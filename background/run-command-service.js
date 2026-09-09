// Run Command Service - orchestrates RunSession creation and lifecycle commands.
(function attachRunCommandService(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RunCommandService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('RunCommandService missing dependency: ' + name);
    return value;
  }

  function requireMethod(value, name, owner) {
    if (!value || typeof value[name] !== 'function') {
      throw new Error('RunCommandService missing dependency: ' + owner + '.' + name);
    }
    return value[name].bind(value);
  }

  function requireSessionMethod(session, name) {
    if (!session || typeof session[name] !== 'function') {
      throw new Error('RunCommandService invalid session method: ' + name);
    }
    return session[name].bind(session);
  }

  function runtimeUserFlowId(value) {
    var text = String(value);
    return text.indexOf('user:') === 0 ? text : 'user:' + text;
  }

  function createRunCommandService(deps) {
    deps = deps || {};
    var registry = deps.registry;
    var registerSession = requireMethod(registry, 'register', 'registry');
    var unregisterSession = requireMethod(registry, 'unregister', 'registry');
    var getSession = requireMethod(registry, 'get', 'registry');
    var forEachSession = requireMethod(registry, 'forEachSession', 'registry');
    var adaptSessionLike = requireMethod(registry, 'adaptSessionLike', 'registry');
    var isResumableSnapshot = requireMethod(registry, 'isResumableSnapshot', 'registry');
    var hasRunningFlow = requireMethod(registry, 'hasRunningFlow', 'registry');
    var findLatestTerminal = requireMethod(registry, 'findLatestTerminal', 'registry');
    var getSnapshot = requireMethod(registry, 'getSnapshot', 'registry');
    var deleteSnapshot = requireMethod(registry, 'deleteSnapshot', 'registry');
    var findStoppedNodeId = requireMethod(registry, 'findStoppedNodeId', 'registry');
    var createRawSession = requireFunction(deps.createRunSession, 'createRunSession');
    var stopRawSession = requireFunction(deps.stopRunSession, 'stopRunSession');
    var getRawSessionResult = requireFunction(deps.getRunSessionResult, 'getRunSessionResult');
    var getConfigReady = requireFunction(deps.getConfigReady, 'getConfigReady');
    var getSnapshotsReady = requireFunction(deps.getSnapshotsReady, 'getSnapshotsReady');
    var hasRegisteredFlow = requireFunction(deps.hasRegisteredFlow, 'hasRegisteredFlow');
    var getTabIncognito = requireFunction(deps.getTabIncognito, 'getTabIncognito');
    var buildInitialContext = requireFunction(deps.buildInitialContext, 'buildInitialContext');
    var broadcastSessions = requireFunction(deps.broadcastSessions, 'broadcastSessions');
    var pruneSessions = requireFunction(deps.pruneSessions, 'pruneSessions');

    function rollbackSessionRegistration(session) {
      try { unregisterSession(session && session.runId, session); } catch (_) {}
      try { broadcastSessions(); } catch (_) {}
    }

    function snapshotNotResumableError(runId) {
      var error = new Error('该会话不可继续: ' + (runId || ''));
      error.code = 'SNAPSHOT_NOT_RESUMABLE';
      return error;
    }

    function createSession(flowId, options) {
      var session = createRawSession(flowId, options || {});
      if (!session || (typeof session !== 'object' && typeof session !== 'function')) {
        throw new Error('RunCommandService createRunSession must return a session');
      }
      try {
        registerSession(session);
        broadcastSessions();
      } catch (error) {
        rollbackSessionRegistration(session);
        throw error;
      }
      return session;
    }

    function rehydrateSession(snapshot, fallbackRunId) {
      if (!isResumableSnapshot(snapshot)) {
        throw snapshotNotResumableError(fallbackRunId || (snapshot && snapshot.runId));
      }
      var session = createSession(snapshot.flowId, {
        runId: snapshot.runId || fallbackRunId,
        entry: snapshot.entry,
        assistantInvocationKind: snapshot.assistantInvocationKind || '',
        parentRunId: snapshot.parentRunId || '',
        parentKind: snapshot.parentKind || '',
        parentFlowGroupId: snapshot.parentFlowGroupId || '',
        parentFlowGroupLabel: snapshot.parentFlowGroupLabel || '',
        parentStepIndex: snapshot.parentStepIndex,
        parentStepLabel: snapshot.parentStepLabel || '',
        ownerTabId: snapshot.ownerTabId,
        originTabId: snapshot.originTabId,
        originWindowId: snapshot.originWindowId,
        runTabMode: snapshot.runTabMode,
        boundTabId: snapshot.boundTabId,
        primaryRunTabId: snapshot.primaryRunTabId || 0,
        fixedRunTab: !!snapshot.fixedRunTab,
        trigger: snapshot.trigger,
        forceCdpKeepAlive: snapshot.forceCdpKeepAlive === true,
        sessionCdpKeepAlive: snapshot.sessionCdpKeepAlive === true,
        incognito: !!snapshot.incognito,
      });
      try {
        return requireSessionMethod(session, 'restore')(snapshot);
      } catch (error) {
        rollbackSessionRegistration(session);
        throw error;
      }
    }

    function startSessionRun(flowId, options) {
      var runOptions = options || {};
      return Promise.resolve().then(getConfigReady).then(function () {
        if (!hasRegisteredFlow(flowId)) throw new Error('流程不存在: ' + flowId);

        // Register and reserve before asynchronous tab inspection so concurrent
        // starts can observe this run and avoid claiming the same tab.
        var session = createSession(flowId, runOptions);
        var startFailed = false;
        function failReservedStart(error) {
          if (startFailed) return;
          startFailed = true;
          var failureRecorded = false;
          try {
            requireSessionMethod(session, 'failStart')(error);
            failureRecorded = true;
          } catch (_) {}
          if (!failureRecorded) {
            try { unregisterSession(session.runId, session); } catch (_) {}
          }
          try { broadcastSessions(); } catch (_) {}
          try { pruneSessions(); } catch (_) {}
        }

        var reservationStopGeneration;
        try {
          reservationStopGeneration = requireSessionMethod(session, 'reserve')();
          broadcastSessions();
        } catch (error) {
          failReservedStart(error);
          throw error;
        }

        return Promise.resolve().then(function () {
          var incognitoTabId = runOptions.originTabId || runOptions.ownerTabId
            || runOptions.boundTabId || 0;
          if (!incognitoTabId) return !!runOptions.incognito;
          return Promise.resolve().then(function () {
            return getTabIncognito(incognitoTabId);
          }).then(function (incognito) {
            return !!incognito;
          }).catch(function () {
            return !!runOptions.incognito;
          });
        }).then(function (incognito) {
          var initialContext = buildInitialContext(
            flowId,
            runOptions.initialContext || runOptions.context || {}
          );
          return requireSessionMethod(session, 'launch')({
            incognito: incognito,
            initialContext: initialContext,
            totalRuns: runOptions.totalRuns || 1,
            maxRetries: runOptions.maxRetries != null ? runOptions.maxRetries : 0,
            resumeFromNodeId: runOptions.resumeFromNodeId || '',
            reservationStopGeneration: reservationStopGeneration,
          });
        }).catch(function (error) {
          failReservedStart(error);
          throw error;
        });
      });
    }

    function startFlowRun(userFlowId, trigger, options) {
      return Promise.resolve().then(function () {
        var runOptions = Object.assign({ trigger: trigger || 'manual' }, options || {});
        return startSessionRun(runtimeUserFlowId(userFlowId), runOptions);
      });
    }

    function stopSession(runId) {
      try {
        runId = String(runId || '').trim();
        if (!runId) throw new Error('停止运行缺少 runId');
        var session = getSession(runId);
        if (!session) throw new Error('运行会话不存在或已被清理: ' + runId);
        if (session.status !== 'running') throw new Error('运行会话已不在运行: ' + runId);
        return Promise.resolve(stopRawSession(session)).then(function (stopped) {
          if (stopped === false) {
            var alreadyRequested = !!(session.controller
              && typeof session.controller.getStopRequested === 'function'
              && session.controller.getStopRequested());
            if (alreadyRequested) return { runId: runId, stopped: true, alreadyRequested: true };
            throw new Error('运行会话未接受停止请求: ' + runId);
          }
          if (stopped !== true) throw new Error('运行会话停止结果无效: ' + runId);
          return { runId: runId, stopped: true };
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function stopAllSessions() {
      var stops = [];
      try {
        forEachSession(function (session) {
          if (!session || session.status !== 'running') return;
          try {
            stops.push(Promise.resolve(stopRawSession(session)));
          } catch (error) {
            stops.push(Promise.reject(error));
          }
        });
      } catch (error) {
        stops.push(Promise.reject(error));
      }
      return Promise.all(stops).then(function () {});
    }

    function getSessionResult(runId, options) {
      return Promise.resolve().then(function () {
        var session = getSession(runId);
        if (!session) throw new Error('会话不存在或已被清理: ' + runId);
        return getRawSessionResult(session, options || {});
      });
    }

    function getSessionExecutor(runId) {
      var session = getSession(runId);
      return session ? session.executor : null;
    }

    function isFlowSessionRunning(flowId) {
      return hasRunningFlow(flowId);
    }

    function findResumableSession(flowId) {
      return findLatestTerminal(flowId);
    }

    function resumeSession(runId, nodeId) {
      // Always return a Promise: restart() can throw synchronously when a stale
      // caller races another resume, while Router/MCP callers consume rejection.
      return Promise.resolve().then(getConfigReady).then(function () {
        var session = getSession(runId);
        if (!session) throw new Error('会话不存在或已过期: ' + runId);
        if (session.status === 'running') throw new Error('该会话正在运行中');
        if (!hasRegisteredFlow(session.flowId)) {
          throw new Error('流程已被删除，无法续跑: ' + session.flowLabel);
        }
        requireSessionMethod(session, 'restart')('resume:' + nodeId, {
          totalRuns: 1,
          maxRetries: 0,
          resumeFromNodeId: nodeId,
        });
        deleteSnapshot(runId);
        broadcastSessions();
        return { runId: runId, started: true };
      });
    }

    function resumeFlowFrom(userFlowId, nodeId, options) {
      var runOptions = options || {};
      return Promise.resolve().then(getConfigReady).then(function () {
        var flowId = runtimeUserFlowId(userFlowId);
        if (!hasRegisteredFlow(flowId)) throw new Error('流程不存在: ' + userFlowId);
        var resumable = findResumableSession(flowId);
        if (resumable) return resumeSession(resumable.runId, nodeId);
        return startSessionRun(flowId, Object.assign({}, runOptions, {
          trigger: 'resume:' + nodeId,
          resumeFromNodeId: nodeId,
        }));
      });
    }

    function continueSession(runId) {
      return Promise.all([
        Promise.resolve().then(getSnapshotsReady),
        Promise.resolve().then(getConfigReady),
      ]).then(function () {
        var snapshot = getSnapshot(runId);
        var session = getSession(runId);
        if (!session && !snapshot) {
          throw new Error('找不到可继续的会话（快照可能已过期）: ' + runId);
        }
        if (session && session.status === 'running') throw new Error('该会话正在运行中');

        var flowId = session ? session.flowId : snapshot.flowId;
        if (!hasRegisteredFlow(flowId)) {
          throw new Error('流程已被删除，无法继续: '
            + (session ? session.flowLabel : snapshot.flowLabel));
        }
        var adaptedSession = session ? adaptSessionLike(session) : null;
        if ((session && (!adaptedSession || !adaptedSession.resumable))
            || (snapshot && !isResumableSnapshot(snapshot))) {
          throw snapshotNotResumableError(runId);
        }
        if (!session) session = rehydrateSession(snapshot, runId);

        var stopNodeId = snapshot
          ? snapshot.stopNodeId
          : findStoppedNodeId(session.nodeStatuses);
        var dataIndex = snapshot ? snapshot.dataIndex : (function () {
          var value = session.executor.getCtx().dataIndex;
          return value === undefined || value === null ? null : value;
        })();
        var remainingRuns = snapshot && snapshot.round
          ? Math.max(1, (snapshot.round.totalRuns || 1)
            - (snapshot.round.completedRuns || 0))
          : 1;

        requireSessionMethod(session, 'restart')('continue', {
          totalRuns: remainingRuns,
          maxRetries: 0,
          continueFrom: stopNodeId ? { nodeId: stopNodeId, dataIndex: dataIndex } : null,
        });
        deleteSnapshot(runId);
        broadcastSessions();
        return { runId: session.runId, started: true, continued: true };
      });
    }

    return {
      rehydrateSession: rehydrateSession,
      startSessionRun: startSessionRun,
      startFlowRun: startFlowRun,
      stopSession: stopSession,
      stopAllSessions: stopAllSessions,
      getSessionResult: getSessionResult,
      getSessionExecutor: getSessionExecutor,
      isFlowSessionRunning: isFlowSessionRunning,
      resumeSession: resumeSession,
      resumeFlowFrom: resumeFlowFrom,
      continueSession: continueSession,
    };
  }

  return { createRunCommandService: createRunCommandService };
});
