// OpenAI Responses stream/replay semantics adapted from pi-mono openai-responses*.ts (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachOpenAIResponsesProvider(root, factory) {
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
  else root.OpenAIResponsesProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utils, SSE, Transport, Messages, ProviderCompat) {
  'use strict';

  var API_VERSION = 1;
  var API_STYLE = 'responses';
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
      return {
        type: 'function',
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.schema && typeof tool.schema === 'object' ? tool.schema : {},
        strict: false,
      };
    });
  }

  function providerInput(preparedMessages, input, target) {
    var output = Messages.toResponsesInput(preparedMessages, target);
    if (input.developer) output.unshift({
      role: 'developer',
      content: [{ type: 'input_text', text: String(input.developer) }],
    });
    return output;
  }

  function reasoningPartTexts(item, key) {
    return (item && Array.isArray(item[key]) ? item[key] : []).map(function (part) {
      return String(part && part.text || '');
    });
  }

  function ensureReasoningPart(slot, key, index) {
    index = Math.max(0, Number(index) || 0);
    while (slot[key].length <= index) slot[key].push('');
    return index;
  }

  function joinedReasoningParts(parts) {
    return (Array.isArray(parts) ? parts : []).filter(function (part) {
      return String(part || '').length > 0;
    }).join('\n\n');
  }

  function mergeReasoningParts(current, incoming) {
    current = Array.isArray(current) ? current : [];
    incoming = Array.isArray(incoming) ? incoming : [];
    if (!incoming.length) return current;
    var hasText = current.some(function (part) { return String(part || '').length > 0; });
    if (!current.length || !hasText) return incoming.slice();
    for (var index = 0; index < incoming.length; index += 1) {
      if (index >= current.length) current.push(incoming[index]);
      else if (!String(current[index] || '').length && String(incoming[index] || '').length) current[index] = incoming[index];
    }
    return current;
  }

  function appendSummary(slot, summaryIndex, delta) {
    delta = String(delta || '');
    if (!delta) return;
    summaryIndex = ensureReasoningPart(slot, 'summaryParts', summaryIndex);
    if (slot.visibleSummaryIndex !== summaryIndex) {
      if (slot.block.text && !/\n\n$/.test(slot.block.text)) {
        slot.block.text += '\n\n';
      }
      slot.visibleSummaryIndex = summaryIndex;
    }
    slot.summaryParts[summaryIndex] += delta;
    slot.block.text += delta;
  }

  function completeSummary(slot, summaryIndex, finalText) {
    finalText = String(finalText || '');
    summaryIndex = ensureReasoningPart(slot, 'summaryParts', summaryIndex);
    var existing = slot.summaryParts[summaryIndex];
    if (!existing && finalText) appendSummary(slot, summaryIndex, finalText);
    else if (finalText.indexOf(existing) === 0 && finalText.length > existing.length) {
      appendSummary(slot, summaryIndex, finalText.slice(existing.length));
    }
    if (finalText) slot.summaryParts[summaryIndex] = finalText;
    slot.block.text = joinedReasoningParts(slot.summaryParts);
  }

  function appendRawReasoning(slot, contentIndex, delta) {
    delta = String(delta || '');
    if (!delta) return;
    contentIndex = ensureReasoningPart(slot, 'rawParts', contentIndex);
    slot.rawParts[contentIndex] += delta;
  }

  function completeRawReasoning(slot, contentIndex, finalText) {
    contentIndex = ensureReasoningPart(slot, 'rawParts', contentIndex);
    if (finalText !== undefined && finalText !== null) slot.rawParts[contentIndex] = String(finalText);
  }

  function isReasoningSummaryRejection(error) {
    if (!error) return false;
    var status = Number(error.status) || 0;
    if (status && [400, 404, 422].indexOf(status) === -1) return false;
    var source = [error.message, error.bodyText,
      error.body && utils.safeJsonStringify(error.body)].filter(Boolean).join(' ').toLowerCase();
    var mentionsSummary = /reasoning(?:[._ -])?summary|reasoning\.encrypted_content|encrypted_content/.test(source);
    var rejectsSummary = /unsupported|not support|does not support|unknown|unrecognized|invalid|not allowed|不支持|未知|无效/.test(source);
    return mentionsSummary && rejectsSummary;
  }

  function omitReasoningSummary(body) {
    if (body.reasoning && typeof body.reasoning === 'object') {
      delete body.reasoning.summary;
      if (!Object.keys(body.reasoning).length) delete body.reasoning;
    }
    if (Array.isArray(body.include)) {
      body.include = body.include.filter(function (item) { return item !== 'reasoning.encrypted_content'; });
      if (!body.include.length) delete body.include;
    }
  }

  function parseUsage(raw) {
    raw = raw || {};
    var details = raw.input_tokens_details || {};
    var cached = Number(details.cached_tokens) || 0;
    var cacheWrite = Number(details.cache_write_tokens) || 0;
    var input = Number(raw.input_tokens) || 0;
    var output = Number(raw.output_tokens) || 0;
    return {
      inputTokens: Math.max(0, input - cached - cacheWrite),
      outputTokens: output,
      totalTokens: Number(raw.total_tokens) || input + output,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: Number(raw.output_tokens_details && raw.output_tokens_details.reasoning_tokens) || 0,
    };
  }

  function statusFinish(status, details) {
    if (status === 'completed') return 'stop';
    if (status === 'incomplete') {
      var reason = String(details && (details.reason || details.code) || 'max_output_tokens');
      if (/content[_ -]?filter|safety|refusal/i.test(reason)) return 'content_filter';
      if (/max[_ -]?(?:output[_ -]?)?tokens|length|incomplete/i.test(reason)) return 'length';
      var incompleteError = new Error('Unhandled OpenAI Responses incomplete reason: ' + reason);
      incompleteError.code = 'PROVIDER_CONTRACT_ERROR';
      throw incompleteError;
    }
    if (status === 'cancelled') return 'aborted';
    if (status === 'failed') return 'transport_error';
    var error = new Error('OpenAI Responses stream ended with non-terminal status: ' + String(status || 'missing'));
    error.code = 'PROVIDER_CONTRACT_ERROR';
    throw error;
  }

  function sanitizeReasoningItem(item) {
    var output = { type: 'reasoning', id: String(item.id || '') };
    if (typeof item.encrypted_content === 'string') output.encrypted_content = item.encrypted_content;
    if (typeof item.status === 'string') output.status = item.status;
    if (Array.isArray(item.summary)) output.summary = item.summary;
    if (Array.isArray(item.content)) output.content = item.content;
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
      throw new TypeError('OpenAIResponsesProvider requires protocol=' + API_STYLE);
    }
    if (!model || !serviceId) throw new Error('OpenAIResponsesProvider requires service id and model');
    var compatibility = ProviderCompat.resolve(service, API_STYLE);
    var endpoint = compatibility.endpoint(Transport.normalizeEndpoint(service.baseUrl, '/responses'));
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
            topicId: String(input.sessionId || ''), maxBytes: 20 * 1024 * 1024,
          }));
        }
        : null);
      var body = {
        model: model,
        input: providerInput(preparedMessages, input, target),
        stream: true,
        store: false,
      };
      if (input.system) body.instructions = String(input.system);
      var tools = toolDefinitions(input.tools);
      if (tools.length) body.tools = tools;
      var temperature = numberSetting(settings.temperature);
      var topP = numberSetting(settings.topP);
      // Keep the main Responses request unbounded. The context builder still
      // reserves output space for fitting the prompt, but that reserve is not
      // an API generation cap. Summary requests remain explicitly bounded.
      var maxTokens = input.purpose === 'context_summary'
        ? Math.max(0, Math.floor(Number(input.maxOutputTokens) || Number(settings.maxTokens) || 0))
        : 0;
      if (maxTokens) body.max_output_tokens = Math.max(16, maxTokens);
      var assistantEffort = String(settings.reasoningEffort || '').trim();
      var effort = assistantEffort && assistantEffort !== 'auto'
        ? assistantEffort
        : String(service.reasoningEffort || '').trim();
      if (modelSettings && typeof modelSettings.applyReasoningEffortToBody === 'function') {
        modelSettings.applyReasoningEffortToBody(body, service, { apiStyle: API_STYLE, reasoningEffort: effort });
      } else if (effort && effort !== 'auto') {
        body.reasoning = { effort: effort };
      }
      var reasoningEnabled = effort !== 'none' && (!body.reasoning || body.reasoning.effort !== 'none');
      // Responses reasoning models reject sampling controls. Keep these fields
      // entirely absent while reasoning is enabled; zero/default values are not
      // equivalent to omission at the Provider boundary.
      if (!reasoningEnabled) {
        if (temperature !== undefined) body.temperature = temperature;
        if (topP !== undefined) body.top_p = topP;
      }
      var requestedReasoningSummary = false;
      if (reasoningEnabled) {
        if (!body.reasoning || typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)) body.reasoning = {};
        if (!Object.prototype.hasOwnProperty.call(body.reasoning, 'summary')) body.reasoning.summary = 'auto';
        if (!Array.isArray(body.include)) body.include = [];
        if (body.include.indexOf('reasoning.encrypted_content') === -1) body.include.push('reasoning.encrypted_content');
        requestedReasoningSummary = body.reasoning.summary !== 'none';
      }

      var sessionId = String(input.sessionId || '').trim();
      var promptCacheKey = String(input.promptCacheKey || '').trim();
      if (promptCacheKey) body.prompt_cache_key = promptCacheKey.slice(0, 64);
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
      requestedReasoningSummary = !!(body.reasoning && body.reasoning.summary && body.reasoning.summary !== 'none');
      var opened = null;
      var responseId = '';
      var responseModel = '';
      var usage = utils.emptyUsage();
      var finish = '';
      var endTurn;
      var sawTerminal = false;
      var slots = new Map();
      var blocks = [];
      // Retain completed stream slots for the terminal reconciliation pass.
      // Item ids may change, while compatible endpoints may omit output_index
      // or omit reasoning items from response.completed.output.
      var finalizedSlots = new Map();
      var finalizedToolCalls = new Map();
      var activeReasoningSlot = null;

      function slotTypeForItem(item) {
        if (item.type === 'message') return 'text';
        if (item.type === 'function_call') return 'tool_call';
        return item.type;
      }

      function messageItemText(item) {
        return (item && Array.isArray(item.content) ? item.content : []).map(function (part) {
          return part && part.type === 'output_text'
            ? String(part.text || '')
            : String(part && part.refusal || '');
        }).join('');
      }

      function createSlot(outputIndex, item) {
        outputIndex = Number(outputIndex);
        if (slots.has(outputIndex)) return slots.get(outputIndex);
        var finalized = finalizedSlots.get(outputIndex);
        if (finalized && finalized.type === slotTypeForItem(item)) return finalized;
        var slot = null;
        if (item.type === 'reasoning') {
          var summaryParts = reasoningPartTexts(item, 'summary');
          slot = {
            type: 'reasoning',
            block: { type: 'reasoning', text: joinedReasoningParts(summaryParts), signature: null },
            itemId: String(item.id || ''),
            summaryParts: summaryParts,
            rawParts: reasoningPartTexts(item, 'content'),
            visibleSummaryIndex: summaryParts.length ? summaryParts.length - 1 : -1,
          };
        } else if (item.type === 'message') {
          slot = { type: 'text', block: { type: 'text', text: '', itemId: String(item.id || ''), phase: item.phase } };
        } else if (item.type === 'function_call') {
          slot = {
            type: 'tool_call',
            block: {
              type: 'tool_call',
              id: String(item.call_id || '') + '|' + String(item.id || ''),
              name: String(item.name || ''),
              arguments: {},
              partial: String(item.arguments || ''),
            },
          };
        }
        if (slot) {
          slots.set(outputIndex, slot);
          blocks.push(slot.block);
        }
        return slot;
      }

      function slot(outputIndex, type) {
        var value = slots.get(Number(outputIndex));
        return value && value.type === type ? value : null;
      }

      function messageSlotForSnapshot(outputIndex, item, claimed) {
        var candidates = [];
        function collect(candidate) {
          if (!candidate || candidate.type !== 'text' || claimed.has(candidate)
              || candidates.indexOf(candidate) !== -1) return;
          candidates.push(candidate);
        }
        slots.forEach(collect);
        finalizedSlots.forEach(collect);
        if (!candidates.length) return null;

        var itemId = String(item && item.id || '');
        if (itemId) {
          var identified = candidates.filter(function (candidate) {
            return String(candidate.block.itemId || '') === itemId;
          });
          if (identified.length === 1) return identified[0];
        }

        var phase = item && (item.phase === 'commentary' || item.phase === 'final_answer')
          ? item.phase : '';
        var phased = phase ? candidates.filter(function (candidate) {
          return candidate.block.phase === phase;
        }) : candidates;
        if (phased.length) candidates = phased;

        var finalText = messageItemText(item);
        if (finalText) {
          var exact = candidates.filter(function (candidate) {
            return String(candidate.block.text || '') === finalText;
          });
          if (exact.length === 1) return exact[0];

          var compatible = candidates.filter(function (candidate) {
            var streamed = String(candidate.block.text || '');
            return !!streamed && finalText.indexOf(streamed) === 0;
          });
          if (compatible.length === 1) return compatible[0];
        }

        var indexed = slots.get(Number(outputIndex)) || finalizedSlots.get(Number(outputIndex));
        if (indexed && candidates.indexOf(indexed) !== -1) return indexed;
        return candidates.length === 1 ? candidates[0] : null;
      }

      function retainFinalizedSlot(outputIndex, current) {
        slots.forEach(function (candidate, key) {
          if (candidate === current) slots.delete(key);
        });
        finalizedSlots.forEach(function (candidate, key) {
          if (candidate === current) finalizedSlots.delete(key);
        });
        finalizedSlots.set(Number(outputIndex), current);
      }

      function emitToolProgress(block) {
        if (!block || block.type !== 'tool_call') return;
        var event = {
          type: 'tool_call_delta', callId: block.id, name: block.name,
          receivedChars: String(block.partial || '').length,
        };
        emit(input, event);
      }

      function reasoningSlotByItemId(itemId) {
        itemId = String(itemId || '');
        if (!itemId) return null;
        var match = null;
        slots.forEach(function (candidate) {
          if (!match && candidate.type === 'reasoning' && candidate.itemId === itemId) match = candidate;
        });
        return match;
      }

      function reasoningSlotForEvent(event) {
        var indexed = event && event.output_index !== undefined && event.output_index !== null
          ? slot(event.output_index, 'reasoning')
          : null;
        if (indexed) return indexed;
        var itemId = String(event && event.item_id || '');
        if (itemId) {
          var identified = reasoningSlotByItemId(itemId);
          return identified && identified === activeReasoningSlot ? identified : null;
        }
        return activeReasoningSlot;
      }

      // 复合 id 是 call_id|item_id。call_id 段在整段流里稳定，item_id 段可能在
      // 流式早期缺失，绝不能拿它作为工具调用的身份判据。
      function toolCallCallId(id) {
        return String(id || '').split('|')[0];
      }

      function toolCallBlockByCallId(callId) {
        callId = String(callId || '');
        if (!callId) return null;
        for (var index = 0; index < blocks.length; index += 1) {
          if (blocks[index].type === 'tool_call' && toolCallCallId(blocks[index].id) === callId) return blocks[index];
        }
        return null;
      }

      function toolCallBlockByItemId(itemId) {
        itemId = String(itemId || '');
        if (!itemId) return null;
        for (var index = 0; index < blocks.length; index += 1) {
          var block = blocks[index];
          if (block.type === 'tool_call' && String(block.id).split('|')[1] === itemId) return block;
        }
        return null;
      }

      function finalizeToolCallBlock(block, item) {
        block.id = String(item.call_id || toolCallCallId(block.id)) + '|' + String(item.id || block.id.split('|')[1] || '');
        block.name = String(item.name || block.name || '');
        block.partial = String(item.arguments || block.partial || '{}');
        block.arguments = utils.parseFinalArguments(block.partial);
      }

      // 工具调用收尾按三级身份幂等合并：call_id → item.id → 已收尾的 output_index。
      // 流式 done 与终止 completed 两条路径可能重复送达同一次调用（中继甚至会
      // 丢失 call_id/item.id），必须合并成一条，否则一次调用会裂成两条 —— id 相同
      // 时整轮被 normalizeCalls 拒绝，id 不同时副作用被执行两次。
      function finalizeToolCall(outputIndex, item) {
        outputIndex = Number(outputIndex);
        var existing = toolCallBlockByCallId(item.call_id)
          || toolCallBlockByItemId(item.id)
          || finalizedToolCalls.get(outputIndex)
          || null;
        var stale = slots.get(outputIndex);
        var block;
        if (existing) {
          finalizeToolCallBlock(existing, item);
          if (stale && stale.type === 'tool_call' && stale.block !== existing && !toolCallCallId(stale.block.id)) {
            // 只移除还没有独立身份（call_id 段为空）的占位块——它是同一次调用
            // 在 added 阶段的残留；已有身份的块可能属于另一次调用，不能删。
            var staleIndex = blocks.indexOf(stale.block);
            if (staleIndex !== -1) blocks.splice(staleIndex, 1);
          }
          block = existing;
        } else if (stale && stale.type === 'tool_call') {
          finalizeToolCallBlock(stale.block, item);
          block = stale.block;
        } else {
          block = {
            type: 'tool_call',
            id: String(item.call_id || '') + '|' + String(item.id || ''),
            name: String(item.name || ''),
            arguments: {},
            partial: String(item.arguments || ''),
          };
          finalizeToolCallBlock(block, item);
          blocks.push(block);
        }
        slots.delete(outputIndex);
        finalizedToolCalls.set(outputIndex, block);
        return block;
      }

      function finalizeItem(outputIndex, item, preferredSlot) {
        if (item.type === 'function_call') {
          emitToolProgress(finalizeToolCall(outputIndex, item));
          return null;
        }
        var current = preferredSlot || slots.get(Number(outputIndex)) || createSlot(Number(outputIndex), item);
        if (!current) return null;
        if (item.type === 'reasoning' && current.type === 'reasoning') {
          var summaryParts = reasoningPartTexts(item, 'summary');
          var rawParts = reasoningPartTexts(item, 'content');
          current.summaryParts = mergeReasoningParts(current.summaryParts, summaryParts);
          current.rawParts = mergeReasoningParts(current.rawParts, rawParts);
          current.block.text = joinedReasoningParts(current.summaryParts);
          // Some relays omit the terminal id or collapse summary parts. Use
          // the terminal snapshot to fill gaps without replacing the complete
          // output_item.done identity, encryption, or summary structure.
          var streamSignature = current.block.signature || {};
          if (!current.itemId && String(item.id || '').trim()) current.itemId = String(item.id);
          var signedItem = Object.assign({}, item, streamSignature);
          signedItem.type = 'reasoning';
          signedItem.id = String(streamSignature.id || current.itemId || item.id || '');
          if (!String(streamSignature.encrypted_content || '')
              && typeof item.encrypted_content === 'string') {
            signedItem.encrypted_content = item.encrypted_content;
          }
          if (current.summaryParts.length) {
            signedItem.summary = current.summaryParts.map(function (part) { return { type: 'summary_text', text: part }; });
          }
          if (current.rawParts.length) {
            signedItem.content = current.rawParts.map(function (part) { return { type: 'reasoning_text', text: part }; });
          }
          current.block.signature = sanitizeReasoningItem(signedItem);
        } else if (item.type === 'message' && current.type === 'text') {
          current.block.text = messageItemText(item) || current.block.text;
          current.block.itemId = String(item.id || current.block.itemId || '');
          if (item.phase === 'commentary' || item.phase === 'final_answer') current.block.phase = item.phase;
        }
        if (current === activeReasoningSlot) activeReasoningSlot = null;
        retainFinalizedSlot(outputIndex, current);
        return current;
      }

      function finalizeResponse(response) {
        sawTerminal = true;
        responseId = String(response && response.id || responseId || '');
        responseModel = String(response && response.model || responseModel || '');
        if (response && response.end_turn === true) endTurn = true;
        else if (response && response.end_turn === false) endTurn = false;
        if (response && response.usage) usage = parseUsage(response.usage);
        var claimedMessageSlots = new Set();
        (response && Array.isArray(response.output) ? response.output : []).forEach(function (item, index) {
          // response.completed is a reconciliation snapshot. Re-run the same
          // item through the idempotent finalizer. Some compatible endpoints
          // omit output_index or filter reasoning from the terminal output, so
          // the terminal array index is only a fallback identity.
          var preferred = item && item.type === 'message'
            ? messageSlotForSnapshot(index, item, claimedMessageSlots)
            : null;
          var finalized = finalizeItem(index, item, preferred);
          if (finalized && finalized.type === 'text') claimedMessageSlots.add(finalized);
        });
        finish = statusFinish(response && response.status, response && (response.incomplete_details || response.error));
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

      async function openWithCompatibilityFallbacks() {
        var droppedImages = false;
        var droppedReasoningSummary = false;
        for (;;) {
          try { return await openStream(); }
          catch (requestError) {
            if (!droppedReasoningSummary && requestedReasoningSummary && isReasoningSummaryRejection(requestError)) {
              droppedReasoningSummary = true;
              requestedReasoningSummary = false;
              omitReasoningSummary(body);
              emit(input, {
                type: 'provider_warning', code: 'REASONING_SUMMARY_UNSUPPORTED',
                message: '模型不支持 reasoning summary，已关闭可见思考摘要并安全重试一次',
              });
              continue;
            }
            if (!droppedImages && Messages.hasToolImages(preparedMessages) && Messages.isImageInputRejection(requestError)) {
              droppedImages = true;
              preparedMessages = Messages.omitToolImages(preparedMessages, 'IMAGE_INPUT_UNSUPPORTED');
              body.input = providerInput(preparedMessages, input, target);
              emit(input, { type: 'provider_warning', code: 'IMAGE_INPUT_UNSUPPORTED', message: '模型拒绝工具图片，已使用占位文本安全重试一次' });
              continue;
            }
            throw requestError;
          }
        }
      }

      try {
        opened = await openWithCompatibilityFallbacks();
        emit(input, { type: 'model_start', apiStyle: API_STYLE, model: model });
        for await (var sse of SSE.iterate(opened.response.body, opened.signal)) {
          if (opened.touch) opened.touch();
          if (sse.event === 'error') throw new Error(sse.data || 'OpenAI Responses SSE error');
          if (sse.data.trim() === '[DONE]') continue;
          var event = SSE.parseJson(sse);
          var type = String(event.type || sse.event || '');
          if (type === 'response.created') {
            responseId = String(event.response && event.response.id || responseId || '');
            responseModel = String(event.response && event.response.model || responseModel || '');
          } else if (type === 'response.output_item.added') {
            activeReasoningSlot = null;
            var addedSlot = createSlot(Number(event.output_index), event.item || {});
            if (addedSlot && addedSlot.type === 'reasoning') activeReasoningSlot = addedSlot;
            if (addedSlot && addedSlot.type === 'tool_call' && addedSlot.block.partial) {
              addedSlot.block.arguments = utils.parseStreamingJson(addedSlot.block.partial);
              emitToolProgress(addedSlot.block);
            }
          } else if (type === 'response.reasoning_summary_text.delta') {
            var reasoningSlot = reasoningSlotForEvent(event);
            if (reasoningSlot) {
              appendSummary(reasoningSlot, event.summary_index, event.delta);
              emit(input, { type: 'reasoning_delta', reasoningKind: 'summary', delta: String(event.delta || '') });
            }
          } else if (type === 'response.reasoning_summary_text.done') {
            var completedSummarySlot = reasoningSlotForEvent(event);
            if (completedSummarySlot) completeSummary(completedSummarySlot, event.summary_index, event.text);
          } else if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
            var summarySlot = reasoningSlotForEvent(event);
            if (summarySlot) {
              var summaryPart = event.part || {};
              ensureReasoningPart(summarySlot, 'summaryParts', event.summary_index);
              if (type === 'response.reasoning_summary_part.done' && summaryPart.text !== undefined) {
                completeSummary(summarySlot, event.summary_index, summaryPart.text);
              }
            }
          } else if (type === 'response.reasoning_text.delta') {
            var rawReasoningSlot = reasoningSlotForEvent(event);
            if (rawReasoningSlot) {
              appendRawReasoning(rawReasoningSlot, event.content_index, event.delta);
              emit(input, { type: 'reasoning_delta', reasoningKind: 'raw', delta: String(event.delta || '') });
            }
          } else if (type === 'response.reasoning_text.done') {
            var completedRawReasoningSlot = reasoningSlotForEvent(event);
            if (completedRawReasoningSlot) completeRawReasoning(completedRawReasoningSlot, event.content_index, event.text);
          } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
            var textSlot = slot(event.output_index, 'text');
            if (textSlot) {
              textSlot.block.text += String(event.delta || '');
              emit(input, {
                type: 'text_delta', delta: String(event.delta || ''),
                phase: textSlot.block.phase === 'commentary' ? 'commentary'
                  : (textSlot.block.phase === 'final_answer' ? 'final_answer' : ''),
              });
            }
          } else if (type === 'response.function_call_arguments.delta') {
            var toolSlot = slot(event.output_index, 'tool_call');
            if (toolSlot) {
              toolSlot.block.partial += String(event.delta || '');
              toolSlot.block.arguments = utils.parseStreamingJson(toolSlot.block.partial);
              emitToolProgress(toolSlot.block);
            }
          } else if (type === 'response.function_call_arguments.done') {
            var doneSlot = slot(event.output_index, 'tool_call');
            if (doneSlot) {
              var completeArguments = String(event.arguments || '');
              var previous = doneSlot.block.partial;
              doneSlot.block.partial = completeArguments;
              doneSlot.block.arguments = utils.parseStreamingJson(completeArguments);
              if (completeArguments.indexOf(previous) === 0 && completeArguments.length > previous.length) {
                emitToolProgress(doneSlot.block);
              }
            }
          } else if (type === 'response.output_item.done') {
            finalizeItem(Number(event.output_index), event.item || {});
          } else if (type === 'response.completed' || type === 'response.incomplete') {
            finalizeResponse(event.response || {});
          } else if (type === 'response.failed') {
            sawTerminal = true;
            var responseError = event.response && event.response.error;
            throw new Error(responseError ? String(responseError.code || 'unknown') + ': ' + String(responseError.message || '') : 'OpenAI Responses failed');
          } else if (type === 'error') {
            throw new Error('Error Code ' + String(event.code || 'unknown') + ': ' + String(event.message || 'Unknown error'));
          }
        }
        if (opened.signal.aborted) throw utils.normalizeError(null, opened.signal);
        if (!sawTerminal) throw new Error('OpenAI Responses stream ended before a terminal response event');
        var calls = [];
        var replayBlocks = blocks.map(function (block, index) {
          if (block.type !== 'tool_call') return block;
          if (!block.id || block.id === '|') {
            // 掺入 responseId 保证跨轮唯一，见 chat provider 同款修复。
            var fallbackHash = utils.shortHash((responseId || '') + '|' + Date.now().toString(36) + '|' + (++fallbackIdSequence) + '|' + block.name + ':' + index);
            block.id = 'call_' + index + '_' + fallbackHash + '|fc_' + fallbackHash;
          }
          block.arguments = utils.parseFinalArguments(block.partial || '{}');
          calls.push({ id: block.id, name: block.name, arguments: block.arguments });
          return { type: 'tool_call', id: block.id, name: block.name, arguments: block.arguments };
        });
        if (calls.length && finish === 'stop') finish = 'tool_calls';
        var commentary = replayBlocks.filter(function (block) {
          return block.type === 'text' && block.phase === 'commentary';
        }).map(function (block) { return block.text; }).join('');
        var content = replayBlocks.filter(function (block) {
          return block.type === 'text' && block.phase !== 'commentary';
        }).map(function (block) { return block.text; }).join('');
        var hasRawReasoning = false;
        var reasoning = replayBlocks.filter(function (block) {
          return block.type === 'reasoning';
        }).map(function (block) {
          var raw = block.signature && Array.isArray(block.signature.content)
            ? block.signature.content.map(function (part) { return String(part && part.text || ''); }).filter(Boolean).join('')
            : '';
          if (raw) hasRawReasoning = true;
          return [block.text, raw].filter(Boolean).join('\n\n');
        }).join('\n\n');
        var result = {
          content: content,
          commentary: commentary,
          reasoning: reasoning,
          reasoningKind: hasRawReasoning ? 'raw' : 'summary',
          calls: calls,
          usage: usage,
          finishReason: finish,
          endTurn: endTurn,
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

  return Object.freeze({ API_VERSION: API_VERSION, API_STYLE: API_STYLE, mapFinishReason: statusFinish, parseUsage: parseUsage, create: create });
});
