(function attachPageAutomationResourceClient(root, factory) {
  'use strict';

  var runtimeClient = root && root.PageAutomationRuntimeClient;
  if (typeof module === 'object' && module.exports) {
    runtimeClient = runtimeClient || require('./runtime-client.js');
  }
  var api = factory(runtimeClient);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationResourceClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RuntimeClient) {
  'use strict';

  var MESSAGE_TYPE = 'ARP_RESOURCE_REQUEST';
  var METHODS = Object.freeze({ GET: true, POST: true, PUT: true, PATCH: true, DELETE: true, OPTIONS: true });
  var CONTEXT_KEYS = Object.freeze({ requestTag: true });
  var SECURITY_CONTEXT_KEYS = Object.freeze({
    actor: true, actorId: true, conversation: true, conversationId: true,
    entry: true, entryContext: true, tabId: true, currentTabId: true,
    windowId: true, currentWindowId: true, origin: true,
    permissionScope: true, permissions: true, currentResource: true,
    visibleResourceUris: true, incognito: true,
  });
  var REQUEST_KEYS = Object.freeze({
    GET: Object.freeze({ uri: true, ifNoneMatch: true }),
    POST: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, body: true }),
    PUT: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, body: true }),
    PATCH: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, contentType: true, patch: true }),
    DELETE: Object.freeze({ uri: true, preconditions: true, idempotencyKey: true, body: true }),
    OPTIONS: Object.freeze({ uri: true, match: true, relation: true, cursor: true, limit: true }),
  });
  var PRECONDITION_KEYS = Object.freeze({ ifMatch: true, ifNoneMatch: true });
  var PATCH_MEDIA_TYPES = Object.freeze({
    'application/merge-patch+json': true,
  });
  var ENVELOPE_KEYS = Object.freeze({
    protocol: true, requestId: true, status: true, primary: true, included: true,
    receipt: true, capabilities: true, error: true, trace: true, warnings: true,
  });
  var REPRESENTATION_KEYS = Object.freeze({ uri: true, type: true, data: true, links: true, etag: true });
  var LINK_KEYS = Object.freeze({ rel: true, href: true, method: true, title: true });
  var RECEIPT_KEYS = Object.freeze({
    performed: true, operationUri: true, state: true, retryAfterMs: true, idempotencyKey: true,
    verificationStatus: true, conditionMet: true,
    actionId: true, source: true, tabId: true, kind: true, status: true,
    inputProvenance: true, trustedEventExpected: true, targetRef: true,
    actionFacts: true, verification: true,
    navigation: true, newNavigationTarget: true, targetTabId: true, targetDisposition: true,
    targetUrl: true, targetActive: true, browserFacts: true,
    startedAt: true, completedAt: true, durationMs: true, warnings: true,
  });
  var CAPABILITIES_KEYS = Object.freeze({ mediaType: true, scope: true, layer: true, resources: true, descriptors: true, nextCursor: true, match: true });
  var CAPABILITY_RESOURCE_KEYS = Object.freeze({ href: true, type: true, relation: true });
  var DESCRIPTOR_KEYS = Object.freeze({
    schemaVersion: true, method: true, href: true,
    routeTemplate: true, relation: true, summary: true,
    inputSchema: true, outputSchema: true, safety: true, idempotency: true,
    execution: true, requiredPermissions: true,
    requiredPreconditions: true, patchMediaTypes: true,
    deprecated: true,
  });
  var ERROR_KEYS = Object.freeze({ code: true, message: true, retryable: true, stage: true, trace: true, details: true, current: true });
  var requestSequence = 0;

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function cloneJson(value, label) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch (error) {
      throw new TypeError((label || 'value') + ' must be JSON serializable: ' + error.message);
    }
  }

  function normalizeMethod(value) {
    var method = text(value).toUpperCase();
    if (!METHODS[method]) throw new TypeError('Unsupported ARP resource method: ' + method);
    return method;
  }

  function readableEncodeSegment(value) {
    return Array.from(String(value)).map(function (character) {
      if (/^[A-Za-z0-9._~!$&'()*+,;=:@-]$/.test(character)
          || (character.charCodeAt(0) > 0x7f && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(character))) return character;
      return encodeURIComponent(character);
    }).join('');
  }

  function normalizeUri(value) {
    if (typeof value !== 'string') throw new TypeError('ARP resource uri must be a string');
    var uri = value;
    if (uri !== uri.trim()) throw new TypeError('ARP resource uri must not contain surrounding whitespace');
    if (!uri || uri.charAt(0) !== '/' || /[?#\\\s\u0000-\u001F\u007F-\u009F]/.test(uri)
        || uri.indexOf('//') !== -1 || uri.length > 12000) {
      throw new TypeError('ARP resource uri must be a canonical absolute path');
    }
    if (uri === '/') return uri;
    if (uri.charAt(uri.length - 1) === '/') throw new TypeError('ARP resource uri must not have a trailing slash');
    var segments = uri.slice(1).split('/').map(function (segment) {
      if (!segment || /%(?![0-9A-Fa-f]{2})/.test(segment)) throw new TypeError('ARP resource uri contains an invalid segment');
      var decoded;
      try { decoded = decodeURIComponent(segment); } catch (_) { throw new TypeError('ARP resource uri has invalid percent encoding'); }
      if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001F\u007F]/.test(decoded)
          || /%[0-9A-Fa-f]{2}/.test(decoded)) {
        throw new TypeError('ARP resource uri contains a traversal or double-encoded segment');
      }
      return readableEncodeSegment(decoded);
    });
    return '/' + segments.join('/');
  }

  function encodeReadableQueryComponent(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/%/g, '%25')
      .replace(/\+/g, '%2B')
      .replace(/[\s\u0000-\u001F\u007F-\u009F]/gu, function (character) {
        return character === ' ' ? '+' : encodeURIComponent(character);
      })
      .replace(/[&#=]/g, function (character) { return encodeURIComponent(character); });
  }

  function queryStringFromObject(value) {
    if (!isRecord(value)) throw new TypeError('GET query must be an object');
    var pairs = [];
    Object.keys(value).forEach(function (key) {
      var items = Array.isArray(value[key]) ? value[key] : [value[key]];
      items.forEach(function (item) {
        if (item === null || isRecord(item) || Array.isArray(item)) {
          throw new TypeError('GET query values must be scalars; arrays use repeated parameter names: ' + key);
        }
        pairs.push(encodeReadableQueryComponent(key) + '=' + encodeReadableQueryComponent(String(item)));
      });
    });
    return pairs.join('&');
  }

  function normalizeRequestTarget(method, value) {
    if (typeof value !== 'string') throw new TypeError('ARP request-target must be a string');
    var raw = value;
    if (raw !== raw.trim()) throw new TypeError('ARP request-target must not contain surrounding whitespace');
    var queryIndex = raw.indexOf('?');
    if (queryIndex === -1) return normalizeUri(raw);
    if (method !== 'GET') throw new TypeError(method + ' ARP request-target cannot contain a query component');
    if (raw.indexOf('#') !== -1 || /\s|[\\\u0000-\u001F\u007F-\u009F]/.test(raw)) {
      throw new TypeError('ARP GET request-target contains forbidden characters');
    }
    var query = raw.slice(queryIndex + 1);
    if (!query) return normalizeUri(raw.slice(0, queryIndex));
    var normalizedPairs = [];
    query.split('&').filter(Boolean).forEach(function (pair) {
      var separator = pair.indexOf('=');
      var parts = [separator === -1 ? pair : pair.slice(0, separator), separator === -1 ? '' : pair.slice(separator + 1)];
      var decoded = parts.map(function (part) {
        if (/%(?![0-9A-Fa-f]{2})/.test(part)) throw new TypeError('ARP GET request-target contains invalid percent encoding');
        try { return decodeURIComponent(part.replace(/\+/g, ' ')); } catch (_) { throw new TypeError('ARP GET request-target contains invalid percent encoding'); }
      });
      if (!decoded[0]) throw new TypeError('ARP GET request-target contains an empty parameter name');
      normalizedPairs.push(encodeReadableQueryComponent(decoded[0]) + '=' + encodeReadableQueryComponent(decoded[1]));
    });
    var path = normalizeUri(raw.slice(0, queryIndex));
    return normalizedPairs.length ? path + '?' + normalizedPairs.join('&') : path;
  }

  function buildGetRequestTarget(uri, query) {
    var target = normalizeRequestTarget('GET', uri);
    if (query === undefined) return target;
    var queryString = queryStringFromObject(query);
    if (!queryString) return target;
    if (target.indexOf('?') !== -1) {
      throw new TypeError('Do not combine a GET request-target query component with the helper query option');
    }
    return target + '?' + queryString;
  }

  function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function assertAllowedKeys(value, allowed, label) {
    if (!isRecord(value)) throw new TypeError(label + ' must be an object');
    Object.keys(value).forEach(function (key) {
      if (allowed[key]) return;
      if (SECURITY_CONTEXT_KEYS[key]) throw new TypeError('ARP UI security context is background-owned: ' + key);
      throw new TypeError(label + ' contains an unsupported field: ' + key);
    });
    return value;
  }

  function assertString(value, label, options) {
    options = options || {};
    if (typeof value !== 'string' || (options.trim !== false && value !== value.trim())
        || (options.nonEmpty !== false && !value.length)
        || value.length > (options.maxLength || 12000)) {
      throw new TypeError(label + ' must be a bounded non-empty string');
    }
    return value;
  }

  function assertStringArray(value, label) {
    if (!Array.isArray(value) || value.length > 1000) throw new TypeError(label + ' must be a bounded string array');
    value.forEach(function (item) { assertString(item, label + ' item', { maxLength: 12000 }); });
    return value;
  }

  function validatePreconditions(value) {
    assertAllowedKeys(value, PRECONDITION_KEYS, 'ARP preconditions');
    Object.keys(value).forEach(function (key) { assertString(value[key], 'ARP preconditions.' + key, { maxLength: 12000 }); });
    return value;
  }

  function validateRequest(method, request) {
    method = normalizeMethod(method);
    assertAllowedKeys(request, REQUEST_KEYS[method], method + ' request');
    request.uri = normalizeRequestTarget(method, request.uri);
    if (request.uri.split('?')[0] === '/' && method !== 'OPTIONS') throw new TypeError('The ARP root is OPTIONS-only');
    if (request.ifNoneMatch !== undefined) assertString(request.ifNoneMatch, 'ifNoneMatch', { maxLength: 12000 });
    if (request.preconditions !== undefined) validatePreconditions(request.preconditions);
    if (request.idempotencyKey !== undefined) {
      assertString(request.idempotencyKey, 'idempotencyKey', { maxLength: 256 });
      if (request.idempotencyKey.length < 8) throw new TypeError('idempotencyKey must contain at least 8 characters');
    }
    if (method === 'PATCH' && request.contentType !== undefined && !PATCH_MEDIA_TYPES[request.contentType]) {
      throw new TypeError('PATCH contentType is not supported');
    }
    if (method === 'PUT' && !Object.prototype.hasOwnProperty.call(request, 'body')) {
      throw new TypeError('PUT request requires body');
    }
    if (method === 'PATCH' && !Object.prototype.hasOwnProperty.call(request, 'patch')) {
      throw new TypeError('PATCH request requires patch');
    }
    if (method === 'OPTIONS') {
      ['match', 'relation', 'cursor'].forEach(function (key) {
        if (request[key] !== undefined) assertString(request[key], 'OPTIONS ' + key, { maxLength: key === 'match' ? 1000 : 200 });
      });
      if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 4)) {
        throw new TypeError('OPTIONS limit must be an integer from 1 to 4');
      }
    }
    return request;
  }

  function normalizeContext(value) {
    if (value === undefined || value === null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('ARP UI context must be an object');
    }
    var output = {};
    Object.keys(value).forEach(function (key) {
      if (!CONTEXT_KEYS[key]) throw new TypeError('ARP UI security context is background-owned: ' + key);
      var requestTag = text(value[key]);
      if (requestTag.length > 160) throw new TypeError('ARP UI requestTag is too long');
      if (requestTag) output.requestTag = requestTag;
    });
    return output;
  }

  function validateLink(value, label) {
    assertAllowedKeys(value, LINK_KEYS, label);
    assertString(value.rel, label + '.rel', { maxLength: 200 });
    var method = normalizeMethod(value.method);
    normalizeRequestTarget(method, value.href);
    if (value.title !== undefined && typeof value.title !== 'string') throw new TypeError(label + '.title must be a string');
  }

  function validateRepresentation(value, label) {
    assertAllowedKeys(value, REPRESENTATION_KEYS, label);
    normalizeUri(value.uri);
    assertString(value.type, label + '.type', { maxLength: 300 });
    if (!Object.prototype.hasOwnProperty.call(value, 'data')) throw new TypeError(label + '.data is required');
    if (!Array.isArray(value.links) || value.links.length > 1000) throw new TypeError(label + '.links must be a bounded array');
    value.links.forEach(function (link, index) { validateLink(link, label + '.links[' + index + ']'); });
    if (value.etag !== undefined) assertString(value.etag, label + '.etag', { maxLength: 12000 });
  }

  function validateDescriptor(value, label) {
    assertAllowedKeys(value, DESCRIPTOR_KEYS, label);
    assertString(value.schemaVersion, label + '.schemaVersion', { maxLength: 512 });
    var method = normalizeMethod(value.method);
    if (method === 'OPTIONS') throw new TypeError(label + '.method must be a resource method');
    if (value.routeTemplate !== undefined) {
      assertString(value.routeTemplate, label + '.routeTemplate', { maxLength: 12000 });
      if (value.href !== value.routeTemplate || method !== 'POST') throw new TypeError(label + ' has an invalid route-template descriptor');
    } else normalizeUri(value.href);
    assertString(value.relation, label + '.relation', { maxLength: 300 });
    assertString(value.summary, label + '.summary', { maxLength: 12000 });
    ['inputSchema', 'outputSchema'].forEach(function (key) {
      if (value[key] !== undefined && value[key] !== true && value[key] !== false && !isRecord(value[key])) {
        throw new TypeError(label + '.' + key + ' must be a JSON Schema object or boolean');
      }
    });
    if (['safe', 'read', 'write', 'execute', 'privileged'].indexOf(value.safety) === -1
        || ['inherent', 'keyed', 'none'].indexOf(value.idempotency) === -1
        || ['sync', 'async', 'either'].indexOf(value.execution) === -1) {
      throw new TypeError(label + ' contains an invalid policy value');
    }
    assertStringArray(value.requiredPermissions, label + '.requiredPermissions');
    assertStringArray(value.requiredPreconditions, label + '.requiredPreconditions');
    if (value.patchMediaTypes !== undefined) {
      assertStringArray(value.patchMediaTypes, label + '.patchMediaTypes');
      value.patchMediaTypes.forEach(function (mediaType) {
        if (!PATCH_MEDIA_TYPES[mediaType]) throw new TypeError(label + ' advertises an unsupported PATCH media type');
      });
    }
  }

  function validateCapabilities(value) {
    assertAllowedKeys(value, CAPABILITIES_KEYS, 'ARP capabilities');
    if (value.mediaType !== 'application/vnd.page-agent.capabilities+json') throw new TypeError('ARP capabilities mediaType is invalid');
    normalizeUri(value.scope);
    if (['root', 'namespace', 'match', 'resource', 'entry'].indexOf(value.layer) === -1) throw new TypeError('ARP capabilities layer is invalid');
    if (!Array.isArray(value.resources) || value.resources.length > 1000) throw new TypeError('ARP capabilities.resources must be bounded');
    value.resources.forEach(function (resource, index) {
      assertAllowedKeys(resource, CAPABILITY_RESOURCE_KEYS, 'ARP capabilities.resources[' + index + ']');
      normalizeUri(resource.href);
      assertString(resource.type, 'ARP capability resource type', { maxLength: 300 });
      if (resource.relation !== undefined) assertString(resource.relation, 'ARP capability resource relation', { maxLength: 300 });
    });
    if (!Array.isArray(value.descriptors) || value.descriptors.length > 4) throw new TypeError('ARP capabilities.descriptors must contain at most 4 entries');
    value.descriptors.forEach(function (descriptor, index) { validateDescriptor(descriptor, 'ARP capabilities.descriptors[' + index + ']'); });
    if (value.nextCursor !== undefined) assertString(value.nextCursor, 'ARP capabilities.nextCursor', { maxLength: 200 });
    if (value.match !== undefined) assertString(value.match, 'ARP capabilities.match', { maxLength: 1000 });
  }

  function validateEnvelope(value) {
    assertAllowedKeys(value, ENVELOPE_KEYS, 'ARP Resource Envelope');
    if (value.protocol !== 'arp/1') throw new TypeError('ARP Resource Envelope protocol is invalid');
    assertString(value.requestId, 'ARP requestId', { maxLength: 512 });
    assertAllowedKeys(value.status, Object.freeze({ code: true, reason: true }), 'ARP status');
    if (!Number.isInteger(value.status.code) || value.status.code < 100 || value.status.code > 599) throw new TypeError('ARP status.code is invalid');
    assertString(value.status.reason, 'ARP status.reason', { maxLength: 300 });
    if (value.primary !== undefined) validateRepresentation(value.primary, 'ARP primary');
    if (value.included !== undefined) {
      if (!Array.isArray(value.included) || value.included.length > 1000) throw new TypeError('ARP included must be a bounded array');
      value.included.forEach(function (item, index) { validateRepresentation(item, 'ARP included[' + index + ']'); });
    }
    if (value.receipt !== undefined) {
      assertAllowedKeys(value.receipt, RECEIPT_KEYS, 'ARP receipt');
      if (['yes', 'no', 'unknown'].indexOf(value.receipt.performed) === -1) throw new TypeError('ARP receipt.performed is invalid');
      if (value.receipt.operationUri !== undefined) normalizeUri(value.receipt.operationUri);
      if (value.receipt.state !== undefined && ['queued', 'running', 'succeeded', 'unconfirmed', 'failed', 'cancelled'].indexOf(value.receipt.state) === -1) throw new TypeError('ARP receipt.state is invalid');
      if (value.receipt.retryAfterMs !== undefined && (!Number.isFinite(value.receipt.retryAfterMs) || value.receipt.retryAfterMs < 0)) throw new TypeError('ARP receipt.retryAfterMs is invalid');
      if (value.receipt.idempotencyKey !== undefined) assertString(value.receipt.idempotencyKey, 'ARP receipt.idempotencyKey', { maxLength: 256 });
    }
    if (value.capabilities !== undefined) validateCapabilities(value.capabilities);
    if (value.error !== undefined) {
      assertAllowedKeys(value.error, ERROR_KEYS, 'ARP error');
      assertString(value.error.code, 'ARP error.code', { maxLength: 300 });
      assertString(value.error.message, 'ARP error.message', { maxLength: 12000 });
      if (typeof value.error.retryable !== 'boolean') throw new TypeError('ARP error.retryable must be boolean');
      if (value.error.current !== undefined) validateRepresentation(value.error.current, 'ARP error.current');
    }
    if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 1000)) throw new TypeError('ARP warnings must be a bounded array');
    if (value.status.code >= 400 && value.error === undefined) throw new TypeError('Failed ARP Resource Envelope must contain error');
    if (value.status.code < 400 && value.error !== undefined) throw new TypeError('Successful ARP Resource Envelope cannot contain error');
    return value;
  }

  function isEnvelope(value) {
    try { validateEnvelope(value); return true; } catch (_) { return false; }
  }

  function ResourceClientError(message, options) {
    options = options || {};
    this.name = 'ResourceClientError';
    this.message = text(message || options.code || 'ARP resource request failed');
    this.code = text(options.code || 'RESOURCE_CLIENT_ERROR');
    this.status = Math.max(0, Number(options.status) || 0);
    this.retryable = options.retryable === true;
    this.performed = text(options.performed || 'no');
    this.transport = options.transport === true;
    this.envelope = options.envelope || null;
    this.stage = options.stage;
    this.trace = options.trace;
    this.details = options.details;
    this.current = options.current;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ResourceClientError);
  }
  ResourceClientError.prototype = Object.create(Error.prototype);
  ResourceClientError.prototype.constructor = ResourceClientError;

  function transportError(response) {
    response = response || {};
    return new ResourceClientError(response.error || 'ARP resource transport failed', {
      code: response.errorKind || response.reason || 'ARP_RESOURCE_TRANSPORT_ERROR',
      retryable: response.retryable === true,
      transport: true,
      performed: 'unknown',
    });
  }

  function envelopeError(envelope) {
    var error = envelope && envelope.error || {};
    var receipt = envelope && envelope.receipt || {};
    var message = error.message || envelope && envelope.status && envelope.status.reason || 'ARP resource request failed';
    // Surface field-level schema errors ("$.x is not allowed") in the message:
    // UI surfaces cannot adjust a rejected payload, so the toast must name the field.
    var detailErrors = error.details && Array.isArray(error.details.errors) ? error.details.errors : [];
    if (detailErrors.length) {
      message += '（' + detailErrors.slice(0, 3).map(function (item) { return String(item); }).join('；')
        + (detailErrors.length > 3 ? '；…' : '') + '）';
    }
    return new ResourceClientError(message, {
      code: error.code || 'ARP_RESOURCE_ERROR',
      status: envelope && envelope.status && envelope.status.code,
      retryable: error.retryable === true,
      performed: receipt.performed || 'no',
      envelope: envelope,
      stage: error.stage,
      trace: error.trace || envelope && envelope.trace,
      details: error.details,
      current: error.current,
    });
  }

  function generatedIdempotencyKey(cryptoObject) {
    requestSequence += 1;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return 'ui_' + cryptoObject.randomUUID();
    }
    return 'ui_' + Date.now().toString(36) + '_' + requestSequence.toString(36)
      + '_' + Math.random().toString(36).slice(2, 12);
  }

  function copyDefined(target, source, keys) {
    source = source || {};
    keys.forEach(function (key) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') target[key] = source[key];
    });
    return target;
  }

  function create(runtimeOrOptions) {
    var explicitOptions = runtimeOrOptions && typeof runtimeOrOptions === 'object'
      && (Object.prototype.hasOwnProperty.call(runtimeOrOptions, 'runtime')
        || Object.prototype.hasOwnProperty.call(runtimeOrOptions, 'transport')
        || Object.prototype.hasOwnProperty.call(runtimeOrOptions, 'crypto'));
    var options = explicitOptions
      ? runtimeOrOptions
      : { runtime: runtimeOrOptions };
    var runtime = options.runtime || (typeof chrome !== 'undefined' && chrome.runtime) || null;
    var transport = options.transport;
    if (typeof transport !== 'function') {
      if (!RuntimeClient || typeof RuntimeClient.create !== 'function') {
        throw new Error('PageAutomationRuntimeClient must load before PageAutomationResourceClient');
      }
      transport = RuntimeClient.create(runtime).send;
    }
    var cryptoObject = options.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    var etags = Object.create(null);

    function rememberEnvelope(request, envelope) {
      var primary = envelope && envelope.primary;
      var etag = text(primary && primary.etag);
      if (!etag) return envelope;
      var requestedUri = text(request && request.uri);
      var canonicalUri = text(primary && primary.uri);
      if (requestedUri) etags[requestedUri] = etag;
      if (canonicalUri) etags[canonicalUri] = etag;
      return envelope;
    }

    function dispatch(method, request, context) {
      method = normalizeMethod(method);
      request = cloneJson(request, 'ARP resource request');
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return Promise.reject(new TypeError('ARP resource request must be an object'));
      }
      try { validateRequest(method, request); }
      catch (error) { return Promise.reject(error); }
      var wireContext = normalizeContext(context);
      return Promise.resolve(transport(MESSAGE_TYPE, {
        method: method,
        request: request,
        context: wireContext,
      })).then(function (response) {
        if (!response || response.ok !== true) throw transportError(response);
        var envelope = response.payload;
        if (!isEnvelope(envelope)) {
          throw new ResourceClientError('Background returned an invalid ARP Resource Envelope', {
            code: 'ARP_ENVELOPE_INVALID', transport: true, performed: 'unknown',
          });
        }
        return rememberEnvelope(request, envelope);
      });
    }

    function request(method, resourceRequest, context) {
      return dispatch(method, resourceRequest, context).then(function (envelope) {
        if (envelope.error || Number(envelope.status.code) >= 400) throw envelopeError(envelope);
        return envelope;
      });
    }

    function commonUnsafeRequest(uri, callOptions) {
      callOptions = callOptions || {};
      var output = { uri: normalizeUri(uri) };
      var preconditions = cloneJson(callOptions.preconditions || {}, 'ARP preconditions');
      var ifMatch = callOptions.ifMatch;
      if (ifMatch === true || ifMatch === 'cached') ifMatch = etags[output.uri] || '';
      if (callOptions.etag && !ifMatch) ifMatch = callOptions.etag;
      if (ifMatch) preconditions.ifMatch = String(ifMatch);
      copyDefined(preconditions, callOptions, ['ifNoneMatch']);
      if (Object.keys(preconditions).length) output.preconditions = preconditions;
      return output;
    }

    function get(uri, callOptions) {
      callOptions = callOptions || {};
      var input = { uri: buildGetRequestTarget(uri, callOptions.query) };
      copyDefined(input, callOptions, ['ifNoneMatch']);
      return request('GET', input, callOptions.context);
    }

    function post(uri, body, callOptions) {
      callOptions = callOptions || {};
      var input = commonUnsafeRequest(uri, callOptions);
      // The fixed POST envelope permits omission only for a RouteContract that
      // explicitly declares a closed empty object. Preserve that omission so
      // the Router can make the schema-level decision instead of turning it
      // into a misleading JSON null payload.
      if (body !== undefined) input.body = cloneJson(body, 'POST body');
      input.idempotencyKey = text(callOptions.idempotencyKey)
        || generatedIdempotencyKey(cryptoObject);
      return request('POST', input, callOptions.context);
    }

    function put(uri, body, callOptions) {
      callOptions = callOptions || {};
      var input = commonUnsafeRequest(uri, callOptions);
      input.body = cloneJson(body, 'PUT body');
      if (callOptions.idempotencyKey) input.idempotencyKey = text(callOptions.idempotencyKey);
      return request('PUT', input, callOptions.context);
    }

    function patch(uri, value, callOptions) {
      callOptions = callOptions || {};
      var input = commonUnsafeRequest(uri, callOptions);
      input.patch = cloneJson(value, 'PATCH document');
      if (text(callOptions.contentType)) input.contentType = text(callOptions.contentType);
      input.idempotencyKey = text(callOptions.idempotencyKey)
        || generatedIdempotencyKey(cryptoObject);
      return request('PATCH', input, callOptions.context);
    }

    function remove(uri, callOptions) {
      callOptions = callOptions || {};
      var input = commonUnsafeRequest(uri, callOptions);
      if (callOptions.body !== undefined) input.body = cloneJson(callOptions.body, 'DELETE body');
      if (callOptions.idempotencyKey) input.idempotencyKey = text(callOptions.idempotencyKey);
      return request('DELETE', input, callOptions.context);
    }

    function introspect(uri, criteria, callOptions) {
      criteria = criteria || {};
      callOptions = callOptions || {};
      var input = { uri: normalizeUri(uri) };
      copyDefined(input, criteria, ['match', 'relation', 'cursor', 'limit']);
      return request('OPTIONS', input, callOptions.context);
    }

    function descriptorFor(envelope, method, uri) {
      method = normalizeMethod(method);
      uri = normalizeUri(uri);
      var descriptors = envelope && envelope.capabilities && envelope.capabilities.descriptors;
      descriptors = Array.isArray(descriptors) ? descriptors : [];
      for (var index = 0; index < descriptors.length; index += 1) {
        if (descriptors[index] && descriptors[index].method === method && descriptors[index].href === uri) {
          return descriptors[index];
        }
      }
      return null;
    }

    function authorized(method, uri, invoke, callOptions) {
      method = normalizeMethod(method);
      uri = normalizeUri(uri);
      callOptions = Object.assign({}, callOptions || {});
      delete callOptions.criteria;
      if ((method === 'POST' || method === 'PATCH') && !text(callOptions.idempotencyKey)) {
        callOptions.idempotencyKey = generatedIdempotencyKey(cryptoObject);
      }
      return Promise.resolve(invoke(callOptions));
    }

    function authorizedPost(uri, body, callOptions) {
      return authorized('POST', uri, function (authorizedOptions) {
        return post(uri, body, authorizedOptions);
      }, callOptions);
    }

    function authorizedPut(uri, body, callOptions) {
      return authorized('PUT', uri, function (authorizedOptions) {
        return put(uri, body, authorizedOptions);
      }, callOptions);
    }

    function authorizedPatch(uri, patchDocument, callOptions) {
      return authorized('PATCH', uri, function (authorizedOptions) {
        return patch(uri, patchDocument, authorizedOptions);
      }, callOptions);
    }

    function authorizedDelete(uri, callOptions) {
      return authorized('DELETE', uri, function (authorizedOptions) {
        return remove(uri, authorizedOptions);
      }, callOptions);
    }

    return Object.freeze({
      dispatch: dispatch,
      request: request,
      get: get,
      post: post,
      put: put,
      patch: patch,
      delete: remove,
      options: introspect,
      introspect: introspect,
      authorized: authorized,
      authorizedPost: authorizedPost,
      authorizedPut: authorizedPut,
      authorizedPatch: authorizedPatch,
      authorizedDelete: authorizedDelete,
      etagFor: function (uri) { return etags[normalizeUri(uri)] || ''; },
      forgetEtag: function (uri) { delete etags[normalizeUri(uri)]; },
      descriptorFor: descriptorFor,
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    MESSAGE_TYPE: MESSAGE_TYPE,
    METHODS: METHODS,
    ResourceClientError: ResourceClientError,
    isEnvelope: isEnvelope,
    validateEnvelope: validateEnvelope,
    create: create,
  });
});
