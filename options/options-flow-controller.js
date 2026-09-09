// Flow list/editor lifecycle, persistence, copy/export, and dependency guards for options.html.
(function attachOptionsFlowController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsFlowController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsFlowController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsFlowController missing dependency: ' + name);
    return value;
  }

  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function isSafeKey(value) {
    return typeof value === 'string' && value.length > 0 && !UNSAFE_KEYS[value];
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function cloneData(value, ancestors, path) {
    path = path || '$';
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType !== 'object') throw new TypeError('流程数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('流程数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
        throw new TypeError('流程数据禁止自定义 toJSON: ' + path);
      }
      var array = new Array(value.length);
      for (var index = 0; index < value.length; index++) {
        var arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!arrayDescriptor) {
          array[index] = null;
          continue;
        }
        if (arrayDescriptor.get || arrayDescriptor.set
            || !Object.prototype.hasOwnProperty.call(arrayDescriptor, 'value')) {
          throw new TypeError('流程数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = arrayDescriptor.value === undefined
          ? null
          : cloneData(arrayDescriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
      throw new TypeError('流程数据禁止自定义 toJSON: ' + path);
    }
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('流程数据禁止访问器字段: ' + path + '.' + key);
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

  function stripRuntimeMetadata(value) {
    if (Array.isArray(value)) return value.map(stripRuntimeMetadata);
    if (value && typeof value === 'object') {
      var output = Object.create(null);
      Object.keys(value).forEach(function (key) {
        if (!isSafeKey(key) || key.indexOf('__builtin') === 0 || key === 'mcpValidation') return;
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError('流程数据禁止访问器字段: ' + key);
        }
        if (descriptor.value === undefined || typeof descriptor.value === 'function'
            || typeof descriptor.value === 'symbol') return;
        Object.defineProperty(output, key, {
          value: stripRuntimeMetadata(descriptor.value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
      return output;
    }
    return value;
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

  function normalizedFlowId(value) {
    return String(value || '').trim().replace(/^user:/, '');
  }

  function create(options) {
    options = options || {};
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsFlowController');
    }

    var window = options.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    var lifecycle = options.lifecycle || lifecycleFactory.create(window);
    var $ = requireFunction(options.$, '$');
    var esc = requireFunction(options.esc, 'esc');
    var resourceClient = options.resourceClient;
    if (!resourceClient || typeof resourceClient.get !== 'function'
        || typeof resourceClient.authorizedPost !== 'function'
        || typeof resourceClient.authorizedPatch !== 'function'
        || typeof resourceClient.authorizedDelete !== 'function') {
      throw new Error('OptionsFlowController requires PageAutomationResourceClient');
    }
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var mutateConfig = requireFunction(options.mutateConfig, 'mutateConfig');
    var applyFlowEnvelope = requireFunction(options.applyFlowEnvelope, 'applyFlowEnvelope');
    var removeFlowFromState = requireFunction(options.removeFlowFromState, 'removeFlowFromState');
    var refreshFlowResources = requireFunction(options.refreshFlowResources, 'refreshFlowResources');
    var sortedValues = requireFunction(options.sortedValues, 'sortedValues');
    var renderConfigListItems = requireFunction(options.renderConfigListItems, 'renderConfigListItems');
    var resetConfigListPage = requireFunction(options.resetConfigListPage, 'resetConfigListPage');
    var isBuiltinItem = requireFunction(options.isBuiltinItem, 'isBuiltinItem');
    var itemIdHtml = requireFunction(options.itemIdHtml, 'itemIdHtml');
    var flowUsageSummary = requireFunction(options.flowUsageSummary, 'flowUsageSummary');
    var renderFlowUsageSummary = requireFunction(options.renderFlowUsageSummary, 'renderFlowUsageSummary');
    var normalizeRunTabMode = requireFunction(options.normalizeRunTabMode, 'normalizeRunTabMode');
    var runTabModeSelectHtml = requireFunction(options.runTabModeSelectHtml, 'runTabModeSelectHtml');
    var nodeCardHtml = requireFunction(options.nodeCardHtml, 'nodeCardHtml');
    var setupNodeDragDrop = requireFunction(options.setupNodeDragDrop, 'setupNodeDragDrop');
    var validateFlowNodes = requireFunction(options.validateFlowNodes, 'validateFlowNodes');
    var generateConfigId = requireFunction(options.generateConfigId, 'generateConfigId');
    var downloadFile = requireFunction(options.downloadFile, 'downloadFile');
    var scrollOpenedEditor = requireFunction(options.scrollOpenedEditor, 'scrollOpenedEditor');
    var toastImpl = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var isActive = requireFunction(options.isActive, 'isActive');
    var onIdle = typeof options.onIdle === 'function' ? options.onIdle : function () {};

    var initialized = false;
    var destroyed = false;
    var draft = null;
    var dirty = false;
    var draftRevision = 0;
    var draftPendingId = '';
    var draftFormSignature = '';
    var saveInFlight = null;
    var saveRevision = -1;
    var splitInFlight = null;
    var splitRevision = -1;
    var copyInFlight = Object.create(null);
    var deleteInFlight = Object.create(null);
    var targetInFlight = Object.create(null);

    function segment(value) {
      return Array.from(String(value || '')).map(function (character) {
        return /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/.test(character)
          || (character.charCodeAt(0) > 0x7f && !/[\s\u0080-\u009f]/u.test(character))
          ? character : encodeURIComponent(character);
      }).join('');
    }

    function flowUri(flowId) {
      return '/flows/' + segment(flowId);
    }

    function envelopeData(envelope) {
      var data = envelope && envelope.primary && envelope.primary.data;
      return data && typeof data === 'object' && !Array.isArray(data) ? cloneData(data) : null;
    }

    function applyEnvelope(envelope) {
      var applied = applyFlowEnvelope(envelope);
      return applied && typeof applied === 'object' ? cloneData(applied) : envelopeData(envelope);
    }

    function resourceOptions(extra) {
      return Object.assign({}, extra || {});
    }

    function toast(message, isError) {
      if (destroyed) return;
      try { toastImpl(message, isError); } catch (_) {}
    }

    function currentConfig() {
      var config = getConfig();
      return config && typeof config === 'object' ? config : {};
    }

    function configSection(name, fallback) {
      var config = currentConfig();
      var descriptor = Object.getOwnPropertyDescriptor(config, name);
      if (!descriptor) return cloneData(fallback);
      if (descriptor.get || descriptor.set || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('配置分区禁止访问器字段: ' + name);
      }
      return cloneData(descriptor.value === undefined ? fallback : descriptor.value, null, '$.' + name);
    }

    function configMap(name) {
      var map = configSection(name, {});
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        throw new TypeError('配置分区必须是对象: ' + name);
      }
      return map;
    }

    function safeMapValue(map, id) {
      if (!isSafeKey(id) || !map || typeof map !== 'object' || Array.isArray(map)) return null;
      var descriptor = Object.getOwnPropertyDescriptor(map, id);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      return descriptor.value;
    }

    function findFlow(flowId, stripRuntime) {
      var flow = safeMapValue(configMap('flows'), String(flowId || ''));
      if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return null;
      return stripRuntime ? stripRuntimeMetadata(flow) : cloneData(flow);
    }

    function dataSignature(value) {
      try { return JSON.stringify(value); } catch (_) { return ''; }
    }

    function draftId() {
      return String(ownDataValue(draft, 'id') || '');
    }

    function draftIsReadOnly() {
      return isBuiltinItem(draft);
    }

    function isMutating() {
      return !!(saveInFlight || splitInFlight || Object.keys(copyInFlight).length
        || Object.keys(deleteInFlight).length || Object.keys(targetInFlight).length);
    }

    function notifyWhenIdle() {
      Promise.resolve().then(function () {
        if (destroyed || isMutating()) return;
        try { onIdle(); } catch (_) {}
      });
    }

    function ensureEditable() {
      if (!draft) {
        toast('没有可编辑的流程', true);
        return false;
      }
      if (!draftIsReadOnly()) return true;
      toast('内置流程不能直接修改，请先复制为用户流程', true);
      return false;
    }

    function editorElement(id) {
      var editor = $('#flow-editor');
      return editor && editor.querySelector('#' + id);
    }

    function readEditorData() {
      var label = editorElement('flow-label');
      var description = editorElement('flow-description');
      var inputDescription = editorElement('flow-input-description');
      var outputDescription = editorElement('flow-output-description');
      var inputExample = editorElement('flow-input-example');
      var runTabMode = editorElement('flow-run-tab-mode');
      var dataset = editorElement('flow-dataset');
      var cdpKeepAlive = editorElement('flow-cdp-keepalive');
      if (!label || !description || !inputDescription || !outputDescription || !inputExample
          || !runTabMode || !dataset || !cdpKeepAlive) return null;
      return {
        label: String(label.value || '').trim(),
        description: String(description.value || '').trim(),
        inputDescription: String(inputDescription.value || '').trim(),
        outputDescription: String(outputDescription.value || '').trim(),
        inputExample: String(inputExample.value || '').trim(),
        runTabMode: normalizeRunTabMode(runTabMode.value),
        dataset: String(dataset.value || '').trim(),
        allowCdpKeepAlive: !!cdpKeepAlive.checked,
        disableKeepAlive: !cdpKeepAlive.checked,
      };
    }

    function syncDraftFromEditor(syncOptions) {
      syncOptions = syncOptions || {};
      if (destroyed || !draft || draftIsReadOnly()) return draft ? cloneData(draft) : null;
      var editorData = readEditorData();
      if (!editorData) return cloneData(draft);
      var signature = dataSignature(editorData);
      if (signature !== draftFormSignature) {
        var next = cloneData(draft);
        next.label = editorData.label;
        next.description = editorData.description;
        next.inputDescription = editorData.inputDescription;
        next.outputDescription = editorData.outputDescription;
        next.inputExample = editorData.inputExample;
        next.runTabMode = editorData.runTabMode;
        next.dataset = editorData.dataset;
        next.allowCdpKeepAlive = editorData.allowCdpKeepAlive;
        next.disableKeepAlive = editorData.disableKeepAlive;
        delete next.inputs;
        delete next.outputs;
        draft = next;
        draftRevision++;
        draftFormSignature = signature;
      }
      if (syncOptions.markDirty !== false) dirty = true;
      return cloneData(draft);
    }

    function handleEditorChange() {
      if (destroyed || !draft || draftIsReadOnly()) return;
      syncDraftFromEditor({ markDirty: true });
    }

    function reconcileDraft() {
      if (!draft || dirty || isMutating() || !draftId()) return;
      var fresh = findFlow(draftId(), false);
      if (!fresh) {
        draft = null;
        draftPendingId = '';
        draftFormSignature = '';
        draftRevision++;
        return;
      }
      if (dataSignature(fresh) !== dataSignature(draft)) {
        draft = fresh;
        draftRevision++;
        draftFormSignature = '';
      }
    }

    function render() {
      if (destroyed) return { ok: false, destroyed: true };
      var list = $('#flows-list');
      if (!list) return { ok: false, error: '流程列表不存在' };
      var flows;
      try {
        reconcileDraft();
        flows = sortedValues(configMap('flows'));
      } catch (error) {
        var listMessage = '无法渲染流程列表: ' + errorText(error, '流程数据无效');
        toast(listMessage, true);
        return { ok: false, error: listMessage };
      }
      list.innerHTML = renderConfigListItems('flows', flows, '<div class="placeholder">还没有流程，点击「新建流程」开始编排</div>', function (flow) {
        var nodes = ownDataValue(flow, 'nodes');
        var nodeCount = Array.isArray(nodes) ? nodes.length : 0;
        var builtin = isBuiltinItem(flow);
        var id = String(ownDataValue(flow, 'id') || '');
        var usageSummary = flowUsageSummary(flow);
        return '<div class="item-card' + (draft && draftId() === id ? ' selected' : '') + (builtin ? ' builtin' : '') + '" data-action="edit-flow" data-id="' + esc(id) + '">'
          + '<span class="item-title">' + esc(ownDataValue(flow, 'label') || '(未命名)') + '</span>'
          + '<span class="item-sub">' + nodeCount + ' 个节点' + (ownDataValue(flow, 'dataset') ? ' · 数据驱动' : '') + (usageSummary ? ' · ' + esc(usageSummary) : '') + (ownDataValue(flow, 'description') ? ' · ' + esc(ownDataValue(flow, 'description')) : '') + '</span>'
          + (builtin ? '<span class="badge builtin">内置</span>' : '')
          + '<button class="btn-small" data-action="run-flow" data-id="' + esc(id) + '">运行</button>'
          + (builtin
            ? '<button class="btn-small" disabled title="内置流程不支持导出，请先复制为用户流程">导出</button>'
            : '<button class="btn-small" data-action="export-flow" data-id="' + esc(id) + '">导出</button>')
          + (builtin
            ? '<button class="btn-small" disabled title="内置流程不能直接修改，请先复制">修改</button>'
              + '<button class="btn-small btn-danger-outline" disabled title="内置流程不能删除">删除</button>'
              + '<button class="btn-small" data-action="copy-flow" data-id="' + esc(id) + '">复制</button>'
            : '')
          + itemIdHtml(id)
          + '</div>';
      });
      renderEditor();
      return { ok: true, draftOpen: !!draft };
    }

    function renderEditor() {
      if (destroyed) return { ok: false, destroyed: true };
      var editor = $('#flow-editor');
      if (!editor) return { ok: false, error: '流程编辑器不存在' };
      if (!draft) {
        editor.classList.add('hidden');
        editor.innerHTML = '';
        draftFormSignature = '';
        return { ok: true, draftOpen: false };
      }
      var flow = cloneData(draft);
      var nodes = ownDataValue(flow, 'nodes');
      if (!Array.isArray(nodes)) nodes = [];
      var readonly = draftIsReadOnly();
      var id = String(ownDataValue(flow, 'id') || '');

      editor.classList.remove('hidden');
      editor.innerHTML =
        '<h3>' + (readonly ? '查看内置流程' : (id ? '编辑流程' : '新建流程')) + (readonly ? ' <span class="badge builtin">内置</span>' : '') + '</h3>'
        + (readonly ? '<div class="readonly-banner">内置流程来自扩展包，只能运行或复制为用户流程后编辑。</div>' : '')
        + '<div class="flow-editor-header">'
        + '<div class="form-row"><label>流程名称</label><input type="text" id="flow-label" value="' + esc(ownDataValue(flow, 'label')) + '" placeholder="如：每日报表推送"' + (readonly ? ' disabled' : '') + '></div>'
        + (readonly ? '' : '<button class="btn-primary" data-action="open-add-node-drawer">添加节点</button>')
        + '</div>'
        + '<div class="form-row form-row-spaced"><label>使用说明</label>'
        + '<textarea id="flow-description" rows="3" placeholder="说明这个流程做什么、运行前需要什么页面状态，以及调用示例。"' + (readonly ? ' disabled' : '') + '>' + esc(ownDataValue(flow, 'description') || '') + '</textarea></div>'
        + '<div class="form-grid io-editor-grid">'
        + '<div class="form-row"><label>入参说明</label>'
        + '<textarea id="flow-input-description" rows="4" placeholder="写给使用者看的入参说明，例如运行 JSON 可以传哪些字段、字段含义、可选值。这里不生成入参表单，不做校验。"' + (readonly ? ' disabled' : '') + '>' + esc(ownDataValue(flow, 'inputDescription') || '') + '</textarea></div>'
        + '<div class="form-row"><label>出参说明</label>'
        + '<textarea id="flow-output-description" rows="4" placeholder="写给使用者看的出参说明，例如 result.answer 是最终回答，result 是完整对象。这里不配置出参路径。"' + (readonly ? ' disabled' : '') + '>' + esc(ownDataValue(flow, 'outputDescription') || '') + '</textarea></div>'
        + '</div>'
        + '<div class="form-row form-row-spaced"><label>运行入参示例（可选 JSON）</label>'
        + '<textarea id="flow-input-example" rows="4" placeholder=\'{"question":"你是谁，当前是什么时间","mode":"quick","deepThink":"false","webSearch":"true"}\'' + (readonly ? ' disabled' : '') + '>' + esc(ownDataValue(flow, 'inputExample') || '') + '</textarea>'
        + '<div class="form-help">仅作为运行界面的预填示例。运行入参仍是可选 JSON，不会生成字段表单或强制校验。</div></div>'
        + renderFlowUsageSummary(flow, '填写后，运行界面会展示说明和输入示例。')
        + '<div class="form-row form-row-spaced"><label>运行标签策略</label>'
        + runTabModeSelectHtml('flow-run-tab-mode', ownDataValue(flow, 'runTabMode') || 'reuseOpenTab', readonly, false)
        + '<div class="form-help">控制本流程打开页面时使用哪个标签。流程组步骤可单独覆盖该设置。</div></div>'
        + '<div class="form-row form-row-spaced"><label>数据集（可选，JSON 数组；每组数据跑一遍流程，节点参数用 {{data.字段}} 引用）</label>'
        + '<textarea id="flow-dataset" rows="3" placeholder=\'[{"user":"alice","pwd":"123"},{"user":"bob","pwd":"456"}]\'' + (readonly ? ' disabled' : '') + '>' + esc(ownDataValue(flow, 'dataset') || '') + '</textarea></div>'
        + '<div class="form-row form-row-spaced"><label class="switch-label">'
        + '<input type="checkbox" id="flow-cdp-keepalive"' + (ownDataValue(flow, 'allowCdpKeepAlive') === true && ownDataValue(flow, 'disableKeepAlive') !== true ? ' checked' : '') + (readonly ? ' disabled' : '') + '>'
        + '<span class="switch-slider"></span>'
        + '<span class="switch-text">启用 CDP 防节流保活（可检测）</span></label>'
        + '<small>后台稳定模式：运行期间保持 CDP 调试器附加，只激活目标 tab，不主动聚焦浏览器窗口；意外断线会立即重接并重试当前命令。敏感页面可能检测到 DevTools 侧效应</small></div>'
        + '<div class="node-list" id="node-list-container">'
        + (nodes.length ? nodes.map(function (node, index) {
          return nodeCardHtml(node, index, nodes.length, nodes, readonly);
        }).join('') : '<div class="placeholder">暂无节点，点击上方「添加节点」开始</div>')
        + '</div>'
        + '<div class="editor-actions">'
        + (readonly
          ? '<button class="btn-primary" disabled title="内置流程不能直接修改，请先复制">保存流程</button>'
            + '<button class="btn-primary" data-action="run-flow" data-id="' + esc(id) + '">运行</button>'
            + '<button class="btn-secondary" data-action="validate-flow" data-id="' + esc(id) + '">校验</button>'
            + '<button class="btn-secondary" disabled title="内置流程不支持导出，请先复制为用户流程">导出</button>'
            + '<button class="btn-secondary" data-action="copy-flow" data-id="' + esc(id) + '">复制为用户流程</button>'
            + '<button class="btn-secondary" data-action="cancel-flow">关闭</button>'
          : '<button class="btn-primary" data-action="save-flow">保存流程</button>'
            + (id ? '<button class="btn-secondary" data-action="validate-flow" data-id="' + esc(id) + '">校验</button>' : '')
            + '<button class="btn-secondary" data-action="cancel-flow">取消</button>')
        + '<span class="spacer"></span>'
        + (readonly
          ? '<button class="btn-danger" disabled title="内置流程不能删除">删除</button>'
          : (id ? '<button class="btn-danger" data-action="delete-flow" data-id="' + esc(id) + '">删除</button>' : ''))
        + '</div>';

      try {
        draftFormSignature = dataSignature(readEditorData());
      } catch (_) {
        draftFormSignature = '';
      }
      if (!readonly) setupNodeDragDrop();
      return { ok: true, draftOpen: true, readonly: readonly };
    }

    function confirmDiscard() {
      if (!draft || !dirty) return true;
      if (!confirmAction('当前流程有未保存的修改，确定丢弃吗？\n（点「取消」可回去点击「保存流程」）')) return false;
      dirty = false;
      notifyWhenIdle();
      return true;
    }

    function openNew() {
      if (destroyed) return { ok: false, destroyed: true };
      if (!confirmDiscard()) return { ok: false, cancelled: true };
      draft = {
        label: '',
        nodes: [],
        runTabMode: 'reuseOpenTab',
        allowCdpKeepAlive: false,
        disableKeepAlive: true,
      };
      dirty = false;
      draftPendingId = '';
      draftFormSignature = '';
      draftRevision++;
      if (isActive()) {
        render();
        scrollOpenedEditor('#flow-editor');
      }
      return { ok: true };
    }

    function openById(flowId, openOptions) {
      openOptions = openOptions || {};
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      flowId = String(flowId || '');
      if (draft && draftId() === flowId && openOptions.reload !== true) {
        if (isActive() && openOptions.render !== false) {
          render();
          if (openOptions.scroll !== false) scrollOpenedEditor('#flow-editor');
        }
        return Promise.resolve({ ok: true, retained: true });
      }
      if (openOptions.force !== true && !confirmDiscard()) return Promise.resolve({ ok: false, cancelled: true });
      return resourceClient.get(flowUri(flowId)).then(function (envelope) {
        if (destroyed) return { ok: false, destroyed: true };
        var nextDraft = applyEnvelope(envelope);
        if (!nextDraft) throw new Error('流程资源没有返回可编辑内容');
        draft = nextDraft;
        dirty = false;
        draftPendingId = '';
        draftFormSignature = '';
        draftRevision++;
        if (isActive() && openOptions.render !== false) {
          render();
          if (openOptions.scroll !== false) scrollOpenedEditor('#flow-editor');
        }
        return { ok: true, flow: cloneData(nextDraft) };
      }).catch(function (error) {
        var message = '无法打开流程: ' + errorText(error, '流程资源读取失败');
        toast(message, true);
        return { ok: false, error: message };
      });
    }

    function clearDraft(clearOptions) {
      clearOptions = clearOptions || {};
      draft = null;
      dirty = false;
      draftPendingId = '';
      draftFormSignature = '';
      draftRevision++;
      if (clearOptions.render !== false && !destroyed && isActive()) render();
      notifyWhenIdle();
      return { ok: !destroyed, destroyed: destroyed };
    }

    function replaceDraft(nextDraft, replaceOptions) {
      replaceOptions = replaceOptions || {};
      if (destroyed) return { ok: false, destroyed: true };
      var previousId = draftId();
      var cloned;
      try {
        cloned = nextDraft ? cloneData(nextDraft) : null;
      } catch (error) {
        var message = '无法更新流程草稿: ' + errorText(error, '流程数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
      var nextId = String(ownDataValue(cloned, 'id') || '');
      draft = cloned;
      if (previousId !== nextId) draftPendingId = '';
      dirty = replaceOptions.dirty !== undefined ? !!replaceOptions.dirty : dirty;
      draftFormSignature = '';
      draftRevision++;
      if (replaceOptions.render !== false && isActive()) renderEditor();
      return { ok: true, draft: draft ? cloneData(draft) : null, revision: draftRevision };
    }

    function getDraft(getOptions) {
      getOptions = getOptions || {};
      if (getOptions.syncEditor === true) syncDraftFromEditor({ markDirty: getOptions.markDirty !== false });
      return draft ? cloneData(draft) : null;
    }

    function setDirty(value) {
      dirty = !!value && !!draft && !draftIsReadOnly();
      if (!dirty) notifyWhenIdle();
      return dirty;
    }

    function validationFailure(message) {
      toast(message, true);
      return Promise.resolve({ ok: false, error: message });
    }

    function targetBusy(targetId, requestedOperation) {
      var active = isSafeKey(targetId) ? targetInFlight[targetId] : null;
      if (!active) return null;
      var labels = { save: '保存', copy: '复制', delete: '删除', split: '拆分' };
      var message = '流程正在' + (labels[active.kind] || '更新') + '，请稍后再' + (labels[requestedOperation] || '操作');
      toast(message, true);
      return {
        ok: false,
        busy: true,
        operation: active.kind,
        requestedOperation: requestedOperation,
        error: message,
      };
    }

    function trackTarget(targetId, kind, operation) {
      if (!isSafeKey(targetId)) return;
      targetInFlight[targetId] = { kind: kind, promise: operation };
      operation.then(function () {
        if (targetInFlight[targetId] && targetInFlight[targetId].promise === operation) delete targetInFlight[targetId];
        notifyWhenIdle();
      }, function () {
        if (targetInFlight[targetId] && targetInFlight[targetId].promise === operation) delete targetInFlight[targetId];
        notifyWhenIdle();
      });
    }

    function reservedIds(section) {
      var reserved = Object.create(null);
      Object.keys(configMap(section)).forEach(function (id) { reserved[id] = true; });
      Object.keys(targetInFlight).forEach(function (id) { reserved[id] = true; });
      return reserved;
    }

    function nextConfigId(prefix, section, reserved) {
      reserved = reserved || reservedIds(section);
      var id = String(generateConfigId(prefix, section, reserved) || '');
      if (!isSafeKey(id) || safeMapValue(configMap(section), id) || targetInFlight[id]) {
        throw new Error('无法生成配置 ID');
      }
      reserved[id] = true;
      return id;
    }

    function flowMetadata(item) {
      var metadata = stripRuntimeMetadata(item || {});
      delete metadata.nodes;
      delete metadata.createdAt;
      delete metadata.updatedAt;
      return metadata;
    }

    function normalizedNodes(nodes) {
      return (Array.isArray(nodes) ? nodes : []).map(function (node, index) {
        var next = stripRuntimeMetadata(node);
        next.displayOrder = index + 1;
        return next;
      });
    }

    function refreshFlow(flowId, desiredSignature) {
      return resourceClient.get(flowUri(flowId)).then(function (envelope) {
        var current = applyEnvelope(envelope);
        if (!current) throw new Error('流程资源刷新未返回内容');
        if (draft && draftId() === flowId) {
          var localNodes = ownDataValue(draft, 'nodes');
          if (!desiredSignature || dataSignature(normalizedNodes(localNodes)) === desiredSignature) {
            var nextDraft = cloneData(draft);
            nextDraft.nodes = cloneData(ownDataValue(current, 'nodes') || []);
            draft = nextDraft;
            draftFormSignature = '';
          }
        }
        return current;
      });
    }

    function syncFlowNodes(flowId, desiredNodes) {
      flowId = String(flowId || '');
      var desired = normalizedNodes(desiredNodes);
      var desiredSignature = dataSignature(desired);
      return resourceClient.get(flowUri(flowId)).then(function (envelope) {
        if (!applyEnvelope(envelope)) throw new Error('流程资源不存在');
        return resourceClient.authorizedPatch(flowUri(flowId), { nodes: desired }, resourceOptions({
          ifMatch: 'cached',
          criteria: { relation: 'flow' },
        }));
      }).then(function (envelope) {
        if (!applyEnvelope(envelope)) throw new Error('更新流程节点未返回资源');
        return refreshFlow(flowId, desiredSignature);
      });
    }

    function save() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (!ensureEditable()) return Promise.resolve({ ok: false, error: '没有可保存的流程' });
      syncDraftFromEditor({ markDirty: true });
      if (!draft) return validationFailure('没有可保存的流程');
      if (saveInFlight && saveRevision === draftRevision) return saveInFlight;

      var item;
      try { item = cloneData(draft); } catch (error) {
        return validationFailure('无法保存流程: ' + errorText(error, '流程数据无效'));
      }
      item.label = String(ownDataValue(item, 'label') || '').trim();
      var nodes = ownDataValue(item, 'nodes');
      if (!item.label) return validationFailure('流程名称不能为空');
      if (!Array.isArray(nodes) || !nodes.length) return validationFailure('流程至少需要一个节点');
      if (ownDataValue(item, 'dataset')) {
        try {
          var dataset = JSON.parse(item.dataset);
          if (!Array.isArray(dataset)) return validationFailure('数据集必须是 JSON 数组');
        } catch (_) {
          return validationFailure('数据集不是合法的 JSON');
        }
      }
      var errors;
      try {
        errors = validateFlowNodes(nodes);
      } catch (error) {
        return validationFailure('无法校验流程: ' + errorText(error, '节点数据无效'));
      }
      if (errors.length) return validationFailure(errors[0]);

      var itemId = String(ownDataValue(item, 'id') || '');
      if (!itemId) {
        try {
          if (!draftPendingId) draftPendingId = nextConfigId('fl', 'flows');
          item.id = draftPendingId;
          itemId = draftPendingId;
        } catch (error) {
          return validationFailure('无法保存流程: ' + errorText(error, '无法生成流程 ID'));
        }
      }
      var busy = targetBusy(itemId, 'save');
      if (busy) return Promise.resolve(busy);

      var revision = draftRevision;
      var committed = false;
      var existingResource = !!findFlow(itemId, false);
      function stillCurrent() {
        return !destroyed && !!draft && revision === draftRevision;
      }
      var operation = Promise.resolve().then(function () {
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        var metadata = flowMetadata(item);
        if (!existingResource) {
          metadata.id = itemId;
          metadata.nodes = [];
          return resourceClient.authorizedPost('/flows', metadata, resourceOptions({
            criteria: { relation: 'flows' },
          })).then(function (envelope) {
            var created = applyEnvelope(envelope);
            if (!created) throw new Error('创建流程未返回资源');
            itemId = String(ownDataValue(created, 'id') || itemId);
          });
        }
        return resourceClient.get(flowUri(itemId)).then(function (envelope) {
          applyEnvelope(envelope);
          delete metadata.id;
          return resourceClient.authorizedPatch(flowUri(itemId), metadata, resourceOptions({
            ifMatch: 'cached',
            criteria: { relation: 'flow' },
          }));
        }).then(function (envelope) {
          if (!applyEnvelope(envelope)) throw new Error('更新流程未返回资源');
        });
      }).then(function (skipped) {
        if (skipped && skipped.stale) return skipped;
        return syncFlowNodes(itemId, nodes);
      }).then(function (saved) {
        if (saved && saved.stale) return saved;
        committed = true;
        return refreshFlowResources().catch(function () {}).then(function () { return saved; });
      }).then(function () {
        if (!stillCurrent()) {
          return { ok: true, committed: true, flowId: itemId, draftChanged: !destroyed && !!draft, destroyed: destroyed };
        }
        clearDraft({ render: false });
        resetConfigListPage('flows');
        toast('流程已保存');
        if (isActive()) render();
        return { ok: true, committed: true, flowId: itemId };
      }).catch(function (error) {
        if (committed) {
          var refreshMessage = '流程已保存，但刷新失败: ' + errorText(error, '未知错误');
          toast(refreshMessage, true);
          return { ok: true, committed: true, flowId: itemId, refreshWarning: refreshMessage, destroyed: destroyed };
        }
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        var message = '保存失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, error: message };
      });
      saveInFlight = operation;
      saveRevision = revision;
      trackTarget(itemId, 'save', operation);
      operation.then(function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
        }
      }, function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
        }
      });
      return operation;
    }

    function copy(flowId, event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      flowId = String(flowId || '');
      if (!isSafeKey(flowId)) return Promise.resolve({ ok: false, error: '流程不存在' });
      if (copyInFlight[flowId]) return copyInFlight[flowId];
      var sourceBusy = targetBusy(flowId, 'copy');
      if (sourceBusy) return Promise.resolve(sourceBusy);

      var config;
      var source;
      var pageIdMap = Object.create(null);
      var scriptIdMap = Object.create(null);
      var newFlowId = '';
      var operations = [];
      try {
        config = cloneData(currentConfig());
        var flows = ownDataValue(config, 'flows') || {};
        var pages = ownDataValue(config, 'pages') || {};
        var scripts = ownDataValue(config, 'scripts') || {};
        source = safeMapValue(flows, flowId);
        if (!source) return Promise.resolve({ ok: false, error: '流程不存在' });

        var reservedFlows = reservedIds('flows');
        var reservedPages = reservedIds('pages');
        var reservedScripts = reservedIds('scripts');
        newFlowId = nextConfigId('fl', 'flows', reservedFlows);
        var sourceNodes = ownDataValue(source, 'nodes');
        (Array.isArray(sourceNodes) ? sourceNodes : []).forEach(function (node) {
          var pageId = String(ownDataValue(node, 'pageId') || '');
          if (pageId && safeMapValue(pages, pageId) && !pageIdMap[pageId]) {
            pageIdMap[pageId] = nextConfigId('pa', 'pages', reservedPages);
          }
          var params = ownDataValue(node, 'params');
          var scriptId = String(ownDataValue(params, 'scriptId') || '');
          if (scriptId && safeMapValue(scripts, scriptId) && !scriptIdMap[scriptId]) {
            scriptIdMap[scriptId] = nextConfigId('sc', 'scripts', reservedScripts);
          }
        });

        function remapNode(node) {
          var copiedNode = stripRuntimeMetadata(node);
          if (copiedNode.pageId && pageIdMap[copiedNode.pageId]) copiedNode.pageId = pageIdMap[copiedNode.pageId];
          copiedNode.params = copiedNode.params || {};
          if (copiedNode.params.scriptId && scriptIdMap[copiedNode.params.scriptId]) {
            copiedNode.params.scriptId = scriptIdMap[copiedNode.params.scriptId];
          }
          return copiedNode;
        }

        Object.keys(pageIdMap).forEach(function (oldId) {
          var page = stripRuntimeMetadata(safeMapValue(pages, oldId));
          page.id = pageIdMap[oldId];
          page.label = String(page.label || page.url || oldId) + ' (副本)';
          delete page.updatedAt;
          operations.push(['pages', page]);
        });
        Object.keys(scriptIdMap).forEach(function (oldId) {
          var script = stripRuntimeMetadata(safeMapValue(scripts, oldId));
          script.id = scriptIdMap[oldId];
          script.label = String(script.label || oldId) + ' (副本)';
          delete script.updatedAt;
          operations.push(['scripts', script]);
        });
        var flow = stripRuntimeMetadata(source);
        flow.id = newFlowId;
        flow.label = String(flow.label || flowId) + ' (副本)';
        var flowNodes = ownDataValue(flow, 'nodes');
        flow.nodes = (Array.isArray(flowNodes) ? flowNodes : []).map(remapNode);
        delete flow.updatedAt;
        operations.push(['flows', flow]);
      } catch (error) {
        var prepareMessage = '复制流程失败: ' + errorText(error, '流程数据无效');
        toast(prepareMessage, true);
        return Promise.resolve({ ok: false, error: prepareMessage });
      }

      var revision = draftRevision;
      var mayOpen = !draft || !dirty;
      var committedCount = 0;
      var chain = Promise.resolve();
      operations.forEach(function (operation) {
        chain = chain.then(function () {
          if (operation[0] === 'flows') {
            var copiedFlow = operation[1];
            var copiedNodes = ownDataValue(copiedFlow, 'nodes') || [];
            var metadata = flowMetadata(copiedFlow);
            metadata.nodes = [];
            return resourceClient.authorizedPost('/flows', metadata, resourceOptions({
              criteria: { relation: 'flows' },
            })).then(function (envelope) {
              var created = applyEnvelope(envelope);
              if (!created) throw new Error('复制流程失败');
              return syncFlowNodes(String(ownDataValue(created, 'id') || ''), copiedNodes);
            }).then(function () { committedCount++; });
          }
          return mutateConfig('upsert', operation[0], operation[1]).then(function (nextConfig) {
            if (!nextConfig) throw new Error('复制流程失败');
            committedCount++;
          });
        });
      });
      var allCommitted = false;
      var result = chain.then(function () {
        allCommitted = true;
        if (destroyed) return { ok: true, committed: true, flowId: newFlowId, destroyed: true };
        resetConfigListPage('pages');
        resetConfigListPage('flows');
        resetConfigListPage('scripts');
        var opened = mayOpen && revision === draftRevision;
        if (opened) {
          var copied = findFlow(newFlowId, false);
          if (!copied) throw new Error('复制后的流程不存在');
          draft = copied;
          dirty = false;
          draftPendingId = '';
          draftFormSignature = '';
          draftRevision++;
        }
        toast('已复制为用户流程');
        if (isActive()) {
          render();
          if (opened) scrollOpenedEditor('#flow-editor');
        }
        return { ok: true, committed: true, flowId: newFlowId, opened: opened };
      }).catch(function (error) {
        if (allCommitted) {
          var refreshMessage = '流程已复制，但刷新失败: ' + errorText(error, '未知错误');
          toast(refreshMessage, true);
          return { ok: true, committed: true, flowId: newFlowId, refreshWarning: refreshMessage, destroyed: destroyed };
        }
        var partial = committedCount > 0;
        var message = partial
          ? '流程仅完成部分复制，请检查已生成的依赖配置: ' + errorText(error, '未知错误')
          : '复制流程失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, committed: partial, partial: partial, committedCount: committedCount, flowId: newFlowId, error: message };
      });
      copyInFlight[flowId] = result;
      trackTarget(flowId, 'copy', result);
      operations.forEach(function (operation) {
        var targetId = String(ownDataValue(operation[1], 'id') || '');
        trackTarget(targetId, 'copy', result);
      });
      result.then(function () {
        if (copyInFlight[flowId] === result) delete copyInFlight[flowId];
      }, function () {
        if (copyInFlight[flowId] === result) delete copyInFlight[flowId];
      });
      return result;
    }

    function collectFlowBundleParts(flowId) {
      var flows = configMap('flows');
      var pages = configMap('pages');
      var scripts = configMap('scripts');
      var flow = safeMapValue(flows, flowId);
      var outputPages = Object.create(null);
      var outputScripts = Object.create(null);
      if (!flow) return { flow: null, pages: outputPages, scripts: outputScripts };
      var exportedFlow = stripRuntimeMetadata(flow);
      var nodes = ownDataValue(flow, 'nodes');
      (Array.isArray(nodes) ? nodes : []).forEach(function (node) {
        var pageId = String(ownDataValue(node, 'pageId') || '');
        var page = safeMapValue(pages, pageId);
        if (pageId && page && !isBuiltinItem(page)) outputPages[pageId] = stripRuntimeMetadata(page);
        var params = ownDataValue(node, 'params');
        var scriptId = String(ownDataValue(params, 'scriptId') || '');
        var script = safeMapValue(scripts, scriptId);
        if (scriptId && script && !isBuiltinItem(script)) outputScripts[scriptId] = stripRuntimeMetadata(script);
      });
      return { flow: exportedFlow, pages: outputPages, scripts: outputScripts };
    }

    function exportFlow(flowId, event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (destroyed) return { ok: false, destroyed: true };
      flowId = String(flowId || '');
      try {
        var flow = findFlow(flowId, false);
        if (!flow) return { ok: false, error: '流程不存在' };
        if (isBuiltinItem(flow)) {
          toast('内置流程不支持导出，请先复制为用户流程', true);
          return { ok: false, builtin: true, error: '内置流程不支持导出' };
        }
        var parts = collectFlowBundleParts(flowId);
        var bundle = {
          kind: 'pfa-flow',
          version: 1,
          exportedAt: new Date().toISOString(),
          flow: parts.flow || stripRuntimeMetadata(flow),
          pages: parts.pages,
          scripts: parts.scripts,
        };
        var label = String(ownDataValue(flow, 'label') || flowId);
        downloadFile('flow-' + label.replace(/[^\w一-龥-]+/g, '_') + '.json', JSON.stringify(bundle, null, 2), 'application/json');
        return { ok: true, flowId: flowId };
      } catch (error) {
        var message = '导出流程失败: ' + errorText(error, '流程数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
    }

    function remove(flowId) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      flowId = String(flowId || '');
      if (!isSafeKey(flowId)) return Promise.resolve({ ok: false, error: '流程不存在' });
      if (deleteInFlight[flowId]) return deleteInFlight[flowId];
      var busy = targetBusy(flowId, 'delete');
      if (busy) return Promise.resolve(busy);
      var source;
      try {
        source = findFlow(flowId, false);
        if (!source) return Promise.resolve({ ok: false, error: '流程不存在' });
        if (isBuiltinItem(source)) return Promise.resolve({ ok: false, builtin: true, error: '内置流程不能删除' });
      } catch (error) {
        var inspectMessage = '无法读取流程: ' + errorText(error, '配置数据无效');
        toast(inspectMessage, true);
        return Promise.resolve({ ok: false, error: inspectMessage });
      }
      if (!confirmAction('确定删除该流程？')) return Promise.resolve({ ok: false, cancelled: true });

      var committed = false;
      var operation = Promise.resolve().then(function () {
        return resourceClient.get(flowUri(flowId));
      }).then(function (envelope) {
        applyEnvelope(envelope);
        return resourceClient.authorizedDelete(flowUri(flowId), resourceOptions({
          ifMatch: 'cached',
          criteria: { relation: 'flow' },
        }));
      }).then(function () {
        committed = true;
        removeFlowFromState(flowId);
        return refreshFlowResources().catch(function () {});
      }).then(function () {
        if (destroyed) return { ok: true, committed: true, flowId: flowId, destroyed: true };
        if (draft && normalizedFlowId(draftId()) === normalizedFlowId(flowId)) clearDraft({ render: false });
        resetConfigListPage('flows');
        toast('流程已删除');
        if (isActive()) render();
        return { ok: true, committed: true, flowId: flowId };
      }).catch(function (error) {
        if (committed) {
          var refreshMessage = '流程已删除，但刷新失败: ' + errorText(error, '未知错误');
          toast(refreshMessage, true);
          return { ok: true, committed: true, flowId: flowId, refreshWarning: refreshMessage, destroyed: destroyed };
        }
        var message = '删除失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, committed: false, error: message };
      });
      deleteInFlight[flowId] = operation;
      trackTarget(flowId, 'delete', operation);
      operation.then(function () {
        if (deleteInFlight[flowId] === operation) delete deleteInFlight[flowId];
      }, function () {
        if (deleteInFlight[flowId] === operation) delete deleteInFlight[flowId];
      });
      return operation;
    }

    function saveSplit(split) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      split = split || {};
      if (splitInFlight && splitRevision === draftRevision) return splitInFlight;
      var original;
      var created;
      try {
        original = cloneData(split.originalFlow);
        created = cloneData(split.newFlow);
      } catch (error) {
        return validationFailure('拆分失败: ' + errorText(error, '流程数据无效'));
      }
      var originalId = String(ownDataValue(original, 'id') || '');
      var createdId = String(ownDataValue(created, 'id') || '');
      if (!originalId || !createdId || !draft || draftId() !== originalId) {
        return validationFailure('拆分失败: 流程草稿已变化');
      }
      var originalBusy = targetBusy(originalId, 'split');
      if (originalBusy) return Promise.resolve(originalBusy);
      var createdBusy = targetBusy(createdId, 'split');
      if (createdBusy) return Promise.resolve(createdBusy);
      var revision = draftRevision;
      var committedCount = 0;
      var allCommitted = false;
      var operation = Promise.resolve().then(function () {
        var createdMetadata = flowMetadata(created);
        createdMetadata.nodes = [];
        return resourceClient.authorizedPost('/flows', createdMetadata, resourceOptions({
          criteria: { relation: 'flows' },
        })).then(function (envelope) {
          var createdResource = applyEnvelope(envelope);
          if (!createdResource) throw new Error('保存新流程失败');
          return syncFlowNodes(createdId, ownDataValue(created, 'nodes') || []);
        });
      }).then(function () {
        committedCount++;
        return resourceClient.get(flowUri(originalId)).then(function (envelope) {
          applyEnvelope(envelope);
          var metadata = flowMetadata(original);
          delete metadata.id;
          return resourceClient.authorizedPatch(flowUri(originalId), metadata, resourceOptions({
            ifMatch: 'cached',
            criteria: { relation: 'flow' },
          }));
        }).then(function (envelope) {
          if (!applyEnvelope(envelope)) throw new Error('保存前半段流程失败');
          return syncFlowNodes(originalId, ownDataValue(original, 'nodes') || []);
        });
      }).then(function () {
        committedCount++;
        allCommitted = true;
        return refreshFlowResources().catch(function () {});
      }).then(function () {
        if (destroyed) return { ok: true, committed: true, flowId: createdId, destroyed: true };
        resetConfigListPage('flows');
        var opened = revision === draftRevision;
        if (opened) {
          var nextDraft = findFlow(createdId, false);
          if (!nextDraft) throw new Error('拆分后的流程不存在');
          draft = nextDraft;
          dirty = false;
          draftPendingId = '';
          draftFormSignature = '';
          draftRevision++;
        }
        toast('已从此节点拆分为新流程');
        if (isActive()) {
          render();
          if (opened) scrollOpenedEditor('#flow-editor');
        }
        return { ok: true, committed: true, flowId: createdId, opened: opened };
      }).catch(function (error) {
        if (allCommitted) {
          var refreshMessage = '流程已拆分，但刷新失败: ' + errorText(error, '未知错误');
          toast(refreshMessage, true);
          return { ok: true, committed: true, flowId: createdId, refreshWarning: refreshMessage, destroyed: destroyed };
        }
        var partial = committedCount > 0;
        var message = partial
          ? '拆分仅完成部分保存，新流程已创建但原流程未更新: ' + errorText(error, '未知错误')
          : '拆分失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, committed: partial, partial: partial, committedCount: committedCount, flowId: createdId, error: message };
      });
      splitInFlight = operation;
      splitRevision = revision;
      trackTarget(originalId, 'split', operation);
      trackTarget(createdId, 'split', operation);
      operation.then(function () {
        if (splitInFlight === operation) {
          splitInFlight = null;
          splitRevision = -1;
        }
      }, function () {
        if (splitInFlight === operation) {
          splitInFlight = null;
          splitRevision = -1;
        }
      });
      return operation;
    }

    function validate(flowId) {
      flowId = String(flowId || '');
      if (!flowId) return validationFailure('请先保存流程再校验');
      var uri = flowUri(flowId);
      return resourceClient.get(uri + '?view=validation').then(function (envelope) {
        var result = envelopeData(envelope) || {};
        if (result.valid === true) {
          toast('流程校验通过' + (result.warnings && result.warnings.length ? '，有 ' + result.warnings.length + ' 条建议' : ''));
          return { ok: true, validation: result };
        }
        var firstError = result.errors && result.errors[0] || '流程校验未通过';
        toast('流程校验失败: ' + firstError, true);
        return { ok: false, validation: result, error: firstError };
      }).catch(function (error) {
        var message = '流程校验失败: ' + errorText(error, '资源请求失败');
        toast(message, true);
        return { ok: false, error: message };
      });
    }

    function handleAction(action, flowId, event) {
      if (action === 'edit-flow') {
        openById(flowId);
        return true;
      }
      if (action === 'save-flow') {
        save();
        return true;
      }
      if (action === 'cancel-flow') {
        if (confirmDiscard()) clearDraft();
        return true;
      }
      if (action === 'copy-flow') {
        copy(flowId, event);
        return true;
      }
      if (action === 'export-flow') {
        exportFlow(flowId, event);
        return true;
      }
      if (action === 'delete-flow') {
        remove(flowId);
        return true;
      }
      if (action === 'validate-flow') {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        validate(flowId);
        return true;
      }
      return false;
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      lifecycle.listen($('#btn-new-flow'), 'click', openNew);
      lifecycle.listen($('#flow-editor'), 'input', handleEditorChange);
      lifecycle.listen($('#flow-editor'), 'change', handleEditorChange);
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      draft = null;
      dirty = false;
      draftPendingId = '';
      draftFormSignature = '';
      draftRevision++;
      lifecycle.destroy();
      return { ok: true, destroyed: true };
    }

    return {
      init: init,
      destroy: destroy,
      render: render,
      renderEditor: renderEditor,
      handleAction: handleAction,
      openNew: openNew,
      openById: openById,
      clearDraft: clearDraft,
      confirmDiscard: confirmDiscard,
      ensureEditable: ensureEditable,
      isReadOnly: draftIsReadOnly,
      isDirty: function () { return dirty; },
      isMutating: isMutating,
      setDirty: setDirty,
      getDraft: getDraft,
      replaceDraft: replaceDraft,
      syncDraftFromEditor: syncDraftFromEditor,
      refreshFlow: refreshFlow,
      saveSplit: saveSplit,
      validate: validate,
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          dirty: dirty,
          saving: !!saveInFlight,
          splitting: !!splitInFlight,
          copying: Object.keys(copyInFlight).length > 0,
          deleting: Object.keys(deleteInFlight).length > 0,
          mutating: isMutating(),
          draftId: draftId(),
          revision: draftRevision,
        };
      },
    };
  }

  return { create: create };
});
