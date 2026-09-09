// Page-level floating automation status entry.
(function () {
  'use strict';

  if (window.__pageAutomationFloatingStatusInstalled || window.__pageAutomationFloatingStatusInitializing) return;
  if (!window.PageAutomationRuntimeClient || typeof window.PageAutomationRuntimeClient.create !== 'function') {
    throw new Error('ui/runtime-client.js must load before content/floating-status.js');
  }
  if (!window.PageAutomationPageElementPositionController
    || typeof window.PageAutomationPageElementPositionController.createDocked !== 'function') {
    throw new Error('content/page-element-position-controller.js must load before content/floating-status.js');
  }
  if (!window.PageAutomationSystemSettings
    || typeof window.PageAutomationSystemSettings.load !== 'function') {
    throw new Error('SystemSettings must load before FloatingStatus');
  }
  if (!window.PageAutomationPageConversationEntry
    || window.PageAutomationPageConversationEntry.API_VERSION !== 1
    || typeof window.PageAutomationPageConversationEntry.toggle !== 'function'
    || typeof window.PageAutomationPageConversationEntry.subscribe !== 'function') {
    throw new Error('content/page-conversation-entry.js must load before content/floating-status.js');
  }
  var pageConversationEntry = window.PageAutomationPageConversationEntry;
  var runtimeClient = window.PageAutomationRuntimeClient.create(chrome.runtime, {
    onInvalidated: destroyFloatingStatus,
  });
  window.__pageAutomationFloatingStatusInitializing = true;
  window.__pageAutomationFloatingStatusInstalled = false;

  var POSITION_STORAGE_KEY = 'pageAutomationFloatingStatusPosition';
  var POLL_INTERVAL_MS = 2000;
  var ACTION_BUTTON_SIZE = 35;
  var STACK_GAP = 8;
  var MAIN_BUTTON_WIDTH = 44;
  var MAIN_BUTTON_HEIGHT = 40;
  var DOCK_WIDTH = 56;
  var DOCK_HEIGHT = ACTION_BUTTON_SIZE + STACK_GAP + MAIN_BUTTON_HEIGHT + STACK_GAP + ACTION_BUTTON_SIZE;
  var DEFAULT_TOP = 96;
  var TUCK_OFFSET = 21;
  var ICON_SIZE = 32;
  var DRAG_SIZE = 40;
  var EDGE_PADDING = 4;
  var BADGE_MIN_WIDTH = 20;
  var BADGE_HEIGHT = 14;
  var host = null;
  var button = null;
  var chatButton = null;
  var chatOpenIndicator = null;
  var settingsButton = null;
  var badge = null;
  var positionController = null;
  var pollTimer = 0;
  var initialized = false;
  var initRetryTimer = 0;
  var disposed = false;
  var floatingEntryEnabled = false;
  var systemSettingsRevision = 0;
  var pageConversationUnsubscribe = null;

  function sendMessage(type, payload) {
    if (!runtimeClient) return Promise.resolve({ ok: false, reason: 'destroyed', error: '浮窗已销毁' });
    return runtimeClient.send(type, payload);
  }

  function createSvgIcon(parts) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    (parts || []).forEach(function (part) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', part.tag || 'path');
      Object.keys(part.attrs || {}).forEach(function (key) {
        node.setAttribute(key, part.attrs[key]);
      });
      svg.appendChild(node);
    });
    return svg;
  }

  function iconChat() {
    return createSvgIcon([
      { attrs: { d: 'M4 5h16v10H8l-4 4V5z' } },
      { attrs: { d: 'M8 9h8' } },
      { attrs: { d: 'M8 12h5' } },
    ]);
  }

  function iconSettings() {
    return createSvgIcon([
      { attrs: { d: 'M10.3 4.3c.4-1.7 2.9-1.7 3.4 0a1.7 1.7 0 0 0 2.5 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 0 0 1.1 2.5c1.7.4 1.7 2.9 0 3.4a1.7 1.7 0 0 0-1.1 2.5c.9 1.5-.8 3.3-2.4 2.4a1.7 1.7 0 0 0-2.5 1.1c-.4 1.7-2.9 1.7-3.4 0a1.7 1.7 0 0 0-2.5-1.1c-1.5.9-3.3-.8-2.4-2.4a1.7 1.7 0 0 0-1.1-2.5c-1.7-.4-1.7-2.9 0-3.4a1.7 1.7 0 0 0 1.1-2.5c-.9-1.5.8-3.3 2.4-2.4 1 .6 2.2.1 2.5-1.1z' } },
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
    ]);
  }

  function iconCheck() {
    return createSvgIcon([
      { attrs: { d: 'm5 12 4 4L19 7' } },
    ]);
  }

  function createHost() {
    host = document.createElement('div');
    host.id = 'page-automation-floating-status';
    host.setAttribute('data-page-automation-ui', 'floating-status');
    host.style.position = 'fixed';
    host.style.top = window.PageAutomationPageElementPositionController.initialTop(
      window,
      DEFAULT_TOP,
      DOCK_HEIGHT
    ) + 'px';
    host.style.right = '0px';
    host.style.zIndex = '2147483647';
    host.style.width = DOCK_WIDTH + 'px';
    host.style.height = DOCK_HEIGHT + 'px';
    host.style.pointerEvents = 'auto';
    host.setAttribute('data-side', 'right');

    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '@media print{:host{display:none!important;}}',
      '.stack{position:relative;display:flex;flex-direction:column;gap:' + STACK_GAP + 'px;width:' + DOCK_WIDTH + 'px;height:' + DOCK_HEIGHT + 'px;box-sizing:border-box;pointer-events:auto;font:13px/1.4 Inter,Roboto,Arial,sans-serif;letter-spacing:0;color:#10282b;}',
      ':host([data-side="right"]) .stack{align-items:flex-end;}',
      ':host([data-side="left"]) .stack{align-items:flex-start;}',
      'button{font:inherit;letter-spacing:0;}',
      '.float-action,.main-button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;-webkit-user-select:none;}',
      '.float-action{position:relative;width:' + ACTION_BUTTON_SIZE + 'px;height:' + ACTION_BUTTON_SIZE + 'px;border:1px solid rgba(208,219,224,.96);border-radius:50%;background:rgba(255,255,255,.98);color:#435d64;box-shadow:0 12px 28px rgba(10,33,36,.13),0 2px 7px rgba(0,0,0,.10);transition:transform .22s ease,opacity .18s ease,border-color .18s ease,background .18s ease,color .18s ease;}',
      ':host([data-side="right"]) .float-action{margin-right:4px;}',
      ':host([data-side="left"]) .float-action{margin-left:4px;}',
      '.float-action:hover,.float-action:focus-visible{outline:none;background:#fff;border-color:#aabbc3;color:#004849;}',
      '.float-action svg{display:block;width:20px;height:20px;}',
      '.chat-action.active{border-color:#8ebcb5;background:#f4fbf9;color:#00645f;}',
      '.chat-open-indicator{position:absolute;right:-2px;bottom:-2px;display:inline-flex;width:13px;height:13px;align-items:center;justify-content:center;border:1.5px solid #fff;border-radius:50%;background:#29a565;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18);}',
      '.chat-open-indicator[hidden]{display:none;}',
      '.chat-open-indicator svg{width:9px;height:9px;stroke-width:3.2;}',
      ':host([data-side="right"]:not([data-expanded="true"]):not([data-dragging="true"])) .float-action{transform:translateX(54px) scale(.96);opacity:0;pointer-events:none;}',
      ':host([data-side="left"]:not([data-expanded="true"]):not([data-dragging="true"])) .float-action{transform:translateX(-54px) scale(.96);opacity:0;pointer-events:none;}',
      '.main-wrap{position:relative;display:flex;width:' + DOCK_WIDTH + 'px;height:' + MAIN_BUTTON_HEIGHT + 'px;box-sizing:border-box;}',
      ':host([data-side="right"]) .main-wrap{justify-content:flex-end;}',
      ':host([data-side="left"]) .main-wrap{justify-content:flex-start;}',
      '.main-button{position:relative;width:' + MAIN_BUTTON_WIDTH + 'px;height:' + MAIN_BUTTON_HEIGHT + 'px;border:1px solid rgba(208,219,224,.96);background:rgba(255,255,255,.98);box-shadow:0 12px 28px rgba(10,33,36,.13),0 2px 7px rgba(0,0,0,.10);touch-action:none;transition:transform .22s ease,opacity .18s ease,border-color .18s ease,background .18s ease;overflow:visible;}',
      ':host([data-side="right"]) .main-button{justify-content:flex-start;padding-left:' + EDGE_PADDING + 'px;border-right:0;border-radius:' + (MAIN_BUTTON_HEIGHT / 2) + 'px 0 0 ' + (MAIN_BUTTON_HEIGHT / 2) + 'px;}',
      ':host([data-side="left"]) .main-button{justify-content:flex-end;padding-right:' + EDGE_PADDING + 'px;border-left:0;border-radius:0 ' + (MAIN_BUTTON_HEIGHT / 2) + 'px ' + (MAIN_BUTTON_HEIGHT / 2) + 'px 0;}',
      ':host([data-side="right"]:not([data-expanded="true"]):not([data-dragging="true"])) .main-button{transform:translateX(' + TUCK_OFFSET + 'px);opacity:.68;}',
      ':host([data-side="left"]:not([data-expanded="true"]):not([data-dragging="true"])) .main-button{transform:translateX(-' + TUCK_OFFSET + 'px);opacity:.68;}',
      '.main-button:hover,.main-button:focus-visible{outline:none;border-color:#aabbc3;background:#fff;}',
      '.main-button.dragging{justify-content:center;width:' + DRAG_SIZE + 'px;height:' + DRAG_SIZE + 'px;padding:0;border:1px solid rgba(208,219,224,.96);border-radius:50%;cursor:grabbing;opacity:1;}',
      ':host([data-side="right"]) .main-button.dragging,:host([data-side="left"]) .main-button.dragging{justify-content:center;width:' + DRAG_SIZE + 'px;height:' + DRAG_SIZE + 'px;padding:0;border:1px solid rgba(208,219,224,.96);border-radius:50%;}',
      ':host([data-dragging="true"]) .stack{width:' + DRAG_SIZE + 'px;height:' + DRAG_SIZE + 'px;gap:0;align-items:center;}',
      ':host([data-dragging="true"]) .float-action{display:none;}',
      ':host([data-dragging="true"]) .main-wrap{width:' + DRAG_SIZE + 'px;height:' + DRAG_SIZE + 'px;}',
      '.main-button.dragging .badge{display:none;}',
      'img{display:block;width:' + ICON_SIZE + 'px;height:' + ICON_SIZE + 'px;object-fit:contain;border-radius:50%;pointer-events:none;-webkit-user-drag:none;user-select:none;}',
      '.badge{position:absolute;top:-3px;display:inline-flex;align-items:center;justify-content:center;min-width:' + BADGE_MIN_WIDTH + 'px;height:' + BADGE_HEIGHT + 'px;padding:0 3px;border:1px solid rgba(255,255,255,.9);border-radius:999px;color:#fff;font:700 6.5px/1 Roboto,Arial,sans-serif;letter-spacing:0;box-shadow:0 1px 4px rgba(0,0,0,.18);}',
      ':host([data-side="right"]) .badge{right:1px;}',
      ':host([data-side="left"]) .badge{left:1px;}',
      '.badge[hidden]{display:none;}',
      '.running{background:#004849;}',
      '.failed{background:#ba554a;}',
      '.stopped{background:#cf9f5d;}',
    ].join('');

    var stack = document.createElement('div');
    stack.className = 'stack';

    chatButton = document.createElement('button');
    chatButton.type = 'button';
    chatButton.className = 'float-action chat-action';
    chatButton.title = '打开页面对话';
    chatButton.setAttribute('aria-label', '打开页面对话');
    chatButton.setAttribute('aria-pressed', 'false');
    chatButton.appendChild(iconChat());
    chatOpenIndicator = document.createElement('span');
    chatOpenIndicator.className = 'chat-open-indicator';
    chatOpenIndicator.hidden = true;
    chatOpenIndicator.setAttribute('aria-hidden', 'true');
    chatOpenIndicator.appendChild(iconCheck());
    chatButton.appendChild(chatOpenIndicator);
    chatButton.addEventListener('click', togglePageConversation);

    var mainWrap = document.createElement('div');
    mainWrap.className = 'main-wrap';

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'main-button';
    button.title = '打开侧边栏 / 状态栏';
    button.setAttribute('aria-label', '打开侧边栏 / 状态栏');

    var icon = document.createElement('img');
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    icon.draggable = false;
    icon.src = chrome.runtime.getURL('icons/icon48.png');

    badge = document.createElement('span');
    badge.className = 'badge';
    badge.hidden = true;

    button.appendChild(icon);
    button.appendChild(badge);

    mainWrap.appendChild(button);

    settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'float-action settings-action';
    settingsButton.title = '打开设置面板';
    settingsButton.setAttribute('aria-label', '打开设置面板');
    settingsButton.appendChild(iconSettings());
    settingsButton.addEventListener('click', function () {
      if (disposed) return;
      sendMessage('OPEN_OPTIONS_PAGE');
    });

    host.addEventListener('mouseenter', setExpanded);
    host.addEventListener('mouseleave', clearExpanded);
    host.addEventListener('focusin', setExpanded);

    stack.appendChild(chatButton);
    stack.appendChild(mainWrap);
    stack.appendChild(settingsButton);
    shadow.appendChild(style);
    shadow.appendChild(stack);
    document.documentElement.appendChild(host);
    positionController = window.PageAutomationPageElementPositionController.createDocked({
      window: window,
      document: document,
      storage: chrome.storage && chrome.storage.local,
      storageKey: POSITION_STORAGE_KEY,
      host: host,
      button: button,
      dockWidth: DOCK_WIDTH,
      dockHeight: DOCK_HEIGHT,
      dragSize: DRAG_SIZE,
      defaultTop: DEFAULT_TOP,
      hideUntilReady: true,
      setExpanded: setExpanded,
      clearExpanded: clearExpanded,
    });
    positionController.init();
    if (!pageConversationUnsubscribe) {
      pageConversationUnsubscribe = pageConversationEntry.subscribe(renderPageConversationState);
    }
  }

  function setExpanded() {
    if (host) host.setAttribute('data-expanded', 'true');
  }

  function renderPageConversationState(open) {
    open = open === true;
    if (!chatButton || !chatOpenIndicator) return;
    chatButton.classList.toggle('active', open);
    chatButton.title = open ? '关闭页面对话' : '打开页面对话';
    chatButton.setAttribute('aria-label', chatButton.title);
    chatButton.setAttribute('aria-pressed', open ? 'true' : 'false');
    chatOpenIndicator.hidden = !open;
  }

  function togglePageConversation() {
    if (disposed || !pageConversationEntry) return false;
    return pageConversationEntry.toggle();
  }

  function clearExpanded() {
    if (!host || (positionController && positionController.isDragging())) return;
    host.removeAttribute('data-expanded');
  }

  function renderStatus(payload) {
    payload = payload || {};
    if (!badge || !button) return;
    badge.className = 'badge';
    if (!payload.text) {
      badge.hidden = true;
      badge.textContent = '';
      button.title = '打开侧边栏 / 状态栏';
      return;
    }
    badge.hidden = false;
    badge.textContent = payload.text;
    if (payload.statusClass) badge.classList.add(payload.statusClass);
    button.title = '打开侧边栏 / 状态栏 · ' + (payload.title || payload.text);
  }

  function refreshStatus() {
    if (!floatingEntryEnabled) return;
    sendMessage('GET_FLOATING_STATUS').then(function (resp) {
      if (resp && resp.ok) renderStatus(resp.payload || {});
    });
  }

  function startPolling() {
    if (!floatingEntryEnabled || !host || pollTimer || document.hidden) return;
    refreshStatus();
    pollTimer = window.setInterval(refreshStatus, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  function syncPolling() {
    if (!floatingEntryEnabled || !host || document.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  }

  function bindOpen() {
    button.addEventListener('click', function () {
      if (disposed) return;
      if (positionController && positionController.consumeSuppressedClick()) return;
      sendMessage('TOGGLE_SIDEPANEL').then(refreshStatus);
    });
  }

  function ensureHost() {
    if (!floatingEntryEnabled || !document.documentElement || !document.body) return;
    if (host) {
      host.hidden = false;
      host.style.display = '';
      syncPolling();
      return;
    }
    createHost();
    bindOpen();
    syncPolling();
  }

  function applySystemSettings(settings) {
    if (disposed) return;
    floatingEntryEnabled = !(settings && settings.floatingEntryDisabled === true);
    if (!initialized) return;
    if (floatingEntryEnabled) {
      ensureHost();
      return;
    }
    stopPolling();
    // 系统开关关闭是全局禁用，不是用户对这个站点说"以后别开"——
    // 保留每站点的打开偏好，重新启用后面板按原偏好恢复。
    if (pageConversationEntry) pageConversationEntry.close({ preservePreference: true });
    if (host) {
      host.hidden = true;
      host.style.display = 'none';
    }
  }

  function handleSystemSettingsChange(changes, area) {
    if (area !== 'local' || !changes
        || !changes[window.PageAutomationSystemSettings.SETTINGS_KEY]) return;
    systemSettingsRevision += 1;
    applySystemSettings(window.PageAutomationSystemSettings.normalize(
      changes[window.PageAutomationSystemSettings.SETTINGS_KEY].newValue
    ));
  }

  function loadSystemSettings() {
    var revision = systemSettingsRevision;
    var storage;
    var runtime;
    try {
      storage = chrome.storage && chrome.storage.local;
      runtime = chrome.runtime;
    } catch (error) {
      return Promise.reject(error);
    }
    return window.PageAutomationSystemSettings.load(storage, runtime)
      .then(function (settings) {
        if (revision === systemSettingsRevision) applySystemSettings(settings);
      });
  }

  function clearLegacyFloatingEnabledState() {
    try {
      chrome.storage.local.remove('pageAutomationFloatingStatusEnabled');
    } catch (_) {}
  }

  function init() {
    if (disposed || initialized) return;
    if (!document.documentElement || !document.body) {
      if (!initRetryTimer) {
        initRetryTimer = window.setTimeout(function () {
          initRetryTimer = 0;
          init();
        }, 50);
      }
      return;
    }
    try {
      clearLegacyFloatingEnabledState();
      if (floatingEntryEnabled) ensureHost();
      document.addEventListener('visibilitychange', syncPolling);
      initialized = true;
      window.__pageAutomationFloatingStatusInstalled = true;
      window.__pageAutomationFloatingStatusInitializing = false;
    } catch (error) {
      destroyFloatingStatus();
      throw error;
    }
  }

  function handlePageHide(event) {
    stopPolling();
    if (!event || !event.persisted) destroyFloatingStatus();
  }

  function handlePageShow() {
    if (!disposed) syncPolling();
  }

  function destroyFloatingStatus() {
    if (disposed) return;
    disposed = true;
    stopPolling();
    if (pageConversationEntry) {
      try { pageConversationEntry.close({ preservePreference: true }); } catch (_) {}
    }
    if (pageConversationUnsubscribe) {
      try { pageConversationUnsubscribe(); } catch (_) {}
      pageConversationUnsubscribe = null;
    }
    if (initRetryTimer) {
      window.clearTimeout(initRetryTimer);
      initRetryTimer = 0;
    }
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
    if (document.removeEventListener) {
      document.removeEventListener('DOMContentLoaded', init);
      document.removeEventListener('visibilitychange', syncPolling);
    }
    try {
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.removeListener(handleSystemSettingsChange);
      }
    } catch (_) {}
    if (positionController) {
      try { positionController.destroy(); } catch (_) {}
    }
    positionController = null;
    if (host && host.parentNode) {
      try { host.parentNode.removeChild(host); } catch (_) {}
    }
    host = null;
    button = null;
    chatButton = null;
    chatOpenIndicator = null;
    settingsButton = null;
    badge = null;
    initialized = false;
    runtimeClient = null;
    pageConversationEntry = null;
    window.__pageAutomationFloatingStatusInstalled = false;
    window.__pageAutomationFloatingStatusInitializing = false;
    if (window.__pageAutomationFloatingStatusDestroy === destroyFloatingStatus) {
      try { delete window.__pageAutomationFloatingStatusDestroy; } catch (_) {
        window.__pageAutomationFloatingStatusDestroy = null;
      }
    }
  }

  window.__pageAutomationFloatingStatusDestroy = destroyFloatingStatus;
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(handleSystemSettingsChange);
  }
  loadSystemSettings().catch(function (error) {
    if (window.PageAutomationRuntimeClient.isContextInvalidatedError(error)) {
      destroyFloatingStatus();
      return;
    }
    applySystemSettings(window.PageAutomationSystemSettings.DEFAULTS);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();
