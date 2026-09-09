// Page tab adoption, reuse, readiness, and driver-cache lifecycle.
(function attachNodePageLifecycleOps(root, factory) {
  'use strict';
  var api = factory();
  var commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.NodePageLifecycleOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function ownDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
    return descriptor && !descriptor.get && !descriptor.set && hasOwn(descriptor, 'value') ? descriptor : null;
  }
  function ownValue(value, key, fallback) {
    var descriptor = ownDescriptor(value, key);
    return descriptor ? descriptor.value : fallback;
  }
  function defineOwn(target, key, value) {
    Object.defineProperty(target, key, { value: value, enumerable: true, configurable: true, writable: true });
    return value;
  }
  function copyOwn(value) {
    var output = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    Object.keys(value).forEach(function (key) {
      var descriptor = ownDescriptor(value, key);
      if (descriptor) defineOwn(output, key, descriptor.value);
    });
    return output;
  }
  function requireObject(value, name) {
    if (!value || typeof value !== 'object') throw new Error('NodePageLifecycleOps missing dependency: ' + name);
    return value;
  }
  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('NodePageLifecycleOps missing dependency: ' + name);
    return value;
  }
  function requireMethod(value, method, name) {
    requireObject(value, name);
    var descriptor = ownDescriptor(value, method);
    if (!descriptor || typeof descriptor.value !== 'function') {
      throw new Error('NodePageLifecycleOps missing dependency: ' + name + '.' + method);
    }
    return descriptor.value.bind(value);
  }

  function createPageLifecycleOps(deps) {
    deps = deps || {};
    var chrome = requireObject(deps.chrome, 'chrome');
    var tabsGet = requireMethod(chrome.tabs, 'get', 'chrome.tabs');
    var tabsQuery = requireMethod(chrome.tabs, 'query', 'chrome.tabs');
    var tabRuntime = requireObject(deps.tabRuntime, 'tabRuntime');
    var registerTab = requireMethod(tabRuntime, 'registerTab', 'tabRuntime');
    var adoptOrGetTabId = requireMethod(tabRuntime, 'adoptOrGetTabId', 'tabRuntime');
    var reuseOrCreateTab = requireMethod(tabRuntime, 'reuseOrCreateTab', 'tabRuntime');
    var getTabIdDescriptor = ownDescriptor(tabRuntime, 'getTabId');
    var getTabId = getTabIdDescriptor && typeof getTabIdDescriptor.value === 'function'
      ? getTabIdDescriptor.value.bind(tabRuntime)
      : null;
    var getConfig = requireFunction(deps.getConfig, 'getConfig');
    var getSession = requireFunction(deps.getSession, 'getSession');
    var getRunCtx = requireFunction(deps.getRunCtx, 'getRunCtx');
    var throwIfStopped = requireFunction(deps.throwIfStopped, 'throwIfStopped');
    var logForExecution = requireFunction(deps.logForExecution, 'logForExecution');
    var executePageCommand = requireFunction(deps.executePageCommand, 'executePageCommand');
    var pageHostMatchesTab = typeof deps.pageHostMatchesTab === 'function' ? deps.pageHostMatchesTab : null;
    var readyPromises;
    var runtimeTargets;
    var lifecycleGeneration = 0;

    function resetRuntimeState() {
      lifecycleGeneration += 1;
      readyPromises = Object.create(null);
      runtimeTargets = Object.create(null);
    }
    resetRuntimeState();

    function pageSource(pageId) { return 'page:' + pageId; }
    function positiveTabId(value) {
      var number = Number(value);
      return isFinite(number) && number > 0 ? Math.floor(number) : 0;
    }
    function runtimeTargetSource(pageId, tabId) {
      pageId = String(pageId || '').trim();
      if (pageId) return pageSource(pageId);
      tabId = positiveTabId(tabId);
      return tabId ? 'tab:' + tabId : '';
    }
    function runtimeTabIdFromParams(params) {
      return positiveTabId(ownValue(params, 'tabId', 0)
        || ownValue(params, 'activeTabId', 0)
        || ownValue(params, 'targetTabId', 0));
    }
    function rememberCurrentRuntimeTab(tabId, detail) {
      tabId = positiveTabId(tabId);
      if (!tabId) return;
      var runCtx = getRunCtx();
      if (!runCtx || typeof runCtx !== 'object') return;
      defineOwn(runCtx, 'tabId', tabId);
      defineOwn(runCtx, 'currentTabId', tabId);
      defineOwn(runCtx, 'activeTabId', tabId);
      var windowId = ownValue(detail, 'windowId', 0) || 0;
      if (windowId) defineOwn(runCtx, 'windowId', windowId);
    }
    function requireRuntimeTabId(params, actionLabel) {
      var tabId = runtimeTabIdFromParams(params);
      if (!tabId) {
        throw new Error((actionLabel || '页面操作') + '需要 tabId。先执行 openPage/openUrl 获取 tabId，或在节点参数中传入 tabId。');
      }
      return tabsGet(tabId).then(function (tab) {
        rememberCurrentRuntimeTab(tabId, { windowId: ownValue(tab, 'windowId', 0) || 0 });
        return tabId;
      });
    }
    function rememberPageRuntimeTarget(pageId, tabId, detail, expectedGeneration) {
      if (expectedGeneration !== undefined && expectedGeneration !== lifecycleGeneration) return false;
      pageId = String(pageId || '');
      tabId = positiveTabId(tabId);
      if (!pageId || !tabId) return;
      var target = copyOwn(detail);
      defineOwn(target, 'tabId', tabId);
      defineOwn(target, 'at', Date.now());
      defineOwn(runtimeTargets, pageId, target);
      rememberCurrentRuntimeTab(tabId, detail);
      return true;
    }
    function getRememberedPageTabId(pageId) {
      pageId = String(pageId || '');
      var target = ownValue(runtimeTargets, pageId, null);
      var tabId = positiveTabId(ownValue(target, 'tabId', 0)
        || (getTabId ? getTabId(pageSource(pageId)) : 0));
      if (!tabId) return Promise.resolve(0);
      var expectedGeneration = lifecycleGeneration;
      return tabsGet(tabId).then(function (tab) {
        if (!target) rememberPageRuntimeTarget(pageId, tabId, {
          source: pageSource(pageId),
          url: ownValue(tab, 'url', ''),
          windowId: ownValue(tab, 'windowId', 0),
        }, expectedGeneration);
        return tabId;
      }, function () {
        if (expectedGeneration !== lifecycleGeneration || ownValue(runtimeTargets, pageId, null) !== target) return 0;
        delete runtimeTargets[pageId];
        return 0;
      });
    }
    function getPage(pageId) {
      var config = getConfig() || {};
      var pages = ownValue(config, 'pages', null);
      var page = ownValue(pages, String(pageId || ''), null);
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw new Error('页面配置不存在: ' + pageId + '（可能已被删除）');
      }
      return page;
    }
    function hostFromUrl(url) { try { return new URL(String(url || '')).host; } catch (_) { return ''; } }
    function pageMatchesTab(page, source, tab) {
      if (!tab || !ownValue(tab, 'id', 0) || !ownValue(tab, 'url', '')) return false;
      var pageHost = pageHostMatchesTab ? '' : hostFromUrl(ownValue(page, 'url', ''));
      if (!pageHostMatchesTab && !pageHost) return false;
      return pageHostMatchesTab ? pageHostMatchesTab(page, source, tab) : hostFromUrl(ownValue(tab, 'url', '')) === pageHost;
    }
    function claimPageTab(source, tab) {
      var tabId = ownValue(tab, 'id', 0) || 0;
      if (!tabId) return false;
      var claimed = registerTab(source, tabId);
      if (claimed === false) return false;
      if (claimed === true) return true;
      return !getTabId || getTabId(source) === tabId;
    }
    function getClaimWindowId() {
      var session = getSession();
      var originWindowId = ownValue(session, 'originWindowId', 0) || 0;
      if (originWindowId) return Promise.resolve(originWindowId);
      return tabsQuery({ active: true, lastFocusedWindow: true }).then(function (tabs) {
        var tab = ownValue(tabs, '0', null);
        return ownValue(tab, 'windowId', 0) || 0;
      });
    }
    function preview(value, maxLength) {
      var text = String(value || '');
      return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
    }
    function findClaimablePageTab(page, source, execution) {
      return getClaimWindowId().then(function (windowId) {
        return windowId ? tabsQuery({ windowId: windowId }) : [];
      }).then(function (tabs) {
        var candidates = [];
        var seen = Object.create(null);
        var active = (tabs || []).find(function (tab) { return ownValue(tab, 'active', false) === true; });
        var activeId = ownValue(active, 'id', 0) || 0;
        if (activeId) { candidates.push(active); seen[activeId] = true; }
        (tabs || []).forEach(function (tab) {
          var tabId = ownValue(tab, 'id', 0) || 0;
          if (!tabId || seen[tabId]) return;
          candidates.push(tab);
          seen[tabId] = true;
        });
        for (var index = 0; index < candidates.length; index++) {
          var candidate = candidates[index];
          if (!pageMatchesTab(page, source, candidate)) continue;
          if (claimPageTab(source, candidate)) return candidate;
          logForExecution(execution, '跳过已被其他流程占用的页面标签: ' + source + ' tabId=' + ownValue(candidate, 'id', 0));
        }
        return null;
      });
    }
    function foregroundRequested(options) {
      return ownValue(options, 'focusWindow', false) === true
        || ownValue(options, 'foreground', false) === true
        || ownValue(options, 'requiresForeground', false) === true;
    }
    function mergeNodeForegroundOptions(node, params) {
      var output = copyOwn(params);
      if (ownValue(node, 'foreground', false) === true) defineOwn(output, 'foreground', true);
      if (ownValue(node, 'requiresForeground', false) === true) defineOwn(output, 'requiresForeground', true);
      if (ownValue(node, 'focusWindow', false) === true) defineOwn(output, 'focusWindow', true);
      if (ownValue(node, 'reveal', false) === true) defineOwn(output, 'reveal', true);
      return output;
    }
    function raceWithStop(promise) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setInterval(function () {
          if (settled) { clearInterval(timer); return; }
          try { throwIfStopped(); } catch (error) { settled = true; clearInterval(timer); reject(error); }
        }, 250);
        Promise.resolve(promise).then(function (value) {
          if (!settled) { settled = true; clearInterval(timer); resolve(value); }
        }, function (error) {
          if (!settled) { settled = true; clearInterval(timer); reject(error); }
        });
      });
    }
    function actionNavigationFacts(actionResult) {
      var resultFacts = ownValue(actionResult, 'result', null);
      var derivedFacts = ownValue(actionResult, 'derivedFacts', null);
      return ownValue(resultFacts, 'navigation', null) || ownValue(derivedFacts, 'navigation', null) || null;
    }
    function waitTabLoaded(tabId, waitStable, options, execution, actionResult) {
      if (waitStable === false) return Promise.resolve(true);
      var navigation = actionNavigationFacts(actionResult);
      var configuredStableMs = Number(ownValue(options, 'stableMs', undefined));
      if (!isFinite(configuredStableMs) || configuredStableMs < 0) configuredStableMs = 800;
      var timeoutMs = Number(ownValue(options, 'timeoutMs', 0)) || 300000;
      var waitInput = {
        tabId: tabId,
        timeoutMs: timeoutMs,
        stableMs: configuredStableMs,
        readyState: 'complete',
        internalLifecycleWait: true,
        onProgress: function (progress) {
          progress = progress || {};
          var checks = progress.loadChecks || {};
          logForExecution(execution, '内部导航加载检查中: tabId=' + tabId
            + ' elapsed=' + (Number(progress.elapsedMs) || 0) + 'ms'
            + ' status=' + String(checks.tabStatus || 'unknown')
            + ' readyState=' + String(checks.readyState || 'unknown')
            + ' loader=' + String(checks.loaderId || 'unknown')
            + ' pendingUrl=' + String(checks.pendingUrl || '')
            + ' loadEvidence=' + String(checks.hasLoadEvidence === true ? (checks.loadEvidence || 'yes') : 'no')
            + ' stable=' + (checks.observationStable === true ? 'yes' : 'no'), { level: 'info' });
        },
      };
      if (navigation) {
        var expectedLoaderId = String(ownValue(navigation, 'loaderId', ''));
        var previousLoaderId = String(ownValue(navigation, 'previousLoaderId', ''));
        if (expectedLoaderId) defineOwn(waitInput, 'expectedLoaderId', expectedLoaderId);
        if (!expectedLoaderId && previousLoaderId && ownValue(navigation, 'sameDocument', false) !== true) {
          defineOwn(waitInput, 'previousLoaderId', previousLoaderId);
          defineOwn(waitInput, 'requireNewDocument', true);
        }
      }
      var readinessOption = ownValue(options, 'readiness', undefined);
      var startedMs = Date.now();
      var foreground = foregroundRequested(options) ? tabRuntime.foregroundTabForAutomation(tabId) : Promise.resolve(tabId);
      return foreground.then(function () {
        // Load completion is followed by a short advisory DOM quiet window.
        // Network idle remains opt-in in the runtime's default policy.
        return raceWithStop(executePageCommand('waitForPageLoad', waitInput, execution));
      }).then(function (loaded) {
        var readinessInput = { tabId: tabId, deadline: startedMs + timeoutMs };
        if (readinessOption !== undefined) defineOwn(readinessInput, 'readiness', readinessOption);
        return raceWithStop(executePageCommand('waitForReadiness', readinessInput, execution)).then(function (readiness) {
          var report = ownValue(readiness, 'report', null);
          if (report && ownValue(report, 'ready', false) === true) logForExecution(execution, '页面就绪: ' + String(ownValue(report, 'summary', '') || ownValue(report, 'reason', '')));
          return loaded;
        }).catch(function (error) {
          if (String(error && error.code || '') !== 'PAGE_READINESS_TIMEOUT') throw error;
          logForExecution(execution, '页面通用就绪等待超时，按 warning 继续: ' + String(error && error.message || error), { level: 'warn' });
          return loaded;
        });
      });
    }
    function normalizeMaxReuseMs(options) {
      var rawMs = Number(ownValue(options, 'maxReuseMs', 0));
      if (isFinite(rawMs) && rawMs > 0) return Math.floor(rawMs);
      var minutes = Number(ownValue(options, 'maxReuseMinutes', 0));
      return isFinite(minutes) && minutes > 0 ? Math.floor(minutes * 60000) : 0;
    }
    function openPage(pageId, rawOptions, execution) {
      var operationGeneration = lifecycleGeneration;
      var options = copyOwn(rawOptions);
      var page = getPage(pageId);
      var url = ownValue(options, 'urlOverride', '') || ownValue(page, 'url', '');
      var source = pageSource(pageId);
      var forceReopen = ownValue(options, 'forceReopen', false) === true;
      var fixedNew = ownValue(options, 'openMode', '') === 'attach';
      logForExecution(execution, '准备页面: ' + pageId + ' → ' + preview(url, 120));
      var adopted = fixedNew ? Promise.resolve(null) : adoptOrGetTabId(source);
      return adopted.then(function () {
        if (fixedNew) logForExecution(execution, '打开方式为固定新开标签页: ' + pageId + '，不认领已有页面');
        return reuseOrCreateTab(source, url, {
          forceNew: fixedNew,
          forceNavigate: forceReopen,
          forceReopen: forceReopen,
          maxReuseMs: fixedNew ? 0 : normalizeMaxReuseMs(options),
          foreground: foregroundRequested(options),
          reveal: ownValue(options, 'reveal', false) === true,
          returnDetails: true,
        });
      }).then(function (tabResult) {
        var tabId = positiveTabId(ownValue(tabResult, 'tabId', tabResult));
        var actionResult = ownValue(tabResult, 'actionResult', null);
        var activationResult = ownValue(tabResult, 'activationResult', null);
        var activation = activationResult
          ? Promise.resolve(activationResult)
          : executePageCommand('activateTab', {
            tabId: tabId,
            focusWindow: foregroundRequested(options),
          }, execution);
        return activation.then(function (result) {
          activationResult = result;
          logForExecution(execution, '页面标签已激活: ' + pageId + ' tabId=' + tabId + '，等待加载稳定');
          return waitTabLoaded(tabId, ownValue(options, 'waitStable', undefined), options, execution, actionResult);
        }).then(function () {
          rememberPageRuntimeTarget(pageId, tabId, { url: url, source: source }, operationGeneration);
          logForExecution(execution, '统一页面引擎目标就绪: ' + pageId + ' tabId=' + tabId);
          return {
            tabId: tabId,
            url: url,
            created: ownValue(tabResult, 'created', false) === true,
            reused: ownValue(tabResult, 'reused', false) === true,
            actionReceipt: actionResult && actionResult.receipt || null,
            activationReceipt: activationResult && activationResult.receipt || null,
          };
        });
      });
    }
    function refreshPage(pageId, rawOptions, execution) {
      var operationGeneration = lifecycleGeneration;
      var options = copyOwn(rawOptions);
      logForExecution(execution, '准备刷新页面: ' + pageId);
      var resolveTab = pageId
        ? ensurePageReady(pageId, execution)
        : requireRuntimeTabId(options, 'refreshPage');
      return resolveTab.then(function (tabId) {
        var source = runtimeTargetSource(pageId, tabId);
        var actionResult;
        return executePageCommand('reload', Object.assign({}, options, { tabId: tabId }), execution)
          .then(function (result) { actionResult = result; return waitTabLoaded(tabId, ownValue(options, 'waitStable', undefined), options, execution, actionResult); })
          .then(function () {
            rememberPageRuntimeTarget(pageId, tabId, { source: source }, operationGeneration);
            return Object.assign({ tabId: tabId }, actionResult || {});
          });
      });
    }
    function resolveNavigationUrl(url, currentUrl) {
      var target = String(url === undefined || url === null ? '' : url).trim();
      if (!target) throw new Error('跳转节点缺少目标 URL');
      try {
        return new URL(target).href;
      } catch (_) {}
      var base = String(currentUrl || '').trim();
      if (!base) throw new Error('相对 URL 缺少可用的当前页面地址: ' + target);
      try {
        return new URL(target, base).href;
      } catch (_) {
        throw new Error('无法基于当前页面解析相对 URL: ' + target + '（当前页面: ' + base + '）');
      }
    }
    function navigatePage(pageId, url, rawOptions, execution) {
      var operationGeneration = lifecycleGeneration;
      var options = copyOwn(rawOptions);
      if (!url) throw new Error('跳转节点缺少目标 URL');
      logForExecution(execution, '准备跳转标签页: ' + pageId + ' → ' + preview(url, 120));
      var resolveTab = pageId
        ? ensurePageReady(pageId, execution)
        : requireRuntimeTabId(options, 'navigate');
      return resolveTab.then(function (tabId) {
        return tabsGet(tabId).then(function (tab) {
          var resolvedUrl = resolveNavigationUrl(url, ownValue(tab, 'url', ''));
          if (resolvedUrl !== url) logForExecution(execution, '已按当前页面解析跳转地址: ' + preview(resolvedUrl, 120));
          return executePageCommand('navigate', Object.assign({}, options, { tabId: tabId, url: resolvedUrl }), execution).then(function (actionResult) {
            return { tabId: tabId, url: resolvedUrl, actionResult: actionResult };
          });
        });
      }).then(function (navigation) {
        var tabId = navigation.tabId;
        var resolvedUrl = navigation.url;
        var source = runtimeTargetSource(pageId, tabId);
        return waitTabLoaded(tabId, ownValue(options, 'waitStable', undefined), options, execution, navigation.actionResult)
          .then(function () {
            rememberPageRuntimeTarget(pageId, tabId, { url: resolvedUrl, source: source }, operationGeneration);
            return Object.assign({ tabId: tabId, url: resolvedUrl }, navigation.actionResult || {});
          });
      });
    }
    function ensurePageReady(pageId, execution) {
      var operationGeneration = lifecycleGeneration;
      var source = pageSource(pageId);
      var page = getPage(pageId);
      var existing = ownValue(readyPromises, source, null);
      if (existing) return existing;
      function ensureDriver(tabId) {
        // A remembered or newly adopted historical tab may not be the active
        // tab anymore. Activate only the tab; focusWindow=false preserves the
        // background automation policy.
        return executePageCommand('activateTab', {
          tabId: tabId,
          focusWindow: false,
        }, execution).then(function () {
          return tabId;
        });
      }
      var readyPromise = getRememberedPageTabId(pageId).then(function (tabId) {
        if (operationGeneration !== lifecycleGeneration) return 0;
        return tabId || adoptOrGetTabId(source);
      }).then(function (tabId) {
        if (operationGeneration !== lifecycleGeneration) return 0;
        if (tabId) return ensureDriver(tabId);
        return findClaimablePageTab(page, source, execution).then(function (tab) {
          if (operationGeneration !== lifecycleGeneration) return 0;
          var claimedId = ownValue(tab, 'id', 0) || 0;
          if (claimedId) {
            logForExecution(execution, '认领已打开标签页: ' + pageId + ' tabId=' + claimedId + '，保留当前 URL: ' + preview(ownValue(tab, 'url', ''), 120));
            return ensureDriver(claimedId);
          }
          return openPage(pageId, {}, execution).then(function (result) { return ownValue(result, 'tabId', 0); });
        });
      }).then(function (tabId) {
        if (operationGeneration === lifecycleGeneration) {
          rememberPageRuntimeTarget(pageId, tabId, { source: source }, operationGeneration);
          if (ownValue(readyPromises, source, null) === readyPromise) delete readyPromises[source];
        }
        return tabId;
      }, function (error) {
        if (operationGeneration === lifecycleGeneration
            && ownValue(readyPromises, source, null) === readyPromise) delete readyPromises[source];
        throw error;
      });
      defineOwn(readyPromises, source, readyPromise);
      return readyPromise;
    }
    function compactRuntimeState() {
      return {
        pageReadyPromises: 0,
        pendingPageReadyPromises: Object.keys(readyPromises).length,
      };
    }

    return Object.freeze({
      resetRuntimeState: resetRuntimeState,
      compactRuntimeState: compactRuntimeState,
      pageSource: pageSource,
      runtimeTargetSource: runtimeTargetSource,
      runtimeTabIdFromParams: runtimeTabIdFromParams,
      requireRuntimeTabId: requireRuntimeTabId,
      getRememberedPageTabId: getRememberedPageTabId,
      foregroundRequested: foregroundRequested,
      mergeNodeForegroundOptions: mergeNodeForegroundOptions,
      raceWithStop: raceWithStop,
      openPage: openPage,
      refreshPage: refreshPage,
      navigatePage: navigatePage,
      ensurePageReady: ensurePageReady,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, createPageLifecycleOps: createPageLifecycleOps });
});
