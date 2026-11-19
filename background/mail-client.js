// The browser stores references only; SMTP credentials and delivery live on the server.
(function (root) {
  'use strict';

  function create(chromeApi, getWebSocketClient, callServerArp) {
    var settings = root.PageAgentMailSettings;
    function unwrap(envelope) {
      if (!envelope || !envelope.status) throw new Error('服务端邮件响应无效');
      if (envelope.status.code >= 400) throw root.AgentResourceProtocol.arpError(
        envelope.error && envelope.error.code || 'UPSTREAM_FAILED', envelope.error && envelope.error.message || '邮件操作失败',
        { performed: envelope.receipt && envelope.receipt.performed || 'unknown', retryable: false, details: envelope.error && envelope.error.details });
      return envelope.primary && envelope.primary.data;
    }
    async function load() {
      var stored = await chromeApi.storage.local.get(settings.SETTINGS_KEY);
      return settings.normalizeBinding(stored[settings.SETTINGS_KEY]);
    }
    async function accounts(connectionId) {
      var data = unwrap(await callServerArp(connectionId, 'GET', { uri: '/bots' }, { actorId: 'mail:settings' }));
      return data.items.filter(function (item) { return item.adapter === 'mail'; });
    }
    async function save(value) {
      var config = settings.validateBinding(value, true);
      if (config.accountId && !config.connectionId) throw new Error('请选择服务端连接');
      var patch = {}; patch[settings.SETTINGS_KEY] = config;
      await chromeApi.storage.local.set(patch);
      return config;
    }
    async function setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('邮件通知开关必须为布尔值');
      // Preserve legacy credentials until the user explicitly saves a server binding.
      var stored = await chromeApi.storage.local.get(settings.SETTINGS_KEY);
      var raw = Object.assign({}, stored[settings.SETTINGS_KEY], { enabled: enabled });
      var patch = {}; patch[settings.SETTINGS_KEY] = raw;
      await chromeApi.storage.local.set(patch);
      return settings.normalizeBinding(raw);
    }
    async function send(input, options) {
      options = options || {};
      var stored = await load();
      if (!stored.enabled) throw root.AgentResourceProtocol.arpError('FORBIDDEN', '邮件通知已关闭，请先在连接配置中启用', { performed: 'no' });
      var config = settings.validateBinding(options.config || stored);
      var message = settings.prepareMessage(input);
      var context = Object.assign({}, options.context || {});
      if (options.signal) context.abortSignal = options.signal;
      if (context.appResourceSession) await root.PageAgentApps.authorizeResources(context.appResourceSession, ['mail-settings.execute']);
      return unwrap(await callServerArp(config.connectionId, 'POST', {
        uri: '/bots/accounts/' + encodeURIComponent(config.accountId) + '/mail', body: message,
        idempotencyKey: crypto.randomUUID(),
      }, context));
    }
    async function getStatus() {
      var config = await load();
      var client = config.connectionId && getWebSocketClient(config.connectionId);
      var status = client && client.getStatus();
      return { enabled: config.enabled, connectionId: config.connectionId, accountId: config.accountId,
        reason: !config.connectionId || !config.accountId ? 'TARGET_REQUIRED' : status && status.reason || (status && status.ready ? null : 'CONNECTION_NOT_READY'),
        connected: !!(status && status.ready),
        supported: !!(status && status.ready && status.serverInfo && status.serverInfo.capabilities.mail.supported
          && status.serverInfo.capabilities.mail.protocol === 'bot-mail/1') };
    }
    return Object.freeze({ load: load, save: save, setEnabled: setEnabled, send: send, getStatus: getStatus, accounts: accounts });
  }
  root.MailClient = Object.freeze({ create: create });
})(globalThis);
