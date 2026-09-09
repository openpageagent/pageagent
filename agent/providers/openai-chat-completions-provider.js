// OpenAI Chat Completions stream semantics adapted from pi-mono openai-completions.ts (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachOpenAIChatCompletionsProvider(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var api = factory(
    commonJs ? require('./provider-utils') : root.BrowserProviderUtilities,
    commonJs ? require('./provider-sse') : root.BrowserProviderSSE,
    commonJs ? require('./browser-provider-transport') : root.BrowserProviderTransport,
    commonJs ? require('./provider-message-normalizer') : root.ProviderMessageNormalizer,
    commonJs ? require('./compat/index') : root.ProviderCompat
  );
  if (commonJs) module.exports = api;
  else root.OpenAIChatCompletionsProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utils, SSE, Transport, Messages, ProviderCompat) {
  'use strict';

  var API_VERSION = 1;
  var API_STYLE = 'chat_completions';
  var fallbackIdSequence = 0;

  function numberSetting(value) {
    var number = Number(value);
    return isFinite(number) ? number : undefined;
  }

  function emit(input, event) {
    if (typeof input.onEvent !== 'function') return;
    try { input.onEvent(event); }
    catch (_) { if (typeof console !== 'undefined' && console.error) console.error('[Page Agent] provider event listener failed'); }
  }

  function toolDefinitions(tools) {
    return (Array.isArray(tools) ? tools : []).map(function (tool) {
      return {
        type: 'function',
        function: {
          name: String(tool.name || ''),
          description: String(tool.description || ''),
          parameters: tool.schema && typeof tool.schema === 'object' ? tool.schema : {},
        },
      };
    });
  }

  function parseUsage(raw) {
    raw = raw || {};
    var prompt = Number(raw.prompt_tokens) || 0;
    var cached = Number(raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens
      || raw.prompt_cache_hit_tokens) || 0;
    var cacheWrite = Number(raw.prompt_tokens_details && raw.prompt_tokens_details.cache_write_tokens) || 0;
    var output = Number(raw.completion_tokens) || 0;
    return {
      inputTokens: Math.max(0, prompt - cached - cacheWrite),
      outputTokens: output,
      totalTokens: Number(raw.total_tokens) || prompt + output,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: Number(raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens) || 0,
    };
  }

  function finishReason(value) {
    if (value === 'stop' || value === 'end') return 'stop';
    if (value === 'length') return 'length';
    if (value === 'tool_calls' || value === 'function_call') return 'tool_calls';
    if (value === 'content_filter') return 'content_filter';
    var error = new Error('Unhandled Chat Completions finish_reason: ' + String(value));
    error.code = 'PROVIDER_CONTRACT_ERROR';
    throw error;
  }

  function instructionMessages(input) {
    var output = [];
    if (input.system) output.push({ role: 'system', content: String(input.system) });
    if (input.developer) output.push({
      role: 'system',
      content: String(input.developer),
    });
    return output;
  }

  function create(options) {
    options = options || {};
    var service = options.service || {};
    var assistant = options.assistant || {};
    var settings = assistant.settings || {};
    var modelSettings = options.modelSettings || null;
    var model = String(assistant.model || service.model || '').trim();
    var serviceId = String(service.id || '').trim();
    var protocol = modelSettings && typeof modelSettings.normalizeModelProtocol === 'function'
      ? modelSettings.normalizeModelProtocol(service.protocol || service.apiStyle)
      : String(service.protocol || service.apiStyle || '').trim();
    if (protocol !== API_STYLE) {
      throw new TypeError('OpenAIChatCompletionsProvider requires protocol=' + API_STYLE);
    }
    if (!model || !serviceId) throw new Error('OpenAIChatCompletionsProvider requires service id and model');
    var compatibility = ProviderCompat.resolve(service, API_STYLE);
    var endpoint = compatibility.endpoint(Transport.normalizeEndpoint(service.baseUrl, '/chat/completions'));
    var transport = Transport.create({
      fetch: options.fetch,
      appendSessionEvent: options.appendSessionEvent,
    });
    var resolveImageArtifact = options.resolveImageArtifact;
    var target = { apiStyle: API_STYLE, serviceId: serviceId, model: model, compat: compatibility.target };
    function providerMessages(preparedMessages, input) {
      return instructionMessages(input).concat(Messages.toOpenAIChat(preparedMessages, target));
    }

    async function request(input) {
      input = input || {};
      var preparedMessages = await Messages.prepareProviderMessages(input.messages || [], typeof resolveImageArtifact === 'function'
        ? function (artifactUri, resolveOptions) {
          return resolveImageArtifact(artifactUri, Object.assign({}, resolveOptions || {}, {
            topicId: String(input.sessionId || ''), maxBytes: 20 * 1024 * 1024,
          }));
        }
        : null);
      var body = {
        model: model,
        messages: providerMessages(preparedMessages, input),
        stream: true,
        // OpenAI 标准流式默认不带 usage；usage 是缓存命中与预算校准的唯一
        // 服务端证据。厂商不支持该字段时由对应 compat 删除。
        stream_options: { include_usage: true },
      };
      var tools = toolDefinitions(input.tools);
      if (tools.length) body.tools = tools;
      var temperature = numberSetting(settings.temperature);
      var topP = numberSetting(settings.topP);
      var maxTokens = input.purpose === 'context_summary'
        ? Math.max(0, Math.floor(Number(input.maxOutputTokens) || Number(settings.maxTokens) || 0))
        : 0;
      if (maxTokens) body.max_tokens = maxTokens;

      var assistantEffort = String(settings.reasoningEffort || '').trim();
      var effort = assistantEffort && assistantEffort !== 'auto'
        ? assistantEffort
        : String(service.reasoningEffort || '').trim();
      if (modelSettings && typeof modelSettings.applyReasoningEffortToBody === 'function') {
        modelSettings.applyReasoningEffortToBody(body, service, {
          apiStyle: API_STYLE,
          reasoningEffort: effort,
        });
      } else if (effort && effort !== 'auto') {
        body.reasoning_effort = effort;
      }
      var reasoningEnabled = !!((body.reasoning_effort && body.reasoning_effort !== 'none')
        || (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none')
        || (body.thinking && body.thinking.type && body.thinking.type !== 'disabled'));
      if (!reasoningEnabled) {
        if (temperature !== undefined) body.temperature = temperature;
        if (topP !== undefined) body.top_p = topP;
      }

      var sessionId = String(input.sessionId || '').trim();
      var headers = Transport.openAiHeaders({
        apiKey: service.apiKey,
        serviceHeaders: service.headers,
        userAgent: service.userAgent,
        sessionId: sessionId,
      });
      var compatibleRequest = compatibility.beforeRequest({
        body: body,
        headers: headers,
        reasoningEffort: effort,
      });
      body = compatibleRequest.body;
      headers = compatibleRequest.headers;
      var opened = null;
      var responseId = '';
      var responseModel = '';
      var usage = utils.emptyUsage();
      var finish = '';
      var blocks = [];
      var textBlock = null;
      var toolByIndex = new Map();
      var toolById = new Map();
      var compatibilityState = compatibility.createResponseState();

      function ensureText() {
        if (!textBlock) { textBlock = { type: 'text', text: '' }; blocks.push(textBlock); }
        return textBlock;
      }
      function ensureTool(delta) {
        var streamIndex = Number.isInteger(delta.index) ? delta.index : 0;
        var block = toolByIndex.get(streamIndex) || (delta.id ? toolById.get(delta.id) : null);
        if (!block) {
          block = { type: 'tool_call', id: String(delta.id || ''), name: String(delta.function && delta.function.name || ''), arguments: {}, partial: '' };
          toolByIndex.set(streamIndex, block);
          if (block.id) toolById.set(block.id, block);
          blocks.push(block);
        }
        if (!block.id && delta.id) block.id = String(delta.id);
        if (!block.name && delta.function && delta.function.name) block.name = String(delta.function.name);
        if (block.id) toolById.set(block.id, block);
        return block;
      }

      function emitToolProgress(tool) {
        var event = {
          type: 'tool_call_delta', callId: tool.id, name: tool.name,
          receivedChars: String(tool.partial || '').length,
        };
        emit(input, event);
      }

      function openStream() {
        return transport.openJsonStream({
          url: endpoint,
          headers: headers,
          body: body,
          signal: input.signal,
          timeoutMs: settings.timeoutMs || service.timeoutMs || service.requestTimeoutMs,
          maxRetries: settings.maxRetries !== undefined ? settings.maxRetries : service.maxRetries,
          maxRetryDelayMs: settings.maxRetryDelayMs || service.maxRetryDelayMs,
          trace: input.providerTrace,
        });
      }

      try {
        try { opened = await openStream(); }
        catch (imageError) {
          if (!Messages.hasToolImages(preparedMessages) || !Messages.isImageInputRejection(imageError)) throw imageError;
          preparedMessages = Messages.omitToolImages(preparedMessages, 'IMAGE_INPUT_UNSUPPORTED');
          body.messages = providerMessages(preparedMessages, input);
          emit(input, { type: 'provider_warning', code: 'IMAGE_INPUT_UNSUPPORTED', message: '模型拒绝工具图片，已使用占位文本安全重试一次' });
          opened = await openStream();
        }
        emit(input, { type: 'model_start', apiStyle: API_STYLE, model: model });
        for await (var event of SSE.iterate(opened.response.body, opened.signal)) {
          if (opened.touch) opened.touch();
          if (event.event === 'error') throw new Error(event.data || 'Chat Completions SSE error');
          if (event.data.trim() === '[DONE]') break;
          var chunk = SSE.parseJson(event);
          if (chunk.error) throw new Error(utils.errorMessageFromBody(chunk) || utils.safeJsonStringify(chunk.error));
          if (chunk.id) responseId = responseId || String(chunk.id);
          if (chunk.model && String(chunk.model) !== model) responseModel = responseModel || String(chunk.model);
          if (chunk.usage) usage = parseUsage(chunk.usage);
          var choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
          if (!choice) continue;
          if (!chunk.usage && choice.usage) usage = parseUsage(choice.usage);
          if (choice.finish_reason) finish = finishReason(choice.finish_reason);
          var delta = choice.delta || {};
          var compatibilityEvents = compatibility.onResponseEvent({
            chunk: chunk,
            choice: choice,
            delta: delta,
          }, compatibilityState);
          (Array.isArray(compatibilityEvents) ? compatibilityEvents : []).forEach(function (compatibilityEvent) {
            emit(input, compatibilityEvent);
          });
          if (typeof delta.content === 'string' && delta.content) {
            ensureText().text += delta.content;
            emit(input, { type: 'text_delta', delta: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            delta.tool_calls.forEach(function (toolDelta) {
              var tool = ensureTool(toolDelta);
              var argumentDelta = toolDelta.function && typeof toolDelta.function.arguments === 'string'
                ? toolDelta.function.arguments : '';
              tool.partial += argumentDelta;
              tool.arguments = utils.parseStreamingJson(tool.partial);
              emitToolProgress(tool);
            });
          }
        }
        if (opened.signal.aborted) throw utils.normalizeError(null, opened.signal);
        if (!finish) throw new Error('Chat Completions stream ended without finish_reason');
        var calls = [];
        var replayBlocks = blocks.map(function (block, index) {
          if (block.type !== 'tool_call') return block;
          // fallback id 必须掺入本轮唯一量：确定性 id 会在下一轮历史校验中
          // 命中"跨 assistant 组重复 tool call id"而使话题永久失败。
          if (!block.id) block.id = 'call_' + index + '_' + utils.shortHash((responseId || '') + '|' + Date.now().toString(36) + '|' + (++fallbackIdSequence) + '|' + index);
          block.arguments = utils.parseFinalArguments(block.partial || '{}');
          emitToolProgress(block);
          var finalBlock = { type: 'tool_call', id: block.id, name: block.name, arguments: block.arguments };
          calls.push({ id: block.id, name: block.name, arguments: block.arguments });
          return finalBlock;
        });
        if (calls.length && finish === 'stop') finish = 'tool_calls';
        var result = {
          content: textBlock ? textBlock.text : '',
          reasoning: '',
          calls: calls,
          usage: usage,
          finishReason: finish,
          responseId: responseId,
          responseModel: responseModel,
          replay: Messages.createReplay({
            apiStyle: API_STYLE, serviceId: serviceId, model: model,
            responseId: responseId, blocks: replayBlocks,
          }),
        };
        result = compatibility.afterResponse(result, compatibilityState);
        if (opened.completeTrace) await opened.completeTrace(result);
        emit(input, { type: 'model_end', apiStyle: API_STYLE, model: model, responseId: responseId, finishReason: finish, usage: usage });
        return result;
      } catch (error) {
        var normalized = utils.normalizeError(error, opened && opened.signal || input.signal);
        if (opened && opened.failTrace) await opened.failTrace(normalized);
        emit(input, {
          type: 'model_end', apiStyle: API_STYLE, model: model,
          finishReason: normalized.name === 'AbortError' ? 'aborted' : 'error', error: normalized.message,
        });
        throw normalized;
      } finally {
        if (opened) opened.close();
      }
    }

    return Object.freeze({ apiStyle: API_STYLE, request: request });
  }

  return Object.freeze({ API_VERSION: API_VERSION, API_STYLE: API_STYLE, mapFinishReason: finishReason, parseUsage: parseUsage, create: create });
});
