// ARP/1 SMTP settings and a test delivery using the existing mail client.
(function attachMailSettingsResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  var settings = commonJs ? require('../../settings/mail-settings') : root.PageAutomationMailSettings;
  if (!arp || !support || !adapter || !settings) throw new Error('MailSettingsResource dependencies are incomplete');
  var api = factory(arp, support, adapter, settings);
  if (commonJs) module.exports = api;
  else root.MailSettingsResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, support, ResourceModuleAdapter, settings) {
  'use strict';
  var PUBLIC_PROPERTIES = Object.freeze({
    connectionId: { type: 'string', maxLength: 200 },
    enabled: { type: 'boolean' }, host: { type: 'string', maxLength: 253 },
    port: { type: 'integer', minimum: 1, maximum: 65535 }, security: { type: 'string', enum: ['tls', 'starttls'] },
    username: { type: 'string' }, from: { type: 'string', maxLength: 254 }, fromName: { type: 'string', maxLength: 200 },
  });
  var SETTINGS_SCHEMA = Object.freeze({
    type: 'object', properties: Object.assign({ passwordConfigured: { type: 'boolean' } }, PUBLIC_PROPERTIES),
    required: Object.keys(PUBLIC_PROPERTIES).concat(['passwordConfigured']), additionalProperties: false,
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object', properties: Object.assign({
      password: { type: 'string', description: '省略则保留现有密码；空字符串清除密码，免认证时需同时清空 username。响应不返回密码。' },
    }, PUBLIC_PROPERTIES), minProperties: 1, additionalProperties: false,
  });
  var STATUS_SCHEMA = Object.freeze({
    type: 'object', properties: { enabled: { type: 'boolean' }, connected: { type: 'boolean' }, supported: { type: 'boolean' }, connectionId: { type: 'string' }, reason: { type: ['string', 'null'] } },
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
      summary: '读取或修改邮件通知开关、SMTP 账号与发件信息；密码只写不读',
      aliases: ['邮件配置', 'SMTP', '邮件通知'], tags: ['settings', 'mail'], entryWeights: { mcp: 35, global: 20 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'mail-settings.read', 'mail-settings', '读取邮件配置，不返回密码', SETTINGS_SCHEMA),
        PATCH: support.patch('mail-settings.write', 'mail-settings', '局部修改邮件配置；省略 password 保留原密码', PATCH_SCHEMA, SETTINGS_SCHEMA),
      },
    }),
    support.route({
      template: '/mail-settings/status', resourceType: 'MailStatus', relation: 'mail-status',
      summary: '读取邮件开关及已连接服务端的 SMTP 支持状态', tags: ['mail', 'status'],
      methods: { GET: support.read(support.EMPTY_QUERY, 'mail-settings.read', 'mail-status', '读取邮件服务状态', STATUS_SCHEMA) },
    }),
    support.route({
      template: '/mail-settings/test-send', resourceType: 'MailTestDelivery', relation: 'mail-test-send',
      summary: '使用已保存的 SMTP 配置向指定邮箱实际发送一封固定内容的测试邮件；须已启用邮件并连接服务端',
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
      // Include credential-only changes without exposing a password hash. A runtime restart requires a fresh GET.
      if (serialized !== previousConfig) {
        previousConfig = serialized;
        version = '"mail-' + crypto.randomUUID() + '"';
      }
      var data = { passwordConfigured: !!config.password };
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
        try { next = settings.validate(service.applyPatch(current, request.patch), true); }
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
        return support.result(request.uri, 'MailTestDelivery', {
          messageId: data.messageId, acceptedCount: data.acceptedCount, rejectedCount: data.rejectedCount,
          audit: data.audit, target: data.target, transportSessionId: data.transportSessionId, requestId: data.requestId,
        }, null, 200, [{ rel: 'settings', href: '/mail-settings', method: 'GET' }]);
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
