(function attachRecordingArtifactStore(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var contract = commonJs ? require('../shared/recording-contract') : root.PageAutomationRecordingContract;
  var nodeCrypto = null;
  if (commonJs) { try { nodeCrypto = require('node:crypto'); } catch (_) {} }
  var api = factory(root, contract, nodeCrypto);
  if (commonJs) module.exports = api;
  if (root) root.PageAutomationRecordingArtifactStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, contract, nodeCrypto) {
  'use strict';
  if (!contract || contract.API_VERSION !== 1) throw new Error('RecordingContract must load before RecordingArtifactStore');
  var API_VERSION = 1;
  var DB_NAME = 'page_agent_recordings';
  var DB_VERSION = 4;
  var STORES = Object.freeze({
    CONTROL: 'control', SESSIONS: 'sessions', EVENTS: 'events', ARTIFACTS: 'artifacts',
    COLLECTIONS: 'draftCollections', REFS: 'refs', OPERATIONS: 'operations', GRANTS: 'grants',
  });
  var CONTROL_KEY = 'active';
  // Completed immutable artifacts use chrome.storage.local so split regular/incognito
  // runtimes share one durable source; active sessions and grants stay in scoped IDB.
  var SHARED_META_KEY_PREFIX = 'page_agent_shared_recording_meta:';
  var SHARED_ARTIFACT_KEY_PREFIX = 'page_agent_shared_recording_artifact:';
  var MAX_SESSION_DIAGNOSTICS = 64;
  function clone(value) { return contract.clone(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function appendDiagnostics(session, diagnostics) {
    if (!Array.isArray(session.diagnostics)) session.diagnostics = [];
    (diagnostics || []).forEach(function (diagnostic) {
      var value = clone(diagnostic || {});
      if (value.code === 'flush_timeout' || value.code === 'pending_ring_overflow' || value.code === 'browser_session_changed') {
        session.interrupted = true;
      }
      session.diagnostics.push(value);
    });
    if (session.diagnostics.length > MAX_SESSION_DIAGNOSTICS) {
      session.diagnostics.splice(0, session.diagnostics.length - MAX_SESSION_DIAGNOSTICS);
    }
  }
  function keyRangeOnly(IDBKeyRangeApi, value) { return IDBKeyRangeApi.only(value); }
  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
    });
  }
  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onabort = transaction.onerror = function () { reject(transaction.error || new Error('IndexedDB transaction failed')); };
    });
  }
  function cursorValues(source, range) {
    return new Promise(function (resolve, reject) {
      var values = [];
      var request = source.openCursor(range);
      request.onerror = function () { reject(request.error || new Error('IndexedDB cursor failed')); };
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) { resolve(values); return; }
        values.push(cursor.value);
        cursor.continue();
      };
    });
  }
  function createStore(indexedDBApi, IDBKeyRangeApi, options) {
    options = options || {};
    if (!indexedDBApi || typeof indexedDBApi.open !== 'function') throw new TypeError('RecordingArtifactStore requires IndexedDB');
    var runtimeScope = text(options.runtimeScope || 'regular') === 'incognito' ? 'incognito' : 'regular';
    var controlKey = runtimeScope === 'incognito' ? CONTROL_KEY + ':incognito' : CONTROL_KEY;
    var runtimeIncognito = runtimeScope === 'incognito';
    var sharedStorage = options.storage && typeof options.storage.get === 'function'
      ? options.storage : null;
    var cryptoApi = options.crypto || root.crypto;
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function' ? options.idGenerator : function (prefix) {
      nextId += 1;
      var random = cryptoApi && cryptoApi.randomUUID ? cryptoApi.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2);
      return prefix + '_' + Number(clock()).toString(36) + '_' + random.slice(0, 18) + nextId.toString(36);
    };
    var sharedArtifactCache = Object.create(null);
    var localArtifactsSynced = false;
    var sharedSyncQueue = Promise.resolve();

    function sharedMetaKey(recordingId) { return SHARED_META_KEY_PREFIX + text(recordingId); }
    function sharedArtifactKey(recordingId) { return SHARED_ARTIFACT_KEY_PREFIX + text(recordingId); }
    function storageInvoke(method, args) {
      if (!sharedStorage || typeof sharedStorage[method] !== 'function') return Promise.resolve(method === 'get' ? {} : undefined);
      args = Array.isArray(args) ? args.slice() : [];
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        }
        function callback(value) {
          var error = root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
          finish(error ? new Error(error.message || String(error)) : null, value);
        }
        try {
          var result = sharedStorage[method].apply(sharedStorage, args.concat(callback));
          if (result && typeof result.then === 'function') result.then(function (value) { finish(null, value); }, finish);
        } catch (error) { finish(error); }
      });
    }
    function sharedMetadata(record) {
      var artifact = record && record.artifact || {};
      var stats = artifact.stats || {};
      return {
        schemaVersion: 1,
        recordingId: text(record && record.recordingId),
        recordingUri: text(record && record.recordingUri),
        sourceSha256: text(record && record.sourceSha256),
        state: text(record && record.state),
        startedAt: Math.max(0, Number(artifact.startedAt) || 0),
        durationMs: Math.max(0, Number(artifact.durationMs) || 0),
        stats: {
          eventCount: Math.max(0, Number(stats.eventCount) || 0),
          tabCount: Math.max(0, Number(stats.tabCount) || 0),
          domainCount: Math.max(0, Number(stats.domainCount) || 0),
        },
        originIncognito: record && record.incognito === true,
        writerScope: runtimeScope,
        createdAt: Math.max(0, Number(record && record.createdAt) || Number(clock())),
        updatedAt: Number(clock()),
      };
    }
    async function getSharedMetadata(recordingId) {
      if (!sharedStorage) return null;
      var key = sharedMetaKey(recordingId);
      var stored = await storageInvoke('get', [[key]]);
      return stored && stored[key] || null;
    }
    async function persistSharedArtifact(record, allowRevive) {
      if (!sharedStorage || !record || !record.recordingId) return record;
      var metadata = await getSharedMetadata(record.recordingId);
      if (metadata && metadata.deleted === true && allowRevive !== true) return record;
      if (metadata && metadata.deleted !== true && metadata.sourceSha256 === record.sourceSha256) {
        sharedArtifactCache[record.recordingId] = clone(record);
        return record;
      }
      var metaKey = sharedMetaKey(record.recordingId);
      var artifactKey = sharedArtifactKey(record.recordingId);
      var values = {};
      values[metaKey] = sharedMetadata(record);
      values[artifactKey] = clone(record);
      await storageInvoke('set', [values]);
      sharedArtifactCache[record.recordingId] = clone(record);
      return record;
    }
    async function deleteSharedArtifact(recordingId, sourceSha256) {
      if (!sharedStorage) return;
      var metaKey = sharedMetaKey(recordingId);
      var existing = await getSharedMetadata(recordingId);
      var tombstone = {};
      tombstone[metaKey] = {
        schemaVersion: 1, recordingId: text(recordingId),
        sourceSha256: text(sourceSha256 || existing && existing.sourceSha256),
        deleted: true, writerScope: runtimeScope,
        deletedAt: Number(clock()), updatedAt: Number(clock()),
      };
      await storageInvoke('set', [tombstone]);
      await storageInvoke('remove', [[sharedArtifactKey(recordingId)]]);
      delete sharedArtifactCache[recordingId];
    }
    async function sharedStorageKeys() {
      if (!sharedStorage) return [];
      if (typeof sharedStorage.getKeys === 'function') {
        var keys = await storageInvoke('getKeys', []);
        return Array.isArray(keys) ? keys : [];
      }
      return Object.keys(await storageInvoke('get', [null]) || {});
    }
    async function listSharedMetadata(includeDeleted) {
      if (!sharedStorage) return [];
      var keys = (await sharedStorageKeys()).filter(function (key) {
        return String(key).indexOf(SHARED_META_KEY_PREFIX) === 0;
      });
      if (!keys.length) return [];
      var stored = await storageInvoke('get', [keys]);
      return keys.map(function (key) { return stored && stored[key]; }).filter(function (metadata) {
        return metadata && (includeDeleted === true || metadata.deleted !== true)
          && metadata.recordingId && metadata.sourceSha256;
      }).sort(function (left, right) {
        return Number(left.createdAt) - Number(right.createdAt)
          || text(left.recordingId).localeCompare(text(right.recordingId));
      });
    }
    async function loadSharedArtifacts(metadataList) {
      metadataList = Array.isArray(metadataList) ? metadataList : [];
      var missing = metadataList.filter(function (metadata) {
        var cached = sharedArtifactCache[metadata.recordingId];
        return !cached || cached.sourceSha256 !== metadata.sourceSha256;
      });
      if (missing.length) {
        var keys = missing.map(function (metadata) { return sharedArtifactKey(metadata.recordingId); });
        var stored = await storageInvoke('get', [keys]);
        missing.forEach(function (metadata) {
          var record = stored && stored[sharedArtifactKey(metadata.recordingId)];
          if (record && record.sourceSha256 === metadata.sourceSha256) sharedArtifactCache[metadata.recordingId] = clone(record);
        });
      }
      return metadataList.map(function (metadata) {
        return sharedArtifactCache[metadata.recordingId] || null;
      }).filter(Boolean).map(clone);
    }

    async function performSharedArtifactSync(input) {
      if (!sharedStorage) return { imported: 0, removed: 0 };
      input = clone(input || {});
      if (!localArtifactsSynced) {
        var localArtifacts = await transact([STORES.ARTIFACTS], 'readonly', function (stores) {
          return cursorValues(stores[STORES.ARTIFACTS]).then(clone);
        });
        for (var localIndex = 0; localIndex < localArtifacts.length; localIndex += 1) {
          await persistSharedArtifact(localArtifacts[localIndex]);
        }
        localArtifactsSynced = true;
      }
      var metadataList = await listSharedMetadata(true);
      var liveMetadata = metadataList.filter(function (metadata) { return metadata.deleted !== true; });
      var deletedIds = Object.create(null);
      metadataList.filter(function (metadata) { return metadata.deleted === true; }).forEach(function (metadata) {
        deletedIds[metadata.recordingId] = true;
      });
      var sharedArtifacts = await loadSharedArtifacts(liveMetadata);
      return transact([STORES.ARTIFACTS, STORES.COLLECTIONS, STORES.REFS], 'readwrite', async function (stores) {
        var collections = (await cursorValues(stores[STORES.COLLECTIONS])).filter(function (collection) {
          return belongsToRuntime(collection)
            && text(collection.profileId || 'default') === text(input.profileId || 'default');
        });
        collections.sort(function (left, right) {
          return Number(right.updatedAt) - Number(left.updatedAt)
            || Number(right.createdAt) - Number(left.createdAt)
            || text(right.draftCollectionId).localeCompare(text(left.draftCollectionId));
        });
        var collection = collections[0] || null;
        var imported = 0;
        var removed = 0;
        var changed = false;
        if (!collection && sharedArtifacts.length) {
          collection = {
            draftCollectionId: idGenerator('collection'), seedTabId: Number(input.seedTabId) || 0,
            profileId: text(input.profileId || 'default'), incognito: runtimeIncognito,
            selectionId: idGenerator('selection'), revision: 1, sourceRecordingIds: [],
            selectedRanges: [], selectionInitializedRecordingIds: [],
            createdAt: Number(clock()), updatedAt: Number(clock()),
          };
          stores[STORES.COLLECTIONS].add(collection);
          collections.push(collection);
        }
        Object.keys(deletedIds).forEach(function (recordingId) {
          collections.forEach(function (candidate) {
            var sourceLength = (candidate.sourceRecordingIds || []).length;
            candidate.sourceRecordingIds = (candidate.sourceRecordingIds || []).filter(function (id) { return id !== recordingId; });
            candidate.selectedRanges = (candidate.selectedRanges || []).filter(function (range) { return range.recordingId !== recordingId; });
            candidate.selectionInitializedRecordingIds = (candidate.selectionInitializedRecordingIds || []).filter(function (id) { return id !== recordingId; });
            if (candidate.sourceRecordingIds.length === sourceLength) return;
            candidate.selectedRanges.forEach(function (range, index) { range.selectionOrder = index; });
            stores[STORES.REFS].delete(draftRefId(candidate.draftCollectionId, recordingId));
            if (candidate === collection) changed = true;
            else {
              candidate.selectionId = idGenerator('selection');
              candidate.revision = Math.max(0, Number(candidate.revision) || 0) + 1;
              candidate.updatedAt = Number(clock());
              stores[STORES.COLLECTIONS].put(candidate);
            }
            removed += 1;
          });
          stores[STORES.ARTIFACTS].delete(recordingId);
          delete sharedArtifactCache[recordingId];
        });
        if (collection) {
          collection.sourceRecordingIds = Array.isArray(collection.sourceRecordingIds) ? collection.sourceRecordingIds : [];
          collection.selectedRanges = Array.isArray(collection.selectedRanges) ? collection.selectedRanges : [];
          collection.selectionInitializedRecordingIds = Array.isArray(collection.selectionInitializedRecordingIds)
            ? collection.selectionInitializedRecordingIds : [];
          sharedArtifacts.forEach(function (record) {
            stores[STORES.ARTIFACTS].put(record);
            if (collection.sourceRecordingIds.indexOf(record.recordingId) !== -1) return;
            collection.sourceRecordingIds.push(record.recordingId);
            collection.selectionInitializedRecordingIds.push(record.recordingId);
            stores[STORES.REFS].put({
              refId: draftRefId(collection.draftCollectionId, record.recordingId),
              kind: 'draft_source', recordingId: record.recordingId,
              draftCollectionId: collection.draftCollectionId, conversationId: '',
              sourceSha256: record.sourceSha256, incognito: runtimeIncognito,
              createdAt: Number(record.createdAt) || Number(clock()),
              expiresAt: Number(clock()) + contract.LIMITS.DRAFT_GRACE_MS,
            });
            imported += 1;
            changed = true;
          });
          if (changed) {
            collection.selectedRanges.forEach(function (range, index) { range.selectionOrder = index; });
            collection.selectionId = idGenerator('selection');
            collection.revision = Math.max(0, Number(collection.revision) || 0) + 1;
            collection.updatedAt = Number(clock());
            stores[STORES.COLLECTIONS].put(collection);
          }
        }
        return { imported: imported, removed: removed, collection: clone(collection) };
      });
    }
    function syncSharedArtifacts(input) {
      var next = sharedSyncQueue.catch(function () {}).then(function () {
        return performSharedArtifactSync(input);
      });
      sharedSyncQueue = next.catch(function () {});
      return next;
    }
    var dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        var request = indexedDBApi.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (event) {
          var db = request.result;
          if (!db.objectStoreNames.contains(STORES.CONTROL)) db.createObjectStore(STORES.CONTROL, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
            var sessions = db.createObjectStore(STORES.SESSIONS, { keyPath: 'recordingId' });
            sessions.createIndex('state', 'state', { unique: false });
            sessions.createIndex('draftCollectionId', 'draftCollectionId', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.EVENTS)) {
            var events = db.createObjectStore(STORES.EVENTS, { keyPath: ['recordingId', 'appendSeq'] });
            events.createIndex('recordingId', 'recordingId', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.ARTIFACTS)) {
            var artifacts = db.createObjectStore(STORES.ARTIFACTS, { keyPath: 'recordingId' });
            artifacts.createIndex('sourceSha256', 'sourceSha256', { unique: false });
            artifacts.createIndex('createdAt', 'createdAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.COLLECTIONS)) {
            var collections = db.createObjectStore(STORES.COLLECTIONS, { keyPath: 'draftCollectionId' });
            collections.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.REFS)) {
            var refs = db.createObjectStore(STORES.REFS, { keyPath: 'refId' });
            refs.createIndex('recordingId', 'recordingId', { unique: false });
            refs.createIndex('conversationId', 'conversationId', { unique: false });
            refs.createIndex('kind', 'kind', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.OPERATIONS)) {
            var operations = db.createObjectStore(STORES.OPERATIONS, { keyPath: 'operationId' });
            operations.createIndex('commandId', 'commandId', { unique: false });
            operations.createIndex('state', 'state', { unique: false });
            operations.createIndex('conversationId', 'conversationId', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.GRANTS)) {
            var grants = db.createObjectStore(STORES.GRANTS, { keyPath: ['generationId', 'recordingId'] });
            grants.createIndex('generationId', 'generationId', { unique: false });
            grants.createIndex('conversationId', 'conversationId', { unique: false });
          }
          if (event.oldVersion < 3) {
            var collectionStore = request.transaction.objectStore(STORES.COLLECTIONS);
            if (collectionStore.indexNames.contains('ownerKey')) collectionStore.deleteIndex('ownerKey');
            collectionStore.openCursor().onsuccess = function (cursorEvent) {
              var cursor = cursorEvent.target.result;
              if (!cursor) return;
              var value = cursor.value;
              delete value.assistantId;
              delete value.intendedConversationId;
              delete value.draftScopeId;
              value.seedTabId = Number(value.seedTabId || value.ownerSeedTabId) || 0;
              delete value.surfaceInstanceId;
              delete value.selectionClaimTokenHash;
              delete value.ownerSeedTabId;
              delete value.ownerSurfaceInstanceId;
              delete value.ownerKey;
              value.profileId = text(value.profileId || 'default');
              cursor.update(value);
              cursor.continue();
            };
            request.transaction.objectStore(STORES.SESSIONS).openCursor().onsuccess = function (cursorEvent) {
              var cursor = cursorEvent.target.result;
              if (!cursor) return;
              var value = cursor.value;
              value.seedTabId = Number(value.seedTabId || value.ownerSeedTabId) || 0;
              delete value.surfaceInstanceId;
              delete value.ownerSeedTabId;
              delete value.ownerSurfaceInstanceId;
              delete value.assistantId;
              delete value.intendedConversationId;
              delete value.draftScopeId;
              value.profileId = text(value.profileId || 'default');
              cursor.update(value);
              cursor.continue();
            };
            request.transaction.objectStore(STORES.OPERATIONS).openCursor().onsuccess = function (cursorEvent) {
              var cursor = cursorEvent.target.result;
              if (!cursor) return;
              var value = cursor.value;
              delete value.ownerSurfaceInstanceId;
              delete value.draftScopeId;
              delete value.surfaceInstanceId;
              delete value.selectionClaimTokenHash;
              cursor.update(value);
              cursor.continue();
            };
          }
          if (event.oldVersion >= 3 && event.oldVersion < 4) {
            request.transaction.objectStore(STORES.COLLECTIONS).openCursor().onsuccess = function (cursorEvent) {
              var cursor = cursorEvent.target.result;
              if (!cursor) return;
              var value = cursor.value;
              delete value.surfaceInstanceId;
              delete value.selectionClaimTokenHash;
              cursor.update(value);
              cursor.continue();
            };
            request.transaction.objectStore(STORES.SESSIONS).openCursor().onsuccess = function (cursorEvent) {
              var cursor = cursorEvent.target.result;
              if (!cursor) return;
              var value = cursor.value;
              delete value.surfaceInstanceId;
              cursor.update(value);
              cursor.continue();
            };
            request.transaction.objectStore(STORES.OPERATIONS).openCursor().onsuccess = function (cursorEvent) {
              var cursor = cursorEvent.target.result;
              if (!cursor) return;
              var value = cursor.value;
              delete value.surfaceInstanceId;
              delete value.selectionClaimTokenHash;
              cursor.update(value);
              cursor.continue();
            };
          }
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { dbPromise = null; reject(request.error || new Error('Recording DB open failed')); };
        request.onblocked = function () { dbPromise = null; reject(new Error('Recording DB migration is blocked')); };
      });
      return dbPromise;
    }
    async function transact(storeNames, mode, operation) {
      var db = await open();
      var tx = db.transaction(storeNames, mode);
      var done = transactionDone(tx);
      var stores = {};
      storeNames.forEach(function (name) { stores[name] = tx.objectStore(name); });
      var result;
      try { result = await operation(stores, tx); }
      catch (error) { try { tx.abort(); } catch (_) {} await done.catch(function () {}); throw error; }
      await done;
      return result;
    }
    async function digest(value) {
      value = String(value === undefined || value === null ? '' : value);
      if (nodeCrypto && nodeCrypto.createHash) return 'sha256:' + nodeCrypto.createHash('sha256').update(value).digest('hex');
      var bytes = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return 'sha256:' + Array.prototype.map.call(new Uint8Array(bytes), function (part) { return part.toString(16).padStart(2, '0'); }).join('');
    }
    function assertRevision(value, expected, label) {
      if (Number(value) !== Number(expected)) throw contract.error('RECORDING_REVISION_CONFLICT', (label || 'revision') + ' is stale', { currentRevision: Number(value), expectedRevision: Number(expected) });
    }
    function assertCollectionAccess(collection, input) {
      if (!collection) throw contract.error('RESOURCE_NOT_FOUND', 'Draft Recording collection does not exist');
      if (!belongsToRuntime(collection)) throw contract.error('FORBIDDEN', 'Draft Recording collection is unavailable in this browsing context');
      if (collection.profileId !== text(input.profileId || 'default')) throw contract.error('FORBIDDEN', 'Draft Recording collection is unavailable to this profile');
      return collection;
    }
    function belongsToRuntime(value) {
      return !!value && (value.incognito === true) === runtimeIncognito;
    }
    function draftRefId(collectionId, recordingId) {
      return 'draft:' + (runtimeIncognito ? 'incognito:' : '')
        + text(collectionId) + ':' + text(recordingId);
    }
    function grantGenerationKey(generationId) {
      return (runtimeIncognito ? 'incognito:' : '') + text(generationId);
    }
    function publicGrant(grant) {
      var output = clone(grant);
      if (output) {
        output.generationId = text(output.runtimeGenerationId || output.generationId);
        delete output.runtimeGenerationId;
      }
      return output;
    }
    async function getControl() {
      return transact([STORES.CONTROL], 'readonly', async function (stores) {
        return clone(await requestPromise(stores[STORES.CONTROL].get(controlKey)) || { key: controlKey, revision: 0, activeRecordingId: '' });
      });
    }
    async function startRecording(input) {
      input = clone(input || {});
      return transact([STORES.CONTROL, STORES.SESSIONS, STORES.COLLECTIONS], 'readwrite', async function (stores) {
        var control = await requestPromise(stores[STORES.CONTROL].get(controlKey)) || { key: controlKey, revision: 0, activeRecordingId: '', pendingOperation: null };
        if (control.activeRecordingId) throw contract.error('RECORDING_CONFLICT', 'Another recording is active', { recordingId: control.activeRecordingId });
        var collection = input.draftCollectionId ? await requestPromise(stores[STORES.COLLECTIONS].get(input.draftCollectionId)) : null;
        if (collection) {
          assertCollectionAccess(collection, input);
        } else {
          collection = {
            draftCollectionId: input.draftCollectionId || idGenerator('collection'),
            seedTabId: Number(input.seedTabId) || 0,
            profileId: text(input.profileId || 'default'), incognito: runtimeIncognito,
            selectionId: input.selectionId || idGenerator('selection'),
            revision: 1, sourceRecordingIds: [], selectedRanges: [], selectionInitializedRecordingIds: [],
            createdAt: Number(input.startedAt) || Number(clock()), updatedAt: Number(input.startedAt) || Number(clock()),
          };
          stores[STORES.COLLECTIONS].add(collection);
        }
        if (collection.sourceRecordingIds.length >= contract.LIMITS.MAX_COLLECTION_SOURCES) throw contract.error('RECORDING_COLLECTION_FULL', 'Recording collection already contains 32 sources');
        var recordingId = text(input.recordingId || idGenerator('rec'));
        contract.canonicalRecordingUri(recordingId);
        var session = {
          schemaVersion: 1, recordingId: recordingId, state: contract.STATES.RECORDING,
          browserSessionId: text(input.browserSessionId), revision: 1, appendSeq: 0, acceptedEventCount: 0,
          startedAt: Number(input.startedAt) || Number(clock()), startUrl: String(input.startUrl || ''), startTitle: String(input.startTitle || ''),
          seedTabKey: text(input.seedTabKey || 'tab:' + Number(input.seedTabId)), seedTabId: Number(input.seedTabId) || 0,
          draftCollectionId: collection.draftCollectionId, incognito: runtimeIncognito,
          profileId: collection.profileId,
          consentVersion: text(input.consentVersion), confirmedAt: Number(input.confirmedAt) || Number(clock()),
          scopeFrozen: false, trackedTabs: clone(input.trackedTabs || {}), excludedTabIds: clone(input.excludedTabIds || []),
          knownWindowIds: clone(input.knownWindowIds || []),
          documents: {}, seenBatches: {}, seenLocalEvents: {}, pendingHellos: {}, navigationOccurrences: {}, diagnostics: [], autoStopRevision: 1, drainRevision: 0,
          stopOperationId: '', stopNonce: '', cutoffAt: 0, drainDeadlineAt: 0, truncated: false, failure: null,
        };
        stores[STORES.SESSIONS].add(session);
        control.activeRecordingId = recordingId;
        control.browserSessionId = session.browserSessionId;
        control.revision = Math.max(0, Number(control.revision) || 0) + 1;
        control.pendingOperation = null;
        stores[STORES.CONTROL].put(control);
        return clone({ control: control, session: session, collection: collection });
      });
    }
    async function getSession(recordingId) {
      return transact([STORES.SESSIONS], 'readonly', async function (stores) {
        var session = await requestPromise(stores[STORES.SESSIONS].get(text(recordingId)));
        return clone(belongsToRuntime(session) ? session : null);
      });
    }
    async function getActiveSession() {
      var control = await getControl();
      return control.activeRecordingId ? getSession(control.activeRecordingId) : null;
    }
    async function mutateSession(recordingId, expectedStates, mutator, extraStores) {
      var names = [STORES.SESSIONS, STORES.CONTROL].concat(extraStores || []);
      return transact(Array.from(new Set(names)), 'readwrite', async function (stores) {
        var session = await requestPromise(stores[STORES.SESSIONS].get(text(recordingId)));
        if (!belongsToRuntime(session)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording session does not exist');
        if (expectedStates && expectedStates.indexOf(session.state) === -1) throw contract.error('RECORDING_STATE_CONFLICT', 'Recording state is ' + session.state);
        var next = await mutator(clone(session), stores);
        if (next) {
          next.revision = Math.max(0, Number(session.revision) || 0) + 1;
          stores[STORES.SESSIONS].put(next);
        }
        return clone(next || session);
      });
    }
    async function registerTrackedTab(recordingId, tab) {
      return mutateSession(recordingId, [contract.STATES.RECORDING], function (session) {
        if (session.scopeFrozen) throw contract.error('RECORDING_STATE_CONFLICT', 'Recording scope is frozen');
        var key = text(tab.tabKey || 'tab:' + Number(tab.tabId));
        if (!session.trackedTabs[key]) session.trackedTabs[key] = clone(tab);
        else session.trackedTabs[key] = Object.assign({}, session.trackedTabs[key], clone(tab));
        var windowId = Number(tab.windowId) || 0;
        if (!Array.isArray(session.knownWindowIds)) session.knownWindowIds = [];
        if (windowId && session.knownWindowIds.indexOf(windowId) === -1) session.knownWindowIds.push(windowId);
        return session;
      });
    }
    async function registerDocument(recordingId, document) {
      return mutateSession(recordingId, [contract.STATES.RECORDING], function (session) {
        var key = text(document.documentKey);
        Object.keys(session.documents).forEach(function (candidateKey) {
          var candidate = session.documents[candidateKey];
          if (candidateKey === key || candidate.tabId !== Number(document.tabId)
              || candidate.frameId !== Number(document.frameId)) return;
          candidate.expectedAtStop = false;
          candidate.supersededAt = Number(clock());
        });
        session.documents[key] = Object.assign({}, session.documents[key] || {}, clone(document), {
          ackedStopNonce: '', expectedAtStop: true, supersededAt: 0, retiredAt: 0,
        });
        return session;
      });
    }
    async function retireTabDocuments(recordingId, tabId, retiredAt) {
      return mutateSession(recordingId, [contract.STATES.RECORDING], function (session) {
        Object.keys(session.trackedTabs || {}).forEach(function (key) {
          if (Number(session.trackedTabs[key].tabId) === Number(tabId)) session.trackedTabs[key].closedAt = Number(retiredAt) || Number(clock());
        });
        Object.keys(session.documents).forEach(function (key) {
          var document = session.documents[key];
          if (document.tabId !== Number(tabId)) return;
          document.expectedAtStop = false;
          document.retiredAt = Number(retiredAt) || Number(clock());
        });
        return session;
      });
    }
    async function appendEventBatch(input) {
      input = clone(input || {});
      var normalized = (input.events || []).map(contract.normalizeRawEvent);
      return transact([STORES.SESSIONS, STORES.EVENTS], 'readwrite', async function (stores) {
        var session = await requestPromise(stores[STORES.SESSIONS].get(text(input.recordingId)));
        if (!belongsToRuntime(session)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording session does not exist');
        var finalBatch = input.finalBatch === true;
        var authorizedDocumentKey = text(input.documentKey);
        if (input.trustedBackground !== true) {
          var document = session.documents[authorizedDocumentKey];
          if (!document || document.capabilityHash !== text(input.capabilityHash)) {
            authorizedDocumentKey = Object.keys(session.documents).find(function (key) {
              var candidate = session.documents[key];
              return candidate.capabilityHash === text(input.capabilityHash)
                && candidate.tabId === Number(input.source && input.source.tabId)
                && candidate.frameId === Number(input.source && input.source.frameId);
            }) || '';
            document = session.documents[authorizedDocumentKey];
          }
          if (!document || document.capabilityHash !== text(input.capabilityHash)) throw contract.error('FORBIDDEN', 'Document capability is invalid');
        }
        var batchKey = authorizedDocumentKey + '\n' + text(input.documentLocalBatchId) + '\n' + (finalBatch ? text(input.stopNonce) : 'regular');
        if (session.seenBatches && session.seenBatches[batchKey]) {
          return { accepted: 0, appendedEvents: [], firstAppendSeq: null, lastAppendSeq: session.appendSeq, count: session.acceptedEventCount, truncated: session.truncated, warning: session.acceptedEventCount >= contract.LIMITS.MAX_CANDIDATE_EVENTS * contract.LIMITS.WARNING_RATIO, duplicate: true };
        }
        if (session.state !== contract.STATES.RECORDING && !(session.state === contract.STATES.DRAINING && finalBatch && text(input.stopNonce) === session.stopNonce)) {
          throw contract.error('RECORDING_STATE_CONFLICT', 'Recording does not accept this batch');
        }
        appendDiagnostics(session, input.diagnostics || []);
        var room = Math.max(0, contract.LIMITS.MAX_CANDIDATE_EVENTS - session.acceptedEventCount);
        var firstAppendSeq = session.appendSeq + 1;
        var appended = 0;
        var appendedEvents = [];
        var overflowed = false;
        if (!session.seenLocalEvents) session.seenLocalEvents = {};
        for (var index = 0; index < normalized.length; index += 1) {
          var event = normalized[index];
          if (finalBatch && event.occurredAt > session.cutoffAt) continue;
          var eventKey = authorizedDocumentKey + '\n' + event.localEventId;
          if (session.seenLocalEvents[eventKey]) continue;
          if (appended >= room) { overflowed = true; continue; }
          session.appendSeq += 1;
          session.acceptedEventCount += 1;
          session.seenLocalEvents[eventKey] = session.appendSeq;
          var storedEvent = {
            recordingId: session.recordingId, appendSeq: session.appendSeq, occurredAt: event.occurredAt,
            localEventId: event.localEventId, kind: event.kind, payload: clone(event.payload),
            source: clone(input.source || {}), documentLocalBatchId: text(input.documentLocalBatchId), batchIndex: index,
          };
          stores[STORES.EVENTS].add(storedEvent);
          appendedEvents.push(storedEvent);
          appended += 1;
        }
        if (overflowed || session.acceptedEventCount >= contract.LIMITS.MAX_CANDIDATE_EVENTS) session.truncated = true;
        if (!session.seenBatches) session.seenBatches = {};
        session.seenBatches[batchKey] = { accepted: appended, at: Number(clock()) };
        session.revision += 1;
        stores[STORES.SESSIONS].put(session);
        return { accepted: appended, appendedEvents: clone(appendedEvents), firstAppendSeq: appended ? firstAppendSeq : null, lastAppendSeq: session.appendSeq, count: session.acceptedEventCount, truncated: session.truncated, warning: session.acceptedEventCount >= contract.LIMITS.MAX_CANDIDATE_EVENTS * contract.LIMITS.WARNING_RATIO };
      });
    }
    async function recordDiagnostic(recordingId, diagnostic) {
      return mutateSession(recordingId, [contract.STATES.RECORDING, contract.STATES.DRAINING, contract.STATES.COMPILING], function (session) {
        appendDiagnostics(session, [diagnostic]);
        return session;
      });
    }
    async function listEvents(recordingId) {
      if (!await getSession(recordingId)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording session does not exist');
      return transact([STORES.EVENTS], 'readonly', async function (stores) {
        var index = stores[STORES.EVENTS].index('recordingId');
        var values = await cursorValues(index, keyRangeOnly(IDBKeyRangeApi, text(recordingId)));
        values.sort(function (left, right) { return left.appendSeq - right.appendSeq; });
        return clone(values);
      });
    }
    async function beginDrain(input) {
      input = clone(input || {});
      return mutateSession(input.recordingId, [contract.STATES.RECORDING, contract.STATES.DRAINING], async function (session, stores) {
        if (session.state === contract.STATES.DRAINING) return session;
        session.state = contract.STATES.DRAINING;
        session.scopeFrozen = true;
        session.stopOperationId = text(input.stopOperationId);
        session.stopNonce = text(input.stopNonce);
        session.cutoffAt = Number(input.cutoffAt) || Number(clock());
        session.drainDeadlineAt = Number(input.drainDeadlineAt) || session.cutoffAt + contract.LIMITS.DRAIN_TIMEOUT_MS;
        session.stopReason = text(input.reason);
        if (session.stopReason === 'event_limit' || session.stopReason === 'duration_limit') {
          session.truncated = true;
          session.terminalStateHint = contract.STATES.TRUNCATED;
        }
        session.drainRevision = Math.max(0, Number(session.revision) || 0) + 1;
        Object.keys(session.documents).forEach(function (key) {
          if (session.documents[key].expectedAtStop === false) return;
          session.documents[key].expectedStopNonce = session.stopNonce;
        });
        var value = await requestPromise(stores[STORES.CONTROL].get(controlKey));
        value = value || { key: controlKey, revision: 0 };
        value.pendingOperation = { kind: 'drain', recordingId: session.recordingId, stopNonce: session.stopNonce };
        value.lastStopRecordingId = session.recordingId;
        value.revision += 1;
        stores[STORES.CONTROL].put(value);
        return session;
      });
    }
    async function acknowledgeDocument(input) {
      input = clone(input || {});
      return mutateSession(input.recordingId, [
        contract.STATES.DRAINING, contract.STATES.READY, contract.STATES.INTERRUPTED,
        contract.STATES.TRUNCATED, contract.STATES.FAILED,
      ], function (session) {
        if (session.stopNonce !== text(input.stopNonce)) throw contract.error('RECORDING_STATE_CONFLICT', 'Stop nonce is stale');
        var document = session.documents[text(input.documentKey)];
        if (!document || document.capabilityHash !== text(input.capabilityHash)) {
          var fallbackKey = Object.keys(session.documents).find(function (key) {
            var candidate = session.documents[key];
            return candidate.capabilityHash === text(input.capabilityHash)
              && candidate.tabId === Number(input.tabId) && candidate.frameId === Number(input.frameId);
          });
          document = fallbackKey ? session.documents[fallbackKey] : null;
        }
        if (!document || document.capabilityHash !== text(input.capabilityHash)) throw contract.error('FORBIDDEN', 'Document capability is invalid');
        if (session.state !== contract.STATES.DRAINING) {
          if (document.ackedStopNonce === session.stopNonce) return null;
          throw contract.error('RECORDING_STATE_CONFLICT', 'Recording no longer accepts a new flush ACK');
        }
        document.ackedStopNonce = session.stopNonce;
        document.ackedAt = Number(input.ackedAt) || Number(clock());
        return session;
      });
    }
    async function enterCompiling(recordingId, diagnostics) {
      return mutateSession(recordingId, [contract.STATES.DRAINING, contract.STATES.COMPILING], async function (session, stores) {
        if (session.state === contract.STATES.COMPILING) return session;
        session.state = contract.STATES.COMPILING;
        appendDiagnostics(session, diagnostics || []);
        var control = await requestPromise(stores[STORES.CONTROL].get(controlKey));
        control.pendingOperation = { kind: 'compile', recordingId: session.recordingId };
        control.revision += 1;
        stores[STORES.CONTROL].put(control);
        return session;
      });
    }
    async function commitArtifact(input) {
      input = clone(input || {});
      var committed = await transact([STORES.CONTROL, STORES.SESSIONS, STORES.ARTIFACTS, STORES.COLLECTIONS, STORES.REFS], 'readwrite', async function (stores) {
        var session = await requestPromise(stores[STORES.SESSIONS].get(text(input.recordingId)));
        if (!belongsToRuntime(session)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording session does not exist');
        if (session.state !== contract.STATES.COMPILING && !contract.TERMINAL_STATES[session.state]) throw contract.error('RECORDING_STATE_CONFLICT', 'Recording is not compiling');
        var existing = await requestPromise(stores[STORES.ARTIFACTS].get(session.recordingId));
        if (existing && existing.state !== 'preparing' && existing.sourceSha256 !== input.sourceSha256) throw contract.error('RECORDING_HASH_CONFLICT', 'Immutable Recording Artifact hash changed');
        var state = input.state || (session.truncated ? contract.STATES.TRUNCATED : contract.STATES.READY);
        var record = {
          recordingId: session.recordingId, recordingUri: contract.canonicalRecordingUri(session.recordingId), sourceSha256: contract.normalizeSha256(input.sourceSha256),
          artifact: clone(input.artifact), state: state, profileId: session.profileId, incognito: session.incognito,
          createdAt: existing && Number(existing.createdAt) || Number(input.createdAt) || Number(clock()),
          lastAccessedAt: existing && Number(existing.lastAccessedAt) || 0,
        };
        stores[STORES.ARTIFACTS].put(record);
        session.state = state;
        session.terminalState = state;
        session.completedAt = Number(input.createdAt) || Number(clock());
        session.artifactSha256 = record.sourceSha256;
        session.revision += 1;
        stores[STORES.SESSIONS].put(session);
        var collection = await requestPromise(stores[STORES.COLLECTIONS].get(session.draftCollectionId));
        if (collection && !belongsToRuntime(collection)) throw contract.error('RESOURCE_NOT_FOUND', 'Draft Recording collection does not exist');
        if (collection && collection.sourceRecordingIds.indexOf(session.recordingId) === -1) {
          if (collection.sourceRecordingIds.length >= contract.LIMITS.MAX_COLLECTION_SOURCES) throw contract.error('RECORDING_COLLECTION_FULL', 'Recording collection already contains 32 sources');
          collection.sourceRecordingIds.push(session.recordingId);
          collection.selectedRanges = Array.isArray(collection.selectedRanges) ? collection.selectedRanges : [];
          collection.selectionInitializedRecordingIds = Array.isArray(collection.selectionInitializedRecordingIds)
            ? collection.selectionInitializedRecordingIds : [];
          var eventCount = Math.max(0, Number(record.artifact && record.artifact.stats && record.artifact.stats.eventCount) || 0);
          if (eventCount > 0 && collection.selectedRanges.length < contract.LIMITS.MAX_COMMAND_RANGES) {
            collection.selectedRanges.push({
              kind: 'page-action-recording-range', descriptorId: idGenerator('range'),
              recordingId: session.recordingId, recordingUri: record.recordingUri,
              sourceSha256: record.sourceSha256, fromSeq: 1, toSeq: eventCount,
              eventCount: eventCount, selectionOrder: collection.selectedRanges.length,
              createdAt: Number(clock()),
            });
            collection.selectionId = idGenerator('selection');
          }
          collection.selectionInitializedRecordingIds.push(session.recordingId);
          collection.revision += 1;
          collection.updatedAt = Number(clock());
          stores[STORES.COLLECTIONS].put(collection);
          stores[STORES.REFS].put({
            refId: draftRefId(collection.draftCollectionId, session.recordingId),
            kind: 'draft_source', recordingId: session.recordingId, draftCollectionId: collection.draftCollectionId,
            conversationId: '', sourceSha256: record.sourceSha256, incognito: runtimeIncognito,
            createdAt: Number(clock()), expiresAt: Number(clock()) + contract.LIMITS.DRAFT_GRACE_MS,
          });
        }
        var control = await requestPromise(stores[STORES.CONTROL].get(controlKey)) || { key: controlKey, revision: 0 };
        if (control.activeRecordingId === session.recordingId) control.activeRecordingId = '';
        control.pendingOperation = null;
        control.revision += 1;
        stores[STORES.CONTROL].put(control);
        return { session: clone(session), artifact: clone(record), collection: clone(collection || null) };
      });
      await persistSharedArtifact(committed.artifact, true);
      return committed;
    }
    async function finalizeFailed(input) {
      input = clone(input || {});
      return transact([STORES.CONTROL, STORES.SESSIONS], 'readwrite', async function (stores) {
        var session = await requestPromise(stores[STORES.SESSIONS].get(text(input.recordingId)));
        if (!belongsToRuntime(session)) return null;
        session.state = input.state || contract.STATES.FAILED;
        session.terminalState = session.state;
        session.failure = input.failure ? clone(input.failure) : null;
        session.completedAt = Number(clock());
        session.revision += 1;
        stores[STORES.SESSIONS].put(session);
        var control = await requestPromise(stores[STORES.CONTROL].get(controlKey)) || { key: controlKey, revision: 0 };
        if (control.activeRecordingId === session.recordingId) control.activeRecordingId = '';
        control.pendingOperation = null;
        control.revision += 1;
        stores[STORES.CONTROL].put(control);
        return clone(session);
      });
    }
    async function getArtifact(recordingId) {
      recordingId = text(recordingId);
      if (sharedStorage) {
        var metadata = await getSharedMetadata(recordingId);
        if (metadata && metadata.deleted === true) return null;
        if (metadata) {
          var shared = await loadSharedArtifacts([metadata]);
          if (shared.length) return shared[0];
        }
      }
      var local = await transact([STORES.ARTIFACTS], 'readonly', async function (stores) {
        return clone(await requestPromise(stores[STORES.ARTIFACTS].get(recordingId)) || null);
      });
      if (local) await persistSharedArtifact(local);
      return local;
    }
    async function getCollection(collectionId) {
      return transact([STORES.COLLECTIONS], 'readonly', async function (stores) {
        var collection = await requestPromise(stores[STORES.COLLECTIONS].get(text(collectionId)));
        return clone(belongsToRuntime(collection) ? collection : null);
      });
    }
    async function getLatestCollection(input) {
      input = clone(input || {});
      await syncSharedArtifacts(input);
      return transact([STORES.COLLECTIONS, STORES.SESSIONS, STORES.ARTIFACTS, STORES.REFS, STORES.OPERATIONS], 'readwrite', async function (stores) {
        var collections = (await cursorValues(stores[STORES.COLLECTIONS])).filter(function (collection) {
          return belongsToRuntime(collection)
            && text(collection.profileId || 'default') === text(input.profileId || 'default');
        });
        collections.sort(function (left, right) {
          return Number(right.updatedAt) - Number(left.updatedAt)
            || Number(right.createdAt) - Number(left.createdAt)
            || text(right.draftCollectionId).localeCompare(text(left.draftCollectionId));
        });
        if (collections.length < 2) return clone(collections[0] || null);
        var collectionIds = Object.create(null);
        collections.forEach(function (collection) { collectionIds[collection.draftCollectionId] = true; });
        var operations = await cursorValues(stores[STORES.OPERATIONS]);
        var hasInFlightOperation = operations.some(function (operation) {
          return belongsToRuntime(operation)
            && collectionIds[operation.draftCollectionId]
            && /^(?:prepared|journal_committed)$/.test(text(operation.state));
        });
        if (hasInFlightOperation) return clone(collections[0]);

        var primary = collections[0];
        var sourceIds = [];
        var sourceSeen = Object.create(null);
        var initializedIds = [];
        var initializedSeen = Object.create(null);
        var selectedRanges = [];
        var selectedSeen = Object.create(null);
        collections.slice().sort(function (left, right) {
          return Number(left.createdAt) - Number(right.createdAt)
            || text(left.draftCollectionId).localeCompare(text(right.draftCollectionId));
        }).forEach(function (collection) {
          (collection.sourceRecordingIds || []).forEach(function (recordingId) {
            if (sourceSeen[recordingId]) return;
            sourceSeen[recordingId] = true;
            sourceIds.push(recordingId);
          });
          (collection.selectionInitializedRecordingIds || []).forEach(function (recordingId) {
            if (initializedSeen[recordingId]) return;
            initializedSeen[recordingId] = true;
            initializedIds.push(recordingId);
          });
          (collection.selectedRanges || []).slice().sort(function (left, right) {
            return Number(left.selectionOrder) - Number(right.selectionOrder);
          }).forEach(function (range) {
            var key = [range.recordingId, range.sourceSha256, range.fromSeq, range.toSeq].join(':');
            if (selectedSeen[key]) return;
            selectedSeen[key] = true;
            if (selectedRanges.length < contract.LIMITS.MAX_COMMAND_RANGES) selectedRanges.push(clone(range));
          });
        });
        selectedRanges.forEach(function (range, index) { range.selectionOrder = index; });
        primary.sourceRecordingIds = sourceIds;
        primary.selectionInitializedRecordingIds = initializedIds;
        primary.selectedRanges = selectedRanges;
        primary.selectionId = idGenerator('selection');
        primary.revision = Math.max(0, Number(primary.revision) || 0) + 1;
        primary.updatedAt = Number(clock());
        delete primary.surfaceInstanceId;
        delete primary.selectionClaimTokenHash;
        stores[STORES.COLLECTIONS].put(primary);
        collections.slice(1).forEach(function (collection) {
          stores[STORES.COLLECTIONS].delete(collection.draftCollectionId);
        });
        var sessions = await cursorValues(stores[STORES.SESSIONS]);
        sessions.forEach(function (session) {
          if (!belongsToRuntime(session) || !collectionIds[session.draftCollectionId]
              || session.draftCollectionId === primary.draftCollectionId) return;
          session.draftCollectionId = primary.draftCollectionId;
          session.revision = Math.max(0, Number(session.revision) || 0) + 1;
          stores[STORES.SESSIONS].put(session);
        });

        var refs = await cursorValues(stores[STORES.REFS]);
        var draftRefsByRecording = Object.create(null);
        refs.forEach(function (ref) {
          if (!belongsToRuntime(ref) || ref.kind !== 'draft_source' || !collectionIds[ref.draftCollectionId]) return;
          var previous = draftRefsByRecording[ref.recordingId];
          if (!previous || Number(ref.expiresAt) > Number(previous.expiresAt)) draftRefsByRecording[ref.recordingId] = ref;
          stores[STORES.REFS].delete(ref.refId);
        });
        for (var sourceIndex = 0; sourceIndex < sourceIds.length; sourceIndex += 1) {
          var recordingId = sourceIds[sourceIndex];
          var artifact = await requestPromise(stores[STORES.ARTIFACTS].get(recordingId));
          var previousRef = draftRefsByRecording[recordingId];
          if (!artifact && !previousRef) continue;
          stores[STORES.REFS].put({
            refId: draftRefId(primary.draftCollectionId, recordingId),
            kind: 'draft_source', recordingId: recordingId, draftCollectionId: primary.draftCollectionId,
            conversationId: '', sourceSha256: text(artifact && artifact.sourceSha256 || previousRef && previousRef.sourceSha256),
            incognito: runtimeIncognito,
            createdAt: Number(previousRef && previousRef.createdAt) || Number(clock()),
            expiresAt: Math.max(Number(previousRef && previousRef.expiresAt) || 0, Number(clock()) + contract.LIMITS.DRAFT_GRACE_MS),
          });
        }
        return clone(primary);
      });
    }
    async function collectionLibrary(input) {
      input = clone(input || {});
      await syncSharedArtifacts(input);
      return transact([STORES.COLLECTIONS, STORES.ARTIFACTS], 'readwrite', async function (stores) {
        var collection = assertCollectionAccess(await requestPromise(stores[STORES.COLLECTIONS].get(text(input.draftCollectionId))), input);
        collection.selectedRanges = Array.isArray(collection.selectedRanges) ? collection.selectedRanges : [];
        collection.selectionInitializedRecordingIds = Array.isArray(collection.selectionInitializedRecordingIds)
          ? collection.selectionInitializedRecordingIds : [];
        var sources = [];
        var initializedChanged = false;
        for (var index = 0; index < collection.sourceRecordingIds.length; index += 1) {
          var artifact = await requestPromise(stores[STORES.ARTIFACTS].get(collection.sourceRecordingIds[index]));
          var recordingId = collection.sourceRecordingIds[index];
          if (collection.selectionInitializedRecordingIds.indexOf(recordingId) === -1) {
            var alreadySelected = collection.selectedRanges.some(function (range) { return range.recordingId === recordingId; });
            var eventCount = Math.max(0, Number(artifact && artifact.artifact && artifact.artifact.stats && artifact.artifact.stats.eventCount) || 0);
            if (!alreadySelected && artifact && eventCount > 0 && collection.selectedRanges.length < contract.LIMITS.MAX_COMMAND_RANGES) {
              collection.selectedRanges.push({
                kind: 'page-action-recording-range', descriptorId: idGenerator('range'),
                recordingId: recordingId, recordingUri: artifact.recordingUri,
                sourceSha256: artifact.sourceSha256, fromSeq: 1, toSeq: eventCount,
                eventCount: eventCount, selectionOrder: collection.selectedRanges.length,
                createdAt: Number(clock()),
              });
            }
            collection.selectionInitializedRecordingIds.push(recordingId);
            initializedChanged = true;
          }
          var artifactStats = artifact && artifact.artifact && artifact.artifact.stats || {};
          sources.push(artifact ? {
            recordingId: artifact.recordingId, recordingUri: artifact.recordingUri, sourceSha256: artifact.sourceSha256, state: artifact.state,
            startedAt: artifact.artifact.startedAt, durationMs: artifact.artifact.durationMs,
            stats: {
              eventCount: Math.max(0, Number(artifactStats.eventCount) || 0),
              tabCount: Math.max(0, Number(artifactStats.tabCount) || 0), domainCount: Math.max(0, Number(artifactStats.domainCount) || 0),
            },
            selectedRangeCount: collection.selectedRanges.filter(function (range) { return range.recordingId === artifact.recordingId; }).length,
          } : { recordingId: collection.sourceRecordingIds[index], state: 'missing', missing: true });
        }
        if (initializedChanged) {
          collection.selectedRanges.forEach(function (range, rangeIndex) { range.selectionOrder = rangeIndex; });
          collection.selectionId = idGenerator('selection');
          collection.revision += 1;
          collection.updatedAt = Number(clock());
          stores[STORES.COLLECTIONS].put(collection);
        }
        return { collection: clone(collection), sources: sources };
      });
    }
    async function updateSelection(input) {
      input = clone(input || {});
      return transact([STORES.COLLECTIONS, STORES.ARTIFACTS], 'readwrite', async function (stores) {
        var collection = assertCollectionAccess(await requestPromise(stores[STORES.COLLECTIONS].get(text(input.draftCollectionId))), input);
        assertRevision(collection.revision, input.expectedRevision, 'collection revision');
        var requested = Array.isArray(input.ranges) ? input.ranges : [];
        if (requested.length > contract.LIMITS.MAX_COMMAND_RANGES) throw contract.error('INVALID_REQUEST', 'A selection may contain at most 32 ranges');
        var bySource = Object.create(null);
        var descriptorInputs = [];
        for (var index = 0; index < requested.length; index += 1) {
          var raw = requested[index] || {};
          contract.assertExactKeys(raw, { recordingId: true, sourceSha256: true, fromSeq: true, toSeq: true, selectionOrder: true }, 'selection range');
          if (!Number.isInteger(raw.selectionOrder) || raw.selectionOrder !== index) throw contract.error('INVALID_REQUEST', 'selectionOrder must match the ordered range array');
          var recordingId = text(raw.recordingId);
          contract.canonicalRecordingUri(recordingId);
          if (collection.sourceRecordingIds.indexOf(recordingId) === -1) throw contract.error('FORBIDDEN', 'Recording is not in this draft collection');
          var artifactRecord = bySource[recordingId] || await requestPromise(stores[STORES.ARTIFACTS].get(recordingId));
          if (!artifactRecord || !/^(?:ready|interrupted|truncated)$/.test(artifactRecord.state)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording source is unavailable');
          bySource[recordingId] = artifactRecord;
          if (artifactRecord.sourceSha256 !== contract.normalizeSha256(raw.sourceSha256)) throw contract.error('RECORDING_HASH_MISMATCH', 'Recording source hash changed');
          descriptorInputs.push({ raw: raw, artifact: artifactRecord });
        }
        var grouped = Object.create(null);
        descriptorInputs.forEach(function (item) {
          var recordingId = item.artifact.recordingId;
          if (!grouped[recordingId]) grouped[recordingId] = { artifact: item.artifact, inputs: [], exact: Object.create(null) };
          var exactKey = Number(item.raw.fromSeq) + ':' + Number(item.raw.toSeq);
          if (grouped[recordingId].exact[exactKey]) return;
          grouped[recordingId].exact[exactKey] = true;
          grouped[recordingId].inputs.push({ fromSeq: item.raw.fromSeq, toSeq: item.raw.toSeq, originalOrder: Number(item.raw.selectionOrder) || 0 });
        });
        var normalized = [];
        Object.keys(grouped).forEach(function (recordingId) {
          var group = grouped[recordingId];
          var union = contract.normalizeRanges(group.inputs.map(function (item) { return { fromSeq: item.fromSeq, toSeq: item.toSeq }; }), group.artifact.artifact.stats.eventCount);
          union.forEach(function (range) {
            var order = Math.min.apply(Math, group.inputs.filter(function (item) { return item.fromSeq <= range.toSeq && item.toSeq >= range.fromSeq; }).map(function (item) { return item.originalOrder; }));
            normalized.push({
              kind: 'page-action-recording-range', descriptorId: idGenerator('range'), recordingId: recordingId,
              recordingUri: group.artifact.recordingUri, sourceSha256: group.artifact.sourceSha256,
              fromSeq: range.fromSeq, toSeq: range.toSeq, eventCount: range.toSeq - range.fromSeq + 1, selectionOrder: order,
              createdAt: Number(clock()),
            });
          });
        });
        normalized.sort(function (left, right) { return left.selectionOrder - right.selectionOrder || left.recordingId.localeCompare(right.recordingId) || left.fromSeq - right.fromSeq; });
        normalized.forEach(function (range, index) { range.selectionOrder = index; });
        collection.selectedRanges = normalized;
        collection.selectionInitializedRecordingIds = collection.sourceRecordingIds.slice();
        collection.selectionId = idGenerator('selection');
        collection.revision += 1;
        collection.updatedAt = Number(clock());
        stores[STORES.COLLECTIONS].put(collection);
        return clone(collection);
      });
    }
    async function removeSource(input) {
      input = clone(input || {});
      var artifactToDelete = await getArtifact(input.recordingId);
      var updatedCollection = await transact([
        STORES.CONTROL, STORES.COLLECTIONS, STORES.ARTIFACTS, STORES.EVENTS,
        STORES.SESSIONS, STORES.REFS, STORES.GRANTS, STORES.OPERATIONS,
      ], 'readwrite', async function (stores) {
        var collection = assertCollectionAccess(await requestPromise(stores[STORES.COLLECTIONS].get(text(input.draftCollectionId))), input);
        assertRevision(collection.revision, input.expectedRevision, 'collection revision');
        var recordingId = text(input.recordingId);
        contract.canonicalRecordingUri(recordingId);
        if (collection.sourceRecordingIds.indexOf(recordingId) === -1) throw contract.error('RESOURCE_NOT_FOUND', 'Recording is not in this draft collection');
        var controls = await cursorValues(stores[STORES.CONTROL]);
        if (controls.some(function (control) { return control.activeRecordingId === recordingId; })) {
          throw contract.error('RECORDING_CONFLICT', 'An active Recording cannot be deleted');
        }
        var control = controls.find(function (candidate) { return candidate.key === controlKey; })
          || { key: controlKey, revision: 0 };
        var operations = await cursorValues(stores[STORES.OPERATIONS]);
        var ownedOperations = operations.filter(belongsToRuntime);
        var inFlight = ownedOperations.some(function (operation) {
          return /^(?:prepared|journal_committed)$/.test(text(operation.state))
            && Array.isArray(operation.orderedRanges)
            && operation.orderedRanges.some(function (range) { return range.recordingId === recordingId; });
        });
        if (inFlight) throw contract.error('RECORDING_OPERATION_CONFLICT', 'Recording is being attached to a Conversation and cannot be deleted yet');

        var allCollections = await cursorValues(stores[STORES.COLLECTIONS]);
        var collections = allCollections.filter(belongsToRuntime);
        var current = null;
        collections.forEach(function (candidate) {
          if ((candidate.sourceRecordingIds || []).indexOf(recordingId) === -1
              && !(candidate.selectedRanges || []).some(function (range) { return range.recordingId === recordingId; })) return;
          candidate.sourceRecordingIds = (candidate.sourceRecordingIds || []).filter(function (id) { return id !== recordingId; });
          candidate.selectedRanges = (candidate.selectedRanges || []).filter(function (range) { return range.recordingId !== recordingId; });
          candidate.selectionInitializedRecordingIds = (candidate.selectionInitializedRecordingIds || []).filter(function (id) { return id !== recordingId; });
          candidate.selectedRanges.forEach(function (range, index) { range.selectionOrder = index; });
          candidate.selectionId = idGenerator('selection');
          candidate.revision = Math.max(0, Number(candidate.revision) || 0) + 1;
          candidate.updatedAt = Number(clock());
          stores[STORES.COLLECTIONS].put(candidate);
          if (candidate.draftCollectionId === collection.draftCollectionId) current = candidate;
        });

        var refs = await cursorValues(stores[STORES.REFS].index('recordingId'), keyRangeOnly(IDBKeyRangeApi, recordingId));
        refs.filter(belongsToRuntime).forEach(function (ref) { stores[STORES.REFS].delete(ref.refId); });
        var grants = await cursorValues(stores[STORES.GRANTS]);
        grants.filter(function (grant) {
          return belongsToRuntime(grant) && grant.recordingId === recordingId;
        }).forEach(function (grant) {
          stores[STORES.GRANTS].delete([grant.generationId, grant.recordingId]);
        });
        ownedOperations.forEach(function (operation) {
          if (!Array.isArray(operation.orderedRanges)) return;
          var retainedRanges = operation.orderedRanges.filter(function (range) {
            return range.recordingId !== recordingId;
          });
          if (retainedRanges.length === operation.orderedRanges.length) return;
          operation.orderedRanges = retainedRanges;
          operation.updatedAt = Number(clock());
          stores[STORES.OPERATIONS].put(operation);
        });
        var sessions = await cursorValues(stores[STORES.SESSIONS]);
        var ownedSession = sessions.find(function (session) {
          return session.recordingId === recordingId && belongsToRuntime(session);
        });
        if (ownedSession) {
          var events = await cursorValues(stores[STORES.EVENTS].index('recordingId'), keyRangeOnly(IDBKeyRangeApi, recordingId));
          events.forEach(function (event) { stores[STORES.EVENTS].delete([event.recordingId, event.appendSeq]); });
          stores[STORES.SESSIONS].delete(recordingId);
        }
        var retainedByOtherRuntime = refs.some(function (ref) {
          return !belongsToRuntime(ref);
        }) || grants.some(function (grant) {
          return !belongsToRuntime(grant) && grant.recordingId === recordingId;
        }) || allCollections.some(function (candidate) {
          return !belongsToRuntime(candidate)
            && ((candidate.sourceRecordingIds || []).indexOf(recordingId) !== -1
              || (candidate.selectedRanges || []).some(function (range) { return range.recordingId === recordingId; }));
        }) || sessions.some(function (session) {
          return !belongsToRuntime(session) && session.recordingId === recordingId;
        }) || operations.some(function (operation) {
          return !belongsToRuntime(operation)
            && operation.state !== 'released' && operation.state !== 'failed'
            && (operation.orderedRanges || []).some(function (range) { return range.recordingId === recordingId; });
        });
        if (!retainedByOtherRuntime) stores[STORES.ARTIFACTS].delete(recordingId);
        if (control.lastStopRecordingId === recordingId) {
          control.lastStopRecordingId = '';
          control.revision = Math.max(0, Number(control.revision) || 0) + 1;
          stores[STORES.CONTROL].put(control);
        }
        return clone(current || collection);
      });
      await deleteSharedArtifact(input.recordingId, artifactToDelete && artifactToDelete.sourceSha256);
      return updatedCollection;
    }
    async function prepareOperation(operation) {
      operation = clone(operation || {});
      return transact([STORES.OPERATIONS], 'readwrite', async function (stores) {
        var existing = operation.commandId ? (await cursorValues(
          stores[STORES.OPERATIONS].index('commandId'),
          keyRangeOnly(IDBKeyRangeApi, text(operation.commandId))
        )).find(belongsToRuntime) : null;
        if (existing) return clone(existing);
        operation.operationId = text(operation.operationId || idGenerator('recording_operation'));
        operation.state = text(operation.state || 'prepared');
        operation.incognito = runtimeIncognito;
        operation.createdAt = Number(operation.createdAt) || Number(clock());
        operation.updatedAt = Number(clock());
        stores[STORES.OPERATIONS].add(operation);
        return clone(operation);
      });
    }
    function sameSelectionRange(left, right) {
      return text(left.recordingId) === text(right.recordingId)
        && text(left.recordingUri) === text(right.recordingUri)
        && text(left.sourceSha256) === text(right.sourceSha256)
        && Number(left.fromSeq) === Number(right.fromSeq)
        && Number(left.toSeq) === Number(right.toSeq)
        && Number(left.selectionOrder) === Number(right.selectionOrder);
    }
    async function prepareSelectionOperation(input) {
      input = clone(input || {});
      return transact([STORES.OPERATIONS, STORES.COLLECTIONS, STORES.ARTIFACTS], 'readwrite', async function (stores) {
        var existing = (await cursorValues(
          stores[STORES.OPERATIONS].index('commandId'),
          keyRangeOnly(IDBKeyRangeApi, text(input.commandId))
        )).find(belongsToRuntime);
        if (existing) {
          var sameCommand = existing.kind === 'recording_selection_claim'
            && belongsToRuntime(existing)
            && existing.conversationId === text(input.conversationId)
            && existing.assistantId === text(input.assistantId)
            && existing.draftCollectionId === text(input.draftCollectionId)
            && existing.selectionId === text(input.selectionId)
            && Number(existing.expectedRevision) === Number(input.expectedRevision)
            && existing.profileId === text(input.profileId || 'default')
            && Array.isArray(existing.orderedRanges)
            && existing.orderedRanges.length === (input.orderedRanges || []).length
            && existing.orderedRanges.every(function (range, index) {
              return sameSelectionRange(range, input.orderedRanges[index]);
            });
          if (!sameCommand) throw contract.error('RECORDING_OPERATION_CONFLICT', 'commandId is already bound to another Recording selection');
          return clone(existing);
        }
        var collection = assertCollectionAccess(
          await requestPromise(stores[STORES.COLLECTIONS].get(text(input.draftCollectionId))),
          Object.assign({}, input, { profileId: text(input.collectionProfileId || input.profileId || 'default') })
        );
        assertRevision(collection.revision, input.expectedRevision, 'collection revision');
        if (collection.selectionId !== text(input.selectionId)) {
          throw contract.error('RECORDING_REVISION_CONFLICT', 'Recording selection identity is stale', {
            currentSelectionId: collection.selectionId,
          });
        }
        var ranges = Array.isArray(input.orderedRanges) ? input.orderedRanges : [];
        if (!ranges.length || ranges.length > contract.LIMITS.MAX_COMMAND_RANGES
            || collection.selectedRanges.length !== ranges.length) {
          throw contract.error('INVALID_REQUEST', 'The complete ordered Recording selection is required');
        }
        for (var index = 0; index < ranges.length; index += 1) {
          var expected = collection.selectedRanges[index];
          var range = ranges[index];
          if (!sameSelectionRange(expected, range)) {
            throw contract.error('RECORDING_REVISION_CONFLICT', 'Recording selection no longer matches the claimed range set');
          }
          var artifact = await requestPromise(stores[STORES.ARTIFACTS].get(text(range.recordingId)));
          if (!artifact || !/^(?:ready|interrupted|truncated)$/.test(artifact.state)
              || artifact.recordingUri !== range.recordingUri
              || artifact.sourceSha256 !== range.sourceSha256
              || Number(range.fromSeq) < 1
              || Number(range.toSeq) < Number(range.fromSeq)
              || Number(range.toSeq) > Number(artifact.artifact && artifact.artifact.stats && artifact.artifact.stats.eventCount)) {
            throw contract.error('RECORDING_HASH_MISMATCH', 'A selected Recording source or range is unavailable');
          }
        }
        var operation = {
          operationId: text(input.operationId || idGenerator('recording_operation')),
          kind: 'recording_selection_claim', state: 'prepared', commandId: text(input.commandId),
          conversationId: text(input.conversationId), assistantId: text(input.assistantId),
          actorId: text(input.actorId), profileId: text(input.profileId || 'default'), incognito: runtimeIncognito,
          draftCollectionId: collection.draftCollectionId,
          selectionId: collection.selectionId, expectedRevision: Number(collection.revision),
          orderedRanges: ranges.map(function (range) {
            return {
              recordingId: range.recordingId, recordingUri: range.recordingUri, sourceSha256: range.sourceSha256,
              fromSeq: Number(range.fromSeq), toSeq: Number(range.toSeq), selectionOrder: Number(range.selectionOrder),
            };
          }),
          createdAt: Number(clock()), updatedAt: Number(clock()),
        };
        stores[STORES.OPERATIONS].add(operation);
        return clone(operation);
      });
    }
    async function getOperationByCommand(commandId) {
      return transact([STORES.OPERATIONS], 'readonly', async function (stores) {
        var values = await cursorValues(stores[STORES.OPERATIONS].index('commandId'), keyRangeOnly(IDBKeyRangeApi, text(commandId)));
        return clone(values.find(belongsToRuntime) || null);
      });
    }
    async function updateOperation(operationId, patch) {
      return transact([STORES.OPERATIONS], 'readwrite', async function (stores) {
        var value = await requestPromise(stores[STORES.OPERATIONS].get(text(operationId)));
        if (!belongsToRuntime(value)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording operation does not exist');
        value = Object.assign({}, value, clone(patch || {}), { updatedAt: Number(clock()) });
        stores[STORES.OPERATIONS].put(value);
        return clone(value);
      });
    }
    async function listOperations(states) {
      states = Array.isArray(states) ? states.map(text) : [];
      return transact([STORES.OPERATIONS], 'readonly', async function (stores) {
        var values = await cursorValues(stores[STORES.OPERATIONS]);
        values = values.filter(belongsToRuntime);
        if (states.length) values = values.filter(function (operation) { return states.indexOf(operation.state) !== -1; });
        return clone(values);
      });
    }
    function conversationRefId(conversationId, recordingId) {
      return 'conversation:' + (runtimeIncognito ? 'incognito:' : '')
        + text(conversationId) + ':' + text(recordingId);
    }
    async function promoteSelection(input) {
      input = clone(input || {});
      return transact([STORES.OPERATIONS, STORES.COLLECTIONS, STORES.ARTIFACTS, STORES.REFS, STORES.GRANTS], 'readwrite', async function (stores) {
        var operation = await requestPromise(stores[STORES.OPERATIONS].get(text(input.operationId)));
        if (!belongsToRuntime(operation)) throw contract.error('RESOURCE_NOT_FOUND', 'Recording command operation does not exist');
        if (operation.state === 'committed') return clone(operation);
        if (operation.state !== 'journal_committed') throw contract.error('RECORDING_OPERATION_CONFLICT', 'Recording operation cannot be promoted before its Journal commit');
        var ranges = clone(operation.orderedRanges || []);
        var recordingIds = Array.from(new Set(ranges.map(function (range) { return range.recordingId; })));
        for (var index = 0; index < recordingIds.length; index += 1) {
          var recordingId = recordingIds[index];
          var artifact = await requestPromise(stores[STORES.ARTIFACTS].get(recordingId));
          var expected = ranges.find(function (range) { return range.recordingId === recordingId; });
          if (!artifact || artifact.sourceSha256 !== expected.sourceSha256) throw contract.error('RECORDING_HASH_MISMATCH', 'Recording source cannot be promoted');
          var refId = conversationRefId(operation.conversationId, recordingId);
          var previousRef = await requestPromise(stores[STORES.REFS].get(refId));
          if (!belongsToRuntime(previousRef)) previousRef = null;
          var retainedRanges = (previousRef && Array.isArray(previousRef.selectedRanges) ? previousRef.selectedRanges : []).concat(
            ranges.filter(function (range) { return range.recordingId === recordingId; }).map(function (range) {
              return { fromSeq: range.fromSeq, toSeq: range.toSeq };
            })
          );
          var retainedKeys = Object.create(null);
          retainedRanges = retainedRanges.filter(function (range) {
            var key = Number(range.fromSeq) + ':' + Number(range.toSeq);
            if (retainedKeys[key]) return false;
            retainedKeys[key] = true;
            return true;
          }).slice(-contract.LIMITS.MAX_COMMAND_RANGES);
          stores[STORES.REFS].put({
            refId: refId, kind: 'conversation_recording', recordingId: recordingId,
            recordingUri: artifact.recordingUri, sourceSha256: artifact.sourceSha256, conversationId: operation.conversationId,
            profileId: operation.profileId, incognito: operation.incognito === true,
            createdAt: previousRef && previousRef.createdAt || Number(clock()), updatedAt: Number(clock()), expiresAt: 0,
            selectedRanges: retainedRanges,
          });
          stores[STORES.GRANTS].put({
            generationId: grantGenerationKey(input.generationId), runtimeGenerationId: text(input.generationId),
            recordingId: recordingId, recordingUri: artifact.recordingUri,
            sourceSha256: artifact.sourceSha256, conversationId: operation.conversationId, actorId: operation.actorId,
            profileId: operation.profileId, incognito: operation.incognito === true, state: 'active', createdAt: Number(clock()),
          });
        }
        operation.state = 'committed';
        operation.generationId = text(input.generationId);
        operation.updatedAt = Number(clock());
        stores[STORES.OPERATIONS].put(operation);
        var collection = await requestPromise(stores[STORES.COLLECTIONS].get(operation.draftCollectionId));
        if (belongsToRuntime(collection) && collection.revision === operation.expectedRevision) {
          collection.selectedRanges = [];
          collection.selectionId = idGenerator('selection');
          collection.revision += 1;
          collection.updatedAt = Number(clock());
          stores[STORES.COLLECTIONS].put(collection);
        }
        return clone(operation);
      });
    }
    async function prepareGeneration(input) {
      input = clone(input || {});
      return transact([STORES.REFS, STORES.ARTIFACTS, STORES.GRANTS], 'readwrite', async function (stores) {
        var requested = Array.isArray(input.recordings) ? input.recordings : [];
        var result = [];
        for (var index = 0; index < requested.length; index += 1) {
          var handle = requested[index];
          var recordingId = text(handle.recordingId || contract.recordingIdFromUri(handle.recordingUri));
          var ref = await requestPromise(stores[STORES.REFS].get(conversationRefId(input.conversationId, recordingId)));
          var artifact = await requestPromise(stores[STORES.ARTIFACTS].get(recordingId));
          if (!ref || !artifact || ref.sourceSha256 !== handle.sourceSha256 || artifact.sourceSha256 !== handle.sourceSha256
              || artifact.recordingUri !== handle.recordingUri
              || ref.profileId !== input.profileId || ref.incognito !== runtimeIncognito) {
            throw contract.error('FORBIDDEN', 'Recording is not linked to this Conversation');
          }
          var selectedRanges = Array.isArray(handle.selectedRanges) ? handle.selectedRanges : [];
          if (!selectedRanges.length || selectedRanges.length > contract.LIMITS.MAX_COMMAND_RANGES
              || Number(handle.eventCount) !== Number(artifact.artifact && artifact.artifact.stats && artifact.artifact.stats.eventCount)) {
            throw contract.error('FORBIDDEN', 'Recording range handles are incomplete or stale');
          }
          var retainedRangeKeys = Object.create(null);
          (Array.isArray(ref.selectedRanges) ? ref.selectedRanges : []).forEach(function (range) {
            retainedRangeKeys[Number(range.fromSeq) + ':' + Number(range.toSeq)] = true;
          });
          selectedRanges.forEach(function (range) {
            var normalized = contract.normalizeRange({ fromSeq: range.fromSeq, toSeq: range.toSeq }, artifact.artifact.stats.eventCount);
            if (!retainedRangeKeys[normalized.fromSeq + ':' + normalized.toSeq]) {
              throw contract.error('FORBIDDEN', 'Recording range is not retained by this Conversation');
            }
          });
          var grant = {
            generationId: grantGenerationKey(input.generationId), runtimeGenerationId: text(input.generationId),
            recordingId: recordingId, recordingUri: artifact.recordingUri,
            sourceSha256: artifact.sourceSha256, conversationId: text(input.conversationId), actorId: text(input.actorId),
            profileId: text(input.profileId), incognito: runtimeIncognito, state: 'active', createdAt: Number(clock()),
          };
          stores[STORES.GRANTS].put(grant);
          result.push(publicGrant(grant));
        }
        return clone(result);
      });
    }
    async function authorizeGrant(input) {
      input = clone(input || {});
      return transact([STORES.GRANTS, STORES.ARTIFACTS], 'readonly', async function (stores) {
        var recordingId = text(input.recordingId || contract.recordingIdFromUri(input.recordingUri));
        var grant = await requestPromise(stores[STORES.GRANTS].get([grantGenerationKey(input.generationId), recordingId]));
        var artifact = await requestPromise(stores[STORES.ARTIFACTS].get(recordingId));
        if (!grant || grant.state !== 'active' || !artifact
            || grant.conversationId !== text(input.conversationId) || grant.actorId !== text(input.actorId)
            || grant.profileId !== text(input.profileId) || grant.incognito !== runtimeIncognito
            || grant.sourceSha256 !== artifact.sourceSha256) return null;
        return { grant: publicGrant(grant), artifact: clone(artifact) };
      });
    }
    async function endGeneration(generationId) {
      return transact([STORES.GRANTS], 'readwrite', async function (stores) {
        var index = stores[STORES.GRANTS].index('generationId');
        var values = await cursorValues(index, keyRangeOnly(IDBKeyRangeApi, grantGenerationKey(generationId)));
        var owned = values.filter(belongsToRuntime);
        owned.forEach(function (grant) { stores[STORES.GRANTS].delete([grant.generationId, grant.recordingId]); });
        return { released: owned.length };
      });
    }
    async function reconcileGrants(activeGenerationIds) {
      var active = Object.create(null);
      (Array.isArray(activeGenerationIds) ? activeGenerationIds : []).map(text).filter(Boolean).forEach(function (generationId) {
        active[generationId] = true;
      });
      return transact([STORES.GRANTS], 'readwrite', async function (stores) {
        var values = await cursorValues(stores[STORES.GRANTS]);
        var owned = values.filter(belongsToRuntime);
        var removed = 0;
        owned.forEach(function (grant) {
          if (active[text(grant.runtimeGenerationId || grant.generationId)]) return;
          stores[STORES.GRANTS].delete([grant.generationId, grant.recordingId]);
          removed += 1;
        });
        return { removed: removed, retained: owned.length - removed };
      });
    }
    async function releaseConversation(conversationId) {
      return transact([STORES.REFS, STORES.GRANTS, STORES.OPERATIONS], 'readwrite', async function (stores) {
        var refs = await cursorValues(stores[STORES.REFS].index('conversationId'), keyRangeOnly(IDBKeyRangeApi, text(conversationId)));
        refs = refs.filter(belongsToRuntime);
        refs.forEach(function (ref) { stores[STORES.REFS].delete(ref.refId); });
        var grants = await cursorValues(stores[STORES.GRANTS].index('conversationId'), keyRangeOnly(IDBKeyRangeApi, text(conversationId)));
        grants = grants.filter(belongsToRuntime);
        grants.forEach(function (grant) { stores[STORES.GRANTS].delete([grant.generationId, grant.recordingId]); });
        var operations = await cursorValues(stores[STORES.OPERATIONS].index('conversationId'), keyRangeOnly(IDBKeyRangeApi, text(conversationId)));
        operations = operations.filter(belongsToRuntime);
        operations.forEach(function (operation) {
          if (operation.kind === 'conversation_release') return;
          operation.state = operation.state === 'committed' ? 'released' : operation.state;
          operation.updatedAt = Number(clock());
          stores[STORES.OPERATIONS].put(operation);
        });
        return { releasedRefs: refs.length, releasedGrants: grants.length };
      });
    }
    async function gc(now) {
      now = Number(now) || Number(clock());
      return transact([STORES.ARTIFACTS, STORES.EVENTS, STORES.SESSIONS, STORES.REFS, STORES.OPERATIONS, STORES.COLLECTIONS], 'readwrite', async function (stores) {
        var operations = await cursorValues(stores[STORES.OPERATIONS]);
        var protectedRecordings = Object.create(null);
        operations.filter(function (operation) { return operation.state !== 'released' && operation.state !== 'failed'; }).forEach(function (operation) {
          (operation.orderedRanges || []).forEach(function (range) { protectedRecordings[range.recordingId] = true; });
        });
        var collections = await cursorValues(stores[STORES.COLLECTIONS]);
        collections.forEach(function (collection) {
          (collection.selectedRanges || []).forEach(function (range) { protectedRecordings[range.recordingId] = true; });
        });
        var refs = await cursorValues(stores[STORES.REFS]);
        refs.forEach(function (ref) {
          if (ref.kind === 'draft_source' && Number(ref.expiresAt) > 0 && Number(ref.expiresAt) <= now) {
            stores[STORES.REFS].delete(ref.refId);
            return;
          }
          protectedRecordings[ref.recordingId] = true;
        });
        var artifacts = await cursorValues(stores[STORES.ARTIFACTS]);
        var removed = [];
        for (var index = 0; index < artifacts.length; index += 1) {
          var artifact = artifacts[index];
          if (protectedRecordings[artifact.recordingId] || now - Number(artifact.createdAt) < contract.LIMITS.DRAFT_GRACE_MS) continue;
          stores[STORES.ARTIFACTS].delete(artifact.recordingId);
          stores[STORES.SESSIONS].delete(artifact.recordingId);
          var events = await cursorValues(stores[STORES.EVENTS].index('recordingId'), keyRangeOnly(IDBKeyRangeApi, artifact.recordingId));
          events.forEach(function (event) { stores[STORES.EVENTS].delete([event.recordingId, event.appendSeq]); });
          removed.push(artifact.recordingId);
        }
        return { removed: removed };
      });
    }
    async function reconcileBrowserSession(browserSessionId) {
      var active = await getActiveSession();
      if (!active || active.browserSessionId === text(browserSessionId)) return active;
      if (/^(?:recording|draining|compiling)$/.test(active.state)) {
        return mutateSession(active.recordingId, [contract.STATES.RECORDING, contract.STATES.DRAINING, contract.STATES.COMPILING], async function (session, stores) {
          session.state = contract.STATES.COMPILING;
          session.scopeFrozen = true;
          session.cutoffAt = session.cutoffAt || Number(clock());
          session.terminalStateHint = contract.STATES.INTERRUPTED;
          appendDiagnostics(session, [{ code: 'browser_session_changed', occurredAt: Number(clock()) }]);
          var control = await requestPromise(stores[STORES.CONTROL].get(controlKey)) || { key: controlKey, revision: 0 };
          control.pendingOperation = { kind: 'compile', recordingId: session.recordingId, terminalState: contract.STATES.INTERRUPTED };
          control.revision = Math.max(0, Number(control.revision) || 0) + 1;
          stores[STORES.CONTROL].put(control);
          return session;
        });
      }
      return active;
    }
    return Object.freeze({
      API_VERSION: API_VERSION, DB_NAME: DB_NAME, runtimeScope: runtimeScope,
      open: async function () {
        var db = await open();
        await syncSharedArtifacts({ profileId: 'default' });
        return db;
      },
      hashToken: digest, getControl: getControl,
      startRecording: startRecording, getSession: getSession, getActiveSession: getActiveSession,
      registerTrackedTab: registerTrackedTab, registerDocument: registerDocument, retireTabDocuments: retireTabDocuments,
      appendEventBatch: appendEventBatch, recordDiagnostic: recordDiagnostic,
      listEvents: listEvents, beginDrain: beginDrain, acknowledgeDocument: acknowledgeDocument,
      enterCompiling: enterCompiling, commitArtifact: commitArtifact, finalizeFailed: finalizeFailed,
      getArtifact: getArtifact, getCollection: getCollection, getLatestCollection: getLatestCollection,
      collectionLibrary: collectionLibrary, updateSelection: updateSelection, removeSource: removeSource,
      prepareOperation: prepareOperation,
      prepareSelectionOperation: prepareSelectionOperation,
      getOperationByCommand: getOperationByCommand, updateOperation: updateOperation, listOperations: listOperations,
      promoteSelection: promoteSelection, prepareGeneration: prepareGeneration, authorizeGrant: authorizeGrant,
      endGeneration: endGeneration, reconcileGrants: reconcileGrants,
      releaseConversation: releaseConversation, gc: gc,
      reconcileBrowserSession: reconcileBrowserSession, syncSharedArtifacts: syncSharedArtifacts,
    });
  }
  return Object.freeze({
    API_VERSION: API_VERSION, DB_NAME: DB_NAME, DB_VERSION: DB_VERSION, STORES: STORES,
    isSharedMetadataKey: function (key) {
      return String(key || '').indexOf(SHARED_META_KEY_PREFIX) === 0;
    },
    create: createStore,
  });
});
