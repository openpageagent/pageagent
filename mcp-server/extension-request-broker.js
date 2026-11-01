'use strict';

const { randomUUID } = require('crypto');
const contract = require('../shared/mcp-contract');
const ARP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
function errorFrom(value, fallback) { return value instanceof Error ? value : new Error(String(value && value.message || value || fallback)); }
function abortError(value) { return Object.assign(errorFrom(value, 'Request aborted'), { code: 'UPSTREAM_FAILED', reason: 'RESULT_UNKNOWN', performed: 'unknown', retryable: false }); }
function normalizeTransportContext(value) {
  if (!contract.record(value)) contract.fail('INVALID_CONTEXT');
  contract.id(value.sessionId); contract.id(value.conversationId || value.sessionId);
  return { sessionId: value.sessionId, conversationId: value.conversationId || value.sessionId, parentRequest: value.parentRequest || null };
}
function isArpEnvelope(value) { return contract.record(value) && value.protocol === 'arp/1' && typeof value.requestId === 'string' && contract.record(value.status) && Number.isInteger(value.status.code); }
class ExtensionRequestBroker {
  constructor(send) { this.send = send; this.pendingRequests = new Map(); this.closed = false; }
  countForClient(clientId) { return [...this.pendingRequests.values()].filter(item => item.clientId === clientId).length; }
  call({ ws, clientId, method, request, context, principal, timeoutMs = 30000, signal, lifecycle, onSettled }) {
    if (this.closed || !ws || ws.readyState !== 1) return Promise.reject(new Error('Extension socket unavailable'));
    if (signal && signal.aborted) return Promise.reject(Object.assign(abortError(signal.reason), { reason: 'REQUEST_CANCELLED', performed: 'no' }));
    if (!ARP_METHODS.has(method) || !contract.record(request)) return Promise.reject(new Error('INVALID_ARP_REQUEST'));
    if (this.pendingRequests.size >= 32 || this.countForClient(clientId) >= 8) return Promise.reject(Object.assign(new Error('ARP forwarding capacity reached'), { code: 'RESOURCE_BUSY' }));
    const requestId = randomUUID(); const safeContext = normalizeTransportContext(context);
    const identity = ws.pageAgentIdentity;
    let done;
    const completion = new Promise(resolve => { done = resolve; });
    if (lifecycle) lifecycle.pending.add(completion);
    return new Promise((resolve, reject) => {
      const item = { requestId, ws, clientId, identity, resolve, reject, signal, done, onSettled,
        parentRequest: safeContext.parentRequest, waiting: true, sent: false };
      const cancel = reason => {
        if (!item.waiting) return;
        item.waiting = false; clearTimeout(item.timer);
        if (signal) signal.removeEventListener('abort', item.abort);
        if (item.sent && ws.readyState === 1) {
          try { this.send(ws, { type: 'arp.cancel', requestId, reason: 'Request cancelled' }); } catch (_) {}
        }
        Promise.resolve().then(() => item.onSettled && item.onSettled(null, abortError(reason))).catch(() => {});
        reject(abortError(reason));
      };
      item.cancel = cancel;
      item.abort = () => cancel(signal.reason);
      item.timer = setTimeout(() => cancel('Extension response timeout'), timeoutMs);
      this.pendingRequests.set(requestId, item);
      if (signal) signal.addEventListener('abort', item.abort, { once: true });
      try {
        item.sent = true;
        this.send(ws, { type: 'arp.request', requestId, method, request, context: safeContext, principal }, error => {
          if (error) item.cancel(error);
        });
      } catch (error) { this.finish(item, null, error); }
    });
  }
  finish(item, envelope, error) {
    if (!this.pendingRequests.has(item.requestId)) return;
    const waiting = item.waiting; item.waiting = false;
    this.pendingRequests.delete(item.requestId); clearTimeout(item.timer);
    if (item.signal) item.signal.removeEventListener('abort', item.abort);
    Promise.resolve().then(() => item.onSettled && item.onSettled(envelope, error)).catch(() => {}).then(() => {
      if (waiting) { if (error) item.reject(abortError(error)); else item.resolve(envelope); }
      item.done();
    });
  }
  handleResponse(message, ws) {
    const item = this.pendingRequests.get(message.requestId);
    if (!item) return 'unknown';
    if (item.ws !== ws || message.transportSessionId !== item.identity.transportSessionId) return 'wrong-socket';
    if (!isArpEnvelope(message.envelope)) { item.cancel(new Error('Invalid ARP Envelope')); return 'invalid'; }
    this.finish(item, message.envelope);
    return 'settled';
  }
  validateParent(parent, identity) {
    if (!parent) return false;
    for (const item of this.pendingRequests.values()) {
      if (!item.parentRequest || item.parentRequest.requestId !== parent.requestId || item.parentRequest.transportSessionId !== parent.transportSessionId) continue;
      if (item.clientId !== identity.clientId) contract.fail('PARENT_TARGET_MISMATCH', '入口目标不匹配', 'FORBIDDEN');
      return true;
    }
    return false;
  }
  rejectForSocket(ws, reason) {
    // Closing this transport releases forwarding capacity, not the remote
    // execution. Persist the unknown outcome and settle the HTTP lifecycle too.
    for (const item of this.pendingRequests.values()) if (item.ws === ws) this.finish(item, null, abortError(reason));
  }
  close(reason) { this.closed = true; for (const item of [...this.pendingRequests.values()]) this.finish(item, null, reason); }
}
module.exports = { ExtensionRequestBroker, ARP_METHODS, normalizeTransportContext, isArpEnvelope, abortError, errorFrom };
