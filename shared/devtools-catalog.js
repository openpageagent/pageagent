// One contract catalog for server routes, browser capabilities and connection forms.
(function (root) {
  'use strict';
  var deletionGuidance = '操作约定：已有权限内可读取、新增和修改。删除、清空等破坏性操作（含脚本或命令间接删除）执行前须说明目标和风险并征得用户确认；用户已明确授权的删除无需重复确认。开启写入或执行权限不等于授权删除。';
  function text(max, description) { return { type: 'string', minLength: 1, maxLength: max || 500, description: description || '' }; }
  function integer(min, max, description) { return { type: 'integer', minimum: min, maximum: max, description: description || '' }; }
  function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
  function field(key, label, options) { return Object.assign({ key: key, label: label, type: 'text', default: '', maxLength: 2000 }, options || {}); }
  function operation(id, label, properties, required, write, description) {
    return { id: id, label: label, write: !!write, description: (description || label) + (write ? '。' + deletionGuidance : ''),
      inputSchema: object(Object.assign({ profileId: text(100, '服务端研发工具连接 ID；从 connections 或 GET /devtools 获取') }, properties), ['profileId'].concat(required || [])) };
  }
  var page = { page: integer(1, 100000, '页码，默认 1'), perPage: integer(1, 100, '每页数量，默认 20') };
  var base = field('baseUrl', '服务地址', { required: true, type: 'url', hint: '包含部署上下文路径，例如 https://host/jira；不含凭据和查询参数' });
  var ca = field('ca', '自定义 CA（PEM，可留空）', { type: 'textarea', maxLength: 65536, hint: '留空使用系统信任的证书；始终验证 TLS 证书' });
  var token = field('token', '访问令牌', { secret: true, required: true, maxLength: 8192 });
  var deployment = field('deployment', '部署类型', { type: 'select', default: 'cloud', choices: [['cloud', 'Atlassian Cloud'], ['datacenter', 'Data Center']] });
  var auth = field('auth', '认证方式', { type: 'select', default: 'basic', choices: [['basic', '用户名 / 邮箱 + API Token'], ['bearer', 'Bearer Token / PAT']] });
  var username = field('username', '用户名 / 邮箱', { hint: 'Basic 认证时必填；Bearer 认证无需填写' });
  var issue = { issueKey: text(100, '工单键，例如 PROJ-42') };
  var project = { project: text(500, 'GitLab 项目 ID 或 group/project 路径') };
  var job = { job: text(1000, 'Jenkins 任务路径，例如 team/build') };
  var build = Object.assign({}, job, { buildNumber: integer(1, 2147483647, '构建号；省略时读取 lastBuild') });
  var key = { key: text(2000, '完整键名') };
  var content = text(524288, '页面正文，Confluence storage 格式（HTML）');
  var mysqlInput = {
    sql: text(65536, '单条 MySQL SQL，值用 ? 占位符；不支持 CALL、DDL、事务或会话管理语句'),
    params: { type: 'array', maxItems: 1000, items: { type: ['string', 'number', 'boolean', 'null'] }, description: '按 ? 顺序传入标量值，JSON 内容以字符串传入；默认 []' },
    maxRows: integer(1, 1000, '默认最多返回 100 行；不限制实际查询或修改行数'),
  };
  var postgresInput = {
    sql: text(65536, '单条 PostgreSQL SQL，值用 $1、$2 占位符'),
    params: { type: 'array', maxItems: 1000, items: {}, description: '与占位符对应的 JSON 参数，默认 []' },
    maxRows: integer(1, 1000, '默认最多返回 100 行；不限制实际查询或修改行数'),
  };
  var kinds = [
    { id: 'postgres', name: 'PostgreSQL 数据库', description: '执行参数化 SQL 查询与写入', fields: [
      field('host', '主机', { required: true, default: '127.0.0.1', maxLength: 255 }),
      field('port', '端口', { type: 'number', default: 5432, min: 1, max: 65535 }),
      field('database', '数据库', { required: true, maxLength: 200 }),
      field('username', '用户', { required: true, maxLength: 200 }),
      field('password', '密码', { secret: true, maxLength: 4096 }),
      field('tls', '启用 TLS', { type: 'checkbox', default: false }), ca,
    ], operations: [
      operation('query', '查询业务数据', postgresInput, ['sql'], false, '在只读事务执行单条参数化 SQL；返回 columns、数组 rows、rowCount 和 truncated'),
      operation('execute', '写入业务数据', postgresInput, ['sql'], true, '执行单条参数化 SQL 写操作；需允许写入，结果未知时先核对数据，不自动重试'),
    ] },
    { id: 'mysql', name: 'MySQL 数据库', description: '执行参数化 SQL 查询与写入', fields: [
      field('host', '主机', { required: true, default: '127.0.0.1', maxLength: 255 }),
      field('port', '端口', { type: 'number', default: 3306, min: 1, max: 65535 }),
      field('database', '数据库', { required: true, maxLength: 200 }),
      field('username', '用户', { required: true, maxLength: 200 }),
      field('password', '密码', { secret: true, maxLength: 4096 }),
      field('tls', '启用 TLS', { type: 'checkbox', default: false }), ca,
    ], operations: [
      operation('query', '查询业务数据', mysqlInput, ['sql'], false, '在只读事务执行 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH；返回 columns、数组 rows 和 truncated'),
      operation('execute', '写入业务数据', mysqlInput, ['sql'], true, '执行 INSERT / UPDATE / DELETE / REPLACE / WITH；提交后返回受影响行数。结果未知时先核对数据，不自动重试'),
    ] },
    { id: 'jira', name: 'Jira 项目与工单管理', description: '搜索和创建工单、添加评论及流转状态', fields: [base, deployment, auth, username, token, ca], operations: [
      operation('search', '搜索工单', { jql: text(8000), maxResults: integer(1, 100), startAt: integer(0, 1000000, 'Data Center 分页偏移'), nextPageToken: text(4000, 'Cloud 上一页返回的分页令牌') }, ['jql'], false, 'JQL 搜索；Cloud 使用 nextPageToken，Data Center 使用 startAt'),
      operation('issue', '读取工单', issue, ['issueKey']),
      operation('create-issue', '创建工单', { projectKey: text(100), issueTypeId: text(100), summary: text(255), description: text(32000) }, ['projectKey', 'issueTypeId', 'summary'], true),
      operation('comment', '添加工单评论', Object.assign({}, issue, { text: text(32000) }), ['issueKey', 'text'], true),
      operation('transitions', '查看可用状态流转', issue, ['issueKey']),
      operation('transition', '流转工单状态', Object.assign({}, issue, { transitionId: text(100) }), ['issueKey', 'transitionId'], true, '先查询 transitions，使用返回的 transitionId'),
    ] },
    { id: 'confluence', name: 'Confluence 文档与知识库', description: '搜索、读取、创建和更新文档', fields: [Object.assign({}, base, { hint: 'Cloud 通常为 https://站点.atlassian.net/wiki；Data Center 包含实际部署路径' }), deployment, auth, username, token, ca], operations: [
      operation('search', '搜索文档', { cql: text(8000), start: integer(0, 1000000, 'Data Center 分页偏移'), cursor: text(8000, 'Cloud 上一页返回的 nextCursor'), limit: integer(1, 100) }, ['cql'], false, 'CQL 搜索；Cloud 使用 cursor，Data Center 使用 start'),
      operation('page', '读取文档', { pageId: text(100) }, ['pageId']),
      operation('create-page', '创建文档', { spaceId: text(100, 'Cloud 空间 ID'), spaceKey: text(100, 'Data Center 空间 Key'), parentId: text(100), title: text(255), content: content }, ['title', 'content'], true),
      operation('update-page', '更新文档', { pageId: text(100), title: text(255), version: integer(2, 2147483647, '当前页面版本 + 1；冲突时重新读取'), content: content }, ['pageId', 'title', 'version', 'content'], true),
    ] },
    { id: 'jenkins', name: 'Jenkins 持续集成与构建', description: '查询构建任务、状态和日志，触发构建', writeLabel: '允许触发构建', fields: [base, Object.assign({}, username, { required: true }), Object.assign({}, token, { label: 'Jenkins API Token', hint: '使用用户 API Token；不使用登录密码' }), ca], operations: [
      operation('jobs', '列出构建任务', { folder: text(1000, '可选文件夹路径，例如 team/backend') }, []),
      operation('build', '读取构建状态', build, ['job']),
      operation('log', '读取构建日志', Object.assign({}, build, { start: integer(0, Number.MAX_SAFE_INTEGER, '字节偏移，首次填 0；后续使用 nextStart') }), ['job'], false, '增量日志；单次最多返回 64 KiB，使用 nextStart 继续读取'),
      operation('trigger', '触发构建', Object.assign({}, job, { parameters: { type: 'object', maxProperties: 50, propertyNames: text(100), additionalProperties: { type: 'string', maxLength: 8000 } } }), ['job'], true, '返回排队 ID；通过 queue 获取构建号，再用 build 查询完成状态'),
      operation('queue', '查询构建队列', { queueId: integer(1, Number.MAX_SAFE_INTEGER) }, ['queueId']),
    ] },
    { id: 'gitlab', name: 'GitLab 代码仓库与流水线', description: '查询项目、创建合并请求、触发流水线及读取作业日志', writeLabel: '允许写入 / 触发流水线', fields: [Object.assign({}, base, { hint: '例如 https://gitlab.example.com，末尾不要添加 /api/v4' }), token, ca], operations: [
      operation('projects', '搜索项目', Object.assign({}, page, { search: text(500) }), []),
      operation('merge-requests', '列出合并请求', Object.assign({}, page, project, { state: { enum: ['opened', 'closed', 'merged', 'all'] } }), ['project']),
      operation('merge-request', '读取合并请求', Object.assign({}, project, { iid: integer(1, 2147483647) }), ['project', 'iid']),
      operation('create-merge-request', '创建合并请求', Object.assign({}, project, { sourceBranch: text(500), targetBranch: text(500), title: text(255), description: text(32000) }), ['project', 'sourceBranch', 'targetBranch', 'title'], true),
      operation('pipelines', '列出流水线', Object.assign({}, page, project, { ref: text(500) }), ['project']),
      operation('pipeline', '读取流水线状态', Object.assign({}, project, { pipelineId: integer(1, Number.MAX_SAFE_INTEGER) }), ['project', 'pipelineId']),
      operation('run-pipeline', '触发流水线', Object.assign({}, project, { ref: text(500), variables: { type: 'array', maxItems: 50, items: object({ key: text(100), value: { type: 'string', maxLength: 8000 } }, ['key', 'value']) } }), ['project', 'ref'], true),
      operation('pipeline-jobs', '列出流水线作业', Object.assign({}, page, project, { pipelineId: integer(1, Number.MAX_SAFE_INTEGER) }), ['project', 'pipelineId']),
      operation('job-log', '读取作业日志', Object.assign({}, project, { jobId: integer(1, Number.MAX_SAFE_INTEGER) }), ['project', 'jobId'], false, '最多返回日志前 64 KiB，truncated 表示还有内容'),
    ] },
    { id: 'redis', name: 'Redis 缓存与键值数据库', description: '扫描键名、读取数据、写入字符串及删除键', fields: [
      field('host', '主机', { required: true, default: '127.0.0.1', maxLength: 255 }),
      field('port', '端口', { type: 'number', default: 6379, min: 1, max: 65535 }),
      field('database', '数据库编号', { type: 'number', default: 0, min: 0, max: 1024 }),
      field('username', 'ACL 用户名（可留空）'), field('password', '密码', { secret: true, maxLength: 4096 }),
      field('tls', '启用 TLS', { type: 'checkbox', default: false }), ca,
    ], operations: [
      operation('scan', '扫描键名', { cursor: { type: 'string', pattern: '^[0-9]+$', maxLength: 30 }, pattern: text(2000), count: integer(1, 100) }, [], false, '使用 SCAN，首次 cursor=0，直到返回 cursor=0；COUNT 是提示值，结果可能重复'),
      operation('get', '读取字符串', key, ['key']),
      operation('hash', '扫描 Hash 字段', Object.assign({}, key, { cursor: { type: 'string', pattern: '^[0-9]+$', maxLength: 30 }, count: integer(1, 100) }), ['key']),
      operation('info', '查看键类型和有效期', key, ['key']),
      operation('set', '写入字符串', Object.assign({}, key, { value: { type: 'string', maxLength: 524288 }, ttlSeconds: integer(1, 2147483647, '可选有效期；省略时持久保存并清除旧 TTL') }), ['key', 'value'], true),
      operation('delete', '删除单个键', key, ['key'], true),
    ] },
    { id: 'ssh', name: 'SSH 远程服务器', description: '执行远程命令并读取输出', writeLabel: '允许执行命令', fields: [
      field('host', '主机', { required: true, maxLength: 255 }), field('port', '端口', { type: 'number', default: 22, min: 1, max: 65535 }),
      field('username', '用户', { required: true, maxLength: 200 }),
      field('hostFingerprint', '服务器主机密钥 SHA256 指纹', { required: true, hint: '填写可信来源的 SHA256:... 指纹；连接时必须匹配' }),
      field('password', '密码（使用私钥时可留空）', { secret: true, maxLength: 4096 }),
      field('privateKey', '私钥（PEM / OpenSSH）', { secret: true, type: 'textarea', maxLength: 65536 }),
      field('passphrase', '私钥口令（可留空）', { secret: true, maxLength: 4096 }),
    ], operations: [
      operation('exec', '执行远程命令', { command: text(32000, '在已配置主机执行的一次性命令；不分配交互终端') }, ['command'], true, '任意命令都要求开启允许执行命令；返回退出码、stdout、stderr，合计最多 64 KiB；取消不保证终止远程子进程'),
    ] },
    { id: 's3', name: 'S3 对象存储', description: '列出、读取、上传和删除对象，兼容 Amazon S3、MinIO', writeLabel: '允许上传 / 删除对象', fields: [
      field('endpoint', '自定义 Endpoint（AWS 可留空）', { type: 'url', hint: '例如 https://minio.example.com；填写 S3 API 地址，不是管理页面' }),
      field('region', 'Region', { required: true, default: 'us-east-1' }), field('bucket', 'Bucket', { required: true, maxLength: 255 }),
      field('accessKeyId', 'Access Key ID', { required: true }), field('secretAccessKey', 'Secret Access Key', { required: true, secret: true, maxLength: 8192 }),
      field('sessionToken', 'Session Token（临时凭据可用）', { secret: true, maxLength: 8192 }),
      field('forcePathStyle', '使用 Path-style（MinIO 通常需要）', { type: 'checkbox', default: false }), ca,
    ], operations: [
      operation('list', '列出对象', { prefix: { type: 'string', maxLength: 2000 }, continuationToken: text(8000), maxKeys: integer(1, 100) }, []),
      operation('get', '读取对象', Object.assign({}, key, { versionId: text(2000), encoding: { enum: ['text', 'base64'] } }), ['key'], false, '读取最多 1 MiB 的完整对象；过大时拒绝返回，二进制使用 base64'),
      operation('put', '上传对象', Object.assign({}, key, { content: { type: 'string', maxLength: 1398104 }, encoding: { enum: ['text', 'base64'] }, contentType: text(200), overwrite: { type: 'boolean', description: '默认 false，对象已存在时拒绝覆盖' } }), ['key', 'content'], true),
      operation('delete', '删除对象', Object.assign({}, key, { versionId: text(2000, '可选指定版本；删除指定版本不可恢复') }), ['key'], true),
    ] },
  ];
  var catalog = { kinds: kinds, object: object, text: text, deletionGuidance: deletionGuidance };
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.PageAgentDevToolsCatalog = catalog;
})(globalThis);
