// Knowledge persistence, state codec, migration, and serialized storage access.
(function attachKnowledgeStore(root, factory) {
  'use strict';

  function isStoreApi(value) {
    return !!(value
      && value.STORAGE_KEY === 'knowledge_state'
      && value.STATE_VERSION === 1
      && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.KnowledgeStore;
  var api = isStoreApi(existing) ? existing : factory();
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.KnowledgeStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'knowledge_state';
  var STATE_VERSION = 1;
  var DEFAULT_MAX_CONTENT_CHARS = 24000;
  var MAX_JSON_ENTRIES = 200000;
  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function hasOwn(value, key) {
    return !!(value
      && (typeof value === 'object' || typeof value === 'function')
      && Object.prototype.hasOwnProperty.call(value, key));
  }

  function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function serializationError(path, reason) {
    return new TypeError('知识状态无法序列化 (' + path + '): ' + reason);
  }

  function cloneJsonData(value, path, ancestors, budget) {
    path = path || '$';
    ancestors = ancestors || [];
    budget = budget || { remaining: MAX_JSON_ENTRIES };
    if (value === null) return null;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') {
      if (!isFinite(value)) throw serializationError(path, 'number 必须有限');
      return value;
    }
    if (valueType === 'undefined' || valueType === 'bigint' || valueType === 'function' || valueType === 'symbol') {
      throw serializationError(path, valueType + ' 不是 JSON 值');
    }
    if (valueType !== 'object') throw serializationError(path, '不支持的值类型 ' + valueType);
    if (ancestors.indexOf(value) !== -1) throw serializationError(path, '存在 circular/循环引用');
    if (budget.remaining <= 0) throw serializationError(path, '对象节点超过安全上限');
    budget.remaining -= 1;
    ancestors.push(value);

    var output;
    if (Array.isArray(value)) {
      var arrayLength = value.length;
      if (arrayLength > budget.remaining) {
        ancestors.pop();
        throw serializationError(path, '数组长度超过安全上限 ' + MAX_JSON_ENTRIES);
      }
      budget.remaining -= arrayLength;
      var arrayKeys;
      try { arrayKeys = Object.getOwnPropertyNames(value); } catch (error) {
        ancestors.pop();
        throw serializationError(path, error && error.message || '无法读取数组字段');
      }
      var arrayIndexes = [];
      for (var arrayKeyIndex = 0; arrayKeyIndex < arrayKeys.length; arrayKeyIndex++) {
        var arrayKey = arrayKeys[arrayKeyIndex];
        if (arrayKey === 'toJSON') {
          ancestors.pop();
          throw serializationError(path + '.toJSON', '禁止自定义 toJSON');
        }
        var index = Number(arrayKey);
        if (arrayKey === 'length' || String(index) !== arrayKey || index < 0 || index >= arrayLength || Math.floor(index) !== index) continue;
        arrayIndexes.push(arrayKey);
      }
      if (arrayIndexes.length !== arrayLength) {
        ancestors.pop();
        throw serializationError(path, '禁止稀疏/sparse 数组和继承索引');
      }
      output = new Array(arrayLength);
      for (var arrayIndex = 0; arrayIndex < arrayIndexes.length; arrayIndex++) {
        var ownIndex = arrayIndexes[arrayIndex];
        var arrayDescriptor;
        try { arrayDescriptor = Object.getOwnPropertyDescriptor(value, ownIndex); } catch (error) {
          ancestors.pop();
          throw serializationError(path + '[' + ownIndex + ']', error && error.message || '无法读取数组字段描述');
        }
        if (!arrayDescriptor || arrayDescriptor.get || arrayDescriptor.set || !hasOwn(arrayDescriptor, 'value')) {
          ancestors.pop();
          throw serializationError(path + '[' + ownIndex + ']', '只允许 own data 字段，禁止访问器/accessor');
        }
        output[Number(ownIndex)] = cloneJsonData(arrayDescriptor.value, path + '[' + ownIndex + ']', ancestors, budget);
      }
    } else {
      output = {};
      var keys;
      try { keys = Object.keys(value); } catch (error) {
        ancestors.pop();
        throw serializationError(path, error && error.message || '无法读取 own keys');
      }
      if (keys.length > budget.remaining) {
        ancestors.pop();
        throw serializationError(path, '对象字段超过安全上限 ' + MAX_JSON_ENTRIES);
      }
      budget.remaining -= keys.length;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (UNSAFE_KEYS[key]) {
          ancestors.pop();
          throw serializationError(path + '.' + key, '禁止原型键');
        }
        if (key === 'toJSON') {
          ancestors.pop();
          throw serializationError(path + '.toJSON', '禁止自定义 toJSON');
        }
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (error) {
          ancestors.pop();
          throw serializationError(path + '.' + key, error && error.message || '无法读取字段描述');
        }
        if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
          ancestors.pop();
          throw serializationError(path + '.' + key, '只允许 own data 字段，禁止访问器/accessor');
        }
        output[key] = cloneJsonData(descriptor.value, path + '.' + key, ancestors, budget);
      }
    }
    ancestors.pop();
    return output;
  }

  function clone(value) {
    return cloneJsonData(value === undefined ? null : value);
  }

  function cloneInputValue(value, path) {
    if (value === undefined) return undefined;
    return cloneJsonData(value, path);
  }

  function cloneCoercionValue(value, path) {
    return coercionPrimitive(cloneInputValue(value, path));
  }

  function coercionPrimitive(value) {
    var valueType = typeof value;
    if (value === null || value === undefined
      || valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
    return undefined;
  }

  function stableValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableValue);
    var output = {};
    Object.keys(value).sort().forEach(function (key) {
      output[key] = stableValue(value[key]);
    });
    return output;
  }

  function sameJson(left, right) {
    try {
      return JSON.stringify(stableValue(cloneJsonData(left))) === JSON.stringify(stableValue(cloneJsonData(right)));
    } catch (_) {
      return false;
    }
  }

  function utf8Bytes(value) {
    var text = String(cloneCoercionValue(value, '$.utf8Value') || '');
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function clampNumber(value, min, max, fallback) {
    var number = Number(coercionPrimitive(value));
    if (!isFinite(number)) number = fallback;
    return Math.max(min, Math.min(max, number));
  }

  function finiteNumber(value, fallback) {
    var number = Number(coercionPrimitive(value));
    return isFinite(number) ? number : fallback;
  }

  function defaultNormalizeSourceKind(value, fallbackType) {
    var kind = String(coercionPrimitive(value) || '').trim();
    if (kind === 'conversation' || kind === 'auto-capture') return 'auto';
    if (kind === 'builtin-user' || kind === 'manual-builtin') return 'auto';
    if (kind === 'built-in') return 'builtin';
    if (kind === 'mcp-server') return 'mcp';
    if (kind === 'codex-skill' || kind === 'agent-skill') return 'skill';
    if (kind === 'builtin' || kind === 'auto' || kind === 'mcp' || kind === 'skill') return kind;
    if (fallbackType === 'mcp') return 'mcp';
    if (fallbackType === 'skill') return 'skill';
    return 'auto';
  }

  function defaultSourcePriorityTier(itemOrKind, normalizeSourceKind) {
    var kind = typeof itemOrKind === 'string'
      ? normalizeSourceKind(itemOrKind)
      : normalizeSourceKind(itemOrKind && (itemOrKind.sourceKind || itemOrKind.source && itemOrKind.source.kind), itemOrKind && itemOrKind.type);
    return { builtin: 1, auto: 2, mcp: 3, skill: 4 }[kind] || 2;
  }

  function defaultVerificationState(value, sourceKind) {
    var state = String(coercionPrimitive(value) || '').trim().toLowerCase();
    if ({ unverified: true, corroborated: true, verified: true, stale: true, rejected: true }[state]) return state;
    return sourceKind === 'auto' ? 'unverified' : 'verified';
  }

  function create(options) {
    options = options || {};
    var root = options.root || (typeof globalThis !== 'undefined' ? globalThis : {});
    var storageKey = String(options.storageKey || STORAGE_KEY);
    var version = Math.max(1, Math.floor(Number(options.version) || STATE_VERSION));
    var maxContentChars = Math.max(1000, Number(options.maxContentChars) || DEFAULT_MAX_CONTENT_CHARS);
    var now = typeof options.now === 'function' ? options.now : Date.now;
    var random = typeof options.random === 'function' ? options.random : Math.random;
    var builtinItems = typeof options.builtinItems === 'function' ? options.builtinItems : function () { return []; };
    var normalizeSourceKind = options.normalizeSourceKind || defaultNormalizeSourceKind;
    var sourcePriorityTier = options.sourcePriorityTier || function (value) {
      return defaultSourcePriorityTier(value, normalizeSourceKind);
    };
    var normalizeVerificationState = options.normalizeVerificationState || defaultVerificationState;
    var captureDependencies = options.captureDependencies || function () { return []; };
    var isInvalidAutoItem = options.isInvalidAutoItem || function () { return false; };
    var auditState = options.auditState || function (state) { return state; };
    var typeLabels = options.typeLabels || {
      conversation: true, process: true, experience: true, tool: true,
      mcp: true, skill: true, document: true, custom: true,
    };
    var sourceLabels = options.sourceLabels || {
      builtin: '内置知识', auto: '自动沉淀/维护', mcp: 'MCP', skill: 'Skill',
    };
    var explicitMaxBytes = Number(options.maxBytes) || 0;
    var operationQueue = Promise.resolve();
    var loadInFlight = null;
    var cachedState = null;

    function compactString(value, max) {
      value = cloneCoercionValue(value, '$.text');
      var text = String(value === undefined || value === null ? '' : value);
      max = Number(cloneCoercionValue(max, '$.textLimit')) || 0;
      if (!max || text.length <= max) return text;
      return text.slice(0, max).replace(/\s+$/g, '') + '\n... omitted ' + (text.length - max) + ' chars';
    }

    function trimStoredContent(value) {
      value = cloneCoercionValue(value, '$.content');
      var text = String(value === undefined || value === null ? '' : value).trim();
      if (text.length <= maxContentChars) return text;
      var marker = '[前文已自动裁剪，仅保留最近可复用知识]\n\n';
      return marker + text.slice(Math.max(0, text.length - maxContentChars + marker.length));
    }

    function splitTags(value) {
      value = cloneInputValue(value, '$.tags');
      var list = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；#]+/);
      var seen = Object.create(null);
      return list.map(function (entry) { return String(coercionPrimitive(entry) || '').trim(); }).filter(function (entry) {
        if (!entry || seen[entry]) return false;
        seen[entry] = true;
        return true;
      }).slice(0, 24);
    }

    function normalizeType(value) {
      value = cloneCoercionValue(value, '$.type');
      var type = String(value || '').trim();
      return hasOwn(typeLabels, type) && typeLabels[type] ? type : 'custom';
    }

    function normalizeId(value) {
      value = cloneCoercionValue(value, '$.id');
      return String(value === undefined || value === null ? '' : value).trim();
    }

    function nowId(prefix) {
      prefix = cloneCoercionValue(prefix, '$.idPrefix');
      return String(prefix) + '_' + now().toString(36) + '_' + random().toString(36).slice(2, 8);
    }

    function compactStringList(value, limit, maxChars) {
      var seen = Object.create(null);
      var output = [];
      limit = Number(cloneCoercionValue(limit, '$.listLimit')) || 12;
      maxChars = Number(cloneCoercionValue(maxChars, '$.listMaxChars')) || 240;
      var values = Array.isArray(value) ? cloneJsonData(value, '$.list') : [];
      values.forEach(function (entry) {
        var text = compactString(String(coercionPrimitive(entry) || '').trim(), maxChars);
        if (!text || seen[text] || output.length >= limit) return;
        seen[text] = true;
        output.push(text);
      });
      return output;
    }

    function normalizeKnowledgeDependencies(value) {
      var seen = Object.create(null);
      var output = [];
      var values = Array.isArray(value) ? cloneJsonData(value, '$.dependencies') : [];
      values.forEach(function (entry) {
        entry = entry && typeof entry === 'object' ? entry : { id: entry };
        var kind = String(coercionPrimitive(entry.kind) || coercionPrimitive(entry.type) || '').trim().toLowerCase();
        var id = compactString(String(coercionPrimitive(entry.id) || coercionPrimitive(entry.name) || '').trim(), 160);
        if ((kind !== 'tool' && kind !== 'node') || !id) return;
        var key = kind + ':' + id;
        if (seen[key] || output.length >= 24) return;
        seen[key] = true;
        output.push({
          kind: kind,
          id: id,
          fingerprint: compactString(String(coercionPrimitive(entry.fingerprint) || coercionPrimitive(entry.schemaFingerprint) || '').trim(), 80),
        });
      });
      return output;
    }

    function normalizeSettings(settings) {
      settings = isRecord(settings) ? cloneJsonData(settings, '$.settings') : {};
      var output = settings;
      output.enabled = settings.enabled !== false;
      output.autoCapture = settings.autoCapture !== false;
      delete output.autoInject;
      delete output.maxAutoContextItems;
      delete output.maxAutoContextChars;
      return output;
    }

    function normalizeSource(source, fallback) {
      source = isRecord(source) ? source : {};
      source = cloneJsonData(source, '$.source');
      fallback = cloneCoercionValue(fallback, '$.sourceFallback');
      var output = source;
      var kind = normalizeSourceKind(coercionPrimitive(source.kind) || fallback, fallback);
      output.kind = kind;
      output.key = String(coercionPrimitive(source.key) || coercionPrimitive(source.sourceKey) || '').trim();
      output.topicId = String(coercionPrimitive(source.topicId) || '').trim();
      output.assistantId = String(coercionPrimitive(source.assistantId) || '').trim();
      output.toolName = String(coercionPrimitive(source.toolName) || '').trim();
      output.uri = String(coercionPrimitive(source.uri) || '').trim();
      var migratedSync = Object.keys(source).some(function (key) {
        return key !== 'remoteSync' && /Sync$/.test(key) && source[key] === true;
      });
      Object.keys(output).forEach(function (key) {
        if (key !== 'remoteSync' && /Sync$/.test(key)) delete output[key];
      });
      if (source.remoteSync === true || source.sync === true || migratedSync) output.remoteSync = true;
      if (coercionPrimitive(source.managed)) {
        output.managed = kind === 'mcp' || kind === 'skill'
          ? 'remote'
          : String(coercionPrimitive(source.managed) || '').trim();
      }
      if (coercionPrimitive(source.importer)) output.importer = String(coercionPrimitive(source.importer) || '').trim();
      return output;
    }

    function normalizeItem(raw, fallbackId) {
      raw = isRecord(raw) ? raw : {};
      raw = cloneJsonData(raw, '$.item');
      var item = raw;
      var createdAt = Number(coercionPrimitive(raw.createdAt)) || now();
      var updatedAt = Number(coercionPrimitive(raw.updatedAt)) || createdAt;
      var source = normalizeSource(raw.source || {}, raw.sourceKind);
      if (!source.key && coercionPrimitive(raw.sourceKey)) source.key = String(coercionPrimitive(raw.sourceKey) || '').trim();
      var sourceKind = normalizeSourceKind(coercionPrimitive(raw.sourceKind) || source.kind, coercionPrimitive(raw.type));
      if (sourceKind === 'builtin' && raw.builtIn !== true && raw.protected !== true) sourceKind = 'auto';
      source.kind = sourceKind;
      var dependencies = normalizeKnowledgeDependencies(raw.dependencies || raw.dependencySnapshots);
      if (!dependencies.length && sourceKind === 'auto') {
        dependencies = normalizeKnowledgeDependencies(captureDependencies([
          coercionPrimitive(raw.title), coercionPrimitive(raw.summary), coercionPrimitive(raw.content) || coercionPrimitive(raw.body),
        ].filter(Boolean).join('\n')));
      }
      var confidence = clampNumber(raw.confidence, 0, 1, 0.6);
      Object.assign(item, {
        id: normalizeId(coercionPrimitive(raw.id) || fallbackId || nowId('kn')),
        type: normalizeType(coercionPrimitive(raw.type) || (source.kind === 'mcp' ? 'mcp' : source.kind === 'skill' ? 'skill' : 'custom')),
        title: compactString(String(coercionPrimitive(raw.title) || '').trim() || '未命名知识', 120),
        summary: compactString(String(coercionPrimitive(raw.summary) || '').trim(), 800),
        content: trimStoredContent(coercionPrimitive(raw.content) || coercionPrimitive(raw.body) || ''),
        tags: splitTags(raw.tags),
        source: source,
        sourceKind: sourceKind,
        sourceLabel: sourceLabels[sourceKind] || sourceKind,
        priorityTier: sourcePriorityTier(sourceKind),
        confidence: confidence,
        useCount: Math.max(0, finiteNumber(raw.useCount, 0)),
        pinned: raw.pinned === true,
        archived: raw.archived === true,
        builtIn: raw.builtIn === true,
        protected: raw.protected === true,
        captureMoment: String(coercionPrimitive(raw.captureMoment) || '').trim(),
        captureCount: Math.max(0, finiteNumber(raw.captureCount, 0)),
        lastCapturedAt: Math.max(0, finiteNumber(raw.lastCapturedAt, 0)),
        firstCapturedTopicId: String(coercionPrimitive(raw.firstCapturedTopicId) || '').trim(),
        lastCapturedTopicId: String(coercionPrimitive(raw.lastCapturedTopicId) || '').trim(),
        knowledgeFingerprint: String(coercionPrimitive(raw.knowledgeFingerprint) || '').trim(),
        decisionReason: compactString(String(coercionPrimitive(raw.decisionReason) || '').trim(), 500),
        verificationState: normalizeVerificationState(coercionPrimitive(raw.verificationState), sourceKind),
        evidenceSource: compactString(String(coercionPrimitive(raw.evidenceSource) || '').trim(), 320),
        reuseSuccessCount: Math.max(0, Math.floor(finiteNumber(raw.reuseSuccessCount, 0))),
        reuseFailureCount: Math.max(0, Math.floor(finiteNumber(raw.reuseFailureCount, 0))),
        reuseInconclusiveCount: Math.max(0, Math.floor(finiteNumber(raw.reuseInconclusiveCount, 0))),
        corroborationTopicIds: compactStringList(raw.corroborationTopicIds, 20, 120),
        evidenceRefs: compactStringList(raw.evidenceRefs, 20, 240),
        lastReuseOutcome: compactString(String(coercionPrimitive(raw.lastReuseOutcome) || '').trim(), 40),
        lastReuseReason: compactString(String(coercionPrimitive(raw.lastReuseReason) || '').trim(), 320),
        lastReuseAt: Math.max(0, finiteNumber(raw.lastReuseAt, 0)),
        lastVerifiedAt: Math.max(0, finiteNumber(raw.lastVerifiedAt, 0)),
        staleAt: Math.max(0, finiteNumber(raw.staleAt, 0)),
        staleReason: compactString(String(coercionPrimitive(raw.staleReason) || '').trim(), 320),
        reviewedAt: Math.max(0, finiteNumber(raw.reviewedAt, 0)),
        reviewedBy: compactString(String(coercionPrimitive(raw.reviewedBy) || '').trim(), 80),
        reviewReason: compactString(String(coercionPrimitive(raw.reviewReason) || '').trim(), 320),
        dependencies: dependencies,
        dependencyStatus: compactString(String(coercionPrimitive(raw.dependencyStatus) || (dependencies.length ? 'current' : 'none')).trim(), 40),
        dependencyInvalidations: compactStringList(raw.dependencyInvalidations, 12, 240),
        lastDependencyCheckedAt: Math.max(0, finiteNumber(raw.lastDependencyCheckedAt, 0)),
        createdAt: createdAt,
        updatedAt: updatedAt,
        lastUsedAt: Math.max(0, finiteNumber(raw.lastUsedAt, 0)),
      });
      if (!item.summary) item.summary = compactString(item.content.replace(/\s+/g, ' '), 220);
      if (isInvalidAutoItem(item)) {
        item.archived = true;
        item.tags = splitTags((item.tags || []).concat(['auto-capture-rejected']));
      }
      return item;
    }

    function normalizeState(raw) {
      var exists = raw !== undefined && raw !== null;
      var needsPersist = false;
      var source;
      if (!exists) source = {};
      else if (!isRecord(raw)) {
        source = {};
        needsPersist = true;
      } else source = cloneJsonData(raw, '$');

      var rawVersion = Number(coercionPrimitive(source.version));
      if (isFinite(rawVersion) && rawVersion > version) {
        throw new Error('知识状态版本 ' + rawVersion + ' 高于当前支持版本 ' + version);
      }
      if (exists && (rawVersion !== version || source.version !== version)) needsPersist = true;

      var state = source;
      state.version = version;
      var hadSettingsRecord = isRecord(source.settings);
      var rawSettings = hadSettingsRecord ? source.settings : {};
      state.settings = normalizeSettings(rawSettings);
      if (exists && (!hadSettingsRecord || !sameJson(rawSettings, state.settings))) needsPersist = true;

      var rawItems = isRecord(source.items) ? source.items : {};
      if (exists && !isRecord(source.items)) needsPersist = true;
      var normalizedItems = {};
      Object.keys(rawItems).forEach(function (id) {
        if (UNSAFE_KEYS[id] || !isRecord(rawItems[id])) {
          needsPersist = true;
          return;
        }
        var normalized = normalizeItem(rawItems[id], id);
        if (!normalized.id || UNSAFE_KEYS[normalized.id]) {
          needsPersist = true;
          return;
        }
        normalizedItems[normalized.id] = normalized;
        if (normalized.id !== id || !sameJson(rawItems[id], normalized)) needsPersist = true;
      });

      var builtins = builtinItems();
      if (!Array.isArray(builtins)) throw new Error('知识 builtinItems 必须返回数组');
      builtins = cloneJsonData(builtins, '$.builtins');
      var builtinCatalog = Object.create(null);
      builtins.forEach(function (rawBuiltin) {
        var builtinId = normalizeId(rawBuiltin && rawBuiltin.id);
        if (builtinId) builtinCatalog[builtinId] = true;
      });
      Object.keys(normalizedItems).forEach(function (id) {
        var item = normalizedItems[id];
        if (item && item.builtIn === true && item.source && item.source.kind === 'builtin'
            && !builtinCatalog[id]) {
          delete normalizedItems[id];
          needsPersist = true;
        }
      });
      builtins.forEach(function (rawBuiltin) {
        if (!isRecord(rawBuiltin)) throw new Error('知识 builtin item 必须为对象');
        var builtin = normalizeItem(rawBuiltin, rawBuiltin.id);
        if (!builtin.id || UNSAFE_KEYS[builtin.id]) throw new Error('知识 builtin ID 无效');
        if (!hasOwn(rawItems, builtin.id) || !sameJson(rawItems[builtin.id], builtin)) needsPersist = needsPersist || exists;
        normalizedItems[builtin.id] = builtin;
      });
      state.items = normalizedItems;

      var requestedOrder = Array.isArray(source.order) ? source.order : [];
      if (exists && !Array.isArray(source.order)) needsPersist = true;
      var order = [];
      var seen = Object.create(null);
      requestedOrder.forEach(function (rawId) {
        var id = normalizeId(rawId);
        if (!id || seen[id] || !hasOwn(normalizedItems, id)) return;
        seen[id] = true;
        order.push(id);
      });
      builtins.slice().reverse().forEach(function (rawBuiltin) {
        var id = normalizeId(rawBuiltin && rawBuiltin.id);
        if (!id || !hasOwn(normalizedItems, id)) return;
        order = [id].concat(order.filter(function (entry) { return entry !== id; }));
        seen[id] = true;
      });
      Object.keys(normalizedItems).forEach(function (id) {
        if (!seen[id]) order.push(id);
      });
      state.order = order;
      if (exists && !sameJson(requestedOrder, order)) needsPersist = true;
      state.updatedAt = Number(coercionPrimitive(source.updatedAt)) || now();
      if (exists && !Number(coercionPrimitive(source.updatedAt))) needsPersist = true;

      var audited = auditState(state, now());
      if (audited && audited !== state) state = audited;
      state = cloneJsonData(state, '$');
      return { state: state, needsPersist: needsPersist, existed: exists };
    }

    function ensureState(raw) {
      return cloneJsonData(normalizeState(raw).state);
    }

    function storageArea() {
      return options.storageArea || root && root.chrome && root.chrome.storage && root.chrome.storage.local || null;
    }

    function callbackLastError() {
      var lastError = root && root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
      return lastError && (lastError.message || String(lastError));
    }

    function invokeStorage(method, args) {
      var area = storageArea();
      if (!area || typeof area[method] !== 'function') {
        return method === 'get'
          ? Promise.resolve({})
          : Promise.reject(new Error('chrome.storage.local 不可用'));
      }
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(ok, value) {
          if (settled) return;
          settled = true;
          if (ok) resolve(value);
          else reject(value instanceof Error ? value : new Error(String(value || 'storage failure')));
        }
        function callback(value) {
          var error = callbackLastError();
          if (error) finish(false, new Error(error));
          else finish(true, value);
        }
        var returned;
        try {
          returned = area[method].apply(area, args.concat(callback));
        } catch (error) {
          finish(false, error);
          return;
        }
        if (returned && typeof returned.then === 'function') {
          Promise.resolve(returned).then(function (value) {
            finish(true, value);
          }, function (error) {
            finish(false, error);
          });
        }
      });
    }

    function readDirect() {
      return invokeStorage('get', [[storageKey]]).then(function (result) {
        if (!isRecord(result)) return { exists: false, value: undefined };
        var descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(result, storageKey);
        } catch (error) {
          throw serializationError('$.storageResult', error && error.message || '无法读取 storage 字段描述');
        }
        if (!descriptor) return { exists: false, value: undefined };
        if (descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) {
          throw serializationError('$.storageResult.' + storageKey, '只允许 own data 字段，禁止访问器/accessor');
        }
        if (descriptor.value === undefined) return { exists: false, value: undefined };
        return {
          exists: true,
          value: cloneJsonData(descriptor.value, '$.storageResult.' + storageKey),
        };
      });
    }

    function quotaBytes() {
      if (explicitMaxBytes > 0) return explicitMaxBytes;
      var area = storageArea();
      var areaQuota = Number(area && area.QUOTA_BYTES);
      return isFinite(areaQuota) && areaQuota > 0 ? areaQuota : 0;
    }

    function encodedPayload(state) {
      var safeState = cloneJsonData(state, '$');
      var payload = {};
      payload[storageKey] = safeState;
      var json;
      try { json = JSON.stringify(payload); } catch (error) {
        throw serializationError('$', error && error.message || 'JSON.stringify 失败');
      }
      var bytes = utf8Bytes(json);
      var limit = quotaBytes();
      if (limit && bytes > limit) {
        throw new Error('知识状态超过 storage quota/配额: ' + bytes + ' > ' + limit + ' bytes');
      }
      return { payload: JSON.parse(json), state: safeState, bytes: bytes };
    }

    function writeDirect(state, options) {
      options = options || {};
      var decoded = options.normalized ? { state: cloneJsonData(state, '$') } : normalizeState(state);
      var next = decoded.state;
      if (options.touchUpdatedAt !== false) next.updatedAt = now();
      var encoded;
      try { encoded = encodedPayload(next); } catch (error) { return Promise.reject(error); }
      return invokeStorage('set', [encoded.payload]).then(function () {
        cachedState = cloneJsonData(encoded.state, '$');
        return cloneJsonData(cachedState, '$');
      });
    }

    function loadDirect(persistMigration) {
      return readDirect().then(function (stored) {
        var decoded = normalizeState(stored.exists ? stored.value : undefined);
        if (decoded.needsPersist && persistMigration !== false) {
          decoded.state.updatedAt = now();
          return writeDirect(decoded.state, { normalized: true, touchUpdatedAt: false });
        }
        cachedState = cloneJsonData(decoded.state, '$');
        return cloneJsonData(cachedState, '$');
      });
    }

    function enqueue(operation) {
      var result = operationQueue.then(operation);
      operationQueue = result.catch(function () {});
      return result;
    }

    function load() {
      if (loadInFlight) return loadInFlight.then(function (state) { return cloneJsonData(state, '$'); });
      var operation = enqueue(function () { return loadDirect(true); });
      loadInFlight = operation;
      operation.then(function () {
        if (loadInFlight === operation) loadInFlight = null;
      }, function () {
        if (loadInFlight === operation) loadInFlight = null;
      });
      return operation.then(function (state) { return cloneJsonData(state, '$'); });
    }

    function save(state) {
      return enqueue(function () { return writeDirect(state); });
    }

    function update(mutator) {
      if (typeof mutator !== 'function') return Promise.reject(new TypeError('知识 update 需要 mutator'));
      return enqueue(function () {
        return loadDirect(false).then(function (state) {
          return Promise.resolve().then(function () { return mutator(state); }).then(function (next) {
            return writeDirect(next || state);
          });
        });
      });
    }

    function getCachedState() {
      if (cachedState) return cloneJsonData(cachedState, '$');
      return cloneJsonData(normalizeState(undefined).state, '$');
    }

    return {
      STORAGE_KEY: storageKey,
      STATE_VERSION: version,
      load: load,
      save: save,
      update: update,
      getCachedState: getCachedState,
      ensureState: ensureState,
      normalizeItem: normalizeItem,
      normalizeSettings: normalizeSettings,
      normalizeSource: normalizeSource,
      normalizeKnowledgeDependencies: normalizeKnowledgeDependencies,
      compactStringList: compactStringList,
      compactString: compactString,
      trimStoredContent: trimStoredContent,
      splitTags: splitTags,
      normalizeType: normalizeType,
      normalizeId: normalizeId,
      nowId: nowId,
      clone: clone,
      utf8Bytes: utf8Bytes,
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    STATE_VERSION: STATE_VERSION,
    create: create,
  };
});
