// Assistant Orchestrator — one durable Assistant generation exposed to Flow nodes.
(function attachAssistantOrchestrator(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AssistantOrchestrator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var TERMINAL_STATES = Object.freeze({
    completed: true,
    failed: true,
    cancelled: true,
    truncated: true,
    blocked: true,
  });
  var TERMINAL_EVENTS = Object.freeze({
    generation_completed: true,
    generation_failed: true,
    generation_cancelled: true,
    generation_truncated: true,
    generation_blocked: true,
  });

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function integer(value, fallback, minimum, maximum) {
    var number = Math.floor(Number(value));
    if (!Number.isFinite(number)) number = fallback;
    number = Math.max(minimum, number);
    return Math.min(maximum, number);
  }

  function createId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function responseError(response, fallback) {
    var details = response && response.error || {};
    var error = new Error(text(details.message) || fallback || 'Assistant command failed');
    error.code = text(details.code) || 'ASSISTANT_COMMAND_FAILED';
    error.details = clone(details.details || {});
    return error;
  }

  function signalError(signal) {
    var error = signal && signal.reason instanceof Error
      ? signal.reason : new Error('Assistant generation was cancelled');
    if (!error.code) error.code = 'ACTION_CANCELLED';
    if (error.performed === undefined) error.performed = 'unknown';
    if (error.retryable === undefined) error.retryable = false;
    return error;
  }

  function sleepWithSignal(sleep, ms, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(sleep(ms));
    if (signal.aborted) return Promise.reject(signalError(signal));
    return new Promise(function (resolve, reject) {
      var settled = false;
      function cleanup() {
        if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      }
      function onAbort() {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signalError(signal));
      }
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(sleep(ms)).then(function () {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, function (error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  function terminalEventFor(events, generationId) {
    events = Array.isArray(events) ? events : [];
    for (var index = events.length - 1; index >= 0; index -= 1) {
      var event = events[index];
      if (event && event.generationId === generationId && TERMINAL_EVENTS[event.type]) return event;
    }
    return null;
  }

  async function materializeTerminalEvent(journal, event) {
    event = clone(event);
    if (!event || !event.payloadRef) return event;
    if (!journal || typeof journal.getPayloadBlob !== 'function') {
      var unavailable = new Error('Assistant terminal payload is externalized but the journal cannot resolve it');
      unavailable.code = 'ASSISTANT_PAYLOAD_UNAVAILABLE';
      throw unavailable;
    }
    var blob = await journal.getPayloadBlob(event.payloadRef.payloadId, event.payloadRef.sha256);
    if (!blob) {
      var missing = new Error('Assistant terminal payload is missing');
      missing.code = 'ASSISTANT_PAYLOAD_MISSING';
      missing.details = { payloadId: String(event.payloadRef.payloadId || '') };
      throw missing;
    }
    event.payload = clone(blob.value);
    event.payloadStorage = { externalized: true, payloadRef: clone(event.payloadRef) };
    return event;
  }

  function create(options) {
    options = options || {};
    var commandBus = options.commandBus;
    var journal = options.journal;
    var resolveAssistant = options.resolveAssistant;
    var resolveDefaultServiceId = options.resolveDefaultServiceId;
    var parseJson = typeof options.parseJson === 'function' ? options.parseJson : function (value) {
      try { return JSON.parse(String(value || '')); } catch (_) { return undefined; }
    };
    var sleep = typeof options.sleep === 'function'
      ? options.sleep
      : function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    var throwIfStopped = typeof options.throwIfStopped === 'function' ? options.throwIfStopped : function () {};
    var pollIntervalMs = integer(options.pollIntervalMs, 250, 50, 5000);

    if (!commandBus || typeof commandBus.dispatchInternal !== 'function') {
      throw new TypeError('AssistantOrchestrator requires ConversationCommandBus.dispatchInternal');
    }
    if (!journal || typeof journal.getMetadata !== 'function' || typeof journal.queryEvents !== 'function') {
      throw new TypeError('AssistantOrchestrator requires ConversationJournalStore');
    }
    if (typeof resolveAssistant !== 'function' || typeof resolveDefaultServiceId !== 'function') {
      throw new TypeError('AssistantOrchestrator requires assistant and service resolvers');
    }

    function trustedSurface(instanceId) {
      return {
        type: 'mcp',
        instanceId: instanceId,
        assistantInvocationKind: 'runAssistant',
      };
    }

    function dispatch(command, input, surface) {
      return Promise.resolve(commandBus.dispatchInternal({ command: command, input: input }, surface)).then(function (response) {
        if (!response || response.ok !== true) throw responseError(response);
        return response.result || {};
      });
    }

    function cancel(conversationId, generationId, surface, reason) {
      if (!conversationId || !generationId) return Promise.resolve(null);
      return dispatch('CANCEL_GENERATION', {
        conversationId: conversationId,
        generationId: generationId,
        reason: text(reason) || 'flow_assistant_cancelled',
      }, surface).catch(function (error) {
        return { state: 'cancel_failed', error: text(error && error.message || error) };
      });
    }

    function attachAssistantAudit(error, conversationId, generationId, state, reason) {
      error = error instanceof Error ? error : new Error(String(error || 'Assistant generation stopped'));
      error.performed = 'unknown';
      error.retryable = false;
      error.assistantResult = Object.assign({}, error.assistantResult || {}, {
        conversationId: conversationId,
        generationId: generationId,
        state: text(state) || 'cancelling',
        reason: text(reason),
      });
      return error;
    }

    async function waitForTerminal(conversationId, generationId, surface, timeoutMs, stopChecker, signal) {
      stopChecker = typeof stopChecker === 'function' ? stopChecker : throwIfStopped;
      var deadline = Date.now() + timeoutMs;
      async function ensureRunning() {
        try {
          if (signal && signal.aborted) throw signalError(signal);
          stopChecker();
        } catch (error) {
          var stopReason = error && error.message || 'flow_stopped';
          var cancelled = await cancel(conversationId, generationId, surface, stopReason);
          throw attachAssistantAudit(error, conversationId, generationId, cancelled && cancelled.state, stopReason);
        }
      }
      while (true) {
        await ensureRunning();
        var metadata = await journal.getMetadata(conversationId);
        await ensureRunning();
        var active = metadata && metadata.activeGeneration;
        if (!active || active.generationId !== generationId) {
          var stale = new Error('Assistant generation is no longer active: ' + generationId);
          stale.code = 'ASSISTANT_GENERATION_STALE';
          throw stale;
        }
        if (TERMINAL_STATES[active.state]) {
          var page = await journal.queryEvents(conversationId, {
            beforeSequence: Math.max(1, Number(metadata.lastSequence) + 1 || 1),
            limit: 50,
          });
          await ensureRunning();
          var terminalEvent = terminalEventFor(page && page.events, generationId);
          if (!terminalEvent) {
            var missingTerminal = new Error('Assistant generation reached terminal state without a matching terminal event: ' + generationId);
            missingTerminal.code = 'ASSISTANT_TERMINAL_EVENT_MISSING';
            missingTerminal.performed = 'unknown';
            missingTerminal.retryable = false;
            missingTerminal.details = { conversationId: conversationId, generationId: generationId, state: String(active.state || '') };
            throw missingTerminal;
          }
          var materializedEvent = await materializeTerminalEvent(journal, terminalEvent);
          await ensureRunning();
          return {
            state: active.state,
            active: clone(active),
            event: materializedEvent,
          };
        }
        if (Date.now() >= deadline) {
          var cancelResult = await cancel(conversationId, generationId, surface, 'flow_assistant_timeout');
          var timeoutError = new Error('Assistant generation timed out after ' + timeoutMs + 'ms');
          timeoutError.code = 'ASSISTANT_TIMEOUT';
          throw attachAssistantAudit(timeoutError, conversationId, generationId, cancelResult && cancelResult.state, 'flow_assistant_timeout');
        }
        try {
          await sleepWithSignal(sleep, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
        } catch (error) {
          if (signal && signal.aborted) {
            var sleepCancel = await cancel(conversationId, generationId, surface, error && error.message || 'flow_assistant_cancelled');
            throw attachAssistantAudit(error, conversationId, generationId, sleepCancel && sleepCancel.state, error && error.message);
          }
          throw error;
        }
      }
    }

    function buildBudgets(assistant, input, timeoutMs) {
      var settings = assistant && assistant.settings || {};
      var requestedIterations = Number(input.maxIterations);
      var requestedToolCalls = Number(input.maxToolCalls);
      var configuredContextTokens = Number(settings.maxContextTokens);
      var maxIterations = integer(requestedIterations > 0 ? requestedIterations : settings.maxIterations, 100, 1, 1000);
      var maxToolCalls = integer(requestedToolCalls > 0 ? requestedToolCalls : settings.maxToolCalls, 200, 0, 10000);
      var maxOutputTokens = integer(Number(settings.maxTokens) > 0 ? settings.maxTokens : 4096, 4096, 1, 1000000);
      var maxContextTokens = integer(configuredContextTokens > 0 ? configuredContextTokens : 1000000, 1000000, 2, 4000000);
      if (maxContextTokens <= maxOutputTokens) maxContextTokens = Math.min(4000000, maxOutputTokens + 1);
      return {
        maxModelRequests: Math.min(1000, Math.max(1, maxIterations * 2)),
        maxIterations: maxIterations,
        maxToolCalls: maxToolCalls,
        maxWallTimeMs: timeoutMs,
        maxContextTokens: maxContextTokens,
        maxOutputTokens: maxOutputTokens,
      };
    }

    async function run(input) {
      input = input || {};
      var assistantRef = text(input.assistantId || input.assistant);
      var prompt = text(input.prompt);
      if (!assistantRef) throw new Error('Assistant node requires assistantId');
      if (!prompt) throw new Error('Assistant node requires prompt');

      var assistant = await resolveAssistant(assistantRef);
      if (!assistant || !text(assistant.id)) {
        var missingAssistant = new Error('Assistant does not exist: ' + assistantRef);
        missingAssistant.code = 'ASSISTANT_NOT_FOUND';
        throw missingAssistant;
      }

      var serviceId = text(input.serviceId || assistant.modelServiceId);
      if (!serviceId) serviceId = text(await resolveDefaultServiceId());
      if (!serviceId) {
        var missingService = new Error('Assistant has no Model Service and no default Model Service is configured');
        missingService.code = 'SERVICE_NOT_FOUND';
        throw missingService;
      }

      var timeoutMs = integer(input.timeoutMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
      if (input.signal && input.signal.aborted) throw signalError(input.signal);
      var conversationId = text(input.conversationId) || createId('assistant_flow');
      var commandId = createId('assistant_command');
      var instanceId = 'flow-assistant:' + text(input.flowId || input.nodeId || conversationId).slice(0, 420);
      var surface = trustedSurface(instanceId);
      var rawFlowId = text(input.flowId).replace(/^user:/, '');
      var tabId = integer(input.tabId, 0, 0, Number.MAX_SAFE_INTEGER);
      var readableSegment = function (value) { return Array.from(String(value || '')).map(function (character) {
        return /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/.test(character)
          || (character.charCodeAt(0) > 0x7f && !/[\s\u0080-\u009f]/u.test(character))
          ? character : encodeURIComponent(character);
      }).join(''); };
      var entry = {
        type: 'conversation',
        currentResource: rawFlowId ? '/flows/' + readableSegment(rawFlowId) : '/assistants/' + readableSegment(assistant.id),
        pageId: text(input.pageId),
        flowId: rawFlowId,
        runId: text(input.runId),
      };
      if (tabId > 0) entry.tabId = tabId;

      var startedAt = Date.now();
      var stopChecker = typeof input.throwIfStopped === 'function' ? input.throwIfStopped : throwIfStopped;
      try {
        if (input.signal && input.signal.aborted) throw signalError(input.signal);
        stopChecker();
      } catch (error) {
        throw attachAssistantAudit(error, conversationId, '', 'cancelled', error && error.message);
      }
      var started;
      try {
        started = await dispatch('START_TURN', {
          schemaVersion: 1,
          commandId: commandId,
          conversationId: conversationId,
          assistantId: assistant.id,
          serviceId: serviceId,
          message: {
            id: commandId + ':message',
            content: prompt,
            attachments: [],
          },
          entry: entry,
          budgets: buildBudgets(assistant, input, timeoutMs),
          preferences: {
            streamOutput: false,
            contextCompression: assistant.settings && assistant.settings.contextCompression === 'off' ? 'off' : 'auto',
          },
          requestedAt: startedAt,
        }, surface);
      } catch (error) {
        if (input.signal && input.signal.aborted) {
          throw attachAssistantAudit(signalError(input.signal), conversationId, '', 'cancelled', signalError(input.signal).message);
        }
        throw error;
      }

      var generationId = text(started.generationId);
      if (!generationId) {
        throw attachAssistantAudit(
          new Error('Assistant generation did not return generationId'),
          conversationId,
          '',
          'unknown',
          'missing_generation_id'
        );
      }
      if (input.signal && input.signal.aborted) {
        var startCancel = await cancel(conversationId, generationId, surface, 'flow_assistant_cancelled');
        throw attachAssistantAudit(signalError(input.signal), conversationId, generationId, startCancel && startCancel.state, 'flow_assistant_cancelled');
      }
      var terminal;
      try {
        terminal = await waitForTerminal(
          conversationId,
          generationId,
          surface,
          timeoutMs,
          input.throwIfStopped,
          input.signal || null,
        );
      } catch (error) {
        if (!error.assistantResult) {
          attachAssistantAudit(error, conversationId, generationId, 'unknown', error && error.message);
        }
        throw error;
      }
      var payload = terminal.event && terminal.event.payload || {};
      var finalAnswer = text(payload.finalAnswer);
      var output = {
        assistantId: assistant.id,
        assistantName: text(assistant.name),
        serviceId: serviceId,
        conversationId: conversationId,
        generationId: generationId,
        state: terminal.state,
        reason: text(payload.reason),
        finalAnswer: finalAnswer,
        result: finalAnswer,
        counters: clone(payload.counters || terminal.active && terminal.active.counters || {}),
        usage: clone(payload.usage || {}),
        startedAt: startedAt,
        endedAt: Date.now(),
      };
      output.durationMs = Math.max(0, output.endedAt - output.startedAt);

      if (terminal.state !== 'completed') {
        var failed = new Error(text(payload.error) || text(payload.reason) || ('Assistant generation ended with state: ' + terminal.state));
        failed.code = 'ASSISTANT_' + terminal.state.toUpperCase();
        failed.performed = 'unknown';
        failed.retryable = false;
        failed.assistantResult = output;
        throw failed;
      }
      if (input.outputFormat === 'json') {
        var parsed = parseJson(finalAnswer);
        if (!parsed || typeof parsed !== 'object') {
          var invalidJson = new Error('Assistant finalAnswer must be a JSON object or array: ' + finalAnswer.slice(0, 200));
          invalidJson.code = 'ASSISTANT_INVALID_JSON';
          invalidJson.performed = 'yes';
          invalidJson.retryable = false;
          invalidJson.assistantResult = output;
          throw invalidJson;
        }
        output.result = parsed;
      }
      return output;
    }

    return Object.freeze({ API_VERSION: API_VERSION, run: run });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
