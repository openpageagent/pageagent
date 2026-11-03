// On-demand page-bottom conversation entry controlled by floating-status.
(function () {
  'use strict';

  if (window.location.protocol === 'chrome-extension:' && (window !== window.top
      || !window.AppContract || !window.AppContract.parseUrl(window.location.href, chrome.runtime.getURL('/')))) return;
  if (window.__pageAgentPageConversationInstalled || window.__pageAgentPageConversationInitializing) return;
  if (!window.PageAgentRuntimeClient || typeof window.PageAgentRuntimeClient.create !== 'function') {
    throw new Error('ui/runtime-client.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAgentPageConversationMessages
      || window.PageAgentPageConversationMessages.API_VERSION !== 1) {
    throw new Error('ui/page-conversation-message-contract.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAgentPageConversationPanel
      || typeof window.PageAgentPageConversationPanel.create !== 'function') {
    throw new Error('content/page-conversation-panel.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAgentConversationEventView
      || window.PageAgentConversationEventView.API_VERSION !== 1) {
    throw new Error('ui/conversation-event-view.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAgentConversationListView
      || window.PageAgentConversationListView.API_VERSION !== 1) {
    throw new Error('ui/conversation-list-view.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAgentConversationShared
      || window.PageAgentConversationShared.API_VERSION !== 1) {
    throw new Error('ui/conversation-shared.js must load before content/page-conversation-entry.js');
  }
  var messageContract = window.PageAgentPageConversationMessages;
  window.__pageAgentPageConversationInitializing = true;
  var disposed = false;
  var initialized = false;
  var openRequested = false;
  var initRetryTimer = 0;
  var panel = null;
  var listeners = [];
  var visibilityClient = null;
  var visibilityRevision = 0;
  var screenshotVisibilitySequence = 0;
  var screenshotVisibilityStates = Object.create(null);

  function handleScreenshotVisibility(message, sender, sendResponse) {
    if (!message || message.type !== 'PAGE_CONVERSATION_SCREENSHOT_VISIBILITY') return undefined;
    if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return undefined;
    var payload = message.payload || {};
    var action = String(payload.action || '');
    if (action === 'hide') {
      var host = document.getElementById('page-agent-page-conversation');
      var token = 'screenshot_' + (++screenshotVisibilitySequence);
      var previous = host ? {
        value: host.style.getPropertyValue('visibility'),
        priority: host.style.getPropertyPriority('visibility'),
      } : null;
      if (host) {
        screenshotVisibilityStates[token] = previous;
        host.style.setProperty('visibility', 'hidden', 'important');
      }
      sendResponse({ ok: true, token: token, found: !!host });
      return undefined;
    }
    if (action === 'restore') {
      var state = screenshotVisibilityStates[String(payload.token || '')];
      var restoreHost = document.getElementById('page-agent-page-conversation');
      if (restoreHost) {
        if (state && state.value) restoreHost.style.setProperty('visibility', state.value, state.priority || '');
        else restoreHost.style.removeProperty('visibility');
      }
      delete screenshotVisibilityStates[String(payload.token || '')];
      sendResponse({ ok: true });
      return undefined;
    }
    sendResponse({ ok: false, error: 'unsupported screenshot visibility action' });
    return undefined;
  }

  function getVisibilityClient() {
    if (visibilityClient) return visibilityClient;
    visibilityClient = window.PageAgentRuntimeClient.create(chrome.runtime, { onInvalidated: destroy });
    return visibilityClient;
  }

  function sendVisibility(type, payload) {
    var built = messageContract.request(type, payload || {});
    if (!built.ok) return Promise.resolve(built);
    try {
      return getVisibilityClient().send(built.message.type, built.message.payload).then(messageContract.response);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function persistVisibility(open) {
    return sendVisibility(messageContract.TYPES.SET_VISIBILITY, { open: open === true });
  }

  function createPanel() {
    if (disposed || !openRequested || panel || !document.documentElement || !document.body) return panel;
    var runtimeClient;
    var runtime;
    try {
      runtime = chrome.runtime;
      runtimeClient = window.PageAgentRuntimeClient.create(runtime, { onInvalidated: destroy });
    } catch (error) {
      if (window.PageAgentRuntimeClient.isContextInvalidatedError(error)) {
        destroy();
        return;
      }
      throw error;
    }
    panel = window.PageAgentPageConversationPanel.create({
      window: window,
      document: document,
      runtime: runtime,
      runtimeClient: runtimeClient,
      messageContract: window.PageAgentPageConversationMessages,
      eventView: window.PageAgentConversationEventView,
      listView: window.PageAgentConversationListView,
      conversationShared: window.PageAgentConversationShared,
      imageArtifactClient: window.PageAgentImageArtifactClient,
      positionController: window.PageAgentPageElementPositionController,
      onClose: close,
    });
    return panel;
  }

  function removePanel() {
    if (!panel) return;
    try { panel.destroy(); } catch (_) {}
    panel = null;
  }

  function isOpen() {
    return !disposed && !!panel;
  }

  function publishState() {
    var open = isOpen();
    listeners.slice().forEach(function (listener) {
      try { listener(open); } catch (_) {}
    });
  }

  function open() {
    if (disposed) return false;
    visibilityRevision += 1;
    openRequested = true;
    if (initialized) {
      try {
        createPanel();
      } catch (error) {
        openRequested = false;
        removePanel();
        publishState();
        persistVisibility(false).catch(function () {});
        throw error;
      }
    }
    publishState();
    persistVisibility(true).catch(function () {});
    return isOpen();
  }

  function close(closeOptions) {
    if (disposed) return false;
    closeOptions = closeOptions || {};
    visibilityRevision += 1;
    openRequested = false;
    removePanel();
    publishState();
    if (closeOptions.preservePreference !== true) persistVisibility(false).catch(function () {});
    return false;
  }

  function toggle() {
    return openRequested ? close() : open();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function' || disposed) return function () {};
    listeners.push(listener);
    try { listener(isOpen()); } catch (_) {}
    return function () {
      listeners = listeners.filter(function (candidate) { return candidate !== listener; });
    };
  }

  function restoreVisibility() {
    var revision = ++visibilityRevision;
    return sendVisibility(messageContract.TYPES.GET_VISIBILITY, {}).then(function (response) {
      if (disposed || revision !== visibilityRevision || !response.ok) return false;
      openRequested = !!(response.payload && response.payload.open === true);
      if (initialized) {
        if (openRequested) {
          try {
            createPanel();
          } catch (error) {
            openRequested = false;
            removePanel();
            publishState();
            persistVisibility(false).catch(function () {});
            throw error;
          }
        } else {
          removePanel();
        }
      }
      publishState();
      return isOpen();
    });
  }

  function handleVisibilityRestore() {
    if (disposed || document.hidden || !openRequested) return;
    // 旧标签页和前进/后退缓存中的面板也要遵从已保存的关闭状态。
    restoreVisibility().catch(function (error) {
      if (window.PageAgentRuntimeClient.isContextInvalidatedError(error)) destroy();
    });
  }

  function init() {
    if (disposed || initialized) return;
    if (!document.documentElement || !document.body) {
      if (!initRetryTimer) {
        initRetryTimer = window.setTimeout(function () { initRetryTimer = 0; init(); }, 50);
      }
      return;
    }
    initialized = true;
    window.__pageAgentPageConversationInstalled = true;
    window.__pageAgentPageConversationInitializing = false;
    if (openRequested) createPanel();
    publishState();
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    if (initRetryTimer) window.clearTimeout(initRetryTimer);
    initRetryTimer = 0;
    visibilityRevision += 1;
    openRequested = false;
    removePanel();
    publishState();
    listeners = [];
    document.removeEventListener('DOMContentLoaded', init);
    document.removeEventListener('visibilitychange', handleVisibilityRestore);
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handleVisibilityRestore);
    chrome.runtime.onMessage.removeListener(handleScreenshotVisibility);
    initialized = false;
    visibilityClient = null;
    screenshotVisibilityStates = Object.create(null);
    window.__pageAgentPageConversationInstalled = false;
    window.__pageAgentPageConversationInitializing = false;
  }

  function handlePageHide(event) {
    if (!event || !event.persisted) destroy();
  }

  var api = Object.freeze({
    API_VERSION: 1,
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    subscribe: subscribe,
  });
  window.PageAgentPageConversationEntry = api;
  window.__pageAgentPageConversationDestroy = destroy;
  chrome.runtime.onMessage.addListener(handleScreenshotVisibility);
  document.addEventListener('visibilitychange', handleVisibilityRestore);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handleVisibilityRestore);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  restoreVisibility().catch(function (error) {
    if (window.PageAgentRuntimeClient.isContextInvalidatedError(error)) destroy();
  });
})();
