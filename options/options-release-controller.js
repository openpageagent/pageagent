// 手动更新页面；文件更新由配置页与 ARP 共用的服务执行。
(function () {
  'use strict';
  var updater = globalThis.ExtensionUpdate;

  function create(options) {
    var current = chrome.runtime.getManifest();
    var checkButton = document.getElementById('btn-release-check');
    var updateButton = document.getElementById('btn-release-update');
    var directoryButton = document.getElementById('btn-release-directory');
    var reloadButton = document.getElementById('btn-release-reload');
    var statusElement = document.getElementById('release-status');
    var directoryElement = document.getElementById('release-directory');
    var directoryStatus = document.getElementById('release-directory-status');
    var supported = typeof window.showDirectoryPicker === 'function';
    var release = null, directory = null, directoryLoaded = false;
    var checking = false, updating = false, completed = false, initialized = false;
    document.getElementById('release-current-version').value = 'v' + current.version;

    function status(message, error) {
      statusElement.textContent = message;
      statusElement.style.color = error ? 'var(--danger)' : '';
    }

    function controls() {
      checkButton.disabled = checking || updating || completed;
      updateButton.disabled = !supported || !directoryLoaded || checking || updating || completed
        || !release || !release.downloadUrl || !updater.newerVersion(release.version, current.version);
      directoryButton.disabled = !supported || !directoryLoaded || checking || updating || completed;
      directoryButton.textContent = directory ? '更换目录' : '选择目录';
      reloadButton.disabled = updating;
    }

    function showDirectory() {
      directoryElement.value = directory ? directory.name : '';
      directoryStatus.textContent = directory ? '已记住此目录，更新时自动使用。' : '尚未选择插件目录。';
      controls();
    }

    async function rememberDirectory(handle) {
      directory = handle;
      showDirectory();
      try { await updater.directorySetting(handle); }
      catch (_) { directoryStatus.textContent = '未能记住此目录，下次需重新选择。'; }
    }

    async function check() {
      if (checking || updating || completed) return;
      checking = true;
      release = null;
      controls();
      status('正在检查最新版本…');
      document.getElementById('release-latest-version').value = '检查中…';
      try {
        release = await globalThis.ReleaseUpdate.fetchLatest();
        document.getElementById('release-latest-version').value = 'v' + release.version;
        document.getElementById('release-page').href = release.url;
        if (!supported) status('当前浏览器不支持选择并写入插件目录，请使用支持此功能的 Chrome 或 Edge。', true);
        else if (!updater.newerVersion(release.version, current.version)) status('当前已是最新版本。');
        else if (!release.downloadUrl) status('此版本尚未提供插件 ZIP 包，请稍后重新检查。', true);
        else status('发现新版本，可点击「手动更新」。');
      } catch (error) {
        document.getElementById('release-latest-version').value = '检查失败';
        status('检查失败：' + error.message, true);
      } finally { checking = false; controls(); }
    }

    async function reloadExtension() {
      if (updating) return;
      try {
        await navigator.locks.request('page-agent-extension-update', { ifAvailable: true }, function (lock) {
          if (!lock) { status('正在更新插件，请完成后再重新加载。', true); return; }
          chrome.runtime.reload();
        });
      }
      catch (error) { status('重新加载失败，请到浏览器扩展管理页手动重新加载：' + error.message, true); }
    }

    directoryButton.onclick = async function () {
      if (updating || completed) return;
      updating = true;
      controls();
      try {
        var handle = await window.showDirectoryPicker({ id: 'page-agent-update', mode: 'readwrite' });
        await updater.validateDirectory(handle, current);
        await rememberDirectory(handle);
        status('已更换插件目录，可点击「手动更新」。');
      } catch (error) { if (error.name !== 'AbortError') status(error.message, true); }
      finally { updating = false; controls(); }
    };

    updateButton.onclick = async function () {
      if (updateButton.disabled) return;
      updating = true;
      controls();
      try {
        // 在点击回调中立即申请授权或选择目录，保留浏览器要求的用户手势。
        var handle = directory;
        if (handle) {
          if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
            throw new Error('需要允许修改插件目录才能更新，也可以点击「更换目录」重新选择。');
          }
        } else {
          handle = await window.showDirectoryPicker({ id: 'page-agent-update', mode: 'readwrite' });
        }
        await updater.validateDirectory(handle, current);
        await rememberDirectory(handle);
        var result = await updater.update({ directory: handle, release: release, status: status });
        completed = true;
        status('v' + result.appliedVersion + ' 更新完成：写入 ' + result.written + ' 个文件，跳过 ' + result.skipped + ' 个未变化的文件。点击「重新加载插件」使更新生效。');
      } catch (error) {
        status(error.name === 'AbortError' ? '已取消更新，未修改插件文件。' : '更新失败：' + error.message, error.name !== 'AbortError');
      } finally { updating = false; controls(); }
      if (completed && await options.confirm('更新已写入插件目录，重新加载即可生效。重新加载会中断插件当前运行的任务。', '更新完成', '立即重新加载')) {
        reloadExtension();
      }
    };

    checkButton.onclick = check;
    reloadButton.onclick = async function () {
      if (updating) return;
      if (await options.confirm('重新加载会中断插件当前运行的任务，是否继续？', '重新加载插件', '重新加载')) {
        await reloadExtension();
      }
    };
    window.addEventListener('beforeunload', function (event) {
      if (updating) { event.preventDefault(); event.returnValue = ''; }
    });
    updater.directorySetting().then(function (handle) {
      directory = handle && handle.kind === 'directory' ? handle : null;
    }).catch(function () {}).finally(function () { directoryLoaded = true; showDirectory(); });

    return {
      render: function () { if (!initialized) { initialized = true; check(); } },
      getState: function () { return { busy: updating }; },
    };
  }

  globalThis.OptionsReleaseController = { create: create };
})();
