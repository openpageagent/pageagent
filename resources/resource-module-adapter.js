// Binds one independently owned first-level resource module to an ARP adapter.
(function attachResourceModuleAdapter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!arp) throw new Error('AgentResourceProtocol must load before ResourceModuleAdapter');
  var api = factory(arp);
  if (commonJs) module.exports = api;
  else root.ResourceModuleAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp) {
  'use strict';

  var METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

  function create(input) {
    input = input || {};
    var rootName = String(input.root || '').trim();
    var resource = input.resource;
    if (!resource || !Array.isArray(resource.routeContracts) || !resource.handlers) {
      throw new TypeError('ResourceModuleAdapter requires a resource with routeContracts and handlers');
    }
    var routeContracts = resource.routeContracts.filter(function (route) {
      return route && route.root === rootName;
    });
    if (!routeContracts.length) throw new TypeError('Resource module has no routes for /' + rootName);

    function invoke(method, context, request) {
      var table = resource.handlers[method] || {};
      var handler = table[request.routeTemplate];
      if (!handler) {
        throw arp.arpError('METHOD_NOT_ALLOWED', '/' + rootName + ' has no handler for '
          + method + ' ' + request.routeTemplate);
      }
      return Promise.resolve(handler(request, context || {}));
    }

    var definition = { root: rootName, routeContracts: routeContracts };
    METHODS.forEach(function (method) {
      definition[method.toLowerCase()] = function (context, request) {
        return invoke(method, context, request);
      };
    });
    if (input.introspect) definition.introspect = input.introspect;
    var adapter = arp.defineAdapter(definition);
    var preconditionState = input.preconditionState || resource.preconditionState;
    if (typeof preconditionState === 'function') {
      adapter.preconditionState = function (context, request, route, params) {
        return preconditionState.call(resource, context, request, route, params);
      };
    }
    var resolveCapabilityDescriptor = input.resolveCapabilityDescriptor || resource.resolveCapabilityDescriptor;
    if (typeof resolveCapabilityDescriptor === 'function') {
      adapter.resolveCapabilityDescriptor = function (context, request, route) {
        return resolveCapabilityDescriptor.call(resource, request, context, route);
      };
    }
    adapter.service = resource.service;
    adapter.resource = resource;
    return adapter;
  }

  return Object.freeze({ API_VERSION: 1, create: create });
});
