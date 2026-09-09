// Screenshot and visual assertion node helpers.
(function attachNodeVisual(root, factory) {
  root.NodeVisual = factory();
})(globalThis, function () {
  'use strict';

  var BASELINES_KEY = 'automation_baselines';

  function createVisualNodes(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || function () {};
    var sleep = deps.sleep || function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };
    var requireRuntimeTabId = deps.requireRuntimeTabId || function (params) {
      var tabId = Number(params && (params.tabId || params.activeTabId) || 0) || 0;
      return tabId ? Promise.resolve(tabId) : Promise.reject(new Error('screenshot 需要 tabId'));
    };
    var ensurePageReady = typeof deps.ensurePageReady === 'function'
      ? deps.ensurePageReady
      : function (_pageId, _execution, params) { return requireRuntimeTabId(params || {}, 'screenshot'); };
    var capturePageScreenshot = deps.capturePageScreenshot;
    if (typeof capturePageScreenshot !== 'function') throw new Error('NodeVisual requires PagePerceptionEngine.captureScreenshot');
    var preparePageCommandTab = typeof deps.preparePageCommandTab === 'function' ? deps.preparePageCommandTab : function (tabId) { return Promise.resolve(tabId); };
    var verifyAssertion = deps.verifyAssertion;
    if (typeof verifyAssertion !== 'function') throw new Error('NodeVisual requires PageVerificationEngine.verifyAssertion');

    function assertionResult(passed, actual, expected, reason, result) {
      var verification = verifyAssertion({ kind: 'assertScreenshot', passed: passed, actual: actual, expected: expected, reason: reason });
      if (!passed) {
        var error = new Error('[断言失败] ' + reason);
        error.code = 'VERIFICATION_FAILED';
        error.verification = verification;
        throw error;
      }
      return Object.assign({}, result || {}, { passed: true, verification: verification });
    }

    function log(execution, message, options) {
      return execution && execution.addLog
        ? execution.addLog(message, options)
        : addLog(message, options);
    }

    function captureScreenshotForPage(pageId, quality, params, execution) {
      var resolveTab = pageId
        ? ensurePageReady(pageId, execution)
        : requireRuntimeTabId(params || {}, 'screenshot');
      return resolveTab.then(function (tabId) {
        return preparePageCommandTab(tabId, params || {}).then(function () {
          return capturePageScreenshot(tabId, Object.assign({}, params || {}, {
            format: 'jpeg',
            quality: Math.min(100, Math.max(1, Number(quality) || 70)),
            signal: execution && execution.signal,
          })).then(function (capture) {
            return capture.dataUrl;
          });
        });
      });
    }

    function execScreenshot(pageId, params, execution) {
      params = params || {};
      return captureScreenshotForPage(pageId, params.quality, params, execution).then(function (dataUrl) {
        log(execution, '已截图（约 ' + Math.round(dataUrl.length * 3 / 4 / 1024) + ' KB）');
        return { dataUrl: dataUrl, capturedAt: Date.now() };
      });
    }

    function getBaselines(execution) {
      ensureNotStopped(execution);
      return new Promise(function (resolve, reject) {
        chrome.storage.local.get(BASELINES_KEY, function (result) {
          var lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            reject(new Error('读取视觉基线失败: ' + lastError.message));
            return;
          }
          try { ensureNotStopped(execution); } catch (error) { reject(error); return; }
          resolve(result[BASELINES_KEY] || {});
        });
      });
    }

    function saveBaseline(key, entry, execution) {
      var dispatched = false;
      return getBaselines(execution).then(function (map) {
        Object.defineProperty(map, key, { value: entry, enumerable: true, configurable: true, writable: true });
        return new Promise(function (resolve, reject) {
          ensureNotStopped(execution);
          dispatched = true;
          chrome.storage.local.set((function () { var o = {}; o[BASELINES_KEY] = map; return o; })(), function () {
            var lastError = chrome.runtime && chrome.runtime.lastError;
            if (lastError) {
              reject(new Error('保存视觉基线失败: ' + lastError.message));
              return;
            }
            try { ensureNotStopped(execution); } catch (error) { reject(error); return; }
            resolve();
          });
        });
      }).catch(function (error) {
        if (dispatched) throw markUncertain(error);
        throw error;
      });
    }

    function ensureNotStopped(execution) {
      if (execution && execution.signal && execution.signal.aborted) {
        throw execution.signal.reason instanceof Error ? execution.signal.reason : new Error('视觉断言已停止');
      }
    }

    function markUncertain(error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        try { error.performed = 'unknown'; error.retryable = false; } catch (_) {}
      }
      return error;
    }

    function dataUrlToImageData(dataUrl, execution) {
      ensureNotStopped(execution);
      return fetch(dataUrl, { signal: execution && execution.signal }).then(function (r) { return r.blob(); }).then(function (blob) {
        ensureNotStopped(execution);
        return createImageBitmap(blob);
      }).then(function (bmp) {
        try {
          ensureNotStopped(execution);
          var canvas = new OffscreenCanvas(bmp.width, bmp.height);
          var ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法创建视觉对比画布');
          ctx.drawImage(bmp, 0, 0);
          return ctx.getImageData(0, 0, bmp.width, bmp.height);
        } finally {
          bmp.close();
        }
      });
    }

    function diffImageData(a, b) {
      if (a.width !== b.width || a.height !== b.height) {
        return { mismatchPct: 100, sizeMismatch: true };
      }
      var tolerance = 24;
      var total = a.width * a.height;
      var diff = 0;
      var da = a.data, db = b.data;
      for (var i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) > tolerance
          || Math.abs(da[i + 1] - db[i + 1]) > tolerance
          || Math.abs(da[i + 2] - db[i + 2]) > tolerance) diff++;
      }
      return { mismatchPct: Math.round(diff / total * 10000) / 100 };
    }

    function execAssertScreenshot(node, params, execution) {
      params = params || {};
      ensureNotStopped(execution);
      var key = params.baselineKey || ('node:' + (node.nodeId || node.type));
      if (/^(?:__proto__|prototype|constructor)$/.test(key)) throw new Error('视觉基线标识不能使用原型保留字段');
      return captureScreenshotForPage(node.pageId, 80, params, execution).then(function (currentUrl) {
        return getBaselines(execution).then(function (map) {
          ensureNotStopped(execution);
          var baseline = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
          if (!baseline || params.updateBaseline) {
            return saveBaseline(key, { dataUrl: currentUrl, updatedAt: Date.now() }, execution).then(function () {
              ensureNotStopped(execution);
              log(execution, (baseline ? '已更新' : '首次运行，已保存') + '视觉基线: ' + key);
              return assertionResult(true, { baselineCreated: true }, { baselineKey: key }, '视觉基线已经建立', { baselineCreated: true, baselineKey: key });
            });
          }
          return Promise.all([
            dataUrlToImageData(baseline.dataUrl, execution),
            dataUrlToImageData(currentUrl, execution),
          ]).then(function (imgs) {
            var r = diffImageData(imgs[0], imgs[1]);
            var threshold = Number(params.mismatchThresholdPct);
            if (isNaN(threshold)) threshold = 1;
            if (r.sizeMismatch) {
              return assertionResult(false, r, { mismatchThresholdPct: threshold }, '视觉对比尺寸不一致（基线与当前截图分辨率不同，窗口大小变化或显示缩放导致；可勾选「更新基线」重新采集）');
            }
            if (r.mismatchPct > threshold) {
              return assertionResult(false, r, { mismatchThresholdPct: threshold }, '视觉差异 ' + r.mismatchPct + '% 超过阈值 ' + threshold + '%（基线: ' + key + '，改版后可勾选「更新基线」）');
            }
            log(execution, '视觉对比通过: 差异 ' + r.mismatchPct + '% ≤ ' + threshold + '%');
            return assertionResult(true, r, { mismatchThresholdPct: threshold }, '视觉差异在阈值内', { mismatchPct: r.mismatchPct, baselineKey: key });
          });
        });
      });
    }

    return {
      captureScreenshotForPage: captureScreenshotForPage,
      execScreenshot: execScreenshot,
      execAssertScreenshot: execAssertScreenshot,
    };
  }

  return {
    createVisualNodes: createVisualNodes,
  };
});
