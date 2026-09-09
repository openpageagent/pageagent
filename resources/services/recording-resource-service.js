(function attachRecordingResourceService(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol;
  var contract = commonJs ? require('../../shared/recording-contract') : root.PageAutomationRecordingContract;
  var api = factory(arp, contract);
  if (commonJs) module.exports = api;
  else root.RecordingResourceService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, contract) {
  'use strict';

  if (!arp || !contract) throw new Error('RecordingResourceService dependencies are incomplete');
  var API_VERSION = 1;
  var BOUNDARY_CODES = Object.freeze({
    FORBIDDEN: true, RESOURCE_NOT_FOUND: true, INVALID_REQUEST: true, RESPONSE_TOO_LARGE: true,
  });
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function byteLength(value) {
    var serialized = JSON.stringify(value);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(serialized).length;
    return unescape(encodeURIComponent(serialized)).length;
  }
  function boundaryError(error) {
    var code = text(error && error.code);
    if (/^RECORDING_(?:HASH_MISMATCH|STATE_CONFLICT)$/.test(code)) code = 'RESOURCE_NOT_FOUND';
    if (!BOUNDARY_CODES[code]) code = 'RESOURCE_NOT_FOUND';
    return arp.arpError(code, error && error.message || code, {
      details: code === 'INVALID_REQUEST' ? error && error.details : undefined,
      performed: 'no',
    });
  }

  function create(options) {
    options = options || {};
    var store = options.recordingStore || options.store;
    var projector = options.recordingProjector || options.projector;
    if (!store || typeof store.authorizeGrant !== 'function') {
      throw new TypeError('RecordingResourceService requires RecordingArtifactStore');
    }
    if (!projector || typeof projector.project !== 'function') {
      throw new TypeError('RecordingResourceService requires RecordingArtifactProjector');
    }

    async function getRecording(recordingId, query, context) {
      context = context || {};
      try {
        var recordingUri = contract.canonicalRecordingUri(recordingId);
        var authorization = await store.authorizeGrant({
          recordingId: recordingId, recordingUri: recordingUri,
          conversationId: text(context.conversationId), generationId: text(context.generationId),
          actorId: text(context.actorId), profileId: text(context.profileId || 'default'),
          incognito: context.incognito === true,
        });
        if (!authorization) throw contract.error('FORBIDDEN', 'Recording is not granted to this generation');
        var projected = projector.project({
          recordingId: recordingId,
          sourceSha256: authorization.artifact.sourceSha256,
          artifact: authorization.artifact.artifact,
          query: query || {},
        });
        if (byteLength(projected.data) > 32768) {
          throw contract.error('RESPONSE_TOO_LARGE', 'Recording representation exceeds 32 KiB; reduce limit/maxChars or use field windowing');
        }
        return projected;
      } catch (error) {
        throw boundaryError(error);
      }
    }
    function etag(value) { return text(value && value.sourceSha256 || value && value.data && value.data.sourceSha256); }

    return Object.freeze({ API_VERSION: API_VERSION, getRecording: getRecording, etag: etag });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
