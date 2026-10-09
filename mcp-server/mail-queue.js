'use strict';

const settings = require('../settings/mail-settings');
const { sendMail } = require('./mail-sender');
const limits = settings.DELIVERY_LIMITS;

function queueError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

// One scheduler for all WebSocket clients of this server process.
function createMailQueue() {
  const waiting = [];
  const active = new Set();
  const accounts = new Set();
  let queuedBytes = 0;
  let closed = false;

  function detach(job) {
    clearTimeout(job.timer);
    if (job.signal) job.signal.removeEventListener('abort', job.onAbort);
    job.payload = null;
    job.state = 'done';
  }

  function removeWaiting(job) {
    const index = waiting.indexOf(job);
    if (index < 0) return;
    waiting.splice(index, 1);
    queuedBytes -= job.bytes;
  }

  function rejectWaiting(job, error) {
    removeWaiting(job);
    detach(job);
    job.reject(error);
  }

  function complete(job, error, result) {
    active.delete(job);
    accounts.delete(job.account);
    detach(job);
    if (error) job.reject(error);
    else job.resolve(result);
    drain();
  }

  function start(job) {
    clearTimeout(job.timer);
    job.state = 'active';
    active.add(job);
    accounts.add(job.account);
    const payload = job.payload;
    job.payload = null;
    Promise.resolve().then(() => sendMail(payload, { signal: job.controller.signal })).then(
      result => complete(job, null, result),
      error => complete(job, error)
    );
  }

  function drain() {
    while (!closed && active.size < limits.maxConcurrent) {
      // Preserve each account's FIFO order while other accounts use free slots.
      const job = waiting.find(entry => !accounts.has(entry.account));
      if (!job) return;
      if (Date.now() >= job.deadline) {
        rejectWaiting(job, queueError('邮件排队超过 60 秒，邮件尚未发送'));
        continue;
      }
      removeWaiting(job);
      start(job);
    }
  }

  function enqueue(payload, options = {}) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(queueError('邮件发送服务正在关闭，邮件尚未发送')); return; }
      if (options.signal && options.signal.aborted) { reject(queueError('邮件请求已取消，邮件尚未发送')); return; }
      let config;
      let bytes;
      try {
        config = settings.validate(payload && payload.config);
        payload = { config, message: payload && payload.message };
        bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        if (bytes > settings.MAX_REQUEST_BYTES) throw queueError('邮件请求超过 32MB，邮件尚未发送');
      } catch (error) {
        reject(queueError(error.message));
        return;
      }
      // Changing the port, TLS mode, host, or display sender must not bypass
      // serialization for the same login account. No password is part of this key.
      const account = (config.username || config.from).trim().toLowerCase();
      const canStart = active.size < limits.maxConcurrent && !accounts.has(account);
      if (!canStart && (waiting.length >= limits.maxQueued || queuedBytes + bytes > limits.maxQueuedBytes)) {
        reject(queueError('邮件等待队列已满（最多 32 封、请求内容合计 64MB），邮件尚未发送'));
        return;
      }
      const job = {
        payload, bytes, account, resolve, reject,
        state: 'queued', deadline: Date.now() + limits.queueWaitMs,
        signal: options.signal, controller: new AbortController(),
      };
      job.onAbort = () => {
        if (job.state === 'queued') {
          rejectWaiting(job, queueError('邮件排队已取消，邮件尚未发送'));
          drain();
        } else if (job.state === 'active') {
          // Hold the slot and account lock until SMTP cleanup has completed.
          job.controller.abort();
        }
      };
      if (job.signal) {
        job.signal.addEventListener('abort', job.onAbort, { once: true });
        if (job.signal.aborted) { job.onAbort(); return; }
      }
      if (canStart) {
        start(job);
      } else {
        waiting.push(job);
        queuedBytes += bytes;
        job.timer = setTimeout(() => {
          rejectWaiting(job, queueError('邮件排队超过 60 秒，邮件尚未发送'));
          drain();
        }, limits.queueWaitMs);
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const job of waiting.slice()) rejectWaiting(job, queueError('邮件发送服务已关闭，排队邮件尚未发送'));
    for (const job of active) job.controller.abort();
  }

  return Object.freeze({ enqueue, close });
}

module.exports = { createMailQueue };
