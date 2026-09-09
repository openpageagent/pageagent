// Sidepanel session response normalization and snapshot composition.
(function attachSidepanelSessionSnapshotRuntime(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidepanelSessionSnapshotRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createMap() {
    return Object.create(null);
  }

  function sessionSortTime(session) {
    return session && (session.startedAt || session.endedAt || 0) || 0;
  }

  function create(options) {
    options = options || {};
    var cloneOwnData = options.cloneOwnData;
    if (typeof cloneOwnData !== 'function') throw new Error('SidepanelSessionSnapshotRuntime requires cloneOwnData');

    function classifyResponse(response, normalizePayload) {
      var owned = cloneOwnData(response);
      if (!owned || typeof owned !== 'object') {
        return { accepted: false, kind: 'empty-response', error: '后台未返回响应' };
      }
      if (owned.ok !== true) {
        return {
          accepted: false,
          kind: owned.transportError ? 'transport-error' : 'business-error',
          error: String(owned.error || owned.reason || '请求失败'),
        };
      }
      return normalizePayload(owned.payload);
    }

    function normalizeFlowPayload(payload) {
      if (payload === undefined || payload === null) {
        return { accepted: true, kind: 'empty', sessions: [] };
      }
      if (!Array.isArray(payload)) {
        return { accepted: false, kind: 'invalid-payload', error: 'GET_SESSIONS payload must be an array' };
      }
      return {
        accepted: true,
        kind: payload.length ? 'snapshot' : 'empty',
        sessions: payload.filter(function (item) { return !!(item && typeof item === 'object'); }),
      };
    }

    function normalizeConversationPayload(payload) {
      if (payload === undefined || payload === null) payload = createMap();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { accepted: false, kind: 'invalid-payload', error: 'Conversation session projection must be an object' };
      }
      var assistants = Array.isArray(payload.assistants) ? payload.assistants : [];
      var sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      return {
        accepted: true,
        kind: assistants.length || sessions.length ? 'snapshot' : 'empty',
        assistants: assistants.filter(function (item) { return !!(item && typeof item === 'object'); }),
        sessions: sessions.filter(function (item) { return !!(item && typeof item === 'object'); }),
      };
    }

    function assistantKey(items) {
      return (items || []).map(function (item) {
        return [item.id || '', item.name || '', item.description || ''].join('\u0001');
      }).join('\u0002');
    }

    function compose(flowSessions, conversationSessions) {
      return (flowSessions || []).concat(conversationSessions || []).sort(function (a, b) {
        return sessionSortTime(b) - sessionSortTime(a);
      });
    }

    return {
      classifyResponse: classifyResponse,
      normalizeFlowPayload: normalizeFlowPayload,
      normalizeConversationPayload: normalizeConversationPayload,
      assistantKey: assistantKey,
      compose: compose,
    };
  }

  return { create: create };
});
