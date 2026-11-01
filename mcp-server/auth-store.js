'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { acquireLock, atomicJson } = require('./state-lock');
const contract = require('../shared/mcp-contract');
const scrypt = promisify(crypto.scrypt);
const COST = Object.freeze({ N: 16384, r: 8, p: 1 });
const generateCredential = () => crypto.randomBytes(24).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest();
function equalHash(value, expected) {
  const actual = digest(value); const stored = Buffer.from(expected || '', 'hex');
  return stored.length === actual.length && crypto.timingSafeEqual(actual, stored);
}
function defaultStateDir() {
  return path.join(process.cwd(), 'data');
}

class AuthStore {
  constructor(directory) {
    this.directory = path.resolve(directory || defaultStateDir());
    this.file = path.join(this.directory, 'auth.json');
    this.queue = Promise.resolve(); this.scryptActive = 0; this.failures = new Map(); this.globalFailures = []; this.rateLimited = 0; this.lastRateSummary = Date.now();
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // The current working directory may be a project directory; keep its permissions.
    if (process.platform !== 'win32' && this.directory !== path.resolve(process.cwd())) await fs.chmod(this.directory, 0o700);
  }
  async read(optional = false) {
    let state;
    try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw Object.assign(new Error('AUTH_STATE_UNAVAILABLE'), { code: 'AUTHENTICATION_REQUIRED', reason: 'AUTH_STATE_UNAVAILABLE' }); }
    if (state.version !== 1 || !contract.record(state.pairings) || !Number.isSafeInteger(state.authEpoch) || state.authEpoch < 1
      || !state.passwordVerifier || state.passwordVerifier.algorithm !== 'scrypt'
      || !/^[a-f0-9]{64}$/.test(state.passwordVerifier.hash) || !/^[a-f0-9]{32,}$/.test(state.passwordVerifier.salt)
      || JSON.stringify(state.passwordVerifier.costParameters) !== JSON.stringify(COST)) throw new Error('AUTH_STATE_INVALID');
    if (state.httpBearerTokenHash !== undefined && !/^[a-f0-9]{64}$/.test(state.httpBearerTokenHash)) throw new Error('AUTH_STATE_INVALID');
    contract.id(state.serverId);
    for (const [pairingId, pairing] of Object.entries(state.pairings)) {
      contract.id(pairingId); contract.id(pairing.clientId); contract.id(pairing.extensionId);
      if (!/^[a-f0-9]{64}$/.test(pairing.tokenHash) || typeof pairing.incognito !== 'boolean'
        || !Number.isSafeInteger(pairing.authEpoch) || pairing.authEpoch < 1 || pairing.authEpoch > state.authEpoch
        || !Number.isFinite(Date.parse(pairing.createdAt)) || pairing.revokedAt !== null && !Number.isFinite(Date.parse(pairing.revokedAt))) throw new Error('AUTH_STATE_INVALID');
      if (pairing.pairingVersion !== undefined || pairing.communicationKey !== undefined) {
        if (pairing.pairingVersion !== contract.PAIRING) throw new Error('AUTH_STATE_INVALID');
        contract.communicationKey(pairing.communicationKey);
      }
    }
    return state;
  }
  mutate(change, optional = false) {
    const run = this.queue.then(async () => {
      const release = await acquireLock(path.join(this.directory, 'auth.lock'));
      try {
        const current = await this.read(optional);
        const result = await change(current);
        await atomicJson(this.file, result.state);
        return result.value;
      } finally { await release(); }
    });
    this.queue = run.catch(() => {}); return run;
  }
  async setPassword(password, initialServerId) {
    contract.password(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, Buffer.from(salt, 'hex'), 32, COST)).toString('hex');
    return this.mutate(state => {
      state = state || { version: 1, serverId: initialServerId || crypto.randomUUID(), authEpoch: 0, pairings: {} };
      state.authEpoch++;
      for (const item of Object.values(state.pairings)) if (!item.revokedAt) item.revokedAt = new Date().toISOString();
      state.passwordVerifier = { algorithm: 'scrypt', salt, costParameters: COST, hash };
      return { state, value: { serverId: state.serverId, authEpoch: state.authEpoch } };
    }, true);
  }
  async ensureHttpBearerToken(token) {
    token = String(token || '').trim();
    const state = await this.read();
    if (!token && state.httpBearerTokenHash) return { hash: state.httpBearerTokenHash };
    const generated = !token;
    if (generated) token = generateCredential();
    const hash = digest(token).toString('hex');
    if (hash !== state.httpBearerTokenHash) {
      await this.mutate(current => {
        current.httpBearerTokenHash = hash;
        return { state: current, value: null };
      });
    }
    return { hash, ...(generated ? { generatedToken: token } : {}) };
  }
  async revoke(pairingId) {
    contract.id(pairingId);
    return this.mutate(state => {
      if (!contract.own(state.pairings, pairingId)) contract.fail('PAIRING_NOT_FOUND', '配对不存在', 'RESOURCE_NOT_FOUND');
      state.pairings[pairingId].revokedAt = state.pairings[pairingId].revokedAt || new Date().toISOString();
      return { state, value: { pairingId, clientId: state.pairings[pairingId].clientId } };
    });
  }
  checkRate(address) {
    const cutoff = Date.now() - 60000;
    this.globalFailures = this.globalFailures.filter(time => time > cutoff);
    for (const [key, times] of this.failures) {
      const current = times.filter(time => time > cutoff);
      if (current.length) this.failures.set(key, current); else this.failures.delete(key);
    }
    if (this.globalFailures.length >= 30 || (this.failures.get(address) || []).length >= 5 || this.scryptActive >= 2) {
      this.rateLimited++;
      throw Object.assign(new Error('认证尝试过于频繁，请稍后重试'), { code: 'RATE_LIMITED', reason: 'AUTH_RATE_LIMITED', retryable: true, retryAfterMs: 60000 });
    }
  }
  failed(address) {
    const now = Date.now(); this.globalFailures.push(now); this.globalFailures = this.globalFailures.slice(-30);
    const list = this.failures.get(address) || []; list.push(now); this.failures.set(address, list.slice(-5));
  }
  reportRateLimit() {
    if (Date.now() - this.lastRateSummary < 60000) return;
    if (this.rateLimited) console.error('Authentication rate limit: rejected ' + this.rateLimited + ' attempts in the last interval');
    this.rateLimited = 0; this.lastRateSummary = Date.now();
  }
  checkOrigin(message, origin) {
    if (!origin || origin !== 'chrome-extension://' + message.clientInfo.extensionId) contract.fail('ORIGIN_MISMATCH', '扩展来源不匹配', 'FORBIDDEN');
  }
  async authenticate(message, origin, address, beforePair) {
    this.checkRate(address);
    try {
      contract.authFrame(message); this.checkOrigin(message, origin);
      const state = await this.read();
      if (message.expectedServerId && message.expectedServerId !== state.serverId) contract.fail('SERVER_ID_CHANGED', '服务端身份变化', 'DEPENDENCY_CHANGED');
      let pairingId = message.pairingId; let token, communicationKey;
      const transportSessionId = crypto.randomUUID();
      if (message.type === 'auth.pair') {
        this.checkRate(address);
        this.scryptActive++;
        let actual;
        try { actual = await scrypt(message.password, Buffer.from(state.passwordVerifier.salt, 'hex'), 32, COST); }
        finally { this.scryptActive--; message.password = ''; }
        if (!crypto.timingSafeEqual(actual, Buffer.from(state.passwordVerifier.hash, 'hex'))) contract.fail('AUTH_FAILED', '认证失败', 'AUTHENTICATION_REQUIRED');
        pairingId = crypto.randomUUID(); token = crypto.randomBytes(32).toString('base64url');
        communicationKey = crypto.randomBytes(32).toString('base64url');
        if (beforePair) await beforePair({ serverId: state.serverId, pairingId, clientId: message.clientId, transportSessionId });
        await this.mutate(current => {
          if (current.serverId !== state.serverId || current.authEpoch !== state.authEpoch) contract.fail('AUTHORIZATION_CHANGED');
          const createdAt = new Date().toISOString();
          for (const item of Object.values(current.pairings)) {
            if (item.clientId === message.clientId && !item.revokedAt) item.revokedAt = createdAt;
          }
          current.pairings[pairingId] = { clientId: message.clientId, extensionId: message.clientInfo.extensionId,
            incognito: message.clientInfo.incognito, tokenHash: digest(token).toString('hex'),
            pairingVersion: contract.PAIRING, communicationKey,
            authEpoch: current.authEpoch, createdAt, revokedAt: null };
          return { state: current, value: null };
        });
      } else if (message.type === 'auth.resume') {
        const validatePairing = current => {
          if (current.serverId !== state.serverId || current.authEpoch !== state.authEpoch) contract.fail('AUTHORIZATION_CHANGED');
          const pairing = contract.own(current.pairings, pairingId) && current.pairings[pairingId];
          if (!pairing || pairing.revokedAt || pairing.authEpoch !== current.authEpoch) contract.fail('CREDENTIAL_REVOKED', '配对不存在或已撤销', 'AUTHENTICATION_REQUIRED');
          if (pairing.clientId !== message.clientId || pairing.extensionId !== message.clientInfo.extensionId
            || pairing.incognito !== message.clientInfo.incognito || !equalHash(message.token, pairing.tokenHash)) contract.fail('AUTH_FAILED', '认证失败', 'AUTHENTICATION_REQUIRED');
          return pairing;
        };
        let pairing = validatePairing(state);
        if (!pairing.communicationKey) {
          contract.communicationKey(message.communicationKey);
          pairing = await this.mutate(current => {
            const active = validatePairing(current);
            if (!active.communicationKey) {
              active.pairingVersion = contract.PAIRING; active.communicationKey = message.communicationKey;
            }
            return { state: current, value: active };
          });
        }
        // An upgrade retry may repeat the same key, but cannot replace an established key.
        if (message.communicationKey !== undefined && !crypto.timingSafeEqual(Buffer.from(message.communicationKey, 'base64url'),
          Buffer.from(pairing.communicationKey, 'base64url'))) contract.fail('AUTH_FAILED', '认证失败', 'AUTHENTICATION_REQUIRED');
        communicationKey = pairing.communicationKey;
      } else contract.fail('PROTOCOL_INCOMPATIBLE');
      return { serverId: state.serverId, clientId: message.clientId, pairingId,
        authEpoch: state.authEpoch, transportSessionId, pairingVersion: contract.PAIRING, communicationKey, ...(token ? { token } : {}) };
    } catch (error) { if (error.reason !== 'AUTH_RATE_LIMITED') this.failed(address); throw error; }
    finally { if (message) { delete message.password; delete message.token; delete message.communicationKey; } }
  }
  async assertActive(identity) {
    const state = await this.read();
    const pairing = contract.own(state.pairings, identity.pairingId) && state.pairings[identity.pairingId];
    if (state.serverId !== identity.serverId || state.authEpoch !== identity.authEpoch || !pairing
      || pairing.revokedAt || pairing.clientId !== identity.clientId || pairing.authEpoch !== state.authEpoch) contract.fail('CREDENTIAL_REVOKED', '凭据已撤销', 'AUTHENTICATION_REQUIRED');
    return pairing;
  }
  async list() {
    const state = await this.read();
    return Object.entries(state.pairings).map(([pairingId, item]) => ({ pairingId, clientId: item.clientId,
      extensionId: item.extensionId, incognito: item.incognito, createdAt: item.createdAt, revokedAt: item.revokedAt }));
  }
}
module.exports = { AuthStore, defaultStateDir, generateCredential, equalHash, digest };
