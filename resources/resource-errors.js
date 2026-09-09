// ARP/1 structured error vocabulary.
(function attachArpResourceErrors(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before resource-errors.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpResourceErrors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    ERROR_STATUS: core.ERROR_STATUS,
    ArpError: core.ArpError,
    arpError: core.arpError,
    createErrorResponse: core.createErrorResponse,
  });
});
