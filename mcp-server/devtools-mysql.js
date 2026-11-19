'use strict';

const { createConnection } = require('mysql2');
const arp = require('../resources/protocol');

async function mysql(operation, input, config, execution) {
  if (operation === 'test') input = { sql: 'SELECT 1', maxRows: 1 };
  const write = operation === 'execute';
  // Limit the statement families that can run inside our transaction. In
  // particular, CALL / DDL / session commands can escape transaction boundaries.
  const allowed = write ? /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i
    : /^\s*(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;
  if (!allowed.test(input.sql)) throw arp.arpError('INVALID_REQUEST', write
    ? '写入 SQL 必须直接以 INSERT、UPDATE、DELETE、REPLACE 或 WITH 开头'
    : '查询 SQL 必须直接以 SELECT、SHOW、DESCRIBE、EXPLAIN 或 WITH 开头');
  execution.signal.throwIfAborted();
  const client = createConnection({ host: config.host, port: config.port, database: config.database,
    user: config.username, password: config.password, connectTimeout: 5000,
    ssl: config.tls ? { rejectUnauthorized: true, verifyIdentity: true, ...(config.ca ? { ca: config.ca } : {}) } : undefined,
    multipleStatements: false, namedPlaceholders: false, flags: ['-LOCAL_FILES'],
    rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true,
    decimalNumbers: false, dateStrings: true, jsonStrings: true, disableEval: true });
  let pending;
  // mysql2.destroy() ends the stream gracefully; also destroy the socket to
  // release a blocked query immediately when the caller cancels or times out.
  const stop = () => { client.destroy(); client.stream.destroy(); };
  const abort = () => { pending?.(execution.signal.reason || new Error('MySQL request cancelled')); stop(); };
  client.on('error', error => pending?.(error));
  execution.signal.addEventListener('abort', abort, { once: true });

  function run(sql, prepared = false) {
    execution.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const rows = [], maxRows = input.maxRows || 100;
      let columns = [], rowCount = 0, bytes = 0, truncated = false, header, settled = false;
      function finish(error) {
        if (settled) return; settled = true; pending = null;
        if (error) reject(error);
        else resolve({ columns, rows, rowCount, truncated,
          affectedRows: header?.affectedRows ?? null, insertId: header?.insertId ?? null,
          warningCount: header?.warningStatus || 0 });
      }
      pending = finish;
      try {
        // The server's prepared-statement protocol rejects multiple statements,
        // including when there are no parameters. No user SQL is interpolated.
        const command = prepared ? client.execute(sql, input.params || []) : client.query(sql);
        command.on('error', finish);
        command.on('fields', fields => {
          if (!settled && fields) columns = fields.map(field => ({ name: field.name, dataTypeId: field.columnType }));
        });
        command.on('result', row => {
          if (settled) return;
          if (!Array.isArray(row)) { header = row; return; }
          rowCount++;
          if (truncated) return;
          try {
            const size = Buffer.byteLength(JSON.stringify(row));
            if (rows.length >= maxRows || bytes + size > 1048576) { truncated = true; return; }
            bytes += size; rows.push(row);
          } catch (error) { finish(error); }
        });
        command.once('end', () => finish());
      } catch (error) { finish(error); }
    });
  }

  try {
    await run(write ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
    execution.signal.throwIfAborted();
    if (write) execution.attempt();
    const result = await run(input.sql, true);
    execution.signal.throwIfAborted();
    await run(write ? 'COMMIT' : 'ROLLBACK');
    if (write) execution.confirm();
    return result;
  } catch (error) {
    // Nontransactional tables or triggers may already have changed data even
    // after a SQL error. Never infer rollback from the error code alone.
    const sqlState = typeof error.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(error.sqlState) ? error.sqlState : null;
    if (sqlState) throw arp.arpError('UPSTREAM_FAILED', 'MySQL 拒绝操作（SQLSTATE ' + sqlState + '），请检查 SQL、参数、账号权限与事务限制',
      { performed: execution.performed, retryable: false, details: { sqlState } });
    throw error;
  } finally {
    execution.signal.removeEventListener('abort', abort); stop();
  }
}

module.exports = { mysql };
