// Provider compatibility registry. Protocol providers depend only on this file.
(function attachProviderCompat(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var api = factory();
  if (commonJs) {
    api.register(require('./deepseek'));
    module.exports = api;
  } else {
    root.ProviderCompat = api;
    var pending = Array.isArray(root.PendingProviderCompats) ? root.PendingProviderCompats.splice(0) : [];
    pending.forEach(api.register);
    if (root.importScripts) {
      root.importScripts('agent/providers/compat/deepseek.js');
    } else if (typeof document !== 'undefined' && document.write) {
      var current = document.currentScript && document.currentScript.src;
      var source = current ? current.replace(/index\.js(?:[?#].*)?$/i, 'deepseek.js') : 'deepseek.js';
      document.write('<script src="' + source.replace(/"/g, '&quot;') + '"><\/script>');
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var adapters = [];
  var passthroughTarget = Object.freeze({});

  function adapterId(adapter) {
    return String(adapter && adapter.id || '').trim();
  }

  function register(adapter) {
    var id = adapterId(adapter);
    if (!id || typeof adapter.matches !== 'function' || typeof adapter.create !== 'function') {
      throw new TypeError('Provider compat adapter requires id, matches, and create');
    }
    var existingIndex = adapters.findIndex(function (candidate) { return adapterId(candidate) === id; });
    if (existingIndex >= 0) adapters.splice(existingIndex, 1);
    adapters.push(adapter);
    adapters.sort(function (left, right) {
      return (Number(right.priority) || 0) - (Number(left.priority) || 0);
    });
    return api;
  }

  function passthrough() {
    return Object.freeze({
      active: false,
      id: '',
      target: passthroughTarget,
      endpoint: function (endpoint) { return endpoint; },
      beforeRequest: function (request) {
        request = request || {};
        return { body: request.body || {}, headers: request.headers || {} };
      },
      createResponseState: function () { return {}; },
      onResponseEvent: function () { return []; },
      afterResponse: function (result) { return result; },
    });
  }

  function normalizeResolved(adapter, resolved) {
    resolved = resolved || {};
    return Object.freeze({
      active: true,
      id: adapterId(adapter),
      target: Object.freeze(Object.assign({}, resolved.target || {})),
      endpoint: typeof resolved.endpoint === 'function'
        ? resolved.endpoint
        : function (endpoint) { return endpoint; },
      beforeRequest: typeof resolved.beforeRequest === 'function'
        ? resolved.beforeRequest
        : function (request) {
          request = request || {};
          return { body: request.body || {}, headers: request.headers || {} };
        },
      createResponseState: typeof resolved.createResponseState === 'function'
        ? resolved.createResponseState
        : function () { return {}; },
      onResponseEvent: typeof resolved.onResponseEvent === 'function'
        ? resolved.onResponseEvent
        : function () { return []; },
      afterResponse: typeof resolved.afterResponse === 'function'
        ? resolved.afterResponse
        : function (result) { return result; },
    });
  }

  function resolve(service, protocol) {
    for (var index = 0; index < adapters.length; index += 1) {
      var adapter = adapters[index];
      if (adapter.matches(service, protocol)) {
        return normalizeResolved(adapter, adapter.create(service, protocol));
      }
    }
    return passthrough();
  }

  var api = {
    API_VERSION: API_VERSION,
    register: register,
    resolve: resolve,
  };
  return Object.freeze(api);
});
