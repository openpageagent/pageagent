// Page Environment Patch — optional MAIN world script for pages that need it.
(function () {
  'use strict';

  function defineGetter(target, prop, getter) {
    try {
      Object.defineProperty(target, prop, {
        get: getter,
        configurable: true,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // WebDriver-driven browsers expose navigator.webdriver=true. In normal
  // extension-driven Chrome this is already false/undefined; keep this patch
  // narrow and opt-in because descriptor changes are also observable.
  defineGetter(Navigator.prototype, 'webdriver', function () { return undefined; });
  defineGetter(navigator, 'webdriver', function () { return undefined; });

  if (!navigator.languages || !navigator.languages.length) {
    defineGetter(Navigator.prototype, 'languages', function () {
      return ['zh-CN', 'zh', 'en-US', 'en'];
    });
  }

  if (!navigator.language) {
    defineGetter(Navigator.prototype, 'language', function () { return 'zh-CN'; });
  }

  if (!window.chrome) {
    try {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        configurable: true,
        enumerable: true,
        writable: true,
      });
    } catch (_) {}
  }

  if (navigator.permissions && navigator.permissions.query && window.Notification) {
    try {
      var nativeQuery = navigator.permissions.query.bind(navigator.permissions);
      function fallbackPermissionStatus(state) {
        return {
          state: state,
          onchange: null,
          addEventListener: function () {},
          removeEventListener: function () {},
          dispatchEvent: function () { return true; },
        };
      }
      navigator.permissions.query = function (parameters) {
        if (parameters && parameters.name === 'notifications') {
          return nativeQuery(parameters).then(function (status) {
            try {
              Object.defineProperty(status, 'state', {
                get: function () { return Notification.permission; },
                configurable: true,
              });
            } catch (_) {}
            return status;
          }).catch(function () {
            return fallbackPermissionStatus(Notification.permission);
          });
        }
        return nativeQuery(parameters);
      };
    } catch (_) {}
  }
})();
