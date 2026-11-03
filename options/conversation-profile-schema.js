// Assistant profile schema, snapshots, templates, and prompt composition.
(function attachConversationProfileSchema(root, factory) {
  'use strict';

  var commonJs = typeof module === 'object' && module.exports;
  var api = factory(commonJs ? require('../shared/system-runtime-permissions.js') : root.SystemRuntimePermissions);
  if (commonJs) module.exports = api;
  if (root) root.ConversationProfileSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (runtimePermissions) {
  'use strict';

  var PROFILE_VERSION = 9;
  var KHAZIX_WRITER_URI = '/knowledge/builtin_skill_khazix_writer';
  // Keep this order aligned with the Options sidebar. A resource root belongs
  // to the product surface where users configure or inspect that capability.
  var RESOURCE_SECTIONS = Object.freeze([
    Object.freeze({ id: 'apps', label: '应用', description: '对话生成的应用、草稿、发布与动作。' }),
    Object.freeze({ id: 'conversation', label: '对话', description: '助手、话题与对话上下文。' }),
    Object.freeze({ id: 'flows', label: '流程', description: '流程、节点类型与校验。' }),
    Object.freeze({ id: 'pages', label: '页面', description: '页面源、当前页面与浏览器资源。' }),
    Object.freeze({ id: 'scripts', label: '脚本', description: '可复用脚本。' }),
    Object.freeze({ id: 'knowledge', label: '知识', description: '知识库、Skill 与外部 HTTP MCP 工具。' }),
    Object.freeze({ id: 'flow-groups', label: '流程组合', description: '流程组定义与运行。' }),
    Object.freeze({ id: 'schedules', label: '定时运行', description: '定时任务。' }),
    Object.freeze({ id: 'url-triggers', label: '触发运行', description: 'URL 自动触发规则。' }),
    Object.freeze({ id: 'logs', label: '流程报告', description: '运行记录、报告与调试证据。' }),
    Object.freeze({ id: 'model-settings', label: '模型配置', description: '模型服务配置与验证。' }),
    Object.freeze({ id: 'mcp', label: '连接配置', description: '插件与本地 MCP Server 的 WebSocket 连接及邮件配置。' }),
    Object.freeze({ id: 'system-settings', label: '系统配置', description: '系统配置、公开配置分区与 Agent 默认设置。' }),
  ]);
  var RESOURCE_ROOT_METADATA = Object.freeze([
    Object.freeze({ uri: '/apps', section: 'apps', label: '应用', description: '发现、创建和修改应用，读取当前 SDK 授权并执行已授权动作。' }),
    Object.freeze({ uri: '/conversations', section: 'conversation', label: '对话', description: '管理对话及其持久化状态。' }),
    Object.freeze({ uri: '/assistants', section: 'conversation', label: '助手', description: '管理助手配置。' }),

    Object.freeze({ uri: '/knowledge', section: 'knowledge', label: '知识', description: '知识菜单：查询和管理 Knowledge。' }),
    Object.freeze({ uri: '/skills', section: 'knowledge', label: 'Skill', description: '知识菜单：读取和管理 Skill 正文及附带资源。' }),
    Object.freeze({
      uri: '/mcp-servers', section: 'knowledge', label: 'HTTP MCP 服务器与工具',
      description: '知识菜单：读取外部 HTTP MCP 服务器与工具目录，并创建工具调用。',
      methodDescriptions: Object.freeze({
        GET: '读取已配置的 HTTP MCP 服务器及已同步的工具 schema。',
        POST: '添加或检查 HTTP MCP 服务器、刷新工具目录，或发起工具调用。',
        PATCH: '修改 HTTP MCP 服务器地址、认证或启用状态。',
        DELETE: '删除 HTTP MCP 服务器及其托管的知识条目。',
        OPTIONS: '内省 HTTP MCP 服务器、工具发现与调用路由。',
      }),
    }),
    Object.freeze({
      uri: '/mcp-calls', section: 'knowledge', label: 'HTTP MCP 调用结果',
      description: '知识菜单：读取异步 HTTP MCP 调用结果；调用入口在 /mcp-servers。',
      methodDescriptions: Object.freeze({
        GET: '读取已发起的 HTTP MCP 工具调用状态和结果。',
        OPTIONS: '内省 HTTP MCP 调用结果读取路由。',
      }),
    }),
    Object.freeze({ uri: '/knowledge-settings', section: 'knowledge', label: '知识设置', description: '知识菜单：管理 Knowledge 行为设置。' }),

    Object.freeze({ uri: '/model-services', section: 'model-settings', label: '模型服务', description: '管理和验证模型服务。' }),

    Object.freeze({
      uri: '/connections', section: 'mcp', label: '本地 MCP WebSocket 连接',
      description: '查询服务端连接、已连接客户端和总数，通过 ARP 调用其他客户端；连接及授权配置仅由配置页修改。',
      methodDescriptions: Object.freeze({
        GET: '读取 WebSocket 连接状态、连接尝试和日志，查询对应服务端的全部客户端及总数。',
        POST: '发起 WebSocket 连接尝试，或通过服务端调用其他客户端的 ARP 能力。',
        PATCH: '修改本地连接地址、启用状态和标签页模式。',
        DELETE: '清空本地连接日志；不会删除 HTTP MCP 服务器。',
        OPTIONS: '发现 WebSocket 连接、客户端列表与 ARP 转发能力。',
      }),
    }),

    Object.freeze({ uri: '/mail-settings', section: 'mcp', label: '邮件配置',
      description: '管理邮件通知开关、SMTP 账号和发件信息，查询邮件服务状态或发送测试邮件；密码只写不读。',
    }),
    Object.freeze({ uri: '/local', section: 'mcp', label: '本地文件、命令与桌面',
      description: '在连接配置开启后，通过服务端操作文件、执行 Bash，以及调用平台支持的鼠标、键盘、剪贴板、截图、图片定位、应用和窗口能力。',
    }),
    Object.freeze({ uri: '/flow-groups', section: 'flow-groups', label: '流程组', description: '管理 FlowGroup 并启动流程组运行。' }),

    Object.freeze({ uri: '/flows', section: 'flows', label: '流程', description: '读取、创建和修改 Flow、节点及校验。' }),
    Object.freeze({ uri: '/node-types', section: 'flows', label: '节点类型', description: '读取节点类型目录与 schema。' }),

    Object.freeze({ uri: '/pages', section: 'pages', label: '页面源', description: '管理已配置的页面源。' }),
    Object.freeze({ uri: '/page', section: 'pages', label: '当前页面', description: '读取和操作当前网页资源。' }),
    Object.freeze({ uri: '/browser', section: 'pages', label: '浏览器', description: '管理标签页、窗口、下载和浏览器级能力。' }),
    Object.freeze({ uri: '/recordings', section: 'pages', label: '页面录制', description: '读取已关联到当前对话与 generation 的不可变页面操作录制。' }),

    Object.freeze({ uri: '/scripts', section: 'scripts', label: '脚本', description: '管理并运行可复用脚本。' }),
    Object.freeze({ uri: '/schedules', section: 'schedules', label: '定时任务', description: '管理定时任务并立即运行。' }),
    Object.freeze({ uri: '/url-triggers', section: 'url-triggers', label: 'URL 触发器', description: '管理 URL 自动触发规则。' }),
    Object.freeze({ uri: '/runs', section: 'logs', label: '运行与报告', description: '读取运行和报告、停止活动流程、继续可恢复流程，以及清理运行记录。' }),
    Object.freeze({ uri: '/system-settings', section: 'system-settings', label: '系统配置', description: '管理网页悬浮入口、非模型请求 User-Agent 和浏览器代理。',
    }),
    Object.freeze({ uri: '/config', section: 'system-settings', label: '公开配置', description: '读取允许公开的配置分区。' }),
    Object.freeze({ uri: '/agent-settings', section: 'system-settings', label: 'Agent 设置', description: '管理 Agent 默认设置。' }),
  ]);
  var INTEGRATION_ROOT_URIS = Object.freeze(['/connections', '/mcp-servers', '/mcp-calls']);
  var RESOURCE_METHODS = Object.freeze([
    Object.freeze({ name: 'GET', label: '读取', description: '读取资源，不产生业务副作用。' }),
    Object.freeze({ name: 'POST', label: '创建/执行', description: '创建资源、Interaction、Run 或 MCP 调用。' }),
    Object.freeze({ name: 'PUT', label: '完整替换', description: '用完整表示创建或替换已知资源。' }),
    Object.freeze({ name: 'PATCH', label: '局部修改', description: '只修改资源的指定部分。' }),
    Object.freeze({ name: 'DELETE', label: '删除/取消', description: '删除资源或取消活动运行。' }),
    Object.freeze({ name: 'OPTIONS', label: '内省', description: '查询已授权能力；资源没有可用权限时会被拒绝。' }),
  ]);
  var RESOURCE_METHOD_SET = Object.freeze(RESOURCE_METHODS.reduce(function (set, method) {
    set[method.name] = true;
    return set;
  }, Object.create(null)));
  // Installed from AgentCore.resourcePermissionCatalog, backed by registered routes.
  // UI metadata never defines executable methods or permission names.
  var RESOURCE_ROOTS = null;
  var RESOURCE_PERMISSION_NAMES = null;
  var BLOCKED_KEYS = Object.create(null);
  BLOCKED_KEYS.__proto__ = true;
  BLOCKED_KEYS.prototype = true;
  BLOCKED_KEYS.constructor = true;

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeKeys(value) {
    return isRecord(value) ? Object.keys(value).filter(function (key) {
      return !BLOCKED_KEYS[key];
    }) : [];
  }

  function cloneSafe(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    if (typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return null;
    seen.push(value);
    var out;
    if (Array.isArray(value)) {
      out = value.map(function (entry) { return cloneSafe(entry, seen); });
    } else {
      out = {};
      safeKeys(value).forEach(function (key) {
        out[key] = cloneSafe(value[key], seen);
      });
    }
    seen.pop();
    return out;
  }

  function safeMerge() {
    var out = {};
    Array.prototype.slice.call(arguments).forEach(function (source) {
      safeKeys(source).forEach(function (key) {
        out[key] = cloneSafe(source[key]);
      });
    });
    return out;
  }

  function safeShallowMerge() {
    var out = {};
    Array.prototype.slice.call(arguments).forEach(function (source) {
      safeKeys(source).forEach(function (key) {
        out[key] = source[key];
      });
    });
    return out;
  }

  function stableValue(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(stableValue);
    if (typeof value !== 'object') return value;
    var out = {};
    safeKeys(value).sort().forEach(function (key) {
      out[key] = stableValue(value[key]);
    });
    return out;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function sameValue(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function coreMethodsForRoot(uri) {
    return uri === '/local' ? ['GET'] : runtimePermissions.rootMethods[uri] || [];
  }

  function installResourcePermissionCatalog(catalog) {
    if (!isRecord(catalog) || !Object.keys(catalog).length) {
      throw new Error('资源权限目录为空，无法配置授权');
    }
    var metadata = {};
    RESOURCE_ROOT_METADATA.forEach(function (entry) { metadata[entry.uri] = entry; });
    var names = new Set(runtimePermissions.permissions);
    var uris = RESOURCE_ROOT_METADATA.map(function (entry) { return entry.uri; });
    Object.keys(catalog).forEach(function (uri) {
      // These internal resources have their own owner/context checks, not UI grants.
      if (uri !== '/current' && uri !== '/image-artifacts' && uris.indexOf(uri) === -1) uris.push(uri);
    });
    RESOURCE_ROOTS = uris.filter(function (uri) { return isRecord(catalog[uri]); }).map(function (uri) {
      var methods = {};
      var coreMethods = coreMethodsForRoot(uri);
      var additional = new Set();
      var methodGrants = new Set();
      RESOURCE_METHODS.forEach(function (method) {
        var permissions = catalog[uri][method.name];
        if (!Array.isArray(permissions)) return;
        methods[method.name] = Array.from(new Set(permissions));
        permissions.forEach(function (permission) {
          names.add(permission);
          if (coreMethods.indexOf(method.name) === -1) methodGrants.add(permission);
          else if (runtimePermissions.permissions.indexOf(permission) === -1) additional.add(permission);
        });
      });
      methods.OPTIONS = [];
      return Object.assign({}, metadata[uri] || { uri: uri, label: uri, description: '' }, {
        supportedMethods: Object.keys(methods),
        methodPermissions: methods,
        // Core methods stay enabled without granting optional capabilities such as
        // page JavaScript, browser windows, downloads or debugger access.
        additionalPermissions: Array.from(additional).filter(function (permission) {
          return !methodGrants.has(permission);
        }).sort(),
      });
    });
    RESOURCE_PERMISSION_NAMES = Array.from(names).sort();
  }

  function hasResourcePermissionCatalog() { return RESOURCE_ROOTS !== null; }

  function requireResourcePermissionCatalog() {
    if (!hasResourcePermissionCatalog()) throw new Error('资源权限目录尚未加载，无法配置授权');
  }

  function normalizedMethods(value, fallback) {
    var source = Array.isArray(value)
      ? value
      : (isRecord(value) && Array.isArray(value.methods) ? value.methods : fallback);
    var selected = Object.create(null);
    (Array.isArray(source) ? source : []).forEach(function (method) {
      method = String(method || '').trim().toUpperCase();
      if (RESOURCE_METHOD_SET[method]) selected[method] = true;
    });
    selected.OPTIONS = true;
    return RESOURCE_METHODS.map(function (method) { return method.name; }).filter(function (method) {
      return !!selected[method];
    });
  }

  function fullResourcePolicy() {
    requireResourcePermissionCatalog();
    var roots = {};
    RESOURCE_ROOTS.forEach(function (root) { roots[root.uri] = { methods: root.supportedMethods.slice() }; });
    return { roots: roots, permissions: RESOURCE_PERMISSION_NAMES.slice() };
  }

  function defaultRuntimeResourcePolicy() {
    requireResourcePermissionCatalog();
    var roots = {};
    RESOURCE_ROOTS.forEach(function (root) {
      roots[root.uri] = { methods: (runtimePermissions.rootMethods[root.uri] || ['OPTIONS']).filter(function (method) {
        return root.supportedMethods.indexOf(method) !== -1;
      }) };
    });
    return { roots: roots, permissions: runtimePermissions.permissions.slice() };
  }

  function normalizedPermissions(value, fallback) {
    var source = Array.isArray(value) ? value : fallback;
    var selected = Object.create(null);
    (Array.isArray(source) ? source : []).forEach(function (permission) {
      permission = String(permission || '').trim();
      if (RESOURCE_PERMISSION_NAMES.indexOf(permission) !== -1) selected[permission] = true;
    });
    runtimePermissions.permissions.forEach(function (permission) { if (permission !== 'local.execute') selected[permission] = true; });
    return RESOURCE_PERMISSION_NAMES.filter(function (permission) { return !!selected[permission]; });
  }

  function permissionsForRootMethods(roots) {
    var selected = Object.create(null);
    RESOURCE_ROOTS.forEach(function (root) {
      var methodPermissions = root.methodPermissions;
      var coreMethods = coreMethodsForRoot(root.uri);
      var methods = roots[root.uri] && roots[root.uri].methods || [];
      methods.forEach(function (method) {
        // A mandatory method is not consent to every capability behind it.
        if (coreMethods.indexOf(method) !== -1) return;
        (methodPermissions[method] || []).forEach(function (permission) {
          selected[permission] = true;
        });
      });
    });
    return RESOURCE_PERMISSION_NAMES.filter(function (permission) { return !!selected[permission]; });
  }

  function normalizeResourcePolicy(policy, base) {
    requireResourcePermissionCatalog();
    var sourceProvided = isRecord(policy);
    var baseProvided = isRecord(base);
    var source = sourceProvided ? policy : {};
    var fallback = baseProvided ? base : defaultRuntimeResourcePolicy();
    var sourceRoots = isRecord(source.roots) ? source.roots : {};
    var fallbackRoots = isRecord(fallback.roots) ? fallback.roots : {};
    var knownRoots = RESOURCE_ROOTS.reduce(function (output, root) {
      output[root.uri] = true;
      return output;
    }, Object.create(null));
    function legacyBuckets(value) {
      var keys = safeKeys(value).filter(function (key) { return !knownRoots[key]; });
      return keys.length === 2 && (value['/page'] || value['/browser'])
        ? { flow: value[keys[0]], integration: value[keys[1]] }
        : null;
    }
    var sourceLegacy = legacyBuckets(sourceRoots);
    var fallbackLegacy = legacyBuckets(fallbackRoots);
    var roots = {};
    RESOURCE_ROOTS.forEach(function (root) {
      var sourceValue = Object.prototype.hasOwnProperty.call(sourceRoots, root.uri) ? sourceRoots[root.uri] : undefined;
      var fallbackValue = fallbackRoots[root.uri];
      if (root.uri === '/recordings' && sourceValue === undefined) sourceValue = { methods: ['GET', 'OPTIONS'] };
      var integrationRoot = INTEGRATION_ROOT_URIS.indexOf(root.uri) !== -1;
      if (sourceValue === undefined && sourceLegacy && root.uri !== '/page' && root.uri !== '/browser') {
        sourceValue = integrationRoot ? sourceLegacy.integration : sourceLegacy.flow;
      }
      if (fallbackValue === undefined && fallbackLegacy && root.uri !== '/page' && root.uri !== '/browser') {
        fallbackValue = integrationRoot ? fallbackLegacy.integration : fallbackLegacy.flow;
      }
      var fallbackMethods = Array.isArray(fallbackValue)
        ? fallbackValue
        : (isRecord(fallbackValue) ? fallbackValue.methods : runtimePermissions.rootMethods[root.uri] || ['OPTIONS']);
      var methods = normalizedMethods(sourceValue, fallbackMethods);
      // Recording retrieval is a core capability of every assistant. Keep the
      // legacy root present even when an older explicit allowlist omitted it.
      if (root.uri === '/recordings') {
        if (methods.indexOf('GET') === -1) methods.push('GET');
        if (methods.indexOf('OPTIONS') === -1) methods.push('OPTIONS');
        methods = RESOURCE_METHODS.map(function (method) { return method.name; }).filter(function (method) {
          return methods.indexOf(method) !== -1;
        });
      }
      var requiredMethods = coreMethodsForRoot(root.uri);
      requiredMethods.forEach(function (method) {
        if (methods.indexOf(method) === -1) methods.push(method);
      });
      methods = RESOURCE_METHODS.map(function (method) { return method.name; }).filter(function (method) {
        return methods.indexOf(method) !== -1 && root.supportedMethods.indexOf(method) !== -1;
      });
      roots[root.uri] = { methods: methods };
    });
    var output = { roots: roots };
    var sourceHasPermissions = Object.prototype.hasOwnProperty.call(source, 'permissions');
    var baseHasPermissions = baseProvided && Object.prototype.hasOwnProperty.call(fallback, 'permissions');
    var sourcePermissions = sourceHasPermissions ? source.permissions : undefined;
    var fallbackPermissions = baseHasPermissions || !sourceProvided ? fallback.permissions : undefined;
    output.permissions = normalizedPermissions(
      normalizedPermissions(sourcePermissions, fallbackPermissions).concat(permissionsForRootMethods(roots)),
      []
    );
    return output;
  }

  function createResourcePolicy(input) {
    requireResourcePermissionCatalog();
    input = isRecord(input) ? input : {};
    if (input.full === true) return fullResourcePolicy();
    if (Array.isArray(input.methods)) {
      var commonRoots = {};
      RESOURCE_ROOTS.forEach(function (root) { commonRoots[root.uri] = { methods: input.methods }; });
      var commonPolicy = { roots: commonRoots };
      if (Object.prototype.hasOwnProperty.call(input, 'permissions')) commonPolicy.permissions = input.permissions;
      return normalizeResourcePolicy(commonPolicy);
    }
    if (isRecord(input.roots)) {
      var roots = {};
      RESOURCE_ROOTS.forEach(function (root) {
        roots[root.uri] = Object.prototype.hasOwnProperty.call(input.roots, root.uri)
          ? input.roots[root.uri]
          : { methods: ['OPTIONS'] };
      });
      var rootPolicy = { roots: roots };
      if (Object.prototype.hasOwnProperty.call(input, 'permissions')) rootPolicy.permissions = input.permissions;
      return normalizeResourcePolicy(rootPolicy);
    }
    return defaultRuntimeResourcePolicy();
  }

  function resourcePolicyCatalog() {
    requireResourcePermissionCatalog();
    return cloneSafe({
      sections: RESOURCE_SECTIONS,
      roots: RESOURCE_ROOTS,
      methods: RESOURCE_METHODS,
      permissions: RESOURCE_PERMISSION_NAMES,
      coreRootMethods: Object.assign({}, runtimePermissions.rootMethods, { '/local': ['GET'] }),
      corePermissions: runtimePermissions.permissions.filter(function (permission) { return permission !== 'local.execute'; }),
    });
  }

  function stringValue(value, fallback) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return String(fallback === undefined || fallback === null ? '' : fallback);
  }

  function normalizeResourceIds(value, fallback) {
    var source = Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);
    var seen = Object.create(null);
    return source.map(function (item) { return String(item || '').trim(); }).filter(function (item) {
      if (!item || item.length > 240 || /[/\\\u0000-\u001F\u007F]/.test(item) || seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function nonNegativeInteger(value, fallback) {
    var number = Math.floor(finiteNumber(value, fallback));
    return number >= 0 ? number : fallback;
  }

  function positiveInteger(value, fallback) {
    var number = Math.floor(finiteNumber(value, fallback));
    return number >= 1 ? number : fallback;
  }

  function defaultSettings(defaultMaxIterations, defaultMaxToolCalls) {
    return {
      runner: 'agent-core',
      temperature: 0,
      topP: 1,
      maxTokens: 4096,
      maxContextTokens: 0,
      reasoningEffort: 'auto',
      contextCompression: 'auto',
      streamOutput: true,
      mode: 'fullAuto',
      maxIterations: defaultMaxIterations,
      maxToolCalls: defaultMaxToolCalls,
      autoCreateNewTopic: true,
    };
  }

  var APP_DEVELOPER_SOURCE_GUIDANCE = '开始前读取 /apps 或目标应用；当前上下文缺少完整生成指引或已知指引更新时，完整读取 /knowledge/builtin_app_generation_guide。同一对话复用已读指引，不因新一轮输入、继续或后台重启而重读。仅改元数据时按摘要 ETag 局部 PATCH 应用。修改源码先读取最新摘要与权限；复用上下文中仍有效的源码片段，只对缺失部分搜索、按行读取。局部修改优先 POST /apps/{appId}/draft/edits，携带最新 ETag，仅提交唯一匹配的 oldText/newText；保存后采用返回的新 ETag。核对回执与可用 diff，不例行重读已知源码；仅在版本冲突、证据缺失或相关调用关系不明时补读受影响片段。仅完整替换字段或文件时读齐该目标，不能以片段覆盖全文。';

  var APP_DEVELOPER_PARAMETER_GUIDANCE = '应用必须声明 code.parameters，默认复用平台的空参数声明 mode=none，省略 input 或传 {} 均可正常打开。只按当前业务需求增加字段、示例与处理逻辑，不为接入机制额外添加 query 等示例字段或表单。简单赋值可用 form 映射到已有控件，需要联动时提供 applyParameters(input) 模块。保存前核对每个声明字段均有处理，不能把打开成功当作适配或业务成功。具体格式按应用 RouteContract 和按需读取的生成指引执行。';

  function buildTemplatePrompt(kind) {
    if (kind === 'default') {
      return '处理未限定专精流程的通用任务。以用户本次要求的交付物为目标，在已配置能力范围内直接回答或完成操作。';
    }
    if (kind === 'app-developer') {
      return [
        '你是 Page Agent 的应用开发工程师，必须以 YAGNI 工程师和外科手术式工程师的身份执行，并遵循第一性原理和奥卡姆剃刀原则。这些原则贯穿每轮需求分析、读取、编辑和交付。',
        '',
        '【开发原则】',
        '- YAGNI：只实现用户当前确认的需求，不为假设中的未来需求添加功能、抽象、配置或依赖。',
        '- 外科手术式修改：先定位问题与影响范围，再做足以完成目标的最小修改；保留无关行为，不顺手重构、改名、格式化或重写整个应用。',
        '- 第一性原理：从用户目标、实际输入输出、当前源码和真实资源契约推导方案；证据不足时补读直接相关内容，不凭猜测修改，不用临时补丁掩盖已确认的根因。',
        '- 奥卡姆剃刀：能够满足需求时，选择步骤、概念和依赖更少的方案，优先复用现有应用、SDK 和资源。',
        '',
        '【执行边界】',
        '- 读取范围：以目标应用的当前草稿、权限、相关资源和对话中已确认的信息为依据；按需读取发布版本、直接依赖或页面事实，不无目的地追溯历史或遍历无关源码。',
        '- 插件能力：按需使用已授权的 SDK、ARP、用户已选择或配置的 MCP 与 Skill；遵守应用生成指引和实际资源契约，不为开发便利自行扩展环境或权限。能力不足时说明具体缺口。',
        '- 验证范围：默认只做静态检查，核对源码逻辑、接口契约、权限声明和改动差异；不编写测试代码、不执行测试，不主动运行应用或业务动作来验证功能，功能测试由用户完成。只有用户明确要求时才调整验证范围。',
        '- 编辑方式：使用应用资源提供的编辑接口提交明确的局部修改，逐项核对编辑内容；禁止通过任何脚本批量替换源码。',
        '',
        '【应用开发流程】',
        '处理应用的创建、修改和修复，交付符合用户需求的 HTML、CSS、JavaScript、主题及功能声明。',
        '先明确用户要完成的业务链路、输入输出、可选步骤和完成条件；后续修改沿用已确认的目标与决定，用户反复强调的要求作为修复依据，不当作新增功能。只实现本次所需，避免添加无助于操作的说明、重复入口、预设和配置。',
        APP_DEVELOPER_SOURCE_GUIDANCE,
        APP_DEVELOPER_PARAMETER_GUIDANCE,
        '需要持久数据或调用流程、流程组、脚本时，使用 PageAgent SDK，核对能力范围、依赖和实际授权。只声明本次功能需要的能力与依赖。',
        '普通接口取数、参数加载和任务状态查询优先使用已有 SDK/ARP 直接能力；不为一次 HTTP 请求默认新建单步 Flow，也不为每次轮询创建 Run。仅有复用现有业务流程、后台任务或用户明确要求时使用 Flow。SDK 缺少能力时说明具体缺口；用户已明确要求的原生调用按 customBehavior 契约处理，不伪造接口或绕过授权。',
        '按用户要求保存草稿或发布应用，以资源写入回执确认结果；逐项对照用户要求说明实现、静态检查和待用户验证的内容。保存成功或 diff 正确不等于功能已验证，不宣称未实际验证的交互或业务链路已经可用。',
      ].join('\n');
    }
    if (kind === 'network-writer') {
      return [
        '处理需要网络资料支撑的研究、事实核验与写作任务，交付符合用户目的、受众、文体和格式的结果，并为关键主张保留必要来源。',
        '先从用户已有材料提取待回答问题、关键主张和证据缺口，只围绕缺口检索。搜索摘要只作线索；事实结论以可追溯原文为准，来源冲突时保留分歧。',
        '检索路径：POST /browser/tabs 打开搜索页（如 https://www.bing.com/search?q=关键词 或用户偏好的搜索引擎），再调用 GET /page/current?start=0&maxChars=10000；hasMore=true 且 nextStart 不为 null 时，下一次必须把 nextStart 原样作为 start 继续读取，这才是下一页，不能再次使用 start=0；重复读取仅在真实观察到页面发生变化时才被允许；hasMore=false 或 nextStart 为 null 均表示已读取完毕。实时页面变化时服务可能保守调整响应 start，后续仍只使用响应 nextStart；再打开命中链接读取原文。',
        '把命中原文整理为事实包：标题、来源主体、URL、日期、核心证据、适用口径及读取缺口。需要形成文章、报告或其他完整成文时，再调用 GET ' + KHAZIX_WRITER_URI + ' 一次读取内置写作方法全文，并采用其中适用于本次交付的工作流、文风和禁区；该资源不传 query、start 或 maxChars，也不替代事实来源。',
        '关键事实能够回溯，重要结论在必要时完成交叉核验，事实、来源观点和自己的综合已区分，即完成；关键证据不可得时说明缺口及其影响。',
      ].join('\n');
    }
    if (kind === 'page-writer') {
      return [
        '处理以当前页面为材料的阅读、总结、改写、续写、评论与创作任务，交付忠实于正文语境并保留重要限定的可用文本。',
        '先读取页面 URL、标题和与任务直接相关的正文，从 GET /page/current?start=0&maxChars=10000 开始。hasMore 只表示当前实时 PageState 还有候选项未返回，不要求穷尽；只有仍缺少任务直接相关证据时才续读。需要续读且 hasMore=true、nextStart 不为 null 时，必须把 nextStart 原样作为下一次 start，不能再次使用 start=0；hasMore=false 或 nextStart 为 null 均表示本次观察已读完。实时页面变化时服务可能保守调整响应 start，后续仍只使用响应 nextStart。不要为了耗尽 hasMore、寻找推测存在的页尾、分页或页脚而滚动。需要完整元素正文时，只能把最近一次 PageState 实际返回的 locator.selector 原样作为扁平 query 参数读取 GET /page/element?locator=<原样 locator.selector>&start=0&maxChars=4000；selector 不是可编辑的 DOM 路径，禁止添加 body、删减或拼接层级，也不得猜测未返回的 locator 或文本。',
        '整理页面事实包：作者或来源、日期、关键事实、重要引语和读取缺口；把正文与菜单、广告、推荐和评论分开，并区分页面陈述、自己的概括与改写。',
        '需要形成完整成文时，调用 GET ' + KHAZIX_WRITER_URI + ' 一次读取内置写作方法全文，并采用其中适用于本次交付的工作流、文风和禁区；该资源不传 query、start 或 maxChars，页面事实包仍是内容边界。',
        '关键表述均能由页面证据支持，数据、引语和经历没有越过页面材料，即完成；页面不可访问或关键正文缺失时说明缺口。',
      ].join('\n');
    }
    if (kind === 'builder') {
      return [
        '处理用户要求创建或保存浏览器自动化的任务，交付可维护的 Flow artifact：Flow 资源、节点顺序与分支，以及明确的输入输出约定。',
        '先明确目标行为、触发方式、目标页面状态、必要输入输出和硬约束；按需读取页面事实和现有 Flow。没有操作结果返回的现成 flowNode 时，调用 GET /node-types?match=<当前目标>&limit=20 取得候选摘要，再对选中的每个真实 nodeType 调用 GET /node-types/{nodeType}。',
        '生成页面读取节点时必须遵守公共分页契约：maxChars 默认且最大都是 10000，运行时实际按 Math.min(maxChars, 10000) 应用。任何读取结果 hasMore=true 且 nextStart 不为 null 时都只是一页，下一次读取必须把本页 nextStart 原样填入 start，这才是下一页，不能再次使用 start=0；重复读取仅在真实观察到页面或数据发生变化时才被允许；hasMore=false 或 nextStart 为 null 均表示已读取完毕。实时只读数据变化使旧 start 落入当前项内部或超过当前数据时，运行时会保守降级并返回实际采用的 start，不把这种漂移作为请求错误；后续仍只使用响应 nextStart。超大的单个结构化项可能在窗口内被有损投影并标记 truncated，被裁掉的项内字段不保证能通过 nextStart 恢复，此时必须缩小读取范围或改读原始文本。设计 HTML 转 Markdown 链路时，必须先拼接完整 HTML 再转换，禁止把首个 10000 字符直接当作完整 HTML。若当前 Flow 节点无法可靠表达动态续读与拼接，应明确报告能力缺口，不能交付一个会静默截断的流程。',
        '具体节点合同中的 description、params、required、default、options、minimum/maximum 和 outputHint 是生成节点配置的事实源，必须完整遵守，不得猜字段、填写超限值或把节点参数放在 Flow 节点顶层。节点输出存在截断、摘要上限或 FIFO 保留上限时，必须分页、缩小采集范围或明确能力缺口，不能把有界结果当作完整结果。',
        '按照当前 Flow 写入路由契约与具体节点合同选择能够可靠完成目标的最小节点抽象，不用 Assistant 替代普通节点或单次模型节点能够确定完成的步骤。需要 runAssistant 时先读取 /assistants 与 /node-types/runAssistant，再创建或复用职责单一的助手并写入 assistantId。创建 Assistant 使用 POST /assistants；复用时只读取，不为复用对象增加无关修改。',
        '创建或更新 Flow；只有目标确实需要时才同时创建或调整 FlowGroup、PageSource、URL Trigger、Script 或 Schedule，优先复用明确适用的现有资源。保存后通过 GET /flows/{flowId}?view=validation 核对节点类型、必填配置、顺序、分支和输入输出；实际运行按用户要求进行。',
        'Flow 已持久化且结构验证覆盖关键路径，即完成；页面事实或节点能力不足时指出精确缺口。',
      ].join('\n');
    }
    if (kind === 'repair') {
      return [
        '处理既有 Flow 的故障定位与修复，交付能够解释并验证的最小修改：故障事实、影响、根因、修改位置、验证结果和剩余边界。',
        '先读取失败 Run、报告或调试信息，定位失败节点并对照预期与实际；再读取对应 Flow，并对受影响的每个真实 nodeType 调用 GET /node-types/{nodeType} 取得完整节点合同，同时读取直接关联的 FlowGroup、PageSource、URL Trigger、Script、Schedule 或 Assistant。证据不足时先补证据，不猜测性修改。若根因已确认位于既有 runAssistant 的 Assistant 定义，只 PATCH 该助手的必要字段；不为修复创建新助手。',
        '只修改与已确认原因直接相关的节点、顺序、分支、字段或关联资源；仅在节点已确认多余或错误且删除是最小修复时删除该节点，保留无关行为。',
        '修改后通过 GET /flows/{flowId}?view=validation 核对受影响契约；需要实际运行时沿原失败路径复验，并比较修复前后的失败信号。',
        '故障已消失且相关路径未出现新的失败，或已定位到当前能力范围外的明确阻塞并给出恢复条件，即完成。',
      ].join('\n');
    }
    if (kind === 'review') {
      return [
        '处理 Flow 审查任务；审查期间保持只读，交付按严重度排序的发现，而不是直接修改资源。',
        '读取用户指定的 Flow，并对其中每个需要审查的真实 nodeType 调用 GET /node-types/{nodeType} 取得完整节点合同；同时读取直接关联的 FlowGroup、PageSource、URL Trigger、Script、Schedule、Assistant 和已有 Run 证据，交叉核对节点配置、顺序、分支、前置条件、输入输出、副作用与失败处理。',
        '每项发现包含影响、位置、证据、置信级别和可执行建议。配置、契约或运行记录直接支持的问题列为已确认；多项信号支持但缺少直接复现的列为风险；预防性优化与风格偏好单列为建议。',
        '约定范围已覆盖、发现已分级且关键证据缺口均已说明，即完成；没有发现时明确已检查范围和剩余限制。',
      ].join('\n');
    }
    if (kind === 'runner') {
      return [
        '处理 Flow 或 FlowGroup 的运行任务，交付本次运行可核对的真实状态：runId、最终或当前 status、关键 output，以及失败节点、原因和可重试条件。',
        '启动前读取并确认唯一目标、必填输入和当前运行状态；纯运行任务不修改 Flow。目标或输入不唯一、不完整时，在启动前指出缺口。',
        '通过 POST /flows/{flowId}/runs 或 POST /flow-groups/{groupId}/runs 启动运行，保留创建回执中的 runId；随后读取 /runs/{runId}，必要时读取报告或调试信息，直到终态或已没有继续等待的依据。',
        '结果以 Run 资源为准，不用启动成功代替运行成功；失败时保留原始失败位置和原因。达到终态并完成结果汇报，即完成；尚未终止时报告当前状态。',
      ].join('\n');
    }
    throw new TypeError('Unknown assistant template kind: ' + kind);
  }

  function upgradeAppDeveloperPrompt(prompt) {
    // Only replace exact builtin defaults; user-edited prompts remain intact.
    var previousSourceGuidance = [
      '开始前读取 /apps 或目标应用；修改已有应用时读取最新草稿和权限，再完整读取 /knowledge/builtin_app_generation_guide，按当前应用契约开发。',
      '开始前读取 /apps 或目标应用，再完整读取 /knowledge/builtin_app_generation_guide。仅改名称、别名、图标或描述时按摘要 ETag 局部 PATCH 应用；修改源码时先读摘要和权限，通过 /apps/{appId}/draft/{field} 独立读取字段，已发布版本用 /published/{field}。长文本加 q 按标准 grep 定位，省略 q 按行读取，用 startLine/startColumn 和 revision 续读。PATCH 是字段整体替换，须读齐待修改字段，不能以搜索片段覆盖全文。',
      '开始前读取 /apps 或目标应用，再按当前契约完整读取 /knowledge/builtin_app_generation_guide。仅改元数据时按摘要 ETag 局部 PATCH 应用。修改源码先读取最新摘要与权限；复用上下文中仍有效的源码片段，只对缺失部分搜索、按行读取。局部修改优先 POST /apps/{appId}/draft/edits，携带最新 ETag，仅提交唯一匹配的 oldText/newText；保存后采用返回的新 ETag。核对回执与可用 diff，不例行重读已知源码；仅在版本冲突、证据缺失或相关调用关系不明时补读受影响片段。仅完整替换字段或文件时读齐该目标，不能以片段覆盖全文。',
      APP_DEVELOPER_SOURCE_GUIDANCE,
    ];
    // Retain the former wording only for exact migration, never as active guidance.
    var previousPrompt = [
      '处理应用的创建、修改和修复，交付符合用户需求的 HTML、CSS、JavaScript、主题及功能声明。围绕本次需求做必要修改，优先复用已有应用和依赖。',
      '以 YAGNI 工程师和外科手术式工程师 身份来执行，执行时必须遵从第一性原理和奥卡姆剃刀原则。非必要不读历史代码，只看当前工作区，不添加 mcp ，不使用 skill。不编译，不看 m2，不解压 jar 包。不写测试代码。不测试，静态检查即可，我来测试。编辑代码时，不通过任何脚本形式批量替换。',
      '先明确用户要完成的业务链路、输入输出、可选步骤和完成条件；后续修改沿用已确认的目标与决定，用户反复强调的要求作为修复依据，不当作新增功能。只实现本次所需，避免添加无助于操作的说明、重复入口、预设和配置。',
      APP_DEVELOPER_SOURCE_GUIDANCE,
      '需要持久数据或调用流程、流程组、脚本时，使用 PageAgent SDK，核对能力范围、依赖和实际授权。只声明本次功能需要的能力与依赖。',
      '普通接口取数、参数加载和任务状态查询优先使用已有 SDK/ARP 直接能力；不为一次 HTTP 请求默认新建单步 Flow，也不为每次轮询创建 Run。仅有复用现有业务流程、后台任务或用户明确要求时使用 Flow。SDK 缺少能力时说明具体缺口；用户已明确要求的原生调用按 customBehavior 契约处理，不伪造接口或绕过授权。',
      '按用户要求保存草稿或发布应用，以资源写入回执确认结果；逐项对照用户要求说明实现、静态检查和待用户验证的内容。保存成功或 diff 正确不等于功能已验证，不宣称未实际验证的交互或业务链路已经可用。',
    ].join('\n');
    var currentPrompt = buildTemplatePrompt('app-developer');
    if (prompt === currentPrompt.replace('\n' + APP_DEVELOPER_PARAMETER_GUIDANCE, '')) return currentPrompt;
    var previousParameterGuidance = '应用必须声明 code.parameters，明确支持的参数、示例与实际适配过程；优先使用平台默认表单映射，复杂交互提供 applyParameters(input) 模块，无参数需求时明确声明不接收。保存前核对每个声明字段均有处理，不能把打开成功当作适配或业务成功。具体格式按应用 RouteContract 和按需读取的生成指引执行。';
    if (prompt === currentPrompt.replace(APP_DEVELOPER_PARAMETER_GUIDANCE, previousParameterGuidance)) return currentPrompt;
    var isPreviousDefault = previousSourceGuidance.some(function (sourceGuidance) {
      return prompt === [
        '处理应用的创建、修改和修复，交付符合用户需求的 HTML、CSS、JavaScript、主题及功能声明。围绕本次需求做必要修改，优先复用已有应用和依赖。',
        sourceGuidance,
        '需要持久数据或调用流程、流程组、脚本时，使用 PageAgent SDK，核对能力范围、依赖和实际授权。只声明本次功能需要的能力与依赖。',
        '按用户要求保存草稿或发布应用，以资源写入回执确认结果；说明已完成的功能、验证结果和待处理事项。',
      ].join('\n') || prompt === previousPrompt.replace(APP_DEVELOPER_SOURCE_GUIDANCE, sourceGuidance);
    });
    return isPreviousDefault ? currentPrompt : prompt;
  }


  function create(options) {
    options = options || {};
    var now = typeof options.now === 'function' ? options.now : Date.now;
    var defaultMaxIterations = positiveInteger(options.defaultMaxIterations, 100);
    var defaultMaxToolCalls = positiveInteger(options.defaultMaxToolCalls, 200);

    function normalizeReasoningEffort(value) {
      if (typeof options.normalizeReasoningEffort === 'function') {
        return options.normalizeReasoningEffort(value);
      }
      var allowed = { auto: true, none: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
      var text = stringValue(value, '').trim().toLowerCase();
      if (text === 'x-high' || text === 'x_high') text = 'xhigh';
      return allowed[text] ? text : 'auto';
    }

    function normalizeContextCompression(value) {
      if (typeof options.normalizeContextCompression === 'function') {
        return options.normalizeContextCompression(value);
      }
      return stringValue(value, '').trim() === 'off' ? 'off' : 'auto';
    }

    function normalizeSettings(settings, base) {
      var source = isRecord(settings) ? settings : {};
      var merged = safeMerge(defaultSettings(defaultMaxIterations, defaultMaxToolCalls), isRecord(base) ? base : {}, source);
      delete merged['allow' + 'High' + 'Risk' + 'Tools'];
      delete merged.reasoning_effort;
      merged.runner = 'agent-core';
      merged.temperature = finiteNumber(merged.temperature, 0);
      merged.topP = finiteNumber(merged.topP, 1);
      merged.maxTokens = positiveInteger(merged.maxTokens, 4096);
      merged.maxContextTokens = nonNegativeInteger(merged.maxContextTokens, 0);
      merged.reasoningEffort = normalizeReasoningEffort(source.reasoningEffort || source.reasoning_effort || merged.reasoningEffort);
      merged.contextCompression = normalizeContextCompression(source.contextCompression || merged.contextCompression);
      merged.streamOutput = merged.streamOutput !== false;
      merged.mode = merged.mode === 'normal' ? 'normal' : 'fullAuto';
      merged.maxIterations = positiveInteger(merged.maxIterations, defaultMaxIterations);
      merged.maxToolCalls = positiveInteger(merged.maxToolCalls, defaultMaxToolCalls);
      merged.autoCreateNewTopic = merged.autoCreateNewTopic !== false;
      return merged;
    }

    function normalizeProfile(profile, profileOptions) {
      profileOptions = profileOptions || {};
      var source = isRecord(profile) ? profile : {};
      var fallback = isRecord(profileOptions.fallback) ? profileOptions.fallback : {};
      var out = {};
      var requestedVersion = nonNegativeInteger(source.profileVersion, 0);
      out.profileVersion = Math.max(PROFILE_VERSION, requestedVersion);
      out.id = stringValue(profileOptions.id !== undefined ? profileOptions.id : (source.id !== undefined ? source.id : fallback.id), '').trim();
      out.name = stringValue(source.name !== undefined ? source.name : fallback.name, profileOptions.defaultName || '').trim();
      out.description = stringValue(source.description !== undefined ? source.description : fallback.description, '').trim();
      out.settings = normalizeSettings(source.settings, fallback.settings);
      out.prompt = stringValue(source.prompt !== undefined
        ? source.prompt
        : (fallback.prompt !== undefined ? fallback.prompt : ''), '');
      out.skillIds = normalizeResourceIds(source.skillIds, fallback.skillIds);
      out.mcpServerIds = normalizeResourceIds(source.mcpServerIds, fallback.mcpServerIds).slice(0, 50);
      out.modelServiceId = stringValue(source.modelServiceId !== undefined
        ? source.modelServiceId
        : (source.settings && source.settings.modelServiceId !== undefined
          ? source.settings.modelServiceId
          : (fallback.modelServiceId !== undefined ? fallback.modelServiceId : fallback.settings && fallback.settings.modelServiceId)), '').trim();
      delete out.settings.taskStrategy;
      delete out.settings.assistantProfile;
      delete out.settings.modelServiceId;
      var sourceResourcePolicy = source.resourcePolicy;
      if (requestedVersion < 6) {
        sourceResourcePolicy = safeMerge(sourceResourcePolicy || {});
        sourceResourcePolicy.roots = safeMerge(sourceResourcePolicy.roots || {});
        sourceResourcePolicy.roots['/recordings'] = { methods: ['GET', 'OPTIONS'] };
      }
      out.resourcePolicy = normalizeResourcePolicy(sourceResourcePolicy, fallback.resourcePolicy);
      out.createdAt = nonNegativeInteger(source.createdAt !== undefined ? source.createdAt : fallback.createdAt, 0);
      out.updatedAt = nonNegativeInteger(source.updatedAt !== undefined ? source.updatedAt : fallback.updatedAt, 0);
      return out;
    }

    function mergeProfile(current, patch, profileOptions) {
      var base = isRecord(current) ? current : {};
      var delta = isRecord(patch) ? patch : {};
      var merged = safeMerge(base, delta);
      merged.settings = safeMerge(base.settings, delta.settings);
      merged.resourcePolicy = normalizeResourcePolicy(delta.resourcePolicy, base.resourcePolicy);
      return normalizeProfile(merged, profileOptions);
    }

    function signature(profile) {
      var normalized = normalizeProfile(profile);
      var settings = normalized.settings;
      return stableStringify({
        prompt: normalized.prompt,
        skillIds: normalized.skillIds,
        mcpServerIds: normalized.mcpServerIds,
        modelServiceId: normalized.modelServiceId,
        settings: {
          runner: settings.runner,
          temperature: settings.temperature,
          topP: settings.topP,
          maxTokens: settings.maxTokens,
          maxContextTokens: settings.maxContextTokens,
          reasoningEffort: settings.reasoningEffort,
          contextCompression: settings.contextCompression,
          streamOutput: settings.streamOutput,
          mode: settings.mode,
          maxIterations: settings.maxIterations,
          maxToolCalls: settings.maxToolCalls,
          autoCreateNewTopic: settings.autoCreateNewTopic,
        },
        resourcePolicy: normalized.resourcePolicy,
      });
    }

    function snapshot(profile, snapshotOptions) {
      snapshotOptions = snapshotOptions || {};
      var source = isRecord(profile) ? profile : {};
      var normalized = normalizeProfile(source, { id: snapshotOptions.id });
      var out = safeMerge(normalized);
      delete out.createdAt;
      delete out.updatedAt;
      out.sourceUpdatedAt = nonNegativeInteger(source.sourceUpdatedAt || source.updatedAt, 0);
      out.snapshotAt = snapshotOptions.preserveSnapshotAt
        ? nonNegativeInteger(source.snapshotAt, 0) || now()
        : now();
      out.signature = signature(out);
      return out;
    }

    function normalizeSnapshot(value, snapshotOptions) {
      snapshotOptions = safeMerge(snapshotOptions || {}, { preserveSnapshotAt: true });
      return snapshot(value, snapshotOptions);
    }

    function mergeSnapshot(current, patch, snapshotOptions) {
      var merged = mergeProfile(current, patch, { id: snapshotOptions && snapshotOptions.id });
      merged.sourceUpdatedAt = isRecord(patch) && patch.sourceUpdatedAt !== undefined
        ? patch.sourceUpdatedAt
        : current && current.sourceUpdatedAt;
      merged.snapshotAt = now();
      return snapshot(merged, safeMerge(snapshotOptions || {}, { preserveSnapshotAt: true }));
    }

    function assistantTemplates() {
      var baseSettings = defaultSettings(defaultMaxIterations, defaultMaxToolCalls);
      var defaultPolicy = defaultRuntimeResourcePolicy();
      function builtinPolicy(rootOverrides, extraPermissions) {
        var roots = cloneSafe(defaultPolicy.roots);
        (Array.isArray(rootOverrides) ? rootOverrides : []).forEach(function (group) {
          (Array.isArray(group.roots) ? group.roots : []).forEach(function (uri) {
            roots[uri] = { methods: group.methods || ['OPTIONS'] };
          });
        });
        return createResourcePolicy({
          roots: roots,
          permissions: defaultPolicy.permissions.concat(Array.isArray(extraPermissions) ? extraPermissions : []),
        });
      }
      var networkWritingPolicy = builtinPolicy();
      var pageWritingPolicy = builtinPolicy();
      var flowDesignPolicy = builtinPolicy([
        { roots: ['/assistants'], methods: ['GET', 'POST', 'OPTIONS'] },
      ], [
        'assistants.write',
      ]);
      var flowRepairPolicy = builtinPolicy([
        { roots: ['/flows'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
        { roots: ['/assistants'], methods: ['GET', 'PATCH', 'OPTIONS'] },
      ], [
        'flows.nodes.delete', 'assistants.write',
      ]);
      var reviewPolicy = builtinPolicy();
      var runnerPolicy = builtinPolicy();
      function templateProfile(value) {
        var profile = normalizeProfile(value);
        delete profile.createdAt;
        delete profile.updatedAt;
        return profile;
      }
      var items = {
        tpl_default_assistant: templateProfile({
          id: 'tpl_default_assistant',
          name: '默认助手',
          description: '完成未限定专精流程的问答、分析与执行任务',
          prompt: buildTemplatePrompt('default'),
          modelServiceId: '',
          settings: baseSettings,
          resourcePolicy: createResourcePolicy(),
        }),
        tpl_app_developer: templateProfile({
          id: 'tpl_app_developer',
          name: '应用开发助手',
          description: '创建、修改和修复应用，保存源码并维护 SDK 能力与依赖',
          prompt: buildTemplatePrompt('app-developer'),
          settings: baseSettings,
          resourcePolicy: createResourcePolicy(),
        }),
        tpl_network_search_writer: templateProfile({
          id: 'tpl_network_search_writer',
          name: '网络搜索写作助手',
          description: '基于可核验网络来源完成研究、归纳与写作交付',
          prompt: buildTemplatePrompt('network-writer'),
          settings: baseSettings,
          resourcePolicy: networkWritingPolicy,
        }),
        tpl_page_reader_writer: templateProfile({
          id: 'tpl_page_reader_writer',
          name: '读取页面写作助手',
          description: '以当前页面证据为边界完成阅读、总结、改写或创作',
          prompt: buildTemplatePrompt('page-writer'),
          settings: baseSettings,
          resourcePolicy: pageWritingPolicy,
        }),
        tpl_flow_builder: templateProfile({
          id: 'tpl_flow_builder',
          name: '流程生成助手',
          description: '设计并交付可保存、可维护的浏览器自动化 Flow',
          prompt: buildTemplatePrompt('builder'),
          settings: baseSettings,
          resourcePolicy: flowDesignPolicy,
        }),
        tpl_flow_repair: templateProfile({
          id: 'tpl_flow_repair',
          name: '流程修复助手',
          description: '依据失败证据对既有 Flow 做最小、可验证的修复',
          prompt: buildTemplatePrompt('repair'),
          settings: baseSettings,
          resourcePolicy: flowRepairPolicy,
        }),
        tpl_flow_reviewer: templateProfile({
          id: 'tpl_flow_reviewer',
          name: '流程审查助手',
          description: '只读审查 Flow、节点契约和已有运行证据并分级报告风险',
          prompt: buildTemplatePrompt('review'),
          settings: baseSettings,
          resourcePolicy: reviewPolicy,
        }),
        tpl_flow_runner: templateProfile({
          id: 'tpl_flow_runner',
          name: '流程运行助手',
          description: '按明确目标和输入启动 Flow 或 FlowGroup 并汇报真实运行结果',
          prompt: buildTemplatePrompt('runner'),
          settings: baseSettings,
          resourcePolicy: runnerPolicy,
        }),
      };
      return {
        order: [
          'tpl_default_assistant',
          'tpl_app_developer',
          'tpl_network_search_writer',
          'tpl_page_reader_writer',
          'tpl_flow_builder',
          'tpl_flow_repair',
          'tpl_flow_reviewer',
          'tpl_flow_runner',
        ],
        items: cloneSafe(items),
      };
    }

    return {
      PROFILE_VERSION: PROFILE_VERSION,
      normalizeSettings: normalizeSettings,
      normalizeProfile: normalizeProfile,
      mergeProfile: mergeProfile,
      signature: signature,
      snapshot: snapshot,
      normalizeSnapshot: normalizeSnapshot,
      mergeSnapshot: mergeSnapshot,
      normalizeResourcePolicy: normalizeResourcePolicy,
      createResourcePolicy: createResourcePolicy,
      resourcePolicyCatalog: resourcePolicyCatalog,
      assistantTemplates: assistantTemplates,
    };
  }

  return {
    PROFILE_VERSION: PROFILE_VERSION,
    installResourcePermissionCatalog: installResourcePermissionCatalog,
    hasResourcePermissionCatalog: hasResourcePermissionCatalog,
    create: create,
    cloneSafe: cloneSafe,
    safeMerge: safeMerge,
    safeShallowMerge: safeShallowMerge,
    sameValue: sameValue,
    buildTemplatePrompt: buildTemplatePrompt,
    upgradeAppDeveloperPrompt: upgradeAppDeveloperPrompt,
  };
});
