'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { LIMITS } = require('../shared/mcp-contract');
const processObservers = new WeakMap();
const childStops = new WeakMap();
const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
function terminationCapability() {
  return process.platform !== 'win32' ? 'posix-process-group' : fs.existsSync(taskkill) ? 'windows-taskkill-tree' : 'windows-child-only';
}
function stopChild(child) {
  if (!child || !Number.isSafeInteger(child.pid)) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve(true); }
    catch (_) { try { child.kill('SIGKILL'); } catch (_) {} return Promise.resolve(false); }
  }
  if (!fs.existsSync(taskkill)) { try { child.kill('SIGKILL'); } catch (_) {} return Promise.resolve(false); }
  return new Promise(resolve => {
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = success => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (!success) { try { child.kill('SIGKILL'); } catch (_) {} }
      resolve(success);
    };
    const timer = setTimeout(() => { try { killer.kill(); } catch (_) {} finish(false); }, 3000);
    killer.once('error', () => finish(false)); killer.once('close', code => finish(code === 0));
  });
}
function terminateChild(child, signal) {
  if (!child || !Number.isSafeInteger(child.pid)) return Promise.resolve(false);
  let pending = childStops.get(child);
  if (!pending) {
    pending = stopChild(child).catch(() => false);
    childStops.set(child, pending);
    const observer = processObservers.get(signal);
    if (observer) observer.stopping(pending);
  }
  return pending;
}
function observeChild(signal, child) {
  const observer = processObservers.get(signal);
  if (observer) child.once('spawn', () => observer.spawned(child.pid));
}
function checkSignal(signal) {
  if (signal && signal.aborted) throw Object.assign(new Error('执行已请求停止；已经产生的效果不会撤销'), { reason: signal.reason || 'user', code: 'OPERATION_TIMEOUT' });
}
function safeError(error) {
  const disk = { ENOSPC: 'DISK_FULL', EDQUOT: 'QUOTA_EXCEEDED', EROFS: 'FILESYSTEM_READ_ONLY' };
  return { code: disk[error.code] ? 'UPSTREAM_FAILED' : error.code && /^[A-Z_]+$/.test(error.code) ? error.code : 'UPSTREAM_FAILED',
    reason: disk[error.code] || error.reason || 'EXECUTION_FAILED', message: String(error.message || '操作失败').slice(0, 1000), retryable: false };
}

