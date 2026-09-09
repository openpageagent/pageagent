// WebSocket Client - Extension 端 ARP/1 transport。
(function attachWebSocketClient(root, factory) {
  'use strict';
  root.WebSocketClient = factory(root);
})(globalThis, function (root) {
  'use strict';

  var ARP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  var CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

  function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function createWebSocketClient(deps) {
    deps = deps || {};
    var dispatchResource = deps.dispatchResource;
    var createTrustedContext = deps.createTrustedContext;
    var arp = deps.arp || root.AgentResourceProtocol;
    if (typeof dispatchResource !== 'function') {
      throw new Error('WebSocketClient requires canonical ARP dispatchResource()');
    }
    if (typeof createTrustedContext !== 'function') {
      throw new Error('WebSocketClient requires createTrustedContext()');
    }
    if (!arp || typeof arp.createErrorResponse !== 'function' || typeof arp.arpError !== 'function') {
      throw new Error('AgentResourceProtocol must load before WebSocketClient');
    }

    var ws = null;
    var connected = false;
    var wsUrl = deps.wsUrl || 'ws://127.0.0.1:9999';
    var retryCount = 0;
    var maxRetries = Math.max(1, Number(deps.maxRetries) || 20);
    var baseDelay = Math.max(250, Number(deps.baseDelayMs) || 1000);
    var shouldReconnect = true;
    var reconnectTimer = null;
    var heartbeatTimer = null;
    var heartbeatIntervalMs = deps.heartbeatIntervalMs || 20000;
    var maxLogEntries = deps.maxLogEntries || 80;
    var logs = [];
    var clientInfo = normalizeClientInfo(deps.clientInfo || {});
    var serverInfo = null;
    var connectionWaiters = [];
    var localRequestSequence = 0;

    function normalizeClientInfo(info) {
      info = info || {};
      return {
        clientId: String(info.clientId || '').trim(),
        clientName: String(info.clientName || info.name || '').trim(),
        extensionId: String(info.extensionId || '').trim(),
        extensionName: String(info.extensionName || '').trim(),
        extensionVersion: String(info.extensionVersion || '').trim(),
        browser: String(info.browser || detectBrowser()).trim(),
        profile: String(info.profile || '').trim(),
        os: String(info.os || (typeof navigator !== 'undefined' && navigator.platform) || '').trim(),
        language: String(info.language || (typeof navigator !== 'undefined' && navigator.language) || '').trim(),
        userAgent: String(info.userAgent || (typeof navigator !== 'undefined' && navigator.userAgent) || '').trim(),
        incognito: info.incognito === true || info.incognitoContext === true,
        incognitoContext: info.incognito === true || info.incognitoContext === true,
        incognitoAccess: info.incognitoAccess === true,
        protocol: 'arp/1',
      };
    }

    function detectBrowser() {
      var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      if (/Edg\//.test(ua)) return 'edge';
      if (/OPR\//.test(ua)) return 'opera';
      if (/Firefox\//.test(ua)) return 'firefox';
      if (/Chrome\//.test(ua)) return 'chrome';
      if (/Safari\//.test(ua)) return 'safari';
      return 'browser';
    }

    function previewValue(value, maxLen) {
      var output = '';
      try { output = typeof value === 'string' ? value : JSON.stringify(value); }
      catch (_) { output = String(value); }
      maxLen = maxLen || 500;
      return output.length > maxLen ? output.slice(0, maxLen) + '...' : output;
    }

    function addLog(level, message, detail) {
      var entry = { timestamp: Date.now(), level: level || 'info', message: message || '' };
      if (detail !== undefined) entry.detail = previewValue(detail, 700);
      logs.push(entry);
      while (logs.length > maxLogEntries) logs.shift();
    }

    function getLogs() { return logs.slice(); }
    function clearLogs() { logs = []; }

    function settleConnectionWaiters(error) {
      var waiters = connectionWaiters.splice(0);
      waiters.forEach(function (waiter) {
        clearTimeout(waiter.timer);
        if (error) waiter.reject(error);
        else waiter.resolve(getStatus());
      });
    }

    function nextLocalRequestId() {
      localRequestSequence += 1;
      return 'arp_ws_' + Date.now().toString(36) + '_' + localRequestSequence.toString(36);
    }

    function errorEnvelope(error, code) {
      var message = String(error && error.message || error || 'ARP WebSocket dispatch failed');
      var normalized = error instanceof arp.ArpError
        ? error
        : arp.arpError(code || 'INTERNAL_ERROR', message, {
          retryable: code === 'TEMPORARILY_UNAVAILABLE',
          performed: 'no',
        });
      return arp.createErrorResponse(nextLocalRequestId(), normalized, { performed: 'no' });
    }

    function isArpEnvelope(value) {
      return !!(isRecord(value)
        && value.protocol === 'arp/1'
        && typeof value.requestId === 'string'
        && isRecord(value.status)
        && Number.isInteger(Number(value.status.code)));
    }

    function safeCorrelationContext(value) {
      value = isRecord(value) ? value : {};
      var sessionId = String(value.sessionId || '').trim();
      var conversationId = String(value.conversationId || sessionId).trim();
      if (!CORRELATION_ID.test(sessionId)) throw new TypeError('context.sessionId is invalid');
      if (!CORRELATION_ID.test(conversationId)) throw new TypeError('context.conversationId is invalid');
      // actor、permissions、origin、tab/window 等安全字段即使出现在帧中也不会被复制。
      return { sessionId: sessionId, conversationId: conversationId };
    }

    function normalizeRequestFrame(message) {
      if (!isRecord(message)) throw new TypeError('WebSocket frame must be an object');
      if (message.requestId === undefined || message.requestId === null || String(message.requestId).length > 200) {
        throw new TypeError('requestId is missing or too long');
      }
      var method = String(message.method || '');
      if (ARP_METHODS.indexOf(method) === -1) throw new TypeError('Unsupported ARP method: ' + (method || '(empty)'));
      if (!isRecord(message.request)) throw new TypeError('request must be an object');
      return {
        requestId: message.requestId,
        method: method,
        request: message.request,
        correlation: safeCorrelationContext(message.context),
      };
    }

    function stopHeartbeat() {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    function startHeartbeat() {
      stopHeartbeat();
      if (!heartbeatIntervalMs || heartbeatIntervalMs < 5000) return;
      heartbeatTimer = setInterval(function () {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: 'heartbeat', sentAt: Date.now(), clientId: clientInfo.clientId }));
        } catch (error) {
          addLog('error', 'MCP heartbeat 发送失败', { error: error.message });
        }
      }, heartbeatIntervalMs);
    }

    function sendHello() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'hello', protocol: 'arp/1', clientInfo: clientInfo, sentAt: Date.now() }));
      } catch (error) {
        addLog('error', '发送 MCP 客户端 hello 失败', { error: error.message });
      }
    }

    function sendResponse(requestId, envelope) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog('error', 'ARP 响应发送失败：连接不可用', { requestId: requestId });
        return;
      }
      try {
        ws.send(JSON.stringify({ requestId: requestId, envelope: envelope }));
      } catch (error) {
        addLog('error', 'ARP 响应发送异常', { requestId: requestId, error: error.message });
      }
    }

    function handleRequest(message) {
      var frame;
      try {
        frame = normalizeRequestFrame(message);
      } catch (error) {
        if (message && message.requestId !== undefined && message.requestId !== null) {
          sendResponse(message.requestId, errorEnvelope(error, 'INVALID_REQUEST'));
        }
        addLog('error', '拒绝无效 ARP 请求帧', { error: error.message });
        return;
      }

      var startedAt = Date.now();
      addLog('info', '收到 ARP 请求: ' + frame.method + ' ' + String(frame.request.uri || ''), {
        requestId: frame.requestId,
      });

      Promise.resolve().then(function () {
        return createTrustedContext(frame.correlation, {
          method: frame.method,
          request: frame.request,
          connectionUrl: wsUrl,
          clientInfo: clientInfo,
        });
      }).then(function (trustedContext) {
        if (!isRecord(trustedContext)) throw new Error('createTrustedContext() did not return an object');
        return dispatchResource(frame.method, frame.request, trustedContext);
      }).then(function (envelope) {
        if (!isArpEnvelope(envelope)) throw new Error('Canonical resource runtime returned an invalid ARP/1 Envelope');
        addLog(Number(envelope.status.code) >= 400 ? 'warn' : 'success', '完成 ARP 请求: ' + frame.method + ' ' + String(frame.request.uri || ''), {
          requestId: frame.requestId,
          status: envelope.status.code,
          elapsedMs: Date.now() - startedAt,
        });
        sendResponse(frame.requestId, envelope);
      }).catch(function (error) {
        addLog('error', 'ARP 请求派发失败: ' + frame.method + ' ' + String(frame.request.uri || ''), {
          requestId: frame.requestId,
          elapsedMs: Date.now() - startedAt,
          error: error.message,
        });
        sendResponse(frame.requestId, errorEnvelope(error, 'INTERNAL_ERROR'));
      });
    }

    function reconnect() {
      if (!shouldReconnect) return;
      if (retryCount >= maxRetries) {
        addLog('error', 'MCP WebSocket 已达到最大重试次数', { maxRetries: maxRetries });
        retryCount = 0;
        return;
      }
      var delay = Math.min(baseDelay * Math.pow(2, retryCount), 30000);
      retryCount += 1;
      addLog('info', '准备重连 MCP Server', { url: wsUrl, delayMs: delay, attempt: retryCount });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (shouldReconnect) connect();
      }, delay);
    }

    function connect() {
      shouldReconnect = true;
      if (connected || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
      try {
        addLog('info', '准备连接 MCP Server', { url: wsUrl, protocol: 'arp/1' });
        var socket = new WebSocket(wsUrl);
        ws = socket;

        socket.onopen = function () {
          if (ws !== socket) { try { socket.close(); } catch (_) {} return; }
          connected = true;
          retryCount = 0;
          addLog('success', '已连接 MCP Server', { url: wsUrl, protocol: 'arp/1' });
          sendHello();
          startHeartbeat();
          settleConnectionWaiters(null);
        };

        socket.onmessage = function (event) {
          if (ws !== socket) return;
          try {
            var message = JSON.parse(event.data);
            if (message && message.type === 'hello') {
              serverInfo = message;
              addLog('success', 'MCP Server 已确认 ARP 客户端', {
                clientId: message.clientId || clientInfo.clientId,
                connectedClients: message.connectedClients,
                protocol: message.protocol || '',
              });
              return;
            }
            handleRequest(message);
          } catch (error) {
            addLog('error', '解析 MCP Server 消息失败', { error: error.message });
          }
        };

        socket.onclose = function (event) {
          if (ws !== socket) return;
          connected = false;
          ws = null;
          stopHeartbeat();
          addLog('warn', 'MCP Server 连接已断开', {
            url: wsUrl,
            code: event && event.code,
            reason: event && event.reason,
            wasClean: !!(event && event.wasClean),
          });
          settleConnectionWaiters(new Error('MCP WebSocket connection closed before the attempt completed'));
          if (shouldReconnect) reconnect();
        };

        socket.onerror = function () {
          if (ws !== socket) return;
          addLog('error', 'MCP WebSocket 连接错误', { url: wsUrl, readyState: socket.readyState });
          settleConnectionWaiters(new Error('MCP WebSocket connection attempt failed'));
        };
      } catch (error) {
        addLog('error', '创建 MCP WebSocket 连接失败', { url: wsUrl, error: error.message });
        settleConnectionWaiters(error);
        reconnect();
      }
    }

    function connectAttempt(options) {
      options = options || {};
      if (connected) return Promise.resolve(getStatus());
      var timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 30000));
      return new Promise(function (resolve, reject) {
        var waiter = { resolve: resolve, reject: reject, timer: null };
        waiter.timer = setTimeout(function () {
          var index = connectionWaiters.indexOf(waiter);
          if (index !== -1) connectionWaiters.splice(index, 1);
          reject(new Error('MCP WebSocket connection attempt timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        connectionWaiters.push(waiter);
        connect();
      });
    }

    function disconnect() {
      shouldReconnect = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopHeartbeat();
      addLog('info', '主动断开 MCP Server 连接', { url: wsUrl });
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      connected = false;
      retryCount = 0;
      settleConnectionWaiters(new Error('MCP WebSocket connection attempt was cancelled'));
    }

    function getStatus() {
      return {
        connected: connected,
        connecting: !!(ws && ws.readyState === WebSocket.CONNECTING),
        url: wsUrl,
        protocol: 'arp/1',
        clientInfo: clientInfo,
        serverInfo: serverInfo,
        retryCount: retryCount,
        logs: getLogs(),
      };
    }

    return {
      connect: connect,
      connectAttempt: connectAttempt,
      disconnect: disconnect,
      isConnected: function () { return connected; },
      getStatus: getStatus,
      clearLogs: clearLogs,
    };
  }

  return Object.freeze({ createWebSocketClient: createWebSocketClient });
});
