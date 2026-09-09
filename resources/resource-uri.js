// ARP/1 canonical resource URI parsing and route-template matching.
(function attachArpResourceUri(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before resource-uri.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpResourceUri = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    ROOT_NAMES: core.ROOT_NAMES,
    ROOTS: core.ROOTS,
    canonicalizeUri: core.canonicalizeUri,
    compileRouteTemplate: core.compileRouteTemplate,
  });
});
