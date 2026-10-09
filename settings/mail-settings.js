// One SMTP account, stored separately from settings exposed to page contexts.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PageAutomationMailSettings = api;
})(globalThis, function () {
  'use strict';

  var SETTINGS_KEY = 'mail_settings';
  var MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  var MAX_REQUEST_BYTES = 32 * 1024 * 1024;
  var FLOW_NOTIFICATION_DEFAULTS = Object.freeze({
    subject: '[Page Agent] 流程{{notification.statusLabel}}：{{notification.flowLabel}}',
    body: '流程：{{notification.flowLabel}}\n结果：{{notification.statusLabel}}\n流程 ID：{{notification.flowId}}\n运行编号：{{notification.runId}}\n触发方式：{{notification.trigger}}\n开始时间：{{notification.startedAt}}\n结束时间：{{notification.endedAt}}\n失败原因：{{notification.error}}',
  });
  var DELIVERY_LIMITS = Object.freeze({
    maxConcurrent: 4,
    maxQueued: 32,
    maxQueuedBytes: 64 * 1024 * 1024,
    queueWaitMs: 60000,
    sendTimeoutMs: 80000,
    resultTimeoutMs: 150000,
  });
  var ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: raw.enabled !== false,
      host: String(raw.host === undefined ? '' : raw.host).trim(),
      port: raw.port === undefined || raw.port === '' ? 465 : Number(raw.port),
      security: String(raw.security || 'tls'),
      username: String(raw.username || '').trim(),
      password: String(raw.password || ''),
      from: String(raw.from || '').trim(),
      fromName: String(raw.fromName || '').trim() || 'Page Agent',
    };
  }

  function validate(raw, allowUnconfigured) {
    if (raw && raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('邮件通知开关必须为布尔值');
    var config = normalize(raw);
    var unconfigured = allowUnconfigured === true && !config.host && !config.from && !config.username && !config.password;
    if (!unconfigured && (!config.host || config.host.length > 253 || /[\s/\\:@\x00-\x1f\x7f]/.test(config.host))) {
      throw new Error('SMTP 服务器请填写主机名或 IPv4 地址，不含协议和端口');
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('SMTP 端口必须为 1–65535');
    if (config.security !== 'tls' && config.security !== 'starttls') throw new Error('请选择 TLS 或 STARTTLS');
    if (!!config.username !== !!config.password) throw new Error('SMTP 用户名和密码须同时填写；免认证服务器可同时留空');
    if (!unconfigured && (!ADDRESS.test(config.from) || config.from.length > 254)) throw new Error('请填写有效的发件邮箱');
    if (/[\x00-\x1f\x7f]/.test(config.fromName) || config.fromName.length > 200) throw new Error('发件人名称不能含控制字符，且最多 200 字符');
    return config;
  }

  function recipients(value, label) {
    var values = Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/);
    var result = [];
    values.forEach(function (item) {
      var address = String(item || '').trim();
      if (!address) return;
      if (!ADDRESS.test(address) || address.length > 254) throw new Error(label + '包含无效邮箱，请仅填写邮箱地址');
      if (result.indexOf(address) < 0) result.push(address);
    });
    return result;
  }

  function validateFlowNotification(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('流程结束邮件通知配置必须是对象');
    ['onSuccess', 'onFailure'].forEach(function (key) {
      if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error('流程结束邮件通知开关必须为布尔值');
    });
    if (raw.to !== undefined && typeof raw.to !== 'string') throw new Error('流程结束邮件通知收件人必须为字符串');
    ['subject', 'body'].forEach(function (key) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error('流程通知的主题和正文必须为字符串');
    });
    var notification = {
      onSuccess: raw.onSuccess === true,
      onFailure: raw.onFailure === true,
      to: String(raw.to || '').trim(),
      subject: raw.subject === undefined ? FLOW_NOTIFICATION_DEFAULTS.subject : raw.subject,
      body: raw.body === undefined ? FLOW_NOTIFICATION_DEFAULTS.body : raw.body,
    };
    if (notification.onSuccess || notification.onFailure) {
      prepareMessage(notification);
    }
    return notification;
  }

  function prepareMessage(input) {
    input = input || {};
    var to = recipients(input.to, '收件人');
    var cc = recipients(input.cc, '抄送');
    var bcc = recipients(input.bcc, '密送');
    if (!to.length && !cc.length && !bcc.length) throw new Error('请至少填写一个收件人、抄送或密送邮箱');
    if (to.length + cc.length + bcc.length > 100) throw new Error('每封邮件最多 100 个收件地址');
    var subject = String(input.subject || '');
    if (!subject.trim() || subject.length > 998 || /[\x00-\x1f\x7f]/.test(subject)) throw new Error('邮件主题不能为空、含控制字符或超过 998 字符');
    var body = String(input.body || '');
    if (new TextEncoder().encode(body).length > 1024 * 1024) throw new Error('邮件正文不能超过 1MB');
    var bodyFormat = String(input.bodyFormat || 'text');
    if (bodyFormat !== 'text' && bodyFormat !== 'html') throw new Error('邮件正文格式仅支持 text 或 html');
    var attachments = input.attachments || [];
    if (typeof attachments === 'string') {
      try { attachments = attachments.trim() ? JSON.parse(attachments) : []; }
      catch (_) { throw new Error('邮件附件必须为 JSON 数组'); }
    }
    if (!Array.isArray(attachments) || attachments.length > 20) throw new Error('邮件附件必须为数组，最多 20 个');
    var totalBytes = 0;
    attachments = attachments.map(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('每个附件必须是对象');
      var fileName = String(item.fileName || '');
      if (!fileName || /[\/\\\x00-\x1f\x7f]/.test(fileName) || fileName.length > 255) throw new Error('附件必须提供不含路径或控制字符的文件名，最多 255 字符');
      var mimeType = String(item.mimeType || '');
      if (mimeType && !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) throw new Error('附件 MIME 类型无效');
      if (item.filePath || item.path || item.href) throw new Error('附件请提供文本或 Base64 内容，不支持文件路径或 URL');
      if (typeof item.content !== 'string') throw new Error('附件 content 必须为字符串');
      var contentMode = String(item.contentMode || 'text');
      var content = item.content;
      if (contentMode === 'base64') {
        content = content.replace(/\s/g, '');
        if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('附件 Base64 内容无效（不接受 data: 前缀）');
        totalBytes += content.length * 3 / 4 - (content.endsWith('==') ? 2 : (content.endsWith('=') ? 1 : 0));
      } else if (contentMode === 'text') {
        totalBytes += new TextEncoder().encode(content).length;
      } else throw new Error('附件 contentMode 仅支持 text 或 base64');
      if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 20MB');
      return { fileName: fileName, mimeType: mimeType, content: content, contentMode: contentMode };
    });
    return { to: to, cc: cc, bcc: bcc, subject: subject, body: body, bodyFormat: bodyFormat, attachments: attachments };
  }

  return Object.freeze({
    SETTINGS_KEY: SETTINGS_KEY, normalize: normalize, validate: validate, recipients: recipients,
    validateFlowNotification: validateFlowNotification,
    FLOW_NOTIFICATION_DEFAULTS: FLOW_NOTIFICATION_DEFAULTS,
    prepareMessage: prepareMessage, MAX_ATTACHMENT_BYTES: MAX_ATTACHMENT_BYTES, MAX_REQUEST_BYTES: MAX_REQUEST_BYTES,
    DELIVERY_LIMITS: DELIVERY_LIMITS,
  });
});
