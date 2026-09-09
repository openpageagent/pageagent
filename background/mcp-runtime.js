// MCP Runtime — 仅负责 Extension ↔ MCP Server 的 ARP/1 连接生命周期。
(function attachMcpRuntime(root, factory) {
  'use strict';
  root.McpRuntime = factory(root);
})(globalThis, function (root) {
  'use strict';

  function createMcpRuntime(deps) {
    deps = deps || {};
    var chrome = deps.chrome || root.chrome;
    var dispatchResource = deps.dispatchResource;
    var createTrustedContext = deps.createTrustedContext;
    var addLog = deps.addLog || function () {};
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      throw new Error('McpRuntime requires chrome.storage.local');
    }
    if (typeof dispatchResource !== 'function') {
      throw new Error('McpRuntime requires canonical ARP dispatchResource()');
    }
    if (typeof createTrustedContext !== 'function') {
      throw new Error('McpRuntime requires createTrustedContext()');
    }
    if (!root.WebSocketClient || typeof root.WebSocketClient.createWebSocketClient !== 'function') {
      throw new Error('WebSocketClient must load before McpRuntime initialization');
    }

    var wsClient = null;

    function generateMcpClientId() {
      return 'pfa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function isMcpIncognitoContext() {
      return !!(chrome.extension && chrome.extension.inIncognitoContext);
    }

    function mcpStorageKeys(incognito) {
      return incognito
        ? { enabled: 'mcpEnabledIncognito', url: 'mcpUrlIncognito', id: 'mcpClientIdIncognito', name: 'mcpClientNameIncognito' }
        : { enabled: 'mcpEnabled', url: 'mcpUrl', id: 'mcpClientId', name: 'mcpClientName' };
    }

    function detectMcpBrowserName() {
      var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      if (/Edg\//.test(ua)) return 'edge';
      if (/OPR\//.test(ua)) return 'opera';
      if (/Firefox\//.test(ua)) return 'firefox';
      if (/Chrome\//.test(ua)) return 'chrome';
      if (/Safari\//.test(ua)) return 'safari';
      return 'browser';
    }

    function buildMcpClientInfo(clientId, clientName, incognito) {
      var manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
      var contextLabel = incognito ? '隐私窗口' : '主窗口';
      return {
        clientId: clientId,
        clientName: clientName || (manifest.name || 'Page Agent') + ' ' + contextLabel + ' ' + clientId.slice(-6),
        extensionId: chrome.runtime.id || '',
        extensionName: manifest.name || '',
        extensionVersion: manifest.version || '',
        browser: detectMcpBrowserName(),
        profile: contextLabel,
        incognito: !!incognito,
        incognitoContext: !!incognito,
        os: (typeof navigator !== 'undefined' && navigator.platform) || '',
        language: (typeof navigator !== 'undefined' && navigator.language) || '',
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
        protocol: 'arp/1',
      };
    }

    function storageGet(keys) {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.get(keys, function (stored) {
          var error = chrome.runtime && chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(stored || {});
        });
      });
    }

    function storageSet(values) {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.set(values, function () {
          var error = chrome.runtime && chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(values);
        });
      });
    }

    function sameClientConfiguration(status, url, clientInfo) {
      var currentInfo = status && status.clientInfo || {};
      return !!(status
        && status.url === url
        && currentInfo.clientId === clientInfo.clientId
        && currentInfo.clientName === clientInfo.clientName
        && currentInfo.incognito === clientInfo.incognito
        && status.protocol === 'arp/1');
    }

    function initClient() {
      var incognito = isMcpIncognitoContext();
      var clientKeys = mcpStorageKeys(incognito);
      var keys = [clientKeys.enabled, clientKeys.url, clientKeys.id, clientKeys.name];
      return storageGet(keys).then(function (stored) {
        var mcpUrl = String(stored[clientKeys.url] || 'ws://127.0.0.1:9999');
        var clientId = String(stored[clientKeys.id] || generateMcpClientId());
        var clientName = String(stored[clientKeys.name] || '');
        var persistClientId = Promise.resolve();
        if (!stored[clientKeys.id]) {
          var values = {};
          values[clientKeys.id] = clientId;
          persistClientId = storageSet(values);
        }

        return persistClientId.then(function () {
          if (stored[clientKeys.enabled] !== true || !mcpUrl) {
            if (wsClient) {
              wsClient.disconnect();
              wsClient = null;
              addLog('MCP ARP/1 WebSocket 客户端已关闭', { scope: 'mcp' });
            }
            return null;
          }

          var clientInfo = buildMcpClientInfo(clientId, clientName, incognito);
          var status = wsClient && wsClient.getStatus ? wsClient.getStatus() : null;
          if (wsClient && !sameClientConfiguration(status, mcpUrl, clientInfo)) {
            wsClient.disconnect();
            wsClient = null;
          }
          if (!wsClient) {
            wsClient = root.WebSocketClient.createWebSocketClient({
              arp: root.AgentResourceProtocol,
              dispatchResource: dispatchResource,
              createTrustedContext: createTrustedContext,
              wsUrl: mcpUrl,
              clientInfo: clientInfo,
            });
          }
          wsClient.connect();
          addLog('MCP ARP/1 WebSocket 客户端已启动: ' + mcpUrl, { scope: 'mcp' });
          return wsClient;
        });
      });
    }

    return Object.freeze({
      initClient: initClient,
      getClient: function () { return wsClient; },
    });
  }

  return Object.freeze({ createMcpRuntime: createMcpRuntime });
});
