// Page Source list/editor state, persistence, copying, and dependency checks for options.html.
(function attachOptionsPageController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsPageController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsPageController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsPageController missing dependency: ' + name);
    return value;
  }

  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function isSafeKey(value) {
    return typeof value === 'string' && !UNSAFE_KEYS[value];
  }

  function isSafeId(value) {
    return isSafeKey(value) && value.length > 0;
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function cloneData(value, ancestors, path, stripRuntimeMetadata) {
    path = path || '$';
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType !== 'object') throw new TypeError('页面数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('页面数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
        throw new TypeError('页面数据禁止自定义 toJSON: ' + path);
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
          throw new TypeError('页面数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = arrayDescriptor.value === undefined
          ? null
          : cloneData(arrayDescriptor.value, nextAncestors, path + '[' + index + ']', stripRuntimeMetadata);
      }
      return array;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
      throw new TypeError('页面数据禁止自定义 toJSON: ' + path);
    }
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      if (stripRuntimeMetadata && (key.indexOf('__builtin') === 0 || key === 'mcpValidation')) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('页面数据禁止访问器字段: ' + path + '.' + key);
      }
      if (descriptor.value === undefined || typeof descriptor.value === 'function'
          || typeof descriptor.value === 'symbol') return;
      Object.defineProperty(output, key, {
        value: cloneData(descriptor.value, nextAncestors, path + '.' + key, stripRuntimeMetadata),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    return output;
  }

  function errorText(error, fallback) {
    var ownMessage = ownDataValue(error, 'message');
    var message = ownMessage !== undefined ? ownMessage : error;
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
      throw new Error('PageAutomationLifecycle must load before OptionsPageController');
    }

    var window = options.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    var lifecycle = options.lifecycle || lifecycleFactory.create(window);
    var $ = requireFunction(options.$, '$');
    var esc = requireFunction(options.esc, 'esc');
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var mutateConfig = requireFunction(options.mutateConfig, 'mutateConfig');
    var sortedValues = requireFunction(options.sortedValues, 'sortedValues');
    var renderConfigListItems = requireFunction(options.renderConfigListItems, 'renderConfigListItems');
    var resetConfigListPage = requireFunction(options.resetConfigListPage, 'resetConfigListPage');
    var isBuiltinItem = requireFunction(options.isBuiltinItem, 'isBuiltinItem');
    var itemIdHtml = requireFunction(options.itemIdHtml, 'itemIdHtml');
    var scrollOpenedEditor = requireFunction(options.scrollOpenedEditor, 'scrollOpenedEditor');
    var toast = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var isActive = requireFunction(options.isActive, 'isActive');
    var generatePageId = requireFunction(options.generatePageId, 'generatePageId');

    var initialized = false;
    var destroyed = false;
    var draft = null;
    var draftPendingId = '';
    var draftRevision = 0;
    var draftFormSignature = '';
    var saveInFlight = null;
    var saveRevision = -1;
    var copyInFlight = Object.create(null);
    var targetInFlight = Object.create(null);

    function currentConfig() {
      var config = getConfig();
      return config && typeof config === 'object' ? config : {};
    }

    function pageMap() {
      var pages = ownDataValue(currentConfig(), 'pages');
      return pages && typeof pages === 'object' && !Array.isArray(pages) ? pages : null;
    }

    function findPage(pageId, stripRuntimeMetadata) {
      var pages = pageMap();
      if (!isSafeId(pageId) || !pages) return null;
      var descriptor = Object.getOwnPropertyDescriptor(pages, pageId);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      var page = cloneData(descriptor.value, null, '$', stripRuntimeMetadata);
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw new TypeError('页面配置必须是对象');
      }
      return page;
    }

    function editorElement(id) {
      var element = $('#' + id);
      if (!element) throw new Error('页面编辑器缺少字段: ' + id);
      return element;
    }

    function readEditorData() {
      return {
        label: editorElement('page-label').value,
        url: editorElement('page-url').value,
        matchers: {
          hostnames: editorElement('page-hostnames').value.trim(),
          urlIncludes: editorElement('page-urlincludes').value.trim(),
        },
        autoRefreshMinutes: Number(editorElement('page-refresh').value) || 0,
        captureNetwork: editorElement('page-capture').checked,
        stealthMode: editorElement('page-stealth-mode').checked,
        keepAlive: {
          enabled: editorElement('page-keepalive-enabled').checked,
          intervalMinutes: Math.max(1, Number(editorElement('page-keepalive-interval').value) || 5),
          requestUrl: editorElement('page-keepalive-request-url').value.trim(),
          method: editorElement('page-keepalive-method').value || 'GET',
          expectedStatus: editorElement('page-keepalive-expected-status').value.trim() || '200-399',
          requestTimeoutMs: Math.max(1000, Number(editorElement('page-keepalive-timeout').value) || 15000),
          headers: editorElement('page-keepalive-headers').value.trim(),
          body: editorElement('page-keepalive-body').value,
          lockedSelector: editorElement('page-keepalive-locked-selector').value.trim(),
          healthySelector: editorElement('page-keepalive-healthy-selector').value.trim(),
          versionUrl: editorElement('page-keepalive-version-url').value.trim(),
          activityMode: editorElement('page-keepalive-activity').value || 'none',
          reloadOnSessionExpired: editorElement('page-keepalive-reload-expired').checked,
          reloadOnLocked: editorElement('page-keepalive-reload-locked').checked,
          reloadOnVersionChange: editorElement('page-keepalive-reload-version').checked,
          reloadDiscarded: editorElement('page-keepalive-reload-discarded').checked,
        },
      };
    }

    function editorDataSignature(data) {
      return JSON.stringify(data);
    }

    function applyEditorData(data) {
      var existingMatchers = ownDataValue(draft, 'matchers');
      var existingKeepAlive = ownDataValue(draft, 'keepAlive');
      draft.label = data.label;
      draft.url = data.url;
      draft.matchers = Object.assign({}, existingMatchers && typeof existingMatchers === 'object' ? existingMatchers : {}, data.matchers);
      draft.autoRefreshMinutes = data.autoRefreshMinutes;
      draft.captureNetwork = data.captureNetwork;
      draft.stealthMode = data.stealthMode;
      draft.keepAlive = Object.assign({}, existingKeepAlive && typeof existingKeepAlive === 'object' ? existingKeepAlive : {}, data.keepAlive);
    }

    function syncDraftFromEditor() {
      if (!draft) return null;
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
      if (destroyed || !draft || isBuiltinItem(draft)) return;
      try {
        syncDraftFromEditor();
      } catch (_) {}
    }

    function render() {
      if (destroyed) return { ok: false, destroyed: true };
      var list = $('#pages-list');
      if (!list) return { ok: false, error: '页面列表不存在' };
      var pages = sortedValues(pageMap() || {});
      list.innerHTML = renderConfigListItems('pages', pages, '<div class="placeholder">还没有页面配置，点击「新建页面」开始</div>', function (page) {
        var badges = '';
        var builtin = isBuiltinItem(page);
        if (Number(page.autoRefreshMinutes) > 0) badges += '<span class="badge on">每 ' + esc(page.autoRefreshMinutes) + ' 分钟</span>';
        if (page.keepAlive && page.keepAlive.enabled) badges += '<span class="badge on">保活 ' + esc(page.keepAlive.intervalMinutes || 5) + ' 分钟</span>';
        if (page.captureNetwork) badges += '<span class="badge on">捕获网络</span>';
        if (page.stealthMode) badges += '<span class="badge on">环境补丁</span>';
        if (builtin) badges += '<span class="badge builtin">内置</span>';
        return '<div class="item-card' + (draft && draft.id === page.id ? ' selected' : '') + (builtin ? ' builtin' : '') + '" data-action="edit-page" data-id="' + esc(page.id) + '">'
          + '<span class="item-title">' + esc(page.label || '(未命名)') + '</span>'
          + '<span class="item-sub">' + esc(page.url) + '</span>'
          + badges
          + (builtin
            ? '<button class="btn-small" disabled title="内置页面不能直接修改，请先复制">修改</button>'
              + '<button class="btn-small btn-danger-outline" disabled title="内置页面不能删除">删除</button>'
              + '<button class="btn-small" data-action="copy-page" data-id="' + esc(page.id) + '">复制</button>'
            : '')
          + itemIdHtml(page.id)
          + '</div>';
      });
      renderEditor();
      return { ok: true, draftOpen: !!draft };
    }

    function renderEditor() {
      var editor = $('#page-editor');
      if (!editor) return;
      if (!draft) {
        draftFormSignature = '';
        editor.classList.add('hidden');
        editor.innerHTML = '';
        return;
      }
      var page = draft;
      var readonly = isBuiltinItem(page);
      var keepAlive = page.keepAlive || {};
      editor.classList.remove('hidden');
      editor.innerHTML =
        '<h3>' + (readonly ? '查看内置页面' : (page.id ? '编辑页面' : '新建页面')) + (readonly ? ' <span class="badge builtin">内置</span>' : '') + '</h3>'
        + (readonly ? '<div class="readonly-banner">内置页面来自扩展包，不能直接修改，请先复制为用户页面后编辑。</div>' : '')
        + '<div class="form-grid">'
        + '<div class="form-row"><label>名称</label><input type="text" id="page-label" value="' + esc(page.label) + '" placeholder="如：ERP 报表页"' + (readonly ? ' disabled' : '') + '></div>'
        + '<div class="form-row"><label>页面 URL（打开页面时使用）</label><input type="text" id="page-url" value="' + esc(page.url) + '" placeholder="https://erp.internal.company.com/report"' + (readonly ? ' disabled' : '') + '></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>额外匹配域名（每行一个，可选；页面 URL 的域名自动包含）</label><textarea id="page-hostnames" rows="2" placeholder="erp2.internal.company.com"' + (readonly ? ' disabled' : '') + '>' + esc((page.matchers && page.matchers.hostnames) || '') + '</textarea></div>'
        + '<div class="form-row"><label>URL 包含（可选，用于区分同域名下的不同页面）</label><input type="text" id="page-urlincludes" value="' + esc((page.matchers && page.matchers.urlIncludes) || '') + '" placeholder="/report/"' + (readonly ? ' disabled' : '') + '></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>页面自动刷新间隔（分钟，0=不刷新；仅刷新已打开的标签页）</label><input type="number" id="page-refresh" min="0" value="' + esc(page.autoRefreshMinutes || 0) + '"' + (readonly ? ' disabled' : '') + '></div>'
        + '<div class="form-row checkbox-row form-row-offset"><input type="checkbox" id="page-capture"' + (page.captureNetwork ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-capture">捕获网络请求（供「获取请求返回数据」节点使用，修改后需刷新目标页面生效）</label></div>'
        + '</div>'
        + '<div class="form-row checkbox-row form-row-spaced"><input type="checkbox" id="page-stealth-mode"' + (page.stealthMode ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-stealth-mode">启用页面环境补丁（document_start 覆盖 navigator.webdriver 等，修改后需刷新目标页面生效）</label></div>'
        + '<h4>页面保活</h4>'
        + '<div class="form-grid">'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="page-keepalive-enabled"' + (keepAlive.enabled ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-keepalive-enabled">启用页面保活（仅作用于已打开的匹配标签页）</label></div>'
        + '<div class="form-row"><label>保活间隔（分钟）</label><input type="number" id="page-keepalive-interval" min="1" value="' + esc(keepAlive.intervalMinutes || 5) + '"' + (readonly ? ' disabled' : '') + '></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>心跳请求 URL（可相对当前页面）</label><input type="text" id="page-keepalive-request-url" value="' + esc(keepAlive.requestUrl || '') + '" placeholder="/api/session/ping"' + (readonly ? ' disabled' : '') + '></div>'
        + '<div class="form-row"><label>期望状态码</label><input type="text" id="page-keepalive-expected-status" value="' + esc(keepAlive.expectedStatus || '200-399') + '" placeholder="200-399 / 204 / 200,204"' + (readonly ? ' disabled' : '') + '></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>心跳方法</label><select id="page-keepalive-method"' + (readonly ? ' disabled' : '') + '>'
        + ['GET', 'HEAD', 'POST'].map(function (method) { return '<option value="' + method + '"' + ((keepAlive.method || 'GET') === method ? ' selected' : '') + '>' + method + '</option>'; }).join('')
        + '</select></div>'
        + '<div class="form-row"><label>请求超时(ms)</label><input type="number" id="page-keepalive-timeout" min="1000" value="' + esc(keepAlive.requestTimeoutMs || 15000) + '"' + (readonly ? ' disabled' : '') + '></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>请求头 JSON 或 Key: Value</label><textarea id="page-keepalive-headers" rows="2" placeholder="{&quot;x-keepalive&quot;:&quot;1&quot;}"' + (readonly ? ' disabled' : '') + '>' + esc(keepAlive.headers || '') + '</textarea></div>'
        + '<div class="form-row"><label>请求体（POST 时可选）</label><textarea id="page-keepalive-body" rows="2" placeholder="{&quot;ping&quot;:true}"' + (readonly ? ' disabled' : '') + '>' + esc(keepAlive.body || '') + '</textarea></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>锁屏/过期选择器（出现则认为不可用）</label><input type="text" id="page-keepalive-locked-selector" value="' + esc(keepAlive.lockedSelector || '') + '" placeholder=".lock-screen / .login-modal"' + (readonly ? ' disabled' : '') + '></div>'
        + '<div class="form-row"><label>健康选择器（可选，出现则认为页面正常）</label><input type="text" id="page-keepalive-healthy-selector" value="' + esc(keepAlive.healthySelector || '') + '" placeholder="main .dashboard"' + (readonly ? ' disabled' : '') + '></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>版本检测 URL（可选）</label><input type="text" id="page-keepalive-version-url" value="' + esc(keepAlive.versionUrl || '') + '" placeholder="/version.json / /asset-manifest.json"' + (readonly ? ' disabled' : '') + '></div>'
        + '<div class="form-row"><label>活动模拟</label><select id="page-keepalive-activity" ' + (readonly ? ' disabled' : '') + '>'
        + [
          ['none', '不模拟活动'],
          ['domEvent', 'DOM mousemove（低风险）'],
          ['cdpMouseMove', 'CDP 鼠标移动（更接近真实）'],
        ].map(function (option) { return '<option value="' + option[0] + '"' + ((keepAlive.activityMode || 'none') === option[0] ? ' selected' : '') + '>' + option[1] + '</option>'; }).join('')
        + '</select></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="page-keepalive-reload-expired"' + (keepAlive.reloadOnSessionExpired ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-keepalive-reload-expired">心跳失败/401/403 时刷新页面</label></div>'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="page-keepalive-reload-locked"' + (keepAlive.reloadOnLocked ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-keepalive-reload-locked">检测到锁屏/过期界面时刷新页面</label></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="page-keepalive-reload-version"' + (keepAlive.reloadOnVersionChange ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-keepalive-reload-version">版本检测内容变化时刷新页面</label></div>'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="page-keepalive-reload-discarded"' + (keepAlive.reloadDiscarded !== false ? ' checked' : '') + (readonly ? ' disabled' : '') + '><label for="page-keepalive-reload-discarded">标签页被浏览器丢弃时自动刷新</label></div>'
        + '</div>'
        + '<div class="editor-actions">'
        + (readonly
          ? '<button class="btn-primary" data-action="copy-page" data-id="' + esc(page.id) + '">复制为用户页面</button>'
            + '<button class="btn-secondary" data-action="cancel-page">关闭</button>'
          : '<button class="btn-primary" data-action="save-page">保存</button>'
            + '<button class="btn-secondary" data-action="cancel-page">取消</button>'
            + '<span class="spacer"></span>'
            + (page.id ? '<button class="btn-danger" data-action="delete-page" data-id="' + esc(page.id) + '">删除</button>' : ''))
        + '</div>';
      try {
        draftFormSignature = editorDataSignature(readEditorData());
      } catch (_) {
        draftFormSignature = '';
      }
    }

    function openNew() {
      if (destroyed) return { ok: false, destroyed: true };
      draft = {
        label: '',
        url: '',
        matchers: { hostnames: '', urlIncludes: '' },
        autoRefreshMinutes: 0,
        captureNetwork: false,
        stealthMode: false,
        keepAlive: {
          enabled: false,
          intervalMinutes: 5,
          expectedStatus: '200-399',
          activityMode: 'none',
          reloadDiscarded: true,
        },
      };
      draftPendingId = '';
      draftRevision++;
      draftFormSignature = '';
      if (isActive()) {
        render();
        scrollOpenedEditor('#page-editor');
      }
      return { ok: true };
    }

    function edit(pageId) {
      if (destroyed) return { ok: false, destroyed: true };
      pageId = String(pageId || '');
      var nextDraft;
      try {
        nextDraft = findPage(pageId, false);
      } catch (error) {
        var message = '无法打开页面: ' + errorText(error, '页面数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
      draft = nextDraft;
      draftPendingId = '';
      draftRevision++;
      draftFormSignature = '';
      if (isActive()) {
        render();
        if (draft) scrollOpenedEditor('#page-editor');
      }
      return draft ? { ok: true } : { ok: false, error: '页面不存在' };
    }

    function clearDraft(clearOptions) {
      clearOptions = clearOptions || {};
      draft = null;
      draftPendingId = '';
      draftRevision++;
      draftFormSignature = '';
      if (clearOptions.render !== false && !destroyed && isActive()) render();
      return { ok: !destroyed, destroyed: destroyed };
    }

    function validationFailure(message) {
      if (!destroyed) toast(message, true);
      return Promise.resolve({ ok: false, error: message });
    }

    function targetBusy(pageId, kind) {
      var current = isSafeId(pageId) ? targetInFlight[pageId] : null;
      if (!current) return null;
      return {
        ok: false,
        busy: true,
        operation: current.kind,
        requestedOperation: kind,
        promise: current.promise,
      };
    }

    function busyFailure(busy, revision) {
      var labels = { save: '保存', copy: '复制', delete: '删除' };
      var message = '页面正在' + (labels[busy.operation] || '更新')
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

    function trackTarget(pageId, kind, operation) {
      if (!isSafeId(pageId)) return;
      targetInFlight[pageId] = { kind: kind, promise: operation };
      operation.then(function () {
        if (targetInFlight[pageId] && targetInFlight[pageId].promise === operation) delete targetInFlight[pageId];
      }, function () {
        if (targetInFlight[pageId] && targetInFlight[pageId].promise === operation) delete targetInFlight[pageId];
      });
    }

    function save() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (!draft) return validationFailure('没有可保存的页面');
      if (isBuiltinItem(draft)) return validationFailure('内置页面不能直接修改，请先复制为用户页面');
      var editorData;
      try {
        editorData = syncDraftFromEditor();
      } catch (error) {
        return validationFailure('页面编辑器不可用: ' + errorText(error, '字段缺失'));
      }
      if (!editorData) return validationFailure('页面编辑器不可用');
      var draftId = String(draft.id || '');
      if (saveInFlight && saveRevision === draftRevision) return saveInFlight;

      var item;
      try {
        var clonedDraft = cloneData(draft);
        var clonedMatchers = ownDataValue(clonedDraft, 'matchers');
        var clonedKeepAlive = ownDataValue(clonedDraft, 'keepAlive');
        item = Object.assign({}, clonedDraft, {
          label: editorData.label.trim(),
          url: editorData.url.trim(),
          matchers: Object.assign({}, clonedMatchers && typeof clonedMatchers === 'object' ? clonedMatchers : {}, editorData.matchers),
          autoRefreshMinutes: editorData.autoRefreshMinutes,
          captureNetwork: editorData.captureNetwork,
          stealthMode: editorData.stealthMode,
          keepAlive: Object.assign({}, clonedKeepAlive && typeof clonedKeepAlive === 'object' ? clonedKeepAlive : {}, editorData.keepAlive),
        });
      } catch (error) {
        return validationFailure('无法保存页面: ' + errorText(error, '页面数据无效'));
      }
      if (!item.url) return validationFailure('页面 URL 不能为空');
      if (!draftId) {
        try {
          if (!draftPendingId) draftPendingId = nextPageId();
          item.id = draftPendingId;
          draftId = draftPendingId;
        } catch (error) {
          return validationFailure('无法保存页面: ' + errorText(error, '无法生成页面 ID'));
        }
      }
      var busy = targetBusy(draftId, 'save');
      if (busy) return busyFailure(busy, draftRevision);

      var revision = draftRevision;
      function stillCurrent() {
        return !destroyed && !!draft && revision === draftRevision;
      }
      var mutationStarted = false;
      var saveCommitted = false;
      var operation = Promise.resolve().then(function () {
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        mutationStarted = true;
        return mutateConfig('upsert', 'pages', item);
      }).then(function (config) {
        if (!mutationStarted) return config;
        if (!config) return { ok: false, error: '保存失败' };
        saveCommitted = true;
        if (!stillCurrent()) {
          return {
            ok: true,
            committed: true,
            pageId: draftId,
            draftChanged: !destroyed && !!draft,
            destroyed: destroyed,
          };
        }
        draft = null;
        draftPendingId = '';
        draftRevision++;
        draftFormSignature = '';
        resetConfigListPage('pages');
        toast('页面已保存');
        if (isActive()) render();
        return { ok: true, committed: true, pageId: draftId };
      }).catch(function (error) {
        if (saveCommitted) {
          var refreshMessage = '页面已保存，但刷新失败: ' + errorText(error, '未知错误');
          if (!destroyed) {
            try { toast(refreshMessage, true); } catch (_) {}
          }
          return {
            ok: true,
            committed: true,
            pageId: draftId,
            refreshWarning: refreshMessage,
            destroyed: destroyed,
          };
        }
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        var message = '保存失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, error: message };
      });
      saveInFlight = operation;
      saveRevision = revision;
      trackTarget(draftId, 'save', operation);
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

    function nextPageId() {
      var pages = pageMap() || {};
      var reserved = Object.create(null);
      Object.keys(pages).forEach(function (pageId) { reserved[pageId] = true; });
      Object.keys(targetInFlight).forEach(function (pageId) { reserved[pageId] = true; });
      var pageId = String(generatePageId(reserved) || '');
      if (!isSafeId(pageId)
          || Object.prototype.hasOwnProperty.call(pages, pageId)
          || Object.prototype.hasOwnProperty.call(targetInFlight, pageId)) {
        throw new Error('无法生成页面 ID');
      }
      return pageId;
    }

    function copy(pageId, event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      pageId = String(pageId || '');
      if (!isSafeId(pageId)) return Promise.resolve({ ok: false, error: '页面不存在' });
      if (copyInFlight[pageId]) return copyInFlight[pageId];
      var source;
      var newId;
      var item;
      try {
        source = findPage(pageId, true);
        if (!source) return Promise.resolve({ ok: false, error: '页面不存在' });
        newId = nextPageId();
        item = Object.assign({}, source);
        item.id = newId;
        item.label = String(item.label || item.url || pageId) + ' (副本)';
        delete item.updatedAt;
      } catch (error) {
        var prepareMessage = '复制页面失败: ' + errorText(error, '页面数据无效');
        toast(prepareMessage, true);
        return Promise.resolve({ ok: false, error: prepareMessage });
      }
      var busy = targetBusy(newId, 'copy');
      if (busy) return busyFailure(busy, draftRevision);
      var revision = draftRevision;
      var copyCommitted = false;
      var operation = Promise.resolve().then(function () {
        return mutateConfig('upsert', 'pages', item);
      }).then(function (config) {
        if (!config) return { ok: false, error: '复制失败' };
        copyCommitted = true;
        if (destroyed) return { ok: true, committed: true, pageId: newId, destroyed: true };
        resetConfigListPage('pages');
        var opened = revision === draftRevision;
        if (opened) {
          var copiedPage = findPage(newId, false);
          if (!copiedPage) throw new Error('复制后的页面不存在');
          draft = copiedPage;
          draftPendingId = '';
          draftRevision++;
          draftFormSignature = '';
        }
        toast('已复制为用户页面');
        if (isActive()) {
          render();
          if (opened && draft) scrollOpenedEditor('#page-editor');
        }
        return { ok: true, committed: true, pageId: newId, opened: opened };
      }).catch(function (error) {
        if (copyCommitted) {
          var refreshMessage = '页面已复制，但刷新失败: ' + errorText(error, '未知错误');
          if (!destroyed) {
            try { toast(refreshMessage, true); } catch (_) {}
          }
          return {
            ok: true,
            committed: true,
            pageId: newId,
            refreshWarning: refreshMessage,
            destroyed: destroyed,
          };
        }
        if (destroyed) return { ok: false, destroyed: true };
        var message = '复制页面失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, committed: false, pageId: newId, error: message };
      });
      copyInFlight[pageId] = operation;
      trackTarget(newId, 'copy', operation);
      operation.then(function () {
        if (copyInFlight[pageId] === operation) delete copyInFlight[pageId];
      }, function () {
        if (copyInFlight[pageId] === operation) delete copyInFlight[pageId];
      });
      return operation;
    }

    function remove(pageId) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      pageId = String(pageId || '');
      if (!isSafeId(pageId)) return Promise.resolve({ ok: false, error: '页面不存在' });
      var busy = targetBusy(pageId, 'delete');
      if (busy) {
        if (busy.operation === 'delete') return busy.promise;
        return busyFailure(busy, draftRevision);
      }
      var page;
      try {
        page = findPage(pageId, false);
      } catch (error) {
        var pageMessage = '无法检查页面: ' + errorText(error, '页面数据无效');
        toast(pageMessage, true);
        return Promise.resolve({ ok: false, error: pageMessage });
      }
      if (!page) return Promise.resolve({ ok: false, error: '页面不存在' });
      if (isBuiltinItem(page)) {
        toast('内置页面不能删除，请先复制为用户页面');
        return Promise.resolve({ ok: false, builtin: true, error: '内置页面不能删除，请先复制为用户页面' });
      }
      if (!confirmAction('确定删除该页面配置？')) return Promise.resolve({ ok: false, canceled: true });

      var revision = draftRevision;
      if (draft && String(draft.id) === pageId) revision = ++draftRevision;
      var deleteCommitted = false;
      var operation = Promise.resolve().then(function () {
        return mutateConfig('delete', 'pages', pageId);
      }).then(function (config) {
        if (!config) return { ok: false, error: '删除失败' };
        deleteCommitted = true;
        if (destroyed) return { ok: true, committed: true, destroyed: true };
        if (draft && String(draft.id) === pageId && revision === draftRevision) {
          draft = null;
          draftPendingId = '';
          draftRevision++;
          draftFormSignature = '';
        }
        toast('页面已删除');
        if (isActive()) render();
        return { ok: true, committed: true };
      }).catch(function (error) {
        if (deleteCommitted) {
          var refreshMessage = '页面已删除，但刷新失败: ' + errorText(error, '未知错误');
          if (!destroyed) {
            try { toast(refreshMessage, true); } catch (_) {}
          }
          return {
            ok: true,
            committed: true,
            refreshWarning: refreshMessage,
            destroyed: destroyed,
          };
        }
        if (destroyed) return { ok: false, destroyed: true };
        var message = '删除失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, committed: false, error: message };
      });
      trackTarget(pageId, 'delete', operation);
      return operation;
    }

    function handleAction(action, pageId, event) {
      if (action === 'edit-page') {
        edit(pageId);
        return true;
      }
      if (action === 'save-page') {
        save();
        return true;
      }
      if (action === 'cancel-page') {
        clearDraft();
        return true;
      }
      if (action === 'copy-page') {
        copy(pageId, event);
        return true;
      }
      if (action === 'delete-page') {
        remove(pageId);
        return true;
      }
      return false;
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      lifecycle.listen($('#btn-new-page'), 'click', openNew);
      lifecycle.listen($('#page-editor'), 'input', handleEditorChange);
      lifecycle.listen($('#page-editor'), 'change', handleEditorChange);
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      draft = null;
      draftPendingId = '';
      draftRevision++;
      draftFormSignature = '';
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
          copying: Object.keys(copyInFlight).length > 0,
          mutating: Object.keys(targetInFlight).length > 0,
          draftId: draft && draft.id || '',
          revision: draftRevision,
        };
      },
    };
  }

  return { create: create };
});
