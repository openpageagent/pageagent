'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const arp = require('../resources/protocol');
const adapters = require('../resources/resource-module-adapter');
const contract = require('../shared/mcp-contract');
const { OPERATIONS, ENVIRONMENT_INPUT_SCHEMA, isRead } = require('../resources/modules/local-resource');
const { execute, localPath, checkedPath } = require('./local-operations');
const { checkSignal } = require('./execution-control');
const { LIMITS } = contract;
const EMPTY = { type: 'object', properties: {}, additionalProperties: false };

function createServerArp(server) {
  const registry = arp.createResourceRegistry();
  function result(uri, type, data, receipt) {
    return { statusCode: 200, primary: { uri, type, data }, ...(receipt ? { receipt } : {}) };
  }
  function route(template, method, inputSchema, permission, summary, safety = 'read', preconditions = []) {
    return new arp.RouteContract({ template, resourceType: 'ServerResource', relation: template.split('/').pop(), summary,
      methods: { [method]: { inputSchema, outputSchema: {}, safety, idempotency: method === 'GET' ? 'inherent' : 'keyed',
        execution: 'sync', permissions: [permission], preconditions,
        ...(method === 'PATCH' ? { patchMediaTypes: ['application/merge-patch+json'] } : {}) } } });
  }
  function supported(name) {
    const definition = OPERATIONS[name];
    return (!definition.desktop || server.capabilities.desktop.supported && (name === 'desktop' || server.capabilities.desktop.actions[name]))
      && (name !== 'bash' || !!server.shell);
  }
  function describeLocal() {
    return { serverId: server.serverId, serverName: server.serverName, workingDirectory: server.startupDirectory,
      authorization: 'http-bearer', capabilities: { ...server.capabilities, audit: { ...server.capabilities.audit, available: server.audit.available } },
      links: [
        { rel: 'environment', href: '/local/environment', method: 'GET' },
        { rel: 'disk', href: '/local/disk', method: 'GET' },
        { rel: 'desktop', href: '/local/desktop', method: 'GET' },
        ...Object.keys(OPERATIONS).filter(name => name !== 'desktop' && supported(name))
          .map(name => ({ rel: name, href: '/local/' + name, method: 'POST' })),
      ] };
  }
  async function runLocal(name, input, context) {
    if (context.sourceIdentity) throw arp.arpError('FORBIDDEN', 'WebSocket 本地操作请使用已授权的 local.call', { performed: 'no' });
    const environmental = name === 'environment' || name === 'disk';
    const directory = server.startupDirectory;
    const identity = { clientId: 'http:operator', transportSessionId: context.sessionId };
    const requestId = randomUUID();
    const workspace = { id: 'startup', resolvedPath: directory };
    const directoryScoped = name === 'disk' || contract.own(contract.DIRECTORY_OPERATIONS, name);
    const auditContext = { transportSessionId: context.sessionId, requestId, parentRequest: context.parentRequest || null,
      principal: { transport: 'http', id: 'http:operator', clientId: null, pairingId: null },
      caller: { kind: 'external', actorId: 'http:operator', conversationId: context.conversationId, runId: null },
      callerAssurance: 'server_verified', executor: { ...server.environment.base.executor, pid: null },
      operation: name, decision: 'allow', ruleIds: ['session.authenticated', 'http.operator', 'platform.supported'],
      policyRevision: 1, grantRevision: null, workspaceId: directoryScoped ? 'startup' : null,
      resolvedPath: directoryScoped ? directory : null, parameters: server.audit.parameters(name, input, server.shell) };
    const timeoutMs = environmental ? LIMITS.sampleTimeoutMs : name === 'bash' ? input.timeoutMs || LIMITS.bashDefaultTimeoutMs
      : OPERATIONS[name].desktop ? LIMITS.desktopTimeoutMs : LIMITS.fileTimeoutMs;
    const pending = server.execution.run({ identity, requestId, operation: name, workspaceId: auditContext.workspaceId,
      timeoutMs, readOnly: isRead(name, input), context: auditContext,
      validate: async signal => {
        checkSignal(signal); checkSignal(context.abortSignal);
        if (!environmental && !supported(name)) throw arp.arpError('UNSUPPORTED_CAPABILITY', '服务端不支持此操作', { performed: 'no' });
        if (OPERATIONS[name] && OPERATIONS[name].desktop && input.action && !server.capabilities.desktop.actions[name].includes(input.action)) {
          throw arp.arpError('UNSUPPORTED_CAPABILITY', '服务端不支持此桌面动作', { performed: 'no' });
        }
        if (directoryScoped && (await fs.realpath(directory) !== directory || !(await fs.stat(directory)).isDirectory())) {
          throw arp.arpError('DEPENDENCY_CHANGED', '服务端工作目录已变化', { performed: 'no' });
        }
        const inputPath = input.path || input.templatePath;
        if (inputPath) {
          const target = localPath(inputPath, directory);
          const checked = await checkedPath(directory, name === 'delete' ? path.dirname(target) : target, name === 'write');
          auditContext.targetPath = name === 'delete' ? path.join(checked, path.basename(target)) : checked;
        }
      },
      execute: signal => name === 'environment' ? server.environment.server(input.refresh)
        : name === 'disk' ? server.environment.disk(workspace, 1, input.refresh) : execute(name, input, signal, directory, server.shell),
    });
    const abort = () => server.execution.cancel(identity, requestId, 'http_cancelled');
    if (context.abortSignal) {
      context.abortSignal.addEventListener('abort', abort, { once: true });
      if (context.abortSignal.aborted) abort();
    }
    let value;
    try { value = await pending; }
    catch (error) { throw arp.arpError(error.code || 'UPSTREAM_FAILED', error.message,
      { performed: error.performed || 'no', details: { reason: error.reason } }); }
    finally { if (context.abortSignal) context.abortSignal.removeEventListener('abort', abort); }
    if (!value.ok) throw arp.arpError(value.error.code, value.error.message, { performed: value.receipt.performed,
      details: { reason: value.error.reason, result: value.result, execution: value.execution, audit: value.audit } });
    return { ...value.result, execution: value.execution, receipt: value.receipt, audit: value.audit,
      target: { serverId: server.serverId, workspaceId: directoryScoped ? 'startup' : null, resolvedPath: directoryScoped ? directory : null } };
  }
  const local = { routeContracts: [], handlers: { GET: {}, POST: {} } };
  function localGet(uri, schema, summary, handler) {
    local.routeContracts.push(route(uri, 'GET', schema, 'local.execute', summary));
    local.handlers.GET[uri] = handler;
  }
  localGet('/local', EMPTY, '服务端本地能力；独立于浏览器插件，文件路径基于服务端启动目录', request => result(request.uri, 'ServerLocal', describeLocal()));
  localGet('/local/desktop', EMPTY, '服务端桌面能力', request => result(request.uri, 'ServerDesktop', server.capabilities.desktop));
  for (const name of ['environment', 'disk']) localGet('/local/' + name, ENVIRONMENT_INPUT_SCHEMA, '服务端' + name,
    async (request, context) => result(request.uri, 'LocalEnvironment', await runLocal(name, request.query, context)));
  for (const [name, definition] of Object.entries(OPERATIONS)) {
    if (name === 'desktop') continue;
    const uri = '/local/' + name;
    local.routeContracts.push(route(uri, 'POST', definition.inputSchema, 'local.execute', definition.summary, isRead(name, {}) ? 'read' : 'execute'));
    local.handlers.POST[uri] = async (request, context) => {
      const data = await runLocal(name, request.body, context);
      return result(request.uri, 'LocalOperationResult', data, data.receipt);
    };
  }
  registry.register(adapters.create({ root: 'local', resource: local }));
  const clients = { routeContracts: [
    route('/clients', 'GET', EMPTY, 'clients.read', '此服务端全部已连接客户端及总数 total；isSelf 标识来源客户端'),
    route('/clients/{clientId}/arp', 'POST', { type: 'object', properties: {
      method: { enum: arp.METHODS }, request: { type: 'object', description: '目标客户端的 ARP 工具参数，包含 uri 以及该方法需要的 body、patch 等字段' },
    }, required: ['method', 'request'], additionalProperties: false }, 'clients.call', '通过服务端调用指定客户端的 ARP 能力；拒绝调用自己', 'execute'),
  ], handlers: { GET: {}, POST: {} } };
  clients.handlers.GET['/clients'] = (request, context) => {
    const items = server.listExtensionClients().map(item => {
      const isSelf = !!context.sourceIdentity && item.clientId === context.sourceIdentity.clientId;
      return { ...item, isSelf, links: isSelf ? [] : [{ rel: 'arp', href: '/clients/' + encodeURIComponent(item.clientId) + '/arp', method: 'POST' }] };
    });
    return result(request.uri, 'ClientCollection', { serverId: server.serverId, serverName: server.serverName, items, total: items.length });
  };
  clients.handlers.POST['/clients/{clientId}/arp'] = async (request, context) => {
    let envelope;
    try { envelope = await server.forwardArp(request.params.clientId, request.body.method, request.body.request, 180000, context); }
    catch (error) { throw arp.arpError(error.code || 'UPSTREAM_FAILED', error.message,
      { performed: error.performed || 'no', details: { ...(error.details || {}), reason: error.reason } }); }
    return clientResult(request.uri, envelope);
  };
  registry.register(adapters.create({ root: 'clients', resource: clients }));
  const archive = server.archive;
  const archiveResource = { routeContracts: [], handlers: { GET: {}, POST: {}, PATCH: {} } };
  function archiveRoute(uri, method, schema, summary, handler) {
    const next = route(uri, method, schema, 'archive.manage', summary, method === 'GET' ? 'read' : 'write', method === 'PATCH' ? ['if-match'] : []);
    const index = archiveResource.routeContracts.findIndex(item => item.template === uri);
    if (index === -1) archiveResource.routeContracts.push(next);
    else {
      const previous = archiveResource.routeContracts[index];
      archiveResource.routeContracts[index] = new arp.RouteContract({ ...previous, methods: { ...previous.methods, ...next.methods } });
    }
    archiveResource.handlers[method][uri] = handler;
  }
  archiveRoute('/archive', 'GET', EMPTY, '备份桶、实例和最近同步/备份操作',
    async (request, context) => result(request.uri, 'Archive', await archive.list(context)));
  archiveRoute('/archive/buckets', 'POST', { type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: { type: 'string' }, name: { type: 'string' } } }, '创建备份桶',
    async (request, context) => result(request.uri, 'Bucket', await archive.createBucket(request.body, context)));
  archiveRoute('/archive/buckets/{bucketId}', 'GET', EMPTY, '读取备份桶及修改前提 ETag', async (request, context) => {
    const bucket = archive.publicBucket(await archive.visibleBucket(request.params.bucketId, context));
    const response = result(request.uri, 'Bucket', bucket);
    response.primary.etag = '"bucket-' + bucket.revision + '"';
    return response;
  });
  archiveRoute('/archive/buckets/{bucketId}/versions', 'GET', EMPTY, '列出不可变配置版本',
    async (request, context) => result(request.uri, 'ArchiveVersions', await archive.versions(request.params.bucketId, context)));
  archiveRoute('/archive/buckets/{bucketId}/versions/{versionId}', 'GET', EMPTY, '读取备份版本；不含模型密钥与对话数据', async (request, context) => {
    await archive.visibleBucket(request.params.bucketId, context);
    return result(request.uri, 'ArchiveVersion', await archive.version(request.params.bucketId, request.params.versionId));
  });
  archiveRoute('/archive/buckets/{bucketId}/versions/{versionId}', 'PATCH', { type: 'object', additionalProperties: false,
    required: ['syncable'], properties: { syncable: { type: 'boolean' } } }, '标记或取消可同步版本',
    async (request, context) => result(request.uri, 'ArchiveVersion', await archive.updateVersion(
      request.params.bucketId, request.params.versionId, request.patch, request.preconditions && request.preconditions.ifMatch, context)));
  archiveRoute('/archive/operations', 'POST', { type: 'object', additionalProperties: false, required: ['kind'],
    properties: { kind: { enum: ['backup', 'apply'] }, clientId: { type: 'string' }, operationId: { type: 'string' }, versionId: { type: 'string' } } }, '备份配置或执行已授权的同步；通过操作 ID 查询结果',
    async (request, context) => result(request.uri, 'ArchiveOperation', await archive.createOperation(request.body, context)));
  archiveRoute('/archive/operations/{operationId}', 'GET', EMPTY, '查询配置操作结果',
    async (request, context) => result(request.uri, 'ArchiveOperation', await archive.getOperation(request.params.operationId, context)));
  archiveRoute('/archive/operations/{operationId}/retries', 'POST', EMPTY, '恢复中断或失败的配置操作',
    async (request, context) => result(request.uri, 'ArchiveOperation', await archive.retryOperation(request.params.operationId, context)));
  registry.register(adapters.create({ root: 'archive', resource: archiveResource }));
  const router = arp.createRouter({ registry, requestId: randomUUID, idempotency: { retentionMs: LIMITS.settledTtlMs },
    authorize: ({ descriptor, request, context, route }) => {
      if (route.template === '/clients/{clientId}/arp' && context.target && context.target !== route.match(request.uri).clientId) {
        throw arp.arpError('INVALID_REQUEST', '目标客户端与 HTTP 会话绑定不一致');
      }
      return descriptor.requiredPermissions.every(permission => context.permissionScope.includes(permission));
    } });
  return { owns(method, request) {
    const uri = arp.canonicalizeUri(arp.parseRequestTarget(request.uri, method).path, { allowRoot: true });
    return uri === '/' || /^\/(local|clients|archive)(\/|$)/.test(uri);
  }, dispatch(method, request, options) {
    const context = { ...options, ...options.context, abortSignal: options.signal,
      actorId: options.sourceIdentity ? 'websocket:' + options.sourceIdentity.clientId : 'http:operator',
      permissionScope: options.sourceIdentity ? ['clients.read', 'clients.call', 'archive.manage']
        : ['local.execute', 'clients.read', 'clients.call', 'archive.manage'] };
    return router.dispatch(method, request, context);
  } };
}
function clientResult(uri, envelope) {
  if (envelope.status.code >= 400) throw arp.arpError(envelope.error && envelope.error.code || 'UPSTREAM_FAILED',
    envelope.error && envelope.error.message || '客户端请求失败', { status: envelope.status.code,
      performed: envelope.receipt && envelope.receipt.performed || 'unknown', retryable: envelope.error && envelope.error.retryable,
      details: { ...(envelope.error && envelope.error.details || {}), response: envelope } });
  return { statusCode: envelope.status.code, primary: envelope.primary
      || (envelope.capabilities ? { uri, type: 'ClientCapabilities', data: envelope.capabilities } : undefined),
    included: envelope.included, warnings: envelope.warnings, receipt: envelope.receipt || { performed: 'no' }, schemaValue: {} };
}
module.exports = { createServerArp };
