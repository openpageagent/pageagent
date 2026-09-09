// Unified facade consumed by Flow nodes, Agent ARP and script page.* APIs.
(function attachPageAutomationRuntime(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var pageDataContract = commonJs ? require('../shared/page-data-contract.js') : root && root.PageDataContract;
  var pageActionContract = commonJs ? require('../shared/page-action-contract.js') : root && root.PageActionContract;
  var pageVerificationContract = commonJs ? require('../shared/page-verification-contract.js') : root && root.PageVerificationContract;
  var api = factory(pageDataContract, pageActionContract, pageVerificationContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageAutomationRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pageDataContract, pageActionContract, pageVerificationContract) {
  'use strict';
  var API_VERSION = 1;
  if (!pageActionContract || !Array.isArray(pageActionContract.EDITABLE_FLOW_KINDS)) {
    throw new Error('PageAutomationRuntime requires PageActionContract.EDITABLE_FLOW_KINDS');
  }
  if (!pageVerificationContract || !Array.isArray(pageVerificationContract.WAIT_CONDITION_TYPES)) {
    throw new Error('PageAutomationRuntime requires PageVerificationContract.WAIT_CONDITION_TYPES');
  }
  var EDITABLE_PAGE_ACTION_KINDS = pageActionContract.EDITABLE_FLOW_KINDS.slice();
  var WAIT_CONDITION_TYPES = pageVerificationContract.WAIT_CONDITION_TYPES.slice();
  var WAIT_TIMEOUT_MIN_MS = Number(pageVerificationContract.WAIT_TIMEOUT_MIN_MS) || 100;
  var WAIT_TIMEOUT_MAX_MS = Number(pageVerificationContract.WAIT_TIMEOUT_MAX_MS) || 120000;
  var WAIT_POLL_INTERVAL_MIN_MS = Number(pageVerificationContract.WAIT_POLL_INTERVAL_MIN_MS) || 25;
  var WAIT_POLL_INTERVAL_MAX_MS = Number(pageVerificationContract.WAIT_POLL_INTERVAL_MAX_MS) || 2000;

  function createPageAutomationRuntime(options) {
    options = options || {};
    var perception = options.pagePerceptionEngine;
    var action = options.pageActionEngine;
    var verification = options.pageVerificationEngine;
    if (!perception || !action || !verification) throw new Error('PageAutomationRuntime requires all three engines');
    // Optional readiness barrier for the internal waitForReadiness command.
    var readiness = options.pageReadinessBarrier && typeof options.pageReadinessBarrier.waitForNavigation === 'function'
      ? options.pageReadinessBarrier : null;

    function tabId(params) {
      var value = Math.floor(Number(params && params.tabId));
      if (!(value > 0)) throw new Error('页面能力需要 params.tabId');
      return value;
    }
    function booleanParam(value, fallback) {
      if (typeof value === 'boolean') return value;
      if (value === undefined || value === null || value === '') return fallback;
      if (/^(?:true|yes|1|on|checked|selected)$/i.test(String(value))) return true;
      if (/^(?:false|no|0|off|unchecked|unselected)$/i.test(String(value))) return false;
      return fallback;
    }
    function locator(params) {
      params = params || {};
      var parsedLocator = params.locator;
      if (typeof parsedLocator === 'string' && /^[\[{]/.test(parsedLocator.trim())) { try { parsedLocator = JSON.parse(parsedLocator); } catch (_) {} }
      var value = Object.assign({}, parsedLocator && typeof parsedLocator === 'object' ? parsedLocator : {});
      var fields = {
        selector: params.selector, textSelector: params.textSelector, textPattern: params.textPattern, text: params.text,
        ref: params.ref, label: params.locatorLabel !== undefined ? params.locatorLabel : params.label,
        scopeSelector: params.scopeSelector, scopeRef: params.scopeRef,
        relative: params.relative, frameId: params.frameId,
      };
      Object.keys(fields).forEach(function (key) {
        if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') value[key] = fields[key];
      });
      if (params.elementIndex !== undefined) value.elementIndex = params.elementIndex;
      else if (params.index !== undefined) value.elementIndex = params.index;
      if (params.exact !== undefined) value.exact = params.exact === true;
      if (params.caseSensitive !== undefined) value.caseSensitive = params.caseSensitive === true;
      if (params.minCount !== undefined) value.minCount = params.minCount;
      return value;
    }
    function prefixedLocator(params, prefix) {
      params = params || {};
      prefix = String(prefix || '');
      var value = {};
      var fields = {
        selector: params[prefix + 'Selector'],
        textSelector: params[prefix + 'TextSelector'],
        textPattern: params[prefix + 'TextPattern'],
        label: params[prefix + 'LocatorLabel'],
        scopeSelector: params[prefix + 'ScopeSelector'],
        relative: params[prefix + 'Relative'],
      };
      Object.keys(fields).forEach(function (key) {
        if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') value[key] = fields[key];
      });
      if (params[prefix + 'Index'] !== undefined && params[prefix + 'Index'] !== '') value.elementIndex = params[prefix + 'Index'];
      return value;
    }
    function parseEditableValue(params) {
      if (String(params && params.valueMode || 'text') !== 'json') return params && params.value;
      try { return JSON.parse(String(params.value || ''));
      } catch (_) { throw new Error('节点值类型为 JSON 时，value 必须是有效 JSON'); }
    }
    function actionKind(command, params) {
      if (command === 'click') return params.clickType === 'dblclick' ? 'doubleClick' : (params.clickType === 'contextmenu' ? 'contextClick' : 'click');
      return ({ fill: 'fill', fillFormFields: 'fillFormFields', scroll: 'scroll', hover: 'hover', keyPress: 'press', dragDrop: 'drag', uploadFile: 'upload', patchPage: 'patch', replayRequest: 'replayRequest', handleDialog: 'handleDialog', webStorage: 'webStorage' })[command] || command;
    }
    function actionOutput(kind, params, input, result, optional) {
      var receipt = result.receipt;
      var derivedFacts = result.derivedFacts || {};
      var confirmationMode = String(params.confirmationMode || 'required');
      var optionalTargetMissing = optional === true
        && result && result.error
        && String(result.error.code || '') === 'TARGET_NOT_FOUND';
      if (receipt.status === 'failed' && (!optionalTargetMissing || confirmationMode === 'deferred')) {
        var failure = result.error || {};
        var error = new Error(failure.message || receipt.verification && receipt.verification.reason || '页面动作失败');
        error.code = failure.code || 'PAGE_ACTION_FAILED';
        error.receipt = receipt;
        error.details = failure.details || null;
        error.retryable = receipt.performed === 'no' && failure.retryable !== false;
        throw error;
      }
      if (receipt.status === 'unconfirmed' && confirmationMode !== 'deferred') {
        var unconfirmed = new Error(receipt.verification && receipt.verification.reason || '页面动作结果未确认');
        unconfirmed.code = 'PAGE_ACTION_UNCONFIRMED';
        unconfirmed.receipt = receipt;
        unconfirmed.details = receipt.verification && receipt.verification.evidence || null;
        unconfirmed.retryable = false;
        throw unconfirmed;
      }
      if (kind === 'fillFormFields') {
        if (result.error && optional === true) result.optionalFailure = result.error;
        return result;
      }
      var output = {
        kind: kind,
        actionReceipt: receipt, receipt: receipt, status: receipt.status, performed: receipt.performed,
        confirmed: receipt.status === 'confirmed', unconfirmed: receipt.status === 'unconfirmed',
        actionFacts: result.actionFacts, verification: receipt.verification,
        result: derivedFacts,
      };
      if (/^(?:click|doubleClick|contextClick)$/.test(kind)) {
        output.clicked = receipt.performed === 'yes';
        output.clickType = params.clickType || (kind === 'doubleClick' ? 'dblclick' : (kind === 'contextClick' ? 'contextmenu' : 'click'));
      }
      if (kind === 'hover') output.hovered = receipt.performed === 'yes';
      if (kind === 'fill') output.filled = receipt.status === 'confirmed';
      if (kind === 'type') output.filled = receipt.performed === 'yes';
      if (kind === 'press') { output.pressed = receipt.performed === 'yes'; output.key = input.key || params.key || 'Enter'; }
      if (kind === 'select') {
        output.selected = receipt.status === 'confirmed';
        output.selectedOption = derivedFacts.selectedOption || null;
      }
      if (kind === 'check') {
        output.checked = typeof derivedFacts.checkedAfter === 'boolean'
          ? derivedFacts.checkedAfter : booleanParam(params.checked, true);
        output.checkedConfirmed = receipt.status === 'confirmed';
      }
      if (kind === 'scroll') Object.assign(output, derivedFacts.scrollAfter || {}, { scrolled: receipt.performed === 'yes' });
      if (kind === 'drag') {
        output.dragged = receipt.performed === 'yes';
        output.dragTargetRef = derivedFacts.dragTargetRef || null;
      }
      if (kind === 'upload') {
        Object.assign(output, derivedFacts.upload || {});
        output.uploaded = receipt.status === 'confirmed'
          && !!(derivedFacts.upload && derivedFacts.upload.fileInputConfirmed);
        output.size = Number(derivedFacts.upload && derivedFacts.upload.byteLength) || 0;
      }
      if (kind === 'navigate') { output.tabId = params.tabId; output.url = String(params.url || ''); output.navigated = receipt.performed === 'yes'; }
      if (kind === 'reload') { output.tabId = params.tabId; output.reloaded = receipt.performed === 'yes'; }
      if (kind === 'createTab') { output.tabId = derivedFacts.tabId || receipt.tabId; output.url = derivedFacts.url || ''; output.created = receipt.performed === 'yes'; output.tab = derivedFacts.createdTab || null; }
      if (kind === 'activateTab') { output.tabId = params.tabId; output.activated = receipt.performed === 'yes'; }
      if (kind === 'closeTab') { output.tabId = params.tabId; output.closed = receipt.performed === 'yes'; }
      if (kind === 'handleDialog') Object.assign(output, derivedFacts.dialog || {});
      if (derivedFacts.result !== undefined) output.result = derivedFacts.result;
      if (result.error && optional === true) output.optionalFailure = result.error;
      return output;
    }
    function actCommand(command, params, context) {
      params = Object.assign({}, params || {});
      context = typeof context === 'string' ? { source: context } : (context || {});
      var kind = actionKind(command, params);
      var actionLocator = locator(params);
      var actionTargetRef = params.targetRef || null;
      var input = Object.assign({}, params);
      if ((kind === 'fill' || kind === 'select') && input.valueMode === 'json') input.value = parseEditableValue(input);
      delete input.valueMode;
      if (kind === 'scroll') {
        var explicitContainer = pageActionLocatorObject(input.containerLocator) || {};
        var configuredContainer = Object.assign({}, explicitContainer, prefixedLocator(input, 'container'));
        if (!input.containerTargetRef && !Object.keys(configuredContainer).length) configuredContainer.selector = 'html';
        if (Object.keys(configuredContainer).length) input.containerLocator = configuredContainer;
        if (String(input.distanceUnit || 'pixels') === 'pages') delete input.amountPx;
        else delete input.pages;
        delete input.distanceUnit;
      }
      if (kind === 'drag') {
        actionLocator = {
          selector: params.sourceSelector || '',
          text: params.sourceText || '',
          ref: params.sourceRef || '',
          elementIndex: params.sourceIndex,
        };
        actionTargetRef = params.sourceTargetRef || params.targetRef || null;
        input.targetTargetRef = params.targetTargetRef || params.dropTargetRef || null;
        input.targetSelector = params.targetSelector;
      }
      if (kind === 'press') input.key = params.key || 'Enter';
      var startedAt = new Date().toISOString();
      return action.act({
        source: context.source || 'flow', owner: context.owner || '', tabId: kind === 'createTab' ? 0 : tabId(params), kind: kind,
        locator: actionLocator, targetRef: actionTargetRef,
        input: input, expect: params.expect || null, timeoutMs: params.timeoutMs,
        sensitive: params.sensitive === true, signal: context.signal || null,
      }).catch(function (error) {
        if (error && error.retryable === undefined
            && (error.performed === 'unknown' || error.receipt && error.receipt.performed !== 'no')) {
          error.retryable = false;
        }
        if (params.optional !== true || String(error && error.code || '') !== 'TARGET_NOT_FOUND') throw error;
        var completedAt = new Date().toISOString();
        var receipt = verification.createFactReceipt({
          source: context.source || 'flow', tabId: tabId(params), kind: kind,
          failure: true, performed: error && error.performed || 'no', inputProvenance: 'cdp',
          signals: ['optional_target_not_found'], evidence: [{ kind: 'locator', locator: actionLocator }],
          reason: String(error && error.message || '可选目标不存在'), startedAt: startedAt, completedAt: completedAt,
        });
        return {
          receipt: receipt, actionFacts: receipt.actionFacts,
          browserFacts: { facts: [], newTabs: [], ambiguous: false }, derivedFacts: {},
          error: { code: 'TARGET_NOT_FOUND', message: String(error && error.message || '可选目标不存在'), details: error && error.details || null },
        };
      }).then(function (result) {
        return actionOutput(kind, params, input, result, params.optional === true);
      });
    }
    function pageActionObject(value, name, fallback) {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); }
        catch (_) { throw new Error('pageAction.' + name + ' 必须是有效 JSON 对象'); }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('pageAction.' + name + ' 必须是对象');
      }
      return Object.assign({}, value);
    }
    function pageActionLocatorObject(value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      if (typeof value === 'string' && /^\s*\{/.test(value)) {
        try {
          var parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) {}
      }
      return null;
    }
    function pageActionCommand(params, context) {
      params = Object.assign({}, params || {});
      context = typeof context === 'string' ? { source: context } : (context || {});
      var kind = String(params.kind || '');
      if (EDITABLE_PAGE_ACTION_KINDS.indexOf(kind) === -1) {
        throw new Error('不支持的 pageAction.kind: ' + kind);
      }
      var actionLocator = pageActionObject(params.locator, 'locator', {});
      var input = pageActionObject(params.input, 'input', {});
      if (params.readiness !== undefined && input.readiness === undefined) input.readiness = params.readiness;
      if (kind === 'scroll') {
        var pageActionContainer = pageActionLocatorObject(input.containerLocator);
        if (pageActionContainer) input.containerLocator = pageActionContainer;
      }
      var expectation = pageActionObject(params.expect, 'expect', null);
      return action.act({
        source: context.source || 'flow', owner: context.owner || '', tabId: tabId(params), kind: kind,
        locator: actionLocator, input: input, expect: expectation, timeoutMs: params.timeoutMs,
        sensitive: params.sensitive === true, signal: context.signal || null,
      }).then(function (result) {
        return actionOutput(kind, params, input, result, false);
      });
    }
    function perceiveCommand(command, params, context) {
      context = context || {};
      params = Object.assign({}, params || {}, { tabId: tabId(params) });
      if (context.signal) params.signal = context.signal;
      if (command === 'waitFor') return verification.waitForElement({
        source: context.source || 'flow', tabId: params.tabId, params: params,
        locator: locator(params), signal: context.signal || params.signal || null,
      });
      if (command === 'waitForPageLoad') return verification.waitForPageLoad({
        source: context.source || 'flow', tabId: params.tabId, params: params,
        signal: context.signal || params.signal || null,
      });
      if (command === 'scrollInfo' && !String(params.containerSelector || '').trim()) params.containerSelector = 'html';
      var kindMap = {
        extractText: 'extractText', extractTable: 'extractTable', extractList: 'extractList', extractScrollingList: 'extractScrollingList',
        elementInfo: 'elementInfo', inspectElement: 'elementInfo', inspectStructure: 'inspectStructure', inspectText: 'inspectText', inspectHtml: 'inspectHtml',
        inspectCss: 'inspectCss', inspectJavascript: 'inspectJavascript', searchPage: 'searchPage', scrollInfo: 'scrollInfo', media: 'media',
        getRequests: 'getRequests', getSseEvents: 'getSseEvents', clearNetworkCapture: 'clearNetworkCapture',
        getCurrentTab: 'tabInfo',
      };
      return perception.perceive(Object.assign({}, params, locator(params), { kind: kindMap[command] || command }));
    }
    function evaluateReadCommand(params, context) {
      params = Object.assign({}, params || {});
      context = context || {};
      var id = tabId(params);
      var startedMs = Date.now();
      var startedAt = new Date(startedMs).toISOString();
      return perception.perceive({
        tabId: id,
        kind: 'evaluateJavascript',
        code: String(params.code || params.expression || ''),
        sourceType: params.sourceType,
        world: params.world || 'MAIN',
        start: params.start,
        maxChars: params.maxChars,
        timeoutMs: params.timeoutMs,
        signal: context.signal || null,
      }).then(function (result) {
        var completedAt = new Date().toISOString();
        var receipt = verification.createFactReceipt({
          source: context.source || 'flow', tabId: id, kind: 'evaluate', performed: 'no', conditionMet: true,
          inputProvenance: 'perception', signals: ['page_fact_read'],
          evidence: [result.evidence], reason: '页面只读 JavaScript 结果已由 PagePerceptionEngine 返回',
          startedAt: startedAt, completedAt: completedAt, durationMs: Date.now() - startedMs,
        });
        return {
          result: result.result,
          actionReceipt: receipt,
          receipt: receipt,
          status: receipt.status,
          performed: receipt.performed,
          confirmed: receipt.status === 'confirmed',
          unconfirmed: receipt.status === 'unconfirmed',
          verification: receipt.verification,
        };
      });
    }
    function waitCondition(params) {
      var condition = params && params.condition;
      if (typeof condition === 'string') {
        try { condition = JSON.parse(condition); }
        catch (_) { throw new Error('页面等待 condition 必须是有效 JSON 对象'); }
      }
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) return Object.assign({}, condition);
      condition = { type: String(params && params.conditionType || '') };
      ['fromUrl', 'pattern', 'text', 'state', 'value', 'checked', 'selected', 'expanded', 'visible', 'enabled', 'editable', 'connected', 'pollIntervalMs'].forEach(function (key) {
        var value = params && params[key];
        if (value === undefined || value === null || value === '') return;
        if (/^(?:checked|expanded|visible|enabled|editable|connected)$/.test(key)
            || key === 'selected' && /^(?:true|false)$/.test(String(value))) {
          value = booleanParam(value, false);
        }
        condition[key] = value;
      });
      return condition;
    }
    function waitLocator(params) {
      var input = Object.assign({}, params || {}, {
        text: undefined,
        label: params && params.locatorLabel,
      });
      return locator(input);
    }
    function waitNeedsNavigationBaseline(condition) {
      condition = condition || {};
      var kind = String(condition.kind || condition.type || '');
      if (kind === 'anyOf' || kind === 'allOf') return (condition.conditions || []).some(waitNeedsNavigationBaseline);
      return /^(?:pageChanged|page_change|urlChanged|url_change|documentChanged)$/.test(kind);
    }
    async function readWaitNavigationBaseline(id, condition, timeoutMs, signal) {
      if (!waitNeedsNavigationBaseline(condition)) return null;
      if (signal && signal.aborted === true) {
        var initialCancel = signal.reason instanceof Error ? signal.reason : new Error('页面等待已取消');
        initialCancel.code = initialCancel.code || 'ACTION_CANCELLED';
        initialCancel.performed = initialCancel.performed || 'unknown';
        initialCancel.retryable = false;
        throw initialCancel;
      }
      var state = await perception.perceive({
        tabId: id,
        kind: 'pageLoadState',
        readyState: 'loading',
        timeoutMs: Math.max(1, Math.min(Number(timeoutMs) || 5000, 5000)),
        signal: signal || null,
      });
      if (signal && signal.aborted === true) {
        var completedCancel = signal.reason instanceof Error ? signal.reason : new Error('页面等待已取消');
        completedCancel.code = completedCancel.code || 'ACTION_CANCELLED';
        completedCancel.performed = completedCancel.performed || 'unknown';
        completedCancel.retryable = false;
        throw completedCancel;
      }
      return { url: String(state && state.url || ''), loaderId: String(state && state.loaderId || '') };
    }
    function waitDelay(ms, signal) {
      function cancelled() {
        var error = signal && signal.reason instanceof Error ? signal.reason : new Error('页面等待已取消');
        error.code = error.code || 'ACTION_CANCELLED';
        error.retryable = false;
        return error;
      }
      if (signal && signal.aborted) return Promise.reject(cancelled());
      return new Promise(function (resolve, reject) {
        function cleanup() {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          clearTimeout(timer);
          cleanup();
          reject(cancelled());
        }
        var timer = setTimeout(function () { cleanup(); resolve(); }, ms);
        if (!signal || typeof signal.addEventListener !== 'function') return;
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    function waitDeadlineSignal(parentSignal, deadline) {
      if (typeof AbortController !== 'function') return { signal: parentSignal || null, cleanup: function () {} };
      var controller = new AbortController();
      var timer = null;
      function abortWith(reason) {
        if (controller.signal.aborted) return;
        var error = reason instanceof Error ? reason : new Error(String(reason || '页面等待已超时'));
        if (!error.code) error.code = 'PAGE_WAIT_TIMEOUT';
        try { controller.abort(error); } catch (_) { controller.abort(); }
      }
      function onParentAbort() {
        var reason = parentSignal && parentSignal.reason;
        if (!(reason instanceof Error)) reason = new Error('页面等待已取消');
        if (!reason.code) reason.code = 'ACTION_CANCELLED';
        abortWith(reason);
      }
      if (parentSignal && typeof parentSignal.addEventListener === 'function') {
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
      var remaining = Math.max(0, Number(deadline) - Date.now());
      timer = setTimeout(function () { abortWith(new Error('页面等待超过配置的超时时间')); }, remaining);
      return {
        signal: controller.signal,
        cleanup: function () {
          if (timer) clearTimeout(timer);
          timer = null;
          if (parentSignal && typeof parentSignal.removeEventListener === 'function') parentSignal.removeEventListener('abort', onParentAbort);
        },
      };
    }
    function timedOutWaitVerdict(condition) {
      return pageVerificationContract.createVerdict({
        status: 'failed', performed: 'no', conditionMet: false,
        signals: ['page_wait_timeout'],
        evidence: [{ kind: 'wait_condition', condition: condition }],
        reason: '页面等待条件在超时前未满足',
      });
    }
    function waitWithinDeadline(factory, deadline, signal) {
      var remaining = Math.max(0, Number(deadline) - Date.now());
      if (remaining < 1) {
        var expired = new Error('页面等待超过配置的超时时间');
        expired.code = 'PAGE_WAIT_TIMEOUT';
        return Promise.reject(expired);
      }
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          cleanup();
          var error = new Error('页面等待超过配置的超时时间');
          error.code = 'PAGE_WAIT_TIMEOUT';
          reject(error);
        }, remaining);
        function cleanup() {
          clearTimeout(timer);
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          if (settled) return;
          settled = true;
          cleanup();
          var error = signal && signal.reason instanceof Error ? signal.reason : new Error('页面等待已取消');
          error.code = error.code || 'ACTION_CANCELLED';
          reject(error);
        }
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        Promise.resolve().then(factory).then(function (value) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }, function (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
    }
    async function waitForConditionCommand(params, context) {
      params = Object.assign({}, params || {});
      context = context || {};
      var id = tabId(params);
      var condition = waitCondition(params);
      if (!condition.type && !condition.kind) throw new Error('页面等待缺少 condition.type');
      var conditionType = String(condition.type || condition.kind || '');
      if (WAIT_CONDITION_TYPES.indexOf(conditionType) === -1) throw new Error('不支持的页面等待条件: ' + conditionType);
      var timeoutMs = Math.max(WAIT_TIMEOUT_MIN_MS, Math.min(Number(
        params.timeoutMs !== undefined && params.timeoutMs !== '' ? params.timeoutMs : condition.timeoutMs
      ) || 10000, WAIT_TIMEOUT_MAX_MS));
      var pollIntervalMs = Math.max(WAIT_POLL_INTERVAL_MIN_MS, Math.min(Number(
        params.pollIntervalMs !== undefined && params.pollIntervalMs !== '' ? params.pollIntervalMs : condition.pollIntervalMs
      ) || 100, WAIT_POLL_INTERVAL_MAX_MS));
      var deadline = 0;
      var startedAt = '';
      var target = waitLocator(params);
      var targetRef = params.targetRef || null;
      if (Object.keys(target).length && !condition.locator) {
        condition.locator = target;
      }
      // The configured timeout covers baseline acquisition as well as the
      // polling phase. Otherwise a slow initial page-state read silently adds
      // another full timeout window before the condition is considered.
      var waitStartedMs = Date.now();
      startedAt = new Date(waitStartedMs).toISOString();
      deadline = waitStartedMs + timeoutMs;
      var deadlineState = waitDeadlineSignal(context.signal || null, deadline);
      var waitSignal = deadlineState.signal;
      var baselineTimeoutMs = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
      function attachConditionFailure(error) {
        if (error && typeof error === 'object' && !error.receipt) {
          var code = String(error.code || 'PAGE_WAIT_FAILED');
          var performed = error.performed !== undefined
            ? error.performed : code === 'ACTION_CANCELLED' ? 'unknown' : 'no';
          error.receipt = verification.createFactReceipt({
            source: context.source || 'flow', tabId: id, kind: 'waitForCondition',
            performed: performed, conditionMet: false, inputProvenance: 'perception',
            signals: ['page_wait_failed'],
            evidence: [{ kind: 'wait_condition', condition: condition, code: code, details: error.details || null }],
            reason: String(error.message || '页面等待条件失败'),
            startedAt: startedAt, completedAt: new Date().toISOString(),
          });
        }
        return error;
      }
      var baseline;
      try {
        baseline = await waitWithinDeadline(function () {
          return readWaitNavigationBaseline(id, condition, baselineTimeoutMs, waitSignal);
        }, deadline, waitSignal);
      } catch (error) {
        deadlineState.cleanup();
        throw attachConditionFailure(error);
      }
      var verdict;
      try {
        while (true) {
          if (Date.now() >= deadline) {
            verdict = timedOutWaitVerdict(condition);
            break;
          }
          verdict = await waitWithinDeadline(function () {
            return verification.verifyExpectation({
              tabId: id,
              expectation: condition,
              targetRef: targetRef,
              baseline: baseline,
              timeoutMs: Math.max(1, deadline - Date.now()),
              signal: waitSignal,
            });
          }, deadline, waitSignal);
          if (verdict.status === 'confirmed' && Date.now() < deadline) break;
          if (Date.now() >= deadline) {
            verdict = timedOutWaitVerdict(condition);
            break;
          }
          await waitDelay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), waitSignal);
        }
      } catch (error) {
        if (String(error && error.code || '') === 'PAGE_WAIT_TIMEOUT') verdict = timedOutWaitVerdict(condition);
        else {
          deadlineState.cleanup();
          throw attachConditionFailure(error);
        }
      } finally {
        deadlineState.cleanup();
      }
      if (!verdict) {
        var missingVerdict = new Error('页面等待没有生成验证结果');
        missingVerdict.code = 'PAGE_WAIT_FAILED';
        throw attachConditionFailure(missingVerdict);
      }
      var completedAt = new Date().toISOString();
      var receipt = verification.createFactReceipt({
        source: context.source || 'flow', tabId: id, kind: 'wait', performed: 'no',
        conditionMet: verdict.conditionMet === true, inputProvenance: 'perception',
        verification: verdict, targetRef: targetRef,
        startedAt: startedAt, completedAt: completedAt,
      });
      var output = {
        kind: 'wait', status: receipt.status, performed: receipt.performed,
        conditionMet: receipt.conditionMet, result: { conditionMet: receipt.conditionMet },
        actionReceipt: receipt, receipt: receipt, verification: receipt.verification,
      };
      if (receipt.status === 'failed' && context.source !== 'agent') {
        var error = new Error(receipt.verification && receipt.verification.reason || '页面等待条件未满足');
        error.code = 'PAGE_WAIT_FAILED';
        error.receipt = receipt;
        throw error;
      }
      return output;
    }
    async function verifyCommand(command, params, context) {
      params = Object.assign({}, params || {});
      context = context || {};
      if (context.signal) params.signal = context.signal;
      var id = tabId(params);
      var result = await verification.verifyPageAssertion({ tabId: id, command: command, params: params, locator: locator(params), signal: context.signal || params.signal || null });
      if (!result.passed) {
        var error = new Error(result.verification.reason);
        error.code = 'VERIFICATION_FAILED';
        error.verification = result.verification;
        throw error;
      }
      return result;
    }
    function plainObject(value) {
      if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
      var prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }
    function replayHeaders(raw) {
      if (raw === undefined || raw === null || raw === '') return {};
      if (plainObject(raw)) return Object.assign({}, raw);
      if (typeof raw !== 'string') return {};
      var source = raw.trim();
      if (!source) return {};
      try {
        var parsed = JSON.parse(source);
        if (plainObject(parsed)) return Object.assign({}, parsed);
      } catch (_) {}
      var headers = {};
      source.split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (!line) return;
        var separator = line.indexOf(':');
        if (separator < 1 || !line.slice(0, separator).trim()) return;
        headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      });
      return headers;
    }
    function replayRequestAction(params, context, readEntry, label) {
      params = Object.assign({}, params || {});
      var replayTabId = tabId(params);
      var entryPromise = params.entryId ? readEntry(replayTabId, params) : Promise.resolve(null);
      return entryPromise.then(function (entry) {
        var hasHeaders = params.headers !== undefined && params.headers !== null && params.headers !== '';
        var replayParams = Object.assign({}, params, {
          tabId: replayTabId,
          url: params.url || entry && entry.url || '',
          method: params.method || entry && entry.method || 'GET',
          headers: replayHeaders(hasHeaders ? params.headers : entry && entry.requestHeaders || {}),
          body: params.body !== undefined && params.body !== null && params.body !== ''
            ? params.body : entry && entry.requestBody || '',
        });
        if (!replayParams.url) throw new Error(label + ' 需要 url 或有效 entryId');
        return actCommand('replayRequest', replayParams, context).then(function (actionOutput) {
          var response = actionOutput.result || {};
          var body = response.body;
          if (replayParams.parseJson === true && typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
          }
          var metadata = Object.assign({}, response);
          delete metadata.body;
          var headers = Array.isArray(metadata.headers) ? metadata.headers : [];
          var contentTypeEntry = headers.find(function (header) { return String(header && header[0] || '').toLowerCase() === 'content-type'; });
          if (!metadata.contentType && contentTypeEntry) metadata.contentType = String(contentTypeEntry[1] || '');
          return { tabId: replayTabId, params: replayParams, actionOutput: actionOutput, metadata: metadata, body: body };
        });
      });
    }
    // Internal command used by NodePageLifecycleOps after waitForPageLoad: wait
    // briefly for DOM stability, with network idle available on request.
    // The page-load wait and loader/new-document semantics stay upstream.
    function waitForReadinessCommand(params, context) {
      params = Object.assign({}, params || {});
      context = context || {};
      var id = tabId(params);
      var startedMs = Date.now();
      var startedAt = new Date(startedMs).toISOString();
      var explicit = !(params.readiness === undefined || params.readiness === null || params.readiness === '');
      var config = readiness ? readiness.normalizeOptions(explicit ? params.readiness : readiness.FLOW_DEFAULTS) : null;
      if (!readiness || !config) {
        return Promise.resolve({ ready: true, skipped: readiness ? 'disabled' : 'unavailable', tabId: id, report: null });
      }
      var signal = context.signal || params.signal || null;
      var deadline = Number(params.deadline) > 0 ? Number(params.deadline)
        : startedMs + Math.max(100, Math.min(Number(params.timeoutMs) || 10000, 300000));
      if (!explicit) deadline = Math.min(deadline, startedMs + readiness.SOFT_TIMEOUT_MS);
      return readiness.waitForNavigation(id, Object.assign({}, config, {
        deadline: deadline,
        signal: signal,
      })).catch(function (error) {
        return readiness.warningReport(error, { mode: 'navigation', tabId: id, signal: signal });
      }).then(function (report) {
        var completedAt = new Date().toISOString();
        var receipt = verification.createFactReceipt({
          source: context.source || 'flow', tabId: id, kind: 'waitForReadiness',
          performed: 'no', conditionMet: report.ready === true, inputProvenance: 'perception',
          signals: [report.ready === true ? 'page_ready' : 'page_readiness_incomplete'], evidence: [{ kind: 'readiness', report: report }],
          warnings: report.warning ? [report.warningCode + ': ' + report.warningMessage] : [],
          reason: String(report && report.reason || '页面已就绪'),
          startedAt: startedAt, completedAt: completedAt, durationMs: Date.now() - startedMs,
        });
        return {
          ready: report.ready === true, tabId: id, report: report,
          actionReceipt: receipt, receipt: receipt, status: receipt.status, performed: receipt.performed,
          conditionMet: receipt.conditionMet, verification: receipt.verification,
        };
      }, function (error) {
        if (error && typeof error === 'object' && !error.receipt) {
          try {
            error.receipt = verification.createFactReceipt({
              source: context.source || 'flow', tabId: id, kind: 'waitForReadiness', failure: true,
              performed: String(error.performed || 'no'), inputProvenance: 'perception',
              signals: ['page_readiness_failed'],
              evidence: [{ kind: 'readiness', code: String(error.code || 'PAGE_READINESS_FAILED'), report: error.details && error.details.report || null }],
              reason: String(error.message || error), startedAt: startedAt, completedAt: new Date().toISOString(),
            });
          } catch (_) {}
        }
        throw error;
      });
    }
    function executeCommand(command, params, context) {
      context = context || {};
      params = params || {};
      var readsPage = /^(?:extractText|extractTable|extractList|extractScrollingList|elementInfo|inspectElement|inspectStructure|inspectText|inspectHtml|inspectCss|searchPage|scrollInfo|media)$/.test(command)
        || command === 'evaluate' && String(params.mode || 'write').toLowerCase() === 'read';
      var explicit = !(params.readiness === undefined || params.readiness === null || params.readiness === '');
      var config = readiness && readsPage && ((context.source || 'flow') === 'flow' || explicit)
        ? readiness.normalizeOptions(explicit ? params.readiness : readiness.FLOW_DEFAULTS) : null;
      if (!config) return executeCommandNow(command, params, context);
      var id = tabId(params);
      var signal = context.signal || params.signal || null;
      return readiness.waitBeforeAction(id, {
        readiness: config, frameId: params.frameId || '', timeoutMs: readiness.SOFT_TIMEOUT_MS, signal: signal,
      }).catch(function (error) {
        return readiness.warningReport(error, { mode: 'before-action', tabId: id, signal: signal });
      }).then(function () { return executeCommandNow(command, params, context); });
    }
    function executeCommandNow(command, params, context) {
      context = context || {};
      if (command === 'waitForCondition') return waitForConditionCommand(params, context);
      if (command === 'waitFor' || command === 'waitForElement') return perceiveCommand('waitFor', params, context);
      if (command === 'waitForPageLoad') return perceiveCommand('waitForPageLoad', params, context);
      if (command === 'waitForReadiness') return waitForReadinessCommand(params, context);
      if (/^cdp\./.test(String(command || ''))) {
        params = Object.assign({}, params || {});
        if (command === 'cdp.analyze_performance') {
          params.reload = booleanParam(params.reload, false);
          params.action = String(params.action || 'none').toLowerCase();
        }
        if (command === 'cdp.screenshot') return perception.captureScreenshot(tabId(params), Object.assign({}, params, { signal: context.signal || params.signal || null }));
        if (command === 'cdp.inspect_dom_snapshot') return perception.perceive(Object.assign({}, params, { tabId: tabId(params), kind: 'diagnosticDomSnapshot', signal: context.signal || params.signal || null }));
        if (command === 'cdp.inspect_ax_tree') return perception.perceive(Object.assign({}, params, { tabId: tabId(params), kind: 'diagnosticAxTree', signal: context.signal || params.signal || null }));
        if (command === 'cdp.replay_request') {
          var replayStartedAt = Date.now();
          return replayRequestAction(params, context, function (replayTabId, replayParams) {
            return perception.perceive({ tabId: replayTabId, kind: 'cdp.network_entry', entryId: replayParams.entryId, signal: context.signal || replayParams.signal || null });
          }, 'cdp.replay_request').then(function (replay) {
            return {
              result: Object.assign(
                { type: 'http-response', actionReceipt: replay.actionOutput.receipt },
                replay.metadata,
                pageDataContract.paginateValue(replay.body, replay.params, 'cdp.replay_request', { dataKey: 'body' })
              ),
              risk: {
                level: 'state-changing',
                note: '请求重放由 PageActionEngine 执行，并由统一 ActionReceipt 裁决是否确认。',
              },
              executionLog: {
                tabId: replay.tabId,
                command: 'cdp.replay_request',
                startedAt: replayStartedAt,
                endedAt: Date.now(),
                durationMs: Date.now() - replayStartedAt,
                timeoutMs: replay.params.timeoutMs,
              },
            };
          });
        }
        if (command === 'cdp.analyze_performance' && (params.reload || params.action === 'click')) {
          var performanceTabId = tabId(params);
          var performanceAction = params.reload ? 'reload' : 'click';
          var capture = null;
          return perception.perceive(Object.assign({}, params, { tabId: performanceTabId, kind: 'cdp.performance_capture_start', signal: context.signal || params.signal || null })).then(function (started) {
            capture = started;
            var actionParams = params.reload
              ? { tabId: performanceTabId, ignoreCache: params.ignoreCache === true, timeoutMs: params.timeoutMs }
              : { tabId: performanceTabId, selector: params.selector || '', x: params.x, y: params.y, offsetX: params.offsetX, offsetY: params.offsetY, timeoutMs: params.timeoutMs };
            return actCommand(performanceAction, actionParams, context);
          }).then(function (actionOutput) {
            return perception.perceive(Object.assign({}, params, {
              tabId: performanceTabId,
              kind: 'cdp.performance_capture_finish',
              signal: context.signal || params.signal || null,
              captureToken: capture.captureToken,
              actionResult: {
                action: performanceAction,
                selector: params.selector || '',
                actionReceipt: actionOutput.receipt,
                startedAt: Date.parse(actionOutput.receipt.startedAt) || Date.now(),
                endedAt: Date.parse(actionOutput.receipt.completedAt) || Date.now(),
              },
            }));
          }).catch(function (error) {
            if (!capture || !capture.captureToken) throw error;
            return perception.perceive(Object.assign({}, params, {
              tabId: performanceTabId,
              kind: 'cdp.performance_capture_finish',
              signal: null,
              cleanupOnly: true,
              captureToken: capture.captureToken,
              actionResult: { action: performanceAction, failed: true, error: String(error && error.message || error), actionReceipt: error && error.receipt || null },
            })).catch(function () {}).then(function () { throw error; });
          });
        }
        if (/^cdp\.(?:inspect_network|javascript_source|search_script_sources|analyze_performance)$/.test(command)) {
          return perception.perceive(Object.assign({}, params, { tabId: tabId(params), kind: command, signal: context.signal || params.signal || null }));
        }
        return Promise.reject(new Error('未知统一页面 CDP 能力: ' + command));
      }
      if (command === 'screenshot') return perception.captureScreenshot(tabId(params), Object.assign({}, params || {}, { signal: context.signal || params && params.signal || null }));
      if (command === 'replayRequest') {
        return replayRequestAction(params, context, function (replayTabId, replayParams) {
          return perception.perceive({
              tabId: replayTabId,
              kind: 'getRequests',
              entryId: replayParams.entryId,
              latestOnly: false,
              parseJson: false,
              start: 0,
              maxChars: 10000,
              timeoutMs: replayParams.timeoutMs,
              signal: context.signal || replayParams.signal || null,
            }).then(function (result) {
              return (result.entries || []).find(function (entry) { return String(entry.id || '') === String(replayParams.entryId); }) || null;
            });
        }, 'replayRequest').then(function (replay) {
          var bodyPage = replay.params.start !== undefined && replay.params.maxChars !== undefined
            ? pageDataContract.paginateValue(replay.body, replay.params, 'replayRequest', { dataKey: 'body' })
            : { body: replay.body };
          return Object.assign({
            type: 'http-response',
            actionReceipt: replay.actionOutput.receipt,
            receipt: replay.actionOutput.receipt,
          }, replay.metadata, bodyPage);
          });
      }
      if (command === 'extractScrollingList') {
        params = Object.assign({}, params || {});
        var scrollingTabId = tabId(params);
        var scrollStepPx = Math.abs(Number(params.scrollStepPx)) || 600;
        var thresholdPx = Math.max(1, Number(params.thresholdPx) || 20);
        var maximumRounds = Math.max(1, Math.min(Number(params.maxIterations) || 30, 200));
        var maximumItems = Math.max(1, Math.min(Number(params.maxItems) || 10000, 10000));
        var stopOnNoNewRounds = Math.max(1, Math.min(Number(params.stopOnNoNewRounds) || 3, 50));
        var keyFields = String(params.keyFields || '').split(/[,\r\n]+/).map(function (key) { return key.trim(); }).filter(Boolean);
        var seen = Object.create(null);
        var items = [];
        var receipts = [];
        var stableRounds = 0;
        var rounds = 0;
        var lastScroll = null;
        var firstCollection = true;
        var scrollingContainerSelector = String(params.containerSelector || '').trim() || 'html';
        function scrollingSettleMs(value) {
          if (value === undefined || value === null || String(value).trim() === '') return 150;
          var configured = Number(value);
          return Number.isFinite(configured) ? Math.max(20, configured) : 150;
        }
        function itemKey(item) {
          var value = keyFields.length ? keyFields.map(function (key) { return item && item[key]; }) : item;
          try { return JSON.stringify(value); } catch (_) { return String(value); }
        }
        function collect() {
          var added = 0;
          function readPage(start) {
            var readParams = Object.assign({}, params, {
              tabId: scrollingTabId, kind: 'extractList', start: start, maxChars: 10000,
              maxItems: maximumItems, timeoutMs: firstCollection ? params.timeoutMs : 0,
            });
            readParams.signal = context.signal || params.signal || null;
            return perception.perceive(readParams).then(function (page) {
              firstCollection = false;
              (page.items || []).forEach(function (item) {
                var key = itemKey(item);
                if (seen[key]) return;
                seen[key] = true;
                items.push(item);
                added += 1;
              });
              var nextStart = Number(page.nextStart);
              if (items.length < maximumItems && page.hasMore === true
                  && Number.isInteger(nextStart) && nextStart > start) {
                return readPage(nextStart);
              }
            });
          }
          return readPage(0).then(function () {
            stableRounds = added ? 0 : stableRounds + 1;
          });
        }
        function advance() {
          if (items.length >= maximumItems || rounds >= maximumRounds || stableRounds >= stopOnNoNewRounds || lastScroll && lastScroll.atBottom === true) return Promise.resolve();
          rounds += 1;
          return action.act({
            source: context.source || 'flow', owner: context.owner || '', tabId: scrollingTabId, kind: 'scroll',
            // extractScrollingList keeps its own settle loop; the generic
            // readiness barrier is not applied to these internal scrolls.
            input: { mode: 'amount', amountPx: scrollStepPx, containerSelector: scrollingContainerSelector, containerIndex: params.containerIndex, humanLike: booleanParam(params.humanLike, true), maxScrollRounds: 1, settleMs: scrollingSettleMs(params.settleMs), thresholdPx: thresholdPx, readiness: false },
            timeoutMs: params.timeoutMs,
            signal: context.signal || params.signal || null,
          }).then(function (result) {
            receipts.push(result.receipt);
            lastScroll = result.derivedFacts.scrollAfter || null;
            var appliedX = Number(lastScroll && lastScroll.appliedX) || 0;
            var appliedY = Number(lastScroll && lastScroll.appliedY) || 0;
            if (!appliedX && !appliedY) stableRounds = Math.max(stableRounds, stopOnNoNewRounds);
            return collect().then(advance);
          });
        }
        var begin = params.scrollToTop === false ? Promise.resolve() : action.act({
          source: context.source || 'flow', owner: context.owner || '', tabId: scrollingTabId, kind: 'scroll',
          input: { mode: 'top', containerSelector: scrollingContainerSelector, containerIndex: params.containerIndex, amountPx: scrollStepPx, humanLike: booleanParam(params.humanLike, true), maxScrollRounds: maximumRounds, settleMs: scrollingSettleMs(params.settleMs), thresholdPx: thresholdPx, readiness: false },
          timeoutMs: params.timeoutMs,
          signal: context.signal || params.signal || null,
        }).then(function (result) {
          receipts.push(result.receipt);
          lastScroll = result.derivedFacts.scrollAfter || null;
        });
        return begin.then(collect).then(advance).then(function () {
          return perception.perceive({ tabId: scrollingTabId, kind: 'scrollInfo', containerSelector: scrollingContainerSelector, containerIndex: params.containerIndex, thresholdPx: thresholdPx, signal: context.signal || params.signal || null });
        }).then(function (scroll) {
          var selected = items.slice(0, maximumItems);
          var result = { items: selected, count: selected.length, returnedCount: selected.length, iterations: rounds, atBottom: scroll && scroll.atBottom === true, scroll: scroll || {}, keyFields: keyFields, scrollReceipts: receipts, itemSelector: params.itemSelector || '' };
          if (pageDataContract && params.start !== undefined && params.maxChars !== undefined) {
            var page = pageDataContract.paginateItems(selected, params, 'extractScrollingList', { dataKey: 'items' });
            return Object.assign(result, { returnedCount: page.items.length }, page);
          }
          return result;
        });
      }
      if (command === 'evaluate' && String(params && params.mode || 'write').toLowerCase() === 'read') {
        return evaluateReadCommand(params, context);
      }
      if (command === 'pageAction') return pageActionCommand(params, context);
      if (/^(?:click|fill|select|check|fillFormFields|scroll|hover|keyPress|dragDrop|uploadFile|patchPage|handleDialog|createTab|navigate|reload|activateTab|closeTab|evaluate)$/.test(command)) return actCommand(command, params, context);
      if (command === 'webStorage' && String(params && params.action || 'get') !== 'get') return actCommand(command, params, context);
      if (/^assert(?:Element|Text|Attribute|Value|Url)$/.test(command)) return verifyCommand(command, params, context);
      return perceiveCommand(command, params, context);
    }
    return Object.freeze({
      perception: perception, action: action, verification: verification,
      registerDiagnosticProvider: function (provider) {
        if (!provider || provider.API_VERSION !== 1 || typeof provider.perceive !== 'function') throw new Error('PageAutomationRuntime diagnostic provider requires API_VERSION=1 and perceive()');
        return perception.registerEvidenceProvider('cdp-diagnostics', provider);
      },
      perceive: function (query) { return perception.perceive(query); },
      act: function (intent, hooks) { return action.act(intent, hooks); },
      verify: function (expectation) { return verification.verifyExpectation(expectation); },
      perceiveCommand: perceiveCommand, evaluateReadCommand: evaluateReadCommand, actCommand: actCommand, verifyCommand: verifyCommand, executeCommand: executeCommand,
      observe: perception.observe, captureScreenshot: perception.captureScreenshot,
    });
  }
  return Object.freeze({ API_VERSION: API_VERSION, createPageAutomationRuntime: createPageAutomationRuntime });
});
