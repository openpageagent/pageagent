// DeepSeek first-party compatibility hooks for Chat Completions, Responses, and Anthropic Messages.
(function attachDeepSeekProviderCompat(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var utilities = commonJs ? require('../provider-utils') : root.BrowserProviderUtilities;
  var adapter = factory(utilities);
  if (commonJs) module.exports = adapter;
  else if (root.ProviderCompat && typeof root.ProviderCompat.register === 'function') root.ProviderCompat.register(adapter);
  else {
    if (!Array.isArray(root.PendingProviderCompats)) root.PendingProviderCompats = [];
    root.PendingProviderCompats.push(adapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utilities) {
  'use strict';

  var SUPPORTED_PROTOCOLS = Object.freeze({ chat_completions: true, responses: true, anthropic: true });

  function protocolName(value) {
    return String(value || '').trim().toLowerCase();
  }

  function serviceHostname(service) {
    try { return new URL(String(service && service.baseUrl || '')).hostname.toLowerCase(); }
    catch (_) { return ''; }
  }

  function matches(service, protocol) {
    var hostname = serviceHostname(service);
    return !!(SUPPORTED_PROTOCOLS[protocolName(protocol)]
      && (hostname === 'deepseek.com' || /\.deepseek\.com$/.test(hostname)));
  }

  function mappedEffort(value) {
    var effort = String(value || '').trim().toLowerCase();
    if (!effort || effort === 'auto') return '';
    if (effort === 'none') return 'none';
    if (effort === 'minimal' || effort === 'low') return 'low';
    if (effort === 'medium' || effort === 'high' || effort === 'xhigh') return 'high';
    if (effort === 'max') return 'max';
    return '';
  }

  function removeHeader(headers, name) {
    var expected = String(name || '').toLowerCase();
    Object.keys(headers || {}).forEach(function (key) {
      if (String(key).toLowerCase() === expected) delete headers[key];
    });
  }

  function normalizeEndpoint(endpoint, protocol) {
    if (protocol !== 'anthropic') return endpoint;
    try {
      var parsed = new URL(String(endpoint || ''));
      parsed.pathname = '/anthropic/messages';
      parsed.hash = '';
      return parsed.toString();
    } catch (_) {
      return endpoint;
    }
  }

  function prepareResponsesRequest(body, effort) {
    body = Object.assign({}, body || {});
    var reasoning = body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
      ? Object.assign({}, body.reasoning)
      : {};
    var mapped = mappedEffort(effort);

    delete reasoning.summary;
    if (mapped) reasoning.effort = mapped;
    else delete reasoning.effort;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
    else delete body.reasoning;

    delete body.include;
    delete body.prompt_cache_key;
    delete body.prompt_cache_retention;
    delete body.store;

    if (mapped !== 'none') {
      delete body.temperature;
      delete body.top_p;
    }
    return body;
  }

  function prepareChatCompletionsRequest(body, effort) {
    body = Object.assign({}, body || {});
    var mapped = mappedEffort(effort);
    if (mapped === 'none') {
      body.thinking = { type: 'disabled' };
      delete body.reasoning_effort;
    } else if (mapped) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = mapped;
    } else {
      delete body.thinking;
      delete body.reasoning_effort;
    }
    if (mapped !== 'none') {
      delete body.temperature;
      delete body.top_p;
      delete body.presence_penalty;
      delete body.frequency_penalty;
    }
    return body;
  }

  function prepareAnthropicRequest(body, effort, requestedMaxTokens) {
    body = Object.assign({}, body || {});
    var mapped = mappedEffort(effort);
    if (mapped === 'none') {
      body.thinking = { type: 'disabled' };
      delete body.output_config;
    } else if (mapped) {
      body.thinking = { type: 'enabled' };
      body.output_config = { effort: mapped };
    } else {
      delete body.thinking;
      delete body.output_config;
    }

    if (Number(requestedMaxTokens) > 0) body.max_tokens = Math.max(1, Math.floor(Number(requestedMaxTokens)));
    if (mapped !== 'none') {
      delete body.temperature;
      delete body.top_p;
    }
    return body;
  }

  function normalizeResponsesResult(result) {
    if (!result || !result.replay || !Array.isArray(result.replay.blocks)) return result;
    var output = utilities.cloneJson(result);
    output.replay.blocks.forEach(function (block) {
      if (!block || block.type !== 'reasoning' || !block.signature
          || typeof block.signature !== 'object' || Array.isArray(block.signature)) return;
      delete block.signature.encrypted_content;
      delete block.signature.summary;
    });
    return output;
  }

  function normalizeAnthropicResult(result) {
    if (!result || !result.replay || !Array.isArray(result.replay.blocks)) return result;
    var output = utilities.cloneJson(result);
    output.replay.blocks.forEach(function (block) {
      if (!block || block.type !== 'reasoning' || block.redacted) return;
      if (typeof block.signature !== 'string') block.signature = '';
    });
    return output;
  }

  function createChatResponseState() {
    return { reasoning: '' };
  }

  function consumeChatResponseEvent(event, state) {
    var delta = event && event.delta;
    var reasoning = delta && typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content : '';
    if (!reasoning) return [];
    state.reasoning += reasoning;
    return [{ type: 'reasoning_delta', reasoningKind: 'raw', delta: reasoning }];
  }

  function normalizeChatResult(result, state) {
    if (!state || !state.reasoning) return result;
    var output = utilities.cloneJson(result);
    output.reasoning = state.reasoning;
    output.reasoningKind = 'raw';
    if (output.replay && Array.isArray(output.replay.blocks)) {
      output.replay.blocks.unshift({
        type: 'reasoning',
        text: state.reasoning,
        field: 'reasoning_content',
      });
    }
    return output;
  }

  function create(service, protocol) {
    protocol = protocolName(protocol);
    var target = protocol === 'chat_completions'
      ? { chatAssistantReasoningField: 'reasoning_content' }
      : (protocol === 'responses'
        ? { responsesReasoningReplay: 'plaintext' }
        : { anthropicThinkingSignature: 'optional', anthropicMaxTokens: 'requested' });
    return {
      target: target,
      endpoint: function (endpoint) { return normalizeEndpoint(endpoint, protocol); },
      beforeRequest: function (request) {
        request = request || {};
        var headers = Object.assign({}, request.headers || {});
        var body = request.body || {};
        if (protocol === 'chat_completions') body = prepareChatCompletionsRequest(body, request.reasoningEffort);
        else if (protocol === 'responses') body = prepareResponsesRequest(body, request.reasoningEffort);
        else {
          body = prepareAnthropicRequest(body, request.reasoningEffort, request.maxTokens);
          removeHeader(headers, 'anthropic-beta');
        }
        return { body: body, headers: headers };
      },
      createResponseState: function () {
        return protocol === 'chat_completions' ? createChatResponseState() : {};
      },
      onResponseEvent: function (event, state) {
        return protocol === 'chat_completions' ? consumeChatResponseEvent(event, state) : [];
      },
      afterResponse: function (result, state) {
        if (protocol === 'chat_completions') return normalizeChatResult(result, state);
        return protocol === 'responses' ? normalizeResponsesResult(result) : normalizeAnthropicResult(result);
      },
    };
  }

  return Object.freeze({
    id: 'deepseek',
    priority: 100,
    matches: matches,
    create: create,
  });
});
