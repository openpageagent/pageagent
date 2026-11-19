'use strict';

// The executable catalog is fixed at release time. Never resolve a package name
// supplied by an account, the browser, or a marketplace.
const adapters = {
  lark: { name: '飞书', package: '@koishijs/plugin-adapter-lark', version: '3.12.6',
    load: () => require('@koishijs/plugin-adapter-lark'),
    example: { platform: 'feishu', protocol: 'ws', appId: '', appSecret: '' },
    hint: '自建应用启用机器人及消息事件，选择长连接；配置应用权限并发布。' },
  dingtalk: { name: '钉钉', package: '@koishijs/plugin-adapter-dingtalk', version: '2.5.2',
    load: () => require('@koishijs/plugin-adapter-dingtalk'),
    example: { protocol: 'ws', appkey: '', secret: '', agentId: 0 },
    hint: '使用钉钉应用机器人，消息接收模式选择 Stream。' },
  qq: { name: 'QQ', package: '@koishijs/plugin-adapter-qq', version: '4.14.0',
    load: () => require('@koishijs/plugin-adapter-qq'),
    example: { id: '', secret: '', type: 'public', protocol: 'websocket', sandbox: false, intents: ['USER_MESSAGE'] },
    hint: 'QQ 官方机器人；按平台授权选择 websocket 或 webhook，以及事件 intents。不是个人 QQ 登录。' },
  wecom: { name: '企业微信', package: '@koishijs/plugin-adapter-wecom', version: '2.5.0',
    load: () => require('@koishijs/plugin-adapter-wecom'),
    example: { corpId: '', agentId: '', secret: '', token: '', aesKey: '' },
    hint: '企业自建应用；配置可信 IP 与接收消息服务器，回调路径为 /wecom。' },
  'wecom-aibot': { name: '企业微信智能机器人', package: '@wecom/aibot-node-sdk', version: '1.0.7',
    load: () => require('./bot-wecom-aibot'),
    example: { botId: '', secret: '' },
    hint: '智能机器人 API 模式选择长连接，填写 BotID 和 Secret；无需回调地址。当前接入文本消息。' },
  mail: { name: '邮件', package: '@koishijs/plugin-adapter-mail', version: '2.3.2',
    load: () => require('@koishijs/plugin-adapter-mail'),
    example: { username: '', password: '', subject: 'Page Agent',
      imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 465, tls: true } },
    hint: '启用 IMAP／SMTP 并填写授权码。接收 INBOX 未读邮件（含启用前的未读邮件），持久化成功后标记已读；单封接收上限 32MB。' },
};
function definition(id) {
  if (!Object.hasOwn(adapters, id)) throw new Error('仅支持飞书、钉钉、QQ、企业微信、企业微信智能机器人和邮件适配器');
  return adapters[id];
}
function load(id) { const value = definition(id).load(); return value.default || value; }
function catalog() {
  return Object.entries(adapters).map(([id, item]) => ({ id, name: item.name, package: item.package,
    version: item.version, license: 'MIT', example: item.example, hint: item.hint }));
}
function needsCallback(id, config) {
  return id === 'wecom' || id === 'qq' && config.protocol === 'webhook'
    || id === 'lark' && config.protocol === 'http';
}
module.exports = { definition, load, catalog, needsCallback };
