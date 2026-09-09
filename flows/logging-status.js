// Logging & Status — 日志管理与节点状态追踪
(function attachLoggingStatus(root, factory) {
  root.LoggingStatus = factory();
})(globalThis, function () {

  var MAX_LOG_ENTRIES = 500;

  function createLoggingStatus(deps) {
    deps = deps || {};
    var getState = deps.getState || (function () { return {}; });
    var setState = deps.setState || (function () {});
    var broadcast = deps.broadcast || (function () {});
    var getSourceLabel = deps.getSourceLabel || (function (s) { return s; });
    var getNodeTitle = deps.getNodeTitle || (function (f, n) { return n; });
    var isNodeDoneStatus = deps.isNodeDoneStatus || (function () { return false; });

    function normalizeLogScope(scope, hasNodeId) {
      if (scope === 'session') return 'run';
      if (scope === 'system' || scope === 'run' || scope === 'flow' || scope === 'mcp') return scope;
      return hasNodeId ? 'flow' : 'system';
    }

    function buildLogEntry(message, options) {
      options = options || {};
      var nodeId = options.nodeId || '';
      return {
        timestamp: Date.now(),
        message: String(message),
        level: options.level || 'info',
        nodeId: nodeId,
        source: options.source || '',
        scope: normalizeLogScope(options.scope, !!nodeId),
        tabId: options.tabId || 0,
        windowId: options.windowId || 0,
        flowId: options.flowId || '',
        runId: options.runId || '',
        conversationLog: !!options.conversationLog,
        displayRun: options.displayRun || '',
      };
    }

    function addLog(message, options) {
      var state = getState();
      var logs = (state && state.deepLog) ? state.deepLog.slice() : [];
      logs.push(buildLogEntry(message, options));
      if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(-MAX_LOG_ENTRIES);

      setState({ deepLog: logs });

      var entry = logs[logs.length - 1];
      broadcast({ type: 'NEW_LOG', payload: entry });
      return entry;
    }

    function setNodeStatus(nodeId, status) {
      var state = getState();
      var statuses = Object.assign({}, state.nodeStatuses || {});
      statuses[nodeId] = status;
      setState({ nodeStatuses: statuses, currentNodeId: nodeId });

      broadcast({
        type: 'NODE_STATUS_CHANGE',
        payload: { nodeId: nodeId, status: status },
      });
    }

    function getErrorMessage(error) {
      if (!error) return '未知错误';
      if (typeof error === 'string') return error;
      var message = error.message;
      if (!message && typeof error === 'object') {
        try { message = JSON.stringify(error); } catch (_) {}
      }
      if (!message) message = error.toString();
      var details = error.details || {};
      var operation = String(details.operation || '');
      if (operation && String(error.code || '') === 'ACTION_TIMEOUT') {
        return message + '（阶段：' + operation + '）';
      }
      return message;
    }

    // 判断是否为可重试的传输错误（Content Script 通信层面）
    function isRetryableTransportError(error) {
      var msg = getErrorMessage(error);
      return /Receiving end does not exist|message channel closed|port closed before a response|back\/forward cache|内容脚本.*秒内未响应/i.test(msg);
    }

    // 获取自动运行状态摘要
    function getAutoRunStatus(state) {
      var nodeStatuses = state.nodeStatuses || {};
      var nodeIds = Object.keys(nodeStatuses);
      var completed = nodeIds.filter(function (id) { return isNodeDoneStatus(nodeStatuses[id]); });
      var running = nodeIds.filter(function (id) { return nodeStatuses[id] === 'running'; });
      var failed = nodeIds.filter(function (id) { return nodeStatuses[id] === 'failed'; });
      return {
        total: nodeIds.length,
        completed: completed.length,
        running: running.length,
        failed: failed.length,
        currentNodeId: state.currentNodeId || '',
        phase: running.length > 0 ? 'running' : (completed.length === nodeIds.length ? 'done' : 'idle'),
      };
    }

    return {
      MAX_LOG_ENTRIES: MAX_LOG_ENTRIES,
      buildLogEntry: buildLogEntry,
      addLog: addLog,
      setNodeStatus: setNodeStatus,
      getErrorMessage: getErrorMessage,
      isRetryableTransportError: isRetryableTransportError,
      getAutoRunStatus: getAutoRunStatus,
    };
  }

  return { createLoggingStatus: createLoggingStatus };
});
