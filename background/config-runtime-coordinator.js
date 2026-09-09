// Config Runtime Coordinator - applies persisted config to runtime resources in order.
(function attachConfigRuntimeCoordinator(root, factory) {
  root.ConfigRuntimeCoordinator = factory();
})(globalThis, function () {

  var REQUIRED_CONFIG_SECTIONS = ['pages', 'flows', 'flowGroups', 'scripts', 'schedules', 'urlTriggers'];

  function assertPersistedConfig(value) {
    var valid = !!(value && typeof value === 'object' && !Array.isArray(value));
    for (var index = 0; valid && index < REQUIRED_CONFIG_SECTIONS.length; index++) {
      valid = Object.prototype.hasOwnProperty.call(value, REQUIRED_CONFIG_SECTIONS[index]);
    }
    if (valid) return value;
    var error = new Error('Config runtime update operation must return the persisted config');
    error.code = 'CONFIG_RUNTIME_INVALID_RESULT';
    throw error;
  }

  function createConfigRuntimeCoordinator(deps) {
    deps = deps || {};
    var prepareConfig = deps.prepareConfig || (function (config) { return Promise.resolve(config); });
    var publishConfig = deps.publishConfig || (function () {});
    var reloadDynamic = deps.reloadDynamic || (function () { return Promise.resolve(); });
    var syncAlarms = deps.syncAlarms || (function () { return Promise.resolve(); });
    var updateQueue = Promise.resolve();

    function applyNow(config) {
      return Promise.resolve().then(function () {
        return prepareConfig(config);
      }).then(function (runtimeConfig) {
        publishConfig(runtimeConfig);
        return Promise.resolve().then(function () {
          return reloadDynamic(runtimeConfig);
        }).then(function () {
          return syncAlarms(runtimeConfig);
        }).then(function () {
          return runtimeConfig;
        });
      });
    }

    function enqueue(operation) {
      if (typeof operation !== 'function') {
        return Promise.reject(new Error('Config runtime update requires an operation'));
      }
      var queued = updateQueue.then(operation, operation);
      updateQueue = queued.catch(function () {});
      return queued;
    }

    // The operation must resolve to the exact config that was persisted or loaded.
    // Keeping it inside this queue prevents a later write from overtaking runtime apply.
    function update(operation) {
      return enqueue(function () {
        return Promise.resolve().then(operation).then(assertPersistedConfig).then(applyNow);
      });
    }

    return {
      update: update,
    };
  }

  return { createConfigRuntimeCoordinator: createConfigRuntimeCoordinator };
});
