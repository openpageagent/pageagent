// Network Capture Hook — 注入到页面 MAIN world，捕获 fetch/XHR/SSE 响应
// 通过 chrome.scripting.registerContentScripts({ world: 'MAIN', runAt: 'document_start' }) 注册
// 与 isolated world 的统一页面网络事实 provider 通过 CustomEvent('__pfa_net_req'/'__pfa_net_res') 桥接
(function () {
  'use strict';

  if (window.__pfaNetCaptureInstalled) return;
  window.__pfaNetCaptureInstalled = true;

  var MAX_ENTRIES = 300;
  var MAX_BODY_LENGTH = 64 * 1024;
  var MAX_REQUEST_BODY_LENGTH = 16 * 1024;
  var MAX_TOTAL_BODY_LENGTH = 6 * 1024 * 1024;
  var DEFAULT_ENTRY_AGE_MS = 60 * 60 * 1000;
  var MIN_ENTRY_AGE_MS = 5 * 60 * 1000;
  var MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;
  var entries = [];

  function headersToObject(headers) {
    var out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === 'function') {
        headers.forEach(function (value, key) { out[key] = value; });
      } else if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) {
          if (headers[i] && headers[i].length >= 2) out[String(headers[i][0])] = String(headers[i][1]);
        }
      } else if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (k) { out[k] = String(headers[k]); });
      }
    } catch (_) {}
    return out;
  }

  function safeRequestBody(body) {
    try {
      if (body === undefined || body === null) return '';
      if (typeof body === 'string') return body.slice(0, MAX_REQUEST_BODY_LENGTH);
      if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_REQUEST_BODY_LENGTH);
      if (body instanceof FormData) {
        var obj = {};
        body.forEach(function (v, k) {
          obj[k] = (v && v.name) ? '[File ' + v.name + ']' : String(v);
        });
        return JSON.stringify(obj).slice(0, MAX_REQUEST_BODY_LENGTH);
      }
      if (body instanceof Blob) return '[Blob ' + body.type + ', ' + body.size + ' bytes]';
      if (body instanceof ArrayBuffer) return '[ArrayBuffer ' + body.byteLength + ' bytes]';
      return String(body).slice(0, MAX_REQUEST_BODY_LENGTH);
    } catch (e) {
      return '[不可读取请求体: ' + e.message + ']';
    }
  }

  function entryTextSize(entry) {
    if (!entry) return 0;
    return String(entry.bodyText || '').length + String(entry.requestBody || '').length;
  }

  function totalEntryTextSize() {
    var total = 0;
    for (var i = 0; i < entries.length; i++) total += entryTextSize(entries[i]);
    return total;
  }

  function normalizeRetentionMs(value) {
    var ms = Number(value);
    if (!isFinite(ms) || ms <= 0) ms = DEFAULT_ENTRY_AGE_MS;
    return Math.max(MIN_ENTRY_AGE_MS, Math.min(MAX_ENTRY_AGE_MS, Math.floor(ms)));
  }

  function trimEntries(retentionMs) {
    var cutoff = Date.now() - normalizeRetentionMs(retentionMs);
    if (entries.length) {
      entries = entries.filter(function (entry) {
        return !entry.ts || entry.ts >= cutoff;
      });
    }
    while (entries.length > MAX_ENTRIES) entries.shift();
    var total = totalEntryTextSize();
    while (entries.length && total > MAX_TOTAL_BODY_LENGTH) {
      total -= entryTextSize(entries.shift());
    }
  }

  function record(url, method, status, bodyText, extra) {
    try {
      var entry = Object.assign({
        id: 'req_' + Date.now() + '_' + Math.random().toString(16).slice(2),
        url: String(url || ''),
        method: String(method || 'GET').toUpperCase(),
        status: status,
        bodyText: String(bodyText || '').slice(0, MAX_BODY_LENGTH),
        ts: Date.now(),
      }, extra || {});
      if (!entry.resourceType) entry.resourceType = 'unknown';
      if (!entry.type) entry.type = entry.resourceType;
      entries.push(entry);
      trimEntries();
    } catch (_) {}
  }

  function absoluteUrl(url) {
    try { return new URL(String(url || ''), location.href).href; }
    catch (_) { return String(url || ''); }
  }

  function parseSseBlock(block) {
    var lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
    var eventName = 'message';
    var eventId = '';
    var data = [];
    var retry = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ':') continue;
      var idx = line.indexOf(':');
      var field = idx === -1 ? line : line.slice(0, idx);
      var value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'event') eventName = value || 'message';
      else if (field === 'id') eventId = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry') retry = value;
    }
    if (!data.length && !eventId && !retry) return null;
    return {
      eventName: eventName,
      eventId: eventId,
      retry: retry,
      data: data.join('\n'),
    };
  }

  function createStreamId() {
    return 'stream_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  }

  function recordSseText(url, method, status, text, meta) {
    var normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var blocks = normalized.split(/\n\n+/);
    meta = meta || {};
    var count = Number(meta.streamSeqStart) || 0;
    for (var i = 0; i < blocks.length; i++) {
      if (!blocks[i].trim()) continue;
      var parsed = parseSseBlock(blocks[i]);
      if (!parsed) continue;
      count += 1;
      record(url, method, status, parsed.data, Object.assign({}, meta, {
        resourceType: 'sse',
        phase: 'message',
        eventName: parsed.eventName,
        eventId: parsed.eventId,
        retry: parsed.retry,
        streamSeq: count,
      }));
    }
    return count - (Number(meta.streamSeqStart) || 0);
  }

  function readFetchSseStream(response, url, method, contentType, streamMeta) {
    try {
      if (!response.body || typeof response.body.getReader !== 'function') return false;
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var seq = 0;
      streamMeta = streamMeta || {};

      function pump() {
        reader.read().then(function (chunk) {
          if (chunk.done) {
            if (buffer.trim()) {
              var tail = parseSseBlock(buffer);
              if (tail) {
                seq += 1;
                record(url, method, response.status, tail.data, {
                  streamId: streamMeta.streamId,
                  streamSeq: seq,
                  resourceType: 'sse',
                  phase: 'message',
                  eventName: tail.eventName,
                  eventId: tail.eventId,
                  retry: tail.retry,
                  contentType: contentType,
                });
              }
            }
            record(url, method, response.status, '', {
              streamId: streamMeta.streamId,
              streamSeq: seq + 1,
              resourceType: 'sse',
              phase: 'close',
              eventName: 'close',
              contentType: contentType,
            });
            return;
          }

          buffer += decoder.decode(chunk.value, { stream: true });
          var parts = buffer.split(/\n\n|\r\n\r\n|\r\r/);
          buffer = parts.pop() || '';
          for (var i = 0; i < parts.length; i++) {
            var parsed = parseSseBlock(parts[i]);
            if (!parsed) continue;
            seq += 1;
            record(url, method, response.status, parsed.data, {
              streamId: streamMeta.streamId,
              streamSeq: seq,
              resourceType: 'sse',
              phase: 'message',
              eventName: parsed.eventName,
              eventId: parsed.eventId,
              retry: parsed.retry,
              contentType: contentType,
              durationMs: Number(streamMeta.durationMs) || 0,
            });
          }
          pump();
        }).catch(function () {});
      }

      pump();
      return true;
    } catch (_) {
      return false;
    }
  }

  // --- fetch 包装 ---

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var url = absoluteUrl((typeof input === 'string') ? input : (input && input.url) || '');
      var method = (init && init.method) || (input && input.method) || 'GET';
      var requestHeaders = headersToObject((init && init.headers) || (input && input.headers));
      var requestBody = safeRequestBody(init && init.body);
      var requestStartedAt = Date.now();
      return originalFetch.apply(this, arguments).then(function (response) {
        try {
          var clone = response.clone();
          var durationMs = Math.max(0, Date.now() - requestStartedAt);
          var contentType = '';
          try { contentType = response.headers && response.headers.get('content-type') || ''; } catch (_) {}
          var finalUrl = response.url || url;
          if (/text\/event-stream/i.test(contentType)) {
            var streamId = createStreamId();
            record(finalUrl, method, response.status, '', {
              streamId: streamId,
              streamSeq: 0,
              resourceType: 'sse',
              phase: 'open',
              eventName: 'open',
              contentType: contentType,
              requestHeaders: requestHeaders,
              requestBody: requestBody,
              durationMs: durationMs,
            });
            if (!readFetchSseStream(clone, finalUrl, method, contentType, { streamId: streamId, durationMs: durationMs })) {
              clone.text().then(function (text) {
                var count = recordSseText(finalUrl, method, response.status, text, {
                  streamId: streamId,
                  resourceType: 'sse',
                  contentType: contentType,
                  requestHeaders: requestHeaders,
                  requestBody: requestBody,
                  durationMs: durationMs,
                });
                if (!count) {
                  record(finalUrl, method, response.status, text, {
                    streamId: streamId,
                    streamSeq: 1,
                    resourceType: 'sse',
                    phase: 'message',
                    eventName: 'message',
                    contentType: contentType,
                    requestHeaders: requestHeaders,
                    requestBody: requestBody,
                    durationMs: durationMs,
                  });
                }
                record(finalUrl, method, response.status, '', {
                  streamId: streamId,
                  streamSeq: count ? count + 1 : 2,
                  resourceType: 'sse',
                  phase: 'close',
                  eventName: 'close',
                  contentType: contentType,
                  requestHeaders: requestHeaders,
                  requestBody: requestBody,
                  durationMs: durationMs,
                });
              }).catch(function () {});
            }
          } else {
            clone.text().then(function (text) {
              record(finalUrl, method, response.status, text, {
                resourceType: 'fetch',
                contentType: contentType,
                requestHeaders: requestHeaders,
                requestBody: requestBody,
                durationMs: durationMs,
              });
            }).catch(function () {});
          }
        } catch (_) {}
        return response;
      });
    };
  }

  // --- XMLHttpRequest 包装 ---

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pfaMethod = method;
    this.__pfaUrl = absoluteUrl(url);
    this.__pfaRequestHeaders = {};
    return originalOpen.apply(this, arguments);
  };

  var originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (!this.__pfaRequestHeaders) this.__pfaRequestHeaders = {};
      this.__pfaRequestHeaders[String(name)] = String(value);
    } catch (_) {}
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var requestBody = safeRequestBody(arguments[0]);
    var requestStartedAt = Date.now();
    xhr.addEventListener('load', function () {
      try {
        var body = '';
        var durationMs = Math.max(0, Date.now() - requestStartedAt);
        var contentType = xhr.getResponseHeader && xhr.getResponseHeader('content-type') || '';
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          body = xhr.responseText;
        } else if (xhr.responseType === 'json') {
          try { body = JSON.stringify(xhr.response); } catch (_) {}
        }
        if (/text\/event-stream/i.test(contentType)) {
          var streamId = createStreamId();
          record(xhr.responseURL || xhr.__pfaUrl, xhr.__pfaMethod, xhr.status, '', {
            streamId: streamId,
            streamSeq: 0,
            resourceType: 'sse',
            phase: 'open',
            eventName: 'open',
            contentType: contentType,
            requestHeaders: xhr.__pfaRequestHeaders || {},
            requestBody: requestBody,
            durationMs: durationMs,
          });
          var messageCount = recordSseText(xhr.responseURL || xhr.__pfaUrl, xhr.__pfaMethod, xhr.status, body, {
            streamId: streamId,
            contentType: contentType,
            requestHeaders: xhr.__pfaRequestHeaders || {},
            requestBody: requestBody,
            durationMs: durationMs,
          });
          record(xhr.responseURL || xhr.__pfaUrl, xhr.__pfaMethod, xhr.status, '', {
            streamId: streamId,
            streamSeq: messageCount + 1,
            resourceType: 'sse',
            phase: 'close',
            eventName: 'close',
            contentType: contentType,
            requestHeaders: xhr.__pfaRequestHeaders || {},
            requestBody: requestBody,
            durationMs: durationMs,
          });
        }
        record(xhr.responseURL || xhr.__pfaUrl, xhr.__pfaMethod, xhr.status, body, {
          resourceType: 'xhr',
          contentType: contentType,
          requestHeaders: xhr.__pfaRequestHeaders || {},
          requestBody: requestBody,
          durationMs: durationMs,
        });
      } catch (_) {}
    });
    return originalSend.apply(this, arguments);
  };

  // --- EventSource 包装 ---

  var OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    window.EventSource = function (url, eventSourceInitDict) {
      var finalUrl = absoluteUrl(url);
      var es = new OriginalEventSource(url, eventSourceInitDict);
      var tracked = {};
      var streamId = createStreamId();
      var seq = 0;

      function recordSseEvent(phase, eventName, event) {
        var data = event && event.data !== undefined ? event.data : '';
        seq += 1;
        record(finalUrl, 'GET', phase === 'message' ? 200 : 0, data, {
          streamId: streamId,
          streamSeq: seq,
          resourceType: 'sse',
          phase: phase,
          eventName: eventName || (event && event.type) || phase,
          eventId: event && event.lastEventId || '',
          readyState: es.readyState,
          withCredentials: !!(eventSourceInitDict && eventSourceInitDict.withCredentials),
        });
      }

      function trackEventType(type) {
        type = String(type || '');
        if (!type || tracked[type]) return;
        tracked[type] = true;
        OriginalEventSource.prototype.addEventListener.call(es, type, function (event) {
          if (type === 'open') recordSseEvent('open', 'open', event);
          else if (type === 'error') recordSseEvent('error', 'error', event);
          else recordSseEvent('message', type, event);
        });
      }

      record(finalUrl, 'GET', 0, '', {
        streamId: streamId,
        streamSeq: 0,
        resourceType: 'sse',
        phase: 'request',
        eventName: 'request',
        readyState: es.readyState,
        withCredentials: !!(eventSourceInitDict && eventSourceInitDict.withCredentials),
      });

      trackEventType('open');
      trackEventType('message');
      trackEventType('error');

      var originalAddEventListener = es.addEventListener;
      es.addEventListener = function (type) {
        trackEventType(type);
        return originalAddEventListener.apply(es, arguments);
      };

      return es;
    };

    try {
      window.EventSource.prototype = OriginalEventSource.prototype;
      window.EventSource.CONNECTING = OriginalEventSource.CONNECTING;
      window.EventSource.OPEN = OriginalEventSource.OPEN;
      window.EventSource.CLOSED = OriginalEventSource.CLOSED;
    } catch (_) {}
  }

  // --- 查询桥（isolated world 经 CustomEvent 查询） ---

  document.addEventListener('__pfa_net_req', function (event) {
    var detail;
    try { detail = JSON.parse(event.detail || '{}'); } catch (_) { detail = {}; }
    if (detail.action === 'clear') {
      var before = entries.length;
      entries = [];
      document.dispatchEvent(new CustomEvent('__pfa_net_res', {
        detail: JSON.stringify({ reqId: detail.reqId, cleared: before }),
      }));
      return;
    }
    var filter = detail.filter || {};
    trimEntries(filter.retentionMs);
    var matched = entries.filter(function (e) {
      if (filter.entryId && e.id !== filter.entryId) return false;
      if (filter.urlFilter && e.url.indexOf(filter.urlFilter) === -1) return false;
      if (filter.method && e.method !== String(filter.method).toUpperCase()) return false;
      if (filter.resourceType && filter.resourceType !== 'all' && e.resourceType !== filter.resourceType) return false;
      if (filter.phase && filter.phase !== 'all' && e.phase !== filter.phase) return false;
      if (filter.eventName && e.eventName !== filter.eventName) return false;
      if (filter.streamId && e.streamId !== filter.streamId) return false;
      return true;
    });
    var limit = Number(filter.limit);
    if (!isFinite(limit) || limit <= 0) limit = 100;
    limit = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit)));
    matched = filter.latestOnly === false ? matched.slice(-limit) : matched.slice(-1);
    document.dispatchEvent(new CustomEvent('__pfa_net_res', {
      detail: JSON.stringify({ reqId: detail.reqId, entries: matched }),
    }));
  });

  document.addEventListener('__pfa_net_replay_req', function (event) {
    var detail;
    try { detail = JSON.parse(event.detail || '{}'); } catch (_) { detail = {}; }
    var opts = detail.options || {};
    var entry = null;
    if (detail.entryId) {
      for (var i = entries.length - 1; i >= 0; i--) {
        if (entries[i].id === detail.entryId) { entry = entries[i]; break; }
      }
    }
    if (!entry && opts.url) {
      entry = {
        url: absoluteUrl(opts.url),
        method: opts.method || 'GET',
        requestHeaders: opts.headers || {},
        requestBody: opts.body || '',
      };
    }
    if (!entry) {
      document.dispatchEvent(new CustomEvent('__pfa_net_replay_res', {
        detail: JSON.stringify({ reqId: detail.reqId, error: '未找到可重放请求' }),
      }));
      return;
    }
    var init = {
      method: opts.method || entry.method || 'GET',
      headers: opts.headers || entry.requestHeaders || {},
      credentials: opts.credentials || 'include',
    };
    var body = opts.body !== undefined ? opts.body : entry.requestBody;
    if (!/^(GET|HEAD)$/i.test(init.method) && body) init.body = body;
    originalFetch(entry.url, init).then(function (response) {
      var contentType = response.headers && response.headers.get('content-type') || '';
      return response.text().then(function (text) {
        record(response.url || entry.url, init.method, response.status, text, {
          resourceType: 'replay',
          contentType: contentType,
          requestHeaders: init.headers,
          requestBody: body || '',
          replayOf: entry.id || '',
        });
        document.dispatchEvent(new CustomEvent('__pfa_net_replay_res', {
          detail: JSON.stringify({
            reqId: detail.reqId,
            result: {
              url: response.url || entry.url,
              status: response.status,
              ok: response.ok,
              contentType: contentType,
              bodyText: text,
            },
          }),
        }));
      });
    }).catch(function (err) {
      document.dispatchEvent(new CustomEvent('__pfa_net_replay_res', {
        detail: JSON.stringify({ reqId: detail.reqId, error: err && err.message || String(err) }),
      }));
    });
  });
})();
