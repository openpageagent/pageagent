(function attachRecordingResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  var contract = commonJs ? require('../../shared/recording-contract') : root.PageAutomationRecordingContract;
  if (!support || !adapter || !contract) throw new Error('RecordingResource dependencies are incomplete');
  var api = factory(support, adapter, contract);
  if (commonJs) module.exports = api;
  else root.RecordingResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter, contract) {
  'use strict';

  var QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['manifest', 'events', 'search'] },
      fromSeq: { type: 'integer', minimum: 1, description: '本次读取的起始事件序号；必须与 toSeq 同时提供。' },
      toSeq: { type: 'integer', minimum: 1, description: '本次读取的结束事件序号；必须与 fromSeq 同时提供。' },
      cursor: { type: 'string', maxLength: 4096 },
      tab: { type: 'string', maxLength: 128, description: 'Recording 标签页别名，例如 T1；绝不是 Chrome tabId。' },
      kinds: {
        oneOf: [
          { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
          {
            type: 'array', maxItems: 32, uniqueItems: true,
            items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
          },
        ],
      },
      fromMs: { type: 'integer', minimum: 0 },
      toMs: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: contract.LIMITS.MAX_EVENTS_LIMIT },
      maxChars: { type: 'integer', minimum: 256, maximum: contract.LIMITS.MAX_RESPONSE_CHARS },
      seq: { type: 'integer', minimum: 1 },
      field: { type: 'string', minLength: 1, maxLength: 256 },
      start: { type: 'integer', minimum: 0 },
      q: { type: 'string', minLength: 1, maxLength: contract.LIMITS.MAX_SEARCH_QUERY },
      context: { type: 'integer', minimum: 0, maximum: 5 },
    },
    anyOf: [
      { required: ['fromSeq', 'toSeq'] },
      { properties: { fromSeq: false, toSeq: false } },
    ],
    additionalProperties: false,
  });
  var RECORDING_GUIDANCE = Object.freeze([
    'Recording 正文不会内联。只能读取 runtime_context.recordingContext 中列出的、已授权给本次生成的规范 recordingUri；绝不枚举或读取无关 Recording。',
    'selectedRanges 表示默认关注范围，不是读取上限。任务需要更多上下文时，可以读取同一已授权 recordingUri 的其他范围。',
    '根据 Recording 创建或修改 Flow 前，先用 GET 读取任务所需的事件投影；不要根据句柄元数据或统计信息推断事件。',
    'recording_start 事件表示录制开始时已存在的起始页，只提供初始页面上下文，不是需要重放的页面操作。兼容旧 Artifact 时，disposition=baseline 或 baseline=true 的 tab_created 含义相同。T1、T2 等 Recording 别名不是 Chrome tabId。',
    'Recording 可能同时包含人工操作，以及由 Conversation、Flow、schedule、MCP、plugin 或其他自动化产生的操作。按观测顺序保留证据；不要根据 isTrusted、actor 或猜测的来源丢弃证据。',
    'Recording 的 seq 定义顺序，t 只表示相对时间。不要把人工停顿转换成 sleep；构建 Flow 时，应把导航影响转换成条件或断言。',
    'Recording 只能证明可观测的页面操作，不能证明完整工作流边界。应根据用户请求和已完成对话推导 Flow 目标，并补上时间线中缺少但任务必需的读取、提取、转换、模型处理、写入或保存步骤。',
    '多个 Recording 的附件顺序不代表时间因果，事件也不能机械地逐一映射成 Flow 节点。写入 Flow 前，确认它的输入、稳定步骤、条件等待、最终输出和完成检查能够独立满足原始目标。',
  ]);
  var ROUTES = Object.freeze([
    support.route({
      template: '/recordings/{recordingId}',
      resourceType: 'PageActionRecording', relation: 'recording',
      summary: '读取已授权且不可变的页面操作 Recording 清单、事件范围或搜索投影',
      aliases: ['page recording', '页面操作录制'], tags: ['recording', 'page-action'],
      entryWeights: { conversation: 40, page: 25, global: 5 },
      methods: {
        GET: support.method(QUERY_SCHEMA, {
          permissions: ['recordings.read'], relation: 'recording',
          summary: '读取一个已授权给本次生成的 Recording', guidance: RECORDING_GUIDANCE,
        }),
      },
    }),
  ]);

  function create(options) {
    var service = support.injectedService(options, 'recordingService', 'RecordingResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/recordings/{recordingId}'] = function (request, context) {
      return service.getRecording(request.params.recordingId, request.query, context).then(function (projection) {
        return support.result(
          projection.uri, projection.type, projection.data, service, 200, projection.links
        );
      });
    };
    return { service: service, routeContracts: ROUTES, handlers: handlers };
  }
  function createAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'recordings', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1, QUERY_SCHEMA: QUERY_SCHEMA, RECORDING_GUIDANCE: RECORDING_GUIDANCE, ROUTE_CONTRACTS: ROUTES,
    create: create, createAdapter: createAdapter,
  });
});
