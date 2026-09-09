// Loads protected ImageArtifacts through the background runtime and hydrates shared conversation cards.
(function attachImageArtifactClient(root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageAutomationImageArtifactClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var MESSAGE_GET = 'IMAGE_ARTIFACT_GET';
  var MESSAGE_EXPORT_TOPIC = 'IMAGE_ARTIFACT_EXPORT_TOPIC';
  var MESSAGE_IMPORT_TOPIC = 'IMAGE_ARTIFACT_IMPORT_TOPIC';
  var objectUrls = new Map();
  var observer = null;
  var observedRoot = null;
  var closeActiveLightbox = null;

  function runtimeRequest(payload, messageType) {
    return new Promise(function (resolve, reject) {
      var chromeApi = root && root.chrome;
      if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.sendMessage !== 'function') {
        reject(new Error('Extension runtime is unavailable'));
        return;
      }
      var settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      }
      function callback(response) {
        var runtimeError = null;
        try { runtimeError = chromeApi.runtime.lastError; } catch (error) { runtimeError = error; }
        if (runtimeError) finish(new Error(runtimeError.message || String(runtimeError)));
        else if (!response || response.ok !== true) finish(new Error(response && response.error || 'Image Artifact request failed'));
        else finish(null, response.payload || {});
      }
      try {
        var returned = chromeApi.runtime.sendMessage({ type: messageType || MESSAGE_GET, payload: payload || {} }, callback);
        if (returned && typeof returned.then === 'function') returned.then(function (response) {
          if (!response || response.ok !== true) finish(new Error(response && response.error || 'Image Artifact request failed'));
          else finish(null, response.payload || {});
        }, function (error) { finish(error); });
      } catch (error) { finish(error); }
    });
  }

  function dataUrlBlob(dataUrl) {
    return fetch(dataUrl).then(function (response) { return response.blob(); });
  }

  async function loadVariant(figure, variant) {
    var payload = await runtimeRequest({
      artifactUri: figure && figure.getAttribute('data-image-artifact') || '',
      topicId: figure && figure.getAttribute('data-topic-id') || '',
      variant: variant || 'display',
    });
    return { blob: await dataUrlBlob(payload.dataUrl), metadata: payload.metadata || {} };
  }

  function fileExtension(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'image/avif') return 'avif';
    return 'png';
  }

  function releaseFigure(figure) {
    var value = objectUrls.get(figure);
    if (value) {
      try { URL.revokeObjectURL(value.url); } catch (_) {}
      objectUrls.delete(figure);
    }
  }

  function ensureObserver(container) {
    if (typeof MutationObserver !== 'function' || !container) return;
    var nextRoot = typeof container.getRootNode === 'function' ? container.getRootNode() : container;
    if (!nextRoot || typeof nextRoot.nodeType !== 'number') return;
    if (!observer) {
      observer = new MutationObserver(function () {
        objectUrls.forEach(function (_, figure) {
          if (!figure.isConnected) releaseFigure(figure);
        });
      });
    }
    if (observedRoot === nextRoot) return;
    observer.disconnect();
    observer.observe(nextRoot, { childList: true, subtree: true });
    observedRoot = nextRoot;
  }

  function showMissing(figure, message) {
    figure.classList.add('is-missing');
    var placeholder = figure.querySelector('[data-image-artifact-placeholder]');
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = '图片不可用：' + String(message || 'Artifact 已丢失');
    }
  }

  async function hydrateFigure(figure) {
    if (!figure || figure.dataset.imageArtifactLoading === 'true' || objectUrls.has(figure)) return;
    figure.dataset.imageArtifactLoading = 'true';
    try {
      var loaded = await loadVariant(figure, 'display');
      var url = URL.createObjectURL(loaded.blob);
      objectUrls.set(figure, { url: url, metadata: loaded.metadata });
      var image = figure.querySelector('[data-image-artifact-img]');
      var placeholder = figure.querySelector('[data-image-artifact-placeholder]');
      if (image) { image.src = url; image.hidden = false; }
      if (placeholder) placeholder.hidden = true;
      figure.classList.remove('is-missing');
    } catch (error) {
      showMissing(figure, error && error.message || error);
    } finally { delete figure.dataset.imageArtifactLoading; }
  }

  async function preview(value, figure) {
    if (!root.document || !value || !value.url) return;
    var loaded = null;
    var previewUrl = value.url;
    try {
      loaded = await loadVariant(figure, 'original');
      previewUrl = URL.createObjectURL(loaded.blob);
    } catch (_) {}
    if (closeActiveLightbox) closeActiveLightbox();
    var host = root.document.createElement('div');
    host.id = 'page-automation-image-lightbox';
    host.setAttribute('data-page-automation-ui', 'image-lightbox');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('visibility', 'visible', 'important');
    host.style.setProperty('pointer-events', 'auto', 'important');
    host.style.setProperty('transform', 'none', 'important');
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = root.document.createElement('style');
    style.textContent = ':host{all:initial}.conversation-image-lightbox{position:absolute;inset:0;display:grid;grid-template-rows:44px minmax(0,1fr) 44px;box-sizing:border-box;background:#3b3b3b;color:#fff;font-family:Arial,sans-serif}.conversation-image-toolbar{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:16px;padding:0 8px 0 14px;background:#090909}.conversation-image-identity,.conversation-image-actions{display:flex;min-width:0;align-items:center}.conversation-image-identity{gap:8px}.conversation-image-identity>svg{width:20px;height:20px;flex:0 0 auto}.conversation-image-title{max-width:min(48vw,560px);overflow:hidden;color:#f4f4f4;font-size:13px;line-height:1;text-overflow:ellipsis;white-space:nowrap}.conversation-image-meta{flex:0 0 auto;color:#a9a9a9;font-size:11px}.conversation-image-actions{gap:2px}.conversation-image-toolbar button{display:grid;width:34px;height:34px;padding:0;place-items:center;border:0;border-radius:3px;appearance:none;background:transparent;color:#f2f2f2;cursor:pointer}.conversation-image-toolbar button:hover{background:#292929}.conversation-image-toolbar button:focus-visible{outline:2px solid #fff;outline-offset:-3px}.conversation-image-toolbar button svg{display:block;width:18px;height:18px;pointer-events:none}.conversation-image-stage{display:grid;min-width:0;min-height:0;place-items:center;overflow:hidden;padding:0 16px;box-sizing:border-box}.conversation-image-stage img{display:block;width:100%;height:100%;object-fit:contain}.conversation-image-footer{background:#090909}';
    shadow.appendChild(style);
    var overlay = root.document.createElement('div');
    overlay.className = 'conversation-image-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<header class="conversation-image-toolbar"><div class="conversation-image-identity"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h12l4 4v14H4zM16 3v5h5M7 16l3-3 2 2 2-2 3 3M9 9h.01" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="conversation-image-title"></span><span class="conversation-image-meta"></span></div><div class="conversation-image-actions"><button type="button" data-lightbox-action="download" aria-label="下载图片" title="下载"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" data-lightbox-action="close" aria-label="关闭图片查看器" title="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div></header><div class="conversation-image-stage"><img alt="页面图片大图"></div><footer class="conversation-image-footer" aria-hidden="true"></footer>';
    var metadata = loaded && loaded.metadata || value.metadata || {};
    var mimeType = String(metadata.mimeType || loaded && loaded.blob && loaded.blob.type || 'image/png');
    var fileName = String(metadata.id || 'page-image') + '.' + fileExtension(mimeType);
    var dimensions = Number(metadata.width) > 0 && Number(metadata.height) > 0
      ? Math.round(Number(metadata.width)) + '×' + Math.round(Number(metadata.height)) : '';
    var title = overlay.querySelector('.conversation-image-title');
    title.textContent = fileName;
    title.title = fileName;
    overlay.querySelector('.conversation-image-meta').textContent = dimensions ? '· ' + dimensions : '';
    overlay.querySelector('img').src = previewUrl;
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (loaded) {
        try { URL.revokeObjectURL(previewUrl); } catch (_) {}
      }
      host.remove();
      if (root.removeEventListener) root.removeEventListener('keydown', onKeydown);
      if (closeActiveLightbox === close) closeActiveLightbox = null;
    }
    function onKeydown(event) { if (event && event.key === 'Escape') close(); }
    function downloadPreview() {
      var link = root.document.createElement('a');
      link.href = previewUrl;
      link.download = fileName;
      link.hidden = true;
      shadow.appendChild(link);
      link.click();
      link.remove();
    }
    overlay.addEventListener('click', function (event) {
      var action = event.target && event.target.closest && event.target.closest('[data-lightbox-action]');
      if (!action) return;
      if (action.getAttribute('data-lightbox-action') === 'close') close();
      else if (action.getAttribute('data-lightbox-action') === 'download') downloadPreview();
    });
    shadow.appendChild(overlay);
    root.document.body.appendChild(host);
    closeActiveLightbox = close;
    if (root.addEventListener) root.addEventListener('keydown', onKeydown);
  }

  async function download(value, figure) {
    if (!root.document || !value || !value.url) return;
    var loaded = await loadVariant(figure, 'original');
    var metadata = loaded.metadata || value.metadata || {};
    var downloadUrl = URL.createObjectURL(loaded.blob);
    var downloadHost = root.document.createElement('div');
    downloadHost.style.setProperty('display', 'none', 'important');
    var downloadRoot = downloadHost.attachShadow({ mode: 'closed' });
    var link = root.document.createElement('a');
    link.href = downloadUrl;
    link.download = String(metadata.id || 'page-image') + '.' + fileExtension(metadata.mimeType || 'image/png');
    downloadRoot.appendChild(link);
    root.document.body.appendChild(downloadHost);
    link.click();
    downloadHost.remove();
    setTimeout(function () { try { URL.revokeObjectURL(downloadUrl); } catch (_) {} }, 1000);
  }

  function installActions(container) {
    if (!container || container.dataset && container.dataset.imageArtifactActions === 'true') return;
    if (container.dataset) container.dataset.imageArtifactActions = 'true';
    container.addEventListener('click', function (event) {
      var action = event.target && event.target.closest && event.target.closest('[data-image-artifact-action]');
      if (!action || !container.contains(action)) return;
      // hydrate() can be called for nested render containers. Let the nearest
      // delegated handler own the action so one click produces one operation.
      event.preventDefault();
      event.stopPropagation();
      var figure = action.closest('[data-image-artifact]');
      var value = figure && objectUrls.get(figure);
      if (!value) { if (figure) hydrateFigure(figure); return; }
      if (action.getAttribute('data-image-artifact-action') === 'open') {
        preview(value, figure).catch(function (error) { showMissing(figure, error && error.message || error); });
      } else if (action.getAttribute('data-image-artifact-action') === 'download') {
        download(value, figure).catch(function (error) { showMissing(figure, error && error.message || error); });
      }
    });
  }

  function hydrate(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return Promise.resolve([]);
    objectUrls.forEach(function (_, figure) { if (!figure.isConnected) releaseFigure(figure); });
    ensureObserver(container);
    installActions(container);
    return Promise.all(Array.prototype.map.call(container.querySelectorAll('[data-image-artifact]'), hydrateFigure));
  }

  if (root && typeof root.addEventListener === 'function') {
    root.addEventListener('pagehide', function (event) {
      if (event && event.persisted) return;
      if (closeActiveLightbox) closeActiveLightbox();
      objectUrls.forEach(function (_, figure) { releaseFigure(figure); });
      if (observer) observer.disconnect();
      observer = null;
      observedRoot = null;
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    MESSAGE_GET: MESSAGE_GET,
    MESSAGE_EXPORT_TOPIC: MESSAGE_EXPORT_TOPIC,
    MESSAGE_IMPORT_TOPIC: MESSAGE_IMPORT_TOPIC,
    request: runtimeRequest,
    exportTopic: function (topicId) {
      return runtimeRequest({ topicId: String(topicId || '') }, MESSAGE_EXPORT_TOPIC);
    },
    importTopic: function (topicId, artifacts) {
      return runtimeRequest({ topicId: String(topicId || ''), artifacts: artifacts || [] }, MESSAGE_IMPORT_TOPIC);
    },
    releaseTopic: function (topicId) {
      return runtimeRequest({ topicId: String(topicId || '') }, 'IMAGE_ARTIFACT_RELEASE_TOPIC');
    },
    hydrate: hydrate,
    releaseFigure: releaseFigure,
  });
});
