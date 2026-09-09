// Persistent Native Messaging client for secure upload-file materialization.
(function attachNativeFileMaterializer(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.NativeFileMaterializer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var API_VERSION = 1;
  var HOST_NAME = 'com.pageagent.automation.files';
  var MAX_BYTES = 20 * 1024 * 1024;

  function MaterializerError(code, message, details) {
    this.name = 'NativeFileMaterializerError';
    this.code = String(code || 'NATIVE_FILE_HOST_UNAVAILABLE');
    this.message = String(message || this.code);
    this.details = details || null;
    this.performed = 'no';
    this.retryable = false;
    if (Error.captureStackTrace) Error.captureStackTrace(this, MaterializerError);
  }
  MaterializerError.prototype = Object.create(Error.prototype);
  MaterializerError.prototype.constructor = MaterializerError;

  function createNativeFileMaterializer(options) {
    options = options || {};
    var chromeApi = options.chrome || globalThis.chrome;
    var hostName = String(options.hostName || HOST_NAME);
    var sequence = 0;
    var active = new Map();
    var pending = new Map();
    var port = null;
    var idleTimer = null;

    function validBase64(value) {
      var clean = String(value || '').replace(/\s+/g, '');
      return clean.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
    }
    function estimateBytes(mode, content) {
      content = String(content || '');
      if (mode === 'base64') {
        var clean = content.replace(/\s+/g, '');
        if (!validBase64(clean)) throw new MaterializerError('UPLOAD_DECODE_FAILED', '上传文件的 base64 内容无效');
        return Math.max(0, Math.floor(clean.length * 3 / 4) - (clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0)));
      }
      try { return new TextEncoder().encode(content).length; } catch (_) { return content.length * 3; }
    }
    function clearIdleTimer() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
    function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
    function disconnectIfIdle() {
      clearIdleTimer();
      if (!port || active.size || pending.size) return;
      idleTimer = setTimeout(function () {
        idleTimer = null;
        if (!port || active.size || pending.size) return;
        var current = port;
        port = null;
        try { current.disconnect(); } catch (_) {}
      }, 1000);
    }
    function rejectPending(error) {
      pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(error); });
      pending.clear();
    }
    function ensurePort() {
      clearIdleTimer();
      if (port) return port;
      try { port = chromeApi.runtime.connectNative(hostName); }
      catch (error) { throw new MaterializerError('NATIVE_FILE_HOST_UNAVAILABLE', '无法连接上传临时文件服务', { reason: String(error && error.message || error) }); }
      var connected = port;
      connected.onMessage.addListener(function (message) {
        if (!message) return;
        var entry = pending.get(String(message.requestId || ''));
        if (!entry) return;
        pending.delete(String(message.requestId));
        clearTimeout(entry.timer);
        if (message.ok === true) entry.resolve(message.result || {});
        else entry.reject(new MaterializerError(String(message.code || 'NATIVE_FILE_HOST_FAILED'), String(message.message || '上传临时文件服务失败')));
        disconnectIfIdle();
      });
      connected.onDisconnect.addListener(function () {
        if (port !== connected) return;
        port = null;
        clearIdleTimer();
        var error = chromeApi.runtime && chromeApi.runtime.lastError;
        rejectPending(new MaterializerError('NATIVE_FILE_HOST_UNAVAILABLE', '上传临时文件服务连接已中断', { reason: String(error && error.message || '') }));
        active.clear();
      });
      return connected;
    }
    function request(command, payload, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var nativePort;
        try { nativePort = ensurePort(); } catch (error) { reject(error); return; }
        var requestId = String(payload.requestId || '');
        var timer = setTimeout(function () {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(new MaterializerError('NATIVE_FILE_HOST_TIMEOUT', '临时文件服务响应超时'));
          disconnectIfIdle();
        }, Math.max(1000, Math.min(Number(timeoutMs) || 15000, 60000)));
        pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
        try { nativePort.postMessage(Object.assign({ command: command }, payload)); }
        catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(new MaterializerError('NATIVE_FILE_HOST_UNAVAILABLE', '无法发送临时文件请求', { reason: String(error && error.message || error) }));
        }
      });
    }
    function materialize(input) {
      input = input || {};
      var mode = input.contentMode === 'base64' ? 'base64' : 'text';
      var byteLength;
      try { byteLength = estimateBytes(mode, input.content); } catch (error) { return Promise.reject(error); }
      if (byteLength > MAX_BYTES) return Promise.reject(new MaterializerError('UPLOAD_FILE_TOO_LARGE', '上传文件超过 20MB 限制', { byteLength: byteLength, maxBytes: MAX_BYTES }));
      var owner = String(input.owner || 'page-action');
      var requestId = 'fileMaterialize_' + (++sequence).toString(36) + '_' + Date.now().toString(36);
      return request('materialize', {
        requestId: requestId, owner: owner, fileName: String(input.fileName || 'upload.bin'),
        mimeType: String(input.mimeType || 'application/octet-stream'), contentMode: mode,
        content: String(input.content || ''), maxBytes: MAX_BYTES,
      }, input.timeoutMs).then(function (result) {
        if (!result.path || !result.token) throw new MaterializerError('NATIVE_FILE_HOST_FAILED', '临时文件服务返回无效路径');
        active.set(String(result.token), { token: String(result.token), owner: owner, path: String(result.path) });
        return Object.freeze({ token: String(result.token), path: String(result.path), byteLength: Number(result.byteLength) || byteLength, fileName: String(result.fileName || input.fileName || '') });
      });
    }
    function cleanup(token, attempt) {
      token = String(token || '');
      if (!token) return Promise.resolve(false);
      attempt = Math.max(0, Number(attempt) || 0);
      return request('cleanup', { requestId: 'fileCleanup_' + (++sequence).toString(36), token: token }, 10000).then(function (result) {
        if (result.removed !== false) active.delete(token);
        disconnectIfIdle();
        return result.removed !== false;
      }, function () {
        if (attempt < 2) return delay(50 * (attempt + 1)).then(function () { return cleanup(token, attempt + 1); });
        disconnectIfIdle();
        return false;
      });
    }
    function cleanupOwner(owner) {
      owner = String(owner || '');
      var tokens = [];
      active.forEach(function (entry, token) { if (!owner || entry.owner === owner) tokens.push(token); });
      return Promise.all(tokens.map(cleanup)).then(function (items) { disconnectIfIdle(); return items.filter(Boolean).length; });
    }
    function cleanupAll() {
      return request('cleanupAll', { requestId: 'fileCleanupAll_' + (++sequence).toString(36) }, 10000).then(function (result) {
        if (Number(result.remaining) === 0) active.clear();
        disconnectIfIdle();
        return Number(result.removed) || 0;
      }, function () { disconnectIfIdle(); return 0; });
    }
    return Object.freeze({ materialize: materialize, cleanup: cleanup, cleanupOwner: cleanupOwner, cleanupAll: cleanupAll, MAX_BYTES: MAX_BYTES, HOST_NAME: hostName });
  }
  return Object.freeze({ API_VERSION: API_VERSION, HOST_NAME: HOST_NAME, MAX_BYTES: MAX_BYTES, MaterializerError: MaterializerError, createNativeFileMaterializer: createNativeFileMaterializer });
});
