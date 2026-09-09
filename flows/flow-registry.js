// Flow Registry — 流程注册中心，管理所有自动化流程定义
(function attachFlowRegistry(root, factory) {
  root.FlowRegistry = factory();
})(globalThis, function () {

  function createFlowRegistry(deps) {
    deps = deps || {};

    // flowDefinitions: { [flowId]: FlowDefinition }
    var flowDefinitions = deps.flowDefinitions || {};
    var defaultFlowId = deps.defaultFlowId || '';

    function registerFlow(flowId, definition) {
      flowDefinitions[flowId] = definition;
    }

    function unregisterFlow(flowId) {
      delete flowDefinitions[flowId];
      if (defaultFlowId === flowId) {
        var remaining = Object.keys(flowDefinitions);
        defaultFlowId = remaining.length ? remaining[0] : '';
      }
    }

    function getRegisteredFlowIds() {
      return Object.keys(flowDefinitions);
    }

    function getFlowDefinition(flowId) {
      return flowDefinitions[flowId] || null;
    }

    function getFlowLabel(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.label) ? def.label : flowId;
    }

    function normalizeFlowId(raw) {
      if (!raw) return defaultFlowId;
      if (flowDefinitions[raw]) return raw;
      // 回退：找第一个匹配前缀的
      var ids = getRegisteredFlowIds();
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] === raw || ids[i].startsWith(raw)) return ids[i];
      }
      return defaultFlowId;
    }

    // --- Target 查询 ---

    function getTargetDefinitions(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.targets) ? def.targets : {};
    }

    function getTargetDefinition(flowId, targetId) {
      var targets = getTargetDefinitions(flowId);
      return targets[targetId] || null;
    }

    function getDefaultTargetId(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.defaultTargetId) ? def.defaultTargetId : '';
    }

    function normalizeTargetId(flowId, raw) {
      if (!raw) return getDefaultTargetId(flowId);
      var targets = getTargetDefinitions(flowId);
      if (targets[raw]) return raw;
      var keys = Object.keys(targets);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === raw || keys[i].startsWith(raw)) return keys[i];
      }
      return getDefaultTargetId(flowId);
    }

    // --- Capabilities ---

    function getFlowCapabilities(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.capabilities) ? def.capabilities : {};
    }

    // --- Source 聚合 ---

    function getRuntimeSourceDefinitions(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.runtimeSources) ? def.runtimeSources : {};
    }

    function getDriverDefinitions(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.driverDefinitions) ? def.driverDefinitions : {};
    }

    function getAllRuntimeSources() {
      var result = {};
      var ids = getRegisteredFlowIds();
      for (var i = 0; i < ids.length; i++) {
        Object.assign(result, getRuntimeSourceDefinitions(ids[i]));
      }
      return result;
    }

    function getAllDriverDefinitions() {
      var result = {};
      var ids = getRegisteredFlowIds();
      for (var i = 0; i < ids.length; i++) {
        Object.assign(result, getDriverDefinitions(ids[i]));
      }
      return result;
    }

    // --- Settings Groups ---

    function getSettingsGroupDefinitions(flowId) {
      var def = flowDefinitions[flowId];
      return (def && def.settingsGroups) ? def.settingsGroups : {};
    }

    return {
      registerFlow: registerFlow,
      unregisterFlow: unregisterFlow,
      getRegisteredFlowIds: getRegisteredFlowIds,
      getFlowDefinition: getFlowDefinition,
      getFlowLabel: getFlowLabel,
      normalizeFlowId: normalizeFlowId,
      getDefaultFlowId: function () { return defaultFlowId; },
      getTargetDefinitions: getTargetDefinitions,
      getTargetDefinition: getTargetDefinition,
      getDefaultTargetId: getDefaultTargetId,
      normalizeTargetId: normalizeTargetId,
      getFlowCapabilities: getFlowCapabilities,
      getRuntimeSourceDefinitions: getRuntimeSourceDefinitions,
      getDriverDefinitions: getDriverDefinitions,
      getAllRuntimeSources: getAllRuntimeSources,
      getAllDriverDefinitions: getAllDriverDefinitions,
      getSettingsGroupDefinitions: getSettingsGroupDefinitions,
    };
  }

  return { createFlowRegistry: createFlowRegistry };
});
