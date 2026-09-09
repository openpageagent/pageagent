// Scoped runtime introspection behind ARP OPTIONS (RFC 7231).
(function attachArpIntrospectionRuntime(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before introspection-runtime.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.ArpIntrospectionRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  return Object.freeze({
    CAPABILITY_MEDIA_TYPE: core.CAPABILITY_MEDIA_TYPE,
    PAGE_ACTION_TEMPLATES: core.PAGE_ACTION_TEMPLATES,
    OptionsIntrospector: core.OptionsIntrospector,
    createOptionsIntrospector: core.createOptionsIntrospector,
  });
});
