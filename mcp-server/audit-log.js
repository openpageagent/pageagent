'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { acquireLock } = require('./state-lock');
const { LIMITS } = require('../shared/mcp-contract');

function unavailable() { return Object.assign(new Error('持久审计不可用'), { code: 'TEMPORARILY_UNAVAILABLE', reason: 'AUDIT_UNAVAILABLE' }); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
const EVENTS = new Set(['auth.succeeded', 'auth.denied', 'pairing.created', 'pairing.revoked', 'password.changed',
  'grants.changed', 'request.received', 'authorization.denied', 'execution.intent', 'execution.started', 'process.spawned',
  'cancel.requested', 'execution.finished', 'execution.unconfirmed', 'audit.recovered']);
const CONTEXT_FIELDS = ['transportSessionId', 'requestId', 'parentRequest', 'principal', 'caller', 'callerAssurance',
  'parentAssurance', 'workspaceId', 'resolvedPath', 'targetPath', 'operation', 'decision', 'ruleIds', 'policyRevision',
  'grantRevision', 'executor', 'execution', 'receipt', 'errorReason', 'parameters', 'claimedClientId'];

class AuditLog {
  constructor(directory, serverId, commandContent = 'plain', onStatus = () => {}) {
    if (!['hash', 'plain'].includes(commandContent)) throw new Error('INVALID_AUDIT_COMMAND_CONTENT');
    this.directory = path.join(directory, 'audit'); this.file = path.join(this.directory, 'audit.jsonl');
    this.serverId = serverId; this.commandContent = commandContent; this.onStatus = onStatus;
    this.available = false; this.queue = Promise.resolve(); this.pending = 0; this.bytes = 0;
    this.closed = false; this.lastRecovery = 0;
  }
  status(value) {
    if (this.available === value) return;
    this.available = value; this.onStatus(value);
  }
  async init(recoverUnfinished = true) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(this.directory, 0o700);
    const release = await acquireLock(path.join(this.directory, 'audit.lock'));
    try {
      await this.repairTailLocked();
      let content;
      try { content = await fs.readFile(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Recovery records unresolved execution intents without restarting any operation.
      const unfinished = new Map();
      const history = [];
      if (recoverUnfinished) {
        for (const name of await fs.readdir(this.directory)) {
          if (!/^audit-.*\.jsonl$/.test(name)) continue;
          const stat = await fs.stat(path.join(this.directory, name)); history.push({ name, time: stat.mtimeMs });
        }
        history.sort((a, b) => a.time - b.time); history.push({ name: 'audit.jsonl' });
      }
      for (const file of history) {
        const data = file.name === 'audit.jsonl' ? content || Buffer.alloc(0) : await fs.readFile(path.join(this.directory, file.name));
        for (const line of data.toString('utf8').split('\n')) {
          if (!line) continue;
          let record; try { record = JSON.parse(line); } catch (_) { continue; }
          const key = JSON.stringify([record.transportSessionId, record.requestId]);
          if (['execution.intent', 'execution.started'].includes(record.event) && record.requestId) unfinished.set(key, record);
          if (['execution.finished', 'execution.unconfirmed', 'grants.changed', 'password.changed', 'pairing.created', 'pairing.revoked'].includes(record.event)) unfinished.delete(key);
        }
      }
      for (const record of unfinished.values()) {
        await this.appendLocked(this.encode('execution.unconfirmed', {
          transportSessionId: record.transportSessionId, requestId: record.requestId, principal: record.principal,
          operation: record.operation, errorReason: 'PROCESS_RESTARTED', receipt: { performed: 'unknown' },
          execution: { outcome: 'unknown', startedAt: null, finishedAt: null, termination: 'unconfirmed' },
        }));
      }
    } finally { await release(); }
    await this.write('audit.recovered', {}, true); this.status(true);
    this.timer = setInterval(() => { this.recover().catch(() => {}); }, LIMITS.auditRecoverMs);
    this.timer.unref();
  }
  encode(event, context) {
    if (!EVENTS.has(event)) throw new Error('INVALID_AUDIT_EVENT');
    const record = { schemaVersion: 1, event, timestamp: new Date().toISOString(), serverId: this.serverId, processId: process.pid };
    for (const key of CONTEXT_FIELDS) {
      if (context[key] === undefined) continue;
      if (key === 'resolvedPath' || key === 'targetPath') {
        if (context[key] !== null) record[key + 'Sha256'] = digest(context[key]);
      } else record[key] = context[key];
    }
    const line = Buffer.from(JSON.stringify(record) + '\n');
    if (line.length > LIMITS.auditRecordBytes) throw unavailable();
    return line;
  }
  parameters(operation, input = {}, shell) {
    if (operation === 'bash') {
      const command = String(input.command || '');
      return { ...(this.commandContent === 'plain' ? { command } : {}),
        commandBytes: Buffer.byteLength(command), commandSha256: digest(command), shell, timeoutMs: input.timeoutMs };
    }
    const content = JSON.stringify(input);
    const result = { inputBytes: Buffer.byteLength(content), inputSha256: digest(content) };
    if (operation === 'write') result.bytes = Buffer.byteLength(String(input.content || ''));
    return result;
  }
  async repairTailLocked() {
    let active;
    try { active = await fs.open(this.file, 'r+'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const { size } = await active.stat();
      if (!size) return;
      const last = Buffer.alloc(1);
      if ((await active.read(last, 0, 1, size - 1)).bytesRead !== 1) throw unavailable();
      if (last[0] === 10) return;
      const start = Math.max(0, size - LIMITS.auditRecordBytes);
      const tail = Buffer.alloc(size - start);
      let offset = 0;
      while (offset < tail.length) {
        const result = await active.read(tail, offset, tail.length - offset, start + offset);
        if (!result.bytesRead) throw unavailable();
        offset += result.bytesRead;
      }
      const end = tail.lastIndexOf(10) + 1;
      if (!end && start) throw unavailable();
      const fragment = await fs.open(path.join(this.directory, 'fragment-' + Date.now() + '-' + randomUUID() + '.jsonl'), 'wx', 0o600);
      try { await fragment.writeFile(tail.subarray(end)); await fragment.sync(); } finally { await fragment.close(); }
      // Preserve the fragment's directory entry before removing it from the active file.
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await active.truncate(start + end); await active.sync();
    } finally { await active.close(); }
  }
  async appendLocked(line) {
    await this.repairTailLocked();
    const now = Date.now();
    let stat; try { stat = await fs.stat(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && stat.size && (stat.size + line.length > LIMITS.auditRotateBytes
      || new Date(stat.mtimeMs).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10))) {
      await fs.rename(this.file, path.join(this.directory, 'audit-' + new Date(stat.mtimeMs).toISOString().slice(0, 10) + '-' + randomUUID() + '.jsonl'));
      stat = null;
    }
    const closed = [];
    for (const name of await fs.readdir(this.directory)) {
      if (name !== 'audit.jsonl' && /^(audit-|fragment-).*\.jsonl$/.test(name)) {
        const item = await fs.stat(path.join(this.directory, name)); closed.push({ name, ...item });
      }
    }
    closed.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = closed.reduce((sum, item) => sum + item.size, (stat ? stat.size : 0) + line.length);
    for (const item of closed) {
      if (now - item.mtimeMs > LIMITS.auditRetainMs || total > LIMITS.auditTotalBytes) {
        await fs.unlink(path.join(this.directory, item.name)); total -= item.size;
      }
    }
    if (total > LIMITS.auditTotalBytes) throw unavailable();
    const handle = await fs.open(this.file, 'a', 0o600);
    try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    if (process.platform !== 'win32') {
      const directory = await fs.open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  write(event, context = {}, recovery = false) {
    if (this.closed || (!recovery && !this.available)) return Promise.reject(unavailable());
    let line; try { line = this.encode(event, context); } catch (error) { this.status(false); return Promise.reject(error); }
    if (this.pending >= LIMITS.auditQueueCount || this.bytes + line.length > LIMITS.auditQueueBytes) {
      this.status(false); return Promise.reject(unavailable());
    }
    this.pending++; this.bytes += line.length;
    let expired = false;
    const actual = this.queue.then(async () => {
      if (expired) throw unavailable();
      const release = await acquireLock(path.join(this.directory, 'audit.lock'), LIMITS.auditWaitMs);
      try { if (expired) throw unavailable(); await this.appendLocked(line); } finally { await release(); }
    }).finally(() => { this.pending--; this.bytes -= line.length; });
    // Keep the real write in the serialization chain even if the response deadline expires.
    this.queue = actual.catch(() => { this.status(false); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { expired = true; this.status(false); reject(unavailable()); }, LIMITS.auditWaitMs);
      actual.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); this.status(false); reject(error); });
    });
  }
  bestEffort(event, context) { return this.write(event, context).then(() => true, () => false); }
  async recover() {
    if (this.available || this.closed || this.pending || Date.now() - this.lastRecovery < LIMITS.auditRecoverMs) return;
    this.lastRecovery = Date.now(); await this.write('audit.recovered', {}, true); this.status(true);
  }
  async close() { clearInterval(this.timer); this.closed = true; await this.queue; }
}
module.exports = { AuditLog, unavailable };
