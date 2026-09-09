// Canonical action intent and action-facts contract.
(function attachPageActionContract(root, factory) {
  'use strict';
  var api = factory(root && root.PageFactContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageActionContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (facts) {
  'use strict';
  var API_VERSION = 1;
  var TIMEOUT_MIN_MS = 100;
  var TIMEOUT_MAX_MS = 120000;
  var KINDS = Object.freeze([
    'click', 'doubleClick', 'contextClick', 'hover', 'type', 'fill', 'press', 'select', 'check',
    'fillFormFields', 'scroll', 'drag', 'upload', 'navigate', 'reload', 'handleDialog',
    'createTab', 'activateTab', 'closeTab', 'evaluate', 'patch', 'webStorage', 'replayRequest',
  ]);
  var EDITABLE_FLOW_KINDS = Object.freeze([
    'click', 'doubleClick', 'contextClick', 'fill', 'select', 'scroll',
  ]);
  function clone(value) { return facts && facts.clone ? facts.clone(value) : JSON.parse(JSON.stringify(value)); }
  function normalizeIntent(input) {
    input = input || {};
    var kind = String(input.kind || '');
    if (KINDS.indexOf(kind) === -1) throw new TypeError('Unknown page action kind: ' + kind);
    var tabId = Math.floor(Number(input.tabId));
    if (kind === 'createTab') tabId = 0;
    else if (!(tabId > 0)) throw new TypeError('Page action requires tabId');
    return Object.freeze({
      actionId: String(input.actionId || ('action_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8))),
      owner: String(input.owner || ''),
      source: /^(?:agent|flow|script)$/.test(String(input.source || '')) ? String(input.source) : 'flow',
      tabId: tabId,
      kind: kind,
      locator: clone(input.locator || {}),
      targetRef: input.targetRef ? clone(input.targetRef) : null,
      input: clone(input.input || {}),
      expect: clone(input.expect || null),
      timeoutMs: Math.max(TIMEOUT_MIN_MS, Math.min(Number(input.timeoutMs) || 10000, TIMEOUT_MAX_MS)),
      sensitive: input.sensitive === true,
      // Internal only: generation cancellation is never part of the public
      // action schema or persisted action facts.
      signal: input.signal || null,
      startedAt: String(input.startedAt || new Date().toISOString()),
    });
  }
  function createActionFacts(input) {
    input = input || {};
    return Object.freeze({
      actionId: String(input.actionId || ''),
      tabId: Math.floor(Number(input.tabId)) || 0,
      kind: String(input.kind || ''),
      target: input.target ? clone(input.target) : null,
      actualCoordinates: input.actualCoordinates ? clone(input.actualCoordinates) : null,
      relatedTargets: Object.freeze((Array.isArray(input.relatedTargets) ? input.relatedTargets : []).map(function (target) { return clone(target); })),
      coordinateFacts: Object.freeze((Array.isArray(input.coordinateFacts) ? input.coordinateFacts : []).map(function (point) { return clone(point); })),
      commands: Object.freeze((Array.isArray(input.commands) ? input.commands : []).map(function (command) { return clone(command); })),
      browserResponses: Object.freeze((Array.isArray(input.browserResponses) ? input.browserResponses : []).map(function (response) { return clone(response); })),
      inputProvenance: String(input.inputProvenance || 'cdp'),
      dispatched: input.dispatched === true,
      transportInterrupted: input.transportInterrupted === true,
      failure: input.failure ? clone(input.failure) : null,
      startedAt: String(input.startedAt || new Date().toISOString()),
      completedAt: String(input.completedAt || new Date().toISOString()),
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      warnings: Object.freeze((Array.isArray(input.warnings) ? input.warnings : []).map(String)),
    });
  }
  return Object.freeze({
    API_VERSION: API_VERSION,
    KINDS: KINDS,
    EDITABLE_FLOW_KINDS: EDITABLE_FLOW_KINDS,
    TIMEOUT_MIN_MS: TIMEOUT_MIN_MS,
    TIMEOUT_MAX_MS: TIMEOUT_MAX_MS,
    normalizeIntent: normalizeIntent,
    createActionFacts: createActionFacts,
  });
});
