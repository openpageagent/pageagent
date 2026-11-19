'use strict';

const arp = require('../resources/protocol');
const adapter = require('../resources/resource-module-adapter');
const catalog = require('../shared/devtools-catalog');

function createDevToolsResource(service) {
  const resource = { routeContracts: [], handlers: { GET: {}, POST: {} } };
  function route(uri, method, schema, write, summary, handler) {
    resource.routeContracts.push(new arp.RouteContract({ template: uri, resourceType: 'DevToolsResource', relation: 'devtools', summary,
      methods: { [method]: { inputSchema: schema, outputSchema: {}, safety: write ? 'write' : 'read',
        idempotency: method === 'GET' ? 'inherent' : 'keyed', execution: 'sync',
        permissions: [write ? 'devtools.write' : 'devtools.read'], preconditions: [], summary } } }));
    resource.handlers[method][uri] = async (request, context) => ({ statusCode: 200,
      primary: { uri: request.uri, type: 'DevToolsResource', data: await handler(request, context) }, receipt: { performed: write ? 'yes' : 'no' } });
  }
  route('/devtools', 'GET', catalog.object({ kind: { enum: catalog.kinds.map(kind => kind.id) } }), false,
    '已授权的 PostgreSQL、MySQL、Jira、Confluence、Jenkins、Redis、GitLab、SSH、S3 连接及操作目录；不返回凭据', (r, c) => service.list(c, r.query.kind));
  for (const kind of catalog.kinds) for (const operation of kind.operations) {
    route('/devtools/' + kind.id + '/' + operation.id, 'POST', operation.inputSchema, operation.write,
      kind.name + '：' + operation.description, (r, c) => service.execute(kind.id, operation.id, r.body, c));
  }
  return adapter.create({ root: 'devtools', resource });
}

module.exports = { createDevToolsResource };
