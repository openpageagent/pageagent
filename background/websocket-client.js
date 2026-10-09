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
    var mailRequests = new Map();
    var localToolsEnabled = deps.localToolsEnabled !== false;
    var localWorkingDirectory = String(deps.localWorkingDirectory || '').trim();
    var localRequests = new Map();

    function effectiveLocalDirectory() {
      return localWorkingDirectory || String(serverInfo && serverInfo.workingDirectory || '').trim();
    }

    function finishLocal(requestId, error, result, cancel) {
      var pending = localRequests.get(requestId);
      if (!pending) return;
      localRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
      if (cancel && pending.socket.readyState === WebSocket.OPEN) {
        try { pending.socket.send(JSON.stringify({ type: 'local.cancel', requestId: requestId })); } catch (_) {}
      }
      if (error) { error.retryable = false; pending.reject(error); }
      else pending.resolve(result);
    }

    function rejectLocalRequests() {
      localRequests.forEach(function (_, requestId) {
        finishLocal(requestId, new Error('本地操作已停用或连接中断；执行结果可能未知，请确认后再重试'), null, true);
      });
    }

    function configureLocalTools(value, directory) {
      var enabled = value === true;
      var nextDirectory = String(directory || '').trim();
      if (localToolsEnabled === enabled && localWorkingDirectory === nextDirectory) return;
      if (!enabled || localWorkingDirectory !== nextDirectory) rejectLocalRequests();
      localToolsEnabled = enabled;
      localWorkingDirectory = nextDirectory;
      sendHello();
    }

    function callLocal(operation, input, options) {
      options = options || {};
      return new Promise(function (resolve, reject) {
        if (!localToolsEnabled || !effectiveLocalDirectory() || !connected || !ws || ws.readyState !== WebSocket.OPEN
            || !serverInfo || serverInfo.localOperations !== 'local/1') {
          reject(new Error('请在连接配置中启用本地文件与命令操作，并连接支持该能力的 MCP Server'));
          return;
        }
        var url = new URL(wsUrl);
        if (url.protocol !== 'wss:' && ['127.0.0.1', 'localhost', '[::1]'].indexOf(url.hostname) < 0) {
          reject(new Error('远程本地操作必须使用 wss:// 连接 MCP Server'));
          return;
        }
        var requestId = nextLocalRequestId();
        var pending = { socket: ws, resolve: resolve, reject: reject, signal: options.signal };
        pending.onAbort = function () {
          finishLocal(requestId, new Error('本地操作已取消；已经完成的修改不会撤销'), null, true);
        };
        pending.timer = setTimeout(function () {
          finishLocal(requestId, new Error('等待本地操作结果超时；执行结果可能未知，请确认后再重试'), null, true);
        }, 75000);
        localRequests.set(requestId, pending);
        if (pending.signal) {
          pending.signal.addEventListener('abort', pending.onAbort, { once: true });
          if (pending.signal.aborted) { pending.onAbort(); return; }
        }
        try {
          pending.socket.send(JSON.stringify({ type: 'local.call', requestId: requestId, operation: operation,
            workingDirectory: effectiveLocalDirectory(), input: input }));
        } catch (error) { finishLocal(requestId, error); }
      });
    }

    function finishMail(requestId, error, result, cancel) {
      var pending = mailRequests.get(requestId);
      if (!pending) return;
      mailRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.payload = null;
      if (cancel && pending.sent && pending.socket.readyState === WebSocket.OPEN) {
        try { pending.socket.send(JSON.stringify({ type: 'mail.cancel', requestId: requestId })); } catch (_) {}
      }
      if (error) {
        error.retryable = false;
        pending.reject(error);
      } else pending.resolve(result);
    }

    function rejectMailRequests() {
      mailRequests.forEach(function (pending, requestId) {
        finishMail(requestId, new Error(pending.sent
          ? 'MCP 连接中断，邮件投递结果未知，请确认后再重试'
          : 'MCP 连接中断，邮件尚未发送'));
      });
    }

    function postMail(requestId, pending) {
      if (!serverInfo || pending.sent || pending.socket !== ws) return;
      if (serverInfo.mail !== 'smtp/1') {
        finishMail(requestId, new Error('当前 MCP Server 不支持邮件发送，请更新服务端后重新连接'));
        return;
      }
      try {
        var frame = JSON.stringify({ type: 'mail.send', requestId: requestId, payload: pending.payload });
        if (new TextEncoder().encode(frame).length > root.PageAutomationMailSettings.MAX_REQUEST_BYTES) throw new Error('邮件请求超过 32MB，请减小附件或正文');
        pending.socket.send(frame);
        pending.sent = true;
        pending.payload = null;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(function () {
          finishMail(requestId, new Error('等待邮件排队及发送结果超过 150 秒，投递结果未知，请确认后再重试'), null, true);
        }, root.PageAutomationMailSettings.DELIVERY_LIMITS.resultTimeoutMs);
      } catch (_) {
        finishMail(requestId, new Error('邮件请求无法发送或超过 32MB，请检查连接和附件大小'));
      }
    }

    function sendMail(payload, options) {
      options = options || {};
      return new Promise(function (resolve, reject) {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('请先连接 MCP Server，邮件尚未发送'));
          return;
        }
        var url = new URL(wsUrl);
        if (url.protocol !== 'wss:' && ['127.0.0.1', 'localhost', '[::1]'].indexOf(url.hostname) < 0) {
          reject(new Error('远程邮件发送必须使用 wss:// 连接 MCP Server，以保护邮箱授权码'));
          return;
        }
        var requestId = nextLocalRequestId();
        var pending = { socket: ws, payload: payload, resolve: resolve, reject: reject, signal: options.signal, sent: false };
        pending.onAbort = function () {
          finishMail(requestId, new Error(pending.sent
            ? '邮件发送已取消；如已提交 SMTP，邮件仍可能送达，请确认后再重试'
            : '邮件发送已取消'), null, true);
        };
        pending.timer = setTimeout(function () {
          finishMail(requestId, new Error('MCP Server 尚未确认邮件发送能力，请检查连接或更新服务端'));
        }, 5000);
        mailRequests.set(requestId, pending);
        if (pending.signal) {
          pending.signal.addEventListener('abort', pending.onAbort, { once: true });
          if (pending.signal.aborted) { pending.onAbort(); return; }
        }
        postMail(requestId, pending);
      });
    }

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
        ws.send(JSON.stringify({ type: 'hello', protocol: 'arp/1', clientInfo: clientInfo,
          localToolsEnabled: localToolsEnabled, localWorkingDirectory: effectiveLocalDirectory(), sentAt: Date.now() }));
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
        serverInfo = null;

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
              var firstHello = !serverInfo;
              serverInfo = message;
              if (firstHello && localToolsEnabled && !localWorkingDirectory && effectiveLocalDirectory()) sendHello();
              mailRequests.forEach(function (pending, requestId) { postMail(requestId, pending); });
              addLog('success', 'MCP Server 已确认 ARP 客户端', {
                clientId: message.clientId || clientInfo.clientId,
                connectedClients: message.connectedClients,
                protocol: message.protocol || '',
              });
              return;
            }
            if (message && message.type === 'mail.result') {
              var result = message.result;
              if (message.ok === true && result && typeof result.messageId === 'string'
                  && Number.isInteger(result.acceptedCount) && result.acceptedCount > 0 && result.rejectedCount === 0) {
                finishMail(message.requestId, null, result);
              } else {
                finishMail(message.requestId, new Error(message.error || 'MCP Server 返回无效邮件结果，请确认投递情况后再重试'));
              }
              return;
            }
            if (message && message.type === 'local.result') {
              finishLocal(message.requestId, message.ok === true && isRecord(message.result)
                ? null : new Error(message.error || 'MCP Server 返回无效的本地操作结果'), message.result);
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
          serverInfo = null;
          rejectMailRequests();
          rejectLocalRequests();
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
      rejectMailRequests();
      rejectLocalRequests();
      serverInfo = null;
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
        localToolsEnabled: localToolsEnabled,
        localWorkingDirectory: effectiveLocalDirectory(),
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
      sendMail: sendMail,
      callLocal: callLocal,
      configureLocalTools: configureLocalTools,
    };
  }

  return Object.freeze({ createWebSocketClient: createWebSocketClient });
});
