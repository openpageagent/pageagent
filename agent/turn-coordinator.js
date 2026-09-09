// Durable single-writer generation coordinator. Runtime receives only a generation-scoped lease.
(function attachTurnCoordinator(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var protocol = commonJs ? require('./conversation-protocol') : root.ConversationProtocol;
  var api = factory(protocol);
  if (commonJs) module.exports = api;
  else root.TurnCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (protocol) {
  'use strict';

  var API_VERSION = 1;
  var STATES = Object.freeze([
    'idle', 'starting', 'running', 'waiting_user', 'cancelling',
    'completed', 'failed', 'cancelled', 'truncated', 'blocked',
  ]);
  var TERMINAL_STATES = Object.freeze({
    completed: true, failed: true, cancelled: true, truncated: true, blocked: true,
  });
  var TRANSITIONS = Object.freeze({
    starting: Object.freeze(['running', 'cancelling', 'failed', 'blocked']),
    running: Object.freeze(['waiting_user', 'cancelling', 'completed', 'failed', 'cancelled', 'truncated', 'blocked']),
    waiting_user: Object.freeze(['running', 'cancelling', 'blocked', 'cancelled']),
    cancelling: Object.freeze(['cancelled', 'blocked', 'failed']),
    completed: Object.freeze([]),
    failed: Object.freeze([]),
    cancelled: Object.freeze([]),
    truncated: Object.freeze([]),
    blocked: Object.freeze([]),
  });
  var TERMINAL_EVENT_TYPES = Object.freeze({
    completed: 'generation_completed',
    failed: 'generation_failed',
    cancelled: 'generation_cancelled',
    truncated: 'generation_truncated',
    blocked: 'generation_blocked',
  });
  var TERMINAL_EVENT_SET = Object.freeze({
    generation_completed: true, generation_failed: true, generation_cancelled: true,
    generation_truncated: true, generation_blocked: true,
  });

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function isRecord(value) { return !!(value && typeof value === 'object' && !Array.isArray(value)); }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function required(value, path) {
    var output = text(value);
    if (!output) throw coordinatorError('INVALID_COMMAND', path + ' is required');
    return output;
  }
  function coordinatorError(code, message, options) {
    options = options || {};
    if (protocol && protocol.ConversationProtocolError) return new protocol.ConversationProtocolError(code, message, options);
    var error = new Error(message || code);
    error.code = code;
    Object.assign(error, options);
    return error;
  }
  function isTerminal(state) { return TERMINAL_STATES[text(state)] === true; }
  function assertClosedGenerationBoundary(events, boundary) {
    var open = Object.create(null);
    events.slice(0, boundary).forEach(function (event) {
      var generationId = text(event && event.generationId);
      if (!generationId) return;
      if (event.type === 'generation_started') open[generationId] = true;
      else if (TERMINAL_EVENT_SET[event.type]) delete open[generationId];
    });
    var openIds = Object.keys(open);
    if (openIds.length) {
      throw coordinatorError('INVALID_FORK_BOUNDARY', 'Fork boundary falls inside an unfinished generation', {
        generationIds: openIds, boundarySequence: boundary,
      });
    }
  }
  function assertState(state) {
    state = text(state);
    if (STATES.indexOf(state) === -1) throw new TypeError('Unknown generation state: ' + state);
    return state;
  }
  function canTransition(from, to) {
    return !!(TRANSITIONS[from] && TRANSITIONS[from].indexOf(to) !== -1);
  }
  function defaultCounters(input, clock) {
    input = input || {};
    return {
      modelRequestCount: Math.max(0, Math.floor(Number(input.modelRequestCount) || 0)),
      loopIterationCount: Math.max(0, Math.floor(Number(input.loopIterationCount) || 0)),
      toolCallCount: Math.max(0, Math.floor(Number(input.toolCallCount) || 0)),
      summaryRequestCount: Math.max(0, Math.floor(Number(input.summaryRequestCount) || 0)),
      overflowRetryCount: Math.max(0, Math.floor(Number(input.overflowRetryCount) || 0)),
      startedAt: Math.max(0, Number(input.startedAt) || Number(clock())),
    };
  }

  function create(options) {
    options = options || {};
    var journal = options.journal;
    if (!journal || typeof journal.transaction !== 'function' || typeof journal.listActiveConversations !== 'function') {
      throw new TypeError('TurnCoordinator requires a ConversationJournalStore');
    }
    var executeGeneration = options.executeGeneration;
    if (typeof executeGeneration !== 'function') throw new TypeError('TurnCoordinator requires executeGeneration(input, lease)');
    var reconcileGeneration = typeof options.reconcileGeneration === 'function'
      ? options.reconcileGeneration
      : async function () { return { action: 'resume_model', terminal: false }; };
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : function (prefix) { nextId += 1; return prefix + '_' + Number(clock()).toString(36) + '_' + nextId.toString(36); };
    var coordinatorInstanceId = text(options.runtimeInstanceId) || idGenerator('runtime');
    var schedule = typeof options.schedule === 'function'
      ? options.schedule
      : function (callback) { Promise.resolve().then(callback); };
    var setTimer = typeof options.setTimer === 'function' ? options.setTimer
      : (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer
      : (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    var createAbortController = typeof options.createAbortController === 'function'
      ? options.createAbortController
      : function () { return new AbortController(); };
    var authorizeInteractionSurface = typeof options.authorizeInteractionSurface === 'function'
      ? options.authorizeInteractionSurface
      : function (surface) { return !!(surface && ['options', 'page'].indexOf(surface.type) !== -1); };
    var faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : null;
    var recordingAttachments = options.recordingAttachments || null;
    var endPageGeneration = typeof options.endPageGeneration === 'function' ? options.endPageGeneration : null;
    var journalMaterializer = options.journalMaterializer || {
      getAllEvents: function (conversationId) { return journal.getAllEvents(conversationId); },
    };
    var abortControllers = Object.create(null);
    var modelRequestControllers = Object.create(null);
    var interactionWaiters = Object.create(null);
    var interactionTimers = Object.create(null);
    var launched = Object.create(null);

    function inject(point, details) {
      if (!faultInjector) return;
      var result = faultInjector(point, clone(details || {}));
      if (result instanceof Error) throw result;
      if (result === true) {
        var error = new Error('Injected MV3 service-worker termination');
        error.name = 'ServiceWorkerTermination';
        error.code = 'SERVICE_WORKER_TERMINATED';
        error.details = { point: point };
        error.faultPoint = point;
        throw error;
      }
    }

    function runtimeKey(conversationId, generationId) { return conversationId + '\n' + generationId; }
    function modelRequestKey(conversationId, generationId) { return runtimeKey(conversationId, generationId); }

    function closeModelRequest(entry) {
      if (!entry || entry.closed) return;
      entry.closed = true;
      if (entry.parentSignal && entry.parentListener
          && typeof entry.parentSignal.removeEventListener === 'function') {
        entry.parentSignal.removeEventListener('abort', entry.parentListener);
      }
      if (modelRequestControllers[entry.key] === entry) delete modelRequestControllers[entry.key];
    }

    function openModelRequest(lease, modelRequestId) {
      var key = modelRequestKey(lease.conversationId, lease.generationId);
      var previous = modelRequestControllers[key];
      if (previous) closeModelRequest(previous);
      var controller = createAbortController();
      var entry = {
        key: key,
        modelRequestId: text(modelRequestId),
        controller: controller,
        parentSignal: lease.signal || null,
        parentListener: null,
        interruptCode: '',
        closed: false,
      };
      if (entry.parentSignal && typeof entry.parentSignal.addEventListener === 'function') {
        entry.parentListener = function () {
          if (controller.signal.aborted) return;
          try { controller.abort(entry.parentSignal.reason || 'cancelled'); }
          catch (_) { controller.abort(); }
        };
        if (entry.parentSignal.aborted) entry.parentListener();
        else entry.parentSignal.addEventListener('abort', entry.parentListener, { once: true });
      }
      modelRequestControllers[key] = entry;
      return Object.freeze({
        signal: controller.signal,
        close: function () { closeModelRequest(entry); },
        interruptedByUser: function () { return entry.interruptCode === 'MODEL_REQUEST_INTERRUPTED'; },
      });
    }

    function abortActiveModelRequest(conversationId, generationId) {
      var entry = modelRequestControllers[modelRequestKey(conversationId, generationId)];
      if (!entry || entry.closed || entry.controller.signal.aborted) return false;
      var error = generationError(
        'MODEL_REQUEST_INTERRUPTED',
        'Current model request was interrupted to process pending user messages',
        conversationId,
        generationId
      );
      entry.interruptCode = error.code;
      try { entry.controller.abort(error); } catch (_) { entry.controller.abort(); }
      return true;
    }
    function interactionKey(conversationId, generationId, interactionId) {
      return conversationId + '\n' + generationId + '\n' + interactionId;
    }
    function clearInteractionTimer(conversationId, generationId, interactionId) {
      var key = interactionKey(conversationId, generationId, interactionId);
      if (!hasOwn(interactionTimers, key)) return;
      try { clearTimer(interactionTimers[key]); } catch (_) {}
      delete interactionTimers[key];
    }
    function settleInteractionWaiter(conversationId, generationId, interactionId, method, value) {
      var key = interactionKey(conversationId, generationId, interactionId);
      var waiter = interactionWaiters[key];
      if (!waiter) return false;
      delete interactionWaiters[key];
      if (waiter.signal && waiter.abortHandler && typeof waiter.signal.removeEventListener === 'function') {
        waiter.signal.removeEventListener('abort', waiter.abortHandler);
      }
      waiter[method](value);
      return true;
    }
    function discardInteractionWaiter(conversationId, generationId, interactionId) {
      var key = interactionKey(conversationId, generationId, interactionId);
      var waiter = interactionWaiters[key];
      if (!waiter) return false;
      delete interactionWaiters[key];
      if (waiter.signal && waiter.abortHandler && typeof waiter.signal.removeEventListener === 'function') {
        waiter.signal.removeEventListener('abort', waiter.abortHandler);
      }
      return true;
    }
    async function endGenerationResources(conversationId, generationId, turnId) {
      // The terminal CAS is authoritative. Cleanup is idempotent and reconciled
      // independently, so cleanup failure cannot rewrite a completed generation.
      if (endPageGeneration) {
        try {
          await endPageGeneration({
            conversationId: conversationId, generationId: generationId, turnId: turnId,
          });
        } catch (_) {}
      }
      if (recordingAttachments && typeof recordingAttachments.endGeneration === 'function') {
        try { await recordingAttachments.endGeneration(generationId); } catch (_) {}
      }
    }
    function generationError(code, message, conversationId, generationId, details) {
      return coordinatorError(code, message, {
        conversationId: conversationId,
        generationId: generationId,
        details: details,
      });
    }
    async function generationInput(conversationId, generationId) {
      var events = await journalMaterializer.getAllEvents(conversationId);
      var started = events.find(function (event) {
        return event.type === 'generation_started' && event.generationId === generationId;
      });
      var user = events.find(function (event) {
        return event.type === 'user_message_appended' && event.generationId === generationId;
      });
      if (!started) throw generationError('GENERATION_STALE', 'generation_started event is missing', conversationId, generationId);
      var payload = started.payload || {};
      return {
        schemaVersion: 1,
        commandId: payload.commandId,
        conversationId: conversationId,
        assistantId: payload.assistantId,
        serviceId: payload.serviceId,
        message: clone(user && user.payload && user.payload.message || payload.message || {}),
        surface: clone(payload.surface || {}),
        entry: clone(payload.entry || {}),
        budgets: clone(payload.budgets || {}),
        preferences: clone(payload.preferences || {}),
        lineage: clone(payload.lineage || { branchId: text(started.branchId || 'main') }),
        requestedAt: Number(payload.requestedAt) || 0,
      };
    }

    async function guardedTransaction(conversationId, generationId, runtimeInstanceId, operation) {
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var metadata = await tx.getMetadata();
        var active = metadata && metadata.activeGeneration;
        if (!active || active.generationId !== generationId
            || runtimeInstanceId && active.runtimeInstanceId !== runtimeInstanceId) {
          tx.append({
            type: 'stale_callback_rejected',
            generationId: generationId,
            payload: {
              expectedGenerationId: generationId,
              activeGenerationId: active && active.generationId || '',
              expectedRuntimeInstanceId: runtimeInstanceId || '',
              activeRuntimeInstanceId: active && active.runtimeInstanceId || '',
            },
          });
          return { stale: true, active: clone(active || null) };
        }
        return operation(tx, metadata, clone(active));
      });
      if (outcome && outcome.stale) {
        throw generationError('GENERATION_STALE', 'Generation lease is no longer active', conversationId, generationId, outcome);
      }
      return outcome;
    }

    async function compareAndSet(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var generationId = required(input.expectedGenerationId || input.generationId, 'generationId');
      var runtimeInstanceId = text(input.runtimeInstanceId);
      var allowedStates = Array.isArray(input.allowedStates) ? input.allowedStates.map(assertState) : [];
      var nextState = assertState(input.nextState);
      return guardedTransaction(conversationId, generationId, runtimeInstanceId, function (tx, metadata, active) {
        if (allowedStates.length && allowedStates.indexOf(active.state) === -1) {
          return { invalidState: true, active: active };
        }
        if (active.state !== nextState && !canTransition(active.state, nextState)) {
          return { invalidTransition: true, active: active };
        }
        // 完成判定与追加指令共用同一 Journal 写锁：只要模型取上下文后又有
        // steering 被接受，本次终态提交就让位给下一次模型请求，避免丢指令。
        if (input.expectedSteeringRevision !== undefined
            && Math.max(0, Math.floor(Number(active.steeringRevision) || 0))
              !== Math.max(0, Math.floor(Number(input.expectedSteeringRevision) || 0))) {
          return { pendingSteering: true, active: active };
        }
        var previousState = active.state;
        active = Object.assign({}, active, clone(input.patch || {}), {
          generationId: generationId,
          state: nextState,
          leaseUpdatedAt: Number(clock()),
        });
        if (isTerminal(nextState)) active.completedAt = Number(clock());
        if (isTerminal(nextState)) active.pendingInteraction = null;
        tx.patchMetadata({ activeGeneration: active });
        if (previousState !== nextState) {
          tx.append({
            type: 'generation_state_changed', generationId: generationId, turnId: active.turnId, branchId: active.branchId,
            payload: { from: previousState, to: nextState, reason: text(input.reason) },
          });
        }
        if (input.event) tx.append(Object.assign({ generationId: generationId, turnId: active.turnId, branchId: active.branchId }, clone(input.event)));
        return { state: nextState, generationId: generationId, turnId: active.turnId, activeGeneration: active };
      }).then(function (result) {
        if (result && result.invalidState) {
          throw generationError('GENERATION_STALE', 'Generation is not in an allowed state', conversationId, generationId, {
            state: result.active.state, allowedStates: allowedStates,
          });
        }
        if (result && result.invalidTransition) {
          throw generationError('GENERATION_STALE', 'Generation transition is not allowed', conversationId, generationId, {
            from: result.active.state, to: nextState,
          });
        }
        return result;
      });
    }

    async function guardedAppend(lease, event) {
      return guardedTransaction(lease.conversationId, lease.generationId, lease.runtimeInstanceId, function (tx, metadata, active) {
        if (isTerminal(active.state)) return { terminal: true, active: active };
        tx.append(Object.assign({ generationId: lease.generationId, turnId: lease.turnId, branchId: lease.branchId }, clone(event || {})));
        return { appended: true, state: active.state };
      }).then(function (result) {
        if (result && result.terminal) throw generationError('GENERATION_STALE', 'Terminal generation cannot append runtime facts', lease.conversationId, lease.generationId);
        return result;
      });
    }

    async function guardedAppendMany(lease, events) {
      if (!Array.isArray(events)) throw new TypeError('lease.appendMany requires an event array');
      if (!events.length) return { appended: 0 };
      return guardedTransaction(lease.conversationId, lease.generationId, lease.runtimeInstanceId, function (tx, metadata, active) {
        if (isTerminal(active.state)) return { terminal: true, active: active };
        tx.appendMany(events.map(function (event) {
          return Object.assign({ generationId: lease.generationId, turnId: lease.turnId, branchId: lease.branchId }, clone(event || {}));
        }));
        return { appended: events.length, state: active.state };
      }).then(function (result) {
        if (result && result.terminal) throw generationError('GENERATION_STALE', 'Terminal generation cannot append runtime facts', lease.conversationId, lease.generationId);
        return result;
      });
    }

    async function updateLease(lease, patch, event) {
      return guardedTransaction(lease.conversationId, lease.generationId, lease.runtimeInstanceId, function (tx, metadata, active) {
        if (isTerminal(active.state)) return { terminal: true, active: active };
        var next = Object.assign({}, active, clone(patch || {}), { leaseUpdatedAt: Number(clock()) });
        if (patch && patch.counters) next.counters = defaultCounters(Object.assign({}, active.counters || {}, patch.counters), clock);
        tx.patchMetadata({ activeGeneration: next });
        if (event) tx.append(Object.assign({ generationId: lease.generationId, turnId: lease.turnId, branchId: lease.branchId }, clone(event)));
        return { activeGeneration: next };
      }).then(function (result) {
        if (result && result.terminal) throw generationError('GENERATION_STALE', 'Terminal generation cannot update its lease', lease.conversationId, lease.generationId);
        return result;
      });
    }

    async function commitModelRequest(lease, input) {
      input = input || {};
      var expectedSteeringRevision = Math.max(0, Math.floor(Number(input.expectedSteeringRevision) || 0));
      var steeringMessages = Array.isArray(input.steeringMessages) ? input.steeringMessages : [];
      return guardedTransaction(lease.conversationId, lease.generationId, lease.runtimeInstanceId, function (tx, metadata, active) {
        if (isTerminal(active.state)) return { terminal: true, active: active };
        var currentSteeringRevision = Math.max(0, Math.floor(Number(active.steeringRevision) || 0));
        if (currentSteeringRevision !== expectedSteeringRevision) {
          return { pendingSteering: true, activeGeneration: active };
        }
        var interruptRevision = Math.max(0, Math.floor(Number(active.interruptRevision) || 0));
        var consumedSteeringRevision = Math.max(0, Math.floor(Number(active.consumedSteeringRevision) || 0));
        var expectedMessages = Math.max(0, expectedSteeringRevision - consumedSteeringRevision);
        if (steeringMessages.length !== expectedMessages) {
          throw generationError('STEERING_STATE_INVALID', 'Steering message projection does not match the active revision', lease.conversationId, lease.generationId, {
            expectedSteeringRevision: expectedSteeringRevision,
            consumedSteeringRevision: consumedSteeringRevision,
            messageCount: steeringMessages.length,
          });
        }
        var counters = defaultCounters(active.counters || {}, clock);
        counters.modelRequestCount = Math.max(0, Number(counters.modelRequestCount) || 0) + 1;
        var next = Object.assign({}, active, {
          counters: counters,
          consumedSteeringRevision: expectedSteeringRevision,
          leaseUpdatedAt: Number(clock()),
        });
        tx.patchMetadata({ activeGeneration: next });
        if (steeringMessages.length) {
          tx.appendMany(steeringMessages.map(function (item) {
            return {
              type: 'steering_message_consumed',
              generationId: lease.generationId,
              turnId: lease.turnId,
              branchId: lease.branchId,
              modelRequestId: text(input.modelRequestId),
              payload: {
                commandId: text(item.commandId),
                sourceSequence: Math.max(0, Number(item.sequence) || 0),
                message: clone(item.message || {}),
              },
            };
          }));
        }
        tx.append({
          type: 'model_request_started',
          generationId: lease.generationId,
          turnId: lease.turnId,
          branchId: lease.branchId,
          modelRequestId: text(input.modelRequestId),
          payload: clone(input.payload || {}),
        });
        return { activeGeneration: next, counters: counters, interruptRevision: interruptRevision };
      }).then(function (result) {
        if (result && result.terminal) {
          throw generationError('GENERATION_STALE', 'Terminal generation cannot start a model request', lease.conversationId, lease.generationId);
        }
        return result;
      });
    }

    async function assertActive(lease) {
      var metadata = await journal.getMetadata(lease.conversationId);
      var active = metadata && metadata.activeGeneration;
      if (!active || active.generationId !== lease.generationId || active.runtimeInstanceId !== lease.runtimeInstanceId || isTerminal(active.state)) {
        throw generationError('GENERATION_STALE', 'Generation lease is no longer active', lease.conversationId, lease.generationId);
      }
      return clone(active);
    }

    async function requestInteraction(lease, input) {
      input = input || {};
      var surfaceType = lease.input.surface.type;
      if (surfaceType === 'sidepanel' || surfaceType === 'scheduled' || surfaceType === 'mcp') {
        await finalize(lease, 'blocked', {
          type: 'generation_blocked',
          payload: { status: 'blocked', reason: 'CAPABILITY_UNAVAILABLE', capability: input.kind || 'interaction' },
        });
        throw generationError('CAPABILITY_UNAVAILABLE', 'Non-interactive generations cannot wait for user interaction', lease.conversationId, lease.generationId);
      }
      var interactionId = text(input.interactionId) || idGenerator('interaction');
      var interaction = {
        interactionId: interactionId,
        conversationId: lease.conversationId,
        generationId: lease.generationId,
        turnId: lease.turnId,
        kind: 'user_input',
        toolCallId: text(input.toolCallId),
        status: 'pending',
        prompt: required(input.prompt, 'interaction.prompt'),
        options: Array.isArray(input.options) ? clone(input.options) : [],
        requestedAt: Number(input.requestedAt) || Number(clock()),
        expiresAt: Math.max(0, Number(input.expiresAt) || 0),
      };
      // Register the in-memory continuation before making the durable interaction
      // visible. Otherwise a fast RESOLVE_INTERACTION can commit between the CAS
      // and waiter registration and incorrectly launch a second recovery runtime.
      var waiterKey = interactionKey(lease.conversationId, lease.generationId, interactionId);
      var waitPromise = new Promise(function (resolve, reject) {
        var waiter = { resolve: resolve, reject: reject, signal: lease.signal, abortHandler: null };
        if (lease.signal && typeof lease.signal.addEventListener === 'function') {
          waiter.abortHandler = function () {
            var error = generationError('CANCELLED', 'Interaction wait was cancelled', lease.conversationId, lease.generationId, {
              interactionId: interactionId,
            });
            settleInteractionWaiter(lease.conversationId, lease.generationId, interactionId, 'reject', error);
          };
          lease.signal.addEventListener('abort', waiter.abortHandler, { once: true });
        }
        interactionWaiters[waiterKey] = waiter;
      });
      try {
        await compareAndSet({
          conversationId: lease.conversationId,
          expectedGenerationId: lease.generationId,
          runtimeInstanceId: lease.runtimeInstanceId,
          allowedStates: ['running'],
          nextState: 'waiting_user',
          reason: 'interaction_requested',
          patch: { pendingInteraction: interaction },
          event: {
            type: 'interaction_requested', interactionId: interactionId, toolCallId: interaction.toolCallId,
            payload: {
              kind: interaction.kind, prompt: interaction.prompt, options: interaction.options,
              expiresAt: interaction.expiresAt,
              toolCallId: interaction.toolCallId,
            },
          },
        });
        inject('after_interaction_requested', {
          conversationId: lease.conversationId,
          generationId: lease.generationId,
          interactionId: interactionId,
          toolCallId: interaction.toolCallId,
        });
        armInteractionExpiry(interaction);
      } catch (error) {
        discardInteractionWaiter(lease.conversationId, lease.generationId, interactionId);
        throw error;
      }
      return waitPromise;
    }

    async function expireInteraction(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var generationId = required(input.generationId, 'generationId');
      var interactionId = required(input.interactionId, 'interactionId');
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var metadata = await tx.getMetadata();
        var active = metadata.activeGeneration;
        if (!active || active.generationId !== generationId || isTerminal(active.state)) return { stale: true };
        var interaction = active.pendingInteraction;
        if (!interaction || interaction.interactionId !== interactionId
            || active.state !== 'waiting_user') return { stale: true };
        if (!interaction.expiresAt || Number(interaction.expiresAt) > Number(clock())) return { notDue: true };
        var previousState = active.state;
        var next = Object.assign({}, active, {
          state: 'blocked', pendingInteraction: null, inFlightTool: null,
          completedAt: Number(clock()), leaseUpdatedAt: Number(clock()),
        });
        tx.patchMetadata({ activeGeneration: next });
        var events = [];
        if (interaction.toolCallId) events.push({
          type: 'tool_execution_failed', generationId: generationId, turnId: active.turnId,
          interactionId: interactionId, toolCallId: text(interaction.toolCallId),
          modelRequestId: text(active.inFlightTool && active.inFlightTool.modelRequestId),
          payload: {
            name: text(active.inFlightTool && active.inFlightTool.method) || 'ASK_USER',
            errorCode: 'INTERACTION_EXPIRED', error: 'Interaction expired before it was resolved',
            performed: 'no', retryable: false,
          },
        });
        events.push({
          type: 'generation_state_changed', generationId: generationId, turnId: active.turnId,
          interactionId: interactionId,
          payload: { from: previousState, to: 'blocked', reason: 'INTERACTION_EXPIRED' },
        }, {
          type: 'generation_blocked', generationId: generationId, turnId: active.turnId,
          interactionId: interactionId,
          payload: { status: 'blocked', reason: 'INTERACTION_EXPIRED', interactionId: interactionId },
        });
        tx.appendMany(events);
        return { expired: true, active: next, interaction: clone(interaction) };
      });
      if (!outcome.expired) return outcome;
      await endGenerationResources(conversationId, generationId, outcome.active && outcome.active.turnId);
      clearInteractionTimer(conversationId, generationId, interactionId);
      var error = generationError('INTERACTION_EXPIRED', 'Interaction has expired', conversationId, generationId, {
        interactionId: interactionId,
      });
      settleInteractionWaiter(conversationId, generationId, interactionId, 'reject', error);
      return outcome;
    }

    function armInteractionExpiry(interaction) {
      if (!setTimer || !interaction || !interaction.expiresAt) return;
      var key = interactionKey(interaction.conversationId, interaction.generationId, interaction.interactionId);
      clearInteractionTimer(interaction.conversationId, interaction.generationId, interaction.interactionId);
      var delay = Math.max(0, Number(interaction.expiresAt) - Number(clock()));
      interactionTimers[key] = setTimer(function () {
        return expireInteraction(interaction).catch(function () {});
      }, delay);
    }

    async function consumeSteering(lease, afterSequence) {
      await assertActive(lease);
      var events = await journalMaterializer.getAllEvents(lease.conversationId);
      return events.filter(function (event) {
        return event.type === 'steering_message_appended' && event.generationId === lease.generationId
          && event.sequence > Math.max(0, Number(afterSequence) || 0);
      }).map(function (event) {
        return { sequence: event.sequence, commandId: event.payload.commandId, message: clone(event.payload.message) };
      });
    }

    async function finalize(lease, terminalState, event) {
      terminalState = assertState(terminalState);
      if (!isTerminal(terminalState)) throw new TypeError('finalize requires a terminal generation state');
      event = event || {};
      var expectedSteeringRevision = event.expectedSteeringRevision;
      var terminalEvent = Object.assign({}, clone(event), {
        type: event.type || TERMINAL_EVENT_TYPES[terminalState],
        payload: Object.assign({ status: terminalState }, clone(event.payload || {})),
      });
      delete terminalEvent.expectedSteeringRevision;
      inject('before_terminal_event', {
        conversationId: lease.conversationId,
        generationId: lease.generationId,
        state: terminalState,
      });
      var result = await compareAndSet({
        conversationId: lease.conversationId,
        expectedGenerationId: lease.generationId,
        runtimeInstanceId: lease.runtimeInstanceId,
        allowedStates: ['starting', 'running', 'waiting_user', 'cancelling'],
        nextState: terminalState,
        reason: text(terminalEvent.payload.reason),
        event: terminalEvent,
        expectedSteeringRevision: expectedSteeringRevision,
      });
      if (result && result.pendingSteering) return result;
      var keyPrefix = lease.conversationId + '\n' + lease.generationId + '\n';
      Object.keys(interactionWaiters).forEach(function (key) {
        if (key.indexOf(keyPrefix) !== 0) return;
        var waiter = interactionWaiters[key];
        delete interactionWaiters[key];
        waiter.reject(generationError(terminalState === 'cancelled' ? 'CANCELLED' : 'GENERATION_STALE', 'Interaction ended with generation', lease.conversationId, lease.generationId));
      });
      await endGenerationResources(lease.conversationId, lease.generationId, lease.turnId);
      return result;
    }

    function createLease(input, active, abortController) {
      var lease = {
        API_VERSION: API_VERSION,
        conversationId: input.conversationId,
        generationId: active.generationId,
        turnId: active.turnId,
        branchId: text(active.branchId || input.lineage && input.lineage.branchId || 'main'),
        lineage: clone(active.lineage || input.lineage || null),
        runtimeInstanceId: active.runtimeInstanceId,
        input: clone(input),
        signal: abortController.signal,
      };
      lease.assertActive = function () { return assertActive(lease); };
      lease.transition = function (expectedStates, nextState, event) {
        return compareAndSet({
          conversationId: lease.conversationId,
          expectedGenerationId: lease.generationId,
          runtimeInstanceId: lease.runtimeInstanceId,
          allowedStates: expectedStates,
          nextState: nextState,
          reason: event && event.reason,
          patch: event && event.patch,
          event: event && event.type ? event : null,
        });
      };
      lease.append = function (event) { return guardedAppend(lease, event); };
      lease.appendMany = function (events) { return guardedAppendMany(lease, events); };
      lease.update = function (patch, event) { return updateLease(lease, patch, event); };
      lease.openModelRequest = function (modelRequestId) { return openModelRequest(lease, modelRequestId); };
      lease.commitModelRequest = function (input) { return commitModelRequest(lease, input); };
      lease.requestInteraction = function (interaction) { return requestInteraction(lease, interaction); };
      lease.consumeSteering = function (afterSequence) { return consumeSteering(lease, afterSequence); };
      lease.finalize = function (terminalState, event) { return finalize(lease, terminalState, event); };
      return Object.freeze(lease);
    }

    async function acquireRuntimeLease(input, reason) {
      var conversationId = input.conversationId;
      var generationId = input.generationId || input.activeGeneration && input.activeGeneration.generationId;
      var freshRuntimeInstanceId = coordinatorInstanceId + ':' + idGenerator('lease');
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var metadata = await tx.getMetadata();
        var active = metadata && metadata.activeGeneration;
        if (!active || active.generationId !== generationId || isTerminal(active.state)) return { stale: true, active: clone(active || null) };
        var steeringRevision = Math.max(0, Math.floor(Number(active.steeringRevision) || 0));
        active = Object.assign({}, active, {
          runtimeInstanceId: freshRuntimeInstanceId,
          leaseUpdatedAt: Number(clock()),
          recoveryCount: Math.max(0, Number(active.recoveryCount) || 0) + (reason === 'recovery' ? 1 : 0),
          steeringRevision: steeringRevision,
          consumedSteeringRevision: Math.min(
            steeringRevision,
            Math.max(0, Math.floor(Number(active.consumedSteeringRevision) || 0))
          ),
          interruptRevision: Math.max(0, Math.floor(Number(active.interruptRevision) || 0)),
        });
        tx.patchMetadata({ activeGeneration: active });
        if (reason === 'recovery') tx.append({
          type: 'runtime_recovered', generationId: generationId, turnId: active.turnId,
          payload: { runtimeInstanceId: freshRuntimeInstanceId, recoveryCount: active.recoveryCount },
        });
        return { active: active };
      });
      if (outcome.stale) throw generationError('GENERATION_STALE', 'Cannot acquire runtime lease', conversationId, generationId);
      var key = runtimeKey(conversationId, generationId);
      var controller = createAbortController();
      abortControllers[key] = controller;
      return createLease(input, outcome.active, controller);
    }

    function launch(input, reason) {
      var key = runtimeKey(input.conversationId, input.generationId);
      if (launched[key]) return launched[key];
      var promise = (async function () {
        var lease = await acquireRuntimeLease(input, reason || 'start');
        if (lease.input.surface.type === 'sidepanel'
            || lease.input.surface.type === 'scheduled'
            || lease.input.surface.type === 'mcp') {
          // Non-interactive surfaces are never permitted to recover into a durable wait state.
          var activeBefore = await lease.assertActive();
          if (/^waiting_/.test(activeBefore.state)) {
            await lease.finalize('blocked', { payload: { reason: 'CAPABILITY_UNAVAILABLE' } });
            return;
          }
        }
        try {
          if (reason === 'recovery') {
            var reconciliation = await reconcileGeneration(clone(input), lease);
            if (reconciliation && reconciliation.terminal === true) return reconciliation;
          }
          var active = await lease.assertActive();
          if (active.state === 'starting') {
            await lease.transition(['starting'], 'running', { reason: reason || 'runtime_ready' });
          }
          if (active.state === 'cancelling') {
            await lease.finalize('cancelled', { payload: { reason: 'cancel_recovered' } });
            return;
          }
          await executeGeneration(clone(input), lease);
        } catch (error) {
          if (error && (error.code === 'GENERATION_STALE' || error.code === 'CANCELLED')) return;
          // A side effect may have happened while its receipt commit was interrupted.
          // Keep the durable generation and inFlightTool intact for ConversationRecovery;
          // terminalizing here would destroy the only reconciliation boundary.
          if (error && (error.code === 'RECOVERY_REQUIRED' || error.code === 'SERVICE_WORKER_TERMINATED')) return;
          try {
            await lease.finalize(lease.signal.aborted ? 'cancelled' : 'failed', {
              payload: {
                reason: lease.signal.aborted ? 'cancelled' : 'runtime_error',
                error: error && error.message || String(error),
              },
            });
          } catch (finalizeError) {
            if (!finalizeError || finalizeError.code !== 'GENERATION_STALE') throw finalizeError;
          }
        }
      })();
      launched[key] = promise.finally(function () {
        if (launched[key] === promise || launched[key] === tracked) delete launched[key];
        var controller = abortControllers[key];
        if (controller) delete abortControllers[key];
        var modelRequest = modelRequestControllers[key];
        if (modelRequest) closeModelRequest(modelRequest);
      });
      var tracked = launched[key];
      tracked.catch(function () {});
      return tracked;
    }

    async function startTurn(input, attachmentPrepared) {
      if (!isRecord(input)) throw coordinatorError('INVALID_COMMAND', 'StartTurnInput must be an object');
      var conversationId = required(input.conversationId, 'conversationId');
      var commandId = required(input.commandId, 'commandId');
      var generationId = idGenerator('generation');
      var turnId = idGenerator('turn');
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(commandId);
        if (duplicate) return { created: false, result: duplicate };
        var metadata = await tx.getMetadata();
        if (metadata.archived === true || metadata.deleted === true) {
          return { error: 'CONVERSATION_READ_ONLY', metadata: metadata };
        }
        if (metadata.assistantId && metadata.assistantId !== input.assistantId) {
          return { error: 'ASSISTANT_MISMATCH', metadata: metadata };
        }
        var current = metadata.activeGeneration;
        if (current && !isTerminal(current.state)) return { error: 'GENERATION_CONFLICT', active: current };
        var startedAt = Number(clock());
        var active = {
          generationId: generationId,
          turnId: turnId,
          branchId: text(input.lineage && input.lineage.branchId) || text(metadata.lineage && metadata.lineage.branchId) || 'main',
          lineage: clone(input.lineage || {
            branchId: text(metadata.lineage && metadata.lineage.branchId) || 'main',
            origin: 'user',
          }),
          state: 'starting',
          surface: clone(input.surface || {}),
          actorId: input.surface && input.surface.instanceId
            ? String(input.surface.type || 'surface') + ':' + String(input.surface.instanceId)
            : String(input.surface && input.surface.type || 'surface'),
          actorType: String(input.surface && input.surface.type || 'surface'),
          runtimeInstanceId: '',
          leaseUpdatedAt: 0,
          startedAt: startedAt,
          recoveryCount: 0,
          steeringRevision: 0,
          consumedSteeringRevision: 0,
          interruptRevision: 0,
          counters: defaultCounters({ startedAt: startedAt }, clock),
          pendingInteraction: null,
          inFlightTool: null,
        };
        var result = { generationId: generationId, turnId: turnId, state: 'starting' };
        tx.patchMetadata({
          assistantId: input.assistantId,
          serviceId: input.serviceId,
          lineage: Object.assign({}, clone(metadata.lineage || {}), clone(input.lineage || {}), {
            rootConversationId: text(metadata.lineage && metadata.lineage.rootConversationId) || conversationId,
            branchId: active.branchId,
          }),
          activeGeneration: active,
          createdAt: metadata.createdAt || startedAt,
          updatedAt: startedAt,
        });
        tx.appendMany([
          {
            type: 'user_message_appended', generationId: generationId, turnId: turnId, branchId: active.branchId,
            at: Number(input.requestedAt) || startedAt,
            payload: { message: clone(input.message), commandId: commandId },
          },
          {
            type: 'generation_started', generationId: generationId, turnId: turnId, branchId: active.branchId,
            payload: {
              surface: clone(input.surface), assistantId: input.assistantId, serviceId: input.serviceId,
              budgets: clone(input.budgets), preferences: clone(input.preferences), entry: clone(input.entry),
              commandId: commandId, requestedAt: Number(input.requestedAt) || 0,
              lineage: clone(input.lineage || { branchId: active.branchId, origin: 'user' }),
            },
          },
        ]);
        tx.putCommandResult(commandId, result);
        return { created: true, result: result };
      });
      if (outcome.created) inject('after_generation_started', {
        conversationId: conversationId,
        generationId: outcome.result.generationId,
        turnId: outcome.result.turnId,
      });
      if (outcome.error === 'ASSISTANT_MISMATCH') {
        throw generationError('ASSISTANT_MISMATCH', 'Conversation belongs to another assistant', conversationId, '', {
          expectedAssistantId: outcome.metadata.assistantId, receivedAssistantId: input.assistantId,
        });
      }
      if (outcome.error === 'CONVERSATION_READ_ONLY') {
        throw generationError('CONVERSATION_READ_ONLY', 'Archived or deleted Conversations cannot start a generation', conversationId, '');
      }
      if (outcome.error === 'GENERATION_CONFLICT') {
        throw generationError('GENERATION_CONFLICT', 'Conversation already has an active generation', conversationId, outcome.active.generationId, { state: outcome.active.state });
      }
      if (attachmentPrepared && attachmentPrepared.operation) {
        if (!recordingAttachments || typeof recordingAttachments.commitCommand !== 'function') {
          throw generationError('CAPABILITY_UNAVAILABLE', 'Recording attachment promotion is unavailable', conversationId, outcome.result.generationId);
        }
        await recordingAttachments.commitCommand(attachmentPrepared, outcome.result.generationId);
      }
      if (outcome.created) {
        var runtimeInput = Object.assign({}, clone(input), {
          generationId: outcome.result.generationId,
          turnId: outcome.result.turnId,
        });
        schedule(function () { return launch(runtimeInput, 'start'); });
      }
      return clone(outcome.result);
    }

    async function cancelGeneration(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var generationId = required(input.generationId, 'generationId');
      var metadata = await journal.getMetadata(conversationId);
      var active = metadata && metadata.activeGeneration;
      if (!active || active.generationId !== generationId) throw generationError('GENERATION_STALE', 'Generation is not active', conversationId, generationId);
      if (isTerminal(active.state)) return { generationId: generationId, state: active.state };
      if (active.state !== 'cancelling') {
        await compareAndSet({
          conversationId: conversationId, expectedGenerationId: generationId,
          allowedStates: ['starting', 'running', 'waiting_user'],
          nextState: 'cancelling', reason: text(input.reason) || 'cancel_requested',
          event: { type: 'cancellation_requested', payload: { reason: text(input.reason) } },
        });
      }
      var controller = abortControllers[runtimeKey(conversationId, generationId)];
      if (controller && !controller.signal.aborted) controller.abort(text(input.reason) || 'cancelled');
      metadata = await journal.getMetadata(conversationId);
      active = metadata.activeGeneration;
      if (!active.inFlightTool) {
        var syntheticLease = createLease(await generationInput(conversationId, generationId), active, controller || createAbortController());
        await finalize(syntheticLease, 'cancelled', { payload: { reason: text(input.reason) || 'cancelled' } });
        return { generationId: generationId, state: 'cancelled' };
      }
      return { generationId: generationId, state: 'cancelling' };
    }

    async function steerGeneration(input, attachmentPrepared) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var generationId = required(input.generationId, 'generationId');
      var commandId = required(input.commandId, 'commandId');
      var eventId = idGenerator('event');
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(commandId);
        if (duplicate) return { duplicate: true, result: duplicate };
        var metadata = await tx.getMetadata();
        var active = metadata.activeGeneration;
        if (!active || active.generationId !== generationId || isTerminal(active.state)) return { stale: true, active: clone(active || null) };
        var result = { eventId: eventId, generationId: generationId, accepted: true };
        active = Object.assign({}, active, {
          steeringRevision: Math.max(0, Math.floor(Number(active.steeringRevision) || 0)) + 1,
          leaseUpdatedAt: Number(clock()),
        });
        tx.patchMetadata({ activeGeneration: active });
        tx.append({
          eventId: eventId, type: 'steering_message_appended', generationId: generationId, turnId: active.turnId,
          payload: { commandId: commandId, message: clone(input.message) },
        });
        tx.putCommandResult(commandId, result);
        return { result: result };
      });
      if (outcome.stale) throw generationError('GENERATION_STALE', 'Cannot steer a terminal or stale generation', conversationId, generationId);
      if (attachmentPrepared && attachmentPrepared.operation) {
        if (!recordingAttachments || typeof recordingAttachments.commitCommand !== 'function') {
          throw generationError('CAPABILITY_UNAVAILABLE', 'Recording attachment promotion is unavailable', conversationId, generationId);
        }
        await recordingAttachments.commitCommand(attachmentPrepared, generationId);
      }
      return clone(outcome.result);
    }

    async function interruptModelRequest(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var generationId = required(input.generationId, 'generationId');
      var commandId = required(input.commandId, 'commandId');
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(commandId);
        if (duplicate) return { duplicate: true, result: duplicate };
        var metadata = await tx.getMetadata();
        var active = metadata.activeGeneration;
        if (!active || active.generationId !== generationId || isTerminal(active.state)) {
          return { stale: true, active: clone(active || null) };
        }
        var steeringRevision = Math.max(0, Math.floor(Number(active.steeringRevision) || 0));
        var consumedSteeringRevision = Math.max(0, Math.floor(Number(active.consumedSteeringRevision) || 0));
        if (steeringRevision <= consumedSteeringRevision) {
          var alreadyProcessing = { generationId: generationId, accepted: true, alreadyProcessing: true };
          tx.putCommandResult(commandId, alreadyProcessing);
          return { result: alreadyProcessing, alreadyProcessing: true };
        }
        var result = { generationId: generationId, accepted: true };
        active = Object.assign({}, active, {
          interruptRevision: Math.max(0, Math.floor(Number(active.interruptRevision) || 0)) + 1,
          leaseUpdatedAt: Number(clock()),
        });
        tx.patchMetadata({ activeGeneration: active });
        tx.append({
          type: 'model_request_interrupt_requested', generationId: generationId, turnId: active.turnId,
          payload: { commandId: commandId, steeringRevision: steeringRevision },
        });
        tx.putCommandResult(commandId, result);
        return { result: result };
      });
      if (outcome.stale) {
        throw generationError('GENERATION_STALE', 'Cannot interrupt a terminal or stale generation', conversationId, generationId);
      }
      var interrupted = !outcome.duplicate && !outcome.alreadyProcessing
        && abortActiveModelRequest(conversationId, generationId);
      return Object.assign({}, clone(outcome.result), { interrupted: interrupted });
    }

    async function resolveInteraction(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var generationId = required(input.generationId, 'generationId');
      var interactionId = required(input.interactionId, 'interactionId');
      if (!authorizeInteractionSurface(input.surface || {}, input)) {
        throw generationError('CAPABILITY_UNAVAILABLE', 'This surface cannot resolve conversation interactions', conversationId, generationId);
      }
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var metadata = await tx.getMetadata();
        var active = metadata.activeGeneration;
        if (!active || active.generationId !== generationId || isTerminal(active.state)) return { stale: true, active: clone(active || null) };
        var interaction = active.pendingInteraction;
        if (!interaction || interaction.interactionId !== interactionId) return { missing: true, active: active };
        if (interaction.expiresAt && Number(interaction.expiresAt) <= Number(clock())) return { expired: true, active: active };
        if (active.state !== 'waiting_user') return { missing: true, active: active };
        var next = Object.assign({}, active, { state: 'running', pendingInteraction: null, leaseUpdatedAt: Number(clock()) });
        tx.patchMetadata({ activeGeneration: next });
        tx.appendMany([
          {
            type: 'interaction_resolved', generationId: generationId, turnId: active.turnId,
            interactionId: interactionId, toolCallId: text(interaction.toolCallId),
            payload: { responderSurface: clone(input.surface || {}), answer: clone(input.answer) },
          },
          {
            type: 'generation_state_changed', generationId: generationId, turnId: active.turnId,
            payload: { from: active.state, to: 'running', reason: 'interaction_resolved' },
          },
        ]);
        return { resolved: true, active: next, answer: clone(input.answer), kind: interaction.kind };
      });
      if (outcome.stale) throw generationError('GENERATION_STALE', 'Interaction generation is stale', conversationId, generationId);
      if (outcome.expired) {
        await expireInteraction({ conversationId: conversationId, generationId: generationId, interactionId: interactionId });
        throw generationError('INTERACTION_EXPIRED', 'Interaction has expired', conversationId, generationId, { interactionId: interactionId });
      }
      if (outcome.missing) throw generationError('INTERACTION_NOT_FOUND', 'Pending interaction was not found', conversationId, generationId, { interactionId: interactionId });
      clearInteractionTimer(conversationId, generationId, interactionId);
      var resolvedWaiter = settleInteractionWaiter(conversationId, generationId, interactionId, 'resolve', {
        interactionId: interactionId, kind: outcome.kind, answer: clone(outcome.answer),
      });
      if (!resolvedWaiter) {
        var recoveredInput = await generationInput(conversationId, generationId);
        recoveredInput.generationId = generationId;
        recoveredInput.turnId = outcome.active.turnId;
        schedule(function () { return launch(recoveredInput, 'recovery'); });
      }
      return { generationId: generationId, interactionId: interactionId, state: 'running' };
    }

    async function appendSubagentCompletion(conversationId, dedupKey, event) {
      if (typeof journal.transaction !== 'function') return journal.append(conversationId, event).then(function () { return true; });
      return journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(dedupKey);
        if (duplicate) return false;
        tx.append(event);
        tx.putCommandResult(dedupKey, { completed: true, subagentId: text(event.subagentId || event.payload && event.payload.subagentId) });
        return true;
      });
    }

    async function appendSubagentEventOnce(conversationId, dedupKey, event) {
      if (typeof journal.transaction !== 'function') return journal.append(conversationId, event).then(function () { return true; });
      return journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(dedupKey);
        if (duplicate) return false;
        tx.append(event);
        tx.putCommandResult(dedupKey, { recorded: true, eventType: text(event && event.type) });
        return true;
      });
    }

    async function markSubagentStarted(conversationId, commandId, event, result) {
      if (typeof journal.transaction !== 'function') {
        await journal.append(conversationId, event);
        return result;
      }
      return journal.transaction(conversationId, 'readwrite', async function (tx) {
        var current = await tx.getCommandResult(commandId);
        if (current && current.state === 'started') return current;
        tx.append(event);
        tx.putCommandResult(commandId, result);
        return result;
      });
    }

    async function reconcileSubagentCompletions() {
      if (typeof journal.listMetadata !== 'function') return [];
      var metadataList = await journal.listMetadata();
      var repaired = [];
      for (var index = 0; index < metadataList.length; index += 1) {
        var parent = metadataList[index];
        var parentConversationId = parent && parent.conversationId;
        if (!parentConversationId) continue;
        var events;
        try { events = await journal.getAllEvents(parentConversationId); } catch (_) { continue; }
        var candidateMap = Object.create(null);
        events.forEach(function (event) {
          if ((event.type !== 'subagent_started' && event.type !== 'subagent_scheduled') || !event.payload) return;
          if (!event.payload.childConversationId) return;
          var key = text(event.payload.subagentId || event.subagentId) + '\n' + text(event.payload.childConversationId);
          // Prefer the started event because it carries the child generation id.
          if (!candidateMap[key] || event.type === 'subagent_started') candidateMap[key] = event;
        });
        var starts = Object.keys(candidateMap).map(function (key) { return candidateMap[key]; });
        for (var startIndex = 0; startIndex < starts.length; startIndex += 1) {
          var started = starts[startIndex];
          var childConversationId = text(started.payload.childConversationId);
          var subagentId = text(started.payload.subagentId || started.subagentId);
          var childMetadata;
          try { childMetadata = await journal.getMetadata(childConversationId); } catch (_) { childMetadata = null; }
          var childActive = childMetadata && childMetadata.activeGeneration;
          var childGenerationId = text(started.payload.childGenerationId || childActive && childActive.generationId);
          if (!childGenerationId || !childActive || !isTerminal(childActive.state)) continue;
          var alreadyCompleted = events.some(function (event) {
            return event.type === 'subagent_completed'
              && text(event.subagentId || event.payload && event.payload.subagentId) === subagentId
              && text(event.payload && event.payload.childGenerationId) === childGenerationId;
          });
          if (alreadyCompleted) continue;
          var payload = {
            subagentId: subagentId, childConversationId: childConversationId,
            childGenerationId: childGenerationId, state: childActive.state,
          };
          await appendSubagentCompletion(parentConversationId, 'subagent_completion:' + parentConversationId + ':' + subagentId + ':' + childGenerationId, {
            type: 'subagent_completed', generationId: text(started.generationId),
            turnId: text(started.turnId), branchId: text(started.branchId) || 'main',
            causationId: childGenerationId, subagentId: subagentId, payload: payload,
          }).catch(function () {});
          var childEvents;
          try { childEvents = await journal.getAllEvents(childConversationId); } catch (_) { childEvents = []; }
          var childAlreadyCompleted = childEvents.some(function (event) {
            return event.type === 'subagent_completed'
              && text(event.subagentId || event.payload && event.payload.subagentId) === subagentId;
          });
          if (!childAlreadyCompleted) {
            await appendSubagentCompletion(childConversationId, 'subagent_completion:' + childConversationId + ':' + subagentId + ':' + childGenerationId, {
              type: 'subagent_completed', generationId: childGenerationId,
              turnId: text(childActive.turnId), branchId: text(childActive.branchId || childMetadata.lineage && childMetadata.lineage.branchId) || text(started.payload.childBranchId) || 'main',
              causationId: text(started.generationId), subagentId: subagentId, payload: payload,
            }).catch(function () {});
          }
          repaired.push({ parentConversationId: parentConversationId, childConversationId: childConversationId, subagentId: subagentId, state: childActive.state });
        }
      }
      return repaired;
    }

    async function recoverActiveGenerations() {
      var repairedSubagents = await reconcileSubagentCompletions();
      var activeConversations = await journal.listActiveConversations();
      var results = repairedSubagents.map(function (item) { return Object.assign({ action: 'reconcile_subagent' }, item); });
      for (var index = 0; index < activeConversations.length; index += 1) {
        var metadata = activeConversations[index];
        var active = metadata.activeGeneration;
        if (!active || isTerminal(active.state)) continue;
        if (active.state === 'waiting_user') {
          if (active.pendingInteraction && active.pendingInteraction.expiresAt
              && Number(active.pendingInteraction.expiresAt) <= Number(clock())) {
            await expireInteraction({
              conversationId: metadata.conversationId,
              generationId: active.generationId,
              interactionId: active.pendingInteraction.interactionId,
            });
            results.push({ conversationId: metadata.conversationId, generationId: active.generationId, state: 'blocked', action: 'expire_interaction' });
            continue;
          }
          if (active.pendingInteraction) armInteractionExpiry(active.pendingInteraction);
          results.push({ conversationId: metadata.conversationId, generationId: active.generationId, state: active.state, action: 'restore_interaction' });
          continue;
        }
        var input = await generationInput(metadata.conversationId, active.generationId);
        input.generationId = active.generationId;
        input.turnId = active.turnId;
        schedule(function (runtimeInput) { return function () { return launch(runtimeInput, 'recovery'); }; }(input));
        results.push({ conversationId: metadata.conversationId, generationId: active.generationId, state: active.state, action: 'resume' });
      }
      return results;
    }

    async function getSnapshot(conversationId) {
      var metadata = await journal.getMetadata(required(conversationId, 'conversationId'));
      if (!metadata) throw coordinatorError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', { conversationId: conversationId });
      return {
        conversationId: conversationId,
        assistantId: metadata.assistantId,
        serviceId: metadata.serviceId,
        lastSequence: metadata.lastSequence,
        activeGeneration: clone(metadata.activeGeneration),
        lineage: clone(metadata.lineage || null),
      };
    }

    async function forkConversation(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var commandId = required(input.commandId, 'commandId');
      var sourceEvents;
      try { sourceEvents = await journal.getAllEvents(conversationId); }
      catch (error) {
        if (error && error.code === 'CONVERSATION_NOT_FOUND') throw coordinatorError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', { conversationId: conversationId });
        throw error;
      }
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(commandId);
        if (duplicate) return { duplicate: true, result: duplicate };
        var metadata = await tx.getMetadata();
        if (!metadata) return { missing: true };
        if (Number(metadata.lastSequence) !== sourceEvents.length) {
          return { sourceChanged: true, lastSequence: Number(metadata.lastSequence) || 0 };
        }
        var boundary = input.boundarySequence === undefined ? sourceEvents.length : Number(input.boundarySequence);
        if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > sourceEvents.length) return { invalidBoundary: true, lastSequence: sourceEvents.length };
        try { assertClosedGenerationBoundary(sourceEvents, boundary); }
        catch (error) { return { invalidBoundary: true, lastSequence: sourceEvents.length, boundaryError: error }; }
        var branchId = text(input.branchId) || idGenerator('branch');
        var parentBranchId = text(metadata.lineage && metadata.lineage.branchId) || 'main';
        var branches = Array.isArray(metadata.lineage && metadata.lineage.branches) ? metadata.lineage.branches.slice() : [];
        if (branches.some(function (branch) { return branch.branchId === branchId; })) return { existingBranch: true, branchId: branchId };
        branches.push({ branchId: branchId, parentBranchId: parentBranchId, forkSequence: boundary, createdAt: Number(clock()) });
        tx.patchMetadata({ lineage: Object.assign({}, clone(metadata.lineage || {}), { branchId: branchId, branches: branches }) });
        var result = { conversationId: conversationId, branchId: branchId, boundarySequence: boundary, accepted: true };
        tx.append({
          type: 'conversation_forked', branchId: branchId, causationId: text(input.causationId), correlationId: text(input.correlationId),
          actorId: text(input.actorId), actorType: text(input.actorType),
          payload: { sourceConversationId: conversationId, sourceSequence: boundary, parentBranchId: parentBranchId, reason: text(input.reason) || 'fork' },
        });
        tx.putCommandResult(commandId, result);
        return { result: result };
      });
      if (outcome.duplicate) return clone(outcome.result);
      if (outcome.missing) throw coordinatorError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', { conversationId: conversationId });
      if (outcome.sourceChanged) throw coordinatorError('JOURNAL_CAS_CONFLICT', 'Conversation changed while preparing the fork', {
        conversationId: conversationId,
        details: { expectedLastSequence: sourceEvents.length, actualLastSequence: outcome.lastSequence },
      });
      if (outcome.invalidBoundary) {
        if (outcome.boundaryError) throw outcome.boundaryError;
        throw coordinatorError('INVALID_FORK_BOUNDARY', 'Fork boundary is outside the Journal', { conversationId: conversationId, lastSequence: outcome.lastSequence });
      }
      if (outcome.existingBranch) throw coordinatorError('INVALID_FORK_BOUNDARY', 'Branch already exists: ' + outcome.branchId, { conversationId: conversationId, branchId: outcome.branchId });
      return clone(outcome.result);
    }

    async function scheduleSubagent(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var commandId = required(input.commandId, 'commandId');
      var parentGenerationId = required(input.parentGenerationId, 'parentGenerationId');
      var outcome = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var duplicate = await tx.getCommandResult(commandId);
        if (duplicate) return { duplicate: true, result: duplicate };
        var metadata = await tx.getMetadata();
        var active = metadata && metadata.activeGeneration;
        if (!active || active.generationId !== parentGenerationId || isTerminal(active.state)) return { stale: true, active: active };
        var inheritedDepth = Math.max(
          0,
          Number(metadata.lineage && metadata.lineage.delegationDepth) || 0,
          Number(input.delegationDepth) || 0
        );
        var depth = inheritedDepth + 1;
        if (depth > 8) return { depthExceeded: true, depth: depth };
        var subagentId = idGenerator('subagent');
        var childConversationId = idGenerator('conversation_subagent');
        var parentBranchId = text(active.branchId) || 'main';
        var branchId = text(input.branchId) || idGenerator('subagent_branch');
        var result = {
          conversationId: conversationId, childConversationId: childConversationId, subagentId: subagentId,
          parentGenerationId: parentGenerationId, branchId: branchId, parentBranchId: parentBranchId,
          delegationDepth: depth, assistantId: text(input.assistantId), serviceId: text(input.serviceId), state: 'scheduled',
        };
        tx.append({
          type: 'subagent_scheduled', generationId: parentGenerationId, turnId: text(input.parentTurnId || active.turnId), branchId: parentBranchId,
          causationId: parentGenerationId, correlationId: commandId,
          payload: {
            subagentId: subagentId, childConversationId: childConversationId,
            parentGenerationId: parentGenerationId, parentTurnId: text(input.parentTurnId || active.turnId),
            assistantId: text(input.assistantId), serviceId: text(input.serviceId), prompt: text(input.prompt),
            delegationDepth: depth, state: 'scheduled', commandId: commandId, childBranchId: branchId,
          },
        });
        tx.putCommandResult(commandId, result);
        return { result: result };
      });
      if (outcome.duplicate && outcome.result && outcome.result.state === 'started') return clone(outcome.result);
      if (outcome.stale) throw generationError('GENERATION_STALE', 'Parent generation is no longer active', conversationId, parentGenerationId);
      if (outcome.depthExceeded) throw generationError('SUBAGENT_DEPTH_EXCEEDED', 'Subagent delegation depth exceeded', conversationId, parentGenerationId, { depth: outcome.depth });
      var scheduled = clone(outcome.result);
      if (scheduled.state !== 'scheduled' || !scheduled.childConversationId) return scheduled;
      try {
        var parentJournalEvents = await journal.getAllEvents(conversationId);
        var scheduledEvent = parentJournalEvents.slice().reverse().find(function (event) {
          return event.type === 'subagent_scheduled' && event.correlationId === commandId && event.payload && event.payload.subagentId === scheduled.subagentId;
        });
        var parentSequence = scheduledEvent && scheduledEvent.sequence || 0;
        var parentGenerationStarted = parentJournalEvents.find(function (event) {
          return event.type === 'generation_started' && event.generationId === parentGenerationId;
        });
        var seedBoundary = parentGenerationStarted ? Math.max(0, Number(parentGenerationStarted.sequence) - 1) : 0;
        if (typeof journal.forkConversation === 'function') {
          await journal.forkConversation(conversationId, scheduled.childConversationId, {
            boundarySequence: seedBoundary,
            branchId: scheduled.branchId,
            origin: 'subagent',
            assistantId: input.assistantId,
            serviceId: input.serviceId,
            reason: 'subagent_scheduled',
          });
        }
        var childCommandId = commandId + ':child';
        var childInput = {
          schemaVersion: 1, commandId: childCommandId, conversationId: scheduled.childConversationId,
          assistantId: input.assistantId, serviceId: text(input.serviceId) || text((await journal.getMetadata(conversationId)).serviceId),
          message: { id: childCommandId + ':message', content: input.prompt, attachments: [] },
          surface: { type: 'mcp', instanceId: 'subagent:' + scheduled.subagentId },
          entry: input.entry || { type: 'conversation', currentResource: '/conversations/' + scheduled.childConversationId },
          budgets: input.budgets, preferences: input.preferences,
          lineage: { branchId: scheduled.branchId, parentConversationId: conversationId, parentGenerationId: parentGenerationId,
            parentTurnId: text(input.parentTurnId), parentSequence: parentSequence, origin: 'subagent', delegationDepth: scheduled.delegationDepth, subagentId: scheduled.subagentId },
          requestedAt: Number(clock()),
        };
        var child = await startTurn(childInput);
        scheduled.state = 'started';
        scheduled.generationId = child.generationId;
        scheduled.turnId = child.turnId;
        var childStartedEvent = {
          type: 'subagent_started', generationId: child.generationId, turnId: child.turnId, branchId: scheduled.branchId,
          causationId: parentGenerationId, correlationId: commandId,
          payload: { subagentId: scheduled.subagentId, parentConversationId: conversationId, parentGenerationId: parentGenerationId },
        };
        var parentStartedEvent = {
          type: 'subagent_started', generationId: parentGenerationId, turnId: text(input.parentTurnId), branchId: scheduled.parentBranchId,
          causationId: child.generationId, correlationId: commandId,
          payload: { subagentId: scheduled.subagentId, childConversationId: scheduled.childConversationId, childGenerationId: child.generationId },
        };
        await appendSubagentEventOnce(
          scheduled.childConversationId,
          'subagent_started:' + scheduled.childConversationId + ':' + scheduled.subagentId + ':' + child.generationId,
          childStartedEvent
        );
        var marked = await markSubagentStarted(conversationId, commandId, parentStartedEvent, scheduled);
        scheduled = Object.assign(scheduled, clone(marked || {}));
        // Completion is another Journal fact, observed from the child metadata;
        // no in-memory parent/child state is required for recovery or replay.
        (function monitorSubagent(parentConversationId, childConversationId, childGenerationId, subagentId, parentGenerationId, parentBranchId, childBranchId) {
          var poll = async function () {
            var childMetadata = await journal.getMetadata(childConversationId).catch(function () { return null; });
            var childActive = childMetadata && childMetadata.activeGeneration;
            if (!childActive || !isTerminal(childActive.state)) {
              if (typeof setTimeout === 'function') setTimeout(function () { poll().catch(function () {}); }, 500);
              return;
            }
            var payload = { subagentId: subagentId, childConversationId: childConversationId, childGenerationId: childGenerationId, state: childActive.state };
            await appendSubagentCompletion(parentConversationId, 'subagent_completion:' + parentConversationId + ':' + subagentId + ':' + childGenerationId, {
              type: 'subagent_completed', generationId: parentGenerationId, branchId: parentBranchId,
              causationId: childGenerationId, subagentId: subagentId, payload: payload,
            }).catch(function () {});
            await appendSubagentCompletion(childConversationId, 'subagent_completion:' + childConversationId + ':' + subagentId + ':' + childGenerationId, {
              type: 'subagent_completed', generationId: childGenerationId, branchId: childBranchId,
              causationId: parentGenerationId, subagentId: subagentId, payload: payload,
            }).catch(function () {});
          };
          poll().catch(function () {});
        }(conversationId, scheduled.childConversationId, child.generationId, scheduled.subagentId, parentGenerationId, scheduled.parentBranchId, scheduled.branchId));
      } catch (error) {
        scheduled.state = 'failed';
        scheduled.error = error && error.message || String(error);
        await journal.append(conversationId, {
          type: 'subagent_failed', generationId: parentGenerationId, turnId: text(input.parentTurnId), branchId: scheduled.parentBranchId,
          causationId: scheduled.subagentId, correlationId: commandId,
          payload: { subagentId: scheduled.subagentId, childConversationId: scheduled.childConversationId, error: scheduled.error },
        }).catch(function () {});
      }
      return scheduled;
    }

    async function replayConversation(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var commandId = required(input.commandId, 'commandId');
      var duplicate = await journal.getCommandResult(commandId);
      if (duplicate) return clone(duplicate);
      var replay = typeof journal.replayConversation === 'function'
        ? await journal.replayConversation(conversationId, input)
        : { conversationId: conversationId, events: await journal.getAllEvents(conversationId) };
      var result = {
        conversationId: conversationId, commandId: commandId, branchId: text(input.branchId) || replay.branchId || 'main',
        fromSequence: Number(input.fromSequence) || 0, toSequence: Number(input.toSequence) || replay.throughSequence || 0,
        events: clone(replay.events || []), throughSequence: replay.throughSequence || 0,
      };
      var committed = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var existing = await tx.getCommandResult(commandId);
        if (existing) return { duplicate: true, result: existing };
        tx.append({ type: 'conversation_replay_requested', branchId: result.branchId, correlationId: commandId,
          actorId: text(input.actorId), actorType: text(input.actorType), payload: {
          fromSequence: result.fromSequence, toSequence: result.toSequence, eventCount: result.events.length, commandId: commandId,
        } });
        tx.putCommandResult(commandId, result);
        return { duplicate: false, result: result };
      });
      return clone(committed && committed.result || result);
    }

    async function resumeConversation(input) {
      input = input || {};
      var conversationId = required(input.conversationId, 'conversationId');
      var commandId = required(input.commandId, 'commandId');
      var metadata = await journal.getMetadata(conversationId);
      if (!metadata) throw coordinatorError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', { conversationId: conversationId });
      var active = metadata.activeGeneration;
      if (!active || isTerminal(active.state)) {
        return { conversationId: conversationId, commandId: commandId, state: active && active.state || 'idle', resumed: false };
      }
      if (input.generationId && input.generationId !== active.generationId) {
        throw generationError('GENERATION_STALE', 'Requested generation is no longer active', conversationId, input.generationId);
      }
      var duplicate = await journal.getCommandResult(commandId);
      if (duplicate) return clone(duplicate);
      var result = { conversationId: conversationId, commandId: commandId, generationId: active.generationId, state: active.state, resumed: true };
      var committed = await journal.transaction(conversationId, 'readwrite', async function (tx) {
        var existing = await tx.getCommandResult(commandId);
        if (existing) return { duplicate: true, result: existing };
        tx.append({ type: 'conversation_resume_requested', generationId: active.generationId, turnId: active.turnId, branchId: active.branchId, correlationId: commandId, payload: { commandId: commandId } });
        tx.putCommandResult(commandId, result);
        return { duplicate: false, result: result };
      });
      if (committed && committed.duplicate) return clone(committed.result);
      if (active.state !== 'waiting_user') {
        var resumeInput = await generationInput(conversationId, active.generationId);
        resumeInput.generationId = active.generationId;
        resumeInput.turnId = active.turnId;
        schedule(function () { return launch(resumeInput, 'recovery'); });
      }
      return result;
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      runtimeInstanceId: coordinatorInstanceId,
      startTurn: startTurn,
      cancelGeneration: cancelGeneration,
      steerGeneration: steerGeneration,
      interruptModelRequest: interruptModelRequest,
      resolveInteraction: resolveInteraction,
      recoverActiveGenerations: recoverActiveGenerations,
      getSnapshot: getSnapshot,
      forkConversation: forkConversation,
      scheduleSubagent: scheduleSubagent,
      replayConversation: replayConversation,
      resumeConversation: resumeConversation,
      compareAndSet: compareAndSet,
      _launch: launch,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    STATES: STATES,
    TERMINAL_STATES: TERMINAL_STATES,
    TRANSITIONS: TRANSITIONS,
    TERMINAL_EVENT_TYPES: TERMINAL_EVENT_TYPES,
    create: create,
  });
});
