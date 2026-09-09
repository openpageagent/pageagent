// CDP Client — stateless send/timeout wrapper. CdpSessionManager owns attach/detach.
(function attachCdpClient(root, factory) {
  root.CdpClient = factory();
})(globalThis, function () {
  'use strict';
  var API_VERSION = 1;
  function createCdpClient(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;

    function normalizeTimeoutMs(value, fallback, min, max) {
      var n = Number(value);
      if (!isFinite(n) || n <= 0) n = fallback;
      if (min) n = Math.max(min, n);
      if (max) n = Math.min(max, n);
      return n;
    }

    function withTimeout(promise, timeoutMs, label) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          reject(new Error((label || '操作') + '超时: ' + timeoutMs + 'ms'));
        }, timeoutMs);
        Promise.resolve(promise).then(function (value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        }, function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        });
      });
    }

    function debuggeeFor(target) {
      if (target && typeof target === 'object') {
        var routed = { tabId: Math.floor(Number(target.tabId)) };
        if (target.sessionId) routed.sessionId = String(target.sessionId);
        return routed;
      }
      return { tabId: Math.floor(Number(target)) };
    }

    function send(target, method, params, timeoutMs) {
      timeoutMs = normalizeTimeoutMs(timeoutMs, 30000, 1, 120000);
      var debuggee = debuggeeFor(target);
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('CDP ' + method + ' 超时: ' + timeoutMs + 'ms'));
        }, timeoutMs);
        try {
          chrome.debugger.sendCommand(debuggee, method, params || {}, function (result) {
            // Chrome requires runtime.lastError to be read inside the callback.
            // A timed-out command may complete only after the debugger detached;
            // consume that late error even though this Promise is already settled.
            var runtimeError = null;
            try { runtimeError = chrome.runtime && chrome.runtime.lastError; } catch (error) { runtimeError = error; }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (runtimeError) {
              reject(runtimeError);
              return;
            }
            resolve(result);
          });
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    }

    return Object.freeze({
      normalizeTimeoutMs: normalizeTimeoutMs,
      withTimeout: withTimeout,
      send: send,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, createCdpClient: createCdpClient });
});
