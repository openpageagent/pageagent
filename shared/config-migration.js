// Remove retired configuration fields at storage and import boundaries.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationConfigMigration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // Callers pass owned data (storage values or a clone), never live drafts.
  function cleanNode(node) {
    if (!isObject(node)) return node;
    delete node.requiresForeground;
    delete node.foreground;
    delete node.reveal;
    delete node.highlightMs;
    if (isObject(node.params)) {
      delete node.params.requiresForeground;
      delete node.params.foreground;
      delete node.params.reveal;
      delete node.params.highlightMs;
    }
    return node;
  }

  function cleanItem(section, item) {
    if (!isObject(item)) return item;
    if (section === 'flows' || section === 'flowGroups') {
      if (!item.label && typeof item.name === 'string') item.label = item.name;
      delete item.name;
    }
    if (section === 'pages') {
      if (isObject(item.keepAlive)) {
        delete item.keepAlive.activityMode;
        delete item.keepAlive.lockedSelector;
        delete item.keepAlive.healthySelector;
        delete item.keepAlive.versionUrl;
        delete item.keepAlive.reloadOnSessionExpired;
        delete item.keepAlive.reloadOnLocked;
        delete item.keepAlive.reloadOnVersionChange;
        delete item.keepAlive.reloadDiscarded;
      }
      delete item.autoRefreshMinutes;
      delete item.stealthMode;
    } else if (section === 'flows') {
      delete item.enabled;
      delete item.inputs;
      delete item.outputs;
      delete item.allowCdpKeepAlive;
      delete item.disableKeepAlive;
      if (Array.isArray(item.nodes)) item.nodes.forEach(cleanNode);
    } else if (section === 'flowGroups') {
      delete item.inputs;
      delete item.outputs;
    }
    return item;
  }

  function cleanConfig(config) {
    if (!isObject(config)) return config;
    ['pages', 'flows', 'flowGroups'].forEach(function (section) {
      var items = config[section];
      if (!isObject(items)) return;
      Object.keys(items).forEach(function (id) { cleanItem(section, items[id]); });
    });
    return config;
  }

  return Object.freeze({ cleanNode: cleanNode, cleanItem: cleanItem, cleanConfig: cleanConfig });
});
