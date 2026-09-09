// ARP/1 resource-precondition gate.
(function attachArpResourcePermissions(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before resource-permissions.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpResourcePermissions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    PreconditionEngine: core.PreconditionEngine,
    createPreconditionEngine: core.createPreconditionEngine,
  });
});
