// ARP/1 bounded extension configuration index.
(function attachConfigResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  var arp = commonJs ? require('../protocol') : root.AgentResourceProtocol;
  if (!support || !adapter) throw new Error('ConfigResource dependencies are incomplete');
  var api = factory(support, adapter, arp);
  if (commonJs) module.exports = api;
  else root.ConfigResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter, arp) {
  'use strict';
  var EXTENSION_STATUS = {
    type: 'object', properties: {
      currentVersion: { type: 'string', description: '当前运行的插件版本' },
      latestVersion: { type: ['string', 'null'], description: 'GitHub 最新正式版本；检查失败时为 null' },
      updateAvailable: { type: ['boolean', 'null'], description: '是否有新版本；检查失败时为 null' },
      canUpdate: { type: 'boolean', description: '是否可通过当前调用方执行更新' },
      directoryConfigured: { type: ['boolean', 'null'], description: '是否已配置目录；更新进行中或目录读取失败时为 null' }, directoryName: { type: 'string' },
      writePermission: { type: ['string', 'null'] }, directoryVersion: { type: ['string', 'null'] },
      updating: { type: 'boolean' }, reloadRequired: { type: 'boolean' },
      reason: { type: ['string', 'null'], description: '不可更新的原因码；目录授权失效时需在配置页重新授权' },
      message: { type: 'string' }, settingsUrl: { type: 'string' },
    }, required: ['currentVersion', 'latestVersion', 'updateAvailable', 'canUpdate', 'reason', 'message', 'reloadRequired'],
    additionalProperties: false,
  };
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
      template: '/config/extension', resourceType: 'ExtensionUpdateStatus', relation: 'extension-update',
      summary: '检查插件当前版本、最新版本、更新提示与插件目录授权状态',
      aliases: ['插件更新', '版本检查', '最新版本'], tags: ['config', 'extension', 'update'],
      methods: { GET: support.read(support.EMPTY_QUERY, 'config.read', 'extension-update', '检查插件更新；canUpdate 为 true 时可按 latestVersion 更新', EXTENSION_STATUS) },
    }),
    support.route({
      template: '/config/extension/updates', resourceType: 'ExtensionUpdateResult', relation: 'update-extension',
      summary: '更新已配置且已授权的插件目录；完成后需在配置页重新加载插件',
      methods: { POST: support.create({
        type: 'object', properties: { version: { type: 'string', pattern: '^\\d+(?:\\.\\d+){0,3}$', description: 'GET /config/extension 返回的 latestVersion；版本变化时拒绝更新' } },
        required: ['version'], additionalProperties: false,
      }, 'config.write', 'update-extension', '下载并校验指定的最新版本，复用目录授权、增量写入与失败恢复') },
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
    handlers.GET['/config'] = function (request) {
      return service.listConfigSections().then(function (data) {
        var result = support.result(request.uri, 'ConfigIndex', data, service);
        result.primary.links.push({ rel: 'extension-update', href: '/config/extension', method: 'GET' });
        return result;
      });
    };
    handlers.GET['/config/{section}'] = function (request) { return service.getConfigSection(request.params.section).then(function (data) { return support.result(request.uri, 'ConfigSection', data, service); }); };
    handlers.GET['/config/extension'] = async function (request, context) {
      var data = await options.extensionUpdate.getStatus();
      var allowed = !context.allowedRouteMethods || (context.allowedRouteMethods['/config/extension/updates'] || []).includes('POST');
      if (data.canUpdate && (!allowed || !(context.permissionScope || context.permissions || []).includes('config.write'))) {
        data.canUpdate = false; data.reason = 'UPDATE_PERMISSION_REQUIRED'; data.message += '当前调用方未获插件更新写入权限。';
      }
      var result = support.result(request.uri, 'ExtensionUpdateStatus', data, service);
      if (data.canUpdate) result.primary.links.push({ rel: 'update-extension', href: '/config/extension/updates', method: 'POST' });
      return result;
    };
    handlers.POST['/config/extension/updates'] = async function (request, context) {
      try {
        var data = await options.extensionUpdate.update({ version: request.body.version, signal: context.abortSignal });
        return support.result(request.uri, 'ExtensionUpdateResult', data, service, 200, [
          { rel: 'extension-update', href: '/config/extension', method: 'GET' },
        ]);
      } catch (error) {
        throw arp.arpError(error.code || 'UPSTREAM_FAILED', error.message, {
          performed: error.performed || 'unknown', details: { reason: error.reason || 'UPDATE_FAILED', discovery: '/config/extension' },
        });
      }
    };
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
