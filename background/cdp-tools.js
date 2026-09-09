// CDP evidence provider — debugger-backed network/script/performance diagnostics.
(function attachCdpTools(root, factory) {
  root.CdpTools = factory();
})(globalThis, function () {
  'use strict';
  var API_VERSION = 1;
  function createCdpTools(deps) {
    deps = deps || {};
    var client = deps.cdpClient;
    var sessions = deps.cdpSessionManager;
    var addLog = deps.addLog || (function () {});
    var sourceRegistry = deps.sourceRegistry;
    var hostFromUrl = deps.hostFromUrl || (function () { return ''; });
    var networkLogs = {};
    var scriptLogs = {};
    var traceSessions = {};
    var performanceCaptures = {};
    var pageDataContract = globalThis.PageDataContract;
    if (!pageDataContract) throw new Error('CdpTools requires PageDataContract');

    function cancellationError(signal) {
      if (signal && signal.reason instanceof Error) return signal.reason;
      var error = new Error('CDP 诊断已取消');
      error.code = 'ACTION_CANCELLED';
      error.retryable = false;
      return error;
    }
    function ensureNotAborted(signal) {
      if (signal && signal.aborted === true) throw cancellationError(signal);
    }
    function abortablePromise(value, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted === true) {
        Promise.resolve(value).catch(function () {});
        return Promise.reject(cancellationError(signal));
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
          reject(cancellationError(signal));
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
      ensureNotAborted(signal);
      return new Promise(function (resolve, reject) {
        var settled = false;
        function cleanup() {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(cancellationError(signal));
        }
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }, Math.max(0, Number(ms) || 0));
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    function signalSender(send, signal) {
      var rawSend = send && send._rawSend || send;
      function abortAwareSend(method, params, timeoutMs) {
        ensureNotAborted(signal);
        return abortablePromise(send(method, params || {}, timeoutMs), signal);
      }
      abortAwareSend._rawSend = rawSend;
      return abortAwareSend;
    }
    function detachCaptureAbort(capture) {
      if (!capture || !capture.abortSignal || !capture.abortListener) return;
      if (typeof capture.abortSignal.removeEventListener === 'function') {
        capture.abortSignal.removeEventListener('abort', capture.abortListener);
      }
      capture.abortSignal = null;
      capture.abortListener = null;
    }
    function releasePerformanceCapture(capture) {
      if (!capture) return Promise.resolve();
      detachCaptureAbort(capture);
      var ownsTrace = !!capture.prestartedTrace && traceSessions[capture.tabId] === capture.prestartedTrace;
      var stopTracing;
      try {
        stopTracing = ownsTrace
          ? (capture.prestartedTrace.cleanupSend || capture.lease.send)('Tracing.end', {})
          : Promise.resolve();
      }
      catch (_) { stopTracing = Promise.resolve(); }
      return Promise.resolve(stopTracing).catch(function () {}).then(function () {
        if (traceSessions[capture.tabId] === capture.prestartedTrace) delete traceSessions[capture.tabId];
        return capture.lease.release();
      });
    }
    function releaseCaptureLease(capture) {
      if (!capture) return Promise.resolve();
      var ownsTrace = !!capture.prestartedTrace && traceSessions[capture.tabId] === capture.prestartedTrace;
      return ownsTrace ? releasePerformanceCapture(capture) : (detachCaptureAbort(capture), capture.lease.release());
    }

    function recordCdpNetworkEvent(tabId, method, params) {
      var bucket = networkLogs[tabId] || (networkLogs[tabId] = { order: [], byId: {} });
      var id = params.requestId;
      if (!id) return;
      var entry = bucket.byId[id];
      if (!entry) {
        entry = bucket.byId[id] = { id: id, requestId: id, startedAt: Date.now(), events: [] };
        bucket.order.push(id);
        while (bucket.order.length > 300) delete bucket.byId[bucket.order.shift()];
      }
      entry.updatedAt = Date.now();
      entry.events.push({ method: method, timestamp: Date.now() });
      if (entry.events.length > 20) entry.events.shift();
      if (method === 'Network.requestWillBeSent') {
        var req = params.request || {};
        entry.url = req.url || entry.url || '';
        entry.method = req.method || entry.method || '';
        entry.requestHeaders = req.headers || {};
        entry.requestBody = req.postData || '';
        entry.type = params.type || entry.type || '';
        entry.documentURL = params.documentURL || '';
        entry.requestTimestamp = params.timestamp || 0;
        entry.wallTime = params.wallTime || 0;
      } else if (method === 'Network.responseReceived') {
        var resp = params.response || {};
        entry.status = resp.status;
        entry.statusText = resp.statusText || '';
        entry.mimeType = resp.mimeType || '';
        entry.responseHeaders = resp.headers || {};
        entry.resourceType = params.type || entry.type || '';
        entry.responseTimestamp = params.timestamp || 0;
        entry.responseTiming = resp.timing || null;
      } else if (method === 'Network.loadingFinished') {
        entry.finished = true;
        entry.encodedDataLength = params.encodedDataLength || 0;
        entry.finishedTimestamp = params.timestamp || 0;
      } else if (method === 'Network.loadingFailed') {
        entry.failed = true;
        entry.errorText = params.errorText || '';
        entry.canceled = !!params.canceled;
        entry.finishedTimestamp = params.timestamp || 0;
      }
      if (entry.requestTimestamp && entry.finishedTimestamp) {
        entry.durationMs = Math.max(0, Math.round((entry.finishedTimestamp - entry.requestTimestamp) * 1000));
      } else if (entry.requestTimestamp && entry.responseTimestamp) {
        entry.durationMs = Math.max(0, Math.round((entry.responseTimestamp - entry.requestTimestamp) * 1000));
      }
    }

    function recordCdpScriptEvent(tabId, params) {
      if (!params || !params.scriptId) return;
      var bucket = scriptLogs[tabId] || (scriptLogs[tabId] = { order: [], byId: {} });
      var id = String(params.scriptId);
      if (!bucket.byId[id]) bucket.order.push(id);
      bucket.byId[id] = {
        scriptId: id,
        url: params.url || '',
        startLine: params.startLine || 0,
        startColumn: params.startColumn || 0,
        endLine: params.endLine || 0,
        endColumn: params.endColumn || 0,
        executionContextId: params.executionContextId || 0,
        hash: params.hash || '',
        sourceMapURL: params.sourceMapURL || '',
        updatedAt: Date.now(),
      };
      while (bucket.order.length > 1000) delete bucket.byId[bucket.order.shift()];
    }

    function getCdpScriptEntries(tabId) {
      var bucket = scriptLogs[tabId] || { order: [], byId: {} };
      return bucket.order.map(function (id) { return bucket.byId[id]; }).filter(Boolean);
    }

    function recordCdpTraceEvent(tabId, method, params) {
      var session = traceSessions[tabId];
      if (!session) return;
      if (method === 'Tracing.dataCollected') {
        var values = params.value || [];
        for (var i = 0; i < values.length; i++) {
          if (session.events.length < session.maxEvents) session.events.push(values[i]);
          else session.truncated = true;
        }
      } else if (method === 'Tracing.tracingComplete') {
        session.complete = true;
        if (session.resolve) session.resolve({ stream: params.stream || '', events: session.events, truncated: !!session.truncated });
      }
    }

    function getCdpNetworkEntries(tabId, params) {
      params = params || {};
      var bucket = networkLogs[tabId] || { order: [], byId: {} };
      var list = bucket.order.map(function (id) { return bucket.byId[id]; }).filter(Boolean);
      if (params.sinceMs) list = list.filter(function (e) { return (e.startedAt || e.updatedAt || 0) >= params.sinceMs; });
      if (params.urlFilter) list = list.filter(function (e) { return (e.url || '').indexOf(params.urlFilter) !== -1; });
      if (params.method) list = list.filter(function (e) { return String(e.method || '').toUpperCase() === String(params.method).toUpperCase(); });
      if (params.status) list = list.filter(function (e) { return Number(e.status) === Number(params.status); });
      list = list.slice(-Math.max(1, Math.min(200, Number(params.limit) || 50))).reverse();
      return params.latestOnly ? list.slice(0, 1) : list;
    }

    function metricsArrayToObject(metrics) {
      var out = {};
      (metrics || []).forEach(function (m) {
        out[m.name] = m.value;
      });
      return out;
    }

    function evaluatePerformanceEntries(send) {
      var expression = '(function(){' +
        'function pick(o,keys){var r={};keys.forEach(function(k){try{var v=o&&o[k];if(typeof v==="number"||typeof v==="string")r[k]=v;}catch(_){}});return r;}' +
        'var nav=performance.getEntriesByType("navigation")[0];' +
        'var paints=performance.getEntriesByType("paint").map(function(e){return pick(e,["name","startTime","duration"]);});' +
        'var resources=performance.getEntriesByType("resource").map(function(e){return {name:String(e.name||"").slice(0,500),initiatorType:e.initiatorType||"",startTime:Math.round(e.startTime),duration:Math.round(e.duration),responseEnd:Math.round(e.responseEnd),transferSize:e.transferSize||0,encodedBodySize:e.encodedBodySize||0,decodedBodySize:e.decodedBodySize||0};}).sort(function(a,b){return b.duration-a.duration;}).slice(0,30);' +
        'var longTasks=performance.getEntriesByType("longtask").map(function(e){return {name:e.name||"longtask",startTime:Math.round(e.startTime),duration:Math.round(e.duration)};}).sort(function(a,b){return b.duration-a.duration;}).slice(0,30);' +
        'var measures=performance.getEntriesByType("measure").map(function(e){return pick(e,["name","startTime","duration"]);}).slice(-30);' +
        'return {timeOrigin:performance.timeOrigin||0,now:Math.round(performance.now()),navigation:nav?pick(nav,["startTime","duration","domInteractive","domContentLoadedEventEnd","loadEventEnd","responseStart","responseEnd","transferSize","encodedBodySize","decodedBodySize"]):null,paint:paints,slowResources:resources,longTasks:longTasks,measures:measures};' +
        '})()';
      return send('Runtime.evaluate', { expression: expression, returnByValue: true }).then(function (res) {
        if (res.exceptionDetails) throw res.exceptionDetails;
        return res.result ? res.result.value : {};
      });
    }

    function performCdpAnalysisAction(_send, params) {
      return Promise.resolve(params._unifiedActionResult || { action: 'none' });
    }

    function startCdpTrace(send, tabId, params) {
      params = params || {};
      var cleanupSend = send && send._rawSend || send;
      send = signalSender(send, params.signal);
      ensureNotAborted(params.signal);
      if (traceSessions[tabId]) return Promise.reject(new Error('Tracing session is already active for tab ' + tabId));
      var categories = params.traceCategories || 'devtools.timeline,v8,blink.user_timing,loading,disabled-by-default-devtools.timeline';
      var session = {
        events: [],
        maxEvents: Math.max(500, Math.min(20000, Number(params.maxTraceEvents) || 6000)),
        truncated: false,
        complete: false,
        cleanupSend: cleanupSend,
      };
      var actionResult = { action: 'none' };
      var completePromise = new Promise(function (resolve) {
        session.resolve = resolve;
      });
      session.completePromise = completePromise;
      traceSessions[tabId] = session;
      return send('Tracing.start', {
        categories: categories,
        options: 'sampling-frequency=10000',
      }).then(function () { return session; }, function (error) {
        var stopTracing;
        try { stopTracing = traceSessions[tabId] === session ? cleanupSend('Tracing.end', {}) : Promise.resolve(); }
        catch (_) { stopTracing = Promise.resolve(); }
        return Promise.resolve(stopTracing).catch(function () {}).then(function () {
          if (traceSessions[tabId] === session) delete traceSessions[tabId];
          throw error;
        });
      });
    }

    function finishCdpTrace(send, tabId, params, sampleMs, session, actionResult) {
      params = params || {};
      var cleanupSend = send && send._rawSend || send;
      send = signalSender(send, params.signal);
      ensureNotAborted(params.signal);
      session = session || traceSessions[tabId];
      if (!session) return Promise.reject(new Error('Tracing session is unavailable'));
      actionResult = actionResult || { action: 'none' };
      var completePromise = session.completePromise;
      var delayMs = Math.max(0, Math.min(10000, Number(params.afterActionDelayMs) || 0));
      return Promise.resolve().then(function () {
        if (!delayMs) return null;
        return abortableDelay(delayMs, params.signal);
      }).then(function () {
        return abortableDelay(sampleMs, params.signal);
      }).then(function () {
        if (traceSessions[tabId] !== session) {
          var ownershipError = new Error('Tracing session ownership was released before collection completed');
          ownershipError.code = 'TRACE_SESSION_RELEASED';
          ownershipError.retryable = false;
          throw ownershipError;
        }
        return send('Tracing.end', {});
      }).then(function () {
        return abortablePromise(Promise.race([
          completePromise,
          new Promise(function (resolve) {
            setTimeout(function () { resolve({ events: session.events, truncated: true, timedOut: true }); }, 5000);
          }),
        ]), params.signal);
      }).then(function (trace) {
        if (traceSessions[tabId] === session) delete traceSessions[tabId];
        trace.action = actionResult;
        return trace;
      }, function (error) {
        var ownsTrace = traceSessions[tabId] === session;
        var stopTracing;
        try { stopTracing = ownsTrace ? cleanupSend('Tracing.end', {}) : Promise.resolve(); }
        catch (_) { stopTracing = Promise.resolve(); }
        return Promise.resolve(stopTracing).catch(function () {}).then(function () {
          if (traceSessions[tabId] === session) delete traceSessions[tabId];
          throw error;
        });
      });
    }

    function collectCdpTrace(send, tabId, params, sampleMs) {
      var session;
      var actionResult = { action: 'none' };
      return startCdpTrace(send, tabId, params).then(function (created) {
        session = created;
        return performCdpAnalysisAction(send, params);
      }).then(function (result) {
        actionResult = result || { action: 'none' };
        return finishCdpTrace(send, tabId, params, sampleMs, session, actionResult);
      });
    }

    function summarizeTraceEvents(traceEvents, params) {
      var events = traceEvents || [];
      var minTs = null;
      var longTaskThreshold = Math.max(16, Math.min(500, Number(params.longTaskThresholdMs) || 50));
      var names = {};
      var longTasks = [];
      var topEvents = [];
      var interesting = {
        RunTask: true,
        TaskQueueManager: true,
        EvaluateScript: true,
        FunctionCall: true,
        EventDispatch: true,
        TimerFire: true,
        ParseHTML: true,
        Layout: true,
        RecalculateStyles: true,
        Paint: true,
        CompositeLayers: true,
        XHRReadyStateChange: true,
        ResourceReceiveResponse: true,
        ResourceFinish: true,
      };

      events.forEach(function (e) {
        if (typeof e.ts === 'number' && (minTs === null || e.ts < minTs)) minTs = e.ts;
      });
      if (minTs === null) minTs = 0;

      events.forEach(function (e) {
        var durMs = (Number(e.dur) || 0) / 1000;
        if (!durMs || e.ph !== 'X') return;
        var name = String(e.name || 'unknown');
        var key = interesting[name] ? name : name.replace(/:.+$/, '');
        if (!names[key]) names[key] = { name: key, count: 0, totalMs: 0, maxMs: 0 };
        names[key].count++;
        names[key].totalMs += durMs;
        names[key].maxMs = Math.max(names[key].maxMs, durMs);
        var item = {
          name: name,
          category: e.cat || '',
          startMs: Math.round((e.ts - minTs) / 1000),
          durationMs: Math.round(durMs),
        };
        if (durMs >= longTaskThreshold) longTasks.push(item);
        topEvents.push(item);
      });

      longTasks.sort(function (a, b) { return b.durationMs - a.durationMs; });
      topEvents.sort(function (a, b) { return b.durationMs - a.durationMs; });
      var byName = Object.keys(names).map(function (k) {
        var v = names[k];
        return {
          name: v.name,
          count: v.count,
          totalMs: Math.round(v.totalMs),
          maxMs: Math.round(v.maxMs),
        };
      }).sort(function (a, b) { return b.totalMs - a.totalMs; }).slice(0, 20);

      return {
        eventCount: events.length,
        longTaskThresholdMs: longTaskThreshold,
        longTasks: longTasks.slice(0, 20),
        topEvents: topEvents.slice(0, 20),
        costByName: byName,
      };
    }

    function buildPerformanceRecommendations(perfEntries, cdpMetrics, traceSummary, networkEntries, sampleMs, actionResult) {
      var nav = perfEntries.navigation || {};
      var loadEnd = Number(nav.loadEventEnd) || Number(nav.duration) || 0;
      var dcl = Number(nav.domContentLoadedEventEnd) || 0;
      var slowNetwork = (networkEntries || []).filter(function (e) {
        return e && e.durationMs;
      }).sort(function (a, b) { return (b.durationMs || 0) - (a.durationMs || 0); }).slice(0, 10);
      var longTasks = traceSummary.longTasks || [];
      var maxLongTask = longTasks[0] ? longTasks[0].durationMs : 0;
      var maxNetwork = slowNetwork[0] ? slowNetwork[0].durationMs : 0;
      var longestFrontendEndMs = longTasks.reduce(function (max, task) {
        return Math.max(max, (task.startMs || 0) + (task.durationMs || 0));
      }, 0);
      var longestNetworkEndMs = slowNetwork.reduce(function (max, entry) {
        var startOffset = entry.startedAt && actionResult && actionResult.startedAt ? Math.max(0, entry.startedAt - actionResult.startedAt) : 0;
        return Math.max(max, startOffset + (entry.durationMs || 0));
      }, 0);
      var hasMeasuredAction = actionResult && (actionResult.action === 'click' || actionResult.action === 'reload');
      var observedActionCompleteMs = hasMeasuredAction
        ? Math.max(longestFrontendEndMs, longestNetworkEndMs, maxNetwork, maxLongTask)
        : Math.max(maxNetwork, maxLongTask);
      var pageLoadTimeoutMs = Math.max(3000, Math.min(120000, Math.ceil(Math.max(loadEnd, dcl, maxNetwork) * 1.3 + 1000)));
      var actionSettlingMs = Math.max(500, Math.min(30000, Math.ceil(Math.max(observedActionCompleteMs * 1.25, maxLongTask * 2, 800))));
      var readinessSignals = [];
      var hotspots = [];

      if (maxNetwork >= 1000) {
        readinessSignals.push({ signal: 'network-response-then-dom', reason: '关键数据可能由慢请求驱动', url: slowNetwork[0].url || '', observedMs: maxNetwork });
        hotspots.push({ type: 'network', severity: maxNetwork >= 3000 ? 'high' : 'medium', message: '存在慢请求，流程等待应优先绑定请求完成后出现的 DOM/文本状态', durationMs: maxNetwork, url: slowNetwork[0].url || '' });
      }
      if (maxLongTask >= 50) {
        readinessSignals.push({ signal: 'post-action-dom-stable', reason: '主线程长任务会延迟渲染和事件响应', observedMs: maxLongTask });
        hotspots.push({ type: 'main-thread', severity: maxLongTask >= 200 ? 'high' : 'medium', message: '存在主线程长任务，点击/填充后的下一步应等待关键元素可见/可点击，而不是立即连续动作', durationMs: maxLongTask, event: longTasks[0].name });
      }
      if (Number(cdpMetrics.JSHeapUsedSize) > 100 * 1024 * 1024) hotspots.push({ type: 'memory', severity: 'medium', message: 'JS heap 使用较高，长流程中应增加中间断言和失败截图，避免状态漂移难定位', bytes: Math.round(cdpMetrics.JSHeapUsedSize) });
      if (!readinessSignals.length) readinessSignals.push({ signal: 'element-or-text-assertion', reason: '未观察到明显网络或主线程瓶颈，流程可直接围绕关键元素/文本编排' });
      if (!hotspots.length) hotspots.push({ type: 'baseline', severity: 'low', message: '采样窗口内未发现明显慢点，可优先使用元素断言或页面稳定等待' });

      return {
        purpose: 'flow-orchestration',
        suggestedWaits: {
          pageLoadTimeoutMs: pageLoadTimeoutMs,
          actionSettlingMs: actionSettlingMs,
          networkIdleMs: 800,
          sampleWindowMs: sampleMs,
        },
        flowPlan: {
          openOrNavigate: {
            node: 'waitForPageLoad',
            timeoutMs: pageLoadTimeoutMs,
            followWith: 'assert_element/assert_text 检查业务关键区域已出现',
          },
          afterClickOrFill: {
            preferred: 'waitForElement/assertElement/assertText 等待下一状态',
            fallbackDelayMs: actionSettlingMs,
            observedCompleteMs: Math.round(observedActionCompleteMs),
            measuredAction: actionResult || { action: 'none' },
            note: '固定 delay 只用于没有可观测状态的兜底，不作为主要编排方式。',
          },
          readinessSignals: readinessSignals,
        },
        flowGuidance: [
          '打开/刷新页面后优先使用 waitForPageLoad，timeoutMs 可参考 pageLoadTimeoutMs。',
          '交互后优先等待业务关键元素或文本出现；如果本次传入 action=click，则 actionSettlingMs 来自点击后观测到的网络和前端主线程耗时。',
          '慢点来自网络时，不要固定睡眠过长；用 inspect_network/getRequests 找 URL，再等待响应后出现的 DOM 状态。',
          '慢点来自主线程长任务时，避免连续高频点击/填充，动作之间保留稳定窗口并加断言验证。',
        ],
        hotspots: hotspots,
      };
    }

    function analyzeCdpPerformance(send, tabId, params) {
      params = params || {};
      send = signalSender(send, params.signal);
      ensureNotAborted(params.signal);
      var sampleMs = Math.max(1000, Math.min(60000, Number(params.sampleMs || params.listenMs) || 5000));
      var captureStartedAt = Number(params._captureStartedAt) || Date.now();
      var beforeMetrics = params._beforeMetrics || {};
      var afterMetrics = {};
      var perfEntries = {};
      var traceResult = {};
      var tracePromise;
      if (params._prestartedTrace) {
        tracePromise = finishCdpTrace(send, tabId, params, sampleMs, params._prestartedTrace, params._unifiedActionResult || { action: 'none' });
      } else {
        tracePromise = send('Performance.enable', { timeDomain: 'timeTicks' }).then(function () {
          return send('Network.enable', { maxTotalBufferSize: 10485760, maxResourceBufferSize: 1048576 });
        }).then(function () {
          return send('Performance.getMetrics', {});
        }).then(function (m) {
          beforeMetrics = metricsArrayToObject(m.metrics || []);
          return collectCdpTrace(send, tabId, params, sampleMs);
        });
      }
      return tracePromise.then(function (trace) {
        traceResult = trace || {};
        return Promise.all([
          send('Performance.getMetrics', {}),
          evaluatePerformanceEntries(send),
        ]);
      }).then(function (results) {
        afterMetrics = metricsArrayToObject((results[0] && results[0].metrics) || []);
        perfEntries = results[1] || {};
        var networkEntries = getCdpNetworkEntries(tabId, Object.assign({}, params, { limit: params.networkLimit || 50, sinceMs: captureStartedAt }));
        var traceSummary = summarizeTraceEvents(traceResult.events || [], params);
        var recommendations = buildPerformanceRecommendations(perfEntries, afterMetrics, traceSummary, networkEntries, sampleMs, traceResult.action);
        return {
          type: 'performance-analysis',
          capturedBy: 'CDP Performance + Tracing + Network',
          boundary: {
            canMeasure: ['页面加载阶段、资源/接口耗时、主线程长任务、脚本/样式/布局粗粒度耗时、JS heap/DOM 节点等浏览器指标'],
            cannotProve: ['业务接口语义是否正确、后端内部耗时、用户真实设备全量分布、未在采样窗口发生的交互慢点'],
            bestUse: '用采样结果确定流程等待边界：等待关键元素/文本/请求状态，固定 delay 只作为最后兜底。',
          },
          sampleMs: sampleMs,
          reload: !!params.reload,
          action: traceResult.action || { action: 'none' },
          performanceMetrics: {
            before: beforeMetrics,
            after: afterMetrics,
            delta: {
              TaskDuration: Math.max(0, (afterMetrics.TaskDuration || 0) - (beforeMetrics.TaskDuration || 0)),
              ScriptDuration: Math.max(0, (afterMetrics.ScriptDuration || 0) - (beforeMetrics.ScriptDuration || 0)),
              LayoutDuration: Math.max(0, (afterMetrics.LayoutDuration || 0) - (beforeMetrics.LayoutDuration || 0)),
              RecalcStyleDuration: Math.max(0, (afterMetrics.RecalcStyleDuration || 0) - (beforeMetrics.RecalcStyleDuration || 0)),
            },
          },
          performanceEntries: perfEntries,
          trace: Object.assign({}, traceSummary, { truncated: !!traceResult.truncated, timedOut: !!traceResult.timedOut }),
          network: {
            entries: networkEntries,
            slowest: networkEntries.slice().filter(function (e) { return e && e.durationMs; }).sort(function (a, b) { return (b.durationMs || 0) - (a.durationMs || 0); }).slice(0, 10),
          },
          recommendations: recommendations,
        };
      });
    }

    function pageHostMatchesTab(page, source, tab) {
      if (!tab || !tab.url) return false;
      var pageHost = hostFromUrl(page && page.url);
      var tabHost = hostFromUrl(tab.url);
      if (pageHost && tabHost) return pageHost === tabHost;
      return sourceRegistry.matchesSourceUrlFamily(source, tab.url);
    }
    function buildSelectorBoxExpression(selector) {
      return '(function(){' +
        'var el=document.querySelector(' + JSON.stringify(selector || '') + ');' +
        'if(!el) throw new Error("未找到元素: " + ' + JSON.stringify(selector || '') + ');' +
        'var r=el.getBoundingClientRect();' +
        'return {x:r.left,y:r.top,width:r.width,height:r.height,centerX:r.left+r.width/2,centerY:r.top+r.height/2,text:(el.textContent||"").trim().replace(/\\s+/g," ").slice(0,300),tagName:(el.tagName||"").toLowerCase(),id:el.id||"",className:typeof el.className==="string"?el.className:""};' +
        '})()';
    }

    function collectEvidence(command, params) {
      params = params || {};
      ensureNotAborted(params.signal);
      var cdpCommand = String(command || '').replace(/^cdp\./, '');
      var windowedCommands = {
        inspect_network: true,
        javascript_source: true,
        search_script_sources: true,
        analyze_performance: true,
      };
      if (windowedCommands[cdpCommand]) pageDataContract.normalizeWindow(params, 'cdp.' + cdpCommand);
      var analyzeSampleMs = cdpCommand === 'analyze_performance' ? (Number(params.sampleMs || params.listenMs) || 5000) : 0;
      var analyzeAfterActionDelayMs = cdpCommand === 'analyze_performance' ? (Number(params.afterActionDelayMs) || 0) : 0;
      var timeoutFallback = cdpCommand === 'analyze_performance' ? Math.max(30000, analyzeSampleMs + analyzeAfterActionDelayMs + 10000) : 30000;
      var timeoutMs = client.normalizeTimeoutMs(params.timeoutMs, timeoutFallback, 1000, 180000);
      var startedAt = Date.now();
      var stateChanging = cdpCommand === 'analyze_performance' && (params.reload || String(params.action || '').toLowerCase() === 'click');
      var risk = {
        level: stateChanging ? 'state-changing' : 'debug-read',
        note: '该入口仅提供受限的 CDP 诊断证据，并复用统一 CdpSessionManager。普通页面输入始终由 PageActionEngine 通过 CDP 执行；这里不是第二条动作路径，也不是失败后的 fallback。浏览器会显示调试提示，且同一标签页不能同时被 DevTools 或其他调试器占用。',
      };

      function envelope(result) {
        return {
          result: result,
          risk: risk,
          executionLog: {
            tabId: Number(params.tabId) || 0,
            command: 'cdp.' + cdpCommand,
            startedAt: startedAt,
            endedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            timeoutMs: timeoutMs,
          },
        };
      }

      var targetTabId = Number(params.tabId);
      if (!isFinite(targetTabId) || targetTabId <= 0) return Promise.reject(new Error('CDP ' + cdpCommand + ' 需要 tabId'));
      var tabPromise = Promise.resolve(Math.floor(targetTabId));
      if (cdpCommand === 'performance_capture_start') {
        var captureToken = 'performance_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
        return sessions.acquire(Math.floor(targetTabId), { owner: 'CdpTools:' + captureToken, type: 'raw-cdp', signal: params.signal || null }).then(async function (lease) {
          var captureSend = signalSender(lease.send, params.signal);
          try {
            await captureSend('Performance.enable', { timeDomain: 'timeTicks' });
            await captureSend('Network.enable', { maxTotalBufferSize: 10485760, maxResourceBufferSize: 1048576 });
            var metrics = await captureSend('Performance.getMetrics', {});
            var state = {
              token: captureToken, tabId: Math.floor(targetTabId), lease: lease,
              params: Object.assign({}, params), beforeMetrics: metricsArrayToObject(metrics.metrics || []),
              captureStartedAt: Date.now(), prestartedTrace: await startCdpTrace(captureSend, Math.floor(targetTabId), params),
            };
            ensureNotAborted(params.signal);
            performanceCaptures[captureToken] = state;
            if (params.signal && typeof params.signal.addEventListener === 'function') {
              state.abortSignal = params.signal;
              state.abortListener = function () {
                if (performanceCaptures[captureToken] !== state) return;
                delete performanceCaptures[captureToken];
                releasePerformanceCapture(state).catch(function () {});
              };
              params.signal.addEventListener('abort', state.abortListener, { once: true });
            }
            return { captureToken: captureToken, tabId: state.tabId, capturedAt: new Date(state.captureStartedAt).toISOString(), evidenceSource: 'CdpTools.performance_capture_start' };
          } catch (error) {
            // The trace is started before the capture state is published. If
            // cancellation (or any later setup failure) happens in that
            // window, releasing the lease alone would leave Tracing active
            // and poison the next performance capture on this tab.
            if (state && state.prestartedTrace) {
              await releasePerformanceCapture(state).catch(function () {});
            } else {
              await lease.release().catch(function () {});
            }
            throw error;
          }
        });
      }
      if (cdpCommand === 'performance_capture_finish') {
        var finishToken = String(params.captureToken || '');
        var capture = performanceCaptures[finishToken];
        if (!capture || capture.tabId !== Math.floor(targetTabId)) return Promise.reject(new Error('性能采样 captureToken 无效或已经结束'));
        delete performanceCaptures[finishToken];
        detachCaptureAbort(capture);
        if (params.cleanupOnly === true) {
          return releasePerformanceCapture(capture).then(function () {
            return envelope({ type: 'performance-capture-cleanup', captureToken: finishToken, released: true });
          });
        }
        var finishParams = Object.assign({}, capture.params, params, {
          reload: false,
          action: 'none',
          _prestartedTrace: capture.prestartedTrace,
          _beforeMetrics: capture.beforeMetrics,
          _captureStartedAt: capture.captureStartedAt,
          _unifiedActionResult: params.actionResult || { action: 'none' },
        });
        return analyzeCdpPerformance(capture.lease.send, capture.tabId, finishParams).then(function (analysis) {
          return envelope(Object.assign({ type: 'performance-analysis' }, pageDataContract.paginateValue(analysis, finishParams, 'cdp.analyze_performance', { dataKey: 'analysis' })));
        }).finally(function () { return releaseCaptureLease(capture); });
      }
      return tabPromise.then(function (tabId) {
        addLog('CDP 调试命令: cdp.' + cdpCommand + ' tabId=' + tabId, { scope: 'mcp', tabId: tabId });
        return sessions.withLease(tabId, { owner: 'CdpTools:' + cdpCommand, type: 'raw-cdp', signal: params.signal || null }, function (send) {
          send = signalSender(send, params.signal);
          if (cdpCommand === 'inspect_network') {
            return send('Network.enable', { maxTotalBufferSize: 10485760, maxResourceBufferSize: 1048576 }).then(function () {
              return abortableDelay(Math.max(0, Math.min(10000, Number(params.listenMs) || 1000)), params.signal);
            }).then(function () {
              var entries = getCdpNetworkEntries(tabId, Object.assign({}, params, { limit: 200 }));
              if (!params.includeBody) return entries;
              return Promise.all(entries.map(function (entry) {
                if (!entry || !entry.requestId || entry.failed) return entry;
                return send('Network.getResponseBody', { requestId: entry.requestId }, 5000).then(function (body) {
                  entry.responseBody = body && body.base64Encoded
                    ? '[base64:' + String(body.body || '').length + ' chars]'
                    : String((body && body.body) || '');
                  return entry;
                });
              }));
            }).then(function (entries) {
              var page = pageDataContract.paginateItems(entries, params, 'cdp.inspect_network', { dataKey: 'entries' });
              return envelope(Object.assign({
                type: 'network-log',
                capturedBy: 'CDP Network',
                totalCount: entries.length,
                returnedCount: page.entries.length,
                note: 'CDP 只能返回启用 Network 域后捕获的请求；首次调用可能需要再次触发页面请求。',
              }, page));
            });
          }

          if (cdpCommand === 'javascript_source') {
            var scriptUrl = String(params.scriptUrl || '');
            var scriptIndex = params.scriptIndex;
            function waitForDebuggerScripts() {
              return abortableDelay(150, params.signal);
            }
            function findScriptEntry(target, entries) {
              if (!target || !target.src) return null;
              var src = target.src;
              for (var i = entries.length - 1; i >= 0; i--) {
                if (entries[i] && entries[i].url === src) return entries[i];
              }
              for (var j = entries.length - 1; j >= 0; j--) {
                var entry = entries[j];
                if (entry && entry.url && (entry.url.indexOf(src) !== -1 || src.indexOf(entry.url) !== -1)) return entry;
              }
              return null;
            }
            return send('Debugger.enable', {}).then(function () {
              return waitForDebuggerScripts();
            }).then(function () {
              return send('Runtime.evaluate', {
                expression: '(function(){return Array.prototype.slice.call(document.scripts||[]).map(function(s,i){return {index:i,src:s.src||"",inlineChars:s.src?0:(s.textContent||"").length};});})()',
                returnByValue: true,
              });
            }).then(function (res) {
              if (res.exceptionDetails) throw res.exceptionDetails;
              var scripts = (res.result && res.result.value) || [];
              var target = null;
              if (scriptUrl) {
                target = scripts.filter(function (s) { return s && (s.src === scriptUrl || s.src.indexOf(scriptUrl) !== -1); })[0] || null;
              } else if (scriptIndex !== null && scriptIndex !== undefined) {
                target = scripts[Number(scriptIndex)] || null;
              }
              if (!target) throw new Error('未找到脚本');
              if (!target.src) {
                return send('Runtime.evaluate', {
                  expression: '(function(i){var s=(document.scripts||[])[i];return s?(s.textContent||""):"";})(' + JSON.stringify(Number(target.index) || 0) + ')',
                  returnByValue: true,
                }).then(function (inlineRes) {
                  if (inlineRes.exceptionDetails) throw inlineRes.exceptionDetails;
                  var inline = String((inlineRes.result && inlineRes.result.value) || '');
                  return envelope(Object.assign(
                    { kind: 'inline-script', scriptIndex: target.index, totalChars: inline.length, sourceProvider: 'Runtime.evaluate(document.scripts)' },
                    pageDataContract.paginateText(inline, params, 'cdp.javascript_source', 'source')
                  ));
                });
              }
              var entry = findScriptEntry(target, getCdpScriptEntries(tabId));
              if (!entry) throw new Error('CDP 未找到已加载脚本记录: ' + target.src);
              return send('Debugger.getScriptSource', { scriptId: entry.scriptId }).then(function (srcRes) {
                var source = String(srcRes.scriptSource || '');
                if (!source) throw new Error('CDP 未返回脚本源码: ' + target.src);
                return envelope(Object.assign(
                  { kind: 'remote-script', url: target.src, scriptIndex: target.index, scriptId: entry.scriptId, totalChars: source.length, sourceProvider: 'Debugger.getScriptSource' },
                  pageDataContract.paginateText(source, params, 'cdp.javascript_source', 'source')
                ));
              });
            });
          }

          if (cdpCommand === 'search_script_sources') {
            var query = String(params.query || '');
            if (!query) throw new Error('search_script_sources 需要 query');
            var regex = !!params.regex;
            var caseSensitive = !!params.caseSensitive;
            var contextChars = Math.max(20, Math.min(500, Number(params.contextChars) || 160));
            var windowSpec = pageDataContract.normalizeWindow(params, 'cdp.search_script_sources');
            var requestedStart = windowSpec.start;
            var includeInline = params.includeInline !== false;
            var maxSourceChars = Math.max(10000, Math.min(2000000, Number(params.maxSourceChars) || 500000));
            function waitForDebuggerScripts() {
              return abortableDelay(150, params.signal);
            }
            function makeMatcher() {
              if (regex) return new RegExp(query, caseSensitive ? 'g' : 'gi');
              return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
            }
            function snippet(text, index, length) {
              var start = Math.max(0, index - contextChars);
              var end = Math.min(text.length, index + length + contextChars);
              return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
            }
            return send('Debugger.enable', {}).then(function () {
              return waitForDebuggerScripts();
            }).then(function () {
              return send('Runtime.evaluate', {
                expression: '(function(){return Array.prototype.slice.call(document.scripts||[]).map(function(s,i){return {index:i,src:s.src||"",type:s.type||"",inline:s.src?"":(s.textContent||"")};});})()',
                returnByValue: true,
              });
            }).then(function (res) {
              if (res.exceptionDetails) throw res.exceptionDetails;
              var documentScripts = (res.result && res.result.value) || [];
              var entries = getCdpScriptEntries(tabId);
              var matches = [];
              var skippedChars = 0;
              var startMatched = requestedStart === 0;
              var appliedStart = 0;
              var matchLimitReached = false;
              var totalScannedMatches = 0;
              var scanned = 0;
              var skippedLarge = 0;
              var chain = Promise.resolve();
              documentScripts.forEach(function (script) {
                chain = chain.then(function () {
                  if (matchLimitReached) return null;
                  var textPromise;
                  if (script.src) {
                    var entry = null;
                    for (var k = entries.length - 1; k >= 0; k--) {
                      if (entries[k] && entries[k].url === script.src) { entry = entries[k]; break; }
                    }
                    if (!entry) {
                      for (var m = entries.length - 1; m >= 0; m--) {
                        var candidate = entries[m];
                        if (candidate && candidate.url && (candidate.url.indexOf(script.src) !== -1 || script.src.indexOf(candidate.url) !== -1)) {
                          entry = candidate;
                          break;
                        }
                      }
                    }
                    if (!entry) return null;
                    textPromise = send('Debugger.getScriptSource', { scriptId: entry.scriptId }).then(function (srcRes) {
                      var source = String(srcRes.scriptSource || '');
                      if (source.length > maxSourceChars) {
                        skippedLarge += 1;
                        source = source.slice(0, maxSourceChars);
                      }
                      return { text: source, scriptId: entry.scriptId };
                    });
                  } else if (includeInline) {
                    textPromise = Promise.resolve({ text: String(script.inline || ''), scriptId: '' });
                  } else {
                    return null;
                  }
                  return textPromise.then(function (payload) {
                    if (!payload || !payload.text) return null;
                    scanned += 1;
                    var matcher = makeMatcher();
                    var found;
                    while (!matchLimitReached && (found = matcher.exec(payload.text))) {
                      var match = {
                        where: { type: 'script-source', scriptIndex: script.index, src: script.src || '', scriptId: payload.scriptId || '' },
                        scriptIndex: script.index,
                        src: script.src || '',
                        type: script.type || '',
                        scriptId: payload.scriptId || '',
                        match: snippet(payload.text, found.index, found[0].length),
                        matchOffset: found.index,
                        remote: !!script.src,
                      };
                      totalScannedMatches += 1;
                      if (!startMatched) {
                        var nextSkippedChars = skippedChars + pageDataContract.itemCharacterSpan(match, 'cdp.search_script_sources');
                        if (!Number.isSafeInteger(nextSkippedChars)) {
                          throw new pageDataContract.ContractError('cdp.search_script_sources character boundary exceeds the safe integer range');
                        }
                        if (nextSkippedChars < requestedStart) {
                          skippedChars = nextSkippedChars;
                        } else if (nextSkippedChars === requestedStart) {
                          skippedChars = nextSkippedChars;
                          appliedStart = requestedStart;
                          startMatched = true;
                        } else {
                          appliedStart = skippedChars;
                          startMatched = true;
                          matches.push(match);
                          if (matches.length > pageDataContract.INTERNAL_SCAN_LIMIT) matchLimitReached = true;
                        }
                      } else {
                        matches.push(match);
                        if (matches.length > pageDataContract.INTERNAL_SCAN_LIMIT) matchLimitReached = true;
                      }
                      if (!regex || found[0] === '') break;
                    }
                    return null;
                  });
                });
              });
              return chain.then(function () {
                if (!startMatched) appliedStart = skippedChars;
                var resultPage = pageDataContract.paginateItems(matches, {
                  start: 0,
                  maxChars: windowSpec.maxChars,
                }, 'cdp.search_script_sources', { dataKey: 'matches', sourceTruncated: matchLimitReached });
                resultPage.start = appliedStart;
                if (resultPage.nextStart !== null) resultPage.nextStart += appliedStart;
                resultPage.hasMore = resultPage.nextStart !== null;
                resultPage.truncated = appliedStart > 0 || resultPage.truncated;
                return envelope(Object.assign({
                  type: 'script-source-search',
                  query: query,
                  regex: regex,
                  scannedScripts: scanned,
                  skippedLargeScripts: skippedLarge,
                  totalScannedMatches: totalScannedMatches,
                  sourceProvider: 'Debugger.getScriptSource',
                }, resultPage));
              });
            });
          }

          if (cdpCommand === 'analyze_performance') {
            return analyzeCdpPerformance(send, tabId, params).then(function (analysis) {
              return envelope(Object.assign(
                { type: 'performance-analysis' },
                pageDataContract.paginateValue(analysis, params, 'cdp.analyze_performance', { dataKey: 'analysis' })
              ));
            });
          }

          throw new Error('未知 CDP 命令: ' + cdpCommand);
        });
      });
    }

    function clearTab(tabId) {
      tabId = Math.floor(Number(tabId));
      delete networkLogs[tabId];
      delete scriptLogs[tabId];
      var retainedTraceCleanup = false;
      Object.keys(performanceCaptures).forEach(function (token) {
        var capture = performanceCaptures[token];
        if (!capture || capture.tabId !== Math.floor(Number(tabId))) return;
        delete performanceCaptures[token];
        if (capture.prestartedTrace && traceSessions[capture.tabId] === capture.prestartedTrace) retainedTraceCleanup = true;
        releasePerformanceCapture(capture).catch(function () {});
      });
      if (!retainedTraceCleanup) {
        var session = traceSessions[tabId];
        if (!session) return;
        var stopTracing;
        try {
          stopTracing = typeof session.cleanupSend === 'function'
            ? session.cleanupSend('Tracing.end', {})
            : Promise.resolve();
        } catch (_) { stopTracing = Promise.resolve(); }
        Promise.resolve(stopTracing).catch(function () {}).then(function () {
          if (traceSessions[tabId] === session) delete traceSessions[tabId];
        });
      }
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      supports: function (kind) {
        return /^cdp\.(?:inspect_network|javascript_source|search_script_sources|analyze_performance|network_entry|performance_capture_start|performance_capture_finish)$/.test(String(kind || ''));
      },
      perceive: function (tabId, kind, params) {
        if (String(kind || '') === 'cdp.network_entry') {
          var bucket = networkLogs[Math.floor(Number(tabId))] || { byId: {} };
          var entry = bucket.byId[String(params && params.entryId || '')];
          return entry ? Object.assign({}, entry, {
            requestHeaders: Object.assign({}, entry.requestHeaders || {}),
            responseHeaders: Object.assign({}, entry.responseHeaders || {}),
          }) : null;
        }
        return collectEvidence(String(kind || '').replace(/^cdp\./, ''), Object.assign({}, params || {}, { tabId: Math.floor(Number(tabId)) }));
      },
      recordNetworkEvent: recordCdpNetworkEvent,
      recordScriptEvent: recordCdpScriptEvent,
      recordTraceEvent: recordCdpTraceEvent,
      pageHostMatchesTab: pageHostMatchesTab,
      clearTab: clearTab,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, createCdpTools: createCdpTools });
});
