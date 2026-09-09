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
  var currentSection = 'conversation';
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

  // 有未保存修改时确认丢弃；返回 false 表示用户取消操作
  function confirmDiscardFlowDraft() {
    return !flowController || flowController.confirmDiscard();
  }
  var scriptController = null;
  var urlTriggerController = null;
  var flowGroupController = null;
  var CONFIG_LIST_DEFAULT_PAGE_SIZE = 40;
  var CONFIG_LIST_PAGE_SIZE_OPTIONS = [20, 40, 80, 120];
  var configListPages = {};
  var scheduleController = null;
  var backupController = null;
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

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function itemIdHtml(id) {
    if (!id) return '';
    return '<span class="item-id" data-action="copy-id" data-id="' + esc(id) + '" title="点击复制 ID，也可拖拽选中">ID: ' + esc(id) + '</span>';
  }

  function scrollOpenedEditor(selector) {
    (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); })(function () {
      var el = typeof selector === 'string' ? $(selector) : selector;
      if (!el || el.classList.contains('hidden')) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var focusEl = el.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
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
    var item = clonePlain(input);
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
    item = clonePlain(item || {});
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

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('#toast');
    el.textContent = message;
    el.className = isError ? 'error' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'hidden'; }, 2600);
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

  function renderUsageBlock(title, text) {
    if (!String(text || '').trim()) return '';
    return '<div class="io-usage-block"><strong>' + esc(title) + '</strong><p>' + esc(text) + '</p></div>';
  }

  function renderFlowUsageSummary(item, emptyText) {
    item = item || {};
    if (!item.description && !item.inputDescription && !item.outputDescription && !item.inputExample) {
      return '<div class="io-note"><b>使用说明</b><span>' + esc(emptyText || '未填写使用说明。') + '</span></div>';
    }
    return '<div class="io-note io-summary">'
      + '<b>使用说明</b>'
      + '<div class="io-note-content">'
      + renderUsageBlock('用途', item.description || '')
      + renderUsageBlock('入参', item.inputDescription || '')
      + renderUsageBlock('出参', item.outputDescription || '')
      + renderUsageBlock('运行入参示例', item.inputExample || '')
      + '</div>'
      + '</div>';
  }

  function normalizeRuntimeInputPayload(parsed) {
    return parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
      ? parsed
      : { input: parsed };
  }

  function buildRuntimeContextFromInputs(runnable, title) {
    var initial = (runnable && runnable.inputExample) ? String(runnable.inputExample) : '';
    var hint = (title || '运行') + ' 入参 JSON（可选）'
      + '\n可使用 {"input": {...}}，也可以直接填写入参对象。留空表示无入参。';
    var raw = prompt(hint, initial);
    if (raw === null) return null;
    raw = String(raw || '').trim();
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
      return normalizeRuntimeInputPayload(parsed);
    } catch (err) {
      toast('入参 JSON 无效: ' + err.message, true);
      return null;
    }
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
    return pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2)
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

  function changeConfigListPage(section, cursor) {
    if (section === 'flows' && !confirmDiscardFlowDraft()) return false;
    var state = configListPageState(section);
    state.cursor = normalizeConfigListCursor(cursor);
    clearConfigListDraft(section);
    renderConfigListSection(section);
    return true;
  }

  function handleConfigListPageSizeChange(event) {
    var target = event.target;
    if (!target || !target.matches || !target.matches('[data-config-list-page-size]')) return;
    var section = target.dataset.section || currentSection;
    var state = configListPageState(section);
    if (section === 'flows' && !confirmDiscardFlowDraft()) {
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

  function currentConfigDomainController() {
    if (currentSection === 'pages') return pageController;
    if (currentSection === 'flows') return flowController;
    if (currentSection === 'flowGroups') return flowGroupController;
    if (currentSection === 'scripts') return scriptController;
    if (currentSection === 'schedules') return scheduleController;
    if (currentSection === 'url-triggers') return urlTriggerController;
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

  function switchSection(section) {
    if (currentSection === 'flows' && section !== 'flows' && !confirmDiscardFlowDraft()) return;
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
      return;
    }
    renderCurrentSection();
  }

  function renderCurrentSection() {
    switch (currentSection) {
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
      case 'system-settings': renderSystemSettings(); break;
    }
  }

  // ============================================================
  // 流程配置
  // ============================================================

  function renderFlows() {
    return flowController ? flowController.render() : null;
  }

  function runFlow(flowId) {
    var flow = config.flows && config.flows[flowId];
    var context = buildRuntimeContextFromInputs(flow, '运行流程「' + ((flow && (flow.label || flow.name)) || flowId) + '」');
    if (context === null) return;
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

  function runFlowGroup(flowGroupId) {
    var group = config.flowGroups && config.flowGroups[flowGroupId];
    var context = buildRuntimeContextFromInputs(group, '运行流程组「' + ((group && (group.label || group.name)) || flowGroupId) + '」');
    if (context === null) return;
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
    group.name = group.label;
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
    var flow = remapImportedFlow(stripRuntimeMetadata(bundle.flow));
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
      var flow = stripRuntimeMetadata(bundle.flows[id]);
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

    var group = stripRuntimeMetadata(bundle.flowGroup);
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
      group.name = group.label;
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

  function setSystemSettingsControlsDisabled(disabled) {
    var floatingEntry = $('#system-floating-entry-disabled');
    if (floatingEntry) floatingEntry.disabled = !!disabled;
  }

  function renderSystemSettings() {
    var floatingEntry = $('#system-floating-entry-disabled');
    if (floatingEntry) floatingEntry.checked = systemSettings.floatingEntryDisabled === true;
  }

  function loadSystemSettings() {
    return globalThis.PageAutomationSystemSettings.load(chrome.storage.local, chrome.runtime).then(function (settings) {
      systemSettings = settings;
      renderSystemSettings();
      return settings;
    });
  }

  function saveSystemSettingsFromControls() {
    if (systemSettingsSaving) return;
    var floatingEntry = $('#system-floating-entry-disabled');
    var previous = systemSettings;
    var floatingEntryDisabled = !!(floatingEntry && floatingEntry.checked);
    systemSettingsSaving = true;
    setSystemSettingsControlsDisabled(true);
    resourceClient.get('/agent-settings').then(function (envelope) {
      var currentAgentSettings = resourceData(envelope);
      if (!currentAgentSettings) throw new Error('Agent Settings 返回无效数据');
      var next = globalThis.PageAutomationSystemSettings.normalize({
        floatingEntryDisabled: floatingEntryDisabled,
      });
      return globalThis.PageAutomationSystemSettings.save(chrome.storage.local, chrome.runtime, next);
    }).then(function (saved) {
      systemSettings = saved;
      toast('系统配置已更新');
    }).catch(function (error) {
      systemSettings = previous;
      renderSystemSettings();
      toast('系统配置保存失败: ' + (error && error.message || error), true);
    }).finally(function () {
      systemSettingsSaving = false;
      setSystemSettingsControlsDisabled(false);
    });
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    var id = target.dataset.id;
    if (flowNodeController && flowNodeController.ownsAction(action)) return;

    switch (action) {
      case 'copy-id': {
        event.stopPropagation();
        var selection = window.getSelection ? String(window.getSelection()) : '';
        if (selection.trim()) break;
        copyText(id || '').then(function () {
          toast('已复制 ID: ' + id);
        }).catch(function () {
          toast('复制失败，请手动选中复制', true);
        });
        break;
      }
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

  var floatingEntryToggle = $('#system-floating-entry-disabled');
  if (floatingEntryToggle) floatingEntryToggle.addEventListener('change', saveSystemSettingsFromControls);
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
  var mcpConnectionAttempt = null;
  var mcpConnectionPollTimer = 0;
  var mcpStatusSequence = 0;
  var mcpMutationSequence = 0;
  var mcpSettingsDirty = false;
  var mcpSettingsSaving = false;
  var mcpEnabledUpdating = false;
  var mcpExtensionDir = '';
  var mcpRunTabMode = 'reuseOpenTab';
  var mcpWsPort = 9999;
  var mcpHttpPort = 9998;
  var mcpBundleRelativePath = 'mcp-server/page-agent-mcp-server.cjs';
  var mcpStatusDot = $('#mcp-status-dot');
  var mcpStatusText = $('#mcp-status-text');
  var mcpSaveSettingsButton = $('#btn-mcp-save-settings');

  function updateMcpSaveSettingsButton() {
    $('#mcp-enabled').disabled = mcpSettingsSaving || mcpEnabledUpdating;
    ['#mcp-url', '#mcp-client-name', '#mcp-run-tab-mode'].forEach(function (selector) {
      $(selector).disabled = mcpEnabled || mcpSettingsSaving || mcpEnabledUpdating;
    });
    mcpSaveSettingsButton.disabled = mcpEnabled || !mcpSettingsDirty || mcpSettingsSaving || mcpEnabledUpdating;
    mcpSaveSettingsButton.textContent = mcpSettingsSaving ? '保存中...' : '保存连接设置';
  }

  function markMcpSettingsDirty() {
    mcpSettingsDirty = true;
    updateMcpSaveSettingsButton();
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
    return 'node ' + quoteCliPath(joinMcpBundlePath(mcpExtensionDir)) + ' ' + buildMcpPortArgs();
  }

  function buildCherryStudioConfig() {
    return JSON.stringify({
      mcpServers: {
        'page-agent': {
          command: 'node',
          args: [
            joinMcpBundlePath(mcpExtensionDir),
            '--ws-port',
            String(Number(mcpWsPort || 9999)),
            '--http-port',
            String(Number(mcpHttpPort || 9998))
          ]
        }
      }
    }, null, 2);
  }

  function buildGenericMcpUsagePrompt() {
    return [
      '使用 mcp page-agent 观测当前已打开的目标页面，创建一个数据采集流程。',
      '要求：',
      '1. 先用页面观测工具定位需要读取的字段和稳定选择器。',
      '2. 用流程节点完成页面打开、等待、数据读取和结构化输出。',
      '3. 输出变量写入 result，便于 webhook 调用时直接读取。',
      '4. 不使用 runScript；runScript 只作为兜底能力，优先使用已有流程节点完成。'
    ].join('\n');
  }

  function buildCodexMcpGuide() {
    var serverPath = quoteCliPath(joinMcpBundlePath(mcpExtensionDir));
    return [
      '# 添加',
      'codex mcp add page-agent -- node ' + serverPath + ' ' + buildMcpPortArgs(),
      '',
      '# 使用',
      buildGenericMcpUsagePrompt(),
      '',
      '# 移除',
      'codex mcp remove page-agent'
    ].join('\n');
  }

  function buildClaudeCodeMcpGuide() {
    var serverPath = quoteCliPath(joinMcpBundlePath(mcpExtensionDir));
    return [
      '# 添加',
      'claude mcp add --transport stdio page-agent -- node ' + serverPath + ' ' + buildMcpPortArgs(),
      '',
      '# 检查 / 管理',
      'claude',
      '/mcp',
      '',
      '# 使用',
      buildGenericMcpUsagePrompt(),
      '',
      '# 移除',
      'claude mcp remove page-agent'
    ].join('\n');
  }

  function updateMcpConfigSnippets() {
    $('#mcp-start-command').textContent = buildMcpStartCommand();
    $('#mcp-cherry-config').textContent = buildCherryStudioConfig();
    $('#mcp-codex-config').textContent = buildCodexMcpGuide();
    $('#mcp-claude-config').textContent = buildClaudeCodeMcpGuide();
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
      if (!items.length || !items[0].id) throw new Error('当前扩展环境没有可用的 MCP 连接资源');
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

  function applyMcpConnectionToControls(connection, preserveDraft) {
    connection = connection || {};
    mcpConnection = clonePlain(connection);
    mcpEnabled = connection.enabled === true;
    mcpUrl = String(connection.url || 'ws://127.0.0.1:9999');
    mcpClientId = String(connection.clientId || '');
    mcpClientName = String(connection.clientName || '');
    mcpRunTabMode = normalizeRunTabMode(connection.runTabMode, 'reuseOpenTab');
    $('#mcp-enabled').checked = mcpEnabled;
    $('#mcp-client-id').value = mcpClientId || (connection.incognito ? '当前隐私环境尚未生成 ID' : '启用连接后自动生成');
    if (preserveDraft && mcpSettingsDirty) {
      updateMcpSaveSettingsButton();
      return;
    }
    $('#mcp-url').value = mcpUrl;
    $('#mcp-client-name').value = mcpClientName;
    $('#mcp-run-tab-mode').value = mcpRunTabMode;
    try {
      var parsed = new URL(mcpUrl);
      mcpWsPort = Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80);
    } catch (_) {
      mcpWsPort = 9999;
    }
    updateMcpConfigSnippets();
    mcpSettingsDirty = false;
    updateMcpSaveSettingsButton();
  }

  function currentMcpAttemptStatus() {
    return mcpConnectionAttempt && mcpConnectionAttempt.data && String(mcpConnectionAttempt.data.status || '');
  }

  function renderMcpConnectionStatus() {
    var connection = mcpConnection || {};
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
    if (connection.connected === true || connection.state === 'connected') {
      setMCPStatus('connected', formatMcpStatusText('已连接', connection));
    } else if (connection.connecting === true || connection.state === 'connecting') {
      setMCPStatus('connecting', formatMcpStatusText('连接中', connection));
    } else if (connection.enabled === false || connection.state === 'disabled') {
      setMCPStatus('disconnected', formatMcpStatusText('连接已关闭', connection));
    } else {
      var text = connection.retryCount ? '未连接 · 重试 ' + connection.retryCount : '未连接';
      setMCPStatus('disconnected', formatMcpStatusText(text, connection));
    }
  }

  function renderMCP() {
    chrome.storage.local.get(['mcpExtensionDir'], function (res) {
      mcpExtensionDir = res.mcpExtensionDir || '';
      $('#mcp-extension-dir').value = mcpExtensionDir;
      updateMcpConfigSnippets();
      updateMCPStatus();
    });
  }

  function updateMCPStatus() {
    var sequence = ++mcpStatusSequence;
    return readMcpConnection().then(function (connection) {
      if (sequence !== mcpStatusSequence) return null;
      applyMcpConnectionToControls(connection, true);
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
    var client = status && (status.clientName || status.clientId) || mcpClientName || mcpClientId || '';
    return [text, url, client].filter(Boolean).join(' · ');
  }

  function mcpLogLevelText(level) {
    if (level === 'success') return '成功';
    if (level === 'warn') return '警告';
    if (level === 'error') return '错误';
    return '信息';
  }

  function renderMcpLogs(logs) {
    var list = $('#mcp-log-list');
    if (!list) return;
    logs = Array.isArray(logs) ? logs : [];
    if (!logs.length) {
      list.innerHTML = '<div class="mcp-log-empty">暂无日志</div>';
      return;
    }
    list.innerHTML = logs.map(function (entry) {
      entry = entry || {};
      var level = entry.level || 'info';
      var time = entry.timestamp ? formatLogTime(entry.timestamp) : '';
      var detail = entry.detail ? '<div class="mcp-log-detail">' + esc(entry.detail) + '</div>' : '';
      return '<div class="mcp-log-entry mcp-log-' + esc(level) + '">'
        + '<span class="mcp-log-time">' + esc(time) + '</span>'
        + '<span class="mcp-log-level">' + esc(mcpLogLevelText(level)) + '</span>'
        + '<span class="mcp-log-message">' + esc(entry.message || '') + '</span>'
        + detail
        + '</div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  function clearMcpConnectionPollTimer() {
    if (mcpConnectionPollTimer) window.clearTimeout(mcpConnectionPollTimer);
    mcpConnectionPollTimer = 0;
  }

  function patchMcpConnection(patch, successMessage) {
    mcpStatusSequence += 1;
    return readMcpConnection().then(function (current) {
      mcpConnection = clonePlain(current);
      return resourceClient.authorizedPatch(mcpConnectionUri(current.id), patch, mcpMutationOptions({
        ifMatch: 'cached',
        criteria: { relation: 'connection' },
      }));
    }).then(function (envelope) {
      var updated = resourceData(envelope);
      if (!updated) throw new Error('MCP 连接更新未返回资源');
      clearMcpConnectionPollTimer();
      mcpConnectionAttempt = null;
      applyMcpConnectionToControls(updated);
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
      readMcpConnectionLogs(mcpConnection.id).then(renderMcpLogs).catch(function (error) {
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
    mcpStatusSequence += 1;
    return readMcpConnection().then(function (connection) {
      mcpConnection = clonePlain(connection);
      applyMcpConnectionToControls(connection, true);
      if (!connection.enabled) throw new Error('请先启用 MCP 连接');
      var uri = mcpConnectionUri(connection.id) + '/attempts';
      return resourceClient.authorizedPost(uri, { timeoutMs: 120000 }, mcpMutationOptions({
        criteria: { relation: 'connection-attempts' },
      }));
    }).then(function (envelope) {
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
    return readMcpConnection().then(function (connection) {
      mcpConnection = clonePlain(connection);
      var uri = mcpConnectionLogsUri(connection.id);
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedDelete(uri, mcpMutationOptions({
          ifMatch: 'cached',
          criteria: { relation: 'connection-logs' },
        }));
      });
    }).then(function () {
      renderMcpLogs([]);
      toast('连接日志已清空');
    }).catch(function (error) {
      toast('清空日志失败: ' + resourceErrorText(error), true);
    });
  }

  $('#mcp-enabled').addEventListener('change', function (e) {
    var enabled = e.target.checked;
    if (enabled && mcpSettingsDirty) {
      e.target.checked = false;
      toast('请先保存 MCP 连接设置', true);
      return;
    }
    if (enabled === mcpEnabled || mcpEnabledUpdating) return;
    mcpEnabledUpdating = true;
    updateMcpSaveSettingsButton();
    patchMcpConnection({ enabled: enabled }, enabled ? 'MCP 连接已启用' : 'MCP 连接已关闭').catch(function () {
      e.target.checked = mcpEnabled;
    }).finally(function () {
      mcpEnabledUpdating = false;
      updateMcpSaveSettingsButton();
    });
  });

  $('#mcp-url').addEventListener('input', function () {
    markMcpSettingsDirty();
  });

  $('#mcp-client-name').addEventListener('input', function () {
    markMcpSettingsDirty();
  });

  $('#mcp-run-tab-mode').addEventListener('change', function () {
    markMcpSettingsDirty();
  });

  mcpSaveSettingsButton.addEventListener('click', function () {
    if (mcpEnabled || mcpSettingsSaving || mcpEnabledUpdating || !mcpSettingsDirty) return;
    mcpSettingsSaving = true;
    updateMcpSaveSettingsButton();
    patchMcpConnection({
      url: $('#mcp-url').value.trim(),
      clientName: $('#mcp-client-name').value.trim(),
      runTabMode: normalizeRunTabMode($('#mcp-run-tab-mode').value, 'reuseOpenTab'),
    }, 'MCP 连接设置已保存').catch(function () {}).finally(function () {
      mcpSettingsSaving = false;
      updateMcpSaveSettingsButton();
    });
  });

  $('#mcp-extension-dir').addEventListener('input', function (e) {
    mcpExtensionDir = e.target.value;
    chrome.storage.local.set({ mcpExtensionDir: mcpExtensionDir });
    updateMcpConfigSnippets();
  });

  $('#btn-copy-mcp-command').addEventListener('click', function () {
    copyText(buildMcpStartCommand()).then(function () {
      toast('已复制启动命令');
    }).catch(function () {
      toast('复制失败，请手动选中复制', true);
    });
  });

  $('#btn-copy-cherry-config').addEventListener('click', function () {
    copyText(buildCherryStudioConfig()).then(function () {
      toast('已复制 Cherry Studio 配置');
    }).catch(function () {
      toast('复制失败，请手动选中复制', true);
    });
  });

  $('#btn-copy-codex-config').addEventListener('click', function () {
    copyText(buildCodexMcpGuide()).then(function () {
      toast('已复制 Codex 命令');
    }).catch(function () {
      toast('复制失败，请手动选中复制', true);
    });
  });

  $('#btn-copy-claude-config').addEventListener('click', function () {
    copyText(buildClaudeCodeMcpGuide()).then(function () {
      toast('已复制 Claude Code 命令');
    }).catch(function () {
      toast('复制失败，请手动选中复制', true);
    });
  });

  $('#btn-mcp-reconnect').addEventListener('click', function () {
    startMcpConnectionAttempt();
  });

  $('#btn-mcp-clear-logs').addEventListener('click', function () {
    clearMcpConnectionLogs();
  });

  lifecycle.interval(function () {
    if (currentSection === 'mcp' && !mcpSettingsSaving && !mcpEnabledUpdating) {
      updateMCPStatus();
    }
  }, 3000);

  // ============================================================
  if (globalThis.OptionsModelSettingsPanel && globalThis.OptionsModelSettingsPanel.init) {
    globalThis.OptionsModelSettingsPanel.init({
      $: $, esc: esc, toast: toast,
      resourceClient: resourceClient,
    });
  }
  if (globalThis.OptionsKnowledgePanel && globalThis.OptionsKnowledgePanel.init) {
    globalThis.OptionsKnowledgePanel.init({ $: $, esc: esc, toast: toast });
  }

  // 共享同步事件：各业务位置按当前引用的数据重新读取资源。
  if (syncEventStream) syncEventStream.subscribe(handleSyncEvent);

  // 抽屉控制
  function openDrawer() {
    $('#drawer-overlay').classList.add('active');
    $('#drawer').classList.add('active');
  }
  function closeDrawer() {
    $('#drawer-overlay').classList.remove('active');
    $('#drawer').classList.remove('active');
  }
  function handleDrawerCancel(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (flowNodeController && typeof flowNodeController.handleDrawerClosed === 'function') {
      flowNodeController.handleDrawerClosed();
    }
    closeDrawer();
  }
  $('#drawer-overlay').addEventListener('click', handleDrawerCancel);
  $('#drawer-close').addEventListener('click', handleDrawerCancel);

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
    clearTimeout(toastTimer);
    if (syncConfigRefreshTimer) window.clearTimeout(syncConfigRefreshTimer);
    toastTimer = null;
    syncConfigRefreshTimer = 0;
    [
      backupController,
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
    confirm: function (message) { return confirm(message); },
    prompt: function (message, defaultValue) { return prompt(message, defaultValue); },
    loadConversationState: loadConversationState,
    loadModelServiceOptions: loadModelServiceOptions,
  });

  flowController = globalThis.OptionsFlowController.create({
    window: window,
    $: $,
    esc: esc,
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
    renderFlowUsageSummary: renderFlowUsageSummary,
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
    confirm: function (message) { return confirm(message); },
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
    confirm: function (message) { return confirm(message); },
    isActive: function () { return currentSection === 'flowGroups'; },
    onIdle: refreshPendingSyncConfig,
    listableFlows: listableFlows,
    flowUsageSummary: flowUsageSummary,
    renderFlowUsageSummary: renderFlowUsageSummary,
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
    confirm: function (message) { return confirm(message); },
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
    confirm: function (message) { return confirm(message); },
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
    confirm: function (message) { return confirm(message); },
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
    confirm: function (message) { return confirm(message); },
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
    confirm: function (message) { return confirm(message); },
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
    confirm: function (message) { return confirm(message); },
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

  loadConfig();
})();
