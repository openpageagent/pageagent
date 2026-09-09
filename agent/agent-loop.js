// Generation-scoped transactional AgentLoop over ContextBuilder, ProviderGateway and ToolDispatcher.
(function attachAgentLoop(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var nodeCrypto = null;
  if (commonJs) {
    try { nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  }
  var api = factory(root, commonJs
    ? require('./providers/provider-message-normalizer')
    : root.ProviderMessageNormalizer, nodeCrypto);
  if (commonJs) module.exports = api;
  else root.AgentLoop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, messages, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;
  var FINISH_REASONS = Object.freeze([
    'stop', 'tool_calls', 'length', 'content_filter', 'aborted', 'transport_error', 'context_overflow',
  ]);
  var WRITE_METHODS = Object.freeze({ POST: true, PUT: true, PATCH: true, DELETE: true });

  if (!messages || typeof messages.contentText !== 'function') {
    throw new Error('ProviderMessageNormalizer must load before AgentLoop');
  }

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function requestTarget(value) { return typeof value === 'string' ? value : String(value === undefined || value === null ? '' : value); }
  function stable(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('AgentLoop values cannot contain cycles');
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
    if (!cryptoApi || !cryptoApi.subtle || typeof TextEncoder !== 'function') throw new Error('SHA-256 is required by AgentLoop');
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function loopError(code, message, details) {
    var error = new Error(message || code);
    error.name = 'AgentLoopError';
    error.code = code;
    error.details = details || {};
    return error;
  }
  function normalizeBudgets(value) {
    value = value || {};
    function integer(key, minimum, fallback) {
      var number = value[key] === undefined ? fallback : Number(value[key]);
      if (!Number.isSafeInteger(number) || number < minimum) throw new TypeError('Invalid generation budget: ' + key);
      return number;
    }
    return {
      maxModelRequests: integer('maxModelRequests', 1, 30),
      maxIterations: integer('maxIterations', 1, 30),
      maxToolCalls: integer('maxToolCalls', 0, 100),
      maxWallTimeMs: integer('maxWallTimeMs', 1, 10 * 60 * 1000),
      maxContextTokens: integer('maxContextTokens', 1024, 1000000),
      maxOutputTokens: integer('maxOutputTokens', 1, 4096),
    };
  }
  function performedValue(result, call) {
    var value = result && (result.performed || result.receipt && result.receipt.performed);
    if (value === true) value = 'yes';
    if (value === false) value = 'no';
    value = text(value).toLowerCase();
    if (value === 'yes' || value === 'no' || value === 'unknown') return value;
    return WRITE_METHODS[call.name] ? 'unknown' : 'yes';
  }
  function errorPerformed(error) {
    var value = error && (error.performed || error.receipt && error.receipt.performed);
    if (value === true) value = 'yes';
    if (value === false) value = 'no';
    value = text(value).toLowerCase();
    return value === 'yes' || value === 'unknown' ? 'unknown' : 'no';
  }
  function requestFingerprint(built) {
    var request = built && built.request || {};
    return stableStringify({
      system: request.system, developer: request.developer, messages: request.messages, tools: request.tools,
      checkpointId: built && built.trace && built.trace.checkpointId,
      throughSequence: built && built.trace && built.trace.throughSequence,
      tailStartSequence: built && built.trace && built.trace.tailStartSequence,
      tailEndSequence: built && built.trace && built.trace.tailEndSequence,
    });
  }

  function createRequestDeadline(parentSignal, timeoutMs) {
    var AbortControllerValue = root && root.AbortController
      || typeof AbortController !== 'undefined' && AbortController;
    var controller = AbortControllerValue ? new AbortControllerValue() : null;
    var timer = null;
    var parentListener = null;
    var closed = false;
    var settled = false;
    var rejectExpiration;
    var expiration = new Promise(function (_, reject) { rejectExpiration = reject; });
    function abort(reason) {
      if (closed || settled) return;
      settled = true;
      var error = reason instanceof Error
        ? reason
        : loopError('CANCELLED', reason ? String(reason) : 'Generation was cancelled');
      if (controller && !controller.signal.aborted) {
        try { controller.abort(error); } catch (_) { controller.abort(); }
      }
      rejectExpiration(error);
    }
    if (parentSignal) {
      if (parentSignal.aborted) abort(parentSignal.reason || loopError('CANCELLED', 'Generation was cancelled'));
      else {
        parentListener = function () {
          abort(parentSignal.reason || loopError('CANCELLED', 'Generation was cancelled'));
        };
        parentSignal.addEventListener('abort', parentListener, { once: true });
      }
    }
    var timeout = Math.max(1, Math.floor(Number(timeoutMs) || 1));
    timer = setTimeout(function () {
      var error = loopError('WALL_TIME_EXCEEDED', 'Generation wall-time budget expired during model request', {
        timeoutMs: timeout,
      });
      error.name = 'TimeoutError';
      abort(error);
    }, timeout);
    return {
      signal: controller ? controller.signal : parentSignal || null,
      expiration: expiration,
      close: function () {
        if (closed) return;
        closed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (parentSignal && parentListener) parentSignal.removeEventListener('abort', parentListener);
        parentListener = null;
      },
    };
  }

  function create(options) {
    options = options || {};
    var contextBuilder = options.contextBuilder;
    var providerGateway = options.providerGateway;
    var toolDispatcher = options.toolDispatcher;
    if (!contextBuilder || typeof contextBuilder.build !== 'function') throw new TypeError('AgentLoop requires ContextBuilder.build');
    if (!providerGateway || typeof providerGateway.request !== 'function') throw new TypeError('AgentLoop requires ProviderGateway.request');
    if (!toolDispatcher || typeof toolDispatcher.dispatch !== 'function') throw new TypeError('AgentLoop requires ToolDispatcher.dispatch');
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : function (prefix) { nextId += 1; return prefix + '_' + Number(clock()).toString(36) + '_' + nextId.toString(36); };
    var cryptoApi = options.crypto || root && root.crypto;
    var streamSink = typeof options.streamSink === 'function' ? options.streamSink : null;
    var faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : null;

    async function durableResult(call, result) {
      if (typeof toolDispatcher.journalResult !== 'function') return clone(result);
      return toolDispatcher.journalResult(clone(call), clone(result));
    }

    function modelProjectionFor(call) {
      if (typeof toolDispatcher.modelProjectionFor !== 'function') return { type: 'data' };
      return clone(toolDispatcher.modelProjectionFor(clone(call)) || { type: 'data' });
    }

    function inject(point, details) {
      if (!faultInjector) return;
      var result = faultInjector(point, clone(details || {}));
      if (result instanceof Error) throw result;
      if (result === true) {
        var error = loopError('SERVICE_WORKER_TERMINATED', 'Injected MV3 service-worker termination', { point: point });
        error.faultPoint = point;
        throw error;
      }
    }

    async function activeAndTime(lease, budgets, stage) {
      var active = await lease.assertActive();
      if (lease.signal && lease.signal.aborted) throw loopError('CANCELLED', 'Generation was cancelled', { stage: stage });
      var elapsed = Number(clock()) - Number(active.startedAt || active.counters && active.counters.startedAt || 0);
      if (elapsed > budgets.maxWallTimeMs) {
        throw loopError('WALL_TIME_EXCEEDED', 'Generation exceeded maxWallTimeMs', { stage: stage, elapsedMs: elapsed });
      }
      return active;
    }
    async function appendMany(lease, events) {
      if (!events.length) return;
      if (typeof lease.appendMany === 'function') return lease.appendMany(events);
      for (var index = 0; index < events.length; index += 1) await lease.append(events[index]);
    }
    async function terminal(lease, state, reason, finalAnswer, extra, terminalOptions) {
      var active = await lease.assertActive();
      var payload = Object.assign({
        status: state,
        reason: reason,
        counters: clone(active.counters || {}),
        durationMs: Math.max(0, Number(clock()) - Number(active.startedAt || 0)),
        finalAnswer: text(finalAnswer),
      }, clone(extra || {}));
      inject('before_terminal_event', { state: state, reason: reason, generationId: lease.generationId });
      var terminalEvent = { payload: payload };
      if (terminalOptions && terminalOptions.expectedSteeringRevision !== undefined) {
        terminalEvent.expectedSteeringRevision = terminalOptions.expectedSteeringRevision;
      }
      var finalized = await lease.finalize(state, terminalEvent);
      if (finalized && finalized.pendingSteering) {
        return { state: 'running', reason: 'pending_steering', finalAnswer: '', counters: payload.counters, pendingSteering: true };
      }
      return { terminal: true, state: state, reason: reason, finalAnswer: payload.finalAnswer, counters: payload.counters };
    }
    async function counterValue(lease, key) {
      var active = await lease.assertActive();
      return Math.max(0, Number(active.counters && active.counters[key]) || 0);
    }
    async function incrementCounter(lease, key, event, patch) {
      var active = await lease.assertActive();
      var counters = Object.assign({}, active.counters || {});
      counters[key] = Math.max(0, Number(counters[key]) || 0) + 1;
      await lease.update(Object.assign({ counters: counters }, patch || {}), event || null);
      return counters;
    }
    function synthetic(call, code, reason, detail) {
      return {
        ok: false,
        error: { code: code, message: reason, retryable: false },
        receipt: { performed: 'no' },
        detail: clone(detail || null),
      };
    }
    async function defer(lease, call, code, reason, detail) {
      var result = synthetic(call, code, reason, detail);
      await lease.append({
        type: 'tool_call_deferred', toolCallId: call.id,
        payload: {
          name: call.name,
          requestTarget: requestTarget(call.arguments && call.arguments.uri),
          canonicalUri: null,
          routeTemplate: null,
          routeSchema: 'not-checked',
          trace: null,
          errorCode: code, reason: reason, performed: 'no', result: result,
        },
      });
      return result;
    }
    async function deferRange(lease, calls, start, code, reason, detail) {
      for (var index = start; index < calls.length; index += 1) await defer(lease, calls[index], code, reason, detail);
    }
    function exposedNames(built) {
      return (built.request.tools || []).map(function (tool) { return text(tool.name).toUpperCase(); });
    }

    function idempotencyKeyFor(lease, call) {
      var explicit = text(call && call.arguments && call.arguments.idempotencyKey);
      if (explicit) return Promise.resolve(explicit);
      var canonicalUri = requestTarget(call && call.arguments && call.arguments.uri);
      return sha256([
        lease.conversationId, lease.generationId, text(call && call.id),
        text(call && call.name), canonicalUri,
      ].join('\n'), cryptoApi);
    }

    async function processTools(lease, budgets, built, response) {
      var calls = (Array.isArray(response.calls) ? response.calls : []).map(function (call) {
        if (!call || typeof call !== 'object') return call;
        var name = text(call.name).toUpperCase();
        return name === call.name ? call : Object.assign({}, call, { name: name });
      });
      var exposed = exposedNames(built);
      var batchSnapshot = typeof toolDispatcher.createBatchSnapshot === 'function'
        ? await toolDispatcher.createBatchSnapshot({
          conversationId: lease.conversationId, generationId: lease.generationId,
          modelRequestId: response.modelRequestId,
        }) : null;
      // skipReason 只作用于本批次：跳过剩余调用并把原因反馈给模型，由模型在下一轮
      // 自行决策（观察状态、换路径或给出最终回答）。它不把 generation 推向终局。
      var skipReason = '';
      try {
        for (var index = 0; index < calls.length; index += 1) {
        var call = calls[index];
        var projectionDescriptor = modelProjectionFor(call);
        if (skipReason) {
          await defer(lease, call, skipReason, 'A prior call in this batch made the remaining calls unsafe or pointless to execute');
          continue;
        }
        if (lease.signal && lease.signal.aborted) {
          await deferRange(lease, calls, index, 'CANCELLED', 'Generation was cancelled before dispatch');
          return { state: 'cancelled', reason: 'cancelled' };
        }
        var activeBeforeTool;
        try { activeBeforeTool = await activeAndTime(lease, budgets, 'before_tool_dispatch'); }
        catch (error) {
          if (error.code === 'WALL_TIME_EXCEEDED') {
            await deferRange(lease, calls, index, 'WALL_TIME_EXCEEDED', error.message);
            return { state: 'failed', reason: 'WALL_TIME_EXCEEDED' };
          }
          throw error;
        }
        if (Math.max(0, Number(activeBeforeTool.interruptRevision) || 0)
            !== Math.max(0, Number(built.trace && built.trace.interruptRevision) || 0)) {
          await deferRange(lease, calls, index, 'MODEL_REQUEST_INTERRUPTED', 'User requested immediate processing of pending messages before dispatch');
          return { state: 'running', reason: 'after_interrupt' };
        }
        // 工具暴露检查发生在 dispatch 之前、零副作用：只 defer 当前调用，
        // deferred 结果会回放给模型自我纠正；批内其余调用各自独立处理。
        // 仅副作用不确定的失败（SIDE_EFFECT_UNKNOWN）才需要阻塞剩余批次并终止。
        if (exposed.indexOf(call.name) === -1) {
          await defer(lease, call, 'CAPABILITY_UNAVAILABLE', 'Tool was not exposed for this Provider request. Use only the tools listed in this request; the method may be exposed again on the next model request');
          continue;
        }
        var count = await counterValue(lease, 'toolCallCount');
        if (count >= budgets.maxToolCalls) {
          await defer(lease, call, 'TOOL_BUDGET_EXHAUSTED', 'Generation exhausted maxToolCalls');
          skipReason = 'TOOL_BUDGET_EXHAUSTED';
          continue;
        }
        var idempotencyKey = await idempotencyKeyFor(lease, call);
        var canonicalUri = null;
        await incrementCounter(lease, 'toolCallCount', {
          type: 'tool_execution_started', modelRequestId: response.modelRequestId, toolCallId: call.id,
          payload: { method: call.name, requestTarget: requestTarget(call.arguments && call.arguments.uri), canonicalUri: canonicalUri, routeTemplate: null, routeSchema: 'not-checked', idempotencyKey: idempotencyKey },
        }, {
          inFlightTool: {
            toolCallId: call.id, modelRequestId: response.modelRequestId, method: call.name,
            requestTarget: requestTarget(call.arguments && call.arguments.uri), canonicalUri: canonicalUri, routeTemplate: null, routeSchema: 'not-checked', idempotencyKey: idempotencyKey, stage: 'started', startedAt: Number(clock()),
          },
        });
        inject('after_tool_execution_started', { toolCallId: call.id, modelRequestId: response.modelRequestId });
        var result;
        try {
          result = await toolDispatcher.dispatch(clone(call), {
            conversationId: lease.conversationId, generationId: lease.generationId, turnId: lease.turnId,
            modelRequestId: response.modelRequestId, idempotencyKey: idempotencyKey,
            batchSnapshot: batchSnapshot,
            lease: lease, signal: lease.signal,
          });
          var dispatchTrace = result && result.trace
            || result && result.error && result.error.trace
            || null;
          if (dispatchTrace && dispatchTrace.canonicalPath) canonicalUri = text(dispatchTrace.canonicalPath);
          inject('after_tool_side_effect', { toolCallId: call.id, modelRequestId: response.modelRequestId });
        } catch (dispatchError) {
          if (dispatchError && dispatchError.code === 'SERVICE_WORKER_TERMINATED') throw dispatchError;
          var failedTrace = dispatchError && dispatchError.details && dispatchError.details.trace;
          if (failedTrace && failedTrace.canonicalPath) canonicalUri = text(failedTrace.canonicalPath);
          var failedPerformed = errorPerformed(dispatchError);
          var failureType = failedPerformed === 'unknown' ? 'tool_execution_unknown' : 'tool_execution_failed';
          try {
            await lease.update({ inFlightTool: null }, {
              type: failureType, modelRequestId: response.modelRequestId, toolCallId: call.id,
              payload: {
                name: call.name, requestTarget: requestTarget(call.arguments && call.arguments.uri), canonicalUri: canonicalUri,
                routeTemplate: failedTrace && failedTrace.routeTemplate || null, routeSchema: failedTrace && failedTrace.routeSchema || 'not-checked',
                errorCode: text(dispatchError && dispatchError.code) || 'TOOL_EXECUTION_FAILED',
                error: dispatchError && dispatchError.message || String(dispatchError),
                retryable: dispatchError && dispatchError.retryable === true, performed: failedPerformed,
                receipt: clone(dispatchError && dispatchError.receipt || null),
                details: clone(dispatchError && dispatchError.details || {}),
                current: clone(dispatchError && dispatchError.current || null),
                trace: clone(failedTrace || null),
                warnings: clone(dispatchError && dispatchError.warnings || []),
                modelProjection: projectionDescriptor,
                lastKnownStage: text(dispatchError && dispatchError.stage) || 'dispatch', reconciliationAttempts: 0,
              },
            });
          } catch (journalError) {
            var recovery = loopError('RECOVERY_REQUIRED', 'Tool outcome could not be committed after dispatch failure', { toolCallId: call.id });
            recovery.cause = journalError;
            throw recovery;
          }
          if (failedPerformed === 'unknown') skipReason = 'SIDE_EFFECT_UNKNOWN';
          continue;
        }
        var performed = performedValue(result, call);
        if (performed === 'unknown') {
          try {
            var durableUnknownResult = await durableResult(call, result);
            await lease.update({ inFlightTool: null }, {
              type: 'tool_execution_unknown', modelRequestId: response.modelRequestId, toolCallId: call.id,
              payload: {
                name: call.name, requestTarget: requestTarget(call.arguments && call.arguments.uri), canonicalUri: canonicalUri,
                routeTemplate: dispatchTrace && dispatchTrace.routeTemplate || null, routeSchema: dispatchTrace && dispatchTrace.routeSchema || 'not-checked',
                performed: 'unknown', receipt: clone(result && result.receipt || null),
                result: durableUnknownResult, modelProjection: projectionDescriptor,
                trace: clone(dispatchTrace),
                lastKnownStage: 'dispatch_returned', reconciliationAttempts: 0,
              },
            });
          } catch (journalError) {
            var unknownRecovery = loopError('RECOVERY_REQUIRED', 'Unknown tool outcome could not be committed', { toolCallId: call.id });
            unknownRecovery.cause = journalError;
            throw unknownRecovery;
          }
          skipReason = 'SIDE_EFFECT_UNKNOWN';
          continue;
        }
        try {
          var durableCompletedResult = await durableResult(call, result);
          await lease.update({ inFlightTool: null }, {
            type: 'tool_execution_completed', modelRequestId: response.modelRequestId, toolCallId: call.id,
            payload: {
              name: call.name, requestTarget: requestTarget(call.arguments && call.arguments.uri), canonicalUri: canonicalUri,
              routeTemplate: dispatchTrace && dispatchTrace.routeTemplate || null, routeSchema: dispatchTrace && dispatchTrace.routeSchema || 'not-checked',
              performed: performed, receipt: clone(result && result.receipt || { performed: performed }),
              result: durableCompletedResult, modelProjection: projectionDescriptor,
              trace: clone(dispatchTrace),
            },
          });
        } catch (journalError) {
          var completedRecovery = loopError('RECOVERY_REQUIRED', 'Tool receipt could not be committed after dispatch', { toolCallId: call.id });
          completedRecovery.cause = journalError;
          throw completedRecovery;
        }
        try { await activeAndTime(lease, budgets, 'after_tool_dispatch'); }
        catch (error) {
          if (error.code === 'WALL_TIME_EXCEEDED') {
            await deferRange(lease, calls, index + 1, 'WALL_TIME_EXCEEDED', error.message);
            return { state: 'failed', reason: 'WALL_TIME_EXCEEDED' };
          }
          throw error;
        }
        }
        return {
          state: 'running',
          reason: skipReason || 'after_tool',
        };
      } finally {
        if (typeof toolDispatcher.finishBatchSnapshot === 'function') {
          try { await toolDispatcher.finishBatchSnapshot(batchSnapshot); } catch (_) {}
        }
      }
    }

    async function runMachine(input, lease, budgets) {
      var reason = 'initial';
      var overflowFingerprint = '';
      var logicalRequestId = '';
      var truncatedRetryCount = 0;
      for (;;) {
        var active = await activeAndTime(lease, budgets, 'loop_start');
        if (Math.max(0, Number(active.counters && active.counters.loopIterationCount) || 0) >= budgets.maxIterations) {
          return terminal(lease, 'blocked', 'ITERATION_BUDGET_EXHAUSTED', '');
        }
        if (Math.max(0, Number(active.counters && active.counters.modelRequestCount) || 0) >= budgets.maxModelRequests) {
          return terminal(lease, 'blocked', 'MODEL_REQUEST_BUDGET_EXHAUSTED', '');
        }
        logicalRequestId = logicalRequestId || idGenerator('logical_request');
        var buildInput = Object.assign({}, clone(input), {
          lease: lease, budgets: budgets, reason: reason, logicalRequestId: logicalRequestId,
          forceSummary: reason === 'overflow_retry',
        });
        var built = await contextBuilder.build(buildInput);
        await activeAndTime(lease, budgets, 'after_context_build');
        var fingerprint = requestFingerprint(built);
        if (reason === 'overflow_retry' && overflowFingerprint && fingerprint === overflowFingerprint) {
          throw loopError('CONTEXT_EXHAUSTED', 'Overflow governance did not change the Provider context');
        }
        await lease.append({
          type: 'context_injected', modelRequestId: built.request.modelRequestId,
          payload: {
            source: 'context-builder',
            logicalRequestId: built.request.logicalRequestId,
            purpose: built.request.purpose,
            system: clone(built.request.system),
            messages: clone(built.request.messages),
            tools: clone(built.request.tools),
            runtimeContext: clone(built.request.contextTrace && built.request.contextTrace.runtimeContext),
            contextAppendMessages: clone(built.contextAppendMessages || []),
            promptState: clone(built.promptState || null),
            trace: clone(built.trace),
          },
        });
        await lease.append({
          type: 'model_request_prepared', modelRequestId: built.request.modelRequestId,
          payload: {
            logicalRequestId: built.request.logicalRequestId, purpose: built.request.purpose,
            contextTrace: clone(built.trace), promptVersion: built.trace.promptVersion, toolSchemaHash: built.trace.toolSchemaHash,
          },
        });
        var requestScope = null;
        var response;
        var providerFailure = null;
        var requestInterrupted = false;
        var requestStartedAt = 0;
        var requestCompletedAt = 0;
        var reasoningObserved = false;
        var reasoningCompletedAt = 0;
        try {
          requestScope = typeof lease.openModelRequest === 'function'
            ? lease.openModelRequest(built.request.modelRequestId)
            : null;
          var activeBeforeRequest = await activeAndTime(lease, budgets, 'before_model_request');
          var requestElapsed = Math.max(0, Number(clock()) - Number(activeBeforeRequest.startedAt
            || activeBeforeRequest.counters && activeBeforeRequest.counters.startedAt || clock()));
          var requestTimeoutMs = Math.max(1, budgets.maxWallTimeMs - requestElapsed);
          requestStartedAt = Number(clock());
          var requestPayload = {
            logicalRequestId: built.request.logicalRequestId,
            provider: text(input.service && (input.service.protocol || input.service.apiStyle)), model: built.request.model,
            attempt: Math.max(1, Number(activeBeforeRequest.counters && activeBeforeRequest.counters.overflowRetryCount) + 1 || 1),
            startedAt: requestStartedAt,
            promptMessages: clone(built.contextAppendMessages || []),
            promptState: clone(built.promptState || null),
            request: clone({
              purpose: built.request.purpose,
              logicalRequestId: built.request.logicalRequestId,
              modelRequestId: built.request.modelRequestId,
              serviceId: built.request.serviceId,
              model: built.request.model,
              system: built.request.system,
              messages: built.request.messages,
              tools: built.request.tools,
              maxOutputTokens: built.request.maxOutputTokens,
              promptCacheKey: built.request.promptCacheKey,
              contextTrace: built.request.contextTrace,
            }),
          };
          var steeringUnits = (built.atomicUnits || []).filter(function (unit) {
            return unit && unit.kind === 'steering' && unit.generationId === lease.generationId;
          }).sort(function (left, right) {
            return Number(left.startSequence || 0) - Number(right.startSequence || 0);
          });
          var consumedSteeringRevision = Math.max(0, Math.floor(Number(activeBeforeRequest.consumedSteeringRevision) || 0));
          var steeringRevision = Math.max(0, Math.floor(Number(built.trace && built.trace.steeringRevision) || 0));
          var steeringMessages = steeringUnits.slice(consumedSteeringRevision, steeringRevision).map(function (unit) {
            var source = unit.sourceEvents && unit.sourceEvents[0] || {};
            return {
              sequence: Math.max(0, Number(source.sequence || unit.startSequence) || 0),
              commandId: source.payload && source.payload.commandId || '',
              message: clone(source.payload && source.payload.message || {}),
            };
          });
          if (typeof lease.commitModelRequest === 'function') {
            var committedRequest = await lease.commitModelRequest({
              modelRequestId: built.request.modelRequestId,
              expectedSteeringRevision: steeringRevision,
              steeringMessages: steeringMessages,
              payload: requestPayload,
            });
            if (committedRequest && committedRequest.pendingSteering) {
              logicalRequestId = '';
              overflowFingerprint = '';
              reason = 'after_steering';
              continue;
            }
            if (committedRequest) {
              built.trace.interruptRevision = Math.max(0, Math.floor(Number(committedRequest.interruptRevision) || 0));
              if (built.request.contextTrace) built.request.contextTrace.interruptRevision = built.trace.interruptRevision;
            }
          } else {
            await incrementCounter(lease, 'modelRequestCount', {
              type: 'model_request_started', modelRequestId: built.request.modelRequestId,
              payload: requestPayload,
            });
          }
          inject('after_model_request_started', { modelRequestId: built.request.modelRequestId });
          if (streamSink) await streamSink({
            conversationId: lease.conversationId, generationId: lease.generationId,
            turnId: lease.turnId, modelRequestId: built.request.modelRequestId,
            event: { type: 'model_request_started', startedAt: requestStartedAt },
          });
          var requestDeadline = createRequestDeadline(requestScope && requestScope.signal
            || built.request.signal || lease.signal, requestTimeoutMs);
          var streamTasks = [];
          var streamClosed = false;
          var providerRequest = Object.assign({}, built.request, {
            signal: requestDeadline.signal,
            onEvent: function (event) {
              if (streamClosed) return;
              var streamedAt = Number(clock());
              if (event && event.type === 'reasoning_delta') {
                reasoningObserved = true;
                reasoningCompletedAt = 0;
              } else if (reasoningObserved && !reasoningCompletedAt && event
                  && (event.type === 'text_delta' || event.type === 'tool_call_delta')) {
                reasoningCompletedAt = streamedAt;
              }
              streamTasks.push(Promise.resolve().then(async function () {
                /* Stream deltas already merge into one stream_buffer row. The
                   completed reasoning/response and real tool lifecycle rows
                   are the durable trajectory; persisting every token here
                   only bloats history and breaks visible-count pagination. */
                return streamSink ? streamSink({
                  conversationId: lease.conversationId, generationId: lease.generationId,
                  turnId: lease.turnId, modelRequestId: built.request.modelRequestId, event: clone(event),
                }) : null;
              }));
            },
          });
          try {
            var providerPromise = Promise.resolve().then(function () {
              return providerGateway.request(providerRequest);
            });
            response = await Promise.race([providerPromise, requestDeadline.expiration]);
            requestCompletedAt = Number(clock());
          } catch (providerError) {
            requestInterrupted = !!(requestScope && requestScope.interruptedByUser())
              || providerError && providerError.code === 'MODEL_REQUEST_INTERRUPTED';
            if (!requestInterrupted) {
              providerFailure = providerError;
              await lease.append({
                type: 'model_request_failed', modelRequestId: built.request.modelRequestId,
                payload: { errorCode: providerError && providerError.code || 'PROVIDER_CONTRACT_ERROR', error: providerError && providerError.message || String(providerError) },
              });
              throw providerError;
            }
          } finally {
            streamClosed = true;
            requestDeadline.close();
            var streamFailure = null;
            if (streamTasks.length) {
              try { await Promise.all(streamTasks); }
              catch (streamError) { streamFailure = streamError; }
            }
            if (streamSink) {
              try {
                await streamSink({
                  conversationId: lease.conversationId, generationId: lease.generationId,
                  turnId: lease.turnId, modelRequestId: built.request.modelRequestId,
                  event: { type: 'request_terminal' },
                });
              } catch (cleanupError) {
                if (!streamFailure) streamFailure = cleanupError;
              }
            }
            if (streamFailure && !providerFailure) throw streamFailure;
          }
          if (!requestInterrupted && requestScope && requestScope.interruptedByUser()) {
            requestInterrupted = true;
          }
        } finally {
          if (requestScope) requestScope.close();
        }
        if (requestInterrupted) {
          await lease.append({
            type: 'model_request_interrupted', modelRequestId: built.request.modelRequestId,
            payload: { reason: 'pending_messages_requested' },
          });
          logicalRequestId = '';
          overflowFingerprint = '';
          reason = 'after_interrupt';
          continue;
        }
        var wallExceededAfterProvider = false;
        try { await activeAndTime(lease, budgets, 'after_model_request'); }
        catch (postRequestError) {
          if (postRequestError && postRequestError.code === 'WALL_TIME_EXCEEDED') wallExceededAfterProvider = true;
          else throw postRequestError;
        }
        if (!response || FINISH_REASONS.indexOf(response.finishReason) === -1) {
          throw loopError('PROVIDER_CONTRACT_ERROR', 'Provider returned an unknown finish reason', { finishReason: response && response.finishReason });
        }
        if (response.finishReason === 'transport_error' || response.finishReason === 'context_overflow' || response.finishReason === 'aborted') {
          await lease.append({
            type: 'model_request_failed', modelRequestId: built.request.modelRequestId,
            payload: {
              finishReason: response.finishReason,
              errorCode: response.rawMeta && response.rawMeta.error && response.rawMeta.error.errorCode || response.finishReason,
              error: response.rawMeta && response.rawMeta.error && response.rawMeta.error.message || '',
              usage: clone(response.usage || {}),
            },
          });
          if (wallExceededAfterProvider) return terminal(lease, 'failed', 'WALL_TIME_EXCEEDED', '');
          if (response.finishReason === 'aborted') {
            return terminal(lease, lease.signal && lease.signal.aborted ? 'cancelled' : 'blocked', 'PROVIDER_ABORTED', '');
          }
          if (response.finishReason === 'transport_error') return terminal(lease, 'failed', 'PROVIDER_TRANSPORT_ERROR', '');
          var overflowCount = await counterValue(lease, 'overflowRetryCount');
          await lease.append({
            type: 'context_overflow_detected', modelRequestId: built.request.modelRequestId,
            payload: { logicalRequestId: logicalRequestId, retryCount: overflowCount, contextTrace: clone(built.trace) },
          });
          if (overflowCount >= 1) return terminal(lease, 'failed', 'CONTEXT_EXHAUSTED', '');
          await incrementCounter(lease, 'overflowRetryCount');
          overflowFingerprint = fingerprint;
          reason = 'overflow_retry';
          continue;
        }

        await incrementCounter(lease, 'loopIterationCount');
        var measuredInputTokens = response.usage
          ? Number(response.usage.inputTokens || 0)
            + Number(response.usage.cacheReadTokens || 0)
            + Number(response.usage.cacheWriteTokens || 0)
          : 0;
        if (typeof contextBuilder.recordUsageCalibration === 'function' && measuredInputTokens > 0) {
          contextBuilder.recordUsageCalibration({
            serviceId: built.request.serviceId, model: built.request.model,
            estimatedInputTokens: built.trace.inputTokens,
            actualInputTokens: measuredInputTokens,
          });
        }
        var calls = (Array.isArray(response.calls) ? response.calls : []).map(function (call) {
          if (!call || typeof call !== 'object') return call;
          return Object.assign({}, call, { name: text(call.name).toUpperCase() });
        });
        var callIds = Object.create(null);
        calls.forEach(function (call) {
          if (!call || !text(call.id) || !text(call.name) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
            throw loopError('PROVIDER_CONTRACT_ERROR', 'Provider returned an invalid completed tool call');
          }
          if (callIds[call.id]) throw loopError('PROVIDER_CONTRACT_ERROR', 'Provider returned duplicate toolCallId: ' + call.id);
          callIds[call.id] = true;
        });
        var planned = await Promise.all(calls.map(async function (call) {
          var idempotencyKey = await idempotencyKeyFor(lease, call);
          return {
            type: 'tool_call_planned', modelRequestId: built.request.modelRequestId, toolCallId: call.id,
            payload: {
              name: call.name, arguments: clone(call.arguments), argumentsHash: await sha256(call.arguments, cryptoApi),
              idempotencyKey: idempotencyKey,
            },
          };
        }));
        var durableResponse = [];
        var commentary = messages.contentText(response.commentary);
        if (commentary) durableResponse.push({
          type: 'commentary_completed', modelRequestId: built.request.modelRequestId,
          payload: {
            provider: response.rawMeta && response.rawMeta.apiStyle || '', model: built.request.model,
            content: clone(response.commentary),
          },
        });
        if (text(response.reasoning)) {
          var reasoningKind = response.rawMeta && response.rawMeta.reasoningKind
            || (response.rawMeta && response.rawMeta.apiStyle === 'responses' ? 'summary' : 'raw');
          durableResponse.push({
            type: 'reasoning_completed', modelRequestId: built.request.modelRequestId,
            payload: {
              provider: response.rawMeta && response.rawMeta.apiStyle || '', model: built.request.model,
              reasoningKind: reasoningKind,
              iteration: await counterValue(lease, 'loopIterationCount'),
              visibility: 'visible',
              startedAt: requestStartedAt,
              durationMs: Math.max(0, Number(reasoningCompletedAt || requestCompletedAt || clock()) - requestStartedAt),
              content: text(response.reasoning),
            },
          });
        }
        durableResponse.push({
          type: 'model_response_completed', modelRequestId: built.request.modelRequestId,
          payload: {
            finishReason: response.finishReason, endTurn: response.endTurn, usage: clone(response.usage || {}),
            content: clone(response.content || []), calls: clone(calls), providerReplay: clone(response.providerReplay || null),
            rawMeta: clone(response.rawMeta || {}), callIds: calls.map(function (call) { return call.id; }),
          },
        });
        durableResponse = durableResponse.concat(planned);
        // providerReplay on model_response_completed is the single durable
        // owner of signed/provider-specific replay blocks. A second hidden
        // event duplicated the same reasoning bytes without adding causality.
        await appendMany(lease, durableResponse);
        inject('after_model_response_completed', { modelRequestId: built.request.modelRequestId });
        if (planned.length) inject('after_tool_call_planned', {
          modelRequestId: built.request.modelRequestId,
          toolCallIds: planned.map(function (event) { return event.toolCallId; }),
        });
        if (streamSink) await streamSink({
          conversationId: lease.conversationId, generationId: lease.generationId,
          turnId: lease.turnId, modelRequestId: built.request.modelRequestId,
          event: { type: 'durable' },
        });

        if (wallExceededAfterProvider) {
          if (calls.length) await deferRange(lease, calls, 0, 'WALL_TIME_EXCEEDED', 'Generation wall-time budget expired before dispatch');
          return terminal(lease, 'failed', 'WALL_TIME_EXCEEDED', messages.contentText(response.content));
        }

        if (response.finishReason === 'length') {
          var truncatedAnswer = messages.contentText(response.content);
          // A reasoning-only incomplete response is not a usable answer. Give
          // the model a small, bounded chance to continue from the durable
          // journal before exposing a terminal truncation to the user.
          if (!truncatedAnswer && !calls.length && truncatedRetryCount < 2) {
            truncatedRetryCount += 1;
            logicalRequestId = '';
            overflowFingerprint = '';
            reason = 'truncated_retry';
            continue;
          }
          // 截断响应里的调用不可信，不能执行。
          await deferRange(lease, calls, 0, 'OUTPUT_TRUNCATED', 'Provider stopped at maxOutputTokens; no calls from this response were executed');
          return terminal(lease, 'truncated', 'OUTPUT_TRUNCATED', truncatedAnswer, {
            usage: clone(response.usage || {}),
          });
        }
        if (response.finishReason === 'content_filter') {
          if (calls.length) await deferRange(lease, calls, 0, 'CONTENT_FILTERED', 'Provider content filter prevented safe call execution');
          return terminal(lease, 'blocked', 'CONTENT_FILTER', messages.contentText(response.content));
        }
        // 实际完成的工具调用是唯一跨 Provider 可靠的自动续跑事实；不要依赖
        // finishReason=tool_calls，因为兼容端点可能错误返回 stop。
        if (calls.length) {
          var toolOutcome = await processTools(lease, budgets, built, response);
          if (toolOutcome.state === 'cancelled') return terminal(lease, 'cancelled', toolOutcome.reason, '');
          if (toolOutcome.state === 'failed') return terminal(lease, 'failed', toolOutcome.reason, '');
          logicalRequestId = '';
          overflowFingerprint = '';
          reason = toolOutcome.reason || 'after_tool';
          continue;
        }
        if (response.finishReason === 'tool_calls') {
          throw loopError('PROVIDER_CONTRACT_ERROR', 'finishReason=tool_calls requires calls');
        }
        // Codex Responses 可明确声明本次响应尚未结束当前 turn。字段缺失时
        // 回退到通用规则：无工具、无待处理 steering 的普通 assistant 正文即最终回答。
        if (response.endTurn === false) {
          logicalRequestId = '';
          overflowFingerprint = '';
          reason = 'provider_follow_up';
          continue;
        }
        var answer = messages.contentText(response.content);
        if (!answer) {
          // commentary、偶发空响应或仅 reasoning 响应都不是最终回答；有界重试由
          // model request / iteration / wall-time 预算兜底。
          logicalRequestId = '';
          overflowFingerprint = '';
          reason = 'empty_response_retry';
          continue;
        }
        var completion = await terminal(lease, 'completed', 'assistant_answer', answer, {
          usage: clone(response.usage || {}),
        }, {
          expectedSteeringRevision: built.trace && built.trace.steeringRevision,
        });
        if (completion.pendingSteering) {
          logicalRequestId = '';
          overflowFingerprint = '';
          reason = 'after_steering';
          continue;
        }
        return completion;
      }
    }

    async function run(input, lease) {
      input = input || {};
      if (!lease || typeof lease.assertActive !== 'function' || typeof lease.finalize !== 'function') {
        throw new TypeError('AgentLoop.run requires a TurnCoordinator generation lease');
      }
      var budgets = normalizeBudgets(input.budgets);
      try {
        return await runMachine(input, lease, budgets);
      } catch (error) {
        if (error && (error.code === 'GENERATION_STALE' || error.code === 'RECOVERY_REQUIRED'
            || error.code === 'SERVICE_WORKER_TERMINATED')) throw error;
        try {
          var active = await lease.assertActive();
          if (active && active.inFlightTool) {
            var recovery = loopError('RECOVERY_REQUIRED', 'Generation stopped while a tool outcome requires reconciliation', { cause: error && error.code });
            recovery.cause = error;
            throw recovery;
          }
          if (error && error.code === 'CANCELLED' || lease.signal && lease.signal.aborted) {
            return terminal(lease, 'cancelled', 'cancelled', '');
          }
          return terminal(lease, 'failed', error && error.code || 'AGENT_LOOP_FAILED', '', {
            error: error && error.message || String(error), details: clone(error && error.details || {}),
          });
        } catch (finalizeError) {
          if (finalizeError && (finalizeError.code === 'GENERATION_STALE' || finalizeError.code === 'RECOVERY_REQUIRED')) throw finalizeError;
          throw error;
        }
      }
    }

    return Object.freeze({ API_VERSION: API_VERSION, run: run });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    FINISH_REASONS: FINISH_REASONS,
    create: create,
    createAgentLoop: create,
  });
});
