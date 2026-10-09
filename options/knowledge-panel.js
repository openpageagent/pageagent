// Options Knowledge, Skill, and HTTP MCP resource panel.
(function attachOptionsKnowledgePanel(root, factory) {
  'use strict';
  root.OptionsKnowledgePanel = factory(root);
})(globalThis, function (root) {
  'use strict';

  var initialized = false;
  var deps = {};
  var resourceClient = null;
  var renderSequence = 0;
  var searchTimer = 0;
  var composingSearch = null;
  var knowledgeLoadSequence = 0;
  var skillLoadSequence = 0;
  var settingsSaveChain = Promise.resolve();
  var idempotencySequence = 0;
  var DEFAULT_PAGE_SIZE = 50;
  var PAGE_SIZE_OPTIONS = [25, 50, 100];
  var TYPE_LABELS = Object.freeze({
    conversation: '对话沉淀',
    process: '流程步骤',
    experience: '经验规则',
    tool: '工具知识',
    mcp: 'MCP 知识',
    skill: 'Skill 知识',
    document: '文档知识',
    custom: '通用知识',
  });
  var SOURCE_LABELS = Object.freeze({
    builtin: '内置知识',
    auto: '维护知识',
    mcp: 'MCP',
    skill: 'Skill',
  });
  var OPERATION_LABELS = Object.freeze({
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    interrupted: '已中断',
  });
  var OPERATION_KIND_LABELS = Object.freeze({
    'mcp-server-connection-attempt': '连接检查',
    'mcp-tool-discovery': '工具刷新',
    'mcp-call': '工具调用',
  });
  var TERMINAL_OPERATION_STATES = Object.freeze({ succeeded: true, failed: true, interrupted: true });

  var queryState = {
    q: '',
    type: '',
    sourceKind: '',
    includeArchived: false,
    includeStale: false,
    cursor: 0,
    limit: DEFAULT_PAGE_SIZE,
  };
  var viewState = {
    knowledgePage: { items: [], total: 0, cursor: 0, nextCursor: null, limit: DEFAULT_PAGE_SIZE },
    settings: null,
    skills: [],
    skillTotal: 0,
    mcpServers: [],
    mcpServerTotal: 0,
    toolsByServer: Object.create(null),
    errors: Object.create(null),
  };
  var knowledgeDraft = null;
  var skillDraft = null;
  var skillImportDraft = null;
  var skillFilter = { q: '', page: 0 };
  var selectedSkills = new Set();
  var selectedKnowledge = new Set();
  var activeTask = null;
  var skillTrees = { skill: new Map(), import: new Map() };
  var treeExpansion = { skill: new Map(), import: new Map() };
  var mcpDraft = null;
  var toolCallDraft = null;
  var operations = Object.create(null);
  var operationTimers = Object.create(null);

  function $(selector) {
    return (deps.$ || document.querySelector.bind(document))(selector);
  }

  function esc(value) {
    if (deps.esc) return deps.esc(value);
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function toast(message, isError) {
    if (deps.toast) deps.toast(message, isError);
  }

  function confirmAction(message) {
    if (typeof deps.confirm === 'function') return deps.confirm(message) === true;
    return typeof root.confirm !== 'function' || root.confirm(message) === true;
  }

  function errorText(error, fallback) {
    var code = error && error.code ? '[' + error.code + '] ' : '';
    var message = error && error.message ? error.message : String(error || fallback || '资源操作失败');
    return code + message;
  }

  function yieldToPage() {
    return new Promise(function (resolve) { root.setTimeout(resolve, 0); });
  }

  function taskRunning() { return !!(activeTask && activeTask.running); }

  function renderTaskStatus() {
    if (!activeTask) return '';
    var task = activeTask;
    return '<div class="knowledge-task-status" role="status" aria-live="polite">'
      + '<span>' + esc(task.label) + '：' + esc(task.done) + ' / ' + esc(task.total)
      + ' · 成功 ' + esc(task.succeeded) + ' · 失败 ' + esc(task.failures.length)
      + (task.running ? (task.cancelled ? ' · 正在停止…' : ' · 处理中') : (task.cancelled ? ' · 已停止' : ' · 已结束')) + '</span>'
      + '<progress max="' + Math.max(1, task.total) + '" value="' + task.done + '"></progress>'
      + (task.detail ? '<span class="knowledge-task-detail">' + esc(task.detail) + '</span>' : '')
      + (task.running ? '<button class="btn-small" data-knowledge-action="stop-task"' + (task.cancelled ? ' disabled' : '') + '>停止后续处理</button>'
        : '<button type="button" class="btn-small" data-knowledge-action="dismiss-task" aria-label="关闭进度提示">关闭</button>')
      + (task.failures.length ? '<details><summary>失败详情（显示前 20 项）</summary>'
        + task.failures.slice(0, 20).map(function (failure) { return '<div>' + esc(failure) + '</div>'; }).join('') + '</details>' : '')
      + '</div>';
  }

  function updateTaskStatus() {
    var status = $('#knowledge-task-status');
    if (status) status.innerHTML = renderTaskStatus();
  }

  function beginTask(label, total) {
    root.clearTimeout(searchTimer);
    renderSequence += 1;
    knowledgeLoadSequence += 1;
    skillLoadSequence += 1;
    activeTask = { label: label, total: total, done: 0, succeeded: 0, failures: [], cancelled: false, running: true, detail: '' };
    renderCurrentState();
    scrollIntoView('#knowledge-task-status');
    return activeTask;
  }

  async function runBatch(label, items, process, refresh) {
    if (taskRunning()) return;
    var task = beginTask(label, items.length);
    try {
      for (var index = 0; index < items.length; index += 1) {
        if (task.cancelled) break;
        var item = items[index];
        task.detail = String(item.name || item.title || item.path || item.id || item);
        updateTaskStatus();
        await yieldToPage();
        if (task.cancelled) break;
        try {
          await process(item, task);
          task.succeeded += 1;
        } catch (error) {
          if (task.cancelled && error && error.name === 'AbortError') break;
          task.failures.push(task.detail + '：' + errorText(error));
        }
        task.done += 1;
      }
      task.detail = '正在刷新列表…';
      updateTaskStatus();
      await refresh();
    } catch (error) {
      task.failures.push(errorText(error));
    } finally {
      task.running = false;
      task.detail = '';
      renderCurrentState(true);
    }
  }

  function checkTaskCancelled(task) {
    if (task && task.cancelled) throw new DOMException('已停止', 'AbortError');
  }

  function renderLocalPagination(page, total, action) {
    var pages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
    return '<div class="knowledge-pagination"><span>第 ' + (page + 1) + ' / ' + pages + ' 页 · 共 ' + total + ' 项</span>'
      + '<div class="knowledge-pagination-controls"><button class="btn-small" data-skill-action="' + action + '" data-page="' + (page - 1) + '"' + (page > 0 ? '' : ' disabled') + '>上一页</button>'
      + '<button class="btn-small" data-skill-action="' + action + '" data-page="' + (page + 1) + '"' + (page + 1 < pages ? '' : ' disabled') + '>下一页</button></div></div>';
  }

  function renderSelectionToolbar(kind, count, allLabel) {
    return '<div class="knowledge-batch-toolbar" data-selection-toolbar="' + kind + '">'
      + '<span data-selection-count>已选 ' + count + ' 项</span>'
      + '<button class="btn-small" data-knowledge-action="select-items" data-kind="' + kind + '" title="' + esc(allLabel) + '">全选</button>'
      + '<button class="btn-small" data-knowledge-action="clear-selection" data-kind="' + kind + '" title="清空选择">清空</button>'
      + '<button class="btn-small btn-danger-outline" data-knowledge-action="delete-selected" data-kind="' + kind + '" title="删除所选"' + (count ? '' : ' disabled') + '>删除</button></div>';
  }

  function updateSelectionCount(kind) {
    var toolbar = $('[data-selection-toolbar="' + kind + '"]');
    if (!toolbar) return;
    var count = (kind === 'skill' ? selectedSkills : selectedKnowledge).size;
    toolbar.querySelector('[data-selection-count]').textContent = '已选 ' + count + ' 项';
    toolbar.querySelector('[data-knowledge-action="delete-selected"]').disabled = !count;
  }

  function renderSkillTree(items, kind, state, renderItem) {
    var directories = new Map();
    var tree = { children: new Map(), items: [], depth: -1 };
    items.forEach(function (item) {
      var directory = kind === 'import' ? item.rootDir : item.source && item.source.packageRoot;
      var parts = String(directory || '').replace(/\\/g, '/').split('/').filter(Boolean);
      var parent = tree;
      var path = '';
      var eligible = kind === 'import' || !skillReadonly(item);
      var selected = kind === 'import' ? item.selected !== false : selectedSkills.has(item.id);
      parts.forEach(function (part, depth) {
        path += (path ? '/' : '') + part;
        if (!parent.children.has(part)) {
          var node = { path: path, name: part, depth: depth, children: new Map(), items: [], total: 0, eligible: 0, selected: 0 };
          parent.children.set(part, node);
          directories.set(path, node);
        }
        parent = parent.children.get(part);
        parent.total += 1;
        if (eligible) {
          parent.eligible += 1;
          if (selected) parent.selected += 1;
        }
      });
      parent.items.push(item);
    });
    skillTrees[kind] = directories;
    var rows = [];
    function visit(node) {
      node.children.forEach(function (child) {
        var expanded = treeExpansion[kind].has(child.path) ? treeExpansion[kind].get(child.path) : (child.depth === 0 || !!state.q);
        rows.push({ node: child, expanded: expanded, depth: child.depth });
        if (expanded) visit(child);
      });
      node.items.forEach(function (item) { rows.push({ item: item, depth: node.depth + 1 }); });
    }
    visit(tree);
    state.page = Math.min(state.page || 0, Math.max(0, Math.ceil(rows.length / DEFAULT_PAGE_SIZE) - 1));
    return '<div class="skill-directory-tree">' + rows.slice(state.page * DEFAULT_PAGE_SIZE, (state.page + 1) * DEFAULT_PAGE_SIZE).map(function (row) {
      var indent = ' style="--tree-depth:' + Math.min(12, row.depth) + '"';
      if (row.item) return '<div class="skill-tree-entry"' + indent + '>' + renderItem(row.item) + '</div>';
      var node = row.node;
      return '<div class="skill-tree-folder"' + indent + '>'
        + '<button type="button" class="btn-small" data-skill-action="tree-toggle" data-tree-kind="' + kind + '" data-tree-path="' + esc(node.path) + '" aria-expanded="' + row.expanded + '" aria-label="' + (row.expanded ? '收起 ' : '展开 ') + esc(node.path) + '"></button>'
        + '<input type="checkbox" data-skill-tree-select="' + kind + '" data-tree-path="' + esc(node.path) + '" aria-label="选择目录 ' + esc(node.path) + ' 下的全部可选 Skill"'
        + (node.eligible && node.selected === node.eligible ? ' checked' : '') + (!node.eligible ? ' disabled' : '')
        + (node.selected > 0 && node.selected < node.eligible ? ' data-indeterminate="true"' : '') + '>'
        + '<button type="button" class="skill-tree-folder-name" data-skill-action="tree-toggle" data-tree-kind="' + kind + '" data-tree-path="' + esc(node.path) + '" title="' + esc(node.path) + '">' + esc(node.name) + '</button>'
        + '<span>' + node.total + ' 个 Skill · 已选 ' + node.selected + '</span></div>';
    }).join('') + '</div>' + renderLocalPagination(state.page, rows.length, kind === 'import' ? 'import-page' : 'page')
      + '<div class="form-help">按原目录展示，每页最多 50 个目录或 Skill 节点；目录勾选包含未展开、未显示在本页的子项。搜索时仅选择匹配项。</div>';
  }

  function selectSkillDirectory(kind, path, checked) {
    var node = skillTrees[kind].get(path);
    if (!node) return;
    function select(directory) {
      directory.items.forEach(function (item) {
        if (kind === 'import') item.selected = checked;
        else if (!skillReadonly(item)) {
          if (checked) selectedSkills.add(item.id); else selectedSkills.delete(item.id);
        }
      });
      directory.children.forEach(select);
    }
    select(node);
    renderCurrentState(false, 'skill');
  }

  function ensureClient() {
    if (resourceClient) return resourceClient;
    var api = root.PageAutomationResourceClient;
    if (!api || typeof api.create !== 'function') {
      throw new Error('资源客户端未加载');
    }
    resourceClient = api.create();
    return resourceClient;
  }

  function segment(value) {
    return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function knowledgeUri(id) {
    return id ? '/knowledge/' + segment(id) : '/knowledge';
  }

  function skillUri(id) {
    return id ? '/skills/' + segment(id) : '/skills';
  }

  function mcpServerUri(id) {
    return id ? '/mcp-servers/' + segment(id) : '/mcp-servers';
  }

  function mcpToolsUri(serverId) {
    return mcpServerUri(serverId) + '/tools';
  }

  function mcpToolUri(serverId, toolName) {
    return mcpToolsUri(serverId) + '/' + segment(toolName);
  }

  function mcpCallUri(serverId, toolName) {
    return mcpToolUri(serverId, toolName) + '/calls';
  }

  function envelopeData(envelope, label) {
    var data = envelope && envelope.primary && envelope.primary.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error((label || '资源') + '返回了无效数据');
    }
    return clone(data);
  }

  function makeIdempotencyKey(prefix) {
    idempotencySequence += 1;
    var cryptoObject = root.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return (prefix || 'options') + '_' + cryptoObject.randomUUID();
    }
    return (prefix || 'options') + '_' + Date.now().toString(36) + '_' + idempotencySequence.toString(36)
      + '_' + Math.random().toString(36).slice(2, 10);
  }

  function mutationOptions(extra) {
    return Object.assign({
      idempotencyKey: makeIdempotencyKey('knowledge_panel'),
    }, extra || {});
  }

  function normalizeCursor(value) {
    return Math.max(0, Number(value) || 0);
  }

  function normalizePageSize(value) {
    var size = Number(value) || DEFAULT_PAGE_SIZE;
    return PAGE_SIZE_OPTIONS.indexOf(size) === -1 ? DEFAULT_PAGE_SIZE : size;
  }

  function normalizeCollection(data, options) {
    options = options || {};
    var items = Array.isArray(data && data.items)
      ? data.items
      : (Array.isArray(data && data.matches) ? data.matches : []);
    return {
      items: clone(items),
      total: Math.max(0, Number(data && data.total) || items.length),
      cursor: normalizeCursor(data && data.cursor),
      nextCursor: data && data.nextCursor !== undefined && data.nextCursor !== null
        ? normalizeCursor(data.nextCursor)
        : null,
      limit: normalizePageSize(options.limit || queryState.limit),
    };
  }

  function collectPagedResources(uri, query) {
    var client = ensureClient();
    var items = [];
    var total = 0;
    var seenCursors = Object.create(null);

    function read(cursor) {
      var nextQuery = Object.assign({}, query || {});
      if (cursor) nextQuery.cursor = cursor;
      return client.get(uri, { query: nextQuery }).then(function (envelope) {
        var data = envelopeData(envelope, uri);
        var pageItems = Array.isArray(data.items) ? data.items : [];
        items = items.concat(pageItems.map(clone));
        total = Math.max(total, Number(data.total) || 0, items.length);
        var nextCursor = data.nextCursor === undefined || data.nextCursor === null ? '' : String(data.nextCursor);
        if (!nextCursor || seenCursors[nextCursor]) return { items: items, total: total };
        seenCursors[nextCursor] = true;
        return read(nextCursor);
      });
    }

    return read('');
  }

  function currentKnowledgeQuery() {
    var search = $('#knowledge-search');
    var type = $('#knowledge-filter-type');
    var source = $('#knowledge-filter-source');
    var archived = $('#knowledge-include-archived');
    var stale = $('#knowledge-include-stale');
    if (search) queryState.q = search.value.trim();
    if (type) queryState.type = type.value;
    if (source) queryState.sourceKind = source.value;
    if (archived) queryState.includeArchived = archived.checked;
    if (stale) queryState.includeStale = stale.checked;
    var query = {
      cursor: String(normalizeCursor(queryState.cursor)),
      limit: normalizePageSize(queryState.limit),
      includeArchived: queryState.includeArchived,
      includeStale: queryState.includeStale,
      contextChars: 180,
    };
    if (queryState.q) {
      query.q = queryState.q;
      query.mode = 'relevance';
    }
    if (queryState.type) query.type = queryState.type;
    if (queryState.sourceKind) query.sourceKind = queryState.sourceKind;
    return query;
  }

  function loadKnowledgePage() {
    var sequence = ++knowledgeLoadSequence;
    var query = currentKnowledgeQuery();
    return ensureClient().get('/knowledge', { query: query }).then(function (envelope) {
      if (sequence !== knowledgeLoadSequence) return;
      viewState.knowledgePage = normalizeCollection(envelopeData(envelope, '知识列表'), { limit: query.limit });
      delete viewState.errors.knowledge;
    }, function (error) {
      if (sequence !== knowledgeLoadSequence) return;
      viewState.knowledgePage = { items: [], total: 0, cursor: 0, nextCursor: null, limit: query.limit };
      viewState.errors.knowledge = errorText(error, '知识列表读取失败');
    });
  }

  function loadKnowledgeSettings() {
    return ensureClient().get('/knowledge-settings').then(function (envelope) {
      viewState.settings = envelopeData(envelope, '知识设置');
      delete viewState.errors.settings;
    }, function (error) {
      viewState.settings = null;
      viewState.errors.settings = errorText(error, '知识设置读取失败');
    });
  }

  function loadSkills() {
    var sequence = ++skillLoadSequence;
    return collectPagedResources('/skills', {
      limit: 100,
      includeArchived: true,
      includeDisabled: true,
    }).then(function (result) {
      if (sequence !== skillLoadSequence) return;
      viewState.skills = result.items.sort(function (left, right) {
        if (isBuiltinSkill(left) !== isBuiltinSkill(right)) return isBuiltinSkill(left) ? -1 : 1;
        return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      });
      viewState.skillTotal = result.total;
      var available = new Set(result.items.filter(function (item) { return !skillReadonly(item); }).map(function (item) { return item.id; }));
      selectedSkills.forEach(function (id) { if (!available.has(id)) selectedSkills.delete(id); });
      delete viewState.errors.skills;
    }, function (error) {
      if (sequence !== skillLoadSequence) return;
      viewState.skills = [];
      viewState.skillTotal = 0;
      viewState.errors.skills = errorText(error, 'Skill 列表读取失败');
    });
  }

  function loadMcpServers() {
    return collectPagedResources('/mcp-servers', { limit: 100, includeDisabled: true }).then(function (result) {
      viewState.mcpServers = result.items;
      viewState.mcpServerTotal = result.total;
      delete viewState.errors.mcp;
    }, function (error) {
      viewState.mcpServers = [];
      viewState.mcpServerTotal = 0;
      viewState.errors.mcp = errorText(error, 'HTTP MCP 服务器读取失败');
    });
  }

  function loadMcpTools(serverId) {
    return collectPagedResources(mcpToolsUri(serverId), { limit: 100 }).then(function (result) {
      viewState.toolsByServer[serverId] = { items: result.items, total: result.total };
      delete viewState.errors['tools:' + serverId];
      return result;
    }, function (error) {
      delete viewState.toolsByServer[serverId];
      viewState.errors['tools:' + serverId] = errorText(error, '工具目录读取失败');
      throw error;
    });
  }

  function loadAll() {
    return Promise.all([
      loadKnowledgePage(),
      loadKnowledgeSettings(),
      loadSkills(),
      loadMcpServers(),
    ]);
  }

  function fmtTime(timestamp) {
    if (!timestamp) return '—';
    var date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  function splitTags(value) {
    if (Array.isArray(value)) return value.map(String).map(function (item) { return item.trim(); }).filter(Boolean);
    return String(value || '').split(/[\n,，;；#]+/).map(function (item) { return item.trim(); }).filter(Boolean);
  }

  function renderTypeOptions(selected, includeAll) {
    var html = includeAll ? '<option value="">全部类型</option>' : '';
    Object.keys(TYPE_LABELS).forEach(function (type) {
      html += '<option value="' + esc(type) + '"' + (type === selected ? ' selected' : '') + '>' + esc(TYPE_LABELS[type]) + '</option>';
    });
    return html;
  }

  function renderSourceOptions(selected) {
    var html = '<option value="">全部来源</option>';
    Object.keys(SOURCE_LABELS).forEach(function (kind) {
      html += '<option value="' + esc(kind) + '"' + (kind === selected ? ' selected' : '') + '>' + esc(SOURCE_LABELS[kind]) + '</option>';
    });
    return html;
  }

  function renderError(message) {
    return message ? '<div class="readonly-banner">' + esc(message) + '</div>' : '';
  }

  function renderStats() {
    var toolTotal = viewState.mcpServers.reduce(function (total, server) {
      return total + Math.max(0, Number(server && server.toolCount) || 0);
    }, 0);
    return '<div class="knowledge-stats">'
      + '<div><b>' + esc(viewState.knowledgePage.total) + '</b><span>知识</span></div>'
      + '<div><b>' + esc(viewState.skillTotal) + '</b><span>Skill</span></div>'
      + '<div><b>' + esc(viewState.mcpServerTotal) + '</b><span>MCP 服务器</span></div>'
      + '<div><b>' + esc(toolTotal) + '</b><span>外部工具</span></div>'
      + '</div>';
  }

  function renderSettings() {
    var settings = viewState.settings;
    if (!settings) return renderError(viewState.errors.settings);
    return '<div class="knowledge-settings">'
      + '<label class="switch-label"><input type="checkbox" id="knowledge-enabled"' + (settings.enabled !== false ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">启用知识</span></label>'
      + '<label class="switch-label"><input type="checkbox" id="knowledge-auto-capture"' + (settings.autoCapture !== false ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">保存可复用经验</span></label>'
      + '</div>';
  }

  function renderToolbar() {
    return '<div class="knowledge-toolbar">'
      + '<input type="search" id="knowledge-search" placeholder="搜索知识" value="' + esc(queryState.q) + '">'
      + '<select id="knowledge-filter-type">' + renderTypeOptions(queryState.type, true) + '</select>'
      + '<select id="knowledge-filter-source">' + renderSourceOptions(queryState.sourceKind) + '</select>'
      + '<label class="switch-label"><input type="checkbox" id="knowledge-include-archived"' + (queryState.includeArchived ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">包含归档</span></label>'
      + '<label class="switch-label"><input type="checkbox" id="knowledge-include-stale"' + (queryState.includeStale ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">包含陈旧和拒绝项</span></label>'
      + '</div>';
  }

  function renderPageSizeOptions(selected) {
    return PAGE_SIZE_OPTIONS.map(function (size) {
      return '<option value="' + size + '"' + (size === selected ? ' selected' : '') + '>' + size + ' 条/页</option>';
    }).join('');
  }

  function renderPagination() {
    var page = viewState.knowledgePage;
    var total = page.total;
    var limit = page.limit;
    var cursor = page.cursor;
    var pageCount = Math.max(1, Math.ceil(total / limit));
    var current = Math.min(pageCount, Math.floor(cursor / limit) + 1);
    var start = total ? cursor + 1 : 0;
    var end = Math.min(total, cursor + page.items.length);
    var hasNext = page.nextCursor !== null && page.nextCursor < total;
    return '<div class="knowledge-pagination">'
      + '<div class="knowledge-pagination-status">第 ' + esc(current) + ' / ' + esc(pageCount) + ' 页 · ' + esc(start) + '-' + esc(end) + ' / ' + esc(total) + '</div>'
      + '<div class="knowledge-pagination-controls">'
      + '<select data-knowledge-page-size>' + renderPageSizeOptions(limit) + '</select>'
      + '<button class="btn-small" data-knowledge-action="page-prev" data-cursor="' + esc(Math.max(0, cursor - limit)) + '"' + (cursor > 0 ? '' : ' disabled') + '>上一页</button>'
      + '<button class="btn-small" data-knowledge-action="page-next" data-cursor="' + esc(hasNext ? page.nextCursor : cursor) + '"' + (hasNext ? '' : ' disabled') + '>下一页</button>'
      + '</div></div>';
  }

  function knowledgeReadonly(item) {
    var source = item && item.source || {};
    var kind = item && (item.sourceKind || source.kind) || '';
    return !!(item && (item.protected || item.builtIn || kind === 'builtin' || kind === 'mcp' || kind === 'skill'));
  }

  function renderKnowledgeItem(item) {
    item = item || {};
    var source = item.source || {};
    var sourceKind = item.sourceKind || source.kind || 'auto';
    var readonly = knowledgeReadonly(item);
    var badges = '<span class="badge">' + esc(item.typeLabel || TYPE_LABELS[item.type] || item.type || '知识') + '</span>'
      + '<span class="badge">' + esc(item.sourceLabel || SOURCE_LABELS[sourceKind] || sourceKind) + '</span>';
    if (item.pinned) badges += '<span class="badge on">置顶</span>';
    if (item.archived) badges += '<span class="badge">归档</span>';
    if (item.verificationState) {
      var danger = item.verificationState === 'stale' || item.verificationState === 'rejected';
      badges += '<span class="badge' + (item.verificationState === 'verified' ? ' on' : (danger ? ' danger' : '')) + '">' + esc(item.verificationState) + '</span>';
    }
    return '<div class="item-card knowledge-card' + (knowledgeDraft && knowledgeDraft.id === item.id ? ' selected' : '') + '">'
      + (!readonly ? '<input type="checkbox" data-knowledge-select="' + esc(item.id) + '" aria-label="选择 ' + esc(item.title || item.id) + '"' + (selectedKnowledge.has(item.id) ? ' checked' : '') + '>' : '')
      + '<div class="knowledge-card-main" data-knowledge-action="edit" data-id="' + esc(item.id) + '">'
      + '<span class="item-title">' + esc(item.title || '未命名知识') + '</span>'
      + '<span class="item-sub">' + esc(item.summary || item.snippet || '') + '</span>'
      + '<span class="knowledge-meta">使用 ' + esc(item.useCount || 0) + ' 次 · 更新 ' + esc(fmtTime(item.updatedAt)) + '</span>'
      + '</div>' + badges
      + '<button class="btn-small" data-knowledge-action="edit" data-id="' + esc(item.id) + '">' + (readonly ? '查看' : '编辑') + '</button>'
      + '<button class="btn-small btn-danger-outline" data-knowledge-action="delete" data-id="' + esc(item.id) + '"' + (readonly ? ' disabled' : '') + '>删除</button>'
      + '</div>';
  }

  function captureKnowledgeDraft() {
    if (!knowledgeDraft || !$('#knowledge-title')) return;
    knowledgeDraft.title = $('#knowledge-title').value;
    knowledgeDraft.type = $('#knowledge-type').value;
    knowledgeDraft.summary = $('#knowledge-summary').value;
    knowledgeDraft.content = $('#knowledge-content').value;
    knowledgeDraft.tags = splitTags($('#knowledge-tags').value);
    knowledgeDraft.pinned = $('#knowledge-pinned').checked;
    knowledgeDraft.archived = $('#knowledge-archived').checked;
  }

  function renderKnowledgeEditor() {
    if (!knowledgeDraft) return '';
    var item = knowledgeDraft;
    var source = item.source || {};
    var readonly = knowledgeReadonly(item);
    return '<div class="editor knowledge-editor" tabindex="-1">'
      + '<h3>' + esc(item.id ? (readonly ? '查看知识' : '编辑知识') : '新建知识') + '</h3>'
      + (readonly ? '<div class="readonly-banner">这项知识由扩展或外部能力维护，可在这里查看。</div>' : '')
      + '<div class="form-grid">'
      + '<div class="form-row"><label>标题</label><input type="text" id="knowledge-title" value="' + esc(item.title || '') + '"' + (readonly ? ' disabled' : '') + '></div>'
      + '<div class="form-row"><label>类型</label><select id="knowledge-type"' + (readonly ? ' disabled' : '') + '>' + renderTypeOptions(item.type || 'custom', false) + '</select></div>'
      + '</div>'
      + '<div class="form-row"><label>摘要</label><textarea id="knowledge-summary" rows="3"' + (readonly ? ' disabled' : '') + '>' + esc(item.summary || '') + '</textarea></div>'
      + '<div class="form-row"><label>内容</label><textarea id="knowledge-content" rows="12"' + (readonly ? ' disabled' : '') + '>' + esc(item.content || '') + '</textarea></div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>标签</label><input type="text" id="knowledge-tags" value="' + esc((item.tags || []).join(', ')) + '"' + (readonly ? ' disabled' : '') + '></div>'
      + '<div class="form-row"><label>来源</label><input type="text" value="' + esc(SOURCE_LABELS[item.sourceKind || source.kind] || item.sourceKind || source.kind || '维护知识') + '" disabled></div>'
      + '</div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>来源标识</label><input type="text" value="' + esc(source.key || '') + '" disabled></div>'
      + '<div class="form-row"><label>来源地址</label><input type="text" value="' + esc(source.uri || '') + '" disabled></div>'
      + '</div>'
      + '<div class="knowledge-editor-checks">'
      + '<label class="switch-label"><input type="checkbox" id="knowledge-pinned"' + (item.pinned ? ' checked' : '') + (readonly ? ' disabled' : '') + '><span class="switch-slider"></span><span class="switch-text">置顶</span></label>'
      + '<label class="switch-label"><input type="checkbox" id="knowledge-archived"' + (item.archived ? ' checked' : '') + (readonly ? ' disabled' : '') + '><span class="switch-slider"></span><span class="switch-text">归档</span></label>'
      + '</div>'
      + '<div class="editor-actions">'
      + (readonly ? '' : '<button class="btn-primary" data-knowledge-action="save">保存知识</button>')
      + '<button class="btn-secondary" data-knowledge-action="cancel">取消</button>'
      + (item.id && !readonly ? '<span class="spacer"></span><button class="btn-danger" data-knowledge-action="delete" data-id="' + esc(item.id) + '">删除</button>' : '')
      + '</div></div>';
  }

  function renderKnowledgeSection() {
    var items = viewState.knowledgePage.items;
    return '<div class="knowledge-domain-section">'
      + '<div class="knowledge-mcp-head"><div><h3>知识库</h3><p>维护对话可检索的事实、步骤和经验。内置知识与外部来源保持只读。</p></div></div>'
      + renderError(viewState.errors.knowledge)
      + renderToolbar() + renderSettings() + renderStats() + renderPagination()
      + renderSelectionToolbar('knowledge', selectedKnowledge.size, '全选本页可删除项')
      + '<div class="item-list knowledge-list">'
      + (items.length ? items.map(renderKnowledgeItem).join('') : '<div class="placeholder">没有匹配的知识。</div>')
      + '</div>' + renderPagination()
      + '<div id="knowledge-editor-wrap">' + renderKnowledgeEditor() + '</div>'
      + '</div>';
  }

  function isBuiltinSkill(item) {
    var source = item && item.source || {};
    return !!(item && (item.builtinSkill || item.builtIn || item.protected
      || source.kind === 'builtin' || source.managed === 'builtin' || source.importer === 'builtin-skill-loader'));
  }

  function skillReadonly(item) { return isBuiltinSkill(item) || !!(item && item.managedSkill); }

  function renderSkillCard(item) {
    var builtin = isBuiltinSkill(item);
    var readonly = skillReadonly(item);
    return '<div class="item-card knowledge-skill-card">'
      + (!readonly ? '<input type="checkbox" data-skill-select="' + esc(item.id) + '" aria-label="选择 ' + esc(item.name || item.id) + '"' + (selectedSkills.has(item.id) ? ' checked' : '') + '>' : '')
      + '<div class="knowledge-card-main" data-skill-action="edit" data-id="' + esc(item.id) + '">'
      + '<span class="item-title">' + esc(item.name || item.id || 'Skill') + '</span>'
      + '<span class="item-sub">' + esc(item.description || '') + '</span>'
      + (item.source && item.source.packageRoot ? '<span class="knowledge-meta">目录：' + esc(item.source.packageRoot) + '</span>' : '')
      + '<span class="knowledge-meta">资源 ' + esc(item.resourceCount || (item.resources || []).length) + ' 个 · 更新 ' + esc(fmtTime(item.updatedAt)) + '</span>'
      + '</div>'
      + (builtin ? '<span class="badge builtin">内置</span>' : '<span class="badge">用户</span>')
      + (item.enabled === false ? '<span class="badge">停用</span>' : '')
      + (item.archived ? '<span class="badge">归档</span>' : '')
      + '<button class="btn-small" data-skill-action="edit" data-id="' + esc(item.id) + '">查看</button>'
      + (!item.archived && !readonly ? '<button class="btn-small btn-danger-outline" data-skill-action="archive" data-id="' + esc(item.id) + '">归档</button>' : '')
      + (!readonly ? '<button class="btn-small btn-danger-outline" data-skill-action="delete" data-id="' + esc(item.id) + '">删除</button>' : '')
      + '</div>';
  }

  function captureSkillDraft() {
    if (!skillDraft || !$('#skill-edit-name')) return;
    if (!$('#skill-edit-name').disabled) skillDraft.name = $('#skill-edit-name').value;
    if (!$('#skill-edit-description').disabled) skillDraft.description = $('#skill-edit-description').value;
    if (!$('#skill-edit-instructions').disabled) skillDraft.instructions = $('#skill-edit-instructions').value;
    if (!$('#skill-edit-version').disabled) skillDraft.version = $('#skill-edit-version').value;
    if (!$('#skill-edit-tags').disabled) skillDraft.tags = splitTags($('#skill-edit-tags').value);
    skillDraft.enabled = $('#skill-edit-enabled').checked;
    skillDraft.archived = $('#skill-edit-archived').checked;
  }

  function renderSkillResources(item) {
    var resources = item.resources || [];
    return '<div class="form-row"><label>附带资源（' + resources.length + ' 个，不含 SKILL.md）</label>'
      + (resources.length ? '<div class="skill-resource-list">' + resources.map(function (resource, index) {
        var metadataOnly = resource.textStored === false;
        return '<details><summary' + (metadataOnly ? '' : ' data-skill-action="view-resource" data-resource-index="' + index + '"') + '>'
          + '<span class="skill-resource-path">' + esc(resource.path || resource.name || resource.id) + '</span>'
          + (metadataOnly ? '<span class="skill-import-file-size">仅保存文件信息</span>' : '')
          + '</summary><pre class="mcp-snippet">' + (metadataOnly ? '此文件未保存原始内容，无法预览；agent 也只能读取文件信息。' : '展开后读取文本内容。')
          + '</pre></details>';
      }).join('') + '</div>' : '<div class="form-help">没有附带资源。</div>')
      + '</div>';
  }

  function renderSkillEditor() {
    if (!skillDraft) return '';
    var item = skillDraft;
    var builtin = skillReadonly(item);
    return '<div class="editor knowledge-skill-editor">'
      + '<h3>' + esc(item.name || 'Skill') + '</h3>'
      + (builtin ? '<div class="readonly-banner">此 Skill 由扩展维护，只读。</div>' : '')
      + (item.source && item.source.packageRoot ? '<div class="form-help">目录：' + esc(item.source.packageRoot) + '</div>' : '')
      + '<div class="form-grid">'
      + '<div class="form-row"><label>名称</label><input type="text" id="skill-edit-name" value="' + esc(item.name || '') + '"' + (builtin ? ' disabled' : '') + '></div>'
      + '<div class="form-row"><label>版本</label><input type="text" id="skill-edit-version" value="' + esc(item.version || '1') + '"' + (builtin ? ' disabled' : '') + '></div>'
      + '</div>'
      + '<div class="form-row"><label>说明</label><textarea id="skill-edit-description" rows="3"' + (builtin ? ' disabled' : '') + '>' + esc(item.description || '') + '</textarea></div>'
      + '<div class="form-row"><label>指令（SKILL.md 正文）</label><textarea id="skill-edit-instructions" rows="14"' + (builtin ? ' disabled' : '') + '>' + esc(item.instructions || '') + '</textarea></div>'
      + renderSkillResources(item)
      + '<div class="form-row"><label>标签</label><input type="text" id="skill-edit-tags" value="' + esc((item.tags || []).join(', ')) + '"' + (builtin ? ' disabled' : '') + '></div>'
      + '<div class="knowledge-editor-checks">'
      + '<label class="switch-label"><input type="checkbox" id="skill-edit-enabled"' + (item.enabled !== false ? ' checked' : '') + (builtin ? ' disabled' : '') + '><span class="switch-slider"></span><span class="switch-text">启用</span></label>'
      + '<label class="switch-label"><input type="checkbox" id="skill-edit-archived"' + (item.archived ? ' checked' : '') + (builtin ? ' disabled' : '') + '><span class="switch-slider"></span><span class="switch-text">归档</span></label>'
      + '<span>资源 ' + esc((item.resources || []).length) + ' 个</span>'
      + '</div>'
      + '<div class="editor-actions">'
      + (!builtin ? '<button class="btn-primary" data-skill-action="save" data-id="' + esc(item.id) + '">保存 Skill</button>' : '')
      + '<button class="btn-secondary" data-skill-action="cancel-edit">取消</button>'
      + '<span class="spacer"></span>'
      + (!builtin ? '<button class="btn-danger" data-skill-action="delete" data-id="' + esc(item.id) + '">删除</button>' : '')
      + '</div></div>';
  }

  function normalizeSkillFilePath(file) {
    return String(file && (file.webkitRelativePath || file.name) || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function pathDirectory(path) {
    var index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  function isSkillMarkdown(path) {
    return /(^|\/)skill\.md$/i.test(String(path || ''));
  }

  function isIgnoredImportPath(path) {
    return /(^|\/)(?:\.git|\.hg|\.svn|node_modules|__pycache__)(?:\/|$)/i.test(path)
      || /(^|\/)\.ds_store$/i.test(path);
  }

  async function detectSkillPackages(files, task) {
    var entries = [];
    var paths = [];
    var packagesByRoot = new Map();
    for (var index = 0; index < files.length; index += 1) {
      if (index % 250 === 0) {
        task.done = index;
        task.detail = '查找 SKILL.md';
        updateTaskStatus();
        await yieldToPage();
        checkTaskCancelled(task);
      }
      var file = files[index];
      var path = normalizeSkillFilePath(file);
      if (!path || isIgnoredImportPath(path)) continue;
      paths.push({ file: file, path: path });
      if (!isSkillMarkdown(path)) continue;
      var directory = pathDirectory(path);
      if (packagesByRoot.has(directory)) continue;
      var entry = { id: path, path: path, rootDir: directory, file: file, selected: true, files: [] };
      packagesByRoot.set(directory, entry);
      entries.push(entry);
    }
    // Each file belongs to its nearest ancestor containing SKILL.md.
    var owners = new Map();
    for (var position = 0; position < paths.length; position += 1) {
      if (position % 250 === 0) {
        task.done = files.length + position;
        task.detail = '分配资源文件 · 已发现 ' + entries.length + ' 个 Skill';
        updateTaskStatus();
        await yieldToPage();
        checkTaskCancelled(task);
      }
      var fileEntry = paths[position];
      var parent = pathDirectory(fileEntry.path);
      var visited = [];
      while (!packagesByRoot.has(parent) && !owners.has(parent) && parent) {
        visited.push(parent);
        parent = pathDirectory(parent);
      }
      var owner = packagesByRoot.get(parent) || owners.get(parent) || null;
      visited.forEach(function (dir) { owners.set(dir, owner); });
      if (owner) owner.files.push(fileEntry.file);
    }
    task.done = task.total;
    task.succeeded = files.length;
    return entries;
  }

  function isLikelyTextFile(file) {
    var path = normalizeSkillFilePath(file).toLowerCase();
    var type = String(file && file.type || '').toLowerCase();
    if (/^text\//.test(type) || /(?:json|xml|yaml|toml|javascript)$/.test(type)) return true;
    return /\.(?:md|markdown|txt|json|ya?ml|toml|ini|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|fish|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|css|scss|less|html?|xml|sql|graphql|proto|env)$/i.test(path)
      || /(^|\/)(?:dockerfile|makefile|license|notice)$/i.test(path);
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('文件读取失败')); };
      reader.readAsText(file);
    });
  }

  function unquote(value) {
    value = String(value || '').trim();
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"')
        || (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    return value;
  }

  function parseFrontmatter(markdown) {
    markdown = String(markdown || '').replace(/^\uFEFF/, '');
    var match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(markdown);
    if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter');
    var lines = match[1].split(/\r?\n/);
    var metadata = {};
    for (var index = 0; index < lines.length; index += 1) {
      var lineMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index]);
      if (!lineMatch) continue;
      var key = lineMatch[1];
      var value = lineMatch[2];
      if (value === '|' || value === '>') {
        var chunks = [];
        while (index + 1 < lines.length && (/^\s+/.test(lines[index + 1]) || !lines[index + 1].trim())) {
          index += 1;
          chunks.push(lines[index].replace(/^\s{1,4}/, ''));
        }
        value = chunks.join(value === '>' ? ' ' : '\n').trim();
      }
      metadata[key] = unquote(value);
    }
    return { metadata: metadata, body: markdown.slice(match[0].length).trim(), markdown: markdown };
  }

  function parseFrontmatterTags(value) {
    value = String(value || '').trim().replace(/^\[/, '').replace(/\]$/, '');
    return splitTags(value).map(unquote);
  }

  function relativeSkillPath(path, rootDir) {
    if (!rootDir) return path;
    return path.indexOf(rootDir + '/') === 0 ? path.slice(rootDir.length + 1) : path;
  }

  function skillResourceKind(path) {
    path = String(path || '').toLowerCase();
    if (/^references\//.test(path)) return 'reference';
    if (/^scripts\//.test(path)) return 'script';
    if (/^assets\//.test(path)) return 'asset';
    if (/^agents\//.test(path)) return 'agent';
    return 'resource';
  }

  function readSkillPackage(skillPackage, sourceUri, task) {
    var entryFile = skillPackage.file;
    if (!entryFile) return Promise.reject(new Error('Skill 包缺少 SKILL.md'));
    if (entryFile.size > 2000000) return Promise.reject(new Error('SKILL.md 超过 2 MB'));
    if (skillPackage.files.length > 1001) return Promise.reject(new Error('Skill 资源超过 1000 个'));
    var textBytes = skillPackage.files.reduce(function (total, file) { return total + (isLikelyTextFile(file) ? file.size : 0); }, 0);
    if (textBytes > 16 * 1024 * 1024) return Promise.reject(new Error('Skill 文本资源合计超过 16 MiB，请精简后重试'));
    return readFileText(entryFile).then(function (markdown) {
      var parsed = parseFrontmatter(markdown);
      var name = String(parsed.metadata.name || '').trim();
      var description = String(parsed.metadata.description || '').trim();
      if (!name || !description) throw new Error('SKILL.md frontmatter 必须包含 name 和 description');
      if (!parsed.body) throw new Error('SKILL.md 必须包含指令正文');
      if (parsed.body.length > 500000) throw new Error('Skill 指令超过 500000 字符');
      var resources = [];
      var chain = Promise.resolve();
      skillPackage.files.forEach(function (file) {
        var fullPath = normalizeSkillFilePath(file);
        if (fullPath === skillPackage.path) return;
        chain = chain.then(function () {
          checkTaskCancelled(task);
          var path = relativeSkillPath(fullPath, skillPackage.rootDir);
          var resource = {
            path: path,
            kind: skillResourceKind(path),
            mediaType: String(file.type || ''),
            size: Math.max(0, Number(file.size) || 0),
            textStored: false,
          };
          if (!isLikelyTextFile(file)) {
            resources.push(resource);
            return null;
          }
          return readFileText(file).then(function (text) {
            resource.text = text;
            resource.textStored = true;
            resources.push(resource);
          });
        });
      });
      return chain.then(function () {
        if (resources.length > 1000) throw new Error('Skill 资源超过 1000 个');
        return {
          name: name,
          description: description,
          instructions: parsed.body,
          version: String(parsed.metadata.version || '1'),
          source: {
            kind: 'skill',
            uri: String(sourceUri || '').trim(),
            entryPath: skillPackage.path,
            packageRoot: skillPackage.rootDir,
            importer: 'options-skill-import',
          },
          resources: resources,
          tags: parseFrontmatterTags(parsed.metadata.tags || ''),
          enabled: true,
          archived: false,
        };
      });
    });
  }

  function captureSkillImportDraft() {
    if (!skillImportDraft) return;
    var source = $('#skill-import-source-uri');
    var markdown = $('#skill-import-markdown');
    if (source) skillImportDraft.sourceUri = source.value;
    if (markdown) skillImportDraft.markdown = markdown.value;
  }

  function renderSkillImportEditor() {
    if (!skillImportDraft) { skillTrees.import.clear(); return ''; }
    var packages = skillImportDraft.packages || [];
    var query = String(skillImportDraft.q || '').trim().toLowerCase();
    var filtered = packages.filter(function (pkg) { return !query || pkg.path.toLowerCase().indexOf(query) !== -1; });
    var packageHtml = renderSkillTree(filtered, 'import', skillImportDraft, function (pkg) {
      return '<div class="skill-import-package"><label class="skill-import-file-row">'
        + '<input type="checkbox" data-skill-package-select="' + esc(pkg.id) + '"' + (pkg.selected !== false ? ' checked' : '') + '>'
        + '<span class="skill-import-file-path" title="' + esc(pkg.path) + '">SKILL.md</span>'
        + '<span class="skill-import-file-size">' + esc(pkg.files.length) + ' 个文件（含 SKILL.md）</span>'
        + (pkg.error ? '<span class="skill-import-error">' + esc(pkg.error) + '</span>' : '')
        + '</label><details class="skill-import-files"><summary>查看文件清单</summary>'
        + '<ul class="skill-import-file-list">' + pkg.files.map(function (file) {
          var fullPath = normalizeSkillFilePath(file);
          var path = relativeSkillPath(fullPath, pkg.rootDir);
          var kind = fullPath === pkg.path ? '入口文件' : (isLikelyTextFile(file) ? '文本资源' : '仅记录文件信息');
          return '<li class="skill-import-resource-row">'
            + '<span class="skill-import-file-path" title="' + esc(path) + '">' + esc(path) + '</span>'
            + '<span class="skill-import-file-size">' + kind + '</span></li>';
        }).join('') + '</ul></details></div>';
    });
    return '<div class="editor knowledge-skill-editor">'
      + '<h3>导入 Skill</h3>'
      + '<div class="readonly-banner">选择包含 SKILL.md 的 Skill 包。指令和文本资源会作为本地 Skill 内容保存，脚本与资源文件不会在导入时执行。</div>'
      + '<div class="form-help">单个 SKILL.md 最大 2 MB；每个 Skill 最多 1000 个资源，文本合计最大 16 MiB。超限项会单独报告。</div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>选择 Skill 文件夹</label><input type="file" id="skill-import-directory" webkitdirectory multiple></div>'
      + '<div class="form-row"><label>选择 SKILL.md 和资源</label><input type="file" id="skill-import-files" multiple></div>'
      + '</div>'
      + (packages.length ? '<input type="search" id="skill-import-search" aria-label="搜索待导入目录路径（不含 Skill 内容）" placeholder="搜索待导入目录路径（不含 Skill 内容）" title="仅匹配待导入 SKILL.md 的文件路径，不搜索文件内的名称、说明或正文" value="' + esc(skillImportDraft.q || '') + '">'
        + '<div class="knowledge-batch-toolbar"><span id="skill-import-selected-count">已选 ' + packages.filter(function (pkg) { return pkg.selected !== false; }).length + ' / ' + packages.length + ' 个 Skill</span>'
        + '<button class="btn-small" data-skill-action="import-select-all" title="全选搜索结果">全选</button><button class="btn-small" data-skill-action="import-clear" title="清空选择">清空</button></div>'
        + '<div class="skill-import-drawer-list">' + packageHtml + '</div>' : '')
      + '<div class="form-row"><label>来源地址</label><input type="text" id="skill-import-source-uri" value="' + esc(skillImportDraft.sourceUri || '') + '" placeholder="可选"></div>'
      + '<div class="form-row"><label>或粘贴 SKILL.md</label><textarea id="skill-import-markdown" rows="12" placeholder="---&#10;name: example&#10;description: ...&#10;---&#10;&#10;# Instructions">' + esc(skillImportDraft.markdown || '') + '</textarea></div>'
      + '<div class="editor-actions"><button class="btn-primary" data-skill-action="import">导入 Skill</button><button class="btn-secondary" data-skill-action="cancel-import">取消</button></div>'
      + '</div>';
  }

  function filteredSkills() {
    var query = skillFilter.q.trim().toLowerCase();
    return viewState.skills.filter(function (item) {
      return !query || [item.name, item.description, item.id, item.source && item.source.packageRoot, (item.tags || []).join(' ')].join(' ').toLowerCase().indexOf(query) !== -1;
    });
  }

  function renderSkillSection() {
    var skills = filteredSkills();
    if (!skills.length) skillTrees.skill.clear();
    return '<div class="knowledge-skill-section">'
      + '<div class="knowledge-mcp-head"><div><h3>Skill</h3><p>Skill 把可复用指令和参考资源组织成一个可管理的能力包。</p></div><button class="btn-secondary" data-skill-action="new-import">导入 Skill</button></div>'
      + renderError(viewState.errors.skills)
      + '<input type="search" id="skill-search" aria-label="搜索 Skill" placeholder="搜索 Skill 名称、说明、标签或目录" value="' + esc(skillFilter.q) + '">'
      + renderSelectionToolbar('skill', selectedSkills.size, '全选搜索结果中可删除项')
      + '<div class="item-list knowledge-skill-list">'
      + (skills.length ? renderSkillTree(skills, 'skill', skillFilter, renderSkillCard) : '<div class="placeholder">没有匹配的 Skill。可以导入 Skill 或修改搜索条件。</div>')
      + '</div>'
      + '<div id="skill-import-editor-wrap">' + renderSkillImportEditor() + '</div>'
      + '<div id="skill-editor-wrap">' + renderSkillEditor() + '</div>'
      + '</div>';
  }

  function operationKey(kind, target) {
    return kind + ':' + String(target || '');
  }

  function renderOperation(operation) {
    if (!operation || !operation.data) return '';
    var data = operation.data;
    var status = String(data.status || '');
    var badgeClass = status === 'succeeded' ? ' on' : ((status === 'failed' || status === 'interrupted') ? ' danger' : '');
    var details = '';
    if (status === 'succeeded' && data.result !== undefined) {
      if (data.kind === 'mcp-server-connection-attempt') {
        details = data.result && data.result.connected
          ? ' · 已连接，工具 ' + esc(data.result.toolCount || 0) + ' 个'
          : ' · 请求已完成，服务器未建立连接';
      } else if (data.kind === 'mcp-tool-discovery') {
        details = ' · 更新 ' + esc(data.result && data.result.synced || 0) + ' 个，归档 ' + esc(data.result && data.result.archived || 0) + ' 个';
      }
    }
    if ((status === 'failed' || status === 'interrupted') && data.error) details = ' · ' + esc(data.error);
    if (operation.pollError) details += ' · 状态读取失败：' + esc(operation.pollError);
    var result = data.kind === 'mcp-call' && status === 'succeeded'
      ? '<pre class="mcp-snippet">' + esc(JSON.stringify(data.result, null, 2)) + '</pre>'
      : '';
    return '<div class="knowledge-operation-status"><span class="badge' + badgeClass + '">' + esc(OPERATION_LABELS[status] || status) + '</span>'
      + '<span class="knowledge-meta">' + esc(OPERATION_KIND_LABELS[data.kind] || '操作') + details + '</span>' + result + '</div>';
  }

  function renderOperationSlot(key) {
    return '<div class="knowledge-operation" data-operation-key="' + esc(key) + '">' + renderOperation(operations[key]) + '</div>';
  }

  function refreshOperationViews() {
    var elements = document.querySelectorAll('[data-operation-key]');
    Array.prototype.forEach.call(elements, function (element) {
      var key = element.getAttribute('data-operation-key') || '';
      element.innerHTML = renderOperation(operations[key]);
    });
  }

  function operationDataFromEnvelope(envelope, label) {
    var data = envelopeData(envelope, label || '异步操作');
    if (!OPERATION_LABELS[data.status]) throw new Error('异步操作返回了无效状态');
    return data;
  }

  function clearOperationTimer(key) {
    if (operationTimers[key]) root.clearTimeout(operationTimers[key]);
    delete operationTimers[key];
  }

  function pollOperation(key, delayMs) {
    var tracked = operations[key];
    if (!tracked || !tracked.uri || TERMINAL_OPERATION_STATES[tracked.data && tracked.data.status]) return;
    clearOperationTimer(key);
    operationTimers[key] = root.setTimeout(function () {
      ensureClient().get(tracked.uri).then(function (envelope) {
        tracked.data = operationDataFromEnvelope(envelope);
        tracked.pollError = '';
        tracked.pollFailures = 0;
        refreshOperationViews();
        if (TERMINAL_OPERATION_STATES[tracked.data.status]) {
          clearOperationTimer(key);
          if (typeof tracked.onTerminal === 'function') tracked.onTerminal(tracked.data);
          return;
        }
        pollOperation(key, 500);
      }).catch(function (error) {
        tracked.pollFailures = Math.min(10, Number(tracked.pollFailures) + 1);
        tracked.pollError = errorText(error, '未知错误');
        refreshOperationViews();
        pollOperation(key, Math.min(5000, 500 * Math.pow(2, tracked.pollFailures)));
      });
    }, Math.max(250, Math.min(5000, Number(delayMs) || 500)));
  }

  function trackOperation(key, envelope, onTerminal) {
    var uri = envelope && envelope.receipt && envelope.receipt.operationUri;
    if (!uri) throw new Error('操作未返回可跟踪的状态地址');
    operations[key] = {
      uri: String(uri),
      data: operationDataFromEnvelope(envelope),
      pollError: '',
      pollFailures: 0,
      onTerminal: onTerminal,
    };
    refreshOperationViews();
    if (!TERMINAL_OPERATION_STATES[operations[key].data.status]) {
      pollOperation(key, envelope.receipt && envelope.receipt.retryAfterMs);
    } else if (typeof onTerminal === 'function') {
      onTerminal(operations[key].data);
    }
    return operations[key];
  }

  function captureMcpDraft() {
    if (!mcpDraft || !$('#http-mcp-name')) return;
    mcpDraft.name = $('#http-mcp-name').value;
    mcpDraft.url = $('#http-mcp-url').value;
    mcpDraft.timeoutMs = Number($('#http-mcp-timeout').value) || 120000;
    mcpDraft.protocolVersion = $('#http-mcp-protocol').value;
    mcpDraft.enabled = $('#http-mcp-enabled').checked;
    mcpDraft._bearerToken = $('#http-mcp-token').value;
    mcpDraft._headersText = $('#http-mcp-headers').value;
    mcpDraft.useBrowserCookies = $('#http-mcp-browser-cookies').checked;
    mcpDraft._clearBearerToken = $('#http-mcp-clear-token').checked;
    mcpDraft._clearHeaders = $('#http-mcp-clear-headers').checked;
  }

  function renderMcpEditor() {
    if (!mcpDraft) return '';
    var item = mcpDraft;
    var existing = !!item.id;
    var auth = item.auth || {};
    return '<div class="editor knowledge-mcp-editor">'
      + '<h3>' + (existing ? '编辑 HTTP MCP 服务器' : '添加 HTTP MCP 服务器') + '</h3>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>名称</label><input type="text" id="http-mcp-name" value="' + esc(item.name || '') + '"></div>'
      + '<div class="form-row"><label>超时毫秒</label><input type="number" id="http-mcp-timeout" min="1000" max="600000" value="' + esc(item.timeoutMs || 120000) + '"></div>'
      + '</div>'
      + '<div class="form-row"><label>服务器地址</label><input type="url" id="http-mcp-url" value="' + esc(item.url || '') + '" placeholder="https://example.com/mcp"></div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>Bearer Token</label><input type="password" id="http-mcp-token" value="' + esc(item._bearerToken || '') + '" autocomplete="off" placeholder="' + (existing && auth.bearerTokenConfigured ? '已配置；留空保持不变' : '可选') + '"></div>'
      + '<div class="form-row"><label>协议版本</label><input type="text" id="http-mcp-protocol" value="' + esc(item.protocolVersion || '2025-11-25') + '"></div>'
      + '</div>'
      + '<div class="form-row"><label>自定义 Header</label><textarea id="http-mcp-headers" rows="4" placeholder="' + (existing && auth.customHeaderNames && auth.customHeaderNames.length ? '已配置 ' + esc(auth.customHeaderNames.join(', ')) + '；留空保持不变' : 'X-Api-Key: ...') + '">' + esc(item._headersText || '') + '</textarea></div>'
      + '<div class="knowledge-editor-checks">'
      + '<label class="switch-label"><input type="checkbox" id="http-mcp-enabled"' + (item.enabled !== false ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">启用</span></label>'
      + '<label class="switch-label"><input type="checkbox" id="http-mcp-browser-cookies"' + (item.useBrowserCookies === true ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">使用浏览器登录 Cookie</span></label>'
      + (existing ? '<label class="switch-label"><input type="checkbox" id="http-mcp-clear-token"' + (item._clearBearerToken ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">清除 Token</span></label><label class="switch-label"><input type="checkbox" id="http-mcp-clear-headers"' + (item._clearHeaders ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">清除 Header</span></label>' : '<input type="checkbox" id="http-mcp-clear-token" hidden><input type="checkbox" id="http-mcp-clear-headers" hidden>')
      + '</div>'
      + '<p class="form-help">Cookie 默认隔离。开启后尝试复用当前浏览器登录态，需服务端支持 Cookie 认证并符合浏览器 Cookie 策略。仅使用 Cookie 时，请清除已保存的 Token 和 Authorization Header。</p>'
      + '<div class="editor-actions"><button class="btn-primary" data-http-mcp-action="save">保存服务器</button><button class="btn-secondary" data-http-mcp-action="cancel">取消</button></div>'
      + '</div>';
  }

  function renderMcpTool(server, tool) {
    return '<div class="item-card knowledge-mcp-tool-card">'
      + '<div class="knowledge-card-main"><span class="item-title">' + esc(tool.name) + '</span><span class="item-sub">' + esc(tool.description || '') + '</span></div>'
      + '<button class="btn-small" data-http-mcp-action="call-tool" data-id="' + esc(server.id) + '" data-tool="' + esc(tool.name) + '">调用</button>'
      + '</div>';
  }

  function renderMcpTools(server) {
    var error = viewState.errors['tools:' + server.id];
    var collection = viewState.toolsByServer[server.id];
    if (error) return renderError(error);
    if (!collection) return '';
    return '<div class="item-list knowledge-mcp-tool-list">'
      + (collection.items.length ? collection.items.map(function (tool) { return renderMcpTool(server, tool); }).join('') : '<div class="placeholder">服务器尚未提供工具。</div>')
      + '</div>';
  }

  function renderMcpServerCard(server) {
    var lastStatus = server.lastStatus === 'ok' ? '可用' : (server.lastStatus === 'error' ? '异常' : '未检查');
    var statusClass = server.lastStatus === 'ok' ? ' on' : (server.lastStatus === 'error' ? ' danger' : '');
    return '<div class="knowledge-mcp-server-block">'
      + '<div class="item-card knowledge-mcp-card">'
      + '<div class="knowledge-card-main"><span class="item-title">' + esc(server.name || server.id) + '</span><span class="item-sub">' + esc(server.url || '') + '</span>'
      + '<span class="knowledge-meta">工具 ' + esc(server.toolCount || 0) + ' 个 · 最近更新 ' + esc(fmtTime(server.syncedAt || server.updatedAt)) + (server.lastError ? ' · ' + esc(server.lastError) : '') + '</span></div>'
      + '<span class="badge' + statusClass + '">' + esc(lastStatus) + '</span>'
      + (server.enabled ? '' : '<span class="badge">停用</span>')
      + '<button class="btn-small" data-http-mcp-action="edit" data-id="' + esc(server.id) + '">编辑</button>'
      + '<button class="btn-small" data-http-mcp-action="test" data-id="' + esc(server.id) + '">检查连接</button>'
      + '<button class="btn-small" data-http-mcp-action="discover" data-id="' + esc(server.id) + '">刷新工具</button>'
      + '<button class="btn-small" data-http-mcp-action="tools" data-id="' + esc(server.id) + '">查看工具</button>'
      + '<button class="btn-small btn-danger-outline" data-http-mcp-action="delete" data-id="' + esc(server.id) + '">删除</button>'
      + '</div>'
      + renderOperationSlot(operationKey('mcp-test', server.id))
      + renderOperationSlot(operationKey('mcp-discovery', server.id))
      + renderMcpTools(server)
      + '</div>';
  }

  function captureToolCallDraft() {
    if (!toolCallDraft || !$('#http-mcp-call-arguments')) return;
    toolCallDraft.argumentsText = $('#http-mcp-call-arguments').value;
    toolCallDraft.timeoutMs = Number($('#http-mcp-call-timeout').value) || 120000;
  }

  function renderToolCallEditor() {
    if (!toolCallDraft) return '';
    var key = operationKey('mcp-call', toolCallDraft.serverId + '/' + toolCallDraft.toolName);
    return '<div class="editor knowledge-mcp-call-editor">'
      + '<h3>调用工具：' + esc(toolCallDraft.toolName) + '</h3>'
      + '<p class="item-sub">' + esc(toolCallDraft.description || '') + '</p>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>参数 JSON</label><textarea id="http-mcp-call-arguments" rows="10">' + esc(toolCallDraft.argumentsText || '{}') + '</textarea></div>'
      + '<div class="form-row"><label>参数结构</label><pre class="mcp-snippet">' + esc(JSON.stringify(toolCallDraft.argumentSchema || {}, null, 2)) + '</pre><label>超时毫秒</label><input type="number" id="http-mcp-call-timeout" min="1000" max="600000" value="' + esc(toolCallDraft.timeoutMs || 120000) + '"></div>'
      + '</div>'
      + '<div class="editor-actions"><button class="btn-primary" data-http-mcp-action="submit-call">调用工具</button><button class="btn-secondary" data-http-mcp-action="cancel-call">取消</button></div>'
      + renderOperationSlot(key)
      + '</div>';
  }

  function renderMcpSection() {
    return '<div class="knowledge-mcp-section">'
      + '<div class="knowledge-mcp-head"><div><h3>HTTP MCP 服务器</h3><p>管理外部工具服务器，检查连接，刷新工具目录，并在允许后发起工具调用。</p></div><button class="btn-secondary" data-http-mcp-action="new">添加服务器</button></div>'
      + renderError(viewState.errors.mcp)
      + '<div class="item-list knowledge-mcp-list">'
      + (viewState.mcpServers.length ? viewState.mcpServers.map(renderMcpServerCard).join('') : '<div class="placeholder">尚未配置 HTTP MCP 服务器。</div>')
      + '</div>'
      + '<div id="http-mcp-editor-wrap">' + renderMcpEditor() + '</div>'
      + '<div id="http-mcp-call-editor-wrap">' + renderToolCallEditor() + '</div>'
      + '</div>';
  }

  function captureDrafts() {
    captureKnowledgeDraft();
    captureSkillDraft();
    captureSkillImportDraft();
    captureMcpDraft();
    captureToolCallDraft();
  }

  function renderCurrentState(skipCapture, section) {
    if (skipCapture !== true) captureDrafts();
    var element = $('#knowledge-root');
    if (!element) return;
    // innerHTML 重建会替换搜索框节点导致失焦；重建后恢复焦点与光标。
    var active = document.activeElement;
    var restoreSearch = isSearchInput(active);
    var searchId = restoreSearch ? active.id : '';
    var caret = restoreSearch ? active.selectionStart : 0;
    var skillSection = section === 'skill' && element.querySelector('.knowledge-skill-section');
    var knowledgeSection = section === 'knowledge' && element.querySelector('.knowledge-domain-section');
    if (skillSection) skillSection.outerHTML = renderSkillSection();
    else if (knowledgeSection) knowledgeSection.outerHTML = renderKnowledgeSection();
    else element.innerHTML = '<div id="knowledge-task-status">' + renderTaskStatus() + '</div>'
        + '<fieldset class="knowledge-content"' + (taskRunning() ? ' disabled' : '') + '>'
        + renderMcpSection() + renderSkillSection() + renderKnowledgeSection() + '</fieldset>';
    element.querySelectorAll('[data-indeterminate]').forEach(function (input) { input.indeterminate = true; });
    if (restoreSearch) {
      var search = $('#' + searchId);
      if (search) {
        search.focus();
        try { search.setSelectionRange(caret, caret); } catch (_) {}
      }
    }
  }

  function render() {
    if (!initialized) init(deps);
    if (taskRunning()) return Promise.resolve();
    var sequence = ++renderSequence;
    captureDrafts();
    return loadAll().then(function () {
      if (sequence !== renderSequence) return;
      renderCurrentState();
    }).catch(function (error) {
      if (sequence !== renderSequence) return;
      var element = $('#knowledge-root');
      if (element) element.innerHTML = '<div class="placeholder">加载失败：' + esc(errorText(error)) + '</div>';
    });
  }

  function scrollIntoView(selector) {
    (root.requestAnimationFrame || function (callback) { return root.setTimeout(callback, 0); })(function () {
      var element = $(selector);
      if (!element) return;
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var focus = element.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
      if (focus) focus.focus();
    });
  }

  function newKnowledge() {
    if (taskRunning()) return;
    knowledgeDraft = {
      type: 'custom', title: '', summary: '', content: '', tags: [], sourceKind: 'auto',
      source: { kind: 'auto' }, pinned: false, archived: false, confidence: 0.8,
    };
    renderCurrentState(true);
    scrollIntoView('#knowledge-editor-wrap .knowledge-editor');
  }

  function editKnowledge(id) {
    return ensureClient().get(knowledgeUri(id)).then(function (envelope) {
      knowledgeDraft = envelopeData(envelope, '知识');
      renderCurrentState(true);
      scrollIntoView('#knowledge-editor-wrap .knowledge-editor');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function knowledgeWritePayload() {
    captureKnowledgeDraft();
    var item = knowledgeDraft || {};
    return {
      id: item.id || undefined,
      type: item.type || 'custom',
      title: String(item.title || '').trim(),
      summary: String(item.summary || '').trim(),
      content: String(item.content || '').trim(),
      tags: splitTags(item.tags),
      sourceKind: 'auto',
      source: Object.assign({}, item.source || {}, { kind: 'auto' }),
      pinned: item.pinned === true,
      archived: item.archived === true,
      confidence: Number(item.confidence) || 0.8,
    };
  }

  function saveKnowledge() {
    var payload = knowledgeWritePayload();
    if (!payload.title || !payload.content) {
      toast('标题和内容不能为空', true);
      return Promise.resolve();
    }
    var request = payload.id
      ? ensureClient().authorizedPut(knowledgeUri(payload.id), payload, mutationOptions({ ifMatch: 'cached' }))
      : ensureClient().authorizedPost('/knowledge', payload, mutationOptions());
    return request.then(function () {
      knowledgeDraft = null;
      toast('知识已保存');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function deleteKnowledge(id) {
    return deleteItems('knowledge', id ? [id] : []);
  }

  function deleteItems(kind, ids) {
    if (taskRunning() || !ids.length || !confirmAction('删除所选的 ' + ids.length + ' 个' + (kind === 'skill' ? ' Skill' : '知识条目') + '？此操作不可恢复。')) return Promise.resolve();
    var selection = kind === 'skill' ? selectedSkills : selectedKnowledge;
    var names = new Map((kind === 'skill' ? viewState.skills : viewState.knowledgePage.items).map(function (item) {
      return [item.id, item.name || item.title];
    }));
    var items = ids.map(function (id) { return { id: id, name: names.get(id) || id }; });
    return runBatch('删除' + (kind === 'skill' ? ' Skill' : '知识'), items, async function (item) {
      var id = item.id;
      var uri = kind === 'skill' ? skillUri(id) : knowledgeUri(id);
      await ensureClient().get(uri);
      await ensureClient().authorizedDelete(uri, mutationOptions({ ifMatch: 'cached' }));
      selection.delete(id);
      if (kind === 'skill' && skillDraft && skillDraft.id === id) skillDraft = null;
      if (kind === 'knowledge' && knowledgeDraft && knowledgeDraft.id === id) knowledgeDraft = null;
    }, async function () {
      if (kind === 'skill') await loadSkills();
      else {
        await loadKnowledgePage();
        if (queryState.cursor >= viewState.knowledgePage.total && queryState.cursor > 0) {
          queryState.cursor = Math.max(0, Math.ceil(viewState.knowledgePage.total / queryState.limit) - 1) * queryState.limit;
          await loadKnowledgePage();
        }
      }
    });
  }

  function saveKnowledgeSettings() {
    var enabled = $('#knowledge-enabled');
    var autoCapture = $('#knowledge-auto-capture');
    if (!enabled || !autoCapture) return Promise.resolve();
    var patch = {
      enabled: enabled.checked,
      autoCapture: autoCapture.checked,
    };
    settingsSaveChain = settingsSaveChain.catch(function () {}).then(function () {
      return ensureClient().authorizedPatch('/knowledge-settings', patch, mutationOptions({ ifMatch: 'cached' }));
    }).then(function (envelope) {
      viewState.settings = envelopeData(envelope, '知识设置');
      toast('知识设置已保存');
      renderCurrentState();
    }).catch(function (error) {
      toast(errorText(error), true);
      renderCurrentState();
      throw error;
    });
    return settingsSaveChain.catch(function () {});
  }

  function editSkill(id) {
    return ensureClient().get(skillUri(id)).then(function (envelope) {
      skillDraft = envelopeData(envelope, 'Skill');
      renderCurrentState(true);
      scrollIntoView('#skill-editor-wrap .knowledge-skill-editor');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function viewSkillResource(target) {
    var resource = skillDraft && (skillDraft.resources || [])[Number(target.dataset.resourceIndex)];
    var details = target.closest('details');
    if (!resource || !details) return;
    details.open = !details.open;
    if (!details.open || details.dataset.loaded || details.dataset.loading) return;
    var preview = details.querySelector('pre');
    details.dataset.loading = 'true';
    preview.textContent = '正在读取…';
    return ensureClient().get(resource.href).then(function (envelope) {
      var data = envelopeData(envelope, 'Skill 资源');
      preview.textContent = data.content === '' ? '（空文件）' : String(data.content);
      details.dataset.loaded = 'true';
    }).catch(function (error) {
      preview.textContent = '读取失败：' + errorText(error) + '。请收起后重新展开重试。';
    }).finally(function () {
      delete details.dataset.loading;
    });
  }

  function saveSkill() {
    captureSkillDraft();
    if (!skillDraft || !skillDraft.id) return Promise.resolve();
    var patch = {
      name: String(skillDraft.name || '').trim(),
      description: String(skillDraft.description || '').trim(),
      instructions: String(skillDraft.instructions || '').trim(),
      version: String(skillDraft.version || '1').trim(),
      tags: splitTags(skillDraft.tags),
      enabled: skillDraft.enabled !== false,
      archived: skillDraft.archived === true,
    };
    if (!patch.name || !patch.instructions) {
      toast('Skill 名称和指令不能为空', true);
      return Promise.resolve();
    }
    return ensureClient().authorizedPatch(skillUri(skillDraft.id), patch, mutationOptions({ ifMatch: 'cached' })).then(function () {
      skillDraft = null;
      toast('Skill 已保存');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function archiveSkill(id) {
    if (!id || !confirmAction('归档这个 Skill？')) return Promise.resolve();
    var uri = skillUri(id);
    return ensureClient().get(uri).then(function () {
      return ensureClient().authorizedPatch(uri, { archived: true }, mutationOptions({ ifMatch: 'cached' }));
    }).then(function () {
      if (skillDraft && skillDraft.id === id) skillDraft = null;
      toast('Skill 已归档');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function deleteSkill(id) {
    return deleteItems('skill', id ? [id] : []);
  }

  async function selectSkillFiles(input) {
    if (taskRunning() || !skillImportDraft || !input.files.length) return;
    captureSkillImportDraft();
    var files = input.files;
    var task = beginTask('解析目录', files.length * 2);
    try {
      var packages = await detectSkillPackages(files, task);
      checkTaskCancelled(task);
      skillImportDraft.packages = packages;
      skillImportDraft.page = 0;
      skillImportDraft.q = '';
      treeExpansion.import.clear();
      if (!packages.length) toast('没有发现 SKILL.md', true);
    } catch (error) {
      if (!task.cancelled) task.failures.push(errorText(error));
    } finally {
      task.running = false;
      task.detail = '识别到 ' + (skillImportDraft.packages || []).length + ' 个 Skill';
      renderCurrentState();
    }
  }

  function importSkills() {
    if (taskRunning() || !skillImportDraft) return Promise.resolve();
    captureSkillImportDraft();
    var selected = (skillImportDraft && skillImportDraft.packages || []).filter(function (pkg) { return pkg.selected !== false; });
    var pasted = String(skillImportDraft && skillImportDraft.markdown || '').trim();
    if (!selected.length && !pasted) {
      toast('请选择 Skill 包或粘贴 SKILL.md', true);
      return Promise.resolve();
    }
    var packages = selected.slice();
    if (!selected.length && pasted) {
      packages.push({
        id: 'pasted-skill', path: 'SKILL.md', rootDir: '', selected: true,
        file: null, files: [], pasted: pasted,
      });
    }
    var draft = skillImportDraft;
    return runBatch('导入 Skill', packages, async function (pkg, task) {
      try {
        var payloadPromise;
        if (pkg.pasted) {
          var parsed = parseFrontmatter(pkg.pasted);
          var name = String(parsed.metadata.name || '').trim();
          var description = String(parsed.metadata.description || '').trim();
          if (!name || !description || !parsed.body) throw new Error('粘贴的 SKILL.md 必须包含 name、description 和指令正文');
          if (parsed.body.length > 500000) throw new Error('Skill 指令超过 500000 字符');
          payloadPromise = Promise.resolve({
            name: name,
            description: description,
            instructions: parsed.body,
            version: String(parsed.metadata.version || '1'),
            source: { kind: 'skill', uri: String(draft.sourceUri || '').trim(), entryPath: 'SKILL.md', importer: 'options-skill-import' },
            resources: [], tags: parseFrontmatterTags(parsed.metadata.tags || ''), enabled: true, archived: false,
          });
        } else {
          payloadPromise = readSkillPackage(pkg, draft.sourceUri, task);
        }
        var payload = await payloadPromise;
        checkTaskCancelled(task);
        pkg.importKey = pkg.importKey || makeIdempotencyKey('skill_import');
        await ensureClient().authorizedPost('/skills', payload, mutationOptions({ idempotencyKey: pkg.importKey }));
        pkg.imported = true;
        pkg.selected = false;
        delete pkg.error;
        if (pkg.pasted) draft.markdown = '';
      } catch (error) {
        if (!task.cancelled) pkg.error = errorText(error);
        throw error;
      }
    }, function () {
      draft.packages = draft.packages.filter(function (pkg) { return !pkg.imported; });
      if (!draft.packages.length && !draft.markdown.trim()) skillImportDraft = null;
      return loadSkills();
    });
  }

  function newMcpServer() {
    mcpDraft = {
      name: '', url: '', timeoutMs: 120000, protocolVersion: '2025-11-25',
      enabled: true, useBrowserCookies: false, _bearerToken: '', _headersText: '',
    };
    renderCurrentState(true);
    scrollIntoView('#http-mcp-editor-wrap .knowledge-mcp-editor');
  }

  function editMcpServer(id) {
    return ensureClient().get(mcpServerUri(id)).then(function (envelope) {
      mcpDraft = envelopeData(envelope, 'HTTP MCP 服务器');
      mcpDraft._bearerToken = '';
      mcpDraft._headersText = '';
      renderCurrentState(true);
      scrollIntoView('#http-mcp-editor-wrap .knowledge-mcp-editor');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function saveMcpServer() {
    captureMcpDraft();
    if (!mcpDraft) return Promise.resolve();
    var body = {
      name: String(mcpDraft.name || '').trim(),
      url: String(mcpDraft.url || '').trim(),
      enabled: mcpDraft.enabled !== false,
      useBrowserCookies: mcpDraft.useBrowserCookies === true,
      timeoutMs: Math.max(1000, Math.min(600000, Number(mcpDraft.timeoutMs) || 120000)),
      protocolVersion: String(mcpDraft.protocolVersion || '').trim(),
    };
    if (!body.name || !body.url) {
      toast('名称和服务器地址不能为空', true);
      return Promise.resolve();
    }
    if (!mcpDraft.id || mcpDraft._bearerToken || mcpDraft._clearBearerToken) {
      body.bearerToken = mcpDraft._clearBearerToken ? '' : String(mcpDraft._bearerToken || '');
    }
    if (!mcpDraft.id || mcpDraft._headersText || mcpDraft._clearHeaders) {
      body.headersText = mcpDraft._clearHeaders ? '' : String(mcpDraft._headersText || '').trim();
    }
    var request = mcpDraft.id
      ? ensureClient().authorizedPatch(mcpServerUri(mcpDraft.id), body, mutationOptions({ ifMatch: 'cached' }))
      : ensureClient().authorizedPost('/mcp-servers', body, mutationOptions());
    return request.then(function () {
      mcpDraft = null;
      toast('HTTP MCP 服务器已保存');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function deleteMcpServer(id) {
    if (!id || !confirmAction('删除这个 HTTP MCP 服务器？相关托管知识会归档。')) return Promise.resolve();
    var uri = mcpServerUri(id);
    return ensureClient().get(uri).then(function () {
      return ensureClient().authorizedDelete(uri, mutationOptions({ ifMatch: 'cached' }));
    }).then(function () {
      if (mcpDraft && mcpDraft.id === id) mcpDraft = null;
      delete viewState.toolsByServer[id];
      toast('HTTP MCP 服务器已删除');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function refreshMcpAfterOperation(serverId, includeTools) {
    captureDrafts();
    var loads = [loadMcpServers()];
    if (includeTools) loads.push(loadMcpTools(serverId).catch(function () {}));
    return Promise.all(loads).then(renderCurrentState);
  }

  function operationFinishedMessage(data, label) {
    if (data.status === 'succeeded') toast(label + '已完成');
    else toast(label + (data.status === 'interrupted' ? '已中断' : '失败') + (data.error ? '：' + data.error : ''), true);
  }

  function testMcpServer(id) {
    var uri = mcpServerUri(id) + '/connection-attempts';
    var key = operationKey('mcp-test', id);
    return ensureClient().authorizedPost(uri, { timeoutMs: 120000 }, mutationOptions()).then(function (envelope) {
      trackOperation(key, envelope, function (data) {
        operationFinishedMessage(data, '连接检查');
        refreshMcpAfterOperation(id, false);
      });
      toast('连接检查已开始');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function discoverMcpTools(id) {
    var uri = mcpServerUri(id) + '/tool-discoveries';
    var key = operationKey('mcp-discovery', id);
    return ensureClient().authorizedPost(uri, { timeoutMs: 120000 }, mutationOptions()).then(function (envelope) {
      trackOperation(key, envelope, function (data) {
        operationFinishedMessage(data, '工具刷新');
        refreshMcpAfterOperation(id, true);
      });
      toast('工具刷新已开始');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function showMcpTools(id) {
    return loadMcpTools(id).then(function () {
      renderCurrentState();
    }).catch(function (error) { toast(errorText(error), true); renderCurrentState(); });
  }

  function dynamicCallDescriptor(envelope, uri) {
    var descriptor = ensureClient().descriptorFor(envelope, 'POST', uri);
    if (!descriptor) throw new Error('这个工具当前不可调用');
    var inputSchema = descriptor.inputSchema || {};
    var properties = inputSchema.properties || {};
    var schemaHash = properties.schemaHash && properties.schemaHash.const;
    if (!schemaHash) throw new Error('工具参数结构缺少版本绑定');
    return {
      descriptor: descriptor,
      schemaHash: String(schemaHash),
      argumentSchema: clone(Object.prototype.hasOwnProperty.call(properties, 'arguments')
        ? properties.arguments
        : { type: 'object' }),
    };
  }

  function openToolCall(serverId, toolName) {
    var toolUri = mcpToolUri(serverId, toolName);
    var callUri = mcpCallUri(serverId, toolName);
    return Promise.all([
      ensureClient().get(toolUri),
      ensureClient().options(callUri, { relation: 'mcp-calls' }),
    ]).then(function (values) {
      var tool = envelopeData(values[0], 'MCP 工具');
      var dynamic = dynamicCallDescriptor(values[1], callUri);
      toolCallDraft = {
        serverId: serverId,
        toolName: toolName,
        description: tool.description || '',
        argumentSchema: dynamic.argumentSchema,
        schemaHash: dynamic.schemaHash,
        argumentsText: '{}',
        timeoutMs: 120000,
      };
      renderCurrentState(true);
      scrollIntoView('#http-mcp-call-editor-wrap .knowledge-mcp-call-editor');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function postDynamicMcpCall(uri, argumentsValue, timeoutMs) {
    var client = ensureClient();
    var idempotencyKey = makeIdempotencyKey('mcp_call');
    return client.options(uri, { relation: 'mcp-calls' }).then(function (optionsEnvelope) {
      var dynamic = dynamicCallDescriptor(optionsEnvelope, uri);
      var body = { arguments: argumentsValue, timeoutMs: timeoutMs, schemaHash: dynamic.schemaHash };
      return client.post(uri, body, { idempotencyKey: idempotencyKey });
    });
  }

  function submitToolCall() {
    captureToolCallDraft();
    if (!toolCallDraft) return Promise.resolve();
    var argumentsValue;
    try {
      argumentsValue = JSON.parse(toolCallDraft.argumentsText || '{}');
    } catch (error) {
      toast('参数 JSON 无法解析：' + error.message, true);
      return Promise.resolve();
    }
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      toast('工具参数必须是 JSON 对象', true);
      return Promise.resolve();
    }
    var serverId = toolCallDraft.serverId;
    var toolName = toolCallDraft.toolName;
    var key = operationKey('mcp-call', serverId + '/' + toolName);
    return postDynamicMcpCall(mcpCallUri(serverId, toolName), argumentsValue, toolCallDraft.timeoutMs).then(function (envelope) {
      trackOperation(key, envelope, function (data) { operationFinishedMessage(data, '工具调用'); });
      toast('工具调用已开始');
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function handleClick(event) {
    var stopTarget = event.target && event.target.closest && event.target.closest('[data-knowledge-action="stop-task"]');
    if (stopTarget && taskRunning()) {
      event.preventDefault();
      event.stopPropagation();
      activeTask.cancelled = true;
      updateTaskStatus();
      return;
    }
    if (taskRunning() && event.target && event.target.closest && event.target.closest('.knowledge-content')) {
      event.preventDefault();
      return;
    }
    var mcpTarget = event.target && event.target.closest && event.target.closest('[data-http-mcp-action]');
    if (mcpTarget) {
      event.preventDefault();
      event.stopPropagation();
      var mcpAction = mcpTarget.dataset.httpMcpAction;
      var serverId = mcpTarget.dataset.id || '';
      if (mcpAction === 'new') newMcpServer();
      else if (mcpAction === 'edit') editMcpServer(serverId);
      else if (mcpAction === 'save') saveMcpServer();
      else if (mcpAction === 'cancel') { mcpDraft = null; renderCurrentState(); }
      else if (mcpAction === 'delete') deleteMcpServer(serverId);
      else if (mcpAction === 'test') testMcpServer(serverId);
      else if (mcpAction === 'discover') discoverMcpTools(serverId);
      else if (mcpAction === 'tools') showMcpTools(serverId);
      else if (mcpAction === 'call-tool') openToolCall(serverId, mcpTarget.dataset.tool || '');
      else if (mcpAction === 'submit-call') submitToolCall();
      else if (mcpAction === 'cancel-call') { toolCallDraft = null; renderCurrentState(); }
      return;
    }

    var skillTarget = event.target && event.target.closest && event.target.closest('[data-skill-action]');
    if (skillTarget) {
      event.preventDefault();
      event.stopPropagation();
      var skillAction = skillTarget.dataset.skillAction;
      var skillId = skillTarget.dataset.id || '';
      if (skillAction === 'new-import') {
        skillImportDraft = { sourceUri: '', markdown: '', packages: [] };
        treeExpansion.import.clear();
        renderCurrentState(true);
        scrollIntoView('#skill-import-editor-wrap .knowledge-skill-editor');
      } else if (skillAction === 'cancel-import') { skillImportDraft = null; renderCurrentState(); }
      else if (skillAction === 'tree-toggle') {
        var treeKind = skillTarget.dataset.treeKind;
        var treePath = skillTarget.dataset.treePath;
        var node = skillTrees[treeKind].get(treePath);
        if (node) {
          var state = treeKind === 'import' ? skillImportDraft : skillFilter;
          var expanded = treeExpansion[treeKind].has(treePath) ? treeExpansion[treeKind].get(treePath) : (node.depth === 0 || !!state.q);
          treeExpansion[treeKind].set(treePath, !expanded);
          renderCurrentState(false, 'skill');
        }
      }
      else if (skillAction === 'page') { skillFilter.page = Math.max(0, Number(skillTarget.dataset.page) || 0); renderCurrentState(false, 'skill'); }
      else if (skillAction === 'import-page' && skillImportDraft) { skillImportDraft.page = Math.max(0, Number(skillTarget.dataset.page) || 0); renderCurrentState(false, 'skill'); }
      else if ((skillAction === 'import-select-all' || skillAction === 'import-clear') && skillImportDraft) {
        var importQuery = String(skillImportDraft.q || '').trim().toLowerCase();
        skillImportDraft.packages.forEach(function (pkg) {
          if (skillAction === 'import-clear' || !importQuery || pkg.path.toLowerCase().indexOf(importQuery) !== -1) pkg.selected = skillAction === 'import-select-all';
        });
        renderCurrentState(false, 'skill');
      }
      else if (skillAction === 'import') importSkills();
      else if (skillAction === 'edit') editSkill(skillId);
      else if (skillAction === 'view-resource') viewSkillResource(skillTarget);
      else if (skillAction === 'save') saveSkill();
      else if (skillAction === 'cancel-edit') { skillDraft = null; renderCurrentState(); }
      else if (skillAction === 'archive') archiveSkill(skillId);
      else if (skillAction === 'delete') deleteSkill(skillId);
      return;
    }

    var knowledgeTarget = event.target && event.target.closest && event.target.closest('[data-knowledge-action]');
    if (!knowledgeTarget) return;
    event.preventDefault();
    event.stopPropagation();
    var action = knowledgeTarget.dataset.knowledgeAction;
    var id = knowledgeTarget.dataset.id || '';
    if (action === 'dismiss-task') {
      if (!taskRunning()) {
        activeTask = null;
        updateTaskStatus();
      }
      return;
    }
    if (action === 'select-items' || action === 'clear-selection' || action === 'delete-selected') {
      var kind = knowledgeTarget.dataset.kind;
      var selection = kind === 'skill' ? selectedSkills : selectedKnowledge;
      if (action === 'delete-selected') { deleteItems(kind, Array.from(selection)); return; }
      if (action === 'clear-selection') selection.clear();
      else (kind === 'skill' ? filteredSkills() : viewState.knowledgePage.items).forEach(function (item) {
        if (!(kind === 'skill' ? skillReadonly(item) : knowledgeReadonly(item))) selection.add(item.id);
      });
      renderCurrentState(false, kind);
    }
    else if (action === 'edit') editKnowledge(id);
    else if (action === 'save') saveKnowledge();
    else if (action === 'delete') deleteKnowledge(id);
    else if (action === 'cancel') { knowledgeDraft = null; renderCurrentState(); }
    else if (action === 'page-prev' || action === 'page-next') {
      queryState.cursor = normalizeCursor(knowledgeTarget.dataset.cursor);
      knowledgeDraft = null;
      loadKnowledgePage().then(function () { renderCurrentState(false, 'knowledge'); });
    }
  }

  function isSearchInput(target) {
    return !!(target && /^(knowledge-search|skill-search|skill-import-search)$/.test(target.id));
  }

  function handleSearchCompositionStart(event) {
    if (!isSearchInput(event.target)) return;
    composingSearch = event.target;
    // 组词期间不能重建搜索框，包括组词开始前已排队的搜索刷新。
    root.clearTimeout(searchTimer);
  }

  function handleSearchCompositionEnd(event) {
    if (!isSearchInput(event.target)) return;
    composingSearch = null;
    handleInput(event);
  }

  function handleInput(event) {
    if (!event.target) return;
    if (isSearchInput(event.target) && (event.isComposing || composingSearch === event.target)) return;
    if (event.target.id === 'skill-search' || event.target.id === 'skill-import-search') {
      if (event.target.id === 'skill-search') { skillFilter.q = event.target.value; skillFilter.page = 0; treeExpansion.skill.clear(); }
      else if (skillImportDraft) { skillImportDraft.q = event.target.value; skillImportDraft.page = 0; treeExpansion.import.clear(); }
      root.clearTimeout(searchTimer);
      searchTimer = root.setTimeout(function () { renderCurrentState(false, 'skill'); }, 180);
      return;
    }
    if (event.target.id === 'knowledge-search') {
      queryState.q = event.target.value.trim();
      queryState.cursor = 0;
      root.clearTimeout(searchTimer);
      selectedKnowledge.clear();
      searchTimer = root.setTimeout(function () { loadKnowledgePage().then(function () { renderCurrentState(false, 'knowledge'); }); }, 180);
      return;
    }
    captureDrafts();
  }

  function handleChange(event) {
    var target = event.target;
    if (!target) return;
    if (target.hasAttribute('data-skill-tree-select')) {
      selectSkillDirectory(target.dataset.skillTreeSelect, target.dataset.treePath, target.checked);
      return;
    }
    if (target.matches && target.matches('[data-skill-select], [data-knowledge-select]')) {
      var kind = target.hasAttribute('data-skill-select') ? 'skill' : 'knowledge';
      var selection = kind === 'skill' ? selectedSkills : selectedKnowledge;
      var selectedId = target.getAttribute('data-' + kind + '-select');
      if (target.checked) selection.add(selectedId); else selection.delete(selectedId);
      updateSelectionCount(kind);
      if (kind === 'skill') renderCurrentState(false, 'skill');
      return;
    }
    if (target.id === 'skill-import-directory' || target.id === 'skill-import-files') {
      selectSkillFiles(target);
      return;
    }
    if (target.matches && target.matches('[data-skill-package-select]')) {
      var packageId = target.getAttribute('data-skill-package-select') || '';
      (skillImportDraft && skillImportDraft.packages || []).forEach(function (pkg) {
        if (pkg.id === packageId) pkg.selected = target.checked;
      });
      var count = $('#skill-import-selected-count');
      if (count && skillImportDraft) count.textContent = '已选 ' + skillImportDraft.packages.filter(function (pkg) { return pkg.selected !== false; }).length + ' / ' + skillImportDraft.packages.length + ' 个 Skill';
      renderCurrentState(false, 'skill');
      return;
    }
    if (target.matches && target.matches('[data-knowledge-page-size]')) {
      queryState.limit = normalizePageSize(target.value);
      queryState.cursor = 0;
      knowledgeDraft = null;
      loadKnowledgePage().then(function () { renderCurrentState(false, 'knowledge'); });
      return;
    }
    if (target.id === 'knowledge-filter-type' || target.id === 'knowledge-filter-source'
        || target.id === 'knowledge-include-archived' || target.id === 'knowledge-include-stale') {
      currentKnowledgeQuery();
      queryState.cursor = 0;
      knowledgeDraft = null;
      selectedKnowledge.clear();
      loadKnowledgePage().then(function () { renderCurrentState(false, 'knowledge'); });
      return;
    }
    if (/^knowledge-(?:enabled|auto-capture)$/.test(target.id || '')) {
      saveKnowledgeSettings();
      return;
    }
    captureDrafts();
  }

  function init(inputDeps) {
    deps = inputDeps || deps || {};
    if (initialized) return;
    initialized = true;
    ensureClient();
    document.addEventListener('click', handleClick);
    document.addEventListener('compositionstart', handleSearchCompositionStart);
    document.addEventListener('compositionend', handleSearchCompositionEnd);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    var refreshButton = $('#btn-knowledge-refresh');
    var newButton = $('#btn-knowledge-new');
    if (refreshButton) refreshButton.addEventListener('click', function () { render(); });
    if (newButton) newButton.addEventListener('click', newKnowledge);
  }

  return Object.freeze({ init: init, render: render });
});
