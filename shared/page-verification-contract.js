// Canonical verification verdict and ActionReceipt contract.
(function attachPageVerificationContract(root, factory) {
  'use strict';
  var api = factory(root && root.PageFactContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageVerificationContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (facts) {
  'use strict';
  var API_VERSION = 1;
  var WAIT_TIMEOUT_MIN_MS = 100;
  var WAIT_TIMEOUT_MAX_MS = 120000;
  var WAIT_POLL_INTERVAL_MIN_MS = 25;
  var WAIT_POLL_INTERVAL_MAX_MS = 2000;
  var WAIT_CONDITION_TYPES = Object.freeze([
    'page_change', 'url_change', 'url_matches', 'text_present', 'text_absent', 'document_ready', 'target_state',
  ]);
  function clone(value) { return facts && facts.clone ? facts.clone(value) : JSON.parse(JSON.stringify(value)); }
  function verdict(input) {
    input = input || {};
    var status = /^(?:confirmed|unconfirmed|failed)$/.test(String(input.status)) ? String(input.status) : 'unconfirmed';
    var performed = /^(?:yes|no|unknown)$/.test(String(input.performed)) ? String(input.performed) : 'unknown';
    return Object.freeze({
      status: status,
      performed: performed,
      conditionMet: input.conditionMet === true,
      signals: Object.freeze((Array.isArray(input.signals) ? input.signals : []).map(String)),
      evidence: Object.freeze((Array.isArray(input.evidence) ? input.evidence : []).map(function (item) { return clone(item); })),
      reason: String(input.reason || ''),
    });
  }
  function receipt(input) {
    input = input || {};
    var verification = verdict(input.verification || input);
    var started = String(input.startedAt || new Date().toISOString());
    var completed = String(input.completedAt || new Date().toISOString());
    var sourceTabId = Math.floor(Number(input.tabId)) || 0;
    var target = input.newNavigationTarget && input.newNavigationTarget.ambiguous !== true
      ? input.newNavigationTarget : null;
    var targetTabId = target && Number(target.tabId) > 0 ? Math.floor(Number(target.tabId)) : sourceTabId;
    var navigation = input.navigation && typeof input.navigation === 'object' ? input.navigation : {};
    var targetDisposition = target
      ? 'new_tab'
      : String(navigation.disposition || (navigation.observed === true ? 'same_tab_navigation' : 'none'));
    return Object.freeze({
      actionId: String(input.actionId || ''),
      source: String(input.source || ''),
      tabId: sourceTabId,
      kind: String(input.kind || ''),
      status: verification.status,
      performed: verification.performed,
      conditionMet: verification.conditionMet,
      inputProvenance: String(input.inputProvenance || 'cdp'),
      trustedEventExpected: input.trustedEventExpected !== false,
      targetRef: input.targetRef ? clone(input.targetRef) : null,
      actionFacts: clone(input.actionFacts || {}),
      verification: verification,
      navigation: clone(navigation),
      newNavigationTarget: input.newNavigationTarget ? clone(input.newNavigationTarget) : null,
      targetTabId: targetTabId,
      targetDisposition: targetDisposition,
      targetUrl: target ? String(target.url || '') : '',
      targetActive: target ? target.active === true : null,
      browserFacts: Object.freeze((Array.isArray(input.browserFacts) ? input.browserFacts : []).map(function (item) { return clone(item); })),
      startedAt: started,
      completedAt: completed,
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      warnings: Object.freeze((Array.isArray(input.warnings) ? input.warnings : []).map(String)),
    });
  }
  return Object.freeze({
    API_VERSION: API_VERSION,
    WAIT_CONDITION_TYPES: WAIT_CONDITION_TYPES,
    WAIT_TIMEOUT_MIN_MS: WAIT_TIMEOUT_MIN_MS,
    WAIT_TIMEOUT_MAX_MS: WAIT_TIMEOUT_MAX_MS,
    WAIT_POLL_INTERVAL_MIN_MS: WAIT_POLL_INTERVAL_MIN_MS,
    WAIT_POLL_INTERVAL_MAX_MS: WAIT_POLL_INTERVAL_MAX_MS,
    createVerdict: verdict,
    createReceipt: receipt,
  });
});