class ExecutionControl {
  constructor(audit) { this.audit = audit; this.active = new Map(); this.closed = false; }
  key(identity, requestId) { return JSON.stringify([identity.clientId, identity.transportSessionId, requestId]); }
  count(clientId) { return [...this.active.values()].filter(item => item.identity.clientId === clientId).length; }
  cancel(identity, requestId, reason, assurance = 'server_verified') {
    const item = this.active.get(this.key(identity, requestId));
    if (!item) return false;
    if (item.settled) return 'settled';
    if (!item.controller.signal.aborted) {
      item.stopReason = reason; item.stopReasonAssurance = assurance; item.controller.abort(reason);
      this.audit.bestEffort('cancel.requested', { ...item.context, parameters: undefined, errorReason: reason,
        execution: { stopReason: reason, stopReasonAssurance: assurance } });
      item.stopTimer = setTimeout(() => item.unconfirmed(), LIMITS.stopWaitMs);
    }
    return 'accepted';
  }
  cancelWhere(predicate, reason) { for (const item of this.active.values()) if (predicate(item)) this.cancel(item.identity, item.requestId, reason); }
  run({ identity, requestId, operation, workspaceId, timeoutMs, readOnly, context, validate, execute, timeoutResult }) {
    if (this.closed || this.active.size >= LIMITS.serverActive || this.count(identity.clientId) >= LIMITS.clientActive) {
      return Promise.reject(Object.assign(new Error('执行槽已满'), { code: 'RESOURCE_BUSY', reason: 'LOCAL_BUSY' }));
    }
    const key = this.key(identity, requestId);
    if (this.active.has(key)) return Promise.reject(Object.assign(new Error('请求已经登记'), { code: 'RESOURCE_CONFLICT', reason: 'DUPLICATE_REQUEST' }));
    const controller = new AbortController();
    const registered = performance.now();
    const item = { identity, requestId, operation, workspaceId, context, controller, stopReason: null, stopReasonAssurance: null, startedAt: null, stopTimer: null,
      stopAttempts: [], limitedTermination: false };
    this.active.set(key, item);
    return new Promise(resolve => {
      let responded = false, intentRecorded = false;
      const response = (outcome, result, error, recorded, finished = false) => {
        const started = !!item.startedAt;
        const receipt = { performed: readOnly || !started ? 'no' : outcome === 'succeeded' ? 'yes' : 'unknown' };
        return { ok: outcome === 'succeeded', ...(result !== undefined ? { result } : {}), ...(error ? { error: safeError(error) } : {}), receipt,
          execution: { outcome, startedAt: item.startedAt, finishedAt: started && finished ? new Date().toISOString() : null,
            durationMs: Math.max(0, Math.round(performance.now() - registered)), effectiveTimeoutMs: timeoutMs,
            termination: !started ? 'not_started' : finished ? 'settled' : 'unconfirmed', stopReason: item.stopReason, stopReasonAssurance: item.stopReasonAssurance,
            ...(item.stopAttempts.length ? { terminationScope: !finished ? 'unconfirmed' : item.limitedTermination ? 'direct-child-only'
              : process.platform === 'win32' ? 'process-tree' : 'process-group' } : {}) },
          audit: { recorded } };
      };
      const reply = value => { if (!responded) { responded = true; resolve(value); } };
      item.unconfirmed = () => {
        if (!this.active.has(key)) return;
        const value = response(item.startedAt ? 'unknown' : 'cancelled', undefined,
          { code: 'OPERATION_TIMEOUT', reason: 'RESULT_UNKNOWN', message: '未确认停止，请勿自动重试' }, false);
        this.audit.bestEffort('execution.unconfirmed', { ...context, parameters: undefined, execution: value.execution, receipt: value.receipt });
        reply(value);
      };
      const deadline = setTimeout(() => {
        this.cancel(identity, requestId, 'timeout');
        if (timeoutResult && item.startedAt) {
          Promise.resolve().then(timeoutResult).then(async result => {
            const value = response('unknown', result, null, false);
            value.audit.recorded = await this.audit.bestEffort('execution.unconfirmed', { ...context, parameters: undefined, execution: value.execution, receipt: value.receipt, errorReason: 'SAMPLE_TIMEOUT' });
            value.ok = true; reply(value);
          }).catch(error => { reply(response('rejected', undefined, error, false)); });
        }
      }, timeoutMs);
      processObservers.set(controller.signal, {
        spawned: pid => { context.executor = { ...context.executor, pid }; },
        stopping: pending => item.stopAttempts.push(pending.then(success => { if (!success) item.limitedTermination = true; })),
      });
      (async () => {
        let result, failure, outcome;
        try {
          await validate(controller.signal); checkSignal(controller.signal);
          await this.audit.write('execution.intent', context);
          intentRecorded = true;
          await validate(controller.signal); checkSignal(controller.signal);
          if (performance.now() - registered >= timeoutMs) { this.cancel(identity, requestId, 'timeout'); checkSignal(controller.signal); }
          item.startedAt = new Date().toISOString();
          result = await execute(controller.signal);
          if (result && result.cancelled === true) checkSignal(controller.signal);
          if (operation === 'bash' && result.exitCode !== 0) throw Object.assign(new Error('Bash 返回非零退出状态'), { code: 'UPSTREAM_FAILED', reason: 'COMMAND_EXIT_NONZERO' });
          outcome = 'succeeded';
        } catch (error) {
          failure = error;
          if (!item.startedAt && !controller.signal.aborted) {
            context.decision = 'deny'; context.ruleIds = error.ruleIds || context.ruleIds || ['request.valid'];
          }
          if (controller.signal.aborted) outcome = item.stopReason === 'timeout' ? 'timed_out' : 'cancelled';
          else outcome = item.startedAt ? 'failed' : 'rejected';
          if (error.result !== undefined) result = error.result;
        }
        // Child close confirms its exit and drained pipes; retain the separately
        // observed group/tree stop result before reporting the termination scope.
        clearTimeout(deadline);
        await Promise.all(item.stopAttempts);
        item.settled = true;
        clearTimeout(item.stopTimer);
        const value = response(outcome, result, failure, false, true);
        value.audit.recorded = await this.audit.bestEffort('execution.finished', { ...context,
          parameters: intentRecorded ? undefined : context.parameters,
          execution: value.execution, receipt: value.receipt, errorReason: value.error ? value.error.reason : null });
        clearTimeout(deadline); clearTimeout(item.stopTimer); processObservers.delete(controller.signal);
        this.active.delete(key); reply(value);
      })().catch(() => {
        // A bookkeeping failure must not report an unverified execution as stopped.
        item.unconfirmed();
      });
    });
  }
  async close() {
    this.closed = true; this.cancelWhere(() => true, 'shutdown');
    const deadline = performance.now() + LIMITS.stopWaitMs;
    while (this.active.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return this.active.size === 0;
  }
}
module.exports = { ExecutionControl, terminateChild, observeChild, terminationCapability, checkSignal, safeError };
