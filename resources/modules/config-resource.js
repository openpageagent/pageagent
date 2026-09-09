// ARP/1 bounded extension configuration index.
(function attachConfigResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('ConfigResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.ConfigResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var ROUTES = Object.freeze([
    support.route({
      template: '/config', resourceType: 'ConfigIndex', relation: 'config', summary: '读取扩展配置分区索引',
      aliases: ['配置'], tags: ['config'], entryWeights: { global: 20, options: 30 },
      methods: { GET: support.read(support.EMPTY_QUERY, 'config.read', 'config', '列出有界的配置分区元数据') },
    }),
    support.route({
      template: '/config/{section}', resourceType: 'ConfigSection', relation: 'config-section', summary: '读取一个白名单配置分区',
      aliases: ['配置分区'], tags: ['config'], entryWeights: { global: 20, options: 30 },
      methods: { GET: support.read(support.EMPTY_QUERY, 'config.read', 'config-section', '读取一个配置分区') },
    }),
  ]);
  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'ConfigResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/config'] = function (request) { return service.listConfigSections().then(function (data) { return support.result(request.uri, 'ConfigIndex', data, service); }); };
    handlers.GET['/config/{section}'] = function (request) { return service.getConfigSection(request.params.section).then(function (data) { return support.result(request.uri, 'ConfigSection', data, service); }); };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'config', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
