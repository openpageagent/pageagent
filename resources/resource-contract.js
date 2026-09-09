// ARP/1 resource and adapter contracts.
(function attachArpResourceContract(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before resource-contract.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpResourceContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    API_VERSION: core.API_VERSION,
    PROTOCOL: core.PROTOCOL,
    METHODS: core.METHODS,
    RESOURCE_METHODS: core.RESOURCE_METHODS,
    ROOT_NAMES: core.ROOT_NAMES,
    ROOTS: core.ROOTS,
    PATCH_MEDIA_TYPES: core.PATCH_MEDIA_TYPES,
    PAGE_ACTION_TEMPLATES: core.PAGE_ACTION_TEMPLATES,
    RouteContract: core.RouteContract,
    CapabilityDescriptor: core.CapabilityDescriptor,
    ResourceAdapter: core.ResourceAdapter,
    defineAdapter: core.defineAdapter,
    validateAdapter: core.validateAdapter,
    validateJsonSchema: core.validateJsonSchema,
    assertSchema: core.assertSchema,
  });
});
