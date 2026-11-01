// The extension owns the account; the connected MCP Server performs SMTP delivery.
(function (root) {
  'use strict';

  function create(chromeApi, getWebSocketClient) {
    var settings = root.PageAutomationMailSettings;

    async function load() {
      var stored = await chromeApi.storage.local.get(settings.SETTINGS_KEY);
      return settings.normalize(stored[settings.SETTINGS_KEY]);
    }

    async function save(value) {
      var config = settings.validate(value, true);
      var patch = {};
      patch[settings.SETTINGS_KEY] = config;
      await chromeApi.storage.local.set(patch);
      return config;
    }

    async function setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('邮件通知开关必须为布尔值');
      var config = await load();
      config.enabled = enabled;
      return save(config);
    }

    async function send(input, options) {
      options = options || {};
      var stored = await load();
      if (!stored.enabled) {
        var error = new Error('邮件通知已关闭，请先在连接配置中启用');
        error.retryable = false;
        throw error;
      }
      var message = settings.prepareMessage(input);
      var config = settings.validate(options.config || stored);
      if (!config.connectionId) throw new Error('请明确选择用于发送邮件的服务端连接');
      if (options.context && options.context.sourceConnectionId && options.context.sourceConnectionId !== config.connectionId) throw new Error('CROSS_CONNECTION_FORWARDING_DISABLED');
      var client = typeof getWebSocketClient === 'function' ? getWebSocketClient(config.connectionId) : null;
      if (!client || !client.isConnected()) throw new Error('请先在「连接配置」中启用并连接 MCP Server');
      var status = client.getStatus();
      if (!status.serverInfo.capabilities.mail.supported) throw new Error('所选服务端不支持邮件');
      if (!status.serverInfo.capabilities.audit.available) throw root.AgentResourceProtocol.arpError('TEMPORARILY_UNAVAILABLE', '服务端审计不可用，邮件尚未发送', { performed: 'no', retryable: false, details: { reason: 'AUDIT_UNAVAILABLE' } });
      var context = options.context || {};
      async function correlation(value) { if (!value) return null; return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(value)) ? String(value) : root.AgentResourceProtocol.sha256(String(value)); }
      var caller = { kind: context.sourceConnectionId ? 'external' : context.runId ? 'flow' : 'ui', actorId: context.actorId || 'mail:runtime',
        conversationId: context.conversationId || null, runId: context.runId || null, parentRequest: context.parentRequest || null };
      caller.actorId = await correlation(caller.actorId); caller.conversationId = await correlation(caller.conversationId); caller.runId = await correlation(caller.runId);
      var smtpConfig = Object.assign({}, config); delete smtpConfig.connectionId;
      try { return await client.sendMail({ config: smtpConfig, message: message }, { signal: options.signal, caller: caller }); }
      catch (error) { throw root.AgentResourceProtocol.arpError(error.code || 'UPSTREAM_FAILED', error.message, { performed: error.performed || 'unknown', retryable: false,
        details: { reason: error.reason, audit: error.audit, target: { connectionId: config.connectionId, serverId: status.serverId } } }); }
    }

    async function getStatus() {
      var config = await load();
      var client = config.connectionId && typeof getWebSocketClient === 'function' ? getWebSocketClient(config.connectionId) : null;
      var status = client && client.getStatus();
      return {
        enabled: config.enabled,
        connectionId: config.connectionId,
        reason: !config.connectionId ? 'TARGET_REQUIRED' : status && status.reason || (status && status.ready ? null : 'CONNECTION_NOT_READY'),
        connected: !!(status && status.ready),
        supported: !!(status && status.ready && status.serverInfo && status.serverInfo.capabilities.mail.supported),
      };
    }

    return Object.freeze({ load: load, save: save, setEnabled: setEnabled, send: send, getStatus: getStatus });
  }

  root.MailClient = Object.freeze({ create: create });
})(globalThis);
