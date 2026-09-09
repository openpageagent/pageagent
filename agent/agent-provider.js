// Canonical Provider Gateway for the three browser-native model protocols.
(function attachAgentProvider(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var api = factory(root, {
    chat: commonJs ? require('./providers/openai-chat-completions-provider') : root.OpenAIChatCompletionsProvider,
    responses: commonJs ? require('./providers/openai-responses-provider') : root.OpenAIResponsesProvider,
    anthropic: commonJs ? require('./providers/anthropic-messages-provider') : root.AnthropicMessagesProvider,
    messages: commonJs ? require('./providers/provider-message-normalizer') : root.ProviderMessageNormalizer,
    utilities: commonJs ? require('./providers/provider-utils') : root.BrowserProviderUtilities,
    modelSettings: commonJs ? require('../settings/model-settings') : root.ModelSettings,
  });
  if (commonJs) module.exports = api;
  else root.AgentProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, deps) {
  'use strict';

  var API_VERSION = 1;
  var CANONICAL_FINISH_REASONS = Object.freeze([
    'stop', 'tool_calls', 'length', 'content_filter', 'aborted', 'transport_error', 'context_overflow',
  ]);
  var PROVIDERS = Object.freeze({
    chat_completions: deps.chat,
    responses: deps.responses,
    anthropic: deps.anthropic,
  });
  var ProviderCompat = null;
  try { ProviderCompat = require('./providers/compat/index'); } catch (_) { ProviderCompat = root && root.ProviderCompat; }
  var CONTEXT_ERROR = /context[_ -]?(?:length|window)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|input (?:is )?too long|request too large|max(?:imum)?[_ -]?tokens[_ -]?exceeded/i;
  var CONTENT_FILTER_ERROR = /content[_ -]?filter|safety filter|sensitive content|model refused|refusal/i;
  var TOOL_ARGUMENT_ERROR = /tool arguments must finish|function call arguments|invalid tool arguments/i;

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function contractError(message, details) {
    var error = new Error(message || 'Provider contract violation');
    error.name = 'ProviderContractError';
    error.code = 'PROVIDER_CONTRACT_ERROR';
    error.details = details || {};
    return error;
  }
  function normalizeFinishReason(value) {
    value = text(value);
    if (CANONICAL_FINISH_REASONS.indexOf(value) === -1) {
      throw contractError('Unknown canonical Provider finish reason: ' + (value || 'missing'), { finishReason: value });
    }
    return value;
  }
  function normalizeUsage(raw, input, content, reasoning, commentary) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var present = raw && typeof raw === 'object' && Object.keys(raw).length > 0;
    var estimatedInput = Number(input && input.contextTrace && input.contextTrace.inputTokens) || 0;
    var outputText = [deps.messages.contentText(commentary), deps.messages.contentText(content), text(reasoning)].filter(Boolean).join('\n');
    var estimatedOutput = Math.max(0, Math.ceil(outputText.length / 4));
    var usage = {
      inputTokens: Math.max(0, Number(source.inputTokens) || (present ? 0 : estimatedInput)),
      outputTokens: Math.max(0, Number(source.outputTokens) || (present ? 0 : estimatedOutput)),
      reasoningTokens: Math.max(0, Number(source.reasoningTokens) || 0),
      cacheReadTokens: Math.max(0, Number(source.cacheReadTokens) || 0),
      cacheWriteTokens: Math.max(0, Number(source.cacheWriteTokens) || 0),
      estimated: source.estimated === true || !present,
    };
    usage.totalTokens = Math.max(0, Number(source.totalTokens) || usage.inputTokens + usage.outputTokens
      + usage.cacheReadTokens + usage.cacheWriteTokens);
    return usage;
  }
  function normalizeResponse(raw, input, service, model) {
    raw = raw || {};
    var finishReason = normalizeFinishReason(raw.finishReason);
    var calls;
    try { calls = deps.messages.normalizeCalls(Array.isArray(raw.calls) ? raw.calls : []); }
    catch (error) { throw contractError('Provider returned invalid completed tool arguments', { cause: error.message }); }
    if (finishReason === 'tool_calls' && !calls.length) {
      throw contractError('finishReason=tool_calls requires at least one complete call');
    }
    if (calls.length && finishReason === 'stop') finishReason = 'tool_calls';
    var content = deps.messages.contentParts(raw.content);
    var commentary = deps.messages.contentParts(raw.commentary);
    var reasoning = text(raw.reasoning);
    var serviceProtocol = service.protocol || service.apiStyle;
    var replay = clone(raw.replay || raw.providerReplay || { version: 1, apiStyle: serviceProtocol, serviceId: service.id, model: model, blocks: [] });
    return {
      schemaVersion: 1,
      modelRequestId: text(input.modelRequestId),
      content: content,
      commentary: commentary,
      reasoning: reasoning,
      calls: calls,
      finishReason: finishReason,
      endTurn: raw.endTurn === true ? true : (raw.endTurn === false ? false : undefined),
      usage: normalizeUsage(raw.usage, input, content, reasoning, commentary),
      providerReplay: replay,
      rawMeta: {
        apiStyle: serviceProtocol,
        serviceId: service.id,
        requestedModel: model,
        responseId: text(raw.responseId),
        responseModel: text(raw.responseModel),
        reasoningKind: text(raw.reasoningKind),
      },
    };
  }
  function classifyError(error, input) {
    error = error instanceof Error ? error : new Error(String(error));
    var message = text(error.message || error);
    var code = text(error.code || error.type).toLowerCase();
    var status = Number(error.status) || 0;
    if (error.code === 'PROVIDER_CONTRACT_ERROR' || TOOL_ARGUMENT_ERROR.test(message)) throw contractError(message, { cause: error.code || error.name });
    if (input && input.signal && input.signal.aborted || error.name === 'AbortError') {
      return { finishReason: 'aborted', errorCode: code || 'aborted', message: message || 'Provider request aborted', retryable: false };
    }
    if (status === 413 || CONTEXT_ERROR.test(code) || CONTEXT_ERROR.test(message)) {
      return { finishReason: 'context_overflow', errorCode: code || 'context_overflow', message: message, retryable: false };
    }
    if (CONTENT_FILTER_ERROR.test(code) || CONTENT_FILTER_ERROR.test(message)) {
      return { finishReason: 'content_filter', errorCode: code || 'content_filter', message: message, retryable: false };
    }
    return {
      finishReason: 'transport_error', errorCode: code || 'transport_error', message: message || 'Provider transport failed',
      retryable: deps.utilities && typeof deps.utilities.isRetryableError === 'function'
        ? deps.utilities.isRetryableError(error) : error.retryable === true,
      status: status,
    };
  }

  function createModelProvider(options) {
    options = options || {};
    var modelSettings = options.modelSettings || deps.modelSettings || root && root.ModelSettings;
    if (!modelSettings || typeof modelSettings.normalizeModelProtocol !== 'function') {
      throw new Error('ModelSettings must load before AgentProvider');
    }
    var service = options.service || {};
    var declaredProtocol = text(service.protocol || service.apiStyle);
    if (!declaredProtocol) throw new TypeError('Model service protocol is required');
    var protocol = modelSettings.normalizeModelProtocol(declaredProtocol);
    var implementation = PROVIDERS[protocol];
    if (!implementation || typeof implementation.create !== 'function') {
      throw new Error('No canonical provider implementation for protocol: ' + String(protocol));
    }
    return implementation.create({
      service: service,
      assistant: options.assistant || {},
      modelSettings: modelSettings,
      fetch: options.fetch || root && root.fetch && root.fetch.bind(root),
      resolveImageArtifact: options.resolveImageArtifact,
      appendSessionEvent: options.appendSessionEvent,
    });
  }

  function cacheVariant(input) {
    input = input || {};
    var service = input.service || {};
    var assistant = input.assistant || {};
    var protocol = text(service.protocol || service.apiStyle);
    if (deps.modelSettings && typeof deps.modelSettings.normalizeModelProtocol === 'function') {
      protocol = deps.modelSettings.normalizeModelProtocol(protocol);
    }
    var settings = assistant.settings || {};
    var actualModel = text(assistant.model || service.model);
    var assistantEffort = text(settings.reasoningEffort);
    var effort = assistantEffort && assistantEffort !== 'auto'
      ? assistantEffort : text(service.reasoningEffort);
    var explicitReasoning = !!(effort && effort !== 'auto' && effort !== 'none');
    var compatibility = ProviderCompat && typeof ProviderCompat.resolve === 'function'
      ? ProviderCompat.resolve(service, protocol) : null;
    var anthropicMaxTokensFloor = 0;
    if (protocol === 'anthropic' && explicitReasoning
        && !(compatibility && compatibility.target && compatibility.target.anthropicMaxTokens === 'requested')
        && deps.modelSettings && typeof deps.modelSettings.resolveAnthropicMaxTokens === 'function') {
      anthropicMaxTokensFloor = deps.modelSettings.resolveAnthropicMaxTokens(actualModel, effort, 1);
    }
    var endpointPath = protocol === 'responses' ? '/responses'
      : protocol === 'anthropic' ? '/messages' : '/chat/completions';
    var endpoint = String(service.baseUrl || '').replace(/\/+$/, '') + endpointPath;
    try {
      var parsedEndpoint = new URL(String(service.baseUrl || ''));
      var basePath = String(parsedEndpoint.pathname || '').replace(/\/+$/, '')
        .replace(/\/(?:chat\/completions|responses|messages)$/i, '');
      parsedEndpoint.pathname = (basePath || '') + endpointPath;
      parsedEndpoint.hash = '';
      endpoint = parsedEndpoint.toString();
    } catch (_) {}
    if (compatibility && typeof compatibility.endpoint === 'function') endpoint = compatibility.endpoint(endpoint);
    var variant = {
      protocol: protocol,
      serviceId: text(service.id || service.serviceId),
      model: actualModel,
      endpoint: endpoint,
      compatId: compatibility && compatibility.id || '',
      anthropicMaxTokensFloor: anthropicMaxTokensFloor,
    };
    return variant;
  }

  function create(options) {
    options = options || {};
    var resolveService = options.resolveService;
    var fixedService = options.service || null;
    if (typeof resolveService !== 'function' && !fixedService) throw new TypeError('ProviderGateway requires resolveService(serviceId)');
    var adapterFactory = typeof options.createAdapter === 'function'
      ? options.createAdapter
      : function (service, assistant) {
        return createModelProvider({
          service: service, assistant: assistant, modelSettings: options.modelSettings,
          fetch: options.fetch, resolveImageArtifact: options.resolveImageArtifact,
          appendSessionEvent: options.appendSessionEvent,
        });
      };
    var assistant = options.assistant || {};

    async function request(input) {
      input = input || {};
      var serviceId = text(input.serviceId);
      var service = fixedService ? clone(fixedService) : clone(await resolveService(serviceId));
      if (!service || !text(service.id || service.serviceId)) {
        var missing = new Error('Unknown Model Service: ' + serviceId); missing.code = 'SERVICE_NOT_FOUND'; throw missing;
      }
      service.id = text(service.id || service.serviceId);
      if (!serviceId || service.id !== serviceId) {
        var mismatch = new Error('ProviderGateway cannot switch Model Service for a request'); mismatch.code = 'SERVICE_NOT_FOUND'; throw mismatch;
      }
      var mainModel = text(assistant.model || service.model);
      var requestedModel = text(input.modelOverride || input.model || mainModel);
      if (input.purpose !== 'context_summary' && requestedModel !== mainModel) {
        throw contractError('Only purpose=context_summary may override a Model Service model');
      }
      if (!requestedModel) throw contractError('Provider request model is empty');
      service.model = requestedModel;
      var requestAssistant = Object.assign({}, clone(assistant), {
        model: requestedModel,
        settings: Object.assign({}, clone(assistant.settings || {}), {
          maxTokens: Math.max(1, Number(input.maxOutputTokens) || Number(assistant.settings && assistant.settings.maxTokens) || 4096),
        }),
      });
      var adapter = adapterFactory(service, requestAssistant, input);
      if (!adapter || typeof adapter.request !== 'function') throw contractError('Provider adapter does not expose request()');
      var contextTrace = input.contextTrace && typeof input.contextTrace === 'object' ? input.contextTrace : {};
      var adapterInput = Object.assign({}, input, {
        appendSessionEvent: typeof input.appendSessionEvent === 'function'
          ? input.appendSessionEvent : options.appendSessionEvent,
        providerTrace: {
          conversationId: text(input.conversationId || contextTrace.conversationId),
          generationId: text(input.generationId || contextTrace.generationId),
          turnId: text(input.turnId || contextTrace.turnId),
          modelRequestId: text(input.modelRequestId),
          logicalRequestId: text(input.logicalRequestId),
          purpose: text(input.purpose) || 'main',
          assistantId: text(requestAssistant.id),
          assistantName: text(requestAssistant.name),
          serviceId: service.id,
          serviceName: text(service.name),
          apiStyle: text(service.protocol || service.apiStyle),
          model: requestedModel,
        },
      });
      try {
        var raw = await adapter.request(adapterInput);
        return normalizeResponse(raw, input, service, requestedModel);
      } catch (error) {
        var classified = classifyError(error, input);
        return {
          schemaVersion: 1, modelRequestId: text(input.modelRequestId), content: [], commentary: [], reasoning: '', calls: [],
          finishReason: classified.finishReason,
          usage: normalizeUsage(null, input, [], '', []), providerReplay: null,
          rawMeta: { apiStyle: service.protocol || service.apiStyle, serviceId: service.id, requestedModel: requestedModel, error: classified },
        };
      }
    }

    return Object.freeze({ API_VERSION: API_VERSION, request: request });
  }

  var PROTOCOLS = Object.freeze(Object.keys(PROVIDERS));
  return Object.freeze({
    API_VERSION: API_VERSION,
    PROTOCOLS: PROTOCOLS,
    API_STYLES: PROTOCOLS,
    CANONICAL_FINISH_REASONS: CANONICAL_FINISH_REASONS,
    normalizeFinishReason: normalizeFinishReason,
    normalizeResponse: normalizeResponse,
    classifyError: classifyError,
    createModelProvider: createModelProvider,
    cacheVariant: cacheVariant,
    create: create,
  });
});
