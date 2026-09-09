(function attachOptionsRunReportController(root, factory) {
  'use strict';

  var commonJs = typeof module === 'object' && module.exports;
  var resourceClientApi = root && root.PageAutomationResourceClient;
  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !resourceClientApi) resourceClientApi = require('../ui/resource-client.js');
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(resourceClientApi, lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsRunReportController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ResourceClientApi, LifecycleApi) {
  'use strict';

  function escapeHtml(value) {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var RUN_STATUS_TEXT = {
    queued: '排队中', starting: '启动中', pending: '等待中', running: '运行中',
    idle: '待继续', paused: '已暂停', pausing: '暂停中', success: '成功', failed: '失败', stopped: '已停止',
  };
  var RUN_ENTRY_TEXT = {
    manual: '手动', sidepanel: '侧边栏', schedule: '定时运行', urlTrigger: 'URL 触发',
    webhook: 'Webhook', mcp: 'MCP', flowGroup: '流程组合',
  };

  function formatStatus(status) {
    var key = String(status === undefined || status === null ? '' : status);
    return Object.prototype.hasOwnProperty.call(RUN_STATUS_TEXT, key) ? RUN_STATUS_TEXT[key] : key;
  }

  function defaultFormatTime(timestamp) {
    if (!timestamp) return '—';
    var date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  function runEntryDisplay(run) {
    var trigger = String(run && run.trigger || '').trim();
    var entry = String(run && run.entry || '').trim();
    if (!entry) {
      if (trigger.indexOf('schedule:') === 0) entry = 'schedule';
      else if (trigger.indexOf('url:') === 0) entry = 'urlTrigger';
      else if (trigger.indexOf('mcp') === 0) entry = 'mcp';
      else if (trigger.indexOf('flowGroup:') === 0) entry = 'flowGroup';
      else entry = 'manual';
    }
    var detail = '';
    if (entry === 'urlTrigger' && trigger.indexOf('url:') === 0) detail = trigger.slice(4);
    else if (entry === 'schedule' && trigger.indexOf('schedule:') === 0) detail = trigger.slice(9);
    else if (trigger && trigger !== 'manual' && trigger !== entry) detail = trigger;
    return {
      label: Object.prototype.hasOwnProperty.call(RUN_ENTRY_TEXT, entry) ? RUN_ENTRY_TEXT[entry] : entry,
      detail: detail,
    };
  }

  function formatLogTime(timestamp) {
    var date = new Date(timestamp);
    function pad(number, length) {
      var text = String(number);
      while (text.length < length) text = '0' + text;
      return text;
    }
    return pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2)
      + '.' + pad(date.getMilliseconds(), 3);
  }

  function create(options) {
    options = options || {};
    var runtime = options.runtime || (typeof chrome !== 'undefined' && chrome.runtime);
    var resourceClientFactory = options.resourceClientApi || ResourceClientApi;
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!resourceClientFactory || typeof resourceClientFactory.create !== 'function') {
      throw new Error('PageAutomationResourceClient must load before OptionsRunReportController');
    }
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsRunReportController');
    }

    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var timerHost = options.window || (typeof window !== 'undefined' ? window : globalThis);
    var lifecycle = options.lifecycle || lifecycleFactory.create(timerHost);
    var resourceClient = options.resourceClient || resourceClientFactory.create(runtime);
    var $ = function (selector) { return doc && doc.querySelector ? doc.querySelector(selector) : null; };
    var esc = options.escapeHtml || escapeHtml;
    var fmtTime = options.formatTime || defaultFormatTime;
    var paginateConfigList = options.paginate || function (runs) {
      return { total: runs.length, cursor: 0, limit: runs.length || 1, items: runs };
    };
    var renderConfigListPagination = options.renderPagination || function () { return ''; };
    var NodeTypes = options.nodeTypes || { getTypeLabel: function (type) { return type || 'unknown'; } };
    var toast = options.toast || function () {};
    var confirmAction = options.confirm || function () { return true; };
    var openDrawer = options.openDrawer || function () {};
    var closeDrawer = options.closeDrawer || function () {};
    var download = options.download || null;
    var expandedRunIds = Object.create(null);
    var detailInFlight = Object.create(null);
    var initialized = false;
    var destroyed = false;
    var refreshSequence = 0;
    var refreshInFlight = null;
    var pendingActions = Object.create(null);

  var lastRuns = [];
  var CHART_COLORS = {
    success: '#1a9964',
    passed: '#1a9964',
    failed: '#ba554a',
    running: '#4086e0',
    idle: '#4086e0',
    stopped: '#9b6a6c',
    skipped: '#728e9b',
  };

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function statusText(status) {
    return esc(formatStatus(status));
  }

  function chartColor(status) {
    return hasOwn(CHART_COLORS, status) ? CHART_COLORS[status] : CHART_COLORS.skipped;
  }

  function isActiveRunHistoryStatus(status) {
    status = String(status || '').toLowerCase();
    return status === 'running' || status === 'idle' || status === 'queued' || status === 'starting'
      || status === 'pending' || status === 'paused' || status === 'pausing';
  }

  function normalizeRunStatus(status) {
    status = String(status || '').trim().toLowerCase();
    if (status === 'completed' || status === 'passed' || status === 'succeeded' || status === 'done' || status === 'manual_completed') return 'success';
    if (status === 'error' || status === 'failure') return 'failed';
    if (status === 'cancelled' || status === 'canceled') return 'stopped';
    return status || 'failed';
  }

  function normalizeRun(run, index) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
    var runId = String(run.runId || run.id || '');
    if (!runId) return null;
    var normalized = Object.assign({}, run);
    normalized.id = runId;
    normalized.runId = String(run.runId || runId);
    normalized.status = normalizeRunStatus(run.status);
    normalized.flowId = String(run.flowId || run.flow && run.flow.id || '');
    normalized.flowLabel = String(run.flowLabel || run.flowName || run.flow && run.flow.label || normalized.flowId || normalized.id);
    normalized.summaries = (Array.isArray(run.summaries) ? run.summaries : []).filter(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item);
    });
    normalized.flowGroupResults = (Array.isArray(run.flowGroupResults) ? run.flowGroupResults : []).filter(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item);
    });
    normalized.logs = (Array.isArray(run.logs) ? run.logs : []).filter(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item);
    });
    normalized.tabUsage = run.tabUsage && typeof run.tabUsage === 'object' && !Array.isArray(run.tabUsage) ? run.tabUsage : {};
    return normalized;
  }

  function normalizeRunHistoryPayload(payload) {
    var source = Array.isArray(payload)
      ? payload
      : (payload && Array.isArray(payload.runs) ? payload.runs : (payload && Array.isArray(payload.items) ? payload.items : []));
    return source.map(normalizeRun).filter(Boolean);
  }

  function resourceSegment(value) {
    return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function resourceData(envelope) {
    var primary = envelope && envelope.primary;
    return primary && primary.data && typeof primary.data === 'object' ? primary.data : null;
  }

  function resourceErrorText(error, fallback) {
    var code = error && error.code ? '[' + error.code + '] ' : '';
    return code + String(error && error.message ? error.message : (error || fallback || '资源请求失败'));
  }

  function readAllRuns() {
    var items = [];
    var seenCursors = Object.create(null);
    function read(cursor) {
      var query = { limit: 100 };
      if (cursor) query.cursor = cursor;
      return resourceClient.get('/runs', { query: query }).then(function (envelope) {
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

  function mergeRunDetails(runId, resources) {
    var index = lastRuns.findIndex(function (run) { return run.id === runId || run.runId === runId; });
    if (index < 0) return null;
    var merged = Object.assign({}, lastRuns[index]);
    resources.forEach(function (value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(merged, value);
    });
    merged._detailsLoaded = true;
    merged._detailsLoading = false;
    delete merged._detailsError;
    lastRuns[index] = normalizeRun(merged, index);
    return lastRuns[index];
  }

  function loadRunDetails(runId) {
    runId = String(runId || '');
    if (!runId) return Promise.reject(new Error('缺少运行 ID'));
    if (detailInFlight[runId]) return detailInFlight[runId];
    var uri = '/runs/' + resourceSegment(runId);
    var operation = Promise.all([
      resourceClient.get(uri),
      resourceClient.get(uri + '/report'),
      resourceClient.get(uri + '/debug-snapshot'),
    ]).then(function (envelopes) {
      return mergeRunDetails(runId, envelopes.map(resourceData));
    });
    detailInFlight[runId] = operation;
    operation.then(function () {
      if (detailInFlight[runId] === operation) delete detailInFlight[runId];
    }, function () {
      if (detailInFlight[runId] === operation) delete detailInFlight[runId];
    });
    return operation;
  }

  function renderLoadFailure(errorValue) {
    var list = $('#runs-list');
    var error = resourceErrorText(errorValue, '后台返回失败');
    if (list) {
      list.innerHTML = '<div class="placeholder report-load-error">加载运行历史失败: ' + esc(error) + '</div>';
    }
    toast('加载运行历史失败: ' + error, true);
  }

  function renderCurrentRuns() {
    var list = $('#runs-list');
    if (!list) return;
    var runs = lastRuns;
    if (!runs.length) {
      list.innerHTML = renderReportDashboard(runs) + '<div class="placeholder">暂无运行记录</div>';
      return;
    }
      var page = paginateConfigList(runs);
      var pager = renderConfigListPagination(page);
      list.innerHTML = renderReportDashboard(runs) + pager + page.items.map(function (run) {
        var expanded = !!expandedRunIds[run.id];
        var duration = run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) + 's' : '';
        var entry = runEntryDisplay(run);
        var triggerText = '入口：' + esc(entry.label) + (entry.detail ? ' · ' + esc(entry.detail) : '');
        var steps = collectRunSteps(run);
        var stats = stepStats(steps);
        var statsBadge = steps.length
          ? '<span class="run-steps-stat">' + stats.total + ' 节点 · ' + stats.passed + ' 通过' + (stats.failed ? ' / <b class="stat-failed">' + stats.failed + ' 失败</b>' : '') + (stats.skipped ? ' / ' + stats.skipped + ' 跳过' : '') + '</span>'
          : '';
        var body = '';
        if (expanded) {
          var canDelete = !isActiveRunHistoryStatus(run.status);
          if (run._detailsLoading) {
            body = '<div class="placeholder">正在读取运行详情、报告和调试快照…</div>';
          } else if (run._detailsError) {
            body = '<div class="placeholder report-load-error">加载运行详情失败: ' + esc(run._detailsError) + '</div>';
          } else {
            body = '<div class="run-actions">'
            + '<button class="btn-small" data-action="export-run-json" data-id="' + esc(run.id) + '">导出 JSON</button>'
            + '<button class="btn-small" data-action="export-run-html" data-id="' + esc(run.id) + '">导出 HTML 报告</button>'
            + '<button class="btn-small btn-danger-outline"' + (canDelete ? ' data-action="delete-run-history-entry" data-id="' + esc(run.id) + '"' : ' disabled title="活动中记录不能清理"') + '>清理本次记录</button>'
            + '</div>'
            + renderRunParentInfo(run)
            + renderRunIO(run)
            + renderRunTabUsage(run)
            + renderDataRows(run)
            + renderFlowGroupResults(run)
            + renderNodeStatsTable(steps)
            + renderFailureSamples(steps)
            + renderWarnErrorEvents(run)
            + (run.error ? '<p class="run-error">错误: ' + esc(run.error) + '</p>' : '');
          }
        }
        return '<div class="run-card">'
          + '<div class="run-card-header" data-action="toggle-run" data-id="' + esc(run.id) + '">'
          + '<span class="run-time">' + fmtTime(run.startedAt) + '</span>'
          + '<span class="run-flow">' + esc(run.flowLabel || run.flowId) + '</span>'
          + '<span class="run-trigger">' + triggerText + (duration ? ' · ' + duration : '') + '</span>'
          + statsBadge
          + '<span class="badge status-' + esc(run.status) + '">' + statusText(run.status) + '</span>'
          + '</div>'
          + '<div class="run-card-body' + (expanded ? '' : ' collapsed') + '">' + body + '</div>'
          + '</div>';
      }).join('') + pager;
  }

  function renderRuns(refreshOptions) {
    refreshOptions = refreshOptions || {};
    if (destroyed) return Promise.resolve({ ok: false, error: '报告控制器已销毁', destroyed: true });
    if (refreshInFlight && refreshOptions.force !== true) return refreshInFlight;

    var sequence = ++refreshSequence;
    var operation = readAllRuns().then(function (items) {
      if (destroyed || sequence !== refreshSequence) return { ok: false, stale: true };
      lastRuns = normalizeRunHistoryPayload(items);
      renderCurrentRuns();
      var expanded = lastRuns.filter(function (run) { return expandedRunIds[run.id]; });
      if (!expanded.length) return { ok: true, payload: lastRuns.slice() };
      expanded.forEach(function (run) { run._detailsLoading = true; });
      renderCurrentRuns();
      return Promise.all(expanded.map(function (run) {
        return loadRunDetails(run.id).catch(function (error) {
          run._detailsLoading = false;
          run._detailsError = resourceErrorText(error);
          return null;
        });
      })).then(function () {
        if (!destroyed && sequence === refreshSequence) renderCurrentRuns();
        return { ok: true, payload: lastRuns.slice() };
      });
    }).catch(function (err) {
      if (destroyed || sequence !== refreshSequence) return { ok: false, stale: true };
      var failure = { ok: false, error: resourceErrorText(err) };
      renderLoadFailure(err);
      return failure;
    });

    refreshInFlight = operation;
    operation.then(function () {
      if (refreshInFlight === operation) refreshInFlight = null;
    }, function () {
      if (refreshInFlight === operation) refreshInFlight = null;
    });
    return operation;
  }

  function toggleRun(runId) {
    runId = String(runId || '');
    var run = findRun(runId);
    if (!runId || !run) return Promise.resolve(false);
    if (expandedRunIds[runId]) {
      delete expandedRunIds[runId];
      renderCurrentRuns();
      return Promise.resolve(false);
    }
    expandedRunIds[runId] = true;
    if (run._detailsLoaded) {
      renderCurrentRuns();
      return Promise.resolve(true);
    }
    run._detailsLoading = true;
    delete run._detailsError;
    renderCurrentRuns();
    return loadRunDetails(runId).then(function () {
      if (!destroyed) renderCurrentRuns();
      return true;
    }).catch(function (error) {
      var current = findRun(runId);
      if (current) {
        current._detailsLoading = false;
        current._detailsError = resourceErrorText(error);
      }
      if (!destroyed) {
        renderCurrentRuns();
        toast('加载运行详情失败: ' + resourceErrorText(error), true);
      }
      return false;
    });
  }

  function formatPct(part, total) {
    return total ? Math.round(part / total * 1000) / 10 + '%' : '0%';
  }

  function toLocalDateInputValue(timestamp) {
    return dateKeyFromTs(Number(timestamp) || Date.now());
  }

  function formatDurationMs(ms) {
    if (ms === undefined || ms === null || ms === '') return '—';
    var n = Number(ms);
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
    return Math.floor(n / 60000) + 'm ' + Math.round((n % 60000) / 1000) + 's';
  }

  function compactErrorText(error) {
    var text = String(error || '').replace(/\s+/g, ' ').trim();
    if (!text) return '未知失败';
    return text.slice(0, 500);
  }

  function normalizeFailureReason(error) {
    var text = compactErrorText(error);
    var lower = text.toLowerCase();
    if (/timeout|timed out|超时|等待.*超/.test(lower)) return '等待/执行超时';
    if (/selector|元素不存在|未找到元素|not found|no such element|无法找到|不存在/.test(lower)) return '元素定位失败';
    if (/断言失败|assert|expected|预期|不匹配/.test(lower)) return '断言失败';
    if (/network|fetch|http|请求|接口|webhook|状态码|status\s*(code|[=: ]\s*[45]\d{2})/.test(lower)) return '网络/接口异常';
    if (/json|parse|解析|syntax/.test(lower)) return '数据解析失败';
    if (/stopped|停止|FLOW_STOPPED_BY_USER/i.test(text)) return '用户停止';
    if (/permission|denied|权限|授权|登录|login|session/.test(lower)) return '权限/登录状态异常';
    return text
      .replace(/runId=[A-Za-z0-9:_-]+/g, 'runId=*')
      .replace(/\b(sess|run|fg)_[A-Za-z0-9:_-]+/g, '$1_*')
      .replace(/\b\d{4}-\d{2}-\d{2}[T\s][^ ]+/g, '<time>')
      .slice(0, 120);
  }

  function getRunDurationMs(run) {
    return run && run.startedAt && run.endedAt ? run.endedAt - run.startedAt : null;
  }

  function dateKeyFromTs(ts) {
    if (!ts) return '未知日期';
    var d = new Date(ts);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function collectFailureRecords(runs) {
    var records = [];
    (runs || []).forEach(function (run) {
      if (!run) return;
      var runId = run.id || run.runId || '';
      if ((run.status === 'failed' || run.status === 'stopped') && run.error) {
        records.push({
          reason: normalizeFailureReason(run.error),
          error: compactErrorText(run.error),
          runId: runId,
          flowId: run.flowId || '',
          flowLabel: run.flowLabel || run.flowId || '',
          nodeId: '',
          nodeTitle: '(运行)',
          nodeType: 'run',
          startedAt: run.startedAt || 0,
        });
      }
      collectRunSteps(run, { includeFlowGroupChildren: false }).forEach(function (step) {
        if (normalizeStepStatus(step.status) !== 'failed') return;
        var error = step.error || run.error || '';
        records.push({
          reason: normalizeFailureReason(error),
          error: compactErrorText(error),
          runId: step.sourceRunId || runId,
          flowId: run.flowId || '',
          flowLabel: step.sourceFlowLabel || run.flowLabel || run.flowId || '',
          nodeId: step.nodeId || '',
          nodeTitle: step.title || step.nodeId || '',
          nodeType: step.type || '',
          flowGroupStep: step.flowGroupStep || '',
          startedAt: step.startedAt || run.startedAt || 0,
        });
      });
    });
    return records;
  }

  function buildFailureReasonGroups(runs) {
    var groups = Object.create(null);
    collectFailureRecords(runs).forEach(function (record) {
      var key = record.reason || '未知失败';
      if (!hasOwn(groups, key)) {
        groups[key] = {
          reason: key,
          count: 0,
          runs: Object.create(null),
          nodes: Object.create(null),
          latestAt: 0,
          sample: '',
        };
      }
      var group = groups[key];
      group.count++;
      if (record.runId) group.runs[record.runId] = true;
      if (record.nodeTitle || record.nodeId) group.nodes[record.nodeTitle || record.nodeId] = true;
      if ((record.startedAt || 0) > group.latestAt) group.latestAt = record.startedAt || 0;
      if (!group.sample && record.error) group.sample = record.error;
    });
    return Object.keys(groups).map(function (key) {
      var group = groups[key];
      group.runCount = Object.keys(group.runs).length;
      group.nodeCount = Object.keys(group.nodes).length;
      return group;
    }).sort(function (a, b) {
      return (b.count - a.count) || (b.latestAt - a.latestAt) || String(a.reason).localeCompare(String(b.reason));
    });
  }

  function buildHistoricalTrend(runs, maxBuckets) {
    var groups = Object.create(null);
    (runs || []).forEach(function (run) {
      var key = dateKeyFromTs(run.startedAt);
      if (!hasOwn(groups, key)) groups[key] = { key: key, total: 0, success: 0, failed: 0, stopped: 0, running: 0, durationSum: 0, durationCount: 0 };
      var group = groups[key];
      group.total++;
      if (run.status === 'idle') group.running++;
      else if (hasOwn(group, run.status)) group[run.status]++;
      var duration = getRunDurationMs(run);
      if (duration !== null) {
        group.durationSum += duration;
        group.durationCount++;
      }
    });
    return Object.keys(groups).sort().slice(-(maxBuckets || 14)).map(function (key) {
      var group = groups[key];
      group.avgDurationMs = group.durationCount ? Math.round(group.durationSum / group.durationCount) : null;
      group.passRate = group.total ? group.success / group.total : 0;
      return group;
    });
  }

  function buildFlakyAnalysis(runs) {
    var flows = Object.create(null);
    var nodes = Object.create(null);
    (runs || []).forEach(function (run) {
      if (!run || isActiveRunHistoryStatus(run.status)) return;
      var flowKey = run.flowId || run.flowLabel || '';
      if (flowKey) {
        if (!hasOwn(flows, flowKey)) flows[flowKey] = { kind: '流程', key: flowKey, label: run.flowLabel || flowKey, total: 0, passed: 0, failed: 0, stopped: 0, latestAt: 0, latestStatus: '' };
        var flow = flows[flowKey];
        flow.total++;
        if (run.status === 'success') flow.passed++;
        else if (run.status === 'failed') flow.failed++;
        else if (run.status === 'stopped') flow.stopped++;
        if ((run.startedAt || 0) > flow.latestAt) {
          flow.latestAt = run.startedAt || 0;
          flow.latestStatus = run.status || '';
        }
      }
      collectRunSteps(run, { includeFlowGroupChildren: false }).forEach(function (step) {
        var status = normalizeStepStatus(step.status);
        if (status !== 'passed' && status !== 'failed') return;
        var key = [run.flowId || step.sourceFlowLabel || '', step.nodeId || '', step.type || '', step.title || ''].join('\u0001');
        if (!hasOwn(nodes, key)) nodes[key] = { kind: '节点', key: key, label: step.title || step.nodeId || step.type || '', flowLabel: step.sourceFlowLabel || run.flowLabel || run.flowId || '', total: 0, passed: 0, failed: 0, stopped: 0, latestAt: 0, latestStatus: '' };
        var node = nodes[key];
        node.total++;
        if (status === 'passed') node.passed++;
        else node.failed++;
        if ((step.startedAt || run.startedAt || 0) > node.latestAt) {
          node.latestAt = step.startedAt || run.startedAt || 0;
          node.latestStatus = status;
        }
      });
    });

    return Object.keys(flows).map(function (key) { return flows[key]; })
      .concat(Object.keys(nodes).map(function (key) { return nodes[key]; }))
      .filter(function (item) { return item.passed > 0 && item.failed > 0; })
      .map(function (item) {
        item.failRate = item.total ? item.failed / item.total : 0;
        item.flakyScore = Math.min(item.passed, item.failed) / Math.max(1, item.total);
        return item;
      })
      .sort(function (a, b) {
        return (b.flakyScore - a.flakyScore) || (b.failed - a.failed) || (b.total - a.total) || String(a.label).localeCompare(String(b.label));
      });
  }

  function renderReportDashboard(runs) {
    runs = runs || [];
    var statusCount = { running: 0, success: 0, failed: 0, stopped: 0 };
    var stepTotal = 0;
    var stepPassed = 0;
    var dataRows = 0;
    var flowGroupRuns = 0;
    var durations = [];
    var failureGroups = buildFailureReasonGroups(runs);
    var flakyItems = buildFlakyAnalysis(runs);

    runs.forEach(function (run) {
      if (run.status === 'idle') statusCount.running++;
      else if (hasOwn(statusCount, run.status)) statusCount[run.status]++;
      if (run.kind === 'flowGroup' || Array.isArray(run.flowGroupResults)) flowGroupRuns++;
      if (run.startedAt && run.endedAt) durations.push(run.endedAt - run.startedAt);
      var stats = stepStats(collectRunSteps(run, { includeFlowGroupChildren: false }));
      stepTotal += stats.passed + stats.failed + stats.skipped;
      stepPassed += stats.passed;
      (run.summaries || []).forEach(function (summary) {
        if (Array.isArray(summary.dataRows)) dataRows += summary.dataRows.length;
      });
    });

    var avgMs = durations.length
      ? Math.round(durations.reduce(function (sum, ms) { return sum + ms; }, 0) / durations.length)
      : 0;
    var passRate = formatPct(statusCount.success, runs.length);
    var stepPassRate = formatPct(stepPassed, stepTotal);
    var avgDuration = avgMs ? Math.round(avgMs / 1000) + 's' : '—';
    var activeRuns = statusCount.running;
    var terminalRuns = runs.length - activeRuns;

    return '<div class="report-dashboard">'
      + '<div class="report-metric"><span>运行记录</span><b>' + runs.length + '</b><em>通过率 ' + passRate + '</em></div>'
      + '<div class="report-metric"><span>可清理</span><b>' + terminalRuns + '</b><em>活动记录保留</em></div>'
      + '<div class="report-metric metric-success"><span>成功</span><b>' + statusCount.success + '</b><em>失败 ' + statusCount.failed + '</em></div>'
      + '<div class="report-metric"><span>流程组</span><b>' + flowGroupRuns + '</b><em>运行中 ' + activeRuns + '</em></div>'
      + '<div class="report-metric"><span>流程节点</span><b>' + stepTotal + '</b><em>节点通过率 ' + stepPassRate + '</em></div>'
      + '<div class="report-metric"><span>数据驱动</span><b>' + dataRows + '</b><em>平均耗时 ' + avgDuration + '</em></div>'
      + '<div class="report-metric"><span>失败原因</span><b>' + failureGroups.length + '</b><em>失败样本 ' + collectFailureRecords(runs).length + '</em></div>'
      + '<div class="report-metric"><span>Flaky</span><b>' + flakyItems.length + '</b><em>流程/节点波动</em></div>'
      + '</div>'
      + renderReportCharts(runs, statusCount)
      + renderReportInsights(runs, failureGroups, flakyItems);
  }

  function renderReportCharts(runs, statusCount) {
    var chartSteps = [];
    runs.forEach(function (run) {
      chartSteps = chartSteps.concat(collectRunSteps(run, { includeFlowGroupChildren: false }));
    });
    return '<div class="report-charts">'
      + renderRunStatusDistributionChart(statusCount, runs.length)
      + renderRunTrendChart(runs)
      + renderHistoricalTrendChart(runs)
      + renderTopNodeChart(chartSteps)
      + '</div>';
  }

  function renderDistributionChart(title, items, total) {
    if (!total) {
      return '<div class="report-chart"><h3>' + esc(title) + '</h3><div class="chart-empty">暂无数据</div></div>';
    }
    var x = 0;
    var rects = items.map(function (item) {
      var w = item.count ? (item.count / total * 100) : 0;
      var rect = w ? '<rect x="' + x.toFixed(2) + '" y="2" width="' + w.toFixed(2) + '" height="12" rx="2" fill="' + item.color + '"></rect>' : '';
      x += w;
      return rect;
    }).join('');
    var legend = items.map(function (item) {
      return '<span><i style="background:' + item.color + '"></i>' + esc(item.label) + ' ' + item.count + '</span>';
    }).join('');
    return '<div class="report-chart"><h3>' + esc(title) + '</h3>'
      + '<svg viewBox="0 0 100 16" preserveAspectRatio="none" class="status-chart">' + rects + '</svg>'
      + '<div class="chart-legend">' + legend + '</div></div>';
  }

  function renderRunStatusDistributionChart(statusCount, total) {
    return renderDistributionChart('运行状态分布', [
      { label: '成功', count: statusCount.success || 0, color: CHART_COLORS.success },
      { label: '失败', count: statusCount.failed || 0, color: CHART_COLORS.failed },
      { label: '运行中', count: statusCount.running || 0, color: CHART_COLORS.running },
      { label: '已停止', count: statusCount.stopped || 0, color: CHART_COLORS.stopped },
    ], total);
  }

  function renderStepDistributionChart(stats) {
    return renderDistributionChart('节点状态分布', [
      { label: '通过', count: stats.passed || 0, color: CHART_COLORS.passed },
      { label: '失败', count: stats.failed || 0, color: CHART_COLORS.failed },
      { label: '跳过', count: stats.skipped || 0, color: CHART_COLORS.skipped },
    ], stats.total || 0);
  }

  function renderRunTrendChart(runs) {
    var recent = (runs || []).slice(0, 12).reverse();
    if (!recent.length) return '<div class="report-chart"><h3>最近运行趋势</h3><div class="chart-empty">暂无数据</div></div>';
    var width = 260;
    var height = 70;
    var pad = 10;
    var points = recent.map(function (run, i) {
      var x = recent.length === 1 ? width / 2 : pad + i * ((width - pad * 2) / (recent.length - 1));
      var y = run.status === 'success' ? 18 : ((run.status === 'running' || run.status === 'idle') ? 32 : (run.status === 'stopped' ? 46 : 56));
      return { x: x, y: y, status: run.status };
    });
    var line = points.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var dots = points.map(function (p) {
      var color = chartColor(p.status);
      return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3.5" fill="' + color + '"></circle>';
    }).join('');
    return '<div class="report-chart"><h3>最近运行趋势</h3>'
      + '<svg viewBox="0 0 ' + width + ' ' + height + '" class="trend-chart">'
      + '<line x1="' + pad + '" y1="18" x2="' + (width - pad) + '" y2="18"></line>'
      + '<line x1="' + pad + '" y1="56" x2="' + (width - pad) + '" y2="56"></line>'
      + '<polyline points="' + line + '"></polyline>' + dots + '</svg>'
      + '<div class="chart-caption">最近 ' + recent.length + ' 次运行</div></div>';
  }

  function renderHistoricalTrendChart(runs) {
    var buckets = buildHistoricalTrend(runs, 14);
    if (!buckets.length) return '<div class="report-chart"><h3>历史趋势</h3><div class="chart-empty">暂无数据</div></div>';
    var maxTotal = buckets.reduce(function (m, item) { return Math.max(m, item.total); }, 0) || 1;
    var rows = buckets.map(function (item) {
      var successW = item.total ? (item.success / item.total * 100) : 0;
      var failedW = item.total ? (item.failed / item.total * 100) : 0;
      var stoppedW = item.total ? (item.stopped / item.total * 100) : 0;
      var totalW = Math.max(6, Math.round(item.total / maxTotal * 100));
      var label = item.key === '未知日期' ? item.key : item.key.slice(5);
      return '<div class="history-trend-row">'
        + '<span>' + esc(label) + '</span>'
        + '<div class="history-trend-track" title="运行 ' + item.total + ' 次，通过率 ' + formatPct(item.success, item.total) + '" style="width:' + totalW + '%">'
        + (successW ? '<i class="trend-success" style="width:' + successW.toFixed(1) + '%"></i>' : '')
        + (failedW ? '<i class="trend-failed" style="width:' + failedW.toFixed(1) + '%"></i>' : '')
        + (stoppedW ? '<i class="trend-stopped" style="width:' + stoppedW.toFixed(1) + '%"></i>' : '')
        + '</div>'
        + '<em>' + item.total + ' 次 · ' + formatPct(item.success, item.total) + ' · ' + formatDurationMs(item.avgDurationMs) + '</em>'
        + '</div>';
    }).join('');
    return '<div class="report-chart report-chart-wide"><h3>历史趋势</h3>'
      + rows
      + '<div class="chart-legend"><span><i style="background:' + CHART_COLORS.success + '"></i>成功</span><span><i style="background:' + CHART_COLORS.failed + '"></i>失败</span><span><i style="background:' + CHART_COLORS.stopped + '"></i>停止</span></div>'
      + '</div>';
  }

  function renderTopNodeChart(steps) {
    var top = buildNodeStats(steps).filter(function (item) {
      return item.failed || item.durationCount;
    }).sort(function (a, b) {
      return (b.failed - a.failed) || ((b.avg || 0) - (a.avg || 0)) || (b.sum - a.sum);
    }).slice(0, 5);
    if (!top.length) return '<div class="report-chart"><h3>Top 慢/失败节点</h3><div class="chart-empty">暂无数据</div></div>';
    var max = top.reduce(function (m, item) {
      var value = item.failed ? item.failed : (item.avg || item.sum || 0);
      return Math.max(m, value);
    }, 0) || 1;
    var rows = top.map(function (item) {
      var value = item.failed ? item.failed : (item.avg || item.sum || 0);
      var label = item.failed ? (item.failed + ' 失败') : (formatDurationMs(item.avg) + ' avg');
      var width = Math.max(4, Math.round(value / max * 100));
      return '<div class="chart-bar-row"><span title="' + esc(item.title || item.nodeId) + '">' + esc(item.title || item.nodeId || item.type) + '</span>'
        + '<div class="chart-bar-track"><i style="width:' + width + '%"></i></div><em>' + esc(label) + '</em></div>';
    }).join('');
    return '<div class="report-chart"><h3>Top 慢/失败节点</h3>' + rows + '</div>';
  }

  function renderReportInsights(runs, failureGroups, flakyItems) {
    if (!runs.length) return '';
    return '<div class="report-insights">'
      + renderFailureReasonAggregation(failureGroups)
      + renderFlakyAnalysis(flakyItems)
      + '</div>';
  }

  function renderFailureReasonAggregation(groups) {
    groups = groups || [];
    if (!groups.length) {
      return '<div class="report-insight"><h3>失败原因聚合</h3><div class="chart-empty">暂无失败样本</div></div>';
    }
    var rows = groups.slice(0, 8).map(function (item) {
      return '<tr>'
        + '<td><b>' + esc(item.reason) + '</b><div class="error-preview">' + esc(item.sample) + '</div></td>'
        + '<td>' + item.count + '</td>'
        + '<td>' + item.runCount + '</td>'
        + '<td>' + item.nodeCount + '</td>'
        + '<td>' + fmtTime(item.latestAt) + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="report-insight"><h3>失败原因聚合</h3>'
      + '<div class="report-table-scroll"><table class="steps-table failure-reason-table"><thead><tr><th>原因 / 样本</th><th>次数</th><th>运行</th><th>节点</th><th>最近出现</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '</div>';
  }

  function renderFlakyAnalysis(items) {
    items = items || [];
    if (!items.length) {
      return '<div class="report-insight"><h3>Flaky 分析</h3><div class="chart-empty">暂无同时成功和失败的流程/节点</div></div>';
    }
    var rows = items.slice(0, 8).map(function (item) {
      var name = item.kind === '节点'
        ? esc(item.label) + '<div class="muted">' + esc(item.flowLabel || '') + '</div>'
        : esc(item.label);
      return '<tr>'
        + '<td><span class="badge">' + esc(item.kind) + '</span> ' + name + '</td>'
        + '<td>' + item.total + '</td>'
        + '<td>' + item.passed + '</td>'
        + '<td class="' + (item.failed ? 'stat-failed' : '') + '">' + item.failed + '</td>'
        + '<td>' + formatPct(item.failed, item.total) + '</td>'
        + '<td>' + statusText(item.latestStatus) + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="report-insight"><h3>Flaky 分析</h3>'
      + '<div class="report-table-scroll"><table class="steps-table flaky-table"><thead><tr><th>对象</th><th>运行/样本</th><th>成功</th><th>失败</th><th>失败率</th><th>最近状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '</div>';
  }

  function findRun(runId) {
    return lastRuns.find(function (r) { return r.id === runId || r.runId === runId; }) || null;
  }

  function normalizeStepStatus(status) {
    if (status === 'passed' || status === 'success' || status === 'completed' || status === 'manual_completed') return 'passed';
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'skipped' || status === 'stopped') return 'skipped';
    return 'skipped';
  }

  function cloneReportStep(step, source) {
    var item = Object.assign({}, step || {});
    item.nodeId = item.nodeId || item.stepId || item.flowId || '';
    item.title = item.title || item.flowLabel || item.nodeId || item.flowId || '';
    item.type = item.type || 'unknown';
    item.status = normalizeStepStatus(item.status);
    if (source) {
      if (source.sourceRunId && !item.sourceRunId) item.sourceRunId = source.sourceRunId;
      if (source.sourceFlowLabel && !item.sourceFlowLabel) item.sourceFlowLabel = source.sourceFlowLabel;
      if (source.flowGroupStep && !item.flowGroupStep) item.flowGroupStep = source.flowGroupStep;
      if (source.summaryRun !== undefined && item.summaryRun === undefined) item.summaryRun = source.summaryRun;
      if (source.summaryAttempt !== undefined && item.summaryAttempt === undefined) item.summaryAttempt = source.summaryAttempt;
    }
    return item;
  }

  function flowGroupResultToStep(result, index, childRun) {
    var status = result.status === 'success' ? 'passed' : (result.status === 'stopped' ? 'skipped' : 'failed');
    var durationMs = childRun && childRun.startedAt && childRun.endedAt ? (childRun.endedAt - childRun.startedAt) : Number(result.durationMs);
    var error = result.error || (result.output && result.output.error) || '';
    return cloneReportStep({
      nodeId: result.stepId || result.flowId || result.runId || ('flowGroupStep-' + (index + 1)),
      title: result.flowLabel || result.flowId || ('流程组步骤 ' + (index + 1)),
      type: 'flowGroupStep',
      status: status,
      durationMs: isFinite(durationMs) ? durationMs : undefined,
      attempts: 1,
      error: error,
    }, {
      sourceRunId: result.runId || '',
      sourceFlowLabel: result.flowLabel || result.flowId || '',
      flowGroupStep: result.flowLabel || result.flowId || '',
    });
  }

  function collectRunStateSteps(run) {
    var statuses = run && run.nodeStatuses && typeof run.nodeStatuses === 'object' && !Array.isArray(run.nodeStatuses)
      ? run.nodeStatuses
      : {};
    var nodes = run && Array.isArray(run.nodes) ? run.nodes : [];
    var seen = Object.create(null);
    var source = {
      sourceRunId: run && (run.id || run.runId) || '',
      sourceFlowLabel: run && (run.flowLabel || run.flowId) || '',
    };
    var steps = nodes.map(function (node) {
      var value = node && typeof node === 'object' && !Array.isArray(node) ? node : {};
      var nodeId = String(value.nodeId || value.id || node || '');
      if (!nodeId || seen[nodeId]) return null;
      seen[nodeId] = true;
      return cloneReportStep({
        nodeId: nodeId,
        title: value.title || value.label || nodeId,
        type: value.type || 'unknown',
        status: statuses[nodeId],
      }, source);
    }).filter(Boolean);
    Object.keys(statuses).forEach(function (nodeId) {
      if (!nodeId || seen[nodeId]) return;
      steps.push(cloneReportStep({
        nodeId: nodeId,
        title: nodeId,
        type: 'unknown',
        status: statuses[nodeId],
      }, source));
    });
    return steps;
  }

  function collectRunSteps(run, options) {
    options = options || {};
    var includeFlowGroupChildren = options.includeFlowGroupChildren !== false;
    var visited = options.visited || Object.create(null);
    if (!run) return [];
    var runKey = run.id || run.runId || '';
    if (runKey && visited[runKey]) return [];
    if (runKey) visited[runKey] = true;
    var steps = [];
    (run.summaries || []).forEach(function (s) {
      if (!Array.isArray(s.steps)) return;
      var source = {
        sourceRunId: run.id || run.runId || '',
        sourceFlowLabel: run.flowLabel || run.flowId || '',
        summaryRun: s.run,
        summaryAttempt: s.attempt,
      };
      steps = steps.concat(s.steps.map(function (step) { return cloneReportStep(step, source); }));
    });
    (run.flowGroupResults || []).forEach(function (result, index) {
      var childRun = result.runId ? findRun(result.runId) : null;
      var childSteps = [];
      if (includeFlowGroupChildren && childRun && childRun !== run) {
        childSteps = collectRunSteps(childRun, { includeFlowGroupChildren: true, visited: visited }).map(function (step) {
          return cloneReportStep(step, {
            flowGroupStep: result.flowLabel || result.flowId || '',
            sourceRunId: step.sourceRunId || result.runId || '',
            sourceFlowLabel: step.sourceFlowLabel || result.flowLabel || result.flowId || '',
          });
        });
      }
      if (childSteps.length) steps = steps.concat(childSteps);
      else steps.push(flowGroupResultToStep(result, index, childRun));
    });
    if (!steps.length) steps = collectRunStateSteps(run);
    return steps;
  }

  function stepStats(steps) {
    var stats = { total: 0, passed: 0, failed: 0, skipped: 0 };
    steps.forEach(function (s) {
      var status = normalizeStepStatus(s.status);
      stats.total++;
      if (hasOwn(stats, status)) stats[status]++;
      else stats.skipped++;
    });
    return stats;
  }

  function stepTypeLabel(type) {
    if (type === 'flowGroupStep') return '流程组步骤';
    return NodeTypes.getTypeLabel(type);
  }

  function safeJsonPreview(value, maxLen) {
    var text;
    try {
      text = JSON.stringify(value === undefined ? null : value, null, 2);
    } catch (_) {
      text = String(value === undefined || value === null ? '' : value);
    }
    if (maxLen && text.length > maxLen) return text.slice(0, maxLen) + '\n... 已截断 ' + (text.length - maxLen) + ' 字符';
    return text;
  }

  function hasReportField(value, key) {
    return !!(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
  }

  function renderRunIO(run, options) {
    options = options || {};
    var hasInput = hasReportField(run, 'input');
    var hasOutput = hasReportField(run, 'output') || hasReportField(run, 'result');
    if (!hasInput && !hasOutput) return '';
    var maxLen = options.fullOutput ? 0 : 8000;
    var openAttr = options.openDetails ? ' open' : '';
    var output = hasReportField(run, 'output') ? run.output : run.result;
    return '<h3 class="run-section-title">流程输入 / 输出</h3>'
      + '<div class="report-io-grid">'
      + (hasInput
        ? '<details class="output-details"' + openAttr + '><summary>输入</summary><pre class="output-preview">' + esc(safeJsonPreview(run.input, maxLen)) + '</pre></details>'
        : '')
      + (hasOutput
        ? '<details class="output-details"' + openAttr + '><summary>输出</summary><pre class="output-preview">' + esc(safeJsonPreview(output, maxLen)) + '</pre></details>'
        : '')
      + '</div>';
  }

  function renderDataRows(run) {
    var html = '';
    (run.summaries || []).forEach(function (s) {
      if (!Array.isArray(s.dataRows) || !s.dataRows.length) return;
      html += '<div class="data-rows"><span class="data-rows-label">数据驱动</span>' + s.dataRows.map(function (r, index) {
        r = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
        var rawIndex = Number(r && r.index);
        var displayIndex = isFinite(rawIndex) && rawIndex >= 0 ? Math.floor(rawIndex) + 1 : index + 1;
        return '<span class="badge ' + (r.status === 'success' ? 'on' : 'status-failed') + '" title="' + esc(r.error || '') + '">第' + displayIndex + '组 ' + (r.status === 'success' ? '通过' : '失败') + '</span>';
      }).join(' ') + '</div>';
    });
    return html;
  }

  function renderRunParentInfo(run) {
    if (!run || !run.parentFlowGroupId) return '';
    var parts = [];
    parts.push('父流程组: ' + (run.parentFlowGroupLabel || run.parentFlowGroupId));
    if (run.parentRunId) parts.push('流程组运行: ' + run.parentRunId);
    if (run.parentStepLabel) parts.push('步骤: ' + run.parentStepLabel);
    else if (run.parentStepIndex !== undefined && run.parentStepIndex !== null) parts.push('步骤: #' + (Number(run.parentStepIndex) + 1));
    return '<div class="run-parent-info muted">' + esc(parts.join(' · ')) + '</div>';
  }

  function renderFlowGroupResults(run, options) {
    options = options || {};
    if (!Array.isArray(run.flowGroupResults) || !run.flowGroupResults.length) return '';
    var maxLen = options.fullOutput ? 0 : 8000;
    var openAttr = options.openDetails ? ' open' : '';
    return '<h3 class="run-section-title">流程组结果</h3>'
      + '<div class="report-table-scroll"><table class="steps-table flow-group-table"><thead><tr><th>#</th><th>流程</th><th>运行 ID</th><th>结果</th><th>输入 / 输出</th></tr></thead><tbody>'
      + run.flowGroupResults.map(function (r, i) {
        var ok = r.status === 'success';
        var output = safeJsonPreview(r.output === undefined ? null : r.output, maxLen);
        var input = r.input === undefined ? '' : safeJsonPreview(r.input, maxLen);
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.flowLabel || r.flowId) + '</td>'
          + '<td>' + esc(r.runId || '') + '</td>'
          + '<td><span class="badge ' + (ok ? 'step-passed' : 'step-failed') + '">' + (ok ? '通过' : esc(r.status)) + '</span></td>'
          + '<td>'
          + (input ? '<details class="output-details"' + openAttr + '><summary>输入</summary><pre class="output-preview">' + esc(input) + '</pre></details>' : '')
          + '<details class="output-details"' + openAttr + '><summary>输出</summary><pre class="output-preview">' + esc(output) + '</pre></details>'
          + '</td></tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  function renderRunTabUsage(run) {
    var usage = run && run.tabUsage ? run.tabUsage : {};
    var keys = Object.keys(usage);
    if (!keys.length) return '';
    var rows = keys.map(function (key) {
      var item = usage[key] || {};
      return '<tr>'
        + '<td>' + esc(item.pageId || item.source || key) + '</td>'
        + '<td>' + esc(item.mode || run.runTabMode || '') + '</td>'
        + '<td>' + esc(item.tabId || '') + '</td>'
        + '<td>' + esc(item.windowId || '') + '</td>'
        + '<td>' + esc(item.host || '') + '</td>'
        + '<td>' + (item.reused ? '是' : '否') + '</td>'
        + '<td><div class="muted">' + esc(item.url || '') + '</div></td>'
        + '</tr>';
    }).join('');
    return '<h3 class="run-section-title">标签页使用</h3>'
      + '<div class="report-table-scroll"><table class="steps-table tab-usage-table"><thead><tr><th>页面</th><th>策略</th><th>Tab</th><th>窗口</th><th>Host</th><th>复用</th><th>URL</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function buildNodeStats(steps) {
    var groups = Object.create(null);
    steps.forEach(function (step) {
      var status = normalizeStepStatus(step.status);
      var key = [step.nodeId || '', step.type || '', step.title || ''].join('\u0001');
      if (!hasOwn(groups, key)) {
        groups[key] = {
          nodeId: step.nodeId || '',
          type: step.type || '',
          title: step.title || step.nodeId || '',
          count: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          min: null,
          max: null,
          avg: null,
          sum: 0,
          durationCount: 0,
          attempts: 0,
          firstError: '',
          lastError: '',
        };
      }
      var group = groups[key];
      group.count++;
      if (hasOwn(group, status)) group[status]++;
      else group.skipped++;
      var duration = Number(step.durationMs);
      if (isFinite(duration) && duration >= 0) {
        group.durationCount++;
        group.sum += duration;
        group.min = group.min === null ? duration : Math.min(group.min, duration);
        group.max = group.max === null ? duration : Math.max(group.max, duration);
        group.avg = group.sum / group.durationCount;
      }
      var attempts = Number(step.attempts);
      group.attempts += attempts > 0 ? attempts : (status === 'skipped' ? 0 : 1);
      if (step.error) {
        if (!group.firstError) group.firstError = String(step.error);
        group.lastError = String(step.error);
      }
    });
    return Object.keys(groups).map(function (key) { return groups[key]; });
  }

  function renderNodeStatsTable(steps) {
    var stats = buildNodeStats(steps).sort(function (a, b) {
      return (b.failed - a.failed) || (b.sum - a.sum) || (b.count - a.count) || String(a.title).localeCompare(String(b.title));
    });
    if (!stats.length) return '<h3 class="run-section-title">节点统计</h3><div class="placeholder">暂无节点统计</div>';
    var rows = stats.map(function (item) {
      return '<tr>'
        + '<td><b>' + esc(item.title || item.nodeId || item.type) + '</b><span class="muted"> ' + esc(item.nodeId) + '</span></td>'
        + '<td>' + esc(stepTypeLabel(item.type)) + '</td>'
        + '<td>' + item.count + '</td>'
        + '<td>' + item.passed + '</td>'
        + '<td class="' + (item.failed ? 'stat-failed' : '') + '">' + item.failed + '</td>'
        + '<td>' + item.skipped + '</td>'
        + '<td>' + formatDurationMs(item.min) + '</td>'
        + '<td>' + formatDurationMs(item.max) + '</td>'
        + '<td>' + formatDurationMs(item.avg) + '</td>'
        + '<td>' + (item.durationCount ? formatDurationMs(item.sum) : '—') + '</td>'
        + '<td>' + item.attempts + '</td>'
        + '<td><div class="error-preview">' + esc(item.firstError) + '</div></td>'
        + '<td><div class="error-preview">' + esc(item.lastError) + '</div></td>'
        + '</tr>';
    }).join('');
    return '<h3 class="run-section-title">节点统计</h3>'
      + '<div class="report-table-scroll"><table class="steps-table node-stats-table"><thead><tr>'
      + '<th>节点</th><th>类型</th><th>count</th><th>passed</th><th>failed</th><th>skipped</th><th>min</th><th>max</th><th>avg</th><th>sum duration</th><th>attempts</th><th>firstError</th><th>lastError</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderFailureSamples(steps) {
    var samples = steps.filter(function (s) {
      return normalizeStepStatus(s.status) === 'failed';
    }).slice(0, 5);
    if (!samples.length) return '';
    var rows = samples.map(function (s, i) {
      var shot = s.screenshotOmitted
        ? '<div class="muted">截图已省略（约 ' + Math.round(Number(s.screenshotBytes || 0) / 1024) + ' KB，未写入流程报告存储）</div>'
        : '';
      var rawDataIndex = Number(s.dataIndex);
      var dataIndex = s.dataIndex !== undefined && isFinite(rawDataIndex) && rawDataIndex >= 0
        ? '<span class="muted"> 数据' + (Math.floor(rawDataIndex) + 1) + '</span>'
        : '';
      return '<tr>'
        + '<td>' + (i + 1) + dataIndex + '</td>'
        + '<td>' + esc(s.title || s.nodeId) + '<span class="muted"> ' + esc(stepTypeLabel(s.type)) + (s.flowGroupStep ? ' · ' + esc(s.flowGroupStep) : '') + '</span></td>'
        + '<td>' + formatDurationMs(s.durationMs) + (Number(s.attempts) > 1 ? ' <span class="muted">×' + s.attempts + '</span>' : '') + '</td>'
        + '<td>' + (s.error ? '<div class="step-error">' + esc(s.error) + '</div>' : '') + shot + '</td>'
        + '</tr>';
    }).join('');
    return '<h3 class="run-section-title">失败样本</h3>'
      + '<div class="report-table-scroll"><table class="steps-table failure-samples-table"><thead><tr><th>#</th><th>节点</th><th>耗时</th><th>错误</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function warnErrorLogs(run) {
    return (run.logs || []).filter(function (entry) {
      return entry && (entry.level === 'warn' || entry.level === 'error');
    });
  }

  function renderWarnErrorEvents(run) {
    var logs = warnErrorLogs(run);
    return '<h3 class="run-section-title">warn/error 事件</h3><div class="run-log">'
      + (logs.length ? logs.map(function (entry) {
        var cls = entry.level === 'error' ? 'log-error' : 'log-warn';
        var node = entry.nodeId ? '<span class="log-node">' + esc(entry.nodeId) + '</span>' : '';
        return '<div class="log-entry ' + cls + '"><span class="log-time">' + formatLogTime(entry.timestamp) + '</span>' + node + esc(entry.message) + '</div>';
      }).join('') : '<div class="log-entry">无警告/错误</div>')
      + '</div>';
  }

  // --- 报告导出 ---

  function downloadFile(filename, content, mime) {
    if (typeof download === 'function') {
      download({ filename: filename, content: content, mime: mime || 'application/octet-stream' });
      return;
    }
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    (timerHost.setTimeout || setTimeout)(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportRunJson(runId) {
    var run = findRun(runId);
    if (!run) return;
    downloadFile('flow-report-' + runId + '.json', JSON.stringify(run, null, 2), 'application/json');
  }

  function exportAllRunsJson() {
    if (!lastRuns.length) {
      toast('暂无运行历史可导出', true);
      return;
    }
    downloadFile('flow-report-runs-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(lastRuns, null, 2), 'application/json');
  }

  function csvCell(value) {
    var text = value === undefined || value === null ? '' : String(value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function csvTimestamp(value) {
    if (value === undefined || value === null || value === '' || value === 0) return '';
    var date = new Date(value);
    return isFinite(date.getTime()) ? date.toISOString() : String(value);
  }

  function buildFailuresCsv(runs) {
    var rows = collectFailureRecords(runs);
    var header = ['reason', 'time', 'runId', 'flowId', 'flowLabel', 'nodeId', 'nodeTitle', 'nodeType', 'flowGroupStep', 'error'];
    var lines = [header.map(csvCell).join(',')];
    rows.forEach(function (row) {
      lines.push([
        row.reason,
        csvTimestamp(row.startedAt),
        row.runId,
        row.flowId,
        row.flowLabel,
        row.nodeId,
        row.nodeTitle,
        row.nodeType,
        row.flowGroupStep || '',
        row.error,
      ].map(csvCell).join(','));
    });
    return '\ufeff' + lines.join('\n');
  }

  function exportFailuresCsv() {
    if (!lastRuns.length) {
      toast('暂无运行历史可导出', true);
      return;
    }
    var records = collectFailureRecords(lastRuns);
    if (!records.length) {
      toast('暂无失败样本可导出', true);
      return;
    }
    downloadFile('flow-report-failures-' + new Date().toISOString().slice(0, 10) + '.csv', buildFailuresCsv(lastRuns), 'text/csv;charset=utf-8');
  }

  function buildHtmlReport(run) {
    var steps = collectRunSteps(run);
    var stats = stepStats(steps);
    var duration = run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) + 's' : '—';
    var statusCount = { running: 0, success: 0, failed: 0, stopped: 0 };
    if (run.status === 'idle') statusCount.running = 1;
    else if (hasOwn(statusCount, run.status)) statusCount[run.status] = 1;

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>流程报告 - ' + esc(run.flowLabel || run.flowId) + '</title>'
      + '<style>'
      + 'body{font-family:Roboto,system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#262626;background:#f9fafb;}'
      + 'h1{font-size:20px;color:#004849;} h3{font-size:14px;color:#004849;margin:18px 0 8px;} .cards{display:flex;gap:12px;margin:16px 0;flex-wrap:wrap;}'
      + '.card{background:#fff;border:1px solid #d0dbe0;border-radius:3px;padding:12px 20px;text-align:center;min-width:90px;}'
      + '.card b{display:block;font-size:22px;} .c-pass b{color:#1a9964;} .c-fail b{color:#ba554a;} .c-skip b{color:#728e9b;}'
      + '.report-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:16px 0;}'
      + '.report-chart{background:#fff;border:1px solid #d0dbe0;border-radius:3px;padding:10px 12px;} .report-chart h3{margin:0 0 8px;font-size:13px;}'
      + '.status-chart{width:100%;height:22px;background:#eef3f5;border-radius:3px;} .trend-chart{width:100%;height:80px;} .trend-chart line{stroke:#d0dbe0;stroke-dasharray:3 3}.trend-chart polyline{fill:none;stroke:#004849;stroke-width:2;}'
      + '.chart-legend{display:flex;gap:8px;flex-wrap:wrap;color:#728e9b;font-size:12px}.chart-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}.chart-caption,.chart-empty{color:#728e9b;font-size:12px}.chart-bar-row{display:grid;grid-template-columns:minmax(80px,1fr) 1.2fr auto;gap:8px;align-items:center;font-size:12px;margin:6px 0}.chart-bar-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chart-bar-track{height:8px;background:#eef3f5;border-radius:3px;overflow:hidden}.chart-bar-track i{display:block;height:100%;background:#ba554a}.chart-bar-row em{font-style:normal;color:#728e9b;}'
      + '.report-chart-wide{grid-column:1/-1}.history-trend-row{display:grid;grid-template-columns:48px minmax(80px,1fr) auto;gap:8px;align-items:center;font-size:12px;margin:6px 0}.history-trend-track{display:flex;height:10px;min-width:6px;background:#eef3f5;border-radius:3px;overflow:hidden}.history-trend-track i{display:block;height:100%}.trend-success{background:#1a9964}.trend-failed{background:#ba554a}.trend-stopped{background:#9b6a6c}.history-trend-row em{font-style:normal;color:#728e9b;white-space:nowrap}.report-insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;margin:14px 0}.report-insight{border:1px solid #d0dbe0;background:#fff;padding:10px 12px}.report-insight h3{margin:0 0 8px;font-size:13px;color:#004849}'
      + '.report-table-scroll{overflow-x:auto;} table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;}'
      + 'th,td{border:1px solid #d0dbe0;padding:6px 10px;text-align:left;vertical-align:top;}'
      + 'th{background:#aabbc3;color:#004849;} tr:nth-child(even) td{background:#f9fafb;} .muted,.meta{color:#728e9b;font-size:12px;} .stat-failed{color:#ba554a;font-weight:600}.error-preview,.step-error{white-space:pre-wrap;word-break:break-word;max-width:360px;color:#ba554a}.step-shot{max-width:480px;border:1px solid #d0dbe0;margin-top:6px}.report-io-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-bottom:12px}.output-preview{white-space:pre-wrap;word-break:break-word;max-height:520px;overflow:auto;background:#f3f6f7;border:1px solid #d0dbe0;padding:8px}.run-log{background:#f3f6f7;border:1px solid #d0dbe0;padding:8px;font-family:monospace;font-size:12px}.log-entry{padding:2px 0}.log-time,.log-node{color:#728e9b;margin-right:8px}.log-error{color:#ba554a}.log-warn{color:#9a6a18}.badge{display:inline-block;border:1px solid #d0dbe0;border-radius:3px;padding:1px 6px}.step-passed{background:#1a9964;color:#fff}.step-failed{background:#ba554a;color:#fff}.status-failed{background:#ba554a;color:#fff}.on{background:#1a9964;color:#fff}'
      + '</style></head><body>'
      + '<h1>流程报告 — ' + esc(run.flowLabel || run.flowId) + '</h1>'
      + '<p class="meta">开始: ' + fmtTime(run.startedAt) + ' · 耗时: ' + duration + ' · 触发: ' + esc(run.trigger) + ' · 结果: <b>' + statusText(run.status) + '</b></p>'
      + renderRunParentInfo(run)
      + '<div class="cards">'
      + '<div class="card"><b>' + stats.total + '</b>流程节点</div>'
      + '<div class="card c-pass"><b>' + stats.passed + '</b>通过</div>'
      + '<div class="card c-fail"><b>' + stats.failed + '</b>失败</div>'
      + '<div class="card c-skip"><b>' + stats.skipped + '</b>跳过</div>'
      + '</div>'
      + '<div class="report-charts">' + renderRunStatusDistributionChart(statusCount, 1) + renderRunTrendChart(lastRuns.length ? lastRuns : [run]) + renderHistoricalTrendChart(lastRuns.length ? lastRuns : [run]) + renderTopNodeChart(steps) + renderStepDistributionChart(stats) + '</div>'
      + renderReportInsights([run], buildFailureReasonGroups([run]), buildFlakyAnalysis(lastRuns.length ? lastRuns : [run]))
      + renderRunIO(run, { fullOutput: true, openDetails: true })
      + renderRunTabUsage(run)
      + renderDataRows(run)
      + renderFlowGroupResults(run, { fullOutput: true, openDetails: true })
      + renderNodeStatsTable(steps)
      + renderFailureSamples(steps)
      + renderWarnErrorEvents(run)
      + '<p class="meta">Generated by Page Agent · ' + new Date().toLocaleString() + '</p>'
      + '</body></html>';
  }

  function exportRunHtml(runId) {
    var run = findRun(runId);
    if (!run) return;
    downloadFile('flow-report-' + runId + '.html', buildHtmlReport(run), 'text/html');
  }

  function buildBatchHtmlReport(runs) {
    runs = (runs || []).slice();
    var sections = runs.map(function (run, index) {
      var steps = collectRunSteps(run);
      var stats = stepStats(steps);
      var duration = getRunDurationMs(run);
      return '<section class="batch-run">'
        + '<h2>' + (index + 1) + '. ' + esc(run.flowLabel || run.flowId) + '</h2>'
        + '<p class="meta">开始: ' + fmtTime(run.startedAt) + ' · 耗时: ' + formatDurationMs(duration) + ' · 触发: ' + esc(run.trigger) + ' · 结果: <b>' + statusText(run.status) + '</b></p>'
        + '<div class="cards">'
        + '<div class="card"><b>' + stats.total + '</b>流程节点</div>'
        + '<div class="card c-pass"><b>' + stats.passed + '</b>通过</div>'
        + '<div class="card c-fail"><b>' + stats.failed + '</b>失败</div>'
        + '<div class="card c-skip"><b>' + stats.skipped + '</b>跳过</div>'
        + '</div>'
        + renderRunIO(run, { fullOutput: true, openDetails: false })
        + renderDataRows(run)
        + renderFlowGroupResults(run, { fullOutput: true, openDetails: false })
        + renderNodeStatsTable(steps)
        + renderFailureSamples(steps)
        + renderWarnErrorEvents(run)
        + '</section>';
    }).join('');

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>批量流程报告</title>'
      + '<style>'
      + 'body{font-family:Roboto,system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#262626;background:#f9fafb;}'
      + 'h1{font-size:22px;color:#004849;} h2{font-size:17px;color:#004849;margin:0 0 8px;} h3{font-size:14px;color:#004849;margin:18px 0 8px;} .batch-run{margin:18px 0 24px;padding-top:18px;border-top:2px solid #d0dbe0}.cards{display:flex;gap:12px;margin:16px 0;flex-wrap:wrap;}'
      + '.card,.report-metric,.report-chart,.report-insight{background:#fff;border:1px solid #d0dbe0;border-radius:3px;padding:10px 12px}.card{text-align:center;min-width:90px}.card b,.report-metric b{display:block;font-size:22px}.c-pass b{color:#1a9964}.c-fail b{color:#ba554a}.c-skip b{color:#728e9b}.report-dashboard{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.report-metric span,.report-metric em{display:block;color:#728e9b;font-size:12px;font-style:normal}.report-metric b{color:#004849;margin:4px 0}.metric-success b{color:#1a9964}.report-charts,.report-insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:14px 0}.report-chart-wide{grid-column:1/-1}.report-chart h3,.report-insight h3{margin:0 0 8px;font-size:13px}.status-chart{width:100%;height:22px;background:#eef3f5;border-radius:3px}.trend-chart{width:100%;height:80px}.trend-chart line{stroke:#d0dbe0;stroke-dasharray:3 3}.trend-chart polyline{fill:none;stroke:#004849;stroke-width:2}.chart-legend{display:flex;gap:8px;flex-wrap:wrap;color:#728e9b;font-size:12px}.chart-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}.chart-caption,.chart-empty{color:#728e9b;font-size:12px}.chart-bar-row{display:grid;grid-template-columns:minmax(80px,1fr) 1.2fr auto;gap:8px;align-items:center;font-size:12px;margin:6px 0}.chart-bar-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chart-bar-track,.history-trend-track{height:8px;background:#eef3f5;border-radius:3px;overflow:hidden}.chart-bar-track i{display:block;height:100%;background:#ba554a}.chart-bar-row em,.history-trend-row em{font-style:normal;color:#728e9b}.history-trend-row{display:grid;grid-template-columns:48px minmax(80px,1fr) auto;gap:8px;align-items:center;font-size:12px;margin:6px 0}.history-trend-track{display:flex;height:10px}.history-trend-track i{display:block;height:100%}.trend-success{background:#1a9964}.trend-failed{background:#ba554a}.trend-stopped{background:#9b6a6c}'
      + '.report-table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{border:1px solid #d0dbe0;padding:6px 10px;text-align:left;vertical-align:top}th{background:#aabbc3;color:#004849}tr:nth-child(even) td{background:#f9fafb}.muted,.meta{color:#728e9b;font-size:12px}.stat-failed{color:#ba554a;font-weight:600}.error-preview,.step-error{white-space:pre-wrap;word-break:break-word;max-width:420px;color:#ba554a}.report-io-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-bottom:12px}.output-preview{white-space:pre-wrap;word-break:break-word;max-height:520px;overflow:auto;background:#f3f6f7;border:1px solid #d0dbe0;padding:8px}.run-log{background:#f3f6f7;border:1px solid #d0dbe0;padding:8px;font-family:monospace;font-size:12px}.log-entry{padding:2px 0}.log-time,.log-node{color:#728e9b;margin-right:8px}.log-error{color:#ba554a}.log-warn{color:#9a6a18}.badge{display:inline-block;border:1px solid #d0dbe0;border-radius:3px;padding:1px 6px}.step-passed,.on{background:#1a9964;color:#fff}.step-failed,.status-failed{background:#ba554a;color:#fff}'
      + '</style></head><body>'
      + '<h1>批量流程报告</h1>'
      + '<p class="meta">运行记录: ' + runs.length + ' · 生成时间: ' + new Date().toLocaleString() + '</p>'
      + renderReportDashboard(runs)
      + sections
      + '</body></html>';
  }

  function exportAllRunsHtml() {
    if (!lastRuns.length) {
      toast('暂无运行历史可导出', true);
      return;
    }
    downloadFile('flow-report-batch-' + new Date().toISOString().slice(0, 10) + '.html', buildBatchHtmlReport(lastRuns), 'text/html');
  }

  function openRunCleanupDrawer() {
    var runs = lastRuns.slice();
    if (!runs.length) {
      toast('暂无运行记录可清理', true);
      return;
    }
    var oldestStartedAt = runs.reduce(function (min, run) {
      var startedAt = Number(run && run.startedAt);
      if (!isFinite(startedAt) || startedAt <= 0) return min;
      return min === null ? startedAt : Math.min(min, startedAt);
    }, null);
    var activeCount = runs.filter(function (run) { return isActiveRunHistoryStatus(run && run.status); }).length;
    var minAttr = oldestStartedAt ? ' min="' + toLocalDateInputValue(oldestStartedAt) + '"' : '';
    var maxAttr = ' max="' + toLocalDateInputValue(Date.now()) + '"';
    $('#drawer-title').textContent = '清理流程报告历史';
    $('#drawer-content').innerHTML =
      '<p class="drawer-hint">可按开始时间清理指定日期之前的记录，或直接清空全部历史。活动中的记录会被保留，不参与清理。</p>'
      + '<div class="form-row"><label>当前历史</label><div class="drawer-readonly-value">共 ' + runs.length + ' 条记录' + (activeCount ? ' · 活动中 ' + activeCount + ' 条' : '') + '</div></div>'
      + '<div class="form-row"><label for="run-history-before-date">清理该日期之前（按开始时间）</label><input type="date" id="run-history-before-date"' + minAttr + maxAttr + '></div>';
    $('#drawer-actions').innerHTML =
      '<button class="btn-secondary" data-action="cancel-drawer">取消</button>'
      + '<button class="btn-small btn-danger-outline" data-action="clear-run-history-before-date">清理指定日期前</button>'
      + '<button class="btn-small btn-danger-outline" data-action="clear-all-run-history">清空全部历史</button>';
    openDrawer();
  }

    function completeAction(key, operation) {
      pendingActions[key] = operation;
      operation.then(function () {
        if (pendingActions[key] === operation) delete pendingActions[key];
      }, function () {
        if (pendingActions[key] === operation) delete pendingActions[key];
      });
      return operation;
    }

    function runMutation(key, work, successMessage, onSuccess) {
      if (destroyed) return Promise.resolve({ ok: false, error: '报告控制器已销毁', destroyed: true });
      if (pendingActions[key]) return pendingActions[key];
      var operation = Promise.resolve().then(work).then(function (envelope) {
        if (destroyed) return { ok: false, stale: true, destroyed: true };
        if (typeof onSuccess === 'function') onSuccess(envelope);
        if (destroyed) return { ok: false, stale: true, destroyed: true };
        if (successMessage) toast(typeof successMessage === 'function' ? successMessage(envelope) : successMessage);
        if (destroyed) return { ok: false, stale: true, destroyed: true };
        return renderRuns({ force: true }).then(function () { return envelope; });
      }).catch(function (err) {
        if (destroyed) return { ok: false, stale: true, destroyed: true };
        var failure = { ok: false, error: resourceErrorText(err) };
        toast('清理失败: ' + failure.error, true);
        return failure;
      });
      return completeAction(key, operation);
    }

    function deleteRun(runId) {
      runId = String(runId || '');
      var run = findRun(runId);
      if (!run) return Promise.resolve({ ok: false, error: '运行记录不存在: ' + runId });
      if (isActiveRunHistoryStatus(run.status)) {
        return Promise.resolve({ ok: false, error: '活动中记录不能清理' });
      }
      var uri = '/runs/' + resourceSegment(runId);
      return runMutation('delete:' + runId, function () {
        return resourceClient.get(uri).then(function (envelope) {
          return resourceClient.authorizedDelete(uri, {
            etag: envelope.primary && envelope.primary.etag,
            criteria: { relation: 'run' },
          });
        });
      }, function (envelope) {
        var result = resourceData(envelope) || {};
        var removed = Number(result.removed) || 0;
        return removed ? '已清理本次记录' : '未清理任何记录';
      });
    }

    function clearBefore(beforeTimestampMs) {
      var cutoff = Number(beforeTimestampMs);
      if (!isFinite(cutoff) || cutoff <= 0) return Promise.resolve({ ok: false, error: '日期无效' });
      return runMutation('clear-before', function () {
        return resourceClient.get('/runs').then(function (envelope) {
          return resourceClient.authorizedDelete('/runs', {
            body: { before: new Date(cutoff).toISOString() },
            etag: envelope.primary && envelope.primary.etag,
            criteria: { relation: 'run-retention' },
          });
        });
      }, function (envelope) {
        var result = resourceData(envelope) || {};
        var removed = Number(result.removed) || 0;
        return removed ? ('已清理 ' + removed + ' 条记录') : '没有符合条件的记录';
      }, closeDrawer);
    }

    function clearBeforeSelectedDate() {
      var input = $('#run-history-before-date');
      var value = input && input.value || '';
      if (!value) {
        toast('请选择日期', true);
        return Promise.resolve({ ok: false, error: '请选择日期' });
      }
      var cutoff = new Date(value + 'T00:00:00').getTime();
      if (!isFinite(cutoff) || cutoff <= 0) {
        toast('日期无效', true);
        return Promise.resolve({ ok: false, error: '日期无效' });
      }
      if (!confirmAction('确定清理 ' + value + ' 之前的记录？')) {
        return Promise.resolve({ ok: false, cancelled: true });
      }
      return clearBefore(cutoff);
    }

    function clearAll() {
      return runMutation('clear-all', function () {
        return resourceClient.get('/runs').then(function (envelope) {
          return resourceClient.authorizedDelete('/runs', {
            body: { before: new Date().toISOString() },
            etag: envelope.primary && envelope.primary.etag,
            criteria: { relation: 'run-retention' },
          });
        });
      }, '历史记录已清理', closeDrawer);
    }


    function handleDocumentClick(event) {
      var source = event && event.target;
      var target = source && typeof source.closest === 'function' ? source.closest('[data-action]') : null;
      if (!target) return;
      var action = target.dataset && target.dataset.action || '';
      var id = target.dataset && target.dataset.id || '';
      if (action === 'toggle-run') {
        toggleRun(id);
        return;
      }
      if (action === 'export-run-json') {
        if (event.stopPropagation) event.stopPropagation();
        exportRunJson(id);
        return;
      }
      if (action === 'export-run-html') {
        if (event.stopPropagation) event.stopPropagation();
        exportRunHtml(id);
        return;
      }
      if (action === 'delete-run-history-entry') {
        if (event.stopPropagation) event.stopPropagation();
        if (confirmAction('确定清理这条运行记录？')) deleteRun(id);
        return;
      }
      if (action === 'clear-run-history-before-date') {
        if (event.stopPropagation) event.stopPropagation();
        clearBeforeSelectedDate();
        return;
      }
      if (action === 'clear-all-run-history') {
        if (event.stopPropagation) event.stopPropagation();
        if (confirmAction('确定清空全部历史记录？活动中的记录会保留。')) clearAll();
      }
    }

    function listenClick(selector, handler) {
      var element = $(selector);
      if (element) lifecycle.listen(element, 'click', handler);
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      if (doc) lifecycle.listen(doc, 'click', handleDocumentClick);
      lifecycle.listen(timerHost, 'pagehide', function (event) {
        if (!event || !event.persisted) destroy();
      });
      listenClick('#btn-refresh-runs', function () { renderRuns(); });
      listenClick('#btn-export-runs-json', exportAllRunsJson);
      listenClick('#btn-export-runs-html', exportAllRunsHtml);
      listenClick('#btn-export-failures-csv', exportFailuresCsv);
      listenClick('#btn-clear-runs', openRunCleanupDrawer);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      refreshSequence++;
      refreshInFlight = null;
      lifecycle.destroy();
    }

    function getState() {
      return {
        runs: lastRuns.slice(),
        expandedRunIds: Object.assign({}, expandedRunIds),
        destroyed: destroyed,
      };
    }

    return {
      init: init,
      destroy: destroy,
      refresh: renderRuns,
      render: renderCurrentRuns,
      toggleRun: toggleRun,
      deleteRun: deleteRun,
      clearBefore: clearBefore,
      clearAll: clearAll,
      openCleanup: openRunCleanupDrawer,
      exportRunJson: exportRunJson,
      exportRunHtml: exportRunHtml,
      exportAllRunsJson: exportAllRunsJson,
      exportAllRunsHtml: exportAllRunsHtml,
      exportFailuresCsv: exportFailuresCsv,
      getState: getState,
    };
  }

  return {
    create: create,
    escapeHtml: escapeHtml,
    formatStatus: formatStatus,
  };
});
