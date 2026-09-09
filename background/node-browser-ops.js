// Browser profile operations used by node executor.
(function attachNodeBrowserOps(root, factory) {
  root.NodeBrowserOps = factory();
})(globalThis, function () {
  'use strict';

  var PROXY_PAC_TYPES = {
    http: 'PROXY',
    https: 'HTTPS',
    socks4: 'SOCKS',
    socks5: 'SOCKS5',
  };

  function createBrowserOps(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || function () {};
    var pageSource = deps.pageSource || function (pageId) { return 'page:' + pageId; };
    var tabRuntime = deps.tabRuntime || {};
    var getSession = deps.getSession || function () { return null; };
    var proxyManager = deps.proxyManager || null;
    var requireRuntimeTabId = deps.requireRuntimeTabId || function (params) {
      var tabId = Number(params && (params.tabId || params.activeTabId) || 0) || 0;
      return tabId ? Promise.resolve(tabId) : Promise.reject(new Error('设置代理需要 tabId'));
    };
    var ensurePageReady = typeof deps.ensurePageReady === 'function'
      ? deps.ensurePageReady
      : function (_pageId, _execution, params) { return requireRuntimeTabId(params || {}, 'setProxy'); };
    var perceiveTabInfo = deps.perceiveTabInfo;
    if (typeof perceiveTabInfo !== 'function') throw new Error('NodeBrowserOps requires PagePerceptionEngine tab facts');

    function log(execution, message, options) {
      return execution && execution.addLog
        ? execution.addLog(message, options)
        : addLog(message, options);
    }

    function ensureNotStopped(execution) {
      if (execution && execution.signal && execution.signal.aborted) {
        throw execution.signal.reason instanceof Error ? execution.signal.reason : new Error('浏览器配置操作已停止');
      }
    }

    function markUncertain(error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        try { error.performed = 'unknown'; error.retryable = false; } catch (_) {}
      }
      return error;
    }

    // Cookie APIs accept URL-like strings at runtime, including values coming
    // from templates and script calls. Enforce the same web-origin boundary as
    // the flow schema before touching chrome.cookies.
    function normalizeCookieUrl(raw) {
      var text = raw === undefined || raw === null ? '' : String(raw).trim();
      if (!text) throw new Error('Cookie 操作缺少 URL');
      var parsed;
      try {
        parsed = new URL(text);
      } catch (_) {
        throw new Error('Cookie URL 格式无效');
      }
      var protocol = String(parsed.protocol || '').toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error('Cookie 仅支持 http/https URL');
      }
      return text;
    }

    function execSetCookie(params, execution) {
      params = params || {};
      ensureNotStopped(execution);
      if (!params.url || !params.name) throw new Error('写入 Cookie 需要 URL 与 Cookie 名');
      var cookieUrl = normalizeCookieUrl(params.url);
      var details = {
        url: cookieUrl,
        name: params.name,
        value: String(params.value === undefined ? '' : params.value),
      };
      var days = Number(params.expiresDays) || 0;
      if (days > 0) details.expirationDate = Math.floor(Date.now() / 1000) + days * 86400;
      var dispatched = false;
      return Promise.resolve().then(function () {
        ensureNotStopped(execution);
        dispatched = true;
        return chrome.cookies.set(details);
      }).then(function (cookie) {
        ensureNotStopped(execution);
        if (!cookie) throw new Error('Cookie 写入失败: ' + params.name);
        return { set: true, name: params.name };
      }).catch(function (error) {
        if (dispatched) throw markUncertain(error);
        throw error;
      });
    }

    function execGetCookie(params, execution) {
      params = params || {};
      ensureNotStopped(execution);
      if (!params.url || !params.name) throw new Error('读取 Cookie 需要 URL 与 Cookie 名');
      var cookieUrl = normalizeCookieUrl(params.url);
      return chrome.cookies.get({ url: cookieUrl, name: params.name }).then(function (cookie) {
        ensureNotStopped(execution);
        return cookie ? cookie.value : null;
      });
    }

    function execClearCookies(params, execution) {
      params = params || {};
      ensureNotStopped(execution);
      if (!params.url) throw new Error('清除 Cookie 需要 URL');
      var cookieUrl = normalizeCookieUrl(params.url);
      return chrome.cookies.getAll({ url: cookieUrl }).then(function (cookies) {
        ensureNotStopped(execution);
        var targets = params.name ? cookies.filter(function (c) { return c.name === params.name; }) : cookies;
        var dispatchedCount = 0;
        return Promise.all(targets.map(function (c) {
          var host = String(c.domain || '').replace(/^\./, '');
          var path = String(c.path || '/');
          if (path.charAt(0) !== '/') path = '/' + path;
          var details = {
            url: (c.secure ? 'https://' : 'http://') + host + path,
            name: c.name,
          };
          if (c.storeId) details.storeId = c.storeId;
          if (c.partitionKey) details.partitionKey = c.partitionKey;
          return Promise.resolve().then(function () {
            ensureNotStopped(execution);
            dispatchedCount++;
            return chrome.cookies.remove(details);
          }).then(function (result) {
            return { ok: true, result: result };
          }).catch(function (error) {
            return { ok: false, error: error };
          });
        })).then(function (outcomes) {
          var failures = outcomes.filter(function (outcome) { return !outcome.ok; });
          if (failures.length) {
            var firstError = failures[0].error;
            if (dispatchedCount > 0) throw markUncertain(firstError);
            throw firstError;
          }
          ensureNotStopped(execution);
          return { removed: outcomes.filter(function (outcome) { return !!outcome.result; }).length };
        }).catch(function (error) {
          if (dispatchedCount > 0) throw markUncertain(error);
          throw error;
        });
      });
    }

    function parseProxyServer(raw) {
      var text = String(raw || '').trim();
      if (!text) throw new Error('代理服务器地址不能为空');
      if (/\s/.test(text)) throw new Error('代理服务器地址不能包含空白字符');

      var urlText = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : ('http://' + text);
      var url;
      try {
        url = new URL(urlText);
      } catch (err) {
        throw new Error('代理服务器格式无效，应为 host:port 或 scheme://host:port');
      }

      var scheme = String(url.protocol || '').replace(/:$/, '').toLowerCase();
      if (!PROXY_PAC_TYPES[scheme]) {
        throw new Error('不支持的代理协议: ' + scheme + '（支持 http/https/socks4/socks5）');
      }
      if (url.username || url.password) {
        throw new Error('代理服务器地址不支持内嵌用户名密码，请使用无认证代理或系统级认证');
      }
      if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
        throw new Error('代理服务器只填写 host:port，不支持路径、查询参数或 hash');
      }
      if (!url.hostname || !url.port) {
        throw new Error('代理服务器必须包含 host 和 port');
      }

      var port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('代理服务器端口必须在 1-65535 之间');
      }

      return {
        scheme: scheme,
        host: url.hostname,
        port: port,
        server: url.host,
        pacValue: PROXY_PAC_TYPES[scheme] + ' ' + url.host,
      };
    }

    function getHostnameFromUrl(rawUrl) {
      try {
        var url = new URL(String(rawUrl || ''));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return String(url.hostname || '').toLowerCase();
      } catch (_) {
        return '';
      }
    }

    function normalizeHostPattern(raw, label, allowLocal) {
      var text = String(raw || '').trim().toLowerCase();
      label = label || '主机匹配模式';
      if (!text) throw new Error(label + '不能为空');
      if (allowLocal && text === '<local>') return text;
      if (text.indexOf('://') !== -1 || /[\/?#]/.test(text)) {
        throw new Error(label + '只支持 host 通配符，不支持完整 URL 或路径');
      }
      if (/[\s"'\\]/.test(text)) {
        throw new Error(label + '不能包含空白、引号或反斜杠');
      }
      if (!/^[a-z0-9*?.:_\-\[\]]+$/i.test(text)) {
        throw new Error(label + '只能包含字母、数字、点、冒号、中括号、连字符和 * ? 通配符');
      }
      return text;
    }

    function parseBypassList(raw) {
      return String(raw || '').split(/[,\n]/).map(function (item) {
        return item.trim();
      }).filter(Boolean).map(function (item) {
        return normalizeHostPattern(item, '绕过代理主机', true);
      });
    }

    function execSetProxy(pageId, params, execution) {
      params = params || {};
      ensureNotStopped(execution);
      var source = pageSource(pageId);
      var resolveTabId = pageId
        ? ensurePageReady(pageId, execution)
        : requireRuntimeTabId(params, 'setProxy');
      return resolveTabId.then(function (tabId) {
        var session = getSession();
        if (!session || !session.runId) {
          throw new Error('代理节点必须在流程运行会话中执行，避免无法自动清理浏览器代理设置');
        }
        if (!proxyManager || !proxyManager.setRule) {
          throw new Error('代理管理器不可用，无法安全设置浏览器代理');
        }
        var proxy = parseProxyServer(params.proxyServer);

        return perceiveTabInfo(tabId, execution).then(function (tab) {
          var currentUrl = tab && tab.url || '';
          if (!currentUrl) throw new Error('无法获取页面 URL');

          var currentHost = getHostnameFromUrl(currentUrl);
          if (!currentHost) {
            throw new Error('当前页面不是 http/https URL，无法按 host 设置代理');
          }
          var hostPattern = normalizeHostPattern(params.hostPattern || params.urlPattern || currentHost, '主机匹配模式');
          var bypassList = parseBypassList(params.bypassList);

          log(execution, '设置浏览器代理（profile 级）: ' + proxy.server + '，匹配 host: ' + hostPattern + ' (tabId=' + tabId + ')');
          if (hostPattern === '*') {
            log(execution, '主机匹配模式为 *，会影响当前浏览器配置中的所有请求', { level: 'warn' });
          } else {
            log(execution, '注意：chrome.proxy 不是 tab 级设置；其他标签页访问匹配 host 时也会走该代理', { level: 'warn' });
          }

          var dispatched = false;
          return Promise.resolve().then(function () {
            ensureNotStopped(execution);
            dispatched = true;
            return proxyManager.setRule(session, {
              ruleId: 'tab:' + tabId,
              tabId: tabId,
              source: source,
              proxyServer: proxy.server,
              proxyScheme: proxy.scheme,
              proxyPacValue: proxy.pacValue,
              hostPattern: hostPattern,
              bypassList: bypassList,
            });
          }).then(function (result) {
            ensureNotStopped(execution);
            return {
              success: true,
              tabId: tabId,
              proxyServer: proxy.server,
              proxyScheme: proxy.scheme,
              hostPattern: hostPattern,
              bypassList: bypassList,
              activeRules: result.activeRules,
              mode: 'pac_script',
              scope: proxyManager.scope || 'regular',
              note: 'chrome.proxy 为 profile 级设置，匹配 host 的其他 tab 也会受影响',
            };
          }).catch(function (error) {
            if (dispatched) throw markUncertain(error);
            throw error;
          });
        });
      });
    }

    function execClearProxy(execution) {
      ensureNotStopped(execution);
      var session = getSession();
      if (!session || !session.runId) {
        throw new Error('代理节点必须在流程运行会话中执行，避免误清浏览器代理设置');
      }
      if (!proxyManager || !proxyManager.clearSession) {
        throw new Error('代理管理器不可用，无法安全清除浏览器代理');
      }

      log(execution, '清除当前会话代理规则');
      var dispatched = false;
      return Promise.resolve().then(function () {
        ensureNotStopped(execution);
        dispatched = true;
        return proxyManager.clearSession(session, 'clear_node');
      }).then(function (result) {
        ensureNotStopped(execution);
        if (!result.cleared) {
          log(execution, '当前会话没有已登记的代理规则');
        } else if (result.activeRules > 0) {
          log(execution, '已清除当前会话代理规则；仍保留其他会话代理规则 ' + result.activeRules + ' 条');
        } else {
          log(execution, '已清除当前会话代理规则，浏览器代理控制已释放');
        }
        return {
          cleared: !!result.cleared,
          activeRules: result.activeRules || 0,
        };
      }).catch(function (error) {
        if (dispatched) throw markUncertain(error);
        throw error;
      });
    }

    return {
      execSetCookie: execSetCookie,
      execGetCookie: execGetCookie,
      execClearCookies: execClearCookies,
      execSetProxy: execSetProxy,
      execClearProxy: execClearProxy,
    };
  }

  return {
    createBrowserOps: createBrowserOps,
  };
});
