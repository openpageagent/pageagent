// Flow Capabilities — 运行时能力解析与验证
(function attachFlowCapabilities(root, factory) {
  root.FlowCapabilities = factory();
})(globalThis, function () {

  function createFlowCapabilities(deps) {
    deps = deps || {};
    var getRegisteredFlowIds = deps.getRegisteredFlowIds || (function () { return []; });
    var getFlowDefinition = deps.getFlowDefinition || (function () { return null; });
    var getFlowCapabilities = deps.getFlowCapabilities || (function () { return {}; });
    var getTargetDefinition = deps.getTargetDefinition || (function () { return null; });

    // 获取 flow 的**运行时解析后**的能力快照
    function resolveCapabilities(state) {
      var capabilitiesByFlow = {};
      var flowIds = getRegisteredFlowIds();

      for (var i = 0; i < flowIds.length; i++) {
        var fid = flowIds[i];
        var caps = getFlowCapabilities(fid);
        capabilitiesByFlow[fid] = JSON.parse(JSON.stringify(caps));
      }

      // 允许 flow 自定义能力覆盖（通过 state 中存储的运行时判断结果）
      var flowState = state.flowState || {};
      for (var j = 0; j < flowIds.length; j++) {
        var fId = flowIds[j];
        if (flowState[fId] && flowState[fId]._capabilityOverrides) {
          Object.assign(capabilitiesByFlow[fId], flowState[fId]._capabilityOverrides);
        }
      }

      return capabilitiesByFlow;
    }

    // 验证启动自动运行的前提条件
    function validateAutoRunStart(state, settings) {
      var errors = [];
      var flowId = state.flowId;
      if (!flowId) {
        errors.push({ code: 'NO_FLOW_SELECTED', message: '未选择自动化流程' });
        return errors;
      }

      var flowDef = getFlowDefinition(flowId);
      if (!flowDef) {
        errors.push({ code: 'FLOW_NOT_FOUND', message: '流程未注册: ' + flowId });
        return errors;
      }

      // 可由 flow 自定义校验
      var customValidate = flowDef.validateAutoRun;
      if (typeof customValidate === 'function') {
        var customErrors = customValidate(state, settings);
        if (customErrors && customErrors.length) {
          errors = errors.concat(customErrors);
        }
      }

      return errors;
    }

    return {
      resolveCapabilities: resolveCapabilities,
      validateAutoRunStart: validateAutoRunStart,
    };
  }

  return { createFlowCapabilities: createFlowCapabilities };
});
