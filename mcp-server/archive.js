'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const arp = require('../resources/protocol');
const contract = require('../shared/mcp-contract');
const { version: SERVER_VERSION } = require('./package.json');
const { atomicJson } = require('./state-lock');

function fail(message, code = 'RESOURCE_CONFLICT') { throw arp.arpError(code, message); }
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
      || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('Invalid archive identifier', 'INVALID_REQUEST');
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Invalid configuration property', 'INVALID_REQUEST');
    out[key] = stable(value[key]);
  }
  return out;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function initiator(context) {
  const identity = context.sourceIdentity;
  if (identity) return { transport: 'websocket', id: identity.clientId, clientId: identity.clientId, pairingId: identity.pairingId };
  return context.actorId === 'http:operator' ? { transport: 'http', id: 'http:operator' }
    : { transport: 'system', id: 'archive' };
}

class Archive {
  constructor(server) {
    this.server = server;
    this.directory = path.join(server.auth.directory, 'archive');
    this.file = path.join(this.directory, 'index.json');
    this.queue = Promise.resolve(); this.running = new Map(); this.discovering = new Set(); this.discoveryWork = new Set();
    this.closed = false;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { version: 1, buckets: {}, clients: {}, operations: {} };
    }
    if (this.state.version !== 1 || !this.state.buckets || !this.state.clients || !this.state.operations) throw new Error('Invalid archive index');
    for (const client of Object.values(this.state.clients)) {
      Object.assign(client, this.policy(client, this.state.buckets[client.bucketId]));
      delete client.lastSeenAt;
      delete client.appliedVersionId;
    }
    for (const bucket of Object.values(this.state.buckets)) {
      for (const version of bucket.versions) {
        if (version.syncable === undefined) version.syncable = version.id === bucket.defaultVersionId;
      }
      delete bucket.defaultVersionId;
      delete bucket.backupIntervalMinutes;
      delete bucket.retainCount;
    }
    for (const operation of Object.values(this.state.operations)) {
      if (operation.status === 'running' || operation.status === 'pending') operation.status = 'interrupted';
    }
    await atomicJson(this.file, this.state);
    this.timer = setInterval(() => this.tick().catch(error => console.error('Archive backup: ' + error.message)), 60000);
    this.timer.unref();
  }
  mutate(change) {
    const pending = this.queue.then(async () => {
      const next = copy(this.state), result = await change(next);
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        await atomicJson(this.file, next); this.state = next;
      }
      return result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  bucket(bucketId) {
    const bucket = Object.hasOwn(this.state.buckets, id(bucketId)) && this.state.buckets[bucketId];
    if (!bucket) fail('备份桶不存在: ' + bucketId, 'RESOURCE_NOT_FOUND');
    return bucket;
  }
  async visibleBucket(bucketId, context) {
    const bucket = this.bucket(bucketId);
    if (!context.sourceIdentity) return bucket;
    const client = this.state.clients[context.sourceIdentity.clientId];
    if (!client || client.bucketId !== bucket.id) fail('当前客户端未选择此备份桶', 'FORBIDDEN');
    return bucket;
  }
  publicBucket(bucket) {
    return { id: bucket.id, name: bucket.name,
      revision: bucket.revision, versionCount: bucket.versions.length };
  }
  async list(context) {
    if (context.sourceIdentity) await this.connected(context.sourceIdentity.clientId, false);
    const clientId = context.sourceIdentity && context.sourceIdentity.clientId;
    const client = clientId && this.state.clients[clientId];
    return { buckets: Object.values(this.state.buckets).filter(bucket => !clientId || client && client.bucketId === bucket.id).map(bucket => this.publicBucket(bucket)),
      clients: Object.values(this.state.clients).filter(item => !clientId || item.id === clientId),
      operations: Object.values(this.state.operations).filter(item => !clientId || item.clientId === clientId)
        .sort((a, b) => Number(b.clientId === clientId) - Number(a.clientId === clientId) || b.createdAt - a.createdAt).slice(0, 50) };
  }
  async createBucket(body, context) {
    const bucketId = id(body.id);
    const name = String(body.name || bucketId).trim();
    if (!name || name.length > 200) fail('备份桶显示名称无效', 'INVALID_REQUEST');
    return this.mutate(state => {
      if (state.buckets[bucketId]) fail('备份桶已存在');
      const bucket = { id: bucketId, name, revision: 1, nextVersion: 1, versions: [] };
      state.buckets[bucketId] = bucket;
      return this.publicBucket(bucket);
    });
  }
  policy(binding, previous = {}) {
    const backupIntervalMinutes = binding.backupIntervalMinutes ?? previous.backupIntervalMinutes ?? 60;
    const retainCount = binding.retainCount ?? previous.retainCount ?? 20;
    // Zero is retained only for older policies that disabled scheduled backups.
    if (!Number.isInteger(backupIntervalMinutes) || backupIntervalMinutes < 0 || backupIntervalMinutes > 525600) fail('备份周期必须为 0 至 525600 分钟', 'INVALID_REQUEST');
    if (!Number.isInteger(retainCount) || retainCount < 1 || retainCount > 1000) fail('备份保留数量必须为 1 至 1000', 'INVALID_REQUEST');
    return { backupIntervalMinutes, retainCount };
  }
  async versions(bucketId, context) {
    const bucket = await this.visibleBucket(bucketId, context);
    return { items: copy(bucket.versions).reverse() };
  }
  async updateVersion(bucketId, versionId, patch, expected, context) {
    await this.visibleBucket(bucketId, context); id(versionId);
    if (typeof patch.syncable !== 'boolean') fail('可同步标记必须为布尔值', 'INVALID_REQUEST');
    return this.mutate(state => {
      const bucket = state.buckets[bucketId];
      if (expected !== '"bucket-' + bucket.revision + '"') fail('备份版本已变化，请刷新后重试', 'PRECONDITION_FAILED');
      const version = bucket.versions.find(item => item.id === versionId);
      if (!version) fail('配置版本不存在', 'RESOURCE_NOT_FOUND');
      version.syncable = patch.syncable; bucket.revision++;
      return copy(version);
    });
  }
  async version(bucketId, versionId) {
    const bucket = this.bucket(bucketId);
    const metadata = bucket.versions.find(item => item.id === id(versionId));
    if (!metadata) fail('配置版本不存在', 'RESOURCE_NOT_FOUND');
    const backup = JSON.parse(await fs.readFile(path.join(this.directory, bucketId, versionId + '.json'), 'utf8'));
    if (digest(backup) !== metadata.checksum) fail('备份版本校验失败');
    return { metadata: copy(metadata), backup };
  }
  async rpc(clientId, method, uri, body, operationId) {
    const sessionId = operationId || randomUUID();
    // The persisted operation ID handles restoration retries across worker/server
    // restarts. A new transport key avoids replaying a previous failed response.
    const request = { uri, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }) };
    const envelope = await this.server.forwardArp(clientId, method, request, 180000, {
      systemTask: true, context: { sessionId, conversationId: sessionId },
    });
    if (!envelope || envelope.status.code >= 400 || !envelope.primary) {
      const error = envelope && envelope.error;
      throw Object.assign(new Error(error && error.message || '配置 ARP 响应无效'), { code: error && error.code, reason: error && error.details && error.details.reason });
    }
    return envelope.primary.data;
  }
  connected(clientId, resume = true) {
    const work = this.discover(clientId, resume).finally(() => this.discoveryWork.delete(work));
    this.discoveryWork.add(work);
    return work;
  }
  compatible(deployment) {
    return deployment.compatibility && deployment.compatibility.compatible === true
      && !contract.configurationCompatibility({ ...contract.CONFIGURATION, version: SERVER_VERSION }, deployment.protocol);
  }
  canApply(deployment, operationId, versionId) {
    return this.compatible(deployment) && (deployment.autoSync && deployment.autoSyncEnabled && !!deployment.syncVersion
      && (!versionId || versionId === deployment.syncVersion)
      || !!operationId && deployment.manualOperationId === operationId);
  }
  async discover(clientId, resume) {
    if (this.closed || this.discovering.has(clientId)) return;
    this.discovering.add(clientId);
    try {
      let deployment;
      for (let attempt = 0; attempt < 5 && !this.closed; attempt++) {
        try { deployment = await this.rpc(clientId, 'GET', '/config/deployment'); break; }
        catch (error) {
          if (['FORBIDDEN', 'RESOURCE_NOT_FOUND'].includes(error.code)) {
            if (this.state.clients[clientId]) await this.mutate(state => { delete state.clients[clientId]; });
            return;
          }
          if (attempt === 4 || !['CONNECTION_NOT_READY', 'TEMPORARILY_UNAVAILABLE'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (!deployment || !deployment.enabled || !deployment.binding || this.closed) return;
      if (!this.compatible(deployment)) return;
      const bucketId = id(deployment.binding.bucketId); contract.id(deployment.bootId);
      const record = this.server.resolveExtensionClient({ clientId });
      if (!Object.hasOwn(this.state.buckets, bucketId)) {
        try { await this.createBucket({ id: bucketId }, {}); }
        catch (error) { if (error.code !== 'RESOURCE_CONFLICT' || !Object.hasOwn(this.state.buckets, bucketId)) throw error; }
      }
      const previous = this.state.clients[clientId];
      let pending = Object.values(this.state.operations).find(item => item.clientId === clientId && item.bucketId === bucketId
        && item.status === 'interrupted' && (item.kind === 'apply' ? this.canApply(deployment, item.id, item.versionId) : item.reason !== 'scheduled' || deployment.backupEnabled));
      if (deployment.recoveryPending && deployment.operation) {
        const recovery = this.state.operations[deployment.operation.id];
        if (!recovery || recovery.clientId !== clientId || recovery.bucketId !== bucketId || recovery.kind !== 'apply') fail('找不到待恢复的配置操作: ' + deployment.operation.id);
        pending = recovery;
      }
      await this.mutate(state => {
        const current = state.clients[clientId];
        const sameBucket = current && current.bucketId === bucketId ? current : undefined;
        state.clients[clientId] = { ...sameBucket, id: clientId, bucketId,
          autoSync: deployment.autoSync === true, backupEnabled: deployment.backupEnabled === true,
          ...this.policy(deployment.binding, sameBucket),
          name: record.clientInfo.clientName, bootId: deployment.bootId };
      });
      if (pending) {
        if (resume && (pending.kind !== 'apply' || this.canApply(deployment, pending.id, pending.versionId))) this.launch(pending.id);
        return;
      }
      // Reading status registers the client without starting a synchronization.
      if (!resume || !this.canApply(deployment)) return;
      if (previous && previous.lastBootId === deployment.bootId || deployment.startupCompleted) return;
      await this.createOperation({ kind: 'apply', clientId, versionId: deployment.syncVersion, reason: 'startup' }, {});
      await this.mutate(state => { state.clients[clientId].lastBootId = deployment.bootId; });
    } finally { this.discovering.delete(clientId); }
  }
  async createOperation(body, context) {
    if (this.closed) fail('服务端正在停止', 'TEMPORARILY_UNAVAILABLE');
    const ownId = context.sourceIdentity && context.sourceIdentity.clientId;
    const clientId = body.clientId || ownId;
    contract.id(clientId);
    if (ownId && clientId !== ownId) fail('只能操作当前客户端', 'FORBIDDEN');
    this.server.resolveExtensionClient({ clientId });
    if (!['backup', 'apply'].includes(body.kind)) fail('无效的配置操作', 'INVALID_REQUEST');
    const deployment = await this.rpc(clientId, 'GET', '/config/deployment');
    const bucketId = deployment.binding && deployment.binding.bucketId;
    if (!deployment.enabled || !bucketId) fail('此连接尚未配置同步和备份', 'FORBIDDEN');
    if (!this.compatible(deployment)) fail('Sync protocol or application version is incompatible', 'VERSION_INCOMPATIBLE');
    const versionId = body.versionId || deployment.syncVersion;
    if (body.kind === 'apply') id(versionId);
    if (body.kind === 'apply' && !this.canApply(deployment, body.operationId, versionId)) fail('此连接未获得指定版本的同步授权', 'FORBIDDEN');
    if (body.reason === 'scheduled' && !deployment.backupEnabled) fail('此连接未开启自动备份', 'FORBIDDEN');
    if (body.operationId !== undefined) contract.id(body.operationId);
    if (deployment.recoveryPending) fail('上次配置应用未完成，请重试原操作: ' + (deployment.operation && deployment.operation.id || ''), 'RESOURCE_BUSY');
    this.bucket(bucketId);
    const operation = await this.mutate(state => {
      const bucket = state.buckets[bucketId];
      if (Object.values(state.operations).some(item => item.clientId === clientId && item.bucketId === bucketId
          && ['pending', 'running', 'interrupted'].includes(item.status))) fail('此客户端已有配置操作，请等待或恢复该操作', 'RESOURCE_BUSY');
      const previous = state.clients[clientId];
      const sameBucket = previous && previous.bucketId === bucketId ? previous : undefined;
      state.clients[clientId] = { ...sameBucket, id: clientId, bucketId,
        autoSync: deployment.autoSync, backupEnabled: deployment.backupEnabled, bootId: deployment.bootId,
        ...this.policy(deployment.binding, sameBucket) };
      const operation = { id: body.operationId || randomUUID(), kind: body.kind, reason: body.reason || 'manual', clientId, bucketId: bucket.id,
        versionId: body.kind === 'apply' ? versionId : null, bootId: deployment.bootId, status: 'pending', createdAt: Date.now(),
        initiator: initiator(context) };
      if (state.operations[operation.id]) fail('操作 ID 已存在', 'RESOURCE_CONFLICT');
      state.operations[operation.id] = operation;
      if (body.kind === 'backup') state.clients[clientId].lastBackupAttemptAt = operation.createdAt;
      const finished = Object.values(state.operations).filter(item => ['complete', 'failed'].includes(item.status)).sort((a, b) => b.createdAt - a.createdAt);
      // An offline plugin may have persisted a partial apply before its reply
      // was lost. Keep each client's latest failed apply available for recovery.
      const recoveryIds = new Set(), seenClients = new Set();
      finished.filter(item => item.kind === 'apply').forEach(item => {
        if (!seenClients.has(item.clientId) && item.status === 'failed') recoveryIds.add(item.id);
        seenClients.add(item.clientId);
      });
      finished.slice(100).forEach(item => { if (!recoveryIds.has(item.id)) delete state.operations[item.id]; });
      return copy(operation);
    });
    this.launch(operation.id);
    return operation;
  }
  async getOperation(operationId, context) {
    contract.id(operationId);
    const operation = this.state.operations[operationId];
    if (!operation) fail('配置操作不存在', 'RESOURCE_NOT_FOUND');
    if (context.sourceIdentity && operation.clientId !== context.sourceIdentity.clientId) fail('无权读取此配置操作', 'FORBIDDEN');
    return copy(operation);
  }
  async retryOperation(operationId, context) {
    const operation = await this.getOperation(operationId, context);
    if (!['interrupted', 'failed'].includes(operation.status)) fail('只有中断或失败的操作可以重试');
    this.server.resolveExtensionClient({ clientId: operation.clientId });
    await this.authorizeOperation({ ...operation, reason: 'manual' });
    await this.mutate(state => {
      if (Object.values(state.operations).some(item => item.clientId === operation.clientId && item.bucketId === operation.bucketId && item.id !== operationId
          && ['pending', 'running', 'interrupted'].includes(item.status))) fail('此客户端已有配置操作', 'RESOURCE_BUSY');
      state.operations[operationId].status = 'pending';
      state.operations[operationId].reason = 'manual';
      state.operations[operationId].initiator = initiator(context);
    });
    this.launch(operationId);
    return this.getOperation(operationId, context);
  }
  async backup(operation, reason) {
    const captured = await this.rpc(operation.clientId, 'GET', '/config/backup');
    const checksum = digest(captured.backup);
    if (checksum !== captured.fingerprint) fail('备份校验失败');
    if (Buffer.byteLength(JSON.stringify(captured.backup)) > 1024 * 1024) fail('备份超过 1 MiB', 'PAYLOAD_TOO_LARGE');
    const bucket = this.bucket(operation.bucketId);
    const previous = [...bucket.versions].reverse().find(item => item.sourceClientId === operation.clientId && item.checksum === checksum);
    if (previous) {
      await this.mutate(state => { if (state.clients[operation.clientId]) state.clients[operation.clientId].lastBackupAt = Date.now(); });
      return { versionId: previous.id, fingerprint: checksum };
    }
    const versionId = await this.mutate(state => {
      const bucket = state.buckets[operation.bucketId];
      return 'v' + String(bucket.nextVersion++).padStart(6, '0');
    });
    const directory = path.join(this.directory, operation.bucketId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(directory, versionId + '.json'), captured.backup);
    await this.mutate(state => {
      state.buckets[operation.bucketId].versions.push({ id: versionId, sourceClientId: operation.clientId, createdAt: Date.now(), checksum,
        reason, syncable: false, formatVersion: 7, extensionVersion: captured.backup.extensionVersion });
      if (state.clients[operation.clientId]) state.clients[operation.clientId].lastBackupAt = Date.now();
    });
    return { versionId, fingerprint: checksum };
  }
  launch(operationId) {
    if (this.closed || this.running.has(operationId)) return;
    const work = this.run(operationId).catch(error => console.error('Archive operation: ' + error.message))
      .finally(() => this.running.delete(operationId));
    this.running.set(operationId, work);
  }
  async authorizeOperation(operation) {
    const deployment = await this.rpc(operation.clientId, 'GET', '/config/deployment');
    if (!deployment.enabled || !this.compatible(deployment) || !deployment.binding || deployment.binding.bucketId !== operation.bucketId
        || (operation.kind === 'apply' ? !this.canApply(deployment, operation.id, operation.versionId) : operation.reason === 'scheduled' && !deployment.backupEnabled)) {
      fail('同步源或备份目标已变更，此操作不再允许执行', 'FORBIDDEN');
    }
    if (operation.kind === 'apply' && !this.bucket(operation.bucketId).versions.some(item => item.id === operation.versionId && item.syncable)) {
      fail('指定版本不存在或未标记为可同步: ' + operation.versionId, 'RESOURCE_CONFLICT');
    }
    return deployment;
  }
  async run(operationId) {
    const operation = copy(this.state.operations[operationId]);
    const auditContext = { transportSessionId: operation.id, requestId: randomUUID(), principal: operation.initiator || null,
      operation: 'archive.' + operation.kind, parameters: { operationId: operation.id, reason: operation.reason,
        targetClientId: operation.clientId, bucketId: operation.bucketId, versionId: operation.versionId } };
    let startedAt = null, status = 'failed', errorCode = null;
    await this.mutate(state => {
      state.operations[operationId].status = 'running';
      delete state.operations[operationId].error; delete state.operations[operationId].errorCode; delete state.operations[operationId].completedAt;
      delete state.operations[operationId].audit;
    });
    try {
      await this.authorizeOperation(operation);
      const target = operation.kind === 'apply' ? await this.version(operation.bucketId, operation.versionId) : null;
      auditContext.parameters.targetPairingId = this.server.resolveExtensionClient({ clientId: operation.clientId }).identity.pairingId;
      if (target) auditContext.parameters.sourceClientId = target.metadata.sourceClientId;
      await this.server.audit.write('execution.intent', auditContext);
      startedAt = new Date().toISOString();
      if (!operation.backupVersionId) {
        const backup = await this.backup(operation, operation.kind === 'apply' ? 'before-apply' : operation.reason);
        operation.backupVersionId = backup.versionId; operation.expectedFingerprint = backup.fingerprint;
        await this.mutate(state => { Object.assign(state.operations[operationId], { backupVersionId: backup.versionId, expectedFingerprint: backup.fingerprint }); });
      }
      if (target) {
        await this.rpc(operation.clientId, 'POST', '/config/restorations', {
          operationId, versionId: operation.versionId, bucketId: operation.bucketId,
          expectedFingerprint: operation.expectedFingerprint, backup: target.backup, bootId: operation.bootId,
        }, operationId);
      }
      await this.mutate(state => {
        Object.assign(state.operations[operationId], { status: 'complete', completedAt: Date.now() });
      });
      status = 'complete';
    } catch (error) {
      const interrupted = this.closed || ['UPSTREAM_FAILED', 'CONNECTION_NOT_READY', 'TEMPORARILY_UNAVAILABLE'].includes(error.code)
        || ['CONNECTION_NOT_READY', 'RESULT_UNKNOWN'].includes(error.reason);
      status = interrupted ? 'interrupted' : 'failed'; errorCode = error.code || 'OPERATION_FAILED';
      await this.mutate(state => {
        Object.assign(state.operations[operationId], { status, error: error.message, errorCode, completedAt: Date.now() });
      });
      return;
    } finally {
      const unknown = status === 'interrupted';
      const recorded = await this.server.audit.bestEffort(unknown ? 'execution.unconfirmed' : 'execution.finished', {
        ...auditContext, parameters: { ...auditContext.parameters, backupVersionId: operation.backupVersionId || null },
        execution: { outcome: status === 'complete' ? 'succeeded' : unknown ? 'unknown' : startedAt ? 'failed' : 'rejected',
          startedAt, finishedAt: unknown ? null : new Date().toISOString() },
        receipt: { performed: !startedAt ? 'no' : status === 'complete' ? 'yes' : 'unknown' }, errorReason: errorCode,
      });
      await this.mutate(state => { if (state.operations[operationId]) state.operations[operationId].audit = { recorded }; });
    }
    await this.prune(operation.bucketId);
    if (operation.kind === 'apply' && this.state.clients[operation.clientId]
        && operation.bootId !== this.state.clients[operation.clientId].bootId) await this.connected(operation.clientId);
  }
  async prune(bucketId) {
    const removed = await this.mutate(state => {
      const bucket = state.buckets[bucketId], protectedIds = new Set(bucket.versions.filter(item => item.syncable).map(item => item.id));
      Object.values(state.operations).filter(item => item.bucketId === bucketId && item.status !== 'complete').forEach(item => {
        protectedIds.add(item.versionId); protectedIds.add(item.backupVersionId);
      });
      const counts = {}, removed = [];
      bucket.versions = [...bucket.versions].reverse().filter(item => {
        counts[item.sourceClientId] = (counts[item.sourceClientId] || 0) + 1;
        const client = state.clients[item.sourceClientId];
        if (!client || client.bucketId !== bucketId || protectedIds.has(item.id) || counts[item.sourceClientId] <= client.retainCount) return true;
        removed.push(item.id); return false;
      }).reverse();
      return removed;
    });
    for (const versionId of removed) await fs.unlink(path.join(this.directory, bucketId, versionId + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async tick() {
    if (this.closed) return;
    for (const client of Object.values(this.state.clients)) {
      const record = this.server.clients.get(client.id);
      if (!record || record.state !== 'ready') continue;
      // Refresh roles so saving a new backup target takes effect without reconnecting.
      try { await this.connected(client.id, false); }
      catch (error) { console.error('Archive discovery: ' + error.message); continue; }
      const current = this.state.clients[client.id];
      if (!current || !current.backupEnabled) continue;
      const interval = current.backupIntervalMinutes;
      if (!interval || Date.now() - Math.max(current.lastBackupAt || 0, current.lastBackupAttemptAt || 0) < interval * 60000) continue;
      try { await this.createOperation({ kind: 'backup', clientId: client.id, reason: 'scheduled' }, {}); }
      catch (error) { if (error.code !== 'RESOURCE_BUSY') console.error('Archive backup: ' + error.message); }
    }
  }
  close() { this.closed = true; clearInterval(this.timer); }
  async drain() { await Promise.allSettled([...this.discoveryWork, ...this.running.values()]); await this.queue; }
}

module.exports = { Archive };
