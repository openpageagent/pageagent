// Flow Group Controller - serial flow orchestration over isolated RunSession instances.
(function attachFlowGroupController(root, factory) {
  root.FlowGroupController = factory();
})(globalThis, function () {
  'use strict';

  var STOP_ERROR_MESSAGE = 'FLOW_GROUP_STOPPED_BY_USER';
  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return value;
  }

  function isSafeKey(value) {
    return typeof value === 'string' && value.length > 0 && value.trim() === value && !UNSAFE_KEYS[value];
  }

  function safeMapValue(map, key) {
    return isSafeKey(key) && hasOwn(map, key) ? ownDataValue(map, key) : undefined;
  }

  function copyOwnDataObject(value) {
    var output = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    Object.keys(value).forEach(function (key) {
      var item = ownDataValue(value, key);
      if (item !== undefined || hasOwn(value, key)) defineOwn(output, key, item);
    });
    return output;
  }

  function createFlowGroupController(deps) {
    deps = deps || {};

    var runReport = deps.runReport || globalThis.RunReport;
    if (!runReport) throw new Error('RunReport 未加载');
    var getConfigReady = deps.getConfigReady || (function () { return Promise.resolve(); });
    var getConfig = deps.getConfig || (function () { return { flows: {}, flowGroups: {} }; });
    var buildInitialContext = deps.buildInitialContext || (function (value) { return value || {}; });
    var cloneJsonSafe = deps.cloneJsonSafe || cloneFallback;
    var interpolate = deps.interpolate || function (text) { return String(text); };
    var resolvePath = deps.resolvePath || resolvePathFallback;
    var unwrapFlowOutput = deps.unwrapFlowOutput || function (value) { return value; };
    var getStepRunTabMode = deps.getStepRunTabMode || function (step) {
      return step && step.runTabMode || 'reuseOpenTab';
    };
    var startSessionRun = deps.startSessionRun || function () {
      return Promise.reject(new Error('startSessionRun 未接线'));
    };
    var getSession = deps.getSession || function () { return null; };
    var getSessionResult = deps.getSessionResult || function (runId) {
      throw new Error('流程会话不存在: ' + runId);
    };
    var registerSession = deps.registerSession || function () {};
    var unregisterSession = deps.unregisterSession || function () {};
    var stopSession = deps.stopSession || function () {};
    var appendRun = deps.appendRun || function () { return Promise.resolve(); };
    var updateRun = deps.updateRun || function () { return Promise.resolve(); };
    var rememberRunInput = deps.rememberRunInput || function () {};
    var broadcast = deps.broadcast || function () {};
    var broadcastSessions = deps.broadcastSessions || function () {};
    var syncKeepAlive = deps.syncKeepAlive || function () {};
    var pruneSessions = deps.pruneSessions || function () {};
    var getErrorMessage = deps.getErrorMessage || function (error) {
      return error && error.message ? error.message : String(error);
    };
    var normalizeLogScope = deps.normalizeLogScope || function (scope, hasNodeId, fallback) {
      return scope || (hasNodeId ? 'flow' : fallback || 'run');
    };
    var generateRunId = deps.generateRunId || function () {
      return 'fg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    };
    var now = deps.now || function () { return Date.now(); };
    var maxSessionLogs = Math.max(20, Number(deps.maxSessionLogs) || 400);

    function cloneFallback(value) {
      if (value === undefined) return undefined;
      try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function safeClone(value) {
      try { return cloneJsonSafe(value); } catch (_) { return cloneFallback(value); }
    }

    function reportClone(value) {
      try { return value === undefined ? null : runReport.sanitizeValue(value); } catch (_) {
        return value === undefined ? null : cloneFallback(value);
      }
    }

    function safeInvoke(callback, args) {
      try {
        var result = callback.apply(null, args || []);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(function () {});
        }
        return result;
      } catch (_) {
        return undefined;
      }
    }

    function invokePromise(callback, args) {
      return Promise.resolve().then(function () {
        return callback.apply(null, args || []);
      });
    }

    function requestChildStop(runId, parentSession) {
      if (!runId) return;
      function reportStopFailure(error) {
        if (!parentSession || typeof parentSession.addLog !== 'function') return;
        try {
          parentSession.addLog('停止子流程失败 (' + runId + '): ' + errorMessage(error), {
            level: 'warn',
            scope: 'run',
          });
        } catch (_) {}
      }
      try {
        Promise.resolve(stopSession(runId)).catch(reportStopFailure);
      } catch (error) {
        reportStopFailure(error);
      }
    }

    function errorMessage(error) {
      try { return getErrorMessage(error); } catch (_) {
        return error && error.message ? error.message : String(error);
      }
    }

    function isPlainObject(value) {
      return !!(value && typeof value === 'object' && !Array.isArray(value));
    }

    function resolvePathFallback(value, path) {
      var parts = String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
      var current = value;
      for (var i = 0; i < parts.length; i++) {
        if (current === null || current === undefined) return undefined;
        current = current[parts[i]];
      }
      return current;
    }

    function normalizeFlowId(flowId) {
      return String(flowId || '').replace(/^user:/, '');
    }

    function runtimeStepNodeId(step, index) {
      return ownDataValue(step, '__runtimeNodeId')
        || ('step_' + (index + 1) + '_' + String(ownDataValue(step, 'flowId') || '').replace(/[^a-zA-Z0-9_-]/g, '_'));
    }

    function prepareSteps(flowGroup, config) {
      var rawStepsValue = ownDataValue(flowGroup, 'steps');
      var rawSteps = Array.isArray(rawStepsValue) ? rawStepsValue.slice() : [];
      if (!rawSteps.length) throw new Error('流程组中没有可运行的流程');
      var seenStepIds = Object.create(null);
      return rawSteps.map(function (rawStep, index) {
        var step = copyOwnDataObject(rawStep);
        var flowId = normalizeFlowId(ownDataValue(step, 'flowId'));
        if (!flowId) throw new Error('流程组第 ' + (index + 1) + ' 步缺少流程');
        var flow = safeMapValue(ownDataValue(config, 'flows'), flowId);
        if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
          throw new Error('流程组第 ' + (index + 1) + ' 步引用的流程不存在: ' + ownDataValue(step, 'flowId'));
        }
        step.flowId = flowId;
        var configuredStepId = ownDataValue(step, 'stepId');
        var nodeId = configuredStepId === undefined || configuredStepId === null || configuredStepId === ''
          ? 'step_' + (index + 1) + '_' + flowId.replace(/[^a-zA-Z0-9_-]/g, '_')
          : configuredStepId;
        if (!isSafeKey(nodeId)) {
          throw new Error('流程组第 ' + (index + 1) + ' 步的 stepId 无效');
        }
        if (seenStepIds[nodeId]) {
          throw new Error('流程组第 ' + (index + 1) + ' 步的 stepId 重复: ' + nodeId);
        }
        seenStepIds[nodeId] = true;
        Object.defineProperty(step, '__runtimeNodeId', {
          value: nodeId,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        var outputVar = ownDataValue(step, 'outputVar');
        if (outputVar !== undefined && outputVar !== null && outputVar !== '' && !isSafeKey(outputVar)) {
          throw new Error('流程组第 ' + (index + 1) + ' 步的 outputVar 无效');
        }
        return step;
      });
    }

    function prepareParentContext(rawContext) {
      var parentCtx = buildInitialContext(rawContext || {});
      if (!isPlainObject(parentCtx)) parentCtx = {};
      parentCtx = safeClone(parentCtx) || {};
      if (hasOwn(parentCtx, 'input')) {
        parentCtx.input = safeClone(parentCtx.input);
        if (isPlainObject(parentCtx.input)) delete parentCtx.input.tabId;
      } else {
        var initialInput = {};
        Object.keys(parentCtx).forEach(function (key) {
          if (key === 'tabId' || key === 'steps' || key === 'stepOutputs' || key === 'last') return;
          initialInput[key] = safeClone(parentCtx[key]);
        });
        parentCtx.input = initialInput;
      }
      parentCtx.steps = [];
      parentCtx.stepOutputs = Object.create(null);
      return parentCtx;
    }

    function extractOutput(ctx) {
      var result = resolvePath(ctx || {}, 'result');
      var last = unwrapFlowOutput(resolvePath(ctx || {}, 'last'));
      return result !== undefined ? result : (last !== undefined ? last : ctx);
    }

    function buildStepInput(step, parentCtx) {
      var raw = step.inputJson || step.input || '';
      if (String(raw || '').trim()) {
        var text = interpolate(String(raw), parentCtx);
        try {
          return JSON.parse(text);
        } catch (error) {
          throw new Error('流程组步骤入参 JSON 解析失败: ' + error.message);
        }
      }

      var inheritedInput = parentCtx.last !== undefined ? unwrapFlowOutput(parentCtx.last) : parentCtx.input;
      if (inheritedInput === undefined) inheritedInput = {};
      if (!isPlainObject(inheritedInput)) return { value: safeClone(inheritedInput) };
      return safeClone(inheritedInput) || {};
    }

    function buildChildContext(stepInput, parentCtx) {
      var isolatedInput = safeClone(stepInput);
      if (isPlainObject(isolatedInput)) delete isolatedInput.tabId;
      var childContext = isPlainObject(isolatedInput)
        ? isolatedInput
        : { value: isolatedInput };
      if (!isPlainObject(childContext.input)) {
        childContext.input = isPlainObject(isolatedInput)
          ? safeClone(isolatedInput)
          : { value: safeClone(isolatedInput) };
      }
      var parentTabId = ownDataValue(parentCtx, 'tabId');
      if (parentTabId !== undefined && parentTabId !== null && parentTabId !== '') {
        defineOwn(childContext, 'tabId', safeClone(parentTabId));
      }
      return childContext;
    }

    function runChildAndWait(flowId, context, trigger, options, parentSession) {
      var childOptions = {
        trigger: trigger || 'flowGroup',
        entry: options.entry || 'flowGroup',
        assistantInvocationKind: options.assistantInvocationKind === 'runAssistant'
          ? 'runAssistant' : '',
        initialContext: context || {},
        boundTabId: options.boundTabId || 0,
        ownerTabId: options.ownerTabId || options.originTabId || options.boundTabId || 0,
        originTabId: options.originTabId || options.ownerTabId || options.boundTabId || 0,
        originWindowId: options.originWindowId || 0,
        conversationTopicId: options.conversationTopicId || '',
        incognito: options.incognito,
        runTabMode: options.runTabMode,
        parentRunId: options.parentRunId || '',
        parentKind: options.parentKind || '',
        parentFlowGroupId: options.parentFlowGroupId || '',
        parentFlowGroupLabel: options.parentFlowGroupLabel || '',
        parentStepIndex: options.parentStepIndex,
        parentStepLabel: options.parentStepLabel || '',
        forceCdpKeepAlive: options.forceCdpKeepAlive === true
          || String(options.trigger || trigger || '').indexOf('schedule:') === 0
          || String(options.entry || '') === 'schedule',
      };
      return invokePromise(startSessionRun, ['user:' + normalizeFlowId(flowId), childOptions]).then(function (started) {
        var runId = started && (started.runId || started.sessionId);
        var childSession = runId && getSession(runId);
        if (!childSession) throw new Error('流程会话不存在: ' + runId);
        parentSession.childRunId = runId;
        safeInvoke(broadcastSessions);
        if (parentSession.stopRequested) requestChildStop(runId, parentSession);
        return Promise.resolve(childSession.runPromise).then(function () {
          return getSessionResult(runId);
        }, function () {
          return getSessionResult(runId);
        }).then(function (result) {
          result = result && typeof result === 'object' ? Object.assign({}, result) : {};
          if (!result.runId) result.runId = runId;
          return result;
        });
      });
    }

    function stepTitle(step, index, config) {
      var flow = safeMapValue(ownDataValue(config, 'flows'), ownDataValue(step, 'flowId'));
      return ownDataValue(step, 'label') || (flow && (ownDataValue(flow, 'label') || ownDataValue(flow, 'name')))
        || ownDataValue(step, 'flowId') || ('步骤 ' + (index + 1));
    }

    function buildTabUsage(records) {
      var usage = {};
      (records || []).forEach(function (record, index) {
        var stepUsage = record && record.tabUsage ? record.tabUsage : {};
        Object.keys(stepUsage).forEach(function (key) {
          var item = stepUsage[key] || {};
          var next = Object.assign({}, item);
          next.flowGroupStep = record.flowLabel || record.flowId || '';
          next.pageId = (record.flowLabel || record.flowId || ('步骤' + (index + 1))) + ' / ' + (item.pageId || item.source || key);
          defineOwn(usage, 'step' + (index + 1) + ':' + key, next);
        });
      });
      return usage;
    }

    function buildTabEvents(records) {
      var events = [];
      (records || []).forEach(function (record, index) {
        var stepEvents = Array.isArray(record && record.tabEvents) ? record.tabEvents : [];
        stepEvents.forEach(function (event) {
          events.push(Object.assign({
            flowGroupStep: record.flowLabel || record.flowId || '',
            stepIndex: index,
          }, event));
        });
      });
      return events;
    }

    function reportInputFromContext(ctx) {
      if (!isPlainObject(ctx)) return null;
      if (hasOwn(ctx, 'input')) return reportClone(ctx.input);
      return Object.keys(ctx).length ? reportClone(ctx) : null;
    }

    function runFlowGroup(flowGroupId, options) {
      options = options || {};
      return invokePromise(getConfigReady).then(function () {
        var config = getConfig() || {};
        flowGroupId = String(flowGroupId || '');
        var flowGroup = safeMapValue(ownDataValue(config, 'flowGroups'), flowGroupId);
        if (!flowGroup || typeof flowGroup !== 'object' || Array.isArray(flowGroup)) {
          throw new Error('流程组不存在: ' + flowGroupId);
        }
        var steps = prepareSteps(flowGroup, config);
        var runId = generateRunId();
        var startedAt = now();
        var parentCtx = prepareParentContext(options.initialContext || options.context || {});
        var flowGroupLabel = ownDataValue(flowGroup, 'label') || ownDataValue(flowGroup, 'name') || flowGroupId;
        var sessionFlowId = 'flowGroup:' + flowGroupId;
        var results = [];
        var groupLogs = [];

        var session = {
          runId: runId,
          kind: 'flowGroup',
          flowGroupId: flowGroupId,
          flowId: sessionFlowId,
          flowLabel: '流程组: ' + flowGroupLabel,
          status: 'running',
          error: '',
          trigger: options.trigger || 'manual',
          entry: options.entry || 'flowGroup',
          forceCdpKeepAlive: options.forceCdpKeepAlive === true
            || String(options.trigger || '').indexOf('schedule:') === 0
            || String(options.entry || '') === 'schedule',
          ownerTabId: options.ownerTabId || options.originTabId || 0,
          originTabId: options.originTabId || options.ownerTabId || 0,
          originWindowId: options.originWindowId || 0,
          conversationTopicId: options.conversationTopicId || '',
          runTabMode: '',
          boundTabId: 0,
          primaryRunTabId: 0,
          fixedRunTab: false,
          windowId: 0,
          incognito: !!options.incognito,
          keepAliveTabs: {},
          proxyConfigs: {},
          tabs: {},
          tabUsage: {},
          tabEvents: [],
          waitingTabs: {},
          nodeStatuses: Object.create(null),
          logs: [],
          nodes: steps.map(function (step, index) {
            return {
              nodeId: runtimeStepNodeId(step, index),
              title: stepTitle(step, index, config),
              displayOrder: index + 1,
              type: 'flowGroupStep',
            };
          }),
          startedAt: startedAt,
          endedAt: 0,
          initialContext: reportClone(parentCtx),
          flowGroupResults: [],
          childRunId: '',
          stopRequested: false,
          reportStatus: 'pending',
          reportError: '',
        };
        session.nodes.forEach(function (node) {
          defineOwn(session.nodeStatuses, node.nodeId, 'pending');
        });

        session.controller = {
          requestStop: function () {
            session.stopRequested = true;
            if (session.childRunId) requestChildStop(session.childRunId, session);
          },
          clearStopRequest: function () { session.stopRequested = false; },
          isRunning: function () { return session.status === 'running'; },
        };
        session.addLog = function (message, logOptions) {
          logOptions = logOptions || {};
          var nodeId = logOptions.nodeId || '';
          var entry = {
            timestamp: now(),
            level: logOptions.level || 'info',
            nodeId: nodeId,
            scope: safeInvoke(normalizeLogScope, [logOptions.scope, !!nodeId, 'run']) || 'run',
            tabId: logOptions.tabId || 0,
            windowId: logOptions.windowId || 0,
            flowId: session.flowId,
            runId: runId,
            message: String(message),
          };
          session.logs.push(entry);
          if (session.logs.length > maxSessionLogs) session.logs.splice(0, session.logs.length - maxSessionLogs);
          safeInvoke(broadcast, [{ type: 'NEW_LOG', payload: Object.assign({ runId: runId }, entry) }]);
          return entry;
        };

        function addGroupLog(message, logOptions) {
          var entry = session.addLog(message, Object.assign({ scope: 'run', flowId: session.flowId }, logOptions || {}));
          if (entry) groupLogs.push(entry);
          return entry;
        }

        function setStepStatus(nodeId, status) {
          defineOwn(session.nodeStatuses, nodeId, status);
          safeInvoke(broadcast, [{ type: 'NODE_STATUS_CHANGE', payload: { runId: runId, nodeId: nodeId, status: status } }]);
          safeInvoke(broadcastSessions);
        }

        function clearChildRun() {
          session.childRunId = '';
          safeInvoke(broadcastSessions);
        }

        function mergeStepResult(step, stepIndex, flowLabel, stepLabel, childContext, runTabMode, result) {
          result = result || {};
          var status = result.status || 'failed';
          var output = status === 'success'
            ? extractOutput(result.ctx || {})
            : {
              status: status,
              runId: result.runId || '',
              error: result.error || '',
              last: result.ctx && result.ctx.last,
            };
          var record = {
            stepId: ownDataValue(step, 'stepId') || '',
            flowId: ownDataValue(step, 'flowId'),
            flowLabel: flowLabel,
            runId: result.runId || '',
            parentRunId: runId,
            status: status,
            error: result.error || '',
            runTabMode: runTabMode,
            tabUsage: safeClone(result.tabUsage || {}),
            tabEvents: safeClone(result.tabEvents || []),
            input: reportClone(childContext && childContext.input),
            output: reportClone(output),
          };
          results.push(record);
          session.flowGroupResults = reportClone(results);
          parentCtx.last = output;
          parentCtx.steps.push(record);
          var outputKey = ownDataValue(step, 'outputVar') || ownDataValue(step, 'stepId') || ownDataValue(step, 'flowId');
          defineOwn(parentCtx, outputKey, output);
          defineOwn(parentCtx.stepOutputs, outputKey, output);

          if (session.stopRequested || status === 'stopped') {
            session.stopRequested = true;
            setStepStatus(runtimeStepNodeId(step, stepIndex), 'stopped');
            throw new Error(STOP_ERROR_MESSAGE);
          }
          if (status === 'success') {
            setStepStatus(runtimeStepNodeId(step, stepIndex), 'completed');
            return;
          }
          setStepStatus(runtimeStepNodeId(step, stepIndex), 'failed');
          if (step.continueOnFailure === true) {
            addGroupLog('流程组步骤失败但继续: ' + stepLabel + ' (status=' + status + ', runId=' + (result.runId || '') + ')', { level: 'warn' });
            return;
          }
          throw new Error('流程组步骤失败: ' + stepLabel + ' (status=' + status + ', runId=' + (result.runId || '') + ')');
        }

        function mergeStepError(step, stepIndex, flowLabel, stepLabel, childContext, runTabMode, error, failedRunId) {
          var failure = {
            runId: failedRunId || session.childRunId || '',
            status: 'failed',
            error: errorMessage(error),
            ctx: {},
          };
          if (session.stopRequested || (error && error.message === STOP_ERROR_MESSAGE)) {
            setStepStatus(runtimeStepNodeId(step, stepIndex), 'stopped');
            throw new Error(STOP_ERROR_MESSAGE);
          }
          mergeStepResult(step, stepIndex, flowLabel, stepLabel, childContext || {}, runTabMode || '', failure);
        }

        function markUnfinished(finalStatus) {
          session.nodes.forEach(function (node) {
            var status = session.nodeStatuses[node.nodeId];
            if (status === 'running') setStepStatus(node.nodeId, finalStatus === 'stopped' ? 'stopped' : 'failed');
            else if (status === 'pending') setStepStatus(node.nodeId, 'skipped');
          });
        }

        function terminalPatch(status, error, output, tabUsage, tabEvents) {
          return runReport.createTerminalPatch({
            endedAt: session.endedAt,
            status: status,
            error: error || '',
            flowGroupResults: results,
            input: reportInputFromContext(parentCtx),
            output: reportClone(output),
            result: reportClone(output),
            entry: options.entry || 'flowGroup',
            ownerTabId: session.ownerTabId || options.ownerTabId || options.originTabId || 0,
            originTabId: session.originTabId || options.originTabId || options.ownerTabId || 0,
            originWindowId: options.originWindowId || 0,
            tabUsage: tabUsage,
            tabEvents: tabEvents,
            logs: groupLogs,
            nodeStatuses: session.nodeStatuses,
          });
        }

        function reportWriteFailed(error, phase) {
          var message = errorMessage(error);
          if (!session.reportError) session.reportError = message;
          session.reportStatus = 'failed';
          addGroupLog('流程组报告' + phase + '失败: ' + message, { level: 'error' });
          safeInvoke(broadcast, [{
            type: 'RUN_REPORT_PERSISTENCE_ERROR',
            payload: { runId: runId, kind: 'flowGroup', phase: phase, error: message },
          }]);
          safeInvoke(broadcastSessions);
        }

        function finishObservers(result) {
          session.reportStatus = session.reportError ? 'failed' : 'complete';
          safeInvoke(broadcast, [{ type: 'RUN_HISTORY_UPDATED' }]);
          safeInvoke(broadcastSessions);
          safeInvoke(pruneSessions);
          return result;
        }

        function finalizeFailure(error) {
          var stopped = session.stopRequested || (error && error.message === STOP_ERROR_MESSAGE);
          var status = stopped ? 'stopped' : 'failed';
          var finalError = stopped ? '' : errorMessage(error);
          clearChildRun();
          session.status = status;
          session.endedAt = now();
          session.error = finalError;
          markUnfinished(status);
          if (stopped) addGroupLog('流程组已停止');
          else addGroupLog('流程组失败: ' + finalError, { level: 'error' });
          var tabUsage = buildTabUsage(results);
          var tabEvents = buildTabEvents(results);
          session.tabUsage = tabUsage;
          session.tabEvents = tabEvents;
          session.flowGroupResults = reportClone(results);
          session.initialContext = reportClone(parentCtx);
          var reportInput = reportInputFromContext(parentCtx);
          safeInvoke(rememberRunInput, [runId, reportInput]);
          safeInvoke(syncKeepAlive);
          if (error && error.runReportCreationFailed) {
            safeInvoke(pruneSessions);
            return Promise.resolve();
          }
          return invokePromise(updateRun, [runId, terminalPatch(status, finalError, parentCtx.last, tabUsage, tabEvents)])
            .then(finishObservers, function (reportError) {
              reportWriteFailed(reportError, '终态写入');
              safeInvoke(pruneSessions);
            });
        }

        var index = 0;
        function next() {
          if (session.stopRequested) return Promise.reject(new Error(STOP_ERROR_MESSAGE));
          if (index >= steps.length) return Promise.resolve();
          var stepIndex = index;
          var step = steps[index++];
          var flow = safeMapValue(ownDataValue(config, 'flows'), ownDataValue(step, 'flowId'));
          var flowLabel = flow && (ownDataValue(flow, 'label') || ownDataValue(flow, 'name')) || ownDataValue(step, 'flowId');
          var stepLabel = ownDataValue(step, 'label') || flowLabel;
          var nodeId = runtimeStepNodeId(step, stepIndex);
          setStepStatus(nodeId, 'running');

          var stepInput;
          var childContext;
          var runTabMode;
          try {
            stepInput = buildStepInput(step, parentCtx);
            childContext = buildChildContext(stepInput, parentCtx);
            runTabMode = getStepRunTabMode(step, step.flowId);
          } catch (error) {
            try {
              mergeStepError(step, stepIndex, flowLabel, stepLabel, childContext || {}, runTabMode || '', error);
            } catch (stepError) {
              return Promise.reject(stepError);
            }
            return next();
          }

          addGroupLog('流程组执行 (' + index + '/' + steps.length + '): ' + stepLabel);
          return runChildAndWait(step.flowId, childContext, 'flowGroup:' + flowGroupId, Object.assign({}, options, {
            runTabMode: runTabMode,
            entry: options.entry || 'flowGroup',
            parentRunId: runId,
            parentKind: 'flowGroup',
            parentFlowGroupId: flowGroupId,
            parentFlowGroupLabel: flowGroupLabel,
            parentStepIndex: stepIndex,
            parentStepLabel: stepLabel,
            forceCdpKeepAlive: session.forceCdpKeepAlive === true,
          }), session).then(function (result) {
            clearChildRun();
            mergeStepResult(step, stepIndex, flowLabel, stepLabel, childContext, runTabMode, result);
          }, function (error) {
            var failedRunId = session.childRunId;
            clearChildRun();
            mergeStepError(step, stepIndex, flowLabel, stepLabel, childContext, runTabMode, error, failedRunId);
          }).then(next);
        }

        try {
          registerSession(session);
        } catch (error) {
          safeInvoke(unregisterSession, [runId, session]);
          throw error;
        }
        safeInvoke(broadcastSessions);
        safeInvoke(syncKeepAlive);

        addGroupLog('流程组开始: ' + flowGroupLabel + '，共 ' + steps.length + ' 个流程');
        var groupInput = reportInputFromContext(parentCtx);
        var runRecord = runReport.createStartRecord({
          id: runId,
          kind: 'flowGroup',
          flowId: flowGroupId,
          flowLabel: '流程组: ' + flowGroupLabel,
          trigger: options.trigger || 'manual',
          entry: options.entry || 'flowGroup',
          ownerTabId: options.ownerTabId || options.originTabId || 0,
          originTabId: options.originTabId || options.ownerTabId || 0,
          originWindowId: options.originWindowId || 0,
          startedAt: startedAt,
          input: groupInput,
        });
        safeInvoke(rememberRunInput, [runRecord]);

        var runRecordReady = invokePromise(appendRun, [runRecord]).then(function () {
          session.reportStatus = 'running';
          safeInvoke(broadcast, [{ type: 'RUN_HISTORY_UPDATED' }]);
        }, function (error) {
          reportWriteFailed(error, '创建');
          var creationError = new Error(errorMessage(error));
          creationError.runReportCreationFailed = true;
          throw creationError;
        });

        session.runPromise = runRecordReady.then(next).then(function () {
          var finalOutput = extractOutput(parentCtx);
          parentCtx.result = finalOutput;
          clearChildRun();
          session.status = 'success';
          session.endedAt = now();
          session.error = '';
          markUnfinished('success');
          var tabUsage = buildTabUsage(results);
          var tabEvents = buildTabEvents(results);
          session.tabUsage = tabUsage;
          session.tabEvents = tabEvents;
          session.flowGroupResults = reportClone(results);
          session.initialContext = reportClone(parentCtx);
          addGroupLog('流程组完成: ' + flowGroupLabel);
          var reportInput = reportInputFromContext(parentCtx);
          safeInvoke(rememberRunInput, [runId, reportInput]);
          safeInvoke(syncKeepAlive);
          return invokePromise(updateRun, [runId, terminalPatch('success', '', finalOutput, tabUsage, tabEvents)]).then(finishObservers, function (reportError) {
            reportWriteFailed(reportError, '终态写入');
            safeInvoke(pruneSessions);
          });
        }).catch(finalizeFailure);

        return {
          started: true,
          total: steps.length,
          flowGroupRunId: runId,
          runId: runId,
        };
      });
    }

    return {
      runFlowGroup: runFlowGroup,
    };
  }

  return {
    STOP_ERROR_MESSAGE: STOP_ERROR_MESSAGE,
    createFlowGroupController: createFlowGroupController,
  };
});
