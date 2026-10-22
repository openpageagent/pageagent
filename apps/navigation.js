// Application entry and executable source share the extension origin.
(function (root) {
  'use strict';
  var origin = new URL(chrome.runtime.getURL('/'));
  function headers(type, code) {
    var result = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (code && code.networkPolicy === 'offline') result['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:; worker-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
    return result;
  }
  root.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url);
    if (url.protocol !== origin.protocol || url.hostname !== origin.hostname || !url.pathname.startsWith('/apps')) return;
    var entry = root.AppContract.parsePath(url.pathname);
    var source = /^\/apps\/source\/(app_[A-Za-z0-9_-]+)\/(draft|published)\/([A-Za-z0-9-]+)\.js$/.exec(url.pathname);
    var file = /^\/apps\/source\/(app_[A-Za-z0-9_-]+)\/(draft|published)\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
    if (file) source = file;
    if (!entry && !source) {
      if (event.request.mode === 'navigate') event.respondWith(new Response('无效的应用地址', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
      return;
    }
    event.respondWith((async function () {
      try {
        if (url.search || event.request.method !== 'GET') return new Response('无效的应用地址', { status: 400, headers: { 'Cache-Control': 'no-store' } });
        if (entry) {
          var store = root.PageAgentApps.store;
          var meta = entry.appId ? await store.get('app_meta', entry.appId) : await store.findBySlug(entry.slug);
          var current = meta && await store.get('app_code', [meta.appId, entry.slot]);
          var host = await fetch(chrome.runtime.getURL('apps/index.html'));
          return new Response(await host.text(), { headers: headers('text/html; charset=utf-8', current && current.code) });
        }
        var record = await root.PageAgentApps.store.get('app_code', [source[1], source[2]]);
        if (!record || record.revision !== source[3]) return new Response('应用已更新，请重新加载', { status: 409, headers: { 'Cache-Control': 'no-store' } });
        var name = file && file[4], content = record.code.javascript;
        if (name && name !== '__entry__.js') {
          root.AppContract.sourceFileName(name);
          if (!Object.prototype.hasOwnProperty.call(record.code.files || {}, name)) return new Response('应用源码文件不存在', { status: 404, headers: headers('text/plain; charset=utf-8') });
          content = record.code.files[name];
        }
        var css = name && name.endsWith('.css');
        if (css) content = root.AppContract.resolveSourceFiles(content, root.AppContract.sourceBase(source[1], source[2], source[3]), record.code.files);
        return new Response(content, { headers: headers(css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', record.code) });
      } catch (error) {
        return new Response('应用加载失败: ' + error.message, { status: error.code === 'CONTENT_CHANGED' ? 409 : error.code === 'INVALID_ADDRESS' ? 400 : 500, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
    })());
  });
})(globalThis);
