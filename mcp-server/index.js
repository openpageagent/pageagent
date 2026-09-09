#!/usr/bin/env node
'use strict';

// MCP is an ARP/1 transport adapter. It does not own another tool catalog.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  RequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { AsyncLocalStorage } = require('async_hooks');
const WebSocket = require('ws');
const arp = require('../resources/protocol/index.js');
const { createHttpApi } = require('./http-api');
const {
  ExtensionRequestBroker,
  isArpEnvelope,
  normalizeTransportContext,
} = require('./extension-request-broker');
const { version: SERVER_VERSION } = require('./package.json');

function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index] || '');
    const next = () => {
      const value = args[index + 1];
      index++;
      return value;
    };
    if (arg === '--ws-port') parsed.wsPort = next();
    else if (arg === '--http-port') parsed.httpPort = next();
    else if (arg === '--host') parsed.host = next();
    else if (arg === '--ws-host') parsed.wsHost = next();
    else if (arg === '--http-host') parsed.httpHost = next();
    else if (arg === '--default-client') parsed.defaultClient = next();
    else if (arg === '--default-client-id') parsed.defaultClientId = next();
    else if (arg === '--default-client-name') parsed.defaultClientName = next();
  }
  return parsed;
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

const CLI_ARGS = parseCliArgs(process.argv.slice(2));
const WS_PORT = normalizePort(CLI_ARGS.wsPort, normalizePort(process.env.WS_PORT, 9999));
const HTTP_PORT = normalizePort(CLI_ARGS.httpPort, normalizePort(process.env.HTTP_PORT, 9998));
const DEFAULT_BIND_HOST = '127.0.0.1';
const WS_HOST = String(
  CLI_ARGS.wsHost || CLI_ARGS.host || process.env.PAGE_AGENT_WS_HOST
  || process.env.PAGE_AGENT_HOST || DEFAULT_BIND_HOST
).trim() || DEFAULT_BIND_HOST;
const HTTP_HOST = String(
  CLI_ARGS.httpHost || CLI_ARGS.host || process.env.PAGE_AGENT_HTTP_HOST
  || process.env.PAGE_AGENT_HOST || DEFAULT_BIND_HOST
).trim() || DEFAULT_BIND_HOST;
const HTTP_CORS_ORIGINS = String(
  process.env.PAGE_AGENT_HTTP_CORS_ORIGINS || ''
).trim();
const HTTP_MCP_BEARER_TOKEN = String(
  process.env.PAGE_AGENT_HTTP_BEARER_TOKEN || ''
).trim();
const MCP_TOOL_TIMEOUT_MS = 180000;
const WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_CLIENT_SELECTOR = Object.freeze({
  any: String(CLI_ARGS.defaultClient || process.env.PAGE_AGENT_DEFAULT_CLIENT || '').trim(),
  clientId: String(CLI_ARGS.defaultClientId || process.env.PAGE_AGENT_DEFAULT_CLIENT_ID || '').trim(),
  clientName: String(CLI_ARGS.defaultClientName || process.env.PAGE_AGENT_DEFAULT_CLIENT_NAME || '').trim(),
});

function closeListeningServer(server) {
  if (!server || typeof server.close !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      else if (typeof server.closeActiveConnections === 'function') server.closeActiveConnections();
    } catch (error) {
      if (error && error.code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    }
  });
}

function isListeningServer(server) {
  if (!server) return true;
  if (server.listening === true) return true;
  if (typeof server.address !== 'function') return false;
  try { return server.address() !== null; } catch (_) { return false; }
}

function waitForListeningServer(server, label) {
  if (!server || typeof server.once !== 'function' || typeof server.removeListener !== 'function') {
    return Promise.resolve();
  }
  const observable = typeof server.address === 'function' || typeof server.listening === 'boolean';
  if (!observable || isListeningServer(server)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      server.removeListener('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onListening = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error(`${label} server closed before listening`));
    server.once('listening', onListening);
    server.once('error', onError);
    server.once('close', onClose);
    if (isListeningServer(server)) onListening();
  });
}

function canonicalToMcpUri(uri) {
  return 'arp://' + arp.canonicalizeUri(uri, { allowRoot: true });
}

