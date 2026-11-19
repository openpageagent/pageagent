(function (root) {
  'use strict';
  var support = root.ResourceModuleSupport, Source = root.PageAgentSourceCode;
  function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
  function error(code, message) { return root.AgentResourceProtocol.arpError(code, message, { performed: 'no', stage: 'plugin-validation' }); }
  function sourceFiles(definition) {
    var metadata = Object.assign({}, definition); delete metadata.files; delete metadata.javascript;
    return Object.assign({}, definition.files, { 'plugin.json': JSON.stringify(metadata, null, 2) });
  }
  function definitionFromFiles(files) {
    var value;
    try { value = JSON.parse(files['plugin.json']); }
    catch (_) { throw error('SCHEMA_VALIDATION_FAILED', 'plugin.json 必须是有效 JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.files !== undefined || value.javascript !== undefined) throw error('SCHEMA_VALIDATION_FAILED', 'plugin.json 必须是插件元数据对象，源码请通过独立文件编辑');
    var sources = Object.assign({}, files); delete sources['plugin.json'];
    if (Object.keys(sources).length) value.files = sources;
    return value;
  }
  function sourceFileName(name) { return name === 'plugin.json' ? name : root.PageAgentUserPlugin.fileName(name); }
  function createAdapter(runtime) {
    var routes = [], handlers = { GET: {}, POST: {}, PUT: {}, DELETE: {} };
    var definition = root.PageAgentUserPlugin.schema;
    var revision = { type: 'integer', minimum: 1 };
    var fileQuery = Source.querySchema(revision), includeDiff = Source.includeDiffSchema;
    var fileGuidance = [
      'GET /plugins/{pluginId}/files 返回文件清单和 revision；plugin.json 是配置、入口和权限等元数据的文件视图，不包含 files。内置源码只读，先复制再修改。',
      '单文件 GET 提供 q 按 grep 搜索，fixedStrings 对应 -F，before/after 对应 -B/-A；不提供 q 则按 startLine/startColumn/limit 读取，默认 50 行。hasMore=true 时按 nextLine/nextColumn 续读并携带 revision；版本变化须重新读取。',
      '局部修改优先 POST /plugins/{pluginId}/edits，提交 revision 和 edits:[{fileName,oldText,newText}]；oldText 必须非空且唯一匹配，复用仍有效的原文片段，无需读取或重传整个文件。插入时保留原文锚点，删除时 newText 为空。',
      '所有 edits 依次作用于前项结果，全部匹配并通过定义与语法校验才保存。任一项失败或 revision 冲突均不覆盖；重新读取相关片段后调整。换行沿用目标文件 LF/CRLF，保留未修改内容。',
      'PUT /plugins/{pluginId}/files/{fileName} 提交 {revision,source} 新增或完整替换文件；只有全文替换才必须读齐并保留未修改内容，不能用片段覆盖全文。DELETE 提交 {revision}，不可删除 plugin.json 或当前入口；需同时移除引用。写入沿用插件启停状态，已启用插件会重新加载。',
      '写入回执含 saved、revision 和 diff。通常省略 includeDiff；小改动自动返回，较大改动仅确需时显式请求。diff 比较保存前与实际保存后的文件，包含文件名、行号和上下文。收到后核对位置、增删内容和范围，diff 不表示功能验证通过。',
      'diff.status=skipped/unavailable 或 truncated=true 不代表保存失败；不要重试已成功的编辑，也不能声称核对了完整差异。仅对缺少证据的位置按 changes 中 uri 搜索或补读；available 且 changes 为空才表示没有净变化。',
    ];
    function read(uri, type, summary, value) {
      routes.push(support.route({ template: uri, resourceType: type, relation: type,
        summary: summary, methods: { GET: support.read(support.EMPTY_QUERY, 'plugins.read', type, summary) } }));
      handlers.GET[uri] = async function (request, context) {
        if (!context.pluginId) await runtime.initialized;
        return { statusCode: 200, primary: { uri: request.uri, type: type, data: value() } };
      };
    }
    read('/plugins', 'PluginCollection', '内置及自建 Cordis 插件、版本和运行状态', function () { return { items: runtime.list() }; });
    read('/plugins/contributions', 'PluginContributions', '插件提供的能力、流程节点、工具及应用模板', function () { return runtime.host.contributions(); });
    read('/plugins/authoring', 'PluginAuthoring', '对话现场编写插件：声明能力、订阅消息，由 Cordis 管理，JavaScript 处理函数在沙箱运行', function () {
      return {
        schema: definition,
        lifecycle: 'POST /plugins 创建；GET /plugins/{id} 读取源码和 revision；POST /plugins/{id} 携带 revision 完整更新。新建默认使用 enabled=false，更新保留原启停状态，按用户要求启用。保存前校验定义及处理函数语法，失败不替换旧定义。无草稿或发布版本，revision 仅防止并发覆盖；enabled=true 保存后自动重新加载，状态 loading/active/failed 以再次读取为准。自建插件启动失败或处理函数抛出未处理异常时自动停用，保存错误原因；修复后再显式启用。正常取消调用不会自动停用。停用或更新会释放能力、订阅和正在运行的调用。',
        copies: '内置插件源码只读，GET /plugins/{id}/files 列出源码文件，GET /plugins/{id} 可读取完整 definition.files 和 entry。向 POST /plugins/{id}/copies 提交新 id、name 和源 revision，复制全部源码文件与配置，生成停用的独立副本。编辑副本文件后保存，运行修改后的源码。base=messaging 标记平台对话通道，不替代副本源码；保存时补充内置指令所需权限，不能超过调用方授权。副本不继承开发话题和运行会话。',
        files: fileGuidance,
        configuration: '插件作者负责在 configSchema 中声明配置表单，管理页不提供原始 JSON 编辑框。根声明 type:object 和 properties；每个字段写清 title、description、type，required 声明必填项。title 为简短字段名，description 为简洁说明。插件 description 为简短用途摘要，在列表类型标签后展示；详细配置说明放在 configSchema 或字段的 description，统一显示在编辑区顶部默认关闭的折叠项，内置与自建插件一致。无需自行实现说明界面，不把说明拼进字段名称或配置值，不在多个字段重复通用说明。支持 string、number、integer、boolean、嵌套 object 和带 items 的 array；enum 显示下拉框，oneOf:[{const:值,title:名称}] 可为选项命名。writeOnly:true 或 format:password 显示密码框，format:multiline 显示多行文本，readOnly:true 禁止编辑；minLength/maxLength、minimum/maximum、minItems/maxItems 等规则仍由保存接口校验。config 提供可用的初始配置，Schema 的 default 不会自动填充已有配置；列表新增项可采用 items.default。不使用 $ref、anyOf、allOf 或复杂 oneOf 描述表单，普通 object 要声明 properties，array 要声明单一 items Schema。不需要配置时使用空 properties；模块可导出 configSchema，声明式处理函数插件在 plugin.json 中填写。',
        modules: 'files 保存文件名到源码的映射，entry 指向 JS 入口，默认 index.js；最多 20 个 JS/JSON 文件，总大小 256 KB，不含目录，plugin.json 是元数据编辑视图的保留名称。用 module.exports = { apply(ctx, config) { ... } } 导出插件，也可导出 { configSchema, plugin: { apply } }。通过 require("./helpers.js") 或 require("./data.json") 引用插件内文件，JS 使用 CommonJS 导出；不支持 npm、外部路径或直接访问扩展 API。ctx.pageAgent 提供 registerCapability（execute(input, call)）、registerNode、registerUtility、registerApp、events.on/emit、arp、serverArp、conversation 和 signal。call 提供 signal、idempotencyKey、arp、serverArp，能力内部使用 call 保留调用者权限；自主任务使用 ctx.pageAgent。模块在现有沙箱保持启用期内的状态，Cordis 释放注册和调用。setTimeout/setInterval 会随停用清理，ctx.on("dispose", callback) 注册清理。平台源码中的 chrome.storage.local 是按插件隔离的 get(string)/set(object) 兼容接口。启动、回调或定时器异常会自动停用插件。',
        handlers: 'code 是异步 JavaScript 函数体。await api.ctx.get() 返回 {input,message,config}；也可 get("input")。能力用 return 返回 JSON；订阅通过 api.messaging.reply(text) 回复原消息，返回值不自动发送。处理函数使用现有脚本沙箱，单次调用最长 60 秒；未处理的执行异常或超时会自动停用插件。无独立 Worker，超时和停用不能强制打断同步死循环。不要依赖沙箱全局状态，不支持 require 或 npm 模块。',
        resources: '模块通过 ctx.pageAgent.arp(method, {uri,body,...}) 调用资源，能力内部使用 call.arp，写操作提供 idempotencyKey。capabilities/subscriptions 中的独立函数体使用 api.resources.request，幂等键由宿主生成。两者均返回完整 ARP 信封：检查 error，读取 primary.data。permissions 只填写实际需要且当前助手已有的资源权限；能力嵌套调用保留调用方权限。permissions 不代替消息来源与指令授权，消息处理代码须自行检查配置中的授权。',
        messageAuthorization: '除非用户明确提出额外要求，接收平台消息的插件默认采用内置平台消息的账号与指令授权格式。config.authorizations 为数组，每项为 {connectionId,accountId,commands}；新建默认 []，用户已明确指定的授权可填入配置，修改已有插件时保留既有授权，不从消息历史推定授权。configSchema.properties.authorizations 声明 type:array、title:接受的账号、format:message-accounts；items 声明 type:object、properties 和 required:[connectionId,accountId,commands]，两个 ID 为 string，commands 为 type:array、title:允许的指令、uniqueItems:true、items:{type:string,enum:本插件支持的指令名列表}，指令名不含 /。该表单可选择多个账号并为每个账号单独开启指令，新增账号的 commands 默认为 []；自然语言接收按需以 chat 单独授权。处理代码从 config.authorizations 读取授权，在业务执行前匹配消息的连接、账号和指令；未选择账号或未开启指令时不执行。默认覆盖所选账号的所有发送者和会话，仅用户明确要求时增加来源限制或固定绑定。缺少账号时仍可交付空授权的可配置插件，不在源码、subscriptions 或 Schema 的 const/单值 enum 中锁定具体平台、连接、账号、频道、发送者或启用项。configSchema 只提供表单和配置校验，不会自动过滤消息；base=messaging 用于平台对话通道，普通消息接收和此表单无需该标记。',
        messages: '通用消息插件使用模块监听 messaging:dispatch，从 event.data 读取消息并按 messageAuthorization 检查授权，返回 true 表示接管。声明式 subscriptions 要求精确指定 connectionId/accountId/channelId/userId，可选 command（不含 /），仅在用户明确要求固定来源时采用。所有插件按 priority 从高到低分发，同级按插件注册顺序，插件内按订阅注册顺序；首个接管后停止。全部插件均未接管后，按同样顺序分发 messaging:unmatched，首个返回 true 后停止；平台消息插件据此为已选择账号的未匹配指令回复提示，config.unmatchedCommand 为 reply（默认）或 ignore。priority 为整数，普通插件默认 0，平台消息默认 -100 兜底，也可调整；平台消息范围为 all，无触发规则。POST /plugins/{id}/configuration 可提交 priority，省略则保留当前值。messaging:message 仅观察。message.command 提供 name/text/args。额外指令和消息逻辑通过独立插件实现。浏览器及服务端连接须在线。',
        capabilities: '能力自动出现在 /plugins/contributions；POST /plugin-{id}/capabilities/{capabilityId} 执行，调用方需要 plugins.execute 及处理函数实际使用的资源权限。node=true 提供流程节点，utility=true 且 safety=read 提供工具箱工具。',
        applications: '打开应用用 POST /apps/{id}/open，body={input:启动参数}，参数来自 GET /apps/{id} 的 slots.published.parameters；调用动作使用 /apps/{id}/actions/{name}/runs。流程和内置工具沿用各自资源接口。',
        example: { id: 'text-helper', name: '文本助手', enabled: false, config: {}, permissions: [], subscriptions: [], capabilities: [
          { id: 'trim', label: '去除首尾空白', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            outputSchema: { type: 'string' }, safety: 'read', node: true, utility: true, code: 'const input = await api.ctx.get("input"); return input.text.trim();' },
        ] },
      };
    });
    // Extend the collection route without registering a duplicate path.
    routes[0] = support.route(Object.assign({}, routes[0], { methods: Object.assign({}, routes[0].methods, {
      POST: support.create(definition, 'plugins.write', 'plugin-create', '创建并保存自建插件，enabled=true 时由 Cordis 加载；先读取 /plugins/authoring'),
    }) }));
    var updateSchema = Object.assign({}, definition, { properties: Object.assign({}, definition.properties, { revision: revision }), required: definition.required.concat(['revision']) });
    routes.push(support.route({ template: '/plugins/{pluginId}', resourceType: 'PluginDefinition', relation: 'plugin', summary: '读取、完整更新或删除自建插件；内置插件源码只读', methods: {
      GET: support.read(support.EMPTY_QUERY, 'plugins.read', 'plugin', '读取插件源码、配置、状态和 revision'),
      POST: support.create(updateSchema, 'plugins.write', 'plugin-save', '携带当前 revision 完整更新自建插件，替换旧实例'),
      DELETE: support.method({ type: 'object', properties: { revision: revision }, required: ['revision'], additionalProperties: false },
        { safety: 'write', idempotency: 'keyed', permissions: ['plugins.write'], relation: 'plugin-delete', summary: '携带当前 revision 删除自建插件并释放其注册' }),
    } }));
    routes.push(support.route({ template: '/plugins/{pluginId}/configuration', resourceType: 'PluginConfiguration', relation: 'plugin-configuration', summary: '启停插件或保存配置', methods: {
      POST: support.create({ type: 'object', properties: { enabled: { type: 'boolean' }, priority: definition.properties.priority, config: { type: 'object' }, revision: revision },
        required: ['enabled', 'config', 'revision'], additionalProperties: false }, 'plugins.write', 'plugin-configuration', '依据当前 configSchema 和 revision 保存配置并启停插件'),
    } }));
    routes.push(support.route({ template: '/plugins/{pluginId}/copies', resourceType: 'PluginDefinition', relation: 'plugin-copy', summary: '复制完整源码及配置为停用的独立插件', methods: {
      POST: support.create({ type: 'object', properties: { id: definition.properties.id, name: definition.properties.name, revision: revision },
        required: ['id', 'name', 'revision'], additionalProperties: false }, 'plugins.write', 'plugin-copy', '依据源 revision 复制插件；副本不继承话题关联和运行中的会话'),
    } }));
    routes.push(support.route({ template: '/plugins/{pluginId}/files', resourceType: 'PluginSourceFiles', relation: 'plugin-files', summary: '读取源码文件清单及当前 revision', guidance: fileGuidance, methods: {
      GET: support.read(object({ revision: revision }), 'plugins.read', 'plugin-files', '列出 JS/JSON 文件与 plugin.json 元数据文件，不返回全文'),
    } }));
    routes.push(support.route({ template: '/plugins/{pluginId}/files/{fileName}', resourceType: 'PluginSourceFile', relation: 'plugin-file', summary: '读取、查找、新增、完整替换或删除插件文件', guidance: fileGuidance, methods: {
      GET: support.read(fileQuery, 'plugins.read', 'plugin-file', '按行读取或 grep 查找文件；参数与应用源码一致，revision 使用插件的整数 revision'),
      PUT: support.method(object({ revision: revision, source: { type: 'string' }, includeDiff: includeDiff }, ['revision', 'source']),
        { safety: 'write', idempotency: 'keyed', permissions: ['plugins.write'], relation: 'plugin-file', summary: '携带 revision 新增或完整替换一个文件，其余文件保持不变；返回保存回执和 diff' }),
      DELETE: support.method(object({ revision: revision, includeDiff: includeDiff }, ['revision']),
        { safety: 'write', idempotency: 'keyed', permissions: ['plugins.write'], relation: 'plugin-file', summary: '携带 revision 删除文件并校验剩余定义；返回保存回执和 diff' }),
    } }));
    routes.push(support.route({ template: '/plugins/{pluginId}/edits', resourceType: 'PluginSourceEdits', relation: 'plugin-edits', summary: '精确替换源码片段并返回保存后的 diff', guidance: fileGuidance, methods: {
      POST: support.create(object({ revision: revision, includeDiff: includeDiff, edits: {
        type: 'array', minItems: 1, maxItems: 50, items: object({
          field: { const: 'files', description: '可省略；兼容应用的 field=files 编辑格式' },
          fileName: { type: 'string', pattern: definition.properties.files.propertyNames.pattern },
          oldText: Source.editProperties.oldText, newText: Source.editProperties.newText,
        }, ['fileName', 'oldText', 'newText']),
      } }, ['revision', 'edits']), 'plugins.write', 'plugin-edits', '携带 revision 和幂等键依次精确替换，全部校验后原子保存；小改动默认返回 diff', { modelProjection: { type: 'data' } }),
    } }));
    function handle(method, uri, work, type) {
      handlers[method][uri] = async function (request, context) {
        if (!context.pluginId) await runtime.initialized;
        return { statusCode: 200, primary: { uri: request.uri, type: type || 'PluginDefinition', data: await work(request, context) },
          receipt: { performed: method === 'GET' ? 'no' : 'yes' } };
      };
    }
    async function currentFiles(request, write) {
      var current = await runtime.definition(request.params.pluginId);
      var expected = write ? request.body.revision : request.query && request.query.revision;
      if (expected !== undefined && expected !== current.revision) throw error('PRECONDITION_FAILED', '插件已变化，请重新读取相关源码后调整');
      if (write && current.source !== 'user') throw error('FORBIDDEN', '内置源码只读，请先复制插件');
      return current;
    }
    function sourceDiff(before, saved, expectedFiles, inputChars, requested) {
      return Source.diff({ beforeRevision: before.revision, afterRevision: saved.revision, inputChars: inputChars, includeDiff: requested,
        readChanges: async function () {
          var actual = await runtime.definition(saved.id);
          if (actual.revision !== saved.revision) return { reason: 'revision_changed' };
          var previous = sourceFiles(before.definition), next = sourceFiles(actual.definition);
          // Saving may normalize plugin.json (for example, the exported configSchema).
          if (Object.keys(expectedFiles).concat(Object.keys(next)).some(function (name) {
            return name !== 'plugin.json' && expectedFiles[name] !== next[name];
          })) return { reason: 'saved_content_mismatch' };
          return { targets: Array.from(new Set(Object.keys(previous).concat(Object.keys(next)))).map(function (name) {
            return { path: name, before: previous[name], after: next[name], change: {
              field: 'files', fileName: name, uri: '/plugins/' + saved.id + '/files/' + name,
              kind: previous[name] === undefined ? 'added' : next[name] === undefined ? 'deleted' : 'modified',
            } };
          }) };
        } });
    }
    async function saveFiles(request, context, before, files, inputChars, appliedEdits) {
      var next = definitionFromFiles(files);
      var saved = await runtime.saveDefinition(before.id, Object.assign({}, next, { revision: before.revision }), context);
      return { id: saved.id, revision: saved.revision, saved: true, enabled: saved.enabled, state: saved.state, error: saved.error,
        appliedEdits: appliedEdits, diff: await sourceDiff(before, saved, files, inputChars, request.body.includeDiff) };
    }
    handle('GET', '/plugins/{pluginId}/files', async function (r) {
      var current = await currentFiles(r, false), files = sourceFiles(current.definition);
      return { id: current.id, name: current.name, source: current.source, revision: current.revision, entry: current.definition.entry || null,
        enabled: current.enabled, state: current.state, error: current.error,
        items: Source.list(files, '/plugins/' + current.id + '/files/') };
    }, 'PluginSourceFiles');
    handle('GET', '/plugins/{pluginId}/files/{fileName}', async function (r) {
      var name = sourceFileName(r.params.fileName), query = r.query || {};
      Source.validateQuery(query);
      var current = await currentFiles(r, false), files = sourceFiles(current.definition);
      if (!Object.prototype.hasOwnProperty.call(files, name)) throw error('RESOURCE_NOT_FOUND', '插件源码文件不存在：' + name);
      return Object.assign({ id: current.id, revision: current.revision, field: 'files', fileName: name }, Source.read(files[name], query));
    }, 'PluginSourceFile');
    ['PUT', 'DELETE'].forEach(function (method) {
      handle(method, '/plugins/{pluginId}/files/{fileName}', async function (r, c) {
        var name = sourceFileName(r.params.fileName), current = await currentFiles(r, true), files = sourceFiles(current.definition);
        var inputChars = (files[name] || '').length;
        if (method === 'PUT') { files[name] = r.body.source; inputChars += r.body.source.length; }
        else {
          if (!Object.prototype.hasOwnProperty.call(files, name)) throw error('RESOURCE_NOT_FOUND', '插件源码文件不存在：' + name);
          if (name === 'plugin.json' || name === current.definition.entry) throw error('INVALID_REQUEST', '不能删除 plugin.json 或当前入口文件；请先更改入口');
          delete files[name];
        }
        return saveFiles(r, c, current, files, inputChars, 1);
      }, 'PluginSourceEdits');
    });
    handle('POST', '/plugins/{pluginId}/edits', async function (r, c) {
      var current = await currentFiles(r, true), files = sourceFiles(current.definition);
      var inputChars = Source.applyEdits(r.body.edits, function (edit) {
        var name = sourceFileName(edit.fileName);
        return { object: files, key: name };
      });
      return saveFiles(r, c, current, files, inputChars, r.body.edits.length);
    }, 'PluginSourceEdits');
    handle('POST', '/plugins', function (r, c) { return runtime.saveDefinition(null, r.body, c); });
    handle('GET', '/plugins/{pluginId}', function (r) { return runtime.definition(r.params.pluginId); });
    handle('POST', '/plugins/{pluginId}', function (r, c) { return runtime.saveDefinition(r.params.pluginId, r.body, c); });
    handle('DELETE', '/plugins/{pluginId}', function (r) { return runtime.remove(r.params.pluginId, r.body.revision); });
    handle('POST', '/plugins/{pluginId}/configuration', function (r, c) { return runtime.update(r.params.pluginId, r.body, c); });
    handle('POST', '/plugins/{pluginId}/copies', function (r, c) { return runtime.copy(r.params.pluginId, r.body, c); });
    return root.ResourceModuleAdapter.create({ root: 'plugins', resource: { routeContracts: routes, handlers: handlers } });
  }
  root.PluginResource = Object.freeze({ createAdapter: createAdapter });
})(globalThis);
