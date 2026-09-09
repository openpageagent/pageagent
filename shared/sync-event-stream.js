// Sync Event Stream — 跨扩展上下文广播可订阅的共享数据变更
(function attachSyncEventStream(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationSyncEventStream = api;
})(globalThis, function () {
  'use strict';

  var API_VERSION = 1;
  var MESSAGE_TYPE = 'SYNC_EVENT';
  var sequence = 0;

  function own(value, key) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
  }

  function text(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function createEventId() {
    sequence += 1;
    return 'sync_' + Date.now().toString(36) + '_' + sequence.toString(36)
      + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalizeEvent(input) {
    input = input && typeof input === 'object' ? input : {};
    var event = {
      version: Number(input.version) || 1,
      eventId: text(input.eventId || input.idempotencyKey || createEventId()),
      scope: text(input.scope || 'shared'),
      resource: text(input.resource || 'config'),
      section: text(input.section),
      action: text(input.action || 'changed'),
      id: text(input.id),
      timestamp: Number(input.timestamp) || Date.now(),
    };
    if (own(input, 'source')) event.source = text(input.source);
    if (own(input, 'runtime')) event.runtime = text(input.runtime);
    if (own(input, 'meta') && input.meta && typeof input.meta === 'object') event.meta = input.meta;
    return Object.freeze(event);
  }

  function create(options) {
    options = options || {};
    var runtime = options.runtime || (typeof chrome !== 'undefined' && chrome.runtime);
    var listeners = [];
    var seen = Object.create(null);
    var destroyed = false;

    function remember(eventId) {
      if (!eventId) return false;
      if (seen[eventId]) return true;
      seen[eventId] = true;
      var keys = Object.keys(seen);
      if (keys.length > 256) delete seen[keys[0]];
      return false;
    }

    function emit(input) {
      if (destroyed) return null;
      var event = normalizeEvent(input);
      if (remember(event.eventId)) return event;
      listeners.slice().forEach(function (listener) {
        try { listener(event); } catch (_) {}
      });
      return event;
    }

    function handleMessage(message) {
      if (destroyed || !message || message.type !== MESSAGE_TYPE) return;
      emit(message.event || message.payload || {});
    }

    if (runtime && runtime.onMessage && typeof runtime.onMessage.addListener === 'function') {
      runtime.onMessage.addListener(handleMessage);
    }

    function subscribe(listener) {
      if (destroyed || typeof listener !== 'function') return function () {};
      listeners.push(listener);
      return function unsubscribe() {
        var index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }

    function publish(input) {
      var event = emit(input);
      if (!event) return null;
      if (runtime && typeof runtime.sendMessage === 'function') {
        try {
          var sent = runtime.sendMessage({ type: MESSAGE_TYPE, event: event });
          if (sent && typeof sent.catch === 'function') sent.catch(function () {});
        } catch (_) {}
      }
      return event;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (runtime && runtime.onMessage && typeof runtime.onMessage.removeListener === 'function') {
        try { runtime.onMessage.removeListener(handleMessage); } catch (_) {}
      }
      listeners.length = 0;
      seen = Object.create(null);
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      subscribe: subscribe,
      emit: emit,
      publish: publish,
      destroy: destroy,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    MESSAGE_TYPE: MESSAGE_TYPE,
    create: create,
  });
});
