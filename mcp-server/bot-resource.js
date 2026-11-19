'use strict';
const arp = require('../resources/protocol');
const adapter = require('../resources/resource-module-adapter');
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const EMPTY = object({});
const ACCOUNT = object({ name: string(100), adapter: { enum: ['lark', 'dingtalk', 'qq', 'wecom', 'wecom-aibot', 'mail'] },
  enabled: { type: 'boolean' }, config: { type: 'object' }, revision: { type: 'integer', minimum: 1 },
  receiveEnabled: { type: 'boolean', description: '仅邮件：是否接收 IMAP 邮件；默认 true，false 时只需 SMTP 配置' },
  autoReply: object({ enabled: { type: 'boolean' }, text: { type: 'string', maxLength: 16000 } }, ['enabled', 'text']),
  authorizedClientIds: { type: 'array', maxItems: 100, uniqueItems: true, items: string(200), description: '授权使用账号并接收实时消息的配对客户端；服务端始终可用，只有 HTTP 操作者可修改' },
  ownerClientId: { anyOf: [{ type: 'null' }, string(200)], description: '旧版单客户端授权字段；新配置使用 authorizedClientIds，不可同时提交' },
  callback: { anyOf: [{ type: 'null' }, object({ host: string(200), port: { type: 'integer', minimum: 1, maximum: 65535 },
    selfUrl: { type: 'string', pattern: '^https?://', maxLength: 2000 } }, ['host', 'port', 'selfUrl'])] },
}, ['name', 'adapter', 'enabled', 'config']);
const SEND = object({ targetId: string(500), text: string(16000), direct: { type: 'boolean' },
  selfId: string(500), platform: string(80), guildId: string(500), replyTo: string(200) }, ['targetId', 'text']);
const HISTORY = object({ after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } });
const CONSUMER = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$', maxLength: 100 };
const PULL = object({ consumerId: CONSUMER, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['consumerId']);
const ACK = object({ consumerId: CONSUMER, receipt: string(100) }, ['consumerId', 'receipt']);
const ADDRESSES = { anyOf: [{ type: 'string', maxLength: 30000 }, { type: 'array', maxItems: 100, items: string(254) }] };
const MAIL = object({ to: ADDRESSES, cc: ADDRESSES, bcc: ADDRESSES, subject: string(998),
  body: { type: 'string', maxLength: 1048576 }, bodyFormat: { enum: ['text', 'html'] },
  attachments: { type: 'array', maxItems: 20, items: object({ fileName: string(255),
    mimeType: { type: 'string', maxLength: 200 }, content: { type: 'string', maxLength: 27962028 },
    contentMode: { enum: ['text', 'base64'] } }, ['fileName', 'content']) },
}, ['subject', 'body']);
function createBotResource(service) {
  const resource = { routeContracts: [], handlers: { GET: {}, POST: {}, DELETE: {} } };
  function route(uri, method, schema, permission, summary, handler) {
    const definition = { inputSchema: schema, outputSchema: {}, safety: method === 'GET' ? 'read' : 'write',
      idempotency: method === 'GET' ? 'inherent' : 'keyed', execution: 'sync', permissions: [permission], preconditions: [], summary };
    let contract = resource.routeContracts.find(item => item.template === uri);
    if (contract) {
      resource.routeContracts.splice(resource.routeContracts.indexOf(contract), 1,
        new arp.RouteContract({ ...contract, methods: { ...contract.methods, [method]: definition } }));
    } else resource.routeContracts.push(new arp.RouteContract({ template: uri, resourceType: 'BotResource', relation: 'bots', summary, methods: { [method]: definition } }));
    resource.handlers[method][uri] = async (request, context) => ({ statusCode: 200,
      primary: { uri: request.uri, type: 'BotResource', data: await handler(request, context) },
      receipt: { performed: method === 'GET' ? 'no' : 'yes' } });
  }
  route('/bots', 'GET', EMPTY, 'bots.read', '内置平台适配器及有权访问的账号；不含凭据', (r, c) => service.list(c));
  route('/bots/clients', 'GET', EMPTY, 'bots.manage', '服务端操作者查询可授权的配对客户端，包含离线客户端', (r, c) => service.clients(c));
  route('/bots/accounts', 'POST', ACCOUNT, 'bots.manage', '创建服务端账号；可选授权配对客户端', (r, c) => service.save(null, r.body, c));
  route('/bots/accounts/{accountId}', 'POST', ACCOUNT, 'bots.manage', '保存账号及启停；必须提交当前 revision', (r, c) => service.save(r.params.accountId, r.body, c));
  route('/bots/accounts/{accountId}', 'DELETE', object({ revision: { type: 'integer', minimum: 1 } }, ['revision']), 'bots.manage', '删除账号', (r, c) => service.remove(r.params.accountId, r.body.revision, c));
  route('/bots/accounts/{accountId}/configuration', 'GET', EMPTY, 'bots.manage', 'HTTP 配置中心读取账号凭据；配对客户端仅返回摘要和 revision', (r, c) => service.settings(r.params.accountId, c));
  route('/bots/accounts/{accountId}/events', 'GET', HISTORY, 'bots.read', '持久消息历史；默认最近 50 条，after=0 从头分页；不改变消费者进度', (r, c) => service.events(r.params.accountId, c, r.query));
  route('/bots/accounts/{accountId}/sources', 'GET', EMPTY, 'bots.read', '从已保存的消息中选择频道与发送者，不改变消费者进度', (r, c) => service.sources(r.params.accountId, c));
  route('/bots/accounts/{accountId}/pull', 'POST', PULL, 'bots.read', '按服务端保存的消费者进度领取消息；未确认的批次重复返回', (r, c) => service.pull(r.params.accountId, r.body, c));
  route('/bots/accounts/{accountId}/ack', 'POST', ACK, 'bots.read', '确认已处理的批次，由服务端推进读取进度', (r, c) => service.acknowledge(r.params.accountId, r.body, c));
  route('/bots/accounts/{accountId}/consumers/{consumerId}', 'DELETE', EMPTY, 'bots.read', '删除本调用方的消费者进度；再次领取从头开始', (r, c) => service.removeConsumer(r.params.accountId, r.params.consumerId, c));
  route('/bots/accounts/{accountId}/messages', 'POST', SEND, 'bots.send', '发送纯文本；未确认的投递不得自动重试', (r, c) => service.send(r.params.accountId, r.body, c));
  route('/bots/accounts/{accountId}/mail', 'POST', MAIL, 'bots.send', '通过服务端邮件账号发送邮件；支持主题、HTML、附件、抄送和密抄', (r, c) => service.sendMail(r.params.accountId, r.body, c));
  return adapter.create({ root: 'bots', resource });
}
module.exports = { createBotResource, ACCOUNT, HISTORY, PULL, ACK };
