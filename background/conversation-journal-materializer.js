(function attachConversationJournalMaterializer(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var contract = commonJs ? require('../shared/recording-contract') : root.PageAutomationRecordingContract;
  var api = factory(contract);
  if (commonJs) module.exports = api;
  else root.ConversationJournalMaterializer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';

  if (!contract || contract.API_VERSION !== 1) {
    throw new Error('RecordingContract must load before ConversationJournalMaterializer');
  }
  var API_VERSION = 1;
  var RANGE_KIND = 'page-action-recording-range';
  var MAX_RETAINED_RECORDINGS = 128;

  function clone(value) { return contract.clone(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function eventAttachments(event) {
    if (!event || (event.type !== 'user_message_appended' && event.type !== 'steering_message_appended')) return [];
    var payload = event.payload || {};
    var message = payload.message || payload;
    return message && Array.isArray(message.attachments) ? message.attachments : [];
  }
  function normalizeAttachment(attachment, event, order) {
    if (!attachment || attachment.kind !== RANGE_KIND) return null;
    var recordingId = contract.recordingIdFromUri(attachment.artifactUri);
    var metadata = attachment.metadata || {};
    var eventCount = Number(metadata.eventCount);
    var range = contract.normalizeRange({
      fromSeq: metadata.fromSourceSeq,
      toSeq: metadata.toSourceSeq,
    }, eventCount);
    return {
      recordingId: recordingId,
      recordingUri: contract.canonicalRecordingUri(recordingId),
      sourceSha256: contract.normalizeSha256(attachment.sha256),
      name: text(attachment.name).slice(0, 256),
      eventCount: eventCount,
      durationMs: Math.max(0, Number(metadata.durationMs) || 0),
      tabCount: Math.max(0, Number(metadata.tabCount) || 0),
      domainCount: Math.max(0, Number(metadata.domainCount) || 0),
      state: text(metadata.state),
      selectedRange: {
        fromSeq: range.fromSeq, toSeq: range.toSeq,
        eventCount: range.toSeq - range.fromSeq + 1,
        selectionOrder: order,
        journalSequence: Math.max(0, Number(event && event.sequence) || 0),
      },
    };
  }
  function addHandle(groups, order, handle) {
    if (!handle) return;
    var key = handle.recordingUri + '\n' + handle.sourceSha256;
    var group = groups[key];
    if (!group) {
      group = groups[key] = {
        recordingId: handle.recordingId, recordingUri: handle.recordingUri,
        sourceSha256: handle.sourceSha256, name: handle.name,
        eventCount: handle.eventCount, durationMs: handle.durationMs,
        tabCount: handle.tabCount, domainCount: handle.domainCount,
        state: handle.state,
        selectedRanges: [], firstOrder: order,
      };
    }
    var range = handle.selectedRange;
    if (!range) return;
    var rangeKey = range.fromSeq + ':' + range.toSeq;
    if (group.selectedRanges.some(function (current) { return current.fromSeq + ':' + current.toSeq === rangeKey; })) return;
    if (group.selectedRanges.length >= 32) group.selectedRanges.shift();
    group.selectedRanges.push(clone(range));
  }
  function addRetained(groups, order, retained) {
    if (!retained) return;
    var recordingId = contract.recordingIdFromUri(retained.recordingUri);
    var sourceSha256 = contract.normalizeSha256(retained.sourceSha256);
    var ranges = Array.isArray(retained.selectedRanges) ? retained.selectedRanges : [];
    if (!ranges.length) return;
    ranges.forEach(function (range, index) {
      var normalized = contract.normalizeRange(range, Number(retained.eventCount));
      addHandle(groups, order, {
        recordingId: recordingId, recordingUri: contract.canonicalRecordingUri(recordingId),
        sourceSha256: sourceSha256, name: text(retained.name).slice(0, 256),
        eventCount: Number(retained.eventCount), durationMs: Math.max(0, Number(retained.durationMs) || 0),
        tabCount: Math.max(0, Number(retained.tabCount) || 0), domainCount: Math.max(0, Number(retained.domainCount) || 0),
        state: text(retained.state),
        selectedRange: {
          fromSeq: normalized.fromSeq, toSeq: normalized.toSeq,
          eventCount: normalized.toSeq - normalized.fromSeq + 1,
          selectionOrder: index, journalSequence: Math.max(0, Number(range.journalSequence) || 0),
        },
      });
    });
  }

  function create(options) {
    options = options || {};
    var journal = options.journal;
    if (!journal || typeof journal.getPayloadBlob !== 'function' || typeof journal.getAllEvents !== 'function') {
      throw new TypeError('ConversationJournalMaterializer requires ConversationJournalStore');
    }

    async function materializeEvent(value) {
      var event = clone(value || {});
      if (!event.payloadRef) return event;
      var blob = await journal.getPayloadBlob(event.payloadRef.payloadId, event.payloadRef.sha256);
      if (!blob) {
        var error = new Error('Externalized Journal payload is missing');
        error.code = 'PAYLOAD_MISSING';
        throw error;
      }
      event.payload = clone(blob.value);
      event.payloadStorage = { externalized: true, payloadRef: clone(event.payloadRef) };
      return event;
    }
    async function materializeEvents(values) {
      var events = [];
      for (var index = 0; index < (values || []).length; index += 1) {
        events.push(await materializeEvent(values[index]));
      }
      return events;
    }
    async function getAllEvents(conversationId) {
      return materializeEvents(await journal.getAllEvents(conversationId));
    }
    function collectRecordingContext(events, checkpoint) {
      var groups = Object.create(null);
      var order = 0;
      (checkpoint && Array.isArray(checkpoint.retainedRecordingRefs) ? checkpoint.retainedRecordingRefs : []).forEach(function (retained) {
        addRetained(groups, order++, retained);
      });
      (Array.isArray(events) ? events : []).forEach(function (event) {
        eventAttachments(event).forEach(function (attachment, index) {
          addHandle(groups, order++, normalizeAttachment(attachment, event, index));
        });
      });
      return Object.keys(groups).map(function (key) { return groups[key]; })
        .sort(function (left, right) { return left.firstOrder - right.firstOrder; })
        .slice(-MAX_RETAINED_RECORDINGS)
        .map(function (handle) {
          delete handle.firstOrder;
          var selectedRange = handle.selectedRanges[0];
          var eventsUri = handle.recordingUri + '?view=events';
          if (selectedRange) eventsUri += '&fromSeq=' + selectedRange.fromSeq + '&toSeq=' + selectedRange.toSeq;
          eventsUri += '&limit=20';
          handle.retrieval = {
            default: { method: 'GET', uri: handle.recordingUri },
            events: { method: 'GET', uri: eventsUri },
            search: { method: 'GET', uri: handle.recordingUri + '?view=search&q=keyword&limit=8&context=1' },
          };
          return handle;
        });
    }
    function retainedRecordingRefs(events, previousCheckpoint) {
      return collectRecordingContext(events, previousCheckpoint).map(function (handle) {
        var retained = clone(handle);
        delete retained.recordingId;
        delete retained.retrieval;
        retained.selectedRanges = retained.selectedRanges.map(function (range) {
          return {
            fromSeq: range.fromSeq, toSeq: range.toSeq,
            eventCount: range.eventCount, journalSequence: range.journalSequence,
          };
        });
        return retained;
      });
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      materializeEvent: materializeEvent,
      materializeEvents: materializeEvents,
      getAllEvents: getAllEvents,
      collectRecordingContext: collectRecordingContext,
      retainedRecordingRefs: retainedRecordingRefs,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