function mcpToCanonicalUri(uri) {
  const text = String(uri || '');
  if (!text.startsWith('arp:///') || /[?#]/.test(text)) {
    throw new Error('MCP resource URI must use arp:/// followed by one canonical ARP path');
  }
  return arp.canonicalizeUri(text.slice('arp://'.length), { allowRoot: true });
}

function createMcpToolDefinitions() {
  return arp.createToolDefinitions()
    .filter((definition) => arp.METHODS.includes(definition.name))
    .map((definition) => {
      const inputSchema = Object.assign({}, definition.inputSchema, {
        properties: Object.assign({}, definition.inputSchema.properties, {
          mcpClientId: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            pattern: '\\S',
            description: '目标 Extension 客户端 ID。连接多个客户端时必须显式传入。',
          },
        }),
      });
      return Object.assign({}, definition, { inputSchema });
    });
}

class PageAgentMCPServer {
  constructor(options = {}) {
    this.wsPort = options.wsPort !== undefined ? options.wsPort : WS_PORT;
    this.httpPort = options.httpPort !== undefined ? options.httpPort : HTTP_PORT;
    this.wsHost = options.wsHost || WS_HOST;
    this.httpHost = options.httpHost || HTTP_HOST;
    this.installSignalHandlers = options.installSignalHandlers === true;
    this._closePromise = null;
    this._closing = false;
    this._networkReady = false;
    this._stdioInput = null;
    this._stdioEndHandler = null;
    this.transportSessionId = String(options.sessionId || this.generateId('mcp_session'));
    this.defaultTransportContext = normalizeTransportContext({
      sessionId: this.transportSessionId,
      conversationId: this.transportSessionId,
    });

    this.toolDefinitions = createMcpToolDefinitions();
    if (this.toolDefinitions.length !== 6) {
      throw new Error(`ARP MCP surface must contain exactly 6 resource methods, got ${this.toolDefinitions.length}`);
    }

    this.server = new Server(
      { name: 'page-agent-arp', version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } }
    );
    this.wsServer = options.wsServer || new WebSocket.Server({
      port: this.wsPort,
      host: this.wsHost,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
    });
    this.extensionWs = null;
    this.extensionClients = new Map();
    this.clientCallContext = new AsyncLocalStorage();
    this.requestBroker = new ExtensionRequestBroker();
    this.pendingRequests = this.requestBroker.pendingRequests;

    this.setupWebSocket();
    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.setupErrorHandling();

