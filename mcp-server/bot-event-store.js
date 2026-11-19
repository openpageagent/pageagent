'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const arp = require('../resources/protocol');
const fail = (code, message) => { throw arp.arpError(code, message); };

// The server already requires Node >=22.16. No external database or native addon.
// Do not evict unread messages. Account deletion is the explicit retention boundary.
class BotEventStore {
  constructor(directory) {
    const file = path.join(directory, 'bot-events.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL, id TEXT NOT NULL, timestamp INTEGER NOT NULL,
        source_timestamp INTEGER NOT NULL, body TEXT NOT NULL,
        UNIQUE(account, id)
      );
      CREATE INDEX IF NOT EXISTS account_events ON events(account, sequence);
      CREATE TABLE IF NOT EXISTS consumers (
        account TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        receipt TEXT, pending_end INTEGER, last_receipt TEXT,
        PRIMARY KEY(account, owner, name)
      );
    `);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(event, sourceTimestamp) {
    const result = this.db.prepare('INSERT OR IGNORE INTO events(account, id, timestamp, source_timestamp, body) VALUES (?, ?, ?, ?, ?)')
      .run(event.accountId, event.id, event.timestamp, sourceTimestamp, JSON.stringify(event));
    return Number(result.changes) > 0;
  }
  decode(row) { return { ...JSON.parse(row.body), sequence: Number(row.sequence) }; }
  find(account, id) {
    const row = this.db.prepare('SELECT * FROM events WHERE account = ? AND id = ?').get(account, id);
    return row && { event: this.decode(row), sourceTimestamp: Number(row.source_timestamp) };
  }
  recordAutoReply(account, id, result) {
    const saved = this.find(account, id);
    if (!saved) return;
    const { sequence, ...event } = saved.event;
    event.autoReply = result;
    this.db.prepare('UPDATE events SET body = ? WHERE account = ? AND id = ?').run(JSON.stringify(event), account, id);
  }
  sources(account) {
    const rows = this.db.prepare(`SELECT body FROM events WHERE sequence IN (
      SELECT MAX(sequence) FROM events WHERE account = ?
      GROUP BY json_extract(body, '$.channelId'), json_extract(body, '$.userId')
    ) ORDER BY sequence DESC`).all(account);
    return { items: rows.map(row => {
      const event = JSON.parse(row.body);
      return { channelId: event.channelId, userId: event.userId, channelName: event.channelName || '',
        userName: event.userName || '', direct: event.direct, preview: String(event.text || '').slice(0, 80) };
    }).filter(item => item.channelId && item.userId) };
  }
  history(account, query = {}) {
    const limit = query.limit === undefined ? 50 : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST', 'limit 必须为 1–100');
    const after = query.after;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) fail('INVALID_REQUEST', 'after 必须为非负整数');
    const rows = after === undefined
      ? this.db.prepare('SELECT sequence, body FROM events WHERE account = ? ORDER BY sequence DESC LIMIT ?').all(account, limit).reverse()
      : this.db.prepare('SELECT sequence, body FROM events WHERE account = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(account, after, limit);
    const items = rows.map(row => this.decode(row));
    const next = items.length ? items[items.length - 1].sequence : after || 0;
    const remaining = this.db.prepare('SELECT 1 FROM events WHERE account = ? AND sequence > ? LIMIT 1').get(account, next);
    return { items, nextCursor: next, hasMore: !!remaining };
  }
  consumer(account, owner, name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) fail('INVALID_REQUEST', 'consumerId 必须为 1–100 位英文、数字、点、横线或下划线');
    let item = this.db.prepare('SELECT * FROM consumers WHERE account = ? AND owner = ? AND name = ?').get(account, owner, name);
    if (!item) {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM consumers').get();
      if (Number(count.count) >= 1000) fail('RESOURCE_BUSY', '最多支持 1000 个消息消费者');
      this.db.prepare('INSERT INTO consumers(account, owner, name) VALUES (?, ?, ?)').run(account, owner, name);
      item = this.db.prepare('SELECT * FROM consumers WHERE account = ? AND owner = ? AND name = ?').get(account, owner, name);
    }
    return item;
  }
  pull(account, owner, name, limit = 50) {
    return this.transaction(() => {
      const item = this.consumer(account, owner, name);
      if (item.receipt) {
        const rows = this.db.prepare('SELECT sequence, body FROM events WHERE account = ? AND sequence > ? AND sequence <= ? ORDER BY sequence')
          .all(account, item.position, item.pending_end);
        return { items: rows.map(row => this.decode(row)), receipt: item.receipt, redelivered: true };
      }
      const batch = this.history(account, { after: Number(item.position), limit });
      if (!batch.items.length) return { items: [], receipt: null, redelivered: false };
      const receipt = randomUUID();
      this.db.prepare('UPDATE consumers SET receipt = ?, pending_end = ? WHERE account = ? AND owner = ? AND name = ?')
        .run(receipt, batch.nextCursor, account, owner, name);
      return { items: batch.items, receipt, redelivered: false };
    });
  }
  acknowledge(account, owner, name, receipt) {
    return this.transaction(() => {
      const item = this.consumer(account, owner, name);
      if (typeof receipt !== 'string' || !receipt) fail('INVALID_REQUEST', '请提供拉取批次的 receipt');
      if (item.last_receipt === receipt) return { acknowledged: true };
      if (item.receipt !== receipt) fail('PRECONDITION_FAILED', '批次凭证不匹配，读取进度未改变');
      this.db.prepare('UPDATE consumers SET position = pending_end, last_receipt = receipt, receipt = NULL, pending_end = NULL WHERE account = ? AND owner = ? AND name = ?')
        .run(account, owner, name);
      return { acknowledged: true };
    });
  }
  removeConsumer(account, owner, name) {
    this.db.prepare('DELETE FROM consumers WHERE account = ? AND owner = ? AND name = ?').run(account, owner, name);
    return { deleted: true };
  }
  removeAccount(account) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM consumers WHERE account = ?').run(account);
      this.db.prepare('DELETE FROM events WHERE account = ?').run(account);
    });
  }
  close() { this.db.close(); }
}

module.exports = { BotEventStore };
