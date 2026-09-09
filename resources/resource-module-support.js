// Shared constructors for independently owned ARP resource modules.
(function attachResourceModuleSupport(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../resources/protocol/index.js') : root.AgentResourceProtocol;
  if (!arp) throw new Error('AgentResourceProtocol must load before ResourceModuleSupport');
  var api = factory(arp);
  if (commonJs) module.exports = api;
  else root.ResourceModuleSupport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp) {
  'use strict';

  var OBJECT = Object.freeze({ type: 'object' });
  var EMPTY_QUERY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
  function closedObject(properties, required) {
    var schema = { type: 'object', properties: Object.freeze(properties), additionalProperties: false };
    if (required && required.length) schema.required = required.slice();
    return Object.freeze(schema);
  }

  function patchObject(properties, omitted) {
    var patchProperties = {};
    omitted = omitted || [];
    Object.keys(properties).forEach(function (key) {
      if (omitted.indexOf(key) === -1) patchProperties[key] = properties[key];
    });
    return Object.freeze({
      type: 'object', properties: Object.freeze(patchProperties), minProperties: 1, additionalProperties: false,
    });
  }

  var MATCHERS_PROPERTIES = Object.freeze({
    hostnames: { type: 'string', maxLength: 20000 },
    urlIncludes: { type: 'string', maxLength: 20000 },
  });
  var KEEP_ALIVE_PROPERTIES = Object.freeze({
    enabled: { type: 'boolean' }, intervalMinutes: { type: 'number', minimum: 1 },
    requestUrl: { type: 'string', maxLength: 20000 }, method: { type: 'string', enum: ['GET', 'HEAD', 'POST'] },
    expectedStatus: { type: 'string', maxLength: 1000 }, requestTimeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    headers: { type: 'string', maxLength: 20000 }, body: { type: 'string', maxLength: 200000 },
    lockedSelector: { type: 'string', maxLength: 10000 }, healthySelector: { type: 'string', maxLength: 10000 },
    versionUrl: { type: 'string', maxLength: 20000 }, activityMode: { type: 'string', enum: ['none', 'cdpMouseMove'] },
    reloadOnSessionExpired: { type: 'boolean' }, reloadOnLocked: { type: 'boolean' },
    reloadOnVersionChange: { type: 'boolean' }, reloadDiscarded: { type: 'boolean' },
  });
  var PAGE_SOURCE_PROPERTIES = Object.freeze({
    id: { type: 'string', maxLength: 240 }, label: { type: 'string', maxLength: 300 },
    url: { type: 'string', minLength: 1, maxLength: 20000 },
    matchers: closedObject(MATCHERS_PROPERTIES), keepAlive: closedObject(KEEP_ALIVE_PROPERTIES),
    autoRefreshMinutes: { type: 'number', minimum: 0 }, captureNetwork: { type: 'boolean' }, stealthMode: { type: 'boolean' },
  });
  var URL_TRIGGER_PROPERTIES = Object.freeze({
    id: { type: 'string', maxLength: 240 }, label: { type: 'string', maxLength: 300 },
    flowId: { type: 'string', minLength: 1, maxLength: 240 }, urlPattern: { type: 'string', minLength: 1, maxLength: 20000 },
    enabled: { type: 'boolean' },
    updatedAt: { type: 'number', minimum: 0, description: '由界面维护的展示时间戳；对触发行为无影响。' },
  });
  var SCRIPT_PROPERTIES = Object.freeze({
    id: { type: 'string', maxLength: 240 }, label: { type: 'string', minLength: 1, maxLength: 300 },
    code: { type: 'string', maxLength: 200000 },
  });
  var FLOW_GROUP_STEP_PROPERTIES = Object.freeze({
    stepId: { type: 'string', maxLength: 240 }, flowId: { type: 'string', minLength: 1, maxLength: 240 },
    label: { type: 'string', maxLength: 300 }, continueOnFailure: { type: 'boolean' },
    runTabMode: { type: 'string', maxLength: 100 },
  });
  var FLOW_GROUP_PROPERTIES = Object.freeze({
    id: { type: 'string', maxLength: 240 }, label: { type: 'string', minLength: 1, maxLength: 300 },
    description: { type: 'string', maxLength: 10000 }, inputDescription: { type: 'string', maxLength: 10000 },
    outputDescription: { type: 'string', maxLength: 10000 }, inputExample: { type: 'string', maxLength: 100000 },
    steps: { type: 'array', minItems: 1, maxItems: 2000, items: closedObject(FLOW_GROUP_STEP_PROPERTIES, ['flowId']) },
  });
  var PAGE_SOURCE_RESOURCE = closedObject(PAGE_SOURCE_PROPERTIES, ['url']);
  var PAGE_SOURCE_PATCH = patchObject(PAGE_SOURCE_PROPERTIES, ['id']);
  var URL_TRIGGER_RESOURCE = closedObject(URL_TRIGGER_PROPERTIES, ['flowId', 'urlPattern']);
  var URL_TRIGGER_PATCH = patchObject(URL_TRIGGER_PROPERTIES, ['id']);
  var SCRIPT_RESOURCE = closedObject(SCRIPT_PROPERTIES, ['label']);
  var SCRIPT_PATCH = patchObject(SCRIPT_PROPERTIES, ['id']);
  var FLOW_GROUP_RESOURCE = closedObject(FLOW_GROUP_PROPERTIES, ['label', 'steps']);
  var FLOW_GROUP_PATCH = patchObject(FLOW_GROUP_PROPERTIES, ['id']);
  var PAGE_WINDOW_QUERY = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  });
  var PATCH_MEDIA_TYPES = Object.freeze(['application/merge-patch+json']);

  function segment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function injectedService(options, key, owner) {
    options = options || {};
    key = String(key || 'service');
    var service = options[key] || options.service;
    if (!service) throw new Error(String(owner || 'Resource module') + ' requires an injected ' + key);
    return service;
  }

  function method(inputSchema, policy) {
    policy = policy || {};
    if (policy.prepareInput !== undefined) {
      throw new TypeError('ARP resource methods cannot define prepareInput; use the fixed RouteContract schema');
    }
    return {
      inputSchema: inputSchema,
      outputSchema: policy.outputSchema || OBJECT,
      safety: policy.safety || 'read', idempotency: policy.idempotency || 'inherent',
      execution: policy.execution || 'sync', permissions: policy.permissions || [],
      preconditions: policy.preconditions || [],
      patchMediaTypes: policy.patchMediaTypes,
      relation: policy.relation || '', summary: policy.summary || '',
      guidance: policy.guidance || [],
      modelProjection: policy.modelProjection || { type: 'data' },
    };
  }

  function read(inputSchema, permission, relation, summary, outputSchema, options) {
    options = options || {};
    return method(inputSchema || EMPTY_QUERY, {
      permissions: [permission], relation: relation, summary: summary, outputSchema: outputSchema,
      modelProjection: options.modelProjection,
    });
  }

  function create(inputSchema, permission, relation, summary, options) {
    options = options || {};
    if (inputSchema === undefined) throw new TypeError('ARP create routes require an explicit inputSchema');
    return method(inputSchema, {
      safety: options.safety || (options.execution === 'async' ? 'execute' : 'write'),
      idempotency: 'keyed', execution: options.execution || 'sync', permissions: [permission],
      preconditions: options.preconditions || [],
      relation: relation, summary: summary, outputSchema: options.outputSchema,
      modelProjection: options.modelProjection,
    });
  }

  function replace(inputSchema, permission, relation, summary, outputSchema) {
    if (inputSchema === undefined) throw new TypeError('ARP replace routes require an explicit inputSchema');
    return method(inputSchema, {
      safety: 'write', idempotency: 'inherent', permissions: [permission],
      preconditions: ['if-match'], relation: relation, summary: summary,
      outputSchema: outputSchema,
    });
  }

  function patch(permission, relation, summary, inputSchema, outputSchema) {
    if (inputSchema === undefined) throw new TypeError('ARP patch routes require an explicit inputSchema');
    return method(inputSchema, {
      safety: 'write', idempotency: 'keyed', permissions: [permission],
      preconditions: ['if-match'], patchMediaTypes: PATCH_MEDIA_TYPES,
      relation: relation, summary: summary, outputSchema: outputSchema,
    });
  }

  function remove(permission, relation, summary, outputSchema) {
    return method(null, {
      safety: 'write', idempotency: 'inherent', permissions: [permission],
      preconditions: ['if-match'], relation: relation, summary: summary,
      outputSchema: outputSchema,
    });
  }

  function route(input) {
    return new arp.RouteContract(input);
  }

  function representation(uri, type, data, service, links) {
    var output = {
      uri: arp.canonicalizeUri(uri), type: type, data: data,
      links: links || [
        { rel: 'self', href: uri, method: 'GET' },
        { rel: 'capabilities', href: uri, method: 'OPTIONS' },
      ],
    };
    if (data && service && typeof service.etag === 'function') output.etag = service.etag(data);
    return arp.normalizeRepresentation(output);
  }

  function result(uri, type, data, service, statusCode, links) {
    return {
      statusCode: statusCode || 200,
      primary: representation(uri, type, data, service, links),
      schemaValue: data,
    };
  }

  function asyncRunResult(run, service) {
    var runId = String(run && (run.runId || run.id || run.flowGroupRunId) || '');
    var uri = '/runs/' + segment(runId);
    var output = result(uri, 'Run', run, service, 202);
    output.receipt = { performed: 'yes', operationUri: uri, retryAfterMs: 250, state: 'running' };
    return output;
  }

  return Object.freeze({
    API_VERSION: 1,
    OBJECT: OBJECT, EMPTY_QUERY: EMPTY_QUERY,
    PAGE_SOURCE_RESOURCE: PAGE_SOURCE_RESOURCE, PAGE_SOURCE_PATCH: PAGE_SOURCE_PATCH,
    URL_TRIGGER_RESOURCE: URL_TRIGGER_RESOURCE, URL_TRIGGER_PATCH: URL_TRIGGER_PATCH,
    SCRIPT_RESOURCE: SCRIPT_RESOURCE, SCRIPT_PATCH: SCRIPT_PATCH,
    FLOW_GROUP_RESOURCE: FLOW_GROUP_RESOURCE, FLOW_GROUP_PATCH: FLOW_GROUP_PATCH,
    PAGE_QUERY: PAGE_WINDOW_QUERY, PAGE_WINDOW_QUERY: PAGE_WINDOW_QUERY, PATCH_MEDIA_TYPES: PATCH_MEDIA_TYPES,
    segment: segment, injectedService: injectedService,
    method: method, read: read, create: create, replace: replace,
    patch: patch, remove: remove, route: route, representation: representation,
    result: result, asyncRunResult: asyncRunResult,
  });
});
