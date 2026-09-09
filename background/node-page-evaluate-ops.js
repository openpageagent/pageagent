// MAIN-world page evaluation, function calls, and runtime-module actions.
(function attachNodePageEvaluateOps(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var pageDataContract = commonJs ? require('../shared/page-data-contract.js') : root.PageDataContract;
  var api = factory(pageDataContract);
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.NodePageEvaluateOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pageDataContract) {
  'use strict';

  var API_VERSION = 2;
  if (!pageDataContract) throw new Error('NodePageEvaluateOps requires PageDataContract');
  var UNSAFE_PATH_SEGMENTS = Object.create(null);
  UNSAFE_PATH_SEGMENTS.__proto__ = true;
  UNSAFE_PATH_SEGMENTS.prototype = true;
  UNSAFE_PATH_SEGMENTS.constructor = true;
  Object.freeze(UNSAFE_PATH_SEGMENTS);

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function ownDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
    return descriptor && !descriptor.get && !descriptor.set && hasOwn(descriptor, 'value') ? descriptor : null;
  }
  function ownValue(value, key, fallback) {
    var descriptor = ownDescriptor(value, key);
    return descriptor ? descriptor.value : fallback;
  }
  function copyOwn(value) {
    var output = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    Object.keys(value).forEach(function (key) {
      var descriptor = ownDescriptor(value, key);
      if (!descriptor) return;
      Object.defineProperty(output, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
    });
    return output;
  }
  function sanitizeJsonData(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return undefined;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new Error('页面执行参数包含循环引用');
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        var array = [];
        for (var index = 0; index < value.length; index++) {
          var itemDescriptor = ownDescriptor(value, String(index));
          array.push(itemDescriptor ? sanitizeJsonData(itemDescriptor.value, seen) : null);
        }
        return array;
      }
      var output = {};
      Object.keys(value).forEach(function (key) {
        var descriptor = ownDescriptor(value, key);
        if (!descriptor) return;
        Object.defineProperty(output, key, {
          value: sanitizeJsonData(descriptor.value, seen), enumerable: true, configurable: true, writable: true,
        });
      });
      return output;
    } finally {
      seen.pop();
    }
  }
  function requireObject(value, name) {
    if (!value || typeof value !== 'object') throw new Error('NodePageEvaluateOps missing dependency: ' + name);
    return value;
  }
  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('NodePageEvaluateOps missing dependency: ' + name);
    return value;
  }
  function requireMethod(value, method, name) {
    requireObject(value, name);
    var descriptor = ownDescriptor(value, method);
    if (!descriptor || typeof descriptor.value !== 'function') {
      throw new Error('NodePageEvaluateOps missing dependency: ' + name + '.' + method);
    }
    return descriptor.value.bind(value);
  }
  function pathSegments(path) {
    return String(path || '').replace(/^window\./, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  }
  function assertSafePath(path, label) {
    var segments = pathSegments(path);
    for (var index = 0; index < segments.length; index++) {
      if (UNSAFE_PATH_SEGMENTS[segments[index]]) {
        throw new Error((label || '页面路径') + '包含保留字段: ' + segments[index]);
      }
    }
    return path;
  }
  function foregroundRequested(options) {
    return ownValue(options, 'focusWindow', false) === true
      || ownValue(options, 'foreground', false) === true
      || ownValue(options, 'requiresForeground', false) === true;
  }

  function createPageEvaluateOps(deps) {
    deps = deps || {};
    var requireRuntimeTabId = requireFunction(deps.requireRuntimeTabId, 'requireRuntimeTabId');
    var ensurePageReady = requireFunction(deps.ensurePageReady, 'ensurePageReady');
    var executePageCommand = requireFunction(deps.executePageCommand, 'executePageCommand');
    var logForExecution = requireFunction(deps.logForExecution, 'logForExecution');
    var parseJsonValue = requireFunction(deps.parseJsonValue, 'parseJsonValue');

    function execPageEvaluate(pageId, code, rawOptions, execution) {
      var options = copyOwn(rawOptions);
      if (!code || typeof code !== 'string') return Promise.reject(new Error('page.evaluate 需要一段 JS 代码字符串'));
      pageDataContract.normalizeWindow(options, 'page.evaluate');
      var timeoutMs = Math.max(100, Math.min(120000, Number(ownValue(options, 'timeoutMs', 0)) || 10000));
      var world = String(ownValue(options, 'world', 'MAIN') || 'MAIN').toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
      var startedAt = Date.now();
      return Promise.resolve().then(function () {
        if (pageId) return ensurePageReady(pageId, execution);
        return requireRuntimeTabId(options, 'page.evaluate');
      }).then(function (tabId) {
        var riskLabel = ownValue(options, 'riskLabel', '') || '';
        logForExecution(execution, '页面 JS 执行: tabId=' + tabId + (pageId ? ' pageLabel=' + pageId : '')
          + ' timeout=' + timeoutMs + 'ms' + (riskLabel ? ' risk=' + riskLabel : ''));
        return executePageCommand('evaluate', {
          tabId: tabId,
          code: code,
          sourceType: ownValue(options, 'sourceType', 'expression'),
          timeoutMs: timeoutMs,
          world: world,
          mode: ownValue(options, 'mode', 'write') || 'write',
          foreground: foregroundRequested(options),
          requiresForeground: ownValue(options, 'requiresForeground', false) === true,
          reveal: ownValue(options, 'reveal', false) === true,
        }, execution).then(function (commandResult) {
          var page = pageDataContract.paginateValue(ownValue(commandResult, 'result', null), options, 'page.evaluate', { dataKey: 'result' });
          if (ownValue(options, 'returnEnvelope', false) !== true) return page;
          var endedAt = Date.now();
          return Object.assign({}, page, {
            executionLog: { pageId: pageId, world: world, startedAt: startedAt, endedAt: endedAt, durationMs: endedAt - startedAt, timeoutMs: timeoutMs, risk: riskLabel },
            risk: { level: riskLabel || 'page-evaluate', note: '在页面 ' + world + ' world 执行 JS，可能读取或改变页面状态；执行结果已做安全序列化。' },
            actionReceipt: ownValue(commandResult, 'actionReceipt', null),
            receipt: ownValue(commandResult, 'receipt', null),
            status: ownValue(commandResult, 'status', ''),
            performed: ownValue(commandResult, 'performed', ''),
          });
        });
      });
    }

    function buildCallPageFunctionCode(path, thisPath, callArgs) {
      assertSafePath(path, '函数路径');
      if (thisPath) assertSafePath(thisPath, 'this 路径');
      return '(async function(){' +
        'var path=' + JSON.stringify(path || '') + ';var thisPath=' + JSON.stringify(thisPath || '') + ';var callArgs=' + JSON.stringify(sanitizeJsonData(Array.isArray(callArgs) ? callArgs : [])) + ';' +
        'var unsafe=Object.create(null);unsafe.__proto__=unsafe.prototype=unsafe.constructor=true;function parts(p){return String(p||"").replace(/\\[(\\d+)\\]/g,".$1").replace(/^window\\./,"").split(".").filter(Boolean);}function safe(p){var a=parts(p);for(var i=0;i<a.length;i++)if(unsafe[a[i]])throw new Error("路径包含保留字段: "+a[i]);return a;}' +
        'function resolve(p){var a=safe(p),cur=window;for(var i=0;i<a.length;i++)cur=cur==null?undefined:cur[a[i]];return cur;}function parentOf(p){var a=safe(p);a.pop();var cur=window;for(var i=0;i<a.length;i++)cur=cur==null?undefined:cur[a[i]];return cur||window;}' +
        'var fn=resolve(path);if(typeof fn!=="function")throw new Error("目标不是函数: "+path);var thisObj=thisPath?resolve(thisPath):parentOf(path);return await Promise.resolve(fn.apply(thisObj,callArgs));})()';
    }

    function normalizeRuntimeModuleActions(raw) {
      var actions = parseJsonValue(raw, undefined, '运行时模块动作');
      if (!Array.isArray(actions)) return actions;
      return actions.map(function (action) {
        return typeof action === 'string' ? parseJsonValue(action, action, '运行时模块动作项') : action;
      });
    }

    function buildRuntimeModuleActionCode(params) {
      params = copyOwn(params);
      var actionConfig = {
        chunkGlobalPattern: ownValue(params, 'chunkGlobalPattern', '') || '(?:webpack|rspack)Chunk',
        moduleId: ownValue(params, 'moduleId', '') || '',
        exportPath: ownValue(params, 'exportPath', '') || '',
        actions: sanitizeJsonData(normalizeRuntimeModuleActions(ownValue(params, 'actions', undefined))),
        returnPath: ownValue(params, 'returnPath', '') || '',
        timeoutMs: ownValue(params, 'timeoutMs', 0) || 30000,
      };
      [actionConfig.exportPath, actionConfig.returnPath].filter(Boolean).forEach(function (path) { assertSafePath(path, '运行时模块路径'); });
      return '(async function(){var cfg=' + JSON.stringify(actionConfig) + ';var unsafe=Object.create(null);unsafe.__proto__=unsafe.prototype=unsafe.constructor=true;' +
        'function pathParts(path){var parts=String(path||"").replace(/\\[(\\d+)\\]/g,".$1").split(".").filter(Boolean);for(var i=0;i<parts.length;i++)if(unsafe[parts[i]])throw new Error("路径包含保留字段: "+parts[i]);return parts;}' +
        'function getPath(obj,path){var cur=obj,parts=pathParts(path);for(var i=0;i<parts.length;i++){if(cur==null)return undefined;cur=cur[parts[i]];}return cur;}function setPath(obj,path,value){var parts=pathParts(path);if(!parts.length)return value;var cur=obj;for(var i=0;i<parts.length-1;i++){var p=parts[i];if(!cur[p]||typeof cur[p]!=="object")cur[p]={};cur=cur[p];}cur[parts[parts.length-1]]=value;return obj;}' +
        'function getRuntime(){var keys=Object.getOwnPropertyNames(window).filter(function(key){try{return new RegExp(cfg.chunkGlobalPattern,"i").test(key)&&Array.isArray(window[key]);}catch(_){return false;}});for(var i=0;i<keys.length;i++){var req=null;try{window[keys[i]].push([["pfa_runtime_action_"+Date.now()+"_"+Math.random().toString(16).slice(2)],{},function(r){req=r;}]);}catch(_){}if(req)return {key:keys[i],require:req};}throw new Error("未找到页面打包运行时: "+cfg.chunkGlobalPattern);}' +
        'function resolveArg(arg,ctx){if(arg&&typeof arg==="object"&&!Array.isArray(arg)&&arg.from!==undefined)return getPath(ctx,arg.from);return arg;}function toArray(value){if(Array.isArray(value))return value;if(value&&typeof value==="object")return Object.keys(value).map(function(k){return value[k];});return [];}' +
        'function compare(actual,op,expected){if(op==="exists")return actual!==undefined&&actual!==null;if(op==="notExists")return actual===undefined||actual===null;if(op==="contains")return String(actual||"").indexOf(String(expected||""))!==-1;if(op==="regex")return new RegExp(String(expected||"")).test(String(actual||""));if(op==="!=")return actual!=expected;if(op==="===")return actual===expected;if(op==="!==")return actual!==expected;return actual==expected;}' +
        'function runAction(ctx,action){action=action||{};var op=action.op||"get";var target=action.target?getPath(ctx,action.target):ctx.current;if(op==="get"){ctx.current=getPath(target,action.path||"");return;}if(op==="global"){ctx.current=getPath(window,action.path||"");return;}if(op==="regex"){var re=new RegExp(String(action.pattern||action.value||""),String(action.flags||""));var m=re.exec(String(target==null?"":target));ctx.current=m?(m[Number(action.group||1)]!==undefined?m[Number(action.group||1)]:m[0]):(action.defaultValue!==undefined?action.defaultValue:"");return;}if(op==="replace"){var re2=new RegExp(String(action.pattern||action.value||""),String(action.flags||"g"));ctx.current=String(target==null?"":target).replace(re2,String(action.replacement===undefined?"":action.replacement));return;}if(op==="call"){var fn=action.path?getPath(target,action.path):target;if(typeof fn!=="function")throw new Error("动作目标不是函数: "+(action.path||action.target||"current"));var thisObj=action.thisPath?getPath(ctx,action.thisPath):(action.path?target:null);var args=(action.args||[]).map(function(arg){return resolveArg(arg,ctx);});ctx.current=fn.apply(thisObj,args);return;}if(op==="values"){ctx.current=toArray(target);return;}if(op==="filter"){ctx.current=toArray(target).filter(function(item){return compare(getPath(item,action.path||""),action.operator||"==",resolveArg(action.value,ctx));});return;}if(op==="sort"){var items=toArray(target).slice(),desc=action.direction==="desc";items.sort(function(a,b){var av=getPath(a,action.path||""),bv=getPath(b,action.path||"");return(av>bv?1:av<bv?-1:0)*(desc?-1:1);});ctx.current=items;return;}if(op==="at"){var arr=toArray(target),index=Number(action.index||0);if(index<0)index=arr.length+index;ctx.current=arr[index];return;}if(op==="map"){var fields=action.fields||{};ctx.current=toArray(target).map(function(item){var out=Object.create(null);Object.keys(fields).forEach(function(k){Object.defineProperty(out,k,{value:getPath(item,fields[k]),enumerable:true,configurable:true,writable:true});});return out;});return;}if(op==="join"){ctx.current=toArray(target).map(function(item){var value=action.path?getPath(item,action.path):item;return value==null?"":String(value);}).join(action.separator===undefined?"":String(action.separator));return;}if(op==="set"){setPath(ctx,action.path||"current",target);return;}throw new Error("未知运行时模块动作: "+op);}' +
        'var runtime=getRuntime();if(!cfg.moduleId)throw new Error("缺少 moduleId");if(!Array.isArray(cfg.actions)||!cfg.actions.length)throw new Error("运行时模块动作不能为空");var exported=runtime.require(String(cfg.moduleId));var current=cfg.exportPath?getPath(exported,cfg.exportPath):exported;var ctx={runtimeKey:runtime.key,moduleId:String(cfg.moduleId),exported:exported,current:current};for(var i=0;i<cfg.actions.length;i++){var r=runAction(ctx,cfg.actions[i]);if(r&&typeof r.then==="function")await r;if(ctx.current&&typeof ctx.current.then==="function")ctx.current=await ctx.current;}return cfg.returnPath?getPath(ctx,cfg.returnPath):ctx.current;})()';
    }

    function execCallPageFunction(node, rawParams, execution) {
      var params = copyOwn(rawParams);
      var callArgs = ownValue(params, 'args', []);
      if (typeof callArgs === 'string') {
        try { callArgs = JSON.parse(callArgs || '[]'); } catch (_) { callArgs = []; }
      }
      if (!Array.isArray(callArgs)) callArgs = [];
      return execPageEvaluate(ownValue(node, 'pageId', ''), buildCallPageFunctionCode(ownValue(params, 'path', ''), ownValue(params, 'thisPath', ''), callArgs), {
        timeoutMs: ownValue(params, 'timeoutMs', 0) || 30000,
        start: ownValue(params, 'start', undefined),
        maxChars: ownValue(params, 'maxChars', undefined),
        returnEnvelope: true,
        riskLabel: 'callPageFunction',
        sourceType: 'expression',
        foreground: foregroundRequested(params),
        reveal: ownValue(params, 'reveal', false) === true,
      }, execution);
    }

    function execRuntimeModuleAction(node, rawParams, execution) {
      var params = copyOwn(rawParams);
      return execPageEvaluate(ownValue(node, 'pageId', ''), buildRuntimeModuleActionCode(params), {
        timeoutMs: ownValue(params, 'timeoutMs', 0) || 30000,
        start: ownValue(params, 'start', undefined),
        maxChars: ownValue(params, 'maxChars', undefined),
        returnEnvelope: true,
        riskLabel: 'runtimeModuleAction',
        sourceType: 'expression',
        foreground: foregroundRequested(params),
        reveal: ownValue(params, 'reveal', false) === true,
      }, execution);
    }

    return Object.freeze({
      execPageEvaluate: execPageEvaluate,
      buildCallPageFunctionCode: buildCallPageFunctionCode,
      buildRuntimeModuleActionCode: buildRuntimeModuleActionCode,
      execCallPageFunction: execCallPageFunction,
      execRuntimeModuleAction: execRuntimeModuleAction,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, createPageEvaluateOps: createPageEvaluateOps });
});
