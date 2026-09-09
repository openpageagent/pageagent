// Model Settings helpers — shared service normalization for model nodes and Conversation.
(function attachModelSettings(root, factory) {
  var api = factory();
  root.ModelSettings = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, function () {
  'use strict';

  var SETTINGS_KEY = 'model_settings';
  var DEFAULT_MAX_CONTEXT_TOKENS = 1000000;
  var MAX_CONTEXT_TOKENS_LIMIT = 1000000;
  // 网络错误/429/5xx/流中断等瞬时故障的自动重试（带退避、尊重 Retry-After）。
  // 配额与账单类错误不重试（见 provider-utils 的 NON_RETRYABLE_LIMIT）。
  var DEFAULT_MAX_RETRIES = 15;
  var MAX_RETRIES_LIMIT = 50;
  var MODEL_PROTOCOLS = {
    chat_completions: true,
    responses: true,
    anthropic: true,
  };
  var REASONING_EFFORTS = {
    auto: true,
    none: true,
    minimal: true,
    low: true,
    medium: true,
    high: true,
    xhigh: true,
    max: true,
  };
  var ANTHROPIC_EFFORT_BETA = 'effort-2025-11-24';
  function normalizePositiveInt(value, fallback, max) {
    if (value === '' || value === null || value === undefined) return fallback;
    var n = Math.floor(Number(value));
    if (!isFinite(n) || n < 0) return fallback;
    if (max) n = Math.min(n, max);
    return n;
  }

  function normalizeMaxContextTokens(value) {
    return normalizePositiveInt(value, DEFAULT_MAX_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS_LIMIT);
  }

  function normalizeReasoningEffort(value) {
    var text = String(value || '').trim().toLowerCase();
    if (!text || text === 'default') return 'auto';
    if (text === 'x-high' || text === 'x_high') text = 'xhigh';
    if (!/^[a-z0-9_-]+$/.test(text)) return 'auto';
    return REASONING_EFFORTS[text] ? text : 'auto';
  }

  function normalizeModelProtocol(value) {
    var style = String(value || '').trim();
    if (!style) return 'chat_completions';
    // 存量配置可能带有旧版/手改的脏值；normalize 同时服务于读取路径，
    // 抛错会让 resolveService 对该服务永久失败，此处回退默认协议。
    if (!MODEL_PROTOCOLS[style]) return 'chat_completions';
    return style;
  }

  // Compatibility aliases for callers and stored configurations from before
  // the protocol field was introduced.
  function normalizeModelApiStyle(value) {
    return normalizeModelProtocol(value);
  }

  function normalizeProviderHeaders(value) {
    if (value === undefined || value === null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('模型服务 headers 必须是对象');
    var output = {};
    Object.keys(value).forEach(function (name) {
      var normalizedName = String(name || '').trim();
      if (!normalizedName || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(normalizedName)) {
        throw new TypeError('模型服务 header 名无效: ' + normalizedName);
      }
      if (value[name] === null) output[normalizedName] = null;
      else {
        var headerValue = String(value[name] === undefined ? '' : value[name]);
        if (/[\r\n]/.test(headerValue)) throw new TypeError('模型服务 header 值不能包含换行: ' + normalizedName);
        output[normalizedName] = headerValue;
      }
    });
    return output;
  }

  function normalizeUserAgent(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 512);
  }

  function normalizeContextCompression(value) {
    return String(value || '').trim() === 'off' ? 'off' : 'auto';
  }

  function autoCompactTokenLimit(maxContextTokens, configuredLimit) {
    var maxTokens = normalizePositiveInt(maxContextTokens, 0, 2000000);
    var explicitLimit = normalizePositiveInt(configuredLimit, 0, 2000000);
    if (!maxTokens) return explicitLimit;
    var defaultLimit = Math.floor(maxTokens * 0.9);
    return explicitLimit > 0 ? Math.min(explicitLimit, defaultLimit) : defaultLimit;
  }

  function makeServiceId() {
    return 'svc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function isDeprecatedFlowService(service) {
    service = service || {};
    return service.builtin === true ||
      !!service.builtinFlowId ||
      /^builtin[_-]/i.test(String(service.id || '').trim()) ||
      String(service.providerType || service.provider_type || service.reasoningProviderType || '').trim().toLowerCase() === 'builtin' ||
      String(service.providerType || service.provider_type || service.reasoningProviderType || '').trim().toLowerCase() === 'builtin-flow' ||
      String(service.providerType || service.provider_type || service.reasoningProviderType || '').trim().toLowerCase() === 'flow';
  }

  function serviceHasValue(service) {
    if (!service) return false;
    if (isDefaultPlaceholderService(service)) return false;
    return !!(
      service.name || service.baseUrl || service.apiKey || service.model || service.visionModel || service.summaryModel || service.userAgent
      || (service.protocol && service.protocol !== 'chat_completions')
      || (service.apiStyle && service.apiStyle !== 'chat_completions')
      || (service.maxContextTokens && service.maxContextTokens !== DEFAULT_MAX_CONTEXT_TOKENS)
      || service.autoCompactTokenLimit
      || (service.reasoningEffort && service.reasoningEffort !== 'auto')
      || Object.keys(service.headers || {}).length
      || (service.requestTimeoutMs && service.requestTimeoutMs !== 120000)
      || (service.maxRetries !== undefined && service.maxRetries !== DEFAULT_MAX_RETRIES)
    );
  }

  function isDefaultPlaceholderService(service) {
    if (!service) return false;
    return service.id === 'default'
      && String(service.name || '').trim() === '默认服务'
      && !String(service.baseUrl || '').trim()
      && !String(service.apiKey || '').trim()
      && !String(service.model || '').trim()
      && !String(service.visionModel || '').trim()
      && !String(service.summaryModel || '').trim()
      && !String(service.userAgent || '').trim()
      && normalizeModelProtocol(service.protocol || service.apiStyle || service.api_style) === 'chat_completions'
      && normalizeMaxContextTokens(service.maxContextTokens) === DEFAULT_MAX_CONTEXT_TOKENS
      && !normalizePositiveInt(service.autoCompactTokenLimit || service.auto_compact_token_limit, 0, 2000000)
      && normalizeReasoningEffort(service.reasoningEffort || service.reasoning_effort) === 'auto'
      && !Object.keys(normalizeProviderHeaders(service.headers)).length
      && normalizeRequestTimeoutMs(service.requestTimeoutMs || service.timeoutMs) === 120000
      && normalizePositiveInt(service.maxRetries, DEFAULT_MAX_RETRIES, MAX_RETRIES_LIMIT) === DEFAULT_MAX_RETRIES
      && normalizeContextCompression(service.contextCompression) === 'auto';
  }

  function serviceDisplayName(service) {
    service = service || {};
    var name = String(service.name || '').trim();
    if (name) return name;
    var model = String(service.model || '').trim();
    if (model) return model;
    var baseUrl = String(service.baseUrl || '').trim();
    if (baseUrl) return baseUrl;
    return '未命名服务';
  }

  function normalizeService(service, fallbackId, fallbackName) {
    service = service && typeof service === 'object' ? service : {};
    if (isDeprecatedFlowService(service)) return null;
    var id = String(service.id || fallbackId || makeServiceId()).trim();
    return {
      id: id,
      name: String(service.name || fallbackName || '').trim(),
      baseUrl: String(service.baseUrl || '').trim(),
      apiKey: String(service.apiKey || '').trim(),
      model: String(service.model || '').trim(),
      visionModel: String(service.visionModel || '').trim(),
      summaryModel: String(service.summaryModel || '').trim(),
      protocol: normalizeModelProtocol(service.protocol || service.apiStyle || service.api_style || service.callStyle || service.call_style),
      userAgent: normalizeUserAgent(service.userAgent || service.user_agent),
      maxContextTokens: normalizeMaxContextTokens(service.maxContextTokens),
      autoCompactTokenLimit: normalizePositiveInt(service.autoCompactTokenLimit || service.auto_compact_token_limit, 0, 2000000),
      reasoningEffort: normalizeReasoningEffort(service.reasoningEffort || service.reasoning_effort),
      headers: normalizeProviderHeaders(service.headers),
      requestTimeoutMs: normalizeRequestTimeoutMs(service.requestTimeoutMs || service.timeoutMs),
      maxRetries: normalizePositiveInt(service.maxRetries, DEFAULT_MAX_RETRIES, MAX_RETRIES_LIMIT),
      maxRetryDelayMs: normalizePositiveInt(service.maxRetryDelayMs, 60000, 10 * 60 * 1000),
      contextCompression: normalizeContextCompression(service.contextCompression),
    };
  }

  function legacyService(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return normalizeService({
      id: 'default',
      name: raw.name || '默认服务',
      baseUrl: raw.baseUrl,
      apiKey: raw.apiKey,
      model: raw.model,
      visionModel: raw.visionModel,
      summaryModel: raw.summaryModel,
      protocol: raw.protocol || raw.apiStyle || raw.api_style,
      userAgent: raw.userAgent || raw.user_agent,
      headers: raw.headers,
      requestTimeoutMs: raw.requestTimeoutMs || raw.timeoutMs,
      maxRetries: raw.maxRetries,
      maxRetryDelayMs: raw.maxRetryDelayMs,
    }, 'default', '默认服务');
  }

  function normalizeServices(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var input = [];
    if (Array.isArray(raw.services)) {
      input = raw.services;
    } else if (raw.services && typeof raw.services === 'object') {
      input = Object.keys(raw.services).map(function (id) {
        return Object.assign({ id: id }, raw.services[id] || {});
      });
    }

    var seen = {};
    var services = input.map(function (item, index) {
      var fallbackId = index === 0 ? 'default' : makeServiceId();
      var service = normalizeService(item, fallbackId, index === 0 ? '默认服务' : '');
      if (!service) return null;
      if (!service.id || seen[service.id]) service.id = makeServiceId();
      seen[service.id] = true;
      return service;
    }).filter(function (service) {
      if (!service) return false;
      return service.id && serviceHasValue(service);
    });

    if (!services.length && (raw.baseUrl || raw.apiKey || raw.model || raw.visionModel || raw.summaryModel)) {
      var legacy = legacyService(raw);
      if (legacy && serviceHasValue(legacy)) services.push(legacy);
    }
    return services;
  }

  function findService(services, serviceId) {
    var id = String(serviceId || '').trim();
    if (!id) return null;
    for (var i = 0; i < (services || []).length; i++) {
      if (services[i] && services[i].id === id) return services[i];
    }
    return null;
  }

  function normalizeSettings(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var services = normalizeServices(raw);
    var defaultServiceId = String(raw.defaultServiceId || raw.activeServiceId || '').trim();
    if (!defaultServiceId && !Array.isArray(raw.services) && !(raw.services && typeof raw.services === 'object') && (raw.baseUrl || raw.apiKey || raw.model || raw.visionModel || raw.summaryModel)) {
      defaultServiceId = String(raw.serviceId || 'default').trim();
    }
    var defaultService = findService(services, defaultServiceId);
    if (defaultServiceId && !defaultService) {
      defaultServiceId = services[0] && services[0].id || '';
    }

    var generatorServiceId = String(raw.generatorServiceId || '').trim();
    if (!findService(services, generatorServiceId)) {
      generatorServiceId = defaultServiceId;
    }

    defaultService = findService(services, defaultServiceId) || {};
    return {
      version: 3,
      services: services,
      defaultServiceId: defaultServiceId,
      generatorServiceId: generatorServiceId,
      baseUrl: defaultService.baseUrl || '',
      apiKey: defaultService.apiKey || '',
      model: defaultService.model || '',
      visionModel: defaultService.visionModel || '',
      summaryModel: defaultService.summaryModel || '',
      protocol: defaultService.protocol || 'chat_completions',
      userAgent: defaultService.userAgent || '',
      maxContextTokens: defaultService.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
      autoCompactTokenLimit: defaultService.autoCompactTokenLimit || 0,
      reasoningEffort: defaultService.reasoningEffort || 'auto',
      contextCompression: defaultService.contextCompression || 'auto',
      updatedAt: Number(raw.updatedAt || 0) || Date.now(),
    };
  }

  function getService(settings, serviceId, fallbackToDefault) {
    settings = normalizeSettings(settings);
    var service = findService(settings.services, serviceId);
    if (!service && fallbackToDefault !== false) {
      service = findService(settings.services, settings.defaultServiceId) || settings.services[0] || null;
    }
    return service ? normalizeService(service, service.id, service.name) : null;
  }

  function getDefaultService(settings) {
    settings = normalizeSettings(settings);
    return settings.defaultServiceId ? getService(settings, settings.defaultServiceId, false) : null;
  }

  function getGeneratorService(settings) {
    settings = normalizeSettings(settings);
    return getService(settings, settings.generatorServiceId, true);
  }

  function isServiceConfigured(service) {
    service = service || {};
    return !!(String(service.baseUrl || '').trim() && String(service.model || '').trim());
  }

  function safeJson(value) {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function textFromContent(content) {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (part) {
        if (part === undefined || part === null) return null;
        if (typeof part === 'string') return part;
        if (typeof part === 'number' || typeof part === 'boolean') return String(part);
        if (part.type === 'text') return part.text === undefined || part.text === null ? '' : String(part.text);
        if (part.type === 'input_text') return part.text === undefined || part.text === null ? '' : String(part.text);
        if (part.type === 'image_url') return '[image_url]';
        if (part.type === 'input_image') return '[image]';
        return safeJson(part);
      }).filter(function (part) { return part !== null && part !== undefined; }).join('\n');
    }
    return safeJson(content);
  }

  function utf8ByteLength(text) {
    text = String(text || '');
    if (!text) return 0;
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    try {
      return unescape(encodeURIComponent(text)).length;
    } catch (_) {
      return text.length;
    }
  }

  function estimateTextTokens(text) {
    var bytes = utf8ByteLength(text);
    return bytes ? Math.ceil(bytes / 4) : 0;
  }

  function estimateMessageTokens(message) {
    if (!message) return 0;
    var tokens = 6 + estimateTextTokens(message.role || '');
    tokens += estimateTextTokens(textFromContent(message.content));
    var toolCalls = message.calls;
    if (Array.isArray(toolCalls) && toolCalls.length) tokens += estimateTextTokens(safeJson(toolCalls));
    if (message.providerReplay) tokens += estimateTextTokens(safeJson(message.providerReplay));
    if (message.name) tokens += estimateTextTokens(message.name);
    if (message.toolCallId || message.id) tokens += estimateTextTokens(message.toolCallId || message.id);
    return tokens;
  }

  function estimateMessagesTokens(messages) {
    return (Array.isArray(messages) ? messages : []).reduce(function (sum, message) {
      return sum + estimateMessageTokens(message);
    }, 0);
  }

  function mapResponsesReasoningEffort(effort) {
    return effort === 'none' || effort === 'minimal' || effort === 'low' || effort === 'medium'
      || effort === 'high' || effort === 'xhigh' || effort === 'max'
      ? effort
      : '';
  }

  function anthropicThinkingBudget(effort) {
    if (effort === 'minimal') return 1024;
    if (effort === 'low') return 2048;
    if (effort === 'medium') return 8192;
    if (effort === 'high') return 16384;
    if (effort === 'xhigh' || effort === 'max') return 32768;
    return 0;
  }

  function anthropicSupportsEffort(model) {
    model = String(model || '').toLowerCase();
    if (model.indexOf('opus-4-6') >= 0 || model.indexOf('sonnet-4-6') >= 0) return true;
    if (model.indexOf('haiku') >= 0 || model.indexOf('sonnet') >= 0 || model.indexOf('opus') >= 0) return false;
    return true;
  }

  function anthropicSupportsMaxEffort(model) {
    return String(model || '').toLowerCase().indexOf('opus-4-6') >= 0;
  }

  function mapAnthropicReasoningEffort(effort, model) {
    if (effort === 'minimal' || effort === 'low') return 'low';
    if (effort === 'medium' || effort === 'high') return effort;
    if (effort === 'xhigh' || effort === 'max') return anthropicSupportsMaxEffort(model) ? 'max' : 'high';
    return '';
  }

  function resolveAnthropicMaxTokens(model, effort, requestedMaxTokens) {
    var maxTokens = Math.max(1, Math.floor(Number(requestedMaxTokens) || 4096));
    effort = normalizeReasoningEffort(effort);
    if (effort !== 'none' && effort !== 'auto' && !anthropicSupportsEffort(model)) {
      var thinkingBudget = anthropicThinkingBudget(effort);
      if (thinkingBudget > 0) maxTokens = Math.max(maxTokens, thinkingBudget + 1024);
    }
    return maxTokens;
  }

  function setIfMissing(body, key, value) {
    if (!body || Object.prototype.hasOwnProperty.call(body, key)) return false;
    body[key] = value;
    return true;
  }

  function setNestedIfMissing(body, key, nestedKey, value) {
    if (!body) return false;
    var current = body[key];
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
    else current = Object.assign({}, current);
    if (Object.prototype.hasOwnProperty.call(current, nestedKey)) return false;
    current[nestedKey] = value;
    body[key] = current;
    return true;
  }

  function applyChatReasoningControl(body, effort, applied) {
    delete body.reasoning;
    delete body.thinking;
    delete body.enable_thinking;
    delete body.thinking_budget;
    if (!effort || effort === 'auto') {
      delete body.reasoning_effort;
      return;
    }
    if (setIfMissing(body, 'reasoning_effort', effort) && Array.isArray(applied)) applied.push('reasoning_effort');
  }

  function applyReasoningEffortToBody(body, service, options) {
    body = body || {};
    service = service || {};
    options = options || {};
    var effort = normalizeReasoningEffort(options.reasoningEffort || service.reasoningEffort || service.reasoning_effort);
    var apiStyle = normalizeModelProtocol(options.protocol || options.apiStyle
      || service.protocol || service.apiStyle || service.api_style);
    var applied = [];
    if (!effort || effort === 'auto') {
      if (apiStyle === 'chat_completions') applyChatReasoningControl(body, effort, applied);
      return { body: body, apiStyle: apiStyle, reasoningEffort: effort, applied: applied };
    }
    if (apiStyle === 'responses') {
      var responsesEffort = mapResponsesReasoningEffort(effort);
      if (responsesEffort && setNestedIfMissing(body, 'reasoning', 'effort', responsesEffort)) applied.push('reasoning.effort');
      return {
        body: body, apiStyle: apiStyle, reasoningEffort: effort,
        mappedReasoningEffort: responsesEffort, applied: applied,
      };
    }
    if (apiStyle === 'anthropic') {
      if (effort === 'none') {
        if (setIfMissing(body, 'thinking', { type: 'disabled' })) applied.push('thinking');
        return { body: body, apiStyle: apiStyle, reasoningEffort: effort, applied: applied };
      }
      var anthropicModel = String(body.model || service.model || '');
      if (anthropicSupportsEffort(anthropicModel)) {
        var anthropicEffort = mapAnthropicReasoningEffort(effort, anthropicModel);
        if (setIfMissing(body, 'thinking', { type: 'adaptive' })) applied.push('thinking');
        if (anthropicEffort && setNestedIfMissing(body, 'output_config', 'effort', anthropicEffort)) applied.push('output_config.effort');
        return {
          body: body, apiStyle: apiStyle, reasoningEffort: effort,
          mappedReasoningEffort: anthropicEffort, anthropicBeta: anthropicEffort ? ANTHROPIC_EFFORT_BETA : '', applied: applied,
        };
      }
      var anthropicBudget = anthropicThinkingBudget(effort);
      if (anthropicBudget > 0 && setIfMissing(body, 'thinking', { type: 'enabled', budget_tokens: anthropicBudget })) {
        applied.push('thinking');
      }
      if (anthropicBudget > 0) body.max_tokens = resolveAnthropicMaxTokens(anthropicModel, effort, body.max_tokens);
      return {
        body: body, apiStyle: apiStyle, reasoningEffort: effort,
        mappedThinkingBudget: anthropicBudget, applied: applied,
      };
    }
    // Chat Completions emits the OpenAI-standard reasoning_effort field.
    // Provider-specific thinking controls belong to provider compat adapters.
    applyChatReasoningControl(body, effort, applied);
    return { body: body, apiStyle: apiStyle, reasoningEffort: effort, applied: applied };
  }

  function prepareChatCompletionRequest(body, service, options) {
    body = Object.assign({}, body || {});
    service = service || {};
    options = options || {};
    var reasoningMeta = applyReasoningEffortToBody(body, service, options);
    var maxContextTokens = normalizePositiveInt(
      options.maxContextTokens !== undefined ? options.maxContextTokens : service.maxContextTokens,
      0,
      2000000
    );
    var compression = normalizeContextCompression(options.contextCompression || service.contextCompression);
    var meta = {
      maxContextTokens: maxContextTokens,
      reasoningEffort: reasoningMeta.reasoningEffort,
      mappedReasoningEffort: reasoningMeta.mappedReasoningEffort || '',
      mappedThinkingBudget: reasoningMeta.mappedThinkingBudget || 0,
      anthropicBeta: reasoningMeta.anthropicBeta || '',
      reasoningFields: reasoningMeta.applied || [],
      contextCompression: compression,
      compacted: false,
    };
    return { body: body, meta: meta };
  }

  function buildChatCompletionsUrl(baseUrl) {
    var base = String(baseUrl || '').trim();
    if (!base) return '';
    if (typeof URL === 'function') {
      try {
        var parsed = new URL(base);
        var pathname = String(parsed.pathname || '').replace(/\/+$/, '');
        if (!/\/chat\/completions$/i.test(pathname)) pathname += '/chat/completions';
        parsed.pathname = pathname || '/chat/completions';
        return parsed.toString();
      } catch (_) {}
    }
    var suffixIndex = base.search(/[?#]/);
    var path = suffixIndex === -1 ? base : base.slice(0, suffixIndex);
    var suffix = suffixIndex === -1 ? '' : base.slice(suffixIndex);
    path = path.replace(/\/+$/, '');
    if (!/\/chat\/completions$/i.test(path)) path += '/chat/completions';
    return path + suffix;
  }

  function buildModelEndpointUrl(baseUrl, protocol) {
    var style = normalizeModelProtocol(protocol);
    var base = String(baseUrl || '').trim();
    if (!base) return '';
    var endpoint = style === 'anthropic' ? '/messages' : (style === 'responses' ? '/responses' : '/chat/completions');
    var knownEndpointPattern = /\/(?:chat\/completions|responses|messages)$/i;
    if (typeof URL === 'function') {
      try {
        var parsed = new URL(base);
        var pathname = String(parsed.pathname || '').replace(/\/+$/, '');
        pathname = pathname.replace(knownEndpointPattern, '');
        pathname += endpoint;
        parsed.pathname = pathname || endpoint;
        return parsed.toString();
      } catch (_) {}
    }
    var suffixIndex = base.search(/[?#]/);
    var path = suffixIndex === -1 ? base : base.slice(0, suffixIndex);
    var suffix = suffixIndex === -1 ? '' : base.slice(suffixIndex);
    path = path.replace(/\/+$/, '');
    path = path.replace(knownEndpointPattern, '') + endpoint;
    return path + suffix;
  }

  function copyHeaders(headers) {
    var out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function') {
      headers.forEach(function (value, key) { out[String(key)] = String(value); });
      return out;
    }
    Object.keys(headers).forEach(function (key) {
      var value = headers[key];
      if (value !== undefined && value !== null) out[key] = String(value);
    });
    return out;
  }

  function appendHeaderToken(headers, name, token) {
    headers = headers || {};
    name = String(name || '').trim();
    token = String(token || '').trim();
    if (!name || !token) return headers;
    var existingKey = Object.keys(headers).find(function (key) {
      return String(key).toLowerCase() === name.toLowerCase();
    });
    var key = existingKey || name;
    var values = String(headers[key] || '').split(',').map(function (item) { return item.trim(); }).filter(Boolean);
    if (values.indexOf(token) === -1) values.push(token);
    headers[key] = values.join(',');
    return headers;
  }

  function buildChatCompletionHeaders(service, extraHeaders, stream) {
    service = service || {};
    var headers = copyHeaders(extraHeaders);
    headers['Content-Type'] = 'application/json';
    var style = normalizeModelProtocol(service.protocol || service.apiStyle || service.api_style);
    var apiKey = String(service.apiKey || '');
    if (style === 'anthropic') {
      if (apiKey) headers['x-api-key'] = apiKey;
      if (!headers['anthropic-version'] && !headers['Anthropic-Version']) headers['anthropic-version'] = '2023-06-01';
      if (!headers['anthropic-dangerous-direct-browser-access'] && !headers['Anthropic-Dangerous-Direct-Browser-Access']) {
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      }
    } else if (apiKey) {
      headers.Authorization = 'Bearer ' + apiKey;
    }
    var userAgent = normalizeUserAgent(service.userAgent);
    if (userAgent) headers['User-Agent'] = userAgent;
    if (stream === true) headers.Accept = 'text/event-stream';
    return headers;
  }

  function canonicalToolCall(call) {
    call = call || {};
    var fn = call.function || {};
    return {
      id: String(call.id || ''),
      name: String(fn.name || call.name || ''),
      arguments: fn.arguments !== undefined ? fn.arguments : (call.arguments !== undefined ? call.arguments : '{}'),
    };
  }

  function mapContentToResponses(content) {
    if (!Array.isArray(content)) return content;
    return content.map(function (part) {
      if (!part || typeof part !== 'object') return { type: 'input_text', text: String(part == null ? '' : part) };
      if (part.type === 'input_text' || part.type === 'input_image') return part;
      if (part.type === 'text') return { type: 'input_text', text: String(part.text || '') };
      if (part.type === 'image_url') {
        var url = part.image_url && typeof part.image_url === 'object' ? part.image_url.url : part.image_url;
        return { type: 'input_image', image_url: String(url || '') };
      }
      return part;
    });
  }

  function anthropicImageSource(url) {
    url = String(url || '');
    var match = /^data:([^;,]+);base64,(.*)$/i.exec(url);
    if (match) return { type: 'base64', media_type: match[1], data: match[2] };
    return { type: 'url', url: url };
  }

  function mapContentToAnthropic(content) {
    if (!Array.isArray(content)) return content;
    return content.map(function (part) {
      if (!part || typeof part !== 'object') return { type: 'text', text: String(part == null ? '' : part) };
      if (part.type === 'text' || part.type === 'image') return part;
      if (part.type === 'input_text') return { type: 'text', text: String(part.text || '') };
      if (part.type === 'image_url' || part.type === 'input_image') {
        var url = part.image_url && typeof part.image_url === 'object' ? part.image_url.url : part.image_url;
        return { type: 'image', source: anthropicImageSource(url) };
      }
      return part;
    });
  }

  function mapChatMessagesToResponses(messages) {
    var input = [];
    var instructions = [];
    (Array.isArray(messages) ? messages : []).forEach(function (message) {
      if (!message) return;
      if (message.role === 'system') {
        instructions.push(textFromContent(message.content));
      } else if (message.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: String(message.tool_call_id || message.id || ''), output: textFromContent(message.content) });
      } else if (message.role === 'assistant') {
        var content = textFromContent(message.content);
        if (content) input.push({ role: 'assistant', content: content });
        (message.tool_calls || message.calls || []).forEach(function (call) {
          var normalized = canonicalToolCall(call);
          input.push({ type: 'function_call', call_id: normalized.id, name: normalized.name, arguments: typeof normalized.arguments === 'string' ? normalized.arguments : safeJson(normalized.arguments) });
        });
      } else {
        input.push({ role: 'user', content: message.content === undefined ? '' : mapContentToResponses(message.content) });
      }
    });
    return { input: input, instructions: instructions.filter(Boolean).join('\n\n') };
  }

  function mapChatMessagesToAnthropic(messages) {
    var output = [];
    var system = [];
    (Array.isArray(messages) ? messages : []).forEach(function (message) {
      if (!message) return;
      if (message.role === 'system') {
        system.push(textFromContent(message.content));
        return;
      }
      if (message.role === 'tool') {
        var block = { type: 'tool_result', tool_use_id: String(message.tool_call_id || message.id || ''), content: textFromContent(message.content) };
        var previous = output[output.length - 1];
        if (previous && previous.role === 'user' && Array.isArray(previous.content)) previous.content.push(block);
        else output.push({ role: 'user', content: [block] });
        return;
      }
      if (message.role === 'assistant') {
        var blocks = [];
        var assistantText = textFromContent(message.content);
        if (assistantText) blocks.push({ type: 'text', text: assistantText });
        (message.tool_calls || message.calls || []).forEach(function (call) {
          var normalized = canonicalToolCall(call);
          var args = normalized.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = {}; }
          }
          blocks.push({ type: 'tool_use', id: normalized.id, name: normalized.name, input: args || {} });
        });
        if (blocks.length) output.push({ role: 'assistant', content: blocks });
        return;
      }
      output.push({ role: 'user', content: message.content === undefined ? '' : mapContentToAnthropic(message.content) });
    });
    return { messages: output, system: system.filter(Boolean).join('\n\n') };
  }

  function convertChatCompletionBody(body, service) {
    body = Object.assign({}, body || {});
    var style = normalizeModelProtocol(service && (service.protocol || service.apiStyle || service.api_style));
    if (style === 'chat_completions') return body;
    if (style === 'responses') {
      var responseMessages = mapChatMessagesToResponses(body.messages);
      var responseBody = {
        model: body.model,
        input: responseMessages.input,
        stream: !!body.stream,
      };
      if (responseMessages.instructions) responseBody.instructions = responseMessages.instructions;
      if (body.temperature !== undefined) responseBody.temperature = body.temperature;
      if (body.top_p !== undefined) responseBody.top_p = body.top_p;
      if (body.max_tokens !== undefined) responseBody.max_output_tokens = body.max_tokens;
      if (Array.isArray(body.tools) && body.tools.length) {
        responseBody.tools = body.tools.map(function (tool) {
          var fn = tool.function || tool;
          return { type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters || fn.input_schema || {} };
        });
      }
      if (body.reasoning && typeof body.reasoning === 'object') responseBody.reasoning = Object.assign({}, body.reasoning);
      else if (body.reasoning_effort) responseBody.reasoning = { effort: body.reasoning_effort };
      return responseBody;
    }
    var anthropicMessages = mapChatMessagesToAnthropic(body.messages);
    var anthropicBody = {
      model: body.model,
      max_tokens: Math.max(1, Math.floor(Number(body.max_tokens) || 4096)),
      messages: anthropicMessages.messages,
      stream: !!body.stream,
    };
    if (anthropicMessages.system) anthropicBody.system = anthropicMessages.system;
    var anthropicThinkingEnabled = body.thinking && body.thinking.type !== 'disabled';
    if (!anthropicThinkingEnabled && body.temperature !== undefined) anthropicBody.temperature = body.temperature;
    if (!anthropicThinkingEnabled && body.top_p !== undefined) anthropicBody.top_p = body.top_p;
    if (Array.isArray(body.tools) && body.tools.length) {
      anthropicBody.tools = body.tools.map(function (tool) {
        var fn = tool.function || tool;
        return { name: fn.name, description: fn.description, input_schema: fn.parameters || fn.input_schema || {} };
      });
    }
    if (body.thinking && typeof body.thinking === 'object') anthropicBody.thinking = Object.assign({}, body.thinking);
    if (body.output_config && typeof body.output_config === 'object') anthropicBody.output_config = Object.assign({}, body.output_config);
    return anthropicBody;
  }

  function normalizeRequestTimeoutMs(value, options) {
    options = options || {};
    var defaultMs = normalizePositiveInt(options.defaultMs, 120000, 60 * 60 * 1000);
    var minMs = normalizePositiveInt(options.minMs, 1000, 60 * 60 * 1000);
    var maxMs = normalizePositiveInt(options.maxMs, 10 * 60 * 1000, 60 * 60 * 1000);
    if (maxMs < minMs) maxMs = minMs;
    if (value === '' || value === null || value === undefined) return Math.min(Math.max(defaultMs, minMs), maxMs);
    var timeoutMs = Number(value);
    if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = defaultMs;
    return Math.min(Math.max(Math.floor(timeoutMs), minMs), maxMs);
  }

  function chatCompletionErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (payload.error && typeof payload.error === 'object' && payload.error.message !== undefined) {
      return textFromContent(payload.error.message).trim();
    }
    if (payload.error !== undefined && payload.error !== null) return textFromContent(payload.error).trim();
    if (payload.message !== undefined && payload.message !== null) return textFromContent(payload.message).trim();
    return '';
  }

  function parseChatCompletionResponse(value) {
    var payload = value;
    if (typeof value === 'string') {
      try {
        payload = JSON.parse(value);
      } catch (_) {
        var jsonError = new Error('模型接口返回非 JSON: ' + value.slice(0, 200));
        jsonError.code = 'MODEL_RESPONSE_NOT_JSON';
        jsonError.bodyPreview = value.slice(0, 500);
        throw jsonError;
      }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      var shapeError = new Error('模型接口返回必须是 JSON 对象');
      shapeError.code = 'MODEL_RESPONSE_INVALID_SHAPE';
      throw shapeError;
    }
    var choices = Array.isArray(payload.choices) ? payload.choices : [];
    var choice = choices[0] && typeof choices[0] === 'object' ? choices[0] : null;
    var message = choice && choice.message && typeof choice.message === 'object' ? choice.message : null;
    var contentValue;
    var hasContent = false;
    if (message && Object.prototype.hasOwnProperty.call(message, 'content')) {
      contentValue = message.content;
      hasContent = true;
    } else if (choice && Object.prototype.hasOwnProperty.call(choice, 'text')) {
      contentValue = choice.text;
      hasContent = true;
    }
    if (!hasContent) {
      var contentError = new Error('模型接口返回缺少 choices[0].message.content');
      contentError.code = 'MODEL_RESPONSE_CONTENT_MISSING';
      contentError.response = payload;
      throw contentError;
    }
    return {
      content: textFromContent(contentValue),
      message: message,
      model: payload.model === undefined || payload.model === null ? '' : String(payload.model),
      usage: Object.prototype.hasOwnProperty.call(payload, 'usage') ? payload.usage : null,
      finishReason: choice && Object.prototype.hasOwnProperty.call(choice, 'finish_reason') ? choice.finish_reason : null,
      response: payload,
    };
  }

  function parseModelResponse(value, serviceOrStyle) {
    var style = typeof serviceOrStyle === 'string'
      ? normalizeModelProtocol(serviceOrStyle)
      : normalizeModelProtocol(serviceOrStyle && (serviceOrStyle.protocol || serviceOrStyle.apiStyle || serviceOrStyle.api_style));
    if (style === 'chat_completions') return parseChatCompletionResponse(value);
    var payload = value;
    if (typeof value === 'string') {
      try { payload = JSON.parse(value); } catch (_) {
        var jsonError = new Error('模型接口返回非 JSON: ' + value.slice(0, 200));
        jsonError.code = 'MODEL_RESPONSE_NOT_JSON';
        throw jsonError;
      }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      var shapeError = new Error('模型接口返回必须是 JSON 对象');
      shapeError.code = 'MODEL_RESPONSE_INVALID_SHAPE';
      throw shapeError;
    }
    var parts = [];
    var finishReason = null;
    if (style === 'responses') {
      if (typeof payload.output_text === 'string') parts.push(payload.output_text);
      (Array.isArray(payload.output) ? payload.output : []).forEach(function (item) {
        if (!item || item.type !== 'message') return;
        (Array.isArray(item.content) ? item.content : []).forEach(function (part) {
          if (part && (part.type === 'output_text' || part.type === 'text') && part.text !== undefined) parts.push(String(part.text));
        });
      });
      finishReason = payload.status === 'incomplete' ? 'length' : 'stop';
    } else {
      (Array.isArray(payload.content) ? payload.content : []).forEach(function (part) {
        if (part && part.type === 'text' && part.text !== undefined) parts.push(String(part.text));
      });
      finishReason = payload.stop_reason || null;
    }
    if (!parts.length) {
      var contentError = new Error('模型接口返回缺少文本内容');
      contentError.code = 'MODEL_RESPONSE_CONTENT_MISSING';
      contentError.response = payload;
      throw contentError;
    }
    return {
      content: parts.join(''),
      message: null,
      model: payload.model === undefined || payload.model === null ? '' : String(payload.model),
      usage: Object.prototype.hasOwnProperty.call(payload, 'usage') ? payload.usage : null,
      finishReason: finishReason,
      response: payload,
    };
  }

  function buildModelHttpRequest(body, service, options) {
    service = normalizeService(service || {}, service && service.id, service && service.name) || {};
    options = options || {};
    var prepared = prepareChatCompletionRequest(body, service, options);
    var requestBody = convertChatCompletionBody(prepared.body, service);
    var headers = buildChatCompletionHeaders(service, options.headers, !!requestBody.stream);
    if (prepared.meta && prepared.meta.anthropicBeta) {
      appendHeaderToken(headers, 'anthropic-beta', prepared.meta.anthropicBeta);
    }
    return {
      url: buildModelEndpointUrl(service.baseUrl, service.protocol),
      headers: headers,
      body: requestBody,
      meta: Object.assign({}, prepared.meta || {}, { apiStyle: service.protocol || 'chat_completions' }),
    };
  }

  function createChatCompletionHttpError(status, statusText, responseText) {
    var text = responseText === undefined || responseText === null ? '' : String(responseText);
    var parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    var detail = chatCompletionErrorMessage(parsed) || text.slice(0, 300) || String(statusText || '').trim();
    var message = '模型接口请求失败 (HTTP ' + String(status || 0) + ')' + (detail ? ': ' + detail : '');
    var error = new Error(message);
    error.code = 'MODEL_HTTP_ERROR';
    error.status = Number(status) || 0;
    error.statusText = String(statusText || '');
    error.bodyPreview = text.slice(0, 500);
    error.response = parsed;
    return error;
  }

  return {
    SETTINGS_KEY: SETTINGS_KEY,
    makeServiceId: makeServiceId,
    normalizeSettings: normalizeSettings,
    normalizeService: normalizeService,
    getService: getService,
    getDefaultService: getDefaultService,
    getGeneratorService: getGeneratorService,
    serviceDisplayName: serviceDisplayName,
    isServiceConfigured: isServiceConfigured,
    DEFAULT_MAX_CONTEXT_TOKENS: DEFAULT_MAX_CONTEXT_TOKENS,
    MAX_CONTEXT_TOKENS_LIMIT: MAX_CONTEXT_TOKENS_LIMIT,
    DEFAULT_MAX_RETRIES: DEFAULT_MAX_RETRIES,
    MAX_RETRIES_LIMIT: MAX_RETRIES_LIMIT,
    normalizeMaxContextTokens: normalizeMaxContextTokens,
    normalizeReasoningEffort: normalizeReasoningEffort,
    normalizeModelProtocol: normalizeModelProtocol,
    normalizeModelApiStyle: normalizeModelApiStyle,
    normalizeProviderHeaders: normalizeProviderHeaders,
    appendHeaderToken: appendHeaderToken,
    normalizeUserAgent: normalizeUserAgent,
    normalizeContextCompression: normalizeContextCompression,
    autoCompactTokenLimit: autoCompactTokenLimit,
    applyReasoningEffortToBody: applyReasoningEffortToBody,
    resolveAnthropicMaxTokens: resolveAnthropicMaxTokens,
    estimateTextTokens: estimateTextTokens,
    estimateMessageTokens: estimateMessageTokens,
    estimateMessagesTokens: estimateMessagesTokens,
    textFromContent: textFromContent,
    prepareChatCompletionRequest: prepareChatCompletionRequest,
    buildChatCompletionsUrl: buildChatCompletionsUrl,
    buildModelEndpointUrl: buildModelEndpointUrl,
    buildChatCompletionHeaders: buildChatCompletionHeaders,
    convertChatCompletionBody: convertChatCompletionBody,
    buildModelHttpRequest: buildModelHttpRequest,
    normalizeRequestTimeoutMs: normalizeRequestTimeoutMs,
    parseChatCompletionResponse: parseChatCompletionResponse,
    parseModelResponse: parseModelResponse,
    createChatCompletionHttpError: createChatCompletionHttpError,
  };
});
