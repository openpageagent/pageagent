// Canonical ARP/1 Flow resource contracts.
(function attachFlowResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var adapterModule = commonJs ? require('../../resources/resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !adapterModule) throw new Error('ARP and ResourceModuleAdapter must load before FlowResource');
  var api = factory(arp, adapterModule);
  if (commonJs) module.exports = api;
  else root.FlowResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, ResourceModuleAdapter) {
  'use strict';

  var URI_TEMPLATES = Object.freeze({
    collection: '/flows',
    item: '/flows/{flowId}',
    nodes: '/flows/{flowId}/nodes',
    node: '/flows/{flowId}/nodes/{nodeId}',
    runs: '/flows/{flowId}/runs',
  });
  var OBJECT = Object.freeze({ type: 'object' });
  var EMPTY_QUERY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var PAGE_QUERY = Object.freeze({
    type: 'object', properties: {
      cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, additionalProperties: false,
  });
  var FLOW_QUERY = Object.freeze({
    type: 'object', properties: { view: { type: 'string', enum: ['resource', 'validation'] } }, additionalProperties: false,
  });
  var NODE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      nodeId: { type: 'string', maxLength: 240, description: '节点唯一标识；省略时由服务生成。完整 Flow 中统一使用 nodeId，不使用 id' },
      type: { type: 'string', minLength: 1, maxLength: 160, description: '必须是 /node-types 中存在的节点类型；优先使用 Agent 操作结果返回的可视化 flowNode' },
      title: { type: 'string', maxLength: 300 },
      pageId: { type: 'string', maxLength: 240, description: '可复用页面节点应绑定 /pages 中的 PageSource；运行时会认领匹配标签或按页面配置打开标签' },
      params: { type: 'object', description: '节点类型参数；键、必填项、默认值、类型、枚举和范围以 GET /node-types/{nodeType} 返回的 params 为准。selector、fields、tabId 等动作参数必须放在此对象中' },
      displayOrder: { type: 'number', description: '提交值会被忽略并按 nodes 数组顺序重写；调整顺序请重排 nodes 数组' },
      outputVar: { type: 'string', maxLength: 240, description: '可选；把该节点的 outputHint 所述输出写入顶层流程变量，供后续 {{outputVar}} 或 {{json outputVar}} 引用' },
      onFailure: { type: 'string', enum: ['abort', 'continue'], description: '失败策略；省略时按 abort 处理。只有业务允许忽略本节点失败时才使用 continue' },
      retries: { type: 'integer', minimum: 0, description: '节点级重试次数；有外部副作用或具体节点合同禁止重试时必须为 0' },
      retryDelayMs: { type: 'number', minimum: 0, description: '节点级重试间隔毫秒，仅在 retries > 0 时有意义' },
      requiresForeground: { type: 'boolean' }, foreground: { type: 'boolean' }, reveal: { type: 'boolean' },
    },
    required: ['type'], additionalProperties: false,
  });
  var FLOW_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 240 }, name: { type: 'string', maxLength: 300 },
      label: { type: 'string', maxLength: 300 }, description: { type: 'string', maxLength: 10000 },
      inputDescription: { type: 'string', maxLength: 10000 }, outputDescription: { type: 'string', maxLength: 10000 },
      inputExample: { type: 'string', maxLength: 100000, description: '运行入参示例，内容必须是 JSON 对象字符串，例如 {"module":"ersoft-kratos"}' },
      nodes: { type: 'array', maxItems: 2000, items: NODE_SCHEMA },
      enabled: { type: 'boolean', description: '保留字段：当前不影响 Flow 注册与运行' },
      runTabMode: { type: 'string', maxLength: 100, description: '本 Flow 运行时的默认标签页策略；运行请求未指定 runTabMode 时生效' },
      dataset: { type: 'string', maxLength: 200000, description: '数据驱动运行的数据集，内容必须是 JSON 数组文本；每轮运行以其中一项作为 ctx.data' },
      allowCdpKeepAlive: { type: 'boolean', description: '允许本 Flow 的运行会话保持 CDP 连接' },
      disableKeepAlive: { type: 'boolean', description: 'allowCdpKeepAlive 的反向开关，二者由界面同一选项维护' },
    },
    additionalProperties: false,
  });
  var FLOW_PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      name: FLOW_SCHEMA.properties.name, label: FLOW_SCHEMA.properties.label,
      description: FLOW_SCHEMA.properties.description, inputDescription: FLOW_SCHEMA.properties.inputDescription,
      outputDescription: FLOW_SCHEMA.properties.outputDescription, inputExample: FLOW_SCHEMA.properties.inputExample,
      nodes: FLOW_SCHEMA.properties.nodes, enabled: FLOW_SCHEMA.properties.enabled,
      runTabMode: FLOW_SCHEMA.properties.runTabMode, dataset: FLOW_SCHEMA.properties.dataset,
      allowCdpKeepAlive: FLOW_SCHEMA.properties.allowCdpKeepAlive, disableKeepAlive: FLOW_SCHEMA.properties.disableKeepAlive,
    },
    minProperties: 1, additionalProperties: false,
  });
  var NODE_PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      type: NODE_SCHEMA.properties.type, title: NODE_SCHEMA.properties.title, pageId: NODE_SCHEMA.properties.pageId,
      params: NODE_SCHEMA.properties.params, displayOrder: NODE_SCHEMA.properties.displayOrder,
      outputVar: NODE_SCHEMA.properties.outputVar, onFailure: NODE_SCHEMA.properties.onFailure,
      retries: NODE_SCHEMA.properties.retries, retryDelayMs: NODE_SCHEMA.properties.retryDelayMs,
      requiresForeground: NODE_SCHEMA.properties.requiresForeground, foreground: NODE_SCHEMA.properties.foreground,
      reveal: NODE_SCHEMA.properties.reveal,
    },
    minProperties: 1, additionalProperties: false,
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);
  var VALIDATION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      flowId: { type: 'string' }, valid: { type: 'boolean' },
      errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } },
      nodeCount: { type: 'integer', minimum: 0 }, flowVersion: { type: 'string' },
    },
    required: ['flowId', 'valid', 'errors', 'warnings', 'nodeCount', 'flowVersion'],
    additionalProperties: false,
  });
  var RUN_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      trigger: { type: 'string', maxLength: 300 }, nodeId: { type: 'string', maxLength: 240 },
      context: { type: 'object' }, options: { type: 'object' }, resetContext: { type: 'boolean' },
      entry: { type: 'string', maxLength: 100 },
      ownerTabId: { type: 'integer', minimum: 1 }, originTabId: { type: 'integer', minimum: 1 },
      originWindowId: { type: 'integer', minimum: 0 }, runTabMode: { type: 'string', maxLength: 100 },
      totalRuns: { type: 'integer', minimum: 1 }, maxRetries: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  });

  function method(inputSchema, policy) {
    policy = policy || {};
    return Object.assign({ inputSchema: inputSchema, outputSchema: policy.outputSchema || OBJECT }, policy);
  }

  function route(template, resourceType, relation, summary, methods, aliases, tags) {
    return new arp.RouteContract({
      template: template, resourceType: resourceType, relation: relation, summary: summary,
      aliases: aliases, tags: tags, entryWeights: { flow: 25, 'flow-editor': 35, global: 15 }, methods: methods,
    });
  }

  var FLOW_MUTATION_GUIDANCE = Object.freeze([
    '创建或修改 Flow 只会改变 Flow 资源，不会启动运行。只有用户另行要求执行时，才通过 Flow 的 runs 关系启动。',
    '不要猜测节点类型或参数。/page/clicks、/page/fills、/page/selections、/page/scrolls、/page/waits 和 /page/javascript-executions 的可重放结果会返回可直接复制的 flowNode。',
    '当前操作结果没有可复制的 flowNode 时，使用路径目录披露的 GET /node-types?match=<query>&limit=20 按目标检索真实 nodeType；需要完整节点清单时直接 GET /node-types（不传 limit/cursor），原样使用 items、total、categoryCounts，不自行分类或计数。选定真实 nodeType 后再 GET /node-types/{nodeType} 读取参数和输出合同；不要从名称或旧示例猜 schema。',
    '节点详情中的 params 是节点实例 params 的完整事实源；required/default、kind、options、minimum/maximum、description 和 outputHint 都必须遵守。节点实例公共外壳只使用 Flow 写入 schema 披露的 nodeId、type、title、pageId、params、outputVar、onFailure、retries 等字段；不要发明 edges、connections 或把节点参数放到顶层。',
    'flowNode 使用可在配置页编辑的 clickElement、fillInput、selectOption、scrollPage、waitForCondition 或 executePageJavascript。不要创建 page.click、page.select 等不存在的类型，也不要用 fillFormFields 模拟单个 select。',
    'Agent 返回的未确认动作节点会设置 params.confirmationMode=deferred；它后面必须紧跟同一页面的 waitForCondition 节点，两个节点的 onFailure 都必须为 abort，否则 Flow 校验失败。通过 /page/waits 取得等待节点，不要把未确认候选动作单独当作成功流程。',
    '包含 confirmationMode=deferred 与 waitForCondition 的节点链必须在创建 Flow 时随完整 nodes 一次提交，或通过 Flow 的 PATCH/PUT 原子替换完整 nodes；不要逐节点提交会暂时破坏闭环的中间状态。',
    '只保存完成业务目标的最小节点链，不把能力内省、只读诊断、失败尝试或重复点击写入 Flow。下拉选择使用一个 selectOption 节点表达，不拆成“点击下拉 + 点击选项”，避免开关组件被重复点击。',
    '节点抽象按确定性逐级选择：固定输入、动作和条件使用普通节点；单次语义断言、结构化提取或文本/JSON 生成使用 requestModelAssert、requestModelExtract 或 requestModelAction；只有需要动态观察、工具选择、多轮行动或开放式交付时才使用 runAssistant。',
    '把当前对话沉淀为 Flow 时，以用户原始目标和最终交付物为边界；除有效页面动作外，原任务必需的数据读取、转换、单次模型生成、写作、保存和验证也必须由对应节点表达。Recording 或最后一次页面动作不能替代完整交付链。',
    'Flow 模板按精确路径取值：用户业务入参使用 {{input.xxx}}，流程中间结果使用明确的 outputVar 或顶层变量；{{tabId}} 是系统当前运行标签，不能由用户业务字段或普通变量覆盖。',
    '页面节点必须二选一：指定 pageId 由页面配置认领或打开标签页，或在 params.tabId 中指定运行入口的标签。如果同时提供，pageId 优先。完整 Flow 中节点身份只使用 nodeId，所有动作参数只放在 params。',
    'Agent 返回的 flowNode 没有 pageId 时会尽量带上实际 params.tabId，可在该标签仍存在时立即重放。创建可复用 Flow 时先 GET /pages 复用匹配的 PageSource；没有匹配项再按当前页面 URL POST /pages，把返回的 id 写入相关节点 pageId，并删除临时 tabId。普通页面节点会自行认领或打开 PageSource，不要因为页面绑定再额外添加 openPage。',
    '写入后通过 GET /flows/{flowId}?view=validation 确认 valid=true；无效节点不会被保存或启动。',
  ]);

  var ROUTE_CONTRACTS = Object.freeze([
    route(URI_TEMPLATES.collection, 'FlowCollection', 'flows', '列出或创建可复用的浏览器 Flow', {
      GET: method(PAGE_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['flows.read'],
        preconditions: [], relation: 'flows', summary: '列出 Flow 资源',
      }),
      POST: method(FLOW_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['flows.write'],
        preconditions: [],
        relation: 'flows', summary: '创建一个可校验的 Flow', guidance: FLOW_MUTATION_GUIDANCE,
      }),
    }, ['flow', 'workflow'], ['flow', 'workflow']),
    route(URI_TEMPLATES.item, 'Flow', 'flow', '读取或修改一个 Flow', {
      GET: method(FLOW_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['flows.read'],
        preconditions: [], relation: 'flow', summary: '读取 Flow 或其校验投影',
      }),
      PUT: method(FLOW_SCHEMA, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['flows.write'],
        preconditions: ['if-match'],
        relation: 'flow', summary: '完整替换一个 Flow', guidance: FLOW_MUTATION_GUIDANCE,
      }),
      PATCH: method(FLOW_PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['flows.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'flow', summary: '局部修改一个 Flow', guidance: FLOW_MUTATION_GUIDANCE,
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['flows.delete'],
        preconditions: ['if-match'],
        relation: 'flow', summary: '删除一个 Flow',
      }),
    }, ['flow details', 'validate flow'], ['flow', 'validation']),
    route(URI_TEMPLATES.nodes, 'FlowNodeCollection', 'flow-nodes', '在现有 Flow 中创建一个节点', {
      POST: method(NODE_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['flows.nodes.write'],
        preconditions: ['if-match'],
        relation: 'flow-nodes', summary: '创建一个 Flow 节点', guidance: FLOW_MUTATION_GUIDANCE,
      }),
    }, ['流程节点'], ['flow', 'node']),
    route(URI_TEMPLATES.node, 'FlowNode', 'flow-node', '读取或修改一个 Flow 节点', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['flows.nodes.read'],
        preconditions: [], relation: 'flow-node', summary: '读取一个 Flow 节点',
      }),
      PUT: method(NODE_SCHEMA, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['flows.nodes.write'],
        preconditions: ['if-match'],
        relation: 'flow-node', summary: '完整替换一个 Flow 节点', guidance: FLOW_MUTATION_GUIDANCE,
      }),
      PATCH: method(NODE_PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['flows.nodes.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'flow-node', summary: '局部修改一个 Flow 节点', guidance: FLOW_MUTATION_GUIDANCE,
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['flows.nodes.delete'],
        preconditions: ['if-match'],
        relation: 'flow-node', summary: '删除一个 Flow 节点',
      }),
    }, ['节点', 'debug node'], ['flow', 'node']),
    route(URI_TEMPLATES.runs, 'FlowRunCollection', 'flow-runs', '启动一个 Flow 或单节点 Run', {
      POST: method(RUN_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['runs.execute'],
        preconditions: [],
        relation: 'flow-runs', summary: '创建一个异步 FlowRun',
      }),
    }, ['run flow', 'run node'], ['flow', 'run', 'debug']),
  ]);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function canonicalUri(flowId) {
    return flowId === undefined || flowId === null || flowId === ''
      ? URI_TEMPLATES.collection
      : URI_TEMPLATES.collection + '/' + segment(flowId);
  }

  function createRepresentation(uri, type, data, service) {
    uri = arp.canonicalizeUri(uri);
    var output = {
      uri: uri, type: type, data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
    if (type === 'FlowCollection' || type === 'Flow') {
      output.links.push({ rel: 'node-types', href: '/node-types', method: 'GET' });
      output.links.push({ rel: 'pages', href: '/pages', method: 'GET' });
    }
    if (type === 'Flow') {
      output.links.push({ rel: 'validation', href: uri + '?view=validation', method: 'GET' });
      output.links.push({ rel: 'flow-nodes', href: uri + '/nodes', method: 'POST' });
      output.links.push({ rel: 'runs', href: uri + '/runs', method: 'POST' });
    }
    if (data && service && typeof service.etag === 'function') output.etag = service.etag(data);
    return arp.normalizeRepresentation(output);
  }

  function result(uri, type, data, service, statusCode) {
    return { statusCode: statusCode || 200, primary: createRepresentation(uri, type, data, service), schemaValue: data };
  }

  function asyncRunResult(run, service) {
    var runId = String(run && (run.runId || run.id || run.flowGroupRunId) || '');
    var uri = '/runs/' + segment(runId);
    return {
      statusCode: 202,
      primary: createRepresentation(uri, 'Run', run, service),
      schemaValue: run,
      receipt: { performed: 'yes', operationUri: uri, retryAfterMs: 250, state: 'running' },
    };
  }

  function create(options) {
    options = options || {};
    var service = options.resourceService || options.service;
    if (!service) throw new Error('FlowResource requires an injected resourceService');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET[URI_TEMPLATES.collection] = function (request) {
      return service.listFlows(request.query).then(function (data) { return result(URI_TEMPLATES.collection, 'FlowCollection', data, service); });
    };
    handlers.GET[URI_TEMPLATES.item] = function (request) {
      return service.getFlow(request.params.flowId, request.query).then(function (data) {
        return result(request.uri, request.query && request.query.view === 'validation' ? 'FlowValidation' : 'Flow', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.collection] = function (request) {
      return service.createFlow(request.body).then(function (data) { return result(canonicalUri(data.id), 'Flow', data, service, 201); });
    };
    handlers.POST[URI_TEMPLATES.nodes] = function (request) {
      return service.createFlowNode(request.params.flowId, request.body).then(function (data) {
        return result(request.uri + '/' + segment(data.nodeId), 'FlowNode', data, service, 201);
      });
    };
    handlers.GET[URI_TEMPLATES.node] = function (request) {
      return service.getFlowNode(request.params.flowId, request.params.nodeId).then(function (data) {
        return result(request.uri, 'FlowNode', data, service);
      });
    };
    handlers.PUT[URI_TEMPLATES.node] = function (request) {
      return service.replaceFlowNode(request.params.flowId, request.params.nodeId, request.body).then(function (data) {
        return result(request.uri, 'FlowNode', data, service);
      });
    };
    handlers.PATCH[URI_TEMPLATES.node] = function (request) {
      return service.patchFlowNode(request.params.flowId, request.params.nodeId, request.patch).then(function (data) {
        return result(request.uri, 'FlowNode', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.node] = function (request) {
      return service.deleteFlowNode(request.params.flowId, request.params.nodeId).then(function (data) {
        return result(request.uri, 'DeletedResource', data, service);
      });
    };
    handlers.POST[URI_TEMPLATES.runs] = function (request, context) {
      return service.createFlowRun(request.params.flowId, request.body, context).then(function (data) {
        return asyncRunResult(data, service);
      });
    };
    handlers.PUT[URI_TEMPLATES.item] = function (request) {
      return service.replaceFlow(request.params.flowId, request.body).then(function (data) { return result(request.uri, 'Flow', data, service); });
    };
    handlers.PATCH[URI_TEMPLATES.item] = function (request) {
      return service.patchFlow(request.params.flowId, request.patch).then(function (data) { return result(request.uri, 'Flow', data, service); });
    };
    handlers.DELETE[URI_TEMPLATES.item] = function (request) {
      return service.deleteFlow(request.params.flowId).then(function (data) { return result(request.uri, 'DeletedResource', data, service); });
    };
    Object.keys(handlers).forEach(function (methodName) { Object.freeze(handlers[methodName]); });
    return Object.freeze({
      service: service, routeContracts: ROUTE_CONTRACTS, handlers: Object.freeze(handlers),
      preconditionState: service.preconditionState,
    });
  }

  function createAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'flows', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1,
    URI_TEMPLATES: URI_TEMPLATES,
    METHOD_CONTRACTS: Object.freeze({
      collection: ROUTE_CONTRACTS[0].methods,
      item: ROUTE_CONTRACTS[1].methods,
      nodes: ROUTE_CONTRACTS[2].methods,
      node: ROUTE_CONTRACTS[3].methods,
      runs: ROUTE_CONTRACTS[4].methods,
    }),
    VALIDATION_SCHEMA: VALIDATION_SCHEMA,
    ROUTE_CONTRACTS: ROUTE_CONTRACTS,
    canonicalUri: canonicalUri,
    createRepresentation: createRepresentation,
    createRouteContracts: function () { return ROUTE_CONTRACTS.slice(); },
    create: create,
    createFlowResource: create,
    createAdapter: createAdapter,
  });
});
