// Tab lifecycle registry. Page perception/action/verification never execute in Content Scripts.
(function attachTabRuntime(root, factory) {
  'use strict';
  root.TabRuntime = factory();
})(globalThis, function () {
  'use strict';

  function createTabRuntime(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var getState = deps.getState || (function () { return {}; });
    var setState = deps.setState || (function () {});
    var addLog = deps.addLog || (function () {});
    var resolveCanonicalSource = deps.resolveCanonicalSource || (function (source) { return source; });
    var matchesSourceUrlFamily = deps.matchesSourceUrlFamily || (function () { return false; });
    var getPageAutomation = deps.getPageAutomation || (function () { return deps.pageAutomation || null; });

    function errorMessage(error) {
      return String(error && error.message || error || '');
    }
    function isMissingTabError(error) {
      return /(?:No tab with id|Invalid tab ID|tab(?:\s+|-)not found|no such tab)/i.test(errorMessage(error));
    }

    function sameUrl(left, right) {
      try { return !!left && !!right && new URL(String(left)).href === new URL(String(right)).href; }
      catch (_) { return String(left || '') === String(right || ''); }
    }
    function readSharedState() { var state = getState() || {}; return state.sharedState || {}; }
    function updateSharedState(patch) {
      var shared = Object.assign({}, readSharedState(), patch || {});
      setState({ sharedState: shared });
    }
    function getAutomationWindowId() { return Number(readSharedState().automationWindowId) || 0; }
    function setAutomationWindowId(windowId) { updateSharedState({ automationWindowId: Number(windowId) || 0 }); }
    function readTabMeta(canonical) { return (readSharedState().tabRegistryMeta || {})[canonical] || null; }
    function writeTabMeta(canonical, tabId, meta) {
      var shared = readSharedState();
      var all = Object.assign({}, shared.tabRegistryMeta || {});
      var previous = all[canonical] || {};
      var now = Date.now();
      all[canonical] = { tabId: tabId, openedAt: meta && meta.openedAt || previous.tabId === tabId && previous.openedAt || now, updatedAt: now };
      updateSharedState({ tabRegistryMeta: all });
    }
    function getRegisteredTabAgeMs(source, tabId) {
      var meta = readTabMeta(resolveCanonicalSource(source));
      if (!meta || tabId && Number(meta.tabId) !== Number(tabId) || !meta.openedAt) return 0;
      return Math.max(0, Date.now() - Number(meta.openedAt));
    }
    function shouldReopenTab(source, tabId, maxReuseMs) {
      maxReuseMs = Number(maxReuseMs) || 0;
      return maxReuseMs > 0 && getRegisteredTabAgeMs(source, tabId) >= maxReuseMs;
    }
    function registerTab(source, tabId, meta) {
      var canonical = resolveCanonicalSource(source);
      tabId = Math.floor(Number(tabId));
      if (!(tabId > 0)) return false;
      var shared = readSharedState();
      var registry = Object.assign({}, shared.tabRegistry || {});
      var previous = registry[canonical];
      if (previous && previous !== tabId) delete registry['__reverse_' + previous];
      registry[canonical] = tabId;
      registry['__reverse_' + tabId] = canonical;
      updateSharedState({ tabRegistry: registry });
      writeTabMeta(canonical, tabId, meta || {});
      addLog('Tab 已注册: source=' + canonical + ' tabId=' + tabId, { source: canonical, tabId: tabId });
      return true;
    }
    function getTabId(source) { return (readSharedState().tabRegistry || {})[resolveCanonicalSource(source)] || null; }
    function getSourceByTabId(tabId) { return (readSharedState().tabRegistry || {})['__reverse_' + Number(tabId)] || null; }
    function unregisterTab(source) {
      var canonical = resolveCanonicalSource(source);
      var shared = readSharedState();
      var registry = Object.assign({}, shared.tabRegistry || {});
      var meta = Object.assign({}, shared.tabRegistryMeta || {});
      var tabId = registry[canonical];
      delete registry[canonical];
      if (tabId) delete registry['__reverse_' + tabId];
      delete meta[canonical];
      updateSharedState({ tabRegistry: registry, tabRegistryMeta: meta });
    }
    function isTabAlive(source) {
      var tabId = getTabId(source);
      return tabId ? chrome.tabs.get(tabId).then(function () { return true; }, function (error) {
        if (isMissingTabError(error)) return false;
        throw error;
      }) : Promise.resolve(false);
    }
    function createAutomationTab(properties) {
      var props = Object.assign({}, properties || {});
      var windowId = getAutomationWindowId();
      if (windowId && !props.windowId) props.windowId = windowId;
      return pageLifecycleAction(0, 'createTab', props).then(function (actionResult) {
        var tab = actionResult.derivedFacts && actionResult.derivedFacts.createdTab;
        if (!tab || !(Number(tab.id) > 0)) throw new Error('统一页面动作引擎未返回新建标签页');
        if (!windowId && tab.windowId) setAutomationWindowId(tab.windowId);
        addLog('已创建自动化 Tab: ' + tab.id + ' url=' + (props.url || '(empty)'), { tabId: tab.id });
        return Object.assign({}, tab, { actionReceipt: actionResult.receipt, actionResult: actionResult });
      });
    }
    function activateTabForAutomation(tabId, focusWindow) {
      tabId = Number(tabId);
      if (!(tabId > 0)) return Promise.resolve(null);
      return pageLifecycleAction(tabId, 'activateTab', { focusWindow: focusWindow === true });
    }
    function foregroundTabForAutomation(tabId, options) {
      options = options || {};
      tabId = Number(tabId);
      if (!(tabId > 0)) return Promise.resolve(tabId);
      return activateTabForAutomation(tabId, true).then(function () { return tabId; });
    }
    function pageLifecycleAction(tabId, kind, input) {
      var runtime = getPageAutomation();
      if (!runtime || !runtime.action || typeof runtime.action.act !== 'function') return Promise.reject(new Error('统一页面动作引擎尚未就绪'));
      return runtime.action.act({ source: 'flow', tabId: tabId, kind: kind, input: input || {}, timeoutMs: 30000 }).then(function (result) {
        if (result.receipt.status === 'failed') {
          var error = new Error(result.receipt.verification && result.receipt.verification.reason || kind + ' 失败');
          error.receipt = result.receipt;
          throw error;
        }
        return result;
      });
    }
    function closeTabQuietly(tabId) { return pageLifecycleAction(tabId, 'closeTab', {}).catch(function () {}); }
    function closeTabForReplacement(tabId) { return pageLifecycleAction(tabId, 'closeTab', {}); }
    function reuseOrCreateTab(source, url, options) {
      options = options || {};
      var canonical = resolveCanonicalSource(source);
      var foreground = options.focusWindow === true
        || options.foreground === true
        || options.requiresForeground === true;
      var existing = options.forceNew === true ? 0 : getTabId(canonical);
      function output(tabId, details) {
        return options.returnDetails === true ? Object.assign({ tabId: tabId }, details || {}) : tabId;
      }
      function create() {
        return createAutomationTab({ url: url || undefined, active: false }).then(function (tab) {
          return activateTabForAutomation(tab.id, false).then(function (activationResult) {
            registerTab(canonical, tab.id);
            if (foreground) {
              return activateTabForAutomation(tab.id, true).then(function (focusedActivation) {
                return output(tab.id, { created: true, reused: false, actionResult: tab.actionResult, activationResult: focusedActivation });
              });
            }
            return output(tab.id, { created: true, reused: false, actionResult: tab.actionResult, activationResult: activationResult });
          });
        });
      }
      if (!existing) return create();
      if (shouldReopenTab(canonical, existing, options.maxReuseMs)) {
        return closeTabForReplacement(existing).then(function () {
          unregisterTab(canonical);
          return create();
        });
      }
      return chrome.tabs.get(existing).then(function (tab) {
        return activateTabForAutomation(existing, false).then(function (activationResult) {
          var operation = Promise.resolve();
          if (url && options.forceReopen === true && sameUrl(tab.url, url)) operation = pageLifecycleAction(existing, 'reload', {});
          else if (url && (options.forceNavigate === true || !sameUrl(tab.url, url))) operation = pageLifecycleAction(existing, 'navigate', { url: url });
          return operation.then(function (actionResult) {
            var finalActivation = foreground ? activateTabForAutomation(existing, true) : Promise.resolve(activationResult);
            return finalActivation.then(function (focusedActivation) {
              return output(existing, { created: false, reused: true, actionResult: actionResult || null, activationResult: focusedActivation });
            });
          });
        });
      }, function (error) {
        if (!isMissingTabError(error)) throw error;
        unregisterTab(canonical);
        return create();
      });
    }
    function rememberSourceLastUrl(source, url) {
      var canonical = resolveCanonicalSource(source);
      var shared = readSharedState();
      var values = Object.assign({}, shared.sourceLastUrls || {});
      values[canonical] = String(url || '');
      updateSharedState({ sourceLastUrls: values });
    }
    function adoptOrGetTabId(source, options) {
      options = options || {};
      var canonical = resolveCanonicalSource(source);
      var existing = getTabId(canonical);
      var windowId = Number(options.windowId) || 0;
      var check = existing ? chrome.tabs.get(existing).then(function (tab) { return !windowId || tab.windowId === windowId ? existing : 0; }, function (error) {
        if (isMissingTabError(error)) return 0;
        throw error;
      }) : Promise.resolve(0);
      return check.then(function (alive) {
        if (alive) return alive;
        if (existing) unregisterTab(canonical);
        return chrome.tabs.query(windowId ? { windowId: windowId } : {}).then(function (tabs) {
          for (var index = 0; index < tabs.length; index += 1) {
            if (tabs[index].url && matchesSourceUrlFamily(canonical, tabs[index].url)) {
              registerTab(canonical, tabs[index].id);
              return tabs[index].id;
            }
          }
          return null;
        });
      });
    }
    function closeTabsByUrlPrefix(prefix) {
      return chrome.tabs.query({}).then(function (tabs) {
        return Promise.all(tabs.filter(function (tab) { return tab.url && tab.url.indexOf(prefix) === 0; }).map(function (tab) { return closeTabQuietly(tab.id); }));
      });
    }
    function closeConflictingTabsForSource(source) {
      var canonical = resolveCanonicalSource(source);
      var current = getTabId(canonical);
      return chrome.tabs.query({}).then(function (tabs) {
        return Promise.all(tabs.filter(function (tab) { return tab.id !== current && tab.url && matchesSourceUrlFamily(canonical, tab.url); }).map(function (tab) { return closeTabQuietly(tab.id); }));
      });
    }

    return {
      getAutomationWindowId: getAutomationWindowId,
      setAutomationWindowId: setAutomationWindowId,
      registerTab: registerTab,
      getTabId: getTabId,
      getSourceByTabId: getSourceByTabId,
      getRegisteredTabAgeMs: getRegisteredTabAgeMs,
      shouldReopenTab: shouldReopenTab,
      isTabAlive: isTabAlive,
      unregisterTab: unregisterTab,
      createAutomationTab: createAutomationTab,
      foregroundTabForAutomation: foregroundTabForAutomation,
      reuseOrCreateTab: reuseOrCreateTab,
      adoptOrGetTabId: adoptOrGetTabId,
      rememberSourceLastUrl: rememberSourceLastUrl,
      closeTabsByUrlPrefix: closeTabsByUrlPrefix,
      closeConflictingTabsForSource: closeConflictingTabsForSource,
    };
  }

  return { createTabRuntime: createTabRuntime };
});
