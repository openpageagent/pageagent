// Trusted surface/resource policy -> the exact ARP tools exposed for one model request.
(function attachCapabilityPolicy(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../resources/protocol') : root.AgentResourceProtocol;
  var api = factory(arp);
  if (commonJs) module.exports = api;
  else root.CapabilityPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp) {
  'use strict';

  var API_VERSION = 1;
  var REGISTERED_TOOL_NAMES = Object.freeze([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ASK_USER',
  ]);
  var RESOURCE_TOOL_NAMES = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  var CONTROL_TOOL_NAMES = Object.freeze(['ASK_USER']);
  var INTERACTIVE_SURFACES = Object.freeze(['options', 'page']);
  var ACTIVE_REQUEST_STATES = Object.freeze(['starting', 'running']);
  var SURFACE_MATRIX = Object.freeze({
    options: Object.freeze({
      streamOutput: true, askUser: true, steering: true,
      userCancel: true, reasoning: true, grantSource: 'assistant-policy',
    }),
    page: Object.freeze({
      streamOutput: true, askUser: true, steering: true,
      userCancel: true, reasoning: true, grantSource: 'assistant-policy+page-scope',
    }),
    sidepanel: Object.freeze({
      streamOutput: false, askUser: false, steering: false,
      userCancel: false, reasoning: true, grantSource: 'assistant-policy',
    }),
    scheduled: Object.freeze({
      streamOutput: false, askUser: false, steering: false,
      userCancel: false, schedulerCancel: true, reasoning: true, grantSource: 'schedule-grant-only',
    }),
    // MCP transport is an operator-started local programmatic surface. It is
    // non-interactive and its tools come only from the assistant policy.
    mcp: Object.freeze({
      streamOutput: false, askUser: false, steering: true,
      userCancel: true, reasoning: true, grantSource: 'assistant-policy',
    }),
  });

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function unique(values) {
    var seen = Object.create(null);
    return values.filter(function (value) {
      if (seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }
  function toolSet(values, path) {
    if (values === undefined || values === null) return null;
    if (!Array.isArray(values)) throw new TypeError(path + ' must be an array');
    return unique(values.map(function (value) {
      var name = String(value || '').trim().toUpperCase();
      if (REGISTERED_TOOL_NAMES.indexOf(name) === -1) {
        throw new TypeError(path + ' contains a non-ARP tool: ' + name);
      }
      return name;
    }));
  }

  function create(options) {
    options = options || {};
    if (!arp || typeof arp.createToolDefinitions !== 'function') {
      throw new Error('CapabilityPolicy requires AgentResourceProtocol.createToolDefinitions');
    }
    var definitions = options.toolDefinitions ? clone(options.toolDefinitions) : arp.createToolDefinitions();
    var definitionNames = definitions.map(function (item) { return item && item.name; });
    if (JSON.stringify(definitionNames) !== JSON.stringify(REGISTERED_TOOL_NAMES)) {
      throw new Error('ARP tool registry does not exactly match the registered tool protocol');
    }
    var byName = Object.create(null);
    definitions.forEach(function (definition) { byName[definition.name] = Object.freeze(clone(definition)); });

    function evaluate(input) {
      input = input || {};
      var surface = String(input.surface && input.surface.type || input.surface || '');
      var matrix = SURFACE_MATRIX[surface];
      if (!matrix) throw new TypeError('Unknown trusted conversation surface: ' + surface);
      var state = String(input.generationState || 'running');
      var remainingToolCalls = input.remainingToolCalls === undefined
        ? Number.MAX_SAFE_INTEGER
        : Number(input.remainingToolCalls);
      if (!Number.isFinite(remainingToolCalls) || remainingToolCalls < 0) {
        throw new TypeError('remainingToolCalls must be a non-negative finite number');
      }

      var exposed = [];
      if (ACTIVE_REQUEST_STATES.indexOf(state) !== -1) {
        var policyNames = toolSet(input.allowedToolNames, 'allowedToolNames');
        if (remainingToolCalls > 0) {
          var policyResourceMethods = policyNames
            ? policyNames.filter(function (name) { return RESOURCE_TOOL_NAMES.indexOf(name) !== -1; })
            : RESOURCE_TOOL_NAMES.slice();
          if (surface === 'scheduled') {
            var granted = toolSet(input.scheduleGrant, 'scheduleGrant') || [];
            policyResourceMethods = policyResourceMethods.filter(function (name) {
              return granted.indexOf(name) !== -1;
            });
          }
          exposed = exposed.concat(policyResourceMethods);

          var policyAllowsAsk = !policyNames || policyNames.indexOf('ASK_USER') !== -1;
          if (matrix.askUser && policyAllowsAsk) exposed.push('ASK_USER');
        }
      }

      exposed = REGISTERED_TOOL_NAMES.filter(function (name) { return exposed.indexOf(name) !== -1; });
      var result = {
        schemaVersion: 1,
        surface: surface,
        generationState: state,
        registeredToolNames: REGISTERED_TOOL_NAMES.slice(),
        exposedToolNames: exposed,
        tools: exposed.map(function (name) { return clone(byName[name]); }),
        surfaceCapabilities: clone(matrix),
        interaction: {
          askUser: exposed.indexOf('ASK_USER') !== -1,
          unavailableBehavior: surface === 'sidepanel' || surface === 'scheduled' || surface === 'mcp'
            ? 'blocked' : 'interaction',
        },
      };
      return Object.freeze(result);
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      evaluate: evaluate,
      definitions: function () { return definitions.map(clone); },
      registeredToolNames: function () { return REGISTERED_TOOL_NAMES.slice(); },
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    REGISTERED_TOOL_NAMES: REGISTERED_TOOL_NAMES,
    RESOURCE_TOOL_NAMES: RESOURCE_TOOL_NAMES,
    CONTROL_TOOL_NAMES: CONTROL_TOOL_NAMES,
    SURFACE_MATRIX: SURFACE_MATRIX,
    INTERACTIVE_SURFACES: INTERACTIVE_SURFACES,
    create: create,
  });
});
