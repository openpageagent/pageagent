// Unified page-engine readiness. No page-side automation driver is injected.
(function attachPageReadiness(root, factory) {
  'use strict';
  root.PageReadiness = factory();
})(globalThis, function () {
  'use strict';
  var API_VERSION = 1;

  function createPageReadiness(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var pageAutomation = deps.pageAutomation;
    var getConfigReady = deps.getConfigReady || (function () { return Promise.resolve(); });
    var getConfig = deps.getConfig || (function () { return { pages: {} }; });
    var pageHostMatchesTab = deps.pageHostMatchesTab || (function () { return false; });
    if (!pageAutomation || typeof pageAutomation.executeCommand !== 'function'
        || !pageAutomation.perception || !pageAutomation.action || !pageAutomation.verification) {
      throw new Error('PageReadiness requires PageAutomationRuntime');
    }

    function expectedInfo() {
      var info = globalThis.PageEngineVersion || {};
      return { version: String(info.version || ''), hash: String(info.hash || ''), providerHash: String(info.providerHash || '') };
    }

    function configuredMatches(tab) {
      var pages = (getConfig() || {}).pages || {};
      return Object.keys(pages).filter(function (pageId) {
        return pageHostMatchesTab(pages[pageId], 'page:' + pageId, tab);
      }).map(function (pageId) {
        var page = pages[pageId] || {};
        return { pageId: pageId, label: page.label || page.name || page.url || pageId };
      });
    }

    function queryPageEngineInfo(tabId, knownTab) {
      tabId = Math.floor(Number(tabId));
      if (!(tabId > 0)) return Promise.reject(new Error('页面引擎状态查询需要有效 tabId'));
      return Promise.resolve(knownTab || chrome.tabs.get(tabId)).then(function (tab) {
        var expected = expectedInfo();
        return {
          ready: true,
          version: expected.version,
          hash: expected.hash,
          providerHash: expected.providerHash,
          tabId: tabId,
          url: String(tab && (tab.pendingUrl || tab.url) || ''),
          tabStatus: String(tab && tab.status || ''),
          evidenceSource: 'background-runtime',
        };
      });
    }

    function checkTabReadiness(tabId) {
      tabId = Math.floor(Number(tabId));
      if (!(tabId > 0)) return Promise.resolve({ ready: false, status: 'noTab', message: '没有当前标签页' });
      return Promise.resolve(getConfigReady()).then(function () {
        return chrome.tabs.get(tabId);
      }).then(function (tab) {
        var expected = expectedInfo();
        var matches = configuredMatches(tab);
        if (!matches.length) {
          return { ready: false, applicable: false, status: 'notConfigured', message: '当前页未匹配页面配置', tabId: tabId, url: tab.url || '', expected: expected, matches: [] };
        }
        return queryPageEngineInfo(tabId, tab).then(function (actual) {
          return {
            ready: true,
            applicable: true,
            status: 'ready',
            message: '统一页面引擎已就绪',
            tabId: tabId,
            url: actual.url || tab.url || '',
            expected: expected,
            actual: actual,
            matches: matches,
          };
        }).catch(function (error) {
          var code = String(error && error.code || 'PAGE_ENGINE_UNAVAILABLE');
          return {
            ready: false,
            applicable: true,
            status: 'error',
            message: '统一页面引擎后台运行时不可用',
            error: String(error && error.message || error),
            code: code,
            tabId: tabId,
            url: tab.url || '',
            expected: expected,
            matches: matches,
          };
        });
      }).catch(function (error) {
        return { ready: false, status: 'error', message: '无法读取当前标签页', error: String(error && error.message || error), tabId: tabId };
      });
    }

    return {
      checkTabReadiness: checkTabReadiness,
      queryPageEngineInfo: queryPageEngineInfo,
      queryPageDriverInfo: queryPageEngineInfo,
      getExpectedPageEngineInfo: expectedInfo,
      getExpectedPageDriverInfo: expectedInfo,
    };
  }

  return Object.freeze({ API_VERSION: API_VERSION, createPageReadiness: createPageReadiness });
});
