'use strict';

const arp = require('../resources/protocol');
const adapter = require('../resources/resource-module-adapter');
const { INPUT } = require('./postgres-service');
const { deletionGuidance } = require('../shared/devtools-catalog');

function createPostgresResource(service) {
  const resource = { routeContracts: [], handlers: { GET: {}, POST: {} } };
  function route(uri, method, inputSchema, write, summary, handler) {
    resource.routeContracts.push(new arp.RouteContract({ template: uri, resourceType: 'PostgresResource', relation: 'postgres', summary,
      methods: { [method]: { inputSchema, outputSchema: {}, safety: write ? 'write' : 'read',
        idempotency: method === 'GET' ? 'inherent' : 'keyed', execution: 'sync',
        permissions: [write ? 'postgres.write' : 'postgres.read'], preconditions: [], summary } } }));
    resource.handlers[method][uri] = async (request, context) => ({ statusCode: 200,
      primary: { uri: request.uri, type: 'PostgresResource', data: await handler(request, context) },
      receipt: { performed: write ? 'yes' : 'no' } });
  }
  route('/postgres', 'GET', { type: 'object', properties: { profileId: INPUT.properties.profileId }, additionalProperties: false }, false,
    'PostgreSQL 连接状态（兼容入口）；连接统一从 /devtools 获取，不返回凭据', (r, c) => service.status(c, r.query));
  route('/postgres/query', 'POST', INPUT, false,
    '单条参数化只读 SQL（兼容入口）；新连接需 profileId，旧配置沿用已导入的连接；返回 columns 和数组 rows',
    (r, c) => service.execute(r.body, c, false));
  route('/postgres/execute', 'POST', INPUT, true,
    '单条参数化 SQL 写操作（兼容入口）；新连接需 profileId，并需允许写入。结果未知时先核对数据，不自动重试。' + deletionGuidance,
    (r, c) => service.execute(r.body, c, true));
  return adapter.create({ root: 'postgres', resource });
}

module.exports = { createPostgresResource };
