// Offscreen — background ↔ sandbox iframe 的纯消息中继
(function () {
  'use strict';

  var frame = document.getElementById('sandbox-frame');
  var sandboxReady = false;
  var queue = [];

  function forwardToSandbox(payload) {
    if (!sandboxReady) {
      queue.push(payload);
      return;
    }
    frame.contentWindow.postMessage(payload, '*');
  }

  function sendToBackground(payload, from) {
    return chrome.runtime.sendMessage({ target: 'background', from: from, payload: payload }).catch(function () {});
  }

  function turndownHtmlToMarkdown(payload) {
    Promise.resolve().then(function () {
      if (!globalThis.PageAgentTurndown || typeof globalThis.PageAgentTurndown.convert !== 'function') {
        throw new Error('Turndown 转换适配器未加载');
      }
      return globalThis.PageAgentTurndown.convert(payload.html, payload.config);
    }).then(function (markdown) {
      return sendToBackground({
        type: 'TURNDOWN_RESULT', requestId: payload.requestId, ok: true, markdown: markdown,
      }, 'offscreen');
    }, function (error) {
      return sendToBackground({
        type: 'TURNDOWN_RESULT', requestId: payload.requestId, ok: false,
        error: error && error.message || String(error || 'Turndown 转换失败'),
      }, 'offscreen');
    });
  }

  // sandbox → background
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'SANDBOX_READY') {
      sandboxReady = true;
      while (queue.length) {
        frame.contentWindow.postMessage(queue.shift(), '*');
      }
      return;
    }

    // SCRIPT_API_CALL / SCRIPT_DONE → background
    sendToBackground(msg, 'sandbox');
  });

  // background → sandbox
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.target !== 'offscreen') return;
    if (message.payload && message.payload.type === 'TURNDOWN_CONVERT') {
      turndownHtmlToMarkdown(message.payload);
      sendResponse({ ok: true });
      return;
    }
    forwardToSandbox(message.payload);
    sendResponse({ ok: true });
  });
})();
