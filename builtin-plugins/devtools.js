(function (root) {
  'use strict';
  function unwrap(response) {
    if (response.error) throw root.AgentResourceProtocol.arpError(response.error.code, response.error.message, {
      details: response.error.details, performed: response.receipt && response.receipt.performed || 'unknown', retryable: false,
    });
    return response.primary.data;
  }
  function schema(properties, required) { return { type: 'object', properties: properties, required: required, additionalProperties: false }; }
  function applyPostgres(ctx) {
    var connection = { type: 'string', minLength: 1, maxLength: 500, description: '已配对且已获数据库授权的 MCP 连接 ID' };
    var profile = { type: 'string', minLength: 1, maxLength: 100, description: '研发工具连接 ID，从 connections 获取；仅迁移的旧连接可省略' };
    ctx.pageAgent.registerCapability({
      id: 'connections', label: 'PostgreSQL 连接', description: '列出已授权的 PostgreSQL 连接和 profileId，不连接数据库',
      inputSchema: schema({ connectionId: connection }, ['connectionId']),
      safety: 'read', permissions: ['plugins.execute'], node: true, utility: true,
      execute: async function (input, call) {
        return unwrap(await call.serverArp(input.connectionId, 'GET', { uri: '/devtools?kind=postgres' }));
      },
    });
    ctx.pageAgent.registerCapability({
      id: 'status', label: 'PostgreSQL 连接状态', description: '查看服务端数据库是否已配置及当前客户端授权；不连接数据库',
      inputSchema: schema({ connectionId: connection, profileId: profile }, ['connectionId']),
      safety: 'read', permissions: ['plugins.execute'], node: true, utility: true,
      execute: async function (input, call) {
        return unwrap(await call.serverArp(input.connectionId, 'GET', { uri: '/postgres' + (input.profileId ? '?profileId=' + encodeURIComponent(input.profileId) : '') }));
      },
    });
    ['query', 'execute'].forEach(function (id) {
      var write = id === 'execute';
      ctx.pageAgent.registerCapability({
        id: id, label: write ? 'PostgreSQL 写入' : 'PostgreSQL 查询',
        description: write ? '执行单条参数化 SQL 写操作；需服务端允许写入，结果未知时不要自动重试。已有权限内可新增和修改。DELETE、DROP、TRUNCATE 等删除或清空操作执行前须说明目标和风险并征得用户确认；用户已明确授权的删除无需重复确认。开启写入权限不等于授权删除。'
          : '在只读事务执行单条参数化 SQL；返回 columns、数组 rows、rowCount 和 truncated',
        inputSchema: schema({ connectionId: connection, profileId: profile,
          sql: { type: 'string', minLength: 1, maxLength: 65536, description: '单条 SQL；值用 $1、$2 占位符，表名和列名直接写入 SQL' },
          params: { type: 'array', maxItems: 1000, items: {}, description: '占位符对应的 JSON 参数，默认 []' },
          maxRows: { type: 'integer', minimum: 1, maximum: 1000, description: '默认最多返回 100 行；不限制实际查询或写入行数' },
        }, ['connectionId', 'sql']),
        safety: write ? 'write' : 'read', permissions: ['plugins.execute'],
        node: true, utility: !write,
        execute: async function (input, call) {
          var body = { sql: input.sql, params: input.params || [] };
          if (input.profileId !== undefined) body.profileId = input.profileId;
          if (input.maxRows !== undefined) body.maxRows = input.maxRows;
          return unwrap(await call.serverArp(input.connectionId, 'POST', {
            uri: '/postgres/' + id, body: body, idempotencyKey: call.idempotencyKey,
          }));
        },
      });
    });
  }
  var catalog = root.PageAgentDevToolsCatalog;
  var postgresKind = catalog && catalog.kinds.find(function (kind) { return kind.id === 'postgres'; });
  var postgres = Object.freeze({
    id: 'postgres', name: postgresKind ? postgresKind.name : 'PostgreSQL 数据库', version: '1.0.0', apiVersion: 1, enabled: true,
    description: postgresKind ? postgresKind.description : '执行参数化 SQL 查询与写入',
    sourcePath: 'builtin-plugins/devtools.js', config: {}, configSchema: schema({}, []),
    plugin: { name: 'page-agent-postgres', apply: applyPostgres },
  });
  // PostgreSQL 源码副本独立加载，不依赖扩展内的研发工具目录。
  if (typeof module === 'object' && module.exports) {
    module.exports = postgres;
    return;
  }
  root.PageAgentDevToolsPlugins = Object.freeze([postgres, ...catalog.kinds.filter(function (kind) { return kind.id !== 'postgres'; }).map(function (kind) {
    return Object.freeze({ id: kind.id, name: kind.name, version: '1.0.0', apiVersion: 1, enabled: true,
      description: kind.description,
      config: {}, configSchema: catalog.object({}),
      plugin: { name: 'page-agent-' + kind.id, apply: function (ctx) {
        var connection = catalog.text(500, '已配对的 MCP 服务器连接 ID');
        ctx.pageAgent.registerCapability({ id: 'connections', label: kind.name + ' 连接', description: '列出已授权的 ' + kind.name + ' 连接和 profileId，不发起远端连接',
          inputSchema: catalog.object({ connectionId: connection }, ['connectionId']),
          safety: 'read', permissions: ['plugins.execute'], node: true, utility: true,
          execute: async function (input, call) { return unwrap(await call.serverArp(input.connectionId, 'GET', { uri: '/devtools?kind=' + kind.id })); },
        });
        kind.operations.forEach(function (operation) {
          ctx.pageAgent.registerCapability({ id: operation.id, label: kind.name + ' · ' + operation.label, description: operation.description,
            inputSchema: catalog.object(Object.assign({ connectionId: connection }, operation.inputSchema.properties), ['connectionId'].concat(operation.inputSchema.required)),
            safety: operation.write ? 'write' : 'read', permissions: ['plugins.execute'], node: true, utility: !operation.write,
            execute: async function (input, call) {
              var body = Object.assign({}, input); delete body.connectionId;
              return unwrap(await call.serverArp(input.connectionId, 'POST', {
                uri: '/devtools/' + kind.id + '/' + operation.id, body: body, idempotencyKey: call.idempotencyKey,
              }));
            },
          });
        });
      } },
    });
  })]);
})(globalThis);
