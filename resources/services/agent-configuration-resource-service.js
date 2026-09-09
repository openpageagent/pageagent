// Canonical Assistant, Model Service, connection-attempt, and Agent Settings domain service.
(function attachAgentConfigurationResourceService(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var resourceService = commonJs ? require('./resource-service') : root.AgentResourceService;
  if (!arp || !resourceService) throw new Error('ARP and AgentResourceService must load before AgentConfigurationResourceService');
  var api = factory(root, arp, resourceService);
  if (commonJs) module.exports = api;
  else root.AgentConfigurationResourceService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, arp, AgentResourceService) {
  'use strict';

  var MODEL_META_KEY = 'arp_model_service_metadata';
  var AGENT_SETTINGS_META_KEY = 'arp_agent_settings_metadata';
  var RUN_SETTING_KEYS = Object.freeze([
    'temperature', 'topP', 'maxTokens', 'maxContextTokens', 'reasoningEffort',
    'contextCompression', 'streamOutput', 'mode', 'maxIterations', 'maxToolCalls',
    'autoCreateNewTopic',
  ]);
  var ASSISTANT_MUTABLE_KEYS = Object.freeze({
    name: true, description: true, prompt: true,
    skillIds: true, mcpServerIds: true,
    resourcePolicy: true, modelServiceId: true, settings: true,
  });
  var MODEL_MUTABLE_KEYS = Object.freeze({
    name: true, baseUrl: true, model: true, visionModel: true, summaryModel: true, protocol: true,
    apiStyle: true, providerType: true, provider_type: true, reasoningProviderType: true,
    userAgent: true, maxContextTokens: true,
    autoCompactTokenLimit: true, reasoningEffort: true, requestTimeoutMs: true,
    maxRetries: true, maxRetryDelayMs: true, contextCompression: true, secret: true,
  });
  var AGENT_SETTINGS_KEYS = Object.freeze({
    defaultAssistantId: true, defaultModelServiceId: true, contextBudget: true,
    contextCompression: true,
  });
  var UNSAFE_KEYS = Object.freeze({ __proto__: true, prototype: true, constructor: true });

  function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function fail(code, message, options) {
    options = options || {};
    throw arp.arpError(code, message, {
      status: options.status,
      retryable: options.retryable === true,
      performed: options.performed || 'no',
      details: options.details,
    });
  }

  function requiredFunction(value, name) {
    if (typeof value !== 'function') throw new Error('AgentConfigurationResourceService requires ' + name);
    return value;
  }

  function cleanId(value, name) {
    var text = String(value || '').trim();
    if (!text || text.length > 240 || /[/\\\u0000-\u001F\u007F]/.test(text)) {
      fail('SCHEMA_VALIDATION_FAILED', (name || 'id') + ' is invalid');
    }
    return text;
  }

  function randomId(prefix) {
    var cryptoObject = root && root.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return prefix + '_' + cryptoObject.randomUUID().replace(/-/g, '').slice(0, 20);
    }
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    var output = {};
    Object.keys(value).sort().forEach(function (key) { output[key] = stableValue(value[key]); });
    return output;
  }

  function etag(value) {
    var text = JSON.stringify(stableValue(value === undefined ? null : value));
    var hash = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return '"arp-agent-' + (hash >>> 0).toString(16).padStart(8, '0') + '"';
  }

  function pageWindow(items, query) {
    query = query || {};
    var match = String(query.q || '').trim().toLowerCase();
    if (match) items = items.filter(function (item) {
      return [item.id, item.name, item.description, item.model, item.baseUrl]
        .join(' ').toLowerCase().indexOf(match) !== -1;
    });
    var limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    var cursorMatch = /^offset:(\d+)$/.exec(String(query.cursor || ''));
    var offset = cursorMatch ? Number(cursorMatch[1]) : 0;
    var page = items.slice(offset, offset + limit);
    var output = {
      items: page,
      total: items.length,
    };
    if (offset + page.length < items.length) output.nextCursor = 'offset:' + (offset + page.length);
    return output;
  }

  function storageCall(storageArea, method, value) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(error, result) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      }
      function callback(result) {
        var lastError = root && root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
        finish(lastError ? new Error(lastError.message || String(lastError)) : null, result);
      }
      try {
        var returned = storageArea[method](value, callback);
        if (returned && typeof returned.then === 'function') {
          returned.then(function (result) { finish(null, result); }, function (error) { finish(error); });
        }
      } catch (error) { finish(error); }
    });
  }

  function mergePatch(target, patch) {
    if (!isRecord(patch)) return clone(patch);
    var output = isRecord(target) ? clone(target) : {};
    Object.keys(patch).forEach(function (key) {
      if (UNSAFE_KEYS[key]) fail('SCHEMA_VALIDATION_FAILED', 'Patch contains a forbidden property: ' + key);
      if (patch[key] === null) delete output[key];
      else output[key] = mergePatch(output[key], patch[key]);
    });
    return output;
  }

  function applyPatch(target, patch) {
    return mergePatch(target, patch);
  }

  function assertOnly(value, allowed, label) {
    Object.keys(value || {}).forEach(function (key) {
      if (!allowed[key]) fail('SCHEMA_VALIDATION_FAILED', 'Unknown ' + label + ' field: ' + key);
    });
  }

  function redactErrorMessage(value) {
    return String(value || 'Provider request failed')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[-_]?key|authorization|cookie|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .slice(0, 500);
  }

  function create(options) {
    options = options || {};
    var conversationState = options.conversationState;
    var conversationJournal = options.conversationJournal;
    var modelSettings = options.modelSettings;
    var agentProvider = options.agentProvider;
    var systemSettings = options.systemSettings;
    var storageArea = options.storageArea;
    var runtime = options.runtime || root && root.chrome && root.chrome.runtime;
    var fetchImpl = options.fetch;
    if (!conversationState || !modelSettings || !agentProvider || !systemSettings || !storageArea) {
      throw new Error('AgentConfigurationResourceService requires explicit ConversationState, ModelSettings, AgentProvider, SystemSettings, and storageArea');
    }
    requiredFunction(conversationState.load, 'ConversationState.load');
    requiredFunction(conversationState.createAssistant, 'ConversationState.createAssistant');
    requiredFunction(conversationState.updateAssistant, 'ConversationState.updateAssistant');
    requiredFunction(conversationState.deleteAssistant, 'ConversationState.deleteAssistant');
    requiredFunction(conversationState.normalizeAssistantProfile, 'ConversationState.normalizeAssistantProfile');
    requiredFunction(conversationState.normalizeResourcePolicy, 'ConversationState.normalizeResourcePolicy');
    requiredFunction(conversationState.createResourcePolicy, 'ConversationState.createResourcePolicy');
    requiredFunction(modelSettings.normalizeSettings, 'ModelSettings.normalizeSettings');
    requiredFunction(modelSettings.normalizeService, 'ModelSettings.normalizeService');
    requiredFunction(modelSettings.normalizeModelProtocol, 'ModelSettings.normalizeModelProtocol');
    requiredFunction(agentProvider.createModelProvider, 'AgentProvider.createModelProvider');
    requiredFunction(systemSettings.load, 'SystemSettings.load');
    requiredFunction(systemSettings.save, 'SystemSettings.save');
    if (typeof fetchImpl !== 'function') throw new Error('AgentConfigurationResourceService requires an explicit fetch implementation');

    var modelSettingsKey = String(modelSettings.SETTINGS_KEY || 'model_settings');
    var writeQueue = Promise.resolve();
    var attemptStore = options.connectionAttemptStore || AgentResourceService.createOperationRunStore({
      storageArea: storageArea,
      storageKey: options.connectionAttemptStorageKey
        || (options.incognito ? 'arp_model_connection_attempts_incognito' : 'arp_model_connection_attempts'),
      idPrefix: 'model_attempt',
      maxEntries: 200,
      leaseMs: 5 * 60 * 1000,
    });

    function queuedWrite(callback) {
      var result = writeQueue.then(callback);
      writeQueue = result.catch(function () {});
      return result;
    }

    function loadConversationState() {
      return Promise.resolve(conversationState.load({ fresh: true }));
    }

    function knownRunSettings(settings) {
      settings = isRecord(settings) ? settings : {};
      var normalized = conversationState.normalizeAssistantProfile({ settings: settings }).settings || {};
      var output = {};
      RUN_SETTING_KEYS.forEach(function (key) { output[key] = clone(normalized[key]); });
      return output;
    }

    function assistantResource(assistant) {
      var settings = isRecord(assistant && assistant.settings) ? assistant.settings : {};
      return {
        id: String(assistant && assistant.id || ''),
        name: String(assistant && assistant.name || ''),
        description: String(assistant && assistant.description || ''),
        prompt: String(hasOwn(assistant, 'prompt') ? assistant.prompt : ''),
        skillIds: clone(Array.isArray(assistant && assistant.skillIds) ? assistant.skillIds : []),
        mcpServerIds: clone(Array.isArray(assistant && assistant.mcpServerIds) ? assistant.mcpServerIds : []),
        resourcePolicy: clone(conversationState.normalizeResourcePolicy(assistant && assistant.resourcePolicy)),
        modelServiceId: String(hasOwn(assistant, 'modelServiceId') ? assistant.modelServiceId : (settings.modelServiceId || '')),
        settings: knownRunSettings(settings),
        createdAt: Math.max(0, Number(assistant && assistant.createdAt) || 0),
        updatedAt: Math.max(0, Number(assistant && assistant.updatedAt) || 0),
      };
    }

    function assistantFromState(state, assistantId) {
      assistantId = cleanId(assistantId, 'assistantId');
      var assistant = state && state.assistants && state.assistants[assistantId];
      if (!assistant) fail('RESOURCE_NOT_FOUND', 'Assistant does not exist: ' + assistantId);
      return assistant;
    }

    function listAssistants(query) {
      return loadConversationState().then(function (state) {
        var order = Array.isArray(state.assistantOrder) ? state.assistantOrder.slice() : Object.keys(state.assistants || {});
        var seen = Object.create(null);
        var items = order.concat(Object.keys(state.assistants || {})).filter(function (id) {
          if (seen[id] || !state.assistants[id]) return false;
          seen[id] = true;
          return true;
        }).map(function (id) { return assistantResource(state.assistants[id]); });
        return pageWindow(items, query);
      });
    }

    function getAssistant(assistantId) {
      return loadConversationState().then(function (state) {
        return assistantResource(assistantFromState(state, assistantId));
      });
    }

    function loadModelBundle() {
      return storageCall(storageArea, 'get', [modelSettingsKey, MODEL_META_KEY, AGENT_SETTINGS_META_KEY]).then(function (stored) {
        var raw = isRecord(stored && stored[modelSettingsKey]) ? stored[modelSettingsKey] : {};
        var settings = modelSettings.normalizeSettings(raw);
        settings.updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
        return {
          settings: settings,
          meta: isRecord(stored && stored[MODEL_META_KEY]) ? clone(stored[MODEL_META_KEY]) : {},
          agentSettingsMeta: isRecord(stored && stored[AGENT_SETTINGS_META_KEY])
            ? clone(stored[AGENT_SETTINGS_META_KEY])
            : null,
        };
      });
    }

    function saveModelBundle(bundle) {
      bundle.settings.updatedAt = Date.now();
      bundle.settings = modelSettings.normalizeSettings(bundle.settings);
      var values = {};
      values[modelSettingsKey] = bundle.settings;
      values[MODEL_META_KEY] = bundle.meta;
      if (bundle.agentSettingsMeta) values[AGENT_SETTINGS_META_KEY] = bundle.agentSettingsMeta;
      return storageCall(storageArea, 'set', values).then(function () { return bundle; });
    }

    function rawModelService(bundle, serviceId) {
      serviceId = cleanId(serviceId, 'modelServiceId');
      var service = modelSettings.getService(bundle.settings, serviceId, false);
      if (!service) fail('RESOURCE_NOT_FOUND', 'Model Service does not exist: ' + serviceId);
      return service;
    }

    function credentialMetadata(service, serviceId, meta) {
      var headerNames = Object.keys(service.headers || {}).sort();
      var configured = !!String(service.apiKey || '').trim() || headerNames.length > 0;
      return {
        hasSecret: configured,
        secretRef: 'model-service:' + serviceId,
        apiKeyConfigured: !!String(service.apiKey || '').trim(),
        headers: headerNames.map(function (name) { return { name: name, configured: true, masked: true }; }),
        revision: Math.max(0, Number(meta && meta.secretRevision) || 0),
      };
    }

    function modelServiceResource(service, meta) {
      meta = isRecord(meta) ? meta : {};
      return {
        id: String(service.id || ''),
        name: String(service.name || ''),
        baseUrl: String(service.baseUrl || ''),
        model: String(service.model || ''),
        visionModel: String(service.visionModel || ''),
        summaryModel: String(service.summaryModel || ''),
        protocol: modelSettings.normalizeModelProtocol(service.protocol),
        userAgent: String(service.userAgent || ''),
        maxContextTokens: Math.max(0, Number(service.maxContextTokens) || 0),
        autoCompactTokenLimit: Math.max(0, Number(service.autoCompactTokenLimit) || 0),
        reasoningEffort: String(service.reasoningEffort || 'auto'),
        requestTimeoutMs: Math.max(1000, Number(service.requestTimeoutMs) || 120000),
        maxRetries: Math.max(0, Number(service.maxRetries) || 0),
        maxRetryDelayMs: Math.max(0, Number(service.maxRetryDelayMs) || 0),
        contextCompression: String(service.contextCompression || 'auto'),
        credentialMetadata: credentialMetadata(service, service.id, meta),
        createdAt: Math.max(0, Number(meta.createdAt) || 0),
        updatedAt: Math.max(0, Number(meta.updatedAt) || 0),
      };
    }

    function listModelServices(query) {
      return loadModelBundle().then(function (bundle) {
        return pageWindow((bundle.settings.services || []).map(function (service) {
          return modelServiceResource(service, bundle.meta[service.id]);
        }), query);
      });
    }

    function getModelService(serviceId) {
      return loadModelBundle().then(function (bundle) {
        var service = rawModelService(bundle, serviceId);
        return modelServiceResource(service, bundle.meta[service.id]);
      });
    }

    function validateModelReference(serviceId) {
      if (!String(serviceId || '').trim()) return Promise.resolve('');
      return getModelService(serviceId).then(function () { return cleanId(serviceId, 'modelServiceId'); });
    }

    function createAssistant(body) {
      body = isRecord(body) ? clone(body) : {};
      assertOnly(body, ASSISTANT_MUTABLE_KEYS, 'Assistant');
      if (!String(body.name || '').trim()) fail('SCHEMA_VALIDATION_FAILED', 'Assistant name is required');
      var modelServiceId = String(body.modelServiceId || '').trim();
      return validateModelReference(modelServiceId).then(function () {
        var resource = {
          name: String(body.name).trim(),
          description: String(body.description || ''),
          prompt: String(body.prompt || ''),
          skillIds: clone(Array.isArray(body.skillIds) ? body.skillIds : []),
          mcpServerIds: clone(Array.isArray(body.mcpServerIds) ? body.mcpServerIds : []),
          resourcePolicy: hasOwn(body, 'resourcePolicy')
            ? conversationState.createResourcePolicy(body.resourcePolicy)
            : conversationState.createResourcePolicy(),
          modelServiceId: modelServiceId,
          settings: knownRunSettings(body.settings),
        };
        return conversationState.createAssistant({
          name: resource.name,
          description: resource.description,
          prompt: resource.prompt,
          skillIds: resource.skillIds,
          mcpServerIds: resource.mcpServerIds,
          modelServiceId: resource.modelServiceId,
          resourcePolicy: resource.resourcePolicy,
          settings: resource.settings,
        });
      }).then(function (result) {
        var assistant = result && result.assistant;
        if (!assistant || !assistant.id) fail('INTERNAL_ERROR', 'ConversationState.createAssistant did not return an Assistant');
        return getAssistant(assistant.id);
      });
    }

    function patchAssistant(assistantId, patch) {
      return getAssistant(assistantId).then(function (current) {
        var next = applyPatch(current, patch);
        if (!isRecord(next)) fail('SCHEMA_VALIDATION_FAILED', 'Assistant PATCH must leave an object');
        assertOnly(next, Object.assign({ id: true, createdAt: true, updatedAt: true }, ASSISTANT_MUTABLE_KEYS), 'Assistant');
        if (next.id !== current.id) fail('RESOURCE_CONFLICT', 'Assistant identity fields are immutable');
        if (!String(next.name || '').trim()) fail('SCHEMA_VALIDATION_FAILED', 'Assistant name is required');
        return validateModelReference(next.modelServiceId).then(function () {
          return conversationState.updateAssistant(current.id, {
            name: String(next.name).trim(),
            description: String(next.description || ''),
            prompt: String(next.prompt || ''),
            skillIds: clone(Array.isArray(next.skillIds) ? next.skillIds : []),
            mcpServerIds: clone(Array.isArray(next.mcpServerIds) ? next.mcpServerIds : []),
            modelServiceId: String(next.modelServiceId || ''),
            resourcePolicy: conversationState.normalizeResourcePolicy(next.resourcePolicy),
            settings: knownRunSettings(next.settings),
          });
        }).then(function () { return getAssistant(current.id); });
      });
    }

    function deleteAssistantConversations(state, assistantId) {
      var topics = state && state.topics || {};
      var topicIds = Object.keys(topics).filter(function (topicId) {
        return topics[topicId] && String(topics[topicId].assistantId || '') === assistantId;
      });
      return topicIds.reduce(function (chain, topicId) {
        return chain.then(function () {
          var deleteJournal = conversationJournal && typeof conversationJournal.deleteConversation === 'function'
            ? conversationJournal.deleteConversation(topicId)
            : Promise.resolve();
          return Promise.resolve(deleteJournal).then(function () {
            return conversationState.deleteTopic(topicId);
          });
        });
      }, Promise.resolve());
    }

    function deleteAssistant(assistantId) {
      assistantId = cleanId(assistantId, 'assistantId');
      return loadConversationState().then(function (state) {
        assistantFromState(state, assistantId);
        return deleteAssistantConversations(state, assistantId).then(function () {
          return conversationState.deleteAssistant(assistantId);
        });
      }).then(function () { return { id: assistantId, deleted: true }; });
    }

    function validateBaseUrl(value) {
      var text = String(value || '').trim();
      if (!text) return '';
      var parsed;
      try { parsed = new URL(text); } catch (_) { fail('SCHEMA_VALIDATION_FAILED', 'Model Service baseUrl must be an absolute URL'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        fail('SCHEMA_VALIDATION_FAILED', 'Model Service baseUrl must use http or https');
      }
      return text;
    }

    function applySecret(service, secret, createMode) {
      if (secret === undefined) {
        if (createMode) { service.apiKey = ''; service.headers = {}; }
        return service;
      }
      if (!isRecord(secret)) fail('SCHEMA_VALIDATION_FAILED', 'secret must be an object');
      assertOnly(secret, { apiKey: true, clearApiKey: true, headers: true, clearHeaders: true }, 'secret');
      if (secret.apiKey !== undefined && secret.clearApiKey === true) {
        fail('SCHEMA_VALIDATION_FAILED', 'secret cannot set and clear apiKey in one request');
      }
      if (secret.headers !== undefined && secret.clearHeaders === true) {
        fail('SCHEMA_VALIDATION_FAILED', 'secret cannot set and clear headers in one request');
      }
      if (secret.apiKey !== undefined) {
        var apiKey = String(secret.apiKey || '');
        if (!apiKey) fail('SCHEMA_VALIDATION_FAILED', 'secret.apiKey must be non-empty; use clearApiKey to clear it');
        service.apiKey = apiKey;
      } else if (secret.clearApiKey === true) service.apiKey = '';
      if (secret.headers !== undefined) service.headers = modelSettings.normalizeProviderHeaders(secret.headers);
      else if (secret.clearHeaders === true) service.headers = {};
      return service;
    }

    function normalizedModelService(input, serviceId, current, createMode) {
      input = isRecord(input) ? clone(input) : {};
      assertOnly(input, Object.assign({ id: true }, MODEL_MUTABLE_KEYS), 'Model Service');
      if (!hasOwn(input, 'protocol') && hasOwn(input, 'apiStyle')) input.protocol = input.apiStyle;
      delete input.apiStyle;
      delete input.providerType;
      delete input.provider_type;
      delete input.reasoningProviderType;
      var secret = input.secret;
      delete input.secret;
      var merged = Object.assign({}, current || {}, input, { id: serviceId });
      merged.baseUrl = validateBaseUrl(merged.baseUrl);
      applySecret(merged, secret, createMode);
      var normalized;
      try { normalized = modelSettings.normalizeService(merged, serviceId, merged.name); }
      catch (error) { fail('SCHEMA_VALIDATION_FAILED', error.message); }
      if (!normalized) fail('SCHEMA_VALIDATION_FAILED', 'Model Service shape is not supported');
      return normalized;
    }

    function createModelService(body) {
      body = isRecord(body) ? clone(body) : {};
      var serviceId = cleanId(body.id || modelSettings.makeServiceId(), 'modelServiceId');
      return queuedWrite(function () {
        return loadModelBundle().then(function (bundle) {
          if (modelSettings.getService(bundle.settings, serviceId, false)) fail('RESOURCE_CONFLICT', 'Model Service already exists: ' + serviceId);
          var service = normalizedModelService(body, serviceId, null, true);
          if (!bundle.settings.generatorServiceId && isRecord(bundle.agentSettingsMeta)) {
            var globalBudget = isRecord(bundle.agentSettingsMeta.contextBudget)
              ? bundle.agentSettingsMeta.contextBudget
              : {};
            service.maxContextTokens = modelSettings.normalizeMaxContextTokens(globalBudget.maxContextTokens);
            service.autoCompactTokenLimit = Math.max(0, Math.floor(Number(globalBudget.autoCompactTokenLimit) || 0));
            service.contextCompression = modelSettings.normalizeContextCompression(bundle.agentSettingsMeta.contextCompression);
            service = modelSettings.normalizeService(service, serviceId, service.name);
          }
          bundle.settings.services = (bundle.settings.services || []).concat([service]);
          var now = Date.now();
          bundle.meta[serviceId] = { createdAt: now, updatedAt: now, secretRevision: now };
          if (!bundle.settings.defaultServiceId) bundle.settings.defaultServiceId = serviceId;
          if (!bundle.settings.generatorServiceId) bundle.settings.generatorServiceId = serviceId;
          return saveModelBundle(bundle).then(function () {
            return modelServiceResource(service, bundle.meta[serviceId]);
          });
        });
      });
    }

    function patchModelService(serviceId, patch) {
      serviceId = cleanId(serviceId, 'modelServiceId');
      return queuedWrite(function () {
        return loadModelBundle().then(function (bundle) {
          var currentRaw = rawModelService(bundle, serviceId);
          var current = modelServiceResource(currentRaw, bundle.meta[serviceId]);
          var patchForResource = clone(patch);
          if (isRecord(patchForResource)
              && !hasOwn(patchForResource, 'protocol') && hasOwn(patchForResource, 'apiStyle')) {
            patchForResource.protocol = patchForResource.apiStyle;
            delete patchForResource.apiStyle;
          }
          if (isRecord(patchForResource)) {
            delete patchForResource.providerType;
          }
          var secret;
          if (isRecord(patchForResource)
              && Object.prototype.hasOwnProperty.call(patchForResource, 'secret')) {
            secret = patchForResource.secret;
            delete patchForResource.secret;
          }
          var next = applyPatch(current, patchForResource);
          if (!isRecord(next)) fail('SCHEMA_VALIDATION_FAILED', 'Model Service PATCH must leave an object');
          if (next.id !== serviceId) fail('RESOURCE_CONFLICT', 'Model Service id is immutable');
          var input = {};
          Object.keys(MODEL_MUTABLE_KEYS).forEach(function (key) {
            if (key !== 'secret' && Object.prototype.hasOwnProperty.call(next, key)) input[key] = next[key];
          });
          if (secret !== undefined) input.secret = secret;
          var updated = normalizedModelService(input, serviceId, currentRaw, false);
          bundle.settings.services = bundle.settings.services.map(function (item) { return item.id === serviceId ? updated : item; });
          var meta = bundle.meta[serviceId] || { createdAt: Date.now() };
          meta.updatedAt = Date.now();
          if (secret !== undefined) meta.secretRevision = meta.updatedAt;
          bundle.meta[serviceId] = meta;
          return saveModelBundle(bundle).then(function () { return modelServiceResource(updated, meta); });
        });
      });
    }

    function deleteModelService(serviceId) {
      serviceId = cleanId(serviceId, 'modelServiceId');
      return queuedWrite(function () {
        return Promise.all([loadModelBundle(), loadConversationState()]).then(function (values) {
          var bundle = values[0];
          var conversation = values[1];
          rawModelService(bundle, serviceId);
          bundle.settings.services = bundle.settings.services.filter(function (service) { return service.id !== serviceId; });
          var fallbackServiceId = String(bundle.settings.services[0] && bundle.settings.services[0].id || '');
          if (bundle.settings.defaultServiceId === serviceId) bundle.settings.defaultServiceId = fallbackServiceId;
          if (bundle.settings.generatorServiceId === serviceId) bundle.settings.generatorServiceId = fallbackServiceId;
          delete bundle.meta[serviceId];
          var assistantIds = Object.keys(conversation && conversation.assistants || {}).filter(function (assistantId) {
            var assistant = conversation.assistants[assistantId];
            return String(assistant && assistant.modelServiceId || '') === serviceId;
          });
          var topicIds = Object.keys(conversation && conversation.topics || {}).filter(function (topicId) {
            var topic = conversation.topics[topicId];
            return String(topic && topic.modelServiceId || '') === serviceId;
          });
          var detach = assistantIds.reduce(function (chain, assistantId) {
            return chain.then(function () {
              return conversationState.updateAssistant(assistantId, { modelServiceId: '' });
            });
          }, Promise.resolve());
          if (typeof conversationState.updateTopic === 'function') {
            detach = topicIds.reduce(function (chain, topicId) {
              return chain.then(function () {
                return conversationState.updateTopic(topicId, { modelServiceId: '' });
              });
            }, detach);
          }
          return detach.then(function () {
            if (!conversationJournal || typeof conversationJournal.putMetadata !== 'function') return null;
            return topicIds.reduce(function (chain, topicId) {
              return chain.then(function () { return conversationJournal.putMetadata(topicId, { serviceId: '' }); });
            }, Promise.resolve());
          }).then(function () {
            return saveModelBundle(bundle);
          }).then(function () { return { id: serviceId, deleted: true }; });
        });
      });
    }

    function ownerFromContext(context) {
      var actorId = String(context && context.actorId || '').trim();
      var conversationId = String(context && context.conversationId || '').trim();
      if (!actorId || !conversationId) fail('AUTHENTICATION_REQUIRED', 'ConnectionAttempt requires an actor and conversation owner');
      return { actorId: actorId, conversationId: conversationId };
    }

    function sameOwner(left, right) {
      return !!(left && right && left.actorId === right.actorId && left.conversationId === right.conversationId);
    }

    function publicAttempt(record) {
      record = record || {};
      var publicError = null;
      if (record.error) {
        publicError = isRecord(record.error)
          ? clone(record.error)
          : {
            code: record.status === 'interrupted' ? 'OPERATION_INTERRUPTED' : 'PROVIDER_REQUEST_FAILED',
            message: redactErrorMessage(record.error),
          };
      }
      return {
        id: String(record.id || ''),
        kind: 'model-service-connection-attempt',
        serviceId: String(record.serviceId || ''),
        owner: clone(record.owner || {}),
        protocol: String(record.protocol || ''),
        status: String(record.status || ''),
        startedAt: Number(record.startedAt) || 0,
        createdAt: Number(record.createdAt) || Number(record.startedAt) || 0,
        updatedAt: Number(record.updatedAt) || 0,
        heartbeatAt: Number(record.heartbeatAt) || 0,
        leaseExpiresAt: Number(record.leaseExpiresAt) || 0,
        endedAt: Number(record.endedAt) || 0,
        latencyMs: Number(record.latencyMs) || 0,
        result: record.result ? clone(record.result) : null,
        error: publicError,
        recoverable: record.recoverable === true,
      };
    }

    function getConnectionAttempt(serviceId, attemptId, context) {
      serviceId = cleanId(serviceId, 'modelServiceId');
      attemptId = cleanId(attemptId, 'attemptId');
      var owner = ownerFromContext(context);
      return attemptStore.get(attemptId).then(function (record) {
        if (!record || String(record.serviceId || '') !== serviceId) fail('RESOURCE_NOT_FOUND', 'ConnectionAttempt does not exist: ' + attemptId);
        if (!sameOwner(record.owner, owner)) fail('FORBIDDEN', 'ConnectionAttempt belongs to another owner');
        return publicAttempt(record);
      });
    }

    function createConnectionAttempt(serviceId, context) {
      serviceId = cleanId(serviceId, 'modelServiceId');
      var owner = ownerFromContext(context);
      return loadModelBundle().then(function (bundle) {
        var service = rawModelService(bundle, serviceId);
        if (!String(service.baseUrl || '').trim() || !String(service.model || '').trim()) {
          fail('SCHEMA_VALIDATION_FAILED', 'Model Service requires baseUrl and model before a connection attempt');
        }
        var style;
        try { style = modelSettings.normalizeModelProtocol(service.protocol); }
        catch (error) { fail('SCHEMA_VALIDATION_FAILED', error.message); }
        if (!Array.isArray(agentProvider.PROTOCOLS) || agentProvider.PROTOCOLS.indexOf(style) === -1) {
          fail('SCHEMA_VALIDATION_FAILED', 'No canonical AgentProvider for protocol: ' + style);
        }
        var attemptId = randomId('model_attempt');
        var startedAt = Date.now();
        var record = {
          id: attemptId,
          kind: 'model-service-connection-attempt',
          serviceId: serviceId,
          owner: owner,
          protocol: style,
          status: 'running',
          startedAt: startedAt,
          createdAt: startedAt,
        };
        return attemptStore.save(record).then(function (stored) {
          var timeoutMs = Math.min(120000, Math.max(1000, Number(service.requestTimeoutMs) || 30000));
          var provider;
          try {
            provider = agentProvider.createModelProvider({
              service: service,
              assistant: {
                model: service.model,
                settings: { maxTokens: 16, temperature: 0, topP: 1, reasoningEffort: 'none', timeoutMs: timeoutMs },
              },
              modelSettings: modelSettings,
              fetch: fetchImpl,
            });
          } catch (error) {
            record.status = 'failed';
            record.endedAt = Date.now();
            record.latencyMs = record.endedAt - startedAt;
            record.error = { code: String(error.code || 'PROVIDER_INITIALIZATION_FAILED'), message: redactErrorMessage(error.message) };
            return attemptStore.update(attemptId, record).then(function (failed) { return publicAttempt(failed); });
          }
          Promise.resolve(provider.request({
            purpose: 'connection-test',
            messages: [{ role: 'user', content: '只回复：ok' }],
            tools: [],
            sessionId: attemptId,
          })).then(function (response) {
            record.status = 'succeeded';
            record.endedAt = Date.now();
            record.latencyMs = record.endedAt - startedAt;
            record.result = {
              protocol: style,
              model: String(response && response.model || service.model || ''),
              finishReason: String(response && response.finishReason || ''),
              contentChars: String(response && response.content || '').length,
              receivedContent: !!String(response && response.content || ''),
            };
            return attemptStore.update(attemptId, record);
          }, function (error) {
            record.status = 'failed';
            record.endedAt = Date.now();
            record.latencyMs = record.endedAt - startedAt;
            record.error = {
              code: String(error && error.code || error && error.name || 'PROVIDER_REQUEST_FAILED'),
              status: Math.max(0, Number(error && error.status) || 0),
              message: redactErrorMessage(error && error.message),
            };
            return attemptStore.update(attemptId, record);
          }).catch(function () {});
          return publicAttempt(stored);
        });
      });
    }

    function getAgentSettings() {
      return Promise.all([
        loadConversationState(),
        loadModelBundle(),
        systemSettings.load(storageArea, runtime),
      ]).then(function (values) {
        var conversation = values[0];
        var bundle = values[1];
        var system = values[2] || {};
        var service = bundle.settings.generatorServiceId
          ? modelSettings.getService(bundle.settings, bundle.settings.generatorServiceId, false)
          : null;
        var storedMeta = isRecord(bundle.agentSettingsMeta) ? bundle.agentSettingsMeta : {};
        var storedBudget = isRecord(storedMeta.contextBudget) ? storedMeta.contextBudget : {};
        var hasStoredMaxContext = Object.prototype.hasOwnProperty.call(storedBudget, 'maxContextTokens');
        var hasStoredCompactLimit = Object.prototype.hasOwnProperty.call(storedBudget, 'autoCompactTokenLimit');
        return {
          defaultAssistantId: String(conversation.activeAssistantId || ''),
          defaultModelServiceId: String(bundle.settings.generatorServiceId || ''),
          contextBudget: {
            maxContextTokens: hasStoredMaxContext
              ? Math.max(0, Number(storedBudget.maxContextTokens) || 0)
              : Math.max(0, Number(service && service.maxContextTokens) || modelSettings.DEFAULT_MAX_CONTEXT_TOKENS || 0),
            autoCompactTokenLimit: hasStoredCompactLimit
              ? Math.max(0, Number(storedBudget.autoCompactTokenLimit) || 0)
              : Math.max(0, Number(service && service.autoCompactTokenLimit) || 0),
          },
          contextCompression: String(storedMeta.contextCompression || service && service.contextCompression || 'auto'),
        };
      });
    }

    function patchTouches(patch, key) {
      return isRecord(patch) && Object.prototype.hasOwnProperty.call(patch, key);
    }

    function patchAgentSettings(patch) {
      return queuedWrite(function () {
        return getAgentSettings().then(function (current) {
          var next = applyPatch(current, patch);
          if (!isRecord(next)) fail('SCHEMA_VALIDATION_FAILED', 'Agent Settings PATCH must leave an object');
          assertOnly(next, AGENT_SETTINGS_KEYS, 'Agent Settings');
          var changes = {
            defaultAssistantId: patchTouches(patch, 'defaultAssistantId'),
            defaultModelServiceId: patchTouches(patch, 'defaultModelServiceId'),
            contextBudget: patchTouches(patch, 'contextBudget'),
            contextCompression: patchTouches(patch, 'contextCompression'),
          };
          return Promise.all([loadConversationState(), loadModelBundle(), systemSettings.load(storageArea, runtime)]).then(function (values) {
            var conversation = values[0];
            var bundle = values[1];
            var system = values[2] || {};
            var assistantId = String(next.defaultAssistantId || '').trim();
            var serviceId = String(next.defaultModelServiceId || '').trim();
            if (changes.defaultAssistantId && assistantId
                && (!conversation.assistants || !conversation.assistants[assistantId])) {
              fail('RESOURCE_NOT_FOUND', 'Default Assistant does not exist: ' + assistantId);
            }
            var service = null;
            if (serviceId && (changes.defaultModelServiceId || changes.contextBudget || changes.contextCompression)) {
              service = rawModelService(bundle, serviceId);
            }
            var contextBudget = isRecord(next.contextBudget) ? next.contextBudget : {};
            var modelSettingsChanged = changes.defaultModelServiceId || changes.contextBudget || changes.contextCompression;
            if (changes.contextBudget || changes.contextCompression) {
              bundle.agentSettingsMeta = {
                contextBudget: {
                  maxContextTokens: Math.max(0, Math.floor(Number(contextBudget.maxContextTokens) || 0)),
                  autoCompactTokenLimit: Math.max(0, Math.floor(Number(contextBudget.autoCompactTokenLimit) || 0)),
                },
                contextCompression: modelSettings.normalizeContextCompression(next.contextCompression),
                updatedAt: Date.now(),
              };
            }
            if (service && modelSettingsChanged) {
              service.maxContextTokens = modelSettings.normalizeMaxContextTokens(contextBudget.maxContextTokens);
              service.autoCompactTokenLimit = Math.max(0, Math.floor(Number(contextBudget.autoCompactTokenLimit) || 0));
              service.contextCompression = modelSettings.normalizeContextCompression(next.contextCompression);
              service = modelSettings.normalizeService(service, serviceId, service.name);
              bundle.settings.services = bundle.settings.services.map(function (item) { return item.id === serviceId ? service : item; });
              var meta = bundle.meta[serviceId] || { createdAt: Date.now() };
              meta.updatedAt = Date.now();
              bundle.meta[serviceId] = meta;
            }
            if (changes.defaultModelServiceId) bundle.settings.generatorServiceId = serviceId;
            var saveModel = modelSettingsChanged ? saveModelBundle(bundle) : Promise.resolve(bundle);
            return saveModel.then(function () {
              if (!changes.defaultAssistantId || !assistantId) return null;
              return conversationState.setActiveAssistant(assistantId);
            }).then(function () {
              return system;
            }).then(function () {
              return getAgentSettings();
            });
          });
        });
      });
    }

    function preconditionState(context, _request, route, params) {
      var template = route && route.template || '';
      if (template === '/assistants/{assistantId}') {
        return getAssistant(params.assistantId).then(function (item) { return { exists: true, etag: etag(item), current: null }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      if (template === '/model-services/{serviceId}') {
        return getModelService(params.serviceId).then(function (item) { return { exists: true, etag: etag(item), current: null }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      if (template === '/agent-settings') {
        return getAgentSettings().then(function (item) { return { exists: true, etag: etag(item), current: null }; });
      }
      if (template === '/model-services/{serviceId}/connection-attempts/{attemptId}') {
        return getConnectionAttempt(params.serviceId, params.attemptId, context).then(function (item) { return { exists: true, etag: etag(item), current: null }; }, function (error) {
          if (error && error.code === 'RESOURCE_NOT_FOUND') return { exists: false };
          throw error;
        });
      }
      return Promise.resolve(null);
    }

    return Object.freeze({
      etag: etag,
      applyPatch: applyPatch,
      listAssistants: listAssistants,
      getAssistant: getAssistant,
      createAssistant: createAssistant,
      patchAssistant: patchAssistant,
      deleteAssistant: deleteAssistant,
      listModelServices: listModelServices,
      getModelService: getModelService,
      createModelService: createModelService,
      patchModelService: patchModelService,
      deleteModelService: deleteModelService,
      createConnectionAttempt: createConnectionAttempt,
      getConnectionAttempt: getConnectionAttempt,
      getAgentSettings: getAgentSettings,
      patchAgentSettings: patchAgentSettings,
      preconditionState: preconditionState,
      connectionAttemptStore: attemptStore,
      // 可写字段的唯一事实源投影。路由合同在组装时据此自检，
      // 防止写入 schema 与本服务的允许字段再次漂移。
      mutableKeyContract: Object.freeze({
        assistant: Object.freeze(Object.keys(ASSISTANT_MUTABLE_KEYS).sort()),
        modelService: Object.freeze(Object.keys(MODEL_MUTABLE_KEYS).sort()),
        agentSettings: Object.freeze(Object.keys(AGENT_SETTINGS_KEYS).sort()),
      }),
      permissionNames: Object.freeze([
        'assistants.read', 'assistants.write', 'assistants.delete',
        'model-services.read', 'model-services.write', 'model-services.delete',
        'model-services.execute', 'agent-settings.read', 'agent-settings.write',
      ]),
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    MODEL_META_KEY: MODEL_META_KEY,
    AGENT_SETTINGS_META_KEY: AGENT_SETTINGS_META_KEY,
    RUN_SETTING_KEYS: RUN_SETTING_KEYS,
    create: create,
  });
});
