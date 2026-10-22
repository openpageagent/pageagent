// Fixed offline operations only. No user-provided code is evaluated here.
'use strict';
// Third-party browser bundles expect window; this aliases the Worker, not a DOM.
self.window = self;
// Fixed packaged imports remain available; tools cannot open a network connection.
self.fetch = function () { return Promise.reject(new Error('离线工具禁止联网')); };
for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport']) {
  Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
}
importScripts('catalog.js', 'runtime.js', 'encoding.js', 'certificate.js', 'cryptography.js', 'data.js', 'serialization.js', 'php-source.js', 'codegen.js', 'generators.js', 'developer-utils.js', 'jsx.js');
self.onmessage = async function (event) {
  try {
    const { tool, input } = event.data;
    const request = OfflineToolCatalog.normalize(tool, input);
    const handler = OfflineTools.handlers[tool];
    if (!handler) throw new Error('工具实现未加载：' + tool);
    const value = await handler(request.input, request.operation, request.options);
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 98304) throw new Error('序列化结果超过 98304 字符限制，请缩小输入');
    self.postMessage({ ok: true, result: { tool, operation: request.operation, value: JSON.parse(encoded) } });
  } catch (error) {
    self.postMessage({ ok: false, error: error && error.message || String(error) });
  }
};
