// Single PagePerceptionEngine. CDP providers submit evidence; callers receive one PageFactModel.
(function attachPagePerceptionEngine(root, factory) {
  'use strict';
  var api = factory(root && root.PageFactContract, root && root.PageDataContract, root && root.PageJavascriptContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PagePerceptionEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (factContract, pageDataContract, javascriptContract) {
  'use strict';
  var API_VERSION = 1;
  var DEFAULT_MAX_TARGETS = 1200;

  function createPagePerceptionEngine(options) {
    options = options || {};
    var sessions = options.cdpSessionManager;
    var networkFacts = options.networkFactProvider || null;
    var evidenceProviders = Object.create(null);
    var chromeApi = options.chrome || globalThis.chrome;
    if (!factContract || !pageDataContract || !javascriptContract || !sessions) {
      throw new Error('PagePerceptionEngine requires shared contracts and CdpSessionManager');
    }

    function fail(code, message, details) { throw new factContract.PageFactError(code, message, details); }
    function ensureNotAborted(signal) {
      if (!signal || signal.aborted !== true) return;
      if (signal.reason instanceof Error) {
        try { signal.reason.code = signal.reason.code || 'ACTION_CANCELLED'; } catch (_) {}
        try { signal.reason.performed = signal.reason.performed || 'unknown'; } catch (_) {}
        try { signal.reason.retryable = false; } catch (_) {}
        throw signal.reason;
      }
      throw new factContract.PageFactError('ACTION_CANCELLED', '页面操作已取消');
    }
    function abortablePromise(value, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted === true) {
        Promise.resolve(value).catch(function () {});
        try { ensureNotAborted(signal); } catch (error) { return Promise.reject(error); }
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
          try { ensureNotAborted(signal); } catch (error) { reject(error); }
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
    function abortableDelay(ms, signal) {
      ensureNotAborted(signal);
      return new Promise(function (resolve, reject) {
        var settled = false;
        function cleanup() {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          try { ensureNotAborted(signal); } catch (error) { reject(error); }
        }
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }, Math.max(0, Number(ms) || 0));
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    function registerEvidenceProvider(name, provider) {
      name = String(name || '').trim();
      if (!name || !provider || provider.API_VERSION !== 1 || typeof provider.perceive !== 'function') throw new Error('PagePerceptionEngine evidence provider requires name, API_VERSION=1 and perceive()');
      if (evidenceProviders[name] && evidenceProviders[name] !== provider) throw new Error('PagePerceptionEngine evidence provider already registered: ' + name);
      evidenceProviders[name] = provider;
      return true;
    }
    function diagnosticProvider(kind) {
      var names = Object.keys(evidenceProviders);
      for (var index = 0; index < names.length; index += 1) {
        var provider = evidenceProviders[names[index]];
        if (!provider || typeof provider.perceive !== 'function') continue;
        if (typeof provider.supports !== 'function' || provider.supports(kind)) return provider;
      }
      return null;
    }
    function compact(value, limit) {
      return String(value === undefined || value === null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit || 1000);
    }
    function targetIdFor(tabId, documentId, frameId, backendNodeId) {
      return 'target_' + factContract.hash([
        Number(tabId) || 0,
        String(documentId || ''),
        String(frameId || ''),
        Number(backendNodeId) || 0,
      ].join(':'));
    }
    function targetIdentity(tabId, documentId, target) {
      target = target || {};
      var backendNodeId = Math.max(0, Math.floor(Number(target.backendNodeId) || 0));
      if (!backendNodeId) return null;
      var frameId = String(target.frameId || '');
      return Object.freeze({
        targetId: targetIdFor(tabId, documentId, frameId, backendNodeId),
        frameId: frameId,
        backendNodeId: backendNodeId,
      });
    }
    function normalizeCurrentTarget(tabId, documentId, target) {
      var identity = targetIdentity(tabId, documentId, target);
      if (!identity) fail('TARGET_STALE', '目标节点没有有效的 CDP 身份', { documentId: documentId });
      return factContract.normalizeTarget(Object.assign({}, target, identity));
    }
    function stringAt(strings, index) { return Number.isInteger(index) && index >= 0 && index < strings.length ? String(strings[index] || '') : ''; }
    function rareIndex(rare, nodeIndex) {
      if (!rare || !Array.isArray(rare.index)) return -1;
      return rare.index.indexOf(nodeIndex);
    }
    function rareString(rare, nodeIndex, strings) {
      var found = rareIndex(rare, nodeIndex);
      return found === -1 || !Array.isArray(rare.value) ? '' : stringAt(strings, rare.value[found]);
    }
    function rareBoolean(rare, nodeIndex) { return rareIndex(rare, nodeIndex) !== -1; }
    function frameTreeFrames(tree) {
      var frames = [];
      (function visit(node) {
        if (!node || !node.frame) return;
        frames.push({
          id: String(node.frame.id || ''), parentId: String(node.frame.parentId || ''),
          loaderId: String(node.frame.loaderId || ''), url: String(node.frame.url || ''),
          name: String(node.frame.name || ''), securityOrigin: String(node.frame.securityOrigin || ''),
        });
        (node.childFrames || []).forEach(visit);
      })(tree);
      return frames;
    }
    function senderForFrame(send, frameId) {
      return send && typeof send.forFrame === 'function' ? send.forFrame(String(frameId || '')) : send;
    }
    function senderForSession(send, sessionId) {
      return send && typeof send.forSession === 'function' ? send.forSession(String(sessionId || '')) : send;
    }
    function signalSender(send, signal) {
      if (!signal || typeof signal.addEventListener !== 'function') return send;
      var wrapped = function (method, params, timeoutMs) {
        ensureNotAborted(signal);
        return abortablePromise(send(method, params || {}, timeoutMs), signal);
      };
      wrapped.forFrame = function (frameId) { return signalSender(senderForFrame(send, frameId), signal); };
      wrapped.forSession = function (sessionId) { return signalSender(senderForSession(send, sessionId), signal); };
      wrapped.getFrameRoute = function (frameId) {
        return send && typeof send.getFrameRoute === 'function' ? send.getFrameRoute(String(frameId || '')) : null;
      };
      wrapped.getSessionRoute = function (sessionId) {
        return send && typeof send.getSessionRoute === 'function' ? send.getSessionRoute(String(sessionId || '')) : null;
      };
      wrapped.listFrameRoutes = function () {
        return send && typeof send.listFrameRoutes === 'function' ? send.listFrameRoutes() : [];
      };
      wrapped.waitForFrameRoutes = function () {
        if (!send || typeof send.waitForFrameRoutes !== 'function') return Promise.resolve([]);
        return abortablePromise(send.waitForFrameRoutes(), signal);
      };
      wrapped._rawSend = send && send._rawSend || send;
      return wrapped;
    }
    function rawSender(send) {
      return send && send._rawSend || send;
    }
    function frameRoute(send, frameId) {
      return send && typeof send.getFrameRoute === 'function' ? send.getFrameRoute(String(frameId || '')) : null;
    }
    function sessionRoute(send, sessionId) {
      return send && typeof send.getSessionRoute === 'function' ? send.getSessionRoute(String(sessionId || '')) : null;
    }
    async function resolveBackendNodeWithSend(send, frameId, backendNodeId, objectGroup) {
      backendNodeId = Number(backendNodeId) || 0;
      if (!backendNodeId) return null;
      var targetSend = senderForFrame(send, frameId);
      var params = { backendNodeId: backendNodeId, objectGroup: String(objectGroup || '') };
      var isolated = await targetSend('Page.createIsolatedWorld', {
        frameId: String(frameId || ''),
        worldName: 'page-automation-target',
        grantUniveralAccess: false,
      }, 5000);
      if (isolated && Number(isolated.executionContextId) > 0) {
        params.executionContextId = Number(isolated.executionContextId);
      }
      var resolved = await targetSend('DOM.resolveNode', params, 5000);
      if (resolved && resolved.object && resolved.object.objectId) return resolved;
      if (params.executionContextId) {
        delete params.executionContextId;
        resolved = await targetSend('DOM.resolveNode', params, 5000);
      }
      return resolved;
    }
    function quadBounds(quad) {
      var xs = [], ys = [];
      for (var index = 0; index + 1 < (quad || []).length; index += 2) {
        xs.push(Number(quad[index]));
        ys.push(Number(quad[index + 1]));
      }
      if (!xs.length) return null;
      return factContract.normalizeBounds({
        x: Math.min.apply(Math, xs), y: Math.min.apply(Math, ys),
        width: Math.max.apply(Math, xs) - Math.min.apply(Math, xs),
        height: Math.max.apply(Math, ys) - Math.min.apply(Math, ys),
      });
    }
    function identityTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
    function applyTransform(transform, point) {
      transform = transform || identityTransform();
      point = point || {};
      var x = Number(point.x) || 0;
      var y = Number(point.y) || 0;
      return {
        x: transform.a * x + transform.c * y + transform.e,
        y: transform.b * x + transform.d * y + transform.f,
      };
    }
    function inverseTransform(transform, point) {
      transform = transform || identityTransform();
      point = point || {};
      var determinant = transform.a * transform.d - transform.b * transform.c;
      if (Math.abs(determinant) < 1e-9) return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
      var x = (Number(point.x) || 0) - transform.e;
      var y = (Number(point.y) || 0) - transform.f;
      return {
        x: (transform.d * x - transform.c * y) / determinant,
        y: (-transform.b * x + transform.a * y) / determinant,
      };
    }
    function transformBounds(value, transform) {
      value = value || {};
      var x = Number(value.x !== undefined ? value.x : value.left) || 0;
      var y = Number(value.y !== undefined ? value.y : value.top) || 0;
      var width = Math.max(0, Number(value.width) || 0);
      var height = Math.max(0, Number(value.height) || 0);
      var points = [
        applyTransform(transform, { x: x, y: y }),
        applyTransform(transform, { x: x + width, y: y }),
        applyTransform(transform, { x: x + width, y: y + height }),
        applyTransform(transform, { x: x, y: y + height }),
      ];
      var xs = points.map(function (point) { return point.x; });
      var ys = points.map(function (point) { return point.y; });
      return factContract.normalizeBounds({
        x: Math.min.apply(Math, xs), y: Math.min.apply(Math, ys),
        width: Math.max.apply(Math, xs) - Math.min.apply(Math, xs),
        height: Math.max.apply(Math, ys) - Math.min.apply(Math, ys),
      });
    }
    function transformFromQuad(quad, width, height, parentTransform) {
      if (!Array.isArray(quad) || quad.length < 8) return null;
      var localPoints = [
        { x: Number(quad[0]) || 0, y: Number(quad[1]) || 0 },
        { x: Number(quad[2]) || 0, y: Number(quad[3]) || 0 },
        { x: Number(quad[6]) || 0, y: Number(quad[7]) || 0 },
      ];
      var points = localPoints.map(function (point) { return applyTransform(parentTransform, point); });
      var horizontalLength = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      var verticalLength = Math.hypot(points[2].x - points[0].x, points[2].y - points[0].y);
      width = Math.max(1, Number(width) || horizontalLength || 1);
      height = Math.max(1, Number(height) || verticalLength || 1);
      return {
        a: (points[1].x - points[0].x) / width,
        b: (points[1].y - points[0].y) / width,
        c: (points[2].x - points[0].x) / height,
        d: (points[2].y - points[0].y) / height,
        e: points[0].x,
        f: points[0].y,
      };
    }
    async function frameGeometry(send, frameId, viewport, cache, signal) {
      cache = cache || Object.create(null);
      frameId = String(frameId || '');
      ensureNotAborted(signal);
      var route = frameRoute(send, frameId);
      if (!route || route.root) {
        return { frameId: frameId, offsetX: 0, offsetY: 0, transform: identityTransform(), depth: 0, clip: {
          x: 0, y: 0, width: Math.max(0, Number(viewport && viewport.width) || 0), height: Math.max(0, Number(viewport && viewport.height) || 0),
        } };
      }
      if (cache[route.sessionId]) return cache[route.sessionId];
      cache[route.sessionId] = (async function () {
        var parentRoute = route.parentSessionId ? sessionRoute(send, route.parentSessionId) : null;
        var parentGeometry = parentRoute && parentRoute.frameId
          ? await frameGeometry(send, parentRoute.frameId, viewport, cache, signal)
          : { offsetX: 0, offsetY: 0, transform: identityTransform(), depth: 0, clip: { x: 0, y: 0, width: Math.max(0, Number(viewport && viewport.width) || 0), height: Math.max(0, Number(viewport && viewport.height) || 0) } };
        var parentSend = senderForSession(send, route.parentSessionId);
        var owner = await parentSend('DOM.getFrameOwner', { frameId: route.frameId }, 5000);
        ensureNotAborted(signal);
        var backendNodeId = Number(owner && owner.backendNodeId) || 0;
        var quads = { quads: [] };
        if (backendNodeId) {
          quads = await parentSend('DOM.getContentQuads', { backendNodeId: backendNodeId }, 5000);
          ensureNotAborted(signal);
        }
        var quad = quads.quads && quads.quads[0];
        var localBounds = quadBounds(quad);
        if (!localBounds) {
          return { frameId: route.frameId, sessionId: route.sessionId, parentSessionId: route.parentSessionId, offsetX: parentGeometry.offsetX, offsetY: parentGeometry.offsetY, transform: parentGeometry.transform || identityTransform(), depth: parentGeometry.depth + 1, clip: parentGeometry.clip, ownerBackendNodeId: backendNodeId };
        }
        var childSend = senderForSession(send, route.sessionId);
        var childViewport = await childSend('Runtime.evaluate', {
          expression: '({width:innerWidth,height:innerHeight})', returnByValue: true,
        }, 3000);
        ensureNotAborted(signal);
        if (childViewport && childViewport.exceptionDetails) throw childViewport.exceptionDetails;
        var childSize = childViewport && childViewport.result && childViewport.result.value || {};
        var transform = transformFromQuad(quad, childSize.width, childSize.height, parentGeometry.transform || identityTransform());
        if (!transform) transform = {
          a: 1, b: 0, c: 0, d: 1,
          e: parentGeometry.offsetX + localBounds.x,
          f: parentGeometry.offsetY + localBounds.y,
        };
        var bounds = transformBounds({ x: 0, y: 0, width: Number(childSize.width) || localBounds.width, height: Number(childSize.height) || localBounds.height }, transform);
        return {
          frameId: route.frameId, sessionId: route.sessionId, parentSessionId: route.parentSessionId,
          offsetX: transform.e, offsetY: transform.f, transform: transform, depth: parentGeometry.depth + 1,
          clip: intersectBounds(parentGeometry.clip, bounds), bounds: bounds,
          ownerBackendNodeId: backendNodeId,
        };
      })();
      return cache[route.sessionId];
    }
    function attributeMap(raw, strings) {
      var out = {};
      for (var index = 0; index + 1 < raw.length; index += 2) out[stringAt(strings, raw[index])] = stringAt(strings, raw[index + 1]);
      return out;
    }
    function layoutMap(layout) {
      var map = new Map();
      var indexes = layout && layout.nodeIndex || [];
      for (var index = 0; index < indexes.length; index += 1) {
        var rawBounds = layout.bounds && layout.bounds[index] || [];
        var styles = layout.styles && layout.styles[index] || [];
        map.set(indexes[index], { bounds: rawBounds, styles: styles, text: layout.text && layout.text[index], paintOrder: layout.paintOrders && layout.paintOrders[index] });
      }
      return map;
    }
    function layoutStyle(item, position, strings) {
      return stringAt(strings, item && item.styles && item.styles[position]);
    }
    function layoutHasArea(item) {
      var bounds = item && item.bounds || [];
      return Number(bounds[2]) > 0 && Number(bounds[3]) > 0;
    }
    function layoutOpacityZero(item, strings) {
      var opacity = layoutStyle(item, 2, strings);
      return opacity !== '' && Number(opacity) === 0;
    }
    function layoutStyleHidden(item, strings) {
      var display = layoutStyle(item, 0, strings);
      var visibility = layoutStyle(item, 1, strings);
      var contentVisibility = layoutStyle(item, 4, strings);
      return display === 'none' || visibility === 'hidden' || visibility === 'collapse'
        || contentVisibility === 'hidden' || layoutOpacityZero(item, strings);
    }
    function intersectBounds(left, right) {
      if (!left || !right) return null;
      var x = Math.max(Number(left.x) || 0, Number(right.x) || 0);
      var y = Math.max(Number(left.y) || 0, Number(right.y) || 0);
      var rightEdge = Math.min((Number(left.x) || 0) + (Number(left.width) || 0), (Number(right.x) || 0) + (Number(right.width) || 0));
      var bottomEdge = Math.min((Number(left.y) || 0) + (Number(left.height) || 0), (Number(right.y) || 0) + (Number(right.height) || 0));
      if (!(rightEdge > x && bottomEdge > y)) return null;
      return { x: x, y: y, width: rightEdge - x, height: bottomEdge - y };
    }
    // A PageState target is useful only when some of its rendered surface is
    // exposed in the current viewport. DOMSnapshot already supplies text and
    // layout, so this browser-side probe only adds CSS/clipping/hit-test facts.
    // Glyph-by-glyph Range probing is deliberately avoided: it forces repeated
    // layout and hit testing on the business page for every visible word.
    function visualExposureRuntime(input) {
      input = input || {};
      var descriptors = Array.isArray(input.targets) ? input.targets : [];
      var viewport = input.viewport || {};
      var viewportRect = { x: 0, y: 0, width: Math.max(0, Number(viewport.width) || innerWidth), height: Math.max(0, Number(viewport.height) || innerHeight) };
      var transform = input.transform || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      var output = descriptors.map(function (item) {
        return { targetId: String(item.targetId || ''), found: false, visible: false, inViewport: false, exposed: false, occluded: true, text: '' };
      });
      var styleCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      var visibilityCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      var selfClipCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      var parentClipCache = typeof WeakMap === 'function' ? new WeakMap() : null;
      var roots = [];
      var seenRoots = [];
      function addRoot(root) {
        if (!root || seenRoots.indexOf(root) !== -1) return;
        seenRoots.push(root);
        roots.push(root);
        var all = [];
        try { all = root.querySelectorAll('*'); } catch (_) { all = []; }
        for (var i = 0; i < all.length; i += 1) if (all[i].shadowRoot) addRoot(all[i].shadowRoot);
      }
      addRoot(document);
      function parentOf(node) {
        if (!node) return null;
        if (node.parentElement) return node.parentElement;
        var root = node.getRootNode && node.getRootNode();
        return root && root.host || null;
      }
      function ownUi(el) {
        return !!(el && el.getAttribute && (el.hasAttribute('data-page-automation-ui') || /^page-automation-/.test(String(el.id || ''))));
      }
      function excluded(el) {
        var current = el;
        while (current) {
          if (ownUi(current)) return true;
          current = parentOf(current);
        }
        return false;
      }
      function normalized(value) { return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim(); }
      function styleFor(element) {
        if (styleCache && styleCache.has(element)) return styleCache.get(element);
        var style = null;
        try { style = getComputedStyle(element); } catch (_) { style = null; }
        if (styleCache) styleCache.set(element, style);
        return style;
      }
      function localBounds(item) {
        var bounds = item && item.bounds || {};
        var x = Number(bounds.x) || 0, y = Number(bounds.y) || 0;
        var w = Math.max(0, Number(bounds.width) || 0), h = Math.max(0, Number(bounds.height) || 0);
        var points = [{ x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }];
        var determinant = Number(transform.a || 1) * Number(transform.d || 1) - Number(transform.b || 0) * Number(transform.c || 0);
        if (Math.abs(determinant) < 1e-9) return { x: x, y: y, width: w, height: h };
        var mapped = points.map(function (point) {
          var px = point.x - (Number(transform.e) || 0), py = point.y - (Number(transform.f) || 0);
          return {
            x: ((Number(transform.d || 1) * px) - (Number(transform.c || 0) * py)) / determinant,
            y: ((-Number(transform.b || 0) * px) + (Number(transform.a || 1) * py)) / determinant,
          };
        });
        var xs = mapped.map(function (point) { return point.x; });
        var ys = mapped.map(function (point) { return point.y; });
        return { x: Math.min.apply(Math, xs), y: Math.min.apply(Math, ys), width: Math.max.apply(Math, xs) - Math.min.apply(Math, xs), height: Math.max.apply(Math, ys) - Math.min.apply(Math, ys) };
      }
      function cssVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        if (visibilityCache && visibilityCache.has(el)) return visibilityCache.get(el);
        var visible = true;
        try {
          if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) visible = false;
        } catch (_) {}
        var current = el;
        while (visible && current) {
          var style = styleFor(current);
          if (style && (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0
              || current === el && (style.visibility === 'hidden' || style.visibility === 'collapse'))) visible = false;
          current = parentOf(current);
        }
        if (visibilityCache) visibilityCache.set(el, visible);
        return visible;
      }
      function styleVisible(el) {
        if (!cssVisible(el)) return false;
        var rects = el.getClientRects();
        return !!(rects && rects.length);
      }
      function clippingBounds(element, includeSelf) {
        var cache = includeSelf ? selfClipCache : parentClipCache;
        if (cache && cache.has(element)) return cache.get(element);
        var clipped = { x: viewportRect.x, y: viewportRect.y, width: viewportRect.width, height: viewportRect.height };
        var current = includeSelf ? element : parentOf(element);
        while (clipped && current) {
          var style = styleFor(current);
          var overflowX = style && style.overflowX || '';
          var overflowY = style && style.overflowY || '';
          var contain = style && style.contain || '';
          var clipsPaint = /(?:^|\s)paint(?:\s|$)/.test(contain);
          if (/^(?:hidden|clip|auto|scroll)$/.test(overflowX) || /^(?:hidden|clip|auto|scroll)$/.test(overflowY) || clipsPaint) {
            var currentRect = current.getBoundingClientRect();
            if (clipsPaint) clipped = intersectClient(clipped, { x: currentRect.left, y: currentRect.top, width: currentRect.width, height: currentRect.height });
            if (clipped && /^(?:hidden|clip|auto|scroll)$/.test(overflowX)) {
              var right = Math.min(clipped.x + clipped.width, currentRect.right);
              clipped.x = Math.max(clipped.x, currentRect.left);
              clipped.width = Math.max(0, right - clipped.x);
            }
            if (clipped && /^(?:hidden|clip|auto|scroll)$/.test(overflowY)) {
              var bottom = Math.min(clipped.y + clipped.height, currentRect.bottom);
              clipped.y = Math.max(clipped.y, currentRect.top);
              clipped.height = Math.max(0, bottom - clipped.y);
            }
          }
          current = parentOf(current);
        }
        clipped = clipped && clipped.width > 0 && clipped.height > 0 ? clipped : null;
        if (cache) cache.set(element, clipped);
        return clipped;
      }
      function clipRect(rect, element, includeSelf) {
        var raw = { x: Number(rect.left) || 0, y: Number(rect.top) || 0, width: Math.max(0, Number(rect.width) || 0), height: Math.max(0, Number(rect.height) || 0) };
        return intersectClient(raw, clippingBounds(element, includeSelf));
      }
      function intersectClient(left, right) {
        if (!left || !right) return null;
        var x = Math.max(left.x, right.x), y = Math.max(left.y, right.y);
        var rightEdge = Math.min(left.x + left.width, right.x + right.width);
        var bottomEdge = Math.min(left.y + left.height, right.y + right.height);
        return rightEdge > x && bottomEdge > y ? { x: x, y: y, width: rightEdge - x, height: bottomEdge - y } : null;
      }
      function visibleRects(element, includeSelf) {
        var rects = [];
        if (!element || !styleVisible(element)) return rects;
        var raw;
        try { raw = element.getClientRects(); } catch (_) { raw = []; }
        for (var i = 0; i < raw.length; i += 1) {
          var clipped = clipRect(raw[i], element, includeSelf === true);
          if (clipped) rects.push(clipped);
        }
        return rects;
      }
      function topAt(x, y) {
        function topIn(root) {
          var stack = [];
          try {
            if (root.elementsFromPoint) stack = root.elementsFromPoint(x, y);
            else if (root.elementFromPoint) stack = [root.elementFromPoint(x, y)];
          } catch (_) { stack = []; }
          for (var i = 0; i < stack.length; i += 1) if (stack[i] && !excluded(stack[i])) return stack[i];
          return null;
        }
        var hit = topIn(document);
        while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
          var inner = topIn(hit.shadowRoot);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        return hit;
      }
      function composedContains(ancestor, node) {
        if (!ancestor || !node) return false;
        var current = node;
        while (current) {
          if (current === ancestor) return true;
          current = parentOf(current);
        }
        return false;
      }
      function samples(rect) {
        var insetX = Math.min(1, rect.width / 4), insetY = Math.min(1, rect.height / 4);
        var left = rect.x + insetX, right = rect.x + rect.width - insetX;
        var top = rect.y + insetY, bottom = rect.y + rect.height - insetY;
        var centerX = rect.x + rect.width / 2, centerY = rect.y + rect.height / 2;
        return [{ x: centerX, y: centerY }, { x: left, y: top }, { x: right, y: top }, { x: left, y: bottom }, { x: right, y: bottom }];
      }
      function elementExposed(element, rects) {
        for (var i = 0; i < rects.length; i += 1) {
          var points = samples(rects[i]);
          for (var j = 0; j < points.length; j += 1) {
            var hit = topAt(points[j].x, points[j].y);
            if (hit && composedContains(element, hit)) return true;
          }
        }
        return false;
      }
      function candidatesFor(selector) {
        var candidates = [];
        var selectors = String(selector || '').split('||').map(function (value) { return value.trim(); }).filter(Boolean);
        for (var r = 0; r < roots.length; r += 1) {
          for (var s = 0; s < selectors.length; s += 1) {
            var found = [];
            try { found = roots[r].querySelectorAll(selectors[s]); } catch (_) { found = []; }
            for (var i = 0; i < found.length; i += 1) if (!excluded(found[i]) && candidates.indexOf(found[i]) === -1) candidates.push(found[i]);
          }
        }
        return candidates;
      }
      function score(element, item, expectedBounds) {
        var tag = String(element.tagName || '').toLowerCase();
        var expectedTag = String(item.tag || '').toLowerCase();
        if (expectedTag && tag !== expectedTag) return -100000;
        var value = 0;
        var name = normalized(item.name);
        var actualName = normalized(element.getAttribute && (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || ''));
        if (name && actualName === name) value += 1000;
        else if (name && actualName.indexOf(name) !== -1) value += 100;
        var text = normalized(element.innerText || element.textContent || '');
        var expectedText = normalized(item.text);
        if (expectedText && (text === expectedText || text.indexOf(expectedText) !== -1)) value += 20;
        var rect = element.getBoundingClientRect();
        var dx = Math.abs(rect.left - expectedBounds.x), dy = Math.abs(rect.top - expectedBounds.y);
        value -= Math.min(100, dx + dy);
        return value;
      }
      for (var descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
        var descriptor = descriptors[descriptorIndex] || {};
        var expectedBounds = localBounds(descriptor);
        var candidates = candidatesFor(descriptor.selector);
        var best = null, bestScore = -Infinity;
        for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
          var candidateScore = score(candidates[candidateIndex], descriptor, expectedBounds);
          if (candidateScore > bestScore) { bestScore = candidateScore; best = candidates[candidateIndex]; }
        }
        if (!best || bestScore < -1000) continue;
        output[descriptorIndex].found = true;
        var rects = visibleRects(best, false);
        output[descriptorIndex].visible = styleVisible(best);
        output[descriptorIndex].inViewport = rects.length > 0;
        output[descriptorIndex].exposed = rects.length > 0 && elementExposed(best, rects);
        output[descriptorIndex].occluded = !output[descriptorIndex].exposed;
        output[descriptorIndex].text = output[descriptorIndex].exposed
          ? normalized(descriptor.text || descriptor.name)
          : '';
      }
      return output;
    }
    function visualExposureExpression(targets, viewport, transform) {
      return '(' + visualExposureRuntime.toString() + ')(' + JSON.stringify({
        targets: targets || [], viewport: viewport || {}, transform: transform || identityTransform(),
      }) + ')';
    }
    function documentGeometry(documents, layouts, viewport) {
      var geometries = new Array(documents.length);
      var viewportClip = { x: 0, y: 0, width: Math.max(0, Number(viewport && viewport.width) || 0), height: Math.max(0, Number(viewport && viewport.height) || 0) };
      if (documents.length) {
        geometries[0] = {
          offsetX: -(Number(documents[0].scrollOffsetX) || 0),
          offsetY: -(Number(documents[0].scrollOffsetY) || 0),
          clip: viewportClip,
        };
      }
      var unresolved = Math.max(0, documents.length - 1);
      for (var round = 0; unresolved && round < documents.length; round += 1) {
        var progressed = false;
        for (var parentIndex = 0; parentIndex < documents.length; parentIndex += 1) {
          var parentGeometry = geometries[parentIndex];
          if (!parentGeometry) continue;
          var nodes = documents[parentIndex].nodes || {};
          var rare = nodes.contentDocumentIndex || {};
          (rare.index || []).forEach(function (ownerNodeIndex, valueIndex) {
            var childIndex = Number(rare.value && rare.value[valueIndex]);
            if (!(childIndex >= 0 && childIndex < documents.length) || geometries[childIndex]) return;
            var ownerLayout = layouts[parentIndex].get(Number(ownerNodeIndex));
            var rawBounds = ownerLayout && ownerLayout.bounds || [];
            if (rawBounds.length < 4) return;
            var ownerBounds = {
              x: parentGeometry.offsetX + Number(rawBounds[0] || 0),
              y: parentGeometry.offsetY + Number(rawBounds[1] || 0),
              width: Math.max(0, Number(rawBounds[2]) || 0),
              height: Math.max(0, Number(rawBounds[3]) || 0),
            };
            geometries[childIndex] = {
              offsetX: ownerBounds.x - (Number(documents[childIndex].scrollOffsetX) || 0),
              offsetY: ownerBounds.y - (Number(documents[childIndex].scrollOffsetY) || 0),
              clip: intersectBounds(parentGeometry.clip, ownerBounds),
            };
            unresolved -= 1;
            progressed = true;
          });
        }
        if (!progressed) break;
      }
      for (var index = 0; index < documents.length; index += 1) {
        if (!geometries[index]) geometries[index] = {
          offsetX: -(Number(documents[index].scrollOffsetX) || 0),
          offsetY: -(Number(documents[index].scrollOffsetY) || 0),
          clip: viewportClip,
        };
      }
      return geometries;
    }
    function axMap(nodes) {
      var map = new Map();
      (nodes || []).forEach(function (node) {
        var backend = Number(node && node.backendDOMNodeId) || 0;
        if (!backend) return;
        var properties = {};
        (node.properties || []).forEach(function (property) { properties[property.name] = property.value && property.value.value; });
        map.set(String(node._pageFrameId || '') + ':' + backend, {
          role: String(node.role && node.role.value || ''),
          name: String(node.name && node.name.value || ''),
          description: String(node.description && node.description.value || ''),
          disabled: properties.disabled === true,
          checked: typeof properties.checked === 'boolean' ? properties.checked : null,
          selected: typeof properties.selected === 'boolean' ? properties.selected : null,
          expanded: typeof properties.expanded === 'boolean' ? properties.expanded : null,
          value: node.value && node.value.value !== undefined ? node.value.value : null,
        });
      });
      return map;
    }
    function isInteractive(tag, role, attrs) {
      tag = String(tag || '').toLowerCase();
      role = String(role || '').toLowerCase();
      return /^(?:a|button|input|textarea|select|option|summary|details|label|iframe|img|video|audio|canvas|svg)$/.test(tag)
        || /^(?:button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|tab|switch|slider|spinbutton|treeitem|gridcell)$/.test(role)
        || attrs.tabindex !== undefined || attrs.onclick !== undefined || attrs.contenteditable === 'true';
    }
    function dynamicToken(value) {
      value = String(value || '');
      return !value || value.length > 48 || /^\d/.test(value)
        || /(?:^|[-_])(?:css|jss|sc|svelte|chakra|emotion)[-_]/i.test(value)
        || /[a-f0-9]{10,}/i.test(value) && /\d/.test(value);
    }
    function selectorAttribute(name, value) {
      return '[' + name + '="' + String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\u0000-\u001f\u007f]/g, function (character) {
          return '\\' + character.charCodeAt(0).toString(16) + ' ';
        }) + '"]';
    }
    function selectorKey(tag, name, value) {
      return String(tag || '') + '\n' + String(name || '') + '\n' + String(value || '');
    }
    function locatorForSnapshotNode(index, nodeNames, parents, attributesByNode, positionsByNode, selectorCounts, textValue, label) {
      var tag = String(nodeNames[index] || '').toLowerCase();
      var attrs = attributesByNode[index] || {};
      var candidates = [];
      ['data-testid', 'data-test', 'data-cy', 'data-qa'].forEach(function (name) {
        if (attrs[name]) candidates.push({ name: name, value: attrs[name], selector: tag + selectorAttribute(name, attrs[name]) });
      });
      if (attrs.id && !dynamicToken(attrs.id)) candidates.push({ name: 'id', value: attrs.id, selector: selectorAttribute('id', attrs.id) });
      ['name', 'aria-label', 'aria-labelledby', 'title', 'placeholder'].forEach(function (name) {
        if (attrs[name]) candidates.push({ name: name, value: attrs[name], selector: tag + selectorAttribute(name, attrs[name]) });
      });
      var selector = '';
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var candidate = candidates[candidateIndex];
        if (selectorCounts[selectorKey(tag, candidate.name, candidate.value)] === 1) {
          selector = candidate.selector;
          break;
        }
      }
      if (!selector) {
        var parts = [];
        var current = index;
        var depth = 0;
        while (current >= 0 && depth < 8) {
          var currentTag = String(nodeNames[current] || '').toLowerCase();
          if (!currentTag || currentTag.charAt(0) === '#') break;
          if (currentTag === 'html' || currentTag === 'body') {
            parts.unshift(currentTag);
            break;
          }
          parts.unshift(currentTag + ':nth-of-type(' + Math.max(1, Number(positionsByNode[current]) || 1) + ')');
          current = Number(parents[current]);
          depth += 1;
        }
        selector = parts.join(' > ').slice(0, 1000);
      }
      var locator = {};
      if (selector) locator.selector = selector;
      if (textValue) locator.textSelector = compact(textValue, 500);
      if (label) locator.label = compact(label, 500);
      return factContract.normalizeLocator(locator);
    }
    function isExtensionUiNode(attrs, parentExcluded, tagName) {
      if (parentExcluded) return true;
      tagName = String(tagName || '').toLowerCase();
      // DOMSnapshot includes non-rendered document metadata and stylesheet or
      // script text. It is not page evidence and must never be folded into the
      // visible text of html/body or used as a target label.
      if (/^(?:head|style|script|noscript|template|meta|link|base|title)$/.test(tagName)) return true;
      attrs = attrs || {};
      return attrs['data-page-automation-ui'] !== undefined
        || /^page-automation-/.test(String(attrs.id || ''));
    }
    function parseSnapshot(tabId, raw, frameTree, metadata) {
      var segments = Array.isArray(raw && raw._pageSegments) && raw._pageSegments.length
        ? raw._pageSegments : [{ raw: raw, offsetX: 0, offsetY: 0, clip: null, viewport: metadata.viewport || {} }];
      var rootRaw = segments[0].raw || {};
      var strings = rootRaw.strings || [];
      var documents = rootRaw.documents || [];
      var frames = frameTreeFrames(frameTree);
      var mainFrame = frames[0] || {};
      var mainDocument = documents[0] || {};
      var url = metadata.url || stringAt(strings, mainDocument.documentURL) || mainFrame.url || '';
      // Page identity follows the top-level browser document. Child frame/OOPIF
      // loading is independent and must not invalidate every target on the page.
      // Same-document history/hash changes keep the loader; a real navigation
      // replaces it. This also matches viewportSnapshotFromNavigation().
      var documentId = 'document_' + factContract.hash([tabId, mainFrame.id, mainFrame.loaderId].join(':'));
      // The document identity comes from this CDP capture. No prior page
      // observation is consulted or retained as a second source of truth.
      var targets = [];
      segments.forEach(function (segment) {
        var segmentRaw = segment.raw || {};
        var strings = segmentRaw.strings || [];
        var accessibility = axMap(segmentRaw.accessibilityNodes || []);
        var documents = segmentRaw.documents || [];
        var layouts = documents.map(function (documentSnapshot) { return layoutMap(documentSnapshot.layout || {}); });
        var localGeometries = documentGeometry(documents, layouts, segment.viewport || metadata.viewport || {});
        var segmentTransform = segment.transform || {
          a: 1, b: 0, c: 0, d: 1,
          e: Number(segment.offsetX) || 0, f: Number(segment.offsetY) || 0,
        };
        var geometries = localGeometries.map(function (geometry) {
          var translatedClip = geometry.clip && transformBounds(geometry.clip, segmentTransform);
          return {
            offsetX: geometry.offsetX,
            offsetY: geometry.offsetY,
            transform: segmentTransform,
            clip: segment.clip ? intersectBounds(translatedClip, segment.clip) : translatedClip,
          };
        });
        documents.forEach(function (documentSnapshot, documentIndex) {
        var nodes = documentSnapshot.nodes || {};
        var layout = layouts[documentIndex];
        var geometry = geometries[documentIndex];
        var count = nodes.nodeName && nodes.nodeName.length || 0;
        var childText = new Array(count).fill('');
        var attributesByNode = new Array(count);
        var contentEditableByNode = new Array(count).fill(false);
        var excludedByNode = new Array(count).fill(false);
        var transparentByNode = new Array(count).fill(false);
        var nodeNames = new Array(count);
        var parents = new Array(count);
        var positionsByNode = new Array(count).fill(1);
        var siblingTypeCounts = Object.create(null);
        for (var nodeIndex = 0; nodeIndex < count; nodeIndex += 1) {
          var name = stringAt(strings, nodes.nodeName[nodeIndex]).toLowerCase();
          nodeNames[nodeIndex] = name;
          attributesByNode[nodeIndex] = attributeMap(nodes.attributes && nodes.attributes[nodeIndex] || [], strings);
          var parentIndex = Number(nodes.parentIndex && nodes.parentIndex[nodeIndex]);
          parents[nodeIndex] = parentIndex;
          excludedByNode[nodeIndex] = isExtensionUiNode(
            attributesByNode[nodeIndex], parentIndex >= 0 && excludedByNode[parentIndex], name
          );
          var nodeLayout = layout.get(nodeIndex);
          transparentByNode[nodeIndex] = (parentIndex >= 0 && transparentByNode[parentIndex] === true)
            || layoutOpacityZero(nodeLayout, strings);
          if (name === '#text' && !excludedByNode[nodeIndex]
              && !transparentByNode[nodeIndex] && layoutHasArea(nodeLayout)
              && !layoutStyleHidden(nodeLayout, strings)) {
            childText[nodeIndex] = compact(stringAt(strings, nodes.nodeValue[nodeIndex]), 600);
          }
          if (name && name.charAt(0) !== '#') {
            var siblingKey = parentIndex + '\n' + name;
            siblingTypeCounts[siblingKey] = (Number(siblingTypeCounts[siblingKey]) || 0) + 1;
            positionsByNode[nodeIndex] = siblingTypeCounts[siblingKey];
          }
          var contentEditableValue = attributesByNode[nodeIndex].contenteditable;
          var inheritedContentEditable = parentIndex >= 0 && contentEditableByNode[parentIndex] === true;
          if (contentEditableValue === undefined || !/^(?:|true|false|plaintext-only)$/i.test(String(contentEditableValue))) {
            contentEditableByNode[nodeIndex] = inheritedContentEditable;
          } else {
            contentEditableByNode[nodeIndex] = !/^false$/i.test(String(contentEditableValue));
          }
        }
        for (var reverse = count - 1; reverse >= 0; reverse -= 1) {
          var parent = Number(nodes.parentIndex && nodes.parentIndex[reverse]);
          if (!excludedByNode[reverse] && parent >= 0 && !excludedByNode[parent]
              && childText[reverse] && childText[parent].length < 900) {
            childText[parent] = compact(childText[reverse] + ' ' + childText[parent], 900);
          }
        }
        var selectorCounts = Object.create(null);
        for (var selectorIndex = 0; selectorIndex < count; selectorIndex += 1) {
          if (excludedByNode[selectorIndex]) continue;
          var selectorTag = String(nodeNames[selectorIndex] || '').toLowerCase();
          if (!selectorTag || selectorTag.charAt(0) === '#') continue;
          var selectorAttrs = attributesByNode[selectorIndex] || {};
          ['data-testid', 'data-test', 'data-cy', 'data-qa', 'id', 'name', 'aria-label', 'aria-labelledby', 'title', 'placeholder'].forEach(function (attributeName) {
            var attributeValue = selectorAttrs[attributeName];
            if (!attributeValue || attributeName === 'id' && dynamicToken(attributeValue)) return;
            var key = selectorKey(selectorTag, attributeName, attributeValue);
            selectorCounts[key] = (Number(selectorCounts[key]) || 0) + 1;
          });
        }
        for (var index = 0; index < count && targets.length < DEFAULT_MAX_TARGETS; index += 1) {
          var nodeName = stringAt(strings, nodes.nodeName[index]);
          if (!nodeName || nodeName.charAt(0) === '#' || excludedByNode[index]) continue;
          var backendNodeId = Number(nodes.backendNodeId && nodes.backendNodeId[index]) || 0;
          if (!backendNodeId) continue;
          var attrs = attributesByNode[index] || {};
          var frameId = stringAt(strings, documentSnapshot.frameId) || String(segment.frameId || '') || mainFrame.id || '';
          var ax = accessibility.get(String(frameId) + ':' + backendNodeId) || {};
          var tag = nodeName.toLowerCase();
          if (tag === 'html' || tag === 'body') continue;
          var role = ax.role || attrs.role || '';
          var itemLayout = layout.get(index);
          var rawBounds = itemLayout && itemLayout.bounds || [];
          var normalizedBounds = transformBounds({
            x: geometry.offsetX + Number(rawBounds[0] || 0),
            y: geometry.offsetY + Number(rawBounds[1] || 0),
            width: rawBounds[2],
            height: rawBounds[3],
          }, geometry.transform);
          var visible = !!itemLayout && normalizedBounds.width > 0 && normalizedBounds.height > 0
            && !transparentByNode[index] && !layoutStyleHidden(itemLayout, strings);
          var inViewport = !!intersectBounds(normalizedBounds, geometry.clip);
          var value = rareString(nodes.inputValue, index, strings);
          if (!value && ax.value !== undefined && ax.value !== null) value = ax.value;
          if (!value && contentEditableByNode[index]) value = childText[index];
          var checked = rareBoolean(nodes.inputChecked, index) ? true : (ax.checked === true ? true : (ax.checked === false ? false
            : (attrs['aria-checked'] === 'true' ? true : (attrs['aria-checked'] === 'false' ? false : null))));
          var selected = rareBoolean(nodes.optionSelected, index) ? true : (ax.selected === true ? true : (ax.selected === false ? false
            : (attrs['aria-selected'] === 'true' ? true : (attrs['aria-selected'] === 'false' ? false : null))));
          var expanded = ax.expanded === true ? true : (ax.expanded === false ? false
            : (attrs['aria-expanded'] === 'true' ? true : (attrs['aria-expanded'] === 'false' ? false : null)));
          var name = compact(ax.name || attrs['aria-label'] || attrs.alt || attrs.title || childText[index], 500);
          var elementText = compact(childText[index] || name || value, 800);
          var interactive = isInteractive(tag, role, attrs) || contentEditableByNode[index];
          if (!visible) continue;
          if (!interactive && !elementText) continue;
          var locator = locatorForSnapshotNode(
            index, nodeNames, parents, attributesByNode, positionsByNode,
            selectorCounts, elementText, name
          );
          targets.push(normalizeCurrentTarget(tabId, documentId, {
            frameId: frameId,
            backendNodeId: backendNodeId,
            nodeName: tag,
            tag: tag,
            role: role,
            name: name,
            text: elementText,
            attributes: attrs,
            bounds: normalizedBounds,
            visible: visible,
            inViewport: inViewport,
            occluded: null,
            enabled: attrs.disabled === undefined && attrs['aria-disabled'] !== 'true' && ax.disabled !== true,
            editable: attrs.disabled === undefined && attrs.readonly === undefined
              && attrs['aria-disabled'] !== 'true' && attrs['aria-readonly'] !== 'true' && ax.disabled !== true
              && (/^(?:input|textarea|select)$/.test(tag) || contentEditableByNode[index] || /^(?:textbox|searchbox|combobox)$/.test(role)),
            value: value === '' ? null : value,
            checked: checked,
            selected: selected,
            expanded: expanded,
            locator: locator,
            evidence: { source: 'PagePerceptionEngine', sources: ['DOMSnapshot', 'Accessibility'], capturedAt: metadata.capturedAt, documentIndex: documentIndex, nodeIndex: index, paintOrder: itemLayout && itemLayout.paintOrder },
          }));
        }
        });
      });
      var snapshot = factContract.createSnapshot({
        documentId: documentId,
        tabId: tabId,
        frameId: mainFrame.id || '',
        url: url,
        title: metadata.title || '',
        viewport: metadata.viewport || {},
        navigation: { loaderId: mainFrame.loaderId || '', frameId: mainFrame.id || '', readyState: metadata.readyState || '' },
        targets: targets,
        evidence: {
          source: 'PagePerceptionEngine', capturedAt: new Date().toISOString(),
          providers: ['DOMSnapshot', 'Accessibility', 'Page', 'Runtime'], frameCount: Math.max(frames.length, segments.length),
          oopifSessionCount: Math.max(0, segments.length - 1),
          frameCaptureErrors: Array.isArray(metadata.frameCaptureErrors) ? metadata.frameCaptureErrors : [],
          partialFrameCapture: Array.isArray(metadata.frameCaptureErrors) && metadata.frameCaptureErrors.length > 0,
          targetsTruncated: targets.length >= DEFAULT_MAX_TARGETS,
          targetLimit: DEFAULT_MAX_TARGETS,
        },
      });
      return snapshot;
    }
    async function captureWithSend(send, tabId, captureOptions) {
      tabId = Math.floor(Number(tabId));
      captureOptions = captureOptions || {};
      send = signalSender(send, captureOptions.signal);
      ensureNotAborted(captureOptions.signal);
      if (!(tabId > 0)) throw new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面感知需要有效 tabId');
      var frameTreeResponse = await send('Page.getFrameTree', {}, 10000);
      ensureNotAborted(captureOptions.signal);
      var frames = frameTreeFrames(frameTreeResponse.frameTree);
      var routes = send && typeof send.waitForFrameRoutes === 'function'
        ? await send.waitForFrameRoutes() : [];
      ensureNotAborted(captureOptions.signal);
      routes = routes.filter(function (route) {
        return route && route.frameId && frames.some(function (frame) { return frame.id === route.frameId; });
      });
      var rootValues = await abortablePromise(Promise.all([
        send('DOMSnapshot.captureSnapshot', {
          computedStyles: ['display', 'visibility', 'opacity', 'pointer-events', 'content-visibility'],
          includeDOMRects: true,
          includePaintOrder: true,
        }, captureOptions.timeoutMs || 20000),
        send('Runtime.evaluate', {
          expression: '(function(){return {title:document.title||"",url:location.href,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio||1,scrollX:scrollX,scrollY:scrollY,documentWidth:Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0),documentHeight:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)}}})()',
          returnByValue: true,
        }, 5000),
        Promise.all(frames.filter(function (frame) { return !frameRoute(send, frame.id); }).map(function (frame) {
          return send('Accessibility.getFullAXTree', { frameId: frame.id }, 15000).then(function (response) {
            return { frameId: frame.id, response: response };
          });
        })),
      ]), captureOptions.signal);
      ensureNotAborted(captureOptions.signal);
      if (rootValues[1] && rootValues[1].exceptionDetails) throw rootValues[1].exceptionDetails;
      rootValues[0].accessibilityNodes = rootValues[2].filter(Boolean).reduce(function (all, item) {
        return all.concat((item.response && item.response.nodes || []).map(function (node) {
          return Object.assign({ _pageFrameId: item.frameId }, node);
        }));
      }, []);
      var metadata = rootValues[1] && rootValues[1].result && rootValues[1].result.value || {};
      metadata.capturedAt = new Date().toISOString();
      metadata.frameCaptureErrors = [];
      var geometryCache = Object.create(null);
      var segments = [{ raw: rootValues[0], offsetX: 0, offsetY: 0, transform: identityTransform(), clip: null, viewport: metadata.viewport || {}, frameId: frames[0] && frames[0].id || '' }];
      for (var routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
        ensureNotAborted(captureOptions.signal);
        var route = routes[routeIndex];
        if (!route || route.type !== 'iframe' || !route.frameId) continue;
        var routeSend = senderForSession(send, route.sessionId);
        var childTree = await abortablePromise(routeSend('Page.getFrameTree', {}, 10000), captureOptions.signal);
        var childFrames = frameTreeFrames(childTree.frameTree);
        var childValues = await abortablePromise(Promise.all([
          routeSend('DOMSnapshot.captureSnapshot', {
            computedStyles: ['display', 'visibility', 'opacity', 'pointer-events', 'content-visibility'],
            includeDOMRects: true,
            includePaintOrder: true,
          }, captureOptions.timeoutMs || 20000),
          routeSend('Runtime.evaluate', {
            expression: '(function(){return {viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio||1,scrollX:scrollX,scrollY:scrollY,documentWidth:Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0),documentHeight:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)}}})()',
            returnByValue: true,
          }, 5000),
          Promise.all(childFrames.filter(function (frame) {
            var nested = frameRoute(send, frame.id);
            return !nested || nested.sessionId === route.sessionId;
          }).map(function (frame) {
            return routeSend('Accessibility.getFullAXTree', { frameId: frame.id }, 15000).then(function (response) {
              return { frameId: frame.id, response: response };
            });
          })),
        ]), captureOptions.signal);
        ensureNotAborted(captureOptions.signal);
        if (childValues[1] && childValues[1].exceptionDetails) throw childValues[1].exceptionDetails;
        childValues[0].accessibilityNodes = childValues[2].filter(Boolean).reduce(function (all, item) {
          return all.concat((item.response && item.response.nodes || []).map(function (node) {
            return Object.assign({ _pageFrameId: item.frameId }, node);
          }));
        }, []);
        var childMetadata = childValues[1] && childValues[1].result && childValues[1].result.value || {};
        var geometry = await frameGeometry(send, route.frameId, metadata.viewport || {}, geometryCache, captureOptions.signal);
        segments.push({
          raw: childValues[0], frameId: route.frameId,
          offsetX: geometry.offsetX, offsetY: geometry.offsetY,
          transform: geometry.transform || { a: 1, b: 0, c: 0, d: 1, e: geometry.offsetX, f: geometry.offsetY },
          clip: geometry.clip, viewport: childMetadata.viewport || {},
        });
      }
      rootValues[0]._pageSegments = segments;
      var snapshot = parseSnapshot(tabId, rootValues[0], frameTreeResponse.frameTree, metadata);
      if (captureOptions.visualExposure === true) {
        snapshot = await refineVisualExposureWithSend(send, snapshot, captureOptions);
      }
      ensureNotAborted(captureOptions.signal);
      return snapshot;
    }
    function capture(tabId, captureOptions) {
      tabId = Math.floor(Number(tabId));
      captureOptions = captureOptions || {};
      if (!(tabId > 0)) return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面感知需要有效 tabId'));
      return sessions.withLease(tabId, { owner: 'PagePerceptionEngine', type: 'short', signal: captureOptions.signal || null }, function (send) {
        return captureWithSend(send, tabId, captureOptions);
      });
    }

    function mainFrameFromTree(response) {
      var frames = frameTreeFrames(response && response.frameTree);
      return frames.find(function (frame) { return !frame.parentId; }) || frames[0] || {};
    }

    async function readNavigationStateWithSend(send, tabId, timeoutMs, signal, constraints) {
      ensureNotAborted(signal);
      timeoutMs = Math.max(1, Math.min(Number(timeoutMs) || 5000, 10000));
      var mainFrame = mainFrameFromTree(await abortablePromise(send('Page.getFrameTree', {}, timeoutMs), signal));
      ensureNotAborted(signal);
      var evaluated;
      evaluated = await abortablePromise(send('Runtime.evaluate', {
        expression: '(function(){var de=document.documentElement,b=document.body,nav=null,legacy=null;try{nav=performance.getEntriesByType("navigation")[0]||null}catch(_){}try{legacy=performance.timing||null}catch(_){}var legacyStart=Number(legacy&&legacy.navigationStart)||0,legacyLoadEnd=Number(legacy&&legacy.loadEventEnd)||0;var loadEventEnd=Number(nav&&nav.loadEventEnd)||0;if(!loadEventEnd&&legacyLoadEnd)loadEventEnd=legacyStart?Math.max(0,legacyLoadEnd-legacyStart):legacyLoadEnd;return {url:location.href,title:document.title||"",readyState:document.readyState,timeOrigin:Number(performance.timeOrigin)||legacyStart||0,navigationType:String(nav&&nav.type||""),domContentLoadedEventEnd:nav?(Number(nav.domContentLoadedEventEnd)||0):0,loadEventEnd:loadEventEnd,loadEventCompleted:loadEventEnd>0,viewport:{width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio||1,scrollX:scrollX,scrollY:scrollY,documentWidth:Math.max(de?de.scrollWidth:0,b?b.scrollWidth:0),documentHeight:Math.max(de?de.scrollHeight:0,b?b.scrollHeight:0)}}})()',
        returnByValue: true,
      }, timeoutMs), signal);
      ensureNotAborted(signal);
      if (evaluated.exceptionDetails) throw evaluated.exceptionDetails;
      if (!evaluated.result || !evaluated.result.value) throw new Error('Runtime.evaluate 未返回导航状态');
      var metadata = evaluated.result.value || {};
      var lifecycleEvidence = sessions && typeof sessions.getLoadEvidence === 'function'
        ? sessions.getLoadEvidence(tabId, {
          frameId: String(mainFrame.id || ''),
          loaderId: String(mainFrame.loaderId || ''),
          previousLoaderId: String(constraints && constraints.previousLoaderId || ''),
          afterMs: Number(constraints && constraints.loadEvidenceAfterMs) || 0,
          eventNames: constraints && constraints.loadEvidenceEvents,
        })
        : null;
      return {
        tabId: tabId,
        frameId: String(mainFrame.id || ''),
        loaderId: String(mainFrame.loaderId || ''),
        url: String(metadata.url || mainFrame.url || ''),
        title: String(metadata.title || ''),
        readyState: String(metadata.readyState || ''),
        timeOrigin: Number(metadata.timeOrigin) || 0,
        navigationType: String(metadata.navigationType || ''),
        domContentLoadedEventEnd: Number(metadata.domContentLoadedEventEnd) || 0,
        loadEventEnd: Number(metadata.loadEventEnd) || 0,
        loadEventCompleted: metadata.loadEventCompleted === true,
        cdpLoadEvidence: lifecycleEvidence,
        viewport: metadata.viewport || {},
        capturedAt: new Date().toISOString(),
        evidence: { source: 'PagePerceptionEngine.Navigation', providers: ['Page', 'Runtime'] },
      };
    }

    function readTabLoadState(tabId, signal) {
      ensureNotAborted(signal);
      if (!chromeApi || !chromeApi.tabs || typeof chromeApi.tabs.get !== 'function') {
        return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面加载判断需要 chrome.tabs.get'));
      }
      return abortablePromise(Promise.resolve(chromeApi.tabs.get(tabId)), signal).then(function (tab) {
        ensureNotAborted(signal);
        return {
          tabStatus: String(tab && tab.status || ''),
          tabUrl: String(tab && tab.url || ''),
          pendingUrl: String(tab && tab.pendingUrl || ''),
          discarded: !!(tab && tab.discarded),
        };
      });
    }

    function readTabInfo(tabId, signal) {
      ensureNotAborted(signal);
      if (!chromeApi || !chromeApi.tabs || typeof chromeApi.tabs.get !== 'function') {
        return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '读取标签页信息需要 chrome.tabs.get'));
      }
      return abortablePromise(Promise.resolve(chromeApi.tabs.get(tabId)), signal).then(function (tab) {
        ensureNotAborted(signal);
        tab = tab || {};
        var committedUrl = String(tab.url || '');
        var pendingUrl = String(tab.pendingUrl || '');
        return {
          tabId: Number(tab.id) || Number(tabId) || 0,
          windowId: Number(tab.windowId) || 0,
          url: pendingUrl || committedUrl,
          committedUrl: committedUrl,
          pendingUrl: pendingUrl,
          title: String(tab.title || ''),
          active: tab.active === true,
          status: String(tab.status || ''),
          discarded: tab.discarded === true,
          incognito: tab.incognito === true,
          evidence: {
            source: 'PagePerceptionEngine.Tab',
            providers: ['chrome.tabs.get'],
            capturedAt: new Date().toISOString(),
          },
        };
      });
    }

    function sameTabLoadState(left, right) {
      left = left || {};
      right = right || {};
      return String(left.tabStatus || '') === String(right.tabStatus || '')
        && String(left.tabUrl || '') === String(right.tabUrl || '')
        && String(left.pendingUrl || '') === String(right.pendingUrl || '')
        && left.discarded === right.discarded;
    }

    function readPageLoadStateWithSend(send, tabId, timeoutMs, signal, constraints) {
      ensureNotAborted(signal);
      var tabBefore;
      return readTabLoadState(tabId, signal).then(function (state) {
        ensureNotAborted(signal);
        tabBefore = state;
        if (state.tabStatus !== 'complete' || state.pendingUrl || state.discarded) {
          return Object.assign({
            tabId: tabId,
            frameId: '',
            loaderId: '',
            url: state.pendingUrl || state.tabUrl || '',
            title: '',
            readyState: 'loading',
            timeOrigin: 0,
            navigationType: '',
            domContentLoadedEventEnd: 0,
            loadEventEnd: 0,
            loadEventCompleted: false,
            viewport: {},
            capturedAt: new Date().toISOString(),
            observationStable: true,
            evidence: {
              source: 'PagePerceptionEngine.PageLoad',
              providers: ['chrome.tabs.get'],
            },
          }, state);
        }
        return readNavigationStateWithSend(send, tabId, timeoutMs, signal, constraints);
      }).then(function (navigation) {
        ensureNotAborted(signal);
        if (navigation && navigation.frameId === '' && navigation.readyState === 'loading') return navigation;
        return readTabLoadState(tabId, signal).then(function (tabState) {
          ensureNotAborted(signal);
          return Object.assign({}, navigation, tabState, {
            observationStable: sameTabLoadState(tabBefore, tabState),
            evidence: {
              source: 'PagePerceptionEngine.PageLoad',
              providers: ['Page.getFrameTree', 'Runtime.evaluate', 'chrome.tabs.get'],
            },
          });
        });
      });
    }

    function pageLoadStateReached(navigation, expectedReadyState, constraints) {
      var checks = pageLoadChecks(navigation, constraints);
      if (!checks.loaderMatchesExpected || !checks.isNewDocument || !checks.observationStable) return false;
      if (expectedReadyState === 'loading') return checks.readyState === 'loading';
      if (expectedReadyState === 'interactive') return /^(?:interactive|complete)$/.test(checks.readyState);
      // Completion is decided from the current document and tab state read on
      // this poll. Do not let a previously received lifecycle event or network
      // activity cache override the live CDP/Chrome facts.
      return checks.tabComplete
        && checks.noPendingUrl
        && checks.readyStateComplete
        && checks.hasLoadEvidence
        && !checks.discarded;
    }

    function pageLoadCompletionEvidence(navigation) {
      navigation = navigation || {};
      var cdp = navigation.cdpLoadEvidence;
      if (cdp && cdp.source) return String(cdp.source) + ':' + String(cdp.name || '');
      if (navigation.loadEventCompleted === true) return 'performance_navigation_timing';
      return '';
    }

    function pageLoadChecks(navigation, constraints) {
      navigation = navigation || {};
      constraints = constraints || {};
      var loaderId = String(navigation.loaderId || '');
      var expectedLoaderId = String(constraints.expectedLoaderId || '');
      var previousLoaderId = String(constraints.previousLoaderId || '');
      var loadEvidence = pageLoadCompletionEvidence(navigation);
      var requiredLifecycleEvent = String(constraints.requiredLifecycleEvent || '');
      var lifecycleEventMatches = !requiredLifecycleEvent
        || !!(navigation.cdpLoadEvidence && String(navigation.cdpLoadEvidence.name || '') === requiredLifecycleEvent);
      var pendingUrl = String(navigation.pendingUrl || '');
      var readyState = String(navigation.readyState || '');
      var tabStatus = String(navigation.tabStatus || '');
      return {
        tabStatus: tabStatus,
        tabComplete: tabStatus === 'complete',
        pendingUrl: pendingUrl,
        noPendingUrl: !pendingUrl,
        readyState: readyState,
        readyStateComplete: readyState === 'complete',
        loaderId: loaderId,
        expectedLoaderId: expectedLoaderId,
        loaderMatchesExpected: !expectedLoaderId || loaderId === expectedLoaderId,
        previousLoaderId: previousLoaderId,
        isNewDocument: !(constraints.requireNewDocument === true && previousLoaderId && loaderId === previousLoaderId),
        observationStable: navigation.observationStable === true,
        loadEvidence: loadEvidence,
        loadEvidenceEvent: navigation.cdpLoadEvidence || null,
        requiredLifecycleEvent: requiredLifecycleEvent,
        hasLoadEvidence: !!loadEvidence && lifecycleEventMatches,
        discarded: navigation.discarded === true,
      };
    }

    function viewportSnapshotFromNavigation(tabId, navigation, captureOptions) {
      var transient = !!(captureOptions && captureOptions.transient === true);
      var documentId = 'document_' + factContract.hash([tabId, navigation.frameId, navigation.loaderId].join(':'));
      var snapshot = factContract.createSnapshot({
        documentId: documentId,
        tabId: tabId,
        frameId: navigation.frameId,
        url: navigation.url,
        title: navigation.title,
        viewport: navigation.viewport,
        navigation: {
          loaderId: navigation.loaderId,
          frameId: navigation.frameId,
          readyState: navigation.readyState,
        },
        targets: [],
        capturedAt: navigation.capturedAt,
        evidence: {
          source: 'PagePerceptionEngine.Viewport',
          capturedAt: navigation.capturedAt,
          providers: ['Page', 'Runtime'],
          projection: 'viewport-navigation',
          transient: transient,
        },
      });
      return snapshot;
    }

    function liveDocumentContextFromNavigation(tabId, navigation) {
      navigation = navigation || {};
      var documentId = 'document_' + factContract.hash([tabId, navigation.frameId, navigation.loaderId].join(':'));
      return Object.freeze({
        documentId: documentId,
        tabId: Number(tabId),
        frameId: String(navigation.frameId || ''),
        url: String(navigation.url || ''),
        title: String(navigation.title || ''),
        viewport: factContract.clone(navigation.viewport || {}),
        navigation: Object.freeze({
          loaderId: String(navigation.loaderId || ''),
          frameId: String(navigation.frameId || ''),
          readyState: String(navigation.readyState || ''),
        }),
        capturedAt: String(navigation.capturedAt || new Date().toISOString()),
        live: true,
      });
    }

    async function getDocumentContextWithSend(send, tabId, captureOptions) {
      captureOptions = captureOptions || {};
      send = signalSender(send, captureOptions.signal);
      ensureNotAborted(captureOptions.signal);
      var navigation = await readNavigationStateWithSend(send, tabId, captureOptions.timeoutMs, captureOptions.signal);
      ensureNotAborted(captureOptions.signal);
      return liveDocumentContextFromNavigation(tabId, navigation);
    }

    async function captureViewportWithSend(send, tabId, captureOptions) {
      captureOptions = captureOptions || {};
      send = signalSender(send, captureOptions.signal);
      ensureNotAborted(captureOptions.signal);
      var navigation = await readNavigationStateWithSend(send, tabId, captureOptions.timeoutMs, captureOptions.signal);
      ensureNotAborted(captureOptions.signal);
      return viewportSnapshotFromNavigation(tabId, navigation, captureOptions);
    }

    function captureViewport(tabId, captureOptions) {
      tabId = Math.floor(Number(tabId));
      captureOptions = captureOptions || {};
      if (!(tabId > 0)) return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面感知需要有效 tabId'));
      return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.viewport', type: 'short', signal: captureOptions.signal || null }, function (send) {
        return captureViewportWithSend(send, tabId, captureOptions);
      });
    }

    function frameRecords(send) {
      return send('Page.getFrameTree', {}, 10000).then(function (response) { return frameTreeFrames(response.frameTree); });
    }
    async function isolatedContexts(send, signal) {
      ensureNotAborted(signal);
      var records = await frameRecords(send);
      ensureNotAborted(signal);
      var routes = send && typeof send.waitForFrameRoutes === 'function' ? await send.waitForFrameRoutes() : [];
      ensureNotAborted(signal);
      routes = routes.filter(function (route) {
        return route && route.frameId && records.some(function (frame) { return frame.id === route.frameId; });
      });
      var contexts = [];
      var rootMetadata;
      rootMetadata = await send('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', returnByValue: true }, 3000);
      if (rootMetadata && rootMetadata.exceptionDetails) throw rootMetadata.exceptionDetails;
      var viewport = rootMetadata && rootMetadata.result && rootMetadata.result.value || {};
      var geometryCache = Object.create(null);
      var geometryByFrame = Object.create(null);
      for (var index = 0; index < records.length; index += 1) {
        ensureNotAborted(signal);
        var frame = records[index];
        var routeSend = senderForFrame(send, frame.id);
        var created = await routeSend('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'page-automation-perception', grantUniveralAccess: false }, 5000);
        if (created && created.executionContextId) {
          var geometry = await frameGeometry(send, frame.id, viewport, geometryCache, signal);
          if (!frameRoute(send, frame.id) && frame.parentId) {
            var parentGeometry = geometryByFrame[frame.parentId]
              || await frameGeometry(send, frame.parentId, viewport, geometryCache, signal);
            var ownerSend = senderForFrame(send, frame.parentId);
            var owner = await ownerSend('DOM.getFrameOwner', { frameId: frame.id }, 5000);
            var ownerBackendNodeId = Number(owner && owner.backendNodeId) || 0;
            var ownerQuads = { quads: [] };
            if (ownerBackendNodeId) ownerQuads = await ownerSend('DOM.getContentQuads', { backendNodeId: ownerBackendNodeId }, 5000);
            var contextViewport = await routeSend('Runtime.evaluate', {
              expression: '({width:innerWidth,height:innerHeight})', contextId: created.executionContextId, returnByValue: true,
            }, 3000);
            if (contextViewport && contextViewport.exceptionDetails) throw contextViewport.exceptionDetails;
            var contextSize = contextViewport && contextViewport.result && contextViewport.result.value || {};
            var ownerQuad = ownerQuads.quads && ownerQuads.quads[0];
            var ownerTransform = transformFromQuad(ownerQuad, contextSize.width, contextSize.height, parentGeometry.transform || identityTransform());
            var ownerBounds = ownerTransform
              ? transformBounds({ x: 0, y: 0, width: Number(contextSize.width) || 0, height: Number(contextSize.height) || 0 }, ownerTransform)
              : quadBounds(ownerQuad);
            if (ownerBounds) geometry = Object.assign({}, geometry, {
              offsetX: ownerTransform ? ownerTransform.e : ownerBounds.x,
              offsetY: ownerTransform ? ownerTransform.f : ownerBounds.y,
              transform: ownerTransform || { a: 1, b: 0, c: 0, d: 1, e: ownerBounds.x, f: ownerBounds.y },
              depth: (Number(parentGeometry.depth) || 0) + 1,
              bounds: ownerBounds,
              clip: intersectBounds(parentGeometry.clip || { x: 0, y: 0, width: Number(viewport.width) || 0, height: Number(viewport.height) || 0 }, ownerBounds),
              ownerBackendNodeId: ownerBackendNodeId,
            });
            else geometry = Object.assign({}, geometry, { depth: (Number(parentGeometry.depth) || 0) + 1, ownerBackendNodeId: ownerBackendNodeId });
          }
          geometryByFrame[frame.id] = geometry;
          contexts.push({
            frameId: frame.id, executionContextId: created.executionContextId,
            parentFrameId: frame.parentId || '', ownerBackendNodeId: Number(geometry.ownerBackendNodeId) || 0,
            offsetX: geometry.offsetX, offsetY: geometry.offsetY,
            transform: geometry.transform || identityTransform(), depth: Number(geometry.depth) || 0,
            send: routeSend,
          });
        }
      }
      if (!contexts.length) fail('PAGE_STATE_UNAVAILABLE', '无法建立页面元素查询上下文', {
        frameCount: records.length,
      });
      return contexts;
    }
    async function refineVisualExposureWithSend(send, snapshot, captureOptions) {
      captureOptions = captureOptions || {};
      var contexts = await isolatedContexts(send, captureOptions.signal);
      var resultByTarget = Object.create(null);
      var attemptedFrames = Object.create(null);
      var contextByFrame = Object.create(null);
      for (var contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
        ensureNotAborted(captureOptions.signal);
        var context = contexts[contextIndex];
        contextByFrame[context.frameId] = context;
        var frameTargets = snapshot.targets.filter(function (target) {
          return target.inViewport === true && String(target.frameId || '') === String(context.frameId || '');
        });
        if (!frameTargets.length) continue;
        var descriptors = frameTargets.map(function (target) {
          return {
            targetId: target.targetId,
            selector: target.locator && target.locator.selector || '',
            tag: target.tag,
            name: compact(target.name, 160),
            text: compact(target.text, 800),
            bounds: target.bounds,
          };
        });
        attemptedFrames[context.frameId] = true;
        var contextSend = context.send || senderForFrame(send, context.frameId);
        var params = {
          expression: visualExposureExpression(descriptors, {
            width: Number(snapshot.viewport && snapshot.viewport.width) || 0,
            height: Number(snapshot.viewport && snapshot.viewport.height) || 0,
          }, context.transform || identityTransform()),
          returnByValue: true,
          silent: true,
        };
        if (Number(context.executionContextId) > 0) params.contextId = context.executionContextId;
        var evaluated = await contextSend('Runtime.evaluate', params, Math.max(5000, Math.min(Number(captureOptions.timeoutMs) || 15000, 30000)));
        ensureNotAborted(captureOptions.signal);
        if (evaluated.exceptionDetails) throw evaluated.exceptionDetails;
        var frameResults = evaluated.result && evaluated.result.value;
        if (!Array.isArray(frameResults)) throw new Error('页面可见性探测没有返回结果数组');
        frameResults.forEach(function (result) {
          if (result && result.targetId) resultByTarget[String(result.targetId)] = result;
        });
      }
      var ownerTargetByFrame = Object.create(null);
      contexts.forEach(function (context) {
        if (!context.parentFrameId || !context.ownerBackendNodeId) return;
        ownerTargetByFrame[context.frameId] = snapshot.targets.find(function (target) {
          return String(target.frameId || '') === String(context.parentFrameId)
            && Number(target.backendNodeId) === Number(context.ownerBackendNodeId);
        }) || null;
      });
      function frameSurfaceExposed(frameId, seen) {
        var context = contextByFrame[frameId];
        if (!context || !context.parentFrameId) return true;
        seen = seen || Object.create(null);
        if (seen[frameId]) return true;
        seen[frameId] = true;
        var ownerTarget = ownerTargetByFrame[frameId];
        var ownerResult = ownerTarget && resultByTarget[ownerTarget.targetId];
        if (ownerResult && ownerResult.exposed !== true) return false;
        return frameSurfaceExposed(context.parentFrameId, seen);
      }
      var targets = [];
      snapshot.targets.forEach(function (target) {
        if (target.inViewport !== true) return;
        if (!frameSurfaceExposed(target.frameId)) return;
        var result = resultByTarget[target.targetId];
        var frameAttempted = attemptedFrames[target.frameId] === true;
        if (frameAttempted) {
          if (!result || result.found !== true || result.visible !== true || result.inViewport !== true || result.exposed !== true) return;
          var exposedText = compact(result.text, 800);
          var interactive = isInteractive(target.tag, target.role, target.attributes || {}) || target.editable === true;
          if (!exposedText && !interactive) return;
          target = factContract.normalizeTarget(Object.assign({}, target, {
            name: interactive ? target.name : compact(exposedText, 500),
            text: exposedText,
            visible: true,
            inViewport: true,
            occluded: false,
            evidence: Object.assign({}, target.evidence || {}, {
              visualExposure: { source: 'Runtime.elementFromPoint', currentViewport: true, ancestorClipping: true, textSource: 'DOMSnapshot' },
            }),
          }));
        } else return;
        targets.push(target);
      });
      var providers = snapshot.evidence && Array.isArray(snapshot.evidence.providers)
        ? snapshot.evidence.providers.slice() : [];
      if (providers.indexOf('Runtime.elementFromPoint') === -1) providers.push('Runtime.elementFromPoint');
      return factContract.createSnapshot({
        documentId: snapshot.documentId,
        tabId: snapshot.tabId,
        frameId: snapshot.frameId,
        url: snapshot.url,
        title: snapshot.title,
        viewport: snapshot.viewport,
        navigation: snapshot.navigation,
        targets: targets,
        capturedAt: snapshot.capturedAt,
        evidence: Object.assign({}, snapshot.evidence || {}, {
          providers: providers,
          projection: 'current-viewport-visual-exposure',
          visualExposure: {
            method: 'css-visibility+ancestor-clipping+elementFromPoint',
            attemptedFrameCount: Object.keys(attemptedFrames).length,
            partial: false,
          },
        }),
      });
    }
    function remoteQueryExpression(locator) {
      return '(function(p){' +
        'function ownUi(el){return !!(el&&el.getAttribute&&(el.hasAttribute("data-page-automation-ui")||/^page-automation-/.test(String(el.id||""))))}' +
        'function excluded(el){var cur=el;while(cur){if(ownUi(cur))return true;var root=cur.getRootNode&&cur.getRootNode();cur=cur.parentElement||(root&&root.host)||null}return false}' +
        'function roots(root,out){out.push(root);var all=[];try{all=root.querySelectorAll("*")}catch(_){all=[]}for(var i=0;i<all.length;i++){if(!excluded(all[i])&&all[i].shadowRoot)roots(all[i].shadowRoot,out)}}' +
        'function text(el){return String(el&&(el.innerText||el.textContent||el.getAttribute&&el.getAttribute("aria-label"))||"").replace(/\\s+/g," ").trim()}' +
        'function actionable(el){return !!(el&&el.matches&&el.matches("a[href],button,input,textarea,select,option,summary,[role=button],[role=link],[role=menuitem],[role=tab],[tabindex],[onclick]"))}' +
        'function visible(el){if(!el||el.isConnected===false)return false;var s=getComputedStyle(el),r=el.getBoundingClientRect();return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.visibility!=="collapse"&&Number(s.opacity)!==0}' +
        'function depth(el){var n=0,cur=el;while(cur){n++;var root=cur.getRootNode&&cur.getRootNode();cur=cur.parentElement||(root&&root.host)||null}return n}' +
        'function ref(path){var parts=String(path||"").split("/").filter(Boolean),cur=null;if(!parts.length)return null;var first=parts.shift();if(first==="html")cur=document.documentElement;else if(first==="body")cur=document.body;else return null;for(var i=0;i<parts.length&&cur;i++){var part=parts[i];if(part==="shadow")cur=cur.shadowRoot;else if(/^child:\\d+$/.test(part))cur=(cur.children||[])[Number(part.slice(6))]||null;else return null}return cur}' +
        'var rs=[];roots(document,rs);var scopes=rs;if(p.scopeRef){var scopeRef=ref(p.scopeRef);scopes=scopeRef&&!excluded(scopeRef)?[scopeRef]:[]}else if(p.scopeSelector){scopes=[];for(var sr=0;sr<rs.length;sr++){var sl=[];try{sl=rs[sr].querySelectorAll(p.scopeSelector)}catch(e){throw new Error("无效范围选择器: "+p.scopeSelector)}for(var sj=0;sj<sl.length;sj++)if(!excluded(sl[sj]))scopes.push(sl[sj])}}' +
        'var found=[];if(p.label){var labelNeedle=String(p.label).replace(/\\s+/g," ").trim();for(var lr=0;lr<scopes.length;lr++){var labels=[];try{labels=scopes[lr].querySelectorAll("label")}catch(_){labels=[]}for(var li=0;li<labels.length;li++){if(text(labels[li]).indexOf(labelNeedle)===-1)continue;var control=labels[li].control||(labels[li].htmlFor&&document.getElementById(labels[li].htmlFor))||labels[li].querySelector("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=combobox],[role=textbox]");if(control)found.push(control)}var controls=[];try{controls=scopes[lr].querySelectorAll("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=combobox],[role=textbox]")}catch(_){controls=[]}for(var ci=0;ci<controls.length;ci++){var n=controls[ci].getAttribute("aria-label")||controls[ci].getAttribute("placeholder")||controls[ci].getAttribute("name")||"";if(String(n).indexOf(labelNeedle)!==-1)found.push(controls[ci])}}if(!found.length){for(var ar=0;ar<scopes.length;ar++){var actions=[];try{actions=scopes[ar].querySelectorAll("a,button,summary,[role=button],[role=link],[role=menuitem],[tabindex]")}catch(_){actions=[]}for(var ai=0;ai<actions.length;ai++){var actionName=String(actions[ai].getAttribute("aria-label")||actions[ai].getAttribute("title")||"").replace(/\\s+/g," ").trim();if(text(actions[ai])===labelNeedle||actionName===labelNeedle)found.push(actions[ai])}}}}' +
        'if(p.ref){var referenced=ref(p.ref);if(referenced)found.push(referenced)}' +
        'var selector=String(p.selector||"").trim();var selectors=selector.split("||").map(function(s){return s.trim()}).filter(Boolean);if(!selectors.length&&!p.label)selectors=["*"];' +
        'for(var si=0;si<selectors.length&&!found.length&&!p.ref;si++){for(var r=0;r<scopes.length;r++){var list=[];try{list=scopes[r].querySelectorAll(selectors[si])}catch(e){throw new Error("无效选择器: "+selectors[si])}for(var j=0;j<list.length;j++)found.push(list[j])}}' +
        'if(p.textPattern){var re=new RegExp(p.textPattern,p.caseSensitive?"":"i");found=found.filter(function(el){return re.test(String(el.innerText||el.textContent||el.getAttribute("aria-label")||""))})}' +
        'if(p.text){var needle=p.caseSensitive?String(p.text):String(p.text).toLowerCase();found=found.filter(function(el){var t=text(el);if(!p.caseSensitive)t=t.toLowerCase();return p.exact?t===needle:t.indexOf(needle)!==-1});if(p.rankTextMatches){found=found.filter(function(el){return el!==document.documentElement&&el!==document.body}).map(function(el,index){var t=text(el);if(!p.caseSensitive)t=t.toLowerCase();return {el:el,index:index,visible:visible(el)?1:0,exact:t===needle?1:0,actionable:actionable(el)?1:0,extra:Math.max(0,t.length-needle.length),depth:depth(el)}}).sort(function(a,b){return b.visible-a.visible||b.exact-a.exact||b.actionable-a.actionable||a.extra-b.extra||b.depth-a.depth||a.index-b.index}).map(function(item){return item.el})}}' +
        'var seen=[];found=found.filter(function(el){if(excluded(el)||seen.indexOf(el)!==-1)return false;seen.push(el);return true});' +
        'if(p.relative){found=found.map(function(el){if(p.relative==="parent"){var root=el.getRootNode&&el.getRootNode();return el.parentElement||(root&&root.host)||null}if(p.relative==="prevSibling")return el.previousElementSibling;if(p.relative==="nextSibling")return el.nextElementSibling;return el}).filter(Boolean)}' +
        'return found.filter(function(el){return !excluded(el)});' +
      '})(' + JSON.stringify(locator || {}) + ')';
    }
    async function queryBackendNodes(send, locator, signal) {
      ensureNotAborted(signal);
      var contexts = await isolatedContexts(send, signal);
      var candidates = [];
      var queryErrors = [];
      var remoteNodeCount = 0;
      try {
        for (var contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
          ensureNotAborted(signal);
          var context = contexts[contextIndex];
          if (locator.frameId && String(locator.frameId) !== String(context.frameId)) continue;
          var contextSend = context.send || senderForFrame(send, context.frameId);
          var evaluateParams = {
            expression: remoteQueryExpression(locator),
            returnByValue: false, objectGroup: 'page-automation-query', silent: true,
          };
          if (Number(context.executionContextId) > 0) evaluateParams.contextId = context.executionContextId;
          var evaluated = await contextSend('Runtime.evaluate', evaluateParams, 10000);
          if (evaluated.exceptionDetails) throw evaluated.exceptionDetails;
          var arrayObjectId = evaluated.result && evaluated.result.objectId;
          if (!arrayObjectId) {
            queryErrors.push({ frameId: context.frameId, message: '页面查询没有返回节点数组' });
            continue;
          }
          var properties = await contextSend('Runtime.getProperties', { objectId: arrayObjectId, ownProperties: true }, 10000);
          var numeric = (properties.result || []).filter(function (item) { return /^\d+$/.test(String(item.name)) && item.value && item.value.objectId; })
            .sort(function (left, right) { return Number(left.name) - Number(right.name); });
          remoteNodeCount += numeric.length;
          for (var propertyIndex = 0; propertyIndex < numeric.length; propertyIndex += 1) {
            var described = await contextSend('DOM.describeNode', {
              objectId: numeric[propertyIndex].value.objectId, depth: 0, pierce: true,
            }, 5000);
            var backend = Number(described.node && described.node.backendNodeId) || 0;
            if (backend) candidates.push({ backendNodeId: backend, frameId: context.frameId });
          }
        }
        var unique = [];
        var seen = Object.create(null);
        candidates.forEach(function (candidate) {
          var key = candidate.frameId + ':' + candidate.backendNodeId;
          if (!seen[key]) { seen[key] = true; unique.push(candidate); }
        });
        if (!unique.length && (remoteNodeCount > 0 || queryErrors.length >= contexts.length)) {
          fail('PAGE_STATE_UNAVAILABLE', '页面元素查询失败', {
            locator: locator,
            remoteNodeCount: remoteNodeCount,
            errors: queryErrors.slice(0, 5),
          });
        }
        return unique;
      } finally {
        await Promise.all(contexts.map(function (context) {
          var contextSend = context.send || senderForFrame(send, context.frameId);
          // Release is best-effort cleanup. If the parent operation was
          // cancelled, the signal-aware wrapper intentionally refuses new
          // commands; use its raw routed sender so the remote object group is
          // still released when the transport remains available.
          var releaseSend = rawSender(contextSend);
          return releaseSend('Runtime.releaseObjectGroup', { objectGroup: 'page-automation-query' }, 5000).catch(function () {});
        }));
      }
    }
    function chooseCandidate(candidates, rawIndex) {
      if (!candidates.length) return null;
      if (String(rawIndex || '').toLowerCase() === 'random') return candidates[Math.floor(Math.random() * candidates.length)];
      var index = Number(rawIndex);
      if (!Number.isInteger(index) || index === 0) return candidates[0];
      if (index < 0) index = candidates.length + index;
      else index -= 1;
      return candidates[index] || null;
    }
    function attributesFromDescribe(node) {
      var attrs = {};
      var raw = node && node.attributes || [];
      for (var index = 0; index + 1 < raw.length; index += 2) attrs[String(raw[index])] = String(raw[index + 1]);
      return attrs;
    }
    function targetRefForContext(context, target) {
      return Object.freeze({
        documentId: String(context && context.documentId || ''),
        targetId: String(target && target.targetId || ''),
        frameId: String(target && target.frameId || ''),
        backendNodeId: Math.max(0, Math.floor(Number(target && target.backendNodeId) || 0)),
        fingerprint: String(target && target.fingerprint || ''),
      });
    }
    async function liveTarget(send, tabId, context, identity, locator, resolveOptions) {
      resolveOptions = resolveOptions || {};
      ensureNotAborted(resolveOptions.signal);
      var backendNodeId = Number(identity && identity.backendNodeId) || 0;
      var frameId = String(identity && identity.frameId || '');
      var targetId = String(identity && identity.targetId || targetIdFor(tabId, context && context.documentId, frameId, backendNodeId));
      var targetSend = senderForFrame(send, frameId);
      var described = await targetSend('DOM.describeNode', { backendNodeId: backendNodeId, depth: 0, pierce: true }, 5000);
      var resolved = await resolveBackendNodeWithSend(send, frameId, backendNodeId, 'page-automation-target');
      var objectId = resolved && resolved.object && resolved.object.objectId;
      if (!objectId) fail('TARGET_STALE', '目标节点无法解析', { targetId: targetId });
      try {
      var stateResponse = await targetSend('Runtime.callFunctionOn', {
        objectId: objectId,
        functionDeclaration: 'function(){var el=this;var s=getComputedStyle(el);var r=el.getBoundingClientRect();var a={};for(var i=0;i<el.attributes.length;i++)a[el.attributes[i].name]=el.attributes[i].value;var text=String(el.innerText||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,800),ariaChecked=el.getAttribute("aria-checked"),ariaSelected=el.getAttribute("aria-selected"),expanded=el.getAttribute("aria-expanded"),enabled=!(el.matches&&el.matches(":disabled"))&&!el.disabled&&el.getAttribute("aria-disabled")!=="true",editable=!el.readOnly&&el.getAttribute("aria-readonly")!=="true"&&(el.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)||/^(textbox|searchbox|combobox)$/.test(el.getAttribute("role")||""));return {connected:el.isConnected!==false,tag:(el.tagName||"").toLowerCase(),role:el.getAttribute("role")||"",name:el.getAttribute("aria-label")||el.getAttribute("alt")||el.getAttribute("title")||"",text:text,attributes:a,bounds:{x:r.left,y:r.top,width:r.width,height:r.height},visible:r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.visibility!=="collapse"&&Number(s.opacity)!==0,enabled:enabled,editable:enabled&&editable,value:el.isContentEditable?text:(("value" in el)?el.value:null),checked:("checked" in el)?!!el.checked:(ariaChecked==="true"?true:(ariaChecked==="false"?false:null)),selected:("selected" in el)?!!el.selected:(ariaSelected==="true"?true:(ariaSelected==="false"?false:null)),expanded:expanded==="true"?true:(expanded==="false"?false:null)}}',
        returnByValue: true, silent: true,
      }, 5000);
      ensureNotAborted(resolveOptions.signal);
      if (stateResponse && stateResponse.exceptionDetails) throw stateResponse.exceptionDetails;
      var live = stateResponse.result && stateResponse.result.value || {};
      if (live.connected === false) fail('TARGET_STALE', '目标节点已脱离文档', { targetId: targetId });
      var quads = { quads: [] };
      try { quads = await targetSend('DOM.getContentQuads', { backendNodeId: backendNodeId }, 5000); }
      catch (error) {
        if (resolveOptions.requireGeometry !== false) throw error;
      }
      var quad = quads.quads && quads.quads[0] || [];
      var geometry = await frameGeometry(send, frameId, context.viewport || {}, Object.create(null), resolveOptions.signal);
      var localQuadBounds = quadBounds(quad);
      var bounds = localQuadBounds
        ? transformBounds(localQuadBounds, geometry.transform || identityTransform())
        : (live.bounds ? transformBounds(factContract.normalizeBounds(live.bounds), geometry.transform || identityTransform()) : null);
      if ((!bounds || !(bounds.width > 0) || !(bounds.height > 0)) && resolveOptions.requireGeometry !== false) {
        // A node can exist in the DOM while its layout is still being built.
        // Its fallback rectangle is then commonly (0, 0, 0, 0); treating that
        // as a real action point would dispatch input at the viewport origin.
        fail('PAGE_STATE_UNAVAILABLE', '目标节点当前没有可用的可点击几何信息', {
          targetId: targetId,
          bounds: bounds,
        });
      }
      var viewportBounds = { x: 0, y: 0, width: Math.max(0, Number(context.viewport && context.viewport.width) || 0), height: Math.max(0, Number(context.viewport && context.viewport.height) || 0) };
      var frameBounds = geometry.bounds || null;
      var frameVisibleBounds = frameBounds ? intersectBounds(frameBounds, viewportBounds) : viewportBounds;
      var effectiveClip = geometry.clip || frameVisibleBounds;
      bounds = bounds || factContract.normalizeBounds({});
      var hasGeometry = bounds.width > 0 && bounds.height > 0;
      var visibleBounds = hasGeometry && effectiveClip ? intersectBounds(bounds, effectiveClip) : null;
      var actionBounds = visibleBounds || bounds;
      var actionPoint = hasGeometry ? { x: actionBounds.x + actionBounds.width / 2, y: actionBounds.y + actionBounds.height / 2 } : null;
      var normalized = normalizeCurrentTarget(tabId, context.documentId, {
        frameId: frameId, backendNodeId: backendNodeId, targetId: targetId,
        tag: live.tag || described.node && described.node.nodeName && String(described.node.nodeName).toLowerCase(),
        role: live.role,
        name: compact(live.name, 500), text: compact(live.text, 800),
        attributes: live.attributes || attributesFromDescribe(described.node), bounds: bounds,
        visible: live.visible === true, inViewport: !!visibleBounds, occluded: null,
        enabled: live.enabled !== false, editable: live.editable === true,
        value: live.value, checked: live.checked, selected: live.selected, expanded: live.expanded,
        locator: factContract.normalizeLocator(locator),
        evidence: { sources: ['DOM.describeNode', 'DOM.getContentQuads', 'Runtime.callFunctionOn'], capturedAt: new Date().toISOString() },
      });
      return {
        context: context,
        target: normalized,
        targetRef: targetRefForContext(context, normalized),
        coordinates: actionPoint ? { x: actionPoint.x, y: actionPoint.y } : null,
        actionBounds: hasGeometry ? factContract.normalizeBounds(actionBounds) : null,
      };
      } finally {
        await rawSender(targetSend)('Runtime.releaseObjectGroup', { objectGroup: 'page-automation-target' }, 5000).catch(function () {});
      }
    }
    async function resolveTargetWithSend(send, tabId, locator, resolveOptions) {
      locator = locator || {};
      resolveOptions = resolveOptions || {};
      // ActionEngine callers pass a deadline sender plus a separate signal.
      // Wrap the sender here as well so target resolution, including nested
      // frame/Runtime calls, stops promptly when the parent operation is
      // cancelled instead of waiting for an individual CDP timeout.
      send = signalSender(send, resolveOptions.signal);
      ensureNotAborted(resolveOptions.signal);
      // Target resolution has one source of truth: the current CDP document.
      var current = await getDocumentContextWithSend(send, tabId, resolveOptions);
      ensureNotAborted(resolveOptions.signal);
      var targetRef = resolveOptions.targetRef || locator.targetRef;
      var identity = null;
      var candidateCount = 1;
      if (targetRef) {
        if (String(targetRef.documentId || '') !== String(current.documentId || '')) {
          fail('TARGET_STALE', '目标引用所属页面已经变化', { targetRef: targetRef, currentDocumentId: current.documentId });
        }
        identity = targetIdentity(tabId, current.documentId, {
          frameId: targetRef.frameId,
          backendNodeId: targetRef.backendNodeId,
        });
        if (!identity) fail('TARGET_STALE', '目标引用缺少 CDP 节点身份', { targetRef: targetRef });
      } else {
        var candidates = await queryBackendNodes(send, {
          selector: locator.selector || (locator.label ? '' : '*'), textPattern: locator.textPattern || '',
          text: locator.textSelector || locator.text || '', exact: locator.exact === true, caseSensitive: locator.caseSensitive === true,
          rankTextMatches: !locator.selector && !locator.label && !!(locator.textSelector || locator.text),
          ref: locator.ref || '', label: locator.label || '', scopeSelector: locator.scopeSelector || '', scopeRef: locator.scopeRef || '', frameId: locator.frameId || '',
        }, resolveOptions.signal);
        candidateCount = candidates.length;
        if (Number(locator.minCount) > 0 && candidates.length < Number(locator.minCount)) return { count: candidates.length, missing: true };
        var chosen = chooseCandidate(candidates, locator.elementIndex !== undefined ? locator.elementIndex : locator.index);
        if (!chosen) fail('TARGET_NOT_FOUND', '未找到目标元素', { locator: locator, count: candidates.length });
        identity = targetIdentity(tabId, current.documentId, chosen);
      }
      if (locator.relative && /^(?:parent|prevSibling|nextSibling)$/.test(String(locator.relative))) {
        ensureNotAborted(resolveOptions.signal);
        var relativeSend = senderForFrame(send, identity.frameId);
        var sourceNode = await relativeSend('DOM.resolveNode', { backendNodeId: Number(identity.backendNodeId), objectGroup: 'page-automation-relative' }, 5000);
        ensureNotAborted(resolveOptions.signal);
        var sourceObjectId = sourceNode && sourceNode.object && sourceNode.object.objectId;
        if (!sourceObjectId) fail('TARGET_STALE', '目标节点无法用于相对定位', { targetId: identity.targetId, relative: locator.relative });
        var relativeFunction = locator.relative === 'parent'
          ? 'function(){var root=this.getRootNode&&this.getRootNode();return this.parentElement||(root&&root.host)||null}'
          : (locator.relative === 'prevSibling' ? 'function(){return this.previousElementSibling}' : 'function(){return this.nextElementSibling}');
        var relativeResult = await relativeSend('Runtime.callFunctionOn', {
          objectId: sourceObjectId,
          functionDeclaration: relativeFunction,
          returnByValue: false,
          objectGroup: 'page-automation-relative',
        }, 5000);
        ensureNotAborted(resolveOptions.signal);
        if (relativeResult && relativeResult.exceptionDetails) throw relativeResult.exceptionDetails;
        var relativeObjectId = relativeResult.result && relativeResult.result.objectId;
        if (!relativeObjectId || relativeResult.result.subtype === 'null') {
          await rawSender(relativeSend)('Runtime.releaseObjectGroup', { objectGroup: 'page-automation-relative' }, 5000).catch(function () {});
          fail('TARGET_NOT_FOUND', '相对目标不存在', { targetId: identity.targetId, relative: locator.relative });
        }
        var relativeBackendNodeId = 0;
        try {
          var describedRelative = await relativeSend('DOM.describeNode', { objectId: relativeObjectId, depth: 0, pierce: true }, 5000);
          relativeBackendNodeId = Number(describedRelative.node && describedRelative.node.backendNodeId) || 0;
        } finally {
          await rawSender(relativeSend)('Runtime.releaseObjectGroup', { objectGroup: 'page-automation-relative' }, 5000).catch(function () {});
        }
        ensureNotAborted(resolveOptions.signal);
        if (!relativeBackendNodeId) fail('TARGET_NOT_FOUND', '相对目标无法映射为页面节点', { targetId: identity.targetId, relative: locator.relative });
        identity = targetIdentity(tabId, current.documentId, {
          frameId: identity.frameId,
          backendNodeId: relativeBackendNodeId,
        });
      }
      var liveResult = await liveTarget(send, tabId, current, identity, locator, resolveOptions);
      ensureNotAborted(resolveOptions.signal);
      liveResult.count = candidateCount;
      return liveResult;
    }
    function waitForTargetWithSend(send, tabId, locator, waitOptions) {
      locator = locator || {};
      waitOptions = waitOptions || {};
      var timeoutMs = Math.max(0, Math.min(Number(waitOptions.timeoutMs) || 0, 120000));
      var pollIntervalMs = Math.max(25, Math.min(Number(waitOptions.pollIntervalMs) || 100, 2000));
      var deadline = Date.now() + timeoutMs;
      function attempt() {
        ensureNotAborted(waitOptions.signal);
        return resolveTargetWithSend(send, tabId, locator, {
          targetRef: waitOptions.targetRef || locator.targetRef || null,
          requireGeometry: waitOptions.requireGeometry !== false,
          signal: waitOptions.signal,
        }).then(function (resolved) {
          var waitingForVisible = waitOptions.visible === true && resolved && resolved.target && resolved.target.visible !== true;
          if (!resolved || resolved.missing || waitingForVisible) {
            var error = new factContract.PageFactError('TARGET_NOT_FOUND', waitingForVisible ? '等待的元素仍不可见' : '等待元素数量未达到要求', {
              locator: locator,
              count: resolved && resolved.count || 0,
              minCount: locator.minCount,
            });
            if (Date.now() >= deadline) throw error;
            return abortableDelay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), waitOptions.signal).then(attempt);
          }
          return resolved;
        }, function (error) {
          var code = String(error && error.code || '');
          var retryable = code === 'TARGET_NOT_FOUND' || waitOptions.retryUnavailable === true && code === 'PAGE_STATE_UNAVAILABLE';
          if (!retryable || Date.now() >= deadline) throw error;
          return abortableDelay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), waitOptions.signal).then(attempt);
        });
      }
      return attempt();
    }
    function resolveTarget(tabId, locator, resolveOptions) {
      tabId = Math.floor(Number(tabId));
      resolveOptions = resolveOptions || {};
      return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.resolveTarget', type: 'short', signal: resolveOptions.signal || null }, function (send) {
        send = signalSender(send, resolveOptions.signal);
        return resolveTargetWithSend(send, tabId, locator || {}, resolveOptions);
      });
    }
    async function resolveFocusedTargetWithSend(send, tabId, signal) {
      send = signalSender(send, signal);
      ensureNotAborted(signal);
      var documentContext = await getDocumentContextWithSend(send, tabId, { signal: signal });
      var contexts = await isolatedContexts(send, signal);
      var candidates = [];
      for (var contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
        ensureNotAborted(signal);
        var queryContext = contexts[contextIndex];
        var contextSend = queryContext.send || senderForFrame(send, queryContext.frameId);
        var objectGroup = 'page-automation-focused-target';
        try {
          var focused = await contextSend('Runtime.evaluate', {
            expression: '(function(){var active=document.activeElement;while(active&&active.shadowRoot&&active.shadowRoot.activeElement)active=active.shadowRoot.activeElement;if(!active||active===document.body||active===document.documentElement)return null;return active})()',
            contextId: queryContext.executionContextId,
            returnByValue: false,
            objectGroup: objectGroup,
            silent: true,
          }, 5000);
          ensureNotAborted(signal);
          if (focused && focused.exceptionDetails) throw focused.exceptionDetails;
          var objectId = focused.result && focused.result.objectId;
          if (!objectId || focused.result.subtype === 'null') continue;
          var requested = await contextSend('DOM.requestNode', { objectId: objectId }, 5000);
          var described = await contextSend('DOM.describeNode', { nodeId: requested.nodeId, depth: 0, pierce: true }, 5000);
          ensureNotAborted(signal);
          var backendNodeId = Number(described.node && described.node.backendNodeId) || 0;
          if (!backendNodeId) continue;
          candidates.push({
            frameId: queryContext.frameId,
            backendNodeId: backendNodeId,
            depth: Number(queryContext.depth) || 0,
            node: described.node || {},
          });
        } finally {
          await rawSender(contextSend)('Runtime.releaseObjectGroup', { objectGroup: objectGroup }, 5000).catch(function () {});
        }
      }
      candidates.sort(function (left, right) { return right.depth - left.depth; });
      if (!candidates.length) fail('TARGET_NOT_FOUND', '页面当前没有可记录的焦点目标', { tabId: tabId });
      var focusedCandidate = candidates[0];
      var identity = targetIdentity(tabId, documentContext.documentId, focusedCandidate);
      return liveTarget(send, tabId, documentContext, identity, {}, { signal: signal });
    }
    async function readTargetOptionsWithSend(send, resolved, signal) {
      send = signalSender(send, signal);
      ensureNotAborted(signal);
      if (!resolved || !resolved.target) fail('TARGET_NOT_FOUND', '读取选项需要有效目标');
      var targetSend = senderForFrame(send, resolved.target.frameId);
      var node = await targetSend('DOM.resolveNode', { backendNodeId: resolved.target.backendNodeId, objectGroup: 'page-perception-options' }, 5000);
      ensureNotAborted(signal);
      var objectId = node && node.object && node.object.objectId;
      if (!objectId) fail('TARGET_STALE', '选择目标已经失效', { targetRef: resolved.targetRef });
      try {
        var response = await targetSend('Runtime.callFunctionOn', {
          objectId: objectId,
          functionDeclaration: 'function(){return {tag:(this.tagName||"").toLowerCase(),selectedIndex:Number(this.selectedIndex),options:Array.from(this.options||[]).map(function(o,i){return {index:i,text:String(o.textContent||o.label||"").replace(/\\s+/g," ").trim(),value:o.value,disabled:!!o.disabled,selected:!!o.selected}})}}',
          returnByValue: true,
        }, 5000);
        ensureNotAborted(signal);
        if (response.exceptionDetails) throw response.exceptionDetails;
        return response.result && response.result.value || { tag: resolved.target.tag, options: [], selectedIndex: -1 };
      } finally {
        await rawSender(targetSend)('Runtime.releaseObjectGroup', { objectGroup: 'page-perception-options' }, 5000).catch(function () {});
      }
    }
    async function readScrollInfoWithSend(send, tabId, input) {
      input = input || {};
      send = signalSender(send, input.signal);
      ensureNotAborted(input.signal);
      var thresholdPx = Math.max(1, Number(input.thresholdPx) || 2);
      var targetRef = input.containerTargetRef || null;
      var containerSelector = String(input.containerSelector || '').trim();
      if (!targetRef && !containerSelector) {
        fail('ACTION_INVALID', '读取滚动事实必须指定容器；整个页面使用 containerLocator {"selector":"html"} 或 containerSelector "html"');
      }
      var objectId = '';
      var resolvedTarget = null;
      if (targetRef) {
        resolvedTarget = await resolveTargetWithSend(send, tabId, {}, { targetRef: targetRef, signal: input.signal });
        var node = await senderForFrame(send, resolvedTarget.target.frameId)('DOM.resolveNode', { backendNodeId: resolvedTarget.target.backendNodeId, objectGroup: 'page-perception-scroll' }, 5000);
        ensureNotAborted(input.signal);
        objectId = node && node.object && node.object.objectId || '';
        if (!objectId) fail('TARGET_STALE', '滚动容器目标已经失效', { targetRef: targetRef });
      }
      var scrollInfoFunction = 'function(threshold){var source=this,root=document.scrollingElement||document.documentElement,isDocument=source===document.documentElement||source===root,el=isDocument?root:source,r=isDocument?{left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight}:source.getBoundingClientRect(),left=Number(r.left)||0,top=Number(r.top)||0,right=Number(r.right),bottom=Number(r.bottom);if(!Number.isFinite(right))right=left+(Number(r.width)||0);if(!Number.isFinite(bottom))bottom=top+(Number(r.height)||0);if(!isDocument){for(var parent=source.parentElement;parent;parent=parent.parentElement){var style=getComputedStyle(parent),pr=parent.getBoundingClientRect();if(/^(?:hidden|clip|auto|scroll)$/.test(style.overflowX)){left=Math.max(left,pr.left);right=Math.min(right,pr.right)}if(/^(?:hidden|clip|auto|scroll)$/.test(style.overflowY)){top=Math.max(top,pr.top);bottom=Math.min(bottom,pr.bottom)}}left=Math.max(0,left);top=Math.max(0,top);right=Math.min(innerWidth,right);bottom=Math.min(innerHeight,bottom)}var width=Math.max(0,right-left),height=Math.max(0,bottom-top),remainingTop=Math.max(0,el.scrollHeight-el.clientHeight-el.scrollTop),remainingLeft=Math.max(0,el.scrollWidth-el.clientWidth-el.scrollLeft);return {scrollTop:el.scrollTop,scrollLeft:el.scrollLeft,scrollHeight:el.scrollHeight,scrollWidth:el.scrollWidth,clientHeight:el.clientHeight,viewportHeight:el.clientHeight,clientWidth:el.clientWidth,viewportWidth:el.clientWidth,maxTop:Math.max(0,el.scrollHeight-el.clientHeight),maxLeft:Math.max(0,el.scrollWidth-el.clientWidth),remainingPx:remainingTop,atTop:el.scrollTop<=threshold,atBottom:remainingTop<=threshold,atLeft:el.scrollLeft<=threshold,atRight:remainingLeft<=threshold,scrollableY:el.scrollHeight>el.clientHeight,scrollableX:el.scrollWidth>el.clientWidth,documentScroller:isDocument,x:left+width/2,y:top+height/2,bounds:{x:left,y:top,width:width,height:height}}}';
      try {
        var response;
        if (objectId) {
          response = await senderForFrame(send, resolvedTarget.target.frameId)('Runtime.callFunctionOn', {
            objectId: objectId,
            functionDeclaration: scrollInfoFunction,
            arguments: [{ value: thresholdPx }],
            returnByValue: true,
          }, 5000);
        } else {
          response = await send('Runtime.evaluate', {
            expression: '(function(s,index,threshold,read){var list=document.querySelectorAll(s),i=Number(index);if(!Number.isInteger(i)||i===0)i=0;else if(i<0)i=list.length+i;else i-=1;var source=list[i]||null;return source?read.call(source,threshold):null})(' + JSON.stringify(containerSelector) + ',' + JSON.stringify(input.containerIndex) + ',' + JSON.stringify(thresholdPx) + ',' + scrollInfoFunction + ')',
            returnByValue: true,
          }, 5000);
        }
        ensureNotAborted(input.signal);
        if (response.exceptionDetails) throw response.exceptionDetails;
        var value = response.result && response.result.value || null;
        if (!value) fail('TARGET_NOT_FOUND', '滚动容器不存在', { containerSelector: containerSelector, targetRef: targetRef });
        if (value && resolvedTarget) {
          var documentContext = resolvedTarget.context || {};
          var geometry = await frameGeometry(send, resolvedTarget.target.frameId, documentContext.viewport || {}, Object.create(null), input.signal);
          ensureNotAborted(input.signal);
          var transformedBounds = transformBounds(factContract.normalizeBounds(value.bounds), geometry.transform || identityTransform());
          var viewportBounds = {
            x: 0, y: 0,
            width: Math.max(0, Number(documentContext.viewport && documentContext.viewport.width) || 0),
            height: Math.max(0, Number(documentContext.viewport && documentContext.viewport.height) || 0),
          };
          var visibleBounds = intersectBounds(transformedBounds, geometry.clip || viewportBounds);
          value.bounds = factContract.normalizeBounds(visibleBounds || transformedBounds);
          value.x = value.bounds.x + value.bounds.width / 2;
          value.y = value.bounds.y + value.bounds.height / 2;
          value.targetRef = resolvedTarget.targetRef;
        }
        ensureNotAborted(input.signal);
        return value;
      } finally {
        if (objectId) await rawSender(senderForFrame(send, resolvedTarget.target.frameId))('Runtime.releaseObjectGroup', { objectGroup: 'page-perception-scroll' }, 5000).catch(function () {});
      }
    }

    async function domRefForResolvedTarget(send, resolved, signal) {
      send = signalSender(send, signal);
      ensureNotAborted(signal);
      if (!resolved || !resolved.target) fail('TARGET_STALE', '页面读取目标已经失效');
      var objectGroup = 'page-perception-read-target';
      var targetSend = senderForFrame(send, resolved.target.frameId);
      try {
        var node = await targetSend('DOM.resolveNode', {
          backendNodeId: resolved.target.backendNodeId,
          objectGroup: objectGroup,
        }, 5000);
        ensureNotAborted(signal);
        var objectId = node && node.object && node.object.objectId;
        if (!objectId) fail('TARGET_STALE', '页面读取目标无法解析', { targetRef: resolved.targetRef });
        var response = await targetSend('Runtime.callFunctionOn', {
          objectId: objectId,
          functionDeclaration: 'function(){var el=this,parts=[];while(el){if(el===el.ownerDocument.body){parts.unshift("body");break}if(el===el.ownerDocument.documentElement){parts.unshift("html");break}var parent=el.parentElement;if(parent){parts.unshift("child:"+Array.prototype.indexOf.call(parent.children,el));el=parent;continue}var root=el.getRootNode&&el.getRootNode();if(root&&root.host){parts.unshift("child:"+Array.prototype.indexOf.call(root.children,el));parts.unshift("shadow");el=root.host;continue}return ""}return parts.join("/")}',
          returnByValue: true,
          silent: true,
        }, 5000);
        ensureNotAborted(signal);
        if (response && response.exceptionDetails) throw response.exceptionDetails;
        var path = String(response.result && response.result.value || '');
        if (!path) fail('PAGE_STATE_UNAVAILABLE', '页面读取目标无法建立稳定 DOM 路径', { targetRef: resolved.targetRef });
        return path;
      } finally {
        await rawSender(targetSend)('Runtime.releaseObjectGroup', { objectGroup: objectGroup }, 5000).catch(function () {});
      }
    }

    function pageFunctionSource(kind, params) {
      return '(function(p){' +
        'function ownUi(el){return !!(el&&el.getAttribute&&(el.hasAttribute("data-page-automation-ui")||/^page-automation-/.test(String(el.id||""))))}' +
        'function nonContent(el){var tag=String(el&&el.tagName||"").toLowerCase();return /^(?:head|style|script|noscript|template|meta|link|base|title)$/.test(tag)}' +
        'function excluded(el){var cur=el;while(cur){if(ownUi(cur)||nonContent(cur))return true;var root=cur.getRootNode&&cur.getRootNode();cur=cur.parentElement||(root&&root.host)||null}return false}' +
        'function stylesheetExcluded(sheet){if(!sheet)return true;var href=String(sheet.href||"");if(/^(?:chrome|moz|safari|edge)-extension:|^extension:/i.test(href))return true;var owner=sheet.ownerNode;while(owner){if(ownUi(owner))return true;var ownerRoot=owner.getRootNode&&owner.getRootNode();owner=owner.parentElement||(ownerRoot&&ownerRoot.host)||null}return false}' +
        'function roots(root,out){out.push(root);var all=[];try{all=root.querySelectorAll("*")}catch(_){all=[]}for(var i=0;i<all.length;i++)if(!excluded(all[i])&&all[i].shadowRoot)roots(all[i].shadowRoot,out)}' +
        'function queryAll(selector){var rs=[];roots(document,rs);var out=[],seen=[];var selectors=String(selector||"*").split("||").map(function(s){return s.trim()}).filter(Boolean);if(!selectors.length)selectors=["*"];for(var si=0;si<selectors.length;si++)for(var i=0;i<rs.length;i++){var list=[];try{list=rs[i].querySelectorAll(selectors[si])}catch(e){throw new Error("无效选择器: "+selectors[si])}for(var j=0;j<list.length;j++)if(!excluded(list[j])&&seen.indexOf(list[j])===-1){seen.push(list[j]);out.push(list[j])}}return out}' +
        'function one(selector,index){var list=queryAll(selector||"body");index=Number(index);if(!Number.isInteger(index)||index===0)return list[0]||null;if(index<0)index=list.length+index;else index-=1;return list[index]||null}' +
        'function txt(el){if(!el||excluded(el))return "";return String(el.innerText||el.textContent||"").replace(/\\s+/g," ").trim()}' +
        'function rect(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom}}' +
        'function visible(el){if(!el||el.isConnected===false)return false;var s=getComputedStyle(el),r=el.getBoundingClientRect();return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.visibility!=="collapse"&&Number(s.opacity)!==0}' +
        'function resolveRef(path){var parts=String(path||"").split("/").filter(Boolean),cur=null;if(!parts.length)return null;var first=parts.shift();if(first==="html")cur=document.documentElement;else if(first==="body")cur=document.body;else return null;for(var i=0;i<parts.length&&cur;i++){var part=parts[i];if(part==="shadow")cur=cur.shadowRoot;else if(/^child:\\d+$/.test(part))cur=(cur.children||[])[Number(part.slice(6))]||null;else return null}return cur}' +
        'function refOf(el){if(!el||el.nodeType!==1)return "";var parts=[];while(el){if(el===document.body){parts.unshift("body");break}if(el===document.documentElement){parts.unshift("html");break}var parent=el.parentElement;if(parent){parts.unshift("child:"+Array.prototype.indexOf.call(parent.children,el));el=parent;continue}var root=el.getRootNode&&el.getRootNode();if(root&&root.host){parts.unshift("child:"+Array.prototype.indexOf.call(root.children,el));parts.unshift("shadow");el=root.host;continue}return ""}return parts.join("/")}' +
        'function candidates(p,fallback){var list=p.ref?[resolveRef(p.ref)].filter(Boolean):queryAll(p.selector||fallback||"body");if(p.textPattern){var re=new RegExp(String(p.textPattern),p.caseSensitive?"":"i");list=list.filter(function(el){return re.test(txt(el))})}else if(p.text){var needle=p.caseSensitive?String(p.text):String(p.text).toLowerCase();list=list.filter(function(el){var t=p.caseSensitive?txt(el):txt(el).toLowerCase();return p.exact?t===needle:t.indexOf(needle)!==-1})}return list}' +
        'function target(p,fallback){var list=candidates(p,fallback),index=Number(p.elementIndex);if(!Number.isInteger(index)||index===0)return list[0]||null;if(index<0)index=list.length+index;else index-=1;return list[index]||null}' +
        'function value(el,attr){if(!el)return null;if(attr==="text")return txt(el);if(attr==="innerText")return el.innerText;if(attr==="textContent")return el.textContent;if(attr==="html")return el.innerHTML;if(attr==="outerHTML")return el.outerHTML;if(attr==="value")return "value" in el?el.value:null;if(attr==="checked")return "checked" in el?!!el.checked:null;if(attr==="href")return el.href||el.getAttribute("href");return el.getAttribute(attr)}' +
        'function parseFields(raw){if(Array.isArray(raw))return raw;if(typeof raw!=="string")return [];return raw.split(/\\r?\\n/).map(function(line){var s=line.split("|");return {key:s[0],selector:s[1]||".",attr:s[2]||"text"}}).filter(function(f){return f.key})}' +
        'function paginateText(text){return String(text||"")}' +
        'var kind=' + JSON.stringify(kind) + ';' +
        'if(kind==="extractText"){var list=candidates(p,"body"),attr=p.attr==="attribute"?p.attributeName:(p.attr||"text");function read(el){if(!el)return null;if(p.childSelector){var children=Array.from(el.querySelectorAll(p.childSelector));return children.map(function(child){return value(child,attr)}).join(p.childSeparator===undefined?"\\n":String(p.childSeparator))}return value(el,attr)}if(!p.all)return read(target(p,"body"));return list.map(read)}' +
        'if(kind==="elementInfo"){var list=candidates(p,"body"),el=target(p,"body"),attrs=el?Array.from(el.attributes).reduce(function(o,a){o[a.name]=a.value;return o},{}):{};return {exists:!!el,count:list.length,visible:visible(el),text:txt(el),value:el&&(el.isContentEditable?txt(el):("value" in el)?el.value:null),checked:el&&("checked" in el)?!!el.checked:null,bounds:rect(el),tagName:el?(el.tagName||"").toLowerCase():"",role:el?el.getAttribute("role")||"":"",attributes:attrs,ref:refOf(el),framework:"",selectors:el?{id:el.id?"#"+el.id:"",name:attrs.name?"[name=\\\""+attrs.name+"\\\"]":"",ref:refOf(el)}:{}}}' +
        'if(kind==="extractTable"){var table=target(p,"table");if(!table)return null;var rows=Array.from(table.querySelectorAll("tr"));var headers=[],headerRow=null;if(p.headerMode==="firstRow")headerRow=rows[0]||null;else if(p.headerMode!=="none")headerRow=table.querySelector("thead tr")||rows.find(function(row){return !!row.querySelector("th")})||null;if(headerRow)headers=Array.from(headerRow.children).map(txt);var data=rows.filter(function(row){return row!==headerRow}).map(function(row){var cells=Array.from(row.children).map(txt);if(!headers.length)return cells;var o={};cells.forEach(function(cell,i){o[headers[i]||("col"+i)]=cell});return o});if(Number(p.maxRows)>0)data=data.slice(0,Number(p.maxRows));return {headers:headers,rows:data,rowCount:data.length}}' +
        'if(kind==="extractList"){var selector=p.itemSelector;if(!selector&&p.autoDetect!==false){var candidates=["article","li","tr","[role=listitem]","[data-id]"];for(var ci=0;ci<candidates.length;ci++){if(queryAll(candidates[ci]).length>1){selector=candidates[ci];break}}}if(!selector){if(p.autoDetect===false)throw new Error("未启用列表自动检测时必须提供 itemSelector");return {itemSelector:"",items:[],count:0}}var items=queryAll(selector),fields=parseFields(p.fields);if(Number(p.maxItems)>0)items=items.slice(0,Number(p.maxItems));return {itemSelector:selector,items:items.map(function(item){if(!fields.length)return {text:txt(item)};var o={};fields.forEach(function(f){var el=f.selector==="."?item:item.querySelector(f.selector);o[f.key]=value(el,f.attr)});return o}),count:items.length}}' +
        'if(kind==="inspectText"){var el=target(p,"body");return txt(el)}' +
        'if(kind==="inspectHtml"){var el=target(p,"html");return el?(p.outer===true?el.outerHTML:el.innerHTML):""}' +
        'if(kind==="inspectCss"){if(!p.selector&&!p.ref&&!p.properties){var chunks=[];Array.from(document.styleSheets||[]).forEach(function(sheet){if(stylesheetExcluded(sheet))return;try{Array.from(sheet.cssRules||[]).forEach(function(rule){var css=String(rule.cssText||"");if(/WXT\\s+Shadow\\s+Root\\s+Reset|page-automation-/i.test(css))return;chunks.push(css)})}catch(_){if(!stylesheetExcluded(sheet))chunks.push("/* unreadable stylesheet: "+String(sheet.href||"inline")+" */")}});return {mode:"stylesheets",content:chunks.join("\\n")}}var el=target(p,"html");if(!el)return {mode:"computed",computed:{}};var cs=getComputedStyle(el),props=String(p.properties||"").split(/[,\\s]+/).filter(Boolean);if(!props.length)props=["display","visibility","position","z-index","width","height","color","background-color","font-size","overflow","pointer-events"];var out={};props.forEach(function(name){out[name]=cs.getPropertyValue(name)});return {mode:"computed",computed:out,ref:refOf(el)}}' +
        'if(kind==="inspectJavascript"){var keys=String(p.globalKeys||"").split(/[,\\s]+/).filter(Boolean),items=[];keys.forEach(function(k){try{var v=window[k];items.push({kind:"global",name:k,valueType:typeof v,summary:typeof v==="string"?v.slice(0,500):Array.isArray(v)?("Array("+v.length+")"):v&&typeof v==="object"?Object.keys(v).slice(0,50):v})}catch(e){items.push({kind:"global",name:k,error:e.message})}});Object.keys(localStorage).forEach(function(k){items.push({kind:"localStorage-key",name:k})});Object.keys(sessionStorage).forEach(function(k){items.push({kind:"sessionStorage-key",name:k})});Array.from(document.scripts).slice(0,500).forEach(function(s,i){items.push({kind:"script",index:i,src:s.src||"",inlineChars:s.src?0:(s.textContent||"").length})});return {frameworks:[],location:{url:location.href,title:document.title,readyState:document.readyState},items:items}}' +
        'if(kind==="inspectStructure"){var root=target(p,"body");if(!root||excluded(root))return [];var maxDepth=Math.max(0,Math.min(Number(p.maxDepth)||4,12)),items=[];function walk(el,d,parentRef){if(items.length>=5000||excluded(el))return;var isVisible=visible(el);if(p.mode!=="all"&&!isVisible)return;var currentRef=refOf(el),o={depth:d,parentRef:parentRef||"",ref:currentRef,tag:(el.tagName||"").toLowerCase(),id:el.id||"",className:typeof el.className==="string"?el.className:"",role:el.getAttribute("role")||"",name:el.getAttribute("aria-label")||"",text:txt(el).slice(0,300),visible:isVisible,bounds:rect(el)};if(p.mode!=="interactive"||/^(?:a|button|input|textarea|select|option|summary)$/.test(o.tag)||o.role||el.tabIndex>=0)items.push(o);if(d<maxDepth){var kids=Array.from(el.children||[]);if(el.shadowRoot)kids=kids.concat(Array.from(el.shadowRoot.children||[]));kids.filter(function(k){return !excluded(k)}).slice(0,500).forEach(function(k){walk(k,d+1,currentRef)})}}walk(root,0,"");return items}' +
        'if(kind==="searchPage"){var q=String(p.query||""),flags=p.caseSensitive?"":"i",re=p.regex?new RegExp(q,flags):null,needle=p.caseSensitive?q:q.toLowerCase(),hits=[],types=String(p.types||"text,element,html,css,script").split(/[,\\s]+/);function wanted(t){return !types[0]||types.indexOf(t)!==-1}function matches(value){var s=String(value||""),hay=p.caseSensitive?s:s.toLowerCase();return re?re.test(s):hay.indexOf(needle)!==-1}candidates(p,"*").forEach(function(el){if(!p.includeHidden&&!visible(el))return;var t=txt(el),html=el.outerHTML||"",ref=refOf(el),base={tag:(el.tagName||"").toLowerCase(),ref:ref,bounds:rect(el)};if(wanted("text")&&matches(t))hits.push({where:{type:"text",ref:ref},match:q,snippet:t.slice(0,Math.max(40,Number(p.contextChars)||120)),element:base,ref:ref});if(wanted("html")&&matches(html))hits.push({where:{type:"html",ref:ref},match:q,snippet:html.slice(0,Math.max(40,Number(p.contextChars)||120)),element:base,ref:ref});else if(wanted("element")&&matches((el.tagName||"")+" "+Array.from(el.attributes||[]).map(function(a){return a.name+"="+a.value}).join(" ")))hits.push({where:{type:"element",ref:ref},match:q,snippet:(el.outerHTML||"").slice(0,Math.max(40,Number(p.contextChars)||120)),element:base,ref:ref})});if(wanted("css"))Array.from(document.styleSheets||[]).forEach(function(sheet){if(stylesheetExcluded(sheet))return;try{Array.from(sheet.cssRules||[]).forEach(function(rule,i){var css=String(rule.cssText||"");if(/WXT\\s+Shadow\\s+Root\\s+Reset|page-automation-/i.test(css))return;if(matches(css))hits.push({where:{type:"css",href:sheet.href||"",index:i},match:q,snippet:css.slice(0,Math.max(40,Number(p.contextChars)||120))})})}catch(_){}});if(wanted("script"))Array.from(document.scripts||[]).forEach(function(script,i){var source=script.src||script.textContent||"";if(matches(source))hits.push({where:{type:"script",index:i,src:script.src||""},match:q,snippet:String(source).slice(0,Math.max(40,Number(p.contextChars)||120))})});return {query:q,hits:hits.slice(0,5000),count:hits.length}}' +
        'if(kind==="scrollInfo"){var source=p.containerSelector?one(p.containerSelector,0):null;if(!source)return null;var el=source===document.documentElement&&document.scrollingElement?document.scrollingElement:source,threshold=Math.max(1,Number(p.thresholdPx)||1),remaining=Math.max(0,el.scrollHeight-el.clientHeight-el.scrollTop);return {scrollTop:el.scrollTop,scrollLeft:el.scrollLeft,scrollHeight:el.scrollHeight,scrollWidth:el.scrollWidth,clientHeight:el.clientHeight,clientWidth:el.clientWidth,viewportHeight:el.clientHeight,viewportWidth:el.clientWidth,maxTop:Math.max(0,el.scrollHeight-el.clientHeight),remainingPx:remaining,scrollable:el.scrollHeight>el.clientHeight||el.scrollWidth>el.clientWidth,atTop:el.scrollTop<=threshold,atBottom:remaining<=threshold,bounds:rect(source)}}' +
        'if(kind==="webStorage"){var s=p.storageType==="session"?sessionStorage:localStorage;if(p.key)return {key:p.key,value:s.getItem(p.key)};var out={};for(var si=0;si<s.length;si++){var sk=s.key(si);out[sk]=s.getItem(sk)}return {entries:out}}' +
        'if(kind==="media"){function selector(el){if(el.id)return "#"+(window.CSS&&window.CSS.escape?window.CSS.escape(el.id):el.id);var parts=[];while(el&&el.nodeType===1&&parts.length<8){var tag=(el.tagName||"").toLowerCase(),n=1,s=el;while((s=s.previousElementSibling))if(s.tagName===el.tagName)n++;parts.unshift(tag+":nth-of-type("+n+")");el=el.parentElement}return parts.join(" > ")}function urls(value){var out=[],re=/url\\(\\s*([\"\\x27]?)(.*?)\\1\\s*\\)/gi,m;while((m=re.exec(String(value||""))))if(m[2])out.push(m[2]);return out}var out=[];queryAll("*").forEach(function(el){if(!visible(el))return;var tag=(el.tagName||"").toLowerCase();if(/^(?:img|video|canvas|svg|iframe)$/.test(tag))out.push({kind:tag,selector:selector(el),name:el.getAttribute("alt")||el.getAttribute("aria-label")||el.getAttribute("title")||tag,currentSrc:el.currentSrc||el.src||"",mimeHint:"",naturalWidth:el.naturalWidth||el.videoWidth||el.width||0,naturalHeight:el.naturalHeight||el.videoHeight||el.height||0,bounds:rect(el),visible:true,sourceReadable:tag==="img"&&!!(el.currentSrc||el.src),renderedReadable:true});urls(getComputedStyle(el).backgroundImage).forEach(function(url){var absolute="";try{absolute=new URL(url,document.baseURI).href}catch(_){absolute=url}out.push({kind:"css-background",selector:selector(el),name:el.getAttribute("aria-label")||el.getAttribute("title")||"CSS background image",currentSrc:absolute,mimeHint:"",naturalWidth:0,naturalHeight:0,bounds:rect(el),visible:true,sourceReadable:!!absolute,renderedReadable:true})})});return out}' +
        'return null;' +
      '})(' + JSON.stringify(params || {}) + ')';
    }
    async function evaluateFrames(send, kind, params) {
      ensureNotAborted(params && params.signal);
      var contexts = await isolatedContexts(send, params && params.signal);
      var requestedFrameId = String(params && params.frameId || '');
      if (requestedFrameId) contexts = contexts.filter(function (context) { return String(context.frameId) === requestedFrameId; });
      if (requestedFrameId && !contexts.length) fail('PAGE_STATE_UNAVAILABLE', '指定 frame 没有可用的执行上下文', { frameId: requestedFrameId });
      var results = [];
      function translateBounds(value, transform, seen) {
        if (!value || typeof value !== 'object') return value;
        seen = seen || [];
        if (seen.indexOf(value) !== -1) return value;
        seen.push(value);
        if (value.bounds && typeof value.bounds === 'object') {
          value.bounds = transformBounds(value.bounds, transform);
        }
        if (Array.isArray(value)) value.forEach(function (item) { translateBounds(item, transform, seen); });
        else Object.keys(value).forEach(function (key) { if (key !== 'bounds') translateBounds(value[key], transform, seen); });
        return value;
      }
      for (var index = 0; index < contexts.length; index += 1) {
        ensureNotAborted(params && params.signal);
        var response = await (contexts[index].send || senderForFrame(send, contexts[index].frameId))('Runtime.evaluate', {
          expression: pageFunctionSource(kind, params), contextId: contexts[index].executionContextId,
          returnByValue: true, awaitPromise: true, silent: true,
        }, Math.max(1000, Math.min(Number(params && params.timeoutMs) || 15000, 60000)));
        ensureNotAborted(params && params.signal);
        if (response.exceptionDetails) throw response.exceptionDetails;
        results.push({
          frameId: contexts[index].frameId,
          value: translateBounds(response.result && response.result.value, contexts[index].transform || identityTransform()),
        });
      }
      return results;
    }
    function windowed(value, params, label, dataKey) {
      if (params && params.start !== undefined && params.maxChars !== undefined) return pageDataContract.paginateValue(value, params, label, { dataKey: dataKey || 'value' });
      return value;
    }
    function perceive(input) {
      input = input || {};
      ensureNotAborted(input.signal);
      var tabId = Math.floor(Number(input.tabId));
      var kind = String(input.kind || 'snapshot');
      if (/^(?:getRequests|getSseEvents|clearNetworkCapture)$/.test(kind)) {
        if (!networkFacts) return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '网络事实 provider 未加载'));
        if (kind === 'clearNetworkCapture') return Promise.resolve(networkFacts.clear(tabId, input.signal)).then(function (result) {
          ensureNotAborted(input.signal);
          return result;
        });
        var networkInput = kind === 'getSseEvents'
          ? Object.assign({}, input, { resourceType: 'sse', phase: input.phase === 'all' ? '' : (input.phase || 'message') })
          : input;
        return Promise.resolve(networkFacts.query(tabId, networkInput)).then(function (result) {
          ensureNotAborted(input.signal);
          return result;
        });
      }
      if (kind === 'tabInfo' || kind === 'getCurrentTab') return readTabInfo(tabId, input.signal).then(function (result) {
        ensureNotAborted(input.signal);
        return result;
      });
      if (kind === 'snapshot' || kind === 'observe') return capture(tabId, input).then(function (snapshot) { return snapshot; });
      if (kind === 'pageLoadState') {
        var stateReadyState = String(input.readyState || input.state || 'complete');
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.pageLoadState', type: 'short', signal: input.signal || null }, function (send) {
          send = signalSender(send, input.signal);
          return readPageLoadStateWithSend(send, tabId, input.timeoutMs, input.signal, input).then(function (navigation) {
            ensureNotAborted(input.signal);
            return Object.assign({}, navigation, {
              ready: pageLoadStateReached(navigation, stateReadyState, input),
              expectedReadyState: stateReadyState,
              loadChecks: pageLoadChecks(navigation, input),
            });
          });
        });
      }
      if (kind === 'waitFor') {
        var waitForTimeoutMs = Math.max(100, Math.min(Number(input.timeoutMs) || 10000, 120000));
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.waitFor', type: 'short', signal: input.signal || null }, function (send) {
          send = signalSender(send, input.signal);
          return waitForTargetWithSend(send, tabId, input, {
            targetRef: input.targetRef || null,
            timeoutMs: waitForTimeoutMs,
            pollIntervalMs: input.pollIntervalMs,
            visible: input.visible !== false,
            requireGeometry: false,
            signal: input.signal,
          });
        });
      }
      if (kind === 'waitForPageLoad') {
        var waitStartedAt = 0;
        var loadDeadline = 0;
        var loadTimeoutMs = Math.max(100, Math.min(Number(input.timeoutMs) || 300000, 300000));
        var expectedReadyState = String(input.readyState || input.state || 'complete');
        // Missing configuration uses the node default. An explicit zero remains
        // meaningful: the browser/document completion facts need no extra
        // continuous-confirmation window.
        var configuredStableMs = Number(input.stableMs);
        var requiredStableMs = !Number.isFinite(configuredStableMs) || configuredStableMs < 0
          ? 800
          : Math.max(0, Math.min(configuredStableMs, 5000));
        var stableWindowStartedAt = 0;
        var stableWindowEndedAt = 0;
        function mainDocumentIdentity(value) {
          value = value || {};
          var navigation = value.navigation || value;
          var loaderId = String(navigation.loaderId || '');
          var frameId = String(navigation.frameId || value.frameId || '');
          return loaderId
            ? ['loader', frameId, loaderId].join(':')
            : ['document', frameId, Number(navigation.timeOrigin) || value.documentId || ''].join(':');
        }
        function pageLoadSignature(navigation) {
          return JSON.stringify([
            mainDocumentIdentity(navigation),
            String(navigation.url || ''),
            String(navigation.tabUrl || ''),
            String(navigation.pendingUrl || ''),
            String(navigation.readyState || ''),
            String(navigation.tabStatus || ''),
            navigation.loadEventCompleted === true,
            pageLoadCompletionEvidence(navigation),
          ]);
        }
        function waitResult(navigation) {
          return {
            ready: true,
            readyState: navigation.readyState,
            tabStatus: navigation.tabStatus,
            frameId: navigation.frameId,
            loaderId: navigation.loaderId,
            loadEventEnd: navigation.loadEventEnd,
            loadEventCompleted: navigation.loadEventCompleted,
            loadEvidence: pageLoadCompletionEvidence(navigation),
            loadChecks: pageLoadChecks(navigation, input),
            stableMs: requiredStableMs,
            waitDurationMs: Math.max(0, Date.now() - waitStartedAt),
            stableWindowStartedAt: stableWindowStartedAt || null,
            stableWindowEndedAt: stableWindowEndedAt || null,
            stableWindowDurationMs: stableWindowStartedAt && stableWindowEndedAt
              ? Math.max(0, stableWindowEndedAt - stableWindowStartedAt)
              : 0,
            documentId: liveDocumentContextFromNavigation(tabId, navigation).documentId,
            url: navigation.url,
            navigation: navigation,
            evidence: navigation.evidence,
          };
        }
        // A page-load wait can last several minutes. Retain the debugger lease
        // for its lifetime, but do not retain the per-tab command queue while
        // the poll is sleeping: a later page action must still be able to run.
        var loadLease = null;
        return sessions.acquire(tabId, { owner: 'PagePerceptionEngine.waitForPageLoad', type: 'short', signal: input.signal || null }).then(function (lease) {
          loadLease = lease;
          var send = lease.send;
          return Promise.resolve().then(function () {
            waitStartedAt = Date.now();
            loadDeadline = waitStartedAt + loadTimeoutMs;
            // Read the current browser/document state repeatedly and require it
            // to remain complete throughout the configured window.
            var stableSince = 0;
            var stableSignature = '';
            var lastNavigation = null;
            var lastError = null;
            var lastProgressAt = 0;
            var lastProgressSignature = '';
            function notifyProgress(navigation) {
              if (typeof input.onProgress !== 'function') return;
              var now = Date.now();
              var checks = pageLoadChecks(navigation, input);
              var signature = JSON.stringify([
                String(navigation && navigation.tabStatus || ''),
                String(navigation && navigation.readyState || ''),
                String(navigation && navigation.pendingUrl || ''),
                String(navigation && navigation.loaderId || ''),
                checks.hasLoadEvidence === true,
                checks.observationStable === true,
              ]);
              if (lastProgressAt && now - lastProgressAt < 1000 && signature === lastProgressSignature) return;
              lastProgressAt = now;
              lastProgressSignature = signature;
              try {
                input.onProgress({
                  tabId: tabId,
                  elapsedMs: Math.max(0, now - waitStartedAt),
                  stableWindowMs: stableSince ? Math.max(0, now - stableSince) : 0,
                  navigation: navigation,
                  loadChecks: checks,
                });
              } catch (_) {}
            }
            return new Promise(function pollLoad(resolve, reject) {
              try { ensureNotAborted(input.signal); }
              catch (error) { reject(error); return; }
              if (Date.now() >= loadDeadline) {
                var lastChecks = pageLoadChecks(lastNavigation, input);
                reject(new factContract.PageFactError('PAGE_LOAD_TIMEOUT', '页面未在超时前完成加载', {
                  expectedReadyState: expectedReadyState,
                  requiredStableMs: requiredStableMs,
                  waitDurationMs: Math.max(0, Date.now() - waitStartedAt),
                  navigation: lastNavigation,
                  loadChecks: lastChecks,
                  lastError: lastError ? String(lastError.message || lastError) : '',
                }));
                return;
              }
              var remaining = Math.max(1, loadDeadline - Date.now());
              readPageLoadStateWithSend(send, tabId, Math.min(5000, remaining), input.signal, input).then(function (navigation) {
                lastNavigation = navigation;
                lastError = null;
                notifyProgress(navigation);
                if (pageLoadStateReached(navigation, expectedReadyState, input)) {
                  var signature = pageLoadSignature(navigation);
                  if (signature !== stableSignature) {
                    stableSignature = signature;
                    stableSince = Date.now();
                    stableWindowStartedAt = stableSince;
                    stableWindowEndedAt = 0;
                    if (typeof input.onStableWindowStart === 'function') {
                      try {
                        input.onStableWindowStart({
                          tabId: tabId,
                          at: stableWindowStartedAt,
                          waitStartedAt: waitStartedAt,
                          navigation: navigation,
                          loadChecks: pageLoadChecks(navigation, input),
                        });
                      } catch (_) {}
                    }
                  }
                  if (!requiredStableMs || Date.now() - stableSince >= requiredStableMs) {
                    stableWindowEndedAt = Date.now();
                    if (typeof input.onStableWindowComplete === 'function') {
                      try {
                        input.onStableWindowComplete({
                          tabId: tabId,
                          startedAt: stableWindowStartedAt,
                          endedAt: stableWindowEndedAt,
                          durationMs: Math.max(0, stableWindowEndedAt - stableWindowStartedAt),
                          waitStartedAt: waitStartedAt,
                          navigation: navigation,
                          loadChecks: pageLoadChecks(navigation, input),
                        });
                      } catch (_) {}
                    }
                    resolve(waitResult(navigation));
                    return;
                  }
                } else {
                  stableSince = 0;
                  stableWindowStartedAt = 0;
                  stableWindowEndedAt = 0;
                  stableSignature = '';
                }
                setTimeout(function () { pollLoad(resolve, reject); }, Math.min(100, Math.max(0, loadDeadline - Date.now())));
              }, function (error) {
                lastError = error;
                stableSince = 0;
                stableWindowStartedAt = 0;
                stableWindowEndedAt = 0;
                stableSignature = '';
                reject(error);
              });
            });
          });
        }).then(function (result) {
          return loadLease.release().then(function () { return result; });
        }, function (error) {
          return (loadLease ? loadLease.release() : Promise.resolve()).then(function () { throw error; });
        });
      }
      if (kind === 'evaluateJavascript') {
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.evaluateJavascript', type: 'short', signal: input.signal || null }, async function (send) {
          send = signalSender(send, input.signal);
          ensureNotAborted(input.signal);
          var evaluateParams = {
            expression: javascriptContract.toExpression(input.code || input.expression || '', input.sourceType),
            awaitPromise: true,
            returnByValue: true,
            silent: true,
          };
          var world = String(input.world || 'MAIN').toUpperCase();
          if (world === 'ISOLATED') {
            var tree = await send('Page.getFrameTree', {}, 5000);
            var mainFrameId = tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
            if (!mainFrameId) fail('PAGE_STATE_UNAVAILABLE', '无法创建只读 ISOLATED world：主 frame 不可用');
            var isolated = await send('Page.createIsolatedWorld', {
              frameId: mainFrameId,
              worldName: 'page-automation-perception-script',
              grantUniveralAccess: false,
            }, 5000);
            evaluateParams.contextId = isolated.executionContextId;
          }
          var evaluated = await abortablePromise(send('Runtime.evaluate', evaluateParams, Math.max(100, Math.min(Number(input.timeoutMs) || 10000, 120000))), input.signal);
          ensureNotAborted(input.signal);
          return {
            result: javascriptContract.evaluatedValue(evaluated, '页面 JavaScript', 'no'),
            evidence: {
              source: 'PagePerceptionEngine',
              command: 'Runtime.evaluate',
              world: world,
              capturedAt: new Date().toISOString(),
            },
          };
        });
      }
      if (kind === 'getElement' || kind === 'getParent') {
        return sessions.withLease(tabId, {
          owner: 'PagePerceptionEngine.' + kind,
          type: 'short',
          signal: input.signal || null,
        }, async function (send) {
            var locator = Object.assign({}, factContract.normalizeLocator(input.locator));
            if (!Object.keys(locator).length) fail('ACTION_INVALID', '读取元素需要 canonical locator', { kind: kind });
            if (kind === 'getParent') locator.relative = 'parent';
            var resolved = await resolveTargetWithSend(send, tabId, locator, { requireGeometry: false, signal: input.signal });
            var details = { outerHTML: '', innerText: '', hasParent: String(resolved.target.tag || '').toLowerCase() !== 'html' };
            if (input.includeOuterHTML === true || input.includeInnerText === true) {
              var detailSend = senderForFrame(send, resolved.target.frameId);
              var remote = await detailSend('DOM.resolveNode', { backendNodeId: resolved.target.backendNodeId, objectGroup: 'page-automation-details' }, 5000);
              ensureNotAborted(input.signal);
              var detailObjectId = remote && remote.object && remote.object.objectId;
              try {
                if (detailObjectId) {
                  var detailRepresentation = input.includeInnerText === true ? 'text' : 'outerHTML';
                  var detailResponse = await detailSend('Runtime.callFunctionOn', {
                    objectId: detailObjectId,
                    functionDeclaration: 'function(representation){var root=this.getRootNode&&this.getRootNode(),text=typeof this.innerText==="string"?this.innerText:(this.textContent||"");return {outerHTML:representation==="outerHTML"?String(this.outerHTML||""):"",innerText:representation==="text"?String(text):"",hasParent:!!(this.parentElement||(root&&root.host))}}',
                    arguments: [{ value: detailRepresentation }],
                    returnByValue: true,
                    silent: true,
                  }, 10000);
                  ensureNotAborted(input.signal);
                  if (detailResponse && detailResponse.exceptionDetails) throw detailResponse.exceptionDetails;
                  details = detailResponse.result && detailResponse.result.value || details;
                }
              } finally {
                await detailSend('Runtime.releaseObjectGroup', { objectGroup: 'page-automation-details' }, 5000).catch(function () {});
              }
            }
            return Object.assign({
              documentId: String(resolved.targetRef && resolved.targetRef.documentId || ''),
              targetRef: resolved.targetRef,
              outerHTML: String(details.outerHTML || ''),
              innerText: String(details.innerText || ''),
              hasParent: details.hasParent === true,
            }, resolved.target);
        });
      }
      if (kind === 'inspectCss' && input.targetRef) {
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.inspectCss', type: 'short', signal: input.signal || null }, async function (send) {
            send = signalSender(send, input.signal);
            var resolved = await resolveTargetWithSend(send, tabId, {}, { targetRef: input.targetRef, signal: input.signal });
            var targetSend = senderForFrame(send, resolved.target.frameId);
            var objectGroup = 'page-perception-css';
            var remote = await targetSend('DOM.resolveNode', {
              backendNodeId: resolved.target.backendNodeId,
              objectGroup: objectGroup,
            }, 5000);
            ensureNotAborted(input.signal);
            var cssObjectId = remote && remote.object && remote.object.objectId;
            if (!cssObjectId) fail('TARGET_STALE', '样式目标已经失效', { targetRef: input.targetRef });
            try {
              var response = await targetSend('Runtime.callFunctionOn', {
                objectId: cssObjectId,
                functionDeclaration: 'function(rawProperties){var props=String(rawProperties||"").split(/[,\\s]+/).filter(Boolean);if(!props.length)props=["display","visibility","position","z-index","width","height","color","background-color","font-size","overflow","pointer-events"];var cs=getComputedStyle(this),out={};props.forEach(function(name){out[name]=cs.getPropertyValue(name)});return out}',
                arguments: [{ value: String(input.properties || '') }],
                returnByValue: true,
                silent: true,
              }, 10000);
              ensureNotAborted(input.signal);
              if (response.exceptionDetails) throw response.exceptionDetails;
              var computed = response.result && response.result.value || {};
              return Object.assign({
                type: 'css', frameId: resolved.target.frameId || '', targetRef: resolved.targetRef,
              }, pageDataContract.paginateValue(computed, input, kind, { dataKey: 'computed' }));
            } finally {
              await rawSender(targetSend)('Runtime.releaseObjectGroup', { objectGroup: objectGroup }, 5000).catch(function () {});
            }
          });
      }
      if (kind === 'scrollInfo') {
        if (!input.containerTargetRef && !input.containerSelector) {
          fail('ACTION_INVALID', 'scrollInfo 必须指定 containerSelector；读取整个页面时显式使用 "html"');
        }
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.scrollInfo', type: 'short', signal: input.signal || null }, async function (send) {
          send = signalSender(send, input.signal);
          var query = Object.assign({}, input);
          if (!query.containerTargetRef && query.containerSelector) {
            var container = await waitForTargetWithSend(send, tabId, { selector: query.containerSelector, elementIndex: query.containerIndex }, {
              timeoutMs: input.timeoutMs,
              visible: false,
              signal: input.signal,
            });
            query.containerTargetRef = container.targetRef;
          }
          var info = await readScrollInfoWithSend(send, tabId, query);
          if (!info) fail('TARGET_NOT_FOUND', '滚动容器不存在', { containerSelector: query.containerSelector || '' });
          var configuredStableMs = Number(input.stableMs);
          var stableMs = Math.max(0, Math.min(Number.isFinite(configuredStableMs) ? configuredStableMs : 800, 5000));
          if (!info.atBottom || !stableMs) return info;

          var stableSince = Date.now();
          var deadline = stableSince + Math.max(1000, Math.min(Number(input.timeoutMs) || 10000, 60000));
          var signature = [info.scrollHeight, info.clientHeight, info.maxTop].join(':');
          while (Date.now() - stableSince < stableMs && Date.now() < deadline) {
            ensureNotAborted(input.signal);
            await abortableDelay(Math.max(1, Math.min(50, stableMs - (Date.now() - stableSince), deadline - Date.now())), input.signal);
            var next = await readScrollInfoWithSend(send, tabId, query);
            if (!next.atBottom) return next;
            var nextSignature = [next.scrollHeight, next.clientHeight, next.maxTop].join(':');
            if (nextSignature !== signature) {
              signature = nextSignature;
              stableSince = Date.now();
            }
            info = next;
          }
          info.atBottom = Date.now() - stableSince >= stableMs;
          return info;
        });
      }
      if (kind === 'diagnosticDomSnapshot') {
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.diagnosticDomSnapshot', type: 'short', signal: input.signal || null }, async function (send) {
          send = signalSender(send, input.signal);
          ensureNotAborted(input.signal);
          var styles = input.computedStyles;
          if (typeof styles === 'string') styles = styles.split(',').map(function (value) { return value.trim(); }).filter(Boolean);
          var snapshot = await abortablePromise(send('DOMSnapshot.captureSnapshot', {
            computedStyles: Array.isArray(styles) ? styles.slice(0, 50) : [],
            includeDOMRects: input.includeDOMRects !== false,
            includePaintOrder: input.includePaintOrder === true,
            includeBlendedBackgroundColors: input.includeBlendedBackgroundColors === true,
          }, input.timeoutMs || 30000), input.signal);
          ensureNotAborted(input.signal);
          return Object.assign({ type: 'dom-snapshot', capturedAt: new Date().toISOString(), evidenceSource: 'PagePerceptionEngine.DOMSnapshot' }, pageDataContract.paginateValue(snapshot, input, kind, { dataKey: 'snapshot' }));
        });
      }
      if (kind === 'diagnosticAxTree') {
        return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.diagnosticAxTree', type: 'short', signal: input.signal || null }, async function (send) {
          send = signalSender(send, input.signal);
          ensureNotAborted(input.signal);
          var response;
          if (input.selector) {
            var resolved = await resolveTargetWithSend(send, tabId, { selector: input.selector, elementIndex: input.elementIndex }, { signal: input.signal });
            response = await abortablePromise(senderForFrame(send, resolved.target.frameId)('Accessibility.getPartialAXTree', { backendNodeId: resolved.target.backendNodeId, fetchRelatives: input.fetchRelatives !== false }, input.timeoutMs || 30000), input.signal);
          } else response = await abortablePromise(send('Accessibility.getFullAXTree', {}, input.timeoutMs || 30000), input.signal);
          ensureNotAborted(input.signal);
          var nodes = response.nodes || [];
          var page = pageDataContract.paginateItems(nodes, input, kind, { dataKey: 'nodes' });
          return Object.assign({ type: 'ax-tree', totalNodes: nodes.length, returnedNodeCount: page.nodes.length, evidenceSource: 'PagePerceptionEngine.Accessibility' }, page);
        });
      }
      if (/^(?:cdp\.(?:inspect_network|javascript_source|search_script_sources|analyze_performance|network_entry|performance_capture_start|performance_capture_finish)|resourceCacheRead(?:Many)?)$/.test(kind)) {
        var provider = diagnosticProvider(kind);
        if (!provider) return Promise.reject(new factContract.PageFactError('PAGE_STATE_UNAVAILABLE', '页面证据 provider 未加载', { kind: kind }));
        if (kind === 'cdp.analyze_performance' && (input.reload || String(input.action || '').toLowerCase() === 'click')) {
          return Promise.reject(new factContract.PageFactError('PAGE_ACTION_REQUIRED', '带页面动作的性能分析必须由 PageAutomationRuntime 编排', { kind: kind }));
        }
        return Promise.resolve(provider.perceive(tabId, kind, input)).then(function (result) {
          ensureNotAborted(input.signal);
          return result;
        });
      }
      return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.' + kind, type: 'short', signal: input.signal || null }, async function (send) {
        send = signalSender(send, input.signal);
        var queryInput = input;
        var resolvedReadTarget = null;
        var singleTargetRead = /^(?:extractText|elementInfo|extractTable|inspectText|inspectHtml|inspectCss|inspectStructure)$/.test(kind)
          && input.all !== true
          && !(kind === 'inspectCss' && !input.selector && !input.ref && !input.targetRef && !input.label && !input.scopeSelector && !input.scopeRef && !input.properties);
        if (singleTargetRead) {
          var readLocator = Object.assign({}, input);
          var hasReadLocator = !!(input.targetRef || input.selector || input.textSelector || input.textPattern || input.text
            || input.ref || input.label || input.scopeSelector || input.scopeRef || input.relative
            || input.elementIndex !== undefined || input.index !== undefined);
          if (!hasReadLocator) readLocator.selector = kind === 'extractTable' ? 'table' : (kind === 'inspectHtml' || kind === 'inspectCss' ? 'html' : 'body');
          try {
            resolvedReadTarget = /^(?:extractText|extractTable|elementInfo)$/.test(kind) && Number(input.timeoutMs) > 0
              ? await waitForTargetWithSend(send, tabId, readLocator, {
                  targetRef: input.targetRef || null,
                  timeoutMs: input.timeoutMs,
                  visible: false,
                  requireGeometry: false,
                  signal: input.signal,
                })
              : await resolveTargetWithSend(send, tabId, readLocator, {
                  targetRef: input.targetRef || null,
                  requireGeometry: false,
                  signal: input.signal,
                });
          } catch (error) {
            if (kind !== 'elementInfo' || String(error && error.code || '') !== 'TARGET_NOT_FOUND') throw error;
            resolvedReadTarget = null;
          }
          if (resolvedReadTarget && resolvedReadTarget.missing) fail('TARGET_NOT_FOUND', '页面读取目标数量未达到要求', { count: resolvedReadTarget.count, minCount: input.minCount });
          if (resolvedReadTarget) {
            queryInput = Object.assign({}, input, {
              selector: '', textSelector: '', textPattern: '', text: '', label: '',
              scopeSelector: '', scopeRef: '', relative: '', elementIndex: 0, index: 0,
              ref: await domRefForResolvedTarget(send, resolvedReadTarget, input.signal),
              frameId: resolvedReadTarget.target.frameId,
            });
          }
        } else if (kind === 'extractText' && input.all === true && Number(input.timeoutMs) > 0) {
          await waitForTargetWithSend(send, tabId, input, {
            timeoutMs: input.timeoutMs,
            visible: false,
            requireGeometry: false,
            signal: input.signal,
          });
        }
        var readSnapshot = await captureWithSend(send, tabId, input);
        var evaluatedKind = kind === 'extractScrollingList' ? 'extractList' : kind;
        var results;
        if (evaluatedKind === 'extractList' && Number(input.timeoutMs) > 0) {
          var listDeadline = Date.now() + Math.max(100, Math.min(Number(input.timeoutMs), 120000));
          while (true) {
            ensureNotAborted(input.signal);
            results = await evaluateFrames(send, evaluatedKind, queryInput);
            var extractedItemCount = results.reduce(function (total, result) {
              return total + (result.value && Array.isArray(result.value.items) ? result.value.items.length : 0);
            }, 0);
            if (extractedItemCount > 0) break;
            if (Date.now() >= listDeadline) {
              fail('TARGET_NOT_FOUND', '等待列表项超时', { itemSelector: input.itemSelector || '', autoDetect: input.autoDetect !== false });
            }
            await abortableDelay(Math.min(100, Math.max(1, listDeadline - Date.now())), input.signal);
          }
        } else {
          results = await evaluateFrames(send, evaluatedKind, queryInput);
        }
        function combineReadResults() {
        var values = results.map(function (item) { return item.value; }).filter(function (value) { return value !== null && value !== undefined; });
        var value;
        if (kind === 'extractList' || kind === 'extractScrollingList') {
          var items = [];
          values.forEach(function (result) { if (result && Array.isArray(result.items)) items = items.concat(result.items); });
          // maxItems is a node-wide limit, not a per-frame limit. The page
          // function applies it inside each execution context, so enforce the
          // contract once more after cross-frame aggregation.
          if (Number(input.maxItems) > 0) items = items.slice(0, Number(input.maxItems));
          var detectedItemSelector = '';
          values.some(function (result) {
            var candidate = String(result && result.itemSelector || '').trim();
            if (!candidate) return false;
            detectedItemSelector = candidate;
            return true;
          });
          value = { items: items, count: items.length, itemSelector: detectedItemSelector || input.itemSelector || '' };
          var listPage = pageDataContract.paginateItems(items, input, kind, { dataKey: 'items' });
          return Object.assign(value, { returnedCount: listPage.items.length }, listPage);
        }
        if (kind === 'extractTable') {
          var tableResult = results.find(function (item) { return item.value && Array.isArray(item.value.rows); });
          value = tableResult && tableResult.value || { headers: [], rows: [], rowCount: 0 };
          var tablePage = pageDataContract.paginateItems(value.rows || [], input, kind, { dataKey: 'rows' });
          return Object.assign({ frameId: tableResult && tableResult.frameId || '', returnedRowCount: tablePage.rows.length }, value, tablePage);
        }
        if (kind === 'elementInfo') {
          var elementResults = results.filter(function (item) { return item.value && typeof item.value === 'object'; });
          var elementResult = elementResults.find(function (item) { return item.value.exists === true; }) || elementResults[0];
          value = elementResult && elementResult.value || { exists: false, count: 0 };
          return Object.assign({}, value, {
            frameId: elementResult && elementResult.frameId || '',
            count: resolvedReadTarget ? resolvedReadTarget.count : elementResults.reduce(function (total, item) { return total + Math.max(0, Number(item.value.count) || 0); }, 0),
          });
        }
        if (kind === 'media') {
          value = [];
          results.forEach(function (result) {
            if (Array.isArray(result.value)) value = value.concat(result.value.map(function (item) { return Object.assign({ frameId: result.frameId }, item); }));
          });
          var mediaGeneration = Date.now();
          return { generation: mediaGeneration, capturedAt: new Date().toISOString(), items: value.map(function (item, index) { return Object.assign({ index: index, generation: mediaGeneration }, item); }), count: value.length };
        }
        if (kind === 'searchPage') {
          var hits = [];
          results.forEach(function (result) {
            if (result.value && Array.isArray(result.value.hits)) hits = hits.concat(result.value.hits.map(function (hit) { return Object.assign({ frameId: result.frameId }, hit); }));
          });
          var searchWindow = pageDataContract.paginateItems(hits, input, kind, { dataKey: 'hits' });
          return Object.assign({ query: input.query || '', count: hits.length, matches: searchWindow.hits }, searchWindow);
        }
        if (kind === 'inspectStructure') {
          var structureItems = [];
          results.forEach(function (result) {
            if (Array.isArray(result.value)) structureItems = structureItems.concat(result.value.map(function (item) { return Object.assign({ frameId: result.frameId }, item); }));
          });
          return Object.assign({ type: 'structure', count: structureItems.length }, pageDataContract.paginateItems(structureItems, input, kind, { dataKey: 'items' }));
        }
        if (kind === 'inspectText') {
          value = values.length <= 1 ? String(values[0] || '') : values.map(function (item) { return String(item || ''); }).join('\n');
          return Object.assign({ type: 'text' }, pageDataContract.paginateValue(value, input, kind, { dataKey: 'content' }));
        }
        if (kind === 'inspectHtml') {
          value = values.length <= 1 ? String(values[0] || '') : values.map(function (item) { return String(item || ''); }).join('\n');
          return Object.assign({ type: input.outer === true ? 'outerHTML' : 'innerHTML' }, pageDataContract.paginateValue(value, input, kind, { dataKey: 'content' }));
        }
        if (kind === 'inspectCss') {
          var cssMode = resolvedReadTarget || input.selector || input.ref || input.targetRef || input.properties ? 'computed' : 'stylesheets';
          if (cssMode === 'stylesheets') {
            var cssContent = results.map(function (result) { return result.value && result.value.content ? String(result.value.content) : ''; }).filter(Boolean).join('\n');
            return Object.assign({ type: 'css', frameCount: results.length }, pageDataContract.paginateValue(cssContent, input, kind, { dataKey: 'content' }));
          }
          var cssResult = results.find(function (result) { return result.value && result.value.computed && Object.keys(result.value.computed).length; }) || results[0];
          value = cssResult && cssResult.value || { mode: 'computed', computed: {} };
          return Object.assign({ type: 'css', frameId: cssResult && cssResult.frameId || '', ref: value.ref || '' }, pageDataContract.paginateValue(value.computed || {}, input, kind, { dataKey: 'computed' }));
        }
        if (kind === 'inspectJavascript') {
          var javascriptItems = [];
          var frameworks = [];
          var locations = [];
          results.forEach(function (result) {
            var frameValue = result.value || {};
            (frameValue.frameworks || []).forEach(function (framework) { if (frameworks.indexOf(framework) === -1) frameworks.push(framework); });
            if (frameValue.location) locations.push(Object.assign({ frameId: result.frameId }, frameValue.location));
            (frameValue.items || []).forEach(function (item) { javascriptItems.push(Object.assign({ frameId: result.frameId }, item)); });
          });
          return Object.assign({ type: 'javascript', frameworks: frameworks, location: locations[0] || {}, locations: locations, count: javascriptItems.length }, pageDataContract.paginateItems(javascriptItems, input, kind, { dataKey: 'items' }));
        }
        if (kind === 'webStorage') {
          var storageResult = values[0] || {};
          if (Object.prototype.hasOwnProperty.call(storageResult, 'key')) {
            return Object.assign({ key: storageResult.key }, pageDataContract.paginateValue(storageResult.value, input, kind, { dataKey: 'value' }));
          }
          return pageDataContract.paginateValue(storageResult.entries || {}, input, kind, { dataKey: 'entries' });
        }
        if (kind === 'extractText' && input.all === true) {
          value = [];
          values.forEach(function (result) {
            if (Array.isArray(result)) value = value.concat(result);
            else if (result !== undefined && result !== null) value.push(result);
          });
        } else {
          value = values.length <= 1 ? values[0] : values;
        }
        var readValue = windowed(value, input, kind, kind === 'inspectText' || kind === 'inspectHtml' ? 'content' : 'value');
        return kind === 'extractText' && readValue && typeof readValue === 'object'
          ? Object.assign({ type: 'extracted-value' }, readValue)
          : readValue;
        }
        var combined = combineReadResults();
        if (!combined || typeof combined !== 'object') return combined;
        return Object.assign({}, combined, {
          documentId: readSnapshot.documentId,
          targetRef: resolvedReadTarget && resolvedReadTarget.targetRef || combined.targetRef || null,
          targetId: resolvedReadTarget && resolvedReadTarget.target && resolvedReadTarget.target.targetId || combined.targetId || '',
          evidence: {
            source: 'PagePerceptionEngine',
            capturedAt: readSnapshot.capturedAt,
            providers: readSnapshot.evidence && readSnapshot.evidence.providers || [],
          },
        });
      });
    }
    function pageStateTargets(targets) {
      targets = Array.isArray(targets) ? targets : [];
      var primaryIndex = targets.findIndex(function (target) {
        return String(target && target.tag || '').toLowerCase() === 'article' && target.visible === true;
      });
      if (primaryIndex === -1) primaryIndex = targets.findIndex(function (target) {
        var tag = String(target && target.tag || '').toLowerCase();
        var role = String(target && target.role || '').toLowerCase();
        return (tag === 'main' || role === 'main') && target.visible === true;
      });
      if (primaryIndex <= 0) return targets;
      return [targets[primaryIndex]].concat(targets.slice(0, primaryIndex), targets.slice(primaryIndex + 1));
    }

    function describePageState(snapshot) {
      var targets = pageStateTargets(snapshot.targets);
      return {
        documentId: snapshot.documentId,
        tabId: snapshot.tabId,
        frameId: snapshot.frameId,
        url: snapshot.url,
        title: snapshot.title,
        viewport: snapshot.viewport,
        navigation: snapshot.navigation,
        evidence: snapshot.evidence,
        targetsTruncated: snapshot.evidence && snapshot.evidence.targetsTruncated === true,
        elements: targets,
        elementCount: targets.length,
        capturedAt: snapshot.capturedAt,
        facts: { engine: 'PagePerceptionEngine', documentId: snapshot.documentId },
      };
    }
    function observe(tabId, projection) {
      projection = projection || {};
      return capture(tabId, Object.assign({}, projection, { visualExposure: true })).then(function (snapshot) {
        return describePageState(snapshot);
      });
    }

    async function setConversationScreenshotVisibility(send, hidden, previous, signal) {
      ensureNotAborted(signal);
      var expression;
      if (hidden) {
        expression = '(function(){var el=document.getElementById("page-automation-page-conversation");if(!el)return null;var state={value:el.style.getPropertyValue("visibility"),priority:el.style.getPropertyPriority("visibility")};el.style.setProperty("visibility","hidden","important");return state;})()';
      } else {
        expression = '(function(state){var el=document.getElementById("page-automation-page-conversation");if(!el)return true;if(state&&state.value)el.style.setProperty("visibility",state.value,state.priority||"");else el.style.removeProperty("visibility");return true;})(' + JSON.stringify(previous || null) + ')';
      }
      var response = await abortablePromise(send('Runtime.evaluate', { expression: expression, returnByValue: true, silent: true }, 5000), signal);
      ensureNotAborted(signal);
      if (response && response.exceptionDetails) throw response.exceptionDetails;
      return response && response.result ? response.result.value : null;
    }
    function captureScreenshot(tabId, screenshotOptions) {
      screenshotOptions = screenshotOptions || {};
      ensureNotAborted(screenshotOptions.signal);
      return sessions.withLease(tabId, { owner: 'PagePerceptionEngine.screenshot', type: 'short', signal: screenshotOptions.signal || null }, async function (send) {
        send = signalSender(send, screenshotOptions.signal);
        var params = {
          format: /^(?:jpeg|webp)$/.test(String(screenshotOptions.format)) ? String(screenshotOptions.format) : 'png',
          fromSurface: true,
          captureBeyondViewport: screenshotOptions.captureBeyondViewport === true,
        };
        if (params.format !== 'png') params.quality = Math.max(0, Math.min(Number(screenshotOptions.quality) || 82, 100));
        if (screenshotOptions.selector || screenshotOptions.targetRef) {
          var resolved = await resolveTargetWithSend(send, Number(tabId), screenshotOptions, { targetRef: screenshotOptions.targetRef, signal: screenshotOptions.signal });
          params.clip = { x: resolved.target.bounds.x + Number(resolved.context.viewport && resolved.context.viewport.scrollX || 0), y: resolved.target.bounds.y + Number(resolved.context.viewport && resolved.context.viewport.scrollY || 0), width: resolved.target.bounds.width, height: resolved.target.bounds.height, scale: 1 };
          params.captureBeyondViewport = screenshotOptions.captureBeyondViewport !== false;
        } else if (screenshotOptions.clip) {
          params.clip = {
            x: Number(screenshotOptions.clip.x),
            y: Number(screenshotOptions.clip.y),
            width: Number(screenshotOptions.clip.width),
            height: Number(screenshotOptions.clip.height),
            scale: Number(screenshotOptions.clip.scale) || 1,
          };
        }
        ensureNotAborted(screenshotOptions.signal);
        // Use the raw lease sender for the tiny hide/restore transaction. If
        // the generation signal wins between the hide command and its reply,
        // aborting the wrapped sender could leave the panel hidden forever.
        var screenshotUiSend = send && send._rawSend || send;
        var previousConversationVisibility = await setConversationScreenshotVisibility(screenshotUiSend, true, null, null);
        try {
          var response = await abortablePromise(send('Page.captureScreenshot', params, Math.max(5000, Number(screenshotOptions.timeoutMs) || 30000)), screenshotOptions.signal);
          ensureNotAborted(screenshotOptions.signal);
          return { dataUrl: 'data:image/' + (params.format === 'jpeg' ? 'jpeg' : params.format) + ';base64,' + String(response.data || ''), format: params.format, clip: params.clip || null, capturedAt: new Date().toISOString(), evidenceSource: 'Page.captureScreenshot' };
        } finally {
          // Restoration is best-effort after cancellation, but must still be
          // attempted so a failed capture cannot leave the page UI hidden.
          if (previousConversationVisibility !== null) {
            await setConversationScreenshotVisibility(screenshotUiSend, false, previousConversationVisibility, null).catch(function () {});
          }
        }
      });
    }
    return Object.freeze({
      capture: capture,
      captureWithSend: captureWithSend,
      captureViewport: captureViewport,
      captureViewportWithSend: captureViewportWithSend,
      getDocumentContextWithSend: getDocumentContextWithSend,
      observe: observe,
      perceive: perceive,
      resolveTarget: resolveTarget,
      resolveTargetWithSend: resolveTargetWithSend,
      waitForTargetWithSend: waitForTargetWithSend,
      resolveFocusedTargetWithSend: resolveFocusedTargetWithSend,
      readTargetOptionsWithSend: readTargetOptionsWithSend,
      readScrollInfoWithSend: readScrollInfoWithSend,
      readPageLoadStateWithSend: readPageLoadStateWithSend,
      pageLoadStateReached: pageLoadStateReached,
      pageLoadChecks: pageLoadChecks,
      describePageState: describePageState,
      captureScreenshot: captureScreenshot,
      registerEvidenceProvider: registerEvidenceProvider,
    });
  }
  return Object.freeze({ API_VERSION: API_VERSION, createPagePerceptionEngine: createPagePerceptionEngine });
});
