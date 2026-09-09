// HTTP and webhook node helpers.
(function attachNodeHttp(root, factory) {
  root.NodeHttp = factory();
})(globalThis, function () {
  'use strict';

  function createHttpNodes(deps) {
    deps = deps || {};
    var addLog = deps.addLog || function () {};
    var throwIfStopped = deps.throwIfStopped || function () {};
    var maxBodyLength = Number(deps.maxBodyLength) || (64 * 1024);

    function log(execution, message, options) {
      return execution && execution.addLog
        ? execution.addLog(message, options)
        : addLog(message, options);
    }

    function parseHeaderLines(raw) {
      var headers = {};
      if (!raw) return headers;
      if (typeof raw === 'object') return raw;
      var text = String(raw).trim();
      if (text.charAt(0) === '{') {
        try {
          var parsed = JSON.parse(text);
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {}
      }
      var lines = text.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return headers;
    }

    // URL values can come from templates, scripts, or loop variables and may
    // therefore bypass the flow-node schema. Keep the runtime boundary strict
    // so no non-web scheme reaches fetch (or any caller that delegates here).
    function normalizeHttpUrl(raw, label, missingMessage) {
      label = label || 'HTTP 请求';
      var text = raw === undefined || raw === null ? '' : String(raw).trim();
      if (!text) throw new Error(missingMessage || (label + '缺少 URL'));
      var parsed;
      try {
        parsed = new URL(text);
      } catch (_) {
        throw new Error(label + ' URL 格式无效');
      }
      var protocol = String(parsed.protocol || '').toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error(label + '仅支持 http/https URL');
      }
      return text;
    }

    function abortable(value, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted) {
        Promise.resolve(value).catch(function () {});
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('HTTP 请求已停止'));
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
          reject(signal.reason instanceof Error ? signal.reason : new Error('HTTP 请求已停止'));
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

    function httpFetch(url, options) {
      options = options || {};
      var requestUrl;
      try {
        requestUrl = normalizeHttpUrl(url, 'HTTP 请求');
      } catch (error) {
        return Promise.reject(error);
      }
      var method = (options.method || 'GET').toUpperCase();
      var configuredTimeout = Number(options.timeoutMs);
      var timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.max(1, Math.min(configuredTimeout, 10 * 60 * 1000))
        : 30000;
      var controller = new AbortController();
      var parentSignal = options.signal || null;
      var forwardAbort = null;
      function cancelledError() {
        var error = parentSignal && parentSignal.reason instanceof Error
          ? parentSignal.reason : new Error('HTTP 请求已停止');
        if (!error.code) error.code = 'ACTION_CANCELLED';
        if (error.performed === undefined) error.performed = 'unknown';
        if (error.retryable === undefined) error.retryable = false;
        return error;
      }
      if (parentSignal && parentSignal.aborted) {
        return Promise.reject(cancelledError());
      }
      if (parentSignal && typeof parentSignal.addEventListener === 'function') {
        forwardAbort = function () {
          try { controller.abort(parentSignal.reason); } catch (_) { controller.abort(); }
        };
        parentSignal.addEventListener('abort', forwardAbort, { once: true });
      }
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

      var init = {
        method: method,
        headers: parseHeaderLines(options.headers),
        signal: controller.signal,
      };
      if (options.body !== undefined && options.body !== null && options.body !== '' && !/^(?:GET|HEAD)$/.test(method)) {
        init.body = (typeof options.body === 'string') ? options.body : JSON.stringify(options.body);
        if (!init.headers['Content-Type'] && !init.headers['content-type']) {
          init.headers['Content-Type'] = 'application/json';
        }
      }

      return abortable(Promise.resolve().then(function () { return fetch(requestUrl, init); }), parentSignal).then(function (response) {
        return abortable(response.text(), parentSignal).then(function (text) {
          var body = text.slice(0, maxBodyLength);
          var json = null;
          try { json = JSON.parse(text); } catch (_) {}
          return { status: response.status, ok: response.ok, body: body, json: json };
        });
      }).catch(function (err) {
        if (parentSignal && parentSignal.aborted) {
          throw cancelledError();
        }
        if (err && err.name === 'AbortError') {
          err = new Error('HTTP 请求超时 (' + timeoutMs + 'ms): ' + requestUrl);
        }
        if (!/^(?:GET|HEAD|OPTIONS)$/.test(method) && err && (typeof err === 'object' || typeof err === 'function')) {
          try {
            err.performed = 'unknown';
            err.retryable = false;
          } catch (_) {}
        }
        throw err;
      }).finally(function () {
        clearTimeout(timer);
        if (parentSignal && forwardAbort && typeof parentSignal.removeEventListener === 'function') {
          try { parentSignal.removeEventListener('abort', forwardAbort); } catch (_) {}
        }
      });
    }

    function percentile(sorted, pct) {
      if (!sorted.length) return 0;
      var pos = (sorted.length - 1) * pct;
      var base = Math.floor(pos);
      var rest = pos - base;
      if (sorted[base + 1] !== undefined) {
        return Math.round((sorted[base] + rest * (sorted[base + 1] - sorted[base])) * 100) / 100;
      }
      return Math.round(sorted[base] * 100) / 100;
    }

    function execHttpLoadTest(params, execution) {
      var requestUrl = normalizeHttpUrl(params && params.url, 'HTTP 性能压测');
      var concurrency = Math.max(1, Math.min(100, Number(params.concurrency) || 1));
      var maxRequests = Math.max(0, Number(params.maxRequests) || 0);
      var durationMs = Math.max(0, Number(params.durationMs) || 0);
      if (!maxRequests && !durationMs) maxRequests = 50;

      var method = (params.method || 'GET').toUpperCase();
      var headers = params.headers;
      var body = params.body;
      var requestTimeoutMs = Math.max(1000, Number(params.requestTimeoutMs) || 30000);
      var startedAt = Date.now();
      var deadline = durationMs > 0 ? startedAt + durationMs : 0;
      var nextRequest = 0;
      var results = [];
      var statusCounts = {};
      var errors = {};

      log(execution, 'HTTP 性能压测开始: ' + method + ' ' + requestUrl + '，并发=' + concurrency + '，最大请求=' + (maxRequests || '按时长') + '，时长=' + (durationMs || '不限') + 'ms');

      function shouldStartMore() {
        if (maxRequests > 0 && nextRequest >= maxRequests) return false;
        if (deadline && Date.now() >= deadline) return false;
        return true;
      }

      function runOne() {
        throwIfStopped();
        var index = nextRequest++;
        var t0 = Date.now();
        return httpFetch(requestUrl, {
          method: method,
          headers: headers,
          body: body,
          timeoutMs: requestTimeoutMs,
          signal: execution && execution.signal,
        }).then(function (resp) {
          var duration = Date.now() - t0;
          var statusKey = String(resp.status || 0);
          statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
          results.push({ ok: !!resp.ok, status: resp.status || 0, durationMs: duration });
          return index;
        }).catch(function (err) {
          if (execution && execution.signal && execution.signal.aborted) throw err;
          throwIfStopped();
          var duration = Date.now() - t0;
          var message = (err && err.message) ? err.message : String(err);
          errors[message] = (errors[message] || 0) + 1;
          results.push({ ok: false, status: 0, durationMs: duration, error: message });
          return index;
        });
      }

      function worker() {
        if (!shouldStartMore()) return Promise.resolve();
        return runOne().then(worker);
      }

      var workers = [];
      for (var i = 0; i < concurrency; i++) workers.push(worker());

      return Promise.all(workers).then(function () {
        var endedAt = Date.now();
        var total = results.length;
        var ok = results.filter(function (r) { return r.ok; }).length;
        var failed = total - ok;
        var durations = results.map(function (r) { return r.durationMs; }).sort(function (a, b) { return a - b; });
        var sum = durations.reduce(function (acc, n) { return acc + n; }, 0);
        var elapsedMs = Math.max(1, endedAt - startedAt);
        var errorRatePct = total ? Math.round(failed / total * 10000) / 100 : 0;
        var latency = {
          min: durations.length ? durations[0] : 0,
          max: durations.length ? durations[durations.length - 1] : 0,
          avg: durations.length ? Math.round(sum / durations.length * 100) / 100 : 0,
          p50: percentile(durations, 0.50),
          p90: percentile(durations, 0.90),
          p95: percentile(durations, 0.95),
          p99: percentile(durations, 0.99),
        };
        var thresholdFailures = [];
        var p95Threshold = Number(params.p95ThresholdMs) || 0;
        var maxErrorRate = Number(params.maxErrorRatePct) || 0;
        if (p95Threshold > 0 && latency.p95 > p95Threshold) {
          thresholdFailures.push('P95 ' + latency.p95 + 'ms > 阈值 ' + p95Threshold + 'ms');
        }
        if (maxErrorRate > 0 && errorRatePct > maxErrorRate) {
          thresholdFailures.push('错误率 ' + errorRatePct + '% > 阈值 ' + maxErrorRate + '%');
        }
        var summary = {
          total: total,
          ok: ok,
          failed: failed,
          errorRatePct: errorRatePct,
          elapsedMs: elapsedMs,
          rps: Math.round(total / elapsedMs * 100000) / 100,
          latency: latency,
          statusCounts: statusCounts,
          errors: errors,
          thresholdPassed: thresholdFailures.length === 0,
          thresholdFailures: thresholdFailures,
        };
        log(execution, 'HTTP 性能压测完成: total=' + total + ', ok=' + ok + ', failed=' + failed + ', rps=' + summary.rps + ', p95=' + latency.p95 + 'ms, 错误率=' + errorRatePct + '%');
        if (thresholdFailures.length && params.failOnThreshold !== false) {
          var thresholdError = new Error('[压测失败] ' + thresholdFailures.join('; '));
          if (!/^(?:GET|HEAD|OPTIONS)$/.test(method) && total > 0) {
            thresholdError.performed = 'unknown';
            thresholdError.retryable = false;
          }
          throw thresholdError;
        }
        return summary;
      });
    }

    function execWebhook(params, execution) {
      var requestUrl = normalizeHttpUrl(params && params.url, 'Webhook');
      var requestMethod = String(params.method || 'POST').toUpperCase();
      log(execution, 'Webhook 推送: ' + requestMethod + ' ' + requestUrl);
      return httpFetch(requestUrl, {
        method: requestMethod,
        headers: params.headers,
        body: params.bodyTemplate,
        timeoutMs: params.timeoutMs,
        signal: execution && execution.signal,
      }).then(function (result) {
        if (!result.ok) {
          log(execution, 'Webhook 响应非 2xx: status=' + result.status, { level: 'warn' });
        }
        return result;
      });
    }

    return {
      parseHeaderLines: parseHeaderLines,
      httpFetch: httpFetch,
      execHttpLoadTest: execHttpLoadTest,
      execWebhook: execWebhook,
    };
  }

  return {
    createHttpNodes: createHttpNodes,
  };
});
