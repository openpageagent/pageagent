// Stateless generation orchestrator. Turn ownership and facts remain in Coordinator + Journal.
(function attachConversationRuntime(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var nodeCrypto = null;
  if (commonJs) {
    try { nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  }
  var deps = commonJs ? {
    core: require('./agent-core'),
    provider: require('./agent-provider'),
    summary: require('./conversation-summary'),
    context: require('./context-builder'),
    capability: require('./capability-policy'),
    loop: require('./agent-loop'),
    materializer: require('../background/conversation-journal-materializer'),
  } : {
    core: root.AgentCore,
    provider: root.AgentProvider,
    summary: root.ConversationSummary,
    context: root.ContextBuilder,
    capability: root.CapabilityPolicy,
    loop: root.AgentLoop,
    materializer: root.ConversationJournalMaterializer,
  };
  var api = factory(root, deps, nodeCrypto);
  if (commonJs) module.exports = api;
  else root.ConversationRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, deps, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;
  var installedResourceRuntime = null;
  var RESULT_TYPES = Object.freeze({
    tool_execution_completed: true,
    tool_execution_failed: true,
    tool_execution_unknown: true,
    tool_call_deferred: true,
  });
  var WRITE_METHODS = Object.freeze({ POST: true, PUT: true, PATCH: true, DELETE: true });

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function stable(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('ConversationRuntime values cannot contain cycles');
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
  function hex(bytes) { return Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join(''); }
  async function sha256(value, cryptoApi) {
    var serialized = typeof value === 'string' ? value : stableStringify(value);
    if (nodeCrypto && nodeCrypto.createHash) return 'sha256:' + nodeCrypto.createHash('sha256').update(serialized).digest('hex');
    cryptoApi = cryptoApi || root && root.crypto;
    if (!cryptoApi || !cryptoApi.subtle || typeof TextEncoder !== 'function') throw new Error('SHA-256 is required by ConversationRuntime');
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function requiredApi(value, name, method) {
    if (!value || method && typeof value[method] !== 'function') throw new Error(name + ' must load before ConversationRuntime');
    return value;
  }
  function installResourceRuntime(runtime) {
    if (!runtime || typeof runtime.dispatch !== 'function') throw new TypeError('ConversationRuntime requires an ARP Resource Runtime');
    if (installedResourceRuntime && installedResourceRuntime !== runtime) throw new Error('A different ARP Resource Runtime is already installed');
    installedResourceRuntime = runtime;
    return runtime;
  }
  function dispatchResource(method, request, context) {
    if (!installedResourceRuntime) return Promise.reject(new Error('ARP Resource Runtime is not installed'));
    return installedResourceRuntime.dispatch(method, request, context || {});
  }
  function performedValue(value, call) {
    var performed = value && (value.performed || value.receipt && value.receipt.performed);
    if (performed === true) performed = 'yes';
    if (performed === false) performed = 'no';
    performed = text(performed).toLowerCase();
    if (performed === 'yes' || performed === 'no' || performed === 'unknown') return performed;
    return WRITE_METHODS[call.name] ? 'unknown' : 'yes';
  }
  function errorPerformed(error) {
    var performed = error && (error.performed || error.receipt && error.receipt.performed);
    if (performed === true) performed = 'yes';
    if (performed === false) performed = 'no';
    performed = text(performed).toLowerCase();
    return performed === 'yes' || performed === 'unknown' ? 'unknown' : 'no';
  }
  function create(options) {
    options = options || {};
    var journal = options.journal;
    var resourceRuntime = options.resourceRuntime || installedResourceRuntime;
    if (!journal || typeof journal.getMetadata !== 'function' || typeof journal.putStreamBuffer !== 'function') {
      throw new TypeError('ConversationRuntime requires ConversationJournalStore');
    }
    if (!resourceRuntime || typeof resourceRuntime.dispatch !== 'function') throw new TypeError('ConversationRuntime requires resourceRuntime');
    var resolveService = options.resolveService;
    var resolveAssistant = options.resolveAssistant;
    if (typeof resolveService !== 'function' || typeof resolveAssistant !== 'function') {
      throw new TypeError('ConversationRuntime requires resolveService and resolveAssistant');
    }
    var coreFactory = requiredApi(deps.core, 'AgentCore', 'create').create({ resourceRuntime: resourceRuntime });
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : function (prefix) { nextId += 1; return prefix + '_' + Number(clock()).toString(36) + '_' + nextId.toString(36); };
    var resolveScheduleGrant = typeof options.resolveScheduleGrant === 'function'
      ? options.resolveScheduleGrant : async function () { return []; };
    var cryptoApi = options.crypto || root && root.crypto;
    var journalMaterializer = options.journalMaterializer
      || deps.materializer && deps.materializer.create({ journal: journal });
    if (!journalMaterializer || typeof journalMaterializer.getAllEvents !== 'function'
        || typeof journalMaterializer.collectRecordingContext !== 'function') {
      throw new TypeError('ConversationRuntime requires ConversationJournalMaterializer');
    }
    var recordingAttachments = options.recordingAttachments || null;
    var streamWriteQueues = Object.create(null);
    var streamDeltaBatches = Object.create(null);
    var streamCleanupTimers = Object.create(null);
    var STREAM_BUFFER_FLUSH_MS = 40;

    function streamKeyFor(conversationId, generationId, modelRequestId) {
      return [conversationId, generationId, modelRequestId].join('\n');
    }

    function clearStreamCleanupTimer(key) {
      if (!streamCleanupTimers[key]) return;
      try { clearTimeout(streamCleanupTimers[key]); } catch (_) {}
      delete streamCleanupTimers[key];
    }

    function mergeStreamDelta(current, key, event, updatedAt) {
      current = current || key;
      event = event || {};
      var next = Object.assign({}, current, { updatedAt: Math.max(0, Number(updatedAt) || Number(clock())) });
      if (event.type === 'text_delta') {
        if (current.thinking === true && Number(current.startedAt) > 0) {
          next.durationMs = Math.max(0, next.updatedAt - Number(current.startedAt));
        }
        next.thinking = false;
        if (event.phase === 'commentary') {
          next.commentary = String(current.commentary || '') + String(event.delta || '');
        } else {
          next.text = String(current.text || '') + String(event.delta || '');
        }
      }
      else if (event.type === 'reasoning_delta') {
        next.thinking = true;
        next.durationMs = 0;
        next.reasoning = String(current.reasoning || '') + String(event.delta || '');
        next.reasoningKind = event.reasoningKind || current.reasoningKind || 'raw';
      }
      else if (event.type === 'tool_call_delta') {
        if (current.thinking === true && Number(current.startedAt) > 0) {
          next.durationMs = Math.max(0, next.updatedAt - Number(current.startedAt));
        }
        next.thinking = false;
        next.toolCalls = Array.isArray(current.toolCalls) ? current.toolCalls.slice() : [];
        var existing = next.toolCalls.find(function (item) { return item.toolCallId === event.callId; });
        if (!existing) next.toolCalls.push({ toolCallId: event.callId, name: text(event.name).toUpperCase(), receivedChars: Number(event.receivedChars) || 0 });
        else {
          existing.receivedChars = Number(event.receivedChars) || existing.receivedChars;
          if (event.name) existing.name = text(event.name).toUpperCase();
        }
      } else return null;
      return next;
    }

    async function applyStreamUpdate(update) {
      var event = update.event || {};
      var key = {
        conversationId: update.conversationId,
        generationId: update.generationId,
        modelRequestId: update.modelRequestId,
      };
      var streamKey = streamKeyFor(key.conversationId, key.generationId, key.modelRequestId);
      if (event.type === 'durable' || event.type === 'model_end') {
        clearStreamCleanupTimer(streamKey);
        return journal.deleteStreamBuffer(key);
      }
      if (event.type === 'request_terminal') {
        /* The provider finally block runs before model_response_completed and
           tool_call_planned are committed. Retaining the live buffer briefly
           lets readonly surfaces bridge that hand-off instead of rendering a
           transient empty stream. A failed/interrupted request still gets
           cleaned up when no durable hand-off follows. */
        clearStreamCleanupTimer(streamKey);
        streamCleanupTimers[streamKey] = setTimeout(function () {
          delete streamCleanupTimers[streamKey];
          journal.deleteStreamBuffer(key).catch(function () {});
        }, 500);
        return journal.getStreamBuffer(key.conversationId, key.generationId, key.modelRequestId);
      }
      var current = await journal.getStreamBuffer(key.conversationId, key.generationId, key.modelRequestId) || key;
      var next = Object.assign({}, current, { updatedAt: Number(clock()) });
      if (event.type === 'model_request_started' || event.type === 'model_start') {
        // Create a visible in-flight row before the provider produces its first token.
        next.startedAt = Math.max(0, Number(event.startedAt) || next.updatedAt);
        next.durationMs = 0;
        next.thinking = true;
        next.reasoning = '';
        next.commentary = '';
        next.text = '';
        next.toolCalls = [];
      }
      else next = mergeStreamDelta(current, key, event, update.receivedAt);
      if (!next) return null;
      return journal.putStreamBuffer(next);
    }

    async function applyStreamDeltaBatch(updates) {
      var first = updates[0] || {};
      var key = {
        conversationId: first.conversationId,
        generationId: first.generationId,
        modelRequestId: first.modelRequestId,
      };
      var current = await journal.getStreamBuffer(key.conversationId, key.generationId, key.modelRequestId) || key;
      for (var index = 0; index < updates.length; index += 1) {
        var update = updates[index] || {};
        var next = mergeStreamDelta(current, key, update.event, update.receivedAt);
        if (next) current = next;
      }
      return journal.putStreamBuffer(current);
    }

    function enqueueStreamWrite(queueKey, operation) {
      var previous = streamWriteQueues[queueKey] || Promise.resolve();
      var current = previous.catch(function () {}).then(operation);
      var tracked = current.then(function () {}, function () {}).finally(function () {
        if (streamWriteQueues[queueKey] === tracked) delete streamWriteQueues[queueKey];
      });
      streamWriteQueues[queueKey] = tracked;
      return current;
    }

    function flushStreamDeltaBatch(queueKey) {
      var batch = streamDeltaBatches[queueKey];
      if (!batch) return null;
      delete streamDeltaBatches[queueKey];
      if (batch.timer) clearTimeout(batch.timer);
      var operation = enqueueStreamWrite(queueKey, function () {
        return applyStreamDeltaBatch(batch.updates);
      });
      operation.then(function (value) {
        batch.waiters.forEach(function (waiter) { waiter.resolve(value); });
      }, function (error) {
        batch.waiters.forEach(function (waiter) { waiter.reject(error); });
      });
      return operation;
    }

    function streamSink(update) {
      update = Object.assign({}, update || {}, { receivedAt: Number(clock()) });
      var queueKey = streamKeyFor(update.conversationId, update.generationId, update.modelRequestId);
      var type = text(update.event && update.event.type);
      if (type === 'text_delta' || type === 'reasoning_delta' || type === 'tool_call_delta') {
        var batch = streamDeltaBatches[queueKey];
        if (!batch) {
          batch = streamDeltaBatches[queueKey] = { updates: [], waiters: [], timer: 0 };
          batch.timer = setTimeout(function () { flushStreamDeltaBatch(queueKey); }, STREAM_BUFFER_FLUSH_MS);
        }
        batch.updates.push(update);
        return new Promise(function (resolve, reject) { batch.waiters.push({ resolve: resolve, reject: reject }); });
      }
      flushStreamDeltaBatch(queueKey);
      return enqueueStreamWrite(queueKey, function () { return applyStreamUpdate(update); });
    }

    async function createComponents(input, lease) {
      input = clone(input || {});
      await lease.assertActive();
      var values = await Promise.all([resolveService(input.serviceId), resolveAssistant(input.assistantId)]);
      var service = values[0];
      var assistant = values[1];
      if (!service || text(service.id || service.serviceId) !== input.serviceId) {
        var serviceError = new Error('未知 ModelService：' + input.serviceId); serviceError.code = 'SERVICE_NOT_FOUND'; throw serviceError;
      }
      if (!assistant || text(assistant.id) !== input.assistantId) {
        var assistantError = new Error('未知 Assistant：' + input.assistantId); assistantError.code = 'ASSISTANT_MISMATCH'; throw assistantError;
      }
      service = clone(service);
      service.id = text(service.id || service.serviceId);
      service.model = text(assistant.model || service.model);
      var materializedEvents = await journalMaterializer.getAllEvents(input.conversationId);
      var checkpoint = await journal.getActiveCheckpoint(input.conversationId);
      var recordingHandles = journalMaterializer.collectRecordingContext(materializedEvents, checkpoint);
      if (recordingHandles.length) {
        if (!recordingAttachments || typeof recordingAttachments.prepareGeneration !== 'function') {
          var recordingError = new Error('Recording 附件授权不可用');
          recordingError.code = 'CAPABILITY_UNAVAILABLE';
          throw recordingError;
        }
        var initialRecordingGrant = await recordingAttachments.prepareGeneration({
          generationId: lease.generationId, conversationId: input.conversationId,
          actorId: 'assistant:' + input.assistantId,
          profileId: text(assistant.profileId || 'default'), incognito: !!(input.surface && input.surface.incognito),
          recordings: recordingHandles,
        });
        input.recordingVisibleResourceUris = initialRecordingGrant.visibleResourceUris;
      }
      input.recordingContext = { recordings: recordingHandles };
      var generationCore = coreFactory.createGeneration(input, lease, assistant);
      var gateway = deps.provider.create({
        service: service,
        assistant: assistant,
        modelSettings: options.modelSettings || root.ModelSettings,
        fetch: options.fetch || root.fetch && root.fetch.bind(root),
        resolveImageArtifact: options.resolveImageArtifact || resourceRuntime.resolveImageArtifact,
      });
      var summaryPipeline = deps.summary.create({
        journal: journal, providerGateway: gateway, clock: clock, idGenerator: idGenerator,
        requestBuilder: deps.context.buildSummaryProviderRequest,
        journalMaterializer: journalMaterializer,
        timeoutMs: options.summaryTimeoutMs,
        faultInjector: options.faultInjector,
      });
      var contextBuilder = deps.context.create({
        journal: journal,
        capabilityPolicy: deps.capability.create(),
        resourceRegistry: resourceRuntime.registry || resourceRuntime.router && resourceRuntime.router.registry,
        resourceContext: generationCore.securityContext,
        summaryPipeline: summaryPipeline,
        resolveRuntimeContext: generationCore.resolveRuntimeContext,
        tokenizer: options.tokenizer,
        clock: clock,
        idGenerator: idGenerator,
        journalMaterializer: journalMaterializer,
        resolveRecordingContext: async function (runtimeInput) {
          var handles = journalMaterializer.collectRecordingContext(runtimeInput.events, runtimeInput.checkpoint);
          if (handles.length) {
            if (!recordingAttachments || typeof recordingAttachments.prepareGeneration !== 'function') {
              var error = new Error('Recording 附件授权不可用');
              error.code = 'CAPABILITY_UNAVAILABLE';
              throw error;
            }
            var prepared = await recordingAttachments.prepareGeneration({
              generationId: lease.generationId, conversationId: input.conversationId,
              actorId: 'assistant:' + input.assistantId,
              profileId: text(assistant.profileId || 'default'), incognito: !!(input.surface && input.surface.incognito),
              recordings: handles,
            });
            if (generationCore.addVisibleResourceUris) generationCore.addVisibleResourceUris(prepared.visibleResourceUris);
          }
          return { recordings: handles };
        },
        materializeResourceResults: async function (events) {
          var output = [];
          for (var eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
            var event = clone(events[eventIndex]);
            var result = event && event.payload && event.payload.result;
            if (result && result.kind === 'recording-projection-ref') {
              event.payload.result = result.modelSnapshot !== undefined
                ? clone(result.modelSnapshot)
                : await generationCore.toolDispatcher.materializeJournalResult(result);
            }
            output.push(event);
          }
          return output;
        },
      });
      var loop = deps.loop.create({
        contextBuilder: contextBuilder,
        providerGateway: gateway,
        toolDispatcher: generationCore.toolDispatcher,
        streamSink: streamSink,
        clock: clock,
        idGenerator: idGenerator,
        crypto: cryptoApi,
        faultInjector: options.faultInjector,
      });
      var scheduleGrant = input.surface && input.surface.type === 'scheduled'
        ? await resolveScheduleGrant(input) : [];
      var runtimeInput = Object.assign({}, input, {
        service: service,
        allowedToolNames: generationCore.allowedToolNames,
        scheduleGrant: scheduleGrant,
        providerCacheVariant: typeof deps.provider.cacheVariant === 'function'
          ? deps.provider.cacheVariant({ service: service, assistant: assistant })
          : { protocol: text(service.protocol), serviceId: text(service.id || service.serviceId), model: text(assistant.model || service.model) },
      });
      return {
        input: runtimeInput,
        service: service,
        assistant: assistant,
        generationCore: generationCore,
        contextBuilder: contextBuilder,
        loop: loop,
      };
    }

    async function idempotencyKeyFor(lease, call) {
      var explicit = text(call.arguments && call.arguments.idempotencyKey);
      if (explicit) return explicit;
      return sha256([
        lease.conversationId, lease.generationId, text(call.id), text(call.name),
        text(call.arguments && call.arguments.uri),
      ].join('\n'), cryptoApi);
    }

    async function appendMissingPlans(lease, events) {
      var planned = Object.create(null);
      var results = Object.create(null);
      events.forEach(function (event) {
        if (event.type === 'tool_call_planned') planned[event.toolCallId] = true;
        if (RESULT_TYPES[event.type]) results[event.toolCallId] = true;
      });
      var missing = [];
      for (var index = 0; index < events.length; index += 1) {
        var event = events[index];
        if (event.type !== 'model_response_completed') continue;
        var calls = Array.isArray(event.payload && event.payload.calls) ? event.payload.calls : [];
        for (var callIndex = 0; callIndex < calls.length; callIndex += 1) {
          var call = calls[callIndex] || {};
          var callId = text(call.id || call.toolCallId);
          if (!callId || planned[callId] || results[callId]) continue;
          call = { id: callId, name: text(call.name).toUpperCase(), arguments: clone(call.arguments || call.input || {}) };
          var idempotencyKey = await idempotencyKeyFor(lease, call);
          missing.push({
            type: 'tool_call_planned', modelRequestId: event.modelRequestId, toolCallId: callId,
            payload: {
              name: call.name,
              arguments: call.arguments,
              argumentsHash: await sha256(call.arguments, cryptoApi),
              idempotencyKey: idempotencyKey,
              recoveredFromModelResponse: true,
            },
          });
          planned[callId] = true;
        }
      }
      if (missing.length) await lease.appendMany(missing);
      return missing.length;
    }

    async function preserveInterruptedStreams(lease, events) {
      if (typeof journal.listStreamBuffers !== 'function') return 0;
      var terminalRequests = Object.create(null);
      events.forEach(function (event) {
        if (event.modelRequestId && /^(?:model_response_completed|model_request_failed)$/.test(event.type)) {
          terminalRequests[event.modelRequestId] = true;
        }
      });
      var buffers = await journal.listStreamBuffers(lease.conversationId, lease.generationId);
      var preserved = 0;
      for (var index = 0; index < buffers.length; index += 1) {
        var buffer = buffers[index];
        if (!terminalRequests[buffer.modelRequestId]) {
          await lease.appendMany([
            {
              type: 'model_stream_interrupted', modelRequestId: buffer.modelRequestId,
              payload: {
                text: String(buffer.text || ''), commentary: String(buffer.commentary || ''), reasoning: String(buffer.reasoning || ''),
                reason: 'mv3_worker_terminated',
              },
            },
            {
              type: 'model_request_failed', modelRequestId: buffer.modelRequestId,
              payload: { errorCode: 'MV3_INTERRUPTED', error: '模型响应提交前 Service Worker 已终止', retryable: true },
            },
          ]);
          preserved += 1;
        }
        await journal.deleteStreamBuffer(buffer);
      }
      return preserved;
    }

    function callFromPlan(plan) {
      return {
        id: text(plan.toolCallId),
        name: text(plan.payload && plan.payload.name).toUpperCase(),
        arguments: clone(plan.payload && plan.payload.arguments || {}),
      };
    }

    function requestTargetFromPlan(plan) {
      var args = plan && plan.payload && plan.payload.arguments;
      var value = args && args.uri;
      return typeof value === 'string' ? value : String(value === undefined || value === null ? '' : value);
    }

    function traceFromValue(value) {
      if (!value || typeof value !== 'object') return null;
      if (value.trace && typeof value.trace === 'object') return value.trace;
      if (value.error && value.error.trace && typeof value.error.trace === 'object') return value.error.trace;
      if (value.details && value.details.trace && typeof value.details.trace === 'object') return value.details.trace;
      return null;
    }

    async function finishRecoveredCall(components, lease, plan, result, performed) {
      var call = callFromPlan(plan);
      var trace = traceFromValue(result);
      var canonicalUri = text(trace && trace.canonicalPath) || null;
      var durableResult = typeof components.generationCore.toolDispatcher.journalResult === 'function'
        ? await components.generationCore.toolDispatcher.journalResult(call, result)
        : clone(result);
      var modelProjection = typeof components.generationCore.toolDispatcher.modelProjectionFor === 'function'
        ? components.generationCore.toolDispatcher.modelProjectionFor(call) : { type: 'data' };
      await lease.update({ inFlightTool: null }, {
        type: 'tool_execution_completed', modelRequestId: plan.modelRequestId, toolCallId: plan.toolCallId,
        payload: {
          name: text(plan.payload && plan.payload.name).toUpperCase(),
          requestTarget: requestTargetFromPlan(plan),
          canonicalUri: canonicalUri,
          routeTemplate: trace && trace.routeTemplate || null,
          routeSchema: trace && trace.routeSchema || 'not-checked',
          performed: performed,
          receipt: clone(result && result.receipt || { performed: performed }),
          result: durableResult,
          modelProjection: clone(modelProjection),
          trace: clone(trace),
          recovered: true,
        },
      });
    }

    async function failRecoveredCall(components, lease, plan, error, performed, stage) {
      var dispatcher = components.generationCore.toolDispatcher;
      var call = callFromPlan(plan);
      var trace = traceFromValue(error);
      var canonicalUri = text(trace && trace.canonicalPath) || null;
      var modelProjection = typeof dispatcher.modelProjectionFor === 'function'
        ? dispatcher.modelProjectionFor(call) : { type: 'data' };
      await lease.update({ inFlightTool: null }, {
        type: performed === 'unknown' ? 'tool_execution_unknown' : 'tool_execution_failed',
        modelRequestId: plan.modelRequestId,
        toolCallId: plan.toolCallId,
        payload: {
          name: text(plan.payload && plan.payload.name).toUpperCase(),
          requestTarget: requestTargetFromPlan(plan),
          canonicalUri: canonicalUri,
          routeTemplate: trace && trace.routeTemplate || null,
          routeSchema: trace && trace.routeSchema || 'not-checked',
          errorCode: text(error && error.code) || (performed === 'unknown' ? 'SIDE_EFFECT_UNKNOWN' : 'RECOVERY_NOT_PERFORMED'),
          error: error && error.message || String(error || '恢复的工具调用未完成'),
          retryable: false,
          performed: performed,
          receipt: clone(error && error.receipt || null),
          details: clone(error && error.details || {}),
          current: clone(error && error.current || null),
          trace: clone(trace),
          warnings: clone(error && error.warnings || []),
          modelProjection: clone(modelProjection),
          lastKnownStage: text(error && error.stage) || stage,
          reconciliationAttempts: 1,
          recovered: true,
        },
      });
    }

    async function deferRecoveredCall(lease, plan, code, reason) {
      await lease.append({
        type: 'tool_call_deferred', modelRequestId: plan.modelRequestId, toolCallId: plan.toolCallId,
        payload: {
          name: text(plan.payload && plan.payload.name).toUpperCase(),
          requestTarget: requestTargetFromPlan(plan),
          canonicalUri: null,
          routeTemplate: null,
          routeSchema: 'not-checked',
          trace: null,
          errorCode: code,
          reason: reason,
          performed: 'no',
          recovered: true,
          result: { ok: false, error: { code: code, message: reason }, receipt: { performed: 'no' } },
        },
      });
    }

    async function dispatchRecoveredCall(components, lease, plan, batchSnapshot, alreadyStarted) {
      var call = callFromPlan(plan);
      var active = await lease.assertActive();
      var maxToolCalls = Math.max(0, Number(components.input.budgets && components.input.budgets.maxToolCalls) || 0);
      var count = Math.max(0, Number(active.counters && active.counters.toolCallCount) || 0);
      if (!alreadyStarted && count >= maxToolCalls) {
        await deferRecoveredCall(lease, plan, 'TOOL_BUDGET_EXHAUSTED', '恢复调度前，generation 已耗尽 maxToolCalls');
        return { state: 'deferred' };
      }
      var capabilityDecision = typeof components.generationCore.isToolCallAllowed === 'function'
        ? components.generationCore.isToolCallAllowed(call)
        : { allowed: components.generationCore.allowedToolNames.indexOf(call.name) !== -1 };
      if (!capabilityDecision.allowed) {
        await deferRecoveredCall(lease, plan, 'CAPABILITY_UNAVAILABLE', capabilityDecision.message || '当前 Assistant 不允许执行恢复的调用');
        return { state: 'deferred' };
      }
      var idempotencyKey = text(plan.payload && plan.payload.idempotencyKey) || await idempotencyKeyFor(lease, call);
      if (!alreadyStarted) {
        var counters = Object.assign({}, active.counters || {});
        counters.toolCallCount = count + 1;
        await lease.update({
          counters: counters,
          inFlightTool: {
            toolCallId: call.id,
            modelRequestId: plan.modelRequestId,
            method: call.name,
            requestTarget: requestTargetFromPlan(plan),
            canonicalUri: null,
            routeTemplate: null,
            routeSchema: 'not-checked',
            idempotencyKey: idempotencyKey,
            stage: 'started',
            startedAt: Number(clock()),
          },
        }, {
          type: 'tool_execution_started', modelRequestId: plan.modelRequestId, toolCallId: call.id,
          payload: {
            method: call.name,
            requestTarget: requestTargetFromPlan(plan),
            canonicalUri: null,
            routeTemplate: null,
            routeSchema: 'not-checked',
            idempotencyKey: idempotencyKey,
            recovered: true,
          },
        });
      }
      try {
        var result = await components.generationCore.toolDispatcher.dispatch(call, {
          conversationId: lease.conversationId,
          generationId: lease.generationId,
          turnId: lease.turnId,
          modelRequestId: plan.modelRequestId,
          idempotencyKey: idempotencyKey,
          batchSnapshot: batchSnapshot,
          lease: lease,
          signal: lease.signal,
          recovery: true,
        });
        var performed = performedValue(result, call);
        if (performed === 'unknown') {
          await failRecoveredCall(components, lease, plan, { message: '恢复调度返回了副作用未知的结果', receipt: result && result.receipt }, 'unknown', 'recovery_dispatch');
          return { state: 'unknown' };
        }
        await finishRecoveredCall(components, lease, plan, result, performed);
        return { state: 'completed', result: result, call: call };
      } catch (error) {
        var failedPerformed = errorPerformed(error);
        await failRecoveredCall(components, lease, plan, error, failedPerformed, 'recovery_dispatch');
        return { state: failedPerformed === 'unknown' ? 'unknown' : 'failed', error: error, call: call };
      }
    }

    async function reconcileStartedCall(components, lease, plan, start, interactions, batchSnapshot) {
      var call = callFromPlan(plan);
      var interaction = interactions[call.id] || null;
      if (interaction && interaction.resolved) {
        if (call.name === 'ASK_USER') {
          var interactionResult = { answer: clone(interaction.answer), receipt: { performed: 'no' } };
          await finishRecoveredCall(components, lease, plan, interactionResult, 'no');
          return { state: 'completed', result: interactionResult, call: call };
        }
      }
      if (['GET', 'OPTIONS'].indexOf(call.name) !== -1) {
        return dispatchRecoveredCall(components, lease, plan, batchSnapshot, true);
      }
      var receipt;
      try {
        receipt = await components.generationCore.toolDispatcher.queryReceipt({
          conversationId: lease.conversationId,
          generationId: lease.generationId,
          turnId: lease.turnId,
          toolCallId: call.id,
          modelRequestId: plan.modelRequestId,
          method: call.name,
          canonicalUri: text(start.payload && start.payload.canonicalUri) || requestTargetFromPlan(plan),
          idempotencyKey: text(start.payload && start.payload.idempotencyKey || plan.payload && plan.payload.idempotencyKey),
          arguments: clone(call.arguments),
        });
      } catch (error) {
        receipt = { performed: 'unknown', error: error && error.message || String(error) };
      }
      var performed = performedValue(receipt, call);
      if (performed === 'yes') {
        await finishRecoveredCall(components, lease, plan, receipt && receipt.result !== undefined ? receipt.result : receipt, 'yes');
        return { state: 'completed', result: receipt, call: call };
      }
      if (performed === 'no') {
        await failRecoveredCall(components, lease, plan, { code: 'RECOVERY_NOT_PERFORMED', message: '回执确认操作未执行', receipt: receipt }, 'no', 'receipt_query');
        return { state: 'failed', result: receipt, call: call };
      }
      await failRecoveredCall(components, lease, plan, { code: 'SIDE_EFFECT_UNKNOWN', message: '回执无法确认操作是否执行', receipt: receipt }, 'unknown', 'receipt_query');
      return { state: 'unknown', result: receipt, call: call };
    }

    async function reconcileGeneration(input, lease) {
      var components = await createComponents(input, lease);
      var events = (await journalMaterializer.getAllEvents(lease.conversationId)).filter(function (event) {
        return event.generationId === lease.generationId;
      });
      await preserveInterruptedStreams(lease, events);
      if (await appendMissingPlans(lease, events)) {
        events = (await journalMaterializer.getAllEvents(lease.conversationId)).filter(function (event) { return event.generationId === lease.generationId; });
      }
      var plans = [];
      var starts = Object.create(null);
      var results = Object.create(null);
      var interactions = Object.create(null);
      events.forEach(function (event) {
        if (event.type === 'tool_call_planned') plans.push(event);
        if (event.type === 'tool_execution_started') starts[event.toolCallId] = event;
        if (RESULT_TYPES[event.type]) results[event.toolCallId] = event;
        if (event.type === 'interaction_requested' && event.toolCallId) {
          interactions[event.toolCallId] = { kind: event.payload && event.payload.kind, requested: event };
        }
        if (event.type === 'interaction_resolved' && event.toolCallId) {
          interactions[event.toolCallId] = Object.assign({}, interactions[event.toolCallId] || {}, {
            kind: interactions[event.toolCallId] && interactions[event.toolCallId].kind,
            resolved: event,
            answer: clone(event.payload && event.payload.answer),
          });
        }
      });
      plans.sort(function (left, right) { return left.sequence - right.sequence; });
      var pending = plans.filter(function (plan) { return !results[plan.toolCallId]; });
      if (!pending.length) return { action: 'resume_model', recoveredToolCalls: 0 };
      var snapshots = Object.create(null);
      var snapshotList = [];
      async function snapshotForPlan(plan) {
        if (typeof components.generationCore.toolDispatcher.createBatchSnapshot !== 'function') return null;
        var key = text(plan.modelRequestId) || 'request_without_id';
        if (snapshots[key]) return snapshots[key];
        snapshots[key] = await components.generationCore.toolDispatcher.createBatchSnapshot({
          conversationId: lease.conversationId,
          generationId: lease.generationId,
          modelRequestId: text(plan.modelRequestId),
          recovery: true,
        });
        snapshotList.push(snapshots[key]);
        return snapshots[key];
      }
      var recoveredCount = 0;
      try {
        for (var index = 0; index < pending.length; index += 1) {
          var plan = pending[index];
          var batchSnapshot = await snapshotForPlan(plan);
          var outcome = starts[plan.toolCallId]
            ? await reconcileStartedCall(components, lease, plan, starts[plan.toolCallId], interactions, batchSnapshot)
            : await dispatchRecoveredCall(components, lease, plan, batchSnapshot, false);
          recoveredCount += 1;
          if (outcome.state === 'unknown') {
            // 副作用未知：剩余恢复调用基于不可知状态，全部延后；但不终止 generation，
            // 交回模型观察实际资源状态后自行决策（提示词禁止重放 performed=unknown 的写操作）。
            for (var later = index + 1; later < pending.length; later += 1) {
              await deferRecoveredCall(lease, pending[later], 'SIDE_EFFECT_UNKNOWN', 'A prior recovered call has an unknown side-effect result');
            }
            recoveredCount += pending.length - index - 1;
            break;
          }
        }
      } finally {
        if (typeof components.generationCore.toolDispatcher.finishBatchSnapshot === 'function') {
          for (var snapshotIndex = 0; snapshotIndex < snapshotList.length; snapshotIndex += 1) {
            try { await components.generationCore.toolDispatcher.finishBatchSnapshot(snapshotList[snapshotIndex]); } catch (_) {}
          }
        }
      }
      var active = await lease.assertActive();
      if (active.state === 'cancelling') {
        await lease.finalize('cancelled', { payload: { reason: 'cancel_recovered', recoveredToolCalls: recoveredCount } });
        return { action: 'cancelled', terminal: true, recoveredToolCalls: recoveredCount };
      }
      return { action: 'resume_model', recoveredToolCalls: recoveredCount };
    }

    async function executeGeneration(input, lease) {
      var components = await createComponents(input, lease);
      await lease.assertActive();
      return components.loop.run(components.input, lease);
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      executeGeneration: executeGeneration,
      reconcileGeneration: reconcileGeneration,
      streamSink: streamSink,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    create: create,
    executeGeneration: function () { throw new Error('Use ConversationRuntime.create(...).executeGeneration'); },
    installResourceRuntime: installResourceRuntime,
    dispatchResource: dispatchResource,
    authorizeResourceRequest: function (input) { return deps.core.authorizeResourceRequest(input); },
    derivePermissionScope: function (runtime, assistant, ceiling) { return deps.core.derivePermissionScope(runtime, assistant, ceiling); },
  });
});
