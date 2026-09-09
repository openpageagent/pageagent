// ARP/1 reusable Script resources.
(function attachScriptResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('ScriptResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.ScriptResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var ROUTES = Object.freeze([
    support.route({
      template: '/scripts', resourceType: 'ScriptCollection', relation: 'scripts', summary: '列出或创建可复用的 Script',
      aliases: ['脚本'], tags: ['script'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        GET: support.read(support.PAGE_QUERY, 'scripts.read', 'scripts', '列出 Script 资源'),
        POST: support.create(support.SCRIPT_RESOURCE, 'scripts.write', 'scripts', '创建一个 Script'),
      },
    }),
    support.route({
      template: '/scripts/{scriptId}', resourceType: 'Script', relation: 'script', summary: '读取或修改一个 Script',
      aliases: ['脚本详情'], tags: ['script'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'scripts.read', 'script', '读取一个 Script'),
        PUT: support.replace(support.SCRIPT_RESOURCE, 'scripts.write', 'script', '完整替换 Script 源码'),
        PATCH: support.patch('scripts.write', 'script', '局部修改 Script 元数据', support.SCRIPT_PATCH),
        DELETE: support.remove('scripts.delete', 'script', '删除一个 Script'),
      },
    }),
    support.route({
      template: '/scripts/{scriptId}/runs', resourceType: 'ScriptRunCollection', relation: 'script-runs', summary: '启动一次 Script Run',
      aliases: ['运行脚本'], tags: ['script', 'run'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        POST: support.create({ type: 'object', properties: { trigger: { type: 'string', maxLength: 300, description: '仅写入 Run 记录的触发标注，不影响脚本执行。' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } }, additionalProperties: false }, 'runs.execute', 'script-runs', '创建一个异步 ScriptRun', { execution: 'async' }),
      },
    }),
  ]);
  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'ScriptResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/scripts'] = function (request) { return service.listScripts(request.query).then(function (data) { return support.result(request.uri, 'ScriptCollection', data, service); }); };
    handlers.GET['/scripts/{scriptId}'] = function (request) { return service.getScript(request.params.scriptId).then(function (data) { return support.result(request.uri, 'Script', data, service); }); };
    handlers.POST['/scripts'] = function (request) { return service.createScript(request.body).then(function (data) { return support.result('/scripts/' + support.segment(data.id), 'Script', data, service, 201); }); };
    handlers.POST['/scripts/{scriptId}/runs'] = function (request) { return service.createScriptRun(request.params.scriptId, request.body).then(function (data) { return support.asyncRunResult(data, service); }); };
    handlers.PUT['/scripts/{scriptId}'] = function (request) { return service.replaceScript(request.params.scriptId, request.body).then(function (data) { return support.result(request.uri, 'Script', data, service); }); };
    handlers.PATCH['/scripts/{scriptId}'] = function (request) { return service.patchScript(request.params.scriptId, request.patch).then(function (data) { return support.result(request.uri, 'Script', data, service); }); };
    handlers.DELETE['/scripts/{scriptId}'] = function (request) { return service.deleteScript(request.params.scriptId).then(function (data) { return support.result(request.uri, 'DeletedResource', data, service); }); };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'scripts', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
