// IndexedDB append-only conversation Journal. The injected memory backend is for deterministic tests.
(function attachConversationJournalStore(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var nodeCrypto = null;
  if (commonJs) {
    try { nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  }
  var api = factory(root, nodeCrypto);
  if (commonJs) module.exports = api;
  else root.ConversationJournalStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;
  var DATABASE_NAME = 'page_agent_conversations';
  var DATABASE_VERSION = 3;
  var STORE_NAMES = Object.freeze([
    'conversation_meta',
    'journal_events',
    'summary_checkpoints',
    'command_dedup',
    'stream_buffers',
    'payload_blobs',
  ]);
  var DEFAULT_PAGE_SIZE = 100;
  var MAX_PAGE_SIZE = 500;
  var DEFAULT_PAYLOAD_THRESHOLD = 64 * 1024;
  var SNAPSHOT_ENCODING = 'request-snapshot/1';
  function snapshotPartId(conversationId, hash) { return conversationId + ':snapshot:' + hash; }
  function snapshotPreview(payload) {
    var preview = {};
    ['source', 'logicalRequestId', 'purpose', 'provider', 'model', 'attempt', 'startedAt',
      'maxRetries', 'maxAttempts'].forEach(function (key) {
      if (hasOwn(payload, key)) preview[key] = clone(payload[key]);
    });
    if (isRecord(payload.request)) {
      preview.request = {};
      ['purpose', 'logicalRequestId', 'modelRequestId', 'serviceId', 'model', 'maxOutputTokens', 'promptCacheKey'].forEach(function (key) {
        if (hasOwn(payload.request, key)) preview.request[key] = clone(payload.request[key]);
      });
    }
    return preview;
  }
  var TERMINAL_STATES = Object.freeze({
    completed: true, failed: true, cancelled: true, truncated: true, blocked: true,
  });
  var TERMINAL_EVENT_TYPES = Object.freeze({
    generation_completed: true, generation_failed: true, generation_cancelled: true,
    generation_truncated: true, generation_blocked: true,
  });

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function isRecord(value) { return !!(value && typeof value === 'object' && !Array.isArray(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }
  function reasoningKey(key) {
    return /(?:reasoning|thinking|thought|chain[_-]?of[_-]?thought|internal[_-]?monologue)/i.test(String(key || ''));
  }
  function providerReasoningKey(key) {
    return reasoningKey(key) || /^(?:encrypted[_-]?content|signature(?:[_-]?delta)?|redacted[_-]?thinking)$/i.test(String(key || ''));
  }
  function reasoningType(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var marker = value.type || value.event || value.kind
      || value.data && (value.data.type || value.data.event || value.data.kind);
    return /(?:reasoning|thinking|thought|chain[_-]?of[_-]?thought|internal[_-]?monologue)/i.test(String(marker || ''));
  }
  function scrubReasoning(value, seen, providerMode, skipRawBody) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return '[Circular]';
    seen.push(value);
    var output;
    if (Array.isArray(value)) {
      output = value.filter(function (item) { return !reasoningType(item); }).map(function (item) {
        return scrubReasoning(item, seen, providerMode, skipRawBody);
      });
    } else {
      output = {};
      Object.keys(value).forEach(function (key) {
        if ((providerMode ? providerReasoningKey(key) : reasoningKey(key))) return;
        if (reasoningType(value[key])) return;
        output[key] = !skipRawBody && /^(?:raw[_-]?body)$/i.test(key)
          ? scrubProviderRawBody(value[key]) : scrubReasoning(value[key], seen, providerMode, skipRawBody);
      });
    }
    seen.pop();
    return output;
  }
  function scrubProviderRawBody(value) {
    if (typeof value !== 'string') return scrubReasoning(value, [], true);
    var trimmed = value.trim();
    if (!trimmed) return value;
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try { return JSON.stringify(scrubReasoning(JSON.parse(value), [], true, true)); } catch (_) {}
    }
    if (value.indexOf('data:') === -1) return value;
    return value.split(/(\r?\n\r?\n)/).map(function (frame) {
      if (!/^\s*data:/i.test(frame)) return frame;
      var lines = frame.split(/\r?\n/);
      var hidden = false;
      var sanitizedLines = lines.map(function (line) {
        var data = line.replace(/^\s*data:\s?/, '');
        if (!data || data === '[DONE]') return line;
        try {
          var parsed = JSON.parse(data);
          if (reasoningType(parsed) || /(?:reasoning|thinking|thought)/i.test(String(parsed && (parsed.type || parsed.event) || ''))) {
            hidden = true;
            return '';
          }
          var sanitized = scrubReasoning(parsed, [], true);
          return line.slice(0, line.indexOf(data)) + JSON.stringify(sanitized);
        } catch (_) {
          if (/(?:reasoning|thinking|thought)/i.test(data)) hidden = true;
          return hidden ? '' : line;
        }
      });
      return hidden ? '' : sanitizedLines.join('\n');
    }).join('');
  }
  function exportEventWithoutReasoning(event) {
    if (!event || typeof event !== 'object') return event;
    if (event.type === 'reasoning_completed') return null;
    if (event.type === 'model_stream_delta' && event.payload && event.payload.phase === 'reasoning') return null;
    var output = scrubReasoning(event);
    if (output.type === 'provider_request_started' && output.payload && output.payload.request) {
      output.payload.request = scrubReasoning(output.payload.request, [], true);
      if (typeof output.payload.request.body === 'string') {
        output.payload.request.body = scrubProviderRawBody(output.payload.request.body);
      }
      if (output.payload.request.rawBody !== undefined) {
        output.payload.request.rawBody = scrubProviderRawBody(output.payload.request.rawBody);
      }
    }
    if (/^provider_response_/.test(String(output.type || '')) && output.payload && output.payload.response) {
      output.payload.response = scrubReasoning(output.payload.response, [], true);
      if (typeof output.payload.response.body === 'string') {
        output.payload.response.body = scrubProviderRawBody(output.payload.response.body);
      }
      if (output.payload.response.rawBody !== undefined) {
        output.payload.response.rawBody = scrubProviderRawBody(output.payload.response.rawBody);
      }
    }
    if (output.type === 'model_response_completed' && output.payload) output.payload.providerReplay = null;
    return output;
  }
  function stable(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('Journal values cannot contain cycles');
    seen.push(value);
    var result;
    if (Array.isArray(value)) result = value.map(function (item) { return stable(item, seen); });
    else {
      result = {};
      Object.keys(value).sort().forEach(function (key) { result[key] = stable(value[key], seen); });
    }
    seen.pop();
    return result;
  }
  function stableStringify(value) { return JSON.stringify(stable(value)); }
  function byteLength(value) {
    var stringValue = typeof value === 'string' ? value : stableStringify(value);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(stringValue).byteLength;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(stringValue, 'utf8');
    return unescape(encodeURIComponent(stringValue)).length;
  }
  function hex(bytes) {
    return Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }
  async function sha256(value, cryptoApi) {
    var serialized = typeof value === 'string' ? value : stableStringify(value);
    if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
      return 'sha256:' + nodeCrypto.createHash('sha256').update(serialized).digest('hex');
    }
    cryptoApi = cryptoApi || root && root.crypto;
    if (!cryptoApi || !cryptoApi.subtle || typeof TextEncoder !== 'function') {
      throw new Error('SHA-256 support is required by ConversationJournalStore');
    }
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function journalError(code, message, details) {
    var error = new Error(message || code);
    error.name = 'ConversationJournalError';
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }
  function requiredId(value, path) {
    var output = text(value);
    if (!output) throw journalError('INVALID_JOURNAL_INPUT', path + ' is required');
    return output;
  }
  function defaultMetadata(conversationId) {
    return {
      schemaVersion: 1,
      conversationId: conversationId,
      assistantId: '',
      serviceId: '',
      lastSequence: 0,
      revision: 0,
      activeGeneration: null,
      lineage: {
        rootConversationId: conversationId,
        parentConversationId: '',
        parentSequence: 0,
        branchId: 'main',
        origin: 'user',
        delegationDepth: 0,
        branches: [{ branchId: 'main', parentBranchId: '', forkSequence: 0, createdAt: 0 }],
      },
      latestCheckpointId: null,
      migration: { state: 'not_started', sourceHash: '' },
      createdAt: 0,
      updatedAt: 0,
    };
  }
  function normalizeMetadata(value, conversationId, clock) {
    value = Object.assign(defaultMetadata(conversationId), clone(value || {}));
    value.conversationId = conversationId;
    value.schemaVersion = 1;
    value.lastSequence = Math.max(0, Math.floor(Number(value.lastSequence) || 0));
    value.revision = Math.max(0, Math.floor(Number(value.revision) || 0));
    value.createdAt = Math.max(0, Number(value.createdAt) || Number(clock()));
    value.updatedAt = Math.max(0, Number(value.updatedAt) || value.createdAt);
    var lineage = isRecord(value.lineage) ? value.lineage : {};
    value.lineage = {
      rootConversationId: text(lineage.rootConversationId) || conversationId,
      parentConversationId: text(lineage.parentConversationId),
      parentSequence: Math.max(0, Math.floor(Number(lineage.parentSequence) || 0)),
      branchId: text(lineage.branchId) || 'main',
      origin: text(lineage.origin) || 'user',
      delegationDepth: Math.max(0, Math.floor(Number(lineage.delegationDepth) || 0)),
      branches: (Array.isArray(lineage.branches) ? lineage.branches : []).map(function (branch) {
        return {
          branchId: text(branch && branch.branchId), parentBranchId: text(branch && branch.parentBranchId),
          forkSequence: Math.max(0, Math.floor(Number(branch && branch.forkSequence) || 0)),
          createdAt: Math.max(0, Number(branch && branch.createdAt) || 0),
        };
      }).filter(function (branch) { return !!branch.branchId; }),
    };
    if (!value.lineage.branches.some(function (branch) { return branch.branchId === value.lineage.branchId; })) {
      value.lineage.branches.unshift({ branchId: value.lineage.branchId, parentBranchId: '', forkSequence: value.lineage.parentSequence || 0, createdAt: value.createdAt });
    }
    return value;
  }
  function normalizeEvent(value, conversationId, defaults, clock, idGenerator) {
    if (!isRecord(value)) throw journalError('INVALID_JOURNAL_EVENT', 'Journal event must be an object');
    var type = requiredId(value.type, 'event.type');
    var eventConversationId = text(value.conversationId || conversationId);
    if (eventConversationId !== conversationId) {
      throw journalError('CONVERSATION_MISMATCH', 'Event conversationId does not match the transaction');
    }
    var explicitEventId = text(value.eventId);
    var event = {
      schemaVersion: 1,
      sequence: 0,
      conversationId: conversationId,
      generationId: text(value.generationId || defaults.generationId),
      turnId: text(value.turnId || defaults.turnId),
      modelRequestId: text(value.modelRequestId),
      toolCallId: text(value.toolCallId),
      interactionId: text(value.interactionId),
      type: type,
      status: text(value.status),
      at: Math.max(0, Number(value.at) || Number(clock())),
      causationId: text(value.causationId),
      correlationId: text(value.correlationId),
      branchId: text(value.branchId || defaults.branchId),
      parentEventId: text(value.parentEventId),
      actorId: text(value.actorId || defaults.actorId || value.payload && value.payload.actorId),
      actorType: text(value.actorType || defaults.actorType || value.payload && value.payload.actorType),
      subagentId: text(value.subagentId || defaults.subagentId || defaults.lineage && defaults.lineage.subagentId
        || value.payload && value.payload.subagentId),
      payload: value.payload === undefined ? {} : clone(value.payload),
      payloadRef: value.payloadRef === undefined ? null : clone(value.payloadRef),
    };
    /* Sequence is the durable ordering key. Most events need no second UUID;
       preserve an ID only when a command supplied one for an external receipt
       or when importing an older Journal that already has identities. */
    if (explicitEventId) event.eventId = explicitEventId;
    return event;
  }
  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || journalError('INDEXEDDB_ERROR', 'IndexedDB request failed')); };
    });
  }
  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onabort = function () { reject(transaction.error || journalError('TRANSACTION_ABORTED', 'IndexedDB transaction aborted')); };
      transaction.onerror = function () { reject(transaction.error || journalError('INDEXEDDB_ERROR', 'IndexedDB transaction failed')); };
    });
  }

  function createMemoryState(seed) {
    seed = seed || {};
    function map(value) { return value instanceof Map ? value : new Map(value || []); }
    return {
      conversationMeta: map(seed.conversationMeta),
      journalEvents: map(seed.journalEvents),
      summaryCheckpoints: map(seed.summaryCheckpoints),
      commandDedup: map(seed.commandDedup),
      streamBuffers: map(seed.streamBuffers),
      payloadBlobs: map(seed.payloadBlobs),
    };
  }
  function eventKey(conversationId, sequence) { return conversationId + '\n' + String(sequence).padStart(20, '0'); }
  function checkpointKey(conversationId, checkpointId) { return conversationId + '\n' + checkpointId; }
  function streamKey(conversationId, generationId, modelRequestId) {
    return conversationId + '\n' + generationId + '\n' + modelRequestId;
  }
  function eventMatches(event, filter) {
    filter = filter || {};
    if (filter.branchId && text(event.branchId) !== text(filter.branchId)) return false;
    if (filter.generationId && text(event.generationId) !== text(filter.generationId)) return false;
    if (filter.actorId && text(event.actorId || event.payload && event.payload.actorId) !== text(filter.actorId)) return false;
    if (Array.isArray(filter.types) && filter.types.length && filter.types.indexOf(event.type) === -1) return false;
    if (filter.q) {
      var haystack = '';
      try { haystack = stableStringify(event); } catch (_) { haystack = String(event.type || ''); }
      if (haystack.toLowerCase().indexOf(String(filter.q).toLowerCase()) === -1) return false;
    }
    return true;
  }
  function canAdvanceCommandResult(existing, next) {
    return !!(existing && next && existing.conversationId === next.conversationId
      && existing.result && next.result
      && existing.result.state === 'scheduled' && next.result.state === 'started'
      && existing.result.childConversationId && existing.result.childConversationId === next.result.childConversationId);
  }
  function assertClosedGenerationBoundary(events, boundary) {
    var open = Object.create(null);
    events.slice(0, boundary).forEach(function (event) {
      var generationId = text(event && event.generationId);
      if (!generationId) return;
      if (event.type === 'generation_started') open[generationId] = true;
      else if (TERMINAL_EVENT_TYPES[event.type]) delete open[generationId];
    });
    var openIds = Object.keys(open);
    if (openIds.length) {
      throw journalError('INVALID_FORK_BOUNDARY', 'Fork boundary falls inside an unfinished generation', {
        boundarySequence: boundary, generationIds: openIds,
      });
    }
  }

  function createMemoryBackend(state, clock) {
    state = createMemoryState(state);
    return {
      kind: 'memory',
      state: state,
      open: async function () { return state; },
      getMetadata: async function (conversationId) { return clone(state.conversationMeta.get(conversationId) || null); },
      getCommand: async function (commandId) { return clone(state.commandDedup.get(commandId) || null); },
      getCheckpoint: async function (conversationId, checkpointId) {
        if (checkpointId) return clone(state.summaryCheckpoints.get(checkpointKey(conversationId, checkpointId)) || null);
        var meta = state.conversationMeta.get(conversationId);
        return meta && meta.latestCheckpointId
          ? clone(state.summaryCheckpoints.get(checkpointKey(conversationId, meta.latestCheckpointId)) || null)
          : null;
      },
      commitBundle: async function (bundle) {
        var storedCurrent = state.conversationMeta.get(bundle.conversationId) || null;
        var current = bundle.replace === true ? defaultMetadata(bundle.conversationId)
          : storedCurrent || defaultMetadata(bundle.conversationId);
        if (bundle.expectedRevision !== undefined && Number(current.revision || 0) !== bundle.expectedRevision) {
          throw journalError('JOURNAL_CAS_CONFLICT', 'Conversation metadata changed during transaction');
        }
        var next = normalizeMetadata(Object.assign({}, current, bundle.metadata || {}), bundle.conversationId, clock);
        var assigned = bundle.events.map(function (event, index) {
          var copy = clone(event);
          copy.sequence = Number(current.lastSequence || 0) + index + 1;
          return copy;
        });
        next.lastSequence = Number(current.lastSequence || 0) + assigned.length;
        next.revision = Number(current.revision || 0) + 1;
        next.updatedAt = Number(clock());
        if (!next.createdAt) next.createdAt = next.updatedAt;
        for (var i = 0; i < bundle.commands.length; i += 1) {
          var command = bundle.commands[i];
          var existing = state.commandDedup.get(command.commandId);
          if (bundle.replace === true && existing && existing.conversationId === bundle.conversationId) existing = null;
          if (existing && stableStringify(existing.result) !== stableStringify(command.result)
              && !canAdvanceCommandResult(existing, command)) {
            throw journalError('COMMAND_DEDUP_CONFLICT', 'commandId already has a different result', { commandId: command.commandId });
          }
        }
        if (bundle.replace === true) {
          state.conversationMeta.delete(bundle.conversationId);
          [state.journalEvents, state.summaryCheckpoints, state.streamBuffers].forEach(function (map) {
            Array.from(map.keys()).forEach(function (key) { if (key.indexOf(bundle.conversationId + '\n') === 0) map.delete(key); });
          });
          Array.from(state.commandDedup.entries()).forEach(function (entry) {
            if (entry[1].conversationId === bundle.conversationId) state.commandDedup.delete(entry[0]);
          });
          Array.from(state.payloadBlobs.entries()).forEach(function (entry) {
            if (entry[1].conversationId === bundle.conversationId) state.payloadBlobs.delete(entry[0]);
          });
        }
        assigned.forEach(function (event) { state.journalEvents.set(eventKey(bundle.conversationId, event.sequence), clone(event)); });
        bundle.commands.forEach(function (command) { state.commandDedup.set(command.commandId, clone(command)); });
        bundle.checkpoints.forEach(function (checkpoint) {
          state.summaryCheckpoints.set(checkpointKey(bundle.conversationId, checkpoint.checkpointId), clone(checkpoint));
        });
        bundle.payloads.forEach(function (payload) { state.payloadBlobs.set(payload.payloadId, clone(payload)); });
        state.conversationMeta.set(bundle.conversationId, clone(next));
        return { metadata: clone(next), events: assigned.map(clone) };
      },
      queryEvents: async function (conversationId, cursor, limit, filter) {
        var values = [];
        state.journalEvents.forEach(function (event) {
          if (event.conversationId === conversationId && eventMatches(event, filter)) values.push(clone(event));
        });
        values.sort(function (a, b) { return a.sequence - b.sequence; });
        if (hasOwn(cursor, 'afterSequence')) values = values.filter(function (event) { return event.sequence > cursor.afterSequence; }).slice(0, limit);
        else if (hasOwn(cursor, 'beforeSequence')) values = values.filter(function (event) { return event.sequence < cursor.beforeSequence; }).slice(-limit);
        else values = values.slice(-limit);
        return values;
      },
      countEvents: async function (conversationId, filter, cursor) {
        var count = 0;
        state.journalEvents.forEach(function (event) {
          if (event.conversationId !== conversationId || !eventMatches(event, filter)) return;
          if (hasOwn(cursor, 'beforeSequence') && event.sequence >= cursor.beforeSequence) return;
          if (hasOwn(cursor, 'afterSequence') && event.sequence <= cursor.afterSequence) return;
          count += 1;
        });
        return count;
      },
      putStream: async function (buffer) { state.streamBuffers.set(streamKey(buffer.conversationId, buffer.generationId, buffer.modelRequestId), clone(buffer)); return clone(buffer); },
      getStream: async function (conversationId, generationId, modelRequestId) { return clone(state.streamBuffers.get(streamKey(conversationId, generationId, modelRequestId)) || null); },
      listStreams: async function (conversationId, generationId) {
        var values = [];
        state.streamBuffers.forEach(function (buffer) {
          if (buffer.conversationId === conversationId && (!generationId || buffer.generationId === generationId)) values.push(clone(buffer));
        });
        return values.sort(function (a, b) { return a.updatedAt - b.updatedAt; });
      },
      deleteStream: async function (conversationId, generationId, modelRequestId) { return state.streamBuffers.delete(streamKey(conversationId, generationId, modelRequestId)); },
      putPayload: async function (payload) { state.payloadBlobs.set(payload.payloadId, clone(payload)); return clone(payload); },
      getPayload: async function (payloadId) { return clone(state.payloadBlobs.get(payloadId) || null); },
      missingPayloadIds: async function (ids) { return ids.filter(function (id) { return !state.payloadBlobs.has(id); }); },
      listCheckpoints: async function (conversationId) {
        var values = [];
        state.summaryCheckpoints.forEach(function (checkpoint) { if (checkpoint.conversationId === conversationId) values.push(clone(checkpoint)); });
        return values.sort(function (a, b) { return a.throughSequence - b.throughSequence || a.createdAt - b.createdAt; });
      },
      listMetadata: async function () { return Array.from(state.conversationMeta.values()).map(clone); },
      clearConversation: async function (conversationId) {
        state.conversationMeta.delete(conversationId);
        [state.journalEvents, state.summaryCheckpoints, state.streamBuffers].forEach(function (map) {
          Array.from(map.keys()).forEach(function (key) { if (key.indexOf(conversationId + '\n') === 0) map.delete(key); });
        });
        Array.from(state.commandDedup.entries()).forEach(function (entry) { if (entry[1].conversationId === conversationId) state.commandDedup.delete(entry[0]); });
        Array.from(state.payloadBlobs.entries()).forEach(function (entry) { if (entry[1].conversationId === conversationId) state.payloadBlobs.delete(entry[0]); });
      },
    };
  }

  function createIndexedDbBackend(indexedDB, idbKeyRange, clock, databaseName) {
    var databasePromise = null;
    function open() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise(function (resolve, reject) {
        var request = indexedDB.open(databaseName, DATABASE_VERSION);
        request.onupgradeneeded = function () {
          var db = request.result;
          if (db.objectStoreNames.contains('api_trace_records')) db.deleteObjectStore('api_trace_records');
          if (db.objectStoreNames.contains('api_trace_blobs')) db.deleteObjectStore('api_trace_blobs');
          var events;
          if (!db.objectStoreNames.contains('conversation_meta')) db.createObjectStore('conversation_meta', { keyPath: 'conversationId' });
          if (!db.objectStoreNames.contains('journal_events')) {
            events = db.createObjectStore('journal_events', { keyPath: ['conversationId', 'sequence'] });
            events.createIndex('by_generation', ['conversationId', 'generationId', 'sequence'], { unique: false });
            events.createIndex('by_event_id', 'eventId', { unique: true });
            events.createIndex('by_type', ['conversationId', 'type', 'sequence'], { unique: false });
          }
          if (!db.objectStoreNames.contains('summary_checkpoints')) {
            var checkpoints = db.createObjectStore('summary_checkpoints', { keyPath: ['conversationId', 'checkpointId'] });
            checkpoints.createIndex('by_sequence', ['conversationId', 'throughSequence'], { unique: false });
          }
          if (!db.objectStoreNames.contains('command_dedup')) {
            var commands = db.createObjectStore('command_dedup', { keyPath: 'commandId' });
            commands.createIndex('by_conversation', ['conversationId', 'createdAt'], { unique: false });
          }
          if (!db.objectStoreNames.contains('stream_buffers')) db.createObjectStore('stream_buffers', { keyPath: ['conversationId', 'generationId', 'modelRequestId'] });
          if (!db.objectStoreNames.contains('payload_blobs')) {
            var payloads = db.createObjectStore('payload_blobs', { keyPath: 'payloadId' });
            payloads.createIndex('by_hash', 'sha256', { unique: false });
          }
        };
        request.onsuccess = function () {
          var db = request.result;
          db.onversionchange = function () { db.close(); databasePromise = null; };
          resolve(db);
        };
        request.onerror = function () { databasePromise = null; reject(request.error); };
        request.onblocked = function () { reject(journalError('INDEXEDDB_BLOCKED', 'Conversation Journal database upgrade is blocked')); };
      });
      return databasePromise;
    }
    async function one(storeName, mode, operation) {
      var db = await open();
      var tx = db.transaction([storeName], mode);
      var done = transactionDone(tx);
      var result = await operation(tx.objectStore(storeName));
      await done;
      return result;
    }
    function rangeForConversation(conversationId, lower, upper, lowerOpen, upperOpen) {
      return idbKeyRange.bound(
        [conversationId, lower === undefined ? 0 : lower],
        [conversationId, upper === undefined ? Number.MAX_SAFE_INTEGER : upper],
        lowerOpen === true,
        upperOpen === true
      );
    }
    function eventRanges(conversationId, cursor, filter) {
      var prefixes = filter && filter.types && filter.types.length
        ? Array.from(new Set(filter.types)).filter(function (type) { return typeof type === 'string'; })
          .map(function (type) { return [conversationId, type]; })
        : [[conversationId]];
      var after = hasOwn(cursor, 'afterSequence');
      var before = hasOwn(cursor, 'beforeSequence');
      return prefixes.map(function (prefix) {
        return idbKeyRange.bound(
          prefix.concat(after ? cursor.afterSequence : 0),
          prefix.concat(before ? cursor.beforeSequence : Number.MAX_SAFE_INTEGER),
          after,
          before
        );
      });
    }
    return {
      kind: 'indexeddb',
      open: open,
      getMetadata: async function (conversationId) { return one('conversation_meta', 'readonly', function (store) { return requestPromise(store.get(conversationId)); }).then(function (value) { return value || null; }); },
      getCommand: async function (commandId) { return one('command_dedup', 'readonly', function (store) { return requestPromise(store.get(commandId)); }).then(function (value) { return value || null; }); },
      getCheckpoint: async function (conversationId, checkpointId) {
        if (checkpointId) return one('summary_checkpoints', 'readonly', function (store) { return requestPromise(store.get([conversationId, checkpointId])); }).then(function (value) { return value || null; });
        var metadata = await this.getMetadata(conversationId);
        if (!metadata || !metadata.latestCheckpointId) return null;
        return this.getCheckpoint(conversationId, metadata.latestCheckpointId);
      },
      commitBundle: async function (bundle) {
        var db = await open();
        var tx = db.transaction(STORE_NAMES.slice(), 'readwrite');
        var done = transactionDone(tx);
        var metaStore = tx.objectStore('conversation_meta');
        var eventStore = tx.objectStore('journal_events');
        var checkpointStore = tx.objectStore('summary_checkpoints');
        var commandStore = tx.objectStore('command_dedup');
        var payloadStore = tx.objectStore('payload_blobs');
        try {
          var current = await requestPromise(metaStore.get(bundle.conversationId));
          if (bundle.replace === true) {
            async function deleteRange(store, range) {
              await new Promise(function (resolve, reject) {
                var request = store.openCursor(range);
                request.onerror = function () { reject(request.error); };
                request.onsuccess = function () {
                  var cursor = request.result;
                  if (!cursor) { resolve(); return; }
                  cursor.delete();
                  cursor.continue();
                };
              });
            }
            await deleteRange(eventStore, rangeForConversation(bundle.conversationId));
            await deleteRange(checkpointStore, idbKeyRange.bound([bundle.conversationId, ''], [bundle.conversationId, '\uffff']));
            await deleteRange(tx.objectStore('stream_buffers'), idbKeyRange.bound(
              [bundle.conversationId, '', ''], [bundle.conversationId, '\uffff', '\uffff']
            ));
            var oldCommands = await requestPromise(commandStore.getAll());
            oldCommands.filter(function (item) { return item.conversationId === bundle.conversationId; })
              .forEach(function (item) { commandStore.delete(item.commandId); });
            var oldPayloads = await requestPromise(payloadStore.getAll());
            oldPayloads.filter(function (item) { return item.conversationId === bundle.conversationId; })
              .forEach(function (item) { payloadStore.delete(item.payloadId); });
            current = defaultMetadata(bundle.conversationId);
          } else {
            current = current || defaultMetadata(bundle.conversationId);
          }
          if (bundle.expectedRevision !== undefined && Number(current.revision || 0) !== bundle.expectedRevision) {
            throw journalError('JOURNAL_CAS_CONFLICT', 'Conversation metadata changed during transaction');
          }
          for (var c = 0; c < bundle.commands.length; c += 1) {
            var command = bundle.commands[c];
            var existing = await requestPromise(commandStore.get(command.commandId));
            if (bundle.replace === true && existing && existing.conversationId === bundle.conversationId) existing = null;
            if (existing && stableStringify(existing.result) !== stableStringify(command.result)
                && !canAdvanceCommandResult(existing, command)) {
              throw journalError('COMMAND_DEDUP_CONFLICT', 'commandId already has a different result', { commandId: command.commandId });
            }
          }
          var assigned = bundle.events.map(function (event, index) {
            var copy = clone(event);
            copy.sequence = Number(current.lastSequence || 0) + index + 1;
            return copy;
          });
          assigned.forEach(function (event) { eventStore.add(event); });
          bundle.commands.forEach(function (command) { commandStore.put(command); });
          bundle.checkpoints.forEach(function (checkpoint) { checkpointStore.put(checkpoint); });
          bundle.payloads.forEach(function (payload) { payloadStore.put(payload); });
          var next = normalizeMetadata(Object.assign({}, current, bundle.metadata || {}), bundle.conversationId, clock);
          next.lastSequence = Number(current.lastSequence || 0) + assigned.length;
          next.revision = Number(current.revision || 0) + 1;
          next.updatedAt = Number(clock());
          if (!next.createdAt) next.createdAt = next.updatedAt;
          metaStore.put(next);
          await done;
          return { metadata: clone(next), events: assigned.map(clone) };
        } catch (error) {
          try { tx.abort(); } catch (_) {}
          throw error;
        }
      },
      queryEvents: async function (conversationId, cursor, limit, filter) {
        var db = await open();
        var tx = db.transaction(['journal_events'], 'readonly');
        var done = transactionDone(tx);
        var store = tx.objectStore('journal_events');
        var direction = hasOwn(cursor, 'beforeSequence') || (!hasOwn(cursor, 'afterSequence') && !hasOwn(cursor, 'beforeSequence')) ? 'prev' : 'next';
        var source = filter && filter.types && filter.types.length ? store.index('by_type') : store;
        var pages = await Promise.all(eventRanges(conversationId, cursor, filter).map(function (range) {
          return new Promise(function (resolve, reject) {
            var values = [];
            var request = source.openCursor(range, direction);
            request.onerror = function () { reject(request.error); };
            request.onsuccess = function () {
              var item = request.result;
              if (!item) { resolve(values); return; }
              if (eventMatches(item.value, filter)) values.push(clone(item.value));
              if (values.length >= limit) { resolve(values); return; }
              item.continue();
            };
          });
        }));
        await done;
        var values = [].concat.apply([], pages).sort(function (a, b) { return a.sequence - b.sequence; });
        return direction === 'prev' ? values.slice(-limit) : values.slice(0, limit);
      },
      countEvents: async function (conversationId, filter, cursor) {
        return one('journal_events', 'readonly', function (store) {
          var source = filter && filter.types && filter.types.length ? store.index('by_type') : store;
          return Promise.all(eventRanges(conversationId, cursor, filter).map(function (range) {
            return requestPromise(source.count(range));
          })).then(function (counts) {
            return counts.reduce(function (total, count) { return total + count; }, 0);
          });
        });
      },
      putStream: async function (buffer) { return one('stream_buffers', 'readwrite', async function (store) { await requestPromise(store.put(buffer)); return clone(buffer); }); },
      getStream: async function (conversationId, generationId, modelRequestId) { return one('stream_buffers', 'readonly', function (store) { return requestPromise(store.get([conversationId, generationId, modelRequestId])); }).then(function (value) { return value || null; }); },
      listStreams: async function (conversationId, generationId) {
        return one('stream_buffers', 'readonly', function (store) {
          return requestPromise(store.getAll()).then(function (values) {
            return values.filter(function (item) { return item.conversationId === conversationId && (!generationId || item.generationId === generationId); });
          });
        });
      },
      deleteStream: async function (conversationId, generationId, modelRequestId) { return one('stream_buffers', 'readwrite', async function (store) { await requestPromise(store.delete([conversationId, generationId, modelRequestId])); return true; }); },
      putPayload: async function (payload) { return one('payload_blobs', 'readwrite', async function (store) { await requestPromise(store.put(payload)); return clone(payload); }); },
      getPayload: async function (payloadId) { return one('payload_blobs', 'readonly', function (store) { return requestPromise(store.get(payloadId)); }).then(function (value) { return value || null; }); },
      missingPayloadIds: async function (ids) {
        return one('payload_blobs', 'readonly', async function (store) {
          var keys = await Promise.all(ids.map(function (id) { return requestPromise(store.getKey(id)); }));
          return ids.filter(function (_, index) { return keys[index] === undefined; });
        });
      },
      listCheckpoints: async function (conversationId) { return one('summary_checkpoints', 'readonly', function (store) { return requestPromise(store.getAll()).then(function (values) { return values.filter(function (item) { return item.conversationId === conversationId; }); }); }); },
      listMetadata: async function () { return one('conversation_meta', 'readonly', function (store) { return requestPromise(store.getAll()); }); },
      clearConversation: async function (conversationId) {
        var db = await open();
        var tx = db.transaction(STORE_NAMES.slice(), 'readwrite');
        var done = transactionDone(tx);
        tx.objectStore('conversation_meta').delete(conversationId);
        async function deleteRange(storeName, range) {
          await new Promise(function (resolve, reject) {
            var request = tx.objectStore(storeName).openCursor(range);
            request.onerror = function () { reject(request.error); };
            request.onsuccess = function () {
              var cursor = request.result;
              if (!cursor) { resolve(); return; }
              cursor.delete();
              cursor.continue();
            };
          });
        }
        await deleteRange('journal_events', rangeForConversation(conversationId));
        await deleteRange('summary_checkpoints', idbKeyRange.bound([conversationId, ''], [conversationId, '\uffff']));
        await deleteRange('stream_buffers', idbKeyRange.bound([conversationId, '', ''], [conversationId, '\uffff', '\uffff']));
        var commands = await requestPromise(tx.objectStore('command_dedup').getAll());
        commands.filter(function (item) { return item.conversationId === conversationId; }).forEach(function (item) { tx.objectStore('command_dedup').delete(item.commandId); });
        var payloads = await requestPromise(tx.objectStore('payload_blobs').getAll());
        payloads.filter(function (item) { return item.conversationId === conversationId; }).forEach(function (item) { tx.objectStore('payload_blobs').delete(item.payloadId); });
        await done;
      },
    };
  }

  function create(options) {
    options = options || {};
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : function (prefix) { nextId += 1; return String(prefix || 'id') + '_' + Number(clock()).toString(36) + '_' + nextId.toString(36); };
    var cryptoApi = options.crypto || root && root.crypto;
    var payloadThreshold = Number.isFinite(Number(options.payloadThresholdBytes))
      ? Math.max(1024, Number(options.payloadThresholdBytes))
      : DEFAULT_PAYLOAD_THRESHOLD;
    var indexedDB = options.indexedDB || root && root.indexedDB;
    var idbKeyRange = options.IDBKeyRange || root && root.IDBKeyRange;
    var runtimeScope = text(options.runtimeScope) === 'incognito' ? 'incognito' : 'regular';
    var databaseName = text(options.databaseName)
      || (runtimeScope === 'incognito' ? DATABASE_NAME + '_incognito' : DATABASE_NAME);
    var backend = options.backend || (options.memory === true || !indexedDB
      ? createMemoryBackend(options.memoryState, clock)
      : createIndexedDbBackend(indexedDB, idbKeyRange, clock, databaseName));
    var locks = Object.create(null);
    var faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : null;
    var onMutation = typeof options.onMutation === 'function' ? options.onMutation : null;

    function metadataRuntimeScope(metadata) {
      var explicitScope = text(metadata && metadata.runtimeScope);
      if (explicitScope === 'incognito' || explicitScope === 'regular') return explicitScope;
      return metadata && metadata.activeGeneration && metadata.activeGeneration.surface
        && metadata.activeGeneration.surface.incognito === true ? 'incognito' : 'regular';
    }
    function metadataBelongsToRuntime(metadata) {
      return !!metadata && metadataRuntimeScope(metadata) === runtimeScope;
    }
    async function requireRuntimeMetadata(conversationId) {
      conversationId = requiredId(conversationId, 'conversationId');
      var value = await backend.getMetadata(conversationId);
      if (!metadataBelongsToRuntime(value)) {
        throw journalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist');
      }
      return normalizeMetadata(value, conversationId, clock);
    }

    function inject(point, context) {
      if (!faultInjector) return;
      var result = faultInjector(point, clone(context || {}));
      if (result instanceof Error) throw result;
      if (result === true) throw journalError('FAULT_INJECTED', 'Fault injected at ' + point, { point: point });
    }
    function notifyMutation(conversationId, committed) {
      if (!onMutation) return;
      try {
        onMutation({
          conversationId: conversationId,
          metadata: clone(committed && committed.metadata || null),
          eventCount: Array.isArray(committed && committed.events) ? committed.events.length : 0,
        });
      } catch (_) {}
    }
    function withLock(conversationId, work) {
      var previous = locks[conversationId] || Promise.resolve();
      var current = previous.catch(function () {}).then(work);
      var tracked = current.then(function () {}, function () {}).finally(function () {
        if (locks[conversationId] === tracked) delete locks[conversationId];
      });
      locks[conversationId] = tracked;
      return current;
    }
    async function preparePayload(payload, conversationId, generationId) {
      var serialized = stableStringify(payload);
      var size = byteLength(serialized);
      var payloadId = idGenerator('payload');
      var hash = await sha256(serialized, cryptoApi);
      return {
        record: {
          schemaVersion: 1,
          payloadId: payloadId,
          conversationId: conversationId,
          generationId: text(generationId),
          sha256: hash,
          byteLength: size,
          encoding: 'json',
          value: clone(payload),
          createdAt: Number(clock()),
        },
        ref: { payloadId: payloadId, sha256: hash, byteLength: size, encoding: 'json' },
      };
    }
    // Snapshot bodies share immutable message/system/tool components inside
    // the existing payload store. References are hashes scoped to a conversation.
    async function prepareSnapshot(payload, conversationId, generationId, parts) {
      var skeleton = clone(payload);
      var fields = [];
      var paths = [['system'], ['messages'], ['tools'], ['runtimeContext'], ['contextAppendMessages'],
        ['promptMessages'], ['promptState'], ['trace'], ['request', 'system'], ['request', 'messages'],
        ['request', 'tools'], ['request', 'contextTrace']];
      for (var path of paths) {
        var parent = path.length === 1 ? skeleton : skeleton[path[0]];
        var key = path[path.length - 1];
        if (!isRecord(parent) || !hasOwn(parent, key) || parent[key] === undefined) continue;
        var array = key === 'messages' || key === 'promptMessages' || key === 'contextAppendMessages';
        array = array && Array.isArray(parent[key]);
        var values = array ? parent[key] : [parent[key]];
        var hashes = [];
        for (var part of values) {
          var serialized = stableStringify(part);
          var hash = await sha256(serialized, cryptoApi);
          hashes.push(hash);
          var partId = snapshotPartId(conversationId, hash);
          if (!parts.has(partId)) {
            parts.set(partId, { schemaVersion: 1, payloadId: partId, conversationId: conversationId,
              generationId: '', sha256: hash, byteLength: byteLength(serialized), encoding: 'json',
              value: clone(part), createdAt: Number(clock()) });
          }
        }
        fields.push({ path: path, array: array, hashes: hashes });
        delete parent[key];
      }
      var prepared = await preparePayload({ payload: skeleton, fields: fields }, conversationId, generationId);
      prepared.record.encoding = prepared.ref.encoding = SNAPSHOT_ENCODING;
      return prepared;
    }
    async function resolveSnapshot(record, readPart, view) {
      if (record.encoding !== SNAPSHOT_ENCODING) return record.value;
      var snapshot = record.value;
      if (!isRecord(snapshot) || !isRecord(snapshot.payload) || !Array.isArray(snapshot.fields)) {
        throw journalError('INVALID_IMPORT', 'Invalid request snapshot');
      }
      var payload = clone(snapshot.payload);
      var seenFields = new Set();
      for (var field of snapshot.fields) {
        if (!isRecord(field) || !Array.isArray(field.path) || !Array.isArray(field.hashes)
            || typeof field.array !== 'boolean' || field.path.length < 1 || field.path.length > 2
            || field.path.some(function (key) { return typeof key !== 'string' || key.indexOf('.') !== -1; })
            || !/^(?:system|messages|tools|runtimeContext|contextAppendMessages|promptMessages|promptState|trace|request\.(?:system|messages|tools|contextTrace))$/.test(field.path.join('.'))
            || (!field.array && field.hashes.length !== 1) || seenFields.has(field.path.join('.'))) {
          throw journalError('INVALID_IMPORT', 'Invalid request snapshot field');
        }
        seenFields.add(field.path.join('.'));
        if (view === 'runtime' && field.path.join('.') !== 'promptMessages' && field.path.join('.') !== 'promptState') continue;
        var values = [];
        for (var hash of field.hashes) {
          if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw journalError('INVALID_IMPORT', 'Invalid snapshot component hash');
          var part = await readPart(snapshotPartId(record.conversationId, hash));
          if (!part || part.conversationId !== record.conversationId || part.encoding !== 'json' || part.sha256 !== hash) {
            throw journalError('PAYLOAD_MISSING', 'Request snapshot component is missing or invalid');
          }
          if (view !== 'validate') values.push(clone(part.value));
        }
        var parent = field.path.length === 1 ? payload : payload.request;
        if (!isRecord(parent)) throw journalError('INVALID_IMPORT', 'Invalid request snapshot parent');
        if (view !== 'validate') parent[field.path[field.path.length - 1]] = field.array ? values : values[0];
      }
      return payload;
    }
    function snapshotDependencies(record) {
      if (record.encoding !== SNAPSHOT_ENCODING) return [];
      return record.value.fields.reduce(function (ids, field) {
        return ids.concat(field.hashes.map(function (hash) { return snapshotPartId(record.conversationId, hash); }));
      }, []);
    }
    async function prepareEvents(rawEvents, conversationId, defaults, includeAllParts) {
      var payloads = [];
      var parts = new Map();
      var events = [];
      for (var index = 0; index < rawEvents.length; index += 1) {
        var event = normalizeEvent(rawEvents[index], conversationId, defaults || {}, clock, idGenerator);
        var snapshot = event.type === 'context_injected' || event.type === 'model_request_started';
        if (!event.payloadRef && (snapshot || byteLength(event.payload) > payloadThreshold)) {
          var prepared = snapshot
            ? await prepareSnapshot(event.payload, conversationId, event.generationId, parts)
            : await preparePayload(event.payload, conversationId, event.generationId);
          payloads.push(prepared.record);
          event.payloadRef = prepared.ref;
          event.payload = Object.assign(snapshot ? snapshotPreview(event.payload) : {}, { externalized: true });
        }
        events.push(event);
      }
      var partIds = Array.from(parts.keys());
      if (!includeAllParts && partIds.length && typeof backend.missingPayloadIds === 'function') {
        partIds = await backend.missingPayloadIds(partIds);
      }
      return { events: events, payloads: payloads.concat(partIds.map(function (id) { return parts.get(id); })) };
    }

    async function transaction(conversationId, mode, callback) {
      conversationId = requiredId(conversationId, 'conversationId');
      if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError('Journal transaction mode must be readonly or readwrite');
      if (typeof callback !== 'function') throw new TypeError('Journal transaction callback is required');
      return withLock(conversationId, async function () {
        inject('transaction_started', { conversationId: conversationId, mode: mode });
        var existing = await backend.getMetadata(conversationId);
        if (existing && !metadataBelongsToRuntime(existing)) {
          throw journalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist');
        }
        var metadata = normalizeMetadata(existing || defaultMetadata(conversationId), conversationId, clock);
        var expectedRevision = metadata.revision;
        var stagedEvents = [];
        var stagedCommands = [];
        var stagedCheckpoints = [];
        var stagedPayloads = [];
        var dirtyMetadata = false;
        var port = {
          getMetadata: async function () { return clone(metadata); },
          setMetadata: function (value) {
            if (mode !== 'readwrite') throw journalError('READONLY_TRANSACTION', 'Cannot change metadata in a readonly transaction');
            metadata = normalizeMetadata(Object.assign({}, metadata, clone(value || {})), conversationId, clock);
            dirtyMetadata = true;
          },
          patchMetadata: function (value) {
            if (mode !== 'readwrite') throw journalError('READONLY_TRANSACTION', 'Cannot change metadata in a readonly transaction');
            metadata = normalizeMetadata(Object.assign({}, metadata, clone(value || {})), conversationId, clock);
            dirtyMetadata = true;
          },
          append: function (event) {
            if (mode !== 'readwrite') throw journalError('READONLY_TRANSACTION', 'Cannot append in a readonly transaction');
            stagedEvents.push(clone(event));
          },
          appendMany: function (events) {
            if (!Array.isArray(events)) throw new TypeError('events must be an array');
            events.forEach(port.append);
          },
          getCommandResult: async function (commandId) {
            commandId = requiredId(commandId, 'commandId');
            var local = stagedCommands.find(function (item) { return item.commandId === commandId; });
            if (local) return clone(local.result);
            var stored = await backend.getCommand(commandId);
            return stored && stored.conversationId === conversationId ? clone(stored.result) : null;
          },
          putCommandResult: function (commandId, result) {
            if (mode !== 'readwrite') throw journalError('READONLY_TRANSACTION', 'Cannot write command dedup in a readonly transaction');
            commandId = requiredId(commandId, 'commandId');
            stagedCommands.push({
              schemaVersion: 1,
              commandId: commandId,
              conversationId: conversationId,
              result: clone(result),
              createdAt: Number(clock()),
            });
          },
          getActiveCheckpoint: async function () { return backend.getCheckpoint(conversationId, metadata.latestCheckpointId); },
          putCheckpoint: function (checkpoint) {
            if (mode !== 'readwrite') throw journalError('READONLY_TRANSACTION', 'Cannot write checkpoint in a readonly transaction');
            stagedCheckpoints.push(clone(checkpoint));
            metadata.latestCheckpointId = checkpoint.checkpointId;
            dirtyMetadata = true;
          },
          putPayload: function (payload) {
            if (mode !== 'readwrite') throw journalError('READONLY_TRANSACTION', 'Cannot write payload in a readonly transaction');
            stagedPayloads.push(clone(payload));
          },
        };
        var result = await callback(port);
        if (mode === 'readonly') return result;
        metadata.runtimeScope = runtimeScope;
        var prepared = await prepareEvents(stagedEvents, conversationId, Object.assign({}, metadata.activeGeneration || {}, {
          branchId: metadata.lineage && metadata.lineage.branchId || 'main',
          actorId: metadata.activeGeneration && (metadata.activeGeneration.actorId
            || metadata.activeGeneration.surface && (String(metadata.activeGeneration.surface.type || 'surface') + ':' + String(metadata.activeGeneration.surface.instanceId || ''))),
          actorType: metadata.activeGeneration && (metadata.activeGeneration.actorType
            || metadata.activeGeneration.surface && metadata.activeGeneration.surface.type),
          subagentId: metadata.activeGeneration && (metadata.activeGeneration.subagentId
            || metadata.activeGeneration.lineage && metadata.activeGeneration.lineage.subagentId),
        }));
        stagedPayloads = stagedPayloads.concat(prepared.payloads);
        if (!dirtyMetadata && !prepared.events.length && !stagedCommands.length && !stagedCheckpoints.length && !stagedPayloads.length) return result;
        inject('before_commit', { conversationId: conversationId, eventCount: prepared.events.length });
        var committed = await backend.commitBundle({
          conversationId: conversationId,
          expectedRevision: expectedRevision,
          metadata: metadata,
          events: prepared.events,
          commands: stagedCommands,
          checkpoints: stagedCheckpoints,
          payloads: stagedPayloads,
        });
        inject('after_commit', { conversationId: conversationId, eventCount: committed.events.length });
        notifyMutation(conversationId, committed);
        return result === undefined ? committed : result;
      });
    }

    async function appendMany(conversationId, events) {
      if (!Array.isArray(events) || !events.length) return [];
      var committed = await transaction(conversationId, 'readwrite', function (tx) { tx.appendMany(events); });
      return committed.events;
    }
    async function append(conversationId, event) { return (await appendMany(conversationId, [event]))[0]; }
    async function putMetadata(conversationId, value) {
      var committed = await transaction(conversationId, 'readwrite', function (tx) { tx.setMetadata(value); });
      return committed.metadata;
    }
    async function getMetadata(conversationId) {
      conversationId = requiredId(conversationId, 'conversationId');
      var value = await backend.getMetadata(conversationId);
      return metadataBelongsToRuntime(value) ? normalizeMetadata(value, conversationId, clock) : null;
    }
    async function queryEvents(conversationId, cursor) {
      conversationId = requiredId(conversationId, 'conversationId');
      await requireRuntimeMetadata(conversationId);
      cursor = cursor || {};
      var limit = cursor.limit === undefined ? DEFAULT_PAGE_SIZE : Math.floor(Number(cursor.limit));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new TypeError('Event page limit must be between 1 and ' + MAX_PAGE_SIZE);
      var normalizedCursor = {};
      if (cursor.beforeSequence !== undefined) normalizedCursor.beforeSequence = Math.max(1, Math.floor(Number(cursor.beforeSequence)));
      if (cursor.afterSequence !== undefined) normalizedCursor.afterSequence = Math.max(0, Math.floor(Number(cursor.afterSequence)));
      if (hasOwn(normalizedCursor, 'beforeSequence') && hasOwn(normalizedCursor, 'afterSequence')) throw new TypeError('Event cursor cannot use beforeSequence and afterSequence together');
      var filter = {
        branchId: text(cursor.branchId), generationId: text(cursor.generationId), actorId: text(cursor.actorId),
        types: Array.isArray(cursor.types) ? cursor.types.slice() : [], q: text(cursor.q),
      };
      var events = await backend.queryEvents(conversationId, normalizedCursor, limit, filter);
      var first = events[0] && events[0].sequence || 0;
      var last = events[events.length - 1] && events[events.length - 1].sequence || 0;
      var allFiltered = null;
      var filtered = filter.branchId || filter.generationId || filter.actorId || filter.types.length || filter.q;
      // Status reads request one terminal event. Count index keys instead of
      // loading the entire conversation again just to compute page metadata.
      var typeOnly = filter.types.length && !filter.branchId && !filter.generationId && !filter.actorId && !filter.q;
      var counts = typeOnly ? await Promise.all([
        backend.countEvents(conversationId, filter),
        first ? backend.countEvents(conversationId, filter, { beforeSequence: first }) : 0,
        last ? backend.countEvents(conversationId, filter, { afterSequence: last }) : 0,
      ]) : null;
      var total = counts ? counts[0] : filtered
        ? ((allFiltered = await backend.queryEvents(conversationId, {}, Number.MAX_SAFE_INTEGER, filter)).length)
        : await backend.countEvents(conversationId);
      return {
        events: events,
        total: total,
        limit: limit,
        hasMoreBefore: counts ? counts[1] > 0 : filtered ? !!(first && allFiltered && allFiltered[0] && allFiltered[0].sequence < first) : first > 1,
        hasMoreAfter: counts ? counts[2] > 0 : filtered ? !!(last && allFiltered && allFiltered[allFiltered.length - 1] && allFiltered[allFiltered.length - 1].sequence > last) : last > 0 && last < total,
        cursors: { beforeSequence: first || null, afterSequence: last || null },
        filter: filter,
      };
    }
    async function getAllEvents(conversationId) {
      var output = [];
      var afterSequence = 0;
      for (;;) {
        var page = await queryEvents(conversationId, { afterSequence: afterSequence, limit: MAX_PAGE_SIZE });
        if (!page.events.length) break;
        output = output.concat(page.events);
        afterSequence = page.events[page.events.length - 1].sequence;
        if (!page.hasMoreAfter) break;
      }
      return output;
    }
    async function putCheckpointAndCommit(checkpoint, event, commitOptions) {
      if (!isRecord(checkpoint)) throw new TypeError('checkpoint must be an object');
      commitOptions = commitOptions || {};
      if (commitOptions.beforeCommit !== undefined && typeof commitOptions.beforeCommit !== 'function') {
        throw new TypeError('commitOptions.beforeCommit must be a function');
      }
      var conversationId = requiredId(checkpoint.conversationId, 'checkpoint.conversationId');
      requiredId(checkpoint.checkpointId, 'checkpoint.checkpointId');
      if (!Number.isSafeInteger(checkpoint.throughSequence) || checkpoint.throughSequence < 0) throw new TypeError('checkpoint.throughSequence must be a non-negative integer');
      var result = await transaction(conversationId, 'readwrite', function (tx) {
        if (checkpoint.generationId || event && event.generationId) {
          return tx.getMetadata().then(function (metadata) {
            var expectedGenerationId = checkpoint.generationId || event.generationId;
            if (!metadata.activeGeneration || metadata.activeGeneration.generationId !== expectedGenerationId
                || TERMINAL_STATES[metadata.activeGeneration.state]
                || checkpoint.runtimeInstanceId
                  && metadata.activeGeneration.runtimeInstanceId !== checkpoint.runtimeInstanceId) {
              throw journalError('GENERATION_STALE', 'Summary checkpoint generation is no longer active');
            }
            tx.putCheckpoint(checkpoint);
            tx.append(Object.assign({
              type: 'summary_committed',
              generationId: text(event && event.generationId),
              turnId: text(event && event.turnId),
              payload: {
                checkpointId: checkpoint.checkpointId,
                throughSequence: checkpoint.throughSequence,
                sourceHash: checkpoint.sourceHash,
                usage: checkpoint.usage || {},
              },
            }, event || {}));
            if (commitOptions.beforeCommit) commitOptions.beforeCommit();
          });
        }
        tx.putCheckpoint(checkpoint);
        tx.append(Object.assign({
          type: 'summary_committed',
          generationId: text(event && event.generationId),
          turnId: text(event && event.turnId),
          payload: {
            checkpointId: checkpoint.checkpointId,
            throughSequence: checkpoint.throughSequence,
            sourceHash: checkpoint.sourceHash,
            usage: checkpoint.usage || {},
          },
        }, event || {}));
        if (commitOptions.beforeCommit) commitOptions.beforeCommit();
      });
      return { checkpoint: clone(checkpoint), event: result.events[0], metadata: result.metadata };
    }
    async function getActiveCheckpoint(conversationId) {
      conversationId = requiredId(conversationId, 'conversationId');
      await requireRuntimeMetadata(conversationId);
      return backend.getCheckpoint(conversationId);
    }
    async function getCheckpoint(conversationId, checkpointId) {
      conversationId = requiredId(conversationId, 'conversationId');
      await requireRuntimeMetadata(conversationId);
      return backend.getCheckpoint(conversationId, requiredId(checkpointId, 'checkpointId'));
    }
    async function getCommandResult(commandId) {
      var value = await backend.getCommand(requiredId(commandId, 'commandId'));
      if (!value || !await getMetadata(value.conversationId)) return null;
      return clone(value.result);
    }
    async function putCommandResult(commandId, conversationId, result) {
      await transaction(conversationId, 'readwrite', function (tx) { tx.putCommandResult(commandId, result); });
      return clone(result);
    }
    async function putStreamBuffer(buffer) {
      if (!isRecord(buffer)) throw new TypeError('stream buffer must be an object');
      var value = {
        schemaVersion: 1,
        conversationId: requiredId(buffer.conversationId, 'buffer.conversationId'),
        generationId: requiredId(buffer.generationId, 'buffer.generationId'),
        modelRequestId: requiredId(buffer.modelRequestId, 'buffer.modelRequestId'),
        text: String(buffer.text || ''),
        commentary: String(buffer.commentary || ''),
        reasoning: String(buffer.reasoning || ''),
        reasoningKind: text(buffer.reasoningKind),
        thinking: buffer.thinking === true,
        startedAt: Math.max(0, Number(buffer.startedAt) || 0),
        durationMs: Math.max(0, Number(buffer.durationMs) || 0),
        toolCalls: (Array.isArray(buffer.toolCalls) ? buffer.toolCalls : []).map(function (call) {
          return {
            toolCallId: requiredId(call && (call.toolCallId || call.callId), 'buffer.toolCalls[].toolCallId'),
            name: text(call && call.name).toUpperCase(),
            receivedChars: Math.max(0, Math.floor(Number(call && call.receivedChars) || 0)),
          };
        }),
        updatedAt: Number(buffer.updatedAt) || Number(clock()),
      };
      await requireRuntimeMetadata(value.conversationId);
      var stored = await backend.putStream(value);
      /* Stream buffers are the live counterpart of Journal rows. Notify
         readonly surfaces after the buffer is durable; otherwise the Journal
         append broadcast can make them render an intermediate state with the
         tool call missing until the next poll or a manual refresh. */
      notifyMutation(value.conversationId, { metadata: null, events: [] });
      return stored;
    }
    async function getStreamBuffer(conversationId, generationId, modelRequestId) {
      conversationId = requiredId(conversationId, 'conversationId');
      await requireRuntimeMetadata(conversationId);
      return backend.getStream(conversationId, generationId, modelRequestId);
    }
    async function listStreamBuffers(conversationId, generationId) {
      conversationId = requiredId(conversationId, 'conversationId');
      await requireRuntimeMetadata(conversationId);
      return backend.listStreams(conversationId, generationId);
    }
    async function deleteStreamBuffer(input) {
      var conversationId = requiredId(input.conversationId, 'conversationId');
      await requireRuntimeMetadata(conversationId);
      var removed = await backend.deleteStream(conversationId, requiredId(input.generationId, 'generationId'), requiredId(input.modelRequestId, 'modelRequestId'));
      /* Pair deletion notifications with putStreamBuffer so a terminal model
         row cannot leave a stale live tool/reasoning preview on readonly UI. */
      notifyMutation(conversationId, { metadata: null, events: [] });
      return removed;
    }
    async function putPayloadBlob(input) {
      input = input || {};
      var conversationId = requiredId(input.conversationId, 'payload.conversationId');
      await requireRuntimeMetadata(conversationId);
      var prepared = await preparePayload(input.value, conversationId, text(input.generationId));
      if (input.payloadId) {
        prepared.record.payloadId = requiredId(input.payloadId, 'payload.payloadId');
        prepared.ref.payloadId = prepared.record.payloadId;
      }
      await backend.putPayload(prepared.record);
      return prepared.ref;
    }
    async function getPayloadBlob(payloadId, expectedHash, readOptions) {
      var value = await backend.getPayload(requiredId(payloadId, 'payloadId'));
      if (!value) return null;
      if (!await getMetadata(value.conversationId)) return null;
      if (expectedHash && value.sha256 !== expectedHash) throw journalError('PAYLOAD_HASH_MISMATCH', 'Payload hash does not match its reference');
      var actual = await sha256(stableStringify(value.value), cryptoApi);
      if (actual !== value.sha256) throw journalError('PAYLOAD_HASH_MISMATCH', 'Stored payload failed SHA-256 verification');
      if (value.encoding === SNAPSHOT_ENCODING) {
        value.value = await resolveSnapshot(value, async function (id) {
          return getPayloadBlob(id);
        }, readOptions && readOptions.view);
      }
      return clone(value);
    }
    async function listActiveConversations() {
      var all = await backend.listMetadata();
      return all.filter(function (metadata) {
        return metadataBelongsToRuntime(metadata)
          && metadata.activeGeneration && !TERMINAL_STATES[metadata.activeGeneration.state];
      }).map(clone);
    }
    async function listMetadata() {
      var all = await backend.listMetadata();
      return all.filter(metadataBelongsToRuntime).map(clone);
    }
    async function deleteConversation(conversationId) {
      conversationId = requiredId(conversationId, 'conversationId');
      return withLock(conversationId, async function () {
        var metadata = await backend.getMetadata(conversationId);
        if (metadata && !metadataBelongsToRuntime(metadata)) {
          throw journalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist');
        }
        if (metadata && metadata.activeGeneration && !TERMINAL_STATES[metadata.activeGeneration.state]) {
          throw journalError('CONVERSATION_ACTIVE', 'An active Conversation cannot be deleted', {
            conversationId: conversationId,
            generationId: metadata.activeGeneration.generationId,
            state: metadata.activeGeneration.state,
          });
        }
        await backend.clearConversation(conversationId);
        return { conversationId: conversationId, deleted: !!metadata };
      });
    }
    async function exportConversation(conversationId, exportOptions) {
      exportOptions = exportOptions || {};
      var metadata = await getMetadata(conversationId);
      if (!metadata) throw journalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist');
      var events = await getAllEvents(conversationId);
      var includeReasoning = exportOptions.includeReasoning !== false;
      var sanitizedPayloads = Object.create(null);
      var sanitizedParts = new Map();
      if (!includeReasoning) {
        var sanitizedEvents = [];
        for (var eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
          var sourceEvent = events[eventIndex];
          var eventForExport = clone(sourceEvent);
          var referencedPayload = null;
          var referencedPayloadId = eventForExport.payloadRef && eventForExport.payloadRef.payloadId;
          if (referencedPayloadId) {
            referencedPayload = await backend.getPayload(referencedPayloadId);
            if (referencedPayload) eventForExport.payload = await resolveSnapshot(referencedPayload, function (id) { return getPayloadBlob(id); });
          }
          eventForExport = exportEventWithoutReasoning(eventForExport);
          if (!eventForExport) continue;
          if (referencedPayload) {
            if (exportOptions.includePayloads === true) {
              var sanitized = referencedPayload.encoding === SNAPSHOT_ENCODING
                ? await prepareSnapshot(eventForExport.payload, conversationId, eventForExport.generationId, sanitizedParts)
                : await preparePayload(eventForExport.payload, conversationId, eventForExport.generationId);
              var sanitizedPayload = sanitized.record;
              sanitizedPayload.payloadId = referencedPayloadId;
              eventForExport.payloadRef = Object.assign({}, eventForExport.payloadRef, {
                sha256: sanitizedPayload.sha256,
                byteLength: sanitizedPayload.byteLength,
                encoding: sanitizedPayload.encoding,
              });
              sanitizedPayloads[referencedPayloadId] = sanitizedPayload;
            }
            eventForExport.payload = Object.assign(referencedPayload.encoding === SNAPSHOT_ENCODING
              ? snapshotPreview(eventForExport.payload) : {}, { externalized: true });
          }
          sanitizedEvents.push(eventForExport);
        }
        events = sanitizedEvents;
      }
      var checkpoints = await backend.listCheckpoints(conversationId);
      if (!includeReasoning) checkpoints = checkpoints.map(function (checkpoint) { return scrubReasoning(checkpoint); });
      var payloads = [];
      if (exportOptions.includePayloads === true) {
        var ids = {};
        events.forEach(function (event) { if (event.payloadRef && event.payloadRef.payloadId) ids[event.payloadRef.payloadId] = true; });
        var queue = Object.keys(ids);
        for (var queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
          var payloadId = queue[queueIndex];
          var payload = sanitizedPayloads[payloadId] || sanitizedParts.get(payloadId) || await backend.getPayload(payloadId);
          if (!payload) throw journalError('PAYLOAD_MISSING', 'Export payload is missing: ' + payloadId);
          payloads.push(payload);
          snapshotDependencies(payload).forEach(function (id) { if (!ids[id]) { ids[id] = true; queue.push(id); } });
        }
      }
      return {
        manifest: {
          schemaVersion: 1,
          format: 'page-agent-conversation-journal',
          conversationId: conversationId,
          eventCount: events.length,
          includeReasoning: exportOptions.includeReasoning !== false,
          includePayloads: exportOptions.includePayloads === true,
          exportedAt: Number(clock()),
        },
        conversation: metadata,
        journal: events,
        checkpoints: checkpoints,
        payloads: payloads,
      };
    }
    async function importConversation(data, importOptions) {
      importOptions = importOptions || {};
      if (!isRecord(data) || !isRecord(data.conversation) || !Array.isArray(data.journal)) {
        throw journalError('INVALID_IMPORT', 'Conversation import requires conversation metadata and journal events');
      }
      var conversationId = requiredId(data.conversation.conversationId || data.manifest && data.manifest.conversationId, 'import.conversationId');
      var events = data.journal.slice().sort(function (a, b) { return Number(a.sequence) - Number(b.sequence); });
      var sequenceCompaction = !!(data.manifest && data.manifest.includeReasoning === false);
      var originalSequences = events.map(function (event) { return Number(event.sequence); });
      function compactedSequence(boundary) {
        var low = 0;
        var high = originalSequences.length;
        while (low < high) {
          var middle = Math.floor((low + high) / 2);
          if (originalSequences[middle] <= boundary) low = middle + 1;
          else high = middle;
        }
        return low;
      }
      events.forEach(function (event, index) {
        var sequence = Number(event.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 1
            || (!sequenceCompaction && sequence !== index + 1)
            || (sequenceCompaction && index > 0 && sequence <= originalSequences[index - 1])) {
          throw journalError('INVALID_IMPORT_SEQUENCE', sequenceCompaction
            ? 'Imported no-reasoning Journal sequence must be strictly increasing'
            : 'Imported Journal sequence must be contiguous from 1');
        }
        if (event.conversationId !== conversationId) throw journalError('CONVERSATION_MISMATCH', 'Imported event belongs to another conversation');
      });
      if (sequenceCompaction) {
        function compactSequenceReferences(value, seen) {
          if (value === null || value === undefined || typeof value !== 'object') return value;
          seen = seen || [];
          if (seen.indexOf(value) !== -1) return '[Circular]';
          seen.push(value);
          var compacted = Array.isArray(value) ? [] : {};
          Object.keys(value).forEach(function (key) {
            var item = value[key];
            if (typeof item === 'number' && Number.isSafeInteger(item)
                && /^(?:sequence|throughSequence|sourceSequence|startSequence|endSequence|previousThroughSequence|tailStartSequence|tailEndSequence|steeringThroughSequence|beforeSequence|afterSequence)$/i.test(key)) {
              item = compactedSequence(item);
            }
            compacted[key] = compactSequenceReferences(item, seen);
          });
          seen.pop();
          return compacted;
        }
        events = events.map(function (event, index) {
          var copy = compactSequenceReferences(event);
          copy.sequence = index + 1;
          return copy;
        });
      }
      if (data.manifest && Number(data.manifest.eventCount) !== events.length) {
        throw journalError('INVALID_IMPORT', 'Imported manifest eventCount does not match journal.jsonl');
      }
      var checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
      var payloads = Array.isArray(data.payloads) ? data.payloads : [];
      if (sequenceCompaction) checkpoints = checkpoints.map(function (checkpoint) {
        var compacted = clone(checkpoint);
        var originalThrough = Number(compacted && compacted.throughSequence);
        if (Number.isSafeInteger(originalThrough) && originalThrough >= 0) {
          compacted.throughSequence = compactedSequence(originalThrough);
        }
        return compacted;
      });
      checkpoints.forEach(function (checkpoint) {
        if (!isRecord(checkpoint) || text(checkpoint.conversationId) !== conversationId || !text(checkpoint.checkpointId)
            || !Number.isSafeInteger(checkpoint.throughSequence) || checkpoint.throughSequence < 0
            || checkpoint.throughSequence > events.length) {
          throw journalError('INVALID_IMPORT', 'Imported SummaryCheckpoint is invalid or belongs to another conversation');
        }
      });
      var payloadById = Object.create(null);
      for (var p = 0; p < payloads.length; p += 1) {
        var payload = payloads[p];
        if (!isRecord(payload) || text(payload.conversationId) !== conversationId || !text(payload.payloadId)) {
          throw journalError('INVALID_IMPORT', 'Imported payload is invalid or belongs to another conversation');
        }
        if (payloadById[payload.payloadId]) throw journalError('INVALID_IMPORT', 'Imported payloadId is duplicated: ' + payload.payloadId);
        var actualHash = await sha256(stableStringify(payload.value), cryptoApi);
        if (payload.sha256 !== actualHash) throw journalError('PAYLOAD_HASH_MISMATCH', 'Imported payload failed SHA-256 verification');
        payloadById[payload.payloadId] = payload;
      }
      for (var importedPayload of payloads) {
        if (importedPayload.encoding === SNAPSHOT_ENCODING) {
          await resolveSnapshot(importedPayload, async function (id) { return payloadById[id]; }, 'validate');
        }
      }
      // Every externalized event must resolve to a payload in the portable
      // backup. Check this even when the payload list is empty so an import
      // can never publish a Journal with dangling references.
      events.forEach(function (event) {
        if (!event.payloadRef || !event.payloadRef.payloadId) return;
        var payload = payloadById[event.payloadRef.payloadId];
        if (!payload) throw journalError('INVALID_IMPORT', 'Imported event references a missing payload: ' + event.payloadRef.payloadId);
        if (event.payloadRef.sha256 && event.payloadRef.sha256 !== payload.sha256) {
          throw journalError('PAYLOAD_HASH_MISMATCH', 'Imported event payload reference does not match its payload');
        }
      });
      var latestCheckpointId = text(data.conversation.latestCheckpointId);
      if (latestCheckpointId && !checkpoints.some(function (checkpoint) { return checkpoint.checkpointId === latestCheckpointId; })) {
        throw journalError('INVALID_IMPORT', 'Imported metadata references a missing SummaryCheckpoint');
      }
      var prepared = await prepareEvents(events.map(function (event) {
        var copy = clone(event);
        delete copy.sequence;
        return copy;
      }), conversationId, data.conversation.activeGeneration || {}, true);
      await withLock(conversationId, async function () {
        var existing = await backend.getMetadata(conversationId);
        if (existing && !metadataBelongsToRuntime(existing)) {
          throw journalError('CONVERSATION_EXISTS', 'Conversation already exists in another runtime scope');
        }
        if (existing && importOptions.replace !== true) throw journalError('CONVERSATION_EXISTS', 'Conversation already exists');
        if (existing && existing.activeGeneration && !TERMINAL_STATES[existing.activeGeneration.state]) {
          throw journalError('CONVERSATION_ACTIVE', 'An active Conversation cannot be replaced', {
            conversationId: conversationId,
            generationId: existing.activeGeneration.generationId,
            state: existing.activeGeneration.state,
          });
        }
        var metadata = clone(data.conversation);
        metadata.runtimeScope = runtimeScope;
        metadata.lastSequence = 0;
        metadata.revision = 0;
        await backend.commitBundle({
          conversationId: conversationId,
          replace: !!existing,
          metadata: metadata,
          events: prepared.events,
          commands: [],
          checkpoints: checkpoints.map(clone),
          payloads: payloads.map(clone).concat(prepared.payloads),
        });
      });
      var imported = await getMetadata(conversationId);
      if (!imported || imported.lastSequence !== events.length) throw journalError('IMPORT_VERIFICATION_FAILED', 'Imported Journal failed event-count verification');
      return { conversationId: conversationId, eventCount: events.length, metadata: imported };
    }

    // Fork/replay/search are Journal projections. They never maintain a second
    // history tree: a fork copies one verified prefix and records its parent
    // boundary in metadata and in the child Journal itself.
    async function forkConversation(sourceConversationId, targetConversationId, forkOptions) {
      sourceConversationId = requiredId(sourceConversationId, 'sourceConversationId');
      targetConversationId = requiredId(targetConversationId, 'targetConversationId');
      if (sourceConversationId === targetConversationId) throw journalError('INVALID_FORK_BOUNDARY', 'A Conversation cannot fork onto itself');
      forkOptions = forkOptions || {};
      var source = await getMetadata(sourceConversationId);
      if (!source) throw journalError('CONVERSATION_NOT_FOUND', 'Source Conversation does not exist');
      // A Service Worker can terminate after the child Journal commits but
      // before the source command-dedup record is written. Treat a matching
      // child lineage as the already-completed operation on retry.
      var existingTarget = await getMetadata(targetConversationId);
      if (existingTarget) {
        var existingLineage = existingTarget.lineage || {};
        var boundaryMatches = forkOptions.boundarySequence === undefined
          || Number(existingLineage.parentSequence) === Math.floor(Number(forkOptions.boundarySequence));
        var branchMatches = !text(forkOptions.branchId) || text(existingLineage.branchId) === text(forkOptions.branchId);
        var expectedOrigin = text(forkOptions.origin) || 'fork';
        if (text(existingLineage.parentConversationId) === sourceConversationId
            && text(existingLineage.origin) === expectedOrigin && boundaryMatches && branchMatches) {
          return {
            conversationId: targetConversationId,
            sourceConversationId: sourceConversationId,
            boundarySequence: Number(existingLineage.parentSequence) || 0,
            branchId: text(existingLineage.branchId) || 'main',
            metadata: existingTarget,
            idempotent: true,
          };
        }
        throw journalError('CONVERSATION_EXISTS', 'Conversation already exists');
      }
      var sourceEvents = await getAllEvents(sourceConversationId);
      var sourceRevision = Number(source.revision) || 0;
      var boundary = forkOptions.boundarySequence === undefined
        ? sourceEvents.length : Math.floor(Number(forkOptions.boundarySequence));
      if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > sourceEvents.length) {
        throw journalError('INVALID_FORK_BOUNDARY', 'Fork boundary is outside the source Journal', { boundarySequence: boundary, lastSequence: sourceEvents.length });
      }
      assertClosedGenerationBoundary(sourceEvents, boundary);
      var prefix = sourceEvents.filter(function (event) { return event.sequence <= boundary; });
      if (prefix.length !== boundary) throw journalError('INVALID_FORK_BOUNDARY', 'Fork boundary is not contiguous');
      var payloadIds = Object.create(null);
      prefix.forEach(function (event) {
        if (event.payloadRef && event.payloadRef.payloadId) payloadIds[event.payloadRef.payloadId] = true;
      });
      var payloads = [];
      var payloadMap = Object.create(null);
      var forkPayloadQueue = Object.keys(payloadIds);
      for (var forkPayloadIndex = 0; forkPayloadIndex < forkPayloadQueue.length; forkPayloadIndex += 1) {
        var payloadId = forkPayloadQueue[forkPayloadIndex];
        var payload = await backend.getPayload(payloadId);
        if (!payload) throw journalError('INVALID_FORK_BOUNDARY', 'Fork source payload is missing: ' + payloadId);
        snapshotDependencies(payload).forEach(function (id) {
          if (!payloadIds[id]) { payloadIds[id] = true; forkPayloadQueue.push(id); }
        });
        var copiedPayload = clone(payload);
        var copiedId = payloadId === snapshotPartId(sourceConversationId, payload.sha256)
          ? snapshotPartId(targetConversationId, payload.sha256) : idGenerator('payload');
        payloadMap[payloadId] = copiedId;
        copiedPayload.payloadId = copiedId;
        copiedPayload.conversationId = targetConversationId;
        payloads.push(copiedPayload);
      }
      var branchId = text(forkOptions.branchId) || idGenerator('branch');
      var lineage = source.lineage || {};
      var childMetadata = clone(source);
      childMetadata.conversationId = targetConversationId;
      childMetadata.lastSequence = 0;
      childMetadata.revision = 0;
      childMetadata.activeGeneration = null;
      childMetadata.latestCheckpointId = null;
      childMetadata.createdAt = Number(clock());
      childMetadata.updatedAt = childMetadata.createdAt;
      childMetadata.archived = false;
      childMetadata.deleted = false;
      if (forkOptions.assistantId) childMetadata.assistantId = text(forkOptions.assistantId);
      if (forkOptions.serviceId) childMetadata.serviceId = text(forkOptions.serviceId);
      childMetadata.lineage = {
        rootConversationId: text(lineage.rootConversationId) || sourceConversationId,
        parentConversationId: sourceConversationId,
        parentSequence: boundary,
        branchId: branchId,
        origin: text(forkOptions.origin) || 'fork',
        delegationDepth: Math.max(0, Number(lineage.delegationDepth) || 0) + (forkOptions.origin === 'subagent' ? 1 : 0),
        branches: (Array.isArray(lineage.branches) ? clone(lineage.branches) : []).concat([{
          branchId: branchId, parentBranchId: text(lineage.branchId) || 'main', forkSequence: boundary, createdAt: Number(clock()),
        }]),
      };
      var checkpoints = await backend.listCheckpoints(sourceConversationId);
      checkpoints = checkpoints.filter(function (checkpoint) { return Number(checkpoint.throughSequence) <= boundary; }).map(function (checkpoint) {
        var copy = clone(checkpoint);
        copy.conversationId = targetConversationId;
        return copy;
      });
      if (checkpoints.length) childMetadata.latestCheckpointId = checkpoints[checkpoints.length - 1].checkpointId;
      var eventIdMap = Object.create(null);
      prefix.forEach(function (event) {
        if (text(event.eventId)) eventIdMap[event.eventId] = idGenerator('event');
      });
      var childEvents = prefix.map(function (event, eventIndex) {
        var copy = clone(event);
        copy.conversationId = targetConversationId;
        // Preserve only explicit identities. Older Journals may contain them,
        // and IndexedDB's unique index requires a fresh value in the child.
        if (text(event.eventId)) copy.eventId = eventIdMap[event.eventId];
        else delete copy.eventId;
        if (copy.parentEventId) copy.parentEventId = eventIdMap[copy.parentEventId] || '';
        copy.branchId = branchId;
        copy.sequence = eventIndex + 1;
        if (copy.payloadRef && payloadMap[copy.payloadRef.payloadId]) copy.payloadRef.payloadId = payloadMap[copy.payloadRef.payloadId];
        return copy;
      });
      childEvents.push({
        sequence: childEvents.length + 1,
        conversationId: targetConversationId,
        type: 'conversation_forked', branchId: branchId,
        parentEventId: childEvents.length ? text(childEvents[childEvents.length - 1].eventId) : '',
        causationId: text(forkOptions.causationId), correlationId: text(forkOptions.correlationId),
        actorId: text(forkOptions.actorId), actorType: text(forkOptions.actorType),
        payload: {
          sourceConversationId: sourceConversationId, sourceSequence: boundary,
          parentBranchId: text(lineage.branchId) || 'main', reason: text(forkOptions.reason) || 'fork',
        },
      });
      var currentSource = await getMetadata(sourceConversationId);
      if (!currentSource || Number(currentSource.revision) !== sourceRevision
          || Number(currentSource.lastSequence) !== sourceEvents.length) {
        throw journalError('JOURNAL_CAS_CONFLICT', 'Source Conversation changed while preparing the fork', {
          conversationId: sourceConversationId, expectedRevision: sourceRevision,
          actualRevision: currentSource && currentSource.revision,
        });
      }
      await importConversation({
        manifest: { schemaVersion: 1, format: 'page-agent-conversation-journal', conversationId: targetConversationId, eventCount: childEvents.length, includeReasoning: true },
        conversation: childMetadata,
        journal: childEvents,
        checkpoints: checkpoints,
        payloads: payloads,
      }, { replace: false });
      return { conversationId: targetConversationId, sourceConversationId: sourceConversationId, boundarySequence: boundary, branchId: branchId, metadata: await getMetadata(targetConversationId) };
    }

    async function searchEvents(conversationId, query) {
      conversationId = requiredId(conversationId, 'conversationId');
      query = query || {};
      await requireRuntimeMetadata(conversationId);
      var all = await getAllEvents(conversationId);
      var filter = { branchId: text(query.branchId), generationId: text(query.generationId), actorId: text(query.actorId), types: query.types, q: text(query.q) };
      var events = all.filter(function (event) { return eventMatches(event, filter); });
      var from = Math.max(0, Math.floor(Number(query.fromSequence) || 0));
      var to = Math.max(0, Math.floor(Number(query.toSequence) || 0));
      if (from) events = events.filter(function (event) { return event.sequence >= from; });
      if (to) events = events.filter(function (event) { return event.sequence <= to; });
      var limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.limit) || DEFAULT_PAGE_SIZE)));
      return { conversationId: conversationId, events: events.slice(-limit), total: events.length, filter: filter };
    }

    async function replayConversation(conversationId, replayOptions) {
      conversationId = requiredId(conversationId, 'conversationId');
      replayOptions = replayOptions || {};
      var metadata = await requireRuntimeMetadata(conversationId);
      var allEvents = await getAllEvents(conversationId);
      var replayFilter = { branchId: text(replayOptions.branchId), generationId: text(replayOptions.generationId), actorId: text(replayOptions.actorId), types: replayOptions.types, q: text(replayOptions.q) };
      var fromSequence = Math.max(0, Math.floor(Number(replayOptions.fromSequence) || 0));
      var toSequence = Math.max(0, Math.floor(Number(replayOptions.toSequence) || 0));
      var events = allEvents.filter(function (event) {
        if (!eventMatches(event, replayFilter)) return false;
        if (fromSequence && event.sequence < fromSequence) return false;
        if (toSequence && event.sequence > toSequence) return false;
        return true;
      });
      if (replayOptions.includePayloads === true) {
        for (var index = 0; index < events.length; index += 1) {
          if (!events[index].payloadRef) continue;
          var payload = await getPayloadBlob(events[index].payloadRef.payloadId, events[index].payloadRef.sha256);
          if (payload) events[index].payload = clone(payload.value);
        }
      }
      return { conversationId: conversationId, branchId: metadata.lineage && metadata.lineage.branchId || 'main', throughSequence: events.length ? events[events.length - 1].sequence : 0, events: events, metadata: metadata };
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      databaseName: databaseName,
      runtimeScope: runtimeScope,
      backendKind: backend.kind,
      open: backend.open,
      transaction: transaction,
      append: append,
      appendMany: appendMany,
      getMetadata: getMetadata,
      putMetadata: putMetadata,
      listMetadata: listMetadata,
      queryEvents: queryEvents,
      getAllEvents: getAllEvents,
      getCheckpoint: getCheckpoint,
      getActiveCheckpoint: getActiveCheckpoint,
      putCheckpointAndCommit: putCheckpointAndCommit,
      getCommandResult: getCommandResult,
      putCommandResult: putCommandResult,
      putStreamBuffer: putStreamBuffer,
      getStreamBuffer: getStreamBuffer,
      listStreamBuffers: listStreamBuffers,
      deleteStreamBuffer: deleteStreamBuffer,
      putPayloadBlob: putPayloadBlob,
      getPayloadBlob: getPayloadBlob,
      listActiveConversations: listActiveConversations,
      deleteConversation: deleteConversation,
      exportConversation: exportConversation,
      importConversation: importConversation,
      forkConversation: forkConversation,
      searchEvents: searchEvents,
      replayConversation: replayConversation,
      _backend: options.exposeBackendForTests === true ? backend : undefined,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    DATABASE_NAME: DATABASE_NAME,
    DATABASE_VERSION: DATABASE_VERSION,
    STORE_NAMES: STORE_NAMES,
    DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE: MAX_PAGE_SIZE,
    TERMINAL_STATES: TERMINAL_STATES,
    createMemoryState: createMemoryState,
    create: create,
  });
});
