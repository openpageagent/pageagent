(function attachPageElementPositionController(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.PageAutomationPageElementPositionController = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PAGE_EDGE_GAP = 5;
  var OVERLAY_SCROLLBAR_SAFE_GAP = 12;

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function viewportSize(win, documentRef) {
    var documentElement = documentRef && documentRef.documentElement;
    var width = finiteNumber(documentElement && documentElement.clientWidth, 0);
    var height = finiteNumber(documentElement && documentElement.clientHeight, 0);
    var innerWidth = finiteNumber(win && win.innerWidth, width);
    var innerHeight = finiteNumber(win && win.innerHeight, height);
    width = width > 0 ? width : innerWidth;
    height = height > 0 ? height : innerHeight;
    var scrollingElement = documentRef && (documentRef.scrollingElement || documentElement);
    var overflowX = '';
    var overflowY = '';
    if (scrollingElement && win && typeof win.getComputedStyle === 'function') {
      try {
        var scrollingStyle = win.getComputedStyle(scrollingElement);
        overflowX = String(scrollingStyle && scrollingStyle.overflowX || '');
        overflowY = String(scrollingStyle && scrollingStyle.overflowY || '');
      } catch (_) {}
    }
    var hasHorizontalScrollbar = !!scrollingElement
      && overflowX !== 'hidden' && overflowX !== 'clip'
      && (overflowX === 'scroll' || finiteNumber(scrollingElement.scrollWidth, 0)
        > finiteNumber(scrollingElement.clientWidth, width) + 1);
    var hasVerticalScrollbar = !!scrollingElement
      && overflowY !== 'hidden' && overflowY !== 'clip'
      && (overflowY === 'scroll' || finiteNumber(scrollingElement.scrollHeight, 0)
        > finiteNumber(scrollingElement.clientHeight, height) + 1);
    return {
      width: width,
      height: height,
      rightInset: hasVerticalScrollbar && innerWidth - width < 1 ? OVERLAY_SCROLLBAR_SAFE_GAP : 0,
      bottomInset: hasHorizontalScrollbar && innerHeight - height < 1 ? OVERLAY_SCROLLBAR_SAFE_GAP : 0,
    };
  }

  function normalizedRatioPosition(value) {
    if (!value || typeof value !== 'object') return null;
    var leftRatio = Number(value.leftRatio);
    var topRatio = Number(value.topRatio);
    if (!Number.isFinite(leftRatio) || !Number.isFinite(topRatio)) return null;
    return {
      leftRatio: Math.min(Math.max(leftRatio, 0), 1),
      topRatio: Math.min(Math.max(topRatio, 0), 1),
    };
  }

  function normalizedFreePosition(value) {
    var position = normalizedRatioPosition(value);
    if (!position) return null;
    var bottom = Number(value.bottom);
    if (Number.isFinite(bottom)) position.bottom = bottom;
    return position;
  }

  function createPointerDrag(options) {
    var win = options.window;
    var handle = options.handle;
    var interactiveSelector = String(options.interactiveSelector || '');
    var stopPointerDownPropagation = options.stopPointerDownPropagation === true;
    var onStart = options.onStart;
    var onMoveStart = options.onMoveStart;
    var onMove = options.onMove;
    var onFinish = options.onFinish;
    var state = null;
    var suppressClick = false;
    var suppressClickTimer = 0;
    var initialized = false;
    var destroyed = false;
    options = null;

    function onDragStart(event) {
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!state || state.pointerId !== event.pointerId) return;
      var dx = event.clientX - state.startX;
      var dy = event.clientY - state.startY;
      if (!state.moved && Math.max(Math.abs(dx), Math.abs(dy)) > 4) {
        state.moved = true;
        if (onMoveStart) onMoveStart(state, event);
      }
      if (!state.moved) return;
      if (onMove) onMove(state, dx, dy, event);
      event.preventDefault();
      event.stopPropagation();
    }

    function finish(event) {
      if (!state || event && event.pointerId !== state.pointerId) return;
      var finished = state;
      state = null;
      win.removeEventListener('pointermove', onPointerMove, true);
      win.removeEventListener('pointerup', finish, true);
      win.removeEventListener('pointercancel', finish, true);
      try { if (handle && handle.releasePointerCapture) handle.releasePointerCapture(finished.pointerId); } catch (_) {}
      if (onFinish) onFinish(finished, event);
      if (!finished.moved) return;
      suppressClick = true;
      if (suppressClickTimer) win.clearTimeout(suppressClickTimer);
      suppressClickTimer = win.setTimeout(function () {
        suppressClickTimer = 0;
        suppressClick = false;
      }, 350);
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function onPointerDown(event) {
      if (destroyed || state || event.button !== undefined && event.button !== 0) return;
      var interactive = interactiveSelector && event.target && event.target.closest
        ? event.target.closest(interactiveSelector) : null;
      if (interactive) return;
      var started = onStart ? onStart(event) : {};
      if (started === false || started === null) return;
      state = started || {};
      state.pointerId = event.pointerId;
      state.startX = event.clientX;
      state.startY = event.clientY;
      state.moved = false;
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
      win.addEventListener('pointermove', onPointerMove, true);
      win.addEventListener('pointerup', finish, true);
      win.addEventListener('pointercancel', finish, true);
      event.preventDefault();
      if (stopPointerDownPropagation) event.stopPropagation();
    }

    function consumeSuppressedClick() {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      handle.addEventListener('pointerdown', onPointerDown);
      handle.addEventListener('dragstart', onDragStart);
    }

    function destroy() {
      if (destroyed) return;
      finish();
      destroyed = true;
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('dragstart', onDragStart);
      if (suppressClickTimer) win.clearTimeout(suppressClickTimer);
      suppressClickTimer = 0;
      state = null;
      suppressClick = false;
      onStart = null;
      onMoveStart = null;
      onMove = null;
      onFinish = null;
      handle = null;
      win = null;
    }

    return {
      init: init,
      isDragging: function () { return !!state; },
      consumeSuppressedClick: consumeSuppressedClick,
      destroy: destroy,
    };
  }

  function createFree(options) {
    options = options || {};
    var win = options.window;
    var documentRef = options.document || win && win.document;
    var host = options.host;
    var handle = options.handle;
    var boundaryElement = options.boundaryElement || host;
    var dragClassTarget = options.dragClassTarget || handle;
    var storage = options.storage;
    var storageKey = String(options.storageKey || 'pageAutomationFreePosition');
    var edgeGap = Math.max(0, finiteNumber(options.edgeGap, PAGE_EDGE_GAP));
    var defaultPosition = normalizedRatioPosition(options.defaultPosition) || { leftRatio: 0.5, topRatio: 1 };
    var interactiveSelector = String(options.interactiveSelector || 'button,select,textarea,input');
    var layoutDelay = Math.max(0, finiteNumber(options.layoutDelay, 320));
    var anchorBottom = options.verticalAnchor === 'bottom';

    if (!win || !documentRef || !host || !handle) {
      throw new Error('free position controller requires window, document, host and handle');
    }
    options = null;

    var destroyed = false;
    var initialized = false;
    var pointerDrag = null;
    var currentPosition = null;
    var refreshFrame = 0;
    var refreshTimer = 0;
    var resizeObserver = null;

    function positionBounds() {
      var hostRect = host && host.getBoundingClientRect ? host.getBoundingClientRect() : null;
      var boundaryRect = boundaryElement && boundaryElement.getBoundingClientRect
        ? boundaryElement.getBoundingClientRect() : hostRect;
      var width = boundaryRect && boundaryRect.width || 0;
      var height = boundaryRect && boundaryRect.height || 0;
      if (!(width > 0) || !(height > 0)) return null;
      var offsetLeft = boundaryRect && hostRect ? boundaryRect.left - hostRect.left : 0;
      var offsetTop = boundaryRect && hostRect ? boundaryRect.top - hostRect.top : 0;
      var viewport = viewportSize(win, documentRef);
      return {
        left: edgeGap - offsetLeft,
        top: edgeGap - offsetTop,
        width: Math.max(0, viewport.width - width - edgeGap * 2 - viewport.rightInset),
        height: Math.max(0, viewport.height - height - edgeGap * 2 - viewport.bottomInset),
        viewportHeight: viewport.height,
        hostHeight: hostRect && hostRect.height || height,
        bottomInset: viewport.bottomInset,
      };
    }

    function applyPosition(left, top) {
      if (destroyed || !host) return;
      var bounds = positionBounds();
      if (!bounds) return;
      left = Math.min(Math.max(finiteNumber(left, 0), bounds.left), bounds.left + bounds.width);
      top = Math.min(Math.max(finiteNumber(top, 0), bounds.top), bounds.top + bounds.height);
      host.style.left = Math.round(left) + 'px';
      host.style.right = 'auto';
      if (anchorBottom) {
        host.style.top = 'auto';
        host.style.bottom = Math.round(bounds.viewportHeight - bounds.hostHeight - top) + 'px';
      } else {
        host.style.top = Math.round(top) + 'px';
        host.style.bottom = 'auto';
      }
      host.style.transform = 'none';
      currentPosition = {
        leftRatio: bounds.width ? (left - bounds.left) / bounds.width : 0,
        topRatio: bounds.height ? (top - bounds.top) / bounds.height : 0,
      };
      if (anchorBottom) {
        currentPosition.bottom = bounds.viewportHeight - bounds.hostHeight - top - bounds.bottomInset;
      }
    }

    function applyRememberedPosition() {
      if (destroyed || !host || !currentPosition || pointerDrag && pointerDrag.isDragging()) return;
      var bounds = positionBounds();
      if (!bounds) return;
      var top = anchorBottom && Number.isFinite(currentPosition.bottom)
        ? bounds.viewportHeight - bounds.hostHeight - currentPosition.bottom - bounds.bottomInset
        : bounds.top + bounds.height * currentPosition.topRatio;
      applyPosition(
        bounds.left + bounds.width * currentPosition.leftRatio,
        top
      );
    }

    function persistPosition() {
      if (!currentPosition || !storage || typeof storage.setItem !== 'function') return;
      try { storage.setItem(storageKey, JSON.stringify(currentPosition)); } catch (_) {}
    }

    function loadPosition() {
      var stored = null;
      if (storage && typeof storage.getItem === 'function') {
        try { stored = normalizedFreePosition(JSON.parse(storage.getItem(storageKey) || 'null')); } catch (_) {}
      }
      currentPosition = stored || currentPosition || defaultPosition;
      applyRememberedPosition();
    }

    function cancelScheduledRefresh() {
      if (refreshFrame && win.cancelAnimationFrame) win.cancelAnimationFrame(refreshFrame);
      if (refreshTimer) win.clearTimeout(refreshTimer);
      refreshFrame = 0;
      refreshTimer = 0;
    }

    function refresh() {
      if (destroyed) return;
      applyRememberedPosition();
      if (!refreshFrame && win.requestAnimationFrame) {
        refreshFrame = win.requestAnimationFrame(function () {
          refreshFrame = 0;
          applyRememberedPosition();
        });
      }
      if (layoutDelay) {
        if (refreshTimer) win.clearTimeout(refreshTimer);
        refreshTimer = win.setTimeout(function () {
          refreshTimer = 0;
          applyRememberedPosition();
        }, layoutDelay);
      }
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      pointerDrag = createPointerDrag({
        window: win,
        handle: handle,
        interactiveSelector: interactiveSelector,
        onStart: function () {
          var rect = host.getBoundingClientRect();
          return { startLeft: rect.left, startTop: rect.top };
        },
        onMoveStart: function () {
          if (dragClassTarget) dragClassTarget.classList.add('dragging');
        },
        onMove: function (drag, dx, dy) {
          applyPosition(drag.startLeft + dx, drag.startTop + dy);
        },
        onFinish: function (drag) {
          if (dragClassTarget) dragClassTarget.classList.remove('dragging');
          if (drag.moved) persistPosition();
        },
      });
      pointerDrag.init();
      loadPosition();
      win.addEventListener('resize', refresh, { passive: true });
      if (win.ResizeObserver && documentRef.documentElement) {
        resizeObserver = new win.ResizeObserver(refresh);
        resizeObserver.observe(documentRef.documentElement);
        if (boundaryElement !== documentRef.documentElement) resizeObserver.observe(boundaryElement);
      }
      refresh();
    }

    function destroy() {
      if (destroyed) return;
      if (pointerDrag) pointerDrag.destroy();
      destroyed = true;
      win.removeEventListener('resize', refresh, { passive: true });
      if (resizeObserver) resizeObserver.disconnect();
      cancelScheduledRefresh();
      if (dragClassTarget) dragClassTarget.classList.remove('dragging');
      resizeObserver = null;
      pointerDrag = null;
      currentPosition = null;
      boundaryElement = null;
      dragClassTarget = null;
      storage = null;
      handle = null;
      host = null;
      documentRef = null;
      win = null;
    }

    return {
      init: init,
      refresh: refresh,
      resize: refresh,
      isDragging: function () { return !!(pointerDrag && pointerDrag.isDragging()); },
      consumeSuppressedClick: function () {
        return !!(pointerDrag && pointerDrag.consumeSuppressedClick());
      },
      destroy: destroy,
    };
  }

  function initialTop(win, defaultTop, dockHeight) {
    defaultTop = finiteNumber(defaultTop, 96);
    dockHeight = Math.max(0, finiteNumber(dockHeight, 0));
    var minTop = 30;
    var maxTop = Math.max(minTop, viewportSize(win, win && win.document).height - dockHeight - 4);
    return Math.min(Math.max(defaultTop, minTop), maxTop);
  }

  function createDocked(options) {
    options = options || {};
    var win = options.window;
    var documentRef = options.document || win && win.document;
    var storage = options.storage;
    var storageKey = String(options.storageKey || 'pageAutomationFloatingStatusPosition');
    var host = options.host;
    var button = options.button;
    var dockWidth = Math.max(1, finiteNumber(options.dockWidth, 56));
    var dockHeight = Math.max(1, finiteNumber(options.dockHeight, 126));
    var dragSize = Math.max(1, finiteNumber(options.dragSize, 40));
    var defaultTop = finiteNumber(options.defaultTop, 96);
    var hideUntilReady = options.hideUntilReady === true;
    var setExpanded = typeof options.setExpanded === 'function' ? options.setExpanded : function () {};
    var clearExpanded = typeof options.clearExpanded === 'function' ? options.clearExpanded : function () {};

    if (!win || !host || !button) {
      throw new Error('floating position controller requires window, host and button');
    }
    options = null;

    var destroyed = false;
    var initialized = false;
    var pointerDrag = null;
    var currentPosition = null;
    var currentSide = 'right';
    var currentTopRatio = null;
    var storageNeedsMigration = false;
    var resizeObserver = null;
    var positionLoaded = false;

    function finishPositionLoad() {
      if (destroyed || positionLoaded) return;
      positionLoaded = true;
      if (hideUntilReady && host) host.style.visibility = '';
    }

    function clampTop(top) {
      top = finiteNumber(top, defaultTop);
      var minTop = 30;
      var maxTop = Math.max(minTop, viewportSize(win, documentRef).height - dockHeight - 4);
      return Math.min(Math.max(top, minTop), maxTop);
    }

    function dockSize() {
      return {
        width: host && host.offsetWidth || dockWidth,
        height: host && host.offsetHeight || dockHeight,
      };
    }

    function normalizePosition(value) {
      if (!value || typeof value !== 'object') return null;
      var left = Number(value.left);
      var top = Number(value.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left: left, top: top };
    }

    function normalizeSide(value) {
      return value === 'left' || value === 'right' ? value : '';
    }

    function constrainPosition(position) {
      position = normalizePosition(position);
      if (!position) return null;
      var size = dockSize();
      var viewport = viewportSize(win, documentRef);
      var minLeft = 0;
      var minTop = 30;
      var maxLeft = Math.max(minLeft, viewport.width - size.width);
      var maxTop = Math.max(minTop, viewport.height - size.height - 4);
      return {
        left: Math.min(Math.max(position.left, minLeft), maxLeft),
        top: Math.min(Math.max(position.top, minTop), maxTop),
      };
    }

    function topRatioFromTop(top) {
      return clampTop(top) / Math.max(1, viewportSize(win, documentRef).height);
    }

    function normalizeTopRatio(value, fallbackTop) {
      var topRatio = Number(value);
      if (!Number.isFinite(topRatio)) return topRatioFromTop(fallbackTop);
      return Math.min(Math.max(topRatio, 0), 1);
    }

    function topFromRatio(topRatio) {
      topRatio = Number(topRatio);
      if (!Number.isFinite(topRatio)) return clampTop(defaultTop);
      return clampTop(topRatio * Math.max(1, viewportSize(win, documentRef).height));
    }

    function edgePosition(side, top) {
      var size = dockSize();
      var viewport = viewportSize(win, documentRef);
      side = normalizeSide(side) || 'right';
      return {
        left: side === 'left' ? 0 : Math.max(0, viewport.width - size.width),
        top: clampTop(top),
      };
    }

    function defaultPosition() {
      return edgePosition('right', defaultTop);
    }

    function positionSide(position) {
      position = constrainPosition(position);
      if (!position) return 'right';
      var size = dockSize();
      return position.left + (size.width / 2) < viewportSize(win, documentRef).width / 2 ? 'left' : 'right';
    }

    function positionFromStorage(value) {
      if (!value || typeof value !== 'object') return null;
      var side = normalizeSide(value.side);
      var topRatio = Number(value.topRatio);
      if (side && Number.isFinite(topRatio)) {
        currentSide = side;
        currentTopRatio = normalizeTopRatio(topRatio, defaultTop);
        return edgePosition(side, topFromRatio(currentTopRatio));
      }
      var legacyPosition = normalizePosition(value);
      if (!legacyPosition) return null;
      currentSide = positionSide(legacyPosition);
      currentTopRatio = topRatioFromTop(legacyPosition.top);
      storageNeedsMigration = true;
      return edgePosition(currentSide, legacyPosition.top);
    }

    function positionForStorage(position) {
      if (!position) return null;
      return {
        side: normalizeSide(currentSide) || positionSide(position),
        topRatio: currentTopRatio === null ? topRatioFromTop(position.top) : currentTopRatio,
      };
    }

    function applyPosition(position, side, applyOptions) {
      if (destroyed || !host) return;
      applyOptions = applyOptions || {};
      host.style.width = dockWidth + 'px';
      host.style.height = dockHeight + 'px';
      if (!position) {
        currentSide = 'right';
        position = defaultPosition();
        if (applyOptions.updateTopRatio !== false || currentTopRatio === null) {
          currentTopRatio = topRatioFromTop(position.top);
        }
        currentPosition = position;
        host.style.left = Math.round(position.left) + 'px';
        host.style.top = Math.round(position.top) + 'px';
        host.style.right = 'auto';
        host.setAttribute('data-side', 'right');
        return;
      }
      currentSide = normalizeSide(side) || normalizeSide(currentSide) || 'right';
      position = edgePosition(currentSide, position.top);
      currentPosition = position;
      if (applyOptions.updateTopRatio !== false || currentTopRatio === null) {
        currentTopRatio = topRatioFromTop(position.top);
      }
      host.style.left = Math.round(position.left) + 'px';
      host.style.right = 'auto';
      host.style.top = Math.round(position.top) + 'px';
      host.setAttribute('data-side', currentSide);
    }

    function applyDragPosition(position) {
      if (destroyed || !host) return;
      position = constrainPosition(position);
      if (!position) return;
      host.style.width = dragSize + 'px';
      host.style.height = dragSize + 'px';
      currentPosition = position;
      currentSide = positionSide(position);
      currentTopRatio = topRatioFromTop(position.top);
      host.style.left = Math.round(position.left) + 'px';
      host.style.top = Math.round(position.top) + 'px';
      host.style.right = 'auto';
      host.setAttribute('data-side', currentSide);
    }

    function persistPosition() {
      if (destroyed || !currentPosition || !storage || typeof storage.set !== 'function') return;
      try {
        var patch = {};
        patch[storageKey] = positionForStorage(currentPosition);
        storage.set(patch);
      } catch (_) {}
    }

    function loadPosition() {
      if (!storage || typeof storage.get !== 'function') {
        applyPosition(null);
        finishPositionLoad();
        return;
      }
      try {
        storage.get(storageKey, function (result) {
          if (destroyed) return;
          storageNeedsMigration = false;
          currentPosition = positionFromStorage(result && result[storageKey]);
          if (!currentPosition) {
            currentSide = 'right';
            currentPosition = defaultPosition();
            currentTopRatio = topRatioFromTop(currentPosition.top);
          }
          applyPosition(currentPosition, currentSide, { updateTopRatio: false });
          if (storageNeedsMigration) {
            persistPosition();
            storageNeedsMigration = false;
          }
          finishPositionLoad();
        });
      } catch (_) {
        applyPosition(null);
        finishPositionLoad();
      }
    }

    function resize() {
      if (destroyed || !currentPosition) return;
      currentPosition = edgePosition(currentSide, topFromRatio(currentTopRatio));
      applyPosition(currentPosition, currentSide, { updateTopRatio: false });
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      if (hideUntilReady) host.style.visibility = 'hidden';
      pointerDrag = createPointerDrag({
        window: win,
        handle: button,
        stopPointerDownPropagation: true,
        onStart: function () {
          if (!positionLoaded) return false;
          var hostRect = host.getBoundingClientRect();
          var rect = button.getBoundingClientRect();
          setExpanded();
          return {
            startLeft: rect.left,
            startTop: rect.top,
            mainOffsetTop: rect.top - hostRect.top,
          };
        },
        onMoveStart: function () {
          button.classList.add('dragging');
          host.style.width = dragSize + 'px';
          host.style.height = dragSize + 'px';
          host.setAttribute('data-dragging', 'true');
        },
        onMove: function (drag, dx, dy) {
          currentPosition = constrainPosition({
            left: drag.startLeft + dx,
            top: drag.startTop + dy,
          });
          applyDragPosition(currentPosition);
        },
        onFinish: function (drag) {
          button.classList.remove('dragging');
          host.removeAttribute('data-dragging');
          if (drag.moved) {
            var mainOffsetTop = drag.mainOffsetTop || 0;
            currentSide = positionSide(currentPosition);
            currentTopRatio = topRatioFromTop((currentPosition && currentPosition.top || 0) - mainOffsetTop);
            currentPosition = edgePosition(currentSide, (currentPosition && currentPosition.top || 0) - mainOffsetTop);
            applyPosition(currentPosition, currentSide, { updateTopRatio: false });
            persistPosition();
          }
          clearExpanded();
        },
      });
      pointerDrag.init();
      loadPosition();
      win.addEventListener('resize', resize, { passive: true });
      if (win.ResizeObserver && documentRef && documentRef.documentElement) {
        resizeObserver = new win.ResizeObserver(resize);
        resizeObserver.observe(documentRef.documentElement);
      }
    }

    function destroy() {
      if (destroyed) return;
      if (pointerDrag) pointerDrag.destroy();
      destroyed = true;
      win.removeEventListener('resize', resize, { passive: true });
      if (resizeObserver) resizeObserver.disconnect();
      if (button) {
        button.classList.remove('dragging');
      }
      if (host) host.removeAttribute('data-dragging');
      resizeObserver = null;
      pointerDrag = null;
      currentPosition = null;
      positionLoaded = false;
      host = null;
      button = null;
      storage = null;
      setExpanded = null;
      clearExpanded = null;
      documentRef = null;
      win = null;
    }

    return {
      init: init,
      resize: resize,
      isDragging: function () { return !!(pointerDrag && pointerDrag.isDragging()); },
      consumeSuppressedClick: function () {
        return !!(pointerDrag && pointerDrag.consumeSuppressedClick());
      },
      destroy: destroy,
    };
  }

  return {
    EDGE_GAP: PAGE_EDGE_GAP,
    createDocked: createDocked,
    createFree: createFree,
    initialTop: initialTop,
  };
});
