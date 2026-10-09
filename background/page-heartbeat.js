// Optional session heartbeat requests in existing pages, using the shared CDP engine.
(function attachPageHeartbeat(root, factory) {
  root.PageHeartbeat = factory();
})(globalThis, function () {
  'use strict';

  function parseHeaders(raw) {
    var text = String(raw || '').trim();
    var headers = new Headers();
    if (text.charAt(0) === '{') {
      var values = JSON.parse(text);
      Object.keys(values).forEach(function (key) { headers.append(key, String(values[key])); });
    } else if (text) {
      text.split(/\r?\n/).forEach(function (line) {
        if (!line.trim()) return;
        var separator = line.indexOf(':');
        if (separator < 1) throw new Error('心跳请求头需要 JSON 对象或 Key: Value');
        headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      });
    }
    return Array.from(headers.entries());
  }

  function statusRanges(raw) {
    return String(raw || '200-399').split(',').map(function (part) {
      var match = /^([1-5]\d{2})(?:\s*-\s*([1-5]\d{2}))?$/.exec(part.trim());
      if (!match) throw new Error('心跳期望状态码格式无效，例如 200-299,304');
      var range = [Number(match[1]), Number(match[2] || match[1])];
      if (range[0] > range[1]) throw new Error('心跳期望状态码范围无效');
      return range;
    });
  }

  function matchesPage(page, tab) {
    var url;
    var pageUrl;
    try { url = new URL(tab.url); pageUrl = new URL(page.url); } catch (_) { return false; }
    if (!/^https?:$/.test(url.protocol)) return false;
    var matchers = page.matchers || {};
    var hosts = Array.isArray(matchers.hostnames) ? matchers.hostnames : String(matchers.hostnames || '').split(/[,\n]/);
    hosts = hosts.map(function (host) { return String(host).trim().toLowerCase(); });
    if (url.hostname !== pageUrl.hostname && hosts.indexOf(url.hostname) === -1) return false;
    var includes = Array.isArray(matchers.urlIncludes) ? matchers.urlIncludes : [matchers.urlIncludes || ''];
    return includes.some(function (part) { return url.href.indexOf(String(part)) !== -1; });
  }

  // Executed in the page's MAIN world so cookies and page fetch hooks apply.
  async function sendHeartbeat(request) {
    if (location.origin !== request.pageOrigin) throw new Error('页面已跳转，跳过本次会话保活');
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, request.timeoutMs);
    try {
      var response = await fetch(request.url, {
        method: request.method, headers: request.headers,
        body: request.method === 'POST' ? request.body : undefined,
        credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
      var result = { status: response.status, redirected: response.redirected };
      if (response.body) await response.body.cancel();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  function createPageHeartbeat(deps) {
    var chrome = deps.chrome;
    var pageAutomation = deps.pageAutomation;
    var addLog = deps.addLog;
    var incognito = deps.incognito === true;
    var activePages = new Map();

    async function execute(pageId, page) {
      var config = page.keepAlive || {};
      var method = String(config.method || 'GET').toUpperCase();
      if (!/^(?:GET|HEAD|POST)$/.test(method)) throw new Error('心跳仅支持 GET、HEAD、POST');
      var headers = parseHeaders(config.headers);
      var ranges = statusRanges(config.expectedStatus);
      var timeoutMs = Math.max(1000, Math.min(Number(config.requestTimeoutMs) || 15000, 60000));
      var tabs = await chrome.tabs.query({});
      var targets = tabs.filter(function (tab) {
        return tab.id && !!tab.incognito === incognito && !tab.discarded
          && tab.status !== 'loading' && !tab.pendingUrl && matchesPage(page, tab);
      });
      await Promise.all(targets.map(async function (tab) {
        var owner = 'PageHeartbeat:' + (incognito ? 'incognito:' : 'regular:') + pageId + ':' + tab.id;
        try {
          var url = new URL(String(config.requestUrl).trim(), tab.url);
          if (!/^https?:$/.test(url.protocol)) throw new Error('心跳 URL 仅支持 HTTP/HTTPS');
          var request = {
            url: url.href, pageOrigin: new URL(tab.url).origin,
            method: method, headers: headers, body: String(config.body || ''), timeoutMs: timeoutMs,
          };
          var result = await pageAutomation.executeCommand('evaluate', {
            tabId: tab.id, mode: 'write', world: 'MAIN', sourceType: 'expression',
            code: '(' + sendHeartbeat.toString() + ')(' + JSON.stringify(request) + ')',
            timeoutMs: timeoutMs + 3000, sensitive: true,
          }, { source: 'script', owner: owner });
          var response = result && result.result;
          var status = Number(response && response.status) || 0;
          var accepted = ranges.some(function (range) { return status >= range[0] && status <= range[1]; });
          addLog('页面会话保活 [' + (page.label || pageId) + '] HTTP ' + status
            + (response && response.redirected ? '（请求发生重定向，请确认登录状态）' : '')
            + (accepted ? '' : '（不符合期望状态码）'), {
            level: accepted && !(response && response.redirected) ? 'info' : 'warn', tabId: tab.id,
          });
        } catch (error) {
          addLog('页面会话保活 [' + (page.label || pageId) + '] 失败: ' + String(error && error.message || error), { level: 'warn', tabId: tab.id });
        } finally {
          await pageAutomation.action.cleanupOwner(owner, { detachImmediately: true }).catch(function (error) {
            addLog('释放会话保活连接失败: ' + String(error && error.message || error), { level: 'warn', tabId: tab.id });
          });
        }
      }));
    }

    function run(pageId, page) {
      var config = page && page.keepAlive;
      if (!config || config.enabled !== true || !String(config.requestUrl || '').trim()) return Promise.resolve();
      if (activePages.has(pageId)) return activePages.get(pageId);
      var operation = Promise.resolve().then(function () { return execute(pageId, page); }).finally(function () {
        activePages.delete(pageId);
      });
      activePages.set(pageId, operation);
      return operation;
    }

    return Object.freeze({ run: run });
  }

  return Object.freeze({ createPageHeartbeat: createPageHeartbeat });
});
