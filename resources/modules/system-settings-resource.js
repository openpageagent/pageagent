// ARP/1 extension system settings, saved through the shared network configuration path.
(function attachSystemSettingsResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('SystemSettingsResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.SystemSettingsResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var PROPERTIES = Object.freeze({
    floatingEntryDisabled: { type: 'boolean', description: '是否隐藏网页上的悬浮入口' },
    userAgent: { type: 'string', maxLength: 512, description: '用于流程 HTTP 请求、资源下载和 MCP 连接；留空时使用浏览器默认值' },
    proxyServer: { type: 'string', maxLength: 2048, description: '浏览器代理，支持 HTTP / SOCKS5，作用于网页、模型和 MCP 连接；留空关闭系统代理' },
    proxyUsername: { type: 'string', maxLength: 1024, description: 'HTTP / HTTPS 代理用户名，SOCKS 代理不支持用户名密码认证' },
    proxyHostPatterns: { type: 'string', maxLength: 8192, description: '匹配域名，逗号或换行分隔，支持通配符；留空匹配全部' },
    proxyBypassList: { type: 'string', maxLength: 8192, description: '绕过域名，逗号或换行分隔，支持通配符及 <local>' },
  });
  var SETTINGS_SCHEMA = Object.freeze({
    type: 'object', properties: Object.assign({ proxyPasswordConfigured: { type: 'boolean' } }, PROPERTIES),
    required: Object.keys(PROPERTIES).concat(['proxyPasswordConfigured']), additionalProperties: false,
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object', properties: Object.assign({
      proxyPassword: { type: 'string', maxLength: 1024, description: '代理密码；省略保留原密码，空字符串清除，响应不返回密码' },
    }, PROPERTIES), minProperties: 1, additionalProperties: false,
  });
  var ROUTES = Object.freeze([
    support.route({
      template: '/system-settings', resourceType: 'SystemSettings', relation: 'system-settings',
      summary: '读取或修改系统配置：网页悬浮入口、User-Agent 与浏览器代理',
      aliases: ['系统设置', '系统配置', 'User-Agent', '代理', '悬浮入口'], tags: ['settings', 'system'],
      entryWeights: { global: 20, 'system-settings': 35 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'system-settings.read', 'system-settings', '读取系统配置', SETTINGS_SCHEMA),
        PATCH: support.patch('system-settings.write', 'system-settings', '局部修改并立即应用系统配置', PATCH_SCHEMA, SETTINGS_SCHEMA),
      },
    }),
  ]);

  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'SystemSettingsResource');
    var settings = options.systemSettings;
    if (!settings || typeof settings.load !== 'function' || typeof options.saveSystemSettings !== 'function') {
      throw new Error('SystemSettingsResource requires systemSettings and saveSystemSettings');
    }
    function load() { return settings.load(options.storageArea, options.chrome && options.chrome.runtime); }
    var previousConfig;
    var version;
    function snapshot(data) {
      var serialized = JSON.stringify(data);
      if (serialized !== previousConfig) {
        previousConfig = serialized;
        version = '"system-' + crypto.randomUUID() + '"';
      }
      var output = { proxyPasswordConfigured: !!data.proxyPassword };
      Object.keys(PROPERTIES).forEach(function (key) { output[key] = data[key]; });
      return { data: output, etag: version };
    }
    function result(uri, data) {
      var state = snapshot(data);
      var output = support.result(uri, 'SystemSettings', state.data, service);
      output.primary.etag = state.etag;
      return output;
    }
    var handlers = { GET: {}, PATCH: {} };
    handlers.GET['/system-settings'] = function (request) {
      return load().then(function (data) { return result(request.uri, data); });
    };
    handlers.PATCH['/system-settings'] = function (request) {
      return load().then(function (current) {
        return options.saveSystemSettings(service.applyPatch(current, request.patch));
      }).then(function (data) { return result(request.uri, data); });
    };
    return {
      service: service, routeContracts: ROUTES, handlers: handlers,
      preconditionState: function () {
        return load().then(function (data) { return { exists: true, etag: snapshot(data).etag }; });
      },
    };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'system-settings', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
