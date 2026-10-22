// Stable builtin system/domain knowledge. Tool and node contracts are disclosed progressively.
(function attachKnowledgeBuiltins(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && value.API_VERSION === 1 && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.KnowledgeBuiltins;
  var api = isApi(existing) ? existing : factory();
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.KnowledgeBuiltins = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function dictionary() { return Object.create(null); }

  function hasOwn(value, key) {
    return !!(value
      && (typeof value === 'object' || typeof value === 'function')
      && Object.prototype.hasOwnProperty.call(value, key));
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('KnowledgeBuiltins missing dependency: ' + name);
    return value;
  }

  function catalogError(code, catalog, path, message, cause) {
    var error = new TypeError('Knowledge builtin catalog ' + catalog + ' rejected at ' + path + ': ' + message);
    error.name = 'KnowledgeBuiltinCatalogError';
    error.code = 'KNOWLEDGE_BUILTIN_' + code;
    error.catalog = catalog;
    error.path = path;
    if (cause) error.cause = cause;
    return error;
  }

  function requiredText(value, catalog, path) {
    if (typeof value !== 'string' || !value.trim()) {
      throw catalogError('CATALOG_KEY_INVALID', catalog, path, 'expected a non-empty string');
    }
    return value;
  }

  function readCatalog(provider, catalog, keyField, projector) {
    var source;
    try { source = provider(); } catch (cause) {
      throw catalogError('CATALOG_PROVIDER_FAILED', catalog, catalog, 'provider threw', cause);
    }
    if (!Array.isArray(source) || !source.length) {
      throw catalogError('CATALOG_NOT_ARRAY', catalog, catalog, 'catalog must be a non-empty array');
    }
    var seen = dictionary();
    return source.map(function (value, index) {
      var path = catalog + '[' + index + ']';
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw catalogError('CATALOG_ENTRY_INVALID', catalog, path, 'expected an object');
      }
      var projected = projector(value, index);
      var key = projected[keyField];
      if (hasOwn(seen, key)) throw catalogError('CATALOG_KEY_DUPLICATE', catalog, path, 'duplicate key: ' + key);
      seen[key] = true;
      return projected;
    });
  }

  function projectTool(value, index) {
    var path = 'tools[' + index + ']';
    var name = requiredText(value.name, 'tools', path + '.name');
    if (!value.inputSchema || (typeof value.inputSchema !== 'object' && value.inputSchema !== true)) {
      throw catalogError('CATALOG_FIELD_INVALID', 'tools', path + '.inputSchema', 'expected a JSON schema');
    }
    return {
      name: name,
      description: String(value.description || ''),
      inputSchema: cloneJson(value.inputSchema),
    };
  }

  function projectNode(value, index) {
    var path = 'nodes[' + index + ']';
    var type = requiredText(value.type, 'nodes', path + '.type');
    if (!Array.isArray(value.params)) {
      throw catalogError('CATALOG_FIELD_INVALID', 'nodes', path + '.params', 'expected an array');
    }
    var params = value.params.map(function (param, paramIndex) {
      if (!param || typeof param !== 'object' || Array.isArray(param)) {
        throw catalogError('CATALOG_FIELD_INVALID', 'nodes', path + '.params[' + paramIndex + ']', 'expected an object');
      }
      requiredText(param.key, 'nodes', path + '.params[' + paramIndex + '].key');
      return cloneJson(param);
    });
    return {
      type: type,
      label: String(value.label || type),
      description: String(value.description || ''),
      needsPage: value.needsPage === true,
      needsTab: value.needsTab === true,
      outputHint: value.outputHint === undefined ? undefined : cloneJson(value.outputHint),
      outputVar: value.outputVar === undefined ? undefined : cloneJson(value.outputVar),
      outputType: value.outputType === undefined ? undefined : cloneJson(value.outputType),
      params: params,
      examples: Array.isArray(value.examples) ? cloneJson(value.examples) : [],
    };
  }

  function create(options) {
    options = options || {};
    var provideTools = requireFunction(options.getToolDefinitions, 'getToolDefinitions');
    var provideNodes = requireFunction(options.getNodeTypes, 'getNodeTypes');

    function readToolDefinitions() {
      return readCatalog(provideTools, 'tools', 'name', projectTool);
    }

    function readNodeTypes() {
      return readCatalog(provideNodes, 'nodes', 'type', projectNode);
    }

    function makeItem(spec) {
      return {
        id: spec.id,
        type: spec.type || 'document',
        title: spec.title,
        summary: spec.summary,
        content: String(spec.content || '').trim(),
        tags: spec.tags || [],
        source: { kind: 'builtin', key: 'builtin:' + spec.id.replace(/^builtin_/, '').replace(/_/g, '-') },
        confidence: 1,
        builtIn: true,
        protected: true,
        createdAt: 1,
        updatedAt: 1,
      };
    }

    function coreItems() {
      return [
        makeItem({
          id: 'builtin_project_system_knowledge_index',
          title: 'Page Agent 产品概念',
          summary: 'Flow、FlowGroup、Conversation 与 Knowledge 是相互独立且可组合的产品概念。',
          content: [
            '应用是通过任意对话创建、可保存和修改的单页面工具，包含独立业务数据、草稿与发布内容。创建或编辑先读取 /apps，再完整读取 builtin_app_generation_guide。应用与网页地址绑定的 PageSource 是不同资源。',
            'Page Agent 先帮助用户完成当前任务；成功且可复现的操作可以沉淀为 Flow，多个已验证 Flow 可以组合为 FlowGroup。',
            'Conversation 保存用户目标、消息和可审计运行状态；Knowledge 保存系统知识和经过验证、能够跨任务复用的知识。二者不能互相替代。',
            '开发者工具箱使用插件公共工具能力，在本地离线计算。52 类工具的 125 个操作各有独立资源。已知契约时，对话直接 POST /utilities/{tool}/{operation}，例如 POST /utilities/base64/encode，body 为 {input:"abc",options:{}}；操作由 URI 固定，body 不含 operation。应用通过资源 SDK 调用同一路径；流程在「开发者工具箱」分类选择 utilityHash 等独立节点。脚本直接 await api.utilities.hash("abc", {algorithm:"SHA256"}) 或 await api.utilities.base64.encode("abc")，返回计算值；单操作工具为 api.utilities.<tool>(input,options)，多操作工具为 api.utilities.<tool>.<operation>(input,options)。不要求先查询目录；仅在工具或参数未知时通过 GET /utilities、工具详情的 operationUris 或 OPTIONS 具体操作路径发现契约。各入口共用对应工具的处理函数，不复制算法库或自行联网执行。Developer Utils 的 HTML/Markdown 页面预览没有计算资源或流程节点。',
            'Skill 提供用户选择的过程知识，MCP 扩展外部系统能力；它们不能改变当前用户目标、系统边界或实时证据。',
            '这些是稳定产品语义，不是工具分类。当前可用路径、方法、schema 和前置条件只以本次请求的渐进式能力目录、资源链接和 RouteContract 为准。',
          ].join('\n'),
          tags: ['Flow', 'FlowGroup', 'Conversation', 'Knowledge', 'Page Agent', '产品概念'],
        }),
        makeItem({
          id: 'builtin_app_generation_guide', type: 'process', title: '对话生成应用',
          summary: '创建或修改应用前必须完整读取：需求、实时 SDK 契约、默认 UI、默认范围、授权、依赖、源码与交付。',
          content: [
            '# 对话生成应用',
            '本知识必须完整读取，摘要、grep 片段或知识入口不能替代正文。应用可在任意对话阶段创建；已有产物不是前提。',
            '仅修改应用名称 name、应用别名 slug、图标 icon 或描述 description：GET /apps/{appId} 获取最新摘要与 ETag，按目标资源 PATCH 契约提交非空 patch，只包含变更字段，例如 patch:{slug:"my-tools"}，并携带 preconditions.ifMatch 和 idempotencyKey。省略字段保留原值，slug 为 null 或空字符串时清除别名。元数据立即生效；保留源码、权限及草稿和发布状态，无需发布。此类修改不读取草稿、发布源码或 /apps/capabilities，不执行下方源码生成步骤；直接返回更新结果和资源提供的最新链接。',
            '图标目录与单独改图标：GET /apps/capabilities/ui/icons 返回当前可用图标 ID 全集 icons，与应用管理界面的选择框共用目录。新建应用的 icon、修改应用的 icon 和页面 icons.create(name) 必须从当前返回的目录选择，不得凭记忆编造图标名或使用其他 FontAwesome 版本的名字；新建时已读取 /apps/capabilities.icons 可直接复用。单独改图标时先读取该目录与应用最新摘要，再 PATCH /apps/{appId}，只提交 patch:{icon:"fa-calendar"} 这样的单字段修改，并携带摘要 ETag 对应的 preconditions.ifMatch 和 idempotencyKey；立即保存，不读取或提交源码，不保存草稿、不发布。目录外的 icon 会被校验拒绝，不能宣称已修改成功。',
            '局部修改源码、主题或功能声明：GET /apps/{appId} 获取最新摘要与权限，查询目标路径契约，再通过 GET /apps/{appId}/draft/{field} 独立读取字段；已发布版本用 /apps/{appId}/published/{field}。支持 html、css、javascript、themeCss、description、capabilities、actions、dependencies、customBehavior、externalResources；数组字段直接返回 value，仅接受 revision 参数。保存时 PATCH /apps/{appId}/draft，只传 patch:{code:{css:"新的 CSS"}} 等变更字段，携带 preconditions.ifMatch 和 idempotencyKey。各字段可独立修改，也可一次提交相互关联的字段；字符串和数组整体替换，空字符串或空数组表示清空，省略保留，不能用 null 删除必需字段。后台合并后校验能力声明、动作、依赖指纹和原生调用约束，按原版本原子保存草稿；不重新发送未修改的源码或主题。动作需要 actions.run 声明；仍被动作引用的依赖会重新收集。capabilities 是源码声明，实际授权仍由用户在权限面板独立保存。',
            '大段 HTML、CSS、JavaScript 或主题先搜索定位：GET /apps/{appId}/published/javascript?q=addEventListener&fixedStrings=true&before=3&after=5，草稿同样支持。加 q 即复用 Knowledge 标准 grep 的匹配器及结果结构，省略 q 按行读取，不使用 fields、mode 或 context 参数。搜索默认正则匹配且忽略大小写，fixedStrings=true 对应 grep -F 字面量匹配，caseSensitive=true 区分大小写；before 对应 grep -B、after 对应 grep -A，分别指定每个命中前后的行数，各默认 0、最多 20，可组合使用，须与 q 同用。limit 默认 5、最多 50 个命中行，不计附带的前后行；每行片段最多 500 字符。matches 包含 line、content、before、after 和带 kind 的 lines；truncated=true 时可收窄查询、调大 limit 或按行读取。GET /apps/{appId}/draft/html?startLine=120&limit=40 按原始行号读取并保留缩进；行列从 1 开始，每页最多 50 行、12000 个源码字符。hasMore=true 时把 nextLine/nextColumn 作为 startLine/startColumn 续读，后续查询带首次结果的 revision，版本变化须重新读取。字段路径返回精简结果和 ETag，最新权限从应用摘要读取。搜索与分段不会格式化或修改已保存源码。片段不等于全文：PATCH 是字段整体替换，替换前必须读齐该字段并保留未修改内容，不能把搜索结果或截断片段作为整个字段保存。',
            '1. 根据用户当前需求确定功能、输入输出和持久数据。新建应用未指定页面风格时，默认沿用插件 UI，不主动另造视觉风格，也不为风格重复询问；用户明确指定的风格优先。已明确的内容不重复询问。必要信息足够后立即创建完整草稿。',
            '2. 新建应用时 GET /apps/capabilities 获取当前版本 SDK、codeSchema、图标目录、defaults.ui 默认 UI 模板、默认能力范围及 resourcePermissions 完整模块权限目录；defaults.resourcePermissions 是对话与应用共用的系统默认运行权限，不包含 apps.delete，不能把完整目录当成默认全开。能力选择不是必填步骤；未指定才使用默认值，明确空范围必须保留。修改已有应用时按需读取草稿字段与权限，沿用其保存范围；只在需要 SDK 说明、默认主题或能力目录时读取 /apps/capabilities。',
            '3. 绑定动作时按真实 RouteContract 查询所需 Flow、FlowGroup、Script、PageSource 及其他依赖。GET /apps/dependency?uri=<编码后的资源路径> 获取依赖与内容指纹，ID 不得猜测。动作中的动态引用必须显式声明依赖并通过绑定 context 参数传入。模块管理应用通过 SDK 查询实时资源列表，使用返回的 ID、链接和 ETag 调用，不需预先绑定运行时才选择的全部资源。',
            '4. 列出功能分工：布局、表单、筛选、图表和计算在应用本地完成；持久数据及网络、模型、浏览器/CDP、文件等插件能力通过当前 SDK。已有绑定动作使用 PageAgent.actions；各插件模块使用 PageAgent.resources.request(method, request)，复用真实 ARP 契约和模块权限，不得调用 chrome.*、原生 fetch 或内部模块绕过 SDK。SDK 未提供的能力必须说明缺失，不伪造成功或自行扩大范围。',
            '5. 新建应用默认开启 SDK 和应用数据、绑定动作能力；模块权限使用系统默认运行权限，与对话全自动（YOLO）模式共用同一来源，包含本地操作，删除应用默认关闭。其他权限可由用户开启，“重置为默认权限”同时恢复 SDK 开关、应用数据与绑定动作范围、插件模块权限，保存后生效；普通应用恢复系统默认值，声明默认权限的内置应用按包中配置恢复。所有权限作用于整个应用，草稿与发布共用，没有版本授权。关闭能力阻止运行，不阻止保存和发布源码，也不会因保存重新开启。已有应用保留总开关和模块权限；旧版本中明确关闭的项目合并到应用级范围，关闭任一绑定动作会关闭 actions.run。内置加载器对有默认声明但缺少权限初始化标记的旧安装补齐默认值一次，之后保留用户修改。普通导入仍关闭 SDK 且不继承模块授权。权限由用户在配置中心调整，点击“保存权限”后统一生效；生成代码不能修改权限。',
            '6. 仅用户明确要求的原生调用、外部资源或其他例外写入 customBehavior 和 externalResources；不删除已有手动例外。它们不受 SDK 完整管理，仍受浏览器限制。MV3 宿主不支持远程脚本。不要把加载远程 script 或 eval 当作可运行方式。',
            '7. 新建时以最新 codeSchema 生成完整 html、css、javascript、themeCss、description、capabilities、actions、dependencies、customBehavior、externalResources；修改时只生成需要变更的字段。capabilities 只填 schema 允许的应用数据和绑定动作能力，模块权限由摘要的 permissions.resources 表示，不填入 capabilities。HTML 使用 body 内容，JavaScript 单独放 javascript 字段，按模块执行，可直接访问全局 PageAgent。图标只选当前目录。',
            '默认 UI：新建且用户未指定风格时，将 defaults.ui.themeCss 全文复制到 code.themeCss，按 defaults.ui.usage 和 htmlExample 复用页面、按钮、表单与表格样式；仅生成所需结构并实现实际行为。业务布局写入 code.css，复用模板变量，不用另一套配色、字体或控件样式覆盖默认风格。宿主先加载 themeCss 再加载 css，不要链接插件的 options.css 或 default-theme.css。复制后的主题属于应用，可由用户修改、替换或清空，插件更新不会自动覆盖。修改已有应用时保留已保存的 themeCss（包括空字符串）和现有视觉风格；仅在用户要求换肤或恢复默认时调整相关样式。新增控件沿用该应用当前主题。',
            '公共 UI：需要代码编辑、Markdown、消息列表、图标、提示消息或浮动拖动时，先查看 /apps/capabilities 的 ui.components，按其 href 读取所需组件完整用法，再在 javascript 中 await PageAgent.ui.load(id)。复用已有组件，不复制内部实现，不直接引用插件脚本路径，不编造目录外的 API。基础布局和表单使用默认主题，details、文件输入、progress、dialog 使用 defaults.ui.nativeControls 示例。消息列表只展示传入数据，发送、停止、模型调用与保存仍由应用通过实际 SDK 契约编排。UI 按需加载，不需要业务权限；移除区域前销毁实例，代码编辑器移除元素自动释放。UI 仅在页面分支使用，Worker 分支不使用 DOM 或 PageAgent.ui。',
            '8. SDK 使用：await PageAgent.ready；await PageAgent.data.get(key) 返回 {key,value,version}；data.list({cursor,limit}) 分页；data.set(key,value,version) 带旧版本，首次新建 version=null；data.delete(key,version)。草稿使用当前预览会话临时数据。并发冲突要显示，不覆盖用户输入。',
            '模块 SDK：await PageAgent.resources.request("OPTIONS", {uri:"/local/read"}) 查询契约；读取本地文件使用 await PageAgent.resources.request("POST", {uri:"/local/read",body:{path:"notes.txt"},idempotencyKey:crypto.randomUUID()})。返回完整 ARP 响应，必须检查 response.error，成功数据在 response.primary.data，内省结果在 response.capabilities；保留 receipt 判断操作是否执行。本地 read/write/delete/grep/bash 复用已配置的工作目录和本地操作服务，应用默认权限不替代全局服务开关或实际连接。其他模块同样先查询真实契约，按权限和请求前置条件调用。',
            '9. await PageAgent.actions.run(name,input,{idempotencyKey}) 返回现有 Run，actions.status(runId) 和 actions.cancel(runId) 查询与取消。幂等键应在用户发起一次操作时产生并保存，超时后先查询；当前幂等账本不承诺跨后台重启去重。动作稳定名称绑定 resource:{uri,fingerprint}、inputSchema、outputSchema、context、dependencies、sideEffects 和 purpose。真实网页操作必须由用户动作触发，不在源码生成、加载或预览时自行执行。脚本动作具有任意用户脚本能力，不能称为强制只读。',
            '应用间交互使用 PageAgent.apps，先从 /apps 查询真实 appId，不使用别名或猜测 ID。await PageAgent.apps.describe(appId) 返回已发布动作声明数组，按真实 name/inputSchema/outputSchema 调用 await PageAgent.apps.run(appId,name,input,{idempotencyKey})；返回 Run 引用，不等待完成，也不要求目标页面打开。用 apps.status(appId,runId) 查询，apps.cancel(appId,runId,{idempotencyKey}) 取消。只有成功、无 outputRef 且无 outputValidation 失败时才将 output 作为下一应用动作输入，并匹配其 inputSchema；运行记录有容量限制。跨应用 Run 不向调用方转发 onChange，需要时仅在当前任务期间查询状态，结束后停止。describe/status 需调用方 apps.read，open/run/cancel 需 apps.execute，目标动作还需目标自身的 SDK 和动作授权。Run 归属目标应用，按目标授权管理；调用方页面关闭不自动取消。方法直接返回业务数据，失败抛出带 code 的异常，资源错误保留 error.receipt。',
            '跨应用页面传参：用户操作触发 await PageAgent.apps.open(appId,{recordId:"实际记录ID"},{idempotencyKey})，目标 await PageAgent.ready 后读取 PageAgent.apps.input；无参数为 null。只打开发布版；提供 input 时新建标签页，省略时复用已有页面。参数只接受普通 JSON，放在 URL hash，编码后最多 16 KiB，适合记录 ID 或筛选条件，不放密钥或大数据；目标自行校验，不把参数当调用方身份、授权或自动执行副作用的依据。固定应用依赖通过 /apps/dependency 获取 {uri:"/apps/<appId>",fingerprint} 放入 code.dependencies；打开或调用已声明目标时校验完整依赖，漂移时报 DEPENDENCY_CHANGED。沿用名称、草稿与发布源码的内容指纹，目标草稿修改也需确认并更新绑定；未声明的动态目标使用最新发布版。保持单向依赖，导出导入复用现有依赖处理，不复制对方业务逻辑、不新增消息总线或后台常驻程序。',
            '10. SDK 失败显示真实错误。AUTHORIZATION_CHANGED 后刷新权限，CONTENT_CHANGED 提示加载新内容，PERMISSION_DENIED 引导用户权限面板。超时不表示未执行，写入和启动动作不得盲目重试。PageAgent.onChange 订阅变化；不为每个应用常驻轮询。',
            '动作 targets 必须列出明确的 origins、methods、pageIds、pageOperations、modelServiceIds；不需要的列表填空。页面操作名来自真实节点及页面契约，不能猜测。当前 SDK 的 HTTP 路径拒绝重定向，因为浏览器无法向 Fetch 暴露可校验的重定向目标；应绑定最终地址。纯脚本中的原生副作用不被描述为可逐项限制。',
            '模型动作必须指定 targets.modelServiceIds 中的 serviceId，不隐式使用默认模型。读取 /apps/capabilities 的 unsupportedNodes 与 restrictions；这些节点的应用授权尚未开放，不能承诺其可执行。应用运行不发送共享 Flow 的自动邮件通知。',
            '插件已有离线工具能力且当前契约已知时，直接通过 PageAgent.resources.request("POST", {uri:"/utilities/hash/digest", body:{input:"abc", options:{algorithm:"SHA256"}}, idempotencyKey:crypto.randomUUID()}) 调用，需 utilities.execute，返回 primary.data 的 {tool, operation, value}。每个操作有独立 URI，body 只含 input/options。工具或参数未知时才 GET /utilities 或 GET /utilities/{tool}，查询需 utilities.read；返回的 operationUris 提供具体执行地址，OPTIONS 该地址可读契约。查询不是执行前置条件。工具与 utilityHash 等独立流程节点共用处理函数，不把算法库重新嵌入应用。无业务联网、不执行任意用户代码；输入最多 65536 字符、总参数 100000 字符，结果序列化最多 98304 字符；最多并行两个 Worker，15 秒终止。仅查询、复制或生成 HTTP 示例不发送请求。',
            '11. 大计算使用按需 Worker：await PageAgent.ready 后 PageAgent.createWorker() 在 Worker 中装载同一 javascript 字段；源码以 typeof document === "undefined" 区分纯计算分支和页面分支，Worker 分支不调用 PageAgent 或 DOM。其他 Worker 可用 PageAgent.manageWorker(worker) 纳入实例清理。主题资源以 app-asset:assets/name 引用，或 await PageAgent.asset(name)。停止应用仅停止该实例，不能重启插件或破坏共享执行器。',
            '应用页面不引入沙箱。页面程序和专用 Worker 的生命周期绑定标签页，关闭标签页即结束；不使用 SharedWorker、Service Worker、offscreen 页面或后台定时任务延续页面程序。已提交的 Flow、FlowGroup、Script 任务例外，继续由 Run 系统管理，关闭标签页不会自动取消这些任务。',
            '12. 保存前核对功能有实际实现、默认 UI 已按用户风格要求或已有主题处理、默认代码只调用允许的 SDK、例外已记录、依赖完整且指纹一致。POST /apps 新建草稿；局部修改先按需读取最新草稿字段，PATCH /apps/{id}/draft 携带摘要 ETag 和幂等键，仅发送变更字段。只有确需完整替换草稿时使用 PUT。手动输入与对话共享草稿，冲突时重读再调整。不得生成历史版本、回滚副本或写插件安装目录。',
            '13. 返回名称、状态、功能与依赖清单和最新 SDK 权限，给出资源返回的完整预览 URL /apps/{id}/draft。预览在独立标签页打开，不嵌入对话。用户要求发布时 POST /apps/{id}/publish 携带当前 ETag；仅本地启用，不公开上传。发布不清空数据，普通动作只运行发布槽位。',
            '14. 导出包含两个槽位、主题资源、可选业务数据和递归依赖；授权、开关状态和会话不导出。依赖缺失、漂移或动态引用不确定时先补齐，不生成伪完整包。导入后仍未授权，不自动运行。',
            '每次生成时在实际规划中明确本次范围、当前槽位、应用权限总开关/能力范围/模块权限/代次、真实契约和用户明确例外。只读取目标应用源码，不把所有应用源码放入上下文。',
            '应用可用 code.files 保存自己的 JS/CSS 原文，文件名不含目录，__entry__.js 为保留名称。入口与模块用 import "./app.js"，HTML/CSS 用 app-file:app.css。内置应用声明的本地文件已安装到 code.files，发布包保留原文，不压缩这些源码；GET /apps/{id}/{draft|published}/files 列出文件，再 GET /apps/{id}/{slot}/files/{fileName} 按行读取或用 q 搜索，分页沿用 nextLine/nextColumn 和 revision。修改内置应用先 POST /apps/{id}/copy；副本携带源码和主题，不包含业务数据或授权。单文件修改用 PUT /apps/{副本ID}/draft/files/{fileName}，body 为 {source:"完整源码"}，携带当前应用 ETag 和幂等键；先读齐文件，保留其他实现。删除用同一文件路径 DELETE。普通 code PATCH 中 files 会整体替换，优先单文件接口。无需读取或写入插件安装目录；公共 SDK、工具服务、组件和字体继续使用目标插件提供的能力。',
          ].join('\n\n'), tags: ['应用', 'SDK', '草稿', '发布', '生成'],
        }),
        makeItem({
          id: 'builtin_turndown_markdown_conversion_contract',
          type: 'process',
          title: '网页 HTML 转 Markdown 的语义方法',
          summary: 'HTML 到 Markdown 是语义投影；优先保留正文结构，只为页面特有且必要的语义增加最小规则。',
          content: [
            'HTML 到 Markdown 不是无损序列化。优先保留标题、段落、列表、链接、图片、引用、表格、代码和公式；Markdown 无法表达的 class、style 与 data-* 只有在业务确实需要时才保留。',
            '转换前必须确认输入覆盖完整目标正文。分页或窗口化读取尚未结束时先按原顺序取得并拼接完整 HTML，再执行一次转换；不能逐窗口转换后拼接，也不能把第一窗口当作完整正文。',
            '诊断按三层进行：先确认工作流读取了正确且完整的正文，再检查页面 DOM 的真实语义，最后判断转换器默认规则是否已经能够表达。只有默认结果会丢失或重复业务语义时，才增加页面专用的声明式规则。',
            '裸 pre 中的字面 Markdown 开围栏不能依赖 HTML 结束标签闭合；输出必须形成配对且不会吞并后续正文的代码块。',
            'KaTeX 页面通常同时包含 MathML/TeX 语义树和 aria-hidden 展示树；转换时只选择一个权威公式来源，避免重复或破坏公式。块级与行内公式必须分别保持正确边界。',
            '具体可用节点、参数、规则动作和 schema 以当前节点目录与节点契约为准；这条知识只描述跨页面复用的转换方法。',
          ].join('\n'),
          tags: ['HTML', 'Markdown', 'Turndown', '语义转换', '代码围栏', 'KaTeX', 'MathML'],
        }),
      ];
    }

    function validateItems(items) {
      if (!Array.isArray(items) || !items.length) throw catalogError('ITEMS_INVALID', 'builtins', 'builtins', 'items must be non-empty');
      var seen = dictionary();
      items.forEach(function (item, index) {
        if (!item || typeof item !== 'object' || !item.id) {
          throw catalogError('ITEM_INVALID', 'builtins', 'builtins[' + index + ']', 'item and id are required');
        }
        if (hasOwn(seen, item.id)) throw catalogError('ITEM_ID_DUPLICATE', 'builtins', 'builtins[' + index + '].id', item.id);
        seen[item.id] = true;
      });
      return items;
    }

    function buildItems() {
      return validateItems(coreItems());
    }

    return {
      buildItems: buildItems,
      getToolDefinitions: readToolDefinitions,
      getNodeTypes: readNodeTypes,
    };
  }

  return { API_VERSION: API_VERSION, create: create };
});
