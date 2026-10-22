// Applications, conversations, flow nodes and scripts share this worker client.
(function (root) {
  'use strict';
  root.UtilityService = {
    create: function (ensureOffscreen) {
      async function execute(tool, input, options) {
        var request = root.OfflineToolCatalog.normalize(tool, input);
        var signal = options && options.signal;
        if (signal && signal.aborted) throw new Error('离线工具已取消');
        await ensureOffscreen();
        if (signal && signal.aborted) throw new Error('离线工具已取消');
        var id = crypto.randomUUID();
        return new Promise(function (resolve, reject) {
          var settled = false;
          function cancelWorker() {
            chrome.runtime.sendMessage({ target: 'utility-workers', type: 'cancel', id: id }).catch(function () {});
          }
          function finish(error, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
          }
          function abort() { cancelWorker(); finish(new Error('离线工具已取消')); }
          var timer = setTimeout(function () { cancelWorker(); finish(new Error('离线工具执行超时（20 秒）')); }, 20000);
          // Send before registering abort so a cancel message cannot overtake run.
          chrome.runtime.sendMessage({ target: 'utility-workers', type: 'run', id: id, tool: tool, input: request }).then(function (reply) {
            if (!reply || !reply.ok) finish(new Error(reply && reply.error || '离线计算连接已关闭'));
            else finish(null, reply.result);
          }, function (error) { finish(error); });
          if (signal) {
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }
        });
      }
      return { execute: execute };
    },
  };
})(globalThis);
