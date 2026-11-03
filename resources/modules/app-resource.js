(function (root) {
  'use strict';
  var C = root.AppContract, S = root.ResourceModuleSupport;
  function trusted(context) { return String(context && (context.actorId || context.actor) || '').startsWith('ui:'); }
  function validationError(code, message) {
    return root.AgentResourceProtocol.arpError(code, message, { performed: 'no', stage: 'app-validation' });
  }
  function validateSourceFileName(name) {
    try { return C.sourceFileName(name); }
    catch (error) { throw validationError(error.code || 'INTERNAL_ERROR', error.message); }
  }
  // Reading process knowledge is not a write precondition. Validate the
  // actual source on every save, independently of turns or worker restarts.
  function assertGeneratedCode(context, code) {
    if (trusted(context)) return;
    if (code && !code.customBehavior.length && [code.javascript].concat(Object.keys(code.files || {}).filter(function (name) { return name.endsWith('.js'); }).map(function (name) { return code.files[name]; })).some(function (source) { return /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|chrome\s*\.)/.test(source); })) throw validationError('SCHEMA_VALIDATION_FAILED', '默认生成代码包含非 SDK 调用。请改为 SDK；只有用户明确要求的例外才可记录为 customBehavior。此检查不是任意代码的安全审计。');
  }
  var body = C.object({ name: { type: 'string', minLength: 1, maxLength: C.limits.nameLength }, icon: { type: 'string', enum: Object.keys(C.ICONS) }, description: { type: 'string' }, code: C.codeSchema, generationScope: { type: 'array', uniqueItems: true, items: { type: 'string', enum: C.CAPABILITIES } }, sourceConversationId: { type: 'string' } }, ['name', 'code']);
  body.properties.icon.description = '应用图标 ID，只能使用 GET /apps/capabilities/ui/icons 返回的 icons；与管理界面的图标目录一致。单独修改图标时 PATCH /apps/{appId}，只提交 icon，无需源码或发布。';
  body.properties.slug = { type: ['string', 'null'], description: '应用别名：1–64 位英文字母、数字，以单个横线连接；自动转小写，同一普通／隐身范围内唯一。空值清除；保存时省略则保留。不能使用 source、capabilities、dependency。保存后立即生效，旧 ID 链接仍可用。' };
  var saveBody = C.object({ name: body.properties.name, slug: body.properties.slug, icon: body.properties.icon, description: body.properties.description, code: C.codeSchema }, ['name', 'code']);
  var metadataPatch = C.object({ name: body.properties.name, slug: body.properties.slug, icon: body.properties.icon, description: body.properties.description });
  metadataPatch.minProperties = 1;
  var codePatch = C.object(C.codeSchema.properties);
  codePatch.minProperties = 1;
  var AUTO_DIFF_MAX_CHARS = 4000;
  var sourceEdit = C.object({
    field: { type: 'string', enum: ['html', 'css', 'javascript', 'themeCss', 'description', 'files'] },
    fileName: { type: 'string', description: '仅 field=files 时必填，指定已存在的 JS/CSS 文件名' },
    oldText: { type: 'string', minLength: 1, description: '从当前草稿读取的原文片段，须恰好匹配一次；可跨行，保留缩进，重复时补充上下文' },
    newText: { type: 'string', description: '替换后的片段；空字符串表示删除，插入时保留 oldText 锚点并加入新内容。沿用周围缩进和换行，不压缩源码' }
  }, ['field', 'oldText', 'newText']);
  var sourceEdits = C.object({
    edits: { type: 'array', minItems: 1, maxItems: 50, items: sourceEdit, description: '按顺序在前一项结果上匹配并替换，全部成功后原子保存；可只提交一项' },
    includeDiff: { type: 'boolean', description: '通常省略，由系统在所有 oldText 与 newText 的字符数合计不超过 ' + AUTO_DIFF_MAX_CHARS + ' 时自动返回 diff；仅本次确需大改动的 diff 时传 true，不要固定为 true；false 关闭。跳过时不为 diff 回读草稿；显式请求仍受输出长度与计算时间限制。须随本次编辑提交，不要重放成功的编辑来补取 diff。' }
  }, ['edits']);
  var sourceEditResult = C.object({
    appId: { type: 'string' }, revision: { type: 'string' }, saved: { type: 'boolean', const: true },
    unpublished: { type: 'boolean' }, appliedEdits: { type: 'integer', minimum: 1 },
    links: C.object({ preview: { type: 'string' } }, ['preview']), diff: { type: 'object' }
  }, ['appId', 'revision', 'saved', 'unpublished', 'appliedEdits', 'links', 'diff']);
  var grepProperties = root.KnowledgeSearch.GREP_QUERY_PROPERTIES;
  var fieldQuery = C.object({
    q: Object.assign({}, grepProperties.q, { minLength: 1, description: '提供 q 即按标准 grep 搜索此文本字段；省略则按行读取。正则最多 256 字符，fixedStrings=true 时按字面匹配、最多 4096 字符。' }),
    fixedStrings: grepProperties.fixedStrings,
    caseSensitive: grepProperties.caseSensitive,
    before: Object.assign({}, grepProperties.before, { description: '同 grep -B：返回每个命中前的行数，默认 0、最多 20；须与 q 同用' }),
    after: Object.assign({}, grepProperties.after, { description: '同 grep -A：返回每个命中后的行数，默认 0、最多 20；须与 q 同用' }),
    startLine: { type: 'integer', minimum: 1, description: '读取起始行号，默认 1；不能与 q 同用' },
    startColumn: { type: 'integer', minimum: 1, description: '起始行的列号，默认 1；用于续读长行，不能与 q 同用' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: '读取行数或搜索命中数上限；读取默认 50 行、搜索默认 5 个命中行，不计附带的前后行' },
    revision: { type: 'string', minLength: 1, maxLength: 100, description: '续读时传入上一页 revision；版本变化则拒绝读取' }
  });
  var FIELD_REPLACEMENT_GUIDANCE = '局部源码修改优先 POST /apps/{appId}/draft/edits，只提交 edits:[{field,oldText,newText}]；修改源码文件时 field=files 并提供 fileName。复用上下文中仍有效的原文，仅在缺失时搜索定位并读取足以唯一匹配的片段，无需读齐或重传整个字段、文件。PATCH /draft 的 code 字段和单文件 PUT 仍为整体替换，仅此时必须读齐目标并保留未修改内容，不能用片段覆盖全文。';
  var routes = [];
  function route(template, type, methods, options) {
    options = options || {};
    routes.push(S.route({ template: template, resourceType: type, relation: 'apps', summary: C.guidance, tags: ['apps', '应用'], entryWeights: { global: 30 }, guidance: [C.guidance, C.parameterGuidance].concat(options.guidance || []), affordances: options.affordances, methods: methods }));
  }
  route('/apps', 'AppCollection', {
    GET: S.read(C.object({ prefix: { type: 'string' }, sort: { type: 'string', enum: ['used', 'updated'] }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }), 'apps.read', 'apps', '按名称前缀、最近使用或更新分页查询应用，返回应用生成知识入口'),
    POST: S.create(body, 'apps.write', 'apps', '创建完整草稿并返回应用摘要与预览入口')
  }, {
    affordances: [{
      method: 'GET', href: '/apps', rel: 'app-development',
      title: '用户可在任意对话阶段要求创建、编辑或修复应用；意图明确后读取 /apps 或目标应用，当前上下文缺少完整生成指引时再读取。同一对话复用已读指引，无需每轮重读或重新开始对话。'
    }, {
      method: 'GET', href: '/apps/capabilities/ui/icons', rel: 'app-icons',
      title: '读取当前可用图标 ID 目录；应用图标和页面图标只能从返回的 icons 中选择。'
    }]
  });
  route('/apps/capabilities', 'AppCapabilities', { GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app-capabilities', '读取 SDK 契约、默认 UI 模板、默认生成范围和限制') });
  route('/apps/capabilities/ui/{componentId}', 'AppUiComponent', { GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app-ui-component', '读取应用 UI 组件的接口、主题、生命周期和使用示例；componentId=icons 返回当前可用图标目录') });
  route('/apps/dependency', 'AppDependency', { GET: S.read(C.object({ uri: { type: 'string' } }, ['uri']), 'apps.read', 'app-dependency', '读取实际依赖内容、指纹及运行要求') });
  route('/apps/{appId}', 'App', {
    GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app', '读取应用摘要和最新权限，不读取源码'),
    PATCH: S.patch('apps.write', 'app', '带 If-Match 局部修改名称、应用别名、图标或描述，立即生效；只提交变更字段，无需读取或提交源码，不改变草稿和发布状态', metadataPatch),
    DELETE: S.remove('apps.delete', 'app', '删除应用并使 SDK 会话和授权失效')
  }, {
    guidance: [
      '仅修改名称、应用别名、图标或描述时使用本资源 PATCH，无需读取源码。修改源码、主题、功能声明或依赖时，先读取本应用最新摘要与权限，再通过 /apps/{appId}/draft/{field} 独立读取待修改字段；已发布版本用 /apps/{appId}/published/{field}。',
      '源码修改保存到草稿，不改变已发布版本；发布按用户意图单独执行。草稿预览使用实例内的临时数据，发布页使用正式业务数据。',
      '单独修改图标：先 GET /apps/capabilities/ui/icons，从返回的 icons 中选择 ID，再以本应用最新 ETag 和 idempotencyKey 提交 PATCH，patch 仅包含 {"icon":"所选图标 ID"}。立即生效，无需保存草稿或发布；目录外的图标会被拒绝。',
      '功能声明不等于实际授权，权限由用户在配置中心独立调整；SDK 执行器在每次调用时按最新权限校验。'
    ]
  });
  route('/apps/{appId}/draft', 'AppDraft', {
    GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app-draft', '读取完整草稿；独立读取或搜索请使用 /apps/{appId}/draft/{field}'),
    PUT: S.replace(saveBody, 'apps.write', 'app-draft', '带 If-Match 原子保存完整草稿；不能修改权限或生成范围'),
    PATCH: S.patch('apps.write', 'app-draft', '带 If-Match 替换指定 code 字段；省略字段保留，指定字段整体替换（包括 files 映射）。源码片段修改优先 POST /draft/edits；完整替换单文件使用 /draft/files/{fileName}。合并后校验并保存草稿，不修改实际授权', C.object({ code: codePatch }, ['code']))
  }, {
    guidance: [
      FIELD_REPLACEMENT_GUIDANCE,
      '修改前读取 /apps/{appId} 的最新摘要与权限；PATCH 只提交变更的 code 字段，携带摘要 ETag 和幂等键。保存后返回资源提供的预览入口。'
    ]
  });
  route('/apps/{appId}/draft/edits', 'AppSourceEdits', {
    POST: S.create(sourceEdits, 'apps.write', 'app-source-edits', '带 If-Match 和幂等键精确替换草稿源码片段；只提交原文与新文，无需完整字段或文件。所有片段依次匹配成功并校验后原子保存，返回精简保存回执和最新 ETag。小改动默认返回源码 diff，大改动须显式 includeDiff=true；收到差异后核对是否符合需求', { preconditions: ['if-match'], outputSchema: sourceEditResult, modelProjection: { type: 'data', includeEtag: true } })
  }, {
    guidance: [
      'oldText 非空且须唯一匹配，区分大小写与缩进，不使用正则或行号；支持跨行。LF/CRLF 按目标源码首次换行的风格转换，仅转换传入片段，未命中部分保持原文。无换行的源码默认使用 LF。',
      '插入时将原文锚点与新增内容一起放入 newText；删除时 newText 为空。fileName 仅 field=files 时必填，文件必须已存在；新建文件使用单文件 PUT。',
      '每项在前项编辑结果上匹配；任一项未命中、多处命中、版本冲突或校验失败都不保存。重新读取受影响的草稿片段并调整，勿盲目重试或改为全文覆盖。保存后使用返回的最新 ETag。',
      '通常省略 includeDiff；所有 oldText 与 newText 合计不超过 ' + AUTO_DIFF_MAX_CHARS + ' 字符才自动生成 diff，仅本次确需大改动的 diff 时传 true，false 关闭。跳过时返回 diff.status=skipped 和 reason，不做保存后的草稿回读或 diff 计算；不代表没有改动或保存失败。不要为补取 diff 重放已经成功的编辑。',
      '回执仅含 appId、revision、saved、unpublished、appliedEdits、links.preview 和 diff；权限与应用详情按需 GET /apps/{appId}，无需为了查看保存结果重复查询。',
      '需要 diff 时，保存成功后读取实际草稿，与修改前源码比较，diff.changes 按字段或文件返回净差异，含行号和前后最多各 2 行上下文；源码含超过 500 字符的长行时不附带未修改的上下文行。差异文本合计最多 12000 字符。收到后须核对位置、增删内容和范围，符合需求后再报告完成；diff 只供源码核对，不表示功能验证通过。',
      'diff.status=unavailable 或 diff.truncated=true 时不能声称已核对完整差异；结合完整 edits 输入、成功回执与可用差异核对已知改动，仅对仍缺少证据的位置按 changes 中的 uri 或原字段路径搜索、按行补读。相关调用关系不明时只补读相关代码，不例行重新遍历整个文件。差异不可用不撤销已经成功的保存，也不能据此重试编辑。仅当 status=available 且 changes 为空时，表示本次源码没有净变化。'
    ]
  });
  route('/apps/{appId}/published', 'AppPublished', { GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app-published', '读取完整发布源码；独立读取或搜索请使用 /apps/{appId}/published/{field}') });
  ['draft', 'published'].forEach(function (slot) {
    var fileMethods = { GET: S.read(fieldQuery, 'apps.read', 'app-source-file', '读取或搜索单个应用 JS/CSS 文件，参数与源码字段相同；先 GET /apps/{appId}/' + slot + '/files 查询文件名') };
    if (slot === 'draft') {
      fileMethods.PUT = S.replace(C.object({ source: { type: 'string' } }, ['source']), 'apps.write', 'app-source-file', '带 If-Match 新增或完整替换一个草稿源码文件，其余源码保持不变');
      fileMethods.DELETE = S.remove('apps.write', 'app-source-file', '带 If-Match 删除一个草稿源码文件；需同步移除对该文件的引用');
    }
    route('/apps/{appId}/' + slot + '/files/{fileName}', 'AppSourceFile', fileMethods, { guidance: [FIELD_REPLACEMENT_GUIDANCE, '文件名为不含目录的 JS/CSS 文件名。源码随应用保存、发布、复制和导出。内置原版只读，先复制再修改副本。'] });
    route('/apps/{appId}/' + slot + '/{field}', 'AppCodeField', {
      GET: S.read(fieldQuery, 'apps.read', 'app-code-field', '独立读取' + (slot === 'draft' ? '草稿' : '已发布') + '字段；文本加 q 即按标准 grep 搜索，fixedStrings 对应 -F、before 对应 -B、after 对应 -A；不加 q 则按行读取。数组字段直接返回 value，仅接受 revision 参数。field 可选：' + Object.keys(C.codeSchema.properties).join('、'))
    }, {
      guidance: [
        '长文本先加 q 定位命中行，再省略 q 按行读取。hasMore=true 时以 nextLine/nextColumn 作为 startLine/startColumn 续读，携带首次结果的 revision；版本变化须重新读取。',
        FIELD_REPLACEMENT_GUIDANCE,
        'field=files 返回文件清单；使用 /apps/{appId}/{slot}/files/{fileName} 读取和搜索单个文件。草稿文件的局部修改用 POST /apps/{appId}/draft/edits；新增、完整替换或删除使用单文件 PUT {source:完整源码} 和 DELETE。'
      ]
    });
  });
  route('/apps/{appId}/publish', 'AppPublication', { POST: S.create(S.EMPTY_QUERY, 'apps.write', 'app-publish', '在本地发布当前完整草稿', { preconditions: ['if-match'] }) });
  route('/apps/{appId}/copy', 'AppCopy', { POST: S.create(S.EMPTY_QUERY, 'apps.write', 'app-copy', '创建可编辑的应用副本，保留源码和主题，不复制业务数据、别名和授权', { preconditions: ['if-match'] }) });
  route('/apps/{appId}/assets/{assetName}', 'AppAsset', { PUT: S.replace(C.object({ base64: { type: 'string' }, mime: { type: 'string' } }, ['base64', 'mime']), 'apps.write', 'app-asset', '保存草稿主题图片或字体，引用 app-asset:assets/{assetName}') });
  route('/apps/{appId}/open', 'AppOpen', { POST: S.create(C.object({ input: {} }), 'apps.execute', 'app-open', '打开已发布应用；先读取 slots.published.parameters，提供 input 时按声明校验并新建标签页。缺少声明时默认 mode=none，允许省略 input 或传 {}，不执行参数处理，拒绝非空参数。宿主等待页面初始化后处理已配置的参数；返回 tabId/url 仅确认打开，不确认处理结果') });
  route('/apps/{appId}/actions/{actionName}/runs', 'AppRun', { POST: S.create(C.object({ input: {} }, ['input']), 'apps.execute', 'app-run', '按最新 SDK 授权执行已发布动作', { execution: 'async' }) });
  route('/apps/{appId}/runs/{runId}', 'AppRunStatus', { GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app-run-status', '查询属于目标应用的 Run 状态、输出和输出校验结果') });
  route('/apps/{appId}/runs/{runId}/stop', 'AppRunControl', { POST: S.create(S.EMPTY_QUERY, 'apps.execute', 'app-run-stop', '请求取消属于目标应用的 Run') });
  route('/apps/{appId}/data/{key}', 'AppData', {
    GET: S.read(S.EMPTY_QUERY, 'apps.read', 'app-data', '经应用 SDK 授权读取正式数据'),
    PUT: S.method(C.object({ value: {}, version: { type: ['string', 'null'] } }, ['value', 'version']), { safety: 'write', permissions: ['apps.write'], relation: 'app-data', summary: '按数据版本保存，null 表示仅新建' }),
    DELETE: S.method(null, { safety: 'write', permissions: ['apps.delete'], preconditions: ['if-match'], relation: 'app-data', summary: '按版本删除正式数据' })
  });
  function createAdapter(options) {
    var service = options.appService, handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    var etagService = { etag: function (value) { return '"' + (value.revision || value.version) + '"'; } };
    function expected(request) { return String(request.preconditions && request.preconditions.ifMatch || '').replace(/^"|"$/g, ''); }
    function result(request, type, data, status) { return S.result(request.uri, type, data, data.revision || data.version ? etagService : null, status); }
    async function draftForEdit(request) {
      try {
        var current = await service.getCode(request.params.appId, 'draft');
        service.store.assertEditable(current);
        if (current.revision !== expected(request)) throw validationError('REVISION_CONFLICT', '源码已变化，请重新读取最新草稿片段后调整');
        return current;
      } catch (error) {
        if (error instanceof root.AgentResourceProtocol.ArpError) throw error;
        // This phase only reads and validates; saving starts in the caller.
        throw validationError(error.code || 'INTERNAL_ERROR', error.message);
      }
    }
    async function sourceDiff(before, app, code, edits, includeDiff) {
      var diff = { beforeRevision: before.revision, afterRevision: app.revision, status: 'unavailable', truncated: false, changes: [] };
      var inputChars = edits.reduce(function (total, edit) { return total + edit.oldText.length + edit.newText.length; }, 0);
      if (includeDiff === false || includeDiff !== true && inputChars > AUTO_DIFF_MAX_CHARS) {
        diff.status = 'skipped';
        diff.reason = includeDiff === false ? 'disabled' : 'size_threshold';
        diff.inputChars = inputChars; diff.autoThreshold = AUTO_DIFF_MAX_CHARS;
        return diff;
      }
      try {
        var saved = await service.store.get('app_code', [app.appId, 'draft']);
        if (!saved || saved.revision !== app.revision) { diff.reason = 'revision_changed'; return diff; }
        if (JSON.stringify(saved.code) !== JSON.stringify(code)) { diff.reason = 'saved_content_mismatch'; return diff; }
        var targets = new Map(), budget = 12000, deadline = Date.now() + 200;
        edits.forEach(function (edit) { targets.set(edit.field === 'files' ? 'files/' + edit.fileName : edit.field, edit); });
        targets.forEach(function (edit, path) {
          var oldSource = edit.field === 'files' ? before.code.files[edit.fileName] : before.code[edit.field];
          var newSource = edit.field === 'files' ? saved.code.files[edit.fileName] : saved.code[edit.field];
          if (oldSource === newSource) return;
          var change = { field: edit.field, uri: '/apps/' + app.appId + '/draft/' + path };
          if (edit.field === 'files') change.fileName = edit.fileName;
          diff.changes.push(change);
          if (budget <= 0 || Date.now() >= deadline) {
            change.omitted = true; change.reason = budget <= 0 ? 'size_limit' : 'time_limit'; diff.truncated = true; return;
          }
          var contextLines = /[^\n]{501}/.test(oldSource) || /[^\n]{501}/.test(newSource) ? 0 : 2;
          var patch = root.Diff.structuredPatch('before/' + path, 'after/' + path, oldSource, newSource, undefined, undefined, { context: contextLines, timeout: Math.max(1, deadline - Date.now()) });
          if (!patch) { change.omitted = true; change.reason = 'time_limit'; diff.truncated = true; return; }
          var text = root.Diff.formatPatch(patch);
          change.text = text.slice(0, budget);
          change.truncated = text.length > budget;
          budget -= change.text.length;
          if (change.truncated) diff.truncated = true;
        });
        diff.status = 'available';
      } catch (error) {
        diff.changes = []; diff.reason = error.code || 'diff_unavailable';
      }
      return diff;
    }
    handlers.GET['/apps'] = async function (r) { return result(r, 'AppCollection', Object.assign(await service.store.list(r.query), { guidance: C.guidance, knowledge: '/knowledge/builtin_app_generation_guide' })); };
    handlers.GET['/apps/capabilities'] = async function (r) {
      var theme = await fetch(chrome.runtime.getURL('apps/default-theme.css'));
      if (!theme.ok) throw C.error('RESOURCE_NOT_FOUND', '应用默认样式读取失败');
      return result(r, 'AppCapabilities', {
        version: C.VERSION, generationScope: C.CAPABILITIES, resourcePermissions: service.resourceCatalog(),
        ui: root.AppUiContract.list(),
        defaults: {
          sdkEnabled: true, declaredCapabilitiesEnabled: true, resourcePermissions: service.defaultResourcePermissions(),
          parameters: C.noParameters(),
          ui: {
            themeCss: await theme.text(),
            nativeControls: {
              details: '<details><summary>更多信息</summary><p>详细内容</p></details>',
              file: '<label>选择文件<input type="file"></label>',
              progress: '<label>处理进度<progress value="30" max="100">30%</progress></label>',
              dialog: '<dialog id="dialog" aria-labelledby="dialog-title"><h2 id="dialog-title">提示</h2><p>内容</p><form method="dialog"><button>关闭</button></form></dialog>；在 javascript 的用户点击事件中调用 document.getElementById("dialog").showModal()。',
              status: '状态文本使用 status-success、status-error、status-pending；业务结果由应用实际操作返回。'
            },
            usage: '新建且用户未指定风格时，将 themeCss 全文复制到 code.themeCss，复用下方 HTML 类名；业务布局写入 code.css，并使用主题变量。主题属于应用，可修改、替换或清空；修改已有应用时保留已保存的主题，只有用户要求换肤或恢复默认时才调整。示例仅演示结构，按钮行为需在 javascript 中实现。字体使用插件内置字体及系统回退。',
            htmlExample: [
              '<main class="app-page">',
              '  <header class="app-header"><h1>应用名称</h1><p class="section-desc">功能说明</p></header>',
              '  <section class="app-panel" aria-labelledby="input-heading">',
              '    <h2 id="input-heading">输入</h2>',
              '    <div class="form-row"><label for="query">查询条件</label><input id="query" type="text" aria-describedby="query-help"><p id="query-help" class="form-help">填写需要处理的内容。</p></div>',
              '    <div class="app-actions"><button type="button" class="btn-primary">查询</button><button type="button" class="btn-secondary">清空</button></div>',
              '  </section>',
              '  <section class="app-panel" aria-labelledby="result-heading">',
              '    <h2 id="result-heading">结果</h2>',
              '    <div class="table-scroll"><table><thead><tr><th scope="col">名称</th><th scope="col">状态</th></tr></thead><tbody><tr><td colspan="2">暂无数据</td></tr></tbody></table></div>',
              '  </section>',
              '</main>'
            ].join('\n')
          }
        },
        icons: Object.keys(C.ICONS), codeSchema: C.codeSchema,
        sdk: {
          data: ['get(key)', 'list({cursor,limit})', 'set(key,value,version)', 'delete(key,version)'],
          actions: ['run(name,input,{idempotencyKey})', 'status(runId)', 'cancel(runId)'],
          apps: {
            input: 'await PageAgent.ready 后可读取原始 PageAgent.apps.input，未传参为 null；宿主按 code.parameters 自动处理，不在入口重复消费。参数不代表调用方身份或授权',
            parameters: {
              guidance: C.parameterGuidance,
              form: 'mode=form：每个 schema.properties 标量字段在 bindings 中对应一个控件 ID，支持 input（普通输入或 checkbox）、textarea、select、page-code-editor。只赋值，不触发 input/change 或提交；需要联动用 module。省略字段保留原值。',
              module: 'mode=module：module 为 code.files 内的 JS 文件名，导出 async function applyParameters(input)。javascript 入口须 await 完成页面初始化后返回；宿主随后调用适配器一次，等待其完成。校验或处理失败必须抛错，不吞错或提前返回成功；不得因参数自动执行外部写入。',
              moduleExample: 'export async function applyParameters(input) {\n  const field = document.getElementById("query");\n  if (!field) throw new Error("查询输入框未就绪");\n  if (input.query !== undefined) field.value = input.query;\n}\n',
              none: C.noParameters()
            },
            describe: 'await PageAgent.apps.describe(appId) 返回已发布动作声明数组，包含 name、inputSchema、outputSchema；需 apps.read',
            open: 'await PageAgent.apps.open(appId,input?,{idempotencyKey}?) 返回 {tabId,url}；仅打开发布版，提供 input 时新建标签页；JSON 参数写入 URL hash，编码后最多 16 KiB；需 apps.execute。目标参数约定见 GET /apps/{appId} 的 slots.published.parameters；对话通过 POST /apps/{appId}/open 的 body.input 传参，按 schema 校验。缺少声明时默认 mode=none，允许省略 input 或传 {}，不执行参数处理，拒绝非空参数。打开成功不代表页面处理成功。多个离线工具的计算可先通过 /utilities 串联，再将文本结果填入目标工具页面',
            run: 'await PageAgent.apps.run(appId,name,input?,{idempotencyKey}?) 返回 Run 引用，不等待完成；无需打开目标页面；需 apps.execute 和目标应用的动作授权',
            status: 'await PageAgent.apps.status(appId,runId) 返回 status、output、error、outputValidation 或 outputRef；仅接受属于目标应用的 Run；需 apps.read',
            cancel: 'await PageAgent.apps.cancel(appId,runId,{idempotencyKey}?) 请求取消目标应用的 Run；需 apps.execute',
            dependencies: '固定依赖沿用 code.dependencies 的 {uri:"/apps/<appId>",fingerprint}；打开或启动动作时校验已声明的目标依赖，变化时报 DEPENDENCY_CHANGED。未声明时使用目标最新发布版。所有 appId 使用实际 ID，不使用 slug。',
            errors: '这些便捷方法返回业务数据，失败时抛出带 code 的异常；ARP 错误保留 error.receipt。一次操作的幂等键由调用方保存后用于重试；超时或断线不能据此判断操作未执行。'
          },
          resources: 'PageAgent.resources.request(method, request)；method 为 GET/POST/PUT/PATCH/DELETE/OPTIONS，request 使用对应 ARP 输入契约，返回完整 ARP 响应（须检查 error、receipt、primary、capabilities）。离线工具目录 GET /utilities，执行 POST /utilities/{tool}/{operation}，body 只含 input/options，地址见工具的 operationUris；分别需要 utilities.read、utilities.execute；应用与流程节点共用实现', events: 'PageAgent.onChange(listener)', assets: 'PageAgent.asset("assets/name") 返回当前应用主题资源的 Blob URL'
        },
        unsupportedNodes: C.unsupportedNodes, restrictions: ['本地文件、命令和桌面支持绑定流程节点，也可通过 SDK resources.request 调用 /local/*；两种方式均需 local.execute 模块权限和已启用、已连接的本地服务。绑定流程每次执行本地节点前校验权限，撤销模块权限会请求取消运行中的应用动作。桌面节点见 /node-types?match=local，平台范围由 /local/desktop 查询', 'HTTP 动作拒绝重定向，请指定最终 URL', '模型调用须明确指定已授权的 serviceId', '不支持捕获请求重放的目标授权', '动作参数 targets 列出 origins、methods、pageIds、pageOperations、modelServiceIds；生命周期命令也需声明'],
        runtime: '同源动态资源；浏览器须支持扩展 Service Worker 的导航和脚本 fetch 分发，此平台路径尚未实测。远程脚本不支持。', guidance: C.guidance
      });
    };
    handlers.GET['/apps/capabilities/ui/{componentId}'] = async function (r) { return result(r, 'AppUiComponent', root.AppUiContract.describe(r.params.componentId)); };
    handlers.GET['/apps/dependency'] = async function (r) { return result(r, 'AppDependency', await service.readDependency(r.query.uri)); };
    handlers.GET['/apps/{appId}'] = async function (r) { return result(r, 'App', await service.summary(r.params.appId)); };
    handlers.GET['/apps/{appId}/draft'] = async function (r) { return result(r, 'AppDraft', await service.getCode(r.params.appId, 'draft')); };
    handlers.GET['/apps/{appId}/published'] = async function (r) { return result(r, 'AppPublished', await service.getCode(r.params.appId, 'published')); };
    ['draft', 'published'].forEach(function (slot) {
      handlers.GET['/apps/{appId}/' + slot + '/{field}'] = async function (r) { return result(r, 'AppCodeField', await service.getCode(r.params.appId, slot, r.params.field, r.query)); };
      handlers.GET['/apps/{appId}/' + slot + '/files/{fileName}'] = async function (r) { return result(r, 'AppSourceFile', await service.getCode(r.params.appId, slot, 'files', r.query, r.params.fileName)); };
    });
    ['PUT', 'DELETE'].forEach(function (method) {
      handlers[method]['/apps/{appId}/draft/files/{fileName}'] = async function (r, context) {
        validateSourceFileName(r.params.fileName);
        var current = await draftForEdit(r);
        var files = Object.assign({}, current.code.files);
        if (method === 'PUT') files[r.params.fileName] = r.body.source;
        else {
          if (!Object.prototype.hasOwnProperty.call(files, r.params.fileName)) throw validationError('RESOURCE_NOT_FOUND', '应用源码文件不存在: ' + r.params.fileName);
          delete files[r.params.fileName];
        }
        var code = Object.assign({}, current.code, { files: files });
        assertGeneratedCode(context, code);
        var app = await service.save(r.params.appId, expected(r), { code: code });
        if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, app.appId);
        return result(r, 'App', app);
      };
    });
    handlers.POST['/apps'] = async function (r, context) {
      assertGeneratedCode(context, r.body.code);
      var input = Object.assign({}, r.body, { sourceConversationId: !trusted(context) && context.conversationId || r.body.sourceConversationId || '' });
      var app = await service.create(input);
      if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, app.appId);
      return S.result('/apps/' + app.appId, 'App', app, etagService, 201);
    };
    handlers.PUT['/apps/{appId}/draft'] = async function (r, context) {
      assertGeneratedCode(context, r.body.code);
      var app = await service.save(r.params.appId, expected(r), r.body);
      if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, app.appId);
      return result(r, 'App', app);
    };
    handlers.PATCH['/apps/{appId}'] = async function (r, context) {
      var app = await service.patchMetadata(r.params.appId, expected(r), r.patch);
      if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, app.appId);
      return result(r, 'App', app);
    };
    handlers.PATCH['/apps/{appId}/draft'] = async function (r, context) {
      var current = await draftForEdit(r);
      var code = Object.assign({}, current.code, r.patch.code);
      assertGeneratedCode(context, code);
      var app = await service.save(r.params.appId, expected(r), { code: code });
      if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, app.appId);
      return result(r, 'App', app);
    };
    handlers.POST['/apps/{appId}/draft/edits'] = async function (r, context) {
      var current = await draftForEdit(r);
      var code = Object.assign({}, current.code);
      r.body.edits.forEach(function (edit, index) {
        var target = code, key = edit.field;
        if (edit.field === 'files') {
          validateSourceFileName(edit.fileName);
          if (!Object.prototype.hasOwnProperty.call(code.files || {}, edit.fileName)) throw validationError('RESOURCE_NOT_FOUND', '应用源码文件不存在: ' + edit.fileName);
          code.files = Object.assign({}, code.files);
          target = code.files; key = edit.fileName;
        } else if (edit.fileName !== undefined) throw validationError('SCHEMA_VALIDATION_FAILED', 'fileName 仅用于 field=files');
        var source = target[key], lineEnding = (source.match(/\r?\n/) || ['\n'])[0];
        var oldText = edit.oldText.replace(/\r?\n/g, lineEnding), newText = edit.newText.replace(/\r?\n/g, lineEnding);
        var offset = source.indexOf(oldText), label = 'edits[' + index + '] ' + key;
        if (offset === -1) throw validationError('RESOURCE_CONFLICT', label + ' 未找到 oldText，请重新读取草稿片段后调整');
        if (source.indexOf(oldText, offset + 1) !== -1) throw validationError('RESOURCE_CONFLICT', label + ' 的 oldText 匹配多处，请补充唯一上下文');
        target[key] = source.slice(0, offset) + newText + source.slice(offset + oldText.length);
      });
      assertGeneratedCode(context, code);
      var app = await service.save(r.params.appId, expected(r), { code: code });
      var diff = await sourceDiff(current, app, code, r.body.edits, r.body.includeDiff);
      if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, app.appId);
      return result(r, 'AppSourceEdits', {
        appId: app.appId, revision: app.revision, saved: true, unpublished: app.unpublished,
        appliedEdits: r.body.edits.length, links: { preview: app.links.preview }, diff: diff
      });
    };
    handlers.POST['/apps/{appId}/publish'] = async function (r) { return result(r, 'App', await service.publish(r.params.appId, expected(r))); };
    handlers.POST['/apps/{appId}/copy'] = async function (r, context) {
      var copied = await service.store.copy(r.params.appId, expected(r));
      if (!trusted(context) && context.conversationId) await service.bindConversation(context.conversationId, copied.appId);
      return S.result('/apps/' + copied.appId, 'App', await service.summary(copied.appId), etagService, 201);
    };
    handlers.PUT['/apps/{appId}/assets/{assetName}'] = async function (r, context) {
      var raw = atob(r.body.base64), bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      await service.store.putAsset(r.params.appId, expected(r), r.params.assetName, new Blob([bytes], { type: r.body.mime }));
      return result(r, 'App', await service.summary(r.params.appId));
    };
    handlers.DELETE['/apps/{appId}'] = async function (r) { return result(r, 'DeletedApp', await service.store.remove(r.params.appId, expected(r))); };
    handlers.POST['/apps/{appId}/open'] = async function (r, context) {
      var revision = await service.checkAppDependency(context.appResourceSession, r.params.appId);
      return result(r, 'AppOpen', await service.open(r.params.appId, 'published', r.body.input, revision));
    };
    handlers.POST['/apps/{appId}/actions/{actionName}/runs'] = async function (r, context) {
      var revision = await service.checkAppDependency(context.appResourceSession, r.params.appId);
      return S.asyncRunResult(await service.action(r.params.appId, r.params.actionName, r.body.input, context.appSession, revision), null);
    };
    handlers.GET['/apps/{appId}/runs/{runId}'] = async function (r) { return result(r, 'AppRunStatus', await service.ownedRun(r.params.appId, r.params.runId, false)); };
    handlers.POST['/apps/{appId}/runs/{runId}/stop'] = async function (r) { return result(r, 'AppRunControl', await service.ownedRun(r.params.appId, r.params.runId, true)); };
    async function data(r, operation) {
      var app = await service.summary(r.params.appId), permission = operation === 'get' ? 'data.read' : operation === 'delete' ? 'data.delete' : 'data.write';
      var auth = { appId: app.appId, slot: 'published', revision: app.slots.published && app.slots.published.revision, generation: app.permissions.generation, permission: permission };
      await service.authorize(auth);
      var committed = await service.store.data(app.appId, operation, Object.assign({ key: r.params.key, version: expected(r) }, r.body || {}), function (meta, p) { service.localPermission(meta, p, 'published', permission, auth); });
      if (operation !== 'get' && root.PageAgentAppBridge) root.PageAgentAppBridge.changed({ appId: app.appId, slot: 'published', change: 'data', key: r.params.key });
      return result(r, 'AppData', committed);
    }
    handlers.GET['/apps/{appId}/data/{key}'] = function (r) { return data(r, 'get'); };
    handlers.PUT['/apps/{appId}/data/{key}'] = function (r) { return data(r, 'set'); };
    handlers.DELETE['/apps/{appId}/data/{key}'] = function (r) { return data(r, 'delete'); };
    return root.ResourceModuleAdapter.create({ root: 'apps', resource: {
      service: service, routeContracts: routes, handlers: handlers,
      preconditionState: async function (_context, _request, route, params) {
        if (!params.appId) return { exists: true };
        var record = route.template === '/apps/{appId}/data/{key}' ? await service.store.get('app_data', [params.appId, params.key]) : await service.store.get('app_meta', params.appId);
        return record ? { exists: true, etag: etagService.etag(record) } : { exists: false };
      }
    } });
  }
  root.AppResource = Object.freeze({ createAdapter: createAdapter, ROUTE_CONTRACTS: routes });
})(globalThis);
