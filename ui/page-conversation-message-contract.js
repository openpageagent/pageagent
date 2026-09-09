(function attachPageConversationMessageContract(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var protocol = commonJs ? require('../agent/conversation-protocol') : root.ConversationProtocol;
  var api = factory(protocol);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationPageConversationMessages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (protocol) {
  'use strict';

  if (!protocol || protocol.API_VERSION !== 1) throw new Error('ConversationProtocol must load before the Page message transport');
  var COMMANDS = protocol.COMMANDS;
  var COMMAND_NAMES = protocol.COMMAND_NAMES;
  var TYPES = Object.freeze({
    GET_ENTRY_CONFIG: 'GET_PAGE_AGENT_ENTRY_CONFIG',
    COMMAND: 'CONVERSATION_COMMAND',
    OPEN_OPTIONS_CONVERSATION: 'OPEN_OPTIONS_CONVERSATION',
    GET_VISIBILITY: 'GET_PAGE_CONVERSATION_VISIBILITY',
    SET_VISIBILITY: 'SET_PAGE_CONVERSATION_VISIBILITY',
    REFRESH: 'PAGE_CONVERSATION_REFRESH',
    GET_RECORDING_STATE: 'GET_CONVERSATION_RECORDING_STATE',
    START_RECORDING: 'START_CONVERSATION_RECORDING',
    STOP_RECORDING: 'STOP_CONVERSATION_RECORDING',
    REMOVE_RECORDING_SOURCE: 'REMOVE_CONVERSATION_RECORDING_SOURCE',
    GET_RECORDING_LIBRARY: 'GET_CONVERSATION_RECORDING_LIBRARY',
    GET_RECORDING_PREVIEW: 'GET_CONVERSATION_RECORDING_SOURCE_PREVIEW',
    EXPORT_RECORDING_SOURCE: 'EXPORT_CONVERSATION_RECORDING_SOURCE',
    UPDATE_RECORDING_SELECTION: 'UPDATE_CONVERSATION_RECORDING_SELECTION',
    CLAIM_RECORDING_SELECTION: 'CLAIM_CONVERSATION_RECORDING_SELECTION',
    RECORDING_STATE_CHANGED: 'CONVERSATION_RECORDING_STATE_CHANGED',
    RECORDING_LIBRARY_CHANGED: 'CONVERSATION_RECORDING_LIBRARY_CHANGED',
  });

  function failure(code, message) {
    return { ok: false, code: code, reason: code, error: String(message || code) };
  }

  function clone(value, seen) {
    if (value === null || value === undefined || typeof value === 'string'
        || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return undefined;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new Error('消息 payload 包含循环引用');
    seen.push(value);
    try {
      var output = Array.isArray(value) ? [] : Object.create(null);
      Object.keys(value).forEach(function (key) {
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
        if (!descriptor || descriptor.get || descriptor.set
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
        var next = clone(descriptor.value, seen);
        if (next !== undefined) output[key] = next;
      });
      return output;
    } finally {
      seen.pop();
    }
  }

  function request(type, payload) {
    type = String(type || '').trim();
    var supported = Object.keys(TYPES).map(function (key) { return TYPES[key]; }).filter(function (value) {
      return value !== TYPES.REFRESH && value !== TYPES.RECORDING_STATE_CHANGED && value !== TYPES.RECORDING_LIBRARY_CHANGED;
    });
    if (supported.indexOf(type) === -1) {
      return failure('unsupported-message-type', '不支持的页面对话消息: ' + type);
    }
    var clean;
    try { clean = clone(payload || {}); } catch (error) {
      return failure('invalid-payload', error && error.message || '消息 payload 无效');
    }
    if (type === TYPES.COMMAND) {
      var command = String(clean.command || '').trim();
      if (COMMAND_NAMES.indexOf(command) === -1) return failure('invalid-command', '未知对话命令: ' + command);
      if (!clean.input || typeof clean.input !== 'object' || Array.isArray(clean.input)) {
        return failure('invalid-command-input', '对话命令缺少 input');
      }
      clean = { command: command, input: clean.input };
    }
    if (type === TYPES.SET_VISIBILITY && typeof clean.open !== 'boolean') {
      return failure('missing-visibility', '页面对话显示状态必须是布尔值');
    }
    return { ok: true, message: { type: type, payload: clean } };
  }

  function response(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return failure('invalid-response', '后台响应格式无效');
    }
    if (raw.ok !== true) {
      var error = raw.error && typeof raw.error === 'object' ? raw.error : null;
      return {
        ok: false,
        code: String(error && error.code || raw.code || raw.reason || 'operation-failed'),
        reason: String(error && error.code || raw.reason || raw.code || 'operation-failed'),
        error: String(error && error.message || raw.error || '操作失败'),
        details: error && error.details,
        transportError: raw.transportError === true,
      };
    }
    try {
      return { ok: true, payload: clone(raw.result !== undefined ? raw.result : raw.payload) };
    } catch (error) {
      return failure('invalid-response-payload', error && error.message || '后台响应数据无效');
    }
  }

  return Object.freeze({
    API_VERSION: 1,
    COMMANDS: COMMANDS,
    TYPES: TYPES,
    request: request,
    response: response,
    error: failure,
  });
});
