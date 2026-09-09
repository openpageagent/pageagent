// Session Tab Access — per-run tab ownership, visibility, and CDP keep-alive policy.
(function attachSessionTabAccess(root, factory) {
  root.SessionTabAccess = factory();
})(globalThis, function () {
  function createSessionTabAccessFactory(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var cdpSessionManager = deps.cdpSessionManager;
    if (!cdpSessionManager || typeof cdpSessionManager.acquire !== 'function') throw new Error('SessionTabAccess requires CdpSessionManager');
    var pageAutomation = deps.pageAutomation;
    if (!pageAutomation || !pageAutomation.action || typeof pageAutomation.action.act !== 'function'
      || !pageAutomation.perception || typeof pageAutomation.perception.perceive !== 'function'
      || !pageAutomation.verification || typeof pageAutomation.verification.createFactReceipt !== 'function'
      || typeof pageAutomation.verification.waitForPageLoad !== 'function') {
      throw new Error('SessionTabAccess requires PageAutomationRuntime');
    }
    var getConfig = deps.getConfig || (function () { return { flows: {}, pages: {} }; });
    var pageIdFromSource = deps.pageIdFromSource || (function () { return ''; });
    var hostFromUrl = deps.hostFromUrl || (function () { return ''; });
    var sourceHostMatches = deps.sourceHostMatches || (function () { return false; });
    var sameUrl = deps.sameUrl || (function (a, b) { return a === b; });
    var normalizeRunTabMode = deps.normalizeRunTabMode || (function (mode) { return mode; });
    var runTabModeLabel = deps.runTabModeLabel || (function (mode) { return mode || ''; });
    var isTabClaimedByOther = deps.isTabClaimedByOther || (function () { return false; });
    var claimTab = deps.claimTab || (function (session, source, tabId) {
      session.tabs[source] = tabId;
      return true;
    });
    var promoteSessionOwnerToFirstRunTab = deps.promoteSessionOwnerToFirstRunTab || (function () {});
    var mirrorChildTabUsageToParent = deps.mirrorChildTabUsageToParent || (function () {});
    var broadcastSessions = deps.broadcastSessions || (function () {});
    var RUN_TAB_MODE_REUSE_OPEN = deps.RUN_TAB_MODE_REUSE_OPEN;
    var RUN_TAB_MODE_FIXED_CURRENT = deps.RUN_TAB_MODE_FIXED_CURRENT;
    var RUN_TAB_MODE_FIXED_NEW = deps.RUN_TAB_MODE_FIXED_NEW;

    function errorMessage(error) {
      return String(error && error.message || error || '');
    }
    function isMissingTabError(error) {
      return /(?:No tab with id|Invalid tab ID|tab(?:\s+|-)not found|no such tab)/i.test(errorMessage(error));
    }
    function isMissingWindowError(error) {
      return /(?:No window with id|Invalid window ID|window(?:\s+|-)not found|no such window)/i.test(errorMessage(error));
    }

    function createSessionTabAccess(session, sessionTabRuntime) {
      function lifecycleFactResult(tabId, kind, performed, evidence, reason, startedAt) {
        var completedAt = new Date().toISOString();
        var receipt = pageAutomation.verification.createFactReceipt({
          source: 'flow', tabId: tabId, kind: kind, performed: performed,
          conditionMet: true, signals: [kind], evidence: evidence || [], reason: reason,
          startedAt: startedAt || completedAt, completedAt: completedAt,
          inputProvenance: 'chrome.tabs',
        });
        return { receipt: receipt, actionFacts: receipt.actionFacts, derivedFacts: { tabId: tabId } };
      }

      function executeLifecycleAction(tabId, kind, input, options) {
        options = options || {};
        return pageAutomation.action.act({
          source: 'flow',
          owner: String(session.runId || session.flowId || ''),
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
            session.addLog('页面' + (labels[kind] || kind) + '命令已送达但结果尚未确认 (tabId=' + tabId + '): '
              + String(receipt.verification && receipt.verification.reason || ''), { level: 'warn', scope: 'run', tabId: tabId });
          }
          return result;
        });
      }

      function aliveOrNull(tabId) {
        return chrome.tabs.get(tabId).then(function () { return tabId; }, function (error) {
          if (isMissingTabError(error)) return null;
          throw error;
        });
      }

      // CDP 防节流保活在流程运行期就是“后台稳定模式”：
      // 1. 页面命令只激活目标 tab，不主动聚焦浏览器窗口。
      // 2. debugger attach 在流程期间复用，并在流程结束时统一 detach。
      // 3. 意外断线由 CdpSessionManager 立即重接并重试当前命令。
      function activateTabWithoutFocusingWindow(tabId, knownTab, returnDetails) {
        return Promise.resolve(knownTab || chrome.tabs.get(tabId)).then(function (tab) {
          if (!tab || !tab.id) throw new Error('目标标签页不可用: tabId=' + tabId);
          return executeLifecycleAction(tabId, 'activateTab', { focusWindow: false }, {}).then(function (actionResult) {
            return returnDetails === true ? { tabId: tabId, actionResult: actionResult } : tabId;
          });
        });
      }

      function updateRunTab(tabId, url, options) {
        options = options || {};
        var foreground = options.focusWindow === true
          || options.foreground === true
          || options.requiresForeground === true;
        var actionResult = null;
        var activationResult = null;
        var update = activateTabWithoutFocusingWindow(tabId, null, true).then(function (activated) {
          activationResult = activated.actionResult || null;
          return preparePageCommandTab(tabId, null, {});
        }).then(function () {
          return (options.navigate !== false && url)
            ? executeLifecycleAction(tabId, 'navigate', { url: url }, options)
            : null;
        });
        return update.then(function (result) {
          actionResult = result || lifecycleFactResult(tabId, 'openPage', 'no', [
            { kind: 'existing_tab', tabId: tabId, url: String(url || '') },
          ], '目标标签页已经存在且无需导航');
          return foreground ? focusTabForCommand(tabId, null, true) : prepareOpenedOrNavigatedTab(tabId, null, options);
        }).then(function (prepared) {
          activationResult = prepared && prepared.actionResult || activationResult;
          return { tabId: tabId, actionResult: actionResult, activationResult: activationResult };
        });
      }

      function closeSessionTabQuietly(source, tabId, reason) {
        if (!tabId) return Promise.resolve();
        return executeLifecycleAction(tabId, 'closeTab', {}, {}).then(function () {
          delete session.tabs[source];
          if (session.boundTabId === tabId) session.boundTabId = 0;
          try {
            if (session.keepAliveTabs && session.keepAliveTabs[tabId]) {
              delete session.keepAliveTabs[tabId];
              if (session.keepAliveLeases && session.keepAliveLeases[tabId]) {
                session.keepAliveLeases[tabId].release();
                delete session.keepAliveLeases[tabId];
              }
            }
          } catch (_) {}
          session.addLog('已关闭旧会话标签页以释放页面运行态 (tabId=' + tabId + (reason ? ', ' + reason : '') + ')', { scope: 'run', tabId: tabId });
        });
      }

      function recordTabUsage(source, tab, meta) {
        if (!tab || !tab.id) return;
        meta = meta || {};
        var pageId = pageIdFromSource(source);
        var ts = Date.now();
        var previous = session.tabUsage && session.tabUsage[source];
        var openedAt = meta.reused === true && previous && previous.tabId === tab.id && previous.openedAt
          ? previous.openedAt
          : ts;
        var usage = {
          source: source,
          pageId: pageId,
          tabId: tab.id,
          windowId: tab.windowId || 0,
          host: hostFromUrl(tab.url || meta.url || ''),
          url: tab.url || meta.url || '',
          mode: normalizeRunTabMode(meta.mode || session.runTabMode),
          reused: meta.reused === true,
          openedAt: openedAt,
          updatedAt: ts,
        };
        session.tabUsage = session.tabUsage || {};
        session.tabEvents = session.tabEvents || [];
        session.tabUsage[source] = usage;
        session.tabEvents.push(Object.assign({ ts: ts, action: meta.action || 'open' }, usage));
        if (session.tabEvents.length > 200) session.tabEvents.splice(0, session.tabEvents.length - 200);
        if (!session.parentRunId) {
          promoteSessionOwnerToFirstRunTab(session, usage);
        } else {
          mirrorChildTabUsageToParent(session, source, usage);
        }
        broadcastSessions();
      }

      function waitForTabAvailable(tabId, reason) {
        if (!isTabClaimedByOther(session, tabId)) return Promise.resolve(tabId);
        session.waitingTabs = session.waitingTabs || {};
        if (!session.waitingTabs[tabId]) {
          session.waitingTabs[tabId] = Date.now();
          session.addLog('等待标签页释放 (tabId=' + tabId + (reason ? ', ' + reason : '') + ')', { level: 'info', scope: 'run', tabId: tabId });
        }
        return new Promise(function (resolve, reject) {
          function poll() {
            if (session.status !== 'running') {
              delete session.waitingTabs[tabId];
              reject(new Error('会话已结束，停止等待标签页: ' + tabId));
              return;
            }
            if (!isTabClaimedByOther(session, tabId)) {
              delete session.waitingTabs[tabId];
              session.addLog('标签页已释放，继续运行 (tabId=' + tabId + ')', { scope: 'run', tabId: tabId });
              resolve(tabId);
              return;
            }
            setTimeout(poll, 500);
          }
          setTimeout(poll, 500);
        });
      }

      function claimAfterWait(source, tabId, reason) {
        return waitForTabAvailable(tabId, reason).then(function () {
          if (claimTab(session, source, tabId)) return tabId;
          return new Promise(function (resolve) { setTimeout(resolve, 300); }).then(function () {
            return claimAfterWait(source, tabId, reason);
          });
        });
      }

      function ensureSessionWindow(url, options) {
        options = options || {};
        if (session.windowCreating) {
          return session.windowCreating.then(function () { return ensureSessionWindow(url, options); });
        }
        var foreground = options.focusWindow === true
          || options.foreground === true
          || options.requiresForeground === true;

        var check = session.windowId
          ? chrome.windows.get(session.windowId).then(function () { return session.windowId; }, function (error) {
            if (isMissingWindowError(error)) return 0;
            throw error;
          })
          : Promise.resolve(0);

        var windowPromise = check.then(function (winId) {
          if (winId) {
            return executeLifecycleAction(0, 'createTab', { windowId: winId, url: url, active: foreground }, options).then(function (result) {
              return Object.assign({}, result.derivedFacts.createdTab || {}, { actionResult: result });
            });
          }
          var windowStartedAt = new Date().toISOString();
          return chrome.windows.create({ url: url, focused: foreground, width: 1280, height: 900, incognito: !!session.incognito }).then(function (win) {
            session.windowId = win.id;
            session.addLog('已为会话创建独立窗口 (windowId=' + win.id + (session.incognito ? '，隐私模式' : '') + ')' + (foreground ? '，按显式“聚焦浏览器窗口”请求聚焦' : '，后台创建不主动聚焦'));
            var tab = win.tabs && win.tabs[0];
            var tabPromise = tab ? Promise.resolve(tab) : chrome.tabs.query({ windowId: win.id }).then(function (tabs) { return tabs && tabs[0]; });
            return tabPromise.then(function (createdTab) {
              if (!createdTab || !createdTab.id) return createdTab;
              return Object.assign({}, createdTab, {
                actionResult: lifecycleFactResult(createdTab.id, 'openPage', 'yes', [
                  { kind: 'window_created', windowId: win.id, tabId: createdTab.id, url: String(createdTab.url || url || '') },
                ], '浏览器窗口和目标标签页已创建', windowStartedAt),
              });
            });
          }).catch(function (err) {
            if (session.incognito) {
              throw new Error('创建隐私窗口失败（请到 chrome://extensions 扩展详情中开启「在无痕模式下启用」）: ' + (err && err.message));
            }
            throw err;
          });
        }).then(function (tab) {
          session.windowCreating = null;
          return tab;
        }, function (err) {
          session.windowCreating = null;
          throw err;
        });

        session.windowCreating = windowPromise;
        return windowPromise;
      }

      function adoptOrGetTabId(source) {
        var known = session.tabs[source];
        var check = known ? aliveOrNull(known) : Promise.resolve(null);
        return check.then(function (alive) {
          if (alive && !isTabClaimedByOther(session, alive)) return alive;
          delete session.tabs[source];
          return null;
        });
      }

      function getRunTabMode() {
        return normalizeRunTabMode(session.runTabMode);
      }

      function setRunTabMode(mode, options) {
        options = options || {};
        var next = normalizeRunTabMode(mode);
        var changed = next !== session.runTabMode;
        session.runTabMode = next;
        if (changed && options.keepTabs !== true) session.tabs = {};
        session.addLog('运行标签策略切换为: ' + runTabModeLabel(next), { scope: 'run' });
        broadcastSessions();
        return { runTabMode: next, label: runTabModeLabel(next), clearedTabs: changed && options.keepTabs !== true };
      }

      function queryReusableTabs() {
        if (session.entry === 'mcp') return chrome.tabs.query({});
        if (session.originWindowId) return chrome.tabs.query({ windowId: session.originWindowId });
        return chrome.windows.getLastFocused().then(function (win) {
          return chrome.tabs.query({ windowId: win.id });
        }, function (error) {
          if (isMissingWindowError(error)) return chrome.tabs.query({ currentWindow: true });
          throw error;
        });
      }

      function findReusableTab(source, url) {
        return queryReusableTabs().then(function (tabs) {
          var firstBusy = null;
          for (var i = 0; i < tabs.length; i++) {
            var tab = tabs[i];
            if (!tab || !tab.id || !tab.url) continue;
            if (!!tab.incognito !== !!session.incognito) continue;
            if (!sourceHostMatches(source, tab.url, url)) continue;
            if (!isTabClaimedByOther(session, tab.id)) return { tab: tab, busy: false };
            if (!firstBusy) firstBusy = tab;
          }
          return firstBusy ? { tab: firstBusy, busy: true } : null;
        });
      }

      function shouldNavigateExistingTab(source, tab, url, mode, reused, options) {
        options = options || {};
        if (!url) return false;
        if (options.forceNavigate === true) return true;
        if (options.forceReopen === true) return true;
        if (options.forceReopen === false) return !sameUrl(tab && tab.url, url);
        if (mode === RUN_TAB_MODE_REUSE_OPEN && reused) return !sameUrl(tab && tab.url, url);
        return true;
      }

      function openInExistingTab(source, tabId, url, mode, reused, label, options) {
        options = options || {};
        label = label || runTabModeLabel(mode);
        return claimAfterWait(source, tabId, label).then(function () {
          return chrome.tabs.get(tabId);
        }).then(function (tab) {
          var navigate = shouldNavigateExistingTab(source, tab, url, mode, reused, options);
          var actionResult = null;
          var activationResult = null;
          var updatePromise = (navigate && options && options.forceReopen === true && url && sameUrl(tab && tab.url, url))
            ? activateTabWithoutFocusingWindow(tabId, tab, true).then(function (activated) {
              activationResult = activated.actionResult || null;
              return preparePageCommandTab(tabId, null, {});
            }).then(function () {
              return executeLifecycleAction(tabId, 'reload', {}, options);
            }).then(function (result) { actionResult = result; return prepareOpenedOrNavigatedTab(tabId, null, options); }).then(function (prepared) {
              activationResult = prepared && prepared.actionResult || activationResult;
              return { tabId: tabId, actionResult: actionResult, activationResult: activationResult };
            })
            : updateRunTab(tabId, url, Object.assign({}, options, { navigate: navigate }));
          return updatePromise.then(function (updateResult) {
            actionResult = updateResult && updateResult.actionResult || actionResult;
            activationResult = updateResult && updateResult.activationResult || activationResult;
            return chrome.tabs.get(tabId);
          }).then(function (updatedTab) {
            var action = reused ? (navigate ? 'reuse-navigate' : 'reuse') : 'open';
            var actualUrl = (updatedTab && updatedTab.url) || (tab && tab.url) || url || '';
            recordTabUsage(source, updatedTab || tab, { mode: mode, reused: reused, url: actualUrl, action: action });
            session.addLog(label + ' (tabId=' + tabId + '): ' + actualUrl.slice(0, 100) + (navigate ? '' : '（保留当前页面）'), { scope: 'run', tabId: tabId });
            return options.returnDetails === true
              ? { tabId: tabId, created: false, reused: true, actionResult: actionResult, activationResult: activationResult }
              : tabId;
          });
        }).then(function (resultTabId) {
          return resultTabId;
        });
      }

      function openCreatedTab(source, tab, url, mode, label, options) {
        options = options || {};
        if (!tab || !tab.id) throw new Error('创建标签页失败');
        var activationResult = null;
        return claimAfterWait(source, tab.id, label).then(function () {
          return activateTabWithoutFocusingWindow(tab.id, tab, true);
        }).then(function (activated) {
          activationResult = activated.actionResult || null;
          return prepareOpenedOrNavigatedTab(tab.id, null, options);
        }).then(function (prepared) {
          activationResult = prepared && prepared.actionResult || activationResult;
          return chrome.tabs.get(tab.id);
        }).then(function (currentTab) {
          var actualUrl = (currentTab && currentTab.url) || url || '';
          recordTabUsage(source, currentTab || tab, { mode: mode, reused: false, url: actualUrl, action: 'open' });
          session.addLog(label + ' (tabId=' + tab.id + '): ' + actualUrl.slice(0, 100), { scope: 'run', tabId: tab.id });
          return options.returnDetails === true
            ? { tabId: tab.id, created: true, reused: false, actionResult: tab.actionResult || null, activationResult: activationResult }
            : tab.id;
        });
      }

      function createTabInRunWindow(url, options) {
        options = options || {};
        var foreground = options.focusWindow === true
          || options.foreground === true
          || options.requiresForeground === true;
        if (session.originWindowId) {
          return chrome.windows.get(session.originWindowId).then(function () {
            return executeLifecycleAction(0, 'createTab', { windowId: session.originWindowId, url: url, active: foreground }, options).then(function (result) {
              return Object.assign({}, result.derivedFacts.createdTab || {}, { actionResult: result });
            });
          }, function (error) {
            if (!isMissingWindowError(error)) throw error;
            return ensureSessionWindow(url, options);
          });
        }
        return ensureSessionWindow(url, options);
      }

      function createTabForReuse(url, options) {
        if (session.entry !== 'mcp' && session.originWindowId) return createTabInRunWindow(url, options);
        return ensureSessionWindow(url, options);
      }

      function reuseOrCreateTab(source, url, options) {
        options = options || {};
        return adoptOrGetTabId(source).then(function (tabId) {
          var mode = getRunTabMode();
          if (options.forceNew === true) {
            if (tabId && session.tabs) delete session.tabs[source];
            return createTabForReuse(url, options).then(function (tab) {
              return openCreatedTab(source, tab, url, mode, '固定新开标签页', options);
            });
          }
          if (tabId) {
            var maxReuseMs = Number(options.maxReuseMs) || 0;
            var usage = session.tabUsage && session.tabUsage[source];
            var expired = !!(maxReuseMs > 0 && usage && usage.openedAt && Date.now() - usage.openedAt >= maxReuseMs);
            if (expired && mode !== RUN_TAB_MODE_FIXED_CURRENT) {
              return closeSessionTabQuietly(source, tabId, 'maxReuseMs=' + maxReuseMs).then(function () {
                return createTabForReuse(url, options).then(function (tab) {
                  return openCreatedTab(source, tab, url, mode, '标签页超龄重开页面', options);
                });
              });
            }
            return openInExistingTab(source, tabId, url, mode, true, '继续使用会话标签页', options);
          }

          if (mode === RUN_TAB_MODE_FIXED_CURRENT) {
            var currentTabId = session.ownerTabId || session.originTabId || 0;
            if (!currentTabId) throw new Error('运行标签策略为「固定当前标签」，但当前入口没有可绑定的标签页');
            return chrome.tabs.get(currentTabId).then(function (tab) {
              if (!!tab.incognito !== !!session.incognito) {
                throw new Error('当前标签页的隐私模式与会话不匹配');
              }
              return openInExistingTab(source, currentTabId, url, mode, true, '固定当前标签打开', options);
            });
          }

          if (mode === RUN_TAB_MODE_FIXED_NEW) {
            if (!session.boundTabId) {
              return createTabInRunWindow(url, options).then(function (tab) {
                if (!tab || !tab.id) throw new Error('创建固定运行标签页失败');
                session.boundTabId = tab.id;
                return openCreatedTab(source, tab, url, mode, '固定打开标签', options);
              });
            }
            return chrome.tabs.get(session.boundTabId).then(function (tab) {
              if (!!tab.incognito !== !!session.incognito) {
                throw new Error('固定运行标签页的隐私模式与会话不匹配');
              }
              return openInExistingTab(source, session.boundTabId, url, mode, true, '固定打开标签', options);
            }, function (error) {
              if (!isMissingTabError(error)) throw error;
              session.addLog('固定运行标签页不可用，重新创建: ' + String(error && error.message || error), { level: 'warn', scope: 'run' });
              session.boundTabId = 0;
              return createTabInRunWindow(url, options).then(function (tab) {
                if (!tab || !tab.id) throw new Error('创建固定运行标签页失败');
                session.boundTabId = tab.id;
                return openCreatedTab(source, tab, url, mode, '固定打开标签', options);
              });
            });
          }

          return findReusableTab(source, url).then(function (match) {
            if (match && match.tab) {
              return openInExistingTab(source, match.tab.id, url, mode, true, '复用已打开标签', options);
            }
            return createTabForReuse(url, options).then(function (tab) {
              return openCreatedTab(source, tab, url, mode, '新建标签页', options);
            });
          });
        });
      }

      function focusTabForCommand(tabId, knownTab, returnDetails) {
        var shouldLog = false;
        return Promise.resolve(knownTab || chrome.tabs.get(tabId)).then(function (tab) {
          if (!tab || !tab.id) throw new Error('目标标签页不可用: tabId=' + tabId);
          shouldLog = !tab.active;
          return executeLifecycleAction(tabId, 'activateTab', { focusWindow: true }, {}).then(function (actionResult) {
            if (shouldLog) {
              session.addLog('已聚焦目标标签所在的浏览器窗口 (tabId=' + tabId + ')', { scope: 'run', tabId: tabId });
            }
            return returnDetails === true ? { tabId: tabId, actionResult: actionResult } : tabId;
          });
        });
      }

      function recoverDiscardedTabForStableMode(tabId, knownTab) {
        return Promise.resolve(knownTab || chrome.tabs.get(tabId)).then(function (tab) {
          if (!tab || !tab.id || !tab.discarded) return tab;
          session.addLog('CDP 后台稳定模式：目标 Tab 已被浏览器丢弃，先恢复再执行 (tabId=' + tabId + ')', { level: 'warn', scope: 'run', tabId: tabId });
          var deadline = Date.now() + 30000;
          return chrome.tabs.reload(tabId).then(function waitRestored() {
            return chrome.tabs.get(tabId).then(function (currentTab) {
              if (currentTab && currentTab.id && !currentTab.discarded) return currentTab;
              if (Date.now() >= deadline) throw new Error('恢复被丢弃的目标 Tab 超时: tabId=' + tabId);
              return new Promise(function (resolve) { setTimeout(resolve, 100); }).then(waitRestored);
            });
          }).then(function (currentTab) {
            return pageAutomation.verification.waitForPageLoad({
              source: 'flow', tabId: tabId,
              params: { tabId: tabId, timeoutMs: 300000, stableMs: 800, readyState: 'complete' },
            }).then(function () { return currentTab; });
          });
        });
      }

      function ensureBackgroundStableTab(tabId, knownTab) {
        if (!isSessionCdpKeepAliveEnabled()) return Promise.resolve(tabId);
        return Promise.resolve(knownTab || chrome.tabs.get(tabId)).then(function (tab) {
          return tab;
        }).then(function (tab) {
          return recoverDiscardedTabForStableMode(tabId, tab);
        }).then(function () {
          return ensureKeepAlive(tabId);
        }).then(function () {
          return tabId;
        });
      }

      function prepareOpenedOrNavigatedTab(tabId, knownTab, options) {
        options = options || {};
        var activation = activateTabWithoutFocusingWindow(tabId, knownTab, true);
        var stable = activation.then(function () {
          return isSessionCdpKeepAliveEnabled()
            ? ensureBackgroundStableTab(tabId, null)
            : recoverDiscardedTabForStableMode(tabId, null);
        });
        return stable.then(function () {
          return options.focusWindow === true
            || options.foreground === true
            || options.requiresForeground === true
            ? focusTabForCommand(tabId, null, options.returnDetails === true)
            : tabId;
        });
      }

      function preparePageCommandTab(tabId, knownTab, options) {
        options = options || {};
        var activation = activateTabWithoutFocusingWindow(tabId, knownTab, false);
        var stable = activation.then(function () {
          return isSessionCdpKeepAliveEnabled()
            ? ensureBackgroundStableTab(tabId, null)
            : recoverDiscardedTabForStableMode(tabId, null);
        });
        return stable.then(function () {
          return options.focusWindow === true
            || options.foreground === true
            || options.requiresForeground === true
            ? focusTabForCommand(tabId, null)
            : tabId;
        });
      }

      function ensureForegroundOrCdp(tabId, knownTab, options) {
        return preparePageCommandTab(tabId, knownTab, options);
      }

      function isSessionCdpKeepAliveForced() {
        return session.forceCdpKeepAlive === true
          || String(session.trigger || '').indexOf('schedule:') === 0
          || String(session.entry || '') === 'schedule';
      }

      function isSessionCdpKeepAliveEnabled() {
        return isSessionCdpKeepAliveForced() || session.sessionCdpKeepAlive === true;
      }

      function ensureKeepAlive(tabId, options) {
        options = options || {};
        if (!isSessionCdpKeepAliveEnabled()) {
          if (!session.keepAliveDisabledLogged) {
            session.keepAliveDisabledLogged = true;
            session.addLog('本流程未启用 CDP 防节流保活：不建立 session 级长期 debugger lease；页面命令仍会按需使用短 CDP lease');
          }
          return Promise.resolve();
        }
        if (session.keepAliveClosing === true && session.status === 'running' && session.detachKeepAlivePromise) {
          return session.detachKeepAlivePromise.then(function () { return ensureKeepAlive(tabId); });
        }
        if (session.status !== 'running') {
          return Promise.reject(new Error('当前 Flow 已结束，不能再创建 CDP lease'));
        }
        if (session.keepAliveClosing === true) {
          return Promise.reject(new Error('当前 Flow 正在释放 CDP lease，不能创建新 lease'));
        }
        session.keepAliveTabs = session.keepAliveTabs || {};
        session.keepAlivePromises = session.keepAlivePromises || {};
        if (session.keepAlivePromises[tabId]) return session.keepAlivePromises[tabId];
        var state = session.keepAliveTabs[tabId];
        if (state === true) {
          return Promise.resolve();
        }

        if (!session.backgroundStableModeLogged) {
          session.backgroundStableModeLogged = true;
          session.addLog('已启用 CDP 后台稳定模式：运行期间保持 debugger 附加，只激活目标 tab；意外断线会重接并重试当前命令，流程结束后自动 detach', { scope: 'run' });
        }

        function finishAttached(lease) {
          session.keepAliveTabs[tabId] = true;
          session.keepAliveLeases = session.keepAliveLeases || {};
          session.keepAliveLeases[tabId] = lease;
          session.addLog('已开启 CDP 防节流保活 (tabId=' + tabId + ')', { scope: 'run', tabId: tabId });
          return lease;
        }
        var attaching = cdpSessionManager.acquire(tabId, { owner: 'FlowRun:' + String(session.runId || session.flowId || ''), type: 'flow-run' })
          .then(finishAttached);
        session.keepAlivePromises[tabId] = attaching.finally(function () {
          if (session.keepAlivePromises && session.keepAlivePromises[tabId] === attachingPromise) {
            delete session.keepAlivePromises[tabId];
          }
        });
        var attachingPromise = session.keepAlivePromises[tabId];
        return attachingPromise;
      }

      function detachKeepAlive() {
        if (session.detachKeepAlivePromise) return session.detachKeepAlivePromise;
        session.keepAliveClosing = true;
        var pending = Object.keys(session.keepAlivePromises || {}).map(function (tid) {
          return Promise.resolve(session.keepAlivePromises[tid]).catch(function () { return null; });
        });
        var cleanup = Promise.all(pending).then(function () {
          return cdpSessionManager.releaseOwner(
            'FlowRun:' + String(session.runId || session.flowId || ''),
            { detachImmediately: true }
          );
        }).finally(function () {
          session.keepAlivePromises = {};
          session.keepAliveLeases = {};
          session.keepAliveTabs = {};
          session.keepAliveClosing = false;
          session.detachKeepAlivePromise = null;
        });
        session.detachKeepAlivePromise = cleanup;
        return cleanup;
      }
      session.detachKeepAlive = detachKeepAlive;

      return {
        adoptOrGetTabId: adoptOrGetTabId,
        reuseOrCreateTab: reuseOrCreateTab,
        getTabId: function (source) {
          var tabId = session.tabs[source];
          if (tabId && isTabClaimedByOther(session, tabId)) {
            delete session.tabs[source];
            return null;
          }
          return tabId || null;
        },
        isTabAlive: function (source) {
          var tabId = session.tabs[source];
          return tabId ? chrome.tabs.get(tabId).then(function () { return true; }, function (error) {
            if (isMissingTabError(error)) return false;
            throw error;
          }) : Promise.resolve(false);
        },
        foregroundTabForAutomation: function (tabId) {
          return focusTabForCommand(tabId);
        },
        preparePageCommandTab: function (tabId, options) {
          return chrome.tabs.get(tabId).then(function (tab) {
            return preparePageCommandTab(tabId, tab, options);
          });
        },
        describeAutomationTab: function (tabId) {
          var describeTab = sessionTabRuntime.describeTab
            ? sessionTabRuntime.describeTab(tabId)
            : chrome.tabs.get(tabId).then(function (tab) { return 'tab=' + tabId + ', url=' + String(tab && tab.url || ''); });
          return Promise.resolve(describeTab);
        },
        getRunTabMode: function () {
          return { runTabMode: getRunTabMode(), label: runTabModeLabel(getRunTabMode()) };
        },
        setRunTabMode: setRunTabMode,
        registerTab: function (source, tabId) {
          return claimTab(session, source, tabId);
        },
      };
    }

    return {
      createSessionTabAccess: createSessionTabAccess,
    };
  }

  return {
    createSessionTabAccessFactory: createSessionTabAccessFactory,
  };
});
