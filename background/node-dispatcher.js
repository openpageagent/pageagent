// Node Dispatcher - pure node-type routing over explicitly injected handler adapters.
(function attachNodeDispatcher(root, factory) {
  'use strict';

  var api = factory();
  var commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.NodeDispatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var UNSAFE_TYPES = Object.create(null);
  UNSAFE_TYPES.__proto__ = true;
  UNSAFE_TYPES.prototype = true;
  UNSAFE_TYPES.constructor = true;

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
      throw new Error('NodeDispatcher missing dependency: ' + name);
    }
    return value;
  }

  function requireMethod(owner, method, name) {
    requireObject(owner, name);
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(owner, method); } catch (_) {}
    if (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw new Error('NodeDispatcher missing dependency: ' + name + '.' + method);
    }
    // Return the function value without binding owner. Existing executor adapters are
    // invoked as bare functions, and preserving that call shape avoids changing `this`.
    return descriptor.value;
  }

  function safeType(type) {
    return typeof type === 'string' && type.length > 0 && UNSAFE_TYPES[type] !== true;
  }

  function addRoute(routes, type, handler) {
    if (!safeType(type)) throw new Error('NodeDispatcher invalid node type: ' + type);
    if (hasOwn(routes, type)) throw new Error('NodeDispatcher duplicate node type: ' + type);
    if (typeof handler !== 'function') throw new Error('NodeDispatcher invalid handler: ' + type);
    Object.defineProperty(routes, type, {
      value: handler,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  function ownRoute(routes, type) {
    if (!safeType(type)) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(routes, type); } catch (_) {}
    return descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      ? descriptor.value
      : null;
  }

  function nodeType(node) {
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(node, 'type'); } catch (_) {}
    return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }

  function callParams(fn) {
    return function (_node, params) { return fn(params); };
  }

  function callParamsExecution(fn) {
    return function (_node, params, _state, execution) { return fn(params, execution); };
  }

  function callParamsState(fn) {
    return function (_node, params, state) { return fn(params, state); };
  }

  function callParamsStateExecution(fn) {
    return function (_node, params, state, execution) { return fn(params, state, execution); };
  }

  function callNodeParamsExecution(fn) {
    return function (node, params, _state, execution) { return fn(node, params, execution); };
  }

  function callNodeParamsStateExecution(fn) {
    return function (node, params, state, execution) { return fn(node, params, state, execution); };
  }

  function callPageParams(fn) {
    return function (node, params) { return fn(node.pageId, params); };
  }

  function callPageParamsExecution(fn) {
    return function (node, params, _state, execution) { return fn(node.pageId, params, execution); };
  }

  function callExecution(fn) {
    return function (_node, _params, _state, execution) { return fn(execution); };
  }

  function createNodeDispatcher(deps) {
    deps = deps || {};
    var page = requireObject(deps.page, 'page');
    var http = requireObject(deps.http, 'http');
    var data = requireObject(deps.data, 'data');
    var random = requireObject(deps.random, 'random');
    var file = requireObject(deps.file, 'file');
    var browser = requireObject(deps.browser, 'browser');
    var visual = requireObject(deps.visual, 'visual');
    var model = requireObject(deps.model, 'model');
    var assistant = requireObject(deps.assistant, 'assistant');
    var callbacks = requireObject(deps.callbacks, 'callbacks');

    var openPage = requireMethod(page, 'openPage', 'page');
    var perceive = requireMethod(page, 'perceive', 'page');
    var act = requireMethod(page, 'act', 'page');
    var verify = requireMethod(page, 'verify', 'page');
    var execGetCurrentTab = requireMethod(page, 'execGetCurrentTab', 'page');
    var execPageEvaluate = requireMethod(page, 'execPageEvaluate', 'page');
    var execCallPageFunction = requireMethod(page, 'execCallPageFunction', 'page');
    var execRuntimeModuleAction = requireMethod(page, 'execRuntimeModuleAction', 'page');

    var httpFetch = requireMethod(http, 'httpFetch', 'http');
    var execHttpLoadTest = requireMethod(http, 'execHttpLoadTest', 'http');
    var execWebhook = requireMethod(http, 'execWebhook', 'http');

    var execDataMap = requireMethod(data, 'execDataMap', 'data');
    var execDataCompose = requireMethod(data, 'execDataCompose', 'data');
    var execDataProject = requireMethod(data, 'execDataProject', 'data');
    var execDataFilter = requireMethod(data, 'execDataFilter', 'data');
    var execDataJoin = requireMethod(data, 'execDataJoin', 'data');
    var execDataDedupe = requireMethod(data, 'execDataDedupe', 'data');
    var execDataAggregate = requireMethod(data, 'execDataAggregate', 'data');
    var execCheckpointGet = requireMethod(data, 'execCheckpointGet', 'data');
    var execCheckpointSet = requireMethod(data, 'execCheckpointSet', 'data');
    var execDataDiff = requireMethod(data, 'execDataDiff', 'data');
    var execContextPrune = requireMethod(data, 'execContextPrune', 'data');

    var execRandomData = requireMethod(random, 'execRandomData', 'random');
    var execClosePage = requireMethod(file, 'execClosePage', 'file');
    var execWaitDownload = requireMethod(file, 'execWaitDownload', 'file');
    var execSaveFile = requireMethod(file, 'execSaveFile', 'file');
    var execDownloadMedia = requireMethod(file, 'execDownloadMedia', 'file');
    var execSetCookie = requireMethod(browser, 'execSetCookie', 'browser');
    var execGetCookie = requireMethod(browser, 'execGetCookie', 'browser');
    var execClearCookies = requireMethod(browser, 'execClearCookies', 'browser');
    var execSetProxy = requireMethod(browser, 'execSetProxy', 'browser');
    var execClearProxy = requireMethod(browser, 'execClearProxy', 'browser');
    var execScreenshot = requireMethod(visual, 'execScreenshot', 'visual');
    var execAssertScreenshot = requireMethod(visual, 'execAssertScreenshot', 'visual');
    var execRequestModelAssert = requireMethod(model, 'execRequestModelAssert', 'model');
    var execRequestModelExtract = requireMethod(model, 'execRequestModelExtract', 'model');
    var execRequestModelAction = requireMethod(model, 'execRequestModelAction', 'model');
    var execRunAssistant = requireMethod(assistant, 'execRunAssistant', 'assistant');

    var logForExecution = requireMethod(callbacks, 'logForExecution', 'callbacks');
    var execForEachParallel = requireMethod(callbacks, 'execForEachParallel', 'callbacks');
    var execExportTestReport = requireMethod(callbacks, 'execExportTestReport', 'callbacks');
    var execAttachArtifact = requireMethod(callbacks, 'execAttachArtifact', 'callbacks');
    var execAssertPerformance = requireMethod(callbacks, 'execAssertPerformance', 'callbacks');
    var execExitGate = requireMethod(callbacks, 'execExitGate', 'callbacks');
    var execExportRunSummary = requireMethod(callbacks, 'execExportRunSummary', 'callbacks');
    var execAccessibilityCheck = requireMethod(callbacks, 'execAccessibilityCheck', 'callbacks');
    var execCoverageMark = requireMethod(callbacks, 'execCoverageMark', 'callbacks');
    var execMockNetwork = requireMethod(callbacks, 'execMockNetwork', 'callbacks');
    var execRouteAssert = requireMethod(callbacks, 'execRouteAssert', 'callbacks');
    var execSetVariable = requireMethod(callbacks, 'execSetVariable', 'callbacks');
    var execAddAttribute = requireMethod(callbacks, 'execAddAttribute', 'callbacks');
    var execAssertValue = requireMethod(callbacks, 'execAssertValue', 'callbacks');
    var delaySegmented = requireMethod(callbacks, 'delaySegmented', 'callbacks');
    var execLogData = requireMethod(callbacks, 'execLogData', 'callbacks');
    var execRunScript = requireMethod(callbacks, 'execRunScript', 'callbacks');
    var execTurndownToMarkdown = requireMethod(callbacks, 'execTurndownToMarkdown', 'callbacks');
    var execLoopStart = requireMethod(callbacks, 'execLoopStart', 'callbacks');
    var execLoopBreak = requireMethod(callbacks, 'execLoopBreak', 'callbacks');
    var execStatusBreak = requireMethod(callbacks, 'execStatusBreak', 'callbacks');
    var execLoopContinue = requireMethod(callbacks, 'execLoopContinue', 'callbacks');
    var execIfStart = requireMethod(callbacks, 'execIfStart', 'callbacks');
    var execJsonExtract = requireMethod(callbacks, 'execJsonExtract', 'callbacks');

    var routes = Object.create(null);

    function perception(command) {
      return function (node, params, _state, execution) {
        return perceive(node.pageId, command, params, execution);
      };
    }

    function action(command) {
      return function (node, params, _state, execution) {
        return act(node.pageId, command, params, execution);
      };
    }

    function verification(command) {
      return function (node, params, _state, execution) {
        return verify(node.pageId, command, params, execution);
      };
    }

    addRoute(routes, 'openPage', callPageParamsExecution(openPage));
    addRoute(routes, 'refreshPage', action('reload'));
    addRoute(routes, 'navigate', function (node, params, _state, execution) {
      return act(node.pageId, 'navigate', params, execution);
    });
    addRoute(routes, 'pageAction', action('pageAction'));
    addRoute(routes, 'clickElement', action('click'));
    addRoute(routes, 'fillInput', action('fill'));
    addRoute(routes, 'selectOption', action('select'));
    addRoute(routes, 'fillFormFields', action('fillFormFields'));
    addRoute(routes, 'waitForCondition', verification('waitForCondition'));
    addRoute(routes, 'waitForElement', verification('waitForElement'));
    addRoute(routes, 'waitForPageLoad', verification('waitForPageLoad'));
    addRoute(routes, 'activateTab', action('activateTab'));
    addRoute(routes, 'getCurrentTab', callPageParamsExecution(execGetCurrentTab));
    addRoute(routes, 'executePageJavascript', function (node, params, _state, execution) {
      return execPageEvaluate(node.pageId, params.source, Object.assign({}, params, { sourceType: 'body', returnEnvelope: true }), execution);
    });
    addRoute(routes, 'assertElement', verification('assertElement'));
    addRoute(routes, 'assertText', verification('assertText'));
    addRoute(routes, 'assertAttribute', verification('assertAttribute'));
    addRoute(routes, 'extractText', perception('extractText'));
    addRoute(routes, 'elementInfo', perception('elementInfo'));
    addRoute(routes, 'inspectStructure', perception('inspectStructure'));
    addRoute(routes, 'inspectText', perception('inspectText'));
    addRoute(routes, 'inspectHtml', perception('inspectHtml'));
    addRoute(routes, 'inspectCss', perception('inspectCss'));
    addRoute(routes, 'inspectJavascript', perception('inspectJavascript'));
    addRoute(routes, 'searchPage', perception('searchPage'));
    addRoute(routes, 'dragDrop', action('dragDrop'));
    addRoute(routes, 'screenshot', callPageParamsExecution(execScreenshot));
    addRoute(routes, 'assertScreenshot', callNodeParamsExecution(execAssertScreenshot));
    addRoute(routes, 'httpRequest', function (_node, params, _state, execution) {
      var requestMethod = String(params.method || 'GET').toUpperCase();
      logForExecution(execution, 'HTTP 请求: ' + requestMethod + ' ' + params.url);
      return httpFetch(params.url, {
        method: requestMethod,
        headers: params.headers,
        body: params.body,
        timeoutMs: params.timeoutMs,
        signal: execution && execution.signal,
      });
    });
    addRoute(routes, 'httpLoadTest', callParamsExecution(execHttpLoadTest));
    addRoute(routes, 'dataMap', callParams(execDataMap));
    addRoute(routes, 'dataCompose', callParams(execDataCompose));
    addRoute(routes, 'dataProject', callParams(execDataProject));
    addRoute(routes, 'dataFilter', callParams(execDataFilter));
    addRoute(routes, 'dataJoin', callParams(execDataJoin));
    addRoute(routes, 'dataDedupe', callParams(execDataDedupe));
    addRoute(routes, 'dataAggregate', callParams(execDataAggregate));
    addRoute(routes, 'checkpointGet', callParamsStateExecution(execCheckpointGet));
    addRoute(routes, 'checkpointSet', callParamsStateExecution(execCheckpointSet));
    addRoute(routes, 'dataDiff', callParams(execDataDiff));
    addRoute(routes, 'forEachParallel', callParamsExecution(execForEachParallel));
    addRoute(routes, 'exportTestReport', callParamsStateExecution(execExportTestReport));
    addRoute(routes, 'attachArtifact', callParamsExecution(execAttachArtifact));
    addRoute(routes, 'assertPerformance', callParams(execAssertPerformance));
    addRoute(routes, 'exitGate', callParamsState(execExitGate));
    addRoute(routes, 'exportRunSummary', callParamsStateExecution(execExportRunSummary));
    addRoute(routes, 'accessibilityCheck', callNodeParamsExecution(execAccessibilityCheck));
    addRoute(routes, 'coverageMark', callParams(execCoverageMark));
    addRoute(routes, 'mockNetwork', callNodeParamsExecution(execMockNetwork));
    addRoute(routes, 'routeAssert', callNodeParamsExecution(execRouteAssert));
    addRoute(routes, 'setVariable', callParams(execSetVariable));
    addRoute(routes, 'contextPrune', callParams(execContextPrune));
    addRoute(routes, 'addAttribute', callParamsExecution(execAddAttribute));
    addRoute(routes, 'randomData', callParams(execRandomData));
    addRoute(routes, 'handleDialog', action('handleDialog'));
    addRoute(routes, 'closePage', callPageParamsExecution(execClosePage));
    addRoute(routes, 'waitDownload', callParamsExecution(execWaitDownload));
    addRoute(routes, 'saveFile', callParamsExecution(execSaveFile));
    addRoute(routes, 'downloadMedia', callParamsExecution(execDownloadMedia));
    addRoute(routes, 'requestModelAssert', callNodeParamsExecution(execRequestModelAssert));
    addRoute(routes, 'requestModelExtract', callNodeParamsExecution(execRequestModelExtract));
    addRoute(routes, 'requestModelAction', callNodeParamsExecution(execRequestModelAction));
    addRoute(routes, 'runAssistant', callNodeParamsStateExecution(execRunAssistant));
    addRoute(routes, 'assertValue', callParams(execAssertValue));
    addRoute(routes, 'assertUrl', verification('assertUrl'));
    addRoute(routes, 'scrollPage', action('scroll'));
    addRoute(routes, 'scrollInfo', perception('scrollInfo'));
    addRoute(routes, 'hoverElement', action('hover'));
    addRoute(routes, 'keyPress', action('keyPress'));
    addRoute(routes, 'uploadFile', action('uploadFile'));
    addRoute(routes, 'webStorage', function (node, params, _state, execution) {
      return String(params.action || 'get') === 'get'
        ? perceive(node.pageId, 'webStorage', params, execution)
        : act(node.pageId, 'webStorage', params, execution);
    });
    addRoute(routes, 'setCookie', callParamsExecution(execSetCookie));
    addRoute(routes, 'getCookie', callParamsExecution(execGetCookie));
    addRoute(routes, 'clearCookies', callParamsExecution(execClearCookies));
    addRoute(routes, 'setProxy', callPageParamsExecution(execSetProxy));
    addRoute(routes, 'clearProxy', callExecution(execClearProxy));
    addRoute(routes, 'extractTable', perception('extractTable'));
    addRoute(routes, 'extractList', perception('extractList'));
    addRoute(routes, 'extractScrollingList', perception('extractScrollingList'));
    addRoute(routes, 'getRequests', perception('getRequests'));
    addRoute(routes, 'replayRequest', function (node, params, _state, execution) {
      return act(node.pageId, 'replayRequest', params, execution);
    });
    addRoute(routes, 'patchPage', action('patchPage'));
    addRoute(routes, 'callPageFunction', callNodeParamsExecution(execCallPageFunction));
    addRoute(routes, 'runtimeModuleAction', callNodeParamsExecution(execRuntimeModuleAction));
    addRoute(routes, 'cdp.inspect_dom_snapshot', perception('cdp.inspect_dom_snapshot'));
    addRoute(routes, 'cdp.inspect_ax_tree', perception('cdp.inspect_ax_tree'));
    addRoute(routes, 'cdp.inspect_network', perception('cdp.inspect_network'));
    addRoute(routes, 'cdp.analyze_performance', perception('cdp.analyze_performance'));
    addRoute(routes, 'cdp.replay_request', function (node, params, _state, execution) {
      return act(node.pageId, 'cdp.replay_request', params, execution);
    });
    addRoute(routes, 'cdp.screenshot', perception('cdp.screenshot'));
    addRoute(routes, 'getSseEvents', perception('getSseEvents'));
    addRoute(routes, 'clearNetworkCapture', perception('clearNetworkCapture'));
    addRoute(routes, 'delay', function (_node, params, _state, execution) { return delaySegmented(params.ms, execution); });
    addRoute(routes, 'logData', callParamsExecution(execLogData));
    addRoute(routes, 'runScript', callParamsExecution(execRunScript));
    addRoute(routes, 'turndownToMarkdown', callParamsExecution(execTurndownToMarkdown));
    addRoute(routes, 'webhook', callParamsExecution(execWebhook));
    addRoute(routes, 'loopStart', callParams(execLoopStart));
    addRoute(routes, 'loopEnd', function () { return { loopEnd: true }; });
    addRoute(routes, 'loopBreak', callParamsExecution(execLoopBreak));
    addRoute(routes, 'statusBreak', function (node, params, _state, execution) {
      return execStatusBreak(params, node, execution);
    });
    addRoute(routes, 'loopContinue', callParamsExecution(execLoopContinue));
    addRoute(routes, 'ifStart', callParamsExecution(execIfStart));
    addRoute(routes, 'elseBlock', function () { return {}; });
    addRoute(routes, 'ifEnd', function () { return {}; });
    addRoute(routes, 'jsonExtract', callParams(execJsonExtract));

    Object.freeze(routes);
    var types = Object.freeze(Object.keys(routes));

    function dispatch(node, params, state, execution) {
      var type = nodeType(node);
      var handler = ownRoute(routes, type);
      if (!handler) return Promise.reject(new Error('未知节点类型: ' + type));
      // One Promise boundary captures synchronous throws and adopts async/falsy results
      // without changing the handler argument order. execution remains the last argument.
      return Promise.resolve().then(function () {
        return handler(node, params, state, execution);
      });
    }

    return Object.freeze({
      dispatch: dispatch,
      has: function (type) { return !!ownRoute(routes, type); },
      getTypes: function () { return types.slice(); },
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    createNodeDispatcher: createNodeDispatcher,
  });
});
