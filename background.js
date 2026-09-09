// background.js — Service Worker: 模块组装、状态管理、消息路由
(function () {
  'use strict';

  // --- 导入核心模块 ---
  importScripts(
    'agent/conversation-protocol.js',
    'shared/recording-contract.js',
    'ui/session-floating-message-contract.js',
    'ui/page-conversation-message-contract.js',
    'background/floating-conversation-wiring.js',
    'background/page-conversation-wiring.js',
    'shared/utils.js',
    'shared/sync-event-stream.js',
    'shared/page-data-contract.js',
    'shared/page-fact-contract.js',
    'shared/page-javascript-contract.js',
    'shared/page-action-contract.js',
    'shared/page-verification-contract.js',
    'shared/page-engine-version.js',
    'flows/runtime-state.js',
    'flows/source-registry.js',
    'flows/flow-registry.js',
    'flows/flow-engine.js',
    'flows/step-registry.js',
    'flows/tab-runtime.js',
    'flows/flow-capabilities.js',
    'settings/settings-schema.js',
    'settings/model-settings.js',
    'settings/system-settings.js',
    'agent/providers/provider-utils.js',
    'agent/providers/provider-sse.js',
    'agent/providers/browser-provider-transport.js',
    'agent/providers/compat/index.js',
    'agent/tool-result-projection.js',
    'ui/conversation-list-view.js',
    'agent/providers/provider-message-normalizer.js',
    'agent/providers/openai-chat-completions-provider.js',
    'agent/providers/openai-responses-provider.js',
    'agent/providers/anthropic-messages-provider.js',
    'flows/logging-status.js',
    'flows/node-types.js',
    'resources/mcp-tool-contract.js',
    'resources/protocol/index.js',
    'resources/resource-contract.js',
    'resources/resource-uri.js',
    'resources/resource-errors.js',
    'resources/resource-permissions.js',
    'resources/resource-idempotency.js',
    'resources/introspection-runtime.js',
    'resources/resource-router.js',
    'knowledge/knowledge-search.js',
    'knowledge/knowledge-store.js',
    'knowledge/knowledge-lifecycle.js',
    'knowledge/knowledge-builtins.js',
    'knowledge/knowledge.js',
    'knowledge/skill-knowledge.js',
    'flows/template.js',
    'flows/expression.js',
    'flows/flow-data.js',
    'flows/media-resources.js',
    'dependencies/croner/croner.umd.js',
    'options/conversation-profile-schema.js',
    'options/conversation-assistant-state-runtime.js',
    'options/conversation-state.js',
    'background/navigation-utils.js',
    'background/run-report.js',
    'background/config-store.js',
    'background/builtin-flow-loader.js',
    'background/builtin-skill-loader.js',
    'background/model-client.js',
    'background/http-mcp-client.js',
    'ui/zip-store.js',
    'background/image-artifact-store.js',
    'background/recording-artifact-store.js',
    'background/recording-compiler.js',
    'background/recording-artifact-projector.js',
    'background/conversation-recording-coordinator.js',
    'background/conversation-recording-attachments.js',
    'background/conversation-journal-materializer.js',
    'background/agent-page-service.js',
    'background/proxy-manager.js',
    'background/cdp-client.js',
    'background/cdp-session-manager.js',
    'background/page-perception-engine.js',
    'background/native-file-materializer.js',
    'background/page-verification-engine.js',
    'background/page-readiness-barrier.js',
    'background/page-standard-actions.js',
    'background/page-action-engine.js',
    'background/page-network-fact-provider.js',
    'background/page-automation-runtime.js',
    'background/page-resource-cache.js',
    'background/cdp-tools.js',
    'background/page-readiness.js',
    'background/page-keepalive.js',
    'background/mcp-tab-access.js',
    'background/session-tab-access.js',
    'background/action-indicator.js',
    'background/mcp-runtime.js',
    'background/node-http.js',
    'background/node-random-data.js',
    'background/node-file-ops.js',
    'background/node-browser-ops.js',
    'background/node-visual.js',
    'background/node-model.js',
    'background/node-data-ops.js',
    'background/node-page-lifecycle-ops.js',
    'background/node-page-evaluate-ops.js',
    'background/node-assertion-ops.js',
    'background/node-script-ops.js',
    'background/node-execution-contract.js',
    'background/assistant-orchestrator.js',
    'background/node-dispatcher.js',
    'background/node-executor.js',
    'background/sandbox-engine.js',
    'background/dynamic-flow-builder.js',
    'background/scheduler.js',
    'background/config-runtime-coordinator.js',
    'background/url-trigger-controller.js',
    'background/run-session-registry.js',
    'background/run-command-service.js',
    'background/run-query-service.js',
    'background/flow-group-controller.js',
    'background/message-router.js',
    'background/auto-run-controller.js',
    'background/run-session.js',
    'background/websocket-client.js',
    'resources/services/resource-service.js',
    'resources/services/recording-resource-service.js',
    'resources/services/agent-configuration-resource-service.js',
    'resources/services/mcp-resource-service.js',
    'resources/resource-module-adapter.js',
    'resources/resource-module-support.js',
    'resources/modules/flow-resource.js',
    'resources/modules/node-type-resource.js',
    'resources/modules/flow-group-resource.js',
    'resources/modules/conversation-resource.js',
    'resources/modules/recording-resource.js',
    'resources/modules/page-source-resource.js',
    'resources/modules/url-trigger-resource.js',
    'resources/modules/script-resource.js',
    'resources/modules/config-resource.js',
    'resources/modules/skill-resource.js',
    'resources/modules/run-resource.js',
    'resources/modules/schedule-resource.js',
    'resources/modules/knowledge-resource.js',
    'resources/modules/agent-configuration-resource.js',
    'resources/modules/connection-resource.js',
    'resources/modules/mcp-resource.js',
    'resources/adapters/page-resource-adapter.js',
    'resources/adapters/image-artifact-resource-adapter.js',
    'resources/adapters/browser-resource-adapter.js',
    'resources/adapters/current-resource-adapter.js',
    'agent/capability-policy.js',
    'agent/agent-prompt.js',
    'agent/agent-provider.js',
    'agent/conversation-summary.js',
    'agent/context-builder.js',
    'agent/agent-loop.js',
    'agent/agent-resource-router.js',
    'agent/agent-core.js',
    'agent/conversation-runtime.js',
    'agent/turn-coordinator.js',
    'background/conversation-journal-store.js',
    'background/conversation-journal-migration.js',
    'background/conversation-command-bus.js',
    'background/conversation-recovery.js',
    'agent/agent-bootstrap.js',
    'flows/index.js'
  );
  var SessionFloatingMessages = globalThis.PageAutomationSessionFloatingMessageContract;
  if (!SessionFloatingMessages || SessionFloatingMessages.API_VERSION !== 1) throw new Error('session/floating message contract 未加载');
  var PageConversationMessages = globalThis.PageAutomationPageConversationMessages;
  if (!PageConversationMessages || PageConversationMessages.API_VERSION !== 1) throw new Error('page conversation message contract 未加载');
  if (!globalThis.FloatingConversationWiring || globalThis.FloatingConversationWiring.API_VERSION !== 1
      || typeof globalThis.FloatingConversationWiring.create !== 'function') throw new Error('FloatingConversationWiring 未加载');
  if (!globalThis.PageConversationWiring || globalThis.PageConversationWiring.API_VERSION !== 1
      || typeof globalThis.PageConversationWiring.create !== 'function') throw new Error('PageConversationWiring 未加载');

  if (!globalThis.UrlTriggerController
      || typeof globalThis.UrlTriggerController.createUrlTriggerController !== 'function') {
    throw new Error('UrlTriggerController must load before background.js');
  }
  if (!globalThis.RunCommandService
      || typeof globalThis.RunCommandService.createRunCommandService !== 'function') {
    throw new Error('RunCommandService must load before background.js');
  }

  // --- 常量 ---
  var INCOGNITO_CONTEXT = !!(chrome.extension && chrome.extension.inIncognitoContext);
  var RUNTIME_SCOPE = INCOGNITO_CONTEXT ? 'incognito' : 'regular';
  var STORAGE_KEY = INCOGNITO_CONTEXT ? 'automation_state_incognito' : 'automation_state';
  var SW_KEEPALIVE_ALARM_NAME = 'sw_keepalive:' + RUNTIME_SCOPE;
  var LOG_PREFIX = '[Automation]';

  // --- 运行时状态缓存 ---
  var stateCache = null;

  function getState() {
    return stateCache || RuntimeState.DEFAULT_STATE;
  }

  function setState(patch) {
    var rt = RuntimeState.createRuntimeState();
    var current = getState();
    var merged = CoreUtils.deepMerge(current, patch);
    // 规范化 sharedState
    if (patch.sharedState) {
      merged.sharedState = CoreUtils.deepMerge(current.sharedState || {}, patch.sharedState);
    }
    stateCache = merged;
    persistState(merged);
    broadcastState(merged);
  }

  function persistState(state) {
    try {
      var rt = RuntimeState.createRuntimeState();
      var persistent = rt.buildPersistentPatch(state);
      chrome.storage.session.set({ [STORAGE_KEY]: persistent });
    } catch (_) {}
  }

  function broadcastState(state) {
    try {
      chrome.runtime.sendMessage({ type: 'STATE_UPDATE', payload: state }).catch(function () {});
    } catch (_) {}
  }

  function broadcast(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(function () {});
    } catch (_) {}
  }

  var syncEventStream = globalThis.PageAutomationSyncEventStream
    && globalThis.PageAutomationSyncEventStream.create
    ? globalThis.PageAutomationSyncEventStream.create({ runtime: chrome.runtime })
    : null;

  function publishSyncEvent(event) {
    if (!syncEventStream) return null;
    event = Object.assign({}, event || {});
    if (event.scope === 'runtime' && !event.runtime) event.runtime = RUNTIME_SCOPE;
    var published = syncEventStream.publish(event);
    if (!published) return null;
    try {
      chrome.tabs.query({}, function (tabs) {
        if (chrome.runtime.lastError) return;
        (tabs || []).forEach(function (tab) {
          if (!(Number(tab && tab.id) > 0)) return;
          try {
            chrome.tabs.sendMessage(Number(tab.id), { type: 'SYNC_EVENT', event: published }, function () {
              void chrome.runtime.lastError;
            });
          } catch (_) {}
        });
      });
    } catch (_) {}
    return published;
  }

  function broadcastToPageContent(msg) {
    broadcast(msg);
    try {
      chrome.tabs.query({}, function (tabs) {
        if (chrome.runtime.lastError) return;
        (tabs || []).forEach(function (tab) {
          if (!(Number(tab && tab.id) > 0)) return;
          try {
            chrome.tabs.sendMessage(Number(tab.id), msg, function () { void chrome.runtime.lastError; });
          } catch (_) {}
        });
      });
    } catch (_) {}
  }

  var PAGE_CONVERSATION_VISIBILITY_KEY_PREFIX = 'page_conversation_visible_origin_';
  var pageConversationVisibilityWrites = Object.create(null);

  function pageConversationVisibilitySite(sender) {
    var tabUrl = String(sender && sender.tab && sender.tab.url || '').trim();
    var parsed;
    try { parsed = new URL(tabUrl); } catch (_) {}
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error('无法识别当前站点');
    }
    return parsed.origin;
  }

  function pageConversationVisibilityStorageKey(site) {
    return PAGE_CONVERSATION_VISIBILITY_KEY_PREFIX + encodeURIComponent(String(site || ''));
  }

  function invokePageConversationVisibilityStorage(method, value) {
    var storage = chrome.storage && chrome.storage.local;
    if (!storage || typeof storage[method] !== 'function') {
      return Promise.reject(new Error('页面对话显示状态存储不可用'));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(error, result) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      }
      function callback(result) {
        var runtimeError = null;
        try { runtimeError = chrome.runtime && chrome.runtime.lastError; } catch (error) { runtimeError = error; }
        finish(runtimeError ? new Error(runtimeError.message || String(runtimeError)) : null, result);
      }
      try {
        var returned = storage[method](value, callback);
        if (returned && typeof returned.then === 'function') returned.then(function (result) {
          finish(null, result);
        }, function (error) {
          finish(error);
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  function getPageConversationVisibility(site) {
    var key = pageConversationVisibilityStorageKey(site);
    var pending = pageConversationVisibilityWrites[key] || Promise.resolve();
    return pending.catch(function () {}).then(function () {
      return invokePageConversationVisibilityStorage('get', key);
    }).then(function (result) {
      return !!(result && result[key] === true);
    });
  }

  function setPageConversationVisibility(site, open) {
    var key = pageConversationVisibilityStorageKey(site);
    var previous = pageConversationVisibilityWrites[key] || Promise.resolve();
    var operation = previous.catch(function () {}).then(function () {
      if (!open) return invokePageConversationVisibilityStorage('remove', key);
      var patch = {};
      patch[key] = true;
      return invokePageConversationVisibilityStorage('set', patch);
    }).then(function () {
      return open === true;
    });
    pageConversationVisibilityWrites[key] = operation;
    operation.finally(function () {
      if (pageConversationVisibilityWrites[key] === operation) delete pageConversationVisibilityWrites[key];
    }).catch(function () {});
    return operation;
  }

  // --- 恢复持久化状态 ---
  function restoreState() {
    chrome.storage.session.get(STORAGE_KEY, function (result) {
      var persisted = result[STORAGE_KEY] || {};
      var rt = RuntimeState.createRuntimeState();
      stateCache = rt.ensureState(persisted);
      stateCache.sharedState = stateCache.sharedState || {};
      broadcastState(stateCache);
    });
  }

  // --- 初始化模块 ---

  // Flow Registry (从 flows/index.js 获取定义)
  var flowRegistry = FlowRegistry.createFlowRegistry({
    flowDefinitions: (typeof FlowIndex !== 'undefined' && FlowIndex.getFlowDefinitions)
      ? FlowIndex.getFlowDefinitions() : {},
    defaultFlowId: (typeof FlowIndex !== 'undefined' && FlowIndex.getDefaultFlowId)
      ? FlowIndex.getDefaultFlowId() : '',
  });

  // Source Registry
  var sourceRegistry = SourceRegistry.createSourceRegistry({
    sourceDefinitions: flowRegistry.getAllRuntimeSources(),
    driverDefinitions: flowRegistry.getAllDriverDefinitions(),
  });

  // Flow Engine
  var flowEngine = FlowEngine.createFlowEngine({
    getWorkflowDefinitions: function () {
      return (typeof FlowIndex !== 'undefined' && FlowIndex.getWorkflowDefinitions)
        ? FlowIndex.getWorkflowDefinitions() : {};
    },
  });

  // Logging & Status
  var loggingStatus = LoggingStatus.createLoggingStatus({
    getState: getState,
    setState: setState,
    broadcast: broadcast,
    getSourceLabel: function (s) { return sourceRegistry.getSourceLabel(s); },
    getNodeTitle: function (f, n) { return flowEngine.getNodeTitle(f, n); },
    isNodeDoneStatus: function (s) { return flowEngine.isNodeDoneStatus(s); },
  });

  // Tab Runtime
  var tabRuntime = TabRuntime.createTabRuntime({
    chrome: chrome,
    storage: chrome.storage.local,
    storageKey: globalThis.ConversationState.STORAGE_KEY,
    getState: getState,
    setState: setState,
    addLog: loggingStatus.addLog,
    getSourceLabel: function (s) { return sourceRegistry.getSourceLabel(s); },
    resolveCanonicalSource: function (s) { return sourceRegistry.resolveCanonicalSource(s); },
    getDriverIdForSource: function (s) { return sourceRegistry.getDriverIdForSource(s); },
    matchesSourceUrlFamily: function (s, url) { return sourceRegistry.matchesSourceUrlFamily(s, url); },
    isRetryableTransportError: function (e) { return loggingStatus.isRetryableTransportError(e); },
    getPageAutomation: function () { return pageAutomation; },
  });
  var cdpClient = CdpClient.createCdpClient({ chrome: chrome });
  var cdpSessionManager = CdpSessionManager.createCdpSessionManager({ chrome: chrome, cdpClient: cdpClient });
  var pageNetworkFactProvider = PageNetworkFactProvider.createPageNetworkFactProvider({ chrome: chrome });
  var pagePerceptionEngine = PagePerceptionEngine.createPagePerceptionEngine({
    chrome: chrome,
    cdpSessionManager: cdpSessionManager,
    networkFactProvider: pageNetworkFactProvider,
  });
  var nativeFileMaterializer = NativeFileMaterializer.createNativeFileMaterializer({ chrome: chrome });
  if (chrome.runtime && chrome.runtime.onSuspend) {
    chrome.runtime.onSuspend.addListener(function () { nativeFileMaterializer.cleanupAll().catch(function () {}); });
  }
  var pageVerificationEngine = PageVerificationEngine.createPageVerificationEngine({
    pagePerceptionEngine: pagePerceptionEngine,
  });
  // State-change readiness barrier: fed by chrome.debugger Network events,
  // consumed by Flow page actions (PageActionEngine) and navigation waits
  // (PageAutomationRuntime.waitForReadiness via NodePageLifecycleOps).
  var pageReadinessBarrier = PageReadinessBarrier.createPageReadinessBarrier({
    cdpSessionManager: cdpSessionManager,
    pageVerificationEngine: pageVerificationEngine,
    addLog: function (message, logOptions) { return loggingStatus.addLog(message, logOptions); },
  });
  var pageActionEngine = PageActionEngine.createPageActionEngine({
    chrome: chrome,
    cdpSessionManager: cdpSessionManager,
    pagePerceptionEngine: pagePerceptionEngine,
    pageVerificationEngine: pageVerificationEngine,
    nativeFileMaterializer: nativeFileMaterializer,
    readinessBarrier: pageReadinessBarrier,
  });
  var pageAutomation = PageAutomationRuntime.createPageAutomationRuntime({
    pagePerceptionEngine: pagePerceptionEngine,
    pageActionEngine: pageActionEngine,
    pageVerificationEngine: pageVerificationEngine,
    pageReadinessBarrier: pageReadinessBarrier,
  });
  var pageResourceCache = PageResourceCache.createReader({ cdpSessionManager: cdpSessionManager });
  pageAutomation.perception.registerEvidenceProvider('page-resource-cache', pageResourceCache);
  var pageReadiness;
  var actionIndicator;

  // Settings Schema
  var settingsSchema = SettingsSchema.createSettingsSchema({
    getRegisteredFlowIds: function () { return flowRegistry.getRegisteredFlowIds(); },
    getFlowDefinition: function (f) { return flowRegistry.getFlowDefinition(f); },
    getTargetDefinitions: function (f) { return flowRegistry.getTargetDefinitions(f); },
    defaultFlowId: flowRegistry.getDefaultFlowId(),
  });

  // Flow Capabilities
  var flowCapabilities = FlowCapabilities.createFlowCapabilities({
    getRegisteredFlowIds: function () { return flowRegistry.getRegisteredFlowIds(); },
    getFlowDefinition: function (f) { return flowRegistry.getFlowDefinition(f); },
    getFlowCapabilities: function (f) { return flowRegistry.getFlowCapabilities(f); },
    getTargetDefinition: function (f, t) { return flowRegistry.getTargetDefinition(f, t); },
  });

  // Step Registry — 从 FlowIndex 获取节点定义
  var stepRegistry;
  function buildStepRegistry() {
    var defs = [];
    if (typeof FlowIndex !== 'undefined' && FlowIndex.getAllNodeDefinitions) {
      defs = FlowIndex.getAllNodeDefinitions();
    }
    // 注入 tab runtime 到每个节点的 execute 上下文
    defs = defs.map(function (d) {
      if (d.execute) {
        var origExecute = d.execute;
        d.execute = function (state) {
          return origExecute(state, { tabRuntime: tabRuntime, log: loggingStatus.addLog, getState: getState });
        };
      }
      return d;
    });
    stepRegistry = StepRegistry.createStepRegistry(defs);
  }

  // 执行节点的包装函数（供 message router 和 auto run 使用）
  function executeNode(nodeId, state) {
    if (!stepRegistry) buildStepRegistry();
    return stepRegistry.executeNode(nodeId, state);
  }

  // --- 用户配置层（配置存储 / 节点执行器 / 沙箱引擎 / 动态注册 / 调度器） ---

  var autoRunController; // 前置声明（nodeExecutor 需要懒引用）
  var sandboxEngine;
  var assistantOrchestrator;

  // Config Store
  var configStore = ConfigStore.createConfigStore({
    chrome: chrome,
    runReport: RunReport,
    incognito: INCOGNITO_CONTEXT,
  });
  var configCache = { version: 1, pages: {}, flows: {}, flowGroups: {}, scripts: {}, schedules: {}, urlTriggers: [] };
  var runInputCache = {};
  var builtinFlowLoader = BuiltinFlowLoader.createBuiltinFlowLoader({
    chrome: chrome,
    addLog: loggingStatus.addLog,
  });

  function cloneConfigValue(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function stripRuntimeMetadata(value) {
    if (Array.isArray(value)) {
      return value.map(stripRuntimeMetadata);
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) {
        if (key.indexOf('__builtin') === 0) return;
        if (key === 'mcpValidation') return;
        out[key] = stripRuntimeMetadata(value[key]);
      });
      return out;
    }
    return value;
  }

  function isRuntimeBuiltin(section, id) {
    var item = configCache && configCache[section] && configCache[section][id];
    return !!(item && item.__builtin);
  }

  function sanitizeConfigForStorage(rawConfig) {
    rawConfig = rawConfig || {};
    var config = configStore.ensureConfig(stripRuntimeMetadata(rawConfig));
    ['pages', 'flows', 'flowGroups', 'scripts'].forEach(function (section) {
      var rawSection = rawConfig[section] || {};
      Object.keys(rawSection).forEach(function (id) {
        if ((rawSection[id] && rawSection[id].__builtin) || isRuntimeBuiltin(section, id)) delete config[section][id];
      });
    });
    return config;
  }

  function sanitizeMutationPayload(payload) {
    var next = Object.assign({}, payload || {});
    if (next.op === 'upsert') next.item = stripRuntimeMetadata(next.item);
    return next;
  }

  function assertMutableConfigTarget(payload) {
    payload = payload || {};
    if (['pages', 'flows', 'flowGroups', 'scripts'].indexOf(payload.section) === -1) return;
    var id = payload.op === 'delete'
      ? payload.id
      : (payload.item && payload.item.id);
    if (!id || !isRuntimeBuiltin(payload.section, id)) return;
    var labels = { pages: '页面', flows: '流程', flowGroups: '流程组', scripts: '脚本' };
    throw new Error('内置' + (labels[payload.section] || '配置') + '不能修改，请先复制后编辑');
  }

  // Model Client — 请求模型节点与脚本 model.chat 共用
  var modelClient = ModelClient.createModelClient({ chrome: chrome, addLog: loggingStatus.addLog });

  var proxyManager = ProxyManager.createProxyManager({
    chrome: chrome,
    addLog: loggingStatus.addLog,
    incognito: INCOGNITO_CONTEXT,
  });

  // Node Executor — 声明式节点的通用执行器，兼任脚本 API 桥后端
  var nodeExecutor = NodeExecutor.createNodeExecutor({
    chrome: chrome,
    tabRuntime: tabRuntime,
    pageAutomation: pageAutomation,
    addLog: loggingStatus.addLog,
    getConfig: function () { return configCache; },
    pageHostMatchesTab: pageHostMatchesTab,
    getRunHistory: function () { return configStore.getRuns(); },
    getSandboxEngine: function () { return sandboxEngine; },
    proxyManager: proxyManager,
    modelClient: modelClient,
    getAssistantOrchestrator: function () { return assistantOrchestrator; },
    runtimeScope: RUNTIME_SCOPE,
    // 停止标志仅在流程运行中生效，避免上次停止的残留标志阻断脚本测试/手动执行
    throwIfStopped: function () {
      if (autoRunController && autoRunController.isRunning()) autoRunController.throwIfStopped();
    },
    sleep: CoreUtils.sleep,
  });

  // Sandbox Engine — 用户脚本执行
  sandboxEngine = SandboxEngine.createSandboxEngine({
    chrome: chrome,
    addLog: loggingStatus.addLog,
    executeApiCall: nodeExecutor.executeApiCall,
  });

  // Dynamic Flow Builder — 用户配置 → 运行时注册
  var dynamicFlowBuilder = DynamicFlowBuilder.createDynamicFlowBuilder({
    chrome: chrome,
    flowIndex: FlowIndex,
    flowRegistry: flowRegistry,
    registerSource: sourceRegistry.registerSource,
    unregisterSource: sourceRegistry.unregisterSource,
    registerDriver: sourceRegistry.registerDriver,
    nodeExecutor: nodeExecutor,
    addLog: loggingStatus.addLog,
    rebuildStepRegistry: function () { buildStepRegistry(); },
  });

  // --- 运行历史记录 ---

  var pendingRunTrigger = 'manual';
  var currentRunStartedAt = 0;
  var legacyRunBoundTabId = 0;
  var legacyRunStatus = '';
  var legacyRunFlowLabel = '';
  var legacyRunReportPromise = Promise.resolve({ ok: true });
  // 失败诊断截图也只通过统一感知引擎采集，不抢占用户窗口焦点。
  function captureTabScreenshot(tabId, quality) {
    return pageAutomation.captureScreenshot(tabId, { format: 'jpeg', quality: quality }).then(function (capture) {
      return capture.dataUrl;
    });
  }

  // 失败截图：聚焦目标 tab 后截取可视区域（失败仅记 warn，不阻塞流程）
  function captureFailureScreenshot(node) {
    if (!node || !node.pageId) return Promise.resolve('');
    var tabId = tabRuntime.getTabId('page:' + node.pageId);
    if (!tabId) return Promise.resolve('');
    return captureTabScreenshot(tabId, 55).catch(function (err) {
      loggingStatus.addLog('失败截图未成功: ' + (err && err.message), { level: 'warn' });
      return '';
    });
  }

  // 流程数据集（数据驱动）：flow 配置的 dataset 字段为 JSON 数组文本
  function getFlowDataset(flowId) {
    var rawId = String(flowId || '').replace(/^user:/, '');
    var flow = configCache.flows && configCache.flows[rawId];
    if (!flow || !flow.dataset) return [];
    try {
      var parsed = JSON.parse(flow.dataset);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      loggingStatus.addLog('流程数据集 JSON 解析失败，忽略数据驱动: ' + (flow.label || rawId), { level: 'warn' });
      return [];
    }
  }

  function markRunReportPersistenceFailure(session, reportId, kind, phase, error, generation) {
    var message;
    try {
      message = loggingStatus.getErrorMessage(error);
    } catch (_) {
      message = error && error.message ? error.message : String(error);
    }
    if (session) {
      session.markReportPersistenceFailure(message, phase, generation);
    } else {
      loggingStatus.addLog('运行报告' + phase + '失败: ' + message, { level: 'error', scope: 'run' });
    }
    broadcast({
      type: 'RUN_REPORT_PERSISTENCE_ERROR',
      payload: {
        runId: session && session.runId || reportId,
        reportId: reportId,
        kind: kind || 'flow',
        phase: phase,
        error: message,
      },
    });
    if (session) broadcastSessions();
    return { ok: false, error: error, message: message };
  }

  var runQueryService = null;

  function requireRunQueryService() {
    if (!runQueryService) throw new Error('RunQueryService 尚未初始化');
    return runQueryService;
  }

  function waitForRunReport(runPromise, getReportPromise) {
    return requireRunQueryService().waitForRunReport(runPromise, getReportPromise);
  }

  function onRunStart(info) {
    currentRunStartedAt = info.startedAt;
    legacyRunStatus = 'running';
    legacyRunFlowLabel = flowRegistry.getFlowLabel(info.flowId);
    syncSwKeepAlive();
    updateActionIndicators();
    var record = RunReport.createStartRecord({
      id: info.sessionId,
      flowId: info.flowId,
      flowLabel: flowRegistry.getFlowLabel(info.flowId),
      trigger: pendingRunTrigger,
      startedAt: info.startedAt,
    });
    pendingRunTrigger = 'manual';
    legacyRunReportPromise = configStore.appendRun(record).then(function (result) {
      broadcast({ type: 'RUN_HISTORY_UPDATED' });
      return { ok: true, result: result };
    }, function (error) {
      return markRunReportPersistenceFailure(null, info.sessionId, 'flow', '创建', error);
    });
  }

  function onRunComplete(info) {
    var summaries = info.summaries || [];
    var status = RunReport.deriveTerminalStatus(info);
    legacyRunStatus = status;
    updateActionIndicators();
    syncSwKeepAlive();

    var logs = (getState().deepLog || []).filter(function (entry) {
      return entry.timestamp >= currentRunStartedAt;
    });

    var patch = RunReport.createTerminalPatch({
      endedAt: Date.now(),
      status: status,
      summaries: summaries,
      error: info.error || '',
      logs: logs,
      nodeStatuses: getState().nodeStatuses || {},
    });
    legacyRunReportPromise = Promise.resolve(legacyRunReportPromise).then(function (startResult) {
      if (startResult && startResult.ok === false) return startResult;
      return configStore.updateRun(info.sessionId, patch).then(function (result) {
        broadcast({ type: 'RUN_HISTORY_UPDATED' });
        return { ok: true, result: result };
      }, function (error) {
        return markRunReportPersistenceFailure(null, info.sessionId, 'flow', '终态写入', error);
      });
    });
  }

  // Auto Run Controller
  autoRunController = AutoRunController.createAutoRunController({
    getState: getState,
    setState: setState,
    addLog: loggingStatus.addLog,
    setNodeStatus: loggingStatus.setNodeStatus,
    getOrderedNodes: function (flowId) { return flowEngine.getOrderedNodes(flowId); },
    getNodeIdsForFlow: function (flowId) { return flowEngine.getNodeIdsForFlow(flowId); },
    isNodeDoneStatus: function (s) { return flowEngine.isNodeDoneStatus(s); },
    getErrorMessage: function (e) { return loggingStatus.getErrorMessage(e); },
    executeNode: executeNode,
    broadcast: broadcast,
    sleep: CoreUtils.sleep,
    onRunStart: onRunStart,
    onRunComplete: onRunComplete,
    onRoundReset: function () { nodeExecutor.resetCtx(); },
    getLoopStack: function () { return nodeExecutor.getLoopStack(); },
    getCtx: function () { return nodeExecutor.getCtx(); },
    captureFailureScreenshot: captureFailureScreenshot,
    getFlowDataset: getFlowDataset,
  });

  var pageKeepAlive = PageKeepAlive.createPageKeepAlive({
    chrome: chrome,
    tabRuntime: tabRuntime,
    sourceRegistry: sourceRegistry,
    pageAutomation: pageAutomation,
    isTabClaimedByRunningSession: isTabClaimedByRunningSession,
    runningSessionForTab: runningSessionForTab,
  });

  function scheduledConversationField(sched, keys) {
    var task = sched && sched.task || {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = sched && sched[key] !== undefined ? sched[key] : task[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function scheduledConversationAssistantId(sched) {
    return scheduledConversationField(sched, ['assistantId']);
  }

  function scheduledConversationMessage(sched) {
    return scheduledConversationField(sched, ['message', 'prompt', 'input']);
  }

  function scheduledConversationServiceId(sched) {
    return scheduledConversationField(sched, ['modelServiceId']);
  }

  function startScheduledConversation(sched, trigger, opts) {
    sched = sched || {};
    opts = opts || {};
    var assistantId = scheduledConversationAssistantId(sched);
    var message = scheduledConversationMessage(sched);
    var serviceId = scheduledConversationServiceId(sched);
    if (!assistantId) return Promise.reject(new Error('缺少绑定助手'));
    if (!message) return Promise.reject(new Error('缺少对话内容'));
    var scheduleId = opts.scheduleId || sched.id || '';
    var fireTime = Math.max(0, Math.floor(Number(opts.fireTime) || Date.now()));
    var commandId = 'schedule:' + RUNTIME_SCOPE + ':' + scheduleId + ':' + fireTime;
    var conversationId = 'scheduled:' + RUNTIME_SCOPE + ':' + scheduleId + ':' + fireTime;
    return resolveConversationAssistant(assistantId).then(function (assistant) {
      if (!assistant) throw new Error('助手不存在: ' + assistantId);
      var selectedServiceId = serviceId || String(assistant.modelServiceId || '').trim();
      var servicePromise = selectedServiceId ? resolveConversationService(selectedServiceId) : conversationModelSettingsReady.then(function () {
        var settings = conversationModelSettingsCache;
        var fallbackId = settings.generatorServiceId || settings.defaultServiceId
          || settings.services && settings.services[0] && settings.services[0].id || '';
        return resolveConversationService(fallbackId);
      });
      return Promise.resolve(servicePromise).then(function (service) {
        if (!service) throw new Error('定时对话缺少可用模型服务');
        return conversationCommandBus.dispatchInternal({
        command: 'START_TURN',
        input: {
          schemaVersion: 1,
          commandId: commandId,
          conversationId: conversationId,
          assistantId: assistantId,
          serviceId: service.id,
          message: { id: commandId + ':message', content: message, attachments: [] },
          entry: { type: 'scheduled', currentResource: '/schedules/' + scheduleId },
          budgets: {
            maxModelRequests: Math.max(1, Number(assistant.settings && assistant.settings.maxIterations) || 30),
            maxIterations: Math.max(1, Number(assistant.settings && assistant.settings.maxIterations) || 30),
            maxToolCalls: Math.max(0, Number(assistant.settings && assistant.settings.maxToolCalls) || 100),
            maxWallTimeMs: Math.max(1000, Number(sched.maxWallTimeMs || sched.task && sched.task.maxWallTimeMs) || 15 * 60 * 1000),
            maxContextTokens: Math.max(1024, Number(service.maxContextTokens) || 1000000),
            maxOutputTokens: Math.max(1, Number(assistant.settings && assistant.settings.maxTokens) || 4096),
          },
          preferences: {
            streamOutput: false,
            reasoningVisibility: assistant.settings && assistant.settings.reasoningVisibility === 'collapsed' ? 'collapsed' : 'expanded',
            contextCompression: assistant.settings && assistant.settings.contextCompression === 'off' ? 'off' : 'auto',
          },
          requestedAt: fireTime,
        },
        }, { type: 'scheduled', scheduleId: scheduleId, instanceId: scheduleId });
      });
    }).then(function (response) {
      if (!response || response.ok !== true) {
        var error = new Error(response && response.error && response.error.message || '定时对话启动失败');
        error.code = response && response.error && response.error.code || 'INVALID_COMMAND';
        throw error;
      }
      loggingStatus.addLog('定时对话已提交: ' + (sched.label || scheduleId) + ' generation=' + response.result.generationId);
      return Object.assign({ conversationId: conversationId, commandId: commandId }, response.result);
    });
  }

  var runCommandService = null;

  function requireRunCommandService() {
    if (!runCommandService) throw new Error('RunCommandService 尚未初始化');
    return runCommandService;
  }

  // Scheduler — 定时任务与页面自动刷新/保活
  var scheduler = Scheduler.createScheduler({
    chrome: chrome,
    runtimeScope: RUNTIME_SCOPE,
    pageAutomation: pageAutomation,
    addLog: loggingStatus.addLog,
    getConfig: function () {
      return Promise.resolve(configReady).then(function () { return configCache; });
    },
    isFlowRunning: function (rawFlowId) {
      // 仅用于定时任务防自我堆叠（手动运行不受此限制，同流程可并发）
      if (rawFlowId) return isFlowSessionRunning('user:' + rawFlowId);
      return autoRunController.isRunning();
    },
    startFlowRun: startFlowRun,
    startFlowGroupRun: function (flowGroupId, options) { return runFlowGroup(flowGroupId, options); },
    isFlowGroupRunning: function (flowGroupId) {
      return isFlowSessionRunning('flowGroup:' + String(flowGroupId || '').replace(/^flowGroup:/, ''));
    },
    startConversation: startScheduledConversation,
    isConversationScheduleRunning: function (scheduleId) {
      scheduleId = String(scheduleId || '').trim();
      if (!scheduleId || !conversationJournalRuntime || typeof conversationJournalRuntime.listActiveConversations !== 'function') {
        return false;
      }
      return conversationJournalRuntime.listActiveConversations().then(function (items) {
        return (items || []).some(function (metadata) {
          var surface = metadata && metadata.activeGeneration && metadata.activeGeneration.surface || {};
          var instanceId = String(surface.instanceId || '');
          return surface.type === 'scheduled'
            && (instanceId === scheduleId || instanceId.indexOf('schedule:' + scheduleId + ':') === 0);
        });
      });
    },
    getTabId: tabRuntime.getTabId,
    execPageKeepAlive: function (pageId, page) { return pageKeepAlive.execPageKeepAlive(pageId, page); },
    syncPageKeepAliveState: function (config) { return pageKeepAlive.syncCdpActivityState(config); },
    isTabRunning: isTabClaimedByRunningSession,
  });

  function startFlowRun(userFlowId, trigger, opts) {
    return requireRunCommandService().startFlowRun(userFlowId, trigger, opts);
  }

  // 从指定节点恢复运行：优先复用最近一次会话（保留上下文变量），没有则新建
  function resumeFlowFrom(userFlowId, nodeId, opts) {
    return requireRunCommandService().resumeFlowFrom(userFlowId, nodeId, opts);
  }

  // --- 流程入参/出参与流程组 ---

  function cloneJsonSafe(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function cloneReportValue(value) {
    if (value === undefined) return null;
    return cloneRuntimeValueBounded(value, RUNTIME_RESULT_CLONE_OPTIONS);
  }

  function isImageDataUrl(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
  }

  var RUNTIME_STORAGE_CLONE_OPTIONS = {
    totalBudget: 512 * 1024,
    maxStringLength: 32 * 1024,
    maxArrayItems: 200,
    maxObjectKeys: 160,
    maxDepth: 8,
    largeStringMode: 'omit',
  };
  var RUNTIME_RESULT_CLONE_OPTIONS = {
    totalBudget: 768 * 1024,
    maxStringLength: 128 * 1024,
    maxArrayItems: 300,
    maxObjectKeys: 220,
    maxDepth: 8,
    largeStringMode: 'truncate',
  };

  function createRuntimeCloneBudget(options) {
    return {
      remaining: Math.max(16 * 1024, Number(options.totalBudget) || RUNTIME_STORAGE_CLONE_OPTIONS.totalBudget),
      exhausted: false,
    };
  }

  function consumeRuntimeCloneBudget(budget, amount) {
    if (!budget || budget.exhausted) return !!(budget && budget.exhausted);
    budget.remaining -= Math.max(0, Number(amount) || 0);
    if (budget.remaining < 0) budget.exhausted = true;
    return budget.exhausted;
  }

  function omittedRuntimeValue(reason, extra) {
    return Object.assign({ __omitted: true, reason: reason || 'runtime-size-limit' }, extra || {});
  }

  function normalizeRuntimeCloneOptions(options) {
    return Object.assign({}, RUNTIME_STORAGE_CLONE_OPTIONS, options || {});
  }

  function cloneRuntimeValueBounded(value, options, depth, seen, budget) {
    options = normalizeRuntimeCloneOptions(options);
    depth = depth || 0;
    seen = seen || [];
    budget = budget || createRuntimeCloneBudget(options);

    if (budget.exhausted) return omittedRuntimeValue('runtime-budget-exceeded');
    if (value === undefined) return null;
    if (value === null) {
      consumeRuntimeCloneBudget(budget, 4);
      return null;
    }

    var type = typeof value;
    if (type === 'string') {
      if (isImageDataUrl(value)) {
        consumeRuntimeCloneBudget(budget, 64);
        return omittedRuntimeValue('image-data-url', { type: 'string', length: value.length });
      }
      var maxStringLength = Math.max(1024, Number(options.maxStringLength) || RUNTIME_STORAGE_CLONE_OPTIONS.maxStringLength);
      consumeRuntimeCloneBudget(budget, Math.min(value.length, maxStringLength));
      if (value.length > maxStringLength) {
        if (options.largeStringMode === 'truncate') {
          return value.slice(0, maxStringLength) + '\n... omitted ' + (value.length - maxStringLength) + ' chars by runtime size limit';
        }
        return omittedRuntimeValue('string-too-large', {
          type: 'string',
          length: value.length,
          preview: value.slice(0, Math.min(2048, maxStringLength)),
        });
      }
      return value;
    }
    if (type === 'number' || type === 'boolean') {
      consumeRuntimeCloneBudget(budget, 16);
      return value;
    }
    if (type === 'bigint') {
      var bigintText = String(value) + 'n';
      consumeRuntimeCloneBudget(budget, bigintText.length);
      return bigintText;
    }
    if (type === 'function') {
      consumeRuntimeCloneBudget(budget, 64);
      return { __type: 'function', name: value.name || '' };
    }
    if (type !== 'object') {
      var text = String(value);
      consumeRuntimeCloneBudget(budget, text.length);
      return text;
    }
    if (seen.indexOf(value) !== -1) return '[Circular]';
    if (depth >= options.maxDepth) return omittedRuntimeValue('max-depth', { depth: depth });

    seen.push(value);
    try {
      if (Array.isArray(value)) {
        var arr = [];
        var len = value.length;
        var itemLimit = Math.min(len, Math.max(0, Number(options.maxArrayItems) || RUNTIME_STORAGE_CLONE_OPTIONS.maxArrayItems));
        for (var i = 0; i < itemLimit; i++) {
          if (budget.exhausted) {
            arr.push(omittedRuntimeValue('runtime-budget-exceeded'));
            break;
          }
          arr.push(cloneRuntimeValueBounded(value[i], options, depth + 1, seen, budget));
        }
        if (len > itemLimit) {
          arr.push(omittedRuntimeValue('array-items-limit', { length: len, omittedItems: len - itemLimit }));
        }
        return arr;
      }

      if (value instanceof Error) {
        consumeRuntimeCloneBudget(budget, 256);
        return {
          __type: 'error',
          name: value.name || 'Error',
          message: value.message || '',
          stack: value.stack ? String(value.stack).slice(0, 4096) : '',
        };
      }

      var keys = Object.keys(value);
      var out = {};
      var keyLimit = Math.min(keys.length, Math.max(0, Number(options.maxObjectKeys) || RUNTIME_STORAGE_CLONE_OPTIONS.maxObjectKeys));
      for (var j = 0; j < keyLimit; j++) {
        var key = keys[j];
        if (consumeRuntimeCloneBudget(budget, key.length)) {
          out.__omitted = true;
          out.__omittedReason = 'runtime-budget-exceeded';
          break;
        }
        var item = value[key];
        if ((key === 'screenshot' || key === 'dataUrl' || key === 'imageDataUrl') && isImageDataUrl(item)) {
          out[key + 'Omitted'] = true;
          out[key + 'Bytes'] = item.length;
          continue;
        }
        out[key] = cloneRuntimeValueBounded(item, options, depth + 1, seen, budget);
        if (budget.exhausted) {
          out.__omitted = true;
          out.__omittedReason = 'runtime-budget-exceeded';
          break;
        }
      }
      if (keys.length > keyLimit) {
        out.__omittedKeys = keys.length - keyLimit;
        out.__totalKeys = keys.length;
      }
      return out;
    } finally {
      seen.pop();
    }
  }

  function sanitizeStoredRuntimeValue(value) {
    return cloneRuntimeValueBounded(value, RUNTIME_STORAGE_CLONE_OPTIONS);
  }

  function setRuntimePath(target, path, value) {
    var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
    var parts = normalized.split('.').filter(Boolean);
    if (!parts.length) return;
    var cur = target;
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function splitRuntimePathList(raw) {
    if (Array.isArray(raw)) return raw.map(function (v) { return String(v || '').trim(); }).filter(Boolean);
    return String(raw || '').split(/[,\n]/).map(function (v) { return v.trim(); }).filter(Boolean);
  }

  function cloneCtxPaths(ctx, paths, options) {
    var out = {};
    var cloneOptions = normalizeRuntimeCloneOptions(options);
    var budget = createRuntimeCloneBudget(cloneOptions);
    splitRuntimePathList(paths).forEach(function (path) {
      if (!path || budget.exhausted) return;
      var value = resolveFromCtx(ctx, path);
      if (value === undefined) return;
      setRuntimePath(out, path, cloneRuntimeValueBounded(value, cloneOptions, 0, [], budget));
    });
    if (budget.exhausted) out.__omitted = omittedRuntimeValue('runtime-budget-exceeded');
    return out;
  }

  function cloneRuntimeContextForResult(ctx, options) {
    options = options || {};
    var mode = String(options.ctxMode || options.contextMode || '').trim();
    if (mode === 'none' || mode === 'omit') return {};
    if (mode === 'paths') {
      return cloneCtxPaths(ctx || {}, options.ctxPaths || options.contextPaths || options.paths || [], RUNTIME_RESULT_CLONE_OPTIONS);
    }
    return cloneRuntimeValueBounded(ctx || {}, RUNTIME_RESULT_CLONE_OPTIONS);
  }

  function isPlainObject(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  // Keep legacy {{field}} and canonical {{input.field}} templates equivalent.
  // tabId belongs to runtime context and never crosses the input boundary.
  function normalizeRuntimeInputContext(ctx) {
    if (!isPlainObject(ctx)) return ctx;

    var hasInputObject = isPlainObject(ctx.input);
    var input = hasInputObject ? cloneJsonSafe(ctx.input) : {};
    if (isPlainObject(input)) delete input.tabId;
    var hasBusinessInput = hasInputObject;

    Object.keys(ctx).forEach(function (key) {
      if (!key || key === 'input' || key === 'tabId') return;
      input[key] = cloneJsonSafe(ctx[key]);
      hasBusinessInput = true;
    });

    if (!hasBusinessInput) return ctx;
    ctx.input = input;
    Object.keys(input).forEach(function (key) {
      if (!key || key === 'tabId' || Object.prototype.hasOwnProperty.call(ctx, key)) return;
      ctx[key] = cloneJsonSafe(input[key]);
    });
    return ctx;
  }

  function getReportInputFromContext(ctx) {
    if (!isPlainObject(ctx)) return null;
    if (Object.prototype.hasOwnProperty.call(ctx, 'input')) return cloneReportValue(ctx.input);
    var legacyInput = {};
    Object.keys(ctx).forEach(function (key) {
      if (key === 'tabId') return;
      legacyInput[key] = ctx[key];
    });
    return Object.keys(legacyInput).length ? cloneReportValue(legacyInput) : null;
  }

  function rememberRunInput(recordOrId, input, runId) {
    var id = '';
    var sessionRunId = '';
    var value = input;
    if (recordOrId && typeof recordOrId === 'object') {
      id = recordOrId.id || '';
      sessionRunId = recordOrId.runId || '';
      value = recordOrId.input;
    } else {
      id = recordOrId || '';
      sessionRunId = runId || '';
    }
    if (value === undefined || value === null) return;
    var stored = cloneReportValue(value);
    if (id) runInputCache[id] = stored;
    if (sessionRunId) runInputCache[sessionRunId] = stored;
  }

  function rebuildRunInputCache(runs) {
    var next = {};
    (runs || []).forEach(function (run) {
      if (!run || run.input === undefined || run.input === null) return;
      var stored = cloneReportValue(run.input);
      if (run.id) next[run.id] = stored;
      if (run.runId) next[run.runId] = stored;
    });
    runInputCache = next;
  }

  function refreshRunInputCache() {
    return configStore.getRuns().then(function (runs) {
      rebuildRunInputCache(runs);
    }).catch(function () {});
  }

  function resolveRunSummaryInput(runId, localInput) {
    if (localInput !== undefined && localInput !== null) return cloneReportValue(localInput);
    if (runId && Object.prototype.hasOwnProperty.call(runInputCache, runId)) return cloneReportValue(runInputCache[runId]);
    return null;
  }

  function getUserFlowConfig(flowId) {
    var rawId = String(flowId || '').replace(/^user:/, '');
    return rawId && configCache.flows ? configCache.flows[rawId] : null;
  }

  function buildInitialContextFromRuntimeInput(rawContext) {
    var ctx = isPlainObject(rawContext) ? cloneJsonSafe(rawContext) : {};
    normalizeRuntimeInputContext(ctx);
    return ctx;
  }

  function buildFlowInitialContext(flowId, rawContext) {
    return buildInitialContextFromRuntimeInput(rawContext);
  }

  function resolveFromCtx(ctx, path) {
    if (!path) return undefined;
    var Template = globalThis.Template;
    if (Template && Template.resolvePath) return Template.resolvePath(ctx || {}, path);
    var normalized = String(path).replace(/\[(\d+)\]/g, '.$1');
    var parts = normalized.split('.').filter(Boolean);
    var cur = ctx;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function unwrapFlowOutput(value) {
    var FlowData = globalThis.FlowData;
    if (FlowData && FlowData.isFlowData && FlowData.isFlowData(value)) return FlowData.getContent(value);
    return value;
  }

  function extractFlowOutputs(flowId, ctx) {
    var result = resolveFromCtx(ctx, 'result');
    var last = unwrapFlowOutput(resolveFromCtx(ctx, 'last'));
    var fallback = result !== undefined ? result : (last !== undefined ? last : ctx);
    return fallback;
  }

  var flowGroupController = FlowGroupController.createFlowGroupController({
    runReport: RunReport,
    getConfigReady: function () { return configReady; },
    getConfig: function () { return configCache; },
    generateRunId: function () {
      return 'fg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    },
    buildInitialContext: buildInitialContextFromRuntimeInput,
    cloneJsonSafe: cloneJsonSafe,
    interpolate: function (text, ctx) {
      return globalThis.Template ? globalThis.Template.interpolate(String(text), ctx || {}) : String(text);
    },
    resolvePath: resolveFromCtx,
    unwrapFlowOutput: unwrapFlowOutput,
    getStepRunTabMode: getStepRunTabMode,
    startSessionRun: startSessionRun,
    getSession: function (runId) { return runSessionRegistry.get(runId); },
    getSessionResult: getSessionResult,
    registerSession: function (session) { return runSessionRegistry.register(session); },
    unregisterSession: function (runId, expected) { return runSessionRegistry.unregister(runId, expected); },
    stopSession: stopSession,
    appendRun: function (record) { return configStore.appendRun(record); },
    updateRun: function (runId, patch) { return configStore.updateRun(runId, patch); },
    rememberRunInput: rememberRunInput,
    broadcast: broadcast,
    broadcastSessions: broadcastSessions,
    syncKeepAlive: syncSwKeepAlive,
    pruneSessions: pruneSessions,
    getErrorMessage: function (error) { return loggingStatus.getErrorMessage(error); },
    normalizeLogScope: normalizeLogScope,
    maxSessionLogs: 400,
  });

  function runFlowGroup(flowGroupId, opts) {
    return flowGroupController.runFlowGroup(flowGroupId, opts);
  }

  var configRuntimeCoordinator = ConfigRuntimeCoordinator.createConfigRuntimeCoordinator({
    prepareConfig: function (config) { return builtinFlowLoader.applyToConfig(config); },
    publishConfig: function (runtimeConfig) { configCache = runtimeConfig; },
    reloadDynamic: function (runtimeConfig) { return dynamicFlowBuilder.reload(runtimeConfig); },
    syncAlarms: function (runtimeConfig) { return scheduler.syncAlarms(runtimeConfig); },
  });

  // 配置整体替换（导入备份）
  function configReplace(rawConfig) {
    var configInput = cloneConfigValue(rawConfig || {});
    return Promise.resolve(configReady).then(function () {
      return configRuntimeCoordinator.update(function () {
        var config = sanitizeConfigForStorage(configInput);
        return configStore.saveConfig(config);
      });
    });
  }

  // --- 配置加载与应用 ---

  function loadAndApplyConfig() {
    return configRuntimeCoordinator.update(function () {
      return configStore.getConfig();
    }).catch(function (err) {
      loggingStatus.addLog('加载用户配置失败: ' + err.message, { level: 'error' });
    });
  }

  function scheduleConfigTaskKind(sched) {
    var task = sched && sched.task || {};
    var kind = String((sched && (sched.taskType || sched.targetKind)) || task.kind || task.type || '').trim();
    if (!kind) {
      var conversationHint = sched && (sched.assistantId || sched.message || sched.prompt)
        || task.assistantId || task.message;
      var flowGroupHint = sched && (sched.flowGroupId || sched.groupId)
        || task.flowGroupId || task.groupId;
      kind = conversationHint ? 'conversation' : (flowGroupHint ? 'flowGroup' : 'flow');
    }
    if (kind === 'conversation') return 'conversation';
    return kind === 'flowGroup' || kind === 'flow-group' ? 'flowGroup' : 'flow';
  }

  function scheduleConfigField(sched, keys) {
    var task = sched && sched.task || {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = sched && sched[key] !== undefined ? sched[key] : task[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function validateScheduleConfigItem(item) {
    item = item || {};
    var trigger = Object.assign({}, item.trigger || {});
    if (!trigger.kind && item.cronExpression) {
      trigger.kind = 'cron';
      trigger.expression = item.cronExpression;
    }
    if (!trigger.kind) trigger.kind = 'interval';
    if (trigger.kind === 'daily') {
      var time = String(trigger.time || '08:00').trim();
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('每天固定时间必须是 HH:mm');
    } else if (trigger.kind === 'cron') {
      scheduler.validateCronExpression(trigger.expression || trigger.cron || item.cronExpression || '');
    } else if (trigger.kind !== 'interval') {
      throw new Error('未知触发方式: ' + trigger.kind);
    }

    var taskKind = scheduleConfigTaskKind(item);
    if (taskKind === 'conversation') {
      if (!scheduleConfigField(item, ['assistantId'])) throw new Error('对话定时任务缺少绑定助手');
      if (!scheduleConfigField(item, ['message', 'prompt', 'input'])) throw new Error('对话定时任务缺少对话内容');
    } else if (taskKind === 'flowGroup') {
      if (!scheduleConfigField(item, ['flowGroupId', 'groupId'])) throw new Error('流程组定时任务缺少绑定流程组');
    } else if (!scheduleConfigField(item, ['flowId'])) {
      throw new Error('流程定时任务缺少绑定流程');
    }
  }

  function configMutate(payload) {
    var mutation = sanitizeMutationPayload(payload);
    return Promise.resolve(configReady).then(function () {
      return configRuntimeCoordinator.update(function () {
        assertMutableConfigTarget(mutation);
        if (mutation.op === 'upsert' && mutation.section === 'schedules') validateScheduleConfigItem(mutation.item);
        return configStore.mutate(mutation);
      });
    });
  }

  var httpMcpManager = HttpMcpClient.createHttpMcpManager({
    chrome: chrome,
    incognito: INCOGNITO_CONTEXT,
    knowledge: globalThis.Knowledge,
    addLog: loggingStatus.addLog,
  });
  var skillKnowledgeManager = SkillKnowledge.createSkillKnowledgeImporter({
    knowledge: globalThis.Knowledge,
    addLog: loggingStatus.addLog,
  });
  var builtinSkillLoader = BuiltinSkillLoader.createBuiltinSkillLoader({
    chrome: chrome,
    skillKnowledge: skillKnowledgeManager,
  });
  var builtinSkillsReady = builtinSkillLoader.sync().catch(function (err) {
    loggingStatus.addLog('内置 Skill 加载失败: ' + err.message, { level: 'warn', scope: 'system', source: 'builtin-skill-loader' });
    return { provider: 'builtin-skill-loader', ok: false, error: err.message };
  });

  function stopConversationTopicRuns(topicId) {
    if (!runSessionRegistry) return Promise.resolve({ ok: true, stoppedRunIds: [] });
    var stopped = [];
    return Promise.all(runSessionRegistry.runningIds().map(function (runId) {
      var session = runSessionRegistry.get && runSessionRegistry.get(runId)
        || runSessionRegistry.sessions && runSessionRegistry.sessions.get && runSessionRegistry.sessions.get(runId);
      if (!session || String(session.conversationTopicId || session.options && session.options.conversationTopicId || '') !== String(topicId || '')) return null;
      return Promise.resolve(stopSession(runId)).then(function () { stopped.push(runId); });
    })).then(function () { return { ok: true, stoppedRunIds: stopped }; });
  }

  // ============================================================
  // 运行会话（RunSession）— 每个会话独立的执行器/控制器/页面 tab/状态/日志
  // 支持多流程并行（不同流程各占各的标签页，互不干扰）
  // ============================================================

  var MAX_FINISHED_SESSIONS = 10;
  var MAX_COMPLETED_SNAPSHOTS = 50;
  var MAX_SESSION_LOGS = 400;
  var ACTIVE_SESSION_COMPACT_INTERVAL_MS = 15000;
  var RUNNING_SNAPSHOT_INTERVAL_MS = 60000;
  var SNAPSHOT_STORAGE_KEY = INCOGNITO_CONTEXT
    ? 'automation_run_snapshots_incognito'
    : 'automation_run_snapshots';

  function invokeRunSnapshotStorage(method, value) {
    var storage = chrome.storage && chrome.storage.session;
    if (!storage || typeof storage[method] !== 'function') {
      return Promise.reject(new Error('chrome.storage.session.' + method + ' is unavailable'));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function settle(error, result) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      }
      function callback(result) {
        var lastError = chrome.runtime && chrome.runtime.lastError;
        settle(lastError ? new Error(lastError.message || String(lastError)) : null, result);
      }
      try {
        var returned = storage[method](value, callback);
        if (returned && typeof returned.then === 'function') {
          returned.then(function (result) { settle(null, result); }, function (error) { settle(error); });
        }
      } catch (error) {
        settle(error);
      }
    });
  }

  if (!globalThis.RunSessionRegistry || typeof globalThis.RunSessionRegistry.create !== 'function') {
    throw new Error('RunSessionRegistry must load before background.js');
  }
  var runSessionRegistry = globalThis.RunSessionRegistry.create({
    readSnapshots: function () {
      return invokeRunSnapshotStorage('get', SNAPSHOT_STORAGE_KEY).then(function (data) {
        return data && data[SNAPSHOT_STORAGE_KEY] || {};
      });
    },
    writeSnapshots: function (snapshots) {
      var payload = {};
      payload[SNAPSHOT_STORAGE_KEY] = snapshots;
      return invokeRunSnapshotStorage('set', payload);
    },
    cloneData: cloneJsonSafe,
    sanitizeRuntimeValue: sanitizeStoredRuntimeValue,
    getReportInput: getReportInputFromContext,
    compactActiveSession: compactActiveSessionRuntime,
    now: function () { return Date.now(); },
    maxFinishedSessions: MAX_FINISHED_SESSIONS,
    maxCompletedSnapshots: MAX_COMPLETED_SNAPSHOTS,
    runningSnapshotIntervalMs: RUNNING_SNAPSHOT_INTERVAL_MS,
    onSnapshotsLoaded: function (count) {
      if (count) broadcastSessions();
    },
    onPersistenceError: function (error, phase) {
      loggingStatus.addLog('运行会话快照' + phase + '失败: ' + ((error && error.message) || error), {
        level: 'warn',
        scope: 'system',
      });
    },
    onSessionsPruned: function () { updateActionIndicators(); },
    onSnapshotWarning: function (session, field, error) {
      if (!session || typeof session.addLog !== 'function') return;
      session.addLog('会话快照字段 ' + field + ' 无法序列化，已使用安全回退: '
        + ((error && error.message) || error), { level: 'warn', scope: 'run' });
    },
  });
  var sessions = runSessionRegistry.sessions; // stable runId -> session map
  var snapshotCache = runSessionRegistry.snapshots; // stable runId -> snapshot map
  var snapshotsReady = runSessionRegistry.ready;

  var RUN_TAB_MODE_REUSE_OPEN = 'reuseOpenTab';
  var RUN_TAB_MODE_FIXED_CURRENT = 'fixedCurrentTab';
  var RUN_TAB_MODE_FIXED_NEW = 'fixedNewTab';
  var DEFAULT_RUN_TAB_MODE = RUN_TAB_MODE_REUSE_OPEN;
  var RUN_TAB_MODE_LABELS = {};
  RUN_TAB_MODE_LABELS[RUN_TAB_MODE_FIXED_CURRENT] = '固定当前标签';
  RUN_TAB_MODE_LABELS[RUN_TAB_MODE_REUSE_OPEN] = '复用已打开标签';
  RUN_TAB_MODE_LABELS[RUN_TAB_MODE_FIXED_NEW] = '固定打开标签';

  function normalizeRunTabMode(value, fallback) {
    var mode = String(value || '').trim();
    if (mode === 'currentTab' || mode === 'fixedCurrent') mode = RUN_TAB_MODE_FIXED_CURRENT;
    if (mode === 'newTab' || mode === 'exclusiveWindow' || mode === 'fixedRunTab') mode = RUN_TAB_MODE_FIXED_NEW;
    if (mode === 'reuse' || mode === 'reuseTab') mode = RUN_TAB_MODE_REUSE_OPEN;
    if (mode === RUN_TAB_MODE_FIXED_CURRENT || mode === RUN_TAB_MODE_REUSE_OPEN || mode === RUN_TAB_MODE_FIXED_NEW) return mode;
    return fallback || DEFAULT_RUN_TAB_MODE;
  }

  function runTabModeLabel(mode) {
    return RUN_TAB_MODE_LABELS[normalizeRunTabMode(mode)] || mode || DEFAULT_RUN_TAB_MODE;
  }

  function normalizeLogScope(scope, hasNodeId, fallback) {
    if (scope === 'session') return 'run';
    if (scope === 'system' || scope === 'run' || scope === 'flow' || scope === 'mcp') return scope;
    if (hasNodeId) return 'flow';
    return fallback || 'run';
  }

  function normalizeEntry(value, trigger) {
    var entry = String(value || '').trim();
    if (entry) return entry;
    trigger = String(trigger || '');
    if (trigger.indexOf('mcp') === 0) return 'mcp';
    if (trigger.indexOf('schedule:') === 0) return 'schedule';
    if (trigger.indexOf('url:') === 0) return 'urlTrigger';
    if (trigger.indexOf('flowGroup:') === 0) return 'flowGroup';
    return 'manual';
  }

  function hostFromUrl(url) {
    try { return new URL(url).host; } catch (_) { return ''; }
  }

  function comparableUrl(url) {
    var text = String(url || '').trim();
    if (!text) return '';
    try { return new URL(text).href; } catch (_) { return text; }
  }

  function sameUrl(a, b) {
    var left = comparableUrl(a);
    var right = comparableUrl(b);
    return !!(left && right && left === right);
  }

  function pageIdFromSource(source) {
    var m = /^page:(.+)$/.exec(String(source || ''));
    return m ? m[1] : '';
  }

  function splitMatcherValues(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) { return String(item || '').trim(); }).filter(Boolean);
    }
    return String(value || '').split(/[\s,，;；\n]+/).map(function (item) { return item.trim(); }).filter(Boolean);
  }

  function parsedUrl(url) {
    try { return url ? new URL(url) : null; } catch (_) { return null; }
  }

  function pageMatchScoreForEntryStatus(page, url) {
    page = page || {};
    var target = parsedUrl(url);
    if (!target) return 0;
    var pageUrl = parsedUrl(page.url || '');
    var score = 0;
    if (pageUrl && pageUrl.hostname === target.hostname) {
      score = Math.max(score, 50);
      if (pageUrl.href === target.href) score = Math.max(score, 120);
      if (pageUrl.origin + pageUrl.pathname === target.origin + target.pathname) score = Math.max(score, 100);
      if (pageUrl.pathname && pageUrl.pathname !== '/' && target.pathname.indexOf(pageUrl.pathname) === 0) score = Math.max(score, 90);
    }
    var matchers = page.matchers || {};
    var hosts = splitMatcherValues(matchers.hostnames || page.hostnames);
    var includes = splitMatcherValues(matchers.urlIncludes || page.urlIncludes || page.urlPattern);
    if (hosts.length) {
      if (!hosts.some(function (host) { return host === target.hostname; })) return 0;
      score = Math.max(score, 70);
    }
    if (includes.length) {
      if (!includes.every(function (part) { return target.href.indexOf(part) !== -1; })) return 0;
      score = Math.max(score, 95);
    }
    return score;
  }

  function pageContextFromPageId(pageId, matchedBy) {
    pageId = String(pageId || '').trim();
    var page = pageId && configCache.pages && configCache.pages[pageId];
    if (!page) return null;
    return {
      source: 'page:' + pageId,
      pageId: pageId,
      pageLabel: page.label || page.name || page.url || pageId,
      pageUrl: page.url || '',
      matchedBy: matchedBy || '',
    };
  }

  function findConfiguredPageContextByUrl(url) {
    var best = null;
    var bestScore = 0;
    var pages = configCache.pages || {};
    Object.keys(pages).forEach(function (pageId) {
      var score = pageMatchScoreForEntryStatus(pages[pageId], url);
      if (score > bestScore) {
        bestScore = score;
        best = pageContextFromPageId(pageId, 'url-config');
      }
    });
    return bestScore >= 70 ? best : null;
  }

  function resolvePageContextForEntryTab(tab, url) {
    tab = tab || {};
    var tabId = Number(tab.id || 0) || 0;
    if (tabId && tabRuntime && tabRuntime.getSourceByTabId) {
      var source = tabRuntime.getSourceByTabId(tabId);
      var pageContext = pageContextFromPageId(pageIdFromSource(source), 'claimed-tab');
      if (pageContext) return pageContext;
    }
    var configuredContext = findConfiguredPageContextByUrl(url);
    if (configuredContext) return configuredContext;
    if (url && sourceRegistry && sourceRegistry.detectSourceFromLocation) {
      var parsed = parsedUrl(url);
      var detected = sourceRegistry.detectSourceFromLocation({
        url: url,
        hostname: parsed ? parsed.hostname : hostFromUrl(url).split(':')[0],
      });
      var detectedContext = pageContextFromPageId(pageIdFromSource(detected), 'source-registry');
      if (detectedContext) return detectedContext;
    }
    return null;
  }

  function conversationEntryStatusName(entry) {
    entry = String(entry || '').trim();
    if (entry === 'floating' || entry === 'floating-status') return 'floating-status';
    if (entry === 'page-conversation') return 'page-conversation';
    return 'sidepanel';
  }

  function getConversationEntryTab(payload) {
    payload = payload || {};
    var tabId = Number(payload.originTabId || payload.ownerTabId || payload.activeTabId || payload.tabId || 0) || 0;
    if (!tabId || !chrome.tabs || !chrome.tabs.get) return Promise.resolve(null);
    return chrome.tabs.get(tabId).catch(function () { return null; });
  }

  function resolveConversationEntryStatus(payload) {
    payload = payload || {};
    var entryName = conversationEntryStatusName(payload.entry || 'sidepanel');
    return getConversationEntryTab(payload).then(function (tab) {
      tab = tab || {};
      if (!tab.id) throw new Error('无法确认发起对话的真实标签页，请回到目标页面后重试');
      var tabId = Number(tab.id || 0) || 0;
      var windowId = Number(tab.windowId || 0) || 0;
      var url = String(tab.url || '').trim();
      var title = String(tab.title || '').trim();
      var payloadPageId = String(payload.pageId || payload.sourcePageId || '').trim();
      var payloadPageContext = pageContextFromPageId(payloadPageId, 'payload');
      if (payloadPageContext && url && pageMatchScoreForEntryStatus(configCache.pages && configCache.pages[payloadPageId], url) < 70) {
        payloadPageContext = null;
      }
      var pageContext = payloadPageContext || resolvePageContextForEntryTab(tab, url) || {};
      var pageLabel = String(pageContext.pageLabel || payload.pageLabel || payload.pageName || title || '').trim();
      return {
        entryStatus: {
          entry: entryName,
          tabId: tabId,
          windowId: windowId,
          pageId: pageContext.pageId || '',
          url: url,
          pageLabel: pageLabel,
        },
        url: url,
        title: title,
        tabId: tabId,
        windowId: windowId,
      };
    });
  }

  function sourceHostMatches(source, tabUrl, targetUrl) {
    var targetHost = hostFromUrl(targetUrl || '');
    if (!targetHost) {
      var pageId = pageIdFromSource(source);
      var page = pageId && configCache.pages && configCache.pages[pageId];
      targetHost = page && page.url ? hostFromUrl(page.url) : '';
    }
    var tabHost = hostFromUrl(tabUrl || '');
    return !!(targetHost && tabHost && targetHost === tabHost);
  }

  function getConfiguredFlowRunTabMode(flowId, fallback) {
    var rawId = String(flowId || '').replace(/^user:/, '');
    var flow = rawId && configCache.flows ? configCache.flows[rawId] : null;
    return normalizeRunTabMode(flow && flow.runTabMode, fallback || DEFAULT_RUN_TAB_MODE);
  }

  function getStepRunTabMode(step, flowId, fallback) {
    return normalizeRunTabMode(step && step.runTabMode, getConfiguredFlowRunTabMode(flowId, fallback || DEFAULT_RUN_TAB_MODE));
  }

  var MCP_ENABLED_STORAGE_KEY = INCOGNITO_CONTEXT ? 'mcpEnabledIncognito' : 'mcpEnabled';
  var MCP_URL_STORAGE_KEY = INCOGNITO_CONTEXT ? 'mcpUrlIncognito' : 'mcpUrl';
  var MCP_CLIENT_ID_STORAGE_KEY = INCOGNITO_CONTEXT ? 'mcpClientIdIncognito' : 'mcpClientId';
  var MCP_CLIENT_NAME_STORAGE_KEY = INCOGNITO_CONTEXT ? 'mcpClientNameIncognito' : 'mcpClientName';
  var MCP_RUN_TAB_MODE_STORAGE_KEY = INCOGNITO_CONTEXT ? 'mcpRunTabModeIncognito' : 'mcpRunTabMode';
  var mcpRunTabMode = DEFAULT_RUN_TAB_MODE;
  chrome.storage.local.get([MCP_RUN_TAB_MODE_STORAGE_KEY], function (res) {
    mcpRunTabMode = normalizeRunTabMode(res && res[MCP_RUN_TAB_MODE_STORAGE_KEY], DEFAULT_RUN_TAB_MODE);
  });
  var mcpTabAccessManager = McpTabAccess.createMcpTabAccessManager({
    chrome: chrome,
    tabRuntime: tabRuntime,
    pageAutomation: pageAutomation,
    getConfig: function () { return configCache; },
    addLog: loggingStatus.addLog,
    pageHostMatchesTab: pageHostMatchesTab,
    isTabClaimedByOther: isTabClaimedByOther,
    normalizeRunTabMode: normalizeRunTabMode,
    runTabModeLabel: runTabModeLabel,
    sameUrl: sameUrl,
    RUN_TAB_MODE_REUSE_OPEN: RUN_TAB_MODE_REUSE_OPEN,
    RUN_TAB_MODE_FIXED_CURRENT: RUN_TAB_MODE_FIXED_CURRENT,
    RUN_TAB_MODE_FIXED_NEW: RUN_TAB_MODE_FIXED_NEW,
    DEFAULT_RUN_TAB_MODE: DEFAULT_RUN_TAB_MODE,
    getInitialRunTabMode: function () { return mcpRunTabMode; },
    onRunTabModeChanged: function (mode) { mcpRunTabMode = mode; },
  });

  var CONFIG_SYNC_SECTIONS = ['pages', 'flows', 'flowGroups', 'scripts', 'schedules', 'urlTriggers'];
  var CONFIG_SYNC_RESOURCES = {
    pages: 'page',
    flows: 'flow',
    flowGroups: 'flowGroup',
    scripts: 'script',
    schedules: 'schedule',
    urlTriggers: 'urlTrigger',
  };

  function syncValueSignature(value) {
    try { return JSON.stringify(value === undefined ? null : value); }
    catch (_) { return ''; }
  }

  function syncItemMap(section, value) {
    var map = Object.create(null);
    if (section === 'urlTriggers') {
      (Array.isArray(value) ? value : []).forEach(function (item) {
        var id = item && item.id !== undefined ? String(item.id) : '';
        if (id) map[id] = item;
      });
      return map;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return map;
    Object.keys(value).forEach(function (id) { map[id] = value[id]; });
    return map;
  }

  function publishConfigSyncEvents(change) {
    var oldConfig = change && change.oldValue || {};
    var nextConfig = change && change.newValue || {};
    CONFIG_SYNC_SECTIONS.forEach(function (section) {
      if (syncValueSignature(oldConfig && oldConfig[section]) === syncValueSignature(nextConfig && nextConfig[section])) return;
      var oldItems = syncItemMap(section, oldConfig && oldConfig[section]);
      var nextItems = syncItemMap(section, nextConfig && nextConfig[section]);
      var ids = Object.create(null);
      Object.keys(oldItems).forEach(function (id) { ids[id] = true; });
      Object.keys(nextItems).forEach(function (id) { ids[id] = true; });
      var published = false;
      Object.keys(ids).forEach(function (id) {
        var oldItem = oldItems[id];
        var nextItem = nextItems[id];
        var oldExists = oldItem !== undefined;
        var nextExists = nextItem !== undefined;
        if (oldExists && nextExists && syncValueSignature(oldItem) === syncValueSignature(nextItem)) return;
        publishSyncEvent({
          scope: 'shared',
          resource: CONFIG_SYNC_RESOURCES[section] || 'config',
          section: section,
          action: oldExists ? (nextExists ? 'updated' : 'deleted') : 'created',
          id: id,
          source: 'storage',
        });
        published = true;
      });
      if (!published) {
        publishSyncEvent({
          scope: 'shared',
          resource: 'config',
          section: section,
          action: 'changed',
          source: 'storage',
        });
      }
    });
  }

  function publishAssistantSyncEvents(change) {
    var oldCatalog = change && change.oldValue || {};
    var nextCatalog = change && change.newValue || {};
    var oldAssistants = oldCatalog && oldCatalog.assistants || {};
    var nextAssistants = nextCatalog && nextCatalog.assistants || {};
    var ids = Object.create(null);
    if (oldAssistants && typeof oldAssistants === 'object') Object.keys(oldAssistants).forEach(function (id) { ids[id] = true; });
    if (nextAssistants && typeof nextAssistants === 'object') Object.keys(nextAssistants).forEach(function (id) { ids[id] = true; });
    var published = false;
    Object.keys(ids).forEach(function (id) {
      var oldItem = oldAssistants && oldAssistants[id];
      var nextItem = nextAssistants && nextAssistants[id];
      var oldExists = oldItem !== undefined;
      var nextExists = nextItem !== undefined;
      if (oldExists && nextExists && syncValueSignature(oldItem) === syncValueSignature(nextItem)) return;
      publishSyncEvent({
        scope: 'shared',
        resource: 'assistant',
        section: 'assistants',
        action: oldExists ? (nextExists ? 'updated' : 'deleted') : 'created',
        id: id,
        source: 'storage',
      });
      published = true;
    });
    if (!published && syncValueSignature(oldCatalog) !== syncValueSignature(nextCatalog)) {
      publishSyncEvent({ scope: 'shared', resource: 'assistant', section: 'assistants', action: 'changed', source: 'storage' });
    }
  }

  function publishConversationTopicSyncEvents(change) {
    var oldTopics = change && change.oldValue && change.oldValue.topics || {};
    var nextTopics = change && change.newValue && change.newValue.topics || {};
    var ids = Object.create(null);
    Object.keys(oldTopics).forEach(function (id) { ids[id] = true; });
    Object.keys(nextTopics).forEach(function (id) { ids[id] = true; });
    var published = false;
    Object.keys(ids).forEach(function (id) {
      var oldTopic = oldTopics[id];
      var nextTopic = nextTopics[id];
      var oldExists = oldTopic !== undefined;
      var nextExists = nextTopic !== undefined;
      if (oldExists && nextExists && syncValueSignature(oldTopic) === syncValueSignature(nextTopic)) return;
      publishSyncEvent({
        scope: 'runtime',
        resource: 'conversationTopic',
        section: 'topics',
        action: oldExists ? (nextExists ? 'updated' : 'deleted') : 'created',
        id: id,
        runtime: RUNTIME_SCOPE,
        source: 'storage',
      });
      published = true;
    });
    if (!published && syncValueSignature(oldTopics) !== syncValueSignature(nextTopics)) {
      publishSyncEvent({
        scope: 'runtime', resource: 'conversationTopic', section: 'topics', action: 'changed',
        runtime: RUNTIME_SCOPE, source: 'storage',
      });
    }
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[configStore.CONFIG_KEY]) {
      var storedConfig = changes[configStore.CONFIG_KEY].newValue;
      configRuntimeCoordinator.update(function () {
        return configStore.ensureConfig(cloneConfigValue(storedConfig));
      }).then(function () {
        publishConfigSyncEvents(changes[configStore.CONFIG_KEY]);
      }).catch(function (error) {
        loggingStatus.addLog('同步用户配置失败: ' + error.message, { level: 'error' });
      });
    }
    if (area === 'local' && changes[configStore.RUNS_KEY]) {
      rebuildRunInputCache(changes[configStore.RUNS_KEY].newValue || []);
    }
    if (area === 'local' && changes[MCP_RUN_TAB_MODE_STORAGE_KEY]) {
      mcpRunTabMode = normalizeRunTabMode(changes[MCP_RUN_TAB_MODE_STORAGE_KEY].newValue, DEFAULT_RUN_TAB_MODE);
      mcpTabAccessManager.clearFixedTabIfModeNotFixed(mcpRunTabMode);
    }
    if (area === 'local' && (
      changes[MCP_ENABLED_STORAGE_KEY]
      || changes[MCP_URL_STORAGE_KEY]
      || changes[MCP_CLIENT_ID_STORAGE_KEY]
      || changes[MCP_CLIENT_NAME_STORAGE_KEY]
    )) {
      setTimeout(initMCPClient, 0);
    }
  });

  function isTabClaimedByOther(self, tabId) {
    var ids = Object.keys(sessions);
    for (var i = 0; i < ids.length; i++) {
      var s = sessions[ids[i]];
      if (s === self || s.status !== 'running') continue;
      if (s.boundTabId === tabId) return true;
      var keys = Object.keys(s.tabs);
      for (var j = 0; j < keys.length; j++) {
        if (s.tabs[keys[j]] === tabId) return true;
      }
    }
    // 旧版全局控制器运行中占用的 tab（全局注册表反查）也视为占用
    if (autoRunController && autoRunController.isRunning() && tabRuntime.getSourceByTabId(tabId)) {
      return true;
    }
    return false;
  }

  function isTabClaimedByRunningSession(tabId) {
    var ids = Object.keys(sessions);
    for (var i = 0; i < ids.length; i++) {
      var s = sessions[ids[i]];
      if (s.status !== 'running') continue;
      if (s.boundTabId === tabId) return true;
      var keys = Object.keys(s.tabs);
      for (var j = 0; j < keys.length; j++) {
        if (s.tabs[keys[j]] === tabId) return true;
      }
    }
    return false;
  }

  function runningSessionForTab(tabId) {
    var ids = Object.keys(sessions);
    for (var i = 0; i < ids.length; i++) {
      var s = sessions[ids[i]];
      if (s.status !== 'running') continue;
      if (s.boundTabId === tabId) return s;
      var keys = Object.keys(s.tabs);
      for (var j = 0; j < keys.length; j++) {
        if (s.tabs[keys[j]] === tabId) return s;
      }
    }
    return null;
  }

  function updateActionIndicators() {
    if (actionIndicator) actionIndicator.update();
    if (conversationRecordingCoordinator && typeof conversationRecordingCoordinator.refreshBadge === 'function') {
      conversationRecordingCoordinator.refreshBadge().catch(function () {});
    }
  }

  function refreshActionIndicatorForTab(tabId) {
    if (actionIndicator) actionIndicator.refreshForTab(tabId);
    if (conversationRecordingCoordinator && typeof conversationRecordingCoordinator.refreshBadge === 'function') {
      conversationRecordingCoordinator.refreshBadge().catch(function () {});
    }
  }

  function clearAllActionIndicators() {
    if (actionIndicator) actionIndicator.clearAll();
  }

  function getSessionActionTabIds(session) {
    return actionIndicator ? actionIndicator.getSessionTabIds(session) : [];
  }

  function getSnapshotActionTabIds(snap) {
    return actionIndicator ? actionIndicator.getSnapshotTabIds(snap) : [];
  }

  function floatingStatusIndicatorForStatus(status) {
    if (status === 'running') return { text: 'RUN', statusClass: 'running', title: '运行中' };
    if (status === 'failed') return { text: 'ERR', statusClass: 'failed', title: '运行失败' };
    if (status === 'stopped') return { text: 'STOP', statusClass: 'stopped', title: '已停止' };
    return null;
  }

  function floatingStatusCandidate(record, status) {
    return {
      status: status,
      flowLabel: record && record.flowLabel || '',
      startedAt: Number(record && record.startedAt) || 0,
      endedAt: Number(record && (record.endedAt || record.stoppedAt)) || 0,
    };
  }

  function pickFloatingStatusCandidate(current, next) {
    if (!next) return current;
    if (!current) return next;
    if (next.status === 'running' && current.status !== 'running') return next;
    if (current.status === 'running' && next.status !== 'running') return current;
    if (next.startedAt !== current.startedAt) return next.startedAt > current.startedAt ? next : current;
    return next.endedAt > current.endedAt ? next : current;
  }

  function tabIdListHas(tabIds, tabId) {
    tabId = Number(tabId) || 0;
    if (!tabId) return false;
    for (var i = 0; i < tabIds.length; i++) {
      if (Number(tabIds[i]) === tabId) return true;
    }
    return false;
  }

  function getFloatingStatusForTab(tabId) {
    tabId = Number(tabId) || 0;
    var candidate = null;
    Object.keys(sessions || {}).forEach(function (id) {
      var session = sessions[id];
      if (!session || !tabIdListHas(getSessionActionTabIds(session), tabId)) return;
      candidate = pickFloatingStatusCandidate(candidate,
        floatingStatusCandidate(session, session.status));
    });
    Object.keys(snapshotCache || {}).forEach(function (runId) {
      if (sessions[runId]) return;
      var snap = snapshotCache[runId];
      if (!snap || !tabIdListHas(getSnapshotActionTabIds(snap), tabId)) return;
      var status = snap._isRunningSnapshot ? 'stopped' : (snap.status || 'stopped');
      candidate = pickFloatingStatusCandidate(candidate,
        floatingStatusCandidate(snap, status));
    });
    if (legacyRunBoundTabId === tabId) {
      candidate = pickFloatingStatusCandidate(candidate, floatingStatusCandidate({
        flowLabel: legacyRunFlowLabel,
        startedAt: currentRunStartedAt,
      }, legacyRunStatus));
    }
    var indicator = floatingStatusIndicatorForStatus(candidate && candidate.status);
    if (indicator && candidate.flowLabel) indicator.title += ' · ' + candidate.flowLabel;
    return indicator || { text: '', statusClass: '', title: '空闲' };
  }

  // 写入时复查占用再认领（检查与写入同步完成，杜绝异步间隙的双重认领）
  // 注意：只写会话内映射，不写全局 tabRegistry——否则多会话互相覆盖（全局表仅服务旧版路径与定时刷新）
  function claimTab(session, source, tabId) {
    if (isTabClaimedByOther(session, tabId)) return false;
    var changed = session.tabs[source] !== tabId;
    session.tabs[source] = tabId;
    updateActionIndicators();
    if (changed) broadcastSessions();
    return true;
  }

  function promoteSessionOwnerToFirstRunTab(session, usage) {
    if (!session || !usage || !usage.tabId) return false;
    if (session.primaryRunTabId) return false;
    session.primaryRunTabId = usage.tabId;
    if (session.ownerTabId === usage.tabId) return true;
    var previous = session.ownerTabId || 0;
    session.ownerTabId = usage.tabId;
    if (!session.boundTabId && normalizeRunTabMode(session.runTabMode) === RUN_TAB_MODE_FIXED_CURRENT) {
      session.boundTabId = usage.tabId;
    }
    session.addLog('会话归属已切换到首个实际运行标签页 (tabId=' + usage.tabId + (previous ? ', from=' + previous : '') + ')', { scope: 'run', tabId: usage.tabId });
    return true;
  }

  function mirrorChildTabUsageToParent(childSession, source, usage) {
    if (!childSession || !childSession.parentRunId || !usage) return false;
    var parent = sessions[childSession.parentRunId];
    if (!parent || parent.kind !== 'flowGroup' || parent.status !== 'running') return false;
    var key = childSession.runId + ':' + source;
    var flowLabel = childSession.flowLabel || childSession.flowId || '';
    var pageLabel = usage.pageId || pageIdFromSource(source) || source;
    var parentUsage = Object.assign({}, usage, {
      source: key,
      childRunId: childSession.runId,
      childFlowId: childSession.flowId || '',
      childFlowLabel: flowLabel,
      pageId: flowLabel ? (flowLabel + ' / ' + pageLabel) : pageLabel,
    });
    parent.tabUsage = parent.tabUsage || {};
    parent.tabEvents = parent.tabEvents || [];
    parent.tabUsage[key] = parentUsage;
    parent.tabEvents.push(Object.assign({ ts: Date.now(), action: 'child-' + (usage.action || 'open') }, parentUsage));
    if (parent.tabEvents.length > 200) parent.tabEvents.splice(0, parent.tabEvents.length - 200);
    promoteSessionOwnerToFirstRunTab(parent, parentUsage);
    return true;
  }

  // 标签页被关闭：清除所有会话内的映射和保活状态，并停止正在使用该标签页的流程
  chrome.tabs.onRemoved.addListener(function (closedTabId) {
    var expectedFlowClose = cdpSessionManager.consumeExpectedTabClose(closedTabId);
    Object.keys(sessions).forEach(function (id) {
      var s = sessions[id];
      var hadTab = false;
      Object.keys(s.tabs).forEach(function (source) {
        if (s.tabs[source] === closedTabId) { delete s.tabs[source]; hadTab = true; }
      });
      if (s.boundTabId === closedTabId) { s.boundTabId = 0; hadTab = true; }
      // 清理保活状态（虽然 debugger 会自动 detach，但显式清理避免 sync 尝试操作无效 tab）
      if (s.keepAliveTabs && s.keepAliveTabs[closedTabId] !== undefined) {
        if (s.keepAliveLeases && s.keepAliveLeases[closedTabId]) delete s.keepAliveLeases[closedTabId];
        delete s.keepAliveTabs[closedTabId];
      }
      // 流程运行中关闭了标签页 → 自动停止该会话
      var closedByThisSession = !!(expectedFlowClose && expectedFlowClose.owner
        && expectedFlowClose.owner === String(s.runId || ''));
      if (hadTab && s.status === 'running' && !closedByThisSession) {
        runSessionFactory.stop(s, {
          abortReason: '标签页已关闭',
          tabIds: [closedTabId],
          logMessage: '标签页已关闭 (tabId=' + closedTabId + ')，自动停止流程',
          logBeforeStop: true,
        });
      }
    });
    if (cdpTools && cdpTools.clearTab) cdpTools.clearTab(closedTabId);
    pageReadinessBarrier.clearTab(closedTabId);
    cdpSessionManager.closeTab(closedTabId).catch(function () {});
    updateActionIndicators();
  });

  chrome.tabs.onActivated.addListener(function () {
    updateActionIndicators();
  });
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (!changeInfo || (!changeInfo.status && !changeInfo.url)) return;
    refreshActionIndicatorForTab(tabId);
  });
  chrome.windows.onFocusChanged.addListener(function () {
    updateActionIndicators();
  });

  // 窗口关闭检测：用户手动关闭会话窗口后清理 windowId，避免后续 create tab 失败
  chrome.windows.onRemoved.addListener(function (closedWindowId) {
    Object.keys(sessions).forEach(function (id) {
      var s = sessions[id];
      if (s.windowId === closedWindowId) {
        s.windowId = 0;
        s.addLog('会话窗口已关闭 (windowId=' + closedWindowId + ')，后续页面将新建窗口');
      }
    });
  });

  // An unexpected detach is recovered by CdpSessionManager while preserving
  // the active lease, so an in-flight command can retry on the reattached tab.
  cdpSessionManager.onDetach(function (event) {
    if (!event || !event.tabId || event.managed === true) return;
    Object.keys(sessions).forEach(function (id) {
      var session = sessions[id];
      if (!session || !session.keepAliveTabs || !session.keepAliveTabs[event.tabId]) return;
      session.addLog('CDP 连接已断开，正在重连并重试当前页面命令 (tabId=' + event.tabId + ')', {
        level: 'warn', scope: 'run', tabId: event.tabId,
      });
    });
  });
  chrome.debugger.onEvent.addListener(function (source, method, params) {
    if (!source || !source.tabId) return;
    if (method.indexOf('Network.') === 0) {
      pageReadinessBarrier.recordNetworkEvent(source.tabId, method, params || {}, source);
      recordCdpNetworkEvent(source.tabId, method, params || {});
      return;
    }
    if (method === 'Debugger.scriptParsed') {
      recordCdpScriptEvent(source.tabId, params || {});
      return;
    }
    if (method.indexOf('Tracing.') === 0) {
      recordCdpTraceEvent(source.tabId, method, params || {});
    }
  });

  var sessionTabAccessFactory = SessionTabAccess.createSessionTabAccessFactory({
    chrome: chrome,
    cdpSessionManager: cdpSessionManager,
    pageAutomation: pageAutomation,
    getConfig: function () { return configCache; },
    pageIdFromSource: pageIdFromSource,
    hostFromUrl: hostFromUrl,
    sourceHostMatches: sourceHostMatches,
    sameUrl: sameUrl,
    normalizeRunTabMode: normalizeRunTabMode,
    runTabModeLabel: runTabModeLabel,
    isTabClaimedByOther: isTabClaimedByOther,
    claimTab: claimTab,
    promoteSessionOwnerToFirstRunTab: promoteSessionOwnerToFirstRunTab,
    mirrorChildTabUsageToParent: mirrorChildTabUsageToParent,
    broadcastSessions: broadcastSessions,
    RUN_TAB_MODE_REUSE_OPEN: RUN_TAB_MODE_REUSE_OPEN,
    RUN_TAB_MODE_FIXED_CURRENT: RUN_TAB_MODE_FIXED_CURRENT,
    RUN_TAB_MODE_FIXED_NEW: RUN_TAB_MODE_FIXED_NEW,
  });

  // 会话级 tab 访问层：与 tabRuntime 同接口，但 source→tab 映射存在会话内。
  function createSessionTabAccess(session, sessionTabRuntime) {
    return sessionTabAccessFactory.createSessionTabAccess(session, sessionTabRuntime);
  }

  function captureSessionScreenshot(session, node) {
    if (!node || !node.pageId) return Promise.resolve('');
    var tabId = session.tabs['page:' + node.pageId];
    if (!tabId) return Promise.resolve('');
    return captureTabScreenshot(tabId, 55).catch(function () { return ''; });
  }

  function broadcastSessions() {
    broadcast({ type: 'SESSIONS_UPDATED' });
    updateActionIndicators();
  }

  function pruneSessions() {
    return runSessionRegistry.pruneTerminalSessions(MAX_FINISHED_SESSIONS);
  }

  function compactActiveSessionRuntime(session, reason, options) {
    options = options || {};
    if (!session || !session.executor) return null;
    var now = Date.now();
    if (!options.force && session.lastRuntimeCompactAt && now - session.lastRuntimeCompactAt < ACTIVE_SESSION_COMPACT_INTERVAL_MS) {
      return null;
    }
    session.lastRuntimeCompactAt = now;
    if (Array.isArray(session.logs) && session.logs.length > MAX_SESSION_LOGS) {
      session.logs.splice(0, session.logs.length - MAX_SESSION_LOGS);
    }
    if (Array.isArray(session.tabEvents) && session.tabEvents.length > 200) {
      session.tabEvents.splice(0, session.tabEvents.length - 200);
    }
    if (session.executor.compactRuntimeState) {
      try {
        return session.executor.compactRuntimeState({ reason: reason || 'active-session' });
      } catch (_) {}
    }
    return null;
  }

  // 后台流程会话清理接口；当前 sidepanel 清除按钮不直接调用。
  function clearFinishedSessions() {
    var result = runSessionRegistry.clearFinished();
    broadcastSessions();
    return result;
  }

  // --- 停止快照：停止时落盘 storage.session，SW 被杀后仍可「继续」 ---

  actionIndicator = ActionIndicator.createActionIndicator({
    chrome: chrome,
    getSessions: function () { return sessions; },
    getSnapshots: function () { return snapshotCache; },
    getLegacyState: function () {
      return { boundTabId: legacyRunBoundTabId, status: legacyRunStatus, flowLabel: legacyRunFlowLabel };
    },
  });

  function persistSnapshots() {
    return runSessionRegistry.persistSnapshots();
  }

  function findStoppedNodeId(nodeStatuses) {
    return runSessionRegistry.findStoppedNodeId(nodeStatuses);
  }

  function saveRunSnapshot(session, info) {
    return runSessionRegistry.saveStoppedSnapshot(session, info || {});
  }

  // 成功/失败会话的精简快照（仅用于 SW 重启后保留运行记录，不可「继续」）
  function saveCompletedSnapshot(session, status) {
    return runSessionRegistry.saveCompletedSnapshot(session, status);
  }

  function compactFinishedSessionRuntime(session, status) {
    if (!session || !session.executor || !session.executor.getCtx || !session.executor.setCtx) return;
    try {
      var snap = runSessionRegistry.getSnapshot(session.runId);
      var compactedCtx = snap && snap.runCtx ? snap.runCtx : sanitizeStoredRuntimeValue(session.executor.getCtx());
      session.executor.setCtx(compactedCtx || {});
      if (session.executor.setLoopStack) {
        if (status === 'stopped' && snap && Array.isArray(snap.loopStack)) {
          session.executor.setLoopStack(snap.loopStack.slice());
        } else {
          session.executor.setLoopStack([]);
        }
      }
    } catch (err) {
      try {
        session.addLog('会话结束后压缩运行变量失败: ' + ((err && err.message) || String(err)), { level: 'warn', scope: 'run' });
      } catch (_) {}
    }
  }

  // SW 重启后由快照重建会话（不启动运行）
  function rehydrateSession(snap, fallbackRunId) {
    return requireRunCommandService().rehydrateSession(snap, fallbackRunId);
  }

  // 「继续」：从停止节点接续执行（保留变量/循环栈/数据行），区别于「从此节点运行」的跳过语义
  function continueSession(runId) {
    return requireRunCommandService().continueSession(runId);
  }


  var runSessionFactory = RunSession.createRunSessionFactory({
    chrome: chrome,
    tabRuntime: TabRuntime,
    modelClient: ModelClient,
    nodeExecutor: NodeExecutor,
    autoRunController: AutoRunController,
    runReport: RunReport,
    sourceRegistry: sourceRegistry,
    flowEngine: flowEngine,
    loggingStatus: loggingStatus,
    configStore: configStore,
    proxyManager: proxyManager,
    sandboxEngine: sandboxEngine,
    createSessionTabAccess: createSessionTabAccess,
    getFlowLabel: function (flowId) { return flowRegistry.getFlowLabel(flowId); },
    normalizeEntry: normalizeEntry,
    normalizeRunTabMode: normalizeRunTabMode,
    getConfiguredFlowRunTabMode: getConfiguredFlowRunTabMode,
    normalizeLogScope: normalizeLogScope,
    runTabModeLabel: runTabModeLabel,
    defaultRunTabMode: DEFAULT_RUN_TAB_MODE,
    getConfig: function () { return configCache; },
    pageHostMatchesTab: pageHostMatchesTab,
    getAssistantOrchestrator: function () { return assistantOrchestrator; },
    pageAutomation: pageAutomation,
    sleep: CoreUtils.sleep,
    now: function () { return Date.now(); },
    random: function () { return Math.random(); },
    maxSessionLogs: MAX_SESSION_LOGS,
    compactActiveSessionRuntime: compactActiveSessionRuntime,
    compactFinishedSessionRuntime: compactFinishedSessionRuntime,
    captureSessionScreenshot: captureSessionScreenshot,
    getFlowDataset: getFlowDataset,
    broadcast: broadcast,
    broadcastSessions: broadcastSessions,
    syncSwKeepAlive: syncSwKeepAlive,
    pruneSessions: pruneSessions,
    markRunReportPersistenceFailure: markRunReportPersistenceFailure,
    waitForRunReport: waitForRunReport,
    rememberRunInput: rememberRunInput,
    getReportInputFromContext: getReportInputFromContext,
    extractFlowOutputs: extractFlowOutputs,
    saveRunSnapshot: saveRunSnapshot,
    saveCompletedSnapshot: saveCompletedSnapshot,
    cloneJsonSafe: cloneJsonSafe,
    cloneRuntimeContextForResult: cloneRuntimeContextForResult,
    cloneRuntimeValueForResult: function (value) {
      return cloneRuntimeValueBounded(value, RUNTIME_RESULT_CLONE_OPTIONS);
    },
  });

  runCommandService = RunCommandService.createRunCommandService({
    registry: runSessionRegistry,
    createRunSession: function (flowId, options) {
      return runSessionFactory.create(flowId, options || {});
    },
    stopRunSession: function (session) {
      return runSessionFactory.stop(session);
    },
    getRunSessionResult: function (session, options) {
      return runSessionFactory.getResult(session, options || {});
    },
    getConfigReady: function () { return configReady; },
    getSnapshotsReady: function () { return snapshotsReady; },
    hasRegisteredFlow: function (flowId) {
      return flowRegistry.getRegisteredFlowIds().indexOf(flowId) !== -1;
    },
    getTabIncognito: function (tabId) {
      return chrome.tabs.get(tabId).then(function (tab) { return !!tab.incognito; });
    },
    buildInitialContext: buildFlowInitialContext,
    broadcastSessions: broadcastSessions,
    pruneSessions: pruneSessions,
  });

  runQueryService = RunQueryService.createRunQueryService({
    registry: runSessionRegistry,
    getRunSessionResult: function (runId, options) {
      return requireRunCommandService().getSessionResult(runId, options);
    },
    getOrderedNodes: function (flowId) { return flowEngine.getOrderedNodes(flowId); },
    getSessionActionTabIds: getSessionActionTabIds,
    getSnapshotActionTabIds: getSnapshotActionTabIds,
    resolveRunSummaryInput: resolveRunSummaryInput,
    getReportInputFromContext: getReportInputFromContext,
  });

  function isFlowSessionRunning(flowId) {
    return requireRunCommandService().isFlowSessionRunning(flowId);
  }

  // 会话运行结果（HTTP/MCP 轮询用）：含上下文变量快照
  function getSessionResult(runId, options) {
    return requireRunQueryService().getSessionResult(runId, options);
  }

  function startSessionRun(flowId, opts) {
    return requireRunCommandService().startSessionRun(flowId, opts);
  }

  function stopSession(runId) {
    return requireRunCommandService().stopSession(runId);
  }

  function stopAllSessions() {
    return requireRunCommandService().stopAllSessions();
  }

  function resumeSession(runId, nodeId) {
    return requireRunCommandService().resumeSession(runId, nodeId);
  }

  function getSessionsSummary() {
    return requireRunQueryService().getSessionsSummary();
  }

  function getSessionExecutor(runId) {
    return requireRunCommandService().getSessionExecutor(runId);
  }

  function sidepanelConversationRunId(topicId) {
    topicId = String(topicId || '').trim();
    return topicId ? 'conversation:' + topicId : '';
  }

  // Message Router
  var floatingConversationWiring = globalThis.FloatingConversationWiring.create({
    messageContract: SessionFloatingMessages,
    chrome: chrome,
    conversationRunId: sidepanelConversationRunId,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  });
  var pageConversationWiring = globalThis.PageConversationWiring.create({
    loadConversationState: function () {
      return globalThis.ConversationState.load({ fresh: true });
    },
    // 必须在首次加载完成后取"当前"缓存：storage 变更监听更新的是 cache 变量，
    // 直接返回 ready Promise 会永远拿到 service worker 启动时的旧快照。
    getModelSettings: function () {
      return conversationModelSettingsReady.then(function () { return conversationModelSettingsCache; });
    },
    listActiveConversations: function () {
      return Promise.resolve(conversationMigrationGate).then(function () {
        return conversationJournalRuntime.listActiveConversations();
      });
    },
    getConversationEvents: function (conversationId) {
      return Promise.resolve(conversationMigrationGate).then(function () {
        return conversationJournalRuntime.getAllEvents(conversationId);
      });
    },
  });

  var LOCAL_MCP_CONNECTION_ID = INCOGNITO_CONTEXT
    ? 'local-mcp-incognito'
    : 'local-mcp';

  function localMcpStorageGet() {
    var keys = [
      MCP_ENABLED_STORAGE_KEY, MCP_URL_STORAGE_KEY,
      MCP_CLIENT_ID_STORAGE_KEY, MCP_CLIENT_NAME_STORAGE_KEY,
      MCP_RUN_TAB_MODE_STORAGE_KEY,
    ];
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(keys, function (stored) {
        var error = chrome.runtime && chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(stored || {});
      });
    });
  }

  function localMcpStorageSet(values) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(values, function () {
        var error = chrome.runtime && chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(values);
      });
    });
  }

  function assertLocalMcpConnectionId(connectionId) {
    if (String(connectionId || '') !== LOCAL_MCP_CONNECTION_ID) {
      throw new Error('MCP Connection does not exist: ' + String(connectionId || ''));
    }
  }

  function redactedLocalMcpUrl(value) {
    try {
      var url = new URL(String(value || 'ws://127.0.0.1:9999'));
      url.username = '';
      url.password = '';
      return url.toString();
    } catch (_) {
      return String(value || '').replace(/^(wss?:\/\/)[^/@\s]+@/i, '$1');
    }
  }

  function readLocalMcpConnection() {
    return localMcpStorageGet().then(function (stored) {
      var incognito = INCOGNITO_CONTEXT;
      var client = mcpRuntime && typeof mcpRuntime.getClient === 'function' ? mcpRuntime.getClient() : null;
      var status = client && typeof client.getStatus === 'function' ? client.getStatus() : {};
      var enabled = stored[MCP_ENABLED_STORAGE_KEY] === true;
      var connected = enabled && status.connected === true;
      var connecting = enabled && status.connecting === true;
      return {
        id: LOCAL_MCP_CONNECTION_ID,
        kind: 'mcp-websocket',
        enabled: enabled,
        url: redactedLocalMcpUrl(stored[MCP_URL_STORAGE_KEY] || 'ws://127.0.0.1:9999'),
        clientId: String(stored[MCP_CLIENT_ID_STORAGE_KEY] || status.clientInfo && status.clientInfo.clientId || ''),
        clientName: String(stored[MCP_CLIENT_NAME_STORAGE_KEY] || status.clientInfo && status.clientInfo.clientName || ''),
        runTabMode: normalizeRunTabMode(stored[MCP_RUN_TAB_MODE_STORAGE_KEY], DEFAULT_RUN_TAB_MODE),
        state: !enabled ? 'disabled' : (connected ? 'connected' : (connecting ? 'connecting' : 'disconnected')),
        connected: connected,
        connecting: connecting,
        retryCount: Math.max(0, Number(status.retryCount) || 0),
        incognito: incognito,
        owner: { scope: 'extension-profile', incognito: incognito },
      };
    });
  }

  var localMcpConnectionRuntime = Object.freeze({
    listConnections: function () {
      return readLocalMcpConnection().then(function (connection) { return [connection]; });
    },
    getConnection: function (connectionId) {
      if (String(connectionId || '') !== LOCAL_MCP_CONNECTION_ID) return Promise.resolve(null);
      return readLocalMcpConnection();
    },
    updateConnection: function (connectionId, input) {
      assertLocalMcpConnectionId(connectionId);
      input = input && typeof input === 'object' ? input : {};
      var values = {};
      if (Object.prototype.hasOwnProperty.call(input, 'enabled')) values[MCP_ENABLED_STORAGE_KEY] = input.enabled === true;
      if (Object.prototype.hasOwnProperty.call(input, 'url')) {
        var url = new URL(String(input.url || ''));
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('MCP Connection URL must use ws/wss');
        if (url.username || url.password) throw new Error('MCP Connection URL cannot contain credentials');
        values[MCP_URL_STORAGE_KEY] = url.toString();
      }
      if (Object.prototype.hasOwnProperty.call(input, 'clientName')) {
        values[MCP_CLIENT_NAME_STORAGE_KEY] = String(input.clientName || '').trim();
      }
      if (Object.prototype.hasOwnProperty.call(input, 'runTabMode')) {
        values[MCP_RUN_TAB_MODE_STORAGE_KEY] = normalizeRunTabMode(input.runTabMode, DEFAULT_RUN_TAB_MODE);
      }
      return localMcpStorageSet(values).then(function () {
        if (!mcpRuntime || typeof mcpRuntime.initClient !== 'function') throw new Error('MCP runtime is not initialized');
        return mcpRuntime.initClient();
      }).then(readLocalMcpConnection);
    },
    attemptConnection: function (connectionId, options) {
      assertLocalMcpConnectionId(connectionId);
      options = options || {};
      return readLocalMcpConnection().then(function (connection) {
        if (!connection.enabled) throw new Error('MCP Connection is disabled');
        if (!mcpRuntime || typeof mcpRuntime.initClient !== 'function') throw new Error('MCP runtime is not initialized');
        return mcpRuntime.initClient();
      }).then(function (client) {
        if (!client || typeof client.connectAttempt !== 'function') throw new Error('MCP WebSocket client is unavailable');
        client.disconnect();
        return client.connectAttempt({ timeoutMs: options.timeoutMs });
      }).then(readLocalMcpConnection);
    },
    getConnectionLogs: function (connectionId) {
      assertLocalMcpConnectionId(connectionId);
      var client = mcpRuntime && typeof mcpRuntime.getClient === 'function' ? mcpRuntime.getClient() : null;
      var status = client && typeof client.getStatus === 'function' ? client.getStatus() : {};
      return Promise.resolve(Array.isArray(status.logs) ? status.logs : []);
    },
    clearConnectionLogs: function (connectionId) {
      assertLocalMcpConnectionId(connectionId);
      var client = mcpRuntime && typeof mcpRuntime.getClient === 'function' ? mcpRuntime.getClient() : null;
      var status = client && typeof client.getStatus === 'function' ? client.getStatus() : {};
      var removed = Array.isArray(status.logs) ? status.logs.length : 0;
      if (client && typeof client.clearLogs === 'function') client.clearLogs();
      return Promise.resolve({ removed: removed });
    },
  });

  function executeResourceNodeInstance(node, options) {
    options = options || {};
    node = node || {};
    if (!node.type) return Promise.reject(new Error('单步节点缺少 type'));
    var isolatedTabAccess = mcpTabAccessManager.createTabAccess(options.runTabMode);
    var isolatedExecutor;
    function addResourceStepLog(message, logOptions) {
      logOptions = Object.assign({}, logOptions || {});
      if (!logOptions.scope) logOptions.scope = logOptions.nodeId ? 'flow' : 'resource';
      return loggingStatus.addLog(message, logOptions);
    }
    isolatedExecutor = NodeExecutor.createNodeExecutor({
      chrome: chrome,
      tabRuntime: isolatedTabAccess,
      addLog: addResourceStepLog,
      getConfig: function () { return configCache; },
      pageAutomation: pageAutomation,
      pageHostMatchesTab: pageHostMatchesTab,
      getRunHistory: function () { return configStore.getRuns(); },
      getSandboxEngine: function () {
        return {
          turndownHtmlToMarkdown: sandboxEngine.turndownHtmlToMarkdown,
          runScript: function (code, scriptOptions) {
            return sandboxEngine.runScript(code, Object.assign({}, scriptOptions || {}, {
              apiCall: isolatedExecutor.executeApiCall,
              tag: 'resource-node-step',
              addLog: addResourceStepLog,
            }));
          },
        };
      },
      proxyManager: proxyManager,
      modelClient: modelClient,
      getAssistantOrchestrator: function () { return assistantOrchestrator; },
      runtimeScope: RUNTIME_SCOPE,
      sleep: CoreUtils.sleep,
    });
    if (options.resetContext !== false) isolatedExecutor.resetCtx();
    var context = cloneJsonSafe(options.context || {}) || {};
    isolatedExecutor.setCtx(normalizeRuntimeInputContext(context));
    var rawFlowId = String(options.flowId || '').replace(/^user:/, '');
    var flow = rawFlowId && configCache.flows && configCache.flows[rawFlowId];
    return isolatedExecutor.executeNodeInstance(node, {
      flowId: rawFlowId ? 'user:' + rawFlowId : 'resource:single-step',
      flowLabel: flow && (flow.label || flow.name) || '资源单步调试',
      nodeStatuses: {},
      assistantInvocationKind: options.assistantInvocationKind === 'runAssistant'
        ? 'runAssistant' : '',
    }).then(function (result) {
      return {
        nodeId: node.nodeId || '',
        nodeType: node.type,
        result: cloneJsonSafe(result),
        ctx: cloneJsonSafe(isolatedExecutor.getCtx()),
        debugTrace: cloneJsonSafe(isolatedExecutor.getDebugTrace ? isolatedExecutor.getDebugTrace() : []),
      };
    });
  }

  var imageArtifactStoreRuntime = null;
  var recordingStoreRuntime = globalThis.PageAutomationRecordingArtifactStore.create(
    globalThis.indexedDB,
    globalThis.IDBKeyRange,
    { crypto: globalThis.crypto, runtimeScope: RUNTIME_SCOPE, storage: chrome.storage.local }
  );
  var recordingCompilerRuntime = globalThis.PageAutomationRecordingCompiler;
  var recordingProjectorRuntime = globalThis.PageAutomationRecordingArtifactProjector;
  var conversationRecordingCoordinator = null;
  var conversationJournalRuntime = globalThis.ConversationJournalStore.create({
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
    crypto: globalThis.crypto,
    runtimeScope: RUNTIME_SCOPE,
    onMutation: function (change) {
      var conversationId = String(change && change.conversationId || '').trim();
      if (conversationId) broadcast({ type: 'CONVERSATION_JOURNAL_UPDATED', conversationId: conversationId });
    },
  });
  var conversationRecordingAttachmentsRuntime = globalThis.PageAutomationConversationRecordingAttachments.create({
    store: recordingStoreRuntime,
    journal: conversationJournalRuntime,
    resolveAssistant: function (assistantId) { return resolveConversationAssistant(assistantId); },
    onCollectionChanged: function (draftCollectionId) {
      broadcast({ type: 'CONVERSATION_RECORDING_LIBRARY_CHANGED', payload: { draftCollectionId: draftCollectionId } });
    },
  });
  var conversationJournalResourceRuntime = Object.assign({}, conversationJournalRuntime, {
    deleteConversation: function (conversationId) {
      return conversationRecordingAttachmentsRuntime.releaseConversation(conversationId);
    },
  });
  var resolveConversationMigrationGate;
  var rejectConversationMigrationGate;
  var conversationMigrationGate = new Promise(function (resolve, reject) {
    resolveConversationMigrationGate = resolve;
    rejectConversationMigrationGate = reject;
  });
  conversationMigrationGate.catch(function () {});

  function createCanonicalResourceRuntime() {
    var resourceRouter = globalThis.AgentResourceRouter;
    var conversationRuntime = globalThis.ConversationRuntime;
    var pageServiceFactory = globalThis.AgentPageService;
    if (!resourceRouter || typeof resourceRouter.createAgentResourceRouter !== 'function') {
      throw new Error('AgentResourceRouter must load before background resource assembly');
    }
    if (!conversationRuntime || typeof conversationRuntime.installResourceRuntime !== 'function'
        || typeof conversationRuntime.authorizeResourceRequest !== 'function') {
      throw new Error('ConversationRuntime must expose canonical ARP runtime installation');
    }
    if (!pageServiceFactory || typeof pageServiceFactory.createPageService !== 'function') {
      throw new Error('AgentPageService must load before background resource assembly');
    }
    if (!globalThis.ImageArtifactStore || typeof globalThis.ImageArtifactStore.createStore !== 'function') {
      throw new Error('ImageArtifactStore must load before background resource assembly');
    }
    if (!imageArtifactStoreRuntime) {
      imageArtifactStoreRuntime = globalThis.ImageArtifactStore.createStore({
        indexedDB: globalThis.indexedDB,
        crypto: globalThis.crypto,
        runtimeScope: RUNTIME_SCOPE,
      });
      imageArtifactStoreRuntime.gc().catch(function () {});
      globalThis.PageAutomationImageArtifacts = Object.freeze({
        store: imageArtifactStoreRuntime,
        releaseTopic: imageArtifactStoreRuntime.releaseTopic,
        exportTopic: imageArtifactStoreRuntime.exportTopic,
      });
    }

    var resourceOptions = {
      chrome: chrome,
      root: globalThis,
      storageArea: chrome.storage.local,
      incognito: INCOGNITO_CONTEXT,
      operationRunStorageKey: INCOGNITO_CONTEXT ? 'arp_flow_operations_incognito' : 'arp_flow_operations',
      skillCatalogStorageKey: 'arp_skill_catalog',
      connectionAttemptStorageKey: INCOGNITO_CONTEXT
        ? 'arp_model_connection_attempts_incognito'
        : 'arp_model_connection_attempts',
      mcpCallStorageKey: INCOGNITO_CONTEXT ? 'arp_mcp_calls_incognito' : 'arp_mcp_calls',
      conversationState: globalThis.ConversationState,
      conversationJournal: conversationJournalResourceRuntime,
      conversationReady: conversationMigrationGate,
      // 对话操作复用唯一入口 ConversationCommandBus；总线在本函数返回后才创建，
      // 用 getter 延迟解析（MCP/模型请求全部发生在同步装配完成之后）。
      conversationCommands: function () { return conversationCommandBus; },
      conversationExport: function (input) { return exportConversationBackup(input); },
      modelSettings: globalThis.ModelSettings,
      agentProvider: globalThis.AgentProvider,
      systemSettings: globalThis.PageAutomationSystemSettings,
      fetch: globalThis.fetch.bind(globalThis),
      knowledge: globalThis.Knowledge,
      nodeTypes: globalThis.NodeTypes,
      configStore: configStore,
      getConfig: function () {
        return Promise.resolve(configReady).then(function () {
          return configStore.getConfig();
        }).then(function (persistedConfig) {
          var runtimeConfig = cloneConfigValue(persistedConfig);
          ['pages', 'flows', 'flowGroups', 'scripts'].forEach(function (section) {
            runtimeConfig[section] = runtimeConfig[section] || {};
            var cachedSection = configCache && configCache[section] || {};
            Object.keys(cachedSection).forEach(function (id) {
              if (cachedSection[id] && cachedSection[id].__builtin === true
                  && !Object.prototype.hasOwnProperty.call(runtimeConfig[section], id)) {
                runtimeConfig[section][id] = cloneConfigValue(cachedSection[id]);
              }
            });
          });
          return runtimeConfig;
        });
      },
      mutateConfig: configMutate,
      saveConfig: configReplace,
      runCommands: requireRunCommandService(),
      runQueries: requireRunQueryService(),
      flowGroupController: flowGroupController,
      scheduler: scheduler,
      executeNodeInstance: function (node, options) {
        return executeResourceNodeInstance(node, options || {});
      },
      runScript: function (code, options) {
        return sandboxEngine.runScript(code, options || {});
      },
      httpMcpManager: httpMcpManager,
      connectionRuntime: localMcpConnectionRuntime,
      imageArtifactStore: imageArtifactStoreRuntime,
      recordingStore: recordingStoreRuntime,
      recordingProjector: recordingProjectorRuntime,
    };
    resourceOptions.resourceService = globalThis.AgentResourceService.create(resourceOptions);
    resourceOptions.recordingService = globalThis.RecordingResourceService.create(resourceOptions);
    resourceOptions.agentConfigurationService = globalThis.AgentConfigurationResourceService.create(resourceOptions);
    resourceOptions.mcpService = globalThis.McpResourceService.create(resourceOptions);

    var runtime = resourceRouter.createAgentResourceRouter({
      authorize: conversationRuntime.authorizeResourceRequest,
      resourceOptions: resourceOptions,
      adapterOptions: {
        page: {
          pageService: pageServiceFactory.createPageService({
            chrome: chrome,
            fetch: globalThis.fetch.bind(globalThis),
            imageArtifactStore: imageArtifactStoreRuntime,
            cdpSessionManager: cdpSessionManager,
            pageAutomation: pageAutomation,
          }),
        },
        browser: { cdpSessionManager: cdpSessionManager, pageAutomation: pageAutomation },
      },
    });
    runtime.imageArtifactStore = imageArtifactStoreRuntime;
    runtime.resolveImageArtifact = function (artifactUri, resolveOptions) {
      resolveOptions = resolveOptions || {};
      var topicId = String(resolveOptions.topicId || '').trim();
      if (!topicId) {
        var missingTopic = new Error('Image Artifact resolution requires a Conversation topic');
        missingTopic.code = 'ARTIFACT_ACCESS_DENIED';
        return Promise.reject(missingTopic);
      }
      return imageArtifactStoreRuntime.canAccess(artifactUri, topicId, 0).then(function (allowed) {
        if (!allowed) {
          var denied = new Error('Image Artifact does not belong to the current Conversation topic');
          denied.code = 'ARTIFACT_ACCESS_DENIED';
          throw denied;
        }
        return imageArtifactStoreRuntime.resolveImageArtifact(artifactUri, resolveOptions);
      });
    };
    conversationRuntime.installResourceRuntime(runtime);
    return runtime;
  }

  var canonicalResourceRuntime = createCanonicalResourceRuntime();

  // Conversation P0 runtime: one Journal, one Coordinator and one Command Bus.
  var conversationModelSettingsCache = globalThis.ModelSettings.normalizeSettings({});
  var conversationModelSettingsReady = new Promise(function (resolve, reject) {
    var settingsKey = globalThis.ModelSettings.SETTINGS_KEY || 'model_settings';
    chrome.storage.local.get([settingsKey], function (stored) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      try {
        conversationModelSettingsCache = globalThis.ModelSettings.normalizeSettings(
          stored && stored[settingsKey] || {}
        );
        resolve(conversationModelSettingsCache);
      } catch (error) { reject(error); }
    });
  });
  var conversationSystemSettingsCache = globalThis.PageAutomationSystemSettings.normalize({});
  var conversationSystemSettingsReady = globalThis.PageAutomationSystemSettings.load(
    chrome.storage.local,
    chrome.runtime
  ).then(function (settings) {
    conversationSystemSettingsCache = settings;
    return settings;
  });
  var conversationTopicReconcileQueue = Promise.resolve();
  var conversationTopicReconcileTimer = 0;
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local') return;
      var recordingStoreApi = globalThis.PageAutomationRecordingArtifactStore;
      var sharedRecordingChanged = changes && Object.keys(changes).some(function (storageKey) {
        if (!recordingStoreApi || typeof recordingStoreApi.isSharedMetadataKey !== 'function'
            || !recordingStoreApi.isSharedMetadataKey(storageKey)) return false;
        var metadata = changes[storageKey] && changes[storageKey].newValue;
        return !metadata || String(metadata.writerScope || '') !== RUNTIME_SCOPE;
      });
      if (sharedRecordingChanged) {
        recordingStoreRuntime.syncSharedArtifacts({ profileId: 'default' }).then(function () {
          broadcastToPageContent({ type: 'CONVERSATION_RECORDING_LIBRARY_CHANGED', payload: { shared: true } });
        }).catch(function (error) {
          console.warn('[recording] 同步共享录制失败:', error);
        });
      }
      var assistantsKey = globalThis.ConversationState.ASSISTANTS_STORAGE_KEY || 'conversation_assistants';
      if (changes && changes[assistantsKey]) {
        publishAssistantSyncEvents(changes[assistantsKey]);
        scheduleConversationTopicReconcile();
      }
      var topicKey = globalThis.ConversationState.STORAGE_KEY;
      if (topicKey && changes && changes[topicKey]) {
        publishConversationTopicSyncEvents(changes[topicKey]);
      }
      var systemKey = globalThis.PageAutomationSystemSettings.SETTINGS_KEY || 'system_settings';
      if (changes && changes[systemKey]) {
        conversationSystemSettingsCache = globalThis.PageAutomationSystemSettings.normalize(changes[systemKey].newValue || {});
      }
      var key = globalThis.ModelSettings.SETTINGS_KEY || 'model_settings';
      var changed = changes && changes[key];
      if (!changed) return;
      try {
        conversationModelSettingsCache = globalThis.ModelSettings.normalizeSettings(changed.newValue || {});
        scheduleConversationTopicReconcile();
      }
      catch (_) {}
    });
  }
  function resolveConversationServiceSync(serviceId) {
    return globalThis.ModelSettings.getService(conversationModelSettingsCache, String(serviceId || ''), false);
  }
  function resolveConversationService(serviceId) {
    return conversationModelSettingsReady.then(function () { return resolveConversationServiceSync(serviceId); });
  }
  function resolveConversationAssistant(assistantId) {
    assistantId = String(assistantId || '').trim();
    return globalThis.ConversationState.load({ fresh: true }).then(function (state) {
      var assistant = state && state.assistants && state.assistants[assistantId];
      if (!assistant) return null;
      return typeof globalThis.ConversationState.normalizeAssistantProfile === 'function'
        ? globalThis.ConversationState.normalizeAssistantProfile(assistant, { id: assistantId })
        : Object.assign({}, assistant, { id: assistantId });
    });
  }
  function resolveConversationAssistantReference(reference) {
    reference = String(reference || '').trim();
    return globalThis.ConversationState.load({ fresh: true }).then(function (state) {
      var assistants = state && state.assistants || {};
      if (assistants[reference]) return resolveConversationAssistant(reference);
      var matches = Object.keys(assistants).filter(function (assistantId) {
        return String(assistants[assistantId] && assistants[assistantId].name || '').trim() === reference;
      });
      if (!matches.length) return null;
      if (matches.length > 1) throw new Error('助手名称不唯一，请改用 assistantId: ' + reference);
      return resolveConversationAssistant(matches[0]);
    });
  }
  conversationRecordingCoordinator = globalThis.PageAutomationConversationRecordingCoordinator.create({
    chrome: chrome,
    runtimeScope: RUNTIME_SCOPE,
    store: recordingStoreRuntime,
    compiler: recordingCompilerRuntime,
    projector: recordingProjectorRuntime,
    crypto: globalThis.crypto,
    sessionMarkerKey: INCOGNITO_CONTEXT
      ? 'conversation_recording_browser_session_id_incognito'
      : 'conversation_recording_browser_session_id',
    broadcast: broadcastToPageContent,
    onBadgeReleased: updateActionIndicators,
  });
  function resolveDefaultConversationServiceId() {
    return conversationModelSettingsReady.then(function () {
      var service = globalThis.ModelSettings.getGeneratorService(conversationModelSettingsCache)
        || conversationModelSettingsCache.services && conversationModelSettingsCache.services[0];
      return service && service.id || '';
    });
  }
  function resolveConversationMetadataForBackup(conversationId) {
    conversationId = String(conversationId || '').trim();
    return globalThis.ConversationState.load({ fresh: true }).then(function (state) {
      var topic = state && state.topics && state.topics[conversationId];
      if (!topic) return null;
      if (topic.archived && typeof globalThis.ConversationState.loadArchivedTopic === 'function') {
        return globalThis.ConversationState.loadArchivedTopic(conversationId).then(function (archived) {
          return archived || topic;
        });
      }
      return topic;
    });
  }
  function resolveConversationScheduleGrant(input) {
    var scheduleId = String(input && input.entry && input.entry.currentResource || '').replace(/^\/schedules\//, '');
    return Promise.resolve(configReady).then(function () {
      var schedule = configCache && configCache.schedules && configCache.schedules[scheduleId] || {};
      var task = schedule.task || {};
      var grant = schedule.scheduleGrant || task.scheduleGrant || [];
      return (Array.isArray(grant) ? grant : []).map(function (method) { return String(method || '').toUpperCase(); });
    });
  }
  var conversationAgentRuntime = globalThis.AgentBootstrap.create({
    journal: conversationJournalRuntime,
    resourceRuntime: canonicalResourceRuntime,
    resolveService: resolveConversationService,
    resolveServiceSync: resolveConversationServiceSync,
    resolveAssistant: resolveConversationAssistant,
    resolveScheduleGrant: resolveConversationScheduleGrant,
    ready: Promise.all([conversationModelSettingsReady, conversationSystemSettingsReady]),
    modelSettings: globalThis.ModelSettings,
    chrome: chrome,
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
    crypto: globalThis.crypto,
    fetch: globalThis.fetch.bind(globalThis),
    resolveConversationMetadata: resolveConversationMetadataForBackup,
    recordingAttachments: conversationRecordingAttachmentsRuntime,
    runtimeInstanceId: 'service-worker:' + (globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID() : Date.now().toString(36)),
  });
  conversationAgentRuntime.migrationReady.then(resolveConversationMigrationGate, rejectConversationMigrationGate);

  // Journal 是对话事实源；ConversationState.topics 是配置中心的话题索引。
  // 页面/侧边栏/定时任务入口直接 START_TURN 落 Journal，必须同步补录索引，
  // 否则话题在配置中心不可见。
  function ensureConversationTopicRecord(input) {
    var conversationId = String(input && input.conversationId || '').trim();
    var assistantId = String(input && input.assistantId || '').trim();
    if (!conversationId || !assistantId) return Promise.resolve(null);
    return globalThis.ConversationState.load({ fresh: true }).then(function (state) {
      var existing = state && state.topics && state.topics[conversationId];
      var content = String(input.messageContent || '').trim();
      if (existing) {
        var patch = {};
        if (content && !String(existing.name || '').trim()) patch.name = content.slice(0, 36);
        if (content && !String(existing.objective || '').trim()) patch.objective = content.slice(0, 12000);
        return Object.keys(patch).length
          ? globalThis.ConversationState.updateTopic(conversationId, patch)
          : null;
      }
      return resolveConversationAssistant(assistantId).then(function (assistant) {
        if (!assistant) return null;
        return globalThis.ConversationState.createTopic({
          topicId: conversationId,
          assistantId: assistantId,
          strictAssistant: true,
          makeActive: false,
          name: content.slice(0, 36),
          objective: content.slice(0, 12000),
          modelServiceId: String(input.serviceId || ''),
          activeTabId: Math.max(0, Number(input.activeTabId) || 0),
        });
      });
    }).catch(function (error) {
      console.warn('[conversation] 同步话题索引失败:', conversationId, error);
      return null;
    });
  }

  function syncConversationTopicAfterDispatch(message, response) {
    if (message && message.command === 'START_TURN' && response && response.ok) {
      var input = message.input || {};
      return ensureConversationTopicRecord({
        conversationId: input.conversationId,
        assistantId: input.assistantId,
        serviceId: input.serviceId,
        messageContent: input.message && input.message.content,
        activeTabId: input.entry && input.entry.tabId,
      }).then(function () {
        return response;
      });
    }
    return response;
  }

  var conversationCommandBus = (function (bus) {
    var mutatingCommands = {
      START_TURN: true,
      CANCEL_GENERATION: true,
      STEER_GENERATION: true,
      INTERRUPT_MODEL_REQUEST: true,
      RESOLVE_INTERACTION: true,
    };
    function broadcastIfMutated(message, response) {
      if (response && response.ok && message && Object.prototype.hasOwnProperty.call(mutatingCommands, message.command)
          && message.input && message.input.conversationId) {
        broadcast({ type: 'CONVERSATION_JOURNAL_UPDATED', conversationId: String(message.input.conversationId) });
      }
    }
    return Object.freeze({
      API_VERSION: bus.API_VERSION,
      dispatch: function (message, sender) {
        return bus.dispatch(message, sender).then(function (response) {
          broadcastIfMutated(message, response);
          return syncConversationTopicAfterDispatch(message, response);
        });
      },
      dispatchInternal: function (message, surface) {
        return bus.dispatchInternal(message, surface).then(function (response) {
          broadcastIfMutated(message, response);
          return syncConversationTopicAfterDispatch(message, response);
        });
      },
    });
  })(conversationAgentRuntime.commandBus);

  assistantOrchestrator = globalThis.AssistantOrchestrator.create({
    commandBus: conversationCommandBus,
    journal: conversationAgentRuntime.journal,
    resolveAssistant: resolveConversationAssistantReference,
    resolveDefaultServiceId: resolveDefaultConversationServiceId,
    parseJson: modelClient.extractJson,
    sleep: CoreUtils.sleep,
    throwIfStopped: function () {
      if (autoRunController && autoRunController.isRunning()) autoRunController.throwIfStopped();
    },
  });

  function scheduleConversationTopicReconcile(delayMs) {
    if (conversationTopicReconcileTimer) clearTimeout(conversationTopicReconcileTimer);
    conversationTopicReconcileTimer = setTimeout(function () {
      conversationTopicReconcileTimer = 0;
      conversationTopicReconcileQueue = conversationTopicReconcileQueue.catch(function () {}).then(function () {
        if (!conversationAgentRuntime || !conversationAgentRuntime.migrationReady) return null;
        return Promise.all([
          conversationAgentRuntime.migrationReady,
          conversationModelSettingsReady,
        ]).then(reconcileConversationTopics);
      }).catch(function (error) {
        console.warn('[conversation] 话题依赖对账失败:', error);
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  var CONVERSATION_TERMINAL_STATES = Object.freeze({
    completed: true, failed: true, cancelled: true, truncated: true, blocked: true,
  });

  function deleteOrphanConversation(conversationId, metadata) {
    conversationId = String(conversationId || '').trim();
    if (!conversationId) return Promise.resolve({ deferred: false });
    var active = metadata && metadata.activeGeneration;
    var cancel = Promise.resolve({ state: active && active.state || '' });
    if (active && !CONVERSATION_TERMINAL_STATES[active.state]) {
      cancel = conversationAgentRuntime.coordinator.cancelGeneration({
        conversationId: conversationId,
        generationId: active.generationId,
        reason: 'assistant_deleted',
      }).catch(function (error) {
        if (error && (error.code === 'GENERATION_STALE' || error.code === 'CONVERSATION_NOT_FOUND')) return { state: 'cancelled' };
        throw error;
      });
    }
    return cancel.then(function (result) {
      if (result && result.state === 'cancelling') return { deferred: true };
      return conversationRecordingAttachmentsRuntime.releaseConversation(conversationId).then(function () {
        return globalThis.ConversationState.deleteTopic(conversationId);
      }).then(function () {
        return { deferred: false };
      }).catch(function (error) {
        if (error && error.code === 'CONVERSATION_ACTIVE') return { deferred: true };
        throw error;
      });
    });
  }

  // 启动和共享配置变更后对账：补齐有效索引，并删除已删除助手留下的完整运行数据链。
  function reconcileConversationTopics() {
    return Promise.all([
      conversationAgentRuntime.journal.listMetadata(),
      globalThis.ConversationState.load({ fresh: true }),
    ]).then(function (values) {
      var metadataList = Array.isArray(values[0]) ? values[0] : [];
      var state = values[1] || {};
      var topics = state.topics || {};
      var assistants = state.assistants || {};
      var metadataById = Object.create(null);
      metadataList.forEach(function (metadata) {
        if (metadata && metadata.conversationId) metadataById[metadata.conversationId] = metadata;
      });
      var configuredServices = Object.create(null);
      (conversationModelSettingsCache.services || []).forEach(function (service) {
        if (service && service.id) configuredServices[String(service.id)] = true;
      });

      var orphanIds = Object.create(null);
      Object.keys(topics).forEach(function (topicId) {
        var assistantId = String(topics[topicId] && topics[topicId].assistantId || '');
        if (!assistantId || !assistants[assistantId]) orphanIds[topicId] = true;
      });
      metadataList.forEach(function (metadata) {
        var assistantId = String(metadata && metadata.assistantId || '');
        if (metadata && metadata.conversationId && (!assistantId || !assistants[assistantId])) {
          orphanIds[metadata.conversationId] = true;
        }
      });

      var retryOrphanCleanup = false;
      var cleanOrphans = Object.keys(orphanIds).reduce(function (chain, conversationId) {
        return chain.then(function () {
          return deleteOrphanConversation(conversationId, metadataById[conversationId]).then(function (result) {
            if (result && result.deferred) retryOrphanCleanup = true;
          }).catch(function (error) {
            console.warn('[conversation] 清理孤儿话题失败:', conversationId, error);
          });
        });
      }, Promise.resolve());

      var invalidTopicServiceIds = Object.keys(topics).filter(function (topicId) {
        var topic = topics[topicId];
        var serviceId = String(topic && topic.modelServiceId || '');
        return !orphanIds[topicId]
          && !!(topic && topic.archived !== true && serviceId && !configuredServices[serviceId]);
      });
      var cleanTopics = cleanOrphans.then(function () {
        return invalidTopicServiceIds.reduce(function (chain, topicId) {
          return chain.then(function () {
            topics[topicId].modelServiceId = '';
            return globalThis.ConversationState.updateTopic(topicId, { modelServiceId: '' });
          });
        }, Promise.resolve());
      });

      return cleanTopics.then(function () {
        return metadataList.reduce(function (chain, metadata) {
          return chain.then(function () {
            if (!metadata || orphanIds[metadata.conversationId]) return null;
            var topic = metadata && topics[metadata.conversationId];
            if (!topic || topic.archived === true) return null;
            var patch = {};
            var metadataServiceId = String(metadata.serviceId || '');
            if (metadataServiceId && !configuredServices[metadataServiceId]) {
              var topicServiceId = String(topic.modelServiceId || '');
              patch.serviceId = configuredServices[topicServiceId] ? topicServiceId : '';
            }
            return Object.keys(patch).length
              ? conversationAgentRuntime.journal.putMetadata(metadata.conversationId, patch)
              : null;
          });
        }, Promise.resolve());
      }).then(function () {
        var missing = metadataList.filter(function (metadata) {
          return metadata && metadata.conversationId && metadata.assistantId
            && !orphanIds[metadata.conversationId]
            && metadata.archived !== true && metadata.deleted !== true
            && !topics[metadata.conversationId];
        });
        return missing.reduce(function (chain, metadata) {
          return chain.then(function () {
            var assistantId = String(metadata.assistantId || '');
            var serviceId = String(metadata.serviceId || '');
            if (!configuredServices[serviceId]) serviceId = '';
            return conversationAgentRuntime.journal.queryEvents(metadata.conversationId, { afterSequence: 0, limit: 20 })
              .catch(function () { return { events: [] }; })
              .then(function (page) {
                var content = '';
                (page && page.events || []).some(function (event) {
                  var message = event && event.type === 'user_message_appended'
                    && event.payload && event.payload.message;
                  if (message) content = String(message.content || '');
                  return !!message;
                });
                return ensureConversationTopicRecord({
                  conversationId: metadata.conversationId,
                  assistantId: assistantId,
                  serviceId: serviceId,
                  messageContent: content,
                });
              });
          });
        }, Promise.resolve());
      }).then(function () {
        if (retryOrphanCleanup) scheduleConversationTopicReconcile(2000);
      });
    }).catch(function (error) {
      console.warn('[conversation] 话题索引对账失败:', error);
    });
  }
  scheduleConversationTopicReconcile();
  var conversationRecovery = globalThis.ConversationRecovery.create({
    journal: conversationAgentRuntime.journal,
    coordinator: conversationAgentRuntime.coordinator,
  });
  globalThis.PageAutomationConversationRuntime = conversationAgentRuntime;

  function conversationBackupFiles(value) {
    var files = value && value.files || value;
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('对话 Journal 备份缺少 files');
    return files;
  }

  function conversationBackupMetadata(value) {
    var files = conversationBackupFiles(value);
    var raw = String(files['conversation.json'] || '');
    if (!raw) throw new Error('对话 Journal 备份缺少 conversation.json');
    var envelope = JSON.parse(raw);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('conversation.json 格式无效');
    var manifestRaw = String(files['manifest.json'] || '');
    var manifest = manifestRaw ? JSON.parse(manifestRaw) : {};
    if (manifest.format !== 'page-agent-conversation-journal'
        || Number(manifest.formatVersion) !== 3
        || Number(manifest.conversationSchemaVersion) !== 3
        || Number(envelope.schemaVersion) !== 3) {
      throw conversationArchiveError('UNSUPPORTED_LEGACY_BACKUP', '仅支持 Conversation Journal v3 归档');
    }
    if (!envelope.topicSnapshot || typeof envelope.topicSnapshot !== 'object' || Array.isArray(envelope.topicSnapshot)
        || !envelope.journalMetadata || typeof envelope.journalMetadata !== 'object' || Array.isArray(envelope.journalMetadata)) {
      throw new Error('conversation.json v3 缺少 topicSnapshot 或 journalMetadata');
    }
    return Object.assign({}, cloneJsonSafe(envelope.topicSnapshot), {
      conversationId: String(envelope.conversationId || envelope.journalMetadata.conversationId || ''),
      assistantId: String(envelope.assistantId || envelope.journalMetadata.assistantId || envelope.topicSnapshot.assistantId || ''),
    });
  }

  function syncImportedConversationMetadata(metadata, result) {
    var conversationId = String(result && result.conversationId || metadata && (metadata.conversationId || metadata.topicId) || '').trim();
    var assistantId = String(metadata && metadata.assistantId || '').trim();
    if (!conversationId || !assistantId) return Promise.reject(new Error('导入的对话缺少 conversationId 或 assistantId'));
    return resolveConversationAssistant(assistantId).then(function (assistant) {
      if (!assistant) throw new Error('导入对话引用的助手不存在: ' + assistantId);
      return globalThis.ConversationState.load({ fresh: true }).then(function (state) {
        var existing = state && state.topics && state.topics[conversationId];
        var patch = {
          name: String(metadata.name || metadata.objective || '恢复的对话').slice(0, 300),
          objective: String(metadata.objective || metadata.name || '').slice(0, 12000),
          assistantId: assistantId,
          modelServiceId: String(metadata.modelServiceId || metadata.serviceId || '').trim(),
          contextMeta: metadata.contextMeta && typeof metadata.contextMeta === 'object' ? metadata.contextMeta : {},
        };
        if (metadata.assistantSnapshot && typeof metadata.assistantSnapshot === 'object') patch.assistantSnapshot = metadata.assistantSnapshot;
        if (metadata.budgets && typeof metadata.budgets === 'object') patch.budgets = metadata.budgets;
        if (existing) return globalThis.ConversationState.updateTopic(conversationId, patch);
        return globalThis.ConversationState.createTopic(Object.assign({}, patch, {
          topicId: conversationId,
          strictAssistant: true,
          makeActive: true,
          maxIterations: Number(metadata.budgets && metadata.budgets.maxIterations) || undefined,
          maxToolCalls: Number(metadata.budgets && metadata.budgets.maxToolCalls) || undefined,
        }));
      });
    }).then(function () { return result; });
  }

  function exportConversationBackup(input) {
    input = input || {};
    var conversationId = String(input.conversationId || '').trim();
    if (!conversationId) return Promise.reject(new Error('缺少 conversationId'));
    return conversationAgentRuntime.migrationReady.then(function () {
      return conversationAgentRuntime.journal.getMetadata(conversationId);
    }).then(function (metadata) {
      if (metadata) return metadata;
      return resolveConversationMetadataForBackup(conversationId).then(function (topic) {
        if (!topic) throw new Error('对话不存在: ' + conversationId);
        return conversationAgentRuntime.journal.putMetadata(conversationId, {
          conversationId: conversationId,
          assistantId: String(topic.assistantId || ''),
          serviceId: String(topic.modelServiceId || ''),
          activeGeneration: null,
          createdAt: Number(topic.createdAt) || Date.now(),
          updatedAt: Number(topic.updatedAt) || Date.now(),
        });
      });
    }).then(function () {
      return conversationAgentRuntime.migration.exportBackup(conversationId, {
        includeReasoning: input.includeReasoning !== false,
        includePayloads: input.includePayloads !== false,
      });
    });
  }

  function importConversationBackup(input) {
    input = input || {};
    if (input.legacyTopic && typeof input.legacyTopic === 'object') {
      return Promise.reject(conversationArchiveError(
        'UNSUPPORTED_LEGACY_BACKUP',
        '仅支持 Conversation Journal v3 归档；旧版 conversation/history/events 数据不可导入'
      ));
    }
    var backup = input.backup || input.files;
    var metadata;
    try { metadata = conversationBackupMetadata(backup); }
    catch (error) { return Promise.reject(error); }
    var assistantId = String(input.assistantId || metadata.assistantId || '');
    metadata.assistantId = assistantId;
    return resolveConversationAssistant(assistantId).then(function (assistant) {
      if (!assistant) throw new Error('导入对话引用的助手不存在: ' + assistantId);
      return conversationAgentRuntime.migrationReady;
    }).then(function () {
      return conversationAgentRuntime.migration.importBackup(backup, {
        replace: input.replace === true,
        assistantId: assistantId,
      });
    }).then(function (result) {
      return syncImportedConversationMetadata(metadata, result);
    });
  }

  function trustedExtensionSender(sender) {
    var url = String(sender && sender.url || '');
    return url.indexOf('chrome-extension://' + chrome.runtime.id + '/') === 0;
  }

  function senderPageOrigin(sender) {
    try {
      var parsed = new URL(String(sender && sender.url || ''));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
    } catch (_) { return ''; }
  }

  function publicImageArtifactMetadata(metadata) {
    metadata = metadata || {};
    return {
      id: String(metadata.id || ''),
      artifactUri: String(metadata.artifactUri || ''),
      sourceKind: String(metadata.sourceKind || ''),
      representation: String(metadata.representation || ''),
      mimeType: String(metadata.mimeType || ''),
      byteLength: Math.max(0, Number(metadata.byteLength) || 0),
      width: Math.max(0, Number(metadata.width) || 0),
      height: Math.max(0, Number(metadata.height) || 0),
      sha256: String(metadata.sha256 || ''),
      detail: String(metadata.detail || 'high'),
      alt: String(metadata.alt || '').slice(0, 500),
      createdAt: Math.max(0, Number(metadata.createdAt) || 0),
    };
  }

  function getImageArtifactForUi(payload, sender) {
    payload = payload || {};
    var artifactUri = String(payload.artifactUri || '').trim();
    var topicId = String(payload.topicId || '').trim();
    if (!artifactUri || !topicId) return Promise.reject(new Error('图片请求缺少 Artifact URI 或 topicId'));
    return imageArtifactStoreRuntime.get(artifactUri).then(function (value) {
      var metadata = value.metadata || {};
      var senderTabId = trustedExtensionSender(sender) ? 0 : Number(sender && sender.tab && sender.tab.id) || 0;
      var senderOrigin = senderTabId ? senderPageOrigin(sender) : '';
      return imageArtifactStoreRuntime.canAccess(artifactUri, topicId, senderTabId, senderOrigin).then(function (allowed) {
        if (!allowed) throw new Error(senderTabId ? '页面上下文无权读取该图片' : '该图片不属于当前话题');
        var original = String(payload.variant || '') === 'original';
        var resolution = original && metadata.mimeType !== 'image/svg+xml'
          ? imageArtifactStoreRuntime.rawDataUrl(artifactUri)
          : imageArtifactStoreRuntime.resolveImageArtifact(artifactUri, { detail: original ? 'original' : 'high' });
        return resolution.then(function (resolved) {
          var publicMetadata = publicImageArtifactMetadata(metadata);
          if (resolved.mimeType) publicMetadata.mimeType = resolved.mimeType;
          return Object.assign({}, resolved, { metadata: publicMetadata });
        });
      });
    });
  }

  function exportTopicImageArtifacts(payload, sender) {
    if (!trustedExtensionSender(sender)) return Promise.reject(new Error('仅扩展页面可以导出话题图片'));
    var topicId = String(payload && payload.topicId || '').trim();
    if (!topicId) return Promise.reject(new Error('图片导出缺少 topicId'));
    return imageArtifactStoreRuntime.listByTopic(topicId).then(function (items) {
      return Promise.all(items.map(function (metadata) {
        return imageArtifactStoreRuntime.rawDataUrl(metadata.artifactUri).then(function (resolved) {
          return { metadata: publicImageArtifactMetadata(metadata), dataUrl: resolved.dataUrl };
        });
      }));
    }).then(function (files) { return { topicId: topicId, artifacts: files }; });
  }

  // 完整归档只留在后台；页面通过明确的字节 [start,end) 范围读取，避免触发 runtime 64MiB 消息上限。
  var CONVERSATION_ARCHIVE_RANGE_MAX_BYTES = 4 * 1024 * 1024;
  var CONVERSATION_ARCHIVE_EXPORT_TTL_MS = 10 * 60 * 1000;
  var conversationArchiveExports = new Map();

  function conversationArchiveError(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
  }

  function safeConversationArchiveName(value) {
    return String(value || 'topic').trim().replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^_+|_+$/g, '') || 'topic';
  }

  function conversationArchiveTimestamp(value) {
    var date = new Date(value || Date.now());
    function pad(number) { return String(number).padStart(2, '0'); }
    return date.getFullYear()
      + pad(date.getMonth() + 1)
      + pad(date.getDate())
      + '-'
      + pad(date.getHours())
      + pad(date.getMinutes())
      + pad(date.getSeconds());
  }

  function conversationArchiveImageExtension(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'image/avif') return 'avif';
    if (mimeType === 'image/svg+xml') return 'svg';
    return 'png';
  }

  function conversationArchiveExportId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return 'conversation-export-' + globalThis.crypto.randomUUID();
    }
    return 'conversation-export-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }

  function cleanupConversationArchiveExports() {
    var now = Date.now();
    conversationArchiveExports.forEach(function (entry, exportId) {
      if (!entry || Number(entry.expiresAt) <= now) conversationArchiveExports.delete(exportId);
    });
  }

  function conversationArchiveBytesToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    if (typeof btoa !== 'function') {
      throw conversationArchiveError('ARCHIVE_ENCODING_UNAVAILABLE', '当前运行时不支持导出分块编码');
    }
    var chunks = [];
    for (var offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000))));
    }
    return btoa(chunks.join(''));
  }

  async function prepareConversationArchiveExport(input) {
    input = input || {};
    var conversationId = String(input.conversationId || '').trim();
    if (!conversationId) throw conversationArchiveError('INVALID_ARCHIVE_EXPORT', '缺少 conversationId');
    var zipStore = globalThis.PageAutomationZipStore;
    if (!zipStore || typeof zipStore.create !== 'function') {
      throw conversationArchiveError('ARCHIVE_EXPORT_UNAVAILABLE', 'ZIP 归档组件未加载');
    }
    cleanupConversationArchiveExports();

    var values = await Promise.all([
      exportConversationBackup({
        conversationId: conversationId,
        includeReasoning: input.includeReasoning !== false,
        includePayloads: input.includePayloads !== false,
      }),
      imageArtifactStoreRuntime.exportTopic(conversationId),
    ]);
    var journalBackup = values[0] || {};
    var imageExport = values[1] || {};
    var journalFiles = journalBackup.files && typeof journalBackup.files === 'object'
      ? journalBackup.files : {};
    var files = Object.keys(journalFiles).map(function (name) {
      return { name: name, data: String(journalFiles[name] || '') };
    });
    if (!files.length) throw conversationArchiveError('ARCHIVE_EXPORT_EMPTY', '后台未生成 Journal 备份文件');

    var imageManifest = [];
    var imageFiles = Array.isArray(imageExport.files) ? imageExport.files : [];
    for (var imageIndex = 0; imageIndex < imageFiles.length; imageIndex += 1) {
      var item = imageFiles[imageIndex] || {};
      var metadata = publicImageArtifactMetadata(item.metadata || {});
      var id = String(metadata.id || '').replace(/[^A-Za-z0-9._~-]/g, '_') || 'image-' + (imageIndex + 1);
      var path = 'media/' + id + '.' + conversationArchiveImageExtension(metadata.mimeType || 'image/png');
      if (!item.blob || typeof item.blob.arrayBuffer !== 'function') {
        throw conversationArchiveError('ARCHIVE_IMAGE_MISSING', '对话图片数据不完整: ' + id);
      }
      imageManifest.push(Object.assign({}, metadata, { path: path }));
      files.push({ name: path, data: await item.blob.arrayBuffer() });
    }
    files.push({
      name: 'image-artifacts.json',
      data: JSON.stringify({ version: 1, artifacts: imageManifest }, null, 2),
    });

    var archive = zipStore.create(files);
    var conversationMetadata = {};
    try { conversationMetadata = JSON.parse(String(journalFiles['conversation.json'] || '{}')); }
    catch (_) {}
    var label = conversationMetadata.name || conversationMetadata.objective || conversationId;
    var filename = 'conversation-' + safeConversationArchiveName(label).slice(0, 80)
      + '-' + conversationArchiveTimestamp(Date.now()) + '.zip';
    var exportId = conversationArchiveExportId();
    var createdAt = Date.now();
    var entry = {
      exportId: exportId,
      conversationId: conversationId,
      filename: filename,
      archive: archive,
      byteLength: archive.size,
      createdAt: createdAt,
      expiresAt: createdAt + CONVERSATION_ARCHIVE_EXPORT_TTL_MS,
    };
    conversationArchiveExports.set(exportId, entry);
    setTimeout(function () {
      var current = conversationArchiveExports.get(exportId);
      if (current === entry) conversationArchiveExports.delete(exportId);
    }, CONVERSATION_ARCHIVE_EXPORT_TTL_MS);
    return {
      exportId: exportId,
      filename: filename,
      byteLength: entry.byteLength,
      maxRangeBytes: CONVERSATION_ARCHIVE_RANGE_MAX_BYTES,
      rangeUnit: 'bytes',
      rangeSemantics: '[start,end)',
      encoding: 'base64',
      createdAt: createdAt,
      expiresAt: entry.expiresAt,
    };
  }

  async function readConversationArchiveExportRange(input) {
    input = input || {};
    cleanupConversationArchiveExports();
    var exportId = String(input.exportId || '').trim();
    var start = Number(input.start);
    var end = Number(input.end);
    if (!exportId) throw conversationArchiveError('INVALID_ARCHIVE_RANGE', '缺少 exportId');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw conversationArchiveError('INVALID_ARCHIVE_RANGE', 'start/end 必须是明确的安全整数');
    }
    var entry = conversationArchiveExports.get(exportId);
    if (!entry) throw conversationArchiveError('ARCHIVE_EXPORT_EXPIRED', '导出数据已释放或过期，请重新导出');
    if (start < 0 || end < start || end > entry.byteLength) {
      throw conversationArchiveError('INVALID_ARCHIVE_RANGE', '请求范围必须在归档字节 [0,' + entry.byteLength + ') 内');
    }
    if (end - start > CONVERSATION_ARCHIVE_RANGE_MAX_BYTES) {
      throw conversationArchiveError('ARCHIVE_RANGE_TOO_LARGE', '单次最多读取 ' + CONVERSATION_ARCHIVE_RANGE_MAX_BYTES + ' 字节');
    }
    var buffer = await entry.archive.slice(start, end).arrayBuffer();
    return {
      exportId: exportId,
      start: start,
      end: end,
      byteLength: entry.byteLength,
      encoding: 'base64',
      data: conversationArchiveBytesToBase64(buffer),
    };
  }

  function releaseConversationArchiveExport(input) {
    var exportId = String(input && input.exportId || '').trim();
    if (!exportId) throw conversationArchiveError('INVALID_ARCHIVE_EXPORT', '缺少 exportId');
    return { exportId: exportId, released: conversationArchiveExports.delete(exportId) };
  }

  function importTopicImageArtifacts(payload, sender) {
    if (!trustedExtensionSender(sender)) return Promise.reject(new Error('仅扩展页面可以恢复话题图片'));
    var topicId = String(payload && payload.topicId || '').trim();
    var artifacts = payload && payload.artifacts;
    if (!topicId || !Array.isArray(artifacts) || artifacts.length > 100) {
      return Promise.reject(new Error('图片恢复请求无效或数量超限'));
    }
    return artifacts.reduce(function (chain, item) {
      return chain.then(function (results) {
        item = item || {};
        if (!/^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(String(item.dataUrl || ''))) {
          throw new Error('恢复包包含无效图片数据');
        }
        return fetch(item.dataUrl).then(function (response) { return response.blob(); }).then(function (blob) {
          return imageArtifactStoreRuntime.importRecord(blob, item.metadata || {}, topicId);
        }).then(function (record) { results.push(record); return results; });
      });
    }, Promise.resolve([])).then(function (records) {
      return { topicId: topicId, artifacts: records };
    });
  }

  function collectCanonicalTransportPermissions(runtime) {
    var permissions = Object.create(null);
    var routes = runtime && runtime.registry && runtime.registry.routes || [];
    routes.forEach(function (entry) {
      var methods = entry && entry.route && entry.route.methods || {};
      Object.keys(methods).forEach(function (method) {
        (methods[method].permissions || []).forEach(function (permission) {
          permissions[permission] = true;
        });
      });
    });
    return Object.freeze(Object.keys(permissions).sort());
  }

  var mcpTransportPermissionScope = collectCanonicalTransportPermissions(canonicalResourceRuntime);

  function webOrigin(value) {
    try {
      var parsed = new URL(String(value || ''));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
    } catch (_) { return ''; }
  }

  function activeTrustedPageContext() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        var error = chrome.runtime && chrome.runtime.lastError;
        if (error) { resolve(null); return; }
        resolve(tabs && tabs[0] || null);
      });
    });
  }

  function createTrustedMcpResourceContext(correlation, dispatchInfo) {
    correlation = correlation || {};
    dispatchInfo = dispatchInfo || {};
    var request = dispatchInfo.request || {};
    var uri = String(request.uri || '');
    var pageScoped = uri === '/page' || uri.indexOf('/page/') === 0;
    var tabPromise = pageScoped ? activeTrustedPageContext() : Promise.resolve(null);
    return tabPromise.then(function (tab) {
      return {
        actorId: 'mcp-transport:' + String(chrome.runtime.id || 'extension')
          + ':' + (chrome.extension && chrome.extension.inIncognitoContext ? 'incognito' : 'regular'),
        sessionId: String(correlation.sessionId || ''),
        conversationId: String(correlation.conversationId || correlation.sessionId || ''),
        entryContext: pageScoped ? 'page' : 'global',
        origin: pageScoped && tab ? webOrigin(tab.url || tab.pendingUrl) : 'mcp://local',
        permissionScope: mcpTransportPermissionScope.slice(),
        currentResource: uri === '/' ? '' : uri,
        visibleResourceUris: uri && uri !== '/' ? [uri] : [],
        currentTabId: pageScoped && tab ? Number(tab.id) || 0 : 0,
        currentWindowId: pageScoped && tab ? Number(tab.windowId) || 0 : 0,
        incognito: INCOGNITO_CONTEXT,
        transport: 'mcp-websocket',
      };
    });
  }

  var messageRouter = MessageRouter.createMessageRouter({
    pageAutomation: pageAutomation,
    getConfig: function () { return configCache; },
    conversationCommandBus: conversationCommandBus,
    exportConversationBackup: exportConversationBackup,
    importConversationBackup: importConversationBackup,
    prepareConversationArchiveExport: prepareConversationArchiveExport,
    readConversationArchiveExportRange: readConversationArchiveExportRange,
    releaseConversationArchiveExport: releaseConversationArchiveExport,
    dispatchResource: function (method, request, context) {
      return canonicalResourceRuntime.dispatch(method, request, context);
    },
    getState: getState,
    tabRuntime: tabRuntime,
    addLog: loggingStatus.addLog,
    setNodeStatus: loggingStatus.setNodeStatus,
    registerTab: tabRuntime.registerTab,
    executeNode: executeNode,
    getFirstUnfinishedNodeId: function (flowId, statuses) { return flowEngine.getFirstUnfinishedNodeId(flowId, statuses); },
    isNodeDoneStatus: function (s) { return flowEngine.isNodeDoneStatus(s); },
    stopSession: stopSession,
    stopAllSessions: stopAllSessions,
    getSessions: getSessionsSummary,
    getSessionExecutor: getSessionExecutor,
    clearFinishedSessions: clearFinishedSessions,
    resumeSession: resumeSession,
    continueSession: continueSession,
    requestStop: function () {
      // 停全部：会话 + 旧版全局控制器
      var stopped = stopAllSessions();
      autoRunController.requestStop();
      sandboxEngine.abortAll('流程已停止');
      pageActionEngine.cleanupOwner('').catch(function () {});
      return stopped;
    },
    detectSourceFromLocation: function (loc) { return sourceRegistry.detectSourceFromLocation(loc); },
    checkTabReadiness: function (tabId) { return pageReadiness.checkTabReadiness(tabId); },
    getOrderedNodes: function (flowId) { return flowEngine.getOrderedNodes(flowId); },
    executeNodeInstance: executeResourceNodeInstance,
    getTargetDefinitions: function (flowId) { return flowRegistry.getTargetDefinitions(flowId); },
    getSourceByTabId: tabRuntime.getSourceByTabId,
    resumeFlowFrom: resumeFlowFrom,
  });

  // --- Chrome API 事件绑定 ---

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // offscreen 中继消息：发往 offscreen 的消息由 offscreen.js 处理，background 忽略
    if (message && message.target === 'offscreen') return undefined;

    var recordingMessageResult = conversationRecordingCoordinator.handleMessage(message, sender, sendResponse);
    if (recordingMessageResult.handled) return recordingMessageResult.keepChannel ? true : undefined;

    if (message && message.type === 'IMAGE_ARTIFACT_GET') {
      getImageArtifactForUi(message.payload, sender).then(function (value) {
        sendResponse({ ok: true, payload: { dataUrl: value.dataUrl, metadata: value.metadata } });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error || '读取图片失败') });
      });
      return true;
    }

    if (message && message.type === 'IMAGE_ARTIFACT_RELEASE_TOPIC') {
      if (!trustedExtensionSender(sender)) {
        sendResponse({ ok: false, error: '仅扩展页面可以释放话题图片' });
        return undefined;
      }
      imageArtifactStoreRuntime.releaseTopic(message.payload && message.payload.topicId).then(function (value) {
        sendResponse({ ok: true, payload: value });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error || '释放图片失败') });
      });
      return true;
    }

    if (message && message.type === 'IMAGE_ARTIFACT_EXPORT_TOPIC') {
      exportTopicImageArtifacts(message.payload, sender).then(function (value) {
        sendResponse({ ok: true, payload: value });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error || '导出图片失败') });
      });
      return true;
    }

    if (message && message.type === 'IMAGE_ARTIFACT_IMPORT_TOPIC') {
      importTopicImageArtifacts(message.payload, sender).then(function (value) {
        sendResponse({ ok: true, payload: value });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error || '恢复图片失败') });
      });
      return true;
    }

    // 沙箱上行消息（脚本 API 调用 / 执行完成）
    if (message && message.target === 'background' && message.from === 'sandbox') {
      sandboxEngine.handleSandboxMessage(message.payload);
      sendResponse({ ok: true });
      return undefined;
    }

    if (message && message.target === 'background' && message.from === 'offscreen') {
      sandboxEngine.handleSandboxMessage(message.payload);
      sendResponse({ ok: true });
      return undefined;
    }

    if (message && message.type === 'OPEN_SIDEPANEL') {
      var openTarget = {
        windowId: (message.payload && message.payload.windowId) || (sender && sender.tab && sender.tab.windowId),
        tabId: (message.payload && message.payload.tabId) || (sender && sender.tab && sender.tab.id),
      };
      openSidepanelForTarget(openTarget).then(function (resp) {
        if (resp && resp.ok && message.payload && (message.payload.runId || message.payload.topicId)) {
          floatingConversationWiring.focusRun(message.payload, openTarget);
        }
        sendResponse(resp);
      });
      return true;
    }

    if (message && message.type === 'TOGGLE_SIDEPANEL') {
      toggleSidepanelForTarget({
        windowId: (message.payload && message.payload.windowId) || (sender && sender.tab && sender.tab.windowId),
        tabId: (message.payload && message.payload.tabId) || (sender && sender.tab && sender.tab.id),
      }).then(sendResponse);
      return true;
    }

    if (message && message.type === 'CLOSE_SIDEPANEL') {
      closeSidepanelForWindow(
        (message.payload && message.payload.windowId)
        || (sender && sender.tab && sender.tab.windowId)
      ).then(sendResponse);
      return true;
    }

    if (message && message.type === PageConversationMessages.TYPES.GET_VISIBILITY) {
      var visibilitySite;
      try {
        visibilitySite = pageConversationVisibilitySite(sender);
      } catch (error) {
        sendResponse({ ok: false, error: error && error.message || '无法识别当前站点' });
        return undefined;
      }
      getPageConversationVisibility(visibilitySite).then(function (open) {
        sendResponse({ ok: true, payload: { open: open } });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error || '读取页面对话显示状态失败') });
      });
      return true;
    }

    if (message && message.type === PageConversationMessages.TYPES.SET_VISIBILITY) {
      var visibilityPayload = message.payload || {};
      if (typeof visibilityPayload.open !== 'boolean') {
        sendResponse({ ok: false, error: '页面对话显示状态必须是布尔值' });
        return undefined;
      }
      var visibilitySite;
      try {
        visibilitySite = pageConversationVisibilitySite(sender);
      } catch (error) {
        sendResponse({ ok: false, error: error && error.message || '无法识别当前站点' });
        return undefined;
      }
      setPageConversationVisibility(visibilitySite, visibilityPayload.open).then(function (open) {
        sendResponse({ ok: true, payload: { open: open } });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || String(error || '保存页面对话显示状态失败') });
      });
      return true;
    }

    if (message && message.type === 'GET_FLOATING_STATUS') {
      sendResponse({
        ok: true,
        payload: getFloatingStatusForTab(sender && sender.tab && sender.tab.id),
      });
      return undefined;
    }

    if (message && message.type === PageConversationMessages.TYPES.OPEN_OPTIONS_CONVERSATION) {
      openOptionsConversation(message.payload, sender).then(function (tab) {
        sendResponse({ ok: true, payload: { tabId: tab && tab.id || 0 } });
      }, function (error) {
        sendResponse({ ok: false, error: error && error.message || '打开对话页面失败' });
      });
      return true;
    }

    var pageConversationResult = pageConversationWiring.handleMessage(message, sender, sendResponse);
    if (pageConversationResult.handled) return pageConversationResult.keepChannel ? true : undefined;

    if (message && message.type === 'OPEN_OPTIONS_PAGE') {
      openHomePage();
      sendResponse({ ok: true });
      return undefined;
    }

    // 异步处理器在 handleMessage 内部 return true，必须透传以保持响应通道
    return messageRouter.handleMessage(message, sender, sendResponse);
  });

  // 定时任务触发
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === SW_KEEPALIVE_ALARM_NAME) {
      // SW 保活心跳：alarm 事件本身已重置 SW 空闲计时器
      // 顺带保存运行中会话的快照，用于 SW 意外终止后恢复
      saveRunningSnapshots();
      return;
    }
    scheduler.handleAlarm(alarm);
  });

  // 定期保存所有运行中会话的恢复快照（SW 意外被杀后可用）
  function saveRunningSnapshots(options) {
    return runSessionRegistry.saveRunningSnapshots(options || {});
  }

  // Service Worker 活跃心跳：Chrome alarms 最小周期按 30s 级别调度。
  // MV3 仍可能终止 SW；运行中快照负责恢复，alarm 只降低长时间空闲带来的影响。
  function ensureSwKeepAlive() {
    chrome.alarms.get(SW_KEEPALIVE_ALARM_NAME, function (alarm) {
      if (!alarm) {
        chrome.alarms.create(SW_KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
      }
    });
  }

  function removeSwKeepAlive() {
    chrome.alarms.clear(SW_KEEPALIVE_ALARM_NAME, function () { void chrome.runtime.lastError; });
  }

  // 清理升级前未分域且会永久周期触发的旧心跳。
  chrome.alarms.clear('sw_keepalive', function () { void chrome.runtime.lastError; });

  // 有任何运行中的会话时开启保活，全部停止后关闭
  function syncSwKeepAlive() {
    var hasRunning = false;
    Object.keys(sessions).forEach(function (id) {
      if (sessions[id].status === 'running') hasRunning = true;
    });
    if (hasRunning) ensureSwKeepAlive();
    else removeSwKeepAlive();
  }

  var urlTriggerController = UrlTriggerController.createUrlTriggerController({
    chrome: chrome,
    getConfig: function () {
      return Promise.resolve(configReady).then(function () { return configCache; });
    },
    startFlowRun: startFlowRun,
    runFlowGroup: runFlowGroup,
    isFlowRunning: function (rawFlowId) {
      return isFlowSessionRunning('user:' + String(rawFlowId || '').replace(/^user:/, ''));
    },
    isFlowGroupRunning: function (flowGroupId) {
      return isFlowSessionRunning('flowGroup:' + String(flowGroupId || ''));
    },
    addLog: loggingStatus.addLog,
  });

  // URL 触发器：页面加载完成时检查是否匹配
  chrome.webNavigation.onCompleted.addListener(function (details) {
    urlTriggerController.handleNavigation(details).catch(function (err) {
      loggingStatus.addLog('URL 触发器处理失败: ' + (err && err.message || err), { level: 'warn' });
    });
  });

  // Service Worker 生命周期
  chrome.runtime.onStartup.addListener(function () {
    restoreState();
    loggingStatus.addLog('Service Worker 启动');
    recoverRunningSessionsIfAny();
  });

  chrome.runtime.onInstalled.addListener(function () {
    loggingStatus.addLog('扩展已安装/更新');
  });

  // SW 即将被终止时的最后保存（不可靠，仅尽力而为）
  chrome.runtime.onSuspend.addListener(function () {
    floatingConversationWiring.suspend();
    saveRunningSnapshots({ force: true });
    loggingStatus.addLog('Service Worker 即将终止，已保存运行中会话快照');
  });

  if (chrome.runtime.onSuspendCanceled && typeof chrome.runtime.onSuspendCanceled.addListener === 'function') {
    chrome.runtime.onSuspendCanceled.addListener(function () {
      floatingConversationWiring.resume();
    });
  }

  // SW 重启后恢复意外终止的会话
  function recoverRunningSessionsIfAny() {
    return Promise.all([Promise.resolve(snapshotsReady), Promise.resolve(configReady)]).then(function () {
      var recovered = 0;
      Object.keys(snapshotCache).forEach(function (runId) {
        var snap = snapshotCache[runId];
        if (!snap || !snap._isRunningSnapshot) return;
        if (runSessionRegistry.get(runId)) return;
        // 清理运行标记，转为可继续的停止快照
        var recoveredSnapshot = cloneJsonSafe(snap);
        delete recoveredSnapshot._isRunningSnapshot;
        recoveredSnapshot.status = 'stopped';
        recoveredSnapshot.canContinue = true;
        recoveredSnapshot.stopNodeId = findStoppedNodeId(recoveredSnapshot.nodeStatuses || {}) || '';
        recoveredSnapshot.stoppedAt = Date.now();
        runSessionRegistry.setSnapshot(runId, recoveredSnapshot, { persist: false });
        // 重建会话
        var session = rehydrateSession(recoveredSnapshot, runId);
        session.addLog('⚠️ Service Worker 曾被意外终止，会话已从快照恢复。可手动「继续」执行');
        recovered++;
      });
      if (recovered) {
        persistSnapshots();
        broadcastSessions();
        loggingStatus.addLog('已恢复 ' + recovered + ' 个因 SW 终止而中断的会话（可在侧边栏「继续」）');
      }
      return recovered;
    }).catch(function (error) {
      loggingStatus.addLog('恢复运行会话快照失败: ' + ((error && error.message) || error), {
        level: 'warn',
        scope: 'system',
      });
      return 0;
    });
  }

  var ACTION_CONTEXT_MENU_OPEN_HOME = 'pageAutomation.openHome';
  var ACTION_CONTEXT_MENU_OPEN_SIDEPANEL = 'pageAutomation.openSidepanel';
  var sidepanelPortsByWindowId = {};

  function ignoreLastError() {
    try { void chrome.runtime.lastError; } catch (_) {}
  }

  function normalizeWindowId(value) {
    var windowId = Number(value);
    return Number.isFinite(windowId) && windowId > 0 ? windowId : 0;
  }

  function registerSidepanelPort(port, windowId) {
    windowId = normalizeWindowId(windowId);
    if (!port || !windowId) return;
    if (port._pageAutomationWindowId && port._pageAutomationWindowId !== windowId) {
      var previousKey = String(port._pageAutomationWindowId);
      if (sidepanelPortsByWindowId[previousKey] === port) delete sidepanelPortsByWindowId[previousKey];
    }
    port._pageAutomationWindowId = windowId;
    sidepanelPortsByWindowId[String(windowId)] = port;
  }

  function unregisterSidepanelPort(port) {
    if (!port || !port._pageAutomationWindowId) return;
    var key = String(port._pageAutomationWindowId);
    if (sidepanelPortsByWindowId[key] === port) delete sidepanelPortsByWindowId[key];
  }

  function isSidepanelOpenForWindow(windowId) {
    windowId = normalizeWindowId(windowId);
    return !!(windowId && sidepanelPortsByWindowId[String(windowId)]);
  }

  function toggleSidepanelForTarget(target) {
    target = target || {};
    var windowId = normalizeWindowId(target.windowId);
    if (windowId && isSidepanelOpenForWindow(windowId)) {
      return closeSidepanelForWindow(windowId).then(function (resp) {
        if (resp && resp.ok) delete sidepanelPortsByWindowId[String(windowId)];
        return resp;
      });
    }
    return openSidepanelForTarget(target);
  }

  function openSidepanelForTarget(target) {
    target = target || {};
    if (!chrome.sidePanel || !chrome.sidePanel.open) {
      return Promise.resolve({ ok: false, reason: 'unsupported' });
    }
    var windowId = Number(target.windowId);
    var tabId = Number(target.tabId);
    var options = {};
    if (Number.isFinite(windowId) && windowId > 0) options.windowId = windowId;
    else if (Number.isFinite(tabId) && tabId > 0) options.tabId = tabId;
    else return Promise.resolve({ ok: false, reason: 'missing-target' });
    try {
      return Promise.resolve(chrome.sidePanel.open(options)).then(function () {
        return { ok: true, action: 'opened' };
      }).catch(function (err) {
        return {
          ok: false,
          reason: 'open-failed',
          error: err && err.message ? err.message : String(err || ''),
        };
      });
    } catch (err) {
      return Promise.resolve({
        ok: false,
        reason: 'open-failed',
        error: err && err.message ? err.message : String(err || ''),
      });
    }
  }

  function openSidepanelForWindow(windowId) {
    return openSidepanelForTarget({ windowId: windowId });
  }

  function closeSidepanelForWindow(windowId) {
    windowId = normalizeWindowId(windowId);
    if (!windowId) return Promise.resolve({ ok: false, reason: 'missing-target' });
    function closeViaLifecyclePort(reason) {
      var port = sidepanelPortsByWindowId[String(windowId)];
      if (!port || !port.postMessage) {
        return Promise.resolve({ ok: false, reason: reason || 'unsupported' });
      }
      try {
        port.postMessage({ type: 'CLOSE_SIDEPANEL' });
        return Promise.resolve({ ok: true, action: 'closed', via: 'port-fallback' });
      } catch (_) {
        return Promise.resolve({ ok: false, reason: 'close-failed' });
      }
    }
    if (!chrome.sidePanel || typeof chrome.sidePanel.close !== 'function') {
      return closeViaLifecyclePort('unsupported');
    }
    try {
      var options = { windowId: windowId };
      return Promise.resolve(chrome.sidePanel.close(options)).then(function () {
        return { ok: true, action: 'closed' };
      }).catch(function () {
        return closeViaLifecyclePort('close-failed');
      });
    } catch (_) {
      return closeViaLifecyclePort('close-failed');
    }
  }

  function openHomePage() {
    try {
      var optionsPromise = chrome.runtime.openOptionsPage();
      if (optionsPromise && optionsPromise.catch) optionsPromise.catch(function () {});
    } catch (_) {}
  }

  function openOptionsConversation(payload, sender) {
    payload = payload || {};
    var assistantId = String(payload.assistantId || '').trim().slice(0, 1000);
    var topicId = String(payload.topicId || '').trim().slice(0, 1000);
    var query = ['section=conversation'];
    if (assistantId) query.push('assistantId=' + encodeURIComponent(assistantId));
    if (topicId) query.push('topicId=' + encodeURIComponent(topicId));
    var createProperties = {
      active: true,
      url: chrome.runtime.getURL('options/options.html') + '?' + query.join('&'),
    };
    var windowId = Number(sender && sender.tab && sender.tab.windowId);
    if (Number.isInteger(windowId) && windowId > 0) createProperties.windowId = windowId;
    return Promise.resolve(chrome.tabs.create(createProperties));
  }

  function setupActionContextMenu() {
    if (!chrome.contextMenus) return;
    function removeExistingMenus(callback) {
      var ids = [
        ACTION_CONTEXT_MENU_OPEN_HOME,
        ACTION_CONTEXT_MENU_OPEN_SIDEPANEL,
        'pageAutomation.toggleFloatingStatus',
      ];
      var index = 0;
      function removeNext() {
        if (index >= ids.length) {
          callback();
          return;
        }
        var id = ids[index++];
        try {
          chrome.contextMenus.remove(id, function () {
            ignoreLastError();
            removeNext();
          });
        } catch (_) {
          removeNext();
        }
      }
      removeNext();
    }
    function createMenus() {
      try {
        chrome.contextMenus.create({
          id: ACTION_CONTEXT_MENU_OPEN_HOME,
          title: '主页',
          contexts: ['action'],
        }, ignoreLastError);
        chrome.contextMenus.create({
          id: ACTION_CONTEXT_MENU_OPEN_SIDEPANEL,
          title: '侧边栏',
          contexts: ['action'],
        }, ignoreLastError);
      } catch (_) {}
    }
    try {
      removeExistingMenus(function () {
        createMenus();
      });
    } catch (_) {
      createMenus();
    }
  }

  // Action 左键直接打开侧边栏；Chrome 的右键菜单仍由浏览器托管，自定义项只能追加。
  try {
    var behaviorPromise = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    if (behaviorPromise && behaviorPromise.catch) behaviorPromise.catch(function () {});
  } catch (_) {}
  if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(function (tab) {
      openSidepanelForWindow(tab && tab.windowId);
    });
  }
  if (chrome.runtime && chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener(function (port) {
      if (!port || port.name !== 'page-automation-sidepanel') return;
      port.onMessage.addListener(function (message) {
        if (message && message.type === 'SIDEPANEL_WINDOW') {
          registerSidepanelPort(port, message.windowId);
        }
      });
      port.onDisconnect.addListener(function () {
        unregisterSidepanelPort(port);
      });
    });
  }
  setupActionContextMenu();
  if (chrome.contextMenus && chrome.contextMenus.onClicked) {
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
      if (!info) return;
      if (info.menuItemId === ACTION_CONTEXT_MENU_OPEN_HOME) {
        openHomePage();
        return;
      }
      if (info.menuItemId === ACTION_CONTEXT_MENU_OPEN_SIDEPANEL) {
        openSidepanelForWindow(tab && tab.windowId);
        return;
      }
    });
  }
  clearAllActionIndicators();

  // --- 初始化 ---
  restoreState();
  buildStepRegistry();
  var configReady = Promise.all([loadAndApplyConfig(), builtinSkillsReady]).then(function (parts) {
    return parts[0];
  });
  pageReadiness = PageReadiness.createPageReadiness({
    chrome: chrome,
    pageAutomation: pageAutomation,
    getConfigReady: function () { return configReady; },
    getConfig: function () { return configCache; },
    pageHostMatchesTab: pageHostMatchesTab,
    foregroundTabForAutomation: function (tabId) { return tabRuntime.foregroundTabForAutomation(tabId); },
  });
  refreshRunInputCache();

  // --- MCP runtime / WebSocket client ---
  var cdpTools = CdpTools.createCdpTools({
    cdpClient: cdpClient,
    cdpSessionManager: cdpSessionManager,
    tabAccessManager: mcpTabAccessManager,
    addLog: loggingStatus.addLog,
    sourceRegistry: sourceRegistry,
    hostFromUrl: hostFromUrl,
    pageAutomation: pageAutomation,
  });
  pageAutomation.registerDiagnosticProvider(cdpTools);

  function recordCdpNetworkEvent(tabId, method, params) {
    return cdpTools.recordNetworkEvent(tabId, method, params);
  }

  function recordCdpScriptEvent(tabId, params) {
    return cdpTools.recordScriptEvent(tabId, params);
  }

  function recordCdpTraceEvent(tabId, method, params) {
    return cdpTools.recordTraceEvent(tabId, method, params);
  }

  function pageHostMatchesTab(page, source, tab) {
    return cdpTools.pageHostMatchesTab(page, source, tab);
  }

  var mcpRuntime = McpRuntime.createMcpRuntime({
    chrome: chrome,
    addLog: loggingStatus.addLog,
    dispatchResource: function (method, request, context) {
      return canonicalResourceRuntime.dispatch(method, request, context);
    },
    createTrustedContext: createTrustedMcpResourceContext,
  });

  function initMCPClient() {
    return mcpRuntime.initClient();
  }


  configReady.then(initMCPClient);
  Promise.all([configReady, conversationModelSettingsReady]).then(function () {
    return conversationAgentRuntime.migrationReady.then(function () {
      return conversationRecordingAttachmentsRuntime.reconcile();
    }).then(function () {
      return conversationRecovery.recoverActiveGenerations();
    });
  }).catch(function (error) {
    loggingStatus.addLog('对话恢复失败: ' + (error && error.message || String(error)), {
      level: 'error',
      scope: 'conversation',
    });
  });

  // --- 暴露关键 API 到全局作用域（供其他模块访问） ---
  self.AutomationFramework = {
    getState: getState,
    setState: setState,
    flowRegistry: flowRegistry,
    sourceRegistry: sourceRegistry,
    flowEngine: flowEngine,
    tabRuntime: tabRuntime,
    loggingStatus: loggingStatus,
    autoRunController: autoRunController,
    settingsSchema: settingsSchema,
    flowCapabilities: flowCapabilities,
    configStore: configStore,
    nodeExecutor: nodeExecutor,
    sandboxEngine: sandboxEngine,
    dynamicFlowBuilder: dynamicFlowBuilder,
    scheduler: scheduler,
  };

})();
