// Fixed, local data transformations. No URL fetching or arbitrary code execution.
(function (root) {
  'use strict';
  var support = root.ResourceModuleSupport;
  var catalog = root.OfflineToolCatalog;
  function createAdapter(options) {
    var handlers = { GET: {}, POST: {} };
    var routes = [support.route({
      template: '/utilities', resourceType: 'UtilityCatalog', relation: 'utilities',
      summary: '插件离线工具目录：与内置工具应用和流程节点共用', tags: ['offline', 'tools', '离线工具'],
      methods: { GET: support.read(support.EMPTY_QUERY, 'utilities.read', 'utilities', '读取工具、操作、选项和节点类型') },
    })];
    handlers.GET['/utilities'] = function (request) {
      return { statusCode: 200, primary: { uri: request.uri, type: 'UtilityCatalog', data: { tools: catalog.tools } } };
    };
    catalog.tools.forEach(function (tool) {
      var uri = tool.uri;
      routes.push(support.route({
        template: uri, resourceType: 'Utility', relation: 'utility-' + tool.id,
        summary: tool.label + '：' + tool.description, aliases: [tool.label, tool.id], tags: ['offline', tool.category],
        methods: {
          GET: support.read(support.EMPTY_QUERY, 'utilities.read', 'utility-' + tool.id, '读取参数与操作说明'),
        },
      }));
      handlers.GET[uri] = function (request) {
        return { statusCode: 200, primary: { uri: request.uri, type: 'Utility', data: { ...tool, inputSchema: catalog.inputSchema(tool.id) } } };
      };
      tool.operations.forEach(function (operation) {
        var operationUri = tool.operationUris[operation];
        routes.push(support.route({
          template: operationUri, resourceType: 'UtilityOperation', relation: 'utility-' + tool.id + '-' + operation,
          summary: tool.label + ' / ' + operation + '：' + tool.description,
          aliases: [tool.label, tool.id, operation], tags: ['offline', tool.category],
          methods: {
            POST: {
              inputSchema: catalog.inputSchema(tool.id),
              outputSchema: { type: 'object', properties: {
                tool: { type: 'string', enum: [tool.id] }, operation: { type: 'string', enum: [operation] }, value: {},
              }, required: ['tool', 'operation', 'value'], additionalProperties: false },
              safety: 'read', idempotency: 'keyed', execution: 'sync', permissions: ['utilities.execute'], preconditions: [],
              relation: 'utility-' + tool.id + '-' + operation,
              summary: '本地执行 ' + tool.label + ' / ' + operation + '；最多并行 2 个，15 秒终止',
            },
          },
        }));
        handlers.POST[operationUri] = async function (request, context) {
          // The route owns the operation; catalog normalization still validates the input and options.
          var data = await options.utilityService.execute(tool.id, { ...request.body, operation: operation }, { signal: context.abortSignal });
          return { statusCode: 200, primary: { uri: request.uri, type: 'UtilityResult', data: data }, receipt: { performed: 'no' } };
        };
      });
    });
    return root.ResourceModuleAdapter.create({ root: 'utilities', resource: { routeContracts: routes, handlers: handlers } });
  }
  root.UtilityResource = { createAdapter: createAdapter };
})(globalThis);
