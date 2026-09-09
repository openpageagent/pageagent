// PageReadinessBarrier: state-change based completion for Flow page actions
// and navigations. It observes three independent facts and only reports
// "ready" when every enabled barrier is satisfied inside the caller's deadline:
//   - CDP Network events (fed from background.js chrome.debugger.onEvent),
//     classified as blocking (Document/Fetch/XHR), persistent (WebSocket/SSE)
//     or ignored;
//   - an idempotent in-page MutationObserver installed through
//     Runtime.evaluate in a private isolated world per frame;
//   - main/action frame navigation identity (url, loaderId, documentId).
// Only counts, timestamps and reasons are recorded. Request bodies, headers
// and URLs of individual requests are never stored here.
(function attachPageReadinessBarrier(root, factory) {
  'use strict';
  var api = factory(root && root.PageFactContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageReadinessBarrier = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (factContract) {
  'use strict';
  var API_VERSION = 1;
  var DEFAULTS = Object.freeze({
    network: true,
    domStable: true,
    navigation: true,
    requireEffect: false,
    networkIdleMs: 500,
    domStableMs: 300,
    pollIntervalMs: 75,
  });
  var FLOW_DEFAULTS = Object.freeze({ network: false, domStable: true, navigation: true, requireEffect: false });
  var SOFT_TIMEOUT_MS = 1500;
  var NETWORK_IDLE_MIN_MS = 50;
  var NETWORK_IDLE_MAX_MS = 10000;
  var DOM_STABLE_MIN_MS = 50;
  var DOM_STABLE_MAX_MS = 10000;
  var POLL_MIN_MS = 25;
  var POLL_MAX_MS = 1000;
  var TIMEOUT_MIN_MS = 100;
  var TIMEOUT_MAX_MS = 300000;
  var COMMAND_TIMEOUT_MS = 5000;
  var MAX_ENTRIES = 2000;
  var STALE_ENTRY_MS = 300000;
  var WORLD_NAME = 'page-automation-readiness';
  var BLOCKING_TYPES = /^(?:Document|Fetch|XHR)$/;
  var PERSISTENT_TYPES = /^(?:WebSocket|EventSource)$/;

  if (!factContract || typeof factContract.PageFactError !== 'function' || typeof factContract.hash !== 'function') {
    throw new Error('PageReadinessBarrier requires PageFactContract');
  }

  // Installed once per frame document inside a private isolated world. The
  // same expression reads the current state, so install and read are one
  // idempotent Runtime.evaluate. Only counters and timestamps leave the page.
  function pageTracker() {
    // This function is serialized into an isolated world; all dependencies
    // used by its observer must be declared inside it.
    var importantAttributes = {
      'class': true, style: true, id: true, hidden: true, disabled: true, open: true,
      selected: true, checked: true, value: true,
    };
    var w = window;
    var existing = w.__pfaReadinessTracker;
    var t = existing && existing.version === 2 && existing.document === document ? existing : null;
    if (!t) {
      if (existing) {
        if (existing.observer) existing.observer.disconnect();
        if (existing.noteHref) {
          w.removeEventListener('popstate', existing.noteHref, true);
          w.removeEventListener('hashchange', existing.noteHref, true);
        }
      }
      t = {
        version: 2,
        document: document,
        token: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
        installedAt: Date.now(),
        mutationSequence: 0,
        lastMutationAt: 0,
        historySequence: 0,
        lastHistoryAt: 0,
        lastHref: location.href,
        observer: null,
        observing: false,
        observerError: '',
      };
      var isExtensionUi = function (node) {
        var element = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
        while (element && element.nodeType === 1) {
          if (element.hasAttribute && element.hasAttribute('data-page-automation-ui')) return true;
          element = element.parentElement;
        }
        return false;
      };
      var significant = function (record) {
        if (isExtensionUi(record.target)) return false;
        if (record.type === 'attributes') {
          var attributeName = String(record.attributeName || '').toLowerCase();
          if (!importantAttributes[attributeName]
              && !/^aria-(?:busy|checked|current|disabled|expanded|hidden|pressed|selected|value)/.test(attributeName)) return false;
        }
        if (record.type === 'childList') {
          var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
          if (nodes.length && nodes.every(isExtensionUi)) return false;
        }
        return true;
      };
      var noteHref = function () {
        var href = location.href;
        if (href === t.lastHref) return;
        t.lastHref = href;
        t.historySequence += 1;
        t.lastHistoryAt = Date.now();
      };
      try {
        t.observer = new MutationObserver(function (records) {
          try {
            var counted = 0;
            for (var index = 0; index < records.length; index += 1) {
              if (significant(records[index])) counted += 1;
            }
            if (counted) {
              t.mutationSequence += counted;
              t.lastMutationAt = Date.now();
            }
            noteHref();
          } catch (error) {
            t.observerError = String(error && error.message || error);
            t.observing = false;
            t.observer.disconnect();
          }
        });
        t.observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
        t.observing = true;
      } catch (error) {
        t.observerError = String(error && error.message || error);
      }
      try {
        w.addEventListener('popstate', noteHref, true);
        w.addEventListener('hashchange', noteHref, true);
      } catch (_) {}
      t.noteHref = noteHref;
      try {
        Object.defineProperty(w, '__pfaReadinessTracker', { value: t, configurable: true, enumerable: false, writable: true });
      } catch (_) {
        w.__pfaReadinessTracker = t;
      }
    }
    if (typeof t.noteHref === 'function') t.noteHref();
    var now = Date.now();
    var lastActivityAt = Math.max(Number(t.lastMutationAt) || 0, Number(t.installedAt) || 0);
    return {
      installed: true,
      token: String(t.token || ''),
      installedAt: Number(t.installedAt) || 0,
      mutationSequence: Number(t.mutationSequence) || 0,
      lastMutationAt: Number(t.lastMutationAt) || 0,
      quietMs: Math.max(0, now - lastActivityAt),
      historySequence: Number(t.historySequence) || 0,
      lastHistoryAt: Number(t.lastHistoryAt) || 0,
      url: String(location.href || ''),
      readyState: String(document.readyState || ''),
      observing: t.observing === true,
      observerError: String(t.observerError || ''),
      now: now,
    };
  }
  var TRACKER_EXPRESSION = '(' + String(pageTracker) + ')()';

  function clampNumber(value, fallback, min, max) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallback;
    return Math.max(min, Math.min(max, number));
  }
  function booleanOption(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return fallback;
    if (/^(?:true|yes|1|on)$/i.test(String(value))) return true;
    if (/^(?:false|no|0|off)$/i.test(String(value))) return false;
    return fallback;
  }
  // params.readiness → normalized barrier options. Returns null when the
  // barrier is explicitly disabled (false / "false").
  function normalizeOptions(raw) {
    if (raw === false) return null;
    if (typeof raw === 'string') {
      var text = raw.trim();
      if (!text) raw = undefined;
      else if (/^(?:false|0|off|no)$/i.test(text)) return null;
      else if (/^(?:true|1|on|yes)$/i.test(text)) raw = true;
      else {
        try { raw = JSON.parse(text); } catch (_) { raw = undefined; }
        if (raw === false) return null;
      }
    }
    var input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      network: booleanOption(input.network, DEFAULTS.network),
      domStable: booleanOption(input.domStable, DEFAULTS.domStable),
      navigation: booleanOption(input.navigation, DEFAULTS.navigation),
      requireEffect: booleanOption(input.requireEffect, DEFAULTS.requireEffect),
      networkIdleMs: Math.floor(clampNumber(input.networkIdleMs, DEFAULTS.networkIdleMs, NETWORK_IDLE_MIN_MS, NETWORK_IDLE_MAX_MS)),
      domStableMs: Math.floor(clampNumber(input.domStableMs, DEFAULTS.domStableMs, DOM_STABLE_MIN_MS, DOM_STABLE_MAX_MS)),
      pollIntervalMs: Math.floor(clampNumber(input.pollIntervalMs, DEFAULTS.pollIntervalMs, POLL_MIN_MS, POLL_MAX_MS)),
    };
  }
  function classify(type) {
    type = String(type || '');
    if (BLOCKING_TYPES.test(type)) return 'blocking';
    if (PERSISTENT_TYPES.test(type)) return 'persistent';
    return 'ignored';
  }
  function iso(ms) { return ms > 0 ? new Date(ms).toISOString() : null; }
  function documentIdFor(tabId, frameId, loaderId) {
    return 'document_' + factContract.hash([tabId, frameId, loaderId].join(':'));
  }
  function errorText(error) { return String(error && error.message || error || ''); }
  function exceptionText(details) {
    if (!details) return '页面就绪观察器执行异常';
    var exception = details.exception || {};
    return String(exception.description || exception.value || details.text || '页面就绪观察器执行异常');
  }
  function contextLost(error) {
    return /cannot find context|context.*destroyed|execution context|navigated or closed|no frame for given id|target closed|uniquecontextid/i.test(errorText(error));
  }
  function transportGone(error) {
    return /lease is no longer active|no tab with given id|cannot access|tab was closed/i.test(errorText(error));
  }
  function flattenFrameTree(tree) {
    var frames = [];
    (function visit(node) {
      if (!node || !node.frame) return;
      frames.push({
        id: String(node.frame.id || ''),
        parentId: String(node.frame.parentId || ''),
        loaderId: String(node.frame.loaderId || ''),
        url: String(node.frame.url || '') + String(node.frame.urlFragment || ''),
      });
      (node.childFrames || []).forEach(visit);
    })(tree);
    return frames;
  }

  function createPageReadinessBarrier(deps) {
    deps = deps || {};
    var sessions = deps.cdpSessionManager;
    var verification = deps.pageVerificationEngine;
    var addLog = typeof deps.addLog === 'function' ? deps.addLog : null;
    if (!sessions || typeof sessions.acquire !== 'function' || typeof sessions.withLease !== 'function' || typeof sessions.getState !== 'function') {
      throw new Error('PageReadinessBarrier requires CdpSessionManager');
    }
    if (!verification || typeof verification.verifyExpectation !== 'function') {
      throw new Error('PageReadinessBarrier requires PageVerificationEngine.verifyExpectation');
    }
    var tabs = new Map();

    function stateFor(tabId) {
      tabId = Math.floor(Number(tabId));
      var state = tabs.get(tabId);
      if (!state) {
        state = {
          tabId: tabId,
          generation: -1,
          rootEnabled: false,
          enablePromise: null,
          enabledAt: 0,
          enabledSessions: Object.create(null),
          sequence: 0,
          entries: new Map(),
          activity: new Map(),
          lastBlockingStart: 0,
          lastBlockingFinish: 0,
          lastWsMessage: 0,
          lastSseEvent: 0,
          wsMessages: 0,
          sseEvents: 0,
          contexts: new Map(),
          networkCoverageKnown: false,
        };
        tabs.set(tabId, state);
      }
      return state;
    }
    function resetTransport(state) {
      state.rootEnabled = false;
      state.enablePromise = null;
      state.enabledAt = 0;
      state.enabledSessions = Object.create(null);
      state.sequence = 0;
      state.entries.clear();
      state.activity.clear();
      state.contexts.clear();
      state.lastBlockingStart = 0;
      state.lastBlockingFinish = 0;
      state.lastWsMessage = 0;
      state.lastSseEvent = 0;
      state.wsMessages = 0;
      state.sseEvents = 0;
      state.networkCoverageKnown = false;
    }
    function currentGeneration(tabId) {
      var state = sessions.getState(tabId);
      return state ? Number(state.generation) || 0 : 0;
    }
    if (typeof sessions.onDetach === 'function') {
      sessions.onDetach(function (event) {
        var state = event && tabs.get(Number(event.tabId));
        if (!state) return;
        // Network events emitted while the debugger was away are lost, so any
        // in-flight bookkeeping from the previous transport is unknowable.
        resetTransport(state);
        state.generation = -1;
      });
    }
    function clearTab(tabId) {
      tabs.delete(Math.floor(Number(tabId)));
    }

    // --- Network tracker -------------------------------------------------
    function requestKey(sessionId, requestId) {
      return String(sessionId || 'root') + '\u0000' + String(requestId || '');
    }
    function activityKey(entry) {
      if (entry.frameId) return entry.frameId;
      return entry.sessionId ? 'session:' + entry.sessionId : 'root';
    }
    function touch(state, entry, now, phase) {
      var key = activityKey(entry);
      var record = state.activity.get(key);
      if (!record) {
        record = { lastStart: 0, lastFinish: 0, lastActivity: 0 };
        state.activity.set(key, record);
      }
      if (phase === 'start') record.lastStart = now;
      if (phase === 'finish') record.lastFinish = now;
      record.lastActivity = now;
    }
    function bump(state, now) {
      state.sequence += 1;
      state.lastEventAt = now;
    }
    function trimEntries(state, now) {
      if (state.entries.size <= MAX_ENTRIES) return;
      var overflow = state.entries.size - MAX_ENTRIES;
      var iterator = state.entries.keys();
      while (overflow > 0) {
        var next = iterator.next();
        if (next.done) break;
        state.entries.delete(next.value);
        overflow -= 1;
      }
    }
    function recordNetworkEvent(tabId, method, params, source) {
      tabId = Math.floor(Number(tabId));
      if (!(tabId > 0) || typeof method !== 'string' || method.indexOf('Network.') !== 0) return;
      var state = stateFor(tabId);
      params = params || {};
      var now = Date.now();
      var requestId = String(params.requestId || '');
      var sessionId = String(source && source.sessionId || '');
      var key = requestKey(sessionId, requestId);
      var entry;
      switch (method) {
        case 'Network.requestWillBeSent': {
          if (!requestId) return;
          var type = String(params.type || '');
          var category = classify(type);
          entry = state.entries.get(key);
          if (!entry) {
            entry = { key: key, requestId: requestId, category: category, type: type, frameId: String(params.frameId || ''), loaderId: String(params.loaderId || ''), sessionId: sessionId, startedAt: now, updatedAt: now };
            state.entries.set(key, entry);
            trimEntries(state, now);
          } else {
            // Redirect: same request identity, still in flight.
            entry.type = type;
            entry.category = category;
            if (params.frameId) entry.frameId = String(params.frameId);
            if (params.loaderId) entry.loaderId = String(params.loaderId);
            entry.sessionId = sessionId;
            entry.updatedAt = now;
          }
          bump(state, now);
          if (entry.category === 'blocking') {
            state.lastBlockingStart = now;
            touch(state, entry, now, 'start');
          }
          return;
        }
        case 'Network.responseReceived': {
          bump(state, now);
          entry = requestId ? state.entries.get(key) : null;
          if (!entry) return;
          entry.updatedAt = now;
          var mimeType = String(params.response && params.response.mimeType || '').toLowerCase();
          if (entry.category === 'blocking' && mimeType.indexOf('text/event-stream') === 0) {
            // A streaming fetch used as SSE never finishes; it must not block.
            entry.category = 'persistent';
            entry.type = 'EventSource';
            state.lastBlockingFinish = now;
            touch(state, entry, now, 'finish');
          } else if (entry.category === 'blocking') {
            touch(state, entry, now, 'response');
          }
          return;
        }
        case 'Network.loadingFinished':
        case 'Network.loadingFailed': {
          bump(state, now);
          entry = requestId ? state.entries.get(key) : null;
          if (!entry) return;
          state.entries.delete(key);
          if (entry.category === 'blocking') {
            state.lastBlockingFinish = now;
            touch(state, entry, now, 'finish');
          }
          return;
        }
        case 'Network.webSocketCreated': {
          if (!requestId) return;
          bump(state, now);
          state.entries.set(key, { key: key, requestId: requestId, category: 'persistent', type: 'WebSocket', frameId: '', loaderId: '', sessionId: sessionId, startedAt: now, updatedAt: now });
          trimEntries(state, now);
          return;
        }
        case 'Network.webSocketClosed': {
          bump(state, now);
          if (requestId) state.entries.delete(key);
          return;
        }
        case 'Network.webSocketFrameReceived':
        case 'Network.webSocketFrameSent': {
          bump(state, now);
          state.lastWsMessage = now;
          state.wsMessages += 1;
          entry = requestId ? state.entries.get(key) : null;
          if (entry) entry.updatedAt = now;
          return;
        }
        case 'Network.eventSourceMessageReceived': {
          bump(state, now);
          state.lastSseEvent = now;
          state.sseEvents += 1;
          entry = requestId ? state.entries.get(key) : null;
          if (entry) entry.updatedAt = now;
          return;
        }
        case 'Network.webSocketFrameError':
        case 'Network.webSocketWillSendHandshakeRequest':
        case 'Network.webSocketHandshakeResponseReceived':
          bump(state, now);
          return;
        default:
          return;
      }
    }
    // Requests are attributed to a frame set. Root-session requests without a
    // frame belong to the main document; child-target requests without a
    // confirmable frame never block another frame.
    function inScope(entry, scope) {
      if (entry.frameId) {
        if (scope.frameIds.indexOf(entry.frameId) === -1) return false;
        var currentLoader = scope.loaders[entry.frameId];
        if (currentLoader && entry.loaderId && entry.loaderId !== currentLoader && entry.type !== 'Document') return false;
        return true;
      }
      return !entry.sessionId;
    }
    function networkSnapshot(state, scope, now) {
      var blocking = 0;
      var persistent = 0;
      var documents = 0;
      var inherited = 0;
      var blockingKeys = [];
      var baselineKeys = Object.create(null);
      (scope.baselineBlockingKeys || []).forEach(function (key) { baselineKeys[String(key)] = true; });
      state.entries.forEach(function (entry, requestId) {
        if (now - entry.updatedAt > STALE_ENTRY_MS) {
          state.entries.delete(requestId);
          return;
        }
        if (!inScope(entry, scope)) return;
        if (entry.category === 'blocking') {
          var key = entry.key || requestKey(entry.sessionId, entry.requestId);
          if (baselineKeys[key]) {
            inherited += 1;
          }
          blocking += 1;
          blockingKeys.push(key);
          if (entry.type === 'Document') documents += 1;
        } else if (entry.category === 'persistent') {
          persistent += 1;
        }
      });
      var lastActivityAt = 0;
      var lastStart = 0;
      var lastFinish = 0;
      var keys = scope.frameIds.concat(['root']);
      keys.forEach(function (key) {
        var record = state.activity.get(key);
        if (!record) return;
        lastActivityAt = Math.max(lastActivityAt, record.lastActivity);
        lastStart = Math.max(lastStart, record.lastStart);
        lastFinish = Math.max(lastFinish, record.lastFinish);
      });
      return {
        sequence: state.sequence,
        blocking: blocking,
        persistent: persistent,
        documents: documents,
        inheritedBlocking: inherited,
        blockingKeys: blockingKeys,
        lastActivityAt: lastActivityAt,
        lastBlockingStart: lastStart || state.lastBlockingStart,
        lastBlockingFinish: lastFinish || state.lastBlockingFinish,
        lastWsMessage: state.lastWsMessage,
        lastSseEvent: state.lastSseEvent,
        wsMessages: state.wsMessages,
        sseEvents: state.sseEvents,
        enabled: state.rootEnabled,
        enabledAt: state.enabledAt,
      };
    }

    // --- CDP access ------------------------------------------------------
    function deadlineBudget(deadline, parentSignal) {
      var controller = new AbortController();
      function expire() {
        controller.abort(new factContract.PageFactError('PAGE_READINESS_TIMEOUT', '页面就绪等待超过时限'));
      }
      function onAbort() { controller.abort(cancellation(parentSignal)); }
      if (parentSignal && parentSignal.aborted) onAbort();
      else if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
      var timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
      function check() {
        if (!controller.signal.aborted && Date.now() >= deadline) expire();
        ensureNotAborted(controller.signal);
      }
      return {
        signal: controller.signal,
        check: check,
        call: function (factory) {
          return new Promise(function (resolve, reject) {
            var settled = false;
            function finish(error, value) {
              if (settled) return;
              settled = true;
              controller.signal.removeEventListener('abort', aborted);
              if (error) reject(error);
              else resolve(value);
            }
            function aborted() { finish(cancellation(controller.signal)); }
            controller.signal.addEventListener('abort', aborted, { once: true });
            try {
              check();
              Promise.resolve(factory()).then(function (value) {
                try { check(); finish(null, value); }
                catch (error) { finish(error); }
              }, function (error) { finish(error); });
            } catch (error) { finish(error); }
          });
        },
        close: function () {
          clearTimeout(timer);
          if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
        },
      };
    }
    async function withObservationSession(tabId, options, deadline, task) {
      var budget = deadlineBudget(deadline, options.signal);
      var lease = null;
      try {
        var cdp;
        if (options.send) cdp = adaptSender(options.send);
        else {
          lease = await budget.call(function () {
            return sessions.acquire(tabId, { owner: 'PageReadinessBarrier', type: 'short', signal: budget.signal }).then(function (acquired) {
              // Acquisition may finish after the advisory wait has expired.
              if (budget.signal.aborted) {
                acquired.release().catch(function () {});
                throw cancellation(budget.signal);
              }
              lease = acquired;
              return acquired;
            });
          });
          cdp = adaptLease(lease);
        }
        function bounded(send) {
          return function (method, params, timeoutMs) {
            return budget.call(function () {
              return send(method, params, Math.min(Number(timeoutMs) || COMMAND_TIMEOUT_MS, commandTimeout(deadline)));
            });
          };
        }
        return await budget.call(function () {
          return task({
            root: bounded(cdp.root),
            frame: function (frameId) { return bounded(cdp.frame(frameId)); },
            routeFor: cdp.routeFor,
          }, budget);
        });
      } finally {
        budget.close();
        if (lease) { try { await lease.release(); } catch (_) {} }
      }
    }
    function adaptSender(send) {
      if (typeof send !== 'function') throw new Error('PageReadinessBarrier requires a CDP sender');
      return {
        root: function (method, params, timeoutMs) { return send(method, params || {}, timeoutMs); },
        frame: function (frameId) {
          return typeof send.forFrame === 'function' ? send.forFrame(String(frameId || '')) : send;
        },
        routeFor: function (frameId) {
          frameId = String(frameId || '');
          if (typeof send.getFrameRoute === 'function') return send.getFrameRoute(frameId) || null;
          var routes = typeof send.listFrameRoutes === 'function' ? send.listFrameRoutes() : [];
          return routes.find(function (route) { return route && route.frameId === frameId; }) || null;
        },
      };
    }
    function adaptLease(lease) {
      return {
        root: function (method, params, timeoutMs) { return lease.send(method, params || {}, timeoutMs); },
        frame: function (frameId) {
          frameId = String(frameId || '');
          return function (method, params, timeoutMs) { return lease.sendForFrame(frameId, method, params || {}, timeoutMs); };
        },
        routeFor: function (frameId) {
          frameId = String(frameId || '');
          var routes = typeof lease.listFrameRoutes === 'function' ? lease.listFrameRoutes() : [];
          return routes.find(function (route) { return route && route.frameId === frameId; }) || null;
        },
      };
    }
    function cancellation(signal) {
      if (signal && signal.reason instanceof Error) {
        var reason = signal.reason;
        try { reason.code = reason.code || 'ACTION_CANCELLED'; } catch (_) {}
        try { reason.performed = reason.performed || 'unknown'; } catch (_) {}
        try { reason.retryable = false; } catch (_) {}
        return reason;
      }
      var error = new factContract.PageFactError('ACTION_CANCELLED', '页面就绪等待已取消');
      error.performed = 'unknown';
      error.retryable = false;
      return error;
    }
    function transportUncertainError(tabId) {
      var error = new factContract.PageFactError('PAGE_READINESS_UNAVAILABLE',
        '本次等待期间 CDP 连接发生变化，页面状态观测存在缺口', {
          tabId: tabId,
          transportUncertain: true,
        });
      error.performed = 'unknown';
      error.retryable = false;
      return error;
    }
    function ensureNotAborted(signal) {
      if (signal && signal.aborted === true) throw cancellation(signal);
    }
    function delay(ms, signal) {
      return new Promise(function (resolve, reject) {
        if (signal && signal.aborted === true) { reject(cancellation(signal)); return; }
        var timer = setTimeout(function () { cleanup(); resolve(); }, Math.max(0, Number(ms) || 0));
        function cleanup() { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort); }
        function onAbort() { clearTimeout(timer); cleanup(); reject(cancellation(signal)); }
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    function commandTimeout(deadline) {
      var remaining = Number.isFinite(deadline) ? deadline - Date.now() : COMMAND_TIMEOUT_MS;
      return Math.max(1, Math.min(COMMAND_TIMEOUT_MS, Math.floor(remaining)));
    }
    function syncGeneration(state, tabId) {
      var generation = currentGeneration(tabId);
      if (state.generation !== generation) {
        // Preserve initial events captured by the session manager on attach.
        // Detach has already cleared the previous connection's state.
        if (state.generation >= 0) resetTransport(state);
        state.generation = generation;
      }
      return generation;
    }
    // Network.enable is issued once per debugger attach generation on the
    // root session, plus once per child session that routes an action frame.
    async function ensureNetworkEnabled(state, cdp, tabId, timeoutMs, frameIds) {
      var generation = syncGeneration(state, tabId);
      if (!state.rootEnabled) {
        if (!state.enablePromise) {
          state.enablePromise = Promise.resolve(cdp.root('Network.enable', {}, timeoutMs)).then(function () {
            if (state.generation !== generation || currentGeneration(tabId) !== generation) return;
            state.rootEnabled = true;
            state.enabledAt = Date.now();
            // A successful Network.enable establishes coverage for events
            // that occur from this point onward, even when the page is idle.
            state.networkCoverageKnown = true;
            state.enablePromise = null;
          }, function (error) {
            if (state.generation === generation) state.enablePromise = null;
            throw error;
          });
        }
        await state.enablePromise;
      }
      if (state.rootEnabled) state.networkCoverageKnown = true;
      if (state.generation !== currentGeneration(tabId)) throw transportUncertainError(tabId);
      var routed = Array.isArray(frameIds) ? frameIds : [];
      for (var index = 0; index < routed.length; index += 1) {
        var route = cdp.routeFor(routed[index]);
        var sessionId = route && route.sessionId ? String(route.sessionId) : '';
        if (!sessionId || state.enabledSessions[sessionId]) continue;
        await cdp.frame(routed[index])('Network.enable', {}, timeoutMs);
        state.enabledSessions[sessionId] = true;
      }
    }
    async function readFrames(cdp, timeoutMs) {
      var tree = await cdp.root('Page.getFrameTree', {}, timeoutMs);
      var frames = flattenFrameTree(tree && tree.frameTree);
      var main = frames.find(function (frame) { return !frame.parentId; }) || frames[0] || null;
      return { frames: frames, main: main };
    }
    async function locateFrame(cdp, tree, frameId, timeoutMs) {
      var record = tree.frames.find(function (frame) { return frame.id === frameId; }) || null;
      if (record && (record.loaderId || !cdp.routeFor(frameId))) return record;
      if (!cdp.routeFor(frameId)) return record;
      // Out-of-process frame: its own target owns the authoritative loader.
      try {
        var childTree = await cdp.frame(frameId)('Page.getFrameTree', {}, timeoutMs);
        var childMain = flattenFrameTree(childTree && childTree.frameTree).find(function (frame) { return frame.id === frameId; });
        if (childMain) return childMain;
      } catch (_) {}
      return record;
    }
    async function readTracker(cdp, state, frame, timeoutMs) {
      var frameId = frame.frameId;
      var send = frame.main ? cdp.root : cdp.frame(frameId);
      var cached = state.contexts.get(frameId) || null;
      if (cached && cached.generation !== state.generation) cached = null;
      if (cached && frame.loaderId && cached.loaderId && cached.loaderId !== frame.loaderId) cached = null;
      var attempt = 0;
      while (true) {
        attempt += 1;
        if (!cached) {
          var created = await send('Page.createIsolatedWorld', { frameId: frameId, worldName: WORLD_NAME, grantUniveralAccess: false }, timeoutMs);
          var contextId = Number(created && created.executionContextId) || 0;
          if (!contextId) throw new Error('无法为 frame 建立就绪观察上下文');
          cached = { loaderId: frame.loaderId || '', contextId: contextId, generation: state.generation };
          state.contexts.set(frameId, cached);
        }
        try {
          var evaluated = await send('Runtime.evaluate', { expression: TRACKER_EXPRESSION, contextId: cached.contextId, returnByValue: true }, timeoutMs);
          if (evaluated && evaluated.exceptionDetails) throw new Error(exceptionText(evaluated.exceptionDetails));
          var value = evaluated && evaluated.result && evaluated.result.value;
          if (!value || typeof value !== 'object') throw new Error('页面就绪观察器未返回状态');
          return value;
        } catch (error) {
          state.contexts.delete(frameId);
          cached = null;
          if (attempt >= 2 || !contextLost(error)) throw error;
        }
      }
    }
    // One observation: frame identities, per-frame DOM tracker state and the
    // scoped network snapshot. Frame-level tracker failures are reported, not
    // thrown; the caller decides whether that frame is required.
    async function observe(cdp, state, tabId, actionFrameId, since, baselineBlockingKeys, timeoutMs, signal) {
      ensureNotAborted(signal);
      var tree = await readFrames(cdp, timeoutMs);
      if (!tree.main || !tree.main.id) {
        throw new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '无法读取页面主 frame');
      }
      var frames = [{ frameId: tree.main.id, loaderId: tree.main.loaderId, url: tree.main.url, main: true, missing: false }];
      actionFrameId = String(actionFrameId || '');
      if (actionFrameId && actionFrameId !== tree.main.id) {
        var record = await locateFrame(cdp, tree, actionFrameId, timeoutMs);
        frames.push(record
          ? { frameId: actionFrameId, loaderId: record.loaderId, url: record.url, main: false, missing: false }
          : { frameId: actionFrameId, loaderId: '', url: '', main: false, missing: true });
      }
      var dom = {};
      var loaders = {};
      for (var index = 0; index < frames.length; index += 1) {
        var frame = frames[index];
        loaders[frame.frameId] = frame.loaderId;
        if (frame.missing) {
          dom[frame.frameId] = { observed: false, missing: true };
          continue;
        }
        ensureNotAborted(signal);
        try {
          dom[frame.frameId] = Object.assign({ observed: true, missing: false }, await readTracker(cdp, state, frame, timeoutMs));
        } catch (error) {
          if (signal && signal.aborted === true) throw cancellation(signal);
          if (transportGone(error)) throw error;
          dom[frame.frameId] = { observed: false, missing: false, error: errorText(error) };
        }
      }
      var now = Date.now();
      var frameIds = frames.map(function (frame) { return frame.frameId; });
      return {
        at: now,
        main: tree.main,
        frames: frames,
        frameIds: frameIds,
        dom: dom,
        network: networkSnapshot(state, { frameIds: frameIds, loaders: loaders, since: since, baselineBlockingKeys: baselineBlockingKeys || [] }, now),
      };
    }
    function frameUrl(observation, frame) {
      var tracker = observation.dom[frame.frameId];
      return tracker && tracker.observed && tracker.url ? tracker.url : String(frame.url || '');
    }
    function baselineFrom(tabId, observation, actionFrameId, state) {
      var main = observation.frames[0];
      var navigationFrames = {};
      var domFrames = {};
      observation.frames.forEach(function (frame) {
        var tracker = observation.dom[frame.frameId] || { observed: false };
        navigationFrames[frame.frameId] = { url: frameUrl(observation, frame), loaderId: frame.loaderId, missing: frame.missing === true };
        domFrames[frame.frameId] = {
          observed: tracker.observed === true,
          mutationSequence: Number(tracker.mutationSequence) || 0,
          lastMutationAt: Number(tracker.lastMutationAt) || 0,
          url: frameUrl(observation, frame),
          historySequence: Number(tracker.historySequence) || 0,
          token: String(tracker.token || ''),
          installedAt: Number(tracker.installedAt) || 0,
          error: tracker.error || '',
        };
      });
      var network = observation.network;
      return {
        tabId: tabId,
        generation: state.generation,
        timestamp: observation.at,
        frameId: String(actionFrameId || main.frameId),
        scope: observation.frameIds.slice(),
        navigation: {
          url: frameUrl(observation, main),
          frameId: main.frameId,
          loaderId: main.loaderId,
          documentId: documentIdFor(tabId, main.frameId, main.loaderId),
          frames: navigationFrames,
        },
        network: {
          sequence: network.sequence,
          blocking: network.blocking,
          blockingKeys: network.blockingKeys.slice(),
          persistent: network.persistent,
          lastBlockingStart: network.lastBlockingStart,
          lastBlockingFinish: network.lastBlockingFinish,
          lastWsMessage: network.lastWsMessage,
          lastSseEvent: network.lastSseEvent,
          wsMessages: network.wsMessages,
          sseEvents: network.sseEvents,
          enabled: network.enabled,
          coverageKnown: !!(state && state.networkCoverageKnown === true),
        },
        dom: { frames: domFrames },
      };
    }
    function baselineTimeout(deadline, timeoutMs) {
      if (Number.isFinite(Number(deadline)) && Number(deadline) > 0) return Number(deadline);
      var budget = clampNumber(timeoutMs, 10000, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
      return Date.now() + budget;
    }
    async function captureBaselineWith(cdp, tabId, options) {
      var state = stateFor(tabId);
      var deadline = baselineTimeout(options.deadline, options.timeoutMs);
      var actionFrameId = String(options.frameId || '');
      var since = Number(options.since) || 0;
      ensureNotAborted(options.signal);
      var generation = syncGeneration(state, tabId);
      var config = normalizeOptions(options.readiness) || FLOW_DEFAULTS;
      if (config.network) await ensureNetworkEnabled(state, cdp, tabId, commandTimeout(deadline), actionFrameId ? [actionFrameId] : []);
      var observation = await observe(cdp, state, tabId, actionFrameId, since, [], commandTimeout(deadline), options.signal);
      var mainTracker = observation.dom[observation.main.id];
      if (!mainTracker || mainTracker.observed !== true) {
        throw new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '无法安装页面就绪观察器: ' + String(mainTracker && mainTracker.error || '主 frame 不可用'), {
          frameId: observation.main.id,
        });
      }
      if (generation !== currentGeneration(tabId) || state.generation !== generation) {
        throw transportUncertainError(tabId);
      }
      return baselineFrom(tabId, observation, actionFrameId, state);
    }
    // captureBaseline(tabId, { send?, frameId?, signal?, timeoutMs?, deadline? })
    // With options.send (a lease sender already held by the caller) the
    // baseline is read inline; otherwise a short lease is acquired.
    function captureBaseline(tabId, options) {
      tabId = Math.floor(Number(tabId));
      options = options || {};
      if (!(tabId > 0)) return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面就绪基线需要有效 tabId'));
      var deadline = baselineTimeout(options.deadline, options.timeoutMs);
      return withObservationSession(tabId, options, deadline, function (cdp, budget) {
        return captureBaselineWith(cdp, tabId, Object.assign({}, options, { deadline: deadline, signal: budget.signal }));
      });
    }

    // --- Readiness evaluation --------------------------------------------
    function evaluateNavigation(tabId, baseline, observation, config) {
      var main = observation.frames[0];
      var tracker = observation.dom[main.frameId] || { observed: false };
      var baselineMain = baseline.dom.frames[main.frameId] || {};
      var url = frameUrl(observation, main);
      var documentId = documentIdFor(tabId, main.frameId, main.loaderId);
      var loaderChanged = !!(main.loaderId && baseline.navigation.loaderId && main.loaderId !== baseline.navigation.loaderId);
      var documentChanged = documentId !== baseline.navigation.documentId
        || !!(tracker.observed && baselineMain.token && tracker.token && tracker.token !== baselineMain.token);
      var frames = {};
      var anyUrlChanged = url !== baseline.navigation.url;
      var anyHistoryChanged = false;
      var settled = observation.network.documents === 0;
      observation.frames.forEach(function (frame) {
        var frameTracker = observation.dom[frame.frameId] || { observed: false };
        if ((frame.main || !frame.missing)
            && (!frameTracker.observed || frameTracker.readyState !== 'complete')) settled = false;
        var baselineFrame = baseline.navigation.frames[frame.frameId] || null;
        var baselineDom = baseline.dom.frames[frame.frameId] || null;
        var currentUrl = frameUrl(observation, frame);
        var urlChanged = !!(baselineFrame && !frame.missing && currentUrl !== baselineFrame.url);
        var sameDocument = !!(frameTracker.observed && baselineDom && baselineDom.token && frameTracker.token === baselineDom.token);
        var historyChanged = sameDocument && Number(frameTracker.historySequence) > Number(baselineDom.historySequence);
        if (urlChanged) anyUrlChanged = true;
        if (historyChanged) anyHistoryChanged = true;
        frames[frame.frameId] = {
          url: currentUrl,
          loaderId: frame.loaderId,
          missing: frame.missing === true,
          urlChanged: urlChanged,
          loaderChanged: !!(baselineFrame && frame.loaderId && baselineFrame.loaderId && frame.loaderId !== baselineFrame.loaderId),
          historyChanged: historyChanged,
          readyState: frameTracker.observed ? String(frameTracker.readyState || '') : '',
        };
      });
      return {
        frameId: main.frameId,
        url: url,
        loaderId: main.loaderId,
        documentId: documentId,
        readyState: tracker.observed ? String(tracker.readyState || '') : '',
        urlChanged: anyUrlChanged,
        loaderChanged: loaderChanged,
        documentChanged: documentChanged,
        historyChanged: anyHistoryChanged,
        settled: settled,
        required: config.navigation === true,
        frames: frames,
      };
    }
    function evaluateNetwork(baseline, observation, config, since, now) {
      var snapshot = observation.network;
      var blocking = Number(snapshot.blocking) || 0;
      var documents = Number(snapshot.documents) || 0;
      var inheritedBlocking = Number(snapshot.inheritedBlocking) || 0;
      var anchor = Math.max(snapshot.lastActivityAt, since, snapshot.enabledAt);
      var stableFor = Math.max(0, now - anchor);
      var coverageKnown = !!(baseline.network && baseline.network.coverageKnown === true);
      var stable = blocking === 0 && stableFor >= config.networkIdleMs && coverageKnown;
      return {
        blockingCount: blocking,
        persistentCount: snapshot.persistent,
        inheritedBlockingCount: inheritedBlocking,
        documentCount: documents,
        coverageKnown: coverageKnown,
        sequenceDelta: Math.max(0, snapshot.sequence - Number(baseline.network.sequence || 0)),
        stable: stable,
        stableFor: stableFor,
        idleWindowMs: config.networkIdleMs,
        enabled: snapshot.enabled,
        lastBlockingStart: snapshot.lastBlockingStart,
        lastBlockingFinish: snapshot.lastBlockingFinish,
        lastWsMessage: snapshot.lastWsMessage,
        lastSseEvent: snapshot.lastSseEvent,
        websocketMessages: Math.max(0, snapshot.wsMessages - Number(baseline.network.wsMessages || 0)),
        sseEvents: Math.max(0, snapshot.sseEvents - Number(baseline.network.sseEvents || 0)),
        required: config.network === true,
      };
    }
    function evaluateDom(baseline, observation, config, since, now) {
      var frames = {};
      var mutationDelta = 0;
      var stable = true;
      var stableFor = Number.POSITIVE_INFINITY;
      var observedFrames = 0;
      observation.frames.forEach(function (frame) {
        var tracker = observation.dom[frame.frameId] || { observed: false };
        var baselineDom = baseline.dom.frames[frame.frameId] || null;
        if (!tracker.observed || tracker.observing !== true || tracker.observerError) {
          // Only a genuinely removed action frame can leave the barrier.
          var required = frame.main || !frame.missing;
          if (required) stable = false;
          frames[frame.frameId] = {
            observed: tracker.observed === true, observing: tracker.observing === true,
            missing: frame.missing === true, error: tracker.error || tracker.observerError || '', required: required,
          };
          return;
        }
        observedFrames += 1;
        var sameDocument = !!(baselineDom && baselineDom.token && tracker.token === baselineDom.token);
        var delta = sameDocument
          ? Math.max(0, Number(tracker.mutationSequence) - Number(baselineDom.mutationSequence))
          : Number(tracker.mutationSequence) || 0;
        var lastActivityAt = now - Math.max(0, Number(tracker.quietMs) || 0);
        var frameStableFor = Math.max(0, now - Math.max(lastActivityAt, since));
        var frameStable = frameStableFor >= config.domStableMs;
        mutationDelta += delta;
        if (!frameStable) stable = false;
        stableFor = Math.min(stableFor, frameStableFor);
        frames[frame.frameId] = {
          observed: true,
          sameDocument: sameDocument,
          mutationSequence: Number(tracker.mutationSequence) || 0,
          mutationDelta: delta,
          stableFor: frameStableFor,
          stable: frameStable,
          historySequence: Number(tracker.historySequence) || 0,
          observing: tracker.observing === true,
          observerError: tracker.observerError || '',
        };
      });
      if (!Number.isFinite(stableFor)) stableFor = 0;
      return {
        mutationDelta: mutationDelta,
        stable: stable,
        stableFor: stableFor,
        stableWindowMs: config.domStableMs,
        observedFrames: observedFrames,
        required: config.domStable === true,
        frames: frames,
      };
    }
    function collectSignals(navigation, network, dom) {
      var signals = [];
      if (navigation.urlChanged) signals.push('url_changed');
      if (navigation.loaderChanged) signals.push('loader_changed');
      if (navigation.documentChanged) signals.push('document_changed');
      if (navigation.historyChanged) signals.push('history_changed');
      if (network.sequenceDelta > 0) signals.push('network_activity');
      if (dom.mutationDelta > 0 || navigation.documentChanged) signals.push('dom_mutation');
      if (network.websocketMessages > 0) signals.push('websocket_message');
      if (network.sseEvents > 0) signals.push('sse_event');
      return signals;
    }
    function pendingReasons(config, navigation, network, dom, expectedState, effect, observeError) {
      var reasons = [];
      if (observeError) reasons.push('页面状态暂不可读: ' + errorText(observeError));
      if (config.network && !network.stable) {
        reasons.push(network.coverageKnown === false
          ? '网络观测覆盖未知，拒绝判定网络稳定'
          : network.blockingCount > 0
          ? '等待 ' + network.blockingCount + ' 个 blocking 请求完成'
          : '等待网络空闲 (' + network.stableFor + '/' + network.idleWindowMs + 'ms)');
      }
      if (config.domStable && !dom.stable) {
        reasons.push(dom.observedFrames === 0 ? '等待 DOM 观察器可用' : '等待 DOM 稳定 (' + dom.stableFor + '/' + dom.stableWindowMs + 'ms)');
      }
      if (config.navigation && !navigation.settled) reasons.push('等待文档加载完成 (readyState=' + (navigation.readyState || 'unknown') + ')');
      if (expectedState.required && !expectedState.satisfied) reasons.push('等待显式 expectation 满足');
      if (config.requireEffect && !effect.detected) reasons.push('等待可观测的动作效果');
      return reasons;
    }
    function summarize(report) {
      var parts = [];
      var network = report.network || {};
      var dom = report.dom || {};
      var navigation = report.navigation || {};
      if (network.required !== false) {
        parts.push('network ' + (network.stable ? 'idle' : 'busy') + ' ' + (network.stableFor || 0) + '/' + (network.idleWindowMs || 0) + 'ms (blocking=' + (network.blockingCount || 0) + ' persistent=' + (network.persistentCount || 0) + ')');
      }
      if (dom.required === true) {
        parts.push('dom ' + (dom.stable ? 'stable' : 'unstable') + ' ' + (dom.stableFor || 0) + '/' + (dom.stableWindowMs || 0) + 'ms (mutations=' + (dom.mutationDelta || 0) + ')');
      }
      if (navigation.required === true) {
        parts.push('navigation ' + (navigation.settled ? 'settled' : 'pending') + ' (readyState=' + (navigation.readyState || 'unknown') + ')');
      }
      if (report.expectedState && report.expectedState.required) parts.push('expect ' + (report.expectedState.satisfied ? 'satisfied' : 'unsatisfied'));
      parts.push('effect=' + ((report.effect && report.effect.signals || []).join(',') || 'none'));
      parts.push((report.durationMs || 0) + 'ms/' + (report.polls || 0) + ' polls');
      return parts.join(' | ');
    }
    function compactVerdict(verdict) {
      if (!verdict) return null;
      return {
        status: String(verdict.status || ''),
        performed: String(verdict.performed || ''),
        conditionMet: verdict.conditionMet === true,
        signals: Array.isArray(verdict.signals) ? verdict.signals.slice() : [],
        evidence: Array.isArray(verdict.evidence) ? verdict.evidence.slice() : [],
        reason: String(verdict.reason || ''),
      };
    }
    function expectationFatal(error, signal) {
      if (signal && signal.aborted === true) return true;
      var code = String(error && error.code || '');
      return code === 'ACTION_CANCELLED' || code === 'INVALID_EXPECTATION' || transportGone(error);
    }
    function warningReport(error, context) {
      context = context || {};
      if (expectationFatal(error, context.signal)) throw error;
      var report = Object.assign({ ready: false, mode: context.mode || 'action', tabId: context.tabId, frameId: context.frameId || '' },
        error && error.details && error.details.report || {});
      report.ready = false;
      report.timedOut = String(error && error.code || '') === 'PAGE_READINESS_TIMEOUT';
      report.warning = true;
      report.warningCode = 'PAGE_READINESS_INCOMPLETE';
      report.warningMessage = errorText(error) || '页面状态暂不可确认';
      report.reason = report.reason || report.warningMessage;
      if (addLog) {
        try {
          addLog('页面稳定检查未完成，按 warning 继续 tabId=' + context.tabId + ' mode=' + report.mode + '：' + report.warningMessage,
            { level: 'warn', scope: 'run', tabId: context.tabId });
        } catch (_) {}
      }
      return report;
    }
    function timeoutError(report, mode) {
      var error = new factContract.PageFactError('PAGE_READINESS_TIMEOUT',
        (mode === 'navigation' ? '页面导航后状态未在时限内稳定: ' : mode === 'before-action' ? '页面操作前状态未在时限内稳定: ' : '页面动作后状态未在时限内稳定: ') + String(report.reason || '') + '；' + summarize(report), {
          report: report,
          lastState: {
            navigation: report.navigation,
            network: report.network,
            dom: report.dom,
            expectedState: report.expectedState,
          },
        });
      error.performed = 'unknown';
      error.retryable = false;
      return error;
    }
    function resolveDeadline(options, startedMs) {
      // The caller's existing deadline (action deadline / navigation budget)
      // is the boundary; the barrier never extends it.
      var explicit = Number(options.deadline);
      if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, startedMs + TIMEOUT_MAX_MS);
      return startedMs + clampNumber(options.timeoutMs, 10000, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
    }
    async function runWait(mode, tabId, baseline, options) {
      tabId = Math.floor(Number(tabId));
      options = options || {};
      if (!(tabId > 0)) throw new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面就绪等待需要有效 tabId');
      var config = normalizeOptions(options.readiness !== undefined ? options.readiness : options);
      if (!config) return { ready: false, skipped: 'disabled', mode: mode, tabId: tabId };
      var signal = options.signal || null;
      var startedMs = Date.now();
      var deadline = resolveDeadline(options, startedMs);
      var since = options.since === undefined ? startedMs : Math.max(0, Number(options.since) || 0);
      var expectation = options.expect && typeof options.expect === 'object' ? options.expect : null;
      var state = stateFor(tabId);
      var waitLabel = mode === 'action' ? '页面动作后稳定检查' : mode === 'before-action' ? '页面操作前稳定检查' : '页面导航后稳定检查';
      var expectedState = { required: !!expectation, satisfied: false, verification: null };
      var effect = { detected: false, signals: [], firstObservedAt: null };
      var polls = 0;
      var lastReport = null;
      var lastError = null;
      ensureNotAborted(signal);
      async function waitWithSession(cdp, budget) {
        var signal = budget.signal;
        if (!baseline) {
          baseline = await captureBaselineWith(cdp, tabId, { frameId: options.frameId, signal: signal, deadline: deadline, since: since, readiness: config });
        }
        var generation = baseline.generation;
        var actionFrameId = baseline.frameId && baseline.frameId !== baseline.navigation.frameId ? baseline.frameId : '';
        async function observeCurrent() {
          budget.check();
          if (generation !== currentGeneration(tabId) || state.generation !== generation) throw transportUncertainError(tabId);
          if (config.network) await ensureNetworkEnabled(state, cdp, tabId, commandTimeout(deadline), actionFrameId ? [actionFrameId] : []);
          var current = await observe(cdp, state, tabId, actionFrameId, since,
            mode === 'action' ? baseline.network.blockingKeys || [] : [], commandTimeout(deadline), signal);
          if (generation !== currentGeneration(tabId) || state.generation !== generation) throw transportUncertainError(tabId);
          return current;
        }
        function stateSignature(observation) {
          return JSON.stringify(observation.frames.map(function (frame) {
            var tracker = observation.dom[frame.frameId] || {};
            return [frame.frameId, frame.loaderId, frame.missing, tracker.token, tracker.url, tracker.readyState, tracker.mutationSequence];
          }));
        }
        var lastProgressAt = 0;
        var lastProgressSignature = '';
        var sawPendingReport = false;
        function logProgress(report) {
          if (!addLog || !report) return;
          if (report.ready !== true) sawPendingReport = true;
          // An action that is already stable on its first observation does not
          // need a waiting log. Keep diagnostics for actual waits and the final
          // transition after a pending state.
          if (report.ready === true && !sawPendingReport) return;
          var now = Date.now();
          var signature = [
            report.ready === true,
            report.network && report.network.blockingCount || 0,
            report.network && report.network.stable === true,
            report.navigation && report.navigation.readyState || '',
            report.navigation && report.navigation.settled === true,
            report.dom && report.dom.stable === true,
            report.expectedState && report.expectedState.satisfied === true,
          ].join('|');
          if (lastProgressAt && now - lastProgressAt < 1000 && signature === lastProgressSignature) return;
          lastProgressAt = now;
          lastProgressSignature = signature;
          try {
            addLog((report.ready === true ? waitLabel + '完成' : waitLabel + '中') + ' tabId=' + tabId + ' mode=' + mode + '：' + summarize(report) + '；' + String(report.reason || ''), {
              level: 'info', scope: 'run', tabId: tabId,
            });
          } catch (_) {}
        }
        while (true) {
          budget.check();
          expectedState.satisfied = false;
          polls += 1;
          var observation = null;
          var observeError = null;
          try {
            observation = await observeCurrent();
          } catch (error) {
            if ((signal && signal.aborted === true)
                || String(error && error.code || '') === 'ACTION_CANCELLED'
                || transportGone(error)
                || error && error.details && error.details.transportUncertain === true) throw error;
            observeError = error;
            lastError = error;
          }
          var evaluatedAt = Date.now();
          var navigation = observation ? evaluateNavigation(tabId, baseline, observation, config) : { frameId: baseline.navigation.frameId, url: baseline.navigation.url, loaderId: baseline.navigation.loaderId, documentId: baseline.navigation.documentId, readyState: '', urlChanged: false, loaderChanged: false, documentChanged: false, historyChanged: false, settled: false, required: config.navigation === true, frames: {} };
          var network = observation ? evaluateNetwork(baseline, observation, config, since, evaluatedAt) : { blockingCount: 0, persistentCount: 0, inheritedBlockingCount: 0, sequenceDelta: 0, stable: false, stableFor: 0, idleWindowMs: config.networkIdleMs, enabled: state.rootEnabled, required: config.network === true, coverageKnown: false };
          var dom = observation ? evaluateDom(baseline, observation, config, since, evaluatedAt) : { mutationDelta: 0, stable: false, stableFor: 0, stableWindowMs: config.domStableMs, observedFrames: 0, required: config.domStable === true, frames: {} };
          if (observation) {
            collectSignals(navigation, network, dom).forEach(function (name) {
              if (effect.signals.indexOf(name) === -1) effect.signals.push(name);
            });
            if (effect.signals.length && !effect.detected) {
              effect.detected = true;
              effect.firstObservedAt = iso(evaluatedAt);
            }
          }
          // Current-state expectations must hold at the end of the wait.
          // Check them only after stability, and discard the verdict if the
          // page changes while verification is reading it.
          if (expectedState.required && observation
              && pendingReasons(config, navigation, network, dom, { required: false }, effect, observeError).length === 0) {
            try {
              var verifiedSignature = stateSignature(observation);
              var verdict = await budget.call(function () {
                return verification.verifyExpectation({
                  tabId: tabId, expectation: expectation, targetRef: options.targetRef || null, intent: options.intent || null,
                  baseline: { url: baseline.navigation.url, documentId: baseline.navigation.documentId, loaderId: baseline.navigation.loaderId },
                  timeoutMs: commandTimeout(deadline), signal: signal,
                });
              });
              expectedState.verification = compactVerdict(verdict);
              observation = await observeCurrent();
              evaluatedAt = Date.now();
              navigation = evaluateNavigation(tabId, baseline, observation, config);
              network = evaluateNetwork(baseline, observation, config, since, evaluatedAt);
              dom = evaluateDom(baseline, observation, config, since, evaluatedAt);
              expectedState.satisfied = !!(verdict && verdict.status === 'confirmed' && verdict.conditionMet === true
                && stateSignature(observation) === verifiedSignature);
            } catch (error) {
              if (expectationFatal(error, signal) || error && error.details && error.details.transportUncertain) throw error;
              observeError = error;
              lastError = error;
              expectedState.verification = { status: 'failed', performed: 'no', conditionMet: false, signals: [], evidence: [], reason: errorText(error), code: String(error && error.code || '') };
            }
          }
          budget.check();
          var reasons = pendingReasons(config, navigation, network, dom, expectedState, effect, observeError);
          var ready = !observeError && reasons.length === 0;
          var report = {
            ready: ready,
            mode: mode,
            tabId: tabId,
            frameId: baseline.frameId,
            scope: baseline.scope.slice(),
            effect: { detected: effect.detected, signals: effect.signals.slice(), firstObservedAt: effect.firstObservedAt },
            navigation: navigation,
            network: network,
            dom: dom,
            expectedState: { required: expectedState.required, satisfied: expectedState.satisfied, verification: expectedState.verification },
            reason: ready ? '已达到就绪条件' : reasons.join('；'),
            options: config,
            startedAt: iso(startedMs),
            completedAt: iso(evaluatedAt),
            durationMs: evaluatedAt - startedMs,
            polls: polls,
            timedOut: false,
          };
          report.summary = summarize(report);
          if (lastError && !ready) report.lastError = errorText(lastError);
          lastReport = report;
          logProgress(report);
          if (ready) return report;
          var wait = Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now()));
          if (wait > 0) await delay(wait, signal);
        }
      }
      try {
        return await withObservationSession(tabId, options, deadline, waitWithSession);
      } catch (error) {
        if (String(error && error.code || '') !== 'PAGE_READINESS_TIMEOUT') throw error;
        var now = Date.now();
        var timedOut = Object.assign({}, lastReport || {
          ready: false, mode: mode, tabId: tabId, reason: '尚未完成首次页面状态观测',
          network: {}, dom: {}, navigation: {}, expectedState: expectedState, effect: effect,
        }, { ready: false, timedOut: true, completedAt: iso(now), durationMs: now - startedMs, polls: polls });
        if (lastError) timedOut.lastError = errorText(lastError);
        timedOut.summary = summarize(timedOut);
        throw timeoutError(timedOut, mode);
      }
    }
    // waitForAction(tabId, baseline, { deadline|timeoutMs, signal, since, expect, targetRef, intent, network, domStable, navigation, requireEffect, networkIdleMs, domStableMs, pollIntervalMs })
    function waitForAction(tabId, baseline, options) {
      if (!baseline || typeof baseline !== 'object' || !baseline.navigation || !baseline.dom) {
        return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面就绪等待缺少基线'));
      }
      return runWait('action', tabId, baseline, options || {});
    }
    function waitBeforeAction(tabId, options) {
      options = Object.assign({}, options || {}, { since: 0, expect: null });
      var config = normalizeOptions(options.readiness !== undefined ? options.readiness : FLOW_DEFAULTS);
      options.readiness = config ? Object.assign({}, config, { requireEffect: false }) : false;
      return runWait('before-action', tabId, null, options);
    }
    // waitForNavigation(tabId, { deadline|timeoutMs, signal, readiness?, ... })
    // Main-frame only. Stability is measured from real activity (or from the
    // moment tracking started) rather than from the call time, so a page that
    // already went quiet during the load wait completes immediately.
    function waitForNavigation(tabId, options) {
      options = Object.assign({}, options || {}, { since: 0, frameId: '', expect: null });
      return runWait('navigation', tabId, null, options);
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      DEFAULTS: DEFAULTS,
      FLOW_DEFAULTS: FLOW_DEFAULTS,
      SOFT_TIMEOUT_MS: SOFT_TIMEOUT_MS,
      normalizeOptions: normalizeOptions,
      summarize: summarize,
      warningReport: warningReport,
      recordNetworkEvent: recordNetworkEvent,
      clearTab: clearTab,
      captureBaseline: captureBaseline,
      waitForAction: waitForAction,
      waitBeforeAction: waitBeforeAction,
      waitForNavigation: waitForNavigation,
      getState: function (tabId) {
        var state = tabs.get(Math.floor(Number(tabId)));
        return state ? { tabId: state.tabId, sequence: state.sequence, inflight: state.entries.size, networkEnabled: state.rootEnabled, generation: state.generation } : null;
      },
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    DEFAULTS: DEFAULTS,
    FLOW_DEFAULTS: FLOW_DEFAULTS,
    SOFT_TIMEOUT_MS: SOFT_TIMEOUT_MS,
    normalizeOptions: normalizeOptions,
    createPageReadinessBarrier: createPageReadinessBarrier,
  });
});
