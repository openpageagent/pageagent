// Pure assistant profile catalog and identity state transitions for conversation state.
(function attachConversationAssistantStateRuntime(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ConversationAssistantStateRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var LEGACY_TEMPLATE_ASSISTANT_IDS = Object.freeze({
    asst_flow_builder: true,
    asst_flow_repair: true,
    asst_flow_reviewer: true,
    asst_flow_runner: true,
  });

  function requireFunction(value, name) {
    if (typeof value !== 'function') {
      throw new Error('ConversationAssistantStateRuntime requires ' + name);
    }
    return value;
  }

  function ownValue(map, key) {
    return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  function create(options) {
    options = options || {};
    var schemaApi = options.schemaApi;
    var profileSchema = options.profileSchema;
    if (!schemaApi || typeof schemaApi.safeMerge !== 'function'
        || typeof schemaApi.safeShallowMerge !== 'function'
        || typeof schemaApi.sameValue !== 'function') {
      throw new Error('ConversationAssistantStateRuntime requires schemaApi');
    }
    if (!profileSchema || typeof profileSchema.normalizeProfile !== 'function'
        || typeof profileSchema.mergeProfile !== 'function'
        || typeof profileSchema.normalizeResourcePolicy !== 'function'
        || typeof profileSchema.snapshot !== 'function'
        || typeof profileSchema.signature !== 'function'
        || typeof profileSchema.normalizeSnapshot !== 'function'
        || typeof profileSchema.assistantTemplates !== 'function') {
      throw new Error('ConversationAssistantStateRuntime requires profileSchema');
    }
    var nowId = requireFunction(options.nowId, 'nowId');
    var compactString = requireFunction(options.compactString, 'compactString');
    var markStateNeedsPersist = requireFunction(options.markStateNeedsPersist, 'markStateNeedsPersist');
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };

    function assistantTemplates() {
      return profileSchema.assistantTemplates();
    }

    function snapshot(assistant) {
      return profileSchema.snapshot(assistant);
    }

    function signature(assistant) {
      return profileSchema.signature(assistant);
    }

    function normalizeCatalog(state) {
      if (!state || typeof state !== 'object') return state;
      var rawAssistants = state.assistants && typeof state.assistants === 'object'
          && !Array.isArray(state.assistants)
        ? schemaApi.safeShallowMerge(state.assistants)
        : {};
      state.assistants = {};
      Object.keys(LEGACY_TEMPLATE_ASSISTANT_IDS).forEach(function (id) {
        var assistant = rawAssistants[id];
        if (assistant && assistant.builtIn === true && (!assistant.updatedAt || assistant.updatedAt === 0)) {
          delete rawAssistants[id];
          markStateNeedsPersist(state);
        }
      });
      Object.keys(rawAssistants).forEach(function (id) {
        var current = rawAssistants[id];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          markStateNeedsPersist(state);
          return;
        }
        var normalized = profileSchema.normalizeProfile(current, { id: id });
        if (!schemaApi.sameValue(current, normalized)) markStateNeedsPersist(state);
        state.assistants[id] = normalized;
      });
      var requestedOrder = Array.isArray(state.assistantOrder) ? state.assistantOrder : [];
      var seen = Object.create(null);
      state.assistantOrder = requestedOrder.concat(Object.keys(state.assistants)).map(function (id) {
        return String(id || '').trim();
      }).filter(function (id) {
        if (!id || seen[id] || !ownValue(state.assistants, id)) return false;
        seen[id] = true;
        return true;
      });
      if (!schemaApi.sameValue(requestedOrder, state.assistantOrder)) markStateNeedsPersist(state);
      if (!state.assistantOrder.length) {
        // 目录被清空（legacy 迁移删光或用户删掉最后一个助手）时必须自愈：
        // 零助手状态会让引用旧助手的话题被 remap 到 ''、在 UI 中永久不可见，
        // 新建对话也会直接报错。
        var templates = assistantTemplates();
        var template = templates && templates.items && templates.items[templates.order && templates.order[0]];
        createAssistant(state, template || { name: '默认助手' });
        markStateNeedsPersist(state);
      }
      if (!state.activeAssistantId || !ownValue(state.assistants, state.activeAssistantId)) {
        state.activeAssistantId = state.assistantOrder[0] || '';
      }
      return state;
    }

    function normalizeTopicIdentity(state, topic) {
      if (!state || !topic) return topic;
      var snapshotAssistantId = topic.assistantSnapshot
        && String(topic.assistantSnapshot.id || '').trim();
      if (!ownValue(state.assistants, topic.assistantId)
          && snapshotAssistantId && ownValue(state.assistants, snapshotAssistantId)) {
        topic.assistantId = snapshotAssistantId;
        markStateNeedsPersist(state);
      }
      var assistant = ownValue(state.assistants, topic.assistantId);
      // A missing Assistant makes the topic an orphan. Keep its original
      // identity intact so the background reconciler can delete the complete
      // topic/Journal/artifact chain instead of silently reassigning it.
      if (!assistant) return topic;
      if (!topic.assistantSnapshot) {
        topic.assistantSnapshot = snapshot(assistant);
        markStateNeedsPersist(state);
        return topic;
      }
      var normalized = profileSchema.normalizeSnapshot(topic.assistantSnapshot, { id: topic.assistantId });
      if (!schemaApi.sameValue(topic.assistantSnapshot, normalized)) {
        topic.assistantSnapshot = normalized;
        markStateNeedsPersist(state);
      }
      return topic;
    }

    function setActive(state, assistantId) {
      if (!state || !ownValue(state.assistants, assistantId)) return state;
      state.activeAssistantId = assistantId;
      var activeTopic = ownValue(state.topics, state.activeTopicId);
      if (!activeTopic || activeTopic.assistantId !== assistantId) {
        state.activeTopicId = (state.topicOrder || []).filter(function (topicId) {
          var topic = ownValue(state.topics, topicId);
          return topic && topic.assistantId === assistantId;
        })[0] || '';
      }
      return state;
    }

    function createAssistant(state, input) {
      input = input && typeof input === 'object' && !Array.isArray(input)
        ? schemaApi.safeMerge(input)
        : {};
      var assistantId = nowId('asst');
      var assistant = profileSchema.normalizeProfile(input, { id: assistantId });
      assistant.id = assistantId;
      assistant.name = compactString(
        typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '新助手',
        36
      );
      assistant.description = typeof input.description === 'string'
        ? input.description
        : (assistant.description || '对话');
      assistant.createdAt = now();
      assistant.updatedAt = assistant.createdAt;
      state.assistants[assistantId] = assistant;
      state.assistantOrder = [assistantId].concat((state.assistantOrder || []).filter(function (id) {
        return id !== assistantId;
      }));
      state.activeAssistantId = assistantId;
      state.activeTopicId = '';
      return state;
    }

    function updateAssistant(state, assistantId, patch) {
      patch = patch && typeof patch === 'object' && !Array.isArray(patch)
        ? schemaApi.safeMerge(patch)
        : {};
      var current = ownValue(state.assistants, assistantId);
      if (!current) return state;
      state.assistants[assistantId] = profileSchema.mergeProfile(current, schemaApi.safeMerge(patch, {
        id: assistantId,
        updatedAt: now(),
      }), { id: assistantId });
      return state;
    }

    function deleteAssistant(state, assistantId) {
      var assistant = ownValue(state.assistants, assistantId);
      if (!assistant) return state;
      delete state.assistants[assistantId];
      state.assistantOrder = (state.assistantOrder || []).filter(function (id) {
        return id !== assistantId && !!ownValue(state.assistants, id);
      });
      var fallbackId = state.activeAssistantId !== assistantId
          && ownValue(state.assistants, state.activeAssistantId)
        ? state.activeAssistantId
        : state.assistantOrder[0] || '';
      if (!fallbackId) {
        var templates = assistantTemplates();
        var template = templates && templates.items && templates.items[templates.order && templates.order[0]];
        createAssistant(state, template || { name: '默认助手' });
        fallbackId = state.activeAssistantId || state.assistantOrder[0] || '';
      }
      state.activeAssistantId = fallbackId;
      var activeTopic = ownValue(state.topics, state.activeTopicId);
      if (!activeTopic || activeTopic.assistantId === assistantId) state.activeTopicId = '';
      return state;
    }

    function reorderAssistants(state, requestedOrder) {
      if (!state || !state.assistants || typeof state.assistants !== 'object') return state;
      var seen = Object.create(null);
      var nextOrder = (Array.isArray(requestedOrder) ? requestedOrder : [])
        .map(function (id) { return String(id || '').trim(); })
        .concat(Array.isArray(state.assistantOrder) ? state.assistantOrder : [])
        .concat(Object.keys(state.assistants))
        .filter(function (id) {
          if (!id || seen[id] || !ownValue(state.assistants, id)) return false;
          seen[id] = true;
          return true;
        });
      state.assistantOrder = nextOrder;
      if (!state.activeAssistantId || !ownValue(state.assistants, state.activeAssistantId)) {
        state.activeAssistantId = nextOrder[0] || '';
      }
      return state;
    }

    return Object.freeze({
      assistantTemplates: assistantTemplates,
      snapshot: snapshot,
      signature: signature,
      normalizeCatalog: normalizeCatalog,
      normalizeTopicIdentity: normalizeTopicIdentity,
      setActive: setActive,
      createAssistant: createAssistant,
      updateAssistant: updateAssistant,
      deleteAssistant: deleteAssistant,
      reorderAssistants: reorderAssistants,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
