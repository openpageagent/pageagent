// Single PageActionEngine. User input and deterministic container mutations are
// emitted through CDP; business completion is decided by standard actions and receipts.
(function attachPageActionEngine(root, factory) {
  'use strict';
  var api = factory(root && root.PageActionContract, root && root.PageFactContract, root && root.PageJavascriptContract, root && root.PageStandardActions);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageActionEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionContract, factContract, javascriptContract, standardActionsModule) {
  'use strict';
  var API_VERSION = 1;

  function createPageActionEngine(options) {
    options = options || {};
    var chromeApi = options.chrome || globalThis.chrome;
    var sessions = options.cdpSessionManager;
    var perception = options.pagePerceptionEngine;
    var verification = options.pageVerificationEngine;
    var files = options.nativeFileMaterializer;
    if (!actionContract || !factContract || !javascriptContract || !standardActionsModule || !sessions || !perception || !verification || !files) {
      throw new Error('PageActionEngine requires shared contracts, standard actions, session, perception, verification and file materializer');
    }
    var standardActions = standardActionsModule.createPageStandardActions();
    // Optional state-change readiness barrier. Flow page actions wait for the
    // page to settle before lookup and after dispatch. Agent/script intents
    // opt in through input.readiness.
    var readinessBarrier = options.readinessBarrier && typeof options.readinessBarrier.waitForAction === 'function'
      ? options.readinessBarrier : null;
    var READINESS_ACTION_KINDS = /^(?:click|doubleClick|contextClick|hover|type|fill|fillFormFields|select|scroll|press|check|drag|upload)$/;
    // A generic action cannot safely infer which Fetch/XHR belongs to its
    // business result. Use navigation and DOM quiet windows by default, but make
    // the global network-idle barrier opt-in for Flow actions. Nodes that need
    // request completion can enable it explicitly through input.readiness.
    var actionQueues = new Map();
    var platformPromise = null;
    var VISUAL_FEEDBACK_TIMEOUT_MS = 1600;

    function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, Number(ms) || 0)); }); }
    function remainingActionMs(deadline) {
      return Number.isFinite(Number(deadline)) ? Math.max(0, Number(deadline) - Date.now()) : Number.POSITIVE_INFINITY;
    }
    function actionTimeout(operation) {
      return new factContract.PageFactError('ACTION_TIMEOUT', String(operation || '页面动作') + ' 超过统一时限', {
        performed: 'unknown',
      });
    }
    function actionCancelled(signal) {
      var error = new factContract.PageFactError('ACTION_CANCELLED', '页面动作随生成取消', {});
      error.performed = 'unknown';
      error.retryable = false;
      error.signal = signal || null;
      return error;
    }
    function ensureNotAborted(signal) {
      if (signal && signal.aborted) throw actionCancelled(signal);
    }
    function abortablePromise(value, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted) {
        Promise.resolve(value).catch(function () {});
        return Promise.reject(actionCancelled(signal));
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
          reject(actionCancelled(signal));
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
    function boundedCall(factory, deadline, operation, signal) {
      ensureNotAborted(signal);
      var remaining = remainingActionMs(deadline);
      if (remaining < 1) return Promise.reject(actionTimeout(operation));
      var value;
      try { value = factory(); }
      catch (error) { return Promise.reject(error); }
      var pending = Promise.resolve(value);
      if (!Number.isFinite(remaining)) return abortablePromise(pending, signal);
      var timed = new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(actionTimeout(operation));
        }, Math.max(1, remaining));
        pending.then(function (result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }, function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
      return abortablePromise(timed, signal);
    }
    function actionDelay(ms, deadline, operation, signal) {
      var requested = Math.max(0, Number(ms) || 0);
      return boundedCall(function () { return delay(requested); }, deadline, operation || '页面动作等待', signal);
    }
    function deadlineSender(send, deadline, intent) {
      function bounded(method, params, timeoutMs) {
        ensureNotAborted(intent && intent.signal);
        var requested = Number(timeoutMs) || Number(intent && intent.timeoutMs) || 30000;
        var remaining = remainingActionMs(deadline);
        if (remaining < 1) return Promise.reject(actionTimeout('CDP ' + method));
        var commandTimeout = Number.isFinite(remaining)
          ? Math.max(1, Math.min(Math.floor(requested), Math.floor(remaining)))
          : Math.max(1, Math.floor(requested));
        return boundedCall(function () {
          return send(method, params || {}, commandTimeout);
        }, deadline, 'CDP ' + method, intent && intent.signal);
      }
      bounded.forFrame = function (frameId) {
        return deadlineSender(typeof send.forFrame === 'function' ? send.forFrame(frameId) : send, deadline, intent);
      };
      bounded.forSession = function (sessionId) {
        return deadlineSender(typeof send.forSession === 'function' ? send.forSession(sessionId) : send, deadline, intent);
      };
      bounded.getFrameRoute = function (frameId) { return typeof send.getFrameRoute === 'function' ? send.getFrameRoute(frameId) : null; };
      bounded.getSessionRoute = function (sessionId) { return typeof send.getSessionRoute === 'function' ? send.getSessionRoute(sessionId) : null; };
      bounded.listFrameRoutes = function () { return typeof send.listFrameRoutes === 'function' ? send.listFrameRoutes() : []; };
      bounded.waitForFrameRoutes = function () {
        return send.waitForFrameRoutes
          ? send.waitForFrameRoutes()
          : Promise.resolve([]);
      };
      // Keep an escape hatch for best-effort cleanup (for example releasing a
      // Runtime object group after the parent signal has been aborted). Normal
      // commands still use this deadline/signal-aware wrapper.
      bounded._rawSend = send && send._rawSend || send;
      return bounded;
    }
    function showVirtualPointer(tabId, kind, coordinates, bounds, deadline) {
      if (!chromeApi.tabs || typeof chromeApi.tabs.sendMessage !== 'function' || !(Number(tabId) > 0) || !coordinates) {
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        var settled = false;
        var budget = remainingActionMs(deadline);
        var timer = setTimeout(function () { finish(false); }, Math.max(1, Math.min(VISUAL_FEEDBACK_TIMEOUT_MS, budget)));
        function finish(value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value === true);
        }
        try {
          var returned = chromeApi.tabs.sendMessage(Number(tabId), {
            type: 'PAGE_ACTION_VISUAL_FEEDBACK',
            kind: String(kind || 'click'),
            x: Number(coordinates.x) || 0,
            y: Number(coordinates.y) || 0,
            bounds: bounds ? {
              x: Number(bounds.x !== undefined ? bounds.x : bounds.left) || 0,
              y: Number(bounds.y !== undefined ? bounds.y : bounds.top) || 0,
              width: Math.max(0, Number(bounds.width) || 0),
              height: Math.max(0, Number(bounds.height) || 0),
            } : null,
          }, function (response) {
            var lastError = chromeApi.runtime && chromeApi.runtime.lastError;
            finish(!lastError && !!(response && response.ok));
          });
          if (returned && typeof returned.then === 'function') {
            returned.then(function (response) { finish(!!(response && response.ok)); }, function () { finish(false); });
          }
        } catch (_) { finish(false); }
      });
    }
    function platform() {
      if (platformPromise) return platformPromise;
      platformPromise = new Promise(function (resolve) {
        if (!chromeApi.runtime || typeof chromeApi.runtime.getPlatformInfo !== 'function') { resolve({ os: '' }); return; }
        chromeApi.runtime.getPlatformInfo(function (info) { resolve(info || { os: '' }); });
      });
      return platformPromise;
    }
    function safeCommandParams(method, params, sensitive) {
      if (sensitive && method === 'Input.insertText') return { text: '[REDACTED]' };
      if (sensitive && method === 'Runtime.evaluate') return { expression: '[REDACTED]' };
      if (method === 'DOM.setFileInputFiles') {
        return Object.assign({}, factContract.clone(params || {}), { files: ['[MATERIALIZED_TEMP_FILE]'] });
      }
      return factContract.clone(params || {});
    }
    function commandMayMutate(method, intent) {
      method = String(method || '');
      if (/^(?:Input\.|DOM\.setFileInputFiles$|Page\.(?:navigate|reload)$)/.test(method)) return true;
      if (method !== 'Runtime.evaluate') return false;
      intent = intent || {};
      if (/^(?:patch|webStorage|replayRequest)$/.test(String(intent.kind || ''))) return true;
      if (String(intent.kind || '') === 'evaluate') {
        return /^(?:write|mutate)$/i.test(String(intent.input && intent.input.mode || ''));
      }
      return false;
    }
    function commandSender(send, records, responses, intent, deadline) {
      send = deadlineSender(send, deadline, intent);
      async function dispatch(method, params, timeoutMs, routedTask) {
        var effectiveTimeout = Math.max(1, Number(timeoutMs) || Number(intent.timeoutMs) || 30000);
        var startedAt = new Date().toISOString();
        var record = { method: method, params: safeCommandParams(method, params, intent.sensitive), accepted: false, mutation: commandMayMutate(method, intent), startedAt: startedAt, provenance: 'cdp' };
        records.push(record);
        try {
          var response = await (routedTask ? routedTask(effectiveTimeout) : send(method, params || {}, effectiveTimeout));
          record.accepted = true;
          record.completedAt = new Date().toISOString();
          responses.push({ method: method, response: response === undefined ? null : factContract.clone(response), mutation: record.mutation === true, completedAt: record.completedAt });
          return response;
        } catch (error) {
          // A CDP transport failure after dispatch cannot prove that the
          // browser did not apply the input. Treat the action as unknown and
          // prevent node-level retries from replaying a possible side effect.
          if (record.mutation === true && error && (typeof error === 'object' || typeof error === 'function') && record.accepted !== true) {
            try {
              error.performed = 'unknown';
              error.retryable = false;
            } catch (_) {}
          }
          throw error;
        }
      }
      function command(method, params, timeoutMs) { return dispatch(method, params, timeoutMs, null); }
      command.via = function (method, params, timeoutMs, routedTask) {
        return dispatch(method, params, timeoutMs, routedTask);
      };
      function routedCommand(routedSend) {
        routedSend = deadlineSender(routedSend, deadline, intent);
        function routed(method, params, timeoutMs) {
          return dispatch(method, params, timeoutMs, function (effectiveTimeout) {
            return routedSend(method, params || {}, effectiveTimeout);
          });
        }
        routed.forFrame = function (frameId) {
          return routedCommand(typeof routedSend.forFrame === 'function' ? routedSend.forFrame(frameId) : routedSend);
        };
        routed.forSession = function (sessionId) {
          return routedCommand(typeof routedSend.forSession === 'function' ? routedSend.forSession(sessionId) : routedSend);
        };
        routed.getFrameRoute = function (frameId) { return typeof routedSend.getFrameRoute === 'function' ? routedSend.getFrameRoute(frameId) : null; };
        routed.getSessionRoute = function (sessionId) { return typeof routedSend.getSessionRoute === 'function' ? routedSend.getSessionRoute(sessionId) : null; };
        routed.listFrameRoutes = function () { return typeof routedSend.listFrameRoutes === 'function' ? routedSend.listFrameRoutes() : []; };
        routed.waitForFrameRoutes = function () { return typeof routedSend.waitForFrameRoutes === 'function' ? routedSend.waitForFrameRoutes() : Promise.resolve([]); };
        return routed;
      }
      command.forFrame = function (frameId) { return routedCommand(typeof send.forFrame === 'function' ? send.forFrame(frameId) : send); };
      command.forSession = function (sessionId) { return routedCommand(typeof send.forSession === 'function' ? send.forSession(sessionId) : send); };
      command.getFrameRoute = function (frameId) { return typeof send.getFrameRoute === 'function' ? send.getFrameRoute(frameId) : null; };
      command.getSessionRoute = function (sessionId) { return typeof send.getSessionRoute === 'function' ? send.getSessionRoute(sessionId) : null; };
      command.listFrameRoutes = function () { return typeof send.listFrameRoutes === 'function' ? send.listFrameRoutes() : []; };
      command.waitForFrameRoutes = function () { return typeof send.waitForFrameRoutes === 'function' ? send.waitForFrameRoutes() : Promise.resolve([]); };
      return command;
    }
    function meaningfulLocator(locator) {
      if (!locator || typeof locator !== 'object') return false;
      if (locator.elementIndex !== undefined && locator.elementIndex !== null && locator.elementIndex !== '') return true;
      return ['selector', 'textSelector', 'textPattern', 'text', 'ref', 'label'].some(function (key) {
        return locator[key] !== '' && locator[key] !== undefined && locator[key] !== null;
      });
    }
    function validateAgentScrollIntent(intent) {
      if (!intent || intent.source !== 'agent' || intent.kind !== 'scroll') return;
      var input = intent.input || {};
      if (!meaningfulLocator(input.containerLocator)) {
        throw new factContract.PageFactError('ACTION_INVALID', 'Agent 滚动必须提供 containerLocator；滚动整个页面时显式使用 {"selector":"html"}', {
          required: ['containerLocator'],
        });
      }
      if (String(input.to || '') === 'target' && !meaningfulLocator(intent.locator)) {
        throw new factContract.PageFactError('ACTION_INVALID', 'to="target" 时必须额外提供目标元素 locator', {
          required: ['containerLocator', 'locator'],
        });
      }
    }
    // params.readiness → barrier options; null means no barrier for this intent.
    function readinessPlan(intent) {
      if (!readinessBarrier || !READINESS_ACTION_KINDS.test(intent.kind)) return null;
      var raw = intent.input ? intent.input.readiness : undefined;
      var explicit = !(raw === undefined || raw === null || raw === '');
      if (intent.source !== 'flow' && !explicit) return null;
      if (!explicit) return readinessBarrier.normalizeOptions(readinessBarrier.FLOW_DEFAULTS);
      return readinessBarrier.normalizeOptions(raw);
    }
    function preparationDeadline(actionDeadline) {
      var now = Date.now();
      var budget = readinessBarrier.SOFT_TIMEOUT_MS;
      // An explicit shared deadline cannot move. Reserve most of its
      // remaining time for the operation that the user actually requested.
      if (Number(actionDeadline) > 0) budget = Math.min(budget, Math.max(0, (Number(actionDeadline) - now) / 4));
      return now + Math.floor(budget);
    }
    async function prepareReadiness(intent, plan, actionDeadline) {
      if (!plan) return null;
      var frameId = String(intent.targetRef && intent.targetRef.frameId || intent.locator && intent.locator.frameId
        || intent.input && intent.input.containerLocator && intent.input.containerLocator.frameId || '');
      var deadline = preparationDeadline(actionDeadline);
      try {
        var report = await readinessBarrier.waitBeforeAction(intent.tabId, {
          readiness: plan, frameId: frameId, deadline: deadline, signal: intent.signal,
        });
        var baseline = await readinessBarrier.captureBaseline(intent.tabId, {
          readiness: plan, frameId: frameId, deadline: deadline, signal: intent.signal,
        });
        return { report: report, baseline: baseline };
      } catch (error) {
        return { baseline: null, report: readinessBarrier.warningReport(error, {
          mode: 'before-action', tabId: intent.tabId, frameId: frameId, signal: intent.signal,
        }) };
      }
    }
    async function awaitActionReadiness(intent, baseline, plan, resolved, records, actionDeadline) {
      var dispatched = records.some(function (record) { return record.mutation === true && record.accepted === true; });
      if (!dispatched) {
        return { ready: true, skipped: 'no_mutation_dispatched', reason: '动作未向浏览器派发输入，无需等待页面稳定', frameId: baseline.frameId };
      }
      try {
        var explicit = intent.input && intent.input.readiness;
        var deadline = actionDeadline;
        if ((explicit === undefined || explicit === null || explicit === '') && !intent.expect) {
          deadline = Math.min(deadline, Date.now() + readinessBarrier.SOFT_TIMEOUT_MS);
        }
        return await readinessBarrier.waitForAction(intent.tabId, baseline, Object.assign({}, plan, {
          since: Date.now(),
          deadline: deadline,
          signal: intent.signal,
          // newTab expectations need post-action browser facts that only the
          // final receipt reads; every other expectation is polled here.
          expect: intent.expect && !shouldTrackNewTabs(intent) ? intent.expect : null,
          targetRef: resolved && resolved.targetRef || intent.targetRef || null,
          intent: intent,
        }));
      } catch (error) {
        return readinessBarrier.warningReport(error, {
          mode: 'action', tabId: intent.tabId, frameId: baseline.frameId, signal: intent.signal,
        });
      }
    }
    function enqueueAction(tabId, signal, task) {
      tabId = Math.floor(Number(tabId));
      var previous = actionQueues.get(tabId) || Promise.resolve();
      var running = previous.catch(function () {}).then(function () {
        ensureNotAborted(signal);
        return task();
      });
      var tail = running.catch(function () {});
      actionQueues.set(tabId, tail);
      // finally() creates a new rejecting promise when the action fails. Consume
      // that derived promise so a handled action error cannot become an
      // unhandled rejection in the service worker.
      tail.finally(function () { if (actionQueues.get(tabId) === tail) actionQueues.delete(tabId); }).catch(function () {});
      return running;
    }
    function keyDefinition(key) {
      var value = String(key || '');
      var map = {
        Enter: { key: 'Enter', code: 'Enter', vk: 13 }, Tab: { key: 'Tab', code: 'Tab', vk: 9 },
        Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
        Delete: { key: 'Delete', code: 'Delete', vk: 46 }, Home: { key: 'Home', code: 'Home', vk: 36 },
        End: { key: 'End', code: 'End', vk: 35 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }, Space: { key: ' ', code: 'Space', vk: 32 },
      };
      if (map[value]) return map[value];
      if (value.length === 1) return { key: value, code: /[A-Za-z]/.test(value) ? 'Key' + value.toUpperCase() : '', vk: value.toUpperCase().charCodeAt(0) };
      return { key: value, code: value, vk: 0 };
    }
    async function pressKey(command, key, modifiers) {
      var definition = keyDefinition(key);
      var base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.vk, nativeVirtualKeyCode: definition.vk, modifiers: Number(modifiers) || 0 };
      var printable = String(definition.key || '').length === 1 && !(base.modifiers & (1 | 2 | 4));
      var keyDown = Object.assign({ type: printable ? 'keyDown' : 'rawKeyDown' }, base);
      if (printable) {
        var textValue = base.modifiers & 8 && /^[a-z]$/i.test(definition.key) ? definition.key.toUpperCase() : definition.key;
        keyDown.key = textValue;
        keyDown.text = textValue;
        keyDown.unmodifiedText = definition.key;
      }
      await command('Input.dispatchKeyEvent', keyDown);
      await command('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    }
    function movePointer(command, point, button, buttons) {
      return command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y,
        button: button || 'none', buttons: Number(buttons) || 0,
      });
    }
    async function mouseClick(command, point, clickType) {
      var button = clickType === 'contextClick' ? 'right' : 'left';
      var clickCount = clickType === 'doubleClick' ? 2 : 1;
      await movePointer(command, point, 'none', 0);
      for (var index = 1; index <= clickCount; index += 1) {
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: button, buttons: button === 'right' ? 2 : 1, clickCount: index });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: button, buttons: 0, clickCount: index });
      }
    }
    function insertText(command, text) {
      return command('Input.insertText', { text: String(text) });
    }
    function mouseWheel(command, point, deltaX, deltaY) {
      return command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y,
        deltaX: Number(deltaX) || 0, deltaY: Number(deltaY) || 0,
        button: 'none', buttons: 0, pointerType: 'mouse',
      });
    }
    function scrollGesture(command, point, deltaX, deltaY, speed) {
      return command('Input.synthesizeScrollGesture', {
        x: point.x, y: point.y,
        // synthesizeScrollGesture describes content movement, which is the
        // inverse sign of mouseWheel delta values.
        xDistance: -(Number(deltaX) || 0),
        yDistance: -(Number(deltaY) || 0),
        speed: Math.max(1, Number(speed) || 1200),
        gestureSourceType: 'mouse',
        preventFling: true,
      });
    }
    async function dragPointer(command, from, to, steps, dragData) {
      await movePointer(command, from, 'none', 0);
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      try {
        for (var step = 1; step <= steps; step += 1) {
          await movePointer(command, {
            x: from.x + (to.x - from.x) * step / steps,
            y: from.y + (to.y - from.y) * step / steps,
          }, 'left', 1);
        }
        if (dragData) {
          await command('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data: dragData });
          await command('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data: dragData });
          await command('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: dragData });
        }
      } finally {
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
      }
    }
    async function patchPage(command, input) {
      var expression = '(function(p){var list=Array.from(document.querySelectorAll(p.selector));if(!p.all)list=list.slice(0,1);list.forEach(function(el){if(p.action==="remove")el.remove();else if(p.action==="hide")el.style.setProperty("display","none","important");else if(p.action==="style")el.style.setProperty(p.name,String(p.value));else if(p.action==="attribute")el.setAttribute(p.name,String(p.value));else if(p.action==="removeAttribute")el.removeAttribute(p.name);else if(p.action==="enable"){el.removeAttribute("disabled");el.removeAttribute("aria-disabled")}});return {matched:list.length,action:p.action}})(' + JSON.stringify(input) + ')';
      var response = await command('Runtime.evaluate', { expression: expression, returnByValue: true, userGesture: true });
      return javascriptContract.evaluatedValue(response, '页面补丁', 'unknown') || {};
    }
    async function webStorage(command, input) {
      var expression = '(function(p){var s=p.storageType==="session"?sessionStorage:localStorage;var key=String(p.key==null?"":p.key);if(p.action==="get")return {key:key,value:s.getItem(key),confirmed:true};if(p.action==="remove"){s.removeItem(key);var removedValue=s.getItem(key);return {removed:true,key:key,value:removedValue,confirmed:removedValue===null}}if(p.action==="clear"){s.clear();return {cleared:true,length:s.length,confirmed:s.length===0}}var expected=String(p.value==null?"":p.value);s.setItem(key,expected);var actual=s.getItem(key);return {stored:true,key:key,value:actual,confirmed:actual===expected}})(' + JSON.stringify(input) + ')';
      var response = await command('Runtime.evaluate', { expression: expression, returnByValue: true, userGesture: true });
      return javascriptContract.evaluatedValue(response, '页面存储', 'unknown') || {};
    }
    function setFileInputFiles(command, resolved, path, timeoutMs) {
      return command.forFrame(resolved.target.frameId)('DOM.setFileInputFiles', {
        backendNodeId: resolved.target.backendNodeId,
        files: [path],
      }, timeoutMs);
    }

    async function dispatchTargetAction(send, intent, documentContext, records, responses, derivedFacts, actionDeadline, beforeExecute) {
      send = deadlineSender(send, actionDeadline, intent);
      var command = commandSender(send, records, responses, intent, actionDeadline);
      var input = intent.input || {};
      var kind = intent.kind;
      var resolved = null;
      var workingContext = documentContext;

      async function resolveForAction(locator, targetRef, resolveOptions) {
        resolveOptions = resolveOptions || {};
        var requiresGeometry = resolveOptions.requireGeometry !== undefined ? resolveOptions.requireGeometry !== false : kind !== 'upload';
        var requiresVisible = resolveOptions.visible !== undefined ? resolveOptions.visible === true : kind !== 'scroll' && kind !== 'upload';
        var value = resolveOptions.wait === true
          ? await perception.waitForTargetWithSend(send, intent.tabId, locator || {}, {
              targetRef: targetRef || null,
              timeoutMs: remainingActionMs(actionDeadline),
              visible: requiresVisible,
              requireGeometry: requiresGeometry,
              retryUnavailable: requiresGeometry,
              signal: intent.signal,
            })
          : await perception.resolveTargetWithSend(send, intent.tabId, locator || {}, {
              targetRef: targetRef || null,
              requireGeometry: requiresGeometry,
              signal: intent.signal,
            });
        if (value && value.missing) {
          throw new factContract.PageFactError('TARGET_NOT_FOUND', '目标数量未达到动作要求', { locator: locator, count: value.count });
        }
        if (requiresVisible && value && value.target && value.target.visible !== true) {
          throw new factContract.PageFactError('TARGET_NOT_FOUND', '动作目标当前不可见', { locator: locator, targetRef: value.targetRef });
        }
        return value;
      }

      var needsTargetResolution = /^(?:click|doubleClick|contextClick|hover|type|fill|select|check|drag|upload)$/.test(kind)
        || kind === 'press' && (intent.targetRef || meaningfulLocator(intent.locator))
        // Amount/top/bottom scrolling has no target element; the standard
        // action resolves its container itself. Only target/untilElement
        // modes need the pre-resolved target here.
        || kind === 'scroll' && (intent.targetRef || meaningfulLocator(intent.locator));
      if (needsTargetResolution) {
        var coordinateOnly = /^(?:click|doubleClick|contextClick|hover)$/.test(kind)
          && !intent.targetRef && !meaningfulLocator(intent.locator) && Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y));
        if (coordinateOnly) {
          resolved = { target: null, targetRef: null, coordinates: { x: Number(input.x), y: Number(input.y) } };
        } else {
          resolved = await resolveForAction(intent.locator, intent.targetRef, { wait: true });
          workingContext = resolved.context;
        }
      }

      if (resolved && (Number(input.offsetX) || Number(input.offsetY))) {
        resolved.coordinates = {
          x: resolved.coordinates.x + (Number(input.offsetX) || 0),
          y: resolved.coordinates.y + (Number(input.offsetY) || 0),
        };
      }

      // Readiness baseline: the target is resolved and nothing has been
      // dispatched yet, so the observation window starts before any input.
      if (typeof beforeExecute === 'function') await beforeExecute(resolved);

      if (standardActions.handlesTarget(kind)) {
        return standardActions.executeTarget(kind, {
          intent: intent,
          resolved: resolved,
          derivedFacts: derivedFacts,
          engine: {
            perform: async function (operation, payload) {
              payload = payload || {};
              if (operation === 'target.resolve') return resolveForAction(payload.locator, payload.targetRef, payload.options);
              if (operation === 'target.options') return perception.readTargetOptionsWithSend(command, payload.resolved, intent.signal);
              if (operation === 'scroll.read') return perception.readScrollInfoWithSend(send, intent.tabId, Object.assign({}, payload.input || {}, { signal: intent.signal }));
              if (operation === 'delay') return actionDelay(payload.ms, actionDeadline, payload.operation, intent.signal);
              if (operation === 'pointer.show') {
                var pointerTarget = payload.resolved || {};
                var shown = await showVirtualPointer(intent.tabId, payload.kind, pointerTarget.coordinates, pointerTarget.actionBounds || pointerTarget.target && pointerTarget.target.bounds, actionDeadline);
                if (typeof beforeExecute === 'function' && pointerTarget.targetRef && pointerTarget.coordinates) {
                  var refreshed = await resolveForAction({}, pointerTarget.targetRef);
                  // Standard actions may already hold this point object. Update
                  // it in place so input uses the latest geometry after feedback.
                  var point = pointerTarget.coordinates;
                  var offsetX = pointerTarget === resolved ? Number(input.offsetX) || 0 : 0;
                  var offsetY = pointerTarget === resolved ? Number(input.offsetY) || 0 : 0;
                  Object.assign(point, { x: refreshed.coordinates.x + offsetX, y: refreshed.coordinates.y + offsetY });
                  Object.assign(pointerTarget, refreshed, { coordinates: point });
                }
                return shown;
              }
              if (operation === 'pointer.click') return mouseClick(command, payload.point, payload.clickType);
              if (operation === 'pointer.move') return movePointer(command, payload.point, 'none', 0);
              if (operation === 'pointer.wheel') return mouseWheel(command, payload.point, payload.deltaX, payload.deltaY);
              if (operation === 'pointer.scrollGesture') return scrollGesture(command, payload.point, payload.deltaX, payload.deltaY, payload.speed);
              if (operation === 'pointer.drag') return dragPointer(command, payload.from, payload.to, payload.steps, payload.dragData);
              if (operation === 'keyboard.press') return pressKey(command, payload.key, payload.modifiers);
              if (operation === 'text.insert') return insertText(command, payload.text);
              if (operation === 'platform.read') return platform();
              if (operation === 'file.materialize') {
                var fileInput = payload.input || {};
                return boundedCall(function () {
                  return files.materialize({
                    owner: intent.owner || intent.actionId,
                    fileName: fileInput.fileName,
                    mimeType: fileInput.mimeType,
                    contentMode: fileInput.contentMode,
                    content: fileInput.content,
                    timeoutMs: intent.timeoutMs,
                  });
                }, actionDeadline, '文件准备', intent.signal);
              }
              if (operation === 'file.set') return setFileInputFiles(command, payload.resolved, payload.path, intent.timeoutMs);
              throw new factContract.PageFactError('ACTION_INVALID', '未知标准业务动作操作: ' + operation);
            },
          },
        });
      }

      throw new factContract.PageFactError('ACTION_INVALID', '未实现的目标页面动作: ' + kind);
    }


    async function dispatchNonTarget(send, intent, records, responses, derivedFacts, actionDeadline) {
      send = deadlineSender(send, actionDeadline, intent);
      var command = commandSender(send, records, responses, intent, actionDeadline);
      var input = intent.input || {};
      if (intent.kind === 'navigate') {
        derivedFacts.navigation = derivedFacts.navigation || {};
        derivedFacts.navigation.requestedAt = new Date().toISOString();
        var result = await command('Page.navigate', { url: String(input.url || '') });
        if (result && result.errorText) {
          throw new factContract.PageFactError('NAVIGATION_FAILED', '页面导航失败: ' + String(result.errorText), { url: String(input.url || '') });
        }
        derivedFacts.navigation.frameId = String(result.frameId || '');
        derivedFacts.navigation.loaderId = String(result.loaderId || '');
        derivedFacts.navigation.sameDocument = !result.loaderId;
        derivedFacts.navigation.url = String(input.url || '');
        derivedFacts.navigation.isDownload = result.isDownload === true;
      } else if (intent.kind === 'reload') {
        derivedFacts.navigation = derivedFacts.navigation || {};
        derivedFacts.navigation.requestedAt = new Date().toISOString();
        // Page.reload does not return a loaderId. Capture the pre-refresh main
        // document so the shared wait can require a genuinely new document.
        var reloadTree = await command('Page.getFrameTree', {});
        var reloadFrame = reloadTree && reloadTree.frameTree && reloadTree.frameTree.frame || {};
        derivedFacts.navigation.previousLoaderId = String(reloadFrame.loaderId || '');
        derivedFacts.navigation.previousFrameId = String(reloadFrame.id || '');
        await command('Page.reload', { ignoreCache: input.ignoreCache === true });
      } else if (intent.kind === 'evaluate') {
        if (!/^(?:write|mutate)$/.test(String(input.mode || '').toLowerCase())) {
          throw new factContract.PageFactError('PAGE_ACTION_REQUIRED', '只读 JavaScript 必须由 PagePerceptionEngine 执行');
        }
        var evaluateParams = {
          expression: javascriptContract.toExpression(input.code || input.expression || '', input.sourceType),
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        };
        if (String(input.world || 'MAIN').toUpperCase() === 'ISOLATED') {
          var tree = await command('Page.getFrameTree', {});
          var mainFrameId = tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
          if (!mainFrameId) throw new Error('无法创建 ISOLATED world：主 frame 不可用');
          var isolated = await command('Page.createIsolatedWorld', { frameId: mainFrameId, worldName: 'page-automation-script', grantUniveralAccess: false });
          evaluateParams.contextId = isolated.executionContextId;
        }
        var evaluated = await command('Runtime.evaluate', evaluateParams);
        derivedFacts.result = javascriptContract.evaluatedValue(evaluated, '页面 JavaScript', 'unknown');
      } else if (intent.kind === 'patch') {
        var patchInput = standardActions.preparePatch(input);
        derivedFacts.result = standardActions.completePatch(patchInput, await patchPage(command, patchInput));
        derivedFacts.businessState = {
          kind: 'patch', confirmed: Number(derivedFacts.result && derivedFacts.result.matched) > 0,
          matched: Number(derivedFacts.result && derivedFacts.result.matched) || 0,
          action: String(derivedFacts.result && derivedFacts.result.action || input.action || ''),
        };
      } else if (intent.kind === 'webStorage') {
        var storageInput = standardActions.prepareStorage(input);
        var storage = standardActions.completeStorage(storageInput, await webStorage(command, storageInput));
        derivedFacts.result = storage.result;
        derivedFacts.businessState = storage.businessState;
      } else if (intent.kind === 'replayRequest') {
        // Fetch in a page context accepts relative URLs, but it can also read
        // non-web schemes (for example data:) that must never be smuggled in
        // through templates or captured-request input. Resolve and validate
        // before invoking fetch so the rejection cannot be mistaken for a
        // network failure after a request has started.
        var replayExpression = '(async function(p){' +
          'var raw=String(p&&p.url==null?"":p.url).trim();' +
          'if(!raw)throw new Error("页面请求重放缺少 URL");' +
          'var resolved;try{resolved=new URL(raw,document.baseURI||location.href)}catch(_){throw new Error("页面请求重放 URL 格式无效");}' +
          'if(resolved.protocol!=="http:"&&resolved.protocol!=="https:")throw new Error("页面请求重放仅支持 http/https 或相对 URL");' +
          'var method=String(p.method||"GET").toUpperCase();' +
          'var r=await fetch(resolved.href,{method:method,headers:p.headers||{},body:/^(GET|HEAD)$/i.test(method)?undefined:p.body,credentials:"include"});' +
          'var body=await r.text();return {url:r.url,status:r.status,ok:r.ok,headers:Array.from(r.headers.entries()),body:body}' +
          '})(' + JSON.stringify(input) + ')';
        var replay = await command('Runtime.evaluate', { expression: replayExpression, awaitPromise: true, returnByValue: true, userGesture: true }, intent.timeoutMs);
        derivedFacts.result = javascriptContract.evaluatedValue(replay, '页面请求重放', 'unknown');
      }
      return null;
    }
    async function armDialog(intent, onTransportReady, deadline, onMutationAttempt) {
      if (typeof onTransportReady === 'function') onTransportReady();
      var dialogAction = standardActions.prepareDialog(intent.input || {});
      return boundedCall(function () {
        if (dialogAction.action === 'read') {
          return { armed: false, dialogs: sessions.readDialogHistory(intent.tabId, 20) };
        }
        if (typeof onMutationAttempt === 'function') onMutationAttempt();
        var configuredPolicyTimeout = Number(intent.input && intent.input.timeoutMs);
        return sessions.handleOrInstallDialogPolicy(intent.tabId, Object.assign({}, dialogAction, {
          owner: intent.owner || intent.actionId,
          timeoutMs: configuredPolicyTimeout > 0 ? configuredPolicyTimeout : (intent.owner ? 0 : intent.timeoutMs),
        }));
      }, deadline, '原生对话框业务动作', intent.signal);
    }
    function shouldTrackNewTabs(intent) {
      function containsNewTab(condition) {
        condition = condition || {};
        var kind = String(condition.kind || condition.type || '');
        if (kind === 'newTab') return true;
        if (kind === 'anyOf' || kind === 'allOf') return (condition.conditions || []).some(containsNewTab);
        return false;
      }
      return containsNewTab(intent && intent.expect);
    }
    function readAllTabs() {
      if (!chromeApi.tabs || typeof chromeApi.tabs.query !== 'function') return Promise.reject(new Error('读取标签页需要 chrome.tabs.query'));
      return chromeApi.tabs.query({});
    }
    function tabFact(tab, sourceTabId, confirmed) {
      tab = tab || {};
      return {
        actionId: '', sourceTabId: Number(sourceTabId) || 0, tabId: Number(tab.id) || 0,
        windowId: Number(tab.windowId) || 0, url: String(tab.pendingUrl || tab.url || ''),
        title: String(tab.title || ''), status: String(tab.status || ''), active: tab.active === true,
        openerTabId: Number(tab.openerTabId) || 0, sources: ['chrome.tabs.query'],
        ambiguous: confirmed !== true, associationConfirmed: confirmed === true,
      };
    }
    async function readBrowserFacts(tabBaseline, sourceTabId) {
      if (!tabBaseline) return { facts: [], newTabs: [], ambiguous: false };
      var baselineIds = Object.create(null);
      (tabBaseline || []).forEach(function (tab) { baselineIds[Number(tab && tab.id) || 0] = true; });
      var currentTabs = await readAllTabs();
      var candidates = currentTabs.filter(function (tab) {
        return tab && Number(tab.id) > 0 && !baselineIds[Number(tab.id)];
      }).map(function (tab) {
        var opener = Number(tab.openerTabId) || 0;
        return tabFact(tab, sourceTabId, opener === Number(sourceTabId));
      });
      var confirmed = candidates.filter(function (tab) { return tab.associationConfirmed === true; });
      var selected = confirmed.length === 1 ? confirmed : candidates;
      var ambiguous = confirmed.length > 1 || (confirmed.length === 0 && candidates.length > 0);
      selected = selected.map(function (tab) { var result = Object.assign({}, tab); delete result.associationConfirmed; return result; });
      return { facts: [], newTabs: selected, ambiguous: ambiguous };
    }
    async function executeUnsafe(rawIntent, hooks) {
      var intent = actionContract.normalizeIntent(rawIntent);
      hooks = hooks || {};
      ensureNotAborted(intent.signal);
      var requestedMs = Date.now();
      var startedMs = Number(hooks.actionStartedMs) > 0 ? Number(hooks.actionStartedMs) : 0;
      var actionDeadline = Number(hooks.actionDeadline) > 0 ? Number(hooks.actionDeadline) : (startedMs ? startedMs + intent.timeoutMs : 0);
      var startedAt = startedMs ? new Date(startedMs).toISOString() : '';
      var records = [];
      var responses = [];
      var derivedFacts = {};
      var resolved = null;
      var browserFactsError = null;
      var actualTabId = intent.tabId;
      var tabBaseline = null;
      var mutationAttempted = false;
      var readinessPlanned = readinessPlan(intent);
      var preparation = hooks.readinessPreparation || await prepareReadiness(intent, readinessPlanned, actionDeadline);
      var readinessBaseline = preparation && preparation.baseline || null;
      if (preparation) {
        derivedFacts.preReadiness = preparation.report;
        if (!readinessBaseline) derivedFacts.readiness = preparation.report;
      }
      function beginExecution() {
        if (!startedMs) {
          startedMs = Date.now();
          actionDeadline = startedMs + intent.timeoutMs;
          startedAt = new Date(startedMs).toISOString();
          if (typeof hooks.onReady === 'function') {
            var sharedDeadline = Number(hooks.onReady(startedMs));
            if (Number.isFinite(sharedDeadline) && sharedDeadline > 0) actionDeadline = Math.min(actionDeadline, sharedDeadline);
          }
        }
        return actionDeadline;
      }
      try {
      ensureNotAborted(intent.signal);
      if (intent.source === 'agent' && intent.owner && intent.tabId > 0
            && typeof sessions.retainOwnerLease === 'function') {
          await boundedCall(function () { return sessions.retainOwnerLease(intent.tabId, {
            owner: 'AgentGeneration:' + intent.owner,
            type: 'agent-generation',
            signal: intent.signal || null,
          }); }, actionDeadline, 'CDP lease', intent.signal);
      }
      if (intent.kind === 'createTab') {
        beginExecution();
        var createProperties = {};
        ['url', 'active', 'windowId', 'pinned', 'index', 'openerTabId'].forEach(function (key) {
          if (intent.input[key] !== undefined) createProperties[key] = intent.input[key];
        });
        mutationAttempted = true;
        var createdTab = await boundedCall(function () { return chromeApi.tabs.create(createProperties); }, actionDeadline, 'create-tab', intent.signal);
        actualTabId = Number(createdTab && createdTab.id) || 0;
        derivedFacts.createdTab = factContract.clone(createdTab || {});
        derivedFacts.tabId = actualTabId;
        derivedFacts.url = String(createdTab && (createdTab.pendingUrl || createdTab.url) || createProperties.url || '');
        responses.push({ method: 'chrome.tabs.create', response: factContract.clone(createdTab || {}), completedAt: new Date().toISOString() });
      } else if (intent.kind === 'activateTab') {
        beginExecution();
        var tab = await boundedCall(function () { return chromeApi.tabs.get(intent.tabId); }, actionDeadline, 'read-tab', intent.signal);
        mutationAttempted = true;
        responses.push({ method: 'chrome.tabs.update', response: await boundedCall(function () { return chromeApi.tabs.update(intent.tabId, { active: true }); }, actionDeadline, 'activate-tab', intent.signal), completedAt: new Date().toISOString() });
        if (intent.input.focusWindow === true) {
          responses.push({ method: 'chrome.windows.update', response: await boundedCall(function () { return chromeApi.windows.update(tab.windowId, { focused: true }); }, actionDeadline, 'focus-window', intent.signal), completedAt: new Date().toISOString() });
        }
      } else if (intent.kind === 'closeTab') {
        beginExecution();
        mutationAttempted = true;
        await boundedCall(function () { return sessions.closeTab(intent.tabId, { expectTabRemoval: true, owner: intent.owner }); }, actionDeadline, 'close-tab-session', intent.signal);
        try {
          await boundedCall(function () { return chromeApi.tabs.remove(intent.tabId); }, actionDeadline, 'close-tab', intent.signal);
        } catch (error) {
          if (typeof sessions.cancelExpectedTabClose === 'function') sessions.cancelExpectedTabClose(intent.tabId);
          throw error;
        }
        responses.push({ method: 'chrome.tabs.remove', response: { closed: true }, completedAt: new Date().toISOString() });
      } else if (intent.kind === 'handleDialog') {
          var dialogStartedAt = new Date().toISOString();
          derivedFacts.dialog = await armDialog(intent, beginExecution, actionDeadline, function () { mutationAttempted = true; });
          var dialogCompletedAt = new Date().toISOString();
          if (derivedFacts.dialog.handled === true) {
            records.push({
              method: 'Page.handleJavaScriptDialog',
              params: { accept: derivedFacts.dialog.action !== 'dismiss', promptText: intent.sensitive ? '[REDACTED]' : String(intent.input.promptText || '') },
              mutation: true, primary: true, accepted: true,
              startedAt: dialogStartedAt, completedAt: dialogCompletedAt, provenance: 'cdp',
            });
            responses.push({ method: 'Page.handleJavaScriptDialog', response: { handled: true }, completedAt: dialogCompletedAt });
          } else {
            responses.push({ method: 'Page.handleJavaScriptDialog.policy', response: derivedFacts.dialog, completedAt: dialogCompletedAt });
          }
        } else {
          ensureNotAborted(intent.signal);
          await boundedCall(function () { return sessions.withLease(intent.tabId, {
            owner: 'PageActionEngine:' + (intent.owner || intent.actionId),
            type: intent.source === 'flow' ? 'flow-action' : 'short',
            signal: intent.signal || null,
          }, async function (rawSend) {
            ensureNotAborted(intent.signal);
            if (shouldTrackNewTabs(intent)) {
              try { tabBaseline = await readAllTabs(); }
              catch (error) { browserFactsError = error; }
            }
            beginExecution();
            var send = deadlineSender(rawSend, actionDeadline, intent);
            if (/^(?:click|doubleClick|contextClick|hover|type|fill|press|select|check|scroll|drag|upload)$/.test(intent.kind)) {
              var targetDispatch = await dispatchTargetAction(send, intent, null, records, responses, derivedFacts, actionDeadline, readinessPlanned ? async function (resolvedTarget) {
                var frameId = resolvedTarget && resolvedTarget.target && resolvedTarget.target.frameId || '';
                // Reuse the baseline taken before target lookup. An implicitly
                // resolved iframe needs its own observation before input.
                if (!readinessBaseline || frameId && readinessBaseline.scope.indexOf(frameId) === -1) {
                  try {
                    var frameDeadline = preparationDeadline(actionDeadline);
                    if (readinessBaseline) await readinessBarrier.waitBeforeAction(intent.tabId, {
                      send: rawSend, frameId: frameId, signal: intent.signal,
                      readiness: readinessPlanned, deadline: frameDeadline,
                    });
                    readinessBaseline = await readinessBarrier.captureBaseline(intent.tabId, {
                      send: rawSend, frameId: frameId, signal: intent.signal,
                      readiness: readinessPlanned, deadline: frameDeadline,
                    });
                  } catch (error) {
                    readinessBaseline = null;
                    derivedFacts.readiness = readinessBarrier.warningReport(error, {
                      mode: 'baseline', tabId: intent.tabId, frameId: frameId, signal: intent.signal,
                    });
                  }
                }
                if (readinessBaseline) derivedFacts.navigationBaseline = {
                  url: readinessBaseline.navigation.url,
                  loaderId: readinessBaseline.navigation.loaderId,
                  documentId: readinessBaseline.navigation.documentId,
                };
              } : null);
              resolved = targetDispatch.resolved;
            } else {
              resolved = await dispatchNonTarget(send, intent, records, responses, derivedFacts, actionDeadline);
            }
          }); }, actionDeadline, 'CDP 页面动作', intent.signal);
        }
      // 4. the CDP command queue is released → 5. wait for readiness while this
      // tab's action queue is still held, so the next action cannot interleave.
      if (readinessBaseline) {
        derivedFacts.readiness = await awaitActionReadiness(intent, readinessBaseline, readinessPlanned, resolved, records, actionDeadline);
      }
      if (!startedMs) {
        startedMs = requestedMs;
        startedAt = new Date(startedMs).toISOString();
        if (!(actionDeadline > 0)) actionDeadline = Date.now() + intent.timeoutMs;
      }
      if (intent.signal && intent.signal.aborted) {
        throw actionCancelled(intent.signal);
      }
      var browserFacts = { facts: [], newTabs: [], ambiguous: false };
      if (tabBaseline) {
        try {
          browserFacts = await abortablePromise(readBrowserFacts(tabBaseline, intent.tabId), intent.signal);
        } catch (error) {
          if (intent.signal && intent.signal.aborted) {
            throw actionCancelled(intent.signal);
          }
          browserFactsError = error;
        }
      }
      var completedAt = new Date().toISOString();
      var mutationDispatched = records.some(function (record) { return record.mutation === true && record.accepted === true; });
      var lifecycleDispatched = /^(?:createTab|activateTab|closeTab)$/.test(intent.kind) && responses.length > 0;
      var warnings = [];
      if (browserFactsError) warnings.push('BROWSER_FACTS_UNAVAILABLE: ' + String(browserFactsError.message || browserFactsError));
      if (derivedFacts.upload && derivedFacts.upload.cleanupPending) warnings.push('UPLOAD_TEMP_CLEANUP_FAILED: 上传临时文件清理待重试');
      if (derivedFacts.readiness && derivedFacts.readiness.warning === true) {
        warnings.push(String(derivedFacts.readiness.warningCode || 'PAGE_READINESS_INCOMPLETE') + ': ' + String(derivedFacts.readiness.warningMessage || derivedFacts.readiness.reason || '页面状态未在时限内稳定，已继续执行'));
      }
      if (derivedFacts.preReadiness && derivedFacts.preReadiness.warning === true && derivedFacts.preReadiness !== derivedFacts.readiness) {
        warnings.push(derivedFacts.preReadiness.warningCode + ': ' + derivedFacts.preReadiness.warningMessage);
      }
      var actionFacts = actionContract.createActionFacts({
        actionId: intent.actionId, tabId: actualTabId, kind: intent.kind,
        target: resolved && resolved.target ? { targetRef: resolved.targetRef, targetId: resolved.target.targetId, frameId: resolved.target.frameId, backendNodeId: resolved.target.backendNodeId, fingerprint: resolved.target.fingerprint } : null,
        actualCoordinates: intent.kind === 'scroll'
          ? derivedFacts.wheelPoint || null
          : resolved && resolved.coordinates || null,
        relatedTargets: derivedFacts.dragDestination ? [{
          relation: 'destination', targetRef: derivedFacts.dragDestination.targetRef,
        }] : [],
        coordinateFacts: derivedFacts.dragDestination ? [
          { role: 'source', x: derivedFacts.dragSource.coordinates.x, y: derivedFacts.dragSource.coordinates.y },
          { role: 'destination', x: derivedFacts.dragDestination.coordinates.x, y: derivedFacts.dragDestination.coordinates.y },
        ] : (derivedFacts.wheelPoint ? [{ role: 'wheel', x: derivedFacts.wheelPoint.x, y: derivedFacts.wheelPoint.y }] : []),
        commands: records, browserResponses: responses,
        inputProvenance: /^(?:createTab|activateTab|closeTab)$/.test(intent.kind) ? 'chrome.tabs' : 'cdp',
        dispatched: mutationDispatched || lifecycleDispatched,
        transportInterrupted: false,
        failure: null,
        startedAt: startedAt, completedAt: completedAt, durationMs: Date.now() - startedMs,
        warnings: warnings,
      });
      var receiptInput = {
        intent: actualTabId !== intent.tabId ? Object.assign({}, intent, { tabId: actualTabId }) : intent,
        actionFacts: actionFacts,
        browserFacts: browserFacts,
        browserFactsError: browserFactsError,
        targetRef: resolved && resolved.targetRef || intent.targetRef || null,
        derivedFacts: derivedFacts,
      };
      var receipt = await abortablePromise(verification.createReceipt(receiptInput), intent.signal);
      return Object.freeze({ receipt: receipt, actionFacts: actionFacts, browserFacts: browserFacts, derivedFacts: factContract.clone(derivedFacts), error: null });
      } catch (error) {
        // A click can synchronously navigate or replace the document. Chrome
        // may accept the mouse release and then lose the old CDP document
        // while a follow-up frame lookup is in flight. In that case the page
        // already received the complete click; report it as completed with a
        // warning instead of turning the post-click observation timeout into
        // a failed node.
        var postClickFrameTimeout = /^(?:click|doubleClick|contextClick)$/.test(intent.kind)
          && /^(?:ACTION_TIMEOUT|PAGE_READINESS_TIMEOUT|PAGE_STATE_UNAVAILABLE|PAGE_READINESS_UNAVAILABLE)$/.test(String(error && error.code || ''))
          && /Page\.getFrameTree/.test(String(error && error.message || ''))
          && records.some(function (record) {
            return record.accepted === true
              && record.method === 'Input.dispatchMouseEvent'
              && record.params && record.params.type === 'mouseReleased';
          });
        if (postClickFrameTimeout) {
          var clickCompletedAt = new Date().toISOString();
          var clickFacts = actionContract.createActionFacts({
            actionId: intent.actionId,
            tabId: actualTabId,
            kind: intent.kind,
            target: resolved && resolved.target ? {
              targetRef: resolved.targetRef,
              targetId: resolved.target.targetId,
              frameId: resolved.target.frameId,
              backendNodeId: resolved.target.backendNodeId,
              fingerprint: resolved.target.fingerprint,
            } : null,
            actualCoordinates: resolved && resolved.coordinates || null,
            relatedTargets: [], coordinateFacts: [], commands: records,
            browserResponses: responses,
            inputProvenance: 'cdp', dispatched: true,
            transportInterrupted: false, failure: null,
            startedAt: startedAt || new Date(requestedMs).toISOString(),
            completedAt: clickCompletedAt,
            durationMs: Math.max(0, Date.parse(clickCompletedAt) - Date.parse(startedAt || new Date(requestedMs).toISOString())),
            warnings: ['CLICK_POST_ACTION_FRAME_TIMEOUT: 点击已发送，后续页面 frame 观测超时'],
          });
          var clickReceipt = await verification.createReceipt({
            intent: actualTabId !== intent.tabId ? Object.assign({}, intent, { tabId: actualTabId }) : intent,
            actionFacts: clickFacts,
            browserFacts: { facts: [], newTabs: [], ambiguous: false },
            browserFactsError: error,
            targetRef: resolved && resolved.targetRef || intent.targetRef || null,
            derivedFacts: derivedFacts,
          });
          return Object.freeze({ receipt: clickReceipt, actionFacts: clickFacts, browserFacts: { facts: [], newTabs: [], ambiguous: false }, derivedFacts: factContract.clone(derivedFacts), error: null });
        }
        // Once a CDP command or browser lifecycle call has been recorded, a
        // later parse/verification failure cannot prove that no side effect
        // happened. Preserve target-resolution retries, but never replay an
        // action whose execution state is uncertain.
        var hasExecutionEvidence = mutationAttempted
          || records.some(function (record) { return record.mutation === true; })
          || responses.some(function (response) { return response.mutation === true; });
        var performed = error && /^(?:yes|no|unknown)$/.test(String(error.performed || ''))
          ? String(error.performed)
          : (hasExecutionEvidence ? 'unknown' : 'no');
        if (hasExecutionEvidence && error && (typeof error === 'object' || typeof error === 'function')) {
          try {
            error.performed = 'unknown';
            error.retryable = false;
          } catch (_) {}
          performed = 'unknown';
        }
        // Every page action failure carries the same ActionReceipt shape as a
        // successful action. This is especially important for target lookup
        // failures: node-level retry policy must see performed="no", while a
        // transport error after an accepted input must remain
        // performed="unknown" and non-retryable.
        if (error && typeof error === 'object' && !error.receipt) {
          try {
            var failureStartedAt = startedAt || new Date(requestedMs).toISOString();
            var failureCompletedAt = new Date().toISOString();
            var failureFacts = actionContract.createActionFacts({
              actionId: intent.actionId,
              tabId: actualTabId,
              kind: intent.kind,
              target: resolved && resolved.target ? {
                targetRef: resolved.targetRef,
                targetId: resolved.target.targetId,
                frameId: resolved.target.frameId,
                backendNodeId: resolved.target.backendNodeId,
                fingerprint: resolved.target.fingerprint,
              } : null,
              actualCoordinates: intent.kind === 'scroll'
                ? derivedFacts.wheelPoint || null : resolved && resolved.coordinates || null,
              relatedTargets: [], coordinateFacts: [], commands: records,
              browserResponses: responses,
              inputProvenance: /^(?:createTab|activateTab|closeTab)$/.test(intent.kind) ? 'chrome.tabs' : 'cdp',
              dispatched: mutationAttempted || records.some(function (record) { return record.mutation === true && record.accepted === true; })
                || responses.some(function (response) { return response.mutation === true; }),
              transportInterrupted: performed === 'unknown',
              failure: { code: String(error.code || 'PAGE_ACTION_FAILED'), message: String(error.message || error), details: error.details || null },
              startedAt: failureStartedAt,
              completedAt: failureCompletedAt,
              durationMs: Math.max(0, Date.parse(failureCompletedAt) - Date.parse(failureStartedAt)),
              warnings: [],
            });
            var failureReceipt = await verification.createReceipt({
              intent: actualTabId !== intent.tabId ? Object.assign({}, intent, { tabId: actualTabId }) : intent,
              actionFacts: failureFacts,
              browserFacts: { facts: [], newTabs: [], ambiguous: false },
              browserFactsError: browserFactsError,
              targetRef: resolved && resolved.targetRef || intent.targetRef || null,
              derivedFacts: derivedFacts,
            });
            error.receipt = failureReceipt;
            error.actionReceipt = failureReceipt;
          } catch (_) {}
        }
        throw error;
      }
    }
    async function executeForm(rawIntent, hooks) {
      rawIntent = rawIntent || {};
      var aggregateIntent = actionContract.normalizeIntent(rawIntent);
      ensureNotAborted(aggregateIntent.signal);
      hooks = hooks || {};
      var aggregatePlan = readinessPlan(aggregateIntent);
      var preparation = hooks.readinessPreparation || await prepareReadiness(aggregateIntent, aggregatePlan, hooks.actionDeadline);
      var aggregateRequestedMs = Date.now();
      var aggregateStartedMs = Number(hooks.actionStartedMs) > 0 ? Number(hooks.actionStartedMs) : 0;
      if (!aggregateStartedMs) aggregateStartedMs = aggregateRequestedMs;
      var aggregateStartedAt = aggregateStartedMs ? new Date(aggregateStartedMs).toISOString() : '';
      var aggregateDeadline = Number(hooks.actionDeadline) > 0
        ? Number(hooks.actionDeadline)
        : aggregateStartedMs + aggregateIntent.timeoutMs;
      var input = rawIntent.input || {};
      var aggregateConfirmationDeferred = String(input.confirmationMode || '') === 'deferred';
      function failedForm(code, message, details) {
        if (!aggregateStartedMs) {
          aggregateStartedMs = aggregateRequestedMs;
          aggregateStartedAt = new Date(aggregateStartedMs).toISOString();
        }
        var completedAt = new Date().toISOString();
        var receipt = verification.createFactReceipt({
          actionId: aggregateIntent.actionId, source: aggregateIntent.source, tabId: aggregateIntent.tabId,
          kind: 'fillFormFields', failure: true, performed: 'no', inputProvenance: 'cdp',
          signals: ['form_input_invalid'], evidence: [{ kind: 'form_input', details: details || null }], reason: message,
          startedAt: aggregateStartedAt, completedAt: completedAt,
        });
        return { ok: false, total: 0, passed: 0, confirmed: 0, unconfirmed: 0, failed: 1, results: [], receipt: receipt, actionFacts: receipt.actionFacts, derivedFacts: { ok: false, total: 0, passed: 0, confirmed: 0, unconfirmed: 0, failed: 1, results: [] }, browserFacts: { facts: [], newTabs: [], ambiguous: false }, error: { code: code, message: message, details: details || null } };
      }
      var standardForm;
      try {
        standardForm = await standardActions.executeForm(input, {
          confirmationDeferred: aggregateConfirmationDeferred,
          executeField: async function (spec) {
            var fieldStartedAt = new Date().toISOString();
            var fieldTimeoutMs = Number(spec.field.timeoutMs) > 0 ? Number(spec.field.timeoutMs) : aggregateIntent.timeoutMs;
            fieldTimeoutMs = Math.max(100, Math.min(fieldTimeoutMs, 120000));
            var fieldStartedMs = Date.now();
            try {
              return await executeUnsafe({
                source: rawIntent.source,
                owner: rawIntent.owner,
                tabId: rawIntent.tabId,
                kind: spec.kind,
                locator: spec.locator,
                // The form is one node: its automatic wait belongs at the
                // form boundaries. Per-field policies/expectations stay explicit.
                input: Object.assign({}, spec.input, {
                  readiness: spec.field.readiness !== undefined ? spec.field.readiness : spec.field.expect ? spec.input.readiness : false,
                }),
                expect: spec.field.expect || null,
                timeoutMs: fieldTimeoutMs,
                sensitive: rawIntent.sensitive === true || spec.field.sensitive === true,
                signal: aggregateIntent.signal,
              }, {
                actionStartedMs: fieldStartedMs,
                actionDeadline: Math.min(aggregateDeadline, fieldStartedMs + fieldTimeoutMs),
              });
            } catch (error) {
              if (String(error && error.code || '') === 'ACTION_CANCELLED') throw error;
              var failedAt = new Date().toISOString();
              var childReceipt = verification.createFactReceipt({
                source: rawIntent.source, tabId: rawIntent.tabId, kind: spec.kind,
                failure: true, performed: error && error.performed || 'unknown', inputProvenance: 'cdp',
                signals: ['form_field_failed'], evidence: [{ kind: 'form_field', field: spec.field.label || spec.field.selector || '' }],
                reason: String(error && error.message || error), startedAt: fieldStartedAt, completedAt: failedAt,
              });
              return { receipt: childReceipt, actionFacts: childReceipt.actionFacts, browserFacts: { facts: [], newTabs: [], ambiguous: false }, derivedFacts: {}, error: {
                code: String(error && error.code || 'FORM_FIELD_FAILED'), message: String(error && error.message || error), details: error && error.details || null,
              } };
            }
          },
        });
      } catch (error) {
        if (String(error && error.code || '') === 'ACTION_CANCELLED') throw error;
        return failedForm(String(error && error.code || 'ACTION_INVALID'), String(error && error.message || error), error && error.details || null);
      }
      var fieldsInput = standardForm.fields;
      var results = standardForm.results;
      var aggregateBrowserFacts = standardForm.browserFacts;
      var failed = results.filter(function (result) { return result.receipt.status === 'failed' && result.skipped !== true; }).length;
      var unconfirmed = results.filter(function (result) { return result.receipt.status === 'unconfirmed' && result.skipped !== true; }).length;
      var confirmed = results.filter(function (result) { return result.skipped === true || result.receipt.status === 'confirmed'; }).length;
      if (!aggregateStartedMs) {
        aggregateStartedMs = aggregateRequestedMs;
        aggregateStartedAt = new Date(aggregateStartedMs).toISOString();
      }
      var allFieldsProcessed = results.length === fieldsInput.length;
      var readinessFacts = preparation ? { preReadiness: preparation.report } : {};
      if (preparation && preparation.baseline) {
        readinessFacts.navigationBaseline = preparation.baseline.navigation;
        var commands = results.reduce(function (all, child) {
          return all.concat(child.receipt && child.receipt.actionFacts && child.receipt.actionFacts.commands || []);
        }, []);
        readinessFacts.readiness = await awaitActionReadiness(aggregateIntent, preparation.baseline, aggregatePlan, null, commands, aggregateDeadline);
      } else if (preparation) readinessFacts.readiness = preparation.report;
      var readinessWarnings = [readinessFacts.preReadiness, readinessFacts.readiness].filter(function (report, index, reports) {
        return report && report.warning && reports.indexOf(report) === index;
      }).map(function (report) { return report.warningCode + ': ' + report.warningMessage; });
      var completedAt = new Date().toISOString();
      var receipt = await abortablePromise(verification.createAggregateReceipt({
        intent: aggregateIntent,
        children: results,
        complete: allFieldsProcessed,
        derivedFacts: readinessFacts,
        warnings: readinessWarnings,
        startedAt: aggregateStartedAt,
        completedAt: completedAt,
        durationMs: Date.now() - aggregateStartedMs,
      }), aggregateIntent.signal);
      var derivedFacts = Object.assign({ ok: receipt.status === 'confirmed' && allFieldsProcessed, total: fieldsInput.length, processed: results.length, passed: confirmed, confirmed: confirmed, unconfirmed: unconfirmed, failed: failed, results: results }, readinessFacts);
      var aggregateError = null;
      if (receipt.status === 'failed') {
        var firstChildError = results.map(function (result) { return result && result.error; }).find(Boolean);
        aggregateError = firstChildError ? {
          code: String(firstChildError.code || 'FORM_ACTION_FAILED'),
          message: String(firstChildError.message || receipt.verification.reason),
          details: firstChildError.details || { failed: failed, processed: results.length, total: fieldsInput.length },
          fatalFlow: firstChildError.fatalFlow === true,
        } : { code: 'FORM_ACTION_FAILED', message: receipt.verification.reason, details: { failed: failed, processed: results.length, total: fieldsInput.length } };
      } else if (!allFieldsProcessed) {
        aggregateError = { code: 'FORM_ACTION_INCOMPLETE', message: '表单字段未全部执行', details: { processed: results.length, total: fieldsInput.length } };
      }
      return { ok: derivedFacts.ok, total: derivedFacts.total, processed: derivedFacts.processed, passed: derivedFacts.passed, confirmed: confirmed, unconfirmed: unconfirmed, failed: failed, results: results, receipt: receipt, actionFacts: receipt.actionFacts, derivedFacts: derivedFacts, browserFacts: aggregateBrowserFacts, error: aggregateError };
    }
    function execute(rawIntent, hooks) {
      var intent;
      try {
        intent = actionContract.normalizeIntent(rawIntent);
        validateAgentScrollIntent(intent);
      }
      catch (error) { return Promise.reject(error); }
      hooks = hooks || {};
      // Queue wait is transport preparation. Start the action clock when this
      // tab reaches the serialized execution slot, unless the caller supplied
      // an explicit shared start/deadline (for an aggregate operation).
      var actionStartedMs = Number(hooks.actionStartedMs) > 0 ? Number(hooks.actionStartedMs) : 0;
      var actionDeadline = Number(hooks.actionDeadline) > 0 ? Number(hooks.actionDeadline) : 0;
      var executionHooks = Object.assign({}, hooks, {
        actionStartedMs: actionStartedMs,
        actionDeadline: actionDeadline,
      });
      var running = enqueueAction(intent.tabId, intent.signal, async function () {
        ensureNotAborted(intent.signal);
        // Automatic preparation has its own short budget. Start the normal
        // action clock afterwards so a busy page does not consume input time.
        executionHooks.readinessPreparation = await prepareReadiness(intent, readinessPlan(intent), executionHooks.actionDeadline);
        ensureNotAborted(intent.signal);
        if (!(Number(executionHooks.actionStartedMs) > 0)) {
          executionHooks.actionStartedMs = Date.now();
          if (!(Number(executionHooks.actionDeadline) > 0)) {
            executionHooks.actionDeadline = executionHooks.actionStartedMs + intent.timeoutMs;
          }
          if (typeof hooks.onReady === 'function') {
            var sharedDeadline = Number(hooks.onReady(executionHooks.actionStartedMs));
            if (Number.isFinite(sharedDeadline) && sharedDeadline > 0) {
              executionHooks.actionDeadline = Math.min(executionHooks.actionDeadline, sharedDeadline);
            }
          }
        } else if (!(Number(executionHooks.actionDeadline) > 0)) {
          executionHooks.actionDeadline = executionHooks.actionStartedMs + intent.timeoutMs;
        }
        if (remainingActionMs(executionHooks.actionDeadline) < 1) throw actionTimeout('页面动作');
        return intent.kind === 'fillFormFields' ? executeForm(intent, executionHooks) : executeUnsafe(intent, executionHooks);
      });
      return abortablePromise(running, intent.signal);
    }
    function act(rawIntent, hooks) { return execute(rawIntent, hooks); }
    function cleanupOwner(owner, cleanupOptions) {
      var policyTasks = [];
      policyTasks.push(files.cleanupOwner(owner));
      policyTasks.push(sessions.releaseOwner(owner, cleanupOptions));
      return Promise.all(policyTasks);
    }
    return Object.freeze({ execute: execute, act: act, executeForm: executeForm, cleanupOwner: cleanupOwner });
  }
  return Object.freeze({ API_VERSION: API_VERSION, createPageActionEngine: createPageActionEngine });
});
