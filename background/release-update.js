// GitHub Release 每日检查；缓存供扩展图标菜单读取。
(function () {
  'use strict';
  var STORAGE_KEY = 'github_release_update';
  var ALARM_NAME = 'github_release_update';
  var DAY_MS = 24 * 60 * 60 * 1000;
  var pending = null;

  async function fetchLatest() {
    var response = await fetch('https://api.github.com/repos/openpageagent/pageagent/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('GitHub Release HTTP ' + response.status);
    var release = await response.json();
    var tag = String(release.tag_name || '');
    var version = tag.replace(/^v/i, '');
    if (release.draft || release.prerelease || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
      throw new Error('GitHub Release 版本号无效');
    }
    var asset = (release.assets || []).find(function (item) {
      return item.name === 'page-agent-extension-' + version + '.zip'
        && item.state === 'uploaded'
        && String(item.browser_download_url || '').startsWith('https://github.com/openpageagent/pageagent/releases/download/');
    });
    return {
      version: version,
      url: 'https://github.com/openpageagent/pageagent/releases/tag/' + encodeURIComponent(tag),
      downloadUrl: asset ? asset.browser_download_url : '',
      size: asset ? asset.size : 0,
      digest: asset ? asset.digest || '' : '',
    };
  }

  async function checkLatest() {
    var cached = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    var now = Date.now();
    if (cached.checkedAt && now < cached.checkedAt + DAY_MS) {
      await chrome.alarms.create(ALARM_NAME, { when: cached.checkedAt + DAY_MS });
      return;
    }

    // 请求前记下时间并安排下次检查，断网或后台重启也不会反复请求。
    await chrome.storage.local.set({ [STORAGE_KEY]: Object.assign({}, cached, { checkedAt: now }) });
    await chrome.alarms.create(ALARM_NAME, { when: now + DAY_MS });
    var release = await fetchLatest();
    await chrome.storage.local.set({ [STORAGE_KEY]: Object.assign({ checkedAt: now }, release) });
  }

  function check() {
    // split 无痕上下文共享 local 缓存，只由普通上下文发起请求。
    if (chrome.extension.inIncognitoContext) return Promise.resolve();
    if (!pending) {
      pending = checkLatest().catch(function (error) {
        console.warn('[ReleaseUpdate] 检查新版本失败:', error);
      }).finally(function () { pending = null; });
    }
    return pending;
  }

  globalThis.ReleaseUpdate = { ALARM_NAME: ALARM_NAME, check: check, fetchLatest: fetchLatest };
})();
