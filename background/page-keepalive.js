// Scheduled page heartbeat/activity/reload, routed through the unified page engines.
(function attachPageKeepAlive(root, factory) {
  'use strict';
  root.PageKeepAlive = factory();
})(globalThis, function () {
  'use strict';

  function createPageKeepAlive(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var tabRuntime = deps.tabRuntime;
    var sourceRegistry = deps.sourceRegistry;
    var pageAutomation = deps.pageAutomation;
    var isTabClaimedByRunningSession = deps.isTabClaimedByRunningSession || (function () { return false; });
    var runningSessionForTab = deps.runningSessionForTab || (function () { return null; });
    var stateByPageId = {};
    if (!pageAutomation || !pageAutomation.perception || !pageAutomation.action) throw new Error('PageKeepAlive requires PageAutomationRuntime');

    function parseHeaderObject(raw) {
      var headers = {};
      if (!raw) return headers;
      if (typeof raw === 'object') return raw;
      var text = String(raw || '').trim();
      if (!text) return headers;
      if (text.charAt(0) === '{') {
        try { var parsed = JSON.parse(text); return parsed && typeof parsed === 'object' ? parsed : {}; }
        catch (_) {}
      }
      text.split('\n').forEach(function (line) {
        var at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      });
      return headers;
    }

    function statusMatches(status, expected) {
      if (!expected) return status >= 200 && status < 400;
      var parts = String(expected || '').trim().split(',').map(function (value) { return value.trim(); }).filter(Boolean);
      for (var index = 0; index < parts.length; index += 1) {
        if (/^\d+\-\d+$/.test(parts[index])) {
          var range = parts[index].split('-').map(Number);
          if (status >= range[0] && status <= range[1]) return true;
        } else if (Number(parts[index]) === status) return true;
      }
      return false;
    }

    function errorMessage(error) {
      return String(error && error.message || error || '');
    }
    function isMissingTabError(error) {
      return /(?:No tab with id|Invalid tab ID|tab(?:\s+|-)not found|no such tab)/i.test(errorMessage(error));
    }
    function isExpectedMissingTarget(error) {
      return /^(?:TARGET_NOT_FOUND|TARGET_STALE)$/.test(String(error && error.code || ''));
    }

    function findOpenPageTab(pageId, page) {
      var source = 'page:' + pageId;
      var known = tabRuntime.getTabId(source);
      if (known) return chrome.tabs.get(known).then(function (tab) { return tab; }, function (error) {
        if (isMissingTabError(error)) return null;
        throw error;
      });
      return chrome.tabs.query({}).then(function (tabs) {
        var runningMatch = null;
        for (var index = 0; index < tabs.length; index += 1) {
          var tab = tabs[index];
          if (!tab || !tab.url) continue;
          var matches = sourceRegistry.matchesSourceUrlFamily(source, tab.url) || (page && page.url && tab.url.indexOf(page.url) === 0);
          if (!matches) continue;
          if (isTabClaimedByRunningSession(tab.id)) { if (!runningMatch) runningMatch = tab; continue; }
          return tab;
        }
        return runningMatch;
      });
    }

    function pageRequestCode(config) {
      return '(async function(config){' +
        'function headersObject(headers){var out={};try{headers.forEach(function(value,key){out[key]=value})}catch(_){}return out}' +
        'async function digest(text){try{var bytes=new TextEncoder().encode(String(text||""));var raw=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(raw)).map(function(v){return v.toString(16).padStart(2,"0")}).join("")}catch(_){return String(text||"").length+":"}}' +
        'async function request(url,opts){if(!url)return null;var resolved;try{resolved=new URL(String(url),document.baseURI||location.href)}catch(_){return {url:String(url),status:0,ok:false,error:"URL 格式无效",signature:"error|invalid-url"}}if(resolved.protocol!=="http:"&&resolved.protocol!=="https:")return {url:resolved.href,status:0,ok:false,error:"仅支持 http/https 或相对 URL",signature:"error|invalid-scheme"};var requestUrl=resolved.href;var ctrl=new AbortController();var timer=setTimeout(function(){ctrl.abort()},config.timeoutMs);try{var response=await fetch(requestUrl,Object.assign({method:"GET",credentials:"include",cache:"no-store",signal:ctrl.signal},opts||{}));var text="";try{text=await response.clone().text()}catch(_){}return {url:response.url||requestUrl,status:response.status,ok:response.ok,headers:headersObject(response.headers),signature:[response.status,response.headers.get("etag")||"",response.headers.get("last-modified")||"",await digest(text)].join("|")}}catch(error){return {url:requestUrl,status:0,ok:false,error:String(error&&error.message||error),signature:"error|"+String(error&&error.message||error)}}finally{clearTimeout(timer)}}' +
        'var heartbeat=await request(config.requestUrl,{method:config.method||"GET",headers:config.headers||{},body:/^(GET|HEAD)$/i.test(config.method||"GET")?undefined:config.body});' +
        'var version=await request(config.versionUrl,{method:config.versionMethod||"GET"});' +
        'return {href:location.href,title:document.title,heartbeat:heartbeat,version:version}' +
      '})(' + JSON.stringify(config) + ')';
    }

    function selectorVisible(tabId, selector) {
      if (!selector) return Promise.resolve(null);
      return pageAutomation.perception.resolveTarget(tabId, { selector: selector }, {
        checkOcclusion: false,
        requireEnabled: false,
        requireVisible: false,
      }).then(function (resolved) {
        return !!(resolved && resolved.target && resolved.target.visible === true);
      }, function (error) {
        if (isExpectedMissingTarget(error)) return false;
        throw error;
      });
    }

    function readKeepAliveFacts(tabId, keepAlive) {
      var config = {
        requestUrl: keepAlive.requestUrl || '', method: keepAlive.method || 'GET',
        headers: parseHeaderObject(keepAlive.headers), body: keepAlive.body,
        timeoutMs: Math.max(1000, Math.min(60000, Number(keepAlive.requestTimeoutMs) || 15000)),
        versionUrl: keepAlive.versionUrl || '', versionMethod: keepAlive.versionMethod || 'GET',
      };
      return Promise.all([
        selectorVisible(tabId, keepAlive.lockedSelector || ''),
        selectorVisible(tabId, keepAlive.healthySelector || ''),
        pageAutomation.action.act({
          source: 'script', tabId: tabId, kind: 'evaluate',
          input: { code: pageRequestCode(config), world: 'MAIN', mode: 'write' },
          timeoutMs: config.timeoutMs + 5000,
          sensitive: true,
        }),
      ]).then(function (values) {
        var pageResult = values[2].derivedFacts.result || {};
        pageResult.locked = values[0] === true;
        pageResult.healthy = keepAlive.healthySelector ? values[1] === true : null;
        pageResult.documentId = '';
        pageResult.receipt = values[2].receipt;
        return pageResult;
      });
    }

    function sendActivity(tabId, keepAlive) {
      if (keepAlive.activityMode !== 'cdpMouseMove') return Promise.resolve({ sent: false, mode: keepAlive.activityMode || 'none' });
      var x = Math.max(1, Math.min(200, Number(keepAlive.activityX) || (10 + Math.floor(Math.random() * 40))));
      var y = Math.max(1, Math.min(200, Number(keepAlive.activityY) || (10 + Math.floor(Math.random() * 40))));
      return pageAutomation.action.act({ source: 'script', tabId: tabId, kind: 'hover', input: { x: x, y: y }, timeoutMs: 10000 }).then(function (result) {
        return { sent: result.receipt.performed === 'yes', mode: 'cdpMouseMove', x: x, y: y, receipt: result.receipt };
      }, function (error) { return { sent: false, mode: 'cdpMouseMove', error: String(error && error.message || error) }; });
    }

    function reload(tabId, reason) {
      return pageAutomation.action.act({ source: 'script', tabId: tabId, kind: 'reload', input: {}, timeoutMs: 30000 }).then(function (result) {
        return { reloaded: result.receipt.performed === 'yes', reloadReason: reason, reloadReceipt: result.receipt };
      });
    }

    function execPageKeepAlive(pageId, page) {
      var keepAlive = page && page.keepAlive || {};
      if (!keepAlive.enabled) return Promise.resolve({ skipped: 'disabled' });
      return findOpenPageTab(pageId, page).then(function (tab) {
        if (!tab || !tab.id) return { skipped: 'page-not-open' };
        var runningSession = runningSessionForTab(tab.id);
        if (runningSession) return { tabId: tab.id, skipped: 'running-session', runId: runningSession.runId || '', flowId: runningSession.flowId || '' };
        if (tab.discarded && keepAlive.reloadDiscarded !== false) {
          return reload(tab.id, 'discarded').then(function (value) { return Object.assign({ tabId: tab.id }, value); });
        }
        return readKeepAliveFacts(tab.id, keepAlive).then(function (pageResult) {
          var heartbeat = pageResult.heartbeat || null;
          var expired = !!(heartbeat && (heartbeat.status === 401 || heartbeat.status === 403 || heartbeat.error || !statusMatches(Number(heartbeat.status), keepAlive.expectedStatus)));
          var state = stateByPageId[pageId] || (stateByPageId[pageId] = {});
          var versionChanged = false;
          if (pageResult.version && pageResult.version.signature) {
            if (state.versionSignature && state.versionSignature !== pageResult.version.signature) versionChanged = true;
            state.versionSignature = pageResult.version.signature;
          }
          var shouldReload = expired && keepAlive.reloadOnSessionExpired || pageResult.locked && keepAlive.reloadOnLocked || versionChanged && keepAlive.reloadOnVersionChange;
          return sendActivity(tab.id, keepAlive).then(function (activity) {
            var result = {
              tabId: tab.id, href: pageResult.href || tab.url || '', heartbeat: heartbeat ? {
                url: heartbeat.url, status: heartbeat.status, ok: heartbeat.ok, error: heartbeat.error || '',
                matchedExpectedStatus: statusMatches(Number(heartbeat.status), keepAlive.expectedStatus),
              } : null,
              expired: expired, locked: pageResult.locked === true, healthy: pageResult.healthy,
              versionChanged: versionChanged, activity: activity,
              documentId: pageResult.documentId, requestReceipt: pageResult.receipt,
            };
            if (!shouldReload) return result;
            var reason = expired ? 'session-expired' : (pageResult.locked ? 'locked' : 'version-changed');
            return reload(tab.id, reason).then(function (reloaded) { return Object.assign(result, reloaded); });
          });
        });
      });
    }

    return {
      execPageKeepAlive: execPageKeepAlive,
      findOpenPageTab: findOpenPageTab,
      statusMatches: statusMatches,
      parseHeaderObject: parseHeaderObject,
      syncCdpActivityState: function () { return Promise.resolve({ tracked: 0 }); },
    };
  }

  return { createPageKeepAlive: createPageKeepAlive };
});
