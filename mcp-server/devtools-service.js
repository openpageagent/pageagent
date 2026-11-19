'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const arp = require('../resources/protocol');
const { atomicJson } = require('./state-lock');
const catalog = require('../shared/devtools-catalog');
const { postgres, readLegacyPostgres } = require('./postgres-service');
const handlers = { ...require('./devtools-http'), ...require('./devtools-native'), ...require('./devtools-mysql'), postgres };
const { object, text } = catalog;
const SAVE = object({ revision: { type: 'integer', minimum: 0 }, id: text(100), kind: { enum: catalog.kinds.map(kind => kind.id) },
  name: text(100), enabled: { type: 'boolean' }, allowWrites: { type: 'boolean' },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }, config: { type: 'object' },
  authorizedClientIds: { type: 'array', maxItems: 100, uniqueItems: true, items: text(200) },
  clearSecrets: { type: 'array', maxItems: 10, uniqueItems: true, items: text(100) },
}, ['revision', 'kind', 'name', 'enabled', 'allowWrites', 'timeoutMs', 'config', 'authorizedClientIds']);
const REMOVE = object({ revision: { type: 'integer', minimum: 0 }, id: text(100) }, ['revision', 'id']);
const TEST = object(Object.fromEntries(['revision', 'id', 'kind', 'timeoutMs', 'config', 'clearSecrets']
  .map(key => [key, SAVE.properties[key]])), ['revision', 'kind', 'timeoutMs', 'config']);
