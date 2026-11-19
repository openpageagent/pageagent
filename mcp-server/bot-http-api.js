'use strict';

const arp = require('../resources/protocol');
const { HISTORY, PULL, ACK } = require('./bot-resource');

// Authentication and CORS are owned by the existing HTTP listener. These routes
// need no MCP initialization, extension connection, or client-managed position.
function createBotHttpApi(service) {
  return async function handle(req, res, url, helpers) {
    if (!url.pathname.startsWith('/api/bots')) return false;
    const context = { actorId: 'http:operator', abortSignal: helpers.signal };
    const validate = (schema, input) => {
      const result = arp.validateJsonSchema(schema, input);
      if (!result.valid) throw arp.arpError('INVALID_REQUEST', result.errors.join('; '));
      return input;
    };
    let value;
    if (url.pathname === '/api/bots' && req.method === 'GET') {
      value = service.list(context);
    } else {
      const match = /^\/api\/bots\/accounts\/([^/]+)\/(events|pull|ack|consumers\/([^/]+))$/.exec(url.pathname);
      if (!match) throw arp.arpError('RESOURCE_NOT_FOUND', '未知 bot HTTP 路径');
      let accountId, consumerId;
      try { accountId = decodeURIComponent(match[1]); consumerId = match[3] && decodeURIComponent(match[3]); }
      catch (_) { throw arp.arpError('INVALID_REQUEST', '路径编码无效'); }
      if (match[2] === 'events' && req.method === 'GET') {
        const query = {};
        for (const [name, raw] of url.searchParams) {
          if (!['after', 'limit'].includes(name) || Object.hasOwn(query, name) || !/^\d+$/.test(raw)) throw arp.arpError('INVALID_REQUEST', '历史查询仅支持 after 和 limit 各一次');
          query[name] = Number(raw);
        }
        value = service.events(accountId, context, validate(HISTORY, query));
      } else if (['pull', 'ack'].includes(match[2]) && req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw arp.arpError('UNSUPPORTED_MEDIA_TYPE', '请求体必须为 application/json');
        const input = validate(match[2] === 'pull' ? PULL : ACK, await helpers.readBody(req, helpers.signal));
        helpers.signal.throwIfAborted();
        value = match[2] === 'pull' ? service.pull(accountId, input, context) : service.acknowledge(accountId, input, context);
      } else if (consumerId && req.method === 'DELETE') {
        value = service.removeConsumer(accountId, consumerId, context);
      } else throw arp.arpError('METHOD_NOT_ALLOWED', '此路径不支持该 HTTP 方法');
    }
    helpers.sendJson(req, res, 200, value);
    return true;
  };
}

module.exports = { createBotHttpApi };
