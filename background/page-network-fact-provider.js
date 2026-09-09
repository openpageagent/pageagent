// Network evidence provider used only through PagePerceptionEngine/PageAutomationRuntime.
(function attachPageNetworkFactProvider(root, factory) {
  'use strict';
  var api = factory(root && root.PageDataContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageNetworkFactProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pageDataContract) {
  'use strict';
  var API_VERSION = 1;
  function createPageNetworkFactProvider(options) {
    options = options || {};
    var chromeApi = options.chrome || globalThis.chrome;
    function abortError(signal) {
      return signal && signal.reason instanceof Error ? signal.reason : new Error('网络事实等待已停止');
    }
    function ensureNotAborted(signal) {
      if (signal && signal.aborted) throw abortError(signal);
    }
    function abortablePromise(value, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted) {
        Promise.resolve(value).catch(function () {});
        return Promise.reject(abortError(signal));
      }
      return new Promise(function (resolve, reject) {
        var settled = false;
        function cleanup() {
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          if (settled) return;
          settled = true;
          cleanup();
          reject(abortError(signal));
        }
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(value).then(function (result) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        }, function (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
    }
    function abortableDelay(ms, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') {
        return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
      }
      ensureNotAborted(signal);
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
          resolve();
        }, Math.max(0, Number(ms) || 0));
        function onAbort() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
          reject(abortError(signal));
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    function send(tabId, payload) {
      return new Promise(function (resolve, reject) {
        chromeApi.tabs.sendMessage(Number(tabId), { type: 'PAGE_NETWORK_FACT_QUERY', payload: payload }, { frameId: 0 }, function (response) {
          var error = chromeApi.runtime && chromeApi.runtime.lastError;
          if (error) { reject(new Error(error.message)); return; }
          if (!response || response.ok !== true) { reject(new Error(response && response.error || '网络事实 provider 无响应')); return; }
          resolve(response.result || {});
        });
      });
    }
    function ensure(tabId) {
      return send(tabId, { kind: 'probe', filter: {}, timeoutMs: 250 }).catch(function () {
        return chromeApi.scripting.executeScript({ target: { tabId: Number(tabId), frameIds: [0] }, files: ['content/page-network-provider.js'] }).then(function () {
          return send(tabId, { kind: 'probe', filter: {}, timeoutMs: 250 });
        });
      });
    }
    function filter(params) {
      return {
        entryId: String(params.entryId || ''),
        urlFilter: String(params.urlFilter || ''), method: String(params.method || ''),
        resourceType: String(params.resourceType || ''), phase: String(params.phase || ''),
        eventName: String(params.eventName || ''), streamId: String(params.streamId || ''),
        latestOnly: params.latestOnly !== false, limit: 300,
        retentionMs: Number(params.retentionMs || params.maxEntryAgeMs) || 0,
      };
    }
    function mapEntry(entry, parseJson) {
      var body = entry.bodyText;
      if (parseJson) { try { body = JSON.parse(body); } catch (_) {} }
      return {
        id: entry.id || '', url: entry.url || '', method: entry.method || '', status: Number(entry.status) || 0,
        timestamp: entry.ts || 0, durationMs: Math.max(0, Number(entry.durationMs) || 0),
        resourceType: entry.resourceType || entry.type || 'unknown', type: entry.type || entry.resourceType || 'unknown',
        phase: entry.phase || '', eventName: entry.eventName || '', eventId: entry.eventId || '', retry: entry.retry || '',
        streamId: entry.streamId || '', streamSeq: Number(entry.streamSeq) || 0, contentType: entry.contentType || '',
        requestHeaders: entry.requestHeaders || {}, requestBody: entry.requestBody || '', replayOf: entry.replayOf || '', body: body,
      };
    }
    function query(tabId, params) {
      params = params || {};
      pageDataContract.normalizeWindow(params, params.resourceType === 'sse' ? 'getSseEvents' : 'getRequests');
      var timeoutMs = Math.max(0, Number(params.timeoutMs) || 0);
      var deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
      function attempt() {
        ensureNotAborted(params.signal);
        return abortablePromise(ensure(tabId), params.signal).then(function () {
          return abortablePromise(send(tabId, { kind: 'query', filter: filter(params), timeoutMs: 1800 }), params.signal);
        }).then(function (result) {
          ensureNotAborted(params.signal);
          if (!result.available) throw new Error('网络捕获未启用：请在页面配置中开启捕获网络请求并刷新页面');
          var entries = (result.entries || []).map(function (entry) { return mapEntry(entry, params.parseJson === true); });
          if (entries.length || Date.now() >= deadline) return entries;
          return abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), params.signal).then(attempt);
        });
      }
      return attempt().then(function (entries) {
        var selected = params.latestOnly === false ? entries : entries.slice(-1);
        var page = pageDataContract.paginateItems(selected, params, 'network facts', { dataKey: 'entries' });
        return Object.assign({ type: 'network-log', tabId: Number(tabId), totalCount: selected.length, returnedCount: page.entries.length, capturedBy: 'PageNetworkFactProvider', evidenceSource: 'net-capture-main' }, page);
      });
    }
    function clear(tabId, signal) {
      ensureNotAborted(signal);
      return abortablePromise(ensure(tabId), signal).then(function () {
        return abortablePromise(send(tabId, { kind: 'clear', timeoutMs: 1800 }), signal);
      }).then(function (result) {
        ensureNotAborted(signal);
        if (!result.available) throw new Error('网络捕获未启用');
        return { cleared: Number(result.cleared) || 0, evidenceSource: 'PageNetworkFactProvider' };
      });
    }
    return Object.freeze({ query: query, clear: clear });
  }
  return Object.freeze({ API_VERSION: API_VERSION, createPageNetworkFactProvider: createPageNetworkFactProvider });
});
