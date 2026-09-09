(function attachRecordingContract(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationRecordingContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var SCHEMA_VERSION = 1;
  var CONSENT_VERSION = 'conversation-recording-consent-v2';
  var LIMITS = Object.freeze({
    MAX_DURATION_MS: 60 * 60 * 1000,
    MAX_CANDIDATE_EVENTS: 2000,
    WARNING_RATIO: 0.8,
    MAX_COLLECTION_SOURCES: 32,
    MAX_COMMAND_RANGES: 32,
    MAX_EVENTS_LIMIT: 50,
    DEFAULT_EVENTS_LIMIT: 20,
    MAX_SEARCH_LIMIT: 20,
    DEFAULT_SEARCH_LIMIT: 8,
    MAX_SEARCH_QUERY: 200,
    MAX_RESPONSE_CHARS: 32768,
    MAX_MANIFEST_CHARS: 4000,
    MAX_FIELD_WINDOW_CHARS: 10000,
    DEFAULT_FIELD_WINDOW_CHARS: 4000,
    MAX_EXPORT_CHUNK_CHARS: 65536,
    CONTENT_RING_EVENTS: 128,
    CONTENT_BATCH_EVENTS: 32,
    CONTENT_BATCH_DELAY_MS: 120,
    FILL_DEBOUNCE_MS: 400,
    DRAIN_TIMEOUT_MS: 5000,
    DRAFT_GRACE_MS: 24 * 60 * 60 * 1000,
  });
  var STATES = Object.freeze({
    IDLE: 'idle', RECORDING: 'recording', DRAINING: 'draining', COMPILING: 'compiling',
    READY: 'ready', INTERRUPTED: 'interrupted', TRUNCATED: 'truncated', FAILED: 'failed',
  });
  var TERMINAL_STATES = Object.freeze({ ready: true, interrupted: true, truncated: true, failed: true });
  var DOCUMENT_MESSAGES = Object.freeze({
    HELLO: 'RECORDER_DOCUMENT_HELLO', ENABLE: 'RECORDER_DOCUMENT_ENABLE',
    BATCH: 'RECORDER_EVENT_BATCH', STOP_AND_FLUSH: 'RECORDER_STOP_AND_FLUSH', ACK: 'RECORDER_FLUSH_ACK',
  });
  var UI_MESSAGES = Object.freeze({
    GET_STATE: 'GET_CONVERSATION_RECORDING_STATE', START: 'START_CONVERSATION_RECORDING',
    STOP: 'STOP_CONVERSATION_RECORDING', REMOVE_SOURCE: 'REMOVE_CONVERSATION_RECORDING_SOURCE',
    GET_LIBRARY: 'GET_CONVERSATION_RECORDING_LIBRARY', GET_PREVIEW: 'GET_CONVERSATION_RECORDING_SOURCE_PREVIEW',
    EXPORT_SOURCE: 'EXPORT_CONVERSATION_RECORDING_SOURCE',
    UPDATE_SELECTION: 'UPDATE_CONVERSATION_RECORDING_SELECTION', CLAIM_SELECTION: 'CLAIM_CONVERSATION_RECORDING_SELECTION',
    STATE_CHANGED: 'CONVERSATION_RECORDING_STATE_CHANGED', LIBRARY_CHANGED: 'CONVERSATION_RECORDING_LIBRARY_CHANGED',
  });
  var ALLOWED_KEYS = Object.freeze({ Enter: true, Escape: true, Tab: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true });

  function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value); }
  function trimmed(value, max) {
    var output = text(value).trim();
    if (max && output.length > max) throw contractError('INVALID_REQUEST', 'String exceeds ' + max + ' characters');
    return output;
  }
  function integer(value, name, min, max) {
    var number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw contractError('INVALID_REQUEST', name + ' is out of range');
    return number;
  }
  function clone(value, seen) {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw contractError('INVALID_REQUEST', 'Non-finite numbers are not supported');
      return value;
    }
    if (typeof value !== 'object') throw contractError('INVALID_REQUEST', 'Unsupported value type');
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw contractError('INVALID_REQUEST', 'Cyclic values are not supported');
    seen.push(value);
    var result;
    if (Array.isArray(value)) result = value.map(function (item) { return clone(item, seen); });
    else {
      result = {};
      Object.keys(value).forEach(function (key) {
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set) throw contractError('INVALID_REQUEST', 'Accessor properties are not supported');
        result[key] = clone(descriptor.value, seen);
      });
    }
    seen.pop();
    return result;
  }
  function stable(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stable);
    var result = {};
    Object.keys(value).sort().forEach(function (key) { result[key] = stable(value[key]); });
    return result;
  }
  function stableStringify(value) { return JSON.stringify(stable(value)); }
  function contractError(code, message, details) {
    var error = new Error(String(message || code));
    error.code = String(code || 'INVALID_REQUEST');
    if (details !== undefined) error.details = clone(details);
    return error;
  }
  function assertExactKeys(value, allowed, label) {
    if (!isRecord(value)) throw contractError('INVALID_REQUEST', label + ' must be an object');
    Object.keys(value).forEach(function (key) {
      if (!allowed[key]) throw contractError('INVALID_REQUEST', label + ' contains unknown field: ' + key);
    });
    return value;
  }
  function canonicalRecordingUri(recordingId) {
    recordingId = trimmed(recordingId, 160);
    if (!/^rec_[A-Za-z0-9][A-Za-z0-9_-]{5,159}$/.test(recordingId)) throw contractError('INVALID_REQUEST', 'Invalid Recording ID');
    return '/recordings/' + recordingId;
  }
  function recordingIdFromUri(uri) {
    uri = trimmed(uri, 192);
    var match = /^\/recordings\/(rec_[A-Za-z0-9][A-Za-z0-9_-]{5,159})$/.exec(uri);
    if (!match) throw contractError('INVALID_REQUEST', 'Recording URI must be canonical');
    return match[1];
  }
  function normalizeSha256(value) {
    value = trimmed(value, 80).toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw contractError('INVALID_REQUEST', 'Invalid source SHA-256');
    return value;
  }
  function normalizeRange(value, eventCount, options) {
    options = options || {};
    assertExactKeys(value, { fromSeq: true, toSeq: true }, 'range');
    if (eventCount !== undefined && Number(eventCount) === 0) throw contractError('INVALID_REQUEST', 'An empty Recording has no selectable range');
    var max = Math.max(1, Number(eventCount) || Number.MAX_SAFE_INTEGER);
    var fromSeq = integer(value.fromSeq, 'fromSeq', 1, max);
    var toSeq = integer(value.toSeq, 'toSeq', fromSeq, max);
    return Object.freeze({ fromSeq: fromSeq, toSeq: toSeq });
  }
  function normalizeRanges(values, eventCount, options) {
    options = options || {};
    if (values === undefined) return [];
    if (!Array.isArray(values) || !values.length || values.length > LIMITS.MAX_COMMAND_RANGES) {
      throw contractError('INVALID_REQUEST', 'ranges must contain 1..' + LIMITS.MAX_COMMAND_RANGES + ' items');
    }
    var exact = Object.create(null);
    var normalized = values.map(function (value) {
      var range = normalizeRange(value, eventCount, options);
      var key = range.fromSeq + ':' + range.toSeq;
      if (exact[key]) throw contractError('INVALID_REQUEST', 'Duplicate range: ' + key);
      exact[key] = true;
      return range;
    }).sort(function (left, right) { return left.fromSeq - right.fromSeq || left.toSeq - right.toSeq; });
    if (options.unionOverlaps === false) return normalized;
    var union = [];
    normalized.forEach(function (range) {
      var previous = union[union.length - 1];
      if (previous && range.fromSeq <= previous.toSeq) {
        union[union.length - 1] = Object.freeze({ fromSeq: previous.fromSeq, toSeq: Math.max(previous.toSeq, range.toSeq) });
      } else union.push(range);
    });
    return union;
  }
  function normalizeLocator(value) {
    if (!isRecord(value)) return null;
    var output = {};
    ['selector', 'textSelector', 'textPattern', 'label', 'scopeSelector'].forEach(function (key) {
      var item = text(value[key]).trim();
      if (!item) return;
      output[key] = item.slice(0, key === 'selector' || key === 'scopeSelector' ? 1000 : 500);
    });
    if (/^(?:parent|prevSibling|nextSibling)$/.test(text(value.relative))) output.relative = text(value.relative);
    return Object.keys(output).length ? output : null;
  }
  function normalizeRawEvent(value) {
    assertExactKeys(value, { localEventId: true, occurredAt: true, kind: true, payload: true }, 'recording event');
    var localEventId = trimmed(value.localEventId, 180);
    if (!localEventId) throw contractError('INVALID_REQUEST', 'localEventId is required');
    var occurredAt = Number(value.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt < 0) throw contractError('INVALID_REQUEST', 'occurredAt is invalid');
    var kind = trimmed(value.kind, 64);
    if (!/^[a-z][a-z0-9_]*$/.test(kind)) throw contractError('INVALID_REQUEST', 'Recording event kind is invalid');
    return Object.freeze({ localEventId: localEventId, occurredAt: occurredAt, kind: kind, payload: clone(value.payload || {}) });
  }
  function normalizeSelectionDescriptor(value, eventCount) {
    assertExactKeys(value, {
      kind: true, recordingId: true, recordingUri: true, sourceSha256: true,
      fromSeq: true, toSeq: true, eventCount: true, selectionOrder: true,
    }, 'selection descriptor');
    var recordingId = trimmed(value.recordingId || recordingIdFromUri(value.recordingUri), 160);
    var recordingUri = canonicalRecordingUri(recordingId);
    if (value.recordingUri && recordingUri !== value.recordingUri) throw contractError('INVALID_REQUEST', 'Recording URI does not match recordingId');
    if (value.kind !== undefined && value.kind !== 'page-action-recording-range') {
      throw contractError('INVALID_REQUEST', 'Selection descriptor kind is invalid');
    }
    var range = normalizeRange({ fromSeq: value.fromSeq, toSeq: value.toSeq }, eventCount);
    var rangeEventCount = range.toSeq - range.fromSeq + 1;
    if (value.eventCount !== undefined && integer(value.eventCount, 'eventCount', 1, Number.MAX_SAFE_INTEGER) !== rangeEventCount) {
      throw contractError('INVALID_REQUEST', 'Selection descriptor eventCount does not match its range');
    }
    return Object.freeze({
      kind: 'page-action-recording-range', recordingId: recordingId, recordingUri: recordingUri,
      sourceSha256: normalizeSha256(value.sourceSha256), fromSeq: range.fromSeq, toSeq: range.toSeq,
      eventCount: rangeEventCount,
      selectionOrder: integer(value.selectionOrder, 'selectionOrder', 0, LIMITS.MAX_COMMAND_RANGES - 1),
    });
  }
  function inRanges(seq, ranges) {
    if (!ranges || !ranges.length) return true;
    for (var index = 0; index < ranges.length; index += 1) {
      if (seq >= ranges[index].fromSeq && seq <= ranges[index].toSeq) return true;
    }
    return false;
  }

  return Object.freeze({
    API_VERSION: API_VERSION, SCHEMA_VERSION: SCHEMA_VERSION, CONSENT_VERSION: CONSENT_VERSION,
    LIMITS: LIMITS, STATES: STATES, TERMINAL_STATES: TERMINAL_STATES,
    DOCUMENT_MESSAGES: DOCUMENT_MESSAGES, UI_MESSAGES: UI_MESSAGES,
    ALLOWED_KEYS: ALLOWED_KEYS, isRecord: isRecord, text: text, clone: clone,
    stableStringify: stableStringify, error: contractError, assertExactKeys: assertExactKeys,
    canonicalRecordingUri: canonicalRecordingUri, recordingIdFromUri: recordingIdFromUri,
    normalizeSha256: normalizeSha256, normalizeRange: normalizeRange, normalizeRanges: normalizeRanges,
    normalizeLocator: normalizeLocator, normalizeRawEvent: normalizeRawEvent,
    normalizeSelectionDescriptor: normalizeSelectionDescriptor, inRanges: inRanges,
  });
});
