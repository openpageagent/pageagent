// Local operations use the existing ARP catalog and Extension → Server socket.
(function (root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var api = factory(commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol,
    commonJs ? require('../resource-module-adapter.js') : root.ResourceModuleAdapter);
  if (commonJs) module.exports = api;
  else root.LocalResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, adapters) {
  'use strict';

  var PATH = { type: 'string', minLength: 1, maxLength: 4096, description: '配置的工作目录内的路径；相对路径基于该目录，绝对路径也必须在该目录内' };
  function schema(properties, required) {
    return { type: 'object', properties: properties, required: required, additionalProperties: false };
  }
  var OPERATIONS = Object.freeze({
    read: {
      summary: '读取本地 UTF-8 文本文件（最多 4MB），按行分页，返回内容最多 64KB',
      inputSchema: schema({ path: PATH, offset: { type: 'integer', minimum: 1, description: '起始行号，默认 1' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: '最多读取行数，默认 200' } }, ['path']),
    },
    write: {
      summary: '创建或覆盖本地 UTF-8 文本文件（最多 1MB），自动创建父目录',
      inputSchema: schema({ path: PATH, content: { type: 'string', maxLength: 1048576 } }, ['path', 'content']),
    },
    delete: {
      summary: '删除一个本地文件或符号链接，不递归删除目录',
      inputSchema: schema({ path: PATH }, ['path']),
    },
    grep: {
      summary: '在本地文件或目录递归查找字面文本，返回路径、行号和匹配行；跳过符号链接、二进制、超过 4MB 的文件及 .git/node_modules 目录',
      inputSchema: schema({ path: PATH, pattern: { type: 'string', minLength: 1, maxLength: 4096 },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多匹配行数，默认 100' } }, ['path', 'pattern']),
    },
    bash: {
      summary: '在配置的工作目录内启动 Bash 命令；每次独立运行，输出最多 64KB，不可通过参数更改工作目录',
      inputSchema: schema({ command: { type: 'string', minLength: 1, maxLength: 65536 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, description: '超时毫秒数，默认 30000' } }, ['command']),
    },
  });

  function createAdapter(options) {
    var runtime = options.localOperations;
    var routes = Object.keys(OPERATIONS).map(function (name) {
      var definition = OPERATIONS[name];
      return new arp.RouteContract({
        template: '/local/' + name, resourceType: 'LocalOperationResult', relation: 'local-' + name,
        summary: definition.summary, aliases: [name], tags: ['local', 'file', '本地文件', '命令'],
        visible: function () { return runtime.isAvailable(); },
        methods: { POST: {
          inputSchema: definition.inputSchema, outputSchema: { type: 'object' },
          safety: name === 'read' || name === 'grep' ? 'read' : 'execute',
          idempotency: 'keyed', execution: 'sync', permissions: ['local.execute'], preconditions: [],
          relation: 'local-' + name, summary: definition.summary,
        } },
      });
    });
    var handlers = { POST: {} };
    Object.keys(OPERATIONS).forEach(function (name) {
      handlers.POST['/local/' + name] = async function (request, context) {
        var data = await runtime.execute(name, request.body, { signal: context.abortSignal });
        return { statusCode: 200, primary: { uri: request.uri, type: 'LocalOperationResult', data: data },
          receipt: { performed: name === 'read' || name === 'grep' ? 'no' : 'yes' } };
      };
    });
    return adapters.create({ root: 'local', resource: { routeContracts: routes, handlers: handlers } });
  }

  return Object.freeze({ OPERATIONS: OPERATIONS, createAdapter: createAdapter });
});
