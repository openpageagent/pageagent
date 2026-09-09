// Canonical ARP/1 Run resource contracts.
(function attachRunResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var adapterModule = commonJs ? require('../../resources/resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !adapterModule) throw new Error('ARP and ResourceModuleAdapter must load before RunResource');
  var api = factory(arp, adapterModule);
  if (commonJs) module.exports = api;
  else root.RunResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, ResourceModuleAdapter) {
  'use strict';

  var URI_TEMPLATES = Object.freeze({
    collection: '/runs',
    item: '/runs/{runId}',
    report: '/runs/{runId}/report',
    debugSnapshot: '/runs/{runId}/debug-snapshot',
  });
  var OBJECT = Object.freeze({ type: 'object' });
  var EMPTY_QUERY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var PAGE_QUERY = Object.freeze({
    type: 'object', properties: {
      cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      status: { type: 'string', maxLength: 100 }, flowId: { type: 'string', maxLength: 240 },
    }, additionalProperties: false,
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
  var DELETE_BEFORE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      before: {
        type: 'string',
        minLength: 20,
        maxLength: 40,
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$',
      },
    },
    required: ['before'],
    additionalProperties: false,
  });
  var DELETED_RUN_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, runId: { type: 'string' }, deleted: { const: true }, removed: { type: 'integer', minimum: 1 },
    },
    required: ['id', 'runId', 'deleted', 'removed'],
    additionalProperties: false,
  });
  var RETENTION_RESULT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      before: { type: 'string' }, cutoff: { type: 'integer', minimum: 1 }, removed: { type: 'integer', minimum: 0 },
      activeRunsPreserved: { const: true },
    },
    required: ['before', 'cutoff', 'removed', 'activeRunsPreserved'],
    additionalProperties: false,
  });
  var RUN_EVIDENCE_GUIDANCE = Object.freeze([
    'Run 的状态、结果、report 和 debug-snapshot 是 Flow 是否完成的证据链；资源请求成功不等于业务目标完成。失败时按 runId、nodeId、error 和上游输入定位原因。',
  ]);

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

  var ROUTE_CONTRACTS = Object.freeze([
    route(URI_TEMPLATES.collection, 'RunCollection', 'runs', '读取 Flow、FlowGroup、Schedule、Script 和节点的 Run 历史', {
      GET: method(PAGE_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['runs.read'],
        preconditions: [], relation: 'runs', summary: '列出 Run 资源',
      }),
      DELETE: method(DELETE_BEFORE_SCHEMA, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['runs.delete'],
        preconditions: ['if-match'],
        relation: 'run-retention', summary: '删除早于 ISO-8601 截止时间的终态 Run 历史，同时保留活动 Run',
        outputSchema: RETENTION_RESULT_SCHEMA,
      }),
    }, ['run history'], ['run', 'history']),
    route(URI_TEMPLATES.item, 'Run', 'run', '读取一个 Run 的状态和结果，或删除一条终态历史记录', {
      GET: method(Object.freeze({
        type: 'object',
        properties: {
          includeFinalOutput: { type: 'boolean', description: '包含运行的最终输出结果' },
          includeDebugTrace: { type: 'boolean', description: '包含运行的调试轨迹' },
        },
        additionalProperties: false,
      }), {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['runs.read'],
        preconditions: [], relation: 'run', summary: '读取 Run 状态和结果', guidance: RUN_EVIDENCE_GUIDANCE,
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['runs.delete'],
        preconditions: ['if-match'],
        relation: 'run', summary: '删除一条终态 Run 历史记录；活动 Run 会被拒绝',
        outputSchema: DELETED_RUN_SCHEMA,
      }),
    }, ['run status', 'run result', 'delete run history'], ['run', 'status', 'result', 'history']),
    route(URI_TEMPLATES.report, 'FlowReport', 'run-report', '读取一份稳定的 Flow 报告', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['runs.report.read'],
        preconditions: [], relation: 'run-report', summary: '读取有界的 Run 报告', guidance: RUN_EVIDENCE_GUIDANCE,
      }),
    }, ['flow report'], ['run', 'report']),
    route(URI_TEMPLATES.debugSnapshot, 'RunDebugSnapshot', 'run-debug-snapshot', '读取一份有界且已脱敏的 Run 调试快照', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['runs.debug.read'],
        preconditions: [], relation: 'run-debug-snapshot', summary: '读取 Run 调试状态', guidance: RUN_EVIDENCE_GUIDANCE,
      }),
    }, ['run debug'], ['run', 'debug']),
  ]);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function canonicalRunUri(runId) {
    return runId === undefined || runId === null || runId === ''
      ? URI_TEMPLATES.collection
      : URI_TEMPLATES.collection + '/' + segment(runId);
  }

  function createRepresentation(uri, type, data, service) {
    uri = arp.canonicalizeUri(uri);
    var output = {
      uri: uri, type: type, data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
    if (type === 'Run') {
      output.links.push({ rel: 'report', href: uri + '/report', method: 'GET' });
      output.links.push({ rel: 'debug-snapshot', href: uri + '/debug-snapshot', method: 'GET' });
    }
    if (data && service && typeof service.etag === 'function') output.etag = service.etag(data);
    return arp.normalizeRepresentation(output);
  }

  function result(uri, type, data, service, statusCode) {
    return { statusCode: statusCode || 200, primary: createRepresentation(uri, type, data, service), schemaValue: data };
  }

  function asyncResult(run, service) {
    var runId = String(run && (run.runId || run.id || run.flowGroupRunId) || '');
    var uri = canonicalRunUri(runId);
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
    if (!service) throw new Error('RunResource requires an injected resourceService');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET[URI_TEMPLATES.collection] = function (request) {
      return service.listRuns(request.query).then(function (data) { return result(URI_TEMPLATES.collection, 'RunCollection', data, service); });
    };
    handlers.GET[URI_TEMPLATES.item] = function (request) {
      return service.getRun(request.params.runId, request.query).then(function (data) { return result(request.uri, 'Run', data, service); });
    };
    handlers.GET[URI_TEMPLATES.report] = function (request) {
      return service.getRunReport(request.params.runId).then(function (data) { return result(request.uri, 'FlowReport', data, service); });
    };
    handlers.GET[URI_TEMPLATES.debugSnapshot] = function (request) {
      return service.getRunDebugSnapshot(request.params.runId).then(function (data) { return result(request.uri, 'RunDebugSnapshot', data, service); });
    };
    handlers.DELETE[URI_TEMPLATES.collection] = function (request) {
      return service.deleteRunsBefore(request.body).then(function (data) {
        return result(URI_TEMPLATES.collection, 'RunRetentionResult', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.item] = function (request) {
      return service.deleteRun(request.params.runId).then(function (data) { return result(request.uri, 'DeletedResource', data, service); });
    };
    Object.keys(handlers).forEach(function (methodName) { Object.freeze(handlers[methodName]); });
    return Object.freeze({
      service: service, routeContracts: ROUTE_CONTRACTS, handlers: Object.freeze(handlers),
      preconditionState: service.preconditionState,
    });
  }

  function createAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'runs', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1,
    URI_TEMPLATES: URI_TEMPLATES,
    RUN_INPUT_SCHEMA: RUN_SCHEMA,
    DELETE_BEFORE_SCHEMA: DELETE_BEFORE_SCHEMA,
    METHOD_CONTRACTS: Object.freeze({
      collection: ROUTE_CONTRACTS[0].methods, item: ROUTE_CONTRACTS[1].methods,
      report: ROUTE_CONTRACTS[2].methods, debugSnapshot: ROUTE_CONTRACTS[3].methods,
    }),
    ROUTE_CONTRACTS: ROUTE_CONTRACTS,
    canonicalUri: canonicalRunUri,
    canonicalRunUri: canonicalRunUri,
    createRepresentation: createRepresentation,
    createRouteContracts: function () { return ROUTE_CONTRACTS.slice(); },
    create: create,
    createRunResource: create,
    createAdapter: createAdapter,
  });
});
