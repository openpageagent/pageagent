// Sidepanel run, stop, continue, resume, and action listener controller.
(function attachSidepanelRunEntry(root, factory) {
  'use strict';

  var commonJs = typeof module === 'object' && module.exports;
  var lifecycleApi = root && root.PageAutomationLifecycle;
  var resourceClientApi = root && root.PageAutomationResourceClient;
  var runStateApi = root && root.SidepanelRunState;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  if (commonJs && !resourceClientApi) resourceClientApi = require('../ui/resource-client.js');
  if (commonJs && !runStateApi) runStateApi = require('./sidepanel-run-state.js');
  var api = factory(lifecycleApi, resourceClientApi, runStateApi);
  if (commonJs) module.exports = api;
  if (root) root.SidepanelRunEntry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi, ResourceClientApi, RunStateApi) {
  'use strict';

  var API_VERSION = 1;

  function failure(reason, error, transportError) {
    return {
      ok: false,
      reason: reason,
      error: String(error && error.message ? error.message : (error || reason || '操作失败')),
      transportError: transportError === true,
    };
  }

  function staleResult(response) {
    return { ok: false, stale: true, response: response };
  }

  function isUserFlow(flowId) {
    return typeof flowId === 'string' && flowId.indexOf('user:') === 0;
  }

  function isAssistantTarget(target) {
    return !!(target && target.type === 'assistant');
  }

  function isConversationSession(session) {
    return !!(session && session.kind === 'conversation');
  }

  function responseError(response) {
    return String(response && (response.error || response.reason) || '后台未返回响应');
  }

  function resourceSegment(value) {
    return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function resourceData(envelope) {
    var primary = envelope && envelope.primary;
    return primary && primary.data && typeof primary.data === 'object' ? primary.data : {};
  }

  function resourceErrorText(error) {
    var code = error && error.code ? '[' + error.code + '] ' : '';
    return code + String(error && error.message ? error.message : (error || '资源请求失败'));
  }

  function resourceStartResponse(envelope) {
    var payload = Object.assign({}, resourceData(envelope));
    var operationUri = String(envelope && envelope.receipt && envelope.receipt.operationUri
      || envelope && envelope.primary && envelope.primary.uri || '');
    if (!payload.runId && !payload.flowGroupRunId && operationUri) {
      var segments = operationUri.split('/').filter(Boolean);
      if (segments.length) payload.runId = decodeURIComponent(segments[segments.length - 1]);
    }
    return { ok: true, payload: payload, envelope: envelope };
  }

  function create(api) {
    api = api || {};
    var lifecycleFactory = api.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before SidepanelRunEntry');
    }
    var resourceClientFactory = api.resourceClientApi || ResourceClientApi;
    if (!resourceClientFactory || typeof resourceClientFactory.create !== 'function') {
      throw new Error('PageAutomationResourceClient must load before SidepanelRunEntry');
    }
    if (typeof api.sendMessage !== 'function') {
      throw new Error('SidepanelRunEntry requires sendMessage');
    }
    var runStatePolicy = api.runStatePolicy || RunStateApi;
    if (!runStatePolicy || runStatePolicy.API_VERSION !== 1 || typeof runStatePolicy.resolve !== 'function') {
      throw new Error('SidepanelRunState must load before SidepanelRunEntry');
    }

    var timerHost = api.window || (typeof window !== 'undefined' ? window : globalThis);
    var browser = api.browser || (typeof chrome !== 'undefined' ? chrome : {});
    var elements = api.elements || {};
    var runButton = elements.runButton || null;
    var flowSelect = elements.flowSelect || null;
    var sessionSelect = elements.sessionSelect || null;
    var clearSessionsButton = elements.clearSessionsButton || null;
    var stepsContainer = elements.stepsContainer || null;
    var lifecycle = api.lifecycle || lifecycleFactory.create(timerHost);
    var resourceClient = api.resourceClient || resourceClientFactory.create(browser.runtime);
    var initialized = false;
    var destroyed = false;
    var contextRevision = 0;
    var actionSequence = 0;
    var inFlight = null;
    var stopInFlight = null;

    function setStatus(message) {
      if (api.setStatus) api.setStatus(message);
    }

    function addLog(message, level, extra) {
      if (api.addLocalLog) api.addLocalLog(message, 'run', level || 'info', extra);
    }

    function send(action, payload) {
      var result;
      try {
        result = api.sendMessage(action, payload || {});
      } catch (err) {
        return Promise.resolve(failure('transport-error', err, true));
      }
      return Promise.resolve(result).then(function (response) {
        if (response === undefined || response === null) {
          return failure('empty-response', '后台未返回响应', true);
        }
        return response;
      }, function (err) {
        return failure('transport-error', err, true);
      });
    }

    function conversationCommand(command, input) {
      return send('CONVERSATION_COMMAND', { command: command, input: input || {} }).then(function (response) {
        if (!response || response.ok !== true) {
          var error = response && response.error;
          return failure(error && error.code || 'conversation-command-failed', error && error.message || error || '对话命令失败');
        }
        return { ok: true, payload: response.result || {}, command: command };
      });
    }

    function nextId(prefix) {
      var cryptoApi = timerHost && timerHost.crypto;
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return prefix + ':' + cryptoApi.randomUUID();
      return prefix + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10);
    }

    function sidepanelConversationInput(target, context, active) {
      var assistantId = String(target.rawId || target.id || '').trim();
      var modelServiceId = String(context.modelServiceId || target.modelServiceId || api.getDefaultModelServiceId && api.getDefaultModelServiceId() || '').trim();
      if (!modelServiceId) return failure('missing-model-service-id', '当前助手未配置模型服务');
      var settings = target.settings || {};
      var commandId = nextId('sidepanel-start');
      var conversationId = 'sidepanel:' + String(active.windowId || 0) + ':' + assistantId + ':' + Date.now().toString(36);
      return {
        schemaVersion: 1,
        commandId: commandId,
        conversationId: conversationId,
        assistantId: assistantId,
        serviceId: modelServiceId,
        message: { id: commandId + ':message', content: String(context.message || ''), attachments: [] },
        entry: {
          type: 'conversation',
          currentResource: '/page/current',
          tabId: Number(active.tabId) || 0,
        },
        budgets: {
          maxModelRequests: Math.max(1, Number(settings.maxModelRequests || settings.maxIterations) || 100),
          maxIterations: Math.max(1, Number(settings.maxIterations) || 100),
          maxToolCalls: Math.max(0, Number(settings.maxToolCalls) || 200),
          maxWallTimeMs: Math.max(1000, Number(settings.maxWallTimeMs) || 900000),
          maxContextTokens: Math.max(1024, Number(settings.maxContextTokens) || 1000000),
          maxOutputTokens: Math.max(1, Number(settings.maxTokens) || 4096),
        },
        preferences: {
          streamOutput: false,
          reasoningVisibility: settings.reasoningVisibility === 'collapsed' ? 'collapsed' : 'expanded',
          contextCompression: settings.contextCompression === 'off' ? 'off' : 'auto',
        },
        requestedAt: Date.now(),
      };
    }

    function currentTargetValue() {
      var target = api.getSelectedRunTarget ? api.getSelectedRunTarget() : null;
      return target && target.value || '';
    }

    function currentRunId() {
      return String(api.getCurrentRunId ? api.getCurrentRunId() : '').trim();
    }

    function currentSession() {
      var runId = currentRunId();
      return runId && api.findSessionByRunId ? api.findSessionByRunId(runId) : null;
    }

    function resolveRunState(session, actionPending) {
      var active = api.getActiveTabContext ? api.getActiveTabContext() : {};
      return runStatePolicy.resolve({
        currentSession: session || null,
        activeTabSession: api.findRunningSessionForActiveTab && api.findRunningSessionForActiveTab(),
        occupancySession: api.findRunningOccupancyForActiveTab && api.findRunningOccupancyForActiveTab(),
        activeTabId: Number(active && active.tabId) || 0,
        actionPending: actionPending === true,
        isOwned: function (candidate) {
          return !api.isSidepanelOwnedSession || api.isSidepanelOwnedSession(candidate);
        },
      });
    }

    function currentTabId() {
      var active = api.getActiveTabContext ? api.getActiveTabContext() : {};
      return Number(active && active.tabId) || 0;
    }

    function isActionCurrent(action) {
      return !!(action && !destroyed && action.revision === contextRevision
        && (!action.targetValue || !currentTargetValue() || action.targetValue === currentTargetValue())
        && (!action.validateRunId || !action.runId || !currentRunId() || action.runId === currentRunId())
        && (!action.tabId || !currentTabId() || action.tabId === currentTabId()));
    }

    function notifyPending() {
      var pending = !!(inFlight || stopInFlight);
      var canStop = !!findStoppableSession();
      if (runButton) runButton.disabled = !!(pending && !canStop);
      if (!destroyed && api.refreshControlStates) api.refreshControlStates();
      if (!destroyed && api.onActionPendingChange) api.onActionPendingChange(!!pending);
    }

    function finishAction(action) {
      if (!inFlight || inFlight.action !== action) return;
      inFlight = null;
      notifyPending();
    }

    function finishStopAction(action) {
      if (!stopInFlight || stopInFlight.action !== action) return;
      stopInFlight = null;
      notifyPending();
    }

    function runExclusive(kind, meta, work) {
      if (destroyed) return Promise.resolve(failure('destroyed', '面板操作控制器已销毁'));
      if (stopInFlight) return stopInFlight.promise;
      if (inFlight) return inFlight.promise;
      meta = meta || {};
      var action = {
        id: ++actionSequence,
        kind: kind,
        revision: contextRevision,
        targetValue: meta.targetValue || '',
        runId: meta.runId || '',
        validateRunId: meta.validateRunId === true,
        tabId: meta.tabId || currentTabId(),
      };
      var operation = Promise.resolve().then(function () {
        return work(action);
      }).catch(function (err) {
        if (!isActionCurrent(action)) return staleResult();
        var result = failure('transport-error', err, true);
        setStatus('操作失败: ' + result.error, '');
        addLog('操作失败: ' + result.error, 'error', { transportError: true });
        return result;
      });
      inFlight = { action: action, promise: operation };
      notifyPending();
      operation.then(function () { finishAction(action); }, function () { finishAction(action); });
      return operation;
    }

    function runStopExclusive(meta, work) {
      if (destroyed) return Promise.resolve(failure('destroyed', '面板操作控制器已销毁'));
      if (stopInFlight) return stopInFlight.promise;
      contextRevision++;
      inFlight = null;
      meta = meta || {};
      var action = {
        id: ++actionSequence,
        kind: 'stop',
        revision: contextRevision,
        targetValue: '',
        runId: meta.runId || '',
        validateRunId: false,
        tabId: meta.tabId || currentTabId(),
      };
      var operation = Promise.resolve().then(function () {
        return work(action);
      }).catch(function (err) {
        if (!isActionCurrent(action)) return staleResult();
        var result = failure('transport-error', err, true);
        setStatus('停止失败: ' + result.error, '');
        addLog('停止失败: ' + result.error, 'error', { transportError: true });
        return result;
      });
      stopInFlight = { action: action, promise: operation };
      notifyPending();
      operation.then(function () { finishStopAction(action); }, function () { finishStopAction(action); });
      return operation;
    }

    function onContextChanged() {
      contextRevision++;
      inFlight = null;
      stopInFlight = null;
      notifyPending();
    }

    function trackActiveTab() {
      return new Promise(function (resolve) {
        if (!api.trackActiveTab) {
          resolve();
          return;
        }
        try {
          api.trackActiveTab(function () { resolve(); });
        } catch (_) {
          resolve();
        }
      });
    }

    function browserLastErrorMessage() {
      try {
        var error = browser && browser.runtime && browser.runtime.lastError;
        return error && error.message ? String(error.message) : '';
      } catch (_) {
        return '';
      }
    }

    function focusCurrentWindow() {
      return new Promise(function (resolve) {
        var windows = browser && browser.windows;
        if (!windows || typeof windows.getCurrent !== 'function') {
          resolve(false);
          return;
        }
        try {
          windows.getCurrent(function (win) {
            if (browserLastErrorMessage()) {
              resolve(false);
              return;
            }
            if (!win || win.id === undefined || win.id === null) {
              resolve(false);
              return;
            }
            if (typeof windows.update !== 'function') {
              resolve(true);
              return;
            }
            windows.update(win.id, { focused: true }, function () {
              resolve(!browserLastErrorMessage());
            });
          });
        } catch (_) {
          resolve(false);
        }
      });
    }

    function activeContext(action, focusWindow) {
      action.tabId = 0;
      var focus = focusWindow ? focusCurrentWindow() : Promise.resolve(true);
      return focus.then(function (focused) {
        if (focusWindow && !focused) {
          if (!isActionCurrent(action)) return staleResult();
          setStatus('无法获取当前窗口', '');
          addLog('无法获取当前窗口，未启动运行', 'error');
          return failure('no-current-window', '无法获取当前窗口');
        }
        return trackActiveTab().then(function () { return null; });
      }).then(function (preflight) {
        if (preflight && preflight.ok === false) return preflight;
        if (!isActionCurrent(action)) return null;
        var active = api.getActiveTabContext ? api.getActiveTabContext() : {};
        active = {
          tabId: Number(active && active.tabId) || 0,
          windowId: Number(active && active.windowId) || 0,
        };
        if (!active.tabId) {
          setStatus('没有当前标签页', '');
          addLog('没有当前标签页，无法启动运行', 'warn');
          return failure('no-active-tab', '没有当前标签页');
        }
        action.tabId = active.tabId;
        return active;
      });
    }

    function applyFailure(prefix, response, extra) {
      var normalized = response;
      if (response === undefined || response === null) normalized = failure('empty-response', '后台未返回响应', true);
      else if (typeof response !== 'object') normalized = failure('invalid-response', '后台响应格式无效', false);
      var message = prefix + ': ' + responseError(normalized);
      setStatus(message, '');
      addLog(message, 'error', Object.assign({ transportError: !!normalized.transportError }, extra || {}));
      return normalized;
    }

    function applyStartResponse(action, response, target, meta) {
      if (!isActionCurrent(action)) return staleResult(response);
      if (!response || response.ok !== true) return applyFailure(meta.failurePrefix, response, meta.logExtra);
      var runId = response.payload && (response.payload.runId || response.payload.flowGroupRunId) || '';
      if (meta.requireRunId && !runId) {
        return applyFailure(meta.failurePrefix, failure('missing-run-id', '后台未返回 runId'), meta.logExtra);
      }
      if (runId && api.setPinnedRunId) {
        api.setPinnedRunId(runId, {
          label: meta.label || target.label || target.rawId || runId,
          flowLabel: meta.flowLabel || target.label || target.rawId || runId,
          conversationLabel: meta.conversationLabel || '',
          kind: meta.kind,
          ownerTabId: Number(meta.ownerTabId) || 0,
          originTabId: Number(meta.originTabId || meta.ownerTabId) || 0,
          originWindowId: Number(meta.originWindowId) || 0,
        });
      }
      if (api.refreshSessions) api.refreshSessions(meta.conversationOnly ? { conversationOnly: true } : undefined);
      setStatus(meta.successStatus, 'auto-run');
      if (meta.successLog) addLog(typeof meta.successLog === 'function' ? meta.successLog(runId) : meta.successLog, 'info', meta.logExtra);
      return response;
    }

    function buildAutomationRunRequest(target, context, active, options) {
      var groupRun = target.type === 'flowGroup';
      var targetId = target.rawId || target.id || target.value;
      var rawContext = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
      var userInput = rawContext.input && typeof rawContext.input === 'object' && !Array.isArray(rawContext.input)
        ? rawContext.input
        : rawContext;
      var runtimeContext = {
        tabId: active.tabId,
        input: Object.assign({}, userInput),
      };
      return {
        uri: (groupRun ? '/flow-groups/' : '/flows/') + resourceSegment(targetId) + '/runs',
        relation: groupRun ? 'flow-group-runs' : 'flow-runs',
        body: {
          trigger: 'manual',
          entry: 'sidepanel',
          ownerTabId: active.tabId,
          originTabId: active.tabId,
          originWindowId: active.windowId,
          context: runtimeContext,
          totalRuns: options.totalRuns,
          maxRetries: options.maxRetries,
          options: { totalRuns: options.totalRuns, maxRetries: options.maxRetries },
        },
        meta: {
          kind: groupRun ? 'flowGroup' : 'flow',
          ownerTabId: active.tabId,
          originTabId: active.tabId,
          originWindowId: active.windowId,
          requireRunId: true,
          successStatus: groupRun ? '流程组已启动' : '已启动',
          successLog: function (runId) {
            return (groupRun ? '流程组会话已创建: ' : '流程会话已创建: ') + runId;
          },
          failurePrefix: groupRun ? '流程组启动失败' : '启动失败',
        },
      };
    }

    function runAutomationTarget(action, target, context, options) {
      return activeContext(action, false).then(function (active) {
        if (!active) return staleResult();
        if (active.ok === false) return active;
        if (!isActionCurrent(action)) return staleResult();
        addLog('发送启动请求: ' + (target.label || target.value), 'info');
        var request = buildAutomationRunRequest(target, context, active, options);
        return resourceClient.authorizedPost(request.uri, request.body, {
          criteria: { relation: request.relation },
        }).then(resourceStartResponse, function (error) {
          return failure('resource-request-failed', resourceErrorText(error), false);
        }).then(function (response) {
          return applyStartResponse(action, response, target, request.meta);
        });
      });
    }

    function runTarget(target, context) {
      var targetValue = target && target.value || '';
      return runExclusive('run', { targetValue: targetValue }, function (action) {
        var opts = api.getRunOptions ? api.getRunOptions() : { totalRuns: 1, maxRetries: 0 };
        if (isAssistantTarget(target)) setStatus('提交后台任务...', '');
        else if (target.type === 'flowGroup') setStatus('启动流程组...', '');
        else setStatus('启动中...', '');

        if (isAssistantTarget(target)) {
          return activeContext(action, false).then(function (active) {
            if (!active) return staleResult();
            if (active.ok === false) return active;
            if (!isActionCurrent(action)) return staleResult();
            var assistantLabel = target.label || target.rawId || '对话';
            var conversationLabel = String(context.label || context.message || '').trim().slice(0, 36);
            var displayRun = conversationLabel && conversationLabel !== assistantLabel
              ? assistantLabel + ' · ' + conversationLabel
              : assistantLabel;
            addLog('提交后台任务：' + assistantLabel, 'info', { conversationLog: true, displayRun: displayRun });
            var startInput = sidepanelConversationInput(target, context, active);
            if (startInput && startInput.ok === false) return startInput;
            var operation = conversationCommand('START_TURN', startInput).then(function (response) {
              if (response.ok) {
                response.payload.conversationId = startInput.conversationId;
                response.payload.runId = 'conversation:' + startInput.conversationId;
              }
              return response;
            });
            return operation.then(function (response) {
              return applyStartResponse(action, response, target, {
                kind: 'conversation',
                label: displayRun,
                conversationLabel: displayRun,
                ownerTabId: active.tabId,
                originTabId: active.tabId,
                originWindowId: active.windowId,
                requireRunId: true,
                conversationOnly: true,
                successStatus: '后台任务运行中',
                successLog: '',
                failurePrefix: '后台任务启动失败',
                logExtra: { conversationLog: true, displayRun: displayRun },
              });
            });
          });
        }

        return runAutomationTarget(action, target, context, opts);
      });
    }

    function run() {
      if (inFlight) return inFlight.promise;
      if (api.setLogScope) api.setLogScope('run', true);
      var target = api.getSelectedRunTarget && api.getSelectedRunTarget();
      if (!target || !target.value) {
        setStatus('请选择流程或流程组', '');
        addLog('未选择流程，无法启动', 'warn');
        return Promise.resolve(failure('missing-target', '请选择流程或流程组'));
      }
      var context;
      try {
        context = api.collectRuntimeContext ? api.collectRuntimeContext(target) : {};
      } catch (err) {
        setStatus(err.message || '入参无效', '');
        addLog(err.message || '入参无效', 'error');
        return Promise.resolve(failure('invalid-input', err));
      }
      return runTarget(target, context || {});
    }

    function rejectStop(reason, message) {
      setStatus(message, '');
      addLog(message, 'warn');
      return Promise.resolve(failure(reason, message, false));
    }

    function stop(runId) {
      var resolvedRunId = String(runId || currentRunId() || '').trim();
      var current = resolvedRunId && api.findSessionByRunId ? api.findSessionByRunId(resolvedRunId) : null;
      if (!resolvedRunId) return rejectStop('missing-run-id', '没有可停止的运行');
      if (!current) return rejectStop('run-not-found', '运行会话已不存在: ' + resolvedRunId);
      if (current.status !== 'running') return rejectStop('run-not-running', '运行会话已不在运行: ' + resolvedRunId);
      var conversation = isConversationSession(current);
      if (conversation) return rejectStop('conversation-background-only', '后台任务运行中，请等待完成');
      var actionName = 'STOP_FLOW';
      var payload = { runId: current.runId };
      return runStopExclusive({ runId: resolvedRunId }, function (action) {
        setStatus('停止中...', '');
        addLog('发送停止请求: ' + resolvedRunId, 'info');
        return send(actionName, payload).then(function (response) {
          if (!isActionCurrent(action)) return staleResult(response);
          if (!response || response.ok !== true) return applyFailure('停止失败', response);
          addLog('停止请求已接受: ' + resolvedRunId, 'info');
          if (api.refreshSessions) api.refreshSessions();
          return response;
        });
      });
    }

    function findStoppableSession() {
      return resolveRunState(currentSession(), false).stoppableSession;
    }

    function onRunAction() {
      var stoppable = findStoppableSession();
      if (stoppable && isConversationSession(stoppable)) {
        return Promise.resolve(failure('conversation-running', '后台任务运行中，请等待完成'));
      }
      if (stoppable) return stop(stoppable.runId);
      if (inFlight) return inFlight.promise;
      if (api.isActiveTabRunOccupied && api.isActiveTabRunOccupied()) {
        setStatus('当前标签页运行中', '');
        addLog('当前标签页正被其它运行会话占用，不能从这里启动新的运行', 'warn');
        return Promise.resolve(failure('tab-occupied', '当前标签页运行中'));
      }
      return run();
    }

    function sessionActionLabel(session) {
      return session && (session.flowLabel || session.conversationLabel || session.runId) || '运行会话';
    }

    function setRunActionMode(running, occupiedOnly, runningSession) {
      if (!runButton) return;
      if (running) {
        var conversationRunning = isConversationSession(runningSession);
        runButton.textContent = conversationRunning ? '运行中' : '停止';
        runButton.title = (conversationRunning
          ? '后台任务运行中，请等待完成'
          : '停止当前展示会话')
          + (runningSession ? ': ' + sessionActionLabel(runningSession) : '');
      } else if (occupiedOnly) {
        runButton.textContent = '运行中';
        runButton.title = '当前标签页正被其它运行会话占用';
      } else {
        runButton.textContent = '运行';
        runButton.title = '运行当前选择';
      }
      if (runButton.classList) {
        runButton.classList.toggle('btn-danger', !!(running && !conversationRunning));
        runButton.classList.toggle('btn-primary', !occupiedOnly && (!running || conversationRunning));
      }
    }

    function updateControlStates(session) {
      var actionPending = !!(inFlight || stopInFlight);
      var state = resolveRunState(session, actionPending);
      setRunActionMode(state.runningAction, state.occupiedOnly, state.actionSession);
      var conversationRunning = !!(state.actionSession && isConversationSession(state.actionSession)
        && state.actionSession.status === 'running');
      if (runButton) runButton.disabled = state.occupiedOnly || conversationRunning
        || (actionPending && !state.runningAction);
      if (flowSelect) flowSelect.disabled = state.controlsLocked;
      if (sessionSelect) sessionSelect.disabled = state.controlsLocked;
      if (clearSessionsButton) clearSessionsButton.disabled = state.controlsLocked;
      if (api.setRuntimeInputsDisabled) {
        api.setRuntimeInputsDisabled(state.controlsLocked
          || (!(api.getSelectedRunTarget && api.getSelectedRunTarget()) && !currentRunId()));
      }
    }

    function onContinueRun(runId) {
      runId = String(runId || '').trim();
      if (!runId) return Promise.resolve(failure('missing-run-id', '缺少 runId'));
      return runExclusive('continue', { runId: runId, validateRunId: true }, function (action) {
        setStatus('从停止处继续...', '');
        return send('CONTINUE_RUN', { runId: runId }).then(function (response) {
          if (!isActionCurrent(action)) return staleResult(response);
          if (!response || response.ok !== true) return applyFailure('继续失败', response);
          if (api.setPinnedRunId) api.setPinnedRunId(runId, { kind: 'flow' });
          if (api.refreshSessions) api.refreshSessions();
          setStatus('运行中', 'auto-run');
          return response;
        });
      });
    }

    function onResumeFrom(nodeId) {
      nodeId = String(nodeId || '').trim();
      if (!nodeId) return Promise.resolve(failure('missing-node-id', '缺少 nodeId'));
      var runId = currentRunId();
      var state = api.getCurrentState ? api.getCurrentState() : null;
      var flowId = state && state.flowId || '';
      var target = api.getSelectedRunTarget && api.getSelectedRunTarget();
      if (!runId && !isUserFlow(flowId)) return Promise.resolve(failure('missing-run-id', '没有可继续的运行'));
      return runExclusive('resume', { runId: runId, validateRunId: !!runId, targetValue: target && target.value || '' }, function (action) {
        setStatus('从节点继续...', '');
        var prepare = runId ? Promise.resolve(api.getActiveTabContext ? api.getActiveTabContext() : {}) : activeContext(action, false);
        return prepare.then(function (active) {
          if (!isActionCurrent(action)) return staleResult();
          if (active && active.ok === false) return active;
          var payload = runId
            ? { runId: runId, nodeId: nodeId }
            : {
              flowId: flowId.slice(5),
              nodeId: nodeId,
              ownerTabId: Number(active && active.tabId) || 0,
              originTabId: Number(active && active.tabId) || 0,
              originWindowId: Number(active && active.windowId) || 0,
              entry: 'sidepanel',
            };
          return send('RESUME_FROM_NODE', payload).then(function (response) {
            if (!isActionCurrent(action)) return staleResult(response);
            if (!response || response.ok !== true) return applyFailure('继续失败', response);
            var nextRunId = response.payload && response.payload.runId || '';
            if (!runId && nextRunId && api.setPinnedRunId) {
              api.setPinnedRunId(nextRunId, {
                label: target && target.label || flowId,
                flowLabel: target && target.label || flowId,
                kind: 'flow',
                ownerTabId: Number(active && active.tabId) || 0,
                originTabId: Number(active && active.tabId) || 0,
                originWindowId: Number(active && active.windowId) || 0,
              });
            }
            if (api.refreshSessions) api.refreshSessions();
            setStatus('运行中', 'auto-run');
            return response;
          });
        });
      });
    }

    function handleStepsClick(event) {
      var source = event && event.target;
      if (!source || typeof source.closest !== 'function') return;
      var continueButton = source.closest('[data-continue]');
      if (continueButton) {
        onContinueRun(continueButton.dataset && continueButton.dataset.continue);
        return;
      }
      var resumeButton = source.closest('[data-resume]');
      if (resumeButton) onResumeFrom(resumeButton.dataset && resumeButton.dataset.resume);
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      lifecycle.listen(runButton, 'click', onRunAction);
      lifecycle.listen(flowSelect, 'change', function () {
        onContextChanged('flow');
        if (api.onFlowChange) api.onFlowChange(flowSelect && flowSelect.value || '');
      });
      lifecycle.listen(sessionSelect, 'focus', function () {
        if (api.onSessionFocusChange) api.onSessionFocusChange(true);
      });
      lifecycle.listen(sessionSelect, 'blur', function () {
        if (api.onSessionFocusChange) api.onSessionFocusChange(false);
      });
      lifecycle.listen(sessionSelect, 'change', function () {
        onContextChanged('session');
        if (api.onSessionChange) api.onSessionChange(sessionSelect && sessionSelect.value || '');
      });
      lifecycle.listen(clearSessionsButton, 'click', function () {
        onContextChanged('clear');
        if (api.onClearSessions) api.onClearSessions();
      });
      lifecycle.listen(stepsContainer, 'click', handleStepsClick);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      onContextChanged('destroy');
      lifecycle.destroy();
    }

    return {
      init: init,
      destroy: destroy,
      onRunAction: onRunAction,
      onContinueRun: onContinueRun,
      onResumeFrom: onResumeFrom,
      stop: stop,
      onContextChanged: onContextChanged,
      updateControlStates: updateControlStates,
      isInFlight: function () { return !!(inFlight || stopInFlight); },
      hasActiveRunForCurrentTarget: function () {
        return !!(inFlight && inFlight.action.kind === 'run' && isActionCurrent(inFlight.action));
      },
    };
  }

  return {
    API_VERSION: API_VERSION,
    create: create,
    failure: failure,
  };
});
