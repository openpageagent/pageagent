// Flow node editor, list interactions, selector tools, and drag/drop lifecycle.
(function attachOptionsFlowNodeController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && value.API_VERSION === 1 && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsFlowNodeController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsFlowNodeController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  var API_VERSION = 1;
  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  var OWNED_ACTIONS = Object.create(null);
  [
    'open-add-node-drawer',
    'select-node-type',
    'toggle-node-type-group',
    'edit-node',
    'view-node',
    'save-node-edit',
    'cancel-node-edit',
    'pick-selector',
    'verify-selector',
    'use-candidate',
    'num-mode-fixed',
    'num-mode-random',
    'delete-node',
    'run-from-node',
    'run-single-node',
    'copy-node',
    'split-flow-from-node',
  ].forEach(function (action) { OWNED_ACTIONS[action] = true; });

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsFlowNodeController missing dependency: ' + name);
    return value;
  }

  function isSafeKey(value) {
    return typeof value === 'string' && value.length > 0 && !UNSAFE_KEYS[value];
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
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
    if (valueType !== 'object') throw new TypeError('流程节点数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('流程节点数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (hasOwn(value, 'toJSON')) throw new TypeError('流程节点数据禁止自定义 toJSON: ' + path);
      var array = new Array(value.length);
      for (var index = 0; index < value.length; index++) {
        var descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          array[index] = null;
          continue;
        }
        if (descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
          throw new TypeError('流程节点数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = descriptor.value === undefined
          ? null
          : cloneData(descriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    if (hasOwn(value, 'toJSON')) throw new TypeError('流程节点数据禁止自定义 toJSON: ' + path);
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
        throw new TypeError('流程节点数据禁止访问器字段: ' + path + '.' + key);
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

  function stripRuntimeMetadata(value, ancestors, path) {
    path = path || '$';
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType !== 'object') throw new TypeError('流程节点数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('流程节点数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      var array = new Array(value.length);
      for (var index = 0; index < value.length; index++) {
        var descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          array[index] = null;
          continue;
        }
        if (descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
          throw new TypeError('流程节点数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = descriptor.value === undefined
          ? null
          : stripRuntimeMetadata(descriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key) || key.indexOf('__builtin') === 0 || key === 'mcpValidation') return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
        throw new TypeError('流程节点数据禁止访问器字段: ' + path + '.' + key);
      }
      if (descriptor.value === undefined || typeof descriptor.value === 'function'
          || typeof descriptor.value === 'symbol') return;
      Object.defineProperty(output, key, {
        value: stripRuntimeMetadata(descriptor.value, nextAncestors, path + '.' + key),
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
    try { return String(message); } catch (_) { return fallback || '未知错误'; }
  }

  function create(options) {
    options = options || {};
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsFlowNodeController');
    }

    var windowRef = options.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = options.document || windowRef.document;
    if (!documentRef || typeof documentRef.addEventListener !== 'function') {
      throw new Error('OptionsFlowNodeController missing dependency: document');
    }
    var lifecycle = options.lifecycle || lifecycleFactory.create(windowRef);
    var $ = requireFunction(options.$, '$');
    var esc = requireFunction(options.esc, 'esc');
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var getFlowController = requireFunction(options.getFlowController, 'getFlowController');
    var userConfigValues = requireFunction(options.userConfigValues, 'userConfigValues');
    var sortedValues = requireFunction(options.sortedValues, 'sortedValues');
    var isBuiltinItem = requireFunction(options.isBuiltinItem, 'isBuiltinItem');
    var sendMessage = requireFunction(options.sendMessage, 'sendMessage');
    var getCurrentWindowId = requireFunction(options.getCurrentWindowId, 'getCurrentWindowId');
    var getRunOriginContext = requireFunction(options.getRunOriginContext, 'getRunOriginContext');
    var buildRuntimeContextFromInputs = requireFunction(options.buildRuntimeContextFromInputs, 'buildRuntimeContextFromInputs');
    var generateConfigId = requireFunction(options.generateConfigId, 'generateConfigId');
    var openDrawer = requireFunction(options.openDrawer, 'openDrawer');
    var closeDrawer = requireFunction(options.closeDrawer, 'closeDrawer');
    var toastImpl = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var promptAction = requireFunction(options.prompt, 'prompt');
    var loadConversationState = typeof options.loadConversationState === 'function'
      ? options.loadConversationState
      : function () { return Promise.resolve({ assistants: {}, assistantOrder: [] }); };
    var loadModelServiceOptions = typeof options.loadModelServiceOptions === 'function'
      ? options.loadModelServiceOptions
      : function () { return Promise.resolve({ services: [], defaultServiceId: '' }); };
    var nodeTypes = options.nodeTypes;
    if (!nodeTypes || typeof nodeTypes.getType !== 'function'
        || typeof nodeTypes.validateNodeInstance !== 'function') {
      throw new Error('OptionsFlowNodeController missing dependency: NodeTypes');
    }
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var random = typeof options.random === 'function' ? options.random : function () { return Math.random(); };
    var consoleRef = options.console || windowRef.console || { info: function () {} };

    var initialized = false;
    var destroyed = false;
    var revision = 0;
    var drawerMode = '';
    var selectedNode = null;
    var editorToken = 0;
    var selectorRequest = 0;
    var verifyRequest = 0;
    var dragState = {
      index: -1,
      destinationIndex: -1,
      nodeId: '',
      draftRevision: -1,
      metrics: null,
    };
    var conversationState = { assistants: {}, assistantOrder: [] };
    var modelServiceState = { services: [], defaultServiceId: '', loaded: false };

    function toast(message, isError) {
      if (destroyed) return;
      try { toastImpl(message, isError); } catch (_) {}
    }

    function flowController() {
      var controller = getFlowController();
      return controller && typeof controller.getDraft === 'function' ? controller : null;
    }

    function flowState() {
      var controller = flowController();
      if (!controller || typeof controller.getState !== 'function') return {};
      try { return controller.getState() || {}; } catch (_) { return {}; }
    }

    function currentFlowRevision() {
      return Number(ownDataValue(flowState(), 'revision')) || 0;
    }

    function snapshotDraft(syncEditor) {
      var controller = flowController();
      if (!controller) return null;
      var draft = syncEditor && typeof controller.syncDraftFromEditor === 'function'
        ? controller.syncDraftFromEditor({ markDirty: false })
        : controller.getDraft();
      return draft ? cloneData(draft) : null;
    }

    function ensureEditable() {
      var controller = flowController();
      return !!(controller && typeof controller.ensureEditable === 'function' && controller.ensureEditable());
    }

    function isReadOnly() {
      var controller = flowController();
      return !!(controller && typeof controller.isReadOnly === 'function' && controller.isReadOnly());
    }

    function renderFlowEditor() {
      if (destroyed) return { ok: false, destroyed: true };
      var controller = flowController();
      return controller && typeof controller.renderEditor === 'function'
        ? controller.renderEditor()
        : { ok: false, error: '流程控制器不可用' };
    }

    function replaceDraft(draft) {
      var controller = flowController();
      if (!controller || typeof controller.replaceDraft !== 'function') {
        toast('流程控制器不可用', true);
        return false;
      }
      var result;
      try {
        result = controller.replaceDraft(draft, { dirty: true, render: false });
      } catch (error) {
        toast('无法更新流程节点: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (!result || result.ok === false) {
        toast(result && result.error || '无法更新流程节点', true);
        return false;
      }
      revision++;
      renderFlowEditor();
      return true;
    }

    function configMap(section) {
      var config = getConfig();
      var map = ownDataValue(config, section);
      return map && typeof map === 'object' && !Array.isArray(map) ? map : Object.create(null);
    }

    function safeMapValue(map, key) {
      if (!isSafeKey(String(key || '')) || !map || typeof map !== 'object') return null;
      var value = ownDataValue(map, String(key));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    function queryAll(selector, root) {
      root = root || documentRef;
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    }

    function nodesOf(draft) {
      var nodes = ownDataValue(draft, 'nodes');
      return Array.isArray(nodes) ? nodes : [];
    }

    function nodeId(node) {
      return String(ownDataValue(node, 'nodeId') || '');
    }

    function resolveNode(nodes, id, indexHint) {
      id = String(id || '');
      var index = Number(indexHint);
      if (Number.isInteger(index) && index >= 0 && index < nodes.length
          && (!id || nodeId(nodes[index]) === id)) {
        return { node: nodes[index], index: index };
      }
      var match = null;
      for (var candidateIndex = 0; candidateIndex < nodes.length; candidateIndex++) {
        if (nodeId(nodes[candidateIndex]) !== id) continue;
        if (match) return null;
        match = { node: nodes[candidateIndex], index: candidateIndex };
      }
      return match;
    }

    function actionNodeIndex(actionElement) {
      if (!actionElement || typeof actionElement.closest !== 'function') return -1;
      var card = actionElement.closest('.node-card');
      if (!card) return -1;
      var index = Number(card.dataset.nodeIndex);
      return Number.isInteger(index) ? index : -1;
    }

    function generateNodeId(reserved) {
      reserved = reserved || Object.create(null);
      var id = '';
      var attempt = 0;
      do {
        id = 'n_' + Number(now()).toString(36) + '_' + Number(random()).toString(36).slice(2, 7);
        if (attempt) id += '_' + attempt.toString(36);
        attempt++;
      } while (!isSafeKey(id) || reserved[id]);
      reserved[id] = true;
      return id;
    }

    function reservedNodeIds(nodes) {
      var reserved = Object.create(null);
      for (var index = 0; index < nodes.length; index++) {
        var id = nodeId(nodes[index]);
        if (id) reserved[id] = true;
      }
      return reserved;
    }

    function generateStructureId(prefix, nodes, paramKey) {
      var reserved = Object.create(null);
      nodes.forEach(function (node) {
        var params = ownDataValue(node, 'params');
        var value = ownDataValue(params, paramKey);
        if (typeof value === 'string' || typeof value === 'number') reserved[String(value)] = true;
      });
      var base = prefix + '_' + Number(now()).toString(36);
      var candidate = base;
      var suffix = 2;
      while (reserved[candidate]) candidate = base + '_' + suffix++;
      return candidate;
    }

    function dataSignature(value) {
      try { return JSON.stringify(value); } catch (_) { return ''; }
    }

    function formatParamEditorValue(param, value) {
      var fallback = ownDataValue(param, 'default');
      var v = value === undefined || value === null ? (fallback !== undefined ? fallback : '') : value;
      if (ownDataValue(param, 'kind') === 'textarea' && v && typeof v === 'object') {
        try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
      }
      return v;
    }

    function booleanEditorValue(value, fallback) {
      if (typeof value === 'boolean') return value;
      if (value === undefined || value === null || value === '') return fallback === true;
      if (/^(?:true|yes|1|on|checked|selected)$/i.test(String(value))) return true;
      if (/^(?:false|no|0|off|unchecked|unselected)$/i.test(String(value))) return false;
      return fallback === true;
    }

    function parseParamEditorValue(param, element) {
      if (element.type === 'checkbox') return !!element.checked;
      var value = element.value;
      if (!param || ownDataValue(param, 'valueFormat') !== 'json') return value;
      var text = String(value || '').trim();
      if (!text || !/^[\[{]/.test(text)) return value;
      try { return JSON.parse(text); } catch (_) { return value; }
    }

    function numericControlHtml(key, value, scope, defaultHint) {
      var stringValue = value === undefined || value === null ? '' : String(value);
      var isRandom = stringValue.indexOf('~') !== -1;
      var minValue = '';
      var maxValue = '';
      var fixedValue = stringValue;
      if (isRandom) {
        var separator = stringValue.indexOf('~');
        minValue = stringValue.slice(0, separator).trim();
        maxValue = stringValue.slice(separator + 1).trim();
        fixedValue = '';
      }
      var fixedPlaceholder = defaultHint !== undefined && defaultHint !== ''
        ? defaultHint + ' 或 {{变量}}'
        : '数字或 {{变量}}';
      return '<div class="num-control' + (isRandom ? ' random' : '') + '" data-num-key="' + esc(key)
        + '" data-num-scope="' + esc(scope) + '">'
        + '<span class="num-mode-toggle">'
        + '<button type="button" class="num-mode-btn num-mode-fixed-btn' + (!isRandom ? ' active' : '')
        + '" data-action="num-mode-fixed" title="每次执行使用固定值">固定</button>'
        + '<button type="button" class="num-mode-btn num-mode-random-btn' + (isRandom ? ' active' : '')
        + '" data-action="num-mode-random" title="每次执行在范围内随机取值，模拟人工操作">随机</button>'
        + '</span>'
        + '<input type="text" class="num-fixed" value="' + esc(fixedValue) + '" placeholder="' + esc(fixedPlaceholder) + '">'
        + '<span class="num-range"><input type="text" class="num-min" value="' + esc(minValue) + '" placeholder="最小">'
        + '<span class="num-range-sep">~</span>'
        + '<input type="text" class="num-max" value="' + esc(maxValue) + '" placeholder="最大"></span>'
        + '</div>';
    }

    function collectNumericControls(scope, allowedKeys, assign) {
      queryAll('.num-control[data-num-scope="' + scope + '"]', $('#drawer-content')).forEach(function (box) {
        var key = String(box.dataset.numKey || '');
        if (!isSafeKey(key) || !allowedKeys[key]) return;
        var value;
        if (box.classList.contains('random')) {
          var minInput = box.querySelector('.num-min');
          var maxInput = box.querySelector('.num-max');
          var min = minInput ? String(minInput.value || '').trim() : '';
          var max = maxInput ? String(maxInput.value || '').trim() : '';
          value = min === '' && max === '' ? '' : min + '~' + max;
        } else {
          var fixedInput = box.querySelector('.num-fixed');
          value = fixedInput ? String(fixedInput.value || '').trim() : '';
        }
        assign(key, value);
      });
    }

    function paramDefinitions(typeDef) {
      var params = ownDataValue(typeDef, 'params');
      return Array.isArray(params) ? params : [];
    }

    function paramDefinitionMap(typeDef) {
      var map = Object.create(null);
      paramDefinitions(typeDef).forEach(function (param) {
        var key = String(ownDataValue(param, 'key') || '');
        if (isSafeKey(key)) map[key] = param;
      });
      return map;
    }

    function assistantOptionsHtml(selectedId) {
      selectedId = String(selectedId || '');
      var assistants = ownDataValue(conversationState, 'assistants');
      var order = ownDataValue(conversationState, 'assistantOrder');
      if (!assistants || typeof assistants !== 'object' || Array.isArray(assistants)) assistants = Object.create(null);
      if (!Array.isArray(order)) order = [];
      var seen = Object.create(null);
      var ids = [];
      order.concat(Object.keys(assistants)).forEach(function (rawId) {
        var id = String(rawId || '');
        if (!isSafeKey(id) || seen[id] || !ownDataValue(assistants, id)) return;
        seen[id] = true;
        ids.push(id);
      });
      var selectedExists = false;
      var optionsHtml = ids.map(function (id) {
        var assistant = ownDataValue(assistants, id);
        if (id === selectedId) selectedExists = true;
        return '<option value="' + esc(id) + '"' + (String(selectedId || '') === id ? ' selected' : '') + '>'
          + esc(ownDataValue(assistant, 'name') || id) + '</option>';
      }).join('');
      if (selectedId && !selectedExists) {
        optionsHtml = '<option value="' + esc(selectedId) + '" selected>'
          + esc('不可用的助手 · ' + selectedId) + '</option>' + optionsHtml;
      }
      return '<option value="">— 选择助手 —</option>' + optionsHtml;
    }

    function refreshAssistantFields(token, selectedValues) {
      return Promise.resolve().then(loadConversationState).then(function (state) {
        if (destroyed || drawerMode !== 'node' || !selectedNode || selectedNode.token !== token) return;
        conversationState = state && typeof state === 'object' && !Array.isArray(state)
          ? state
          : { assistants: {}, assistantOrder: [] };
        Object.keys(selectedValues).forEach(function (key) {
          var field = findParamElement(key);
          if (field) field.innerHTML = assistantOptionsHtml(selectedValues[key]);
        });
      }).catch(function (error) {
        toast('助手列表加载失败: ' + errorText(error, '未知错误'), true);
      });
    }

    function refreshAssistantReferences() {
      if (destroyed || drawerMode !== 'node' || !selectedNode) return Promise.resolve({ ok: true, refreshed: false });
      var typeDef = nodeTypes.getType(selectedNode.type);
      var definitions = paramDefinitionMap(typeDef);
      var selectedValues = Object.create(null);
      Object.keys(definitions).forEach(function (key) {
        if (ownDataValue(definitions[key], 'kind') !== 'assistant') return;
        var field = findParamElement(key);
        selectedValues[key] = field ? String(field.value || '') : '';
      });
      if (!Object.keys(selectedValues).length) return Promise.resolve({ ok: true, refreshed: false });
      return refreshAssistantFields(selectedNode.token, selectedValues).then(function () {
        return { ok: true, refreshed: true };
      });
    }

    function modelServiceOptionsHtml(selectedId, emptyLabel) {
      selectedId = String(selectedId || '');
      var services = ownDataValue(modelServiceState, 'services');
      if (!Array.isArray(services)) services = [];
      var defaultServiceId = String(ownDataValue(modelServiceState, 'defaultServiceId') || '');
      var selectedExists = false;
      var optionsHtml = services.map(function (service) {
        var id = String(ownDataValue(service, 'id') || '');
        if (!id) return '';
        if (id === selectedId) selectedExists = true;
        var label = String(ownDataValue(service, 'name') || id);
        var model = String(ownDataValue(service, 'model') || '');
        if (model) label += ' · ' + model;
        if (id === defaultServiceId) label += '（全局默认）';
        return '<option value="' + esc(id) + '"' + (id === selectedId ? ' selected' : '') + '>'
          + esc(label) + '</option>';
      }).join('');
      if (selectedId && !selectedExists) {
        var unavailableLabel = modelServiceState.loaded ? '不可用的模型服务' : '正在加载模型服务';
        optionsHtml = '<option value="' + esc(selectedId) + '" selected>'
          + esc(unavailableLabel + ' · ' + selectedId) + '</option>' + optionsHtml;
      }
      return '<option value=""' + (!selectedId ? ' selected' : '') + '>— '
        + esc(emptyLabel || '使用全局默认模型服务') + ' —</option>' + optionsHtml;
    }

    function refreshModelServiceFields(token, selectedValues) {
      Promise.resolve().then(loadModelServiceOptions).then(function (state) {
        if (destroyed || drawerMode !== 'node' || !selectedNode || selectedNode.token !== token) return;
        modelServiceState = {
          services: state && Array.isArray(state.services) ? state.services : [],
          defaultServiceId: String(state && state.defaultServiceId || ''),
          loaded: true,
        };
        Object.keys(selectedValues).forEach(function (key) {
          var field = findParamElement(key);
          if (!field) return;
          var option = selectedValues[key] || {};
          var selectedId = String(field.value || option.selectedId || '');
          field.innerHTML = modelServiceOptionsHtml(selectedId, option.emptyLabel);
        });
      }).catch(function (error) {
        toast('模型服务列表加载失败: ' + errorText(error, '未知错误'), true);
      });
    }

    function paramFieldHtml(param, value) {
      var key = String(ownDataValue(param, 'key') || '');
      if (!isSafeKey(key)) return '';
      var attrs = ' data-node-id="node" data-param-key="' + esc(key) + '"';
      var kind = String(ownDataValue(param, 'kind') || '');
      var label = ownDataValue(param, 'label');
      var placeholder = ownDataValue(param, 'placeholder');
      var description = ownDataValue(param, 'description');
      var formatted = formatParamEditorValue(param, value);
      var html = '<div class="form-row"><label>' + esc(label) + (ownDataValue(param, 'required') ? ' *' : '') + '</label>';

      if (kind === 'textarea') {
        html += '<textarea rows="3"' + attrs + ' placeholder="' + esc(placeholder || '') + '">' + esc(formatted) + '</textarea>';
      } else if (kind === 'number') {
        var defaultValue = ownDataValue(param, 'default');
        html += numericControlHtml(key, formatted, 'param', defaultValue !== undefined ? String(defaultValue) : '');
      } else if (kind === 'boolean') {
        html = '<div class="form-row checkbox-row"><input type="checkbox"' + attrs
          + (booleanEditorValue(formatted, ownDataValue(param, 'default') === true) ? ' checked' : '') + '><label>' + esc(label) + '</label>';
      } else if (kind === 'select') {
        html += '<select' + attrs + '>';
        var choices = ownDataValue(param, 'options');
        (Array.isArray(choices) ? choices : []).forEach(function (choice) {
          var optionValue = ownDataValue(choice, 'value');
          html += '<option value="' + esc(optionValue) + '"'
            + (String(formatted) === String(optionValue) ? ' selected' : '') + '>'
            + esc(ownDataValue(choice, 'label')) + '</option>';
        });
        html += '</select>';
      } else if (kind === 'assistant') {
        html += '<select' + attrs + '>' + assistantOptionsHtml(formatted) + '</select>';
      } else if (kind === 'modelService') {
        html += '<select' + attrs + '>' + modelServiceOptionsHtml(formatted, placeholder) + '</select>';
      } else if (kind === 'script') {
        html += '<select' + attrs + '><option value="">— 不使用已保存脚本 —</option>';
        var scripts = userConfigValues('scripts').slice();
        var selectedScript = safeMapValue(configMap('scripts'), String(formatted || ''));
        if (formatted && selectedScript && !scripts.some(function (script) {
          return String(ownDataValue(script, 'id') || '') === String(formatted);
        })) scripts.push(selectedScript);
        scripts.forEach(function (script) {
          var scriptId = String(ownDataValue(script, 'id') || '');
          html += '<option value="' + esc(scriptId) + '"' + (String(formatted) === scriptId ? ' selected' : '') + '>'
            + esc(ownDataValue(script, 'label') || scriptId) + (isBuiltinItem(script) ? '（内置）' : '') + '</option>';
        });
        html += '</select>';
      } else if (/selector/i.test(key)) {
        html += '<div class="input-with-btn">'
          + '<input type="text"' + attrs + ' value="' + esc(formatted) + '" placeholder="' + esc(placeholder || '') + '">'
          + '<button type="button" class="btn-small" data-action="pick-selector" data-key="' + esc(key)
          + '" title="到目标页面上点选元素自动生成选择器">选取</button>'
          + '<button type="button" class="btn-small" data-action="verify-selector" data-key="' + esc(key)
          + '" title="验证当前选择器能否在页面上定位到元素">验证</button>'
          + '</div><div class="pick-candidates" data-candidates-for="' + esc(key) + '"></div>';
      } else {
        html += '<input type="text"' + attrs + ' value="' + esc(formatted) + '" placeholder="' + esc(placeholder || '') + '">';
      }
      if (description) html += '<p class="form-help">' + esc(description) + '</p>';
      return html + '</div>';
    }

    function loopLevel(nodes, index) {
      var level = 0;
      for (var cursor = 0; cursor < index; cursor++) {
        var type = String(ownDataValue(nodes[cursor], 'type') || '');
        if (type === 'loopStart' || type === 'ifStart') level++;
        if (type === 'loopEnd' || type === 'ifEnd') level--;
      }
      return level;
    }

    function nodeCardHtml(node, index, _total, nodes, readonly) {
      nodes = Array.isArray(nodes) ? nodes : [];
      var type = String(ownDataValue(node, 'type') || '');
      var typeDef = nodeTypes.getType(type);
      var typeLabel = typeDef ? ownDataValue(typeDef, 'label') : type;
      var level = loopLevel(nodes, index);
      var dedent = type === 'loopEnd' || type === 'ifEnd' || type === 'elseBlock';
      var indent = level * 20;
      if (dedent) indent = Math.max(0, (level - 1) * 20);
      var id = nodeId(node);
      var flags = '';
      if (ownDataValue(node, 'onFailure') === 'continue') flags += '<span class="badge">失败继续</span>';
      var retries = Number(ownDataValue(node, 'retries'));
      if (retries > 0) flags += '<span class="badge">重试' + retries + '</span>';
      if (ownDataValue(node, 'requiresForeground') === true) flags += '<span class="badge">聚焦窗口</span>';

      return '<div class="node-card' + (readonly ? ' readonly' : '') + '" draggable="' + (readonly ? 'false' : 'true')
        + '" data-node-id="' + esc(id) + '" data-node-index="' + index + '" style="margin-left:' + indent + 'px">'
        + '<div class="node-card-header">'
        + (readonly ? '' : '<span class="drag-handle">⋮⋮</span>')
        + '<span class="node-order">' + (index + 1) + '.</span>'
        + '<span class="node-type-label">[' + esc(typeLabel) + ']</span>'
        + '<span class="node-title">' + esc(ownDataValue(node, 'title') || typeLabel) + '</span>'
        + flags
        + '<button class="btn-icon" data-action="run-from-node" data-id="' + esc(id)
        + '" title="从此节点运行（之前节点跳过，保留上下文变量）">运行</button>'
        + '<button class="btn-icon" data-action="run-single-node" data-id="' + esc(id)
        + '" title="单步运行当前节点（不保存，不继续后续节点）">单步</button>'
        + (readonly
          ? '<button class="btn-icon btn-edit" data-action="view-node" data-id="' + esc(id) + '">查看</button>'
            + '<button class="btn-icon" disabled title="内置流程节点不能修改">编辑</button>'
            + '<button class="btn-icon" disabled title="内置流程节点不能修改">复制</button>'
            + '<button class="btn-icon" disabled title="内置流程节点不能拆分">从此拆分</button>'
            + '<button class="btn-icon" disabled title="内置流程节点不能删除">删除</button>'
          : '<button class="btn-icon btn-edit" data-action="edit-node" data-id="' + esc(id) + '">编辑</button>'
            + '<button class="btn-icon" data-action="copy-node" data-id="' + esc(id) + '" title="复制节点">复制</button>'
            + '<button class="btn-icon" data-action="split-flow-from-node" data-id="' + esc(id)
            + '" title="从此拆分为新流程">从此拆分</button>'
            + '<button class="btn-icon" data-action="delete-node" data-id="' + esc(id) + '">删除</button>')
        + '</div></div>';
    }

    function openNodeEditor(id, indexHint) {
      if (destroyed) return { ok: false, destroyed: true };
      var draft;
      try { draft = snapshotDraft(false); } catch (error) {
        toast('无法打开节点: ' + errorText(error, '节点数据无效'), true);
        return { ok: false, error: errorText(error) };
      }
      if (!draft) return { ok: false, error: '流程草稿不存在' };
      var match = resolveNode(nodesOf(draft), id, indexHint);
      if (!match) {
        toast('节点不存在或节点 ID 重复，请刷新后重试', true);
        return { ok: false, stale: true, error: '节点不存在或重复' };
      }
      var node = match.node;
      var readonly = isReadOnly();
      var type = String(ownDataValue(node, 'type') || '');
      var typeDef = nodeTypes.getType(type);
      var typeLabel = typeDef ? ownDataValue(typeDef, 'label') : type;
      var params = ownDataValue(node, 'params');
      if (!params || typeof params !== 'object' || Array.isArray(params)) params = Object.create(null);
      var retriesLocked = typeof nodeTypes.isNodeReplaySafe !== 'function' || !nodeTypes.isNodeReplaySafe(node);

      editorToken++;
      revision++;
      drawerMode = 'node';
      selectedNode = {
        id: nodeId(node),
        index: match.index,
        type: type,
        token: editorToken,
        flowId: String(ownDataValue(draft, 'id') || ''),
        flowRevision: currentFlowRevision(),
      };

      $('#drawer-title').textContent = (readonly ? '查看节点 - ' : '编辑节点 - ') + typeLabel;
      var body = '<div class="form-row"><label>节点标题</label><input type="text" id="node-title" value="'
        + esc(ownDataValue(node, 'title') || '') + '" placeholder="' + esc(typeLabel) + '"></div>';
      if (typeDef && ownDataValue(typeDef, 'description')) {
        body += '<p class="form-help">' + esc(ownDataValue(typeDef, 'description')) + '</p>';
      }
      var hasSelectorParam = typeDef && paramDefinitions(typeDef).some(function (param) {
        return /selector/i.test(String(ownDataValue(param, 'key') || ''));
      });
      if (hasSelectorParam) {
        body += '<details class="selector-help"><summary>选择器使用说明（手写选择器前请读）</summary><ul>'
          + '<li>使用<b>标准 CSS 选择器</b>：<code>#id</code>、<code>.class</code>、<code>button[type="submit"]</code>、<code>div.list > a</code></li>'
          + '<li><b>不支持</b> XPath（<code>//div[…]</code>）和 jQuery 扩展（<code>:contains(…)</code>）；按文字定位请用点击节点的「文本匹配正则」</li>'
          + '<li>多个备选用 <code>||</code> 分隔，左边找不到自动尝试右边：<code>#submit || button.primary</code></li>'
          + '<li>语法无效会<b>立即报错</b>；语法正确但元素不存在会等待直至超时</li>'
          + '<li>推荐用「选取」到页面上点选，自动生成稳定选择器及备选链</li>'
          + '<li>自动穿透 open Shadow DOM 与同源 iframe；<b>跨域 iframe 不支持</b></li>'
          + '<li>多个元素匹配同一选择器时，配合「第几个匹配」（2 / -1 / random）与「相对定位」精确定位</li>'
          + '<li>注意动态 class（如 <code>css-1q2w3e</code> 这类构建哈希）刷新就变，别用它定位</li>'
          + '</ul></details>';
      }
      if (type === 'setProxy') {
        body += '<p class="form-help">chrome.proxy 是浏览器配置级代理，不是单标签页代理；同一 profile 中其他标签页访问匹配 Host 时也会走该代理。</p>';
      }

      if (typeDef && (ownDataValue(typeDef, 'needsPage') || ownDataValue(typeDef, 'optionalPage'))) {
        body += '<div class="form-row"><label>目标页面' + (ownDataValue(typeDef, 'needsPage') ? ' *' : '（可选）')
          + '</label><select id="node-pageId"><option value="">— 选择页面 —</option>';
        var pages = readonly ? sortedValues(configMap('pages')).slice() : userConfigValues('pages').slice();
        var selectedPageId = String(ownDataValue(node, 'pageId') || '');
        var selectedPage = safeMapValue(configMap('pages'), selectedPageId);
        if (selectedPage && !pages.some(function (page) {
          return String(ownDataValue(page, 'id') || '') === selectedPageId;
        })) pages.push(selectedPage);
        pages.forEach(function (page) {
          var pageId = String(ownDataValue(page, 'id') || '');
          body += '<option value="' + esc(pageId) + '"' + (selectedPageId === pageId ? ' selected' : '') + '>'
            + esc(ownDataValue(page, 'label') || ownDataValue(page, 'url'))
            + (isBuiltinItem(page) ? '（内置）' : '') + '</option>';
        });
        body += '</select></div>';
      }

      if (typeDef) {
        var assistantValues = Object.create(null);
        var modelServiceValues = Object.create(null);
        paramDefinitions(typeDef).forEach(function (param) {
          var key = String(ownDataValue(param, 'key') || '');
          var value = ownDataValue(params, key);
          body += paramFieldHtml(param, value);
          if (ownDataValue(param, 'kind') === 'assistant') assistantValues[key] = String(value || '');
          if (ownDataValue(param, 'kind') === 'modelService') {
            modelServiceValues[key] = {
              selectedId: String(value || ''),
              emptyLabel: String(ownDataValue(param, 'placeholder') || ''),
            };
          }
        });
      }
      body += '<div class="form-row"><label>输出变量名（可选）</label><input type="text" id="node-outputVar" value="'
        + esc(ownDataValue(node, 'outputVar') || '') + '" placeholder="orders"></div>'
        + '<div class="output-hint">输出格式: ' + esc(typeDef ? ownDataValue(typeDef, 'outputHint') : '—') + '</div>'
        + '<hr class="form-divider"><div class="form-grid">'
        + '<div class="form-row"><label>失败策略</label><select id="node-onFailure">'
        + '<option value="abort"' + (ownDataValue(node, 'onFailure') !== 'continue' ? ' selected' : '') + '>失败时中止本轮</option>'
        + '<option value="continue"' + (ownDataValue(node, 'onFailure') === 'continue' ? ' selected' : '') + '>失败时继续执行（软断言）</option>'
        + '</select></div>'
        + '<div class="form-row"><label>失败重试次数</label><input type="number" id="node-retries" min="0" value="'
        + esc(retriesLocked ? 0 : (ownDataValue(node, 'retries') || 0)) + '"'
        + (retriesLocked ? ' disabled title="该节点可能产生外部副作用，不允许自动重试"' : '') + '></div>'
        + (retriesLocked ? '' : '<div class="form-row"><label>重试间隔(ms)</label>'
          + numericControlHtml('retryDelayMs', ownDataValue(node, 'retryDelayMs') !== undefined
            && ownDataValue(node, 'retryDelayMs') !== '' ? ownDataValue(node, 'retryDelayMs') : 1000, 'common', '1000')
          + '</div>')
        + '<div class="form-row"><label>聚焦浏览器窗口</label><input type="checkbox" id="node-requiresForeground"'
        + (ownDataValue(node, 'requiresForeground') === true ? ' checked' : '') + '></div>'
        + '</div>';

      $('#drawer-content').innerHTML = body;
      $('#drawer-actions').innerHTML = readonly
        ? '<button class="btn-secondary" data-action="cancel-node-edit">关闭</button>'
        : '<button class="btn-primary" data-action="save-node-edit" data-id="' + esc(selectedNode.id)
          + '" data-node-index="' + match.index + '">保存</button>'
          + '<button class="btn-secondary" data-action="cancel-node-edit">取消</button>';
      if (readonly) {
        queryAll('input, select, textarea, button', $('#drawer-content')).forEach(function (element) {
          element.disabled = true;
        });
      }
      openDrawer();
      if (typeDef && Object.keys(assistantValues).length) {
        refreshAssistantFields(selectedNode.token, assistantValues);
      }
      if (typeDef && Object.keys(modelServiceValues).length) {
        refreshModelServiceFields(selectedNode.token, modelServiceValues);
      }
      return { ok: true, nodeId: selectedNode.id, index: match.index, readonly: readonly };
    }

    function selectedNodeMatch(draft) {
      if (!selectedNode || drawerMode !== 'node') return null;
      if (String(ownDataValue(draft, 'id') || '') !== selectedNode.flowId
          || currentFlowRevision() !== selectedNode.flowRevision) return null;
      var match = resolveNode(nodesOf(draft), selectedNode.id, selectedNode.index);
      if (!match || String(ownDataValue(match.node, 'type') || '') !== selectedNode.type) return null;
      return match;
    }

    function editorIdentity(context) {
      return {
        token: context.token,
        flowId: String(ownDataValue(context.draft, 'id') || ''),
        nodeId: nodeId(context.node),
        flowRevision: currentFlowRevision(),
      };
    }

    function editorIdentityMatches(identity) {
      if (destroyed || !identity || !selectedNode || drawerMode !== 'node'
          || identity.token !== selectedNode.token || identity.flowId !== selectedNode.flowId
          || identity.nodeId !== selectedNode.id || identity.flowRevision !== selectedNode.flowRevision
          || identity.flowRevision !== currentFlowRevision()) return false;
      var draft;
      try { draft = snapshotDraft(false); } catch (_) { return false; }
      return !!(draft && String(ownDataValue(draft, 'id') || '') === identity.flowId
        && selectedNodeMatch(draft));
    }

    function findParamElement(paramKey) {
      paramKey = String(paramKey || '');
      var elements = queryAll('[data-node-id="node"][data-param-key]', $('#drawer-content'));
      for (var index = 0; index < elements.length; index++) {
        if (String(elements[index].dataset.paramKey || '') === paramKey) return elements[index];
      }
      return null;
    }

    function findCandidateBox(paramKey) {
      var boxes = queryAll('[data-candidates-for]', $('#drawer-content'));
      for (var index = 0; index < boxes.length; index++) {
        if (String(boxes[index].dataset.candidatesFor || '') === String(paramKey || '')) return boxes[index];
      }
      return null;
    }

    function findVerifyResult(paramKey) {
      var results = queryAll('[data-verify-for]', $('#drawer-content'));
      for (var index = 0; index < results.length; index++) {
        if (String(results[index].dataset.verifyFor || '') === String(paramKey || '')) return results[index];
      }
      return null;
    }

    function collectEditorParams(node) {
      var existing = ownDataValue(node, 'params');
      var params = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? cloneData(existing)
        : Object.create(null);
      var typeDef = nodeTypes.getType(String(ownDataValue(node, 'type') || ''));
      var definitions = paramDefinitionMap(typeDef);
      queryAll('[data-node-id="node"][data-param-key]', $('#drawer-content')).forEach(function (element) {
        var key = String(element.dataset.paramKey || '');
        if (!isSafeKey(key) || !definitions[key]) return;
        params[key] = parseParamEditorValue(definitions[key], element);
      });
      collectNumericControls('param', definitions, function (key, value) { params[key] = value; });
      return params;
    }

    function currentEditorContext() {
      if (!selectedNode || drawerMode !== 'node') return null;
      var draft;
      try { draft = snapshotDraft(false); } catch (_) { return null; }
      if (!draft) return null;
      var match = selectedNodeMatch(draft);
      if (!match) return null;
      return { draft: draft, match: match, node: match.node, token: selectedNode.token };
    }

    function renderPickCandidates(paramKey, candidates, identity) {
      if (!editorIdentityMatches(identity)) return;
      var box = findCandidateBox(paramKey);
      if (!box) return;
      candidates = Array.isArray(candidates) ? candidates : [];
      if (!candidates.length) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = '<div class="pick-candidates-title">候选选择器（点击替换）:</div>'
        + candidates.map(function (candidate) {
          var selector = ownDataValue(candidate, 'selector');
          var unique = ownDataValue(candidate, 'unique') === true;
          return '<div class="pick-candidate' + (unique ? '' : ' ambiguous')
            + '" data-action="use-candidate" data-key="' + esc(paramKey) + '" data-selector="' + esc(selector) + '">'
            + '<code>' + esc(selector) + '</code><span class="muted">'
            + esc(ownDataValue(candidate, 'strategy') || '') + (unique ? '' : ' · 非唯一') + '</span></div>';
        }).join('');
    }

    function selectorToolTarget(context, params) {
      var rawTabId = ownDataValue(params, 'tabId');
      if (rawTabId === undefined || rawTabId === null || rawTabId === '') {
        rawTabId = ownDataValue(params, 'activeTabId');
      }
      var numericTabId = Number(rawTabId);
      var tabId = Number.isFinite(numericTabId) && numericTabId > 0 ? Math.floor(numericTabId) : 0;
      var pageId = String(ownDataValue(context && context.node, 'pageId') || '').trim();
      var pageUrl = '';
      try {
        var config = getConfig() || {};
        var pages = ownDataValue(config, 'pages');
        var page = pageId && ownDataValue(pages, pageId);
        pageUrl = String(ownDataValue(page, 'url') || '').trim();
      } catch (_) {}
      return { tabId: tabId, pageId: pageId, pageUrl: pageUrl };
    }

    function pickSelector(paramKey) {
      paramKey = String(paramKey || '');
      if (!isSafeKey(paramKey)) return;
      var context = currentEditorContext();
      if (!context) {
        toast('节点编辑器已变化，请重新打开', true);
        return;
      }
      var params;
      try { params = collectEditorParams(context.node); } catch (error) {
        toast('无法读取节点参数: ' + errorText(error, '参数数据无效'), true);
        return;
      }
      var target = selectorToolTarget(context, params);
      var request = ++selectorRequest;
      var identity = editorIdentity(context);
      toast('已切换到目标页面，请点击要选取的元素（按 Esc 取消）');
      Promise.resolve().then(getCurrentWindowId).then(function (windowId) {
        return sendMessage('START_ELEMENT_PICKER', Object.assign({ windowId: windowId }, target));
      }).then(function (response) {
        if (request !== selectorRequest || !editorIdentityMatches(identity)) return;
        if (!response || !response.ok) {
          toast('选取失败: ' + (response && response.error || '未知错误'), true);
          return;
        }
        if (!response.selector) {
          toast('已取消选取');
          return;
        }
        var input = findParamElement(paramKey);
        if (!input) return;
        input.value = response.selector;
        renderPickCandidates(paramKey, response.candidates || [], identity);
        toast('已填入选择器，可点「验证」确认元素是否匹配');
      }).catch(function (error) {
        if (request === selectorRequest && editorIdentityMatches(identity)) {
          toast('选取失败: ' + errorText(error, '未知错误'), true);
        }
      });
    }

    function renderVerifyResult(paramKey, response, identity, request) {
      if (request !== verifyRequest || !editorIdentityMatches(identity)) return;
      var element = findVerifyResult(paramKey);
      if (!element) return;
      if (!response || !response.ok) {
        element.className = 'verify-result verify-fail';
        element.textContent = '验证失败: ' + (response && response.error || '未知错误');
        return;
      }
      var info = response.payload || {};
      if (!ownDataValue(info, 'exists')) {
        element.className = 'verify-result verify-fail';
        element.textContent = '当前页面未找到匹配元素';
        return;
      }
      element.remove();
    }

    function verifySelectedSelector(paramKey) {
      paramKey = String(paramKey || '');
      if (!isSafeKey(paramKey)) return;
      var context = currentEditorContext();
      if (!context) {
        toast('节点编辑器已变化，请重新打开', true);
        return;
      }
      var params;
      try { params = collectEditorParams(context.node); } catch (error) {
        toast('无法读取节点参数: ' + errorText(error, '参数数据无效'), true);
        return;
      }
      var target = selectorToolTarget(context, params);
      var input = findParamElement(paramKey);
      var selector = input ? String(input.value || '').trim() : '';
      if (!selector) {
        toast('请先选取或输入选择器', true);
        return;
      }
      params.selector = selector;
      if (!ownDataValue(params, 'timeoutMs')) params.timeoutMs = 2000;
      var previous = findVerifyResult(paramKey);
      if (previous) previous.remove();
      var box = findCandidateBox(paramKey);
      if (box) {
        box.insertAdjacentHTML('beforeend', '<div class="verify-result" data-verify-for="'
          + esc(paramKey) + '">验证中...</div>');
      }
      var request = ++verifyRequest;
      var identity = editorIdentity(context);
      Promise.resolve().then(function () {
        return sendMessage('VERIFY_SELECTOR', Object.assign({ selector: selector, params: params }, target));
      })
        .then(function (response) { renderVerifyResult(paramKey, response, identity, request); })
        .catch(function (error) {
          renderVerifyResult(paramKey, { ok: false, error: errorText(error, '未知错误') }, identity, request);
        });
    }

    function finiteNonNegative(value) {
      var number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : 0;
    }

    function saveNodeEdit() {
      if (!ensureEditable()) return false;
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法保存节点: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (!draft) return false;
      var match = selectedNodeMatch(draft);
      if (!match) {
        toast('节点已变化，请重新打开编辑器', true);
        return false;
      }
      var node = match.node;
      var titleElement = $('#node-title');
      if (titleElement) node.title = String(titleElement.value || '').trim();
      var pageElement = $('#node-pageId');
      if (pageElement) node.pageId = String(pageElement.value || '');
      var outputElement = $('#node-outputVar');
      if (outputElement) node.outputVar = String(outputElement.value || '').trim();
      var failureElement = $('#node-onFailure');
      if (failureElement) node.onFailure = failureElement.value === 'continue' ? 'continue' : 'abort';
      var retriesElement = $('#node-retries');
      var foregroundElement = $('#node-requiresForeground');
      if (foregroundElement) {
        if (foregroundElement.checked) node.requiresForeground = true;
        else delete node.requiresForeground;
      }
      var commonKeys = Object.create(null);
      commonKeys.retryDelayMs = true;
      collectNumericControls('common', commonKeys, function (key, value) { node[key] = value; });
      try { node.params = collectEditorParams(node); } catch (error) {
        toast('无法保存节点参数: ' + errorText(error, '参数数据无效'), true);
        return false;
      }
      if (retriesElement) {
        node.retries = typeof nodeTypes.isNodeReplaySafe === 'function' && nodeTypes.isNodeReplaySafe(node)
          ? finiteNonNegative(retriesElement.value) : 0;
      }
      if (node.pageId && node.params && typeof node.params === 'object') delete node.params.tabId;
      if (!replaceDraft(draft)) return false;
      drawerMode = '';
      selectedNode = null;
      editorToken++;
      closeDrawer();
      return true;
    }

    function openAddNodeDrawer() {
      if (!ensureEditable()) return false;
      var hidden = Object.create(null);
      hidden.loopEnd = true;
      hidden.ifEnd = true;
      var categorized = Object.create(null);
      var categories = Array.isArray(nodeTypes.CATEGORIES) ? nodeTypes.CATEGORIES : [];
      categories.forEach(function (category) {
        var types = ownDataValue(category, 'types');
        (Array.isArray(types) ? types : []).forEach(function (type) { categorized[String(type)] = true; });
      });

      function optionHtml(typeDef) {
        var type = String(ownDataValue(typeDef, 'type') || '');
        if (!isSafeKey(type)) return '';
        var label = type === 'loopStart' ? '循环' : (type === 'ifStart' ? '条件分支' : ownDataValue(typeDef, 'label'));
        var searchText = (label + ' ' + type + ' ' + (ownDataValue(typeDef, 'description') || '')).toLowerCase();
        return '<div class="node-type-option" data-action="select-node-type" data-type="' + esc(type)
          + '" data-search="' + esc(searchText) + '" data-desc="' + esc(ownDataValue(typeDef, 'description') || '') + '">'
          + '<span class="type-label">' + esc(label) + '</span></div>';
      }

      var html = '<div class="form-row"><input type="text" id="node-type-search"'
        + ' placeholder="搜索节点（名称/功能，如：断言、滚动、cookie）" autocomplete="off"></div>';
      categories.forEach(function (category) {
        var categoryTypes = ownDataValue(category, 'types');
        var items = (Array.isArray(categoryTypes) ? categoryTypes : [])
          .filter(function (type) { return !hidden[type] && nodeTypes.getType(type); })
          .map(function (type) { return optionHtml(nodeTypes.getType(type)); })
          .join('');
        if (!items) return;
        html += '<div class="node-type-group collapsed"><div class="node-type-group-title"'
          + ' data-action="toggle-node-type-group">' + esc(ownDataValue(category, 'label')) + '</div>'
          + '<div class="node-type-grid">' + items + '</div></div>';
      });
      var allTypes = Array.isArray(nodeTypes.TYPES) ? nodeTypes.TYPES : [];
      var uncategorized = allTypes.filter(function (typeDef) {
        var type = String(ownDataValue(typeDef, 'type') || '');
        return !hidden[type] && !categorized[type];
      });
      if (uncategorized.length) {
        html += '<div class="node-type-group collapsed"><div class="node-type-group-title"'
          + ' data-action="toggle-node-type-group">其他</div><div class="node-type-grid">'
          + uncategorized.map(optionHtml).join('') + '</div></div>';
      }
      drawerMode = 'add-node';
      selectedNode = null;
      editorToken++;
      revision++;
      $('#drawer-title').textContent = '选择节点类型';
      $('#drawer-content').innerHTML = html;
      $('#drawer-actions').innerHTML = '<button class="btn-secondary" data-action="cancel-drawer">取消</button>';
      openDrawer();
      var search = $('#node-type-search');
      if (search) search.focus();
      return true;
    }

    function handleNodeTypeSearch(element) {
      if (drawerMode !== 'add-node') return;
      var keyword = String(element.value || '').trim().toLowerCase();
      queryAll('.node-type-group', $('#drawer-content')).forEach(function (group) {
        group.classList.toggle('collapsed', !keyword);
      });
      queryAll('.node-type-option', $('#drawer-content')).forEach(function (option) {
        option.style.display = !keyword || String(option.dataset.search || '').indexOf(keyword) !== -1 ? '' : 'none';
      });
      queryAll('.node-type-group', $('#drawer-content')).forEach(function (group) {
        var visible = queryAll('.node-type-option', group).some(function (option) {
          return option.style.display !== 'none';
        });
        group.style.display = visible ? '' : 'none';
      });
    }

    function addFlowNode(type) {
      if (!ensureEditable()) return '';
      type = String(type || '');
      if (type === 'loopEnd' || type === 'ifEnd') {
        toast('结束标记只能随对应结构自动创建', true);
        return '';
      }
      var typeDef = nodeTypes.getType(type);
      if (!typeDef && type !== 'elseBlock') {
        toast('未知节点类型: ' + type, true);
        return '';
      }
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法添加节点: ' + errorText(error, '节点数据无效'), true);
        return '';
      }
      if (!draft) return '';
      var nodes = nodesOf(draft);
      if (!Array.isArray(ownDataValue(draft, 'nodes'))) {
        nodes = [];
        draft.nodes = nodes;
      }
      var reserved = reservedNodeIds(nodes);
      var newNodeId = '';
      if (type === 'loopStart') {
        var loopId = generateStructureId('loop', nodes, 'loopId');
        var loopCount = nodes.filter(function (node) {
          return ownDataValue(node, 'type') === 'loopStart';
        }).length + 1;
        var startNode = {
          nodeId: generateNodeId(reserved),
          type: 'loopStart',
          title: '循环 ' + loopCount,
          pageId: '',
          params: { loopId: loopId, maxIterations: 0, breakCondition: '' },
          outputVar: '',
        };
        var endNode = {
          nodeId: generateNodeId(reserved),
          type: 'loopEnd',
          title: '循环 ' + loopCount + ' 结束',
          pageId: '',
          params: { loopId: loopId },
          outputVar: '',
        };
        nodes.push(startNode, endNode);
        newNodeId = startNode.nodeId;
      } else if (type === 'ifStart') {
        var ifId = generateStructureId('if', nodes, 'ifId');
        var ifCount = nodes.filter(function (node) { return ownDataValue(node, 'type') === 'ifStart'; }).length + 1;
        var ifStart = {
          nodeId: generateNodeId(reserved),
          type: 'ifStart',
          title: '条件分支 ' + ifCount,
          pageId: '',
          params: { ifId: ifId, condition: '' },
          outputVar: '',
        };
        nodes.push(ifStart, {
          nodeId: generateNodeId(reserved),
          type: 'ifEnd',
          title: '条件分支 ' + ifCount + ' 结束',
          pageId: '',
          params: { ifId: ifId },
          outputVar: '',
        });
        newNodeId = ifStart.nodeId;
      } else if (type === 'elseBlock') {
        var usedIfIds = Object.create(null);
        nodes.forEach(function (node) {
          if (ownDataValue(node, 'type') !== 'elseBlock') return;
          var params = ownDataValue(node, 'params');
          var id = String(ownDataValue(params, 'ifId') || '');
          if (isSafeKey(id)) usedIfIds[id] = true;
        });
        var lastIf = null;
        nodes.forEach(function (node) {
          if (ownDataValue(node, 'type') !== 'ifStart') return;
          var params = ownDataValue(node, 'params');
          var id = String(ownDataValue(params, 'ifId') || '');
          if (!usedIfIds[id]) lastIf = node;
        });
        var lastIfParams = ownDataValue(lastIf, 'params');
        var linkedIfId = String(ownDataValue(lastIfParams, 'ifId') || '');
        var elseNode = {
          nodeId: generateNodeId(reserved),
          type: 'elseBlock',
          title: 'Else 分支',
          pageId: '',
          params: { ifId: linkedIfId },
          outputVar: '',
        };
        var insertAt = nodes.length;
        if (lastIf) {
          for (var endIndex = 0; endIndex < nodes.length; endIndex++) {
            var candidateParams = ownDataValue(nodes[endIndex], 'params');
            if (ownDataValue(nodes[endIndex], 'type') === 'ifEnd'
                && String(ownDataValue(candidateParams, 'ifId') || '') === linkedIfId) {
              insertAt = endIndex;
              break;
            }
          }
        }
        nodes.splice(insertAt, 0, elseNode);
        newNodeId = elseNode.nodeId;
      } else {
        var node = {
          nodeId: generateNodeId(reserved),
          type: type,
          title: ownDataValue(typeDef, 'label') || type,
          pageId: '',
          params: Object.create(null),
          outputVar: '',
        };
        if (ownDataValue(typeDef, 'needsPage') || ownDataValue(typeDef, 'optionalPage')) {
          for (var previousIndex = nodes.length - 1; previousIndex >= 0; previousIndex--) {
            var previousPageId = String(ownDataValue(nodes[previousIndex], 'pageId') || '');
            if (!previousPageId) continue;
            node.pageId = previousPageId;
            break;
          }
          if (!node.pageId) {
            var pageIds = userConfigValues('pages').map(function (page) {
              return String(ownDataValue(page, 'id') || '');
            }).filter(Boolean);
            if (pageIds.length === 1) node.pageId = pageIds[0];
          }
        }
        paramDefinitions(typeDef).forEach(function (param) {
          var key = String(ownDataValue(param, 'key') || '');
          var defaultValue = ownDataValue(param, 'default');
          if (isSafeKey(key) && defaultValue !== undefined) node.params[key] = cloneData(defaultValue);
        });
        nodes.push(node);
        newNodeId = node.nodeId;
      }
      if (!replaceDraft(draft)) return '';
      drawerMode = '';
      closeDrawer();
      return newNodeId;
    }

    function moveFlowNode(fromIndex, toIndex, expectedId) {
      if (!ensureEditable()) return false;
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法移动节点: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (!draft) return false;
      var nodes = nodesOf(draft);
      var source = resolveNode(nodes, expectedId, fromIndex);
      toIndex = Number(toIndex);
      if (!source || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= nodes.length
          || source.index === toIndex) return false;
      var node = nodes.splice(source.index, 1)[0];
      nodes.splice(toIndex, 0, node);
      return replaceDraft(draft);
    }

    function deleteFlowNode(id, indexHint) {
      if (!ensureEditable()) return false;
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法删除节点: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (!draft) return false;
      var nodes = nodesOf(draft);
      var match = resolveNode(nodes, id, indexHint);
      if (!match) {
        toast('节点已变化，请刷新后重试', true);
        return false;
      }
      nodes.splice(match.index, 1);
      return replaceDraft(draft);
    }

    function copyFlowNode(id, indexHint) {
      if (!ensureEditable()) return false;
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法复制节点: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (!draft) return false;
      var nodes = nodesOf(draft);
      var match = resolveNode(nodes, id, indexHint);
      if (!match) {
        toast('节点已变化，请刷新后重试', true);
        return false;
      }
      var type = String(ownDataValue(match.node, 'type') || '');
      if (type === 'loopStart' || type === 'loopEnd' || type === 'ifStart'
          || type === 'ifEnd' || type === 'elseBlock') {
        toast('循环/分支标记节点不支持复制', true);
        return false;
      }
      var copy;
      try { copy = cloneData(match.node); } catch (error) {
        toast('无法复制节点: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      copy.nodeId = generateNodeId(reservedNodeIds(nodes));
      copy.title = String(ownDataValue(match.node, 'title') || '') + ' (副本)';
      nodes.splice(match.index + 1, 0, copy);
      return replaceDraft(draft);
    }

    function normalizeNodeOrders(nodes) {
      return (Array.isArray(nodes) ? nodes : []).map(function (node, index) {
        var copy = stripRuntimeMetadata(node);
        copy.displayOrder = index + 1;
        return copy;
      });
    }

    function associationId(params, key) {
      var value = ownDataValue(params, key);
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    }

    function validateFlowNodes(nodes) {
      if (!Array.isArray(nodes)) return ['流程节点必须是数组'];
      var errors = [];
      var loopStarts = Object.create(null);
      var loopEnds = Object.create(null);
      var ifStarts = Object.create(null);
      var ifEnds = Object.create(null);
      nodes.forEach(function (node, index) {
        if (node && typeof node === 'object') node.displayOrder = index + 1;
        var nodeErrors = nodeTypes.validateNodeInstance(node);
        if (Array.isArray(nodeErrors)) errors = errors.concat(nodeErrors);
        var type = String(ownDataValue(node, 'type') || '');
        var params = ownDataValue(node, 'params');
        params = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
        if (String(ownDataValue(params, 'confirmationMode') || '') === 'deferred') {
          var nextNode = nodes[index + 1];
          var nextParams = ownDataValue(nextNode, 'params');
          nextParams = nextParams && typeof nextParams === 'object' && !Array.isArray(nextParams) ? nextParams : {};
          var label = String(ownDataValue(node, 'title') || ownDataValue(node, 'type') || ('节点 ' + (index + 1)));
          if (!nextNode || ownDataValue(nextNode, 'type') !== 'waitForCondition') {
            errors.push('[' + label + '] 延后确认后必须紧跟等待页面条件节点');
          } else if (String(ownDataValue(node, 'pageId') || '') !== String(ownDataValue(nextNode, 'pageId') || '')
              || !ownDataValue(node, 'pageId') && String(ownDataValue(params, 'tabId') || '') !== String(ownDataValue(nextParams, 'tabId') || '')) {
            errors.push('[' + label + '] 延后确认动作与配对等待节点必须绑定同一页面');
          }
          if (String(ownDataValue(node, 'onFailure') || 'abort') === 'continue') {
            errors.push('[' + label + '] 延后确认动作的失败策略必须为中止');
          }
          var deferredOptional = ownDataValue(params, 'optional');
          if (deferredOptional === true || deferredOptional === 'true') {
            errors.push('[' + label + '] 延后确认动作不能同时设置为未找到时继续执行');
          }
          if (nextNode && String(ownDataValue(nextNode, 'onFailure') || 'abort') === 'continue') {
            errors.push('[' + label + '] 配对等待节点的失败策略必须为中止');
          }
        }
        if (type === 'loopStart') loopStarts[associationId(params, 'loopId')] = true;
        if (type === 'loopEnd') loopEnds[associationId(params, 'loopId')] = true;
        if (type === 'ifStart') ifStarts[associationId(params, 'ifId')] = true;
        if (type === 'ifEnd') ifEnds[associationId(params, 'ifId')] = true;
      });
      Object.keys(loopStarts).forEach(function (id) {
        if (!loopEnds[id]) errors.push('循环 ID ' + id + ' 缺少"循环结束"节点');
      });
      Object.keys(loopEnds).forEach(function (id) {
        if (!loopStarts[id]) errors.push('循环 ID ' + id + ' 缺少"循环开始"节点');
      });
      Object.keys(ifStarts).forEach(function (id) {
        if (!ifEnds[id]) errors.push('条件分支 ID ' + id + ' 缺少"分支结束"节点');
      });
      Object.keys(ifEnds).forEach(function (id) {
        if (!ifStarts[id]) errors.push('条件分支 ID ' + id + ' 缺少"条件分支 If"节点');
      });
      nodes.forEach(function (node) {
        if (ownDataValue(node, 'type') !== 'elseBlock') return;
        var ifId = associationId(ownDataValue(node, 'params'), 'ifId');
        if (!ifStarts[ifId]) errors.push('Else 分支的分支 ID "' + (ifId || '(空)') + '" 没有对应的条件分支');
      });
      return errors;
    }

    function splitFlowFromNode(id, indexHint) {
      if (!ensureEditable()) return false;
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法拆分流程: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (!draft || !ownDataValue(draft, 'id')) {
        toast('请先保存流程，再从节点拆分为新流程', true);
        return false;
      }
      var nodes = nodesOf(draft);
      var match = resolveNode(nodes, id, indexHint);
      if (!match) return false;
      if (match.index === 0) {
        toast('第一个节点不能作为拆分点；可以复制整个流程后再编辑', true);
        return false;
      }
      var headNodes = normalizeNodeOrders(nodes.slice(0, match.index));
      var tailNodes = normalizeNodeOrders(nodes.slice(match.index));
      var headErrors;
      var tailErrors;
      try {
        headErrors = validateFlowNodes(headNodes);
        tailErrors = validateFlowNodes(tailNodes);
      } catch (error) {
        toast('无法校验拆分结果: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      if (headErrors.length || tailErrors.length) {
        toast('当前拆分点会破坏循环/分支结构：' + (headErrors[0] || tailErrors[0]), true);
        return false;
      }
      var firstTail = tailNodes[0] || {};
      var draftId = String(ownDataValue(draft, 'id') || '');
      var draftLabel = String(ownDataValue(draft, 'label') || draftId);
      var defaultName = draftLabel + ' - ' + (ownDataValue(firstTail, 'title') || ownDataValue(firstTail, 'type') || '后半段');
      var newLabel = promptAction('后半段流程名称', defaultName);
      if (newLabel === null) return false;
      newLabel = String(newLabel || '').trim();
      if (!newLabel) {
        toast('新流程名称不能为空', true);
        return false;
      }
      if (!confirmAction('将从第 ' + (match.index + 1) + ' 个节点开始拆分：原流程保留前 '
          + match.index + ' 个节点，新建后半段流程。继续？')) return false;
      var newFlowId;
      try { newFlowId = String(generateConfigId('fl', 'flows', Object.create(null)) || ''); } catch (error) {
        toast('无法生成新流程 ID: ' + errorText(error, '未知错误'), true);
        return false;
      }
      if (!isSafeKey(newFlowId)) {
        toast('无法生成新流程 ID', true);
        return false;
      }
      var originalFlow;
      var newFlow;
      try {
        originalFlow = stripRuntimeMetadata(draft);
        originalFlow.nodes = headNodes;
        newFlow = stripRuntimeMetadata(draft);
        newFlow.id = newFlowId;
        newFlow.label = newLabel;
        newFlow.name = newLabel;
        newFlow.description = '从流程 "' + draftLabel + '" 的第 ' + (match.index + 1) + ' 个节点拆分而来。';
        newFlow.nodes = tailNodes;
        delete newFlow.createdAt;
        delete newFlow.updatedAt;
      } catch (error) {
        toast('无法准备拆分流程: ' + errorText(error, '节点数据无效'), true);
        return false;
      }
      var controller = flowController();
      if (!controller || typeof controller.saveSplit !== 'function') return false;
      try {
        Promise.resolve(controller.saveSplit({ originalFlow: originalFlow, newFlow: newFlow })).catch(function (error) {
          toast('拆分失败: ' + errorText(error, '未知错误'), true);
        });
      } catch (error) {
        toast('拆分失败: ' + errorText(error, '未知错误'), true);
        return false;
      }
      return true;
    }

    function runFromNode(id, indexHint) {
      var controller = flowController();
      var draft;
      try { draft = snapshotDraft(false); } catch (error) {
        toast('无法读取流程: ' + errorText(error, '流程数据无效'), true);
        return;
      }
      var flowId = String(ownDataValue(draft, 'id') || '');
      if (!draft || !flowId) {
        toast('请先保存流程，再从节点运行', true);
        return;
      }
      if (controller && typeof controller.isDirty === 'function' && controller.isDirty()) {
        toast('流程有未保存修改，请先保存后再从节点运行', true);
        return;
      }
      var localMatch = resolveNode(nodesOf(draft), id, indexHint);
      var savedFlow = safeMapValue(configMap('flows'), flowId);
      var savedMatch = savedFlow && localMatch
        ? resolveNode(nodesOf(savedFlow), nodeId(localMatch.node), localMatch.index)
        : null;
      var localSignature = '';
      var savedSignature = '';
      try {
        localSignature = localMatch ? dataSignature(stripRuntimeMetadata(localMatch.node)) : '';
        savedSignature = savedMatch ? dataSignature(stripRuntimeMetadata(savedMatch.node)) : '';
      } catch (error) {
        toast('无法检查节点保存状态: ' + errorText(error, '节点数据无效'), true);
        return;
      }
      if (!savedMatch || !localSignature || localSignature !== savedSignature) {
        toast('该节点尚未保存或已变化，请先保存流程', true);
        return;
      }
      Promise.resolve().then(function () { return getRunOriginContext('options'); }).then(function (origin) {
        return sendMessage('RESUME_FROM_NODE', Object.assign({ flowId: flowId, nodeId: nodeId(savedMatch.node) }, origin));
      }).then(function (response) {
        if (destroyed) return;
        if (response && response.ok) {
          toast('已从「' + (ownDataValue(savedMatch.node, 'title') || nodeId(savedMatch.node)) + '」开始运行，之前节点跳过');
        } else {
          toast('启动失败: ' + (response && response.error || '未知错误'), true);
        }
      }).catch(function (error) {
        toast('启动失败: ' + errorText(error, '未知错误'), true);
      });
    }

    function runSingleNode(id, indexHint) {
      var draft;
      try { draft = snapshotDraft(true); } catch (error) {
        toast('无法读取节点: ' + errorText(error, '节点数据无效'), true);
        return;
      }
      if (!draft) return;
      var match = resolveNode(nodesOf(draft), id, indexHint);
      if (!match) return;
      var matchParams = ownDataValue(match.node, 'params');
      if (String(ownDataValue(matchParams, 'confirmationMode') || '') === 'deferred') {
        toast('该动作的结果由后续条件等待节点确认，不能脱离等待节点单步运行', true);
        return;
      }
      var errors;
      try { errors = nodeTypes.validateNodeInstance(match.node); } catch (error) {
        toast('无法校验节点: ' + errorText(error, '节点数据无效'), true);
        return;
      }
      if (errors && errors.length) {
        toast(errors[0], true);
        return;
      }
      var title = ownDataValue(match.node, 'title') || ownDataValue(match.node, 'type') || id;
      var context = buildRuntimeContextFromInputs(draft, '单步运行节点「' + title + '」');
      if (context === null) return;
      var messageNode;
      try { messageNode = cloneData(match.node); } catch (error) {
        toast('无法执行节点: ' + errorText(error, '节点数据无效'), true);
        return;
      }
      Promise.resolve().then(function () {
        return sendMessage('EXECUTE_NODE_INSTANCE', {
          flowId: String(ownDataValue(draft, 'id') || ''),
          node: messageNode,
          context: context,
          resetContext: true,
        });
      }).then(function (response) {
        if (destroyed) return;
        if (response && response.ok) {
          try { consoleRef.info('[Page Agent] 单步节点运行结果', response.payload); } catch (_) {}
          toast('单步运行完成: ' + title + '（结果见控制台）');
        } else {
          toast('单步运行失败: ' + (response && response.error || '未知错误'), true);
        }
      }).catch(function (error) {
        toast('单步运行失败: ' + errorText(error, '未知错误'), true);
      });
    }

    function setupNodeDragDrop() {
      return { ok: !destroyed, delegated: true, destroyed: destroyed };
    }

    function dragCard(event) {
      var source = event && event.target;
      if (!source || typeof source.closest !== 'function') return null;
      var card = source.closest('.node-card');
      if (!card || card.classList.contains('readonly') || !card.closest('#node-list-container')) return null;
      return card;
    }

    function dragList(event) {
      var source = event && event.target;
      if (!source || typeof source.closest !== 'function') return null;
      var list = source.closest('#node-list-container');
      var editor = $('#flow-editor');
      return list && editor && editor.contains(list) ? list : null;
    }

    function dragCards(list) {
      return list ? queryAll('.node-card', list) : [];
    }

    function measureDragLayout(list, cards) {
      if (!list || !cards.length || typeof list.getBoundingClientRect !== 'function') return null;
      var listRect = list.getBoundingClientRect();
      var gap = 6;
      try {
        var style = windowRef.getComputedStyle && windowRef.getComputedStyle(list);
        var measuredGap = style && parseFloat(style.rowGap || style.gap);
        if (Number.isFinite(measuredGap)) gap = measuredGap;
      } catch (_) {}
      return {
        gap: gap,
        items: cards.map(function (card) {
          var rect = card.getBoundingClientRect();
          return {
            top: rect.top - listRect.top,
            height: rect.height,
            center: rect.top - listRect.top + rect.height / 2,
          };
        }),
      };
    }

    function destinationFromPointer(event, list) {
      var metrics = dragState.metrics;
      if (!metrics || !metrics.items.length || dragState.index < 0) return dragState.index;
      var listRect = list.getBoundingClientRect();
      var pointerY = Number(event.clientY) - listRect.top;
      var slot = metrics.items.length;
      for (var index = 0; index < metrics.items.length; index++) {
        if (pointerY < metrics.items[index].center) {
          slot = index;
          break;
        }
      }
      var destination = slot > dragState.index ? slot - 1 : slot;
      return Math.max(0, Math.min(destination, metrics.items.length - 1));
    }

    function clearDragTransforms(list) {
      dragCards(list).forEach(function (card) {
        card.style.removeProperty('--drag-shift-y');
      });
    }

    function previewDragDestination(list, destinationIndex) {
      if (!list || !dragState.metrics || destinationIndex === dragState.destinationIndex) return;
      var cards = dragCards(list);
      var metrics = dragState.metrics;
      var sourceIndex = dragState.index;
      var sourceCard = cards[sourceIndex];
      var sourceMetrics = metrics.items[sourceIndex];
      if (!sourceCard || !sourceMetrics || !metrics.items[destinationIndex]) return;

      clearDragTransforms(list);
      var shift = sourceMetrics.height + metrics.gap;
      if (destinationIndex > sourceIndex) {
        for (var downIndex = sourceIndex + 1; downIndex <= destinationIndex; downIndex++) {
          cards[downIndex].style.setProperty('--drag-shift-y', (-shift) + 'px');
        }
      } else if (destinationIndex < sourceIndex) {
        for (var upIndex = destinationIndex; upIndex < sourceIndex; upIndex++) {
          cards[upIndex].style.setProperty('--drag-shift-y', shift + 'px');
        }
      }
      dragState.destinationIndex = destinationIndex;
    }

    function handleDragStart(event) {
      var card = dragCard(event);
      if (!card) return;
      var list = card.closest('#node-list-container');
      var cards = dragCards(list);
      dragState.index = Number(card.dataset.nodeIndex);
      dragState.destinationIndex = dragState.index;
      dragState.nodeId = String(card.dataset.nodeId || '');
      dragState.draftRevision = currentFlowRevision();
      dragState.metrics = measureDragLayout(list, cards);
      list.classList.add('drag-active');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', dragState.nodeId || String(dragState.index)); } catch (_) {}
      }
      if (typeof windowRef.requestAnimationFrame === 'function') {
        var startedIndex = dragState.index;
        windowRef.requestAnimationFrame(function () {
          if (dragState.index === startedIndex) card.classList.add('dragging');
        });
      } else {
        card.classList.add('dragging');
      }
    }

    function clearDragClasses() {
      var editor = $('#flow-editor');
      queryAll('.node-list', editor).forEach(function (list) {
        list.classList.remove('drag-active');
        clearDragTransforms(list);
      });
      queryAll('.node-card', editor).forEach(function (card) {
        card.classList.remove('dragging');
      });
    }

    function handleDragEnd() {
      clearDragClasses();
      dragState.index = -1;
      dragState.destinationIndex = -1;
      dragState.nodeId = '';
      dragState.draftRevision = -1;
      dragState.metrics = null;
    }

    function handleDragOver(event) {
      var list = dragList(event);
      if (!list || dragState.index < 0) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      previewDragDestination(list, destinationFromPointer(event, list));
    }

    function handleDragLeave() {}

    function handleDrop(event) {
      var list = dragList(event);
      if (!list || dragState.index < 0) return;
      event.preventDefault();
      var targetIndex = destinationFromPointer(event, list);
      var fromIndex = dragState.index;
      var nodeId = dragState.nodeId;
      if (currentFlowRevision() !== dragState.draftRevision) {
        toast('流程草稿已变化，请重新拖拽节点', true);
        handleDragEnd();
        return;
      }
      handleDragEnd();
      if (fromIndex !== targetIndex) moveFlowNode(fromIndex, targetIndex, nodeId);
    }

    function ownsAction(action) {
      return !!OWNED_ACTIONS[String(action || '')];
    }

    function handleAction(action, actionElement, event) {
      if (destroyed) return false;
      action = String(action || '');
      if (!ownsAction(action)) return false;
      var id = String(actionElement && actionElement.dataset.id || '');
      var index = actionNodeIndex(actionElement);
      if (action === 'open-add-node-drawer') openAddNodeDrawer();
      else if (action === 'select-node-type') {
        var newId = addFlowNode(actionElement && actionElement.dataset.type);
        if (newId) openNodeEditor(newId, -1);
      } else if (action === 'toggle-node-type-group') {
        if (actionElement.parentElement) actionElement.parentElement.classList.toggle('collapsed');
      } else if (action === 'edit-node' || action === 'view-node') {
        if (event) event.stopPropagation();
        openNodeEditor(id, index);
      } else if (action === 'save-node-edit') saveNodeEdit();
      else if (action === 'cancel-node-edit') {
        drawerMode = '';
        selectedNode = null;
        editorToken++;
        closeDrawer();
      } else if (action === 'pick-selector') {
        if (event) event.stopPropagation();
        pickSelector(actionElement && actionElement.dataset.key);
      } else if (action === 'verify-selector') {
        if (event) event.stopPropagation();
        verifySelectedSelector(actionElement && actionElement.dataset.key);
      } else if (action === 'use-candidate') {
        if (event) event.stopPropagation();
        var input = findParamElement(actionElement && actionElement.dataset.key);
        if (input) input.value = String(actionElement.dataset.selector || '');
      } else if (action === 'num-mode-fixed' || action === 'num-mode-random') {
        var box = actionElement && actionElement.closest('.num-control');
        if (box) {
          var randomMode = action === 'num-mode-random';
          box.classList.toggle('random', randomMode);
          var fixedButton = box.querySelector('.num-mode-fixed-btn');
          var randomButton = box.querySelector('.num-mode-random-btn');
          if (fixedButton) fixedButton.classList.toggle('active', !randomMode);
          if (randomButton) randomButton.classList.toggle('active', randomMode);
        }
      } else if (action === 'delete-node') deleteFlowNode(id, index);
      else if (action === 'run-from-node') {
        if (event) event.stopPropagation();
        runFromNode(id, index);
      } else if (action === 'run-single-node') {
        if (event) event.stopPropagation();
        runSingleNode(id, index);
      } else if (action === 'copy-node') {
        if (event) event.stopPropagation();
        copyFlowNode(id, index);
      } else if (action === 'split-flow-from-node') {
        if (event) event.stopPropagation();
        splitFlowFromNode(id, index);
      }
      return true;
    }

    function handleDrawerClosed() {
      drawerMode = '';
      selectedNode = null;
      editorToken++;
      selectorRequest++;
      verifyRequest++;
      return { ok: !destroyed, destroyed: destroyed };
    }

    function handleDocumentClick(event) {
      var source = event && event.target;
      if (!source || typeof source.closest !== 'function') return;
      var actionElement = source.closest('[data-action]');
      if (!actionElement) return;
      var action = String(actionElement.dataset.action || '');
      if (action === 'cancel-drawer' && drawerMode) {
        handleDrawerClosed();
        closeDrawer();
        return;
      }
      handleAction(action, actionElement, event);
    }

    function handleDocumentInput(event) {
      var source = event && event.target;
      if (source && source.id === 'node-type-search') handleNodeTypeSearch(source);
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      lifecycle.listen(documentRef, 'click', handleDocumentClick);
      lifecycle.listen(documentRef, 'input', handleDocumentInput);
      var flowEditor = $('#flow-editor');
      lifecycle.listen(flowEditor, 'dragstart', handleDragStart);
      lifecycle.listen(flowEditor, 'dragend', handleDragEnd);
      lifecycle.listen(flowEditor, 'dragover', handleDragOver);
      lifecycle.listen(flowEditor, 'dragleave', handleDragLeave);
      lifecycle.listen(flowEditor, 'drop', handleDrop);
      lifecycle.listen(windowRef, 'pagehide', function (event) {
        if (!event || !event.persisted) destroy();
      });
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      revision++;
      editorToken++;
      selectorRequest++;
      verifyRequest++;
      selectedNode = null;
      drawerMode = '';
      lifecycle.destroy();
      return { ok: true, destroyed: true };
    }

    return {
      init: init,
      destroy: destroy,
      ownsAction: ownsAction,
      handleAction: handleAction,
      refreshAssistantReferences: refreshAssistantReferences,
      handleDrawerClosed: handleDrawerClosed,
      nodeCardHtml: nodeCardHtml,
      setupNodeDragDrop: setupNodeDragDrop,
      validateFlowNodes: validateFlowNodes,
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          revision: revision,
          drawerMode: drawerMode,
          selectedNodeId: selectedNode && selectedNode.id || '',
        };
      },
    };
  }

  return { API_VERSION: API_VERSION, create: create };
});
