// MCP Tab Access — tab strategy and tabRuntime adapter for MCP observations/single-node runs.
(function attachMcpTabAccess(root, factory) {
  root.McpTabAccess = factory();
})(globalThis, function () {
  function createMcpTabAccessManager(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var tabRuntime = deps.tabRuntime;
    var pageAutomation = deps.pageAutomation;
    if (!pageAutomation || !pageAutomation.action || typeof pageAutomation.action.act !== 'function'
      || !pageAutomation.perception || typeof pageAutomation.perception.perceive !== 'function'
      || !pageAutomation.verification || typeof pageAutomation.verification.waitForPageLoad !== 'function') {
      throw new Error('McpTabAccess requires PageAutomationRuntime');
    }
    var getConfig = deps.getConfig || (function () { return { pages: {} }; });
    var addLog = deps.addLog || (function () {});
    var pageHostMatchesTab = deps.pageHostMatchesTab || (function () { return false; });
    var isTabClaimedByOther = deps.isTabClaimedByOther || (function () { return false; });
    var normalizeRunTabMode = deps.normalizeRunTabMode;
    var runTabModeLabel = deps.runTabModeLabel;
    var sameUrl = deps.sameUrl;
    var RUN_TAB_MODE_REUSE_OPEN = deps.RUN_TAB_MODE_REUSE_OPEN;
    var RUN_TAB_MODE_FIXED_CURRENT = deps.RUN_TAB_MODE_FIXED_CURRENT;
    var RUN_TAB_MODE_FIXED_NEW = deps.RUN_TAB_MODE_FIXED_NEW;
    var DEFAULT_RUN_TAB_MODE = deps.DEFAULT_RUN_TAB_MODE || RUN_TAB_MODE_REUSE_OPEN;
    var getInitialRunTabMode = deps.getInitialRunTabMode || (function () { return DEFAULT_RUN_TAB_MODE; });
    var onRunTabModeChanged = deps.onRunTabModeChanged || (function () {});
    var fixedTabId = 0;

    function errorMessage(error) {
      return String(error && error.message || error || '');
    }
    function isMissingTabError(error) {
      return /(?:No tab with id|Invalid tab ID|tab(?:\s+|-)not found|no such tab)/i.test(errorMessage(error));
    }

    function executeLifecycleAction(tabId, kind, input, options) {
      options = options || {};
      return pageAutomation.action.act({
        source: 'flow',
        owner: 'MCP',
        tabId: tabId,
        kind: kind,
        input: input || {},
        timeoutMs: Number(options.timeoutMs) || 30000,
      }).then(function (result) {
        var receipt = result && result.receipt;
        if (!receipt || receipt.status === 'failed') {
          var error = new Error(receipt && receipt.verification && receipt.verification.reason || kind + ' 失败');
          error.code = result && result.error && result.error.code || 'PAGE_ACTION_FAILED';
          error.receipt = receipt || null;
          throw error;
        }
        if (receipt.status === 'unconfirmed') {
          var labels = { reload: '重载', navigate: '跳转', activateTab: '激活', createTab: '创建', closeTab: '关闭' };
          addLog('MCP 页面' + (labels[kind] || kind) + '命令已送达但结果尚未确认 (tabId=' + tabId + '): '
            + String(receipt.verification && receipt.verification.reason || ''), { level: 'warn', scope: 'mcp', tabId: tabId });
        }
        return result;
      });
    }

    function pageLoadNavigation(actionResult) {
      var resultFacts = actionResult && actionResult.result;
      var derivedFacts = actionResult && actionResult.derivedFacts;
      return resultFacts && resultFacts.navigation || derivedFacts && derivedFacts.navigation || null;
    }

    function waitForUnifiedPageLoad(tabId, options, actionResult) {
      options = options || {};
      var configuredStableMs = Number(options.stableMs);
      if (!isFinite(configuredStableMs) || configuredStableMs < 0) configuredStableMs = 800;
      var input = {
        tabId: tabId,
        kind: 'waitForPageLoad',
        timeoutMs: Number(options.timeoutMs) || 300000,
        stableMs: configuredStableMs,
        readyState: String(options.readyState || 'complete'),
      };
      var navigation = pageLoadNavigation(actionResult);
      var expectedLoaderId = String(navigation && navigation.loaderId || '');
      var previousLoaderId = String(navigation && navigation.previousLoaderId || '');
      if (expectedLoaderId) input.expectedLoaderId = expectedLoaderId;
      if (!expectedLoaderId && previousLoaderId && navigation.sameDocument !== true) {
        input.previousLoaderId = previousLoaderId;
        input.requireNewDocument = true;
      }
      return pageAutomation.verification.waitForPageLoad({
        source: 'flow', tabId: tabId, params: input,
      });
    }

    function activateTab(tabId, focusWindow) {
      return executeLifecycleAction(tabId, 'activateTab', { focusWindow: focusWindow === true }, {}).then(function (result) {
        return new Promise(function (resolve) { setTimeout(function () { resolve({ tabId: tabId, actionResult: result }); }, 150); });
      });
    }

    function recoverDiscardedTab(tabId) {
      return chrome.tabs.get(tabId).then(function (tab) {
        if (!tab || !tab.id || !tab.discarded) return tab;
        var deadline = Date.now() + 30000;
        return chrome.tabs.reload(tabId).then(function waitRestored() {
          return chrome.tabs.get(tabId).then(function (currentTab) {
            if (currentTab && currentTab.id && !currentTab.discarded) return currentTab;
            if (Date.now() >= deadline) throw new Error('恢复被丢弃的目标 Tab 超时: tabId=' + tabId);
            return new Promise(function (resolve) { setTimeout(resolve, 100); }).then(waitRestored);
          });
        }).then(function (currentTab) {
          return waitForUnifiedPageLoad(tabId, { timeoutMs: 300000, stableMs: 800 }, null).then(function () {
            return currentTab;
          });
        });
      });
    }

    function createTab(properties, options) {
      return executeLifecycleAction(0, 'createTab', properties || {}, options || {}).then(function (result) {
        var tab = result.derivedFacts && result.derivedFacts.createdTab;
        if (!tab || !(Number(tab.id) > 0)) throw new Error('MCP 统一页面动作引擎未返回新建标签页');
        return Object.assign({}, tab, { actionResult: result });
      });
    }

    function normalizeTabMaxReuseMs(options) {
      options = options || {};
      var rawMs = Number(options.maxReuseMs);
      if (isFinite(rawMs) && rawMs > 0) return Math.floor(rawMs);
      var rawMinutes = Number(options.maxReuseMinutes);
      if (!isFinite(rawMinutes) || rawMinutes <= 0) return 0;
      return Math.floor(rawMinutes * 60 * 1000);
    }

    function closeTabQuietly(source, tabId, reason) {
      if (!tabId) return Promise.resolve();
      return executeLifecycleAction(tabId, 'closeTab', {}, {}).then(function () {
        try { tabRuntime.unregisterTab(source); } catch (_) {}
        if (fixedTabId === tabId) fixedTabId = 0;
        addLog('MCP 已关闭旧标签页以释放页面运行态 (tabId=' + tabId + (reason ? ', ' + reason : '') + ')', { scope: 'mcp', tabId: tabId });
      });
    }

    function waitForTabAvailable(tabId, reason) {
      if (!isTabClaimedByOther(null, tabId)) return Promise.resolve(tabId);
      addLog('MCP 等待运行标签页释放 (tabId=' + tabId + (reason ? ', ' + reason : '') + ')', { scope: 'mcp', tabId: tabId });
      return new Promise(function (resolve) {
        function poll() {
          if (!isTabClaimedByOther(null, tabId)) {
            addLog('MCP 继续使用已释放标签页 (tabId=' + tabId + ')', { scope: 'mcp', tabId: tabId });
            resolve(tabId);
            return;
          }
          setTimeout(poll, 500);
        }
        setTimeout(poll, 500);
      });
    }

    function shouldNavigateTab(tab, url, options) {
      options = options || {};
      if (!url) return false;
      if (options.forceNavigate === true) return true;
      if (options.forceReopen === true) return true;
      if (options.preserveIfHostMatches && pageHostMatchesTab(options.matchPage, options.source, tab)) return false;
      if (options.forceReopen === false || options.reused === true) return !sameUrl(tab && tab.url, url);
      return options.navigate === true;
    }

    function focusAndRegisterTab(source, tabId, url, mode, label, navOptions) {
      navOptions = (typeof navOptions === 'boolean') ? { forceNavigate: navOptions } : (navOptions || {});
      return waitForTabAvailable(tabId, label).then(function () {
        return chrome.tabs.get(tabId);
      }).then(function (tab) {
        var navigate = shouldNavigateTab(tab, url, navOptions);
        var foreground = navOptions.focusWindow === true
          || navOptions.foreground === true
          || navOptions.requiresForeground === true;
        var activationResult = null;
        var update = activateTab(tabId, false).then(function (activation) {
          activationResult = activation && activation.actionResult || null;
          return recoverDiscardedTab(tabId);
        });
        var actionResult = navOptions.createdActionResult || null;
        if (navigate && url && navOptions.forceReopen === true && sameUrl(tab && tab.url, url)) {
          update = update.then(function () { return executeLifecycleAction(tabId, 'reload', {}, navOptions); }).then(function (result) {
            actionResult = result;
            return tab;
          });
        } else if (navigate && url) {
          update = update.then(function () { return executeLifecycleAction(tabId, 'navigate', { url: url }, navOptions); }).then(function (result) {
            actionResult = result;
            return tab;
          });
        }
        return update.then(function () {
          return waitForUnifiedPageLoad(tabId, { timeoutMs: 300000, stableMs: 800 }, actionResult);
        }).then(function () {
          tabRuntime.registerTab(source, tabId);
          var preserveHint = (!navigate && (/复用|继续使用/.test(label || ''))) ? '（保留当前页面）' : '';
          addLog('MCP 标签策略 ' + runTabModeLabel(mode) + ': ' + label + ' tabId=' + tabId + preserveHint, { scope: 'mcp', tabId: tabId });
          return foreground ? activateTab(tabId, true) : { tabId: tabId, actionResult: activationResult };
        }).then(function (activation) {
          return navOptions.returnDetails === true
            ? { tabId: tabId, created: !!navOptions.createdActionResult, reused: !navOptions.createdActionResult, actionResult: actionResult, activationResult: activation && activation.actionResult || null }
            : tabId;
        });
      });
    }

    function findReusablePageTab(page, source) {
      return chrome.tabs.query({}).then(function (tabs) {
        var firstBusy = null;
        for (var i = 0; i < tabs.length; i++) {
          var tab = tabs[i];
          if (!pageHostMatchesTab(page, source, tab)) continue;
          if (!isTabClaimedByOther(null, tab.id)) return { tab: tab, busy: false };
          if (!firstBusy) firstBusy = tab;
        }
        return firstBusy ? { tab: firstBusy, busy: true } : null;
      });
    }

    function getCurrentTab() {
      return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
        return tabs && tabs[0] ? tabs[0] : null;
      });
    }

    function ensurePageTab(pageId, options) {
      options = options || {};
      var source = 'page:' + pageId;
      var config = getConfig() || {};
      var page = config.pages && config.pages[pageId];
      if (!page) return Promise.reject(new Error('页面配置不存在: ' + pageId));
      var mode = normalizeRunTabMode(options.runTabMode || getInitialRunTabMode(), DEFAULT_RUN_TAB_MODE);
      var targetUrl = options.urlOverride || page.url;
      var matchPage = Object.assign({}, page, { url: targetUrl });
      var forceNavigate = options.forceNavigate === true;
      var forceReopen = options.forceReopen;
      var maxReuseMs = normalizeTabMaxReuseMs(options);
      var reuseNavOptions = {
        forceNavigate: forceNavigate,
        forceReopen: forceReopen,
        reused: true,
        preserveIfHostMatches: true,
        matchPage: matchPage,
        source: source,
        foreground: options.foreground === true,
        returnDetails: options.returnDetails === true,
      };
      function shouldReopenRegisteredTab(tabId) {
        return mode !== RUN_TAB_MODE_FIXED_CURRENT
          && maxReuseMs > 0
          && tabRuntime.shouldReopenTab
          && tabRuntime.shouldReopenTab(source, tabId, maxReuseMs);
      }
      function createFreshTab(label) {
        return createTab({ url: targetUrl, active: options.foreground === true }, options).then(function (tab) {
          if (!tab || !tab.id) throw new Error('MCP 创建标签页失败');
          return focusAndRegisterTab(source, tab.id, targetUrl, mode, label || '标签页超龄重开', { navigate: false, foreground: options.foreground === true, returnDetails: options.returnDetails === true, createdActionResult: tab.actionResult });
        });
      }

      return Promise.resolve().then(function () {
        if (options.forceNew === true) {
          return createFreshTab('固定新开标签页');
        }

        if (mode === RUN_TAB_MODE_FIXED_CURRENT) {
          return getCurrentTab().then(function (tab) {
            if (!tab || !tab.id) throw new Error('MCP 标签策略为「固定当前标签」，但没有可用的当前标签页');
            return focusAndRegisterTab(source, tab.id, targetUrl, mode, '固定当前标签', reuseNavOptions);
          });
        }

        if (mode === RUN_TAB_MODE_FIXED_NEW) {
          function createFixedTab() {
            return createTab({ url: targetUrl, active: options.foreground === true }, options).then(function (tab) {
              if (!tab || !tab.id) throw new Error('MCP 创建固定标签页失败');
              fixedTabId = tab.id;
              return focusAndRegisterTab(source, tab.id, targetUrl, mode, '固定打开标签', { navigate: false, foreground: options.foreground === true, returnDetails: options.returnDetails === true, createdActionResult: tab.actionResult });
            });
          }
          if (fixedTabId) {
            return chrome.tabs.get(fixedTabId).then(function () {
              if (shouldReopenRegisteredTab(fixedTabId)) {
                return closeTabQuietly(source, fixedTabId, 'maxReuseMs=' + maxReuseMs).then(createFixedTab);
              }
              return focusAndRegisterTab(source, fixedTabId, targetUrl, mode, '固定打开标签', reuseNavOptions);
            }, function (error) {
              if (!isMissingTabError(error)) throw error;
              fixedTabId = 0;
              return createFixedTab();
            });
          }
          return createFixedTab();
        }

        return tabRuntime.adoptOrGetTabId(source).then(function (tabId) {
          if (tabId) {
            if (shouldReopenRegisteredTab(tabId)) {
              return closeTabQuietly(source, tabId, 'maxReuseMs=' + maxReuseMs).then(function () {
                return createFreshTab('标签页超龄重开');
              });
            }
            return focusAndRegisterTab(source, tabId, targetUrl, mode, '继续使用已登记标签', reuseNavOptions);
          }
          return findReusablePageTab(matchPage, source).then(function (match) {
            if (match && match.tab) {
              return focusAndRegisterTab(source, match.tab.id, targetUrl, mode, '复用已打开标签', reuseNavOptions);
            }
            return createTab({ url: targetUrl, active: options.foreground === true }, options).then(function (tab) {
              if (!tab || !tab.id) throw new Error('MCP 创建标签页失败');
              return focusAndRegisterTab(source, tab.id, targetUrl, mode, '新建标签页', { navigate: false, foreground: options.foreground === true, returnDetails: options.returnDetails === true, createdActionResult: tab.actionResult });
            });
          });
        });
      });
    }

    function pageIdFromPageSource(source) {
      if (typeof source !== 'string' || source.indexOf('page:') !== 0) return '';
      return source.slice(5);
    }

    function createTabAccess(runTabModeOverride) {
      var localMode = normalizeRunTabMode(runTabModeOverride || getInitialRunTabMode(), DEFAULT_RUN_TAB_MODE);

      function ensureSource(source, url, options) {
        options = options || {};
        var pageId = pageIdFromPageSource(source);
        if (!pageId) return Promise.resolve(null);
        return ensurePageTab(pageId, { runTabMode: localMode, urlOverride: url || '', foreground: options.foreground === true });
      }

      return Object.assign({}, tabRuntime, {
        adoptOrGetTabId: function (source, options) {
          options = options || {};
          var pageId = pageIdFromPageSource(source);
          if (pageId && localMode !== RUN_TAB_MODE_REUSE_OPEN) return ensureSource(source, '', options);
          return tabRuntime.adoptOrGetTabId(source, options);
        },
        reuseOrCreateTab: function (source, url, options) {
          options = options || {};
          var pageId = pageIdFromPageSource(source);
          var tabPromise = pageId
            ? ensurePageTab(pageId, { runTabMode: localMode, urlOverride: url || '', forceNew: options.forceNew === true, forceNavigate: options.forceNavigate === true, forceReopen: options.forceReopen, maxReuseMs: options.maxReuseMs, maxReuseMinutes: options.maxReuseMinutes, foreground: options.foreground === true, returnDetails: options.returnDetails === true })
            : tabRuntime.reuseOrCreateTab(source, url, options);
          return tabPromise;
        },
        getRunTabMode: function () {
          return { runTabMode: localMode, label: runTabModeLabel(localMode) };
        },
        setRunTabMode: function (mode) {
          localMode = normalizeRunTabMode(mode, DEFAULT_RUN_TAB_MODE);
          if (localMode !== RUN_TAB_MODE_FIXED_NEW) fixedTabId = 0;
          onRunTabModeChanged(localMode);
          addLog('MCP 单步标签策略切换为: ' + runTabModeLabel(localMode), { scope: 'mcp' });
          return { runTabMode: localMode, label: runTabModeLabel(localMode) };
        },
      });
    }

    function clearFixedTabIfModeNotFixed(mode) {
      if (mode !== RUN_TAB_MODE_FIXED_NEW) fixedTabId = 0;
    }

    return {
      ensurePageTab: ensurePageTab,
      getPageTabForDebug: ensurePageTab,
      createTabAccess: createTabAccess,
      activateTab: activateTab,
      clearFixedTabIfModeNotFixed: clearFixedTabIfModeNotFixed,
    };
  }

  return { createMcpTabAccessManager: createMcpTabAccessManager };
});
