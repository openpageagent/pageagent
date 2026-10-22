(function () {
  'use strict';
  var connected = false;
  window.addEventListener('message', function (event) {
    if (connected || event.source !== parent || !event.data || event.data.type !== 'PAGE_AGENT_CODE_VIEW'
        || event.data.token !== location.hash.slice(1) || event.ports.length !== 1) return;
    connected = true;
    var port = event.ports[0], editor = document.querySelector('page-code-editor');
    function reportHeight() {
      var height = parseFloat(editor.style.getPropertyValue('--code-content-height'));
      if (Number.isFinite(height)) port.postMessage({ height: height });
    }
    editor.addEventListener('code-editor-resize', reportHeight);
    reportHeight();
    port.onmessage = function (message) {
      var data = message.data;
      if (!data || typeof data.value !== 'string' || typeof data.language !== 'string') return;
      Object.entries(data.colors || {}).forEach(function (entry) {
        if (/^[a-z-]+$/.test(entry[0]) && /^#[0-9a-f]{6}$/i.test(entry[1])) editor.style.setProperty('--' + entry[0], entry[1]);
      });
      editor.setAttribute('aria-label', String(data.label || '代码详情'));
      editor.setAttribute('language', data.language); editor.value = data.value;
    };
    window.addEventListener('pagehide', function () {
      editor.removeEventListener('code-editor-resize', reportHeight); port.close();
    }, { once: true });
  });
})();
