// Message Router — 中央消息调度器
(function attachMessageRouter(root, factory) {
  root.MessageRouter = factory();
})(globalThis, function () {

  function createMessageRouter(deps) {
    deps = deps || {};

    var getState = deps.getState || (function () { return {}; });
    var addLog = deps.addLog || (function () {});
    var setNodeStatus = deps.setNodeStatus || (function () {});
    var registerTab = deps.registerTab || (function () {});
    var executeNode = deps.executeNode || (function () {});
    var executeNodeInstance = deps.executeNodeInstance || null;
    var getFirstUnfinishedNodeId = deps.getFirstUnfinishedNodeId || (function () { return null; });
    var isNodeDoneStatus = deps.isNodeDoneStatus || (function () { return false; });
    var requestStop = deps.requestStop || (function () {});
    var detectSourceFromLocation = deps.detectSourceFromLocation || (function () { return 'unknown-source'; });
    var getOrderedNodes = deps.getOrderedNodes || (function () { return []; });
    var getTargetDefinitions = deps.getTargetDefinitions || (function () { return {}; });
    var getSourceByTabId = deps.getSourceByTabId || (function () { return null; });
    var checkTabReadiness = deps.checkTabReadiness || null;
    var conversationCommandBus = deps.conversationCommandBus || null;
    var exportConversationBackup = deps.exportConversationBackup || null;
    var importConversationBackup = deps.importConversationBackup || null;
    var prepareConversationArchiveExport = deps.prepareConversationArchiveExport || null;
    var readConversationArchiveExportRange = deps.readConversationArchiveExportRange || null;
    var releaseConversationArchiveExport = deps.releaseConversationArchiveExport || null;
    var getConfig = deps.getConfig || (function () { return { pages: {} }; });
    var chromeApi = deps.chrome || (typeof chrome !== 'undefined' ? chrome : null);
    var pageAutomation = deps.pageAutomation || null;

    function positiveTabId(value) {
      var number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
    }

    function webTab(tab) {
      return !!(tab && positiveTabId(tab.id) && /^(?:https?|file):/i.test(String(tab.url || tab.pendingUrl || '')));
    }

    function selectorToolPage(payload) {
      payload = payload || {};
      var pageId = String(payload.pageId || '').trim();
      var pageUrl = String(payload.pageUrl || '').trim();
      if (!pageUrl && pageId) {
        try {
          var config = getConfig() || {};
          var page = config.pages && config.pages[pageId];
          pageUrl = String(page && page.url || '').trim();
        } catch (_) {}
      }
      return { pageId: pageId, pageUrl: pageUrl };
    }

    function selectorTabScore(tab, pageUrl, preferredWindowId) {
      if (!webTab(tab)) return -1;
      var score = Number(tab.lastAccessed) || 0;
      if (positiveTabId(preferredWindowId) && Number(tab.windowId) === positiveTabId(preferredWindowId)) score += 1e15;
      if (tab.active) score += 2e15;
      if (!pageUrl) return score;
      var actual = String(tab.url || tab.pendingUrl || '');
      try {
        var expectedUrl = new URL(pageUrl);
        var actualUrl = new URL(actual);
        if (expectedUrl.hostname !== actualUrl.hostname) return -1;
        score += 4e15;
        var expectedHref = expectedUrl.href.replace(/[#?].*$/, '').replace(/\/$/, '');
        var actualHref = actualUrl.href.replace(/[#?].*$/, '').replace(/\/$/, '');
        if (actualHref === expectedHref) score += 4e15;
        else if (actualHref.indexOf(expectedHref + '/') === 0) score += 2e15;
      } catch (_) {
        if (actual.indexOf(pageUrl) !== 0) return -1;
        score += 4e15;
      }
      return score;
    }

    function resolveSelectorToolTab(payload) {
      payload = payload || {};
      if (!chromeApi || !chromeApi.tabs) return Promise.reject(new Error('浏览器标签页 API 不可用'));
      var explicitTabId = positiveTabId(payload.tabId || payload.activeTabId);
      if (explicitTabId) {
        return Promise.resolve(chromeApi.tabs.get(explicitTabId)).then(function (tab) {
          if (!webTab(tab)) throw new Error('指定 tabId 不是可操作网页');
          return tab;
        });
      }
      var page = selectorToolPage(payload);
      var preferredWindowId = positiveTabId(payload.windowId);
      return Promise.resolve(chromeApi.tabs.query({})).then(function (tabs) {
        var ranked = (tabs || []).map(function (tab) {
          return { tab: tab, score: selectorTabScore(tab, page.pageUrl, preferredWindowId) };
        }).filter(function (item) { return item.score >= 0; })
          .sort(function (left, right) { return right.score - left.score; });
        if (ranked.length) return ranked[0].tab;
        if (page.pageUrl) throw new Error('未找到已打开的目标页面: ' + page.pageUrl);
        throw new Error('未找到可用于选择器工具的网页标签页');
      });
    }

    function activateExtensionTab(tabId, focusWindow) {
      if (!pageAutomation || !pageAutomation.action || typeof pageAutomation.action.act !== 'function') {
        return Promise.reject(new Error('统一页面动作引擎尚未就绪'));
      }
      return pageAutomation.action.act({
        source: 'script',
        owner: 'extension-ui:element-picker',
        tabId: Number(tabId),
        kind: 'activateTab',
        input: { focusWindow: focusWindow === true },
        timeoutMs: 10000,
      }).then(function (result) {
        if (!result || !result.receipt || result.receipt.status === 'failed') {
          throw new Error(result && result.receipt && result.receipt.verification && result.receipt.verification.reason || '标签页激活失败');
        }
        return result;
      });
    }

    var ARP_METHODS = Object.freeze({ GET: true, POST: true, PUT: true, PATCH: true, DELETE: true, OPTIONS: true });
    var ARP_SECURITY_CONTEXT_KEYS = Object.freeze({
      actor: true, actorId: true,
      conversation: true, conversationId: true,
      entry: true, entryContext: true,
      tabId: true, currentTabId: true,
      windowId: true, currentWindowId: true,
      origin: true,
      permissionScope: true, permissions: true,
      currentResource: true, visibleResourceUris: true,
    });
    var ARP_REQUEST_KEYS = Object.freeze({
      GET: Object.freeze({ uri: true, ifNoneMatch: true }),
      POST: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, body: true }),
      PUT: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, body: true }),
      PATCH: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, contentType: true, patch: true }),
      DELETE: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, body: true }),
      OPTIONS: Object.freeze({ uri: true, match: true, relation: true, cursor: true, limit: true }),
    });
    var ARP_PRECONDITION_KEYS = Object.freeze({ ifMatch: true, ifNoneMatch: true });
    var ARP_PATCH_MEDIA_TYPES = Object.freeze({
      'application/merge-patch+json': true,
    });
    var ARP_OPTION_PERMISSIONS = Object.freeze([
      'flows.read', 'flows.write', 'flows.delete',
      'flows.nodes.read', 'flows.nodes.write', 'flows.nodes.delete',
      'node-types.read',
      'flow-groups.read', 'flow-groups.write', 'flow-groups.delete',
      'runs.read', 'runs.report.read', 'runs.debug.read',
      'runs.execute', 'runs.cancel', 'runs.delete',
      'conversations.read', 'conversations.write', 'conversations.delete',
      'recordings.read',
      'knowledge.read', 'knowledge.write', 'knowledge.delete',
      'pages.read', 'pages.write', 'pages.delete',
      'schedules.read', 'schedules.write', 'schedules.delete',
      'url-triggers.read', 'url-triggers.write', 'url-triggers.delete',
      'scripts.read', 'scripts.write', 'scripts.delete',
      'config.read', 'skills.read', 'skills.write', 'skills.delete',
      'assistants.read', 'assistants.write', 'assistants.delete',
      'model-services.read', 'model-services.write', 'model-services.delete',
      'model-services.execute', 'agent-settings.read', 'agent-settings.write',
      'connections.read', 'connections.write', 'connections.execute',
      'mcp-servers.read', 'mcp-servers.write', 'mcp-servers.delete', 'mcp-servers.call', 'mcp-calls.read',
    ]);
    var ARP_SIDEPANEL_PERMISSIONS = Object.freeze([
      'page.read', 'page.interact',
      'browser.read', 'browser.navigate', 'browser.downloads.read',
      'flows.read', 'flows.nodes.read', 'node-types.read',
      'flow-groups.read',
      'runs.read', 'runs.report.read', 'runs.debug.read',
      'runs.execute', 'runs.cancel',
      'conversations.read', 'conversations.write',
      'recordings.read',
      'knowledge.read', 'pages.read',
      'schedules.read', 'url-triggers.read', 'scripts.read',
      'config.read', 'skills.read',
      'assistants.read', 'agent-settings.read',
      'connections.read', 'mcp-servers.read', 'mcp-calls.read',
    ]);
    var ARP_PAGE_PERMISSIONS = Object.freeze([
      'page.read', 'page.interact',
      'browser.read', 'browser.navigate',
      'conversations.read', 'conversations.write',
      'recordings.read',
      'knowledge.read', 'skills.read',
    ]);

    function cloneForMessage(value) {
      try {
        return JSON.parse(JSON.stringify(value === undefined ? null : value));
      } catch (err) {
        return { __error: '数据不可序列化: ' + (err && err.message ? err.message : String(err)) };
      }
    }

    function typedFailure(error, fallbackKind) {
      var source = error && typeof error === 'object' ? error : {};
      return {
        ok: false,
        error: source.message ? String(source.message) : String(error || '运行失败'),
        errorKind: String(source.errorKind || fallbackKind || 'runtime_error'),
        retryable: source.retryable === true,
        details: source.details === undefined ? undefined : cloneForMessage(source.details),
      };
    }

    function isOptionsPageSender(sender) {
      sender = sender || {};
      var url = String(sender.url || sender.origin || '').trim();
      if (!url) return false;
      if (chromeApi && chromeApi.runtime && chromeApi.runtime.id && sender.id
          && String(sender.id) !== String(chromeApi.runtime.id)) return false;
      try {
        if (chromeApi && chromeApi.runtime && chromeApi.runtime.getURL) {
          return url.split('#')[0].split('?')[0] === chromeApi.runtime.getURL('options/options.html');
        }
      } catch (_) {}
      return /\/options\/options\.html(?:[?#].*)?$/.test(url);
    }

    function isSidepanelPageSender(sender) {
      sender = sender || {};
      var url = String(sender.url || sender.origin || '').trim();
      if (!url) return false;
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          return url.split('#')[0].split('?')[0] === chrome.runtime.getURL('sidepanel/sidepanel.html');
        }
      } catch (_) {}
      return /\/sidepanel\/sidepanel\.html(?:[?#].*)?$/.test(url);
    }

    function arpSenderSurface(sender) {
      sender = sender || {};
      if (chromeApi && chromeApi.runtime && chromeApi.runtime.id && sender.id
          && String(sender.id) !== String(chromeApi.runtime.id)) return '';
      if (isOptionsPageSender(sender)) return 'options';
      if (isSidepanelPageSender(sender)) return 'sidepanel';
      var tab = sender.tab || {};
      var url = String(sender.url || tab.url || '').trim();
      if (Number(tab.id) > 0 && /^(?:https?|file):/i.test(url)) return 'page';
      return '';
    }

    function arpActiveTab() {
      return new Promise(function (resolve) {
        if (!chromeApi || !chromeApi.tabs || typeof chromeApi.tabs.query !== 'function') {
          resolve(null);
          return;
        }
        var settled = false;
        function finish(tabs) {
          if (settled) return;
          settled = true;
          resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
        }
        try {
          var returned = chromeApi.tabs.query({ active: true, lastFocusedWindow: true }, finish);
          if (returned && typeof returned.then === 'function') returned.then(finish, function () { finish([]); });
        } catch (_) { finish([]); }
      });
    }

    function arpUrlOrigin(value) {
      try {
        var parsed = new URL(String(value || ''));
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
        if (parsed.protocol === 'chrome-extension:' && parsed.host) return parsed.protocol + '//' + parsed.host;
      } catch (_) {}
      return '';
    }

    function arpExtensionOrigin(sender) {
      var senderOrigin = arpUrlOrigin(sender && (sender.origin || sender.url));
      if (senderOrigin && senderOrigin.indexOf('chrome-extension://') === 0) return senderOrigin;
      try {
        return arpUrlOrigin(chromeApi && chromeApi.runtime && chromeApi.runtime.getURL
          ? chromeApi.runtime.getURL('/')
          : '');
      } catch (_) { return ''; }
    }

    function arpClientContext(raw) {
      if (raw === undefined || raw === null) return {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('ARP UI context must be an object');
      }
      Object.keys(raw).forEach(function (key) {
        if (ARP_SECURITY_CONTEXT_KEYS[key]) {
          throw new Error('ARP UI security context is background-owned: ' + key);
        }
        if (key !== 'requestTag') throw new Error('Unsupported ARP UI context field: ' + key);
      });
      var requestTag = String(raw.requestTag || '').trim();
      if (requestTag.length > 160) throw new Error('ARP UI requestTag is too long');
      return requestTag ? { requestTag: requestTag } : {};
    }

    function arpAssertRecord(value, label) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
      return value;
    }

    function arpAssertAllowedKeys(value, allowed, label) {
      arpAssertRecord(value, label);
      Object.keys(value).forEach(function (key) {
        if (allowed[key]) return;
        if (ARP_SECURITY_CONTEXT_KEYS[key]) throw new Error('ARP UI security context is background-owned: ' + key);
        throw new Error(label + ' contains an unsupported field: ' + key);
      });
    }

    function arpAssertNonEmptyString(value, label, maxLength) {
      if (typeof value !== 'string' || !value.length || value !== value.trim() || value.length > (maxLength || 12000)) {
        throw new Error(label + ' must be a bounded non-empty string');
      }
    }

    function arpValidateUiRequest(method, request) {
      arpAssertAllowedKeys(request, ARP_REQUEST_KEYS[method], method + ' ARP request');
      arpAssertNonEmptyString(request.uri, 'ARP resource uri', 12000);
      if (request.uri.charAt(0) !== '/') throw new Error('ARP resource uri must be an absolute path');
      if (request.ifNoneMatch !== undefined) arpAssertNonEmptyString(request.ifNoneMatch, 'ifNoneMatch', 12000);
      if (request.preconditions !== undefined) {
        arpAssertAllowedKeys(request.preconditions, ARP_PRECONDITION_KEYS, 'ARP preconditions');
        Object.keys(request.preconditions).forEach(function (key) {
          arpAssertNonEmptyString(request.preconditions[key], 'ARP preconditions.' + key, 12000);
        });
      }
      if (request.idempotencyKey !== undefined) {
        arpAssertNonEmptyString(request.idempotencyKey, 'idempotencyKey', 256);
        if (request.idempotencyKey.length < 8) throw new Error('idempotencyKey must contain at least 8 characters');
      }
      if ((method === 'POST' || method === 'PUT') && !Object.prototype.hasOwnProperty.call(request, 'body')) {
        throw new Error(method + ' ARP request requires body');
      }
      if (method === 'PATCH') {
        if (!Object.prototype.hasOwnProperty.call(request, 'patch')) throw new Error('PATCH ARP request requires patch');
        if (request.contentType !== undefined && !ARP_PATCH_MEDIA_TYPES[request.contentType]) {
          throw new Error('PATCH contentType is unsupported');
        }
      }
      if (method === 'OPTIONS') {
        ['match', 'relation', 'cursor'].forEach(function (key) {
          if (request[key] !== undefined) arpAssertNonEmptyString(request[key], 'OPTIONS ' + key, key === 'match' ? 1000 : 200);
        });
        if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 4)) {
          throw new Error('OPTIONS limit must be an integer from 1 to 4');
        }
      }
      return request;
    }

    function arpDocumentBinding(sender, surface, tab) {
      var documentId = String(sender && sender.documentId || '').trim();
      if (documentId) return documentId.slice(0, 240);
      var senderTabId = Number(sender && sender.tab && sender.tab.id) || 0;
      var tabId = senderTabId || Number(tab && tab.id) || 0;
      var windowId = Number(sender && sender.tab && sender.tab.windowId) || Number(tab && tab.windowId) || 0;
      return (tabId ? 'tab-' + tabId : (windowId ? 'window-' + windowId : surface));
    }

    function arpPermissionsForSurface(surface) {
      if (surface === 'options') return ARP_OPTION_PERMISSIONS.slice();
      if (surface === 'sidepanel') return ARP_SIDEPANEL_PERMISSIONS.slice();
      return ARP_PAGE_PERMISSIONS.slice();
    }

    function arpSecurityContext(sender, surface, tab, request, clientContext) {
      var senderTab = surface === 'page' ? sender && sender.tab : null;
      var boundTab = senderTab || (surface === 'sidepanel' ? tab : null) || {};
      var tabId = Number(boundTab.id) || 0;
      var windowId = Number(boundTab.windowId) || 0;
      var requestTarget = String(request && request.uri || '');
      var requestUri = requestTarget.split('?')[0];
      var pageScoped = requestUri.indexOf('/page/') === 0 || requestUri.indexOf('/browser/') === 0;
      var extensionOrigin = arpExtensionOrigin(sender);
      var pageOrigin = arpUrlOrigin(boundTab.url || boundTab.pendingUrl || sender && sender.url);
      var runtimeId = String(chromeApi && chromeApi.runtime && chromeApi.runtime.id || 'extension');
      return Object.assign({}, clientContext || {}, {
        actorId: 'ui:' + runtimeId + ':' + surface,
        conversationId: 'ui:' + surface + ':' + arpDocumentBinding(sender, surface, boundTab),
        entryContext: surface === 'options' ? 'global' : 'page',
        origin: pageScoped ? pageOrigin : extensionOrigin,
        permissionScope: arpPermissionsForSurface(surface),
        currentResource: requestUri,
        visibleResourceUris: requestUri ? [requestUri] : [],
        currentTabId: tabId,
        currentWindowId: windowId,
        incognito: !!boundTab.incognito,
      });
    }

    function arpResourceDispatcher() {
      if (typeof deps.dispatchResource === 'function') return deps.dispatchResource;
      return null;
    }

    function dispatchArpUiRequest(message, sender) {
      var payload = message && message.payload || {};
      try { arpAssertAllowedKeys(payload, Object.freeze({ method: true, request: true, context: true }), 'ARP transport payload'); }
      catch (error) { return Promise.reject(error); }
      var method = String(payload.method || '').trim().toUpperCase();
      if (!ARP_METHODS[method]) return Promise.reject(new Error('Unsupported ARP resource method: ' + method));
      if (!payload.request || typeof payload.request !== 'object' || Array.isArray(payload.request)) {
        return Promise.reject(new Error('ARP resource request must be an object'));
      }
      var surface = arpSenderSurface(sender);
      if (!surface) return Promise.reject(new Error('ARP resource requests are only accepted from trusted extension UI contexts'));
      var request = cloneForMessage(payload.request);
      var clientContext;
      try {
        arpValidateUiRequest(method, request);
        clientContext = arpClientContext(payload.context);
      }
      catch (error) { return Promise.reject(error); }
      var tabPromise = surface === 'sidepanel' ? arpActiveTab() : Promise.resolve(sender && sender.tab || null);
      return tabPromise.then(function (tab) {
        var dispatcher = arpResourceDispatcher();
        if (!dispatcher) throw new Error('ARP Resource Router is unavailable');
        var context = arpSecurityContext(sender, surface, tab, request, clientContext);
        return Promise.resolve(dispatcher(method, request, context));
      });
    }

    var DEBUG_MESSAGE_TOTAL_BUDGET = 512 * 1024;
    var DEBUG_MESSAGE_STRING_PREVIEW = 12000;
    var DEBUG_MESSAGE_ARRAY_ITEMS = 200;
    var DEBUG_MESSAGE_OBJECT_KEYS = 200;
    var DEBUG_MESSAGE_MAX_DEPTH = 8;

    function createDebugMessageBudget() {
      return { remaining: DEBUG_MESSAGE_TOTAL_BUDGET, exhausted: false };
    }

    function consumeDebugMessageBudget(budget, amount) {
      if (!budget || budget.exhausted) return !!(budget && budget.exhausted);
      budget.remaining -= Math.max(0, Number(amount) || 0);
      if (budget.remaining < 0) budget.exhausted = true;
      return budget.exhausted;
    }

    function debugMessageOmitted(reason, extra) {
      return Object.assign({ __omitted: true, reason: reason || 'debug-message-budget' }, extra || {});
    }

    function splitDebugPathList(raw) {
      if (Array.isArray(raw)) return raw.map(function (v) { return String(v || '').trim(); }).filter(Boolean);
      return String(raw || '').split(/[,\n]/).map(function (v) { return v.trim(); }).filter(Boolean);
    }

    function resolveDebugPath(obj, path) {
      if (!path) return obj;
      var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
      var parts = normalized.split('.').filter(Boolean);
      var cur = obj;
      for (var i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }

    function setDebugPath(target, path, value) {
      var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
      var parts = normalized.split('.').filter(Boolean);
      if (!parts.length) return;
      var cur = target;
      for (var i = 0; i < parts.length - 1; i++) {
        var key = parts[i];
        if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
        cur = cur[key];
      }
      cur[parts[parts.length - 1]] = value;
    }

    function cloneDebugContext(ctx, options) {
      options = options || {};
      var mode = String(options.ctxMode || options.contextMode || options.mode || '').trim();
      if (mode === 'none' || mode === 'omit') return {};
      if (mode === 'paths') {
        var out = {};
        var budget = createDebugMessageBudget();
        splitDebugPathList(options.ctxPaths || options.contextPaths || options.paths).forEach(function (path) {
          if (!path || budget.exhausted) return;
          var value = resolveDebugPath(ctx || {}, path);
          if (value === undefined) return;
          setDebugPath(out, path, cloneForDebugMessage(value, 0, [], budget));
        });
        if (budget.exhausted) out.__omitted = debugMessageOmitted('debug-message-budget');
        return out;
      }
      return cloneForDebugMessage(ctx);
    }

    function cloneForDebugMessage(value, depth, seen, budget) {
      depth = depth || 0;
      seen = seen || [];
      budget = budget || createDebugMessageBudget();
      if (budget.exhausted) return debugMessageOmitted('debug-message-budget');
      if (value === undefined) return null;
      if (value === null) {
        consumeDebugMessageBudget(budget, 4);
        return null;
      }
      var type = typeof value;
      if (type === 'string') {
        consumeDebugMessageBudget(budget, Math.min(value.length, DEBUG_MESSAGE_STRING_PREVIEW));
        if (value.length > DEBUG_MESSAGE_STRING_PREVIEW) {
          return debugMessageOmitted('string-too-large', {
            type: 'string',
            length: value.length,
            preview: value.slice(0, DEBUG_MESSAGE_STRING_PREVIEW),
          });
        }
        return value;
      }
      if (type === 'number' || type === 'boolean') {
        consumeDebugMessageBudget(budget, 16);
        return value;
      }
      if (type === 'bigint') {
        var bigintText = String(value) + 'n';
        consumeDebugMessageBudget(budget, bigintText.length);
        return bigintText;
      }
      if (type === 'function') return { __type: 'function', name: value.name || '' };
      if (type !== 'object') return String(value);
      if (seen.indexOf(value) !== -1) return '[Circular]';
      if (depth >= DEBUG_MESSAGE_MAX_DEPTH) return debugMessageOmitted('max-depth', { depth: depth });

      seen.push(value);
      try {
        if (Array.isArray(value)) {
          var arr = [];
          var len = value.length;
          var limit = Math.min(len, DEBUG_MESSAGE_ARRAY_ITEMS);
          for (var i = 0; i < limit; i++) {
            if (budget.exhausted) {
              arr.push(debugMessageOmitted('debug-message-budget'));
              break;
            }
            arr.push(cloneForDebugMessage(value[i], depth + 1, seen, budget));
          }
          if (len > limit) arr.push(debugMessageOmitted('array-items-limit', { omittedItems: len - limit, length: len }));
          return arr;
        }

        if (value instanceof Error) {
          return {
            __type: 'error',
            name: value.name || 'Error',
            message: value.message || '',
            stack: value.stack ? String(value.stack).slice(0, DEBUG_MESSAGE_STRING_PREVIEW) : '',
          };
        }

        var keys = Object.keys(value);
        var out = {};
        var keyLimit = Math.min(keys.length, DEBUG_MESSAGE_OBJECT_KEYS);
        for (var j = 0; j < keyLimit; j++) {
          var key = keys[j];
          if (consumeDebugMessageBudget(budget, key.length)) {
            out.__omitted = true;
            out.__omittedReason = 'debug-message-budget';
            break;
          }
          try {
            out[key] = cloneForDebugMessage(value[key], depth + 1, seen, budget);
          } catch (err) {
            out[key] = { __error: '数据不可序列化: ' + (err && err.message ? err.message : String(err)) };
          }
          if (budget.exhausted) {
            out.__omitted = true;
            out.__omittedReason = 'debug-message-budget';
            break;
          }
        }
        if (keys.length > keyLimit) {
          out.__omittedKeys = keys.length - keyLimit;
          out.__totalKeys = keys.length;
        }
        return out;
      } finally {
        seen.pop();
      }
    }

    function unwrapNodeInstanceResult(result) {
      if (result && Object.prototype.hasOwnProperty.call(result, 'result')) return result.result;
      return result;
    }

    function handleMessage(message, sender, sendResponse) {
      var type = message.type;

      switch (type) {

        case 'ARP_RESOURCE_REQUEST': {
          dispatchArpUiRequest(message, sender).then(function (envelope) {
            sendResponse({ ok: true, payload: cloneForMessage(envelope) });
          }).catch(function (err) {
            sendResponse(typedFailure(err, 'arp_resource_transport_error'));
          });
          return true;
        }

        case 'GET_STATE': {
          var state = getState();
          // 注入计算属性供 sidepanel 使用
          var enriched = Object.assign({}, state);
          if (enriched.flowId && getOrderedNodes) {
            enriched._orderedNodes = getOrderedNodes(enriched.flowId);
          }
          if (enriched.flowId && getTargetDefinitions) {
            enriched._targets = getTargetDefinitions(enriched.flowId);
          }
          sendResponse({ ok: true, payload: enriched });
          break;
        }

        case 'CHECK_TAB_READINESS': {
          if (!checkTabReadiness) { sendResponse({ ok: false, error: '未接线' }); return; }
          var readyPayload = message.payload || {};
          checkTabReadiness(readyPayload.tabId || 0).then(function (result) {
            sendResponse({ ok: true, payload: cloneForMessage(result) });
          }).catch(function (err) {
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
          });
          return true;
        }

        case 'EXECUTE_NODE': {
          var nodeId = message.payload && message.payload.nodeId;
          if (!nodeId) {
            sendResponse({ ok: false, error: 'Missing nodeId' });
            return;
          }
          setNodeStatus(nodeId, 'running');
          executeNode(nodeId, getState())
            .then(function (result) {
              setNodeStatus(nodeId, 'completed');
              sendResponse({ ok: true, payload: result });
            })
            .catch(function (err) {
              setNodeStatus(nodeId, 'failed');
              sendResponse({ ok: false, error: err.message });
            });
          return true; // 保持异步通道开启
        }

        case 'EXECUTE_NODE_INSTANCE': {
          if (!executeNodeInstance) { sendResponse({ ok: false, error: '未接线' }); return; }
          var stepPayload = message.payload || {};
          var stepNode = stepPayload.node || {};
          if (!stepNode.type) {
            sendResponse({ ok: false, error: '单步节点缺少 type' });
            return;
          }
          if (stepNode.nodeId) setNodeStatus(stepNode.nodeId, 'running');
          executeNodeInstance(stepNode, {
            flowId: stepPayload.flowId || '',
            context: stepPayload.context || {},
            resetContext: stepPayload.resetContext !== false,
          }).then(function (result) {
            if (stepNode.nodeId) setNodeStatus(stepNode.nodeId, 'completed');
            sendResponse({ ok: true, payload: result });
          }).catch(function (err) {
            if (stepNode.nodeId) setNodeStatus(stepNode.nodeId, 'failed');
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
          });
          return true;
        }

        case 'NODE_COMPLETE': {
          var nId = message.nodeId;
          if (nId) {
            setNodeStatus(nId, 'completed');
            addLog('节点完成: ' + nId, { nodeId: nId });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'NODE_ERROR': {
          var eId = message.nodeId;
          var errMsg = message.error || '未知错误';
          if (eId) {
            setNodeStatus(eId, 'failed');
            addLog('节点失败: ' + eId + ' — ' + errMsg, { nodeId: eId, level: 'error' });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'STOP_FLOW': {
          var stopPayload = message.payload || {};
          var stopOperation;
          if (stopPayload.runId && deps.stopSession) {
            // 会话级停止：不动全局命令队列，避免误伤其它并行运行
            addLog('收到停止信号 (runId=' + stopPayload.runId + ')', { scope: 'run', runId: stopPayload.runId });
            stopOperation = deps.stopSession(stopPayload.runId);
          } else {
            addLog('收到停止信号（全部）');
            stopOperation = requestStop();
          }
          Promise.resolve(stopOperation).then(function (result) {
            sendResponse({ ok: true, payload: result || {} });
          }).catch(function (err) {
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
          });
          return true;
        }

        case 'GET_SESSIONS': {
          sendResponse({ ok: true, payload: deps.getSessions ? deps.getSessions() : [] });
          break;
        }

        case 'GET_RUN_CONTEXT': {
          // 获取指定会话的运行上下文（用于调试面板）
          var payload = message.payload || {};
          var runId = payload.runId || message.runId;
          if (!runId || !deps.getSessionExecutor) {
            sendResponse({ ok: false, error: '未找到会话' });
            break;
          }
          var executor = deps.getSessionExecutor(runId);
          if (!executor) {
            sendResponse({ ok: false, error: '会话不存在' });
            break;
          }
          var ctx = executor.getCtx ? executor.getCtx() : {};
          sendResponse({ ok: true, payload: cloneDebugContext(ctx, payload) });
          break;
        }

        case 'GET_DEBUG_TRACE': {
          // 获取指定会话的调试追踪记录
          var payload = message.payload || {};
          var runId = payload.runId || message.runId;
          if (!runId || !deps.getSessionExecutor) {
            sendResponse({ ok: false, error: '未找到会话' });
            break;
          }
          var executor = deps.getSessionExecutor(runId);
          if (!executor) {
            sendResponse({ ok: false, error: '会话不存在' });
            break;
          }
          var trace = executor.getDebugTrace ? executor.getDebugTrace() : [];
          sendResponse({ ok: true, payload: cloneForDebugMessage(trace) });
          break;
        }

        case 'CLEAR_FINISHED_SESSIONS': {
          if (!deps.clearFinishedSessions) { sendResponse({ ok: false, error: '未接线' }); break; }
          sendResponse({ ok: true, payload: deps.clearFinishedSessions() });
          break;
        }

        case 'LOG': {
          addLog(message.message, {
            level: message.level,
            nodeId: message.nodeId,
            source: message.source,
            scope: message.scope,
            tabId: message.tabId,
            windowId: message.windowId,
            flowId: message.flowId,
            runId: message.runId,
          });
          sendResponse({ ok: true });
          break;
        }

        case 'PING': {
          sendResponse({ ok: true, source: message.source || 'background' });
          break;
        }

        case 'RESUME_FROM_NODE': {
          var rp = message.payload || {};
          // 优先按 runId 复用既有会话（保留上下文变量）
          if (rp.runId && deps.resumeSession) {
            deps.resumeSession(rp.runId, rp.nodeId).then(function (r) {
              sendResponse({ ok: true, payload: r });
            }).catch(function (err) {
              sendResponse({ ok: false, error: err.message });
            });
            return true;
          }
          if (!deps.resumeFlowFrom) { sendResponse({ ok: false, error: '未接线' }); return; }
          deps.resumeFlowFrom(rp.flowId, rp.nodeId, {
            ownerTabId: rp.ownerTabId || rp.originTabId || rp.boundTabId || 0,
            originTabId: rp.originTabId || rp.ownerTabId || rp.boundTabId || 0,
            originWindowId: rp.originWindowId || 0,
            entry: rp.entry || 'sidepanel',
            incognito: rp.incognito,
          }).then(function (r) {
            sendResponse({ ok: true, payload: r });
          }).catch(function (err) {
            sendResponse({ ok: false, error: err.message });
          });
          return true;
        }

        case 'CONTINUE_RUN': {
          if (!deps.continueSession) { sendResponse({ ok: false, error: '未接线' }); return; }
          deps.continueSession((message.payload || {}).runId).then(function (r) {
            sendResponse({ ok: true, payload: r });
          }).catch(function (err) {
            sendResponse({ ok: false, error: err.message });
          });
          return true;
        }

        case 'CONVERSATION_COMMAND': {
          if (!conversationCommandBus || typeof conversationCommandBus.dispatch !== 'function') {
            sendResponse({ ok: false, error: { code: 'INVALID_COMMAND', message: 'Conversation Command Bus is unavailable' } });
            return;
          }
          function sendConversationResponse(response) {
            try {
              sendResponse(response);
            } catch (error) {
              var detail = error && error.message || String(error || 'Conversation response failed');
              try {
                sendResponse({
                  ok: false,
                  error: {
                    code: 'RESPONSE_TOO_LARGE',
                    message: 'Conversation response could not be transferred: ' + detail,
                    details: { command: String(message.payload && message.payload.command || '') },
                  },
                });
              } catch (fallbackError) {
                console.error('[conversation] response transfer failed:', fallbackError);
              }
            }
          }
          conversationCommandBus.dispatch(message.payload || {}, sender || {}).then(sendConversationResponse, function (error) {
            sendConversationResponse({ ok: false, error: { code: error && error.code || 'INVALID_COMMAND', message: error && error.message || String(error) } });
          });
          return true;
        }

        case 'PREPARE_CONVERSATION_ARCHIVE_EXPORT': {
          if (!isOptionsPageSender(sender) || typeof prepareConversationArchiveExport !== 'function') {
            sendResponse({ ok: false, error: 'Conversation archive export is unavailable on this surface' });
            return;
          }
          Promise.resolve(prepareConversationArchiveExport(message.payload || {})).then(function (result) {
            sendResponse({ ok: true, payload: result });
          }).catch(function (error) {
            sendResponse({ ok: false, error: error && error.message || String(error), code: error && error.code || 'ARCHIVE_EXPORT_FAILED' });
          });
          return true;
        }

        case 'READ_CONVERSATION_ARCHIVE_EXPORT_RANGE': {
          if (!isOptionsPageSender(sender) || typeof readConversationArchiveExportRange !== 'function') {
            sendResponse({ ok: false, error: 'Conversation archive range reader is unavailable on this surface' });
            return;
          }
          Promise.resolve(readConversationArchiveExportRange(message.payload || {})).then(function (result) {
            sendResponse({ ok: true, payload: result });
          }).catch(function (error) {
            sendResponse({ ok: false, error: error && error.message || String(error), code: error && error.code || 'ARCHIVE_RANGE_READ_FAILED' });
          });
          return true;
        }

        case 'RELEASE_CONVERSATION_ARCHIVE_EXPORT': {
          if (!isOptionsPageSender(sender) || typeof releaseConversationArchiveExport !== 'function') {
            sendResponse({ ok: false, error: 'Conversation archive release is unavailable on this surface' });
            return;
          }
          Promise.resolve().then(function () {
            return releaseConversationArchiveExport(message.payload || {});
          }).then(function (result) {
            sendResponse({ ok: true, payload: result });
          }).catch(function (error) {
            sendResponse({ ok: false, error: error && error.message || String(error), code: error && error.code || 'ARCHIVE_RELEASE_FAILED' });
          });
          return true;
        }

        case 'EXPORT_CONVERSATION_BACKUP': {
          if (!isOptionsPageSender(sender) || typeof exportConversationBackup !== 'function') {
            sendResponse({ ok: false, error: 'Conversation backup export is unavailable on this surface' });
            return;
          }
          Promise.resolve(exportConversationBackup(message.payload || {})).then(function (result) {
            sendResponse({ ok: true, payload: result });
          }).catch(function (error) {
            sendResponse({ ok: false, error: error && error.message || String(error), code: error && error.code || 'BACKUP_EXPORT_FAILED' });
          });
          return true;
        }

        case 'IMPORT_CONVERSATION_BACKUP': {
          if (!isOptionsPageSender(sender) || typeof importConversationBackup !== 'function') {
            sendResponse({ ok: false, error: 'Conversation backup import is unavailable on this surface' });
            return;
          }
          Promise.resolve(importConversationBackup(message.payload || {})).then(function (result) {
            sendResponse({ ok: true, payload: result });
          }).catch(function (error) {
            sendResponse({ ok: false, error: error && error.message || String(error), code: error && error.code || 'BACKUP_IMPORT_FAILED' });
          });
          return true;
        }

        case 'START_ELEMENT_PICKER': {
          var pickPayload = Object.assign({}, message.payload || {});
          if (!pickPayload.tabId && message.tabId) pickPayload.tabId = message.tabId;
          var senderTabId = sender && sender.tab ? sender.tab.id : null;
          var pickTabId = 0;
          resolveSelectorToolTab(pickPayload).then(function (tab) {
            pickTabId = positiveTabId(tab && tab.id);
            return chromeApi.scripting.executeScript({
              target: { tabId: pickTabId },
              files: ['content/selector-utils.js', 'content/element-picker.js'],
            });
          }).then(function () {
              // 聚焦目标页面，方便用户直接点选
              return activateExtensionTab(pickTabId, true);
            }).then(function () {
              return chromeApi.tabs.sendMessage(pickTabId, { type: 'START_PICKER' });
            }).then(function (result) {
              // 选取完成后切回发起页（options）
              var back = senderTabId ? activateExtensionTab(senderTabId, false).catch(function () {}) : Promise.resolve();
              return Promise.resolve(back).then(function () {
                result = result || {};
                sendResponse({ ok: true, selector: result.selector || null, candidates: result.candidates || [], text: result.text || '' });
              });
            }).catch(function (err) {
              sendResponse({ ok: false, error: err.message });
            });
          return true;
        }

        case 'VERIFY_SELECTOR': {
          if (!executeNodeInstance) { sendResponse({ ok: false, error: '未接线' }); return; }
          var verifyPayload = message.payload || {};
          var verifySelector = verifyPayload.selector;
          if (!verifySelector) {
            sendResponse({ ok: false, error: '缺少 selector' });
            return;
          }
          resolveSelectorToolTab(verifyPayload).then(function (tab) {
            var verifyParams = Object.assign({}, verifyPayload.params || {}, {
              tabId: positiveTabId(tab && tab.id),
              selector: verifySelector,
            });
            if (!verifyParams.timeoutMs) verifyParams.timeoutMs = 2000;
            verifyParams.reveal = true;
            if (!verifyParams.highlightMs) verifyParams.highlightMs = 1800;
            return executeNodeInstance({
              type: 'elementInfo',
              label: '验证选择器',
              pageId: '',
              params: verifyParams,
            }, {
              resetContext: true,
              context: {},
              runTabMode: 'reuseOpenTab',
            });
          }).then(function (result) {
            sendResponse({ ok: true, payload: unwrapNodeInstanceResult(result) });
          }).catch(function (err) {
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
          });
          return true;
        }

        default: {
          sendResponse({ ok: false, error: 'Unknown message type: ' + type });
          break;
        }
      }
    }

    return { handleMessage: handleMessage };
  }

  return { createMessageRouter: createMessageRouter };
});
