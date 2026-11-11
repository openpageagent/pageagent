'use strict';

const { randomUUID } = require('crypto');
const arp = require('../resources/protocol');
const { LIMITS, record } = require('../shared/mcp-contract');
const VERSIONS = ['2025-11-25', '2025-06-18'];
const rpcError = (code, message, statusCode = 200) => Object.assign(new Error(message), { code, statusCode });
function canonicalToMcpUri(uri) { return 'arp://' + arp.canonicalizeUri(uri, { allowRoot: true }); }
function mcpToCanonicalUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('arp:///') || /[?#]/.test(uri)) throw rpcError(-32602, 'Resource URI must use arp:///');
  try { return arp.canonicalizeUri(uri.slice(6), { allowRoot: true }); }
  catch (_) { throw rpcError(-32602, 'Invalid resource URI'); }
}
function validId(id) { return Number.isSafeInteger(id) || typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(id); }
function typedId(id) { return JSON.stringify([typeof id, id]); }
class McpHttpHandler {
  constructor(server) {
    this.server = server; this.sessions = new Map(); this.active = 0;
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  expire() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state === 'initializing' && now - session.createdAt >= 10000
        || session.state === 'ready' && !session.active.size && now - session.touched >= LIMITS.httpIdleMs) this.remove(session);
    }
  }
  remove(session) {
    session.state = 'closing'; for (const item of session.active.values()) item.controller.abort('HTTP session closed');
    if (!session.active.size) this.sessions.delete(session.id);
  }
  target(req, query, session, argument) {
    if (query.getAll('mcpClientId').length > 1) throw rpcError(-32602, 'Duplicate target query', 400);
    const values = [req.headers['x-page-agent-mcp-client-id'], query.get('mcpClientId'), argument].filter(value => value !== undefined && value !== null && value !== '');
    if (values.some(value => typeof value !== 'string' || value.length > 200) || new Set(values).size > 1) throw rpcError(-32602, 'Conflicting target IDs', 400);
    const value = values[0] || null;
    if (session && session.target && value && session.target !== value) throw rpcError(-32602, 'Target differs from session binding', 400);
    return session && session.target || value;
  }
  async dispatch(message, options) {
    const params = message.params || {};
    const allowed = { ping: ['_meta'], 'tools/list': ['cursor', '_meta'], 'tools/call': ['name', 'arguments', '_meta'],
      'resources/list': ['cursor', '_meta'], 'resources/read': ['uri', '_meta'] }[message.method];
    if (allowed && (Object.keys(params).some(key => !allowed.includes(key)) || params._meta !== undefined && !record(params._meta)
      || params.cursor !== undefined && (typeof params.cursor !== 'string' || !/^offset:\d+$/.test(params.cursor)))) throw rpcError(-32602, 'Invalid method parameters');
    if (message.method === 'ping') return {};
    if (message.method === 'tools/list') return { tools: params.cursor ? [] : this.server.toolDefinitions };
    if (message.method === 'tools/call') {
      if (!arp.METHODS.includes(params.name) || !record(params.arguments)) throw rpcError(-32602, 'Invalid method tool or arguments');
      try {
        return this.server.toolResult(await this.server.callMcpTool(params.name, { ...params.arguments, mcpClientId: options.target }, options));
      } catch (error) {
        const failure = arp.arpError(error.code || 'UPSTREAM_FAILED', error.message, {
          performed: error.performed || 'no', retryable: false,
          details: { ...(error.details || {}), ...(error.reason ? { reason: error.reason } : {}) },
        });
        return this.server.toolResult(arp.createErrorResponse(randomUUID(), failure));
      }
    }
    if (message.method === 'resources/list') {
      const envelope = await this.server.callArp('OPTIONS', { uri: '/', ...(params.cursor ? { cursor: params.cursor } : {}) }, 30000, options);
      if (envelope.status.code >= 400) throw rpcError(-32000, 'Resource discovery failed');
      const discovered = envelope.capabilities && envelope.capabilities.resources || [];
      return { ...(envelope.capabilities && envelope.capabilities.nextCursor ? { nextCursor: envelope.capabilities.nextCursor } : {}),
        resources: (params.cursor ? [] : [{ uri: 'arp:///', name: 'ARP/1 resources', mimeType: 'application/json' }]).concat(discovered.map(item => ({
        uri: canonicalToMcpUri(item.href), name: item.type || item.relation || item.href,
        description: item.relation || 'ARP resource', mimeType: 'application/json' }))) };
    }
    if (message.method === 'resources/read') {
      const canonical = mcpToCanonicalUri(params.uri);
      const method = canonical === '/' || canonical === '/page' || canonical === '/browser' ? 'OPTIONS' : 'GET';
      const envelope = await this.server.callArp(method, { uri: canonical }, 30000, options);
      const images = this.server.inlineImageContents(envelope);
      return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(images.length ? this.server.stripInlineImageData(envelope) : envelope) }]
        .concat(images.map(image => ({ uri: params.uri, mimeType: image.mimeType, blob: image.data }))) };
    }
    throw rpcError(-32601, 'Method not found');
  }
  async handle(req, res, query, helpers) {
    const { sendJson, sendEmpty, readBody, signal } = helpers;
    let message, session;
    const auditContext = { transportSessionId: randomUUID(), requestId: randomUUID(), parentRequest: null,
      principal: { transport: 'http', id: 'http:operator', clientId: null, pairingId: null },
      caller: null, callerAssurance: 'server_verified', operation: 'http.mcp',
      executor: { ...this.server.environment.base.executor, pid: null },
      decision: 'allow', ruleIds: ['session.authenticated'], policyRevision: 1, grantRevision: null };
    const failure = error => {
      this.server.audit.bestEffort('authorization.denied', { ...auditContext, decision: 'deny',
        errorReason: Number.isSafeInteger(error.code) ? 'JSON_RPC_' + error.code : 'HTTP_REQUEST_FAILED' });
      if (record(message) && !Object.prototype.hasOwnProperty.call(message, 'id') && typeof message.method === 'string') {
        sendEmpty(req, res, error.statusCode && error.statusCode >= 400 ? error.statusCode : 400); return;
      }
      sendJson(req, res, error.statusCode || 200, { jsonrpc: '2.0', id: message && validId(message.id) ? message.id : null,
        error: { code: Number.isSafeInteger(error.code) ? error.code : -32603, message: error.message || 'MCP request failed' } });
    };
    try {
      if (req.method === 'GET') { res.setHeader('Allow', 'POST, DELETE, OPTIONS'); sendEmpty(req, res, 405); return; }
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId) {
        session = this.sessions.get(sessionId);
        if (!session || session.state === 'closing') throw rpcError(-32600, 'Unknown or expired session', 404);
        auditContext.transportSessionId = session.id;
        if (req.headers['mcp-protocol-version'] && req.headers['mcp-protocol-version'] !== session.version) throw rpcError(-32600, 'Protocol version conflicts with session', 400);
        this.target(req, query, session);
        session.touched = Date.now();
      }
      if (req.method === 'DELETE') {
        if (!session) throw rpcError(-32600, 'Mcp-Session-Id required', 400);
        this.server.audit.bestEffort('cancel.requested', { ...auditContext, operation: 'http.session.delete' });
        this.remove(session); sendEmpty(req, res, 204); return;
      }
      if (req.method !== 'POST') { sendEmpty(req, res, 405); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw rpcError(-32600, 'Content-Type must be application/json', 415);
      const accepted = String(req.headers.accept || '').toLowerCase().split(',').filter(value => !/;\s*q\s*=\s*0(?:\.0*)?\s*(?:;|$)/.test(value)).map(value => value.split(';')[0].trim());
      if (!accepted.includes('application/json') || !accepted.includes('text/event-stream')) throw rpcError(-32600, 'Accept must include application/json and text/event-stream', 406);
      try { message = await readBody(req, signal); } catch (error) { if (error.statusCode === 400) error.code = -32700; throw error; }
      if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method || message.method.length > 200
        || Object.keys(message).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) throw rpcError(-32600, 'Invalid JSON-RPC request', 400);
      const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
      if (hasId && !validId(message.id)) throw rpcError(-32600, 'Invalid JSON-RPC ID', 400);
      if (message.params !== undefined && !record(message.params)) throw rpcError(-32602, 'Method parameters must be an object', 400);
      auditContext.operation = ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read',
        'notifications/initialized', 'notifications/cancelled'].includes(message.method) ? 'mcp.' + message.method : 'mcp.unknown';
      auditContext.parameters = { rpcRequestId: hasId ? message.id : null };
      if (message.method === 'initialize') {
        if (sessionId || !hasId) throw rpcError(-32600, 'initialize requires ID and no previous session', 400);
        const params = message.params;
        if (!record(params) || Object.keys(params).some(key => !['protocolVersion', 'clientInfo', 'capabilities', '_meta'].includes(key))
          || typeof params.protocolVersion !== 'string' || !params.protocolVersion || params.protocolVersion.length > 100
          || !record(params.clientInfo) || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name || params.clientInfo.name.length > 200
          || typeof params.clientInfo.version !== 'string' || !params.clientInfo.version || params.clientInfo.version.length > 100
          || !record(params.capabilities) || params._meta !== undefined && !record(params._meta)) throw rpcError(-32602, 'Invalid initialize parameters');
        if (this.sessions.size >= LIMITS.httpSessions) throw rpcError(-32000, 'HTTP session capacity reached', 429);
        const version = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
        session = { id: auditContext.transportSessionId, principal: 'http:operator', version, state: 'initializing', target: this.target(req, query),
          createdAt: Date.now(), touched: Date.now(), seen: new Set([typedId(message.id)]), active: new Map() };
        this.server.audit.bestEffort('auth.succeeded', { ...auditContext, parameters: {
          address: req.socket.remoteAddress, clientName: params.clientInfo.name, version: params.clientInfo.version } });
        this.sessions.set(session.id, session);
        res.setHeader('Mcp-Session-Id', session.id); res.setHeader('MCP-Protocol-Version', version);
        sendJson(req, res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: version,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          instructions: this.server.instructions,
          serverInfo: { name: 'page-agent-arp', title: this.server.serverName, version: this.server.version } } }); return;
      }
      if (!session) throw rpcError(-32600, 'Mcp-Session-Id required', 400);
      if (!hasId) {
        if (message.method === 'notifications/initialized') {
          const params = message.params || {};
          if (Object.keys(params).some(key => key !== '_meta') || params._meta !== undefined && !record(params._meta)) throw rpcError(-32602, 'Invalid initialized parameters', 400);
          if (session.state !== 'initializing') throw rpcError(-32600, 'Already initialized', 400);
          session.state = 'ready';
        } else if (message.method === 'notifications/cancelled') {
          if (!record(message.params) || !validId(message.params.requestId)
            || Object.keys(message.params).some(key => !['requestId', 'reason', '_meta'].includes(key))
            || message.params.reason !== undefined && (typeof message.params.reason !== 'string' || message.params.reason.length > 1000)
            || message.params._meta !== undefined && !record(message.params._meta)) throw rpcError(-32602, 'Invalid cancellation parameters', 400);
          this.server.audit.bestEffort('cancel.requested', { ...auditContext, parameters: { rpcRequestId: message.params.requestId } });
          const item = session.active.get(typedId(message.params.requestId)); if (item) item.controller.abort('HTTP cancellation');
        } else if (['ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read'].includes(message.method)) throw rpcError(-32600, 'Request method requires an ID', 400);
        sendEmpty(req, res, 202); return;
      }
      if (session.state !== 'ready') throw rpcError(-32600, 'Session not initialized', 400);
      const key = typedId(message.id);
      if (session.seen.has(key)) throw rpcError(-32600, 'Duplicate ID; original execution must not be replayed');
      if (session.seen.size >= LIMITS.seenRequests) throw rpcError(-32000, 'Session ID capacity reached; initialize a new session', 429);
      session.seen.add(key);
      const business = ['tools/call', 'resources/list', 'resources/read'].includes(message.method);
      const target = this.target(req, query, session, message.method === 'tools/call' && message.params && message.params.arguments ? message.params.arguments.mcpClientId : undefined);
      if (!business) { sendJson(req, res, 200, { jsonrpc: '2.0', id: message.id, result: await this.dispatch(message, {}) }); return; }
      if (session.active.size >= LIMITS.httpSessionActive || this.active >= LIMITS.httpActive) throw rpcError(-32000, 'HTTP execution capacity reached', 429);
      const controller = new AbortController(); const lifecycle = { pending: new Set() };
      session.active.set(key, { controller }); this.active++;
      const abort = () => controller.abort('HTTP disconnected'); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timeout = setTimeout(() => controller.abort('HTTP response timeout'), message.method === 'tools/call' ? 180000 : 30000);
      const requestId = auditContext.requestId;
      const options = { target, signal: controller.signal, lifecycle,
        context: { sessionId: session.id, conversationId: session.id, parentRequest: { transportSessionId: session.id, requestId } },
        rpcRequestId: message.id };
      try {
        const result = await this.server.withClientTarget({ clientId: target }, () => this.dispatch(message, options), options);
        sendJson(req, res, 200, { jsonrpc: '2.0', id: message.id, result });
      } catch (error) { failure(error); }
      finally {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        Promise.allSettled([...lifecycle.pending]).then(() => {
          session.active.delete(key); this.active--; session.touched = Date.now();
          if (session.state === 'closing' && !session.active.size) this.sessions.delete(session.id);
        });
      }
    } catch (error) { failure(error); }
  }
  close() { clearInterval(this.timer); for (const session of this.sessions.values()) this.remove(session); }
}
module.exports = { McpHttpHandler, canonicalToMcpUri, mcpToCanonicalUri };
