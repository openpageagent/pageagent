'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 610000;
const ARP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function isRecord(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value));
}

function errorFrom(value, fallbackMessage) {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const error = new Error(String(value.message || fallbackMessage || 'Extension request failed'));
    if (value.code !== undefined) error.code = value.code;
    return error;
  }
  return new Error(String(value || fallbackMessage || 'Extension request failed'));
}

function abortError(reason) {
  const error = errorFrom(reason, 'Request aborted');
  if (error.name === 'Error') error.name = 'AbortError';
  return error;
}

function normalizeCorrelationId(value, name, fallback) {
  const text = String(value || fallback || '').trim();
  if (!CORRELATION_ID.test(text)) {
    throw new TypeError(`${name} must be 1-200 safe correlation characters`);
  }
  return text;
}

function normalizeTransportContext(value) {
  value = isRecord(value) ? value : {};
  const sessionId = normalizeCorrelationId(value.sessionId, 'context.sessionId');
  return {
    sessionId,
    conversationId: normalizeCorrelationId(
      value.conversationId,
      'context.conversationId',
      sessionId
    ),
  };
}

function isArpEnvelope(value) {
  return !!(isRecord(value)
    && value.protocol === 'arp/1'
    && typeof value.requestId === 'string'
    && isRecord(value.status)
    && Number.isInteger(Number(value.status.code)));
}

class ExtensionRequestBroker {
  constructor(options = {}) {
    this.defaultTimeoutMs = this.normalizeTimeout(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxTimeoutMs = this.normalizeTimeout(options.maxTimeoutMs, MAX_TIMEOUT_MS);
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.closed = false;
  }

  normalizeTimeout(value, fallback) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout <= 0) return fallback;
    return Math.max(1, Math.floor(timeout));
  }

  nextRequestId() {
    do {
      this.requestIdCounter = this.requestIdCounter >= Number.MAX_SAFE_INTEGER
        ? 1
        : this.requestIdCounter + 1;
    } while (this.pendingRequests.has(String(this.requestIdCounter)));
    return this.requestIdCounter;
  }

  countForClient(clientId) {
    let count = 0;
    for (const pending of this.pendingRequests.values()) {
      if (pending.clientId === clientId) count++;
    }
    return count;
  }

  call({ ws, clientId, method, request, context, timeoutMs, signal }) {
    if (this.closed) return Promise.reject(new Error('Extension request broker is closed'));
    if (!ws || typeof ws.send !== 'function') return Promise.reject(new Error('Extension socket is not available'));
    if (signal && signal.aborted) return Promise.reject(abortError(signal.reason));

    method = String(method || '').toUpperCase();
    if (!ARP_METHODS.has(method)) return Promise.reject(new TypeError(`Unsupported ARP method: ${method || '(empty)'}`));
    if (!isRecord(request)) return Promise.reject(new TypeError('ARP request must be an object'));

    let safeContext;
    try {
      safeContext = normalizeTransportContext(context);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = this.nextRequestId();
    const key = String(requestId);
    const boundedTimeoutMs = Math.min(
      this.normalizeTimeout(timeoutMs, this.defaultTimeoutMs),
      this.maxTimeoutMs
    );

    return new Promise((resolve, reject) => {
      const onAbort = signal
        ? () => this.settle(key, 'reject', abortError(signal.reason))
        : null;
      const timeout = setTimeout(() => {
        this.settle(key, 'reject', new Error(`Request timeout after ${boundedTimeoutMs}ms`));
      }, boundedTimeoutMs);

      this.pendingRequests.set(key, {
        requestId,
        resolve,
        reject,
        timeout,
        signal,
        onAbort,
        ws,
        clientId,
        method,
        uri: String(request.uri || ''),
      });
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });

      try {
        ws.send(JSON.stringify({
          requestId,
          method,
          request,
          context: safeContext,
        }), (error) => {
          if (error) this.settle(key, 'reject', errorFrom(error, 'Failed to send extension request'));
        });
      } catch (error) {
        this.settle(key, 'reject', errorFrom(error, 'Failed to send extension request'));
      }
    });
  }

  settle(key, outcome, value) {
    key = String(key);
    const pending = this.pendingRequests.get(key);
    if (!pending) return false;
    this.pendingRequests.delete(key);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    if (outcome === 'resolve') pending.resolve(value);
    else pending.reject(errorFrom(value, 'Extension request failed'));
    return true;
  }

  handleResponse(message, ws) {
    if (!message || message.requestId === undefined || message.requestId === null) return 'unknown';
    const key = String(message.requestId);
    const pending = this.pendingRequests.get(key);
    if (!pending) return 'unknown';
    if (pending.ws !== ws) return 'wrong-socket';

    if (message.error !== undefined && message.error !== null && message.error !== '') {
      this.settle(key, 'reject', errorFrom(message.error, 'Extension transport failed'));
    } else if (!isArpEnvelope(message.envelope)) {
      this.settle(key, 'reject', new Error('Extension returned an invalid ARP/1 Envelope'));
    } else {
      this.settle(key, 'resolve', message.envelope);
    }
    return 'settled';
  }

  rejectForSocket(ws, reason) {
    let rejected = 0;
    for (const [key, pending] of Array.from(this.pendingRequests.entries())) {
      if (pending.ws !== ws) continue;
      if (this.settle(key, 'reject', errorFrom(reason, 'Extension client disconnected'))) rejected++;
    }
    return rejected;
  }

  close(reason) {
    if (this.closed) return 0;
    this.closed = true;
    let rejected = 0;
    for (const key of Array.from(this.pendingRequests.keys())) {
      if (this.settle(key, 'reject', errorFrom(reason, 'Extension request broker closed'))) rejected++;
    }
    return rejected;
  }
}

module.exports = {
  ARP_METHODS,
  ExtensionRequestBroker,
  abortError,
  errorFrom,
  isArpEnvelope,
  normalizeTransportContext,
};
