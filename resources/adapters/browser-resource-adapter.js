// ARP/1 BrowserResourceAdapter for browser lifecycle and CDP automation.
(function attachBrowserResourceAdapter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var nodeCrypto = null;
  if (commonJs) {
    try { nodeCrypto = require('crypto'); } catch (_) { nodeCrypto = null; }
  }
  var api = factory(root, core, nodeCrypto);
  if (commonJs) module.exports = api;
  else if (root) root.BrowserResourceAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, core, nodeCrypto) {
  'use strict';
  if (!core) throw new Error('BrowserResourceAdapter requires AgentResourceProtocol');

  function receiptState(status) {
    status = String(status || '');
    return status === 'confirmed' ? 'succeeded' : (status === 'unconfirmed' ? 'unconfirmed' : 'failed');
  }

  var TAB_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'integer' }, windowId: { type: 'integer' }, url: { type: 'string' },
      title: { type: 'string' }, status: { type: 'string' }, active: { type: 'boolean' },
      pinned: { type: 'boolean' }, audible: { type: 'boolean' }, discarded: { type: 'boolean' },
      incognito: { type: 'boolean' }, index: { type: 'integer' }, muted: { type: 'boolean' },
    },
    required: ['id', 'windowId', 'url', 'title', 'active', 'pinned', 'incognito'],
    additionalProperties: true,
  };
  var WINDOW_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'integer' }, focused: { type: 'boolean' }, incognito: { type: 'boolean' },
      type: { type: 'string' }, state: { type: 'string' }, left: { type: 'integer' },
      top: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' },
    },
    required: ['id', 'focused', 'incognito', 'type', 'state'],
    additionalProperties: true,
  };
  var DOWNLOAD_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'integer' }, url: { type: 'string' }, filename: { type: 'string' },
      state: { type: 'string' }, paused: { type: 'boolean' }, canResume: { type: 'boolean' },
      bytesReceived: { type: 'number' }, totalBytes: { type: 'number' }, error: { type: 'string' },
    },
    required: ['id', 'url', 'filename', 'state'],
    additionalProperties: true,
  };
  var CURRENT_EXTENSION_BROWSER_GUIDANCE = '该资源由当前 Page Agent 扩展实例直接读取，是 runtime_context 所属扩展可见浏览器状态的权威来源。外部 MCP 返回的窗口或标签页属于其连接环境，不能替代当前扩展环境的事实。';

  // Keep this bounded diagnostic surface exact and intentionally read-only.
  // Page input is owned by PageActionEngine; raw CDP is neither a second action
  // path nor a failure fallback. Navigation, permission, storage, network mutation,
  // and arbitrary Runtime evaluation stay unavailable here.
  var CDP_COMMAND_ALLOWLIST = Object.freeze({
    'Accessibility.getFullAXTree': true,
    'Accessibility.getPartialAXTree': true,
    'DOM.describeNode': true,
    'DOM.getAttributes': true,
    'DOM.getBoxModel': true,
    'DOM.getDocument': true,
    'DOM.getNodeForLocation': true,
    'DOM.getOuterHTML': true,
    'DOM.querySelector': true,
    'DOM.querySelectorAll': true,
    'Page.captureScreenshot': true,
    'Page.captureSnapshot': true,
    'Page.getLayoutMetrics': true,
  });

  function isCdpCommandAllowed(methodName) {
    var name = typeof methodName === 'string' ? methodName.trim() : '';
    return !!(name && Object.prototype.hasOwnProperty.call(CDP_COMMAND_ALLOWLIST, name));
  }

  function method(input) {
    return Object.assign({
      outputSchema: true,
      safety: 'safe', idempotency: 'inherent', execution: 'sync', permissions: [],
      preconditions: [],
    }, input || {});
  }

  function routeContracts() {
    return [
      new core.RouteContract({
        template: '/browser/tabs', resourceType: 'TabCollection', relation: 'browser-tabs',
        summary: '列出或创建浏览器标签页', tags: ['browser', 'tabs'], entryWeights: { page: 20, global: 10 },
        affordances: [{
          method: 'GET', href: '/browser/tabs', rel: 'list-browser-tabs',
          title: 'runtime_context.pageTarget.bound=false 只表示没有默认页面目标；判断是否存在其他 Tab 时读取此集合。',
        }],
        methods: {
          GET: method({
            inputSchema: {
              type: 'object', properties: {
                windowId: { type: 'integer' }, active: { type: 'boolean' }, currentWindow: { type: 'boolean' },
                limit: { type: 'integer', minimum: 1, maximum: 200 },
              }, additionalProperties: false,
            },
            outputSchema: { type: 'object', properties: { tabs: { type: 'array', items: TAB_SCHEMA } }, required: ['tabs'], additionalProperties: false },
            safety: 'read', permissions: ['browser.read'], relation: 'list-tabs',
            guidance: [CURRENT_EXTENSION_BROWSER_GUIDANCE],
          }),
          POST: method({
            inputSchema: {
              type: 'object', properties: {
                url: { type: 'string', minLength: 1, maxLength: 10000 }, active: { type: 'boolean' },
                windowId: { type: 'integer' }, pinned: { type: 'boolean' }, index: { type: 'integer', minimum: 0 },
                openerTabId: { type: 'integer', minimum: 1, description: '新标签页的 opener 标签页 ID。' },
              }, additionalProperties: false,
            },
            outputSchema: TAB_SCHEMA, safety: 'write', idempotency: 'keyed', permissions: ['browser.tabs.write'],
            relation: 'create-tab',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/tabs/{tabId}', resourceType: 'BrowserTab', relation: 'browser-tab',
        summary: '读取、更新或关闭一个浏览器标签页', tags: ['browser', 'tab'],
        methods: {
          GET: method({ inputSchema: { type: 'object', additionalProperties: false }, outputSchema: TAB_SCHEMA, safety: 'read', permissions: ['browser.read'] }),
          PATCH: method({
            inputSchema: {
              type: 'object', properties: {
                active: { type: 'boolean' }, pinned: { type: 'boolean' }, muted: { type: 'boolean' },
                autoDiscardable: { type: 'boolean' }, highlighted: { type: 'boolean' },
              }, minProperties: 1, additionalProperties: false,
            },
            outputSchema: TAB_SCHEMA, safety: 'write', idempotency: 'inherent', permissions: ['browser.tabs.write'],
            preconditions: ['if-match'], patchMediaTypes: ['application/merge-patch+json'], relation: 'update-tab',
          }),
          DELETE: method({
            inputSchema: null, outputSchema: true, safety: 'write', idempotency: 'inherent', permissions: ['browser.tabs.write'],
            preconditions: ['if-match'], relation: 'close-tab',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/tabs/{tabId}/navigations', resourceType: 'TabNavigation', relation: 'navigate-tab',
        summary: '在现有浏览器标签页中发起一次导航', aliases: ['open url', 'navigate browser', 'go to page'], tags: ['browser', 'navigation'],
        methods: {
          POST: method({
            inputSchema: {
              type: 'object', properties: {
                url: { type: 'string', minLength: 1, maxLength: 10000 }, active: { type: 'boolean' },
              }, required: ['url'], additionalProperties: false,
            },
            outputSchema: { type: 'object', properties: { id: { type: 'string' }, tabId: { type: 'integer' }, url: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'tabId', 'url', 'status'], additionalProperties: true },
            safety: 'execute', idempotency: 'keyed', permissions: ['browser.navigate'], preconditions: ['if-match'],
            relation: 'navigate-tab',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/tabs/{tabId}/navigations/{navigationId}', resourceType: 'TabNavigation', relation: 'tab-navigation',
        summary: '读取一次已保留的标签页导航结果', tags: ['browser', 'navigation'],
        methods: {
          GET: method({
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: { type: 'object', properties: { id: { type: 'string' }, tabId: { type: 'integer' }, url: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'tabId', 'url', 'status'], additionalProperties: true },
            safety: 'read', permissions: ['browser.read'], relation: 'tab-navigation',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/windows', resourceType: 'WindowCollection', relation: 'browser-windows',
        summary: '列出或创建浏览器窗口', tags: ['browser', 'windows'],
        methods: {
          GET: method({
            inputSchema: { type: 'object', properties: { populate: { type: 'boolean' } }, additionalProperties: false },
            outputSchema: { type: 'object', properties: { windows: { type: 'array', items: WINDOW_SCHEMA } }, required: ['windows'], additionalProperties: false },
            safety: 'read', permissions: ['browser.read'], relation: 'list-windows',
            guidance: [CURRENT_EXTENSION_BROWSER_GUIDANCE],
          }),
          POST: method({
            inputSchema: {
              type: 'object', properties: {
                url: { type: 'string', maxLength: 10000 }, focused: { type: 'boolean' }, incognito: { type: 'boolean' },
                type: { type: 'string', enum: ['normal', 'popup'] }, state: { type: 'string', enum: ['normal', 'minimized', 'maximized', 'fullscreen'] },
                left: { type: 'integer' }, top: { type: 'integer' }, width: { type: 'integer', minimum: 100 }, height: { type: 'integer', minimum: 100 },
              }, additionalProperties: false,
            },
            outputSchema: WINDOW_SCHEMA, safety: 'write', idempotency: 'keyed', permissions: ['browser.windows.write'],
            relation: 'create-window',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/windows/{windowId}', resourceType: 'BrowserWindow', relation: 'browser-window',
        summary: '读取、更新或关闭一个浏览器窗口', tags: ['browser', 'window'],
        methods: {
          GET: method({ inputSchema: { type: 'object', additionalProperties: false }, outputSchema: WINDOW_SCHEMA, safety: 'read', permissions: ['browser.read'] }),
          PATCH: method({
            inputSchema: {
              type: 'object', properties: {
                focused: { type: 'boolean' }, state: { type: 'string', enum: ['normal', 'minimized', 'maximized', 'fullscreen'] },
                left: { type: 'integer' }, top: { type: 'integer' }, width: { type: 'integer', minimum: 100 }, height: { type: 'integer', minimum: 100 },
              }, minProperties: 1, additionalProperties: false,
            },
            outputSchema: WINDOW_SCHEMA, safety: 'write', idempotency: 'inherent', permissions: ['browser.windows.write'],
            preconditions: ['if-match'], patchMediaTypes: ['application/merge-patch+json'], relation: 'update-window',
          }),
          DELETE: method({
            inputSchema: null, outputSchema: true, safety: 'write', idempotency: 'inherent', permissions: ['browser.windows.write'],
            preconditions: ['if-match'], relation: 'close-window',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/downloads', resourceType: 'DownloadCollection', relation: 'browser-downloads',
        summary: '列出下载任务或启动一个明确指定的下载', tags: ['browser', 'download'],
        methods: {
          GET: method({
            inputSchema: {
              type: 'object', properties: {
                state: { type: 'string', enum: ['in_progress', 'interrupted', 'complete'] },
                limit: { type: 'integer', minimum: 1, maximum: 200 },
              }, additionalProperties: false,
            },
            outputSchema: { type: 'object', properties: { downloads: { type: 'array', items: DOWNLOAD_SCHEMA } }, required: ['downloads'], additionalProperties: false },
            safety: 'read', permissions: ['browser.downloads.read'], relation: 'list-downloads',
          }),
          POST: method({
            inputSchema: {
              type: 'object', properties: {
                url: { type: 'string', minLength: 1, maxLength: 10000 }, filename: { type: 'string', maxLength: 1000 },
                conflictAction: { type: 'string', enum: ['uniquify', 'overwrite', 'prompt'] }, saveAs: { type: 'boolean' },
              }, required: ['url'], additionalProperties: false,
            },
            outputSchema: DOWNLOAD_SCHEMA, safety: 'execute', idempotency: 'keyed', permissions: ['browser.downloads.write'],
            relation: 'start-download',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/downloads/{downloadId}', resourceType: 'BrowserDownload', relation: 'browser-download',
        summary: '读取一个浏览器下载任务', tags: ['browser', 'download'],
        methods: {
          GET: method({ inputSchema: { type: 'object', additionalProperties: false }, outputSchema: DOWNLOAD_SCHEMA, safety: 'read', permissions: ['browser.downloads.read'] }),
        },
      }),
      new core.RouteContract({
        template: '/browser/cdp-sessions', resourceType: 'CdpSessionCollection', relation: 'cdp-sessions',
        summary: '为浏览器自动化创建一个 debugger 会话', tags: ['browser', 'cdp', 'privileged'],
        methods: {
          POST: method({
            inputSchema: { type: 'object', properties: { tabId: { type: 'integer', minimum: 1 }, protocolVersion: { type: 'string', enum: ['1.3'], description: '声明性字段：实际 attach 版本固定为 1.3。' } }, required: ['tabId'], additionalProperties: false },
            outputSchema: { type: 'object', properties: { id: { type: 'string' }, tabId: { type: 'integer' }, state: { type: 'string' }, attachedAt: { type: 'string' } }, required: ['id', 'tabId', 'state', 'attachedAt'], additionalProperties: true },
            safety: 'privileged', idempotency: 'keyed', permissions: ['browser.debugger'],
            relation: 'create-cdp-session',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/cdp-sessions/{sessionId}', resourceType: 'CdpSession', relation: 'cdp-session',
        summary: '读取或分离一个 debugger 会话', tags: ['browser', 'cdp', 'privileged'],
        methods: {
          GET: method({ inputSchema: { type: 'object', additionalProperties: false }, outputSchema: true, safety: 'privileged', permissions: ['browser.debugger'] }),
          DELETE: method({
            inputSchema: null, outputSchema: true, safety: 'privileged', idempotency: 'inherent', permissions: ['browser.debugger'],
            preconditions: ['if-match'], relation: 'detach-cdp-session',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/cdp-sessions/{sessionId}/commands', resourceType: 'CdpCommand', relation: 'send-cdp-command',
        summary: '通过现有 debugger 会话发送一条白名单命令', tags: ['browser', 'cdp', 'privileged'],
        methods: {
          POST: method({
            inputSchema: {
              type: 'object', properties: {
                method: { type: 'string', enum: Object.keys(CDP_COMMAND_ALLOWLIST) }, params: { type: 'object' },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
              }, required: ['method'], additionalProperties: false,
            },
            outputSchema: { type: 'object', properties: { id: { type: 'string' }, sessionId: { type: 'string' }, method: { type: 'string' }, performed: { type: 'string' }, result: true }, required: ['id', 'sessionId', 'method', 'performed'], additionalProperties: true },
            safety: 'privileged', idempotency: 'keyed', permissions: ['browser.debugger'],
            relation: 'send-cdp-command',
          }),
        },
      }),
      new core.RouteContract({
        template: '/browser/cdp-sessions/{sessionId}/commands/{commandId}', resourceType: 'CdpCommand', relation: 'cdp-command',
        summary: '读取一次已保留的 CDP 命令结果', tags: ['browser', 'cdp', 'privileged'],
        methods: {
          GET: method({
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: { type: 'object', properties: { id: { type: 'string' }, sessionId: { type: 'string' }, method: { type: 'string' }, performed: { type: 'string' }, result: true }, required: ['id', 'sessionId', 'method', 'performed'], additionalProperties: true },
            safety: 'privileged', permissions: ['browser.debugger'], relation: 'cdp-command',
          }),
        },
      }),
    ];
  }

  function encodeSegment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function hashString(value) {
    var text = String(value);
    var hash = 2166136261;
    for (var index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function etag(type, data) {
    return '"' + type + '-' + hashString(core.stableStringify(data)) + '"';
  }

  function randomId(prefix, cryptoObject) {
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return prefix + '_' + cryptoObject.randomUUID();
    if (nodeCrypto && typeof nodeCrypto.randomUUID === 'function') return prefix + '_' + nodeCrypto.randomUUID();
    var bytes;
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      bytes = new Uint8Array(16); cryptoObject.getRandomValues(bytes);
    } else if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') bytes = new Uint8Array(nodeCrypto.randomBytes(16));
    else throw new Error('BrowserResourceAdapter requires secure random identifiers');
    return prefix + '_' + Array.prototype.map.call(bytes, function (item) { return item.toString(16).padStart(2, '0'); }).join('');
  }

  function tabData(tab) {
    tab = tab || {};
    return {
      id: Number(tab.id), windowId: Number(tab.windowId), url: String(tab.url || tab.pendingUrl || ''),
      title: String(tab.title || ''), status: String(tab.status || ''), active: tab.active === true,
      pinned: tab.pinned === true, audible: tab.audible === true, discarded: tab.discarded === true,
      incognito: tab.incognito === true, index: Number(tab.index) || 0,
      muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
    };
  }

  function windowData(windowValue) {
    windowValue = windowValue || {};
    return {
      id: Number(windowValue.id), focused: windowValue.focused === true, incognito: windowValue.incognito === true,
      type: String(windowValue.type || 'normal'), state: String(windowValue.state || 'normal'),
      left: Number(windowValue.left) || 0, top: Number(windowValue.top) || 0,
      width: Number(windowValue.width) || 0, height: Number(windowValue.height) || 0,
    };
  }

  function downloadData(download) {
    download = download || {};
    return {
      id: Number(download.id), url: String(download.url || ''), filename: String(download.filename || ''),
      state: String(download.state || 'in_progress'), paused: download.paused === true,
      canResume: download.canResume === true, bytesReceived: Number(download.bytesReceived) || 0,
      totalBytes: Number(download.totalBytes) || 0, error: String(download.error || ''),
    };
  }

  function tabRepresentation(tab) {
    var data = tabData(tab);
    var uri = '/browser/tabs/' + encodeSegment(data.id);
    return {
      uri: uri, type: 'BrowserTab', etag: etag('tab', data), data: data,
      links: [
        { rel: 'self', href: uri, method: 'GET' },
        { rel: 'navigate-tab', href: uri + '/navigations', method: 'POST' },
        { rel: 'introspect', href: uri, method: 'OPTIONS' },
      ],
    };
  }

  function windowRepresentation(windowValue) {
    var data = windowData(windowValue);
    var uri = '/browser/windows/' + encodeSegment(data.id);
    return {
      uri: uri, type: 'BrowserWindow', etag: etag('window', data), data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'introspect', href: uri, method: 'OPTIONS' }],
    };
  }

  function downloadRepresentation(download) {
    var data = downloadData(download);
    var uri = '/browser/downloads/' + encodeSegment(data.id);
    return {
      uri: uri, type: 'BrowserDownload', etag: etag('download', data), data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }],
    };
  }

  function cdpSessionRepresentation(session) {
    var uri = '/browser/cdp-sessions/' + encodeSegment(session.id);
    var data = {
      id: session.id, tabId: session.tabId, state: session.state,
      attachedAt: session.attachedAt, expiresAt: session.expiresAt,
      detachedAt: session.detachedAt || '', detachReason: session.detachReason || '',
    };
    return {
      uri: uri, type: 'CdpSession', etag: etag('cdp-session', data), data: data,
      links: [
        { rel: 'self', href: uri, method: 'GET' },
        { rel: 'send-cdp-command', href: uri + '/commands', method: 'POST' },
        { rel: 'introspect', href: uri, method: 'OPTIONS' },
      ],
    };
  }

  function privilegedVisible(context) {
    context = context || {};
    var permissions = context.permissionScope || context.permissions || [];
    return Array.isArray(permissions) && permissions.indexOf('browser.debugger') !== -1;
  }

  function securityBinding(context) {
    context = context && typeof context === 'object' ? context : {};
    var binding = {
      actorId: String(context.actorId || context.actor || ''),
      conversationId: String(context.conversationId || context.conversation || ''),
      entryContext: String(context.entryContext || context.entry || ''),
      origin: String(context.origin || ''),
      permissionScope: (Array.isArray(context.permissionScope) ? context.permissionScope : []).map(String).sort(),
      currentTabId: Number(context.currentTabId) || 0,
      currentWindowId: Number(context.currentWindowId) || 0,
      incognito: context.incognito === true,
    };
    if (!binding.actorId || !binding.conversationId || !binding.entryContext) {
      throw core.arpError('FORBIDDEN', 'CDP 必须具有绑定 actor、conversation 和 entry 的安全上下文', { performed: 'no' });
    }
    return binding;
  }

  function sameSecurityBinding(left, right) {
    // 会话归属 = 谁（actor）在哪个会话里、以什么权限、在哪个档案（incognito）。
    // 入口类型、入口 origin、绑定 tab/window 只是入口的"当前状态"描述，
    // 不参与归属判定——sidepanel 跟随切换 tab 不应导致自己丢失会话。
    return left && right
      && left.actorId === right.actorId
      && left.conversationId === right.conversationId
      && left.incognito === right.incognito
      && core.stableStringify(left.permissionScope) === core.stableStringify(right.permissionScope);
  }

  function urlOrigin(value) {
    try {
      var parsed = new URL(String(value || ''));
      return parsed.protocol + '//' + parsed.host;
    } catch (_) { return ''; }
  }

  function actionOwner(context) {
    return String(context && (context.generationId || context.turnId || context.topicId || context.conversationId || context.actorId) || 'browser-resource');
  }

  function createBrowserResourceAdapter(options) {
    options = options || {};
    var chromeApi = options.chrome || root && root.chrome;
    var cdpSessionManager = options.cdpSessionManager;
    var pageAutomation = options.pageAutomation;
    if (!chromeApi || !chromeApi.tabs || !chromeApi.windows) throw new Error('createBrowserResourceAdapter requires chrome tabs and windows APIs');
    if (!pageAutomation || !pageAutomation.action) throw new Error('BrowserResourceAdapter requires PageAutomationRuntime');
    ['query', 'get', 'create', 'update', 'remove'].forEach(function (name) {
      if (typeof chromeApi.tabs[name] !== 'function') throw new Error('BrowserResourceAdapter requires chrome.tabs.' + name);
    });
    ['getAll', 'get', 'create', 'update', 'remove'].forEach(function (name) {
      if (typeof chromeApi.windows[name] !== 'function') throw new Error('BrowserResourceAdapter requires chrome.windows.' + name);
    });
    var supportsDownloads = !!chromeApi.downloads;
    if (supportsDownloads) ['search', 'download'].forEach(function (name) {
      if (typeof chromeApi.downloads[name] !== 'function') throw new Error('BrowserResourceAdapter requires chrome.downloads.' + name);
    });
    var supportsDebugger = !!(chromeApi.debugger && cdpSessionManager);
    var cryptoObject = options.crypto || root && root.crypto;
    var routes = routeContracts().filter(function (route) {
      if (route.template.indexOf('/browser/downloads') === 0) return supportsDownloads;
      if (route.template.indexOf('/browser/cdp-sessions') === 0) return supportsDebugger;
      return true;
    });
    var cdpSessions = new Map();
    var navigationResults = new Map();
    var commandResults = new Map();
    var maxRetainedOperationResults = 100;
    var cdpSessionTtlMs = Math.max(5000, Math.min(Number(options.cdpSessionTtlMs) || 5 * 60 * 1000, 30 * 60 * 1000));

    function chromeCall(target, name, args) {
      try { return Promise.resolve(target[name].apply(target, args || [])); }
      catch (error) { return Promise.reject(error); }
    }

    function translateError(error, performed) {
      if (error instanceof core.ArpError) return error;
      return core.arpError('UPSTREAM_FAILED', String(error && error.message || 'Browser API 操作失败'), {
        performed: performed || 'no', retryable: performed === 'no',
        details: { browserError: String(error && error.message || error || '').slice(0, 2000) },
      });
    }

    function retainOperationResult(store, id, value) {
      store.set(String(id), value);
      while (store.size > maxRetainedOperationResults) store.delete(store.keys().next().value);
    }

    function operationRepresentation(uri, type, data, parentRel, parentUri) {
      return {
        uri: uri, type: type, data: data,
        links: [
          { rel: 'self', href: uri, method: 'GET' },
          { rel: parentRel, href: parentUri, method: 'GET' },
          { rel: 'capabilities', href: uri, method: 'OPTIONS' },
        ],
      };
    }

    function get(context, request) {
      var template = request.routeTemplate;
      if (template === '/browser/tabs') {
        var query = Object.assign({}, request.query || {});
        var limit = Math.max(1, Math.min(Number(query.limit) || 100, 200));
        delete query.limit;
        return chromeCall(chromeApi.tabs, 'query', [query]).then(function (tabs) {
          var representations = (tabs || []).slice(0, limit).map(tabRepresentation);
          return {
            primary: { uri: '/browser/tabs', type: 'TabCollection', data: { tabs: representations.map(function (item) { return item.data; }) }, links: [{ rel: 'introspect', href: '/browser/tabs', method: 'OPTIONS' }] },
            included: representations,
            schemaValue: { tabs: representations.map(function (item) { return item.data; }) },
          };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/tabs/{tabId}') {
        return chromeCall(chromeApi.tabs, 'get', [Number(request.params.tabId)]).then(function (tab) {
          var representation = tabRepresentation(tab);
          return { primary: representation, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/tabs/{tabId}/navigations/{navigationId}') {
        var navigation = navigationResults.get(String(request.params.navigationId || ''));
        if (!navigation || Number(request.params.tabId) !== navigation.tabId) {
          throw core.arpError('RESOURCE_GONE', '标签页导航结果未被保留');
        }
        if (!sameSecurityBinding(securityBinding(context), navigation.owner)) {
          throw core.arpError('FORBIDDEN', '标签页导航结果属于其他安全上下文', { performed: 'no' });
        }
        var navigationUri = '/browser/tabs/' + encodeSegment(request.params.tabId) + '/navigations/' + encodeSegment(request.params.navigationId);
        var navigationRepresentation = operationRepresentation(navigationUri, 'TabNavigation', navigation.data, 'tab', '/browser/tabs/' + encodeSegment(request.params.tabId));
        return Promise.resolve({ primary: navigationRepresentation, schemaValue: navigation.data });
      }
      if (template === '/browser/windows') {
        return chromeCall(chromeApi.windows, 'getAll', [{ populate: request.query && request.query.populate === true }]).then(function (windows) {
          var representations = (windows || []).map(windowRepresentation);
          return {
            primary: { uri: '/browser/windows', type: 'WindowCollection', data: { windows: representations.map(function (item) { return item.data; }) }, links: [{ rel: 'introspect', href: '/browser/windows', method: 'OPTIONS' }] },
            included: representations,
            schemaValue: { windows: representations.map(function (item) { return item.data; }) },
          };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/windows/{windowId}') {
        return chromeCall(chromeApi.windows, 'get', [Number(request.params.windowId)]).then(function (windowValue) {
          var representation = windowRepresentation(windowValue);
          return { primary: representation, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/downloads') {
        var search = {};
        if (request.query && request.query.state) search.state = request.query.state;
        search.limit = Math.max(1, Math.min(Number(request.query && request.query.limit) || 100, 200));
        search.orderBy = ['-startTime'];
        return chromeCall(chromeApi.downloads, 'search', [search]).then(function (downloads) {
          var representations = (downloads || []).map(downloadRepresentation);
          return {
            primary: { uri: '/browser/downloads', type: 'DownloadCollection', data: { downloads: representations.map(function (item) { return item.data; }) }, links: [{ rel: 'introspect', href: '/browser/downloads', method: 'OPTIONS' }] },
            included: representations,
            schemaValue: { downloads: representations.map(function (item) { return item.data; }) },
          };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/downloads/{downloadId}') {
        return chromeCall(chromeApi.downloads, 'search', [{ id: Number(request.params.downloadId) }]).then(function (downloads) {
          if (!downloads || !downloads[0]) throw core.arpError('RESOURCE_NOT_FOUND', '找不到 Browser 下载任务');
          var representation = downloadRepresentation(downloads[0]);
          return { primary: representation, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/cdp-sessions/{sessionId}') {
        return verifyOwnedSession(context, request.params.sessionId).then(function (session) {
          var sessionRepresentation = cdpSessionRepresentation(session);
          return { primary: sessionRepresentation, schemaValue: sessionRepresentation.data };
        });
      }
      if (template === '/browser/cdp-sessions/{sessionId}/commands/{commandId}') {
        var command = commandResults.get(String(request.params.commandId || ''));
        if (!command || String(request.params.sessionId || '') !== command.sessionId) {
          throw core.arpError('RESOURCE_GONE', 'CDP 命令结果未被保留');
        }
        if (!sameSecurityBinding(securityBinding(context), command.owner)) {
          throw core.arpError('FORBIDDEN', 'CDP 命令结果属于其他安全上下文', { performed: 'no' });
        }
        var commandUri = '/browser/cdp-sessions/' + encodeSegment(request.params.sessionId) + '/commands/' + encodeSegment(request.params.commandId);
        var commandRepresentation = operationRepresentation(commandUri, 'CdpCommand', command.data, 'session', '/browser/cdp-sessions/' + encodeSegment(request.params.sessionId));
        return Promise.resolve({ primary: commandRepresentation, schemaValue: command.data });
      }
      throw core.arpError('RESOURCE_NOT_FOUND', '未知 Browser 资源路由');
    }

    function attachDebugger(tabId, version, owner) {
      void version;
      return cdpSessionManager.acquire(tabId, { owner: 'AgentGeneration:' + String(owner || 'browser-resource'), type: 'raw-cdp' });
    }

    function detachDebugger(session) {
      return session && session.lease ? session.lease.release() : Promise.resolve(false);
    }

    function sendCdp(session, methodName, params, timeoutMs) {
      if (!session || !session.lease) return Promise.reject(core.arpError('RESOURCE_GONE', 'CDP 会话 lease 不可用'));
      return session.lease.send(methodName, params || {}, timeoutMs).then(function (result) { return result === undefined ? null : result; });
    }

    function assertTargetScope(binding, tab) {
      // 入口不构成能力边界：任何入口都可调试任意 tab。唯一保留的是隐身档案
      // 边界——它是 Chrome 的真实隔离边界，不是入口策略。
      if (binding.incognito !== (tab.incognito === true)) {
        throw core.arpError('FORBIDDEN', 'CDP 目标跨越了当前上下文的隐身边界', { performed: 'no' });
      }
    }

    function invalidateAndDetach(session, reason, finalError, details) {
      session.invalidated = true;
      session.invalidatedAt = new Date().toISOString();
      session.invalidationReason = String(reason || 'target_invalidated');
      return detachDebugger(session).then(function () {
        session.state = 'detached';
        session.detachedAt = new Date().toISOString();
        session.detachReason = session.invalidationReason;
        cdpSessions.delete(session.id);
        throw finalError;
      }, function (detachError) {
        // onDetach may have removed the record before the detach callback reports.
        if (!cdpSessions.has(session.id)) throw finalError;
        throw core.arpError('UPSTREAM_FAILED', '无法分离已经失效的 CDP 会话', {
          performed: 'unknown',
          retryable: false,
          details: Object.assign({}, details || {}, {
            reason: session.invalidationReason,
            debuggerError: String(detachError && detachError.message || detachError),
          }),
        });
      });
    }

    function verifyOwnedSession(context, sessionId) {
      var session = cdpSessions.get(String(sessionId || ''));
      if (!session) return Promise.reject(core.arpError('RESOURCE_GONE', 'CDP 会话未被保留'));
      var binding;
      try { binding = securityBinding(context); }
      catch (error) { return Promise.reject(error); }
      if (!sameSecurityBinding(binding, session.owner)) {
        return Promise.reject(core.arpError('FORBIDDEN', 'CDP 会话属于其他 actor、conversation、entry 或目标上下文', { performed: 'no' }));
      }
      if (session.invalidated === true) {
        return invalidateAndDetach(
          session,
          session.invalidationReason,
          core.arpError('RESOURCE_GONE', 'CDP 会话已失效并被分离', { performed: 'no' })
        );
      }
      if (Date.now() >= session.expiresAtMs) {
        return invalidateAndDetach(
          session,
          'expired',
          core.arpError('RESOURCE_GONE', 'CDP 会话已过期并被分离', { performed: 'no' })
        );
      }
      return chromeCall(chromeApi.tabs, 'get', [session.tabId]).then(function (tab) {
        assertTargetScope(binding, tab);
        return session;
      });
    }

    function post(context, request) {
      var template = request.routeTemplate;
      var body = request.body || {};
      if (template === '/browser/tabs') {
        var createOwner = actionOwner(context);
        return pageAutomation.action.act({ source: 'agent', owner: createOwner, tabId: 0, kind: 'createTab', input: body }).then(function (result) {
          var tab = result.derivedFacts.createdTab;
          if (!tab || !(Number(tab.id) > 0)) throw new Error('PageActionEngine did not return the created tab');
          var representation = tabRepresentation(tab);
          return {
            statusCode: 201,
            primary: representation,
            receipt: Object.assign({}, result.receipt, {
              state: receiptState(result.receipt.status),
              verificationStatus: result.receipt.status,
              operationUri: representation.uri,
            }),
            schemaValue: representation.data,
          };
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/tabs/{tabId}/navigations') {
        var navigationId = randomId('navigation', cryptoObject);
        var navigationTabId = Number(request.params.tabId);
        var owner = actionOwner(context);
        return pageAutomation.action.act({ source: 'agent', owner: owner, tabId: navigationTabId, kind: 'navigate', input: { url: body.url } }).then(function (result) {
          var activation = body.active === true
            ? pageAutomation.action.act({ source: 'agent', owner: owner, tabId: navigationTabId, kind: 'activateTab', input: {} })
            : Promise.resolve(null);
          return activation.then(function (activationResult) {
          return chromeCall(chromeApi.tabs, 'get', [navigationTabId]).then(function (tab) {
          var uri = '/browser/tabs/' + encodeSegment(request.params.tabId) + '/navigations/' + encodeSegment(navigationId);
          var actionReceipt = result.receipt;
          var data = { id: navigationId, tabId: navigationTabId, url: String(body.url), status: actionReceipt.status, performed: actionReceipt.performed, actionReceipt: actionReceipt, activationReceipt: activationResult && activationResult.receipt || null, verification: actionReceipt.verification };
          retainOperationResult(navigationResults, navigationId, { tabId: navigationTabId, owner: securityBinding(context), data: data });
          return {
            statusCode: 201,
            primary: operationRepresentation(uri, 'TabNavigation', data, 'tab', '/browser/tabs/' + encodeSegment(request.params.tabId)),
            included: tab ? [tabRepresentation(tab)] : [],
            receipt: Object.assign({}, actionReceipt, {
              state: receiptState(actionReceipt.status),
              verificationStatus: actionReceipt.status,
              operationUri: uri,
            }),
            schemaValue: data,
          };
          });
          });
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/windows') {
        return chromeCall(chromeApi.windows, 'create', [body]).then(function (windowValue) {
          var representation = windowRepresentation(windowValue);
          return { statusCode: 201, primary: representation, receipt: { performed: 'yes', state: 'succeeded', operationUri: representation.uri }, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/downloads') {
        return chromeCall(chromeApi.downloads, 'download', [body]).then(function (downloadId) {
          return chromeCall(chromeApi.downloads, 'search', [{ id: Number(downloadId) }]).then(function (downloads) {
            var raw = downloads && downloads[0] || { id: downloadId, url: body.url, filename: body.filename || '', state: 'in_progress' };
            var representation = downloadRepresentation(raw);
            return { statusCode: 201, primary: representation, receipt: { performed: 'yes', state: 'running', operationUri: representation.uri }, schemaValue: representation.data };
          });
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/cdp-sessions') {
        var sessionId = randomId('cdp_session', cryptoObject);
        var owner = securityBinding(context);
        var requestedTabId = Number(body.tabId);
        return chromeCall(chromeApi.tabs, 'get', [requestedTabId]).then(function (tab) {
          assertTargetScope(owner, tab);
          return attachDebugger(requestedTabId, body.protocolVersion || '1.3', actionOwner(context)).then(function (lease) {
            var attachedAtMs = Date.now();
            var session = {
              id: sessionId,
              tabId: requestedTabId,
              state: 'attached',
              attachedAt: new Date(attachedAtMs).toISOString(),
              expiresAt: new Date(attachedAtMs + cdpSessionTtlMs).toISOString(),
              expiresAtMs: attachedAtMs + cdpSessionTtlMs,
              owner: owner,
              lease: lease,
              target: {
                targetId: '',
                windowId: Number(tab.windowId),
                incognito: tab.incognito === true,
                origin: urlOrigin(tab.url || tab.pendingUrl),
              },
            };
            cdpSessions.set(sessionId, session);
            var representation = cdpSessionRepresentation(session);
            return { statusCode: 201, primary: representation, receipt: { performed: 'yes', state: 'succeeded', operationUri: representation.uri }, schemaValue: representation.data };
          });
        });
      }
      if (template === '/browser/cdp-sessions/{sessionId}/commands') {
        if (!isCdpCommandAllowed(body.method)) {
          throw core.arpError('SCHEMA_VALIDATION_FAILED', '此路由契约不支持该 CDP 命令', {
            performed: 'no',
            details: { method: String(body.method || '') },
          });
        }
        var commandId = randomId('cdp_command', cryptoObject);
        return verifyOwnedSession(context, request.params.sessionId).then(function (retained) {
          return sendCdp(retained, body.method, body.params || {}, body.timeoutMs).then(function (result) {
            var uri = '/browser/cdp-sessions/' + encodeSegment(retained.id) + '/commands/' + encodeSegment(commandId);
            var data = { id: commandId, sessionId: retained.id, method: body.method, performed: 'yes', result: result };
            retainOperationResult(commandResults, commandId, { sessionId: retained.id, owner: securityBinding(context), data: data });
            return {
              statusCode: 201,
              primary: operationRepresentation(uri, 'CdpCommand', data, 'session', '/browser/cdp-sessions/' + encodeSegment(retained.id)),
              receipt: { performed: 'yes', state: 'succeeded', operationUri: uri }, schemaValue: data,
            };
          });
        });
      }
      throw core.arpError('RESOURCE_NOT_FOUND', '未知 Browser 创建路由');
    }

    function patch(context, request) {
      var template = request.routeTemplate;
      var patchValue = request.patch || {};
      if (template === '/browser/tabs/{tabId}') {
        var patchTabId = Number(request.params.tabId);
        var patchOwner = actionOwner(context);
        var activation = patchValue.active === true
          ? pageAutomation.action.act({ source: 'agent', owner: patchOwner, tabId: patchTabId, kind: 'activateTab', input: {} })
          : Promise.resolve(null);
        var remainingPatch = Object.assign({}, patchValue);
        if (remainingPatch.active === true) delete remainingPatch.active;
        return activation.then(function (activationResult) {
          var updated = Object.keys(remainingPatch).length
            ? chromeCall(chromeApi.tabs, 'update', [patchTabId, remainingPatch])
            : chromeCall(chromeApi.tabs, 'get', [patchTabId]);
          return updated.then(function (tab) {
          var representation = tabRepresentation(tab);
          var receipt = activationResult && activationResult.receipt
            ? Object.assign({}, activationResult.receipt, { state: receiptState(activationResult.receipt.status), verificationStatus: activationResult.receipt.status })
            : { performed: 'yes', state: 'succeeded' };
          return { primary: representation, receipt: receipt, schemaValue: representation.data };
          });
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/windows/{windowId}') {
        return chromeCall(chromeApi.windows, 'update', [Number(request.params.windowId), patchValue]).then(function (windowValue) {
          var representation = windowRepresentation(windowValue);
          return { primary: representation, receipt: { performed: 'yes', state: 'succeeded' }, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      throw core.arpError('RESOURCE_NOT_FOUND', '未知 Browser 局部修改路由');
    }

    function remove(context, request) {
      var template = request.routeTemplate;
      if (template === '/browser/tabs/{tabId}') {
        var closeTabId = Number(request.params.tabId);
        var closeOwner = actionOwner(context);
        return pageAutomation.action.act({ source: 'agent', owner: closeOwner, tabId: closeTabId, kind: 'closeTab', input: {} }).then(function (result) {
          var actionReceipt = result.receipt;
          return {
            statusCode: 204,
            data: null,
            receipt: Object.assign({}, actionReceipt, {
              state: receiptState(actionReceipt.status),
              verificationStatus: actionReceipt.status,
            }),
            schemaValue: null,
          };
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/windows/{windowId}') {
        return chromeCall(chromeApi.windows, 'remove', [Number(request.params.windowId)]).then(function () {
          return { statusCode: 204, data: null, receipt: { performed: 'yes', state: 'succeeded' }, schemaValue: null };
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      if (template === '/browser/cdp-sessions/{sessionId}') {
        if (!cdpSessions.has(String(request.params.sessionId))) {
          return Promise.resolve({ statusCode: 204, data: null, receipt: { performed: 'no', state: 'succeeded' }, schemaValue: null });
        }
        return verifyOwnedSession(context, request.params.sessionId).then(function (session) {
          return detachDebugger(session).then(function () {
          session.state = 'detached'; session.detachedAt = new Date().toISOString(); session.detachReason = 'requested';
          cdpSessions.delete(session.id);
          return { statusCode: 204, data: null, receipt: { performed: 'yes', state: 'succeeded' }, schemaValue: null };
          });
        }).catch(function (error) { throw translateError(error, 'unknown'); });
      }
      throw core.arpError('RESOURCE_NOT_FOUND', '未知 Browser 删除路由');
    }

    function preconditionState(context, request, route, params) {
      var template = route && route.template || request.routeTemplate;
      params = params || request.params || {};
      if (template === '/browser/tabs/{tabId}' || template === '/browser/tabs/{tabId}/navigations') {
        return chromeCall(chromeApi.tabs, 'get', [Number(params.tabId)]).then(function (tab) {
          var representation = tabRepresentation(tab);
          return { exists: true, etag: representation.etag, current: representation };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/windows/{windowId}') {
        return chromeCall(chromeApi.windows, 'get', [Number(params.windowId)]).then(function (windowValue) {
          var representation = windowRepresentation(windowValue);
          return { exists: true, etag: representation.etag, current: representation };
        }).catch(function (error) { throw translateError(error, 'no'); });
      }
      if (template === '/browser/cdp-sessions/{sessionId}') {
        var session = cdpSessions.get(String(params.sessionId));
        if (!session) return Promise.resolve({ exists: false, gone: true });
        if (!sameSecurityBinding(securityBinding(context), session.owner)) {
          return Promise.reject(core.arpError('FORBIDDEN', 'CDP 会话属于其他安全上下文', { performed: 'no' }));
        }
        var representation = cdpSessionRepresentation(session);
        return Promise.resolve({ exists: true, etag: representation.etag, current: representation });
      }
      return Promise.resolve({ exists: true });
    }

    function descriptor(route, methodName, href) {
      var contract = route.methods[methodName];
      return new core.CapabilityDescriptor({
        method: methodName, href: href, relation: contract.relation || route.relation,
        summary: contract.summary || route.summary, inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema, safety: contract.safety, idempotency: contract.idempotency,
        execution: contract.execution, requiredPermissions: contract.permissions,
        requiredPreconditions: contract.preconditions, patchMediaTypes: contract.patchMediaTypes,
      });
    }

    function introspect(context, request) {
      var uri = core.canonicalizeUri(request.uri);
      var matched = routes.find(function (route) { return !!route.match(uri); });
      if (!matched) return [];
      if (matched.template.indexOf('/cdp-sessions') !== -1 && !privilegedVisible(context)) return [];
      return Object.keys(matched.methods).map(function (methodName) { return descriptor(matched, methodName, uri); });
    }

    if (supportsDebugger && typeof cdpSessionManager.onDetach === 'function') {
      cdpSessionManager.onDetach(function (event) {
        if (!event || event.managed !== true) return;
        cdpSessions.forEach(function (session) {
          if (Number(session.tabId) !== Number(event && event.tabId)) return;
          session.state = 'detached'; session.detachedAt = new Date().toISOString(); session.detachReason = String(event.reason || 'browser');
          cdpSessions.delete(session.id);
        });
      });
    }

    var adapter = core.defineAdapter({
      root: 'browser', routeContracts: routes, get: get, post: post, patch: patch, delete: remove, introspect: introspect,
    });
    adapter.preconditionState = preconditionState;
    return adapter;
  }

  return Object.freeze({
    API_VERSION: 1,
    CDP_COMMAND_ALLOWLIST: CDP_COMMAND_ALLOWLIST,
    isCdpCommandAllowed: isCdpCommandAllowed,
    createAdapter: createBrowserResourceAdapter,
    createBrowserResourceAdapter: createBrowserResourceAdapter,
    createRouteContracts: routeContracts,
    routeContracts: routeContracts,
  });
});
