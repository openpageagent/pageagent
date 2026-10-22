(function () {
  'use strict';
  var jobs = new Map();
  chrome.runtime.onMessage.addListener(function (message, sender, respond) {
    if (!message || message.target !== 'utility-workers') return;
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'cancel') {
      var job = jobs.get(message.id);
      if (job) job({ ok: false, error: '离线工具已取消' });
      respond({ ok: true });
      return;
    }
    if (message.type !== 'run') return;
    if (jobs.size >= 2 || jobs.has(message.id)) {
      respond({ ok: false, error: '已有两个工具正在计算，请稍后重试' });
      return;
    }
    var worker, timer, finished = false;
    function finish(reply) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (worker) worker.terminate();
      jobs.delete(message.id);
      respond(reply);
    }
    try {
      worker = new Worker(chrome.runtime.getURL('utilities/worker.js'));
      jobs.set(message.id, finish);
      timer = setTimeout(function () { finish({ ok: false, error: '离线计算超过 15 秒，已终止' }); }, 15000);
      worker.onmessage = function (event) { finish(event.data); };
      worker.onerror = function (event) { event.preventDefault(); finish({ ok: false, error: event.message || '离线计算加载失败' }); };
      worker.onmessageerror = function () { finish({ ok: false, error: '离线计算结果无法传输' }); };
      worker.postMessage({ tool: message.tool, input: message.input });
    } catch (error) { finish({ ok: false, error: error.message }); }
    return true;
  });
  window.addEventListener('pagehide', function () {
    Array.from(jobs.values()).forEach(function (finish) { finish({ ok: false, error: '离线计算页面已关闭' }); });
  });
})();
