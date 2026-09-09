// Script node execution and sandbox API bridge.
(function attachNodeScriptOps(root, factory) {
  'use strict';

  var api = factory();
  var commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.NodeScriptOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function ownDataDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
    return descriptor && !descriptor.get && !descriptor.set && hasOwn(descriptor, 'value')
      ? descriptor
      : null;
  }

  function ownDataValue(value, key, fallback) {
    var descriptor = ownDataDescriptor(value, key);
    return descriptor ? descriptor.value : fallback;
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, String(key), {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return value;
  }

  function safeContextKey(key) {
    return typeof key === 'string' && key.length > 0
      && key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
  }

  function copyOwnData(value) {
    var output = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    Object.keys(value).forEach(function (key) {
      var descriptor = ownDataDescriptor(value, key);
      if (!descriptor) return;
      defineOwn(output, key, descriptor.value);
    });
    return output;
  }

  function mergeOwnData() {
    var output = {};
    for (var index = 0; index < arguments.length; index++) {
      var source = arguments[index];
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      Object.keys(source).forEach(function (key) {
        var descriptor = ownDataDescriptor(source, key);
        if (!descriptor) return;
        defineOwn(output, key, descriptor.value);
      });
    }
    return output;
  }

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('NodeScriptOps missing dependency: ' + name);
    return value;
  }

  function requireObject(value, name) {
    if (!value || typeof value !== 'object') throw new Error('NodeScriptOps missing dependency: ' + name);
    return value;
  }

  function requireMethod(value, method, name) {
    requireObject(value, name);
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, method); } catch (_) {}
    if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'function') {
      throw new Error('NodeScriptOps missing dependency: ' + name + '.' + method);
    }
    return descriptor.value.bind(value);
  }

  function createScriptOps(deps) {
    deps = deps || {};
    var tabRuntime = requireObject(deps.tabRuntime, 'tabRuntime');
    var flowData = requireObject(deps.FlowData, 'FlowData');
    var flowDataGetContent = requireMethod(flowData, 'getContent', 'FlowData');
    var flowDataAddAttributes = requireMethod(flowData, 'addAttributes', 'FlowData');
    var flowDataGetAttribute = requireMethod(flowData, 'getAttribute', 'FlowData');
    var flowDataGetAttributes = requireMethod(flowData, 'getAttributes', 'FlowData');
    var getConfig = requireFunction(deps.getConfig, 'getConfig');
    var getSandboxEngine = requireFunction(deps.getSandboxEngine, 'getSandboxEngine');
    var getRunCtx = requireFunction(deps.getRunCtx, 'getRunCtx');
    var throwIfStopped = requireFunction(deps.throwIfStopped, 'throwIfStopped');
    var openPage = requireFunction(deps.openPage, 'openPage');
    var refreshPage = requireFunction(deps.refreshPage, 'refreshPage');
    var navigatePage = requireFunction(deps.navigatePage, 'navigatePage');
    var executePageCommand = requireFunction(deps.executePageCommand, 'executePageCommand');
    var execGetCurrentTab = requireFunction(deps.execGetCurrentTab, 'execGetCurrentTab');
    var execPageEvaluate = requireFunction(deps.execPageEvaluate, 'execPageEvaluate');
    var buildCallPageFunctionCode = requireFunction(deps.buildCallPageFunctionCode, 'buildCallPageFunctionCode');
    var execScreenshot = requireFunction(deps.execScreenshot, 'execScreenshot');
    var getModelClient = requireFunction(deps.getModelClient, 'getModelClient');
    var httpFetch = requireFunction(deps.httpFetch, 'httpFetch');
    var execSaveFile = requireFunction(deps.execSaveFile, 'execSaveFile');
    var logForExecution = requireFunction(deps.logForExecution, 'logForExecution');
    var addLog = requireFunction(deps.addLog, 'addLog');

    function normalizeClickArgs(arg) {
      if (typeof arg === 'string') return { selector: arg };
      return copyOwnData(arg);
    }

    function normalizeFileSaveArgs(args) {
      if (typeof args[0] === 'string') {
        var options = copyOwnData(args[2]);
        defineOwn(options, 'fileName', args[0]);
        defineOwn(options, 'content', args[1]);
        if (!ownDataValue(options, 'sourceMode', '')) defineOwn(options, 'sourceMode', 'literal');
        return options;
      }
      return copyOwnData(args[0]);
    }

    function withApiTabId(tabId, params) {
      var output = copyOwnData(params);
      defineOwn(output, 'tabId', tabId);
      return output;
    }

    // Script helpers are a convenience surface rather than Flow node schema
    // forms, so callers often omit the page-data window. Materialize the
    // contract defaults here while still routing every returned value through
    // the same bounded start/maxChars fields as ordinary nodes.
    function pageWindowOptions(raw) {
      var output = copyOwnData(raw);
      if (!hasOwn(output, 'start') || output.start === undefined || output.start === null || output.start === '') {
        defineOwn(output, 'start', 0);
      }
      if (!hasOwn(output, 'maxChars') || output.maxChars === undefined || output.maxChars === null || output.maxChars === '') {
        defineOwn(output, 'maxChars', 10000);
      }
      return output;
    }

    function withPageWindow(tabId, params) {
      return withApiTabId(tabId, pageWindowOptions(params));
    }

    function isOwnFlowData(value) {
      var marker = ownDataDescriptor(value, '__isFlowData');
      if (marker && marker.value === true) return true;
      var attributes = ownDataDescriptor(value, 'attributes');
      var content = ownDataDescriptor(value, 'content');
      return !!(attributes && content && attributes.value && typeof attributes.value === 'object');
    }

    function resolveOwnPath(value, path) {
      var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
      var parts = normalized.split('.').filter(function (part) { return part !== ''; });
      if (!parts.length) return undefined;
      var current = value;
      for (var index = 0; index < parts.length; index++) {
        if (current === null || current === undefined) return undefined;
        var part = parts[index];
        if (isOwnFlowData(current)) {
          if (part === 'attributes' || part === 'content') {
            current = ownDataValue(current, part, undefined);
            continue;
          }
          current = flowDataGetContent(current);
          if (current === null || current === undefined) return undefined;
        }
        var descriptor = ownDataDescriptor(current, part);
        if (descriptor) {
          current = descriptor.value;
          continue;
        }
        var matched = false;
        for (var end = parts.length; end > index + 1; end--) {
          var dottedKey = parts.slice(index, end).join('.');
          descriptor = ownDataDescriptor(current, dottedKey);
          if (!descriptor) continue;
          current = descriptor.value;
          index = end - 1;
          matched = true;
          break;
        }
        if (!matched) return undefined;
      }
      return isOwnFlowData(current) ? flowDataGetContent(current) : current;
    }

    function resolveScriptCode(params) {
      params = params || {};
      var scriptId = ownDataValue(params, 'scriptId', '');
      if (scriptId) {
        var config = getConfig() || {};
        var scripts = ownDataValue(config, 'scripts', null);
        var script = ownDataValue(scripts, scriptId, null);
        if (!script || typeof script !== 'object' || Array.isArray(script)) {
          throw new Error('脚本不存在: ' + scriptId);
        }
        return ownDataValue(script, 'code', '') || '';
      }
      var inlineCode = ownDataValue(params, 'inlineCode', '');
      if (inlineCode) return inlineCode;
      throw new Error('脚本节点未配置脚本');
    }

    function execRunScript(params, execution) {
      params = params || {};
      var justification = String(ownDataValue(params, 'runScriptJustification', '') || '').trim();
      if (!justification) {
        var justificationError = new Error('脚本节点必须填写 runScriptJustification，说明普通节点无法表达的原因');
        justificationError.code = 'RUN_SCRIPT_JUSTIFICATION_REQUIRED';
        throw justificationError;
      }
      var code = resolveScriptCode(params);
      var engine = getSandboxEngine();
      if (!engine || typeof engine.runScript !== 'function') throw new Error('沙箱脚本引擎未初始化');
      logForExecution(execution, '脚本兜底原因: ' + justification, { level: 'info' });
      var apiCall = execution && execution.executeApiCall ? execution.executeApiCall : executeApiCall;
      var scriptLog = execution && execution.addLog ? execution.addLog : addLog;
      return engine.runScript(code, {
        timeoutMs: Number(ownDataValue(params, 'timeoutMs', 0)) || 60000,
        apiCall: apiCall,
        addLog: scriptLog,
        nodeExecutionApiCall: apiCall,
        nodeExecutionAddLog: scriptLog,
        executionFrame: execution && execution.frame || null,
        signal: execution && execution.signal || null,
      }).catch(function (error) {
        // The sandbox may have completed page, HTTP, file, or context mutations
        // before its terminal error reached the host. Replaying it is unsafe.
        if (error && (typeof error === 'object' || typeof error === 'function')) {
          try {
            error.performed = 'unknown';
            error.retryable = false;
          } catch (_) {}
        }
        throw error;
      });
    }

    function executeApiCall(api, args, execution) {
      args = Array.isArray(args) ? args : [];
      throwIfStopped();
      switch (api) {
        case 'page.open':
          return openPage(args[0], copyOwnData(args[1]), execution);
        case 'page.setTabMode':
          if (typeof tabRuntime.setRunTabMode !== 'function') throw new Error('当前运行环境不支持动态切换标签策略');
          return tabRuntime.setRunTabMode(args[0], copyOwnData(args[1]));
        case 'page.getTabMode':
          if (typeof tabRuntime.getRunTabMode !== 'function') throw new Error('当前运行环境不支持读取标签策略');
          return tabRuntime.getRunTabMode();
        case 'page.getCurrentTab':
          return execGetCurrentTab('', { tabId: args[0] }, execution);
        case 'page.getCurrentUrl':
          return execGetCurrentTab('', { tabId: args[0] }, execution).then(function (tab) { return tab.url; });
        case 'page.refresh':
          return refreshPage('', withApiTabId(args[0], args[1]), execution);
        case 'page.navigate':
          return navigatePage('', args[1], withApiTabId(args[0], args[2]), execution);
        case 'page.click':
          return executePageCommand('click', withApiTabId(args[0], normalizeClickArgs(args[1])), execution);
        case 'page.fill':
          return executePageCommand('fill', { tabId: args[0], selector: args[1], value: args[2], timeoutMs: args[3] }, execution);
        case 'page.fillForm':
          return executePageCommand('fillFormFields', withApiTabId(args[0], args[1]), execution);
        case 'page.select':
          return executePageCommand('select', withApiTabId(args[0], typeof args[1] === 'string' ? mergeOwnData({ selector: args[1] }, args[2]) : args[1]), execution);
        case 'page.check':
          return executePageCommand('check', withApiTabId(args[0], typeof args[1] === 'string' ? { selector: args[1], checked: args[2] } : args[1]), execution);
        case 'page.hover':
          return executePageCommand('hover', withApiTabId(args[0], typeof args[1] === 'string' ? { selector: args[1] } : args[1]), execution);
        case 'page.press':
          return executePageCommand('keyPress', { tabId: args[0], selector: args[1], key: args[2], timeoutMs: args[3] }, execution);
        case 'page.scroll':
          return executePageCommand('scroll', withApiTabId(args[0], args[1]), execution);
        case 'page.scrollInfo':
          return executePageCommand('scrollInfo', withApiTabId(args[0], args[1]), execution);
        case 'page.drag':
          return executePageCommand('dragDrop', withApiTabId(args[0], args[1]), execution);
        case 'page.upload':
          return executePageCommand('uploadFile', withApiTabId(args[0], args[1]), execution);
        case 'page.dialog':
          return executePageCommand('handleDialog', withApiTabId(args[0], args[1]), execution);
        case 'page.activate':
          return executePageCommand('activateTab', withApiTabId(args[0], args[1]), execution);
        case 'page.close':
          return executePageCommand('closeTab', withApiTabId(args[0], args[1]), execution);
        case 'page.waitFor':
          return executePageCommand('waitFor', { tabId: args[0], selector: args[1], timeoutMs: args[2] }, execution);
        case 'page.extractTable':
          return executePageCommand('extractTable', withPageWindow(args[0], args[1]), execution);
        case 'page.extractList':
          return executePageCommand('extractList', withPageWindow(args[0], args[1]), execution);
        case 'page.extractScrollingList':
          return executePageCommand('extractScrollingList', withPageWindow(args[0], args[1]), execution);
        case 'page.extractText':
          return executePageCommand('extractText', withPageWindow(args[0], typeof args[1] === 'string' ? { selector: args[1] } : args[1]), execution);
        case 'page.inspectStructure':
          return executePageCommand('inspectStructure', withPageWindow(args[0], args[1]), execution);
        case 'page.inspectElement':
          return executePageCommand('inspectElement', withApiTabId(args[0], typeof args[1] === 'string' ? { selector: args[1] } : args[1]), execution);
        case 'page.inspectText':
          return executePageCommand('inspectText', withPageWindow(args[0], args[1]), execution);
        case 'page.inspectHtml':
          return executePageCommand('inspectHtml', withPageWindow(args[0], args[1]), execution);
        case 'page.inspectCss':
          return executePageCommand('inspectCss', withPageWindow(args[0], args[1]), execution);
        case 'page.inspectJavascript':
          return executePageCommand('inspectJavascript', withPageWindow(args[0], args[1]), execution);
        case 'page.search':
          return executePageCommand('searchPage', withPageWindow(args[0], args[1]), execution);
        case 'page.assertElement':
          return executePageCommand('assertElement', withApiTabId(args[0], args[1]), execution);
        case 'page.assertText':
          return executePageCommand('assertText', withApiTabId(args[0], args[1]), execution);
        case 'page.assertAttribute':
          return executePageCommand('assertAttribute', withApiTabId(args[0], args[1]), execution);
        case 'page.assertValue':
          return executePageCommand('assertValue', withApiTabId(args[0], args[1]), execution);
        case 'page.assertUrl':
          return executePageCommand('assertUrl', withApiTabId(args[0], args[1]), execution);
        case 'page.webStorage':
          return executePageCommand('webStorage', withApiTabId(args[0], args[1]), execution);
        case 'page.getRequests':
          return executePageCommand('getRequests', withPageWindow(args[0], args[1]), execution);
        case 'page.getSseEvents':
          return executePageCommand('getSseEvents', withPageWindow(args[0], args[1]), execution);
        case 'page.clearNetworkCapture':
          return executePageCommand('clearNetworkCapture', withApiTabId(args[0], args[1]), execution);
        case 'page.replayRequest':
          return executePageCommand('replayRequest', withPageWindow(args[0], args[1]), execution);
        case 'page.patch':
          return executePageCommand('patchPage', withApiTabId(args[0], args[1]), execution);
        case 'page.callFunction': {
          var callOptions = mergeOwnData({ riskLabel: 'callPageFunction', returnEnvelope: true, mode: 'write', sourceType: 'expression' }, args[3]);
          callOptions = pageWindowOptions(callOptions);
          return executePageCommand('evaluate', mergeOwnData(withApiTabId(args[0], callOptions), {
            code: buildCallPageFunctionCode(args[1], ownDataValue(args[3], 'thisPath', ''), args[2] || []),
            sourceType: 'expression',
          }), execution);
        }
        case 'page.evaluate':
          return executePageCommand('evaluate', mergeOwnData({ mode: 'write' }, withPageWindow(args[0], args[2]), { code: args[1], sourceType: 'body' }), execution);
        case 'page.cdp': {
          var cdpCommand = String(args[1] || '').replace(/^cdp\./, '');
          var cdpParams = /^(?:inspect_network|inspect_dom_snapshot|inspect_ax_tree|javascript_source|search_script_sources|analyze_performance|replay_request)$/.test(cdpCommand)
            ? pageWindowOptions(args[2]) : copyOwnData(args[2]);
          return executePageCommand('cdp.' + cdpCommand, withApiTabId(args[0], cdpParams), execution);
        }
        case 'page.screenshot':
          return executePageCommand('screenshot', withApiTabId(args[0], args[1]), execution);
        case 'model.chat':
          return Promise.resolve().then(function () {
            var modelClient = getModelClient();
            var options = typeof args[0] === 'string' ? { user: args[0] } : copyOwnData(args[0]);
            return modelClient.chat({
              system: ownDataValue(options, 'system', undefined),
              user: ownDataValue(options, 'user', undefined),
              serviceId: ownDataValue(options, 'serviceId', undefined),
              useVision: !!ownDataValue(options, 'useVision', false),
              timeoutMs: ownDataValue(options, 'timeoutMs', undefined),
              temperature: ownDataValue(options, 'temperature', undefined),
              signal: execution && execution.signal,
            }).then(function (response) { return response.content; });
          });
        case 'http.fetch':
          var fetchOptions = copyOwnData(args[1]);
          defineOwn(fetchOptions, 'signal', execution && execution.signal);
          return httpFetch(args[0], fetchOptions);
        case 'http.webhook': {
          var webhookOptions = copyOwnData(args[2]);
          return httpFetch(args[0], {
            method: 'POST',
            body: args[1],
            headers: ownDataValue(webhookOptions, 'headers', undefined),
            timeoutMs: ownDataValue(webhookOptions, 'timeoutMs', undefined),
            signal: execution && execution.signal,
          });
        }
        case 'file.save':
          return execSaveFile(normalizeFileSaveArgs(args), execution);
        case 'ctx.get': {
          var runCtx = getRunCtx();
          return Promise.resolve(args[0] === undefined ? copyOwnData(runCtx) : resolveOwnPath(runCtx, args[0]));
        }
        case 'ctx.set':
          if (!safeContextKey(args[0])) return Promise.reject(new Error('上下文变量名不能使用原型保留字段'));
          defineOwn(getRunCtx(), args[0], args[1]);
          return Promise.resolve(true);
        case 'ctx.addAttribute':
          return Promise.resolve().then(function () {
            var runCtx = getRunCtx();
            var lastFlowData = ownDataValue(runCtx, 'last', undefined);
            if (!isOwnFlowData(lastFlowData)) throw new Error('ctx.addAttribute 需要 last 为 FlowData');
            runCtx.last = flowDataAddAttributes(lastFlowData, args[0] || {});
            return true;
          });
        case 'ctx.getAttribute':
          return Promise.resolve().then(function () {
            var lastFlowData = ownDataValue(getRunCtx(), 'last', undefined);
            if (!isOwnFlowData(lastFlowData)) return undefined;
            var key = args[0];
            return key ? flowDataGetAttribute(lastFlowData, key) : flowDataGetAttributes(lastFlowData);
          });
        case 'ctx.getAttributes':
          return Promise.resolve().then(function () {
            var lastFlowData = ownDataValue(getRunCtx(), 'last', undefined);
            return isOwnFlowData(lastFlowData) ? flowDataGetAttributes(lastFlowData) : {};
          });
        case 'log':
          logForExecution(execution, '[脚本] ' + String(args[0]), { level: args[1] || 'info' });
          return Promise.resolve(true);
        default:
          return Promise.reject(new Error('未知脚本 API: ' + api));
      }
    }

    return Object.freeze({
      resolveScriptCode: resolveScriptCode,
      execRunScript: execRunScript,
      executeApiCall: executeApiCall,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    createScriptOps: createScriptOps,
  });
});
