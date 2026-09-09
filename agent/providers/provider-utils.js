// Streaming JSON/error semantics adapted from pi-mono packages/ai (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachBrowserProviderUtilities(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserProviderUtilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var MAX_ERROR_BODY_CHARS = 4000;
  var VALID_JSON_ESCAPES = Object.freeze({
    '"': true, '\\': true, '/': true, b: true, f: true, n: true, r: true, t: true, u: true,
  });
  var RETRYABLE_STATUS = Object.freeze({ 408: true, 409: true, 425: true, 429: true, 500: true, 502: true, 503: true, 504: true, 524: true });
  var NON_RETRYABLE_LIMIT = /insufficient_quota|quota exceeded|out of budget|billing|monthly usage limit|freeusagelimit|gousagelimit/i;
  var RETRYABLE_ERROR = /overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|ended without|stream ended before|you can retry|try your request again|please retry/i;

  function text(value) {
    return String(value === undefined || value === null ? '' : value);
  }

  function safeJsonStringify(value) {
    try {
      var serialized = JSON.stringify(value);
      return serialized === undefined ? String(value) : serialized;
    } catch (_) {
      return String(value);
    }
  }

  function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function sanitizeSurrogates(value) {
    var source = text(value);
    var output = '';
    for (var index = 0; index < source.length; index += 1) {
      var code = source.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        var next = source.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += source.charAt(index) + source.charAt(index + 1);
          index += 1;
        }
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      output += source.charAt(index);
    }
    return output;
  }

  function escapeControlCharacter(character) {
    if (character === '\b') return '\\b';
    if (character === '\f') return '\\f';
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  }

  function repairJson(json) {
    json = text(json);
    var repaired = '';
    var inString = false;
    for (var index = 0; index < json.length; index += 1) {
      var character = json.charAt(index);
      if (!inString) {
        repaired += character;
        if (character === '"') inString = true;
        continue;
      }
      if (character === '"') {
        repaired += character;
        inString = false;
        continue;
      }
      if (character === '\\') {
        var next = json.charAt(index + 1);
        if (!next) {
          repaired += '\\\\';
          continue;
        }
        if (next === 'u') {
          var digits = json.slice(index + 2, index + 6);
          if (/^[0-9a-fA-F]{4}$/.test(digits)) {
            repaired += '\\u' + digits;
            index += 5;
            continue;
          }
        }
        if (VALID_JSON_ESCAPES[next]) {
          repaired += '\\' + next;
          index += 1;
          continue;
        }
        repaired += '\\\\';
        continue;
      }
      var code = character.charCodeAt(0);
      repaired += code >= 0 && code <= 0x1f ? escapeControlCharacter(character) : character;
    }
    return repaired;
  }

  function parseJsonWithRepair(json) {
    try { return JSON.parse(text(json)); }
    catch (originalError) {
      var repaired = repairJson(json);
      if (repaired !== text(json)) return JSON.parse(repaired);
      throw originalError;
    }
  }

  function completePartialJson(value) {
    var source = repairJson(value).trim();
    if (!source) return '{}';
    var stack = [];
    var inString = false;
    var escaped = false;
    for (var index = 0; index < source.length; index += 1) {
      var character = source.charAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') stack.push('}');
      else if (character === '[') stack.push(']');
      else if ((character === '}' || character === ']') && stack[stack.length - 1] === character) stack.pop();
    }
    if (escaped) source += '\\';
    if (inString) source += '"';
    source = source.replace(/,\s*$/, '').replace(/:\s*$/, ':null');
    while (stack.length) source += stack.pop();
    return source;
  }

  function parseStreamingJson(value) {
    if (!text(value).trim()) return {};
    try { return parseJsonWithRepair(value); }
    catch (_) {
      try { return parseJsonWithRepair(completePartialJson(value)); }
      catch (_) { return {}; }
    }
  }

  function parseFinalArguments(value) {
    // 模型输出的参数 JSON 可能损坏或修复后不是对象。这里兜底为空对象而不是抛错：
    // 抛错会击穿 Provider 层杀死整个 generation；空参数会被资源 schema 校验拒绝，
    // 错误作为工具结果反馈给模型，由它在下一轮修正。
    var parsed;
    try { parsed = parseJsonWithRepair(text(value || '{}')); }
    catch (_) { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  }

  function shortHash(value) {
    value = text(value);
    var h1 = 0xdeadbeef;
    var h2 = 0x41c6ce57;
    for (var index = 0; index < value.length; index += 1) {
      var code = value.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }

  function truncate(value, limit) {
    var source = text(value);
    var max = Math.max(1, Number(limit) || MAX_ERROR_BODY_CHARS);
    if (source.length <= max) return source;
    return source.slice(0, max) + '... [truncated ' + (source.length - max) + ' chars]';
  }

  function omitInlineImageData(value) {
    return text(value).replace(/data:image\/[^,;\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/_=-]+/gi, '[image data omitted]');
  }

  function errorMessageFromBody(body) {
    if (!body || typeof body !== 'object') return '';
    if (body.error && typeof body.error === 'object' && body.error.message !== undefined) return text(body.error.message).trim();
    if (body.error !== undefined && body.error !== null) return typeof body.error === 'string' ? body.error.trim() : safeJsonStringify(body.error);
    if (body.message !== undefined && body.message !== null) return text(body.message).trim();
    return '';
  }

  function ProviderHttpError(status, statusText, bodyText, body) {
    this.name = 'ProviderHttpError';
    this.status = Number(status) || 0;
    this.statusText = text(statusText);
    this.body = body;
    this.bodyText = omitInlineImageData(truncate(bodyText || '', MAX_ERROR_BODY_CHARS));
    var detail = omitInlineImageData(errorMessageFromBody(body) || this.bodyText || this.statusText);
    this.message = 'Provider request failed (HTTP ' + this.status + ')' + (detail ? ': ' + detail : '');
    this.retryable = isRetryableStatus(this.status) && !NON_RETRYABLE_LIMIT.test(detail);
    if (Error.captureStackTrace) Error.captureStackTrace(this, ProviderHttpError);
  }
  ProviderHttpError.prototype = Object.create(Error.prototype);
  ProviderHttpError.prototype.constructor = ProviderHttpError;

  function isRetryableStatus(status) {
    return !!RETRYABLE_STATUS[Number(status) || 0];
  }

  function isRetryableError(error) {
    if (!error) return false;
    if (error.name === 'AbortError') return false;
    if (error.retryable === true) return true;
    var message = text(error.message || error);
    if (NON_RETRYABLE_LIMIT.test(message)) return false;
    return RETRYABLE_ERROR.test(message);
  }

  function retryAfterMs(headers, now) {
    if (!headers || typeof headers.get !== 'function') return undefined;
    var milliseconds = Number(headers.get('retry-after-ms'));
    if (isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
    var value = headers.get('retry-after');
    if (!value) return undefined;
    var seconds = Number(value);
    if (isFinite(seconds) && seconds >= 0) return seconds * 1000;
    var date = Date.parse(value);
    return isFinite(date) ? Math.max(0, date - (Number(now) || Date.now())) : undefined;
  }

  function retryDelayMs(attempt, headers, maxDelayMs) {
    var requested = retryAfterMs(headers);
    var exponential = Math.min(1000 * Math.pow(2, Math.max(0, Number(attempt) || 0)), 30000);
    var delay = requested === undefined ? exponential : requested;
    var cap = maxDelayMs === 0 ? 0 : Math.max(1, Number(maxDelayMs) || 60000);
    if (cap && delay > cap) {
      var error = new Error('Provider requested retry delay ' + delay + 'ms, above configured maximum ' + cap + 'ms');
      error.retryable = true;
      throw error;
    }
    return delay;
  }

  function normalizeError(error, signal) {
    if (signal && signal.aborted) {
      var reason = signal.reason;
      var aborted = reason instanceof Error ? reason : new Error(reason ? text(reason) : 'Provider request aborted');
      if (aborted.name !== 'TimeoutError') aborted.name = 'AbortError';
      return aborted;
    }
    if (error instanceof Error) return error;
    return new Error(safeJsonStringify(error));
  }

  function emptyUsage() {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    MAX_ERROR_BODY_CHARS: MAX_ERROR_BODY_CHARS,
    ProviderHttpError: ProviderHttpError,
    text: text,
    cloneJson: cloneJson,
    safeJsonStringify: safeJsonStringify,
    sanitizeSurrogates: sanitizeSurrogates,
    repairJson: repairJson,
    parseJsonWithRepair: parseJsonWithRepair,
    parseStreamingJson: parseStreamingJson,
    parseFinalArguments: parseFinalArguments,
    shortHash: shortHash,
    truncate: truncate,
    errorMessageFromBody: errorMessageFromBody,
    isRetryableStatus: isRetryableStatus,
    isRetryableError: isRetryableError,
    retryAfterMs: retryAfterMs,
    retryDelayMs: retryDelayMs,
    normalizeError: normalizeError,
    emptyUsage: emptyUsage,
  });
});
