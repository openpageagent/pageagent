// ARP/1 Page service. This module is an adapter over the unified page engines;
// it never injects a second page runtime or owns page targets.
(function attachAgentPageService(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var pageDataContract = commonJs ? require('../shared/page-data-contract.js') : root.PageDataContract;
  var api = factory(root, pageDataContract);
  if (commonJs) module.exports = api;
  else if (root) root.AgentPageService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, pageDataContract) {
  'use strict';

  var PAGE_RUNTIME_IMPLEMENTATION_VERSION = root && root.PageEngineVersion && root.PageEngineVersion.version || 'page-engine.unavailable';
  var MAX_ARTIFACTS_PER_TURN = 8;
  var MAX_MEDIA_BYTES = 20 * 1024 * 1024;

  if (!pageDataContract) throw new Error('AgentPageService requires PageDataContract');

  function PageServiceError(code, message, options) {
    options = options || {};
    this.name = 'PageServiceError';
    this.code = String(code || 'PAGE_SERVICE_FAILED');
    this.message = String(message || this.code);
    this.performed = /^(?:yes|no|unknown)$/.test(String(options.performed)) ? String(options.performed) : 'no';
    this.retryable = options.retryable === true;
    this.details = options.details || null;
    this.currentPage = options.currentPage || null;
    this.warnings = Array.isArray(options.warnings) ? options.warnings.slice() : [];
    if (Error.captureStackTrace) Error.captureStackTrace(this, PageServiceError);
  }
  PageServiceError.prototype = Object.create(Error.prototype);
  PageServiceError.prototype.constructor = PageServiceError;

  function compactError(error) {
    var value = error && error.message;
    if (!value && error && typeof error === 'object') {
      try { value = JSON.stringify(error); } catch (_) {}
    }
    return String(value || error || 'Unknown page error').slice(0, 2000);
  }

  function resolveContextTabId(context) {
    context = context || {};
    var entry = context.entryStatus || context.entry || {};
    var candidates = [context.currentTabId, context.pageTabId, context.boundTabId, context.senderTabId, entry.tabId, context.tab && context.tab.id];
    for (var index = 0; index < candidates.length; index += 1) {
      var tabId = Number(candidates[index]);
      if (Number.isInteger(tabId) && tabId > 0) return tabId;
    }
    throw new PageServiceError('PAGE_CONTEXT_REQUIRED', 'No target page tab was resolved. Pass an explicit tabId or bind the Conversation entry to a page tab.', { performed: 'no' });
  }

  function pageOrigin(value) {
    try {
      var parsed = new URL(String(value || ''));
      return /^(?:http|https):$/.test(parsed.protocol) ? parsed.origin : '';
    } catch (_) { return ''; }
  }

  function chromeCall(target, method, args) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      }
      function callback(value) {
        var runtimeError = null;
        try { runtimeError = root && root.chrome && root.chrome.runtime && root.chrome.runtime.lastError; } catch (error) { runtimeError = error; }
        finish(runtimeError || null, value);
      }
      try {
        var returned = target[method].apply(target, (args || []).concat(callback));
        if (returned && typeof returned.then === 'function') returned.then(function (value) { finish(null, value); }, finish);
      } catch (error) { finish(error); }
    });
  }

  function visualEvidenceDecision(kind, payload, result) {
    var input = payload && payload.input || {};
    var mode = String(input.visualEvidence || 'auto').toLowerCase();
    if (mode !== 'always' && mode !== 'never') mode = 'auto';
    if (mode === 'never') return { mode: mode, capture: false, reason: 'disabled' };
    if (mode === 'always') return { mode: mode, capture: true, reason: 'explicit-always' };
    var interaction = result && result.interaction || {};
    if (interaction.performed === 'unknown') return { mode: mode, capture: true, reason: 'outcome-unknown' };
    if (interaction.status === 'failed') return { mode: mode, capture: true, reason: 'verification-failed' };
    if (interaction.status === 'unconfirmed') return { mode: mode, capture: true, reason: 'verification-unconfirmed' };
    return { mode: mode, capture: false, reason: 'verification-confirmed' };
  }

  function createPageService(options) {
    options = options || {};
    var chromeApi = options.chrome || root && root.chrome;
    var cdpSessionManager = options.cdpSessionManager;
    var pageAutomation = options.pageAutomation;
    var imageArtifactStore = options.imageArtifactStore;
    var fetchImpl = options.fetch || root && root.fetch && root.fetch.bind(root);
    if (!chromeApi || !chromeApi.tabs || typeof chromeApi.tabs.get !== 'function') throw new Error('AgentPageService requires chrome.tabs.get');
    if (!cdpSessionManager || typeof cdpSessionManager.retainOwnerLease !== 'function') {
      throw new Error('AgentPageService requires CdpSessionManager.retainOwnerLease');
    }
    if (!pageAutomation || !pageAutomation.perception || !pageAutomation.action || !pageAutomation.verification
        || typeof pageAutomation.evaluateReadCommand !== 'function' || typeof pageAutomation.executeCommand !== 'function') {
      throw new Error('AgentPageService requires the unified pageAutomation runtime');
    }
    if (!imageArtifactStore || typeof imageArtifactStore.put !== 'function') throw new Error('AgentPageService requires imageArtifactStore.put');
    if (typeof fetchImpl !== 'function') throw new Error('AgentPageService requires fetch');

    var turnArtifactCounts = new Map();

    function actionOwner(context) {
      return String(context && (context.generationId || context.turnId || context.topicId || context.conversationId) || '');
    }

    function operationTiming(input, fallbackMs) {
      input = input || {};
      var timeoutMs = Number(input.timeoutMs);
      if ((!Number.isFinite(timeoutMs) || timeoutMs <= 0) && input.condition && typeof input.condition === 'object') {
        timeoutMs = Number(input.condition.timeoutMs);
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = Number(fallbackMs) || 10000;
      timeoutMs = Math.max(100, Math.min(timeoutMs, 120000));
      return { timeoutMs: timeoutMs, deadline: null };
    }

    function startOperationTiming(timing) {
      if (!timing) return timing;
      if (!(Number(timing.deadline) > 0)) timing.deadline = Date.now() + timing.timeoutMs;
      return timing;
    }

    function remainingOperationMs(timing) {
      if (!timing) return 10000;
      if (!(Number(timing.deadline) > 0)) return Math.max(0, Number(timing.timeoutMs) || 10000);
      return Math.max(0, Math.min(Number(timing.timeoutMs) || 10000, Number(timing.deadline) - Date.now()));
    }

    function boundedByDeadline(value, timing, operation) {
      if (!timing || !(Number(timing.deadline) > 0)) return Promise.resolve(value);
      var remaining = remainingOperationMs(timing);
      if (remaining < 1) return Promise.reject(new PageServiceError('ACTION_TIMEOUT', String(operation || 'page-operation') + ' 超过统一时限', { performed: 'unknown' }));
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new PageServiceError('ACTION_TIMEOUT', String(operation || 'page-operation') + ' 超过统一时限', { performed: 'unknown' }));
        }, Math.max(1, remaining));
        Promise.resolve(value).then(function (result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }, function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
    }

    function boundedStage(value, timing, maxMs, operation) {
      var remaining = timing ? remainingOperationMs(timing) : Number(maxMs) || 5000;
      var timeoutMs = Math.max(100, Math.min(Number(maxMs) || 5000, remaining));
      return boundedByDeadline(value, {
        timeoutMs: timeoutMs,
        deadline: Date.now() + timeoutMs,
      }, operation);
    }

    function cancelledError() {
      var error = new PageServiceError('ACTION_CANCELLED', '页面动作随生成取消', { performed: 'unknown' });
      error.performed = 'unknown';
      return error;
    }

    function abortable(value, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted) {
        Promise.resolve(value).catch(function () {});
        return Promise.reject(cancelledError());
      }
      return new Promise(function (resolve, reject) {
        var settled = false;
        function cleanup() {
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          if (settled) return;
          settled = true;
          cleanup();
          reject(cancelledError());
        }
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(value).then(function (result) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        }, function (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
    }

    function retainGenerationLease(context, tabId, timing) {
      var owner = actionOwner(context);
      if (!owner) return Promise.resolve(false);
      var leaseOptions = {
        owner: 'AgentGeneration:' + owner,
        type: 'agent-generation',
        signal: context && context.abortSignal || null,
      };
      // Lease retention can wait for an existing attach or recovery. The page
      // operation clock starts only after this transport preparation finishes.
      return abortable(cdpSessionManager.retainOwnerLease(tabId, leaseOptions), context && context.abortSignal);
    }

    function cleanupOwner(owner) {
      owner = String(owner || '');
      if (!owner) return Promise.resolve(0);
      return pageAutomation.action.cleanupOwner(owner, { detachImmediately: true });
    }

    function normalizeError(error) {
      return error;
    }

    function targetRef(snapshot, target) {
      return {
        documentId: String(snapshot.documentId || ''),
        targetId: String(target.targetId || ''),
        frameId: String(target.frameId || ''),
        backendNodeId: Math.max(0, Math.floor(Number(target.backendNodeId) || 0)),
        fingerprint: String(target.fingerprint || ''),
      };
    }

    function elementKind(target) {
      var tag = String(target.tag || '').toLowerCase();
      var role = String(target.role || '').toLowerCase();
      if (/^(?:h[1-6]|heading)$/.test(tag) || role === 'heading') return 'heading';
      if (/^(?:button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|tab|switch|slider|spinbutton)$/.test(role)
          || /^(?:a|button|input|textarea|select|option)$/.test(tag)) return 'control';
      if (/^(?:status|alert|log)$/.test(role)) return 'message';
      return target.text ? 'text' : 'element';
    }

    function externalElement(target) {
      var bounds = target.bounds || {};
      return {
        locator: target.locator || {},
        kind: elementKind(target),
        tag: target.tag,
        role: target.role,
        name: target.name,
        text: target.text,
        value: target.value,
        attributes: target.attributes || {},
        state: {
          visible: target.visible === true,
          enabled: target.enabled !== false,
          editable: target.editable === true,
          disabled: target.enabled === false,
          checked: target.checked,
          selected: target.selected,
          expanded: target.expanded,
          inViewport: target.inViewport === true,
          occluded: target.occluded,
        },
        bounds: bounds,
        inViewport: target.inViewport === true,
      };
    }

    function hasCanonicalLocator(target) {
      var locator = target && target.locator;
      if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return false;
      return ['selector', 'textSelector', 'textPattern', 'label', 'scopeSelector', 'relative'].some(function (key) {
        return String(locator[key] || '').trim() !== '';
      });
    }

    function externalPageState(state) {
      var elements = (state.elements || []).filter(hasCanonicalLocator).map(externalElement);
      return {
        contract: 'canonical-page-state-v1',
        capturedAt: state.capturedAt,
        phase: 'initial',
        page: { tabId: state.tabId, url: state.url, title: state.title },
        application: { engine: 'PagePerceptionEngine' },
        layout: { viewport: state.viewport || {} },
        coverage: { discovered: state.elementCount, returned: elements.length },
        elements: elements,
        elementCount: elements.length,
        discoveredElementCount: state.elementCount,
        discoveryComplete: state.targetsTruncated !== true,
        truncated: state.targetsTruncated === true,
      };
    }

    function observe(context, projection) {
      var tabId = resolveContextTabId(context);
      var timing = operationTiming(projection, 10000);
      var signal = context && context.abortSignal || null;
      return retainGenerationLease(context, tabId, timing).then(function () {
        startOperationTiming(timing);
        return abortable(pageAutomation.perception.observe(tabId, Object.assign({}, projection || {}, {
          timeoutMs: remainingOperationMs(timing),
          signal: signal,
        })), context && context.abortSignal);
      }).then(externalPageState).catch(function (error) { throw normalizeError(error); });
    }

    function windowElement(element, representation, start, maxChars) {
      representation = representation === 'text' ? 'text' : 'outerHTML';
      var dataKey = representation === 'text' ? 'content' : 'outerHTML';
      var source = representation === 'text' ? element.innerText : element.outerHTML;
      var windowed = pageDataContract.paginateValue(String(source || ''), { start: start, maxChars: maxChars }, 'Page element ' + representation, { dataKey: dataKey });
      var result = Object.assign({}, element, { representation: representation }, windowed);
      delete result.innerText;
      if (representation === 'text') delete result.outerHTML;
      return result;
    }

    function readElement(context, locator, start, maxChars, representation) {
      representation = representation === 'text' ? 'text' : 'outerHTML';
      var tabId = resolveContextTabId(context);
      var timing = operationTiming({}, 10000);
      var signal = context && context.abortSignal || null;
      return retainGenerationLease(context, tabId, timing).then(function () {
        startOperationTiming(timing);
        return abortable(pageAutomation.perception.perceive({
        tabId: tabId,
        kind: 'getElement',
        locator: locator || {},
        includeOuterHTML: representation === 'outerHTML',
        includeInnerText: representation === 'text',
        timeoutMs: remainingOperationMs(timing),
        signal: signal,
      }), context && context.abortSignal); }).then(function (target) {
        var element = externalElement(target);
        return windowElement(Object.assign(element, {
          outerHTML: target.outerHTML || '',
          innerText: target.innerText || '',
        }), representation, start, maxChars);
      }).catch(function (error) { throw normalizeError(error); });
    }

    function mediaRecord(snapshot, target, index, generation) {
      var attrs = target.attributes || {};
      return {
        index: index,
        generation: generation,
        documentId: snapshot.documentId,
        targetId: target.targetId,
        targetRef: targetRef(snapshot, target),
        kind: target.tag,
        name: target.name || attrs.alt || attrs.title || target.tag,
        alt: attrs.alt || '',
        currentSrc: attrs.currentSrc || attrs.src || '',
        mimeHint: attrs.type || '',
        naturalWidth: Number(attrs.width) || Number(target.bounds && target.bounds.width) || 0,
        naturalHeight: Number(attrs.height) || Number(target.bounds && target.bounds.height) || 0,
        bounds: target.bounds,
        visible: target.visible === true,
        sourceReadable: target.tag === 'img' && !!(attrs.currentSrc || attrs.src),
        renderedReadable: true,
        evidence: { source: 'PagePerceptionEngine', capturedAt: snapshot.capturedAt },
      };
    }

    function mediaGeneration(snapshot, items, visibleOnly) {
      var value = JSON.stringify([
        String(snapshot && snapshot.documentId || ''),
        visibleOnly !== false,
        (items || []).map(function (item) {
          return [item.kind, item.currentSrc, item.targetId, item.bounds];
        }),
      ]);
      var hash = 2166136261;
      for (var index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      var generation = (hash >>> 0) & 0x7ffffffe;
      return Math.max(2, generation) + (visibleOnly === false ? 1 : 0);
    }

    function captureMediaEvidence(context, projection, timing) {
      projection = projection || {};
      var tabId = resolveContextTabId(context);
      var signal = context && context.abortSignal || null;
      function capturePairedEvidence(attempt) {
        var before;
        var media;
        var captureProjection = Object.assign({}, projection, { timeoutMs: remainingOperationMs(timing), signal: signal });
        return abortable(pageAutomation.perception.capture(tabId, captureProjection), context && context.abortSignal).then(function (snapshot) {
          before = snapshot;
          return abortable(pageAutomation.perception.perceive(Object.assign({}, captureProjection, { tabId: tabId, kind: 'media', signal: signal })), signal);
        }).then(function (result) {
          media = result;
          return abortable(pageAutomation.perception.capture(tabId, captureProjection), context && context.abortSignal);
        }).then(function (after) {
          if (before.documentId === after.documentId) return { snapshot: after, media: media };
          if (attempt < 1) return capturePairedEvidence(attempt + 1);
          throw new PageServiceError('TARGET_STALE', 'The page document changed while media evidence was captured; read /page/media again', { performed: 'no', retryable: true });
        });
      }
      return capturePairedEvidence(0);
    }

    function mediaItemsFromEvidence(paired, projection) {
      var snapshot = paired.snapshot;
      var all = snapshot.targets.filter(function (target) {
        return /^(?:img|video|canvas|svg|iframe)$/.test(String(target.tag || '')) && (projection.visibleOnly === false || target.visible === true);
      }).map(function (target, index) { return mediaRecord(snapshot, target, index, 0); });
      var seen = Object.create(null);
      all.forEach(function (item) { seen[item.kind + '|' + item.currentSrc + '|' + JSON.stringify(item.bounds || {})] = true; });
      (paired.media && paired.media.items || []).forEach(function (item) {
        var key = String(item.kind || '') + '|' + String(item.currentSrc || '') + '|' + JSON.stringify(item.bounds || {});
        if (seen[key]) return;
        seen[key] = true;
        all.push(Object.assign({}, item, {
          index: all.length, generation: 0,
          documentId: snapshot.documentId, targetId: '', targetRef: null,
          evidence: { source: 'PagePerceptionEngine.media', capturedAt: paired.media.capturedAt || snapshot.capturedAt },
        }));
      });
      var generation = mediaGeneration(snapshot, all, projection.visibleOnly);
      all.forEach(function (item) { item.generation = generation; });
      return { snapshot: snapshot, items: all, generation: generation };
    }

    function listMedia(context, projection) {
      projection = projection || {};
      var tabId = resolveContextTabId(context);
      var timing = operationTiming(projection, 30000);
      return retainGenerationLease(context, tabId, timing).then(function () {
        startOperationTiming(timing);
        return captureMediaEvidence(context, projection, timing);
      }).then(function (paired) {
        var collected = mediaItemsFromEvidence(paired, projection);
        var snapshot = collected.snapshot;
        var all = collected.items;
        var generation = collected.generation;
        return {
          observedAt: snapshot.capturedAt,
          generation: generation,
          media: all,
          mediaCount: all.length,
          discoveredMediaCount: all.length,
          documentId: snapshot.documentId,
          start: projection.start,
          maxChars: projection.maxChars,
        };
      }).catch(function (error) { throw normalizeError(error); });
    }

    async function getMedia(context, index, generation) {
      var tabId = resolveContextTabId(context);
      var timing = operationTiming({}, 10000);
      var requestedGeneration = Number(generation);
      var signal = context && context.abortSignal || null;
      if (!Number.isFinite(requestedGeneration) || requestedGeneration <= 0) {
        throw new PageServiceError('MEDIA_NOT_FOUND', 'The media generation is invalid; read /page/media first', { performed: 'no', retryable: true });
      }
      var projection = { visibleOnly: requestedGeneration % 2 !== 1, signal: signal };
      await retainGenerationLease(context, tabId, timing);
      startOperationTiming(timing);
      var paired = await captureMediaEvidence(context, Object.assign({}, projection, {
        timeoutMs: remainingOperationMs(timing),
      }), timing);
      var collected = mediaItemsFromEvidence(paired, projection);
      if (Number(collected.generation) !== requestedGeneration) {
        throw new PageServiceError('TARGET_STALE', 'The current CDP media data no longer matches the requested generation; read /page/media again', { performed: 'no', retryable: true });
      }
      var item = collected.items[Number(index)];
      if (!item) throw new PageServiceError('MEDIA_NOT_FOUND', 'The media index does not exist in the current CDP page data', { performed: 'no', retryable: true });
      return item;
    }

    function reserveTurnArtifact(context) {
      var topicId = String(context && (context.topicId || context.conversationId) || '').trim();
      var turnId = String(context && context.turnId || '').trim();
      if (!topicId || !turnId) return function () {};
      var key = topicId + '\n' + turnId;
      var count = Number(turnArtifactCounts.get(key)) || 0;
      if (count >= MAX_ARTIFACTS_PER_TURN) throw new PageServiceError('IMAGE_TOO_LARGE', 'This Conversation turn has reached the image Artifact limit', { details: { limit: MAX_ARTIFACTS_PER_TURN } });
      turnArtifactCounts.set(key, count + 1);
      var released = false;
      return function () {
        if (released) return;
        released = true;
        var current = Number(turnArtifactCounts.get(key)) || 0;
        if (current <= 1) turnArtifactCounts.delete(key);
        else turnArtifactCounts.set(key, current - 1);
      };
    }

    function ensureArtifactCapacity(context, requested) {
      var topicId = String(context && (context.topicId || context.conversationId) || '').trim();
      var turnId = String(context && context.turnId || '').trim();
      if (!topicId || !turnId) return;
      var count = Number(turnArtifactCounts.get(topicId + '\n' + turnId)) || 0;
      if (count + Math.max(1, Number(requested) || 1) > MAX_ARTIFACTS_PER_TURN) {
        throw new PageServiceError('IMAGE_TOO_LARGE', 'This Conversation turn has reached the image Artifact limit', { details: { limit: MAX_ARTIFACTS_PER_TURN, current: count, requested: requested } });
      }
    }

    async function dataUrlBlob(dataUrl, mimeHint, signal) {
      var response = await abortable(fetchImpl(String(dataUrl || ''), signal ? { signal: signal } : undefined), signal);
      var blob = await abortable(response.blob(), signal);
      var mime = String(blob.type || mimeHint || '').split(';')[0].toLowerCase();
      if (!/^image\/(?:png|jpe?g|webp|gif|bmp|avif|svg\+xml)$/.test(mime) || !blob.size) {
        throw new PageServiceError('IMAGE_FORMAT_UNSUPPORTED', 'The acquired page resource is not a supported image', { details: { mimeType: mime, byteLength: blob.size } });
      }
      if (blob.size > MAX_MEDIA_BYTES) throw new PageServiceError('IMAGE_TOO_LARGE', 'The acquired page image exceeds the byte limit', { details: { byteLength: blob.size, maxBytes: MAX_MEDIA_BYTES } });
      return blob;
    }

    function normalizeScreenshotClip(value) {
      if (value === undefined || value === null) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PageServiceError('INVALID_REQUEST', 'Screenshot clip must be an object');
      }
      var clip = {
        x: Number(value.x),
        y: Number(value.y),
        width: Number(value.width),
        height: Number(value.height),
        scale: value.scale === undefined ? 1 : Number(value.scale),
      };
      if (!Number.isFinite(clip.x) || clip.x < 0
          || !Number.isFinite(clip.y) || clip.y < 0
          || !Number.isFinite(clip.width) || clip.width <= 0
          || !Number.isFinite(clip.height) || clip.height <= 0
          || !Number.isFinite(clip.scale) || clip.scale < 0.1 || clip.scale > 4) {
        throw new PageServiceError('INVALID_REQUEST', 'Screenshot clip coordinates or scale are invalid');
      }
      var outputWidth = Math.round(clip.width * clip.scale);
      var outputHeight = Math.round(clip.height * clip.scale);
      if (!outputWidth || !outputHeight || outputWidth > 8192 || outputHeight > 8192
          || outputWidth * outputHeight > 40 * 1000 * 1000) {
        throw new PageServiceError('IMAGE_TOO_LARGE', 'Screenshot clip output exceeds the pixel limit', {
          details: { width: outputWidth, height: outputHeight, maxPixels: 40 * 1000 * 1000 },
        });
      }
      return clip;
    }

    async function responseBlob(response, mimeHint, signal) {
      var length = Number(response && response.headers && response.headers.get('content-length')) || 0;
      if (length > MAX_MEDIA_BYTES) throw new PageServiceError('IMAGE_TOO_LARGE', 'The page image response exceeds the byte limit', { details: { byteLength: length, maxBytes: MAX_MEDIA_BYTES } });
      var blob = await abortable(response.blob(), signal);
      if (blob.size > MAX_MEDIA_BYTES) throw new PageServiceError('IMAGE_TOO_LARGE', 'The page image exceeds the byte limit', { details: { byteLength: blob.size, maxBytes: MAX_MEDIA_BYTES } });
      var mime = String(blob.type || mimeHint || '').split(';')[0].toLowerCase();
      if (!/^image\//.test(mime) || !blob.size) throw new PageServiceError('IMAGE_FORMAT_UNSUPPORTED', 'The acquired page resource is not an image', { details: { mimeType: mime } });
      return blob;
    }

    function artifactModelPart(record) {
      return {
        type: 'image', artifactUri: record.artifactUri, mimeType: record.mimeType,
        detail: record.detail || 'high', alt: record.alt || '', width: record.width,
        height: record.height, byteLength: record.byteLength,
        representation: record.representation, sourceKind: record.sourceKind,
        acquisitionSource: record.acquisitionSource || '',
      };
    }

    function artifactRecord(record) {
      return {
        id: record.id, artifactUri: record.artifactUri, mimeType: record.mimeType,
        byteLength: record.byteLength, width: record.width, height: record.height,
        representation: record.representation, sourceKind: record.sourceKind,
        acquisitionSource: record.acquisitionSource || '', detail: record.detail || 'high',
        alt: record.alt || '', sha256: record.sha256, createdAt: record.createdAt,
      };
    }

    async function persistArtifact(context, tab, acquired, representation, body, persistedArtifacts) {
      var signal = context && context.abortSignal || null;
      if (signal && signal.aborted) throw cancelledError();
      var release = reserveTurnArtifact(context);
      var stored;
      var pendingStore;
      try {
        pendingStore = Promise.resolve(imageArtifactStore.put(acquired.blob, {
          topicId: String(context && (context.topicId || context.conversationId) || ''),
          turnId: String(context && context.turnId || ''),
          sourcePage: { tabId: Number(tab.id) || 0, origin: pageOrigin(tab.url || tab.pendingUrl) },
          sourceKind: acquired.sourceKind,
          acquisitionSource: acquired.acquisitionSource,
          representation: representation,
          mimeType: acquired.blob.type,
          width: acquired.width,
          height: acquired.height,
          detail: String(body.detail || 'high'),
          alt: acquired.alt || '',
        }));
        stored = await abortable(pendingStore, signal);
      } catch (error) {
        release();
        // If abort won while the persistence write was still in flight, clean
        // up the record when that write eventually resolves.
        if (pendingStore) pendingStore.then(function (lateRecord) {
          if (lateRecord && lateRecord.id && lateRecord.created !== false && imageArtifactStore && typeof imageArtifactStore.delete === 'function') {
            return imageArtifactStore.delete(lateRecord.id);
          }
        }).catch(function () {});
        throw error;
      }
      if (signal && signal.aborted) {
        release();
        // A store write cannot always be interrupted once it has entered the
        // persistence layer. Remove a completed record when the cancellation
        // loses that race, preventing an unreferenced artifact from leaking.
        if (stored && stored.id && stored.created !== false && imageArtifactStore && typeof imageArtifactStore.delete === 'function') {
          await imageArtifactStore.delete(stored.id).catch(function () {});
        }
        throw cancelledError();
      }
      var record = artifactRecord(stored);
      if (persistedArtifacts) persistedArtifacts.push({
        id: stored && stored.id,
        created: !stored || stored.created !== false,
        release: release,
      });
      return Object.assign(record, { modelContent: [artifactModelPart(record)] });
    }

    async function rollbackPersistedArtifacts(persistedArtifacts) {
      var failures = [];
      var entries = Array.isArray(persistedArtifacts) ? persistedArtifacts.slice() : [];
      for (var index = entries.length - 1; index >= 0; index -= 1) {
        var entry = entries[index] || {};
        try {
          if (typeof entry.release === 'function') entry.release();
          if (entry.created && entry.id && imageArtifactStore && typeof imageArtifactStore.delete === 'function') {
            await imageArtifactStore.delete(entry.id);
          }
        } catch (error) {
          failures.push({ id: entry.id || '', message: compactError(error) });
        }
      }
      return failures;
    }

    async function acquireRendered(tabId, descriptor, body, timing, signal) {
      var remaining = remainingOperationMs(timing);
      if (timing && remaining < 100) {
        throw new PageServiceError('ACTION_TIMEOUT', '页面动作的可选视觉证据已超过统一时限', { performed: 'yes' });
      }
      var capture = await pageAutomation.perception.captureScreenshot(tabId, {
        targetRef: descriptor && descriptor.targetRef || null,
        selector: descriptor && !descriptor.targetRef ? descriptor.selector || '' : '',
        frameId: descriptor && descriptor.frameId || '',
        format: body.format === 'auto' ? 'png' : body.format,
        quality: body.quality,
        clip: descriptor ? null : body.clip,
        timeoutMs: timing ? Math.max(100, Math.min(Number(body.timeoutMs) || remaining, remaining)) : undefined,
        signal: signal || null,
      });
      return {
        blob: await dataUrlBlob(capture.dataUrl, 'image/' + capture.format, signal),
        sourceKind: descriptor ? 'page-media-element' : 'page-viewport',
        acquisitionSource: capture.evidenceSource,
        width: descriptor && Number(descriptor.bounds && descriptor.bounds.width)
          || capture.clip && Math.round(Number(capture.clip.width) * Number(capture.clip.scale || 1)) || 0,
        height: descriptor && Number(descriptor.bounds && descriptor.bounds.height)
          || capture.clip && Math.round(Number(capture.clip.height) * Number(capture.clip.scale || 1)) || 0,
        alt: descriptor && (descriptor.alt || descriptor.name) || String(body.alt || 'Current page viewport'),
      };
    }

    async function acquireOriginal(tabId, descriptor, timing, signal) {
      var sourceUrl = String(descriptor.currentSrc || '');
      if (!sourceUrl) throw new PageServiceError('MEDIA_SOURCE_UNREADABLE', 'This media element has no readable original source URL');
      if (/^https?:/i.test(sourceUrl)) {
        var cached = await pageAutomation.perception.perceive({
          tabId: tabId, kind: 'resourceCacheRead', url: sourceUrl,
          maxBytes: MAX_MEDIA_BYTES, maxTotalBytes: MAX_MEDIA_BYTES, timeoutMs: timing ? remainingOperationMs(timing) : 30000,
          signal: signal || null,
        });
        if (cached && cached.status === 'hit') {
          return {
            blob: await dataUrlBlob(cached.dataUrl, cached.mimeType || descriptor.mimeHint, signal),
            sourceKind: 'network-image', acquisitionSource: 'page-resource-cache',
            width: descriptor.naturalWidth, height: descriptor.naturalHeight, alt: descriptor.alt || descriptor.name,
          };
        }
      }
      var response;
      try {
        response = await abortable(fetchImpl(sourceUrl, { credentials: 'include', cache: 'force-cache', signal: signal || undefined }), signal);
      } catch (error) {
        if (signal && signal.aborted) throw cancelledError();
        throw new PageServiceError('MEDIA_SOURCE_UNREADABLE', 'The original media source could not be read by the extension background context');
      }
      if (!response.ok) throw new PageServiceError('MEDIA_SOURCE_UNREADABLE', 'The original media request failed with HTTP ' + response.status, { details: { status: response.status } });
      return {
        blob: await responseBlob(response, descriptor.mimeHint, signal),
        sourceKind: 'network-image', acquisitionSource: 'background-fetch',
        width: descriptor.naturalWidth, height: descriptor.naturalHeight, alt: descriptor.alt || descriptor.name,
      };
    }

    async function createMediaArtifacts(context, index, body) {
      body = body || {};
      var representation = String(body.representation || 'auto').toLowerCase();
      if (['auto', 'original', 'rendered', 'both'].indexOf(representation) === -1) throw new PageServiceError('INVALID_REQUEST', 'Unknown media representation: ' + representation);
      var tabId = resolveContextTabId(context);
      var timing = operationTiming(body, 30000);
      var signal = context && context.abortSignal || null;
      await retainGenerationLease(context, tabId, timing);
      startOperationTiming(timing);
      var descriptor = await getMedia(context, index, body.generation);
      var tab = await abortable(chromeCall(chromeApi.tabs, 'get', [tabId]), signal);
      ensureArtifactCapacity(context, representation === 'both' ? 2 : 1);
      var artifacts = [];
      var persistedArtifacts = [];
      try {
        if (representation === 'both') {
          artifacts.push(await persistArtifact(context, tab, await acquireOriginal(tabId, descriptor, timing, signal), 'original', body, persistedArtifacts));
          artifacts.push(await persistArtifact(context, tab, await acquireRendered(tabId, descriptor, body, timing, signal), 'rendered', body, persistedArtifacts));
        } else if (representation === 'original') {
          artifacts.push(await persistArtifact(context, tab, await acquireOriginal(tabId, descriptor, timing, signal), 'original', body, persistedArtifacts));
        } else if (representation === 'rendered') {
          artifacts.push(await persistArtifact(context, tab, await acquireRendered(tabId, descriptor, body, timing, signal), 'rendered', body, persistedArtifacts));
        } else {
          try { artifacts.push(await persistArtifact(context, tab, await acquireOriginal(tabId, descriptor, timing, signal), 'original', body, persistedArtifacts)); }
          catch (error) {
            if (!/^(?:MEDIA_SOURCE_UNREADABLE|IMAGE_FORMAT_UNSUPPORTED)$/.test(String(error && error.code || ''))) throw error;
            artifacts.push(await persistArtifact(context, tab, await acquireRendered(tabId, descriptor, body, timing, signal), 'rendered', body, persistedArtifacts));
          }
        }
      } catch (error) {
        var cleanupFailures = await rollbackPersistedArtifacts(persistedArtifacts);
        if (cleanupFailures.length && error && (typeof error === 'object' || typeof error === 'function')) {
          error.artifactCleanup = { failed: cleanupFailures };
        }
        throw error;
      }
      var primary = artifacts[0];
      return Object.assign({}, primary, { artifacts: artifacts, modelContent: artifacts.map(function (item) { return item.modelContent[0]; }), requestedRepresentation: representation });
    }

    async function createViewportArtifact(context, body, timing) {
      body = Object.assign({ detail: 'high', format: 'png', quality: 82 }, body || {});
      body.clip = normalizeScreenshotClip(body.clip);
      timing = timing || operationTiming(body, 30000);
      if (timing && remainingOperationMs(timing) < 100) {
        throw new PageServiceError('ACTION_TIMEOUT', '页面动作的可选视觉证据已超过统一时限', { performed: 'yes' });
      }
      var tabId = resolveContextTabId(context);
      var signal = context && context.abortSignal || null;
      ensureArtifactCapacity(context, 1);
      var tab = await boundedStage(
        abortable(chromeCall(chromeApi.tabs, 'get', [tabId]), signal),
        timing,
        5000,
        '读取截图目标标签页'
      );
      await retainGenerationLease(context, tabId, timing);
      startOperationTiming(timing);
      var artifact = await persistArtifact(context, tab, await acquireRendered(
        tabId,
        null,
        body,
        timing,
        signal
      ), 'rendered', body);
      return Object.assign({}, artifact, { artifacts: [artifact], requestedRepresentation: 'rendered' });
    }

    var INTERNAL_PAGE_IDENTITY_KEYS = Object.freeze({
      targetRef: true, targetId: true, documentId: true, backendNodeId: true,
      fingerprint: true,
    });

    function publicPageFacts(value) {
      if (Array.isArray(value)) return value.map(publicPageFacts);
      if (!value || typeof value !== 'object') return value;
      var output = {};
      Object.keys(value).forEach(function (key) {
        if (INTERNAL_PAGE_IDENTITY_KEYS[key]) return;
        output[key] = publicPageFacts(value[key]);
      });
      return output;
    }

    function contextPageId(context) {
      context = context || {};
      var raw = context.raw && typeof context.raw === 'object' ? context.raw : {};
      var entry = context.entryStatus && typeof context.entryStatus === 'object' ? context.entryStatus
        : (raw.entryStatus && typeof raw.entryStatus === 'object' ? raw.entryStatus : {});
      return String(context.pageId || raw.pageId || entry.pageId || '').trim();
    }

    function projectFlowNode(methodName, spec, context, fallback) {
      var nodeTypes = root && root.NodeTypes;
      if (nodeTypes && typeof nodeTypes[methodName] === 'function') {
        var projected = nodeTypes[methodName](spec, contextPageId(context));
        if (projected && !projected.pageId) {
          projected.params = projected.params && typeof projected.params === 'object' ? projected.params : {};
          if (!projected.params.tabId) projected.params.tabId = resolveContextTabId(context);
        }
        return projected;
      }
      var node = fallback ? fallback(spec) : null;
      var pageId = contextPageId(context);
      if (node && pageId) node.pageId = pageId;
      if (node && !node.pageId) {
        node.params = node.params && typeof node.params === 'object' ? node.params : {};
        if (!node.params.tabId) node.params.tabId = resolveContextTabId(context);
      }
      return node;
    }

    function canProjectAction(receipt) {
      if (!receipt || receipt.status === 'failed' || receipt.performed === 'unknown') return false;
      return receipt.status === 'confirmed' || receipt.performed === 'yes';
    }

    function interactionFromResult(kind, result, locator, actionSpec, context) {
      var receipt = result.receipt;
      var publicReceipt = publicPageFacts(receipt);
      var newTarget = receipt.newNavigationTarget && receipt.newNavigationTarget.ambiguous !== true
        ? receipt.newNavigationTarget : null;
      var targetTabId = newTarget && Number(newTarget.tabId) > 0 ? Number(newTarget.tabId) : Number(receipt.tabId) || 0;
      var interaction = {
        id: receipt.actionId,
        actionId: receipt.actionId,
        kind: kind,
        status: receipt.status,
        performed: receipt.performed,
        conditionMet: receipt.conditionMet,
        locator: publicPageFacts(locator || {}),
        result: publicPageFacts(result.derivedFacts || {}),
        actionFacts: publicPageFacts(receipt.actionFacts || {}),
        verification: publicPageFacts(receipt.verification || {}),
        receipt: publicReceipt,
        navigation: publicPageFacts(receipt.navigation || {}),
        newNavigationTarget: publicPageFacts(receipt.newNavigationTarget),
        targetTabId: targetTabId,
        targetDisposition: newTarget ? 'new_tab' : (receipt.navigation && receipt.navigation.disposition || 'same_tab'),
        targetUrl: newTarget ? String(newTarget.url || '') : '',
        targetActive: newTarget ? newTarget.active === true : null,
        browserFacts: publicPageFacts(receipt.browserFacts || []),
        startedAt: receipt.startedAt,
        completedAt: receipt.completedAt,
        durationMs: receipt.durationMs,
        warnings: receipt.warnings || [],
      };
      // Replayability belongs to the requested action, while confirmation belongs
      // to the observed result. A trusted input may be dispatched successfully
      // without enough business evidence to confirm the outcome.
      if (actionSpec && canProjectAction(receipt)) {
        var replayActionSpec = actionSpec;
        var effectiveKind = String(result && result.derivedFacts && result.derivedFacts.effectiveKind || '');
        if (actionSpec.kind === 'fill' && effectiveKind === 'select') {
          var selectInput = Object.assign({}, actionSpec.input || {});
          if (selectInput.optionText === undefined && typeof selectInput.value === 'string') {
            selectInput.optionText = selectInput.value;
          }
          replayActionSpec = Object.assign({}, actionSpec, { kind: 'select', input: selectInput });
        }
        interaction.actionSpec = publicPageFacts(replayActionSpec);
        interaction.flowNode = projectFlowNode('projectPageActionNode', publicPageFacts(replayActionSpec), context, function (spec) {
          return { type: 'pageAction', params: spec };
        });
        if (receipt.status === 'unconfirmed') {
          interaction.flowNode.params = interaction.flowNode.params || {};
          interaction.flowNode.params.confirmationMode = 'deferred';
          interaction.verificationRequired = true;
          interaction.verificationHint = '该动作必须紧跟同一页面的 waitForCondition 节点，不能单独作为成功流程保存';
        }
      }
      return interaction;
    }

    function interact(context, kind, payload) {
      payload = payload || {};
      var input = Object.assign({}, payload.input || {});
      var tabId = resolveContextTabId(context);
      var timingInput = input;
      if (kind === 'wait' && (input.timeoutMs === undefined || input.timeoutMs === null || input.timeoutMs === '')
          && input.condition && typeof input.condition === 'object' && !Array.isArray(input.condition)
          && input.condition.timeoutMs !== undefined) {
        timingInput = Object.assign({}, input, { timeoutMs: input.condition.timeoutMs });
      }
      var timing = operationTiming(timingInput, 10000);
      var retained = retainGenerationLease(context, tabId, timing);
      if (kind === 'wait') {
        var waitLocator = input.locator || null;
        delete input.locator;
        return retained.then(function () {
          // The shared action/observation queue may wait behind another page
          // operation. Its timeout starts when the real command begins, not
          // while it is waiting for the queue.
          input.timeoutMs = timing.timeoutMs;
          return abortable(pageAutomation.executeCommand('waitForCondition', Object.assign({}, input, {
            tabId: tabId,
            locator: waitLocator || {},
          }), {
            source: 'agent', owner: actionOwner(context), signal: context && context.abortSignal || null,
          }), context && context.abortSignal);
        }).then(function (result) {
          var receipt = result.receipt;
          var interaction = {
            id: receipt.actionId, actionId: receipt.actionId, kind: 'wait', status: receipt.status, performed: receipt.performed,
            conditionMet: receipt.conditionMet, locator: publicPageFacts(waitLocator || {}),
            result: { conditionMet: receipt.conditionMet }, actionFacts: publicPageFacts(receipt.actionFacts || {}),
            verification: publicPageFacts(receipt.verification || {}), receipt: publicPageFacts(receipt),
            startedAt: receipt.startedAt, completedAt: receipt.completedAt, durationMs: receipt.durationMs, warnings: receipt.warnings || [],
          };
          if (receipt.status === 'confirmed') {
            interaction.flowNode = projectFlowNode('projectPageWaitNode', {
              condition: publicPageFacts(input.condition || input.expect || {}),
              locator: publicPageFacts(waitLocator || {}),
              timeoutMs: timing.timeoutMs,
              pollIntervalMs: input.pollIntervalMs,
            }, context, function (spec) {
              return { type: 'waitForCondition', params: spec };
            });
          }
          return { interaction: interaction, warnings: [] };
        }).catch(function (error) { throw normalizeError(error); });
      }
      if (kind === 'select') {
        if (input.label !== undefined && input.optionText === undefined) input.optionText = input.label;
        if (input.index !== undefined && input.optionIndex === undefined) input.optionIndex = input.index;
        if (input.exact === true && input.optionMatch === undefined) input.optionMatch = 'exact';
        input.optionIndexBase = 0;
      }
      var locator = payload.locator || input.locator || {};
      delete input.locator;
      // Normalize the public click gesture before entering the shared engine.
      var actionKind = kind === 'click'
        ? (input.clickType === 'dblclick' ? 'doubleClick' : (input.clickType === 'contextmenu' ? 'contextClick' : 'click'))
        : (kind === 'select' ? 'select' : kind);
      var actionSpec = null;
      if (input.sensitive !== true) {
        var reusableInput = Object.assign({}, input);
        ['clickType', 'expect', 'locator', 'sensitive', 'timeoutMs', 'visualEvidence'].forEach(function (key) { delete reusableInput[key]; });
        if (actionKind === 'select') {
          delete reusableInput.label;
          delete reusableInput.index;
          delete reusableInput.exact;
        }
        actionSpec = {
          kind: actionKind,
          locator: publicPageFacts(locator),
          input: publicPageFacts(reusableInput),
          expect: input.expect ? publicPageFacts(input.expect) : null,
          timeoutMs: timing.timeoutMs,
        };
      }
      return retained.then(function () {
        // Start the service timer from the shared action engine's ready point;
        // queue wait and CDP attachment are transport preparation.
        input.timeoutMs = timing.timeoutMs;
        return pageAutomation.action.act({
        source: 'agent', owner: actionOwner(context), tabId: tabId, kind: actionKind,
        targetRef: null,
        locator: locator,
        input: input,
        expect: input.expect || null,
        timeoutMs: input.timeoutMs,
        sensitive: input.sensitive === true,
        signal: context && context.abortSignal || null,
        }, { onReady: function () { startOperationTiming(timing); } });
      }).then(function (result) {
        var serviceResult = { interaction: interactionFromResult(kind, result, locator, actionSpec, context), warnings: result.receipt.warnings || [] };
        var decision = visualEvidenceDecision(kind, payload, serviceResult);
        serviceResult.interaction.visualEvidence = { mode: decision.mode, captured: false, reason: decision.reason };
        if (!decision.capture) return serviceResult;
        if (remainingOperationMs(timing) < 100) {
          serviceResult.interaction.visualEvidence.reason = 'action-deadline-exceeded';
          return serviceResult;
        }
        return abortable(boundedByDeadline(
          createViewportArtifact(context, { detail: 'high', format: 'png', quality: 82, alt: 'Page action visual evidence' }, timing),
          timing,
          '页面动作视觉证据'
        ), context && context.abortSignal).then(function (artifact) {
          serviceResult.interaction.visualEvidence = { mode: decision.mode, captured: true, reason: decision.reason, artifactUri: artifact.artifactUri, acquisitionSource: artifact.acquisitionSource };
          serviceResult.interaction.modelContent = artifact.modelContent || [];
          return serviceResult;
        }).catch(function (error) {
          if (context && context.abortSignal && context.abortSignal.aborted) throw cancelledError();
          var warning = 'The page action completed, but visual evidence capture failed: ' + compactError(error);
          serviceResult.interaction.visualEvidence = { mode: decision.mode, captured: false, reason: decision.reason, error: compactError(error) };
          serviceResult.interaction.warnings = (serviceResult.interaction.warnings || []).concat(warning);
          serviceResult.warnings = (serviceResult.warnings || []).concat(warning);
          return serviceResult;
        });
      }).catch(function (error) { throw normalizeError(error, error && error.receipt && error.receipt.performed || 'unknown'); });
    }

    function javascriptExecutionWithFlowNode(execution, payload, context) {
      if (execution && execution.status === 'confirmed') {
        execution.flowNode = projectFlowNode('projectPageJavascriptNode', {
          source: String(payload.source || ''),
          world: payload.world || 'MAIN',
          mode: payload.mode || 'read',
          start: payload.start,
          maxChars: payload.maxChars,
          timeoutMs: payload.timeoutMs,
        }, context, function (spec) {
          return { type: 'executePageJavascript', params: spec };
        });
      }
      return execution;
    }

    function executeJavascript(context, payload) {
      payload = payload || {};
      var tabId = resolveContextTabId(context);
      var windowSpec;
      try { windowSpec = pageDataContract.normalizeWindow(payload, 'Page JavaScript execution'); }
      catch (error) { return Promise.reject(normalizeError(error)); }
      if (String(payload.mode || 'read').toLowerCase() === 'read') {
        return retainGenerationLease(context, tabId).then(function () {
          return abortable(pageAutomation.evaluateReadCommand({
            tabId: tabId,
            code: String(payload.source || ''),
            sourceType: 'body',
            world: payload.world || 'MAIN',
            start: windowSpec.start,
            maxChars: windowSpec.maxChars,
            timeoutMs: payload.timeoutMs,
          }, { source: 'agent', signal: context && context.abortSignal || null }), context && context.abortSignal);
        }).then(function (result) {
          var receipt = result.receipt;
          var windowed = pageDataContract.paginateValue(result.result, windowSpec, 'Page JavaScript execution result', { dataKey: 'result' });
          return { execution: javascriptExecutionWithFlowNode(Object.assign({
            id: receipt.actionId,
            actionId: receipt.actionId,
            kind: 'javascript',
            world: String(payload.world || 'MAIN'),
            mode: 'read',
            status: receipt.status,
            performed: receipt.performed,
            valueType: result.result === null ? 'null' : typeof result.result,
            verification: publicPageFacts(receipt.verification || {}),
            receipt: publicPageFacts(receipt),
            startedAt: receipt.startedAt,
            completedAt: receipt.completedAt,
            durationMs: receipt.durationMs,
          }, windowed), payload, context) };
        }).catch(function (error) { throw normalizeError(error, 'no'); });
      }
      return retainGenerationLease(context, tabId).then(function () { return pageAutomation.action.act({
        source: 'agent', owner: actionOwner(context), tabId: tabId, kind: 'evaluate',
        input: { code: String(payload.source || ''), sourceType: 'body', world: payload.world || 'MAIN', mode: 'write' },
        timeoutMs: payload.timeoutMs,
        signal: context && context.abortSignal || null,
      }); }).then(function (result) {
        var receipt = result.receipt;
        var windowed = pageDataContract.paginateValue(result.derivedFacts.result, windowSpec, 'Page JavaScript execution result', { dataKey: 'result' });
        return { execution: javascriptExecutionWithFlowNode(Object.assign({
          id: receipt.actionId,
          actionId: receipt.actionId,
          kind: 'javascript',
          world: String(payload.world || 'MAIN'),
          mode: String(payload.mode || 'read'),
          status: receipt.status,
          performed: receipt.performed,
          valueType: result.derivedFacts.result === null ? 'null' : typeof result.derivedFacts.result,
          verification: publicPageFacts(receipt.verification || {}),
          receipt: publicPageFacts(receipt),
          startedAt: receipt.startedAt,
          completedAt: receipt.completedAt,
          durationMs: receipt.durationMs,
        }, windowed), payload, context) };
      }).catch(function (error) { throw normalizeError(error, error && error.receipt && error.receipt.performed || 'unknown'); });
    }

    return Object.freeze({
      contentScriptFiles: [],
      resolveContextTabId: resolveContextTabId,
      health: function (context) {
        var tabId = resolveContextTabId(context);
        return retainGenerationLease(context, tabId).then(function () {
          return abortable(pageAutomation.perception.capture(tabId, { signal: context && context.abortSignal || null }), context && context.abortSignal);
        }).then(function (snapshot) { return { ok: true, implementationVersion: PAGE_RUNTIME_IMPLEMENTATION_VERSION, documentId: snapshot.documentId }; });
      },
      beginToolBatch: function (context) {
        return Promise.resolve({ ok: true, engine: 'PagePerceptionEngine' });
      },
      endToolBatch: function (context) {
        return Promise.resolve({ ok: true, engine: 'PagePerceptionEngine', cleaned: 0 });
      },
      endGeneration: function (context) {
        return cleanupOwner(actionOwner(context)).then(function (results) {
          return { ok: true, engine: 'PagePerceptionEngine', cleaned: results };
        });
      },
      observe: observe,
      getElement: readElement,
      listMedia: listMedia,
      getMedia: getMedia,
      createMediaArtifacts: createMediaArtifacts,
      createViewportArtifact: createViewportArtifact,
      interact: interact,
      executeJavascript: executeJavascript,
    });
  }

  return Object.freeze({
    IPC_TYPE: '',
    PAGE_RUNTIME_IMPLEMENTATION_VERSION: PAGE_RUNTIME_IMPLEMENTATION_VERSION,
    CONTENT_SCRIPT_FILES: Object.freeze([]),
    CONTENT_SCRIPT_CSS: Object.freeze([]),
    PageServiceError: PageServiceError,
    resolveContextTabId: resolveContextTabId,
    visualEvidenceDecision: visualEvidenceDecision,
    createPageService: createPageService,
  });
});
