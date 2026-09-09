(function attachPageAutomationRuntimeClient(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationRuntimeClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function failure(reason, error) {
    return {
      ok: false,
      reason: reason,
      error: String(error && error.message ? error.message : (error || reason || '消息发送失败')),
      transportError: true,
    };
  }

  function isContextInvalidatedError(error) {
    var message = String(error && error.message ? error.message : (error || ''));
    return /extension context invalidated/i.test(message);
  }

  function lastErrorMessage(runtime) {
    try {
      var err = runtime && runtime.lastError;
      return err && err.message ? err.message : '';
    } catch (error) {
      return String(error && error.message ? error.message : (error || ''));
    }
  }

  function create(runtime, options) {
    options = options || {};
    var invalidated = false;
    var invalidationNotified = false;

    function transportFailure(error) {
      var contextInvalidated = invalidated || isContextInvalidatedError(error);
      if (contextInvalidated) {
        invalidated = true;
        if (!invalidationNotified && typeof options.onInvalidated === 'function') {
          invalidationNotified = true;
          try { options.onInvalidated(error); } catch (_) {}
        }
      }
      return failure(contextInvalidated ? 'extension-context-invalidated' : 'transport-error', error);
    }

    function send(type, payload) {
      type = String(type || '').trim();
      if (!type) return Promise.resolve(failure('invalid-message-type', '消息类型不能为空'));
      if (invalidated) {
        return Promise.resolve(transportFailure('Extension context invalidated.'));
      }
      try {
        if (!runtime || typeof runtime.sendMessage !== 'function') {
          return Promise.resolve(failure('runtime-unavailable', '扩展消息通道不可用'));
        }
      } catch (error) {
        return Promise.resolve(transportFailure(error));
      }

      return new Promise(function (resolve) {
        var settled = false;
        function failTransport(error) {
          if (settled) return;
          settled = true;
          resolve(transportFailure(error));
        }
        function finishResponse(response) {
          if (settled) return;
          settled = true;
          if (response === undefined || response === null) {
            resolve(failure('empty-response', '后台未返回响应'));
            return;
          }
          resolve(response);
        }
        function finishCallback(response) {
          if (settled) return;
          var runtimeError = lastErrorMessage(runtime);
          if (runtimeError) {
            settled = true;
            resolve(transportFailure(runtimeError));
            return;
          }
          finishResponse(response);
        }

        try {
          var returned = runtime.sendMessage({
            type: type,
            payload: payload === undefined ? {} : payload,
          }, finishCallback);
          if (returned && typeof returned.then === 'function') {
            returned.then(finishResponse, failTransport);
          }
        } catch (err) {
          failTransport(err);
        }
      });
    }

    return { send: send };
  }

  return {
    create: create,
    failure: failure,
    isContextInvalidatedError: isContextInvalidatedError,
  };
});
