// Shared system settings contract for options and content-script contexts.
(function attachSystemSettings(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationSystemSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SETTINGS_KEY = 'system_settings';
  var DEFAULTS = Object.freeze({
    floatingEntryDisabled: false,
  });

  function normalize(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      floatingEntryDisabled: raw.floatingEntryDisabled === true,
    };
  }

  function lastError(runtime) {
    try {
      var error = runtime && runtime.lastError;
      return error && error.message ? new Error(error.message) : null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error || '读取扩展状态失败'));
    }
  }

  function load(storage, runtime) {
    try {
      if (!storage || typeof storage.get !== 'function') {
        return Promise.resolve(normalize());
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise(function (resolve, reject) {
      try {
        storage.get(SETTINGS_KEY, function (result) {
          var error = lastError(runtime);
          if (error) {
            reject(error);
            return;
          }
          resolve(normalize(result && result[SETTINGS_KEY]));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function save(storage, runtime, value) {
    var settings = normalize(value);
    try {
      if (!storage || typeof storage.set !== 'function') {
        return Promise.reject(new Error('系统配置存储不可用'));
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise(function (resolve, reject) {
      var patch = {};
      patch[SETTINGS_KEY] = settings;
      try {
        storage.set(patch, function () {
          var error = lastError(runtime);
          if (error) reject(error);
          else resolve(settings);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  return {
    SETTINGS_KEY: SETTINGS_KEY,
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    load: load,
    save: save,
  };
});
