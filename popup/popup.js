(function () {
  'use strict';
  var client = window.PageAgentResourceClient.create(chrome.runtime);
  var recentLimit = window.AppContract.limits.recentApps;
  var list = document.getElementById('recent-apps');
  var recentContent = document.getElementById('recent-content');
  var status = document.getElementById('status');
  var retry = document.getElementById('retry');
  var sidepanel = document.getElementById('open-sidepanel');
  var options = document.getElementById('open-options');
  var aboutButton = document.getElementById('open-about');
  var releaseBadge = document.getElementById('release-update');
  var projectUrl = 'https://github.com/openpageagent/pageagent';
  var aboutUrl = projectUrl;
  var releaseStorageKey = 'github_release_update';
  var windowId = null;
  recentContent.style.setProperty('--recent-limit', recentLimit);

  function fail(error) {
    status.textContent = error.message || String(error);
    status.classList.add('error'); status.hidden = false;
    retry.hidden = false;
  }

  function renderReleaseUpdate(release) {
    releaseBadge.hidden = true;
    aboutButton.title = '打开 GitHub 项目首页';
    aboutUrl = projectUrl;
    if (!release || !release.version || !release.url) return;
    var latest = release.version.split('.').map(Number);
    var current = chrome.runtime.getManifest().version.split('.').map(Number);
    for (var i = 0; i < Math.max(latest.length, current.length); i++) {
      var nextPart = latest[i] || 0, currentPart = current[i] || 0;
      if (nextPart === currentPart) continue;
      if (nextPart < currentPart) return;
      releaseBadge.hidden = false;
      aboutButton.title = '新版本 v' + release.version + '，前往手动更新';
      aboutUrl = chrome.runtime.getURL('options/options.html?section=release');
      return;
    }
  }

  async function openApp(app, event, button) {
    button.disabled = true;
    try {
      var newTab = event.metaKey || event.ctrlKey;
      var win = await chrome.windows.getCurrent();
      var response = await chrome.runtime.sendMessage({
        type: 'APP_MANAGE', operation: 'open',
        input: { appId: app.appId, newTab: newTab, active: !newTab || event.shiftKey, windowId: win.id },
      });
      if (!response) throw new Error('后台未响应');
      if (response.error) throw new Error(response.error.message);
      window.close();
    } catch (error) { fail(error); }
    finally { button.disabled = false; }
  }

  async function loadApps() {
    recentContent.setAttribute('aria-busy', 'true');
    status.textContent = '正在加载…'; status.classList.remove('error'); status.hidden = false;
    retry.hidden = true;
    var settingsContract = window.PageAgentSystemSettings;
    var layoutKey = 'app_launcher_' + (chrome.extension.inIncognitoContext ? 'incognito' : 'regular');
    var stored = await chrome.storage.local.get([settingsContract.SETTINGS_KEY, layoutKey]);
    var favoritesOnly = settingsContract.normalize(stored[settingsContract.SETTINGS_KEY]).popupAppsFavoritesOnly;
    var layout = stored[layoutKey] || {};
    var favorites = new Set(Array.isArray(layout.favorites) ? layout.favorites : []);
    document.getElementById('recent-title').textContent = favoritesOnly ? '收藏的应用' : '最近使用';
    recentContent.style.setProperty('--recent-limit', favoritesOnly ? Math.min(favorites.size, recentLimit) : recentLimit);
    var apps = [], cursor = null;
    if (!favoritesOnly || favorites.size) {
      do {
        var query = new URLSearchParams({ sort: favoritesOnly ? 'updated' : 'used', limit: String(favoritesOnly ? 100 : recentLimit) });
        if (cursor) query.set('cursor', cursor);
        var response = await client.get('/apps?' + query);
        var page = response.primary.data;
        // 内置应用即使未使用也展示，因此需继续分页查找。
        apps = apps.concat(page.items.filter(function (app) {
          return favoritesOnly ? favorites.has(app.appId) : app.__builtin || app.lastUsedAt > 0 && app.lastUsedAt !== app.createdAt;
        }));
        cursor = page.nextCursor;
      } while (apps.length < (favoritesOnly ? favorites.size : recentLimit) && cursor);
    }
    if (favoritesOnly) {
      // 与应用入口一致：保留旧置顶位置，再按保存的排列和创建时间排序。
      var order = Array.from(new Set((Array.isArray(layout.pinned) ? layout.pinned : []).concat(Array.isArray(layout.order) ? layout.order : [])));
      var positions = new Map(order.map(function (id, index) { return [id, index]; }));
      apps.sort(function (a, b) {
        var aPosition = positions.has(a.appId) ? positions.get(a.appId) : Infinity;
        var bPosition = positions.has(b.appId) ? positions.get(b.appId) : Infinity;
        return aPosition - bPosition || (a.createdAt || 0) - (b.createdAt || 0) || a.appId.localeCompare(b.appId);
      });
    } else {
      apps = apps.slice(0, recentLimit);
    }
    list.replaceChildren();
    apps.forEach(function (app) {
      var item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'menu-item'; button.title = app.name;
      var icon = document.createElement('span'), name = document.createElement('span');
      icon.className = 'app-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.textContent = window.AppContract.ICONS[app.icon] || window.AppContract.ICONS['fa-cube'];
      name.className = 'app-name'; name.textContent = app.name;
      button.append(icon, name);
      if (app.__builtin) {
        var badge = document.createElement('span');
        badge.className = 'app-builtin'; badge.textContent = '内置';
        button.append(badge);
      }
      button.addEventListener('click', function (event) { openApp(app, event, button); });
      item.append(button); list.append(item);
    });
    status.textContent = favoritesOnly ? '暂无收藏的应用，请在应用入口收藏。' : '暂无最近使用的应用';
    status.hidden = apps.length > 0;
  }

  function load() {
    retry.disabled = true;
    Promise.all([
      loadApps().finally(function () { recentContent.setAttribute('aria-busy', 'false'); }),
      chrome.windows.getCurrent().then(function (win) {
        windowId = win.id; sidepanel.disabled = false;
      }),
    ]).catch(fail).finally(function () { retry.disabled = false; });
  }

  sidepanel.addEventListener('click', function () {
    // 直接在点击回调中打开，保留 Chrome 所需的用户手势。
    sidepanel.disabled = true;
    chrome.sidePanel.open({ windowId: windowId }).then(function () {
      window.close();
    }).catch(fail).finally(function () { sidepanel.disabled = false; });
  });
  options.addEventListener('click', function () {
    options.disabled = true;
    chrome.runtime.openOptionsPage().then(function () {
      window.close();
    }).catch(fail).finally(function () { options.disabled = false; });
  });
  aboutButton.addEventListener('click', function () {
    aboutButton.disabled = true;
    chrome.tabs.create({ url: aboutUrl }).then(function () {
      window.close();
    }).catch(fail).finally(function () { aboutButton.disabled = false; });
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[releaseStorageKey]) renderReleaseUpdate(changes[releaseStorageKey].newValue);
  });
  chrome.storage.local.get(releaseStorageKey).then(function (stored) {
    renderReleaseUpdate(stored[releaseStorageKey]);
  }).catch(function (error) { console.warn('读取新版本提示失败:', error); });
  retry.addEventListener('click', load);
  document.addEventListener('keydown', function (event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    var buttons = Array.from(document.querySelectorAll('button:not(:disabled):not([hidden])'));
    if (!buttons.length) return;
    var index = buttons.indexOf(document.activeElement), next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else next = index <= 0 ? buttons.length - 1 : index - 1;
    event.preventDefault(); buttons[next].focus();
  });
  chrome.commands.getAll().then(function (commands) {
    commands.forEach(function (command) {
      if (!['open-sidepanel', 'open-options'].includes(command.name) || !command.shortcut) return;
      var button = document.getElementById(command.name);
      var shortcut = button.querySelector('kbd');
      var shortcutLabel = command.shortcut.replace(/\bComma\b/gi, ',').replace(/\bPeriod\b/gi, '.');
      shortcut.textContent = shortcutLabel;
      shortcut.hidden = false;
      button.title += '（' + shortcutLabel + '）';
    });
  }).catch(function () {});
  load();
})();
