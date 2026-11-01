(function (root, factory) {
  'use strict';
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('../protocol') : root.AgentResourceProtocol, common ? require('../resource-module-adapter') : root.ResourceModuleAdapter);
  if (common) module.exports = api; else root.ConnectionResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, adapter) {
  'use strict';
  function schema(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
  var EMPTY = schema({}), OUTPUT = { type: 'object' };
  var ALIAS = { type: 'string', minLength: 1, maxLength: 200 }, PATH = { type: 'string', minLength: 1, maxLength: 4096 };
  var PERMISSIONS = schema({ read: { type: 'boolean' }, write: { type: 'boolean' }, execute: { type: 'boolean' } });
  var ARP_PERMISSIONS = schema({ read: { type: 'boolean' }, write: { type: 'boolean' }, delete: { type: 'boolean' }, execute: { type: 'boolean' } });
  var LIST = schema({ cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } });
  var PATCH = schema({ alias: ALIAS, url: { type: 'string', minLength: 1, maxLength: 4000 }, enabled: { type: 'boolean' },
    desktopEnabled: { type: 'boolean' }, arpPermissions: ARP_PERMISSIONS,
    runTabMode: { enum: ['reuseOpenTab', 'fixedCurrentTab', 'fixedNewTab'] } });
  var WORKSPACE = schema({ alias: ALIAS, path: PATH, permissions: PERMISSIONS });
  var REMOTE_PERMISSION_GUIDANCE = [
    '连接的 arpPermissions 统一控制经此连接进入当前插件的远程操作，适用于 HTTP Agent 和其他客户端转发，不按业务模块单独配置。新连接和未配置的已有连接默认 read、write、execute 开启，delete 关闭；已保存的配置优先。',
    '远程操作权限只能由用户在目标客户端的扩展配置页「MCP 连接 → 权限 → 远程操作权限」修改。当前插件的连接配置不代表其他客户端的授权；服务端目录与桌面授权独立管理。',
  ];
  function method(verb, input, permission, precondition, async) {
    return { inputSchema: input, outputSchema: OUTPUT, safety: verb === 'GET' ? 'read' : permission === 'execute' ? 'execute' : 'write',
      idempotency: verb === 'POST' || verb === 'PATCH' ? 'keyed' : 'inherent', execution: async ? 'async' : 'sync',
      permissions: ['connections.' + permission], preconditions: precondition ? ['if-match'] : [],
      ...(verb === 'PATCH' ? { patchMediaTypes: ['application/merge-patch+json'] } : {}) };
  }
  function route(path, type, methods, summary, guidance) { return new arp.RouteContract({ template: path, resourceType: type,
    relation: ({ Connection: 'connection', ConnectionAttemptCollection: 'connection-attempts', ConnectionAttempt: 'connection-attempt', ConnectionLogCollection: 'connection-logs',
      ClientCollection: 'clients', ClientArpResult: 'client-arp' })[type] || 'connections',
    summary: summary || 'MCP 服务端连接、目录授权与客户端通信；配置只能由扩展配置页修改', guidance: guidance || [], methods: methods }); }
  var routes = [
    route('/connections', 'ConnectionCollection', { GET: method('GET', LIST, 'read'), POST: method('POST', schema({ alias: ALIAS, url: { type: 'string', maxLength: 4000 } }, ['alias', 'url']), 'write') }, undefined, REMOTE_PERMISSION_GUIDANCE),
    route('/connections/{connectionId}', 'Connection', { GET: method('GET', EMPTY, 'read'), PATCH: method('PATCH', PATCH, 'write', true), DELETE: method('DELETE', null, 'write', true) }, undefined, REMOTE_PERMISSION_GUIDANCE),
    route('/connections/{connectionId}/workspaces', 'WorkspaceCollection', { GET: method('GET', EMPTY, 'read'), POST: method('POST', Object.assign({}, WORKSPACE, { required: ['path'] }), 'write') }),
    route('/connections/{connectionId}/workspaces/{workspaceId}', 'Workspace', { GET: method('GET', EMPTY, 'read'), PATCH: method('PATCH', WORKSPACE, 'write', true), DELETE: method('DELETE', null, 'write', true) }),
    route('/connections/{connectionId}/attempts', 'ConnectionAttemptCollection', { POST: method('POST', schema({ timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 } }), 'execute', false, true) }),
    route('/connections/{connectionId}/attempts/{attemptId}', 'ConnectionAttempt', { GET: method('GET', EMPTY, 'read') }),
    route('/connections/{connectionId}/logs', 'ConnectionLogCollection', { GET: method('GET', EMPTY, 'read'), DELETE: method('DELETE', null, 'write', true) }),
    route('/connections/{connectionId}/clients', 'ClientCollection', { GET: method('GET', EMPTY, 'read') }, '查询此服务端全部已连接客户端及总数 total，包含当前客户端；isSelf 标识自己', REMOTE_PERMISSION_GUIDANCE),
    route('/connections/{connectionId}/clients/{clientId}/arp', 'ClientArpResult', { POST: method('POST', schema({
      method: { enum: arp.METHODS }, request: { type: 'object', description: '目标客户端的 ARP 工具参数，包含 uri 和该方法的业务参数' },
    }, ['method', 'request']), 'execute') }, '通过此服务端调用目标客户端的 ARP 能力；禁止调用自己', REMOTE_PERMISSION_GUIDANCE.concat([
      '通过返回的客户端链接选择目标，禁止调用 isSelf 客户端。先转发 OPTIONS 到目标资源，再按目标返回的契约执行；目标资源的后续链接仍须经同一客户端转发。',
      '目标权限按内层 method 和资源契约分类：DELETE 为 delete，GET、OPTIONS 或只读操作为 read，execute/privileged 操作为 execute，其余为 write；外层 POST 只是转发。',
      '以目标最新 OPTIONS 和实际错误为准，不把默认值视为当前授权，也不因外层只提供 POST 或一次错误就断言目标只读。CONNECTION_PERMISSION_DENIED 的 details.permission 指明关闭的操作类别；需要调整时说明目标客户端及对应开关，不要求用户逐项开放 model-services.write 等模块权限。',
    ])),
  ];
  function create(options) {
    var service = options.mcpService || options.service; var handlers = { GET: {}, POST: {}, PATCH: {}, DELETE: {} };
    function result(uri, type, data, code) { return { statusCode: code || 200, primary: { uri: uri, type: type, data: data,
      etag: service.etag(data), links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }]
        .concat(type === 'Connection' ? data.links || [] : []) }, schemaValue: data }; }
    function expected(request) { return request.preconditions && request.preconditions.ifMatch; }
    handlers.GET['/connections'] = async function (r) { return result(r.uri, 'ConnectionCollection', await service.listConnections(r.query)); };
    handlers.POST['/connections'] = async function (r, context) { var item = await service.createConnection(r.body, context); return result('/connections/' + item.id, 'Connection', item, 201); };
    handlers.GET['/connections/{connectionId}'] = async function (r) { return result(r.uri, 'Connection', await service.getConnection(r.params.connectionId)); };
    handlers.PATCH['/connections/{connectionId}'] = async function (r, context) { return result(r.uri, 'Connection', await service.patchConnection(r.params.connectionId, r.patch, context, expected(r))); };
    handlers.DELETE['/connections/{connectionId}'] = async function (r, context) { return result(r.uri, 'DeletedConnection', await service.deleteConnection(r.params.connectionId, context, expected(r))); };
    handlers.GET['/connections/{connectionId}/workspaces'] = async function (r) { return result(r.uri, 'WorkspaceCollection', await service.listWorkspaces(r.params.connectionId)); };
    handlers.GET['/connections/{connectionId}/workspaces/{workspaceId}'] = async function (r) { return result(r.uri, 'Workspace', await service.getWorkspace(r.params.connectionId, r.params.workspaceId)); };
    handlers.POST['/connections/{connectionId}/workspaces'] = async function (r, context) {
      var item = await service.changeWorkspace(r.params.connectionId, null, r.body, context, undefined, 'create');
      return result(r.uri + '/' + item.id, 'Workspace', item, 201);
    };
    handlers.PATCH['/connections/{connectionId}/workspaces/{workspaceId}'] = async function (r, context) {
      return result(r.uri, 'Workspace', await service.changeWorkspace(r.params.connectionId, r.params.workspaceId, r.patch, context, expected(r), 'patch'));
    };
    handlers.DELETE['/connections/{connectionId}/workspaces/{workspaceId}'] = async function (r, context) {
      return result(r.uri, 'DeletedWorkspace', await service.changeWorkspace(r.params.connectionId, r.params.workspaceId, {}, context, expected(r), 'delete'));
    };
    handlers.POST['/connections/{connectionId}/attempts'] = async function (r, context) {
      var data = await service.createConnectionAttempt(r.params.connectionId, r.body, context);
      var uri = '/connections/' + r.params.connectionId + '/attempts/' + data.id;
      var output = result(uri, 'ConnectionAttempt', data, 202); output.receipt = { performed: 'yes', operationUri: uri, retryAfterMs: 250, state: 'running' }; return output;
    };
    handlers.GET['/connections/{connectionId}/attempts/{attemptId}'] = async function (r, context) { return result(r.uri, 'ConnectionAttempt', await service.getConnectionAttempt(r.params.connectionId, r.params.attemptId, context)); };
    handlers.GET['/connections/{connectionId}/logs'] = async function (r) { return result(r.uri, 'ConnectionLogCollection', await service.getConnectionLogs(r.params.connectionId)); };
    handlers.DELETE['/connections/{connectionId}/logs'] = async function (r) { return result(r.uri, 'DeletedConnectionLogs', await service.clearConnectionLogs(r.params.connectionId)); };
    function forwardedResult(r, envelope) {
      if (envelope.status.code >= 400) throw arp.arpError(envelope.error && envelope.error.code || 'UPSTREAM_FAILED',
        envelope.error && envelope.error.message || '客户端调用失败', { status: envelope.status.code,
          performed: envelope.receipt && envelope.receipt.performed || 'unknown', retryable: envelope.error && envelope.error.retryable,
          details: Object.assign({}, envelope.error && envelope.error.details, { response: envelope }) });
      return { statusCode: envelope.status.code, primary: envelope.primary
          || (envelope.capabilities ? { uri: r.uri, type: 'ClientCapabilities', data: envelope.capabilities } : undefined),
        included: envelope.included, warnings: envelope.warnings, receipt: envelope.receipt || { performed: 'no' }, schemaValue: {} };
    }
    handlers.GET['/connections/{connectionId}/clients'] = async function (r, context) {
      var envelope = await service.callServerArp(r.params.connectionId, 'GET', { uri: '/clients' }, context);
      var output = forwardedResult(r, envelope), data = output.primary.data;
      data.items = data.items.map(function (item) {
        return Object.assign({}, item, { links: item.isSelf ? [] : [{ rel: 'arp', href: r.uri + '/' + encodeURIComponent(item.clientId) + '/arp', method: 'POST' }] });
      });
      output.primary.uri = r.uri; return output;
    };
    handlers.POST['/connections/{connectionId}/clients/{clientId}/arp'] = async function (r, context) {
      var envelope = await service.callServerArp(r.params.connectionId, 'POST', {
        uri: '/clients/' + encodeURIComponent(r.params.clientId) + '/arp', body: r.body, idempotencyKey: r.idempotencyKey,
      }, context);
      return forwardedResult(r, envelope);
    };
    return { service: service, routeContracts: routes, handlers: handlers, preconditionState: service.preconditionState };
  }
  return { API_VERSION: 2, ROUTE_CONTRACTS: routes, create: create, createAdapter: function (options) { return adapter.create({ root: 'connections', resource: create(options) }); } };
});
