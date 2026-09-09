(function attachSidepanelLogPanel(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidepanelLogPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char];
    });
  }

  function normalizeScope(entry) {
    if (!entry) return 'system';
    var scope = entry.scope || '';
    if (scope === 'session') return 'run';
    if (scope === 'system' || scope === 'run' || scope === 'flow' || scope === 'mcp') return scope;
    if (entry.nodeId) return 'flow';
    if (entry.runId) return 'run';
    return 'system';
  }

  function entryKey(entry) {
    return [entry.timestamp || '', entry.runId || '', entry.scope || '', entry.nodeId || '', entry.message || ''].join('\u0001');
  }

  function formatLogTime(timestamp) {
    var date = new Date(timestamp);
    function pad(number, length) {
      var text = String(number);
      while (text.length < length) text = '0' + text;
      return text;
    }
    return pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2)
      + '.' + pad(date.getMilliseconds(), 3);
  }

  function create(options) {
    options = options || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var container = options.container || (doc && doc.getElementById('log-container'));
    var clearButton = options.clearButton || (doc && doc.getElementById('btn-clear-log'));
    var getCurrentRunId = options.getCurrentRunId || function () { return ''; };
    var isConversationRunId = options.isConversationRunId || function () { return false; };
    var entries = [];
    var currentScope = 'run';
    var initialized = false;
    var destroyed = false;
    var unbind = [];

    function listen(target, type, handler) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, handler);
      unbind.push(function () { target.removeEventListener(type, handler); });
    }

    function isConversationEntry(entry) {
      return !!(entry && (entry.conversationLog || isConversationRunId(entry.runId)));
    }

    function displayScope(entry) {
      return isConversationEntry(entry) ? '后台' : normalizeScope(entry);
    }

    function displayScopeClass(entry) {
      return isConversationEntry(entry) ? 'conversation' : normalizeScope(entry);
    }

    function displayRun(entry) {
      if (!entry) return '';
      var explicit = String(entry.displayRun || '').trim();
      if (explicit) return explicit;
      if (isConversationEntry(entry)) return '';
      return entry.runId ? String(entry.runId).slice(0, 12) : '';
    }

    function shouldShow(entry) {
      var scope = normalizeScope(entry);
      if (scope !== currentScope) return false;
      var currentRunId = String(getCurrentRunId() || '');
      if (currentScope === 'run' && currentRunId && isConversationRunId(currentRunId) && isConversationEntry(entry)) {
        return entry.runId === currentRunId;
      }
      return true;
    }

    function append(entry) {
      if (!container || !entry) return;
      var time = formatLogTime(entry.timestamp);
      var levelClass = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : '';
      var div = doc.createElement('div');
      div.className = 'log-entry ' + levelClass + ' log-scope-' + displayScopeClass(entry);
      var meta = '<span class="log-scope">' + escapeHtml(displayScope(entry)) + '</span>';
      var runLabel = displayRun(entry);
      if (runLabel) meta += '<span class="log-run">' + escapeHtml(runLabel) + '</span>';
      if (entry.tabId) meta += '<span class="log-tab">tab ' + escapeHtml(entry.tabId) + '</span>';
      div.innerHTML = '<span class="log-time">' + escapeHtml(time) + '</span> ' + meta
        + '<span class="log-msg">' + escapeHtml(entry.message) + '</span>';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      while (container.children.length > 200) container.removeChild(container.firstChild);
    }

    function render() {
      if (!container) return;
      container.innerHTML = '';
      entries.slice().sort(function (a, b) {
        return Number(a && a.timestamp || 0) - Number(b && b.timestamp || 0);
      }).forEach(function (entry) {
        if (shouldShow(entry)) append(entry);
      });
    }

    function push(entry) {
      if (!entry) return false;
      entry = Object.assign({}, entry, { scope: normalizeScope(entry) });
      var key = entryKey(entry);
      for (var i = Math.max(0, entries.length - 200); i < entries.length; i++) {
        if (entryKey(entries[i]) === key) return false;
      }
      entries.push(entry);
      if (entries.length > 500) entries.splice(0, entries.length - 500);
      if (shouldShow(entry)) append(entry);
      return true;
    }

    function setScope(scope, rerender) {
      currentScope = scope || 'run';
      var channels = doc ? doc.querySelectorAll('.log-channel') : [];
      for (var i = 0; i < channels.length; i++) {
        channels[i].classList.toggle('active', (channels[i].dataset.logScope || '') === currentScope);
      }
      if (rerender) render();
    }

    function addLocal(message, scope, level, extra) {
      return push(Object.assign({
        timestamp: Date.now(),
        level: level || 'info',
        scope: scope || 'run',
        message: String(message || ''),
      }, extra || {}));
    }

    function clear() {
      entries = [];
      if (container) container.innerHTML = '';
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      listen(clearButton, 'click', clear);
      var channels = doc ? doc.querySelectorAll('.log-channel') : [];
      for (var i = 0; i < channels.length; i++) {
        (function (button) {
          listen(button, 'click', function () { setScope(button.dataset.logScope || 'run', true); });
        })(channels[i]);
      }
      setScope(currentScope, false);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      while (unbind.length) unbind.pop()();
    }

    return {
      init: init,
      destroy: destroy,
      push: push,
      setScope: setScope,
      addLocal: addLocal,
      clear: clear,
      render: render,
      getScope: function () { return currentScope; },
      getEntries: function () { return entries.slice(); },
    };
  }

  return {
    create: create,
    escapeHtml: escapeHtml,
    normalizeScope: normalizeScope,
  };
});
