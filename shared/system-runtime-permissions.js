// System defaults shared by conversations, applications and the execution layer.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SystemRuntimePermissions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var permissions = Object.freeze([
    'page.read', 'page.interact',
    'browser.read', 'browser.tabs.write', 'browser.navigate',
    'flows.read', 'flows.write', 'flows.nodes.read', 'flows.nodes.write',
    'flow-groups.read', 'flow-groups.write', 'node-types.read', 'recordings.read',
    'runs.read', 'runs.report.read', 'runs.debug.read', 'runs.execute', 'runs.cancel',
    'pages.read', 'pages.write',
    'url-triggers.read', 'url-triggers.write',
    'scripts.read', 'scripts.write',
    'apps.read', 'apps.write', 'apps.execute',
    'schedules.read', 'schedules.write',
    'knowledge.read', 'knowledge.write', 'skills.read', 'assistants.read',
    'system-settings.read', 'system-settings.write',
    'mail-settings.read', 'mail-settings.write', 'mail-settings.execute',
    'connections.read',
    'local.execute',
    'utilities.read', 'utilities.execute',
  ]);
  var rootMethods = Object.freeze({
    '/page': Object.freeze(['GET', 'POST', 'OPTIONS']),
    '/browser': Object.freeze(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']),
    '/flows': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/node-types': Object.freeze(['GET', 'OPTIONS']),
    '/utilities': Object.freeze(['GET', 'POST', 'OPTIONS']),
    '/flow-groups': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/recordings': Object.freeze(['GET', 'OPTIONS']),
    '/runs': Object.freeze(['GET', 'POST', 'OPTIONS']),
    '/knowledge': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/skills': Object.freeze(['GET', 'OPTIONS']),
    '/assistants': Object.freeze(['GET', 'OPTIONS']),
    '/pages': Object.freeze(['GET', 'POST', 'PATCH', 'OPTIONS']),
    '/url-triggers': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/scripts': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/apps': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/schedules': Object.freeze(['GET', 'POST', 'PATCH', 'OPTIONS']),
    '/local': Object.freeze(['GET', 'POST', 'OPTIONS']),
    '/connections': Object.freeze(['GET', 'OPTIONS']),
    '/system-settings': Object.freeze(['GET', 'PATCH', 'OPTIONS']),
    '/mail-settings': Object.freeze(['GET', 'PATCH', 'POST', 'OPTIONS']),
  });

  return Object.freeze({ permissions: permissions, rootMethods: rootMethods });
});
