// Settings Schema — 分层用户设置管理
(function attachSettingsSchema(root, factory) {
  root.SettingsSchema = factory();
})(globalThis, function () {

  function deepMerge(a, b) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return b;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
    var result = {};
    var keys = Object.keys(a).concat(Object.keys(b));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k in result) continue;
      result[k] = deepMerge(a[k], b[k]);
    }
    return result;
  }

  function createSettingsSchema(deps) {
    deps = deps || {};
    var getRegisteredFlowIds = deps.getRegisteredFlowIds || (function () { return []; });
    var getFlowDefinition = deps.getFlowDefinition || (function () { return null; });
    var getTargetDefinitions = deps.getTargetDefinitions || (function () { return {}; });

    // 构建设置默认值树
    function buildDefaults() {
      var defaults = {
        services: {
          autoRun: {
            totalRuns: 1,
            maxRetriesPerRound: 0,
            retryDelaySeconds: 30,
            roundIntervalSeconds: 5,
          },
        },
        flows: {},
      };

      var flowIds = getRegisteredFlowIds();
      for (var i = 0; i < flowIds.length; i++) {
        var fid = flowIds[i];
        var def = getFlowDefinition(fid);
        defaults.flows[fid] = {
          active: fid === (deps.defaultFlowId || ''),
          selectedTargetId: (def && def.defaultTargetId) || '',
          targets: {},
          autoRun: {},
        };

        var targets = getTargetDefinitions(fid);
        var targetIds = Object.keys(targets);
        for (var j = 0; j < targetIds.length; j++) {
          var tid = targetIds[j];
          defaults.flows[fid].targets[tid] = (targets[tid].defaultSettings) ? deepMerge({}, targets[tid].defaultSettings) : {};
        }
      }

      return defaults;
    }

    // 规范化设置，填充默认值
    function normalize(raw) {
      var defaults = buildDefaults();
      return deepMerge(defaults, raw || {});
    }

    // 从设置中提取当前 flow 的输入状态（供节点使用）
    function getFlowInput(settings, flowId) {
      var flows = settings.flows || {};
      var flowSettings = flows[flowId] || {};
      var targetId = flowSettings.selectedTargetId || '';
      var targetSettings = (flowSettings.targets || {})[targetId] || {};
      return {
        flowId: flowId,
        targetId: targetId,
        settings: flowSettings,
        targetSettings: targetSettings,
        autoRun: flowSettings.autoRun || {},
      };
    }

    // 按 scope 投射设置视图（供 sidepanel 渲染）
    function buildView(settings) {
      var flowIds = getRegisteredFlowIds();
      var view = {};
      for (var i = 0; i < flowIds.length; i++) {
        var fid = flowIds[i];
        var fs = (settings.flows || {})[fid] || {};
        view[fid] = {
          active: fs.active,
          selectedTargetId: fs.selectedTargetId,
          autoRun: (settings.services || {}).autoRun || {},
        };
      }
      return view;
    }

    return {
      buildDefaults: buildDefaults,
      normalize: normalize,
      getFlowInput: getFlowInput,
      buildView: buildView,
    };
  }

  return { createSettingsSchema: createSettingsSchema };
});
