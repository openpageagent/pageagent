// SSE decoding semantics adapted from pi-mono Anthropic Messages transport (MIT; see PI_UPSTREAM_NOTICE.md).
(function attachBrowserProviderSSE(root, factory) {
  'use strict';
  var utilities = typeof module === 'object' && module.exports
    ? require('./provider-utils')
    : root.BrowserProviderUtilities;
  var api = factory(utilities);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserProviderSSE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utilities) {
  'use strict';

  var API_VERSION = 1;
  var MAX_EVENT_CHARS = 4 * 1024 * 1024;

  function flush(state) {
    if (!state.event && !state.data.length) return null;
    var event = {
      event: state.event || '',
      data: state.data.join('\n'),
      id: state.id || '',
      retry: state.retry,
      raw: state.raw.slice(),
    };
    state.event = '';
    state.data = [];
    state.id = '';
    state.retry = undefined;
    state.raw = [];
    state.chars = 0;
    return event;
  }

  function decodeLine(line, state) {
    if (line === '') return flush(state);
    state.chars += line.length;
    if (state.chars > MAX_EVENT_CHARS) throw new Error('Provider SSE event exceeds maximum size');
    state.raw.push(line);
    if (line.charAt(0) === ':') return null;
    var delimiter = line.indexOf(':');
    var field = delimiter === -1 ? line : line.slice(0, delimiter);
    var value = delimiter === -1 ? '' : line.slice(delimiter + 1);
    if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'event') state.event = value;
    else if (field === 'data') state.data.push(value);
    else if (field === 'id' && value.indexOf('\u0000') === -1) state.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) state.retry = Number(value);
    return null;
  }

  function consumeLine(buffer) {
    var carriage = buffer.indexOf('\r');
    var newline = buffer.indexOf('\n');
    var index = carriage === -1 ? newline : (newline === -1 ? carriage : Math.min(carriage, newline));
    if (index === -1) return null;
    var next = index + 1;
    if (buffer.charAt(index) === '\r' && buffer.charAt(next) === '\n') next += 1;
    return { line: buffer.slice(0, index), rest: buffer.slice(next) };
  }

  async function* iterate(body, signal) {
    if (!body || typeof body.getReader !== 'function') throw new Error('Provider response has no readable SSE body');
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var state = { event: '', data: [], id: '', retry: undefined, raw: [], chars: 0 };
    var buffer = '';
    var first = true;
    try {
      while (true) {
        if (signal && signal.aborted) throw utilities.normalizeError(null, signal);
        var item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        if (first) {
          first = false;
          if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
        }
        var consumed = consumeLine(buffer);
        while (consumed) {
          buffer = consumed.rest;
          var event = decodeLine(consumed.line, state);
          if (event) yield event;
          consumed = consumeLine(buffer);
        }
      }
      buffer += decoder.decode();
      var trailing = consumeLine(buffer);
      while (trailing) {
        buffer = trailing.rest;
        var lineEvent = decodeLine(trailing.line, state);
        if (lineEvent) yield lineEvent;
        trailing = consumeLine(buffer);
      }
      if (buffer) {
        var bufferEvent = decodeLine(buffer, state);
        if (bufferEvent) yield bufferEvent;
      }
      var finalEvent = flush(state);
      if (finalEvent) yield finalEvent;
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  function parseJson(event) {
    try { return utilities.parseJsonWithRepair(event && event.data || ''); }
    catch (error) {
      throw new Error('Could not parse provider SSE event ' + String(event && event.event || 'message')
        + ': ' + error.message + '; data=' + utilities.truncate(event && event.data || '', 2000));
    }
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    iterate: iterate,
    parseJson: parseJson,
  });
});
