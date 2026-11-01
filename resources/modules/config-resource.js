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
    support.route({
      template: '/config/deployment', resourceType: 'ConfigurationDeployment', relation: 'configuration-deployment', summary: '读取同步协商、当前连接策略和本次浏览器启动状态',
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'config.read', 'configuration-deployment', '读取同步和备份状态'),
      },
    }),
    support.route({
      template: '/config/backup', resourceType: 'Backup', relation: 'backup', summary: '已配置的连接读取备份内容',
      methods: { GET: support.read(support.EMPTY_QUERY, 'config.read', 'backup', '导出配置；不包含连接身份、模型密钥或对话数据') },
    }),
    support.route({
      template: '/config/restorations', resourceType: 'ConfigurationRestoration', relation: 'configuration-restorations', summary: '自动同步源或获得手动授权的连接强制同步版本并持久化资源归属',
      methods: { POST: {
        inputSchema: { type: 'object', additionalProperties: false, required: ['operationId', 'bucketId', 'versionId', 'expectedFingerprint', 'backup'], properties: {
          operationId: { type: 'string' }, bucketId: { type: 'string' }, versionId: { type: 'string' },
          expectedFingerprint: { type: 'string' }, backup: { type: 'object' }, bootId: { type: 'string' },
        } }, outputSchema: { type: 'object' }, safety: 'write', idempotency: 'keyed', execution: 'sync', permissions: ['config.write'], preconditions: [],
      } },
    }),
  ]);
  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'ConfigResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/config'] = function (request) { return service.listConfigSections().then(function (data) { return support.result(request.uri, 'ConfigIndex', data, service); }); };
    handlers.GET['/config/{section}'] = function (request) { return service.getConfigSection(request.params.section).then(function (data) { return support.result(request.uri, 'ConfigSection', data, service); }); };
    handlers.GET['/config/deployment'] = async function (request, context) {
      return support.result(request.uri, 'ConfigurationDeployment', await options.archiveService.remoteStatus(context), service);
    };
    handlers.GET['/config/backup'] = async function (request, context) {
      return support.result(request.uri, 'Backup', await options.archiveService.capture(context), service);
    };
    handlers.POST['/config/restorations'] = async function (request, context) {
      return support.result(request.uri, 'ConfigurationRestoration', await options.archiveService.apply(request.body, context), service);
    };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'config', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
