'use strict';

const { randomUUID } = require('crypto');
const { generateCredential } = require('./auth-store');
const arp = require('../resources/protocol');

// HTTP operator endpoints only. Never register these in extension ARP routing.
function createConfigApi(server) {
  let changing = false;
  return async function handle(req, res, url, helpers) {
    if (!url.pathname.startsWith('/api/config/')) return false;
    const route = url.pathname.slice('/api/config/'.length);
    let value;
    if (req.method === 'GET' && route === 'status') {
      const pairings = (await server.auth.list()).filter(item => !item.revokedAt);
      value = { serverId: server.serverId, name: server.serverName, version: server.version, sampledAt: Date.now(),
        uptime: Math.floor(process.uptime()), workingDirectory: server.startupDirectory,
        websocket: { listening: !!server.wsServer.address(), address: server.wsServer.address(), sockets: server.sockets.size },
        clients: pairings.map(pairing => {
          const live = server.clients.get(pairing.clientId);
          return { ...pairing, name: live?.clientInfo?.clientName || pairing.clientName || pairing.clientId,
            state: live?.state || 'offline', address: live?.address, connectedAt: live?.connectedAt,
            lastSeenAt: live?.lastSeenAt, version: live?.clientInfo?.version,
            bufferedBytes: live?.socket.bufferedAmount || 0,
            pending: server.requestBroker.countForClient(pairing.clientId) };
        }),
        sessions: [...server.httpHandler.sessions.values()].map(session => ({ id: session.id,
          name: session.clientInfo?.name || 'MCP 客户端', version: session.clientInfo?.version,
          address: session.address, state: session.state, createdAt: session.createdAt, lastSeenAt: session.touched,
          target: session.target || null, active: session.active.size, streaming: !!session.stream,
          subscriptions: session.subscriptions.size, pending: session.pending.size })),
        queues: { mail: server.mailQueue.status(), executions: server.execution.active.size,
          forwards: server.requestBroker.pendingRequests.size, http: server.httpHandler.active,
          audit: { available: server.audit.available, pending: server.audit.pending, bytes: server.audit.bytes } },
        tokenManagedByEnvironment: server.httpTokenManagedByEnvironment };
    } else if (req.method === 'GET' && route === 'connections') {
      value = { items: server.connectionLogs.slice() };
    } else if (req.method === 'GET' && route === 'audit') {
      value = await server.audit.recent();
    } else if (req.method === 'GET' && ['accounts/export', 'devtools/export'].includes(route)) {
      const scope = route.split('/')[0], service = scope === 'accounts' ? server.bots : server.devtools;
      value = { type: 'page-agent-mcp-' + scope, version: 1, exportedAt: new Date().toISOString(), items: service.exportSettings() };
    } else if (req.method === 'POST' && ['accounts/import', 'devtools/import'].includes(route)) {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw arp.arpError('UNSUPPORTED_MEDIA_TYPE', '请求体必须为 application/json');
      const input = await helpers.readBody(req, helpers.signal, 16777216), scope = route.split('/')[0];
      const backup = input?.backup;
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['backup', scope === 'accounts' ? 'revisions' : 'revision'].includes(key))
        || !backup || typeof backup !== 'object' || Array.isArray(backup)
        || backup.type !== 'page-agent-mcp-' + scope || backup.version !== 1 || !Array.isArray(backup.items)
        || Object.keys(backup).some(key => !['type', 'version', 'exportedAt', 'items'].includes(key))) throw arp.arpError('INVALID_REQUEST', '备份文件类型或版本不匹配');
      helpers.signal.throwIfAborted();
      const context = { requestId: randomUUID(), transportSessionId: randomUUID(), operation: 'config.' + scope + '.import',
        principal: { transport: 'http', id: 'http:operator' } };
      await server.audit.write('execution.intent', context);
      value = scope === 'accounts' ? await server.bots.importSettings(backup.items, input.revisions)
        : await server.devtools.importSettings(backup.items, input.revision);
      value.auditRecorded = await server.audit.bestEffort('execution.finished', { ...context, receipt: { performed: 'yes' } });
    } else if (req.method === 'GET' && route === 'devtools') {
      value = server.devtools.settings();
    } else if (req.method === 'POST' && route === 'devtools/test') {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw arp.arpError('UNSUPPORTED_MEDIA_TYPE', '请求体必须为 application/json');
      const input = await helpers.readBody(req, helpers.signal, 1048576);
      helpers.signal.throwIfAborted();
      value = await server.devtools.test(input, { actorId: 'http:operator', abortSignal: helpers.signal });
    } else if (req.method === 'POST' && ['devtools', 'devtools/remove'].includes(route)) {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw arp.arpError('UNSUPPORTED_MEDIA_TYPE', '请求体必须为 application/json');
      const input = await helpers.readBody(req, helpers.signal, 1048576);
      helpers.signal.throwIfAborted();
      const context = { requestId: randomUUID(), transportSessionId: randomUUID(), operation: route === 'devtools' ? 'config.devtools.save' : 'config.devtools.remove',
        principal: { transport: 'http', id: 'http:operator' } };
      await server.audit.write('execution.intent', context);
      value = await server.devtools.save(input, route === 'devtools/remove');
      value.auditRecorded = await server.audit.bestEffort('execution.finished', { ...context, receipt: { performed: 'yes' } });
    } else if (req.method === 'POST' && ['pairing', 'token', 'revoke'].includes(route)) {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw arp.arpError('UNSUPPORTED_MEDIA_TYPE', '请求体必须为 application/json');
      const input = await helpers.readBody(req, helpers.signal, 4096);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => route !== 'revoke' || key !== 'pairingId')
        || route === 'revoke' && typeof input.pairingId !== 'string') throw arp.arpError('INVALID_REQUEST', '管理参数无效');
      if (changing) throw arp.arpError('RESOURCE_BUSY', '管理操作正在执行');
      changing = true;
      const context = { requestId: randomUUID(), transportSessionId: randomUUID(), operation: 'config.' + route,
        principal: { transport: 'http', id: 'http:operator' } };
      try {
        helpers.signal.throwIfAborted();
        if (route === 'token' && server.httpTokenManagedByEnvironment) throw arp.arpError('PRECONDITION_FAILED', '令牌由启动配置管理，请修改 PAGE_AGENT_HTTP_BEARER_TOKEN 后重启');
        await server.audit.write('execution.intent', context);
        if (route === 'pairing') value = await server.auth.createPairingTicket();
        if (route === 'revoke') {
          value = await server.auth.revoke(input.pairingId);
          await server.checkRevocations();
          await server.audit.bestEffort('pairing.revoked', { ...context, parameters: { pairingId: input.pairingId } });
        }
        if (route === 'token') {
          const token = generateCredential(), saved = await server.auth.ensureHttpBearerToken(token);
          server.httpBearerTokenHash = saved.hash;
          for (const session of [...server.httpHandler.sessions.values()]) server.httpHandler.remove(session);
          value = { token };
        }
        value.auditRecorded = await server.audit.bestEffort('execution.finished', { ...context, receipt: { performed: 'yes' } });
      } finally { changing = false; }
    } else throw arp.arpError('RESOURCE_NOT_FOUND', '未知配置接口');
    helpers.sendJson(req, res, 200, value);
    return true;
  };
}

module.exports = { createConfigApi };
