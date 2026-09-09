// Flow Engine — DAG 节点状态机
(function attachFlowEngine(root, factory) {
  root.FlowEngine = factory();
})(globalThis, function () {

  // 节点状态常量
  var STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    STOPPED: 'stopped',
    MANUAL_COMPLETED: 'manual_completed',
  };

  var DONE_STATUSES = [STATUS.COMPLETED, STATUS.MANUAL_COMPLETED, STATUS.SKIPPED];
  var TERMINAL_STATUSES = DONE_STATUSES.concat([STATUS.FAILED, STATUS.STOPPED]);

  function createFlowEngine(deps) {
    deps = deps || {};
    var getWorkflowDefs = deps.getWorkflowDefinitions || (function () { return {}; });

    function getWorkflowForFlow(flowId) {
      var defs = getWorkflowDefs();
      return defs[flowId] || null;
    }

    function getNodesForFlow(flowId) {
      var wf = getWorkflowForFlow(flowId);
      return (wf && wf.nodes) ? wf.nodes.slice() : [];
    }

    function getNodeIdsForFlow(flowId) {
      return getNodesForFlow(flowId).map(function (n) { return n.nodeId; });
    }

    function getNodeById(flowId, nodeId) {
      var nodes = getNodesForFlow(flowId);
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].nodeId === nodeId) return nodes[i];
      }
      return null;
    }

    function getNodeTitle(flowId, nodeId) {
      var node = getNodeById(flowId, nodeId);
      return (node && node.title) ? node.title : nodeId;
    }

    // 按 displayOrder 排序后的节点列表
    function getOrderedNodes(flowId) {
      return getNodesForFlow(flowId).sort(function (a, b) {
        var ao = a.displayOrder || 0;
        var bo = b.displayOrder || 0;
        if (ao !== bo) return ao - bo;
        return (a.nodeId || '').localeCompare(b.nodeId || '');
      });
    }

    // 构建默认节点状态（全部 pending）
    function buildDefaultNodeStatuses(flowId) {
      var statuses = {};
      var nodeIds = getNodeIdsForFlow(flowId);
      for (var i = 0; i < nodeIds.length; i++) {
        statuses[nodeIds[i]] = STATUS.PENDING;
      }
      return statuses;
    }

    function normalizeNodeStatuses(flowId, raw) {
      var defaults = buildDefaultNodeStatuses(flowId);
      if (!raw || typeof raw !== 'object') return defaults;
      var result = {};
      var keys = Object.keys(defaults);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        result[k] = (k in raw) ? raw[k] : defaults[k];
      }
      return result;
    }

    function isNodeDoneStatus(status) {
      return DONE_STATUSES.indexOf(status) !== -1;
    }

    function isNodeTerminalStatus(status) {
      return TERMINAL_STATUSES.indexOf(status) !== -1;
    }

    // 获取当前正在运行的节点
    function getRunningNodeIds(flowId, nodeStatuses) {
      var running = [];
      var nodeIds = getNodeIdsForFlow(flowId);
      for (var i = 0; i < nodeIds.length; i++) {
        if (nodeStatuses[nodeIds[i]] === STATUS.RUNNING) running.push(nodeIds[i]);
      }
      return running;
    }

    // 获取第一个未完成节点（断点续跑）
    function getFirstUnfinishedNodeId(flowId, nodeStatuses) {
      var ordered = getOrderedNodes(flowId);
      for (var i = 0; i < ordered.length; i++) {
        if (!isNodeDoneStatus(nodeStatuses[ordered[i].nodeId] || STATUS.PENDING)) {
          return ordered[i].nodeId;
        }
      }
      return null;
    }

    // 获取后继节点 ID 列表
    function getNextNodeIds(flowId, nodeId) {
      var node = getNodeById(flowId, nodeId);
      if (!node || !node.next) return [];
      return Array.isArray(node.next) ? node.next.slice() : [node.next];
    }

    // 是否还有待执行的节点
    function hasRemainingNodes(flowId, nodeStatuses) {
      return getFirstUnfinishedNodeId(flowId, nodeStatuses) !== null;
    }

    return {
      STATUS: STATUS,
      getWorkflowForFlow: getWorkflowForFlow,
      getNodesForFlow: getNodesForFlow,
      getNodeIdsForFlow: getNodeIdsForFlow,
      getNodeById: getNodeById,
      getNodeTitle: getNodeTitle,
      getOrderedNodes: getOrderedNodes,
      buildDefaultNodeStatuses: buildDefaultNodeStatuses,
      normalizeNodeStatuses: normalizeNodeStatuses,
      isNodeDoneStatus: isNodeDoneStatus,
      isNodeTerminalStatus: isNodeTerminalStatus,
      getRunningNodeIds: getRunningNodeIds,
      getFirstUnfinishedNodeId: getFirstUnfinishedNodeId,
      getNextNodeIds: getNextNodeIds,
      hasRemainingNodes: hasRemainingNodes,
    };
  }

  return { createFlowEngine: createFlowEngine, STATUS: STATUS };
});
