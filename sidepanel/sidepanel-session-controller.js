// Sidepanel session list, selection, progress rendering, and runtime updates.
(function attachSidepanelSessionController(root, factory) {
  'use strict';

  function isCompatible(value) {
    return !!(value && value.API_VERSION === 1 && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = !commonJs && root && root.SidepanelSessionController;
  var api = isCompatible(existing) ? existing : factory();
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.SidepanelSessionController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var SESSION_STATUS_TEXT = {
    running: '运行中',
    success: '成功',
    failed: '失败',
    stopped: '已停止',
    idle: '待运行',
  };

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('SidepanelSessionController missing dependency: ' + name);
    return value;
  }

  function requireObject(value, name) {
    if (!value || typeof value !== 'object') throw new Error('SidepanelSessionController missing dependency: ' + name);
    return value;
  }

  function createMap() {
    return Object.create(null);
  }

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function cloneOwnData(value, seen) {
    var type = typeof value;
    if (value === null || type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
      return value;
    }
    if (type !== 'object') return undefined;

    seen = seen || (typeof WeakMap === 'function' ? new WeakMap() : null);
    if (seen && seen.has(value)) return seen.get(value);

    var out = Array.isArray(value) ? new Array(value.length) : createMap();
    if (seen) seen.set(value, out);
    Object.keys(value).forEach(function (key) {
      var descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch (_) {
        descriptor = null;
      }
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) return;
      var cloned = cloneOwnData(descriptor.value, seen);
      try {
        Object.defineProperty(out, key, {
          value: cloned,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } catch (_) {}
    });
    return out;
  }

  function create(options) {
    options = options || {};
    var documentRef = requireObject(options.document, 'document');
    var windowRef = requireObject(options.window, 'window');
    var browser = requireObject(options.browser, 'browser');
    var lifecycleApi = requireObject(options.lifecycleApi, 'lifecycleApi');
    var elements = requireObject(options.elements, 'elements');
    var sessionSelect = requireObject(elements.sessionSelect, 'elements.sessionSelect');
    var stepsContainer = requireObject(elements.stepsContainer, 'elements.stepsContainer');
    var stepsTitle = elements.stepsTitle || null;
    var outputSection = elements.outputSection || null;
    var detailsElement = elements.detailsElement || null;
    var statusIcons = requireObject(options.statusIcons, 'statusIcons');
    var statusClasses = requireObject(options.statusClasses, 'statusClasses');
    var sendMessage = requireFunction(options.sendMessage, 'sendMessage');
    var getSelectedRunTarget = requireFunction(options.getSelectedRunTarget, 'getSelectedRunTarget');
    var isConversationRunTarget = requireFunction(options.isConversationRunTarget, 'isConversationRunTarget');
    var isConversationSession = requireFunction(options.isConversationSession, 'isConversationSession');
    var isConversationRunId = requireFunction(options.isConversationRunId, 'isConversationRunId');
    var getActiveTabId = requireFunction(options.getActiveTabId, 'getActiveTabId');
    var getCurrentState = requireFunction(options.getCurrentState, 'getCurrentState');
    var renderIdleStepsForTarget = requireFunction(options.renderIdleStepsForTarget, 'renderIdleStepsForTarget');
    var idleStatusForTarget = requireFunction(options.idleStatusForTarget, 'idleStatusForTarget');
    var applySessionInputToRuntime = requireFunction(options.applySessionInputToRuntime, 'applySessionInputToRuntime');
    var setStatus = requireFunction(options.setStatus, 'setStatus');
    var escapeHtml = requireFunction(options.escapeHtml, 'escapeHtml');
    var onAssistantsChanged = requireFunction(options.onAssistantsChanged, 'onAssistantsChanged');
    var getRunEntry = requireFunction(options.getRunEntry, 'getRunEntry');
    var getLogPanel = requireFunction(options.getLogPanel, 'getLogPanel');
    var getDebugPanel = requireFunction(options.getDebugPanel, 'getDebugPanel');
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var messageContract = windowRef.PageAutomationSessionFloatingMessageContract;
    if (!messageContract || messageContract.API_VERSION !== 1) throw new Error('session/floating message contract must load before SidepanelSessionController');
    var lifecycle = lifecycleApi.create(windowRef);
    if (!windowRef.SidepanelSessionSnapshotRuntime
        || typeof windowRef.SidepanelSessionSnapshotRuntime.create !== 'function') {
      throw new Error('SidepanelSessionSnapshotRuntime must load before SidepanelSessionController');
    }
    var snapshotRuntime = windowRef.SidepanelSessionSnapshotRuntime.create({ cloneOwnData: cloneOwnData });
    if (!windowRef.SidepanelSessionStepsView || windowRef.SidepanelSessionStepsView.API_VERSION !== 1) {
      throw new Error('SidepanelSessionStepsView must load before SidepanelSessionController');
    }
    var stepsView = windowRef.SidepanelSessionStepsView.create({ container: stepsContainer, title: stepsTitle,
      escapeHtml: escapeHtml, statusClasses: statusClasses, statusIcons: statusIcons });
    if (!windowRef.SidepanelSessionStateRuntime
        || windowRef.SidepanelSessionStateRuntime.API_VERSION !== 1
        || typeof windowRef.SidepanelSessionStateRuntime.create !== 'function') {
      throw new Error('SidepanelSessionStateRuntime must load before SidepanelSessionController');
    }

    var flowSessions = [];
    var conversationSessions = [];
    var sessions = [];
    var assistants = [];
    var assistantCatalogKey = '';
    var sessionRefs = createMap();
    var refreshInFlight = createMap();
    var nodeStatusOverlays = createMap();
    var sessionOptionsRenderKey = '';
    var pinnedRunId = '';
    var currentRunId = '';
    var sessionSelectFocused = false;
    var pendingSessionOptionsRender = false;
    var renderedStepsRunId = '';
    var renderedStepsMode = '';
    var pendingStepsRunId = '';
    var pendingStepsMode = '';
    var stepsRenderRevision = 0;
    var refreshRequestId = 0;
    var flowRevision = 0;
    var conversationRevision = 0;
    var controllerGeneration = 1;
    var sessionRefreshTimer = 0;
    var conversationSessionRefreshTimer = 0;
    var stepsFallbackTimer = 0;
    var frameIds = [];
    var initialized = false;
    var destroyed = false;
    var persistWarningSignature = '';
    var persistWarningAt = 0;
    var sessionStateRuntime = windowRef.SidepanelSessionStateRuntime.create({
      storage: getSessionRefsStorageArea(),
      browserRuntime: browser.runtime || null,
      runtimeScope: browser.extension && browser.extension.inIncognitoContext ? 'incognito' : 'regular',
      clone: cloneOwnData,
      normalizeRefs: normalizeSessionRefs,
    });

    function applyPersistentSessionState(state) {
      state = state || createMap();
      sessionRefs = normalizeSessionRefs(state.refs);
      pinnedRunId = String(state.pinnedRunId || '').trim();
      currentRunId = String(state.currentRunId || '').trim() || pinnedRunId;
      sessionOptionsRenderKey = '';
    }

    function persistSessionState() {
      sessionStateRuntime.replaceRefs(sessionRefs, false);
      sessionStateRuntime.setSelection(pinnedRunId, currentRunId, false);
      var generation = controllerGeneration;
      var operation = sessionStateRuntime.persist();
      operation.then(function (result) {
        if (!isLive(generation) || !result || result.written !== true) return;
        persistWarningSignature = '';
        persistWarningAt = 0;
      }, function (error) {
        if (!isLive(generation)) return;
        var signature = String(error && error.message || error || '未知错误');
        var warningAt = now();
        if (signature === persistWarningSignature && warningAt - persistWarningAt < 2000) return;
        persistWarningSignature = signature;
        persistWarningAt = warningAt;
        var logPanel = getLogPanel();
        if (logPanel) logPanel.addLocal('保存 sidepanel 会话状态失败: ' + signature, 'system', 'warn');
      });
      return operation;
    }

    function isLive(generation) {
      return !destroyed && (generation === undefined || generation === controllerGeneration);
    }

    function rebuildSessionList() {
      sessions = snapshotRuntime.compose(flowSessions, conversationSessions);
    }

    function requestOutcome(type, payload, normalizePayload) {
      return Promise.resolve().then(function () {
        if (!isLive()) return { accepted: false, kind: 'destroyed' };
        var built = messageContract.request(type, payload);
        if (!built.ok) return built;
        return sendMessage(built.message.type, built.message.payload);
      }).then(function (response) {
        return snapshotRuntime.classifyResponse(messageContract.response(response), normalizePayload);
      }, function (error) {
        return {
          accepted: false,
          kind: 'transport-error',
          error: String(error && error.message ? error.message : (error || '消息发送失败')),
        };
      });
    }

    function registerInFlight(promise) {
      var requestId = String(++refreshRequestId);
      refreshInFlight[requestId] = promise;
      promise.then(function () {
        delete refreshInFlight[requestId];
      }, function () {
        delete refreshInFlight[requestId];
      });
      return promise;
    }

    function overlayForRun(runId) {
      if (!nodeStatusOverlays[runId]) nodeStatusOverlays[runId] = createMap();
      return nodeStatusOverlays[runId];
    }

    function mergeNodeStatusOverlay(session) {
      if (!session || !session.runId) return session;
      var overlay = nodeStatusOverlays[session.runId];
      if (!overlay) return session;
      if (session.status && session.status !== 'running') {
        delete nodeStatusOverlays[session.runId];
        return session;
      }
      var statuses = cloneOwnData(session.nodeStatuses || createMap());
      var snapshotUpdatedAt = Number(session.updatedAt || 0) || 0;
      Object.keys(overlay).forEach(function (nodeId) {
        var entry = overlay[nodeId];
        var overlayStatus = entry && typeof entry === 'object' && hasOwn(entry, 'status')
          ? entry.status
          : entry;
        var overlayUpdatedAt = entry && typeof entry === 'object'
          ? (Number(entry.updatedAt || 0) || 0)
          : 0;
        var snapshotHasNode = hasOwn(statuses, nodeId);
        var snapshotAcknowledged = snapshotHasNode && statuses[nodeId] === overlayStatus;
        var snapshotIsNewer = snapshotHasNode && snapshotUpdatedAt
          && (!overlayUpdatedAt || snapshotUpdatedAt >= overlayUpdatedAt);
        if (snapshotAcknowledged || snapshotIsNewer) {
          delete overlay[nodeId];
          return;
        }
        statuses[nodeId] = overlayStatus;
      });
      if (!Object.keys(overlay).length) delete nodeStatusOverlays[session.runId];
      session.nodeStatuses = statuses;
      return session;
    }

    function applyFlowSnapshot(outcome) {
      flowSessions = outcome.sessions.map(function (session) {
        return mergeNodeStatusOverlay(session);
      });
    }

    function applyConversationSnapshot(outcome, options) {
      options = options || {};
      if (Array.isArray(outcome.assistants)) assistants = outcome.assistants;
      conversationSessions = outcome.sessions.slice();
      var nextKey = snapshotRuntime.assistantKey(assistants);
      var changed = nextKey !== assistantCatalogKey;
      assistantCatalogKey = nextKey;
      return {
        notify: Array.isArray(outcome.assistants) && (changed || options.renderTargets),
        payload: cloneOwnData(assistants),
        meta: {
          changed: changed,
          renderTargets: !!options.renderTargets,
        },
      };
    }

    function selectedSource(runId) {
      var ref = sessionRefs[runId] || null;
      return (isConversationRunId(runId) || ref && ref.kind === 'conversation') ? 'conversation' : 'flow';
    }

    function reconcileSelection(appliedSources) {
      var selected = pinnedRunId || currentRunId || '';
      if (!selected) return false;
      if (findSessionByRunId(selected)) return false;
      var source = selectedSource(selected);
      if (!appliedSources[source]) return false;
      if (pinnedRunId === selected) pinnedRunId = '';
      if (currentRunId === selected) currentRunId = '';
      persistSessionState();
      sessionOptionsRenderKey = '';
      resetStepsRenderTracking();
      return true;
    }

    function applySnapshotTransaction(flowOutcome, conversationOutcome, options) {
      options = options || {};
      var appliedSources = { flow: false, conversation: false };
      var assistantChange = null;
      if (flowOutcome && flowOutcome.accepted) {
        applyFlowSnapshot(flowOutcome);
        appliedSources.flow = true;
      }
      if (conversationOutcome && conversationOutcome.accepted) {
        assistantChange = applyConversationSnapshot(conversationOutcome, options);
        appliedSources.conversation = true;
      }
      if (!appliedSources.flow && !appliedSources.conversation) return;
      rebuildSessionList();
      reconcileSelection(appliedSources);
      if (assistantChange && assistantChange.notify) {
        onAssistantsChanged(assistantChange.payload, assistantChange.meta);
      }
      renderAfterSnapshot({ skipOptions: !!(assistantChange && assistantChange.notify) });
    }

    function conversationIdFromRunId(runId) {
      runId = String(runId || '').trim();
      return runId.indexOf('conversation:') === 0 ? runId.slice(13) : runId;
    }

    function requestConversation(command, input) {
      return Promise.resolve(sendMessage('CONVERSATION_COMMAND', { command: command, input: input || {} })).then(function (response) {
        if (!response || response.ok !== true) {
          var error = response && response.error || {};
          var failure = new Error(error.message || error || 'Conversation command failed');
          failure.code = error.code || 'INVALID_COMMAND';
          throw failure;
        }
        return cloneOwnData(response.result);
      });
    }

    function conversationSession(runId, metadata) {
      var active = metadata.activeGeneration || createMap();
      var terminal = ['completed', 'failed', 'cancelled', 'truncated', 'blocked'].indexOf(active.state) !== -1;
      var status = !terminal ? 'running'
        : active.state === 'completed' ? 'success'
          : active.state === 'failed' || active.state === 'blocked' ? 'failed' : 'stopped';
      var ref = sessionRefs[runId] || createMap();
      var label = ref.label || metadata.conversationId || '后台任务';
      return {
        runId: runId,
        conversationId: metadata.conversationId,
        assistantId: metadata.assistantId || '',
        assistantName: '',
        flowId: 'assistant:' + String(metadata.assistantId || ''),
        flowLabel: label,
        conversationLabel: label,
        status: status,
        trigger: 'manual',
        entry: 'sidepanel',
        kind: 'conversation',
        ownerTabId: Number(ref.ownerTabId) || 0,
        originTabId: Number(ref.originTabId || ref.ownerTabId) || 0,
        originWindowId: Number(ref.originWindowId) || 0,
        windowId: Number(ref.originWindowId) || 0,
        startedAt: Number(active.startedAt) || Number(metadata.createdAt) || 0,
        endedAt: terminal ? Number(active.completedAt) || Number(metadata.updatedAt) || 0 : 0,
        input: {},
        canContinue: false,
      };
    }

    function requestConversationSession(runId) {
      var conversationId = conversationIdFromRunId(runId);
      return requestConversation('GET_CONVERSATION', { conversationId: conversationId }).then(function (metadata) {
        return conversationSession(runId, metadata);
      });
    }

    function requestConversationSessions() {
      var runIds = Object.keys(sessionRefs).filter(function (runId) {
        return isConversationRunId(runId) || sessionRefs[runId] && sessionRefs[runId].kind === 'conversation';
      });
      return Promise.all(runIds.map(function (runId) {
        var existing = findSessionByRunId(runId);
        if (existing && isConversationSession(existing) && existing.status !== 'running') {
          return Promise.resolve(existing);
        }
        return requestConversationSession(runId).catch(function (error) {
          if (error && error.code === 'CONVERSATION_NOT_FOUND') return null;
          throw error;
        });
      })).then(function (sessions) {
        return { accepted: true, kind: 'snapshot', sessions: sessions.filter(Boolean) };
      }, function (error) {
        return { accepted: false, kind: 'business-error', error: error && error.message || String(error) };
      });
    }

    function refreshSessions(options) {
      options = options || {};
      if (!isLive()) return Promise.resolve({ destroyed: true });
      var generation = controllerGeneration;
      var conversationOnly = options.conversationOnly === true;
      var requestedFlowRevision = conversationOnly ? 0 : ++flowRevision;
      var requestedConversationRevision = ++conversationRevision;
      var flowRequest = conversationOnly
        ? Promise.resolve(null)
        : requestOutcome('GET_SESSIONS', undefined, snapshotRuntime.normalizeFlowPayload);
      var conversationRequest = requestConversationSessions();

      var promise = Promise.all([flowRequest, conversationRequest]).then(function (results) {
        if (!isLive(generation)) return { stale: true };
        var flowOutcome = requestedFlowRevision && requestedFlowRevision === flowRevision ? results[0] : null;
        var conversationOutcome = requestedConversationRevision === conversationRevision ? results[1] : null;
        applySnapshotTransaction(flowOutcome, conversationOutcome);
        return {
          flow: flowOutcome,
          conversation: conversationOutcome,
          stale: !flowOutcome && !conversationOutcome,
        };
      });
      return registerInFlight(promise);
    }

    function scheduleSessionRefresh() {
      if (!isLive() || sessionRefreshTimer) return;
      sessionRefreshTimer = windowRef.setTimeout(function () {
        sessionRefreshTimer = 0;
        if (isLive()) refreshSessions();
      }, 120);
    }

    function scheduleConversationSessionRefresh() {
      if (!isLive() || conversationSessionRefreshTimer) return;
      conversationSessionRefreshTimer = windowRef.setTimeout(function () {
        conversationSessionRefreshTimer = 0;
        if (isLive()) refreshSessions({ conversationOnly: true });
      }, 80);
    }

    function sessionTabIdMap(session) {
      var map = createMap();
      if (!session) return map;
      if (session.ownerTabId) map[session.ownerTabId] = true;
      if (session.boundTabId) map[session.boundTabId] = true;
      (session.tabIds || []).forEach(function (tabId) {
        if (tabId) map[tabId] = true;
      });
      (session.occupiedTabIds || []).forEach(function (tabId) {
        if (tabId) map[tabId] = true;
      });
      var usage = session.tabUsage || createMap();
      Object.keys(usage).forEach(function (key) {
        var item = usage[key] || createMap();
        if (item.tabId) map[item.tabId] = true;
      });
      return map;
    }

    function isSessionUsingTab(session, tabId) {
      if (!session || !tabId) return false;
      return !!sessionTabIdMap(session)[tabId];
    }

    function findRunningOccupancyForTab(tabId) {
      if (!tabId) return null;
      var running = sessions.filter(function (session) {
        return session.status === 'running' && isSessionUsingTab(session, tabId);
      });
      return running.find(function (session) {
        return session.kind === 'flowGroup';
      }) || running[0] || null;
    }

    function findRunningSessionForActiveTab() {
      var tabId = getActiveTabId();
      if (!tabId) return null;
      var running = sessions.filter(function (session) {
        return session.status === 'running'
          && (Number(session.originTabId) === tabId || Number(session.ownerTabId) === tabId);
      });
      return running.find(function (session) {
        return session.kind === 'flowGroup';
      }) || running[0] || null;
    }

    function findRunningOccupancyForActiveTab() {
      var tabId = getActiveTabId();
      return tabId ? findRunningOccupancyForTab(tabId) : null;
    }

    function isSidepanelSessionReferenced(runId) {
      runId = String(runId || '').trim();
      return !!(runId && sessionRefs[runId]);
    }

    function isSidepanelOwnedSession(session) {
      return !!(session && (session.entry === 'sidepanel' || isSidepanelSessionReferenced(session.runId)));
    }

    function getVisibleSessions() {
      return sessions.filter(function (session) {
        return !!(session && session.runId && isSidepanelSessionReferenced(session.runId));
      });
    }

    function findSessionByRunId(runId) {
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i] && sessions[i].runId === runId) return sessions[i];
      }
      return null;
    }

    function pickCurrentSession() {
      var visibleSessions = getVisibleSessions();
      var i;
      if (pinnedRunId) {
        for (i = 0; i < visibleSessions.length; i++) {
          if (visibleSessions[i].runId === pinnedRunId) return visibleSessions[i];
        }
        return null;
      }
      if (currentRunId) {
        for (i = 0; i < visibleSessions.length; i++) {
          if (visibleSessions[i].runId === currentRunId) return visibleSessions[i];
        }
      }
      return null;
    }

    function syncRunningSelectionForActiveTab() {
      var activeRunning = findRunningSessionForActiveTab() || findRunningOccupancyForActiveTab();
      if (activeRunning && isSidepanelOwnedSession(activeRunning)) {
        if (pinnedRunId === activeRunning.runId && currentRunId === activeRunning.runId) return false;
        rememberSessionRef(activeRunning.runId, activeRunning);
        pinnedRunId = activeRunning.runId;
        currentRunId = activeRunning.runId;
        persistSessionState();
        return true;
      }
      var selected = pickCurrentSession();
      if (!selected || selected.status !== 'running') return false;
      pinnedRunId = '';
      currentRunId = '';
      persistSessionState();
      return true;
    }

    function shouldFollowRunEvent(payload) {
      payload = payload || createMap();
      var runId = payload.runId || payload.sessionId || '';
      if (!runId) return false;
      if (pinnedRunId && pinnedRunId !== runId) return false;
      var activeTabId = getActiveTabId();
      var originTabId = Number(payload.originTabId) || 0;
      var ownerTabId = Number(payload.ownerTabId) || 0;
      if (activeTabId && (originTabId || ownerTabId)
          && originTabId !== activeTabId && ownerTabId !== activeTabId) return false;
      if (!currentRunId || currentRunId === runId) return true;
      var current = findSessionByRunId(currentRunId);
      return !current || current.status !== 'running';
    }

    function followRunFromEvent(payload, options) {
      payload = payload || createMap();
      options = options || {};
      var runId = payload.runId || payload.sessionId || '';
      if (!shouldFollowRunEvent(payload)) return;
      if (!options.showLoading && !isSidepanelSessionReferenced(runId)
        && pinnedRunId !== runId && currentRunId !== runId) return;
      rememberSessionRef(runId, payload);
      currentRunId = runId;
      persistSessionState();
      ensurePendingSessionOption(runId, payload);
      syncSessionSelectValue();
      if (options.showLoading) renderPendingRunLoading(runId, payload);
    }

    function isSidepanelAutoRunStartPayload(payload) {
      payload = payload || createMap();
      var runEntry = getRunEntry();
      return payload.entry === 'sidepanel'
        && !!(runEntry && runEntry.hasActiveRunForCurrentTarget());
    }

    function conversationSessionStatusText(session) {
      if (!isConversationSession(session)) return '';
      if (session.status === 'running') return '后台运行中';
      return SESSION_STATUS_TEXT[session.status] || session.status || '';
    }

    function syncSessionSelectValue() {
      if (sessionSelectFocused) return;
      var selected = pinnedRunId || currentRunId || '';
      if (!selected) {
        sessionSelect.value = '';
        return;
      }
      var exists = Array.prototype.some.call(sessionSelect.options, function (option) {
        return option.value === selected;
      });
      sessionSelect.value = exists ? selected : '';
    }

    function sessionEmptyOptionLabel() {
      return '未运行';
    }

    function appendSessionEmptyOption() {
      var option = documentRef.createElement('option');
      option.value = '';
      option.textContent = sessionEmptyOptionLabel();
      sessionSelect.appendChild(option);
    }

    function pendingSessionLabel(runId, payload) {
      runId = String(runId || '').trim();
      payload = payload || createMap();
      var target = getSelectedRunTarget();
      var label = payload.flowLabel || payload.conversationLabel || payload.label
        || (target && target.label) || runId || '运行会话';
      var status = payload.status ? (SESSION_STATUS_TEXT[payload.status] || payload.status) : '加载中';
      return label + ' · ' + status + (isConversationRunId(runId) || isConversationRunTarget(target) ? ' · 后台任务' : '');
    }

    function ensurePendingSessionOption(runId, payload) {
      runId = String(runId || '').trim();
      if (!runId) return;
      var exists = Array.prototype.some.call(sessionSelect.options, function (option) {
        return option.value === runId;
      });
      if (exists) return;
      var option = documentRef.createElement('option');
      option.value = runId;
      option.textContent = pendingSessionLabel(runId, payload);
      sessionSelect.appendChild(option);
    }

    function renderSessionOptions(options) {
      options = options || {};
      if (sessionSelectFocused && !options.force) {
        pendingSessionOptionsRender = true;
        return;
      }
      pendingSessionOptionsRender = false;
      var visibleSessions = getVisibleSessions();
      var nextRenderKey = sessionEmptyOptionLabel() + '\u0003' + visibleSessions.map(function (session) {
        return [
          session.runId || '',
          session.flowLabel || session.conversationLabel || '',
          session.status || '',
          String(session.startedAt || ''),
          String(session.ownerTabId || ''),
        ].join('\u0001');
      }).join('\u0002');
      if (!options.force && nextRenderKey === sessionOptionsRenderKey) {
        ensurePendingSessionOption(pinnedRunId || currentRunId || '');
        syncSessionSelectValue();
        return;
      }
      sessionOptionsRenderKey = nextRenderKey;
      sessionSelect.innerHTML = '';
      appendSessionEmptyOption();

      for (var i = 0; i < visibleSessions.length; i++) {
        var session = visibleSessions[i];
        var option = documentRef.createElement('option');
        option.value = session.runId;
        var time = session.startedAt ? new Date(session.startedAt).toLocaleTimeString() : '';
        var label = session.flowLabel || session.conversationLabel || session.runId || '运行会话';
        option.textContent = label + ' · ' + (conversationSessionStatusText(session)
          || SESSION_STATUS_TEXT[session.status] || session.status)
          + (session.kind === 'conversation' ? ' · 后台任务' : '')
          + (session.ownerTabId && session.kind !== 'conversation' ? ' · tab ' + session.ownerTabId : '')
          + (session.runTabMode ? ' · ' + session.runTabMode : '')
          + (time ? ' · ' + time : '');
        sessionSelect.appendChild(option);
      }
      ensurePendingSessionOption(pinnedRunId || currentRunId || '');
      syncSessionSelectValue();
    }

    function removeFrameId(id) {
      var index = frameIds.indexOf(id);
      if (index >= 0) frameIds.splice(index, 1);
    }

    function requestFrame(callback) {
      if (typeof windowRef.requestAnimationFrame !== 'function') return 0;
      var id = windowRef.requestAnimationFrame(function () {
        removeFrameId(id);
        callback();
      });
      frameIds.push(id);
      return id;
    }

    function cancelPendingFrames() {
      if (typeof windowRef.cancelAnimationFrame === 'function') {
        while (frameIds.length) {
          try { windowRef.cancelAnimationFrame(frameIds.pop()); } catch (_) {}
        }
      } else {
        frameIds = [];
      }
      if (stepsFallbackTimer) {
        windowRef.clearTimeout(stepsFallbackTimer);
        stepsFallbackTimer = 0;
      }
    }

    function stepsModeForSession(session) {
      return isConversationSession(session) ? 'conversation' : 'flow';
    }

    function clearPendingStepsRender() {
      stepsRenderRevision += 1;
      pendingStepsRunId = '';
      pendingStepsMode = '';
      cancelPendingFrames();
    }

    function resetStepsRenderTracking() {
      clearPendingStepsRender();
      renderedStepsRunId = '';
      renderedStepsMode = '';
    }

    function isPendingStepsSession(session) {
      return !!(session && pendingStepsRunId === session.runId
        && pendingStepsMode === stepsModeForSession(session));
    }

    function shouldDeferStepsRender(session) {
      if (!session) return false;
      var mode = stepsModeForSession(session);
      if (isPendingStepsSession(session)) return true;
      return renderedStepsRunId !== session.runId || renderedStepsMode !== mode;
    }

    function updateStepsTitle(session) {
      var conversationMode = isConversationSession(session)
        || (!session && isConversationRunTarget(getSelectedRunTarget()));
      stepsView.setTitle(conversationMode);
    }

    function renderStepsLoading(session) {
      updateStepsTitle(session);
      var conversationMode = isConversationSession(session);
      var text = conversationMode ? '正在启动后台任务' : '正在加载步骤进度';
      var label = session && (session.conversationLabel || session.flowLabel || session.runId) || '';
      stepsView.renderLoading({ conversationMode: conversationMode, text: text, label: label });
    }

    function renderPendingRunLoading(runId, payload) {
      runId = String(runId || '').trim();
      if (!runId) return;
      resetStepsRenderTracking();
      payload = payload || createMap();
      var target = getSelectedRunTarget();
      renderStepsLoading({
        runId: runId,
        kind: isConversationRunId(runId) || isConversationRunTarget(target)
          ? 'conversation'
          : (target && target.type === 'flowGroup' ? 'flowGroup' : 'flow'),
        flowLabel: payload.flowLabel || payload.label || (target && target.label) || runId,
        conversationLabel: payload.conversationLabel || payload.label || (target && target.label) || runId,
      });
    }

    function deferSessionStepsRender(session) {
      if (!session) return;
      clearPendingStepsRender();
      var mode = stepsModeForSession(session);
      var runId = session.runId || '';
      pendingStepsRunId = runId;
      pendingStepsMode = mode;
      var revision = stepsRenderRevision;
      var generation = controllerGeneration;
      renderStepsLoading(session);

      function renderLatest() {
        if (!isLive(generation) || revision !== stepsRenderRevision) return;
        var latest = findSessionByRunId(runId) || session;
        if (!latest || latest.runId !== currentRunId || stepsModeForSession(latest) !== mode) return;
        renderSessionStepsNow(latest);
      }

      if (typeof windowRef.requestAnimationFrame === 'function') {
        requestFrame(function () {
          if (!isLive(generation) || revision !== stepsRenderRevision) return;
          requestFrame(renderLatest);
        });
      } else {
        stepsFallbackTimer = windowRef.setTimeout(function () {
          stepsFallbackTimer = 0;
          renderLatest();
        }, 16);
      }
    }

    function renderSessionSteps(session) {
      var nodes = session.nodes || [];
      var statuses = session.nodeStatuses || createMap();
      var canResumeNodes = session.kind !== 'flowGroup' && session.kind !== 'conversation';
      stepsView.renderFlow({ runId: session.runId, showContinueBanner: canResumeNodes && session.status === 'stopped' && session.canContinue,
        showNodeResume: canResumeNodes && session.status !== 'running', nodes: nodes.map(function (node, index) { return {
          nodeId: node.nodeId, title: node.title, displayOrder: node.displayOrder || (index + 1), status: statuses[node.nodeId] || 'pending',
        }; }) });
    }

    function renderConversationStatus(session) {
      var status = session && session.status || 'running';
      var text = status === 'running' ? '后台运行中，等待完成'
        : status === 'success' ? '后台运行已完成'
          : status === 'failed' ? '后台运行失败' : '后台运行已停止';
      stepsView.renderBackgroundStatus({ status: status === 'success' ? 'completed' : status, text: text });
    }

    function renderSessionStepsNow(session) {
      if (!session) return;
      clearPendingStepsRender();
      if (isConversationSession(session)) {
        updateStepsTitle(session);
        renderConversationStatus(session);
      } else {
        renderSessionSteps(session);
      }
      renderedStepsRunId = session.runId || '';
      renderedStepsMode = stepsModeForSession(session);
      pendingStepsRunId = '';
      pendingStepsMode = '';
    }

    function runTabModeShortLabel(mode) {
      var labels = {
        fixedCurrentTab: '当前',
        reuseOpenTab: '复用',
        fixedNewTab: '新开',
      };
      return labels[mode] || mode || '';
    }

    function renderSessionDetails(session) {
      if (!detailsElement) return;
      var details = [];
      var titleDetails = [];
      if (!session) {
        detailsElement.textContent = '';
        detailsElement.title = '';
        return;
      }
      if (session.kind === 'flowGroup') details.push('组');
      if (session.kind === 'conversation') details.push('后台任务');
      if (session.parentFlowGroupLabel) details.push('子');
      if (session.runTabMode && session.kind !== 'conversation') {
        details.push(runTabModeShortLabel(session.runTabMode));
      }
      if (session.kind === 'conversation' && session.assistantName) {
        titleDetails.push('助手: ' + session.assistantName);
      }
      if (session.kind === 'conversation' && session.conversationLabel) {
        titleDetails.push('任务: ' + session.conversationLabel);
      }
      if (session.windowId) {
        titleDetails.push('窗口 #' + session.windowId + (session.incognito ? ' (隐私)' : ''));
      }
      var tabUsage = session.tabUsage || createMap();
      var usageCount = Object.keys(tabUsage).length;
      if (usageCount) details.push(usageCount + ' tab');
      var keepAlive = session.keepAlive || createMap();
      var keepAliveCount = Object.keys(keepAlive).length;
      if (keepAliveCount > 0) {
        var states = { on: 0, off: 0, failed: 0 };
        Object.keys(keepAlive).forEach(function (tabId) {
          states[keepAlive[tabId]] = (states[keepAlive[tabId]] || 0) + 1;
        });
        var parts = [];
        if (states.on) parts.push(states.on + '个活跃');
        if (states.off) parts.push(states.off + '个附加');
        if (states.failed) parts.push(states.failed + '个失败');
        titleDetails.push('防节流保活: ' + parts.join(', '));
      }
      detailsElement.textContent = details.length ? details.join(' · ') : '';
      detailsElement.title = titleDetails.concat(details).join(' · ');
    }

    function updateAdaptiveUi(session) {
      var conversationMode = isConversationSession(session)
        || (!session && isConversationRunTarget(getSelectedRunTarget()));
      var debugTab = outputSection ? outputSection.querySelector('[data-output-tab="debug"]') : null;
      if (debugTab) debugTab.hidden = !!conversationMode;
      var debugPanel = getDebugPanel();
      if (conversationMode && debugPanel && debugPanel.getOutputTab() === 'debug') {
        debugPanel.switchOutputTab('log');
      }
    }

    function updateControlStates(session) {
      updateAdaptiveUi(session);
      var runEntry = getRunEntry();
      if (runEntry) runEntry.updateControlStates(session);
    }

    function renderCurrentSession() {
      if (!isLive()) return;
      var session = pickCurrentSession();
      currentRunId = session ? session.runId : (pinnedRunId || '');
      if (currentRunId) ensurePendingSessionOption(currentRunId, session);
      syncSessionSelectValue();
      updateStepsTitle(session);
      if (!session) {
        if (currentRunId) {
          ensurePendingSessionOption(currentRunId);
          renderPendingRunLoading(currentRunId);
          renderSessionDetails(null);
          applySessionInputToRuntime(null);
          updateControlStates(null);
          return;
        }
        resetStepsRenderTracking();
        var target = getSelectedRunTarget();
        renderIdleStepsForTarget(target, getCurrentState());
        setStatus(idleStatusForTarget(target), '');
        renderSessionDetails(null);
        applySessionInputToRuntime(null);
        updateControlStates(null);
        return;
      }

      if (shouldDeferStepsRender(session)) deferSessionStepsRender(session);
      else renderSessionStepsNow(session);
      setStatus(conversationSessionStatusText(session)
        || SESSION_STATUS_TEXT[session.status] || session.status);
      renderSessionDetails(session);
      applySessionInputToRuntime(session);
      updateControlStates(session);
      var debugPanel = getDebugPanel();
      if (debugPanel && debugPanel.getOutputTab() === 'debug') debugPanel.refresh();
    }

    function renderAfterSnapshot(options) {
      options = options || {};
      var selectionChanged = syncRunningSelectionForActiveTab();
      if (!options.skipOptions || selectionChanged) renderSessionOptions({ force: selectionChanged });
      var session = pickCurrentSession();
      var nextRunId = session ? session.runId : '';
      if (nextRunId !== currentRunId) {
        renderCurrentSession();
        return;
      }
      if (!session) {
        renderCurrentSession();
        return;
      }
      if (!isPendingStepsSession(session)) renderSessionStepsNow(session);
      renderSessionDetails(session);
      setStatus(conversationSessionStatusText(session)
        || SESSION_STATUS_TEXT[session.status] || session.status);
      applySessionInputToRuntime(session);
      updateControlStates(session);
      var debugPanel = getDebugPanel();
      if (debugPanel && debugPanel.getOutputTab() === 'debug') debugPanel.refresh();
    }

    function findStepElement(nodeId) {
      var id = String(nodeId || '');
      if (windowRef.CSS && windowRef.CSS.escape) {
        return documentRef.querySelector('[data-node-id="' + windowRef.CSS.escape(id) + '"]');
      }
      var elementsWithId = documentRef.querySelectorAll('[data-node-id]');
      for (var i = 0; i < elementsWithId.length; i++) {
        if (elementsWithId[i].getAttribute('data-node-id') === id) return elementsWithId[i];
      }
      return null;
    }

    function updateNodeStatus(nodeId, status) {
      var element = findStepElement(nodeId);
      if (!element) return false;
      element.className = 'step-item ' + (statusClasses[status] || '');
      var iconElement = element.querySelector('.step-icon');
      if (iconElement) iconElement.textContent = statusIcons[status] || '?';
      return true;
    }

    function applySessionNodeStatus(payload) {
      var runId = String(payload && payload.runId || '').trim();
      var nodeId = String(payload && payload.nodeId || '').trim();
      if (!runId || !nodeId) return false;
      var overlay = overlayForRun(runId);
      overlay[nodeId] = {
        status: payload.status,
        updatedAt: Number(payload.updatedAt || payload.at || 0) || now(),
      };
      var session = findSessionByRunId(runId);
      if (session) {
        var statuses = cloneOwnData(session.nodeStatuses || createMap());
        statuses[nodeId] = payload.status;
        session.nodeStatuses = statuses;
      }
      if (runId !== currentRunId) return !!session;
      var updated = updateNodeStatus(nodeId, payload.status);
      if (!updated) scheduleSessionRefresh();
      return updated;
    }

    function getSessionRefsStorageArea() {
      if (browser.storage && browser.storage.local) return browser.storage.local;
      if (browser.storage && browser.storage.session) return browser.storage.session;
      return null;
    }

    function normalizeSessionRefs(raw) {
      raw = cloneOwnData(raw);
      var refs = createMap();
      if (Array.isArray(raw)) {
        raw.forEach(function (item) {
          var runId = String(item && (item.runId || item.id) || item || '').trim();
          if (runId) refs[runId] = { runId: runId };
        });
        return refs;
      }
      if (!raw || typeof raw !== 'object') return refs;
      Object.keys(raw).forEach(function (key) {
        var value = raw[key];
        var runId = String(value && value.runId || key || '').trim();
        if (!runId) return;
        var next = createMap();
        next.runId = runId;
        if (value && typeof value === 'object') {
          Object.keys(value).forEach(function (valueKey) {
            next[valueKey] = cloneOwnData(value[valueKey]);
          });
        }
        refs[runId] = next;
      });
      return refs;
    }

    function loadSessionRefs(callback) {
      callback = typeof callback === 'function' ? callback : function () {};
      var generation = controllerGeneration;
      return sessionStateRuntime.load().then(function (state) {
        if (!isLive(generation)) return;
        applyPersistentSessionState(state);
        callback();
      }, function (error) {
        if (!isLive(generation)) return;
        callback(error);
      });
    }

    function persistSessionRefs() {
      persistSessionState();
    }

    function sessionRefMeta(runId, payload) {
      payload = cloneOwnData(payload) || createMap();
      var target = getSelectedRunTarget();
      var meta = createMap();
      meta.runId = runId;
      meta.label = payload.flowLabel || payload.conversationLabel || payload.label
        || (target && target.label) || '';
      meta.kind = payload.kind || (isConversationRunId(runId) || isConversationRunTarget(target)
        ? 'conversation'
        : (target && target.type === 'flowGroup' ? 'flowGroup' : 'flow'));
      meta.ownerTabId = Number(payload.ownerTabId) || 0;
      meta.originTabId = Number(payload.originTabId || payload.ownerTabId) || 0;
      meta.originWindowId = Number(payload.originWindowId || payload.windowId) || 0;
      meta.addedAt = now();
      return meta;
    }

    function rememberSessionRef(runId, payload) {
      runId = String(runId || '').trim();
      if (!runId) return false;
      var next = sessionRefMeta(runId, payload);
      var previous = sessionRefs[runId];
      if (previous) {
        if (!next.ownerTabId) next.ownerTabId = Number(previous.ownerTabId) || 0;
        if (!next.originTabId) next.originTabId = Number(previous.originTabId || previous.ownerTabId) || 0;
        if (!next.originWindowId) next.originWindowId = Number(previous.originWindowId) || 0;
        if (previous.addedAt) next.addedAt = previous.addedAt;
        if (previous.label === next.label
            && previous.kind === next.kind
            && (Number(previous.ownerTabId) || 0) === next.ownerTabId
            && (Number(previous.originTabId) || 0) === next.originTabId
            && (Number(previous.originWindowId) || 0) === next.originWindowId) return false;
      }
      sessionRefs[runId] = next;
      sessionOptionsRenderKey = '';
      persistSessionRefs();
      return true;
    }

    function clearSessionRefs() {
      var count = Object.keys(sessionRefs).length;
      sessionRefs = createMap();
      sessionOptionsRenderKey = '';
      persistSessionRefs();
      return count;
    }

    function setPinnedRunId(runId, meta) {
      runId = String(runId || '').trim();
      if (!runId) return false;
      pinnedRunId = runId;
      currentRunId = runId;
      rememberSessionRef(runId, meta || createMap());
      ensurePendingSessionOption(runId, meta);
      syncSessionSelectValue();
      renderPendingRunLoading(runId, meta);
      persistSessionState();
      return true;
    }

    function onSessionFocusChange(focused) {
      sessionSelectFocused = !!focused;
      if (focused) return;
      if (pendingSessionOptionsRender) renderSessionOptions({ force: true });
      else syncSessionSelectValue();
    }

    function blockSessionMutation(actionLabel) {
      var runningSession = findRunningSessionForActiveTab() || findRunningOccupancyForActiveTab();
      if (!runningSession) return false;
      syncSessionSelectValue();
      setStatus('运行中，不能' + actionLabel, '');
      var logPanel = getLogPanel();
      if (logPanel) logPanel.addLocal('运行中不能' + actionLabel + '，请先停止当前运行', 'run', 'warn');
      updateControlStates(runningSession || pickCurrentSession());
      return true;
    }

    function onSessionChange(runId) {
      if (blockSessionMutation('切换会话')) return false;
      pinnedRunId = String(runId || '').trim();
      currentRunId = pinnedRunId;
      persistSessionState();
      renderCurrentSession();
      return true;
    }

    function onTargetChanged() {
      pinnedRunId = '';
      currentRunId = '';
      persistSessionState();
      sessionOptionsRenderKey = '';
      renderSessionOptions({ force: true });
      renderSessionDetails(null);
      applySessionInputToRuntime(null);
      resetStepsRenderTracking();
      updateControlStates(null);
    }

    function onActiveContextChanged() {
      if (!syncRunningSelectionForActiveTab()) currentRunId = pinnedRunId || '';
      resetStepsRenderTracking();
      setStatus('空闲', '');
      renderSessionDetails(null);
      applySessionInputToRuntime(null);
    }

    function onClearSessions() {
      if (blockSessionMutation('清除会话')) return false;
      var cleared = clearSessionRefs();
      pinnedRunId = '';
      currentRunId = '';
      sessionSelect.value = '';
      persistSessionState();
      resetStepsRenderTracking();
      renderSessionOptions({ force: true });
      renderCurrentSession();
      setStatus(cleared ? '已清理' : '没有可清理项', '');
      var logPanel = getLogPanel();
      if (logPanel) {
        logPanel.addLocal(
          '已清理 sidepanel 会话指向 ' + cleared + ' 个；未删除流程报告或对话详情',
          'run',
          'info'
        );
      }
      return true;
    }

    function focusRun(payload) {
      payload = payload || createMap();
      var originTabId = Number(payload.originTabId) || 0;
      var ownerTabId = Number(payload.ownerTabId) || 0;
      var activeTabId = Number(getActiveTabId()) || 0;
      if (activeTabId && (originTabId || ownerTabId)
          && originTabId !== activeTabId && ownerTabId !== activeTabId) return;
      var runId = String(payload.runId || payload.sessionId || '').trim();
      if (!runId) return;
      var alreadyFocused = pinnedRunId === runId && currentRunId === runId;
      var refChanged = rememberSessionRef(runId, payload);
      pinnedRunId = runId;
      currentRunId = runId;
      persistSessionState();
      ensurePendingSessionOption(runId, payload);
      syncSessionSelectValue();
      var session = findSessionByRunId(runId);
      if (!alreadyFocused || refChanged) renderCurrentSession();
      if (isConversationRunId(runId) && (!session || session.status === 'running')) scheduleConversationSessionRefresh();
    }

    function handleRuntimeMessage(message) {
      if (!isLive() || !message || typeof message !== 'object') return;
      var payload = cloneOwnData(message.payload) || createMap();
      switch (message.type) {
        case 'NODE_STATUS_CHANGE':
          if (payload.runId) applySessionNodeStatus(payload);
          break;
        case 'SESSIONS_UPDATED':
          scheduleSessionRefresh();
          break;
        case 'SIDEPANEL_FOCUS_RUN':
          focusRun(payload);
          break;
        case 'AUTO_RUN_START':
          if (payload.runId && isSidepanelAutoRunStartPayload(payload)) {
            followRunFromEvent(payload, { showLoading: true });
          }
          refreshSessions();
          break;
        case 'AUTO_RUN_COMPLETE':
          if (payload.runId) followRunFromEvent(payload);
          refreshSessions();
          break;
      }
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      lifecycle.subscribe(browser.runtime && browser.runtime.onMessage, handleRuntimeMessage);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      controllerGeneration += 1;
      flowRevision += 1;
      conversationRevision += 1;
      if (sessionRefreshTimer) windowRef.clearTimeout(sessionRefreshTimer);
      if (conversationSessionRefreshTimer) windowRef.clearTimeout(conversationSessionRefreshTimer);
      sessionRefreshTimer = 0;
      conversationSessionRefreshTimer = 0;
      resetStepsRenderTracking();
      lifecycle.destroy();
      stepsView.destroy();
      sessionStateRuntime.destroy();
      refreshInFlight = createMap();
    }

    return {
      init: init,
      destroy: destroy,
      loadSessionRefs: loadSessionRefs,
      refreshSessions: refreshSessions,
      renderSessionOptions: renderSessionOptions,
      resetStepsRenderTracking: resetStepsRenderTracking,
      updateNodeStatus: updateNodeStatus,
      findSessionByRunId: findSessionByRunId,
      findRunningSessionForActiveTab: findRunningSessionForActiveTab,
      findRunningOccupancyForActiveTab: findRunningOccupancyForActiveTab,
      isSidepanelOwnedSession: isSidepanelOwnedSession,
      isActiveTabRunOccupied: function () {
        var current = currentRunId ? findSessionByRunId(currentRunId) : null;
        var occupancy = findRunningOccupancyForActiveTab();
        return !!(occupancy && (!current || current.status !== 'running'
          || occupancy.runId !== current.runId));
      },
      getCurrentRunId: function () { return currentRunId; },
      hasCurrentRun: function () { return !!currentRunId; },
      setPinnedRunId: setPinnedRunId,
      getCurrentSession: function () { return pickCurrentSession(); },
      onSessionFocusChange: onSessionFocusChange,
      onSessionChange: onSessionChange,
      onTargetChanged: onTargetChanged,
      onActiveContextChanged: onActiveContextChanged,
      onClearSessions: onClearSessions,
      refreshControlStates: function () {
        updateControlStates(pickCurrentSession());
      },
    };
  }

  return {
    API_VERSION: API_VERSION,
    create: create,
  };
});
