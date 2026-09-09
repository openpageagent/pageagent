// Composition root for independently owned ARP/1 resource adapters.
(function attachAgentResourceRouter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  var api = factory(root, core);
  if (commonJs) module.exports = api;
  else root.AgentResourceRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, core) {
  'use strict';

  var API_VERSION = 1;
  var ADAPTER_SPECS = Object.freeze([
    Object.freeze({ root: 'page', api: 'PageResourceAdapter', factories: ['createPageResourceAdapter', 'createAdapter', 'create'] }),
    Object.freeze({ root: 'image-artifacts', api: 'ImageArtifactResourceAdapter', factories: ['createImageArtifactResourceAdapter', 'createAdapter'] }),
    Object.freeze({ root: 'browser', api: 'BrowserResourceAdapter', factories: ['createBrowserResourceAdapter', 'createAdapter', 'create'] }),
    Object.freeze({ root: 'current', api: 'CurrentResourceAdapter', factories: ['createCurrentResourceAdapter', 'createAdapter'] }),
    Object.freeze({ root: 'flows', api: 'FlowResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'node-types', api: 'NodeTypeResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'flow-groups', api: 'FlowGroupResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'conversations', api: 'ConversationResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'recordings', api: 'RecordingResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'pages', api: 'PageSourceResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'url-triggers', api: 'UrlTriggerResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'scripts', api: 'ScriptResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'config', api: 'ConfigResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'skills', api: 'SkillResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'runs', api: 'RunResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'schedules', api: 'ScheduleResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'knowledge', api: 'KnowledgeResource', factories: ['createKnowledgeAdapter', 'createAdapter'] }),
    Object.freeze({ root: 'knowledge-settings', api: 'KnowledgeResource', factories: ['createKnowledgeSettingsAdapter'] }),
    Object.freeze({ root: 'assistants', api: 'AgentConfigurationResource', factories: ['createAssistantsAdapter'] }),
    Object.freeze({ root: 'model-services', api: 'AgentConfigurationResource', factories: ['createModelServicesAdapter'] }),
    Object.freeze({ root: 'agent-settings', api: 'AgentConfigurationResource', factories: ['createAgentSettingsAdapter'] }),
    Object.freeze({ root: 'connections', api: 'ConnectionResource', factories: ['createAdapter'] }),
    Object.freeze({ root: 'mcp-servers', api: 'McpResource', factories: ['createMcpServersAdapter', 'createAdapter'] }),
    Object.freeze({ root: 'mcp-calls', api: 'McpResource', factories: ['createMcpCallsAdapter'] }),
  ]);

  function factoryFunction(value, names) {
    for (var index = 0; value && index < names.length; index += 1) {
      if (typeof value[names[index]] === 'function') return value[names[index]].bind(value);
    }
    return null;
  }

  function defaultFactory(spec) {
    if (!root) return null;
    return factoryFunction(root[spec.api], spec.factories);
  }

  function resolveAdapter(spec, options) {
    var rootName = spec.root;
    var adapters = options.adapters || {};
    if (adapters[rootName]) return adapters[rootName];
    var factories = options.adapterFactories || {};
    var create = factories[rootName] || defaultFactory(spec);
    if (typeof create !== 'function') return null;
    var resourceOptions = Object.assign({}, options.resourceOptions || {},
      options.adapterOptions && options.adapterOptions[rootName] || {});
    if (!resourceOptions.core) resourceOptions.core = core;
    return create(resourceOptions);
  }

  function createAgentResourceRouter(options) {
    options = options || {};
    if (!core || typeof core.createRouter !== 'function') throw new Error('AgentResourceProtocol is required');
    var canDiscover = options.canDiscover;
    if (!canDiscover && typeof options.authorize === 'function') {
      canDiscover = function (input) {
        var contract = input && input.route && input.route.methods && input.route.methods[input.method];
        return Promise.resolve(options.authorize({
          descriptor: { requiredPermissions: contract && contract.permissions || [] },
          request: { method: input.method, uri: input.href },
          context: input.context || {},
          route: input.route,
        })).then(function (decision) {
          return decision === true || !!(decision && decision.allowed === true);
        });
      };
    }
    var registry = options.registry || core.createResourceRegistry({ canDiscover: canDiscover });
    if (!registry.canDiscover && canDiscover) registry.canDiscover = canDiscover;
    var adapters = Object.create(null);
    var missing = [];
    ADAPTER_SPECS.forEach(function (spec) {
      var adapter = resolveAdapter(spec, options);
      if (!adapter) {
        missing.push(spec.root);
        return;
      }
      adapters[spec.root] = adapter;
      registry.register(adapter);
    });
    if (missing.length) {
      throw new Error('ARP resource adapter factories are missing: ' + missing.join(', '));
    }
    var matcher = options.matcher || core.createCapabilityMatcher({
      registry: registry,
      maxMatches: Math.min(4, Math.max(1, Number(options.maxMatches) || 4)),
    });
    var optionsIntrospector = options.optionsIntrospector || core.createOptionsIntrospector({
      registry: registry,
      matcher: matcher,
      maxMatches: Math.min(4, Math.max(1, Number(options.maxMatches) || 4)),
    });
    var router = core.createRouter({
      registry: registry,
      optionsIntrospector: optionsIntrospector,
      preconditions: options.preconditions,
      idempotencyLedger: options.idempotencyLedger,
      idempotency: options.idempotency,
      authorize: options.authorize,
      sizeControl: options.sizeControl,
      maxResponseBytes: options.maxResponseBytes,
      requestId: options.requestId,
    });
    return {
      protocol: core.PROTOCOL,
      router: router,
      registry: registry,
      adapters: adapters,
      missingDomains: missing,
      optionsIntrospector: optionsIntrospector,
      dispatch: function (method, input, context) { return router.dispatch(method, input, context); },
      beginPageToolBatch: function (context) {
        return adapters.page && typeof adapters.page.beginToolBatch === 'function'
          ? adapters.page.beginToolBatch(context || {}) : Promise.resolve();
      },
      endPageToolBatch: function (context) {
        return adapters.page && typeof adapters.page.endToolBatch === 'function'
          ? adapters.page.endToolBatch(context || {}) : Promise.resolve();
      },
      endPageGeneration: function (context) {
        return adapters.page && typeof adapters.page.endGeneration === 'function'
          ? adapters.page.endGeneration(context || {}) : Promise.resolve();
      },
    };
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    RESOURCE_ROOTS: Object.freeze(ADAPTER_SPECS.map(function (spec) { return spec.root; })),
    createAgentResourceRouter: createAgentResourceRouter,
    create: createAgentResourceRouter,
  });
});
