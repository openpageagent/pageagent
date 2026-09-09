// ARP/1 node type catalog resource.
(function attachNodeTypeResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('NodeTypeResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.NodeTypeResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var NODE_TYPES_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      match: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  });
  var NODE_TYPE_SUMMARY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      type: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' },
      categoryId: { type: 'string' }, categoryLabel: { type: 'string' },
    },
    required: ['type', 'label', 'categoryId', 'categoryLabel'], additionalProperties: false,
  });
  var NODE_TYPE_CATEGORY_COUNT_SCHEMA = Object.freeze({
    type: 'object',
    properties: { categoryId: { type: 'string' }, categoryLabel: { type: 'string' }, count: { type: 'integer', minimum: 0 } },
    required: ['categoryId', 'categoryLabel', 'count'], additionalProperties: false,
  });
  var NODE_TYPE_COLLECTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      items: { type: 'array', items: NODE_TYPE_SUMMARY_SCHEMA },
      total: { type: 'integer', minimum: 0 },
      categoryCounts: { type: 'array', items: NODE_TYPE_CATEGORY_COUNT_SCHEMA },
      nextCursor: { type: 'string' },
    },
    required: ['items', 'total', 'categoryCounts'], additionalProperties: false,
  });
  var ROUTES = Object.freeze([
    support.route({
      template: '/node-types', resourceType: 'NodeTypeCollection', relation: 'node-types',
      summary: '读取可用的 Flow 节点类型摘要目录', aliases: ['节点目录', 'node catalog'],
      tags: ['node', 'schema'], entryWeights: { flow: 25, 'flow-editor': 35 },
      affordances: [{
        method: 'GET', href: '/node-types?match=<query>&limit=20', rel: 'match-node-types',
        title: '创建或修改 Flow 且没有现成 flowNode 时，按当前目标检索真实节点类型；匹配结果包含 description 供选型，再读取 /node-types/{nodeType} 获取参数和输出合同。',
      }, {
        method: 'GET', href: '/node-types', rel: 'list-all-node-types',
        title: '需要完整节点清单时直接读取 /node-types；未指定 limit/cursor 时一次返回当前注册表全部节点，完整目录省略 description，详细用途和配置按需读取 /node-types/{nodeType}。原样使用 items[].type、items[].label、items[].categoryLabel 和 response.total/categoryCounts（categoryCounts 是当前 match 过滤后完整结果集的统计，不是当前页）；不要自行分类、合并、去重或重新计数。',
      }],
      methods: { GET: support.read(NODE_TYPES_QUERY_SCHEMA, 'node-types.read', 'node-types', '列出匹配的节点类型摘要或完整节点目录', NODE_TYPE_COLLECTION_SCHEMA) },
    }),
    support.route({
      template: '/node-types/{nodeType}', resourceType: 'NodeType', relation: 'node-type',
      summary: '读取一个节点类型 schema', aliases: ['节点类型详情'], tags: ['node', 'schema'],
      entryWeights: { flow: 25, 'flow-editor': 35 },
      methods: { GET: support.read(support.EMPTY_QUERY, 'node-types.read', 'node-type', '读取用途、完整参数配置、输出和运行边界') },
    }),
  ]);

  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'NodeTypeResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/node-types'] = function (request) {
      return Promise.resolve(service.listNodeTypes(request.query)).then(function (data) {
        return support.result(request.uri, 'NodeTypeCollection', data, service);
      });
    };
    handlers.GET['/node-types/{nodeType}'] = function (request) {
      return service.getNodeType(request.params.nodeType).then(function (data) {
        return support.result(request.uri, 'NodeType', data, service);
      });
    };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }

  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'node-types', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
