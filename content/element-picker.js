// Element Picker — 可视化元素选择器工具（依赖 content/selector-utils.js）
(function () {
  'use strict';

  function installMessageListener(api) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
    if (self.__pfaElementPickerMessageListener) {
      try { chrome.runtime.onMessage.removeListener(self.__pfaElementPickerMessageListener); } catch (_) {}
    }
    var listener = function (message, sender, sendResponse) {
      if (!message || message.type !== 'START_PICKER') return;
      api.start(function (result) { sendResponse(result || null); });
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    self.__pfaElementPickerMessageListener = listener;
  }

  if (self.__pfaElementPicker && typeof self.__pfaElementPicker.start === 'function') {
    installMessageListener(self.__pfaElementPicker);
    return;
  }

  var highlight, tooltip, styleEl, selectedElement;
  var callback;
  var picking = false;

  function getSelector(el) {
    if (self.SelectorUtils) return self.SelectorUtils.bestSelector(el);
    if (el.id) return '#' + el.id;
    return el.tagName.toLowerCase();
  }

  function buildResult(el) {
    var result = { selector: getSelector(el), candidates: [] };
    if (self.SelectorUtils) {
      result.selector = self.SelectorUtils.buildChain(el);
      result.candidates = self.SelectorUtils.buildCandidates(el);
      var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (text) result.text = text;

      // 元素指纹：稳定特征，帮助判断选择器可靠性
      result.fingerprint = {
        tagName: el.tagName ? el.tagName.toLowerCase() : '',
        text: text || '',
        name: el.getAttribute('name') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        role: el.getAttribute('role') || '',
        type: el.type || '',
      };
    }
    return result;
  }

  function isOwnUi(el) {
    return el === highlight || el === tooltip;
  }

  // 高亮框跟随目标元素（不修改目标元素样式，避免污染页面）
  function moveHighlight(el) {
    var rect = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  }

  function onMouseMove(e) {
    if (!picking) return;
    var el = e.target;
    if (!el || isOwnUi(el) || el === document.documentElement || el === document.body) return;
    selectedElement = el;
    moveHighlight(el);
    tooltip.style.display = 'block';
    tooltip.textContent = getSelector(el);
    var x = Math.min(e.clientX + 12, window.innerWidth - 320);
    var y = Math.min(e.clientY + 14, window.innerHeight - 48);
    tooltip.style.left = Math.max(0, x) + 'px';
    tooltip.style.top = Math.max(0, y) + 'px';
  }

  // 捕获阶段吞掉鼠标事件，防止选取时触发页面自身行为（跳转、菜单等）
  function swallow(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!picking) return;
    swallow(e);
    var result = (selectedElement && !isOwnUi(selectedElement)) ? buildResult(selectedElement) : null;
    var cb = callback;
    cleanup();
    if (cb) cb(result);
  }

  function onKeyDown(e) {
    if (!picking) return;
    if (e.key === 'Escape') {
      swallow(e);
      var cb = callback;
      cleanup();
      if (cb) cb(null);
    }
  }

  function cleanup() {
    picking = false;
    if (highlight) highlight.remove();
    if (tooltip) tooltip.remove();
    if (styleEl) styleEl.remove();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('pointerdown', swallow, true);
    document.removeEventListener('pointerup', swallow, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    highlight = tooltip = styleEl = selectedElement = callback = null;
  }

  function start(cb) {
    cleanup();
    callback = cb;
    picking = true;

    // 十字光标（不依赖遮罩层，遮罩会拦截 e.target 导致选不中元素）
    styleEl = document.createElement('style');
    styleEl.textContent = '*, *:hover { cursor: crosshair !important; }';
    document.documentElement.appendChild(styleEl);

    highlight = document.createElement('div');
    highlight.style.cssText = 'position:fixed;display:none;z-index:2147483646;pointer-events:none;'
      + 'border:2px solid #004849;background:rgba(0,72,73,0.12);border-radius:3px;box-sizing:border-box;';
    document.documentElement.appendChild(highlight);

    tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:fixed;display:none;z-index:2147483647;pointer-events:none;'
      + 'background:#004849;color:#fff;padding:4px 8px;border-radius:3px;font:12px/1.4 monospace;'
      + 'max-width:320px;word-break:break-all;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    document.documentElement.appendChild(tooltip);

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('pointerdown', swallow, true);
    document.addEventListener('pointerup', swallow, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  self.__pfaElementPicker = { start: start };
  installMessageListener(self.__pfaElementPicker);
})();
