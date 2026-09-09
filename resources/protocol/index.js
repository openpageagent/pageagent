// Agent Resource Protocol (ARP/1) package. Resource adapters live in their owning modules.
(function attachAgentResourceProtocol(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value
      && value.PROTOCOL === 'arp/1'
      && typeof value.createRouter === 'function'
      && typeof value.createToolDefinitions === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = !commonJs && root && root.AgentResourceProtocol;
  var schemaApi = null;
  var nodeCrypto = null;
  if (commonJs) {
    try { schemaApi = require('../mcp-tool-contract.js'); } catch (_) { schemaApi = null; }
    try { nodeCrypto = require('crypto'); } catch (_) { nodeCrypto = null; }
  } else if (root) {
    schemaApi = root.McpToolContract || null;
  }
  var api = isApi(existing) ? existing : factory(root, schemaApi, nodeCrypto);
  if (commonJs) module.exports = api;
  else if (root) root.AgentResourceProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, existingSchemaApi, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;
  var PROTOCOL = 'arp/1';
  var CAPABILITY_MEDIA_TYPE = 'application/vnd.page-agent.capabilities+json';
  var METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  var RESOURCE_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  var TOOL_NAMES = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ASK_USER']);
  // /page and /browser are aggregate roots. Every other first-level segment is
  // a concrete resource collection supplied by a registered adapter.
  var ROOT_NAMES = Object.freeze(['page', 'browser']);
  var RESOURCE_METHOD_SET = makeSet(RESOURCE_METHODS);
  var TOOL_NAME_SET = makeSet(TOOL_NAMES);
  var SAFETY_VALUES = makeSet(['safe', 'read', 'write', 'execute', 'privileged']);
  var IDEMPOTENCY_VALUES = makeSet(['inherent', 'keyed', 'none']);
  var EXECUTION_VALUES = makeSet(['sync', 'async', 'either']);
  var PRECONDITION_VALUES = makeSet(['if-match', 'if-none-match']);
  // ARP exposes one patch representation. Route schemas then describe exactly
  // which mutable resource fields that merge patch may contain.
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);
  var PATCH_MEDIA_TYPE_SET = makeSet(PATCH_MEDIA_TYPES);
  var PAGE_ACTION_TEMPLATES = Object.freeze([
    '/page/clicks',
    '/page/fills',
    '/page/selections',
    '/page/scrolls',
    '/page/drags',
    '/page/waits',
    '/page/media/{index}/artifacts',
  ]);
  var PAGE_ACTION_TEMPLATE_SET = makeSet(PAGE_ACTION_TEMPLATES);

  var ERROR_STATUS = Object.freeze({
    INVALID_REQUEST: 400,
    AUTHENTICATION_REQUIRED: 401,
    FORBIDDEN: 403,
    RESOURCE_NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    RESOURCE_CONFLICT: 409,
    IDEMPOTENCY_CONFLICT: 409,
    RESOURCE_GONE: 410,
    ETAG_MISMATCH: 412,
    UNSUPPORTED_MEDIA_TYPE: 415,
    SCHEMA_VALIDATION_FAILED: 422,
    PRECONDITION_REQUIRED: 428,
    RATE_LIMITED: 429,
    UPSTREAM_FAILED: 502,
    TEMPORARILY_UNAVAILABLE: 503,
    OPERATION_TIMEOUT: 504,
    INTERNAL_ERROR: 500,
  });

  var STATUS_REASONS = Object.freeze({
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Authentication Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    410: 'Gone',
    412: 'Precondition Failed',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Content',
    428: 'Precondition Required',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  });

  var ROOTS = Object.freeze([
    Object.freeze({ href: '/page', type: 'PageRoot' }),
    Object.freeze({ href: '/browser', type: 'BrowserRoot' }),
  ]);

  function makeSet(values) {
    var out = Object.create(null);
    values.forEach(function (value) { out[value] = true; });
    return out;
  }

  function hasOwn(value, key) {
    return !!(value
      && (typeof value === 'object' || typeof value === 'function')
      && Object.prototype.hasOwnProperty.call(value, key));
  }

  function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function cloneJsonOr(value, fallback) {
    try {
      var cloned = cloneJson(value);
      return cloned === undefined ? fallback : cloned;
    } catch (_) {
      return fallback;
    }
  }

  function performedOr(value, fallback) {
    var candidate = '';
    try { candidate = String(value || ''); } catch (_) { candidate = ''; }
    return /^(?:yes|no|unknown)$/.test(candidate) ? candidate : fallback;
  }

  function boundedErrorCause(error) {
    var name = 'Error';
    var message = 'Unknown ARP pipeline failure';
    try { name = String(error && error.name || name); } catch (_) {}
    try { message = String(error && error.message || error || message); } catch (_) {}
    return {
      name: name.slice(0, 120),
      message: message.slice(0, 1000),
    };
  }

  function stableValue(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('ARP values cannot contain circular references');
    seen.push(value);
    var out;
    if (Array.isArray(value)) {
      out = value.map(function (item) { return stableValue(item, seen); });
    } else {
      out = Object.create(null);
      Object.keys(value).sort().forEach(function (key) {
        out[key] = stableValue(value[key], seen);
      });
    }
    seen.pop();
    return out;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function nonEmptyString(value, name) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new TypeError(name + ' must be a non-empty string');
    return text;
  }

  function stringArray(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(name + ' must be an array');
    var seen = Object.create(null);
    return value.map(function (item) { return nonEmptyString(item, name + ' item'); }).filter(function (item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function nowIso(clock) {
    return new Date(Number(clock())).toISOString();
  }

  function strictEncodeSegment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  // ARP request-targets are presented to the model as readable IRIs. Preserve
  // Unicode and ordinary pchar characters; encode only delimiters, controls,
  // whitespace and percent signs that would change path parsing.
  function readableEncodeSegment(value) {
    return Array.from(String(value)).map(function (character) {
      if (/^[A-Za-z0-9._~!$&'()*+,;=:@-]$/.test(character)
          || (character.charCodeAt(0) > 0x7f && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(character))) return character;
      return encodeURIComponent(character);
    }).join('');
  }

  function normalizeContext(context) {
    context = context && typeof context === 'object' ? context : {};
    return {
      actorId: String(context.actorId || context.actor || ''),
      conversationId: String(context.conversationId || context.conversation || ''),
      entryContext: String(context.entryContext || context.entry || ''),
      origin: String(context.origin || ''),
      permissionScope: stringArray(context.permissionScope || context.permissions || [], 'context.permissionScope').sort(),
      currentResource: typeof context.currentResource === 'string' ? context.currentResource : '',
      visibleResourceUris: Array.isArray(context.visibleResourceUris) ? context.visibleResourceUris.slice() : [],
      currentTabId: Math.max(0, Math.floor(Number(context.currentTabId || context.tabId) || 0)),
      currentWindowId: Math.max(0, Math.floor(Number(context.currentWindowId || context.windowId) || 0)),
      raw: context,
    };
  }

  function routeMethodAllowedByContext(context, route, method) {
    var raw = context && context.raw && typeof context.raw === 'object' ? context.raw : context;
    var allowedRouteMethods = raw && raw.allowedRouteMethods;
    if (!allowedRouteMethods || typeof allowedRouteMethods !== 'object') return true;
    var methods = route && Array.isArray(allowedRouteMethods[route.template])
      ? allowedRouteMethods[route.template] : [];
    return methods.indexOf(String(method || '').toUpperCase()) !== -1;
  }

  function ArpError(code, message, options) {
    options = options || {};
    this.name = 'ArpError';
    this.code = String(code || 'INTERNAL_ERROR');
    this.message = String(message || this.code);
    this.status = Number(options.status || ERROR_STATUS[this.code] || 500);
    this.retryable = options.retryable === true;
    this.details = options.details;
    this.current = options.current;
    this.warnings = Array.isArray(options.warnings) ? cloneJsonOr(options.warnings, []) : [];
    this.performed = options.performed || 'no';
    this.idempotencyKey = options.idempotencyKey;
    this.stage = options.stage ? String(options.stage) : undefined;
    this.trace = options.trace ? cloneJsonOr(options.trace, undefined) : undefined;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ArpError);
  }
  ArpError.prototype = Object.create(Error.prototype);
  ArpError.prototype.constructor = ArpError;

  function arpError(code, message, options) {
    return new ArpError(code, message, options);
  }

  function statusReason(code, fallback) {
    return String(fallback || STATUS_REASONS[Number(code)] || 'Unknown');
  }

  function normalizeLink(link) {
    if (!isRecord(link)) throw new TypeError('Representation link must be an object');
    var method = nonEmptyString(link.method, 'link.method').toUpperCase();
    if (METHODS.indexOf(method) === -1) throw new TypeError('Unsupported link method: ' + method);
    var requestTarget = method === 'GET' ? parseRequestTarget(link.href, 'GET') : null;
    var out = {
      rel: nonEmptyString(link.rel, 'link.rel'),
      href: method === 'GET'
        ? buildRequestTarget(requestTarget.path, requestTarget.query)
        : canonicalizeUri(link.href, { allowRoot: method === 'OPTIONS' }),
      method: method,
    };
    if (link.title !== undefined) out.title = String(link.title);
    return out;
  }

  function normalizeRepresentation(value) {
    if (!isRecord(value)) throw new TypeError('Representation must be an object');
    var out = {
      uri: canonicalizeUri(value.uri),
      type: nonEmptyString(value.type, 'representation.type'),
      data: value.data === undefined ? null : cloneJson(value.data),
      links: (Array.isArray(value.links) ? value.links : []).map(normalizeLink),
    };
    if (value.etag !== undefined) out.etag = String(value.etag);
    return out;
  }

  function normalizeReceipt(value) {
    if (!isRecord(value)) throw new TypeError('receipt must be an object');
    var out = cloneJson(value);
    if (!/^(?:yes|no|unknown)$/.test(String(out.performed || ''))) {
      throw new TypeError('receipt.performed must be yes, no, or unknown');
    }
    if (out.operationUri !== undefined) out.operationUri = canonicalizeUri(out.operationUri);
    if (out.state !== undefined && ['queued', 'running', 'succeeded', 'unconfirmed', 'failed', 'cancelled'].indexOf(out.state) === -1) {
      throw new TypeError('receipt.state is invalid');
    }
    if (out.retryAfterMs !== undefined && (!Number.isFinite(Number(out.retryAfterMs)) || Number(out.retryAfterMs) < 0)) {
      throw new TypeError('receipt.retryAfterMs must be a non-negative finite number');
    }
    return out;
  }

  function createArpResponse(input) {
    input = input || {};
    var code = Number(input.status && input.status.code || input.statusCode || 200);
    var response = {
      protocol: PROTOCOL,
      requestId: nonEmptyString(input.requestId, 'response.requestId'),
      status: {
        code: code,
        reason: statusReason(code, input.status && input.status.reason || input.reason),
      },
    };
    if (input.primary !== undefined && input.primary !== null) response.primary = normalizeRepresentation(input.primary);
    if (Array.isArray(input.included) && input.included.length) response.included = input.included.map(normalizeRepresentation);
    if (input.receipt) response.receipt = normalizeReceipt(input.receipt);
    if (input.capabilities) response.capabilities = cloneJson(input.capabilities);
    if (input.error) response.error = cloneJson(input.error);
    if (input.trace) response.trace = cloneJson(input.trace);
    if (Array.isArray(input.warnings) && input.warnings.length) response.warnings = cloneJson(input.warnings);
    return response;
  }

  function responseWithTrace(response, trace) {
    var output = cloneJson(response);
    output.trace = cloneJson(trace);
    if (output.error) output.error.trace = cloneJson(trace);
    return output;
  }

  function createErrorResponse(requestId, error, overrides) {
    overrides = overrides || {};
    if (!(error instanceof ArpError)) {
      error = new ArpError('INTERNAL_ERROR', 'ARP request failed', {
        status: 500,
        retryable: false,
        performed: overrides.performed || 'unknown',
        details: { cause: boundedErrorCause(error) },
      });
    }
    var performedSource = hasOwn(overrides, 'performed') ? overrides.performed : error.performed;
    var performed = performedOr(performedSource, performedSource === undefined ? 'no' : 'unknown');
    var receiptPerformed = performed;
    var receipt;
    var idempotencyKey = overrides.idempotencyKey || error.idempotencyKey;
    var safeIdempotencyKey = '';
    try { safeIdempotencyKey = idempotencyKey ? String(idempotencyKey) : ''; } catch (_) {}
    try {
      receipt = Object.assign({ performed: performed }, isRecord(overrides.receipt) ? overrides.receipt : {});
      receiptPerformed = performedOr(receipt.performed, 'unknown');
      receipt.performed = receiptPerformed;
      if (safeIdempotencyKey) receipt.idempotencyKey = safeIdempotencyKey;
      receipt = normalizeReceipt(receipt);
    } catch (_) {
      receipt = { performed: receiptPerformed };
      if (safeIdempotencyKey) receipt.idempotencyKey = safeIdempotencyKey;
    }
    var code = 'INTERNAL_ERROR';
    var message = 'ARP request failed';
    try { code = String(error.code || code); } catch (_) {}
    try { message = String(error.message || message); } catch (_) {}
    var status;
    try { status = Number(error.status); } catch (_) { status = NaN; }
    if (!Number.isInteger(status) || status < 100 || status > 599) status = ERROR_STATUS[code] || 500;
    var detail = {
      code: code,
      message: message,
      retryable: error.retryable === true,
    };
    if (error.stage) detail.stage = String(error.stage);
    if (error.trace !== undefined) {
      var trace = cloneJsonOr(error.trace, undefined);
      if (trace !== undefined) detail.trace = trace;
    }
    if (error.details !== undefined) {
      var details = cloneJsonOr(error.details, undefined);
      if (details !== undefined) detail.details = details;
    }
    // `current` is optional. Several precondition resolvers intentionally use
    // null when they can return an ETag but not a safe resource projection.
    // Malformed diagnostic metadata must not mask the actionable ARP error.
    if (error.current !== undefined && error.current !== null) {
      try { detail.current = normalizeRepresentation(error.current); } catch (_) {}
    }
    var warnings = Array.isArray(error.warnings) ? cloneJsonOr(error.warnings, []) : [];
    return createArpResponse({
      requestId: requestId,
      statusCode: status,
      receipt: receipt,
      error: detail,
      trace: overrides.trace || error.trace,
      warnings: warnings,
    });
  }

  function isArpResponse(value) {
    return !!(isRecord(value)
      && value.protocol === PROTOCOL
      && isRecord(value.status)
      && typeof value.requestId === 'string');
  }

  function canonicalizeUri(input, options) {
    options = options || {};
    if (typeof input !== 'string' || !input) {
      throw arpError('INVALID_REQUEST', 'uri must be a non-empty absolute resource path');
    }
    if (input === '/') {
      if (options.allowRoot === false) throw arpError('INVALID_REQUEST', 'The API root is introspection-only');
      return '/';
    }
    if (input.charAt(0) !== '/' || input.indexOf('://') !== -1) {
      throw arpError('INVALID_REQUEST', 'uri must be an ARP absolute path, not a network URL');
    }
    if (/[?#\\]/.test(input) || input.indexOf('//') !== -1 || input.charAt(input.length - 1) === '/') {
      throw arpError('INVALID_REQUEST', 'uri is not canonical');
    }
    if (/\s|[\u0000-\u001F\u007F-\u009F]/.test(input)) throw arpError('INVALID_REQUEST', 'uri contains forbidden characters');
    var rawSegments = input.slice(1).split('/');
    if (!rawSegments.length) throw arpError('INVALID_REQUEST', 'uri must contain a resource segment');
    var canonicalSegments = rawSegments.map(function (rawSegment) {
      if (!rawSegment || /%(?![0-9A-Fa-f]{2})/.test(rawSegment)) {
        throw arpError('INVALID_REQUEST', 'uri contains an invalid encoded segment');
      }
      var decoded;
      try { decoded = decodeURIComponent(rawSegment); } catch (_) {
        throw arpError('INVALID_REQUEST', 'uri contains invalid percent encoding');
      }
      if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001F\u007F]/.test(decoded)) {
        throw arpError('INVALID_REQUEST', 'uri contains a traversal or root-escape segment');
      }
      if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
        throw arpError('INVALID_REQUEST', 'uri contains double encoding');
      }
      return readableEncodeSegment(decoded);
    });
    var canonical = '/' + canonicalSegments.join('/');
    return canonical;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compileRouteTemplate(input) {
    var template = nonEmptyString(input, 'route.template');
    if (template === '/' || template.charAt(0) !== '/' || /[?#\\]/.test(template)
        || template.indexOf('//') !== -1 || template.charAt(template.length - 1) === '/') {
      throw new TypeError('Invalid route template: ' + template);
    }
    var segments = template.slice(1).split('/');
    var parameterNames = [];
    var literalCount = 0;
    var patternParts = segments.map(function (segment, index) {
      var match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(segment);
      if (match) {
        if (index === 0) throw new TypeError('Route root cannot be a parameter');
        if (parameterNames.indexOf(match[1]) !== -1) throw new TypeError('Duplicate route parameter: ' + match[1]);
        parameterNames.push(match[1]);
        return '([^/]+)';
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) {
        throw new TypeError('Route literals must be lower-case kebab-case: ' + segment);
      }
      literalCount += 1;
      return escapeRegExp(segment);
    });
    var expression = new RegExp('^/' + patternParts.join('/') + '$');

    function matchUri(uri) {
      var canonical = canonicalizeUri(uri);
      var match = expression.exec(canonical);
      if (!match) return null;
      var params = Object.create(null);
      parameterNames.forEach(function (name, index) {
        params[name] = decodeURIComponent(match[index + 1]);
      });
      return params;
    }

    function build(params) {
      params = params || {};
      var uri = '/' + segments.map(function (segment) {
        var match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(segment);
        if (!match) return segment;
        if (!hasOwn(params, match[1])) throw new TypeError('Missing route parameter: ' + match[1]);
        return readableEncodeSegment(params[match[1]]);
      }).join('/');
      return canonicalizeUri(uri);
    }

    return Object.freeze({
      template: template,
      root: segments[0],
      segments: Object.freeze(segments.slice()),
      parameterNames: Object.freeze(parameterNames.slice()),
      literalCount: literalCount,
      specificity: literalCount * 100 + segments.length,
      match: matchUri,
      build: build,
    });
  }

  function validateJsonFallback(schema, value, path, errors, rootSchema, refs) {
    path = path || '$';
    errors = errors || [];
    rootSchema = rootSchema || schema || {};
    refs = refs || [];
    if (schema === true || schema === undefined || schema === null) return errors;
    if (schema === false) { errors.push(path + ' is rejected by schema'); return errors; }
    if (!isRecord(schema)) return errors;
    if (schema.$ref) {
      if (refs.indexOf(schema.$ref) !== -1) { errors.push(path + ' has circular $ref'); return errors; }
      var target = rootSchema;
      if (String(schema.$ref).indexOf('#/') !== 0) { errors.push(path + ' has unsupported $ref'); return errors; }
      String(schema.$ref).slice(2).split('/').forEach(function (part) {
        part = part.replace(/~1/g, '/').replace(/~0/g, '~');
        target = target && target[part];
      });
      if (target === undefined) { errors.push(path + ' has unresolved $ref'); return errors; }
      return validateJsonFallback(target, value, path, errors, rootSchema, refs.concat(schema.$ref));
    }
    if (Array.isArray(schema.allOf)) schema.allOf.forEach(function (branch) {
      validateJsonFallback(branch, value, path, errors, rootSchema, refs);
    });
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some(function (branch) {
      return validateJsonFallback(branch, value, path, [], rootSchema, refs).length === 0;
    })) errors.push(path + ' does not match anyOf');
    if (Array.isArray(schema.oneOf)) {
      var matches = schema.oneOf.filter(function (branch) {
        return validateJsonFallback(branch, value, path, [], rootSchema, refs).length === 0;
      }).length;
      if (matches !== 1) errors.push(path + ' must match exactly one oneOf branch');
    }
    var types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
    function typeMatches(type) {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') return isRecord(value);
      if (type === 'integer') return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
      if (type === 'number') return typeof value === 'number' && isFinite(value);
      return typeof value === type;
    }
    if (types.length && !types.some(typeMatches)) { errors.push(path + ' has the wrong type'); return errors; }
    if (hasOwn(schema, 'const') && stableStringify(value) !== stableStringify(schema.const)) errors.push(path + ' must equal const');
    if (Array.isArray(schema.enum) && !schema.enum.some(function (item) {
      return stableStringify(item) === stableStringify(value);
    })) errors.push(path + ' must match enum');
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < Number(schema.minLength)) errors.push(path + ' is too short');
      if (schema.maxLength !== undefined && value.length > Number(schema.maxLength)) errors.push(path + ' is too long');
      if (schema.pattern !== undefined && !(new RegExp(String(schema.pattern))).test(value)) errors.push(path + ' does not match pattern');
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < Number(schema.minimum)) errors.push(path + ' is below minimum');
      if (schema.maximum !== undefined && value > Number(schema.maximum)) errors.push(path + ' is above maximum');
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < Number(schema.minItems)) errors.push(path + ' has too few items');
      if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) errors.push(path + ' has too many items');
      if (schema.items) value.forEach(function (item, index) {
        validateJsonFallback(schema.items, item, path + '[' + index + ']', errors, rootSchema, refs);
      });
    }
    if (isRecord(value)) {
      var properties = isRecord(schema.properties) ? schema.properties : {};
      if (schema.minProperties !== undefined && Object.keys(value).length < Number(schema.minProperties)) {
        errors.push(path + ' has fewer than minProperties ' + schema.minProperties);
      }
      if (schema.maxProperties !== undefined && Object.keys(value).length > Number(schema.maxProperties)) {
        errors.push(path + ' has more than maxProperties ' + schema.maxProperties);
      }
      (Array.isArray(schema.required) ? schema.required : []).forEach(function (key) {
        if (!hasOwn(value, key)) errors.push(path + '.' + key + ' is required');
      });
      Object.keys(value).forEach(function (key) {
        if (hasOwn(properties, key)) validateJsonFallback(properties[key], value[key], path + '.' + key, errors, rootSchema, refs);
        else if (schema.additionalProperties === false) errors.push(path + '.' + key + ' is not allowed');
        else if (isRecord(schema.additionalProperties)) validateJsonFallback(schema.additionalProperties, value[key], path + '.' + key, errors, rootSchema, refs);
      });
    }
    return errors;
  }

  function validateJsonSchema(schema, value) {
    var errors;
    if (existingSchemaApi && typeof existingSchemaApi.validateJsonSchema === 'function') {
      errors = existingSchemaApi.validateJsonSchema(schema, value);
    } else {
      errors = validateJsonFallback(schema, value, '$', [], schema || {}, []);
    }
    return { valid: !errors.length, errors: errors.slice() };
  }

  function assertSchema(schema, value, label) {
    var validation = validateJsonSchema(schema === undefined ? true : schema, value);
    if (!validation.valid) throw arpError('SCHEMA_VALIDATION_FAILED', (label || 'value') + ' failed schema validation', {
      details: { errors: validation.errors.slice(0, 32) },
    });
    return value;
  }

  var PRECONDITIONS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      ifMatch: { type: 'string', minLength: 1 },
      ifNoneMatch: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

  function unsafeProperties(extra) {
    return Object.assign({
      uri: { type: 'string', minLength: 1 },
      preconditions: PRECONDITIONS_SCHEMA,
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 256 },
    }, extra || {});
  }

  var TOOL_DEFINITIONS = Object.freeze([
    Object.freeze({
      name: 'GET',
      description: '调用 RESTful ARP GET。GET 没有 body；uri 使用标准 Web request-target 形式 /path?query。path 只能来自当前路径目录、响应 link 或 OPTIONS，query 必须严格符合该路径已披露的 GET inputSchema；数组字段使用重复参数名，不把对象或数组 JSON 塞入 query。路径或 schema 未披露时不得猜测。默认返回路由声明的模型可见结果；只有需要协议元数据时才设置 responseMode="full"。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: {
          uri: { type: 'string', minLength: 1 },
          responseMode: { type: 'string', enum: ['content', 'full'] },
          ifNoneMatch: { type: 'string', minLength: 1 },
        },
        required: ['uri'],
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      name: 'POST',
      description: '调用 RESTful ARP POST。uri 必须来自当前路径目录、响应 link 或 OPTIONS；创建、交互、运行或执行的路由专用输入放入 body，并严格符合该路径已披露的 POST inputSchema。body 只能在当前契约明确为闭合空对象时省略。不得根据动作名称猜 URI 或 body 字段。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: unsafeProperties({ body: {} }),
        required: ['uri'],
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      name: 'PUT',
      description: '调用 RESTful ARP PUT，使用 body 中的完整表示创建或完全替换一个已知资源。uri 和 body schema 必须已经由路径目录及当前 RouteContract/OPTIONS 明确披露。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: unsafeProperties({ body: {} }),
        required: ['uri', 'body'],
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      name: 'PATCH',
      description: '调用 RESTful ARP PATCH。模型只需提供已知 uri、符合当前 RouteContract 的非空 merge-patch 对象和必需前置条件；contentType 可省略，Runtime 会确定性补全为 application/merge-patch+json。不得使用 body 代替 patch，也不得猜测字段。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: unsafeProperties({
          contentType: { type: 'string', enum: PATCH_MEDIA_TYPES.slice() },
          patch: {},
        }),
        required: ['uri', 'patch'],
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      name: 'DELETE',
      description: '调用 RESTful ARP DELETE，删除一个已明确指定地址的资源；DELETE 默认没有业务 body，只有当前 RouteContract 明确声明集合删除输入时才提供 body。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: unsafeProperties({ body: {} }),
        required: ['uri'],
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      name: 'OPTIONS',
      description: '调用 RESTful ARP OPTIONS。仅在路径或 schema 未知、当前路径目录只有模板而缺少真实 ID，或调用返回 404/405/422 时使用；对最窄已注册资源根匹配最多四个真实操作。OPTIONS 只披露合同，不读取业务数据，也不执行动作。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: {
          uri: { type: 'string', minLength: 1 },
          match: { type: 'string', minLength: 1, maxLength: 1000 },
          relation: { type: 'string', minLength: 1, maxLength: 200 },
          cursor: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 4 },
        },
        required: ['uri'],
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      name: 'ASK_USER',
      description: '请求当前上下文和本地可见资源无法提供、但会实质影响任务的用户事实或有限选项。',
      inputSchema: Object.freeze({
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['input', 'choice'] },
          prompt: { type: 'string', minLength: 1 },
          choices: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 },
                label: { type: 'string', minLength: 1 },
                description: { type: 'string' },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
          },
        },
        required: ['mode', 'prompt'],
        additionalProperties: false,
      }),
    }),
  ]);

  function createToolDefinitions() {
    return cloneJson(TOOL_DEFINITIONS);
  }

  function decodedQueryComponent(value) {
    try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
    catch (_) { throw arpError('INVALID_REQUEST', 'request-target query contains invalid percent encoding'); }
  }

  function parseQueryComponent(value) {
    var query = {};
    String(value || '').split('&').filter(Boolean).forEach(function (pair) {
      var separator = pair.indexOf('=');
      var key = decodedQueryComponent(separator === -1 ? pair : pair.slice(0, separator));
      var item = decodedQueryComponent(separator === -1 ? '' : pair.slice(separator + 1));
      if (!key) throw arpError('INVALID_REQUEST', 'request-target query contains an empty parameter name');
      if (!hasOwn(query, key)) query[key] = item;
      else if (Array.isArray(query[key])) query[key].push(item);
      else query[key] = [query[key], item];
    });
    return query;
  }

  function queryStringFromObject(value) {
    if (!isRecord(value)) return '';
    var pairs = [];
    Object.keys(value).forEach(function (key) {
      var items = Array.isArray(value[key]) ? value[key] : [value[key]];
      items.forEach(function (item) {
        if (item === null || isRecord(item) || Array.isArray(item)) {
          throw arpError('INVALID_REQUEST', 'GET query values must be scalars; arrays use repeated parameter names', {
            details: { field: key },
          });
        }
        pairs.push(encodeReadableQueryComponent(key) + '=' + encodeReadableQueryComponent(String(item)));
      });
    });
    return pairs.join('&');
  }

  // ARP request-targets are text sent directly to the model/runtime boundary.
  // Keep Unicode and JSON punctuation readable; encode only characters that
  // would change query parsing. The actual network URL layer may apply its own
  // final IRI/URI normalization after this protocol boundary.
  function encodeReadableQueryComponent(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/%/g, '%25')
      .replace(/\+/g, '%2B')
      .replace(/[\s\u0000-\u001F\u007F-\u009F]/gu, function (character) {
        return character === ' ' ? '+' : encodeURIComponent(character);
      })
      .replace(/[&#=]/g, function (character) { return encodeURIComponent(character); });
  }

  // Prepare only the current fixed ARP envelope. This hook deliberately does
  // not translate legacy field names or split query objects: the closed tool
  // schema must reject those inputs with a precise contract error.
  function prepareToolInput(method, input) {
    if (!isRecord(input)) return { input: input, warnings: [] };
    var prepared = cloneJson(input);
    if (method === 'PATCH' && typeof prepared.contentType === 'string'
        && !PATCH_MEDIA_TYPE_SET[prepared.contentType]) {
      throw arpError('UNSUPPORTED_MEDIA_TYPE', 'PATCH contentType is not supported by ARP/1', {
        details: { supported: PATCH_MEDIA_TYPES.slice() },
      });
    }
    return { input: prepared, warnings: [] };
  }

  function normalizeModelProjection(value) {
    value = value === undefined ? { type: 'data' } : value;
    if (!isRecord(value)) throw new TypeError('modelProjection must be an object');
    var type = String(value.type || 'data');
    if (type !== 'data' && type !== 'field') {
      throw new TypeError('modelProjection.type must be data or field');
    }
    var out = { type: type };
    if (type === 'field') out.field = nonEmptyString(value.field, 'modelProjection.field');
    ['includeLinks', 'includeIncluded'].forEach(function (key) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') {
        throw new TypeError('modelProjection.' + key + ' must be a boolean');
      }
      if (value[key] === true) out[key] = true;
    });
    return Object.freeze(out);
  }

  function assertFlatGetQueryValueSchema(schema, path) {
    if (!isRecord(schema)) throw new TypeError(path + ' must use an explicit JSON schema');
    if (schema.$ref) throw new TypeError(path + ' cannot use $ref; GET query fields must be explicit');
    var branches = [];
    if (Array.isArray(schema.oneOf)) branches = branches.concat(schema.oneOf);
    if (Array.isArray(schema.anyOf)) branches = branches.concat(schema.anyOf);
    if (branches.length) {
      branches.forEach(function (branch, index) {
        assertFlatGetQueryValueSchema(branch, path + ' branch ' + index);
      });
      return;
    }
    var types = Array.isArray(schema.type) ? schema.type.slice() : (schema.type ? [schema.type] : []);
    if (!types.length && (Array.isArray(schema.enum) || hasOwn(schema, 'const'))) {
      var values = Array.isArray(schema.enum) ? schema.enum : [schema.const];
      if (values.every(function (value) {
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      })) return;
    }
    if (!types.length) throw new TypeError(path + ' must declare a scalar or scalar-array type');
    types.forEach(function (type) {
      if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return;
      if (type === 'array') {
        if (!schema.items) throw new TypeError(path + ' array must declare scalar items');
        assertFlatGetQueryValueSchema(schema.items, path + ' items');
        return;
      }
      throw new TypeError(path + ' cannot contain object, nested array, or null values');
    });
  }

  function assertFlatGetQuerySchema(schema) {
    if (!isRecord(schema) || schema.type !== 'object' || schema.additionalProperties !== false) {
      throw new TypeError('GET inputSchema must be a closed object describing flat query parameters');
    }
    var properties = isRecord(schema.properties) ? schema.properties : {};
    Object.keys(properties).forEach(function (key) {
      assertFlatGetQueryValueSchema(properties[key], 'GET query field "' + key + '"');
    });
  }

  function normalizeMethodContract(method, value) {
    if (!isRecord(value)) throw new TypeError(method + ' method contract must be an object');
    ['outputSchema', 'safety', 'idempotency', 'execution', 'permissions', 'preconditions'].forEach(function (field) {
      if (!hasOwn(value, field)) throw new TypeError(method + ' method contract must declare ' + field);
    });
    var safety = String(value.safety);
    var idempotency = String(value.idempotency);
    var execution = String(value.execution);
    if (!SAFETY_VALUES[safety]) throw new TypeError('Invalid safety for ' + method + ': ' + safety);
    if (!IDEMPOTENCY_VALUES[idempotency]) throw new TypeError('Invalid idempotency for ' + method + ': ' + idempotency);
    if (!EXECUTION_VALUES[execution]) throw new TypeError('Invalid execution for ' + method + ': ' + execution);
    var preconditions = stringArray(value.preconditions || value.requiredPreconditions || [], method + '.preconditions');
    preconditions.forEach(function (item) {
      if (!PRECONDITION_VALUES[item]) throw new TypeError('Invalid precondition for ' + method + ': ' + item);
    });
    var patchMediaTypes;
    if (method === 'PATCH') {
      patchMediaTypes = stringArray(value.patchMediaTypes || [], 'PATCH.patchMediaTypes');
      if (!patchMediaTypes.length) throw new TypeError('PATCH contracts must advertise at least one patch media type');
      patchMediaTypes.forEach(function (item) {
        if (!PATCH_MEDIA_TYPE_SET[item]) throw new TypeError('Unsupported PATCH media type: ' + item);
      });
    } else if (value.patchMediaTypes !== undefined) {
      throw new TypeError('patchMediaTypes is only valid for PATCH');
    }
    var inputSchema = value.inputSchema === undefined ? true : cloneJson(value.inputSchema);
    // Existing item DELETE contracts use null to mean "no request body". Normalize
    // that shorthand to an actual JSON null schema now that DELETE may carry a
    // route-scoped body for conditional collection deletion.
    if (method === 'DELETE' && value.inputSchema === null) inputSchema = { type: 'null' };
    if (method === 'GET') assertFlatGetQuerySchema(inputSchema);
    if (isRecord(inputSchema) && isRecord(inputSchema.properties)) {
      ['action', 'operation', 'dispatch'].forEach(function (forbidden) {
        if (hasOwn(inputSchema.properties, forbidden)) {
          throw new TypeError('ARP route contracts cannot use a universal "' + forbidden + '" discriminator');
        }
      });
    }
    var out = {
      inputSchema: inputSchema,
      outputSchema: cloneJson(value.outputSchema),
      safety: safety,
      idempotency: idempotency,
      execution: execution,
      permissions: stringArray(value.permissions || value.requiredPermissions || [], method + '.permissions'),
      preconditions: preconditions,
      relation: String(value.relation || ''),
      summary: String(value.summary || ''),
      aliases: stringArray(value.aliases || [], method + '.aliases'),
      tags: stringArray(value.tags || [], method + '.tags'),
      guidance: stringArray(value.guidance || [], method + '.guidance'),
      modelProjection: normalizeModelProjection(value.modelProjection),
      deprecated: value.deprecated ? cloneJson(value.deprecated) : undefined,
    };
    if (value.prepareInput !== undefined) {
      throw new TypeError(method + ' method contract cannot define prepareInput; ARP only normalizes protocol-level, schema-preserving input');
    }
    if (patchMediaTypes) out.patchMediaTypes = patchMediaTypes;
    return Object.freeze(out);
  }

  function RouteContract(input) {
    if (!(this instanceof RouteContract)) return new RouteContract(input);
    input = input || {};
    this.compiled = compileRouteTemplate(input.template);
    this.template = this.compiled.template;
    this.root = this.compiled.root;
    this.resourceType = nonEmptyString(input.resourceType, 'route.resourceType');
    this.relation = String(input.relation || this.resourceType);
    this.summary = String(input.summary || this.resourceType);
    this.aliases = Object.freeze(stringArray(input.aliases || [], 'route.aliases'));
    this.tags = Object.freeze(stringArray(input.tags || [], 'route.tags'));
    this.guidance = Object.freeze(stringArray(input.guidance || [], 'route.guidance'));
    if (input.affordances !== undefined && !Array.isArray(input.affordances)) {
      throw new TypeError('route.affordances must be an array');
    }
    var affordances = (input.affordances || []).map(function (link) {
      return Object.freeze(normalizeLink(link));
    });
    this.entryWeights = Object.freeze(Object.assign({}, input.entryWeights || {}));
    this.deprecated = input.deprecated ? Object.freeze(cloneJson(input.deprecated)) : undefined;
    this.visible = typeof input.visible === 'function' ? input.visible : null;
    this.targetUris = typeof input.targetUris === 'function' ? input.targetUris : null;
    var methods = Object.create(null);
    var sourceMethods = input.methods || {};
    Object.keys(sourceMethods).forEach(function (method) {
      method = String(method).toUpperCase();
      if (!RESOURCE_METHOD_SET[method]) throw new TypeError('Route has unsupported method: ' + method);
      methods[method] = normalizeMethodContract(method, sourceMethods[method]);
    });
    if (!Object.keys(methods).length) throw new TypeError('Route must expose at least one resource method');
    this.methods = Object.freeze(methods);
    var contract = this;
    affordances.forEach(function (link) {
      if (link.method !== 'GET' || !contract.methods.GET || contract.compiled.parameterNames.length) return;
      var target = parseRequestTarget(link.href, 'GET');
      if (target.path !== contract.template) return;
      var query = coerceGetQueryValue(contract.methods.GET.inputSchema, target.query);
      var validation = validateJsonSchema(contract.methods.GET.inputSchema, query);
      if (!validation.valid) {
        throw new TypeError('Route GET affordance does not match its inputSchema: ' + link.href
          + ' (' + validation.errors.join('; ') + ')');
      }
    });
    this.affordances = Object.freeze(affordances);
    Object.freeze(this);
  }

  RouteContract.prototype.match = function (uri) { return this.compiled.match(uri); };
  RouteContract.prototype.build = function (params) { return this.compiled.build(params); };
  RouteContract.prototype.allowedMethods = function () { return Object.keys(this.methods); };

  function CapabilityDescriptor(input) {
    if (!(this instanceof CapabilityDescriptor)) return new CapabilityDescriptor(input);
    input = input || {};
    var method = nonEmptyString(input.method, 'capability.method').toUpperCase();
    if (!RESOURCE_METHOD_SET[method]) throw new TypeError('Capability method is invalid: ' + method);
    this.schemaVersion = String(input.schemaVersion || PROTOCOL);
    this.method = method;
    if (input.routeTemplate !== undefined) {
      this.routeTemplate = compileRouteTemplate(input.routeTemplate).template;
      if (!PAGE_ACTION_TEMPLATE_SET[this.routeTemplate]) {
        throw new TypeError('Route-template descriptors are restricted to declared page interaction routes');
      }
      if (method !== 'POST') throw new TypeError('Route-template descriptors only support POST');
      if (input.href !== undefined && String(input.href) !== this.routeTemplate) {
        throw new TypeError('Route-template descriptor href must equal routeTemplate');
      }
      this.href = this.routeTemplate;
    } else {
      this.href = canonicalizeUri(input.href);
    }
    this.relation = nonEmptyString(input.relation, 'capability.relation');
    this.summary = nonEmptyString(input.summary, 'capability.summary');
    this.inputSchema = input.inputSchema === undefined ? undefined : cloneJson(input.inputSchema);
    this.outputSchema = input.outputSchema === undefined ? undefined : cloneJson(input.outputSchema);
    this.safety = String(input.safety || 'safe');
    this.idempotency = String(input.idempotency || 'none');
    this.execution = String(input.execution || 'sync');
    this.requiredPermissions = Object.freeze(stringArray(input.requiredPermissions || [], 'capability.requiredPermissions'));
    this.requiredPreconditions = Object.freeze(stringArray(input.requiredPreconditions || [], 'capability.requiredPreconditions'));
    this.guidance = Object.freeze(stringArray(input.guidance || [], 'capability.guidance'));
    if (!SAFETY_VALUES[this.safety] || !IDEMPOTENCY_VALUES[this.idempotency]
        || !EXECUTION_VALUES[this.execution]) {
      throw new TypeError('Capability contains an invalid policy value');
    }
    if (input.patchMediaTypes !== undefined) {
      this.patchMediaTypes = Object.freeze(stringArray(input.patchMediaTypes, 'capability.patchMediaTypes'));
    }
    if (input.deprecated !== undefined) this.deprecated = Object.freeze(cloneJson(input.deprecated));
    assertPageActionTemplateDescriptor(this);
    Object.freeze(this);
  }

  function descriptorFromRoute(route, method, href, options) {
    var contract = route.methods[method];
    if (!contract) return null;
    options = options || {};
    var descriptor = {
      schemaVersion: PROTOCOL,
      method: method,
      href: options.routeTemplate ? route.template : href,
      relation: contract.relation || route.relation,
      summary: contract.summary || route.summary,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      safety: contract.safety,
      idempotency: contract.idempotency,
      execution: contract.execution,
      requiredPermissions: contract.permissions,
      requiredPreconditions: contract.preconditions,
      guidance: route.guidance.concat(contract.guidance || []),
      patchMediaTypes: contract.patchMediaTypes,
      deprecated: contract.deprecated || route.deprecated,
    };
    if (options.routeTemplate) {
      descriptor.routeTemplate = route.template;
    }
    return new CapabilityDescriptor(descriptor);
  }

  function validatedDynamicDescriptor(route, method, href, candidateInput) {
    var candidate = candidateInput instanceof CapabilityDescriptor
      ? candidateInput
      : new CapabilityDescriptor(candidateInput);
    var registered = descriptorFromRoute(route, method, href);
    if (!registered || candidate.method !== method || candidate.href !== href) {
      throw new TypeError('Dynamic capability must match the registered method and resource target');
    }
    [
      'relation',
      'outputSchema',
      'safety',
      'idempotency',
      'execution',
      'requiredPermissions',
      'requiredPreconditions',
      'patchMediaTypes',
      'deprecated',
    ].forEach(function (field) {
      var expected = registered[field] === undefined ? null : registered[field];
      var advertised = candidate[field] === undefined ? null : candidate[field];
      if (stableStringify(expected) !== stableStringify(advertised)) {
        throw new TypeError('Dynamic capability cannot change registered policy field: ' + field);
      }
    });
    if (candidate.guidance.length
        && stableStringify(candidate.guidance) !== stableStringify(registered.guidance)) {
      throw new TypeError('Dynamic capability cannot change registered guidance');
    }
    if (candidate.routeTemplate) throw new TypeError('Dynamic descriptor cannot create a route-template entry');
    var inherited = cloneJson(candidate);
    inherited.guidance = registered.guidance;
    return new CapabilityDescriptor(inherited);
  }

  function resolveExecutionDescriptor(resolved, method, request, context) {
    var registered = descriptorFromRoute(resolved.route, method, request.uri);
    if (typeof resolved.adapter.resolveCapabilityDescriptor !== 'function') return Promise.resolve(registered);
    return Promise.resolve(resolved.adapter.resolveCapabilityDescriptor(
      normalizeContext(context).raw,
      cloneJson(request),
      resolved.route
    )).then(function (value) {
      if (value === null || value === undefined) return registered;
      var candidate = value && value.descriptor ? value.descriptor : value;
      return validatedDynamicDescriptor(resolved.route, method, request.uri, candidate);
    });
  }

  function ResourceAdapter(rootName) {
    if (!(this instanceof ResourceAdapter)) return new ResourceAdapter(rootName);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(rootName || ''))) {
      throw new TypeError('Adapter root must be lower-case kebab-case');
    }
    this.root = rootName;
  }
  ResourceAdapter.prototype.routes = function () { return []; };
  ResourceAdapter.prototype.introspect = function () { return Promise.resolve([]); };

  function defineAdapter(input) {
    input = input || {};
    var adapter = new ResourceAdapter(input.root);
    ['routes', 'get', 'post', 'put', 'patch', 'delete', 'introspect'].forEach(function (name) {
      if (typeof input[name] === 'function') adapter[name] = input[name];
    });
    if (Array.isArray(input.routeContracts)) {
      var routes = input.routeContracts.slice();
      adapter.routes = function () { return routes.slice(); };
    }
    return adapter;
  }

  function validateAdapter(adapter) {
    if (!adapter || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(adapter.root || ''))) {
      throw new TypeError('ResourceAdapter must declare a lower-case kebab-case root');
    }
    if (typeof adapter.routes !== 'function') throw new TypeError('ResourceAdapter.routes must be a function');
    RESOURCE_METHODS.forEach(function (method) {
      var name = method.toLowerCase();
      if (adapter[name] !== undefined && typeof adapter[name] !== 'function') {
        throw new TypeError('ResourceAdapter.' + name + ' must be a function');
      }
    });
    if (adapter.introspect !== undefined && typeof adapter.introspect !== 'function') {
      throw new TypeError('ResourceAdapter.introspect must be a function');
    }
    return adapter;
  }

  function ResourceRegistry(options) {
    if (!(this instanceof ResourceRegistry)) return new ResourceRegistry(options);
    options = options || {};
    this.adapters = Object.create(null);
    this.routes = [];
    this.canDiscover = typeof options.canDiscover === 'function' ? options.canDiscover : null;
  }

  ResourceRegistry.prototype.register = function (adapter) {
    validateAdapter(adapter);
    if (this.adapters[adapter.root]) throw new TypeError('Adapter already registered for root: ' + adapter.root);
    var contracts = adapter.routes();
    if (!Array.isArray(contracts)) throw new TypeError('ResourceAdapter.routes must return an array');
    var normalized = contracts.map(function (value) {
      var route = value instanceof RouteContract ? value : new RouteContract(value);
      if (route.root !== adapter.root) throw new TypeError('Route root does not match adapter root: ' + route.template);
      return route;
    });
    var existing = Object.create(null);
    this.routes.forEach(function (entry) { existing[entry.route.template] = true; });
    normalized.forEach(function (route) {
      if (existing[route.template]) throw new TypeError('Duplicate route template: ' + route.template);
      existing[route.template] = true;
    });
    this.adapters[adapter.root] = adapter;
    var registry = this;
    normalized.forEach(function (route) { registry.routes.push({ route: route, adapter: adapter }); });
    this.routes.sort(function (left, right) {
      return right.route.compiled.specificity - left.route.compiled.specificity;
    });
    return this;
  };

  ResourceRegistry.prototype.unregister = function (rootName) {
    var adapter = this.adapters[rootName];
    if (!adapter) return false;
    delete this.adapters[rootName];
    this.routes = this.routes.filter(function (entry) { return entry.adapter !== adapter; });
    return true;
  };

  ResourceRegistry.prototype.resolve = function (uri, method) {
    var canonical = canonicalizeUri(uri);
    var methodName = method ? String(method).toUpperCase() : '';
    var matches = [];
    this.routes.forEach(function (entry) {
      var params = entry.route.match(canonical);
      if (params) matches.push({ route: entry.route, adapter: entry.adapter, params: params });
    });
    if (!matches.length) return null;
    var selected = matches[0];
    selected.uri = canonical;
    selected.methodContract = methodName ? selected.route.methods[methodName] || null : null;
    selected.allowedMethods = selected.route.allowedMethods();
    return selected;
  };

  ResourceRegistry.prototype.getAdapter = function (rootName) {
    return this.adapters[rootName] || null;
  };

  ResourceRegistry.prototype.listRoutes = function () {
    return this.routes.map(function (entry) { return entry.route; });
  };

  ResourceRegistry.prototype.resolveTemplate = function (template) {
    var compiled = compileRouteTemplate(template);
    for (var index = 0; index < this.routes.length; index++) {
      if (this.routes[index].route.template === compiled.template) return this.routes[index];
    }
    return null;
  };

  function createResourceRegistry(options) {
    return new ResourceRegistry(options);
  }

  function createActiveCapabilityGuidance(registry, input) {
    if (!(registry instanceof ResourceRegistry)) {
      throw new TypeError('Active capability guidance requires a ResourceRegistry');
    }
    input = input || {};
    var exposedNames = (Array.isArray(input.exposedToolNames) ? input.exposedToolNames : [])
      .map(function (name) { return String(name || '').toUpperCase(); });
    // 固定工具调用方法必须覆盖全部暴露工具（含 OPTIONS/ASK_USER）；
    // 路径目录和资源契约只针对 REST 资源方法。
    var exposedTools = makeSet(exposedNames.filter(function (name) { return !!TOOL_NAME_SET[name]; }));
    var exposed = makeSet(exposedNames.filter(function (name) { return !!RESOURCE_METHOD_SET[name]; }));
    var permissionScope = Array.isArray(input.permissionScope) ? makeSet(input.permissionScope) : null;
    var context = input.context && typeof input.context === 'object' ? input.context : {};
    if (input.allowedRouteMethods && typeof input.allowedRouteMethods === 'object'
        && !context.allowedRouteMethods) {
      context = Object.assign({}, context, { allowedRouteMethods: input.allowedRouteMethods });
    }
    var contracts = [];
    var linkedOperations = [];
    var contractKeys = Object.create(null);
    var linkedKeys = Object.create(null);

    function permitted(contract) {
      return !permissionScope || contract.permissions.every(function (permission) {
        return !!permissionScope[permission];
      });
    }

    function routeAllowed(route, method) {
      return routeMethodAllowedByContext(context, route, method);
    }

    function isCatalogRequestTarget(route, link) {
      if (!route || !link || link.method !== 'GET' || !route.methods.GET
          || route.compiled.parameterNames.length) return false;
      try { return parseRequestTarget(link.href, 'GET').path === route.template; }
      catch (_) { return false; }
    }

    function catalogRequestTargets(route, methods) {
      if (methods.indexOf('GET') === -1) return [];
      return route.affordances.filter(function (link) {
        return isCatalogRequestTarget(route, link);
      }).map(function (link) {
        return Object.freeze({
          method: 'GET', href: link.href, relation: link.rel, title: String(link.title || ''),
        });
      }).sort(function (left, right) {
        return left.href.localeCompare(right.href) || left.relation.localeCompare(right.relation);
      });
    }

    function add(method, href) {
      method = String(method || '').toUpperCase();
      if (!exposed[method]) return;
      var resolved;
      try { resolved = registry.resolve(href, method); } catch (_) { return; }
      if (!resolved || !resolved.methodContract || !permitted(resolved.methodContract)
          || !routeAllowed(resolved.route, method)) return;
      if (resolved.route.visible && resolved.route.visible(context, resolved.uri, method) === false) return;
      var key = method + ' ' + resolved.uri;
      if (contractKeys[key]) return;
      contractKeys[key] = true;
      if (linkedKeys[key]) {
        linkedOperations[linkedKeys[key] - 1] = null;
        delete linkedKeys[key];
      }
      var descriptor = descriptorFromRoute(resolved.route, method, resolved.uri);
      contracts.push({
        method: method,
        href: resolved.uri,
        routeTemplate: resolved.route.template,
        relation: descriptor.relation,
        summary: descriptor.summary,
        inputSchema: cloneJson(descriptor.inputSchema),
        requiredPreconditions: cloneJson(descriptor.requiredPreconditions || []),
        guidance: cloneJson(descriptor.guidance || []),
      });
    }

    function addLinked(method, href, relation) {
      method = String(method || '').toUpperCase();
      if (!exposed[method]) return;
      var resolved;
      try { resolved = registry.resolve(href, method); } catch (_) { return; }
      if (!resolved || !resolved.methodContract || !permitted(resolved.methodContract)
          || !routeAllowed(resolved.route, method)) return;
      if (resolved.route.visible && resolved.route.visible(context, resolved.uri, method) === false) return;
      var key = method + ' ' + resolved.uri;
      if (contractKeys[key] || linkedKeys[key]) return;
      var operation = {
        method: method,
        href: resolved.uri,
        relation: String(relation || resolved.methodContract.relation || resolved.route.relation),
      };
      linkedOperations.push(operation);
      linkedKeys[key] = linkedOperations.length;
    }

    function addResource(uri) {
      var resolved;
      try { resolved = registry.resolve(uri); } catch (_) { return; }
      if (!resolved) return;
      resolved.allowedMethods.forEach(function (method) { add(method, resolved.uri); });
      resolved.route.affordances.forEach(function (link) {
        if (!isCatalogRequestTarget(resolved.route, link)) addLinked(link.method, link.href, link.rel);
      });
    }

    var routeCatalog = registry.listRoutes().map(function (route) {
      var methods = RESOURCE_METHODS.filter(function (method) {
        return !!(exposed[method] && route.methods[method] && permitted(route.methods[method])
          && routeAllowed(route, method)
          && (!route.visible || route.visible(context, route.template, method) !== false));
      });
      if (!methods.length) return null;
      return Object.freeze({
        template: route.template,
        methods: Object.freeze(methods),
        relation: route.relation,
        requestTargets: Object.freeze(catalogRequestTargets(route, methods)),
      });
    }).filter(Boolean).sort(function (left, right) {
      return left.template.localeCompare(right.template);
    });
    var routeOperationCount = routeCatalog.reduce(function (total, route) {
      return total + route.methods.length;
    }, 0);
    var routeRoots = Object.create(null);
    routeCatalog.forEach(function (route) {
      routeRoots['/' + route.template.split('/')[1]] = true;
    });

    addResource(String(input.currentResource || '/'));
    var representations = [];
    if (input.representation) representations.push(input.representation);
    if (Array.isArray(input.representations)) representations = representations.concat(input.representations);
    representations.forEach(function (representation) {
      (representation && Array.isArray(representation.links) ? representation.links : []).forEach(function (link) {
        if (link && link.href && link.method) addLinked(link.method, link.href, link.rel);
      });
    });
    (Array.isArray(input.additionalResourceUris) ? input.additionalResourceUris : []).forEach(function (uri) {
      addResource(uri);
    });

    var lines = [];
    var emittedGuidance = Object.create(null);
    lines.push('# ARP 工具协议');
    lines.push('工具协议严格遵循 Web/REST 语义的 ARP（Agent-Resource-Protocol）接口。工具调用等同于调用接口：方法、request-target、body、patch、前置条件和响应语义必须按下方固定工具定义及当前 RouteContract 执行。未由工具定义、路径目录、资源响应 links、OPTIONS 或 RouteContract 明确披露的信息不得猜测。');
    lines.push('# 固定工具调用方法');
    TOOL_DEFINITIONS.forEach(function (definition) {
      if (!exposedTools[definition.name]) return;
      lines.push(definition.name + '：' + definition.description);
      lines.push(definition.name + ' 输入 schema：' + JSON.stringify(definition.inputSchema));
    });
    if (routeCatalog.length) {
      lines.push('# ARP 路径目录');
      lines.push('当前模型已开放方法与权限范围内，ResourceRegistry 共注册 ' + routeCatalog.length
        + ' 个资源路径模板、' + routeOperationCount + ' 个 REST 操作，分布在 '
        + Object.keys(routeRoots).length + ' 个一级资源根。以下目录是本次请求唯一可信的路径事实；具体动态 ID 仍必须来自当前上下文、资源表示或 OPTIONS。');
      lines.push('规则：工具调用等同于调用 RESTful ARP 接口。uri 只能使用下列路径模板或响应 links/OPTIONS 返回的 canonical href；不得根据产品名、节点类型、自然语言动作或旧接口名称创造同义路径。模板参数只能替换为当前上下文或资源响应中已经取得的真实 ID。');
      lines.push('规则：路径目录只回答有哪些资源路径，不授权猜测参数。GET 查询组件、POST/PUT body、PATCH patch 的精确 schema 必须来自下方已预加载 RouteContract、路径条目明确披露的固定 request-target 或 OPTIONS；没有披露时先 OPTIONS，绝不能用失败请求试探。');
      routeCatalog.forEach(function (route) {
        lines.push(route.methods.join(',') + ' ' + route.template + ' — ' + route.relation);
        route.requestTargets.forEach(function (target) {
          lines.push('固定 GET request-target：' + target.href
            + (target.title ? ' — ' + target.title : ''));
        });
      });
    }
    if (exposed.POST || exposed.PUT || exposed.PATCH || exposed.DELETE) {
      lines.push('# 当前工具策略');
      lines.push('规则：不要重复 performed=yes 的操作。写入或执行操作返回 performed=unknown 时，不要自动重放；如有只读观测方式则用它核实，否则把结果报告为未知。');
      lines.push('规则：当前 RouteContract 声明 if-match 前置条件而你尚未取得 ETag 时，先 GET 同一 canonical URI；Runtime 会在该资源的模型结果中保留 ETag。不得猜测、复用其他资源的 ETag，或以缺失前置条件试探。');
    }
    if (contracts.length) {
      lines.push('# 当前资源契约');
      lines.push('以下路由契约已为当前上下文预加载。固定 REST 方法 schema 只定义通用请求外层；这里的 inputSchema 精确定义该路径 query、body 或 patch 的业务字段。未披露的字段不得猜测。');
      contracts.forEach(function (contract) {
        var inputLabel = contract.method === 'GET' ? '路由查询 schema'
          : (contract.method === 'PATCH' ? '路由补丁 schema' : '路由请求体 schema');
        lines.push(contract.method + ' ' + contract.href + ' — ' + contract.summary);
        lines.push(inputLabel + ': ' + JSON.stringify(contract.inputSchema));
        if (contract.requiredPreconditions.length) {
          lines.push('必需前置条件：' + contract.requiredPreconditions.join(', '));
        }
        contract.guidance.forEach(function (rule) {
          if (emittedGuidance[rule]) return;
          emittedGuidance[rule] = true;
          lines.push('规则：' + rule);
        });
      });
    }
    linkedOperations = linkedOperations.filter(Boolean);
    if (linkedOperations.length) {
      lines.push('# 关联资源操作');
      lines.push('以下链接表示可能的后续操作，其路由 schema 尚未预加载。当某个操作符合下一个具体子目标时，先对其 URI 调用 OPTIONS 获取精确契约，再执行该操作。');
      linkedOperations.forEach(function (operation) {
        lines.push(operation.method + ' ' + operation.href + ' — ' + operation.relation);
      });
    }
    return Object.freeze({
      schemaVersion: 4,
      routeCatalog: Object.freeze(routeCatalog),
      routeCount: routeCatalog.length,
      operationCount: routeOperationCount,
      contracts: Object.freeze(contracts.map(function (contract) { return Object.freeze(contract); })),
      linkedOperations: Object.freeze(linkedOperations.map(function (operation) { return Object.freeze(operation); })),
      text: lines.join('\n'),
    });
  }

  function randomBytes(length) {
    if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') return new Uint8Array(nodeCrypto.randomBytes(length));
    var cryptoObject = root && root.crypto;
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      var array = new Uint8Array(length);
      cryptoObject.getRandomValues(array);
      return array;
    }
    throw new Error('ARP requires a cryptographically secure random source');
  }

  function base64Url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    if (!root || typeof root.btoa !== 'function') throw new Error('No base64 encoder is available');
    return root.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(text), 'utf8'));
    var encoded = unescape(encodeURIComponent(String(text)));
    var bytes = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
    return bytes;
  }

  function sha256(value) {
    var text = typeof value === 'string' ? value : stableStringify(value);
    if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
      return Promise.resolve('sha256:' + nodeCrypto.createHash('sha256').update(text).digest('hex'));
    }
    var cryptoObject = root && root.crypto;
    if (cryptoObject && cryptoObject.subtle && typeof cryptoObject.subtle.digest === 'function') {
      return cryptoObject.subtle.digest('SHA-256', utf8Bytes(text)).then(function (buffer) {
        return 'sha256:' + Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
          return byte.toString(16).padStart(2, '0');
        }).join('');
      });
    }
    return Promise.reject(new Error('ARP requires SHA-256 support'));
  }

  function opaqueId(prefix, randomSource) {
    var bytes = typeof randomSource === 'function' ? randomSource(32) : randomBytes(32);
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 16) throw new Error('ARP opaque identifiers require at least 128 bits of randomness');
    return prefix + '_' + base64Url(bytes);
  }

  function assertPageActionTemplateDescriptor(descriptor) {
    if (!descriptor.routeTemplate) return;
    if (!PAGE_ACTION_TEMPLATE_SET[descriptor.routeTemplate] || descriptor.method !== 'POST') {
      throw new TypeError('Unsupported page action route-template descriptor');
    }
  }

  function descriptorSearchText(route, method, contract) {
    return [
      method,
      route.template,
      route.resourceType,
      route.relation,
      route.summary,
      contract.relation,
      contract.summary,
    ].concat(route.aliases, route.tags, contract.aliases, contract.tags).join(' ').toLowerCase();
  }

  // 资源身份词：模板、类型、关系、别名、标签——不含 summary。summary 是
  // 英文句子，'and/its/to' 这类功能词会和查询产生大量假交集，让毫不相关
  // 的路由拿到"语义分"。身份词命中才是 match 的入选资格。
  function identitySearchText(route, contract) {
    return [route.template, route.resourceType, route.relation, contract.relation]
      .concat(route.aliases, route.tags, contract.aliases, contract.tags).join(' ').toLowerCase();
  }

  function searchUnits(value) {
    var text = String(value || '').toLowerCase().trim();
    var units = Object.create(null);
    text.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).forEach(function (part) { units[part] = true; });
    var han = text.replace(/[^\u3400-\u9fff]/g, '');
    for (var i = 0; i < han.length; i++) {
      units[han.charAt(i)] = true;
      if (i + 1 < han.length) units[han.slice(i, i + 2)] = true;
    }
    return units;
  }

  function semanticScore(query, text, minimumUnitLength) {
    query = String(query || '').toLowerCase().trim();
    text = String(text || '').toLowerCase();
    if (!query) return 0;
    var score = 0;
    if (text.indexOf(query) !== -1) score += 200;
    var queryUnits = searchUnits(query);
    var textUnits = searchUnits(text);
    Object.keys(queryUnits).forEach(function (unit) {
      if (!textUnits[unit]) return;
      // 资格评分（identity）忽略 'to/it/md' 这类过短拉丁词：身份短语别名
      //（如 "scroll to top"）里的功能词不能与查询构成语义交集。CJK 单字/
      // 双字是中文查询的基本单元，不受长度限制。
      if (minimumUnitLength && unit.length < minimumUnitLength && !/[㐀-鿿]/.test(unit)) return;
      score += unit.length > 1 ? 8 : 1;
    });
    return score;
  }

  function candidateTargetUris(route, context) {
    var values = [];
    if (!route.compiled.parameterNames.length) values.push(route.template);
    var normalized = normalizeContext(context);
    [normalized.currentResource].concat(normalized.visibleResourceUris).forEach(function (uri) {
      if (!uri) return;
      try {
        uri = canonicalizeUri(uri);
        if (route.match(uri) && values.indexOf(uri) === -1) values.push(uri);
      } catch (_) { /* Invalid entry context is not discoverable. */ }
    });
    if (route.targetUris) {
      var dynamic = route.targetUris(normalized.raw);
      (Array.isArray(dynamic) ? dynamic : []).forEach(function (uri) {
        try {
          uri = canonicalizeUri(uri);
          if (route.match(uri) && values.indexOf(uri) === -1) values.push(uri);
        } catch (_) { /* Domain adapters cannot advertise non-canonical targets. */ }
      });
    }
    return values;
  }

  function CapabilityMatcher(options) {
    if (!(this instanceof CapabilityMatcher)) return new CapabilityMatcher(options);
    options = options || {};
    if (!(options.registry instanceof ResourceRegistry)) throw new TypeError('CapabilityMatcher requires a ResourceRegistry');
    this.registry = options.registry;
    this.maxMatches = Math.min(4, Math.max(1, Number(options.maxMatches) || 4));
  }

  CapabilityMatcher.prototype.match = function (uri, request, context) {
    var query = String(request.match || '').trim();
    var normalized = normalizeContext(context);
    var candidates = [];
    this.registry.routes.forEach(function (entry) {
      if (uri !== '/' && entry.route.template.indexOf(uri + '/') !== 0 && entry.route.template !== uri) return;
      var permissionScope = normalized.permissionScope;
      var visibleMethods = Object.keys(entry.route.methods).filter(function (method) {
        if (!routeMethodAllowedByContext(normalized, entry.route, method)) return false;
        return !(entry.route.methods[method].permissions || []).some(function (permission) {
          return permissionScope.indexOf(permission) === -1;
        });
      });
      if (!visibleMethods.length) return;
      candidateTargetUris(entry.route, context).forEach(function (href) {
        visibleMethods.forEach(function (method) {
          var contract = entry.route.methods[method];
          if (entry.route.visible && entry.route.visible(normalized.raw, href, method) === false) return;
          if (request.relation && String(contract.relation || entry.route.relation) !== String(request.relation)) return;
          var identity = semanticScore(query, identitySearchText(entry.route, contract), 3);
          var descriptive = semanticScore(query, descriptorSearchText(entry.route, method, contract));
          var weight = Number(entry.route.entryWeights[normalized.entryContext]) || 0;
          try {
            if (normalized.currentResource && entry.route.match(normalized.currentResource)) weight += 25;
          } catch (_) { /* Invalid entry context never contributes to matching. */ }
          var score;
          if (identity > 0) {
            // 语义层：身份词命中的候选永远排在纯权重推荐之前；summary 命中
            // 与入口权重只做层内次级排序。
            score = identity * 10000 + descriptive * 10 + weight;
          } else {
            // 兜底层：查询与所有身份词无交集时（如中文查询对英文路由），
            // 降级为入口权重推荐——但只推荐读操作或模板级授权，绝不把
            // "删除/修改当前资源实例"塞给一个语义上毫不相关的查询。
            if (weight <= 0) return;
            if (method !== 'GET' && href !== entry.route.template) return;
            score = weight;
          }
          candidates.push({
            entry: entry,
            method: method,
            href: href,
            score: score,
            templateDescriptor: href === entry.route.template && PAGE_ACTION_TEMPLATE_SET[entry.route.template],
          });
        });
      });
    });
    candidates.sort(function (left, right) {
      return right.score - left.score || left.href.localeCompare(right.href) || left.method.localeCompare(right.method);
    });
    var deduplicated = [];
    var seen = Object.create(null);
    candidates.forEach(function (item) {
      var key = item.method + ' ' + item.href;
      if (!seen[key]) { seen[key] = true; deduplicated.push(item); }
    });
    var requestedLimit = Number(request.limit);
    var limit = Math.min(this.maxMatches, Math.max(1, isFinite(requestedLimit) ? Math.floor(requestedLimit) : this.maxMatches));
    var cursorMatch = /^offset:(\d+)$/.exec(String(request.cursor || ''));
    var offset = cursorMatch ? Math.max(0, Number(cursorMatch[1])) : 0;
    return {
      query: query,
      items: deduplicated.slice(offset, offset + limit),
      nextCursor: offset + limit < deduplicated.length ? 'offset:' + (offset + limit) : undefined,
      total: deduplicated.length,
    };
  };

  function createCapabilityMatcher(options) {
    return new CapabilityMatcher(options);
  }

  function OptionsIntrospector(options) {
    if (!(this instanceof OptionsIntrospector)) return new OptionsIntrospector(options);
    options = options || {};
    if (!(options.registry instanceof ResourceRegistry)) throw new TypeError('OPTIONS requires a ResourceRegistry');
    this.registry = options.registry;
    this.maxMatches = Math.min(4, Math.max(1, Number(options.maxMatches) || 4));
    this.matcher = options.matcher instanceof CapabilityMatcher
      ? options.matcher
      : createCapabilityMatcher({ registry: this.registry, maxMatches: this.maxMatches });
  }

  OptionsIntrospector.prototype.canShow = function (entry, context, method, href) {
    var normalized = normalizeContext(context);
    var contract = entry && entry.route && entry.route.methods && entry.route.methods[method];
    if (!contract) return Promise.resolve(false);
    if (!routeMethodAllowedByContext(normalized, entry.route, method)) return Promise.resolve(false);
    if ((contract.permissions || []).some(function (permission) {
      return normalized.permissionScope.indexOf(permission) === -1;
    })) return Promise.resolve(false);
    if (entry.route.visible && entry.route.visible(normalized.raw, href, method) === false) {
      return Promise.resolve(false);
    }
    if (!this.registry.canDiscover) return Promise.resolve(true);
    return Promise.resolve(this.registry.canDiscover({
      context: normalized.raw,
      route: entry.route,
      adapter: entry.adapter,
      method: method,
      href: href,
    })).then(function (result) { return result !== false; });
  };

  OptionsIntrospector.prototype.visibleItems = function (items, context) {
    var introspector = this;
    return Promise.all(items.map(function (item) {
      return introspector.canShow(item.entry, context, item.method, item.href).then(function (visible) {
        return visible ? item : null;
      });
    })).then(function (visibleItems) { return visibleItems.filter(Boolean); });
  };

  OptionsIntrospector.prototype.describe = function (items, context) {
    return this.visibleItems(items, context).then(function (visibleItems) {
      return visibleItems.map(function (item) {
        var descriptor = item.descriptor || descriptorFromRoute(item.entry.route, item.method, item.href, item.templateDescriptor ? {
          routeTemplate: true,
        } : null);
        return cloneJson(descriptor);
      });
    });
  };

  OptionsIntrospector.prototype.catalog = function (context, rootName) {
    var introspector = this;
    var entries = this.registry.routes.filter(function (entry) {
      return !rootName || entry.route.root === rootName;
    });
    return Promise.all(entries.map(function (entry) {
      var methods = entry.route.allowedMethods().map(function (method) {
        return introspector.canShow(entry, context, method, entry.route.template).then(function (visible) {
          return visible ? method : null;
        });
      });
      return Promise.all(methods).then(function (allowed) {
        allowed = allowed.filter(Boolean);
        if (!allowed.length) return null;
        return { entry: entry, template: entry.route.template, methods: allowed, relation: entry.route.relation };
      });
    })).then(function (catalog) {
      return catalog.filter(Boolean).sort(function (left, right) { return left.template.localeCompare(right.template); });
    });
  };

  OptionsIntrospector.prototype.root = function (context) {
    var introspector = this;
    return this.catalog(context).then(function (catalog) {
      var routeCatalog = catalog.map(function (item) {
        return { template: item.template, methods: item.methods, relation: item.relation };
      });
      var operationCount = routeCatalog.reduce(function (total, route) { return total + route.methods.length; }, 0);
    var byHref = Object.create(null);
      catalog.forEach(function (item) {
      var entry = item.entry;
      var href = '/' + entry.route.root;
      var exact = entry.route.compiled.segments.length === 1;
      var current = byHref[href];
      if (current && (!exact || current.exact)) return;
      byHref[href] = {
        href: href,
        type: exact ? entry.route.resourceType
          : (entry.route.root === 'page' ? 'PageRoot'
            : (entry.route.root === 'browser' ? 'BrowserRoot' : 'ResourceRoot')),
        relation: exact ? entry.route.relation : undefined,
        exact: exact,
      };
      });
    var resources = Object.keys(byHref).sort().map(function (href) {
      var item = byHref[href];
      var output = { href: item.href, type: item.type };
      if (item.relation) output.relation = item.relation;
      return output;
    });
      return {
      mediaType: CAPABILITY_MEDIA_TYPE,
      scope: '/',
      layer: 'root',
      routeCount: routeCatalog.length,
      operationCount: operationCount,
      resources: resources,
      routes: routeCatalog,
      descriptors: [],
      };
    });
  };

  OptionsIntrospector.prototype.namespace = function (uri, context) {
    var rootName = uri.slice(1);
    var introspector = this;
    return this.catalog(context, rootName).then(function (catalog) {
    var resources = [];
    var seen = Object.create(null);
    var routeCatalog = catalog.map(function (item) {
      var entry = item.entry;
      var collection = entry.route.compiled.segments[1];
      if (collection && !/^\{/.test(collection)) {
        var href = '/' + rootName + '/' + collection;
        if (!seen[href]) {
          seen[href] = true;
          resources.push({ href: href, type: entry.route.resourceType, relation: entry.route.relation });
        }
      }
      return { template: item.template, methods: item.methods, relation: item.relation };
    });
    resources.sort(function (left, right) { return left.href.localeCompare(right.href); });
    routeCatalog.sort(function (left, right) { return left.template.localeCompare(right.template); });
    return {
      mediaType: CAPABILITY_MEDIA_TYPE,
      scope: uri,
      layer: 'namespace',
      routeCount: routeCatalog.length,
      operationCount: routeCatalog.reduce(function (total, route) { return total + route.methods.length; }, 0),
      resources: resources,
      routes: routeCatalog,
      descriptors: [],
    };
    });
  };

  OptionsIntrospector.prototype.match = function (uri, request, context) {
    var matched = this.matcher.match(uri, request, context);
    return this.describe(matched.items, context).then(function (descriptors) {
      var result = {
        mediaType: CAPABILITY_MEDIA_TYPE,
        scope: uri,
        layer: 'match',
        match: matched.query,
        resources: [],
        descriptors: descriptors,
      };
      if (matched.nextCursor) result.nextCursor = matched.nextCursor;
      return result;
    });
  };

  OptionsIntrospector.prototype.resource = function (uri, request, context) {
    var resolved = this.registry.resolve(uri);
    if (!resolved) throw arpError('RESOURCE_NOT_FOUND', 'No ARP resource contract matches ' + uri, {
      stage: 'route-match',
      details: missingRouteDetails(this.registry, uri, 'OPTIONS', context),
    });
    var items = [];
    Object.keys(resolved.route.methods).forEach(function (method) {
      var contract = resolved.route.methods[method];
      if (request.relation && String(contract.relation || resolved.route.relation) !== String(request.relation)) return;
      items.push({ entry: resolved, method: method, href: uri });
    });
    var normalizedContext = normalizeContext(context);
    if (items.length && !items.some(function (item) {
      var contract = item.entry.route.methods[item.method];
      return routeMethodAllowedByContext(normalizedContext, item.entry.route, item.method)
        && !(contract.permissions || []).some(function (permission) {
          return normalizedContext.permissionScope.indexOf(permission) === -1;
        });
    })) {
      throw arpError('FORBIDDEN', 'The current actor cannot discover an authorized method for ' + uri, {
        stage: 'authorization',
        details: {
          uri: uri,
          routeTemplate: resolved.route.template,
          methods: items.map(function (item) { return item.method; }).sort(),
        },
      });
    }
    var introspector = this;
    return this.visibleItems(items, context).then(function (visibleItems) {
      if (!visibleItems.length) {
        throw arpError('RESOURCE_NOT_FOUND', 'No ARP resource contract matches ' + uri, {
          stage: 'route-match',
          details: missingRouteDetails(introspector.registry, uri, 'OPTIONS', context),
        });
      }
      var hasDynamicIntrospection = typeof resolved.adapter.introspect === 'function'
        && resolved.adapter.introspect !== ResourceAdapter.prototype.introspect;
      if (!hasDynamicIntrospection) return { advertised: null, visibleItems: visibleItems };
      return Promise.resolve(resolved.adapter.introspect(normalizeContext(context).raw, cloneJson(request))).then(function (advertised) {
        return { advertised: advertised, visibleItems: visibleItems };
      });
    }).then(function (dynamicResult) {
      var advertised = dynamicResult.advertised;
      var visibleItems = dynamicResult.visibleItems;
      if (advertised === null || advertised === undefined) return visibleItems;
      if (!Array.isArray(advertised)) throw new TypeError('ResourceAdapter.introspect must return CapabilityDescriptor[]');
      var allowed = Object.create(null);
      advertised.forEach(function (candidate) {
        candidate = candidate instanceof CapabilityDescriptor ? candidate : new CapabilityDescriptor(candidate);
        if (candidate.href !== uri) throw new TypeError('Dynamic introspection cannot advertise another resource target');
        var registered = introspector.registry.resolve(candidate.href, candidate.method);
        if (!registered || !registered.methodContract || registered.adapter !== resolved.adapter) {
          throw new TypeError('Dynamic introspection cannot advertise an unregistered method');
        }
        allowed[candidate.method + ' ' + candidate.href] = validatedDynamicDescriptor(
          registered.route,
          candidate.method,
          candidate.href,
          candidate
        );
      });
      return visibleItems.filter(function (item) {
        return !!allowed[item.method + ' ' + item.href];
      }).map(function (item) {
        return Object.assign({}, item, { descriptor: allowed[item.method + ' ' + item.href] });
      });
    }).then(function (selectedItems) {
      if (uri === '/page/current') {
        var normalizedPageContext = normalizeContext(context);
        PAGE_ACTION_TEMPLATES.forEach(function (template) {
          var entry = introspector.registry.resolveTemplate(template);
          if (!entry || !entry.route.methods.POST) return;
          var contract = entry.route.methods.POST;
          if (!routeMethodAllowedByContext(normalizedPageContext, entry.route, 'POST')) return;
          if ((contract.permissions || []).some(function (permission) {
            return normalizedPageContext.permissionScope.indexOf(permission) === -1;
          })) return;
          if (entry.route.visible && entry.route.visible(normalizedPageContext.raw, template, 'POST') === false) return;
          if (request.relation && String(contract.relation || entry.route.relation) !== String(request.relation)) return;
          selectedItems.push({
            entry: entry,
            method: 'POST',
            href: template,
            templateDescriptor: true,
          });
        });
      }
      var requestedLimit = Number(request.limit);
      var limit = Math.min(introspector.maxMatches, Math.max(1, isFinite(requestedLimit) ? Math.floor(requestedLimit) : introspector.maxMatches));
      var cursorMatch = /^offset:(\d+)$/.exec(String(request.cursor || ''));
      var offset = cursorMatch ? Math.max(0, Number(cursorMatch[1])) : 0;
      return {
        selected: selectedItems.slice(offset, offset + limit),
        nextCursor: offset + limit < selectedItems.length ? 'offset:' + (offset + limit) : undefined,
      };
    }).then(function (page) {
      return introspector.describe(page.selected, context).then(function (descriptors) {
        return { descriptors: descriptors, nextCursor: page.nextCursor };
      });
    }).then(function (page) {
      var response = {
        mediaType: CAPABILITY_MEDIA_TYPE,
        scope: uri,
        layer: 'resource',
        resources: [{ href: uri, type: resolved.route.resourceType, relation: resolved.route.relation }],
        descriptors: page.descriptors,
      };
      if (page.nextCursor) response.nextCursor = page.nextCursor;
      return response;
    });
  };

  OptionsIntrospector.prototype.introspect = function (request, context) {
    request = request || {};
    var uri = canonicalizeUri(request.uri, { allowRoot: true });
    // 准确资源地址优先走资源自身内省：资源 OPTIONS 是该地址权威、完整的
    // 能力列表。match 只是模糊发现的辅助手段，绝不能劫持已解析的具体 URI——
    // matcher 无法实例化 /skills/{skillId} 这类动态路由，会返回空 descriptors
    // 把调用方引进"反复内省拿不到合同"的死胡同。
    if (uri !== '/' && this.registry.resolve(uri)) return this.resource(uri, request, context);
    if (request.match) return this.match(uri, request, context);
    if (uri === '/') return this.root(context);
    if (uri.split('/').length === 2 && !this.registry.resolve(uri)
        && this.registry.getAdapter(uri.slice(1))) {
      return this.namespace(uri, context);
    }
    return this.resource(uri, request, context);
  };

  function createOptionsIntrospector(options) {
    return new OptionsIntrospector(options);
  }

  function PreconditionEngine(options) {
    if (!(this instanceof PreconditionEngine)) return new PreconditionEngine(options);
    options = options || {};
    this.resolveState = typeof options.resolve === 'function' ? options.resolve : null;
  }

  function preconditionRecovery(uri, method) {
    return {
      method: 'GET',
      uri: uri,
      reason: '重新读取同一 canonical resource path 的当前 Representation 和 ETag；不得直接重放原写请求。',
      prohibited: { method: method, uri: uri, action: 'replay-with-stale-precondition' },
    };
  }

  function comparableEtag(value) {
    var candidate = String(value === undefined || value === null ? '' : value).trim();
    var weak = candidate.indexOf('W/') === 0;
    var token = weak ? candidate.slice(2) : candidate;
    if (token.length >= 2 && token.charAt(0) === '"' && token.charAt(token.length - 1) === '"') {
      token = token.slice(1, -1);
    }
    return (weak ? 'W/' : '') + token;
  }

  function etagMatches(left, right) {
    var leftText = String(left === undefined || left === null ? '' : left);
    var rightText = String(right === undefined || right === null ? '' : right);
    return leftText === rightText || comparableEtag(leftText) === comparableEtag(rightText);
  }

  PreconditionEngine.prototype.check = function (input) {
    var descriptor = input.descriptor;
    var request = input.request || {};
    var preconditions = request.preconditions || {};
    var required = descriptor.requiredPreconditions || [];
    var missing = [];
    required.forEach(function (item) {
      if (item === 'if-match' && !preconditions.ifMatch) missing.push('ifMatch');
      if (item === 'if-none-match' && !preconditions.ifNoneMatch) missing.push('ifNoneMatch');
    });
    if (missing.length) throw arpError('PRECONDITION_REQUIRED', 'Required request preconditions are missing', {
      stage: 'precondition',
      details: { missing: missing, recovery: preconditionRecovery(request.uri, request.method) },
    });
    var resolver = this.resolveState;
    if (!resolver && input.adapter && typeof input.adapter.preconditionState === 'function') {
      resolver = input.adapter.preconditionState.bind(input.adapter);
    }
    if (!resolver) return Promise.resolve({ satisfied: true });
    return Promise.resolve(resolver(input.context, request, input.route, input.params)).then(function (state) {
      state = state || {};
      if (state.gone) throw arpError('RESOURCE_GONE', 'The target resource is no longer retained', {
        stage: 'precondition', current: state.current,
      });
      if (preconditions.ifMatch && (state.exists === false || !etagMatches(preconditions.ifMatch, state.etag))) {
        throw arpError('ETAG_MISMATCH', 'If-Match does not match the current resource version', {
          stage: 'precondition', current: state.current,
          details: { recovery: preconditionRecovery(request.uri, request.method), currentEtag: state.etag || null },
        });
      }
      if (preconditions.ifNoneMatch) {
        if (preconditions.ifNoneMatch === '*' && state.exists !== false) {
          throw arpError('ETAG_MISMATCH', 'If-None-Match requires the target resource not to exist', {
            stage: 'precondition', current: state.current,
            details: { recovery: preconditionRecovery(request.uri, request.method) },
          });
        }
        if (state.etag && etagMatches(preconditions.ifNoneMatch, state.etag)) {
          throw arpError('ETAG_MISMATCH', 'If-None-Match matches the current resource version', {
            stage: 'precondition', current: state.current,
            details: { recovery: preconditionRecovery(request.uri, request.method) },
          });
        }
      }
      if (request.ifNoneMatch && state.etag && etagMatches(request.ifNoneMatch, state.etag)) {
        return { satisfied: true, notModified: true, current: state.current };
      }
      return { satisfied: true, state: state };
    });
  };

  function createPreconditionEngine(options) {
    return new PreconditionEngine(options);
  }

  function IdempotencyLedger(options) {
    if (!(this instanceof IdempotencyLedger)) return new IdempotencyLedger(options);
    options = options || {};
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this.random = typeof options.randomBytes === 'function' ? options.randomBytes : null;
    this.hash = typeof options.hash === 'function' ? options.hash : sha256;
    this.retentionMs = Math.max(1000, Number(options.retentionMs) || 24 * 60 * 60 * 1000);
    this.records = new Map();
  }

  IdempotencyLedger.prototype.generateKey = function () {
    return opaqueId('idem', this.random);
  };

  IdempotencyLedger.prototype.scopeKey = function (context, request, key) {
    var normalized = normalizeContext(context);
    return stableStringify([
      normalized.actorId,
      normalized.permissionScope,
      request.uri,
      String(key),
    ]);
  };

  IdempotencyLedger.prototype.begin = function (context, request, key) {
    var ledger = this;
    var scopeKey = this.scopeKey(context, request, key);
    var payload = {
      method: request.method,
      uri: request.uri,
      body: request.body,
      patch: request.patch,
      contentType: request.contentType,
    };
    return Promise.resolve(this.hash(payload)).then(function (signature) {
      ledger.cleanup();
      var existing = ledger.records.get(scopeKey);
      if (existing) {
        if (existing.signature !== String(signature)) {
          throw arpError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with a different canonical request', {
            idempotencyKey: key,
            stage: 'idempotency',
          });
        }
        if (existing.response) return { state: 'replay', response: cloneJson(existing.response), key: key };
        return { state: 'pending', response: existing.promise.then(cloneJson), key: key };
      }
      var resolvePending;
      var promise = new Promise(function (resolve) { resolvePending = resolve; });
      var record = {
        signature: String(signature),
        createdAt: Number(ledger.clock()),
        response: null,
        promise: promise,
        resolve: resolvePending,
      };
      ledger.records.set(scopeKey, record);
      return { state: 'new', token: { scopeKey: scopeKey, record: record }, key: key };
    });
  };

  IdempotencyLedger.prototype.complete = function (token, response) {
    if (!token || !token.record) return;
    var stored = cloneJson(response);
    token.record.response = stored;
    token.record.resolve(stored);
    token.record.resolve = function () {};
  };

  IdempotencyLedger.prototype.cleanup = function () {
    var timestamp = Number(this.clock());
    var retention = this.retentionMs;
    var removed = 0;
    this.records.forEach(function (record, key, map) {
      if (record.response && timestamp - record.createdAt >= retention) {
        map.delete(key);
        removed += 1;
      }
    });
    return removed;
  };

  function createIdempotencyLedger(options) {
    return new IdempotencyLedger(options);
  }

  function defaultRequestId() {
    return opaqueId('arp_request');
  }

  function requestPayload(method, request) {
    if (method === 'GET') return request.query || {};
    if (method === 'PATCH') return request.patch;
    if (method === 'DELETE') return hasOwn(request, 'body') ? request.body : null;
    return request.body;
  }

  function acceptsOmittedPostBody(schema) {
    return !!(schema && schema.type === 'object' && schema.additionalProperties === false
      && schema.properties && Object.keys(schema.properties).length === 0
      && (!Array.isArray(schema.required) || schema.required.length === 0));
  }

  function setRequestPayload(method, request, value) {
    if (method === 'GET') request.query = value;
    else if (method === 'PATCH') request.patch = value;
    else if (method === 'DELETE') {
      if (value === null) delete request.body;
      else request.body = value;
    } else request.body = value;
  }

  function schemaTypes(schema) {
    if (!isRecord(schema)) return [];
    return Array.isArray(schema.type) ? schema.type.slice() : (schema.type ? [schema.type] : []);
  }

  // Query components arrive as text. Coerce only the scalar types explicitly
  // disclosed by the matched GET RouteContract. Do not JSON-decode objects or
  // arrays and do not coerce POST/PUT/PATCH/DELETE business payloads.
  function coerceGetQueryValue(schema, value) {
    if (!isRecord(schema)) return value;
    if (isRecord(value) && isRecord(schema.properties)) {
      var objectValue = Object.assign({}, value);
      Object.keys(schema.properties).forEach(function (key) {
        if (hasOwn(objectValue, key)) objectValue[key] = coerceGetQueryValue(schema.properties[key], objectValue[key]);
      });
      value = objectValue;
    }
    var branches = Array.isArray(schema.oneOf) ? schema.oneOf
      : (Array.isArray(schema.anyOf) ? schema.anyOf : null);
    if (branches) {
      var valid = [];
      branches.forEach(function (candidateSchema) {
        var candidateValue = coerceGetQueryValue(candidateSchema, cloneJson(value));
        if (validateJsonSchema(candidateSchema, candidateValue).valid) valid.push(candidateValue);
      });
      return valid.length === 1 ? valid[0] : value;
    }
    var types = schemaTypes(schema);
    if (types.indexOf('array') !== -1 && !Array.isArray(value)) {
      value = [value];
    }
    if (typeof value === 'string' && types.indexOf('boolean') !== -1) {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    if (typeof value === 'string' && (types.indexOf('number') !== -1 || types.indexOf('integer') !== -1)
        && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
      var number = Number(value);
      if (Number.isFinite(number) && (types.indexOf('integer') === -1 || Number.isInteger(number))) return number;
    }
    if (Array.isArray(value) && types.indexOf('array') !== -1 && schema.items) {
      return value.map(function (item) { return coerceGetQueryValue(schema.items, item); });
    }
    return value;
  }

  function inferPatchContentType(descriptor, request) {
    if (request.contentType) return request.contentType;
    var allowed = descriptor.patchMediaTypes || [];
    if (allowed.length === 1) {
      if (allowed[0] === 'application/merge-patch+json' && !isRecord(request.patch)) {
        throw arpError('SCHEMA_VALIDATION_FAILED', 'Merge Patch must be a JSON object', { stage: 'route-schema' });
      }
      return allowed[0];
    }
    if (isRecord(request.patch) && allowed.indexOf('application/merge-patch+json') !== -1) {
      return 'application/merge-patch+json';
    }
    throw arpError('SCHEMA_VALIDATION_FAILED', 'PATCH contentType cannot be inferred from the advertised contract and patch shape', {
      stage: 'route-schema',
      details: { allowed: allowed },
    });
  }

  function parseRequestTarget(value, method) {
    var raw = String(value || '');
    if (/\s|[\\\u0000-\u001F\u007F-\u009F]/.test(raw)) {
      throw arpError('INVALID_REQUEST', 'ARP request-target contains forbidden characters');
    }
    if (raw.indexOf('#') !== -1) {
      throw arpError('INVALID_REQUEST', 'ARP request-target cannot contain a URI fragment');
    }
    var queryIndex = raw.indexOf('?');
    if (queryIndex === -1) return { path: raw, query: {} };
    if (method !== 'GET') throw arpError('INVALID_REQUEST', method + ' request-target cannot contain a query component in ARP/1');
    return {
      path: raw.slice(0, queryIndex),
      query: parseQueryComponent(raw.slice(queryIndex + 1)),
    };
  }

  function buildRequestTarget(path, query) {
    var canonicalPath = canonicalizeUri(path);
    var queryString = queryStringFromObject(query);
    return canonicalPath + (queryString ? '?' + queryString : '');
  }

  function routeRecoveryText(value) {
    return String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_/{}]+/g, ' ')
      .replace(/\b([a-z]{3,})s\b/gi, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function missingRouteDetails(registry, uri, method, context) {
    var attempted = String(uri || '');
    var rootName = attempted.split('/')[1] || '';
    var scope = rootName && registry.getAdapter(rootName) ? '/' + rootName : '/';
    var normalizedContext = normalizeContext(context);
    var query = routeRecoveryText(attempted.split('/').pop() || attempted);
    var candidates = [];
    var visibleRouteCount = 0;
    registry.routes.forEach(function (entry) {
      var route = entry.route;
      var routeMethods = method && route.methods[method]
        ? [method] : RESOURCE_METHODS.filter(function (candidateMethod) { return !!route.methods[candidateMethod]; });
      if (!routeMethods.length) return;
      var routeVisible = false;
      routeMethods.forEach(function (candidateMethod) {
        var contract = route.methods[candidateMethod];
        if (!routeMethodAllowedByContext(normalizedContext, route, candidateMethod)) return;
        if ((contract.permissions || []).some(function (permission) {
          return normalizedContext.permissionScope.indexOf(permission) === -1;
        })) return;
        if (route.visible && route.visible(normalizedContext.raw, route.template, candidateMethod) === false) return;
        routeVisible = true;
        var searchable = routeRecoveryText(descriptorSearchText(route, candidateMethod, contract));
        var score = semanticScore(query, searchable);
        if (route.root === rootName) score += 10;
        if (score <= 0) return;
        candidates.push({
          method: candidateMethod,
          href: route.template,
          relation: contract.relation || route.relation,
          summary: contract.summary || route.summary,
          score: score,
        });
      });
      if (routeVisible) visibleRouteCount += 1;
    });
    candidates.sort(function (left, right) {
      return right.score - left.score || left.href.localeCompare(right.href) || left.method.localeCompare(right.method);
    });
    var seen = Object.create(null);
    var selected = [];
    candidates.forEach(function (candidate) {
      var key = candidate.method + ' ' + candidate.href;
      if (selected.length >= 4 || seen[key]) return;
      seen[key] = true;
      selected.push({
        method: candidate.method,
        href: candidate.href,
        relation: candidate.relation,
        summary: candidate.summary,
      });
    });
    return {
      method: method,
      uri: attempted,
      registeredRouteCount: visibleRouteCount,
      candidates: selected,
      recovery: {
        method: 'OPTIONS',
        arguments: { uri: scope, match: query || attempted, limit: 4 },
      },
    };
  }

  function assertOneUnsafeAction(request) {
    var value = request.method === 'PATCH' ? request.patch : request.body;
    if (!isRecord(value)) return;
    ['action', 'operation', 'dispatch'].forEach(function (key) {
      if (hasOwn(value, key)) {
        throw arpError('INVALID_REQUEST', 'Unsafe ARP requests cannot use a universal "' + key + '" discriminator', { stage: 'request-safety' });
      }
    });
    ['batch', 'requests'].forEach(function (key) {
      if (Array.isArray(value[key])) throw arpError('INVALID_REQUEST', 'An unsafe ARP call cannot contain a request batch', { stage: 'request-safety' });
    });
  }

  function normalizeAdapterResult(method, value) {
    if (isArpResponse(value)) throw new TypeError('Adapters must return AdapterResult, not a serialized ArpResponse');
    value = isRecord(value) ? value : { data: value };
    var statusCode = Number(value.statusCode || (method === 'POST' ? 201 : (method === 'DELETE' ? 204 : 200)));
    var result = {
      statusCode: statusCode,
      reason: value.reason,
      primary: value.primary,
      included: value.included,
      receipt: value.receipt ? cloneJson(value.receipt) : undefined,
      warnings: Array.isArray(value.warnings) ? cloneJson(value.warnings) : [],
      schemaValue: hasOwn(value, 'schemaValue')
        ? value.schemaValue
        : (value.primary && hasOwn(value.primary, 'data') ? value.primary.data : (hasOwn(value, 'data') ? value.data : null)),
    };
    if (statusCode === 202) {
      if (!result.receipt || !result.receipt.operationUri || !Number.isFinite(Number(result.receipt.retryAfterMs))) {
        throw new TypeError('A 202 AdapterResult must include receipt.operationUri and receipt.retryAfterMs');
      }
      result.receipt.operationUri = canonicalizeUri(result.receipt.operationUri);
    }
    return result;
  }

  function authorizationCheck(authorize, descriptor, request, context, route) {
    if (!authorize) {
      if (descriptor.requiredPermissions.length) {
        throw arpError('FORBIDDEN', 'No authorization policy was configured for this protected resource', {
          details: { requiredPermissions: descriptor.requiredPermissions },
        });
      }
      return Promise.resolve(true);
    }
    return Promise.resolve(authorize({
      descriptor: descriptor,
      request: request,
      context: normalizeContext(context).raw,
      route: route,
    })).then(function (decision) {
      if (decision === true || (decision && decision.allowed === true)) return true;
      decision = decision || {};
      throw arpError(decision.code || 'FORBIDDEN', decision.message || 'The current actor cannot use this capability', {
        stage: 'authorization',
        status: decision.status,
        retryable: decision.retryable === true,
        details: decision.details,
      });
    });
  }

  function Router(options) {
    if (!(this instanceof Router)) return new Router(options);
    options = options || {};
    this.registry = options.registry instanceof ResourceRegistry ? options.registry : createResourceRegistry();
    this.optionsIntrospector = options.optionsIntrospector instanceof OptionsIntrospector
      ? options.optionsIntrospector
      : createOptionsIntrospector({
        registry: this.registry,
        maxMatches: 4,
      });
    this.preconditions = options.preconditions instanceof PreconditionEngine
      ? options.preconditions : createPreconditionEngine(options.preconditions);
    this.idempotencyLedger = options.idempotencyLedger instanceof IdempotencyLedger
      ? options.idempotencyLedger : createIdempotencyLedger(options.idempotency);
    // Agent authority has exactly one gate: requiredPermissions against the
    // trusted permissionScope. Do not add a second interactive authorization layer.
    this.authorize = typeof options.authorize === 'function' ? options.authorize : null;
    this.generateRequestId = typeof options.requestId === 'function' ? options.requestId : defaultRequestId;
    this.unsafeLocks = new Set();
  }

  Router.prototype.lockKey = function (context) {
    var normalized = normalizeContext(context);
    return normalized.actorId + '\n' + normalized.conversationId;
  };

  Router.prototype.dispatchOptions = function (input, context, requestId, trace) {
    var router = this;
    return this.optionsIntrospector.introspect(input, context).then(function (capabilities) {
      if (capabilities && capabilities.layer === 'resource') {
        var resolved = router.registry.resolve(input.uri);
        if (resolved) trace.routeTemplate = resolved.route.template;
      }
      return createArpResponse({
        requestId: requestId,
        statusCode: 200,
        capabilities: capabilities,
        trace: trace,
      });
    });
  };

  Router.prototype.dispatch = function (toolName, input, context) {
    var router = this;
    var method = String(toolName || '');
    var requestId = nonEmptyString(this.generateRequestId(), 'requestId');
    var requestTrace = { method: method, requestTarget: null, canonicalPath: null, routeTemplate: null, routeSchema: 'not-checked' };
    if (RESOURCE_METHODS.indexOf(method) === -1 && method !== 'OPTIONS') {
      return Promise.resolve(createErrorResponse(requestId, arpError('INVALID_REQUEST', 'Router only accepts ARP resource methods')));
    }
    var preparedInput;
    try { preparedInput = prepareToolInput(method, input); }
    catch (prepareError) {
      if (prepareError instanceof ArpError) {
        if (!prepareError.stage) prepareError.stage = 'outer-schema';
        if (!prepareError.trace) prepareError.trace = cloneJson(requestTrace);
      }
      return Promise.resolve(createErrorResponse(requestId, prepareError, { performed: 'no', trace: requestTrace }));
    }
    input = preparedInput.input;
    var boundaryWarnings = preparedInput.warnings || [];
    var definition = TOOL_DEFINITIONS[TOOL_NAMES.indexOf(method)];
    var outerValidation = validateJsonSchema(definition.inputSchema, input);
    if (!outerValidation.valid) {
      return Promise.resolve(createErrorResponse(requestId, arpError('INVALID_REQUEST', 'Tool input does not match the fixed ARP schema', {
        stage: 'outer-schema',
        details: { errors: outerValidation.errors.slice(0, 32) },
        trace: requestTrace,
      }), { trace: requestTrace }));
    }
    var request;
    try {
      request = cloneJson(input);
      request.method = method;
      requestTrace.requestTarget = request.uri;
      var requestTarget = parseRequestTarget(request.uri, method);
      request.uri = canonicalizeUri(requestTarget.path, { allowRoot: method === 'OPTIONS' });
      requestTrace.canonicalPath = request.uri;
      if (method === 'GET') request.query = requestTarget.query;
    } catch (error) {
      var targetError = arpError(error.code || 'INVALID_REQUEST', error.message, {
        stage: 'request-target', details: error.details, trace: requestTrace,
      });
      return Promise.resolve(createErrorResponse(requestId, targetError, { trace: requestTrace }));
    }
    if (method === 'OPTIONS') {
      return this.dispatchOptions(request, context, requestId, requestTrace).catch(function (error) {
        return createErrorResponse(requestId, error, { performed: 'no', trace: requestTrace });
      });
    }

    var unsafe = method !== 'GET';
    var lockKey = unsafe ? this.lockKey(context) : '';
    if (unsafe && this.unsafeLocks.has(lockKey)) {
      return Promise.resolve(createErrorResponse(requestId, arpError('RESOURCE_CONFLICT', 'Another unsafe ARP request is already running for this actor and conversation', {
        stage: 'execution-lock', trace: requestTrace,
      }), { trace: requestTrace }));
    }
    if (unsafe) this.unsafeLocks.add(lockKey);
    var executionStarted = false;
    var idempotencyToken = null;
    var idempotencyKey = request.idempotencyKey;
    var resolved;
    var descriptor;

    function finish(response) {
      if (idempotencyToken) router.idempotencyLedger.complete(idempotencyToken, response);
      return response;
    }

    return Promise.resolve().then(function () {
      resolved = router.registry.resolve(request.uri, method);
      if (!resolved) throw arpError('RESOURCE_NOT_FOUND', 'No ARP route matches ' + request.uri, {
        stage: 'route-match',
        details: missingRouteDetails(router.registry, request.uri, method, context),
      });
      if (!resolved.methodContract) throw arpError('METHOD_NOT_ALLOWED', method + ' is not allowed for ' + request.uri, {
        stage: 'route-match',
        details: {
          allow: resolved.allowedMethods.filter(function (allowedMethod) {
            var contract = resolved.route.methods[allowedMethod];
            return routeMethodAllowedByContext(context, resolved.route, allowedMethod)
              && !(contract.permissions || []).some(function (permission) {
                return normalizeContext(context).permissionScope.indexOf(permission) === -1;
              });
          }),
          options: { method: 'OPTIONS', href: request.uri },
        },
      });
      requestTrace.routeTemplate = resolved.route.template;
      requestTrace.routeMethod = method;
      return resolveExecutionDescriptor(resolved, method, request, context).then(function (resolvedDescriptor) {
        descriptor = resolvedDescriptor;
      });
    }).then(function () {
      if (method === 'PATCH') request.contentType = inferPatchContentType(descriptor, request);
      if (method === 'GET') {
        setRequestPayload(method, request, coerceGetQueryValue(descriptor.inputSchema, requestPayload(method, request)));
      }
      if (method === 'POST' && !hasOwn(request, 'body') && acceptsOmittedPostBody(descriptor.inputSchema)) {
        request.body = {};
      }
      if (unsafe) assertOneUnsafeAction(request);
      // 信任边界:路由 inputSchema 是给 Agent/MCP 的合同反馈面，它们在边界外，
      // 读得到合同也能对拒绝自我修正。background 盖章的 ui:* 调用方是系统自身
      // 的固定代码，与本合同同库同版本，被拒绝时没有任何调整手段；其 payload
      // 的完整性由 service 层白名单与规范化守卫。GET query 的类型转换照常执行，
      // 这里只保留"必须是 JSON 对象"的传输底线，不用 Agent 合同拦截自家界面。
      var routePayload = requestPayload(method, request);
      var trustedUiPayload = isRecord(routePayload)
        && /^ui:/.test(String(context && (context.actorId || context.actor) || ''));
      if (trustedUiPayload) {
        requestTrace.routeSchema = 'trusted-ui';
      } else {
        try {
          assertSchema(descriptor.inputSchema, routePayload, 'request payload');
        } catch (error) {
          requestTrace.routeSchema = 'invalid';
          throw arpError('SCHEMA_VALIDATION_FAILED', error.message, {
            stage: 'route-schema', details: error.details,
          });
        }
        requestTrace.routeSchema = 'valid';
      }
      if (method === 'PATCH' && descriptor.patchMediaTypes.indexOf(request.contentType) === -1) {
        throw arpError('UNSUPPORTED_MEDIA_TYPE', 'PATCH contentType is not advertised by this resource', {
          stage: 'route-schema',
          details: { allowed: descriptor.patchMediaTypes },
        });
      }
      return authorizationCheck(router.authorize, descriptor, request, context, resolved.route);
    }).then(function () {
      if (method === 'POST' || (method === 'PATCH' && descriptor.idempotency !== 'inherent')) {
        idempotencyKey = idempotencyKey || router.idempotencyLedger.generateKey();
        request.idempotencyKey = idempotencyKey;
      }
      return router.preconditions.check({
        descriptor: descriptor,
        request: request,
        context: normalizeContext(context).raw,
        route: resolved.route,
        params: resolved.params,
        adapter: resolved.adapter,
      });
    }).then(function (preconditionResult) {
      if (preconditionResult.notModified) {
        return { terminalResponse: createArpResponse({ requestId: requestId, statusCode: 304, trace: requestTrace }) };
      }
      if (!idempotencyKey) return null;
      return router.idempotencyLedger.begin(context, request, idempotencyKey).then(function (ledgerResult) {
        if (ledgerResult.state === 'replay') return { terminalResponse: responseWithTrace(ledgerResult.response, requestTrace) };
        if (ledgerResult.state === 'pending') return ledgerResult.response.then(function (response) {
          return { terminalResponse: responseWithTrace(response, requestTrace) };
        });
        idempotencyToken = ledgerResult.token;
        return null;
      });
    }).then(function (gate) {
      if (gate && gate.terminalResponse) return gate;
      var handler = resolved.adapter[method.toLowerCase()];
      if (typeof handler !== 'function') throw arpError('METHOD_NOT_ALLOWED', 'The adapter does not implement ' + method, {
        stage: 'adapter',
      });
      executionStarted = true;
      var adapterRequest = Object.freeze(Object.assign({}, request, {
        params: Object.freeze(Object.assign({}, resolved.params)),
        routeTemplate: resolved.route.template,
      }));
      return Promise.resolve(handler.call(resolved.adapter, normalizeContext(context).raw, adapterRequest)).then(function (value) {
        return { adapterResult: normalizeAdapterResult(method, value) };
      });
    }).then(function (stage) {
      if (stage.terminalResponse) return stage.terminalResponse;
      var result = stage.adapterResult;
      try {
        assertSchema(descriptor.outputSchema, result.schemaValue, 'adapter output');
      } catch (error) {
        throw arpError('INTERNAL_ERROR', error.message, { stage: 'adapter-output' });
      }
      var receipt = result.receipt || {};
      if (unsafe) {
        if (!receipt.performed) receipt.performed = 'yes';
        if (idempotencyKey) receipt.idempotencyKey = idempotencyKey;
      }
      return createArpResponse({
        requestId: requestId,
        statusCode: result.statusCode,
        reason: result.reason,
        primary: result.primary,
        included: result.included,
        receipt: Object.keys(receipt).length ? receipt : undefined,
        warnings: boundaryWarnings.concat(result.warnings || []),
        trace: requestTrace,
      });
    }).then(function (response) {
      if (isArpResponse(response) && response.requestId !== requestId && response.receipt && response.receipt.idempotencyKey === idempotencyKey) {
        // Idempotency replay keeps the original requestId by design.
      }
      return finish(response);
    }).catch(function (error) {
      var performed = error instanceof ArpError
        ? error.performed
        : (executionStarted ? 'unknown' : 'no');
      var normalizedError = error instanceof ArpError ? error : arpError('INTERNAL_ERROR', 'ARP adapter or pipeline failed', {
        performed: performed,
        details: { cause: boundedErrorCause(error) },
      });
      normalizedError.warnings = boundaryWarnings.concat(normalizedError.warnings || []);
      var response = createErrorResponse(requestId, normalizedError, {
        performed: performed,
        idempotencyKey: idempotencyKey,
        trace: requestTrace,
      });
      return finish(response);
    }).finally(function () {
      if (unsafe) router.unsafeLocks.delete(lockKey);
    });
  };

  function createRouter(options) {
    return new Router(options);
  }

  function userResponseRepresentation(context, requestId, data) {
    var normalized = normalizeContext(context);
    var conversationId = strictEncodeSegment(normalized.conversationId || 'current');
    return {
      uri: '/conversations/' + conversationId + '/user-responses/' + strictEncodeSegment(requestId),
      type: 'UserResponse',
      data: data === undefined ? null : data,
      links: [],
    };
  }

  function createToolScope(options) {
    options = options || {};
    if (!(options.router instanceof Router)) throw new TypeError('createToolScope requires an ARP Router');
    var router = options.router;
    var contextProvider = typeof options.contextProvider === 'function'
      ? options.contextProvider : function () { return options.context || {}; };
    var askUser = typeof options.askUser === 'function' ? options.askUser : null;
    if (!askUser) throw new TypeError('createToolScope requires the ASK_USER bridge');
    var definitions = createToolDefinitions();

    function invokeControl(name, input, context) {
      var definition = definitions[TOOL_NAMES.indexOf(name)];
      var validation = validateJsonSchema(definition.inputSchema, input);
      var requestId = defaultRequestId();
      if (!validation.valid) return Promise.resolve(createErrorResponse(requestId, arpError('INVALID_REQUEST', name + ' input is invalid', {
        details: { errors: validation.errors.slice(0, 32) },
      })));
      if (input.mode === 'choice' && (!Array.isArray(input.choices) || !input.choices.length)) {
        return Promise.resolve(createErrorResponse(requestId, arpError('INVALID_REQUEST', 'choice mode requires choices')));
      }
      return Promise.resolve(askUser(cloneJson(input), context)).then(function (result) {
        if (isArpResponse(result)) return result;
        return createArpResponse({
          requestId: requestId,
          statusCode: 200,
          primary: userResponseRepresentation(context, requestId, result),
          receipt: { performed: 'no' },
        });
      }).catch(function (error) { return createErrorResponse(requestId, error, { performed: 'no' }); });
    }

    function dispatch(name, input) {
      name = String(name || '').trim().toUpperCase();
      if (!TOOL_NAME_SET[name]) return Promise.resolve(createErrorResponse(defaultRequestId(), arpError('INVALID_REQUEST', 'Unknown ARP tool: ' + name)));
      return Promise.resolve(contextProvider()).then(function (context) {
        if (RESOURCE_METHODS.indexOf(name) !== -1 || name === 'OPTIONS') return router.dispatch(name, input, context);
        return invokeControl(name, input, context);
      });
    }

    var tools = definitions.map(function (definition) {
      var execute = function (input) { return dispatch(definition.name, input); };
      return {
        name: definition.name,
        description: definition.description,
        schema: cloneJson(definition.inputSchema),
        execute: execute,
        handler: execute,
      };
    });
    return {
      name: PROTOCOL,
      tools: tools,
      dispatch: dispatch,
    };
  }

  var api = {
    API_VERSION: API_VERSION,
    PROTOCOL: PROTOCOL,
    CAPABILITY_MEDIA_TYPE: CAPABILITY_MEDIA_TYPE,
    METHODS: METHODS,
    RESOURCE_METHODS: RESOURCE_METHODS,
    TOOL_NAMES: TOOL_NAMES,
    ROOT_NAMES: ROOT_NAMES,
    ROOTS: ROOTS,
    PATCH_MEDIA_TYPES: PATCH_MEDIA_TYPES,
    PAGE_ACTION_TEMPLATES: PAGE_ACTION_TEMPLATES,
    ERROR_STATUS: ERROR_STATUS,
    ArpError: ArpError,
    arpError: arpError,
    createArpResponse: createArpResponse,
    createErrorResponse: createErrorResponse,
    isArpResponse: isArpResponse,
    normalizeRepresentation: normalizeRepresentation,
    canonicalizeUri: canonicalizeUri,
    parseRequestTarget: parseRequestTarget,
    buildRequestTarget: buildRequestTarget,
    compileRouteTemplate: compileRouteTemplate,
    validateJsonSchema: validateJsonSchema,
    assertSchema: assertSchema,
    createToolDefinitions: createToolDefinitions,
    normalizeModelProjection: normalizeModelProjection,
    RouteContract: RouteContract,
    CapabilityDescriptor: CapabilityDescriptor,
    ResourceAdapter: ResourceAdapter,
    defineAdapter: defineAdapter,
    validateAdapter: validateAdapter,
    ResourceRegistry: ResourceRegistry,
    createResourceRegistry: createResourceRegistry,
    createActiveCapabilityGuidance: createActiveCapabilityGuidance,
    CapabilityMatcher: CapabilityMatcher,
    createCapabilityMatcher: createCapabilityMatcher,
    OptionsIntrospector: OptionsIntrospector,
    createOptionsIntrospector: createOptionsIntrospector,
    PreconditionEngine: PreconditionEngine,
    createPreconditionEngine: createPreconditionEngine,
    IdempotencyLedger: IdempotencyLedger,
    createIdempotencyLedger: createIdempotencyLedger,
    Router: Router,
    createRouter: createRouter,
    createToolScope: createToolScope,
    stableStringify: stableStringify,
    sha256: sha256,
  };

  return Object.freeze(api);
});
