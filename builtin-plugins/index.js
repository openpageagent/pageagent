// Packaged Cordis v3 plugins only. Page Agent's own features are not entries.
// See docs/Page-Agent-14-内置能力插件.md for the manifest and host contracts.
(function (root) {
  'use strict';
  root.PageAgentBuiltinPlugins = Object.freeze([
    root.PageAgentMessagingPlugin,
    ...root.PageAgentDevToolsPlugins,
  ]);
})(globalThis);
