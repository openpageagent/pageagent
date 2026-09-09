// Run-session registry, session-like queries, pruning, and snapshot persistence.
(function attachRunSessionRegistry(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && value.API_VERSION === 1 && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.RunSessionRegistry;
  var api = isApi(existing) ? existing : factory();
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.RunSessionRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('RunSessionRegistry missing dependency: ' + name);
    return value;
  }

  function positiveInteger(value, fallback, name) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallback;
    number = Math.floor(number);
    if (number < 1) throw new Error('RunSessionRegistry invalid option: ' + name);
    return number;
  }

  function safeId(value) {
    if (value === undefined || value === null) return '';
    var id = String(value);
    return id && !UNSAFE_KEYS[id] ? id : '';
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return value;
  }

  function create(options) {
    options = options || {};
    var readSnapshots = requireFunction(options.readSnapshots, 'readSnapshots');
    var writeSnapshots = requireFunction(options.writeSnapshots, 'writeSnapshots');
    var cloneData = requireFunction(options.cloneData, 'cloneData');
    var sanitizeRuntimeValue = requireFunction(options.sanitizeRuntimeValue, 'sanitizeRuntimeValue');
    var getReportInput = requireFunction(options.getReportInput, 'getReportInput');
    var compactActiveSession = requireFunction(options.compactActiveSession, 'compactActiveSession');
    var now = requireFunction(options.now, 'now');
    var onSnapshotsLoaded = typeof options.onSnapshotsLoaded === 'function' ? options.onSnapshotsLoaded : function () {};
    var onPersistenceError = typeof options.onPersistenceError === 'function' ? options.onPersistenceError : function () {};
    var onSessionsPruned = typeof options.onSessionsPruned === 'function' ? options.onSessionsPruned : function () {};
    var onSnapshotWarning = typeof options.onSnapshotWarning === 'function' ? options.onSnapshotWarning : function () {};
    var maxFinishedSessions = positiveInteger(options.maxFinishedSessions, 10, 'maxFinishedSessions');
    var maxCompletedSnapshots = positiveInteger(options.maxCompletedSnapshots, 50, 'maxCompletedSnapshots');
    var runningSnapshotIntervalMs = positiveInteger(options.runningSnapshotIntervalMs, 60000, 'runningSnapshotIntervalMs');

    var sessions = Object.create(null);
    var snapshots = Object.create(null);
    var snapshotTouches = Object.create(null);
    var snapshotVersions = Object.create(null);
    var snapshotsLoaded = false;
    var pendingClearFinishedGeneration = 0;
    var pruneCompletedAfterLoad = false;
    var snapshotRevision = 0;
    var snapshotDirty = false;
    var snapshotWriteScheduled = false;
    var snapshotWriteChain = Promise.resolve();

    function notifyPersistenceError(error, phase) {
      try { onPersistenceError(error, phase); } catch (_) {}
    }

    function importSnapshots(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
      var imported = 0;
      Object.keys(raw).forEach(function (rawId) {
        var id = safeId(rawId);
        if (!id || snapshotTouches[id]) return;
        var descriptor = Object.getOwnPropertyDescriptor(raw, rawId);
        if (!descriptor || descriptor.get || descriptor.set
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
        var snapshot = descriptor.value;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
        if (pendingClearFinishedGeneration && !isResumableSnapshot(snapshot)) {
          markSnapshotChanged(id);
          return;
        }
        defineOwn(snapshots, id, snapshot);
        imported++;
      });
      return imported;
    }

    var ready = Promise.resolve().then(readSnapshots).then(function (raw) {
      var imported = importSnapshots(raw);
      snapshotsLoaded = true;
      pendingClearFinishedGeneration = 0;
      if (pruneCompletedAfterLoad) {
        pruneCompletedAfterLoad = false;
        pruneCompletedSnapshots();
      }
      try { onSnapshotsLoaded(imported, snapshots); } catch (_) {}
      return snapshots;
    }, function (error) {
      snapshotsLoaded = true;
      notifyPersistenceError(error, 'load');
      return snapshots;
    });

    function cloneSnapshotMap() {
      var output = {};
      Object.keys(snapshots).forEach(function (id) {
        defineOwn(output, id, cloneData(snapshots[id]));
      });
      return output;
    }

    function drainSnapshotWrites() {
      if (!snapshotDirty) {
        snapshotWriteScheduled = false;
        return undefined;
      }
      snapshotDirty = false;
      var revision = snapshotRevision;
      var state;
      try {
        state = cloneSnapshotMap();
      } catch (error) {
        notifyPersistenceError(error, 'serialize');
        if (snapshotDirty || snapshotRevision !== revision) return drainSnapshotWrites();
        snapshotWriteScheduled = false;
        return undefined;
      }
      return Promise.resolve().then(function () {
        return writeSnapshots(state);
      }).catch(function (error) {
        notifyPersistenceError(error, 'write');
      }).then(function () {
        if (snapshotDirty || snapshotRevision !== revision) return drainSnapshotWrites();
        snapshotWriteScheduled = false;
        return undefined;
      });
    }

    function persistSnapshots() {
      snapshotDirty = true;
      if (snapshotWriteScheduled) return snapshotWriteChain;
      snapshotWriteScheduled = true;
      snapshotWriteChain = snapshotWriteChain.then(function () {
        return ready;
      }, function () {
        return ready;
      }).then(drainSnapshotWrites, function (error) {
        notifyPersistenceError(error, 'ready');
        return drainSnapshotWrites();
      });
      return snapshotWriteChain;
    }

    function markSnapshotChanged(id) {
      defineOwn(snapshotTouches, id, true);
      defineOwn(snapshotVersions, id, (Number(snapshotVersions[id]) || 0) + 1);
      snapshotRevision++;
      return snapshotVersions[id];
    }

    function snapshotVersion(runId) {
      var id = safeId(runId);
      return id ? (Number(snapshotVersions[id]) || 0) : 0;
    }

    function setSnapshot(runId, snapshot, setOptions) {
      setOptions = setOptions || {};
      var idValue = runId === undefined || runId === null ? ownDataValue(snapshot, 'runId') : runId;
      var id = safeId(idValue);
      if (!id) throw new Error('RunSessionRegistry snapshot requires a safe runId');
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error('RunSessionRegistry snapshot must be an object');
      }
      if (setOptions.expectedVersion !== undefined
          && snapshotVersion(id) !== Number(setOptions.expectedVersion)) return null;
      defineOwn(snapshots, id, snapshot);
      markSnapshotChanged(id);
      if (setOptions.persist !== false) persistSnapshots();
      return snapshot;
    }

    function deleteSnapshot(runId, deleteOptions) {
      deleteOptions = deleteOptions || {};
      var id = safeId(runId);
      if (!id) return false;
      var existed = Object.prototype.hasOwnProperty.call(snapshots, id);
      if (existed) delete snapshots[id];
      if (existed || !snapshotsLoaded) {
        markSnapshotChanged(id);
        if (deleteOptions.persist !== false) persistSnapshots();
      }
      return existed;
    }

    function getSnapshot(runId) {
      var id = safeId(runId);
      return id && Object.prototype.hasOwnProperty.call(snapshots, id) ? snapshots[id] : null;
    }

    function sessionId(session) {
      var id = safeId(ownDataValue(session, 'runId'));
      if (!id) throw new Error('RunSessionRegistry session requires a safe own runId');
      return id;
    }

    function register(session) {
      if (!session || (typeof session !== 'object' && typeof session !== 'function')) {
        throw new Error('RunSessionRegistry register requires a session-like object');
      }
      var id = sessionId(session);
      var existing = sessions[id];
      if (existing && existing !== session) throw new Error('RunSessionRegistry duplicate runId: ' + id);
      defineOwn(sessions, id, session);
      return session;
    }

    function unregister(runId, expected) {
      var id = safeId(runId);
      if (!id || !Object.prototype.hasOwnProperty.call(sessions, id)) return false;
      if (expected && sessions[id] !== expected) return false;
      delete sessions[id];
      return true;
    }

    function get(runId) {
      var id = safeId(runId);
      return id && Object.prototype.hasOwnProperty.call(sessions, id) ? sessions[id] : null;
    }

    function adaptSessionLike(session) {
      if (!session || (typeof session !== 'object' && typeof session !== 'function')) return null;
      var id;
      try { id = sessionId(session); } catch (_) { return null; }
      var status = String(ownDataValue(session, 'status') || '');
      var kind = String(ownDataValue(session, 'kind') || 'flow');
      return {
        id: id,
        raw: session,
        status: status,
        kind: kind,
        running: status === 'running',
        terminal: status !== 'running',
        resumable: status === 'stopped' && kind !== 'flowGroup' && ownDataValue(session, 'canContinue') !== false,
      };
    }

    function forEachSession(iterator) {
      requireFunction(iterator, 'iterator');
      Object.keys(sessions).forEach(function (id) { iterator(sessions[id], id); });
    }

    function forEachSnapshot(iterator) {
      requireFunction(iterator, 'iterator');
      Object.keys(snapshots).forEach(function (id) { iterator(snapshots[id], id); });
    }

    function runningIds() {
      return Object.keys(sessions).filter(function (id) {
        var adapted = adaptSessionLike(sessions[id]);
        return !!(adapted && adapted.running);
      });
    }

    function hasRunningFlow(flowId) {
      var ids = Object.keys(sessions);
      for (var i = 0; i < ids.length; i++) {
        var session = sessions[ids[i]];
        var adapted = adaptSessionLike(session);
        if (adapted && adapted.running && ownDataValue(session, 'flowId') === flowId) return true;
      }
      return false;
    }

    function findLatestTerminal(flowId) {
      var best = null;
      Object.keys(sessions).forEach(function (id) {
        var session = sessions[id];
        var adapted = adaptSessionLike(session);
        if (!adapted || !adapted.terminal || ownDataValue(session, 'flowId') !== flowId) return;
        if (!best || Number(ownDataValue(session, 'startedAt')) > Number(ownDataValue(best, 'startedAt'))) best = session;
      });
      return best;
    }

    function pruneTerminalSessions(limit) {
      limit = positiveInteger(limit, maxFinishedSessions, 'finishedSessionLimit');
      var terminal = [];
      Object.keys(sessions).forEach(function (id) {
        var session = sessions[id];
        var adapted = adaptSessionLike(session);
        if (!adapted || !adapted.terminal) return;
        terminal.push({
          id: id,
          session: session,
          at: Number(ownDataValue(session, 'endedAt') || ownDataValue(session, 'startedAt')) || 0,
        });
      });
      terminal.sort(function (a, b) { return b.at - a.at; });
      var removed = [];
      for (var i = limit; i < terminal.length; i++) {
        if (unregister(terminal[i].id, terminal[i].session)) removed.push(terminal[i].id);
      }
      if (removed.length) {
        try { onSessionsPruned(removed); } catch (_) {}
      }
      return removed;
    }

    function isResumableSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      if (ownDataValue(snapshot, '_isRunningSnapshot')) return true;
      var status = ownDataValue(snapshot, 'status');
      var legacyStopped = !status && ownDataValue(snapshot, 'stoppedAt') !== undefined
        && (ownDataValue(snapshot, 'runCtx') !== undefined || ownDataValue(snapshot, 'loopStack') !== undefined);
      return (status === 'stopped' || legacyStopped) && ownDataValue(snapshot, 'canContinue') !== false;
    }

    function clearFinished() {
      var removed = 0;
      var preservedResumable = 0;
      Object.keys(sessions).forEach(function (id) {
        var adapted = adaptSessionLike(sessions[id]);
        if (adapted && adapted.running) return;
        if (adapted && adapted.resumable) {
          preservedResumable++;
          return;
        }
        if (unregister(id, sessions[id])) removed++;
      });
      var snapshotsChanged = false;
      Object.keys(snapshots).forEach(function (id) {
        if (sessions[id]) return;
        if (isResumableSnapshot(snapshots[id])) {
          preservedResumable++;
          return;
        }
        delete snapshots[id];
        markSnapshotChanged(id);
        snapshotsChanged = true;
      });
      if (!snapshotsLoaded) {
        pendingClearFinishedGeneration++;
        snapshotsChanged = true;
      }
      if (snapshotsChanged) persistSnapshots();
      return { removed: removed, preservedResumable: preservedResumable };
    }

    function findStoppedNodeId(nodeStatuses) {
      var ids = Object.keys(nodeStatuses || {});
      for (var i = 0; i < ids.length; i++) {
        if (nodeStatuses[ids[i]] === 'stopped') return ids[i];
      }
      return '';
    }

    function safeClone(value, fallback) {
      try { return cloneData(value); } catch (_) { return fallback; }
    }

    function safeSanitize(value, session, field) {
      try {
        return sanitizeRuntimeValue(value);
      } catch (error) {
        try { onSnapshotWarning(session, field, error); } catch (_) {}
        return field === 'runCtx'
          ? { __error: 'runtime snapshot serialization failed' }
          : null;
      }
    }

    function snapshotInput(session) {
      try { return getReportInput(ownDataValue(session, 'initialContext') || {}); } catch (_) { return null; }
    }

    function commonSnapshot(session) {
      return {
        runId: ownDataValue(session, 'runId'),
        flowId: ownDataValue(session, 'flowId'),
        flowLabel: ownDataValue(session, 'flowLabel'),
        kind: ownDataValue(session, 'kind') || 'flow',
        assistantInvocationKind: ownDataValue(session, 'assistantInvocationKind') === 'runAssistant'
          ? 'runAssistant' : '',
        parentRunId: ownDataValue(session, 'parentRunId') || '',
        parentKind: ownDataValue(session, 'parentKind') || '',
        parentFlowGroupId: ownDataValue(session, 'parentFlowGroupId') || '',
        parentFlowGroupLabel: ownDataValue(session, 'parentFlowGroupLabel') || '',
        parentStepIndex: ownDataValue(session, 'parentStepIndex'),
        parentStepLabel: ownDataValue(session, 'parentStepLabel') || '',
        trigger: ownDataValue(session, 'trigger'),
        entry: ownDataValue(session, 'entry'),
        forceCdpKeepAlive: ownDataValue(session, 'forceCdpKeepAlive') === true,
        sessionCdpKeepAlive: ownDataValue(session, 'sessionCdpKeepAlive') === true,
        ownerTabId: ownDataValue(session, 'ownerTabId') || 0,
        originTabId: ownDataValue(session, 'originTabId') || 0,
        originWindowId: ownDataValue(session, 'originWindowId') || 0,
        runTabMode: ownDataValue(session, 'runTabMode'),
        startedAt: ownDataValue(session, 'startedAt') || 0,
        nodeStatuses: safeClone(ownDataValue(session, 'nodeStatuses') || {}, {}),
        tabs: safeClone(ownDataValue(session, 'tabs') || {}, {}),
        tabUsage: safeClone(ownDataValue(session, 'tabUsage') || {}, {}),
        tabEvents: safeClone(ownDataValue(session, 'tabEvents') || [], []),
        windowId: ownDataValue(session, 'windowId') || 0,
        boundTabId: ownDataValue(session, 'boundTabId') || 0,
        primaryRunTabId: ownDataValue(session, 'primaryRunTabId') || 0,
        fixedRunTab: !!ownDataValue(session, 'fixedRunTab'),
        incognito: !!ownDataValue(session, 'incognito'),
        input: snapshotInput(session),
      };
    }

    function runtimeSnapshotParts(session) {
      var executor = ownDataValue(session, 'executor');
      if (!executor || typeof executor.getCtx !== 'function' || typeof executor.getLoopStack !== 'function') return null;
      var ctx = safeSanitize(executor.getCtx(), session, 'runCtx');
      return {
        runCtx: ctx || {},
        loopStack: safeClone(executor.getLoopStack() || [], []),
        dataIndex: ctx && ctx.dataIndex !== undefined && ctx.dataIndex !== null ? ctx.dataIndex : null,
        initialContext: safeSanitize(ownDataValue(session, 'initialContext') || null, session, 'initialContext'),
      };
    }

    function saveStoppedSnapshot(session, info) {
      info = info || {};
      compactActiveSession(session, 'stopped-snapshot', { force: true });
      var runtime = runtimeSnapshotParts(session);
      if (!runtime) throw new Error('RunSessionRegistry stopped snapshot requires an executor');
      var snapshot = Object.assign(commonSnapshot(session), runtime, {
        status: 'stopped',
        stoppedAt: now(),
        stopNodeId: findStoppedNodeId(ownDataValue(session, 'nodeStatuses')),
        round: {
          completedRuns: (Array.isArray(info.summaries) ? info.summaries : []).filter(function (summary) {
            return summary && summary.status !== 'stopped';
          }).length,
          totalRuns: info.totalRuns || 1,
        },
        canContinue: ownDataValue(session, 'canContinue') !== false,
      });
      return setSnapshot(snapshot.runId, snapshot);
    }

    function saveCompletedSnapshot(session, status) {
      var snapshot = Object.assign(commonSnapshot(session), {
        endedAt: ownDataValue(session, 'endedAt') || now(),
        status: status,
        error: ownDataValue(session, 'error') || '',
        logs: safeClone(ownDataValue(session, 'logs') || [], []).slice(-50),
        canContinue: false,
      });
      setSnapshot(snapshot.runId, snapshot);
      pruneCompletedSnapshots();
      return snapshot;
    }

    function pruneCompletedSnapshots() {
      if (!snapshotsLoaded) pruneCompletedAfterLoad = true;
      var completed = [];
      Object.keys(snapshots).forEach(function (id) {
        var snapshot = snapshots[id];
        if (snapshot && !isResumableSnapshot(snapshot)) {
          completed.push({
            id: id,
            at: Number(ownDataValue(snapshot, 'endedAt') || ownDataValue(snapshot, 'startedAt')) || 0,
          });
        }
      });
      if (completed.length <= maxCompletedSnapshots) return [];
      completed.sort(function (a, b) { return b.at - a.at; });
      var removed = [];
      for (var i = maxCompletedSnapshots; i < completed.length; i++) {
        delete snapshots[completed[i].id];
        markSnapshotChanged(completed[i].id);
        removed.push(completed[i].id);
      }
      if (removed.length) persistSnapshots();
      return removed;
    }

    function saveRunningSnapshots(saveOptions) {
      saveOptions = saveOptions || {};
      var force = saveOptions.force === true;
      var timestamp = now();
      var changed = 0;
      Object.keys(sessions).forEach(function (id) {
        var session = sessions[id];
        var adapted = adaptSessionLike(session);
        if (!adapted || !adapted.running) return;
        var expectedVersion = snapshotVersion(id);
        var lastSnapshotAt = Number(ownDataValue(session, 'lastRunningSnapshotAt')) || 0;
        if (!force && lastSnapshotAt && timestamp - lastSnapshotAt < runningSnapshotIntervalMs) return;
        var executor = ownDataValue(session, 'executor');
        if (!executor || typeof executor.getCtx !== 'function' || typeof executor.getLoopStack !== 'function') return;
        try {
          compactActiveSession(session, 'running-snapshot', { force: force });
          var runtime = runtimeSnapshotParts(session);
          if (!runtime) return;
          session.lastRunningSnapshotAt = timestamp;
          var snapshot = Object.assign(commonSnapshot(session), runtime, {
            stoppedAt: timestamp,
            stopNodeId: '',
            canContinue: true,
            _isRunningSnapshot: true,
          });
          if (sessions[id] !== session || !adaptSessionLike(session).running) return;
          if (setSnapshot(id, snapshot, { persist: false, expectedVersion: expectedVersion })) changed++;
        } catch (error) {
          try { onSnapshotWarning(session, 'runningSnapshot', error); } catch (_) {}
        }
      });
      if (changed) persistSnapshots();
      return changed;
    }

    return {
      sessions: sessions,
      snapshots: snapshots,
      ready: ready,
      register: register,
      unregister: unregister,
      get: get,
      getSnapshot: getSnapshot,
      getSnapshotVersion: snapshotVersion,
      setSnapshot: setSnapshot,
      deleteSnapshot: deleteSnapshot,
      persistSnapshots: persistSnapshots,
      forEachSession: forEachSession,
      forEachSnapshot: forEachSnapshot,
      adaptSessionLike: adaptSessionLike,
      isResumableSnapshot: isResumableSnapshot,
      runningIds: runningIds,
      hasRunningFlow: hasRunningFlow,
      findLatestTerminal: findLatestTerminal,
      pruneTerminalSessions: pruneTerminalSessions,
      clearFinished: clearFinished,
      findStoppedNodeId: findStoppedNodeId,
      saveStoppedSnapshot: saveStoppedSnapshot,
      saveCompletedSnapshot: saveCompletedSnapshot,
      pruneCompletedSnapshots: pruneCompletedSnapshots,
      saveRunningSnapshots: saveRunningSnapshots,
    };
  }

  return {
    API_VERSION: API_VERSION,
    create: create,
  };
});
