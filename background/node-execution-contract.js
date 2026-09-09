// Node execution input/output contract shared by the background executor.
(function attachNodeExecutionContract(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NodeExecutionContract = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTENT_SIZE_BUDGET = 512 * 1024;
  var RESERVED_SCRIPT_CONTEXT_KEYS = {
    last: true,
    index: true,
    data: true,
    dataIndex: true,
    _lastContent: true,
  };
  var LATE_TEMPLATE_PARAM_KEYS = {
    ifStart: ['condition'],
    loopBreak: ['condition'],
    loopContinue: ['condition'],
    statusBreak: ['condition'],
    dataMap: ['mappings'],
    dataCompose: ['fields', 'setPaths'],
    dataFilter: ['expression', 'condition', 'expected'],
    dataDedupe: ['keyExpression'],
    forEachParallel: ['url', 'headers', 'bodyTemplate', 'resultTemplate'],
  };
  var CONTENT_TYPES = {
    openPage: 'page-navigation',
    refreshPage: 'page-navigation',
    navigate: 'page-navigation',
    extractTable: 'table',
    extractList: 'list',
    extractScrollingList: 'list',
    screenshot: 'screenshot',
    httpRequest: 'http-response',
    webhook: 'http-response',
    httpLoadTest: 'performance-load-test',
    saveFile: 'file-download',
    waitDownload: 'file-download',
    downloadMedia: 'media-download',
    extractText: 'text',
    pageAction: 'page-action',
    clickElement: 'page-action',
    fillInput: 'page-action',
    selectOption: 'page-action',
    fillFormFields: 'form-fill',
    scrollPage: 'page-action',
    hoverElement: 'page-action',
    keyPress: 'page-action',
    uploadFile: 'page-action',
    dragDrop: 'page-action',
    handleDialog: 'page-action',
    closePage: 'page-action',
    activateTab: 'page-action',
    waitForElement: 'page-wait',
    waitForCondition: 'page-wait',
    waitForPageLoad: 'page-readiness',
    getCurrentTab: 'browser-tab',
    scrollInfo: 'scroll-state',
    executePageJavascript: 'javascript-result',
    runScript: 'script-result',
    requestModelAssert: 'assertion',
    requestModelExtract: 'json',
    requestModelAction: 'model-output',
    runAssistant: 'assistant-result',
    elementInfo: 'element-info',
    inspectStructure: 'page-structure',
    inspectText: 'text',
    inspectHtml: 'html',
    inspectCss: 'css',
    inspectJavascript: 'javascript-state',
    searchPage: 'search-results',
    getRequests: 'network-log',
    replayRequest: 'http-response',
    patchPage: 'page-patch',
    callPageFunction: 'javascript-call',
    runtimeModuleAction: 'javascript-call',
    'cdp.inspect_dom_snapshot': 'cdp-dom-snapshot',
    'cdp.inspect_ax_tree': 'cdp-ax-tree',
    'cdp.inspect_network': 'network-log',
    'cdp.analyze_performance': 'performance-analysis',
    'cdp.replay_request': 'http-response',
    'cdp.screenshot': 'screenshot',
    getSseEvents: 'network-log',
    clearNetworkCapture: 'network-log',
    assertElement: 'assertion',
    assertText: 'assertion',
    assertValue: 'assertion',
    assertUrl: 'assertion',
    assertAttribute: 'assertion',
    assertScreenshot: 'assertion',
    webStorage: 'page-storage',
    setCookie: 'cookie',
    getCookie: 'cookie',
    clearCookies: 'cookie',
    setProxy: 'browser-proxy',
    clearProxy: 'browser-proxy',
    turndownToMarkdown: 'markdown',
    dataMap: 'data-transform',
    dataCompose: 'data-transform',
    dataProject: 'data-transform',
    contextPrune: 'variable',
    dataFilter: 'data-transform',
    dataJoin: 'data-transform',
    dataDedupe: 'data-transform',
    dataAggregate: 'data-aggregate',
    checkpointGet: 'checkpoint',
    checkpointSet: 'checkpoint',
    dataDiff: 'data-diff',
    forEachParallel: 'parallel-results',
    exportTestReport: 'flow-report',
    attachArtifact: 'artifact',
    assertPerformance: 'assertion',
    exitGate: 'ci-gate',
    exportRunSummary: 'run-summary',
    accessibilityCheck: 'accessibility-report',
    coverageMark: 'coverage',
    mockNetwork: 'network-mock',
    routeAssert: 'assertion',
    randomData: 'test-data',
    jsonExtract: 'data-transform',
    setVariable: 'variable',
    addAttribute: 'variable',
    logData: 'passthrough',
    delay: 'control',
    statusBreak: 'control',
    loopStart: 'control',
    loopEnd: 'control',
    loopBreak: 'control',
    loopContinue: 'control',
    ifStart: 'control',
    elseBlock: 'control',
    ifEnd: 'control',
  };

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function ownDataDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    try {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && hasOwn(descriptor, 'value') ? descriptor : null;
    } catch (_) {
      return null;
    }
  }

  function ownDataValue(value, key, fallback) {
    var descriptor = ownDataDescriptor(value, key);
    return descriptor ? descriptor.value : fallback;
  }

  function isSafeExtraParamKey(key) {
    return typeof key === 'string'
      && key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
  }

  function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      var prototype = Object.getPrototypeOf(value);
      return prototype === null || Object.getPrototypeOf(prototype) === null;
    } catch (_) {
      return false;
    }
  }

  function isSerializableParamValue(value, seen) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      return false;
    }
    if (value === null || typeof value !== 'object') return true;
    if (!Array.isArray(value) && !isPlainRecord(value)) return false;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return false;
    seen.push(value);
    try {
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!isSafeExtraParamKey(key)) return false;
        var descriptor = ownDataDescriptor(value, key);
        if (!descriptor || !isSerializableParamValue(descriptor.value, seen)) return false;
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      seen.pop();
    }
  }

  function contractError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function defaultSplitList(raw) {
    if (Array.isArray(raw)) {
      return raw.map(function (value) { return String(value).trim(); }).filter(Boolean);
    }
    return String(raw || '').split(/[,\n]/).map(function (value) { return value.trim(); }).filter(Boolean);
  }

  function defaultDeleteObjectPath(obj, path) {
    var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
    var parts = normalized.split('.').filter(Boolean);
    if (!parts.length) return false;
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      current = current && current[parts[i]];
      if (!current || typeof current !== 'object') return false;
    }
    var key = parts[parts.length - 1];
    if (!current || typeof current !== 'object' || !(key in current)) return false;
    delete current[key];
    return true;
  }

  function createNodeExecutionContract(deps) {
    deps = deps || {};
    var Template = deps.Template || deps.template;
    var NodeTypes = deps.NodeTypes || deps.nodeTypes;
    var FlowData = deps.FlowData || deps.flowData || null;
    var getRunCtx = deps.getRunCtx || function () { return {}; };
    var addLog = deps.addLog || function () {};
    var splitList = deps.splitList || defaultSplitList;
    var deleteObjectPath = deps.deleteObjectPath || defaultDeleteObjectPath;
    var now = deps.now || function () { return Date.now(); };

    function assertNode(node) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw contractError('NODE_EXECUTION_INVALID_NODE', '节点执行参数 node 必须是对象');
      }
      var typeDescriptor = ownDataDescriptor(node, 'type');
      if (!typeDescriptor || typeof typeDescriptor.value !== 'string' || !typeDescriptor.value.trim()) {
        throw contractError('NODE_EXECUTION_INVALID_TYPE', '节点执行参数缺少有效的 type');
      }
      var paramsDescriptor;
      try { paramsDescriptor = Object.getOwnPropertyDescriptor(node, 'params'); } catch (_) {}
      if (paramsDescriptor && (!hasOwn(paramsDescriptor, 'value')
        || (paramsDescriptor.value !== undefined && paramsDescriptor.value !== null
          && (typeof paramsDescriptor.value !== 'object' || Array.isArray(paramsDescriptor.value)
            || !isPlainRecord(paramsDescriptor.value))))) {
        throw contractError('NODE_EXECUTION_INVALID_PARAMS', '节点执行参数 params 必须是普通对象');
      }
      return node;
    }

    function copyOwnDataParams(node) {
      var params = ownDataValue(node, 'params', null);
      if (params === null || params === undefined) return {};
      var output = {};
      var keys;
      try { keys = Object.keys(params); } catch (_) {
        throw contractError('NODE_EXECUTION_INVALID_PARAMS', '节点执行参数 params 无法读取');
      }
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!isSafeExtraParamKey(key)) continue;
        var descriptor = ownDataDescriptor(params, key);
        if (!descriptor) {
          throw contractError('NODE_EXECUTION_INVALID_PARAMS', '节点执行参数不允许访问器字段: ' + key);
        }
        output[key] = descriptor.value;
      }
      return output;
    }

    function requireParamApis() {
      if (!Template || typeof Template.interpolateParams !== 'function' || typeof Template.interpolate !== 'function'
          || typeof Template.interpolateData !== 'function') {
        throw contractError('NODE_EXECUTION_TEMPLATE_UNAVAILABLE', 'Template 参数插值模块未加载');
      }
      if (!NodeTypes || typeof NodeTypes.normalizeParams !== 'function') {
        throw contractError('NODE_EXECUTION_NODE_TYPES_UNAVAILABLE', 'NodeTypes 参数规范化模块未加载');
      }
    }

    function normalizePreservingExtraParams(nodeType, params) {
      var normalized = NodeTypes.normalizeParams(nodeType, params) || {};
      var definition = typeof NodeTypes.getType === 'function' ? NodeTypes.getType(nodeType) : null;
      var output = {};
      if (definition || typeof NodeTypes.getType !== 'function') {
        Object.keys(normalized).forEach(function (key) {
          if (isSafeExtraParamKey(key) && isSerializableParamValue(normalized[key])) output[key] = normalized[key];
        });
      }
      Object.keys(params || {}).forEach(function (key) {
        if (!hasOwn(output, key) && isSafeExtraParamKey(key) && isSerializableParamValue(params[key])) {
          output[key] = params[key];
        }
      });
      return output;
    }

    function interpolateDeepParam(value, ctx) {
      if (typeof value === 'string') return Template.interpolate(value, ctx);
      if (Array.isArray(value)) {
        var arrayOutput = new Array(value.length);
        for (var i = 0; i < value.length; i++) {
          var itemDescriptor = ownDataDescriptor(value, String(i));
          if (itemDescriptor) arrayOutput[i] = interpolateDeepParam(itemDescriptor.value, ctx);
        }
        return arrayOutput;
      }
      if (value && typeof value === 'object') {
        var output = {};
        Object.keys(value).forEach(function (key) {
          if (!isSafeExtraParamKey(key)) return;
          var descriptor = ownDataDescriptor(value, key);
          if (descriptor) output[key] = interpolateDeepParam(descriptor.value, ctx);
        });
        return output;
      }
      return value;
    }

    function resolveNodeParams(node, ctx) {
      assertNode(node);
      requireParamApis();
      var explicitParams = Template.interpolateParams(copyOwnDataParams(node), ctx);
      var params = normalizePreservingExtraParams(node.type, explicitParams);
      params = Template.interpolateParams(params, ctx);
      params = normalizePreservingExtraParams(node.type, params);

      if (node.type === 'elementInfo') {
        ['reveal', 'highlightMs'].forEach(function (key) {
          if (explicitParams[key] !== undefined) params[key] = explicitParams[key];
        });
      }
      if (node.type === 'fillFormFields') {
        params.fields = interpolateDeepParam(params.fields, ctx);
        params.values = interpolateDeepParam(params.values, ctx);
      }
      if (node.type === 'pageAction') {
        params.locator = interpolateDeepParam(params.locator, ctx);
        params.input = interpolateDeepParam(params.input, ctx);
        params.expect = interpolateDeepParam(params.expect, ctx);
      }
      if (node.type === 'runtimeModuleAction') {
        params.actions = interpolateDeepParam(params.actions, ctx);
      }
      if (node.type === 'dataProject') {
        params.fields = interpolateDeepParam(params.fields, ctx);
        params.setPaths = interpolateDeepParam(params.setPaths, ctx);
      }
      var modelInputKeys = {
        requestModelAssert: ['assertion'],
        requestModelExtract: ['instruction'],
        requestModelAction: ['prompt'],
        runAssistant: ['prompt'],
      }[node.type] || [];
      var rawParams = copyOwnDataParams(node);
      if (node.type === 'requestModelAction' && /\{\{[^{}]+\}\}/.test(String(rawParams.systemPrompt || ''))) {
        throw contractError(
          'NODE_EXECUTION_DYNAMIC_SYSTEM_PROMPT_FORBIDDEN',
          'requestModelAction systemPrompt 不能注入运行变量；请把动态数据放入用户提示词'
        );
      }
      modelInputKeys.forEach(function (key) {
        if (typeof rawParams[key] === 'string') params[key] = Template.interpolateData(rawParams[key], ctx);
      });
      return params;
    }

    function restoreLateTemplateParams(node, params) {
      var keys = LATE_TEMPLATE_PARAM_KEYS[node.type];
      if (!keys || !keys.length) return params;
      var raw = copyOwnDataParams(node);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') params[key] = raw[key];
      }
      return params;
    }

    function inferContentType(nodeType) {
      return CONTENT_TYPES[nodeType] || 'unknown';
    }

    function inferMimeType(nodeType, content) {
      if (nodeType === 'screenshot') return 'image/jpeg';
      if (nodeType === 'cdp.screenshot') {
        var screenshotFormat = String(ownDataValue(content, 'format', 'png') || 'png').toLowerCase();
        return 'image/' + (screenshotFormat === 'jpg' ? 'jpeg' : screenshotFormat);
      }
      if (nodeType === 'turndownToMarkdown') return 'text/markdown';
      var mime = ownDataValue(content, 'mime', '');
      var contentType = ownDataValue(content, 'contentType', '');
      if (nodeType === 'saveFile' && mime) return mime;
      if (nodeType === 'httpRequest' && contentType) return contentType;
      if (typeof content === 'object') return 'application/json';
      return 'text/plain';
    }

    function collectionInfo(value) {
      if (!value || typeof value !== 'object') return null;
      if (typeof Map === 'function') {
        try {
          return {
            kind: 'Map',
            size: Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value),
            forEach: Map.prototype.forEach,
          };
        } catch (_) {}
      }
      if (typeof Set === 'function') {
        try {
          return {
            kind: 'Set',
            size: Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value),
            forEach: Set.prototype.forEach,
          };
        } catch (_) {}
      }
      return null;
    }

    function estimateCollectionSize(value, info, budget, seen) {
      var total = Math.min(16, budget);
      var visited = 0;
      var stop = {};
      try {
        info.forEach.call(value, function (item, key) {
          if (visited >= 1024 || total >= budget) throw stop;
          visited++;
          total += Math.min(2, Math.max(0, budget - total));
          if (info.kind === 'Map' && total < budget) {
            total += estimateContentSize(key, budget - total, seen);
          }
          if (total < budget) total += estimateContentSize(item, budget - total, seen);
        });
      } catch (error) {
        if (error !== stop) total += Math.min(16, Math.max(0, budget - total));
      }
      if (info.size > visited && total < budget) total += Math.min(16, budget - total);
      return Math.min(total, budget);
    }

    function estimateContentSize(value, budget, seen) {
      if (budget <= 0 || value === null || value === undefined) return 0;
      var type = typeof value;
      if (type === 'string') return Math.min(value.length, budget);
      if (type === 'number' || type === 'boolean') return Math.min(16, budget);
      if (type === 'bigint') return Math.min(String(value).length + 1, budget);
      if (type === 'function') return Math.min(32, budget);
      if (type !== 'object') return Math.min(String(value).length, budget);
      seen = seen || [];
      if (seen.indexOf(value) !== -1) return Math.min(16, budget);
      seen.push(value);
      var total = 0;
      try {
        var info = collectionInfo(value);
        if (info) return estimateCollectionSize(value, info, budget, seen);
        if (Array.isArray(value)) {
          for (var i = 0; i < value.length && total < budget; i++) {
            total += 1;
            var itemDescriptor = ownDataDescriptor(value, String(i));
            total += itemDescriptor
              ? estimateContentSize(itemDescriptor.value, budget - total, seen)
              : Math.min(16, Math.max(0, budget - total));
          }
          return Math.min(total, budget);
        }
        var keys;
        try { keys = Object.keys(value); } catch (_) { return Math.min(16, budget); }
        for (var j = 0; j < keys.length && total < budget; j++) {
          var key = keys[j];
          total += Math.min(key.length + 2, Math.max(0, budget - total));
          if (total >= budget) break;
          var descriptor = ownDataDescriptor(value, key);
          total += descriptor
            ? estimateContentSize(descriptor.value, budget - total, seen)
            : Math.min(16, Math.max(0, budget - total));
        }
        if (!keys.length) {
          ['name', 'message', 'stack'].forEach(function (key) {
            if (total >= budget) return;
            var descriptor = ownDataDescriptor(value, key);
            if (descriptor) total += estimateContentSize(descriptor.value, budget - total, seen);
          });
        }
        return Math.min(total, budget);
      } finally {
        seen.pop();
      }
    }

    function calculateContentSize(content) {
      return estimateContentSize(content, CONTENT_SIZE_BUDGET, []);
    }

    function buildAttributes(content, node, context, executionTime) {
      context = context || {};
      var runCtx = getRunCtx() || {};
      var nodeType = ownDataValue(node, 'type', '');
      var nodeParams = ownDataValue(node, 'params', {}) || {};
      var attributes = {
        'flow.id': context.flowId || '',
        'flow.label': context.flowLabel || '',
        'node.id': ownDataValue(node, 'nodeId', '') || '',
        'node.type': nodeType || '',
        'node.title': ownDataValue(node, 'title', '') || '',
        'node.executedAt': now(),
        'node.executionTime': executionTime,
        'content.type': inferContentType(nodeType),
        'content.mimeType': inferMimeType(nodeType, content),
        'content.size': calculateContentSize(content),
        'source.pageId': ownDataValue(node, 'pageId', '') || '',
      };

      if (nodeType === 'extractTable' || nodeType === 'extractList' || nodeType === 'extractScrollingList') {
        attributes['source.selector'] = ownDataValue(nodeParams, 'selector', '')
          || ownDataValue(nodeParams, 'itemSelector', '') || '';
      }
      if (nodeType === 'httpRequest') {
        attributes['http.method'] = ownDataValue(nodeParams, 'method', '') || 'GET';
        attributes['http.url'] = ownDataValue(nodeParams, 'url', '') || '';
        if (content && typeof content === 'object') attributes['http.statusCode'] = ownDataValue(content, 'status', 0) || 0;
      }
      if (nodeType === 'screenshot') {
        attributes['screenshot.quality'] = ownDataValue(nodeParams, 'quality', 0) || 70;
      }
      if (nodeType === 'saveFile') {
        attributes['file.name'] = ownDataValue(nodeParams, 'fileName', '') || '';
        attributes['file.directory'] = ownDataValue(nodeParams, 'directory', '') || '';
      }
      if (nodeType === 'downloadMedia') {
        attributes['file.directory'] = ownDataValue(nodeParams, 'directory', '') || '';
        attributes['media.baseUrl'] = ownDataValue(nodeParams, 'baseUrl', '') || '';
        attributes['media.downloadedCount'] = ownDataValue(content, 'downloadedCount', 0) || 0;
        attributes['media.failedCount'] = ownDataValue(content, 'failedCount', 0) || 0;
        attributes['media.residentHitCount'] = ownDataValue(content, 'residentHitCount', 0) || 0;
        attributes['media.residentMissCount'] = ownDataValue(content, 'residentMissCount', 0) || 0;
        attributes['media.networkDownloadCount'] = ownDataValue(content, 'networkDownloadCount', 0) || 0;
        attributes['media.networkFetchCount'] = ownDataValue(content, 'networkFetchCount', 0) || 0;
        attributes['media.generatedCount'] = ownDataValue(content, 'generatedCount', 0) || 0;
      }
      if (nodeType === 'statusBreak' && content && typeof content === 'object') {
        attributes['statusBreak.done'] = ownDataValue(content, 'done', false) === true;
        attributes['statusBreak.status'] = ownDataValue(content, 'status', false) === true;
        attributes['statusBreak.mask'] = ownDataValue(content, 'mask', undefined);
        attributes['statusBreak.maskBinary'] = ownDataValue(content, 'maskBinary', '') || '';
        attributes['statusBreak.bitIndex'] = ownDataValue(content, 'bitIndex', undefined);
        attributes['statusBreak.index'] = ownDataValue(content, 'index', undefined);
        attributes['statusBreak.count'] = ownDataValue(content, 'count', undefined);
        attributes['statusBreak.stateKey'] = ownDataValue(content, 'stateKey', '') || '';
      }

      var customAttributes = ownDataValue(node, 'customAttributes', null);
      if (customAttributes && typeof customAttributes === 'object') {
        Object.keys(customAttributes).forEach(function (key) {
          if (!isSafeExtraParamKey(key)) return;
          var descriptor = ownDataDescriptor(customAttributes, key);
          if (!descriptor) return;
          var rawValue = descriptor.value;
          attributes[key] = typeof rawValue === 'string' && Template
            ? Template.interpolate(rawValue, runCtx)
            : rawValue;
        });
      }

      var inheritAttributes = ownDataValue(node, 'inheritAttributes', null);
      if (FlowData && Array.isArray(inheritAttributes)) {
        var previous = runCtx.last;
        if (isFlowDataValue(previous)) {
          for (var i = 0; i < inheritAttributes.length; i++) {
            var descriptor = ownDataDescriptor(inheritAttributes, String(i));
            if (!descriptor) continue;
            var key = descriptor.value;
            if (!isSafeExtraParamKey(key)) continue;
            var value = getFlowDataAttribute(previous, key);
            if (value !== undefined) attributes[key] = value;
          }
        }
      }
      return attributes;
    }

    function wrapAsFlowData(content, node, context) {
      if (!FlowData) return content;
      if (isFlowDataValue(content)) return content;
      context = context || {};
      var currentTime = now();
      var executionTime = context.startTime ? currentTime - context.startTime : 0;
      return FlowData.createFlowData(content, buildAttributes(content, node, context, executionTime));
    }

    function isFlowDataValue(value) {
      if (!FlowData || !value || typeof value !== 'object') return false;
      var marker = ownDataDescriptor(value, '__isFlowData');
      if (marker && marker.value === true) return true;
      var attributes = ownDataDescriptor(value, 'attributes');
      var content = ownDataDescriptor(value, 'content');
      return !!(attributes && content && attributes.value && typeof attributes.value === 'object');
    }

    function getFlowDataContent(value) {
      var descriptor = ownDataDescriptor(value, 'content');
      return descriptor ? descriptor.value : value;
    }

    function getFlowDataAttribute(value, key) {
      var attributes = ownDataValue(value, 'attributes', null);
      var descriptor = ownDataDescriptor(attributes, key);
      return descriptor ? descriptor.value : undefined;
    }

    function isPlainObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      try {
        var prototype = Object.getPrototypeOf(value);
        return prototype === null || Object.getPrototypeOf(prototype) === null;
      } catch (_) {
        return false;
      }
    }

    function previewSnapshot(value, depth, seen) {
      depth = depth || 0;
      seen = seen || [];
      if (value === undefined) return '[undefined]';
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return String(value) + 'n';
      if (typeof value === 'function') return '[Function]';
      if (typeof value === 'symbol') return String(value);
      if (typeof value !== 'object') return String(value);
      if (seen.indexOf(value) !== -1) return '[Circular]';
      if (depth >= 3) return '[MaxDepth]';
      seen.push(value);
      try {
        var info = collectionInfo(value);
        if (info) {
          var collection = { __type: info.kind, size: info.size, values: [] };
          var stop = {};
          try {
            info.forEach.call(value, function (item, key) {
              if (collection.values.length >= 12) throw stop;
              collection.values.push(info.kind === 'Map'
                ? [previewSnapshot(key, depth + 1, seen), previewSnapshot(item, depth + 1, seen)]
                : previewSnapshot(item, depth + 1, seen));
            });
          } catch (error) {
            if (error !== stop) collection.error = 'unreadable';
          }
          return collection;
        }
        if (Array.isArray(value)) {
          var arrayOutput = [];
          var arrayLimit = Math.min(value.length, 20);
          for (var i = 0; i < arrayLimit; i++) {
            var itemDescriptor = ownDataDescriptor(value, String(i));
            arrayOutput.push(itemDescriptor ? previewSnapshot(itemDescriptor.value, depth + 1, seen) : '[Accessor]');
          }
          if (value.length > arrayLimit) arrayOutput.push('[+' + (value.length - arrayLimit) + ' items]');
          return arrayOutput;
        }
        var output = {};
        var keys;
        try { keys = Object.keys(value); } catch (_) { return '[Uninspectable]'; }
        var keyLimit = Math.min(keys.length, 20);
        for (var j = 0; j < keyLimit; j++) {
          var key = keys[j];
          if (!isSafeExtraParamKey(key)) continue;
          var descriptor = ownDataDescriptor(value, key);
          output[key] = descriptor ? previewSnapshot(descriptor.value, depth + 1, seen) : '[Accessor]';
        }
        if (keys.length > keyLimit) output.__omittedKeys = keys.length - keyLimit;
        if (!keys.length) {
          var message = ownDataDescriptor(value, 'message');
          var stack = ownDataDescriptor(value, 'stack');
          if (message || stack) {
            output.__type = 'Error';
            if (message) output.message = previewSnapshot(message.value, depth + 1, seen);
            if (stack) output.stack = String(stack.value || '').slice(0, 300);
          }
        }
        return output;
      } finally {
        seen.pop();
      }
    }

    function previewValue(value) {
      var text;
      try { text = JSON.stringify(previewSnapshot(value)); } catch (_) { text = '[Unserializable]'; }
      return text.length > 300
        ? text.slice(0, 300) + '…(共' + text.length + '字符，可用「输出日志」节点查看完整数据)'
        : text;
    }

    function suppressesLastWrite(node, params) {
      if (node.type !== 'contextPrune') return false;
      var paths = splitList(params.paths || params.path);
      return params.clearLast === true || paths.indexOf('last') !== -1 || paths.indexOf('_lastContent') !== -1;
    }

    function applyResult(result, node, options) {
      options = options || {};
      var resultLog = options.addLog || addLog;
      var runCtx = getRunCtx();
      if (!runCtx || typeof runCtx !== 'object') {
        throw contractError('NODE_EXECUTION_CONTEXT_UNAVAILABLE', '节点运行上下文不可用');
      }
      var params = options.params || {};
      var scriptMutatedLast = node.type === 'runScript'
        && (result === undefined || result === null)
        && runCtx.last !== options.previousLast;
      var flowData = scriptMutatedLast
        ? runCtx.last
        : wrapAsFlowData(result, node, {
            flowId: options.flowId,
            flowLabel: options.flowLabel,
            startTime: options.startTime,
          });
      var rawContent = isFlowDataValue(flowData) ? getFlowDataContent(flowData) : result;
      var suppressLast = suppressesLastWrite(node, params);
      var outputVar = ownDataValue(node, 'outputVar', '');
      if (outputVar && (typeof outputVar !== 'string' || outputVar !== outputVar.trim()
          || !isSafeExtraParamKey(outputVar))) {
        throw contractError('NODE_EXECUTION_INVALID_OUTPUT_VAR', '节点 outputVar 必须是不带首尾空白的非原型保留字符串');
      }

      if (suppressLast) deleteObjectPath(runCtx, 'last');
      else runCtx.last = flowData;

      if (suppressLast) deleteObjectPath(runCtx, '_lastContent');
      else runCtx._lastContent = rawContent;

      if (outputVar) {
        runCtx[outputVar] = flowData;
        resultLog('节点输出已写入 ctx.' + outputVar + ' = ' + previewValue(rawContent), {
          nodeId: ownDataValue(node, 'nodeId', ''),
        });
      } else if (node.type === 'runScript' && isPlainObject(result)) {
        var spreadKeys = [];
        Object.keys(result).forEach(function (key) {
          if (RESERVED_SCRIPT_CONTEXT_KEYS[key] || !isSafeExtraParamKey(key)) {
            resultLog('脚本输出键「' + key + '」为保留变量名，已跳过展开', {
              nodeId: ownDataValue(node, 'nodeId', ''),
              level: 'warn',
            });
            return;
          }
          var descriptor = ownDataDescriptor(result, key);
          if (!descriptor) {
            resultLog('脚本输出键「' + key + '」为访问器字段，已跳过展开', {
              nodeId: ownDataValue(node, 'nodeId', ''),
              level: 'warn',
            });
            return;
          }
          runCtx[key] = descriptor.value;
          spreadKeys.push(key);
        });
        if (spreadKeys.length) {
          resultLog('脚本 return 对象已展开写入变量: ' + spreadKeys.map(function (key) {
            return '{{' + key + '}}';
          }).join(', '), { nodeId: ownDataValue(node, 'nodeId', '') });
        }
      }

      return {
        flowData: flowData,
        rawContent: rawContent,
        suppressLastWrite: suppressLast,
      };
    }

    return {
      assertNode: assertNode,
      resolveNodeParams: resolveNodeParams,
      restoreLateTemplateParams: restoreLateTemplateParams,
      wrapAsFlowData: wrapAsFlowData,
      buildAttributes: buildAttributes,
      inferContentType: inferContentType,
      inferMimeType: inferMimeType,
      estimateContentSize: estimateContentSize,
      calculateContentSize: calculateContentSize,
      applyResult: applyResult,
    };
  }

  return {
    createNodeExecutionContract: createNodeExecutionContract,
  };
});
