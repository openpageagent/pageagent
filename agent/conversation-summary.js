// The single structured, incremental SummaryCheckpoint pipeline.
(function attachConversationSummary(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var nodeCrypto = null;
  var projection = commonJs ? require('./tool-result-projection') : root.AgentToolResultProjection;
  if (commonJs) {
    try { nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  }
  var api = factory(root, projection, nodeCrypto);
  if (commonJs) module.exports = api;
  else root.ConversationSummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, projection, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;
  var PROMPT_VERSION = 'conversation-summary-v1';
  var SUMMARY_FIELDS = Object.freeze([
    'objective', 'constraints', 'decisions', 'verifiedFacts', 'completedActions',
    'pendingItems', 'failuresAndDoNotRepeat', 'resourceRefs',
  ]);
  var SUMMARY_JSON_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      objective: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      verifiedFacts: { type: 'array', items: { type: 'string' } },
      completedActions: { type: 'array', items: { type: 'string' } },
      pendingItems: { type: 'array', items: { type: 'string' } },
      failuresAndDoNotRepeat: { type: 'array', items: { type: 'string' } },
      resourceRefs: { type: 'array', items: { type: 'string' } },
    },
    required: SUMMARY_FIELDS.slice(),
    additionalProperties: false,
  });
  var SUMMARY_SYSTEM_PROMPT = [
    '你负责生成 Page Agent 的累计上下文摘要。只输出满足给定 JSON Schema 的 JSON，不调用任何工具。',
    '摘要是可重建投影，不是原始事实；只能保留输入中已有的信息，不能补写未经验证的成功。',
    '重点保留用户目标与约束、决定、已验证事实、已完成动作、待办、失败及不可重复原因、canonical resource URI。',
    '普通 reasoning、临时 UI 文案和冗长页面正文不应进入摘要，除非其中已经形成影响后续执行的明确决定或约束。',
    '页面操作录制正文和 Recording URI 由运行时单独确定性保留，不得写入摘要字段或 resourceRefs。',
    '旧 checkpoint 与新增前缀冲突时，以新增且有 Journal 证据的事实为准，并保留尚未解决的冲突。',
  ].join('\n');

  if (!projection || typeof projection.projectEventContent !== 'function') {
    throw new Error('AgentToolResultProjection must load before ConversationSummary');
  }

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function stable(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('Summary source cannot contain cycles');
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
    if (!cryptoApi || !cryptoApi.subtle || typeof TextEncoder !== 'function') throw new Error('SHA-256 is required for SummaryCheckpoint');
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function summaryError(code, message, details) {
    var error = new Error(message || code);
    error.name = 'ConversationSummaryError';
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }
  function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(function (part) {
      return part && typeof part === 'object' ? text(part.text || part.output_text || part.content) : text(part);
    }).filter(Boolean).join('\n');
  }
  function parseJsonOutput(response) {
    var raw = contentText(response && response.content);
    if (!raw && response && response.output !== undefined) raw = contentText(response.output);
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!raw) throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary model returned no JSON content');
    try { return JSON.parse(raw); }
    catch (_) { throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary model returned invalid JSON'); }
  }
  function normalizeStringArray(value, field) {
    if (!Array.isArray(value)) throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary field must be an array: ' + field);
    var seen = Object.create(null);
    return value.map(function (item) {
      if (typeof item !== 'string') throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary array items must be strings: ' + field);
      return item.trim();
    }).filter(function (item) {
      if (!item || seen[item]) return false;
      seen[item] = true;
      return true;
    }).slice(0, 200);
  }
  function normalizeSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary must be an object');
    Object.keys(value).forEach(function (key) {
      if (SUMMARY_FIELDS.indexOf(key) === -1) throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary contains unknown field: ' + key);
    });
    SUMMARY_FIELDS.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw summaryError('SUMMARY_SCHEMA_INVALID', 'Summary is missing field: ' + key);
    });
    if (typeof value.objective !== 'string') throw summaryError('SUMMARY_SCHEMA_INVALID', 'summary.objective must be a string');
    var output = { objective: value.objective.trim().slice(0, 12000) };
    SUMMARY_FIELDS.slice(1).forEach(function (key) { output[key] = normalizeStringArray(value[key], key); });
    output.resourceRefs = output.resourceRefs.filter(function (uri) { return uri.indexOf('/recordings/') !== 0; });
    return output;
  }
  function reasoningField(key) {
    return /(?:reasoning|thinking|thought|chain[_-]?of[_-]?thought|internal[_-]?monologue)/i.test(String(key || ''));
  }
  function reasoningNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var marker = value.type || value.kind || value.event;
    return /(?:reasoning|thinking|thought|chain[_-]?of[_-]?thought)/i.test(String(marker || ''));
  }
  function redactReasoning(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return '[Circular]';
    seen.push(value);
    var output;
    if (Array.isArray(value)) {
      output = value.filter(function (item) { return !reasoningNode(item); }).map(function (item) {
        return redactReasoning(item, seen);
      });
    } else {
      output = {};
      Object.keys(value).forEach(function (key) {
        if (reasoningField(key) || reasoningNode(value[key])) return;
        output[key] = redactReasoning(value[key], seen);
      });
    }
    seen.pop();
    return output;
  }
  function summaryModelEvent(value) {
    var event = clone(value || {});
    delete event.payloadRef;
    delete event.payloadStorage;
    if (event.type === 'reasoning_completed') {
      event.payload = {
        provider: text(event.payload && event.payload.provider),
        model: text(event.payload && event.payload.model),
        reasoningKind: text(event.payload && event.payload.reasoningKind),
        iteration: Number(event.payload && event.payload.iteration) || 0,
        visibility: 'redacted',
      };
      return event;
    }
    if (event.type === 'model_stream_delta' && event.payload && event.payload.phase === 'reasoning') {
      event.payload = { phase: 'reasoning', redacted: true };
      return event;
    }
    if (/^provider_(?:request_started|response_completed|response_failed)$/.test(text(event.type))) {
      var providerPayload = event.payload || {};
      event.payload = {
        source: 'provider',
        requestId: text(providerPayload.requestId),
        purpose: text(providerPayload.purpose),
        model: text(providerPayload.model),
        status: text(providerPayload.status || event.status),
        responseStatus: Number(providerPayload.response && providerPayload.response.status) || 0,
        errorCode: text(providerPayload.error && (providerPayload.error.code || providerPayload.error.errorCode)),
      };
      return event;
    }
    if (event.type === 'model_request_started') {
      var promptMessages = event.payload && event.payload.promptMessages;
      event.payload = {
        purpose: text(event.payload && event.payload.purpose) || 'main',
        promptGuidanceAppended: Array.isArray(promptMessages) && promptMessages.length > 0,
      };
      return event;
    }
    if (event.type === 'model_response_completed') {
      event.payload = redactReasoning(event.payload || {});
      event.payload.providerReplay = null;
      return event;
    }
    event.payload = redactReasoning(event.payload || {});
    if (/^tool_execution_(?:completed|failed|unknown)$/.test(text(event.type))
        && text(event.payload && event.payload.canonicalUri).indexOf('/recordings/') === 0) {
      event.payload = {
        name: text(event.payload && event.payload.name).toUpperCase() || 'GET',
        canonicalUri: text(event.payload && event.payload.canonicalUri),
        performed: text(event.payload && event.payload.performed),
        recordingBodyOmitted: true,
      };
      return event;
    }
    if (/^(?:tool_execution_completed|tool_execution_failed|tool_execution_unknown|tool_call_deferred)$/.test(text(event.type))) {
      var payload = event.payload || {};
      event.payload = {
        name: text(payload.name).toUpperCase(),
        canonicalUri: text(payload.canonicalUri),
        result: projection.projectEventContent(event),
      };
      return event;
    }
    if (event.type !== 'user_message_appended' && event.type !== 'steering_message_appended') return event;
    var payload = event.payload || {};
    var message = payload.message || null;
    if (!message || !Array.isArray(message.attachments)) return event;
    message.attachments = message.attachments.filter(function (attachment) {
      return !attachment || attachment.kind !== 'page-action-recording-range';
    });
    return event;
  }

  function resolveSummaryModel(service) {
    service = service || {};
    var mainModel = text(service.model);
    if (!mainModel) throw summaryError('SERVICE_NOT_FOUND', 'Model Service has no main model');
    var configured = text(service.summaryModel);
    return {
      serviceId: text(service.id || service.serviceId),
      resolvedSummaryModel: configured || mainModel,
      fallbackToMainModel: !configured,
      mainModel: mainModel,
    };
  }

  function selectBoundary(units, options) {
    options = options || {};
    units = Array.isArray(units) ? units : [];
    var previousThrough = Math.max(0, Number(options.previousThroughSequence) || 0);
    var userIndexes = [];
    units.forEach(function (unit, index) { if (unit.kind === 'user') userIndexes.push(index); });
    var keepTurns = Math.max(2, Number(options.keepRecentUserTurns) || 2);
    var protectedIndex = userIndexes.length >= keepTurns ? userIndexes[userIndexes.length - keepTurns] : 0;
    var maximum = -1;
    for (var index = 0; index < protectedIndex; index += 1) {
      var unit = units[index];
      if (!unit || unit.endSequence <= previousThrough || unit.inFlight || unit.unresolvedInteraction || unit.atomicComplete === false) continue;
      maximum = index;
    }
    if (maximum < 0) return null;
    return {
      throughSequence: units[maximum].endSequence,
      unitCount: maximum + 1,
      sourceUnits: units.slice(0, maximum + 1),
      recentUnits: units.slice(maximum + 1),
    };
  }

  function create(options) {
    options = options || {};
    var journal = options.journal;
    var providerGateway = options.providerGateway;
    if (!journal || typeof journal.putCheckpointAndCommit !== 'function') throw new TypeError('ConversationSummary requires a Journal');
    if (!providerGateway || typeof providerGateway.request !== 'function') throw new TypeError('ConversationSummary requires ProviderGateway.request');
    var requestBuilder = options.requestBuilder;
    if (typeof requestBuilder !== 'function') throw new TypeError('ConversationSummary requires the ContextBuilder summary request factory');
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var nextId = 0;
    var idGenerator = typeof options.idGenerator === 'function'
      ? options.idGenerator
      : function (prefix) { nextId += 1; return prefix + '_' + Number(clock()).toString(36) + '_' + nextId.toString(36); };
    var cryptoApi = options.crypto || root && root.crypto;
    var journalMaterializer = options.journalMaterializer || {
      retainedRecordingRefs: function (events, previous) {
        void events;
        return clone(previous && previous.retainedRecordingRefs || []);
      },
    };
    var maxAttempts = Math.max(1, Math.min(2, Number(options.maxAttempts) || 2));
    var timeoutMs = Math.max(1000, Math.min(600000, Number(options.timeoutMs) || 60000));
    var setTimer = typeof options.setTimer === 'function' ? options.setTimer
      : (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer
      : (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    var createAbortController = typeof options.createAbortController === 'function'
      ? options.createAbortController
      : function () { return typeof AbortController === 'function' ? new AbortController() : null; };
    var faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : null;

    function inject(point, details) {
      if (!faultInjector) return;
      var result = faultInjector(point, clone(details || {}));
      if (result instanceof Error) throw result;
      if (result === true) {
        var error = summaryError('SERVICE_WORKER_TERMINATED', 'Injected MV3 service-worker termination', { point: point });
        error.faultPoint = point;
        throw error;
      }
    }

    function requestWithTimeout(request, leaseSignal) {
      if (!setTimer) return providerGateway.request(request);
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = null;
        var controller = createAbortController();
        var requestSignal = controller && controller.signal || leaseSignal;
        var parentAbort = null;

        function cleanup() {
          if (timer !== null) {
            try { clearTimer(timer); } catch (_) {}
            timer = null;
          }
          if (leaseSignal && parentAbort && typeof leaseSignal.removeEventListener === 'function') {
            leaseSignal.removeEventListener('abort', parentAbort);
          }
        }
        function finish(error, value) {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(value);
        }
        function abortController(reason) {
          if (!controller || controller.signal.aborted) return;
          try { controller.abort(reason); } catch (_) { controller.abort(); }
        }

        if (leaseSignal) {
          parentAbort = function () {
            abortController(leaseSignal.reason || 'generation_cancelled');
            finish(summaryError('SUMMARY_ABORTED', 'Summary request was aborted with its generation'));
          };
          if (leaseSignal.aborted) {
            parentAbort();
            return;
          }
          if (typeof leaseSignal.addEventListener === 'function') {
            leaseSignal.addEventListener('abort', parentAbort, { once: true });
          }
        }

        timer = setTimer(function () {
          var error = summaryError('SUMMARY_TIMEOUT', 'Summary request exceeded its independent timeout', {
            timeoutMs: timeoutMs,
          });
          abortController(error);
          finish(error);
        }, timeoutMs);

        var timedRequest = Object.assign({}, request, {
          signal: requestSignal,
          summaryTimeoutMs: timeoutMs,
        });
        Promise.resolve().then(function () {
          return providerGateway.request(timedRequest);
        }).then(function (value) {
          finish(null, value);
        }, function (error) {
          finish(error);
        });
      });
    }

    async function advance(input) {
      input = input || {};
      var lease = input.lease;
      if (!lease || typeof lease.assertActive !== 'function' || typeof lease.append !== 'function') {
        throw new TypeError('Summary advance requires a generation lease');
      }
      var active = await lease.assertActive();
      if (active.summaryCircuitOpen) throw summaryError('SUMMARY_CIRCUIT_OPEN', 'Summary circuit breaker is open for this generation');
      var boundary = input.boundary || selectBoundary(input.units, {
        previousThroughSequence: input.previousCheckpoint && input.previousCheckpoint.throughSequence,
        keepRecentUserTurns: 2,
      });
      if (!boundary || !Number.isSafeInteger(boundary.throughSequence) || boundary.throughSequence <= 0) {
        throw summaryError('SUMMARY_BOUNDARY_UNAVAILABLE', 'No complete prefix is available for SummaryCheckpoint');
      }
      var previous = input.previousCheckpoint || null;
      if (previous && boundary.throughSequence <= previous.throughSequence) {
        throw summaryError('SUMMARY_BOUNDARY_UNAVAILABLE', 'SummaryCheckpoint cannot move backwards');
      }
      var sourceEvents = (Array.isArray(input.events) ? input.events : []).filter(function (event) {
        return event.sequence > (previous && previous.throughSequence || 0) && event.sequence <= boundary.throughSequence;
      });
      if (!sourceEvents.length) throw summaryError('SUMMARY_BOUNDARY_UNAVAILABLE', 'Summary prefix contains no new Journal events');
      var sourceHash = await sha256(sourceEvents, cryptoApi);
      var retainedRecordingRefs = journalMaterializer.retainedRecordingRefs(sourceEvents, previous);
      var model = resolveSummaryModel(input.service);
      var source = {
        schemaVersion: 1,
        previousCheckpoint: previous ? clone(previous.summary) : null,
        throughSequence: boundary.throughSequence,
        sourceHash: sourceHash,
        events: sourceEvents.map(summaryModelEvent),
      };
      var failures = 0;
      var lastError;
      for (var attempt = 1; attempt <= maxAttempts; attempt += 1) {
        var modelRequestId = idGenerator('summary_request');
        var requestActive = await lease.assertActive();
        await lease.append({
          type: 'summary_requested', modelRequestId: modelRequestId,
          payload: {
            throughSequence: boundary.throughSequence,
            previousCheckpointId: previous && previous.checkpointId || null,
            sourceHash: sourceHash,
            promptVersion: PROMPT_VERSION,
            serviceId: model.serviceId,
            resolvedSummaryModel: model.resolvedSummaryModel,
            fallbackToMainModel: model.fallbackToMainModel,
            timeoutMs: timeoutMs,
            attempt: attempt,
            contextTrace: clone(input.contextTrace || {}),
          },
        });
        inject('after_summary_requested', {
          conversationId: lease.conversationId,
          generationId: lease.generationId,
          modelRequestId: modelRequestId,
          throughSequence: boundary.throughSequence,
        });
        await lease.update({
          counters: Object.assign({}, requestActive.counters || {}, {
            summaryRequestCount: Math.max(0, Number(requestActive.counters && requestActive.counters.summaryRequestCount) || 0) + 1,
          }),
        });
        var request = requestBuilder({
          baseRequest: clone(input.request || {}),
          source: source,
          model: model,
          logicalRequestId: text(input.logicalRequestId) || idGenerator('summary_logical'),
          modelRequestId: modelRequestId,
          signal: lease.signal,
          contextTrace: clone(input.contextTrace || {}),
        });
        try {
          var response = await requestWithTimeout(request, lease.signal);
          await lease.assertActive();
          if (!response || response.finishReason !== 'stop') {
            throw summaryError('SUMMARY_PROVIDER_FAILED', 'Summary provider did not return a complete structured response', {
              finishReason: response && response.finishReason,
            });
          }
          var summary = normalizeSummary(parseJsonOutput(response));
          var checkpoint = {
            schemaVersion: 1,
            checkpointId: idGenerator('checkpoint'),
            conversationId: lease.conversationId,
            generationId: lease.generationId,
            runtimeInstanceId: lease.runtimeInstanceId,
            throughSequence: boundary.throughSequence,
            previousCheckpointId: previous && previous.checkpointId || null,
            summary: summary,
            retainedRecordingRefs: retainedRecordingRefs,
            sourceHash: sourceHash,
            promptVersion: PROMPT_VERSION,
            provider: {
              serviceId: model.serviceId,
              resolvedSummaryModel: model.resolvedSummaryModel,
              model: model.resolvedSummaryModel,
              fallbackToMainModel: model.fallbackToMainModel,
            },
            usage: clone(response.usage || {}),
            createdAt: Number(clock()),
          };
          var committed = await journal.putCheckpointAndCommit(checkpoint, {
            generationId: lease.generationId,
            turnId: lease.turnId,
            modelRequestId: modelRequestId,
            payload: {
              checkpointId: checkpoint.checkpointId,
              throughSequence: checkpoint.throughSequence,
              sourceHash: checkpoint.sourceHash,
              usage: checkpoint.usage,
              serviceId: model.serviceId,
              resolvedSummaryModel: model.resolvedSummaryModel,
              fallbackToMainModel: model.fallbackToMainModel,
            },
          }, {
            beforeCommit: function () {
              inject('inside_checkpoint_transaction', {
                conversationId: lease.conversationId,
                generationId: lease.generationId,
                checkpointId: checkpoint.checkpointId,
              });
            },
          });
          inject('after_checkpoint_transaction', {
            conversationId: lease.conversationId,
            generationId: lease.generationId,
            checkpointId: checkpoint.checkpointId,
          });
          return {
            checkpoint: checkpoint,
            event: committed.event,
            boundary: boundary,
            resolvedSummaryModel: model.resolvedSummaryModel,
            fallbackToMainModel: model.fallbackToMainModel,
          };
        } catch (error) {
          lastError = error;
          failures += 1;
          if (error && (error.code === 'GENERATION_STALE' || error.code === 'SERVICE_WORKER_TERMINATED'
              || lease.signal && lease.signal.aborted)) throw error;
          try {
            await lease.append({
              type: 'summary_failed', modelRequestId: modelRequestId,
              payload: {
                attempt: attempt, throughSequence: boundary.throughSequence,
                errorCode: error && error.code || 'SUMMARY_FAILED', error: error && error.message || String(error),
                oldCheckpointId: previous && previous.checkpointId || null,
              },
            });
          } catch (appendError) {
            if (appendError && (appendError.code === 'GENERATION_STALE'
                || appendError.code === 'SERVICE_WORKER_TERMINATED')) throw appendError;
          }
        }
      }
      if (failures >= maxAttempts) await lease.update({ summaryCircuitOpen: true });
      throw summaryError('SUMMARY_FAILED', 'SummaryCheckpoint failed; the prior checkpoint remains active', {
        attempts: failures,
        cause: lastError && lastError.message,
        oldCheckpointId: previous && previous.checkpointId || null,
      });
    }

    return Object.freeze({ API_VERSION: API_VERSION, advance: advance, forceSummary: advance });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    PROMPT_VERSION: PROMPT_VERSION,
    SUMMARY_FIELDS: SUMMARY_FIELDS,
    SUMMARY_JSON_SCHEMA: SUMMARY_JSON_SCHEMA,
    SUMMARY_SYSTEM_PROMPT: SUMMARY_SYSTEM_PROMPT,
    resolveSummaryModel: resolveSummaryModel,
    selectBoundary: selectBoundary,
    normalizeSummary: normalizeSummary,
    summaryModelEvent: summaryModelEvent,
    create: create,
  });
});
