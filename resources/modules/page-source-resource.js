// ARP/1 configured Page source resources.
(function attachPageSourceResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('PageSourceResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.PageSourceResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var ROUTES = Object.freeze([
    support.route({
      template: '/pages', resourceType: 'PageSourceCollection', relation: 'pages', summary: '列出或创建已配置的 PageSource',
      aliases: ['页面源'], tags: ['page-source'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        GET: support.read(support.PAGE_QUERY, 'pages.read', 'pages', '列出 PageSource 资源'),
        POST: support.create(support.PAGE_SOURCE_RESOURCE, 'pages.write', 'pages', '创建一个 PageSource'),
      },
    }),
    support.route({
      template: '/pages/{pageId}', resourceType: 'PageSource', relation: 'page-source', summary: '读取、修改或删除一个 PageSource',
      aliases: ['页面配置'], tags: ['page-source'], entryWeights: { flow: 20, 'flow-editor': 30 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'pages.read', 'page-source', '读取一个 PageSource'),
        PATCH: support.patch('pages.write', 'page-source', '局部修改一个 PageSource', support.PAGE_SOURCE_PATCH),
        DELETE: support.remove('pages.delete', 'page-source', '删除一个 PageSource'),
      },
    }),
  ]);
  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'PageSourceResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/pages'] = function (request) { return service.listPages(request.query).then(function (data) { return support.result(request.uri, 'PageSourceCollection', data, service); }); };
    handlers.GET['/pages/{pageId}'] = function (request) { return service.getPage(request.params.pageId).then(function (data) { return support.result(request.uri, 'PageSource', data, service); }); };
    handlers.POST['/pages'] = function (request) { return service.createPage(request.body).then(function (data) { return support.result('/pages/' + support.segment(data.id), 'PageSource', data, service, 201); }); };
    handlers.PATCH['/pages/{pageId}'] = function (request) { return service.patchPage(request.params.pageId, request.patch).then(function (data) { return support.result(request.uri, 'PageSource', data, service); }); };
    handlers.DELETE['/pages/{pageId}'] = function (request) { return service.deletePage(request.params.pageId).then(function (data) { return support.result(request.uri, 'DeletedResource', data, service); }); };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'pages', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
