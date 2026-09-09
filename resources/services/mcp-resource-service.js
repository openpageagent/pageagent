// Shared service for Connection, MCP Server, and MCP Call resource modules.
(function attachMcpResourceService(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!arp) throw new Error('AgentResourceProtocol must load before McpResourceService');
  var api = factory(root, arp);
  if (commonJs) module.exports = api;
  else root.McpResourceService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, arp) {
  'use strict';

  var UNSAFE_KEYS = Object.freeze({ __proto__: true, prototype: true, constructor: true });

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {}; }
  function fail(code, message, details) { throw arp.arpError(code, message, details === undefined ? undefined : { details: details }); }
  function required(value, name) { if (!value) fail('TEMPORARILY_UNAVAILABLE', name + ' is not wired to McpResourceService'); return value; }
  function requiredFunction(value, name) { if (typeof value !== 'function') fail('TEMPORARILY_UNAVAILABLE', name + ' is not wired to McpResourceService'); return value; }

  function cleanId(value, label) {
    var text = String(value || '').trim();
    if (!text || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) fail('SCHEMA_VALIDATION_FAILED', (label || 'id') + ' is invalid');
    return text;
  }

  function selectedMcpServerIds(context) {
    if (!context || typeof context !== 'object'
        || !Object.prototype.hasOwnProperty.call(context, 'selectedMcpServerIds')) return null;
    var seen = Object.create(null);
    return (Array.isArray(context.selectedMcpServerIds) ? context.selectedMcpServerIds : []).map(function (serverId) {
      return String(serverId || '').trim();
    }).filter(function (serverId) {
      if (!serverId || seen[serverId]) return false;
      seen[serverId] = true;
      return true;
    });
  }

  function assertSelectedMcpServer(context, serverId) {
    var selected = selectedMcpServerIds(context);
    serverId = cleanId(serverId, 'serverId');
    if (selected && selected.indexOf(serverId) === -1) {
      fail('FORBIDDEN', 'HTTP MCP Server is not selected by the current Assistant: ' + serverId);
    }
    return serverId;
  }

  function randomId(prefix) {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return prefix + '_' + root.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var output = {};
    Object.keys(value).sort().forEach(function (key) { output[key] = stable(value[key]); });
    return output;
  }

  function etag(value) {
    var text = JSON.stringify(stable(value === undefined ? null : value));
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return '"arp-' + (hash >>> 0).toString(16).padStart(8, '0') + '"';
  }

  function page(items, query) {
    query = query || {};
    var limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    var match = /^offset:(\d+)$/.exec(String(query.cursor || ''));
    var offset = match ? Number(match[1]) : 0;
    var values = items.slice(offset, offset + limit);
    var output = { items: values, total: items.length };
    if (offset + values.length < items.length) output.nextCursor = 'offset:' + (offset + values.length);
    return output;
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

  function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    var output = {};
    Object.keys(value).forEach(function (key) {
      if (/^(?:authorization|cookie|secret|password|token|bearerToken|headersText)$/i.test(key)) return;
      output[key] = sanitize(value[key]);
    });
    return output;
  }

  function storeMethod(store, names) {
    for (var i = 0; store && i < names.length; i++) {
      if (typeof store[names[i]] === 'function') return store[names[i]].bind(store);
    }
    return null;
  }

  function createMemoryStorageArea(initial) {
    var values = clone(initial || {});
    return {
      get: function (keys, callback) {
        var names = Array.isArray(keys) ? keys : [keys];
        var result = {};
        names.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = clone(values[key]); });
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      },
      set: function (patch, callback) {
        Object.keys(patch || {}).forEach(function (key) { values[key] = clone(patch[key]); });
        if (typeof callback === 'function') callback();
        return Promise.resolve();
      },
      remove: function (keys, callback) {
        (Array.isArray(keys) ? keys : [keys]).forEach(function (key) { delete values[key]; });
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

  function createEntityStore(options) {
    options = options || {};
    var storageArea = defaultStorageArea(options);
    var storageKey = String(options.storageKey || 'arp_mcp_entities');
    var idPrefix = String(options.idPrefix || 'entity');
    var maxEntries = Math.max(10, Number(options.maxEntries) || 500);
    var records = new Map();
    var writeQueue = Promise.resolve();
    var recovered = false;

    function persist() {
      var items = Array.from(records.values()).sort(function (left, right) {
        return Number(right.updatedAt || right.startedAt || 0) - Number(left.updatedAt || left.startedAt || 0);
      });
      if (items.length > maxEntries) {
        var retained = items.slice(0, maxEntries);
        records.clear();
        retained.forEach(function (item) { records.set(String(item.id), item); });
        items = retained;
      }
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
      if (changed) recovered = true;
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
        writeQueue = writeQueue.then(function () { return callback(); }).then(function (result) {
          return persist().then(function () { return result; });
        });
        return writeQueue;
      });
    }

    function normalizedRecord(value, id, requireExisting) {
      var next = object(value);
      var recordId = cleanId(id || next.id || randomId(idPrefix), 'store id');
      if (requireExisting && !records.has(recordId)) throw new Error('Stored entity does not exist: ' + recordId);
      next.id = recordId;
      var previous = records.get(recordId);
      next.createdAt = Number(next.createdAt || previous && previous.createdAt) || Date.now();
      next.updatedAt = Date.now();
      return next;
    }

    return Object.freeze({
      ready: ready,
      list: function () { return afterWrites(function () { return clone(Array.from(records.values())); }); },
      get: function (id) { return afterWrites(function () { return records.has(String(id)) ? clone(records.get(String(id))) : null; }); },
      create: function (value) { return mutate(function () { var next = normalizedRecord(value); if (records.has(next.id)) throw new Error('Stored entity already exists: ' + next.id); records.set(next.id, next); return clone(next); }); },
      replace: function (id, value) { return mutate(function () { var next = normalizedRecord(value, id, true); records.set(next.id, next); return clone(next); }); },
      update: function (id, value) { return mutate(function () { var next = normalizedRecord(value, id, true); records.set(next.id, next); return clone(next); }); },
      save: function (value) { return mutate(function () { var next = normalizedRecord(value); records.set(next.id, next); return clone(next); }); },
      upsert: function (id, value) { if (value === undefined) { value = id; id = value && value.id; } return mutate(function () { var next = normalizedRecord(value, id); records.set(next.id, next); return clone(next); }); },
      remove: function (id) { return mutate(function () { var existed = records.delete(String(id)); return existed; }); },
      recoveredRunningOperations: function () { return recovered; },
      storageArea: storageArea,
      storageKey: storageKey,
    });
  }

  function createOperationRunStore(options) {
    options = options || {};
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var runtimeOwner = String(options.runtimeOwner || randomId('mcp-runtime'));
    var leaseMs = Math.max(30000, Number(options.leaseMs) || 5 * 60 * 1000);
    var legacyGraceMs = Math.max(0, Number(options.legacyGraceMs) || 30000);
    var storeOptions = Object.assign({}, options, {
      storageKey: options.storageKey || (options.incognito ? 'arp_mcp_calls_incognito' : 'arp_mcp_calls'),
      idPrefix: 'operation',
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
    var store = createEntityStore(storeOptions);
    function owned(value) {
      var next = object(value);
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
      create: function (value) { return store.create(owned(value)); },
      replace: function (id, value) { return store.replace(id, owned(value)); },
      update: function (id, value) { return store.update(id, owned(value)); },
      save: function (value) { return store.save(owned(value)); },
      upsert: function (id, value) {
        if (value === undefined) return store.upsert(owned(id));
        return store.upsert(id, owned(value));
      },
      remove: store.remove,
      heartbeat: function (id) {
        return store.get(id).then(function (record) {
          return record && (record.status === 'running' || record.status === 'queued')
            ? store.update(id, owned(record))
            : record;
        });
      },
      recoveredRunningOperations: store.recoveredRunningOperations,
      runtimeOwner: runtimeOwner,
      leaseMs: leaseMs,
      storageArea: store.storageArea,
      storageKey: store.storageKey,
    });
  }

  function create(options) {
    options = options || {};
    var httpMcp = required(options.httpMcpManager || options.httpMcp, 'HttpMcpManager');
    var connectionRuntime = required(options.connectionRuntime, 'MCP Connection runtime');
    ['listServers', 'getServer', 'upsertServer', 'removeServer', 'testServer', 'syncServer', 'callTool'].forEach(function (name) {
      requiredFunction(httpMcp[name], 'HttpMcpManager.' + name);
    });
    ['listConnections', 'getConnection', 'updateConnection', 'attemptConnection', 'getConnectionLogs', 'clearConnectionLogs'].forEach(function (name) {
      requiredFunction(connectionRuntime[name], 'MCP Connection runtime.' + name);
    });
    var callStore = options.mcpCallStore || options.operationRunStore || createOperationRunStore({
      storageArea: options.storageArea,
      storageKey: options.mcpCallStorageKey,
      incognito: options.incognito === true,
      maxEntries: options.maxMcpCalls,
      leaseMs: options.mcpOperationLeaseMs || 11 * 60 * 1000,
    });
    requiredFunction(callStore.create, 'MCP operation store.create');
    requiredFunction(callStore.get, 'MCP operation store.get');
    requiredFunction(callStore.update, 'MCP operation store.update');

    function connectionInput(value) {
      value = object(value);
      var output = {};
      ['enabled', 'url', 'clientName', 'runTabMode'].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = clone(value[key]);
      });
      return output;
    }

    function listConnections(query) {
      return Promise.resolve(connectionRuntime.listConnections(query || {})).then(function (result) {
        var items = Array.isArray(result) ? result : result && (result.items || result.connections) || [];
        return page(sanitize(items), query);
      });
    }

    function getConnection(id) {
      id = cleanId(id, 'connectionId');
      return Promise.resolve(connectionRuntime.getConnection(id)).then(function (item) {
        if (!item) fail('RESOURCE_NOT_FOUND', 'Connection does not exist: ' + id);
        return sanitize(item);
      });
    }

    function patchConnection(id, patch) {
      id = cleanId(id, 'connectionId');
      return getConnection(id).then(function (current) {
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) fail('SCHEMA_VALIDATION_FAILED', 'Connection patch must leave an object');
        var changed = {};
        var projected = connectionInput(next);
        Object.keys(projected).forEach(function (key) {
          if (JSON.stringify(projected[key]) !== JSON.stringify(current[key])) changed[key] = projected[key];
        });
        return Object.keys(changed).length ? connectionRuntime.updateConnection(id, changed) : current;
      }).then(sanitize);
    }

    function getConnectionLogs(id) {
      id = cleanId(id, 'connectionId');
      return getConnection(id).then(function () {
        return Promise.resolve(connectionRuntime.getConnectionLogs(id));
      }).then(function (logs) {
        logs = sanitize(Array.isArray(logs) ? logs : logs && logs.items || []);
        return { connectionId: id, items: logs, total: logs.length };
      });
    }

    function clearConnectionLogs(id) {
      id = cleanId(id, 'connectionId');
      return getConnection(id).then(function () {
        return Promise.resolve(connectionRuntime.clearConnectionLogs(id));
      }).then(function (result) {
        return { connectionId: id, deleted: true, removed: Math.max(0, Number(result && result.removed) || 0) };
      });
    }

    function publicServer(server) {
      var value = sanitize(server || {});
      var tools = Array.isArray(value.tools) ? value.tools : [];
      value.toolCount = tools.length;
      value.auth = {
        kind: 'local-secret',
        bearerTokenConfigured: value.hasBearerToken === true,
        customHeaderNames: Array.isArray(value.customHeaderNames) ? value.customHeaderNames.slice() : [],
      };
      // The injected manager already selects the regular/incognito store. Older
      // records can contain a transient UI document owner, which must not affect
      // access after that document or conversation has gone away.
      value.owner = { scope: 'extension-profile' };
      delete value.tools;
      return arp.sha256(tools.map(function (tool) {
        return { name: tool && tool.name || '', inputSchema: tool && tool.inputSchema || true, outputSchema: tool && tool.outputSchema || true };
      })).then(function (schemaHash) {
        value.schemaHash = schemaHash;
        return value;
      });
    }

    function rawServerList(includeDisabled) {
      return Promise.resolve(httpMcp.listServers({ includeDisabled: includeDisabled === true })).then(function (result) {
        return { items: result && result.servers || [], updatedAt: Number(result && result.updatedAt) || 0 };
      });
    }

    function listMcpServers(query) {
      query = query || {};
      return rawServerList(query.includeDisabled === true).then(function (result) {
        return Promise.all(result.items.map(publicServer)).then(function (items) {
          return Object.assign(page(items, query), { updatedAt: result.updatedAt });
        });
      });
    }

    function getRawMcpServer(serverId) {
      serverId = cleanId(serverId, 'serverId');
      return rawServerList(true).then(function (result) {
        var server = result.items.find(function (item) { return String(item && item.id || '') === serverId; });
        if (!server) fail('RESOURCE_NOT_FOUND', 'HTTP MCP Server does not exist: ' + serverId);
        return sanitize(server);
      });
    }

    function getMcpServer(serverId) {
      return getRawMcpServer(serverId).then(publicServer);
    }

    function serverInput(value, serverId) {
      value = object(value);
      var output = {};
      ['id', 'name', 'url', 'enabled', 'bearerToken', 'headersText', 'timeoutMs', 'protocolVersion'].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = clone(value[key]);
      });
      if (serverId) output.id = serverId;
      output.owner = { scope: 'extension-profile' };
      return output;
    }

    function createMcpServer(body, context) {
      body = object(body);
      var requestedId = String(body.id || '').trim();
      return rawServerList(true).then(function (result) {
        if (requestedId && result.items.some(function (server) { return String(server && server.id || '') === requestedId; })) {
          fail('RESOURCE_CONFLICT', 'HTTP MCP Server already exists: ' + requestedId);
        }
        return httpMcp.upsertServer(serverInput(body));
      }).then(function (result) {
        return publicServer(result && result.server || result);
      });
    }

    function patchMcpServer(serverId, patch, context) {
      serverId = cleanId(serverId, 'serverId');
      return getRawMcpServer(serverId).then(function (current) {
        var next = applyPatch(current, patch);
        if (!next || typeof next !== 'object' || Array.isArray(next)) fail('SCHEMA_VALIDATION_FAILED', 'MCP Server patch must leave an object');
        if (next.id && String(next.id) !== serverId) fail('RESOURCE_CONFLICT', 'MCP Server id cannot be changed');
        return httpMcp.upsertServer(serverInput(next, serverId));
      }).then(function (result) {
        return publicServer(result && result.server || result);
      });
    }

    function deleteMcpServer(serverId, context) {
      serverId = cleanId(serverId, 'serverId');
      return getRawMcpServer(serverId).then(function (current) {
        return httpMcp.removeServer({ serverId: serverId, knowledgeMode: 'archive' });
      }).then(function () { return { id: serverId, deleted: true }; });
    }

    function getMcpTool(serverId, toolName) {
      toolName = cleanId(toolName, 'toolName');
      return getRawMcpServer(serverId).then(function (server) {
        var tools = Array.isArray(server.tools) ? server.tools : [];
        var tool = tools.find(function (item) { return String(item && item.name || '') === toolName; });
        if (!tool) fail('RESOURCE_NOT_FOUND', 'MCP Tool is not in the discovered server catalog: ' + toolName);
        return sanitize(tool);
      });
    }

    function mcpToolInputSchema(tool) {
      var schema = tool && (tool.inputSchema || tool.input_schema || tool.parameters || tool.schema);
      if (schema === undefined || schema === null) return { type: 'object', properties: {}, additionalProperties: true };
      if (schema !== true && schema !== false && (typeof schema !== 'object' || Array.isArray(schema))) {
        fail('UPSTREAM_FAILED', 'MCP Tool input schema is not a valid JSON Schema');
      }
      return clone(schema);
    }

    function toolContract(serverId, tool) {
      var argumentSchema = mcpToolInputSchema(tool);
      var inputSchema = {
        type: 'object',
        properties: {
          arguments: argumentSchema,
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        },
        required: ['arguments'],
        additionalProperties: false,
      };
      return arp.sha256(inputSchema).then(function (schemaHash) {
        return {
          serverId: cleanId(serverId, 'serverId'),
          toolName: cleanId(tool && tool.name, 'toolName'),
          description: String(tool && tool.description || ''),
          inputSchema: inputSchema,
          argumentSchema: argumentSchema,
          outputSchema: clone(tool && (tool.outputSchema || tool.output_schema) || true),
          schemaHash: schemaHash,
        };
      });
    }

    function getMcpToolContract(serverId, toolName) {
      return getMcpTool(serverId, toolName).then(function (tool) { return toolContract(serverId, tool); });
    }

    function listMcpTools(serverId, query) {
      return getRawMcpServer(serverId).then(function (server) {
        return Promise.all((Array.isArray(server.tools) ? server.tools : []).map(function (tool) {
          return toolContract(serverId, tool).then(function (contract) {
            return {
              name: contract.toolName,
              description: contract.description,
              inputSchema: contract.argumentSchema,
              outputSchema: contract.outputSchema,
              schemaHash: contract.schemaHash,
            };
          });
        }));
      }).then(function (tools) { return page(tools, query); });
    }

    function publicOperation(record) {
      record = sanitize(record || {});
      delete record.runtimeOwner;
      delete record.owner;
      return record;
    }

    function startOperation(kind, target, fields, context, executor) {
      var record = Object.assign({
        id: randomId(kind), kind: kind, target: target,
        status: 'running', startedAt: Date.now(),
      }, clone(fields || {}));
      return Promise.resolve(callStore.create(record)).then(function (stored) {
        record = stored;
        Promise.resolve().then(executor).then(function (result) {
          record.status = 'succeeded';
          record.result = sanitize(result);
          record.endedAt = Date.now();
          return callStore.update(record.id, record);
        }, function (error) {
          record.status = 'failed';
          record.error = String(error && error.message || error);
          record.endedAt = Date.now();
          return callStore.update(record.id, record);
        }).catch(function () {});
        return publicOperation(record);
      });
    }

    function getOperation(operationId, kind, _context, target) {
      operationId = cleanId(operationId, 'operationId');
      return Promise.resolve(callStore.get(operationId)).then(function (record) {
        if (!record || record.kind !== kind || target && record.target !== target) {
          fail('RESOURCE_NOT_FOUND', 'MCP operation does not exist: ' + operationId);
        }
        return publicOperation(record);
      });
    }

    function createMcpToolDiscovery(serverId, body, context) {
      serverId = cleanId(serverId, 'serverId');
      body = object(body);
      return getRawMcpServer(serverId).then(function (server) {
        return startOperation('mcp-tool-discovery', serverId, { serverId: serverId }, context, function () {
          return httpMcp.syncServer({ serverId: serverId, timeoutMs: body.timeoutMs }).then(function (result) {
            return { serverId: serverId, synced: Number(result && result.synced) || 0, archived: Number(result && result.archived) || 0 };
          });
        });
      });
    }

    function getMcpToolDiscovery(serverId, discoveryId, context) {
      return getOperation(discoveryId, 'mcp-tool-discovery', context, cleanId(serverId, 'serverId'));
    }

    function createMcpServerConnectionAttempt(serverId, body, context) {
      serverId = cleanId(serverId, 'serverId');
      body = object(body);
      return getRawMcpServer(serverId).then(function (server) {
        return startOperation('mcp-server-connection-attempt', serverId, { serverId: serverId }, context, function () {
          return httpMcp.testServer({ serverId: serverId, timeoutMs: body.timeoutMs }).then(function (result) {
            return { serverId: serverId, connected: result && result.ok === true, toolCount: Number(result && result.toolCount) || 0 };
          });
        });
      });
    }

    function getMcpServerConnectionAttempt(serverId, attemptId, context) {
      return getOperation(attemptId, 'mcp-server-connection-attempt', context, cleanId(serverId, 'serverId'));
    }

    function createConnectionAttempt(connectionId, body, context) {
      connectionId = cleanId(connectionId, 'connectionId');
      body = object(body);
      return getConnection(connectionId).then(function (connection) {
        if (connection.enabled !== true) fail('RESOURCE_CONFLICT', 'Disabled Connection cannot be attempted: ' + connectionId);
        return startOperation('connection-attempt', connectionId, { connectionId: connectionId }, context, function () {
          return Promise.resolve(connectionRuntime.attemptConnection(connectionId, { timeoutMs: body.timeoutMs })).then(sanitize);
        });
      });
    }

    function getConnectionAttempt(connectionId, attemptId, context) {
      return getOperation(attemptId, 'connection-attempt', context, cleanId(connectionId, 'connectionId'));
    }

    function createMcpCall(serverId, toolName, body, context) {
      body = object(body);
      serverId = assertSelectedMcpServer(context, serverId);
      return Promise.all([getRawMcpServer(serverId), getMcpTool(serverId, toolName), getMcpToolContract(serverId, toolName)]).then(function (values) {
        var server = values[0];
        var tool = values[1];
        var contract = values[2];
        if (server.enabled !== true) fail('RESOURCE_CONFLICT', 'HTTP MCP Server is disabled: ' + serverId);
        if (String(body.schemaHash || '') !== contract.schemaHash) fail('RESOURCE_CONFLICT', 'MCP Tool schemaHash is stale');
        var argumentsValue = body.arguments;
        var validation = arp.validateJsonSchema(contract.argumentSchema, argumentsValue);
        if (!validation.valid) fail('SCHEMA_VALIDATION_FAILED', 'MCP Tool arguments do not match the discovered schema', {
          schemaHash: contract.schemaHash, errors: validation.errors.slice(0, 32),
        });
        return startOperation('mcp-call', cleanId(serverId, 'serverId') + '/' + cleanId(toolName, 'toolName'), {
          serverId: cleanId(serverId, 'serverId'), toolName: tool.name || toolName, schemaHash: contract.schemaHash,
        }, context, function () {
          return httpMcp.callTool({
            serverId: serverId, toolName: tool.name || toolName, arguments: argumentsValue, timeoutMs: body.timeoutMs,
          });
        });
      });
    }

    function getMcpCall(callId, context) {
      return getOperation(callId, 'mcp-call', context).then(function (operation) {
        assertSelectedMcpServer(context, operation.serverId);
        return operation;
      });
    }

    function listMcpCalls(query, context) {
      var selected = selectedMcpServerIds(context);
      return callStore.list().then(function (records) {
        return page(records.filter(function (record) {
          return record && record.kind === 'mcp-call'
            && (!selected || selected.indexOf(String(record.serverId || '')) !== -1);
        }).sort(function (left, right) {
          return Number(right.startedAt || right.createdAt) - Number(left.startedAt || left.createdAt);
        }).map(publicOperation), query);
      });
    }

    function preconditionState(context, _request, route, params) {
      var readers = {
        '/connections/{connectionId}': function () { return getConnection(params.connectionId); },
        '/mcp-servers/{serverId}': function () { return getMcpServer(params.serverId); },
        '/connections/{connectionId}/logs': function () { return getConnectionLogs(params.connectionId); },
      };
      var read = readers[route && route.template];
      if (!read) return Promise.resolve({ exists: true });
      return Promise.resolve(read()).then(function (item) { return { exists: true, etag: etag(item) }; }, function (error) {
        if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
        throw error;
      });
    }

    return Object.freeze({
      etag: etag,
      listConnections: listConnections,
      getConnection: getConnection,
      patchConnection: patchConnection,
      createConnectionAttempt: createConnectionAttempt,
      getConnectionAttempt: getConnectionAttempt,
      getConnectionLogs: getConnectionLogs,
      clearConnectionLogs: clearConnectionLogs,
      listMcpServers: listMcpServers,
      getMcpServer: getMcpServer,
      createMcpServer: createMcpServer,
      patchMcpServer: patchMcpServer,
      deleteMcpServer: deleteMcpServer,
      listMcpTools: listMcpTools,
      getMcpTool: getMcpTool,
      getMcpToolContract: getMcpToolContract,
      createMcpToolDiscovery: createMcpToolDiscovery,
      getMcpToolDiscovery: getMcpToolDiscovery,
      createMcpServerConnectionAttempt: createMcpServerConnectionAttempt,
      getMcpServerConnectionAttempt: getMcpServerConnectionAttempt,
      createMcpCall: createMcpCall,
      listMcpCalls: listMcpCalls,
      getMcpCall: getMcpCall,
      preconditionState: preconditionState,
      operationRunStore: callStore,
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    create: create,
    createMemoryStorageArea: createMemoryStorageArea,
    createEntityStore: createEntityStore,
    createOperationRunStore: createOperationRunStore,
  });
});
