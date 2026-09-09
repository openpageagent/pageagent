(function attachRecordingCompiler(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var contract = commonJs ? require('../shared/recording-contract') : root.PageAutomationRecordingContract;
  var nodeCrypto = null;
  if (commonJs) { try { nodeCrypto = require('node:crypto'); } catch (_) {} }
  var api = factory(root, contract, nodeCrypto);
  if (commonJs) module.exports = api;
  if (root) root.PageAutomationRecordingCompiler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, contract, nodeCrypto) {
  'use strict';
  if (!contract || contract.API_VERSION !== 1) throw new Error('RecordingContract must load before RecordingCompiler');
  var API_VERSION = 1;
  function clone(value) { return contract.clone(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value); }
  function hex(bytes) { return Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join(''); }
  async function hash(value, cryptoApi) {
    var serialized = typeof value === 'string' ? value : contract.stableStringify(value);
    if (nodeCrypto && nodeCrypto.createHash) return 'sha256:' + nodeCrypto.createHash('sha256').update(serialized).digest('hex');
    cryptoApi = cryptoApi || root.crypto;
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function executableLocator(raw) {
    var source = contract.normalizeLocator(raw);
    if (!source) return null;
    var output = {};
    ['selector', 'textSelector', 'textPattern', 'label', 'scopeSelector'].forEach(function (key) {
      if (source[key] === undefined) return;
      var limit = key === 'selector' || key === 'scopeSelector' ? 1000 : 500;
      var value = text(source[key]);
      if (value.length > limit) value = value.slice(0, limit);
      output[key] = value;
    });
    if (source.relative) output.relative = source.relative;
    return Object.keys(output).length ? output : null;
  }
  function targetKey(event) {
    var payload = event.payload || {};
    return text(payload.targetKey || payload.locator && (payload.locator.selector || payload.locator.textSelector) || payload.tag || '');
  }
  function clockClamp(events, startedAt, cutoffAt) {
    var ceiling = Math.min(
      startedAt + contract.LIMITS.MAX_DURATION_MS,
      Math.max(startedAt, Number(cutoffAt) || startedAt + contract.LIMITS.MAX_DURATION_MS)
    );
    var batchClock = Object.create(null);
    return events.map(function (event) {
      var occurredAt = Math.min(ceiling, Math.max(startedAt, Number(event.occurredAt) || startedAt));
      var batchKey = text(event.source && event.source.documentKey) + '\n' + text(event.documentLocalBatchId);
      if (batchKey !== '\n') {
        occurredAt = Math.max(Number(batchClock[batchKey]) || startedAt, occurredAt);
        batchClock[batchKey] = occurredAt;
      }
      return Object.assign({}, clone(event), { occurredAt: occurredAt, clampedOccurredAt: occurredAt });
    }).sort(function (left, right) {
      return left.clampedOccurredAt - right.clampedOccurredAt || left.appendSeq - right.appendSeq;
    });
  }
  function mergeFills(events) {
    var output = [];
    events.forEach(function (event) {
      var previous = output[output.length - 1];
      if (event.kind === 'fill' && previous && previous.kind === 'fill'
          && targetKey(previous) && targetKey(previous) === targetKey(event)
          && previous.source && event.source
          && previous.source.documentKey === event.source.documentKey) {
        output[output.length - 1] = event;
      } else output.push(event);
    });
    return output;
  }
  function exactClickDedupe(events) {
    var seen = Object.create(null);
    return events.filter(function (event) {
      if (event.kind !== 'click') return true;
      var sourceKey = text(event.source && event.source.documentKey) + '\n' + text(event.localEventId);
      if (!event.localEventId || !seen[sourceKey]) { seen[sourceKey] = true; return true; }
      return false;
    });
  }
  function dropNavigationNoise(events) {
    var authoritativeEvents = Object.create(null);
    function navigationKey(event) {
      return text(event.source && event.source.tabKey) + '\n' + text(event.source && event.source.frameId);
    }
    events.forEach(function (event) {
      if (event.kind !== 'navigation' || text(event.payload && event.payload.status) === 'reconciled') return;
      var key = navigationKey(event);
      if (!authoritativeEvents[key]) authoritativeEvents[key] = [];
      authoritativeEvents[key].push({
        occurredAt: Number(event.clampedOccurredAt) || 0,
        to: text(event.payload && (event.payload.to === undefined ? event.payload.url : event.payload.to)),
      });
    });
    var lastDestination = Object.create(null);
    return events.filter(function (event) {
      if (event.kind !== 'navigation') return true;
      var payload = event.payload || {};
      var status = text(payload.status || 'committed');
      var from = text(payload.from);
      var to = text(payload.to === undefined ? payload.url : payload.to);
      var key = navigationKey(event);
      if (/^(?:history|fragment|reconciled)$/.test(status) && from === to) return false;
      if (status === 'reconciled' && (authoritativeEvents[key] || []).some(function (authoritative) {
        return authoritative.to === to
          && Math.abs(authoritative.occurredAt - Number(event.clampedOccurredAt)) <= 500;
      })) return false;
      if (/^(?:history|fragment|reconciled)$/.test(status) && lastDestination[key] === to) return false;
      if (/^(?:committed|history|fragment|reconciled)$/.test(status)) lastDestination[key] = to;
      return true;
    });
  }
  function isTimelineFact(event) {
    if (!event || event.kind === 'gap' || event.kind === 'navigation_signal') return false;
    if (event.kind !== 'navigation' || Number(event.source && event.source.frameId) === 0) return true;
    var payload = event.payload || {};
    var destination = text(payload.to === undefined ? payload.url : payload.to);
    return !/^about:blank(?:[#?]|$)/i.test(destination);
  }
  function reconcileNavigationOccurrences(events) {
    var output = [];
    var pending = Object.create(null);
    events.forEach(function (event) {
      if (event.kind === 'navigation') {
        var payload = event.payload || {};
        var occurrenceId = text(payload.occurrenceId);
        var status = text(payload.status || 'committed');
        var key = text(event.source && event.source.tabKey) + '\n' + text(event.source && event.source.frameId) + '\n' + occurrenceId;
        if (occurrenceId && (status === 'completed' || status === 'error') && pending[key]) {
          var prior = pending[key];
          prior.payload.status = status;
          prior.payload.completedAt = event.clampedOccurredAt;
          if (payload.error) prior.payload.error = text(payload.error);
          if (!prior.payload.to && payload.to) prior.payload.to = text(payload.to);
          delete pending[key];
          return;
        }
        if (status === 'completed') return;
        output.push(event);
        if (occurrenceId && status === 'committed') pending[key] = event;
        return;
      }
      if (event.kind === 'tab_closed') {
        var tabPrefix = text(event.source && event.source.tabKey) + '\n';
        Object.keys(pending).forEach(function (key) {
          if (key.indexOf(tabPrefix) !== 0) return;
          pending[key].payload.status = 'tab_closed';
          pending[key].payload.completedAt = event.clampedOccurredAt;
          delete pending[key];
        });
      }
      output.push(event);
    });
    return output;
  }
  function collapseSpaNavigationBursts(events) {
    var output = [];
    var active = Object.create(null);
    events.forEach(function (event) {
      var source = event.source || {};
      var key = text(source.tabKey) + '\n' + text(source.frameId);
      var payload = event.payload || {};
      var status = event.kind === 'navigation' ? text(payload.status) : '';
      var occurredAt = Number(event.clampedOccurredAt) || 0;
      var previous = active[key];
      if (/^(?:history|fragment|reconciled)$/.test(status)) {
        if (previous && occurredAt - previous.lastAt <= 1000) {
          previous.event.payload.url = payload.url;
          previous.event.payload.to = payload.to;
          previous.event.payload.status = status;
          previous.event.payload.documentId = payload.documentId;
          previous.event.payload.transitionType = payload.transitionType;
          previous.event.payload.transitionQualifiers = clone(payload.transitionQualifiers || []);
          previous.lastAt = occurredAt;
          return;
        }
        output.push(event);
        active[key] = { event: event, lastAt: occurredAt };
        return;
      }
      delete active[key];
      output.push(event);
    });
    return output.filter(function (event) {
      if (event.kind !== 'navigation') return true;
      var payload = event.payload || {};
      return !/^(?:history|fragment|reconciled)$/.test(text(payload.status))
        || text(payload.from) !== text(payload.to === undefined ? payload.url : payload.to);
    });
  }
  function aliases(events, session) {
    var tabMap = Object.create(null);
    var tabRecords = Object.create(null);
    var ordered = [];
    function ensure(sourceTabKey, raw) {
      sourceTabKey = text(sourceTabKey);
      if (!sourceTabKey) sourceTabKey = 'seed';
      if (!tabMap[sourceTabKey]) {
        var alias = 'T' + (ordered.length + 1);
        tabMap[sourceTabKey] = alias;
        var record = { alias: alias, sourceTabKey: sourceTabKey, openedAt: raw && raw.occurredAt || session.startedAt, initialUrl: text(raw && raw.payload && (raw.payload.url || raw.payload.pendingUrl)) };
        tabRecords[sourceTabKey] = record;
        ordered.push(record);
      }
      return tabMap[sourceTabKey];
    }
    ensure(text(session.seedTabKey || session.seedTabId || 'seed'), { occurredAt: session.startedAt, payload: { url: session.startUrl } });
    events.forEach(function (event) {
      var payload = event.payload || {};
      if (event.kind === 'tab_created' && payload.openerTabKey) ensure(payload.openerTabKey, event);
      var sourceKey = text(event.source && event.source.tabKey);
      ensure(sourceKey, event);
      var record = tabRecords[sourceKey];
      if (!record) return;
      if (event.kind === 'tab_created') {
        record.openedAt = event.occurredAt;
        record.initialUrl = text(payload.url);
        record.opener = payload.openerTabKey ? tabMap[text(payload.openerTabKey)] || '' : '';
        record.windowCreated = payload.windowCreated === true;
        if (payload.recoveredAfterWorkerRestart === true) record.recoveredAfterWorkerRestart = true;
      } else if (event.kind === 'tab_closed') {
        record.closedAt = event.occurredAt;
        record.windowClosing = payload.windowClosing === true;
      } else if (event.kind === 'navigation' && payload.to) record.lastUrl = text(payload.to);
    });
    return { map: tabMap, records: tabRecords, tabs: ordered };
  }
  function semanticEvent(raw, seq, startedAt, aliasState) {
    var payload = clone(raw.payload || {});
    var source = raw.source || {};
    var recordingStart = raw.kind === 'recording_start' || raw.kind === 'tab_created' && payload.seed === true;
    var event = {
      seq: seq,
      t: Math.max(0, Math.round(raw.clampedOccurredAt - startedAt)),
      kind: recordingStart ? 'recording_start' : raw.kind,
      tab: aliasState.map[text(source.tabKey)] || 'T1',
      frame: Number(source.frameId) === 0 ? 'top' : 'child',
      locator: executableLocator(payload.locator),
      target: payload.target ? clone(payload.target) : null,
      value: payload.value === undefined ? undefined : clone(payload.value),
      url: payload.url === undefined ? undefined : text(payload.url),
      navigation: payload.navigation ? clone(payload.navigation) : undefined,
      causation: payload.causation ? clone(payload.causation) : undefined,
      input: payload.input ? clone(payload.input) : undefined,
    };
    if (recordingStart && payload.title !== undefined) event.title = text(payload.title);
    if (payload.href !== undefined) event.href = text(payload.href);
    if (payload.action !== undefined) event.action = text(payload.action);
    if (event.kind === 'tab_created') {
      event.tabEvent = {
        disposition: 'created',
        openerTab: payload.openerTabKey ? aliasState.map[text(payload.openerTabKey)] || '' : '',
        windowCreated: payload.windowCreated === true,
        recoveredAfterWorkerRestart: payload.recoveredAfterWorkerRestart === true,
      };
    } else if (event.kind === 'tab_closed') {
      event.tabEvent = { disposition: 'closed', windowClosing: payload.windowClosing === true };
    } else if (event.kind === 'navigation_target') {
      event.causation = {
        kind: 'created_navigation_target', sourceTab: payload.sourceTab ? aliasState.map[text(payload.sourceTab)] || '' : '',
        sourceFrame: Number(payload.sourceFrameId) === 0 ? 'top' : 'child',
      };
    }
    if (event.kind === 'navigation') {
      event.navigation = Object.assign({}, event.navigation || {}, {
        occurrenceId: text(payload.occurrenceId), documentId: text(payload.documentId),
        from: payload.from === undefined ? '' : text(payload.from),
        to: payload.to === undefined ? text(payload.url) : text(payload.to),
        transitionType: text(payload.transitionType),
        transitionQualifiers: Array.isArray(payload.transitionQualifiers) ? payload.transitionQualifiers.map(text) : [],
        disposition: payload.disposition === 'effect' || payload.disposition === 'explicit' ? payload.disposition : 'unknown',
        triggerSeq: Number(payload.triggerSeq) || null,
        status: text(payload.status || 'committed'),
        error: text(payload.error),
        completedAfterMs: payload.completedAt === undefined ? null : Math.max(0, Math.round(Number(payload.completedAt) - startedAt)),
      });
    }
    Object.keys(event).forEach(function (key) { if (event[key] === undefined || event[key] === null) delete event[key]; });
    return event;
  }
  function causalNavigation(timeline) {
    var lastSemanticByTab = Object.create(null);
    timeline.forEach(function (event) {
      if (event.kind === 'navigation') {
        var prior = lastSemanticByTab[event.tab];
        var transition = text(event.navigation && event.navigation.transitionType);
        if (/typed|auto_bookmark|keyword/.test(transition)) {
          event.navigation.disposition = 'explicit';
          event.navigation.triggerSeq = null;
        } else if (prior && event.t - prior.t <= 5000) {
          event.navigation.triggerSeq = prior.seq;
          event.navigation.disposition = 'effect';
        } else event.navigation.disposition = event.navigation.disposition || 'unknown';
      }
      if (/^(?:click|fill|select|key|submit)$/.test(event.kind)) lastSemanticByTab[event.tab] = event;
    });
  }
  async function compile(input, options) {
    input = input || {};
    options = options || {};
    var session = clone(input.session || {});
    var raw = Array.isArray(input.events) ? input.events.map(clone) : [];
    var startedAt = Number(session.startedAt) || 0;
    raw = clockClamp(raw, startedAt, session.cutoffAt);
    raw = mergeFills(raw);
    raw = exactClickDedupe(raw);
    raw = dropNavigationNoise(raw);
    raw = reconcileNavigationOccurrences(raw);
    raw = collapseSpaNavigationBursts(raw);
    var timelineRaw = raw.filter(isTimelineFact);
    var aliasState = aliases(timelineRaw, session);
    var timeline = timelineRaw.map(function (event, index) { return semanticEvent(event, index + 1, startedAt, aliasState); });
    causalNavigation(timeline);
    var durationMs = Math.min(contract.LIMITS.MAX_DURATION_MS, Math.max(0, Number(session.cutoffAt || session.stoppedAt || (raw.length && raw[raw.length - 1].clampedOccurredAt) || startedAt) - startedAt));
    var artifact = {
      schemaVersion: 1, kind: 'page-action-recording', state: session.terminalState || (session.truncated ? 'truncated' : 'ready'),
      startedAt: startedAt, durationMs: durationMs,
      start: { url: text(session.startUrl), title: text(session.startTitle), seedTab: 'T1' },
      stats: {
        eventCount: timeline.length, tabCount: aliasState.tabs.length,
        domainCount: Array.from(new Set(timeline.map(function (event) {
          try { return new URL(event.url || event.navigation && event.navigation.to || '').hostname; } catch (_) { return ''; }
        }).filter(Boolean))).length,
      },
      tabs: aliasState.tabs.map(function (tab) { var copy = clone(tab); delete copy.sourceTabKey; return copy; }),
      timeline: timeline,
      retrieval: {
        views: ['manifest', 'events', 'search'], maxEventPageSize: contract.LIMITS.MAX_EVENTS_LIMIT,
        examples: {
          manifest: { uri: '/recordings/{recordingId}' },
          events: { uri: '/recordings/{recordingId}?view=events&fromSeq=1&toSeq=' + Math.min(3, timeline.length || 1) + '&limit=20' },
          search: { uri: '/recordings/{recordingId}?view=search&q=checkout&limit=8&context=1' },
        },
      },
    };
    var semantic = clone(artifact);
    delete semantic.compiledAt;
    var sourceSha256 = await hash(semantic, options.crypto || root.crypto);
    return Object.freeze({ artifact: Object.freeze(artifact), sourceSha256: sourceSha256 });
  }
  return Object.freeze({ API_VERSION: API_VERSION, compile: compile, semanticHash: hash });
});
