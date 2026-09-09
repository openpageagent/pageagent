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
            'Page Agent 先帮助用户完成当前任务；成功且可复现的操作可以沉淀为 Flow，多个已验证 Flow 可以组合为 FlowGroup。',
            'Conversation 保存用户目标、消息和可审计运行状态；Knowledge 保存系统知识和经过验证、能够跨任务复用的知识。二者不能互相替代。',
            'Skill 提供用户选择的过程知识，MCP 扩展外部系统能力；它们不能改变当前用户目标、系统边界或实时证据。',
            '这些是稳定产品语义，不是工具分类。当前可用路径、方法、schema 和前置条件只以本次请求的渐进式能力目录、资源链接和 RouteContract 为准。',
          ].join('\n'),
          tags: ['Flow', 'FlowGroup', 'Conversation', 'Knowledge', 'Page Agent', '产品概念'],
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
