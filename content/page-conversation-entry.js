// On-demand page-bottom conversation entry controlled by floating-status.
(function () {
  'use strict';

  if (window.__pageAutomationPageConversationInstalled || window.__pageAutomationPageConversationInitializing) return;
  if (!window.PageAutomationRuntimeClient || typeof window.PageAutomationRuntimeClient.create !== 'function') {
    throw new Error('ui/runtime-client.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAutomationPageConversationMessages
      || window.PageAutomationPageConversationMessages.API_VERSION !== 1) {
    throw new Error('ui/page-conversation-message-contract.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAutomationPageConversationPanel
      || typeof window.PageAutomationPageConversationPanel.create !== 'function') {
    throw new Error('content/page-conversation-panel.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAutomationConversationEventView
      || window.PageAutomationConversationEventView.API_VERSION !== 1) {
    throw new Error('ui/conversation-event-view.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAutomationConversationListView
      || window.PageAutomationConversationListView.API_VERSION !== 1) {
    throw new Error('ui/conversation-list-view.js must load before content/page-conversation-entry.js');
  }
  if (!window.PageAutomationConversationShared
      || window.PageAutomationConversationShared.API_VERSION !== 1) {
    throw new Error('ui/conversation-shared.js must load before content/page-conversation-entry.js');
  }
  var messageContract = window.PageAutomationPageConversationMessages;
  window.__pageAutomationPageConversationInitializing = true;
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
      var host = document.getElementById('page-automation-page-conversation');
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
      var restoreHost = document.getElementById('page-automation-page-conversation');
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
    visibilityClient = window.PageAutomationRuntimeClient.create(chrome.runtime, { onInvalidated: destroy });
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
      runtimeClient = window.PageAutomationRuntimeClient.create(runtime, { onInvalidated: destroy });
    } catch (error) {
      if (window.PageAutomationRuntimeClient.isContextInvalidatedError(error)) {
        destroy();
        return;
      }
      throw error;
    }
    panel = window.PageAutomationPageConversationPanel.create({
      window: window,
      document: document,
      runtime: runtime,
      runtimeClient: runtimeClient,
      messageContract: window.PageAutomationPageConversationMessages,
      eventView: window.PageAutomationConversationEventView,
      listView: window.PageAutomationConversationListView,
      conversationShared: window.PageAutomationConversationShared,
      imageArtifactClient: window.PageAutomationImageArtifactClient,
      positionController: window.PageAutomationPageElementPositionController,
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
    var revision = visibilityRevision;
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

  function init() {
    if (disposed || initialized) return;
    if (!document.documentElement || !document.body) {
      if (!initRetryTimer) {
        initRetryTimer = window.setTimeout(function () { initRetryTimer = 0; init(); }, 50);
      }
      return;
    }
    initialized = true;
    window.__pageAutomationPageConversationInstalled = true;
    window.__pageAutomationPageConversationInitializing = false;
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
    window.removeEventListener('pagehide', handlePageHide);
    chrome.runtime.onMessage.removeListener(handleScreenshotVisibility);
    initialized = false;
    visibilityClient = null;
    screenshotVisibilityStates = Object.create(null);
    window.__pageAutomationPageConversationInstalled = false;
    window.__pageAutomationPageConversationInitializing = false;
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
  window.PageAutomationPageConversationEntry = api;
  window.__pageAutomationPageConversationDestroy = destroy;
  chrome.runtime.onMessage.addListener(handleScreenshotVisibility);
  window.addEventListener('pagehide', handlePageHide);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  restoreVisibility().catch(function (error) {
    if (window.PageAutomationRuntimeClient.isContextInvalidatedError(error)) destroy();
  });
})();
