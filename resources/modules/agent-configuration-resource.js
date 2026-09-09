// Canonical ARP/1 Assistant, Model Service, connection attempt, and Agent Settings resources.
(function attachAgentConfigurationResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var adapterModule = commonJs ? require('../../resources/resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !adapterModule) throw new Error('AgentConfigurationResource dependencies are incomplete');
  var api = factory(arp, adapterModule);
  if (commonJs) module.exports = api;
  else root.AgentConfigurationResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, ResourceModuleAdapter) {
  'use strict';

  var URI_TEMPLATES = Object.freeze({
    assistants: '/assistants',
    assistant: '/assistants/{assistantId}',
    modelServices: '/model-services',
    modelService: '/model-services/{serviceId}',
    connectionAttempts: '/model-services/{serviceId}/connection-attempts',
    connectionAttempt: '/model-services/{serviceId}/connection-attempts/{attemptId}',
    agentSettings: '/agent-settings',
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);
  var EMPTY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var PAGE_QUERY = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      q: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  });
  var RESOURCE_POLICY_SCHEMA = Object.freeze({ type: 'object' });
  var RESOURCE_ID_LIST_SCHEMA = Object.freeze({
    type: 'array', maxItems: 50,
    items: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^/\\\\\\u0000-\\u001F\\u007F]+$' },
  });
  var RUN_SETTINGS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      temperature: { type: 'number', minimum: 0, maximum: 2 },
      topP: { type: 'number', minimum: 0, maximum: 1 },
      maxTokens: { type: 'integer', minimum: 1, maximum: 2000000 },
      maxContextTokens: { type: 'integer', minimum: 0, maximum: 2000000 },
      reasoningEffort: { type: 'string', enum: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      contextCompression: { type: 'string', enum: ['auto', 'off'] },
      streamOutput: { type: 'boolean' },
      mode: { type: 'string', enum: ['normal', 'fullAuto'] },
      maxIterations: { type: 'integer', minimum: 1, maximum: 1000 },
      maxToolCalls: { type: 'integer', minimum: 1, maximum: 5000 },
      autoCreateNewTopic: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var ASSISTANT_WRITE_PROPERTIES = Object.freeze({
    name: { type: 'string', minLength: 1, maxLength: 300 },
    description: { type: 'string', maxLength: 10000 },
    prompt: { type: 'string', maxLength: 100000 },
    skillIds: RESOURCE_ID_LIST_SCHEMA,
    mcpServerIds: RESOURCE_ID_LIST_SCHEMA,
    resourcePolicy: RESOURCE_POLICY_SCHEMA,
    modelServiceId: { type: 'string', maxLength: 240 },
    settings: RUN_SETTINGS_SCHEMA,
  });
  var ASSISTANT_CREATE_SCHEMA = Object.freeze({
    type: 'object', properties: ASSISTANT_WRITE_PROPERTIES,
    required: ['name'], additionalProperties: false,
  });
  var ASSISTANT_SCHEMA = Object.freeze({
    type: 'object',
    properties: Object.assign({
      id: { type: 'string' },
      createdAt: { type: 'number' }, updatedAt: { type: 'number' },
    }, ASSISTANT_WRITE_PROPERTIES),
    required: [
      'id', 'name', 'description', 'prompt', 'skillIds', 'mcpServerIds', 'resourcePolicy',
      'modelServiceId', 'settings', 'createdAt', 'updatedAt',
    ],
    additionalProperties: false,
  });
  var ASSISTANT_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      items: { type: 'array', items: ASSISTANT_SCHEMA }, total: { type: 'integer', minimum: 0 },
      nextCursor: { type: 'string' },
    },
    required: ['items', 'total'], additionalProperties: false,
  });

  var SECRET_INPUT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      apiKey: { type: 'string', minLength: 1, maxLength: 20000 },
      clearApiKey: { const: true },
      headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 20000 } },
      clearHeaders: { const: true },
    },
    additionalProperties: false,
  });
  var MODEL_PROTOCOL_ENUM = Object.freeze(['chat_completions', 'responses', 'anthropic']);
  var MODEL_MUTABLE_PROPERTIES = Object.freeze({
    name: { type: 'string', minLength: 1, maxLength: 300 },
    baseUrl: { type: 'string', maxLength: 4000 },
    model: { type: 'string', maxLength: 500 },
    visionModel: { type: 'string', maxLength: 500 },
    summaryModel: { type: 'string', maxLength: 500 },
    protocol: { type: 'string', enum: MODEL_PROTOCOL_ENUM },
    // 旧客户端写入兼容：apiStyle 由 service 映射为 protocol，providerType
    // 系被接受并忽略；规范化状态、资源返回和备份输出不保存这些字段。
    apiStyle: { type: 'string', enum: MODEL_PROTOCOL_ENUM, description: '已废弃：protocol 的旧别名，新请求请使用 protocol' },
    providerType: { type: 'string', maxLength: 100, description: '已废弃：服务类型不参与协议选择，接受并忽略' },
    provider_type: { type: 'string', maxLength: 100, description: '已废弃：接受并忽略' },
    reasoningProviderType: { type: 'string', maxLength: 100, description: '已废弃：接受并忽略' },
    userAgent: { type: 'string', maxLength: 512 },
    maxContextTokens: { type: 'integer', minimum: 0, maximum: 2000000 },
    autoCompactTokenLimit: { type: 'integer', minimum: 0, maximum: 2000000 },
    reasoningEffort: { type: 'string', enum: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    requestTimeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 50 },
    maxRetryDelayMs: { type: 'integer', minimum: 0, maximum: 600000 },
    contextCompression: { type: 'string', enum: ['auto', 'off'] },
    secret: SECRET_INPUT_SCHEMA,
  });
  var MODEL_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: Object.assign({ id: { type: 'string', minLength: 1, maxLength: 240 } }, MODEL_MUTABLE_PROPERTIES),
    required: ['name'], additionalProperties: false,
  });
  var CREDENTIAL_METADATA_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      hasSecret: { type: 'boolean' }, secretRef: { type: 'string' }, apiKeyConfigured: { type: 'boolean' },
      headers: {
        type: 'array', items: {
          type: 'object',
          properties: { name: { type: 'string' }, configured: { const: true }, masked: { const: true } },
          required: ['name', 'configured', 'masked'], additionalProperties: false,
        },
      },
      revision: { type: 'number', minimum: 0 },
    },
    required: ['hasSecret', 'secretRef', 'apiKeyConfigured', 'headers', 'revision'],
    additionalProperties: false,
  });
  var MODEL_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, baseUrl: { type: 'string' }, model: { type: 'string' },
      visionModel: { type: 'string' }, summaryModel: { type: 'string' }, protocol: MODEL_MUTABLE_PROPERTIES.protocol,
      userAgent: { type: 'string' },
      maxContextTokens: { type: 'integer' }, autoCompactTokenLimit: { type: 'integer' },
      reasoningEffort: MODEL_MUTABLE_PROPERTIES.reasoningEffort, requestTimeoutMs: { type: 'integer' },
      maxRetries: { type: 'integer' }, maxRetryDelayMs: { type: 'integer' },
      contextCompression: MODEL_MUTABLE_PROPERTIES.contextCompression,
      credentialMetadata: CREDENTIAL_METADATA_SCHEMA,
      createdAt: { type: 'number' }, updatedAt: { type: 'number' },
    },
    required: [
      'id', 'name', 'baseUrl', 'model', 'visionModel', 'summaryModel', 'protocol', 'userAgent',
      'maxContextTokens', 'autoCompactTokenLimit', 'reasoningEffort', 'requestTimeoutMs',
      'maxRetries', 'maxRetryDelayMs', 'contextCompression', 'credentialMetadata', 'createdAt', 'updatedAt',
    ],
    additionalProperties: false,
  });
  var MODEL_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      items: { type: 'array', items: MODEL_SCHEMA }, total: { type: 'integer', minimum: 0 },
      nextCursor: { type: 'string' },
    },
    required: ['items', 'total'], additionalProperties: false,
  });
  var ATTEMPT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, kind: { const: 'model-service-connection-attempt' }, serviceId: { type: 'string' },
      owner: { type: 'object' }, protocol: { type: 'string', enum: ['chat_completions', 'responses', 'anthropic'] },
      status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'interrupted'] },
      startedAt: { type: 'number' }, createdAt: { type: 'number' }, updatedAt: { type: 'number' },
      heartbeatAt: { type: 'number' }, leaseExpiresAt: { type: 'number' }, endedAt: { type: 'number' },
      latencyMs: { type: 'number' }, result: { type: ['object', 'null'] }, error: { type: ['object', 'null'] },
      recoverable: { type: 'boolean' },
    },
    required: [
      'id', 'kind', 'serviceId', 'owner', 'protocol', 'status', 'startedAt', 'createdAt', 'updatedAt',
      'heartbeatAt', 'leaseExpiresAt', 'endedAt', 'latencyMs', 'result', 'error', 'recoverable',
    ],
    additionalProperties: false,
  });
  var CONTEXT_BUDGET_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      maxContextTokens: { type: 'integer', minimum: 0, maximum: 2000000 },
      autoCompactTokenLimit: { type: 'integer', minimum: 0, maximum: 2000000 },
    },
    required: ['maxContextTokens', 'autoCompactTokenLimit'], additionalProperties: false,
  });
  var AGENT_SETTINGS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      defaultAssistantId: { type: 'string' }, defaultModelServiceId: { type: 'string' },
      contextBudget: CONTEXT_BUDGET_SCHEMA,
      contextCompression: { type: 'string', enum: ['auto', 'off'] },
    },
    required: ['defaultAssistantId', 'defaultModelServiceId', 'contextBudget', 'contextCompression'],
    additionalProperties: false,
  });
  var DELETED_SCHEMA = Object.freeze({
    type: 'object', properties: { id: { type: 'string' }, deleted: { const: true } },
    required: ['id', 'deleted'], additionalProperties: false,
  });
  var ASSISTANT_MUTATION_GUIDANCE = Object.freeze([
    'Assistant 是可复用的稳定职责配置。prompt 只保存长期职责、事实边界、副作用边界和完成条件；当前某次任务的数据应放在调用该 Assistant 的本次输入中。',
    'Flow 的 runAssistant 节点只引用 assistantId 和本次运行参数，不复制 Assistant prompt、模型凭据或资源策略。',
  ]);

  function nullableProperties(source) {
    var output = {};
    Object.keys(source).forEach(function (key) {
      output[key] = { anyOf: [source[key], { type: 'null' }] };
    });
    return output;
  }

  function patchSchema(properties) {
    return {
      type: 'object', properties: nullableProperties(properties), minProperties: 1, additionalProperties: false,
    };
  }

  var ASSISTANT_PATCH_SCHEMA = Object.freeze(patchSchema(ASSISTANT_WRITE_PROPERTIES));
  var MODEL_PATCH_SCHEMA = Object.freeze(patchSchema(MODEL_MUTABLE_PROPERTIES));
  var AGENT_SETTINGS_PATCH_SCHEMA = Object.freeze(patchSchema(AGENT_SETTINGS_SCHEMA.properties));

  function method(inputSchema, outputSchema, policy) {
    return Object.assign({ inputSchema: inputSchema, outputSchema: outputSchema }, policy);
  }

  function route(template, resourceType, relation, summary, methods, aliases, tags) {
    return new arp.RouteContract({
      template: template,
      resourceType: resourceType,
      relation: relation,
      summary: summary,
      aliases: aliases || [],
      tags: tags || [],
      entryWeights: { global: 35, options: 30 },
      methods: methods,
    });
  }

  var ROUTE_CONTRACTS = Object.freeze([
    route(URI_TEMPLATES.assistants, 'AssistantCollection', 'assistants', '列出或创建轻量级 Agent Assistant', {
      GET: method(PAGE_QUERY, ASSISTANT_COLLECTION_SCHEMA, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['assistants.read'],
        preconditions: [], relation: 'assistants', summary: '列出 Assistant 资源',
      }),
      POST: method(ASSISTANT_CREATE_SCHEMA, ASSISTANT_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['assistants.write'],
        preconditions: [],
        relation: 'assistants', summary: '创建一个 Assistant', guidance: ASSISTANT_MUTATION_GUIDANCE,
      }),
    }, ['assistant profiles', '助手'], ['assistant', 'agent', 'profile']),
    route(URI_TEMPLATES.assistant, 'Assistant', 'assistant', '读取、局部修改或删除一个 Assistant', {
      GET: method(EMPTY, ASSISTANT_SCHEMA, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['assistants.read'],
        preconditions: [], relation: 'assistant', summary: '读取一个 Assistant',
      }),
      PATCH: method(ASSISTANT_PATCH_SCHEMA, ASSISTANT_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['assistants.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'assistant', summary: '局部修改一个 Assistant', guidance: ASSISTANT_MUTATION_GUIDANCE,
      }),
      DELETE: method(null, DELETED_SCHEMA, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['assistants.delete'],
        preconditions: ['if-match'],
        relation: 'assistant', summary: '删除一个 Assistant，并重新分配其 Conversation',
      }),
    }, ['assistant profile', '助手详情'], ['assistant', 'agent', 'profile']),
    route(URI_TEMPLATES.modelServices, 'ModelServiceCollection', 'model-services', '列出或创建规范的 ModelService', {
      GET: method(PAGE_QUERY, MODEL_COLLECTION_SCHEMA, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['model-services.read'],
        preconditions: [], relation: 'model-services', summary: '列出已脱敏的 ModelService',
      }),
      POST: method(MODEL_CREATE_SCHEMA, MODEL_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['model-services.write'],
        preconditions: [],
        relation: 'model-services', summary: '创建一个 ModelService 和可选密钥',
      }),
    }, ['model providers', '模型服务'], ['model', 'provider', 'service']),
    route(URI_TEMPLATES.modelService, 'ModelService', 'model-service', '读取、局部修改或删除一个已脱敏的 ModelService', {
      GET: method(EMPTY, MODEL_SCHEMA, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['model-services.read'],
        preconditions: [], relation: 'model-service', summary: '读取一个已脱敏的 ModelService',
      }),
      PATCH: method(MODEL_PATCH_SCHEMA, MODEL_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['model-services.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'model-service', summary: '局部修改一个 ModelService；省略 secret 时保留原值',
      }),
      DELETE: method(null, DELETED_SCHEMA, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['model-services.delete'],
        preconditions: ['if-match'],
        relation: 'model-service', summary: '删除一个 ModelService 并解除其绑定',
      }),
    }, ['model provider', '模型服务详情'], ['model', 'provider', 'service']),
    route(URI_TEMPLATES.connectionAttempts, 'ModelServiceConnectionAttemptCollection', 'model-service-connection-attempts', '创建一次真实且最小化的流式 ModelService 连接尝试', {
      POST: method(EMPTY, ATTEMPT_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['model-services.execute'],
        preconditions: [],
        relation: 'model-service-connection-attempts', summary: '创建一个绑定到所有者的 ModelService ConnectionAttempt',
      }),
    }, ['test model connection'], ['model', 'provider', 'connection']),
    route(URI_TEMPLATES.connectionAttempt, 'ModelServiceConnectionAttempt', 'model-service-connection-attempt', '读取一个绑定到所有者的 ConnectionAttempt', {
      GET: method(EMPTY, ATTEMPT_SCHEMA, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['model-services.read'],
        preconditions: [], relation: 'model-service-connection-attempt', summary: '读取 ConnectionAttempt 状态和已脱敏结果',
      }),
    }, ['model connection result'], ['model', 'provider', 'connection', 'operation']),
    route(URI_TEMPLATES.agentSettings, 'AgentSettings', 'agent-settings', '读取或局部修改唯一一份轻量级 Agent 默认设置', {
      GET: method(EMPTY, AGENT_SETTINGS_SCHEMA, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['agent-settings.read'],
        preconditions: [], relation: 'agent-settings', summary: '读取唯一一份 AgentSettings',
      }),
      PATCH: method(AGENT_SETTINGS_PATCH_SCHEMA, AGENT_SETTINGS_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['agent-settings.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'agent-settings', summary: '局部修改唯一一份 AgentSettings，不嵌入 ModelService',
      }),
    }, ['agent defaults', 'Agent设置'], ['agent', 'settings', 'model']),
  ]);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function representation(uri, type, data, service, links) {
    return {
      uri: uri,
      type: type,
      data: data,
      etag: service.etag(data),
      links: links || [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
  }

  function result(uri, type, data, service, statusCode, links) {
    return {
      statusCode: statusCode || 200,
      primary: representation(uri, type, data, service, links),
      schemaValue: data,
    };
  }

  function assertWriteContract(label, schemaProperties, serviceKeys) {
    if (!Array.isArray(serviceKeys)) return;
    var schemaKeys = Object.keys(schemaProperties).sort();
    if (schemaKeys.join(',') !== serviceKeys.slice().sort().join(',')) {
      throw new Error('AgentConfigurationResource ' + label + ' write schema drifted from service mutable keys: schema=['
        + schemaKeys.join(', ') + '] service=[' + serviceKeys.join(', ') + ']');
    }
  }

  function create(options) {
    options = options || {};
    var service = options.agentConfigurationService || options.service;
    if (!service) throw new Error('AgentConfigurationResource requires an injected agentConfigurationService');
    var mutableKeyContract = service.mutableKeyContract || {};
    assertWriteContract('Assistant', ASSISTANT_WRITE_PROPERTIES, mutableKeyContract.assistant);
    assertWriteContract('ModelService', MODEL_MUTABLE_PROPERTIES, mutableKeyContract.modelService);
    assertWriteContract('AgentSettings', AGENT_SETTINGS_SCHEMA.properties, mutableKeyContract.agentSettings);
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };

    handlers.GET[URI_TEMPLATES.assistants] = function (request) {
      return service.listAssistants(request.query).then(function (data) {
        return result(request.uri, 'AssistantCollection', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.assistants] = function (request) {
      return service.createAssistant(request.body).then(function (data) {
        var uri = URI_TEMPLATES.assistants + '/' + segment(data.id);
        return result(uri, 'Assistant', data, service, 201);
      });
    };
    handlers.GET[URI_TEMPLATES.assistant] = function (request) {
      return service.getAssistant(request.params.assistantId).then(function (data) {
        return result(request.uri, 'Assistant', data, service);
      });
    };
    handlers.PATCH[URI_TEMPLATES.assistant] = function (request) {
      return service.patchAssistant(request.params.assistantId, request.patch).then(function (data) {
        return result(request.uri, 'Assistant', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.assistant] = function (request) {
      return service.deleteAssistant(request.params.assistantId).then(function (data) {
        return result(request.uri, 'DeletedResource', data, service);
      });
    };

    handlers.GET[URI_TEMPLATES.modelServices] = function (request) {
      return service.listModelServices(request.query).then(function (data) {
        return result(request.uri, 'ModelServiceCollection', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.modelServices] = function (request) {
      return service.createModelService(request.body).then(function (data) {
        var uri = URI_TEMPLATES.modelServices + '/' + segment(data.id);
        return result(uri, 'ModelService', data, service, 201, [
          { rel: 'self', href: uri, method: 'GET' },
          { rel: 'capabilities', href: uri, method: 'OPTIONS' },
          { rel: 'connection-attempts', href: uri + '/connection-attempts', method: 'POST' },
        ]);
      });
    };
    handlers.GET[URI_TEMPLATES.modelService] = function (request) {
      return service.getModelService(request.params.serviceId).then(function (data) {
        return result(request.uri, 'ModelService', data, service, 200, [
          { rel: 'self', href: request.uri, method: 'GET' },
          { rel: 'capabilities', href: request.uri, method: 'OPTIONS' },
          { rel: 'connection-attempts', href: request.uri + '/connection-attempts', method: 'POST' },
        ]);
      });
    };
    handlers.PATCH[URI_TEMPLATES.modelService] = function (request) {
      return service.patchModelService(request.params.serviceId, request.patch).then(function (data) {
        return result(request.uri, 'ModelService', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.modelService] = function (request) {
      return service.deleteModelService(request.params.serviceId).then(function (data) {
        return result(request.uri, 'DeletedResource', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.connectionAttempts] = function (request, context) {
      return service.createConnectionAttempt(request.params.serviceId, context).then(function (data) {
        var uri = URI_TEMPLATES.modelServices + '/' + segment(request.params.serviceId)
          + '/connection-attempts/' + segment(data.id);
        return {
          statusCode: 202,
          primary: representation(uri, 'ModelServiceConnectionAttempt', data, service),
          schemaValue: data,
          receipt: {
            performed: 'yes', operationUri: uri, retryAfterMs: data.status === 'running' ? 250 : 0,
            state: data.status === 'succeeded' ? 'succeeded' : (data.status === 'failed' ? 'failed' : 'running'),
          },
        };
      });
    };
    handlers.GET[URI_TEMPLATES.connectionAttempt] = function (request, context) {
      return service.getConnectionAttempt(request.params.serviceId, request.params.attemptId, context).then(function (data) {
        return result(request.uri, 'ModelServiceConnectionAttempt', data, service);
      });
    };

    handlers.GET[URI_TEMPLATES.agentSettings] = function (request) {
      return service.getAgentSettings().then(function (data) {
        return result(request.uri, 'AgentSettings', data, service);
      });
    };
    handlers.PATCH[URI_TEMPLATES.agentSettings] = function (request) {
      return service.patchAgentSettings(request.patch).then(function (data) {
        return result(request.uri, 'AgentSettings', data, service);
      });
    };

    Object.keys(handlers).forEach(function (methodName) { Object.freeze(handlers[methodName]); });
    return Object.freeze({
      service: service,
      routeContracts: ROUTE_CONTRACTS,
      handlers: Object.freeze(handlers),
      preconditionState: service.preconditionState,
      ownsRoute: function (template) {
        return Object.keys(URI_TEMPLATES).some(function (key) { return URI_TEMPLATES[key] === template; });
      },
    });
  }

  function createAssistantsAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'assistants', resource: create(options) });
  }

  function createModelServicesAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'model-services', resource: create(options) });
  }

  function createAgentSettingsAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'agent-settings', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1,
    URI_TEMPLATES: URI_TEMPLATES,
    ROUTE_CONTRACTS: ROUTE_CONTRACTS,
    ASSISTANT_SCHEMA: ASSISTANT_SCHEMA,
    MODEL_SERVICE_SCHEMA: MODEL_SCHEMA,
    AGENT_SETTINGS_SCHEMA: AGENT_SETTINGS_SCHEMA,
    createRouteContracts: function () { return ROUTE_CONTRACTS.slice(); },
    create: create,
    createAssistantsAdapter: createAssistantsAdapter,
    createModelServicesAdapter: createModelServicesAdapter,
    createAgentSettingsAdapter: createAgentSettingsAdapter,
  });
});
