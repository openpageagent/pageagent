// Run Session - isolated per-flow runtime, lifecycle, stop, and result boundary.
(function attachRunSession(root, factory) {
  'use strict';

  root.RunSession = factory();
})(globalThis, function () {
  'use strict';

  function requireDependency(value, name) {
    if (!value) throw new Error('RunSession missing dependency: ' + name);
    return value;
  }

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('RunSession missing dependency: ' + name);
    return value;
  }

  function requireMethod(value, method, name) {
    requireDependency(value, name);
    requireFunction(value[method], name + '.' + method);
  }

  function configuredSessionCdpKeepAlive(flowId, deps) {
    var rawId = String(flowId || '').replace(/^user:/, '');
    var config = deps.getConfig() || {};
    var flow = config.flows && config.flows[rawId];
    return !!(flow && flow.allowCdpKeepAlive === true && flow.disableKeepAlive !== true);
  }

  function copyOwnData(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return '[Circular]';
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        var array = [];
        var lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        var length = lengthDescriptor && typeof lengthDescriptor.value === 'number' ? lengthDescriptor.value : 0;
        for (var i = 0; i < length; i++) {
          var itemDescriptor = Object.getOwnPropertyDescriptor(value, String(i));
          array.push(itemDescriptor && Object.prototype.hasOwnProperty.call(itemDescriptor, 'value')
            ? copyOwnData(itemDescriptor.value, seen)
            : null);
        }
        return array;
      }

      var output = {};
      Object.keys(value).forEach(function (key) {
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
        Object.defineProperty(output, key, {
          value: copyOwnData(descriptor.value, seen),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
      return output;
    } finally {
      seen.pop();
    }
  }

  function RunSession(flowId, options, deps, generateRunId) {
    options = options || {};
    Object.defineProperty(this, '_deps', {
      value: deps,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperties(this, {
      _stopGeneration: { value: 0, enumerable: false, configurable: false, writable: true },
      _runGeneration: { value: 0, enumerable: false, configurable: false, writable: true },
      _activeRunGeneration: { value: 0, enumerable: false, configurable: false, writable: true },
      _runAbortController: { value: null, enumerable: false, configurable: false, writable: true },
      _reportGenerations: { value: Object.create(null), enumerable: false, configurable: false, writable: false },
    });
    this.runId = options.runId || generateRunId();
    this.flowId = flowId;
    this.flowLabel = deps.getFlowLabel(flowId);
    this.status = 'idle';
    this.error = '';
    this.trigger = options.trigger || 'manual';
    this.entry = deps.normalizeEntry(options.entry, this.trigger);
    this.forceCdpKeepAlive = options.forceCdpKeepAlive === true
      || String(this.trigger).indexOf('schedule:') === 0
      || this.entry === 'schedule';
    this.sessionCdpKeepAlive = this.forceCdpKeepAlive || (
      Object.prototype.hasOwnProperty.call(options, 'sessionCdpKeepAlive')
        ? options.sessionCdpKeepAlive === true
        : configuredSessionCdpKeepAlive(flowId, deps)
    );
    this.assistantInvocationKind = options.assistantInvocationKind === 'runAssistant'
      ? 'runAssistant' : '';
    this.parentRunId = options.parentRunId || '';
    this.parentKind = options.parentKind || '';
    this.parentFlowGroupId = options.parentFlowGroupId || '';
    this.parentFlowGroupLabel = options.parentFlowGroupLabel || '';
    this.parentStepIndex = options.parentStepIndex;
    this.parentStepLabel = options.parentStepLabel || '';
    this.ownerTabId = options.ownerTabId || options.originTabId || options.boundTabId || 0;
    this.originTabId = options.originTabId || this.ownerTabId || 0;
    this.originWindowId = options.originWindowId || 0;
    this.conversationTopicId = options.conversationTopicId || '';
    this.boundTabId = options.boundTabId || 0;
    this.primaryRunTabId = options.primaryRunTabId || 0;
    this.fixedRunTab = !!options.fixedRunTab;
    this.runTabMode = deps.normalizeRunTabMode(
      options.runTabMode,
      deps.getConfiguredFlowRunTabMode(flowId, deps.defaultRunTabMode)
    );
    this.windowId = 0;
    this.keepAliveTabs = {};
    this.proxyConfigs = {};
    this.tabs = {};
    this.tabUsage = {};
    this.tabEvents = [];
    this.waitingTabs = {};
    this.nodeStatuses = {};
    this.logs = [];
    this.startedAt = 0;
    this.endedAt = 0;
    this.reportStatus = 'idle';
    this.reportError = '';
    this.reportId = '';
    this.reportPromise = Promise.resolve({ ok: true });
    this.lastRuntimeCompactAt = 0;
    this.lastRunningSnapshotAt = 0;
    this.addLog = this.addLog.bind(this);
    this._initializeRuntime();
  }

  RunSession.prototype._beginRunGeneration = function () {
    var generation = ++this._runGeneration;
    this._runAbortController = new AbortController();
    var resolveCompletion;
    var rejectCompletion;
    var entry = {
      generation: generation,
      operation: Promise.resolve({ ok: true }),
      completion: new Promise(function (resolve, reject) {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      }),
      resolveCompletion: resolveCompletion,
      rejectCompletion: rejectCompletion,
      settling: false,
      settled: false,
    };
    this._activeRunGeneration = generation;
    this._reportGenerations[generation] = entry;
    this.endedAt = 0;
    this.error = '';
    this.reportStatus = 'pending';
    this.reportError = '';
    this.reportId = '';
    this.reportPromise = entry.completion;
    entry.completion.catch(function () {});
    return entry;
  };

  RunSession.prototype._settleReportGeneration = function (entry, operation) {
    if (!entry || entry.settling || entry.settled) return;
    var session = this;
    entry.settling = true;
    entry.operation = Promise.resolve(operation);
    entry.operation.then(function (result) {
      if (entry.settled) return;
      entry.settled = true;
      if (session._reportGenerations[entry.generation] === entry) {
        delete session._reportGenerations[entry.generation];
      }
      entry.resolveCompletion(result);
    }, function (error) {
      if (entry.settled) return;
      entry.settled = true;
      if (session._reportGenerations[entry.generation] === entry) {
        delete session._reportGenerations[entry.generation];
      }
      entry.rejectCompletion(error);
    });
  };

  RunSession.prototype.addLog = function (message, options) {
    options = options || {};
    var nodeId = options.nodeId || '';
    var entry = {
      timestamp: this._deps.now(),
      level: options.level || 'info',
      nodeId: nodeId,
      scope: this._deps.normalizeLogScope(options.scope, !!nodeId, 'run'),
      tabId: options.tabId || 0,
      windowId: options.windowId || 0,
      flowId: this.flowId,
      runId: this.runId,
      message: String(message),
    };
    this.logs.push(entry);
    if (this.logs.length > this._deps.maxSessionLogs) {
      this.logs.splice(0, this.logs.length - this._deps.maxSessionLogs);
    }
    this._deps.broadcast({ type: 'NEW_LOG', payload: Object.assign({ runId: this.runId }, entry) });
    return entry;
  };

  RunSession.prototype._initializeRuntime = function () {
    var session = this;
    var deps = this._deps;
    var sessionTabRuntime = deps.tabRuntime.createTabRuntime({
      chrome: deps.chrome,
      getState: function () {
        return { flowId: session.flowId, nodeStatuses: session.nodeStatuses, sharedState: {} };
      },
      setState: function () {},
      addLog: session.addLog,
      getSourceLabel: function (source) { return deps.sourceRegistry.getSourceLabel(source); },
      resolveCanonicalSource: function (source) { return deps.sourceRegistry.resolveCanonicalSource(source); },
      getDriverIdForSource: function (source) { return deps.sourceRegistry.getDriverIdForSource(source); },
      matchesSourceUrlFamily: function (source, url) { return deps.sourceRegistry.matchesSourceUrlFamily(source, url); },
      isRetryableTransportError: function (error) { return deps.loggingStatus.isRetryableTransportError(error); },
      getPageAutomation: function () { return deps.pageAutomation; },
      getCdpKeepAliveState: function (tabId) {
        return session.keepAliveTabs && session.keepAliveTabs[tabId] || '';
      },
      throwIfStopped: function () {
        if (session.controller && session.controller.isRunning()) session.controller.throwIfStopped();
      },
    });
    var tabAccess = deps.createSessionTabAccess(session, sessionTabRuntime);
    var sessionModelClient = deps.modelClient.createModelClient({ chrome: deps.chrome, addLog: session.addLog });
    var executor = deps.nodeExecutor.createNodeExecutor({
      chrome: deps.chrome,
      tabRuntime: tabAccess,
      addLog: session.addLog,
      getConfig: deps.getConfig,
      pageHostMatchesTab: deps.pageHostMatchesTab,
      modelClient: sessionModelClient,
      proxyManager: deps.proxyManager,
      getRunHistory: function () { return deps.configStore.getRuns(); },
      getSandboxEngine: function () {
        return {
          turndownHtmlToMarkdown: deps.sandboxEngine.turndownHtmlToMarkdown,
          runScript: function (code, options) {
            return deps.sandboxEngine.runScript(code, Object.assign({}, options, {
              apiCall: executor.executeApiCall,
              tag: session.runId,
              addLog: session.addLog,
            }));
          },
        };
      },
      getSession: function () { return session; },
      getAbortSignal: function () {
        return session._runAbortController && session._runAbortController.signal || null;
      },
      pageAutomation: deps.pageAutomation,
      getAssistantOrchestrator: deps.getAssistantOrchestrator,
      throwIfStopped: function () {
        if (session.controller && session.controller.isRunning()) session.controller.throwIfStopped();
      },
      sleep: deps.sleep,
    });
    [
      'executeNodeInstance',
      'executeApiCall',
      'resetCtx',
      'getCtx',
      'setCtx',
      'getLoopStack',
      'setLoopStack',
    ].forEach(function (method) { requireMethod(executor, method, 'nodeExecutor instance'); });
    this.executor = executor;
    this.controller = deps.autoRunController.createAutoRunController({
      getState: function () {
        return { flowId: session.flowId, nodeStatuses: session.nodeStatuses, sharedState: {} };
      },
      setState: function (patch) {
        if (patch && patch.nodeStatuses) session.nodeStatuses = patch.nodeStatuses;
      },
      addLog: session.addLog,
      setNodeStatus: function (nodeId, status) {
        session.nodeStatuses[nodeId] = status;
        deps.broadcast({
          type: 'NODE_STATUS_CHANGE',
          payload: { runId: session.runId, nodeId: nodeId, status: status },
        });
      },
      getOrderedNodes: function (id) { return deps.flowEngine.getOrderedNodes(id); },
      getNodeIdsForFlow: function (id) { return deps.flowEngine.getNodeIdsForFlow(id); },
      isNodeDoneStatus: function (status) { return deps.flowEngine.isNodeDoneStatus(status); },
      getErrorMessage: function (error) { return deps.loggingStatus.getErrorMessage(error); },
      executeNode: function (nodeId) { return session._executeNode(nodeId); },
      broadcast: function (message) { session._broadcastControllerMessage(message); },
      sleep: deps.sleep,
      onRunStart: function (info) { session._onRunStart(info); },
      onRunComplete: function (info) { session._onRunComplete(info); },
      onRoundReset: function () { session._onRoundReset(); },
      getLoopStack: function () { return executor.getLoopStack(); },
      getCtx: function () { return executor.getCtx(); },
      captureFailureScreenshot: function (node) { return deps.captureSessionScreenshot(session, node); },
      getFlowDataset: deps.getFlowDataset,
    });
    [
      'requestStop',
      'requestFailure',
      'clearStopRequest',
      'getStopRequested',
      'isRunning',
      'throwIfStopped',
      'startAutoRunLoop',
    ].forEach(function (method) { requireMethod(session.controller, method, 'autoRunController instance'); });
  };

  RunSession.prototype._executeNode = function (nodeId) {
    var session = this;
    var nodes = this._deps.flowEngine.getOrderedNodes(this.flowId);
    var node = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeId === nodeId) {
        node = nodes[i];
        break;
      }
    }
    if (!node) return Promise.reject(new Error('节点不存在: ' + nodeId));
    return this.executor.executeNodeInstance(node, {
      flowId: this.flowId,
      flowLabel: this.flowLabel,
    }).then(function (result) {
      session._deps.compactActiveSessionRuntime(session, 'node-complete');
      return result;
    }, function (error) {
      session._deps.compactActiveSessionRuntime(session, 'node-error', { force: true });
      throw error;
    });
  };

  RunSession.prototype._broadcastControllerMessage = function (message) {
    if (message && message.payload) {
      message.payload.runId = this.runId;
      if (!message.payload.entry) message.payload.entry = this.entry || '';
      if (!message.payload.ownerTabId) message.payload.ownerTabId = this.ownerTabId || 0;
      if (!message.payload.flowLabel) message.payload.flowLabel = this.flowLabel || '';
      if (!message.payload.kind) message.payload.kind = this.kind || 'flow';
      if (!message.payload.trigger) message.payload.trigger = this.trigger || '';
    }
    this._deps.broadcast(message);
  };

  RunSession.prototype._onRunStart = function (info) {
    var session = this;
    var deps = this._deps;
    var generation = this._activeRunGeneration;
    var reportEntry = this._reportGenerations[generation];
    this.status = 'running';
    this.startedAt = info.startedAt;
    this.runLogStart = this.logs.length;
    this.reportStatus = 'pending';
    this.reportError = '';
    this.reportId = info.sessionId;
    deps.syncSwKeepAlive();
    var runRecord = deps.runReport.createStartRecord({
      id: info.sessionId,
      runId: this.runId,
      flowId: this.flowId,
      flowLabel: this.flowLabel,
      trigger: this.trigger,
      entry: this.entry,
      parentRunId: this.parentRunId || '',
      parentKind: this.parentKind || '',
      parentFlowGroupId: this.parentFlowGroupId || '',
      parentFlowGroupLabel: this.parentFlowGroupLabel || '',
      parentStepIndex: this.parentStepIndex,
      parentStepLabel: this.parentStepLabel || '',
      ownerTabId: this.ownerTabId || 0,
      originWindowId: this.originWindowId || 0,
      runTabMode: this.runTabMode,
      startedAt: info.startedAt,
      input: deps.getReportInputFromContext(this.initialContext || {}),
    });
    deps.rememberRunInput(runRecord);
    var appendPromise = deps.configStore.appendRun(runRecord).then(function (result) {
      if (session._activeRunGeneration === generation) session.reportStatus = 'running';
      deps.broadcast({ type: 'RUN_HISTORY_UPDATED' });
      deps.broadcastSessions();
      return { ok: true, result: result };
    }, function (error) {
      return deps.markRunReportPersistenceFailure(session, info.sessionId, 'flow', '创建', error, generation);
    });
    if (reportEntry) reportEntry.operation = appendPromise;
    deps.broadcastSessions();
  };

  RunSession.prototype._onRunComplete = function (info) {
    var session = this;
    var deps = this._deps;
    var generation = this._activeRunGeneration;
    var reportEntry = this._reportGenerations[generation];
    var summaries = info.summaries || [];
    var reportOutput = null;
    var outputError = '';
    try {
      reportOutput = deps.extractFlowOutputs(this.flowId, this.executor.getCtx() || {});
    } catch (error) {
      outputError = deps.loggingStatus.getErrorMessage(error);
    }
    var completionError = info.error || (!info.stopped ? outputError : '') || '';
    var status = deps.runReport.deriveTerminalStatus({
      status: info.status,
      stopped: info.stopped,
      summaries: summaries,
      error: completionError,
    });
    this.status = status;
    this.endedAt = deps.now();
    this.error = completionError;
    if (status === 'stopped') deps.saveRunSnapshot(this, info);
    else deps.saveCompletedSnapshot(this, status);
    deps.compactFinishedSessionRuntime(this, status);
    var reportInput = deps.getReportInputFromContext(this.initialContext || {});
    deps.rememberRunInput(info.sessionId, reportInput, this.runId);
    var terminalPatch = deps.runReport.createTerminalPatch({
      endedAt: this.endedAt,
      status: status,
      summaries: summaries,
      input: reportInput,
      output: reportOutput,
      error: this.error,
      entry: this.entry,
      parentRunId: this.parentRunId || '',
      parentKind: this.parentKind || '',
      parentFlowGroupId: this.parentFlowGroupId || '',
      parentFlowGroupLabel: this.parentFlowGroupLabel || '',
      parentStepIndex: this.parentStepIndex,
      parentStepLabel: this.parentStepLabel || '',
      ownerTabId: this.ownerTabId || 0,
      originWindowId: this.originWindowId || 0,
      runTabMode: this.runTabMode,
      tabs: Object.assign({}, this.tabs),
      tabUsage: deps.cloneJsonSafe(this.tabUsage || {}),
      tabEvents: deps.cloneJsonSafe(this.tabEvents || []),
      logs: this.logs.slice(this.runLogStart || 0),
      nodeStatuses: this.nodeStatuses,
    });
    var terminalPromise = Promise.resolve(reportEntry ? reportEntry.operation : this.reportPromise).then(function (startResult) {
      if (startResult && startResult.ok === false) return startResult;
      return deps.configStore.updateRun(info.sessionId, terminalPatch).then(function (result) {
        if (session._activeRunGeneration === generation) session.reportStatus = 'complete';
        deps.broadcast({ type: 'RUN_HISTORY_UPDATED' });
        deps.broadcastSessions();
        return { ok: true, result: result };
      }, function (error) {
        return deps.markRunReportPersistenceFailure(session, info.sessionId, 'flow', '终态写入', error, generation);
      });
    });
    if (reportEntry) this._settleReportGeneration(reportEntry, terminalPromise);
    else this.reportPromise = terminalPromise;
    if (this.detachKeepAlive) this.detachKeepAlive();
    deps.pageAutomation.action.cleanupOwner(this.runId, { detachImmediately: true }).catch(function () {});
    if (this.proxyConfigs && Object.keys(this.proxyConfigs).length > 0) {
      deps.proxyManager.clearSession(this, 'run_complete').then(function (result) {
        if (result.activeRules > 0) {
          session.addLog('会话结束，已移除本会话代理规则；仍保留其他会话代理规则 ' + result.activeRules + ' 条');
        } else {
          session.addLog('会话结束，已移除本会话代理规则并释放浏览器代理控制');
        }
      }).catch(function (error) {
        session.addLog('会话结束清理代理失败: ' + (error && error.message), { level: 'warn' });
      });
    }
    deps.syncSwKeepAlive();
    deps.broadcastSessions();
    deps.pruneSessions();
  };

  RunSession.prototype._onRoundReset = function () {
    this.executor.resetCtx();
    if (this.initialContext) Object.assign(this.executor.getCtx(), this.initialContext);
  };

  RunSession.prototype.reserve = function () {
    if (this.status === 'idle') this.status = 'running';
    return this._stopGeneration;
  };

  RunSession.prototype._finishStoppedBeforeLaunch = function (reportEntry, totalRuns) {
    var timestamp = this._deps.now();
    this._onRunStart({ sessionId: this.runId, flowId: this.flowId, startedAt: timestamp });
    this._onRunComplete({
      sessionId: this.runId,
      flowId: this.flowId,
      summaries: [],
      stopped: true,
      totalRuns: totalRuns || 1,
    });
    var reportCompletion = reportEntry.completion;
    this.runPromise = this._deps.waitForRunReport(Promise.resolve(), function () { return reportCompletion; });
    return {
      runId: this.runId,
      started: false,
      stopped: true,
      ownerTabId: this.ownerTabId || 0,
      boundTabId: this.boundTabId || 0,
      runTabMode: this.runTabMode,
      fixedRunTab: !!this.fixedRunTab,
    };
  };

  RunSession.prototype.launch = function (options) {
    options = options || {};
    if (this.status !== 'idle' && this.status !== 'running') {
      throw new Error('RunSession launch requires an idle or reserved session');
    }
    if (this.controller.isRunning()) throw new Error('RunSession is already running');
    var reportEntry = this._beginRunGeneration();
    this.incognito = !!options.incognito;
    if (this.incognito) this.addLog('会话运行在隐私窗口模式（只使用隐私窗口的标签页）');
    this.addLog('运行标签策略: ' + this._deps.runTabModeLabel(this.runTabMode), { scope: 'run' });
    var initialContext = options.initialContext;
    if (initialContext && typeof initialContext === 'object' && Object.keys(initialContext).length) {
      this.initialContext = initialContext;
      Object.assign(this.executor.getCtx(), initialContext);
    }
    if (this.status === 'idle') this.status = 'running';
    var reservationChanged = options.reservationStopGeneration !== undefined
      && options.reservationStopGeneration !== this._stopGeneration;
    if (this.status !== 'running' || reservationChanged || this.controller.getStopRequested()) {
      return this._finishStoppedBeforeLaunch(reportEntry, options.totalRuns);
    }
    var controllerPromise = this.controller.startAutoRunLoop({
      totalRuns: options.totalRuns || 1,
      maxRetries: options.maxRetries != null ? options.maxRetries : 0,
      resumeFromNodeId: options.resumeFromNodeId || '',
    });
    var reportCompletion = reportEntry.completion;
    this.runPromise = this._deps.waitForRunReport(controllerPromise, function () { return reportCompletion; });
    return {
      runId: this.runId,
      started: true,
      ownerTabId: this.ownerTabId || 0,
      boundTabId: this.boundTabId || 0,
      runTabMode: this.runTabMode,
      fixedRunTab: !!this.fixedRunTab,
    };
  };

  RunSession.prototype.restart = function (trigger, controllerOptions) {
    if (this.status === 'running' || this.controller.isRunning()) {
      throw new Error('RunSession is already running');
    }
    var reportEntry = this._beginRunGeneration();
    this.trigger = trigger;
    this.forceCdpKeepAlive = this.forceCdpKeepAlive === true
      || String(trigger || '').indexOf('schedule:') === 0
      || this.entry === 'schedule';
    if (this.forceCdpKeepAlive) this.sessionCdpKeepAlive = true;
    this.status = 'running';
    this.controller.clearStopRequest();
    var controllerPromise = this.controller.startAutoRunLoop(controllerOptions || {});
    var reportCompletion = reportEntry.completion;
    this.runPromise = this._deps.waitForRunReport(
      controllerPromise,
      function () { return reportCompletion; }
    );
    return this.runPromise;
  };

  RunSession.prototype.failStart = function (error) {
    this.status = 'failed';
    this.endedAt = this._deps.now();
    this.error = this._deps.loggingStatus.getErrorMessage(error);
    this.addLog('启动会话失败: ' + this.error, { level: 'error' });
    if (this.detachKeepAlive) this.detachKeepAlive();
    this._deps.pageAutomation.action.cleanupOwner(this.runId, { detachImmediately: true }).catch(function () {});
    var reportEntry = this._reportGenerations[this._activeRunGeneration];
    if (reportEntry && !reportEntry.settling && !reportEntry.settled) {
      if (!this.reportId) this.reportStatus = 'idle';
      this._settleReportGeneration(reportEntry, reportEntry.operation);
    }
  };

  RunSession.prototype.markReportPersistenceFailure = function (message, phase, generation) {
    if (generation !== undefined && generation !== this._activeRunGeneration) return false;
    if (!this.reportError) this.reportError = message;
    this.reportStatus = 'failed';
    this.addLog('运行报告' + phase + '失败: ' + message, { level: 'error', scope: 'run' });
    return true;
  };

  RunSession.prototype.restore = function (snapshot) {
    snapshot = snapshot || {};
    this.status = 'stopped';
    this.startedAt = snapshot.startedAt || 0;
    this.endedAt = snapshot.stoppedAt || 0;
    this.nodeStatuses = copyOwnData(snapshot.nodeStatuses || {});
    this.tabs = copyOwnData(snapshot.tabs || {});
    this.tabUsage = copyOwnData(snapshot.tabUsage || {});
    this.tabEvents = copyOwnData(snapshot.tabEvents || []);
    this.windowId = snapshot.windowId || 0;
    this.incognito = !!snapshot.incognito;
    this.fixedRunTab = !!snapshot.fixedRunTab;
    this.forceCdpKeepAlive = snapshot.forceCdpKeepAlive === true
      || String(snapshot.trigger || this.trigger || '').indexOf('schedule:') === 0
      || String(snapshot.entry || this.entry || '') === 'schedule';
    this.sessionCdpKeepAlive = this.forceCdpKeepAlive || snapshot.sessionCdpKeepAlive === true;
    if (snapshot.initialContext) this.initialContext = snapshot.initialContext;
    this.executor.setCtx(Object.assign({}, snapshot.runCtx || {}));
    this.executor.setLoopStack((snapshot.loopStack || []).slice());
    this.addLog('会话已从停止快照重建（service worker 曾被回收）');
    return this;
  };

  RunSession.prototype.requestStop = function (options) {
    options = options || {};
    if (this.status !== 'running') return false;
    if (this.controller.getStopRequested()) return false;
    this._stopGeneration += 1;
    var logMessage = options.logMessage || '收到停止信号';
    if (options.logBeforeStop === true) this.addLog(logMessage);
    this.controller.requestStop();
    if (this._runAbortController && !this._runAbortController.signal.aborted) {
      var stopError = new Error(options.abortReason || '流程已停止');
      stopError.code = 'FLOW_STOPPED';
      try { this._runAbortController.abort(stopError); } catch (_) { this._runAbortController.abort(); }
    }
    this._deps.sandboxEngine.abortByTag(this.runId, options.abortReason || '流程已停止');
    if (options.logBeforeStop !== true) this.addLog(logMessage);
    return true;
  };

  RunSession.prototype.failRuntime = function (error, options) {
    options = options || {};
    if (this.status !== 'running') return false;
    error = error instanceof Error ? error : new Error(String(error || '流程运行时失败'));
    error.code = error.code || 'FLOW_RUNTIME_FAILED';
    error.fatalFlow = true;
    if (!this.controller.requestFailure(error)) return false;
    if (this._runAbortController && !this._runAbortController.signal.aborted) {
      try { this._runAbortController.abort(error); } catch (_) { this._runAbortController.abort(); }
    }
    this.addLog(options.logMessage || ('流程运行时失败: ' + error.message), {
      level: 'error', scope: 'run', tabId: Number(options.tabId) || 0,
    });
    this._deps.sandboxEngine.abortByTag(this.runId, error.message);
    return true;
  };

  function buildSessionResult(session, deps, options) {
    options = options || {};
    var runtimeContext = {};
    var context = {};
    try {
      runtimeContext = session.executor && session.executor.getCtx
        ? session.executor.getCtx()
        : (session.initialContext || {});
      context = deps.cloneRuntimeContextForResult(runtimeContext, options);
    } catch (_) {
      context = { __error: '上下文包含不可序列化数据' };
    }
    var result = {
      runId: session.runId,
      flowId: session.flowId,
      flowLabel: session.flowLabel,
      status: session.status,
      error: session.error || '',
      reportStatus: session.reportStatus || '',
      reportError: session.reportError || '',
      entry: session.entry,
      kind: session.kind || 'flow',
      parentRunId: session.parentRunId || '',
      parentKind: session.parentKind || '',
      parentFlowGroupId: session.parentFlowGroupId || '',
      parentFlowGroupLabel: session.parentFlowGroupLabel || '',
      parentStepIndex: session.parentStepIndex,
      parentStepLabel: session.parentStepLabel || '',
      ownerTabId: session.ownerTabId || 0,
      originWindowId: session.originWindowId || 0,
      runTabMode: session.runTabMode,
      primaryRunTabId: session.primaryRunTabId || 0,
      tabs: copyOwnData(session.tabs || {}),
      tabUsage: copyOwnData(session.tabUsage || {}),
      tabEvents: copyOwnData(session.tabEvents || []),
      flowGroupResults: copyOwnData(session.flowGroupResults || []),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      nodeStatuses: copyOwnData(session.nodeStatuses || {}),
      ctx: context,
      logs: copyOwnData(session.logs || []).slice(-100),
    };
    if (options.includeDebugTrace === true) {
      try {
        result.debugTrace = session.executor && session.executor.getDebugTrace
          ? copyOwnData(session.executor.getDebugTrace() || [])
          : [];
      } catch (_) {
        result.debugTrace = [];
      }
    }
    if (session.status === 'success' && options.includeFinalOutput === true) {
      try {
        var finalOutput = deps.extractFlowOutputs(session.flowId, runtimeContext || {});
        var clonedOutput = deps.cloneRuntimeValueForResult(finalOutput);
        result.output = clonedOutput;
        result.result = clonedOutput;
      } catch (_) {}
    }
    return result;
  }

  RunSession.prototype.getResult = function (options) {
    return buildSessionResult(this, this._deps, options);
  };

  function createRunSessionFactory(deps) {
    deps = deps || {};
    requireMethod(deps.tabRuntime, 'createTabRuntime', 'tabRuntime');
    requireMethod(deps.modelClient, 'createModelClient', 'modelClient');
    requireMethod(deps.nodeExecutor, 'createNodeExecutor', 'nodeExecutor');
    requireMethod(deps.autoRunController, 'createAutoRunController', 'autoRunController');
    requireMethod(deps.runReport, 'createStartRecord', 'runReport');
    requireMethod(deps.runReport, 'createTerminalPatch', 'runReport');
    requireMethod(deps.runReport, 'deriveTerminalStatus', 'runReport');
    requireMethod(deps.sourceRegistry, 'getSourceLabel', 'sourceRegistry');
    requireMethod(deps.sourceRegistry, 'resolveCanonicalSource', 'sourceRegistry');
    requireMethod(deps.sourceRegistry, 'getDriverIdForSource', 'sourceRegistry');
    requireMethod(deps.sourceRegistry, 'matchesSourceUrlFamily', 'sourceRegistry');
    requireMethod(deps.flowEngine, 'getOrderedNodes', 'flowEngine');
    requireMethod(deps.flowEngine, 'getNodeIdsForFlow', 'flowEngine');
    requireMethod(deps.flowEngine, 'isNodeDoneStatus', 'flowEngine');
    requireMethod(deps.loggingStatus, 'getErrorMessage', 'loggingStatus');
    requireMethod(deps.loggingStatus, 'isRetryableTransportError', 'loggingStatus');
    requireMethod(deps.configStore, 'getRuns', 'configStore');
    requireMethod(deps.configStore, 'appendRun', 'configStore');
    requireMethod(deps.configStore, 'updateRun', 'configStore');
    requireMethod(deps.proxyManager, 'clearSession', 'proxyManager');
    requireMethod(deps.sandboxEngine, 'runScript', 'sandboxEngine');
    requireMethod(deps.sandboxEngine, 'turndownHtmlToMarkdown', 'sandboxEngine');
    requireMethod(deps.sandboxEngine, 'abortByTag', 'sandboxEngine');

    [
      'createSessionTabAccess',
      'getFlowLabel',
      'normalizeEntry',
      'normalizeRunTabMode',
      'getConfiguredFlowRunTabMode',
      'normalizeLogScope',
      'runTabModeLabel',
      'getConfig',
      'pageHostMatchesTab',
      'getAssistantOrchestrator',
      'sleep',
      'now',
      'random',
      'compactActiveSessionRuntime',
      'compactFinishedSessionRuntime',
      'captureSessionScreenshot',
      'getFlowDataset',
      'broadcast',
      'broadcastSessions',
      'syncSwKeepAlive',
      'pruneSessions',
      'markRunReportPersistenceFailure',
      'waitForRunReport',
      'rememberRunInput',
      'getReportInputFromContext',
      'extractFlowOutputs',
      'saveRunSnapshot',
      'saveCompletedSnapshot',
      'cloneJsonSafe',
      'cloneRuntimeContextForResult',
      'cloneRuntimeValueForResult',
    ].forEach(function (name) { requireFunction(deps[name], name); });
    requireDependency(deps.defaultRunTabMode, 'defaultRunTabMode');
    requireDependency(deps.maxSessionLogs, 'maxSessionLogs');
    var maxSessionLogs = Number(deps.maxSessionLogs);
    if (!Number.isFinite(maxSessionLogs) || maxSessionLogs < 1) {
      throw new Error('RunSession invalid dependency: maxSessionLogs');
    }

    var sequence = 0;
    var normalized = Object.assign({}, deps);
    normalized.maxSessionLogs = Math.floor(maxSessionLogs);

    function generateRunId() {
      sequence += 1;
      return 'sess_' + normalized.now().toString(36) + '_' + sequence.toString(36)
        + normalized.random().toString(36).slice(2, 5);
    }

    return {
      create: function (flowId, options) {
        return new RunSession(flowId, options, normalized, generateRunId);
      },
      stop: function (session, options) {
        if (!session) return;
        if (session.status !== 'running') return false;
        if (typeof session.requestStop === 'function') return session.requestStop(options);
        var logMessage = options && options.logMessage || '收到停止信号';
        if (options && options.logBeforeStop === true && session.addLog) session.addLog(logMessage);
        session.controller.requestStop();
        normalized.sandboxEngine.abortByTag(session.runId, options && options.abortReason || '流程已停止');
        if ((!options || options.logBeforeStop !== true) && session.addLog) session.addLog(logMessage);
        return true;
      },
      getResult: function (session, options) {
        if (!session) throw new Error('RunSession result requires a session');
        return buildSessionResult(session, normalized, options);
      },
    };
  }

  return {
    RunSession: RunSession,
    createRunSessionFactory: createRunSessionFactory,
  };
});
