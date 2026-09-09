// ARP/1 URL Trigger resources.
(function attachUrlTriggerResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('UrlTriggerResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.UrlTriggerResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var ROUTES = Object.freeze([
    support.route({
      template: '/url-triggers', resourceType: 'UrlTriggerCollection', relation: 'url-triggers', summary: '列出或创建 URL Trigger 资源',
      aliases: ['URL触发器'], tags: ['url-trigger'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        GET: support.read(support.PAGE_QUERY, 'url-triggers.read', 'url-triggers', '列出 URL Trigger'),
        POST: support.create(support.URL_TRIGGER_RESOURCE, 'url-triggers.write', 'url-triggers', '创建一个 URL Trigger'),
      },
    }),
    support.route({
      template: '/url-triggers/{triggerId}', resourceType: 'UrlTrigger', relation: 'url-trigger', summary: '读取或修改一个 URL Trigger',
      aliases: ['URL触发配置'], tags: ['url-trigger'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'url-triggers.read', 'url-trigger', '读取一个 URL Trigger'),
        PUT: support.replace(support.URL_TRIGGER_RESOURCE, 'url-triggers.write', 'url-trigger', '完整替换一个 URL Trigger'),
        PATCH: support.patch('url-triggers.write', 'url-trigger', '局部修改一个 URL Trigger', support.URL_TRIGGER_PATCH),
        DELETE: support.remove('url-triggers.delete', 'url-trigger', '删除一个 URL Trigger'),
      },
    }),
  ]);
  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'UrlTriggerResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/url-triggers'] = function (request) { return service.listUrlTriggers(request.query).then(function (data) { return support.result(request.uri, 'UrlTriggerCollection', data, service); }); };
    handlers.GET['/url-triggers/{triggerId}'] = function (request) { return service.getUrlTrigger(request.params.triggerId).then(function (data) { return support.result(request.uri, 'UrlTrigger', data, service); }); };
    handlers.POST['/url-triggers'] = function (request) { return service.createUrlTrigger(request.body).then(function (data) { return support.result('/url-triggers/' + support.segment(data.id), 'UrlTrigger', data, service, 201); }); };
    handlers.PUT['/url-triggers/{triggerId}'] = function (request) { return service.replaceUrlTrigger(request.params.triggerId, request.body).then(function (data) { return support.result(request.uri, 'UrlTrigger', data, service); }); };
    handlers.PATCH['/url-triggers/{triggerId}'] = function (request) { return service.patchUrlTrigger(request.params.triggerId, request.patch).then(function (data) { return support.result(request.uri, 'UrlTrigger', data, service); }); };
    handlers.DELETE['/url-triggers/{triggerId}'] = function (request) { return service.deleteUrlTrigger(request.params.triggerId).then(function (data) { return support.result(request.uri, 'DeletedResource', data, service); }); };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'url-triggers', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
