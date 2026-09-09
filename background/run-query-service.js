// Run Query Service — 运行会话、结果与对话面板的只读查询编排和快照隔离
(function attachRunQueryService(root, factory) {
  'use strict';
  root.RunQueryService = factory();
})(globalThis, function () {
  'use strict';

  function requireFunction(deps, name) {
    if (typeof deps[name] !== 'function') throw new Error('RunQueryService 缺少依赖: ' + name);
    return deps[name];
  }

  function ownValue(target, key, fallback) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return fallback;
    try {
      var descriptor = Object.getOwnPropertyDescriptor(target, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function ownSnapshot(value, state, depth) {
    if (value === null || value === undefined) return value;
    var type = typeof value;
    state = state && !Array.isArray(state) ? state : { seen: [], members: 0, maxMembers: 10000, maxStringChars: 200000 };
    if (type === 'string') {
      return value.length > state.maxStringChars ? value.slice(0, state.maxStringChars) + '[Truncated]' : value;
    }
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'symbol') return String(value);
    if (type === 'function') return '<function>';
    if (type !== 'object') return undefined;
    if (depth > 12) return '[Truncated]';
    if (state.seen.indexOf(value) !== -1) return '[Circular]';
    state.seen.push(value);
    var out = Array.isArray(value) ? [] : {};
    var keys;
    try { keys = Object.keys(value); } catch (_) { keys = []; }
    for (var i = 0; i < keys.length; i++) {
      if (state.members++ >= state.maxMembers) {
        if (!Array.isArray(out)) out.__truncated = true;
        break;
      }
      var key = keys[i];
      var item = ownValue(value, key, undefined);
      var cloned = ownSnapshot(item, state, depth + 1);
      if (cloned !== undefined || item === undefined) out[key] = cloned;
    }
    if (!Array.isArray(value)) {
      var errorMessage = ownValue(value, 'message', undefined);
      var hadEnumerableMessage = Object.prototype.hasOwnProperty.call(out, 'message');
      if (!hadEnumerableMessage && typeof errorMessage === 'string' && errorMessage) {
        out.message = errorMessage;
      }
      if (!hadEnumerableMessage && typeof errorMessage === 'string' && errorMessage && !Object.prototype.hasOwnProperty.call(out, 'name')) {
        var errorName = ownValue(value, 'name', undefined);
        if (!errorName) {
          try {
            var prototype = Object.getPrototypeOf(value);
            errorName = ownValue(ownValue(prototype, 'constructor', null), 'name', undefined);
          } catch (_) {}
        }
        if (typeof errorName === 'string' && errorName) out.name = errorName;
      }
    }
    state.seen.pop();
    return out;
  }

  function createRunQueryService(deps) {
    deps = deps || {};
    var registry = deps.registry;
    if (!registry || typeof registry.forEachSession !== 'function'
        || typeof registry.forEachSnapshot !== 'function' || typeof registry.get !== 'function') {
      throw new Error('RunQueryService 缺少依赖: registry');
    }
    var getRunSessionResult = requireFunction(deps, 'getRunSessionResult');
    var getOrderedNodes = requireFunction(deps, 'getOrderedNodes');
    var getSessionActionTabIds = requireFunction(deps, 'getSessionActionTabIds');
    var getSnapshotActionTabIds = requireFunction(deps, 'getSnapshotActionTabIds');
    var resolveRunSummaryInput = requireFunction(deps, 'resolveRunSummaryInput');
    var getReportInputFromContext = requireFunction(deps, 'getReportInputFromContext');

    function waitForRunReport(runPromise, getReportPromise) {
      if (typeof getReportPromise !== 'function') return Promise.reject(new Error('运行报告等待器缺少 getReportPromise'));
      function captureReportPromise() {
        try { return Promise.resolve(getReportPromise()); }
        catch (error) { return Promise.reject(error); }
      }
      return Promise.resolve(runPromise).then(function (value) {
        var reportPromise = captureReportPromise();
        return reportPromise.then(function () { return value; });
      }, function (runtimeError) {
        var reportPromise = captureReportPromise();
        return reportPromise.then(function () { throw runtimeError; }, function () { throw runtimeError; });
      });
    }

    function getSessionResult(runId, options) {
      return Promise.resolve(getRunSessionResult(runId, ownSnapshot(options || {}, [], 0))).then(function (result) {
        return ownSnapshot(result, [], 0);
      });
    }

    function nodesOf(flowId) {
      try {
        return getOrderedNodes(flowId).map(function (node) {
          return {
            nodeId: ownValue(node, 'nodeId', ''),
            title: ownValue(node, 'title', ''),
            displayOrder: ownValue(node, 'displayOrder', undefined),
            type: ownValue(node, 'type', ''),
          };
        });
      } catch (_) { return []; }
    }

    function nodesOfSession(session) {
      var sessionNodes = ownValue(session, 'nodes', null);
      if (ownValue(session, 'kind', '') === 'flowGroup' && Array.isArray(sessionNodes)) return ownSnapshot(sessionNodes, [], 0);
      return nodesOf(ownValue(session, 'flowId', ''));
    }

    function sessionSummary(session) {
      var tabs = ownValue(session, 'tabs', {}) || {};
      var keepAliveTabs = ownValue(session, 'keepAliveTabs', {}) || {};
      var keepAlive = {};
      Object.keys(keepAliveTabs).forEach(function (tabId) {
        keepAlive[tabId] = ownSnapshot(ownValue(keepAliveTabs, tabId, null), [], 0);
      });
      var runId = ownValue(session, 'runId', '');
      var initialContext = ownValue(session, 'initialContext', {}) || {};
      var kind = ownValue(session, 'kind', '') || 'flow';
      var status = ownValue(session, 'status', '');
      return {
        runId: runId,
        flowId: ownValue(session, 'flowId', ''),
        flowLabel: ownValue(session, 'flowLabel', ''),
        status: status,
        reportStatus: ownValue(session, 'reportStatus', '') || '',
        reportError: ownValue(session, 'reportError', '') || '',
        trigger: ownValue(session, 'trigger', ''),
        entry: ownValue(session, 'entry', ''),
        kind: kind,
        parentRunId: ownValue(session, 'parentRunId', '') || '',
        parentKind: ownValue(session, 'parentKind', '') || '',
        parentFlowGroupId: ownValue(session, 'parentFlowGroupId', '') || '',
        parentFlowGroupLabel: ownValue(session, 'parentFlowGroupLabel', '') || '',
        parentStepIndex: ownValue(session, 'parentStepIndex', undefined),
        parentStepLabel: ownValue(session, 'parentStepLabel', '') || '',
        ownerTabId: ownValue(session, 'ownerTabId', 0) || 0,
        originTabId: ownValue(session, 'originTabId', 0) || 0,
        originWindowId: ownValue(session, 'originWindowId', 0) || 0,
        runTabMode: ownValue(session, 'runTabMode', ''),
        startedAt: ownValue(session, 'startedAt', 0),
        endedAt: ownValue(session, 'endedAt', 0),
        boundTabId: ownValue(session, 'boundTabId', 0),
        primaryRunTabId: ownValue(session, 'primaryRunTabId', 0) || 0,
        fixedRunTab: !!ownValue(session, 'fixedRunTab', false),
        windowId: ownValue(session, 'windowId', 0) || 0,
        incognito: !!ownValue(session, 'incognito', false),
        tabIds: Object.keys(tabs).map(function (key) { return ownValue(tabs, key, 0); }),
        occupiedTabIds: ownSnapshot(getSessionActionTabIds(session), [], 0),
        tabUsage: ownSnapshot(ownValue(session, 'tabUsage', {}) || {}, [], 0),
        tabEvents: ownSnapshot(ownValue(session, 'tabEvents', []) || [], [], 0),
        keepAlive: keepAlive,
        nodeStatuses: ownSnapshot(ownValue(session, 'nodeStatuses', {}) || {}, [], 0),
        nodes: nodesOfSession(session),
        logs: ownSnapshot((ownValue(session, 'logs', []) || []).slice(-100), [], 0),
        input: ownSnapshot(resolveRunSummaryInput(runId, getReportInputFromContext(initialContext)), [], 0),
        canContinue: kind !== 'flowGroup' && status === 'stopped',
      };
    }

    function snapshotSummary(snap, runId) {
      var status = ownValue(snap, 'status', '') || 'stopped';
      var runningSnapshot = !!ownValue(snap, '_isRunningSnapshot', false);
      if (runningSnapshot) status = 'stopped';
      var snapshotRunId = ownValue(snap, 'runId', '') || runId;
      var tabs = ownValue(snap, 'tabs', {}) || {};
      var initialContext = ownValue(snap, 'initialContext', {}) || {};
      return {
        runId: snapshotRunId,
        flowId: ownValue(snap, 'flowId', ''),
        flowLabel: ownValue(snap, 'flowLabel', ''),
        status: status,
        reportStatus: ownValue(snap, 'reportStatus', '') || 'complete',
        reportError: ownValue(snap, 'reportError', '') || '',
        trigger: ownValue(snap, 'trigger', ''),
        entry: ownValue(snap, 'entry', ''),
        kind: ownValue(snap, 'kind', '') || 'flow',
        parentRunId: ownValue(snap, 'parentRunId', '') || '',
        parentKind: ownValue(snap, 'parentKind', '') || '',
        parentFlowGroupId: ownValue(snap, 'parentFlowGroupId', '') || '',
        parentFlowGroupLabel: ownValue(snap, 'parentFlowGroupLabel', '') || '',
        parentStepIndex: ownValue(snap, 'parentStepIndex', undefined),
        parentStepLabel: ownValue(snap, 'parentStepLabel', '') || '',
        ownerTabId: ownValue(snap, 'ownerTabId', 0) || 0,
        originTabId: ownValue(snap, 'originTabId', 0) || 0,
        originWindowId: ownValue(snap, 'originWindowId', 0) || 0,
        runTabMode: ownValue(snap, 'runTabMode', ''),
        startedAt: ownValue(snap, 'startedAt', 0) || 0,
        endedAt: ownValue(snap, 'endedAt', 0) || ownValue(snap, 'stoppedAt', 0) || 0,
        boundTabId: ownValue(snap, 'boundTabId', 0) || 0,
        primaryRunTabId: ownValue(snap, 'primaryRunTabId', 0) || 0,
        fixedRunTab: !!ownValue(snap, 'fixedRunTab', false),
        windowId: ownValue(snap, 'windowId', 0) || 0,
        incognito: !!ownValue(snap, 'incognito', false),
        tabIds: Object.keys(tabs).map(function (key) { return ownValue(tabs, key, 0); }),
        occupiedTabIds: ownSnapshot(getSnapshotActionTabIds(snap), [], 0),
        tabUsage: ownSnapshot(ownValue(snap, 'tabUsage', {}) || {}, [], 0),
        tabEvents: ownSnapshot(ownValue(snap, 'tabEvents', []) || [], [], 0),
        keepAlive: {},
        nodeStatuses: ownSnapshot(ownValue(snap, 'nodeStatuses', {}) || {}, [], 0),
        nodes: nodesOf(ownValue(snap, 'flowId', '')),
        logs: ownSnapshot(ownValue(snap, 'logs', []) || [], [], 0),
        input: ownSnapshot(resolveRunSummaryInput(snapshotRunId,
          ownValue(snap, 'input', undefined) !== undefined ? ownValue(snap, 'input', undefined) : getReportInputFromContext(initialContext)), [], 0),
        canContinue: runningSnapshot ? true : (ownValue(snap, 'canContinue', true) !== false && status === 'stopped'),
      };
    }

    function getSessionsSummary() {
      var list = [];
      registry.forEachSession(function (session) { list.push(sessionSummary(session)); });
      registry.forEachSnapshot(function (snap, runId) {
        if (!registry.get(runId)) list.push(snapshotSummary(snap, runId));
      });
      return list.sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
    }

    return Object.freeze({
      waitForRunReport: waitForRunReport,
      getSessionResult: getSessionResult,
      getSessionsSummary: getSessionsSummary,
    });
  }

  return Object.freeze({ createRunQueryService: createRunQueryService });
});
