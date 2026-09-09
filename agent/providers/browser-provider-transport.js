// Native browser fetch/retry transport; retry/error behavior adapted from pi-mono (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachBrowserProviderTransport(root, factory) {
  'use strict';
  var utilities = typeof module === 'object' && module.exports
    ? require('./provider-utils')
    : root.BrowserProviderUtilities;
  var api = factory(root, utilities);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserProviderTransport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, utilities) {
  'use strict';

  var API_VERSION = 1;
  var KNOWN_ENDPOINT = /\/(?:chat\/completions|responses|messages)\/?$/i;
  var traceSequence = 0;

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function headersObject(headers) {
    var output = {};
    if (!headers) return output;
    if (typeof headers.forEach === 'function') {
      headers.forEach(function (value, key) { output[String(key)] = String(value); });
      return output;
    }
    Object.keys(headers).forEach(function (key) { output[key] = String(headers[key]); });
    return output;
  }

  function sanitizedHeaders(headers) {
    var source = headersObject(headers);
    var output = {};
    Object.keys(source).forEach(function (name) {
      var normalized = String(name || '').trim().toLowerCase().replace(/_/g, '-');
      if (/(?:^|-)(?:auth|authentication|authorization|api-?key|access-?key|subscription-?key|token|bearer|secret|credential|password|cookie|signature)(?:$|-)/.test(normalized)) return;
      output[name] = source[name];
    });
    return output;
  }

  function newTraceId() {
    var cryptoApi = root && root.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    traceSequence += 1;
    return 'api_' + Date.now().toString(36) + '_' + traceSequence.toString(36);
  }

  function errorValue(error) {
    if (!error) return null;
    var output = {};
    Object.getOwnPropertyNames(error).forEach(function (key) {
      var value = error[key];
      if (value === undefined || typeof value === 'function') return;
      try { output[key] = clone(value); } catch (_) { output[key] = String(value); }
    });
    if (!output.name) output.name = String(error.name || 'Error');
    if (!output.message) output.message = String(error.message || error);
    return output;
  }

  function parseSseEvents(rawBody) {
    var source = String(rawBody || '');
    if (!source || source.indexOf('data:') === -1) return [];
    return source.split(/\r?\n\r?\n/).map(function (frame) {
      if (!frame) return null;
      var eventName = '';
      var dataLines = [];
      var id = '';
      var retry = null;
      frame.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('event:') === 0) eventName = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^\s/, ''));
        else if (line.indexOf('id:') === 0) id = line.slice(3).trim();
        else if (line.indexOf('retry:') === 0) retry = Number(line.slice(6).trim()) || null;
      });
      if (!eventName && !dataLines.length && !id && retry === null) return null;
      var rawData = dataLines.join('\n');
      if (!eventName && rawData === '[DONE]') return null;
      var data = rawData;
      try { data = JSON.parse(rawData); } catch (_) {}
      var event = { event: eventName || 'message', data: data };
      if (id) event.id = id;
      if (retry !== null) event.retry = retry;
      return event;
    }).filter(Boolean);
  }

  function eventType(event) {
    return String(event && event.data && event.data.type || event && event.event || '');
  }

  function ensureIndexed(list, index, factory) {
    index = Math.max(0, Number(index) || 0);
    while (list.length <= index) list.push(null);
    if (!list[index]) list[index] = factory();
    return list[index];
  }

  function reconstructResponses(events) {
    var snapshot = null;
    var output = [];
    var matched = false;
    function mergeResponse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      var incoming = clone(value);
      var incomingOutput = Array.isArray(incoming.output) ? incoming.output : [];
      delete incoming.output;
      snapshot = Object.assign(snapshot || {}, incoming);
      if (incomingOutput.length) output = clone(incomingOutput);
    }
    function ensureOutput(index, type) {
      return ensureIndexed(output, index, function () {
        if (type === 'reasoning') return { type: 'reasoning', summary: [] };
        if (type === 'function_call') return { type: 'function_call', arguments: '' };
        return { type: 'message', role: 'assistant', content: [] };
      });
    }
    events.forEach(function (event) {
      var data = event && event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      var type = eventType(event);
      if (type.indexOf('response.') !== 0 && type !== 'error') return;
      matched = true;
      if (type === 'response.created' || type === 'response.in_progress') {
        mergeResponse(data.response);
      } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        if (data.item && typeof data.item === 'object') {
          ensureIndexed(output, data.output_index, function () { return {}; });
          output[Math.max(0, Number(data.output_index) || 0)] = clone(data.item);
        }
      } else if (type === 'response.output_text.delta' || type === 'response.output_text.done'
          || type === 'response.refusal.delta' || type === 'response.refusal.done') {
        var message = ensureOutput(data.output_index, 'message');
        if (!Array.isArray(message.content)) message.content = [];
        var contentIndex = Math.max(0, Number(data.content_index) || 0);
        var part = ensureIndexed(message.content, contentIndex, function () {
          return { type: type.indexOf('refusal') !== -1 ? 'refusal' : 'output_text', text: '' };
        });
        var field = type.indexOf('refusal') !== -1 ? 'refusal' : 'text';
        if (type.slice(-5) === '.done' && typeof data[field] === 'string') part[field] = data[field];
        else part[field] = String(part[field] || '') + String(data.delta || '');
      } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary_text.done'
          || type === 'response.reasoning_text.delta' || type === 'response.reasoning_text.done') {
        var reasoning = ensureOutput(data.output_index, 'reasoning');
        var collection = type.indexOf('summary') !== -1 ? 'summary' : 'content';
        if (!Array.isArray(reasoning[collection])) reasoning[collection] = [];
        var summaryIndex = Math.max(0, Number(data.summary_index !== undefined ? data.summary_index : data.content_index) || 0);
        var reasoningPart = ensureIndexed(reasoning[collection], summaryIndex, function () {
          return { type: collection === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
        });
        if (type.slice(-5) === '.done' && typeof data.text === 'string') reasoningPart.text = data.text;
        else reasoningPart.text = String(reasoningPart.text || '') + String(data.delta || '');
      } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        var call = ensureOutput(data.output_index, 'function_call');
        if (data.call_id) call.call_id = data.call_id;
        if (data.name) call.name = data.name;
        if (type.slice(-5) === '.done' && typeof data.arguments === 'string') call.arguments = data.arguments;
        else call.arguments = String(call.arguments || '') + String(data.delta || '');
      } else if (type === 'response.completed' || type === 'response.done'
          || type === 'response.incomplete' || type === 'response.failed') {
        mergeResponse(data.response);
      } else if (type === 'response.error' || type === 'error') {
        snapshot = Object.assign(snapshot || {}, { error: clone(data.error || data) });
      }
    });
    if (!matched || !snapshot) return null;
    if (output.length) snapshot.output = output.filter(function (item) { return item !== null; });
    else if (!Array.isArray(snapshot.output)) snapshot.output = [];
    return snapshot;
  }

  function reconstructAnthropic(events) {
    var snapshot = null;
    var matched = false;
    var partialJson = Object.create(null);
    events.forEach(function (event) {
      var data = event && event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      var type = eventType(event);
      if (type === 'message_start') {
        matched = true;
        snapshot = clone(data.message || {});
        if (!Array.isArray(snapshot.content)) snapshot.content = [];
      } else if (type === 'content_block_start') {
        matched = true;
        if (!snapshot) snapshot = { content: [] };
        if (!Array.isArray(snapshot.content)) snapshot.content = [];
        var startIndex = Math.max(0, Number(data.index) || 0);
        ensureIndexed(snapshot.content, startIndex, function () { return {}; });
        snapshot.content[startIndex] = clone(data.content_block || {});
      } else if (type === 'content_block_delta' && snapshot) {
        var index = Math.max(0, Number(data.index) || 0);
        var delta = data.delta || {};
        var block = ensureIndexed(snapshot.content, index, function () { return {}; });
        if (delta.type === 'text_delta') block.text = String(block.text || '') + String(delta.text || '');
        else if (delta.type === 'thinking_delta') block.thinking = String(block.thinking || '') + String(delta.thinking || '');
        else if (delta.type === 'signature_delta') block.signature = String(block.signature || '') + String(delta.signature || '');
        else if (delta.type === 'input_json_delta') partialJson[index] = String(partialJson[index] || '') + String(delta.partial_json || '');
      } else if (type === 'content_block_stop' && snapshot) {
        var stopIndex = Math.max(0, Number(data.index) || 0);
        if (partialJson[stopIndex] !== undefined) {
          try { snapshot.content[stopIndex].input = JSON.parse(partialJson[stopIndex]); }
          catch (_) { snapshot.content[stopIndex].input = partialJson[stopIndex]; }
          delete partialJson[stopIndex];
        }
      } else if (type === 'message_delta' && snapshot) {
        Object.assign(snapshot, clone(data.delta || {}));
        if (data.usage && typeof data.usage === 'object') {
          snapshot.usage = Object.assign({}, snapshot.usage || {}, clone(data.usage));
        }
      }
    });
    return matched ? snapshot : null;
  }

  function reconstructChatCompletions(events) {
    var snapshot = null;
    var choices = [];
    var matched = false;
    events.forEach(function (event) {
      var data = event && event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.choices)) return;
      matched = true;
      if (!snapshot) snapshot = { object: 'chat.completion', choices: [] };
      ['id', 'created', 'model', 'system_fingerprint', 'service_tier'].forEach(function (key) {
        if (data[key] !== undefined) snapshot[key] = clone(data[key]);
      });
      if (data.object && data.object !== 'chat.completion.chunk') snapshot.object = clone(data.object);
      if (data.usage) snapshot.usage = clone(data.usage);
      data.choices.forEach(function (choice, fallbackIndex) {
        var index = Math.max(0, Number(choice && choice.index) || fallbackIndex || 0);
        var stored = ensureIndexed(choices, index, function () {
          return { index: index, message: { role: 'assistant', content: '' }, finish_reason: null };
        });
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) stored.finish_reason = choice.finish_reason;
        if (choice.logprobs !== undefined) stored.logprobs = clone(choice.logprobs);
        var message = choice.message || choice.delta || {};
        if (message.role) stored.message.role = message.role;
        if (typeof message.content === 'string') stored.message.content = String(stored.message.content || '') + message.content;
        ['reasoning_content', 'reasoning', 'reasoning_text'].forEach(function (field) {
          if (typeof message[field] === 'string') stored.message[field] = String(stored.message[field] || '') + message[field];
        });
        if (Array.isArray(message.tool_calls)) {
          if (!Array.isArray(stored.message.tool_calls)) stored.message.tool_calls = [];
          message.tool_calls.forEach(function (toolDelta, toolFallbackIndex) {
            var toolIndex = Math.max(0, Number(toolDelta && toolDelta.index) || toolFallbackIndex || 0);
            var tool = ensureIndexed(stored.message.tool_calls, toolIndex, function () {
              return { index: toolIndex, type: 'function', function: { name: '', arguments: '' } };
            });
            if (toolDelta.id) tool.id = toolDelta.id;
            if (toolDelta.type) tool.type = toolDelta.type;
            var fn = toolDelta.function || {};
            if (fn.name) tool.function.name = fn.name;
            if (typeof fn.arguments === 'string') tool.function.arguments = String(tool.function.arguments || '') + fn.arguments;
          });
        }
      });
    });
    if (!matched || !snapshot) return null;
    snapshot.choices = choices.filter(function (choice) { return choice !== null; });
    return snapshot;
  }

  function reconstructSseBody(events) {
    return reconstructResponses(events)
      || reconstructAnthropic(events)
      || reconstructChatCompletions(events)
      || null;
  }

  async function captureResponse(response) {
    var headers = sanitizedHeaders(response && response.headers);
    var contentType = String(headers['content-type'] || headers['Content-Type'] || '');
    var rawBody = '';
    var captureError = null;
    var cloneResponse = null;
    try { cloneResponse = response && typeof response.clone === 'function' ? response.clone() : null; }
    catch (error) { captureError = errorValue(error); }
    if (cloneResponse && cloneResponse.body && typeof cloneResponse.body.getReader === 'function') {
      var reader = cloneResponse.body.getReader();
      var decoder = new TextDecoder();
      try {
        for (;;) {
          var part = await reader.read();
          if (part.done) break;
          var textPart = decoder.decode(part.value, { stream: true });
          rawBody += textPart;
        }
        var tail = decoder.decode();
        if (tail) {
          rawBody += tail;
        }
      } catch (error) {
        captureError = errorValue(error);
      }
    }
    var body = rawBody;
    if (/application\/(?:[^;]+\+)?json/i.test(contentType) || /^\s*[\[{]/.test(rawBody)) {
      try { body = rawBody ? JSON.parse(rawBody) : null; } catch (_) {}
    }
    var output = {
      status: Number(response && response.status) || 0,
      statusText: String(response && response.statusText || ''),
      headers: headers,
      body: body,
      rawBody: rawBody,
    };
    var events = /text\/event-stream/i.test(contentType) || rawBody.indexOf('data:') !== -1
      ? parseSseEvents(rawBody) : [];
    if (events.length) {
      output.sseEvents = events;
      var reconstructed = reconstructSseBody(events);
      if (reconstructed !== null) output.body = reconstructed;
    }
    if (captureError) output.captureError = captureError;
    return output;
  }

  function normalizeEndpoint(baseUrl, endpoint) {
    var base = String(baseUrl || '').trim();
    var suffix = String(endpoint || '').trim();
    if (!base) throw new Error('Provider baseUrl is required');
    if (!/^\/(?:chat\/completions|responses|messages)$/.test(suffix)) {
      throw new Error('Unknown provider endpoint: ' + suffix);
    }
    var parsed;
    try { parsed = new URL(base); }
    catch (_) { throw new Error('Provider baseUrl must be an absolute URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Provider baseUrl must use http or https');
    }
    var pathname = String(parsed.pathname || '').replace(/\/+$/, '');
    pathname = pathname.replace(KNOWN_ENDPOINT, '');
    parsed.pathname = (pathname || '') + suffix;
    parsed.hash = '';
    return parsed.toString();
  }

  function findHeaderKey(headers, name) {
    var expected = String(name || '').toLowerCase();
    return Object.keys(headers || {}).find(function (key) { return key.toLowerCase() === expected; }) || '';
  }

  function setHeader(headers, name, value, overwrite) {
    var existing = findHeaderKey(headers, name);
    if (value === null) {
      if (existing) delete headers[existing];
      return;
    }
    if (existing && overwrite !== true) return;
    if (existing && existing !== name) delete headers[existing];
    if (value !== undefined) headers[name] = String(value);
  }

  function mergeHeaders() {
    var output = {};
    for (var index = 0; index < arguments.length; index += 1) {
      var source = arguments[index];
      if (!source) continue;
      if (typeof source.forEach === 'function') {
        source.forEach(function (value, key) { setHeader(output, String(key), value, true); });
        continue;
      }
      Object.keys(source).forEach(function (key) { setHeader(output, key, source[key], true); });
    }
    return output;
  }

  function hasAuthorization(headers, names) {
    return (names || []).some(function (name) {
      var key = findHeaderKey(headers, name);
      return !!(key && String(headers[key] || '').trim());
    });
  }

  function openAiHeaders(options) {
    options = options || {};
    var headers = mergeHeaders({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }, options.serviceHeaders, options.headers);
    if (options.apiKey && !hasAuthorization(headers, ['authorization', 'cf-aig-authorization'])) {
      setHeader(headers, 'Authorization', 'Bearer ' + String(options.apiKey), true);
    }
    if (!options.apiKey && !hasAuthorization(headers, ['authorization', 'cf-aig-authorization'])) {
      throw new Error('OpenAI-compatible provider requires an API key or authorization header');
    }
    if (options.sessionId) {
      setHeader(headers, 'session_id', options.sessionId, false);
      setHeader(headers, 'x-client-request-id', options.sessionId, false);
      if (options.includeAffinityHeader) setHeader(headers, 'x-session-affinity', options.sessionId, false);
    }
    if (options.userAgent) setHeader(headers, 'User-Agent', options.userAgent, false);
    return headers;
  }

  function anthropicHeaders(options) {
    options = options || {};
    var headers = mergeHeaders({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, options.serviceHeaders, options.headers);
    if (options.apiKey && !hasAuthorization(headers, ['x-api-key', 'authorization', 'cf-aig-authorization'])) {
      setHeader(headers, 'x-api-key', options.apiKey, true);
    }
    if (!options.apiKey && !hasAuthorization(headers, ['x-api-key', 'authorization', 'cf-aig-authorization'])) {
      throw new Error('Anthropic provider requires an API key or authorization header');
    }
    if (options.sessionId) setHeader(headers, 'x-session-affinity', options.sessionId, false);
    if (options.userAgent) setHeader(headers, 'User-Agent', options.userAgent, false);
    return headers;
  }

  function createAbortScope(parentSignal, timeoutMs) {
    var controller = new AbortController();
    var timer = null;
    var listener = null;
    var closed = false;
    function abort(reason) {
      if (!controller.signal.aborted) {
        try { controller.abort(reason); } catch (_) { controller.abort(); }
      }
    }
    if (parentSignal) {
      if (parentSignal.aborted) abort(parentSignal.reason || new Error('Provider request aborted'));
      else {
        listener = function () { abort(parentSignal.reason || new Error('Provider request aborted')); };
        parentSignal.addEventListener('abort', listener, { once: true });
      }
    }
    var timeout = Math.max(1000, Math.min(Number(timeoutMs) || 120000, 10 * 60 * 1000));
    function armTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function () {
        var error = new Error('Provider request timed out after ' + timeout + 'ms of inactivity');
        error.name = 'TimeoutError';
        abort(error);
      }, timeout);
    }
    armTimer();
    return {
      signal: controller.signal,
      // 空闲超时语义：每收到流数据重置计时。固定整段超时会把长思考模型
      // （单轮流式远超 2 分钟）的正常回复整轮打断。
      touch: function () {
        if (!closed && !controller.signal.aborted) armTimer();
      },
      close: function () {
        closed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (parentSignal && listener) parentSignal.removeEventListener('abort', listener);
        listener = null;
      },
    };
  }

  function sleep(delayMs, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(utilities.normalizeError(null, signal)); return; }
      var timer = setTimeout(finish, Math.max(0, Number(delayMs) || 0));
      var listener = signal ? function () {
        clearTimeout(timer);
        signal.removeEventListener('abort', listener);
        reject(utilities.normalizeError(null, signal));
      } : null;
      function finish() {
        if (signal && listener) signal.removeEventListener('abort', listener);
        resolve();
      }
      if (signal && listener) signal.addEventListener('abort', listener, { once: true });
    });
  }

  async function responseError(response) {
    var bodyText = '';
    try { bodyText = await response.text(); } catch (_) {}
    var parsed = null;
    try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch (_) {}
    return new utilities.ProviderHttpError(response.status, response.statusText, bodyText, parsed);
  }

  function create(options) {
    options = options || {};
    var fetchImpl = options.fetch || root && root.fetch && root.fetch.bind(root);
    if (typeof fetchImpl !== 'function') throw new Error('BrowserProviderTransport requires fetch');
    var appendSessionEvent = typeof options.appendSessionEvent === 'function'
      ? options.appendSessionEvent : null;

    async function beginTrace(request, attempt) {
      // Standalone connection checks are not Conversation runs; generation requests
      // always provide the lease-backed append-only sink and trace identity.
      if (!appendSessionEvent || !request.trace || !request.trace.conversationId) return null;
      var startedAt = Date.now();
      var parsedUrl = new URL(request.url);
      var rawBody = typeof request.rawBody === 'string' ? request.rawBody : JSON.stringify(request.body || {});
      var context = request.trace || {};
      var capture = {
        trace_id: newTraceId(),
        conversation_id: String(context.conversationId || ''),
        generation_id: String(context.generationId || ''),
        turn_id: String(context.turnId || ''),
        model_request_id: String(context.modelRequestId || ''),
        logical_request_id: String(context.logicalRequestId || ''),
        purpose: String(context.purpose || 'main'),
        assistant_id: String(context.assistantId || ''),
        assistant_name: String(context.assistantName || ''),
        service_id: String(context.serviceId || ''),
        service_name: String(context.serviceName || ''),
        api_style: String(context.apiStyle || ''),
        model: String(context.model || ''),
      };
      capture.attempt = attempt + 1;
      capture.max_attempts = Math.max(1, Number(request.maxRetries) + 1 || 1);
      capture.status = 'running';
      var trace = {
        conversationId: String(request.trace.conversationId),
        startedAt: startedAt,
        capture: capture,
        responseCapture: null,
        finalized: null,
        request: {
          method: String(request.method || 'POST').toUpperCase(),
          path: parsedUrl.pathname + parsedUrl.search,
          url: parsedUrl.toString(),
          headers: sanitizedHeaders(request.headers),
          body: clone(request.body || {}),
          rawBody: rawBody,
        },
      };
      await appendSessionEvent(trace.conversationId, {
        type: 'provider_request_started',
        generationId: capture.generation_id,
        turnId: capture.turn_id,
        modelRequestId: capture.model_request_id,
        causationId: capture.model_request_id,
        correlationId: capture.trace_id,
        at: startedAt,
        payload: {
          source: 'provider', requestId: capture.trace_id,
          logicalRequestId: capture.logical_request_id,
          purpose: capture.purpose, attempt: capture.attempt, maxAttempts: capture.max_attempts,
          assistantId: capture.assistant_id, assistantName: capture.assistant_name,
          serviceId: capture.service_id, serviceName: capture.service_name,
          apiStyle: capture.api_style, model: capture.model,
          transport: 'fetch', upstreamBaseUrl: parsedUrl.origin,
          request: clone(trace.request),
        },
      });
      return trace;
    }

    function finishTrace(trace, status, normalizedResponse, error) {
      if (!trace) return Promise.resolve(null);
      if (trace.finalized) return trace.finalized;
      trace.finalized = Promise.resolve(trace.responseCapture).then(function (response) {
        response = response || { status: 0, headers: {}, body: null, rawBody: '' };
        if (normalizedResponse !== undefined) {
          response.derived = Object.assign({}, response.derived || {}, {
            normalizedResponse: clone(normalizedResponse),
          });
        }
        if (error) response.error = errorValue(error);
        var completedAt = Date.now();
        return appendSessionEvent(trace.conversationId, {
          type: status === 'completed' ? 'provider_response_completed' : 'provider_response_failed',
          generationId: trace.capture.generation_id,
          turnId: trace.capture.turn_id,
          modelRequestId: trace.capture.model_request_id,
          causationId: trace.capture.model_request_id,
          correlationId: trace.capture.trace_id,
          status: status,
          at: completedAt,
          payload: {
            source: 'provider', requestId: trace.capture.trace_id,
            logicalRequestId: trace.capture.logical_request_id,
            purpose: trace.capture.purpose, attempt: trace.capture.attempt,
            apiStyle: trace.capture.api_style, model: trace.capture.model,
            durationMs: Math.max(0, completedAt - trace.startedAt),
            response: response,
            error: error ? errorValue(error) : null,
          },
        });
      });
      return trace.finalized;
    }

    async function openJsonStream(request) {
      request = request || {};
      var scope = createAbortScope(request.signal, request.timeoutMs);
      var maxRetries = Math.max(0, Math.min(Number(request.maxRetries) || 0, 50));
      var lastError = null;
      try {
        for (var attempt = 0; attempt <= maxRetries; attempt += 1) {
          if (scope.signal.aborted) throw utilities.normalizeError(null, scope.signal);
          var response;
          var serializedBody = JSON.stringify(request.body || {});
          var trace = await beginTrace(Object.assign({ method: 'POST', rawBody: serializedBody }, request), attempt);
          try {
            response = await fetchImpl(request.url, {
              method: 'POST',
              headers: request.headers,
              body: serializedBody,
              signal: scope.signal,
            });
            if (trace) trace.responseCapture = captureResponse(response);
            if (!response.ok) {
              var httpError = await responseError(response);
              await finishTrace(trace, 'failed', undefined, httpError);
              lastError = httpError;
              if (attempt < maxRetries && httpError.retryable) {
                await sleep(utilities.retryDelayMs(attempt, response.headers, request.maxRetryDelayMs), scope.signal);
                continue;
              }
              throw httpError;
            }
            if (!response.body) throw new Error('Provider response has no stream body');
            if (typeof request.onResponse === 'function') {
              await request.onResponse({ status: response.status, headers: response.headers });
            }
            return {
              response: response,
              signal: scope.signal,
              touch: scope.touch,
              close: scope.close,
              completeTrace: function (result) { return finishTrace(trace, 'completed', result, null); },
              failTrace: function (error) { return finishTrace(trace, 'failed', undefined, error); },
            };
          } catch (error) {
            lastError = utilities.normalizeError(error, scope.signal);
            await finishTrace(trace, 'failed', undefined, lastError);
            if (attempt < maxRetries && utilities.isRetryableError(lastError)) {
              await sleep(utilities.retryDelayMs(attempt, response && response.headers, request.maxRetryDelayMs), scope.signal);
              continue;
            }
            throw lastError;
          }
        }
        throw lastError || new Error('Provider request failed');
      } catch (error) {
        scope.close();
        throw utilities.normalizeError(error, scope.signal);
      }
    }

    return Object.freeze({ openJsonStream: openJsonStream });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    normalizeEndpoint: normalizeEndpoint,
    mergeHeaders: mergeHeaders,
    hasAuthorization: hasAuthorization,
    openAiHeaders: openAiHeaders,
    anthropicHeaders: anthropicHeaders,
    create: create,
  });
});
