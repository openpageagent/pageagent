// Read original response bytes that are still resident in the inspected page's Blink resource cache.
(function attachPageResourceCache(root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageResourceCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;
  var DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  var MAX_REQUESTS = 1000;

  function CacheReadError(code, message, details) {
    this.name = 'CacheReadError';
    this.code = String(code || 'PAGE_RESOURCE_CACHE_UNAVAILABLE');
    this.message = String(message || this.code);
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, CacheReadError);
  }
  CacheReadError.prototype = Object.create(Error.prototype);
  CacheReadError.prototype.constructor = CacheReadError;

  function compactError(error) {
    return String(error && error.message || error || 'Unknown cache read error').slice(0, 500);
  }

  function positiveInteger(value, fallback, maximum) {
    var number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number <= 0) number = fallback;
    if (maximum) number = Math.min(number, maximum);
    return number;
  }

  function normalizedHttpUrl(value) {
    try {
      var parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      parsed.hash = '';
      return parsed.href;
    } catch (_) { return ''; }
  }

  function safeMimeType(value, url) {
    var mime = String(value || '').toLowerCase().split(';')[0].trim();
    if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return mime;
    var path = '';
    try { path = new URL(String(url || '')).pathname.toLowerCase(); } catch (_) {}
    if (/\.avif$/.test(path)) return 'image/avif';
    if (/\.gif$/.test(path)) return 'image/gif';
    if (/\.jpe?g$/.test(path)) return 'image/jpeg';
    if (/\.png$/.test(path)) return 'image/png';
    if (/\.svgz?$/.test(path)) return 'image/svg+xml';
    if (/\.webp$/.test(path)) return 'image/webp';
    if (/\.m3u8$/.test(path)) return 'application/vnd.apple.mpegurl';
    if (/\.mpd$/.test(path)) return 'application/dash+xml';
    if (/\.mp4$|\.m4v$/.test(path)) return 'video/mp4';
    if (/\.webm$/.test(path)) return 'video/webm';
    if (/\.mp3$/.test(path)) return 'audio/mpeg';
    if (/\.m4a$/.test(path)) return 'audio/mp4';
    if (/\.ogg$|\.oga$/.test(path)) return 'audio/ogg';
    return 'application/octet-stream';
  }

  function estimateBase64Bytes(value) {
    var clean = String(value || '').replace(/\s+/g, '');
    if (!clean) return 0;
    var padding = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
  }

  function flattenResourceTree(frameTree) {
    var output = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      var frame = node.frame || {};
      var frameId = String(frame.id || '');
      (Array.isArray(node.resources) ? node.resources : []).forEach(function (resource) {
        var normalized = normalizedHttpUrl(resource && resource.url);
        if (!normalized) return;
        output.push({
          url: String(resource.url || ''),
          normalizedUrl: normalized,
          frameId: frameId,
          mimeType: safeMimeType(resource.mimeType, resource.url),
          resourceType: String(resource.type || ''),
          contentSize: Math.max(0, Number(resource.contentSize) || 0),
          failed: resource.failed === true,
          canceled: resource.canceled === true,
        });
      });
      (Array.isArray(node.childFrames) ? node.childFrames : []).forEach(visit);
    }
    visit(frameTree);
    return output;
  }

  function createReader(options) {
    options = options || {};
    var cdpSessionManager = options.cdpSessionManager;
    if (!cdpSessionManager || typeof cdpSessionManager.withLease !== 'function') {
      throw new Error('PageResourceCache requires CdpSessionManager');
    }
    var btoaImpl = options.btoa || root && root.btoa;
    var TextEncoderImpl = options.TextEncoder || root && root.TextEncoder;
    if (typeof btoaImpl !== 'function' || typeof TextEncoderImpl !== 'function') {
      throw new Error('PageResourceCache requires btoa and TextEncoder');
    }
    var defaultMaxAssetBytes = positiveInteger(options.maxAssetBytes, DEFAULT_MAX_ASSET_BYTES);
    var defaultMaxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);

    function bytesToBase64(bytes) {
      var binary = '';
      var chunkSize = 0x8000;
      for (var index = 0; index < bytes.length; index += chunkSize) {
        var chunk = bytes.subarray(index, index + chunkSize);
        for (var offset = 0; offset < chunk.length; offset += 1) binary += String.fromCharCode(chunk[offset]);
      }
      return btoaImpl(binary);
    }

    function textBase64(value) {
      return bytesToBase64(new TextEncoderImpl().encode(String(value || '')));
    }

    function normalizeRequests(requests, readOptions) {
      requests = Array.isArray(requests) ? requests : [];
      if (requests.length > MAX_REQUESTS) {
        throw new CacheReadError('PAGE_RESOURCE_CACHE_LIMIT', 'Too many page resource cache requests', {
          requested: requests.length, maxRequests: MAX_REQUESTS,
        });
      }
      var fallbackMax = positiveInteger(readOptions.maxAssetBytes, defaultMaxAssetBytes);
      return requests.map(function (request, index) {
        request = typeof request === 'string' ? { url: request } : (request || {});
        var url = String(request.url || '');
        return {
          index: index,
          url: url,
          normalizedUrl: normalizedHttpUrl(url),
          maxBytes: positiveInteger(request.maxBytes, fallbackMax),
        };
      });
    }

    function missResult(request, reason, error) {
      var result = {
        index: request.index,
        url: request.url,
        status: 'miss',
        acquisitionSource: '',
        reason: String(reason || 'not-in-resource-tree'),
      };
      if (error) result.error = compactError(error);
      return result;
    }

    function tooLargeResult(request, reason, details) {
      return {
        index: request.index,
        url: request.url,
        status: 'too-large',
        acquisitionSource: '',
        reason: String(reason || 'asset-limit'),
        byteLength: Math.max(0, Number(details && details.byteLength) || 0),
        maxBytes: Math.max(0, Number(details && details.maxBytes) || request.maxBytes),
      };
    }

    function readMany(tabId, requests, readOptions) {
      tabId = Number(tabId);
      readOptions = readOptions || {};
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return Promise.reject(new CacheReadError('PAGE_CONTEXT_REQUIRED', 'Page resource cache requires a valid tabId'));
      }
      var normalizedRequests;
      try { normalizedRequests = normalizeRequests(requests, readOptions); }
      catch (error) { return Promise.reject(error); }
      var maxTotalBytes = positiveInteger(readOptions.maxTotalBytes, defaultMaxTotalBytes);
      var timeoutMs = positiveInteger(readOptions.timeoutMs, 30000, 120000);
      if (!normalizedRequests.length) {
        return Promise.resolve({ requestedCount: 0, hitCount: 0, missCount: 0, tooLargeCount: 0, byteLength: 0, results: [] });
      }

      return cdpSessionManager.withLease(tabId, { owner: 'PageResourceCache', type: 'short' }, async function (send) {
          var treeResponse = await send('Page.getResourceTree', {}, Math.min(timeoutMs, 15000));
          var resources = flattenResourceTree(treeResponse && treeResponse.frameTree);
          var byUrl = new Map();
          resources.forEach(function (resource) {
            var list = byUrl.get(resource.normalizedUrl) || [];
            list.push(resource);
            byUrl.set(resource.normalizedUrl, list);
          });

          var results = [];
          var totalBytes = 0;
          for (var requestIndex = 0; requestIndex < normalizedRequests.length; requestIndex += 1) {
            var request = normalizedRequests[requestIndex];
            if (!request.normalizedUrl) {
              results.push(missResult(request, 'unsupported-url'));
              continue;
            }
            var candidates = (byUrl.get(request.normalizedUrl) || []).filter(function (resource) {
              return !resource.failed && !resource.canceled && !!resource.frameId;
            });
            if (!candidates.length) {
              results.push(missResult(request, 'not-in-resource-tree'));
              continue;
            }
            var preflightCandidate = candidates.find(function (resource) {
              return !resource.contentSize || resource.contentSize <= request.maxBytes;
            });
            if (!preflightCandidate) {
              results.push(tooLargeResult(request, 'resource-content-size', {
                byteLength: Math.min.apply(Math, candidates.map(function (resource) { return resource.contentSize; })),
                maxBytes: request.maxBytes,
              }));
              continue;
            }

            var successful = null;
            for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
              var candidate = candidates[candidateIndex];
              if (candidate.contentSize > request.maxBytes) continue;
              try {
                var response = await send('Page.getResourceContent', {
                  frameId: candidate.frameId,
                  url: candidate.url,
                }, timeoutMs);
                var base64 = response && response.base64Encoded
                  ? String(response.content || '').replace(/\s+/g, '')
                  : textBase64(response && response.content || '');
                var byteLength = estimateBase64Bytes(base64);
                if (byteLength > request.maxBytes) {
                  successful = tooLargeResult(request, 'decoded-asset-size', {
                    byteLength: byteLength, maxBytes: request.maxBytes,
                  });
                  break;
                }
                if (totalBytes + byteLength > maxTotalBytes) {
                  successful = tooLargeResult(request, 'batch-total-size', {
                    byteLength: byteLength, maxBytes: Math.max(0, maxTotalBytes - totalBytes),
                  });
                  break;
                }
                var mimeType = safeMimeType(candidate.mimeType, candidate.url);
                successful = {
                  index: request.index,
                  url: request.url,
                  status: 'hit',
                  acquisitionSource: 'page-resource-cache',
                  mimeType: mimeType,
                  byteLength: byteLength,
                  resourceType: candidate.resourceType,
                  frameId: candidate.frameId,
                  dataUrl: 'data:' + mimeType + ';base64,' + base64,
                };
                totalBytes += byteLength;
                break;
              } catch (error) { throw error; }
            }
            if (successful) results.push(successful);
            else results.push(missResult(request, 'not-resident'));
          }
          return {
            requestedCount: normalizedRequests.length,
            hitCount: results.filter(function (item) { return item.status === 'hit'; }).length,
            missCount: results.filter(function (item) { return item.status === 'miss'; }).length,
            tooLargeCount: results.filter(function (item) { return item.status === 'too-large'; }).length,
            byteLength: totalBytes,
            results: results,
          };
        });
    }

    function read(tabId, url, readOptions) {
      return readMany(tabId, [{ url: url, maxBytes: readOptions && readOptions.maxBytes }], readOptions)
        .then(function (summary) { return summary.results[0] || null; });
    }

    return Object.freeze({
      API_VERSION: 1,
      read: read,
      readMany: readMany,
      supports: function (kind) { return /^(?:resourceCacheRead|resourceCacheReadMany)$/.test(String(kind || '')); },
      perceive: function (tabId, kind, params) {
        params = params || {};
        if (kind === 'resourceCacheRead') return read(tabId, params.url, params);
        if (kind === 'resourceCacheReadMany') return readMany(tabId, params.requests || [], params);
        return Promise.reject(new CacheReadError('PAGE_RESOURCE_CACHE_UNAVAILABLE', 'Unknown page resource cache evidence kind', { kind: kind }));
      },
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    CacheReadError: CacheReadError,
    normalizedHttpUrl: normalizedHttpUrl,
    flattenResourceTree: flattenResourceTree,
    estimateBase64Bytes: estimateBase64Bytes,
    createReader: createReader,
  });
});
