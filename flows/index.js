// Flow Index — 通用 Flow 注册中心
// 每个 Flow 通过在 flows/ 下创建自己的目录并在此注册
(function attachFlowIndex(root, factory) {
  root.FlowIndex = factory();
})(globalThis, function () {

  var flowDefinitions = {};
  var workflowDefinitions = {};
  var defaultFlowId = '';

  // 注册 Flow（由各 flow 的 index.js 调用）
  function registerFlow(config) {
    var id = config.id;
    if (!id) throw new Error('Flow 必须指定 id');

    flowDefinitions[id] = {
      id: id,
      label: config.label || id,
      capabilities: config.capabilities || {},
      targets: config.targets || {},
      defaultTargetId: config.defaultTargetId || '',
      runtimeSources: config.runtimeSources || {},
      driverDefinitions: config.driverDefinitions || {},
      settingsGroups: config.settingsGroups || {},
      validateAutoRun: config.validateAutoRun || null,
      contentScripts: config.contentScripts || [],
    };

    // 注册 Workflow
    if (config.workflow) {
      workflowDefinitions[id] = config.workflow;
    }

    // 第一个注册的 flow 为默认
    if (!defaultFlowId) defaultFlowId = id;

    return flowDefinitions[id];
  }

  // 注销 Flow（动态配置重载时使用）
  function unregisterFlow(id) {
    delete flowDefinitions[id];
    delete workflowDefinitions[id];
    if (defaultFlowId === id) {
      var remaining = Object.keys(flowDefinitions);
      defaultFlowId = remaining.length ? remaining[0] : '';
    }
  }

  function getFlowDefinitions() {
    return Object.assign({}, flowDefinitions);
  }

  function getWorkflowDefinitions() {
    return Object.assign({}, workflowDefinitions);
  }

  function getDefaultFlowId() {
    return defaultFlowId;
  }

  function getAllNodeDefinitions() {
    var nodes = [];
    var flowIds = Object.keys(workflowDefinitions);
    for (var i = 0; i < flowIds.length; i++) {
      var wf = workflowDefinitions[flowIds[i]];
      if (wf && wf.nodes) {
        for (var j = 0; j < wf.nodes.length; j++) {
          var node = Object.assign({}, wf.nodes[j]);
          node.flowId = flowIds[i];
          nodes.push(node);
        }
      }
    }
    return nodes;
  }

  // --- 尝试自动加载示例 flow ---
  // 各 flow 通过 importScripts 在 background.js 中导入自己的 index.js

  return {
    registerFlow: registerFlow,
    unregisterFlow: unregisterFlow,
    getFlowDefinitions: getFlowDefinitions,
    getWorkflowDefinitions: getWorkflowDefinitions,
    getDefaultFlowId: getDefaultFlowId,
    getAllNodeDefinitions: getAllNodeDefinitions,
  };
});
