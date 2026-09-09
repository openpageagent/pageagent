// Dynamic Flow Builder — 将用户配置（storage.local）翻译为运行时注册
// pages → Source 注册；flows → Flow/Workflow 注册（节点 execute 统一委托 NodeExecutor）
(function attachDynamicFlowBuilder(root, factory) {
  root.DynamicFlowBuilder = factory();
})(globalThis, function () {

  var USER_FLOW_PREFIX = 'user:';
  var PAGE_ENGINE_DRIVER_ID = 'page-automation-engine';
  var LEGACY_PAGE_SCRIPT_PREFIX = 'pfa-page-driver-';
  var NET_SCRIPT_PREFIX = 'pfa-net-';
  var STEALTH_SCRIPT_PREFIX = 'pfa-stealth-';

  function createDynamicFlowBuilder(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var flowIndex = deps.flowIndex;
    var flowRegistry = deps.flowRegistry;
    var registerSource = deps.registerSource || (function () {});
    var unregisterSource = deps.unregisterSource || (function () {});
    var registerDriver = deps.registerDriver || (function () {});
    var nodeExecutor = deps.nodeExecutor;
    var addLog = deps.addLog || (function () {});
    var rebuildStepRegistry = deps.rebuildStepRegistry || (function () {});
    var registeredPageSourceIds = [];

    // --- 页面 → Source ---

    function collectHostnames(page) {
      var hostnames = [];
      try {
        var host = new URL(page.url).hostname;
        if (host) hostnames.push(host);
      } catch (_) {}
      var raw = page.matchers && page.matchers.hostnames;
      if (typeof raw === 'string') raw = raw.split(/[,\n]/);
      if (Array.isArray(raw)) {
        for (var i = 0; i < raw.length; i++) {
          var h = String(raw[i]).trim();
          if (h && hostnames.indexOf(h) === -1) hostnames.push(h);
        }
      }
      return hostnames;
    }

    function buildMatchers(page) {
      var matchers = [];
      var hostnames = collectHostnames(page);
      if (hostnames.length) matchers.push({ hostnames: hostnames });
      var urlIncludes = page.matchers && page.matchers.urlIncludes;
      if (urlIncludes) {
        var includes = (typeof urlIncludes === 'string') ? [urlIncludes] : urlIncludes;
        matchers.push({ urlIncludes: includes });
      }
      return matchers;
    }

    function registerPages(config) {
      for (var r = 0; r < registeredPageSourceIds.length; r++) {
        unregisterSource(registeredPageSourceIds[r]);
      }
      registeredPageSourceIds = [];

      registerDriver(PAGE_ENGINE_DRIVER_ID, {
        sourceId: '*',
        commands: ['navigate', 'reload', 'activateTab', 'closeTab', 'waitForPageLoad',
          'pageAction', 'click', 'fill', 'selectOption', 'fillFormFields', 'select', 'check', 'hover', 'keyPress', 'scroll', 'scrollInfo', 'dragDrop', 'uploadFile', 'handleDialog',
          'waitForCondition', 'waitFor', 'extractText', 'extractTable', 'extractList', 'extractScrollingList', 'elementInfo',
          'inspectStructure', 'inspectElement', 'inspectText', 'inspectHtml', 'inspectCss', 'inspectJavascript', 'searchPage',
          'getCurrentTab', 'getRequests', 'getSseEvents', 'clearNetworkCapture', 'replayRequest', 'webStorage',
          'runtimeModuleAction',
          'assertElement', 'assertText', 'assertAttribute', 'assertValue', 'assertUrl', 'screenshot', 'media',
          'evaluate', 'executePageJavascript', 'patchPage', 'callPageFunction', 'cdp.screenshot', 'cdp.inspect_dom_snapshot',
          'cdp.inspect_ax_tree', 'cdp.inspect_network', 'cdp.analyze_performance', 'cdp.replay_request'],
      });

      var pageIds = Object.keys(config.pages || {});
      for (var i = 0; i < pageIds.length; i++) {
        var page = config.pages[pageIds[i]];
        var matchers = buildMatchers(page);
        var sourceId = 'page:' + page.id;
        registerSource(sourceId, {
          kind: 'user-page',
          label: page.label || page.url,
          driverId: PAGE_ENGINE_DRIVER_ID,
          detectionMatchers: matchers,
          familyMatchers: matchers,
        });
        registeredPageSourceIds.push(sourceId);
      }
      return pageIds.length;
    }

    // --- 流程 → Flow/Workflow ---

    function sortByDisplayOrder(nodes) {
      return (nodes || []).slice().sort(function (a, b) {
        return (a.displayOrder || 0) - (b.displayOrder || 0);
      });
    }

    function buildWorkflowNodes(flowCfg, config) {
      var nodes = sortByDisplayOrder(flowCfg.nodes).map(function (n) {
        return JSON.parse(JSON.stringify(n));
      });
      var usedNodeIds = Object.create(null);
      return nodes.map(function (inst, index) {
        var baseNodeId = String(inst.nodeId || inst.id || ('n_runtime_' + (index + 1))).trim();
        if (!baseNodeId) baseNodeId = 'n_runtime_' + (index + 1);
        var nodeId = baseNodeId;
        var suffix = 2;
        while (usedNodeIds[nodeId]) nodeId = baseNodeId + '_' + suffix++;
        usedNodeIds[nodeId] = true;
        inst.nodeId = nodeId;
        delete inst.id;
        if (!inst.params || typeof inst.params !== 'object' || Array.isArray(inst.params)) inst.params = {};
        var definition = globalThis.NodeTypes && typeof globalThis.NodeTypes.getType === 'function'
          ? globalThis.NodeTypes.getType(inst.type)
          : null;
        (definition && Array.isArray(definition.params) ? definition.params : []).forEach(function (param) {
          var key = param && param.key;
          if (!key || inst.params[key] !== undefined || inst[key] === undefined) return;
          inst.params[key] = inst[key];
          delete inst[key];
        });
        return {
          nodeId: nodeId,
          type: inst.type,
          params: inst.params,
          pageId: inst.pageId || '',
          outputVar: inst.outputVar || '',
          onFailure: inst.onFailure,
          retries: inst.retries,
          retryDelayMs: inst.retryDelayMs,
          requiresForeground: inst.requiresForeground === true,
          foreground: inst.foreground === true,
          reveal: inst.reveal === true,
          displayOrder: index + 1,
          title: inst.title || (globalThis.NodeTypes ? globalThis.NodeTypes.getTypeLabel(inst.type) : inst.type),
          execute: function (state) {
            return nodeExecutor.executeNodeInstance(inst, state);
          },
        };
      });
    }

    function registerFlows(config) {
      // 先注销旧的用户流程（FlowIndex 与 flowRegistry 实例都要同步）
      var existing = Object.keys(flowIndex.getFlowDefinitions());
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].indexOf(USER_FLOW_PREFIX) === 0) {
          flowIndex.unregisterFlow(existing[i]);
          if (flowRegistry) flowRegistry.unregisterFlow(existing[i]);
        }
      }

      var flowIds = Object.keys(config.flows || {});
      for (var j = 0; j < flowIds.length; j++) {
        var flowCfg = config.flows[flowIds[j]];
        var wfNodes = buildWorkflowNodes(flowCfg, config);
        var registeredId = USER_FLOW_PREFIX + flowCfg.id;
        var definition = flowIndex.registerFlow({
          id: registeredId,
          label: flowCfg.label || flowCfg.id,
          description: flowCfg.description || '',
          inputDescription: flowCfg.inputDescription || '',
          outputDescription: flowCfg.outputDescription || '',
          inputExample: flowCfg.inputExample || '',
          targets: { 'default': { id: 'default', label: '默认目标' } },
          defaultTargetId: 'default',
          workflow: { nodes: wfNodes, nodeIds: wfNodes.map(function (n) { return n.nodeId; }) },
          contentScripts: [],
        });
        if (flowRegistry) flowRegistry.registerFlow(registeredId, definition);
      }
      return flowIds.length;
    }

    // --- 网络捕获脚本注册（MAIN world, document_start） ---

    function buildMatchPatterns(page) {
      var patterns = [];
      var hostnames = collectHostnames(page);
      for (var i = 0; i < hostnames.length; i++) {
        patterns.push('*://' + hostnames[i] + '/*');
      }
      return patterns;
    }

    function removeLegacyPageScripts() {
      if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) {
        return Promise.resolve();
      }
      return chrome.scripting.getRegisteredContentScripts().then(function (registered) {
        var staleIds = registered
          .map(function (s) { return s.id; })
          .filter(function (id) { return id.indexOf(LEGACY_PAGE_SCRIPT_PREFIX) === 0; });
        return staleIds.length
          ? chrome.scripting.unregisterContentScripts({ ids: staleIds })
          : Promise.resolve();
      }).catch(function (err) {
        addLog('移除旧页面脚本注册失败: ' + err.message, { level: 'warn' });
      });
    }

    function syncNetCapture(config) {
      if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) {
        return Promise.resolve();
      }
      return chrome.scripting.getRegisteredContentScripts().then(function (registered) {
        var staleIds = registered
          .map(function (s) { return s.id; })
          .filter(function (id) { return id.indexOf(NET_SCRIPT_PREFIX) === 0; });

        var unregister = staleIds.length
          ? chrome.scripting.unregisterContentScripts({ ids: staleIds })
          : Promise.resolve();

        return unregister.then(function () {
          var pageIds = Object.keys(config.pages || {});
          var registrations = [];
          for (var i = 0; i < pageIds.length; i++) {
            var page = config.pages[pageIds[i]];
            if (!page.captureNetwork) continue;
            var matches = buildMatchPatterns(page);
            if (!matches.length) continue;
            registrations.push({
              id: NET_SCRIPT_PREFIX + page.id,
              matches: matches,
              js: ['content/net-capture-main.js'],
              world: 'MAIN',
              runAt: 'document_start',
              persistAcrossSessions: true,
            });
          }
          if (!registrations.length) return;
          return chrome.scripting.registerContentScripts(registrations).catch(function (err) {
            addLog('注册网络捕获脚本失败: ' + err.message, { level: 'warn' });
          });
        });
      }).catch(function (err) {
        addLog('同步网络捕获脚本失败: ' + err.message, { level: 'warn' });
      });
    }

    function syncStealthScripts(config) {
      if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) {
        return Promise.resolve();
      }
      return chrome.scripting.getRegisteredContentScripts().then(function (registered) {
        var staleIds = registered
          .map(function (s) { return s.id; })
          .filter(function (id) { return id.indexOf(STEALTH_SCRIPT_PREFIX) === 0; });

        var unregister = staleIds.length
          ? chrome.scripting.unregisterContentScripts({ ids: staleIds })
          : Promise.resolve();

        return unregister.then(function () {
          var pageIds = Object.keys(config.pages || {});
          var registrations = [];
          for (var i = 0; i < pageIds.length; i++) {
            var page = config.pages[pageIds[i]];
            if (!page.stealthMode) continue;
            var matches = buildMatchPatterns(page);
            if (!matches.length) continue;
            registrations.push({
              id: STEALTH_SCRIPT_PREFIX + page.id,
              matches: matches,
              js: ['content/stealth-main.js'],
              world: 'MAIN',
              runAt: 'document_start',
              persistAcrossSessions: true,
            });
          }
          if (!registrations.length) return;
          return chrome.scripting.registerContentScripts(registrations).catch(function (err) {
            addLog('注册页面环境补丁失败: ' + err.message, { level: 'warn' });
          });
        });
      }).catch(function (err) {
        addLog('同步页面环境补丁失败: ' + err.message, { level: 'warn' });
      });
    }

    // --- 总入口 ---

    function reload(config) {
      var pageCount = registerPages(config);
      var flowCount = registerFlows(config);
      rebuildStepRegistry();
      addLog('动态配置已加载: ' + pageCount + ' 个页面, ' + flowCount + ' 个流程');
      return removeLegacyPageScripts().then(function () {
        return syncNetCapture(config);
      }).then(function () {
        return syncStealthScripts(config);
      });
    }

    return {
      USER_FLOW_PREFIX: USER_FLOW_PREFIX,
      reload: reload,
      removeLegacyPageScripts: removeLegacyPageScripts,
      syncNetCapture: syncNetCapture,
      syncStealthScripts: syncStealthScripts,
    };
  }

  return { createDynamicFlowBuilder: createDynamicFlowBuilder };
});
