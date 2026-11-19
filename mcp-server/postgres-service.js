'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Query } = require('pg');
const arp = require('../resources/protocol');
const catalog = require('../shared/devtools-catalog');
const { object } = catalog;
const LEGACY_CONFIG = object({
  revision: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' },
  host: { type: 'string', minLength: 1, maxLength: 255 }, port: { type: 'integer', minimum: 1, maximum: 65535 },
  database: { type: 'string', maxLength: 200 }, user: { type: 'string', maxLength: 200 },
  password: { type: 'string', maxLength: 4096 }, ssl: { type: 'boolean' }, ca: { type: 'string', maxLength: 65536 },
  allowWrites: { type: 'boolean' },
  authorizedClientIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } },
}, ['revision', 'enabled', 'host', 'port', 'database', 'user', 'ssl', 'ca', 'allowWrites', 'authorizedClientIds']);
const INPUT = object(catalog.kinds.find(kind => kind.id === 'postgres').operations[0].inputSchema.properties, ['sql']);
const fail = (code, message, performed = 'no') => { throw arp.arpError(code, message, { performed }); };

async function readLegacyPostgres(directory) {
  let input;
  try { input = JSON.parse(await fs.readFile(path.join(directory, 'postgres.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('无法读取旧 PostgreSQL 配置'); }
  if (!arp.validateJsonSchema(LEGACY_CONFIG, input).valid) throw new Error('旧 PostgreSQL 配置格式无效');
  return { kind: 'postgres', name: ('PostgreSQL' + (input.database ? ' · ' + input.database : '')).slice(0, 100),
    enabled: input.enabled, allowWrites: input.allowWrites, timeoutMs: 30000, authorizedClientIds: input.authorizedClientIds,
    config: { host: input.host, port: input.port, database: input.database, username: input.user,
      password: input.password || '', tls: input.ssl, ca: input.ca } };
}

// Compatibility routes use the same profiles and authorization as /devtools.
class PostgresService {
  constructor(server) { this.server = server; }
  status(context, input = {}) {
    const service = this.server.devtools, items = service.list(context, 'postgres').items;
    const profileId = input.profileId || service.legacyPostgresId || (items.length === 1 ? items[0].id : null);
    const visible = items.find(item => item.id === profileId), profile = visible && service.profiles.get(visible.id);
    return { configured: !!profile?.enabled, authorized: !!profile, profileId: profile?.id || null,
      database: profile?.config.database || '', allowWrites: !!profile?.allowWrites, maxRows: 1000, timeoutMs: 15000, items,
      links: profile ? [{ rel: 'query', href: '/postgres/query', method: 'POST' },
        ...(profile.allowWrites ? [{ rel: 'execute', href: '/postgres/execute', method: 'POST' }] : [])] : [] };
  }
  authorize(context, write, input) {
    const profileId = input?.profileId || this.server.devtools.legacyPostgresId;
    if (!profileId) fail('INVALID_REQUEST', '请从研发工具连接目录获取 PostgreSQL 的 profileId 并随操作传入');
    return this.server.devtools.authorize(context, 'postgres', write ? 'execute' : 'query', { profileId }).profile;
  }
  async execute(input, context, write) {
    const profile = this.authorize(context, write, input);
    const { result, auditRecorded } = await this.server.devtools.execute('postgres', write ? 'execute' : 'query',
      { ...input, profileId: profile.id }, context);
    return { ...result, auditRecorded };
  }
}

async function postgres(operation, input, config, execution) {
  const { signal, write } = execution;
  if (operation === 'test') input = { sql: 'SELECT 1', maxRows: 1 };
  if (!input.sql.trim()) fail('INVALID_REQUEST', '请提供单条 SQL 和有效参数');
  if (Buffer.byteLength(JSON.stringify(input)) > 1048576) fail('INVALID_REQUEST', 'SQL 和参数合计不能超过 1 MiB');
  signal.throwIfAborted();
  // Each operation owns its connection so session and transaction state cannot leak.
  const client = new Client({ host: config.host, port: config.port, database: config.database,
    user: config.username, password: () => config.password, ssl: config.tls ? { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) } : false,
    connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 5000,
    idle_in_transaction_session_timeout: 15000, application_name: 'page-agent' });
  client.on('error', () => {});
  let sent = false, committed = false;
  const abort = () => { client.end().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(); signal.throwIfAborted();
    await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY'); signal.throwIfAborted();
    sent = true;
    if (write) execution.attempt();
    const rows = [], maxRows = input.maxRows || 100;
    let bytes = 0, truncated = false;
    const result = await new Promise((resolve, reject) => {
      // Extended protocol rejects multiple statements, including with no params.
      const query = new Query({ text: input.sql, values: input.params || [], queryMode: 'extended', rowMode: 'array' });
      query.once('error', reject); query.once('end', resolve);
      query.on('row', row => {
        if (truncated) return;
        const size = Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= maxRows || bytes + size > 1048576) { truncated = true; return; }
        bytes += size; rows.push(row);
      });
      client.query(query);
    });
    signal.throwIfAborted();
    await client.query(write ? 'COMMIT' : 'ROLLBACK'); committed = write;
    if (write) execution.confirm();
    return { columns: result.fields.map(field => ({ name: field.name, dataTypeId: field.dataTypeID })), rows,
      rowCount: result.rowCount, command: result.command, truncated };
  } catch (error) {
    // SQL errors abort the transaction; losing a connection during COMMIT leaves the outcome unknown.
    const sqlState = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    execution.performed = committed ? 'yes' : !write || !sent || sqlState && !/^(08|57|58|XX)/.test(sqlState) ? 'no' : 'unknown';
    const message = sqlState === '25006' ? '只读查询不允许修改数据，请使用 execute 并开启写入授权'
      : sqlState === '57014' ? '数据库执行超时，请缩小查询范围'
      : signal.aborted ? '数据库请求已取消或超时'
      : sqlState ? '数据库拒绝操作（SQLSTATE ' + sqlState + '），请检查 SQL、参数与数据库账号权限'
      : '数据库连接或执行失败，请检查地址、凭据、TLS 与网络';
    throw arp.arpError('UPSTREAM_FAILED', message, { performed: execution.performed, retryable: false, details: { sqlState } });
  } finally {
    signal.removeEventListener('abort', abort);
    await client.end().catch(() => {});
  }
}

module.exports = { PostgresService, INPUT, postgres, readLegacyPostgres };
