// Shared persistence and domain operations used by independently registered ARP resources.
(function attachAgentResourceService(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../protocol') : root.AgentResourceProtocol;
  if (!arp) throw new Error('AgentResourceProtocol must load before AgentResourceService');
  var api = factory(root, arp);
  if (commonJs) module.exports = api;
  else root.AgentResourceService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, arp) {
  'use strict';

  var CONFIG_SECTIONS = Object.freeze([
    'pages', 'flows', 'flowGroups', 'scripts', 'schedules', 'urlTriggers',
  ]);
  var CONFIG_SECTION_SET = CONFIG_SECTIONS.reduce(function (out, name) {
    out[name] = true;
    return out;
  }, Object.create(null));
  var UNSAFE_KEYS = Object.freeze({ __proto__: true, prototype: true, constructor: true });

  function own(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function cloneObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
  }

  function fail(code, message, details) {
    throw arp.arpError(code, message, details === undefined ? undefined : { details: details });
  }

  function requireDependency(value, name) {
    if (!value) fail('TEMPORARILY_UNAVAILABLE', name + ' is not wired to AgentResourceService');
    return value;
  }

  function requireFunction(value, name) {
    if (typeof value !== 'function') fail('TEMPORARILY_UNAVAILABLE', name + ' is not wired to AgentResourceService');
    return value;
  }

  function cleanId(value, label) {
    var text = String(value || '').trim().replace(/^user:/, '');
    if (!text || text.length > 240 || /[\u0000-\u001f\u007f]/.test(text)) {
      fail('SCHEMA_VALIDATION_FAILED', (label || 'resource id') + ' is invalid');
    }
    return text;
  }

  function randomId(prefix) {
    var cryptoObject = root && root.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return prefix + '_' + cryptoObject.randomUUID().replace(/-/g, '').slice(0, 16);
    }
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    var output = {};
    Object.keys(value).sort().forEach(function (key) { output[key] = stableValue(value[key]); });
    return output;
  }

  function etag(value) {
    var text = JSON.stringify(stableValue(value === undefined ? null : value));
    var hash = 2166136261;
    for (var index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return '"arp-' + (hash >>> 0).toString(16).padStart(8, '0') + '"';
  }

  function pageWindow(items, query) {
    query = query || {};
    var limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    var cursorMatch = /^offset:(\d+)$/.exec(String(query.cursor || ''));
    var offset = cursorMatch ? Number(cursorMatch[1]) : 0;
    var page = items.slice(offset, offset + limit);
    var output = {
      items: page,
      total: items.length,
    };
    if (offset + page.length < items.length) output.nextCursor = 'offset:' + (offset + page.length);
    return output;
  }

  // The node catalog is a small, static registry. Keep its default read complete
  // so an agent does not need to reconstruct the registry across pagination calls.
  function nodeTypePageWindow(items, query) {
    query = query || {};
    var hasExplicitWindow = query.limit !== undefined || query.cursor !== undefined;
    var limit = hasExplicitWindow
      ? Math.min(200, Math.max(1, Number(query.limit) || 30))
      : Math.max(1, items.length);
    var cursorMatch = /^offset:(\d+)$/.exec(String(query.cursor || ''));
    var offset = cursorMatch ? Number(cursorMatch[1]) : 0;
    var page = items.slice(offset, offset + limit);
    var output = { items: page, total: items.length };
    if (offset + page.length < items.length) output.nextCursor = 'offset:' + (offset + page.length);
    return output;
  }

  function createMemoryStorageArea(initial) {
    var values = clone(initial || {});
    return {
      get: function (keys, callback) {
        var result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = clone(values[key]);
        });
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      },
      set: function (patch, callback) {
        Object.keys(patch || {}).forEach(function (key) { values[key] = clone(patch[key]); });
        if (typeof callback === 'function') callback();
        return Promise.resolve();
      },
      snapshot: function () { return clone(values); },
    };
  }

  function storageCall(storageArea, method, value) {
    return new Promise(function (resolve, reject) {
      if (!storageArea || typeof storageArea[method] !== 'function') {
        reject(new Error('Persistent storage does not implement ' + method));
        return;
      }
      var settled = false;
      function finish(error, result) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      }
      function callback(result) {
        var lastError = root && root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
        finish(lastError ? new Error(lastError.message || String(lastError)) : null, result);
      }
      try {
        var returned = storageArea[method](value, callback);
        if (returned && typeof returned.then === 'function') returned.then(function (result) { finish(null, result); }, function (error) { finish(error); });
      } catch (error) { finish(error); }
    });
  }

  function defaultStorageArea(options) {
    return options.storageArea
      || root && root.chrome && root.chrome.storage && root.chrome.storage.local
      || createMemoryStorageArea();
  }

  function createPersistentStore(options) {
    options = options || {};
    var storageArea = defaultStorageArea(options);
    var storageKey = String(options.storageKey || 'arp_resource_entities');
    var maxEntries = Math.max(10, Number(options.maxEntries) || 500);
    var records = new Map();
    var writeQueue = Promise.resolve();

    function persist() {
      var items = Array.from(records.values()).sort(function (left, right) {
        return Number(right.updatedAt || right.startedAt || 0) - Number(left.updatedAt || left.startedAt || 0);
      });
      if (items.length > maxEntries) items = items.slice(0, maxEntries);
      records.clear();
      items.forEach(function (item) { records.set(String(item.id), item); });
      var payload = {};
      payload[storageKey] = { version: 1, items: clone(items), updatedAt: Date.now() };
      return storageCall(storageArea, 'set', payload);
    }

    function recoverRecords() {
      if (typeof options.recover !== 'function') return false;
      var changed = false;
      records.forEach(function (item, id) {
        var next = options.recover(clone(item));
        if (!next || JSON.stringify(next) === JSON.stringify(item)) return;
        records.set(String(id), next);
        changed = true;
      });
      return changed;
    }

    var ready = storageCall(storageArea, 'get', storageKey).then(function (stored) {
      var value = stored && stored[storageKey];
      var items = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : [];
      items.forEach(function (item) {
        if (!item || !item.id) return;
        records.set(String(item.id), clone(item));
      });
      return recoverRecords() ? persist() : null;
    });

    function afterWrites(callback) {
      return ready.then(function () {
        if (typeof options.recover !== 'function') return writeQueue.then(callback);
        writeQueue = writeQueue.then(function () {
          return (recoverRecords() ? persist() : Promise.resolve()).then(callback);
        });
        return writeQueue;
      });
    }
    function mutate(callback) {
      return ready.then(function () {
        writeQueue = writeQueue.then(callback).then(function (result) { return persist().then(function () { return result; }); });
        return writeQueue;
      });
    }
    function normalize(value, id) {
      var next = cloneObject(value);
      next.id = cleanId(id || next.id || randomId(options.idPrefix || 'entity'), 'store id');
      var previous = records.get(next.id);
      next.createdAt = Number(next.createdAt || previous && previous.createdAt) || Date.now();
      next.updatedAt = Date.now();
      return next;
    }

    return Object.freeze({
      ready: ready,
      list: function () { return afterWrites(function () { return clone(Array.from(records.values())); }); },
      get: function (id) { return afterWrites(function () { return records.has(String(id)) ? clone(records.get(String(id))) : null; }); },
      save: function (value) { return mutate(function () { var next = normalize(value); records.set(next.id, next); return clone(next); }); },
      upsert: function (id, value) { if (value === undefined) { value = id; id = value && value.id; } return mutate(function () { var next = normalize(value, id); records.set(next.id, next); return clone(next); }); },
      update: function (id, value) { return mutate(function () { if (!records.has(String(id))) throw new Error('Stored entity does not exist: ' + id); var next = normalize(value, id); records.set(next.id, next); return clone(next); }); },
      remove: function (id) { return mutate(function () { return records.delete(String(id)); }); },
      replaceAll: function (items) { return mutate(function () { records.clear(); (items || []).forEach(function (item) { var next = normalize(item); records.set(next.id, next); }); return clone(Array.from(records.values())); }); },
      storageArea: storageArea,
      storageKey: storageKey,
    });
  }

  function createOperationRunStore(options) {
    options = options || {};
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var runtimeOwner = String(options.runtimeOwner || randomId('flow-runtime'));
    var leaseMs = Math.max(30000, Number(options.leaseMs) || 5 * 60 * 1000);
    var legacyGraceMs = Math.max(0, Number(options.legacyGraceMs) || 30000);
    var storeOptions = Object.assign({}, options, {
      storageKey: options.storageKey || (options.incognito ? 'arp_flow_operations_incognito' : 'arp_flow_operations'),
      idPrefix: 'run',
      recover: function (record) {
        if (record.status === 'running' || record.status === 'queued') {
          var now = Number(clock());
          var leaseExpiresAt = Number(record.leaseExpiresAt) || 0;
          var lastSeenAt = Number(record.heartbeatAt || record.updatedAt || record.startedAt) || 0;
          if (record.runtimeOwner === runtimeOwner || leaseExpiresAt > now
              || (!leaseExpiresAt && lastSeenAt && now - lastSeenAt < legacyGraceMs)) return record;
          record.status = 'interrupted';
          record.interruptedAt = now;
          record.endedAt = record.interruptedAt;
          record.recoverable = true;
          record.error = record.error || 'Extension runtime restarted before the operation completed';
          delete record.runtimeOwner;
          delete record.heartbeatAt;
          delete record.leaseExpiresAt;
        }
        return record;
      },
    });
    var store = createPersistentStore(storeOptions);
    function owned(value) {
      var next = cloneObject(value);
      if (next.status === 'running' || next.status === 'queued') {
        var now = Number(clock());
        next.runtimeOwner = runtimeOwner;
        next.heartbeatAt = now;
        next.leaseExpiresAt = now + leaseMs;
      } else {
        delete next.runtimeOwner;
        delete next.heartbeatAt;
        delete next.leaseExpiresAt;
      }
      return next;
    }
    return Object.freeze({
      ready: store.ready,
      list: store.list,
      get: store.get,
      save: function (value) { return store.save(owned(value)); },
      upsert: function (id, value) {
        if (value === undefined) return store.upsert(owned(id));
        return store.upsert(id, owned(value));
      },
      update: function (id, value) { return store.update(id, owned(value)); },
      remove: store.remove,
      replaceAll: function (items) { return store.replaceAll((items || []).map(owned)); },
      heartbeat: function (id) {
        return store.get(id).then(function (record) {
          return record && (record.status === 'running' || record.status === 'queued')
            ? store.update(id, owned(record))
            : record;
        });
      },
      runtimeOwner: runtimeOwner,
      leaseMs: leaseMs,
      storageArea: store.storageArea,
      storageKey: store.storageKey,
    });
  }

  function normalizeSkill(value) {
    value = cloneObject(value);
    var source = value.source && typeof value.source === 'object' ? value.source : {};
    var id = value.id || value.skillId || value.name || source.key;
    id = cleanId(String(id || '').replace(/^builtin:skill:/, ''), 'skillId');
    return {
      id: id,
      name: String(value.name || value.title || id),
      description: String(value.description || value.summary || ''),
      instructions: String(value.instructions || value.content || value.markdown || ''),
      version: String(value.version || source.version || '1'),
      source: clone(source),
      resources: clone(Array.isArray(value.resources) ? value.resources : []),
      tags: clone(Array.isArray(value.tags) ? value.tags : []),
      enabled: value.enabled !== false,
      archived: value.archived === true,
      builtinSkill: value.builtinSkill === true,
      builtIn: value.builtIn === true,
      protected: value.protected === true,
      createdAt: Number(value.createdAt) || Number(value.updatedAt) || Date.now(),
      updatedAt: Number(value.updatedAt) || Date.now(),
    };
  }

  function isBuiltinSkill(value) {
    var source = value && value.source && typeof value.source === 'object' ? value.source : {};
    return !!(value && (value.builtinSkill === true || value.builtIn === true || value.protected === true
      || source.kind === 'builtin' || source.managed === 'builtin' || source.importer === 'builtin-skill-loader'
      || /^skill-builtin:/.test(String(source.key || ''))));
  }

  function createSkillCatalog(options) {
    options = options || {};
    var store = options.store || createPersistentStore({
      storageArea: options.storageArea,
      storageKey: options.storageKey || (options.incognito ? 'arp_skill_catalog_incognito' : 'arp_skill_catalog'),
      idPrefix: 'skill',
      maxEntries: options.maxEntries || 1000,
    });
    var seedPromise = null;

    function ensureSeeded() {
      if (seedPromise) return seedPromise;
      seedPromise = store.list().then(function (items) {
        if (items.length || typeof options.sourceLoader !== 'function') return items;
        return Promise.resolve(options.sourceLoader()).then(function (loaded) {
          loaded = Array.isArray(loaded) ? loaded : loaded && (loaded.items || loaded.matches || loaded.packages) || [];
          var normalized = loaded.map(function (item) { try { return normalizeSkill(item); } catch (_) { return null; } }).filter(Boolean);
          if (!normalized.length) return [];
          return store.replaceAll(normalized);
        });
      }).finally(function () { seedPromise = null; });
      return seedPromise;
    }

    return Object.freeze({
      ready: store.ready,
      list: function (query) {
        query = query || {};
        return ensureSeeded().then(function () { return store.list(); }).then(function (items) {
          var match = String(query.q || '').trim().toLowerCase();
          if (match) items = items.filter(function (item) {
            return [item.id, item.name, item.description, (item.tags || []).join(' ')].join(' ').toLowerCase().indexOf(match) !== -1;
          });
          if (query.includeDisabled !== true) items = items.filter(function (item) { return item.enabled !== false; });
          if (query.includeArchived !== true) items = items.filter(function (item) { return item.archived !== true; });
          return pageWindow(items, query);
        });
      },
      get: function (id) { return ensureSeeded().then(function () { return store.get(cleanId(id, 'skillId')); }); },
      upsert: function (value) { return store.upsert(normalizeSkill(value)); },
      create: function (value) {
        var next = normalizeSkill(value);
        return ensureSeeded().then(function () { return store.get(next.id); }).then(function (existing) {
          if (existing) fail('RESOURCE_CONFLICT', 'Skill already exists: ' + next.id);
          return store.save(next);
        });
      },
      update: function (id, value) {
        id = cleanId(id, 'skillId');
        var next = normalizeSkill(Object.assign({}, value || {}, { id: id }));
        return ensureSeeded().then(function () { return store.update(id, next); });
      },
      remove: function (id) {
        id = cleanId(id, 'skillId');
        return ensureSeeded().then(function () { return store.remove(id); });
      },
      replaceAll: function (values) { return store.replaceAll((values || []).map(normalizeSkill)); },
      store: store,
    });
  }

  function collectionValues(collection) {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return [];
    return Object.keys(collection).sort().map(function (key) {
      var item = own(collection, key);
      if (!item || typeof item !== 'object') return null;
      var copy = clone(item);
      if (!copy.id) copy.id = key;
      return copy;
    }).filter(Boolean);
  }

  function findById(collection, id) {
    if (!collection || typeof collection !== 'object') return null;
    var value = own(collection, id);
    if (value === undefined) value = own(collection, 'user:' + id);
    return value && typeof value === 'object' ? clone(value) : null;
  }

  function mergePatch(target, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
    var output = target && typeof target === 'object' && !Array.isArray(target) ? clone(target) : {};
    Object.keys(patch).forEach(function (key) {
      if (UNSAFE_KEYS[key]) fail('SCHEMA_VALIDATION_FAILED', 'Patch contains a forbidden property: ' + key);
      if (patch[key] === null) delete output[key];
      else output[key] = mergePatch(output[key], patch[key]);
    });
    return output;
  }

  function applyPatch(target, patch) {
    return mergePatch(target, patch);
  }

  function create(options) {
    options = options || {};
    var configStore = options.configStore || null;
    var getConfigDependency = options.getConfig || (configStore && configStore.getConfig && configStore.getConfig.bind(configStore));
    var mutateConfigDependency = options.mutateConfig || (configStore && configStore.mutate && configStore.mutate.bind(configStore));
    var saveConfigDependency = options.saveConfig || (configStore && configStore.saveConfig && configStore.saveConfig.bind(configStore));
    var deleteRunDependency = options.deleteRun || (configStore && configStore.deleteRun && configStore.deleteRun.bind(configStore));
    var clearRunsBeforeDependency = options.clearRunsBefore
      || (configStore && configStore.clearRunsBefore && configStore.clearRunsBefore.bind(configStore));
    var runCommands = options.runCommands || options.runCommandService || null;
    var runQueries = options.runQueries || options.runQueryService || null;
    var groupRunner = options.flowGroupController || null;
    var scheduler = options.scheduler || null;
    var conversationState = options.conversationState || root.ConversationState || null;
    var conversationJournal = options.conversationJournal || null;
    var conversationReady = options.conversationReady ? Promise.resolve(options.conversationReady) : Promise.resolve();
    var conversationCommands = options.conversationCommands || null;
    var conversationExport = options.conversationExport || null;
    var knowledge = options.knowledge || root.Knowledge || null;
    var nodeTypes = options.nodeTypes || root.NodeTypes || null;
    var operationRunStore = options.operationRunStore || createOperationRunStore({
      storageArea: options.storageArea,
      storageKey: options.operationRunStorageKey,
      incognito: options.incognito === true,
      maxEntries: options.maxOperationRuns,
    });
    var skillCatalog = options.skillCatalog || createSkillCatalog({
      storageArea: options.storageArea,
      storageKey: options.skillCatalogStorageKey,
      incognito: options.incognito === true,
    });

    function getConfig() {
      return Promise.resolve(requireFunction(getConfigDependency, 'getConfig')()).then(function (config) {
        return config && typeof config === 'object' ? clone(config) : {};
      });
    }

    function mutateConfig(payload) {
      return Promise.resolve(requireFunction(mutateConfigDependency, 'mutateConfig')(clone(payload))).then(function () {
        return getConfig();
      });
    }

    function saveWholeConfig(config) {
      return Promise.resolve(requireFunction(saveConfigDependency, 'saveConfig')(clone(config))).then(function () {
        return getConfig();
      });
    }

    function sectionName(name) {
      if (!CONFIG_SECTION_SET[name]) fail('RESOURCE_NOT_FOUND', 'Unknown config section: ' + name);
      return name;
    }

    function ensureMutable(item, label) {
      if (item && (item.__builtin || item.__builtinSource || item.builtIn === true || item.protected === true)) {
        fail('FORBIDDEN', (label || 'Resource') + ' is built in or protected');
      }
    }

    function itemInConfig(section, id) {
      return getConfig().then(function (config) {
        var item;
        if (section === 'urlTriggers') {
          item = (Array.isArray(config.urlTriggers) ? config.urlTriggers : []).find(function (entry) {
            return entry && String(entry.id || '') === id;
          });
          item = item ? clone(item) : null;
        } else item = findById(config[section], id);
        if (!item) fail('RESOURCE_NOT_FOUND', section + ' resource does not exist: ' + id);
        return item;
      });
    }

    function listSection(section, query) {
      sectionName(section);
      return getConfig().then(function (config) {
        var items = section === 'urlTriggers'
          ? clone(Array.isArray(config.urlTriggers) ? config.urlTriggers : [])
          : collectionValues(config[section]);
        return pageWindow(items, query);
      });
    }

    function createSectionItem(section, body, prefix) {
      sectionName(section);
      body = cloneObject(body);
      var id = cleanId(body.id || randomId(prefix), section + ' id');
      return getConfig().then(function (config) {
        var existing = section === 'urlTriggers'
          ? (config.urlTriggers || []).some(function (item) { return item && String(item.id || '') === id; })
          : !!findById(config[section], id);
        if (existing) fail('RESOURCE_CONFLICT', section + ' resource already exists: ' + id);
        body.id = id;
        if (section === 'urlTriggers') {
          var list = clone(Array.isArray(config.urlTriggers) ? config.urlTriggers : []);
          list.push(body);
          return mutateConfig({ op: 'upsert', section: section, item: list });
        }
        return mutateConfig({ op: 'upsert', section: section, item: body });
      }).then(function () { return itemInConfig(section, id); });
    }

    function replaceSectionItem(section, id, body) {
      sectionName(section);
      id = cleanId(id, section + ' id');
      body = cloneObject(body);
      if (body.id && cleanId(body.id, section + ' body id') !== id) {
        fail('RESOURCE_CONFLICT', 'Body id does not match the addressed resource');
      }
      return itemInConfig(section, id).then(function (current) {
        ensureMutable(current, section);
        body.id = id;
        if (section !== 'urlTriggers') return mutateConfig({ op: 'upsert', section: section, item: body });
        return getConfig().then(function (config) {
          var list = clone(config.urlTriggers || []);
          var index = list.findIndex(function (item) { return item && String(item.id || '') === id; });
          list[index] = body;
          return mutateConfig({ op: 'upsert', section: section, item: list });
        });
      }).then(function () { return itemInConfig(section, id); });
    }

    function patchSectionItem(section, id, patch) {
      return itemInConfig(section, id).then(function (current) {
        ensureMutable(current, section);
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          fail('SCHEMA_VALIDATION_FAILED', 'PATCH must leave a resource object');
        }
        return replaceSectionItem(section, id, next);
      });
    }

    function deleteSectionItem(section, id) {
      id = cleanId(id, section + ' id');
      return itemInConfig(section, id).then(function (current) {
        ensureMutable(current, section);
        return mutateConfig({ op: 'delete', section: section, id: id });
      }).then(function () { return { id: id, deleted: true }; });
    }

    function getFlow(flowId, query) {
      return itemInConfig('flows', cleanId(flowId, 'flowId')).then(function (flow) {
        if (query && query.view === 'validation') return validateFlow(flow.id || flowId);
        return flow;
      });
    }

    function normalizeFlowInputExample(flow) {
      if (flow.inputExample === undefined || flow.inputExample === null || flow.inputExample === '') {
        if (flow.inputExample !== undefined) flow.inputExample = '';
        return flow;
      }
      if (typeof flow.inputExample !== 'string') {
        fail('SCHEMA_VALIDATION_FAILED', 'Flow inputExample must be a JSON object string');
      }
      var parsed;
      try { parsed = JSON.parse(flow.inputExample); }
      catch (error) {
        fail('SCHEMA_VALIDATION_FAILED', 'Flow inputExample must contain valid JSON: ' + error.message);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('SCHEMA_VALIDATION_FAILED', 'Flow inputExample JSON must be an object');
      }
      return flow;
    }

    function normalizeFlowNode(node, index, usedNodeIds) {
      node = cloneObject(node);
      var nodeId = cleanId(node.nodeId || node.id || randomId('node'), 'nodeId');
      if (usedNodeIds[nodeId]) {
        fail('SCHEMA_VALIDATION_FAILED', 'Flow nodeId must be unique: ' + nodeId);
      }
      usedNodeIds[nodeId] = true;
      node.nodeId = nodeId;
      delete node.id;

      // Keep canonical Flow writes compatible with the legacy CDP click node
      // that older exported/configured flows may still contain.  Storage-load
      // migration covers the background path, but resource imports and direct
      // API writes must normalize the same shape before validation as well.
      if (node.type === ['cdp', 'input', 'click'].join('.')) {
        node.type = 'clickElement';
        if (node.params === undefined || node.params === null) {
          node.params = {};
        } else if (typeof node.params === 'object' && !Array.isArray(node.params)) {
          node.params = Object.assign({}, node.params);
          delete node.params.moveSteps;
        }
      }

      if (node.params === undefined || node.params === null) node.params = {};
      if (typeof node.params !== 'object' || Array.isArray(node.params)) {
        fail('SCHEMA_VALIDATION_FAILED', 'Flow node params must be an object: ' + nodeId);
      }

      var definition = nodeTypes && typeof nodeTypes.getType === 'function'
        ? nodeTypes.getType(node.type)
        : null;
      (definition && Array.isArray(definition.params) ? definition.params : []).forEach(function (param) {
        var key = param && param.key;
        if (!key || node.params[key] !== undefined || own(node, key) === undefined) return;
        node.params[key] = clone(own(node, key));
        delete node[key];
      });

      node.displayOrder = index + 1;
      return node;
    }

    function normalizeFlowRepresentation(body, requireNodes) {
      body = cloneObject(body);
      if (!Array.isArray(body.nodes)) {
        if (requireNodes) fail('SCHEMA_VALIDATION_FAILED', 'A complete Flow representation requires nodes[]');
        body.nodes = [];
      }
      normalizeFlowInputExample(body);
      var usedNodeIds = Object.create(null);
      body.nodes = body.nodes.map(function (node, index) {
        return normalizeFlowNode(node, index, usedNodeIds);
      });
      return body;
    }

    function inspectFlowRepresentation(flowId, flow, config) {
      var errors = [];
      var warnings = [];
      var usedNodeIds = Object.create(null);
      var definitions = nodeTypes && Array.isArray(nodeTypes.TYPES) ? nodeTypes.TYPES : [];
      var definitionMap = definitions.reduce(function (map, item) { map[item.type] = item; return map; }, Object.create(null));
      if (flow.inputExample !== undefined && flow.inputExample !== null && typeof flow.inputExample !== 'string') {
        errors.push('inputExample must be a JSON object string');
      } else if (flow.inputExample) {
        try {
          var example = JSON.parse(flow.inputExample);
          if (!example || typeof example !== 'object' || Array.isArray(example)) errors.push('inputExample JSON must be an object');
        } catch (error) {
          errors.push('inputExample must contain valid JSON: ' + error.message);
        }
      }
      if (!Array.isArray(flow.nodes)) errors.push('nodes must be an array');
      (Array.isArray(flow.nodes) ? flow.nodes : []).forEach(function (node, index) {
        var nodeId = String(node && (node.nodeId || node.id) || '').trim();
        var label = String(node && (node.title || nodeId || node.type) || 'node[' + index + ']');
        if (!nodeId) errors.push('[' + label + '] missing nodeId');
        else if (usedNodeIds[nodeId]) errors.push('[' + label + '] duplicate nodeId: ' + nodeId);
        else usedNodeIds[nodeId] = true;
        if (node && node.params !== undefined && node.params !== null
            && (typeof node.params !== 'object' || Array.isArray(node.params))) {
          errors.push('[' + label + '] params must be an object');
        }
        var definition = definitionMap[node && node.type];
        if (definitions.length && !definition) errors.push('[' + label + '] unknown node type: ' + String(node && node.type || ''));
        if (definition && definition.needsPage && !node.pageId) errors.push('[' + label + '] missing pageId');
        if (node && node.pageId && !findById(config.pages, String(node.pageId))) {
          errors.push('[' + label + '] pageId does not exist: ' + String(node.pageId));
        }
        if (nodeTypes && typeof nodeTypes.validateNodeInstance === 'function') {
          errors = errors.concat(nodeTypes.validateNodeInstance(node || {}));
        }
        var nodeParams = node && node.params && typeof node.params === 'object' && !Array.isArray(node.params) ? node.params : {};
        if (String(nodeParams.confirmationMode || '') === 'deferred') {
          var nextNode = flow.nodes[index + 1];
          var nextParams = nextNode && nextNode.params && typeof nextNode.params === 'object' && !Array.isArray(nextNode.params)
            ? nextNode.params : {};
          if (!nextNode || nextNode.type !== 'waitForCondition') {
            errors.push('[' + label + '] 延后确认后必须紧跟 waitForCondition 节点');
          } else if (String(node.pageId || '') !== String(nextNode.pageId || '')
              || !node.pageId && String(nodeParams.tabId || '') !== String(nextParams.tabId || '')) {
            errors.push('[' + label + '] 延后确认节点与后续 waitForCondition 必须绑定同一页面');
          }
          if (String(node.onFailure || 'abort') === 'continue') {
            errors.push('[' + label + '] 延后确认动作的失败策略必须为中止');
          }
          if (nodeParams.optional === true || nodeParams.optional === 'true') {
            errors.push('[' + label + '] 延后确认动作不能同时设置为未找到时继续执行');
          }
          if (nextNode && String(nextNode.onFailure || 'abort') === 'continue') {
            errors.push('[' + label + '] 配对 waitForCondition 的失败策略必须为中止');
          }
        }
        if (node && node.type === 'delay') warnings.push('[' + label + '] fixed delay should be replaced by a state-based wait where possible');
      });
      return {
        flowId: String(flowId || flow.id || ''),
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
        nodeCount: Array.isArray(flow.nodes) ? flow.nodes.length : 0,
        flowVersion: etag(flow),
      };
    }

    function assertFlowRepresentation(flowId, flow, config) {
      if (!nodeTypes || !Array.isArray(nodeTypes.TYPES) || typeof nodeTypes.validateNodeInstance !== 'function') {
        fail('TEMPORARILY_UNAVAILABLE', 'NodeTypes is required to validate Flow nodes');
      }
      var validation = inspectFlowRepresentation(flowId, flow, config || {});
      if (!validation.valid) {
        fail('SCHEMA_VALIDATION_FAILED', 'Flow contains invalid nodes: ' + validation.errors.join('; '), {
          flowId: String(flowId || flow.id || ''), errors: validation.errors,
        });
      }
      return flow;
    }

    function createFlow(body) {
      body = normalizeFlowRepresentation(body, false);
      return getConfig().then(function (config) {
        assertFlowRepresentation(body.id || '', body, config);
        return createSectionItem('flows', body, 'fl');
      });
    }

    function replaceFlow(flowId, body) {
      body = normalizeFlowRepresentation(body, true);
      return getConfig().then(function (config) {
        assertFlowRepresentation(flowId, body, config);
        return replaceSectionItem('flows', flowId, body);
      });
    }

    function patchFlow(flowId, patch) {
      return itemInConfig('flows', cleanId(flowId, 'flowId')).then(function (current) {
        ensureMutable(current, 'Flow');
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          fail('SCHEMA_VALIDATION_FAILED', 'PATCH must leave a Flow object');
        }
        next = normalizeFlowRepresentation(next, true);
        return getConfig().then(function (config) {
          assertFlowRepresentation(flowId, next, config);
          return replaceSectionItem('flows', flowId, next);
        });
      }).then(function () { return itemInConfig('flows', cleanId(flowId, 'flowId')); });
    }

    function flowNode(flow, nodeId) {
      var nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
      return nodes.find(function (node) { return node && String(node.nodeId || node.id || '') === nodeId; }) || null;
    }

    function getFlowNode(flowId, nodeId) {
      nodeId = cleanId(nodeId, 'nodeId');
      return getFlow(flowId).then(function (flow) {
        var node = flowNode(flow, nodeId);
        if (!node) fail('RESOURCE_NOT_FOUND', 'Flow node does not exist: ' + nodeId);
        return clone(node);
      });
    }

    function createFlowNode(flowId, body) {
      body = cloneObject(body);
      var nodeId = cleanId(body.nodeId || body.id || randomId('node'), 'nodeId');
      return getFlow(flowId).then(function (flow) {
        ensureMutable(flow, 'Flow');
        if (flowNode(flow, nodeId)) fail('RESOURCE_CONFLICT', 'Flow node already exists: ' + nodeId);
        body.nodeId = nodeId;
        delete body.id;
        flow.nodes = Array.isArray(flow.nodes) ? flow.nodes.slice() : [];
        flow.nodes.push(body);
        return replaceFlow(cleanId(flowId, 'flowId'), flow);
      }).then(function () { return getFlowNode(flowId, nodeId); });
    }

    function replaceFlowNode(flowId, nodeId, body) {
      nodeId = cleanId(nodeId, 'nodeId');
      body = cloneObject(body);
      if (body.nodeId && cleanId(body.nodeId, 'body nodeId') !== nodeId) {
        fail('RESOURCE_CONFLICT', 'Body nodeId does not match the addressed node');
      }
      return getFlow(flowId).then(function (flow) {
        ensureMutable(flow, 'Flow');
        var nodes = Array.isArray(flow.nodes) ? flow.nodes.slice() : [];
        var index = nodes.findIndex(function (node) { return node && String(node.nodeId || node.id || '') === nodeId; });
        if (index < 0) fail('RESOURCE_NOT_FOUND', 'Flow node does not exist: ' + nodeId);
        body.nodeId = nodeId;
        delete body.id;
        nodes[index] = body;
        flow.nodes = nodes;
        return replaceFlow(cleanId(flowId, 'flowId'), flow);
      }).then(function () { return getFlowNode(flowId, nodeId); });
    }

    function patchFlowNode(flowId, nodeId, patch) {
      return getFlowNode(flowId, nodeId).then(function (node) {
        var next = applyPatch(node, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          fail('SCHEMA_VALIDATION_FAILED', 'PATCH must leave a FlowNode object');
        }
        return replaceFlowNode(flowId, nodeId, next);
      });
    }

    function deleteFlowNode(flowId, nodeId) {
      nodeId = cleanId(nodeId, 'nodeId');
      return getFlow(flowId).then(function (flow) {
        ensureMutable(flow, 'Flow');
        var nodes = Array.isArray(flow.nodes) ? flow.nodes.slice() : [];
        var next = nodes.filter(function (node) { return String(node && (node.nodeId || node.id) || '') !== nodeId; });
        if (next.length === nodes.length) fail('RESOURCE_NOT_FOUND', 'Flow node does not exist: ' + nodeId);
        flow.nodes = next;
        return replaceFlow(cleanId(flowId, 'flowId'), flow);
      }).then(function () { return { flowId: cleanId(flowId), nodeId: nodeId, deleted: true }; });
    }

    function validateFlow(flowId) {
      flowId = cleanId(flowId, 'flowId');
      return Promise.all([itemInConfig('flows', flowId), getConfig()]).then(function (values) {
        return inspectFlowRepresentation(flowId, values[0], values[1] || {});
      });
    }

    function nodeTypeList(query) {
      var definitions = nodeTypes && Array.isArray(nodeTypes.TYPES) ? clone(nodeTypes.TYPES) : [];
      var match = String(query && query.match || '').trim().toLowerCase();
      if (match) definitions = definitions.filter(function (item) {
        return [item.type, item.label, item.description].join(' ').toLowerCase().indexOf(match) !== -1;
      });
      var categories = nodeTypes && Array.isArray(nodeTypes.CATEGORIES) ? nodeTypes.CATEGORIES : [];
      var includeDescription = !!match;
      var categoryByType = Object.create(null);
      categories.forEach(function (category) {
        if (!category || !Array.isArray(category.types)) return;
        category.types.forEach(function (type) {
          if (categoryByType[type]) return;
          categoryByType[type] = {
            id: String(category.id || '').trim() || 'uncategorized',
            label: String(category.label || '').trim() || '未分类',
          };
        });
      });
      var projected = definitions.map(function (item) {
        var category = categoryByType[item.type] || { id: 'uncategorized', label: '未分类' };
        var summary = {
          type: item.type,
          label: item.label,
          categoryId: category.id,
          categoryLabel: category.label,
        };
        if (includeDescription) summary.description = item.description;
        return summary;
      });
      var categoryCounts = [];
      var categoryCountById = Object.create(null);
      projected.forEach(function (item) {
        var key = item.categoryId;
        if (!categoryCountById[key]) {
          categoryCountById[key] = { categoryId: key, categoryLabel: item.categoryLabel, count: 0 };
          categoryCounts.push(categoryCountById[key]);
        }
        categoryCountById[key].count += 1;
      });
      var output = nodeTypePageWindow(projected, query);
      output.categoryCounts = categoryCounts;
      return output;
    }

    function getNodeType(nodeType) {
      nodeType = cleanId(nodeType, 'nodeType');
      var item = nodeTypes && typeof nodeTypes.getType === 'function'
        ? nodeTypes.getType(nodeType)
        : (nodeTypes && Array.isArray(nodeTypes.TYPES) ? nodeTypes.TYPES.find(function (candidate) { return candidate.type === nodeType; }) : null);
      if (!item) fail('RESOURCE_NOT_FOUND', 'Unknown node type: ' + nodeType);
      return Promise.resolve(clone(item));
    }

    function runIdOf(value) {
      return String(value && (value.runId || value.id || value.flowGroupRunId) || '').trim();
    }

    function matchesRunId(value, runId) {
      return !!value && (String(value.runId || '').trim() === runId || String(value.id || '').trim() === runId);
    }

    function rememberTransientRun(kind, targetId, executor, body) {
      var runId = randomId('run');
      var record = {
        id: runId,
        runId: runId,
        kind: kind,
        targetId: targetId,
        status: 'running',
        startedAt: Date.now(),
        input: clone(body || {}),
      };
      return operationRunStore.save(record).then(function (stored) {
        record = stored;
        Promise.resolve().then(executor).then(function (result) {
          record.status = 'success';
          record.result = clone(result);
          record.endedAt = Date.now();
          return operationRunStore.update(runId, record);
        }, function (error) {
          record.status = 'failed';
          record.error = String(error && error.message || error);
          record.endedAt = Date.now();
          return operationRunStore.update(runId, record);
        }).catch(function () {});
        return clone(record);
      });
    }

    function runOptionsFromBody(body, context) {
      body = cloneObject(body);
      var runOptions = cloneObject(body.options);
      Object.keys(body).forEach(function (key) {
        if (key !== 'options') runOptions[key] = clone(body[key]);
      });
      runOptions.assistantInvocationKind = isRunAssistantInvocation(context) ? 'runAssistant' : '';
      if (body.context !== undefined) {
        if (runOptions.initialContext === undefined) runOptions.initialContext = clone(body.context);
      }
      return runOptions;
    }

    function isRunAssistantInvocation(context) {
      return !!(context && context.assistantInvocationKind === 'runAssistant');
    }

    function assertAssistantLaunchAllowed(context, details) {
      if (!isRunAssistantInvocation(context)) return;
      fail(
        'RESOURCE_CONFLICT',
        'A runAssistant generation cannot start another Assistant generation',
        Object.assign({ invocationKind: 'runAssistant' }, details || {})
      );
    }

    function createFlowRun(flowId, body, context) {
      flowId = cleanId(flowId, 'flowId');
      body = cloneObject(body);
      if (body.nodeId) {
        var executeNode = options.executeNodeInstance || options.executeNode;
        return getFlowNode(flowId, cleanId(body.nodeId, 'nodeId')).then(function (node) {
          var nodeParams = node && node.params && typeof node.params === 'object' && !Array.isArray(node.params)
            ? node.params : {};
          if (String(nodeParams.confirmationMode || '') === 'deferred') {
            fail('SCHEMA_VALIDATION_FAILED', 'Deferred page actions cannot run as a single node; run the Flow together with its following waitForCondition node', {
              flowId: flowId,
              nodeId: String(node.nodeId || body.nodeId || ''),
            });
          }
          requireFunction(executeNode, 'executeNodeInstance');
          return rememberTransientRun('flowNode', flowId + '/' + body.nodeId, function () {
            return executeNode(node, {
              flowId: flowId,
              context: body.context || {},
              resetContext: body.resetContext !== false,
              runTabMode: body.runTabMode,
              assistantInvocationKind: isRunAssistantInvocation(context) ? 'runAssistant' : '',
            });
          }, body);
        });
      }
      return validateFlow(flowId).then(function (validation) {
        if (!validation.valid) {
          fail('SCHEMA_VALIDATION_FAILED', 'Flow is not runnable: ' + validation.errors.join('; '), {
            flowId: flowId,
            errors: validation.errors,
          });
        }
        var start = options.startFlowRun || (runCommands && (runCommands.startFlowRun || runCommands.startSessionRun));
        requireFunction(start, 'RunCommandService.startFlowRun');
        var startsSessionDirectly = !!(runCommands && start === runCommands.startSessionRun);
        var runOptions = runOptionsFromBody(body, context);
        var invocation = startsSessionDirectly
          ? start.call(runCommands, 'user:' + flowId, Object.assign({}, runOptions, { trigger: body.trigger || 'agent' }))
          : start.call(runCommands || null, flowId, body.trigger || 'agent', runOptions);
        return Promise.resolve(invocation).then(function (result) {
          var runId = runIdOf(result);
          if (!runId) fail('INTERNAL_ERROR', 'Flow runner did not return a runId');
          return Object.assign({ id: runId, runId: runId, flowId: flowId, status: 'running' }, clone(result || {}));
        });
      });
    }

    function createFlowGroupRun(groupId, body, context) {
      groupId = cleanId(groupId, 'groupId');
      body = cloneObject(body);
      return itemInConfig('flowGroups', groupId).then(function () {
        var run = options.runFlowGroup || (groupRunner && groupRunner.runFlowGroup);
        requireFunction(run, 'FlowGroupController.runFlowGroup');
        return Promise.resolve(run.call(groupRunner || null, groupId, runOptionsFromBody(body, context))).then(function (result) {
          var runId = runIdOf(result);
          if (!runId) fail('INTERNAL_ERROR', 'FlowGroup runner did not return a runId');
          return Object.assign({ id: runId, runId: runId, flowGroupId: groupId, kind: 'flowGroup', status: 'running' }, clone(result || {}));
        });
      });
    }

    function persistedRuns() {
      if (options.getRuns) return Promise.resolve(options.getRuns());
      if (configStore && typeof configStore.getRuns === 'function') return Promise.resolve(configStore.getRuns());
      return Promise.resolve([]);
    }

    function activeRuns() {
      if (!runQueries || typeof runQueries.getSessionsSummary !== 'function') return Promise.resolve([]);
      return Promise.resolve(runQueries.getSessionsSummary()).then(function (result) {
        return Array.isArray(result) ? result : (result && result.sessions || []);
      });
    }

    function findPersistedOrActiveRun(runId) {
      return persistedRuns().then(function (runs) {
        var found = runs.find(function (run) { return matchesRunId(run, runId); });
        if (found) return clone(found);
        return activeRuns().then(function (active) {
          var activeFound = active.find(function (run) { return matchesRunId(run, runId); });
          if (!activeFound) fail('RESOURCE_NOT_FOUND', 'Run does not exist: ' + runId);
          return clone(activeFound);
        });
      });
    }

    function listRuns(query) {
      query = query || {};
      return Promise.all([persistedRuns(), activeRuns(), operationRunStore.list()]).then(function (values) {
        var map = Object.create(null);
        values[0].concat(values[1], values[2]).forEach(function (run) {
          var id = runIdOf(run);
          if (id) map[id] = clone(run);
        });
        var runs = Object.keys(map).map(function (id) { return map[id]; }).filter(function (run) {
          if (query.flowId && String(run.flowId || '').replace(/^user:/, '') !== cleanId(query.flowId, 'flowId')) return false;
          if (query.status && String(run.status || '') !== String(query.status)) return false;
          return true;
        }).sort(function (left, right) { return Number(right.startedAt || 0) - Number(left.startedAt || 0); });
        return pageWindow(runs, query);
      });
    }

    function getRun(runId, optionsInput) {
      runId = cleanId(runId, 'runId');
      return operationRunStore.get(runId).then(function (operation) {
        if (operation) return operation;
        if (options.getRun) return Promise.resolve(options.getRun(runId, optionsInput || {}));
        if (runQueries && typeof runQueries.getSessionResult === 'function') {
          return Promise.resolve(runQueries.getSessionResult(runId, optionsInput || {})).catch(function () {
            return findPersistedOrActiveRun(runId);
          });
        }
        return findPersistedOrActiveRun(runId);
      });
    }

    function isActiveRun(run) {
      var status = String(run && run.status || '').trim().toLowerCase();
      return status === 'idle' || status === 'running' || status === 'queued'
        || status === 'starting' || status === 'pending' || status === 'paused' || status === 'pausing';
    }

    function deleteRun(runId) {
      runId = cleanId(runId, 'runId');
      return operationRunStore.get(runId).then(function (operation) {
        if (!operation) return null;
        if (isActiveRun(operation)) fail('RESOURCE_CONFLICT', 'An active Run cannot be deleted: ' + runId);
        return operationRunStore.remove(runId).then(function (removed) {
          if (!removed) fail('RESOURCE_NOT_FOUND', 'Run does not exist: ' + runId);
          return { id: runId, runId: runId, deleted: true, removed: 1 };
        });
      }).then(function (operationResult) {
        if (operationResult) return operationResult;
        return getRun(runId).then(function (run) {
          if (isActiveRun(run)) fail('RESOURCE_CONFLICT', 'An active Run cannot be deleted: ' + runId);
          var remove = requireFunction(deleteRunDependency, 'Run history deleteRun');
          return Promise.resolve(remove(runId, { preserveActive: true })).then(function (result) {
            var removed = Math.max(0, Number(result && result.removed) || 0);
            if (!removed) fail('RESOURCE_CONFLICT', 'Run is not a deletable persisted history record: ' + runId);
            return { id: runId, runId: runId, deleted: true, removed: removed };
          });
        });
      });
    }

    function deleteRunsBefore(body) {
      body = cloneObject(body);
      var before = String(body.before || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(before)) {
        fail('SCHEMA_VALIDATION_FAILED', 'Run retention before must be an ISO-8601 timestamp');
      }
      var cutoff = Date.parse(before);
      if (!isFinite(cutoff) || cutoff <= 0) fail('SCHEMA_VALIDATION_FAILED', 'Run retention before is invalid');
      var clearBefore = requireFunction(clearRunsBeforeDependency, 'Run history clearRunsBefore');
      return Promise.resolve(clearBefore(cutoff, { preserveActive: true })).then(function (result) {
        var removed = Math.max(0, Number(result && result.removed) || 0);
        return operationRunStore.list().then(function (operations) {
          var ids = operations.filter(function (operation) {
            return !isActiveRun(operation) && Number(operation && operation.startedAt) > 0
              && Number(operation.startedAt) < cutoff;
          }).map(runIdOf).filter(Boolean);
          return ids.reduce(function (chain, id) {
            return chain.then(function (count) {
              return operationRunStore.remove(id).then(function (didRemove) { return count + (didRemove ? 1 : 0); });
            });
          }, Promise.resolve(removed));
        }).then(function (totalRemoved) {
          return {
            before: new Date(cutoff).toISOString(),
            cutoff: cutoff,
            removed: totalRemoved,
            activeRunsPreserved: true,
          };
        });
      });
    }

    function getRunReport(runId) {
      if (options.getRunReport) return Promise.resolve(options.getRunReport(runId));
      return getRun(runId, { includeFinalOutput: true }).then(function (run) {
        return {
          runId: cleanId(runId),
          status: run.status || '',
          startedAt: run.startedAt || 0,
          endedAt: run.endedAt || 0,
          result: run.result === undefined ? null : run.result,
          error: run.error || '',
          nodeStatuses: run.nodeStatuses || {},
          logs: Array.isArray(run.logs) ? run.logs : [],
        };
      });
    }

    function getRunDebugSnapshot(runId) {
      if (options.getRunDebugSnapshot) return Promise.resolve(options.getRunDebugSnapshot(runId));
      return getRun(runId, { includeDebugTrace: true }).then(function (run) {
        return {
          runId: cleanId(runId),
          status: run.status || '',
          context: run.ctx || run.context || run.initialContext || {},
          debugTrace: run.debugTrace || [],
          nodeStatuses: run.nodeStatuses || {},
        };
      });
    }

    function runSchedule(scheduleId, body, context) {
      return itemInConfig('schedules', cleanId(scheduleId, 'scheduleId')).then(function (schedule) {
        var task = schedule.task || {};
        var flowGroupId = schedule.flowGroupId || schedule.groupId || task.flowGroupId || task.groupId;
        var rawTaskKind = String(schedule.taskType || schedule.targetKind || task.kind || task.type || '').trim();
        var taskKind = rawTaskKind || (flowGroupId ? 'flowGroup' : ((schedule.assistantId || schedule.message
          || schedule.prompt || task.assistantId || task.message) ? 'conversation' : 'flow'));
        if ((taskKind === 'flowGroup' || taskKind === 'flow-group') && flowGroupId) {
          var groupRun = options.runFlowGroup || (groupRunner && groupRunner.runFlowGroup);
          requireFunction(groupRun, 'FlowGroupController.runFlowGroup');
          return groupRun.call(groupRunner || null, String(flowGroupId).replace(/^flowGroup:/, ''), Object.assign({}, body || {}, {
            trigger: 'schedule:' + scheduleId,
            entry: 'schedule',
            scheduleId: scheduleId,
            forceCdpKeepAlive: true,
          }));
        }
        var flowId = schedule.flowId || task.flowId;
        if (flowId) return createFlowRun(flowId, Object.assign({}, body || {}, { trigger: 'schedule:' + scheduleId, entry: 'schedule', forceCdpKeepAlive: true }), context);
        assertAssistantLaunchAllowed(context, { scheduleId: String(scheduleId || '') });
        if (options.runSchedule) return options.runSchedule(schedule, body || {});
        fail('SCHEMA_VALIDATION_FAILED', 'Schedule does not address a runnable Flow');
      });
    }

    function runScript(scriptId, body) {
      scriptId = cleanId(scriptId, 'scriptId');
      return itemInConfig('scripts', scriptId).then(function (script) {
        var executor = options.runScript || options.scriptRunner && options.scriptRunner.runScript;
        requireFunction(executor, 'scriptRunner.runScript');
        return rememberTransientRun('script', scriptId, function () {
          return executor.call(options.scriptRunner || null, script.code || script.source || '', Object.assign({}, body || {}, { scriptId: scriptId }));
        }, body);
      });
    }

    function conversationList(query) {
      var stateApi = requireDependency(conversationState, 'ConversationState');
      var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
      return conversationReady.then(function () {
        var listJournalMetadata = typeof journalApi.listMetadata === 'function'
          ? journalApi.listMetadata
          : requireFunction(journalApi.listActiveConversations, 'ConversationJournalStore.listActiveConversations');
        return Promise.all([
          Promise.resolve(requireFunction(stateApi.load, 'ConversationState.load').call(stateApi)),
          /* The topic list must reflect terminal generations too.  The old
             listActiveConversations() source intentionally omits completed
             metadata, so a stale ConversationState.status=running leaked
             into the UI forever after a generation had finished. */
          Promise.resolve(listJournalMetadata.call(journalApi)),
        ]);
      }).then(function (values) {
        var state = values[0];
        var metadataByConversation = Object.create(null);
        (Array.isArray(values[1]) ? values[1] : []).forEach(function (metadata) {
          if (metadata && metadata.conversationId) metadataByConversation[metadata.conversationId] = metadata;
        });
        var topics = state && state.topics || {};
        var order = Array.isArray(state && state.topicOrder) ? state.topicOrder : Object.keys(topics);
        var items = order.map(function (id) {
          var topic = own(topics, id);
          if (!topic) return null;
          var metadata = metadataByConversation[id];
          return terminalConversationStatus(journalApi, id, metadata).then(function (terminalStatus) {
            return {
              topicId: id,
              id: id,
              assistantId: topic.assistantId || '',
              name: topic.name || '',
              objective: topic.objective || '',
              status: conversationStatus(topic, metadata, terminalStatus),
              archived: topic.archived === true,
              createdAt: topic.createdAt || 0,
              updatedAt: topic.updatedAt || 0,
            };
          });
        }).filter(Boolean);
        return Promise.all(items).then(function (resolvedItems) {
          var filtered = resolvedItems;
          if (!query || query.includeArchived !== true) filtered = filtered.filter(function (item) { return item.archived !== true; });
          if (query && query.status) filtered = filtered.filter(function (item) { return item.status === String(query.status); });
          var match = String(query && query.q || '').trim().toLowerCase();
          if (match) filtered = filtered.filter(function (item) {
            return [item.id, item.name, item.objective].join(' ').toLowerCase().indexOf(match) !== -1;
          });
          return pageWindow(filtered, query);
        });
      });
    }

    function sanitizeConversation(topic) {
      var output = clone(topic || {});
      delete output.history;
      delete output.events;
      delete output.lastAgentMessage;
      return output;
    }

    var TERMINAL_GENERATION_TYPES = [
      'generation_completed', 'generation_failed', 'generation_cancelled',
      'generation_truncated', 'generation_blocked',
    ];
    var TERMINAL_GENERATION_STATUS = {
      generation_completed: 'completed',
      generation_failed: 'failed',
      generation_cancelled: 'cancelled',
      generation_truncated: 'truncated',
      generation_blocked: 'blocked',
    };

    function terminalConversationStatus(journalApi, conversationId, metadata) {
      if (!journalApi || typeof journalApi.queryEvents !== 'function') return Promise.resolve('');
      return Promise.resolve().then(function () {
        return journalApi.queryEvents(conversationId, {
          types: TERMINAL_GENERATION_TYPES,
          limit: 1,
        });
      }).then(function (page) {
        var event = page && Array.isArray(page.events) ? page.events[page.events.length - 1] : null;
        if (!event || !TERMINAL_GENERATION_STATUS[event.type]) return '';
        var active = metadata && metadata.activeGeneration;
        /* A terminal event from an older generation must not hide a newer run. */
        if (active && active.generationId
            && String(active.generationId) !== String(event.generationId || '')) return '';
        return TERMINAL_GENERATION_STATUS[event.type];
      }).catch(function () { return ''; });
    }

    function conversationStatus(topic, metadata, terminalStatus) {
      var generation = metadata && metadata.activeGeneration;
      if (terminalStatus) return terminalStatus;
      if (generation && generation.state) return String(generation.state);
      var status = String(topic && topic.status || '');
      return ['starting', 'running', 'waiting_user', 'cancelling'].indexOf(status) !== -1
        ? 'idle' : status || 'idle';
    }

    function getConversation(conversationId, query) {
      conversationId = cleanId(conversationId, 'conversationId');
      var stateApi = requireDependency(conversationState, 'ConversationState');
      var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
      return conversationReady.then(function () {
        return Promise.all([
          Promise.resolve(requireFunction(stateApi.load, 'ConversationState.load').call(stateApi)),
          Promise.resolve(requireFunction(journalApi.getMetadata, 'ConversationJournalStore.getMetadata').call(journalApi, conversationId)),
        ]);
      }).then(function (values) {
        var state = values[0];
        var metadata = values[1];
        var topic = own(state && state.topics, conversationId);
        if (!topic) fail('RESOURCE_NOT_FOUND', 'Conversation does not exist: ' + conversationId);
        function project(value, terminalStatus) {
          var output = sanitizeConversation(value || topic);
          output.status = conversationStatus(output, metadata, terminalStatus);
          return output;
        }
        if (topic.archived && typeof stateApi.loadArchivedTopic === 'function') {
          return Promise.resolve(stateApi.loadArchivedTopic(conversationId)).then(function (archived) {
            return terminalConversationStatus(journalApi, conversationId, metadata).then(function (terminalStatus) {
              return project(archived, terminalStatus);
            });
          });
        }
        return terminalConversationStatus(journalApi, conversationId, metadata).then(function (terminalStatus) {
          return project(topic, terminalStatus);
        });
      });
    }

    function createConversation(body) {
      var stateApi = requireDependency(conversationState, 'ConversationState');
      var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
      return conversationReady.then(function () {
        return Promise.resolve(requireFunction(stateApi.createTopic, 'ConversationState.createTopic').call(stateApi, cloneObject(body)));
      }).then(function (result) {
        var id = String(result && (result.topicId || result.id || result.topic && result.topic.topicId) || body && body.topicId || '').trim();
        if (!id) fail('INTERNAL_ERROR', 'ConversationState.createTopic did not return a topicId');
        var topic = result && result.topic || result || {};
        return Promise.resolve(requireFunction(journalApi.putMetadata, 'ConversationJournalStore.putMetadata').call(journalApi, id, {
          conversationId: id,
          assistantId: String(topic.assistantId || body && body.assistantId || ''),
          serviceId: String(topic.modelServiceId || body && body.modelServiceId || ''),
          activeGeneration: null,
          createdAt: Number(topic.createdAt) || Date.now(),
          updatedAt: Number(topic.updatedAt) || Date.now(),
        })).then(function () { return getConversation(id, {}); });
      });
    }

    function assertConversationIdle(conversationId, action) {
      var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
      return Promise.resolve(requireFunction(journalApi.getMetadata, 'ConversationJournalStore.getMetadata').call(journalApi, conversationId)).then(function (metadata) {
        var active = metadata && metadata.activeGeneration;
        if (active && ['completed', 'failed', 'cancelled', 'truncated', 'blocked'].indexOf(String(active.state || '')) === -1) {
          fail('RESOURCE_CONFLICT', 'An active Conversation cannot be ' + action, {
            conversationId: conversationId, generationId: active.generationId || '', state: active.state || '',
          });
        }
        return metadata;
      });
    }

    function patchConversation(conversationId, patch) {
      var stateApi = requireDependency(conversationState, 'ConversationState');
      return getConversation(conversationId, {}).then(function (current) {
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) fail('SCHEMA_VALIDATION_FAILED', 'Conversation patch must leave an object');
        var keys = Object.keys(patch || {});
        var archiveOnly = keys.length > 0 && keys.every(function (key) { return key === 'archived'; });
        var touchesArchive = keys.indexOf('archived') !== -1;
        if (current.archived === true) {
          if (archiveOnly && next.archived === true) return current;
          fail('RESOURCE_CONFLICT', 'Archived Conversations are immutable and cannot be restored');
        }
        if (next.archived === true) {
          if (!archiveOnly) fail('SCHEMA_VALIDATION_FAILED', 'Archive must be the only Conversation change in one PATCH');
          return assertConversationIdle(conversationId, 'archived').then(function (metadata) {
            var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
            if (!metadata) return null;
            return requireFunction(journalApi.putMetadata, 'ConversationJournalStore.putMetadata').call(journalApi, conversationId, { archived: true });
          }).then(function () {
            return Promise.resolve(requireFunction(stateApi.archiveTopic, 'ConversationState.archiveTopic').call(stateApi, conversationId));
          }).then(function (result) {
            return sanitizeConversation(result && result.archivedTopic || {});
          });
        }
        if (touchesArchive) fail('RESOURCE_CONFLICT', 'Conversation unarchive is not supported');
        var update = {};
        ['name', 'objective', 'assistantId', 'modelServiceId'].forEach(function (key) {
          if (next[key] !== current[key]) update[key] = next[key] === undefined ? '' : next[key];
        });
        function patchTouchesKey(key) {
          return keys.some(function (entry) {
            return entry === key || entry === '/' + key || String(entry).indexOf('/' + key + '/') === 0;
          });
        }
        ['assistantSnapshot', 'budgets', 'contextMeta'].forEach(function (key) {
          if (patchTouchesKey(key) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) {
            update[key] = next[key];
          }
        });
        if (Object.prototype.hasOwnProperty.call(update, 'assistantId') && !String(update.assistantId || '').trim()) {
          fail('SCHEMA_VALIDATION_FAILED', 'Conversation assistantId cannot be removed');
        }
        if (!Object.keys(update).length) return current;
        var identityChanged = Object.prototype.hasOwnProperty.call(update, 'assistantId')
          || Object.prototype.hasOwnProperty.call(update, 'modelServiceId');
        var idle = identityChanged ? assertConversationIdle(conversationId, 'reassigned') : Promise.resolve(null);
        return idle.then(function () {
          return Promise.resolve(requireFunction(stateApi.updateTopic, 'ConversationState.updateTopic').call(stateApi, conversationId, update));
        }).then(function () {
          if (!identityChanged) return null;
          var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
          var metadataPatch = {};
          if (Object.prototype.hasOwnProperty.call(update, 'assistantId')) metadataPatch.assistantId = String(update.assistantId || '');
          if (Object.prototype.hasOwnProperty.call(update, 'modelServiceId')) metadataPatch.serviceId = String(update.modelServiceId || '');
          return requireFunction(journalApi.putMetadata, 'ConversationJournalStore.putMetadata').call(journalApi, conversationId, metadataPatch);
        }).then(function () { return getConversation(conversationId, {}); });
      });
    }

    function deleteConversation(conversationId) {
      conversationId = cleanId(conversationId, 'conversationId');
      var stateApi = requireDependency(conversationState, 'ConversationState');
      return getConversation(conversationId, {}).then(function (current) {
        void current;
        return assertConversationIdle(conversationId, 'deleted');
      }).then(function () {
        var journalApi = requireDependency(conversationJournal, 'ConversationJournalStore');
        return Promise.resolve(requireFunction(journalApi.deleteConversation, 'ConversationJournalStore.deleteConversation').call(journalApi, conversationId));
      }).then(function () {
        return Promise.resolve(requireFunction(stateApi.deleteTopic, 'ConversationState.deleteTopic').call(stateApi, conversationId));
      }).then(function () { return { id: conversationId, topicId: conversationId, deleted: true }; });
    }

    // Conversation operations reuse the ConversationCommandBus (the only
    // ingress for generations) through the non-interactive mcp surface.
    var CONVERSATION_COMMAND_ERROR_CODES = Object.freeze({
      CONVERSATION_NOT_FOUND: 'RESOURCE_NOT_FOUND',
      INTERACTION_NOT_FOUND: 'RESOURCE_NOT_FOUND',
      SERVICE_NOT_FOUND: 'SCHEMA_VALIDATION_FAILED',
      INVALID_COMMAND: 'SCHEMA_VALIDATION_FAILED',
      ASSISTANT_MISMATCH: 'RESOURCE_CONFLICT',
      GENERATION_CONFLICT: 'RESOURCE_CONFLICT',
      GENERATION_STALE: 'RESOURCE_CONFLICT',
      CONVERSATION_READ_ONLY: 'RESOURCE_CONFLICT',
      INTERACTION_EXPIRED: 'RESOURCE_CONFLICT',
      CANCELLED: 'RESOURCE_CONFLICT',
      CAPABILITY_UNAVAILABLE: 'FORBIDDEN',
      CONVERSATION_EXISTS: 'RESOURCE_CONFLICT',
      CONVERSATION_ACTIVE: 'RESOURCE_CONFLICT',
    });

    function dispatchConversationCommand(command, input) {
      var bus = typeof conversationCommands === 'function' ? conversationCommands() : conversationCommands;
      if (!bus || typeof bus.dispatchInternal !== 'function') {
        fail('TEMPORARILY_UNAVAILABLE', 'Conversation command bus is not wired to AgentResourceService');
      }
      return Promise.resolve(bus.dispatchInternal(
        { command: command, input: input },
        { type: 'mcp', instanceId: 'mcp:conversation-resource' }
      )).then(function (response) {
        if (response && response.ok === true) return clone(response.result);
        var error = response && response.error || {};
        fail(
          CONVERSATION_COMMAND_ERROR_CODES[error.code] || 'UPSTREAM_FAILED',
          String(error.message || ('Conversation command failed: ' + command)),
          error.details
        );
      });
    }

    function startConversationTurn(conversationId, body, context) {
      assertAssistantLaunchAllowed(context, { conversationId: String(conversationId || '') });
      conversationId = cleanId(conversationId, 'conversationId');
      body = cloneObject(body);
      var content = String(body.message || '').trim();
      if (!content) fail('SCHEMA_VALIDATION_FAILED', 'Conversation message is required');
      return getConversation(conversationId, {}).then(function (topic) {
        if (topic.archived === true) fail('RESOURCE_CONFLICT', 'Archived Conversations cannot start a new turn');
        var assistantId = String(body.assistantId || topic.assistantId || '').trim();
        if (!assistantId) fail('SCHEMA_VALIDATION_FAILED', 'Conversation turn requires an assistantId');
        var stateApi = requireDependency(conversationState, 'ConversationState');
        return Promise.resolve(requireFunction(stateApi.load, 'ConversationState.load').call(stateApi)).then(function (state) {
          var assistant = own(state && state.assistants, assistantId);
          if (!assistant) fail('SCHEMA_VALIDATION_FAILED', 'Assistant does not exist: ' + assistantId);
          var settings = assistant.settings && typeof assistant.settings === 'object' ? assistant.settings : {};
          var serviceId = String(body.serviceId || topic.modelServiceId || assistant.modelServiceId || '').trim();
          if (!serviceId) fail('SCHEMA_VALIDATION_FAILED', 'Conversation turn requires a serviceId');
          var commandId = randomId('command');
          var budgets = Object.assign({
            maxModelRequests: Math.max(1, Number(settings.maxIterations) || 30),
            maxIterations: Math.max(1, Number(settings.maxIterations) || 30),
            maxToolCalls: Math.max(0, Number(settings.maxToolCalls) || 100),
            maxWallTimeMs: 15 * 60 * 1000,
          }, cloneObject(body.budgets));
          return dispatchConversationCommand('START_TURN', {
            schemaVersion: 1,
            commandId: commandId,
            conversationId: conversationId,
            assistantId: assistantId,
            serviceId: serviceId,
            message: {
              id: commandId + ':message',
              content: content,
              attachments: Array.isArray(body.attachments) ? clone(body.attachments) : [],
            },
            entry: {
              type: 'conversation',
              currentResource: '/conversations/' + encodeURIComponent(conversationId),
              tabId: Math.max(0, Number(body.tabId || topic.activeTabId) || 0),
            },
            budgets: budgets,
            preferences: {
              streamOutput: false,
              contextCompression: settings.contextCompression === 'off' ? 'off' : 'auto',
            },
            requestedAt: Date.now(),
          }).then(function (result) {
            return Object.assign({ conversationId: conversationId, commandId: commandId }, result || {});
          });
        });
      });
    }

    function listConversationEvents(conversationId, query) {
      conversationId = cleanId(conversationId, 'conversationId');
      query = cloneObject(query);
      var input = { conversationId: conversationId };
      var cursor = {};
      if (query.afterSequence !== undefined) cursor.afterSequence = Number(query.afterSequence);
      if (query.beforeSequence !== undefined) cursor.beforeSequence = Number(query.beforeSequence);
      if (Object.keys(cursor).length) input.cursor = cursor;
      if (query.limit !== undefined) input.limit = Number(query.limit);
      if (query.includePayloads !== undefined) input.includePayloads = query.includePayloads === true;
      input.branchId = query.branchId;
      input.generationId = query.generationId;
      input.actorId = query.actorId;
      input.types = query.types;
      input.q = query.q;
      return Promise.all([
        dispatchConversationCommand('GET_EVENTS', input),
        dispatchConversationCommand('GET_CONVERSATION', { conversationId: conversationId }),
      ]).then(function (values) {
        var snapshot = values[1] || {};
        return Object.assign({}, values[0], {
          conversationId: conversationId,
          assistantId: String(snapshot.assistantId || ''),
          serviceId: String(snapshot.serviceId || ''),
          lastSequence: Number(snapshot.lastSequence) || 0,
          activeGeneration: snapshot.activeGeneration || null,
          lineage: snapshot.lineage || null,
        });
      });
    }

    function searchConversationEvents(conversationId, query) {
      conversationId = cleanId(conversationId, 'conversationId');
      query = cloneObject(query);
      var fromSequence = query.fromSequence === undefined ? 0 : Number(query.fromSequence);
      var toSequence = query.toSequence === undefined ? 0 : Number(query.toSequence);
      var cursor = {};
      // GET_EVENTS exposes a single directional cursor. Use the lower bound
      // when both bounds are present and trim the upper bound below.
      if (fromSequence > 0) cursor.afterSequence = fromSequence - 1;
      else if (toSequence > 0 && toSequence < Number.MAX_SAFE_INTEGER) cursor.beforeSequence = toSequence + 1;
      return dispatchConversationCommand('GET_EVENTS', {
        conversationId: conversationId,
        cursor: cursor,
        limit: query.limit === undefined ? 100 : Number(query.limit),
        includePayloads: query.includePayloads === true,
        branchId: query.branchId, generationId: query.generationId, actorId: query.actorId,
        types: query.types, q: query.q,
      }).then(function (page) {
        if (!toSequence || !page || !Array.isArray(page.events)) return page;
        var events = page.events.filter(function (event) { return Number(event.sequence) <= toSequence; });
        return Object.assign({}, page, { events: events });
      });
    }

    function cancelConversationGeneration(conversationId, generationId) {
      conversationId = cleanId(conversationId, 'conversationId');
      generationId = cleanId(generationId, 'generationId');
      return dispatchConversationCommand('CANCEL_GENERATION', {
        conversationId: conversationId,
        generationId: generationId,
        reason: 'Cancelled through the ARP Conversation resource',
      }).then(function (result) {
        return Object.assign({ conversationId: conversationId, generationId: generationId }, result || {});
      });
    }

    function exportConversationArchive(conversationId, query) {
      conversationId = cleanId(conversationId, 'conversationId');
      query = cloneObject(query);
      var exporter = typeof conversationExport === 'function' ? conversationExport : null;
      if (!exporter) fail('TEMPORARILY_UNAVAILABLE', 'Conversation export is not wired to AgentResourceService');
      return getConversation(conversationId, {}).then(function () {
        return Promise.resolve(exporter({
          conversationId: conversationId,
          includeReasoning: query.includeReasoning !== false,
          includePayloads: query.includePayloads !== false,
        }));
      }).then(function (backup) {
        backup = backup || {};
        var files = backup.files && typeof backup.files === 'object' ? backup.files : backup;
        if (!files || typeof files !== 'object' || Array.isArray(files)) {
          fail('UPSTREAM_FAILED', 'Conversation export did not return backup files');
        }
        return {
          conversationId: conversationId,
          manifest: clone(backup.manifest || null),
          files: clone(files),
        };
      });
    }

    function knowledgeList(query) {
      var api = requireDependency(knowledge, 'Knowledge');
      query = clone(query || {});
      if (query.q && !query.query) query.query = query.q;
      delete query.q;
      var method = query && query.mode === 'grep' ? api.grep : (query && query.mode === 'relevance' ? api.search : api.list);
      return Promise.resolve(requireFunction(method, 'Knowledge query').call(api, query)).then(function (result) {
        return clone(result || {});
      });
    }

    function getKnowledge(knowledgeId) {
      var api = requireDependency(knowledge, 'Knowledge');
      return Promise.resolve(requireFunction(api.get, 'Knowledge.get').call(api, { id: cleanId(knowledgeId, 'knowledgeId') })).then(function (result) {
        var item = result && result.item !== undefined ? result.item : result;
        if (!item) fail('RESOURCE_NOT_FOUND', 'Knowledge does not exist: ' + knowledgeId);
        return clone(item);
      });
    }

    function createKnowledge(body) {
      var api = requireDependency(knowledge, 'Knowledge');
      return Promise.resolve(requireFunction(api.upsert, 'Knowledge.upsert').call(api, cloneObject(body))).then(function (result) {
        var item = result && result.item !== undefined ? result.item : result;
        if (!item) fail('INTERNAL_ERROR', 'Knowledge.upsert did not return an item');
        return clone(item);
      });
    }

    function replaceKnowledge(knowledgeId, body) {
      knowledgeId = cleanId(knowledgeId, 'knowledgeId');
      body = cloneObject(body);
      if (body.id && cleanId(body.id, 'body knowledgeId') !== knowledgeId) fail('RESOURCE_CONFLICT', 'Body id does not match Knowledge resource');
      body.id = knowledgeId;
      return getKnowledge(knowledgeId).then(function (current) {
        ensureMutable(current, 'Knowledge');
        return createKnowledge(body);
      });
    }

    function patchKnowledge(knowledgeId, patch) {
      return getKnowledge(knowledgeId).then(function (current) {
        ensureMutable(current, 'Knowledge');
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) fail('SCHEMA_VALIDATION_FAILED', 'Knowledge patch must leave an object');
        return replaceKnowledge(knowledgeId, next);
      });
    }

    function deleteKnowledge(knowledgeId) {
      var api = requireDependency(knowledge, 'Knowledge');
      knowledgeId = cleanId(knowledgeId, 'knowledgeId');
      return getKnowledge(knowledgeId).then(function (current) {
        ensureMutable(current, 'Knowledge');
        return Promise.resolve(requireFunction(api.remove, 'Knowledge.remove').call(api, { id: knowledgeId }));
      }).then(function () { return { id: knowledgeId, deleted: true }; });
    }

    function projectKnowledgeSettings(value) {
      value = value && typeof value === 'object' ? value : {};
      return {
        enabled: value.enabled !== false,
        autoCapture: value.autoCapture !== false,
      };
    }

    function getKnowledgeSettings() {
      var api = requireDependency(knowledge, 'Knowledge');
      return Promise.resolve(requireFunction(api.load, 'Knowledge.load').call(api)).then(function (state) {
        return projectKnowledgeSettings(state && state.settings);
      });
    }

    function updateKnowledgeSettings(patch) {
      var api = requireDependency(knowledge, 'Knowledge');
      return getKnowledgeSettings().then(function (current) {
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          fail('SCHEMA_VALIDATION_FAILED', 'Knowledge Settings patch must leave an object');
        }
        var allowed = {
          enabled: true, autoCapture: true,
        };
        Object.keys(next).forEach(function (key) {
          if (!allowed[key]) fail('SCHEMA_VALIDATION_FAILED', 'Unknown Knowledge Settings field: ' + key);
        });
        return Promise.resolve(requireFunction(api.updateSettings, 'Knowledge.updateSettings').call(api, next));
      }).then(function (result) {
        return projectKnowledgeSettings(result && result.settings !== undefined ? result.settings : result);
      });
    }

    function resourceSegment(value) {
      return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
        return '%' + character.charCodeAt(0).toString(16).toUpperCase();
      });
    }

    function skillPaths(skillId) {
      var href = '/skills/' + resourceSegment(skillId);
      return {
        href: href,
        instructionsHref: href + '/instructions',
        resourcesHref: href + '/resources',
      };
    }

    function managedSkillSource(item) {
      var source = item && item.source && typeof item.source === 'object' ? item.source : {};
      var key = String(source.key || '');
      var main = /^skill-(builtin|import):([^:]+)$/.exec(key);
      var resource = /^skill-(builtin|import):([^:]+):resource:(.+)$/.exec(key);
      if (!main && !resource) return null;
      return {
        kind: (main || resource)[1],
        id: (main || resource)[2],
        key: 'skill-' + (main || resource)[1] + ':' + (main || resource)[2],
        resourcePath: resource ? resource[3] : '',
      };
    }

    function isManagedCatalogSkill(item) {
      var source = item && item.source || {};
      return !!(managedSkillSource(item)
        || source.importer === 'builtin-skill-loader'
        || source.importer === 'skill-knowledge');
    }

    function listAllKnowledgeSkills() {
      if (!knowledge || typeof knowledge.list !== 'function') return Promise.resolve([]);
      var items = [];
      var cursor = 0;
      var visited = Object.create(null);
      function readPage() {
        var cursorKey = String(cursor);
        if (visited[cursorKey]) return Promise.resolve(items);
        visited[cursorKey] = true;
        return Promise.resolve(knowledge.list({
          sourceKind: 'skill', includeArchived: true, includeStale: true, cursor: cursor, limit: 120,
        })).then(function (result) {
          items = items.concat(result && (result.items || result.matches) || []);
          var next = result && result.nextCursor;
          if (next === null || next === undefined || next === '') return items;
          cursor = next;
          return readPage();
        });
      }
      return readPage();
    }

    function listAllCatalogSkills() {
      var items = [];
      var cursor = '';
      function readPage() {
        return Promise.resolve(skillCatalog.list({
          includeArchived: true, includeDisabled: true, cursor: cursor, limit: 100,
        })).then(function (result) {
          items = items.concat(result && result.items || []);
          if (!result || !result.nextCursor) return items;
          cursor = result.nextCursor;
          return readPage();
        });
      }
      return readPage();
    }

    function skillSearchUnits(value) {
      var input = String(value || '').toLowerCase().trim();
      var units = Object.create(null);
      input.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).forEach(function (part) { units[part] = true; });
      var han = input.replace(/[^\u3400-\u9fff]/g, '');
      for (var index = 0; index < han.length; index += 1) {
        units[han.charAt(index)] = true;
        if (index + 1 < han.length) units[han.slice(index, index + 2)] = true;
      }
      return units;
    }

    function skillSearchScore(item, query) {
      query = String(query || '').toLowerCase().trim();
      if (!query) return 0;
      var haystack = [
        item.id, item.name, item.path, item.kind, item.description, item.summary,
        (item.tags || []).join(' '),
      ].join(' ').toLowerCase();
      var score = haystack.indexOf(query) === -1 ? 0 : 1000;
      var queryUnits = skillSearchUnits(query);
      var textUnits = skillSearchUnits(haystack);
      Object.keys(queryUnits).forEach(function (unit) {
        if (textUnits[unit]) score += unit.length > 1 ? 8 : 1;
      });
      return score;
    }

    function managedSkillSummary(item) {
      var managed = managedSkillSource(item);
      if (!managed || managed.resourcePath) return null;
      var paths = skillPaths(managed.id);
      var builtIn = managed.kind === 'builtin' || item.builtIn === true || item.protected === true;
      return Object.assign({
        id: managed.id,
        knowledgeId: String(item.id || ''),
        name: String(item.title || managed.id).replace(/^Skill:\s*/i, ''),
        description: String(item.summary || ''),
        version: String(item.source && item.source.version || '1'),
        source: clone(item.source || {}),
        resourceCount: 0,
        tags: clone(Array.isArray(item.tags) ? item.tags : []),
        enabled: item.archived !== true,
        archived: item.archived === true,
        managedSkill: true,
        builtinSkill: builtIn,
        builtIn: builtIn,
        protected: builtIn,
        createdAt: Number(item.createdAt) || 0,
        updatedAt: Number(item.updatedAt) || 0,
      }, paths);
    }

    function projectUserResource(skillId, value, index) {
      var item = value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : { content: value };
      var id = String(item.id || 'resource-' + (index + 1));
      var path = String(item.path || item.name || id);
      return Object.assign({}, item, {
        id: id,
        path: path,
        kind: String(item.kind || 'reference'),
        mediaType: String(item.mediaType || item.type || 'text/plain'),
        href: skillPaths(skillId).resourcesHref + '/' + resourceSegment(id),
      });
    }

    function projectUserSkill(item, summaryOnly) {
      item = clone(item);
      var paths = skillPaths(item.id);
      var resources = (Array.isArray(item.resources) ? item.resources : []).map(function (resource, index) {
        return projectUserResource(item.id, resource, index);
      });
      var projected = Object.assign({}, item, paths, {
        resourceCount: resources.length,
        resources: summaryOnly ? [] : resources,
        managedSkill: false,
      });
      if (summaryOnly) delete projected.instructions;
      return projected;
    }

    function resourceKind(path, item) {
      var tags = Array.isArray(item && item.tags) ? item.tags : [];
      if (/^SKILL\.md#body-/i.test(path) || tags.indexOf('skill-body') !== -1) return 'skill-body';
      if (/^references\//i.test(path) || tags.indexOf('reference') !== -1) return 'reference';
      if (/^scripts\//i.test(path) || tags.indexOf('script') !== -1) return 'script';
      if (/^assets\//i.test(path) || tags.indexOf('asset') !== -1) return 'asset';
      return 'extra';
    }

    function resourceMediaType(path) {
      if (/\.md(?:#|$)/i.test(path)) return 'text/markdown';
      if (/\.json(?:#|$)/i.test(path)) return 'application/json';
      if (/\.(?:js|mjs|cjs)(?:#|$)/i.test(path)) return 'text/javascript';
      return 'text/plain';
    }

    function projectManagedResource(skillId, item, path) {
      var href = skillPaths(skillId).resourcesHref + '/' + resourceSegment(item.id);
      return {
        id: String(item.id || ''),
        path: path,
        kind: resourceKind(path, item),
        mediaType: resourceMediaType(path),
        href: href,
        sourceUri: String(item.source && item.source.uri || ''),
        summary: String(item.summary || ''),
      };
    }

    function extractKnowledgeResourceText(item) {
      var content = String(item && item.content || '');
      var marker = '\nResource text:';
      var index = content.indexOf(marker);
      if (index === -1) return content;
      return content.slice(index + marker.length).replace(/^\r?\n/, '');
    }

    // 合并后的 skill 主条目直接内嵌正文与资源全文;旧数据(拆分子条目)走回退聚合。
    function embeddedSkillResources(mainItem) {
      var list = mainItem && Array.isArray(mainItem.skillResources) ? mainItem.skillResources : null;
      if (!list || !list.length) return null;
      return list.filter(function (entry) { return entry && entry.path; });
    }

    function projectEmbeddedResource(skillId, entry) {
      var id = String(entry.id || entry.path || '');
      return {
        id: id,
        path: String(entry.path || ''),
        kind: resourceKind(String(entry.path || ''), { tags: [entry.kind] }),
        mediaType: entry.type || resourceMediaType(String(entry.path || '')),
        href: skillPaths(skillId).resourcesHref + '/' + resourceSegment(id),
        sourceUri: '',
        summary: '此 Skill 随附的 ' + entry.kind + ' 资源：' + entry.path,
      };
    }

    function knowledgeItemDetail(item) {
      if (!item || !knowledge || typeof knowledge.get !== 'function') return Promise.resolve(item || null);
      return Promise.resolve(knowledge.get({ id: item.id })).then(function (result) {
        return result && result.item || item;
      });
    }

    function resolveManagedSkill(skillId) {
      skillId = cleanId(skillId, 'skillId');
      return listAllKnowledgeSkills().then(function (items) {
        var main = null;
        var managed = null;
        items.some(function (item) {
          var candidate = managedSkillSource(item);
          if (!candidate || candidate.resourcePath) return false;
          if (candidate.id !== skillId && String(item.id || '') !== skillId) return false;
          main = item;
          managed = candidate;
          return true;
        });
        if (!main) return null;
        return {
          main: main,
          managed: managed,
          resources: items.filter(function (item) {
            var candidate = managedSkillSource(item);
            return candidate && candidate.key === managed.key && !!candidate.resourcePath && item.archived !== true;
          }),
        };
      });
    }

    function getManagedSkill(skillId) {
      return resolveManagedSkill(skillId).then(function (resolved) {
        if (!resolved) return null;
        var summary = managedSkillSummary(resolved.main);
        return knowledgeItemDetail(resolved.main).then(function (mainDetail) {
          var embedded = embeddedSkillResources(mainDetail);
          var hasEmbeddedInstructions = typeof mainDetail.skillInstructions === 'string' && mainDetail.skillInstructions.trim();
          if (hasEmbeddedInstructions || embedded) {
            var projectedEmbedded = (embedded || []).map(function (entry) {
              return projectEmbeddedResource(summary.id, entry);
            }).sort(function (left, right) { return left.path.localeCompare(right.path); });
            return Object.assign({}, summary, {
              instructions: String(mainDetail.skillInstructions || ''),
              resourceCount: projectedEmbedded.length,
              resources: projectedEmbedded,
            });
          }
          var projectedResources = resolved.resources.map(function (item) {
            return projectManagedResource(summary.id, item, managedSkillSource(item).resourcePath);
          }).sort(function (left, right) { return left.path.localeCompare(right.path); });
          var bodyItems = resolved.resources.filter(function (item) {
            return /^SKILL\.md#body-/i.test(managedSkillSource(item).resourcePath);
          }).sort(function (left, right) {
            return managedSkillSource(left).resourcePath.localeCompare(managedSkillSource(right).resourcePath);
          });
          return Promise.all(bodyItems.map(knowledgeItemDetail)).then(function (body) {
            return Object.assign({}, summary, {
              instructions: body.map(extractKnowledgeResourceText).join(''),
              resourceCount: projectedResources.length,
              resources: projectedResources,
            });
          });
        });
      });
    }

    function listSkills(query) {
      query = query || {};
      return Promise.all([listAllKnowledgeSkills(), listAllCatalogSkills()]).then(function (values) {
        var managedItems = values[0];
        var resourcesByKey = Object.create(null);
        managedItems.forEach(function (item) {
          var source = managedSkillSource(item);
          if (source && source.resourcePath && item.archived !== true) {
            resourcesByKey[source.key] = (resourcesByKey[source.key] || 0) + 1;
          }
        });
        var items = managedItems.map(function (raw) {
          var item = managedSkillSummary(raw);
          if (!item) return null;
          var source = managedSkillSource(item);
          item.resourceCount = (Number(raw.skillResourceCount) || 0)
            || resourcesByKey[source && source.key] || resourcesByKey[String(item.source && item.source.key || '')] || 0;
          return item;
        }).filter(Boolean);
        items = items.concat(values[1].filter(function (item) {
          return !isManagedCatalogSkill(item);
        }).map(function (item) { return projectUserSkill(item, true); }));
        var seen = Object.create(null);
        items = items.filter(function (item) {
          if (!item.id || seen[item.id]) return false;
          seen[item.id] = true;
          if (query.includeDisabled !== true && item.enabled === false) return false;
          if (query.includeArchived !== true && item.archived === true) return false;
          return true;
        });
        var search = String(query.q || '').trim();
        if (search) {
          items = items.map(function (item) {
            return { item: item, score: skillSearchScore(item, search) };
          }).filter(function (entry) { return entry.score > 0; }).sort(function (left, right) {
            return right.score - left.score;
          }).map(function (entry) { return entry.item; });
        }
        return pageWindow(items, query);
      });
    }

    function getSkill(skillId) {
      skillId = cleanId(skillId, 'skillId');
      return getManagedSkill(skillId).then(function (managed) {
        if (managed) return managed;
        return Promise.resolve(skillCatalog.get(skillId)).then(function (item) {
          if (!item || isManagedCatalogSkill(item)) fail('RESOURCE_NOT_FOUND', 'Skill does not exist: ' + skillId);
          return projectUserSkill(item, false);
        });
      });
    }

    function getSkillInstructions(skillId) {
      return getSkill(skillId).then(function (skill) {
        return {
          skillId: skill.id,
          mediaType: 'text/markdown',
          content: String(skill.instructions || ''),
          href: skill.instructionsHref,
          resourcesHref: skill.resourcesHref,
        };
      });
    }

    function listSkillResources(skillId, query) {
      return getSkill(skillId).then(function (skill) {
        var resources = Array.isArray(skill.resources) ? skill.resources : [];
        var match = String(query && query.q || '').trim();
        if (match) resources = resources.filter(function (item) { return skillSearchScore(item, match) > 0; });
        return pageWindow(resources, query || {});
      });
    }

    function getManagedSkillResource(skillId, resourceId) {
      return resolveManagedSkill(skillId).then(function (resolved) {
        if (!resolved) return null;
        return knowledgeItemDetail(resolved.main).then(function (mainDetail) {
          var embedded = embeddedSkillResources(mainDetail);
          if (embedded) {
            var entry = embedded.find(function (candidate) {
              return String(candidate.id || '') === String(resourceId) || String(candidate.path || '') === String(resourceId);
            });
            if (!entry) fail('RESOURCE_NOT_FOUND', 'Skill resource does not exist: ' + resourceId);
            return Object.assign(projectEmbeddedResource(resolved.managed.id, entry), {
              skillId: resolved.managed.id,
              content: String(entry.text || ''),
            });
          }
          var item = resolved.resources.find(function (candidate) { return String(candidate.id || '') === String(resourceId); });
          if (!item) fail('RESOURCE_NOT_FOUND', 'Skill resource does not exist: ' + resourceId);
          var path = managedSkillSource(item).resourcePath;
          return knowledgeItemDetail(item).then(function (full) {
            return Object.assign(projectManagedResource(resolved.managed.id, item, path), {
              skillId: resolved.managed.id,
              content: extractKnowledgeResourceText(full),
            });
          });
        });
      });
    }

    function getSkillResource(skillId, resourceId) {
      skillId = cleanId(skillId, 'skillId');
      resourceId = cleanId(resourceId, 'resourceId');
      return getManagedSkillResource(skillId, resourceId).then(function (managed) {
        if (managed) return managed;
        return getSkill(skillId).then(function (skill) {
          var item = (skill.resources || []).find(function (resource) { return String(resource.id) === resourceId; });
          if (!item) fail('RESOURCE_NOT_FOUND', 'Skill resource does not exist: ' + resourceId);
          return Object.assign({}, item, {
            skillId: skill.id,
            content: String(item.content || item.text || item.markdown || ''),
          });
        });
      });
    }

    function normalizeUserSkill(value, skillId) {
      value = cloneObject(value);
      skillId = cleanId(skillId || value.id || randomId('skill'), 'skillId');
      if (value.id && cleanId(value.id, 'Skill body id') !== skillId) {
        fail('RESOURCE_CONFLICT', 'Body id does not match the Skill resource');
      }
      if (isBuiltinSkill(value)) fail('FORBIDDEN', 'Builtin Skills are read-only');
      if (!String(value.name || '').trim()) fail('SCHEMA_VALIDATION_FAILED', 'Skill name is required');
      if (!String(value.instructions || '').trim()) fail('SCHEMA_VALIDATION_FAILED', 'Skill instructions are required');
      var source = cloneObject(value.source);
      source.kind = 'skill';
      source.key = String(source.key || 'skill-user:' + skillId);
      source.importer = String(source.importer || 'arp-skill');
      value.id = skillId;
      value.source = source;
      value.builtinSkill = false;
      value.builtIn = false;
      value.protected = false;
      return normalizeSkill(value);
    }

    function createSkill(body) {
      var next = normalizeUserSkill(body);
      return getManagedSkill(next.id).then(function (managed) {
        if (managed) fail('RESOURCE_CONFLICT', 'Skill already exists: ' + next.id);
        return skillCatalog.create(next);
      }).then(function (item) { return projectUserSkill(item, false); });
    }

    function patchSkill(skillId, patch) {
      skillId = cleanId(skillId, 'skillId');
      return getSkill(skillId).then(function (current) {
        if (current.managedSkill || isBuiltinSkill(current)) fail('FORBIDDEN', 'Managed Skills are read-only');
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          fail('SCHEMA_VALIDATION_FAILED', 'Skill patch must leave an object');
        }
        return skillCatalog.update(skillId, normalizeUserSkill(next, skillId));
      }).then(function (item) {
        return projectUserSkill(item, false);
      });
    }

    function deleteSkill(skillId) {
      skillId = cleanId(skillId, 'skillId');
      return getSkill(skillId).then(function (current) {
        if (current.managedSkill || isBuiltinSkill(current)) fail('FORBIDDEN', 'Managed Skills are read-only');
        return skillCatalog.remove(skillId);
      }).then(function (removed) {
        if (!removed) fail('RESOURCE_NOT_FOUND', 'Skill does not exist: ' + skillId);
        return { id: skillId, deleted: true };
      });
    }

    function listConfigSections() {
      return getConfig().then(function (config) {
        return {
          sections: CONFIG_SECTIONS.map(function (name) {
            var value = config[name];
            return { name: name, count: Array.isArray(value) ? value.length : Object.keys(value || {}).length };
          }),
          version: config.version || 1,
        };
      });
    }

    function getConfigSection(section) {
      section = sectionName(section);
      return getConfig().then(function (config) {
        return { section: section, value: clone(config[section]) };
      });
    }

    function syncSchedules() {
      if (scheduler && typeof scheduler.syncAlarms === 'function') {
        return Promise.resolve(scheduler.syncAlarms()).catch(function () {});
      }
      return Promise.resolve();
    }

    function createSchedule(body) {
      if (scheduler && typeof scheduler.validateCronExpression === 'function') {
        var trigger = body && body.trigger || {};
        if (trigger.kind === 'cron') scheduler.validateCronExpression(trigger.expression || trigger.cron || '');
      }
      return createSectionItem('schedules', body, 'schedule').then(function (item) {
        return syncSchedules().then(function () { return item; });
      });
    }

    function updateSchedule(scheduleId, patch) {
      return itemInConfig('schedules', cleanId(scheduleId, 'scheduleId')).then(function (current) {
        if (scheduler && typeof scheduler.validateCronExpression === 'function') {
          var next = applyPatch(current, patch) || {};
          var trigger = next.trigger || {};
          if (trigger.kind === 'cron') scheduler.validateCronExpression(trigger.expression || trigger.cron || '');
        }
        return patchSectionItem('schedules', scheduleId, patch);
      }).then(function (item) {
        return syncSchedules().then(function () { return item; });
      });
    }

    function removeSchedule(scheduleId) {
      return deleteSectionItem('schedules', scheduleId).then(function (item) {
        return syncSchedules().then(function () { return item; });
      });
    }

    function preconditionState(_context, _request, route, params) {
      var template = route && route.template || '';
      var sectionByTemplate = {
        '/flows/{flowId}': ['flows', params.flowId],
        '/flows/{flowId}/nodes': ['flows', params.flowId],
        '/flows/{flowId}/nodes/{nodeId}': ['flows', params.flowId],
        '/flow-groups/{groupId}': ['flowGroups', params.groupId],
        '/pages/{pageId}': ['pages', params.pageId],
        '/schedules/{scheduleId}': ['schedules', params.scheduleId],
        '/url-triggers/{triggerId}': ['urlTriggers', params.triggerId],
        '/scripts/{scriptId}': ['scripts', params.scriptId],
      };
      var target = sectionByTemplate[template];
      if (target) {
        return itemInConfig(target[0], cleanId(target[1])).then(function (item) {
          return { exists: true, etag: etag(item), current: null };
        }).catch(function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      if (template === '/knowledge/{knowledgeId}') {
        return getKnowledge(params.knowledgeId).then(function (item) { return { exists: true, etag: etag(item) }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      if (template === '/knowledge-settings') {
        return getKnowledgeSettings().then(function (settings) { return { exists: true, etag: etag(settings) }; });
      }
      if (template === '/conversations/{conversationId}') {
        return getConversation(params.conversationId, {}).then(function (item) { return { exists: true, etag: etag(item) }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      if (template === '/skills/{skillId}') {
        return getSkill(params.skillId).then(function (item) { return { exists: true, etag: etag(item) }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      if (template === '/runs') {
        return listRuns({}).then(function (items) { return { exists: true, etag: etag(items) }; });
      }
      if (template === '/runs/{runId}') {
        return getRun(params.runId).then(function (item) { return { exists: true, etag: etag(item) }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      return Promise.resolve({ exists: true });
    }

    return Object.freeze({
      etag: etag,
      applyPatch: applyPatch,
      getConfig: getConfig,
      listConfigSections: listConfigSections,
      getConfigSection: getConfigSection,
      listFlows: function (query) { return listSection('flows', query); },
      createFlow: createFlow,
      getFlow: getFlow,
      replaceFlow: replaceFlow,
      patchFlow: patchFlow,
      deleteFlow: function (id) { return deleteSectionItem('flows', id); },
      validateFlow: validateFlow,
      createFlowNode: createFlowNode,
      getFlowNode: getFlowNode,
      replaceFlowNode: replaceFlowNode,
      patchFlowNode: patchFlowNode,
      deleteFlowNode: deleteFlowNode,
      createFlowRun: createFlowRun,
      listNodeTypes: nodeTypeList,
      getNodeType: getNodeType,
      listFlowGroups: function (query) { return listSection('flowGroups', query); },
      createFlowGroup: function (body) { return createSectionItem('flowGroups', body, 'fg'); },
      getFlowGroup: function (id) { return itemInConfig('flowGroups', cleanId(id, 'groupId')); },
      replaceFlowGroup: function (id, body) { return replaceSectionItem('flowGroups', id, body); },
      patchFlowGroup: function (id, patch) { return patchSectionItem('flowGroups', id, patch); },
      deleteFlowGroup: function (id) { return deleteSectionItem('flowGroups', id); },
      createFlowGroupRun: createFlowGroupRun,
      listRuns: listRuns,
      getRun: getRun,
      deleteRun: deleteRun,
      deleteRunsBefore: deleteRunsBefore,
      getRunReport: getRunReport,
      getRunDebugSnapshot: getRunDebugSnapshot,
      listConversations: conversationList,
      createConversation: createConversation,
      getConversation: getConversation,
      patchConversation: patchConversation,
      deleteConversation: deleteConversation,
      startConversationTurn: startConversationTurn,
      listConversationEvents: listConversationEvents,
      searchConversationEvents: searchConversationEvents,
      cancelConversationGeneration: cancelConversationGeneration,
      exportConversationArchive: exportConversationArchive,
      listKnowledge: knowledgeList,
      createKnowledge: createKnowledge,
      getKnowledge: getKnowledge,
      replaceKnowledge: replaceKnowledge,
      patchKnowledge: patchKnowledge,
      deleteKnowledge: deleteKnowledge,
      getKnowledgeSettings: getKnowledgeSettings,
      updateKnowledgeSettings: updateKnowledgeSettings,
      listPages: function (query) { return listSection('pages', query); },
      createPage: function (body) { return createSectionItem('pages', body, 'page'); },
      getPage: function (id) { return itemInConfig('pages', cleanId(id, 'pageId')); },
      patchPage: function (id, patch) { return patchSectionItem('pages', id, patch); },
      deletePage: function (id) { return deleteSectionItem('pages', id); },
      listSchedules: function (query) { return listSection('schedules', query); },
      createSchedule: createSchedule,
      getSchedule: function (id) { return itemInConfig('schedules', cleanId(id, 'scheduleId')); },
      patchSchedule: updateSchedule,
      deleteSchedule: removeSchedule,
      createScheduleRun: runSchedule,
      listUrlTriggers: function (query) { return listSection('urlTriggers', query); },
      createUrlTrigger: function (body) { return createSectionItem('urlTriggers', body, 'trigger'); },
      getUrlTrigger: function (id) { return itemInConfig('urlTriggers', cleanId(id, 'triggerId')); },
      replaceUrlTrigger: function (id, body) { return replaceSectionItem('urlTriggers', id, body); },
      patchUrlTrigger: function (id, patch) { return patchSectionItem('urlTriggers', id, patch); },
      deleteUrlTrigger: function (id) { return deleteSectionItem('urlTriggers', id); },
      listScripts: function (query) { return listSection('scripts', query); },
      createScript: function (body) { return createSectionItem('scripts', body, 'script'); },
      getScript: function (id) { return itemInConfig('scripts', cleanId(id, 'scriptId')); },
      replaceScript: function (id, body) { return replaceSectionItem('scripts', id, body); },
      patchScript: function (id, patch) { return patchSectionItem('scripts', id, patch); },
      deleteScript: function (id) { return deleteSectionItem('scripts', id); },
      createScriptRun: runScript,
      listSkills: listSkills,
      getSkill: getSkill,
      getSkillInstructions: getSkillInstructions,
      listSkillResources: listSkillResources,
      getSkillResource: getSkillResource,
      createSkill: createSkill,
      patchSkill: patchSkill,
      deleteSkill: deleteSkill,
      preconditionState: preconditionState,
      saveWholeConfig: saveWholeConfig,
      skillCatalog: skillCatalog,
      operationRunStore: operationRunStore,
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    CONFIG_SECTIONS: CONFIG_SECTIONS,
    create: create,
    createMemoryStorageArea: createMemoryStorageArea,
    createPersistentStore: createPersistentStore,
    createOperationRunStore: createOperationRunStore,
    createSkillCatalog: createSkillCatalog,
  });
});