const fail = (code, message, performed = 'no') => { throw arp.arpError(code, message, { performed }); };
function kindOf(id) {
  const kind = catalog.kinds.find(item => item.id === id);
  if (!kind) fail('INVALID_REQUEST', '不支持的研发工具类型');
  return kind;
}
function configSchema(kind) {
  return object(Object.fromEntries(kind.fields.map(field => [field.key, field.type === 'checkbox' ? { type: 'boolean' }
    : field.type === 'number' ? { type: 'integer', minimum: field.min, maximum: field.max }
      : field.type === 'select' ? { enum: field.choices.map(item => item[0]) } : { type: 'string', maxLength: field.maxLength }])), []);
}
function validateConfig(kind, config, enabled) {
  if (!arp.validateJsonSchema(configSchema(kind), config).valid) fail('INVALID_REQUEST', '连接配置包含不支持的字段或无效值');
  for (const field of kind.fields) {
    const value = config[field.key];
    if (enabled && field.required && (typeof value !== 'string' || !value.trim())) fail('INVALID_REQUEST', '请填写' + field.label);
    if (field.type === 'url' && value) {
      let url; try { url = new URL(value); } catch (_) { fail('INVALID_REQUEST', '服务地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('INVALID_REQUEST', '服务地址只能为 HTTP / HTTPS，不能含凭据、查询参数或片段');
    }
  }
  if (config.host && /[\s/\\?#\0]/.test(config.host)) fail('INVALID_REQUEST', '请填写主机名或 IP，不包含协议和路径');
  for (const key of ['username', 'token', 'accessKeyId', 'secretAccessKey', 'sessionToken']) {
    if (config[key] && /[\r\n\0]/.test(config[key])) fail('INVALID_REQUEST', '账号和令牌不能包含换行或空字符');
  }
  if (enabled && config.auth === 'basic' && !config.username.trim()) fail('INVALID_REQUEST', 'Basic 认证需要用户名或邮箱');
  if (enabled && kind.id === 'ssh') {
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(config.hostFingerprint)) fail('INVALID_REQUEST', '请填写 SHA256: 开头的服务器主机密钥指纹');
    if (!config.privateKey && !config.password) fail('INVALID_REQUEST', 'SSH 需要密码或私钥');
  }
}
function connectionConfig(kind, input, previous, required) {
  if (previous && previous.kind !== kind.id) fail('INVALID_REQUEST', '已有连接不能更换工具类型，请新建连接');
  const config = { ...Object.fromEntries(kind.fields.map(field => [field.key, field.default])), ...previous?.config, ...input.config };
  for (const key of input.clearSecrets || []) {
    if (!kind.fields.some(field => field.key === key && field.secret)) fail('INVALID_REQUEST', '只能清除已声明的凭据字段');
    config[key] = '';
  }
  validateConfig(kind, config, required);
  return config;
}

class DevToolsService {
  constructor(server) {
    this.server = server; this.file = path.join(server.auth.directory, 'devtools-connections.json');
    this.revision = 0; this.profiles = new Map(); this.saving = false; this.closed = false; this.active = new Map();
    this.legacyPostgresId = null;
  }
  async init() {
    let value = { version: 1, revision: 0, items: [] };
    try { value = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取研发工具连接配置'); }
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items) || value.items.length > 50) throw new Error('研发工具连接配置格式无效');
    if (value.legacyPostgresId != null && (typeof value.legacyPostgresId !== 'string' || !value.legacyPostgresId || value.legacyPostgresId.length > 100)) throw new Error('旧 PostgreSQL 连接标记无效');
    for (const item of value.items) {
      if (!arp.validateJsonSchema(SAVE, { ...item, revision: value.revision }).valid || !item.id || this.profiles.has(item.id)) throw new Error('研发工具连接配置无效');
      validateConfig(kindOf(item.kind), item.config, item.enabled); this.profiles.set(item.id, item);
    }
    this.revision = value.revision;
    this.legacyPostgresId = value.legacyPostgresId || null;
    // Persist the imported ID even after deletion, so old credentials never reappear
    // and legacy calls cannot silently switch to a different database.
    if (value.legacyPostgresId === undefined) {
      const legacy = await readLegacyPostgres(this.server.auth.directory);
      if (legacy) {
        if (this.profiles.size >= 50) throw new Error('导入旧 PostgreSQL 配置需要一个连接名额，请先将研发工具连接减至 49 个');
        validateConfig(kindOf('postgres'), legacy.config, legacy.enabled);
        const item = { ...legacy, id: randomUUID() };
        this.profiles.set(item.id, item); this.legacyPostgresId = item.id; this.revision++;
        await atomicJson(this.file, { version: 1, revision: this.revision, legacyPostgresId: this.legacyPostgresId, items: [...this.profiles.values()] });
      }
    }
  }
  settings() {
    return { revision: this.revision, items: [...this.profiles.values()].map(item => {
      const config = {}, secrets = {};
      for (const field of kindOf(item.kind).fields) {
        if (field.secret) secrets[field.key] = !!item.config[field.key]; else config[field.key] = item.config[field.key];
      }
      return { ...item, authorizedClientIds: [...item.authorizedClientIds], config, secrets };
    }) };
  }
  exportSettings() { return JSON.parse(JSON.stringify([...this.profiles.values()])); }
  async importSettings(items, expectedRevision) {
    if (!Array.isArray(items) || items.length > 50 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_REQUEST', '研发工具备份格式无效');
    if (this.closed || this.saving) fail('RESOURCE_BUSY', '连接配置正在保存或服务正在关闭');
    if (expectedRevision !== this.revision) fail('PRECONDITION_FAILED', '连接配置已变化，请重新导入');
    this.saving = true;
    try {
      const clients = new Set((await this.server.auth.list()).filter(item => !item.revokedAt).map(item => item.clientId));
      const next = new Map(this.profiles), imported = new Set();
      let removedAuthorizations = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !item.id || imported.has(item.id)
          || Object.hasOwn(item, 'revision') || Object.hasOwn(item, 'clearSecrets')
          || !arp.validateJsonSchema(SAVE, { ...item, revision: this.revision }).valid || !item.name.trim()) fail('INVALID_REQUEST', '研发工具备份包含无效字段或重复 ID');
        const previous = this.profiles.get(item.id), kind = kindOf(item.kind);
        if (previous && previous.kind !== item.kind) fail('RESOURCE_CONFLICT', '同 ID 连接的工具类型不同，无法合并');
        // Backups contain complete credentials; do not merge omitted secrets from the old connection.
        const config = connectionConfig(kind, item, null, item.enabled);
        const authorizedClientIds = item.authorizedClientIds.filter(id => clients.has(id));
        removedAuthorizations += item.authorizedClientIds.length - authorizedClientIds.length;
        next.set(item.id, { ...item, name: item.name.trim(), config, authorizedClientIds }); imported.add(item.id);
      }
      if (next.size > 50) fail('RESOURCE_BUSY', '导入后超过 50 个研发工具连接，请先删除不需要的连接');
      if (!imported.size) return { imported: 0, removedAuthorizations: 0 };
      const revision = this.revision + 1;
      await atomicJson(this.file, { version: 1, revision, legacyPostgresId: this.legacyPostgresId, items: [...next.values()] });
      this.profiles = next; this.revision = revision;
      return { imported: imported.size, removedAuthorizations };
    } finally { this.saving = false; }
  }
  async save(input, remove = false) {
    if (!arp.validateJsonSchema(remove ? REMOVE : SAVE, input).valid) fail('INVALID_REQUEST', '研发工具配置参数无效');
    if (this.closed || this.saving) fail('RESOURCE_BUSY', '连接配置正在保存或服务正在关闭');
    if (input.revision !== this.revision) fail('PRECONDITION_FAILED', '连接配置已变化，请刷新后编辑');
    const previous = input.id ? this.profiles.get(input.id) : null;
    if (input.id && !previous) fail('RESOURCE_NOT_FOUND', '连接不存在');
    this.saving = true;
    try {
      const next = new Map(this.profiles);
      if (remove) next.delete(input.id);
      else {
        if (!previous && next.size >= 50) fail('RESOURCE_BUSY', '最多保存 50 个研发工具连接');
        const kind = kindOf(input.kind);
        const config = connectionConfig(kind, input, previous, input.enabled);
        const clients = new Set((await this.server.auth.list()).filter(item => !item.revokedAt).map(item => item.clientId));
        if (input.authorizedClientIds.some(id => !clients.has(id))) fail('INVALID_REQUEST', '请选择有效的已配对客户端');
        if (!input.name.trim()) fail('INVALID_REQUEST', '请填写连接名称');
        const item = { id: input.id || randomUUID(), kind: input.kind, name: input.name.trim(), enabled: input.enabled,
          allowWrites: input.allowWrites, timeoutMs: input.timeoutMs, authorizedClientIds: [...input.authorizedClientIds], config };
        next.set(item.id, item);
      }
      const revision = this.revision + 1;
      await atomicJson(this.file, { version: 1, revision, legacyPostgresId: this.legacyPostgresId, items: [...next.values()] });
      this.profiles = next; this.revision = revision;
      return this.settings();
    } finally { this.saving = false; }
  }
  async test(input, context) {
    if (!arp.validateJsonSchema(TEST, input).valid) fail('INVALID_REQUEST', '连接测试参数无效');
    if (input.revision !== this.revision) fail('PRECONDITION_FAILED', '连接配置已变化，请刷新后测试');
    const previous = input.id ? this.profiles.get(input.id) : null;
    if (input.id && !previous) fail('RESOURCE_NOT_FOUND', '连接不存在');
    const config = connectionConfig(kindOf(input.kind), input, previous, true);
    const started = Date.now();
    const { auditRecorded } = await this.runOperation(input.kind, 'test', {},
      { id: input.id || null, timeoutMs: input.timeoutMs, config }, context, false);
    return { durationMs: Date.now() - started, auditRecorded };
  }
  list(context, kind) {
    return { items: [...this.profiles.values()]
      .filter(item => (!kind || item.kind === kind) && (!context.sourceIdentity || item.authorizedClientIds.includes(context.sourceIdentity.clientId)))
      .map(item => ({ id: item.id, kind: item.kind, name: item.name, enabled: item.enabled, allowWrites: item.allowWrites,
        timeoutMs: item.timeoutMs, operations: kindOf(item.kind).operations.filter(op => !op.write || item.allowWrites)
          .map(op => ({ id: op.id, label: op.label, write: op.write, method: 'POST', href: '/devtools/' + item.kind + '/' + op.id })) })) };
  }
  authorize(context, kind, operation, input) {
    const definition = kindOf(kind).operations.find(item => item.id === operation);
    if (!definition) fail('RESOURCE_NOT_FOUND', '能力不存在');
    const profile = this.profiles.get(input?.profileId);
    if (!profile || profile.kind !== kind || context.sourceIdentity && !profile.authorizedClientIds.includes(context.sourceIdentity.clientId)) fail('RESOURCE_NOT_FOUND', '连接不存在或当前客户端未获授权');
    if (this.closed || !profile.enabled) fail('TEMPORARILY_UNAVAILABLE', '请先在服务端配置中心启用此连接');
    if (definition.write && !profile.allowWrites) fail('FORBIDDEN', '此连接未开启「' + (kindOf(kind).writeLabel || '允许写入') + '」');
    return { definition, profile };
  }
  async execute(kind, operation, input, context) {
    const { definition, profile } = this.authorize(context, kind, operation, input);
    if (!arp.validateJsonSchema(definition.inputSchema, input).valid || Buffer.byteLength(JSON.stringify(input)) > 2097152) fail('INVALID_REQUEST', '操作参数无效或超过 2 MiB');
    return this.runOperation(kind, operation, input, profile, context, definition.write);
  }
  async runOperation(kind, operation, input, profile, context, write) {
    if (this.closed) fail('TEMPORARILY_UNAVAILABLE', '研发工具服务正在关闭');
    if (this.active.size >= 8) fail('RESOURCE_BUSY', '研发工具最多同时执行 8 个请求');
    context.abortSignal?.throwIfAborted();
    const controller = new AbortController(); let done;
    this.active.set(controller, new Promise(resolve => { done = resolve; }));
    const signal = context.abortSignal ? AbortSignal.any([controller.signal, context.abortSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), profile.timeoutMs); timer.unref();
    const execution = { signal, write, performed: 'no',
      attempt() { this.performed = 'unknown'; }, confirm() { this.performed = 'yes'; } };
    const audit = { requestId: randomUUID(), transportSessionId: context.sessionId || 'devtools',
      principal: { transport: context.sourceIdentity ? 'websocket' : 'http', id: context.actorId },
      operation: kind + '.' + operation, parameters: { profileId: profile.id, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') } };
    try {
      await this.server.audit.write('execution.intent', audit); signal.throwIfAborted();
      const result = await handlers[kind](operation, input, profile.config, execution);
      if (Buffer.byteLength(JSON.stringify(result)) > 2097152) fail('RESOURCE_BUSY', '结果超过 2 MiB，请缩小查询范围', execution.performed);
      const auditRecorded = await this.server.audit.bestEffort('execution.finished', { ...audit, receipt: { performed: execution.performed } });
      return { result, auditRecorded };
    } catch (error) {
      const known = error instanceof arp.ArpError;
      const performed = known ? error.performed || execution.performed : execution.performed;
      await this.server.audit.bestEffort('execution.finished', { ...audit, receipt: { performed }, errorReason: known ? error.code : signal.aborted ? 'CANCELLED_OR_TIMEOUT' : 'UPSTREAM_FAILED' });
      if (known) throw error;
      throw arp.arpError('UPSTREAM_FAILED', signal.aborted ? write ? '操作已取消或超时；写入结果未知时请先核对远端状态' : '操作已取消或超时'
        : '连接或执行失败，请核对地址、认证、TLS / SSH 主机指纹及服务权限', { performed, retryable: false });
    } finally { clearTimeout(timer); done(); this.active.delete(controller); }
  }
  async close() {
    this.closed = true;
    const pending = [...this.active.values()]; for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(pending);
  }
}

module.exports = { DevToolsService };
