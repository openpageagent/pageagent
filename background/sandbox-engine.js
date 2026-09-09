// Sandbox Engine — 在 offscreen + sandbox 中执行用户脚本的调度器
// 协议: SCRIPT_RUN / SCRIPT_API_CALL / SCRIPT_API_RESULT / SCRIPT_DONE / SCRIPT_ABORT
(function attachSandboxEngine(root, factory) {
  root.SandboxEngine = factory();
})(globalThis, function () {

  var OFFSCREEN_URL = 'offscreen/offscreen.html';
  var DEFAULT_SCRIPT_TIMEOUT_MS = 60000;

  function createSandboxEngine(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || (function () {});
    var executeApiCall = deps.executeApiCall || (function () { return Promise.reject(new Error('API 桥未接线')); });

    var execSeq = 0;
    var runningScripts = Object.create(null); // execId → { resolve, reject, timer }
    var conversionSeq = 0;
    var pendingConversions = Object.create(null); // requestId → { resolve, reject, timer }
    var creatingOffscreen = null;

    // --- offscreen 生命周期（全局唯一，懒创建） ---

    function ensureOffscreen() {
      if (creatingOffscreen) return creatingOffscreen;

      creatingOffscreen = chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      }).then(function (contexts) {
        if (contexts && contexts.length > 0) return;
        return chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['IFRAME_SCRIPTING'],
          justification: '在沙箱 iframe 中执行用户自定义自动化脚本（MV3 扩展上下文禁止 eval）',
        }).catch(function (err) {
          // 并发创建时可能报 already exists，容忍
          if (!/single offscreen document|already exists/i.test(err.message || '')) throw err;
        });
      }).then(function () {
        creatingOffscreen = null;
      }, function (err) {
        creatingOffscreen = null;
        throw err;
      });

      return creatingOffscreen;
    }

    function sendToSandbox(payload) {
      return ensureOffscreen().then(function () {
        return chrome.runtime.sendMessage({ target: 'offscreen', payload: payload }).catch(function (err) {
          throw new Error('无法连接沙箱: ' + (err && err.message));
        });
      });
    }

    function turndownHtmlToMarkdown(html, config, options) {
      options = options || {};
      var timeoutMs = Number(options.timeoutMs);
      if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS;
      var signal = options.signal || null;
      if (signal && signal.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Turndown 转换已停止'));
      }
      var requestId = 'turndown_' + Date.now() + '_' + (++conversionSeq);
      return new Promise(function (resolve, reject) {
        var onAbort = null;
        function cleanup(pending) {
          clearTimeout(pending.timer);
          if (signal && onAbort && typeof signal.removeEventListener === 'function') {
            try { signal.removeEventListener('abort', onAbort); } catch (_) {}
          }
        }
        var timer = setTimeout(function () {
          var pending = pendingConversions[requestId];
          if (!pending) return;
          delete pendingConversions[requestId];
          cleanup(pending);
          reject(new Error('Turndown 转换超时 (' + timeoutMs + 'ms)'));
        }, timeoutMs);
        pendingConversions[requestId] = { resolve: resolve, reject: reject, timer: timer, cleanup: cleanup };
        if (signal && typeof signal.addEventListener === 'function') {
          onAbort = function () {
            var pending = pendingConversions[requestId];
            if (!pending) return;
            delete pendingConversions[requestId];
            cleanup(pending);
            reject(signal.reason instanceof Error ? signal.reason : new Error('Turndown 转换已停止'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
            return;
          }
        }
        ensureOffscreen().then(function () {
          if (!pendingConversions[requestId]) return;
          return chrome.runtime.sendMessage({
            target: 'offscreen',
            payload: { type: 'TURNDOWN_CONVERT', requestId: requestId, html: html, config: config || {} },
          });
        }).catch(function (error) {
          var pending = pendingConversions[requestId];
          if (!pending) return;
          delete pendingConversions[requestId];
          cleanup(pending);
          reject(new Error('无法连接 Turndown 转换器: ' + (error && error.message || error)));
        });
      });
    }

    // --- 脚本执行 ---

    function runScript(code, options) {
      options = options || {};
      var timeoutMs = Number(options.timeoutMs);
      if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS;
      var execId = 'exec_' + Date.now() + '_' + (++execSeq);

      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          abortScript(execId, '脚本执行超时 (' + timeoutMs + 'ms)');
        }, timeoutMs);

        runningScripts[execId] = {
          active: true,
          generation: execSeq,
          resolve: resolve,
          reject: reject,
          timer: timer,
          // 运行会话可注入自己的 API 桥（变量上下文/页面 tab 按会话隔离）与中止标签
          apiCall: options.nodeExecutionApiCall || options.apiCall || null,
          tag: options.tag || '',
          addLog: options.nodeExecutionAddLog || options.addLog || addLog,  // 支持会话级日志函数
          signal: options.signal || null,
          abortListener: null,
        };

        var entry = runningScripts[execId];
        if (entry.signal && typeof entry.signal.addEventListener === 'function') {
          entry.abortListener = function () {
            abortScript(execId, entry.signal.reason instanceof Error ? entry.signal.reason.message : '脚本已被中止');
          };
          entry.signal.addEventListener('abort', entry.abortListener, { once: true });
          if (entry.signal.aborted) entry.abortListener();
        }

        if (!runningScripts[execId]) return;
        sendToSandbox({ type: 'SCRIPT_RUN', execId: execId, code: code, timeoutMs: timeoutMs })
          .catch(function (err) {
            finishScript(execId, { ok: false, error: err.message });
          });
      });
    }

    function finishScript(execId, result) {
      var entry = runningScripts[execId];
      if (!entry || entry.active !== true) return;
      entry.active = false;
      delete runningScripts[execId];
      clearTimeout(entry.timer);
      if (entry.signal && entry.abortListener && typeof entry.signal.removeEventListener === 'function') {
        try { entry.signal.removeEventListener('abort', entry.abortListener); } catch (_) {}
      }
      entry.abortListener = null;
      entry.signal = null;
      var resolve = entry.resolve;
      var reject = entry.reject;
      entry.resolve = null;
      entry.reject = null;
      entry.apiCall = null;
      entry.addLog = null;
      if (result.ok) resolve(result.result);
      else reject(new Error(result.error || '脚本执行失败'));
    }

    function abortScript(execId, reason) {
      sendToSandbox({ type: 'SCRIPT_ABORT', execId: execId }).catch(function () {});
      finishScript(execId, { ok: false, error: reason || '脚本已被中止' });
    }

    function abortAll(reason) {
      var ids = Object.keys(runningScripts);
      for (var i = 0; i < ids.length; i++) {
        abortScript(ids[i], reason || '流程已停止');
      }
    }

    function abortByTag(tag, reason) {
      if (!tag) return;
      var ids = Object.keys(runningScripts);
      for (var i = 0; i < ids.length; i++) {
        if (runningScripts[ids[i]].tag === tag) {
          abortScript(ids[i], reason || '流程已停止');
        }
      }
    }

    function isRunning() {
      return Object.keys(runningScripts).length > 0;
    }

    // --- 处理来自沙箱的消息（由 background.js 的 onMessage 分发） ---

    function isActiveEntry(execId, entry, generation) {
      return !!(entry
        && entry.active === true
        && entry.generation === generation
        && runningScripts[execId] === entry);
    }

    function sendInactiveApiResult(payload) {
      return sendToSandbox({
        type: 'SCRIPT_API_RESULT', execId: payload.execId, callId: payload.callId,
        ok: false, error: '脚本执行已结束或不存在',
      }).catch(function () {});
    }

    function sendActiveApiResult(payload, result, entry, generation) {
      return ensureOffscreen().then(function () {
        var response = isActiveEntry(payload.execId, entry, generation)
          ? {
              type: 'SCRIPT_API_RESULT', execId: payload.execId, callId: payload.callId,
              ok: true, result: result,
            }
          : {
              type: 'SCRIPT_API_RESULT', execId: payload.execId, callId: payload.callId,
              ok: false, error: '脚本执行已结束或不存在',
            };
        return chrome.runtime.sendMessage({ target: 'offscreen', payload: response }).catch(function (err) {
          throw new Error('无法连接沙箱: ' + (err && err.message));
        });
      });
    }

    function handleSandboxMessage(payload) {
      if (!payload || !payload.type) return;

      if (payload.type === 'TURNDOWN_RESULT') {
        var conversion = pendingConversions[payload.requestId];
        if (!conversion) return;
        delete pendingConversions[payload.requestId];
        if (typeof conversion.cleanup === 'function') conversion.cleanup(conversion);
        else clearTimeout(conversion.timer);
        if (payload.ok) conversion.resolve(payload.markdown);
        else conversion.reject(new Error(payload.error || 'Turndown 转换失败'));
        return;
      }

      if (payload.type === 'SCRIPT_API_CALL') {
        var entry = runningScripts[payload.execId];
        var generation = entry && entry.generation;
        // SCRIPT_ABORT/timeout removes the execution first. A late API call must
        // never fall back to the global bridge, otherwise an aborted script can
        // continue mutating browser/session state outside its lifetime.
        if (!isActiveEntry(payload.execId, entry, generation)) {
          sendInactiveApiResult(payload);
          return;
        }
        Promise.resolve().then(function () {
          if (!isActiveEntry(payload.execId, entry, generation)) {
            throw new Error('脚本执行已结束或不存在');
          }
          var apiCall = entry.apiCall || executeApiCall;
          return apiCall(payload.api, payload.args);
        }).then(function (result) {
          if (!isActiveEntry(payload.execId, entry, generation)) {
            throw new Error('脚本执行已结束或不存在');
          }
          // 确保可结构化克隆
          var safe;
          try { safe = (result === undefined) ? null : JSON.parse(JSON.stringify(result)); }
          catch (_) { safe = String(result); }
          return sendActiveApiResult(payload, safe, entry, generation);
        }).catch(function (err) {
          var error = isActiveEntry(payload.execId, entry, generation)
            ? ((err && err.message) || String(err))
            : '脚本执行已结束或不存在';
          return sendToSandbox({
            type: 'SCRIPT_API_RESULT', execId: payload.execId, callId: payload.callId,
            ok: false, error: error,
          });
        }).catch(function () {});
        return;
      }

      if (payload.type === 'SCRIPT_DONE') {
        var entry = runningScripts[payload.execId];
        // Ignore completion messages arriving after timeout/abort. The caller
        // has already received the terminal result and the execution is closed.
        if (!entry || entry.active !== true) return;
        var logFunc = entry.addLog || addLog;
        if (!payload.ok) {
          logFunc('脚本执行失败: ' + payload.error, { level: 'error' });
        }
        finishScript(payload.execId, payload);
      }
    }

    return {
      runScript: runScript,
      turndownHtmlToMarkdown: turndownHtmlToMarkdown,
      abortAll: abortAll,
      abortByTag: abortByTag,
      isRunning: isRunning,
      handleSandboxMessage: handleSandboxMessage,
    };
  }

  return { createSandboxEngine: createSandboxEngine };
});
