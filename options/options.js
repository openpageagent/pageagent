// options.js — 配置中心逻辑（页面/流程/脚本/定时任务/日志）
(function () {
  'use strict';

  if (!globalThis.OptionsFlowGroupController || typeof globalThis.OptionsFlowGroupController.create !== 'function') {
    throw new Error('OptionsFlowGroupController must load before options.js');
  }
  if (!globalThis.OptionsFlowController || typeof globalThis.OptionsFlowController.create !== 'function') {
    throw new Error('OptionsFlowController must load before options.js');
  }
  if (!globalThis.OptionsFlowNodeController
      || typeof globalThis.OptionsFlowNodeController.create !== 'function') {
    throw new Error('OptionsFlowNodeController must load before options.js');
  }
  if (!globalThis.OptionsUrlTriggerController
      || typeof globalThis.OptionsUrlTriggerController.create !== 'function') {
    throw new Error('OptionsUrlTriggerController must load before options.js');
  }
  if (!globalThis.PageAutomationLifecycle
      || typeof globalThis.PageAutomationLifecycle.create !== 'function') {
    throw new Error('PageAutomationLifecycle must load before options.js');
  }
  if (!globalThis.PageAutomationSystemSettings
      || typeof globalThis.PageAutomationSystemSettings.load !== 'function') {
    throw new Error('PageAutomationSystemSettings must load before options.js');
  }
  if (!globalThis.PageAutomationResourceClient
      || typeof globalThis.PageAutomationResourceClient.create !== 'function') {
    throw new Error('PageAutomationResourceClient must load before options.js');
  }

  var $ = function (sel) { return document.querySelector(sel); };
  var $all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // --- 状态 ---
  var config = { pages: {}, flows: {}, flowGroups: {}, scripts: {}, schedules: {}, urlTriggers: [] };
  var currentSection = 'apps';
  var navigationPending = false;
  var navigationReady = false;
  var drawerEditBaseline = '';
  var runtimeInputDialog = null;
  var settingsConfirmDialog = null;
  var pendingConversationTarget = (function () {
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (params.get('section') && params.get('section') !== 'conversation') return null;
      var assistantId = String(params.get('assistantId') || '').trim();
      var topicId = String(params.get('topicId') || '').trim();
      return assistantId || topicId ? { assistantId: assistantId, topicId: topicId } : null;
    } catch (_) {
      return null;
    }
  })();
  var pageController = null;
  var flowController = null;
  var flowNodeController = null;
  var pendingFlowConfigRefresh = false;
  var pendingSyncRefresh = false;
  var syncConfigRefreshTimer = 0;
  var systemSettings = globalThis.PageAutomationSystemSettings.normalize();
  var systemSettingsSaving = false;
  var hasAppFavorites = false;
  var systemProxyDirty = false;
  var systemProxyControls = {
    proxyServer: '#system-proxy-server',
    proxyUsername: '#system-proxy-username',
    proxyPassword: '#system-proxy-password',
    proxyHostPatterns: '#system-proxy-host-patterns',
    proxyBypassList: '#system-proxy-bypass-list',
  };
  var systemProxyStatusRequestId = 0;

  // 有未保存修改时确认丢弃；返回 false 表示用户取消操作
  function confirmDiscardConfigDraft(section) {
    var controller = currentConfigDomainController(section);
    return !controller || controller.confirmDiscard();
  }
  var scriptController = null;
  var urlTriggerController = null;
  var flowGroupController = null;
  var CONFIG_LIST_DEFAULT_PAGE_SIZE = 40;
  var CONFIG_LIST_PAGE_SIZE_OPTIONS = [20, 40, 80, 120];
  var configListPages = {};
  var scheduleController = null;
  var backupController = null;
  var appController = null;
  var lifecycle = globalThis.PageAutomationLifecycle.create(window);
  var syncEventStream = globalThis.PageAutomationSyncEventStream
    && globalThis.PageAutomationSyncEventStream.create
    ? globalThis.PageAutomationSyncEventStream.create({ runtime: chrome.runtime })
    : null;
  var resourceClient = globalThis.PageAutomationResourceClient.create();
  var tornDown = false;
  var RUN_TAB_MODE_OPTIONS = [
    { value: 'reuseOpenTab', label: '复用已打开标签' },
    { value: 'fixedCurrentTab', label: '固定当前标签' },
    { value: 'fixedNewTab', label: '固定打开标签' },
  ];

  // --- 工具 ---

  function esc(str) {
    if (str === undefined || str === null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cssEscape(str) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(String(str));
    return String(str).replace(/["\\]/g, '\\$&');
  }

  function openSettingsDialog(options) {
    var inputMode = Object.prototype.hasOwnProperty.call(options, 'defaultValue');
    var canceled = inputMode || options.secondaryText ? null : false;
    if (settingsConfirmDialog || tornDown) return Promise.resolve(canceled);
    return new Promise(function (resolve) {
      var dialog = document.createElement('dialog'), previous = document.activeElement, settled = false;
      dialog.className = 'conversation-confirm-dialog code-input-dialog';
      dialog.setAttribute('aria-labelledby', 'settings-confirm-title');
      dialog.setAttribute('aria-describedby', 'settings-confirm-message');
      dialog.innerHTML = '<form><header class="conversation-confirm-header"><h3 id="settings-confirm-title">' + esc(options.title || '确认操作') + '</h3></header>'
        + '<div class="conversation-confirm-body"><p id="settings-confirm-message" class="settings-dialog-message">' + esc(options.message) + '</p>'
        + (inputMode ? '<div class="setting-item"><input type="text" aria-label="' + esc(options.message) + '"></div>' : '') + '</div>'
        + '<footer class="conversation-confirm-actions"><button type="button" class="btn-secondary">' + esc(options.cancelText || '取消') + '</button>'
        + (options.secondaryText ? '<button type="button" class="btn-secondary" data-settings-secondary>' + esc(options.secondaryText) + '</button>' : '')
        + '<button type="submit" class="' + (inputMode ? 'btn-primary' : 'btn-danger') + '">' + esc(options.okText || '确认') + '</button></footer></form>';
      function finish(value) {
        if (settled) return;
        settled = true; settingsConfirmDialog = null; dialog.close(); dialog.remove();
        if (previous && previous.isConnected && !tornDown) previous.focus({ preventScroll: true });
        resolve(value);
      }
      settingsConfirmDialog = { cancel: function () { finish(canceled); } };
      dialog.querySelector('button[type="button"]').onclick = function () { finish(canceled); };
      if (options.secondaryText) dialog.querySelector('[data-settings-secondary]').onclick = function () { finish(false); };
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); finish(canceled); });
      dialog.querySelector('form').onsubmit = function (event) { event.preventDefault(); finish(inputMode ? dialog.querySelector('input').value : true); };
      if (inputMode) dialog.querySelector('input').value = options.defaultValue || '';
      document.body.append(dialog); dialog.showModal();
      var focusTarget = dialog.querySelector(inputMode ? 'input' : 'button[type="button"]');
      focusTarget.focus();
      if (inputMode) focusTarget.select();
    });
  }

  function confirmSettingsAction(message, title, okText, secondaryText) {
    if (message === '有未保存的修改，是否放弃？') {
      title = '未保存的修改';
      okText = '放弃修改';
    }
    return openSettingsDialog({ message: message, title: title, okText: okText, secondaryText: secondaryText,
      cancelText: message === '有未保存的修改，是否放弃？' ? '继续编辑' : '取消' });
  }

  function confirmUnsavedChanges() {
    return confirmSettingsAction('有未保存的修改，是否放弃？', '未保存的修改', '放弃修改');
  }

  function promptSettingsInput(message, defaultValue) {
    return openSettingsDialog({ message: message, title: '填写信息', okText: '确定', defaultValue: defaultValue || '' });
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function itemIdHtml(id) {
    if (!id) return '';
    return '<button type="button" class="item-id" data-action="copy-id" data-id="' + esc(id) + '" aria-label="复制 ID: ' + esc(id) + '" title="点击复制 ID: ' + esc(id) + '">ID: ' + esc(id) + '</button>';
  }

  function scrollOpenedEditor(selector) {
    (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); })(function () {
      var el = typeof selector === 'string' ? $(selector) : selector;
      if (!el || el.classList.contains('hidden')) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var focusEl = Array.from(el.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), page-code-editor:not([disabled]), select:not([disabled]), button:not([disabled])'))
        .find(function (control) { return !control.closest('details:not([open])') && control.getClientRects().length; });
      if (!focusEl) return;
      try {
        focusEl.focus({ preventScroll: true });
      } catch (_) {
        focusEl.focus();
      }
    });
  }

  function normalizeRunTabMode(value, fallback) {
    var mode = String(value || '').trim();
    if (mode === 'currentTab' || mode === 'fixedCurrent') mode = 'fixedCurrentTab';
    if (mode === 'newTab' || mode === 'exclusiveWindow' || mode === 'fixedRunTab') mode = 'fixedNewTab';
    if (mode === 'reuse' || mode === 'reuseTab') mode = 'reuseOpenTab';
    if (mode === 'fixedCurrentTab' || mode === 'reuseOpenTab' || mode === 'fixedNewTab') return mode;
    return fallback || 'reuseOpenTab';
  }

  function runTabModeSelectHtml(id, value, readonly, includeInherit) {
    var current = includeInherit && !value ? '' : normalizeRunTabMode(value);
    var html = '<select id="' + esc(id) + '"' + (readonly ? ' disabled' : '') + '>';
    if (includeInherit) html += '<option value=""' + (!current ? ' selected' : '') + '>跟随流程默认</option>';
    RUN_TAB_MODE_OPTIONS.forEach(function (opt) {
      html += '<option value="' + esc(opt.value) + '"' + (current === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
    });
    html += '</select>';
    return html;
  }

  function sendMessage(type, payload) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: type, payload: payload }, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: '无响应' });
      });
    });
  }

  function resourceData(envelope) {
    var primary = envelope && envelope.primary;
    return primary && primary.data && typeof primary.data === 'object' ? clonePlain(primary.data) : null;
  }

  function resourceErrorText(error, fallback) {
    var code = error && error.code ? '[' + error.code + '] ' : '';
    var message = error && error.message ? error.message : String(error || fallback || '资源请求失败');
    return code + message;
  }

  function resourceSegment(value) {
    return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function updateResourceMap(section, item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var id = String(item.id || item.flowId || item.flowGroupId || '');
    if (!id) return null;
    config[section] = config[section] && typeof config[section] === 'object' ? config[section] : {};
    config[section][id] = clonePlain(item);
    return config[section][id];
  }

  function applyFlowEnvelope(envelope) {
    return updateResourceMap('flows', resourceData(envelope));
  }

  function applyFlowGroupEnvelope(envelope) {
    return updateResourceMap('flowGroups', resourceData(envelope));
  }

  function removeResourceFromMap(section, id) {
    if (config[section] && typeof config[section] === 'object') delete config[section][String(id || '')];
  }

  function loadResourceCollection(uri) {
    var items = [];
    var seenCursors = Object.create(null);
    function read(cursor) {
      var query = { limit: 100 };
      if (cursor) query.cursor = cursor;
      return resourceClient.get(uri, { query: query }).then(function (envelope) {
        var data = resourceData(envelope) || {};
        if (Array.isArray(data.items)) items = items.concat(data.items.map(clonePlain));
        var nextCursor = String(data.nextCursor || '');
        if (!nextCursor || seenCursors[nextCursor]) return items;
        seenCursors[nextCursor] = true;
        return read(nextCursor);
      });
    }
    return read('');
  }

  function mapResources(items) {
    var output = {};
    (Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = String(item.id || '');
      if (id) output[id] = clonePlain(item);
    });
    return output;
  }

  function loadFlowResources() {
    return Promise.all([
      loadResourceCollection('/flows'),
      loadResourceCollection('/flow-groups'),
    ]).then(function (values) {
      config.flows = mapResources(values[0]);
      config.flowGroups = mapResources(values[1]);
      return { flows: values[0], flowGroups: values[1] };
    });
  }

  var CONFIG_RESOURCE_SPECS = Object.freeze({
    pages: Object.freeze({
      collectionUri: '/pages', collectionRelation: 'pages', itemRelation: 'page-source',
      stateKind: 'map', updateMethod: 'PATCH',
    }),
    scripts: Object.freeze({
      collectionUri: '/scripts', collectionRelation: 'scripts', itemRelation: 'script',
      stateKind: 'map', updateMethod: 'PUT',
    }),
    schedules: Object.freeze({
      collectionUri: '/schedules', collectionRelation: 'schedules', itemRelation: 'schedule',
      stateKind: 'map', updateMethod: 'PATCH',
    }),
    urlTriggers: Object.freeze({
      collectionUri: '/url-triggers', collectionRelation: 'url-triggers', itemRelation: 'url-trigger',
      stateKind: 'array', updateMethod: 'PUT',
    }),
  });

  function configResourceSpec(section) {
    return CONFIG_RESOURCE_SPECS[section] || null;
  }

  function resourceItemUri(spec, id) {
    return spec.collectionUri + '/' + resourceSegment(id);
  }

  function applyConfigResourceEnvelope(section, envelope) {
    var spec = configResourceSpec(section);
    var item = resourceData(envelope);
    if (!spec || !item || Array.isArray(item)) throw new Error('资源返回了无效的 ' + section + ' 数据');
    var id = String(item.id || '');
    if (!id) throw new Error('资源返回的 ' + section + ' 数据缺少 ID');
    if (spec.stateKind === 'array') {
      var list = Array.isArray(config[section]) ? config[section].slice() : [];
      var found = false;
      config[section] = list.map(function (entry) {
        if (!entry || String(entry.id || '') !== id) return entry;
        found = true;
        return clonePlain(item);
      });
      if (!found) config[section].push(clonePlain(item));
      return clonePlain(item);
    }
    return updateResourceMap(section, item);
  }

  function removeConfigResourceState(section, id) {
    var spec = configResourceSpec(section);
    id = String(id || '');
    if (!spec || !id) return;
    if (spec.stateKind === 'array') {
      config[section] = (Array.isArray(config[section]) ? config[section] : []).filter(function (entry) {
        return !entry || String(entry.id || '') !== id;
      });
      return;
    }
    removeResourceFromMap(section, id);
  }

  function loadConfigResourceSnapshot() {
    return Promise.all([
      loadResourceCollection('/pages'),
      loadResourceCollection('/flows'),
      loadResourceCollection('/flow-groups'),
      loadResourceCollection('/scripts'),
      loadResourceCollection('/schedules'),
      loadResourceCollection('/url-triggers'),
    ]).then(function (values) {
      return {
        version: 1,
        pages: mapResources(values[0]),
        flows: mapResources(values[1]),
        flowGroups: mapResources(values[2]),
        scripts: mapResources(values[3]),
        schedules: mapResources(values[4]),
        urlTriggers: values[5].map(clonePlain),
      };
    });
  }

  function upsertConfigResource(section, input) {
    var spec = configResourceSpec(section);
    if (!spec) return Promise.reject(new Error('配置分区没有资源合同: ' + section));
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return Promise.reject(new TypeError(section + ' 资源必须是对象'));
    }
    var item = PageAutomationConfigMigration.cleanItem(section, clonePlain(input));
    var id = String(item.id || '');
    function createResource() {
      return resourceClient.authorizedPost(spec.collectionUri, item, {
        criteria: { relation: spec.collectionRelation },
      }).then(function (envelope) {
        return applyConfigResourceEnvelope(section, envelope);
      });
    }
    if (!id) return createResource();
    var uri = resourceItemUri(spec, id);
    return resourceClient.get(uri).then(function () {
      var mutationOptions = {
        ifMatch: 'cached',
        criteria: { relation: spec.itemRelation },
      };
      if (spec.updateMethod === 'PUT') {
        return resourceClient.authorizedPut(uri, item, mutationOptions).then(function (envelope) {
          return applyConfigResourceEnvelope(section, envelope);
        });
      }
      var patch = clonePlain(item);
      delete patch.id;
      return resourceClient.authorizedPatch(uri, patch, mutationOptions).then(function (envelope) {
        return applyConfigResourceEnvelope(section, envelope);
      });
    }, function (error) {
      if (error && (error.code === 'RESOURCE_NOT_FOUND' || Number(error.status) === 404)) {
        return createResource();
      }
      throw error;
    });
  }

  function deleteConfigResource(section, id) {
    var spec = configResourceSpec(section);
    id = String(id || '');
    if (!spec) return Promise.reject(new Error('配置分区没有资源合同: ' + section));
    if (!id) return Promise.reject(new TypeError(section + ' 资源 ID 不能为空'));
    var uri = resourceItemUri(spec, id);
    return resourceClient.get(uri).then(function () {
      return resourceClient.authorizedDelete(uri, {
        ifMatch: 'cached',
        criteria: { relation: spec.itemRelation },
      });
    }).then(function (envelope) {
      removeConfigResourceState(section, id);
      return envelope;
    });
  }

  function waitForScriptRun(operationUri, retryAfterMs, timeoutMs) {
    var startedAt = Date.now();
    var activeStatuses = { idle: true, queued: true, starting: true, pending: true, running: true, paused: true, pausing: true };
    function read() {
      return resourceClient.get(operationUri).then(function (envelope) {
        var run = resourceData(envelope) || {};
        var status = String(run.status || '').toLowerCase();
        if (!activeStatuses[status]) {
          if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
            var error = new Error(String(run.error || ('脚本运行结束: ' + status)));
            error.run = run;
            throw error;
          }
          return run;
        }
        if (Date.now() - startedAt >= timeoutMs) throw new Error('脚本运行结果等待超时');
        return new Promise(function (resolve) {
          setTimeout(resolve, retryAfterMs);
        }).then(read);
      });
    }
    return read();
  }

  function saveAndRunScriptResource(item) {
    return upsertConfigResource('scripts', item).then(function (savedScript) {
      var scriptId = String(savedScript && savedScript.id || '');
      if (!scriptId) throw new Error('保存脚本未返回 ID');
      var runsUri = '/scripts/' + resourceSegment(scriptId) + '/runs';
      return resourceClient.authorizedPost(runsUri, {
        trigger: 'manual',
        timeoutMs: 60000,
      }, {
        criteria: { relation: 'script-runs' },
      }).then(function (envelope) {
        var operationUri = String(envelope.receipt && envelope.receipt.operationUri
          || envelope.primary && envelope.primary.uri || '');
        if (!operationUri) throw new Error('脚本运行未返回 operation URI');
        var retryAfterMs = Math.max(100, Math.min(2000, Number(envelope.receipt && envelope.receipt.retryAfterMs) || 250));
        return waitForScriptRun(operationUri, retryAfterMs, 65000).then(function (run) {
          return { script: savedScript, run: run, operationUri: operationUri };
        });
      }).catch(function (error) {
        if (error && typeof error === 'object') error.savedScript = savedScript;
        throw error;
      });
    });
  }

  function createFlowResource(item) {
    item = PageAutomationConfigMigration.cleanItem('flows', clonePlain(item || {}));
    var nodes = (Array.isArray(item.nodes) ? item.nodes : []).map(function (node) {
      return clonePlain(node || {});
    });
    item.nodes = [];
    var flowId = '';
    var itemUri = '';
    return resourceClient.authorizedPost('/flows', item, {
      criteria: { relation: 'flows' },
    }).then(function (envelope) {
      var created = applyFlowEnvelope(envelope);
      flowId = String(created && created.id || '');
      if (!flowId) throw new Error('创建流程未返回 ID');
      itemUri = '/flows/' + resourceSegment(flowId);
      return nodes.reduce(function (chain, node, index) {
        return chain.then(function () {
          var next = clonePlain(node);
          next.displayOrder = index + 1;
          return resourceClient.authorizedPost(itemUri + '/nodes', next, {
            etag: resourceClient.etagFor(itemUri),
            criteria: { relation: 'flow-nodes' },
          });
        }).then(function () {
          return resourceClient.get(itemUri).then(function (currentEnvelope) {
            applyFlowEnvelope(currentEnvelope);
            return currentEnvelope;
          });
        });
      }, Promise.resolve(envelope));
    }).then(function () {
      return resourceClient.get(itemUri).then(function (envelope) {
        applyFlowEnvelope(envelope);
        return envelope;
      });
    });
  }

  function createFlowGroupResource(item) {
    item = PageAutomationConfigMigration.cleanItem('flowGroups', clonePlain(item || {}));
    return resourceClient.authorizedPost('/flow-groups', item, {
      criteria: { relation: 'flow-groups' },
    }).then(function (envelope) {
      applyFlowGroupEnvelope(envelope);
      return envelope;
    });
  }

  function getCurrentWindowId() {
    return new Promise(function (resolve) {
      try {
        chrome.windows.getCurrent(function (win) {
          resolve(win && win.id ? win.id : 0);
        });
      } catch (_) {
        resolve(0);
      }
    });
  }

  function getRunOriginContext(entry) {
    return new Promise(function (resolve) {
      var base = { entry: entry || 'options' };
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          var tab = tabs && tabs[0];
          if (!tab || !tab.id || /^chrome-extension:\/\//.test(tab.url || '')) {
            resolve(base);
            return;
          }
          resolve(Object.assign(base, {
            ownerTabId: tab.id,
            originTabId: tab.id,
            originWindowId: tab.windowId || 0,
            incognito: !!tab.incognito,
          }));
        });
      } catch (_) {
        resolve(base);
      }
    });
  }

  var feedback = globalThis.PageAgentFeedback.create({ duration: 2600, replace: true });
  function toast(message, isError) {
    feedback.toast(message, { kind: isError ? 'error' : 'info' });
  }

  function genConfigId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function isBuiltinItem(item) {
    return !!(item && (item.__builtin || item.builtIn === true || item.protected === true));
  }

  function isBuiltinConfigImport(section, id, item, sourceConfig) {
    sourceConfig = sourceConfig || config;
    return ['pages', 'flows', 'flowGroups', 'scripts'].indexOf(section) !== -1
      && (isBuiltinItem(item) || !!(id && sourceConfig[section] && isBuiltinItem(sourceConfig[section][id])));
  }

  function stripRuntimeMetadata(value) {
    if (Array.isArray(value)) return value.map(stripRuntimeMetadata);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) {
        if (key.indexOf('__builtin') === 0) return;
        if (key === 'mcpValidation') return;
        out[key] = stripRuntimeMetadata(value[key]);
      });
      return out;
    }
    return value;
  }

  function userConfigValues(section) {
    return sortedValues(config[section]).filter(function (item) { return !isBuiltinItem(item); });
  }

  function listableFlows() {
    return sortedValues(config.flows);
  }

  // Flow argument metadata is intentionally descriptive only.
  // Keep args as runtime JSON plus text hints; do not reintroduce structured arg forms or validation here.
  function flowUsageSummary(item) {
    var parts = [];
    if (item && item.inputDescription) parts.push('入参说明');
    if (item && item.outputDescription) parts.push('出参说明');
    if (item && item.inputExample) parts.push('入参示例');
    return parts.join(' · ');
  }

  function normalizeRuntimeInputPayload(parsed) {
    return parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
      ? parsed
      : { input: parsed };
  }

  function buildRuntimeContextFromInputs(runnable, title) {
    if (runtimeInputDialog) return Promise.resolve(null);
    var initial = (runnable && runnable.inputExample) ? String(runnable.inputExample) : '';
    return new Promise(function (resolve) {
      var dialog = document.createElement('dialog'), previous = document.activeElement, settled = false;
      dialog.className = 'conversation-confirm-dialog code-input-dialog';
      dialog.setAttribute('aria-labelledby', 'runtime-input-dialog-title');
      dialog.innerHTML = '<form><header class="conversation-confirm-header"><h3 id="runtime-input-dialog-title">' + esc(title || '运行') + '</h3></header>'
        + '<div class="conversation-confirm-body"><p>入参 JSON 可留空。可使用 {"input": {...}}，也可以直接填写入参对象。</p>'
        + '<page-code-editor language="json" rows="10" aria-label="运行入参">' + esc(initial) + '</page-code-editor>'
        + '<p class="code-input-error" role="alert" hidden></p></div>'
        + '<footer class="conversation-confirm-actions"><button type="button" class="btn-secondary">取消</button><button type="submit" class="btn-primary">运行</button></footer></form>';
      function finish(value) {
        if (settled) return;
        settled = true; runtimeInputDialog = null; dialog.close(); dialog.remove();
        if (previous && previous.isConnected) previous.focus();
        resolve(value);
      }
      runtimeInputDialog = { cancel: function () { finish(null); } };
      dialog.querySelector('button[type="button"]').onclick = function () { finish(null); };
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); finish(null); });
      dialog.querySelector('form').onsubmit = function (event) {
        event.preventDefault();
        var raw = dialog.querySelector('page-code-editor').value.trim();
        try {
          if (!raw) { finish({}); return; }
          var parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
          finish(normalizeRuntimeInputPayload(parsed));
        } catch (error) {
          var notice = dialog.querySelector('[role="alert"]'); notice.hidden = false; notice.textContent = '入参 JSON 无效: ' + error.message;
        }
      };
      document.body.append(dialog); dialog.showModal(); dialog.querySelector('page-code-editor').focus();
    });
  }

  function sortedValues(map) {
    return Object.keys(map || {}).map(function (k) { return map[k]; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function formatLogTime(timestamp) {
    var date = new Date(timestamp);
    function pad(number, length) {
      var text = String(number);
      while (text.length < length) text = '0' + text;
      return text;
    }
    return pad(date.getFullYear(), 4) + '-' + pad(date.getMonth() + 1, 2) + '-' + pad(date.getDate(), 2) + ' '
      + pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2)
      + '.' + pad(date.getMilliseconds(), 3);
  }

  function formatStorageMegabytes(bytes) {
    var mb = (Number(bytes) || 0) / (1024 * 1024);
    return mb.toFixed(mb >= 10 ? 1 : 2) + 'MB';
  }

  function normalizeConfigListPageSize(value) {
    var size = Math.max(1, Number(value) || CONFIG_LIST_DEFAULT_PAGE_SIZE);
    if (CONFIG_LIST_PAGE_SIZE_OPTIONS.indexOf(size) !== -1) return size;
    return CONFIG_LIST_DEFAULT_PAGE_SIZE;
  }

  function normalizeConfigListCursor(value) {
    return Math.max(0, Number(value) || 0);
  }

  function configListPageState(section) {
    if (!configListPages[section]) {
      configListPages[section] = {
        cursor: 0,
        limit: CONFIG_LIST_DEFAULT_PAGE_SIZE,
      };
    }
    configListPages[section].cursor = normalizeConfigListCursor(configListPages[section].cursor);
    configListPages[section].limit = normalizeConfigListPageSize(configListPages[section].limit);
    return configListPages[section];
  }

  function resetConfigListPage(section) {
    configListPageState(section).cursor = 0;
  }

  function configListLabel(section) {
    return {
      pages: '页面',
      flows: '流程',
      flowGroups: '流程组',
      scripts: '脚本',
      schedules: '定时任务',
      'url-triggers': 'URL 触发器',
      logs: '流程报告',
    }[section] || '项目';
  }

  function configListPageSizeOptions(selected) {
    selected = normalizeConfigListPageSize(selected);
    return CONFIG_LIST_PAGE_SIZE_OPTIONS.map(function (size) {
      return '<option value="' + esc(size) + '"' + (size === selected ? ' selected' : '') + '>' + esc(size) + ' 条/页</option>';
    }).join('');
  }

  function paginateConfigList(section, items) {
    var state = configListPageState(section);
    var total = (items || []).length;
    var limit = state.limit;
    if (total > 0 && state.cursor >= total) {
      state.cursor = Math.floor((total - 1) / limit) * limit;
    }
    var cursor = normalizeConfigListCursor(state.cursor);
    return {
      section: section,
      total: total,
      cursor: cursor,
      limit: limit,
      items: (items || []).slice(cursor, cursor + limit),
    };
  }

  function renderConfigListPagination(page) {
    if (!page || page.total <= page.limit && page.cursor === 0) return '';
    var total = Math.max(0, Number(page.total) || 0);
    var limit = normalizeConfigListPageSize(page.limit);
    var cursor = normalizeConfigListCursor(page.cursor);
    var pageCount = Math.max(1, Math.ceil(total / limit));
    var pageNumber = Math.min(pageCount, Math.floor(cursor / limit) + 1);
    var start = total ? cursor + 1 : 0;
    var end = Math.min(total, cursor + (page.items || []).length);
    var prevCursor = Math.max(0, cursor - limit);
    var nextCursor = cursor + limit;
    var hasPrev = cursor > 0;
    var hasNext = nextCursor < total;
    return '<div class="list-pagination">'
      + '<div class="list-pagination-status">' + esc(configListLabel(page.section)) + ' 第 ' + esc(pageNumber) + ' / ' + esc(pageCount) + ' 页 · 显示 ' + esc(start) + '-' + esc(end) + ' / 共 ' + esc(total) + ' 条</div>'
      + '<div class="list-pagination-controls">'
      + '<select data-config-list-page-size data-section="' + esc(page.section) + '">' + configListPageSizeOptions(limit) + '</select>'
      + '<button class="btn-small" data-action="config-list-page" data-section="' + esc(page.section) + '" data-cursor="' + esc(prevCursor) + '"' + (hasPrev ? '' : ' disabled') + '>上一页</button>'
      + '<button class="btn-small" data-action="config-list-page" data-section="' + esc(page.section) + '" data-cursor="' + esc(nextCursor) + '"' + (hasNext ? '' : ' disabled') + '>下一页</button>'
      + '</div>'
      + '</div>';
  }

  function renderConfigListItems(section, items, emptyHtml, renderItem) {
    var page = paginateConfigList(section, items || []);
    if (!page.total) return emptyHtml;
    var pager = renderConfigListPagination(page);
    return pager + page.items.map(renderItem).join('') + pager;
  }

  function clearConfigListDraft(section) {
    if (section === 'pages' && pageController) pageController.clearDraft({ render: false });
    else if (section === 'flows' && flowController) flowController.clearDraft({ render: false });
    else if (section === 'flowGroups' && flowGroupController) flowGroupController.clearDraft({ render: false });
    else if (section === 'scripts' && scriptController) scriptController.clearDraft({ render: false });
    else if (section === 'schedules' && scheduleController) scheduleController.clearDraft({ render: false });
    else if (section === 'url-triggers' && urlTriggerController) {
      urlTriggerController.clearDraft({ render: false });
    }
  }

  function renderConfigListSection(section) {
    if (section === 'pages' && pageController) pageController.render();
    else if (section === 'flows' && flowController) flowController.render();
    else if (section === 'flowGroups' && flowGroupController) flowGroupController.render();
    else if (section === 'scripts' && scriptController) scriptController.render();
    else if (section === 'schedules' && scheduleController) scheduleController.render();
    else if (section === 'url-triggers' && urlTriggerController) urlTriggerController.render();
    else if (section === 'logs') renderRuns();
  }

  async function changeConfigListPage(section, cursor) {
    if (!await confirmDiscardConfigDraft(section)) return false;
    var state = configListPageState(section);
    state.cursor = normalizeConfigListCursor(cursor);
    clearConfigListDraft(section);
    renderConfigListSection(section);
    return true;
  }

  async function handleConfigListPageSizeChange(event) {
    var target = event.target;
    if (!target || !target.matches || !target.matches('[data-config-list-page-size]')) return;
    var section = target.dataset.section || currentSection;
    var state = configListPageState(section);
    if (!await confirmDiscardConfigDraft(section)) {
      target.value = String(state.limit);
      return;
    }
    state.limit = normalizeConfigListPageSize(target.value);
    state.cursor = 0;
    clearConfigListDraft(section);
    renderConfigListSection(section);
  }

  // --- 配置加载 ---

  function loadConfig() {
    var loadingFlows = currentSection === 'flows';
    if (loadingFlows) pendingFlowConfigRefresh = false;
    return loadConfigResourceSnapshot().then(function (snapshot) {
      config = snapshot;
      renderCurrentSection();
      return { ok: true, payload: clonePlain(snapshot) };
    }).catch(function (error) {
      if (loadingFlows) pendingFlowConfigRefresh = true;
      toast('加载资源失败: ' + resourceErrorText(error), true);
      renderCurrentSection();
      return { ok: false, error: resourceErrorText(error) };
    });
  }

  function currentConfigDomainController(section) {
    section = section || currentSection;
    if (section === 'pages') return pageController;
    if (section === 'flows') return flowController;
    if (section === 'flowGroups') return flowGroupController;
    if (section === 'scripts') return scriptController;
    if (section === 'schedules') return scheduleController;
    if (section === 'url-triggers') return urlTriggerController;
    return null;
  }

  function configDomainBusy() {
    var controller = currentConfigDomainController();
    var state = controller && typeof controller.getState === 'function' ? controller.getState() : null;
    if (!state) return false;
    return !!(state.dirty || state.saving || state.copying || state.mutating
      || state.testing || state.deleting || state.splitting);
  }

  function refreshPendingSyncConfig() {
    if (!(pendingSyncRefresh || pendingFlowConfigRefresh) || !sectionUsesConfig(currentSection)) return false;
    if (configDomainBusy()) {
      if (currentSection !== 'flows' && currentSection !== 'flowGroups' && !syncConfigRefreshTimer) {
        syncConfigRefreshTimer = window.setTimeout(function () {
          syncConfigRefreshTimer = 0;
          refreshPendingSyncConfig();
        }, 100);
      }
      return false;
    }
    pendingSyncRefresh = false;
    pendingFlowConfigRefresh = false;
    if (!syncConfigRefreshTimer) {
      syncConfigRefreshTimer = window.setTimeout(function () {
        syncConfigRefreshTimer = 0;
        if (tornDown) return;
        if (configDomainBusy()) {
          pendingSyncRefresh = true;
          refreshPendingSyncConfig();
          return;
        }
        loadConfig();
      }, 0);
    }
    return true;
  }

  function handleSyncEvent(event) {
    if (!event) return;
    var resource = String(event.resource || '');
    if (resource === 'flowGroup' && event.action === 'deleted' && flowGroupController
        && typeof flowGroupController.markExternalDelete === 'function') {
      flowGroupController.markExternalDelete(event.id);
    }
    if (resource === 'assistant') {
      if (flowNodeController && typeof flowNodeController.refreshAssistantReferences === 'function') {
        flowNodeController.refreshAssistantReferences().catch(function () {});
      }
      if (currentSection === 'schedules' && scheduleController
          && typeof scheduleController.refreshAssistantReferences === 'function') {
        scheduleController.refreshAssistantReferences().catch(function () {});
      }
      return;
    }
    var affectsConfig = resource === 'config'
      || ['page', 'flow', 'flowGroup', 'script', 'schedule', 'urlTrigger'].indexOf(resource) >= 0;
    if (!affectsConfig || !sectionUsesConfig(currentSection)) return;
    if (configDomainBusy()) {
      pendingSyncRefresh = true;
      refreshPendingSyncConfig();
      return;
    }
    pendingSyncRefresh = true;
    refreshPendingSyncConfig();
  }

  function mutateConfig(op, section, itemOrId) {
    if (section === 'flows' || section === 'flowGroups') {
      return Promise.reject(new Error('Flow 和 FlowGroup 必须通过平台资源接口修改'));
    }
    if (!configResourceSpec(section)) {
      return Promise.reject(new Error('配置分区必须通过对应平台资源修改: ' + section));
    }
    var operation;
    if (op === 'upsert') operation = upsertConfigResource(section, itemOrId);
    else if (op === 'delete') operation = deleteConfigResource(section, itemOrId);
    else return Promise.reject(new Error('不支持的平台资源变更操作: ' + op));
    return operation.then(function () {
      return config;
    });
  }

  // --- 导航 ---

  function sectionUsesConfig(section) {
    return ['pages', 'flows', 'flowGroups', 'scripts', 'schedules', 'url-triggers'].indexOf(section) !== -1;
  }

  function sectionEditState() {
    var controller = currentConfigDomainController();
    var states = [];
    if (controller) states.push(controller.getState());
    if (currentSection === 'model-settings') states.push(globalThis.OptionsModelSettingsPanel.getState());
    if (currentSection === 'knowledge') states.push(globalThis.OptionsKnowledgePanel.getState());
    if (currentSection === 'mcp') {
      states.push({
        dirty: mcpSettingsDirty || mcpLocalDirectoryDirty || mcpArpPermissionsDirty
          || mcpActionDrawer === 'client' && $('#mcp-client-name').value.trim() !== mcpClientNameBeforeEdit,
        busy: mcpSettingsSaving || mcpEnabledUpdating,
      });
      states.push(globalThis.OptionsMailController.getState());
    }
    if (currentSection === 'system-settings') states.push({ dirty: systemProxyDirty, busy: systemSettingsSaving });
    if (appController) states.push(appController.getEditState());
    if (globalThis.Conversation && globalThis.Conversation.getEditState) states.push(globalThis.Conversation.getEditState());
    if ($('#drawer').classList.contains('active') && drawerEditBaseline) {
      states.push({ dirty: readDrawerEditSignature() !== drawerEditBaseline });
    }
    return {
      dirty: states.some(function (state) { return state && state.dirty; }),
      busy: states.some(function (state) {
        return state && (state.busy || state.saving || state.mutating || state.copying || state.deleting || state.splitting || state.testing);
      }),
    };
  }

  async function leaveCurrentSection() {
    var editing = sectionEditState();
    if (editing.busy) { toast('正在保存或处理，请稍后再切换'); return false; }
    if (editing.dirty && !await confirmUnsavedChanges()) return false;
    if ($('#drawer').classList.contains('active') && !await closeDrawer({ discard: true })) return false;
    clearConfigListDraft(currentSection);
    if (currentSection === 'conversation' && globalThis.Conversation) globalThis.Conversation.discardEditor();
    if (currentSection === 'model-settings') globalThis.OptionsModelSettingsPanel.discard();
    if (currentSection === 'knowledge') globalThis.OptionsKnowledgePanel.discard();
    if (currentSection === 'mcp') {
      resetMcpEditorDraft();
      if (mcpCreating) { mcpCreating = false; mcpConnection = mcpConnections[0] || null; }
      if (mcpConnection) applyMcpConnectionToControls(mcpConnection);
      setMcpEditorOpen(false);
      globalThis.OptionsMailController.discard();
    }
    if (currentSection === 'system-settings') { systemProxyDirty = false; renderSystemSettings(); }
    return true;
  }

  async function switchSection(section) {
    if (navigationPending) return false;
    if (navigationReady && currentSection === section) return true;
    navigationPending = true;
    try {
      if (navigationReady && !await leaveCurrentSection()) return false;
      navigationReady = true;
      // Entry targets are captured before the initial navigation and used only once.
      var url = new URL(location.href);
      ['section', 'appId', 'action', 'assistantId', 'topicId'].forEach(function (key) { url.searchParams.delete(key); });
      if (url.href !== location.href) history.replaceState(history.state, '', url.href);
      if (section !== 'conversation') pendingConversationTarget = null;
      currentSection = section;
      var main = $('#main');
      if (main) main.classList.toggle('conversation-main', section === 'conversation');
      $all('.nav-item').forEach(function (el) {
        el.classList.toggle('active', el.dataset.section === section);
      });
      $all('.section').forEach(function (el) {
        el.classList.toggle('active', el.id === 'section-' + section);
      });
      if (sectionUsesConfig(section)) {
        loadConfig();
        return true;
      }
      renderCurrentSection();
      return true;
    } finally { navigationPending = false; }
  }

  function renderCurrentSection() {
    switch (currentSection) {
      case 'apps': if (appController) appController.render().catch(function (error) { toast(error.message, true); }); break;
      case 'pages': if (pageController) pageController.render(); break;
      case 'flows': if (flowController) flowController.render(); break;
      case 'flowGroups': if (flowGroupController) flowGroupController.render(); break;
      case 'scripts': if (scriptController) scriptController.render(); break;
      case 'schedules': if (scheduleController) scheduleController.refresh(); break;
      case 'url-triggers': if (urlTriggerController) urlTriggerController.render(); break;
      case 'logs': renderRuns(); break;
      case 'mcp': renderMCP(); break;
      case 'knowledge':
        if (window.OptionsKnowledgePanel && window.OptionsKnowledgePanel.render) window.OptionsKnowledgePanel.render();
        break;
      case 'conversation':
        if (window.Conversation && pendingConversationTarget && window.Conversation.openTarget) {
          var target = pendingConversationTarget;
          pendingConversationTarget = null;
          window.Conversation.openTarget(target);
        } else if (window.Conversation && window.Conversation.render) {
          window.Conversation.render();
        }
        break;
      case 'system-settings':
        renderSystemSettings();
        if (appController) appController.render().catch(function (error) { toast(error.message, true); });
        break;
    }
  }

  // ============================================================
  // 流程配置
  // ============================================================

  function renderFlows() {
    return flowController ? flowController.render() : null;
  }

  async function runFlow(flowId) {
    var flow = config.flows && config.flows[flowId];
    var context = await buildRuntimeContextFromInputs(flow, '运行流程「' + ((flow && flow.label) || flowId) + '」');
    if (context === null || tornDown) return;
    var uri = '/flows/' + resourceSegment(flowId) + '/runs';
    resourceClient.authorizedPost(uri, {
      trigger: 'manual',
      context: context,
      options: { totalRuns: 1, maxRetries: 0 },
    }, {
      criteria: { relation: 'flow-runs' },
    }).then(function (envelope) {
      var operationUri = envelope.receipt && envelope.receipt.operationUri || envelope.primary && envelope.primary.uri || '';
      toast('流程已启动' + (operationUri ? '，运行记录已创建' : ''));
      if (currentSection === 'logs') renderRuns({ force: true });
    }).catch(function (error) {
      toast('启动失败: ' + resourceErrorText(error), true);
    });
  }

  // ============================================================
  // 流程组
  // ============================================================

  async function runFlowGroup(flowGroupId) {
    var group = config.flowGroups && config.flowGroups[flowGroupId];
    var context = await buildRuntimeContextFromInputs(group, '运行流程组「' + ((group && (group.label || group.name)) || flowGroupId) + '」');
    if (context === null || tornDown) return;
    var uri = '/flow-groups/' + resourceSegment(flowGroupId) + '/runs';
    resourceClient.authorizedPost(uri, {
      trigger: 'manual',
      context: context,
    }, {
      criteria: { relation: 'flow-group-runs' },
    }).then(function () {
      toast('流程组已启动，结果见「流程报告」');
      if (currentSection === 'logs') renderRuns({ force: true });
    }).catch(function (error) {
      toast('流程组启动失败: ' + resourceErrorText(error), true);
    });
  }

  // ============================================================
  // 流程导入导出 / 配置备份
  // ============================================================

  function genUniqueConfigId(prefix, section, reserved) {
    reserved = reserved || {};
    var id;
    do {
      id = genConfigId(prefix);
    } while ((config[section] && config[section][id]) || reserved[id]);
    reserved[id] = true;
    return id;
  }

  function uniqueIds(ids) {
    var seen = {};
    return (ids || []).filter(function (id) {
      id = String(id || '');
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  function normalizeUserFlowId(flowId) {
    return typeof flowId === 'string' ? flowId.replace(/^user:/, '') : '';
  }

  function collectFlowBundleParts(flowIds) {
    var flows = {};
    var pages = {};
    var scripts = {};
    uniqueIds(flowIds).forEach(function (flowId) {
      var flow = config.flows && config.flows[flowId];
      if (!flow || isBuiltinItem(flow)) return;
      flows[flowId] = stripRuntimeMetadata(flow);
      (flow.nodes || []).forEach(function (n) {
        if (n.pageId && config.pages[n.pageId] && !isBuiltinItem(config.pages[n.pageId])) pages[n.pageId] = stripRuntimeMetadata(config.pages[n.pageId]);
        var sid = n.params && n.params.scriptId;
        if (sid && config.scripts[sid] && !isBuiltinItem(config.scripts[sid])) scripts[sid] = stripRuntimeMetadata(config.scripts[sid]);
      });
    });
    return { flows: flows, pages: pages, scripts: scripts };
  }

  function copyFlowGroup(flowGroupId) {
    var source = config.flowGroups && config.flowGroups[flowGroupId];
    if (!source) return;

    var flowIds = uniqueIds((source.steps || []).map(function (step) {
      return normalizeUserFlowId(step && step.flowId);
    }).filter(function (fid) { return config.flows[fid]; }));
    var flowIdMap = {};
    var pageIdMap = {};
    var scriptIdMap = {};
    var reservedFlows = {};
    var reservedPages = {};
    var reservedScripts = {};

    flowIds.forEach(function (fid) {
      flowIdMap[fid] = genUniqueConfigId('fl', 'flows', reservedFlows);
    });

    flowIds.forEach(function (fid) {
      (config.flows[fid].nodes || []).forEach(function (node) {
        if (node.pageId && config.pages[node.pageId] && !pageIdMap[node.pageId]) {
          pageIdMap[node.pageId] = genUniqueConfigId('pa', 'pages', reservedPages);
        }
        var sid = node.params && node.params.scriptId;
        if (sid && config.scripts[sid] && !scriptIdMap[sid]) {
          scriptIdMap[sid] = genUniqueConfigId('sc', 'scripts', reservedScripts);
        }
      });
    });

    function remapNode(node) {
      var copy = stripRuntimeMetadata(node);
      if (copy.pageId && pageIdMap[copy.pageId]) copy.pageId = pageIdMap[copy.pageId];
      copy.params = copy.params || {};
      if (copy.params.scriptId && scriptIdMap[copy.params.scriptId]) copy.params.scriptId = scriptIdMap[copy.params.scriptId];
      return copy;
    }

    var ops = [];
    Object.keys(pageIdMap).forEach(function (oldId) {
      var page = stripRuntimeMetadata(config.pages[oldId]);
      page.id = pageIdMap[oldId];
      page.label = (page.label || page.url || oldId) + ' (副本)';
      delete page.updatedAt;
      ops.push(['pages', page]);
    });
    Object.keys(scriptIdMap).forEach(function (oldId) {
      var script = stripRuntimeMetadata(config.scripts[oldId]);
      script.id = scriptIdMap[oldId];
      script.label = (script.label || oldId) + ' (副本)';
      delete script.updatedAt;
      ops.push(['scripts', script]);
    });
    flowIds.forEach(function (oldId) {
      var flow = stripRuntimeMetadata(config.flows[oldId]);
      flow.id = flowIdMap[oldId];
      flow.label = (flow.label || oldId) + ' (副本)';
      flow.nodes = (flow.nodes || []).map(remapNode);
      delete flow.updatedAt;
      ops.push(['flows', flow]);
    });

    var groupId = genUniqueConfigId('fg', 'flowGroups');
    var group = stripRuntimeMetadata(source);
    group.id = groupId;
    group.label = (group.label || group.name || flowGroupId) + ' (副本)';
    group.steps = (group.steps || []).map(function (step) {
      var copy = stripRuntimeMetadata(step);
      var sourceFlowId = normalizeUserFlowId(copy.flowId);
      if (sourceFlowId && flowIdMap[sourceFlowId]) copy.flowId = flowIdMap[sourceFlowId];
      return copy;
    });
    delete group.updatedAt;
    ops.push(['flowGroups', group]);

    var chain = Promise.resolve();
    ops.forEach(function (op) {
      chain = chain.then(function () {
        if (op[0] === 'flows') return createFlowResource(op[1]);
        if (op[0] === 'flowGroups') return createFlowGroupResource(op[1]);
        return mutateConfig('upsert', op[0], op[1]).then(function (cfg) {
          if (!cfg) throw new Error('复制流程组失败');
        });
      });
    });
    chain.then(function () {
      resetConfigListPage('pages');
      resetConfigListPage('flows');
      resetConfigListPage('flowGroups');
      resetConfigListPage('scripts');
      toast('已复制为用户流程组');
      if (flowGroupController) flowGroupController.openById(groupId);
    }).catch(function (err) {
      toast(err.message || '复制流程组失败', true);
    });
  }

  function exportFlowGroup(flowGroupId) {
    var group = config.flowGroups && config.flowGroups[flowGroupId];
    if (!group) return;
    if (isBuiltinItem(group)) {
      toast('内置流程组不支持导出，请先复制为用户流程组', true);
      return;
    }
    var flowIds = uniqueIds((group.steps || []).map(function (step) {
      return normalizeUserFlowId(step && step.flowId);
    }).filter(function (flowId) {
      return flowId && config.flows && config.flows[flowId] && !isBuiltinItem(config.flows[flowId]);
    }));
    var parts = collectFlowBundleParts(flowIds);
    var bundle = {
      kind: 'pfa-flow-group',
      version: 1,
      exportedAt: new Date().toISOString(),
      flowGroup: stripRuntimeMetadata(group),
      flows: parts.flows,
      pages: parts.pages,
      scripts: parts.scripts,
    };
    backupController.downloadFile('flow-group-' + (group.label || group.name || flowGroupId).replace(/[^\w一-龥-]+/g, '_') + '.json', JSON.stringify(bundle, null, 2), 'application/json');
  }

  function importFlowBundle(bundle) {
    if (!bundle || bundle.kind !== 'pfa-flow' || !bundle.flow) {
      toast('不是有效的流程导出文件', true);
      return;
    }
    if (isBuiltinConfigImport('flows', bundle.flow.id, bundle.flow)) {
      toast('导入包中的内置流程已跳过');
      return;
    }
    var ops = [];
    var pageIdMap = {};
    var scriptIdMap = {};
    var reservedPages = {};
    var reservedScripts = {};
    Object.keys(bundle.pages || {}).forEach(function (id) {
      if (isBuiltinConfigImport('pages', id, bundle.pages[id])) return;
      var page = stripRuntimeMetadata(bundle.pages[id]);
      if (config.pages[id] && isBuiltinItem(config.pages[id])) {
        page.id = genUniqueConfigId('pa', 'pages', reservedPages);
        page.label = (page.label || page.url || id) + ' (导入)';
        pageIdMap[id] = page.id;
      }
      ops.push(['pages', page]);
    });
    Object.keys(bundle.scripts || {}).forEach(function (id) {
      if (isBuiltinConfigImport('scripts', id, bundle.scripts[id])) return;
      var script = stripRuntimeMetadata(bundle.scripts[id]);
      if (config.scripts[id] && isBuiltinItem(config.scripts[id])) {
        script.id = genUniqueConfigId('sc', 'scripts', reservedScripts);
        script.label = (script.label || id) + ' (导入)';
        scriptIdMap[id] = script.id;
      }
      ops.push(['scripts', script]);
    });
    function remapImportedFlow(item) {
      item.nodes = (item.nodes || []).map(function (node) {
        var copy = stripRuntimeMetadata(node);
        if (copy.pageId && pageIdMap[copy.pageId]) copy.pageId = pageIdMap[copy.pageId];
        copy.params = copy.params || {};
        if (copy.params.scriptId && scriptIdMap[copy.params.scriptId]) copy.params.scriptId = scriptIdMap[copy.params.scriptId];
        return copy;
      });
      return item;
    }
    var flow = remapImportedFlow(PageAutomationConfigMigration.cleanItem('flows', stripRuntimeMetadata(bundle.flow)));
    if (config.flows[flow.id]) {
      flow = JSON.parse(JSON.stringify(flow));
      flow.id = '';
      flow.label = (flow.label || '') + ' (导入)';
    }
    ops.push(['flows', flow]);

    var chain = Promise.resolve();
    ops.forEach(function (op) {
      chain = chain.then(function () {
        if (op[0] === 'flows') return createFlowResource(op[1]);
        return mutateConfig('upsert', op[0], op[1]);
      });
    });
    chain.then(function () {
      resetConfigListPage('pages');
      resetConfigListPage('flows');
      resetConfigListPage('scripts');
      toast('流程导入完成');
      renderFlows();
    });
  }

  function importFlowGroupBundle(bundle) {
    if (!bundle || bundle.kind !== 'pfa-flow-group' || !bundle.flowGroup) {
      toast('不是有效的流程组导出文件', true);
      return;
    }
    if (isBuiltinConfigImport('flowGroups', bundle.flowGroup.id, bundle.flowGroup)) {
      toast('导入包中的内置流程组已跳过');
      return;
    }
    var ops = [];
    var pageIdMap = {};
    var scriptIdMap = {};
    var flowIdMap = {};
    var importedFlowIds = {};
    var reservedPages = {};
    var reservedScripts = {};
    var reservedFlows = {};
    var reservedFlowGroups = {};

    Object.keys(bundle.pages || {}).forEach(function (id) {
      if (isBuiltinConfigImport('pages', id, bundle.pages[id])) return;
      var page = stripRuntimeMetadata(bundle.pages[id]);
      page.id = page.id || id;
      if (config.pages[id]) {
        page.id = genUniqueConfigId('pa', 'pages', reservedPages);
        page.label = (page.label || page.url || id) + ' (导入)';
        pageIdMap[id] = page.id;
      }
      ops.push(['pages', page]);
    });
    Object.keys(bundle.scripts || {}).forEach(function (id) {
      if (isBuiltinConfigImport('scripts', id, bundle.scripts[id])) return;
      var script = stripRuntimeMetadata(bundle.scripts[id]);
      script.id = script.id || id;
      if (config.scripts[id]) {
        script.id = genUniqueConfigId('sc', 'scripts', reservedScripts);
        script.label = (script.label || id) + ' (导入)';
        scriptIdMap[id] = script.id;
      }
      ops.push(['scripts', script]);
    });

    Object.keys(bundle.flows || {}).forEach(function (id) {
      if (isBuiltinConfigImport('flows', id, bundle.flows[id])) return;
      var flow = PageAutomationConfigMigration.cleanItem('flows', stripRuntimeMetadata(bundle.flows[id]));
      flow.id = flow.id || id;
      if (config.flows[id]) {
        flow.id = genUniqueConfigId('fl', 'flows', reservedFlows);
        flow.label = (flow.label || id) + ' (导入)';
      }
      flowIdMap[id] = flow.id || id;
      importedFlowIds[flowIdMap[id]] = true;
      flow.nodes = (flow.nodes || []).map(function (node) {
        var copy = stripRuntimeMetadata(node);
        if (copy.pageId && pageIdMap[copy.pageId]) copy.pageId = pageIdMap[copy.pageId];
        copy.params = copy.params || {};
        if (copy.params.scriptId && scriptIdMap[copy.params.scriptId]) copy.params.scriptId = scriptIdMap[copy.params.scriptId];
        return copy;
      });
      ops.push(['flows', flow]);
    });

    var group = PageAutomationConfigMigration.cleanItem('flowGroups', stripRuntimeMetadata(bundle.flowGroup));
    group.steps = (group.steps || []).map(function (step) {
      var copy = stripRuntimeMetadata(step);
      var sourceFlowId = normalizeUserFlowId(copy.flowId);
      if (sourceFlowId && flowIdMap[sourceFlowId]) copy.flowId = flowIdMap[sourceFlowId];
      return copy;
    });
    var missingFlowIds = uniqueIds((group.steps || []).map(function (step) {
      return normalizeUserFlowId(step && step.flowId);
    }).filter(function (flowId) {
      return flowId && !config.flows[flowId] && !importedFlowIds[flowId];
    }));
    if (missingFlowIds.length) {
      toast('流程组引用的流程不存在且导出包未携带: ' + missingFlowIds.join(', '), true);
      return;
    }
    if (!group.id || config.flowGroups[group.id]) {
      group.id = genUniqueConfigId('fg', 'flowGroups', reservedFlowGroups);
      group.label = (group.label || group.name || '') + ' (导入)';
    }
    ops.push(['flowGroups', group]);

    var chain = Promise.resolve();
    ops.forEach(function (op) {
      chain = chain.then(function () {
        if (op[0] === 'flows') return createFlowResource(op[1]);
        if (op[0] === 'flowGroups') return createFlowGroupResource(op[1]);
        return mutateConfig('upsert', op[0], op[1]);
      });
    });
    chain.then(function () {
      resetConfigListPage('pages');
      resetConfigListPage('flows');
      resetConfigListPage('flowGroups');
      resetConfigListPage('scripts');
      toast('流程组导入完成');
      if (flowGroupController) flowGroupController.render();
    });
  }

  // ============================================================
  // 运行历史与流程报告
  // ============================================================

  var runReportController = null;

  function renderRuns(options) {
    if (!runReportController) return Promise.resolve({ ok: false, error: '流程报告控制器尚未初始化' });
    return runReportController.refresh(options);
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  function updateFavoritesAvailability(disabled) {
    var input = $('#system-sidebar-apps-favorites-only');
    // 已开启时仍允许关闭，避免取消最后一个收藏后无法退出该模式。
    if (input) input.disabled = !!disabled || (!hasAppFavorites && !systemSettings.sidebarAppsFavoritesOnly);
    var hint = $('#system-sidebar-apps-favorites-hint');
    if (hint) hint.textContent = hasAppFavorites
      ? '开启后，无搜索词时只显示收藏的应用；输入搜索词时搜索全部应用。'
      : '请先在应用入口收藏应用，才可开启此开关。';
    var popupInput = $('#system-popup-apps-favorites-only');
    if (popupInput) popupInput.disabled = !!disabled || (!hasAppFavorites && !systemSettings.popupAppsFavoritesOnly);
    var popupHint = $('#system-popup-apps-favorites-hint');
    if (popupHint) popupHint.textContent = hasAppFavorites
      ? '开启后，左键菜单显示全部收藏，顺序与应用入口的收藏列表一致；关闭后恢复最近使用。'
      : '请先在应用入口收藏应用，才可开启此开关。';
  }

  function setSystemSettingsControlsDisabled(disabled) {
    $all('#section-system-settings .connection-card').forEach(function (card) {
      card.disabled = !!disabled;
    });
    var floatingEntry = $('#system-floating-entry-disabled');
    if (floatingEntry) floatingEntry.disabled = !!disabled;
    updateFavoritesAvailability(disabled);
    var userAgent = $('#system-user-agent');
    if (userAgent) userAgent.disabled = !!disabled;
    Object.keys(systemProxyControls).forEach(function (key) {
      var input = $(systemProxyControls[key]);
      if (input) input.disabled = !!disabled;
    });
    var saveProxy = $('#btn-save-system-proxy');
    if (saveProxy) saveProxy.disabled = !!disabled;
  }

  function refreshSystemProxyStatus(manual) {
    var element = $('#system-proxy-status');
    if (!element) return;
    var requestId = ++systemProxyStatusRequestId;
    var button = $('#btn-refresh-system-proxy-status');
    if (button) {
      button.disabled = true;
      button.textContent = '刷新中…';
    }
    element.textContent = '正在读取代理状态…';
    element.setAttribute('aria-busy', 'true');
    var timer;
    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error('后台在 10 秒内未响应，请重新加载扩展并刷新当前设置页'));
      }, 10000);
      chrome.runtime.sendMessage({ type: 'SYSTEM_PROXY_STATUS' }).then(resolve, reject);
    }).then(function (response) {
      if (requestId !== systemProxyStatusRequestId) return;
      if (!response || !response.ok || !response.payload) throw new Error(response && response.error || '未收到有效的代理状态');
      var status = response.payload;
      var labels = {
        controlled_by_this_extension: '当前由本插件控制',
        controllable_by_this_extension: '当前未由本插件控制，本插件可以接管',
        controlled_by_other_extensions: '当前由其他插件控制，本插件的代理配置未生效',
        not_controllable: '当前不允许本插件控制代理（可能受浏览器策略限制）',
      };
      element.textContent = (labels[status.levelOfControl] || '代理控制状态未知')
        + '；' + (status.scope === 'regular' ? '普通浏览器配置' : '无痕浏览器配置')
        + '；当前模式：' + status.mode + '；流程规则：' + status.activeRules + ' 条'
        + '；刷新时间：' + new Date().toLocaleTimeString();
      if (manual === true) toast('代理状态已刷新');
    }).catch(function (error) {
      if (requestId !== systemProxyStatusRequestId) return;
      element.textContent = '代理状态读取失败：' + error.message;
      if (manual === true) toast(element.textContent, true);
    }).finally(function () {
      clearTimeout(timer);
      if (requestId !== systemProxyStatusRequestId) return;
      element.removeAttribute('aria-busy');
      if (button) {
        button.disabled = false;
        button.textContent = '刷新状态';
      }
    });
  }

  function renderSystemSettings() {
    var floatingEntry = $('#system-floating-entry-disabled');
    if (floatingEntry) floatingEntry.checked = systemSettings.floatingEntryDisabled === true;
    var sidebarFavorites = $('#system-sidebar-apps-favorites-only');
    if (sidebarFavorites) sidebarFavorites.checked = systemSettings.sidebarAppsFavoritesOnly === true;
    var popupFavorites = $('#system-popup-apps-favorites-only');
    if (popupFavorites) popupFavorites.checked = systemSettings.popupAppsFavoritesOnly === true;
    updateFavoritesAvailability(systemSettingsSaving);
    var userAgent = $('#system-user-agent');
    if (userAgent) userAgent.value = systemSettings.userAgent;
    if (!systemProxyDirty) {
      Object.keys(systemProxyControls).forEach(function (key) {
        var input = $(systemProxyControls[key]);
        if (input) input.value = systemSettings[key];
      });
    }
    refreshSystemProxyStatus();
  }

  function loadSystemSettings() {
    return globalThis.PageAutomationSystemSettings.load(chrome.storage.local, chrome.runtime).then(function (settings) {
      systemSettings = settings;
      renderSystemSettings();
      return settings;
    });
  }

  function saveSystemSettingsFromControls(saveProxy) {
    if (systemSettingsSaving) return;
    var floatingEntry = $('#system-floating-entry-disabled');
    var previous = systemSettings;
    var floatingEntryDisabled = !!(floatingEntry && floatingEntry.checked);
    var sidebarFavorites = $('#system-sidebar-apps-favorites-only');
    var popupFavorites = $('#system-popup-apps-favorites-only');
    if (!hasAppFavorites && (
      sidebarFavorites && sidebarFavorites.checked && !previous.sidebarAppsFavoritesOnly ||
      popupFavorites && popupFavorites.checked && !previous.popupAppsFavoritesOnly
    )) {
      if (sidebarFavorites) sidebarFavorites.checked = previous.sidebarAppsFavoritesOnly;
      if (popupFavorites) popupFavorites.checked = previous.popupAppsFavoritesOnly;
      updateFavoritesAvailability(false);
      toast('请先在应用入口收藏应用', true);
      return;
    }
    var userAgent = $('#system-user-agent');
    var configuredUserAgent = userAgent ? userAgent.value : previous.userAgent;
    systemSettingsSaving = true;
    setSystemSettingsControlsDisabled(true);
    var next = globalThis.PageAutomationSystemSettings.normalize(Object.assign({}, previous, {
      floatingEntryDisabled: floatingEntryDisabled,
      sidebarAppsFavoritesOnly: sidebarFavorites ? sidebarFavorites.checked : previous.sidebarAppsFavoritesOnly,
      popupAppsFavoritesOnly: popupFavorites ? popupFavorites.checked : previous.popupAppsFavoritesOnly,
      userAgent: configuredUserAgent,
    }));
    if (saveProxy === true) {
      Object.keys(systemProxyControls).forEach(function (key) {
        var input = $(systemProxyControls[key]);
        if (input) next[key] = input.value;
      });
    }
    chrome.runtime.sendMessage({ type: 'SYSTEM_SETTINGS_SAVE', payload: next }).then(function (response) {
      if (!response || !response.ok) throw new Error(response && response.error || '系统配置保存失败');
      return response.payload;
    }).then(function (saved) {
      systemSettings = saved;
      if (saveProxy === true) systemProxyDirty = false;
      renderSystemSettings();
      toast(saveProxy === true ? '代理设置已保存' : '系统配置已更新');
    }).catch(function (error) {
      systemSettings = previous;
      renderSystemSettings();
      toast('系统配置保存失败: ' + (error && error.message || error), true);
    }).finally(function () {
      systemSettingsSaving = false;
      setSystemSettingsControlsDisabled(false);
    });
  }

  // 在卡片列表的事件代理前处理拖拽区域和复制，避免同时打开编辑器。
  document.addEventListener('click', function (event) {
    if (event.target.closest('.node-card-heading[draggable="true"]')) {
      event.stopPropagation();
      return;
    }
    if (event.target.closest('.item-card, .node-card') && event.target.closest('button:disabled')) {
      event.stopPropagation();
      return;
    }
    var target = event.target.closest('[data-action="copy-id"]');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    var selection = window.getSelection && window.getSelection();
    if (selection && String(selection).trim() && target.contains(selection.anchorNode) && target.contains(selection.focusNode)) return;
    var id = target.dataset.id || '';
    copyText(id).then(function () { toast('已复制 ID: ' + id); })
      .catch(function () { toast('复制失败，请手动选中复制', true); });
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var card = event.target.closest('.item-card[tabindex="0"], .node-card[tabindex="0"]');
    if (!card || event.target !== card) return;
    event.preventDefault();
    if (card.getAttribute('aria-disabled') !== 'true') card.click();
  });

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    var id = target.dataset.id;
    if (flowNodeController && flowNodeController.ownsAction(action)) return;

    switch (action) {
      case 'config-list-page':
        event.stopPropagation();
        changeConfigListPage(target.dataset.section || currentSection, target.dataset.cursor);
        break;

      // 流程
      case 'run-flow':
        event.stopPropagation();
        runFlow(id);
        break;
      // 流程组跨域命令保留在页面编排层；编辑与持久化由控制器处理。
      case 'run-flowGroup':
        event.stopPropagation();
        runFlowGroup(id);
        break;
      case 'export-flowGroup':
        event.stopPropagation();
        exportFlowGroup(id);
        break;
      case 'copy-flowGroup':
        event.stopPropagation();
        copyFlowGroup(id);
        break;

      case 'cancel-drawer':
        handleDrawerCancel(event);
        break;
      default:
        if (flowController && flowController.handleAction(action, id, event)) break;
        if (flowGroupController && flowGroupController.handleAction(action, id, event, target)) break;
        if (pageController && pageController.handleAction(action, id, event)) break;
        if (scriptController && scriptController.handleAction(action, id, event)) break;
        if (scheduleController && scheduleController.handleAction(action, id, event)) break;
        if (backupController) backupController.handleAction(action, event);
        break;
    }
  });

  document.addEventListener('change', handleConfigListPageSizeChange);

  $all('#section-system-settings .connection-card').forEach(function (card) {
    var editor = document.getElementById(card.getAttribute('aria-controls'));
    card.addEventListener('click', function () {
      if (systemSettingsSaving) return;
      var open = editor.classList.contains('hidden');
      editor.classList.toggle('hidden', !open);
      card.classList.toggle('selected', open);
      card.setAttribute('aria-expanded', String(open));
      if (open) scrollOpenedEditor(editor);
      else {
        card.focus({ preventScroll: true });
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });

  var floatingEntryToggle = $('#system-floating-entry-disabled');
  if (floatingEntryToggle) floatingEntryToggle.addEventListener('change', saveSystemSettingsFromControls);
  var sidebarFavoritesToggle = $('#system-sidebar-apps-favorites-only');
  if (sidebarFavoritesToggle) sidebarFavoritesToggle.addEventListener('change', saveSystemSettingsFromControls);
  var popupFavoritesToggle = $('#system-popup-apps-favorites-only');
  if (popupFavoritesToggle) popupFavoritesToggle.addEventListener('change', saveSystemSettingsFromControls);
  var systemUserAgentInput = $('#system-user-agent');
  if (systemUserAgentInput) systemUserAgentInput.addEventListener('change', saveSystemSettingsFromControls);
  Object.keys(systemProxyControls).forEach(function (key) {
    var input = $(systemProxyControls[key]);
    if (input) input.addEventListener('input', function () { systemProxyDirty = true; });
  });
  var saveProxyButton = $('#btn-save-system-proxy');
  if (saveProxyButton) saveProxyButton.addEventListener('click', function () { saveSystemSettingsFromControls(true); });
  var refreshProxyButton = $('#btn-refresh-system-proxy-status');
  if (refreshProxyButton) refreshProxyButton.addEventListener('click', function () { refreshSystemProxyStatus(true); });
  if (chrome.proxy && chrome.proxy.settings) {
    lifecycle.subscribe(chrome.proxy.settings.onChange, refreshSystemProxyStatus);
  }
  loadSystemSettings().catch(function (error) {
    toast('系统配置加载失败: ' + (error && error.message || error), true);
  });

  lifecycle.subscribe(chrome.storage.onChanged, function (changes, area) {
    if (area !== 'local' || !changes[globalThis.PageAutomationSystemSettings.SETTINGS_KEY]) return;
    systemSettings = globalThis.PageAutomationSystemSettings.normalize(
      changes[globalThis.PageAutomationSystemSettings.SETTINGS_KEY].newValue
    );
    renderSystemSettings();
  });

  // 导航
  $all('.nav-item').forEach(function (el) {
    if (!el.title) el.title = el.textContent.trim();
    el.addEventListener('click', function () { switchSection(el.dataset.section); });
  });

  function setGlobalSidebarCollapsed(collapsed) {
    var app = $('#app');
    var toggle = $('#btn-toggle-sidebar');
    if (app) app.classList.toggle('global-sidebar-collapsed', !!collapsed);
    if (toggle) {
      toggle.title = collapsed ? '显示侧边栏' : '隐藏侧边栏';
      toggle.setAttribute('aria-label', toggle.title);
    }
    try {
      localStorage.setItem('options_sidebar_collapsed', collapsed ? '1' : '0');
    } catch (_) {}
  }

  setGlobalSidebarCollapsed((function () {
    try { return localStorage.getItem('options_sidebar_collapsed') === '1'; } catch (_) { return false; }
  })());

  var toggleSidebarBtn = $('#btn-toggle-sidebar');
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', function () {
      setGlobalSidebarCollapsed(!$('#app').classList.contains('global-sidebar-collapsed'));
    });
  }

  // 导入导出
  $('#btn-import-flow').addEventListener('click', function () { $('#file-import-flow').click(); });
  $('#file-import-flow').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (file) backupController.readJsonFile(file, importFlowBundle);
    e.target.value = '';
  });
  $('#btn-import-flowGroup').addEventListener('click', function () { $('#file-import-flowGroup').click(); });
  $('#file-import-flowGroup').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (file) backupController.readJsonFile(file, importFlowGroupBundle);
    e.target.value = '';
  });
  $('#btn-export-config').addEventListener('click', function () { backupController.openExportBackupDrawer(); });
  $('#btn-import-config').addEventListener('click', function () { $('#file-import-config').click(); });
  $('#file-import-config').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (file) backupController.readJsonFile(file, backupController.openImportBackupFromRaw);
    e.target.value = '';
  });

  // === MCP Section ===
  var mcpEnabled = false;
  var mcpUrl = 'ws://127.0.0.1:9999';
  var mcpClientId = '';
  var mcpClientName = '';
  var mcpConnection = null;
  var mcpConnections = [];
  var mcpConnectionsHtml = '';
  var mcpLogsHtml = '';
  var mcpEditorOpen = false;
  var mcpCreating = false;
  var mcpPermissionsOpen = false;
  var mcpArpPermissionsDirty = false;
  var mcpArpPermissionsRevision = null;
  var mcpActionDrawer = '';
  var mcpClientNameBeforeEdit = '';
  var mcpSelectedWorkspaceId = '';
  var mcpEditingWorkspace = null;
  var mcpDirectoryPermissions = { read: false, write: false, execute: false };
  var mcpWorkspacesSignature = '';
  var mcpConnectionsSequence = 0;
  var mcpConnectionAttempt = null;
  var mcpConnectionPollTimer = 0;
  var mcpStatusSequence = 0;
  var mcpMutationSequence = 0;
  var mcpDiskSequence = 0;
  var mcpEnvironmentSequence = 0;
  var mcpDiskRefreshing = false;
  var mcpEnvironmentRefreshing = false;
  var mcpDiskInitialPending = false;
  var mcpEnvironmentInitialPending = false;
  var mcpEnvironmentSignature = '';
  var mcpSettingsDirty = false;
  var mcpDesktopDirty = false;
  var mcpDraftRevision = null;
  var mcpSettingsSaving = false;
  var mcpEnabledUpdating = false;
  var mcpLocalDirectoryDirty = false;
  var mcpExtensionDir = '';
  var mcpRunTabMode = 'reuseOpenTab';
  var mcpWsPort = 9999;
  var mcpHttpPort = 9998;
  var mcpBundleRelativePath = 'mcp-server/page-agent-mcp-server.cjs';
  var mcpStatusDot = $('#mcp-status-dot');
  var mcpStatusText = $('#mcp-status-text');
  var mcpSaveSettingsButton = $('#btn-mcp-save-settings');

  function mcpStateLabel(state) {
    return ({ disabled: '已配对 · 已关闭', disconnected: '网络断开', connecting: '连接中', authenticating: '认证中',
      'pairing-required': '需要配对', pairing: '配对中', configuring: '同步目录中', ready: '已就绪', 'auth-failed': '认证失败',
      revoked: '凭据已撤销', 'identity-conflict': '服务端身份冲突', incompatible: '协议不兼容，请同步升级' })[state] || '尚未连接';
  }
  async function mcpControl(type, payload) {
    var response = await chrome.runtime.sendMessage({ type: type, payload: payload });
    if (!response || !response.ok) throw Object.assign(new Error(response && response.error || '操作失败'), {
      code: response && response.code, reason: response && response.reason,
    });
    return response.result;
  }
  async function refreshMcpConnections() {
    var sequence = ++mcpConnectionsSequence;
    var data;
    try {
      data = resourceData(await resourceClient.get('/connections', { query: { limit: 100 } }));
    } catch (error) {
      if (sequence === mcpConnectionsSequence) {
        $('#mcp-connections-status').textContent = '服务端连接加载失败：' + resourceErrorText(error) + '。页面将自动重试。';
        $('#mcp-connections-status').hidden = false;
      }
      throw error;
    }
    if (sequence !== mcpConnectionsSequence) return;
    $('#mcp-connections-status').hidden = true;
    mcpConnections = data.items || [];
    if (!mcpCreating && (!mcpConnection || !mcpConnections.some(function (item) { return item.id === mcpConnection.id; }))) {
      mcpConnection = mcpConnections[0] || null;
      resetMcpEditorDraft();
      setMcpEditorOpen(false);
      clearMcpConnectionPollTimer(); mcpConnectionAttempt = null; mcpStatusSequence += 1;
    }
    renderMcpConnections();
    updateMcpSaveSettingsButton();
    return mcpConnections;
  }
  function renderMcpConnections() {
    var list = $('#mcp-connections-list');
    var focusedCard = document.activeElement.closest('.mcp-connection-card');
    var focusedId = focusedCard && list.contains(focusedCard) ? focusedCard.dataset.id : null;
    var focusedCopy = document.activeElement.matches('[data-action="copy-id"]');
    var html = mcpConnections.map(function (connection) {
      var expanded = mcpEditorOpen && mcpConnection && mcpConnection.id === connection.id;
      var description = connection.url + ' · ' + (connection.platform || '待确认平台');
      var stateLabel = connection.state === 'pairing' ? '配对中'
        : connection.needsPairing ? connection.paired ? (connection.enabled ? '已开启' : '已关闭') + ' · 待重新配对' : '未配对'
          : connection.reason === 'RETRY_LIMIT_REACHED' ? '已开启 · 重试已停止' : mcpStateLabel(connection.state);
      return '<div role="button" tabindex="0" class="item-card connection-card mcp-connection-card' + (expanded ? ' selected' : '')
        + '" data-id="' + esc(connection.id) + '" aria-expanded="' + !!expanded + '" aria-controls="mcp-connection-editor"'
        + (mcpSettingsSaving || mcpEnabledUpdating ? ' aria-disabled="true"' : '') + '>'
        + '<span class="connection-summary"><span class="item-title" title="' + esc(connection.alias || connection.url) + '">' + esc(connection.alias || connection.url) + '</span>'
        + '<span class="item-sub" title="' + esc(description) + '">' + esc(description) + '</span>'
        + itemIdHtml(connection.id) + '</span>'
        + '<span class="badge' + (connection.ready ? ' on' : '') + '" title="' + esc(connection.reason || '') + '">' + esc(stateLabel) + '</span>'
        + '</div>';
    }).join('') || (mcpEditorOpen ? '' : '<div class="placeholder">还没有服务端，点击「新增服务端」配置连接</div>');
    if (html === mcpConnectionsHtml) return;
    mcpConnectionsHtml = html;
    list.innerHTML = html;
    if (focusedId) {
      var focused = Array.from(list.children).find(function (item) { return item.dataset.id === focusedId; });
      if (focused) (focusedCopy ? focused.querySelector('.item-id') : focused).focus({ preventScroll: true });
    }
  }
  function setMcpEditorOpen(open) {
    var restoreFocus = $('#mcp-connection-editor').contains(document.activeElement);
    mcpEditorOpen = open && !!mcpConnection;
    $('#mcp-connection-editor').classList.toggle('hidden', !mcpEditorOpen);
    $('#btn-mcp-add').setAttribute('aria-expanded', String(mcpEditorOpen && mcpCreating));
    if (!mcpEditorOpen && mcpPermissionsOpen) closeDrawer();
    renderMcpConnections();
    if (mcpEditorOpen) scrollOpenedEditor('#mcp-connection-editor');
    if (!mcpEditorOpen && mcpConnection && restoreFocus) {
      var card = Array.from($('#mcp-connections-list').children).find(function (item) { return item.dataset.id === mcpConnection.id; });
      if (card) {
        card.focus({ preventScroll: true });
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }
  function resetMcpEditorDraft() {
    mcpSettingsDirty = false; mcpDesktopDirty = false; mcpDraftRevision = null; mcpLocalDirectoryDirty = false;
    mcpArpPermissionsDirty = false; mcpArpPermissionsRevision = null;
    mcpDiskSequence += 1; mcpEnvironmentSequence += 1;
    mcpDiskRefreshing = false; mcpEnvironmentRefreshing = false;
    mcpDiskInitialPending = mcpPermissionsOpen; mcpEnvironmentInitialPending = mcpPermissionsOpen;
    mcpWorkspacesSignature = '';
    mcpEnvironmentSignature = '';
    resetMcpDirectoryForm();
    $('#mcp-pair-password').value = ''; $('#mcp-disk-workspace').value = ''; $('#mcp-disk-info').textContent = '';
    setMcpInfoStatus('environment', ''); setMcpInfoStatus('disk', '');
  }
  async function confirmMcpEditorChange() {
    if (mcpSettingsSaving || mcpEnabledUpdating) return false;
    return !(mcpSettingsDirty || mcpLocalDirectoryDirty || mcpArpPermissionsDirty)
      || await confirmUnsavedChanges();
  }
  async function collapseMcpEditor() {
    if (!await confirmMcpEditorChange()) return;
    resetMcpEditorDraft();
    if (mcpCreating) {
      mcpCreating = false;
      mcpConnection = mcpConnections[0] || null;
      $('#btn-mcp-add').focus({ preventScroll: true });
    }
    if (mcpConnection) applyMcpConnectionToControls(mcpConnection);
    setMcpEditorOpen(false);
  }
  $('#btn-mcp-cancel-settings').addEventListener('click', collapseMcpEditor);
  function resetMcpDirectoryForm() {
    mcpLocalDirectoryDirty = false;
    mcpEditingWorkspace = null;
    mcpSelectedWorkspaceId = '';
    mcpDirectoryPermissions = { read: false, write: false, execute: false };
    $('#mcp-local-directory-form').reset();
    $('#mcp-local-directory-form').classList.add('hidden');
    $('#btn-mcp-local-directory-add').setAttribute('aria-expanded', 'false');
  }
  function fillMcpDirectoryForm(workspace) {
    mcpEditingWorkspace = workspace ? clonePlain(workspace) : null;
    mcpSelectedWorkspaceId = workspace ? workspace.id : '';
    mcpDirectoryPermissions = workspace ? clonePlain(workspace.permissions) : { read: false, write: false, execute: false };
    var startup = workspace && workspace.kind === 'startup';
    $('#mcp-directory-form-title').textContent = workspace ? '编辑目录 · ' + workspace.alias : '新增目录';
    $('#mcp-local-working-directory').value = workspace ? workspace.path || workspace.resolvedPath || '' : '';
    $('#mcp-local-working-directory').readOnly = !!startup;
    $('#mcp-new-workspace-alias').value = workspace ? workspace.alias : '';
    $('#mcp-new-workspace-alias').readOnly = !!startup;
    $('#mcp-new-workspace-alias').placeholder = workspace ? '留空保留当前别名' : '留空使用目录名称';
    $('#mcp-workspace-read-hint').classList.toggle('hidden', !startup);
    $('#btn-mcp-local-directory-delete').classList.toggle('hidden', !workspace || startup);
    $('#btn-mcp-local-directory-add').setAttribute('aria-expanded', String(!workspace));
  }
  async function openMcpDirectoryForm(workspace) {
    if (!mcpConnection || mcpSettingsSaving || mcpEnabledUpdating) return;
    if (mcpLocalDirectoryDirty && !await confirmUnsavedChanges()) return;
    resetMcpDirectoryForm();
    fillMcpDirectoryForm(workspace);
    $('#mcp-local-directory-form').classList.remove('hidden');
    renderMcpWorkspaceList(mcpConnection);
    updateMcpSaveSettingsButton();
    $('#mcp-local-working-directory').focus({ preventScroll: true });
    $('#mcp-local-directory-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function mcpDirectoryPathChanged() {
    return !!(mcpEditingWorkspace && mcpEditingWorkspace.kind === 'custom'
      && $('#mcp-local-working-directory').value.trim() !== mcpEditingWorkspace.path);
  }
  function updateMcpDirectoryControls() {
    var workspace = mcpEditingWorkspace;
    var pathChanged = mcpDirectoryPathChanged();
    var awaitingPath = !workspace || workspace.needsAuthorization && !workspace.lastResolvedPath;
    $all('#mcp-workspace-controls input').forEach(function (checkbox) {
      var permission = checkbox.dataset.permission;
      checkbox.checked = !pathChanged && mcpDirectoryPermissions[permission];
      checkbox.disabled = !mcpConnection || mcpSettingsSaving || mcpEnabledUpdating || awaitingPath || pathChanged
        || workspace && workspace.kind === 'startup' && permission === 'read';
    });
    $('#mcp-directory-form-hint').textContent = !workspace ? '先保存目录，待服务端确认实际路径后，再设置权限并保存。'
      : pathChanged ? '路径已修改，保存后将关闭原有权限；确认新路径后，请重新授权。'
        : workspace.state === 'invalid' ? '服务端无法访问此目录，请检查路径与服务端文件权限。'
          : awaitingPath ? '请先连接服务端确认实际路径，再设置权限并保存。'
            : workspace.needsAuthorization || workspace.state === 'changed' ? '权限已关闭，请确认实际路径，重新设置权限并保存。'
              : workspace.state === 'unverified' ? '连接服务端后自动确认目录，已保存的权限将在确认后生效。'
                : workspace.kind === 'startup' ? '工作目录的路径和别名由服务端提供，读取权限默认开启。' : '修改路径并保存会关闭该目录的全部权限，需要重新授权。';
  }
  function markMcpDirectoryDirty() {
    var directory = $('#mcp-local-working-directory').value.trim(), alias = $('#mcp-new-workspace-alias').value.trim();
    mcpLocalDirectoryDirty = mcpEditingWorkspace
      ? mcpDirectoryPathChanged() || mcpEditingWorkspace.kind === 'custom' && !!alias && alias !== mcpEditingWorkspace.alias
        || ['read', 'write', 'execute'].some(function (permission) { return mcpDirectoryPermissions[permission] !== mcpEditingWorkspace.permissions[permission]; })
      : !!(directory || alias);
    updateMcpSaveSettingsButton();
  }
  function renderMcpArpPermissions() {
    if (mcpArpPermissionsDirty) return;
    var permissions = globalThis.McpContract.arpPermissions(mcpConnection ? mcpConnection.arpPermissions : undefined);
    $all('#mcp-arp-permission-controls input').forEach(function (checkbox) {
      checkbox.checked = permissions[checkbox.dataset.permission];
    });
    mcpArpPermissionsRevision = mcpConnection && mcpConnection.configRevision;
  }
  $all('#mcp-arp-permission-controls input').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      var permissions = globalThis.McpContract.arpPermissions(mcpConnection ? mcpConnection.arpPermissions : undefined);
      mcpArpPermissionsDirty = Array.from($all('#mcp-arp-permission-controls input')).some(function (input) {
        return input.checked !== permissions[input.dataset.permission];
      });
      if (!mcpArpPermissionsDirty) renderMcpArpPermissions();
      updateMcpSaveSettingsButton();
    });
  });
  $('#mcp-arp-permissions-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!mcpConnection || !mcpArpPermissionsDirty || mcpSettingsSaving || mcpEnabledUpdating) return;
    var permissions = {}, previousRevision = mcpArpPermissionsRevision;
    $all('#mcp-arp-permission-controls input').forEach(function (checkbox) {
      permissions[checkbox.dataset.permission] = checkbox.checked;
    });
    mcpEnabledUpdating = true;
    mcpConnectionsSequence += 1; mcpStatusSequence += 1;
    updateMcpSaveSettingsButton();
    try {
      var updated = resourceData(await resourceClient.authorizedPatch(mcpConnectionUri(mcpConnection.id), { arpPermissions: permissions },
        mcpMutationOptions({ ifMatch: '"mcp-' + previousRevision + '"' })));
      mcpArpPermissionsDirty = false;
      advanceMcpDraftRevision(previousRevision, updated);
      applyMcpConnectionToControls(updated, true);
      toast('远程操作权限已保存');
    } catch (error) { toast(resourceErrorText(error), true); }
    finally { mcpEnabledUpdating = false; updateMcpSaveSettingsButton(); }
  });
  $('#btn-mcp-permissions').addEventListener('click', async function () {
    if (!mcpConnection || mcpSettingsSaving || mcpEnabledUpdating) return;
    if ($('#drawer').classList.contains('active') && !await closeDrawer()) return;
    $('#drawer-title').textContent = '连接权限 · ' + (mcpConnection.alias || mcpConnection.url);
    $('#drawer-content').replaceChildren($('#mcp-permissions-content'));
    $('#drawer-actions').innerHTML = '<button type="button" class="btn-secondary" data-action="cancel-drawer">关闭</button>';
    mcpPermissionsOpen = true;
    mcpDiskInitialPending = true; mcpEnvironmentInitialPending = true;
    $('#btn-mcp-permissions').setAttribute('aria-expanded', 'true');
    renderMcpArpPermissions();
    renderMcpWorkspaces(mcpConnection);
    updateMcpSaveSettingsButton();
    openDrawer();
    $('#drawer-content').scrollTop = 0;
    $('#btn-mcp-local-directory-add').focus({ preventScroll: true });
  });
  $('#btn-mcp-local-directory-add').addEventListener('click', function () {
    openMcpDirectoryForm();
  });
  $('#btn-mcp-local-directory-cancel').addEventListener('click', function () {
    var workspace = mcpEditingWorkspace;
    resetMcpDirectoryForm();
    renderMcpWorkspaceList(mcpConnection);
    updateMcpSaveSettingsButton();
    focusMcpDirectoryAction(workspace);
  });
  function focusMcpDirectoryAction(workspace) {
    var button = workspace && Array.from($('#mcp-workspace-list').querySelectorAll('.mcp-workspace-card')).find(function (element) {
      return element.dataset.workspaceId === workspace.id;
    });
    (button || $('#btn-mcp-local-directory-add')).focus({ preventScroll: true });
  }
  $('#mcp-workspace-list').addEventListener('click', function (event) {
    var card = event.target.closest('.mcp-workspace-card');
    if (!card || !mcpConnection || mcpSettingsSaving || mcpEnabledUpdating) return;
    if (mcpSelectedWorkspaceId === card.dataset.workspaceId) {
      $('#mcp-local-directory-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    var workspace = (mcpConnection.workspaces || []).find(function (item) { return item.id === card.dataset.workspaceId; });
    if (workspace) openMcpDirectoryForm(workspace);
  });
  function renderMcpDescription(container, paragraphs) {
    container.replaceChildren();
    paragraphs.forEach(function (parts) {
      var paragraph = document.createElement('p');
      parts.forEach(function (part) {
        if (!part.strong) {
          paragraph.appendChild(document.createTextNode(part.text));
          return;
        }
        var value = document.createElement('strong');
        value.textContent = part.text;
        paragraph.appendChild(value);
      });
      container.appendChild(paragraph);
    });
  }
  function renderMcpEnvironment(connection, result) {
    var environment = result ? result.environment : connection.environment;
    var memory = result ? result.memory : connection.observations && connection.observations.memory;
    var capabilities = connection.capabilities || {};
    var signature = JSON.stringify([connection.id, connection.ready, environment, memory, capabilities.execution, capabilities.audit]);
    if (signature === mcpEnvironmentSignature) return;
    mcpEnvironmentSignature = signature;
    renderMcpDescription($('#mcp-environment-info'), ServerInfoDescription.environment(connection, result));
  }
  function renderMcpDisk(result) {
    renderMcpDescription($('#mcp-disk-info'), ServerInfoDescription.disk(result.disk));
  }
  function mcpInfoReady(connection) {
    return !!(connection && connection.ready && connection.capabilities && connection.capabilities.audit
      && connection.capabilities.audit.available);
  }
  function updateMcpInfoActions() {
    var ready = mcpInfoReady(mcpConnection), busy = mcpEnvironmentRefreshing || mcpDiskRefreshing;
    var button = $('#btn-mcp-refresh-info');
    button.disabled = !ready || busy || mcpSettingsSaving || mcpEnabledUpdating;
    button.textContent = busy ? '获取中…' : '刷新信息';
    var select = $('#mcp-disk-workspace');
    select.disabled = !ready || !select.value || mcpSettingsSaving || mcpEnabledUpdating;
    $('#mcp-environment-info').setAttribute('aria-busy', String(mcpEnvironmentRefreshing));
    $('#mcp-disk-info').setAttribute('aria-busy', String(mcpDiskRefreshing));
    if (!ready) setMcpInfoStatus('environment', (mcpConnection && mcpConnection.ready
      ? '服务端审计暂不可用，' : '连接未就绪，')
      + (mcpEnvironmentInitialPending ? '恢复后自动加载。' : '恢复后可刷新。'));
    else if (!mcpEnvironmentRefreshing && !$('#mcp-environment-status').classList.contains('is-error')) {
      setMcpInfoStatus('environment', '');
    }
  }
  function setMcpInfoStatus(kind, message, error) {
    var status = $('#mcp-' + kind + '-status');
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('is-error', !!error);
  }
  function renderMcpDiskTargets(connection) {
    var select = $('#mcp-disk-workspace'), selectedId = select.value;
    var selectedOption = select.selectedOptions[0], selectedPath = selectedOption && selectedOption.dataset.path;
    var capabilities = connection.capabilities || {}, supported = capabilities.environment && capabilities.environment.disk;
    var workspaces = mcpInfoReady(connection) && supported ? (connection.workspaces || []).filter(function (workspace) {
      return workspace.state === 'ready' && workspace.resolvedPath
        && Object.values(workspace.effectivePermissions || {}).some(Boolean);
    }) : [];
    var selected = workspaces.find(function (workspace) { return workspace.id === selectedId; });
    var revision = String(connection.acceptedRevision || '');
    if (selectedId && (!selected || selected.resolvedPath !== selectedPath || select.dataset.revision !== revision)) {
      mcpDiskSequence += 1; mcpDiskRefreshing = false;
      $('#mcp-disk-info').textContent = ''; setMcpInfoStatus('disk', '');
    }
    var signature = JSON.stringify(workspaces.map(function (workspace) { return [workspace.id, workspace.alias, workspace.resolvedPath]; }));
    if (select.dataset.options !== signature) {
      var options = [];
      if (!workspaces.length) {
        var placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '暂无可用目录';
        options.push(placeholder);
      }
      workspaces.forEach(function (workspace) {
        var option = document.createElement('option'); option.value = workspace.id; option.dataset.path = workspace.resolvedPath;
        option.textContent = workspace.alias; option.title = workspace.resolvedPath; options.push(option);
      });
      select.replaceChildren(...options); select.dataset.options = signature;
    }
    var defaultWorkspace = workspaces.find(function (workspace) { return workspace.kind === 'startup'; }) || workspaces[0];
    var nextSelectedId = selected && selected.resolvedPath === selectedPath ? selectedId : defaultWorkspace ? defaultWorkspace.id : '';
    if (select.value !== nextSelectedId) select.value = nextSelectedId;
    select.dataset.revision = revision; select.disabled = !workspaces.length;
    if (nextSelectedId && !mcpDiskInitialPending && !mcpDiskRefreshing && !$('#mcp-disk-info').hasChildNodes()
      && !$('#mcp-disk-status').classList.contains('is-error')) {
      setMcpInfoStatus('disk', '点击「刷新信息」获取所选目录的磁盘信息。');
    }
    $('#mcp-disk-hint').textContent = !connection.ready ? '请先连接服务端并授权目录。'
      : !mcpInfoReady(connection) ? '服务端审计不可用，无法采样。'
        : !supported ? '服务端不支持磁盘空间采样。'
          : !workspaces.length ? '请先为至少一个已确认目录授予权限。' : '';
    updateMcpInfoActions();
  }
  function renderMcpWorkspaces(connection) {
    renderMcpWorkspaceList(connection);
    renderMcpEnvironment(connection);
    renderMcpDiskTargets(connection);
    if (!mcpInfoReady(connection)) {
      mcpEnvironmentSequence += 1; mcpEnvironmentRefreshing = false;
      updateMcpInfoActions();
    }
    if (mcpPermissionsOpen) {
      if (mcpEnvironmentInitialPending) refreshMcpEnvironment(false);
      if (mcpDiskInitialPending) refreshMcpDisk(false);
    }
  }
  function renderMcpWorkspaceList(connection) {
    var workspaces = connection.workspaces || [];
    var selectedWorkspace = workspaces.find(function (workspace) { return workspace.id === mcpSelectedWorkspaceId; });
    if (mcpSelectedWorkspaceId && !selectedWorkspace) {
      resetMcpDirectoryForm();
    } else if (selectedWorkspace && !mcpLocalDirectoryDirty && JSON.stringify(selectedWorkspace) !== JSON.stringify(mcpEditingWorkspace)) {
      fillMcpDirectoryForm(selectedWorkspace);
    }
    var directoryFormOpen = !$('#mcp-local-directory-form').classList.contains('hidden');
    var signature = JSON.stringify([connection.id, workspaces, mcpSelectedWorkspaceId, directoryFormOpen]);
    if (signature === mcpWorkspacesSignature) return;
    mcpWorkspacesSignature = signature;
    var list = $('#mcp-workspace-list');
    var focused = list.contains(document.activeElement) ? document.activeElement : null;
    var focusedCard = focused && focused.closest('.mcp-workspace-card');
    var focusedId = focusedCard && focusedCard.dataset.workspaceId;
    var focusedCopy = focused && focused.matches('[data-action="copy-id"]');
    list.replaceChildren();
    if (!workspaces.length && !directoryFormOpen) list.innerHTML = '<div class="placeholder">暂无目录，点击「新增目录」添加</div>';
    workspaces.forEach(function (workspace) {
      var selected = workspace.id === mcpSelectedWorkspaceId;
      var card = document.createElement('div'); card.setAttribute('role', 'button'); card.tabIndex = 0;
      card.className = 'item-card connection-card mcp-workspace-card' + (selected ? ' selected' : '');
      card.dataset.workspaceId = workspace.id;
      card.setAttribute('aria-expanded', String(selected)); card.setAttribute('aria-controls', 'mcp-local-directory-form');
      var summary = document.createElement('span'); summary.className = 'connection-summary';
      var title = document.createElement('span'); title.className = 'item-title'; title.textContent = workspace.alias; title.title = workspace.alias;
      var path = document.createElement('span'); path.className = 'item-sub';
      path.textContent = workspace.resolvedPath || workspace.path || '待服务端确认'; path.title = path.textContent;
      summary.append(title, path);
      summary.insertAdjacentHTML('beforeend', itemIdHtml(workspace.id));
      var state = workspace.needsAuthorization && workspace.state !== 'invalid' ? '待授权'
        : ({ ready: '已确认', invalid: '目录无效', changed: '待授权', unverified: '待确认' })[workspace.state] || '待确认';
      var badge = document.createElement('span');
      badge.className = 'badge' + (workspace.state === 'invalid' ? ' status-failed' : state === '已确认' ? ' on' : '');
      badge.textContent = state;
      card.append(summary, badge); list.appendChild(card);
    });
    if (focusedId) {
      var replacement = Array.from(list.children).find(function (item) { return item.dataset.workspaceId === focusedId; });
      if (replacement) (focusedCopy ? replacement.querySelector('.item-id') : replacement).focus({ preventScroll: true });
      else focusMcpDirectoryAction();
    }
  }
  $('#btn-mcp-local-directory-delete').addEventListener('click', async function () {
    var workspace = mcpEditingWorkspace;
    if (!workspace || workspace.kind !== 'custom' || mcpSettingsSaving || mcpEnabledUpdating) return;
    if (!await confirmSettingsAction('删除此目录配置并取消其请求；不会删除磁盘文件。', '删除目录配置', '删除')) return;
    if (!mcpEditingWorkspace || mcpEditingWorkspace.id !== workspace.id
      || mcpEditingWorkspace.connectionId !== workspace.connectionId || mcpSettingsSaving || mcpEnabledUpdating) return;
    var uri = mcpConnectionUri(workspace.connectionId) + '/workspaces/' + resourceSegment(workspace.id);
    var precondition = mcpMutationOptions({ ifMatch: '"mcp-' + workspace.configRevision + '"' });
    mcpEnabledUpdating = true;
    updateMcpSaveSettingsButton();
    try {
      await resourceClient.authorizedDelete(uri, precondition);
      resetMcpDirectoryForm();
      renderMcpWorkspaceList(mcpConnection);
      var updated = await updateMCPStatus();
      advanceMcpDraftRevision(workspace.configRevision, updated);
    } catch (error) { toast(resourceErrorText(error), true); }
    finally {
      mcpEnabledUpdating = false;
      updateMcpSaveSettingsButton();
      if ($('#mcp-local-directory-form').classList.contains('hidden')) focusMcpDirectoryAction();
    }
  });
  $('#mcp-connections-list').addEventListener('click', async function (event) {
    var card = event.target.closest('.mcp-connection-card');
    if (!card || mcpSettingsSaving || mcpEnabledUpdating) return;
    if (mcpEditorOpen && mcpConnection && mcpConnection.id === card.dataset.id) { collapseMcpEditor(); return; }
    if (!await confirmMcpEditorChange()) return;
    var connection = mcpConnections.find(function (item) { return item.id === card.dataset.id; });
    if (!connection) return;
    resetMcpEditorDraft();
    mcpCreating = false;
    applyMcpConnectionToControls(connection);
    setMcpEditorOpen(true);
    renderMcpLogs([]);
    clearMcpConnectionPollTimer(); mcpConnectionAttempt = null;
    renderMcpConnectionStatus(); updateMCPStatus();
  });
  $('#btn-mcp-add').addEventListener('click', async function () {
    if (!await confirmMcpEditorChange()) return;
    resetMcpEditorDraft(); clearMcpConnectionPollTimer(); mcpConnectionAttempt = null;
    mcpConnectionsSequence += 1; mcpStatusSequence += 1;
    mcpCreating = true;
    applyMcpConnectionToControls({ url: 'ws://127.0.0.1:9999', enabled: false, clientId: mcpClientId, clientName: mcpClientName });
    setMcpEditorOpen(true);
    renderMcpLogs([]); renderMcpConnectionStatus();
    $('#mcp-alias').focus({ preventScroll: true });
  });
  $('#btn-mcp-delete').addEventListener('click', async function () {
    if (!mcpConnection || mcpSettingsSaving || mcpEnabledUpdating) return;
    var connectionId = mcpConnection.id;
    if (!await confirmSettingsAction('删除此连接及其凭据并取消请求。服务端配对仍保留，需要在服务端手动撤销。', '删除连接', '删除')) return;
    if (!mcpConnection || mcpConnection.id !== connectionId || mcpSettingsSaving || mcpEnabledUpdating) return;
    mcpSettingsSaving = true; mcpConnectionsSequence += 1; mcpStatusSequence += 1; updateMcpSaveSettingsButton();
    try {
      var uri = mcpConnectionUri(mcpConnection.id); await resourceClient.get(uri);
      await resourceClient.authorizedDelete(uri, mcpMutationOptions({ ifMatch: 'cached' }));
      resetMcpEditorDraft(); setMcpEditorOpen(false);
      clearMcpConnectionPollTimer(); mcpConnectionAttempt = null; mcpStatusSequence += 1;
      mcpConnection = null; await refreshMcpConnections(); if (mcpConnection) await updateMCPStatus();
    } catch (error) { toast(resourceErrorText(error), true); }
    finally { mcpSettingsSaving = false; updateMcpSaveSettingsButton(); }
  });
  async function openMcpActionDrawer(kind) {
    if (mcpSettingsSaving || mcpEnabledUpdating) return;
    if ($('#drawer').classList.contains('active') && !await closeDrawer()) return;
    var clientSettings = kind === 'client';
    $('#drawer-title').textContent = clientSettings ? '客户端设置（所有连接共用）' : '配对服务端';
    $('#drawer-content').replaceChildren($(clientSettings ? '#mcp-client-settings-form' : '#mcp-pair-form'));
    $('#drawer-actions').replaceChildren($(clientSettings ? '#mcp-client-settings-actions' : '#mcp-pair-actions'));
    mcpActionDrawer = kind;
    $(clientSettings ? '#btn-mcp-client-settings' : '#btn-mcp-pair').setAttribute('aria-expanded', 'true');
    openDrawer();
    $(clientSettings ? '#mcp-client-name' : '#mcp-pair-password').focus({ preventScroll: true });
  }
  async function readMcpClientSettings() {
    // The connection endpoint waits for packaged names and connections to load.
    resourceData(await resourceClient.get('/connections', { query: { limit: 1 } }));
    var key = chrome.extension.inIncognitoContext ? 'mcp_connections_v2_incognito' : 'mcp_connections_v2';
    var stored = await chrome.storage.local.get(key);
    var settings = stored[key] || {};
    mcpClientName = typeof settings.clientName === 'string' ? settings.clientName : 'Page Agent';
    mcpClientId = settings.clientId || '';
    renderMcpIdentity();
    updateMcpConfigSnippets();
  }
  $('#btn-mcp-client-settings').addEventListener('click', async function () {
    if (mcpSettingsSaving || mcpEnabledUpdating) return;
    mcpEnabledUpdating = true; updateMcpSaveSettingsButton();
    var loaded = false;
    try {
      await readMcpClientSettings();
      mcpClientNameBeforeEdit = mcpClientName;
      $('#mcp-client-name').value = mcpClientName;
      loaded = true;
    } catch (error) { toast(resourceErrorText(error), true); }
    finally { mcpEnabledUpdating = false; updateMcpSaveSettingsButton(); }
    if (loaded) openMcpActionDrawer('client');
  });
  $('#mcp-client-settings-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (mcpActionDrawer !== 'client' || mcpSettingsSaving || mcpEnabledUpdating) return;
    var name = $('#mcp-client-name').value.trim(), saved = false;
    mcpEnabledUpdating = true; mcpStatusSequence += 1; updateMcpSaveSettingsButton();
    try {
      await mcpControl('MCP_CLIENT_UPDATE_NAME', { clientName: name });
      mcpClientName = name; mcpClientNameBeforeEdit = name; saved = true;
      await refreshMcpConnections();
      if (mcpConnection) await updateMCPStatus();
      renderMcpIdentity();
      toast('客户端名称已保存，所有连接共用');
    } catch (error) { toast(resourceErrorText(error), true); }
    finally { mcpEnabledUpdating = false; updateMcpSaveSettingsButton(); }
    if (saved) closeDrawer();
  });
  $('#btn-mcp-pair').addEventListener('click', function () {
    if (!mcpConnection || mcpSettingsSaving || mcpEnabledUpdating) return;
    if (mcpSettingsDirty || mcpLocalDirectoryDirty || mcpArpPermissionsDirty) { toast('请先保存连接和权限设置，再配对', true); return; }
    $('#mcp-pair-target').value = (mcpConnection.alias || '服务端') + ' · ' + mcpConnection.url;
    $('#mcp-pair-form').dataset.connectionId = mcpConnection.id;
    $('#mcp-pair-form').dataset.ifMatch = '"mcp-' + mcpConnection.configRevision + '"';
    $('#mcp-pair-password').value = '';
    openMcpActionDrawer('pair');
  });
  $('#mcp-pair-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!mcpConnection || mcpActionDrawer !== 'pair' || mcpSettingsSaving || mcpEnabledUpdating) return;
    if ($('#mcp-pair-form').dataset.connectionId !== mcpConnection.id) { toast('连接已变化，请重新打开配对', true); return; }
    if (mcpSettingsDirty || mcpLocalDirectoryDirty || mcpArpPermissionsDirty) { toast('请先保存连接和权限设置，再配对', true); return; }
    var password = $('#mcp-pair-password').value; $('#mcp-pair-password').value = '';
    if (!password) { toast('请输入配对密码', true); return; }
    var paired = false;
    mcpEnabledUpdating = true; mcpConnectionsSequence += 1; mcpStatusSequence += 1;
    mcpConnection.state = 'pairing';
    clearMcpConnectionPollTimer(); mcpConnectionAttempt = null; updateMcpSaveSettingsButton();
    renderMcpConnections(); renderMcpConnectionStatus();
    try {
      await mcpControl('MCP_CONNECTION_PAIR', {
        connectionId: mcpConnection.id, password: password, ifMatch: $('#mcp-pair-form').dataset.ifMatch,
      });
      paired = true;
    } catch (error) { toast(error.message, true); }
    finally { password = ''; await updateMCPStatus(); mcpEnabledUpdating = false; updateMcpSaveSettingsButton(); }
    if (paired) {
      await closeDrawer();
      toast(mcpConnection.enabled ? '配对完成，密钥已更新；将自动连接' : '配对完成，连接保持关闭；可打开开关连接');
      if (!mcpConnection.enabled) $('#mcp-enabled').focus({ preventScroll: true });
    }
  });
  $('#btn-mcp-reset-id').addEventListener('click', async function () {
    if (mcpSettingsSaving || mcpEnabledUpdating) return;
    var scope = chrome.extension.inIncognitoContext ? '隐私' : '普通';
    if (!await confirmSettingsAction('重置客户端身份会断开当前' + scope + '浏览环境的所有 MCP 连接，并清除它们的本机凭据。目录配置保留，全部连接需要重新配对，服务端旧配对需另行撤销。确认生成？', '重新生成客户端身份', '重新生成')) return;
    if (mcpSettingsSaving || mcpEnabledUpdating) return;
    mcpEnabledUpdating = true; mcpStatusSequence += 1; updateMcpSaveSettingsButton();
    try {
      await mcpControl('MCP_CLIENT_RESET_ID', {});
      await readMcpClientSettings();
      await refreshMcpConnections();
      if (mcpConnection) await updateMCPStatus();
      toast('客户端身份已更新，所有连接需要重新配对');
    } catch (error) { toast(error.message, true); }
    finally { mcpEnabledUpdating = false; updateMcpSaveSettingsButton(); }
  });
  $('#mcp-disk-workspace').addEventListener('change', function () {
    mcpDiskInitialPending = false;
    mcpDiskSequence += 1; mcpDiskRefreshing = false;
    $('#mcp-disk-info').textContent = '';
    setMcpInfoStatus('disk', '点击「刷新信息」获取所选目录的磁盘信息。');
    updateMcpInfoActions();
  });
  async function refreshMcpDisk(force) {
    if (!mcpPermissionsOpen || !mcpInfoReady(mcpConnection) || mcpDiskRefreshing || mcpSettingsSaving || mcpEnabledUpdating) return;
    var connectionId = mcpConnection.id, workspaceId = $('#mcp-disk-workspace').value;
    var workspace = (mcpConnection.workspaces || []).find(function (item) { return item.id === workspaceId; });
    if (!workspace || $('#mcp-disk-workspace').disabled) return;
    mcpDiskInitialPending = false;
    var sequence = ++mcpDiskSequence;
    mcpDiskRefreshing = true;
    setMcpInfoStatus('disk', '正在获取磁盘空间…'); updateMcpInfoActions();
    try {
      var uri = '/local/connections/' + resourceSegment(connectionId) + '/workspaces/' + resourceSegment(workspaceId) + '/disk' + (force ? '?refresh=true' : '');
      var result = resourceData(await resourceClient.get(uri));
      if (sequence === mcpDiskSequence && mcpConnection && mcpConnection.id === connectionId) {
        renderMcpDisk(result);
        setMcpInfoStatus('disk', result.disk.status === 'unavailable' ? '暂时无法读取磁盘空间，可点击「刷新信息」重试。'
          : '', result.disk.status === 'unavailable');
      }
    } catch (error) {
      if (sequence === mcpDiskSequence && mcpConnection && mcpConnection.id === connectionId) {
        setMcpInfoStatus('disk', '获取失败：' + resourceErrorText(error) + '。可点击「刷新信息」重试。'
          + ($('#mcp-disk-info').hasChildNodes() ? '下方保留上次结果。' : ''), true);
      }
    } finally {
      if (sequence === mcpDiskSequence) { mcpDiskRefreshing = false; updateMcpInfoActions(); }
    }
  }
  async function refreshMcpEnvironment(force) {
    if (!mcpPermissionsOpen || !mcpInfoReady(mcpConnection) || mcpEnvironmentRefreshing || mcpSettingsSaving || mcpEnabledUpdating) return;
    mcpEnvironmentInitialPending = false;
    var connectionId = mcpConnection.id, sequence = ++mcpEnvironmentSequence;
    mcpEnvironmentRefreshing = true;
    setMcpInfoStatus('environment', '正在获取运行环境…'); updateMcpInfoActions();
    try {
      var environment = resourceData(await resourceClient.get('/local/connections/' + resourceSegment(connectionId) + '/environment' + (force ? '?refresh=true' : '')));
      if (sequence === mcpEnvironmentSequence && mcpConnection && mcpConnection.id === connectionId) {
        renderMcpEnvironment(mcpConnection, environment);
        setMcpInfoStatus('environment', '');
      }
    } catch (error) {
      if (sequence === mcpEnvironmentSequence && mcpConnection && mcpConnection.id === connectionId) {
        setMcpInfoStatus('environment', '获取失败：' + resourceErrorText(error) + '。可点击「刷新信息」重试。'
          + (mcpConnection.environment ? '下方保留上次结果。' : ''), true);
      }
    } finally {
      if (sequence === mcpEnvironmentSequence) { mcpEnvironmentRefreshing = false; updateMcpInfoActions(); }
    }
  }
  $('#btn-mcp-refresh-info').addEventListener('click', function () {
    refreshMcpEnvironment(true);
    refreshMcpDisk(true);
  });
  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === 'MCP_CONNECTIONS_CHANGED' && currentSection === 'mcp' && !mcpSettingsSaving && !mcpEnabledUpdating) {
      refreshMcpConnections().then(function (connections) { if (connections && mcpConnection) return updateMCPStatus(); }).catch(function () {});
    }
  });

  function updateMcpSaveSettingsButton() {
    var desktop = mcpConnection && mcpConnection.capabilities && mcpConnection.capabilities.desktop;
    var hasConnection = !!(mcpConnection && mcpConnection.id);
    var paired = hasConnection && mcpConnection.paired === true;
    var needsPairing = hasConnection && mcpConnection.needsPairing === true;
    var isPairing = hasConnection && mcpConnection.state === 'pairing';
    $('#btn-mcp-add').disabled = mcpSettingsSaving || mcpEnabledUpdating;
    $('#btn-mcp-add').setAttribute('aria-expanded', String(mcpEditorOpen && mcpCreating));
    $('#btn-mcp-cancel-settings').disabled = mcpSettingsSaving || mcpEnabledUpdating;
    $('#btn-mcp-delete').disabled = !hasConnection || mcpSettingsSaving || mcpEnabledUpdating;
    $('#mcp-connections-list').querySelectorAll('.mcp-connection-card').forEach(function (card) {
      card.setAttribute('aria-disabled', String(mcpSettingsSaving || mcpEnabledUpdating));
    });
    $('#btn-mcp-clear-logs').disabled = !hasConnection || mcpSettingsSaving || mcpEnabledUpdating;
    ['#btn-mcp-pair', '#btn-mcp-confirm-pair', '#mcp-pair-password'].forEach(function (selector) {
      $(selector).disabled = !hasConnection || isPairing || mcpSettingsSaving || mcpEnabledUpdating;
    });
    $('#btn-mcp-pair').textContent = isPairing ? '配对中…' : paired ? '重新配对' : '配对服务端';
    $('#btn-mcp-pair').classList.toggle('btn-primary', !paired || needsPairing);
    $('#btn-mcp-pair').classList.toggle('btn-secondary', paired && !needsPairing);
    $('#btn-mcp-confirm-pair').textContent = isPairing ? '配对中…' : '确认配对';
    $('#btn-mcp-reconnect').disabled = !hasConnection || needsPairing || !mcpConnection.enabled || isPairing || mcpSettingsSaving || mcpEnabledUpdating;
    ['#btn-mcp-client-settings', '#btn-mcp-client-save', '#btn-mcp-reset-id', '#mcp-client-name'].forEach(function (selector) {
      $(selector).disabled = mcpSettingsSaving || mcpEnabledUpdating;
    });
    $all('.mcp-action-buttons [data-action="cancel-drawer"]').forEach(function (button) {
      button.disabled = mcpSettingsSaving || mcpEnabledUpdating;
    });
    $('#mcp-enabled').disabled = !hasConnection || (!paired && !mcpConnection.enabled) || isPairing || mcpSettingsSaving || mcpEnabledUpdating;
    $('#mcp-local-tools-enabled').disabled = !desktop || desktop.supported !== true || mcpSettingsSaving || mcpEnabledUpdating;
    $all('#mcp-arp-permission-controls input').forEach(function (checkbox) {
      checkbox.disabled = !hasConnection || mcpSettingsSaving || mcpEnabledUpdating;
    });
    $('#btn-mcp-arp-permissions-save').disabled = !hasConnection || !mcpArpPermissionsDirty || mcpSettingsSaving || mcpEnabledUpdating;
    $('#mcp-local-working-directory').disabled = mcpSettingsSaving || mcpEnabledUpdating;
    $('#mcp-new-workspace-alias').disabled = mcpSettingsSaving || mcpEnabledUpdating;
    $('#btn-mcp-local-directory-save').disabled = !mcpConnection || !mcpLocalDirectoryDirty
      || !(mcpEditingWorkspace && mcpEditingWorkspace.kind === 'startup') && !$('#mcp-local-working-directory').value.trim()
      || mcpSettingsSaving || mcpEnabledUpdating;
    ['#btn-mcp-permissions', '#btn-mcp-local-directory-add', '#btn-mcp-local-directory-cancel', '#btn-mcp-local-directory-delete'].forEach(function (selector) {
      $(selector).disabled = !hasConnection || mcpSettingsSaving || mcpEnabledUpdating;
    });
    $all('#mcp-workspace-list .mcp-workspace-card').forEach(function (card) {
      card.setAttribute('aria-disabled', String(!mcpConnection || mcpSettingsSaving || mcpEnabledUpdating));
    });
    updateMcpDirectoryControls();
    ['#mcp-url', '#mcp-alias', '#mcp-run-tab-mode'].forEach(function (selector) {
      $(selector).disabled = !mcpConnection || mcpSettingsSaving || mcpEnabledUpdating;
    });
    mcpSaveSettingsButton.disabled = !mcpConnection || mcpSettingsSaving || mcpEnabledUpdating;
    mcpSaveSettingsButton.textContent = mcpSettingsSaving ? '保存中...' : '保存';
    updateMcpInfoActions();
  }

  function markMcpSettingsDirty() {
    if (!mcpSettingsDirty) mcpDraftRevision = mcpConnection && mcpConnection.configRevision;
    mcpSettingsDirty = true;
    updateMcpSaveSettingsButton();
  }
  function advanceMcpDraftRevision(previousRevision, connection) {
    if (connection && mcpSettingsDirty && mcpDraftRevision === previousRevision) mcpDraftRevision = connection.configRevision;
    if (connection && mcpArpPermissionsRevision === previousRevision) mcpArpPermissionsRevision = connection.configRevision;
    if (connection && mcpEditingWorkspace && mcpEditingWorkspace.configRevision === previousRevision) {
      mcpEditingWorkspace.configRevision = connection.configRevision;
    }
  }

  function joinMcpPath(baseDir, relativePath) {
    var base = String(baseDir || '').trim();
    if (!base) return '/path/to/page-agent-extension/' + relativePath;
    var separator = base.indexOf('\\') >= 0 ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + separator + relativePath.split('/').join(separator);
  }

  function joinMcpBundlePath(baseDir) {
    return joinMcpPath(baseDir, mcpBundleRelativePath);
  }

  function quoteCliPath(path) {
    return '"' + String(path || '').replace(/"/g, '\\"') + '"';
  }

  function buildMcpPortArgs() {
    return '--ws-port ' + Number(mcpWsPort || 9999) + ' --http-port ' + Number(mcpHttpPort || 9998);
  }

  function buildMcpStartCommand() {
    return '# 先在终端切换到希望使用的工作目录；需要 Node >=22.16.0\n'
      + '# 认证、审计及状态默认保存在当前工作目录的 ./data\nnode '
      + quoteCliPath(joinMcpBundlePath(mcpExtensionDir)) + ' ' + buildMcpPortArgs();
  }

  function buildCherryStudioConfig() {
    return JSON.stringify({
      mcpServers: {
        'page-agent': {
          type: 'streamableHttp',
          url: 'http://127.0.0.1:' + mcpHttpPort + '/mcp',
          headers: { Authorization: 'Bearer <HTTP令牌>' }
        }
      }
    }, null, 2);
  }

  function buildGenericMcpUsagePrompt() {
    return [
      '请使用已配置的 page-agent MCP 完成我提出的任务，并按以下方式选择能力：',
      '1. 先调用 OPTIONS，参数 {"uri":"/"}，发现服务端资源。',
      '2. 操作服务端本地文件、命令或桌面时，先 GET /local 查看工作目录和能力，沿返回链接调用；无需选择插件。先用 OPTIONS 查询具体操作的参数。',
      '3. 操作浏览器时，先 GET /clients，按名称和 ID 选择已就绪的目标，再调用 POST，参数为 {"uri":"/clients/{clientId}/arp","body":{"method":"GET","request":{"uri":"/page/current"}}}，将 {clientId} 替换为查询到的 ID。',
      '4. 发现目标插件能力时，将内层 method 改为 OPTIONS、request.uri 改为 /。后续页面请求和响应链接仍通过同一客户端转发，不自动换目标。',
      '5. 外部调用不创建或启动 Flow、脚本、对话、定时任务或应用动作；这些任务在扩展内管理。',
      '6. 断线、取消或结果未知时，先核对实际效果，不自动重试有副作用的操作。'
    ].join('\n');
  }

  function buildMcpClientGuide() {
    return [
      '名称: page-agent',
      '传输方式: Streamable HTTP',
      'URL: http://127.0.0.1:' + mcpHttpPort + '/mcp',
      '请求头 Authorization: Bearer <HTTP令牌>'
    ].join('\n');
  }

  function updateMcpConfigSnippets() {
    $('#mcp-start-command').textContent = buildMcpStartCommand();
    $('#mcp-cherry-config').textContent = buildCherryStudioConfig();
    $('#mcp-client-guide').textContent = buildMcpClientGuide();
    $('#mcp-usage-prompt').textContent = buildGenericMcpUsagePrompt();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand('copy')) resolve();
        else reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      } finally {
        ta.remove();
      }
    });
  }

  function mcpConnectionUri(connectionId) {
    return '/connections/' + resourceSegment(connectionId);
  }

  function mcpConnectionLogsUri(connectionId) {
    return mcpConnectionUri(connectionId) + '/logs';
  }

  function mcpIdempotencyKey(prefix) {
    mcpMutationSequence += 1;
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return (prefix || 'mcp_connection') + '_' + globalThis.crypto.randomUUID();
    }
    return (prefix || 'mcp_connection') + '_' + Date.now().toString(36) + '_' + mcpMutationSequence.toString(36)
      + '_' + Math.random().toString(36).slice(2, 10);
  }

  function mcpMutationOptions(extra) {
    return Object.assign({
      idempotencyKey: mcpIdempotencyKey('mcp_connection'),
    }, extra || {});
  }

  function readMcpConnection() {
    if (mcpConnection && mcpConnection.id) {
      return resourceClient.get(mcpConnectionUri(mcpConnection.id)).then(function (envelope) {
        var current = resourceData(envelope);
        if (!current) throw new Error('MCP 连接返回了无效数据');
        return current;
      });
    }
    return resourceClient.get('/connections', { query: { limit: 100 } }).then(function (envelope) {
      var collection = resourceData(envelope) || {};
      var items = Array.isArray(collection.items) ? collection.items : [];
      if (!items.length || !items[0].id) { mcpConnection = null; updateMcpSaveSettingsButton(); throw new Error('尚无连接，请新增服务端'); }
      return resourceClient.get(mcpConnectionUri(items[0].id));
    }).then(function (envelope) {
      var current = resourceData(envelope);
      if (!current) throw new Error('MCP 连接返回了无效数据');
      return current;
    });
  }

  function readMcpConnectionLogs(connectionId) {
    return resourceClient.get(mcpConnectionLogsUri(connectionId)).then(function (envelope) {
      var data = resourceData(envelope) || {};
      return Array.isArray(data.items) ? data.items : [];
    });
  }

  function renderMcpIdentity() {
    var connection = mcpConnection || {};
    [
      ['mcp-log-client-name', mcpClientName, '未设置'],
      ['mcp-log-client-id', mcpClientId, '尚未生成'],
      ['mcp-log-server-name', connection.serverName, connection.connected ? '未提供名称' : '待连接'],
      ['mcp-log-server-id', connection.serverId, '尚未配对'],
    ].forEach(function (item) {
      var button = $('#' + item[0]);
      var text = item[1] || item[2];
      if (button.textContent !== text) button.textContent = text;
      button.dataset.copyValue = item[1] || '';
      button.title = item[1] || '';
      button.disabled = !item[1];
    });
    var clientId = mcpClientId || '尚未生成';
    if ($('#mcp-client-id').value !== clientId) $('#mcp-client-id').value = clientId;
  }
  $('#mcp-log-identity').addEventListener('click', function (event) {
    var button = event.target.closest('.mcp-log-copy');
    if (!button || button.disabled) return;
    copyText(button.dataset.copyValue).then(function () {
      toast('已复制');
    }).catch(function () { toast('复制失败，请手动选中复制', true); });
  });

  function applyMcpConnectionToControls(connection, preserveDraft) {
    connection = connection || {};
    mcpConnection = clonePlain(connection);
    renderMcpArpPermissions();
    var index = mcpConnections.findIndex(function (item) { return item.id === connection.id; });
    if (index !== -1) mcpConnections[index] = mcpConnection;
    else if (connection.id) mcpConnections.push(mcpConnection);
    renderMcpConnections();
    $('#mcp-connection-editor-title').textContent = mcpCreating ? '新增服务端连接' : '编辑连接 · ' + (connection.alias || connection.url || '服务端');
    mcpEnabled = connection.enabled === true;
    mcpUrl = String(connection.url || 'ws://127.0.0.1:9999');
    mcpClientId = String(connection.clientId || '');
    mcpClientName = String(connection.clientName || '');
    mcpRunTabMode = normalizeRunTabMode(connection.runTabMode, 'reuseOpenTab');
    $('#mcp-enabled').checked = mcpEnabled;
    var desktop = connection.capabilities && connection.capabilities.desktop;
    var platform = connection.platform || connection.environment && connection.environment.os && connection.environment.os.platform;
    var operatingSystem = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] || platform || '待确认';
    if (!preserveDraft || !mcpDesktopDirty) {
      $('#mcp-local-tools-enabled').checked = !!(desktop && desktop.supported === true && connection.desktopEnabled === true);
    }
    $('#mcp-local-tools-status').textContent = '操作系统：' + operatingSystem + '；'
      + (desktop && desktop.supported === true ? '支持桌面操作。允许截图、键鼠等操作，作用于整台服务端，不受目录权限限制。修改后点击「保存」生效。'
        : desktop ? '不支持桌面操作。' : '桌面操作支持情况：待确认。请先连接服务端。');
    renderMcpWorkspaces(connection);
    renderMcpIdentity();
    if (preserveDraft && mcpSettingsDirty) {
      updateMcpSaveSettingsButton();
      return;
    }
    $('#mcp-url').value = mcpUrl;
    $('#mcp-alias').value = connection.alias || '';
    $('#mcp-run-tab-mode').value = mcpRunTabMode;
    updateMcpConfigSnippets();
    mcpSettingsDirty = false;
    mcpDesktopDirty = false;
    updateMcpSaveSettingsButton();
  }

  function currentMcpAttemptStatus() {
    return mcpConnectionAttempt && mcpConnectionAttempt.data && String(mcpConnectionAttempt.data.status || '');
  }

  function renderMcpConnectionStatus() {
    if (mcpCreating) { setMCPStatus('disconnected', '保存连接后，点击「配对服务端」，再开启连接'); return; }
    var connection = mcpConnection || {};
    if (connection.state === 'pairing') {
      setMCPStatus('connecting', formatMcpStatusText('正在验证配对，请稍候…', connection)); return;
    }
    if (connection.needsPairing) {
      setMCPStatus(connection.enabled ? 'error' : 'disconnected', formatMcpStatusText(
        (connection.enabled ? '开关已开启，' : '连接已关闭，') + (connection.paired ? '凭据不可用，请点击「重新配对」' : '请点击「配对服务端」输入配对密码'), connection)); return;
    }
    if (connection.enabled === false) {
      setMCPStatus('disconnected', formatMcpStatusText(connection.paired ? '已配对，打开开关即可连接' : '未配对，请点击「配对服务端」输入配对密码', connection)); return;
    }
    if (connection.reason === 'RETRY_LIMIT_REACHED') {
      setMCPStatus('error', formatMcpStatusText('开关已开启，自动重试已达上限（' + connection.retryLimit + ' 次）；请检查服务端后点击「重新连接」', connection)); return;
    }
    var attemptStatus = currentMcpAttemptStatus();
    var pollError = mcpConnectionAttempt && mcpConnectionAttempt.pollError
      ? ' · 状态读取失败: ' + mcpConnectionAttempt.pollError
      : '';
    if (attemptStatus === 'running') {
      setMCPStatus('connecting', formatMcpStatusText('连接中', connection) + pollError);
      return;
    }
    if (attemptStatus === 'failed') {
      setMCPStatus('error', formatMcpStatusText('连接失败', connection)
        + (mcpConnectionAttempt.data.error ? ' · ' + mcpConnectionAttempt.data.error : '') + pollError);
      return;
    }
    if (attemptStatus === 'interrupted') {
      setMCPStatus('error', formatMcpStatusText('连接已中断', connection)
        + (mcpConnectionAttempt.data.error ? ' · ' + mcpConnectionAttempt.data.error : '') + pollError);
      return;
    }
    if (connection.ready === true) {
      setMCPStatus('connected', formatMcpStatusText('已就绪', connection));
    } else if (connection.connecting === true || connection.state === 'connecting') {
      setMCPStatus('connecting', formatMcpStatusText('连接中', connection));
    } else {
      var text = mcpStateLabel(connection.state) + (connection.reason ? ' · ' + connection.reason : '');
      setMCPStatus('disconnected', formatMcpStatusText(text, connection));
    }
  }

  function renderMCP() {
    refreshMcpConnections().then(function (connections) { if (connections && mcpConnection) return updateMCPStatus(); })
      .catch(function (error) { toast(resourceErrorText(error), true); });
    chrome.storage.local.get(['mcpExtensionDir'], function (res) {
      mcpExtensionDir = res.mcpExtensionDir || '';
      $('#mcp-extension-dir').value = mcpExtensionDir;
      updateMcpConfigSnippets();
    });
  }

  function updateMCPStatus() {
    if (mcpCreating) return Promise.resolve(null);
    var sequence = ++mcpStatusSequence;
    return readMcpConnection().then(function (connection) {
      if (sequence !== mcpStatusSequence) return null;
      applyMcpConnectionToControls(connection, true);
      renderMcpConnectionStatus();
      if (!mcpEditorOpen) return connection;
      return readMcpConnectionLogs(connection.id).then(function (logs) {
        if (sequence !== mcpStatusSequence) return null;
        renderMcpLogs(logs);
        renderMcpConnectionStatus();
        return connection;
      });
    }).catch(function (error) {
      if (sequence !== mcpStatusSequence) return null;
      setMCPStatus('error', '连接状态读取失败 · ' + resourceErrorText(error));
      renderMcpLogs([]);
      return null;
    });
  }

  function setMCPStatus(state, text) {
    mcpStatusDot.className = 'status-dot ' + state;
    mcpStatusText.textContent = text;
  }

  function formatMcpStatusText(text, status) {
    var url = (status && status.url) || mcpUrl || '';
    return [text, url].filter(Boolean).join(' · ');
  }

  function renderMcpLogs(logs) {
    var list = $('#mcp-log-events');
    var viewport = $('#mcp-log-list');
    logs = Array.isArray(logs) ? logs : [];
    var html = logs.map(function (entry) {
      entry = entry || {};
      var level = entry.level || 'info';
      var time = entry.timestamp ? formatLogTime(entry.timestamp) : '';
      var detail = entry.detail ? '<div class="mcp-log-detail">' + esc(entry.detail) + '</div>' : '';
      return '<div class="mcp-log-entry mcp-log-' + esc(level) + '">'
        + '<span class="mcp-log-time">' + esc(time) + '</span> '
        + '<span class="mcp-log-level">' + esc(level) + '</span> '
        + '<span class="mcp-log-message">' + esc(entry.message || '') + '</span>'
        + detail
        + '</div>';
    }).join('') || '<div class="mcp-log-empty">暂无日志</div>';
    if (html === mcpLogsHtml) return;
    var followLatest = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8;
    mcpLogsHtml = html;
    list.innerHTML = html;
    if (followLatest) viewport.scrollTop = viewport.scrollHeight;
  }

  function clearMcpConnectionPollTimer() {
    if (mcpConnectionPollTimer) window.clearTimeout(mcpConnectionPollTimer);
    mcpConnectionPollTimer = 0;
  }

  function patchMcpConnection(patch, successMessage, preserveDraft) {
    mcpConnectionsSequence += 1;
    mcpStatusSequence += 1;
    var current = mcpConnection;
    var revision = mcpSettingsDirty && !preserveDraft ? mcpDraftRevision : current && current.configRevision;
    return Promise.resolve().then(function () {
      if (!current) throw new Error('请先选择服务端连接');
      return resourceClient.authorizedPatch(mcpConnectionUri(current.id), patch, mcpMutationOptions({
        ifMatch: '"mcp-' + revision + '"',
        criteria: { relation: 'connection' },
      }));
    }).then(function (envelope) {
      var updated = resourceData(envelope);
      if (!updated) throw new Error('MCP 连接更新未返回资源');
      clearMcpConnectionPollTimer();
      mcpConnectionAttempt = null;
      if (preserveDraft || mcpArpPermissionsDirty) advanceMcpDraftRevision(current.configRevision, updated);
      applyMcpConnectionToControls(updated, preserveDraft);
      renderMcpConnectionStatus();
      if (successMessage) toast(successMessage);
      return readMcpConnectionLogs(updated.id).then(renderMcpLogs).catch(function (error) {
        toast('连接已更新，但日志读取失败: ' + resourceErrorText(error), true);
      });
    }).catch(function (error) {
      renderMcpConnectionStatus();
      toast('连接设置失败: ' + resourceErrorText(error), true);
      throw error;
    });
  }

  function mcpConnectionAttemptData(envelope) {
    var data = resourceData(envelope);
    var status = data && String(data.status || '');
    if (['running', 'succeeded', 'failed', 'interrupted'].indexOf(status) === -1) {
      throw new Error('连接操作返回了无效状态');
    }
    return data;
  }

  function finishMcpConnectionAttempt() {
    var attempt = mcpConnectionAttempt;
    if (!attempt || !attempt.data) return;
    var data = attempt.data;
    if (data.status === 'succeeded' && data.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
      applyMcpConnectionToControls(data.result, true);
    }
    renderMcpConnectionStatus();
    if (data.status === 'succeeded') {
      toast(mcpConnection && mcpConnection.connected ? 'MCP 连接已建立' : '连接操作已完成，当前仍未连接', !mcpConnection || !mcpConnection.connected);
    } else {
      toast(data.status === 'interrupted'
        ? 'MCP 连接操作已中断' + (data.error ? ': ' + data.error : '')
        : 'MCP 连接失败' + (data.error ? ': ' + data.error : ''), true);
    }
    if (mcpConnection && mcpConnection.id) {
      var connectionId = mcpConnection.id;
      readMcpConnectionLogs(connectionId).then(function (logs) {
        if (mcpConnection && mcpConnection.id === connectionId) renderMcpLogs(logs);
      }).catch(function (error) {
        toast('日志读取失败: ' + resourceErrorText(error), true);
      });
    }
  }

  function pollMcpConnectionAttempt(delayMs) {
    var attempt = mcpConnectionAttempt;
    if (!attempt || !attempt.uri || attempt.data.status !== 'running') return;
    clearMcpConnectionPollTimer();
    mcpConnectionPollTimer = window.setTimeout(function () {
      resourceClient.get(attempt.uri).then(function (envelope) {
        if (mcpConnectionAttempt !== attempt) return;
        attempt.data = mcpConnectionAttemptData(envelope);
        attempt.pollError = '';
        attempt.pollFailures = 0;
        renderMcpConnectionStatus();
        if (attempt.data.status === 'running') {
          pollMcpConnectionAttempt(500);
        } else {
          clearMcpConnectionPollTimer();
          finishMcpConnectionAttempt();
        }
      }).catch(function (error) {
        if (mcpConnectionAttempt !== attempt) return;
        attempt.pollFailures = Math.min(10, Number(attempt.pollFailures) + 1);
        attempt.pollError = resourceErrorText(error);
        renderMcpConnectionStatus();
        pollMcpConnectionAttempt(Math.min(5000, 500 * Math.pow(2, attempt.pollFailures)));
      });
    }, Math.max(250, Math.min(5000, Number(delayMs) || 500)));
  }

  function startMcpConnectionAttempt() {
    if (mcpSettingsDirty) {
      toast('请先保存 MCP 连接设置', true);
      return Promise.resolve();
    }
    var connectionId = mcpConnection && mcpConnection.id;
    mcpStatusSequence += 1;
    return readMcpConnection().then(function (connection) {
      if (!mcpConnection || mcpConnection.id !== connectionId) return null;
      mcpConnection = clonePlain(connection);
      applyMcpConnectionToControls(connection, true);
      if (!connection.enabled) throw new Error('请先启用 MCP 连接');
      var uri = mcpConnectionUri(connection.id) + '/attempts';
      return resourceClient.authorizedPost(uri, { timeoutMs: 120000 }, mcpMutationOptions({
        criteria: { relation: 'connection-attempts' },
      }));
    }).then(function (envelope) {
      if (!envelope || !mcpConnection || mcpConnection.id !== connectionId) return;
      var operationUri = envelope && envelope.receipt && envelope.receipt.operationUri;
      if (!operationUri) throw new Error('连接操作未返回状态地址');
      clearMcpConnectionPollTimer();
      mcpConnectionAttempt = {
        uri: String(operationUri),
        data: mcpConnectionAttemptData(envelope),
        pollError: '',
        pollFailures: 0,
      };
      renderMcpConnectionStatus();
      toast('MCP 连接操作已开始');
      if (mcpConnectionAttempt.data.status === 'running') {
        pollMcpConnectionAttempt(envelope.receipt && envelope.receipt.retryAfterMs);
      } else {
        finishMcpConnectionAttempt();
      }
    }).catch(function (error) {
      renderMcpConnectionStatus();
      toast(resourceErrorText(error), true);
    });
  }

  function clearMcpConnectionLogs() {
    var connectionId = mcpConnection && mcpConnection.id;
    return readMcpConnection().then(function (connection) {
      if (!mcpConnection || mcpConnection.id !== connectionId) return;
      mcpConnection = clonePlain(connection);
      var uri = mcpConnectionLogsUri(connection.id);
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedDelete(uri, mcpMutationOptions({
          ifMatch: 'cached',
          criteria: { relation: 'connection-logs' },
        }));
      });
    }).then(function () {
      if (!mcpConnection || mcpConnection.id !== connectionId) return;
      renderMcpLogs([]);
      toast('连接日志已清空');
    }).catch(function (error) {
      toast('清空日志失败: ' + resourceErrorText(error), true);
    });
  }

  $('#mcp-enabled').addEventListener('change', function (e) {
    var enabled = e.target.checked;
    if (enabled && (!mcpConnection || !mcpConnection.paired)) {
      e.target.checked = false;
      toast('请先完成服务端配对，再开启连接', true);
      $('#btn-mcp-pair').focus({ preventScroll: true });
      return;
    }
    if (enabled && mcpSettingsDirty) {
      e.target.checked = false;
      toast('请先保存 MCP 连接设置', true);
      return;
    }
    if (enabled === mcpEnabled || mcpEnabledUpdating) return;
    mcpEnabledUpdating = true;
    updateMcpSaveSettingsButton();
    patchMcpConnection({ enabled: enabled }, enabled ? 'MCP 连接已启用' : 'MCP 连接已关闭', true).catch(function () {
      e.target.checked = mcpEnabled;
    }).finally(function () {
      mcpEnabledUpdating = false;
      updateMcpSaveSettingsButton();
    });
  });

  $('#mcp-local-tools-enabled').addEventListener('change', function () {
    mcpDesktopDirty = true;
    markMcpSettingsDirty();
  });

  ['#mcp-local-working-directory', '#mcp-new-workspace-alias'].forEach(function (selector) {
    $(selector).addEventListener('input', markMcpDirectoryDirty);
  });
  $all('#mcp-workspace-controls input').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      mcpDirectoryPermissions[checkbox.dataset.permission] = checkbox.checked;
      markMcpDirectoryDirty();
    });
  });

  $('#mcp-local-directory-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!mcpConnection || !mcpLocalDirectoryDirty || mcpSettingsSaving || mcpEnabledUpdating) return;
    var directory = $('#mcp-local-working-directory').value.trim();
    var editing = mcpEditingWorkspace;
    var startup = editing && editing.kind === 'startup';
    if (!startup && !directory) { toast('目录路径不能为空', true); return; }
    var previousRevision = mcpConnection.configRevision;
    var body = {};
    if (!startup) {
      body.path = directory;
      var alias = $('#mcp-new-workspace-alias').value.trim(); if (alias) body.alias = alias;
    }
    if (editing) body.permissions = mcpDirectoryPathChanged() ? { read: false, write: false, execute: false } : clonePlain(mcpDirectoryPermissions);
    mcpEnabledUpdating = true;
    updateMcpSaveSettingsButton();
    var uri = mcpConnectionUri(mcpConnection.id) + '/workspaces';
    var saved;
    try {
      saved = resourceData(await (editing
        ? resourceClient.authorizedPatch(uri + '/' + resourceSegment(editing.id), body, mcpMutationOptions({ ifMatch: '"mcp-' + editing.configRevision + '"' }))
        : resourceClient.authorizedPost(uri, body, mcpMutationOptions())));
      resetMcpDirectoryForm();
      renderMcpWorkspaceList(mcpConnection);
      toast(editing ? '目录及权限已保存' : '目录已新增，确认实际路径后可设置权限并保存');
      var updated = await updateMCPStatus();
      advanceMcpDraftRevision(previousRevision, updated);
    } catch (error) { toast(resourceErrorText(error), true); }
    finally {
      mcpEnabledUpdating = false;
      updateMcpSaveSettingsButton();
      if (saved) focusMcpDirectoryAction(saved);
    }
  });

  $('#mcp-url').addEventListener('input', function () {
    markMcpSettingsDirty();
  });

  $('#mcp-alias').addEventListener('input', markMcpSettingsDirty);

  $('#mcp-run-tab-mode').addEventListener('change', function () {
    markMcpSettingsDirty();
  });

  mcpSaveSettingsButton.addEventListener('click', async function () {
    if (!mcpConnection || mcpSettingsSaving || mcpEnabledUpdating) return;
    if (!mcpSettingsDirty && !mcpCreating) {
      if (mcpLocalDirectoryDirty || mcpArpPermissionsDirty) toast('权限有未保存的修改，请先保存权限', true);
      else collapseMcpEditor();
      return;
    }
    var url = $('#mcp-url').value.trim(), parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('invalid protocol');
    } catch (_) { toast('请输入有效的 WebSocket 地址（ws:// 或 wss://）', true); $('#mcp-url').focus(); return; }
    var connectionId = mcpConnection.id;
    if (!mcpCreating && mcpConnection.url !== url && !await confirmSettingsAction('修改地址会断开连接并清除本机配对凭据。保存后请使用目标服务端的密码重新配对。继续保存？', '修改连接地址', '保存新地址')) return;
    if (!mcpConnection || mcpConnection.id !== connectionId || mcpSettingsSaving || mcpEnabledUpdating) return;
    var patch = {
      url: url,
      alias: $('#mcp-alias').value.trim() || parsed.host,
      runTabMode: normalizeRunTabMode($('#mcp-run-tab-mode').value, 'reuseOpenTab'),
    };
    if (mcpDesktopDirty) patch.desktopEnabled = $('#mcp-local-tools-enabled').checked;
    mcpSettingsSaving = true;
    updateMcpSaveSettingsButton();
    if (mcpCreating) {
      mcpConnectionsSequence += 1; mcpStatusSequence += 1;
      try {
        var connection = resourceData(await resourceClient.authorizedPost('/connections', { alias: patch.alias, url: patch.url }, mcpMutationOptions()));
        mcpCreating = false;
        mcpDraftRevision = connection.configRevision;
        applyMcpConnectionToControls(connection, true);
        if (patch.runTabMode !== connection.runTabMode) await patchMcpConnection({ runTabMode: patch.runTabMode });
        else applyMcpConnectionToControls(connection);
        resetMcpEditorDraft();
        renderMcpLogs([]); renderMcpConnectionStatus();
        toast('连接已保存，可继续配对服务端');
      } catch (error) { toast(resourceErrorText(error), true); }
      finally { mcpSettingsSaving = false; updateMcpSaveSettingsButton(); }
      return;
    }
    try {
      await patchMcpConnection(patch);
      if (mcpLocalDirectoryDirty || mcpArpPermissionsDirty) { toast('连接设置已保存；权限有未保存的修改，请继续保存权限'); return; }
      resetMcpEditorDraft();
      mcpSettingsSaving = false;
      updateMcpSaveSettingsButton();
      setMcpEditorOpen(false);
      toast('MCP 连接设置已保存');
    } catch (_) {} finally {
      mcpSettingsSaving = false;
      updateMcpSaveSettingsButton();
    }
  });

  $('#mcp-extension-dir').addEventListener('input', function (e) {
    mcpExtensionDir = e.target.value;
    chrome.storage.local.set({ mcpExtensionDir: mcpExtensionDir });
    updateMcpConfigSnippets();
  });

  $('#btn-mcp-reconnect').addEventListener('click', function () {
    startMcpConnectionAttempt();
  });

  $('#btn-mcp-clear-logs').addEventListener('click', function () {
    clearMcpConnectionLogs();
  });

  lifecycle.interval(function () {
    if (currentSection === 'mcp' && !mcpSettingsSaving && !mcpEnabledUpdating) {
      refreshMcpConnections().then(function (connections) { if (connections && mcpConnection) return updateMCPStatus(); }).catch(function () {});
    }
  }, 3000);

  // ============================================================
  if (globalThis.OptionsModelSettingsPanel && globalThis.OptionsModelSettingsPanel.init) {
    globalThis.OptionsModelSettingsPanel.init({
      $: $, esc: esc, toast: toast, itemIdHtml: itemIdHtml,
      lifecycle: lifecycle,
      confirm: confirmSettingsAction,
      resourceClient: resourceClient,
      scrollOpenedEditor: scrollOpenedEditor,
    });
  }
  if (globalThis.OptionsKnowledgePanel && globalThis.OptionsKnowledgePanel.init) {
    globalThis.OptionsKnowledgePanel.init({ $: $, esc: esc, toast: toast, confirm: confirmSettingsAction, itemIdHtml: itemIdHtml,
      lifecycle: lifecycle, isActive: function () { return currentSection === 'knowledge'; } });
  }

  // 共享同步事件：各业务位置按当前引用的数据重新读取资源。
  if (syncEventStream) syncEventStream.subscribe(handleSyncEvent);

  // 抽屉控制
  function readDrawerEditSignature() {
    var content = $('#drawer-content');
    if (!content.querySelector('#node-title, #flowGroup-step-flowId, #flow-mail-form')) return '';
    return JSON.stringify(Array.from(content.querySelectorAll('input, select, textarea, page-code-editor')).map(function (field) {
      return [field.id, field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value];
    }));
  }

  function openDrawer() {
    $('#drawer-content').scrollTop = 0;
    $('#drawer-overlay').classList.add('active');
    $('#drawer').classList.add('active');
    drawerEditBaseline = readDrawerEditSignature();
  }
  async function closeDrawer(closeOptions) {
    var discard = closeOptions && closeOptions.discard === true;
    if (!discard && globalThis.Conversation && globalThis.Conversation.confirmEditorLeave
      && !await globalThis.Conversation.confirmEditorLeave()) return false;
    if (mcpActionDrawer) {
      if (mcpSettingsSaving || mcpEnabledUpdating) return false;
      if (!discard && mcpActionDrawer === 'client' && $('#mcp-client-name').value.trim() !== mcpClientNameBeforeEdit
        && !await confirmUnsavedChanges()) return false;
    }
    if (mcpPermissionsOpen) {
      if (mcpSettingsSaving || mcpEnabledUpdating) return false;
      if (!discard && (mcpLocalDirectoryDirty || mcpArpPermissionsDirty) && !await confirmUnsavedChanges()) return false;
    }
    if (appController && !await appController.confirmDrawerClose(discard)) return false;
    if (globalThis.Conversation && globalThis.Conversation.discardEditor) globalThis.Conversation.discardEditor();
    if (flowNodeController) flowNodeController.handleDrawerClosed();
    drawerEditBaseline = '';
    $('#drawer-overlay').classList.remove('active');
    $('#drawer').classList.remove('active');
    if (mcpActionDrawer) {
      var clientSettings = mcpActionDrawer === 'client';
      $('#mcp-action-host').appendChild($(clientSettings ? '#mcp-client-settings-form' : '#mcp-pair-form'));
      $('#mcp-action-host').appendChild($(clientSettings ? '#mcp-client-settings-actions' : '#mcp-pair-actions'));
      $('#mcp-pair-password').value = '';
      var trigger = $(clientSettings ? '#btn-mcp-client-settings' : '#btn-mcp-pair');
      mcpActionDrawer = '';
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus({ preventScroll: true });
    }
    if (mcpPermissionsOpen) {
      $('#mcp-permissions-host').appendChild($('#mcp-permissions-content'));
      mcpArpPermissionsDirty = false;
      renderMcpArpPermissions();
      mcpPermissionsOpen = false;
      mcpDiskInitialPending = false; mcpEnvironmentInitialPending = false;
      mcpDiskSequence += 1; mcpEnvironmentSequence += 1;
      if (mcpEnvironmentRefreshing) setMcpInfoStatus('environment', '');
      if (mcpDiskRefreshing) setMcpInfoStatus('disk', '');
      mcpDiskRefreshing = false; mcpEnvironmentRefreshing = false;
      resetMcpDirectoryForm();
      updateMcpSaveSettingsButton();
      $('#btn-mcp-permissions').setAttribute('aria-expanded', 'false');
      $('#btn-mcp-permissions').focus({ preventScroll: true });
    }
    globalThis.OptionsArchive.handleDrawerClosed();
    return true;
  }
  function handleDrawerCancel(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    closeDrawer();
  }
  $('#drawer-overlay').addEventListener('click', handleDrawerCancel);
  $('#drawer-close').addEventListener('click', handleDrawerCancel);

  globalThis.OptionsArchive.init({ openDrawer: openDrawer, closeDrawer: closeDrawer });
  globalThis.OptionsMailController.init({ openDrawer: openDrawer, lifecycle: lifecycle, toast: toast, scrollOpenedEditor: scrollOpenedEditor, confirm: confirmSettingsAction });

  function destroyController(controller) {
    if (!controller || typeof controller.destroy !== 'function') return;
    try {
      controller.destroy();
    } catch (error) {
      console.error('Options controller teardown failed', error);
    }
  }

  function teardown(event) {
    if (event && event.persisted) return;
    if (tornDown) return;
    tornDown = true;
    if (runtimeInputDialog) runtimeInputDialog.cancel();
    if (settingsConfirmDialog) settingsConfirmDialog.cancel();
    feedback.destroy();
    if (syncConfigRefreshTimer) window.clearTimeout(syncConfigRefreshTimer);
    syncConfigRefreshTimer = 0;
    [
      backupController,
      appController,
      runReportController,
      urlTriggerController,
      scheduleController,
      scriptController,
      pageController,
      flowGroupController,
      flowNodeController,
      flowController,
    ].forEach(destroyController);
    if (syncEventStream) syncEventStream.destroy();
    lifecycle.destroy();
  }

  function loadConversationState() {
    return globalThis.ConversationState.load();
  }

  function loadModelServiceOptions() {
    return Promise.all([
      loadResourceCollection('/model-services'),
      resourceClient.get('/agent-settings'),
    ]).then(function (values) {
      var agentSettings = resourceData(values[1]) || {};
      return {
        services: values[0],
        defaultServiceId: String(agentSettings.defaultModelServiceId || ''),
      };
    });
  }

  // Register before child controllers so a real unload removes their own
  // pagehide listeners while destroying them. BFCache navigation stays live.
  lifecycle.listen(window, 'pagehide', teardown);

  flowNodeController = globalThis.OptionsFlowNodeController.create({
    lifecycleApi: globalThis.PageAutomationLifecycle,
    window: window,
    document: document,
    runtime: chrome.runtime,
    console: console,
    $: $,
    esc: esc,
    nodeTypes: globalThis.NodeTypes,
    getConfig: function () { return config; },
    getFlowController: function () { return flowController; },
    userConfigValues: userConfigValues,
    sortedValues: sortedValues,
    isBuiltinItem: isBuiltinItem,
    sendMessage: sendMessage,
    getCurrentWindowId: getCurrentWindowId,
    getRunOriginContext: getRunOriginContext,
    buildRuntimeContextFromInputs: buildRuntimeContextFromInputs,
    generateConfigId: function (prefix, section, reserved) {
      return genUniqueConfigId(prefix, section, reserved);
    },
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    toast: toast,
    confirm: confirmSettingsAction,
    prompt: promptSettingsInput,
    loadConversationState: loadConversationState,
    loadModelServiceOptions: loadModelServiceOptions,
  });

  flowController = globalThis.OptionsFlowController.create({
    window: window,
    $: $,
    esc: esc,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    resourceClient: resourceClient,
    getConfig: function () { return config; },
    mutateConfig: mutateConfig,
    applyFlowEnvelope: applyFlowEnvelope,
    removeFlowFromState: function (flowId) { removeResourceFromMap('flows', flowId); },
    refreshFlowResources: loadFlowResources,
    sortedValues: sortedValues,
    renderConfigListItems: renderConfigListItems,
    resetConfigListPage: resetConfigListPage,
    isBuiltinItem: isBuiltinItem,
    itemIdHtml: itemIdHtml,
    flowUsageSummary: flowUsageSummary,
    normalizeRunTabMode: normalizeRunTabMode,
    runTabModeSelectHtml: runTabModeSelectHtml,
    nodeCardHtml: function (node, index, total, nodes, readonly) {
      return flowNodeController.nodeCardHtml(node, index, total, nodes, readonly);
    },
    setupNodeDragDrop: function () { return flowNodeController.setupNodeDragDrop(); },
    validateFlowNodes: function (nodes) { return flowNodeController.validateFlowNodes(nodes); },
    generateConfigId: function (prefix, section, reserved) {
      return genUniqueConfigId(prefix, section, reserved);
    },
    downloadFile: function (filename, content, contentType) {
      if (!backupController || typeof backupController.downloadFile !== 'function') {
        throw new Error('备份控制器尚未初始化');
      }
      return backupController.downloadFile(filename, content, contentType);
    },
    scrollOpenedEditor: scrollOpenedEditor,
    toast: toast,
    confirm: confirmSettingsAction,
    isActive: function () { return currentSection === 'flows'; },
    onIdle: refreshPendingSyncConfig,
  });
  flowController.init();
  flowNodeController.init();

  flowGroupController = globalThis.OptionsFlowGroupController.create({
    window: window,
    $: $,
    esc: esc,
    resourceClient: resourceClient,
    getConfig: function () { return config; },
    applyFlowGroupEnvelope: applyFlowGroupEnvelope,
    removeFlowGroupFromState: function (flowGroupId) { removeResourceFromMap('flowGroups', flowGroupId); },
    refreshFlowResources: loadFlowResources,
    sortedValues: sortedValues,
    renderConfigListItems: renderConfigListItems,
    resetConfigListPage: resetConfigListPage,
    isBuiltinItem: isBuiltinItem,
    itemIdHtml: itemIdHtml,
    scrollOpenedEditor: scrollOpenedEditor,
    toast: toast,
    confirm: confirmSettingsAction,
    isActive: function () { return currentSection === 'flowGroups'; },
    onIdle: refreshPendingSyncConfig,
    listableFlows: listableFlows,
    flowUsageSummary: flowUsageSummary,
    normalizeRunTabMode: normalizeRunTabMode,
    runTabModeSelectHtml: runTabModeSelectHtml,
    runTabModeOptions: RUN_TAB_MODE_OPTIONS,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    generateFlowGroupId: function (reserved) { return genUniqueConfigId('fg', 'flowGroups', reserved); },
    generateStepId: function () { return genConfigId('st'); },
  });
  flowGroupController.init();

  if (!globalThis.OptionsPageController || typeof globalThis.OptionsPageController.create !== 'function') {
    throw new Error('OptionsPageController must load before options.js');
  }
  pageController = globalThis.OptionsPageController.create({
    window: window,
    $: $,
    esc: esc,
    getConfig: function () { return config; },
    mutateConfig: mutateConfig,
    sortedValues: sortedValues,
    renderConfigListItems: renderConfigListItems,
    resetConfigListPage: resetConfigListPage,
    isBuiltinItem: isBuiltinItem,
    itemIdHtml: itemIdHtml,
    scrollOpenedEditor: scrollOpenedEditor,
    toast: toast,
    confirm: confirmSettingsAction,
    isActive: function () { return currentSection === 'pages'; },
    generatePageId: function (reserved) { return genUniqueConfigId('pa', 'pages', reserved); },
  });
  pageController.init();

  if (!globalThis.OptionsScriptController || typeof globalThis.OptionsScriptController.create !== 'function') {
    throw new Error('OptionsScriptController must load before options.js');
  }
  scriptController = globalThis.OptionsScriptController.create({
    window: window,
    $: $,
    esc: esc,
    getConfig: function () { return config; },
    mutateConfig: mutateConfig,
    executeScript: saveAndRunScriptResource,
    userConfigValues: userConfigValues,
    renderConfigListItems: renderConfigListItems,
    resetConfigListPage: resetConfigListPage,
    itemIdHtml: itemIdHtml,
    fmtTime: fmtTime,
    scrollOpenedEditor: scrollOpenedEditor,
    toast: toast,
    confirm: confirmSettingsAction,
    isActive: function () { return currentSection === 'scripts'; },
  });
  scriptController.init();

  if (!globalThis.OptionsScheduleController || typeof globalThis.OptionsScheduleController.create !== 'function') {
    throw new Error('OptionsScheduleController must load before options.js');
  }
  scheduleController = globalThis.OptionsScheduleController.create({
    window: window,
    $: $,
    esc: esc,
    getConfig: function () { return config; },
    mutateConfig: mutateConfig,
    sortedValues: sortedValues,
    renderConfigListItems: renderConfigListItems,
    resetConfigListPage: resetConfigListPage,
    listableFlows: listableFlows,
    isBuiltinItem: isBuiltinItem,
    itemIdHtml: itemIdHtml,
    scrollOpenedEditor: scrollOpenedEditor,
    toast: toast,
    confirm: confirmSettingsAction,
    isActive: function () { return currentSection === 'schedules'; },
    loadConversationState: loadConversationState,
  });
  scheduleController.init();

  urlTriggerController = globalThis.OptionsUrlTriggerController.create({
    lifecycleApi: globalThis.PageAutomationLifecycle,
    window: window,
    document: document,
    $: $,
    esc: esc,
    getConfig: function () { return config; },
    mutateConfig: mutateConfig,
    listableFlows: listableFlows,
    sortedValues: sortedValues,
    renderConfigListItems: renderConfigListItems,
    resetConfigListPage: resetConfigListPage,
    itemIdHtml: itemIdHtml,
    scrollOpenedEditor: scrollOpenedEditor,
    toast: toast,
    confirm: confirmSettingsAction,
    isActive: function () { return currentSection === 'url-triggers'; },
  });
  urlTriggerController.init();

  if (!globalThis.OptionsRunReportController
      || typeof globalThis.OptionsRunReportController.create !== 'function'
      || typeof globalThis.OptionsRunReportController.formatStatus !== 'function') {
    throw new Error('OptionsRunReportController must load before options.js');
  }
  runReportController = globalThis.OptionsRunReportController.create({
    runtime: chrome.runtime,
    resourceClient: resourceClient,
    document: document,
    window: window,
    paginate: function (runs) { return paginateConfigList('logs', runs); },
    renderPagination: renderConfigListPagination,
    nodeTypes: globalThis.NodeTypes,
    toast: toast,
    confirm: confirmSettingsAction,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    isActive: function () { return currentSection === 'logs'; },
  });
  runReportController.init();

  if (!globalThis.OptionsBackupController || typeof globalThis.OptionsBackupController.create !== 'function') {
    throw new Error('OptionsBackupController must load before options.js');
  }
  backupController = globalThis.OptionsBackupController.create({
    chrome: chrome,
    resourceClient: resourceClient,
    document: document,
    window: window,
    $: $,
    $all: $all,
    esc: esc,
    cssEscape: cssEscape,
    hasOwn: hasOwn,
    clonePlain: clonePlain,
    uniqueIds: uniqueIds,
    stripRuntimeMetadata: stripRuntimeMetadata,
    isBuiltinItem: isBuiltinItem,
    isBuiltinConfigImport: isBuiltinConfigImport,
    fmtTime: fmtTime,
    formatStorageMegabytes: formatStorageMegabytes,
    scheduleTaskKind: scheduleController.scheduleTaskKind,
    toast: toast,
    confirm: confirmSettingsAction,
    prompt: promptSettingsInput,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    setGlobalSidebarCollapsed: setGlobalSidebarCollapsed,
    loadConfig: loadConfig,
    renderCurrentSection: renderCurrentSection,
    renderRuns: renderRuns,
    renderMCP: renderMCP,
    getConfig: function () { return config; },
    setConfig: function (next) { config = next; },
    readConfigSnapshot: loadConfigResourceSnapshot,
    mutateConfigResource: mutateConfig,
    setFlowDirty: function (dirty) { if (flowController) flowController.setDirty(dirty); },
    getCurrentSection: function () { return currentSection; },
  });
  backupController.init();
  appController = globalThis.OptionsAppController.create({
    resourceClient: resourceClient,
    toast: toast,
    confirm: confirmSettingsAction,
    prompt: promptSettingsInput,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    isActive: function () { return currentSection === 'apps' || currentSection === 'system-settings'; },
    onFavoritesChanged: function (hasFavorites) {
      hasAppFavorites = hasFavorites;
      updateFavoritesAvailability(systemSettingsSaving);
    },
    exportApp: function (appId) { return backupController.exportApp(appId); },
    showRuns: function () { switchSection('logs'); },
    converse: async function (appId) {
      if (!await switchSection('conversation')) return;
      await globalThis.Conversation.openApp(appId);
    },
  });
  var appTarget = new URLSearchParams(location.search);
  switchSection(appTarget.get('section') === 'conversation' || pendingConversationTarget ? 'conversation' : 'apps');
  if (appTarget.get('section') === 'apps') {
    if (appTarget.get('appId')) {
      var appAction = appTarget.get('action');
      if (appAction === 'manage') appController.openManagement(appTarget.get('appId')).catch(function (error) { toast(error.message, true); });
      if (appAction === 'edit' || appAction === 'permissions') appController[appAction](appTarget.get('appId')).catch(function (error) { toast(error.message, true); });
    }
  }

  loadConfig();
})();
