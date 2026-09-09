// Single PageVerificationEngine. Only this module may produce final action verdicts/receipts.
(function attachPageVerificationEngine(root, factory) {
  'use strict';
  var api = factory(root && root.PageVerificationContract, root && root.PageFactContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageVerificationEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract, facts) {
  'use strict';
  var API_VERSION = 1;
  function createPageVerificationEngine(options) {
    options = options || {};
    var perception = options.pagePerceptionEngine;
    if (!contract || !facts || !perception) throw new Error('PageVerificationEngine requires contracts and PagePerceptionEngine');

    function ensureNotAborted(signal) {
      if (!signal || signal.aborted !== true) return;
      if (signal.reason instanceof Error) {
        try { signal.reason.code = signal.reason.code || 'ACTION_CANCELLED'; } catch (_) {}
        try { signal.reason.performed = signal.reason.performed || 'unknown'; } catch (_) {}
        try { signal.reason.retryable = false; } catch (_) {}
        throw signal.reason;
      }
      var error = new facts.PageFactError('ACTION_CANCELLED', '页面验证已取消');
      error.retryable = false;
      throw error;
    }

    function browserSummary(browserFacts) {
      browserFacts = browserFacts || { facts: [], newTabs: [], ambiguous: false };
      var relevantTabs = Array.isArray(browserFacts.newTabs) ? browserFacts.newTabs.slice() : [];
      return { facts: [], navigation: [], newTabs: relevantTabs, ambiguous: browserFacts.ambiguous === true || relevantTabs.length > 1 || relevantTabs.some(function (tab) { return tab.ambiguous === true; }), dialogs: [] };
    }
    function performedFrom(actionFacts) {
      actionFacts = actionFacts || {};
      if (actionFacts.transportInterrupted === true) return 'unknown';
      if (actionFacts.dispatched === true) return 'yes';
      if (actionFacts.kind === 'evaluate' && !actionFacts.failure && (actionFacts.browserResponses || []).length > 0) return 'yes';
      return 'no';
    }
    function expectedBoolean(value) {
      if (typeof value === 'boolean') return value;
      var normalized = String(value === undefined || value === null ? '' : value).toLowerCase();
      if (/^(?:true|yes|1|expanded|visible|enabled|editable|selected)$/.test(normalized)) return true;
      if (/^(?:false|no|0|collapsed|hidden|disabled|readonly|unselected)$/.test(normalized)) return false;
      return null;
    }
    function booleanStateMatches(actual, expected) {
      var normalized = expectedBoolean(expected);
      return normalized !== null && actual === normalized;
    }
    function targetLocator(condition, context) {
      var locator = condition && condition.locator;
      return locator && typeof locator === 'object' ? locator : {};
    }
    function targetReference(condition, context) {
      return condition && condition.targetRef || context.targetRef || null;
    }
    async function currentTarget(condition, context) {
      ensureNotAborted(context.signal);
      var locator = targetLocator(condition, context);
      var targetRef = targetReference(condition, context);
      if (!targetRef && !Object.keys(locator).length) {
        throw new facts.PageFactError('INVALID_EXPECTATION', '目标状态条件缺少 locator 或 targetRef');
      }
      var resolved = await perception.resolveTarget(context.intent.tabId, locator, {
        targetRef: targetRef,
        requireGeometry: false,
        timeoutMs: context.timeoutMs || condition && condition.timeoutMs,
        signal: context.signal,
      });
      ensureNotAborted(context.signal);
      return resolved && resolved.target || null;
    }
    function targetMissing(error) {
      return /^(?:TARGET_NOT_FOUND|TARGET_STALE)$/.test(String(error && error.code || ''));
    }
    function baselineChanged(current, baseline, field) {
      var before = String(baseline && baseline[field] || '');
      var after = String(current && current[field] || '');
      return !!(before && after && before !== after);
    }
    async function currentNavigation(context, condition) {
      var state = await perception.perceive({
        tabId: context.intent.tabId,
        kind: 'pageLoadState',
        timeoutMs: context.timeoutMs || condition && condition.timeoutMs,
        readyState: 'loading',
        signal: context.signal,
      });
      ensureNotAborted(context.signal);
      return {
        url: String(state && state.url || ''),
        documentId: 'document_' + facts.hash([
          context.intent.tabId,
          state && state.frameId,
          state && state.loaderId,
        ].join(':')),
        loaderId: String(state && state.loaderId || ''),
      };
    }
    async function evaluateCondition(condition, context) {
      condition = condition || {};
      ensureNotAborted(context.signal);
      var kind = String(condition.kind || condition.type || '');
      var aliases = {
        page_change: 'pageChanged',
        url_change: 'urlChanged',
        url_matches: 'urlMatches',
        text_present: 'textPresent',
        text_absent: 'textAbsent',
        document_ready: 'documentReady',
        target_state: 'targetState',
        element_visible: 'elementVisible',
        element_hidden: 'elementHidden',
        element_exists: 'elementExists',
      };
      kind = aliases[kind] || kind;
      if (kind === 'anyOf' || condition.type === 'anyOf') {
        var anyConditions = condition.conditions || [];
        for (var anyIndex = 0; anyIndex < anyConditions.length; anyIndex += 1) if (await evaluateCondition(anyConditions[anyIndex], context)) return true;
        return false;
      }
      if (kind === 'allOf' || condition.type === 'allOf') {
        var allConditions = condition.conditions || [];
        for (var allIndex = 0; allIndex < allConditions.length; allIndex += 1) if (!(await evaluateCondition(allConditions[allIndex], context))) return false;
        return true;
      }
      if (kind === 'newTab') {
        if (context.browserFactsError) {
          throw new facts.PageFactError('PAGE_STATE_UNAVAILABLE', '实时标签页数据不可用，无法确认是否打开了新标签页', {
            reason: String(context.browserFactsError.message || context.browserFactsError),
          });
        }
        return context.browser.newTabs.length === 1 && context.browser.ambiguous !== true;
      }
      if (/^(?:pageChanged|urlChanged|documentChanged|urlMatches)$/.test(kind)) {
        var navigation = await currentNavigation(context, condition);
        var baseline = context.baseline || null;
        if (kind === 'pageChanged') return context.browser.newTabs.length === 1 && context.browser.ambiguous !== true
          || !!(condition.fromUrl && navigation.url !== String(condition.fromUrl))
          || baselineChanged(navigation, baseline, 'url')
          || baselineChanged(navigation, baseline, 'documentId')
          || baselineChanged(navigation, baseline, 'loaderId');
        if (kind === 'urlChanged') return !!(condition.fromUrl && navigation.url !== String(condition.fromUrl))
          || baselineChanged(navigation, baseline, 'url');
        if (kind === 'documentChanged') return baselineChanged(navigation, baseline, 'documentId')
          || baselineChanged(navigation, baseline, 'loaderId');
        var expectedUrl = condition.pattern !== undefined ? condition.pattern : condition.value;
        if (condition.regex || condition.pattern !== undefined) return new RegExp(String(expectedUrl || ''), condition.caseSensitive ? '' : 'i').test(navigation.url);
        return condition.exact ? navigation.url === String(expectedUrl || '') : navigation.url.indexOf(String(expectedUrl || '')) !== -1;
      }
      if (kind === 'targetStateChanged') {
        throw new facts.PageFactError('INVALID_EXPECTATION', 'targetStateChanged 已移除；请使用明确的 targetState、valueEquals 或 checkedEquals 条件');
      }
      if (kind === 'valueEquals') {
        var valueTarget = await currentTarget(condition, context);
        return !!valueTarget && String(valueTarget.value === null ? '' : valueTarget.value) === String(condition.value === undefined ? context.intent.input && context.intent.input.value : condition.value);
      }
      if (kind === 'checkedEquals') {
        var expectedChecked = condition.value !== undefined ? condition.value : context.intent.input && context.intent.input.checked;
        if (expectedChecked === undefined) expectedChecked = true;
        var checkedTarget = await currentTarget(condition, context);
        return !!checkedTarget && booleanStateMatches(checkedTarget.checked, expectedChecked);
      }
      if (kind === 'elementVisible' || kind === 'elementHidden' || kind === 'elementExists') {
        try {
          var elementTarget = await currentTarget(condition, context);
          return kind === 'elementHidden' ? !elementTarget.visible : (kind === 'elementVisible' ? elementTarget.visible : true);
        } catch (error) {
          if (!targetMissing(error)) throw error;
          return kind === 'elementHidden' || kind === 'elementExists' ? kind === 'elementHidden' : false;
        }
      }
      if (kind === 'textPresent' || kind === 'textAbsent') {
        var needle = String(condition.text || condition.value || '');
        if (!needle) throw new facts.PageFactError('INVALID_EXPECTATION', '文本条件缺少非空 text');
        var found = false;
        var scopedLocator = condition.locator && typeof condition.locator === 'object'
          ? condition.locator : null;
        if (scopedLocator && Object.keys(scopedLocator).length) {
          try {
            var textResolved = await perception.resolveTarget(context.intent.tabId, scopedLocator, {
              requireGeometry: false,
              timeoutMs: context.timeoutMs || condition.timeoutMs,
              signal: context.signal,
            });
            ensureNotAborted(context.signal);
            var scopedTarget = textResolved && textResolved.target || {};
            found = [scopedTarget.text, scopedTarget.name].some(function (value) {
              return String(value || '').indexOf(needle) !== -1;
            });
          } catch (error) {
            if (!targetMissing(error)) throw error;
            found = false;
          }
        } else {
          var search = await perception.perceive({ tabId: context.intent.tabId, kind: 'searchPage', query: needle, includeHidden: true, start: 0, maxChars: 10000, timeoutMs: context.timeoutMs || condition.timeoutMs, signal: context.signal });
          ensureNotAborted(context.signal);
          found = Number(search && search.count) > 0;
        }
        return kind === 'textAbsent' ? !found : found;
      }
      if (kind === 'documentReady') {
        var expectedState = String(condition.state || 'complete');
        var pageLoadState = await perception.perceive({
          tabId: context.intent.tabId,
          kind: 'pageLoadState',
          timeoutMs: context.timeoutMs || condition.timeoutMs,
          readyState: expectedState,
          signal: context.signal,
        });
        ensureNotAborted(context.signal);
        return pageLoadState && pageLoadState.ready === true;
      }
      if (kind === 'targetState') {
        var stateTarget;
        try { stateTarget = await currentTarget(condition, context); }
        catch (error) {
          if (!targetMissing(error)) throw error;
          stateTarget = null;
        }
        if (condition.connected !== undefined && !booleanStateMatches(!!stateTarget, condition.connected)) return false;
        if (!stateTarget) return booleanStateMatches(false, condition.connected);
        if (condition.value !== undefined && String(stateTarget.value === null ? '' : stateTarget.value) !== String(condition.value)) return false;
        if (condition.checked !== undefined && !booleanStateMatches(stateTarget.checked, condition.checked)) return false;
        if (condition.selected !== undefined) {
          var selectedBoolean = expectedBoolean(condition.selected);
          if (selectedBoolean !== null) {
            if (stateTarget.selected !== selectedBoolean) return false;
          } else if (String(stateTarget.value === null ? '' : stateTarget.value) !== String(condition.selected)) {
            // Historical Flow nodes used selected for a select element's option value.
            // Keep that persisted form runnable while new nodes use condition.value.
            return false;
          }
        }
        if (condition.expanded !== undefined && !booleanStateMatches(stateTarget.expanded, condition.expanded)) return false;
        if (condition.visible !== undefined && !booleanStateMatches(stateTarget.visible, condition.visible)) return false;
        if (condition.enabled !== undefined && !booleanStateMatches(stateTarget.enabled, condition.enabled)) return false;
        if (condition.editable !== undefined && !booleanStateMatches(stateTarget.editable, condition.editable)) return false;
        return true;
      }
      return false;
    }
    async function verify(input) {
      input = input || {};
      var intent = input.intent || {};
      var actionFacts = input.actionFacts || {};
      var expectation = intent.expect || input.expectation;
      var browser = browserSummary(input.browserFacts);
      var targetRef = input.targetRef || intent.targetRef || actionFacts.target && actionFacts.target.targetRef || null;
      var derivedFacts = input.derivedFacts || {};
      var signals = [];
      var evidence = [];
      if (actionFacts.dispatched) {
        signals.push('cdp_dispatched');
        evidence.push({ kind: 'action_facts', commands: (actionFacts.commands || []).map(function (command) { return command.method; }) });
      }
      if (browser.newTabs.length) { signals.push('new_tab'); evidence.push({ kind: 'new_tab', candidates: browser.newTabs, ambiguous: browser.ambiguous }); }
      var readiness = derivedFacts.readiness && typeof derivedFacts.readiness === 'object' ? derivedFacts.readiness : null;
      if (readiness) {
        signals.push(readiness.ready === true ? 'page_ready' : 'page_readiness_incomplete');
        evidence.push({ kind: 'readiness', report: readiness });
      }
      if (actionFacts.failure) {
        return contract.createVerdict({
          status: 'failed',
          performed: actionFacts.transportInterrupted === true
            ? 'unknown' : (actionFacts.dispatched === true ? 'yes' : 'no'),
          conditionMet: false,
          signals: signals, evidence: evidence, reason: actionFacts.failure.message || '页面动作执行失败',
        });
      }
      if (expectation) {
        var barrierVerdict = readiness && readiness.ready === true && readiness.expectedState && readiness.expectedState.satisfied === true
          ? readiness.expectedState.verification : null;
        if (barrierVerdict && barrierVerdict.status === 'confirmed') {
          // The readiness barrier already polled this expectation to a
          // confirmed verdict after the action; do not read the page again.
          return contract.createVerdict({
            status: 'confirmed',
            performed: performedFrom(actionFacts),
            conditionMet: true,
            signals: signals.concat(barrierVerdict.signals || []),
            evidence: evidence.concat(barrierVerdict.evidence || []),
            reason: '显式 expectation 已在页面就绪等待中满足',
          });
        }
        var conditionMet;
        conditionMet = await evaluateCondition(expectation, {
          intent: intent,
          browser: browser,
          browserFactsError: input.browserFactsError || null,
          targetRef: targetRef,
          baseline: input.baseline || derivedFacts.navigationBaseline || null,
          timeoutMs: input.timeoutMs || intent.timeoutMs || null,
          signal: input.signal || intent.signal || null,
        });
        return contract.createVerdict({
          status: conditionMet ? 'confirmed' : 'failed',
          performed: performedFrom(actionFacts),
          conditionMet: conditionMet,
          signals: signals,
          evidence: evidence,
          reason: conditionMet ? '显式 expectation 已满足' : '显式 expectation 未满足',
        });
      }
      if (intent.kind === 'handleDialog' && derivedFacts.dialog) {
        var dialogEvidence = evidence.concat({ kind: derivedFacts.dialog.handled === true ? 'dialog_handled' : 'dialog_policy', fact: derivedFacts.dialog });
        signals.push(derivedFacts.dialog.handled === true ? 'dialog_handled' : (derivedFacts.dialog.armed ? 'dialog_policy_armed' : 'dialog_history_read'));
        return contract.createVerdict({
          status: 'confirmed', performed: derivedFacts.dialog.handled === true ? 'yes' : 'no', conditionMet: true,
          signals: signals, evidence: dialogEvidence,
          reason: derivedFacts.dialog.handled === true ? '原生对话框已按意图处理' : (derivedFacts.dialog.armed ? '已安装原生对话框处理策略' : '已读取原生对话框历史事实'),
        });
      }
      if (derivedFacts.satisfiedBeforeAction === true) {
        signals.push('business_state_already_satisfied');
        evidence.push({ kind: 'business_state', fact: derivedFacts });
        return contract.createVerdict({
          status: 'confirmed', performed: 'no', conditionMet: true,
          signals: signals, evidence: evidence, reason: '目标业务状态在动作前已经满足，无需重复输入',
        });
      }
      // A plain Flow action without an explicit expectation is confirmed by
      // the browser/CDP command response itself. Business-state facts are
      // authoritative for Agent/script callers and for Flow actions that
      // explicitly requested an expectation, but an implicit post-action read
      // must not turn a successfully dispatched Flow command into an
      // unconfirmed result (for example, a scroll at a boundary or a control
      // whose framework-owned value cannot be read back immediately).
      if (derivedFacts.businessState && (intent.source !== 'flow' || !!expectation)) {
        var stateConfirmed = derivedFacts.businessState.confirmed === true;
        signals.push(stateConfirmed ? 'business_state_confirmed' : 'business_state_unconfirmed');
        evidence.push({ kind: 'business_state', fact: derivedFacts.businessState });
        return contract.createVerdict({
          status: stateConfirmed ? 'confirmed' : 'unconfirmed',
          performed: performedFrom(actionFacts),
          conditionMet: stateConfirmed,
          signals: signals,
          evidence: evidence,
          reason: stateConfirmed ? '动作后的业务状态已确认' : '浏览器已接受输入，但动作后的业务状态未能确认',
        });
      }
      var readResultReturned = /^(?:evaluate|webStorage)$/.test(intent.kind) && Object.prototype.hasOwnProperty.call(derivedFacts, 'result');
      if (actionFacts.dispatched || readResultReturned) {
        signals.push('command_accepted');
        // Plain Flow actions deliberately stop at the browser/CDP command
        // boundary when no explicit expectation was requested. This includes
        // state-shaped actions (fill/select/check/scroll/upload/patch), whose
        // optional read-back is diagnostic and must not veto a successful
        // command response. Agent/script callers still require the narrower
        // business-state or expectation paths below.
        var plainFlowAction = intent.source === 'flow' && !expectation;
        // Agent and script callers need business evidence (or an explicit
        // expectation) before claiming that the user's goal was achieved.
        // A successful CDP/browser response only proves that the input was
        // accepted.  Ordinary Flow actions are the deliberate exception.
        var commandCompletionKind = plainFlowAction;
        return contract.createVerdict({
          status: commandCompletionKind ? 'confirmed' : 'unconfirmed',
          performed: actionFacts.dispatched ? 'yes' : 'no', conditionMet: commandCompletionKind,
          signals: signals, evidence: evidence,
          reason: commandCompletionKind ? '浏览器已完成该输入或生命周期原语' : '浏览器已接受输入，但缺少业务完成事实',
        });
      }
      return contract.createVerdict({
        status: 'failed', performed: 'no', conditionMet: false,
        signals: signals.concat('command_not_dispatched'), evidence: evidence,
        reason: '页面操作指令未送达浏览器',
      });
    }
    async function createReceipt(input) {
      var intent = input.intent || {};
      var actionFacts = input.actionFacts || {};
      var derivedFacts = input.derivedFacts || {};
      var verification = await verify(input);
      var browser = browserSummary(input.browserFacts);
      var navigationFacts = derivedFacts.navigation ? [Object.assign({ kind: 'navigation', sources: ['cdp'] }, derivedFacts.navigation)] : [];
      var newNavigationTarget = null;
      if (browser.newTabs.length) newNavigationTarget = {
        kind: 'new_tab',
        disposition: 'new_tab',
        actionId: intent.actionId,
        sourceTabId: intent.tabId,
        candidates: browser.newTabs,
        targets: browser.newTabs,
        openedTabIds: browser.newTabs.map(function (tab) { return tab.tabId; }),
        ambiguous: browser.ambiguous,
        tabId: browser.ambiguous ? 0 : browser.newTabs[0].tabId,
        windowId: browser.ambiguous ? 0 : browser.newTabs[0].windowId,
        url: browser.ambiguous ? '' : browser.newTabs[0].url,
        active: browser.ambiguous ? null : browser.newTabs[0].active === true,
        status: browser.ambiguous ? '' : String(browser.newTabs[0].status || ''),
        sources: browser.newTabs.reduce(function (all, tab) {
          (tab.sources || []).forEach(function (source) { if (all.indexOf(source) === -1) all.push(source); });
          return all;
        }, []),
      };
      var targetRef = input.targetRef || actionFacts.target && actionFacts.target.targetRef || intent.targetRef || null;
      return contract.createReceipt({
        actionId: intent.actionId, source: intent.source, tabId: intent.tabId, kind: intent.kind,
        inputProvenance: actionFacts.inputProvenance || 'cdp', trustedEventExpected: !/^(?:navigate|reload|handleDialog|createTab|activateTab|closeTab|evaluate|patch|webStorage|replayRequest)$/.test(intent.kind),
        targetRef: targetRef,
        actionFacts: actionFacts, verification: verification,
        navigation: {
          observed: navigationFacts.length > 0,
          disposition: navigationFacts.length ? 'same_tab_navigation' : 'none',
          tabId: intent.tabId,
          facts: navigationFacts,
        },
        newNavigationTarget: newNavigationTarget,
        browserFacts: browser.facts || [],
        startedAt: actionFacts.startedAt || intent.startedAt,
        completedAt: actionFacts.completedAt || new Date().toISOString(), durationMs: actionFacts.durationMs,
        warnings: actionFacts.warnings || [],
      });
    }
    async function verifyExpectation(input) {
      input = input || {};
      // A caller that owns the real action intent passes it so condition
      // defaults (for example valueEquals without value) resolve from it.
      var baseIntent = input.intent && typeof input.intent === 'object'
        ? input.intent
        : { tabId: input.tabId, kind: 'evaluate', input: {} };
      var fakeIntent = Object.assign({}, baseIntent, {
        tabId: input.tabId || baseIntent.tabId,
        targetRef: input.targetRef || baseIntent.targetRef || null,
        expect: input.expectation,
        signal: input.signal || null,
      });
      var verdict = await verify({
        intent: fakeIntent,
        actionFacts: { dispatched: false, browserResponses: [] },
        browserFacts: { facts: [], newTabs: [] },
        targetRef: input.targetRef || null,
        baseline: input.baseline || null,
        timeoutMs: input.timeoutMs || null,
        signal: input.signal || null,
      });
      if (input.final === true && verdict.status !== 'confirmed') {
        return contract.createVerdict({
          status: 'failed',
          performed: 'no',
          conditionMet: false,
          signals: verdict.signals,
          evidence: verdict.evidence,
          reason: String(input.failureReason || verdict.reason || '页面条件未满足'),
        });
      }
      return verdict;
    }
    function verifyAssertion(input) {
      input = input || {};
      return contract.createVerdict({
        status: input.passed === true ? 'confirmed' : 'failed',
        performed: 'no',
        conditionMet: input.passed === true,
        signals: ['page_assertion'],
        evidence: [{ kind: String(input.kind || 'assertion'), actual: input.actual, expected: input.expected }],
        reason: String(input.reason || (input.passed === true ? '页面断言已满足' : '页面断言未满足')),
      });
    }
    function createFactReceipt(input) {
      input = input || {};
      var verification = input.verification && /^(?:confirmed|unconfirmed|failed)$/.test(String(input.verification.status || ''))
        ? input.verification
        : contract.createVerdict({
          status: input.failure ? 'failed' : (input.conditionMet === true ? 'confirmed' : 'unconfirmed'),
          performed: input.performed || (input.failure ? 'no' : 'unknown'),
          conditionMet: input.conditionMet === true,
          signals: input.signals || [],
          evidence: input.evidence || [],
          reason: input.reason || '',
        });
      var startedAt = String(input.startedAt || new Date().toISOString());
      var completedAt = String(input.completedAt || new Date().toISOString());
      // PageFactContract intentionally exposes data normalization only; it
      // has no id() helper. Lifecycle/fact receipts still need a local
      // fallback when the caller did not provide an actionId.
      var actionId = String(input.actionId || ('action_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
      var tabId = Number(input.tabId) || 0;
      var kind = String(input.kind || 'fact');
      return contract.createReceipt({
        actionId: actionId,
        source: String(input.source || 'flow'),
        tabId: tabId,
        kind: kind,
        inputProvenance: String(input.inputProvenance || 'browser-fact'),
        trustedEventExpected: false,
        targetRef: input.targetRef || null,
        actionFacts: input.actionFacts || {
          actionId: actionId,
          tabId: tabId,
          kind: kind,
          inputProvenance: String(input.inputProvenance || 'browser-fact'),
          dispatched: verification.performed === 'yes',
          transportInterrupted: verification.performed === 'unknown',
          browserResponses: input.browserResponses || [],
          startedAt: startedAt,
          completedAt: completedAt,
        },
        verification: verification,
        navigation: input.navigation || {},
        newNavigationTarget: input.newNavigationTarget || null,
        browserFacts: input.browserFacts || [],
        startedAt: startedAt,
        completedAt: completedAt,
        durationMs: input.durationMs !== undefined ? input.durationMs : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        warnings: input.warnings || [],
      });
    }
    function failedWaitReceipt(input, error, startedAt) {
      var completedAt = new Date().toISOString();
      var performed = error && error.performed !== undefined
        ? error.performed
        : String(error && error.code || '') === 'ACTION_CANCELLED' ? 'unknown' : 'no';
      var verification = contract.createVerdict({
        status: 'failed',
        performed: performed,
        conditionMet: false,
        signals: ['page_wait_failed'],
        evidence: [{
          kind: String(input.kind || 'page_wait'),
          code: String(error && error.code || 'PAGE_WAIT_FAILED'),
          details: error && error.details || null,
        }],
        reason: String(error && error.message || '页面等待失败'),
      });
      return createFactReceipt({
        source: input.source || 'flow', tabId: input.tabId, kind: input.kind || 'wait',
        performed: performed, conditionMet: false, inputProvenance: 'perception',
        verification: verification, targetRef: input.targetRef || null,
        startedAt: startedAt, completedAt: completedAt,
      });
    }
    async function waitForElement(input) {
      input = input || {};
      var params = Object.assign({}, input.params || {});
      var tabId = Math.floor(Number(input.tabId || params.tabId));
      var signal = input.signal || params.signal || null;
      var startedAt = new Date().toISOString();
      try {
        ensureNotAborted(signal);
        var result = await perception.perceive(Object.assign({}, params, input.locator || {}, {
          tabId: tabId,
          kind: 'waitFor',
          signal: signal,
        }));
        ensureNotAborted(signal);
        var verification = contract.createVerdict({
          status: 'confirmed', performed: 'no', conditionMet: true,
          signals: ['page_wait_element'],
          evidence: [{ kind: 'element', targetRef: result && result.targetRef || null, count: Number(result && result.count) || 0 }],
          reason: '等待的页面元素已出现',
        });
        var receipt = createFactReceipt({
          source: input.source || 'flow', tabId: tabId, kind: 'waitForElement',
          performed: 'no', conditionMet: true, inputProvenance: 'perception',
          verification: verification, targetRef: result && result.targetRef || params.targetRef || null,
          startedAt: startedAt, completedAt: new Date().toISOString(),
        });
        return Object.assign({}, result || {}, {
          status: receipt.status, performed: receipt.performed, conditionMet: receipt.conditionMet,
          actionReceipt: receipt, receipt: receipt, verification: receipt.verification,
        });
      } catch (error) {
        if (error && typeof error === 'object' && !error.receipt) {
          error.receipt = failedWaitReceipt({
            source: input.source || 'flow', tabId: tabId, kind: 'waitForElement',
            targetRef: params.targetRef || null,
          }, error, startedAt);
        }
        throw error;
      }
    }
    async function waitForPageLoad(input) {
      input = input || {};
      var params = Object.assign({}, input.params || {});
      var tabId = Math.floor(Number(input.tabId || params.tabId));
      var signal = input.signal || params.signal || null;
      var startedAt = new Date().toISOString();
      try {
        ensureNotAborted(signal);
        var result = await perception.perceive(Object.assign({}, params, {
          tabId: tabId,
          kind: 'waitForPageLoad',
          signal: signal,
        }));
        ensureNotAborted(signal);
        var verification = contract.createVerdict({
          status: 'confirmed', performed: 'no', conditionMet: result && result.ready === true,
          signals: ['page_wait_load'],
          evidence: [{
            kind: 'page_load', readyState: result && result.readyState,
            tabStatus: result && result.tabStatus, loaderId: result && result.loaderId,
            loadChecks: result && result.loadChecks || null,
          }],
          reason: '页面加载完成事实已连续满足稳定窗口',
        });
        var receipt = createFactReceipt({
          source: input.source || 'flow', tabId: tabId, kind: 'waitForPageLoad',
          performed: 'no', conditionMet: true, inputProvenance: 'perception',
          verification: verification, startedAt: startedAt, completedAt: new Date().toISOString(),
        });
        return Object.assign({}, result || {}, {
          loaded: result && result.ready === true, tabId: tabId, url: result && result.url || '',
          status: receipt.status, performed: receipt.performed, conditionMet: receipt.conditionMet,
          actionReceipt: receipt, receipt: receipt, verification: receipt.verification,
        });
      } catch (error) {
        if (error && typeof error === 'object' && !error.receipt) {
          error.receipt = failedWaitReceipt({
            source: input.source || 'flow', tabId: tabId, kind: 'waitForPageLoad',
          }, error, startedAt);
        }
        throw error;
      }
    }
    function assertionMatch(actual, expected, mode) {
      actual = String(actual === undefined || actual === null ? '' : actual);
      expected = String(expected === undefined || expected === null ? '' : expected);
      if (mode === 'regex') return new RegExp(expected).test(actual);
      if (mode === 'notContains') return actual.indexOf(expected) === -1;
      if (mode === 'contains') return actual.indexOf(expected) !== -1;
      return actual === expected;
    }
    async function verifyPageAssertion(input) {
      input = input || {};
      var command = String(input.command || '');
      var params = input.params || {};
      var tabId = Math.floor(Number(input.tabId || params.tabId));
      var deadline = Number(input.deadline) || 0;
      var timeoutMs = Math.max(0, Math.min(Number(params.timeoutMs) || 0, 120000));
      var signal = input.signal || params.signal || null;
      // The assertion budget covers the initial snapshot/target read as well
      // as subsequent polling attempts. Recursive calls preserve this
      // absolute deadline through input.deadline.
      if (!deadline) deadline = Date.now() + timeoutMs;
      ensureNotAborted(signal);
      var snapshot = await perception.capture(tabId, Object.assign({}, params, { signal: signal }));
      ensureNotAborted(signal);
      var expected = params.expected;
      var actual = null;
      var passed = false;
      var reason = '';
      if (command === 'assertUrl') {
        actual = snapshot.url;
        passed = assertionMatch(actual, expected, params.matchMode);
        reason = 'URL ' + (passed ? '满足' : '不满足') + '预期';
      } else {
        var target = null;
        var resolvedTargetRef = null;
        try {
          var resolved = await perception.resolveTarget(tabId, input.locator || {}, {
            targetRef: params.targetRef || null,
            requireGeometry: false,
            signal: signal,
          });
          ensureNotAborted(signal);
          target = resolved.target;
          resolvedTargetRef = resolved.targetRef;
        } catch (error) {
          if (String(error && error.code || '') !== 'TARGET_NOT_FOUND') throw error;
        }
        if (command === 'assertElement') {
          var condition = String(params.condition || 'exists');
          passed = condition === 'notExists' ? !target
            : condition === 'hidden' ? !target || !target.visible
              : condition === 'visible' ? !!(target && target.visible) : !!target;
          actual = target ? { exists: true, visible: target.visible } : { exists: false, visible: false };
          expected = condition;
        } else if (command === 'assertText') {
          actual = target && target.text || '';
          passed = !!target && assertionMatch(actual, expected, params.matchMode);
        } else if (command === 'assertAttribute') {
          if (target && /^(?:css|style)$/.test(String(params.checkType || ''))) {
            var cssResult = await perception.perceive(Object.assign({}, params, input.locator || {}, {
              tabId: tabId, kind: 'inspectCss', targetRef: resolvedTargetRef,
              properties: params.name, start: 0, maxChars: 10000,
              signal: signal,
            }));
            ensureNotAborted(signal);
            actual = cssResult.computed && cssResult.computed[params.name];
          } else if (params.checkType === 'value') actual = target && target.value;
          else if (params.checkType === 'checked') actual = target && target.checked;
          else actual = target && target.attributes && target.attributes[params.name];
          passed = !!target && assertionMatch(actual, expected, params.matchMode);
        } else if (command === 'assertValue') {
          actual = target && target.value;
          passed = !!target && assertionMatch(actual, expected, params.matchMode);
        }
        reason = command + (passed ? ' 已满足' : ' 未满足');
      }
      if (!passed && Date.now() < deadline) {
        await new Promise(function (resolve, reject) {
          var timer = setTimeout(function () { cleanup(); resolve(); }, Math.min(100, Math.max(1, deadline - Date.now())));
          function cleanup() { if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort); }
          function onAbort() {
            clearTimeout(timer);
            cleanup();
            try { ensureNotAborted(signal); } catch (error) { reject(error); }
          }
          if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
        });
        var retryInput = Object.assign({}, input, { deadline: deadline });
        return verifyPageAssertion(retryInput);
      }
      return {
        passed: passed,
        actual: actual,
        expected: expected,
        verification: verifyAssertion({ kind: command, passed: passed, actual: actual, expected: expected, reason: reason }),
      };
    }
    async function createAggregateReceipt(input) {
      input = input || {};
      var intent = input.intent || {};
      var readiness = input.derivedFacts && input.derivedFacts.readiness;
      var children = Array.isArray(input.children) ? input.children : [];
      var failed = children.filter(function (child) { return child && child.skipped !== true && child.receipt && child.receipt.status === 'failed'; });
      var unconfirmed = children.filter(function (child) { return child && child.skipped !== true && child.receipt && child.receipt.status === 'unconfirmed'; });
      var unknown = children.some(function (child) { return child && child.receipt && child.receipt.performed === 'unknown'; });
      var performed = unknown ? 'unknown' : (children.some(function (child) { return child && child.receipt && child.receipt.performed === 'yes'; }) ? 'yes' : 'no');
      var status = failed.length ? 'failed' : (unconfirmed.length ? 'unconfirmed' : 'confirmed');
      var verification = contract.createVerdict({
        status: status,
        performed: performed,
        conditionMet: status === 'confirmed',
        signals: ['aggregate_form_verification'].concat(readiness ? [readiness.ready ? 'page_ready' : 'page_readiness_incomplete'] : []),
        evidence: children.map(function (child) { return { kind: 'field_receipt', field: child.field, actionId: child.receipt && child.receipt.actionId, status: child.receipt && child.receipt.status, performed: child.receipt && child.receipt.performed, skipped: child.skipped === true }; }).concat(readiness ? [{ kind: 'readiness', report: readiness }] : []),
        reason: failed.length ? failed.length + ' 个表单字段失败' : (unconfirmed.length ? unconfirmed.length + ' 个表单字段结果未确认' : '所有表单字段均已由统一验证引擎确认'),
      });
      var first = children[0] && children[0].receipt;
      var last = children[children.length - 1] && children[children.length - 1].receipt;
      var childActionFacts = children.map(function (child) { return child && child.receipt && child.receipt.actionFacts || {}; });
      var navigationFacts = children.reduce(function (all, child) {
        return all.concat(child && child.receipt && child.receipt.navigation && child.receipt.navigation.facts || []);
      }, []);
      var browserFacts = children.reduce(function (all, child) {
        return all.concat(child && child.receipt && child.receipt.browserFacts || []);
      }, []);
      var newTabCandidates = [];
      children.forEach(function (child) {
        var target = child && child.receipt && child.receipt.newNavigationTarget;
        (target && target.candidates || []).forEach(function (candidate) {
          if (!newTabCandidates.some(function (existing) { return Number(existing.tabId) === Number(candidate.tabId); })) newTabCandidates.push(candidate);
        });
      });
      var firstFailure = childActionFacts.map(function (item) { return item.failure; }).find(Boolean) || null;
      var actionFacts = {
        actionId: intent.actionId,
        tabId: intent.tabId,
        kind: 'fillFormFields',
        target: null,
        actualCoordinates: null,
        relatedTargets: childActionFacts.map(function (item) { return item.target; }).filter(Boolean),
        coordinateFacts: childActionFacts.reduce(function (all, item) {
          return all.concat(item.coordinateFacts || (item.actualCoordinates ? [{ role: 'field', x: item.actualCoordinates.x, y: item.actualCoordinates.y }] : []));
        }, []),
        childActionIds: children.map(function (child) { return child.receipt && child.receipt.actionId || ''; }),
        commands: childActionFacts.reduce(function (all, item) { return all.concat(item.commands || []); }, []),
        browserResponses: childActionFacts.reduce(function (all, item) { return all.concat(item.browserResponses || []); }, []),
        inputProvenance: 'cdp',
        dispatched: childActionFacts.some(function (item) { return item.dispatched === true; }),
        transportInterrupted: childActionFacts.some(function (item) { return item.transportInterrupted === true; }),
        failure: firstFailure,
        startedAt: input.startedAt || first && first.startedAt || new Date().toISOString(),
        completedAt: input.completedAt || last && last.completedAt || new Date().toISOString(),
        durationMs: Math.max(0, Number(input.durationMs) || 0),
        warnings: children.reduce(function (all, child) { return all.concat(child.receipt && child.receipt.warnings || []); }, input.warnings || []),
      };
      var ambiguousNewTab = newTabCandidates.length > 1 || children.some(function (child) {
        return child && child.receipt && child.receipt.newNavigationTarget && child.receipt.newNavigationTarget.ambiguous === true;
      });
      var newNavigationTarget = newTabCandidates.length ? {
        kind: 'new_tab', disposition: 'new_tab', actionId: intent.actionId, sourceTabId: intent.tabId,
        candidates: newTabCandidates, targets: newTabCandidates,
        openedTabIds: newTabCandidates.map(function (candidate) { return candidate.tabId; }),
        ambiguous: ambiguousNewTab,
        tabId: ambiguousNewTab ? 0 : newTabCandidates[0].tabId,
        windowId: ambiguousNewTab ? 0 : newTabCandidates[0].windowId,
        url: ambiguousNewTab ? '' : newTabCandidates[0].url,
        active: ambiguousNewTab ? null : newTabCandidates[0].active === true,
        status: ambiguousNewTab ? '' : String(newTabCandidates[0].status || ''),
        sources: newTabCandidates.reduce(function (all, candidate) {
          (candidate.sources || []).forEach(function (source) { if (all.indexOf(source) === -1) all.push(source); });
          return all;
        }, []),
      } : null;
      if (intent.expect && !failed.length && input.complete !== false) {
        verification = await verify({
          intent: intent,
          actionFacts: actionFacts,
          browserFacts: { facts: browserFacts, newTabs: newTabCandidates, ambiguous: ambiguousNewTab },
          derivedFacts: input.derivedFacts,
        });
      }
      return contract.createReceipt({
        actionId: intent.actionId,
        source: intent.source,
        tabId: intent.tabId,
        kind: 'fillFormFields',
        inputProvenance: 'cdp',
        trustedEventExpected: true,
        actionFacts: actionFacts,
        verification: verification,
        navigation: { observed: navigationFacts.length > 0, facts: navigationFacts },
        newNavigationTarget: newNavigationTarget,
        browserFacts: browserFacts,
        startedAt: actionFacts.startedAt,
        completedAt: actionFacts.completedAt,
        durationMs: input.durationMs,
        warnings: actionFacts.warnings,
      });
    }
    return Object.freeze({
      verify: verify,
      createReceipt: createReceipt,
      createAggregateReceipt: createAggregateReceipt,
      createFactReceipt: createFactReceipt,
      verifyExpectation: verifyExpectation,
      verifyAssertion: verifyAssertion,
      verifyPageAssertion: verifyPageAssertion,
      waitForElement: waitForElement,
      waitForPageLoad: waitForPageLoad,
    });
  }
  return Object.freeze({ API_VERSION: API_VERSION, createPageVerificationEngine: createPageVerificationEngine });
});
