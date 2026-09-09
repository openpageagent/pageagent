// Runtime fingerprint for the single background-owned page automation engine.
(function attachPageEngineVersion(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageEngineVersion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var API_VERSION = 1;
  var engineHash = 'page-engine:sha256:60bfb6add882656cf5b02096597ad830fc5177bbc925dc56e433d4fe6717b8e2';
  var providerHash = 'page-provider:sha256:ce8264a9888002ff918b95bc35897667e8682096757b44fb74eacffdf5f93dba';
  var ENGINE_FILES = Object.freeze([
    'shared/page-data-contract.js',
    'shared/page-fact-contract.js',
    'shared/page-javascript-contract.js',
    'shared/page-action-contract.js',
    'shared/page-verification-contract.js',
    'background/cdp-client.js',
    'background/cdp-session-manager.js',
    'background/native-file-materializer.js',
    'background/page-perception-engine.js',
    'background/page-standard-actions.js',
    'background/page-action-engine.js',
    'background/page-verification-engine.js',
    'background/page-automation-runtime.js',
  ]);
  var PROVIDER_FILES = Object.freeze([
    'background/cdp-tools.js',
    'background/page-resource-cache.js',
    'background/page-network-fact-provider.js',
    'content/page-network-provider.js',
    'content/net-capture-main.js',
  ]);
  function copy(value) { return value.slice(); }
  return Object.freeze({
    API_VERSION: API_VERSION,
    version: 'page-engine.' + engineHash.split(':').pop().slice(0, 12),
    hash: engineHash,
    providerHash: providerHash,
    getFingerprintFiles: function (capability) {
      return copy(capability === 'provider' ? PROVIDER_FILES : ENGINE_FILES);
    },
  });
});
