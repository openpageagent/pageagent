// Step Registry — 节点执行器注册中心
(function attachStepRegistry(root, factory) {
  root.StepRegistry = factory();
})(globalThis, function () {

  function createStepRegistry(definitions) {
    definitions = definitions || [];
    var nodeMap = {};
    var orderedNodes = [];

    // 索引节点定义
    for (var i = 0; i < definitions.length; i++) {
      var def = definitions[i];
      var nodeId = def.nodeId;
      if (!nodeId) continue;

      var normalized = {
        nodeId: nodeId,
        flowId: def.flowId || '',
        displayOrder: def.displayOrder || 0,
        title: def.title || nodeId,
        execute: def.execute || null,
        executeKey: def.executeKey || nodeId,
      };

      nodeMap[nodeId] = normalized;
    }

    orderedNodes = Object.values(nodeMap).sort(function (a, b) {
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      return a.nodeId.localeCompare(b.nodeId);
    });

    function getNodeDefinition(nodeId) {
      return nodeMap[nodeId] || null;
    }

    function getOrderedNodes() {
      return orderedNodes.slice();
    }

    function getNodeIds() {
      return orderedNodes.map(function (n) { return n.nodeId; });
    }

    function executeNode(nodeId, state) {
      var def = nodeMap[nodeId];
      if (!def || !def.execute) {
        throw new Error('Node not found or has no execute function: ' + nodeId);
      }
      return def.execute(state);
    }

    return {
      getNodeDefinition: getNodeDefinition,
      getOrderedNodes: getOrderedNodes,
      getNodeIds: getNodeIds,
      executeNode: executeNode,
    };
  }

  return { createStepRegistry: createStepRegistry };
});
