// ARP/1 local MCP WebSocket Connection resources.
(function attachConnectionResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !adapter) throw new Error('ConnectionResource dependencies are incomplete');
  var api = factory(arp, adapter);
  if (commonJs) module.exports = api;
  else root.ConnectionResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, ResourceModuleAdapter) {
  'use strict';
  var OBJECT = Object.freeze({ type: 'object' });
  var EMPTY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var LIST_QUERY = Object.freeze({
    type: 'object',
    properties: { cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    additionalProperties: false,
  });
  var PATCH_PROPERTIES = Object.freeze({
    enabled: { type: 'boolean' }, url: { type: 'string', minLength: 1, maxLength: 4000, pattern: '^wss?://' },
    clientName: { type: 'string', maxLength: 300 },
    runTabMode: { type: 'string', enum: ['reuseOpenTab', 'fixedCurrentTab', 'fixedNewTab'] },
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object', properties: PATCH_PROPERTIES, minProperties: 1, additionalProperties: false,
  });
  var CONNECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, kind: { const: 'mcp-websocket' }, enabled: { type: 'boolean' }, url: { type: 'string' },
      clientId: { type: 'string' }, clientName: { type: 'string' }, runTabMode: { type: 'string' },
      state: { type: 'string', enum: ['disabled', 'disconnected', 'connecting', 'connected'] },
      connected: { type: 'boolean' }, connecting: { type: 'boolean' }, retryCount: { type: 'integer', minimum: 0 },
      incognito: { type: 'boolean' }, owner: { type: 'object' },
    },
    required: ['id', 'kind', 'enabled', 'url', 'state', 'connected', 'connecting', 'retryCount', 'incognito', 'owner'],
    additionalProperties: false,
  });
  var COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: { items: { type: 'array', items: CONNECTION_SCHEMA }, total: { type: 'integer' }, nextCursor: { type: 'string' } },
    required: ['items', 'total'], additionalProperties: false,
  });
  var ATTEMPT_INPUT_SCHEMA = Object.freeze({
    type: 'object', properties: { timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 } }, additionalProperties: false,
  });
  var OPERATION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, kind: { const: 'connection-attempt' }, target: { type: 'string' }, connectionId: { type: 'string' },
      owner: { type: 'object' }, status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'interrupted'] },
      startedAt: { type: 'number' }, createdAt: { type: 'number' }, updatedAt: { type: 'number' }, endedAt: { type: 'number' },
      heartbeatAt: { type: 'number' }, leaseExpiresAt: { type: 'number' }, interruptedAt: { type: 'number' },
      recoverable: { type: 'boolean' }, result: true, error: { type: 'string' },
    },
    required: ['id', 'kind', 'target', 'connectionId', 'status', 'startedAt'], additionalProperties: false,
  });
  var LOG_SCHEMA = Object.freeze({
    type: 'object',
    properties: { timestamp: { type: 'number' }, level: { type: 'string' }, message: { type: 'string' }, detail: { type: 'string' } },
    required: ['timestamp', 'level', 'message'], additionalProperties: false,
  });
  var LOG_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: { connectionId: { type: 'string' }, items: { type: 'array', items: LOG_SCHEMA }, total: { type: 'integer' } },
    required: ['connectionId', 'items', 'total'], additionalProperties: false,
  });
  var DELETED_LOGS_SCHEMA = Object.freeze({
    type: 'object',
    properties: { connectionId: { type: 'string' }, deleted: { const: true }, removed: { type: 'integer', minimum: 0 } },
    required: ['connectionId', 'deleted', 'removed'], additionalProperties: false,
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);

  function method(inputSchema, policy) {
    return Object.assign({ inputSchema: inputSchema, outputSchema: policy.outputSchema || OBJECT }, policy);
  }
  function route(template, type, relation, summary, methods, aliases, tags) {
    return new arp.RouteContract({
      template: template, resourceType: type, relation: relation, summary: summary, methods: methods,
      aliases: aliases || [], tags: tags || [], entryWeights: { integration: 30, mcp: 35 },
    });
  }
  var ROUTES = Object.freeze([
    route('/connections', 'ConnectionCollection', 'connections', '读取 Options「MCP 服务器」中的 Extension 到本地 MCP Server WebSocket 连接；此资源不提供外部 HTTP MCP 工具', {
      GET: method(LIST_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['connections.read'],
        preconditions: [], relation: 'connections', summary: '列出本地 MCP WebSocket Connection；外部 HTTP MCP 工具应读取 /mcp-servers', outputSchema: COLLECTION_SCHEMA,
      }),
    }, ['MCP connection'], ['connection', 'mcp']),
    route('/connections/{connectionId}', 'Connection', 'connection', '读取或修改 Options「MCP 服务器」中的本地 WebSocket Connection 配置', {
      GET: method(EMPTY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['connections.read'],
        preconditions: [], relation: 'connection', summary: '读取本地 MCP Connection 状态', outputSchema: CONNECTION_SCHEMA,
      }),
      PATCH: method(PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['connections.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'connection', summary: '局部修改本地 MCP Connection 配置', outputSchema: CONNECTION_SCHEMA,
      }),
    }, ['MCP connection state'], ['connection', 'mcp']),
    route('/connections/{connectionId}/attempts', 'ConnectionAttemptCollection', 'connection-attempts', '发起一次 Extension 到本地 MCP Server 的真实 WebSocket 连接尝试', {
      POST: method(ATTEMPT_INPUT_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['connections.execute'],
        preconditions: [],
        relation: 'connection-attempts', summary: '创建一个 ConnectionAttempt', outputSchema: OPERATION_SCHEMA,
      }),
    }, ['connect MCP'], ['connection', 'attempt']),
    route('/connections/{connectionId}/attempts/{attemptId}', 'ConnectionAttempt', 'connection-attempt', '读取一个已保留的本地 MCP 连接尝试', {
      GET: method(EMPTY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['connections.read'],
        preconditions: [], relation: 'connection-attempt', summary: '读取 ConnectionAttempt 状态和结果', outputSchema: OPERATION_SCHEMA,
      }),
    }, ['MCP connection attempt'], ['connection', 'attempt', 'operation']),
    route('/connections/{connectionId}/logs', 'ConnectionLogCollection', 'connection-logs', '读取或清空有界的内存中本地 MCP 连接日志', {
      GET: method(EMPTY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['connections.read'],
        preconditions: [], relation: 'connection-logs', summary: '读取 Connection 日志', outputSchema: LOG_COLLECTION_SCHEMA,
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['connections.write'],
        preconditions: ['if-match'],
        relation: 'connection-logs', summary: '清空当前 Connection 日志', outputSchema: DELETED_LOGS_SCHEMA,
      }),
    }, ['MCP logs'], ['connection', 'logs']),
  ]);

  function representation(uri, type, data, service) {
    var output = {
      uri: uri, type: type, data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
    if (data && typeof service.etag === 'function') output.etag = service.etag(data);
    return output;
  }
  function result(uri, type, data, service, statusCode) {
    return { statusCode: statusCode || 200, primary: representation(uri, type, data, service), schemaValue: data };
  }
  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  function create(options) {
    options = options || {};
    var service = options.mcpService || options.service;
    if (!service) throw new Error('ConnectionResource requires an injected mcpService');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/connections'] = function (request) { return service.listConnections(request.query).then(function (data) { return result(request.uri, 'ConnectionCollection', data, service); }); };
    handlers.GET['/connections/{connectionId}'] = function (request) { return service.getConnection(request.params.connectionId).then(function (data) { return result(request.uri, 'Connection', data, service); }); };
    handlers.GET['/connections/{connectionId}/attempts/{attemptId}'] = function (request, context) { return service.getConnectionAttempt(request.params.connectionId, request.params.attemptId, context).then(function (data) { return result(request.uri, 'ConnectionAttempt', data, service); }); };
    handlers.GET['/connections/{connectionId}/logs'] = function (request) { return service.getConnectionLogs(request.params.connectionId).then(function (data) { return result(request.uri, 'ConnectionLogCollection', data, service); }); };
    handlers.POST['/connections/{connectionId}/attempts'] = function (request, context) {
      return service.createConnectionAttempt(request.params.connectionId, request.body, context).then(function (data) {
        var uri = '/connections/' + segment(request.params.connectionId) + '/attempts/' + segment(data.id);
        return {
          statusCode: 202, primary: representation(uri, 'ConnectionAttempt', data, service), schemaValue: data,
          receipt: { performed: 'yes', operationUri: uri, retryAfterMs: 250, state: 'running' },
        };
      });
    };
    handlers.PATCH['/connections/{connectionId}'] = function (request) { return service.patchConnection(request.params.connectionId, request.patch).then(function (data) { return result(request.uri, 'Connection', data, service); }); };
    handlers.DELETE['/connections/{connectionId}/logs'] = function (request) { return service.clearConnectionLogs(request.params.connectionId).then(function (data) { return result(request.uri, 'DeletedConnectionLogs', data, service); }); };
    return Object.freeze({
      service: service, routeContracts: ROUTES, handlers: handlers,
      preconditionState: service.preconditionState,
    });
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'connections', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