    this.httpServer = options.httpServer || createHttpApi({
      callArp: (method, request, timeoutMs, callOptions) => this.callArp(method, request, timeoutMs, callOptions),
      withClientTarget: (target, fn, callOptions) => this.withClientTarget(target, fn, callOptions),
      getExtensionClients: () => this.listExtensionClients(),
      createCorrelationContext: (hint) => this.createCorrelationContext(hint),
      handleMcpMessage: (message, requestOptions) => this.handleHttpMcpMessage(message, requestOptions),
      mcpBearerToken: options.httpMcpBearerToken !== undefined
        ? options.httpMcpBearerToken
        : HTTP_MCP_BEARER_TOKEN,
      port: this.httpPort,
      host: this.httpHost,
      allowedOrigins: options.allowedHttpOrigins !== undefined
        ? options.allowedHttpOrigins
        : HTTP_CORS_ORIGINS,
      pollIntervalMs: options.httpPollIntervalMs,
    });
    if (this.httpServer && typeof this.httpServer.on === 'function') {
      this.httpServer.on('error', (error) => {
        if (!this._closing && this._networkReady) console.error('[HTTP API] Server error:', error);
      });
    }
    this._networkStartup = Promise.all([
      waitForListeningServer(this.wsServer, 'WebSocket'),
      waitForListeningServer(this.httpServer, 'HTTP'),
    ]).then(() => {
      this._networkReady = true;
      return null;
    }, (error) => {
      if (!this._closing) console.error('[MCP Server] Network startup failed:', error);
      return error;
    });
  }

  generateId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  createCorrelationContext(hint) {
    const safeHint = String(hint || '').trim();
    const sessionId = safeHint || this.transportSessionId;
    return normalizeTransportContext({ sessionId, conversationId: sessionId });
  }

  setupWebSocket() {
    this.wsServer.on('connection', (ws, request) => {
      const socketId = this.generateId('socket');
      const record = this.registerExtensionClient(ws, {
        clientId: socketId,
        clientName: socketId,
        source: 'socket',
        remoteAddress: request && request.socket ? request.socket.remoteAddress : '',
      });
      console.error(`[WebSocket] Extension connected: ${record.clientId}`);
      ws.on('message', (data) => {
        try { this.handleExtensionMessage(JSON.parse(data.toString()), ws); }
        catch (error) { console.error('[WebSocket] Parse error:', error.message); }
      });
      ws.on('close', () => {
        const removed = this.unregisterExtensionClient(ws);
        console.error('[WebSocket] Extension disconnected' + (removed ? `: ${removed.clientId}` : ''));
      });
      ws.on('error', (error) => console.error('[WebSocket] Error:', error.message));
    });
    this.wsServer.on('error', (error) => {
      if (!this._closing && this._networkReady) console.error('[WebSocket] Server error:', error);
    });
    console.error(`[WebSocket] ARP/1 transport listening on ws://${this.wsHost}:${this.wsPort}`);
  }

  normalizeClientInfo(info, fallback = {}) {
    info = info && typeof info === 'object' ? info : {};
    const clientId = String(info.clientId || fallback.clientId || this.generateId('socket')).trim();
    const clientName = String(info.clientName || info.name || fallback.clientName || clientId).trim();
    return {
      clientId,
      clientName,
      source: info.source || fallback.source || 'extension',
      protocol: String(info.protocol || fallback.protocol || 'arp/1'),
      extensionId: String(info.extensionId || '').trim(),
      extensionName: String(info.extensionName || '').trim(),
      extensionVersion: String(info.extensionVersion || '').trim(),
      browser: String(info.browser || '').trim(),
      profile: String(info.profile || '').trim(),
      os: String(info.os || '').trim(),
      language: String(info.language || '').trim(),
      incognito: info.incognito === true || info.incognitoContext === true,
      incognitoContext: info.incognito === true || info.incognitoContext === true,
      incognitoAccess: info.incognitoAccess === true,
      connectedAt: fallback.connectedAt || Date.now(),
      lastSeenAt: Date.now(),
      remoteAddress: String(info.remoteAddress || fallback.remoteAddress || '').trim(),
    };
  }

  registerExtensionClient(ws, info) {
    const previousId = ws.__pageAgentClientId;
    const previous = previousId ? this.extensionClients.get(previousId) : null;
    const client = this.normalizeClientInfo(info, Object.assign({}, previous || {}, info || {}));
    if (previousId && previousId !== client.clientId) this.extensionClients.delete(previousId);
    const existing = this.extensionClients.get(client.clientId);
    if (existing && existing.ws !== ws) {
      this.requestBroker.rejectForSocket(existing.ws, `Extension client replaced: ${client.clientId}`);
      try { existing.ws.close(1000, 'Replaced by a newer ARP connection'); } catch (_) {}
    }
    const record = Object.assign({}, existing || {}, client, {
      ws,
      connectedAt: existing && existing.ws === ws ? existing.connectedAt : client.connectedAt,
      lastSeenAt: Date.now(),
    });
    ws.__pageAgentClientId = record.clientId;
    this.extensionClients.set(record.clientId, record);
    this.extensionWs = this.getOnlyOrFirstExtensionWs();
    return record;
  }

  unregisterExtensionClient(ws) {
    let removed = null;
    for (const [clientId, record] of this.extensionClients.entries()) {
      if (record.ws !== ws) continue;
      removed = record;
      this.extensionClients.delete(clientId);
    }
    this.requestBroker.rejectForSocket(ws, removed
      ? `Extension client disconnected: ${removed.clientId}`
      : 'Extension client disconnected');
    this.extensionWs = this.getOnlyOrFirstExtensionWs();
    return removed;
  }

  getOnlyOrFirstExtensionWs() {
    const record = Array.from(this.extensionClients.values())
      .find((client) => client.ws && client.ws.readyState === WebSocket.OPEN);
    return record ? record.ws : null;
  }

  handleExtensionMessage(message, ws) {
    if (message && message.type === 'heartbeat') {
      const clientId = ws && ws.__pageAgentClientId;
      const record = clientId ? this.extensionClients.get(clientId) : null;
      if (record) record.lastSeenAt = Date.now();
      return;
    }
    if (message && message.type === 'hello') {
      const currentId = ws && ws.__pageAgentClientId;
      const current = currentId ? this.extensionClients.get(currentId) : null;
      const record = this.registerExtensionClient(ws, Object.assign(
        {}, current || {}, message.clientInfo || {},
        { protocol: message.protocol || message.clientInfo && message.clientInfo.protocol || 'arp/1', remoteAddress: current && current.remoteAddress }
      ));
      console.error(`[WebSocket] Extension registered: ${record.clientId} (${record.clientName}) protocol=${record.protocol}`);
      try {
        ws.send(JSON.stringify({
          type: 'hello',
          server: 'page-agent-arp',
          version: SERVER_VERSION,
          protocol: 'arp/1',
          clientId: record.clientId,
          connectedClients: this.listExtensionClients().length,
        }));
      } catch (error) {
        console.error('[WebSocket] Failed to send hello ack:', error.message);
      }
      return;
    }
    const outcome = this.requestBroker.handleResponse(message, ws);
    if (outcome === 'wrong-socket') {
      console.error(`[WebSocket] Ignoring response for request ${message.requestId} from non-target client`);
    }
  }

  getCurrentCallContext() {
    return this.clientCallContext.getStore() || {};
  }

  async callArp(method, request, timeoutMs = 30000, options = {}) {
    const current = this.getCurrentCallContext();
    const client = this.resolveExtensionClient(current.clientSelector);
    const context = normalizeTransportContext(options.context || current.transportContext || this.defaultTransportContext);
    return this.requestBroker.call({
      ws: client.ws,
      clientId: client.clientId,
      method,
      request,
      context,
      timeoutMs,
      signal: options.signal || current.signal || null,
    });
  }

  callMcpTool(method, args, options = {}) {
    const request = Object.assign({}, args || {});
    const mcpClientId = String(request.mcpClientId || '').trim();
    delete request.mcpClientId;
    if (!mcpClientId && this.listExtensionClients().length > 1) {
      const error = new Error('Multiple Extension clients are connected; pass mcpClientId in this Method Tool call');
      error.code = ErrorCode.InvalidParams;
      throw error;
    }
    const invoke = () => this.callArp(method, request, MCP_TOOL_TIMEOUT_MS, options);
    return mcpClientId
      ? this.withClientTarget({ clientId: mcpClientId }, invoke, options)
      : invoke();
  }

  withClientTarget(target, fn, options = {}) {
    const current = this.getCurrentCallContext();
    return this.clientCallContext.run({
      clientSelector: this.normalizeClientSelector(target),
      transportContext: options.context || current.transportContext || this.defaultTransportContext,
      signal: options.signal || current.signal || null,
    }, fn);
  }

  normalizeSelectorBoolean(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'incognito', 'private'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', 'regular'].includes(text)) return false;
    return undefined;
  }

  normalizeClientSelector(value) {
    if (!value) return {};
    if (typeof value === 'string') return value.trim() ? { any: value.trim() } : {};
    if (typeof value !== 'object') return {};
    const selector = {
      any: String(value.any || value.mcpClient || '').trim(),
      clientId: String(value.clientId || value.mcpClientId || '').trim(),
      clientName: String(value.clientName || value.mcpClientName || '').trim(),
      browser: String(value.browser || '').trim(),
      profile: String(value.profile || '').trim(),
      extensionId: String(value.extensionId || '').trim(),
    };
    const incognito = this.normalizeSelectorBoolean(value.incognito !== undefined
      ? value.incognito
      : value.mcpClientIncognito);
    if (incognito !== undefined) selector.incognito = incognito;
    Object.keys(selector).forEach((key) => {
      if (selector[key] === '' || selector[key] === undefined) delete selector[key];
    });
    return selector;
  }

  hasSelector(selector) {
    return !!(selector && Object.keys(selector).some((key) => selector[key] !== '' && selector[key] !== undefined));
  }

  clientMatchesSelector(record, selector) {
    const lower = (value) => String(value || '').toLowerCase();
    if (selector.clientId && record.clientId !== selector.clientId) return false;
    if (selector.clientName && lower(record.clientName) !== lower(selector.clientName)) return false;
    if (selector.browser && lower(record.browser) !== lower(selector.browser)) return false;
    if (selector.profile && lower(record.profile) !== lower(selector.profile)) return false;
    if (selector.extensionId && record.extensionId !== selector.extensionId) return false;
    if (selector.incognito !== undefined && !!record.incognito !== !!selector.incognito) return false;
    if (selector.any) {
      const query = lower(selector.any);
      const values = [record.clientId, record.clientName, record.browser, record.profile, record.extensionId].map(lower);
      if (!values.some((value) => value === query || value.includes(query))) return false;
    }
    return true;
  }

  resolveExtensionClient(selector) {
    const clients = Array.from(this.extensionClients.values())
      .filter((record) => record.ws && record.ws.readyState === WebSocket.OPEN);
    if (!clients.length) throw new Error('Chrome Extension ARP transport is not connected');
    const explicit = this.normalizeClientSelector(selector);
    const effective = this.hasSelector(explicit)
      ? explicit
      : this.normalizeClientSelector(DEFAULT_CLIENT_SELECTOR);
    if (!this.hasSelector(effective)) {
      if (clients.length === 1) return clients[0];
      throw new Error('Multiple Extension clients are connected; configure --default-client-id or PAGE_AGENT_DEFAULT_CLIENT_ID');
    }
    const matches = clients.filter((record) => this.clientMatchesSelector(record, effective));
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error('No Extension client matches the configured default selector');
    throw new Error('The configured default selector matches multiple Extension clients');
  }

  listExtensionClients() {
    const now = Date.now();
    return Array.from(this.extensionClients.values())
      .filter((record) => record.ws && record.ws.readyState === WebSocket.OPEN)
      .map((record) => ({
        clientId: record.clientId,
        clientName: record.clientName,
        protocol: record.protocol,
        extensionId: record.extensionId,
        extensionName: record.extensionName,
        extensionVersion: record.extensionVersion,
        browser: record.browser,
        profile: record.profile,
        os: record.os,
        language: record.language,
        incognito: !!record.incognito,
        connectedAt: record.connectedAt,
        lastSeenAt: record.lastSeenAt,
        idleMs: now - Number(record.lastSeenAt || now),
        remoteAddress: record.remoteAddress,
        pendingRequestCount: this.requestBroker.countForClient(record.clientId),
      }));
  }

  setValidatedRequestHandler(schema, handler) {
    const method = schema.shape.method.value;
    const envelopeSchema = RequestSchema.extend({ method: schema.shape.method }).passthrough();
    this.server.setRequestHandler(envelopeSchema, async (request, extra) => {
      const parsed = schema.safeParse(request);
      if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 3).map((issue) => {
          const path = issue.path && issue.path.length ? issue.path.join('.') : 'request';
          return `${path}: ${issue.message}`;
        }).join('; ');
        const error = new Error(`Invalid params for ${method}${details ? `: ${details}` : ''}`);
        error.code = ErrorCode.InvalidParams;
        throw error;
      }
      return handler(parsed.data, extra || {});
    });
  }

  localErrorEnvelope(code, message, options = {}) {
    const error = arp.arpError(code, message, {
      status: options.status,
      retryable: options.retryable === true,
      performed: 'no',
    });
    return arp.createErrorResponse(this.generateId('arp_mcp'), error, { performed: 'no' });
  }

  inlineImageContents(envelope) {
    const modelContent = envelope && envelope.primary && envelope.primary.data
      && envelope.primary.data.modelContent;
    if (!Array.isArray(modelContent)) return [];
    const seen = new Set();
    return modelContent.filter((part) => (
      part && part.type === 'image'
      && typeof part.data === 'string' && part.data.length > 0
      && /^image\/[A-Za-z0-9.+-]+$/.test(String(part.mimeType || ''))
    )).map((part) => {
      const key = `${part.mimeType}:${part.data.length}:${part.data.slice(0, 32)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return { type: 'image', data: part.data, mimeType: part.mimeType };
    }).filter(Boolean);
  }

  stripInlineImageData(value) {
    if (Array.isArray(value)) return value.map((item) => this.stripInlineImageData(item));
    if (!value || typeof value !== 'object') return value;
    const output = {};
    Object.keys(value).forEach((key) => {
      if (key === 'data' && value.type === 'image' && typeof value.data === 'string') return;
      output[key] = this.stripInlineImageData(value[key]);
    });
    if (value.type === 'image' && typeof value.data === 'string') output.inlineData = true;
    return output;
  }

  toolResult(envelope) {
    const isError = !isArpEnvelope(envelope) || Number(envelope.status.code) >= 400;
    const imageContents = this.inlineImageContents(envelope);
    const projectedEnvelope = imageContents.length ? this.stripInlineImageData(envelope) : envelope;
    return {
      content: [{ type: 'text', text: JSON.stringify(projectedEnvelope, null, 2) }].concat(imageContents),
      structuredContent: projectedEnvelope,
      isError,
    };
  }

  async handleHttpMcpMessage(message, options = {}) {
    const method = String(message && message.method || '');
    const params = message && message.params && typeof message.params === 'object'
      ? message.params
      : {};
    if (method === 'initialize') {
      const requestedVersion = String(params.protocolVersion || '2025-11-25');
      const protocolVersion = requestedVersion === '2025-06-18'
        ? requestedVersion
        : '2025-11-25';
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'page-agent-arp', version: SERVER_VERSION },
        instructions: 'Page Agent ARP/1 method tools backed by the connected browser extension.',
      };
    }
    if (method === 'notifications/initialized' || method === 'ping') return {};
    if (method === 'tools/list') return { tools: this.toolDefinitions };
    if (method === 'tools/call') {
      const name = String(params.name || '');
      if (!arp.METHODS.includes(name)) {
        const error = new Error(`Unknown ARP method tool: ${name}`);
        error.code = ErrorCode.InvalidParams;
        throw error;
      }
      const envelope = await this.callMcpTool(name, params.arguments, {
        signal: options.signal,
        context: options.context,
      });
      return this.toolResult(envelope);
    }
    const error = new Error(`Method not found: ${method || '(empty)'}`);
    error.code = ErrorCode.MethodNotFound;
    throw error;
  }

  setupToolHandlers() {
    this.setValidatedRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolDefinitions,
    }));

    this.setValidatedRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = String(request.params.name || '');
      const args = request.params.arguments || {};
      if (!arp.METHODS.includes(name)) {
        return this.toolResult(this.localErrorEnvelope('INVALID_REQUEST', `Unknown ARP method tool: ${name}`));
      }
      try {
        const envelope = await this.callMcpTool(name, args, { signal: extra.signal });
        return this.toolResult(envelope);
      } catch (error) {
        if (error && error.code === ErrorCode.InvalidParams) {
          return this.toolResult(this.localErrorEnvelope('INVALID_REQUEST', error.message, { status: 400 }));
        }
        if (error && error.name !== 'AbortError') {
          console.error(`[MCP Tool] ${name} transport failed: ${error.message}`);
        }
        return this.toolResult(this.localErrorEnvelope(
          'TEMPORARILY_UNAVAILABLE',
          `ARP Extension transport failed: ${error.message}`,
          { status: 503, retryable: true }
        ));
      }
    });
  }

  setupResourceHandlers() {
    const rootResource = {
      uri: canonicalToMcpUri('/'),
      name: 'ARP/1 resources',
      description: 'Read to discover registered first-level resources.',
      mimeType: 'application/json',
    };
    this.setValidatedRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
      try {
        const envelope = await this.callArp('OPTIONS', { uri: '/' }, 30000, { signal: extra.signal });
        const discovered = envelope && envelope.capabilities && Array.isArray(envelope.capabilities.resources)
          ? envelope.capabilities.resources : [];
        return {
          resources: [rootResource].concat(discovered.map((resource) => ({
            uri: canonicalToMcpUri(resource.href),
            name: resource.type || resource.relation || resource.href,
            description: resource.relation ? `ARP relation: ${resource.relation}` : 'Registered ARP resource.',
            mimeType: 'application/json',
          }))),
        };
      } catch (_) {
        return { resources: [rootResource] };
      }
    });
    this.setValidatedRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const resourceUri = String(request.params.uri || '');
      try {
        const canonicalUri = mcpToCanonicalUri(resourceUri);
        const namespace = canonicalUri === '/' || canonicalUri === '/page' || canonicalUri === '/browser';
        const method = namespace ? 'OPTIONS' : 'GET';
        const envelope = await this.callArp(method, { uri: canonicalUri }, 30000, { signal: extra.signal });
        const imageContents = this.inlineImageContents(envelope);
        if (imageContents.length) {
          return {
            contents: imageContents.map((image) => ({
              uri: resourceUri,
              mimeType: image.mimeType,
              blob: image.data,
            })),
          };
        }
        return {
          contents: [{
            uri: resourceUri,
            mimeType: 'application/json',
            text: JSON.stringify(envelope, null, 2),
          }],
        };
      } catch (error) {
        const envelope = this.localErrorEnvelope(
          'UPSTREAM_FAILED',
          `Failed to read ARP resource ${resourceUri}: ${error.message}`,
          { status: 502, retryable: true }
        );
        return {
          contents: [{
            uri: resourceUri,
            mimeType: 'application/json',
            text: JSON.stringify(envelope, null, 2),
          }],
        };
      }
    });
  }

  setupErrorHandling() {
    this.server.onerror = (error) => console.error('[MCP Server Error]', error);
    this.server.onclose = () => {
      if (this._closing) return;
      this.close({ skipMcp: true, reason: 'MCP transport closed' }).catch((error) => {
        console.error('[MCP Server] Failed to close after transport disconnect:', error);
      });
    };
    if (!this.installSignalHandlers) return;
    this._signalHandler = async () => {
      try {
        await this.close({ reason: 'Process signal received' });
        process.exit(0);
      } catch (error) {
        console.error('[MCP Server] Shutdown failed:', error);
        process.exit(1);
      }
    };
    process.once('SIGINT', this._signalHandler);
    process.once('SIGTERM', this._signalHandler);
  }

  async run(transport = new StdioServerTransport()) {
    try {
      const startupError = await this._networkStartup;
      if (startupError) throw startupError;
      this.transport = transport;
      await this.server.connect(transport);
      const input = transport && transport._stdin;
      if (input && typeof input.once === 'function') {
        this._stdioInput = input;
        this._stdioEndHandler = () => {
          if (this._closing) return;
          this.close({ reason: 'MCP stdio closed' }).catch((error) => {
            console.error('[MCP Server] Failed to close after stdio EOF:', error);
          });
        };
        input.once('end', this._stdioEndHandler);
        input.once('close', this._stdioEndHandler);
        if (input.readableEnded || input.destroyed) {
          await this.close({ reason: 'MCP stdio closed' });
          return;
        }
      }
      console.error('Page Agent ARP/1 MCP Server running');
      console.error(`WebSocket transport: ws://${this.wsHost}:${this.wsPort}`);
      console.error('MCP tools: GET POST PUT PATCH DELETE OPTIONS');
    } catch (error) {
      try { await this.close({ reason: 'MCP startup failed' }); }
      catch (closeError) { console.error('[MCP Server] Failed to clean up:', closeError); }
      throw error;
    }
  }

  close(options = {}) {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this.requestBroker.close(options.reason || 'MCP server closed');
    if (this._stdioInput && this._stdioEndHandler) {
      this._stdioInput.removeListener('end', this._stdioEndHandler);
      this._stdioInput.removeListener('close', this._stdioEndHandler);
    }
    if (this._signalHandler) {
      process.removeListener('SIGINT', this._signalHandler);
      process.removeListener('SIGTERM', this._signalHandler);
    }
    for (const record of this.extensionClients.values()) {
      const socket = record && record.ws;
      if (!socket) continue;
      try {
        if (typeof socket.terminate === 'function') socket.terminate();
        else if (typeof socket.close === 'function') socket.close(1001, 'MCP server shutting down');
      } catch (_) {}
    }
    this.extensionClients.clear();
    this.extensionWs = null;
    this._closePromise = Promise.resolve().then(() => Promise.all([
      options.skipMcp ? Promise.resolve() : this.server.close(),
      closeListeningServer(this.httpServer),
      closeListeningServer(this.wsServer),
    ])).then(() => {});
    return this._closePromise;
  }
}

if (require.main === module) {
  const server = new PageAgentMCPServer({ installSignalHandlers: true });
  server.run().catch(async (error) => {
    console.error(error);
    try { await server.close({ reason: 'MCP startup failed' }); } catch (_) {}
    process.exitCode = 1;
  });
}

module.exports = PageAgentMCPServer;
module.exports.canonicalToMcpUri = canonicalToMcpUri;
module.exports.mcpToCanonicalUri = mcpToCanonicalUri;
