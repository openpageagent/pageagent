// Canonical Page Fact Model shared by perception, action and verification.
(function attachPageFactContract(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageFactContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function text(value) { return String(value === undefined || value === null ? '' : value); }
  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (Number(fallback) || 0);
  }
  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }
  function hash(value) {
    var input = text(value);
    var result = 2166136261;
    for (var index = 0; index < input.length; index += 1) {
      result ^= input.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }
  function bounds(value) {
    value = value && typeof value === 'object' ? value : {};
    var x = number(value.x !== undefined ? value.x : value.left, 0);
    var y = number(value.y !== undefined ? value.y : value.top, 0);
    var width = Math.max(0, number(value.width, number(value.right, x) - x));
    var height = Math.max(0, number(value.height, number(value.bottom, y) - y));
    return Object.freeze({
      x: x, y: y, width: width, height: height,
      left: x, top: y, right: x + width, bottom: y + height,
      centerX: x + width / 2, centerY: y + height / 2,
    });
  }
  function normalizeLocator(value) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var normalized = {};
    ['selector', 'textSelector', 'textPattern', 'label', 'scopeSelector'].forEach(function (key) {
      var item = text(value[key]).trim();
      if (!item) return;
      normalized[key] = item.slice(0, key === 'selector' || key === 'scopeSelector' ? 1000 : 500);
    });
    if (/^(?:parent|prevSibling|nextSibling)$/.test(text(value.relative))) {
      normalized.relative = text(value.relative);
    }
    return Object.freeze(normalized);
  }
  function targetFingerprint(input) {
    input = input || {};
    return hash([
      text(input.frameId), number(input.backendNodeId), text(input.tag).toLowerCase(),
      text(input.role).toLowerCase(),
      text(input.attributes && input.attributes.id), text(input.attributes && input.attributes.name),
      text(input.attributes && input.attributes.type), text(input.attributes && input.attributes.href),
    ].join('\u001f'));
  }
  function normalizeTarget(input) {
    input = input || {};
    var normalized = {
      targetId: text(input.targetId),
      frameId: text(input.frameId),
      backendNodeId: Math.max(0, Math.floor(number(input.backendNodeId, 0))),
      nodeName: text(input.nodeName || input.tag).toLowerCase(),
      tag: text(input.tag || input.nodeName).toLowerCase(),
      role: text(input.role),
      name: text(input.name),
      text: text(input.text),
      attributes: clone(input.attributes || {}),
      bounds: bounds(input.bounds),
      visible: input.visible === true,
      inViewport: input.inViewport === true,
      occluded: typeof input.occluded === 'boolean' ? input.occluded : null,
      enabled: input.enabled !== false,
      editable: input.editable === true,
      value: input.value === undefined ? null : input.value,
      checked: typeof input.checked === 'boolean' ? input.checked : null,
      selected: input.selected === undefined ? null : input.selected,
      expanded: typeof input.expanded === 'boolean' ? input.expanded : null,
      locator: normalizeLocator(input.locator),
      fingerprint: text(input.fingerprint),
      evidence: clone(input.evidence || {}),
    };
    if (!normalized.fingerprint) normalized.fingerprint = targetFingerprint(normalized);
    return Object.freeze(normalized);
  }
  function createSnapshot(input) {
    input = input || {};
    var capturedAt = text(input.capturedAt || new Date().toISOString());
    var snapshot = {
      documentId: text(input.documentId),
      tabId: Math.max(0, Math.floor(number(input.tabId, 0))),
      frameId: text(input.frameId),
      url: text(input.url),
      title: text(input.title),
      viewport: clone(input.viewport || {}),
      navigation: clone(input.navigation || {}),
      targets: Object.freeze((Array.isArray(input.targets) ? input.targets : []).map(normalizeTarget)),
      evidence: Object.freeze(Object.assign({ source: 'PagePerceptionEngine', capturedAt: capturedAt }, clone(input.evidence || {}))),
      capturedAt: capturedAt,
    };
    return Object.freeze(snapshot);
  }
  function targetRef(snapshot, target) {
    if (!snapshot || !target) return null;
    return Object.freeze({
      // A target reference is a CDP node identity, not an in-memory snapshot
      // lookup.
      documentId: text(snapshot.documentId),
      targetId: text(target.targetId),
      frameId: text(target.frameId),
      backendNodeId: Math.max(0, Math.floor(number(target.backendNodeId, 0))),
      fingerprint: text(target.fingerprint),
    });
  }
  function PageFactError(code, message, details) {
    this.name = 'PageFactError';
    this.code = text(code || 'PAGE_FACT_ERROR');
    this.message = text(message || this.code);
    this.details = details || null;
    this.performed = 'no';
    this.retryable = /^(?:TARGET_STALE|TARGET_NOT_FOUND|PAGE_STATE_UNAVAILABLE)$/.test(this.code);
    if (Error.captureStackTrace) Error.captureStackTrace(this, PageFactError);
  }
  PageFactError.prototype = Object.create(Error.prototype);
  PageFactError.prototype.constructor = PageFactError;

  return Object.freeze({
    API_VERSION: API_VERSION,
    clone: clone,
    hash: hash,
    normalizeBounds: bounds,
    normalizeLocator: normalizeLocator,
    targetFingerprint: targetFingerprint,
    normalizeTarget: normalizeTarget,
    createSnapshot: createSnapshot,
    targetRef: targetRef,
    PageFactError: PageFactError,
  });
});
