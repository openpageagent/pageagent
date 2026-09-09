(function attachRecordingArtifactProjector(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var contract = commonJs ? require('../shared/recording-contract') : root.PageAutomationRecordingContract;
  var api = factory(root, contract);
  if (commonJs) module.exports = api;
  if (root) root.PageAutomationRecordingArtifactProjector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, contract) {
  'use strict';
  if (!contract || contract.API_VERSION !== 1) throw new Error('RecordingContract must load before RecordingArtifactProjector');
  var API_VERSION = 1;
  var MAX_PRIMARY_DATA_BYTES = 32 * 1024;
  function clone(value) { return contract.clone(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value); }
  function byteLength(value) {
    var serialized = JSON.stringify(value);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(serialized).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(serialized, 'utf8');
    return unescape(encodeURIComponent(serialized)).length;
  }
  function integer(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    var number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw contract.error('INVALID_REQUEST', 'Numeric query value is out of range');
    return number;
  }
  function encode(value) {
    var raw = JSON.stringify(value);
    if (typeof Buffer !== 'undefined') return Buffer.from(raw, 'utf8').toString('base64url');
    return btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(value) {
    try {
      if (typeof Buffer !== 'undefined') return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
      var raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
      while (raw.length % 4) raw += '=';
      return JSON.parse(decodeURIComponent(escape(atob(raw))));
    } catch (_) { throw contract.error('INVALID_REQUEST', 'Cursor is invalid'); }
  }
  function queryShape(query) {
    var copy = clone(query || {});
    delete copy.cursor;
    delete copy.ranges;
    return contract.stableStringify(copy);
  }
  function normalizedQuery(artifact, query) {
    query = query && typeof query === 'object' && !Array.isArray(query) ? clone(query) : {};
    var allowed = { view: true, fromSeq: true, toSeq: true, cursor: true, tab: true, kinds: true, fromMs: true, toMs: true, limit: true, maxChars: true, seq: true, field: true, start: true, q: true, context: true };
    contract.assertExactKeys(query, allowed, 'Recording GET query');
    var view = text(query.view || 'manifest');
    if (view !== 'manifest' && view !== 'events' && view !== 'search') throw contract.error('INVALID_REQUEST', 'Unknown Recording view');
    var viewKeys = view === 'manifest'
      ? { view: true }
      : (view === 'events'
        ? { view: true, fromSeq: true, toSeq: true, cursor: true, tab: true, kinds: true, fromMs: true, toMs: true, limit: true, maxChars: true, seq: true, field: true, start: true }
        : { view: true, fromSeq: true, toSeq: true, cursor: true, tab: true, kinds: true, fromMs: true, toMs: true, limit: true, maxChars: true, q: true, context: true });
    Object.keys(query).forEach(function (key) {
      if (!viewKeys[key]) throw contract.error('INVALID_REQUEST', key + ' is not valid for Recording view ' + view);
    });
    var hasFromSeq = query.fromSeq !== undefined;
    var hasToSeq = query.toSeq !== undefined;
    if (hasFromSeq !== hasToSeq) throw contract.error('INVALID_REQUEST', 'fromSeq and toSeq must be provided together');
    var ranges = hasFromSeq ? contract.normalizeRanges([{
      fromSeq: query.fromSeq,
      toSeq: query.toSeq,
    }], artifact.stats.eventCount) : [];
    var kinds = query.kinds === undefined ? [] : (Array.isArray(query.kinds) ? query.kinds : [query.kinds]).map(function (kind) {
      kind = text(kind).trim();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(kind)) throw contract.error('INVALID_REQUEST', 'Invalid event kind filter');
      return kind;
    });
    if (kinds.length > 32 || new Set(kinds).size !== kinds.length) throw contract.error('INVALID_REQUEST', 'kinds must contain at most 32 unique values');
    var hasSeq = query.seq !== undefined;
    var hasField = query.field !== undefined && text(query.field) !== '';
    if (view === 'events' && hasSeq !== hasField) throw contract.error('INVALID_REQUEST', 'seq and field must be provided together');
    if (query.start !== undefined && !hasField) throw contract.error('INVALID_REQUEST', 'start is only valid for an event field window');
    if (hasField && (query.cursor !== undefined || query.tab !== undefined || query.kinds !== undefined
        || query.fromMs !== undefined || query.toMs !== undefined)) {
      throw contract.error('INVALID_REQUEST', 'Event field windows only accept fromSeq, toSeq, seq, field, start, and maxChars');
    }
    var field = text(query.field);
    if (field && (field.length > 256 || !/^[A-Za-z0-9_$-]+(?:(?:\.[A-Za-z0-9_$-]+)|(?:\[[0-9]{1,6}\]))*$/.test(field))) {
      throw contract.error('INVALID_REQUEST', 'field must be a bounded dot-separated event field path');
    }
    var cursor = text(query.cursor);
    var tab = text(query.tab);
    if (cursor.length > 4096 || tab.length > 128) {
      throw contract.error('INVALID_REQUEST', 'Recording query string is too long');
    }
    var normalized = {
      view: view,
      fromSeq: ranges.length ? ranges[0].fromSeq : null,
      toSeq: ranges.length ? ranges[0].toSeq : null,
      ranges: ranges, cursor: cursor, tab: tab, kinds: kinds,
      fromMs: query.fromMs === undefined ? null : integer(query.fromMs, 0, 0, Number.MAX_SAFE_INTEGER),
      toMs: query.toMs === undefined ? null : integer(query.toMs, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: integer(query.limit, view === 'search' ? contract.LIMITS.DEFAULT_SEARCH_LIMIT : contract.LIMITS.DEFAULT_EVENTS_LIMIT, 1, view === 'search' ? contract.LIMITS.MAX_SEARCH_LIMIT : contract.LIMITS.MAX_EVENTS_LIMIT),
      maxChars: integer(query.maxChars, contract.LIMITS.MAX_RESPONSE_CHARS, 256, contract.LIMITS.MAX_RESPONSE_CHARS),
      seq: query.seq === undefined ? null : integer(query.seq, 0, 1, Math.max(1, artifact.stats.eventCount)),
      field: field, start: integer(query.start, 0, 0, Number.MAX_SAFE_INTEGER),
      q: text(query.q), context: integer(query.context, 1, 0, 5),
    };
    if (normalized.fromMs !== null && normalized.toMs !== null && normalized.fromMs > normalized.toMs) {
      throw contract.error('INVALID_REQUEST', 'fromMs cannot be greater than toMs');
    }
    return normalized;
  }
  function isTimelineFact(event) {
    if (!event || event.kind === 'gap' || event.kind === 'navigation_signal') return false;
    var destination = text(event.navigation && event.navigation.to || event.url);
    return !(event.kind === 'navigation' && event.frame === 'child' && /^about:blank(?:[#?]|$)/i.test(destination));
  }
  function filtered(artifact, query) {
    return (artifact.timeline || []).filter(function (event) {
      if (!isTimelineFact(event)) return false;
      if (!contract.inRanges(event.seq, query.ranges)) return false;
      if (query.tab && event.tab !== query.tab) return false;
      if (query.kinds.length && query.kinds.indexOf(event.kind) === -1) return false;
      if (query.fromMs !== null && event.t < query.fromMs) return false;
      if (query.toMs !== null && event.t > query.toMs) return false;
      return true;
    });
  }
  function fieldAtPath(value, path) {
    if (!path) return undefined;
    var parts = [];
    path.replace(/([A-Za-z0-9_$-]+)|\[([0-9]+)\]/g, function (_, name, index) {
      parts.push(index === undefined ? name : Number(index));
      return _;
    });
    return parts.reduce(function (current, part) {
      return current && typeof current === 'object' ? current[part] : undefined;
    }, value);
  }
  function fieldWindow(artifact, query, sourceSha256) {
    if (query.seq === null || !query.field) return null;
    var event = filtered(artifact, query).find(function (item) { return item.seq === query.seq; });
    if (!event) throw contract.error('RESOURCE_NOT_FOUND', 'Recording event does not exist');
    var raw = fieldAtPath(event, query.field);
    if (typeof raw !== 'string') throw contract.error('INVALID_REQUEST', 'Requested field is not a string');
    var maxChars = Math.min(query.maxChars, contract.LIMITS.MAX_FIELD_WINDOW_CHARS);
    var start = Math.min(query.start, raw.length);
    function responseFor(length) {
      var end = Math.min(raw.length, start + length);
      if (end < raw.length && end > start && /[\uD800-\uDBFF]/.test(raw.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(raw.charAt(end))) end -= 1;
      var value = raw.slice(start, end);
      return {
        sourceSha256: sourceSha256, fromSeq: query.fromSeq, toSeq: query.toSeq,
        event: { seq: event.seq, kind: event.kind, tab: event.tab, t: event.t }, field: query.field, value: value,
        start: start, maxChars: maxChars, returnedChars: value.length, remainingChars: Math.max(0, raw.length - end),
        hasMore: end < raw.length, nextStart: end < raw.length ? end : null,
      };
    }
    var low = 0;
    var high = Math.min(maxChars, raw.length - start);
    var best = responseFor(0);
    while (low <= high) {
      var middle = Math.floor((low + high) / 2);
      var candidate = responseFor(middle);
      if (byteLength(candidate) <= MAX_PRIMARY_DATA_BYTES) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (!best.returnedChars && start < raw.length) {
      throw contract.error('RESPONSE_TOO_LARGE', 'Recording field window metadata exceeds the response budget');
    }
    return best;
  }
  function rangeFields(query) {
    var output = {};
    if (query.fromSeq !== null) output.fromSeq = query.fromSeq;
    if (query.toSeq !== null) output.toSeq = query.toSeq;
    return output;
  }
  function pageData(query, sourceSha256, key, selected, totalMatched, hasMore, nextCursor) {
    return Object.assign(
      Object.assign({ sourceSha256: sourceSha256, limit: query.limit }, rangeFields(query)),
      key === 'search' ? { q: query.q, results: clone(selected) } : { events: clone(selected) },
      { totalMatched: totalMatched, hasMore: hasMore, nextCursor: nextCursor }
    );
  }
  function boundedPage(items, query, sourceSha256, offset, key) {
    var selected = [];
    var index = offset;
    while (index < items.length && selected.length < query.limit) {
      var candidate = selected.concat([items[index]]);
      var candidateIndex = index + 1;
      var candidateHasMore = candidateIndex < items.length;
      var candidateCursor = candidateHasMore
        ? encode({ v: 1, sha256: sourceSha256, shape: queryShape(query), offset: candidateIndex, key: key })
        : null;
      var data = pageData(query, sourceSha256, key, candidate, items.length, candidateHasMore, candidateCursor);
      if (JSON.stringify(data).length > query.maxChars || byteLength(data) > MAX_PRIMARY_DATA_BYTES) {
        if (!selected.length) {
          var oversized = key === 'search' && items[index] && items[index].match ? items[index].match : items[index];
          var fields = [];
          eventStrings(oversized, '', fields);
          throw contract.error('RESPONSE_TOO_LARGE', 'A single Recording event exceeds the response budget; use seq/field/start/maxChars', {
            seq: Number(oversized && oversized.seq) || null,
            stringFields: fields.map(function (entry) { return entry.field; }).filter(Boolean).slice(0, 32),
          });
        }
        break;
      }
      selected = candidate;
      index = candidateIndex;
    }
    var hasMore = index < items.length;
    var cursor = hasMore ? encode({ v: 1, sha256: sourceSha256, shape: queryShape(query), offset: index, key: key }) : null;
    var output = pageData(query, sourceSha256, key, selected, items.length, hasMore, cursor);
    if (JSON.stringify(output).length > query.maxChars || byteLength(output) > MAX_PRIMARY_DATA_BYTES) {
      throw contract.error('RESPONSE_TOO_LARGE', 'Recording page metadata exceeds the response budget');
    }
    return output;
  }
  function cursorOffset(query, sourceSha256, key) {
    if (!query.cursor) return 0;
    var cursor = decode(query.cursor);
    if (!cursor || cursor.v !== 1 || cursor.sha256 !== sourceSha256 || cursor.key !== key
        || cursor.shape !== queryShape(query) || !Number.isInteger(cursor.offset) || cursor.offset < 0) {
      throw contract.error('INVALID_REQUEST', 'Cursor does not match this Recording query');
    }
    return cursor.offset;
  }
  function manifest(recordingId, artifact, sourceSha256) {
    var uri = contract.canonicalRecordingUri(recordingId);
    var retrieval = clone(artifact.retrieval || {});
    retrieval.examples = {
      manifest: { uri: uri },
      events: { uri: uri + '?view=events&limit=' + contract.LIMITS.DEFAULT_EVENTS_LIMIT },
      search: { uri: uri + '?view=search&q=checkout&limit=' + contract.LIMITS.DEFAULT_SEARCH_LIMIT + '&context=1' },
    };
    if (Number(artifact.stats && artifact.stats.eventCount) > 0) {
      retrieval.examples.events.uri += '&fromSeq=1&toSeq=' + Math.min(3, artifact.stats.eventCount);
    }
    var data = {
      schemaVersion: artifact.schemaVersion, kind: artifact.kind, state: artifact.state, sourceSha256: sourceSha256,
      startedAt: artifact.startedAt, durationMs: artifact.durationMs, start: clone(artifact.start), stats: clone(artifact.stats),
      tabs: clone(artifact.tabs || []), retrieval: retrieval,
    };
    var totals = {
      tabs: data.tabs.length,
    };
    retrieval.manifestWindow = { totals: totals, returned: clone(totals), sourceFieldsOmitted: [] };
    function refreshWindow() {
      retrieval.manifestWindow.returned = {
        tabs: data.tabs.length,
      };
    }
    var serialized = JSON.stringify(data);
    while (serialized.length > contract.LIMITS.MAX_MANIFEST_CHARS && data.tabs.length) {
      data.tabs.pop();
      refreshWindow();
      serialized = JSON.stringify(data);
    }
    ['title', 'url'].forEach(function (field) {
      if (serialized.length <= contract.LIMITS.MAX_MANIFEST_CHARS || !data.start || !data.start[field]) return;
      retrieval.manifestWindow.sourceFieldsOmitted.push('start.' + field);
      delete data.start[field];
      serialized = JSON.stringify(data);
    });
    if (serialized.length > contract.LIMITS.MAX_MANIFEST_CHARS || byteLength(data) > MAX_PRIMARY_DATA_BYTES) throw contract.error('RESPONSE_TOO_LARGE', 'Recording manifest exceeds its representation budget');
    return { uri: uri, type: 'PageActionRecording', data: data, links: [{ rel: 'self', href: uri, method: 'GET' }] };
  }
  function eventStrings(value, prefix, output) {
    if (typeof value === 'string') output.push({ field: prefix, value: value });
    else if (Array.isArray(value)) value.forEach(function (item, index) { eventStrings(item, prefix + '[' + index + ']', output); });
    else if (value && typeof value === 'object') Object.keys(value).forEach(function (key) { eventStrings(value[key], prefix ? prefix + '.' + key : key, output); });
  }
  function search(artifact, query) {
    if (!query.q || query.q.length > contract.LIMITS.MAX_SEARCH_QUERY) throw contract.error('INVALID_REQUEST', 'Search q must contain 1..200 characters');
    var needle = query.q.toLocaleLowerCase();
    var candidates = filtered(artifact, query).slice(0, contract.LIMITS.MAX_CANDIDATE_EVENTS);
    var allowedSeq = Object.create(null);
    candidates.forEach(function (event) { allowedSeq[event.seq] = true; });
    var timeline = artifact.timeline || [];
    return candidates.map(function (event) {
      var strings = [];
      eventStrings(event, '', strings);
      var matchedFields = strings.filter(function (entry) { return entry.value.toLocaleLowerCase().indexOf(needle) !== -1; }).map(function (entry) { return entry.field; });
      if (!matchedFields.length) return null;
      var neighbors = timeline.filter(function (candidate) {
        return allowedSeq[candidate.seq] && Math.abs(candidate.seq - event.seq) <= query.context && candidate.seq !== event.seq;
      }).map(function (candidate) { return clone(candidate); });
      return { match: clone(event), matchedFields: matchedFields, neighbors: neighbors };
    }).filter(Boolean);
  }
  function project(input) {
    input = input || {};
    var recordingId = text(input.recordingId);
    var artifact = input.artifact;
    var sourceSha256 = contract.normalizeSha256(input.sourceSha256);
    if (!artifact || artifact.kind !== 'page-action-recording') throw contract.error('RESOURCE_NOT_FOUND', 'Recording Artifact is missing');
    var query = normalizedQuery(artifact, input.query || {});
    if (query.view === 'manifest') return manifest(recordingId, artifact, sourceSha256);
    var uri = contract.canonicalRecordingUri(recordingId);
    var windowResult = fieldWindow(artifact, query, sourceSha256);
    if (windowResult) return { uri: uri, type: 'PageActionRecordingEvents', data: windowResult, links: [{ rel: 'recording', href: uri, method: 'GET' }] };
    var items = query.view === 'search' ? search(artifact, query) : filtered(artifact, query);
    var offset = cursorOffset(query, sourceSha256, query.view);
    if (offset > items.length) throw contract.error('INVALID_REQUEST', 'Cursor points beyond this Recording projection');
    var data = boundedPage(items, query, sourceSha256, offset, query.view);
    return {
      uri: uri, type: query.view === 'search' ? 'PageActionRecordingSearch' : 'PageActionRecordingEvents',
      data: data,
      links: [{ rel: 'recording', href: uri, method: 'GET' }],
    };
  }
  return Object.freeze({ API_VERSION: API_VERSION, project: project, normalizeQuery: normalizedQuery, normalizeRanges: contract.normalizeRanges });
});
