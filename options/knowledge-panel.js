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
    var query = currentKnowledgeQuery();
    return ensureClient().get('/knowledge', { query: query }).then(function (envelope) {
      viewState.knowledgePage = normalizeCollection(envelopeData(envelope, '知识列表'), { limit: query.limit });
      delete viewState.errors.knowledge;
    }, function (error) {
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
    return collectPagedResources('/skills', {
      limit: 100,
      includeArchived: true,
      includeDisabled: true,
    }).then(function (result) {
      viewState.skills = result.items;
      viewState.skillTotal = result.total;
      delete viewState.errors.skills;
    }, function (error) {
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
      + '<label class="knowledge-check"><input type="checkbox" id="knowledge-include-archived"' + (queryState.includeArchived ? ' checked' : '') + '>包含归档</label>'
      + '<label class="knowledge-check"><input type="checkbox" id="knowledge-include-stale"' + (queryState.includeStale ? ' checked' : '') + '>包含陈旧和拒绝项</label>'
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
      + '<label><input type="checkbox" id="knowledge-pinned"' + (item.pinned ? ' checked' : '') + (readonly ? ' disabled' : '') + '>置顶</label>'
      + '<label><input type="checkbox" id="knowledge-archived"' + (item.archived ? ' checked' : '') + (readonly ? ' disabled' : '') + '>归档</label>'
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

  function renderSkillCard(item) {
    var builtin = isBuiltinSkill(item);
    return '<div class="item-card knowledge-skill-card">'
      + '<div class="knowledge-card-main" data-skill-action="edit" data-id="' + esc(item.id) + '">'
      + '<span class="item-title">' + esc(item.name || item.id || 'Skill') + '</span>'
      + '<span class="item-sub">' + esc(item.description || '') + '</span>'
      + '<span class="knowledge-meta">资源 ' + esc((item.resources || []).length) + ' 个 · 更新 ' + esc(fmtTime(item.updatedAt)) + '</span>'
      + '</div>'
      + (builtin ? '<span class="badge builtin">内置</span>' : '<span class="badge">用户</span>')
      + (item.enabled === false ? '<span class="badge">停用</span>' : '')
      + (item.archived ? '<span class="badge">归档</span>' : '')
      + '<button class="btn-small" data-skill-action="edit" data-id="' + esc(item.id) + '">查看</button>'
      + (!item.archived ? '<button class="btn-small btn-danger-outline" data-skill-action="archive" data-id="' + esc(item.id) + '">归档</button>' : '')
      + '<button class="btn-small btn-danger-outline" data-skill-action="delete" data-id="' + esc(item.id) + '">删除</button>'
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

  function renderSkillEditor() {
    if (!skillDraft) return '';
    var item = skillDraft;
    var builtin = isBuiltinSkill(item);
    return '<div class="editor knowledge-skill-editor">'
      + '<h3>' + esc(item.name || 'Skill') + '</h3>'
      + (builtin ? '<div class="readonly-banner">内置 Skill 由扩展维护。保存、归档或删除会被拒绝，并显示具体原因。</div>' : '')
      + '<div class="form-grid">'
      + '<div class="form-row"><label>名称</label><input type="text" id="skill-edit-name" value="' + esc(item.name || '') + '"' + (builtin ? ' disabled' : '') + '></div>'
      + '<div class="form-row"><label>版本</label><input type="text" id="skill-edit-version" value="' + esc(item.version || '1') + '"' + (builtin ? ' disabled' : '') + '></div>'
      + '</div>'
      + '<div class="form-row"><label>说明</label><textarea id="skill-edit-description" rows="3"' + (builtin ? ' disabled' : '') + '>' + esc(item.description || '') + '</textarea></div>'
      + '<div class="form-row"><label>指令</label><textarea id="skill-edit-instructions" rows="14"' + (builtin ? ' disabled' : '') + '>' + esc(item.instructions || '') + '</textarea></div>'
      + '<div class="form-row"><label>标签</label><input type="text" id="skill-edit-tags" value="' + esc((item.tags || []).join(', ')) + '"' + (builtin ? ' disabled' : '') + '></div>'
      + '<div class="knowledge-editor-checks">'
      + '<label><input type="checkbox" id="skill-edit-enabled"' + (item.enabled !== false ? ' checked' : '') + (builtin ? ' disabled' : '') + '>启用</label>'
      + '<label><input type="checkbox" id="skill-edit-archived"' + (item.archived ? ' checked' : '') + (builtin ? ' disabled' : '') + '>归档</label>'
      + '<span>资源 ' + esc((item.resources || []).length) + ' 个</span>'
      + '</div>'
      + '<div class="editor-actions">'
      + '<button class="btn-primary" data-skill-action="save" data-id="' + esc(item.id) + '">保存 Skill</button>'
      + '<button class="btn-secondary" data-skill-action="cancel-edit">取消</button>'
      + '<span class="spacer"></span>'
      + '<button class="btn-danger" data-skill-action="delete" data-id="' + esc(item.id) + '">删除</button>'
      + '</div></div>';
  }

  function normalizeSkillFilePath(file) {
    return String(file && (file.webkitRelativePath || file.name) || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function pathDirectory(path) {
    var index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  function pathWithin(path, directory) {
    return !directory || path === directory || path.indexOf(directory + '/') === 0;
  }

  function isSkillMarkdown(path) {
    return /(^|\/)skill\.md$/i.test(String(path || ''));
  }

  function isIgnoredImportPath(path) {
    return /(^|\/)(?:\.git|\.hg|\.svn|node_modules|__pycache__)(?:\/|$)/i.test(path)
      || /(^|\/)\.ds_store$/i.test(path);
  }

  function detectSkillPackages(files) {
    files = Array.prototype.slice.call(files || []).filter(function (file) {
      var path = normalizeSkillFilePath(file);
      return path && !isIgnoredImportPath(path);
    });
    var entries = files.filter(function (file) { return isSkillMarkdown(normalizeSkillFilePath(file)); }).map(function (file) {
      var path = normalizeSkillFilePath(file);
      return { id: path, path: path, rootDir: pathDirectory(path), file: file, selected: true, files: [] };
    }).sort(function (left, right) {
      return left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path);
    });
    entries.forEach(function (entry) {
      var childRoots = entries.filter(function (candidate) {
        return candidate !== entry && candidate.rootDir && pathWithin(candidate.rootDir, entry.rootDir);
      }).map(function (candidate) { return candidate.rootDir; });
      entry.files = files.filter(function (file) {
        var path = normalizeSkillFilePath(file);
        if (!pathWithin(path, entry.rootDir)) return false;
        return !childRoots.some(function (childRoot) {
          return path !== entry.path && pathWithin(path, childRoot);
        });
      });
    });
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

  function readSkillPackage(skillPackage, sourceUri) {
    var entryFile = skillPackage.files.filter(function (file) {
      return normalizeSkillFilePath(file) === skillPackage.path;
    })[0] || skillPackage.file;
    if (!entryFile) return Promise.reject(new Error('Skill 包缺少 SKILL.md'));
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
    if (!skillImportDraft) return '';
    var packages = skillImportDraft.packages || [];
    var packageHtml = packages.map(function (pkg) {
      return '<label class="skill-import-file-row">'
        + '<input type="checkbox" data-skill-package-select="' + esc(pkg.id) + '"' + (pkg.selected !== false ? ' checked' : '') + '>'
        + '<span class="skill-import-file-path">' + esc(pkg.rootDir || pkg.path) + '</span>'
        + '<span class="skill-import-file-size">' + esc(pkg.files.length) + ' 个文件</span>'
        + '</label>';
    }).join('');
    return '<div class="editor knowledge-skill-editor">'
      + '<h3>导入 Skill</h3>'
      + '<div class="readonly-banner">选择包含 SKILL.md 的 Skill 包。指令和文本资源会作为本地 Skill 内容保存，脚本与资源文件不会在导入时执行。</div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>选择 Skill 文件夹</label><input type="file" id="skill-import-directory" webkitdirectory multiple></div>'
      + '<div class="form-row"><label>选择 SKILL.md 和资源</label><input type="file" id="skill-import-files" multiple></div>'
      + '</div>'
      + (packages.length ? '<div class="skill-import-drawer-list">' + packageHtml + '</div>' : '')
      + '<div class="form-row"><label>来源地址</label><input type="text" id="skill-import-source-uri" value="' + esc(skillImportDraft.sourceUri || '') + '" placeholder="可选"></div>'
      + '<div class="form-row"><label>或粘贴 SKILL.md</label><textarea id="skill-import-markdown" rows="12" placeholder="---&#10;name: example&#10;description: ...&#10;---&#10;&#10;# Instructions">' + esc(skillImportDraft.markdown || '') + '</textarea></div>'
      + '<div class="editor-actions"><button class="btn-primary" data-skill-action="import">导入 Skill</button><button class="btn-secondary" data-skill-action="cancel-import">取消</button></div>'
      + '</div>';
  }

  function renderSkillSection() {
    var skills = viewState.skills.slice().sort(function (left, right) {
      if (isBuiltinSkill(left) !== isBuiltinSkill(right)) return isBuiltinSkill(left) ? -1 : 1;
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    });
    return '<div class="knowledge-skill-section">'
      + '<div class="knowledge-mcp-head"><div><h3>Skill</h3><p>Skill 把可复用指令和参考资源组织成一个可管理的能力包。</p></div><button class="btn-secondary" data-skill-action="new-import">导入 Skill</button></div>'
      + renderError(viewState.errors.skills)
      + '<div class="item-list knowledge-skill-list">'
      + (skills.length ? skills.map(renderSkillCard).join('') : '<div class="placeholder">尚无 Skill。可以选择 Skill 文件夹或粘贴 SKILL.md。</div>')
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
      + (existing ? '<label class="knowledge-check"><input type="checkbox" id="http-mcp-clear-token"' + (item._clearBearerToken ? ' checked' : '') + '>清除 Token</label><label class="knowledge-check"><input type="checkbox" id="http-mcp-clear-headers"' + (item._clearHeaders ? ' checked' : '') + '>清除 Header</label>' : '<input type="checkbox" id="http-mcp-clear-token" hidden><input type="checkbox" id="http-mcp-clear-headers" hidden>')
      + '</div>'
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

  function renderCurrentState(skipCapture) {
    if (skipCapture !== true) captureDrafts();
    var element = $('#knowledge-root');
    if (!element) return;
    // innerHTML 重建会替换搜索框节点导致失焦；重建后恢复焦点与光标。
    var active = document.activeElement;
    var restoreSearch = !!(active && active.id === 'knowledge-search');
    var caret = restoreSearch ? active.selectionStart : 0;
    element.innerHTML = renderMcpSection() + renderSkillSection() + renderKnowledgeSection();
    if (restoreSearch) {
      var search = $('#knowledge-search');
      if (search) {
        search.focus();
        try { search.setSelectionRange(caret, caret); } catch (_) {}
      }
    }
  }

  function render() {
    if (!initialized) init(deps);
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
    id = String(id || '').trim();
    if (!id || !confirmAction('删除这条知识？')) return Promise.resolve();
    var uri = knowledgeUri(id);
    return ensureClient().get(uri).then(function () {
      return ensureClient().authorizedDelete(uri, mutationOptions({ ifMatch: 'cached' }));
    }).then(function () {
      if (knowledgeDraft && knowledgeDraft.id === id) knowledgeDraft = null;
      toast('知识已删除');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
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
    if (!id || !confirmAction('删除这个 Skill？此操作不可恢复。')) return Promise.resolve();
    var uri = skillUri(id);
    return ensureClient().get(uri).then(function () {
      return ensureClient().authorizedDelete(uri, mutationOptions({ ifMatch: 'cached' }));
    }).then(function () {
      if (skillDraft && skillDraft.id === id) skillDraft = null;
      toast('Skill 已删除');
      return render();
    }).catch(function (error) { toast(errorText(error), true); });
  }

  function selectSkillFiles(input) {
    captureSkillImportDraft();
    var files = Array.prototype.slice.call(input && input.files || []);
    skillImportDraft.files = files;
    skillImportDraft.packages = detectSkillPackages(files);
    if (!skillImportDraft.packages.length) toast('没有发现 SKILL.md', true);
    renderCurrentState();
  }

  function importSkills() {
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
    var created = 0;
    var chain = Promise.resolve();
    packages.forEach(function (pkg) {
      chain = chain.then(function () {
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
            source: { kind: 'skill', uri: String(skillImportDraft.sourceUri || '').trim(), entryPath: 'SKILL.md', importer: 'options-skill-import' },
            resources: [], tags: parseFrontmatterTags(parsed.metadata.tags || ''), enabled: true, archived: false,
          });
        } else {
          payloadPromise = readSkillPackage(pkg, skillImportDraft.sourceUri);
        }
        return payloadPromise.then(function (payload) {
          return ensureClient().authorizedPost('/skills', payload, mutationOptions());
        }).then(function () { created += 1; });
      });
    });
    toast('正在导入 Skill…');
    return chain.then(function () {
      skillImportDraft = null;
      toast('已导入 ' + created + ' 个 Skill');
      return render();
    }).catch(function (error) {
      toast((created ? '已导入 ' + created + ' 个；' : '') + errorText(error), true);
      return render();
    });
  }

  function newMcpServer() {
    mcpDraft = {
      name: '', url: '', timeoutMs: 120000, protocolVersion: '2025-11-25',
      enabled: true, _bearerToken: '', _headersText: '',
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
        skillImportDraft = { sourceUri: '', markdown: '', files: [], packages: [] };
        renderCurrentState(true);
        scrollIntoView('#skill-import-editor-wrap .knowledge-skill-editor');
      } else if (skillAction === 'cancel-import') { skillImportDraft = null; renderCurrentState(); }
      else if (skillAction === 'import') importSkills();
      else if (skillAction === 'edit') editSkill(skillId);
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
    if (action === 'edit') editKnowledge(id);
    else if (action === 'save') saveKnowledge();
    else if (action === 'delete') deleteKnowledge(id);
    else if (action === 'cancel') { knowledgeDraft = null; renderCurrentState(); }
    else if (action === 'page-prev' || action === 'page-next') {
      queryState.cursor = normalizeCursor(knowledgeTarget.dataset.cursor);
      knowledgeDraft = null;
      render();
    }
  }

  function handleInput(event) {
    if (!event.target) return;
    if (event.target.id === 'knowledge-search') {
      queryState.q = event.target.value.trim();
      queryState.cursor = 0;
      root.clearTimeout(searchTimer);
      searchTimer = root.setTimeout(render, 180);
      return;
    }
    captureDrafts();
  }

  function handleChange(event) {
    var target = event.target;
    if (!target) return;
    if (target.id === 'skill-import-directory' || target.id === 'skill-import-files') {
      selectSkillFiles(target);
      return;
    }
    if (target.matches && target.matches('[data-skill-package-select]')) {
      var packageId = target.getAttribute('data-skill-package-select') || '';
      (skillImportDraft && skillImportDraft.packages || []).forEach(function (pkg) {
        if (pkg.id === packageId) pkg.selected = target.checked;
      });
      return;
    }
    if (target.matches && target.matches('[data-knowledge-page-size]')) {
      queryState.limit = normalizePageSize(target.value);
      queryState.cursor = 0;
      knowledgeDraft = null;
      render();
      return;
    }
    if (target.id === 'knowledge-filter-type' || target.id === 'knowledge-filter-source'
        || target.id === 'knowledge-include-archived' || target.id === 'knowledge-include-stale') {
      currentKnowledgeQuery();
      queryState.cursor = 0;
      knowledgeDraft = null;
      render();
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
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    var refreshButton = $('#btn-knowledge-refresh');
    var newButton = $('#btn-knowledge-new');
    if (refreshButton) refreshButton.addEventListener('click', function () { render(); });
    if (newButton) newButton.addEventListener('click', newKnowledge);
  }

  return Object.freeze({ init: init, render: render });
});
