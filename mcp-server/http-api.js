'use strict';

// HTTP webhook surface backed exclusively by ARP/1 resources.
const http = require('http');
const arp = require('../resources/protocol/index.js');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 120000;
const MAX_WAIT_TIMEOUT_MS = 600000;
const TERMINAL_RUN_STATES = new Set([
  'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled',
  'stopped', 'completed', 'done', 'partial', 'blocked', 'interrupted',
]);
const ACTIVE_RUN_STATES = new Set([
  'idle', 'queued', 'starting', 'pending', 'running', 'paused', 'pausing',
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createHttpApi(options) {
  options = options || {};
  const callArp = options.callArp;
  if (typeof callArp !== 'function') throw new TypeError('HTTP API requires callArp()');
  const runWithClientTarget = typeof options.withClientTarget === 'function'
    ? options.withClientTarget
    : (_target, fn) => fn();
  const getExtensionClients = options.getExtensionClients;
  const handleMcpMessage = typeof options.handleMcpMessage === 'function'
    ? options.handleMcpMessage
    : null;
  const mcpBearerToken = String(options.mcpBearerToken || '').trim();
  const createCorrelationContext = typeof options.createCorrelationContext === 'function'
    ? options.createCorrelationContext
    : (hint) => ({ sessionId: hint, conversationId: hint });
  const requestedPort = Number(options.port);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
    ? requestedPort
    : 9998;
  const bindHost = String(options.host || '127.0.0.1').trim() || '127.0.0.1';
  const configuredOrigins = parseAllowedOrigins(options.allowedOrigins);
  const pollMs = Number.isFinite(Number(options.pollIntervalMs)) && Number(options.pollIntervalMs) > 0
    ? Math.floor(Number(options.pollIntervalMs))
    : POLL_INTERVAL_MS;
  let requestSequence = 0;

  function nextRequestId() {
    requestSequence += 1;
    return 'arp_http_' + Date.now().toString(36) + '_' + requestSequence.toString(36);
  }

  function localEnvelope(code, message, errorOptions) {
    errorOptions = errorOptions || {};
    const error = arp.arpError(code, message, {
      status: errorOptions.status,
      retryable: errorOptions.retryable === true,
      current: errorOptions.current,
      details: errorOptions.details,
      performed: errorOptions.performed || 'no',
    });
    return arp.createErrorResponse(nextRequestId(), error, {
      performed: errorOptions.performed || 'no',
      idempotencyKey: errorOptions.idempotencyKey,
    });
  }

  function abortError(signal) {
    const reason = signal && signal.reason;
    const error = reason instanceof Error ? reason : new Error(String(reason || 'HTTP request aborted'));
    if (error.name === 'Error') error.name = 'AbortError';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError(signal);
  }

  function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(abortError(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function normalizeWaitTimeout(value) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
    return Math.min(Math.floor(timeout), MAX_WAIT_TIMEOUT_MS);
  }

  function readBody(req, signal) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let settled = false;
      const cleanup = () => {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onData = (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish(reject, new HttpError(413, '请求体超过 2MB 限制'));
          req.resume();
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return finish(resolve, {});
        try { finish(resolve, JSON.parse(raw)); }
        catch (error) { finish(reject, new HttpError(400, '请求体不是合法 JSON: ' + error.message)); }
      };
      const onError = (error) => finish(reject, error);
      const onAbort = () => finish(reject, abortError(signal));
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (signal && signal.aborted) onAbort();
    });
  }

  function parseAllowedOrigins(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  function isLoopbackHostname(hostname) {
    hostname = String(hostname || '').toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1'
      || hostname === '::1' || hostname === '[::1]';
  }

  function originAllowed(origin) {
    if (!origin) return true;
    if (configuredOrigins.includes('*') || configuredOrigins.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      return isLoopbackHostname(parsed.hostname)
        || parsed.protocol === 'chrome-extension:'
        || parsed.protocol === 'moz-extension:';
    }
    catch (_) { return false; }
  }

  function mcpAuthorized(req) {
    if (!mcpBearerToken) return true;
    const authorization = header(req, 'authorization');
    return authorization === 'Bearer ' + mcpBearerToken;
  }

  function corsHeaders(req) {
    const origin = req && req.headers ? String(req.headers.origin || '') : '';
    return origin && originAllowed(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};
  }

  function sendJson(req, res, statusCode, value) {
    if (res.destroyed || res.writableEnded) return false;
    res.writeHead(statusCode, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, corsHeaders(req)));
    res.end(JSON.stringify(value));
    return true;
  }

  function sendEmpty(req, res, statusCode) {
    if (res.destroyed || res.writableEnded) return false;
    res.writeHead(statusCode, corsHeaders(req));
    res.end();
    return true;
  }

  function jsonRpcError(id, code, message) {
    return {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error: { code, message: String(message || 'MCP request failed') },
    };
  }

  function sendEnvelope(req, res, envelope) {
    const status = envelope && envelope.status && Number(envelope.status.code);
    return sendJson(req, res, Number.isInteger(status) ? status : 502, envelope);
  }

  function header(req, name) {
    const value = req && req.headers && req.headers[String(name).toLowerCase()];
    return Array.isArray(value) ? String(value[0] || '') : String(value || '');
  }

  function firstText(values) {
    for (const value of values) {
      const text = String(value === undefined || value === null ? '' : value).trim();
      if (text) return text;
    }
    return '';
  }

  function clientTarget(req, query) {
    return {
      any: firstText([header(req, 'x-page-agent-mcp-client'), query.get('mcpClient')]),
      clientId: firstText([
        header(req, 'x-page-agent-mcp-client-id'),
        header(req, 'x-page-agent-client-id'),
        query.get('mcpClientId'), query.get('clientId'),
      ]),
      clientName: firstText([
        header(req, 'x-page-agent-mcp-client-name'),
        header(req, 'x-page-agent-client-name'),
        query.get('mcpClientName'), query.get('clientName'),
      ]),
      incognito: firstText([query.get('incognito')]),
    };
  }

  function correlationContext(req, query) {
    const hint = firstText([
      header(req, 'x-page-agent-session-id'),
      query.get('sessionId'),
    ]);
    try { return createCorrelationContext(hint || undefined); }
    catch (error) { throw new HttpError(400, '无效的 ARP sessionId: ' + error.message); }
  }

  function decodeIdentifier(value) {
    try {
      const decoded = decodeURIComponent(String(value || ''));
      if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001F\u007F]/.test(decoded)) {
        throw new Error('invalid identifier');
      }
      return decoded;
    } catch (_) {
      throw new HttpError(400, '路径参数不是合法的资源 ID');
    }
  }

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => (
      '%' + character.charCodeAt(0).toString(16).toUpperCase()
    ));
  }

  function requestMetadata(req, body) {
    const control = body && typeof body._arp === 'object' && !Array.isArray(body._arp) ? body._arp : {};
    return {
      idempotencyKey: firstText([header(req, 'idempotency-key'), control.idempotencyKey]),
    };
  }

  function webhookInput(body) {
    const clean = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.assign({}, body)
      : { input: body };
    delete clean._arp;
    return Object.prototype.hasOwnProperty.call(clean, 'input') ? clean.input : clean;
  }

  async function invoke(method, request, context, signal, timeoutMs) {
    throwIfAborted(signal);
    return callArp(method, request, timeoutMs, { signal, context });
  }

  async function createRun(uri, runBody, metadata, context, signal) {
    const request = {
      uri,
      body: runBody,
    };
    if (metadata.idempotencyKey) request.idempotencyKey = metadata.idempotencyKey;
    return invoke('POST', request, context, signal);
  }

  function runState(envelope) {
    const data = envelope && envelope.primary && envelope.primary.data;
    return String(data && data.status || envelope && envelope.receipt && envelope.receipt.state || '').toLowerCase();
  }

  async function waitForRun(started, context, timeoutValue, signal) {
    if (!started || !started.status || Number(started.status.code) >= 400) return started;
    const operationUri = started.receipt && started.receipt.operationUri
      || started.primary && started.primary.uri;
    if (!operationUri) {
      return localEnvelope('UPSTREAM_FAILED', 'Run creation did not return an operation URI', {
        status: 502, retryable: false, performed: 'unknown',
      });
    }
    const timeoutMs = normalizeWaitTimeout(timeoutValue);
    const deadline = Date.now() + timeoutMs;
    let current = started;
    while (Date.now() < deadline) {
      await sleep(pollMs, signal);
      current = await invoke('GET', { uri: operationUri }, context, signal);
      if (!current || !current.status || Number(current.status.code) >= 400) return current;
      const state = runState(current);
      if (TERMINAL_RUN_STATES.has(state)) return current;
      if (state && !ACTIVE_RUN_STATES.has(state)) return current;
    }
    return localEnvelope('OPERATION_TIMEOUT', `Run did not reach a terminal state within ${timeoutMs}ms`, {
      status: 504,
      retryable: true,
      performed: 'yes',
      current: current && current.primary,
      details: { operationUri, timeoutMs },
      idempotencyKey: started.receipt && started.receipt.idempotencyKey,
    });
  }

  async function handleRunWebhook(req, res, targetKind, targetIdRaw, query, signal) {
    const body = await readBody(req, signal);
    const targetId = decodeIdentifier(targetIdRaw);
    const uri = targetKind === 'flow'
      ? '/flows/' + segment(targetId) + '/runs'
      : '/flow-groups/' + segment(targetId) + '/runs';
    const input = webhookInput(body);
    const runBody = {
      trigger: 'webhook',
      context: { input },
      initialContext: { input },
      entry: 'webhook',
    };
    const metadata = requestMetadata(req, body);
    const context = correlationContext(req, query);
    return runWithClientTarget(clientTarget(req, query), async () => {
      const started = await createRun(uri, runBody, metadata, context, signal);
      if (String(query.get('wait')).toLowerCase() === 'false') {
        sendEnvelope(req, res, started);
        return;
      }
      sendEnvelope(req, res, await waitForRun(started, context, query.get('timeoutMs'), signal));
    }, { signal, context });
  }

  async function handleResultWebhook(req, res, runIdRaw, query, signal) {
    const runId = decodeIdentifier(runIdRaw);
    const context = correlationContext(req, query);
    const uri = '/runs/' + segment(runId);
    return runWithClientTarget(clientTarget(req, query), async () => {
      sendEnvelope(req, res, await invoke('GET', { uri }, context, signal));
    }, { signal, context });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const requestAbort = new AbortController();
    const abortRequest = () => {
      if (!requestAbort.signal.aborted && !res.writableEnded) {
        requestAbort.abort(new Error('HTTP client disconnected'));
      }
    };
    req.once('aborted', abortRequest);
    res.once('close', abortRequest);

    if (!originAllowed(req.headers && req.headers.origin)) {
      sendJson(req, res, 403, localEnvelope('FORBIDDEN', 'Origin not allowed', { status: 403 }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': [
          'Content-Type', 'Authorization', 'Idempotency-Key',
          'MCP-Protocol-Version', 'MCP-Session-Id',
          'X-Page-Agent-Session-Id',
          'X-Page-Agent-MCP-Client', 'X-Page-Agent-MCP-Client-Id',
          'X-Page-Agent-MCP-Client-Name',
        ].join(', '),
      }, corsHeaders(req)));
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(req, res, 200, {
          ok: true,
          service: 'page-agent-arp-http-api',
          protocol: 'arp/1',
          clients: typeof getExtensionClients === 'function' ? getExtensionClients() : [],
        });
        return;
      }
      if (req.method === 'GET' && path === '/mcp/clients') {
        sendJson(req, res, 200, {
          ok: true,
          protocol: 'arp/1',
          clients: typeof getExtensionClients === 'function' ? getExtensionClients() : [],
        });
        return;
      }
      if (req.method === 'POST' && path === '/mcp') {
        if (!handleMcpMessage) {
          sendJson(req, res, 503, jsonRpcError(null, -32603, 'HTTP MCP endpoint is unavailable'));
          return;
        }
        if (!mcpAuthorized(req)) {
          sendJson(req, res, 401, jsonRpcError(null, -32001, 'Invalid or missing Bearer Token'));
          return;
        }
        const message = await readBody(req, requestAbort.signal);
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          sendJson(req, res, 400, jsonRpcError(null, -32600, 'Invalid JSON-RPC request'));
          return;
        }
        const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
        const context = correlationContext(req, url.searchParams);
        try {
          const result = await runWithClientTarget(clientTarget(req, url.searchParams), () => (
            handleMcpMessage(message, { signal: requestAbort.signal, context })
          ), { signal: requestAbort.signal, context });
          if (!hasId) {
            sendEmpty(req, res, 202);
            return;
          }
          sendJson(req, res, 200, { jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result });
        } catch (error) {
          sendJson(req, res, 200, jsonRpcError(message.id, Number.isSafeInteger(error && error.code)
            ? error.code : -32603, error && error.message || error));
        }
        return;
      }
      const flow = path.match(/^\/webhook\/run\/([^/]+)$/);
      if (req.method === 'POST' && flow) {
        await handleRunWebhook(req, res, 'flow', flow[1], url.searchParams, requestAbort.signal);
        return;
      }
      const group = path.match(/^\/webhook\/run-group\/([^/]+)$/);
      if (req.method === 'POST' && group) {
        await handleRunWebhook(req, res, 'flow-group', group[1], url.searchParams, requestAbort.signal);
        return;
      }
      const result = path.match(/^\/webhook\/result\/([^/]+)$/);
      if (req.method === 'GET' && result) {
        await handleResultWebhook(req, res, result[1], url.searchParams, requestAbort.signal);
        return;
      }
      sendJson(req, res, 404, localEnvelope('RESOURCE_NOT_FOUND', `Unknown HTTP route: ${req.method} ${path}`, {
        status: 404,
        details: {
          available: [
            'POST /webhook/run/{flowId}',
            'POST /webhook/run-group/{groupId}',
            'GET /webhook/result/{runId}',
            'GET /mcp/clients',
            'POST /mcp',
            'GET /healthz',
          ],
        },
      }));
    } catch (error) {
      if (!requestAbort.signal.aborted && !res.writableEnded) {
        const status = Number(error && error.statusCode) || 502;
        sendJson(req, res, status, localEnvelope(
          status === 400 ? 'INVALID_REQUEST' : 'UPSTREAM_FAILED',
          error.message,
          { status, retryable: status >= 500 }
        ));
      }
    } finally {
      req.removeListener('aborted', abortRequest);
      res.removeListener('close', abortRequest);
    }
  });

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.closeActiveConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  server.listen(port, bindHost, () => {
    console.error(`[HTTP API] ARP/1 webhooks listening on http://${bindHost}:${port}`);
  });
  return server;
}

module.exports = { createHttpApi };
