// ARP/1 transport-retry idempotency ledger.
(function attachArpResourceIdempotency(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before resource-idempotency.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpResourceIdempotency = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    IdempotencyLedger: core.IdempotencyLedger,
    createIdempotencyLedger: core.createIdempotencyLedger,
  });
});
