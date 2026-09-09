// Persistent sidepanel session references and selection state.
(function attachSidepanelSessionStateRuntime(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.SidepanelSessionStateRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var REFS_KEY = 'sidepanelSessionRefs';
  var SELECTION_KEY = 'sidepanelSessionSelection';

  function create(options) {
    options = options || {};
    var storage = options.storage || null;
    var browserRuntime = options.browserRuntime || (typeof chrome !== 'undefined' && chrome.runtime) || null;
    var runtimeScope = String(options.runtimeScope || 'regular') === 'incognito' ? 'incognito' : 'regular';
    var refsKey = runtimeScope === 'incognito' ? REFS_KEY + 'Incognito' : REFS_KEY;
    var selectionKey = runtimeScope === 'incognito' ? SELECTION_KEY + 'Incognito' : SELECTION_KEY;
    var clone = options.clone;
    var normalizeRefs = options.normalizeRefs;
    if (typeof clone !== 'function' || typeof normalizeRefs !== 'function') {
      throw new Error('SidepanelSessionStateRuntime requires clone and normalizeRefs');
    }
    var refs = Object.create(null);
    var pinnedRunId = '';
    var currentRunId = '';
    var revision = 0;
    var generation = 1;
    var writeTail = Promise.resolve();
    var destroyed = false;

    function cleanId(value) { return String(value || '').trim(); }
    function snapshot() {
      return { refs: clone(refs), pinnedRunId: pinnedRunId, currentRunId: currentRunId, revision: revision };
    }
    function selectionPayload() {
      return { pinnedRunId: pinnedRunId, currentRunId: currentRunId };
    }
    function runtimeError() {
      var error = browserRuntime && browserRuntime.lastError;
      return error ? new Error(error.message || String(error)) : null;
    }
    function invoke(method, value) {
      if (!storage || typeof storage[method] !== 'function') return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error) {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        }
        function callback() { finish(runtimeError()); }
        try {
          var returned = storage[method](value, callback);
          if (returned && typeof returned.then === 'function') returned.then(function () { finish(); }, finish);
          else if (returned !== undefined) finish();
        } catch (error) { finish(error); }
      });
    }
    function persist() {
      var writeRevision = revision;
      var refsSnapshot = clone(refs);
      var selectionSnapshot = selectionPayload();
      var operation = writeTail.then(function () {
        if (destroyed || writeRevision !== revision) return { written: false, skipped: true };
        var patch = Object.create(null);
        patch[refsKey] = refsSnapshot;
        patch[selectionKey] = selectionSnapshot;
        return invoke('set', patch).then(function () { return { written: true, skipped: false }; });
      }, function () {});
      writeTail = operation.catch(function () {});
      return operation;
    }
    function load() {
      var loadGeneration = generation;
      var loadRevision = revision;
      if (!storage || typeof storage.get !== 'function') return Promise.resolve(snapshot());
      var read = new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, result) {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(result);
        }
        function callback(result) { finish(runtimeError(), result); }
        try {
          var returned = storage.get([refsKey, selectionKey], callback);
          if (returned && typeof returned.then === 'function') returned.then(function (result) { finish(null, result); }, function (error) { finish(error); });
          else if (returned !== undefined) finish(null, returned);
        } catch (error) { finish(error); }
      });
      return read.then(function (result) {
        if (destroyed || loadGeneration !== generation || loadRevision !== revision) return snapshot();
        result = result || {};
        refs = normalizeRefs(result[refsKey]);
        var selection = result[selectionKey] || {};
        pinnedRunId = cleanId(selection.pinnedRunId);
        currentRunId = cleanId(selection.currentRunId) || pinnedRunId;
        revision += 1;
        return snapshot();
      });
    }
    function replaceRefs(nextRefs, shouldPersist) {
      refs = normalizeRefs(nextRefs);
      revision += 1;
      if (shouldPersist !== false) persist().catch(function () {});
      return snapshot();
    }
    function setSelection(pinned, current, shouldPersist) {
      pinnedRunId = cleanId(pinned);
      currentRunId = cleanId(current) || pinnedRunId;
      revision += 1;
      if (shouldPersist !== false) persist().catch(function () {});
      return snapshot();
    }
    function destroy() { destroyed = true; generation += 1; revision += 1; }

    return Object.freeze({ load: load, snapshot: snapshot, replaceRefs: replaceRefs, setSelection: setSelection, persist: persist, destroy: destroy });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
