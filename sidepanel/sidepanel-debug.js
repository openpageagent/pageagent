(function attachSidepanelDebugPanel(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidepanelDebugPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEBUG_REFRESH_INTERVAL_MS = 1500;
  var DEBUG_TABS = { variables: true, ctx: true, flowdata: true, trace: true };

  function escapeHtml(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char];
    });
  }

  function stringifyDebugValue(value) {
    try {
      var result = JSON.stringify(value, null, 2);
      return result === undefined ? String(value) : result;
    } catch (err) {
      return '序列化失败: ' + (err && err.message ? err.message : String(err));
    }
  }

  function getValueType(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'Array';
    if (typeof value === 'object') return 'Object';
    if (typeof value === 'string') return 'String';
    if (typeof value === 'number') return 'Number';
    if (typeof value === 'boolean') return 'Boolean';
    return typeof value;
  }

  function isExpandableValue(value) {
    return !!(value && typeof value === 'object' && Object.keys(value).length);
  }

  function summaryTreeValue(value, isFlowData) {
    if (isFlowData) return ' {attributes, content}';
    if (Array.isArray(value)) return ' [' + value.length + ']';
    return ' {' + Object.keys(value || {}).length + '}';
  }

  function previewTreeValue(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value.length > 120 ? value.slice(0, 120) + '...' : value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return stringifyDebugValue(value).slice(0, 160);
  }

  function variablePathKey(path) {
    return JSON.stringify(path || []);
  }

  function renderVariableItem(key, value, depth, path, isPathExpanded) {
    var type = getValueType(value);
    var isFlowData = value && typeof value === 'object' && 'attributes' in value && 'content' in value;
    var expandable = isExpandableValue(value);
    var expanded = expandable && (typeof isPathExpanded === 'function'
      ? isPathExpanded(path, depth)
      : depth === 0);
    var html = '<div class="tree-item' + (expandable && !expanded ? ' collapsed' : '') + '">';
    html += '<div class="tree-row" style="padding-left: ' + (depth * 16) + 'px;" data-tree-row'
      + (expandable ? ' data-tree-path="' + escapeHtml(variablePathKey(path)) + '"' : '') + '>';
    if (expandable) {
      html += '<button type="button" class="tree-toggle" data-tree-toggle aria-expanded="' + (expanded ? 'true' : 'false') + '">' + (expanded ? '▼' : '▶') + '</button>';
    } else {
      html += '<span class="tree-toggle placeholder"></span>';
    }
    html += '<span class="tree-item-key">' + escapeHtml(key) + '</span>';
    html += '<span class="tree-item-type">(' + (isFlowData ? 'FlowData' : type) + ')</span>';
    html += expandable
      ? '<span class="tree-item-value">' + escapeHtml(summaryTreeValue(value, isFlowData)) + '</span>'
      : '<span class="tree-item-value">: ' + escapeHtml(previewTreeValue(value)) + '</span>';
    html += '</div>';
    if (expandable) html += '<div class="tree-children">' + renderTreeChildren(value, depth + 1, path, isPathExpanded) + '</div>';
    return html + '</div>';
  }

  function renderTreeChildren(value, depth, path, isPathExpanded) {
    if (depth > 8) return '<div class="tree-overflow">已达到最大展开深度</div>';
    var keys = Array.isArray(value) ? value.map(function (_, index) { return String(index); }) : Object.keys(value || {});
    var maxChildren = 100;
    var html = '';
    for (var i = 0; i < keys.length && i < maxChildren; i++) {
      var key = keys[i];
      html += renderVariableItem(key, value[key], depth, (path || []).concat([key]), isPathExpanded);
    }
    if (keys.length > maxChildren) html += '<div class="tree-overflow">还有 ' + (keys.length - maxChildren) + ' 项未展开显示</div>';
    return html;
  }

  function create(options) {
    options = options || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var sendMessage = options.sendMessage;
    var getRunId = options.getRunId || function () { return ''; };
    var outputSection = options.outputSection || doc.getElementById('output-section');
    var debugSection = options.debugSection || doc.getElementById('debug-section');
    var refreshButton = options.refreshButton || doc.getElementById('btn-refresh-debug');
    var variablesTree = options.variablesTree || doc.getElementById('variables-tree');
    var ctxViewer = options.ctxViewer || doc.getElementById('ctx-viewer');
    var attributesViewer = options.attributesViewer || doc.getElementById('attributes-viewer');
    var contentViewer = options.contentViewer || doc.getElementById('content-viewer');
    var traceTimeline = options.traceTimeline || doc.getElementById('trace-timeline');
    var currentOutputTab = 'log';
    var currentDebugTab = 'variables';
    var refreshInFlight = false;
    var refreshQueued = false;
    var refreshTimer = 0;
    var lastRefreshAt = 0;
    var requestRevision = 0;
    var variableExpansionRunId = '';
    var variableExpansionState = Object.create(null);
    var initialized = false;
    var destroyed = false;
    var unbind = [];

    function listen(target, type, handler) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, handler);
      unbind.push(function () { target.removeEventListener(type, handler); });
    }

    function invalidateRequests() {
      requestRevision += 1;
      return requestRevision;
    }

    function requestIsCurrent(request) {
      return !destroyed
        && request.revision === requestRevision
        && request.runId === String(getRunId() || '')
        && request.outputTab === currentOutputTab
        && request.debugTab === currentDebugTab;
    }

    function isTransportFailure(response) {
      return !!(response && response.transportError);
    }

    function setEmpty(element, text, compact) {
      if (!element) return;
      element.innerHTML = '<p class="debug-empty' + (compact ? ' compact' : '') + '">' + escapeHtml(text) + '</p>';
    }

    function syncVariableExpansionRun(runId) {
      runId = String(runId || '');
      if (runId === variableExpansionRunId) return;
      variableExpansionRunId = runId;
      variableExpansionState = Object.create(null);
    }

    function isVariablePathExpanded(path, depth) {
      var key = variablePathKey(path);
      return Object.prototype.hasOwnProperty.call(variableExpansionState, key)
        ? variableExpansionState[key]
        : depth === 0;
    }

    function renderVariablesTree(ctx, runId) {
      if (!variablesTree) return;
      syncVariableExpansionRun(runId);
      if (!ctx || typeof ctx !== 'object') {
        setEmpty(variablesTree, '无变量');
        return;
      }
      var visibleKeys = Object.keys(ctx).filter(function (key) { return key.indexOf('_') !== 0; });
      if (!visibleKeys.length) {
        setEmpty(variablesTree, '无变量');
        return;
      }
      variablesTree.innerHTML = visibleKeys.map(function (key) {
        return renderVariableItem(key, ctx[key], 0, [key], isVariablePathExpanded);
      }).join('');
    }

    function renderCtx(ctx) {
      if (ctxViewer) ctxViewer.textContent = stringifyDebugValue(ctx);
    }

    function renderFlowData(last) {
      var isFlowData = last && typeof last === 'object' && 'attributes' in last && 'content' in last;
      if (isFlowData) {
        attributesViewer.textContent = stringifyDebugValue(last.attributes);
        contentViewer.textContent = stringifyDebugValue(last.content);
        return;
      }
      setEmpty(attributesViewer, 'last 不是 FlowData', true);
      contentViewer.textContent = stringifyDebugValue(last);
    }

    function renderDebugTrace(trace) {
      if (!traceTimeline) return;
      if (!Array.isArray(trace) || !trace.length) {
        setEmpty(traceTimeline, '无追踪记录');
        return;
      }
      var html = '';
      for (var i = 0; i < trace.length; i++) {
        var record = trace[i] || {};
        var statusIcon = record.status === 'completed' ? '✓' : '✗';
        html += '<div class="trace-item collapsed' + (record.status === 'failed' ? ' failed' : '') + '">';
        html += '<div class="trace-header"><span class="trace-node-info">[节点' + (i + 1) + ': '
          + escapeHtml(record.nodeTitle || record.nodeId) + '] ' + statusIcon + '</span>';
        html += '<span class="trace-time">' + escapeHtml(record.executionTime) + 'ms</span></div>';
        html += '<div class="trace-body"><div class="trace-label">Input:</div><div class="trace-data">'
          + escapeHtml(stringifyDebugValue(record.input)) + '</div>';
        if (record.status === 'completed' && record.output !== undefined) {
          html += '<div class="trace-label">Output:</div><div class="trace-data">'
            + escapeHtml(stringifyDebugValue(record.output)) + '</div>';
        }
        if (record.error) {
          html += '<div class="trace-label">Error:</div><div class="trace-data trace-error">'
            + escapeHtml(record.error) + '</div>';
        }
        html += '</div></div>';
      }
      traceTimeline.innerHTML = html;
    }

    function loadVariables(request) {
      return sendMessage('GET_RUN_CONTEXT', { runId: request.runId }).then(function (response) {
        if (!requestIsCurrent(request)) return;
        if (response && response.ok && response.payload) renderVariablesTree(response.payload, request.runId);
        else setEmpty(variablesTree, isTransportFailure(response) ? '加载失败' : '无变量数据');
      }, function () {
        if (requestIsCurrent(request)) setEmpty(variablesTree, '加载失败');
      });
    }

    function loadCtx(request) {
      return sendMessage('GET_RUN_CONTEXT', { runId: request.runId }).then(function (response) {
        if (!requestIsCurrent(request)) return;
        if (response && response.ok) renderCtx(response.payload || {});
        else setEmpty(ctxViewer, isTransportFailure(response) ? '加载失败' : '无 ctx 数据', true);
      }, function () {
        if (requestIsCurrent(request)) setEmpty(ctxViewer, '加载失败', true);
      });
    }

    function loadFlowData(request) {
      return sendMessage('GET_RUN_CONTEXT', { runId: request.runId, ctxMode: 'paths', ctxPaths: ['last'] }).then(function (response) {
        if (!requestIsCurrent(request)) return;
        if (response && response.ok && response.payload && response.payload.last !== undefined) {
          renderFlowData(response.payload.last);
        } else {
          var label = isTransportFailure(response) ? '加载失败' : '无 FlowData';
          setEmpty(attributesViewer, label, true);
          setEmpty(contentViewer, label, true);
        }
      }, function () {
        if (!requestIsCurrent(request)) return;
        setEmpty(attributesViewer, '加载失败', true);
        setEmpty(contentViewer, '加载失败', true);
      });
    }

    function loadDebugTrace(request) {
      return sendMessage('GET_DEBUG_TRACE', { runId: request.runId }).then(function (response) {
        if (!requestIsCurrent(request)) return;
        if (response && response.ok && response.payload) renderDebugTrace(response.payload);
        else setEmpty(traceTimeline, isTransportFailure(response) ? '加载失败' : '无追踪数据');
      }, function () {
        if (requestIsCurrent(request)) setEmpty(traceTimeline, '加载失败');
      });
    }

    function finishRefresh() {
      refreshInFlight = false;
      if (!refreshQueued || destroyed) return;
      refreshQueued = false;
      refresh({ force: true });
    }

    function refresh(options) {
      options = options || {};
      if (destroyed || currentOutputTab !== 'debug') return Promise.resolve();
      var runId = String(getRunId() || '');
      if (!runId) return Promise.resolve();
      var revision = invalidateRequests();
      var now = Date.now();
      var elapsed = now - lastRefreshAt;
      if (!options.force && elapsed < DEBUG_REFRESH_INTERVAL_MS) {
        if (!refreshTimer) {
          refreshTimer = setTimeout(function () {
            refreshTimer = 0;
            refresh({ force: true });
          }, DEBUG_REFRESH_INTERVAL_MS - elapsed);
        }
        return Promise.resolve();
      }
      if (refreshInFlight) {
        refreshQueued = true;
        return Promise.resolve();
      }

      refreshInFlight = true;
      lastRefreshAt = now;
      var request = {
        revision: revision,
        runId: runId,
        outputTab: currentOutputTab,
        debugTab: currentDebugTab,
      };
      var work = currentDebugTab === 'variables' ? loadVariables(request)
        : currentDebugTab === 'ctx' ? loadCtx(request)
          : currentDebugTab === 'flowdata' ? loadFlowData(request)
            : loadDebugTrace(request);
      return Promise.resolve(work).then(function (result) {
        finishRefresh();
        return result;
      }, function (err) {
        finishRefresh();
        return err;
      });
    }

    function switchOutputTab(tab) {
      tab = tab === 'debug' ? 'debug' : 'log';
      currentOutputTab = tab;
      invalidateRequests();
      var tabs = doc.querySelectorAll('.output-tab');
      var panels = doc.querySelectorAll('.output-panel');
      var actions = doc.querySelectorAll('[data-output-action]');
      for (var i = 0; i < tabs.length; i++) {
        var active = tabs[i].dataset.outputTab === tab;
        tabs[i].classList.toggle('active', active);
        tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (var j = 0; j < panels.length; j++) panels[j].classList.toggle('active', panels[j].dataset.outputPanel === tab);
      for (var k = 0; k < actions.length; k++) actions[k].hidden = actions[k].dataset.outputAction !== tab;
      return tab === 'debug' ? refresh({ force: true }) : Promise.resolve();
    }

    function switchDebugTab(tab) {
      currentDebugTab = DEBUG_TABS[tab] ? tab : 'variables';
      invalidateRequests();
      var tabs = debugSection.querySelectorAll('.debug-tab');
      var panels = debugSection.querySelectorAll('.debug-tab-panel');
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === currentDebugTab);
      for (var j = 0; j < panels.length; j++) {
        var active = panels[j].dataset.panel === currentDebugTab;
        panels[j].classList.toggle('active', active);
        panels[j].style.display = active ? 'block' : 'none';
      }
      return refresh({ force: true });
    }

    function onVariablesClick(event) {
      var row = event.target && event.target.closest ? event.target.closest('[data-tree-row]') : null;
      if (!row || !variablesTree.contains(row)) return;
      var item = row.parentElement;
      var toggle = row.querySelector('[data-tree-toggle]');
      if (!item || !toggle) return;
      syncVariableExpansionRun(getRunId());
      item.classList.toggle('collapsed');
      var expanded = !item.classList.contains('collapsed');
      var path = row.getAttribute('data-tree-path');
      if (path) variableExpansionState[path] = expanded;
      toggle.textContent = expanded ? '▼' : '▶';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      event.preventDefault();
      event.stopPropagation();
    }

    function onTraceClick(event) {
      var header = event.target && event.target.closest ? event.target.closest('.trace-header') : null;
      if (header && traceTimeline.contains(header) && header.parentElement) header.parentElement.classList.toggle('collapsed');
    }

    function init() {
      if (initialized || destroyed || !outputSection || !debugSection) return;
      initialized = true;
      var outputTabs = outputSection.querySelectorAll('.output-tab');
      for (var i = 0; i < outputTabs.length; i++) {
        (function (button) { listen(button, 'click', function () { switchOutputTab(button.dataset.outputTab); }); })(outputTabs[i]);
      }
      var debugTabs = debugSection.querySelectorAll('.debug-tab');
      for (var j = 0; j < debugTabs.length; j++) {
        (function (button) { listen(button, 'click', function () { switchDebugTab(button.dataset.tab); }); })(debugTabs[j]);
      }
      listen(refreshButton, 'click', function () { refresh({ force: true }); });
      listen(variablesTree, 'click', onVariablesClick);
      listen(traceTimeline, 'click', onTraceClick);
      switchOutputTab(currentOutputTab);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      invalidateRequests();
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = 0;
      refreshQueued = false;
      while (unbind.length) unbind.pop()();
    }

    return {
      init: init,
      destroy: destroy,
      refresh: refresh,
      switchOutputTab: switchOutputTab,
      switchDebugTab: switchDebugTab,
      getOutputTab: function () { return currentOutputTab; },
      getDebugTab: function () { return currentDebugTab; },
    };
  }

  return {
    create: create,
    escapeHtml: escapeHtml,
    stringifyDebugValue: stringifyDebugValue,
  };
});
