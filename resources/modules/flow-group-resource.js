// ARP/1 FlowGroup resources.
(function attachFlowGroupResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('FlowGroupResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.FlowGroupResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var RUN_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      trigger: { type: 'string', maxLength: 300 }, context: { type: 'object' }, options: { type: 'object' },
      entry: { type: 'string', maxLength: 100 },
      ownerTabId: { type: 'integer', minimum: 1 }, originTabId: { type: 'integer', minimum: 1 },
      originWindowId: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  });
  var FLOW_GROUP_GUIDANCE = Object.freeze([
    'FlowGroup 只按 flowId 组合已保存的 Flow，不嵌入 FlowNode。被引用的基础 Flow 未完成验证时，不能把 FlowGroup 视为可靠复用链路。',
  ]);
  var ROUTES = Object.freeze([
    support.route({
      template: '/flow-groups', resourceType: 'FlowGroupCollection', relation: 'flow-groups',
      summary: '列出或创建 FlowGroup', aliases: ['流程组'], tags: ['flow-group'],
      entryWeights: { flow: 25, 'flow-editor': 35 },
      guidance: FLOW_GROUP_GUIDANCE,
      methods: {
        GET: support.read(support.PAGE_QUERY, 'flow-groups.read', 'flow-groups', '列出 FlowGroup 资源'),
        POST: support.create(support.FLOW_GROUP_RESOURCE, 'flow-groups.write', 'flow-groups', '创建一个 FlowGroup'),
      },
    }),
    support.route({
      template: '/flow-groups/{groupId}', resourceType: 'FlowGroup', relation: 'flow-group',
      summary: '读取或修改一个 FlowGroup', aliases: ['流程组详情'], tags: ['flow-group'],
      entryWeights: { flow: 25, 'flow-editor': 35 },
      guidance: FLOW_GROUP_GUIDANCE,
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'flow-groups.read', 'flow-group', '读取一个 FlowGroup'),
        PUT: support.replace(support.FLOW_GROUP_RESOURCE, 'flow-groups.write', 'flow-group', '完整替换一个 FlowGroup'),
        PATCH: support.patch('flow-groups.write', 'flow-group', '局部修改一个 FlowGroup', support.FLOW_GROUP_PATCH),
        DELETE: support.remove('flow-groups.delete', 'flow-group', '删除一个 FlowGroup'),
      },
    }),
    support.route({
      template: '/flow-groups/{groupId}/runs', resourceType: 'FlowGroupRunCollection', relation: 'flow-group-runs',
      summary: '启动一次 FlowGroup Run', aliases: ['运行流程组'], tags: ['flow-group', 'run'],
      entryWeights: { flow: 25, 'flow-editor': 35 },
      guidance: FLOW_GROUP_GUIDANCE,
      methods: {
        POST: support.create(RUN_SCHEMA, 'runs.execute', 'flow-group-runs', '创建一个异步 GroupRun', { execution: 'async' }),
      },
    }),
  ]);

  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'FlowGroupResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/flow-groups'] = function (request) { return service.listFlowGroups(request.query).then(function (data) { return support.result(request.uri, 'FlowGroupCollection', data, service); }); };
    handlers.GET['/flow-groups/{groupId}'] = function (request) { return service.getFlowGroup(request.params.groupId).then(function (data) { return support.result(request.uri, 'FlowGroup', data, service); }); };
    handlers.POST['/flow-groups'] = function (request) { return service.createFlowGroup(request.body).then(function (data) { return support.result('/flow-groups/' + support.segment(data.id), 'FlowGroup', data, service, 201); }); };
    handlers.POST['/flow-groups/{groupId}/runs'] = function (request, context) { return service.createFlowGroupRun(request.params.groupId, request.body, context).then(function (data) { return support.asyncRunResult(data, service); }); };
    handlers.PUT['/flow-groups/{groupId}'] = function (request) { return service.replaceFlowGroup(request.params.groupId, request.body).then(function (data) { return support.result(request.uri, 'FlowGroup', data, service); }); };
    handlers.PATCH['/flow-groups/{groupId}'] = function (request) { return service.patchFlowGroup(request.params.groupId, request.patch).then(function (data) { return support.result(request.uri, 'FlowGroup', data, service); }); };
    handlers.DELETE['/flow-groups/{groupId}'] = function (request) { return service.deleteFlowGroup(request.params.groupId).then(function (data) { return support.result(request.uri, 'DeletedResource', data, service); }); };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }

  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'flow-groups', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
