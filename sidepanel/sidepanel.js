// sidepanel.js — 最小化 Side Panel 逻辑
(function () {
  'use strict';

  // --- DOM 引用 ---
  var $ = function (id) { return document.getElementById(id); };

  var elFlow = $('select-flow');
  var elSession = $('select-session');
  var elClearSessions = $('btn-clear-sessions');
  var elRun = $('btn-run');
  var elRuntimeInputs = $('runtime-inputs');
  var elSteps = $('steps-container');
  var elStepsTitle = $('steps-title');
  var elLog = $('log-container');
  var elStatus = $('status-text');
  var elPageReadiness = $('page-readiness');
  var elClearLog = $('btn-clear-log');
  var elOpenSettings = $('btn-open-settings');

  // 输出/调试面板
  var elOutputSection = $('output-section');

  // --- 状态 ---
  var currentState = null;
  var currentFlows = [];
  var currentFlowGroups = [];
  var currentAssistants = [];
  var currentDefaultModelServiceId = '';
  var flowListRequestRevision = 0;
  var currentRunTargets = [];
  var runTargetValue = '';
  var activeTabId = 0;           // 当前 sidepanel 所在窗口的激活 tab
  var activeWindowId = 0;
  var sessionController = null;
  var runEntry = null;
  var runtimeInputController = null;
  var logPanel = null;
  var debugPanel = null;
  var readinessRefreshTimer = 0;
  var syncRefreshTimer = 0;
  var pendingSyncTargets = false;
  var pendingSyncConversations = false;
  var pendingSyncReadiness = false;
  var sidepanelLifecycleReconnectTimer = 0;
  var RUN_TARGET_STORAGE_KEY = chrome.extension && chrome.extension.inIncognitoContext
    ? 'sidepanelRunTargetSelectionIncognito'
    : 'sidepanelRunTargetSelection';
  var sidepanelLifecyclePort = null;
  var runtimeClient = window.PageAutomationRuntimeClient.create(chrome.runtime);
  var resourceClient = window.PageAutomationResourceClient.create(chrome.runtime);
  var lifecycle = window.PageAutomationLifecycle.create(window);
  var syncEventStream = window.PageAutomationSyncEventStream
    && window.PageAutomationSyncEventStream.create
    ? window.PageAutomationSyncEventStream.create({ runtime: chrome.runtime })
    : null;
  var tornDown = false;

  // 步骤状态图标
  var STATUS_ICONS = {
    pending: '○',
    running: '◉',
    completed: '✓',
    failed: '✗',
    skipped: '-',
    stopped: '||',
    manual_completed: '✓',
  };

  var STATUS_CLASSES = {
    pending: 'status-pending',
    running: 'status-running',
    completed: 'status-completed',
    failed: 'status-failed',
    skipped: 'status-skipped',
    stopped: 'status-stopped',
    manual_completed: 'status-completed',
  };

  // --- 初始化 ---

  function init() {
    if (!window.SidepanelRuntimeInputController
      || typeof window.SidepanelRuntimeInputController.create !== 'function') {
      throw new Error('SidepanelRuntimeInputController must load before sidepanel.js');
    }
    runtimeInputController = window.SidepanelRuntimeInputController.create({
      lifecycleApi: window.PageAutomationLifecycle,
      document: document,
      window: window,
      container: elRuntimeInputs,
      getSelectedRunTarget: getSelectedRunTarget,
      isConversationRunTarget: isConversationRunTarget,
      isConversationSession: isConversationSession,
      escapeHtml: escapeHtml,
    });
    runtimeInputController.init();
    if (!window.SidepanelSessionController || typeof window.SidepanelSessionController.create !== 'function') {
      throw new Error('SidepanelSessionController must load before sidepanel.js');
    }
    sessionController = window.SidepanelSessionController.create(createSessionControllerApi());

    runEntry = window.SidepanelRunEntry && window.SidepanelRunEntry.create(createRunEntryApi());
    if (!runEntry) throw new Error('SidepanelRunEntry must load before sidepanel.js');
    runEntry.init();
    logPanel = window.SidepanelLogPanel.create({
      document: document,
      container: elLog,
      clearButton: elClearLog,
      getCurrentRunId: function () {
        return sessionController ? sessionController.getCurrentRunId() : '';
      },
      isConversationRunId: isConversationRunId,
    });
    logPanel.init();

    debugPanel = window.SidepanelDebugPanel.create({
      document: document,
      outputSection: elOutputSection,
      sendMessage: sendMessage,
      getRunId: function () {
        return sessionController ? sessionController.getCurrentRunId() : '';
      },
    });
    debugPanel.init();
    sessionController.init();

    lifecycle.listen(elOpenSettings, 'click', function () {
      var opened;
      try {
        opened = chrome.runtime.openOptionsPage();
      } catch (err) {
        opened = Promise.reject(err);
      }
      Promise.resolve(opened).catch(function () {
        window.open(chrome.runtime.getURL('options/options.html'), '_blank', 'noopener');
      });
    });

    // 初始化时绑定当前激活 tab；之后 tab 切换时刷新当前 tab 的运行入口和会话视图。
    trackActiveTab(function () {
      sessionController.loadSessionRefs(function () {
        // 绑定完成并恢复运行选择后再加载数据，避免 sidepanel 重开时清空下拉框。
        loadRunTargetSelection(function () {
          requestState();
          Promise.resolve(sessionController.refreshSessions()).then(requestFlowList, requestFlowList);
          refreshPageReadiness();
        });
      });
    });

    bindActiveTabListeners();
    if (chrome.tabs && chrome.tabs.onUpdated) {
      lifecycle.subscribe(chrome.tabs.onUpdated, function (tabId, changeInfo) {
        if (tabId !== activeTabId) return;
        if (changeInfo.status === 'complete' || changeInfo.url) schedulePageReadinessRefresh();
      });
    }
  }

  function trackActiveTab(callback) {
    try {
      chrome.windows.getCurrent(function (win) {
        var runtimeError = chrome.runtime && chrome.runtime.lastError;
        if (runtimeError) win = null;
        if (!win) {
          var hadContext = !!(activeTabId || activeWindowId);
          activeTabId = 0;
          activeWindowId = 0;
          callback && callback(hadContext);
          return;
        }
        var previousTabId = activeTabId;
        var previousWindowId = activeWindowId;
        activeWindowId = win.id || 0;
        syncSidepanelLifecyclePort();
        chrome.tabs.query({ active: true, windowId: win.id }, function (tabs) {
          if (chrome.runtime && chrome.runtime.lastError) tabs = [];
          activeTabId = tabs && tabs[0] ? tabs[0].id : 0;
          callback && callback(activeTabId !== previousTabId || activeWindowId !== previousWindowId);
        });
      });
    } catch (_) {
      var hadContext = !!(activeTabId || activeWindowId);
      activeTabId = 0;
      activeWindowId = 0;
      callback && callback(hadContext);
    }
  }

  function syncSidepanelLifecyclePort() {
    if (tornDown || !activeWindowId) return;
    try {
      if (!sidepanelLifecyclePort && chrome.runtime && chrome.runtime.connect) {
        sidepanelLifecyclePort = chrome.runtime.connect({ name: 'page-automation-sidepanel' });
        var connectedPort = sidepanelLifecyclePort;
        lifecycle.subscribe(connectedPort.onMessage, function (message) {
          if (message && message.type === 'CLOSE_SIDEPANEL') {
            try { window.close(); } catch (_) {}
          }
        });
        lifecycle.subscribe(connectedPort.onDisconnect, function () {
          if (sidepanelLifecyclePort === connectedPort) sidepanelLifecyclePort = null;
          if (tornDown || sidepanelLifecycleReconnectTimer) return;
          sidepanelLifecycleReconnectTimer = window.setTimeout(function () {
            sidepanelLifecycleReconnectTimer = 0;
            syncSidepanelLifecyclePort();
          }, 250);
        });
      }
      if (sidepanelLifecyclePort) {
        sidepanelLifecyclePort.postMessage({
          type: 'SIDEPANEL_WINDOW',
          windowId: activeWindowId,
        });
      }
    } catch (_) {
      sidepanelLifecyclePort = null;
    }
  }

  function bindActiveTabListeners() {
    if (chrome.tabs && chrome.tabs.onActivated) {
      lifecycle.subscribe(chrome.tabs.onActivated, function () {
        refreshActiveTabContext();
      });
    }
    if (chrome.windows && chrome.windows.onFocusChanged) {
      lifecycle.subscribe(chrome.windows.onFocusChanged, function (windowId) {
        if (chrome.windows.WINDOW_ID_NONE !== undefined && windowId === chrome.windows.WINDOW_ID_NONE) return;
        refreshActiveTabContext();
      });
    }
  }

  function refreshActiveTabContext() {
    trackActiveTab(function (changed) {
      if (!changed) return;
      if (runEntry) runEntry.onContextChanged('tab');
      if (sessionController) sessionController.onActiveContextChanged();
      if (runtimeInputController) runtimeInputController.resetContext();
      loadRunTargetSelection(function () {
        requestState();
        var refresh = sessionController ? sessionController.refreshSessions() : Promise.resolve();
        Promise.resolve(refresh).then(renderFlowOptions, renderFlowOptions);
        refreshPageReadiness();
      });
    });
  }

  function renderPageReadiness(info) {
    if (!elPageReadiness) return;
    info = info || {};
    var status = String(info.status || 'error');
    var ready = status === 'ready';
    elPageReadiness.className = 'page-readiness' + (ready ? ' ready' : '');
    elPageReadiness.textContent = ready
      ? '驱动 OK'
      : (status === 'notConfigured' ? '未配置页面' : '驱动未就绪');
    var expected = info.expected || {};
    var actual = info.actual || {};
    elPageReadiness.title = [
      info.message || '',
      info.url || '',
      'expected=' + (expected.hash || expected.version || ''),
      'actual=' + (actual.hash || actual.version || ''),
      info.error ? ('error=' + info.error) : '',
    ].filter(Boolean).join('\n');
  }

  function refreshPageReadiness() {
    if (!activeTabId) {
      renderPageReadiness({ status: 'noTab', message: '没有当前标签页' });
      return;
    }
    sendMessage('CHECK_TAB_READINESS', { tabId: activeTabId }).then(function (resp) {
      if (resp && resp.ok) renderPageReadiness(resp.payload || {});
      else renderPageReadiness({ status: 'error', message: '页面驱动状态查询失败', error: (resp && resp.error) || '' });
    });
  }

  function schedulePageReadinessRefresh() {
    if (readinessRefreshTimer) clearTimeout(readinessRefreshTimer);
    readinessRefreshTimer = setTimeout(function () {
      readinessRefreshTimer = 0;
      refreshPageReadiness();
    }, 400);
  }

  function isFlowStepsTarget(target) {
    return !!(target && target.value && target.type !== 'flowGroup' && !isConversationRunTarget(target));
  }

  function flowIdMatchesTarget(flowId, target) {
    flowId = String(flowId || '').trim();
    if (!flowId || !target) return false;
    var candidates = [
      target.value || '',
      target.id || '',
      target.rawId || '',
    ];
    if (target.rawId) candidates.push('user:' + target.rawId);
    if (target.value && String(target.value).indexOf('user:') === 0) {
      candidates.push(String(target.value).slice(5));
    }
    for (var i = 0; i < candidates.length; i++) {
      if (String(candidates[i] || '').trim() === flowId) return true;
    }
    return false;
  }

  function stateMatchesFlowTarget(state, target) {
    return !!(state && isFlowStepsTarget(target) && flowIdMatchesTarget(state.flowId, target));
  }

  function stateHasLoadedSteps(state) {
    return !!(state && Array.isArray(state._orderedNodes));
  }

  function equivalentFlowId(left, right) {
    left = String(left || '').trim();
    right = String(right || '').trim();
    if (!left || !right) return false;
    if (left === right) return true;
    return left.replace(/^user:/, '') === right.replace(/^user:/, '');
  }

  function mergeStateDisplayMetadata(state) {
    if (!state || !currentState) return state;
    if (!equivalentFlowId(state.flowId, currentState.flowId)) return state;
    var merged = state;
    if (!Array.isArray(state._orderedNodes) && Array.isArray(currentState._orderedNodes)) {
      merged = Object.assign({}, merged, { _orderedNodes: currentState._orderedNodes });
    }
    if (!state._targets && currentState._targets) {
      if (merged === state) merged = Object.assign({}, state);
      merged._targets = currentState._targets;
    }
    return merged;
  }

  function renderIdleStepsForTarget(target, state) {
    if (elStepsTitle) elStepsTitle.textContent = isConversationRunTarget(target) ? '运行状态' : '步骤进度';
    if (!target) {
      elSteps.innerHTML = '<p class="placeholder">请选择运行目标并启动</p>';
      return;
    }
    if (target.type === 'flowGroup') {
      elSteps.innerHTML = '<p class="placeholder">流程组启动后将显示流程组会话</p>';
      return;
    }
    if (isConversationRunTarget(target)) {
      elSteps.innerHTML = '<p class="placeholder">提交后将在后台运行，此处仅显示运行状态</p>';
      return;
    }
    if (!stateMatchesFlowTarget(state, target) || !stateHasLoadedSteps(state)) {
      elSteps.innerHTML = '<p class="placeholder">正在加载步骤进度</p>';
      return;
    }
    renderSteps(state);
  }

  function idleStatusForTarget(target) {
    if (!target) return '空闲';
    if (target.type === 'flowGroup') return '已选择流程组';
    if (isConversationRunTarget(target)) return '已选择对话助手';
    return '已选择流程';
  }

  function canApplyLegacyNodeStatusChange() {
    return !(sessionController && sessionController.hasCurrentRun())
      && stateMatchesFlowTarget(currentState, getSelectedRunTarget())
      && stateHasLoadedSteps(currentState);
  }

  // --- 与 Background 通信 ---

  function sendMessage(type, payload) {
    return runtimeClient.send(type, payload);
  }

  function resourceData(envelope) {
    var primary = envelope && envelope.primary;
    return primary && primary.data && typeof primary.data === 'object' ? primary.data : null;
  }

  function resourceErrorText(error) {
    var code = error && error.code ? '[' + error.code + '] ' : '';
    return code + String(error && error.message ? error.message : (error || '资源请求失败'));
  }

  function loadResourceCollection(uri) {
    var items = [];
    var seenCursors = Object.create(null);
    function read(cursor) {
      var query = { limit: 100 };
      if (cursor) query.cursor = cursor;
      return resourceClient.get(uri, { query: query }).then(function (envelope) {
        var data = resourceData(envelope) || {};
        if (Array.isArray(data.items)) items = items.concat(data.items);
        var nextCursor = String(data.nextCursor || '');
        if (!nextCursor || seenCursors[nextCursor]) return items;
        seenCursors[nextCursor] = true;
        return read(nextCursor);
      });
    }
    return read('');
  }

  function requestFlowList() {
    var requestRevision = ++flowListRequestRevision;
    function capture(promise) {
      return Promise.resolve(promise).then(function (value) {
        return { ok: true, value: value };
      }, function (error) {
        return { ok: false, error: error };
      });
    }
    return Promise.all([
      capture(loadResourceCollection('/flows')),
      capture(loadResourceCollection('/flow-groups')),
      capture(loadResourceCollection('/assistants')),
      capture(resourceClient.get('/agent-settings').then(function (envelope) { return resourceData(envelope) || {}; })),
    ]).then(function (results) {
      if (requestRevision !== flowListRequestRevision) {
        return { stale: true };
      }
      if (results[0].ok) currentFlows = results[0].value;
      if (results[1].ok) currentFlowGroups = results[1].value;
      if (results[2].ok) currentAssistants = results[2].value;
      if (results[3].ok) currentDefaultModelServiceId = String(results[3].value && results[3].value.defaultModelServiceId || '');
      renderFlowOptions();
      syncSelectedFlowState();
      var failures = results.filter(function (result) { return !result.ok; });
      if (failures.length) {
        var message = (failures.length === results.length ? '加载运行目标失败: ' : '部分运行目标加载失败: ')
          + failures.map(function (result) { return resourceErrorText(result.error); }).join('；');
        setStatus(message);
        if (logPanel) logPanel.addLocal(message, 'system', 'error');
      }
      return { flows: currentFlows, flowGroups: currentFlowGroups, failures: failures.length };
    }).catch(function (error) {
      if (requestRevision !== flowListRequestRevision) {
        return { flows: [], flowGroups: [], error: resourceErrorText(error), stale: true };
      }
      var message = '加载运行目标失败: ' + resourceErrorText(error);
      setStatus(message);
      if (logPanel) logPanel.addLocal(message, 'system', 'error');
      return { flows: [], flowGroups: [], error: message };
    });
  }

  function requestState() {
    sendMessage('GET_STATE').then(function (resp) {
      if (resp && resp.ok) {
        updateState(resp.payload);
      }
    });
  }

  function scheduleReferencedDataRefresh(event) {
    var resource = String(event && event.resource || '');
    if (resource === 'assistant') {
      pendingSyncTargets = true;
      pendingSyncConversations = true;
    } else if (resource === 'conversationTopic') {
      pendingSyncConversations = true;
    } else if (['page', 'flow', 'flowGroup', 'script', 'schedule', 'urlTrigger', 'config'].indexOf(resource) >= 0) {
      pendingSyncTargets = true;
      pendingSyncReadiness = true;
    } else {
      return;
    }
    if (syncRefreshTimer) return;
    syncRefreshTimer = window.setTimeout(function () {
      syncRefreshTimer = 0;
      var refreshTargets = pendingSyncTargets;
      var refreshConversations = pendingSyncConversations;
      var refreshReadiness = pendingSyncReadiness;
      pendingSyncTargets = false;
      pendingSyncConversations = false;
      pendingSyncReadiness = false;
      if (refreshTargets) requestFlowList();
      if (refreshConversations && sessionController) sessionController.refreshSessions({ conversationOnly: true });
      if (refreshReadiness) schedulePageReadinessRefresh();
    }, 0);
  }

  if (syncEventStream) syncEventStream.subscribe(scheduleReferencedDataRefresh);

  // --- Content Script 连接监听 ---
  // Side Panel 也需要监听来自 Background 的广播
  lifecycle.subscribe(chrome.runtime.onMessage, function (message) {
    switch (message.type) {
      case 'STATE_UPDATE':
        updateState(message.payload);
        break;
      case 'NEW_LOG': {
        var entry = message.payload || {};
        if (logPanel) logPanel.push(entry);
        break;
      }
      case 'NODE_STATUS_CHANGE': {
        var p = message.payload || {};
        if (!p.runId && canApplyLegacyNodeStatusChange() && sessionController) {
          sessionController.updateNodeStatus(p.nodeId, p.status);
        }
        break;
      }
    }
  });

  // --- 状态更新 ---

  function updateState(state) {
    state = mergeStateDisplayMetadata(state);
    // 有运行会话时步骤区由会话渲染，全局状态仅作旧版回退
    if (!sessionController || !sessionController.hasCurrentRun()) {
      if (sessionController) sessionController.resetStepsRenderTracking();
      if (syncSelectedFlowState(state)) return;
      currentState = state;
      renderIdleStepsForTarget(getSelectedRunTarget(), state);
      return;
    }
    currentState = state;
  }

  function setStatus(text) {
    var raw = String(text || '');
    if (elStatus) {
      elStatus.textContent = compactStatusText(raw);
      elStatus.title = raw;
    }
  }

  function compactStatusText(text) {
    if (!text) return '';
    if (text.indexOf('对话启动失败') >= 0) return '对话启动失败';
    if (text.indexOf('对话已启动') >= 0) return '对话已启动';
    if (text.indexOf('启动对话') >= 0) return '对话启动中';
    if (text.indexOf('停止对话') >= 0) return '对话停止中';
    if (text.indexOf('启动失败') >= 0) return '启动失败';
    if (text.indexOf('继续失败') >= 0) return '继续失败';
    if (text.indexOf('入参') >= 0 && text.indexOf('无效') >= 0) return '入参无效';
    if (text.indexOf('请选择流程') >= 0) return '请选择流程';
    if (text.indexOf('流程组已启动') >= 0) return '已启动';
    if (text.indexOf('已启动') >= 0) return '已启动';
    if (text.indexOf('启动流程组') >= 0) return '启动中';
    if (text.indexOf('启动中') >= 0) return '启动中';
    if (text.indexOf('停止中') >= 0) return '停止中';
    if (text.indexOf('从停止处继续') >= 0) return '继续中';
    if (text.indexOf('从节点继续') >= 0) return '继续中';
    if (text.indexOf('已选择流程组') >= 0) return '已选流程组';
    if (text.indexOf('运行中') >= 0) return '运行中';
    if (text.indexOf('成功') >= 0) return '成功';
    if (text.indexOf('失败') >= 0) return '失败';
    if (text.indexOf('已停止') >= 0) return '已停止';
    return text.length > 12 ? text.slice(0, 12) + '...' : text;
  }

  // --- 渲染 ---

  function getRunTargetStorageArea() {
    if (chrome.storage && chrome.storage.session) return chrome.storage.session;
    if (chrome.storage && chrome.storage.local) return chrome.storage.local;
    return null;
  }

  function loadRunTargetSelection(callback) {
    var area = getRunTargetStorageArea();
    if (!area) {
      setRunTargetValue('');
      callback && callback();
      return;
    }
    area.get(RUN_TARGET_STORAGE_KEY, function (res) {
      var saved = (res && res[RUN_TARGET_STORAGE_KEY]) || {};
      var byTab = saved.byTab || {};
      var value = activeTabId ? (byTab[String(activeTabId)] || '') : '';
      setRunTargetValue(value);
      callback && callback();
    });
  }

  function persistRunTargetSelection(value) {
    var area = getRunTargetStorageArea();
    if (!area) return;
    area.get(RUN_TARGET_STORAGE_KEY, function (res) {
      var saved = (res && res[RUN_TARGET_STORAGE_KEY]) || {};
      var byTab = Object.assign({}, saved.byTab || {});
      if (activeTabId) {
        if (value) byTab[String(activeTabId)] = value;
        else delete byTab[String(activeTabId)];
      }
      var patch = {};
      patch[RUN_TARGET_STORAGE_KEY] = { byTab: byTab };
      area.set(patch);
    });
  }

  function setRunTargetValue(value, options) {
    options = options || {};
    runTargetValue = value || '';
    if (elFlow && elFlow.value !== runTargetValue) elFlow.value = runTargetValue;
    if (options.persist) persistRunTargetSelection(runTargetValue);
    if (options.renderInput) renderRuntimeInputs(options);
  }

  function buildFallbackRunTarget(value) {
    if (!value) return null;
    if (value.indexOf('assistant:') === 0) {
      return {
        type: 'assistant',
        value: value,
        id: value.slice(10),
        rawId: value.slice(10),
        label: value.slice(10),
        description: '',
        inputDescription: '直接输入后台任务内容即可；只有需要自定义 label 或 modelServiceId 时，才需要改用 JSON。',
        outputDescription: '',
        inputExample: '',
        inputPlaceholder: '直接输入对话内容，例如：请帮我检查当前页面并给出建议',
        inputRequired: true,
      };
    }
    return null;
  }

  function selectedFlowResource(target) {
    if (!target || target.type !== 'flow') return null;
    for (var index = 0; index < currentFlows.length; index++) {
      if (flowIdMatchesTarget(currentFlows[index] && currentFlows[index].id, target)) return currentFlows[index];
    }
    return null;
  }

  function syncSelectedFlowState(runtimeState) {
    if (sessionController && sessionController.hasCurrentRun()) return false;
    var target = getSelectedRunTarget();
    var flow = selectedFlowResource(target);
    if (!flow) {
      renderIdleStepsForTarget(target, currentState);
      return false;
    }
    var nodes = (Array.isArray(flow.nodes) ? flow.nodes : []).map(function (node) {
      var copy = Object.assign({}, node || {});
      copy.nodeId = String(copy.nodeId || copy.id || '');
      return copy;
    }).filter(function (node) { return !!node.nodeId; }).sort(function (left, right) {
      return (Number(left.displayOrder) || 0) - (Number(right.displayOrder) || 0);
    });
    var baseState = stateMatchesFlowTarget(runtimeState, target)
      ? runtimeState
      : (stateMatchesFlowTarget(currentState, target) ? currentState : null);
    currentState = Object.assign({}, baseState || {}, {
      flowId: String(flow.id || target.rawId || target.id || ''),
      nodeStatuses: Object.assign({}, baseState && baseState.nodeStatuses || {}),
      _orderedNodes: nodes,
      _targets: flow.targets && typeof flow.targets === 'object' ? flow.targets : {},
    });
    renderIdleStepsForTarget(target, currentState);
    return true;
  }

  function runTargetForSession(session) {
    if (!session || session.status !== 'running') return null;
    var flowId = String(session.flowId || '');
    var groupId = String(session.flowGroupId || (flowId.indexOf('flowGroup:') === 0 ? flowId.slice(10) : ''));
    var assistantId = String(session.assistantId || '');
    for (var i = 0; i < currentRunTargets.length; i++) {
      var target = currentRunTargets[i];
      if (target.type === 'assistant' && assistantId
          && String(target.rawId || target.id || '') === assistantId) return target;
      if (target.type === 'flowGroup' && groupId
          && String(target.rawId || target.id || '') === groupId) return target;
      if (target.type === 'flow' && flowIdMatchesTarget(flowId, target)) return target;
    }
    return null;
  }

  function renderFlowOptions() {
    var selected = runTargetValue || elFlow.value;
    currentRunTargets = [];
    elFlow.innerHTML = '<option value="">-- 选择流程、流程组或对话助手 --</option>';

    function appendTarget(group, target) {
      currentRunTargets.push(target);
      var opt = document.createElement('option');
      opt.value = target.value;
      opt.textContent = target.label;
      group.appendChild(opt);
    }

    var flowGroup = document.createElement('optgroup');
    flowGroup.label = '流程';
    for (var i = 0; i < currentFlows.length; i++) {
      var f = currentFlows[i];
      appendTarget(flowGroup, {
        type: 'flow',
        value: f.id,
        id: f.id,
        rawId: String(f.id || '').replace(/^user:/, ''),
        label: f.label || f.id,
        description: f.description || '',
        inputDescription: f.inputDescription || '',
        outputDescription: f.outputDescription || '',
        inputExample: f.inputExample || '',
      });
    }
    if (flowGroup.children.length) elFlow.appendChild(flowGroup);

    var fgGroup = document.createElement('optgroup');
    fgGroup.label = '流程组';
    for (var j = 0; j < currentFlowGroups.length; j++) {
      var g = currentFlowGroups[j];
      appendTarget(fgGroup, {
        type: 'flowGroup',
        value: 'flowGroup:' + g.id,
        id: g.id,
        rawId: g.id,
        label: g.label || g.name || g.id,
        description: g.description || '',
        inputDescription: g.inputDescription || '',
        outputDescription: g.outputDescription || '',
        inputExample: g.inputExample || '',
      });
    }
    if (fgGroup.children.length) elFlow.appendChild(fgGroup);

    var assistantGroup = document.createElement('optgroup');
    assistantGroup.label = '对话助手';
    for (var k = 0; k < currentAssistants.length; k++) {
      var a = currentAssistants[k];
      appendTarget(assistantGroup, {
        type: 'assistant',
        value: 'assistant:' + a.id,
        id: a.id,
        rawId: a.id,
        label: a.name || a.id,
        description: a.description || '',
        modelServiceId: a.modelServiceId || '',
        settings: a.settings || {},
        inputDescription: '直接输入后台任务内容即可；只有需要自定义标签或模型服务时，才需要使用 JSON。message 为主输入，label 可作为任务标签，modelServiceId 可指定模型服务。',
        outputDescription: '',
        inputExample: '',
        inputPlaceholder: '直接输入对话内容，例如：请帮我检查当前页面并给出建议',
        inputRequired: true,
      });
    }
    if (assistantGroup.children.length) elFlow.appendChild(assistantGroup);

    var currentSession = sessionController
      ? sessionController.findRunningSessionForActiveTab()
        || sessionController.findRunningOccupancyForActiveTab()
      : null;
    var runningTarget = runTargetForSession(currentSession);
    if (runningTarget) selected = runningTarget.value;

    var selectedExists = selected && currentRunTargets.some(function (target) { return target.value === selected; });

    if (selected && !selectedExists) {
      var fallback = buildFallbackRunTarget(selected);
      if (fallback) {
        currentRunTargets.push(fallback);
        var fallbackOpt = document.createElement('option');
        fallbackOpt.value = fallback.value;
        fallbackOpt.textContent = fallback.label || fallback.value;
        elFlow.appendChild(fallbackOpt);
        selectedExists = true;
      }
    }

    if (selectedExists) {
      setRunTargetValue(selected);
    } else if (!selected) {
      setRunTargetValue('');
    }
    renderRuntimeInputs();
    if (sessionController) sessionController.renderSessionOptions({ force: true });
  }

  function getSelectedRunTarget() {
    var value = elFlow.value || runTargetValue;
    if (!value) return null;
    for (var i = 0; i < currentRunTargets.length; i++) {
      if (currentRunTargets[i].value === value) return currentRunTargets[i];
    }
    return buildFallbackRunTarget(value);
  }

  function isConversationRunTarget(target) {
    return !!(target && target.type === 'assistant');
  }

  function isConversationSession(session) {
    return !!(session && session.kind === 'conversation');
  }

  function isConversationRunId(runId) {
    return String(runId || '').indexOf('conversation:') === 0;
  }

  function renderRuntimeInputs(options) {
    if (runtimeInputController) runtimeInputController.render(options);
  }

  function collectRuntimeContext(target) {
    return runtimeInputController ? runtimeInputController.collect(target) : {};
  }

  function applySessionInputToRuntime(session) {
    if (runtimeInputController) runtimeInputController.applySessionInput(session);
  }

  function setRuntimeInputsDisabled(disabled) {
    if (runtimeInputController) runtimeInputController.setDisabled(disabled);
  }

  function renderSteps(state) {
    if (!state || !state._orderedNodes) {
      elSteps.innerHTML = '<p class="placeholder">请选择运行目标并启动</p>';
      return;
    }
    if (!state._orderedNodes.length) {
      elSteps.innerHTML = '<p class="placeholder">该流程没有节点信息</p>';
      return;
    }

    var nodes = state._orderedNodes;
    var statuses = state.nodeStatuses || {};
    var html = '';

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var status = statuses[node.nodeId] || 'pending';
      var icon = STATUS_ICONS[status] || '?';
      var cls = STATUS_CLASSES[status] || '';

      html += '<div class="step-item ' + cls + '" data-node-id="' + escapeHtml(node.nodeId) + '">';
      html += '<span class="step-icon">' + icon + '</span>';
      html += '<span class="step-order">' + (node.displayOrder || (i + 1)) + '.</span>';
      html += '<span class="step-title">' + escapeHtml(node.title || node.nodeId) + '</span>';
      if (isUserFlow(state.flowId)) {
        html += '<button class="step-resume" data-resume="' + escapeHtml(node.nodeId) + '" title="从此节点继续运行（之前节点跳过，保留变量）">继续</button>';
      }
      html += '</div>';
    }

    elSteps.innerHTML = html;
  }

  function createSessionControllerApi() {
    return {
      lifecycleApi: window.PageAutomationLifecycle,
      document: document,
      window: window,
      browser: chrome,
      elements: {
        sessionSelect: elSession,
        stepsContainer: elSteps,
        stepsTitle: elStepsTitle,
        outputSection: elOutputSection,
        detailsElement: $('session-details'),
      },
      statusIcons: STATUS_ICONS,
      statusClasses: STATUS_CLASSES,
      sendMessage: sendMessage,
      getSelectedRunTarget: getSelectedRunTarget,
      isConversationRunTarget: isConversationRunTarget,
      isConversationSession: isConversationSession,
      isConversationRunId: isConversationRunId,
      getActiveTabId: function () { return activeTabId || 0; },
      getCurrentState: function () { return currentState; },
      renderIdleStepsForTarget: renderIdleStepsForTarget,
      idleStatusForTarget: idleStatusForTarget,
      applySessionInputToRuntime: applySessionInputToRuntime,
      setStatus: setStatus,
      escapeHtml: escapeHtml,
      onAssistantsChanged: function (nextAssistants) {
        currentAssistants = nextAssistants || [];
        renderFlowOptions();
      },
      getRunEntry: function () { return runEntry; },
      getLogPanel: function () { return logPanel; },
      getDebugPanel: function () { return debugPanel; },
      now: function () { return Date.now(); },
    };
  }

  function createRunEntryApi() {
    return {
      lifecycleApi: window.PageAutomationLifecycle,
      window: window,
      browser: chrome,
      resourceClient: resourceClient,
      elements: {
        runButton: elRun,
        flowSelect: elFlow,
        sessionSelect: elSession,
        clearSessionsButton: elClearSessions,
        stepsContainer: elSteps,
      },
      sendMessage: sendMessage,
      setStatus: setStatus,
      setLogScope: function (scope, rerender) { if (logPanel) logPanel.setScope(scope, rerender); },
      addLocalLog: function (message, scope, level, extra) {
        if (logPanel) logPanel.addLocal(message, scope, level, extra);
      },
      refreshSessions: function (options) {
        return sessionController.refreshSessions(options);
      },
      trackActiveTab: trackActiveTab,
      getSelectedRunTarget: getSelectedRunTarget,
      collectRuntimeContext: collectRuntimeContext,
      findSessionByRunId: function (runId) {
        return sessionController.findSessionByRunId(runId);
      },
      findRunningSessionForActiveTab: function () {
        return sessionController.findRunningSessionForActiveTab();
      },
      findRunningOccupancyForActiveTab: function () {
        return sessionController.findRunningOccupancyForActiveTab();
      },
      isSidepanelOwnedSession: function (session) {
        return sessionController.isSidepanelOwnedSession(session);
      },
      isActiveTabRunOccupied: function () {
        return sessionController.isActiveTabRunOccupied();
      },
      getCurrentRunId: function () { return sessionController.getCurrentRunId(); },
      getCurrentState: function () {
        return stateMatchesFlowTarget(currentState, getSelectedRunTarget()) ? currentState : null;
      },
      getActiveTabContext: function () {
        return { tabId: activeTabId || 0, windowId: activeWindowId || 0 };
      },
      getRunOptions: function () {
        return {
          totalRuns: 1,
          maxRetries: 0,
        };
      },
      getDefaultModelServiceId: function () { return currentDefaultModelServiceId; },
      setPinnedRunId: function (runId, meta) {
        return sessionController.setPinnedRunId(runId, meta);
      },
      onFlowChange: onFlowChange,
      onSessionFocusChange: function (focused) {
        sessionController.onSessionFocusChange(focused);
      },
      onSessionChange: function (runId) {
        sessionController.onSessionChange(runId);
      },
      onClearSessions: function () {
        sessionController.onClearSessions();
      },
      setRuntimeInputsDisabled: setRuntimeInputsDisabled,
      refreshControlStates: function () {
        sessionController.refreshControlStates();
      },
    };
  }

  // --- 事件处理 ---

  function onFlowChange() {
    setRunTargetValue(elFlow.value || '', { persist: true });
    sessionController.onTargetChanged();
    var target = getSelectedRunTarget();
    var flowId = target && target.value;
    renderRuntimeInputs({ forceTargetInput: true });
    renderIdleStepsForTarget(target, currentState);
    if (!flowId) {
      setStatus(idleStatusForTarget(target), '');
      sessionController.refreshControlStates();
      return;
    }
    if (target && target.type === 'flowGroup') {
      setStatus(idleStatusForTarget(target), '');
      sessionController.refreshControlStates();
      return;
    }
    if (target && target.type === 'assistant') {
      setStatus(idleStatusForTarget(target), '');
      sessionController.refreshControlStates();
      return;
    }
    setStatus(idleStatusForTarget(target), '');
    sessionController.refreshControlStates();
    syncSelectedFlowState();
  }

  // --- 通用工具 ---

  function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function isUserFlow(flowId) {
    return typeof flowId === 'string' && flowId.indexOf('user:') === 0;
  }

  function teardown(event) {
    if (event && event.persisted) return;
    if (tornDown) return;
    tornDown = true;
    if (readinessRefreshTimer) clearTimeout(readinessRefreshTimer);
    if (syncRefreshTimer) window.clearTimeout(syncRefreshTimer);
    if (sidepanelLifecycleReconnectTimer) window.clearTimeout(sidepanelLifecycleReconnectTimer);
    readinessRefreshTimer = 0;
    syncRefreshTimer = 0;
    sidepanelLifecycleReconnectTimer = 0;
    if (sessionController) sessionController.destroy();
    if (runEntry) runEntry.destroy();
    if (runtimeInputController) runtimeInputController.destroy();
    if (debugPanel) debugPanel.destroy();
    if (logPanel) logPanel.destroy();
    if (syncEventStream) syncEventStream.destroy();
    lifecycle.destroy();
    if (sidepanelLifecyclePort) {
      try { sidepanelLifecyclePort.disconnect(); } catch (_) {}
      sidepanelLifecyclePort = null;
    }
  }

  // --- 启动 ---
  init();
  lifecycle.listen(window, 'pagehide', teardown);

  // 定时刷新状态与会话（每 2 秒）
  lifecycle.interval(function () {
    requestState();
    if (sessionController) sessionController.refreshSessions();
  }, 2000);
})();
