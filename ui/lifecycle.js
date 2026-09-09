(function attachPageAutomationLifecycle(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function once(cleanup) {
    var active = true;
    return function () {
      if (!active) return;
      active = false;
      cleanup();
    };
  }

  function create(timerHost) {
    timerHost = timerHost || (typeof window !== 'undefined' ? window : globalThis);
    var cleanups = [];
    var destroyed = false;

    function add(cleanup) {
      if (typeof cleanup !== 'function') return function () {};
      var dispose = once(cleanup);
      if (destroyed) dispose();
      else cleanups.push(dispose);
      return dispose;
    }

    function listen(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') return function () {};
      target.addEventListener(type, handler, options);
      return add(function () {
        target.removeEventListener(type, handler, options);
      });
    }

    function subscribe(event, handler) {
      if (!event || typeof event.addListener !== 'function') return function () {};
      event.addListener(handler);
      return add(function () {
        if (typeof event.removeListener === 'function') event.removeListener(handler);
      });
    }

    function interval(handler, delay) {
      var id = timerHost.setInterval(handler, delay);
      add(function () { timerHost.clearInterval(id); });
      return id;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (_) {}
      }
    }

    return {
      add: add,
      listen: listen,
      subscribe: subscribe,
      interval: interval,
      destroy: destroy,
      isDestroyed: function () { return destroyed; },
    };
  }

  return { create: create };
});
