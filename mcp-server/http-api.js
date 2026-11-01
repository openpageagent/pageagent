'use strict';

// HTTP MCP transport, authenticated client discovery, and liveness endpoint.
const http = require('http');
const { randomUUID } = require('crypto');
const arp = require('../resources/protocol/index.js');
const { equalHash } = require('./auth-store');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createHttpApi(options) {
  options = options || {};
  const getExtensionClients = options.getExtensionClients;
  const handleMcpHttp = options.handleMcpHttp;
  if (typeof handleMcpHttp !== 'function') throw new TypeError('HTTP API requires handleMcpHttp()');
  const mcpBearerTokenHash = options.mcpBearerTokenHash || '';
  const requestedPort = Number(options.port);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
    ? requestedPort
    : 9998;
  const bindHost = String(options.host || '127.0.0.1').trim() || '127.0.0.1';
  const configuredOrigins = parseAllowedOrigins(options.allowedOrigins);
  function nextRequestId() {
    return randomUUID();
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
    if (!mcpBearerTokenHash) return false;
    const authorization = header(req, 'authorization');
    return authorization.startsWith('Bearer ') && equalHash(authorization.slice(7), mcpBearerTokenHash);
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
      'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
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

  function header(req, name) {
    const value = req && req.headers && req.headers[String(name).toLowerCase()];
    return Array.isArray(value) ? String(value[0] || '') : String(value || '');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://localhost:${port}`); }
    catch (_) { sendJson(req, res, 400, localEnvelope('INVALID_REQUEST', 'Invalid HTTP request URL', { status: 400 })); return; }
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
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': [
          'Content-Type', 'Authorization',
          'MCP-Protocol-Version', 'MCP-Session-Id',
          'X-Page-Agent-MCP-Client-Id',
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
        });
        return;
      }
      if (!mcpAuthorized(req)) {
        if (options.onAuthenticationFailure) options.onAuthenticationFailure(req.socket.remoteAddress || '');
        sendJson(req, res, 401, localEnvelope('AUTHENTICATION_REQUIRED', 'Invalid or missing Bearer credential', { status: 401 }));
        return;
      }
      if (path === '/mcp') {
        await handleMcpHttp(req, res, url.searchParams, { sendJson, sendEmpty, readBody, signal: requestAbort.signal });
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
      sendJson(req, res, 404, localEnvelope('RESOURCE_NOT_FOUND', `Unknown HTTP route: ${req.method} ${path}`, {
        status: 404,
        details: {
          available: [
            'GET /mcp/clients',
            'POST /mcp',
            'DELETE /mcp',
            'GET /healthz',
          ],
        },
      }));
    } catch (error) {
      if (!requestAbort.signal.aborted && !res.writableEnded) {
        const status = Number(error && error.statusCode) || 502;
        sendJson(req, res, status, localEnvelope(
          error.code && Object.prototype.hasOwnProperty.call(arp.ERROR_STATUS, error.code) ? error.code : status === 400 ? 'INVALID_REQUEST' : 'UPSTREAM_FAILED',
          error.message,
          { status, retryable: false, performed: error.performed || 'no',
            details: { ...(error.details || {}), ...(error.reason ? { reason: error.reason } : {}) } }
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
    console.error(`[HTTP MCP] Listening on http://${bindHost}:${port}/mcp`);
  });
  return server;
}

module.exports = { createHttpApi };
