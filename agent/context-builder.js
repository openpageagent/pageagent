// Per-provider-request context governance over the canonical conversation Journal.
(function attachContextBuilder(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var nodeCrypto = null;
  var deps = commonJs ? {
    prompt: require('./agent-prompt'),
    capability: require('./capability-policy'),
    arp: require('../resources/protocol'),
    summary: require('./conversation-summary'),
    projection: require('./tool-result-projection'),
    materializer: require('../background/conversation-journal-materializer'),
  } : {
    prompt: root.AgentPrompt,
    capability: root.CapabilityPolicy,
    arp: root.AgentResourceProtocol,
    summary: root.ConversationSummary,
    projection: root.AgentToolResultProjection,
    materializer: root.ConversationJournalMaterializer,
  };
  if (commonJs) {
    try { nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  }
  var api = factory(root, deps, nodeCrypto);
  if (commonJs) module.exports = api;
  else root.ContextBuilder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, deps, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;
  var HIGH_WATER_RATIO = 0.85;
  var LOW_WATER_RATIO = 0.65;
  var OVERFLOW_LOW_WATER_RATIO = 0.60;
  var SAFETY_RATIO = 0.02;
  var MIN_SAFETY_TOKENS = 512;
  var OUTPUT_RATIO = 0.20;
  var DEFAULT_CONTEXT_WINDOW = 1000000;
  var DEFAULT_OUTPUT_TOKENS = 4096;
  var PROVIDER_ENVELOPE_TOKENS = 128;
  var IMAGE_TOKENS = 1024;

  if (!deps.projection || typeof deps.projection.projectEventContent !== 'function') {
    throw new Error('AgentToolResultProjection must load before ContextBuilder');
  }

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function stable(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('Context values cannot contain cycles');
    seen.push(value);
    var output;
    if (Array.isArray(value)) output = value.map(function (item) { return stable(item, seen); });
    else {
      output = {};
      Object.keys(value).sort().forEach(function (key) { output[key] = stable(value[key], seen); });
    }
    seen.pop();
    return output;
  }
  function stableStringify(value) { return JSON.stringify(stable(value)); }
  function imageCount(value, seen) {
    if (!value || typeof value !== 'object') return 0;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return 0;
    seen.push(value);
    var count = value.type === 'image' || value.type === 'input_image' || value.type === 'image_url'
      || typeof value.artifactUri === 'string' && value.artifactUri.indexOf('/image-artifacts/') === 0 ? 1 : 0;
    if (Array.isArray(value)) value.forEach(function (item) { count += imageCount(item, seen); });
    else Object.keys(value).forEach(function (key) { count += imageCount(value[key], seen); });
    seen.pop();
    return count;
  }
  function defaultEstimate(value) {
    return Math.max(1, Math.ceil(stableStringify(value).length / 4) + imageCount(value) * IMAGE_TOKENS);
  }
  function hex(bytes) { return Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join(''); }
  async function sha256(value, cryptoApi) {
    var serialized = typeof value === 'string' ? value : stableStringify(value);
    if (nodeCrypto && nodeCrypto.createHash) return 'sha256:' + nodeCrypto.createHash('sha256').update(serialized).digest('hex');
    cryptoApi = cryptoApi || root && root.crypto;
    if (!cryptoApi || !cryptoApi.subtle || typeof TextEncoder !== 'function') throw new Error('SHA-256 is required by ContextBuilder');
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function contextError(code, message, details) {
    var error = new Error(message || code);
    error.name = 'ContextBuilderError';
    error.code = code;
    error.details = details || {};
    return error;
  }
  function buildSummaryProviderRequest(input) {
    input = input || {};
    var model = input.model || {};
    var request = Object.assign({}, clone(input.baseRequest || {}), {
      purpose: 'context_summary',
      logicalRequestId: text(input.logicalRequestId),
      modelRequestId: text(input.modelRequestId),
      serviceId: text(model.serviceId),
      model: text(model.resolvedSummaryModel),
      modelOverride: text(model.resolvedSummaryModel),
      system: deps.summary.SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(clone(input.source || {})) }],
      tools: [],
      responseFormat: {
        type: 'json_schema', name: 'conversation_summary',
        schema: clone(deps.summary.SUMMARY_JSON_SCHEMA), strict: true,
      },
      signal: input.signal,
      contextTrace: clone(input.contextTrace || input.baseRequest && input.baseRequest.contextTrace || {}),
    });
    if (!request.logicalRequestId || !request.modelRequestId || !request.serviceId || !request.model) {
      throw contextError('INVALID_SUMMARY_REQUEST', 'Summary Provider request identity and model are required');
    }
    return request;
  }
  function terminalToolEvent(type) {
    return /^(?:tool_execution_completed|tool_execution_failed|tool_execution_unknown|tool_call_deferred)$/.test(type);
  }
  function normalizedCall(call, planned, index) {
    call = call || {};
    planned = planned || {};
    var payload = planned.payload || {};
    var id = text(call.id || call.toolCallId || planned.toolCallId) || 'tool_call_' + index;
    return {
      id: id,
      name: text(call.name || payload.name),
      arguments: clone(call.arguments || call.input || payload.arguments || {}),
    };
  }

  function buildAtomicUnits(events, input) {
    input = input || {};
    events = (Array.isArray(events) ? events : []).slice().sort(function (a, b) { return a.sequence - b.sequence; });
    var plannedByRequest = Object.create(null);
    var plannedByCall = Object.create(null);
    var terminalByCall = Object.create(null);
    var interactionResolution = Object.create(null);
    events.forEach(function (event) {
      if (event.type === 'tool_call_planned') {
        var requestKey = text(event.modelRequestId);
        if (!plannedByRequest[requestKey]) plannedByRequest[requestKey] = [];
        plannedByRequest[requestKey].push(event);
        plannedByCall[event.toolCallId] = event;
      }
      if (terminalToolEvent(event.type)) terminalByCall[event.toolCallId] = event;
      if (event.type === 'interaction_resolved') interactionResolution[event.interactionId] = event;
    });
    Object.keys(plannedByRequest).forEach(function (key) {
      plannedByRequest[key].sort(function (a, b) { return a.sequence - b.sequence; });
    });
    var consumed = Object.create(null);
    var units = [];
    events.forEach(function (event) {
      if (consumed[event.sequence]) return;
      if (event.type === 'user_message_appended' || event.type === 'steering_message_appended') {
        var message = event.payload && (event.payload.message || event.payload) || {};
        units.push({
          kind: event.type === 'steering_message_appended' ? 'steering' : 'user',
          startSequence: event.sequence,
          endSequence: event.sequence,
          turnId: event.turnId,
          generationId: event.generationId,
          atomicComplete: true,
          messages: [{ role: 'user', content: clone(message.content === undefined ? message : message.content) }],
          sourceEvents: [event],
        });
        consumed[event.sequence] = true;
        return;
      }
      if (event.type === 'model_request_started') {
        var promptMessages = event.payload && event.payload.promptMessages;
        if (Array.isArray(promptMessages) && promptMessages.length) {
          units.push({
            kind: 'model_context',
            startSequence: event.sequence,
            endSequence: event.sequence,
            turnId: event.turnId,
            generationId: event.generationId,
            modelRequestId: event.modelRequestId,
            atomicComplete: true,
            messages: clone(promptMessages),
            sourceEvents: [event],
          });
          consumed[event.sequence] = true;
        }
        return;
      }
      if (event.type === 'model_response_completed') {
        var payload = event.payload || {};
        var planned = plannedByRequest[text(event.modelRequestId)] || [];
        var rawCalls = Array.isArray(payload.calls) ? payload.calls : [];
        var count = Math.max(rawCalls.length, planned.length);
        var calls = [];
        var sourceEvents = [event];
        var messages = [];
        var endSequence = event.sequence;
        var atomicComplete = true;
        var inFlight = false;
        for (var index = 0; index < count; index += 1) {
          var plannedEvent = planned[index];
          var call = normalizedCall(rawCalls[index], plannedEvent, index);
          if (!call.id && plannedEvent) call.id = plannedEvent.toolCallId;
          calls.push(call);
          if (plannedEvent) {
            consumed[plannedEvent.sequence] = true;
            sourceEvents.push(plannedEvent);
            endSequence = Math.max(endSequence, plannedEvent.sequence);
          }
        }
        messages.push({
          role: 'assistant',
          content: clone(payload.content === undefined ? '' : payload.content),
          calls: calls,
          providerReplay: clone(payload.providerReplay || { version: 1, apiStyle: 'journal', serviceId: '', model: '', blocks: [] }),
        });
        calls.forEach(function (call, index) {
          var plannedEvent = planned[index] || plannedByCall[call.id];
          var canonicalId = plannedEvent && plannedEvent.toolCallId || call.id;
          call.id = canonicalId;
          var result = terminalByCall[canonicalId];
          if (!result) {
            atomicComplete = false;
            inFlight = events.some(function (candidate) {
              return candidate.toolCallId === canonicalId && candidate.type === 'tool_execution_started';
            });
            return;
          }
          consumed[result.sequence] = true;
          sourceEvents.push(result);
          endSequence = Math.max(endSequence, result.sequence);
          messages.push({
            role: 'tool',
            toolCallId: canonicalId,
            resourceCall: { name: call.name, arguments: clone(call.arguments || {}) },
            content: deps.projection.projectEventContent(result, {
              name: call.name, arguments: clone(call.arguments || {}),
            }),
          });
        });
        units.push({
          kind: 'assistant_tool_group',
          startSequence: event.sequence,
          endSequence: endSequence,
          turnId: event.turnId,
          generationId: event.generationId,
          modelRequestId: event.modelRequestId,
          atomicComplete: atomicComplete,
          inFlight: inFlight,
          messages: messages,
          sourceEvents: sourceEvents,
        });
        consumed[event.sequence] = true;
        return;
      }
      if (event.type === 'interaction_requested') {
        var resolved = interactionResolution[event.interactionId];
        if (resolved) consumed[resolved.sequence] = true;
        units.push({
          kind: 'interaction',
          startSequence: event.sequence,
          endSequence: resolved ? resolved.sequence : event.sequence,
          turnId: event.turnId,
          generationId: event.generationId,
          atomicComplete: !!resolved,
          unresolvedInteraction: !resolved,
          messages: resolved ? [{
            role: 'user',
            content: JSON.stringify({
              interaction: event.payload && event.payload.prompt,
              answer: resolved.payload && resolved.payload.answer,
            }),
          }] : [],
          sourceEvents: resolved ? [event, resolved] : [event],
        });
        consumed[event.sequence] = true;
      }
    });
    units.sort(function (a, b) { return a.startSequence - b.startSequence; });
    return units;
  }

  function compactToolProjection(messages) {
    return messages.map(function (message) {
      if (message.role !== 'tool') return clone(message);
      return {
        role: 'tool',
        toolCallId: message.toolCallId,
        content: clone(message.content),
      };
    });
  }

  function create(options) {
    options = options || {};
    var journal = options.journal;
    if (!journal || typeof journal.getMetadata !== 'function' || typeof journal.getAllEvents !== 'function') throw new TypeError('ContextBuilder requires a Journal');
    var prompt = options.prompt || deps.prompt;
    if (!prompt || typeof prompt.buildPrompt !== 'function') throw new TypeError('ContextBuilder requires AgentPrompt.buildPrompt');
    var capabilityPolicy = options.capabilityPolicy || deps.capability && deps.capability.create();
    if (!capabilityPolicy || typeof capabilityPolicy.evaluate !== 'function') throw new TypeError('ContextBuilder requires CapabilityPolicy');
    var resourceRegistry = options.resourceRegistry || null;
    var resourceContext = clone(options.resourceContext || {});
    if (resourceRegistry && (!deps.arp || typeof deps.arp.createActiveCapabilityGuidance !== 'function')) {
      throw new TypeError('ContextBuilder requires active capability guidance support');
    }
    var summaryPipeline = options.summaryPipeline || null;
    var tokenizer = options.tokenizer || {};
    var resolveRuntimeContext = typeof options.resolveRuntimeContext === 'function'
      ? options.resolveRuntimeContext
      : async function () { return {}; };
    var journalMaterializer = options.journalMaterializer
      || deps.materializer && deps.materializer.create({ journal: journal });
    if (!journalMaterializer || typeof journalMaterializer.materializeEvents !== 'function') {
      throw new TypeError('ContextBuilder requires ConversationJournalMaterializer');
    }
    var resolveRecordingContext = typeof options.resolveRecordingContext === 'function'
      ? options.resolveRecordingContext : async function () { return { recordings: [] }; };
    var materializeResourceResults = typeof options.materializeResourceResults === 'function'
      ? options.materializeResourceResults : async function (events) { return events; };
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : function (prefix) { nextId += 1; return prefix + '_' + Number(clock()).toString(36) + '_' + nextId.toString(36); };
    var cryptoApi = options.crypto || root && root.crypto;
    var calibrations = Object.create(null);
    var latchedPolicy = null;
    var latchedTools = null;

    function estimate(value, bucket, service) {
      var estimate = typeof tokenizer.estimate === 'function' ? Number(tokenizer.estimate(value, { bucket: bucket, service: service })) : defaultEstimate(value);
      if (!Number.isFinite(estimate) || estimate < 0) estimate = defaultEstimate(value);
      var key = text(service && (service.id || service.serviceId)) + ':' + text(service && service.model);
      var factor = calibrations[key] || 1;
      return Math.max(0, Math.ceil(estimate * factor));
    }
    function recordUsageCalibration(input) {
      input = input || {};
      var estimated = Number(input.estimatedInputTokens);
      var actual = Number(input.actualInputTokens);
      if (!(estimated > 0) || !(actual > 0)) return null;
      var key = text(input.serviceId) + ':' + text(input.model);
      var ratio = Math.max(0.75, Math.min(2.5, actual / estimated));
      calibrations[key] = calibrations[key] ? calibrations[key] * 0.7 + ratio * 0.3 : ratio;
      return calibrations[key];
    }
    async function validateGeneration(input) {
      var metadata = await journal.getMetadata(input.conversationId);
      var active = metadata && metadata.activeGeneration;
      if (!active || active.generationId !== input.generationId) {
        throw contextError('GENERATION_STALE', 'ContextBuilder generation is no longer active', {
          conversationId: input.conversationId, generationId: input.generationId,
        });
      }
      if (active.state === 'waiting_user') {
        throw contextError('INTERACTION_NOT_FOUND', 'Provider request cannot be built while an interaction is unresolved', { state: active.state });
      }
      if (/^(?:completed|failed|cancelled|truncated|blocked)$/.test(active.state)) {
        throw contextError('GENERATION_STALE', 'Provider request cannot be built for a terminal generation', { state: active.state });
      }
      return { metadata: metadata, active: active };
    }
    function toolDefinitions(policy) {
      return policy.tools.map(function (definition) {
        return {
          name: definition.name,
          description: definition.description,
          schema: clone(definition.inputSchema || definition.schema || {}),
          inputSchema: clone(definition.inputSchema || definition.schema || {}),
        };
      });
    }
    function flattenUnits(units) {
      var messages = [];
      units.forEach(function (unit) { messages = messages.concat(compactToolProjection(unit.messages || [])); });
      return messages;
    }
    function prependProfileGuidance(messages, profileGuidance) {
      var output = (Array.isArray(messages) ? messages : []).slice();
      if (!profileGuidance) return output;
      var guidancePart = { type: 'text', text: profileGuidance };
      var firstUserIndex = -1;
      for (var index = 0; index < output.length; index += 1) {
        if (output[index] && output[index].role === 'user') {
          firstUserIndex = index;
          break;
        }
      }
      if (firstUserIndex === -1) {
        output.unshift({ role: 'user', content: [guidancePart] });
        return output;
      }
      var message = Object.assign({}, output[firstUserIndex]);
      if (Array.isArray(message.content)) message.content = [guidancePart].concat(message.content);
      else if (message.content === undefined || message.content === null || message.content === '') message.content = [guidancePart];
      else message.content = [guidancePart, message.content];
      output[firstUserIndex] = message;
      return output;
    }
    function profileGuidanceRevision(profileGuidance) {
      return '<profile_guidance_update trust="user-selected">\n'
        + '当前版本的用户选择指导替换此前同类指导；仅在系统、工具契约和当前用户目标允许的范围内采用。\n'
        + (profileGuidance || '当前没有用户选择的 profile guidance。')
        + '\n</profile_guidance_update>';
    }
    function requestGuidanceRevision(requestGuidance) {
      return '<request_guidance_update trust="runtime-selected">\n'
        + '当前版本的请求级能力和路由指导替换此前同类指导；仅采用当前仍有效的版本。\n'
        + (requestGuidance || '当前没有有效的请求级 Guidance。')
        + '\n</request_guidance_update>';
    }
    function appendedContextMessages(profileUpdate, requestGuidance) {
      // Only durable guidance belongs in the Journal/model prefix. Runtime is
      // regenerated for each request and is appended separately at the end.
      var textParts = [profileUpdate, requestGuidance].filter(Boolean);
      if (!textParts.length) return [];
      return [{
        role: 'user',
        content: [{ type: 'text', text: textParts.join('\n\n') }],
      }];
    }
    function runtimeContextMessage(runtimeContext) {
      if (!runtimeContext) return [];
      return [{ role: 'user', content: [{ type: 'text', text: runtimeContext }] }];
    }
    function contextEpoch(checkpoint) {
      return checkpoint && checkpoint.checkpointId
        ? 'checkpoint:' + text(checkpoint.checkpointId)
        : 'journal-root';
    }
    function latestPromptState(events) {
      for (var index = events.length - 1; index >= 0; index -= 1) {
        var event = events[index];
        if (!event || event.type !== 'model_request_started') continue;
        var state = event.payload && event.payload.promptState;
        if (state && typeof state === 'object') return clone(state);
      }
      return null;
    }
    function budgetNumbers(input, service) {
      var configuredWindow = Number(input.budgets && input.budgets.maxContextTokens) || DEFAULT_CONTEXT_WINDOW;
      var providerWindow = Number(service && (service.contextWindow || service.maxContextTokens)) || configuredWindow;
      var contextWindow = Math.max(1024, Math.min(configuredWindow, providerWindow));
      var configuredOutput = Number(input.budgets && input.budgets.maxOutputTokens) || DEFAULT_OUTPUT_TOKENS;
      var providerOutput = Number(service && service.maxOutputTokens) || configuredOutput;
      var effectiveOutput = Math.max(1, Math.min(configuredOutput, providerOutput, Math.floor(contextWindow * OUTPUT_RATIO)));
      var providerVariant = input.providerCacheVariant || {};
      if (text(providerVariant.protocol || service && service.protocol).toLowerCase() === 'anthropic') {
        effectiveOutput = Math.max(effectiveOutput, Math.floor(Number(providerVariant.anthropicMaxTokensFloor) || 0));
      }
      var safety = Math.max(MIN_SAFETY_TOKENS, Math.floor(contextWindow * SAFETY_RATIO));
      return {
        contextWindow: contextWindow,
        effectiveMaxOutputTokens: effectiveOutput,
        outputReserve: effectiveOutput,
        providerSafetyReserve: safety,
        inputLimit: contextWindow - effectiveOutput - safety,
      };
    }
    function remainingBudgets(input, active) {
      var budgets = input.budgets || {};
      var counters = active.counters || {};
      return {
        modelRequests: Math.max(0, Number(budgets.maxModelRequests) - Number(counters.modelRequestCount || 0)),
        iterations: Math.max(0, Number(budgets.maxIterations) - Number(counters.loopIterationCount || 0)),
        toolCalls: Math.max(0, Number(budgets.maxToolCalls) - Number(counters.toolCallCount || 0)),
        wallTimeMs: Math.max(0, Number(budgets.maxWallTimeMs) - (Number(clock()) - Number(active.startedAt || clock()))),
      };
    }
    function incompleteUnits(units, throughSequence) {
      return units.filter(function (unit) { return unit.endSequence > throughSequence && unit.atomicComplete === false; });
    }
    function toolContract(input) {
      if (!latchedPolicy) {
        // ContextBuilder is generation-scoped. Latch the Provider-visible tool
        // contract once; execution budgets remain authoritative at dispatch.
        latchedPolicy = capabilityPolicy.evaluate({
          surface: input.surface,
          generationState: 'running',
          remainingToolCalls: Number(input.budgets && input.budgets.maxToolCalls) > 0
            ? Number.MAX_SAFE_INTEGER : 0,
          allowedToolNames: input.allowedToolNames,
          scheduleGrant: input.scheduleGrant,
        });
        latchedTools = toolDefinitions(latchedPolicy);
      }
      return { policy: latchedPolicy, tools: clone(latchedTools) };
    }
    async function verifyAppendOnlyPrefix(messages, previous, epoch, cacheEpochHash) {
      if (!previous || text(previous.contextEpoch) !== epoch
          || previous.cacheEpochHash && text(previous.cacheEpochHash) !== text(cacheEpochHash)) return false;
      var count = Math.max(0, Math.floor(Number(previous.messageCount) || 0));
      var expectedHash = text(previous.messagesHash);
      if (!count || !expectedHash || count > messages.length) {
        throw contextError('PROMPT_PREFIX_CHANGED', 'The previous Provider prompt is not a prefix of the next request', {
          contextEpoch: epoch,
          previousMessageCount: count,
          currentMessageCount: messages.length,
        });
      }
      var actualHash = await sha256(messages.slice(0, count), cryptoApi);
      if (actualHash !== expectedHash) {
        throw contextError('PROMPT_PREFIX_CHANGED', 'The previous Provider prompt changed before the next request', {
          contextEpoch: epoch,
          previousMessageCount: count,
          expectedHash: expectedHash,
          actualHash: actualHash,
        });
      }
      return true;
    }
    async function assemble(input, flags) {
      flags = flags || {};
      if (input.lease && typeof input.lease.assertActive === 'function') {
        if (input.lease.conversationId !== input.conversationId || input.lease.generationId !== input.generationId) {
          throw contextError('GENERATION_STALE', 'ContextBuilder input does not match its generation lease');
        }
        await input.lease.assertActive();
      }
      var generation = await validateGeneration(input);
      if (!input.service || !text(input.service.model)) throw contextError('SERVICE_NOT_FOUND', 'Resolved Model Service is required by ContextBuilder');
      var journalEvents = await journal.getAllEvents(input.conversationId);
      var events = await journalMaterializer.materializeEvents(journalEvents);
      events = await materializeResourceResults(events);
      var checkpoint = await journal.getActiveCheckpoint(input.conversationId);
      if (checkpoint && checkpoint.throughSequence > generation.metadata.lastSequence) {
        throw contextError('CHECKPOINT_INVALID', 'SummaryCheckpoint points beyond the Journal');
      }
      var units = buildAtomicUnits(events, input);
      var generationSteeringEvents = events.filter(function (event) {
        return event && event.type === 'steering_message_appended'
          && event.generationId === input.generationId;
      }).sort(function (left, right) {
        return Number(left.sequence || 0) - Number(right.sequence || 0);
      });
      var throughSequence = checkpoint && checkpoint.throughSequence || 0;
      var incomplete = incompleteUnits(units, throughSequence);
      if (incomplete.length) {
        throw contextError('INCOMPLETE_TOOL_CAUSAL_CHAIN', 'Journal contains an incomplete tool or interaction atomic unit', {
          units: incomplete.map(function (unit) { return { kind: unit.kind, startSequence: unit.startSequence, endSequence: unit.endSequence, inFlight: unit.inFlight }; }),
        });
      }
      var tailUnits = units.filter(function (unit) { return unit.endSequence > throughSequence; });
      // The Provider sees one Journal-ordered stream. Re-bucketing by turn and
      // concatenating later can reorder a prefix during recovery or steering.
      var tailMessages = flattenUnits(tailUnits);
      var currentUnits = tailUnits.filter(function (unit) { return unit.turnId === input.turnId; });
      var historyUnits = tailUnits.filter(function (unit) { return unit.turnId !== input.turnId; });
      var historyMessages = flattenUnits(historyUnits);
      var currentMessages = flattenUnits(currentUnits);
      var remaining = remainingBudgets(input, generation.active);
      var dynamic = await resolveRuntimeContext({
        conversationId: input.conversationId,
        generationId: input.generationId,
        turnId: input.turnId,
        surface: clone(input.surface),
        entry: clone(input.entry),
        currentResource: input.entry && input.entry.currentResource || '/',
        events: events,
        checkpoint: checkpoint,
      });
      dynamic = dynamic || {};
      var recordingContext = await resolveRecordingContext({
        conversationId: input.conversationId,
        generationId: input.generationId,
        turnId: input.turnId,
        events: events,
        checkpoint: checkpoint,
      });
      recordingContext = recordingContext && Array.isArray(recordingContext.recordings)
        ? recordingContext : { recordings: [] };
      var contract = toolContract(input);
      var policy = contract.policy;
      var tools = contract.tools;
      var promptInput = {
        surface: input.surface,
        entry: Object.assign({}, input.entry || {}, { currentResource: dynamic.currentResource || input.entry && input.entry.currentResource || '/' }),
        currentResource: dynamic.currentResource || input.entry && input.entry.currentResource || '/',
        conversationSummary: checkpoint ? clone(checkpoint.summary) : null,
        representation: dynamic.representation === undefined ? input.representation : dynamic.representation,
        assistantPrompt: dynamic.assistantPrompt,
        selectedSkills: dynamic.selectedSkills || input.selectedSkills,
        selectedMcpContext: dynamic.selectedMcpContext || input.selectedMcpContext,
        selectedResourceWarnings: dynamic.selectedResourceWarnings || input.selectedResourceWarnings,
        currentTime: Number(clock()),
        recovery: dynamic.recovery || input.recovery,
        remainingBudgets: remaining,
        recordingContext: recordingContext.recordings.length ? recordingContext : null,
      };
      var capabilityGuidance = resourceRegistry
        ? deps.arp.createActiveCapabilityGuidance(resourceRegistry, {
          exposedToolNames: policy.exposedToolNames,
          permissionScope: resourceContext.permissionScope,
          allowedRouteMethods: resourceContext.allowedRouteMethods,
          context: resourceContext,
          currentResource: promptInput.currentResource,
          representation: promptInput.representation,
          additionalResourceUris: (Array.isArray(dynamic.additionalResourceUris)
            ? dynamic.additionalResourceUris : []).concat(recordingContext.recordings.map(function (recording) {
            return recording && recording.recordingUri;
          }).filter(Boolean)),
        })
        : { schemaVersion: 1, contracts: [], text: '' };
      var composedPrompt = prompt.buildPrompt(Object.assign({}, promptInput, {
        capabilityGuidance: capabilityGuidance.text,
      }));
      var profileGuidance = composedPrompt.profileGuidance;
      var requestGuidance = composedPrompt.requestGuidance;
      var runtimeContext = composedPrompt.runtimeContext;
      var systemCore = composedPrompt.systemCore;
      var activeRuntimeGuidance = composedPrompt.activeRuntimeGuidance;
      var systemPrompt = composedPrompt.system;
      var epoch = contextEpoch(checkpoint);
      var previousPromptState = latestPromptState(events);
      var samePromptEpoch = !!(previousPromptState && text(previousPromptState.contextEpoch) === epoch);
      var profileGuidanceHash = await sha256(profileGuidance, cryptoApi);
      var requestGuidanceHash = await sha256(requestGuidance, cryptoApi);
      var profileGuidanceChanged = samePromptEpoch
        && text(previousPromptState.profileGuidanceHash) !== profileGuidanceHash;
      var prefixProfileGuidance = profileGuidance;
      if (samePromptEpoch && typeof previousPromptState.prefixProfileGuidanceText === 'string') {
        prefixProfileGuidance = previousPromptState.prefixProfileGuidanceText;
      } else if (profileGuidanceChanged && typeof previousPromptState.profileGuidanceText === 'string') {
        // Compatibility with a prompt state written before the prefix field.
        prefixProfileGuidance = previousPromptState.profileGuidanceText;
      }
      // A stable profile stays before the first user message. If it changes,
      // preserve the old prefix and append a latest-version update instead of
      // rewriting the first message and destroying the cacheable prefix.
      var currentPromptMessages = prependProfileGuidance(
        tailMessages,
        prefixProfileGuidance
      );
      var appendedProfileGuidance = profileGuidanceChanged
        ? profileGuidanceRevision(profileGuidance) : '';
      var requestGuidanceChanged = samePromptEpoch
        && text(previousPromptState.requestGuidanceHash) !== requestGuidanceHash;
      var appendedRequestGuidance = !samePromptEpoch
        ? requestGuidance : requestGuidanceChanged ? requestGuidanceRevision(requestGuidance) : '';
      var contextAppendMessages = appendedContextMessages(
        appendedProfileGuidance,
        appendedRequestGuidance
      );
      var runtimeAppendMessages = runtimeContextMessage(runtimeContext);
      var budget = budgetNumbers(input, input.service);
      var recordingContextTokens = promptInput.recordingContext
        ? estimate(promptInput.recordingContext, 'recordingContext', input.service) : 0;
      var combinedRuntimeTokens = estimate(runtimeContext, 'runtimeContext', input.service);
      var profileGuidanceTokens = appendedProfileGuidance
        ? estimate(appendedProfileGuidance, 'profileGuidance', input.service) : 0;
      var requestGuidanceTokens = appendedRequestGuidance
        ? estimate(appendedRequestGuidance, 'requestGuidance', input.service) : 0;
      var cacheProviderVariant = clone(input.providerCacheVariant || {
        protocol: input.service && input.service.protocol,
        serviceId: input.service && (input.service.id || input.service.serviceId),
        model: input.service && input.service.model,
        endpoint: input.service && input.service.baseUrl,
      });
      if (!cacheProviderVariant || typeof cacheProviderVariant !== 'object' || Array.isArray(cacheProviderVariant)) {
        cacheProviderVariant = {};
      }
      if (!text(cacheProviderVariant.endpoint)) cacheProviderVariant.endpoint = text(input.service && input.service.baseUrl);
      // Per-request generation controls do not identify a reusable prompt
      // prefix. Keep them out of cacheEpochHash even when a Provider or compat
      // adapter maps them to a different wire representation.
      delete cacheProviderVariant.maxTokens;
      delete cacheProviderVariant.anthropicMaxTokensFloor;
      delete cacheProviderVariant.effectiveMaxOutputTokens;
      delete cacheProviderVariant.reasoningEffort;
      delete cacheProviderVariant.temperature;
      delete cacheProviderVariant.topP;
      delete cacheProviderVariant.compatTarget;
      var toolSchemaHash = await sha256(tools, cryptoApi);
      var systemPromptHash = await sha256(systemPrompt, cryptoApi);
      var cachePrefixMessages = currentPromptMessages.concat(contextAppendMessages);
      var providerMessageProjection = cachePrefixMessages.concat(runtimeAppendMessages);
      var providerMessageTokens = estimate(providerMessageProjection, 'messages', input.service);
      // This key describes only the stable cache prefix. Mutable profile and
      // request guidance deliberately stay out of it because their revisions
      // are appended to the conversation and must not invalidate that prefix.
      var cacheEpochHash = await sha256({
        schemaVersion: 1,
        conversationId: input.conversationId,
        contextEpoch: epoch,
        promptVersion: composedPrompt.promptVersion,
        systemPromptHash: systemPromptHash,
        toolSchemaHash: toolSchemaHash,
        provider: cacheProviderVariant,
      }, cryptoApi);
      var promptCacheKey = 'pfa_' + cacheEpochHash.replace(/^sha256:/, '').slice(0, 60);
      var appendOnlyPrefixVerified = await verifyAppendOnlyPrefix(
        cachePrefixMessages,
        previousPromptState,
        epoch,
        cacheEpochHash
      );
      var buckets = {
        system: estimate(systemCore, 'system', input.service),
        activeRuntimeGuidance: appendedRequestGuidance && activeRuntimeGuidance
          ? estimate(activeRuntimeGuidance, 'activeRuntimeGuidance', input.service) : 0,
        capabilityGuidance: appendedRequestGuidance && capabilityGuidance.text
          ? estimate(capabilityGuidance.text, 'capabilityGuidance', input.service) : 0,
        toolSchemas: estimate(tools, 'toolSchemas', input.service),
        profileGuidance: profileGuidanceTokens,
        requestGuidance: requestGuidanceTokens,
        messages: providerMessageTokens,
        runtimeContext: Math.max(0, combinedRuntimeTokens - recordingContextTokens),
        recordingContext: recordingContextTokens,
        recentHistory: estimate(historyMessages, 'recentHistory', input.service),
        currentTurn: estimate(currentMessages, 'currentTurn', input.service),
        providerEnvelope: Math.max(PROVIDER_ENVELOPE_TOKENS, estimate({ model: input.service.model, purpose: 'main' }, 'providerEnvelope', input.service)),
        outputReserve: budget.outputReserve,
        safetyReserve: budget.providerSafetyReserve,
      };
      // Budget the exact Provider-visible message projection. The cache may
      // make part of it cheaper at billing time, but it does not remove those
      // tokens from the model context window or from semantic attention.
      var inputTokens = buckets.system + buckets.toolSchemas + buckets.messages + buckets.providerEnvelope;
      var mandatoryTokens = inputTokens;
      var trace = {
        schemaVersion: 1,
        reason: input.reason || 'initial',
        conversationId: input.conversationId,
        generationId: input.generationId,
        turnId: input.turnId,
        steeringRevision: generationSteeringEvents.length,
        steeringThroughSequence: generationSteeringEvents.length
          ? Math.max(0, Number(generationSteeringEvents[generationSteeringEvents.length - 1].sequence) || 0)
          : 0,
        interruptRevision: Math.max(0, Math.floor(Number(generation.active.interruptRevision) || 0)),
        promptVersion: composedPrompt.promptVersion,
        responseLanguage: composedPrompt.responseLanguage,
        profileGuidanceHash: profileGuidanceHash,
        requestGuidanceHash: requestGuidanceHash,
        contextEpoch: epoch,
        runtimeContext: clone(runtimeContext),
        cacheEpochHash: cacheEpochHash,
        promptCacheKey: promptCacheKey,
        systemPromptHash: systemPromptHash,
        appendOnlyPrefixVerified: appendOnlyPrefixVerified,
        toolSchemaHash: toolSchemaHash,
        capabilityGuidanceHash: await sha256(capabilityGuidance.text, cryptoApi),
        activeCapabilityContracts: capabilityGuidance.contracts.map(function (contract) {
          return { method: contract.method, href: contract.href, routeTemplate: contract.routeTemplate };
        }),
        linkedCapabilityOperations: (capabilityGuidance.linkedOperations || []).map(function (operation) {
          return { method: operation.method, href: operation.href, relation: operation.relation };
        }),
        checkpointId: checkpoint && checkpoint.checkpointId || null,
        throughSequence: throughSequence,
        tailStartSequence: tailUnits[0] && tailUnits[0].startSequence || null,
        tailEndSequence: tailUnits.at(-1) && tailUnits.at(-1).endSequence || null,
        contextWindow: budget.contextWindow,
        inputLimit: budget.inputLimit,
        highWaterRatio: HIGH_WATER_RATIO,
        lowWaterRatio: LOW_WATER_RATIO,
        overflowLowWaterRatio: OVERFLOW_LOW_WATER_RATIO,
        buckets: buckets,
        inputTokens: inputTokens,
        mandatoryTokens: mandatoryTokens,
        exposedToolNames: policy.exposedToolNames.slice(),
        registeredToolNames: policy.registeredToolNames.slice(),
        estimated: typeof tokenizer.estimate !== 'function',
        recordingContext: {
          handleCount: recordingContext.recordings.length,
          selectedRangeCount: recordingContext.recordings.reduce(function (total, recording) {
            return total + (Array.isArray(recording.selectedRanges) ? recording.selectedRanges.length : 0);
          }, 0),
          estimatedTokens: recordingContextTokens,
        },
      };
      var summaryModel = deps.summary.resolveSummaryModel(input.service);
      trace.summaryProvider = {
        serviceId: summaryModel.serviceId,
        resolvedSummaryModel: summaryModel.resolvedSummaryModel,
        fallbackToMainModel: summaryModel.fallbackToMainModel,
      };
      if (input.lease && typeof input.lease.assertActive === 'function') await input.lease.assertActive();
      return {
        generation: generation,
        events: journalEvents,
        projectionEvents: events,
        units: units,
        tailUnits: tailUnits,
        currentUnits: currentUnits,
        historyUnits: historyUnits,
        checkpoint: checkpoint,
        policy: policy,
        tools: tools,
        systemCore: systemCore,
        activeRuntimeGuidance: activeRuntimeGuidance,
        capabilityGuidance: capabilityGuidance,
        systemPrompt: systemPrompt,
        profileGuidance: profileGuidance,
        runtimeContext: runtimeContext,
        prefixProfileGuidance: prefixProfileGuidance,
        baseMessages: currentPromptMessages,
        tailMessages: tailMessages,
        historyMessages: historyMessages,
        currentMessages: currentMessages,
        contextAppendMessages: contextAppendMessages,
        runtimeAppendMessages: runtimeAppendMessages,
        contextEpoch: epoch,
        promptCacheKey: promptCacheKey,
        budget: budget,
        trace: trace,
      };
    }

    async function maybeSummarize(input, assembled, targetRatio, force) {
      if (!summaryPipeline || typeof summaryPipeline.advance !== 'function') return null;
      var boundary = deps.summary.selectBoundary(assembled.units, {
        previousThroughSequence: assembled.checkpoint && assembled.checkpoint.throughSequence || 0,
        keepRecentUserTurns: 2,
      });
      if (!boundary) return null;
      var sourceEvents = assembled.projectionEvents.filter(function (event) {
        return event.sequence > (assembled.checkpoint && assembled.checkpoint.throughSequence || 0)
          && event.sequence <= boundary.throughSequence;
      });
      var summarySource = sourceEvents.map(deps.summary.summaryModelEvent);
      var summarySourceTokens = estimate(summarySource, 'summarySource', input.service);
      var summarySystemTokens = estimate(deps.summary.SUMMARY_SYSTEM_PROMPT, 'summarySystem', input.service);
      var summarySchemaTokens = estimate(deps.summary.SUMMARY_JSON_SCHEMA, 'summarySchema', input.service);
      var summaryOutputReserve = Math.min(4096, assembled.budget.effectiveMaxOutputTokens);
      var summaryModel = deps.summary.resolveSummaryModel(input.service);
      var summaryTrace = {
        purpose: 'context_summary',
        conversationId: input.conversationId,
        generationId: input.generationId,
        turnId: input.turnId,
        serviceId: summaryModel.serviceId,
        resolvedSummaryModel: summaryModel.resolvedSummaryModel,
        fallbackToMainModel: summaryModel.fallbackToMainModel,
        targetRatio: targetRatio,
        forced: force === true,
        buckets: {
          system: summarySystemTokens,
          source: summarySourceTokens,
          responseSchema: summarySchemaTokens,
          providerEnvelope: PROVIDER_ENVELOPE_TOKENS,
          outputReserve: summaryOutputReserve,
          safetyReserve: assembled.budget.providerSafetyReserve,
        },
        inputLimit: assembled.budget.inputLimit,
      };
      summaryTrace.inputTokens = summarySystemTokens + summarySourceTokens + summarySchemaTokens + PROVIDER_ENVELOPE_TOKENS;
      if (summaryTrace.inputTokens > summaryTrace.inputLimit) {
        throw contextError('CONTEXT_EXHAUSTED', 'Summary request itself exceeds the governed input limit', summaryTrace);
      }
      return summaryPipeline.advance({
        lease: input.lease,
        service: input.service,
        previousCheckpoint: assembled.checkpoint,
        boundary: boundary,
        units: assembled.units,
        events: assembled.projectionEvents,
        logicalRequestId: idGenerator('summary_logical'),
        contextTrace: summaryTrace,
        request: {
          maxOutputTokens: summaryOutputReserve,
          contextTrace: summaryTrace,
          baseUrl: input.service.baseUrl,
          protocol: input.service.protocol,
          credential: input.service.credential,
          headers: clone(input.service.headers || {}),
        },
      });
    }

    async function build(input) {
      input = input || {};
      if (!input.conversationId || !input.generationId || !input.turnId) throw new TypeError('ContextBuilder.build requires conversationId, generationId, and turnId');
      var assembled = await assemble(input);
      if (assembled.trace.mandatoryTokens > assembled.budget.inputLimit) {
        throw contextError('CONTEXT_EXHAUSTED', 'Mandatory context buckets exceed the model input limit', assembled.trace);
      }
      var targetRatio = input.reason === 'overflow_retry' ? OVERFLOW_LOW_WATER_RATIO : LOW_WATER_RATIO;
      var highWater = Math.floor(assembled.budget.inputLimit * HIGH_WATER_RATIO);
      var shouldSummarize = input.forceSummary === true || assembled.trace.inputTokens > highWater;
      var summaryFailure = null;
      if (shouldSummarize && !input._summaryAdvanced) {
        if (input.preferences && input.preferences.contextCompression === 'off' && input.forceSummary !== true) {
          if (assembled.trace.inputTokens > assembled.budget.inputLimit) {
            throw contextError('CONTEXT_EXHAUSTED', 'Context compression is disabled and the governed input no longer fits', assembled.trace);
          }
        } else {
          try {
            var advanced = await maybeSummarize(input, assembled, targetRatio, input.forceSummary === true || input.reason === 'overflow_retry');
            if (advanced) return build(Object.assign({}, input, { _summaryAdvanced: true, forceSummary: false }));
          } catch (error) {
            if (error && (error.code === 'GENERATION_STALE' || error.code === 'SERVICE_WORKER_TERMINATED')) throw error;
            summaryFailure = { code: error && error.code || 'SUMMARY_FAILED', message: error && error.message || String(error) };
          }
        }
      }
      if (assembled.trace.inputTokens > assembled.budget.inputLimit) {
        assembled.trace.summaryFailure = summaryFailure;
        throw contextError('CONTEXT_EXHAUSTED', 'Context remains above the governed input limit after allowed compression', assembled.trace);
      }
      if (summaryFailure) assembled.trace.summaryFailure = summaryFailure;
      var modelRequestId = input.modelRequestId || idGenerator('model_request');
      var cachePrefixMessages = assembled.baseMessages.concat(assembled.contextAppendMessages);
      var requestMessages = cachePrefixMessages.concat(assembled.runtimeAppendMessages);
      // Prefix state intentionally excludes the regenerated runtime tail.
      var promptState = {
        schemaVersion: 1,
        contextEpoch: assembled.contextEpoch,
        messageCount: cachePrefixMessages.length,
        messagesHash: await sha256(cachePrefixMessages, cryptoApi),
        systemPromptHash: assembled.trace.systemPromptHash,
        toolSchemaHash: assembled.trace.toolSchemaHash,
        cacheEpochHash: assembled.trace.cacheEpochHash,
        profileGuidanceHash: assembled.trace.profileGuidanceHash,
        profileGuidanceText: assembled.profileGuidance,
        prefixProfileGuidanceText: assembled.prefixProfileGuidance,
        requestGuidanceHash: assembled.trace.requestGuidanceHash,
      };
      var request = {
        purpose: 'main',
        logicalRequestId: input.logicalRequestId || idGenerator('logical_request'),
        modelRequestId: modelRequestId,
        conversationId: input.conversationId,
        generationId: input.generationId,
        turnId: input.turnId,
        serviceId: text(input.service.id || input.service.serviceId),
        model: text(input.service.model),
        system: assembled.systemPrompt,
        messages: requestMessages,
        tools: assembled.tools,
        sessionId: input.conversationId,
        promptCacheKey: assembled.promptCacheKey,
        maxOutputTokens: assembled.budget.effectiveMaxOutputTokens,
        signal: input.lease && input.lease.signal,
        contextTrace: assembled.trace,
      };
      return {
        request: request,
        trace: assembled.trace,
        capabilityPolicy: assembled.policy,
        checkpoint: assembled.checkpoint,
        atomicUnits: assembled.units,
        contextAppendMessages: clone(assembled.contextAppendMessages),
        promptState: promptState,
      };
    }

    async function forceSummary(input) {
      var assembled = await assemble(Object.assign({}, input, { reason: input.reason || 'force_summary' }));
      var result = await maybeSummarize(Object.assign({}, input, { forceSummary: true }), assembled, LOW_WATER_RATIO, true);
      if (!result) throw contextError('SUMMARY_BOUNDARY_UNAVAILABLE', 'No earlier complete prefix is available to summarize');
      return {
        checkpointId: result.checkpoint.checkpointId,
        throughSequence: result.checkpoint.throughSequence,
        previousInputTokens: assembled.trace.inputTokens,
        checkpoint: result.checkpoint,
      };
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      build: build,
      forceSummary: forceSummary,
      recordUsageCalibration: recordUsageCalibration,
      buildAtomicUnits: buildAtomicUnits,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    HIGH_WATER_RATIO: HIGH_WATER_RATIO,
    LOW_WATER_RATIO: LOW_WATER_RATIO,
    OVERFLOW_LOW_WATER_RATIO: OVERFLOW_LOW_WATER_RATIO,
    MIN_SAFETY_TOKENS: MIN_SAFETY_TOKENS,
    buildAtomicUnits: buildAtomicUnits,
    compactToolProjection: compactToolProjection,
    buildSummaryProviderRequest: buildSummaryProviderRequest,
    create: create,
  });
});
