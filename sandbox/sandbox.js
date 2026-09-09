// Sandbox — 用户脚本执行环境（manifest sandbox 页，允许 new Function）
// 与 offscreen.js 通过 postMessage 通信；API 调用经 offscreen 中继到 background 执行
(function () {
  'use strict';

  var pendingApiCalls = {}; // callId → {resolve, reject}
  var runningExecs = {};    // execId → { aborted }
  var callSeq = 0;

  function post(message) {
    window.parent.postMessage(message, '*');
  }

  // --- API 桥：每个调用 postMessage 并按 callId 挂 Promise ---

  function callApi(execId, api, args) {
    return new Promise(function (resolve, reject) {
      var exec = runningExecs[execId];
      if (!exec || exec.aborted) {
        reject(new Error('脚本已被中止'));
        return;
      }
      var callId = 'c_' + (++callSeq);
      pendingApiCalls[callId] = { resolve: resolve, reject: reject, execId: execId };
      post({ type: 'SCRIPT_API_CALL', execId: execId, callId: callId, api: api, args: args });
    });
  }

  function buildApi(execId) {
    function bridge(api) {
      return function () {
        return callApi(execId, api, Array.prototype.slice.call(arguments));
      };
    }
    var api = {
      page: {
        open: bridge('page.open'),
        setTabMode: bridge('page.setTabMode'),
        getTabMode: bridge('page.getTabMode'),
        getCurrentTab: bridge('page.getCurrentTab'),
        getCurrentUrl: bridge('page.getCurrentUrl'),
        refresh: bridge('page.refresh'),
        navigate: bridge('page.navigate'),
        click: bridge('page.click'),
        fill: bridge('page.fill'),
        fillForm: bridge('page.fillForm'),
        select: bridge('page.select'),
        check: bridge('page.check'),
        hover: bridge('page.hover'),
        press: bridge('page.press'),
        scroll: bridge('page.scroll'),
        scrollInfo: bridge('page.scrollInfo'),
        drag: bridge('page.drag'),
        upload: bridge('page.upload'),
        dialog: bridge('page.dialog'),
        activate: bridge('page.activate'),
        close: bridge('page.close'),
        waitFor: bridge('page.waitFor'),
        extractTable: bridge('page.extractTable'),
        extractList: bridge('page.extractList'),
        extractScrollingList: bridge('page.extractScrollingList'),
        extractText: bridge('page.extractText'),
        inspectStructure: bridge('page.inspectStructure'),
        inspectElement: bridge('page.inspectElement'),
        inspectText: bridge('page.inspectText'),
        inspectHtml: bridge('page.inspectHtml'),
        inspectCss: bridge('page.inspectCss'),
        inspectJavascript: bridge('page.inspectJavascript'),
        search: bridge('page.search'),
        assertElement: bridge('page.assertElement'),
        assertText: bridge('page.assertText'),
        assertAttribute: bridge('page.assertAttribute'),
        assertValue: bridge('page.assertValue'),
        assertUrl: bridge('page.assertUrl'),
        webStorage: bridge('page.webStorage'),
        getRequests: bridge('page.getRequests'),
        getSseEvents: bridge('page.getSseEvents'),
        clearNetworkCapture: bridge('page.clearNetworkCapture'),
        replayRequest: bridge('page.replayRequest'),
        patch: bridge('page.patch'),
        callFunction: bridge('page.callFunction'),
        cdp: bridge('page.cdp'),
        screenshot: bridge('page.screenshot'),
        evaluate: bridge('page.evaluate'),
      },
      http: {
        fetch: bridge('http.fetch'),
        webhook: bridge('http.webhook'),
      },
      file: {
        save: bridge('file.save'),
      },
      model: {
        chat: bridge('model.chat'),
      },
      ctx: {
        get: bridge('ctx.get'),
        set: bridge('ctx.set'),
        addAttribute: bridge('ctx.addAttribute'),
        getAttribute: bridge('ctx.getAttribute'),
        getAttributes: bridge('ctx.getAttributes'),
      },
      log: bridge('log'),
      sleep: function (ms) {
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            var exec = runningExecs[execId];
            if (exec && exec.aborted) reject(new Error('脚本已被中止'));
            else resolve();
          }, Number(ms) || 0);
          var exec = runningExecs[execId];
          if (exec) exec.timers.push(timer);
        });
      },
    };
    return api;
  }

  // --- 脚本执行 ---

  function serializeError(err) {
    if (!err) return '未知错误';
    return err.message || String(err);
  }

  function runScript(execId, code) {
    runningExecs[execId] = { aborted: false, timers: [] };
    var api = buildApi(execId);

    Promise.resolve().then(function () {
      var fn = new Function(
        'api', 'page', 'http', 'ctx', 'log', 'sleep',
        '"use strict";\nreturn (async function () {\n' + code + '\n})();'
      );
      return fn(api, api.page, api.http, api.ctx, api.log, api.sleep);
    }).then(function (result) {
      if (runningExecs[execId] && runningExecs[execId].aborted) return;
      // 确保结果可序列化
      var safe;
      try { safe = (result === undefined) ? null : JSON.parse(JSON.stringify(result)); }
      catch (_) { safe = String(result); }
      post({ type: 'SCRIPT_DONE', execId: execId, ok: true, result: safe });
      delete runningExecs[execId];
    }).catch(function (err) {
      if (runningExecs[execId] && runningExecs[execId].aborted) return;
      post({ type: 'SCRIPT_DONE', execId: execId, ok: false, error: serializeError(err) });
      delete runningExecs[execId];
    });
  }

  function abortScript(execId) {
    var exec = runningExecs[execId];
    if (!exec) return;
    exec.aborted = true;
    for (var i = 0; i < exec.timers.length; i++) clearTimeout(exec.timers[i]);
    // reject 该 exec 的所有挂起 API 调用
    var callIds = Object.keys(pendingApiCalls);
    for (var j = 0; j < callIds.length; j++) {
      if (pendingApiCalls[callIds[j]].execId === execId) {
        pendingApiCalls[callIds[j]].reject(new Error('脚本已被中止'));
        delete pendingApiCalls[callIds[j]];
      }
    }
    delete runningExecs[execId];
  }

  // --- 消息处理 ---

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'SCRIPT_RUN':
        runScript(msg.execId, msg.code || '');
        break;

      case 'SCRIPT_API_RESULT': {
        var pending = pendingApiCalls[msg.callId];
        if (!pending) break;
        delete pendingApiCalls[msg.callId];
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error || 'API 调用失败'));
        break;
      }

      case 'SCRIPT_ABORT':
        abortScript(msg.execId);
        break;
    }
  });

  // 就绪信号
  post({ type: 'SANDBOX_READY' });
})();
