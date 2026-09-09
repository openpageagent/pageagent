// Cross-provider replay transformation adapted from pi-mono transform-messages/OpenAI Responses (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachProviderMessageNormalizer(root, factory) {
  'use strict';
  var utilities = typeof module === 'object' && module.exports
    ? require('./provider-utils')
    : root.BrowserProviderUtilities;
  var api = factory(utilities);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProviderMessageNormalizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utilities) {
  'use strict';

  var API_VERSION = 1;
  var REPLAY_VERSION = 1;
  var STYLES = Object.freeze({ chat_completions: true, responses: true, anthropic: true });
  var MAX_SIGNATURE_CHARS = 2 * 1024 * 1024;
  var ARTIFACT_URI_PATTERN = /^\/image-artifacts\/[A-Za-z0-9._~-]{1,240}$/;
  var DATA_IMAGE_PATTERN = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

  function clone(value) { return utilities.cloneJson(value); }
  function trimmed(value) { return utilities.text(value).trim(); }

  function normalizeMimeType(value) {
    var mimeType = trimmed(value).toLowerCase().split(';')[0];
    return /^image\/[a-z0-9.+-]+$/.test(mimeType) ? mimeType : '';
  }

  function normalizeImagePart(part, includeResolvedData) {
    part = part || {};
    var artifactUri = trimmed(part.artifactUri || part.artifact_uri);
    if (!ARTIFACT_URI_PATTERN.test(artifactUri)) return null;
    var output = { type: 'image', artifactUri: artifactUri };
    var mimeType = normalizeMimeType(part.mimeType || part.mediaType || part.media_type);
    if (mimeType) output.mimeType = mimeType;
    var detail = trimmed(part.detail).toLowerCase();
    if (detail === 'auto' || detail === 'high' || detail === 'low' || detail === 'original') output.detail = detail;
    if (typeof part.alt === 'string' && part.alt.trim()) output.alt = utilities.sanitizeSurrogates(part.alt).slice(0, 500);
    ['width', 'height', 'byteLength'].forEach(function (key) {
      var number = Number(part[key]);
      if (Number.isFinite(number) && number >= 0) output[key] = Math.floor(number);
    });
    ['representation', 'sourceKind', 'acquisitionSource'].forEach(function (key) {
      if (typeof part[key] === 'string' && part[key].trim()) output[key] = part[key].trim().slice(0, 100);
    });
    if (includeResolvedData && typeof part.dataUrl === 'string' && DATA_IMAGE_PATTERN.test(part.dataUrl)) {
      output.dataUrl = part.dataUrl;
      if (!output.mimeType) output.mimeType = normalizeMimeType(DATA_IMAGE_PATTERN.exec(part.dataUrl)[1]);
    }
    return output;
  }

  function contentParts(content, options) {
    options = options || {};
    var source = Array.isArray(content) ? content : [content];
    var output = [];
    source.forEach(function (part) {
      if (typeof part === 'string') {
        output.push({ type: 'text', text: utilities.sanitizeSurrogates(part) });
        return;
      }
      if (part === undefined || part === null) return;
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        output.push({ type: 'text', text: utilities.sanitizeSurrogates(String(part)) });
        return;
      }
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        output.push({ type: 'text', text: utilities.sanitizeSurrogates(part.text) });
        return;
      }
      if (part.type === 'image') {
        var image = normalizeImagePart(part, options.includeResolvedData === true);
        output.push(image || { type: 'text', text: '[图片不可用：Artifact 引用无效]' });
        return;
      }
      output.push({ type: 'text', text: utilities.safeJsonStringify(part) });
    });
    return output;
  }

  function normalizeContent(content) {
    if (typeof content === 'string') return utilities.sanitizeSurrogates(content);
    if (content === undefined || content === null) return '';
    var parts = contentParts(content);
    return parts.length ? parts : '';
  }

  function contentText(content) {
    return contentParts(content).map(function (part) {
      if (part.type === 'text') return part.text;
      return '[image: ' + part.artifactUri + ']';
    }).filter(Boolean).join('\n');
  }

  function imageParts(content, includeResolvedData) {
    return contentParts(content, { includeResolvedData: includeResolvedData === true }).filter(function (part) {
      return part.type === 'image';
    });
  }

  function textOnly(content) {
    return contentParts(content).filter(function (part) { return part.type === 'text'; })
      .map(function (part) { return part.text; }).filter(Boolean).join('\n');
  }

  function imageUnavailableText(error) {
    var code = trimmed(error && error.code);
    return '[图片不可用' + (code ? '：' + code : '：Artifact 已过期或不存在') + ']';
  }

  function hasToolImages(messages) {
    return (Array.isArray(messages) ? messages : []).some(function (message) {
      return message && message.role === 'tool' && imageParts(message.content, true).length > 0;
    });
  }

  function omitToolImages(messages, code) {
    var placeholder = '[图片已省略：' + trimmed(code || 'IMAGE_INPUT_UNSUPPORTED') + ']';
    return (Array.isArray(messages) ? messages : []).map(function (message) {
      if (!message || message.role !== 'tool') return message;
      var parts = contentParts(message.content, { includeResolvedData: false });
      if (!parts.some(function (part) { return part.type === 'image'; })) return message;
      return Object.assign({}, message, {
        content: parts.map(function (part) {
          return part.type === 'image' ? { type: 'text', text: placeholder } : part;
        }),
      });
    });
  }

  function isImageInputRejection(error) {
    if (!error) return false;
    var status = Number(error.status) || 0;
    if (status && [400, 413, 415, 422].indexOf(status) === -1) return false;
    var source = [error.message, error.bodyText,
      error.body && utilities.safeJsonStringify(error.body)].filter(Boolean).join(' ').toLowerCase();
    var mentionsImage = /(?:image|vision|multimodal|input_image|image_url|base64|图片|图像|视觉)/i.test(source);
    var rejectsImage = /(?:unsupported|not support|does not support|invalid|malformed|decode|format|media type|too (?:large|many)|size|dimension|不支持|无效|无法解码|格式|过大|尺寸)/i.test(source);
    return mentionsImage && rejectsImage;
  }

  async function prepareProviderMessages(messages, resolveImageArtifact) {
    var source = Array.isArray(messages) ? messages : [];
    return Promise.all(source.map(async function (message) {
      if (!message || typeof message !== 'object') return message;
      var canonical = normalizeContent(message.content);
      if (!Array.isArray(canonical) || !canonical.some(function (part) { return part.type === 'image'; })) {
        return Object.assign({}, message, { content: canonical });
      }
      var resolved = await Promise.all(canonical.map(async function (part) {
        if (part.type !== 'image') return part;
        if (typeof resolveImageArtifact !== 'function') {
          return { type: 'text', text: imageUnavailableText({ code: 'ARTIFACT_RESOLVER_UNAVAILABLE' }) };
        }
        try {
          var value = await resolveImageArtifact(part.artifactUri, {
            detail: part.detail || 'high',
            mimeType: part.mimeType || '',
          });
          var dataUrl = typeof value === 'string' ? value : value && value.dataUrl;
          var matched = typeof dataUrl === 'string' ? DATA_IMAGE_PATTERN.exec(dataUrl) : null;
          if (!matched) throw Object.assign(new Error('Resolved image is not a base64 Data URL'), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
          return Object.assign({}, part, {
            dataUrl: dataUrl,
            mimeType: normalizeMimeType(value && value.mimeType || matched[1]) || part.mimeType,
          });
        } catch (error) {
          return { type: 'text', text: imageUnavailableText(error) };
        }
      }));
      return Object.assign({}, message, { content: resolved });
    }));
  }

  function openAiContent(content) {
    var parts = contentParts(content, { includeResolvedData: true });
    var hasImage = parts.some(function (part) { return part.type === 'image' && part.dataUrl; });
    if (!hasImage) return parts.filter(function (part) { return part.type === 'text'; })
      .map(function (part) { return part.text; }).filter(Boolean).join('\n');
    return parts.map(function (part) {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (!part.dataUrl) return { type: 'text', text: '[图片不可用：Artifact 已过期或不存在]' };
      return {
        type: 'image_url',
        image_url: { url: part.dataUrl, detail: part.detail === 'original' ? 'high' : (part.detail || 'high') },
      };
    });
  }

  function responsesContent(content, textType) {
    var parts = contentParts(content, { includeResolvedData: true });
    return parts.map(function (part) {
      if (part.type === 'text') return { type: textType || 'input_text', text: part.text };
      if (!part.dataUrl) return { type: textType || 'input_text', text: '[图片不可用：Artifact 已过期或不存在]' };
      return {
        type: 'input_image', image_url: part.dataUrl,
        detail: part.detail === 'original' ? 'high' : (part.detail || 'high'),
      };
    });
  }

  function anthropicContent(content) {
    var parts = contentParts(content, { includeResolvedData: true });
    return parts.map(function (part) {
      if (part.type === 'text') return { type: 'text', text: part.text };
      var matched = part.dataUrl && DATA_IMAGE_PATTERN.exec(part.dataUrl);
      if (!matched) return { type: 'text', text: '[图片不可用：Artifact 已过期或不存在]' };
      return {
        type: 'image',
        source: { type: 'base64', media_type: normalizeMimeType(part.mimeType || matched[1]), data: matched[2] },
      };
    });
  }

  function normalizeArguments(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError((label || 'Tool call') + ' arguments must be an object');
    }
    return clone(value);
  }

  function normalizeCall(value, index) {
    value = value || {};
    var id = trimmed(value.id);
    var name = trimmed(value.name).toUpperCase();
    if (!id || !name) throw new TypeError('Canonical tool call requires id and name at index ' + index);
    return { id: id, name: name, arguments: normalizeArguments(value.arguments, 'Tool call ' + id) };
  }

  function normalizeCalls(values) {
    if (!Array.isArray(values)) throw new TypeError('Canonical assistant calls must be an array');
    var seen = Object.create(null);
    return values.map(function (value, index) {
      var call = normalizeCall(value, index);
      if (seen[call.id]) throw new TypeError('Duplicate canonical tool call id: ' + call.id);
      seen[call.id] = true;
      return call;
    });
  }

  function sanitizeTextSignature(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    var output = {};
    if (trimmed(value.itemId)) output.itemId = trimmed(value.itemId).slice(0, 256);
    if (value.phase === 'commentary' || value.phase === 'final_answer') output.phase = value.phase;
    return Object.keys(output).length ? output : undefined;
  }

  function sanitizeReasoningItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'reasoning') return undefined;
    var id = trimmed(value.id);
    if (!id) return undefined;
    var output = { type: 'reasoning', id: id.slice(0, 256) };
    if (typeof value.encrypted_content === 'string') output.encrypted_content = value.encrypted_content.slice(0, MAX_SIGNATURE_CHARS);
    if (typeof value.status === 'string') output.status = value.status.slice(0, 64);
    ['summary', 'content'].forEach(function (key) {
      if (!Array.isArray(value[key])) return;
      output[key] = value[key].map(function (item) {
        if (!item || typeof item !== 'object') return null;
        var text = typeof item.text === 'string' ? utilities.sanitizeSurrogates(item.text) : '';
        return text ? { type: String(item.type || 'summary_text').slice(0, 64), text: text } : null;
      }).filter(Boolean).slice(0, 64);
    });
    return output;
  }

  function sanitizeThoughtSignature(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (value.type !== 'reasoning.encrypted' || !trimmed(value.id) || typeof value.data !== 'string') return undefined;
    return {
      type: 'reasoning.encrypted',
      id: trimmed(value.id).slice(0, 256),
      data: value.data.slice(0, MAX_SIGNATURE_CHARS),
    };
  }

  function sanitizeReplayBlock(block, index) {
    block = block || {};
    if (block.type === 'text') {
      var textBlock = { type: 'text', text: utilities.sanitizeSurrogates(block.text) };
      var textSignature = sanitizeTextSignature(block);
      if (textSignature) Object.assign(textBlock, textSignature);
      return textBlock;
    }
    if (block.type === 'reasoning') {
      var reasoning = { type: 'reasoning', text: utilities.sanitizeSurrogates(block.text) };
      if (block.field === 'reasoning_content' || block.field === 'reasoning' || block.field === 'reasoning_text') {
        reasoning.field = block.field;
      }
      if (typeof block.signature === 'string' && block.signature) reasoning.signature = block.signature.slice(0, MAX_SIGNATURE_CHARS);
      else {
        var item = sanitizeReasoningItem(block.signature);
        if (item) reasoning.signature = item;
      }
      if (block.redacted === true) reasoning.redacted = true;
      return reasoning;
    }
    if (block.type === 'tool_call') {
      var call = normalizeCall(block, index);
      var toolBlock = { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments };
      var thoughtSignature = sanitizeThoughtSignature(block.thoughtSignature);
      if (thoughtSignature) toolBlock.thoughtSignature = thoughtSignature;
      return toolBlock;
    }
    throw new TypeError('Unknown provider replay block type at index ' + index + ': ' + String(block.type || ''));
  }

  function sanitizeReplayMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('providerReplay is required');
    if (Number(value.version) !== REPLAY_VERSION) throw new TypeError('providerReplay.version must be ' + REPLAY_VERSION);
    var apiStyle = trimmed(value.apiStyle);
    var serviceId = trimmed(value.serviceId);
    var model = trimmed(value.model);
    if (!STYLES[apiStyle] || !serviceId || !model) throw new TypeError('providerReplay requires canonical apiStyle, serviceId, and model');
    if (!Array.isArray(value.blocks)) throw new TypeError('providerReplay.blocks must be an array');
    var output = {
      version: REPLAY_VERSION,
      apiStyle: apiStyle,
      serviceId: serviceId,
      model: model,
      blocks: value.blocks.map(sanitizeReplayBlock),
    };
    if (trimmed(value.responseId)) output.responseId = trimmed(value.responseId).slice(0, 512);
    return output;
  }

  function createReplay(input) {
    return sanitizeReplayMetadata(Object.assign({ version: REPLAY_VERSION }, input || {}));
  }

  function createAssistantHistoryMessage(response) {
    response = response || {};
    var calls = normalizeCalls(response.calls || []);
    var replay = sanitizeReplayMetadata(response.replay);
    var replayCalls = replay.blocks.filter(function (block) { return block.type === 'tool_call'; });
    if (replayCalls.length !== calls.length) throw new TypeError('Provider replay tool blocks do not match canonical calls');
    for (var index = 0; index < calls.length; index += 1) {
      if (calls[index].id !== replayCalls[index].id || calls[index].name !== replayCalls[index].name) {
        throw new TypeError('Provider replay tool block identity mismatch at index ' + index);
      }
    }
    var message = {
      role: 'assistant',
      content: contentText(response.content),
      providerReplay: replay,
    };
    if (calls.length) message.calls = calls;
    return message;
  }

  function compatibleReplay(message, target) {
    var replay = message && message.providerReplay;
    return !!(replay && replay.version === REPLAY_VERSION
      && replay.apiStyle === target.apiStyle
      && replay.serviceId === target.serviceId
      && replay.model === target.model);
  }

  function reasoningText(message) {
    var replay = message && message.providerReplay;
    if (!replay || !Array.isArray(replay.blocks)) return '';
    return replay.blocks.filter(function (block) {
      // Chat Completions 的 reasoning_* 是原始兼容字段，不能在跨协议回放时
      // 被提升为普通助手文本或 Responses 的可见摘要。
      return block.type === 'reasoning' && !block.redacted
        && block.field !== 'reasoning_content' && block.field !== 'reasoning' && block.field !== 'reasoning_text';
    })
      .map(function (block) { return block.text; }).filter(Boolean).join('\n\n');
  }

  function portableAssistantText(message) {
    var reasoning = reasoningText(message);
    var content = contentText(message && message.content);
    return [reasoning, content].filter(Boolean).join('\n\n');
  }

  function normalizeIdPart(value, max) {
    var normalized = trimmed(value).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+$/, '');
    if (!normalized) normalized = 'call_' + utilities.shortHash(value);
    return normalized.slice(0, max || 64);
  }

  function chatCallId(value) { return normalizeIdPart(String(value).split('|')[0], 40); }
  function anthropicCallId(value) { return normalizeIdPart(String(value).split('|')[0], 64); }

  function uniqueMappedId(base, source, used, max) {
    var candidate = String(base || '');
    if (!used[candidate] || used[candidate] === source) {
      used[candidate] = source;
      return candidate;
    }
    var suffix = '_' + utilities.shortHash(source);
    candidate = candidate.slice(0, Math.max(1, max - suffix.length)) + suffix;
    var counter = 2;
    while (used[candidate] && used[candidate] !== source) {
      var numbered = suffix + '_' + counter;
      candidate = base.slice(0, Math.max(1, max - numbered.length)) + numbered;
      counter += 1;
    }
    used[candidate] = source;
    return candidate;
  }

  function responsesCallIdentity(value, foreign) {
    var parts = String(value || '').split('|');
    var callId = normalizeIdPart(parts[0], 64);
    var itemId = parts[1] && !foreign ? normalizeIdPart(parts[1], 61) : 'fc_' + utilities.shortHash(value);
    if (itemId.indexOf('fc_') !== 0) itemId = 'fc_' + itemId;
    return { callId: callId, itemId: itemId.slice(0, 64), id: callId + '|' + itemId.slice(0, 64) };
  }

  function toOpenAIChat(messages, target) {
    var output = [];
    var mappedIds = Object.create(null);
    var usedIds = Object.create(null);
    var assistantReasoningField = target && target.compat && target.compat.chatAssistantReasoningField;
    messages = Array.isArray(messages) ? messages : [];
    for (var messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      var message = messages[messageIndex];
      if (!message) continue;
      if (message.role === 'user') {
        output.push({ role: 'user', content: openAiContent(message.content) });
        continue;
      }
      if (message.role === 'tool') {
        var imageContent = [];
        while (messageIndex < messages.length && messages[messageIndex] && messages[messageIndex].role === 'tool') {
          var toolMessage = messages[messageIndex];
          var resultId = mappedIds[toolMessage.toolCallId] || chatCallId(toolMessage.toolCallId);
          output.push({ role: 'tool', tool_call_id: resultId, content: textOnly(toolMessage.content) || '（工具没有返回文本）' });
          var images = imageParts(toolMessage.content, true).filter(function (part) { return !!part.dataUrl; });
          if (images.length) {
            imageContent.push({ type: 'text', text: '来自工具调用 ' + resultId + ' 的可信图片输出：' });
            images.forEach(function (part) {
              imageContent.push({
                type: 'image_url',
                image_url: { url: part.dataUrl, detail: part.detail === 'original' ? 'high' : (part.detail || 'high') },
              });
            });
          }
          messageIndex += 1;
        }
        messageIndex -= 1;
        if (imageContent.length) output.push({ role: 'user', content: imageContent });
        continue;
      }
      if (message.role !== 'assistant') continue;
      var compatible = compatibleReplay(message, target);
      var replayBlocks = compatible ? message.providerReplay.blocks : [];
      var textBlocks = replayBlocks.filter(function (block) { return block.type === 'text'; });
      var portableText = compatible ? contentText(message.content) : portableAssistantText(message);
      var assistant = { role: 'assistant', content: textBlocks.length ? textBlocks.map(function (block) { return block.text; }).join('') : portableText || null };
      if (assistantReasoningField) {
        var replayReasoning = replayBlocks.filter(function (block) {
          return block.type === 'reasoning' && block.field === assistantReasoningField;
        }).map(function (block) { return block.text; }).filter(Boolean).join('\n\n');
        if (replayReasoning) assistant[assistantReasoningField] = replayReasoning;
      }
      var calls = message.calls || [];
      if (calls.length) {
        assistant.tool_calls = calls.map(function (call) {
          var id = uniqueMappedId(chatCallId(call.id), call.id, usedIds, 40);
          mappedIds[call.id] = id;
          return { id: id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
        });
      }
      if (assistant.content !== null || assistant.tool_calls
          || (assistantReasoningField && assistant[assistantReasoningField])) output.push(assistant);
    }
    return output;
  }

  function toResponsesInput(messages, target) {
    var output = [];
    var mappedIds = Object.create(null);
    var usedCallIds = Object.create(null);
    var usedItemIds = Object.create(null);
    var reasoningReplay = target && target.compat && target.compat.responsesReasoningReplay;
    var messageIndex = 0;
    (messages || []).forEach(function (message) {
      if (!message) return;
      if (message.role === 'user') {
        output.push({ role: 'user', content: responsesContent(message.content, 'input_text') });
        return;
      }
      if (message.role === 'tool') {
        var resultIdentity = mappedIds[message.toolCallId] || responsesCallIdentity(message.toolCallId, true);
        var toolImages = imageParts(message.content, true).filter(function (part) { return !!part.dataUrl; });
        var responseOutput = toolImages.length
          ? responsesContent(message.content, 'input_text')
          : textOnly(message.content) || '(no tool output)';
        output.push({ type: 'function_call_output', call_id: resultIdentity.callId, output: responseOutput });
        return;
      }
      if (message.role !== 'assistant') return;
      var compatible = compatibleReplay(message, target);
      var blocks = compatible ? message.providerReplay.blocks : [];
      var textSeen = false;
      var pushedCalls = Object.create(null);
      // reasoning item 必须紧跟其原始后继 item；孤儿 reasoning（尾部无后继）
      // 回放会被 OpenAI 拒绝，先缓存、有后继时才落地。
      var pendingReasoning = [];
      function flushReasoning() {
        pendingReasoning.forEach(function (item) { output.push(item); });
        pendingReasoning = [];
      }
      function pushFunctionCall(call, foreign) {
        var identity = responsesCallIdentity(call.id, foreign);
        identity.callId = uniqueMappedId(identity.callId, call.id, usedCallIds, 64);
        identity.itemId = uniqueMappedId(identity.itemId, call.id, usedItemIds, 64);
        identity.id = identity.callId + '|' + identity.itemId;
        mappedIds[call.id] = identity;
        output.push({ type: 'function_call', id: identity.itemId, call_id: identity.callId, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
      blocks.forEach(function (block) {
        if (block.type === 'reasoning' && block.signature && typeof block.signature === 'object') {
          // 默认 OpenAI store:false 只回放带 encrypted_content 的 reasoning；
          // 兼容层可以显式声明目标支持明文 content 回放。
          if (typeof block.signature.encrypted_content === 'string' && block.signature.encrypted_content) {
            pendingReasoning.push(clone(block.signature));
          } else if (reasoningReplay === 'plaintext' && Array.isArray(block.signature.content)
              && block.signature.content.length) {
            var plaintextReasoning = clone(block.signature);
            delete plaintextReasoning.encrypted_content;
            delete plaintextReasoning.summary;
            pendingReasoning.push(plaintextReasoning);
          }
        } else if (block.type === 'text') {
          flushReasoning();
          textSeen = true;
          var itemId = block.itemId || 'msg_pfa_' + messageIndex + '_' + utilities.shortHash(block.text);
          output.push({
            type: 'message', role: 'assistant', status: 'completed', id: itemId.slice(0, 64),
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
            phase: block.phase,
          });
        } else if (block.type === 'tool_call') {
          flushReasoning();
          pushedCalls[block.id] = true;
          pushFunctionCall(block, !compatible);
        }
      });
      pendingReasoning = [];
      var portableText = compatible ? contentText(message.content) : portableAssistantText(message);
      if (!textSeen && portableText) {
        output.push({ role: 'assistant', content: portableText });
      }
      (message.calls || []).forEach(function (call) {
        if (pushedCalls[call.id]) return;
        pushFunctionCall(call, !compatible);
      });
      messageIndex += 1;
    });
    return output;
  }

  function toAnthropicMessages(messages, target) {
    var output = [];
    var mappedIds = Object.create(null);
    var usedIds = Object.create(null);
    var optionalThinkingSignature = target && target.compat
      && target.compat.anthropicThinkingSignature === 'optional';
    for (var index = 0; index < (messages || []).length; index += 1) {
      var message = messages[index];
      if (!message) continue;
      if (message.role === 'user') {
        var userParts = anthropicContent(message.content);
        if (userParts.length) output.push({
          role: 'user',
          content: userParts.some(function (part) { return part.type === 'image'; })
            ? userParts
            : userParts.map(function (part) { return part.text; }).join('\n'),
        });
        continue;
      }
      if (message.role === 'tool') {
        var toolBlocks = [];
        while (index < messages.length && messages[index] && messages[index].role === 'tool') {
          var toolMessage = messages[index];
          var anthropicToolContent = anthropicContent(toolMessage.content);
          var hasAnthropicImage = anthropicToolContent.some(function (part) { return part.type === 'image'; });
          toolBlocks.push({
            type: 'tool_result',
            tool_use_id: mappedIds[toolMessage.toolCallId] || anthropicCallId(toolMessage.toolCallId),
            content: hasAnthropicImage
              ? anthropicToolContent
              : textOnly(toolMessage.content) || '(no tool output)',
          });
          index += 1;
        }
        index -= 1;
        output.push({ role: 'user', content: toolBlocks });
        continue;
      }
      if (message.role !== 'assistant') continue;
      var compatible = compatibleReplay(message, target);
      var blocks = compatible ? message.providerReplay.blocks : [];
      var anthropicBlocks = [];
      var textSeen = false;
      blocks.forEach(function (block) {
        if (block.type === 'reasoning') {
          if (typeof block.signature === 'string' && (block.signature || optionalThinkingSignature)) {
            if (block.redacted) anthropicBlocks.push({ type: 'redacted_thinking', data: block.signature });
            else {
              var thinkingBlock = { type: 'thinking', thinking: block.text };
              if (block.signature) thinkingBlock.signature = block.signature;
              anthropicBlocks.push(thinkingBlock);
            }
          } else if (block.text && !block.redacted) {
            anthropicBlocks.push({ type: 'text', text: block.text });
          }
        } else if (block.type === 'text' && block.text) {
          textSeen = true;
          anthropicBlocks.push({ type: 'text', text: block.text });
        }
      });
      var portableText = compatible ? contentText(message.content) : portableAssistantText(message);
      if (!textSeen && portableText) anthropicBlocks.push({ type: 'text', text: portableText });
      (message.calls || []).forEach(function (call) {
        var id = uniqueMappedId(anthropicCallId(call.id), call.id, usedIds, 64);
        mappedIds[call.id] = id;
        anthropicBlocks.push({ type: 'tool_use', id: id, name: call.name, input: clone(call.arguments) });
      });
      if (anthropicBlocks.length) output.push({ role: 'assistant', content: anthropicBlocks });
    }
    return output;
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    REPLAY_VERSION: REPLAY_VERSION,
    API_STYLES: STYLES,
    contentText: contentText,
    contentParts: contentParts,
    normalizeContent: normalizeContent,
    imageParts: imageParts,
    hasToolImages: hasToolImages,
    omitToolImages: omitToolImages,
    isImageInputRejection: isImageInputRejection,
    prepareProviderMessages: prepareProviderMessages,
    normalizeCall: normalizeCall,
    normalizeCalls: normalizeCalls,
    sanitizeReplayMetadata: sanitizeReplayMetadata,
    createReplay: createReplay,
    createAssistantHistoryMessage: createAssistantHistoryMessage,
    compatibleReplay: compatibleReplay,
    toOpenAIChat: toOpenAIChat,
    toResponsesInput: toResponsesInput,
    toAnthropicMessages: toAnthropicMessages,
  });
});
