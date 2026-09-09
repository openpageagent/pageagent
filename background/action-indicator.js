// Action Indicator — browser action badge state for running/stopped/failed sessions.
(function attachActionIndicator(root, factory) {
  root.ActionIndicator = factory();
})(globalThis, function () {
  function createActionIndicator(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var getSessions = deps.getSessions || (function () { return {}; });
    var getSnapshots = deps.getSnapshots || (function () { return {}; });
    var getLegacyState = deps.getLegacyState || (function () { return {}; });
    var activeTabs = {};
    var refreshTimers = {};

    function getIndicator(session) {
      if (!session) return null;
      if (session.status === 'running') {
        return { text: 'RUN', color: '#004849', title: '运行中', priority: 3 };
      }
      if (session.status === 'failed') {
        return { text: 'ERR', color: '#ba554a', title: '运行失败', priority: 2 };
      }
      if (session.status === 'stopped') {
        return { text: 'STOP', color: '#cf9f5d', title: '已停止', priority: 1 };
      }
      return null;
    }

    function sessionTabIds(session) {
      var map = {};
      if (session.ownerTabId) map[session.ownerTabId] = true;
      if (session.boundTabId) map[session.boundTabId] = true;
      Object.keys(session.tabs || {}).forEach(function (source) {
        if (session.tabs[source]) map[session.tabs[source]] = true;
      });
      Object.keys(session.tabUsage || {}).forEach(function (source) {
        var usage = session.tabUsage[source] || {};
        if (usage.tabId) map[usage.tabId] = true;
      });
      return Object.keys(map).map(function (id) { return Number(id); }).filter(Boolean);
    }

    function snapshotTabIds(snap) {
      var map = {};
      if (snap.ownerTabId) map[snap.ownerTabId] = true;
      if (snap.boundTabId) map[snap.boundTabId] = true;
      Object.keys(snap.tabs || {}).forEach(function (source) {
        if (snap.tabs[source]) map[snap.tabs[source]] = true;
      });
      Object.keys(snap.tabUsage || {}).forEach(function (source) {
        var usage = snap.tabUsage[source] || {};
        if (usage.tabId) map[usage.tabId] = true;
      });
      return Object.keys(map).map(function (id) { return Number(id); }).filter(Boolean);
    }

    function setBadge(tabId, indicator) {
      if (!chrome.action || !tabId) return;
      var title = 'Page Agent';
      try {
        var textPromise = chrome.action.setBadgeText({ tabId: tabId, text: '' });
        if (textPromise && textPromise.catch) textPromise.catch(function () {});
      } catch (_) {}
      try {
        var titlePromise = chrome.action.setTitle({ tabId: tabId, title: title });
        if (titlePromise && titlePromise.catch) titlePromise.catch(function () {});
      } catch (_) {}
    }

    function update() {
      if (!chrome.action) return;
      var sessions = getSessions() || {};
      var snapshots = getSnapshots() || {};
      var legacy = getLegacyState() || {};
      var next = {};

      Object.keys(sessions).forEach(function (id) {
        var session = sessions[id];
        var indicator = getIndicator(session);
        if (!indicator) return;
        indicator.flowLabel = session.flowLabel || '';
        sessionTabIds(session).forEach(function (tabId) {
          var current = next[tabId];
          if (!current || indicator.priority > current.priority) next[tabId] = indicator;
        });
      });

      Object.keys(snapshots).forEach(function (runId) {
        if (sessions[runId]) return;
        var snap = snapshots[runId];
        if (!snap || !snap.boundTabId) return;
        var stoppedIndicator = getIndicator({ status: 'stopped' });
        if (!stoppedIndicator) return;
        stoppedIndicator.flowLabel = snap.flowLabel || '';
        var currentStopped = next[snap.boundTabId];
        if (!currentStopped || stoppedIndicator.priority > currentStopped.priority) {
          next[snap.boundTabId] = stoppedIndicator;
        }
      });

      if (legacy.boundTabId) {
        var legacyIndicator = getIndicator({ status: legacy.status });
        if (legacyIndicator) {
          legacyIndicator.flowLabel = legacy.flowLabel || '';
          var currentLegacy = next[legacy.boundTabId];
          if (!currentLegacy || legacyIndicator.priority > currentLegacy.priority) {
            next[legacy.boundTabId] = legacyIndicator;
          }
        }
      }

      Object.keys(activeTabs).forEach(function (tabId) {
        if (!next[tabId]) setBadge(Number(tabId), null);
      });
      Object.keys(next).forEach(function (tabId) {
        setBadge(Number(tabId), next[tabId]);
      });

      activeTabs = {};
      Object.keys(next).forEach(function (tabId) {
        activeTabs[tabId] = true;
      });
    }

    function shouldRefreshForTab(tabId) {
      if (!tabId) return false;
      if (activeTabs[tabId]) return true;
      var sessions = getSessions() || {};
      var legacy = getLegacyState() || {};
      if (legacy.boundTabId === tabId && getIndicator({ status: legacy.status })) return true;

      var ids = Object.keys(sessions);
      for (var i = 0; i < ids.length; i++) {
        var session = sessions[ids[i]];
        if (!getIndicator(session)) continue;
        var tabIds = sessionTabIds(session);
        for (var j = 0; j < tabIds.length; j++) {
          if (tabIds[j] === tabId) return true;
        }
      }

      var snapshots = getSnapshots() || {};
      var snapIds = Object.keys(snapshots);
      for (var k = 0; k < snapIds.length; k++) {
        var snap = snapshots[snapIds[k]];
        if (snap && snap.boundTabId === tabId) return true;
      }
      return false;
    }

    function refreshForTab(tabId) {
      if (!shouldRefreshForTab(tabId)) return;
      update();
      if (refreshTimers[tabId]) clearTimeout(refreshTimers[tabId]);
      refreshTimers[tabId] = setTimeout(function () {
        delete refreshTimers[tabId];
        if (shouldRefreshForTab(tabId)) update();
      }, 300);
    }

    function clearAll() {
      if (!chrome.action || !chrome.tabs) return;
      try {
        var tabsPromise = chrome.tabs.query({});
        if (tabsPromise && tabsPromise.then) {
          tabsPromise.then(function (tabs) {
            (tabs || []).forEach(function (tab) {
              if (tab && tab.id) setBadge(tab.id, null);
            });
            activeTabs = {};
            update();
          }).catch(function () {});
        }
      } catch (_) {}
    }

    return {
      update: update,
      refreshForTab: refreshForTab,
      clearAll: clearAll,
      getSessionTabIds: sessionTabIds,
      getSnapshotTabIds: snapshotTabIds,
    };
  }

  return { createActionIndicator: createActionIndicator };
});
