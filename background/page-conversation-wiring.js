// Read-only Page entry configuration. All execution mutations use ConversationCommandBus.
(function attachPageConversationWiring(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageConversationWiring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var GET_ENTRY_CONFIG = 'GET_PAGE_AGENT_ENTRY_CONFIG';

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function trustedPage(sender) {
    var url = text(sender && (sender.url || sender.tab && sender.tab.url));
    return !!(sender && sender.tab && Number(sender.tab.id) > 0 && /^(?:https?|file):/i.test(url));
  }

  function create(deps) {
    deps = deps || {};
    var loadConversationState = deps.loadConversationState;
    var getModelSettings = deps.getModelSettings;
    var listActiveConversations = deps.listActiveConversations;
    var getConversationEvents = deps.getConversationEvents;
    var generationSurfaceCache = Object.create(null);
    if (typeof loadConversationState !== 'function') throw new TypeError('PageConversationWiring requires loadConversationState');
    if (typeof getModelSettings !== 'function') throw new TypeError('PageConversationWiring requires getModelSettings');

    async function generationSurface(metadata) {
      var active = metadata && metadata.activeGeneration || {};
      if (active.surface && typeof active.surface === 'object') return active.surface;
      if (typeof getConversationEvents !== 'function' || !metadata || !metadata.conversationId || !active.generationId) return null;
      var cacheKey = text(metadata.conversationId) + '\n' + text(active.generationId);
      if (hasOwn(generationSurfaceCache, cacheKey)) return generationSurfaceCache[cacheKey];
      var events = await getConversationEvents(metadata.conversationId);
      var surface = null;
      for (var index = Array.isArray(events) ? events.length - 1 : -1; index >= 0; index -= 1) {
        var event = events[index];
        if (event && event.type === 'generation_started' && event.generationId === active.generationId) {
          surface = event.payload && event.payload.surface || null;
          break;
        }
      }
      generationSurfaceCache[cacheKey] = surface && typeof surface === 'object' ? clone(surface) : null;
      return generationSurfaceCache[cacheKey];
    }

    async function activePageConversation(sender) {
      if (typeof listActiveConversations !== 'function') return null;
      var tabId = Number(sender && sender.tab && sender.tab.id) || 0;
      if (!tabId) return null;
      var metadataList = await listActiveConversations();
      var candidates = [];
      for (var index = 0; index < (Array.isArray(metadataList) ? metadataList.length : 0); index += 1) {
        var metadata = metadataList[index];
        var surface = await generationSurface(metadata);
        if (!surface || surface.type !== 'page' || Number(surface.tabId) !== tabId) continue;
        var active = metadata.activeGeneration || {};
        candidates.push({
          conversationId: text(metadata.conversationId),
          assistantId: text(metadata.assistantId),
          generationId: text(active.generationId),
          state: text(active.state),
          startedAt: Math.max(0, Number(active.startedAt) || Number(metadata.updatedAt) || 0),
        });
      }
      candidates.sort(function (left, right) {
        if (right.startedAt !== left.startedAt) return right.startedAt - left.startedAt;
        return right.conversationId.localeCompare(left.conversationId);
      });
      return candidates[0] || null;
    }

    async function entryConfig(sender) {
      if (!trustedPage(sender)) throw new Error('Page Agent entry config requires a trusted page sender');
      var values = await Promise.all([
        loadConversationState(),
        getModelSettings(),
        activePageConversation(sender).catch(function () { return null; }),
      ]);
      var state = values[0];
      var settings = values[1];
      var activeConversation = values[2];
      var assistants = (state && state.assistantOrder || Object.keys(state && state.assistants || {})).map(function (id) {
        var assistant = state.assistants && state.assistants[id];
        if (!assistant) return null;
        return {
          id: text(assistant.id || id),
          name: text(assistant.name) || text(assistant.id || id),
          modelServiceId: text(assistant.modelServiceId),
          settings: clone(assistant.settings || {}),
        };
      }).filter(Boolean);
      return {
        assistants: assistants,
        defaultAssistantId: text(state && state.defaultAssistantId) || text(assistants[0] && assistants[0].id),
        // generatorServiceId 是"全局默认模型"的权威字段（agent-settings.defaultModelServiceId
        // 写入的就是它）；defaultServiceId 是旧版活动服务，仅作兜底。顺序与定时任务链一致。
        defaultModelServiceId: text(settings && (settings.generatorServiceId || settings.defaultServiceId)),
        tabId: Number(sender.tab && sender.tab.id) || 0,
        windowId: Number(sender.tab && sender.tab.windowId) || 0,
        activeConversation: activeConversation,
        activeConversationId: text(activeConversation && activeConversation.conversationId),
      };
    }

    function handleMessage(message, sender, sendResponse) {
      if (!message || message.type !== GET_ENTRY_CONFIG) return { handled: false, keepChannel: false };
      entryConfig(sender).then(function (payload) {
        sendResponse({ ok: true, payload: payload });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error) });
      });
      return { handled: true, keepChannel: true };
    }

    return Object.freeze({ API_VERSION: API_VERSION, handleMessage: handleMessage, entryConfig: entryConfig });
  }

  return Object.freeze({ API_VERSION: API_VERSION, GET_ENTRY_CONFIG: GET_ENTRY_CONFIG, create: create });
});
