// Knowledge capture, dependency audit, reuse feedback, and review lifecycle policy.
(function attachKnowledgeLifecycle(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && value.API_VERSION === 1 && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.KnowledgeLifecycle;
  var api = isApi(existing) ? existing : factory();
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.KnowledgeLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var DEFAULT_REUSE_CORROBORATION_TOPICS = 2;
  var DEFAULT_REUSE_STALE_FAILURES = 2;
  var MODEL_KNOWLEDGE_TYPES = {
    conversation: true,
    process: true,
    experience: true,
    tool: true,
    skill: true,
    document: true,
    custom: true,
  };

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('KnowledgeLifecycle missing dependency: ' + name);
    return value;
  }

  function dictionary() {
    return Object.create(null);
  }

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, String(key), {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return value;
  }

  function create(options) {
    options = options || {};
    var update = requireFunction(options.update, 'update');
    var loadTopic = requireFunction(options.loadTopic, 'loadTopic');
    var getToolDefinitions = requireFunction(options.getToolDefinitions, 'getToolDefinitions');
    var getNodeTypes = requireFunction(options.getNodeTypes, 'getNodeTypes');
    var compactItem = requireFunction(options.compactItem, 'compactItem');
    var escapeRegExp = requireFunction(options.escapeRegExp, 'escapeRegExp');
    var compactString = requireFunction(options.compactString, 'compactString');
    var compactStringList = requireFunction(options.compactStringList, 'compactStringList');
    var splitTags = requireFunction(options.splitTags, 'splitTags');
    var trimStoredContent = requireFunction(options.trimStoredContent, 'trimStoredContent');
    var normalizeType = requireFunction(options.normalizeType, 'normalizeType');
    var normalizeSourceKind = requireFunction(options.normalizeSourceKind, 'normalizeSourceKind');
    var normalizeVerificationState = requireFunction(options.normalizeVerificationState, 'normalizeVerificationState');
    var normalizeKnowledgeDependencies = requireFunction(options.normalizeKnowledgeDependencies, 'normalizeKnowledgeDependencies');
    var normalizeSource = requireFunction(options.normalizeSource, 'normalizeSource');
    var normalizeItem = requireFunction(options.normalizeItem, 'normalizeItem');
    var nowId = requireFunction(options.nowId, 'nowId');
    var isBuiltinItem = requireFunction(options.isBuiltinItem, 'isBuiltinItem');
    var now = typeof options.now === 'function' ? options.now : Date.now;
    var sourceLabels = options.sourceLabels || { auto: '自动沉淀/维护' };
    var sourcePriority = options.sourcePriority || { auto: 2 };
    var providerName = String(options.providerName || 'built-in-knowledge');
    var reuseCorroborationTopics = Number(options.reuseCorroborationTopics);
    var reuseStaleFailures = Number(options.reuseStaleFailures);
    if (!isFinite(reuseCorroborationTopics)) reuseCorroborationTopics = DEFAULT_REUSE_CORROBORATION_TOPICS;
    if (!isFinite(reuseStaleFailures)) reuseStaleFailures = DEFAULT_REUSE_STALE_FAILURES;
    reuseCorroborationTopics = Math.max(1, Math.floor(reuseCorroborationTopics));
    reuseStaleFailures = Math.max(1, Math.floor(reuseStaleFailures));

    function normalizeCaptureText(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function simpleHash(text) {
      var str = normalizeCaptureText(text).toLowerCase();
      var hash = 2166136261;
      for (var i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return (hash >>> 0).toString(36);
    }

    function stableDependencyValue(value) {
      if (value === null || value === undefined) return null;
      if (Array.isArray(value)) return value.map(stableDependencyValue);
      if (typeof value !== 'object') return typeof value === 'function' ? String(value) : value;
      var out = dictionary();
      Object.keys(value).sort().forEach(function (key) {
        defineOwn(out, key, stableDependencyValue(value[key]));
      });
      return out;
    }

    function dependencyHash(text) {
      var str = String(text || '');
      var hash = 2166136261;
      for (var i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return (hash >>> 0).toString(36);
    }

    function knowledgeDependencyFingerprint(kind, definition) {
      var payload = kind === 'tool'
        ? {
          name: definition && definition.name || '',
          description: definition && definition.description || '',
          inputSchema: definition && definition.inputSchema || {},
        }
        : definition || {};
      try {
        return dependencyHash(JSON.stringify(stableDependencyValue(payload)));
      } catch (_) {
        return dependencyHash(String(kind || '') + ':' + String(definition && (definition.name || definition.type) || ''));
      }
    }

    function currentDependencyCatalogs() {
      var tools = getToolDefinitions();
      var nodes = getNodeTypes();
      var catalogs = {
        tool: { available: tools.length > 0, items: dictionary() },
        node: { available: nodes.length > 0, items: dictionary() },
      };
      tools.forEach(function (tool) {
        var id = String(tool && tool.name || '').trim();
        if (id) defineOwn(catalogs.tool.items, id, knowledgeDependencyFingerprint('tool', tool));
      });
      nodes.forEach(function (node) {
        var id = String(node && node.type || '').trim();
        if (id) defineOwn(catalogs.node.items, id, knowledgeDependencyFingerprint('node', node));
      });
      return catalogs;
    }

    function knowledgeTextMentionsDependency(text, id) {
      text = String(text || '');
      id = String(id || '').trim();
      if (!text || !id) return false;
      var pattern = new RegExp('(^|[^A-Za-z0-9_.-])' + escapeRegExp(id) + '(?=$|[^A-Za-z0-9_.-])', 'i');
      return pattern.test(text);
    }

    function captureDependencies(text) {
      var catalogs = currentDependencyCatalogs();
      var out = [];
      ['tool', 'node'].forEach(function (kind) {
        Object.keys(catalogs[kind].items).forEach(function (id) {
          if (out.length >= 24 || !knowledgeTextMentionsDependency(text, id)) return;
          out.push({ kind: kind, id: id, fingerprint: catalogs[kind].items[id] });
        });
      });
      return normalizeKnowledgeDependencies(out);
    }

    function auditDependencies(item, catalogs, checkedAt) {
      if (!item || normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type) !== 'auto') return item;
      var dependencies = normalizeKnowledgeDependencies(item.dependencies);
      item.dependencies = dependencies;
      if (!dependencies.length) {
        item.dependencyStatus = 'none';
        item.dependencyInvalidations = [];
        return item;
      }
      catalogs = catalogs || currentDependencyCatalogs();
      var invalid = [];
      var checked = 0;
      dependencies.forEach(function (dependency) {
        var catalog = catalogs[dependency.kind];
        if (!catalog || !catalog.available) return;
        checked += 1;
        var currentFingerprint = catalog.items[dependency.id];
        if (!currentFingerprint) {
          invalid.push('missing_' + dependency.kind + ':' + dependency.id);
          return;
        }
        if (!dependency.fingerprint) {
          dependency.fingerprint = currentFingerprint;
          return;
        }
        if (dependency.fingerprint !== currentFingerprint) {
          invalid.push('changed_' + dependency.kind + '_schema:' + dependency.id);
        }
      });
      item.lastDependencyCheckedAt = checked
        ? Math.max(0, Number(checkedAt) || now())
        : Math.max(0, Number(item.lastDependencyCheckedAt) || 0);
      if (!checked) {
        item.dependencyStatus = 'unknown';
        item.dependencyInvalidations = [];
        return item;
      }
      if (!invalid.length) {
        item.dependencyStatus = 'current';
        item.dependencyInvalidations = [];
        return item;
      }
      item.dependencyStatus = 'invalid';
      item.dependencyInvalidations = compactStringList(invalid, 12, 240);
      if (item.verificationState !== 'rejected') {
        item.verificationState = 'stale';
        item.staleAt = Math.max(0, Number(item.staleAt) || Number(checkedAt) || now());
        if (!item.staleReason || /^dependency_/.test(item.staleReason)) {
          item.staleReason = compactString('dependency_schema_changed: ' + invalid.join(', '), 320);
        }
        item.confidence = Math.min(Number(item.confidence) || 0.6, 0.35);
      }
      return item;
    }

    function auditState(state, checkedAt) {
      var catalogs = currentDependencyCatalogs();
      Object.keys(state && state.items || {}).forEach(function (id) {
        auditDependencies(state.items[id], catalogs, checkedAt);
      });
      return state;
    }

    function normalizeModelKnowledgeExtraction(input) {
      var extraction = input && input.extraction;
      if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) return null;
      var extractionKeys = Object.keys(extraction).sort();
      if (extractionKeys.join('|') !== 'action|knowledge|mergeTargetId|reason') return null;
      var action = String(extraction.action || '').trim().toLowerCase();
      if (action !== 'skip' && action !== 'create' && action !== 'merge') return null;
      var reason = compactString(String(extraction.reason || '').trim(), 500);
      var mergeTargetId = compactString(String(extraction.mergeTargetId || '').trim(), 160);
      if (!reason) return null;
      if (action === 'skip') {
        return !mergeTargetId && extraction.knowledge === null ? { action: action, reason: reason } : null;
      }
      if ((action === 'create' && mergeTargetId) || (action === 'merge' && !mergeTargetId)) return null;
      var knowledge = extraction.knowledge;
      if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) return null;
      var knowledgeKeys = Object.keys(knowledge).sort();
      if (knowledgeKeys.join('|') !== 'content|summary|tags|title|type') return null;
      var title = compactString(String(knowledge.title || '').trim(), 120);
      var summary = compactString(String(knowledge.summary || '').trim(), 800);
      var content = trimStoredContent(String(knowledge.content || '').trim());
      var type = String(knowledge.type || '').trim();
      if (!title || !summary || !content || !hasOwn(MODEL_KNOWLEDGE_TYPES, type)
          || !Array.isArray(knowledge.tags)
          || knowledge.tags.some(function (tag) { return typeof tag !== 'string' || !tag.trim(); })) return null;
      return {
        action: action,
        mergeTargetId: mergeTargetId,
        reason: reason,
        title: title,
        summary: summary,
        content: content,
        type: type,
        tags: splitTags(knowledge.tags || []),
      };
    }

    function buildAutoCaptureCandidate(input, topic, assistant) {
      var extracted = normalizeModelKnowledgeExtraction(input);
      if (!extracted || extracted.action === 'skip') return extracted;
      var fingerprint = simpleHash([
        extracted.type,
        extracted.title,
        extracted.summary,
        extracted.content,
        extracted.tags.slice().sort().join('\n'),
      ].join('\n'));
      return {
        action: extracted.action,
        mergeTargetId: extracted.mergeTargetId,
        type: extracted.type,
        title: extracted.title,
        summary: extracted.summary,
        content: extracted.content,
        tags: extracted.tags,
        source: {
          kind: 'auto',
          key: 'auto-capture:llm:' + fingerprint,
          topicId: String(topic && topic.topicId || input.topicId || '').trim(),
          assistantId: String(assistant && assistant.id || topic && topic.assistantId || '').trim(),
          uri: 'topic://' + String(topic && topic.topicId || input.topicId || '').trim(),
        },
        sourceKind: 'auto',
        captureMoment: input.captureMoment || 'model_api_turn_completed',
        confidence: 0.6,
        knowledgeFingerprint: fingerprint,
        decisionReason: extracted.reason,
        verificationState: 'unverified',
        evidenceSource: 'model_knowledge_decision_from_completed_turn',
        dependencies: captureDependencies([extracted.title, extracted.summary, extracted.content].join('\n')),
        firstCapturedTopicId: String(topic && topic.topicId || input.topicId || '').trim(),
        lastCapturedTopicId: String(topic && topic.topicId || input.topicId || '').trim(),
      };
    }

    function findExactAutoKnowledgeItem(state, candidate) {
      var found = null;
      Object.keys(state && state.items || {}).some(function (id) {
        var item = state.items[id];
        if (!item || item.archived || isBuiltinItem(item)
            || normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type) !== 'auto') return false;
        if (candidate.knowledgeFingerprint && item.knowledgeFingerprint === candidate.knowledgeFingerprint) {
          found = item;
          return true;
        }
        return false;
      });
      return found;
    }

    function reusableKnowledgeContentChanged(before, after) {
      before = before || {};
      after = after || {};
      return JSON.stringify({
        type: normalizeType(before.type),
        title: String(before.title || ''),
        summary: String(before.summary || ''),
        content: String(before.content || ''),
        tags: splitTags(before.tags),
      }) !== JSON.stringify({
        type: normalizeType(after.type),
        title: String(after.title || ''),
        summary: String(after.summary || ''),
        content: String(after.content || ''),
        tags: splitTags(after.tags),
      });
    }

    function resetChangedVerification(item, previous, force) {
      if (!item || item.sourceKind !== 'auto') return item;
      var state = normalizeVerificationState(item.verificationState, 'auto');
      if (!force && !reusableKnowledgeContentChanged(previous, item)) return item;
      item.reuseSuccessCount = 0;
      item.reuseFailureCount = 0;
      item.reuseInconclusiveCount = 0;
      item.corroborationTopicIds = [];
      item.evidenceRefs = [];
      item.lastReuseOutcome = '';
      item.lastReuseReason = '';
      item.lastReuseAt = 0;
      if (state !== 'stale' && state !== 'rejected') {
        item.verificationState = 'unverified';
        item.lastVerifiedAt = 0;
        item.evidenceSource = 'knowledge_content_changed_requires_new_verification';
        item.confidence = Math.min(Number(item.confidence) || 0.6, 0.8);
      }
      return item;
    }

    function updateAutoKnowledgeItem(existing, candidate, timestamp) {
      var source = normalizeSource(existing && existing.source || candidate.source || {}, 'auto');
      source.kind = 'auto';
      source.key = source.key || candidate.source && candidate.source.key || 'auto-capture:' + candidate.knowledgeFingerprint;
      source.topicId = candidate.source && candidate.source.topicId || source.topicId || '';
      source.assistantId = candidate.source && candidate.source.assistantId || source.assistantId || '';
      source.uri = candidate.source && candidate.source.uri || source.uri || '';
      var item = normalizeItem(Object.assign({}, existing || {}, {
        id: existing && existing.id || nowId('kn'),
        type: candidate.type,
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        tags: candidate.tags,
        source: source,
        sourceKind: 'auto',
        builtIn: false,
        protected: false,
        captureCount: Math.max(0, Number(existing && existing.captureCount) || 0) + 1,
        lastCapturedAt: timestamp,
        lastCapturedTopicId: candidate.lastCapturedTopicId || source.topicId || '',
        firstCapturedTopicId: existing && existing.firstCapturedTopicId || candidate.firstCapturedTopicId || source.topicId || '',
        knowledgeFingerprint: candidate.knowledgeFingerprint,
        decisionReason: candidate.decisionReason,
        verificationState: existing && normalizeVerificationState(existing.verificationState, 'auto') || candidate.verificationState || 'unverified',
        evidenceSource: candidate.evidenceSource,
        createdAt: existing && existing.createdAt || timestamp,
        updatedAt: timestamp,
        confidence: Number(existing && existing.confidence) || Number(candidate.confidence) || 0.6,
        captureMoment: candidate.captureMoment || existing && existing.captureMoment || 'turn_completed',
      }));
      item.source.kind = 'auto';
      item.sourceKind = 'auto';
      item.sourceLabel = sourceLabels.auto;
      item.priorityTier = sourcePriority.auto;
      item.dependencies = captureDependencies([item.title, item.summary, item.content].filter(Boolean).join('\n'));
      item.dependencyStatus = item.dependencies.length ? 'current' : 'none';
      item.dependencyInvalidations = [];
      resetChangedVerification(item, existing, !existing);
      if (existing && existing.archived) item.archived = true;
      return item;
    }

    function editableAutoKnowledgeItem(item) {
      return !!(item
        && !item.archived
        && !isBuiltinItem(item)
        && item.builtIn !== true
        && item.protected !== true
        && normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type) === 'auto');
    }

    function mergeCandidateIdSet(input) {
      var ids = dictionary();
      (Array.isArray(input && input.mergeCandidates) ? input.mergeCandidates : []).slice(0, 12).forEach(function (item) {
        var id = String(item && item.id || '').trim();
        if (id) defineOwn(ids, id, true);
      });
      return ids;
    }

    function captureConversationTurn(input) {
      input = input || {};
      var topicId = String(input.topicId || input.topic && input.topic.topicId || '').trim();
      if (!topicId) return Promise.resolve({ captured: false, reason: 'missing-topic' });
      if (input.captureViaModelApi !== true) {
        return Promise.resolve({ captured: false, reason: 'model-api-required' });
      }
      var topic = input.topic || {};
      var topicPromise;
      try { topicPromise = loadTopic(topicId, topic); } catch (_) { topicPromise = topic; }
      return Promise.resolve(topicPromise).catch(function () { return topic; }).then(function (latestTopic) {
        topic = latestTopic || topic;
        var captured = { captured: false, reason: 'disabled' };
        return update(function (state) {
          if (!state.settings.enabled || !state.settings.autoCapture) return state;
          var assistant = input.assistant || {};
          var candidate = buildAutoCaptureCandidate(input, topic, assistant);
          if (!candidate) {
            captured = {
              captured: false,
              reason: input.extraction ? 'invalid-model-decision' : 'missing-model-decision',
              topicId: topicId,
            };
            return state;
          }
          if (candidate.action === 'skip') {
            captured = { captured: false, action: 'skip', reason: candidate.reason || 'model-skip', topicId: topicId };
            return state;
          }
          var existing = null;
          if (candidate.action === 'merge') {
            var allowedMergeIds = mergeCandidateIdSet(input);
            if (!candidate.mergeTargetId || !hasOwn(allowedMergeIds, candidate.mergeTargetId)) {
              captured = { captured: false, action: 'merge', reason: 'merge-target-not-in-candidates', topicId: topicId };
              return state;
            }
            existing = state.items[candidate.mergeTargetId];
            if (!editableAutoKnowledgeItem(existing)) {
              captured = { captured: false, action: 'merge', reason: 'merge-target-not-editable', topicId: topicId };
              return state;
            }
          } else {
            existing = findExactAutoKnowledgeItem(state, candidate);
            if (existing) {
              captured = {
                captured: true,
                action: 'deduplicate',
                matchedId: existing.id,
                decisionReason: candidate.decisionReason || '',
                item: compactItem(existing),
              };
              return state;
            }
          }
          var timestamp = now();
          var item = updateAutoKnowledgeItem(existing, candidate, timestamp);
          defineOwn(state.items, item.id, item);
          state.order = [item.id].concat((state.order || []).filter(function (id) { return id !== item.id; }));
          captured = {
            captured: true,
            action: candidate.action,
            matchedId: existing && existing.id || '',
            decisionReason: item.decisionReason || candidate.decisionReason || '',
            item: compactItem(item),
          };
          return state;
        }).then(function () {
          return captured;
        });
      });
    }

    function markUsed(ids, meta) {
      ids = Array.isArray(ids) ? ids : [ids];
      var wanted = dictionary();
      ids.forEach(function (id) { if (id) defineOwn(wanted, String(id), true); });
      if (!Object.keys(wanted).length) return Promise.resolve({ used: [] });
      return update(function (state) {
        Object.keys(wanted).forEach(function (id) {
          var item = state.items[id];
          if (!item) return;
          var timestamp = now();
          item.useCount = Number(item.useCount || 0) + 1;
          item.lastUsedAt = timestamp;
          item.updatedAt = item.updatedAt || timestamp;
        });
        return state;
      }).then(function () {
        return { used: Object.keys(wanted), meta: meta || {} };
      });
    }

    function recordReuseOutcome(ids, meta) {
      if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
        meta = ids;
        ids = meta.ids;
      }
      ids = Array.isArray(ids) ? ids : [ids];
      meta = meta && typeof meta === 'object' ? meta : {};
      var wanted = dictionary();
      ids.forEach(function (id) { if (id) defineOwn(wanted, String(id), true); });
      if (!Object.keys(wanted).length) return Promise.resolve({ updated: [], skipped: true, reason: 'missing-ids' });
      var requestedOutcome = String(meta.outcome || '').trim().toLowerCase();
      var outcome = requestedOutcome === 'helpful' || requestedOutcome === 'harmful' ? requestedOutcome : 'inconclusive';
      if (outcome === 'harmful' && meta.explicitNegativeFeedback !== true) outcome = 'inconclusive';
      var topicId = compactString(String(meta.topicId || '').trim(), 120);
      var evidenceRefs = compactStringList(meta.evidenceRefs, 12, 240);
      var timestamp = now();
      var changed = [];
      return update(function (state) {
        Object.keys(wanted).forEach(function (id) {
          var item = state.items[id];
          if (!item || isBuiltinItem(item)) return;
          if (outcome === 'helpful') {
            item.reuseSuccessCount = Math.max(0, Number(item.reuseSuccessCount) || 0) + 1;
            if (meta.toolBacked === true && topicId) {
              item.corroborationTopicIds = compactStringList((item.corroborationTopicIds || []).concat([topicId]), 20, 120);
            }
            if (meta.toolBacked === true) {
              item.evidenceRefs = compactStringList((item.evidenceRefs || []).concat(evidenceRefs), 20, 240);
            }
            if (item.sourceKind === 'auto' && item.verificationState === 'unverified'
              && (item.corroborationTopicIds || []).length >= reuseCorroborationTopics) {
              item.verificationState = 'corroborated';
              item.lastVerifiedAt = timestamp;
              item.confidence = Math.min(0.9, (Number(item.confidence) || 0.55) + 0.1);
            }
          } else if (outcome === 'harmful') {
            item.reuseFailureCount = Math.max(0, Number(item.reuseFailureCount) || 0) + 1;
            item.confidence = Math.max(0.1, (Number(item.confidence) || 0.6) - 0.15);
            if (item.sourceKind === 'auto' && item.reuseFailureCount >= reuseStaleFailures) {
              item.verificationState = 'stale';
              item.staleAt = timestamp;
              item.staleReason = compactString(String(meta.reason || 'repeated_explicit_negative_reuse_feedback'), 320);
            }
          } else {
            item.reuseInconclusiveCount = Math.max(0, Number(item.reuseInconclusiveCount) || 0) + 1;
          }
          item.lastReuseOutcome = outcome;
          item.lastReuseReason = compactString(String(meta.reason || '').trim(), 320);
          item.lastReuseAt = timestamp;
          changed.push(id);
        });
        return state;
      }).then(function () {
        return { updated: changed, outcome: outcome };
      });
    }

    function reviewKnowledge(input) {
      input = input && typeof input === 'object' ? input : {};
      var id = String(input.id || input.knowledgeId || '').trim();
      if (!id) return Promise.reject(new Error('缺少知识 ID'));
      var requestedState = String(input.verificationState || input.state || '').trim().toLowerCase();
      if (['unverified', 'verified', 'stale', 'rejected'].indexOf(requestedState) === -1) {
        return Promise.reject(new Error('人工审核状态只允许 unverified、verified、stale 或 rejected'));
      }
      var reason = compactString(String(input.reason || input.reviewReason || '').trim(), 320);
      if (requestedState !== 'unverified' && !reason) {
        return Promise.reject(new Error('标记 verified、stale 或 rejected 时必须填写审核依据'));
      }
      var reviewed = null;
      var timestamp = now();
      return update(function (state) {
        var item = state.items[id];
        if (!item) throw new Error('知识不存在: ' + id);
        if (isBuiltinItem(item)) throw new Error('内置知识由代码维护，不能人工改写验证状态');
        if (normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type) !== 'auto') {
          throw new Error('只有 auto(P2) 知识支持本地人工审核；外部来源应在来源系统维护验证状态');
        }
        if (requestedState === 'verified' && item.dependencyStatus === 'invalid') {
          throw new Error('知识依赖的工具或节点 schema 已变化；请先更新知识内容和依赖，再标记 verified');
        }
        item.verificationState = requestedState;
        item.reviewedAt = timestamp;
        item.reviewedBy = 'user';
        item.reviewReason = reason;
        if (requestedState === 'verified') {
          item.lastVerifiedAt = timestamp;
          item.staleAt = 0;
          item.staleReason = '';
          item.confidence = Math.max(Number(item.confidence) || 0.6, 0.9);
        } else if (requestedState === 'stale' || requestedState === 'rejected') {
          item.staleAt = timestamp;
          item.staleReason = reason;
          item.confidence = Math.min(Number(item.confidence) || 0.6, requestedState === 'rejected' ? 0.1 : 0.35);
        } else {
          item.lastVerifiedAt = 0;
          item.staleAt = 0;
          item.staleReason = '';
          item.confidence = Math.min(Number(item.confidence) || 0.6, 0.8);
        }
        item.updatedAt = timestamp;
        reviewed = compactItem(item);
        return state;
      }).then(function () {
        return { provider: providerName, reviewed: true, item: reviewed };
      });
    }

    return {
      captureDependencies: captureDependencies,
      auditState: auditState,
      resetChangedVerification: resetChangedVerification,
      captureConversationTurn: captureConversationTurn,
      markUsed: markUsed,
      recordReuseOutcome: recordReuseOutcome,
      reviewKnowledge: reviewKnowledge,
    };
  }

  return {
    API_VERSION: API_VERSION,
    create: create,
  };
});
