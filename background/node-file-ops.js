// File, download, and close-page node helpers.
(function attachNodeFileOps(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NodeFileOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createFileOps(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || function () {};
    var throwIfStopped = deps.throwIfStopped || function () {};
    var sleep = deps.sleep || function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };
    var fetchImpl = deps.fetch || globalThis.fetch;
    var getRunCtx = deps.getRunCtx || function () { return {}; };
    var pageSource = deps.pageSource || function (pageId) { return 'page:' + pageId; };
    var tabRuntime = deps.tabRuntime || {};
    var requireRuntimeTabId = deps.requireRuntimeTabId || function (params) {
      var tabId = Number(params && (params.tabId || params.activeTabId) || 0) || 0;
      return tabId ? Promise.resolve(tabId) : Promise.resolve(0);
    };
    var getRememberedPageTabId = typeof deps.getRememberedPageTabId === 'function'
      ? deps.getRememberedPageTabId
      : function () { return Promise.resolve(0); };
    var executePageCommand = deps.executePageCommand;
    if (typeof executePageCommand !== 'function') throw new Error('NodeFileOps requires the unified page command runtime');
    var preparePageCommandTab = typeof tabRuntime.preparePageCommandTab === 'function'
      ? tabRuntime.preparePageCommandTab.bind(tabRuntime)
      : function (tabId) { return Promise.resolve(tabId); };

    function log(execution, message, options) {
      return execution && execution.addLog
        ? execution.addLog(message, options)
        : addLog(message, options);
    }

    function ensureNotStopped(execution) {
      throwIfStopped();
      if (execution && execution.signal && execution.signal.aborted) {
        throw execution.signal.reason instanceof Error ? execution.signal.reason : new Error('文件操作已停止');
      }
    }

    function delayWithStop(ms, execution) {
      ensureNotStopped(execution);
      var signal = execution && execution.signal;
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(sleep(ms));
      function removeAbortListener(listener) {
        if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', listener);
      }
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          removeAbortListener(onAbort);
          resolve();
        }, Math.max(0, Number(ms) || 0));
        function onAbort() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          removeAbortListener(onAbort);
          reject(signal.reason instanceof Error ? signal.reason : new Error('文件操作已停止'));
        }
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }

    function markUncertain(error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        try {
          error.performed = 'unknown';
          error.retryable = false;
        } catch (_) {}
      }
      return error;
    }

    function execClosePage(pageId, params, execution) {
      params = params || {};
      var resolveTabId = pageId
        ? getRememberedPageTabId(pageId)
        : requireRuntimeTabId(params, 'closePage');
      return resolveTabId.then(function (tabId) {
      if (!tabId) return Promise.resolve({ closed: false });
      return executePageCommand('closeTab', Object.assign({}, params, { tabId: tabId }), execution).then(function (result) {
        log(execution, '已关闭标签页: tabId=' + tabId + (pageId ? ' pageLabel=' + pageId : ''));
        return Object.assign({}, result, { closed: result.closed === true, tabId: tabId });
      });
      });
    }

    function execWaitDownload(params, execution) {
      params = params || {};
      ensureNotStopped(execution);
      if (!chrome.downloads || !chrome.downloads.search) {
        throw new Error('downloads 权限不可用：请确认 manifest 已声明 "downloads" 并重新加载扩展');
      }
      var startedAfter = Date.now() - 2000;
      var deadline = Date.now() + (Number(params.timeoutMs) || 60000);
      var regex = params.filenamePattern ? new RegExp(params.filenamePattern) : null;

      function baseName(item) {
        return String(item.filename || '').split(/[\\/]/).pop();
      }

      function poll() {
        throwIfStopped();
        ensureNotStopped(execution);
        return chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 }).then(function (items) {
          var match = null;
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var started = new Date(it.startTime).getTime();
            if (started < startedAfter) continue;
            if (regex && !regex.test(baseName(it)) && !regex.test(it.url || '')) continue;
            match = it;
            break;
          }
          if (match && match.state === 'complete') {
            log(execution, '下载完成: ' + baseName(match) + '（' + match.fileSize + ' 字节）');
            return { downloadId: match.id, fileName: baseName(match), filePath: match.filename, fileSize: match.fileSize, mime: match.mime || '', state: 'complete' };
          }
          if (match && match.state === 'interrupted') {
            throw new Error('下载已中断: ' + baseName(match) + (match.error ? '（' + match.error + '）' : ''));
          }
          if (Date.now() >= deadline) {
            throw new Error('等待下载超时' + (params.filenamePattern ? '（文件名正则: ' + params.filenamePattern + '）' : '') + (match ? '，下载仍在进行中' : '，未发现新下载任务'));
          }
          return delayWithStop(500, execution).then(poll);
        });
      }
      return poll();
    }

    function ensureDownloadsApi(method) {
      if (!chrome.downloads || !chrome.downloads[method]) {
        throw new Error('downloads 权限不可用：请确认 manifest 已声明 "downloads" 并重新加载扩展');
      }
    }

    function downloadBaseName(item) {
      return String((item && item.filename) || '').split(/[\\/]/).pop();
    }

    function sanitizeDownloadPath(directory, fileName) {
      var rawDir = String(directory || '').trim();
      var rawName = String(fileName || '').trim();
      if (!rawName) throw new Error('保存文件缺少文件名');

      var raw = (rawDir ? rawDir + '/' : '') + rawName;
      raw = raw.replace(/\\/g, '/').replace(/\0/g, '');
      if (/^\s*(?:\/|~|[a-zA-Z]:)/.test(raw)) {
        throw new Error('保存路径必须是下载目录下的相对路径，不能使用系统绝对路径: ' + raw);
      }

      var parts = raw.split('/');
      var cleaned = [];
      for (var i = 0; i < parts.length; i++) {
        var part = String(parts[i] || '').trim();
        if (!part || part === '.') continue;
        if (part === '..') {
          throw new Error('保存路径不能包含 .. : ' + raw);
        }
        part = part.replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '');
        if (!part) part = '_';
        cleaned.push(part);
      }
      if (!cleaned.length) throw new Error('保存路径为空');
      return cleaned.join('/');
    }

    function inferMimeFromFilename(filename, fallback) {
      var lower = String(filename || '').toLowerCase();
      if (/\.json$/.test(lower)) return 'application/json';
      if (/\.csv$/.test(lower)) return 'text/csv;charset=utf-8';
      if (/\.txt$/.test(lower)) return 'text/plain;charset=utf-8';
      if (/\.html?$/.test(lower)) return 'text/html;charset=utf-8';
      if (/\.xml$/.test(lower)) return 'application/xml';
      if (/\.jpe?g$/.test(lower)) return 'image/jpeg';
      if (/\.png$/.test(lower)) return 'image/png';
      if (/\.gif$/.test(lower)) return 'image/gif';
      if (/\.webp$/.test(lower)) return 'image/webp';
      if (/\.pdf$/.test(lower)) return 'application/pdf';
      return fallback || 'application/octet-stream';
    }

    function cleanMimeType(mimeType, fallback) {
      var mime = String(mimeType || '').trim();
      if (!mime) return fallback || 'application/octet-stream';
      if (/[\r\n,]/.test(mime)) throw new Error('MIME 类型包含非法字符');
      return mime;
    }

    function bytesToBase64(bytes) {
      var binary = '';
      var chunkSize = 0x8000;
      for (var i = 0; i < bytes.length; i += chunkSize) {
        var chunk = bytes.subarray(i, i + chunkSize);
        for (var j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
      }
      return btoa(binary);
    }

    function utf8ToBase64(text) {
      return bytesToBase64(new TextEncoder().encode(String(text)));
    }

    function byteLengthUtf8(text) {
      return new TextEncoder().encode(String(text)).length;
    }

    function stringifyJsonValue(value, pretty) {
      if (typeof value === 'string') {
        var trimmed = value.trim();
        if (trimmed) {
          try {
            return JSON.stringify(JSON.parse(trimmed), null, pretty ? 2 : 0);
          } catch (_) {}
        }
      }
      try {
        return JSON.stringify(value === undefined ? null : value, null, pretty ? 2 : 0);
      } catch (err) {
        throw new Error('保存 JSON 序列化失败: ' + err.message);
      }
    }

    function valueToText(value) {
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
    }

    function extractDataUrlMime(dataUrl) {
      var m = /^data:([^;,]+)?[;,]/i.exec(String(dataUrl || ''));
      return (m && m[1]) || '';
    }

    function estimateBase64Size(base64) {
      var clean = String(base64 || '').replace(/\s+/g, '');
      if (!clean) return 0;
      var padding = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
      return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
    }

    function estimateDataUrlSize(dataUrl) {
      var str = String(dataUrl || '');
      var comma = str.indexOf(',');
      if (comma === -1) return str.length;
      var meta = str.slice(0, comma);
      var body = str.slice(comma + 1);
      if (/;base64/i.test(meta)) return estimateBase64Size(body);
      try { return decodeURIComponent(body).length; } catch (_) { return body.length; }
    }

    function resolveSaveFileSource(params) {
      var runCtx = getRunCtx() || {};
      var mode = params.sourceMode || 'last';
      if (mode === 'literal') return params.content;
      if (mode === 'variable') {
        var path = params.sourcePath || 'last';
        var resolved = globalThis.Template.resolvePath(runCtx, path);
        if (resolved === undefined) throw new Error('保存文件变量不存在: ' + path);
        return resolved;
      }
      if (runCtx.last === undefined) throw new Error('保存文件没有可用的上一节点输出');
      var FlowData = globalThis.FlowData;
      var lastContent = FlowData ? FlowData.getContent(runCtx.last) : globalThis.Template.resolvePath(runCtx, 'last');
      if (lastContent === undefined) throw new Error('保存文件没有可用的上一节点输出');
      return lastContent;
    }

    function resolveMediaSource(params) {
      var runCtx = getRunCtx() || {};
      var mode = params.sourceMode || 'last';
      var value;
      if (mode === 'literal') value = params.content;
      else if (mode === 'variable') {
        value = globalThis.Template.resolvePath(runCtx, params.sourcePath || 'last');
        if (value === undefined) throw new Error('多媒体下载变量不存在: ' + (params.sourcePath || 'last'));
      } else {
        value = runCtx.last;
        if (value === undefined) throw new Error('多媒体下载没有可用的上一节点输出');
      }
      var FlowData = globalThis.FlowData;
      if (FlowData && FlowData.isFlowData(value)) value = FlowData.getContent(value);
      if (typeof value === 'string') return value;
      if ((params.sourceFormat || 'auto') === 'urlList' && Array.isArray(value)) return JSON.stringify(value);
      throw new Error('多媒体下载输入必须是 HTML、Markdown 字符串或 URL 数组');
    }

    function buildDownloadPayload(value, params, relativePath) {
      var requestedFormat = params.format || 'auto';
      var format = requestedFormat;
      if (format === 'auto') {
        if (typeof value === 'string' && /^data:/i.test(value.trim())) format = 'dataUrl';
        else if (value && typeof value === 'object') format = 'json';
        else format = 'text';
      }

      if (format === 'dataUrl') {
        var dataUrl = String(value || '').trim();
        if (!/^data:/i.test(dataUrl)) throw new Error('Data URL 格式必须以 data: 开头');
        var dataUrlMime = extractDataUrlMime(dataUrl);
        return {
          url: dataUrl,
          mime: dataUrlMime || cleanMimeType(params.mimeType, inferMimeFromFilename(relativePath)),
          size: estimateDataUrlSize(dataUrl),
          format: format,
        };
      }

      if (format === 'base64') {
        var raw = String(value || '').trim();
        if (/^data:/i.test(raw)) {
          var comma = raw.indexOf(',');
          raw = comma === -1 ? '' : raw.slice(comma + 1);
        }
        var base64 = raw.replace(/\s+/g, '');
        if (base64 && !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
          throw new Error('Base64 内容格式无效');
        }
        var base64Mime = cleanMimeType(params.mimeType, inferMimeFromFilename(relativePath));
        return {
          url: 'data:' + base64Mime + ';base64,' + base64,
          mime: base64Mime,
          size: estimateBase64Size(base64),
          format: format,
        };
      }

      var text;
      if (format === 'json') text = stringifyJsonValue(value, params.prettyJson !== false);
      else if (format === 'text') text = valueToText(value);
      else throw new Error('未知保存格式: ' + format);

      if (params.addUtf8Bom) text = '\uFEFF' + text;
      var fallbackMime = format === 'json' ? 'application/json' : inferMimeFromFilename(relativePath, 'text/plain;charset=utf-8');
      var mime = cleanMimeType(params.mimeType, fallbackMime);
      return {
        url: 'data:' + mime + ';base64,' + utf8ToBase64(text),
        mime: mime,
        size: byteLengthUtf8(text),
        format: format,
      };
    }

    function normalizeConflictAction(action) {
      var value = action || 'uniquify';
      if (value === 'uniquify' || value === 'overwrite' || value === 'prompt') return value;
      return 'uniquify';
    }

    function normalizeSaveFileParams(raw) {
      var NodeTypesApi = globalThis.NodeTypes;
      if (NodeTypesApi && NodeTypesApi.normalizeParams) {
        return NodeTypesApi.normalizeParams('saveFile', raw || {});
      }
      return Object.assign({
        directory: 'PageAgent',
        fileName: 'data.json',
        sourceMode: 'last',
        sourcePath: 'last',
        content: '',
        format: 'auto',
        mimeType: '',
        prettyJson: true,
        addUtf8Bom: false,
        conflictAction: 'uniquify',
        saveAs: false,
        waitComplete: true,
        timeoutMs: 60000,
      }, raw || {});
    }

    function waitDownloadById(downloadId, timeoutMs, execution) {
      var deadline = Date.now() + (Number(timeoutMs) || 60000);
      function poll() {
        ensureNotStopped(execution);
        return chrome.downloads.search({ id: downloadId }).then(function (items) {
          var item = items && items[0];
          if (!item) throw new Error('下载任务不存在: ' + downloadId);
          if (item.state === 'complete') {
            return {
              downloadId: downloadId,
              fileName: downloadBaseName(item),
              filePath: item.filename || '',
              fileSize: item.fileSize || 0,
              mime: item.mime || '',
              state: item.state,
            };
          }
          if (item.state === 'interrupted') {
            throw new Error('下载已中断: ' + downloadBaseName(item) + (item.error ? '（' + item.error + '）' : ''));
          }
          if (Date.now() >= deadline) {
            throw new Error('保存文件超时: ' + downloadBaseName(item));
          }
          return delayWithStop(500, execution).then(poll);
        });
      }
      return poll();
    }

    function execSaveFile(rawParams, execution) {
      ensureDownloadsApi('download');
      ensureDownloadsApi('search');
      ensureNotStopped(execution);

      var params = normalizeSaveFileParams(rawParams);
      var relativePath = sanitizeDownloadPath(params.directory, params.fileName);
      var value = resolveSaveFileSource(params);
      if (params.format === 'text' && value && typeof value === 'object') {
        log(execution, '保存格式为 text，但实际输入是对象；将序列化为 JSON 文本。请检查 sourcePath 是否指向具体字符串字段。', { level: 'warn' });
      }
      var payload = buildDownloadPayload(value, params, relativePath);
      var details = {
        url: payload.url,
        filename: relativePath,
        conflictAction: normalizeConflictAction(params.conflictAction),
        saveAs: params.saveAs === true,
      };

      log(execution, '保存文件到下载目录: ' + relativePath + '（' + payload.format + ', 约 ' + payload.size + ' 字节）');
      var dispatchStarted = false;
      return Promise.resolve().then(function () {
        ensureNotStopped(execution);
        dispatchStarted = true;
        return chrome.downloads.download(details);
      }).then(function (downloadId) {
        // Cancellation may arrive immediately after Chrome accepts the
        // download. Check before publishing a started/completed result so a
        // dispatched download is never reported as a clean success.
        ensureNotStopped(execution);
        if (params.waitComplete === false) {
          return {
            downloadId: downloadId,
            fileName: relativePath.split('/').pop(),
            filePath: '',
            relativePath: relativePath,
            fileSize: payload.size,
            mime: payload.mime,
            state: 'started',
          };
        }
        return waitDownloadById(downloadId, params.timeoutMs, execution).then(function (result) {
          result.relativePath = relativePath;
          if (!result.mime) result.mime = payload.mime;
          log(execution, '文件保存完成: ' + result.fileName + '（' + result.fileSize + ' 字节）');
          return result;
        });
      }).catch(function (error) {
        if (dispatchStarted) throw markUncertain(error);
        throw error;
      });
    }

    function normalizeMediaParams(raw) {
      var NodeTypesApi = globalThis.NodeTypes;
      if (NodeTypesApi && NodeTypesApi.normalizeParams) {
        return NodeTypesApi.normalizeParams('downloadMedia', raw || {});
      }
      return Object.assign({
        sourceMode: 'last',
        sourcePath: 'last',
        content: '',
        sourceFormat: 'auto',
        baseUrl: '',
        directory: 'PageAgent/assets',
        linkPrefix: 'assets',
        downloadImages: true,
        downloadVideo: true,
        downloadAudio: true,
        downloadStreams: true,
        rewriteLinks: true,
        maxAssets: 500,
        concurrency: 3,
        continueOnError: true,
        waitComplete: true,
        timeoutMs: 120000,
        tabId: '',
        residentResourceMode: 'auto',
        maxResidentAssetBytes: 20 * 1024 * 1024,
        maxResidentTotalBytes: 64 * 1024 * 1024,
      }, raw || {});
    }

    function sanitizeLinkPrefix(value) {
      var raw = String(value || '').trim().replace(/\\/g, '/');
      if (!raw) return '';
      if (/^(?:\/|~|[a-zA-Z]:)/.test(raw)) throw new Error('正文资源路径必须是相对路径: ' + raw);
      var parts = raw.split('/').filter(function (part) { return part && part !== '.'; });
      if (parts.some(function (part) { return part === '..'; })) throw new Error('正文资源路径不能包含 .. : ' + raw);
      return parts.join('/');
    }

    function joinLocalLink(prefix, fileName) {
      return prefix ? prefix.replace(/\/$/, '') + '/' + fileName : fileName;
    }

    function fallbackExtension(type) {
      if (type === 'hls') return '.m3u8';
      if (type === 'dash') return '.mpd';
      return '';
    }

    function runPool(items, concurrency, worker) {
      var next = 0;
      var results = new Array(items.length);
      var count = Math.max(1, Math.min(Number(concurrency) || 1, 10, items.length || 1));
      var schedulingStopped = false;
      var firstError = null;
      function runner() {
        if (schedulingStopped) return Promise.resolve();
        var index = next++;
        if (index >= items.length) return Promise.resolve();
        return Promise.resolve().then(function () { return worker(items[index], index); })
          .then(function (value) { results[index] = value; })
          .catch(function (error) {
            schedulingStopped = true;
            if (!firstError) firstError = error;
          })
          .then(runner);
      }
      var runners = [];
      for (var i = 0; i < count; i++) runners.push(runner());
      return Promise.all(runners).then(function () {
        if (firstError) throw firstError;
        return results;
      });
    }

    function normalizeResidentResourceMode(value) {
      value = String(value || 'auto').toLowerCase();
      return value === 'required' || value === 'off' ? value : 'auto';
    }

    function safeMediaUrlLabel(value) {
      try {
        var parsed = new URL(String(value || ''));
        parsed.search = '';
        parsed.hash = '';
        return parsed.href;
      } catch (_) { return String(value || '').slice(0, 500); }
    }

    function dataUrlText(dataUrl) {
      var value = String(dataUrl || '');
      var match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(value);
      if (!match) throw new Error('驻留资源不是有效 Data URL');
      if (!match[2]) {
        try { return decodeURIComponent(match[3]); } catch (_) { return match[3]; }
      }
      var binary = atob(String(match[3] || '').replace(/\s+/g, ''));
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }

    function execDownloadMedia(rawParams, execution) {
      ensureDownloadsApi('download');
      ensureDownloadsApi('search');
      ensureNotStopped(execution);
      var media = globalThis.MediaResources;
      if (!media || typeof media.discover !== 'function') throw new Error('多媒体资源模块未加载');
      if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持读取 HLS 播放列表');

      var params = normalizeMediaParams(rawParams);
      var source = resolveMediaSource(params);
      var directory = sanitizeDownloadPath('', params.directory || 'PageAgent/assets');
      var linkPrefix = sanitizeLinkPrefix(params.linkPrefix);
      var maxAssets = Math.max(1, Number(params.maxAssets) || 500);
      var residentMode = normalizeResidentResourceMode(params.residentResourceMode);
      var maxResidentAssetBytes = Math.max(1024, Number(params.maxResidentAssetBytes) || 20 * 1024 * 1024);
      var maxResidentTotalBytes = Math.max(maxResidentAssetBytes, Number(params.maxResidentTotalBytes) || 64 * 1024 * 1024);
      var allocateName = media.createNameAllocator();
      var warnings = [];
      if (!String(params.baseUrl || '').trim() && (params.sourceFormat || 'auto') !== 'urlList') {
        warnings.push('未提供 baseUrl；无法解析的相对媒体地址将被跳过');
      }
      if (/\bblob:/i.test(source)) {
        warnings.push('检测到 blob: 媒体地址；它只在原页面会话中有效，downloadMedia 不会把它当成可下载 URL');
      }
      var plan = [];
      var plannedByUrl = Object.create(null);
      var plannedItemByUrl = Object.create(null);
      var hlsByUrl = Object.create(null);
      var planningFailures = [];
      var residentByUrl = Object.create(null);
      var residentAttempted = Object.create(null);
      var residentTabId = 0;
      var residentDisabled = residentMode === 'off';
      var residentWarningAdded = false;
      var residentStats = { hitCount: 0, missCount: 0, tooLargeCount: 0, byteLength: 0, networkFetchCount: 0 };
      var candidates = media.discover(source, {
        format: params.sourceFormat || 'auto',
        baseUrl: params.baseUrl || '',
        images: params.downloadImages !== false,
        video: params.downloadVideo !== false,
        audio: params.downloadAudio !== false,
        streams: params.downloadStreams !== false,
      });

      function reserve(item) {
        if (plan.length >= maxAssets) {
          throw new Error('多媒体资源数量超过上限 ' + maxAssets + '；请提高 maxAssets 或缩小正文范围');
        }
        plan.push(item);
        if (item.sourceUrl) {
          plannedByUrl[item.sourceUrl] = item.fileName;
          plannedItemByUrl[item.sourceUrl] = item;
        }
        return item.fileName;
      }

      function addStreamRoot(item, streamRoot) {
        if (!streamRoot || !item) return;
        item.streamRoots = item.streamRoots || [];
        if (item.streamRoots.indexOf(streamRoot) === -1) item.streamRoots.push(streamRoot);
      }

      function reserveDirect(url, type, streamRoot) {
        if (plannedByUrl[url]) {
          addStreamRoot(plannedItemByUrl[url], streamRoot);
          return plannedByUrl[url];
        }
        var fileName = allocateName(media.fileNameFromUrl(url, fallbackExtension(type)));
        var item = { sourceUrl: url, downloadUrl: url, fileName: fileName, type: type };
        addStreamRoot(item, streamRoot);
        reserve(item);
        return fileName;
      }

      function configuredResidentTabId() {
        var runCtx = getRunCtx() || {};
        var values = [params.tabId, params.activeTabId, runCtx.tabId, runCtx.currentTabId, runCtx.activeTabId];
        for (var index = 0; index < values.length; index += 1) {
          var value = Number(values[index]);
          if (Number.isInteger(value) && value > 0) return value;
        }
        return 0;
      }

      function residentWarning(message) {
        if (residentWarningAdded) return;
        residentWarningAdded = true;
        warnings.push(message);
      }

      function prepareResidentContext() {
        if (residentDisabled) return Promise.resolve(0);
        var requestedTabId = configuredResidentTabId();
        if (!requestedTabId) {
          residentDisabled = true;
          if (residentMode === 'required') throw new Error('页面驻留资源模式为 required，但没有有效 tabId');
          residentWarning('未提供有效 tabId；无法复用页面驻留资源，本节点退回原网络下载路径');
          return Promise.resolve(0);
        }
        return requireRuntimeTabId({ tabId: requestedTabId }, 'downloadMedia 页面驻留资源读取').then(function (tabId) {
          residentTabId = Number(tabId) || 0;
          return preparePageCommandTab(residentTabId, params).then(function () { return residentTabId; });
        }).catch(function (error) {
          ensureNotStopped(execution);
          residentDisabled = true;
          if (residentMode === 'required') throw error;
          residentWarning('页面驻留资源 tab 不可用；本节点退回原网络下载路径: ' + (error && error.message || error));
          return 0;
        });
      }

      function readResidentBatch(urls) {
        if (residentDisabled || !residentTabId) return Promise.resolve();
        var unique = [];
        (urls || []).forEach(function (url) {
          url = String(url || '');
          if (!/^https?:/i.test(url) || residentAttempted[url]) return;
          residentAttempted[url] = true;
          unique.push(url);
        });
        if (!unique.length) return Promise.resolve();
        var remainingBytes = Math.max(0, maxResidentTotalBytes - residentStats.byteLength);
        if (!remainingBytes) {
          unique.forEach(function (url) {
            residentByUrl[url] = { url: url, status: 'too-large', reason: 'node-total-limit' };
            residentStats.tooLargeCount += 1;
          });
          return Promise.resolve();
        }
        return executePageCommand('resourceCacheReadMany', {
          tabId: residentTabId,
          requests: unique.map(function (url) { return { url: url, maxBytes: maxResidentAssetBytes }; }),
          maxAssetBytes: maxResidentAssetBytes,
          maxTotalBytes: remainingBytes,
          timeoutMs: Math.max(30000, Math.min(120000, Number(params.timeoutMs) || 120000)),
        }, execution).then(function (summary) {
          (summary.results || []).forEach(function (item) {
            residentByUrl[item.url] = item;
            if (item.status === 'hit') {
              residentStats.hitCount += 1;
              residentStats.byteLength += Math.max(0, Number(item.byteLength) || 0);
            } else if (item.status === 'too-large') residentStats.tooLargeCount += 1;
            else residentStats.missCount += 1;
          });
        }).catch(function (error) {
          ensureNotStopped(execution);
          unique.forEach(function (url) {
            residentByUrl[url] = { url: url, status: 'unavailable', reason: 'cache-reader-unavailable' };
            residentStats.missCount += 1;
          });
          residentDisabled = true;
          if (residentMode === 'required') return;
          residentWarning('页面驻留资源读取失败；未命中资源将走网络下载: ' + (error && error.message || error));
        });
      }

      function ensureResidentUrl(url) {
        if (residentAttempted[url] || residentDisabled || !residentTabId) return Promise.resolve();
        return readResidentBatch([url]);
      }

      function fetchText(url) {
        return ensureResidentUrl(url).then(function () {
          var resident = residentByUrl[url];
          if (resident && resident.status === 'hit') {
            try {
              return { text: dataUrlText(resident.dataUrl), finalUrl: url, acquisitionSource: 'page-resource-cache' };
            } catch (decodeError) {
              residentByUrl[url] = { url: url, status: 'miss', reason: 'resident-text-decode-failed' };
              residentStats.hitCount = Math.max(0, residentStats.hitCount - 1);
              residentStats.byteLength = Math.max(0, residentStats.byteLength - (Number(resident.byteLength) || 0));
              residentStats.missCount += 1;
            }
          }
          if (residentMode === 'required') {
            throw new Error('页面驻留资源未命中，required 模式禁止网络读取: ' + safeMediaUrlLabel(url));
          }
          residentStats.networkFetchCount += 1;
          var controller = new AbortController();
          var parentSignal = execution && execution.signal;
          var forwardAbort = null;
          var timeoutMs = Number(params.timeoutMs);
          timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.max(1000, Math.min(timeoutMs, 10 * 60 * 1000)) : 120000;
          if (parentSignal && parentSignal.aborted) {
            throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error('多媒体读取已停止');
          }
          if (parentSignal && typeof parentSignal.addEventListener === 'function') {
            forwardAbort = function () {
              try { controller.abort(parentSignal.reason); } catch (_) { controller.abort(); }
            };
            parentSignal.addEventListener('abort', forwardAbort, { once: true });
          }
          var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
          return Promise.resolve().then(function () {
            return fetchImpl(url, { credentials: 'include', redirect: 'follow', signal: controller.signal });
          }).then(function (response) {
            if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status || 0));
            return response.text().then(function (text) {
              return { text: text, finalUrl: response.url || url, acquisitionSource: 'network-download' };
            });
          }).catch(function (error) {
            if (error && error.name === 'AbortError') {
              if (parentSignal && parentSignal.aborted) {
                throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error('多媒体读取已停止');
              }
              throw new Error('读取媒体清单超时 (' + timeoutMs + 'ms): ' + safeMediaUrlLabel(url));
            }
            throw error;
          }).finally(function () {
            clearTimeout(timer);
            if (parentSignal && forwardAbort && typeof parentSignal.removeEventListener === 'function') {
              try { parentSignal.removeEventListener('abort', forwardAbort); } catch (_) {}
            }
          });
        });
      }

      function planHls(url, streamRoot) {
        streamRoot = streamRoot || url;
        var hlsKey = streamRoot + '|' + url;
        if (hlsByUrl[hlsKey]) return hlsByUrl[hlsKey];
        var task = Promise.resolve().then(function () {
          var playlistName = allocateName(media.fileNameFromUrl(url, '.m3u8'));
          // Reserve the URL immediately so recursive/cyclic manifests cannot loop forever.
          hlsByUrl[hlsKey] = Promise.resolve(playlistName);
          return fetchText(url).then(function (fetched) {
            var text = String(fetched.text || '').replace(/\r\n?/g, '\n');
            var refs = media.hlsReferences(text, fetched.finalUrl || url);
            var localByUrl = Object.create(null);
            var chain = Promise.resolve();
            refs.forEach(function (ref) {
              chain = chain.then(function () {
                if (localByUrl[ref.url]) return;
                if (ref.playlist) {
                  return planHls(ref.url, streamRoot).then(function (childName) { localByUrl[ref.url] = childName; });
                }
                localByUrl[ref.url] = reserveDirect(ref.url, 'hls-asset', streamRoot);
              });
            });
            return chain.then(function () {
              var localized = media.rewrite(text, refs, localByUrl);
              var playlistItem = {
                sourceUrl: url,
                downloadUrl: 'data:application/vnd.apple.mpegurl;base64,' + utf8ToBase64(localized),
                fileName: playlistName,
                type: 'hls-playlist',
                acquisitionSource: 'generated-localization',
                residentStatus: fetched.acquisitionSource === 'page-resource-cache' ? 'source-hit' : 'source-miss',
              };
              addStreamRoot(playlistItem, streamRoot);
              reserve(playlistItem);
              plannedByUrl[url] = playlistName;
              return playlistName;
            });
          });
        });
        hlsByUrl[hlsKey] = task;
        return task;
      }

      var roots = Object.create(null);
      var planning = Promise.resolve().then(prepareResidentContext).then(function () {
        return readResidentBatch(candidates.map(function (candidate) { return candidate.url; }));
      });
      candidates.forEach(function (candidate) {
        if (roots[candidate.url]) return;
        roots[candidate.url] = true;
        planning = planning.then(function () {
          if (candidate.type === 'hls') return planHls(candidate.url, candidate.url);
          if (candidate.type === 'dash') {
            warnings.push('DASH 当前仅保存 MPD 清单，不合并分片: ' + safeMediaUrlLabel(candidate.url));
          }
          return reserveDirect(candidate.url, candidate.type);
        }).catch(function (err) {
          ensureNotStopped(execution);
          var message = err && err.message || String(err);
          warnings.push('资源规划失败: ' + safeMediaUrlLabel(candidate.url) + ' — ' + message);
          planningFailures.push({
            sourceUrl: candidate.url,
            type: candidate.type,
            streamRoots: candidate.type === 'hls' ? [candidate.url] : [],
            relativePath: '',
            localPath: '',
            state: 'failed',
            error: message,
            acquisitionSource: '',
            residentStatus: residentByUrl[candidate.url] && residentByUrl[candidate.url].status || 'miss',
          });
          if (params.continueOnError === false) throw err;
          return null;
        });
      });

      return planning.then(function () {
        return readResidentBatch(plan.filter(function (item) {
          return item && item.downloadUrl === item.sourceUrl;
        }).map(function (item) { return item.sourceUrl; }));
      }).then(function () {
        plan.forEach(function (item) {
          if (item.acquisitionSource === 'generated-localization') return;
          var resident = residentByUrl[item.sourceUrl];
          if (resident && resident.status === 'hit') {
            item.downloadUrl = resident.dataUrl;
            item.acquisitionSource = 'page-resource-cache';
            item.residentStatus = 'hit';
            return;
          }
          item.residentStatus = resident && resident.status || (residentMode === 'off' ? 'off' : 'miss');
          if (residentMode === 'required') {
            item.blockedError = '页面驻留资源未命中，required 模式禁止网络下载';
            item.acquisitionSource = '';
          } else item.acquisitionSource = 'network-download';
        });
        if (residentMode === 'required') {
          var blockedStreams = Object.create(null);
          planningFailures.forEach(function (failure) {
            (failure.streamRoots || []).forEach(function (streamRoot) { blockedStreams[streamRoot] = true; });
          });
          plan.forEach(function (item) {
            if (!item.blockedError) return;
            (item.streamRoots || []).forEach(function (streamRoot) { blockedStreams[streamRoot] = true; });
          });
          if (Object.keys(blockedStreams).length) {
            plan.forEach(function (item) {
              var belongsToBlockedStream = (item.streamRoots || []).some(function (streamRoot) {
                return blockedStreams[streamRoot];
              });
              if (!belongsToBlockedStream) return;
              item.blockedError = 'HLS 页面驻留资源包不完整，required 模式不写入部分资源';
            });
          }
        }
        log(execution, '发现多媒体引用 ' + candidates.length + ' 个，计划下载 ' + plan.length + ' 个文件');

        var anyDownloadDispatched = false;
        return runPool(plan, params.concurrency, function (item) {
          ensureNotStopped(execution);
          var relativePath = sanitizeDownloadPath(directory, item.fileName);
          if (item.blockedError) {
            if (params.continueOnError === false) throw new Error(item.blockedError + ': ' + safeMediaUrlLabel(item.sourceUrl));
            warnings.push('驻留资源未命中: ' + safeMediaUrlLabel(item.sourceUrl) + ' — required 模式未访问网络');
            return {
              sourceUrl: item.sourceUrl,
              type: item.type,
              streamRoots: item.streamRoots || [],
              relativePath: relativePath,
              localPath: joinLocalLink(linkPrefix, item.fileName),
              state: 'failed',
              error: item.blockedError,
              acquisitionSource: '',
              residentStatus: item.residentStatus,
            };
          }
          var dispatchStarted = false;
          return Promise.resolve().then(function () {
            ensureNotStopped(execution);
            dispatchStarted = true;
            anyDownloadDispatched = true;
            return chrome.downloads.download({
              url: item.downloadUrl,
              filename: relativePath,
              conflictAction: 'overwrite',
              saveAs: false,
            });
          }).then(function (downloadId) {
            // The download may have been dispatched while cancellation raced
            // with the callback. Do not publish a started result in that case;
            // the outer uncertainty handling will preserve performed=unknown.
            ensureNotStopped(execution);
            if (params.waitComplete === false) {
              return { sourceUrl: item.sourceUrl, type: item.type, streamRoots: item.streamRoots || [], downloadId: downloadId, relativePath: relativePath, localPath: joinLocalLink(linkPrefix, item.fileName), state: 'started', acquisitionSource: item.acquisitionSource, residentStatus: item.residentStatus };
            }
            return waitDownloadById(downloadId, params.timeoutMs, execution).then(function (result) {
              return Object.assign(result, { sourceUrl: item.sourceUrl, type: item.type, streamRoots: item.streamRoots || [], relativePath: relativePath, localPath: joinLocalLink(linkPrefix, item.fileName), acquisitionSource: item.acquisitionSource, residentStatus: item.residentStatus });
            });
          }).catch(function (err) {
            ensureNotStopped(execution);
            var message = err && err.message || String(err);
            if (params.continueOnError === false) throw dispatchStarted ? markUncertain(err) : err;
            warnings.push('下载失败: ' + safeMediaUrlLabel(item.sourceUrl) + ' — ' + message);
            return Object.assign({ sourceUrl: item.sourceUrl, type: item.type, streamRoots: item.streamRoots || [], relativePath: relativePath, localPath: joinLocalLink(linkPrefix, item.fileName), state: 'failed', error: message, acquisitionSource: item.acquisitionSource, residentStatus: item.residentStatus }, dispatchStarted ? { retryable: false, performed: 'unknown' } : {});
          });
        }).catch(function (error) {
          if (anyDownloadDispatched) throw markUncertain(error);
          throw error;
        }).then(function (assets) {
          try { ensureNotStopped(execution); } catch (error) {
            if (anyDownloadDispatched) throw markUncertain(error);
            throw error;
          }
          assets = assets.concat(planningFailures);
          var failed = assets.filter(function (asset) { return asset && asset.state === 'failed'; }).length;
          var downloaded = assets.length - failed;
          var completed = assets.filter(function (asset) { return asset && asset.state === 'complete'; }).length;
          var started = assets.filter(function (asset) { return asset && asset.state === 'started'; }).length;
          var networkDownloadCount = assets.filter(function (asset) {
            return asset && asset.state !== 'failed' && asset.acquisitionSource === 'network-download';
          }).length;
          var generatedCount = assets.filter(function (asset) {
            return asset && asset.state !== 'failed' && asset.acquisitionSource === 'generated-localization';
          }).length;
          var failedUrls = Object.create(null);
          var failedStreams = Object.create(null);
          assets.forEach(function (asset) {
            if (!asset || asset.state !== 'failed') return;
            failedUrls[asset.sourceUrl] = true;
            (asset.streamRoots || []).forEach(function (rootUrl) { failedStreams[rootUrl] = true; });
          });
          var localByUrl = Object.create(null);
          Object.keys(roots).forEach(function (url) {
            if (!plannedByUrl[url] || failedUrls[url] || failedStreams[url]) return;
            localByUrl[url] = joinLocalLink(linkPrefix, plannedByUrl[url]);
          });
          Object.keys(failedStreams).forEach(function (url) {
            warnings.push('HLS 资源包不完整，正文保留原始地址: ' + safeMediaUrlLabel(url));
          });
          var rewritten = params.rewriteLinks === false ? source : media.rewrite(source, candidates, localByUrl);
          log(execution, '多媒体下载完成: 成功 ' + downloaded + '，失败 ' + failed
            + '，页面驻留命中 ' + residentStats.hitCount + '，网络文件下载 ' + networkDownloadCount
            + (residentStats.networkFetchCount ? '，清单网络读取 ' + residentStats.networkFetchCount : '')
            + (warnings.length ? '，警告 ' + warnings.length : ''));
          return {
            content: rewritten,
            assets: assets,
            discoveredCount: candidates.length,
            downloadedCount: downloaded,
            completedCount: completed,
            startedCount: started,
            failedCount: failed,
            residentHitCount: residentStats.hitCount,
            residentMissCount: residentStats.missCount + residentStats.tooLargeCount,
            residentTooLargeCount: residentStats.tooLargeCount,
            residentByteLength: residentStats.byteLength,
            networkDownloadCount: networkDownloadCount,
            networkFetchCount: residentStats.networkFetchCount,
            generatedCount: generatedCount,
            residentResourceMode: residentMode,
            warnings: warnings,
          };
        });
      });
    }

    return {
      execClosePage: execClosePage,
      execWaitDownload: execWaitDownload,
      execSaveFile: execSaveFile,
      execDownloadMedia: execDownloadMedia,
    };
  }

  return {
    createFileOps: createFileOps,
  };
});
