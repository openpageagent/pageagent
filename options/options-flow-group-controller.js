// Flow Group list/editor state, step composition, validation, and persistence for options.html.
(function attachOptionsFlowGroupController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsFlowGroupController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  if (!lifecycleApi || typeof lifecycleApi.create !== 'function') {
    throw new Error('PageAutomationLifecycle must load before OptionsFlowGroupController');
  }
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsFlowGroupController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsFlowGroupController missing dependency: ' + name);
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
    if (valueType !== 'object') throw new TypeError('流程组数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('流程组数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
        throw new TypeError('流程组数据禁止自定义 toJSON: ' + path);
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
          throw new TypeError('流程组数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = arrayDescriptor.value === undefined
          ? null
          : cloneData(arrayDescriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
      throw new TypeError('流程组数据禁止自定义 toJSON: ' + path);
    }
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('流程组数据禁止访问器字段: ' + path + '.' + key);
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

  function create(options) {
    options = options || {};
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsFlowGroupController');
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
      throw new Error('OptionsFlowGroupController requires PageAutomationResourceClient');
    }
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var applyFlowGroupEnvelope = requireFunction(options.applyFlowGroupEnvelope, 'applyFlowGroupEnvelope');
    var removeFlowGroupFromState = requireFunction(options.removeFlowGroupFromState, 'removeFlowGroupFromState');
    var refreshFlowResources = requireFunction(options.refreshFlowResources, 'refreshFlowResources');
    var sortedValues = requireFunction(options.sortedValues, 'sortedValues');
    var renderConfigListItems = requireFunction(options.renderConfigListItems, 'renderConfigListItems');
    var resetConfigListPage = requireFunction(options.resetConfigListPage, 'resetConfigListPage');
    var isBuiltinItem = requireFunction(options.isBuiltinItem, 'isBuiltinItem');
    var itemIdHtml = requireFunction(options.itemIdHtml, 'itemIdHtml');
    var scrollOpenedEditor = requireFunction(options.scrollOpenedEditor, 'scrollOpenedEditor');
    var toastImpl = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var isActive = requireFunction(options.isActive, 'isActive');
    var onIdle = typeof options.onIdle === 'function' ? options.onIdle : function () {};
    var listableFlows = requireFunction(options.listableFlows, 'listableFlows');
    var flowUsageSummary = requireFunction(options.flowUsageSummary, 'flowUsageSummary');
    var renderFlowUsageSummary = requireFunction(options.renderFlowUsageSummary, 'renderFlowUsageSummary');
    var normalizeRunTabMode = requireFunction(options.normalizeRunTabMode, 'normalizeRunTabMode');
    var runTabModeSelectHtml = requireFunction(options.runTabModeSelectHtml, 'runTabModeSelectHtml');
    var openDrawer = requireFunction(options.openDrawer, 'openDrawer');
    var closeDrawer = requireFunction(options.closeDrawer, 'closeDrawer');
    var generateFlowGroupId = requireFunction(options.generateFlowGroupId, 'generateFlowGroupId');
    var generateStepId = requireFunction(options.generateStepId, 'generateStepId');
    var runTabModeOptions = cloneData(options.runTabModeOptions || []);

    var initialized = false;
    var destroyed = false;
    var draft = null;
    var draftRevision = 0;
    var draftBaselineRevision = 0;
    var draftBaselinePersisted = false;
    var externallyDeletedDraftId = '';
    var draftGeneration = 0;
    var renderedDraftGeneration = -1;
    var draftFormSignature = '';
    var saveInFlight = null;
    var saveRevision = -1;
    var targetInFlight = Object.create(null);
    var dragState = {
      index: -1,
      destinationIndex: -1,
      draftRevision: -1,
      metrics: null,
    };
    var activeStepEdit = null;

    function notifyWhenIdle() {
      Promise.resolve().then(function () {
        if (destroyed || saveInFlight || Object.keys(targetInFlight).length) return;
        try { onIdle(); } catch (_) {}
      });
    }

    function segment(value) {
      return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
        return '%' + character.charCodeAt(0).toString(16).toUpperCase();
      });
    }

    function groupUri(flowGroupId) {
      return '/flow-groups/' + segment(flowGroupId);
    }

    function applyEnvelope(envelope) {
      var applied = applyFlowGroupEnvelope(envelope);
      if (applied && typeof applied === 'object') return cloneData(applied);
      var data = envelope && envelope.primary && envelope.primary.data;
      return data && typeof data === 'object' && !Array.isArray(data) ? cloneData(data) : null;
    }

    function resourceOptions(extra) {
      return Object.assign({}, extra || {});
    }

    function toast(message, isError) {
      if (destroyed) return;
      try {
        toastImpl(message, isError);
      } catch (_) {}
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

    function findFlowGroup(flowGroupId) {
      var group = safeMapValue(configMap('flowGroups'), String(flowGroupId || ''));
      if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
      return cloneData(group);
    }

    function normalizeFlowReference(flowId) {
      if (typeof flowId !== 'string') return '';
      var raw = flowId.trim();
      if (raw !== flowId) return '';
      return raw.replace(/^user:/, '');
    }

    function flowForReference(flowId, flows) {
      return safeMapValue(flows, normalizeFlowReference(flowId));
    }

    function draftIsReadOnly() {
      return isBuiltinItem(draft);
    }

    function ensureDraftEditable() {
      if (!draft) {
        toast('没有可编辑的流程组', true);
        return false;
      }
      if (!draftIsReadOnly()) return true;
      toast('内置流程组不能直接修改，请先复制为用户流程组', true);
      return false;
    }

    function editorRoot() {
      return $('#flowGroup-editor');
    }

    function editorElement(id) {
      var root = editorRoot();
      var element = root && root.querySelector('#' + id);
      if (!element) throw new Error('流程组编辑器缺少字段: ' + id);
      return element;
    }

    function readEditorData() {
      return {
        label: editorElement('flowGroup-label').value,
        description: editorElement('flowGroup-description').value,
        inputDescription: editorElement('flowGroup-input-description').value,
        outputDescription: editorElement('flowGroup-output-description').value,
        inputExample: editorElement('flowGroup-input-example').value,
      };
    }

    function editorDataSignature(data) {
      return JSON.stringify(data);
    }

    function applyEditorData(data) {
      draft.label = data.label;
      draft.description = data.description;
      draft.inputDescription = data.inputDescription;
      draft.outputDescription = data.outputDescription;
      draft.inputExample = data.inputExample;
    }

    function syncDraftFromEditor() {
      if (!draft || draftIsReadOnly() || renderedDraftGeneration !== draftGeneration) return null;
      var data = readEditorData();
      var signature = editorDataSignature(data);
      if (signature !== draftFormSignature) {
        applyEditorData(data);
        draftFormSignature = signature;
        draftRevision++;
      }
      return data;
    }

    function handleEditorChange() {
      if (destroyed || !draft || draftIsReadOnly()) return;
      try {
        syncDraftFromEditor();
      } catch (_) {}
    }

    function isDirty() {
      if (!draft || draftIsReadOnly()) return false;
      return !draftBaselinePersisted || draftRevision !== draftBaselineRevision;
    }

    function reconcileDraft() {
      if (!draft || isDirty() || saveInFlight || Object.keys(targetInFlight).length) return;
      var id = String(draft.id || '');
      if (!id) return;
      var fresh = findFlowGroup(id);
      if (!fresh) {
        replaceDraft(null);
        return;
      }
      if (JSON.stringify(fresh) !== JSON.stringify(draft)) replaceDraft(fresh);
    }

    function markExternalDelete(flowGroupId) {
      flowGroupId = String(flowGroupId || '');
      if (!flowGroupId || !draft || String(draft.id || '') !== flowGroupId) return false;
      externallyDeletedDraftId = flowGroupId;
      return true;
    }

    function listedFlows(flows) {
      var listed = cloneData(listableFlows());
      if (!Array.isArray(listed)) listed = [];
      return listed.filter(function (flow) {
        return !!(flow && typeof flow === 'object' && !Array.isArray(flow) && isSafeKey(String(flow.id || '')));
      }).map(function (flow) {
        var configured = safeMapValue(flows, normalizeFlowReference(String(flow.id || '')));
        return configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : flow;
      });
    }

    function render() {
      if (destroyed) return { ok: false, destroyed: true };
      if (draft && renderedDraftGeneration === draftGeneration && !draftIsReadOnly()) {
        try {
          syncDraftFromEditor();
        } catch (_) {}
      }
      var list = $('#flowGroups-list');
      if (!list) return { ok: false, error: '流程组列表不存在' };
      var groups;
      var flows;
      try {
        reconcileDraft();
        groups = configMap('flowGroups');
        flows = configMap('flows');
      } catch (error) {
        return { ok: false, error: errorText(error, '流程组配置无效') };
      }
      var flowGroups = sortedValues(groups);
      list.innerHTML = renderConfigListItems('flowGroups', flowGroups, '<div class="placeholder">还没有流程组，点击「新建流程组」选择已有流程编排</div>', function (group) {
        var steps = Array.isArray(group.steps) ? group.steps : [];
        var usageSummary = flowUsageSummary(group);
        var builtin = isBuiltinItem(group);
        return '<div class="item-card' + (draft && draft.id === group.id ? ' selected' : '') + (builtin ? ' builtin' : '') + '" data-action="edit-flowGroup" data-id="' + esc(group.id) + '">'
          + '<span class="item-title">' + esc(group.label || '(未命名)') + '</span>'
          + '<span class="item-sub">' + steps.length + ' 个流程' + (usageSummary ? ' · ' + esc(usageSummary) : '') + (group.description ? ' · ' + esc(group.description) : '') + '</span>'
          + (builtin ? '<span class="badge builtin">内置</span>' : '')
          + '<button class="btn-small" data-action="run-flowGroup" data-id="' + esc(group.id) + '">运行流程组</button>'
          + (builtin
            ? '<button class="btn-small" disabled title="内置流程组不支持导出，请先复制为用户流程组">导出</button>'
            : '<button class="btn-small" data-action="export-flowGroup" data-id="' + esc(group.id) + '">导出</button>')
          + (builtin
            ? '<button class="btn-small" disabled title="内置流程组不能直接修改，请先复制">修改</button>'
              + '<button class="btn-small btn-danger-outline" disabled title="内置流程组不能删除">删除</button>'
              + '<button class="btn-small" data-action="copy-flowGroup" data-id="' + esc(group.id) + '">复制</button>'
            : '')
          + itemIdHtml(group.id)
          + '</div>';
      });
      return renderEditor(groups, flows);
    }

    function flowGroupFlowOptions(selectedFlowId, flows) {
      var selectedRaw = typeof selectedFlowId === 'string' ? selectedFlowId : '';
      var selectedResolved = normalizeFlowReference(selectedRaw);
      var items = listedFlows(flows);
      var selectedFlow = selectedResolved && safeMapValue(flows, selectedResolved);
      if (selectedFlow && !items.some(function (flow) {
        return normalizeFlowReference(String(flow.id || '')) === selectedResolved;
      })) items.push(selectedFlow);
      var selectedWritten = false;
      var html = '<option value="">— 选择流程 —</option>' + items.map(function (flow) {
        var flowId = String(flow.id || '');
        var matches = !selectedWritten && selectedRaw
          && (selectedRaw === flowId || selectedResolved === normalizeFlowReference(flowId));
        if (matches) selectedWritten = true;
        var optionValue = matches ? selectedRaw : flowId;
        return '<option value="' + esc(optionValue) + '"' + (matches ? ' selected' : '') + '>'
          + esc(flow.label || flow.id) + (isBuiltinItem(flow) ? '（内置）' : '') + '</option>';
      }).join('');
      if (selectedRaw && !selectedWritten) {
        html += '<option value="' + esc(selectedRaw) + '" selected>'
          + esc('流程不存在（' + selectedRaw + '）') + '</option>';
      }
      return html;
    }

    function flowGroupStepCardHtml(step, index, flows) {
      var displayStep = step && typeof step === 'object' && !Array.isArray(step) ? step : {};
      var flowId = typeof displayStep.flowId === 'string' ? displayStep.flowId : '';
      var flow = flowForReference(flowId, flows);
      var label = flow
        ? (displayStep.label || flow.label || flow.name || flowId)
        : (flowId ? '流程不存在（' + flowId + '）' : '未选择流程');
      var flags = '';
      var readonly = draftIsReadOnly();
      if (displayStep.continueOnFailure) flags += '<span class="badge">失败继续</span>';
      if (displayStep.runTabMode) {
        var modeLabel = displayStep.runTabMode;
        runTabModeOptions.forEach(function (option) {
          if (option.value === normalizeRunTabMode(displayStep.runTabMode)) modeLabel = option.label;
        });
        flags += '<span class="badge">' + esc(modeLabel) + '</span>';
      }
      return '<div class="node-card flowGroup-step-card' + (readonly ? ' readonly' : '') + '" draggable="' + (readonly ? 'false' : 'true') + '" data-step-index="' + index + '">'
        + '<div class="node-card-header">'
        + (readonly ? '' : '<span class="drag-handle">⋮⋮</span>')
        + '<span class="node-order">' + (index + 1) + '.</span>'
        + '<span class="node-type-label">[流程]</span>'
        + '<span class="node-title">' + esc(label) + '</span>'
        + flags
        + (readonly
          ? '<button class="btn-icon btn-edit" data-action="view-flowGroup-step" data-index="' + index + '">查看</button>'
            + '<button class="btn-icon" disabled title="内置流程组步骤不能修改">编辑</button>'
            + '<button class="btn-icon" disabled title="内置流程组步骤不能删除">删除</button>'
          : '<button class="btn-icon btn-edit" data-action="edit-flowGroup-step" data-index="' + index + '">编辑</button>'
            + '<button class="btn-icon" data-action="delete-flowGroup-step" data-index="' + index + '">删除</button>')
        + '</div>'
        + '</div>';
    }

    function renderEditor(groups, flows) {
      if (destroyed) return { ok: false, destroyed: true };
      var editor = editorRoot();
      if (!editor) return { ok: false, error: '流程组编辑器不存在' };
      if (!draft) {
        renderedDraftGeneration = -1;
        draftFormSignature = '';
        editor.classList.add('hidden');
        editor.innerHTML = '';
        return { ok: true, draftOpen: false };
      }
      try {
        groups = groups || configMap('flowGroups');
        flows = flows || configMap('flows');
      } catch (error) {
        return { ok: false, error: errorText(error, '流程组配置无效') };
      }
      var group = draft;
      var persisted = !!(group.id && safeMapValue(groups, String(group.id)));
      var readonly = draftIsReadOnly();
      var steps = Array.isArray(group.steps) ? group.steps : [];
      var stepRows = steps.length
        ? steps.map(function (step, index) { return flowGroupStepCardHtml(step, index, flows); }).join('')
        : '<div class="placeholder">还没有流程步骤，点击「添加流程」</div>';

      editor.classList.remove('hidden');
      editor.innerHTML =
        '<h3>' + (readonly ? '查看内置流程组' : (persisted ? '编辑流程组' : '新建流程组')) + (readonly ? ' <span class="badge builtin">内置</span>' : '') + '</h3>'
        + (readonly ? '<div class="readonly-banner">内置流程组来自扩展包，只能运行或复制为用户流程组后编辑。</div>' : '')
        + '<div class="flow-editor-header">'
        + '<div class="form-row"><label>流程组名称</label><input type="text" id="flowGroup-label" value="' + esc(group.label || '') + '" placeholder="如：登录后创建订单并校验"' + (readonly ? ' disabled' : '') + '></div>'
        + (readonly ? '' : '<button class="btn-primary" data-action="open-add-flowGroup-step-drawer">添加流程</button>')
        + '</div>'
        + '<div class="form-row"><label>使用说明</label><textarea id="flowGroup-description" rows="3" placeholder="流程组目标、输入约定或业务场景"' + (readonly ? ' disabled' : '') + '>' + esc(group.description || '') + '</textarea></div>'
        + '<div class="form-grid io-editor-grid">'
        + '<div class="form-row"><label>入参说明</label>'
        + '<textarea id="flowGroup-input-description" rows="4" placeholder="写给使用者看的流程组入参说明，不生成入参表单，不做校验。"' + (readonly ? ' disabled' : '') + '>' + esc(group.inputDescription || '') + '</textarea></div>'
        + '<div class="form-row"><label>出参说明</label>'
        + '<textarea id="flowGroup-output-description" rows="4" placeholder="写给使用者看的流程组出参说明，不配置出参路径。"' + (readonly ? ' disabled' : '') + '>' + esc(group.outputDescription || '') + '</textarea></div>'
        + '</div>'
        + '<div class="form-row form-row-spaced"><label>运行入参示例（可选 JSON）</label>'
        + '<textarea id="flowGroup-input-example" rows="4" placeholder=\'{"keyword":"订单"}\'' + (readonly ? ' disabled' : '') + '>' + esc(group.inputExample || '') + '</textarea>'
        + '<div class="form-help">仅作为运行界面的预填示例。运行入参仍是可选 JSON，不会生成字段表单或强制校验。</div></div>'
        + renderFlowUsageSummary(group, '填写后，运行界面会展示流程组说明和输入示例。')
        + '<div class="node-list flowGroup-step-list" id="flowGroup-step-list-container">' + stepRows + '</div>'
        + '<div class="editor-actions">'
        + (readonly
          ? '<button class="btn-primary" disabled title="内置流程组不能直接修改，请先复制">保存流程组</button>'
            + '<button class="btn-primary" data-action="run-flowGroup" data-id="' + esc(group.id) + '">运行流程组</button>'
            + '<button class="btn-secondary" disabled title="内置流程组不支持导出，请先复制为用户流程组">导出</button>'
            + '<button class="btn-secondary" data-action="copy-flowGroup" data-id="' + esc(group.id) + '">复制为用户流程组</button>'
            + '<button class="btn-secondary" data-action="cancel-flowGroup">关闭</button>'
          : '<button class="btn-primary" data-action="save-flowGroup">保存流程组</button>'
            + (persisted ? '<button class="btn-secondary" data-action="run-flowGroup" data-id="' + esc(group.id) + '">运行流程组</button>' : '')
            + '<button class="btn-secondary" data-action="cancel-flowGroup">取消</button>')
        + '<span class="spacer"></span>'
        + (readonly
          ? '<button class="btn-danger" disabled title="内置流程组不能删除">删除</button>'
          : (persisted ? '<button class="btn-danger" data-action="delete-flowGroup" data-id="' + esc(group.id) + '">删除</button>' : ''))
        + '</div>';
      renderedDraftGeneration = draftGeneration;
      try {
        draftFormSignature = editorDataSignature(readEditorData());
      } catch (_) {
        draftFormSignature = '';
      }
      return { ok: true, draftOpen: true };
    }

    function nextFlowGroupId() {
      var groups = configMap('flowGroups');
      var reserved = Object.create(null);
      Object.keys(groups).forEach(function (id) { if (isSafeKey(id)) reserved[id] = true; });
      var id = String(generateFlowGroupId(reserved) || '');
      if (!isSafeKey(id) || safeMapValue(groups, id)) throw new Error('无法生成流程组 ID');
      return id;
    }

    function stepIds(steps) {
      var reserved = Object.create(null);
      (Array.isArray(steps) ? steps : []).forEach(function (step) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) return;
        var stepId = ownDataValue(step, 'stepId');
        if (typeof stepId === 'string' && isSafeKey(stepId)) reserved[stepId] = true;
      });
      return reserved;
    }

    function nextStepId(reserved) {
      reserved = reserved || Object.create(null);
      for (var attempt = 0; attempt < 100; attempt++) {
        var generatorReserved = Object.assign(Object.create(null), reserved);
        var id = String(generateStepId(generatorReserved) || '');
        if (isSafeKey(id) && !reserved[id]) {
          reserved[id] = true;
          return id;
        }
      }
      throw new Error('无法生成流程组步骤 ID');
    }

    function replaceDraft(nextDraft) {
      draft = nextDraft;
      externallyDeletedDraftId = '';
      draftRevision++;
      draftBaselineRevision = draftRevision;
      try {
        draftBaselinePersisted = !!(nextDraft && nextDraft.id && findFlowGroup(String(nextDraft.id)));
      } catch (_) {
        draftBaselinePersisted = false;
      }
      draftGeneration++;
      renderedDraftGeneration = -1;
      draftFormSignature = '';
      activeStepEdit = null;
      dragState.index = -1;
      dragState.destinationIndex = -1;
      dragState.draftRevision = -1;
      dragState.metrics = null;
    }

    function openNew() {
      if (destroyed) return { ok: false, destroyed: true };
      var id;
      try {
        id = nextFlowGroupId();
      } catch (error) {
        var message = '无法新建流程组: ' + errorText(error, 'ID 生成失败');
        toast(message, true);
        return { ok: false, error: message };
      }
      replaceDraft({ id: id, label: '', description: '', steps: [] });
      if (isActive()) {
        render();
        scrollOpenedEditor('#flowGroup-editor');
      }
      return { ok: true, flowGroupId: id };
    }

    function edit(flowGroupId, editOptions) {
      editOptions = editOptions || {};
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (editOptions.expectedRevision !== undefined && editOptions.expectedRevision !== draftRevision) {
        return Promise.resolve({ ok: false, stale: true });
      }
      return resourceClient.get(groupUri(flowGroupId)).then(function (envelope) {
        if (destroyed) return { ok: false, destroyed: true };
        var nextDraft = applyEnvelope(envelope);
        if (!nextDraft) throw new Error('流程组资源没有返回内容');
        replaceDraft(nextDraft);
        if (editOptions.render !== false && isActive()) {
          render();
          scrollOpenedEditor('#flowGroup-editor');
        }
        return { ok: true, flowGroup: cloneData(nextDraft) };
      }).catch(function (error) {
        var message = '无法打开流程组: ' + errorText(error, '资源读取失败');
        toast(message, true);
        return { ok: false, error: message };
      });
    }

    function clearDraft(clearOptions) {
      clearOptions = clearOptions || {};
      replaceDraft(null);
      if (clearOptions.render !== false && !destroyed && isActive()) render();
      notifyWhenIdle();
      return { ok: !destroyed, destroyed: destroyed };
    }

    function openAddStepDrawer() {
      if (destroyed) return { ok: false, destroyed: true };
      if (!ensureDraftEditable()) return { ok: false, readonly: draftIsReadOnly() };
      try {
        syncDraftFromEditor();
        var flows = configMap('flows');
        var items = listedFlows(flows);
        var html = '<div class="form-row"><input type="text" id="flowGroup-flow-search" placeholder="搜索流程" autocomplete="off"></div>';
        if (!items.length) {
          html += '<div class="placeholder">还没有可添加的流程，请先创建流程</div>';
        } else {
          html += '<div class="node-type-group"><div class="node-type-group-title">流程</div><div class="node-type-grid">'
            + items.map(function (flow) {
              var label = flow.label || flow.name || flow.id;
              var searchText = (label + ' ' + flow.id + ' ' + (flow.description || '')).toLowerCase();
              var desc = (Array.isArray(flow.nodes) ? flow.nodes : []).length + ' 个节点' + (flow.description ? ' · ' + flow.description : '');
              return '<div class="node-type-option" data-action="select-flowGroup-flow" data-flow-id="' + esc(flow.id) + '" data-search="' + esc(searchText) + '" data-desc="' + esc(desc) + '">'
                + '<span class="type-label">' + esc(label) + '</span>'
                + '</div>';
            }).join('')
            + '</div></div>';
        }
        $('#drawer-title').textContent = '选择流程';
        $('#drawer-content').innerHTML = html;
        $('#drawer-actions').innerHTML = '<button class="btn-secondary" data-action="cancel-drawer">取消</button>';
        activeStepEdit = null;
        openDrawer();
        var search = $('#flowGroup-flow-search');
        if (search) search.focus();
        return { ok: true };
      } catch (error) {
        var message = '无法打开流程选择器: ' + errorText(error, '配置数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
    }

    function addStep(flowId) {
      if (destroyed) return { ok: false, destroyed: true };
      if (!ensureDraftEditable()) return { ok: false, readonly: draftIsReadOnly() };
      try {
        syncDraftFromEditor();
        var flows = configMap('flows');
        var flow = flowForReference(flowId, flows);
        if (!flow) throw new Error('所选流程不存在');
        if (!Array.isArray(draft.steps)) draft.steps = [];
        var reserved = stepIds(draft.steps);
        draft.steps.push({
          stepId: nextStepId(reserved),
          flowId: flowId || '',
          label: flow.label || flow.name || '',
          continueOnFailure: false,
        });
        draftRevision++;
        var index = draft.steps.length - 1;
        closeDrawer();
        renderEditor();
        openStepEditor(index);
        return { ok: true, index: index };
      } catch (error) {
        var message = '无法添加流程步骤: ' + errorText(error, '配置数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
    }

    function moveStepTo(fromIndex, toIndex) {
      if (destroyed) return { ok: false, destroyed: true };
      if (!ensureDraftEditable()) return { ok: false, readonly: draftIsReadOnly() };
      try {
        syncDraftFromEditor();
      } catch (_) {}
      var steps = Array.isArray(draft.steps) ? draft.steps : [];
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0
          || fromIndex >= steps.length || toIndex >= steps.length) return { ok: false, invalidIndex: true };
      var step = steps.splice(fromIndex, 1)[0];
      steps.splice(toIndex, 0, step);
      draftRevision++;
      activeStepEdit = null;
      renderEditor();
      return { ok: true };
    }

    function openStepEditor(index) {
      if (destroyed) return { ok: false, destroyed: true };
      try {
        syncDraftFromEditor();
        var step = draft && Array.isArray(draft.steps) && draft.steps[index];
        if (!step || typeof step !== 'object' || Array.isArray(step)) return { ok: false, error: '流程步骤不存在' };
        var flows = configMap('flows');
        var flow = flowForReference(step.flowId, flows) || {};
        var readonly = draftIsReadOnly();
        $('#drawer-title').textContent = readonly ? '查看流程步骤' : '编辑流程步骤';
        $('#drawer-content').innerHTML =
          '<div class="form-row"><label>流程</label><select id="flowGroup-step-flowId"' + (readonly ? ' disabled' : '') + '>' + flowGroupFlowOptions(step.flowId, flows) + '</select></div>'
          + '<div class="form-row"><label>步骤名称</label><input type="text" id="flowGroup-step-label" value="' + esc(step.label || '') + '" placeholder="' + esc(flow.label || flow.name || '') + '"' + (readonly ? ' disabled' : '') + '></div>'
          + '<div class="form-row"><label>运行标签策略</label>' + runTabModeSelectHtml('flowGroup-step-runTabMode', step.runTabMode || '', readonly, true)
          + '<div class="form-help">仅覆盖当前步骤；不选则使用所选流程自己的运行标签策略。</div></div>'
          + '<div class="io-note drawer-io-note">'
          + '<b>输入 / 输出</b>'
          + '<span>该步骤运行时会自动接收上一步输出；第一步接收流程组运行入参。执行完成后，输出会交给下一步。</span>'
          + '</div>'
          + '<div class="form-row checkbox-row"><input type="checkbox" id="flowGroup-step-continueOnFailure"' + (step.continueOnFailure ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="flowGroup-step-continueOnFailure">该流程失败时继续执行下一步</label></div>';
        $('#drawer-actions').innerHTML = readonly
          ? '<button class="btn-secondary" data-action="cancel-node-edit">关闭</button>'
          : '<button class="btn-primary" data-action="save-flowGroup-step-edit" data-index="' + index + '">保存</button>'
            + '<button class="btn-secondary" data-action="cancel-node-edit">取消</button>';
        activeStepEdit = { generation: draftGeneration, index: index, step: step };
        openDrawer();
        return { ok: true };
      } catch (error) {
        var message = '无法打开流程步骤: ' + errorText(error, '配置数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
    }

    function drawerElement(id) {
      var content = $('#drawer-content');
      var element = content && content.querySelector('#' + id);
      if (!element) throw new Error('流程步骤编辑器缺少字段: ' + id);
      return element;
    }

    function saveStepEdit(index) {
      if (destroyed) return { ok: false, destroyed: true };
      if (!ensureDraftEditable()) return { ok: false, readonly: draftIsReadOnly() };
      var step = draft && Array.isArray(draft.steps) && draft.steps[index];
      if (!step || typeof step !== 'object' || Array.isArray(step)) return { ok: false, error: '流程步骤不存在' };
      if (activeStepEdit && (activeStepEdit.generation !== draftGeneration
          || activeStepEdit.index !== index || activeStepEdit.step !== step)) {
        return { ok: false, stale: true, error: '流程步骤已变化，请重新打开' };
      }
      try {
        var flowId = drawerElement('flowGroup-step-flowId').value;
        if (!flowId) {
          toast('请选择流程', true);
          return { ok: false, error: '请选择流程' };
        }
        var flows = configMap('flows');
        var flow = flowForReference(flowId, flows);
        if (!flow) {
          toast('所选流程不存在', true);
          return { ok: false, error: '所选流程不存在' };
        }
        step.flowId = flowId;
        step.label = drawerElement('flowGroup-step-label').value.trim() || flow.label || flow.name || '';
        step.continueOnFailure = !!drawerElement('flowGroup-step-continueOnFailure').checked;
        var runTabMode = drawerElement('flowGroup-step-runTabMode').value;
        if (runTabMode) step.runTabMode = normalizeRunTabMode(runTabMode);
        else delete step.runTabMode;
        delete step.inputJson;
        delete step.input;
        delete step.outputVar;
        draftRevision++;
        activeStepEdit = null;
        closeDrawer();
        renderEditor();
        return { ok: true };
      } catch (error) {
        var message = '无法保存流程步骤: ' + errorText(error, '字段不可用');
        toast(message, true);
        return { ok: false, error: message };
      }
    }

    function deleteStep(index) {
      if (destroyed) return { ok: false, destroyed: true };
      if (!ensureDraftEditable()) return { ok: false, readonly: draftIsReadOnly() };
      try {
        syncDraftFromEditor();
      } catch (_) {}
      if (!Array.isArray(draft.steps) || index < 0 || index >= draft.steps.length) {
        return { ok: false, invalidIndex: true };
      }
      draft.steps.splice(index, 1);
      draftRevision++;
      activeStepEdit = null;
      renderEditor();
      return { ok: true };
    }

    function validationFailure(message, extra) {
      if (!destroyed) toast(message, true);
      return Promise.resolve(Object.assign({ ok: false, error: message }, extra || {}));
    }

    function targetBusy(flowGroupId, requestedKind) {
      var current = isSafeKey(flowGroupId) ? targetInFlight[flowGroupId] : null;
      if (!current) return null;
      return {
        ok: false,
        busy: true,
        operation: current.kind,
        requestedOperation: requestedKind,
        promise: current.promise,
      };
    }

    function busyFailure(busy, revision) {
      var labels = { save: '保存', delete: '删除' };
      var message = '流程组正在' + (labels[busy.operation] || '更新')
        + '，请稍后再' + (labels[busy.requestedOperation] || '操作');
      var stale = destroyed || revision !== draftRevision;
      if (!stale) toast(message, true);
      return Promise.resolve({
        ok: false,
        busy: true,
        stale: stale,
        destroyed: destroyed,
        operation: busy.operation,
        requestedOperation: busy.requestedOperation,
        error: message,
      });
    }

    function trackTarget(flowGroupId, kind, operation) {
      if (!isSafeKey(flowGroupId)) return;
      targetInFlight[flowGroupId] = { kind: kind, promise: operation };
      operation.then(function () {
        if (targetInFlight[flowGroupId] && targetInFlight[flowGroupId].promise === operation) {
          delete targetInFlight[flowGroupId];
        }
        notifyWhenIdle();
      }, function () {
        if (targetInFlight[flowGroupId] && targetInFlight[flowGroupId].promise === operation) {
          delete targetInFlight[flowGroupId];
        }
        notifyWhenIdle();
      });
    }

    function prepareSaveItem() {
      syncDraftFromEditor();
      var item = cloneData(draft);
      item.label = String(item.label || '').trim();
      item.description = String(item.description || '').trim();
      item.inputDescription = String(item.inputDescription || '').trim();
      item.outputDescription = String(item.outputDescription || '').trim();
      item.inputExample = String(item.inputExample || '').trim();
      delete item.inputs;
      delete item.outputs;
      if (!item.label) throw new Error('流程组名称不能为空');
      var generatedGroupId = false;
      var generatedStepIds = [];
      if (!item.id) {
        item.id = nextFlowGroupId();
        generatedGroupId = true;
      }
      if (typeof item.id !== 'string' || !isSafeKey(item.id)) throw new Error('流程组 ID 无效');
      if (!Array.isArray(item.steps) || !item.steps.length) throw new Error('流程组至少需要一个流程');
      var flows = configMap('flows');
      var reserved = Object.create(null);
      var seen = Object.create(null);
      for (var stepIndex = 0; stepIndex < item.steps.length; stepIndex++) {
        var existingStep = item.steps[stepIndex];
        if (!existingStep || typeof existingStep !== 'object' || Array.isArray(existingStep)) {
          throw new Error('第 ' + (stepIndex + 1) + ' 步配置无效');
        }
        var existingStepId = ownDataValue(existingStep, 'stepId');
        if (existingStepId === undefined || existingStepId === null || existingStepId === '') continue;
        if (typeof existingStepId !== 'string' || !isSafeKey(existingStepId) || existingStepId.trim() !== existingStepId) {
          throw new Error('第 ' + (stepIndex + 1) + ' 步的 stepId 无效');
        }
        if (seen[existingStepId]) {
          throw new Error('第 ' + (stepIndex + 1) + ' 步的 stepId 重复: ' + existingStepId);
        }
        seen[existingStepId] = true;
        reserved[existingStepId] = true;
      }
      for (var index = 0; index < item.steps.length; index++) {
        var step = item.steps[index];
        delete step.inputJson;
        delete step.input;
        delete step.outputVar;
        var rawFlowId = ownDataValue(step, 'flowId');
        var flowId = normalizeFlowReference(rawFlowId);
        if (!flowId || !isSafeKey(flowId)) throw new Error('第 ' + (index + 1) + ' 步未选择流程');
        if (rawFlowId === 'flowGroup:' + item.id) {
          throw new Error('第 ' + (index + 1) + ' 步不能引用当前流程组');
        }
        var flow = safeMapValue(flows, flowId);
        if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
          throw new Error('第 ' + (index + 1) + ' 步引用的流程不存在');
        }
        var stepId = ownDataValue(step, 'stepId');
        if (stepId === undefined || stepId === null || stepId === '') {
          stepId = nextStepId(reserved);
          step.stepId = stepId;
          generatedStepIds.push({ index: index, stepId: stepId });
        }
      }
      if (generatedGroupId) draft.id = item.id;
      generatedStepIds.forEach(function (entry) {
        if (draft.steps[entry.index] && typeof draft.steps[entry.index] === 'object'
            && !Array.isArray(draft.steps[entry.index])) {
          draft.steps[entry.index].stepId = entry.stepId;
        }
      });
      if (generatedGroupId || generatedStepIds.length) draftRevision++;
      return item;
    }

    function save() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (!draft) return validationFailure('没有可保存的流程组');
      if (externallyDeletedDraftId && String(draft.id || '') === externallyDeletedDraftId) {
        return validationFailure('该流程组已在其他窗口删除，请取消当前编辑后重新创建');
      }
      if (draftIsReadOnly()) return validationFailure('内置流程组不能直接修改，请先复制为用户流程组');
      if (saveInFlight && saveRevision === draftRevision) return saveInFlight;
      var item;
      try {
        item = prepareSaveItem();
      } catch (error) {
        return validationFailure(errorText(error, '流程组数据无效'));
      }
      var flowGroupId = String(item.id || '');
      var existingResource = !!findFlowGroup(flowGroupId);
      var busy = targetBusy(flowGroupId, 'save');
      if (busy) return busyFailure(busy, draftRevision);
      var revision = draftRevision;
      var generation = draftGeneration;
      var committed = false;
      var completionStale = false;
      var skippedResult = null;

      function stillCurrent() {
        return !destroyed && !!draft && revision === draftRevision && generation === draftGeneration;
      }

      var operation = Promise.resolve().then(function () {
        if (!stillCurrent()) {
          skippedResult = { ok: false, stale: true, destroyed: destroyed };
          return null;
        }
        if (!existingResource) {
          return resourceClient.authorizedPost('/flow-groups', item, resourceOptions({
            criteria: { relation: 'flow-groups' },
          }));
        }
        return resourceClient.get(groupUri(flowGroupId)).then(function (envelope) {
          applyEnvelope(envelope);
          var patch = cloneData(item);
          delete patch.id;
          delete patch.createdAt;
          delete patch.updatedAt;
          return resourceClient.authorizedPatch(groupUri(flowGroupId), patch, resourceOptions({
            ifMatch: 'cached',
            criteria: { relation: 'flow-group' },
          }));
        });
      }).then(function (envelope) {
        if (skippedResult) return skippedResult;
        if (!applyEnvelope(envelope)) return { ok: false, error: '流程组保存失败' };
        committed = true;
        return refreshFlowResources().catch(function () {}).then(function () { return envelope; });
      }).then(function () {
        if (skippedResult) return skippedResult;
        if (destroyed) return { ok: true, committed: true, destroyed: true, rendered: false };
        completionStale = !stillCurrent();
        if (!completionStale) replaceDraft(null);
        resetConfigListPage('flowGroups');
        toast('流程组已保存');
        if (isActive()) {
          var rendered = render();
          if (!rendered || rendered.ok === false) throw new Error(rendered && rendered.error || '流程组界面刷新失败');
        }
        return { ok: true, committed: true, stale: completionStale };
      }).catch(function (error) {
        if (destroyed) return { ok: committed, committed: committed, destroyed: true };
        var stale = committed ? completionStale : (revision !== draftRevision || generation !== draftGeneration);
        if (committed) {
          var warning = '流程组已保存，但刷新失败: ' + errorText(error, '未知错误');
          toast(warning, true);
          return { ok: true, committed: true, stale: stale, warning: warning };
        }
        var message = '流程组保存失败: ' + errorText(error, '未知错误');
        if (!stale) toast(message, true);
        return { ok: false, stale: stale, error: message };
      });
      saveInFlight = operation;
      saveRevision = revision;
      trackTarget(flowGroupId, 'save', operation);
      operation.then(function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
        }
        notifyWhenIdle();
      }, function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
        }
        notifyWhenIdle();
      });
      return operation;
    }

    function remove(flowGroupId) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      flowGroupId = String(flowGroupId || '');
      if (!isSafeKey(flowGroupId)) return Promise.resolve({ ok: false, error: '流程组不存在' });
      var busy = targetBusy(flowGroupId, 'delete');
      if (busy) {
        if (busy.operation === 'delete') return busy.promise;
        return busyFailure(busy, draftRevision);
      }
      var group;
      try {
        group = findFlowGroup(flowGroupId);
      } catch (error) {
        return validationFailure('无法检查流程组: ' + errorText(error, '流程组数据无效'));
      }
      if (!group) return Promise.resolve({ ok: false, error: '流程组不存在' });
      if (isBuiltinItem(group)) {
        return validationFailure('内置流程组不能删除', { builtin: true });
      }
      if (!confirmAction('确定删除该流程组？（不影响其中的流程）')) {
        return Promise.resolve({ ok: false, canceled: true });
      }

      var revision = draftRevision;
      var generation = draftGeneration;
      var committed = false;
      var completionStale = false;
      var operation = Promise.resolve().then(function () {
        return resourceClient.get(groupUri(flowGroupId));
      }).then(function (envelope) {
        applyEnvelope(envelope);
        return resourceClient.authorizedDelete(groupUri(flowGroupId), resourceOptions({
          ifMatch: 'cached',
          criteria: { relation: 'flow-group' },
        }));
      }).then(function () {
        committed = true;
        removeFlowGroupFromState(flowGroupId);
        return refreshFlowResources().catch(function () {});
      }).then(function () {
        if (destroyed) return { ok: true, committed: true, destroyed: true, rendered: false };
        completionStale = revision !== draftRevision || generation !== draftGeneration;
        if (!completionStale && draft && String(draft.id || '') === flowGroupId) replaceDraft(null);
        resetConfigListPage('flowGroups');
        toast('流程组已删除');
        if (isActive()) {
          var rendered = render();
          if (!rendered || rendered.ok === false) throw new Error(rendered && rendered.error || '流程组界面刷新失败');
        }
        return { ok: true, committed: true, stale: completionStale };
      }).catch(function (error) {
        if (destroyed) return { ok: committed, committed: committed, destroyed: true };
        var stale = committed ? completionStale : (revision !== draftRevision || generation !== draftGeneration);
        if (committed) {
          var warning = '流程组已删除，但刷新失败: ' + errorText(error, '未知错误');
          toast(warning, true);
          return { ok: true, committed: true, stale: stale, warning: warning };
        }
        var message = '流程组删除失败: ' + errorText(error, '未知错误');
        if (!stale) toast(message, true);
        return { ok: false, stale: stale, error: message };
      });
      trackTarget(flowGroupId, 'delete', operation);
      return operation;
    }

    function actionTarget(event, providedTarget) {
      if (providedTarget) return providedTarget;
      var target = event && event.target;
      return target && typeof target.closest === 'function' ? target.closest('[data-action]') : null;
    }

    function handleAction(action, flowGroupId, event, providedTarget) {
      var target = actionTarget(event, providedTarget);
      if (action === 'edit-flowGroup') {
        edit(flowGroupId);
        return true;
      }
      if (action === 'open-add-flowGroup-step-drawer') {
        openAddStepDrawer();
        return true;
      }
      if (action === 'select-flowGroup-flow') {
        addStep(target && target.dataset && target.dataset.flowId || '');
        return true;
      }
      if (action === 'edit-flowGroup-step' || action === 'view-flowGroup-step') {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        openStepEditor(Number(target && target.dataset && target.dataset.index));
        return true;
      }
      if (action === 'save-flowGroup-step-edit') {
        saveStepEdit(Number(target && target.dataset && target.dataset.index));
        return true;
      }
      if (action === 'delete-flowGroup-step') {
        deleteStep(Number(target && target.dataset && target.dataset.index));
        return true;
      }
      if (action === 'save-flowGroup') {
        save();
        return true;
      }
      if (action === 'cancel-flowGroup') {
        clearDraft();
        return true;
      }
      if (action === 'delete-flowGroup') {
        remove(flowGroupId);
        return true;
      }
      return false;
    }

    function handleDrawerSearch(event) {
      if (destroyed || !event || !event.target || event.target.id !== 'flowGroup-flow-search') return;
      var keyword = String(event.target.value || '').trim().toLowerCase();
      var content = $('#drawer-content');
      if (!content) return;
      Array.prototype.slice.call(content.querySelectorAll('.node-type-option')).forEach(function (element) {
        element.style.display = (!keyword || String(element.dataset.search || '').indexOf(keyword) !== -1) ? '' : 'none';
      });
    }

    function stepCardFromEvent(event) {
      var target = event && event.target;
      var card = target && typeof target.closest === 'function' ? target.closest('.flowGroup-step-card') : null;
      var editor = editorRoot();
      return card && editor && editor.contains(card) ? card : null;
    }

    function stepListFromEvent(event) {
      var target = event && event.target;
      var list = target && typeof target.closest === 'function'
        ? target.closest('#flowGroup-step-list-container')
        : null;
      var editor = editorRoot();
      return list && editor && editor.contains(list) ? list : null;
    }

    function stepCards(list) {
      return list
        ? Array.prototype.slice.call(list.querySelectorAll('.flowGroup-step-card'))
        : [];
    }

    function measureDragLayout(list, cards) {
      if (!list || !cards.length || typeof list.getBoundingClientRect !== 'function') return null;
      var listRect = list.getBoundingClientRect();
      var gap = 6;
      try {
        var style = window.getComputedStyle && window.getComputedStyle(list);
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
      stepCards(list).forEach(function (card) {
        card.style.removeProperty('--drag-shift-y');
      });
    }

    function previewDragDestination(list, destinationIndex) {
      if (!list || !dragState.metrics || destinationIndex === dragState.destinationIndex) return;
      var cards = stepCards(list);
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

    function clearDragClasses() {
      var editor = editorRoot();
      if (!editor) return;
      Array.prototype.slice.call(editor.querySelectorAll('.node-list')).forEach(function (list) {
        list.classList.remove('drag-active');
        clearDragTransforms(list);
      });
      Array.prototype.slice.call(editor.querySelectorAll('.flowGroup-step-card')).forEach(function (card) {
        card.classList.remove('dragging');
      });
    }

    function handleDragStart(event) {
      if (destroyed || draftIsReadOnly()) return;
      var card = stepCardFromEvent(event);
      if (!card) return;
      var list = card.closest('#flowGroup-step-list-container');
      var cards = stepCards(list);
      dragState.index = Number(card.dataset.stepIndex);
      dragState.destinationIndex = dragState.index;
      dragState.draftRevision = draftRevision;
      dragState.metrics = measureDragLayout(list, cards);
      list.classList.add('drag-active');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', String(dragState.index)); } catch (_) {}
      }
      if (typeof window.requestAnimationFrame === 'function') {
        var startedIndex = dragState.index;
        window.requestAnimationFrame(function () {
          if (dragState.index === startedIndex) card.classList.add('dragging');
        });
      } else {
        card.classList.add('dragging');
      }
    }

    function handleDragEnd() {
      clearDragClasses();
      dragState.index = -1;
      dragState.destinationIndex = -1;
      dragState.draftRevision = -1;
      dragState.metrics = null;
    }

    function handleDragOver(event) {
      if (destroyed || dragState.index < 0) return;
      var list = stepListFromEvent(event);
      if (!list) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      previewDragDestination(list, destinationFromPointer(event, list));
    }

    function handleDragLeave() {}

    function handleDrop(event) {
      if (destroyed || dragState.index < 0) return;
      var list = stepListFromEvent(event);
      if (!list) return;
      event.preventDefault();
      var fromIndex = dragState.index;
      var targetIndex = destinationFromPointer(event, list);
      if (draftRevision !== dragState.draftRevision) {
        toast('流程组草稿已变化，请重新拖拽流程', true);
        handleDragEnd();
        return;
      }
      handleDragEnd();
      if (fromIndex !== targetIndex) moveStepTo(fromIndex, targetIndex);
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      var editor = editorRoot();
      lifecycle.listen($('#btn-new-flowGroup'), 'click', openNew);
      lifecycle.listen(editor, 'input', handleEditorChange);
      lifecycle.listen(editor, 'change', handleEditorChange);
      lifecycle.listen($('#drawer-content'), 'input', handleDrawerSearch);
      lifecycle.listen(editor, 'dragstart', handleDragStart);
      lifecycle.listen(editor, 'dragend', handleDragEnd);
      lifecycle.listen(editor, 'dragover', handleDragOver);
      lifecycle.listen(editor, 'dragleave', handleDragLeave);
      lifecycle.listen(editor, 'drop', handleDrop);
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      replaceDraft(null);
      lifecycle.destroy();
      return { ok: true, destroyed: true };
    }

    return {
      init: init,
      destroy: destroy,
      render: render,
      handleAction: handleAction,
      clearDraft: clearDraft,
      edit: edit,
      openById: edit,
      save: save,
      remove: remove,
      isDirty: isDirty,
      markExternalDelete: markExternalDelete,
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          saving: !!saveInFlight,
          mutating: Object.keys(targetInFlight).length > 0,
          dirty: isDirty(),
          draftId: draft && draft.id || '',
          revision: draftRevision,
        };
      },
    };
  }

  return { create: create };
});
