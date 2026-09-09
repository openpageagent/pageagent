// Auto Run Controller — 自动运行循环控制器
(function attachAutoRunController(root, factory) {
  root.AutoRunController = factory();
})(globalThis, function () {

  var STOP_ERROR_MESSAGE = 'FLOW_STOPPED_BY_USER';
  var MAX_SCREENSHOTS_PER_ROUND = 5;
  var MAX_STEPS_PER_ATTEMPT = 600;

  function isFatalFlowError(error) {
    return !!(error && error.fatalFlow === true);
  }

  function hasUncertainSideEffect(error) {
    if (!error || error.retryable !== false) return false;
    if (error.performed === 'unknown' || error.performed === 'yes') return true;
    var receipt = error.receipt || error.actionReceipt;
    return !!(receipt && receipt.performed !== 'no');
  }

  function createAutoRunController(deps) {
    deps = deps || {};

    var isNodeReplaySafe = deps.isNodeReplaySafe
      || globalThis.NodeTypes && globalThis.NodeTypes.isNodeReplaySafe
      || function () { return false; };

    var getState = deps.getState || (function () { return {}; });
    var setState = deps.setState || (function () {});
    var addLog = deps.addLog || (function () {});
    var setNodeStatus = deps.setNodeStatus || (function () {});
    var getOrderedNodes = deps.getOrderedNodes || (function () { return []; });
    var getNodeIdsForFlow = deps.getNodeIdsForFlow || (function () { return []; });
    var isNodeDoneStatus = deps.isNodeDoneStatus || (function () { return false; });
    var getErrorMessage = deps.getErrorMessage || (function (e) { return String(e); });
    var executeNode = deps.executeNode || (function () { return Promise.resolve(); });
    var broadcast = deps.broadcast || (function () {});
    var sleep = deps.sleep || (function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); });
    var onRunStart = deps.onRunStart || (function () {});
    var onRunComplete = deps.onRunComplete || (function () {});
    var onRoundReset = deps.onRoundReset || (function () {});
    var captureFailureScreenshot = deps.captureFailureScreenshot || null;
    var getFlowDataset = deps.getFlowDataset || (function () { return []; });

    var stopRequested = false;
    var fatalFailure = null;
    var autoRunSessionId = '';
    var running = false;

    function isRunning() {
      return running;
    }

    // --- 停止控制 ---

    function requestStop() {
      stopRequested = true;
    }

    function requestFailure(error) {
      if (fatalFailure) return false;
      error = error instanceof Error ? error : new Error(String(error || 'FLOW_RUNTIME_FAILED'));
      error.fatalFlow = true;
      fatalFailure = error;
      return true;
    }

    function clearStopRequest() {
      stopRequested = false;
      fatalFailure = null;
    }

    function getStopRequested() {
      return stopRequested;
    }

    function throwIfStopped() {
      if (fatalFailure) throw fatalFailure;
      if (stopRequested) throw new Error(STOP_ERROR_MESSAGE);
    }

    // Keep controller-level backoff responsive to a user stop. The injected
    // sleep implementation is intentionally opaque, so wait in short chunks
    // and check the controller state between them instead of blocking for an
    // entire retry/round interval.
    function sleepWithStop(ms) {
      var remaining = Math.max(0, Number(ms) || 0);
      function step() {
        throwIfStopped();
        if (remaining <= 0) return Promise.resolve();
        var chunk = Math.min(250, remaining);
        remaining -= chunk;
        return Promise.resolve(sleep(chunk)).then(step);
      }
      return step();
    }

    function isStopError(err) {
      return err && err.message === STOP_ERROR_MESSAGE;
    }

    // --- 自动运行会话 ---

    function createAutoRunSessionId() {
      autoRunSessionId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      return autoRunSessionId;
    }

    function isCurrentAutoRunSession(sessionId) {
      return sessionId === autoRunSessionId;
    }

    // --- 重置状态为新一轮 ---

    function resetStateForNewRound(flowId) {
      var state = getState();
      var nodeIds = getNodeIdsForFlow(flowId);
      var freshStatuses = {};
      for (var i = 0; i < nodeIds.length; i++) {
        freshStatuses[nodeIds[i]] = 'pending';
      }

      setState({
        flowId: flowId,
        currentNodeId: '',
        nodeStatuses: freshStatuses,
        flowStartTime: Date.now(),
        sharedState: Object.assign({}, state.sharedState || {}, { flowStartTime: Date.now() }),
      });

      addLog('新一轮状态已重置, flow=' + flowId);
      onRoundReset(flowId);
    }

    // 从指定节点恢复：之前的节点标记为跳过，不重置运行上下文（保留已提取的变量）
    function resetStateForResume(flowId, resumeNodeId) {
      var orderedNodes = getOrderedNodes(flowId);
      for (var boundaryIndex = 1; boundaryIndex < orderedNodes.length; boundaryIndex++) {
        var boundaryNode = orderedNodes[boundaryIndex];
        var previousNode = orderedNodes[boundaryIndex - 1];
        if (boundaryNode.nodeId !== resumeNodeId || boundaryNode.type !== 'waitForCondition') continue;
        var previousParams = previousNode && previousNode.params && typeof previousNode.params === 'object'
          ? previousNode.params : {};
        if (String(previousParams.confirmationMode || '') !== 'deferred') continue;
        resumeNodeId = previousNode.nodeId;
        addLog('恢复目标是 deferred 动作的配对等待节点，已回退到前置动作保持验证单元完整', {
          nodeId: resumeNodeId,
          level: 'warn',
        });
        break;
      }
      var statuses = {};
      var found = false;
      for (var i = 0; i < orderedNodes.length; i++) {
        if (orderedNodes[i].nodeId === resumeNodeId) found = true;
        statuses[orderedNodes[i].nodeId] = found ? 'pending' : 'skipped';
      }
      if (!found) {
        addLog('恢复目标节点不存在，从头执行: ' + resumeNodeId, { level: 'warn' });
        resetStateForNewRound(flowId);
        return;
      }

      var state = getState();
      setState({
        flowId: flowId,
        currentNodeId: '',
        nodeStatuses: statuses,
        flowStartTime: Date.now(),
        sharedState: Object.assign({}, state.sharedState || {}, { flowStartTime: Date.now() }),
      });
      addLog('从节点恢复执行: ' + resumeNodeId + '（之前节点已跳过，上下文变量保留）');
    }

    // --- 顺序执行节点（含节点级重试/失败策略、步骤记录、条件分支） ---

    function getCommonFields(node) {
      var NodeTypes = globalThis.NodeTypes;
      if (NodeTypes && NodeTypes.normalizeCommonFields) return NodeTypes.normalizeCommonFields(node);
      return { onFailure: 'abort', retries: 0, retryDelayMs: 1000 };
    }

    function ensureStepsMeta(steps) {
      if (!steps.__pfaMeta) {
        Object.defineProperty(steps, '__pfaMeta', {
          value: { total: 0, omitted: 0, counts: {} },
          enumerable: false,
          configurable: true,
        });
      }
      return steps.__pfaMeta;
    }

    function countVisibleSteps(steps) {
      var counts = {};
      for (var i = 0; i < steps.length; i++) {
        var status = steps[i] && steps[i].status || 'unknown';
        counts[status] = (counts[status] || 0) + 1;
      }
      return counts;
    }

    function summarizeStepsMeta(steps) {
      var meta = steps.__pfaMeta;
      if (!meta) return { total: steps.length, omitted: 0, counts: countVisibleSteps(steps) };
      return {
        total: meta.total || steps.length,
        omitted: meta.omitted || 0,
        counts: Object.assign({}, meta.counts || {}),
      };
    }

    function attachStepsMeta(summary, steps) {
      var meta = summarizeStepsMeta(steps);
      summary.totalSteps = meta.total;
      summary.stepCounts = meta.counts;
      if (meta.omitted > 0) {
        summary.stepsOmitted = meta.omitted;
        summary.stepsWindow = 'last';
      }
      return summary;
    }

    // seqOptions: { steps: [], dataIndex }
    function runAutoSequence(flowId, seqOptions) {
      seqOptions = seqOptions || {};
      var steps = seqOptions.steps || [];
      var dataIndex = seqOptions.dataIndex;
      var state = getState();
      var orderedNodes = getOrderedNodes(flowId);
      var nodeStatuses = state.nodeStatuses || {};
      var loopStack = deps.getLoopStack ? deps.getLoopStack() : [];
      var screenshotCount = 0;
      var softFailures = 0;

      var startIndex = orderedNodes.length;
      if (seqOptions.startNodeId) {
        // 继续模式：直接按停止节点定位（循环体内 completed 状态会让「首个非 done」扫描不可靠）
        for (var s = 0; s < orderedNodes.length; s++) {
          if (orderedNodes[s].nodeId === seqOptions.startNodeId) { startIndex = s; break; }
        }
        if (startIndex === orderedNodes.length) {
          return Promise.reject(new Error('继续目标节点不存在: ' + seqOptions.startNodeId));
        }
      } else {
        for (var i = 0; i < orderedNodes.length; i++) {
          if (!isNodeDoneStatus(nodeStatuses[orderedNodes[i].nodeId] || 'pending')) {
            startIndex = i;
            break;
          }
        }
      }

      var currentIndex = startIndex;

      function recordStep(node, status, extra) {
        var meta = ensureStepsMeta(steps);
        meta.total++;
        meta.counts[status] = (meta.counts[status] || 0) + 1;
        var entry = Object.assign({
          nodeId: node.nodeId,
          title: node.title,
          type: node.type,
          status: status,
        }, extra || {});
        if (dataIndex !== undefined) entry.dataIndex = dataIndex;
        if (steps.length >= MAX_STEPS_PER_ATTEMPT) {
          steps.shift();
          meta.omitted++;
        }
        steps.push(entry);
        return entry;
      }

      // 标记 (fromIdx, toIdx) 开区间内节点为跳过
      function markSkippedRange(fromIdx, toIdx) {
        for (var k = fromIdx + 1; k < toIdx; k++) {
          setNodeStatus(orderedNodes[k].nodeId, 'skipped');
          recordStep(orderedNodes[k], 'skipped');
        }
      }

      function findBranchTargets(idx) {
        var ifId = orderedNodes[idx].params && orderedNodes[idx].params.ifId;
        var elseIdx = -1;
        var endIdx = -1;
        for (var k = idx + 1; k < orderedNodes.length; k++) {
          var pid = orderedNodes[k].params && orderedNodes[k].params.ifId;
          if (pid !== ifId) continue;
          if (orderedNodes[k].type === 'elseBlock' && elseIdx === -1) elseIdx = k;
          if (orderedNodes[k].type === 'ifEnd') { endIdx = k; break; }
        }
        return { elseIdx: elseIdx, endIdx: endIdx };
      }

      function runNodeWithRetry(node) {
        var cf = getCommonFields(node);
        var attempt = 0;
        var startedAt = Date.now();

        function tryOnce() {
          attempt++;
          throwIfStopped();
          return executeNode(node.nodeId, getState()).catch(function (err) {
            if (fatalFailure) throw fatalFailure;
            if (isStopError(err)) throw err;
            if (isFatalFlowError(err)) throw err;
            // 停止请求会让进行中的命令以普通错误失败，这里统一转为停止
            if (stopRequested) throw new Error(STOP_ERROR_MESSAGE);
            if (err && err.retryable === false) throw err;
            if (attempt <= cf.retries) {
              addLog('节点失败，' + cf.retryDelayMs + 'ms 后重试 (' + attempt + '/' + cf.retries + '): ' + getErrorMessage(err), { nodeId: node.nodeId, level: 'warn' });
              return sleepWithStop(cf.retryDelayMs).then(function () {
                throwIfStopped();
                return tryOnce();
              });
            }
            err.__attempts = attempt;
            err.__startedAt = startedAt;
            err.__durationMs = Date.now() - startedAt;
            throw err;
          });
        }

        return tryOnce().then(function (result) {
          return { result: result, attempts: attempt, startedAt: startedAt, durationMs: Date.now() - startedAt };
        });
      }

      function executeNext() {
        if (currentIndex >= orderedNodes.length) return Promise.resolve({ softFailures: softFailures });

        throwIfStopped();
        var node = orderedNodes[currentIndex];
        setNodeStatus(node.nodeId, 'running');
        addLog('开始执行节点: ' + node.title, { nodeId: node.nodeId });

        return runNodeWithRetry(node).then(function (exec) {
          var result = exec.result;
          setNodeStatus(node.nodeId, 'completed');
          addLog('节点完成: ' + node.title, { nodeId: node.nodeId });
          recordStep(node, 'passed', { startedAt: exec.startedAt, durationMs: exec.durationMs, attempts: exec.attempts });

          // --- 条件分支 ---
          if (node.type === 'ifStart' && !(result && result.conditionMet)) {
            var targets = findBranchTargets(currentIndex);
            // 条件为假：跳过 if 体（有 else 跳到 else 之后，否则跳到 ifEnd）
            var jumpTo = targets.elseIdx !== -1 ? targets.elseIdx + 1 : targets.endIdx;
            if (jumpTo > currentIndex) {
              markSkippedRange(currentIndex, jumpTo);
              currentIndex = jumpTo;
              return executeNext();
            }
            if (targets.endIdx === -1) {
              addLog('条件分支缺少配对的"分支结束"节点: ' + (node.params && node.params.ifId), { nodeId: node.nodeId, level: 'warn' });
            }
          }

          if (node.type === 'elseBlock') {
            // 顺序执行到达 else，说明 if 体已执行完 → 跳过 else 体
            var ifId = node.params && node.params.ifId;
            for (var b = currentIndex + 1; b < orderedNodes.length; b++) {
              if (orderedNodes[b].type === 'ifEnd' && orderedNodes[b].params && orderedNodes[b].params.ifId === ifId) {
                markSkippedRange(currentIndex, b);
                currentIndex = b;
                return executeNext();
              }
            }
          }

          // --- 循环控制 ---
          if (result && result.loopBreak === true) {
            var loopDepth = 0;
            for (var j = currentIndex + 1; j < orderedNodes.length; j++) {
              if (orderedNodes[j].type === 'loopStart') loopDepth++;
              if (orderedNodes[j].type === 'loopEnd') {
                if (loopDepth === 0) {
                  var loopId = orderedNodes[j].params && orderedNodes[j].params.loopId;
                  var idx = loopStack.findIndex(function (l) { return l.loopId === loopId; });
                  if (idx !== -1) loopStack.splice(idx, 1);
                  // Break bypasses the remaining body and loopEnd. Mark every
                  // bypassed node terminal so reports do not retain pending nodes.
                  markSkippedRange(currentIndex, j + 1);
                  currentIndex = j + 1;
                  return executeNext();
                }
                loopDepth--;
              }
            }
          }

          if (result && result.loopContinue === true) {
            var loopDepth2 = 0;
            for (var k = currentIndex + 1; k < orderedNodes.length; k++) {
              if (orderedNodes[k].type === 'loopStart') loopDepth2++;
              if (orderedNodes[k].type === 'loopEnd') {
                if (loopDepth2 === 0) {
                  // Continue bypasses the remaining body but still executes
                  // loopEnd, which advances or closes the current iteration.
                  markSkippedRange(currentIndex, k);
                  currentIndex = k;
                  return executeNext();
                }
                loopDepth2--;
              }
            }
          }

          if (node.type === 'loopEnd') {
            var endLoopId = node.params && node.params.loopId;
            var loopData = loopStack.find(function (l) { return l.loopId === endLoopId; });
            if (loopData) {
              var shouldBreak = false;
              if (loopData.maxIterations > 0 && loopData.index >= loopData.maxIterations - 1) {
                shouldBreak = true;
              }
              if (!shouldBreak && loopData.breakCondition) {
                var Template = globalThis.Template;
                var Expression = globalThis.Expression;
                var ctx = deps.getCtx ? deps.getCtx() : {};
                var condition = Template.interpolate(loopData.breakCondition, ctx);
                var evalResult = Expression.evalBool(condition);
                if (!evalResult.ok) {
                  addLog('循环跳出条件解析失败（按 false 处理）: ' + evalResult.error + ' — 表达式: ' + condition, { nodeId: node.nodeId, level: 'warn' });
                }
                if (evalResult.value) shouldBreak = true;
              }

              if (!shouldBreak) {
                for (var m = currentIndex - 1; m >= 0; m--) {
                  if (orderedNodes[m].type === 'loopStart' && orderedNodes[m].params.loopId === endLoopId) {
                    currentIndex = m;
                    return executeNext();
                  }
                }
              } else {
                var idx2 = loopStack.findIndex(function (l) { return l.loopId === endLoopId; });
                if (idx2 !== -1) loopStack.splice(idx2, 1);
              }
            }
          }

          currentIndex++;
          return executeNext();
        }, function (err) {
          if (fatalFailure && !isFatalFlowError(err)) err = fatalFailure;
          if (isStopError(err) || stopRequested) {
            // 用户已请求停止：不计失败、不截图、不重试
            setNodeStatus(node.nodeId, 'stopped');
            throw isStopError(err) ? err : new Error(STOP_ERROR_MESSAGE);
          }
          var cf = getCommonFields(node);
          setNodeStatus(node.nodeId, 'failed');
          addLog('节点失败: ' + node.title + ' — ' + getErrorMessage(err), { nodeId: node.nodeId, level: 'error' });
          var stepEntry = recordStep(node, 'failed', {
            startedAt: err.__startedAt || Date.now(),
            durationMs: err.__durationMs || 0,
            attempts: err.__attempts || 1,
            error: getErrorMessage(err),
          });

          if (isFatalFlowError(err)) throw err;

          var capture = Promise.resolve('');
          if (captureFailureScreenshot && node.pageId && screenshotCount < MAX_SCREENSHOTS_PER_ROUND) {
            screenshotCount++;
            capture = Promise.resolve().then(function () {
              return captureFailureScreenshot(node);
            }).catch(function () { return ''; });
          }

          return capture.then(function (dataUrl) {
            if (dataUrl) stepEntry.screenshot = dataUrl;
            if (cf.onFailure === 'continue' && !hasUncertainSideEffect(err)) {
              softFailures++;
              addLog('节点失败策略为「继续执行」，跳到下一节点', { nodeId: node.nodeId, level: 'warn' });
              currentIndex++;
              return executeNext();
            }
            if (cf.onFailure === 'continue') {
              addLog('节点可能已产生副作用，不能按「继续执行」吞掉失败', { nodeId: node.nodeId, level: 'error' });
            }
            throw err;
          });
        });
      }

      return executeNext();
    }

    // --- 主循环 ---

    function autoRunLoop(totalRuns, maxRetriesPerRound, retryDelayMs, roundIntervalMs, resumeFromNodeId, continueFrom) {
      totalRuns = totalRuns || 1;
      maxRetriesPerRound = maxRetriesPerRound || 0;
      retryDelayMs = retryDelayMs || 30000;
      roundIntervalMs = roundIntervalMs || 5000;

      var state = getState();
      var flowId = state.flowId;
      var containsNonReplayableNode = getOrderedNodes(flowId).some(function (node) {
        return !isNodeReplaySafe(node);
      });
      if (containsNonReplayableNode && maxRetriesPerRound > 0) {
        maxRetriesPerRound = 0;
        addLog('流程包含不能证明可安全重放的副作用节点，已禁用整轮自动重试', { level: 'warn' });
      }
      createAutoRunSessionId();
      clearStopRequest();

      var summaries = [];
      var sessionId = autoRunSessionId;

      function runRound(targetRun) {
        return new Promise(function (resolve, reject) {
          var attempt = 0;

          function runSequenceOnce(steps) {
            // 继续模式：从停止节点接续执行（上下文/循环栈已由外部恢复），仅首轮首次生效
            if (continueFrom && continueFrom.nodeId) {
              var cont = continueFrom;
              continueFrom = null;
              var contNodes = getOrderedNodes(flowId);
              var contExists = contNodes.some(function (n) { return n.nodeId === cont.nodeId; });
              if (!contExists) {
                addLog('继续目标节点不存在（流程可能已被编辑），本轮从头执行: ' + cont.nodeId, { level: 'warn' });
              } else {
                setNodeStatus(cont.nodeId, 'pending');
                var contDataset = [];
                try { contDataset = getFlowDataset(flowId) || []; } catch (_) {}
                var hasDataRow = contDataset.length && cont.dataIndex !== undefined && cont.dataIndex !== null && cont.dataIndex < contDataset.length;

                if (!hasDataRow) {
                  addLog('继续执行 — 从节点接续: ' + cont.nodeId + '（变量与循环状态已恢复）');
                  return runAutoSequence(flowId, { steps: steps, startNodeId: cont.nodeId }).then(function (r) {
                    return { softFailures: (r && r.softFailures) || 0, dataRows: null };
                  });
                }

                // 数据驱动继续：当前行从停止节点接续（ctx 已含 data/dataIndex），后续行正常
                addLog('继续执行 — 第 ' + (cont.dataIndex + 1) + '/' + contDataset.length + ' 组数据从节点接续: ' + cont.nodeId);
                var contRows = [];
                var contRowIndex = cont.dataIndex;
                function runContRows() {
                  if (contRowIndex >= contDataset.length) {
                    return Promise.resolve({
                      softFailures: contRows.filter(function (r) { return r.status === 'failed'; }).length,
                      dataRows: contRows,
                    });
                  }
                  throwIfStopped();
                  var cidx = contRowIndex++;
                  var isContinueRow = cidx === cont.dataIndex;
                  if (!isContinueRow) {
                    resetStateForNewRound(flowId);
                    var cctx = deps.getCtx ? deps.getCtx() : {};
                    cctx.data = contDataset[cidx];
                    cctx.dataIndex = cidx;
                    addLog('数据驱动 — 第 ' + (cidx + 1) + '/' + contDataset.length + ' 组数据: ' + JSON.stringify(contDataset[cidx]).slice(0, 200));
                  }
                  return runAutoSequence(flowId, { steps: steps, dataIndex: cidx, startNodeId: isContinueRow ? cont.nodeId : '' }).then(function (r) {
                    contRows.push({ index: cidx, status: (r && r.softFailures) ? 'failed' : 'success' });
                    return runContRows();
                  }).catch(function (err) {
                    if (fatalFailure && !isFatalFlowError(err)) err = fatalFailure;
                    if (isStopError(err)) throw err;
                    if (isFatalFlowError(err)) throw err;
                    if (err && err.retryable === false) throw err;
                    contRows.push({ index: cidx, status: 'failed', error: getErrorMessage(err) });
                    addLog('第 ' + (cidx + 1) + ' 组数据执行失败，继续下一组: ' + getErrorMessage(err), { level: 'warn' });
                    return runContRows();
                  });
                }
                return runContRows();
              }
            }

            // 恢复模式：从指定节点继续，不重置上下文、不走数据驱动
            if (resumeFromNodeId) {
              resetStateForResume(flowId, resumeFromNodeId);
              return runAutoSequence(flowId, { steps: steps }).then(function (r) {
                return { softFailures: (r && r.softFailures) || 0, dataRows: null };
              });
            }

            var dataset = [];
            try { dataset = getFlowDataset(flowId) || []; } catch (_) {}

            if (!dataset.length) {
              resetStateForNewRound(flowId);
              return runAutoSequence(flowId, { steps: steps }).then(function (r) {
                return { softFailures: (r && r.softFailures) || 0, dataRows: null };
              });
            }

            // 数据驱动：逐行执行整个序列，行失败不阻断后续行
            var dataRows = [];
            var rowIndex = 0;
            function runRows() {
              if (rowIndex >= dataset.length) {
                return Promise.resolve({
                  softFailures: dataRows.filter(function (r) { return r.status === 'failed'; }).length,
                  dataRows: dataRows,
                });
              }
              throwIfStopped();
              var idx = rowIndex++;
              resetStateForNewRound(flowId);
              var ctx = deps.getCtx ? deps.getCtx() : {};
              ctx.data = dataset[idx];
              ctx.dataIndex = idx;
              addLog('数据驱动 — 第 ' + (idx + 1) + '/' + dataset.length + ' 组数据: ' + JSON.stringify(dataset[idx]).slice(0, 200));
              return runAutoSequence(flowId, { steps: steps, dataIndex: idx }).then(function (r) {
                dataRows.push({ index: idx, status: (r && r.softFailures) ? 'failed' : 'success' });
                return runRows();
              }).catch(function (err) {
                if (fatalFailure && !isFatalFlowError(err)) err = fatalFailure;
                if (isStopError(err)) throw err;
                if (isFatalFlowError(err)) throw err;
                if (err && err.retryable === false) throw err;
                dataRows.push({ index: idx, status: 'failed', error: getErrorMessage(err) });
                addLog('第 ' + (idx + 1) + ' 组数据执行失败，继续下一组: ' + getErrorMessage(err), { level: 'warn' });
                return runRows();
              });
            }
            return runRows();
          }

          function tryAttempt() {
            attempt++;
            addLog('自动运行 — 第 ' + targetRun + ' 轮, 尝试 ' + attempt);

            var steps = [];

            return runSequenceOnce(steps).then(function (r) {
              var stepMeta = summarizeStepsMeta(steps);
              var hasFailure = (r.softFailures > 0) || ((stepMeta.counts && stepMeta.counts.failed) || 0) > 0;
              var summary = attachStepsMeta({
                run: targetRun,
                attempt: attempt,
                status: hasFailure ? 'failed' : 'success',
                steps: steps,
              }, steps);
              if (r.dataRows) summary.dataRows = r.dataRows;
              if (hasFailure) {
                summary.error = '存在失败步骤（失败策略为继续执行）';
                addLog('第 ' + targetRun + ' 轮执行完成，但存在失败步骤', { level: 'warn' });
              } else {
                addLog('第 ' + targetRun + ' 轮成功完成');
              }
              summaries.push(summary);
              resolve(summary);
            }).catch(function (err) {
              if (fatalFailure && !isFatalFlowError(err)) err = fatalFailure;
              if (isStopError(err) || stopRequested) {
                summaries.push(attachStepsMeta({ run: targetRun, attempt: attempt, status: 'stopped', steps: steps }, steps));
                addLog('第 ' + targetRun + ' 轮已停止');
                resolve({ run: targetRun, attempt: attempt, status: 'stopped' });
                return;
              }
              if (isFatalFlowError(err)) {
                summaries.push(attachStepsMeta({ run: targetRun, attempt: attempt, status: 'failed', error: getErrorMessage(err), steps: steps }, steps));
                addLog('当前 Flow 遇到不可重试错误，立即终止: ' + getErrorMessage(err), { level: 'error' });
                reject(err);
                return;
              }
              if (err && err.retryable === false) {
                var nonRetryableError = getErrorMessage(err);
                summaries.push(attachStepsMeta({ run: targetRun, attempt: attempt, status: 'failed', error: nonRetryableError, steps: steps }, steps));
                addLog('第 ' + targetRun + ' 轮遇到不可重试错误，停止整轮重放: ' + nonRetryableError, { level: 'error' });
                resolve({ run: targetRun, attempt: attempt, status: 'failed', error: nonRetryableError });
                return;
              }
              if (attempt <= maxRetriesPerRound) {
                addLog('第 ' + targetRun + ' 轮尝试 ' + attempt + ' 失败, ' + retryDelayMs + 'ms 后重试: ' + getErrorMessage(err));
                return sleepWithStop(retryDelayMs).then(function () {
                  if (stopRequested) {
                    summaries.push(attachStepsMeta({ run: targetRun, attempt: attempt, status: 'stopped', steps: steps }, steps));
                    resolve({ run: targetRun, attempt: attempt, status: 'stopped' });
                    return;
                  }
                  return tryAttempt();
                });
              }
              var finalError = getErrorMessage(err);
              summaries.push(attachStepsMeta({ run: targetRun, attempt: attempt, status: 'failed', error: finalError, steps: steps }, steps));
              addLog('第 ' + targetRun + ' 轮失败（已达最大重试）：' + finalError, { level: 'error' });
              resolve({ run: targetRun, attempt: attempt, status: 'failed', error: finalError });
            });
          }

          tryAttempt();
        });
      }

      function loop() {
        var currentRun = summaries.length + 1;
        if (currentRun > totalRuns) {
          addLog('自动运行完成 — 总轮次: ' + totalRuns + ', 成功: ' + summaries.filter(function (s) { return s.status === 'success'; }).length);
          broadcast({ type: 'AUTO_RUN_COMPLETE', payload: { summaries: summaries } });
          return Promise.resolve();
        }

        if (stopRequested) {
          broadcast({ type: 'AUTO_RUN_COMPLETE', payload: { summaries: summaries, stopped: true } });
          return Promise.resolve();
        }

        return runRound(currentRun).then(function () {
          if (stopRequested || currentRun >= totalRuns) {
            broadcast({ type: 'AUTO_RUN_COMPLETE', payload: { summaries: summaries, stopped: stopRequested } });
            return;
          }
          addLog('轮间等待 ' + roundIntervalMs + 'ms...');
          return sleepWithStop(roundIntervalMs).then(function () {
            return loop();
          });
        });
      }

      addLog('自动运行开始 — 总轮次: ' + totalRuns + ', 每轮最大重试: ' + maxRetriesPerRound);
      broadcast({ type: 'AUTO_RUN_START', payload: { totalRuns: totalRuns, sessionId: sessionId } });

      running = true;
      onRunStart({ sessionId: sessionId, flowId: flowId, startedAt: Date.now() });

      return loop().then(function () {
        running = false;
        onRunComplete({ sessionId: sessionId, flowId: flowId, summaries: summaries, stopped: stopRequested, totalRuns: totalRuns });
      }, function (err) {
        running = false;
        onRunComplete({ sessionId: sessionId, flowId: flowId, summaries: summaries, stopped: stopRequested, totalRuns: totalRuns, error: getErrorMessage(err) });
        throw err;
      });
    }

    function startAutoRunLoop(totalRuns, maxRetries, retryDelayMs, roundIntervalMs) {
      // 支持 options 对象调用方式
      var resumeFromNodeId = '';
      var continueFrom = null;
      if (typeof totalRuns === 'object') {
        var opts = totalRuns;
        totalRuns = opts.totalRuns;
        maxRetries = opts.maxRetries;
        retryDelayMs = opts.retryDelayMs;
        roundIntervalMs = opts.roundIntervalMs;
        resumeFromNodeId = opts.resumeFromNodeId || '';
        continueFrom = opts.continueFrom || null;
      }
      var state = getState();
      // 从 settings 中获取 autoRun 配置作为回退
      var autoRunSettings = (state._autoRunSettings) || {};
      return autoRunLoop(
        totalRuns || autoRunSettings.totalRuns || 1,
        maxRetries != null ? maxRetries : (autoRunSettings.maxRetriesPerRound || 0),
        retryDelayMs || autoRunSettings.retryDelayMs || 30000,
        roundIntervalMs || autoRunSettings.roundIntervalMs || 5000,
        resumeFromNodeId,
        continueFrom
      );
    }

    return {
      STOP_ERROR_MESSAGE: STOP_ERROR_MESSAGE,
      requestStop: requestStop,
      requestFailure: requestFailure,
      clearStopRequest: clearStopRequest,
      getStopRequested: getStopRequested,
      isRunning: isRunning,
      throwIfStopped: throwIfStopped,
      isStopError: isStopError,
      createAutoRunSessionId: createAutoRunSessionId,
      isCurrentAutoRunSession: isCurrentAutoRunSession,
      resetStateForNewRound: resetStateForNewRound,
      runAutoSequence: runAutoSequence,
      startAutoRunLoop: startAutoRunLoop,
    };
  }

  return { createAutoRunController: createAutoRunController };
});
