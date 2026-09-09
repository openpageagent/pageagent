// ARP/1 central execution pipeline. Domain behavior remains in registered adapters.
(function attachArpResourceRouter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before resource-router.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpResourceRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    Router: core.Router,
    createRouter: core.createRouter,
  });
});
