// Anthropic Messages SSE/thinking semantics adapted from pi-mono anthropic-messages.ts (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachAnthropicMessagesProvider(root, factory) {
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
  else root.AnthropicMessagesProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utils, SSE, Transport, Messages, ProviderCompat) {
  'use strict';

  var API_VERSION = 1;
  var API_STYLE = 'anthropic';
  var fallbackIdSequence = 0;

  function emit(input, event) {
    if (typeof input.onEvent !== 'function') return;
    try { input.onEvent(event); }
    catch (_) { if (typeof console !== 'undefined' && console.error) console.error('[Page Agent] provider event listener failed'); }
  }

  function numberSetting(value) {
    var number = Number(value);
    return isFinite(number) ? number : undefined;
  }

  function toolDefinitions(tools) {
    return (Array.isArray(tools) ? tools : []).map(function (tool) {
      var schema = tool.schema && typeof tool.schema === 'object' ? tool.schema : {};
      return {
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        input_schema: {
          type: 'object',
          properties: schema.properties || {},
          required: Array.isArray(schema.required) ? schema.required : [],
          additionalProperties: schema.additionalProperties !== false,
        },
      };
    });
  }

  function systemBlocks(input) {
    var output = [];
    if (input.system) output.push({ type: 'text', text: String(input.system) });
    if (input.developer) output.push({ type: 'text', text: String(input.developer) });
    return output;
  }

  function emptyUsage() { return utils.emptyUsage(); }

  function applyUsage(target, raw) {
    raw = raw || {};
    if (raw.input_tokens !== undefined && raw.input_tokens !== null) target.inputTokens = Number(raw.input_tokens) || 0;
    if (raw.output_tokens !== undefined && raw.output_tokens !== null) target.outputTokens = Number(raw.output_tokens) || 0;
    if (raw.cache_read_input_tokens !== undefined && raw.cache_read_input_tokens !== null) target.cacheReadTokens = Number(raw.cache_read_input_tokens) || 0;
    if (raw.cache_creation_input_tokens !== undefined && raw.cache_creation_input_tokens !== null) target.cacheWriteTokens = Number(raw.cache_creation_input_tokens) || 0;
    var reasoning = raw.output_tokens_details && raw.output_tokens_details.thinking_tokens;
    if (reasoning !== undefined && reasoning !== null) target.reasoningTokens = Number(reasoning) || 0;
    target.totalTokens = target.inputTokens + target.outputTokens + target.cacheReadTokens + target.cacheWriteTokens;
    return target;
  }

  function finishReason(reason, details) {
    if (reason === 'end_turn' || reason === 'pause_turn' || reason === 'stop_sequence') return 'stop';
    if (reason === 'max_tokens') return 'length';
    if (reason === 'tool_use') return 'tool_calls';
    if (reason === 'refusal' || reason === 'sensitive') return 'content_filter';
    var error = new Error('Unhandled Anthropic stop_reason: ' + String(reason || 'missing'));
    error.code = 'PROVIDER_CONTRACT_ERROR';
    error.details = details || null;
    throw error;
  }

  function thinkingBudget(effort) {
    if (effort === 'minimal') return 1024;
    if (effort === 'low') return 2048;
    if (effort === 'medium') return 8192;
    if (effort === 'high') return 16384;
    if (effort === 'xhigh' || effort === 'max') return 32768;
    return 0;
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
      throw new TypeError('AnthropicMessagesProvider requires protocol=' + API_STYLE);
    }
    if (!model || !serviceId) throw new Error('AnthropicMessagesProvider requires service id and model');
    var compatibility = ProviderCompat.resolve(service, API_STYLE);
    var endpoint = compatibility.endpoint(Transport.normalizeEndpoint(service.baseUrl, '/messages'));
    var transport = Transport.create({
      fetch: options.fetch,
      appendSessionEvent: options.appendSessionEvent,
    });
    var resolveImageArtifact = options.resolveImageArtifact;
    var target = { apiStyle: API_STYLE, serviceId: serviceId, model: model, compat: compatibility.target };

    async function request(input) {
      input = input || {};
      var preparedMessages = await Messages.prepareProviderMessages(input.messages || [], typeof resolveImageArtifact === 'function'
        ? function (artifactUri, resolveOptions) {
          return resolveImageArtifact(artifactUri, Object.assign({}, resolveOptions || {}, {
            topicId: String(input.sessionId || ''), maxBytes: 5 * 1024 * 1024,
          }));
        }
        : null);
      var assistantEffort = String(settings.reasoningEffort || '').trim();
      var effort = assistantEffort && assistantEffort !== 'auto'
        ? assistantEffort
        : String(service.reasoningEffort || '').trim();
      var requestedMax = Math.max(1, Math.floor(Number(input.maxOutputTokens) || Number(settings.maxTokens) || 4096));
      var body = {
        model: model,
        messages: Messages.toAnthropicMessages(preparedMessages, target),
        max_tokens: requestedMax,
        stream: true,
      };
      var instructions = systemBlocks(input);
      if (instructions.length) body.system = instructions;
      var tools = toolDefinitions(input.tools);
      if (tools.length) body.tools = tools;
      var reasoningMeta = {};
      if (modelSettings && typeof modelSettings.applyReasoningEffortToBody === 'function') {
        reasoningMeta = modelSettings.applyReasoningEffortToBody(body, service, { apiStyle: API_STYLE, reasoningEffort: effort });
      } else if (effort && effort !== 'auto') {
        if (effort === 'none') body.thinking = { type: 'disabled' };
        else {
          var fallbackBudget = thinkingBudget(effort);
          if (fallbackBudget > 0) {
            body.thinking = { type: 'enabled', budget_tokens: fallbackBudget };
            body.max_tokens = Math.max(body.max_tokens, fallbackBudget + 1024);
          }
        }
      }
      var temperature = numberSetting(settings.temperature);
      var topP = numberSetting(settings.topP);
      var thinkingEnabled = body.thinking && body.thinking.type !== 'disabled';
      // Claude Code 在 adaptive 与固定预算 thinking 下都不传采样参数。
      if (!thinkingEnabled && temperature !== undefined) body.temperature = temperature;
      if (!thinkingEnabled && topP !== undefined) body.top_p = topP;

      var sessionId = String(input.sessionId || '').trim();
      var headers = Transport.anthropicHeaders({
        apiKey: service.apiKey,
        serviceHeaders: service.headers,
        userAgent: service.userAgent,
        sessionId: sessionId,
      });
      if (reasoningMeta.anthropicBeta) {
        if (modelSettings && typeof modelSettings.appendHeaderToken === 'function') {
          modelSettings.appendHeaderToken(headers, 'anthropic-beta', reasoningMeta.anthropicBeta);
        } else {
          headers['anthropic-beta'] = reasoningMeta.anthropicBeta;
        }
      }
      var compatibleRequest = compatibility.beforeRequest({
        body: body,
        headers: headers,
        reasoningEffort: effort,
        maxTokens: requestedMax,
      });
      body = compatibleRequest.body;
      headers = compatibleRequest.headers;
      var opened = null;
      var responseId = '';
      var responseModel = '';
      var usage = emptyUsage();
      var finish = '';
      var sawMessageStart = false;
      var sawMessageStop = false;
      var blocks = [];
      var blockByIndex = new Map();

      function startBlock(index, contentBlock) {
        var block;
        if (contentBlock.type === 'text') {
          block = { type: 'text', text: String(contentBlock.text || '') };
        } else if (contentBlock.type === 'thinking') {
          block = { type: 'reasoning', text: String(contentBlock.thinking || ''), signature: String(contentBlock.signature || '') };
        } else if (contentBlock.type === 'redacted_thinking') {
          block = { type: 'reasoning', text: '[Reasoning redacted]', signature: String(contentBlock.data || ''), redacted: true };
        } else if (contentBlock.type === 'tool_use') {
          block = {
            type: 'tool_call', id: String(contentBlock.id || ''), name: String(contentBlock.name || ''),
            arguments: contentBlock.input && typeof contentBlock.input === 'object' ? contentBlock.input : {}, partial: '',
          };
        }
        if (block) {
          blockByIndex.set(Number(index), block);
          blocks.push(block);
        }
        return block;
      }

      function emitToolProgress(block) {
        if (!block || block.type !== 'tool_call') return;
        var event = {
          type: 'tool_call_delta', callId: block.id, name: block.name,
          receivedChars: String(block.partial || '').length,
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
          body.messages = Messages.toAnthropicMessages(preparedMessages, target);
          emit(input, { type: 'provider_warning', code: 'IMAGE_INPUT_UNSUPPORTED', message: '模型拒绝工具图片，已使用占位文本安全重试一次' });
          opened = await openStream();
        }
        emit(input, { type: 'model_start', apiStyle: API_STYLE, model: model });
        for await (var sse of SSE.iterate(opened.response.body, opened.signal)) {
          if (opened.touch) opened.touch();
          if (sse.event === 'error') {
            var errorPayload;
            try { errorPayload = SSE.parseJson(sse); } catch (_) { errorPayload = null; }
            throw new Error(utils.errorMessageFromBody(errorPayload) || sse.data || 'Anthropic SSE error');
          }
          var event = SSE.parseJson(sse);
          var type = String(event.type || sse.event || '');
          if (type === 'ping') continue;
          if (type === 'message_start') {
            sawMessageStart = true;
            responseId = String(event.message && event.message.id || '');
            responseModel = String(event.message && event.message.model || '');
            applyUsage(usage, event.message && event.message.usage);
          } else if (type === 'content_block_start') {
            emitToolProgress(startBlock(event.index, event.content_block || {}));
          } else if (type === 'content_block_delta') {
            var block = blockByIndex.get(Number(event.index));
            var delta = event.delta || {};
            if (!block) continue;
            if (delta.type === 'text_delta' && block.type === 'text') {
              block.text += String(delta.text || '');
              emit(input, { type: 'text_delta', delta: String(delta.text || '') });
            } else if (delta.type === 'thinking_delta' && block.type === 'reasoning') {
              block.text += String(delta.thinking || '');
              emit(input, { type: 'reasoning_delta', reasoningKind: 'raw', delta: String(delta.thinking || '') });
            } else if (delta.type === 'signature_delta' && block.type === 'reasoning') {
              block.signature = String(block.signature || '') + String(delta.signature || '');
            } else if (delta.type === 'input_json_delta' && block.type === 'tool_call') {
              block.partial += String(delta.partial_json || '');
              block.arguments = utils.parseStreamingJson(block.partial);
              emitToolProgress(block);
            }
          } else if (type === 'content_block_stop') {
            var stopped = blockByIndex.get(Number(event.index));
            if (stopped && stopped.type === 'tool_call' && stopped.partial) {
              stopped.arguments = utils.parseFinalArguments(stopped.partial);
              emitToolProgress(stopped);
            }
            blockByIndex.delete(Number(event.index));
          } else if (type === 'message_delta') {
            if (event.delta && event.delta.stop_reason) finish = finishReason(event.delta.stop_reason, event.delta.stop_details);
            applyUsage(usage, event.usage);
          } else if (type === 'message_stop') {
            sawMessageStop = true;
          }
        }
        if (opened.signal.aborted) throw utils.normalizeError(null, opened.signal);
        if (!sawMessageStart) throw new Error('Anthropic stream ended without message_start');
        if (!sawMessageStop) throw new Error('Anthropic stream ended before message_stop');
        if (!finish) throw new Error('Anthropic stream ended without stop_reason');
        var calls = [];
        var replayBlocks = blocks.map(function (block, index) {
          if (block.type !== 'tool_call') return block;
          // 掺入 responseId 保证跨轮唯一，见 chat provider 同款修复。
          if (!block.id) block.id = 'toolu_' + utils.shortHash((responseId || '') + '|' + Date.now().toString(36) + '|' + (++fallbackIdSequence) + '|' + block.name + ':' + index);
          block.arguments = utils.parseFinalArguments(block.partial || JSON.stringify(block.arguments || {}));
          calls.push({ id: block.id, name: block.name, arguments: block.arguments });
          return { type: 'tool_call', id: block.id, name: block.name, arguments: block.arguments };
        });
        if (calls.length && finish === 'stop') finish = 'tool_calls';
        var content = replayBlocks.filter(function (block) { return block.type === 'text'; }).map(function (block) { return block.text; }).join('');
        var reasoning = replayBlocks.filter(function (block) { return block.type === 'reasoning'; }).map(function (block) { return block.text; }).join('\n\n');
        var result = {
          content: content,
          reasoning: reasoning,
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
        result = compatibility.afterResponse(result);
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

  return Object.freeze({ API_VERSION: API_VERSION, API_STYLE: API_STYLE, mapFinishReason: finishReason, applyUsage: applyUsage, create: create });
});
