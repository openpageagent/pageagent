'use strict';

const fs = require('fs/promises');
const { constants } = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { LIMITS } = require('../shared/mcp-contract');

async function discoverBash() {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash']) {
      try {
        const executable = await fs.realpath(path.join(directory, name));
        if (!(await fs.stat(executable)).isFile()) continue;
        await fs.access(executable, constants.X_OK); return executable;
      } catch (_) {}
    }
  }
  return null;
}
const bytes = value => typeof value === 'bigint' ? (value >= 0n ? value.toString() : null)
  : Number.isFinite(value) && value >= 0 ? BigInt(Math.floor(value)).toString() : null;
class EnvironmentInfo {
  constructor(serverId, shell, onChange = () => {}) { this.serverId = serverId; this.shell = shell; this.onChange = onChange; this.base = null; this.revision = 0; this.cache = new Map(); this.inflight = new Map(); this.started = new Map(); this.invalidated = new WeakSet(); this.distributionRead = null; }
  readDistribution() {
    if (!this.distributionRead) this.distributionRead = (async () => {
      const handle = await fs.open('/etc/os-release', 'r');
      try {
        const buffer = Buffer.alloc(16385), result = await handle.read(buffer, 0, buffer.length, 0);
        if (result.bytesRead > 16384) throw new Error('OS_RELEASE_TOO_LARGE');
        const values = {};
        for (const line of buffer.subarray(0, result.bytesRead).toString('utf8').split('\n')) {
          const match = /^(ID|VERSION_ID|PRETTY_NAME)=(.*)$/.exec(line);
          if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').slice(0, 500);
        }
        return { id: values.ID || null, version: values.VERSION_ID || null, name: values.PRETTY_NAME || null };
      } finally { await handle.close(); }
    })().finally(() => { this.distributionRead = null; });
    return this.distributionRead;
  }
  async snapshot(bounded = false) {
    let failed = false;
    const query = fn => { try { return fn(); } catch (_) { failed = true; return null; } };
    let distribution = null;
    if (process.platform === 'linux') {
      let deadline;
      try {
        distribution = bounded ? await Promise.race([this.readDistribution(), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('SAMPLE_TIMEOUT')), LIMITS.sampleTimeoutMs);
        })]) : await this.readDistribution();
      } catch (_) { failed = true; } finally { clearTimeout(deadline); }
    }
    const snapshot = { schemaVersion: 1, revision: this.revision + 1, observedAt: new Date().toISOString(), stale: false, reason: null,
      os: { platform: process.platform, version: query(() => os.version()), kernelRelease: query(() => os.release()), distribution },
      runtime: { nodeVersion: process.version, arch: process.arch, pathStyle: process.platform === 'win32' ? 'win32' : 'posix' },
      shell: this.shell ? { kind: 'bash', executable: this.shell, version: null, environment: 'unknown' } : null,
      cpu: { logicalCount: query(() => os.cpus().length), availableParallelism: query(() => os.availableParallelism()) },
      memory: { totalBytes: query(() => bytes(os.totalmem())) },
      executor: { user: query(() => os.userInfo().username), uid: typeof process.geteuid === 'function' ? query(() => process.geteuid()) : null,
        gid: typeof process.getegid === 'function' ? query(() => process.getegid()) : null } };
    if (failed && this.base) { this.base = { ...this.base, stale: true, reason: 'SAMPLE_FAILED' }; return this.base; }
    if (failed) snapshot.reason = 'SAMPLE_FAILED';
    this.revision = snapshot.revision;
    this.base = snapshot; this.onChange(); return snapshot;
  }
  group(values, reason = null) {
    const now = Date.now();
    return { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + LIMITS.dynamicTtlMs).toISOString(),
      status: reason ? 'partial' : 'ok', reason, ...values };
  }
  sample(key, refresh, read) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const now = performance.now(); const cached = this.cache.get(key);
    if (!refresh && cached && cached.expires > now) return Promise.resolve(cached.value);
    if (now - (this.started.get(key) ?? -Infinity) < LIMITS.sampleIntervalMs) return Promise.reject(Object.assign(new Error('采样刷新过于频繁'), { code: 'RATE_LIMITED', reason: 'SAMPLE_RATE_LIMITED' }));
    this.started.set(key, now);
    for (const oldKey of this.started.keys()) {
      if (this.started.size <= 2048) break;
      if (oldKey !== key && !this.inflight.has(oldKey)) { this.started.delete(oldKey); this.cache.delete(oldKey); }
    }
    const promise = Promise.resolve().then(read).then(value => {
      if (!this.invalidated.has(promise)) this.cache.set(key, { value, expires: performance.now() + LIMITS.dynamicTtlMs }); return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise); return promise;
  }
  async server(refresh) {
    return this.sample('server', refresh, async () => {
      const environment = refresh || !this.base ? await this.snapshot() : this.base;
      const values = { freeBytes: null, processAvailableBytes: null, processConstraintBytes: null }; let failed = false;
      for (const [key, read] of Object.entries({ freeBytes: () => os.freemem(), processAvailableBytes: () => process.availableMemory(), processConstraintBytes: () => process.constrainedMemory() })) {
        try { const value = read(); values[key] = key === 'processConstraintBytes' && !value ? null : bytes(value); } catch (_) { failed = true; }
      }
      const memory = this.group(values, failed ? 'SAMPLE_FAILED' : null);
      if (Object.values(values).every(value => value === null)) { memory.status = 'unavailable'; memory.reason = 'SAMPLE_FAILED'; }
      return { environment, memory };
    });
  }
  async disk(workspace, grantRevision, refresh) {
    const values = await this.sample(JSON.stringify([this.serverId, workspace.resolvedPath]), refresh, async () => {
      const empty = { totalBytes: null, availableBytes: null, freeBytes: null, readOnly: null, quotaLimitBytes: null, quotaRemainingBytes: null };
      try {
        const stat = await fs.statfs(workspace.resolvedPath, { bigint: true });
        return this.group({ ...empty, totalBytes: bytes(stat.bsize * stat.blocks),
          availableBytes: bytes(stat.bsize * (stat.bavail < 0n ? 0n : stat.bavail)),
          freeBytes: bytes(stat.bsize * (stat.bfree < 0n ? 0n : stat.bfree)) }, 'CONSTRAINTS_NOT_DETECTED');
      } catch (_) { return { ...this.group(empty, 'SAMPLE_FAILED'), status: 'unavailable' }; }
    });
    return { disk: { ...values, workspaceId: workspace.id, resolvedPath: workspace.resolvedPath, grantRevision } };
  }
  invalidate(resolvedPath) { const key = JSON.stringify([this.serverId, resolvedPath]); this.cache.delete(key); if (this.inflight.has(key)) this.invalidated.add(this.inflight.get(key)); }
  unavailable(workspace, grantRevision) {
    const empty = this.group({}, 'SAMPLE_TIMEOUT'); empty.status = 'unavailable';
    return workspace ? { disk: { ...empty, workspaceId: workspace.id, resolvedPath: workspace.resolvedPath, grantRevision,
      totalBytes: null, availableBytes: null, freeBytes: null, readOnly: null, quotaLimitBytes: null, quotaRemainingBytes: null } }
      : { environment: { ...this.base, stale: true, reason: 'SAMPLE_TIMEOUT' }, memory: { ...empty,
        freeBytes: null, processAvailableBytes: null, processConstraintBytes: null } };
  }
}
module.exports = { EnvironmentInfo, discoverBash };
