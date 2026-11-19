// ARP/1 server mail account references and test delivery.
(function attachMailSettingsResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  var settings = commonJs ? require('../../settings/mail-settings') : root.PageAgentMailSettings;
  if (!arp || !support || !adapter || !settings) throw new Error('MailSettingsResource dependencies are incomplete');
  var api = factory(arp, support, adapter, settings);
  if (commonJs) module.exports = api;
  else root.MailSettingsResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, support, ResourceModuleAdapter, settings) {
  'use strict';
  var PUBLIC_PROPERTIES = Object.freeze({
    connectionId: { type: 'string', maxLength: 200 },
    accountId: { type: 'string', maxLength: 200 }, enabled: { type: 'boolean' },
  });
  var SETTINGS_SCHEMA = Object.freeze({
    type: 'object', properties: PUBLIC_PROPERTIES,
    required: Object.keys(PUBLIC_PROPERTIES), additionalProperties: false,
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object', properties: PUBLIC_PROPERTIES, minProperties: 1, additionalProperties: false,
  });
  var STATUS_SCHEMA = Object.freeze({
    type: 'object', properties: { enabled: { type: 'boolean' }, connected: { type: 'boolean' }, supported: { type: 'boolean' }, connectionId: { type: 'string' }, accountId: { type: 'string' }, reason: { type: ['string', 'null'] } },
    required: ['enabled', 'connected', 'supported'], additionalProperties: false,
  });
  var TEST_SCHEMA = Object.freeze({
    type: 'object', properties: { to: { type: 'string', minLength: 1, maxLength: 254, description: '接收测试邮件的邮箱' } },
    required: ['to'], additionalProperties: false,
  });
  var DELIVERY_SCHEMA = Object.freeze({
    type: 'object', properties: {
      messageId: { type: 'string' }, acceptedCount: { type: 'integer', minimum: 1 }, rejectedCount: { const: 0 },
      audit: { type: 'object' }, target: { type: 'object' }, transportSessionId: { type: 'string' }, requestId: { type: 'string' },
    }, required: ['messageId', 'acceptedCount', 'rejectedCount'], additionalProperties: false,
  });
  var ROUTES = Object.freeze([
    support.route({
      template: '/mail-settings', resourceType: 'MailSettings', relation: 'mail-settings',
      summary: '读取或修改邮件通知开关与服务端邮件账号引用；凭据在服务端配置',
      aliases: ['邮件配置', 'SMTP', '邮件通知'], tags: ['settings', 'mail'], entryWeights: { mcp: 35, global: 20 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'mail-settings.read', 'mail-settings', '读取服务端连接及账号引用', SETTINGS_SCHEMA),
        PATCH: support.patch('mail-settings.write', 'mail-settings', '局部修改邮件账号引用', PATCH_SCHEMA, SETTINGS_SCHEMA),
      },
    }),
    support.route({
      template: '/mail-settings/status', resourceType: 'MailStatus', relation: 'mail-status',
      summary: '读取邮件开关及已连接服务端的邮件支持状态', tags: ['mail', 'status'],
      methods: { GET: support.read(support.EMPTY_QUERY, 'mail-settings.read', 'mail-status', '读取邮件服务状态', STATUS_SCHEMA) },
    }),
    support.route({
      template: '/mail-settings/test-send', resourceType: 'MailTestDelivery', relation: 'mail-test-send',
      summary: '使用已绑定的服务端邮件账号实际发送测试邮件；须已启用邮件并连接服务端',
      aliases: ['测试邮件'], tags: ['mail', 'test'],
      methods: { POST: support.create(TEST_SCHEMA, 'mail-settings.execute', 'mail-test-send', '实际发送测试邮件', {
        safety: 'execute', outputSchema: DELIVERY_SCHEMA,
      }) },
    }),
  ]);

  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'MailSettingsResource');
    var client = support.injectedService(options, 'mailClient', 'MailSettingsResource');
    var previousConfig;
    var version;
    function snapshot(config) {
      var serialized = JSON.stringify(config);
      // A runtime restart requires a fresh GET.
      if (serialized !== previousConfig) {
        previousConfig = serialized;
        version = '"mail-' + crypto.randomUUID() + '"';
      }
      var data = {};
      Object.keys(PUBLIC_PROPERTIES).forEach(function (key) { data[key] = config[key]; });
      return { data: data, etag: version };
    }
    function result(config) {
      var state = snapshot(config);
      var output = support.result('/mail-settings', 'MailSettings', state.data, null, 200, [
        { rel: 'self', href: '/mail-settings', method: 'GET' },
        { rel: 'capabilities', href: '/mail-settings', method: 'OPTIONS' },
        { rel: 'status', href: '/mail-settings/status', method: 'GET' },
        { rel: 'test-send', href: '/mail-settings/test-send', method: 'POST' },
      ]);
      output.primary.etag = state.etag;
      return output;
    }
    var handlers = { GET: {}, PATCH: {}, POST: {} };
    handlers.GET['/mail-settings'] = function () { return client.load().then(result); };
    handlers.PATCH['/mail-settings'] = function (request) {
      return client.load().then(function (current) {
        var next;
        try { next = settings.validateBinding(service.applyPatch(current, request.patch), true); }
        catch (error) { throw arp.arpError('SCHEMA_VALIDATION_FAILED', error.message); }
        return client.save(next);
      }).then(result);
    };
    handlers.GET['/mail-settings/status'] = function (request) {
      return client.getStatus().then(function (data) { return support.result(request.uri, 'MailStatus', data, service); });
    };
    handlers.POST['/mail-settings/test-send'] = function (request, context) {
      var message;
      try {
        message = settings.prepareMessage({
          to: request.body.to, subject: '[Page Agent] 邮件配置测试', body: '这是一封来自 Page Agent 的邮件配置测试邮件。',
        });
      } catch (error) { throw arp.arpError('SCHEMA_VALIDATION_FAILED', error.message); }
      return client.send(message, { signal: context.abortSignal, context: context }).then(function (data) {
        var delivery = {
          messageId: data.messageId, acceptedCount: data.acceptedCount, rejectedCount: data.rejectedCount,
        };
        ['audit', 'target', 'transportSessionId', 'requestId'].forEach(function (key) {
          if (data[key] !== undefined) delivery[key] = data[key];
        });
        return support.result(request.uri, 'MailTestDelivery', delivery, null, 200, [{ rel: 'settings', href: '/mail-settings', method: 'GET' }]);
      });
    };
    return {
      service: service, routeContracts: ROUTES, handlers: handlers,
      preconditionState: function (_context, _request, route) {
        if (route.template === '/mail-settings') {
          return client.load().then(function (config) { return { exists: true, etag: snapshot(config).etag }; });
        }
        if (route.template === '/mail-settings/status') {
          return client.getStatus().then(function (data) { return { exists: true, etag: service.etag(data) }; });
        }
        return { exists: true };
      },
    };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'mail-settings', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
