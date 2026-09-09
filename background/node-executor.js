// Node Executor — 声明式节点实例的通用执行器
// 同一批能力同时服务于：流程节点执行 + 沙箱脚本 API 桥（保证脚本拥有全部节点能力）
(function attachNodeExecutor(root, factory) {
  root.NodeExecutor = factory();
})(globalThis, function () {

  var MAX_WEBHOOK_BODY_LENGTH = 64 * 1024;
  var DELAY_CHUNK_MS = 1000;
  var CHECKPOINTS_KEY = 'automation_checkpoints';
  var MAX_RUN_ARTIFACTS = 30;
  var MAX_COVERAGE_MARKS = 1000;
  var MAX_LAST_CONTENT_SHORTCUT_SIZE = 256 * 1024;
  var executorSequence = 0;

  function createNodeExecutor(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var tabRuntime = deps.tabRuntime;
    var rawAddLog = deps.addLog || (function () {});
    var getConfig = deps.getConfig || (function () { return { pages: {}, scripts: {} }; });
    var getSandboxEngine = deps.getSandboxEngine || (function () { return null; });
    var getSession = deps.getSession || (function () { return null; });
    var getAbortSignal = deps.getAbortSignal || (function () { return null; });
    var pageAutomation = deps.pageAutomation;
    if (!pageAutomation || typeof pageAutomation.executeCommand !== 'function') throw new Error('NodeExecutor requires PageAutomationRuntime');
    var proxyManager = deps.proxyManager || null;
    var getRunHistory = deps.getRunHistory || (function () { return Promise.resolve([]); });
    var throwIfStopped = deps.throwIfStopped || (function () {});
    var sleep = deps.sleep || (function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); });
    var modelClient = deps.modelClient || null;
    var getAssistantOrchestrator = deps.getAssistantOrchestrator || function () { return null; };
    var pageHostMatchesTab = deps.pageHostMatchesTab || null;
    var runtimeScope = String(deps.runtimeScope || '') === 'incognito' ? 'incognito' : 'regular';
    var checkpointsKey = runtimeScope === 'incognito' ? CHECKPOINTS_KEY + '_incognito' : CHECKPOINTS_KEY;

    // --- 运行上下文（每轮运行重置，不持久化） ---

    var runCtx = {};
    var loopStack = [];
    var debugTrace = []; // 调试追踪记录
    var debugEnabled = true; // 调试追踪开关（默认开启）
    var MAX_DEBUG_TRACE = 50; // 最大追踪记录数，长流程只保留最近记录
    var TRACE_CONTEXT_SNAPSHOT_BUDGET = 64 * 1024;
    var TRACE_VALUE_BUDGET = 16 * 1024;
    var TRACE_STRING_PREVIEW = 2048;
    var TRACE_ARRAY_ITEMS = 50;
    var TRACE_OBJECT_KEYS = 80;
    var TRACE_MAX_DEPTH = 6;
    var executorId = ++executorSequence;
    var executionFrameSequence = 0;
    var currentLogNode = null;
    var currentLogNodeFrames = [];
    var pageLifecycleOps = null;

    function addLog(message, options) {
      return addLogWithFrame(currentLogNode, message, options);
    }

    function addLogWithFrame(frame, message, options) {
      options = Object.assign({}, options || {});
      if (frame) {
        if (!options.nodeId && frame.nodeId) options.nodeId = frame.nodeId;
        if (!options.scope) options.scope = 'flow';
      }
      return rawAddLog(message, options);
    }

    function nodeOwnDataValue(node, key, fallback) {
      try {
        var descriptor = Object.getOwnPropertyDescriptor(node, key);
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ? descriptor.value
          : fallback;
      } catch (_) {
        return fallback;
      }
    }

    function safeContextKey(key) {
      return typeof key === 'string'
        && key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
    }

    function copyContextData(value) {
      var output = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
      Object.keys(value).forEach(function (key) {
        if (!safeContextKey(key)) return;
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) output[key] = descriptor.value;
      });
      return output;
    }

    function createExecutionFrame(node) {
      var commandOptions = {};
      var idempotent = nodeOwnDataValue(node, 'idempotent', undefined);
      if (idempotent !== undefined && idempotent !== null && idempotent !== '') commandOptions.idempotent = idempotent;
      Object.freeze(commandOptions);
      return Object.freeze({
        instanceId: 'nodeExecution_' + executorId.toString(36) + '_' + (++executionFrameSequence).toString(36),
        nodeId: nodeOwnDataValue(node, 'nodeId', '') || '',
        nodeType: nodeOwnDataValue(node, 'type', '') || '',
        nodeTitle: nodeOwnDataValue(node, 'title', '') || '',
        foreground: nodeOwnDataValue(node, 'foreground', false) === true,
        requiresForeground: nodeOwnDataValue(node, 'requiresForeground', false) === true,
        reveal: nodeOwnDataValue(node, 'reveal', false) === true,
        commandOptions: commandOptions,
      });
    }

    function createExecutionScope(frame) {
      var active = true;
      var execution = { frame: frame, signal: getAbortSignal() };
      execution.addLog = function (message, options) {
        if (!active) return false;
        return addLogWithFrame(frame, message, options);
      };
      execution.perceivePage = function (pageId, command, params) {
        if (!active) return Promise.reject(new Error('节点执行已结束，页面 API 不再可用'));
        return perceivePage(pageId, command, params, execution);
      };
      execution.actPage = function (pageId, command, params) {
        if (!active) return Promise.reject(new Error('节点执行已结束，页面 API 不再可用'));
        return actPage(pageId, command, params, execution);
      };
      execution.verifyPage = function (pageId, command, params) {
        if (!active) return Promise.reject(new Error('节点执行已结束，页面 API 不再可用'));
        return verifyPage(pageId, command, params, execution);
      };
      execution.executeApiCall = function (api, args) {
        if (!active) return Promise.reject(new Error('节点执行已结束，脚本 API 不再可用'));
        return executeApiCall(api, args, execution);
      };
      return Object.freeze({
        scope: Object.freeze(execution),
        release: function () { active = false; },
      });
    }

    function logForExecution(execution, message, options) {
      return execution && execution.addLog
        ? execution.addLog(message, options)
        : addLogWithFrame(null, message, options);
    }

    function formatLogTimestamp(value) {
      var date = new Date(Number(value) || Date.now());
      function pad(number, length) {
        var text = String(number);
        while (text.length < length) text = '0' + text;
        return text;
      }
      return pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2)
        + '.' + pad(date.getMilliseconds(), 3);
    }

    function pushCurrentLogNode(frame) {
      currentLogNodeFrames.push(frame);
      currentLogNode = frame;
      return frame;
    }

    function removeCurrentLogNode(frame) {
      var index = currentLogNodeFrames.indexOf(frame);
      if (index !== -1) currentLogNodeFrames.splice(index, 1);
      currentLogNode = currentLogNodeFrames.length
        ? currentLogNodeFrames[currentLogNodeFrames.length - 1]
        : null;
    }

    function resetCtx() {
      runCtx = {};
      loopStack = [];
      debugTrace = [];
      if (pageLifecycleOps) pageLifecycleOps.resetRuntimeState();
    }

    function getCtx() {
      return runCtx;
    }

    var nodeDispatcherModule = deps.nodeDispatcher || globalThis.NodeDispatcher;
    if (!nodeDispatcherModule || nodeDispatcherModule.API_VERSION !== 1
        || typeof nodeDispatcherModule.createNodeDispatcher !== 'function') {
      throw new Error('NodeDispatcher 节点路由模块未加载');
    }
    var nodeScriptOpsModule = deps.nodeScriptOps || globalThis.NodeScriptOps;
    if (!nodeScriptOpsModule || nodeScriptOpsModule.API_VERSION !== 1
        || typeof nodeScriptOpsModule.createScriptOps !== 'function') {
      throw new Error('NodeScriptOps 脚本节点模块未加载');
    }
    var nodePageLifecycleOpsModule = deps.nodePageLifecycleOps || globalThis.NodePageLifecycleOps;
    if (!nodePageLifecycleOpsModule || nodePageLifecycleOpsModule.API_VERSION !== 1
        || typeof nodePageLifecycleOpsModule.createPageLifecycleOps !== 'function') {
      throw new Error('NodePageLifecycleOps 页面生命周期模块未加载');
    }
    var nodePageEvaluateOpsModule = deps.nodePageEvaluateOps || globalThis.NodePageEvaluateOps;
    if (!nodePageEvaluateOpsModule || nodePageEvaluateOpsModule.API_VERSION !== 2
        || typeof nodePageEvaluateOpsModule.createPageEvaluateOps !== 'function') {
      throw new Error('NodePageEvaluateOps 页面执行桥模块未加载');
    }
    var nodeAssertionOpsModule = deps.nodeAssertionOps || globalThis.NodeAssertionOps;
    if (!nodeAssertionOpsModule || nodeAssertionOpsModule.API_VERSION !== 1
        || typeof nodeAssertionOpsModule.createAssertionOps !== 'function') {
      throw new Error('NodeAssertionOps 断言节点模块未加载');
    }
    var nodeExecutionContractModule = deps.nodeExecutionContract || globalThis.NodeExecutionContract;
    if (!nodeExecutionContractModule || typeof nodeExecutionContractModule.createNodeExecutionContract !== 'function') {
      throw new Error('NodeExecutionContract 节点执行契约未加载');
    }
    var executionContract = nodeExecutionContractModule.createNodeExecutionContract({
      Template: globalThis.Template,
      NodeTypes: globalThis.NodeTypes,
      FlowData: globalThis.FlowData,
      getRunCtx: function () { return runCtx; },
      addLog: addLog,
      splitList: splitList,
      deleteObjectPath: deleteObjectPath,
    });

    // 恢复执行用：整体替换上下文/循环栈（须在 startAutoRunLoop 之前调用）
    function setCtx(obj) {
      runCtx = copyContextData(obj);
    }

    function setLoopStack(arr) {
      loopStack = Array.isArray(arr) ? arr : [];
    }

    function getDebugTrace() {
      return debugTrace;
    }

    function setDebugEnabled(enabled) {
      debugEnabled = !!enabled;
    }

    // --- 页面生命周期 ---

    pageLifecycleOps = nodePageLifecycleOpsModule.createPageLifecycleOps({
      chrome: chrome,
      tabRuntime: tabRuntime,
      getConfig: getConfig,
      getSession: getSession,
      getRunCtx: function () { return runCtx; },
      throwIfStopped: throwIfStopped,
      logForExecution: logForExecution,
      pageHostMatchesTab: pageHostMatchesTab,
      executePageCommand: function (command, params, commandExecution) {
        return executeUnifiedPageCommand('', command, params, commandExecution, 'flow');
      },
    });

    function pageSource(pageId) { return pageLifecycleOps.pageSource(pageId); }
    function runtimeTargetSource(pageId, tabId) { return pageLifecycleOps.runtimeTargetSource(pageId, tabId); }
    function runtimeTabIdFromParams(params) { return pageLifecycleOps.runtimeTabIdFromParams(params); }
    function requireRuntimeTabId(params, actionLabel) { return pageLifecycleOps.requireRuntimeTabId(params, actionLabel); }
    function getRememberedPageTabId(pageId) { return pageLifecycleOps.getRememberedPageTabId(pageId); }
    function foregroundRequested(options) { return pageLifecycleOps.foregroundRequested(options); }
    function mergeNodeForegroundOptions(node, params) { return pageLifecycleOps.mergeNodeForegroundOptions(node, params); }
    function raceWithStop(promise) { return pageLifecycleOps.raceWithStop(promise); }
    function openPage(pageId, options, execution) { return pageLifecycleOps.openPage(pageId, options, execution); }
    function refreshPage(pageId, options, execution) { return pageLifecycleOps.refreshPage(pageId, options, execution); }
    function navigatePage(pageId, url, options, execution) { return pageLifecycleOps.navigatePage(pageId, url, options, execution); }
    function ensurePageReady(pageId, execution) { return pageLifecycleOps.ensurePageReady(pageId, execution); }

    function executeUnifiedPageCommand(pageId, command, params, execution, source) {
      params = Object.assign({}, params || {});
      var resolveTab = pageId
        ? ensurePageReady(pageId, execution)
        : requireRuntimeTabId(params, command);
      return resolveTab.then(function (resolvedTabId) {
        if (!(Number(resolvedTabId) > 0)) throw new Error(command + ' 无法取得目标页面 tabId');
        params.tabId = resolvedTabId;
        var internalPageLoadWait = command === 'waitForPageLoad' && params.internalLifecycleWait === true;
        var pageLoadWaitLabel = internalPageLoadWait ? '内部导航加载检查' : '等待页面加载';
        // Tab activation must be the first recovery step. Preparing the page
        // command first can attempt session-level CDP on a historical or
        // discarded tab before Chrome has made that tab active.
        var prepared = command === 'activateTab'
          ? Promise.resolve(resolvedTabId)
          : (typeof tabRuntime.preparePageCommandTab === 'function'
            ? tabRuntime.preparePageCommandTab(resolvedTabId, params)
            : Promise.resolve(resolvedTabId));
        return prepared.then(function () {
          if (command !== 'waitForPageLoad') logForExecution(execution, '统一页面引擎: ' + command + ' tabId=' + resolvedTabId);
          if (command === 'waitForPageLoad') {
            logForExecution(execution, '开始' + pageLoadWaitLabel + ': tabId=' + resolvedTabId, { level: 'info' });
            if (typeof params.onProgress !== 'function') {
              params.onProgress = function (progress) {
                progress = progress || {};
                var checks = progress.loadChecks || {};
                logForExecution(execution, pageLoadWaitLabel + '中: tabId=' + resolvedTabId
                  + ' elapsed=' + (Number(progress.elapsedMs) || 0) + 'ms'
                  + ' status=' + String(checks.tabStatus || 'unknown')
                  + ' readyState=' + String(checks.readyState || 'unknown')
                  + ' loader=' + String(checks.loaderId || 'unknown')
                  + ' pendingUrl=' + String(checks.pendingUrl || '')
                  + ' loadEvidence=' + String(checks.hasLoadEvidence === true ? (checks.loadEvidence || 'yes') : 'no')
                  + ' stable=' + (checks.observationStable === true ? 'yes' : 'no'), { level: 'info' });
              };
            }
            params.onStableWindowStart = function () {
              logForExecution(execution, pageLoadWaitLabel + '完成: tabId=' + resolvedTabId
                + '；等待窗口稳定开始');
            };
            params.onStableWindowComplete = function () {
              logForExecution(execution, pageLoadWaitLabel + '完成: tabId=' + resolvedTabId
                + '；等待窗口稳定完成');
            };
          }
          var session = getSession();
          return pageAutomation.executeCommand(command, params, {
            source: source || 'flow', owner: session && session.runId || '', pageId: pageId || '',
            signal: execution && execution.signal || null,
          })
            .then(function (result) {
              if (command !== 'waitForPageLoad') return result;
              var checks = result && result.loadChecks || {};
              logForExecution(execution, pageLoadWaitLabel + '完成');
              logForExecution(execution, 'tabId=' + resolvedTabId
                + ' Tab.status=' + String(checks.tabStatus || result && result.tabStatus || 'unknown')
                + ' readyState=' + String(checks.readyState || result && result.readyState || 'unknown')
                + '；当前 loader 的 load证据=' + String(checks.loadEvidence || result && result.loadEvidence || '无'));
              return result;
            }, function (error) {
              if (command === 'waitForPageLoad') {
                var details = error && error.details || {};
                var failedChecks = details.loadChecks || {};
                logForExecution(execution, pageLoadWaitLabel + '失败', { level: 'warn' });
                logForExecution(execution, 'tabId=' + resolvedTabId
                  + ' Tab.status=' + String(failedChecks.tabStatus || 'unknown')
                  + ' readyState=' + String(failedChecks.readyState || 'unknown')
                  + '；当前 loader 的 load证据=' + String(failedChecks.loadEvidence || '无'), { level: 'warn' });
              }
              throw error;
            });
        });
      });
    }

    function perceivePage(pageId, command, params, execution) {
      return executeUnifiedPageCommand(pageId, command, params, execution, 'flow');
    }

    function actPage(pageId, command, params, execution) {
      if (command === 'reload') return refreshPage(pageId, params, execution);
      if (command === 'navigate') return navigatePage(pageId, params && params.url, params, execution);
      return executeUnifiedPageCommand(pageId, command, params, execution, 'flow');
    }

    function verifyPage(pageId, command, params, execution) {
      return executeUnifiedPageCommand(pageId, command, params, execution, 'flow');
    }

    var pageEvaluateOps = nodePageEvaluateOpsModule.createPageEvaluateOps({
      requireRuntimeTabId: requireRuntimeTabId,
      ensurePageReady: ensurePageReady,
      executePageCommand: function (command, params, commandExecution) {
        return executeUnifiedPageCommand('', command, params, commandExecution, 'flow');
      },
      logForExecution: logForExecution,
      parseJsonValue: parseJsonValue,
    });

    function execPageEvaluate(pageId, code, options, execution) {
      return pageEvaluateOps.execPageEvaluate(pageId, code, options, execution);
    }

    function buildCallPageFunctionCode(path, thisPath, callArgs) {
      return pageEvaluateOps.buildCallPageFunctionCode(path, thisPath, callArgs);
    }

    function execRuntimeModuleAction(node, params, execution) {
      return pageEvaluateOps.execRuntimeModuleAction(node, params, execution);
    }

    var assertionOps = nodeAssertionOpsModule.createAssertionOps();

    function execAssertValue(params) {
      return assertionOps.execAssertValue(params);
    }

    // --- 非页面节点 ---

    function delaySegmented(ms, execution) {
      var remaining = Number(ms) || 0;
      function wait(chunk) {
        var signal = execution && execution.signal;
        if (!signal || typeof signal.addEventListener !== 'function') return sleep(chunk);
        if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('等待已停止'));
        return new Promise(function (resolve, reject) {
          var settled = false;
          function cleanup() {
            if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
          }
          var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          }, Math.max(0, chunk));
          function onAbort() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(signal.reason instanceof Error ? signal.reason : new Error('等待已停止'));
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      function step() {
        throwIfStopped();
        if (execution && execution.signal && execution.signal.aborted) {
          return Promise.reject(execution.signal.reason instanceof Error ? execution.signal.reason : new Error('等待已停止'));
        }
        if (remaining <= 0) return Promise.resolve({ waitedMs: Number(ms) || 0 });
        var chunk = Math.min(remaining, DELAY_CHUNK_MS);
        remaining -= chunk;
        return wait(chunk).then(step);
      }
      return step();
    }

    var httpNodes = globalThis.NodeHttp.createHttpNodes({
      addLog: addLog,
      throwIfStopped: throwIfStopped,
      maxBodyLength: MAX_WEBHOOK_BODY_LENGTH,
    });
    var parseHeaderLines = httpNodes.parseHeaderLines;
    var httpFetch = httpNodes.httpFetch;

    // --- 通用数据/集成节点 ---

    function storageGet(key) {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.get(key, function (result) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result ? result[key] : undefined);
        });
      });
    }

    function storageSet(values) {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.set(values, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(values);
        });
      });
    }

    function getContentValue(value) {
      var FlowData = globalThis.FlowData;
      return FlowData && FlowData.isFlowData(value) ? FlowData.getContent(value) : value;
    }

    function resolveCtxValue(path, fallbackPath) {
      var Template = globalThis.Template;
      var resolvedPath = path || fallbackPath || 'last';
      var value = Template.resolvePath(runCtx, resolvedPath);
      return getContentValue(value);
    }

    function parseJsonValue(raw, fallback, label) {
      if (raw === undefined || raw === null || raw === '') return fallback;
      if (typeof raw !== 'string') return raw;
      try {
        return JSON.parse(raw);
      } catch (err) {
        if (fallback !== undefined) return fallback;
        throw new Error((label || 'JSON') + ' 解析失败: ' + err.message);
      }
    }

    var randomDataExecutor = globalThis.NodeRandomData.createRandomDataExecutor({
      parseJsonValue: parseJsonValue,
      setObjectPath: setObjectPath,
    });

    var fileOpsExecutor = globalThis.NodeFileOps.createFileOps({
      chrome: chrome,
      addLog: addLog,
      throwIfStopped: throwIfStopped,
      sleep: sleep,
      getRunCtx: function () { return runCtx; },
      pageSource: pageSource,
      tabRuntime: tabRuntime,
      requireRuntimeTabId: requireRuntimeTabId,
      getRememberedPageTabId: getRememberedPageTabId,
      executePageCommand: function (command, params, execution) {
        return executeUnifiedPageCommand('', command, params, execution, 'flow');
      },
    });
    var execSaveFile = fileOpsExecutor.execSaveFile;

    var browserOpsExecutor = globalThis.NodeBrowserOps.createBrowserOps({
      chrome: chrome,
      addLog: addLog,
      pageSource: pageSource,
      tabRuntime: tabRuntime,
      requireRuntimeTabId: requireRuntimeTabId,
      ensurePageReady: ensurePageReady,
      perceiveTabInfo: function (tabId, execution) {
        return perceivePage('', 'getCurrentTab', { tabId: tabId }, execution);
      },
      getSession: getSession,
      proxyManager: proxyManager,
    });

    var visualNodes = globalThis.NodeVisual.createVisualNodes({
      chrome: chrome,
      addLog: addLog,
      sleep: sleep,
      ensurePageReady: ensurePageReady,
      requireRuntimeTabId: requireRuntimeTabId,
      capturePageScreenshot: pageAutomation.captureScreenshot,
      preparePageCommandTab: tabRuntime.preparePageCommandTab,
      verifyAssertion: pageAutomation.verification.verifyAssertion,
    });
    var captureScreenshotForPage = visualNodes.captureScreenshotForPage;
    var execScreenshot = visualNodes.execScreenshot;

    var getModelClient = function () {
      if (!modelClient) throw new Error('模型客户端未初始化');
      return modelClient;
    };
    var modelNodes = globalThis.NodeModel.createModelNodes({
      addLog: addLog,
      perceivePage: perceivePage,
      captureScreenshotForPage: captureScreenshotForPage,
      getModelClient: getModelClient,
      verifyAssertion: pageAutomation.verification.verifyAssertion,
    });

    function execRunAssistant(node, params, state, execution) {
      var session = getSession();
      if ((state && state.assistantInvocationKind === 'runAssistant')
          || (session && session.assistantInvocationKind === 'runAssistant')) {
        var recursionError = new Error('A runAssistant generation cannot start another Assistant generation');
        recursionError.code = 'ASSISTANT_RECURSION_BLOCKED';
        throw recursionError;
      }
      var orchestrator = getAssistantOrchestrator();
      if (!orchestrator || typeof orchestrator.run !== 'function') {
        throw new Error('助手编排运行时尚未初始化');
      }
      logForExecution(execution, '调用助手: ' + String(params.assistantId || ''));
      return orchestrator.run({
        assistantId: params.assistantId,
        prompt: params.prompt,
        tabId: params.tabId,
        serviceId: params.serviceId,
        conversationId: params.conversationId,
        outputFormat: params.outputFormat,
        maxIterations: params.maxIterations,
        maxToolCalls: params.maxToolCalls,
        timeoutMs: params.timeoutMs,
        pageId: node.pageId || '',
        flowId: state && state.flowId || '',
        flowLabel: state && state.flowLabel || '',
        runId: state && (state.runId || state.sessionId) || session && session.runId || '',
        nodeId: node.nodeId || '',
        throwIfStopped: throwIfStopped,
        signal: execution && execution.signal || null,
      }).then(function (result) {
        logForExecution(execution, '助手完成: ' + (result.assistantName || result.assistantId)
          + ' (' + result.durationMs + 'ms)');
        return result;
      });
    }

    var dataOps = globalThis.NodeDataOps.createDataOps({
      chrome: chrome,
      getRunCtx: function () { return runCtx; },
      parseJsonValue: parseJsonValue,
      getContentValue: getContentValue,
      resolveCtxValue: resolveCtxValue,
      ensureArrayValue: ensureArrayValue,
      cloneJsonSafe: cloneJsonSafe,
      splitList: splitList,
      getObjectPath: getObjectPath,
      setObjectPath: setObjectPath,
      deleteObjectPath: deleteObjectPath,
      storageGet: storageGet,
      storageSet: storageSet,
      checkpointsKey: checkpointsKey,
      clearDebugTrace: function () {
        var count = debugTrace.length;
        debugTrace = [];
        return count;
      },
      compactEphemeralRunState: compactEphemeralRunState,
    });
    var localDataCtx = dataOps.localDataCtx;
    var interpolateExpression = dataOps.interpolateExpression;
    var evalTemplateBool = dataOps.evalTemplateBool;

    function parseEmbeddedJsonSpec(spec) {
      if (typeof spec !== 'string') return spec;
      var text = spec.trim();
      if (!text || (text[0] !== '{' && text[0] !== '[')) return spec;
      try { return JSON.parse(text); } catch (_) { return spec; }
    }

    function ensureArrayValue(value, label) {
      value = getContentValue(value);
      if (Array.isArray(value)) return value;
      if (value && Array.isArray(value.rows)) return value.rows;
      if (value && Array.isArray(value.items)) return value.items;
      if (value === undefined || value === null || value === '') return [];
      throw new Error((label || '数据源') + ' 必须是数组，或包含 rows/items 数组');
    }

    function cloneJsonSafe(value) {
      if (value === undefined) return undefined;
      try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function normalizeStatusBreakCount(raw) {
      var n = parseInt(raw, 10);
      if (!isFinite(n) || n <= 0) return 10;
      return Math.max(1, Math.min(n, 30));
    }

    function execStatusBreak(params, node, execution) {
      params = params || {};
      var count = normalizeStatusBreakCount(params.count);
      var stateKey = String(params.stateKey || (node && node.nodeId) || 'statusBreak');
      if (!safeContextKey(stateKey)) throw new Error('StatusBreak 状态键不能使用原型保留字段: ' + stateKey);
      var store = runCtx._statusBreak;
      if (!store || typeof store !== 'object') store = runCtx._statusBreak = Object.create(null);
      if (params.reset === true) delete store[stateKey];

      var maxMask = (1 << count) - 1;
      var state = store[stateKey];
      if (!state || state.count !== count) {
        state = store[stateKey] = {
          count: count,
          mask: maxMask,
          index: 0,
        };
      }

      var status = params.condition ? !!evalTemplateCondition(params.condition, 'StatusBreak ', execution) : false;
      var bitIndex = state.index % count;
      var bit = 1 << bitIndex;
      var previousMask = state.mask;
      state.mask = status ? (state.mask | bit) : (state.mask & ~bit);
      var samples = state.index + 1;
      var filled = samples >= count;
      var done = filled && state.mask === 0;

      var result = {
        done: done,
        loopBreak: done,
        status: status,
        mask: state.mask,
        maskBinary: state.mask.toString(2).padStart(count, '0'),
        previousMask: previousMask,
        previousMaskBinary: previousMask.toString(2).padStart(count, '0'),
        bitIndex: bitIndex,
        bit: bit,
        index: state.index,
        samples: samples,
        count: count,
        maxMask: maxMask,
        filled: filled,
        stateKey: stateKey,
      };
      state.index = samples;
      return result;
    }

    function splitList(raw) {
      if (Array.isArray(raw)) return raw.map(function (v) { return String(v).trim(); }).filter(Boolean);
      return String(raw || '').split(/[,\n]/).map(function (v) { return v.trim(); }).filter(Boolean);
    }

    function getObjectPath(obj, path) {
      if (!path) return obj;
      return globalThis.Template.resolvePath(obj, path);
    }

    function setObjectPath(obj, path, value) {
      var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
      var parts = normalized.split('.').filter(Boolean);
      if (!parts.length) return value;
      var unsafePart = parts.find(function (part) { return /^(?:__proto__|prototype|constructor)$/.test(part); });
      if (unsafePart) throw new Error('数据路径不能包含保留字段: ' + unsafePart);
      var cur = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        var p = parts[i];
        if (!Object.prototype.hasOwnProperty.call(cur, p) || !cur[p] || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = value;
      return obj;
    }

    function deleteObjectPath(obj, path) {
      var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
      var parts = normalized.split('.').filter(Boolean);
      if (!parts.length) return false;
      var cur = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        cur = cur && Object.prototype.hasOwnProperty.call(cur, parts[i]) ? cur[parts[i]] : null;
        if (!cur || typeof cur !== 'object') return false;
      }
      if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1])) return false;
      delete cur[parts[parts.length - 1]];
      return true;
    }

    function trimArrayInPlace(arr, maxItems) {
      if (!Array.isArray(arr) || arr.length <= maxItems) return 0;
      var removed = arr.length - maxItems;
      arr.splice(0, removed);
      return removed;
    }

    function compactEphemeralRunState() {
      var removed = {};
      if (Array.isArray(runCtx._artifacts)) {
        removed.artifacts = trimArrayInPlace(runCtx._artifacts, MAX_RUN_ARTIFACTS);
      }
      if (Array.isArray(runCtx._coverage)) {
        removed.coverage = trimArrayInPlace(runCtx._coverage, MAX_COVERAGE_MARKS);
      }
      if (runCtx._lastContent !== undefined) {
        var lastContentSize = executionContract.calculateContentSize(runCtx._lastContent);
        if (lastContentSize > MAX_LAST_CONTENT_SHORTCUT_SIZE) {
          deleteObjectPath(runCtx, '_lastContent');
          runCtx._lastContentOmitted = {
            reason: 'size-limit',
            size: lastContentSize,
            limit: MAX_LAST_CONTENT_SHORTCUT_SIZE,
          };
          removed.lastContentShortcut = 1;
        } else {
          deleteObjectPath(runCtx, '_lastContentOmitted');
        }
      } else {
        deleteObjectPath(runCtx, '_lastContentOmitted');
      }
      return removed;
    }

    function compactRuntimeState(options) {
      options = options || {};
      var compacted = compactEphemeralRunState();
      if (debugTrace.length > MAX_DEBUG_TRACE) {
        compacted.debugTrace = debugTrace.length - MAX_DEBUG_TRACE;
        debugTrace.splice(0, debugTrace.length - MAX_DEBUG_TRACE);
      }
      var pageCompacted = pageLifecycleOps.compactRuntimeState();
      if (pageCompacted.pageReadyPromises) compacted.pageReadyPromises = pageCompacted.pageReadyPromises;
      return {
        reason: options.reason || '',
        compacted: compacted,
        contextKeys: Object.keys(runCtx || {}).length,
        debugTraceCount: debugTrace.length,
      };
    }

    function summarizeStatuses(statuses) {
      var summary = { total: 0, passed: 0, failed: 0, skipped: 0, running: 0, pending: 0, stopped: 0 };
      Object.keys(statuses || {}).forEach(function (id) {
        summary.total++;
        var st = statuses[id] || 'pending';
        if (st === 'completed' || st === 'manual_completed') summary.passed++;
        else if (st === 'failed') summary.failed++;
        else if (st === 'skipped') summary.skipped++;
        else if (st === 'running') summary.running++;
        else if (st === 'stopped') summary.stopped++;
        else summary.pending++;
      });
      return summary;
    }

    function htmlEscape(text) {
      return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function buildReportObject(state, params) {
      var statuses = state && state.nodeStatuses || {};
      return {
        flowId: state && state.flowId || '',
        flowLabel: state && state.flowLabel || '',
        generatedAt: new Date().toISOString(),
        summary: summarizeStatuses(statuses),
        nodeStatuses: statuses,
        artifacts: runCtx._artifacts || [],
        coverage: runCtx._coverage || [],
        context: params.includeContext ? cloneJsonSafe(runCtx) : undefined,
        debugTrace: params.includeDebugTrace ? cloneJsonSafe(debugTrace) : undefined,
      };
    }

    function reportToHtml(report) {
      var rows = Object.keys(report.nodeStatuses || {}).map(function (id) {
        return '<tr><td>' + htmlEscape(id) + '</td><td>' + htmlEscape(report.nodeStatuses[id]) + '</td></tr>';
      }).join('');
      return '<!doctype html><meta charset="utf-8"><title>Page Agent Report</title>'
        + '<style>body{font-family:Arial,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px}th{background:#f4f6f8;text-align:left}.fail{color:#b00020}</style>'
        + '<h1>Page Agent Report</h1><p>Flow: ' + htmlEscape(report.flowLabel || report.flowId) + '</p>'
        + '<p>Total ' + report.summary.total + ', Passed ' + report.summary.passed + ', Failed <span class="fail">' + report.summary.failed + '</span>, Skipped ' + report.summary.skipped + '</p>'
        + '<table><thead><tr><th>Node</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function reportToJUnit(report) {
      var statuses = report.nodeStatuses || {};
      var names = Object.keys(statuses);
      var failures = names.filter(function (id) { return statuses[id] === 'failed'; }).length;
      var skipped = names.filter(function (id) { return statuses[id] === 'skipped'; }).length;
      var cases = names.map(function (id) {
        var st = statuses[id];
        var body = st === 'failed' ? '<failure message="failed"></failure>' : (st === 'skipped' ? '<skipped></skipped>' : '');
        return '<testcase classname="' + htmlEscape(report.flowId) + '" name="' + htmlEscape(id) + '">' + body + '</testcase>';
      }).join('');
      return '<?xml version="1.0" encoding="UTF-8"?><testsuite name="' + htmlEscape(report.flowLabel || report.flowId) + '" tests="' + names.length + '" failures="' + failures + '" skipped="' + skipped + '">' + cases + '</testsuite>';
    }

    function execExportTestReport(params, state, execution) {
      var report = buildReportObject(state || {}, params || {});
      var format = params.format || 'json';
      var content;
      var mime;
      var ext;
      if (format === 'html') { content = reportToHtml(report); mime = 'text/html;charset=utf-8'; ext = 'html'; }
      else if (format === 'junit') { content = reportToJUnit(report); mime = 'application/xml'; ext = 'xml'; }
      else { content = JSON.stringify(report, null, 2); mime = 'application/json'; ext = 'json'; }
      var result = { format: format, report: report, content: content };
      if (params.saveFile !== false) {
        return execSaveFile({
          directory: params.directory || 'PageAgent/reports',
          fileName: params.fileName || ('flow-report-' + Date.now() + '.' + ext),
          sourceMode: 'literal',
          content: content,
          format: 'text',
          mimeType: mime,
          waitComplete: params.waitComplete !== false,
          conflictAction: params.conflictAction || 'uniquify',
          timeoutMs: params.timeoutMs || 60000,
        }, execution).then(function (file) {
          result.file = file;
          return result;
        });
      }
      return Promise.resolve(result);
    }

    function execAttachArtifact(params, execution) {
      var artifact = {
        id: params.artifactId || ('artifact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        name: params.name || 'artifact',
        type: params.artifactType || params.type || 'data',
        mimeType: params.mimeType || '',
        createdAt: Date.now(),
        content: params.content !== '' && params.content !== undefined ? params.content : resolveCtxValue(params.sourcePath, 'last'),
      };
      runCtx._artifacts = runCtx._artifacts || [];
      runCtx._artifacts.push(artifact);
      logForExecution(execution, '已附加运行产物: ' + artifact.name + ' (' + artifact.type + ')');
      return { attached: true, artifact: artifact, count: runCtx._artifacts.length };
    }

    function execAssertPerformance(params) {
      var source = resolveCtxValue(params.sourcePath || params.source, 'last') || {};
      var latency = source.latency || (source.result && source.result.latency) || {};
      var failures = [];
      function checkMetric(name, actual, max) {
        max = Number(max) || 0;
        if (max > 0 && Number(actual) > max) failures.push(name + ' ' + actual + ' > ' + max);
      }
      checkMetric('p95', latency.p95, params.maxP95Ms);
      checkMetric('avg', latency.avg, params.maxAvgMs);
      checkMetric('p99', latency.p99, params.maxP99Ms);
      checkMetric('errorRatePct', source.errorRatePct, params.maxErrorRatePct);
      var longTasks = source.longTasks || (source.result && source.result.longTasks) || [];
      if (Number(params.maxLongTasks) >= 0 && Array.isArray(longTasks) && longTasks.length > Number(params.maxLongTasks)) {
        failures.push('longTasks ' + longTasks.length + ' > ' + Number(params.maxLongTasks));
      }
      if (failures.length) throw new Error('[性能断言失败] ' + failures.join('; '));
      return { passed: true, checked: true, source: source };
    }

    function execForEachParallel(params, execution) {
      var rows = ensureArrayValue(resolveCtxValue(params.sourcePath || params.source, 'last'), 'forEachParallel 数据源');
      var concurrency = Math.max(1, Math.min(50, Number(params.concurrency) || 5));
      var action = params.action || 'identity';
      var results = new Array(rows.length);
      var nextIndex = 0;
      var schedulingStopped = false;
      var firstError = null;
      var mutatingRequestStarted = false;
      function runItem(item, index) {
        throwIfStopped();
        if (execution && execution.signal && execution.signal.aborted) {
          throw execution.signal.reason instanceof Error ? execution.signal.reason : new Error('并发处理已停止');
        }
        var ctx = localDataCtx(item, index);
        if (action === 'httpRequest' || action === 'webhook') {
          var url = globalThis.Template.interpolate(params.url, ctx);
          var body = params.bodyTemplate ? globalThis.Template.interpolate(params.bodyTemplate, ctx) : (action === 'webhook' ? JSON.stringify(item) : params.body);
          var method = String(params.method || 'AUTO').toUpperCase();
          if (method === 'AUTO') method = action === 'webhook' ? 'POST' : 'GET';
          if (!/^(?:GET|HEAD|OPTIONS)$/.test(method) && url) mutatingRequestStarted = true;
          return httpFetch(url, {
            method: method,
            headers: globalThis.Template.interpolate(params.headers || '', ctx),
            body: body,
            timeoutMs: params.timeoutMs,
            signal: execution && execution.signal,
          });
        }
        if (action === 'template') {
          var text = globalThis.Template.interpolate(params.resultTemplate || '{{json item}}', ctx);
          return Promise.resolve(parseJsonValue(text, text, '并行模板结果'));
        }
        return Promise.resolve(item);
      }
      function worker() {
        if (schedulingStopped || nextIndex >= rows.length) return Promise.resolve();
        throwIfStopped();
        var index = nextIndex++;
        return Promise.resolve().then(function () {
          return runItem(rows[index], index);
        }).then(function (value) {
          results[index] = { index: index, ok: true, value: value };
          return worker();
        }).catch(function (err) {
          if (execution && execution.signal && execution.signal.aborted) {
            schedulingStopped = true;
            if (!firstError) firstError = err;
            return;
          }
          try { throwIfStopped(); } catch (stopError) {
            schedulingStopped = true;
            if (!firstError) firstError = stopError;
            return;
          }
          results[index] = { index: index, ok: false, error: err && err.message || String(err) };
          if (params.failFast !== false) {
            schedulingStopped = true;
            if (!firstError) firstError = err;
            return;
          }
          return worker();
        });
      }
      var workers = [];
      for (var i = 0; i < Math.min(concurrency, rows.length); i++) workers.push(worker());
      return Promise.all(workers).then(function () {
        // Cancellation can win just after the last worker settles. Re-check
        // the execution stop state before publishing a successful batch so a
        // late stop cannot be mistaken for a completed iteration.
        if (!firstError) {
          try { throwIfStopped(); }
          catch (stopError) { firstError = stopError; }
        }
        if (firstError) {
          if (mutatingRequestStarted && (typeof firstError === 'object' || typeof firstError === 'function')) {
            try {
              firstError.performed = 'unknown';
              firstError.retryable = false;
            } catch (_) {}
          }
          throw firstError;
        }
        return { items: results, total: rows.length, ok: results.filter(function (r) { return r && r.ok; }).length, failed: results.filter(function (r) { return r && !r.ok; }).length };
      });
    }

    function execExitGate(params, state) {
      var summary = params.sourcePath ? resolveCtxValue(params.sourcePath, 'last') : summarizeStatuses((state && state.nodeStatuses) || {});
      var failures = [];
      if (params.condition && !evalTemplateBool(params.condition, Object.assign({}, runCtx, { summary: summary }), 'Exit gate ')) failures.push('condition=false');
      if (Number(params.maxFailures) >= 0 && Number(summary.failed || 0) > Number(params.maxFailures)) failures.push('failed ' + summary.failed + ' > ' + params.maxFailures);
      if (params.requiredStatus && summary.status && summary.status !== params.requiredStatus) failures.push('status ' + summary.status + ' != ' + params.requiredStatus);
      if (failures.length) throw new Error('[CI Gate 失败] ' + failures.join('; '));
      return { passed: true, summary: summary };
    }

    function execExportRunSummary(params, state, execution) {
      var summary = {
        flowId: state && state.flowId || '',
        generatedAt: new Date().toISOString(),
        statusSummary: summarizeStatuses((state && state.nodeStatuses) || {}),
        coverage: runCtx._coverage || [],
        artifacts: (runCtx._artifacts || []).map(function (a) { return { id: a.id, name: a.name, type: a.type, mimeType: a.mimeType, createdAt: a.createdAt }; }),
      };
      var content = JSON.stringify(summary, null, 2);
      if (params.saveFile === false) return Promise.resolve({ summary: summary });
      return execSaveFile({
        directory: params.directory || 'PageAgent/reports',
        fileName: params.fileName || ('run-summary-' + Date.now() + '.json'),
        sourceMode: 'literal',
        content: content,
        format: 'text',
        mimeType: 'application/json',
        waitComplete: params.waitComplete !== false,
      }, execution).then(function (file) {
        return { summary: summary, file: file };
      });
    }

    function accessibilitySelector(target) {
      target = target || {};
      var attributes = target.attributes || {};
      function escapePart(value) {
        return String(value || '').replace(/([^A-Za-z0-9_-])/g, '\\$1');
      }
      if (attributes.id) return '#' + escapePart(attributes.id);
      var selector = String(target.tag || target.nodeName || target.role || 'target').toLowerCase();
      var classes = String(attributes.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (classes.length) selector += '.' + classes.map(escapePart).join('.');
      return selector;
    }

    function collectAccessibilityViolations(snapshot) {
      var targets = Array.isArray(snapshot && snapshot.targets) ? snapshot.targets : [];
      var violations = [];
      var labelFors = Object.create(null);
      var headingsByFrame = Object.create(null);

      function frameKey(target) {
        return String(target && target.frameId || snapshot && snapshot.frameId || '');
      }
      function add(id, message, target, selector) {
        violations.push({
          id: id,
          message: message,
          selector: selector || accessibilitySelector(target),
          documentId: String(snapshot && snapshot.documentId || ''),
          targetId: String(target && target.targetId || ''),
          frameId: frameKey(target),
        });
      }

      targets.forEach(function (target) {
        var tag = String(target && (target.tag || target.nodeName) || '').toLowerCase();
        var attributes = target && target.attributes || {};
        if (tag === 'label' && String(attributes.for || '').trim()) {
          labelFors[frameKey(target) + '\n' + String(attributes.for)] = true;
        }
      });

      targets.forEach(function (target) {
        var tag = String(target && (target.tag || target.nodeName) || '').toLowerCase();
        var attributes = target && target.attributes || {};
        if (tag === 'img' && !String(attributes.alt || '').trim()) {
          add('image-alt', '图片缺少 alt', target);
        }
        if (/^(?:input|select|textarea)$/.test(tag)) {
          var id = String(attributes.id || '');
          var hasLabel = !!(id && labelFors[frameKey(target) + '\n' + id]);
          var hasAccessibleName = !!String(target.name || attributes['aria-label'] || attributes['aria-labelledby'] || '').trim();
          if (!hasLabel && !hasAccessibleName) add('form-label', '表单控件缺少 label/aria-label', target);
        }
        if (/^(?:button|a)$/.test(tag)) {
          var controlName = String(target.name || target.text || attributes['aria-label'] || attributes['aria-labelledby'] || '').trim();
          if (!controlName) add('control-name', '可交互元素缺少可访问名称', target);
        }
        var heading = /^h([1-6])$/.exec(tag);
        if (heading) {
          var headingFrame = frameKey(target);
          headingsByFrame[headingFrame] = headingsByFrame[headingFrame] || [];
          headingsByFrame[headingFrame].push({ level: Number(heading[1]), target: target });
        }
      });

      var topFrameId = String(snapshot && snapshot.frameId || '');
      var htmlTarget = targets.find(function (target) {
        return String(target && (target.tag || target.nodeName) || '').toLowerCase() === 'html'
          && frameKey(target) === topFrameId;
      });
      if (!htmlTarget || !String(htmlTarget.attributes && htmlTarget.attributes.lang || '').trim()) {
        add('html-lang', 'html 缺少 lang 属性', htmlTarget, 'html');
      }

      Object.keys(headingsByFrame).forEach(function (headingFrame) {
        var headings = headingsByFrame[headingFrame];
        for (var index = 1; index < headings.length; index += 1) {
          if (headings[index].level - headings[index - 1].level > 1) {
            add('heading-order', '标题层级跳跃', headings[index].target);
          }
        }
      });
      return violations;
    }

    function execAccessibilityCheck(node, params, execution) {
      params = params || {};
      var startedAt = new Date().toISOString();
      return perceivePage(node.pageId, 'snapshot', {
        tabId: params.tabId,
        timeoutMs: params.timeoutMs || 30000,
      }, execution).then(function (snapshot) {
        var violations = collectAccessibilityViolations(snapshot);
        var max = Number(params.maxViolations);
        if (isNaN(max)) max = 0;
        var passed = params.failOnViolation === false || violations.length <= max;
        var reason = passed
          ? '可访问性检查满足阈值：违规 ' + violations.length + ' 条，阈值 ' + max
          : '可访问性检查失败：违规 ' + violations.length + ' 条，超过阈值 ' + max;
        var verification = pageAutomation.verification.verifyAssertion({
          kind: 'accessibilityCheck', passed: passed,
          actual: { count: violations.length, violations: violations },
          expected: { maxViolations: max, failOnViolation: params.failOnViolation !== false },
          reason: reason,
        });
        var completedAt = new Date().toISOString();
        var receipt = pageAutomation.verification.createFactReceipt({
          source: 'flow',
          tabId: snapshot.tabId,
          kind: 'accessibilityCheck',
          inputProvenance: 'perception',
          verification: verification,
          startedAt: startedAt,
          completedAt: completedAt,
        });
        if (!passed) {
          var error = new Error('[可访问性检查失败] 违规 ' + violations.length + ' 条，超过阈值 ' + max);
          error.code = 'VERIFICATION_FAILED';
          error.verification = verification;
          error.actionReceipt = receipt;
          error.receipt = receipt;
          throw error;
        }
        return { passed: true, engine: 'PagePerceptionEngine', violations: violations, count: violations.length, verification: verification, actionReceipt: receipt, receipt: receipt };
      });
    }

    function execCoverageMark(params) {
      runCtx._coverage = runCtx._coverage || [];
      var mark = {
        id: params.markId || params.name || ('coverage_' + Date.now()),
        name: params.name || params.markId || '',
        status: params.status || 'covered',
        detail: params.detail || '',
        ts: Date.now(),
      };
      runCtx._coverage.push(mark);
      return { marked: true, mark: mark, count: runCtx._coverage.length };
    }

    function buildMockNetworkCode(params) {
      var action = params.action || 'set';
      var rule = {
        urlFilter: params.urlFilter || '',
        matchMode: params.matchMode || 'contains',
        method: params.method || '',
        status: Number(params.status) || 200,
        headers: parseHeaderLines(params.responseHeaders),
        body: params.responseBody || '',
        delayMs: Number(params.delayMs) || 0,
      };
      return '(function(){'
        + 'var action=' + JSON.stringify(action) + ';var rule=' + JSON.stringify(rule) + ';'
        + 'var w=window;if(!w.__pfaMockNetwork){w.__pfaMockNetwork={rules:[],hits:[],originalFetch:w.fetch};}'
        + 'var state=w.__pfaMockNetwork;'
        + 'if(action==="clear"){if(state.originalFetch)w.fetch=state.originalFetch;state.rules=[];state.patched=false;return {mocked:false,cleared:true,rules:0,hits:state.hits};}'
        + 'function match(r,url,method){if(r.method&&String(method).toUpperCase()!==String(r.method).toUpperCase())return false;if(!r.urlFilter)return true;if(r.matchMode==="regex")return new RegExp(r.urlFilter).test(url);return String(url).indexOf(r.urlFilter)!==-1;}'
        + 'if(!state.patched&&typeof state.originalFetch==="function"){state.patched=true;w.fetch=function(input,init){var url=String((typeof input==="string"?input:(input&&input.url))||"");var method=(init&&init.method)||(input&&input.method)||"GET";for(var i=0;i<state.rules.length;i++){var r=state.rules[i];if(match(r,url,method)){state.hits.push({url:url,method:method,ts:Date.now(),rule:r.urlFilter});var make=function(){return new Response(r.body||"",{status:r.status||200,headers:r.headers||{}});};return r.delayMs?new Promise(function(res){setTimeout(function(){res(make());},r.delayMs);}):Promise.resolve(make());}}return state.originalFetch.apply(this,arguments);};}'
        + 'if(action==="replace")state.rules=[];state.rules.push(rule);return {mocked:true,rules:state.rules.length};'
        + '})()';
    }

    function execMockNetwork(node, params, execution) {
      return execPageEvaluate(node.pageId, buildMockNetworkCode(params), {
        tabId: params.tabId,
        timeoutMs: params.timeoutMs || 30000,
        start: 0,
        maxChars: 10000,
        returnEnvelope: true,
        riskLabel: 'mockNetwork',
      }, execution).then(function (result) {
        var value = result && result.result;
        return Object.assign({}, value && typeof value === 'object' ? value : { result: value }, {
          actionReceipt: result && result.actionReceipt || null,
          receipt: result && result.actionReceipt || null,
        });
      });
    }

    function execRouteAssert(node, params, execution) {
      params = params || {};
      var startedAt = new Date().toISOString();
      var timeoutMs = Math.max(100, Math.min(Number(params.timeoutMs) || 10000, 120000));
      var deadline = Date.now() + timeoutMs;
      var min = Number(params.minCount);
      if (isNaN(min)) min = 1;
      var max = Number(params.maxCount) || 0;
      var maxDuration = Number(params.maxDurationMs) || 0;
      var getParams = {
        tabId: params.tabId,
        urlFilter: params.urlFilter || '',
        method: params.method || '',
        resourceType: params.resourceType || '',
        latestOnly: false,
        parseJson: false,
        start: 0,
        maxChars: 10000,
        timeoutMs: 0,
      };
      function evaluate(result) {
        var entries = result && Array.isArray(result.entries) ? result.entries : [];
        var failures = [];
        if (entries.length < min) failures.push('请求次数 ' + entries.length + ' < ' + min);
        if (max > 0 && entries.length > max) failures.push('请求次数 ' + entries.length + ' > ' + max);
        if (params.status) {
          var expectedStatus = Number(params.status);
          var bad = entries.filter(function (e) { return Number(e.status) !== expectedStatus; });
          if (bad.length) failures.push('存在非预期状态码，期望 ' + expectedStatus);
        }
        if (params.bodyContains) {
          var matched = entries.some(function (e) { return String(e.body || '').indexOf(String(params.bodyContains)) !== -1; });
          if (!matched) failures.push('响应体不包含: ' + params.bodyContains);
        }
        if (maxDuration > 0) {
          var slow = entries.filter(function (e) { return Number(e.durationMs || 0) > maxDuration; });
          if (slow.length) failures.push('存在耗时超过 ' + maxDuration + 'ms 的请求');
        }
        var passed = failures.length === 0;
        var reason = passed ? '路由断言已满足' : '路由断言未满足：' + failures.join('；');
        return { passed: passed, entries: entries, count: entries.length, failures: failures, reason: reason,
          tabId: Number(result && result.tabId) || Number(params.tabId) || 0 };
      }
      function poll() {
        throwIfStopped();
        return perceivePage(node.pageId, 'getRequests', getParams, execution).then(function (result) {
          var evaluation = evaluate(result || {});
          if (evaluation.passed || Date.now() >= deadline) return evaluation;
          return delaySegmented(Math.min(250, Math.max(1, deadline - Date.now())), execution).then(poll);
        });
      }
      return poll().then(function (evaluation) {
        var entries = evaluation.entries;
        var passed = evaluation.passed;
        var reason = passed ? '路由断言已满足' : '路由断言失败：' + evaluation.failures.join('；');
        var verification = pageAutomation.verification.verifyAssertion({
          kind: 'routeAssert', passed: passed,
          actual: { count: entries.length, entries: entries },
          expected: { minCount: min, maxCount: max, status: params.status || null, bodyContains: params.bodyContains || '', maxDurationMs: maxDuration },
          reason: reason,
        });
        var receipt = pageAutomation.verification.createFactReceipt({
          source: 'flow',
          tabId: Number(evaluation.tabId || params.tabId) || 0,
          kind: 'routeAssert',
          performed: 'no',
          conditionMet: passed,
          inputProvenance: 'perception',
          verification: verification,
          startedAt: startedAt,
          completedAt: new Date().toISOString(),
        });
        if (!passed) {
          var error = new Error('[' + reason + ']');
          error.code = 'VERIFICATION_FAILED';
          error.verification = verification;
          error.actionReceipt = receipt;
          error.receipt = receipt;
          throw error;
        }
        return { passed: true, count: entries.length, entries: entries, verification: verification, actionReceipt: receipt, receipt: receipt };
      });
    }

    function execLogData(params, execution) {
      var message = String(params.message === undefined || params.message === '' ? '{{json last}}' : params.message);
      var maxLength = Number(params.maxLength) || 0;
      if (maxLength > 0 && message.length > maxLength) {
        message = message.slice(0, maxLength) + '…(已截断, 共' + message.length + '字符)';
      }
      logForExecution(execution, message, { level: params.level || 'info' });
      // 透传上一节点输出，不破坏 ctx.last 链
      return runCtx.last;
    }

    function execGetCurrentTab(pageId, params, execution) {
      params = params || {};
      var resolveTabId = pageId
        ? getRememberedPageTabId(pageId).then(function (tabId) {
            if (!(Number(tabId) > 0)) throw new Error('页面尚未绑定标签页: ' + pageId + '；先执行 openPage');
            return tabId;
          })
        : requireRuntimeTabId(params, 'getCurrentTab');
      return resolveTabId.then(function (tabId) {
        return perceivePage('', 'getCurrentTab', { tabId: tabId }, execution);
      }).then(function (info) {
        info = Object.assign({}, info || {}, {
          url: String(info && info.url || '').slice(0, 4000),
          committedUrl: String(info && info.committedUrl || '').slice(0, 4000),
          pendingUrl: String(info && info.pendingUrl || '').slice(0, 4000),
          title: String(info && info.title || '').slice(0, 500),
        });
        logForExecution(execution, '当前标签 URL: ' + previewLogText(info.url));
        return info;
      });
    }

    // 条件求值：模板插值已完成，剩余表达式用安全求值器（MV3 禁止 eval）
    function evalCondition(condition, label, execution) {
      var r = globalThis.Expression.evalBool(condition);
      if (!r.ok) logForExecution(execution, label + '条件解析失败（按 false 处理）: ' + r.error + ' — 表达式: ' + condition, { level: 'warn' });
      return r.value;
    }

    function evalTemplateCondition(condition, label, execution) {
      return evalCondition(interpolateExpression(condition, runCtx), label, execution);
    }

    // --- 变量与测试数据 ---

    function execSetVariable(params) {
      var variableName = String(params && params.name || '').trim();
      if (!variableName) throw new Error('设置变量缺少变量名');
      if (/^(?:__proto__|prototype|constructor)$/.test(variableName)) {
        throw new Error('设置变量名不能使用保留字段: ' + variableName);
      }
      var value = params.value;
      if (params.parseJson) {
        try { value = JSON.parse(value); } catch (e) { throw new Error('变量值 JSON 解析失败: ' + e.message); }
      }
      runCtx[variableName] = value;
      return value;
    }

    function execAddAttribute(params, execution) {
      var FlowData = globalThis.FlowData;
      if (!FlowData) {
        throw new Error('FlowData 模块未加载');
      }

      var lastFlowData = runCtx.last;
      if (!FlowData.isFlowData(lastFlowData)) {
        throw new Error('addAttribute 需要上游节点输出 FlowData（当前 last 不是 FlowData）');
      }

      if (!params.key) throw new Error('addAttribute 缺少属性键');
      if (!safeContextKey(String(params.key))) {
        throw new Error('addAttribute 属性键不能使用原型保留字段: ' + params.key);
      }
      if (params.value === undefined || params.value === null) {
        throw new Error('addAttribute 缺少属性值');
      }

      var mode = params.mode || 'add';
      var key = params.key;
      var value = params.value;

      // 检查是否需要添加
      if (mode === 'addIfAbsent') {
        var existingValue = FlowData.getAttribute(lastFlowData, key);
        if (existingValue !== undefined) {
          logForExecution(execution, '属性 [' + key + '] 已存在，跳过添加', { level: 'info' });
          return lastFlowData; // 返回原 FlowData
        }
      }

      // 添加或覆盖属性
      var newFlowData = FlowData.addAttribute(lastFlowData, key, value);
      logForExecution(execution, '属性已添加: ' + key + ' = ' + value, { level: 'info' });
      return newFlowData;
    }

    // --- 关闭页面 / 下载与文件保存 ---

    // --- 节点实例执行入口 ---

    // --- 调试追踪辅助函数 ---

    function createTraceBudget(chars) {
      return {
        remaining: Math.max(1024, Number(chars) || TRACE_VALUE_BUDGET),
        exhausted: false,
      };
    }

    function consumeTraceBudget(budget, amount) {
      if (!budget || budget.exhausted) return !!(budget && budget.exhausted);
      budget.remaining -= Math.max(0, Number(amount) || 0);
      if (budget.remaining < 0) budget.exhausted = true;
      return budget.exhausted;
    }

    function traceTruncated(reason, extra) {
      return Object.assign({
        __truncated: true,
        reason: reason || 'trace-budget-exceeded',
      }, extra || {});
    }

    /**
     * 捕获当前上下文的快照（用于调试追踪）。
     * 长流程中这里最容易产生重复大对象，因此按整次快照预算摘要化。
     */
    function captureContextSnapshot() {
      var snapshot = {};
      var budget = createTraceBudget(TRACE_CONTEXT_SNAPSHOT_BUDGET);
      try {
        var keys = Object.keys(runCtx);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          // 跳过内部变量；last 会被保留但按预算摘要化。
          if (key.startsWith('_')) continue;
          if (consumeTraceBudget(budget, key.length)) {
            snapshot.__truncated = true;
            snapshot.__truncatedReason = 'context-snapshot-budget';
            break;
          }
          snapshot[key] = serializeForTrace(runCtx[key], { budget: budget });
          if (budget.exhausted) {
            snapshot.__truncated = true;
            snapshot.__truncatedReason = 'context-snapshot-budget';
            break;
          }
        }
      } catch (e) {
        snapshot = { __error: '快照失败: ' + e.message };
      }
      return snapshot;
    }

    /**
     * 序列化数据用于追踪（预算化、深度限制、数组/对象项数限制）。
     * 不再先 JSON.stringify 整个对象，避免调试追踪本身制造大内存峰值。
     */
    function traceOwnDataDescriptor(value, key) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
      try {
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor : null;
      } catch (_) {
        return null;
      }
    }

    function traceCollectionInfo(value) {
      if (!value || typeof value !== 'object') return null;
      if (typeof Map === 'function') {
        try {
          return {
            kind: 'map',
            size: Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value),
            forEach: Map.prototype.forEach,
          };
        } catch (_) {}
      }
      if (typeof Set === 'function') {
        try {
          return {
            kind: 'set',
            size: Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value),
            forEach: Set.prototype.forEach,
          };
        } catch (_) {}
      }
      return null;
    }

    function traceErrorInfo(value) {
      var isError = false;
      try { isError = value instanceof Error; } catch (_) {}
      var name = traceOwnDataDescriptor(value, 'name');
      var message = traceOwnDataDescriptor(value, 'message');
      var stack = traceOwnDataDescriptor(value, 'stack');
      var prototype = value;
      for (var depth = 0; !isError && prototype && depth < 6; depth++) {
        try { prototype = Object.getPrototypeOf(prototype); } catch (_) { prototype = null; }
        if (!prototype) break;
        if (!name) name = traceOwnDataDescriptor(prototype, 'name');
        var constructorDescriptor = traceOwnDataDescriptor(prototype, 'constructor');
        var constructorName = constructorDescriptor
          ? traceOwnDataDescriptor(constructorDescriptor.value, 'name')
          : null;
        if (constructorName && typeof constructorName.value === 'string' && /Error$/.test(constructorName.value)) isError = true;
      }
      if (!isError) return null;
      return {
        name: name && typeof name.value === 'string' ? name.value : 'Error',
        message: message && typeof message.value === 'string' ? message.value : '',
        stack: stack && typeof stack.value === 'string' ? stack.value : '',
      };
    }

    function serializeForTrace(value, options, depth, seen) {
      options = options || {};
      var budget = options.budget || createTraceBudget(options.budgetChars || TRACE_VALUE_BUDGET);
      depth = depth || 0;
      seen = seen || [];

      if (budget.exhausted) return traceTruncated('trace-budget-exceeded');
      if (value === null || value === undefined) {
        consumeTraceBudget(budget, 4);
        return value;
      }

      var type = typeof value;
      if (type === 'string') {
        consumeTraceBudget(budget, Math.min(value.length, TRACE_STRING_PREVIEW));
        if (value.length > TRACE_STRING_PREVIEW) {
          return traceTruncated('string-too-large', {
            type: 'string',
            length: value.length,
            preview: value.slice(0, TRACE_STRING_PREVIEW),
          });
        }
        return value;
      }
      if (type === 'number' || type === 'boolean') {
        consumeTraceBudget(budget, 16);
        return value;
      }
      if (type === 'bigint') {
        var bigintText = String(value) + 'n';
        consumeTraceBudget(budget, bigintText.length);
        return bigintText;
      }
      if (type === 'function') {
        consumeTraceBudget(budget, 64);
        return { __type: 'function', name: value.name || '' };
      }
      if (type !== 'object') {
        var text = String(value);
        consumeTraceBudget(budget, text.length);
        return text;
      }
      if (seen.indexOf(value) !== -1) return '[Circular]';
      if (depth >= TRACE_MAX_DEPTH) return traceTruncated('max-depth', { depth: depth });

      seen.push(value);
      try {
        var collectionInfo = traceCollectionInfo(value);
        if (collectionInfo) {
          consumeTraceBudget(budget, 32);
          var collection = {
            __type: collectionInfo.kind,
            size: collectionInfo.size,
          };
          var collectionValues = [];
          var stopCollection = {};
          try {
            collectionInfo.forEach.call(value, function (item, key) {
              if (collectionValues.length >= TRACE_ARRAY_ITEMS || budget.exhausted) throw stopCollection;
              collectionValues.push(collectionInfo.kind === 'map'
                ? [
                    serializeForTrace(key, { budget: budget }, depth + 1, seen),
                    serializeForTrace(item, { budget: budget }, depth + 1, seen),
                  ]
                : serializeForTrace(item, { budget: budget }, depth + 1, seen));
            });
          } catch (error) {
            if (error !== stopCollection) collection.__error = 'collection-read-failed';
          }
          collection[collectionInfo.kind === 'map' ? 'entries' : 'values'] = collectionValues;
          if (collectionInfo.size > collectionValues.length) {
            collection.__omittedItems = collectionInfo.size - collectionValues.length;
          }
          return collection;
        }
        if (Array.isArray(value)) {
          var arr = [];
          var arrayLimit = Math.min(value.length, TRACE_ARRAY_ITEMS);
          for (var i = 0; i < arrayLimit; i++) {
            if (budget.exhausted) {
              arr.push(traceTruncated('trace-budget-exceeded'));
              break;
            }
            var itemDescriptor = traceOwnDataDescriptor(value, String(i));
            arr.push(itemDescriptor
              ? serializeForTrace(itemDescriptor.value, { budget: budget }, depth + 1, seen)
              : { __type: 'accessor' });
          }
          if (value.length > arrayLimit) {
            arr.push(traceTruncated('array-items-limit', {
              omittedItems: value.length - arrayLimit,
              length: value.length,
            }));
          }
          return arr;
        }

        var errorInfo = traceErrorInfo(value);
        if (errorInfo) {
          consumeTraceBudget(budget, 256);
          return {
            __type: 'error',
            name: errorInfo.name,
            message: errorInfo.message,
            stack: errorInfo.stack.slice(0, TRACE_STRING_PREVIEW),
          };
        }

        var keys = Object.keys(value);
        var out = {};
        var keyLimit = Math.min(keys.length, TRACE_OBJECT_KEYS);
        for (var j = 0; j < keyLimit; j++) {
          var key = keys[j];
          if (consumeTraceBudget(budget, key.length)) {
            out.__truncated = true;
            out.__truncatedReason = 'trace-budget-exceeded';
            break;
          }
          var descriptor = traceOwnDataDescriptor(value, key);
          out[key] = descriptor
            ? serializeForTrace(descriptor.value, { budget: budget }, depth + 1, seen)
            : { __type: 'accessor' };
          if (budget.exhausted) {
            out.__truncated = true;
            out.__truncatedReason = 'trace-budget-exceeded';
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

    /**
     * 添加调试追踪记录
     */
    function addDebugTraceRecord(record) {
      debugTrace.push(record);
      // 限制最大记录数（FIFO）
      if (debugTrace.length > MAX_DEBUG_TRACE) {
        debugTrace.shift();
      }
    }

    // --- 节点路由拥有的少量 executor 状态回调 ---

    function execCallPageFunction(node, params, execution) {
      return pageEvaluateOps.execCallPageFunction(node, params, execution);
    }

    function execLoopStart(params) {
      var loopId = params.loopId;
      var maxIter = Number(params.maxIterations) || 0;
      var existing = loopStack.find(function (item) { return item.loopId === loopId; });
      if (!existing) {
        var itemsPath = String(params.itemsPath || '').trim();
        var items = itemsPath ? globalThis.Template.resolvePath(runCtx, itemsPath) : null;
        if (itemsPath && !Array.isArray(items)) {
          throw new Error('循环数据路径不是数组: ' + itemsPath);
        }
        var itemCount = Array.isArray(items) ? items.length : 0;
        var effectiveMax = itemCount > 0 && maxIter > 0 ? Math.min(itemCount, maxIter) : (itemCount > 0 ? itemCount : maxIter);
        loopStack.push({
          loopId: loopId,
          index: 0,
          maxIterations: effectiveMax,
          breakCondition: params.breakCondition,
          itemsPath: itemsPath,
          items: items,
          itemCount: itemCount,
        });
      } else {
        existing.index++;
      }
      var loop = loopStack.find(function (item) { return item.loopId === loopId; });
      runCtx.index = loop.index;
      if (loop.itemsPath && loop.itemCount === 0) {
        runCtx.item = undefined;
        runCtx.loop = { id: loopId, index: 0, count: 0, item: undefined };
        return { index: 0, count: 0, item: null, loopBreak: true, loopEmpty: true };
      }
      var currentItem = loop.itemsPath ? loop.items[loop.index] : undefined;
      runCtx.item = currentItem;
      runCtx.loop = { id: loopId, index: loop.index, count: loop.itemCount, item: currentItem };
      return { index: loop.index, count: loop.itemCount, item: currentItem };
    }

    function execTurndownToMarkdown(params, execution) {
      throwIfStopped();
      var sandbox = getSandboxEngine();
      if (!sandbox || typeof sandbox.turndownHtmlToMarkdown !== 'function') {
        throw new Error('Turndown 转换器未加载');
      }
      var sourceMode = params.sourceMode || 'last';
      var html;
      if (sourceMode === 'literal') {
        html = params.html || '';
      } else if (sourceMode === 'variable') {
        html = globalThis.Template.resolvePath(runCtx, params.sourcePath || 'last');
      } else {
        html = runCtx.last;
      }
      if (globalThis.FlowData && globalThis.FlowData.isFlowData(html)) {
        html = globalThis.FlowData.getContent(html);
      }
      if (html === undefined || html === null) html = '';
      if (typeof html !== 'string') {
        throw new Error('HTML 转 Markdown 的输入必须是字符串');
      }
      var customRules = params.customRules;
      if (typeof customRules === 'string' && customRules.trim()) {
        try { customRules = JSON.parse(customRules); }
        catch (_) { throw new Error('customRules 必须是有效 JSON 数组'); }
      }
      if (customRules === undefined || customRules === null || customRules === '') customRules = [];
      if (!Array.isArray(customRules)) throw new Error('customRules 必须是 JSON 数组');
      return sandbox.turndownHtmlToMarkdown(html, {
        options: {
          headingStyle: params.headingStyle || 'atx',
          bulletListMarker: params.bulletListMarker || '-',
          codeBlockStyle: params.codeBlockStyle || 'fenced',
          emDelimiter: params.emDelimiter || '*',
          strongDelimiter: params.strongDelimiter || '**',
          gfm: params.gfm !== false,
        },
        customRules: customRules,
      }, { timeoutMs: params.timeoutMs || 60000, signal: execution && execution.signal });
    }

    function execLoopBreak(params, execution) {
      if (params.condition && !evalTemplateCondition(params.condition, 'Break ', execution)) {
        return { loopBreak: false };
      }
      return { loopBreak: true };
    }

    function execLoopContinue(params, execution) {
      if (params.condition && !evalTemplateCondition(params.condition, 'Continue ', execution)) {
        return { loopContinue: false };
      }
      return { loopContinue: true };
    }

    function execIfStart(params, execution) {
      return {
        conditionMet: params.condition ? evalTemplateCondition(params.condition, 'If ', execution) : false,
      };
    }

    function execJsonExtract(params) {
      var FlowData = globalThis.FlowData;
      var Template = globalThis.Template;
      // Resolve dotted/bracket paths through the same FlowData-aware path
      // contract used by the other data nodes; direct runCtx indexing would
      // make sources such as response.data silently appear missing.
      var source = resolveCtxValue(params.source || 'last', 'last');
      if (FlowData && FlowData.isFlowData(source)) source = FlowData.getContent(source);
      if (source === undefined || source === null) {
        return params.defaultValue !== undefined ? parseJsonValue(params.defaultValue, params.defaultValue, 'JSON 默认值') : null;
      }
      var path = params.path || '';
      if (!path) return source;
      var result = Template.resolvePath(source, path);
      return result !== undefined ? result
        : (params.defaultValue !== undefined ? parseJsonValue(params.defaultValue, params.defaultValue, 'JSON 默认值') : null);
    }

    var scriptOps = nodeScriptOpsModule.createScriptOps({
      tabRuntime: tabRuntime,
      FlowData: globalThis.FlowData,
      getConfig: getConfig,
      getSandboxEngine: getSandboxEngine,
      getRunCtx: function () { return runCtx; },
      throwIfStopped: throwIfStopped,
      openPage: openPage,
      refreshPage: refreshPage,
      navigatePage: navigatePage,
      executePageCommand: function (command, params, execution) {
        return executeUnifiedPageCommand('', command, params, execution, 'script');
      },
      execGetCurrentTab: execGetCurrentTab,
      execPageEvaluate: execPageEvaluate,
      buildCallPageFunctionCode: buildCallPageFunctionCode,
      execScreenshot: visualNodes.execScreenshot,
      getModelClient: getModelClient,
      httpFetch: httpNodes.httpFetch,
      execSaveFile: fileOpsExecutor.execSaveFile,
      logForExecution: logForExecution,
      addLog: addLog,
    });

    function executeApiCall(api, args, execution) {
      return scriptOps.executeApiCall(api, args, execution);
    }

    var nodeDispatcher = nodeDispatcherModule.createNodeDispatcher({
      page: {
        openPage: openPage,
        perceive: perceivePage,
        act: actPage,
        verify: verifyPage,
        execGetCurrentTab: execGetCurrentTab,
        execPageEvaluate: execPageEvaluate,
        execCallPageFunction: execCallPageFunction,
        execRuntimeModuleAction: execRuntimeModuleAction,
      },
      http: httpNodes,
      data: dataOps,
      random: randomDataExecutor,
      file: fileOpsExecutor,
      browser: browserOpsExecutor,
      visual: visualNodes,
      model: modelNodes,
      assistant: { execRunAssistant: execRunAssistant },
      callbacks: {
        logForExecution: logForExecution,
        execForEachParallel: execForEachParallel,
        execExportTestReport: execExportTestReport,
        execAttachArtifact: execAttachArtifact,
        execAssertPerformance: execAssertPerformance,
        execExitGate: execExitGate,
        execExportRunSummary: execExportRunSummary,
        execAccessibilityCheck: execAccessibilityCheck,
        execCoverageMark: execCoverageMark,
        execMockNetwork: execMockNetwork,
        execRouteAssert: execRouteAssert,
        execSetVariable: execSetVariable,
        execAddAttribute: execAddAttribute,
        execAssertValue: execAssertValue,
        delaySegmented: delaySegmented,
        execLogData: execLogData,
        execTurndownToMarkdown: execTurndownToMarkdown,
        execRunScript: scriptOps.execRunScript,
        execLoopStart: execLoopStart,
        execLoopBreak: execLoopBreak,
        execStatusBreak: execStatusBreak,
        execLoopContinue: execLoopContinue,
        execIfStart: execIfStart,
        execJsonExtract: execJsonExtract,
      },
    });

    // --- 节点执行核心 ---

    function executeNodeInstance(node, state) {
      state = state || {};
      var executionFrame = createExecutionFrame(node && typeof node === 'object' && !Array.isArray(node) ? node : null);
      var executionHandle = createExecutionScope(executionFrame);
      var execution = executionHandle.scope;
      pushCurrentLogNode(executionFrame);
      var startTime = 0;
      var previousLast;
      var inputSnapshot = null;
      var params;

      return Promise.resolve().then(function () {
        throwIfStopped();
        executionContract.assertNode(node);
        if (state.resetContext === true) resetCtx();
        if (state.context && typeof state.context === 'object') {
          Object.keys(state.context).forEach(function (key) {
            if (!safeContextKey(key)) return;
            var descriptor;
            try { descriptor = Object.getOwnPropertyDescriptor(state.context, key); } catch (_) {}
            if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) runCtx[key] = descriptor.value;
          });
        }

        startTime = Date.now();
        previousLast = runCtx.last;

        if (debugEnabled) inputSnapshot = captureContextSnapshot();

        // Interpolate before normalization so numeric ranges and schema default templates both resolve.
        params = mergeNodeForegroundOptions(node, executionContract.restoreLateTemplateParams(
          node,
          executionContract.resolveNodeParams(node, runCtx)
        ));

        return nodeDispatcher.dispatch(node, params, state, execution);
      }).then(function (result) {
        var completion;
        try {
          completion = executionContract.applyResult(result, node, {
            params: params,
            previousLast: previousLast,
            flowId: state.flowId,
            flowLabel: state.flowLabel,
            startTime: startTime,
            addLog: execution.addLog,
          });
        } catch (error) {
          var replaySafe = globalThis.NodeTypes && typeof globalThis.NodeTypes.isNodeReplaySafe === 'function'
            ? globalThis.NodeTypes.isNodeReplaySafe(node) : false;
          if (!replaySafe && error && (typeof error === 'object' || typeof error === 'function')) {
            var receipt = result && typeof result === 'object' && (result.receipt || result.actionReceipt);
            try {
              error.performed = receipt && receipt.performed || 'yes';
              error.retryable = false;
              if (receipt) error.receipt = receipt;
            } catch (_) {}
          }
          throw error;
        }

        // 调试追踪：记录输出
        if (debugEnabled && inputSnapshot) {
          addDebugTraceRecord({
            nodeId: executionFrame.nodeId,
            nodeType: executionFrame.nodeType,
            nodeTitle: executionFrame.nodeTitle,
            executionInstanceId: executionFrame.instanceId,
            timestamp: Date.now(),
            executionTime: Date.now() - startTime,
            status: 'completed',
            params: serializeForTrace(params, { budgetChars: TRACE_VALUE_BUDGET }),
            input: inputSnapshot,
            output: serializeForTrace(completion.flowData, { budgetChars: TRACE_VALUE_BUDGET }),
            error: null,
          });
        }

        compactRuntimeState({ reason: 'node-complete', nodeId: executionFrame.nodeId });
        return result;
      }).catch(function (err) {
        // 调试追踪：记录错误
        if (debugEnabled && inputSnapshot) {
          addDebugTraceRecord({
            nodeId: executionFrame.nodeId,
            nodeType: executionFrame.nodeType,
            nodeTitle: executionFrame.nodeTitle,
            executionInstanceId: executionFrame.instanceId,
            timestamp: Date.now(),
            executionTime: Date.now() - startTime,
            status: 'failed',
            params: serializeForTrace(params, { budgetChars: TRACE_VALUE_BUDGET }),
            input: inputSnapshot,
            output: null,
            error: err ? err.message : 'Unknown error',
          });
        }
        compactRuntimeState({ reason: 'node-error', nodeId: executionFrame.nodeId });
        throw err;
      }).finally(function () {
        executionHandle.release();
        removeCurrentLogNode(executionFrame);
      });
    }

    function getLoopStack() {
      return loopStack;
    }

    return {
      resetCtx: resetCtx,
      getCtx: getCtx,
      setCtx: setCtx,
      getLoopStack: getLoopStack,
      setLoopStack: setLoopStack,
      getDebugTrace: getDebugTrace,
      setDebugEnabled: setDebugEnabled,
      compactRuntimeState: compactRuntimeState,
      executeNodeInstance: executeNodeInstance,
      executeApiCall: executeApiCall,
    };
  }

  return { createNodeExecutor: createNodeExecutor };
});
