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
      var client = typeof getWebSocketClient === 'function' ? getWebSocketClient() : null;
      if (!client || !client.isConnected()) throw new Error('请先在「连接配置」中启用并连接 MCP Server');
      return client.sendMail({ config: config, message: message }, { signal: options.signal });
    }

    async function getStatus() {
      var config = await load();
      var client = typeof getWebSocketClient === 'function' ? getWebSocketClient() : null;
      var status = client && client.getStatus();
      return {
        enabled: config.enabled,
        connected: !!(status && status.connected),
        supported: !!(status && status.connected && status.serverInfo && status.serverInfo.mail === 'smtp/1'),
      };
    }

    return Object.freeze({ load: load, save: save, setEnabled: setEnabled, send: send, getStatus: getStatus });
  }

  root.MailClient = Object.freeze({ create: create });
})(globalThis);
