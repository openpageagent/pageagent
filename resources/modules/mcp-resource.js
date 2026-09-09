// Canonical ARP/1 resources for HTTP MCP servers, discovery, probes, tools, and calls.
(function attachMcpResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var adapterModule = commonJs ? require('../../resources/resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !adapterModule) throw new Error('McpResource dependencies are incomplete');
  var api = factory(arp, adapterModule);
  if (commonJs) module.exports = api;
  else root.McpResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, ResourceModuleAdapter) {
  'use strict';

  var URI_TEMPLATES = Object.freeze({
    servers: '/mcp-servers',
    server: '/mcp-servers/{serverId}',
    tools: '/mcp-servers/{serverId}/tools',
    tool: '/mcp-servers/{serverId}/tools/{toolName}',
    discoveries: '/mcp-servers/{serverId}/tool-discoveries',
    discovery: '/mcp-servers/{serverId}/tool-discoveries/{discoveryId}',
    connectionAttempts: '/mcp-servers/{serverId}/connection-attempts',
    connectionAttempt: '/mcp-servers/{serverId}/connection-attempts/{attemptId}',
    calls: '/mcp-servers/{serverId}/tools/{toolName}/calls',
    callCollection: '/mcp-calls',
    call: '/mcp-calls/{callId}',
  });
  var OBJECT = Object.freeze({ type: 'object' });
  var EMPTY_QUERY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var LIST_QUERY = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      includeDisabled: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var TOOL_LIST_QUERY = Object.freeze({
    type: 'object',
    properties: { cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    additionalProperties: false,
  });
  var SERVER_WRITE_PROPERTIES = Object.freeze({
    id: { type: 'string', minLength: 1, maxLength: 300 },
    name: { type: 'string', maxLength: 300 },
    url: { type: 'string', minLength: 1, maxLength: 4000, pattern: '^https?://' },
    enabled: { type: 'boolean' },
    bearerToken: { type: 'string', maxLength: 20000 },
    headersText: { type: 'string', maxLength: 50000 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
    protocolVersion: {
      type: 'string', enum: ['2025-11-25', '2025-06-18'],
      description: 'HTTP MCP 协议版本白名单；省略时使用默认版本。',
    },
  });
  var SERVER_CREATE_SCHEMA = Object.freeze({
    type: 'object', properties: SERVER_WRITE_PROPERTIES, required: ['url'], additionalProperties: false,
  });
  var SERVER_PATCH_PROPERTIES = Object.freeze({
    name: SERVER_WRITE_PROPERTIES.name,
    url: SERVER_WRITE_PROPERTIES.url,
    enabled: SERVER_WRITE_PROPERTIES.enabled,
    bearerToken: SERVER_WRITE_PROPERTIES.bearerToken,
    headersText: SERVER_WRITE_PROPERTIES.headersText,
    timeoutMs: SERVER_WRITE_PROPERTIES.timeoutMs,
    protocolVersion: SERVER_WRITE_PROPERTIES.protocolVersion,
  });
  var SERVER_PATCH_SCHEMA = Object.freeze({
    type: 'object', properties: SERVER_PATCH_PROPERTIES, minProperties: 1, additionalProperties: false,
  });
  var SERVER_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, enabled: { type: 'boolean' },
      protocolVersion: { type: 'string' }, timeoutMs: { type: 'integer' },
      syncedAt: { type: 'number' }, lastTestedAt: { type: 'number' }, lastStatus: { type: 'string' }, lastError: { type: 'string' },
      serverInfo: { type: 'object' }, serverInstructions: { type: 'string' }, capabilities: { type: 'object' },
      hasBearerToken: { type: 'boolean' }, hasCustomHeaders: { type: 'boolean' },
      customHeaderNames: { type: 'array', items: { type: 'string' } },
      owner: { type: 'object' }, createdAt: { type: 'number' }, updatedAt: { type: 'number' },
      toolCount: { type: 'integer', minimum: 0 }, schemaHash: { type: 'string' },
      auth: {
        type: 'object',
        properties: {
          kind: { const: 'local-secret' }, bearerTokenConfigured: { type: 'boolean' },
          customHeaderNames: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'bearerTokenConfigured', 'customHeaderNames'], additionalProperties: false,
      },
    },
    required: ['id', 'name', 'url', 'enabled', 'owner', 'toolCount', 'schemaHash', 'auth'],
    additionalProperties: false,
  });
  var SERVER_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      items: { type: 'array', items: SERVER_SCHEMA }, total: { type: 'integer', minimum: 0 },
      nextCursor: { type: 'string' }, updatedAt: { type: 'number' },
    },
    required: ['items', 'total', 'updatedAt'], additionalProperties: false,
  });
  var TOOL_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      name: { type: 'string' }, description: { type: 'string' }, inputSchema: true, outputSchema: true, schemaHash: { type: 'string' },
    },
    required: ['name', 'description', 'inputSchema', 'outputSchema', 'schemaHash'], additionalProperties: false,
  });
  var TOOL_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: { items: { type: 'array', items: TOOL_SCHEMA }, total: { type: 'integer' }, nextCursor: { type: 'string' } },
    required: ['items', 'total'], additionalProperties: false,
  });
  var OPERATION_INPUT_SCHEMA = Object.freeze({
    type: 'object', properties: { timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 } }, additionalProperties: false,
  });
  var OPERATION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, kind: { type: 'string' }, target: { type: 'string' },
      status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'interrupted'] },
      serverId: { type: 'string' }, connectionId: { type: 'string' }, toolName: { type: 'string' }, schemaHash: { type: 'string' },
      startedAt: { type: 'number' }, createdAt: { type: 'number' }, updatedAt: { type: 'number' }, endedAt: { type: 'number' },
      heartbeatAt: { type: 'number' }, leaseExpiresAt: { type: 'number' }, interruptedAt: { type: 'number' }, recoverable: { type: 'boolean' },
      result: true, error: { type: 'string' },
    },
    required: ['id', 'kind', 'target', 'status', 'startedAt'], additionalProperties: false,
  });
  var OPERATION_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      items: { type: 'array', items: OPERATION_SCHEMA }, total: { type: 'integer', minimum: 0 },
      nextCursor: { type: 'string' },
    },
    required: ['items', 'total'], additionalProperties: false,
  });
  var CALL_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      arguments: { type: 'object' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      schemaHash: { type: 'string', minLength: 1 },
    },
    required: ['arguments', 'schemaHash'], additionalProperties: false,
  });
  var DELETED_SCHEMA = Object.freeze({
    type: 'object', properties: { id: { type: 'string' }, deleted: { const: true } },
    required: ['id', 'deleted'], additionalProperties: false,
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);
  var MCP_CALL_GUIDANCE = Object.freeze([
    '此路由调用所选外部 HTTP MCP Server，不代表当前 Page Agent 扩展实例。用户询问“当前环境、当前浏览器、当前窗口或当前标签页”且未明确指定 MCP 连接环境时，应使用原生 /browser 或 /page 资源。',
    '仅提到、质疑或纠正 MCP 不构成调用请求。只有任务对象明确属于该外部系统，或用户明确要求使用或检查 MCP 时才调用；明确要求时必须以实际调用结果为依据，失败则报告原始原因。',
    '严格使用所选目录给出的精确 callUri 和 schemaHash 创建调用；同名原生 Provider 工具不等于 MCP 调用。异步回执只沿 operationUri 读取到 succeeded、failed 或 interrupted。',
  ]);

  function method(inputSchema, policy) {
    policy = policy || {};
    return Object.assign({ inputSchema: inputSchema, outputSchema: policy.outputSchema || OBJECT }, policy);
  }

  function route(template, resourceType, relation, summary, methods, aliases, tags) {
    return new arp.RouteContract({
      template: template, resourceType: resourceType, relation: relation, summary: summary,
      aliases: aliases || [], tags: tags || [], entryWeights: { integration: 30, mcp: 35 }, methods: methods,
    });
  }

  var ROUTE_CONTRACTS = Object.freeze([
    route(URI_TEMPLATES.servers, 'McpServerCollection', 'mcp-servers', '列出或创建 Options「知识」中的外部 HTTP MCP Server；此资源与 /connections 本地 WebSocket 连接无关', {
      GET: method(LIST_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.read'],
        preconditions: [], relation: 'mcp-servers', summary: '列出知识中已配置且已脱敏的外部 HTTP MCP Server',
        outputSchema: SERVER_COLLECTION_SCHEMA,
      }),
      POST: method(SERVER_CREATE_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['mcp-servers.write'],
        preconditions: [],
        relation: 'mcp-servers', summary: '创建一个归当前用户所有的 HTTP MCP Server', outputSchema: SERVER_SCHEMA,
      }),
    }, ['HTTP MCP servers'], ['mcp', 'server']),
    route(URI_TEMPLATES.server, 'McpServer', 'mcp-server', '读取、修改或删除一个 HTTP MCP Server', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.read'],
        preconditions: [], relation: 'mcp-server', summary: '读取一个已脱敏的 HTTP MCP Server', outputSchema: SERVER_SCHEMA,
      }),
      PATCH: method(SERVER_PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['mcp-servers.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'mcp-server', summary: '局部修改一个归当前用户所有的 HTTP MCP Server', outputSchema: SERVER_SCHEMA,
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.delete'],
        preconditions: ['if-match'],
        relation: 'mcp-server', summary: '删除一个归当前用户所有的 HTTP MCP Server，并归档其托管的 Knowledge', outputSchema: DELETED_SCHEMA,
      }),
    }, ['HTTP MCP server'], ['mcp', 'server']),
    route(URI_TEMPLATES.tools, 'McpToolCollection', 'mcp-tools', '读取 Options「知识」中指定 HTTP MCP Server 已发现的工具目录', {
      GET: method(TOOL_LIST_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.read'],
        preconditions: [], relation: 'mcp-tools', summary: '列出指定外部 HTTP MCP Server 已发现的 Tool schema 和哈希',
        outputSchema: TOOL_COLLECTION_SCHEMA,
      }),
    }, ['MCP tools'], ['mcp', 'tool', 'schema']),
    route(URI_TEMPLATES.tool, 'McpTool', 'mcp-tool', '读取一个已发现的 MCP Tool schema', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.read'],
        preconditions: [], relation: 'mcp-tool', summary: '读取一个 MCP Tool 的 schemaHash 契约', outputSchema: TOOL_SCHEMA,
      }),
    }, ['MCP tool'], ['mcp', 'tool', 'schema']),
    route(URI_TEMPLATES.discoveries, 'McpToolDiscoveryCollection', 'mcp-tool-discoveries', '启动一次真实的 tools/list 发现和 Knowledge 同步', {
      POST: method(OPERATION_INPUT_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['mcp-servers.write'],
        preconditions: [],
        relation: 'mcp-tool-discoveries', summary: '创建一次 MCP Tool 发现操作', outputSchema: OPERATION_SCHEMA,
      }),
    }, ['discover MCP tools'], ['mcp', 'tool', 'discovery']),
    route(URI_TEMPLATES.discovery, 'McpToolDiscovery', 'mcp-tool-discovery', '读取一次已保留的 MCP Tool 发现操作', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.read'],
        preconditions: [], relation: 'mcp-tool-discovery', summary: '读取 MCP Tool 发现状态和结果',
        outputSchema: OPERATION_SCHEMA,
      }),
    }, ['MCP discovery result'], ['mcp', 'discovery', 'operation']),
    route(URI_TEMPLATES.connectionAttempts, 'McpServerConnectionAttemptCollection', 'mcp-server-connection-attempts', '通过真实的 initialize 和 tools/list 交互探测一个 HTTP MCP Server', {
      POST: method(OPERATION_INPUT_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['mcp-servers.write'],
        preconditions: [],
        relation: 'mcp-server-connection-attempts', summary: '创建一次 HTTP MCP Server 连接尝试', outputSchema: OPERATION_SCHEMA,
      }),
    }, ['test MCP server'], ['mcp', 'server', 'connection']),
    route(URI_TEMPLATES.connectionAttempt, 'McpServerConnectionAttempt', 'mcp-server-connection-attempt', '读取一次已保留的 HTTP MCP Server 连接尝试', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-servers.read'],
        preconditions: [], relation: 'mcp-server-connection-attempt', summary: '读取 HTTP MCP 连接尝试的状态和结果',
        outputSchema: OPERATION_SCHEMA,
      }),
    }, ['MCP server attempt'], ['mcp', 'server', 'operation']),
    route(URI_TEMPLATES.calls, 'McpCallCollection', 'mcp-calls', '通过指定外部 HTTP MCP Server 创建异步 Tool Call；结果从 /mcp-calls/{callId} 读取', {
      POST: method(CALL_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['mcp-servers.call'],
        preconditions: [],
        guidance: MCP_CALL_GUIDANCE,
        relation: 'mcp-calls', summary: '调用一个已同步 schemaHash 的外部 HTTP MCP Tool', outputSchema: OPERATION_SCHEMA,
      }),
    }, ['call MCP tool'], ['mcp', 'call']),
    route(URI_TEMPLATES.callCollection, 'McpCallCollection', 'mcp-calls', '列出已保留的外部 HTTP MCP Tool Call 结果；此集合不是调用入口', {
      GET: method(TOOL_LIST_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-calls.read'],
        preconditions: [], relation: 'mcp-calls', summary: '列出外部 HTTP MCP Tool Call 状态和结果',
        outputSchema: OPERATION_COLLECTION_SCHEMA,
      }),
    }, ['MCP call results'], ['mcp', 'call', 'operation']),
    route(URI_TEMPLATES.call, 'McpCall', 'mcp-call', '读取一个绑定到所有者且已保留的 MCP Call', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['mcp-calls.read'],
        preconditions: [], relation: 'mcp-call', summary: '读取 MCP Call 状态和结果', outputSchema: OPERATION_SCHEMA,
      }),
    }, ['MCP call result'], ['mcp', 'call', 'operation']),
  ]);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function canonicalServerUri(serverId) {
    return serverId === undefined || serverId === null || serverId === ''
      ? URI_TEMPLATES.servers
      : URI_TEMPLATES.servers + '/' + segment(serverId);
  }

  function canonicalToolUri(serverId, toolName) { return canonicalServerUri(serverId) + '/tools/' + segment(toolName); }
  function canonicalCallsUri(serverId, toolName) { return canonicalToolUri(serverId, toolName) + '/calls'; }
  function canonicalCallUri(callId) { return '/mcp-calls/' + segment(callId); }
  function canonicalDiscoveryUri(serverId, discoveryId) {
    return canonicalServerUri(serverId) + '/tool-discoveries/' + segment(discoveryId);
  }
  function canonicalConnectionAttemptUri(serverId, attemptId) {
    return canonicalServerUri(serverId) + '/connection-attempts/' + segment(attemptId);
  }

  function createRepresentation(uri, type, data, service) {
    uri = arp.canonicalizeUri(uri);
    var output = {
      uri: uri, type: type, data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
    if (type === 'McpTool') output.links.push({ rel: 'calls', href: uri + '/calls', method: 'POST' });
    if (data && service && typeof service.etag === 'function') output.etag = service.etag(data);
    return arp.normalizeRepresentation(output);
  }

  function result(uri, type, data, service, statusCode) {
    return { statusCode: statusCode || 200, primary: createRepresentation(uri, type, data, service), schemaValue: data };
  }

  function operationResult(uri, type, data, service) {
    return {
      statusCode: 202,
      primary: createRepresentation(uri, type, data, service),
      schemaValue: data,
      receipt: { performed: 'yes', operationUri: uri, retryAfterMs: 250, state: 'running' },
    };
  }

  function bindSchemaHash(inputSchema, schemaHash) {
    var schema = JSON.parse(JSON.stringify(inputSchema || { type: 'object', properties: {}, additionalProperties: false }));
    schema.type = 'object';
    schema.properties = schema.properties || {};
    schema.properties.schemaHash = { type: 'string', const: String(schemaHash) };
    schema.required = Array.from(new Set((schema.required || []).concat(['schemaHash'])));
    schema.additionalProperties = false;
    return schema;
  }

  function create(options) {
    options = options || {};
    var service = options.mcpService || options.service;
    if (!service) throw new Error('McpResource requires an injected mcpService');
    var callRoute = ROUTE_CONTRACTS.filter(function (routeContract) { return routeContract.template === URI_TEMPLATES.calls; })[0];

    function prepareCall(request) {
      return Promise.all([
        service.getMcpServer(request.params.serverId),
        service.getMcpToolContract(request.params.serverId, request.params.toolName),
      ]).then(function (values) {
        return { server: values[0], toolContract: values[1] };
      });
    }

    function resolveCapabilityDescriptor(request) {
      request = request || {};
      var uri = arp.canonicalizeUri(request.uri);
      var params = callRoute.match(uri);
      if (!params) return Promise.resolve(null);
      return service.getMcpToolContract(params.serverId, params.toolName).then(function (toolContract) {
        var contract = callRoute.methods.POST;
        var descriptor = new arp.CapabilityDescriptor({
          schemaVersion: 'mcp-tool@' + String(toolContract.schemaHash).replace(/^sha256:/, ''),
          method: 'POST', href: uri, relation: contract.relation || callRoute.relation,
          summary: toolContract.description || contract.summary || callRoute.summary,
          inputSchema: bindSchemaHash(toolContract.inputSchema, toolContract.schemaHash),
          outputSchema: contract.outputSchema, safety: contract.safety, idempotency: contract.idempotency,
          execution: contract.execution, requiredPermissions: contract.permissions,
          requiredPreconditions: contract.preconditions,
        });
        return { descriptor: descriptor, schemaHash: toolContract.schemaHash, toolContract: toolContract };
      });
    }

    function createCall(request, context) {
      return prepareCall(request).then(function (prepared) {
        if (typeof options.beforeCreateCall !== 'function') return prepared;
        return Promise.resolve(options.beforeCreateCall(prepared, request, context)).then(function () { return prepared; });
      }).then(function () {
        return service.createMcpCall(request.params.serverId, request.params.toolName, request.body, context);
      }).then(function (data) {
        return operationResult(canonicalCallUri(data.id), 'McpCall', data, service);
      });
    }

    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET[URI_TEMPLATES.servers] = function (request) {
      return service.listMcpServers(request.query).then(function (data) { return result(URI_TEMPLATES.servers, 'McpServerCollection', data, service); });
    };
    handlers.GET[URI_TEMPLATES.server] = function (request) {
      return service.getMcpServer(request.params.serverId).then(function (data) { return result(request.uri, 'McpServer', data, service); });
    };
    handlers.GET[URI_TEMPLATES.tools] = function (request) {
      return service.listMcpTools(request.params.serverId, request.query).then(function (data) { return result(request.uri, 'McpToolCollection', data, service); });
    };
    handlers.GET[URI_TEMPLATES.tool] = function (request) {
      return service.getMcpToolContract(request.params.serverId, request.params.toolName).then(function (contract) {
        return result(request.uri, 'McpTool', {
          name: contract.toolName, description: contract.description, inputSchema: contract.argumentSchema,
          outputSchema: contract.outputSchema, schemaHash: contract.schemaHash,
        }, service);
      });
    };
    handlers.GET[URI_TEMPLATES.discovery] = function (request, context) {
      return service.getMcpToolDiscovery(request.params.serverId, request.params.discoveryId, context).then(function (data) {
        return result(request.uri, 'McpToolDiscovery', data, service);
      });
    };
    handlers.GET[URI_TEMPLATES.connectionAttempt] = function (request, context) {
      return service.getMcpServerConnectionAttempt(request.params.serverId, request.params.attemptId, context).then(function (data) {
        return result(request.uri, 'McpServerConnectionAttempt', data, service);
      });
    };
    handlers.GET[URI_TEMPLATES.callCollection] = function (request, context) {
      return service.listMcpCalls(request.query, context).then(function (data) {
        return result(request.uri, 'McpCallCollection', data, service);
      });
    };
    handlers.GET[URI_TEMPLATES.call] = function (request, context) {
      return service.getMcpCall(request.params.callId, context).then(function (data) { return result(request.uri, 'McpCall', data, service); });
    };
    handlers.POST[URI_TEMPLATES.servers] = function (request, context) {
      return service.createMcpServer(request.body, context).then(function (data) { return result(canonicalServerUri(data.id), 'McpServer', data, service, 201); });
    };
    handlers.POST[URI_TEMPLATES.discoveries] = function (request, context) {
      return service.createMcpToolDiscovery(request.params.serverId, request.body, context).then(function (data) {
        return operationResult(canonicalDiscoveryUri(request.params.serverId, data.id), 'McpToolDiscovery', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.connectionAttempts] = function (request, context) {
      return service.createMcpServerConnectionAttempt(request.params.serverId, request.body, context).then(function (data) {
        return operationResult(canonicalConnectionAttemptUri(request.params.serverId, data.id), 'McpServerConnectionAttempt', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.calls] = createCall;
    handlers.PATCH[URI_TEMPLATES.server] = function (request, context) {
      return service.patchMcpServer(request.params.serverId, request.patch, context).then(function (data) {
        return result(request.uri, 'McpServer', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.server] = function (request, context) {
      return service.deleteMcpServer(request.params.serverId, context).then(function (data) { return result(request.uri, 'DeletedResource', data, service); });
    };
    Object.keys(handlers).forEach(function (methodName) { Object.freeze(handlers[methodName]); });
    return Object.freeze({
      service: service, routeContracts: ROUTE_CONTRACTS, handlers: Object.freeze(handlers),
      prepareCall: prepareCall, createCall: createCall, resolveCapabilityDescriptor: resolveCapabilityDescriptor,
      preconditionState: service.preconditionState,
    });
  }

  function createMcpServersAdapter(options) {
    var resource = create(options);
    return ResourceModuleAdapter.create({
      root: 'mcp-servers',
      resource: resource,
      introspect: function (_context, request) {
        return resource.resolveCapabilityDescriptor(request).then(function (resolved) {
          return resolved ? [resolved.descriptor] : null;
        });
      },
      resolveCapabilityDescriptor: resource.resolveCapabilityDescriptor,
    });
  }

  function createMcpCallsAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'mcp-calls', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1,
    URI_TEMPLATES: URI_TEMPLATES,
    ROUTE_CONTRACTS: ROUTE_CONTRACTS,
    canonicalUri: canonicalServerUri,
    canonicalServerUri: canonicalServerUri,
    canonicalToolUri: canonicalToolUri,
    canonicalCallsUri: canonicalCallsUri,
    canonicalCallUri: canonicalCallUri,
    createRepresentation: createRepresentation,
    bindSchemaHash: bindSchemaHash,
    createRouteContracts: function () { return ROUTE_CONTRACTS.slice(); },
    create: create,
    createMcpResource: create,
    createAdapter: createMcpServersAdapter,
    createMcpServersAdapter: createMcpServersAdapter,
    createMcpCallsAdapter: createMcpCallsAdapter,
  });
});
