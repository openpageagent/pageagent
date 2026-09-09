// One model-facing projection for durable tool results. ARP envelopes remain
// canonical runtime facts; Provider context and Conversation UI consume this view.
(function attachAgentToolResultProjection(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentToolResultProjection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var TERMINAL_TYPES = Object.freeze({
    tool_execution_completed: true,
    tool_execution_failed: true,
    tool_execution_unknown: true,
    tool_call_deferred: true,
  });
  var IMAGE_URI = /^\/image-artifacts\/[A-Za-z0-9._~-]{1,240}$/;

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function isRecord(value) { return !!(value && typeof value === 'object' && !Array.isArray(value)); }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function assignDefined(target, key, value) {
    if (value !== undefined && value !== null) target[key] = clone(value);
    return target;
  }
  function isArpResponse(value) {
    return !!(isRecord(value) && value.protocol === 'arp/1' && isRecord(value.status));
  }
  function normalizedProjection(value, response) {
    value = isRecord(value) ? value : {};
    var type = text(value.type);
    if (!type) {
      var resourceType = text(response && response.primary && response.primary.type);
      type = resourceType === 'Knowledge' || resourceType === 'SkillInstructions' || resourceType === 'SkillResource'
        ? 'field' : 'data';
      if (type === 'field') value = Object.assign({ field: 'content' }, value);
    }
    if (type !== 'data' && type !== 'field' && type !== 'capabilities' && type !== 'full') type = 'data';
    return {
      type: type,
      field: text(value.field),
      includeEtag: value.includeEtag === true,
      includeLinks: value.includeLinks === true,
      includeIncluded: value.includeIncluded === true,
    };
  }
  function compactRepresentation(value) {
    if (!isRecord(value)) return clone(value);
    var output = { data: clone(value.data) };
    if (value.etag !== undefined) output.etag = String(value.etag);
    return output;
  }
  function embeddedReceipt(value) {
    return isRecord(value) && (isRecord(value.actionReceipt) || isRecord(value.receipt)
      || hasOwn(value, 'performed') && (hasOwn(value, 'verification') || hasOwn(value, 'verificationStatus')));
  }
  function successReceipt(value) {
    if (!isRecord(value)) return clone(value);
    var output = clone(value);
    if (text(output.performed) !== 'unknown') delete output.idempotencyKey;
    return output;
  }
  function meaningfulSuccessReceipt(value, result, code) {
    var receipt = successReceipt(value);
    if (!isRecord(receipt)) return receipt;
    if (code === 202 || result === undefined || result === null) return receipt;
    var performed = text(receipt.performed).toLowerCase();
    if (performed === 'no' || performed === 'unknown') return receipt;
    var state = text(receipt.state).toLowerCase();
    var extra = Object.keys(receipt).filter(function (key) {
      return key !== 'performed' && key !== 'state';
    });
    if (extra.length || state && state !== 'succeeded' && state !== 'completed') return receipt;
    return null;
  }
  function boundedValue(value, maximum) {
    if (value === undefined || value === null) return value;
    try {
      if (JSON.stringify(value).length <= maximum) return clone(value);
    } catch (_) {}
    return { omitted: true, reason: 'model_projection_size_limit' };
  }
  function compactTargetState(value) {
    if (!isRecord(value)) return clone(value);
    var output = {};
    ['frameId', 'nodeName', 'tag', 'role', 'name', 'text'].forEach(function (key) {
      if (typeof value[key] === 'string' && value[key]) output[key] = value[key].slice(0, 800);
    });
    if (isRecord(value.attributes)) {
      var attributes = {};
      ['id', 'class', 'href', 'name', 'type', 'role', 'aria-label', 'title'].forEach(function (key) {
        if (typeof value.attributes[key] === 'string' && value.attributes[key]) attributes[key] = value.attributes[key].slice(0, 1000);
      });
      if (Object.keys(attributes).length) output.attributes = attributes;
    }
    ['bounds', 'locator'].forEach(function (key) {
      if (isRecord(value[key])) output[key] = clone(value[key]);
    });
    ['visible', 'inViewport', 'occluded', 'enabled', 'editable', 'checked', 'selected', 'expanded'].forEach(function (key) {
      if (value[key] !== undefined && value[key] !== null) output[key] = value[key];
    });
    if (value.value !== undefined && value.value !== null) output.value = typeof value.value === 'string' ? value.value.slice(0, 800) : clone(value.value);
    return output;
  }
  function compactVerification(value) {
    if (!isRecord(value)) return clone(value);
    var output = {};
    ['status', 'performed', 'conditionMet', 'reason'].forEach(function (key) { assignDefined(output, key, value[key]); });
    if (Array.isArray(value.signals)) output.signals = value.signals.slice(0, 24).map(String);
    if (Array.isArray(value.evidence)) {
      output.evidence = value.evidence.slice(0, 12).map(function (evidence) {
        if (!isRecord(evidence)) return boundedValue(evidence, 2000);
        if (evidence.kind === 'action_facts') {
          var commands = Array.isArray(evidence.commands) ? evidence.commands.map(String) : [];
          return { kind: 'action_facts', commandCount: commands.length, commands: Array.from(new Set(commands)).slice(0, 24) };
        }
        if (evidence.kind === 'target_state') {
          return { kind: 'target_state', before: compactTargetState(evidence.before), after: compactTargetState(evidence.after) };
        }
        return boundedValue(evidence, 4000);
      });
    }
    return output;
  }
  function compactActionFacts(value) {
    if (!isRecord(value)) return undefined;
    var output = {};
    ['actionId', 'tabId', 'kind', 'dispatched', 'transportInterrupted', 'actualCoordinates'].forEach(function (key) {
      assignDefined(output, key, value[key]);
    });
    if (value.target !== undefined) output.target = boundedValue(value.target, 4000);
    if (value.failure !== undefined) output.failure = boundedValue(value.failure, 4000);
    if (Array.isArray(value.commands)) {
      var methods = value.commands.map(function (command) { return text(command && command.method); }).filter(Boolean);
      output.commandCount = methods.length;
      output.commandMethods = Array.from(new Set(methods)).slice(0, 24);
    }
    if (Array.isArray(value.warnings) && value.warnings.length) {
      output.warnings = value.warnings.slice(0, 24).map(function (warning) { return boundedValue(warning, 2000); });
    }
    return output;
  }
  function compactInteractionData(value) {
    if (!isRecord(value)) return clone(value);
    var output = {};
    ['id', 'actionId', 'kind', 'status', 'performed', 'conditionMet', 'locator', 'targetTabId', 'targetDisposition',
      'targetUrl', 'targetActive', 'startedAt', 'completedAt', 'durationMs'].forEach(function (key) {
      assignDefined(output, key, value[key]);
    });
    ['newNavigationTarget', 'navigation'].forEach(function (key) {
      if (value[key] !== undefined) output[key] = boundedValue(value[key], 8000);
    });
    if (value.result !== undefined) output.result = boundedValue(value.result, 8000);
    if (value.verification !== undefined) output.verification = compactVerification(value.verification);
    var actionFacts = compactActionFacts(value.actionFacts);
    if (actionFacts && Object.keys(actionFacts).length) output.actionFacts = actionFacts;
    if (Array.isArray(value.warnings) && value.warnings.length) {
      output.warnings = value.warnings.slice(0, 24).map(function (warning) { return boundedValue(warning, 2000); });
    }
    ['visualEvidence', 'modelContent'].forEach(function (key) {
      if (value[key] !== undefined) output[key] = boundedValue(value[key], 12000);
    });
    return output;
  }
  function errorProjection(response) {
    var error = clone(response.error || { code: 'RESOURCE_REQUEST_FAILED', message: '资源请求失败' });
    if (error && error.current !== undefined && error.current !== null) {
      error.current = compactRepresentation(error.current);
    }
    var output = {
      ok: false,
      error: error,
    };
    if (response.receipt) output.receipt = clone(response.receipt);
    if (Array.isArray(response.warnings) && response.warnings.length) output.warnings = clone(response.warnings);
    return output;
  }

  function projectArpResponse(response, projection, resourceCall) {
    if (!isArpResponse(response)) {
      if (isRecord(response) && response.kind === 'recording-projection-ref' && hasOwn(response, 'modelSnapshot')) {
        return clone(response.modelSnapshot);
      }
      return clone(response);
    }
    var args = isRecord(resourceCall && resourceCall.arguments) ? resourceCall.arguments : {};
    var descriptor = normalizedProjection(projection, response);
    if (args.responseMode === 'full' || descriptor.type === 'full') return clone(response);
    if (response.error) return errorProjection(response);

    var code = Number(response.status && response.status.code) || 0;
    if (code === 304) return { notModified: true };
    var primary = isRecord(response.primary) ? response.primary : null;
    var data = primary ? primary.data : undefined;
    var result;
    if (descriptor.type === 'capabilities') result = clone(response.capabilities || {});
    else if (descriptor.type === 'field') result = isRecord(data) && descriptor.field ? clone(data[descriptor.field]) : undefined;
    else if (primary && /(?:Interaction|PageWait)$/.test(text(primary.type))) result = compactInteractionData(data);
    else result = clone(data);

    var metadata = {};
    if (code === 202) metadata.accepted = true;
    if (code === 204) metadata.noContent = true;
    if (descriptor.includeEtag && primary && primary.etag !== undefined) metadata.etag = String(primary.etag);
    if (descriptor.includeLinks && primary && Array.isArray(primary.links) && primary.links.length) metadata.links = clone(primary.links);
    if (descriptor.includeIncluded && Array.isArray(response.included) && response.included.length) {
      metadata.included = response.included.map(compactRepresentation);
    }
    if (response.receipt && (!embeddedReceipt(result) || code === 202)) {
      var receipt = meaningfulSuccessReceipt(response.receipt, result, code);
      if (receipt !== null && receipt !== undefined) metadata.receipt = receipt;
    }
    if (Array.isArray(response.warnings) && response.warnings.length) metadata.warnings = clone(response.warnings);
    var metadataKeys = Object.keys(metadata);
    if (!metadataKeys.length) return result === undefined ? null : result;
    if (result !== undefined && result !== null) metadata = Object.assign({ result: result }, metadata);
    return metadata;
  }

  function failureDetail(payload) {
    var detail = {};
    if (payload.details !== undefined && payload.details !== null
        && (!isRecord(payload.details) || Object.keys(payload.details).length)) {
      assignDefined(detail, 'details', payload.details);
    }
    if (payload.current !== undefined && payload.current !== null) detail.current = compactRepresentation(payload.current);
    assignDefined(detail, 'lastKnownStage', payload.lastKnownStage);
    if (Number(payload.reconciliationAttempts) > 0) {
      detail.reconciliationAttempts = Math.floor(Number(payload.reconciliationAttempts));
    }
    if (payload.recovered === true) detail.recovered = true;
    return Object.keys(detail).length ? detail : undefined;
  }
  function projectTerminalEvent(event, resourceCall) {
    event = event || {};
    var payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === 'tool_execution_completed') {
      var completed = hasOwn(payload, 'result') ? payload.result : payload;
      return projectArpResponse(completed, payload.modelProjection, resourceCall);
    }
    if (event.type === 'tool_execution_unknown') {
      var unknown = {
        ok: false,
        error: {
          code: text(payload.errorCode) || 'SIDE_EFFECT_UNKNOWN',
          message: text(payload.error || payload.reason) || '无法核实工具是否产生了副作用',
        },
        performed: 'unknown',
      };
      assignDefined(unknown, 'receipt', payload.receipt);
      if (Array.isArray(payload.warnings) && payload.warnings.length) unknown.warnings = clone(payload.warnings);
      if (hasOwn(payload, 'result')) unknown.result = projectArpResponse(payload.result, payload.modelProjection, resourceCall);
      assignDefined(unknown, 'detail', failureDetail(payload));
      return unknown;
    }
    if (event.type === 'tool_call_deferred') {
      var deferred = {
        ok: false,
        error: {
          code: text(payload.errorCode) || 'TOOL_CALL_DEFERRED',
          message: text(payload.reason || payload.error) || '工具调用未执行',
        },
        performed: 'no',
      };
      assignDefined(deferred, 'detail', failureDetail(payload));
      return deferred;
    }
    var failed = {
      ok: false,
      error: {
        code: text(payload.errorCode) || 'TOOL_EXECUTION_FAILED',
        message: text(payload.error || payload.reason) || '工具执行失败',
        retryable: payload.retryable === true,
      },
      performed: text(payload.performed) || 'no',
    };
    assignDefined(failed, 'receipt', payload.receipt);
    if (Array.isArray(payload.warnings) && payload.warnings.length) failed.warnings = clone(payload.warnings);
    assignDefined(failed, 'detail', failureDetail(payload));
    return failed;
  }

  function normalizeImagePart(value) {
    if (!isRecord(value) || value.type !== 'image' || !IMAGE_URI.test(text(value.artifactUri))) return null;
    var output = { type: 'image', artifactUri: text(value.artifactUri) };
    ['mimeType', 'detail', 'alt', 'representation', 'sourceKind', 'acquisitionSource'].forEach(function (key) {
      if (typeof value[key] === 'string' && value[key].trim()) output[key] = value[key].trim();
    });
    ['width', 'height', 'byteLength'].forEach(function (key) {
      var number = Number(value[key]);
      if (Number.isFinite(number) && number >= 0) output[key] = Math.floor(number);
    });
    return output;
  }
  function modelImages(value) {
    var found = [];
    var seen = [];
    function visit(item, depth) {
      if (!item || typeof item !== 'object' || depth > 8 || seen.indexOf(item) !== -1) return;
      seen.push(item);
      if (Array.isArray(item.modelContent)) item.modelContent.forEach(function (part) {
        var normalized = normalizeImagePart(part);
        if (normalized) found.push(normalized);
      });
      if (Array.isArray(item)) item.forEach(function (child) { visit(child, depth + 1); });
      else Object.keys(item).forEach(function (key) {
        if (key !== 'modelContent') visit(item[key], depth + 1);
      });
    }
    visit(value, 0);
    var unique = Object.create(null);
    return found.filter(function (part) {
      if (unique[part.artifactUri]) return false;
      unique[part.artifactUri] = true;
      return true;
    }).slice(0, 4);
  }
  function toolResultContent(result) {
    var images = modelImages(result);
    if (!images.length) return clone(result);
    var serialized;
    try {
      serialized = JSON.stringify(result === undefined ? null : result, function (key, value) {
        return key === 'modelContent' ? undefined : value;
      });
    } catch (_) {
      serialized = JSON.stringify({ error: 'tool_result_serialization_failed' });
    }
    return [{ type: 'text', text: serialized }].concat(images);
  }
  function projectEventContent(event, resourceCall) {
    if (!event || !TERMINAL_TYPES[event.type]) return null;
    return toolResultContent(projectTerminalEvent(event, resourceCall));
  }
  function contentText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(function (part) {
      return isRecord(part) && part.type === 'text' ? String(part.text || '') : '';
    }).filter(Boolean).join('\n');
    if (value === undefined || value === null) return '';
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return String(value); }
  }
  function imageParts(value) {
    return (Array.isArray(value) ? value : []).filter(function (part) {
      return isRecord(part) && part.type === 'image' && IMAGE_URI.test(text(part.artifactUri));
    }).map(clone);
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    TERMINAL_TYPES: TERMINAL_TYPES,
    projectArpResponse: projectArpResponse,
    projectTerminalEvent: projectTerminalEvent,
    projectEventContent: projectEventContent,
    toolResultContent: toolResultContent,
    contentText: contentText,
    imageParts: imageParts,
  });
});
