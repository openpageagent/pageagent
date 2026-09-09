// Strict Conversation Command Bus protocol shared by every conversation surface.
(function attachConversationProtocol(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var SCHEMA_VERSION = 1;
  var COMMANDS = Object.freeze({
    START_TURN: 'START_TURN',
    CANCEL_GENERATION: 'CANCEL_GENERATION',
    STEER_GENERATION: 'STEER_GENERATION',
    INTERRUPT_MODEL_REQUEST: 'INTERRUPT_MODEL_REQUEST',
    RESOLVE_INTERACTION: 'RESOLVE_INTERACTION',
    GET_CONVERSATION: 'GET_CONVERSATION',
    GET_EVENTS: 'GET_EVENTS',
    GET_SUMMARY: 'GET_SUMMARY',
  });
  var COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS).map(function (key) { return COMMANDS[key]; }));
  var SURFACE_TYPES = Object.freeze(['options', 'page', 'sidepanel', 'scheduled', 'mcp']);
  var ENTRY_TYPES = Object.freeze(['conversation', 'page', 'scheduled']);
  var TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'truncated', 'blocked']);
  var ERROR_CODES = Object.freeze([
    'INVALID_COMMAND',
    'CONVERSATION_NOT_FOUND',
    'ASSISTANT_MISMATCH',
    'SERVICE_NOT_FOUND',
    'GENERATION_CONFLICT',
    'GENERATION_STALE',
    'INTERACTION_NOT_FOUND',
    'INTERACTION_EXPIRED',
    'CAPABILITY_UNAVAILABLE',
    'CONTEXT_EXHAUSTED',
    'TOOL_BUDGET_EXHAUSTED',
    'MODEL_REQUEST_BUDGET_EXHAUSTED',
    'MODEL_REQUEST_INTERRUPTED',
    'ITERATION_BUDGET_EXHAUSTED',
    'OUTPUT_TRUNCATED',
    'RESPONSE_TOO_LARGE',
    'SIDE_EFFECT_UNKNOWN',
    'CANCELLED',
    'CONVERSATION_READ_ONLY',
    'CONVERSATION_EXISTS',
    'CONVERSATION_ACTIVE',
    'JOURNAL_CAS_CONFLICT',
    'BRANCH_NOT_FOUND',
    'INVALID_FORK_BOUNDARY',
    'SUBAGENT_DEPTH_EXCEEDED',
    'REPLAY_NOT_AVAILABLE',
  ]);
  var DEFAULT_BUDGETS = Object.freeze({
    maxModelRequests: 100,
    maxIterations: 100,
    maxToolCalls: 200,
    maxWallTimeMs: 900000,
    maxContextTokens: 1000000,
    maxOutputTokens: 4096,
  });
  var BUDGET_LIMITS = Object.freeze({
    maxModelRequests: 1000,
    maxIterations: 1000,
    maxToolCalls: 10000,
    maxWallTimeMs: 86400000,
    maxContextTokens: 4000000,
    maxOutputTokens: 1000000,
  });
  var RECORDING_RANGE_KIND = 'page-action-recording-range';
  var RECORDING_URI_PATTERN = /^\/recordings\/(rec_[A-Za-z0-9][A-Za-z0-9_-]{5,159})$/;
  var RECORDING_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function isRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function cloneJson(value, path) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { throw protocolError('INVALID_COMMAND', (path || 'value') + ' must be JSON serializable'); }
  }

  function strictObject(value, path, allowed, required) {
    if (!isRecord(value)) throw protocolError('INVALID_COMMAND', path + ' must be an object');
    Object.keys(value).forEach(function (key) {
      if (allowed.indexOf(key) === -1) {
        throw protocolError('INVALID_COMMAND', path + ' contains unknown field: ' + key, { field: path + '.' + key });
      }
    });
    (required || []).forEach(function (key) {
      if (!hasOwn(value, key)) throw protocolError('INVALID_COMMAND', path + '.' + key + ' is required', { field: path + '.' + key });
    });
    return value;
  }

  function requiredString(value, path, maxLength) {
    if (typeof value !== 'string' || !value.trim()) {
      throw protocolError('INVALID_COMMAND', path + ' must be a non-empty string', { field: path });
    }
    var output = value.trim();
    if (maxLength && output.length > maxLength) {
      throw protocolError('INVALID_COMMAND', path + ' exceeds its maximum length', { field: path, maxLength: maxLength });
    }
    return output;
  }

  function optionalString(value, path, maxLength) {
    if (value === undefined || value === null || value === '') return '';
    return requiredString(value, path, maxLength);
  }

  function integer(value, path, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw protocolError('INVALID_COMMAND', path + ' must be an integer between ' + minimum + ' and ' + maximum, {
        field: path,
        minimum: minimum,
        maximum: maximum,
      });
    }
    return value;
  }

  function ConversationProtocolError(code, message, options) {
    options = options || {};
    this.name = 'ConversationProtocolError';
    this.code = ERROR_CODES.indexOf(code) === -1 ? 'INVALID_COMMAND' : code;
    this.message = String(message || this.code);
    this.retryable = options.retryable === true;
    this.conversationId = options.conversationId || '';
    this.generationId = options.generationId || '';
    this.details = options.details === undefined ? undefined : cloneJson(options.details, 'error.details');
    if (Error.captureStackTrace) Error.captureStackTrace(this, ConversationProtocolError);
  }
  ConversationProtocolError.prototype = Object.create(Error.prototype);
  ConversationProtocolError.prototype.constructor = ConversationProtocolError;
  ConversationProtocolError.prototype.toJSON = function () {
    var value = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.conversationId) value.conversationId = this.conversationId;
    if (this.generationId) value.generationId = this.generationId;
    if (this.details !== undefined) value.details = cloneJson(this.details, 'error.details');
    return value;
  };

  function protocolError(code, message, details, options) {
    options = options || {};
    options.details = details;
    return new ConversationProtocolError(code, message, options);
  }

  function errorResponse(error) {
    if (!(error instanceof ConversationProtocolError)) {
      error = new ConversationProtocolError('INVALID_COMMAND', error && error.message || String(error || 'Invalid command'));
    }
    return { ok: false, error: error.toJSON() };
  }

  function normalizeBudgets(input) {
    if (input === undefined || input === null) return Object.assign({}, DEFAULT_BUDGETS);
    strictObject(input, 'budgets', Object.keys(DEFAULT_BUDGETS), []);
    var output = {};
    Object.keys(DEFAULT_BUDGETS).forEach(function (key) {
      var minimum = key === 'maxToolCalls' ? 0 : 1;
      output[key] = hasOwn(input, key)
        ? integer(input[key], 'budgets.' + key, minimum, BUDGET_LIMITS[key])
        : DEFAULT_BUDGETS[key];
    });
    if (output.maxOutputTokens >= output.maxContextTokens) {
      throw protocolError('INVALID_COMMAND', 'budgets.maxOutputTokens must be smaller than budgets.maxContextTokens', {
        field: 'budgets.maxOutputTokens',
      });
    }
    return output;
  }

  function normalizePreferences(input) {
    input = input === undefined || input === null ? {} : input;
    strictObject(input, 'preferences', ['streamOutput', 'reasoningVisibility', 'contextCompression'], []);
    var streamOutput = hasOwn(input, 'streamOutput') ? input.streamOutput : true;
    if (typeof streamOutput !== 'boolean') throw protocolError('INVALID_COMMAND', 'preferences.streamOutput must be boolean');
    var reasoningVisibility = input.reasoningVisibility === undefined ? 'expanded' : input.reasoningVisibility;
    if (['expanded', 'collapsed'].indexOf(reasoningVisibility) === -1) {
      throw protocolError('INVALID_COMMAND', 'preferences.reasoningVisibility must be expanded or collapsed');
    }
    var contextCompression = input.contextCompression === undefined ? 'auto' : input.contextCompression;
    if (['auto', 'off'].indexOf(contextCompression) === -1) {
      throw protocolError('INVALID_COMMAND', 'preferences.contextCompression must be auto or off');
    }
    return {
      streamOutput: streamOutput,
      reasoningVisibility: reasoningVisibility,
      contextCompression: contextCompression,
    };
  }

  function normalizeAttachment(value, index) {
    var path = 'message.attachments[' + index + ']';
    strictObject(value, path, [
      'artifactUri', 'kind', 'mimeType', 'name', 'size', 'sha256', 'width', 'height', 'metadata',
    ], ['artifactUri']);
    var artifactUri = requiredString(value.artifactUri, path + '.artifactUri', 2048);
    if (artifactUri.indexOf('/') !== 0 || /^data:/i.test(artifactUri) || /;base64,/i.test(artifactUri)) {
      throw protocolError('INVALID_COMMAND', path + '.artifactUri must be a non-inline artifact URI');
    }
    if (value.kind === RECORDING_RANGE_KIND) {
      strictObject(value, path, ['artifactUri', 'kind', 'name', 'sha256', 'metadata'], [
        'artifactUri', 'kind', 'name', 'sha256', 'metadata',
      ]);
      if (!RECORDING_URI_PATTERN.test(artifactUri)) {
        throw protocolError('INVALID_COMMAND', path + '.artifactUri must be a canonical Recording URI');
      }
      var sourceSha256 = requiredString(value.sha256, path + '.sha256', 71).toLowerCase();
      if (!RECORDING_SHA256_PATTERN.test(sourceSha256)) {
        throw protocolError('INVALID_COMMAND', path + '.sha256 must be a semantic Recording SHA-256');
      }
      var metadataPath = path + '.metadata';
      strictObject(value.metadata, metadataPath, [
        'schemaVersion', 'eventCount', 'durationMs', 'tabCount', 'domainCount',
        'state', 'fromSourceSeq', 'toSourceSeq',
      ], [
        'schemaVersion', 'eventCount', 'durationMs', 'tabCount', 'domainCount',
        'state', 'fromSourceSeq', 'toSourceSeq',
      ]);
      var eventCount = integer(value.metadata.eventCount, metadataPath + '.eventCount', 1, 2000);
      var fromSourceSeq = integer(value.metadata.fromSourceSeq, metadataPath + '.fromSourceSeq', 1, eventCount);
      var toSourceSeq = integer(value.metadata.toSourceSeq, metadataPath + '.toSourceSeq', fromSourceSeq, eventCount);
      var state = requiredString(value.metadata.state, metadataPath + '.state', 16);
      if (['ready', 'interrupted', 'truncated'].indexOf(state) === -1) {
        throw protocolError('INVALID_COMMAND', metadataPath + '.state is invalid');
      }
      return {
        artifactUri: artifactUri,
        kind: RECORDING_RANGE_KIND,
        name: requiredString(value.name, path + '.name', 256),
        sha256: sourceSha256,
        metadata: {
          schemaVersion: integer(value.metadata.schemaVersion, metadataPath + '.schemaVersion', 1, 1),
          eventCount: eventCount,
          durationMs: integer(value.metadata.durationMs, metadataPath + '.durationMs', 0, 3600000),
          tabCount: integer(value.metadata.tabCount, metadataPath + '.tabCount', 0, 2000),
          domainCount: integer(value.metadata.domainCount, metadataPath + '.domainCount', 0, 2000),
          state: state,
          fromSourceSeq: fromSourceSeq,
          toSourceSeq: toSourceSeq,
        },
      };
    }
    var output = { artifactUri: artifactUri };
    ['kind', 'mimeType', 'name', 'sha256'].forEach(function (key) {
      if (hasOwn(value, key)) output[key] = optionalString(value[key], path + '.' + key, 1024);
    });
    ['size', 'width', 'height'].forEach(function (key) {
      if (hasOwn(value, key)) output[key] = integer(value[key], path + '.' + key, 0, Number.MAX_SAFE_INTEGER);
    });
    if (hasOwn(value, 'metadata')) output.metadata = cloneJson(value.metadata, path + '.metadata');
    return output;
  }

  function normalizeMessage(value, path) {
    path = path || 'message';
    strictObject(value, path, ['id', 'content', 'attachments'], ['id', 'content']);
    if (typeof value.content !== 'string') throw protocolError('INVALID_COMMAND', path + '.content must be a string');
    var content = value.content.trim();
    if (!content) throw protocolError('INVALID_COMMAND', path + '.content must not be empty');
    if (content.length > 1000000) throw protocolError('INVALID_COMMAND', path + '.content exceeds its maximum length');
    var attachments = value.attachments === undefined ? [] : value.attachments;
    if (!Array.isArray(attachments) || attachments.length > 32) {
      throw protocolError('INVALID_COMMAND', path + '.attachments must be an array with at most 32 items');
    }
    var normalizedAttachments = attachments.map(normalizeAttachment);
    var recordingRanges = Object.create(null);
    normalizedAttachments.forEach(function (attachment, index) {
      if (attachment.kind !== RECORDING_RANGE_KIND) return;
      var key = [attachment.artifactUri, attachment.sha256, attachment.metadata.fromSourceSeq, attachment.metadata.toSourceSeq].join('\n');
      if (recordingRanges[key]) {
        throw protocolError('INVALID_COMMAND', path + '.attachments contains a duplicate Recording range', { index: index });
      }
      recordingRanges[key] = true;
    });
    return {
      id: requiredString(value.id, path + '.id', 256),
      content: content,
      attachments: normalizedAttachments,
    };
  }

  function normalizeRecordingSelectionClaim(value, path) {
    path = path || 'recordingSelectionClaim';
    strictObject(value, path, [
      'draftCollectionId', 'selectionId', 'expectedRevision', 'orderedRanges',
    ], ['draftCollectionId', 'selectionId', 'expectedRevision', 'orderedRanges']);
    if (!Array.isArray(value.orderedRanges) || !value.orderedRanges.length || value.orderedRanges.length > 32) {
      throw protocolError('INVALID_COMMAND', path + '.orderedRanges must contain 1..32 items');
    }
    var seen = Object.create(null);
    var orderedRanges = value.orderedRanges.map(function (range, index) {
      var rangePath = path + '.orderedRanges[' + index + ']';
      strictObject(range, rangePath, [
        'recordingId', 'recordingUri', 'sourceSha256', 'fromSeq', 'toSeq', 'selectionOrder',
      ], ['recordingId', 'recordingUri', 'sourceSha256', 'fromSeq', 'toSeq', 'selectionOrder']);
      var recordingId = requiredString(range.recordingId, rangePath + '.recordingId', 160);
      var recordingUri = requiredString(range.recordingUri, rangePath + '.recordingUri', 192);
      var uriMatch = RECORDING_URI_PATTERN.exec(recordingUri);
      if (!uriMatch || uriMatch[1] !== recordingId) throw protocolError('INVALID_COMMAND', rangePath + '.recordingUri is not canonical');
      var sourceSha256 = requiredString(range.sourceSha256, rangePath + '.sourceSha256', 71).toLowerCase();
      if (!RECORDING_SHA256_PATTERN.test(sourceSha256)) throw protocolError('INVALID_COMMAND', rangePath + '.sourceSha256 is invalid');
      var fromSeq = integer(range.fromSeq, rangePath + '.fromSeq', 1, 2000);
      var toSeq = integer(range.toSeq, rangePath + '.toSeq', fromSeq, 2000);
      var selectionOrder = integer(range.selectionOrder, rangePath + '.selectionOrder', 0, value.orderedRanges.length - 1);
      if (selectionOrder !== index) throw protocolError('INVALID_COMMAND', rangePath + '.selectionOrder must match array order');
      var key = [recordingUri, sourceSha256, fromSeq, toSeq].join('\n');
      if (seen[key]) throw protocolError('INVALID_COMMAND', path + '.orderedRanges contains a duplicate range');
      seen[key] = true;
      return {
        recordingId: recordingId, recordingUri: recordingUri, sourceSha256: sourceSha256,
        fromSeq: fromSeq, toSeq: toSeq, selectionOrder: selectionOrder,
      };
    });
    return {
      draftCollectionId: requiredString(value.draftCollectionId, path + '.draftCollectionId', 256),
      selectionId: requiredString(value.selectionId, path + '.selectionId', 256),
      expectedRevision: integer(value.expectedRevision, path + '.expectedRevision', 1, Number.MAX_SAFE_INTEGER),
      orderedRanges: orderedRanges,
    };
  }

  function normalizeEntry(value, surfaceType) {
    strictObject(value, 'entry', [
      'type', 'currentResource', 'origin', 'pageId', 'flowId', 'flowGroupId', 'runId', 'tabId',
    ], ['type', 'currentResource']);
    if (ENTRY_TYPES.indexOf(value.type) === -1) throw protocolError('INVALID_COMMAND', 'entry.type is invalid');
    if (surfaceType === 'page' && value.type !== 'page') throw protocolError('INVALID_COMMAND', 'page surface requires entry.type=page');
    if (surfaceType === 'scheduled' && value.type !== 'scheduled') throw protocolError('INVALID_COMMAND', 'scheduled surface requires entry.type=scheduled');
    if (surfaceType === 'mcp' && value.type !== 'conversation') {
      throw protocolError('INVALID_COMMAND', 'mcp surface requires entry.type=conversation');
    }
    if ((surfaceType === 'options' || surfaceType === 'sidepanel') && value.type === 'scheduled') {
      throw protocolError('INVALID_COMMAND', surfaceType + ' surface cannot claim a scheduled entry');
    }
    var currentResource = requiredString(value.currentResource, 'entry.currentResource', 4096);
    if (currentResource.charAt(0) !== '/' || currentResource.indexOf('://') !== -1) {
      throw protocolError('INVALID_COMMAND', 'entry.currentResource must be an absolute resource URI');
    }
    var output = { type: value.type, currentResource: currentResource };
    ['origin', 'pageId', 'flowId', 'flowGroupId', 'runId'].forEach(function (key) {
      output[key] = optionalString(value[key], 'entry.' + key, 4096);
    });
    output.tabId = value.tabId === undefined || value.tabId === null
      ? 0
      : integer(value.tabId, 'entry.tabId', 0, Number.MAX_SAFE_INTEGER);
    return output;
  }

  function normalizeTrustedSurface(value) {
    if (!isRecord(value)) throw protocolError('INVALID_COMMAND', 'A trusted surface descriptor is required');
    strictObject(value, 'trustedSurface', [
      'type', 'instanceId', 'tabId', 'windowId', 'assistantInvocationKind', 'incognito',
    ], ['type', 'instanceId']);
    if (SURFACE_TYPES.indexOf(value.type) === -1) throw protocolError('INVALID_COMMAND', 'trustedSurface.type is invalid');
    var surface = {
      type: value.type,
      instanceId: requiredString(value.instanceId, 'trustedSurface.instanceId', 512),
      tabId: value.tabId === undefined || value.tabId === null ? 0 : integer(value.tabId, 'trustedSurface.tabId', 0, Number.MAX_SAFE_INTEGER),
      windowId: value.windowId === undefined || value.windowId === null ? 0 : integer(value.windowId, 'trustedSurface.windowId', 0, Number.MAX_SAFE_INTEGER),
      incognito: value.incognito === true,
    };
    if (value.incognito !== undefined && typeof value.incognito !== 'boolean') {
      throw protocolError('INVALID_COMMAND', 'trustedSurface.incognito must be boolean');
    }
    if (value.assistantInvocationKind !== undefined) {
      if (value.assistantInvocationKind !== 'runAssistant') {
        throw protocolError('INVALID_COMMAND', 'trustedSurface.assistantInvocationKind is invalid');
      }
      surface.assistantInvocationKind = 'runAssistant';
    }
    if (surface.type === 'page' && surface.tabId <= 0) throw protocolError('INVALID_COMMAND', 'page trustedSurface requires a tabId');
    return surface;
  }

  function assertUntrustedSurfaceDoesNotConflict(value, trusted) {
    if (value === undefined) return;
    strictObject(value, 'surface', ['type', 'instanceId', 'tabId', 'windowId', 'incognito'], []);
    ['type', 'instanceId', 'tabId', 'windowId', 'incognito'].forEach(function (key) {
      if (hasOwn(value, key) && value[key] !== trusted[key]) {
        throw protocolError('INVALID_COMMAND', 'surface is assigned by the trusted sender and cannot be overridden', { field: 'surface.' + key });
      }
    });
  }

  function create(options) {
    options = options || {};
    var resolveService = options.resolveService;
    if (typeof resolveService !== 'function') {
      throw new TypeError('ConversationProtocol.create requires a synchronous resolveService(serviceId) dependency');
    }

    function normalizeStartTurn(input, trustedSurfaceInput) {
      strictObject(input, 'startTurn', [
        'schemaVersion', 'commandId', 'conversationId', 'assistantId', 'serviceId', 'message',
        'surface', 'entry', 'budgets', 'preferences', 'requestedAt', 'recordingSelectionClaim', 'lineage',
      ], ['schemaVersion', 'commandId', 'conversationId', 'assistantId', 'serviceId', 'message', 'entry']);
      if (input.schemaVersion !== SCHEMA_VERSION) throw protocolError('INVALID_COMMAND', 'Unsupported StartTurnInput schemaVersion');
      if (hasOwn(input, 'service')) {
        throw protocolError('INVALID_COMMAND', 'startTurn.service is not supported; UI must send serviceId only');
      }
      var surface = normalizeTrustedSurface(trustedSurfaceInput);
      assertUntrustedSurfaceDoesNotConflict(input.surface, surface);
      var serviceId = requiredString(input.serviceId, 'startTurn.serviceId', 256);
      var service = resolveService(serviceId);
      if (service && typeof service.then === 'function') {
        throw new TypeError('ConversationProtocol resolveService must be synchronous');
      }
      if (!service) {
        throw new ConversationProtocolError('SERVICE_NOT_FOUND', 'Unknown model service: ' + serviceId, {
          details: { serviceId: serviceId },
        });
      }
      var requestedAt = input.requestedAt === undefined
        ? 0
        : integer(input.requestedAt, 'startTurn.requestedAt', 0, Number.MAX_SAFE_INTEGER);
      var preferences = normalizePreferences(input.preferences);
      if (surface.type === 'sidepanel' || surface.type === 'scheduled' || surface.type === 'mcp') {
        preferences.streamOutput = false;
      }
      var output = {
        schemaVersion: SCHEMA_VERSION,
        commandId: requiredString(input.commandId, 'startTurn.commandId', 256),
        conversationId: requiredString(input.conversationId, 'startTurn.conversationId', 256),
        assistantId: requiredString(input.assistantId, 'startTurn.assistantId', 256),
        serviceId: serviceId,
        message: normalizeMessage(input.message),
        surface: surface,
        entry: normalizeEntry(input.entry, surface.type),
        budgets: normalizeBudgets(input.budgets),
        preferences: preferences,
        requestedAt: requestedAt,
      };
      if (input.recordingSelectionClaim !== undefined) {
        output.recordingSelectionClaim = normalizeRecordingSelectionClaim(input.recordingSelectionClaim, 'startTurn.recordingSelectionClaim');
      }
      if (input.lineage !== undefined) output.lineage = normalizeLineage(input.lineage, 'startTurn.lineage');
      return output;
    }

    function normalizeCancel(input) {
      strictObject(input, 'cancelGeneration', ['conversationId', 'generationId', 'reason'], ['conversationId', 'generationId']);
      return {
        conversationId: requiredString(input.conversationId, 'cancelGeneration.conversationId', 256),
        generationId: requiredString(input.generationId, 'cancelGeneration.generationId', 256),
        reason: optionalString(input.reason, 'cancelGeneration.reason', 2000),
      };
    }

    function normalizeSteer(input) {
      strictObject(input, 'steerGeneration', ['conversationId', 'generationId', 'commandId', 'message', 'recordingSelectionClaim'], [
        'conversationId', 'generationId', 'commandId', 'message',
      ]);
      var output = {
        conversationId: requiredString(input.conversationId, 'steerGeneration.conversationId', 256),
        generationId: requiredString(input.generationId, 'steerGeneration.generationId', 256),
        commandId: requiredString(input.commandId, 'steerGeneration.commandId', 256),
        message: normalizeMessage(input.message, 'steerGeneration.message'),
      };
      if (input.recordingSelectionClaim !== undefined) {
        output.recordingSelectionClaim = normalizeRecordingSelectionClaim(input.recordingSelectionClaim, 'steerGeneration.recordingSelectionClaim');
      }
      return output;
    }

    function normalizeModelInterrupt(input) {
      strictObject(input, 'interruptModelRequest', ['conversationId', 'generationId', 'commandId'], [
        'conversationId', 'generationId', 'commandId',
      ]);
      return {
        conversationId: requiredString(input.conversationId, 'interruptModelRequest.conversationId', 256),
        generationId: requiredString(input.generationId, 'interruptModelRequest.generationId', 256),
        commandId: requiredString(input.commandId, 'interruptModelRequest.commandId', 256),
      };
    }

    function normalizeInteraction(input) {
      strictObject(input, 'resolveInteraction', [
        'conversationId', 'generationId', 'interactionId', 'answer',
      ], ['conversationId', 'generationId', 'interactionId', 'answer']);
      return {
        conversationId: requiredString(input.conversationId, 'resolveInteraction.conversationId', 256),
        generationId: requiredString(input.generationId, 'resolveInteraction.generationId', 256),
        interactionId: requiredString(input.interactionId, 'resolveInteraction.interactionId', 256),
        answer: cloneJson(input.answer, 'resolveInteraction.answer'),
      };
    }

    function normalizeLineage(value, path) {
      path = path || 'lineage';
      if (value === undefined || value === null) return null;
      strictObject(value, path, [
        'branchId', 'parentConversationId', 'parentGenerationId', 'parentTurnId', 'parentSequence',
        'origin', 'delegationDepth', 'subagentId',
      ], []);
      var output = {};
      ['branchId', 'parentConversationId', 'parentGenerationId', 'parentTurnId', 'subagentId'].forEach(function (key) {
        if (hasOwn(value, key)) output[key] = optionalString(value[key], path + '.' + key, 256);
      });
      if (hasOwn(value, 'parentSequence')) output.parentSequence = integer(value.parentSequence, path + '.parentSequence', 0, Number.MAX_SAFE_INTEGER);
      if (hasOwn(value, 'delegationDepth')) output.delegationDepth = integer(value.delegationDepth, path + '.delegationDepth', 0, 64);
      if (hasOwn(value, 'origin')) {
        output.origin = requiredString(value.origin, path + '.origin', 64);
        if (['user', 'subagent', 'fork', 'replay', 'recovery'].indexOf(output.origin) === -1) {
          throw protocolError('INVALID_COMMAND', path + '.origin is invalid');
        }
      }
      return output;
    }

    function normalizeConversationLookup(input, path) {
      strictObject(input, path, ['conversationId'], ['conversationId']);
      return { conversationId: requiredString(input.conversationId, path + '.conversationId', 256) };
    }

    function normalizeEvents(input) {
      strictObject(input, 'getEvents', ['conversationId', 'cursor', 'limit', 'includePayloads', 'branchId', 'generationId', 'types', 'q', 'actorId'], ['conversationId']);
      var cursor = input.cursor === undefined || input.cursor === null ? {} : input.cursor;
      strictObject(cursor, 'getEvents.cursor', ['beforeSequence', 'afterSequence'], []);
      if (hasOwn(cursor, 'beforeSequence') && hasOwn(cursor, 'afterSequence')) {
        throw protocolError('INVALID_COMMAND', 'getEvents.cursor cannot use beforeSequence and afterSequence together');
      }
      var normalizedCursor = {};
      if (hasOwn(cursor, 'beforeSequence')) normalizedCursor.beforeSequence = integer(cursor.beforeSequence, 'getEvents.cursor.beforeSequence', 1, Number.MAX_SAFE_INTEGER);
      if (hasOwn(cursor, 'afterSequence')) normalizedCursor.afterSequence = integer(cursor.afterSequence, 'getEvents.cursor.afterSequence', 0, Number.MAX_SAFE_INTEGER);
      var includePayloads = input.includePayloads === true;
      if (hasOwn(input, 'includePayloads') && typeof input.includePayloads !== 'boolean') {
        throw protocolError('INVALID_COMMAND', 'getEvents.includePayloads must be boolean');
      }
      return {
        conversationId: requiredString(input.conversationId, 'getEvents.conversationId', 256),
        cursor: normalizedCursor,
        limit: input.limit === undefined ? 100 : integer(input.limit, 'getEvents.limit', 1, 500),
        includePayloads: includePayloads,
        branchId: optionalString(input.branchId, 'getEvents.branchId', 256),
        generationId: optionalString(input.generationId, 'getEvents.generationId', 256),
        types: input.types === undefined ? [] : (Array.isArray(input.types) ? input.types.map(function (value) { return requiredString(value, 'getEvents.types[]', 128); }) : (function () { throw protocolError('INVALID_COMMAND', 'getEvents.types must be an array'); })()),
        q: optionalString(input.q, 'getEvents.q', 4000),
        actorId: optionalString(input.actorId, 'getEvents.actorId', 256),
      };
    }

    function normalizeCommand(message, trustedSender) {
      strictObject(message, 'command', ['command', 'input'], ['command', 'input']);
      var command = requiredString(message.command, 'command.command', 64);
      if (COMMAND_NAMES.indexOf(command) === -1) throw protocolError('INVALID_COMMAND', 'Unknown conversation command: ' + command);
      var input;
      if (command === COMMANDS.START_TURN) input = normalizeStartTurn(message.input, trustedSender);
      else if (command === COMMANDS.CANCEL_GENERATION) input = normalizeCancel(message.input);
      else if (command === COMMANDS.STEER_GENERATION) input = normalizeSteer(message.input);
      else if (command === COMMANDS.INTERRUPT_MODEL_REQUEST) input = normalizeModelInterrupt(message.input);
      else if (command === COMMANDS.RESOLVE_INTERACTION) input = normalizeInteraction(message.input);
      else if (command === COMMANDS.GET_EVENTS) input = normalizeEvents(message.input);
      else if (command === COMMANDS.GET_CONVERSATION) input = normalizeConversationLookup(message.input, 'getConversation');
      else input = normalizeConversationLookup(message.input, 'getSummary');
      return Object.freeze({ command: command, input: input });
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      normalizeCommand: normalizeCommand,
      normalizeStartTurn: normalizeStartTurn,
      normalizeBudgets: normalizeBudgets,
      error: protocolError,
      errorResponse: errorResponse,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    COMMANDS: COMMANDS,
    COMMAND_NAMES: COMMAND_NAMES,
    SURFACE_TYPES: SURFACE_TYPES,
    ENTRY_TYPES: ENTRY_TYPES,
    TERMINAL_STATES: TERMINAL_STATES,
    ERROR_CODES: ERROR_CODES,
    DEFAULT_BUDGETS: DEFAULT_BUDGETS,
    BUDGET_LIMITS: BUDGET_LIMITS,
    ConversationProtocolError: ConversationProtocolError,
    normalizeBudgets: normalizeBudgets,
    error: protocolError,
    errorResponse: errorResponse,
    create: create,
  });
});
