// Browser profile operations used by node executor.
(function attachNodeBrowserOps(root, factory) {
  root.NodeBrowserOps = factory();
})(globalThis, function () {
  'use strict';

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
            return deps.authorizeApplication ? deps.authorizeApplication({ kind: 'page', command: 'clearCookies', url: details.url }) : null;
          }).then(function () {
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

    function getHostnameFromUrl(rawUrl) {
      try {
        var url = new URL(String(rawUrl || ''));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return String(url.hostname || '').toLowerCase();
      } catch (_) {
        return '';
      }
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
        var proxy = globalThis.ProxyManager.parseProxyServer(params.proxyServer);

        return perceiveTabInfo(tabId, execution).then(function (tab) {
          var currentUrl = tab && tab.url || '';
          if (!currentUrl) throw new Error('无法获取页面 URL');

          var currentHost = getHostnameFromUrl(currentUrl);
          if (!currentHost) {
            throw new Error('当前页面不是 http/https URL，无法按 host 设置代理');
          }
          var hostPatterns = globalThis.ProxyManager.parseHostList(params.hostPattern || params.urlPattern || currentHost, '匹配域名', false);
          if (!hostPatterns.length) hostPatterns = [currentHost];
          var hostPattern = hostPatterns.join(',');
          var bypassList = globalThis.ProxyManager.parseHostList(params.bypassList, '绕过域名', true);

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
              proxyUsername: params.proxyUsername,
              proxyPassword: params.proxyPassword,
              hostPattern: hostPattern,
              hostPatterns: hostPatterns,
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
        } else if (result.systemProxyServer) {
          log(execution, result.controlledByThisExtension ? '已清除当前会话代理规则，已恢复系统代理' : '已清除当前会话代理规则；系统代理未取得浏览器控制权');
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
