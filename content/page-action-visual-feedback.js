// Foreground virtual pointer for unified PageActionEngine mouse actions.
(function installPageActionVisualFeedback(root) {
  'use strict';

  var MESSAGE_TYPE = 'PAGE_ACTION_VISUAL_FEEDBACK';
  var CONTROLLER_KEY = '__pageAutomationActionVisualFeedbackV1';
  var APPEAR_HOLD_MS = 150;
  var MIN_MOVE_MS = 240;
  var MAX_MOVE_MS = 600;
  var MOVE_PIXELS_PER_MS = 1.4;
  var TARGET_HOLD_MS = 260;
  var POST_ACTION_HOLD_MS = 480;
  if (!root || !root.document || root !== root.top || root[CONTROLLER_KEY]) return;

  var documentRef = root.document;
  var host = null;
  var shadow = null;
  var targetBox = null;
  var pointer = null;
  var ripples = null;
  var clearTimer = null;
  var currentPoint = null;

  function ensureDom() {
    if (host && host.isConnected) return;
    if (!host) {
      host = documentRef.createElement('div');
      host.id = 'page-automation-action-visual-feedback';
      host.setAttribute('data-page-automation-ui', 'page-action-visual-feedback');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;display:block;pointer-events:none;contain:strict';
      shadow = host.attachShadow({ mode: 'closed' });
      var style = documentRef.createElement('style');
      style.textContent = ':host{all:initial;position:fixed;inset:0;display:block;pointer-events:none;contain:strict}'
        + '*,*::before,*::after{box-sizing:border-box;pointer-events:none}'
        + '.target{position:absolute;top:0;left:0;width:4px;height:4px;border:0;border-radius:4px;background:transparent;box-shadow:0 0 0 1px rgba(11,119,114,.9);opacity:0;transform:translate3d(0,0,0);transition:opacity 180ms ease,box-shadow 180ms ease;will-change:transform,width,height,opacity}'
        + '.target.visible{opacity:.72}'
        + '.target.arrived{opacity:1;animation:target-breathe 1.2s ease-in-out infinite}'
        + '.target.acting{box-shadow:0 0 0 1px #004849;animation:none}'
        + '.pointer{position:absolute;top:-3px;left:-5px;width:24px;height:24px;opacity:1;transform:translate3d(0,0,0);transition:transform var(--move-duration,360ms) cubic-bezier(.22,1,.36,1),opacity 160ms ease;will-change:transform}'
        + '.pointer.instant{transition:none}'
        + '.pointer svg{display:block;width:24px;height:24px;overflow:visible;filter:drop-shadow(0 2px 3px rgba(10,33,36,.38))}'
        + '.pointer path{fill:#075856;stroke:#fff;stroke-width:1.7;stroke-linejoin:round}'
        + '.pointer.acting svg{animation:pointer-press 180ms ease-in-out 2 alternate}'
        + '.ripples{position:absolute;inset:0;overflow:hidden}'
        + '.ripple{position:absolute;top:-22px;left:-22px;width:44px;height:44px;border:2px solid rgba(0,109,107,.88);border-radius:50%;opacity:0;transform:translate3d(var(--x),var(--y),0) scale(.2);animation:click-ripple 420ms cubic-bezier(.22,1,.36,1) forwards}'
        + '@keyframes target-breathe{50%{opacity:.58}}'
        + '@keyframes pointer-press{to{transform:scale(.84)}}'
        + '@keyframes click-ripple{0%{opacity:.9}100%{opacity:0;transform:translate3d(var(--x),var(--y),0) scale(1.75)}}'
        + '@media(prefers-reduced-motion:reduce){.pointer,.target{transition:none}.target,.pointer.acting svg,.ripple{animation-duration:1ms;animation-iteration-count:1}}';
      targetBox = documentRef.createElement('div');
      targetBox.className = 'target';
      pointer = documentRef.createElement('div');
      pointer.className = 'pointer';
      var svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      var path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5 3 L5 19.9 L9.6 15.7 L12.2 21.9 L15.1 20.6 L12.5 14.5 L18.6 14.5 Z');
      svg.appendChild(path);
      pointer.appendChild(svg);
      ripples = documentRef.createElement('div');
      ripples.className = 'ripples';
      shadow.appendChild(style);
      shadow.appendChild(targetBox);
      shadow.appendChild(ripples);
      shadow.appendChild(pointer);
    }
    (documentRef.documentElement || documentRef.body).appendChild(host);
  }

  function point(input) {
    return {
      x: Math.max(0, Math.min(Number(root.innerWidth) || 0, Number(input && input.x) || 0)),
      y: Math.max(0, Math.min(Number(root.innerHeight) || 0, Number(input && input.y) || 0)),
    };
  }

  function place(target) {
    pointer.style.transform = 'translate3d(' + target.x.toFixed(2) + 'px,' + target.y.toFixed(2) + 'px,0)';
    currentPoint = target;
  }

  function wait(ms) {
    return new Promise(function (resolve) { root.setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
  }

  function floatingStatusPoint() {
    var floatingStatus = documentRef.getElementById('page-automation-floating-status');
    if (!floatingStatus || typeof floatingStatus.getBoundingClientRect !== 'function') return null;
    var rect;
    try { rect = floatingStatus.getBoundingClientRect(); } catch (_) { return null; }
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function prepareTargetBox(input) {
    var bounds = input && input.bounds;
    var width = Math.max(0, Number(bounds && bounds.width) || 0);
    var height = Math.max(0, Number(bounds && bounds.height) || 0);
    targetBox.classList.remove('visible', 'arrived', 'acting');
    if (!width || !height) {
      return false;
    }
    var x = Number(bounds.x !== undefined ? bounds.x : bounds.left) || 0;
    var y = Number(bounds.y !== undefined ? bounds.y : bounds.top) || 0;
    var left = Math.max(0, x);
    var top = Math.max(0, y);
    var right = Math.min(Number(root.innerWidth) || x + width, x + width);
    var bottom = Math.min(Number(root.innerHeight) || y + height, y + height);
    targetBox.style.transform = 'translate3d(' + left.toFixed(2) + 'px,' + top.toFixed(2) + 'px,0)';
    targetBox.style.width = Math.max(4, right - left).toFixed(2) + 'px';
    targetBox.style.height = Math.max(4, bottom - top).toFixed(2) + 'px';
    return true;
  }

  function movementDuration(from, to, reducedMotion) {
    if (reducedMotion) return 0;
    var deltaX = Number(to.x) - Number(from.x);
    var deltaY = Number(to.y) - Number(from.y);
    var distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    return Math.max(MIN_MOVE_MS, Math.min(MAX_MOVE_MS, Math.round(distance / MOVE_PIXELS_PER_MS)));
  }

  function ripple(target) {
    var node = documentRef.createElement('span');
    node.className = 'ripple';
    node.style.setProperty('--x', target.x.toFixed(2) + 'px');
    node.style.setProperty('--y', target.y.toFixed(2) + 'px');
    ripples.appendChild(node);
    var remove = function () { try { node.remove(); } catch (_) {} };
    node.addEventListener('animationend', remove, { once: true });
    root.setTimeout(remove, 500);
  }

  function show(input) {
    ensureDom();
    var continuingVisibleSequence = clearTimer !== null;
    if (clearTimer !== null) root.clearTimeout(clearTimer);
    pointer.classList.remove('acting');
    pointer.style.opacity = '1';
    if (!currentPoint || !continuingVisibleSequence) {
      currentPoint = floatingStatusPoint() || {
        x: (Number(root.innerWidth) || 0) / 2,
        y: (Number(root.innerHeight) || 0) / 2,
      };
      pointer.classList.add('instant');
      place(currentPoint);
      try { void pointer.offsetWidth; } catch (_) {}
      pointer.classList.remove('instant');
    }
    var target = point(input);
    var reducedMotion = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var from = { x: currentPoint.x, y: currentPoint.y };
    var duration = movementDuration(from, target, reducedMotion);
    var hasTargetBox = prepareTargetBox(input);
    return wait(APPEAR_HOLD_MS).then(function () {
      if (hasTargetBox) targetBox.classList.add('visible');
      pointer.style.setProperty('--move-duration', duration + 'ms');
      place(target);
      return wait(duration);
    }).then(function () {
      if (hasTargetBox) targetBox.classList.add('arrived');
      return wait(TARGET_HOLD_MS);
    }).then(function () {
      var clickLike = !/^(?:hover)$/.test(String(input && input.kind || ''));
      if (clickLike) {
        pointer.classList.remove('acting');
        try { void pointer.offsetWidth; } catch (_) {}
        pointer.classList.add('acting');
        if (hasTargetBox) targetBox.classList.add('acting');
        ripple(target);
        root.setTimeout(function () {
          pointer.classList.remove('acting');
          targetBox.classList.remove('acting');
        }, 380);
      }
      clearTimer = root.setTimeout(function () {
        if (pointer) pointer.style.opacity = '0';
        if (targetBox) targetBox.classList.remove('visible', 'arrived', 'acting');
        clearTimer = null;
      }, POST_ACTION_HOLD_MS);
      return true;
    });
  }

  function onMessage(message, sender, sendResponse) {
    if (!message || message.type !== MESSAGE_TYPE) return undefined;
    if (sender && sender.id && root.chrome.runtime.id && sender.id !== root.chrome.runtime.id) return undefined;
    show(message).then(function () { sendResponse({ ok: true }); }, function () { sendResponse({ ok: false }); });
    return true;
  }

  root[CONTROLLER_KEY] = Object.freeze({ show: show });
  root.chrome.runtime.onMessage.addListener(onMessage);
})(globalThis);
