(function attachConversationRecordingAttachments(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var contract = commonJs ? require('../shared/recording-contract') : root.PageAutomationRecordingContract;
  var api = factory(contract);
  if (commonJs) module.exports = api;
  else root.PageAutomationConversationRecordingAttachments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';

  if (!contract || contract.API_VERSION !== 1) {
    throw new Error('RecordingContract must load before ConversationRecordingAttachments');
  }
  var API_VERSION = 1;
  var RANGE_KIND = 'page-action-recording-range';

  function clone(value) { return contract.clone(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function recordingAttachments(message) {
    return (message && Array.isArray(message.attachments) ? message.attachments : []).filter(function (attachment) {
      return attachment && attachment.kind === RANGE_KIND;
    });
  }
  function attachmentRange(attachment, order) {
    var recordingId = contract.recordingIdFromUri(attachment.artifactUri);
    return {
      recordingId: recordingId,
      recordingUri: contract.canonicalRecordingUri(recordingId),
      sourceSha256: contract.normalizeSha256(attachment.sha256),
      fromSeq: Number(attachment.metadata.fromSourceSeq),
      toSeq: Number(attachment.metadata.toSourceSeq),
      selectionOrder: order,
    };
  }
  function sameRange(left, right) {
    return text(left.recordingId) === text(right.recordingId)
      && text(left.recordingUri) === text(right.recordingUri)
      && text(left.sourceSha256) === text(right.sourceSha256)
      && Number(left.fromSeq) === Number(right.fromSeq)
      && Number(left.toSeq) === Number(right.toSeq)
      && Number(left.selectionOrder) === Number(right.selectionOrder);
  }

  function create(options) {
    options = options || {};
    var store = options.store;
    var journal = options.journal;
    if (!store || typeof store.prepareSelectionOperation !== 'function') {
      throw new TypeError('ConversationRecordingAttachments requires RecordingArtifactStore');
    }
    if (!journal || typeof journal.getMetadata !== 'function') {
      throw new TypeError('ConversationRecordingAttachments requires ConversationJournalStore');
    }
    var resolveAssistant = typeof options.resolveAssistant === 'function'
      ? options.resolveAssistant : async function () { return null; };
    var onCollectionChanged = typeof options.onCollectionChanged === 'function'
      ? options.onCollectionChanged : function () {};

    async function prepareCommand(input, context) {
      input = clone(input || {});
      context = context || {};
      var attachments = recordingAttachments(input.message);
      var claim = input.recordingSelectionClaim || null;
      delete input.recordingSelectionClaim;
      if (!attachments.length) {
        if (claim) throw contract.error('INVALID_REQUEST', 'Recording selection claim and range attachments must be sent together');
        var existingOperation = await store.getOperationByCommand(input.commandId);
        if (existingOperation && existingOperation.kind === 'recording_selection_claim') {
          throw contract.error('INVALID_REQUEST', 'A retry of this command must include the original complete Recording selection');
        }
        return { input: input, operation: null };
      }
      if (!claim) throw contract.error('FORBIDDEN', 'Recording range attachments require a selection claim');
      if (attachments.length !== claim.orderedRanges.length) {
        throw contract.error('INVALID_REQUEST', 'Recording selection claim must cover every range attachment');
      }
      var ranges = attachments.map(attachmentRange);
      for (var index = 0; index < ranges.length; index += 1) {
        if (!sameRange(ranges[index], claim.orderedRanges[index])) {
          throw contract.error('INVALID_REQUEST', 'Recording range attachments do not match the claimed order');
        }
      }
      var surface = context.surface || {};
      var metadata = input.assistantId ? null : await journal.getMetadata(input.conversationId);
      var assistantId = text(input.assistantId || metadata && metadata.assistantId);
      if (!assistantId) throw contract.error('FORBIDDEN', 'Recording selection requires a Conversation assistant');
      var assistant = await resolveAssistant(assistantId);
      if (!assistant) throw contract.error('FORBIDDEN', 'Recording selection assistant no longer exists');
      var profileId = text(assistant.profileId || 'default');
      var operation = await store.prepareSelectionOperation({
        commandId: input.commandId, conversationId: input.conversationId, assistantId: assistantId,
        actorId: 'assistant:' + assistantId, profileId: profileId, collectionProfileId: 'default',
        incognito: surface.incognito === true,
        draftCollectionId: claim.draftCollectionId, selectionId: claim.selectionId,
        expectedRevision: claim.expectedRevision, orderedRanges: ranges,
      });
      return { input: input, operation: operation };
    }

    async function commitCommand(prepared, generationId) {
      var operation = prepared && prepared.operation ? prepared.operation : prepared;
      if (!operation) return { operation: null, recordingUris: [] };
      if (operation.state !== 'committed') {
        if (operation.state === 'prepared') {
          operation = await store.updateOperation(operation.operationId, { state: 'journal_committed' });
        }
        operation = await store.promoteSelection({ operationId: operation.operationId, generationId: generationId });
      }
      try { onCollectionChanged(operation.draftCollectionId); } catch (_) {}
      return {
        operation: operation,
        recordingUris: Array.from(new Set((operation.orderedRanges || []).map(function (range) { return range.recordingUri; }))),
      };
    }

    async function prepareGeneration(input) {
      input = input || {};
      var pending = await store.listOperations(['prepared', 'journal_committed']);
      for (var operationIndex = 0; operationIndex < pending.length; operationIndex += 1) {
        var operation = pending[operationIndex];
        if (operation.kind !== 'recording_selection_claim'
            || operation.conversationId !== text(input.conversationId)) continue;
        var commandResult = await journal.getCommandResult(operation.commandId);
        if (!commandResult || text(commandResult.generationId) !== text(input.generationId)) continue;
        await commitCommand(operation, input.generationId);
      }
      var grants = await store.prepareGeneration({
        generationId: input.generationId, conversationId: input.conversationId,
        actorId: input.actorId, profileId: input.profileId, incognito: input.incognito === true,
        recordings: input.recordings || [],
      });
      return {
        grants: grants,
        visibleResourceUris: grants.map(function (grant) { return grant.recordingUri; }),
      };
    }

    function endGeneration(generationId) {
      return store.endGeneration(generationId);
    }

    async function releaseConversation(conversationId) {
      conversationId = text(conversationId);
      var commandId = 'conversation-recording-release:'
        + (store.runtimeScope === 'incognito' ? 'incognito:' : '') + conversationId;
      var operation = await store.prepareOperation({
        operationId: commandId, commandId: commandId, kind: 'conversation_release',
        conversationId: conversationId, state: 'prepared',
      });
      var deleted = await journal.deleteConversation(conversationId);
      var released = await store.releaseConversation(conversationId);
      await store.updateOperation(operation.operationId, { state: 'released', result: released });
      return deleted;
    }

    async function reconcile() {
      var active = await journal.listActiveConversations();
      var activeGenerationIds = active.map(function (metadata) {
        return text(metadata && metadata.activeGeneration && metadata.activeGeneration.generationId);
      }).filter(Boolean);
      var operations = await store.listOperations(['prepared', 'journal_committed']);
      var recovered = [];
      for (var index = 0; index < operations.length; index += 1) {
        var operation = operations[index];
        if (operation.kind === 'recording_selection_claim') {
          var commandResult = await journal.getCommandResult(operation.commandId);
          if (!commandResult || !text(commandResult.generationId)) continue;
          await commitCommand(operation, commandResult.generationId);
          recovered.push(operation.operationId);
        } else if (operation.kind === 'conversation_release') {
          var metadata = await journal.getMetadata(operation.conversationId);
          if (metadata) continue;
          var released = await store.releaseConversation(operation.conversationId);
          await store.updateOperation(operation.operationId, { state: 'released', result: released });
          recovered.push(operation.operationId);
        }
      }
      var grants = await store.reconcileGrants(activeGenerationIds);
      return { activeConversationCount: active.length, recoveredOperations: recovered, grants: grants };
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      prepareCommand: prepareCommand,
      commitCommand: commitCommand,
      prepareGeneration: prepareGeneration,
      endGeneration: endGeneration,
      releaseConversation: releaseConversation,
      reconcile: reconcile,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
