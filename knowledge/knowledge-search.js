(function attachKnowledgeSearch(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnowledgeSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_QUERY_CHARS = 4096;
  var MAX_TOKENIZE_CHARS = 24000;
  var MAX_FIXED_PATTERN_CHARS = 4096;
  var MAX_REGEX_PATTERN_CHARS = 256;

  var CHINESE_SEARCH_TERMS = [
    '内置知识', '自动沉淀', '知识', '能力', '工具', 'Skill', 'SKILL.md', '技能',
    '流程节点', '节点', '流程组', '流程', '页面源', '页面',
    '脚本', '定时任务', '定时运行', '定时', 'URL触发器', 'URL触发运行', '触发器',
    '流程报告', '报告', '运行记录', '运行', '验证', '验收', '排错', '报错',
    '创建', '新建', '新增', '修改', '编辑', '完善', '删除', '归档', '置顶',
    '查询', '检索', '搜索', '查看', '读取', '导入', '导出', '备份',
    '上下文', '干净上下文', '目标守卫', '目标变更', 'clean context', '目录', '明细', '选择器', '表单', '网络', '截图',
    '受控组件', '输入框', '下拉框', '复选框', '单选框', '表单自动化', '事件序列', '原生setter',
    '对话', '提示词', '任务', '触发', '组合', '编排',
  ];

  var CHINESE_STOP_TOKENS = {
    '怎么': true,
    '如何': true,
    '帮我': true,
    '我想': true,
    '想要': true,
    '需要': true,
    '一个': true,
    '一下': true,
    '这个': true,
    '那个': true,
    '里面': true,
    '可以': true,
    '什么': true,
    '以及': true,
    '并在': true,
  };

  function finiteInteger(value, min, max, fallback, zeroAsFallback) {
    var number = Number(value);
    if (number === Infinity) number = max;
    else if (number === -Infinity) number = min;
    else if (!isFinite(number)) number = fallback;
    if (zeroAsFallback && number === 0) number = fallback;
    number = Math.floor(number);
    return Math.max(min, Math.min(max, number));
  }

  function normalizeQuery(value) {
    var raw = String(value || '').trim();
    return {
      value: raw.slice(0, MAX_QUERY_CHARS),
      truncated: raw.length > MAX_QUERY_CHARS,
      originalLength: raw.length,
    };
  }

  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function braceQuantifierAt(pattern, index) {
    var match = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(index));
    if (!match) return null;
    return {
      length: match[0].length,
      unbounded: /,\}$/.test(match[0]),
    };
  }

  function regexComplexityReason(pattern) {
    var escaped = false;
    var inClass = false;
    var unboundedQuantifiers = 0;
    for (var i = 0; i < pattern.length; i++) {
      var char = pattern.charAt(i);
      if (escaped) {
        if (!inClass && /[1-9]/.test(char)) return 'backreferences are not allowed';
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '[' && !inClass) {
        inClass = true;
        continue;
      }
      if (char === ']' && inClass) {
        inClass = false;
        continue;
      }
      if (inClass) continue;
      if (char === '(' && pattern.charAt(i + 1) === '?' && /[=!<]/.test(pattern.charAt(i + 2))) {
        return 'lookaround assertions are not allowed';
      }
      if (char === ')') {
        var nextChar = pattern.charAt(i + 1);
        if (nextChar === '+' || nextChar === '*' || braceQuantifierAt(pattern, i + 1)) {
          return 'quantified groups are not allowed';
        }
      }
      if (char === '+' || char === '*') {
        unboundedQuantifiers += 1;
        if (unboundedQuantifiers > 1) return 'multiple unbounded quantifiers are not allowed';
      } else if (char === '{') {
        var braceQuantifier = braceQuantifierAt(pattern, i);
        if (braceQuantifier) {
          if (braceQuantifier.unbounded) {
            unboundedQuantifiers += 1;
            if (unboundedQuantifiers > 1) return 'multiple unbounded quantifiers are not allowed';
          }
          i += braceQuantifier.length - 1;
        }
      }
    }
    return '';
  }

  function create(options) {
    options = options || {};
    var typeLabels = options.typeLabels || {};
    var sourceLabels = options.sourceLabels || {};
    var sourcePriority = options.sourcePriority || { builtin: 1, auto: 2, mcp: 3, skill: 4 };
    var priorityRule = String(options.priorityRule || '');

    function normalizeSourceKind(value, fallbackType) {
      if (typeof options.normalizeSourceKind === 'function') return options.normalizeSourceKind(value, fallbackType);
      var kind = String(value || '').trim();
      if (kind === 'conversation' || kind === 'auto-capture') return 'auto';
      if (kind === 'builtin-user' || kind === 'manual-builtin') return 'auto';
      if (kind === 'built-in') return 'builtin';
      if (kind === 'mcp-server') return 'mcp';
      if (kind === 'codex-skill' || kind === 'agent-skill') return 'skill';
      if (sourcePriority[kind]) return kind;
      if (fallbackType === 'mcp') return 'mcp';
      if (fallbackType === 'skill') return 'skill';
      return 'auto';
    }

    function normalizeVerificationState(value, sourceKind) {
      if (typeof options.normalizeVerificationState === 'function') {
        return options.normalizeVerificationState(value, sourceKind);
      }
      var state = String(value || '').trim().toLowerCase();
      if ({ unverified: true, corroborated: true, verified: true, stale: true, rejected: true }[state]) return state;
      return sourceKind === 'auto' ? 'unverified' : 'verified';
    }

    function sourcePriorityTier(itemOrKind) {
      if (typeof options.sourcePriorityTier === 'function') return options.sourcePriorityTier(itemOrKind);
      var kind = typeof itemOrKind === 'string'
        ? normalizeSourceKind(itemOrKind)
        : normalizeSourceKind(itemOrKind && (itemOrKind.sourceKind || itemOrKind.source && itemOrKind.source.kind), itemOrKind && itemOrKind.type);
      return sourcePriority[kind] || sourcePriority.auto || 2;
    }

    function itemText(item) {
      item = item || {};
      return [
        item.title,
        item.summary,
        item.content,
        (item.tags || []).join(' '),
        item.type,
        item.source && item.source.kind,
        item.source && item.source.toolName,
        item.source && item.source.uri,
      ].filter(Boolean).join('\n').toLowerCase();
    }

    function tokenize(value) {
      var text = String(value || '').toLowerCase().slice(0, MAX_TOKENIZE_CHARS);
      var seen = {};
      var out = [];
      function add(token) {
        token = String(token || '').trim().toLowerCase();
        if (token.length < 2 || CHINESE_STOP_TOKENS[token] || seen[token]) return;
        seen[token] = true;
        out.push(token);
      }
      (text.match(/[a-z0-9_./:-]{2,}/g) || []).forEach(add);
      (text.match(/[\u4e00-\u9fff]{2,}/g) || []).forEach(function (run) {
        CHINESE_SEARCH_TERMS.forEach(function (term) {
          var normalized = term.toLowerCase();
          if (run.indexOf(normalized) !== -1) add(normalized);
        });
        for (var size = 2; size <= 3; size++) {
          if (run.length < size) continue;
          for (var i = 0; i <= run.length - size; i++) add(run.slice(i, i + size));
        }
      });
      return out;
    }

    function scoreItem(item, query) {
      item = item || {};
      var q = normalizeQuery(query).value.toLowerCase();
      if (!q) return item.pinned ? 1 : 0;
      var score = item.pinned ? 10 : 0;
      var tokens = tokenize(q);
      var title = String(item.title || '').toLowerCase();
      var summary = String(item.summary || '').toLowerCase();
      var content = String(item.content || '').toLowerCase();
      var tags = (item.tags || []).join(' ').toLowerCase();
      // A Skill summary is its frontmatter applicability contract. Treating it
      // like an ordinary knowledge abstract lets long generic manuals outrank
      // an explicitly matching Skill trigger.
      var summaryTokenScore = item.type === 'skill' ? 72 : 14;
      if (title.indexOf(q) !== -1) score += 80;
      if (summary.indexOf(q) !== -1) score += 45;
      if (content.indexOf(q) !== -1) score += 18;
      tokens.forEach(function (token) {
        if (title.indexOf(token) !== -1) score += 28;
        if (tags.indexOf(token) !== -1) score += 24;
        if (summary.indexOf(token) !== -1) score += summaryTokenScore;
        if (content.indexOf(token) !== -1) score += 5;
      });
      return score;
    }

    function itemMatchesQuery(item, query) {
      var q = normalizeQuery(query).value.toLowerCase();
      if (!q) return true;
      var text = itemText(item);
      if (text.indexOf(q) !== -1) return true;
      var tokens = tokenize(q);
      if (!tokens.length) return false;
      return tokens.some(function (token) { return text.indexOf(token) !== -1; });
    }

    function compareKnowledgeEntries(a, b) {
      var itemA = a && a.item ? a.item : a;
      var itemB = b && b.item ? b.item : b;
      var as = a && a.item ? Number(a.score || 0) : 0;
      var bs = b && b.item ? Number(b.score || 0) : 0;
      if (bs !== as) return bs - as;
      if (!!itemA.pinned !== !!itemB.pinned) return itemA.pinned ? -1 : 1;
      var ap = sourcePriorityTier(itemA);
      var bp = sourcePriorityTier(itemB);
      if (ap !== bp) return ap - bp;
      return Number(itemB.updatedAt || 0) - Number(itemA.updatedAt || 0);
    }

    function filterByArgs(items, args) {
      args = args || {};
      var type = String(args.type || args.knowledgeType || '').trim();
      var requestedSource = args.sourceKind ? normalizeSourceKind(args.sourceKind) : '';
      return (items || []).filter(function (item) {
        if (!args.includeArchived && item.archived) return false;
        var itemSource = normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type);
        var verificationState = normalizeVerificationState(item.verificationState, itemSource);
        if (!args.includeStale && (verificationState === 'stale' || verificationState === 'rejected')) return false;
        if (type && type !== 'all' && item.type !== type) return false;
        if (requestedSource && itemSource !== requestedSource) return false;
        return true;
      });
    }

    function compactItem(item, score) {
      var sourceKind = item.sourceKind || normalizeSourceKind(item.source && item.source.kind, item.type);
      return {
        id: item.id,
        type: item.type,
        typeLabel: typeLabels[item.type] || item.type,
        sourceKind: sourceKind,
        sourceLabel: item.sourceLabel || sourceLabels[sourceKind] || sourceKind || '',
        priorityTier: sourcePriorityTier(item),
        title: item.title,
        summary: item.summary,
        tags: item.tags || [],
        source: item.source || {},
        confidence: item.confidence,
        retrieval: item.retrieval === 'grep' ? 'grep' : undefined,
        skillResourceCount: Array.isArray(item.skillResources) ? item.skillResources.length : undefined,
        useCount: item.useCount,
        pinned: !!item.pinned,
        archived: !!item.archived,
        builtIn: !!item.builtIn,
        protected: !!item.protected,
        captureMoment: item.captureMoment || '',
        captureCount: Math.max(0, Number(item.captureCount) || 0),
        lastCapturedAt: Number(item.lastCapturedAt) || 0,
        firstCapturedTopicId: item.firstCapturedTopicId || '',
        lastCapturedTopicId: item.lastCapturedTopicId || '',
        knowledgeFingerprint: item.knowledgeFingerprint || '',
        decisionReason: item.decisionReason || '',
        verificationState: item.verificationState || '',
        evidenceSource: item.evidenceSource || '',
        reuseSuccessCount: Math.max(0, Number(item.reuseSuccessCount) || 0),
        reuseFailureCount: Math.max(0, Number(item.reuseFailureCount) || 0),
        reuseInconclusiveCount: Math.max(0, Number(item.reuseInconclusiveCount) || 0),
        corroborationTopicIds: item.corroborationTopicIds || [],
        evidenceRefs: item.evidenceRefs || [],
        lastReuseOutcome: item.lastReuseOutcome || '',
        lastReuseReason: item.lastReuseReason || '',
        lastReuseAt: Number(item.lastReuseAt) || 0,
        lastVerifiedAt: Number(item.lastVerifiedAt) || 0,
        staleAt: Number(item.staleAt) || 0,
        staleReason: item.staleReason || '',
        reviewedAt: Number(item.reviewedAt) || 0,
        reviewedBy: item.reviewedBy || '',
        reviewReason: item.reviewReason || '',
        dependencies: item.dependencies || [],
        dependencyStatus: item.dependencyStatus || '',
        dependencyInvalidations: item.dependencyInvalidations || [],
        lastDependencyCheckedAt: Number(item.lastDependencyCheckedAt) || 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastUsedAt: item.lastUsedAt || 0,
        score: score || 0,
      };
    }

    function paginate(items, args) {
      args = args || {};
      var cursor = finiteInteger(args.cursor, 0, items.length, 0, false);
      var limit = finiteInteger(args.limit, 1, 120, 30, true);
      return {
        cursor: cursor,
        limit: limit,
        total: items.length,
        nextCursor: cursor + limit < items.length ? cursor + limit : null,
        items: items.slice(cursor, cursor + limit),
      };
    }

    function orderedItems(state) {
      state = state || {};
      var itemMap = state.items || {};
      return (state.order || []).map(function (id) { return itemMap[id]; }).filter(Boolean);
    }

    function stableCountMap(items, selector) {
      var counts = Object.create(null);
      items.forEach(function (item) {
        var key = String(selector(item) || '').trim();
        if (key) counts[key] = (counts[key] || 0) + 1;
      });
      var output = {};
      Object.keys(counts).sort().forEach(function (key) { output[key] = counts[key]; });
      return output;
    }

    function catalogCounts(items) {
      return {
        bySourceKind: stableCountMap(items, function (item) {
          return item.sourceKind || normalizeSourceKind(item.source && item.source.kind, item.type);
        }),
        byType: stableCountMap(items, function (item) { return item.type; }),
      };
    }

    function snippetFor(item, query, contextChars) {
      var text = [item.summary, item.content].filter(Boolean).join('\n\n');
      var lower = text.toLowerCase();
      var tokens = tokenize(normalizeQuery(query).value);
      var index = -1;
      for (var i = 0; i < tokens.length; i++) {
        index = lower.indexOf(tokens[i]);
        if (index !== -1) break;
      }
      if (index === -1) index = 0;
      var size = finiteInteger(contextChars, 60, 600, 180, true);
      var start = Math.max(0, index - Math.floor(size / 2));
      var end = Math.min(text.length, start + size);
      return (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '');
    }

    function list(state, args) {
      var items = filterByArgs(orderedItems(state), args).sort(compareKnowledgeEntries);
      var page = paginate(items.map(function (item) { return compactItem(item); }), args);
      return {
        provider: 'built-in-knowledge',
        settings: state.settings,
        typeLabels: typeLabels,
        sourceLabels: sourceLabels,
        priorityRule: priorityRule,
        total: page.total,
        counts: catalogCounts(items),
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        items: page.items,
      };
    }

    function search(state, args) {
      args = args || {};
      var queryInfo = normalizeQuery(args.query);
      var query = queryInfo.value;
      var scored = filterByArgs(orderedItems(state), args).map(function (item) {
        return { item: item, score: scoreItem(item, query) };
      }).filter(function (entry) {
        return query ? itemMatchesQuery(entry.item, query) : true;
      }).sort(compareKnowledgeEntries);
      var page = paginate(scored, args);
      return {
        provider: 'built-in-knowledge',
        mode: 'ranked-search',
        query: query,
        queryTruncated: queryInfo.truncated,
        priorityRule: priorityRule,
        total: scored.length,
        counts: catalogCounts(scored.map(function (entry) { return entry.item; })),
        cursor: page.cursor,
        nextCursor: page.nextCursor,
        matches: page.items.map(function (entry) {
          var compacted = compactItem(entry.item, entry.score);
          compacted.snippet = snippetFor(entry.item, query, args.contextChars);
          return compacted;
        }),
      };
    }

    function grepLine(lines, index, kind, maxLineLength) {
      var line = String(lines[index] || '');
      return {
        line: index + 1,
        kind: kind,
        content: line.length > maxLineLength ? line.slice(0, maxLineLength) + '...' : line.trim(),
      };
    }

    function grep(state, args) {
      args = args || {};
      var pattern = String(args.pattern || args.query || '').trim();
      if (!pattern) throw new Error('grep_knowledge 需要 pattern');
      var fixedStrings = args.fixedStrings === true;
      if (fixedStrings && pattern.length > MAX_FIXED_PATTERN_CHARS) {
        throw new Error('grep pattern exceeds 4096 characters (fixed string limit)');
      }
      if (!fixedStrings && pattern.length > MAX_REGEX_PATTERN_CHARS) {
        throw new Error('grep regex pattern exceeds 256 characters');
      }

      var regexPattern = fixedStrings ? escapeRegExp(pattern) : pattern;
      if (!fixedStrings) {
        var complexityReason = regexComplexityReason(pattern);
        if (complexityReason) throw new Error('grep regex complexity rejected: ' + complexityReason);
      }
      var regex;
      try {
        regex = new RegExp(regexPattern, args.caseSensitive ? '' : 'i');
      } catch (err) {
        throw new Error('无效 grep 正则: ' + (err && err.message || String(err)));
      }
      function lineMatches(line) {
        regex.lastIndex = 0;
        return regex.test(line);
      }

      var maxLineLength = finiteInteger(args.maxLineLength, 80, 2000, 500, true);
      var limit = finiteInteger(args.limit, 1, 300, 80, true);
      var perItemLimit = finiteInteger(args.perItemLimit, 1, 50, 5, true);
      var context = finiteInteger(args.context, 0, 20, 0, false);
      function pickContext(primary, alias) {
        var raw = primary !== undefined ? primary : (alias !== undefined ? alias : context);
        return finiteInteger(raw, 0, 20, context, false);
      }
      var beforeContext = pickContext(args.beforeContext, args.before);
      var afterContext = pickContext(args.afterContext, args.after);
      var matches = [];
      var truncated = false;
      var entries = filterByArgs(orderedItems(state), args).map(function (entry) {
        return { item: entry, score: scoreItem(entry, pattern) };
      }).sort(compareKnowledgeEntries);

      entries.some(function (entry) {
        var item = entry.item;
        var text = [
          '# ' + item.title,
          item.summary ? 'summary: ' + item.summary : '',
          item.tags && item.tags.length ? 'tags: ' + item.tags.join(', ') : '',
          'source: ' + (item.sourceKind || item.source && item.source.kind || '') + ' priority: ' + sourcePriorityTier(item),
          item.content || '',
        ].filter(Boolean).join('\n');
        var lines = text.split(/\r?\n/);
        var itemMatchCount = 0;
        for (var i = 0; i < lines.length; i++) {
          if (itemMatchCount >= perItemLimit) break;
          var line = lines[i];
          if (!lineMatches(line)) continue;
          if (matches.length >= limit) {
            truncated = true;
            return true;
          }
          var beforeLines = [];
          var afterLines = [];
          var start = Math.max(0, i - beforeContext);
          var end = Math.min(lines.length - 1, i + afterContext);
          for (var j = start; j < i; j++) beforeLines.push(grepLine(lines, j, 'before', maxLineLength));
          for (var k = i + 1; k <= end; k++) afterLines.push(grepLine(lines, k, 'after', maxLineLength));
          matches.push({
            uri: 'knowledge://' + item.id + ':' + (i + 1),
            knowledgeId: item.id,
            line: i + 1,
            title: item.title,
            type: item.type,
            sourceKind: item.sourceKind || item.source && item.source.kind || '',
            sourceLabel: item.sourceLabel || '',
            priorityTier: sourcePriorityTier(item),
            updatedAt: item.updatedAt,
            content: line.length > maxLineLength ? line.slice(0, maxLineLength) + '...' : line.trim(),
            before: beforeLines,
            after: afterLines,
            lines: beforeLines.concat([grepLine(lines, i, 'match', maxLineLength)], afterLines),
          });
          itemMatchCount += 1;
        }
        return false;
      });

      return {
        provider: 'built-in-knowledge',
        mode: 'grep',
        pattern: pattern,
        fixedStrings: fixedStrings,
        caseSensitive: args.caseSensitive === true,
        beforeContext: beforeContext,
        afterContext: afterContext,
        perItemLimit: perItemLimit,
        priorityRule: priorityRule,
        total: matches.length,
        truncated: truncated,
        matches: matches,
        next: '命中后对已知 knowledgeId 使用 GET /knowledge/{knowledgeId}；retrieval="grep" 的大条目继续使用集合 request-target GET /knowledge?mode=grep&q=<pattern>&after=20 获取具体小节。',
      };
    }

    return {
      itemText: itemText,
      tokenize: tokenize,
      scoreItem: scoreItem,
      itemMatchesQuery: itemMatchesQuery,
      compareKnowledgeEntries: compareKnowledgeEntries,
      filterByArgs: filterByArgs,
      compactItem: compactItem,
      paginate: paginate,
      orderedItems: orderedItems,
      snippetFor: snippetFor,
      list: list,
      search: search,
      grep: grep,
      escapeRegExp: escapeRegExp,
    };
  }

  return {
    create: create,
    finiteInteger: finiteInteger,
    normalizeQuery: normalizeQuery,
    escapeRegExp: escapeRegExp,
    regexComplexityReason: regexComplexityReason,
    MAX_QUERY_CHARS: MAX_QUERY_CHARS,
  };
});
