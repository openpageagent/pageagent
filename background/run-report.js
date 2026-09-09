// Run Report - report schema, terminal state transitions, and bounded cloning.
(function attachRunReport(root, factory) {
  root.RunReport = factory();
})(globalThis, function () {
  'use strict';

  var REPORT_VERSION = 1;
  var ACTIVE_STATUSES = { idle: true, running: true };
  var TERMINAL_STATUSES = { success: true, failed: true, stopped: true, skipped: true };
  var MAX_LOG_ENTRIES = 300;
  var MAX_LOG_MESSAGE_LENGTH = 500;
  var DEFAULT_SANITIZE_OPTIONS = {
    maxStringLength: 128 * 1024,
    maxArrayItems: 500,
    maxObjectKeys: 300,
    maxDepth: 8,
    maxNodes: 5000,
    totalStringBudget: 768 * 1024,
  };

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return value;
  }

  function ownDataDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    try {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && !descriptor.get && !descriptor.set && hasOwn(descriptor, 'value') ? descriptor : null;
    } catch (_) {
      return null;
    }
  }

  function mergeOwnData() {
    var output = {};
    for (var sourceIndex = 0; sourceIndex < arguments.length; sourceIndex++) {
      var source = arguments[sourceIndex];
      if (!source || typeof source !== 'object') continue;
      Object.keys(source).forEach(function (key) {
        var descriptor = ownDataDescriptor(source, key);
        if (!descriptor) return;
        defineOwn(output, key, descriptor.value);
      });
    }
    return output;
  }

  function isReportObject(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function reportError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function assertReportObject(value, label) {
    if (!isReportObject(value)) {
      throw reportError('RUN_REPORT_INVALID', (label || '运行报告') + '必须是对象');
    }
  }

  function canonicalStatus(status) {
    status = String(status || '').trim().toLowerCase();
    if (status === 'completed' || status === 'complete' || status === 'passed') return 'success';
    if (status === 'aborted' || status === 'cancelled' || status === 'canceled') return 'stopped';
    return status;
  }

  function isActiveStatus(status) {
    return !!ACTIVE_STATUSES[canonicalStatus(status)];
  }

  function isTerminalStatus(status) {
    return !!TERMINAL_STATUSES[canonicalStatus(status)];
  }

  function sanitizeOptions(options) {
    options = options || {};
    var out = {};
    Object.keys(DEFAULT_SANITIZE_OPTIONS).forEach(function (key) {
      var fallback = DEFAULT_SANITIZE_OPTIONS[key];
      var supplied = Number(options[key]);
      out[key] = isFinite(supplied) && supplied > 0 ? Math.floor(supplied) : fallback;
    });
    return out;
  }

  function isImageDataUrl(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
  }

  function omitted(reason) {
    return '[omitted: ' + reason + ']';
  }

  function sanitizeString(value, state) {
    if (isImageDataUrl(value)) return omitted('image data url');
    var limit = Math.min(state.options.maxStringLength, state.remainingStringBudget);
    if (limit <= 0) return omitted('report budget exceeded');
    var output = value;
    if (value.length > limit) {
      var suffix = '\n... omitted ' + (value.length - limit) + ' chars';
      var prefixLength = Math.max(0, limit - suffix.length);
      output = value.slice(0, prefixLength) + suffix;
    }
    state.remainingStringBudget = Math.max(0, state.remainingStringBudget - output.length);
    return output;
  }

  function sanitizeError(value, depth, ancestors, state) {
    var output = { __type: 'Error' };
    var keys = ['name', 'message', 'stack', 'code', 'cause'];
    try {
      Object.keys(value).forEach(function (key) {
        if (keys.indexOf(key) === -1) keys.push(key);
      });
    } catch (_) {}
    ancestors.push(value);
    var limit = Math.max(0, state.options.maxObjectKeys - 1);
    for (var i = 0; i < keys.length && i < limit; i++) {
      var key = keys[i];
      var item;
      try { item = value[key]; } catch (_) { item = omitted('unreadable property'); }
      if (item !== undefined) defineOwn(output, key, sanitizeInternal(item, depth + 1, ancestors, state));
    }
    if (keys.length > limit) output.__omittedKeys = keys.length - limit;
    ancestors.pop();
    return output;
  }

  function sanitizeMap(value, depth, ancestors, state) {
    var output = { __type: 'Map', entries: [] };
    ancestors.push(value);
    try {
      var iterator = value.entries();
      while (output.entries.length < state.options.maxArrayItems) {
        var next = iterator.next();
        if (next.done) break;
        var key = next.value[0];
        var item = next.value[1];
        output.entries.push([
          sanitizeInternal(key, depth + 1, ancestors, state),
          sanitizeInternal(item, depth + 1, ancestors, state),
        ]);
      }
    } catch (_) {
      output.__omitted = 'unreadable map';
    }
    ancestors.pop();
    var mapSize = 0;
    try { mapSize = Number(value.size); } catch (_) {}
    if (isFinite(mapSize) && mapSize > output.entries.length) {
      output.__omittedEntries = mapSize - output.entries.length;
    }
    return output;
  }

  function sanitizeSet(value, depth, ancestors, state) {
    var output = { __type: 'Set', values: [] };
    ancestors.push(value);
    try {
      var iterator = value.values();
      while (output.values.length < state.options.maxArrayItems) {
        var next = iterator.next();
        if (next.done) break;
        var item = next.value;
        output.values.push(sanitizeInternal(item, depth + 1, ancestors, state));
      }
    } catch (_) {
      output.__omitted = 'unreadable set';
    }
    ancestors.pop();
    var setSize = 0;
    try { setSize = Number(value.size); } catch (_) {}
    if (isFinite(setSize) && setSize > output.values.length) {
      output.__omittedValues = setSize - output.values.length;
    }
    return output;
  }

  function sanitizeInternal(value, depth, ancestors, state) {
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string') return sanitizeString(value, state);
    if (valueType === 'number') return isFinite(value) ? value : null;
    if (valueType === 'boolean') return value;
    if (valueType === 'bigint') return String(value);
    if (valueType === 'function' || valueType === 'symbol') return omitted('unsupported ' + valueType);
    if (valueType !== 'object') return value;
    if (depth > state.options.maxDepth) return omitted('nesting too deep');
    if (state.remainingNodes <= 0) return omitted('report budget exceeded');
    state.remainingNodes -= 1;
    if (ancestors.indexOf(value) !== -1) return omitted('circular reference');

    var tag = '';
    try { tag = Object.prototype.toString.call(value); } catch (_) {}
    if (tag === '[object Date]') {
      try { return value.toISOString(); } catch (_) { return String(value); }
    }
    if (tag === '[object Error]' || tag === '[object DOMException]') {
      return sanitizeError(value, depth, ancestors, state);
    }
    if (tag === '[object Map]' && typeof value.forEach === 'function') {
      return sanitizeMap(value, depth, ancestors, state);
    }
    if (tag === '[object Set]' && typeof value.forEach === 'function') {
      return sanitizeSet(value, depth, ancestors, state);
    }

    ancestors.push(value);
    var output;
    if (Array.isArray(value)) {
      output = [];
      var arrayLimit = Math.min(value.length, state.options.maxArrayItems);
      for (var i = 0; i < arrayLimit; i++) {
        output.push(sanitizeInternal(value[i], depth + 1, ancestors, state));
      }
      if (value.length > state.options.maxArrayItems) {
        output.push({
          __omitted: true,
          reason: 'array-items-limit',
          length: value.length,
          omittedItems: value.length - state.options.maxArrayItems,
        });
      }
      ancestors.pop();
      return output;
    }

    output = {};
    var keys;
    try {
      keys = Object.keys(value);
    } catch (_) {
      ancestors.pop();
      return { __omitted: true, reason: 'unreadable-object' };
    }
    var objectLimit = Math.min(keys.length, state.options.maxObjectKeys);
    for (var k = 0; k < objectLimit; k++) {
      var key = keys[k];
      var descriptor = ownDataDescriptor(value, key);
      if (!descriptor) {
        defineOwn(output, key, omitted('unreadable property'));
        continue;
      }
      var item = descriptor.value;
      if ((key === 'screenshot' || key === 'dataUrl' || key === 'imageDataUrl') && isImageDataUrl(item)) {
        defineOwn(output, key + 'Omitted', true);
        defineOwn(output, key + 'Bytes', item.length);
        continue;
      }
      defineOwn(output, key, sanitizeInternal(item, depth + 1, ancestors, state));
    }
    if (keys.length > state.options.maxObjectKeys) {
      output.__omittedKeys = keys.length - state.options.maxObjectKeys;
      output.__totalKeys = keys.length;
    }
    ancestors.pop();
    return output;
  }

  function sanitizeValue(value, options) {
    var normalizedOptions = sanitizeOptions(options);
    return sanitizeInternal(value, 0, [], {
      options: normalizedOptions,
      remainingNodes: normalizedOptions.maxNodes,
      remainingStringBudget: normalizedOptions.totalStringBudget,
    });
  }

  function sanitizeLogs(logs) {
    if (!Array.isArray(logs)) return [];
    return logs.filter(function (entry) {
      return !!entry;
    }).slice(-MAX_LOG_ENTRIES).map(function (entry) {
      entry = isReportObject(entry) ? entry : { message: entry };
      var level = String(entry.level || 'info').toLowerCase();
      if (level === 'warning') level = 'warn';
      var scope = entry.scope || (entry.nodeId ? 'flow' : 'run');
      if (scope === 'session') scope = 'run';
      var message = hasOwn(entry, 'message') && entry.message !== null && entry.message !== undefined
        ? entry.message : '';
      return {
        timestamp: entry.timestamp,
        level: level,
        nodeId: entry.nodeId || '',
        scope: scope,
        tabId: entry.tabId || 0,
        windowId: entry.windowId || 0,
        flowId: entry.flowId || '',
        runId: entry.runId || '',
        message: String(message).slice(0, MAX_LOG_MESSAGE_LENGTH),
      };
    });
  }

  function settleNodeStatus(status, terminalStatus) {
    var normalized = canonicalStatus(status);
    if (normalized === 'pending' || normalized === 'idle' || normalized === 'queued' || normalized === 'not_started') {
      return 'skipped';
    }
    if (normalized === 'running' || normalized === 'starting') {
      if (terminalStatus === 'stopped') return 'stopped';
      if (terminalStatus === 'skipped') return 'skipped';
      return 'failed';
    }
    return status;
  }

  function settleNodeStatuses(statuses, terminalStatus) {
    if (!isReportObject(statuses)) return {};
    var output = {};
    Object.keys(statuses).forEach(function (nodeId) {
      var descriptor = ownDataDescriptor(statuses, nodeId);
      var status = descriptor ? descriptor.value : omitted('unreadable property');
      defineOwn(output, nodeId, typeof status === 'string'
        ? settleNodeStatus(status, terminalStatus)
        : sanitizeValue(status));
    });
    return output;
  }

  function settleSummaries(summaries, terminalStatus) {
    if (!Array.isArray(summaries)) return [];
    return summaries.map(function (summary) {
      if (!isReportObject(summary)) return sanitizeValue(summary);
      var output = sanitizeValue(summary);
      if (Array.isArray(output.steps)) {
        output.steps = output.steps.map(function (step) {
          if (!isReportObject(step)) return step;
          if (typeof step.status === 'string') {
            step.status = settleNodeStatus(step.status, terminalStatus);
          }
          return step;
        });
      }
      if (typeof output.status === 'string') {
        output.status = settleNodeStatus(output.status, terminalStatus);
      }
      return output;
    });
  }

  function deriveTerminalStatus(fields) {
    fields = fields || {};
    var explicitStatus = canonicalStatus(fields.status);
    if (fields.stopped === true || explicitStatus === 'stopped') return 'stopped';
    if (fields.error) return 'failed';
    if (explicitStatus === 'failed') return 'failed';

    var summaries = Array.isArray(fields.summaries) ? fields.summaries : [];
    if (summaries.length) {
      var statuses = summaries.map(function (summary) {
        return canonicalStatus(summary && summary.status);
      });
      if (statuses.some(function (status) { return status === 'failed'; })) return 'failed';
      if (statuses.some(function (status) { return status === 'stopped'; })) return 'stopped';
      if (statuses.every(function (status) { return status === 'success' || status === 'skipped'; })) {
        return explicitStatus === 'skipped' ? 'skipped' : 'success';
      }
      return 'failed';
    }
    if (TERMINAL_STATUSES[explicitStatus]) return explicitStatus;
    return 'failed';
  }

  function normalizeStoredRecord(record) {
    if (!isReportObject(record)) return null;
    return sanitizeValue(record);
  }

  function normalizeRecord(record) {
    assertReportObject(record, '运行报告');
    var output = normalizeStoredRecord(record);
    var id = String(output.id || '').trim();
    if (!id) throw reportError('RUN_REPORT_ID_REQUIRED', '运行报告缺少 id');
    output.id = id;
    if (output.status && !isActiveStatus(output.status) && !isTerminalStatus(output.status)) {
      throw reportError('RUN_REPORT_STATUS_INVALID', '无效的运行报告状态: ' + output.status);
    }
    return output;
  }

  function normalizePatch(patch) {
    assertReportObject(patch, '运行报告补丁');
    var output = sanitizeValue(patch);
    if (hasOwn(output, 'logs')) output.logs = sanitizeLogs(output.logs);
    if (output.status && !isActiveStatus(output.status) && !isTerminalStatus(output.status)) {
      throw reportError('RUN_REPORT_STATUS_INVALID', '无效的运行报告状态: ' + output.status);
    }
    return output;
  }

  function createStartRecord(fields) {
    assertReportObject(fields, '运行报告');
    var output = sanitizeValue(fields);
    var id = String(output.id || '').trim();
    if (!id) throw reportError('RUN_REPORT_ID_REQUIRED', '运行报告缺少 id');
    output.id = id;
    if (!output.kind) output.kind = 'flow';
    if (!output.reportVersion) output.reportVersion = REPORT_VERSION;
    output.status = 'running';
    return output;
  }

  function createTerminalPatch(fields) {
    assertReportObject(fields, '运行报告终态');
    var terminalStatus = deriveTerminalStatus(fields);
    var output = sanitizeValue(fields);
    var rawError = fields.error;
    delete output.stopped;
    output.status = terminalStatus;
    output.error = terminalStatus === 'stopped'
      ? ''
      : String(rawError && rawError.message ? rawError.message : (rawError || ''));
    if (hasOwn(output, 'summaries')) output.summaries = settleSummaries(output.summaries, terminalStatus);
    if (hasOwn(output, 'nodeStatuses')) output.nodeStatuses = settleNodeStatuses(output.nodeStatuses, terminalStatus);
    if (hasOwn(output, 'logs')) output.logs = sanitizeLogs(output.logs);
    if (hasOwn(output, 'output') && !hasOwn(output, 'result')) output.result = sanitizeValue(output.output);
    if (hasOwn(output, 'result') && !hasOwn(output, 'output')) output.output = sanitizeValue(output.result);
    return output;
  }

  function applyPatch(record, patch) {
    var current = normalizeStoredRecord(record);
    if (!current) throw reportError('RUN_REPORT_INVALID', '运行报告必须是对象');
    var normalizedPatch = normalizePatch(patch);
    if (isTerminalStatus(current.status)) {
      return { updated: false, reason: 'already-terminal', record: current };
    }
    if (isTerminalStatus(normalizedPatch.status)) {
      normalizedPatch = createTerminalPatch(normalizedPatch);
    }
    delete normalizedPatch.id;
    return {
      updated: true,
      reason: 'updated',
      record: mergeOwnData(current, normalizedPatch),
    };
  }

  function createNotFoundError(runId) {
    return reportError('RUN_REPORT_NOT_FOUND', '运行报告不存在: ' + runId);
  }

  return {
    REPORT_VERSION: REPORT_VERSION,
    ACTIVE_STATUSES: ACTIVE_STATUSES,
    TERMINAL_STATUSES: TERMINAL_STATUSES,
    isActiveStatus: isActiveStatus,
    isTerminalStatus: isTerminalStatus,
    sanitizeValue: sanitizeValue,
    sanitizeLogs: sanitizeLogs,
    settleNodeStatuses: settleNodeStatuses,
    deriveTerminalStatus: deriveTerminalStatus,
    normalizeStoredRecord: normalizeStoredRecord,
    normalizeRecord: normalizeRecord,
    normalizePatch: normalizePatch,
    createStartRecord: createStartRecord,
    createTerminalPatch: createTerminalPatch,
    applyPatch: applyPatch,
    createNotFoundError: createNotFoundError,
  };
});
