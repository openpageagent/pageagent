// 运行时状态管理 — 分层作用域、深度合并、持久化边界
(function attachRuntimeState(root, factory) {
  root.RuntimeState = factory();
})(globalThis, function () {

  var RUNTIME_SHARED_FIELDS = [
    'automationWindowId', 'tabRegistry', 'sourceLastUrls', 'flowStartTime',
  ];

  var DEFAULT_STATE = {
    flowId: '',
    currentNodeId: '',
    runId: '',
    nodeStatuses: {},
    deepLog: [],
    sharedState: {
      automationWindowId: null,
      tabRegistry: {},
      sourceLastUrls: {},
      flowStartTime: null,
    },
    flowState: {},
  };

  function createRuntimeState(deps) {
    deps = deps || {};
    var getPersisted = deps.getPersisted || (function () { return {}; });
    var setPersisted = deps.setPersisted || (function () {});
    var deepMerge = deps.deepMerge || (function (a, b) { return b; });

    function buildDefaultState() {
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    // 将原始状态规范化，填充默认值
    function ensureState(raw) {
      var base = buildDefaultState();
      var merged = deepMerge(base, raw || {});
      merged.sharedState = deepMerge(base.sharedState, (raw || {}).sharedState || {});
      merged.nodeStatuses = merged.nodeStatuses || {};
      return merged;
    }

    // 构建持久化 patch — 只保留跨 session 需要的字段
    function buildPersistentPatch(state) {
      var patch = {};
      // 共享字段是 session-only，不持久化
      // flowState 中的自定义字段如果被标记为 persistent 则保留
      var flowState = state.flowState || {};
      var flowIds = Object.keys(flowState);
      for (var i = 0; i < flowIds.length; i++) {
        var flowId = flowIds[i];
        var fs = flowState[flowId];
        if (fs && typeof fs === 'object') {
          patch[flowId] = JSON.parse(JSON.stringify(fs));
        }
      }
      return patch;
    }

    // 构建 session 状态 patch（跨步骤传递的共享字段）
    function buildSessionPatch(current, updates) {
      var patch = {};
      var us = updates.sharedState || {};
      for (var i = 0; i < RUNTIME_SHARED_FIELDS.length; i++) {
        var key = RUNTIME_SHARED_FIELDS[i];
        if (key in us) patch[key] = us[key];
      }
      return patch;
    }

    return {
      buildDefaultState: buildDefaultState,
      ensureState: ensureState,
      buildPersistentPatch: buildPersistentPatch,
      buildSessionPatch: buildSessionPatch,
      DEFAULT_STATE: DEFAULT_STATE,
    };
  }

  return { createRuntimeState: createRuntimeState, DEFAULT_STATE: DEFAULT_STATE };
});
