// URL trigger list/editor state, target compatibility, and serialized persistence.
(function attachOptionsUrlTriggerController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && value.API_VERSION === 1 && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsUrlTriggerController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsUrlTriggerController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  var API_VERSION = 1;
  var INTERNAL_SOURCE_KEY = '__urlTriggerControllerSourceKey';
  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsUrlTriggerController missing dependency: ' + name);
    return value;
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function isSafeKey(value) {
    return typeof value === 'string' && value.length > 0 && !UNSAFE_KEYS[value];
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function cloneData(value, ancestors, path) {
    path = path || '$';
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType !== 'object') throw new TypeError('URL 触发器数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('URL 触发器数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (hasOwn(value, 'toJSON')) throw new TypeError('URL 触发器数据禁止自定义 toJSON: ' + path);
      var array = new Array(value.length);
      for (var index = 0; index < value.length; index++) {
        var arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!arrayDescriptor) {
          array[index] = null;
          continue;
        }
        if (arrayDescriptor.get || arrayDescriptor.set || !hasOwn(arrayDescriptor, 'value')) {
          throw new TypeError('URL 触发器数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = arrayDescriptor.value === undefined
          ? null
          : cloneData(arrayDescriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    if (hasOwn(value, 'toJSON')) throw new TypeError('URL 触发器数据禁止自定义 toJSON: ' + path);
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
        throw new TypeError('URL 触发器数据禁止访问器字段: ' + path + '.' + key);
      }
      if (descriptor.value === undefined || typeof descriptor.value === 'function'
          || typeof descriptor.value === 'symbol') return;
      Object.defineProperty(output, key, {
        value: cloneData(descriptor.value, nextAncestors, path + '.' + key),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    return output;
  }

  function errorText(error, fallback) {
    var message = ownDataValue(error, 'message');
    if (message === undefined) message = error;
    if (message === undefined || message === null || message === '') return fallback || '未知错误';
    try {
      return String(message);
    } catch (_) {
      return fallback || '未知错误';
    }
  }

  function setSourceKey(item, sourceKey) {
    if (!item || typeof item !== 'object') return item;
    Object.defineProperty(item, INTERNAL_SOURCE_KEY, {
      value: String(sourceKey || ''),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return item;
  }

  function sourceKey(item) {
    return String(item && item[INTERNAL_SOURCE_KEY] || '');
  }

  function create(options) {
    options = options || {};
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsUrlTriggerController');
    }

    var windowRef = options.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = options.document || windowRef.document;
    if (!documentRef || typeof documentRef.addEventListener !== 'function') {
      throw new Error('OptionsUrlTriggerController missing dependency: document');
    }
    var lifecycle = options.lifecycle || lifecycleFactory.create(windowRef);
    var $ = requireFunction(options.$, '$');
    var esc = requireFunction(options.esc, 'esc');
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var mutateConfig = requireFunction(options.mutateConfig, 'mutateConfig');
    var listableFlows = requireFunction(options.listableFlows, 'listableFlows');
    var sortedValues = requireFunction(options.sortedValues, 'sortedValues');
    var renderConfigListItems = requireFunction(options.renderConfigListItems, 'renderConfigListItems');
    var resetConfigListPage = requireFunction(options.resetConfigListPage, 'resetConfigListPage');
    var itemIdHtml = requireFunction(options.itemIdHtml, 'itemIdHtml');
    var scrollOpenedEditor = requireFunction(options.scrollOpenedEditor, 'scrollOpenedEditor');
    var toast = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var isActive = requireFunction(options.isActive, 'isActive');
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var random = typeof options.random === 'function' ? options.random : function () { return Math.random(); };

    var initialized = false;
    var destroyed = false;
    var draft = null;
    var draftSourceKey = '';
    var draftRevision = 0;
    var saveInFlight = null;
    var saveRevision = -1;
    var saveTargetKey = '';
    var deleteInFlight = Object.create(null);
    var mutationTail = Promise.resolve();

    function currentConfig() {
      var config = getConfig();
      return config && typeof config === 'object' && !Array.isArray(config) ? config : Object.create(null);
    }

    function triggerCollection() {
      return ownDataValue(currentConfig(), 'urlTriggers');
    }

    function triggerEntries() {
      var collection = triggerCollection();
      var entries = [];
      var usedKeys = Object.create(null);
      function uniqueSourceKey(baseKey) {
        var key = baseKey;
        var suffix = 2;
        while (usedKeys[key]) key = baseKey + '#' + suffix++;
        usedKeys[key] = true;
        return key;
      }
      function append(rawItem, fallbackKey, index) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return;
        var item = cloneData(rawItem);
        var id = String(ownDataValue(item, 'id') || '');
        var key = uniqueSourceKey(isSafeKey(id) ? 'id:' + id : fallbackKey);
        entries.push({
          key: key,
          index: index,
          item: setSourceKey(item, key),
        });
      }
      if (Array.isArray(collection)) {
        for (var index = 0; index < collection.length; index++) {
          var descriptor = Object.getOwnPropertyDescriptor(collection, String(index));
          if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) continue;
          append(descriptor.value, 'index:' + index, index);
        }
        return entries;
      }
      if (!collection || typeof collection !== 'object') return entries;
      Object.keys(collection).forEach(function (key) {
        if (!isSafeKey(key)) return;
        var descriptor = Object.getOwnPropertyDescriptor(collection, key);
        if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return;
        append(descriptor.value, 'key:' + key, entries.length);
      });
      return entries;
    }

    function findEntry(key) {
      key = String(key || '');
      var entries = triggerEntries();
      for (var index = 0; index < entries.length; index++) {
        var itemId = String(ownDataValue(entries[index].item, 'id') || '');
        if (entries[index].key === key || itemId === key || 'id:' + itemId === key) return entries[index];
      }
      return null;
    }

    function configMap(section) {
      var value = ownDataValue(currentConfig(), section);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : Object.create(null);
    }

    function safeMapValue(map, key) {
      if (!map || !isSafeKey(key)) return null;
      var descriptor = Object.getOwnPropertyDescriptor(map, key);
      if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return null;
      return descriptor.value && typeof descriptor.value === 'object' ? descriptor.value : null;
    }

    function normalizedFlowId(value) {
      return String(value || '').replace(/^user:/, '');
    }

    function findFlowForDisplay(targetId) {
      targetId = String(targetId || '');
      if (!targetId || targetId.indexOf('flowGroup:') === 0) return null;
      var flows = configMap('flows');
      var exact = safeMapValue(flows, targetId);
      if (exact) return exact;
      var rawId = normalizedFlowId(targetId);
      var candidates = [rawId, 'user:' + rawId];
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        var candidate = safeMapValue(flows, candidates[candidateIndex]);
        if (candidate) return candidate;
      }
      var values = listableFlows();
      for (var index = 0; index < values.length; index++) {
        var flow = values[index];
        if (normalizedFlowId(ownDataValue(flow, 'id')) === rawId) return flow;
      }
      return null;
    }

    function flowGroupIdFromTarget(targetId) {
      targetId = String(targetId || '');
      return targetId.indexOf('flowGroup:') === 0 ? targetId.slice(10) : '';
    }

    function findFlowGroupForDisplay(targetId) {
      var groupId = flowGroupIdFromTarget(targetId);
      return groupId ? safeMapValue(configMap('flowGroups'), groupId) : null;
    }

    function missingTargetLabel(kind, targetId, note) {
      var id = kind === 'flowGroup' ? flowGroupIdFromTarget(targetId) : String(targetId || '');
      var details = [];
      if (id) details.push(id);
      if (note) details.push(note);
      return (kind === 'flowGroup' ? '流程组' : '流程') + '不存在'
        + (details.length ? '（' + details.join('，') + '）' : '');
    }

    function targetLabel(targetId) {
      targetId = String(targetId || '');
      var group = findFlowGroupForDisplay(targetId);
      if (group) {
        return {
          known: true,
          kind: 'flowGroup',
          label: String(ownDataValue(group, 'label') || ownDataValue(group, 'name')
            || flowGroupIdFromTarget(targetId)),
        };
      }
      var flow = findFlowForDisplay(targetId);
      if (flow) {
        return {
          known: true,
          kind: 'flow',
          label: String(ownDataValue(flow, 'label') || ownDataValue(flow, 'name') || targetId),
        };
      }
      var kind = targetId.indexOf('flowGroup:') === 0 ? 'flowGroup' : 'flow';
      return {
        known: false,
        kind: kind,
        label: missingTargetLabel(kind, targetId),
      };
    }

    function targetIsKnown(targetId) {
      targetId = String(targetId || '');
      if (!targetId) return false;
      return targetId.indexOf('flowGroup:') === 0
        ? !!findFlowGroupForDisplay(targetId)
        : !!findFlowForDisplay(targetId);
    }

    function sourceTargetId(sourceKeyValue) {
      if (!sourceKeyValue) return '';
      var entry = findEntry(sourceKeyValue);
      return entry ? String(ownDataValue(entry.item, 'flowId') || '') : '';
    }

    function targetOptions(selectedValue) {
      selectedValue = String(selectedValue || '');
      var seen = Object.create(null);
      var html = '<option value="">— 选择流程或流程组 —</option>';
      var flowOptions = '';
      var flows = listableFlows();
      for (var flowIndex = 0; flowIndex < flows.length; flowIndex++) {
        var flow = flows[flowIndex];
        var flowId = String(ownDataValue(flow, 'id') || '');
        if (!flowId || seen[flowId]) continue;
        seen[flowId] = true;
        flowOptions += '<option value="' + esc(flowId) + '"'
          + (selectedValue === flowId ? ' selected' : '') + '>'
          + esc(ownDataValue(flow, 'label') || ownDataValue(flow, 'name') || flowId)
          + (ownDataValue(flow, '__builtin') ? '（内置）' : '')
          + '</option>';
      }
      if (flowOptions) html += '<optgroup label="流程">' + flowOptions + '</optgroup>';

      var groupOptions = '';
      var groups = sortedValues(configMap('flowGroups'));
      for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        var group = groups[groupIndex];
        var groupId = String(ownDataValue(group, 'id') || '');
        var targetId = groupId ? 'flowGroup:' + groupId : '';
        if (!targetId || seen[targetId]) continue;
        seen[targetId] = true;
        groupOptions += '<option value="' + esc(targetId) + '"'
          + (selectedValue === targetId ? ' selected' : '') + '>'
          + esc(ownDataValue(group, 'label') || ownDataValue(group, 'name') || groupId)
          + '</option>';
      }
      if (groupOptions) html += '<optgroup label="流程组">' + groupOptions + '</optgroup>';

      if (selectedValue && !seen[selectedValue]) {
        var current = targetLabel(selectedValue);
        html += '<option value="' + esc(selectedValue)
          + '" selected data-current-url-trigger-target="true">'
          + esc(current.known
            ? current.label + '（当前配置，保留原值）'
            : missingTargetLabel(current.kind, selectedValue, '当前配置已保留'))
          + '</option>';
      }
      return html;
    }

    function triggerPattern(trigger) {
      var pattern = ownDataValue(trigger, 'urlPattern');
      if (pattern === undefined || pattern === null) pattern = ownDataValue(trigger, 'url');
      return String(pattern === undefined || pattern === null ? '' : pattern);
    }

    function render() {
      if (destroyed) return { ok: false, destroyed: true };
      var list = $('#url-triggers-list');
      if (!list) return { ok: false, error: 'URL 触发器列表不存在' };
      var entries;
      try {
        entries = triggerEntries();
      } catch (error) {
        var message = 'URL 触发器配置无效: ' + errorText(error, '未知错误');
        list.innerHTML = '<div class="placeholder">' + esc(message) + '</div>';
        renderEditor();
        return { ok: false, error: message };
      }
      var items = entries.map(function (entry) { return entry.item; });
      list.innerHTML = renderConfigListItems(
        'url-triggers',
        items,
        '<div class="placeholder">还没有 URL 触发器，点击「新建触发器」开始</div>',
        function (trigger) {
          var target = targetLabel(ownDataValue(trigger, 'flowId'));
          var key = sourceKey(trigger);
          return '<div class="item-card' + (draft && draftSourceKey === key ? ' selected' : '')
            + '" data-action="edit-url-trigger" data-id="' + esc(key) + '">'
            + '<span class="item-title">' + esc(ownDataValue(trigger, 'label') || '(未命名)') + '</span>'
            + '<span class="item-sub">' + esc(triggerPattern(trigger)) + ' → '
            + esc((target.known && target.kind === 'flowGroup' ? '流程组 · ' : '') + target.label) + '</span>'
            + '<span class="badge' + (ownDataValue(trigger, 'enabled') !== false ? ' on' : '') + '">'
            + (ownDataValue(trigger, 'enabled') !== false ? '已启用' : '已停用') + '</span>'
            + itemIdHtml(ownDataValue(trigger, 'id'))
            + '</div>';
        }
      );
      renderEditor();
      return { ok: true, draftOpen: !!draft };
    }

    function renderEditor() {
      var existing = $('#url-trigger-editor');
      if (!draft) {
        if (existing) existing.remove();
        return;
      }
      var editor = documentRef.createElement('div');
      editor.id = 'url-trigger-editor';
      editor.className = 'editor';
      var selectedTarget = String(ownDataValue(draft, 'flowId') || '');
      editor.innerHTML =
        '<h3>' + (draftSourceKey ? '编辑 URL 触发器' : '新建 URL 触发器') + '</h3>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>触发器名称</label><input type="text" id="urltrig-label" value="'
        + esc(ownDataValue(draft, 'label')) + '" placeholder="如：ERP 报表页自动推送"></div>'
        + '<div class="form-row"><label>绑定流程或流程组</label><select id="urltrig-flow">'
        + targetOptions(selectedTarget) + '</select></div>'
        + '</div>'
        + '<div class="form-row"><label>URL 匹配模式（支持通配符 * ）</label><input type="text" id="urltrig-pattern" value="'
        + esc(triggerPattern(draft)) + '" placeholder="https://erp.company.com/report*"></div>'
        + '<p class="form-help">示例：<code>https://erp.company.com/*</code> 或 <code>https://*.internal.com/dashboard</code></p>'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="urltrig-enabled"'
        + (ownDataValue(draft, 'enabled') !== false ? ' checked' : '')
        + '><label for="urltrig-enabled">启用</label></div>'
        + '<div class="editor-actions">'
        + '<button class="btn-primary" data-action="save-url-trigger">保存</button>'
        + '<button class="btn-secondary" data-action="cancel-url-trigger">取消</button>'
        + '<span class="spacer"></span>'
        + (draftSourceKey
          ? '<button class="btn-danger" data-action="delete-url-trigger" data-id="'
            + esc(draftSourceKey) + '">删除</button>'
          : '')
        + '</div>';
      if (existing) existing.remove();
      var list = $('#url-triggers-list');
      if (list) list.insertAdjacentElement('afterend', editor);
    }

    function editorElements() {
      return {
        label: $('#urltrig-label'),
        target: $('#urltrig-flow'),
        pattern: $('#urltrig-pattern'),
        enabled: $('#urltrig-enabled'),
      };
    }

    function syncDraftFromEditor() {
      if (!draft) return false;
      var fields = editorElements();
      if (!fields.label || !fields.target || !fields.pattern || !fields.enabled) return false;
      var label = String(fields.label.value || '').trim();
      var targetId = String(fields.target.value || '');
      var pattern = String(fields.pattern.value || '').trim();
      var enabled = !!fields.enabled.checked;
      var changed = String(ownDataValue(draft, 'label') || '') !== label
        || String(ownDataValue(draft, 'flowId') || '') !== targetId
        || triggerPattern(draft) !== pattern
        || (ownDataValue(draft, 'enabled') !== false) !== enabled;
      if (!changed) return true;
      var next = cloneData(draft);
      next.label = label;
      next.flowId = targetId;
      next.urlPattern = pattern;
      next.enabled = enabled;
      draft = next;
      draftRevision++;
      return true;
    }

    function validationFailure(message) {
      if (!destroyed) toast(message, true);
      return Promise.resolve({ ok: false, error: message });
    }

    function generateId() {
      var seen = Object.create(null);
      triggerEntries().forEach(function (entry) {
        var id = String(ownDataValue(entry.item, 'id') || '');
        if (id) seen[id] = true;
      });
      var id;
      do {
        id = 'ut_' + now().toString(36) + '_' + random().toString(36).slice(2, 7);
      } while (seen[id] || !isSafeKey(id));
      return id;
    }

    function buildSaveItem() {
      if (!draft) throw new Error('没有可保存的 URL 触发器');
      if (!syncDraftFromEditor()) throw new Error('URL 触发器编辑器不可用');
      var item = cloneData(draft);
      item.label = String(ownDataValue(item, 'label') || '').trim();
      item.flowId = String(ownDataValue(item, 'flowId') || '');
      item.urlPattern = triggerPattern(item).trim();
      item.enabled = ownDataValue(item, 'enabled') !== false;
      if (!item.flowId) throw new Error('请选择要触发的流程或流程组');
      if (!targetIsKnown(item.flowId) && sourceTargetId(draftSourceKey) !== item.flowId) {
        throw new Error('绑定目标不存在，请重新选择');
      }
      if (!item.urlPattern) throw new Error('URL 匹配模式不能为空');
      if (/[\u0000-\u001f\u007f]/.test(item.urlPattern)) {
        throw new Error('URL 匹配模式不能包含控制字符');
      }
      var itemId = String(ownDataValue(item, 'id') || '');
      if (!isSafeKey(itemId)) {
        if (draftSourceKey) throw new Error('URL 触发器缺少可寻址 ID，无法通过资源接口更新');
        itemId = generateId();
        item.id = itemId;
        draft.id = itemId;
      }
      item.updatedAt = now();
      return item;
    }

    function enqueueMutation(operation) {
      var queued = mutationTail.then(operation, operation);
      mutationTail = queued.catch(function () {});
      return queued;
    }

    function save() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (!draft) return validationFailure('没有可保存的 URL 触发器');
      if (Object.keys(deleteInFlight).length) {
        return validationFailure('URL 触发器正在删除，请稍后保存');
      }
      try {
        if (!syncDraftFromEditor()) return validationFailure('URL 触发器编辑器不可用');
      } catch (error) {
        return validationFailure('无法读取 URL 触发器: ' + errorText(error, '配置数据无效'));
      }
      if (saveInFlight) {
        if (saveRevision === draftRevision) return saveInFlight;
        var queuedRevision = draftRevision;
        var queuedSourceKey = draftSourceKey;
        var queuedItemId = String(ownDataValue(draft, 'id') || '');
        function saveQueuedRevision() {
          if (destroyed) return { ok: false, destroyed: true };
          var currentItemId = String(ownDataValue(draft, 'id') || '');
          var sourceStillMatches = draftSourceKey === queuedSourceKey
            || (!queuedSourceKey && queuedItemId && currentItemId === queuedItemId
              && draftSourceKey === 'id:' + queuedItemId);
          if (!draft || draftRevision !== queuedRevision || currentItemId !== queuedItemId
              || !sourceStillMatches) {
            return { ok: false, stale: true };
          }
          return save();
        }
        return saveInFlight.then(saveQueuedRevision, saveQueuedRevision);
      }

      var item;
      try {
        item = buildSaveItem();
      } catch (error) {
        return validationFailure(errorText(error, 'URL 触发器结构无效'));
      }
      var revision = draftRevision;
      var targetKey = draftSourceKey;
      var itemId = String(item.id || '');
      var committed = false;
      function stillCurrent() {
        return !destroyed && !!draft && draftRevision === revision
          && draftSourceKey === targetKey && String(ownDataValue(draft, 'id') || '') === itemId;
      }
      var operation = enqueueMutation(function () {
        if (!stillCurrent()) return { staleBeforeCommit: true };
        return mutateConfig('upsert', 'urlTriggers', item);
      }).then(function (nextConfig) {
        if (nextConfig && nextConfig.staleBeforeCommit) return { ok: false, stale: true };
        if (!nextConfig) {
          if (stillCurrent()) toast('URL 触发器保存失败', true);
          return { ok: false, error: '保存失败' };
        }
        committed = true;
        if (destroyed) return { ok: true, committed: true, destroyed: true };
        var completionStale = !stillCurrent();
        if (!completionStale) {
          draft = null;
          draftSourceKey = '';
          draftRevision++;
          resetConfigListPage('url-triggers');
          toast('URL 触发器已保存');
        } else {
          if (draft && !draftSourceKey && String(ownDataValue(draft, 'id') || '') === itemId) {
            draftSourceKey = 'id:' + itemId;
          }
          toast('URL 触发器已保存；当前编辑内容尚未保存');
        }
        if (isActive()) render();
        return { ok: true, committed: true, stale: completionStale };
      }).catch(function (error) {
        if (destroyed) return { ok: committed, committed: committed, destroyed: true };
        var stale = !stillCurrent();
        var message = (committed ? 'URL 触发器已保存，但刷新失败: ' : 'URL 触发器保存失败: ')
          + errorText(error, '未知错误');
        if (!stale || committed) toast(message, true);
        return { ok: committed, committed: committed, stale: stale, error: message };
      });
      saveInFlight = operation;
      saveRevision = revision;
      saveTargetKey = targetKey || 'id:' + itemId;
      operation.then(function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
          saveTargetKey = '';
        }
      }, function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
          saveTargetKey = '';
        }
      });
      return operation;
    }

    function remove(triggerKey) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      triggerKey = String(triggerKey || '');
      var entry;
      try {
        entry = findEntry(triggerKey);
      } catch (error) {
        return validationFailure('无法读取 URL 触发器: ' + errorText(error, '配置数据无效'));
      }
      if (!entry) return validationFailure('URL 触发器不存在');
      if (deleteInFlight[entry.key]) return deleteInFlight[entry.key];
      if (Object.keys(deleteInFlight).length) {
        return validationFailure('URL 触发器正在删除，请稍后重试');
      }
      if (saveInFlight && saveTargetKey === entry.key) {
        return validationFailure('URL 触发器正在保存，请稍后删除');
      }
      var itemId = String(ownDataValue(entry.item, 'id') || '');
      if (!isSafeKey(itemId)) return validationFailure('URL 触发器缺少可寻址 ID，无法删除');
      if (!confirmAction('确定删除该 URL 触发器？')) {
        return Promise.resolve({ ok: false, canceled: true });
      }
      var operation = enqueueMutation(function () {
        if (destroyed) return { destroyedBeforeCommit: true };
        return mutateConfig('delete', 'urlTriggers', itemId);
      }).then(function (nextConfig) {
        if (nextConfig && nextConfig.destroyedBeforeCommit) return { ok: false, destroyed: true };
        if (!nextConfig) {
          if (!destroyed) toast('URL 触发器删除失败', true);
          return { ok: false, error: '删除失败' };
        }
        if (destroyed) return { ok: true, committed: true, destroyed: true };
        if (draftSourceKey === entry.key
            || !draftSourceKey && itemId && String(ownDataValue(draft, 'id') || '') === itemId) {
          draft = null;
          draftSourceKey = '';
          draftRevision++;
        }
        toast('URL 触发器已删除');
        if (isActive()) render();
        return { ok: true, committed: true };
      }).catch(function (error) {
        if (destroyed) return { ok: false, destroyed: true };
        var message = 'URL 触发器删除失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, error: message };
      });
      deleteInFlight[entry.key] = operation;
      operation.then(function () {
        if (deleteInFlight[entry.key] === operation) delete deleteInFlight[entry.key];
      }, function () {
        if (deleteInFlight[entry.key] === operation) delete deleteInFlight[entry.key];
      });
      return operation;
    }

    function openNew() {
      if (destroyed) return { ok: false, destroyed: true };
      draft = Object.create(null);
      draft.label = '';
      draft.flowId = '';
      draft.urlPattern = '';
      draft.enabled = true;
      draftSourceKey = '';
      draftRevision++;
      if (isActive()) {
        render();
        scrollOpenedEditor('#url-trigger-editor');
      }
      return { ok: true };
    }

    function edit(triggerKey) {
      if (destroyed) return { ok: false, destroyed: true };
      var entry;
      try {
        entry = findEntry(triggerKey);
      } catch (error) {
        var message = '无法编辑 URL 触发器: ' + errorText(error, '配置数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
      if (!entry) return { ok: false, error: 'URL 触发器不存在' };
      draft = cloneData(entry.item);
      draftSourceKey = entry.key;
      draftRevision++;
      if (isActive()) {
        render();
        scrollOpenedEditor('#url-trigger-editor');
      }
      return { ok: true };
    }

    function clearDraft(clearOptions) {
      clearOptions = clearOptions || {};
      draft = null;
      draftSourceKey = '';
      draftRevision++;
      if (clearOptions.render !== false && !destroyed && isActive()) render();
      return { ok: !destroyed, destroyed: destroyed };
    }

    function handleAction(action, triggerKey) {
      if (action === 'edit-url-trigger') {
        edit(triggerKey);
        return true;
      }
      if (action === 'save-url-trigger') {
        save();
        return true;
      }
      if (action === 'cancel-url-trigger') {
        clearDraft();
        return true;
      }
      if (action === 'delete-url-trigger') {
        remove(triggerKey);
        return true;
      }
      return false;
    }

    function handleDocumentClick(event) {
      var source = event && event.target;
      if (!source || typeof source.closest !== 'function') return;
      var actionElement = source.closest('[data-action]');
      if (!actionElement) return;
      handleAction(actionElement.dataset.action, actionElement.dataset.id || '');
    }

    function handleEditorMutation(event) {
      var source = event && event.target;
      if (!draft || !source || typeof source.closest !== 'function') return;
      if (!source.closest('#url-trigger-editor')) return;
      try {
        syncDraftFromEditor();
      } catch (error) {
        toast('URL 触发器输入无效: ' + errorText(error, '未知错误'), true);
      }
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      lifecycle.listen($('#btn-new-url-trigger'), 'click', openNew);
      lifecycle.listen(documentRef, 'click', handleDocumentClick);
      lifecycle.listen(documentRef, 'input', handleEditorMutation);
      lifecycle.listen(documentRef, 'change', handleEditorMutation);
      lifecycle.listen(windowRef, 'pagehide', function (event) {
        if (!event || !event.persisted) destroy();
      });
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      draft = null;
      draftSourceKey = '';
      draftRevision++;
      lifecycle.destroy();
      return { ok: true, destroyed: true };
    }

    return {
      init: init,
      destroy: destroy,
      render: render,
      handleAction: handleAction,
      clearDraft: clearDraft,
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          saving: !!saveInFlight,
          deleting: Object.keys(deleteInFlight).length > 0,
          draftId: draft && ownDataValue(draft, 'id') || '',
          revision: draftRevision,
        };
      },
    };
  }

  return {
    API_VERSION: API_VERSION,
    create: create,
  };
});
