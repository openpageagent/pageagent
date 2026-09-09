// Knowledge — persistence/search/lifecycle facade.
//
// Maintenance rule:
// When an ARP resource method, schema, adapter behavior, or flow node type changes,
    // update knowledge/knowledge-builtins.js and docs/Page-Agent-05-知识系统.md in the same change.
(function attachKnowledge(root, factory) {
  var searchModule = root && root.KnowledgeSearch;
  var storeModule = root && root.KnowledgeStore;
  var lifecycleModule = root && root.KnowledgeLifecycle;
  var builtinsModule = root && root.KnowledgeBuiltins;
  var toolDefinitionsModule = root && root.AgentResourceProtocol;
  var nodeTypesModule = root && root.NodeTypes;
  if (typeof module === 'object' && module.exports) {
    searchModule = searchModule || require('./knowledge-search.js');
    storeModule = storeModule || require('./knowledge-store.js');
    lifecycleModule = lifecycleModule || require('./knowledge-lifecycle.js');
    builtinsModule = builtinsModule || require('./knowledge-builtins.js');
    toolDefinitionsModule = toolDefinitionsModule || require('../resources/protocol');
    if (!nodeTypesModule) {
      require('../flows/node-types.js');
      nodeTypesModule = root && root.NodeTypes;
    }
    if (!lifecycleModule || typeof lifecycleModule.create !== 'function') {
      throw new Error('KnowledgeLifecycle must load before Knowledge');
    }
    module.exports = factory(root, searchModule, storeModule, lifecycleModule, builtinsModule, toolDefinitionsModule, nodeTypesModule);
  } else {
    if (!searchModule) throw new Error('KnowledgeSearch must load before Knowledge');
    if (!storeModule) throw new Error('KnowledgeStore must load before Knowledge');
    if (!lifecycleModule || typeof lifecycleModule.create !== 'function') {
      throw new Error('KnowledgeLifecycle must load before Knowledge');
    }
    if (!builtinsModule || builtinsModule.API_VERSION !== 1 || typeof builtinsModule.create !== 'function') {
      throw new Error('KnowledgeBuiltins must load before Knowledge');
    }
    if (!toolDefinitionsModule) throw new Error('AgentResourceProtocol must load before Knowledge');
    if (!nodeTypesModule) throw new Error('NodeTypes must load before Knowledge');
    root.Knowledge = factory(root, searchModule, storeModule, lifecycleModule, builtinsModule, toolDefinitionsModule, nodeTypesModule);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  root,
  KnowledgeSearch,
  KnowledgeStore,
  KnowledgeLifecycle,
  KnowledgeBuiltins,
  AgentResourceProtocol,
  NodeTypes
) {
  'use strict';

  if (!KnowledgeBuiltins || KnowledgeBuiltins.API_VERSION !== 1 || typeof KnowledgeBuiltins.create !== 'function') {
    throw new Error('KnowledgeBuiltins must load before Knowledge');
  }

  function ownDataDependency(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  }

  var readAgentToolDefinitions = ownDataDependency(AgentResourceProtocol, 'createToolDefinitions');
  var nodeTypeCatalog = ownDataDependency(NodeTypes, 'TYPES');
  if (typeof readAgentToolDefinitions !== 'function') {
    throw new Error('AgentResourceProtocol.createToolDefinitions must load before Knowledge');
  }
  if (!Array.isArray(nodeTypeCatalog)) {
    throw new Error('NodeTypes.TYPES must load before Knowledge');
  }

  var STORAGE_KEY = KnowledgeStore.STORAGE_KEY;
  var TYPE_LABELS = {
    conversation: '对话沉淀',
    process: '流程步骤',
    experience: '经验规则',
    tool: '工具知识',
    mcp: 'MCP 知识',
    skill: 'Skill 知识',
    document: '文档知识',
    custom: '通用知识',
  };

  var SOURCE_LABELS = {
    builtin: '内置知识',
    auto: '自动沉淀/维护',
    mcp: 'MCP',
    skill: 'Skill',
  };

  var SOURCE_PRIORITY = {
    builtin: 1,
    auto: 2,
    mcp: 3,
    skill: 4,
  };
  var KNOWLEDGE_PRIORITY_RULE = '先按与当前目标或查询的相关性排序；只有相关性接近时，才按来源优先级 builtin(P1) -> auto(P2) -> mcp(P3) -> skill(P4) 决定顺序';

  function clampNumber(value, min, max, fallback) {
    var n = Number(value);
    if (!isFinite(n)) n = fallback;
    return Math.max(min, Math.min(max, n));
  }

  function normalizeSourceKind(value, fallbackType) {
    var kind = String(value || '').trim();
    if (kind === 'conversation' || kind === 'auto-capture') return 'auto';
    if (kind === 'builtin-user' || kind === 'manual-builtin') return 'auto';
    if (kind === 'built-in') return 'builtin';
    if (kind === 'mcp-server') return 'mcp';
    if (kind === 'codex-skill' || kind === 'agent-skill') return 'skill';
    if (SOURCE_PRIORITY[kind]) return kind;
    if (fallbackType === 'mcp') return 'mcp';
    if (fallbackType === 'skill') return 'skill';
    return 'auto';
  }

  function sourcePriorityTier(itemOrKind) {
    var kind = typeof itemOrKind === 'string'
      ? normalizeSourceKind(itemOrKind)
      : normalizeSourceKind(itemOrKind && (itemOrKind.sourceKind || itemOrKind.source && itemOrKind.source.kind), itemOrKind && itemOrKind.type);
    return SOURCE_PRIORITY[kind] || SOURCE_PRIORITY.auto;
  }

  function isBuiltinItem(item) {
    return !!(item && (item.protected || item.builtIn || sourcePriorityTier(item) === SOURCE_PRIORITY.builtin));
  }

  function normalizeVerificationState(value, sourceKind) {
    var state = String(value || '').trim().toLowerCase();
    var allowed = {
      unverified: true,
      corroborated: true,
      verified: true,
      stale: true,
      rejected: true,
    };
    if (allowed[state]) return state;
    return sourceKind === 'auto' ? 'unverified' : 'verified';
  }

  var searchEngine = KnowledgeSearch.create({
    typeLabels: TYPE_LABELS,
    sourceLabels: SOURCE_LABELS,
    sourcePriority: SOURCE_PRIORITY,
    priorityRule: KNOWLEDGE_PRIORITY_RULE,
    normalizeSourceKind: normalizeSourceKind,
    normalizeVerificationState: normalizeVerificationState,
    sourcePriorityTier: sourcePriorityTier,
  });
  var compactItem = searchEngine.compactItem;

  var knowledgeStore;
  var nowId;
  var normalizeId;
  var clone;
  var compactString;
  var trimStoredContent;
  var splitTags;
  var normalizeType;
  var normalizeSettings;
  var normalizeSource;
  var compactStringList;
  var normalizeKnowledgeDependencies;
  var normalizeItem;
  var ensureState;
  var load;
  var save;
  var update;
  var getCachedState;

  var builtinKnowledge = KnowledgeBuiltins.create({
    getToolDefinitions: function () { return readAgentToolDefinitions.call(AgentResourceProtocol); },
    getNodeTypes: function () { return nodeTypeCatalog; },
  });

  var knowledgeLifecycle = KnowledgeLifecycle.create({
    update: function (mutator) { return update(mutator); },
    loadTopic: function (topicId, fallbackTopic) {
      if (!root.ConversationState || typeof root.ConversationState.load !== 'function') {
        return Promise.resolve(fallbackTopic);
      }
      return root.ConversationState.load().then(function (conversationState) {
        return conversationState && conversationState.topics && conversationState.topics[topicId] || fallbackTopic;
      }).catch(function () { return fallbackTopic; });
    },
    getToolDefinitions: builtinKnowledge.getToolDefinitions,
    getNodeTypes: builtinKnowledge.getNodeTypes,
    compactItem: compactItem,
    escapeRegExp: searchEngine.escapeRegExp,
    compactString: function (value, max) { return compactString(value, max); },
    compactStringList: function (value, maxItems, maxChars) { return compactStringList(value, maxItems, maxChars); },
    splitTags: function (value) { return splitTags(value); },
    trimStoredContent: function (value) { return trimStoredContent(value); },
    normalizeType: function (value) { return normalizeType(value); },
    normalizeSourceKind: normalizeSourceKind,
    normalizeVerificationState: normalizeVerificationState,
    normalizeKnowledgeDependencies: function (value) { return normalizeKnowledgeDependencies(value); },
    normalizeSource: function (value, fallbackKind) { return normalizeSource(value, fallbackKind); },
    normalizeItem: function (value, fallbackId) { return normalizeItem(value, fallbackId); },
    nowId: function (prefix) { return nowId(prefix); },
    isBuiltinItem: isBuiltinItem,
    sourceLabels: SOURCE_LABELS,
    sourcePriority: SOURCE_PRIORITY,
  });

  knowledgeStore = KnowledgeStore.create({
    root: root,
    storageKey: STORAGE_KEY,
    version: KnowledgeStore.STATE_VERSION,
    maxContentChars: 1000000,
    typeLabels: TYPE_LABELS,
    sourceLabels: SOURCE_LABELS,
    normalizeSourceKind: normalizeSourceKind,
    sourcePriorityTier: sourcePriorityTier,
    normalizeVerificationState: normalizeVerificationState,
    builtinItems: builtinKnowledge.buildItems,
    captureDependencies: knowledgeLifecycle.captureDependencies,
    auditState: knowledgeLifecycle.auditState,
  });
  nowId = knowledgeStore.nowId;
  normalizeId = knowledgeStore.normalizeId;
  clone = knowledgeStore.clone;
  compactString = knowledgeStore.compactString;
  trimStoredContent = knowledgeStore.trimStoredContent;
  splitTags = knowledgeStore.splitTags;
  normalizeType = knowledgeStore.normalizeType;
  normalizeSettings = knowledgeStore.normalizeSettings;
  normalizeSource = knowledgeStore.normalizeSource;
  compactStringList = knowledgeStore.compactStringList;
  normalizeKnowledgeDependencies = knowledgeStore.normalizeKnowledgeDependencies;
  normalizeItem = knowledgeStore.normalizeItem;
  ensureState = knowledgeStore.ensureState;
  load = knowledgeStore.load;
  save = knowledgeStore.save;
  update = knowledgeStore.update;
  getCachedState = knowledgeStore.getCachedState;

  var captureKnowledgeDependencies = knowledgeLifecycle.captureDependencies;
  var resetChangedAutoKnowledgeVerification = knowledgeLifecycle.resetChangedVerification;
  var captureConversationTurn = knowledgeLifecycle.captureConversationTurn;
  var markUsed = knowledgeLifecycle.markUsed;
  var recordReuseOutcome = knowledgeLifecycle.recordReuseOutcome;
  var reviewKnowledge = knowledgeLifecycle.reviewKnowledge;

  function isSkillImportWrite(args, sourceInput) {
    args = args || {};
    sourceInput = sourceInput && typeof sourceInput === 'object' ? sourceInput : {};
    var key = String(args.sourceKey || sourceInput.key || sourceInput.sourceKey || '').trim();
    return args.skillImport === true
      && sourceInput.importer === 'skill-knowledge'
      && /^skill-import:[^:]+(?::resource:.+)?$/.test(key);
  }

  function list(args) {
    return load().then(function (state) {
      return searchEngine.list(state, args);
    });
  }

  function search(args) {
    return load().then(function (state) {
      return searchEngine.search(state, args);
    });
  }

  function grep(args) {
    return load().then(function (state) {
      return searchEngine.grep(state, args);
    });
  }

  function get(args) {
    args = args || {};
    var id = String(args.id || args.knowledgeId || '').trim();
    if (!id) return Promise.reject(new Error('缺少知识 ID'));
    return load().then(function (state) {
      var item = state.items[id];
      if (!item) throw new Error('知识不存在: ' + id);
      return {
        provider: 'built-in-knowledge',
        item: clone(item),
      };
    });
  }

  function getMany(args) {
    args = args || {};
    var seen = Object.create(null);
    var ids = (Array.isArray(args.ids) ? args.ids : []).map(function (id) {
      return String(id || '').trim();
    }).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).slice(0, 24);
    return load().then(function (state) {
      return {
        provider: 'built-in-knowledge',
        items: ids.map(function (id) { return state.items[id]; }).filter(Boolean).map(clone),
        missing: ids.filter(function (id) { return !state.items[id]; }),
      };
    });
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function mergeAppendText(current, incoming) {
    var left = String(current || '').trim();
    var right = String(incoming || '').trim();
    if (!right) return left;
    if (!left) return right;
    return left + '\n\n' + right;
  }

  function findAutoOverride(state, sourceId) {
    var key = 'manual-override:' + sourceId;
    var found = null;
    Object.keys(state.items || {}).some(function (id) {
      var item = state.items[id];
      var kind = item && normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type);
      if (kind === 'auto' && item.source && item.source.key === key) {
        found = item;
        return true;
      }
      return false;
    });
    return found;
  }

  function findAutoBySourceKey(state, sourceKey) {
    var key = String(sourceKey || '').trim();
    if (!key) return null;
    var found = null;
    Object.keys(state.items || {}).some(function (id) {
      var item = state.items[id];
      var kind = item && normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type);
      if (kind === 'auto' && item.source && item.source.key === key) {
        found = item;
        return true;
      }
      return false;
    });
    return found;
  }

  function saveAuto(args) {
    args = args || {};
    var savedId = '';
    var copiedFrom = '';
    return update(function (state) {
      var targetId = normalizeId(args.id || args.knowledgeId);
      var sourceKnowledgeId = normalizeId(args.sourceKnowledgeId || args.baseKnowledgeId || args.fromKnowledgeId);
      var target = targetId ? state.items[targetId] : null;
      var sourceItem = sourceKnowledgeId ? state.items[sourceKnowledgeId] : null;
      if (isBuiltinItem(target)) {
        throw new Error('内置知识只允许查看，不能通过对话式工具编辑: ' + target.id);
      }
      if (isBuiltinItem(sourceItem)) {
        throw new Error('内置知识只允许查看，不能复制为可编辑知识: ' + sourceItem.id);
      }
      var sourceItemKind = sourceItem && normalizeSourceKind(sourceItem.sourceKind || sourceItem.source && sourceItem.source.kind, sourceItem.type);
      var initialTargetKind = target && normalizeSourceKind(target.sourceKind || target.source && target.source.kind, target.type);
      var sourceBase = null;
      if (target && initialTargetKind !== 'auto') sourceBase = target;
      if (!sourceBase && sourceItem && sourceItemKind !== 'auto') sourceBase = sourceItem;
      if (sourceBase) copiedFrom = sourceBase.id;
      if (sourceBase && (!target || initialTargetKind !== 'auto')) {
        var existingOverride = findAutoOverride(state, sourceBase.id);
        if (existingOverride) target = existingOverride;
      }
      if (!target && sourceItem && sourceItemKind === 'auto') target = sourceItem;
      var targetKind = target && normalizeSourceKind(target.sourceKind || target.source && target.source.kind, target.type);
      var targetIsAuto = target && targetKind === 'auto';
      var base = targetIsAuto ? target : (sourceItem || target || null);
      var baseKind = base && normalizeSourceKind(base.sourceKind || base.source && base.source.kind, base.type);
      var copySource = !!(base && baseKind && baseKind !== 'auto');
      if (copySource) copiedFrom = base.id;
      if (!targetIsAuto && !base) {
        var newTitle = String(args.title || '').trim();
        var newBody = String(args.content || args.summary || '').trim();
        if (!newTitle || !newBody) {
          throw new Error('新增 auto(P2) 知识需要 title 和 content/summary');
        }
      }
      var now = Date.now();
      var preserveTimestamps = args.preserveTimestamps === true || args.restore === true;
      var mode = String(args.mergeMode || args.mode || 'replace').trim();
      var sourceInput = args.source && typeof args.source === 'object' ? args.source : {};
      var sourceKey = String(args.sourceKey || sourceInput.key || '').trim();
      var source = targetIsAuto
        ? normalizeSource(Object.assign({}, target.source || {}, sourceInput, {
          kind: 'auto',
          key: sourceKey || target.source && target.source.key || '',
        }), 'auto')
        : normalizeSource({
          kind: 'auto',
          key: sourceKey || (copySource ? 'manual-override:' + base.id : ''),
          uri: sourceInput.uri || base && base.source && base.source.uri || (copySource ? 'knowledge://' + base.id : ''),
          topicId: sourceInput.topicId || args.topicId || '',
          assistantId: sourceInput.assistantId || args.assistantId || '',
          toolName: sourceInput.toolName || '',
        }, 'auto');
      if (!target && source.key) {
        var existingAutoBySourceKey = findAutoBySourceKey(state, source.key);
        if (existingAutoBySourceKey) target = existingAutoBySourceKey;
      }
      targetKind = target && normalizeSourceKind(target.sourceKind || target.source && target.source.kind, target.type);
      targetIsAuto = target && targetKind === 'auto';
      base = targetIsAuto ? target : (sourceItem || target || null);
      baseKind = base && normalizeSourceKind(base.sourceKind || base.source && base.source.kind, base.type);
      copySource = !!(base && baseKind && baseKind !== 'auto');
      if (copySource) copiedFrom = base.id;
      var patch = {};
      ['type', 'title', 'summary', 'content', 'tags', 'pinned', 'archived', 'captureMoment', 'confidence'].forEach(function (key) {
        if (hasOwn(args, key)) patch[key] = args[key];
      });
      if (mode === 'append' && base) {
        if (hasOwn(args, 'summary')) patch.summary = mergeAppendText(base.summary, args.summary);
        if (hasOwn(args, 'content')) patch.content = mergeAppendText(base.content, args.content);
        if (hasOwn(args, 'tags')) patch.tags = splitTags((base.tags || []).concat(splitTags(args.tags)));
      }
      var itemId = targetIsAuto
        ? target.id
        : (targetId && !target ? targetId : nowId('kn'));
      var item = normalizeItem(Object.assign({}, base || {}, patch, {
        id: itemId,
        source: source,
        sourceKind: 'auto',
        builtIn: false,
        protected: false,
        createdAt: preserveTimestamps
          ? Number(args.createdAt) || (targetIsAuto && target && target.createdAt) || now
          : (targetIsAuto ? target.createdAt : now),
        updatedAt: preserveTimestamps
          ? Number(args.updatedAt) || (targetIsAuto && target && target.updatedAt) || now
          : now,
      }));
      item.dependencies = captureKnowledgeDependencies([item.title, item.summary, item.content].filter(Boolean).join('\n'));
      item.dependencyStatus = item.dependencies.length ? 'current' : 'none';
      item.dependencyInvalidations = [];
      if (!preserveTimestamps) resetChangedAutoKnowledgeVerification(item, targetIsAuto ? base : null, !targetIsAuto);
      item.source.kind = 'auto';
      item.sourceKind = 'auto';
      item.sourceLabel = SOURCE_LABELS.auto;
      item.priorityTier = SOURCE_PRIORITY.auto;
      state.items[item.id] = item;
      savedId = item.id;
      state.order = [item.id].concat((state.order || []).filter(function (id) { return id !== item.id; }));
      return state;
    }).then(function (state) {
      var item = savedId && state.items[savedId] || null;
      return {
        provider: 'built-in-knowledge',
        mode: 'save-auto',
        priorityRule: '仅限 auto(P2)',
        copiedFrom: copiedFrom,
        item: item ? clone(item) : null,
      };
    });
  }

  function upsert(args) {
    args = args || {};
    var savedId = '';
    return update(function (state) {
      var preserveTimestamps = args.preserveTimestamps === true || args.restore === true;
      var requestedId = normalizeId(args.id);
      var existing = requestedId ? state.items[requestedId] : null;
      if (isBuiltinItem(existing)) {
        throw new Error('内置知识只允许查看，不能编辑: ' + existing.id);
      }
      var requestedKind = normalizeSourceKind(args.sourceKind || args.source && args.source.kind);
      var sourceInput = args.source && typeof args.source === 'object' ? args.source : {};
      var migratedSync = Object.keys(sourceInput).some(function (key) {
        return key !== 'remoteSync' && /Sync$/.test(key) && sourceInput[key] === true;
      });
      var allowMcpRemoteSource = requestedKind === 'mcp'
        && (args.remoteSync === true || sourceInput.remoteSync === true || sourceInput.sync === true
          || migratedSync || !!sourceInput.managed);
      var allowSkillImport = requestedKind === 'skill' && isSkillImportWrite(args, sourceInput);
      var allowManagedSource = allowMcpRemoteSource || allowSkillImport;
      if (requestedKind === 'builtin') {
        args = Object.assign({}, args, {
          sourceKind: 'auto',
          source: Object.assign({}, args.source || {}, { kind: 'auto' }),
        });
      } else if (requestedKind === 'skill' && !allowSkillImport) {
        throw new Error('Skill(P4) 只能由扩展内置 Skill 加载器或知识界面的 Skill 导入器写入；对话或 MCP 工具生成的流程知识请保存为 auto(P2)');
      } else if (requestedKind === 'mcp' && !allowManagedSource) {
        args = Object.assign({}, args, {
          sourceKind: 'auto',
          source: Object.assign({}, args.source || {}, { kind: 'auto' }),
        });
      }
      var source = normalizeSource(args.source || existing && existing.source || {}, args.sourceKind);
      if (args.sourceKey && !source.key) source.key = String(args.sourceKey || '').trim();
      if (source.key && !existing) {
        Object.keys(state.items).some(function (id) {
          var item = state.items[id];
          var itemKind = normalizeSourceKind(item && (item.sourceKind || item.source && item.source.kind), item && item.type);
          if (item && item.source && item.source.key === source.key && itemKind === source.kind) {
            existing = item;
            return true;
          }
          return false;
        });
      }
      if (isBuiltinItem(existing)) {
        throw new Error('内置知识只允许查看，不能编辑: ' + existing.id);
      }
      var existingKind = existing && normalizeSourceKind(existing.sourceKind || existing.source && existing.source.kind, existing.type);
      var editingManagedSourceWithoutSync = existing && (existingKind === 'mcp' || existingKind === 'skill') && !allowManagedSource;
      if (editingManagedSourceWithoutSync) {
        if (existingKind === 'skill') {
          throw new Error('Skill(P4) 导入条目不能通过通用 upsert 覆盖；请重新导入 Skill，或保存为 auto(P2) 维护副本');
        }
        source = normalizeSource({
          kind: 'auto',
          key: 'manual-override:' + existing.id,
          uri: existing.source && existing.source.uri || '',
        }, 'auto');
        args = Object.assign({}, args, {
          id: undefined,
          sourceKind: 'auto',
          source: source,
        });
        existing = null;
      } else if ((source.kind === 'mcp' || source.kind === 'skill') && !allowManagedSource) {
        source.kind = 'auto';
      }
      var now = Date.now();
      var item = normalizeItem(Object.assign({}, existing || {}, args, {
        id: existing && existing.id || normalizeId(args.id) || nowId('kn'),
        source: source,
        sourceKind: source.kind,
        createdAt: preserveTimestamps
          ? Number(args.createdAt) || (existing && existing.createdAt) || now
          : (existing && existing.createdAt || args.createdAt || now),
        updatedAt: preserveTimestamps
          ? Number(args.updatedAt) || (existing && existing.updatedAt) || now
          : now,
      }));
      if (source.kind === 'auto' && !preserveTimestamps) {
        item.dependencies = captureKnowledgeDependencies([item.title, item.summary, item.content].filter(Boolean).join('\n'));
        item.dependencyStatus = item.dependencies.length ? 'current' : 'none';
        item.dependencyInvalidations = [];
        resetChangedAutoKnowledgeVerification(item, existing, !existing);
      }
      state.items[item.id] = item;
      savedId = item.id;
      state.order = [item.id].concat((state.order || []).filter(function (id) { return id !== item.id; }));
      return state;
    }).then(function (state) {
      var id = savedId || normalizeId(args.id) || '';
      var item = id && state.items[id] || null;
      if (!item && args.sourceKey) {
        Object.keys(state.items).some(function (itemId) {
          if (state.items[itemId] && state.items[itemId].source && state.items[itemId].source.key === args.sourceKey) {
            item = state.items[itemId];
            return true;
          }
          return false;
        });
      }
      return { provider: 'built-in-knowledge', item: item ? clone(item) : null };
    });
  }

  function syncBuiltinSkillCatalog(args) {
    args = args || {};
    var packages = Array.isArray(args.packages) ? args.packages : [];
    var synced = 0;
    var removed = 0;
    return update(function (state) {
      var activeIds = Object.create(null);
      var activeKeys = Object.create(null);
      var activeOrder = [];
      var packageKeys = Object.create(null);

      packages.forEach(function (pkg, packageIndex) {
        pkg = pkg && typeof pkg === 'object' ? pkg : {};
        var sourceKey = String(pkg.sourceKey || '').trim();
        if (!/^skill-builtin:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(sourceKey)) {
          throw new Error('无效内置 Skill sourceKey: ' + sourceKey);
        }
        if (packageKeys[sourceKey]) throw new Error('重复内置 Skill sourceKey: ' + sourceKey);
        packageKeys[sourceKey] = true;
        var rawItems = Array.isArray(pkg.items) ? pkg.items : [];
        if (!rawItems.length) throw new Error('内置 Skill 没有知识条目: ' + sourceKey);
        var hasMain = false;

        rawItems.forEach(function (raw, itemIndex) {
          raw = raw && typeof raw === 'object' ? raw : {};
          var id = normalizeId(raw.id);
          var rawSource = raw.source && typeof raw.source === 'object' ? raw.source : {};
          var itemKey = String(rawSource.key || '').trim();
          if (!id || id === '__proto__' || id === 'prototype' || id === 'constructor') {
            throw new Error('内置 Skill 知识 ID 无效: package=' + packageIndex + ', item=' + itemIndex);
          }
          if (itemKey === sourceKey) hasMain = true;
          if (itemKey !== sourceKey && itemKey.indexOf(sourceKey + ':resource:') !== 0) {
            throw new Error('内置 Skill 资源越界: ' + itemKey);
          }
          if (activeIds[id]) throw new Error('重复内置 Skill 知识 ID: ' + id);
          if (activeKeys[itemKey]) throw new Error('重复内置 Skill 知识 key: ' + itemKey);

          var existing = state.items[id];
          var existingSource = existing && existing.source || {};
          if (existing && existingSource.importer !== 'builtin-skill-loader') {
            throw new Error('内置 Skill 知识 ID 与现有条目冲突: ' + id);
          }
          var source = normalizeSource(Object.assign({}, rawSource, {
            kind: 'skill',
            key: itemKey,
            remoteSync: true,
            managed: 'builtin',
            importer: 'builtin-skill-loader',
          }), 'skill');
          var item = normalizeItem(Object.assign({}, existing || {}, raw, {
            id: id,
            type: 'skill',
            sourceKind: 'skill',
            source: source,
            skillImport: true,
            builtinSkill: true,
            archived: false,
            builtIn: true,
            protected: true,
            createdAt: Number(raw.createdAt) || existing && existing.createdAt || 1,
            updatedAt: Number(raw.updatedAt) || 1,
          }));
          state.items[id] = item;
          activeIds[id] = true;
          activeKeys[itemKey] = true;
          activeOrder.push(id);
          synced += 1;
        });
        if (!hasMain) throw new Error('内置 Skill 缺少主知识条目: ' + sourceKey);
      });

      Object.keys(state.items || {}).forEach(function (id) {
        var item = state.items[id];
        var source = item && item.source || {};
        if (source.importer !== 'builtin-skill-loader' || String(source.key || '').indexOf('skill-builtin:') !== 0) return;
        if (activeIds[id]) return;
        delete state.items[id];
        removed += 1;
      });
      state.order = activeOrder.concat((state.order || []).filter(function (id) {
        return !activeIds[id] && !!state.items[id];
      }));
      return state;
    }).then(function () {
      return {
        provider: 'built-in-knowledge',
        ok: true,
        packages: packages.length,
        synced: synced,
        removed: removed,
      };
    });
  }

  function remove(args) {
    args = args || {};
    var id = String(args.id || args.knowledgeId || '').trim();
    if (!id) return Promise.reject(new Error('缺少知识 ID'));
    return update(function (state) {
      if (!state.items[id]) throw new Error('知识不存在: ' + id);
      if (isBuiltinItem(state.items[id])) throw new Error('内置系统知识不能删除: ' + id);
      var kind = normalizeSourceKind(state.items[id].sourceKind || state.items[id].source && state.items[id].source.kind, state.items[id].type);
      if (kind === 'skill') throw new Error('Skill(P4) 导入知识不能单条删除；请使用 Skill 卡片归档或删除整个导入');
      if (kind === 'mcp') throw new Error('MCP(P3) 同步知识不能单条删除；请通过对应 MCP 配置同步、归档或删除');
      if (kind !== 'auto') throw new Error('只有 auto(P2) 知识允许通用删除: ' + id);
      delete state.items[id];
      state.order = (state.order || []).filter(function (itemId) { return itemId !== id; });
      return state;
    }).then(function () {
      return { provider: 'built-in-knowledge', deleted: true, id: id };
    });
  }

  function assertManagedDeleteArgs(args) {
    args = args || {};
    var sourceKind = normalizeSourceKind(args.sourceKind || args.kind || '', args.type);
    var sourceKey = String(args.sourceKey || args.key || '').trim();
    var sourceKeyPrefix = String(args.sourceKeyPrefix || args.keyPrefix || args.prefix || '').trim();
    if (sourceKind !== 'skill' && sourceKind !== 'mcp') {
      throw new Error('受管知识删除只支持 skill 或 mcp');
    }
    if (!sourceKey && !sourceKeyPrefix) {
      throw new Error('缺少受管知识 sourceKey 或 sourceKeyPrefix');
    }
    if (sourceKind === 'skill') {
      if (sourceKey && !/^skill-import:[^:]+$/.test(sourceKey)) {
        throw new Error('无效 Skill 导入 sourceKey: ' + sourceKey);
      }
      if (sourceKeyPrefix && !/^skill-import:[^:]+(?::resource:)?$/.test(sourceKeyPrefix)) {
        throw new Error('无效 Skill 导入 sourceKeyPrefix: ' + sourceKeyPrefix);
      }
    }
    if (sourceKind === 'mcp') {
      if (sourceKey && !/^mcp-http:.+:tool:.+/.test(sourceKey)) {
        throw new Error('无效 MCP 知识 sourceKey: ' + sourceKey);
      }
      if (sourceKeyPrefix && !/^mcp-http:.+:tool:/.test(sourceKeyPrefix)) {
        throw new Error('无效 MCP 知识 sourceKeyPrefix: ' + sourceKeyPrefix);
      }
    }
    return {
      sourceKind: sourceKind,
      sourceKey: sourceKey,
      sourceKeyPrefix: sourceKeyPrefix,
      includeChildren: args.includeChildren === true,
    };
  }

  function removeManagedSource(args) {
    var spec;
    try {
      spec = assertManagedDeleteArgs(args || {});
    } catch (err) {
      return Promise.reject(err);
    }
    var deleted = [];
    return update(function (state) {
      Object.keys(state.items || {}).forEach(function (id) {
        var item = state.items[id];
        if (!item || isBuiltinItem(item)) return;
        var kind = normalizeSourceKind(item.sourceKind || item.source && item.source.kind, item.type);
        if (kind !== spec.sourceKind) return;
        var source = item.source || {};
        var key = String(source.key || '').trim();
        var matches = false;
        if (spec.sourceKey) {
          matches = key === spec.sourceKey || (spec.includeChildren && key.indexOf(spec.sourceKey + ':') === 0);
        } else if (spec.sourceKeyPrefix) {
          matches = key.indexOf(spec.sourceKeyPrefix) === 0;
        }
        if (!matches) return;
        if (spec.sourceKind === 'skill' && !(source.importer === 'skill-knowledge' || item.skillImport === true || key.indexOf('skill-import:') === 0)) return;
        if (spec.sourceKind === 'mcp' && !(source.remoteSync === true || source.managed === 'remote' || key.indexOf('mcp-http:') === 0)) return;
        delete state.items[id];
        deleted.push({ id: id, sourceKey: key, title: item.title });
      });
      if (deleted.length) {
        var deletedMap = {};
        deleted.forEach(function (item) { deletedMap[item.id] = true; });
        state.order = (state.order || []).filter(function (id) { return !deletedMap[id]; });
      }
      return state;
    }).then(function () {
      return {
        provider: 'built-in-knowledge',
        deleted: deleted.length,
        items: deleted,
        sourceKind: spec.sourceKind,
        sourceKey: spec.sourceKey,
        sourceKeyPrefix: spec.sourceKeyPrefix,
      };
    });
  }

  function updateSettings(patch) {
    patch = patch || {};
    return update(function (state) {
      state.settings = normalizeSettings(Object.assign({}, state.settings || {}, patch || {}));
      return state;
    }).then(function (state) {
      return { provider: 'built-in-knowledge', settings: state.settings };
    });
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    TYPE_LABELS: TYPE_LABELS,
    SOURCE_LABELS: SOURCE_LABELS,
    SOURCE_PRIORITY: SOURCE_PRIORITY,
    load: load,
    save: save,
    list: list,
    search: search,
    grep: grep,
    get: get,
    getMany: getMany,
    saveAuto: saveAuto,
    upsert: upsert,
    syncBuiltinSkillCatalog: syncBuiltinSkillCatalog,
    remove: remove,
    removeManagedSource: removeManagedSource,
    updateSettings: updateSettings,
    captureConversationTurn: captureConversationTurn,
    markUsed: markUsed,
    recordReuseOutcome: recordReuseOutcome,
    reviewKnowledge: reviewKnowledge,
    getCachedState: getCachedState,
    ensureState: ensureState,
    normalizeItem: normalizeItem,
  };
});
