// Shared source operations. Resource adapters own persistence and authorization.
(function (root) {
  'use strict';
  var AUTO_DIFF_MAX_CHARS = 4000;
  function error(code, message) { return root.AgentResourceProtocol.arpError(code, message, { performed: 'no', stage: 'source-validation' }); }
  var editProperties = {
    oldText: { type: 'string', minLength: 1, description: '从当前源码读取的原文片段，须恰好匹配一次；可跨行，保留缩进，重复时补充上下文' },
    newText: { type: 'string', description: '替换后的片段；空字符串表示删除，插入时保留 oldText 锚点并加入新内容。沿用周围缩进和换行，不压缩源码' },
  };
  var includeDiffSchema = { type: 'boolean', description: '通常省略，oldText 与 newText 字符数合计不超过 ' + AUTO_DIFF_MAX_CHARS + ' 时自动返回 diff；仅本次确需大改动的 diff 时传 true，false 关闭。跳过时不回读源码；显式请求仍受 12000 字符与 200 ms 限制。须随本次编辑提交，不要重放成功编辑来补取 diff。' };
  function querySchema(revision) {
    var grep = root.KnowledgeSearch.GREP_QUERY_PROPERTIES;
    return { type: 'object', additionalProperties: false, properties: {
      q: Object.assign({}, grep.q, { minLength: 1, description: '提供 q 即按 grep 搜索；省略则按行读取。正则最多 256 字符，fixedStrings=true 按字面匹配、最多 4096 字符。' }),
      fixedStrings: grep.fixedStrings, caseSensitive: grep.caseSensitive,
      before: Object.assign({}, grep.before, { description: '同 grep -B，默认 0、最多 20；须与 q 同用' }),
      after: Object.assign({}, grep.after, { description: '同 grep -A，默认 0、最多 20；须与 q 同用' }),
      startLine: { type: 'integer', minimum: 1, description: '读取起始行号，默认 1；不能与 q 同用' },
      startColumn: { type: 'integer', minimum: 1, description: '起始行列号，默认 1；用于续读长行，不能与 q 同用' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '读取行数或搜索命中数上限；读取默认 50 行，搜索默认 5 个命中行' },
      revision: Object.assign({ description: '续读时传入上一页 revision；版本变化则拒绝读取' }, revision),
    } };
  }
  function validateQuery(query) {
    if (query.q !== undefined && (query.startLine !== undefined || query.startColumn !== undefined)) throw error('SCHEMA_VALIDATION_FAILED', '搜索使用 q；按行读取请省略 q');
    if (query.q === undefined && ['fixedStrings', 'caseSensitive', 'before', 'after'].some(function (key) { return query[key] !== undefined; })) throw error('SCHEMA_VALIDATION_FAILED', '搜索选项必须与 q 一起使用');
  }
  function read(source, query) {
    query = query || {}; validateQuery(query);
    if (typeof source !== 'string') {
      if (Object.keys(query).some(function (key) { return key !== 'revision'; })) throw error('SCHEMA_VALIDATION_FAILED', '此字段不是文本，不支持搜索或按行读取参数');
      return { value: source };
    }
    if (query.q !== undefined) {
      try { return root.KnowledgeSearch.createGrep(Object.assign({}, query, { query: query.q, perItemLimit: query.limit })).search(source); }
      catch (failure) { throw error('SCHEMA_VALIDATION_FAILED', failure.message); }
    }
    var lines = source.split(/\r?\n/), index = (query.startLine || 1) - 1, column = (query.startColumn || 1) - 1;
    var limit = query.limit || 50, budget = 12000, rows = [], used = 0;
    if (index < lines.length && column > lines[index].length) throw error('SCHEMA_VALIDATION_FAILED', 'startColumn 超出起始行长度');
    while (index < lines.length && rows.length < limit && used < budget) {
      var text = lines[index].slice(column, column + budget - used);
      rows.push({ line: index + 1, column: column + 1, text: text, lineLength: lines[index].length, truncated: column > 0 || column + text.length < lines[index].length });
      used += text.length + 1; column += text.length;
      if (column < lines[index].length) break;
      index++; column = 0;
    }
    var hasMore = index < lines.length;
    return { mode: 'lines', totalLines: lines.length, totalChars: source.length, lines: rows, hasMore: hasMore,
      nextLine: hasMore ? index + 1 : null, nextColumn: hasMore ? column + 1 : null };
  }
  function list(files, baseUri) {
    return Object.keys(files).map(function (name) {
      return { name: name, chars: files[name].length, lines: files[name].split(/\r?\n/).length, uri: baseUri + encodeURIComponent(name) };
    });
  }
  // Callers supply a private working copy; nothing is persisted until all edits pass.
  function applyEdits(edits, targetForEdit) {
    var inputChars = 0;
    edits.forEach(function (edit, index) {
      var target = targetForEdit(edit), source = target.object[target.key], label = 'edits[' + index + '] ' + target.key;
      if (!Object.prototype.hasOwnProperty.call(target.object, target.key) || typeof source !== 'string') throw error('RESOURCE_NOT_FOUND', '源码不存在：' + target.key);
      var lineEnding = (source.match(/\r?\n/) || ['\n'])[0];
      var oldText = edit.oldText.replace(/\r?\n/g, lineEnding), newText = edit.newText.replace(/\r?\n/g, lineEnding);
      var offset = source.indexOf(oldText);
      if (offset === -1) throw error('RESOURCE_CONFLICT', label + ' 未找到 oldText，请重新读取相关片段后调整');
      if (source.indexOf(oldText, offset + 1) !== -1) throw error('RESOURCE_CONFLICT', label + ' 的 oldText 匹配多处，请补充唯一上下文');
      target.object[target.key] = source.slice(0, offset) + newText + source.slice(offset + oldText.length);
      inputChars += edit.oldText.length + edit.newText.length;
    });
    return inputChars;
  }
  async function diff(options) {
    var result = { beforeRevision: options.beforeRevision, afterRevision: options.afterRevision, status: 'unavailable', truncated: false, changes: [] };
    if (options.includeDiff === false || options.includeDiff !== true && options.inputChars > AUTO_DIFF_MAX_CHARS) {
      result.status = 'skipped'; result.reason = options.includeDiff === false ? 'disabled' : 'size_threshold';
      result.inputChars = options.inputChars; result.autoThreshold = AUTO_DIFF_MAX_CHARS; return result;
    }
    try {
      var saved = await options.readChanges();
      if (saved.reason) { result.reason = saved.reason; return result; }
      var budget = 12000, deadline = Date.now() + 200;
      saved.targets.forEach(function (target) {
        if (target.before === target.after) return;
        var change = Object.assign({}, target.change); result.changes.push(change);
        if (budget <= 0 || Date.now() >= deadline) {
          change.omitted = true; change.reason = budget <= 0 ? 'size_limit' : 'time_limit'; result.truncated = true; return;
        }
        var before = target.before || '', after = target.after || '';
        var contextLines = /[^\n]{501}/.test(before) || /[^\n]{501}/.test(after) ? 0 : 2;
        var patch = root.Diff.structuredPatch(target.before === undefined ? '/dev/null' : 'before/' + target.path,
          target.after === undefined ? '/dev/null' : 'after/' + target.path, before, after, undefined, undefined,
          { context: contextLines, timeout: Math.max(1, deadline - Date.now()) });
        if (!patch) { change.omitted = true; change.reason = 'time_limit'; result.truncated = true; return; }
        var text = root.Diff.formatPatch(patch);
        change.text = text.slice(0, budget); change.truncated = text.length > budget;
        budget -= change.text.length; if (change.truncated) result.truncated = true;
      });
      result.status = 'available';
    } catch (failure) { result.changes = []; result.reason = failure.code || 'diff_unavailable'; }
    return result;
  }
  root.PageAgentSourceCode = Object.freeze({ querySchema: querySchema, validateQuery: validateQuery, read: read, list: list, applyEdits: applyEdits, diff: diff,
    editProperties: editProperties, includeDiffSchema: includeDiffSchema, AUTO_DIFF_MAX_CHARS: AUTO_DIFF_MAX_CHARS });
})(globalThis);
