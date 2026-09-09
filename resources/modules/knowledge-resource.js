// Canonical ARP/1 Knowledge resource contracts.
(function attachKnowledgeResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var adapterModule = commonJs ? require('../../resources/resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !adapterModule) throw new Error('KnowledgeResource dependencies are incomplete');
  var api = factory(arp, adapterModule);
  if (commonJs) module.exports = api;
  else root.KnowledgeResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, ResourceModuleAdapter) {
  'use strict';

  var URI_TEMPLATES = Object.freeze({
    collection: '/knowledge',
    item: '/knowledge/{knowledgeId}',
    settings: '/knowledge-settings',
  });
  var OBJECT = Object.freeze({ type: 'object' });
  // Backup import and the Options knowledge editor persist managed provenance
  // fields. Their background-stamped ui:* calls keep the established internal
  // representation contract; Agent RouteContracts stay closed and expose only
  // fields an Agent may deliberately author.
  var TRUSTED_UI_OBJECT_SCHEMA = Object.freeze({ type: 'object' });
  var KNOWLEDGE_RESOURCE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 240 },
      type: { type: 'string', enum: ['conversation', 'process', 'experience', 'tool', 'mcp', 'skill', 'document', 'custom'] },
      title: { type: 'string', minLength: 1, maxLength: 120 }, summary: { type: 'string', maxLength: 800 },
      content: { type: 'string', minLength: 1, maxLength: 200000 }, tags: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 120 } },
      pinned: { type: 'boolean' }, archived: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      captureMoment: { type: 'string', maxLength: 2000 },
    },
    required: ['title', 'content'], additionalProperties: false,
  });
  var EMPTY_QUERY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var KNOWLEDGE_PERSISTENCE_GUIDANCE = Object.freeze([
    'P2 知识沉淀是“只有用户明确要求才创建可复现工作资源”规则的窄例外，无需用户另行要求，模型可以主动 POST /knowledge。',
    '仅当对话中形成已验证、可脱离当前上下文并跨任务复用的稳定知识时才写入。不要把它作为每回合结束步骤，也不要保存一次性任务结果、瞬时页面状态、敏感信息或未经验证的猜测；不确定时不写入。',
  ]);
  var KNOWLEDGE_RETRIEVAL_GUIDANCE = Object.freeze([
    '从查询结果取得 knowledgeId 后，用 GET /knowledge/{knowledgeId} 读取条目。retrieval="grep" 的大条目 GET 只返回小节目录，继续使用路径目录披露的 Knowledge 集合 grep request-target 获取具体小节；mode=grep 不属于条目 URI。',
    '路径目录已披露的固定 GET request-target 不需要先 OPTIONS；需要其他查询字段且 schema 未预加载时再 OPTIONS /knowledge。',
  ]);
  var KNOWLEDGE_CATALOG_AFFORDANCES = Object.freeze([
    Object.freeze({
      method: 'GET', href: '/knowledge', rel: 'knowledge-list',
      title: 'Knowledge 内容是系统知识和可复用的知识，需要显式读取。',
    }),
    Object.freeze({
      method: 'GET', href: '/knowledge?mode=grep&q=<pattern>&after=20', rel: 'knowledge-grep',
      title: '在 Knowledge 集合中逐行查找；mode=grep 不属于条目 URI。',
    }),
    Object.freeze({
      method: 'GET', href: '/knowledge?mode=relevance&q=<query>', rel: 'knowledge-relevance',
      title: '获取相关候选列表。',
    }),
  ]);
  var PAGE_QUERY = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      q: { type: 'string', maxLength: 4096, description: 'mode=grep 为逐行匹配模式（正则时长度上限 256，fixedStrings=true 时按字面匹配、上限 4096）；mode=relevance 为相关性查询；mode=list 不参与过滤' },
      mode: { type: 'string', enum: ['list', 'grep', 'relevance'] },
      includeArchived: { type: 'boolean' }, sourceKind: { type: 'string', maxLength: 100 },
      includeStale: { type: 'boolean' },
      type: { type: 'string', enum: ['conversation', 'process', 'experience', 'tool', 'mcp', 'skill', 'document', 'custom'] },
      contextChars: { type: 'integer', minimum: 60, maximum: 600 },
      before: { type: 'integer', minimum: 0, maximum: 20 },
      after: { type: 'integer', minimum: 0, maximum: 20 },
      context: { type: 'integer', minimum: 0, maximum: 20 },
      perItemLimit: { type: 'integer', minimum: 1, maximum: 50 },
      maxLineLength: { type: 'integer', minimum: 80, maximum: 2000, description: '仅 mode=grep：匹配行的单行截断长度，默认 500' },
      fixedStrings: { type: 'boolean' },
      caseSensitive: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      type: KNOWLEDGE_RESOURCE_SCHEMA.properties.type, title: KNOWLEDGE_RESOURCE_SCHEMA.properties.title,
      summary: KNOWLEDGE_RESOURCE_SCHEMA.properties.summary, content: KNOWLEDGE_RESOURCE_SCHEMA.properties.content,
      tags: KNOWLEDGE_RESOURCE_SCHEMA.properties.tags, pinned: KNOWLEDGE_RESOURCE_SCHEMA.properties.pinned,
      archived: KNOWLEDGE_RESOURCE_SCHEMA.properties.archived, confidence: KNOWLEDGE_RESOURCE_SCHEMA.properties.confidence,
      captureMoment: KNOWLEDGE_RESOURCE_SCHEMA.properties.captureMoment,
    },
    minProperties: 1, additionalProperties: false,
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);
  var KNOWLEDGE_SETTINGS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      autoCapture: { type: 'boolean' },
    },
    required: ['enabled', 'autoCapture'],
    additionalProperties: false,
  });
  var KNOWLEDGE_SETTINGS_PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      autoCapture: { type: 'boolean' },
    },
    minProperties: 1, additionalProperties: false,
  });

  function method(inputSchema, policy) {
    policy = policy || {};
    return Object.assign({ inputSchema: inputSchema, outputSchema: policy.outputSchema || OBJECT }, policy);
  }

  function isTrustedUi(context) {
    return /^ui:/.test(String(context && (context.actorId || context.actor) || ''));
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function modelCatalogItem(item) {
    item = item && typeof item === 'object' ? item : {};
    var output = {
      id: item.id,
      type: item.type,
      sourceKind: item.sourceKind,
      title: item.title,
      summary: item.summary,
      tags: Array.isArray(item.tags) ? item.tags.slice() : [],
      verificationState: item.verificationState,
    };
    if (item.retrieval) output.retrieval = item.retrieval;
    if (item.snippet) {
      output.score = Number(item.score) || 0;
      output.snippet = item.snippet;
    }
    return output;
  }

  function modelGrepMatch(match) {
    match = match && typeof match === 'object' ? match : {};
    return {
      uri: match.uri,
      knowledgeId: match.knowledgeId,
      line: match.line,
      title: match.title,
      type: match.type,
      sourceKind: match.sourceKind,
      content: match.content,
      before: clone(match.before || []),
      after: clone(match.after || []),
      lines: clone(match.lines || []),
    };
  }

  function modelKnowledgeCollection(data) {
    data = data && typeof data === 'object' ? data : {};
    var output = {};
    [
      'provider', 'mode', 'query', 'queryTruncated', 'pattern', 'fixedStrings',
      'caseSensitive', 'beforeContext', 'afterContext', 'perItemLimit',
      'total', 'cursor', 'nextCursor', 'truncated', 'next',
    ].forEach(function (key) {
      if (data[key] !== undefined) output[key] = clone(data[key]);
    });
    if (data.counts) output.counts = clone(data.counts);
    if (Array.isArray(data.items)) output.items = data.items.map(modelCatalogItem);
    if (Array.isArray(data.matches)) {
      output.matches = data.mode === 'grep'
        ? data.matches.map(modelGrepMatch)
        : data.matches.map(modelCatalogItem);
    }
    return output;
  }

  function trustedUiDescriptor(request, context, route) {
    if (!isTrustedUi(context) || !route) return null;
    var methodName = String(request && request.method || '').toUpperCase();
    var contract = route.methods && route.methods[methodName];
    if (!contract) return null;
    return new arp.CapabilityDescriptor({
      schemaVersion: arp.PROTOCOL,
      method: methodName,
      href: request.uri,
      relation: contract.relation || route.relation,
      summary: contract.summary || route.summary,
      inputSchema: TRUSTED_UI_OBJECT_SCHEMA,
      outputSchema: contract.outputSchema,
      safety: contract.safety,
      idempotency: contract.idempotency,
      execution: contract.execution,
      requiredPermissions: contract.permissions,
      requiredPreconditions: contract.preconditions,
      guidance: route.guidance.concat(contract.guidance || []),
      patchMediaTypes: contract.patchMediaTypes,
      deprecated: contract.deprecated || route.deprecated,
    });
  }

  function route(template, resourceType, relation, summary, methods, aliases, tags, guidance, affordances) {
    return new arp.RouteContract({
      template: template, resourceType: resourceType, relation: relation, summary: summary,
      aliases: aliases, tags: tags, guidance: guidance, affordances: affordances,
      entryWeights: { flow: 25, 'flow-editor': 35, global: 15 }, methods: methods,
    });
  }

  var ROUTE_CONTRACTS = Object.freeze([
    route(URI_TEMPLATES.collection, 'KnowledgeCollection', 'knowledge', '列出、grep、搜索或显式创建 Knowledge', {
      GET: method(PAGE_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['knowledge.read'],
        preconditions: [], relation: 'knowledge', summary: '在本地查询 Knowledge',
      }),
      POST: method(KNOWLEDGE_RESOURCE_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['knowledge.write'],
        preconditions: [],
        relation: 'knowledge', summary: '创建一个 Knowledge 条目', guidance: KNOWLEDGE_PERSISTENCE_GUIDANCE,
      }),
    }, ['knowledge search', 'persist knowledge'], ['knowledge', 'memory'],
    KNOWLEDGE_RETRIEVAL_GUIDANCE, KNOWLEDGE_CATALOG_AFFORDANCES),
    route(URI_TEMPLATES.item, 'Knowledge', 'knowledge-item', '读取或修改一个 Knowledge 条目', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['knowledge.read'],
        preconditions: [], relation: 'knowledge-item', summary: '读取一个 Knowledge 条目',
        modelProjection: { type: 'field', field: 'content' },
      }),
      PUT: method(KNOWLEDGE_RESOURCE_SCHEMA, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['knowledge.write'],
        preconditions: ['if-match'],
        relation: 'knowledge-item', summary: '提交一个 Knowledge 条目的完整表示；省略的可选字段保留现值',
      }),
      PATCH: method(PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['knowledge.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'knowledge-item', summary: '局部修改一个 Knowledge 条目',
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['knowledge.delete'],
        preconditions: ['if-match'],
        relation: 'knowledge-item', summary: '删除一个可修改的 Knowledge 条目',
      }),
    }, ['knowledge details'], ['knowledge', 'memory']),
    route(URI_TEMPLATES.settings, 'KnowledgeSettings', 'knowledge-settings', '读取或修改唯一一份 Knowledge 行为设置', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['knowledge.read'],
        preconditions: [], relation: 'knowledge-settings', summary: '读取 Knowledge 设置',
        outputSchema: KNOWLEDGE_SETTINGS_SCHEMA,
      }),
      PATCH: method(KNOWLEDGE_SETTINGS_PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['knowledge.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'knowledge-settings', summary: '局部修改 Knowledge 设置',
        outputSchema: KNOWLEDGE_SETTINGS_SCHEMA,
      }),
    }, ['knowledge configuration'], ['knowledge', 'settings']),
  ]);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function canonicalUri(knowledgeId) {
    return knowledgeId === undefined || knowledgeId === null || knowledgeId === ''
      ? URI_TEMPLATES.collection
      : URI_TEMPLATES.collection + '/' + segment(knowledgeId);
  }

  function createRepresentation(uri, type, data, service) {
    uri = arp.canonicalizeUri(uri);
    var output = {
      uri: uri, type: type, data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
    if (data && service && typeof service.etag === 'function') output.etag = service.etag(data);
    return arp.normalizeRepresentation(output);
  }

  function result(uri, type, data, service, statusCode) {
    return { statusCode: statusCode || 200, primary: createRepresentation(uri, type, data, service), schemaValue: data };
  }

  function create(options) {
    options = options || {};
    var service = options.resourceService || options.service;
    if (!service) throw new Error('KnowledgeResource requires an injected resourceService');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET[URI_TEMPLATES.collection] = function (request, context) {
      return service.listKnowledge(request.query).then(function (data) {
        return result(
          URI_TEMPLATES.collection,
          'KnowledgeCollection',
          isTrustedUi(context) ? data : modelKnowledgeCollection(data),
          service
        );
      });
    };
    // retrieval='grep' 的 detail 级条目:模型/MCP 侧 GET 恒返回“头部说明+带行号小节目录”,
    // 细节只经 grep 按行取用,防止整条几十 KB 灌进模型上下文。ui:* 可信 surface
    // (配置中心查看/编辑)仍取全文,否则编辑保存会用目录视图覆盖原文。
    function grepOnlyDigest(item) {
      var lines = String(item.content || '').split('\n');
      var toc = [];
      var headEnd = lines.length;
      for (var i = 0; i < lines.length; i++) {
        if (/^## /.test(lines[i])) {
          if (toc.length === 0) headEnd = i;
          toc.push((i + 1) + ': ' + lines[i]);
        }
      }
      var digest = Object.assign({}, item);
      digest.content = lines.slice(0, headEnd).join('\n').trim()
        + '\n\n[Detail knowledge: GET /knowledge?mode=grep&q=<section-title-or-keyword>&after=20. GET returns only this index; use that request-target to retrieve a full section.]'
        + '\n\nIndex (line: section):\n' + toc.join('\n');
      return digest;
    }
    handlers.GET[URI_TEMPLATES.item] = function (request, context) {
      return service.getKnowledge(request.params.knowledgeId).then(function (data) {
        var actorId = String(context && (context.actorId || context.actor) || '');
        if (data && data.retrieval === 'grep' && actorId.indexOf('ui:') !== 0) {
          data = grepOnlyDigest(data);
        }
        return result(request.uri, 'Knowledge', data, service);
      });
    };
    handlers.GET[URI_TEMPLATES.settings] = function () {
      return service.getKnowledgeSettings().then(function (data) { return result(URI_TEMPLATES.settings, 'KnowledgeSettings', data, service); });
    };
    handlers.POST[URI_TEMPLATES.collection] = function (request) {
      return service.createKnowledge(request.body).then(function (data) { return result(canonicalUri(data.id), 'Knowledge', data, service, 201); });
    };
    handlers.PUT[URI_TEMPLATES.item] = function (request) {
      return service.replaceKnowledge(request.params.knowledgeId, request.body).then(function (data) {
        return result(request.uri, 'Knowledge', data, service);
      });
    };
    handlers.PATCH[URI_TEMPLATES.item] = function (request) {
      return service.patchKnowledge(request.params.knowledgeId, request.patch).then(function (data) {
        return result(request.uri, 'Knowledge', data, service);
      });
    };
    handlers.PATCH[URI_TEMPLATES.settings] = function (request) {
      return service.updateKnowledgeSettings(request.patch).then(function (data) {
        return result(URI_TEMPLATES.settings, 'KnowledgeSettings', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.item] = function (request) {
      return service.deleteKnowledge(request.params.knowledgeId).then(function (data) { return result(request.uri, 'DeletedResource', data, service); });
    };
    Object.keys(handlers).forEach(function (methodName) { Object.freeze(handlers[methodName]); });
    function resolveCapabilityDescriptor(request, context, route) {
      if (!isTrustedUi(context)) return null;
      if ((route.template === URI_TEMPLATES.collection && request.method === 'POST')
          || (route.template === URI_TEMPLATES.item && (request.method === 'PUT' || request.method === 'PATCH'))) {
        return trustedUiDescriptor(request, context, route);
      }
      return null;
    }
    return Object.freeze({
      service: service, routeContracts: ROUTE_CONTRACTS, handlers: Object.freeze(handlers),
      resolveCapabilityDescriptor: resolveCapabilityDescriptor,
      preconditionState: service.preconditionState,
    });
  }

  function createKnowledgeAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'knowledge', resource: create(options) });
  }

  function createKnowledgeSettingsAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'knowledge-settings', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1,
    URI_TEMPLATES: URI_TEMPLATES,
    METHOD_CONTRACTS: Object.freeze({
      collection: ROUTE_CONTRACTS[0].methods,
      item: ROUTE_CONTRACTS[1].methods,
      settings: ROUTE_CONTRACTS[2].methods,
    }),
    KNOWLEDGE_SETTINGS_SCHEMA: KNOWLEDGE_SETTINGS_SCHEMA,
    ROUTE_CONTRACTS: ROUTE_CONTRACTS,
    canonicalUri: canonicalUri,
    createRepresentation: createRepresentation,
    createRouteContracts: function () { return ROUTE_CONTRACTS.slice(); },
    create: create,
    createKnowledgeResource: create,
    createAdapter: createKnowledgeAdapter,
    createKnowledgeAdapter: createKnowledgeAdapter,
    createKnowledgeSettingsAdapter: createKnowledgeSettingsAdapter,
  });
});
