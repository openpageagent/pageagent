// Pure Side Panel run-state policy. It decides; controllers only execute.
(function attachSidepanelRunState(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidepanelRunState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function isRunning(session) {
    return !!(session && session.status === 'running');
  }

  function runId(session) {
    return String(session && session.runId || '');
  }

  function resolve(options) {
    options = options || {};
    var activeTabId = Number(options.activeTabId) || 0;
    var rawCurrent = isRunning(options.currentSession) ? options.currentSession : null;
    var activeTab = isRunning(options.activeTabSession) ? options.activeTabSession : null;
    var occupancy = isRunning(options.occupancySession) ? options.occupancySession : null;
    var isOwned = typeof options.isOwned === 'function' ? options.isOwned : function () { return true; };

    function owned(session) {
      return !!(session && isOwned(session));
    }

    function belongsToActiveTab(session) {
      return !!(session && activeTabId && Number(session.originTabId) === activeTabId);
    }

    function usable(session) {
      return !!(isRunning(session) && owned(session));
    }

    var current = rawCurrent && belongsToActiveTab(rawCurrent) ? rawCurrent : null;
    var displayedStoppable = usable(current) ? current : null;
    var activeTabStoppable = usable(activeTab) ? activeTab : null;
    var occupancyStoppable = usable(occupancy) ? occupancy : null;
    var stoppableSession = displayedStoppable || activeTabStoppable || occupancyStoppable || null;
    var blockingSession = activeTab || occupancy || null;
    var otherActiveRunning = !!(blockingSession && (!current || runId(blockingSession) !== runId(current)));
    var occupiedOnly = !!(otherActiveRunning && !stoppableSession);
    var runningAction = !!stoppableSession;
    var runLocked = runningAction || otherActiveRunning;
    var actionPending = options.actionPending === true;

    return Object.freeze({
      displayedRunningSession: current,
      stoppableSession: stoppableSession,
      actionSession: stoppableSession || current || blockingSession || null,
      occupiedOnly: occupiedOnly,
      runningAction: runningAction,
      controlsLocked: runLocked || actionPending,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    isRunning: isRunning,
    resolve: resolve,
  });
});
