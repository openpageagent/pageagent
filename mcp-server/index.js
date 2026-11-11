#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const WebSocket = require('ws');
const arp = require('../resources/protocol');
const contract = require('../shared/mcp-contract');
const encryption = require('../shared/websocket-encryption');
const { AuthStore, generateCredential } = require('./auth-store');
const { AuditLog, unavailable: auditUnavailable } = require('./audit-log');
const { acquireLock } = require('./state-lock');
const { ExecutionControl, terminationCapability, safeError } = require('./execution-control');
const { EnvironmentInfo, discoverBash } = require('./environment-info');
const { capabilities: desktopCapabilities } = require('./desktop-operations');
const { createLocalConnection } = require('./local-connection');
const { createMailQueue } = require('./mail-queue');
const { ExtensionRequestBroker, isArpEnvelope, normalizeTransportContext } = require('./extension-request-broker');
const { createHttpApi } = require('./http-api');
const { McpHttpHandler, canonicalToMcpUri, mcpToCanonicalUri } = require('./mcp-http-handler');
const { createServerArp } = require('./server-arp');
const { Archive } = require('./archive');
const { version: SERVER_VERSION } = require('./package.json');
const { LIMITS } = contract;

function checkNodeVersion() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && (minor < 16 || minor === 16 && patch < 0)) throw new Error('Page Agent MCP Server requires Node >=22.16.0');
}
function parseCliArgs(argv) {
  const options = {}; const positional = [];
  const names = { '--ws-port': 'wsPort', '--http-port': 'httpPort', '--host': 'host', '--ws-host': 'wsHost',
    '--http-host': 'httpHost', '--server-name': 'serverName', '--state-dir': 'stateDir', '--password': 'password', '--audit-command-content': 'auditCommandContent' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const [name, ...rest] = argument.split('=');
    if (!Object.prototype.hasOwnProperty.call(names, name)) throw new Error('Unknown argument: ' + name);
    const value = rest.length ? rest.join('=') : argv[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing value: ' + name);
    options[names[name]] = value;
  }
  for (const key of ['wsPort', 'httpPort']) if (options[key] !== undefined) {
    const value = Number(options[key]); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid port'); options[key] = value;
  }
  if (options.auditCommandContent && !['hash', 'plain'].includes(options.auditCommandContent)) throw new Error('Invalid --audit-command-content');
  const command = positional.join(' ');
  if (positional.length && command !== 'auth set-password' && command !== 'auth pairings list'
    && !(positional.length === 4 && positional.slice(0, 3).join(' ') === 'auth pairings revoke')) throw new Error('Unknown command');
  if (options.password !== undefined) {
    if (command && command !== 'auth set-password') throw new Error('--password is only supported when starting the server or running auth set-password');
    contract.password(options.password);
  }
  return { options, positional };
}
function createManagementContext() {
  const account = os.userInfo();
  return { transportSessionId: randomUUID(), requestId: randomUUID(), parentRequest: null,
    principal: { transport: 'cli', id: 'os:' + account.username, clientId: null, pairingId: null },
    caller: null, callerAssurance: 'server_verified', executor: { user: account.username,
      uid: typeof process.geteuid === 'function' ? process.geteuid() : null,
      gid: typeof process.getegid === 'function' ? process.getegid() : null, pid: process.pid } };
}
async function setPassword(auth, audit, password, context = createManagementContext()) {
  const generated = password === undefined;
  if (generated) password = generateCredential();
  contract.password(password);
  await audit.write('execution.intent', { ...context, operation: 'password.change' });
  const result = await auth.setPassword(password, audit.serverId);
  audit.serverId = result.serverId;
  if (generated) console.error('自动生成的配对密码：' + password);
  password = undefined;
  await audit.write('password.changed', { ...context, operation: 'password.change', parameters: { authEpoch: result.authEpoch } });
  console.error('密码已设置；已有配对已撤销。');
  return result;
}
function listenReady(server) {
  return new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
}
function closeListener(server) {
  if (!server) return Promise.resolve();
  return new Promise(resolve => {
    try { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); else if (server.closeActiveConnections) server.closeActiveConnections(); }
    catch (_) { resolve(); }
  });
}
class PageAgentMCPServer {
  constructor(options = {}) {
    this.options = options; this.version = SERVER_VERSION; this.auth = new AuthStore(options.stateDir);
    this.serverName = contract.serverName(options.serverName ?? (String(process.env.PAGE_AGENT_SERVER_NAME || '').trim() || os.hostname()));
    this.clients = new Map(); this.sockets = new Map(); this.callContext = new AsyncLocalStorage();
    this.requestBroker = new ExtensionRequestBroker((socket, body, callback) => this.send(socket, body, callback));
    this.mailQueue = createMailQueue(); this.mailRequests = new Set(); this.closing = false;
    this.instructions = '本 MCP 的 /local/* 在服务端直接执行文件、Bash、环境与桌面操作，不依赖插件连接或插件授权，也不需要 mcpClientId、connectionId 或 workspaceId。'
      + '本地任务先 GET /local 获取支持的能力和链接，再 OPTIONS 具体路径获取参数，按声明的方法直接调用；无需经 /clients/{clientId}/arp 转发当前服务端的本地任务，该路径会先经过插件再回到服务端执行，并受插件权限管控。'
      + '只有访问插件资源才查询 GET /clients 并选择客户端；客户端绑定不改变 /local 的服务端归属。OPTIONS / 查看服务端资源目录。';
    this.toolDefinitions = arp.createToolDefinitions().filter(item => arp.METHODS.includes(item.name)).map(item => ({ ...item,
      description: this.instructions + '\n' + item.description,
      inputSchema: { ...item.inputSchema, properties: { ...item.inputSchema.properties,
        mcpClientId: { type: 'string', minLength: 1, maxLength: 200, description: '访问插件资源时的目标客户端 ID；服务端 /local、/clients 无需填写，也可使用 /clients/{clientId}/arp' } } } }));
  }
  async run() {
    checkNodeVersion();
    try {
      await this.auth.init();
      this.releaseProcess = await acquireLock(path.join(this.auth.directory, 'process.lock'), 0);
      console.error('数据目录：' + this.auth.directory);
      const state = await this.auth.read(true);
      this.serverId = state ? state.serverId : randomUUID();
      this.audit = new AuditLog(this.auth.directory, this.serverId, this.options.auditCommandContent || 'plain', available => this.broadcastStatus(available));
      await this.audit.init();
      const environmentPassword = String(process.env.PAGE_AGENT_PAIRING_PASSWORD || '').trim();
      delete process.env.PAGE_AGENT_PAIRING_PASSWORD;
      if (!state || this.options.password !== undefined) {
        let initialPassword = this.options.password;
        if (!state && initialPassword === undefined && environmentPassword) initialPassword = environmentPassword;
        const result = await setPassword(this.auth, this.audit, initialPassword);
        this.serverId = result.serverId;
        delete this.options.password;
      }
      const httpCredential = await this.auth.ensureHttpBearerToken(this.options.httpMcpBearerToken ?? process.env.PAGE_AGENT_HTTP_BEARER_TOKEN);
      if (httpCredential.generatedToken) console.error('自动生成的 HTTP MCP Bearer 令牌：' + httpCredential.generatedToken);
      delete httpCredential.generatedToken;
      delete this.options.httpMcpBearerToken;
      this.startupDirectory = await fs.realpath(process.cwd()); this.shell = await discoverBash();
      this.environment = new EnvironmentInfo(this.serverId, this.shell, () => this.broadcastStatus(this.audit.available)); await this.environment.snapshot(true);
      const desktop = desktopCapabilities();
      const desktopSupported = Object.keys(desktop.supported).length > 0;
      this.capabilities = { localProtocol: contract.LOCAL, files: ['read', 'write', 'delete', 'grep'],
        bash: { supported: !!this.shell, executable: this.shell },
        desktop: { supported: desktopSupported, actions: desktop.supported,
          reason: desktopSupported ? null : process.platform === 'linux' ? 'X11_SCREENSHOT_UNAVAILABLE' : 'PLATFORM_UNSUPPORTED',
          permissionsVerified: false, requirements: desktop.requirements },
        mail: { supported: true, protocol: 'smtp/1' }, configuration: { ...contract.CONFIGURATION, version: SERVER_VERSION },
        serverPolicy: 'allow-implemented', policyRevision: 1,
        environment: { schemaVersion: 1, disk: true, dynamicTtlMs: LIMITS.dynamicTtlMs },
        execution: { ...LIMITS, cancelAck: true, processTermination: terminationCapability(), cpuHardLimit: false, memoryHardLimit: false },
        audit: { enabled: true, available: true, commandContent: this.audit.commandContent } };
      this.execution = new ExecutionControl(this.audit);
      this.archive = new Archive(this);
      await this.archive.init();
      this.serverArp = createServerArp(this); this.httpHandler = new McpHttpHandler(this);
      const host = this.options.host || process.env.PAGE_AGENT_HOST || '127.0.0.1';
      const wsHost = this.options.wsHost || process.env.PAGE_AGENT_WS_HOST || host;
      const httpHost = this.options.httpHost || process.env.PAGE_AGENT_HTTP_HOST || host;
      const wsPort = this.options.wsPort || Number(process.env.WS_PORT) || 9999;
      const httpPort = this.options.httpPort || Number(process.env.HTTP_PORT) || 9998;
      this.wsServer = new WebSocket.Server({ host: wsHost, port: wsPort, maxPayload: encryption.MAX_FRAME_BYTES });
      const wsReady = listenReady(this.wsServer);
      this.wsServer.on('connection', (socket, request) => this.accept(socket, request));
      this.httpServer = createHttpApi({ port: httpPort, host: httpHost,
        mcpBearerTokenHash: httpCredential.hash,
        allowedOrigins: this.options.allowedHttpOrigins ?? process.env.PAGE_AGENT_HTTP_CORS_ORIGINS,
        getExtensionClients: () => this.listExtensionClients(),
        onAuthenticationFailure: address => {
          try { this.auth.checkRate(address); } catch (_) { return; }
          this.auth.failed(address);
          this.audit.bestEffort('auth.denied', { principal: null, operation: 'http.authenticate', errorReason: 'AUTH_FAILED' });
        },
        handleMcpHttp: (...args) => this.httpHandler.handle(...args) });
      await Promise.all([wsReady, listenReady(this.httpServer)]);
      this.revokeTimer = setInterval(() => this.checkRevocations(), 1000);
      if (this.options.installSignalHandlers) {
        this.signalHandler = () => this.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
        process.once('SIGINT', this.signalHandler); process.once('SIGTERM', this.signalHandler);
      }
      console.error(`Page Agent MCP ${SERVER_VERSION} [${this.serverName}]: ws://${wsHost}:${wsPort}, http://${httpHost}:${httpPort}/mcp`);
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  send(socket, body, callback) {
    if (socket.readyState !== WebSocket.OPEN) { if (callback) callback(new Error('Connection closed')); return; }
    const identity = socket.pageAgentIdentity;
    const frame = identity ? { ...body, transportProtocol: contract.TRANSPORT, serverId: identity.serverId,
      clientId: identity.clientId, transportSessionId: identity.transportSessionId, requestId: body.requestId || randomUUID() } : body;
    const failed = error => { socket.close(1011, 'Send failed'); if (callback) callback(error); };
    try {
      const text = JSON.stringify(frame);
      if (!identity) { socket.send(text, callback); return; }
      const record = this.sockets.get(socket);
      if (!record || !record.cipher) throw new Error('Encryption unavailable');
      record.sendQueue = record.sendQueue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Connection closed');
        const encrypted = await record.cipher.encrypt(text);
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Connection closed');
        socket.send(encrypted, error => { if (error) failed(error); else if (callback) callback(); });
      }).catch(failed);
    } catch (error) { failed(error); }
  }
  authError(socket, requestId, error) {
    this.send(socket, { type: 'auth.error', transportProtocol: contract.TRANSPORT, authProtocol: contract.AUTH,
      ...(requestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId) ? { requestId } : {}),
      code: error.code || 'AUTHENTICATION_REQUIRED', reason: error.reason || 'AUTH_FAILED', retryable: error.retryable === true,
      ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) });
  }
  accept(socket, request) {
    if (this.closing || [...this.sockets.values()].filter(item => !item.identity).length >= LIMITS.unauthenticated) { socket.close(1013, 'Authentication capacity reached'); return; }
    try { this.auth.checkRate(request.socket.remoteAddress || ''); }
    catch (error) { this.authError(socket, null, error); socket.close(1008, 'Authentication rate limited'); return; }
    const record = { socket, identity: null, state: 'authenticating', origin: String(request.headers.origin || '').replace(/\/$/, ''),
      address: request.socket.remoteAddress || '', activeMail: new Map(), activeArp: new Map(), seen: new Set(), processingAuth: false,
      cipher: null, sendQueue: Promise.resolve(), receiveQueue: Promise.resolve() };
    this.sockets.set(socket, record);
    record.authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), LIMITS.authTimeoutMs);
    this.send(socket, { type: 'auth.required', transportProtocol: contract.TRANSPORT, authProtocol: contract.AUTH,
      pairingVersion: contract.PAIRING, serverId: this.serverId });
    const auditInvalidFrame = reason => {
      if (record.local) this.audit.bestEffort('authorization.denied', {
        ...record.local.context({}), decision: 'deny', errorReason: reason,
      });
    };
    const dispatch = message => this.message(record, message).catch(error => {
      if (!record.identity) { this.authError(socket, message.requestId, error); socket.close(1008, 'Authentication failed'); }
      else if (error.reason === 'IDENTITY_MISMATCH' || error.reason === 'CREDENTIAL_REVOKED') { auditInvalidFrame(error.reason); socket.close(1008, error.reason); }
      else {
        if (message.type === 'arp.call') {
          this.audit.bestEffort('authorization.denied', { ...record.local.context(message), decision: 'deny', errorReason: error.reason || 'INVALID_REQUEST' });
          this.send(record.socket, { type: 'arp.response', requestId: message.requestId, envelope: this.arpFailure(error) }); return;
        }
        const type = { 'local.configure': 'local.configured', 'environment.get': 'environment.result', 'local.call': 'local.result', 'mail.send': 'mail.result' }[message.type];
        this.audit.bestEffort('authorization.denied', { ...record.local.context(message), decision: 'deny', errorReason: error.reason || 'INVALID_REQUEST' });
        if (!type) { socket.close(1008, 'Invalid control frame'); return; }
        this.send(socket, { type, requestId: message.requestId, ok: false, error: safeError(error), audit: { recorded: false },
          ...(type === 'environment.result' ? { scope: message.scope } : {}),
          ...(type === 'mail.result' ? { receipt: { performed: error.performed || 'no' } } : {}),
          ...(type === 'local.result' ? { ...contract.resultTarget(message),
            receipt: { performed: 'no' }, execution: { outcome: 'rejected', startedAt: null, finishedAt: null,
              durationMs: 0, effectiveTimeoutMs: null, termination: 'not_started', stopReason: null, stopReasonAssurance: null } } : {}) });
      }
    });
    socket.on('message', (data, isBinary) => {
      record.receiveQueue = record.receiveQueue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN || record.state === 'disconnected') return;
        if (isBinary) contract.fail('INVALID_FRAME');
        const authenticating = !record.identity;
        if (authenticating && data.length > LIMITS.authBytes) { this.auth.failed(record.address); socket.close(1009, 'Authentication message too large'); return; }
        let text = data.toString(), message = JSON.parse(text);
        if (!authenticating) { text = await record.cipher.decrypt(message); message = JSON.parse(text); }
        if (socket.readyState !== WebSocket.OPEN || record.state === 'disconnected') return;
        if (!contract.record(message)) contract.fail('INVALID_OBJECT');
        if (message.type === 'local.configure' && Buffer.byteLength(text) > LIMITS.configureBytes) { auditInvalidFrame('CONFIGURATION_TOO_LARGE'); socket.close(1009, 'Configuration too large'); return; }
        const work = dispatch(message);
        // Serialize authentication/decryption only; operations must allow cancellation and nested ARP calls.
        if (authenticating) await work;
      }).catch(error => {
        if (!record.identity) this.auth.failed(record.address);
        auditInvalidFrame(error.reason || 'INVALID_FRAME'); socket.close(1008, 'Invalid encrypted or authentication frame');
      });
    });
    socket.on('close', () => this.disconnect(record)); socket.on('error', () => {});
  }
  async message(record, message) {
    const { socket } = record;
    if (!record.identity) {
      if (record.processingAuth) contract.fail('AUTH_IN_PROGRESS'); record.processingAuth = true;
      try {
        const authenticated = await this.auth.authenticate(message, record.origin, record.address, async pairing => {
          await this.audit.write('execution.intent', { operation: 'pairing.create', requestId: message.requestId,
            transportSessionId: pairing.transportSessionId, claimedClientId: pairing.clientId,
            principal: { transport: 'websocket', id: pairing.clientId, clientId: pairing.clientId, pairingId: pairing.pairingId } });
        });
        const token = authenticated.token, communicationKey = authenticated.communicationKey;
        delete authenticated.token; delete authenticated.communicationKey;
        const cipher = await encryption.create(communicationKey, { ...authenticated, requestId: message.requestId }, false);
        if (socket.readyState !== WebSocket.OPEN || this.closing) return;
        const auditContext = { transportSessionId: authenticated.transportSessionId, requestId: message.requestId,
          principal: { transport: 'websocket', id: authenticated.clientId, clientId: authenticated.clientId, pairingId: authenticated.pairingId } };
        if (token) await this.audit.write('pairing.created', auditContext);
        await this.audit.write('auth.succeeded', { ...auditContext, parameters: {
          address: record.address, clientName: message.clientInfo.clientName, extensionId: message.clientInfo.extensionId,
          incognito: message.clientInfo.incognito, version: message.clientInfo.version } });
        await this.auth.assertActive(authenticated);
        if (socket.readyState !== WebSocket.OPEN || this.closing) return;
        const previous = this.clients.get(authenticated.clientId);
        // auth.ok has the authentication schema; bind the common layer afterwards.
        this.send(socket, { type: 'auth.ok', transportProtocol: contract.TRANSPORT, authProtocol: contract.AUTH,
          pairingVersion: contract.PAIRING,
          requestId: message.requestId, serverId: authenticated.serverId, clientId: authenticated.clientId,
          pairingId: authenticated.pairingId, transportSessionId: authenticated.transportSessionId, ...(token ? { token, communicationKey } : {}) });
        record.cipher = cipher; record.identity = authenticated; socket.pageAgentIdentity = authenticated;
        record.clientInfo = message.clientInfo; record.state = 'authenticated'; clearTimeout(record.authTimer);
        if (previous) {
          const revoked = previous.identity.pairingId !== authenticated.pairingId;
          this.disconnect(previous, revoked ? 'grant_revoked' : 'disconnect');
          previous.socket.close(revoked ? 1008 : 1000, revoked ? 'CREDENTIAL_REVOKED' : 'Authenticated reconnect');
        }
        this.clients.set(authenticated.clientId, record);
        record.local = createLocalConnection({ identity: authenticated, auth: this.auth, audit: this.audit, execution: this.execution,
          environment: this.environment, capabilities: this.capabilities, startupDirectory: this.startupDirectory, shell: this.shell,
          seen: record.seen, reply: body => this.send(socket, body), validateParent: (parent, identity) => this.requestBroker.validateParent(parent, identity) });
      } catch (error) {
        if (error.reason !== 'AUTH_RATE_LIMITED') await this.audit.bestEffort('auth.denied', { claimedClientId: typeof message.clientId === 'string' ? message.clientId.slice(0, 200) : null, errorReason: error.reason || 'AUTH_FAILED' });
        throw error;
      } finally { delete message.password; delete message.token; }
      return;
    }
    contract.frame(message, record.identity);
    if (message.type === 'arp.call.cancel') { const active = record.activeArp.get(message.requestId); if (active) active.abort('source_cancelled'); return; }
    if (message.type === 'local.cancel') { await record.local.handle(message); return; }
    if (message.type === 'mail.cancel') { const active = record.activeMail.get(message.requestId); if (active) active.abort(); return; }
    if (!['local.call', 'environment.get', 'local.configure'].includes(message.type)) await this.auth.assertActive(record.identity);
    if (message.type === 'arp.call') { await this.handleArpCall(record, message); return; }
    if (message.type === 'heartbeat') { record.lastSeenAt = Date.now(); return; }
    if (message.type === 'arp.result') { this.requestBroker.handleResponse(message, socket); return; }
    if (message.type === 'hello' || message.type === 'local.configure') {
      if (record.seen.has(message.requestId) || record.seen.size >= LIMITS.seenRequests) contract.fail('DUPLICATE_REQUEST');
      record.seen.add(message.requestId);
    }
    if (message.type === 'hello') {
      if (message.clientInfo.clientId !== record.identity.clientId || message.clientInfo.extensionId !== record.clientInfo.extensionId
        || message.clientInfo.incognito !== record.clientInfo.incognito) contract.fail('IDENTITY_MISMATCH');
      record.clientInfo = message.clientInfo; record.hello = true;
      this.send(socket, { type: 'hello', requestId: message.requestId, protocol: 'arp/1', version: SERVER_VERSION,
        serverName: this.serverName, platform: process.platform, startupWorkingDirectory: this.startupDirectory,
        capabilities: { ...this.capabilities, audit: { ...this.capabilities.audit, available: this.audit.available } }, environment: this.environment.base }); return;
    }
    if (message.type === 'local.configure') {
      if (!record.hello) contract.fail('HELLO_REQUIRED'); record.state = 'configuring';
      const version = record.configureVersion = (record.configureVersion || 0) + 1;
      try {
        const result = await record.local.configure(message);
        if (version === record.configureVersion) record.state = 'ready';
        this.send(socket, { type: 'local.configured', requestId: message.requestId, ok: true, ...result });
        if (record.state === 'ready') this.archive.connected(record.identity.clientId).catch(error => {
          console.error('Archive connection: ' + error.message);
        });
      } catch (error) { throw error; }
      return;
    }
    if (this.closing || record.state !== 'ready') contract.fail('CONNECTION_NOT_READY', '连接尚未就绪', 'TEMPORARILY_UNAVAILABLE');
    if (message.type === 'local.call' || message.type === 'environment.get') { await record.local.handle(message); return; }
    if (message.type === 'mail.send') {
      const pending = this.mail(record, message); this.mailRequests.add(pending);
      try { await pending; } finally { this.mailRequests.delete(pending); }
      return;
    }
    contract.fail('UNEXPECTED_FRAME');
  }
  async mail(record, message) {
    const context = { ...record.local.context(message), operation: 'mail.send', parameters: { action: 'send' } };
    if (record.seen.has(message.requestId)) throw Object.assign(new Error('重复请求，原邮件投递结果不可推断'), {
      code: 'RESOURCE_CONFLICT', reason: 'DUPLICATE_REQUEST', performed: 'unknown' });
    if (record.seen.size >= LIMITS.seenRequests) contract.fail('SESSION_REQUEST_LIMIT', '会话请求数量已达上限', 'RESOURCE_BUSY');
    record.seen.add(message.requestId);
    const controller = new AbortController(); record.activeMail.set(message.requestId, controller);
    let result, error, sending = false;
    try {
      context.parentAssurance = this.requestBroker.validateParent(message.caller.parentRequest, record.identity) ? 'server_verified'
        : message.caller.parentRequest ? 'client_asserted' : null;
      // Reserve the existing bounded mail slot before asynchronous audit/auth
      // work, so large SMTP payloads cannot accumulate outside that queue.
      result = await this.mailQueue.enqueue(message.payload, { signal: controller.signal, beforeSend: async signal => {
        await this.audit.write('execution.intent', context); await this.auth.assertActive(record.identity);
        if (signal.aborted || this.closing) throw new Error('邮件发送已取消');
        sending = true;
      } });
    } catch (failure) { error = failure; }
    finally { message.payload = null; record.activeMail.delete(message.requestId); }
    const receipt = { performed: error ? error.performed || (sending ? 'unknown' : 'no') : 'yes' };
    const recorded = await this.audit.bestEffort('execution.finished', { ...context, receipt,
      errorReason: error ? sending && error.performed !== 'no' ? 'MAIL_DELIVERY_UNKNOWN' : error.reason || 'MAIL_NOT_SENT' : null });
    this.send(record.socket, { type: 'mail.result', requestId: message.requestId, ok: !error,
      ...(error ? { error: safeError(error) } : { result }), receipt, audit: { recorded } });
  }
  disconnect(record, reason = 'disconnect') {
    record.state = 'disconnected';
    clearTimeout(record.authTimer); if (record.local) record.local.close(reason);
    for (const controller of record.activeMail.values()) controller.abort();
    for (const controller of record.activeArp.values()) controller.abort(reason);
    this.requestBroker.rejectForSocket(record.socket, 'Extension disconnected; result unknown');
    if (record.identity && this.clients.get(record.identity.clientId) === record) this.clients.delete(record.identity.clientId);
    this.sockets.delete(record.socket);
  }
  async checkRevocations() {
    this.auth.reportRateLimit();
    if (this.checkingRevocations || this.closing) return; this.checkingRevocations = true;
    try {
      for (const record of this.clients.values()) {
        try { await this.auth.assertActive(record.identity); }
        catch (_) { this.disconnect(record, 'grant_revoked'); record.socket.close(1008, 'CREDENTIAL_REVOKED'); }
      }
    } finally { this.checkingRevocations = false; }
  }
  broadcastStatus(available) {
    for (const record of this.clients.values()) this.send(record.socket, { type: 'server.status', audit: { available },
      environmentRevision: this.environment ? this.environment.revision : 0 });
  }
  withClientTarget(target, fn, options = {}) {
    const current = this.callContext.getStore() || {};
    return this.callContext.run({ ...current, ...options, clientSelector: target }, fn);
  }
  resolveExtensionClient(selector) {
    if (!selector || typeof selector.clientId !== 'string' || !selector.clientId) contract.fail('TARGET_REQUIRED', '必须明确指定目标扩展 ID');
    const client = this.clients.get(selector.clientId);
    if (!client || client.state !== 'ready' || client.socket.readyState !== WebSocket.OPEN) contract.fail('CONNECTION_NOT_READY', '目标扩展未就绪', 'TEMPORARILY_UNAVAILABLE');
    return client;
  }
  listExtensionClients() {
    return [...this.clients.values()].map(item => ({ ...item.clientInfo, state: item.state, clientId: item.identity.clientId,
      lastSeenAt: item.lastSeenAt || null, pendingRequestCount: this.requestBroker.countForClient(item.identity.clientId) }));
  }
  arpFailure(error) {
    return arp.createErrorResponse(randomUUID(), arp.arpError(error.code || 'UPSTREAM_FAILED', error.message,
      { performed: error.performed || 'no', retryable: false, details: { ...(error.details || {}), reason: error.reason || error.code } }));
  }
  async handleArpCall(record, message) {
    if (record.state !== 'ready') contract.fail('CONNECTION_NOT_READY', '来源客户端尚未就绪', 'TEMPORARILY_UNAVAILABLE');
    if (record.seen.has(message.requestId) || record.seen.size >= LIMITS.seenRequests) contract.fail('DUPLICATE_REQUEST');
    record.seen.add(message.requestId);
    if (record.activeArp.size >= LIMITS.httpSessionActive) contract.fail('ARP_BUSY', '客户端转发槽已满', 'RESOURCE_BUSY');
    const controller = new AbortController(); const lifecycle = { pending: new Set() };
    record.activeArp.set(message.requestId, controller);
    const options = { sourceIdentity: record.identity, signal: controller.signal, lifecycle,
      context: { sessionId: record.identity.transportSessionId, conversationId: message.caller.conversationId || record.identity.transportSessionId,
        parentRequest: { transportSessionId: record.identity.transportSessionId, requestId: message.requestId } } };
    try {
      if (!this.audit.available) throw auditUnavailable();
      if (message.method !== 'GET' || !this.serverArp.owns(message.method, message.request)) {
        await this.audit.write('request.received', { ...record.local.context(message), operation: 'arp.call',
          parameters: { method: message.method, ...this.audit.parameters('arp', { uri: message.request.uri }) } });
      }
      const envelope = await this.callArp(message.method, message.request, 180000, options);
      this.send(record.socket, { type: 'arp.response', requestId: message.requestId, envelope });
    } catch (error) {
      this.send(record.socket, { type: 'arp.response', requestId: message.requestId, envelope: this.arpFailure(error) });
    } finally {
      Promise.allSettled([...lifecycle.pending]).then(() => record.activeArp.delete(message.requestId));
    }
  }
  async callArp(method, request, timeoutMs = 30000, options = {}) {
    const current = this.callContext.getStore() || {};
    options = { ...current, ...options };
    if (options.sourceIdentity) {
      await this.auth.assertActive(options.sourceIdentity);
      const source = this.resolveExtensionClient({ clientId: options.sourceIdentity.clientId });
      if (source.identity.transportSessionId !== options.sourceIdentity.transportSessionId) contract.fail('CONNECTION_NOT_READY');
    }
    if (this.serverArp.owns(method, request)) return this.serverArp.dispatch(method, request, options);
    if (options.sourceIdentity) contract.fail('TARGET_REQUIRED', '请通过 /clients/{clientId}/arp 指定目标客户端');
    return this.forwardArp(options.target || current.clientSelector && current.clientSelector.clientId, method, request, timeoutMs, options);
  }
  async forwardArp(targetClientId, method, request, timeoutMs = 30000, options = {}) {
    const current = this.callContext.getStore() || {};
    const context = normalizeTransportContext(options.context || current.context);
    const parent = context.parentRequest || { transportSessionId: context.sessionId, requestId: randomUUID() };
    context.parentRequest = parent;
    const auditContext = { ...parent, parentRequest: null, operation: 'arp.' + method,
      principal: options.sourceIdentity ? { transport: 'websocket', id: options.sourceIdentity.clientId,
        clientId: options.sourceIdentity.clientId, pairingId: options.sourceIdentity.pairingId }
        : options.systemTask ? { transport: 'system', id: 'archive', clientId: null, pairingId: null }
          : { transport: 'http', id: 'http:operator', clientId: null, pairingId: null },
      caller: { kind: 'external', actorId: options.sourceIdentity ? options.sourceIdentity.clientId : options.systemTask ? 'archive' : 'http:operator', conversationId: context.conversationId, runId: null },
      callerAssurance: 'server_verified', executor: { ...this.environment.base.executor, pid: null },
      decision: 'allow', ruleIds: ['session.authenticated', 'target.current'], policyRevision: 1, grantRevision: null,
      parameters: { ...this.audit.parameters('arp', { uri: request.uri }),
        targetClientId: typeof targetClientId === 'string' ? targetClientId.slice(0, 200) : null,
        ...(options.rpcRequestId !== undefined ? { rpcRequestId: options.rpcRequestId } : {}) } };
    let auditedFailure = false;
    try {
      if (!this.audit.available) throw auditUnavailable();
      if (options.sourceIdentity && targetClientId === options.sourceIdentity.clientId) contract.fail('SELF_CALL_FORBIDDEN', '不能通过服务端调用自己', 'FORBIDDEN');
      if (options.sourceIdentity) await this.auth.assertActive(options.sourceIdentity);
      const selector = { clientId: targetClientId };
      const client = this.resolveExtensionClient(selector);
      auditContext.parameters.targetClientId = client.identity.clientId;
      auditContext.ruleIds.push('credential.active');
      // Configuration operations record their own intent and result; discovery is read-only polling.
      if (!options.systemTask) await this.audit.write('execution.intent', auditContext);
      await this.auth.assertActive(client.identity);
      if (options.sourceIdentity) {
        await this.auth.assertActive(options.sourceIdentity);
        const source = this.resolveExtensionClient({ clientId: options.sourceIdentity.clientId });
        if (source.identity.transportSessionId !== options.sourceIdentity.transportSessionId) contract.fail('CONNECTION_NOT_READY');
      }
      if (this.resolveExtensionClient(selector) !== client) contract.fail('CONNECTION_NOT_READY', '目标连接会话已变化', 'TEMPORARILY_UNAVAILABLE');
      const envelope = await this.requestBroker.call({ ws: client.socket, clientId: client.identity.clientId, method, request, context, timeoutMs,
        principal: { id: auditContext.principal.id, transport: auditContext.principal.transport },
        signal: options.signal || current.signal, lifecycle: options.lifecycle || current.lifecycle,
        onSettled: (result, error) => {
          auditedFailure = !!error;
          if (options.systemTask) return;
          return this.audit.bestEffort(error ? 'execution.unconfirmed' : 'execution.finished', { ...auditContext, parameters: undefined,
            receipt: result && result.receipt || { performed: 'unknown' }, errorReason: error ? 'RESULT_UNKNOWN' : null });
        } });
      if (!this.audit.available) envelope.warnings = (envelope.warnings || []).concat({ code: 'AUDIT_UNAVAILABLE', message: '服务端审计不可用', audit: { recorded: false } });
      return envelope;
    } catch (error) {
      if (!auditedFailure && !options.systemTask) {
        const denied = { ...auditContext, decision: 'deny', errorReason: error.reason || error.code || 'FORWARD_REJECTED', receipt: { performed: 'no' } };
        await this.audit.bestEffort('execution.finished', denied);
      }
      throw error;
    }
  }
  callMcpTool(method, args, options = {}) {
    const request = { ...args }; const clientId = request.mcpClientId; delete request.mcpClientId;
    return this.withClientTarget({ clientId }, () => this.callArp(method, request, 180000, options), options);
  }
  inlineImageContents(envelope) {
    const parts = envelope && envelope.primary && envelope.primary.data && envelope.primary.data.modelContent;
    return Array.isArray(parts) ? parts.filter(part => part && part.type === 'image' && typeof part.data === 'string' && /^image\/[A-Za-z0-9.+-]+$/.test(part.mimeType)) : [];
  }
  stripInlineImageData(value) {
    if (Array.isArray(value)) return value.map(item => this.stripInlineImageData(item));
    if (!value || typeof value !== 'object') return value;
    const output = Object.create(null);
    for (const key of Object.keys(value)) if (!(key === 'data' && value.type === 'image')) output[key] = this.stripInlineImageData(value[key]);
    if (value.type === 'image' && value.data) output.inlineData = true; return output;
  }
  toolResult(envelope) {
    const images = this.inlineImageContents(envelope); const projected = images.length ? this.stripInlineImageData(envelope) : envelope;
    return { content: [{ type: 'text', text: JSON.stringify(projected) }].concat(images), structuredContent: projected,
      isError: !isArpEnvelope(envelope) || envelope.status.code >= 400 };
  }
  close() {
    if (this.closePromise) return this.closePromise; this.closing = true;
    this.closePromise = (async () => {
      const deadline = setTimeout(() => { console.error('Shutdown unconfirmed'); process.exit(1); }, 10000); deadline.unref();
      let settled = false;
      try {
        clearInterval(this.revokeTimer); if (this.archive) this.archive.close();
        if (this.httpHandler) this.httpHandler.close(); this.mailQueue.close();
        for (const record of [...this.sockets.values()]) { this.disconnect(record, 'shutdown'); record.socket.terminate(); }
        if (this.wsServer) for (const socket of this.wsServer.clients) socket.terminate();
        this.requestBroker.close('Server shutdown');
        const [stopped] = await Promise.all([
          this.execution ? this.execution.close() : Promise.resolve(true),
          Promise.allSettled([...this.mailRequests]),
          this.archive ? this.archive.drain() : Promise.resolve(),
        ]);
        await Promise.all([closeListener(this.wsServer), closeListener(this.httpServer)]);
        if (this.audit) await this.audit.close();
        if (!stopped) throw new Error('Execution termination unconfirmed');
        if (this.releaseProcess) { await this.releaseProcess(); this.releaseProcess = null; }
        settled = true;
      } finally { if (settled) clearTimeout(deadline); if (this.signalHandler) { process.removeListener('SIGINT', this.signalHandler); process.removeListener('SIGTERM', this.signalHandler); } }
    })(); return this.closePromise;
  }
}
async function main() {
  checkNodeVersion(); const { options, positional } = parseCliArgs(process.argv.slice(2));
  if (!positional.length) { const server = new PageAgentMCPServer({ ...options, installSignalHandlers: true }); await server.run(); return; }
  const auth = new AuthStore(options.stateDir); await auth.init(); const state = await auth.read(true);
  const audit = new AuditLog(auth.directory, state ? state.serverId : randomUUID(), options.auditCommandContent || 'plain');
  const managementContext = createManagementContext();
  const revoking = positional.slice(0, 3).join(' ') === 'auth pairings revoke';
  try { await audit.init(false); } catch (error) { if (!revoking) throw error; console.error('审计不可用，继续撤销配对。'); }
  try {
    const command = positional.slice(0, 3).join(' ');
    if (positional[1] === 'set-password') {
      await setPassword(auth, audit, options.password, managementContext);
      delete options.password;
    } else if (command === 'auth pairings list') {
      await audit.bestEffort('request.received', { ...managementContext, operation: 'pairings.list' });
      console.error(JSON.stringify(await auth.list(), null, 2));
    }
    else {
      await audit.bestEffort('execution.intent', { ...managementContext, operation: 'pairing.revoke' });
      const result = await auth.revoke(positional[3]);
      await audit.bestEffort('pairing.revoked', { ...managementContext, operation: 'pairing.revoke', parameters: result }); console.error('配对已撤销。');
    }
  } finally { await audit.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = PageAgentMCPServer;
module.exports.canonicalToMcpUri = canonicalToMcpUri;
module.exports.mcpToCanonicalUri = mcpToCanonicalUri;
