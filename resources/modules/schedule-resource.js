// Canonical ARP/1 Schedule resource contracts.
(function attachScheduleResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var runModule = commonJs ? require('./run-resource') : root.RunResource;
  var adapterModule = commonJs ? require('../../resources/resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !runModule || !adapterModule) throw new Error('ScheduleResource dependencies are incomplete');
  var api = factory(arp, runModule, adapterModule);
  if (commonJs) module.exports = api;
  else root.ScheduleResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, RunResource, ResourceModuleAdapter) {
  'use strict';

  var URI_TEMPLATES = Object.freeze({
    collection: '/schedules',
    item: '/schedules/{scheduleId}',
    runs: '/schedules/{scheduleId}/runs',
  });
  var OBJECT = Object.freeze({ type: 'object' });
  var TRIGGER_SCHEMA = Object.freeze({
    oneOf: [
      { type: 'object', properties: { kind: { const: 'interval' }, minutes: { type: 'integer', minimum: 1 } }, required: ['kind', 'minutes'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'daily' }, time: { type: 'string', minLength: 5, maxLength: 5, pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$', description: '24 小时制 HH:mm' } }, required: ['kind', 'time'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'cron' }, expression: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['kind', 'expression'], additionalProperties: false },
    ],
  });
  var TRIGGER_PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['interval', 'daily', 'cron'] }, minutes: { type: 'integer', minimum: 1 },
      time: { type: 'string', minLength: 5, maxLength: 5, pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$', description: '24 小时制 HH:mm' },
      expression: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    minProperties: 1, additionalProperties: false,
  });
  // 立即运行的 trigger 与 entry 由 Schedule 决定并被服务端覆盖，因此不在输入面。
  var SCHEDULE_RUN_INPUT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      nodeId: { type: 'string', maxLength: 240, description: '仅 flow 目标：只运行该节点' },
      context: { type: 'object' }, options: { type: 'object' }, resetContext: { type: 'boolean' },
      ownerTabId: { type: 'integer', minimum: 1 }, originTabId: { type: 'integer', minimum: 1 },
      originWindowId: { type: 'integer', minimum: 0 },
      totalRuns: { type: 'integer', minimum: 1, description: '仅 flow 目标生效' },
      maxRetries: { type: 'integer', minimum: 0, description: '仅 flow 目标生效' },
    },
    additionalProperties: false,
  });
  var SCHEDULE_PROPERTIES = Object.freeze({
    id: { type: 'string', maxLength: 240 }, label: { type: 'string', maxLength: 300 }, enabled: { type: 'boolean' },
    taskType: { type: 'string', enum: ['flow', 'flowGroup', 'conversation'] },
    flowId: { type: 'string', maxLength: 240 }, flowGroupId: { type: 'string', maxLength: 240 },
    assistantId: { type: 'string', maxLength: 240 }, message: { type: 'string', maxLength: 200000 },
    trigger: TRIGGER_SCHEMA,
  });
  function scheduleSchema(taskType, requiredProperties) {
    var properties = Object.assign({}, SCHEDULE_PROPERTIES);
    properties.taskType = { const: taskType };
    requiredProperties.forEach(function (key) {
      if (key === 'flowId' || key === 'flowGroupId' || key === 'assistantId') {
        properties[key] = { type: 'string', minLength: 1, maxLength: 240 };
      } else if (key === 'message') {
        properties.message = { type: 'string', minLength: 1, maxLength: 200000 };
      }
    });
    return Object.freeze({
      type: 'object', properties: properties,
      required: ['taskType', 'trigger'].concat(requiredProperties), additionalProperties: false,
    });
  }
  var SCHEDULE_SCHEMA = Object.freeze({
    oneOf: [
      scheduleSchema('flow', ['flowId']),
      scheduleSchema('flowGroup', ['flowGroupId']),
      scheduleSchema('conversation', ['assistantId', 'message']),
    ],
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      label: SCHEDULE_PROPERTIES.label, enabled: SCHEDULE_PROPERTIES.enabled,
      taskType: SCHEDULE_PROPERTIES.taskType, flowId: SCHEDULE_PROPERTIES.flowId,
      flowGroupId: SCHEDULE_PROPERTIES.flowGroupId, assistantId: SCHEDULE_PROPERTIES.assistantId,
      message: SCHEDULE_PROPERTIES.message, trigger: TRIGGER_PATCH_SCHEMA,
    },
    minProperties: 1, additionalProperties: false,
  });
  var EMPTY_QUERY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  var PAGE_QUERY = Object.freeze({
    type: 'object', properties: {
      cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, additionalProperties: false,
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);

  function method(inputSchema, policy) {
    return Object.assign({ inputSchema: inputSchema, outputSchema: OBJECT }, policy);
  }

  function route(template, resourceType, relation, summary, methods, aliases, tags) {
    return new arp.RouteContract({
      template: template, resourceType: resourceType, relation: relation, summary: summary,
      aliases: aliases, tags: tags, entryWeights: { flow: 25, 'flow-editor': 35, global: 15 }, methods: methods,
    });
  }

  var ROUTE_CONTRACTS = Object.freeze([
    route(URI_TEMPLATES.collection, 'ScheduleCollection', 'schedules', '列出或创建 Schedule 资源', {
      GET: method(PAGE_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['schedules.read'],
        preconditions: [], relation: 'schedules', summary: '列出 Schedule',
      }),
      POST: method(SCHEDULE_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['schedules.write'],
        preconditions: [],
        relation: 'schedules', summary: '创建一个已校验的 Schedule',
      }),
    }, ['scheduled task'], ['schedule', 'cron']),
    route(URI_TEMPLATES.item, 'Schedule', 'schedule', '读取、修改或删除一个 Schedule', {
      GET: method(EMPTY_QUERY, {
        safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['schedules.read'],
        preconditions: [], relation: 'schedule', summary: '读取一个 Schedule',
      }),
      PATCH: method(PATCH_SCHEMA, {
        safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['schedules.write'],
        preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
        relation: 'schedule', summary: '局部修改一个 Schedule',
      }),
      DELETE: method(null, {
        safety: 'write', idempotency: 'inherent', execution: 'sync', permissions: ['schedules.delete'],
        preconditions: ['if-match'],
        relation: 'schedule', summary: '删除一个 Schedule',
      }),
    }, ['schedule configuration'], ['schedule', 'cron']),
    route(URI_TEMPLATES.runs, 'ScheduleRunCollection', 'schedule-runs', '立即运行一个 Schedule 的目标任务', {
      POST: method(SCHEDULE_RUN_INPUT_SCHEMA, {
        safety: 'execute', idempotency: 'keyed', execution: 'async', permissions: ['runs.execute'],
        preconditions: [],
        relation: 'schedule-runs', summary: '创建一个异步 Schedule Run',
        guidance: [
          '本次运行的 trigger 与 entry 由 Schedule 决定，请求不接受这两个字段。',
          'taskType=conversation 的 Schedule 当前只按定时触发执行，不支持通过本路由立即运行。',
        ],
      }),
    }, ['run schedule now'], ['schedule', 'run']),
  ]);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function canonicalUri(scheduleId) {
    return scheduleId === undefined || scheduleId === null || scheduleId === ''
      ? URI_TEMPLATES.collection
      : URI_TEMPLATES.collection + '/' + segment(scheduleId);
  }

  function createRepresentation(uri, type, data, service) {
    uri = arp.canonicalizeUri(uri);
    var output = {
      uri: uri, type: type, data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }, { rel: 'capabilities', href: uri, method: 'OPTIONS' }],
    };
    if (type === 'Schedule') output.links.push({ rel: 'runs', href: uri + '/runs', method: 'POST' });
    if (data && service && typeof service.etag === 'function') output.etag = service.etag(data);
    return arp.normalizeRepresentation(output);
  }

  function result(uri, type, data, service, statusCode) {
    return { statusCode: statusCode || 200, primary: createRepresentation(uri, type, data, service), schemaValue: data };
  }

  function runResult(run, service) {
    var runId = String(run && (run.runId || run.id || run.flowGroupRunId) || '');
    var uri = RunResource.canonicalRunUri(runId);
    return {
      statusCode: 202,
      primary: RunResource.createRepresentation(uri, 'Run', run, service),
      schemaValue: run,
      receipt: { performed: 'yes', operationUri: uri, retryAfterMs: 250, state: 'running' },
    };
  }

  function create(options) {
    options = options || {};
    var service = options.resourceService || options.service;
    if (!service) throw new Error('ScheduleResource requires an injected resourceService');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET[URI_TEMPLATES.collection] = function (request) {
      return service.listSchedules(request.query).then(function (data) { return result(URI_TEMPLATES.collection, 'ScheduleCollection', data, service); });
    };
    handlers.GET[URI_TEMPLATES.item] = function (request) {
      return service.getSchedule(request.params.scheduleId).then(function (data) { return result(request.uri, 'Schedule', data, service); });
    };
    handlers.POST[URI_TEMPLATES.collection] = function (request) {
      return service.createSchedule(request.body).then(function (data) { return result(canonicalUri(data.id), 'Schedule', data, service, 201); });
    };
    handlers.POST[URI_TEMPLATES.runs] = function (request, context) {
      return service.createScheduleRun(request.params.scheduleId, request.body, context).then(function (data) { return runResult(data, service); });
    };
    handlers.PATCH[URI_TEMPLATES.item] = function (request) {
      return service.patchSchedule(request.params.scheduleId, request.patch).then(function (data) {
        return result(request.uri, 'Schedule', data, service);
      });
    };
    handlers.DELETE[URI_TEMPLATES.item] = function (request) {
      return service.deleteSchedule(request.params.scheduleId).then(function (data) { return result(request.uri, 'DeletedResource', data, service); });
    };
    Object.keys(handlers).forEach(function (methodName) { Object.freeze(handlers[methodName]); });
    return Object.freeze({
      service: service, routeContracts: ROUTE_CONTRACTS, handlers: Object.freeze(handlers),
      preconditionState: service.preconditionState,
    });
  }

  function createAdapter(options) {
    return ResourceModuleAdapter.create({ root: 'schedules', resource: create(options) });
  }

  return Object.freeze({
    API_VERSION: 1,
    URI_TEMPLATES: URI_TEMPLATES,
    METHOD_CONTRACTS: Object.freeze({
      collection: ROUTE_CONTRACTS[0].methods, item: ROUTE_CONTRACTS[1].methods, runs: ROUTE_CONTRACTS[2].methods,
    }),
    ROUTE_CONTRACTS: ROUTE_CONTRACTS,
    canonicalUri: canonicalUri,
    createRepresentation: createRepresentation,
    createRouteContracts: function () { return ROUTE_CONTRACTS.slice(); },
    create: create,
    createScheduleResource: create,
    createAdapter: createAdapter,
  });
});
