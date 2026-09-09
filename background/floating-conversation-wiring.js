// Sidepanel run-focus relay retained after removal of the legacy floating conversation UI.
(function attachFloatingConversationWiring(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.FloatingConversationWiring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('FloatingConversationWiring missing dependency: ' + name);
    return value;
  }

  function requireMethod(value, method, name) {
    var descriptor;
    try { descriptor = value && Object.getOwnPropertyDescriptor(value, method); } catch (_) {}
    if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'function') {
      throw new Error('FloatingConversationWiring missing dependency: ' + name + '.' + method);
    }
    return descriptor.value.bind(value);
  }

  function create(deps) {
    deps = deps || {};
    var contract = deps.messageContract;
    if (!contract || contract.API_VERSION !== 1 || !contract.TYPES) {
      throw new Error('FloatingConversationWiring missing dependency: messageContract');
    }
    var runtimeSendMessage = requireMethod(deps.chrome && deps.chrome.runtime, 'sendMessage', 'chrome.runtime');
    var conversationRunId = requireFunction(deps.conversationRunId, 'conversationRunId');
    var schedule = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
    var cancelSchedule = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
    var focusTimers = [];
    var generation = 1;
    var destroyed = false;
    var suspending = false;

    function live(expectedGeneration) {
      return !destroyed && !suspending
        && (expectedGeneration === undefined || expectedGeneration === generation);
    }

    function cancelFocusTimers() {
      generation += 1;
      while (focusTimers.length) {
        try { cancelSchedule(focusTimers.pop()); } catch (_) {}
      }
    }

    function focusRun(payload, target) {
      if (!live()) return false;
      payload = payload || {};
      target = target || {};
      var runId = String(payload.runId || payload.sessionId || '').trim();
      var topicId = String(payload.topicId || '').trim();
      if (!runId && topicId) runId = conversationRunId(topicId);
      if (!runId) return false;
      var built = contract.request(contract.TYPES.SIDEPANEL_FOCUS_RUN, {
        runId: runId,
        topicId: topicId,
        kind: 'conversation',
        label: String(payload.label || '').trim(),
        ownerTabId: Number(payload.ownerTabId || target.tabId || 0) || 0,
        windowId: Number(payload.windowId || target.windowId || 0) || 0,
        entry: 'sidepanel',
      });
      if (!built.ok) return false;
      var focusGeneration = generation;
      function send() {
        if (!live(focusGeneration)) return;
        try { Promise.resolve(runtimeSendMessage(built.message)).catch(function () {}); } catch (_) {}
      }
      send();
      try {
        var timerId = schedule(function () {
          var index = focusTimers.indexOf(timerId);
          if (index >= 0) focusTimers.splice(index, 1);
          send();
        }, 350);
        focusTimers.push(timerId);
      } catch (_) {}
      return true;
    }

    function suspend() {
      if (destroyed || suspending) return false;
      suspending = true;
      cancelFocusTimers();
      return true;
    }

    function resume() {
      if (destroyed || !suspending) return false;
      suspending = false;
      generation += 1;
      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      suspending = false;
      cancelFocusTimers();
    }

    return Object.freeze({
      focusRun: focusRun,
      suspend: suspend,
      resume: resume,
      destroy: destroy,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
