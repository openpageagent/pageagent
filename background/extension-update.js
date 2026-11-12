// 配置页和 ARP 共用的扩展更新；只写入浏览器已授权的插件目录。
(function () {
  'use strict';
  var MAX_BYTES = 512 * 1024 * 1024;

  function directorySetting(value) {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open('page-agent-extension-update', 1);
      request.onupgradeneeded = function () { request.result.createObjectStore('settings'); };
      request.onerror = function () { reject(request.error); };
      request.onsuccess = function () {
        var db = request.result;
        try {
          var transaction = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite');
          var store = transaction.objectStore('settings');
          var operation = value === undefined ? store.get('directory') : store.put(value, 'directory');
          transaction.oncomplete = function () { db.close(); resolve(operation.result); };
          transaction.onabort = function () { db.close(); reject(transaction.error || new Error('无法保存插件目录')); };
        } catch (error) { db.close(); reject(error); }
      };
    });
  }

  function newerVersion(latest, current) {
    var left = latest.split('.').map(Number), right = current.split('.').map(Number);
    for (var index = 0; index < Math.max(left.length, right.length); index++) {
      if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
    }
    return false;
  }

  function failure(reason, message, code) {
    return Object.assign(new Error(message), { reason: reason, code: code || 'RESOURCE_CONFLICT', performed: 'no' });
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) throw failure('UPDATE_CANCELLED', '更新已取消。');
  }

  async function readDirectoryManifest(directory, current) {
    var manifest;
    try {
      var file = await directory.getFileHandle('manifest.json');
      manifest = JSON.parse(await (await file.getFile()).text());
    } catch (_) {
      throw failure('DIRECTORY_UNAVAILABLE', '无法读取插件目录，请在「最新版本」页重新选择当前加载的目录。');
    }
    if (!manifest || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)
        || manifest.name !== current.name
        || manifest.manifest_version !== current.manifest_version || manifest.key !== current.key) {
      throw failure('DIRECTORY_MISMATCH', '所选目录与当前插件不一致，请在「最新版本」页重新选择目录。');
    }
    return manifest;
  }

  async function validateDirectory(directory, current) {
    var manifest = await readDirectoryManifest(directory, current);
    if (manifest.version !== current.version) {
      throw failure('DIRECTORY_VERSION_MISMATCH', '所选目录与当前插件版本不一致，请确认加载目录；若已经更新，请点击「重新加载插件」。');
    }
  }

  async function downloadFiles(release, current, status, signal) {
    if (!release.size || release.size > MAX_BYTES) throw new Error('发布包大小无效或超过 512 MB。');
    status('正在下载 v' + release.version + '（' + (release.size / 1024 / 1024).toFixed(1) + ' MB）…');
    var controller = new AbortController();
    var abort = function () { controller.abort(); };
    var timeout = setTimeout(abort, 180000);
    if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    var buffer;
    try {
      var response = await fetch(release.downloadUrl, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('下载失败：HTTP ' + response.status);
      buffer = await response.arrayBuffer();
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abort);
    }
    if (buffer.byteLength !== release.size) throw new Error('下载包大小不符，请重试。');
    status('正在校验并解压发布包…');
    if (release.digest) {
      var digest = await crypto.subtle.digest('SHA-256', buffer);
      var hex = Array.from(new Uint8Array(digest), function (value) { return value.toString(16).padStart(2, '0'); }).join('');
      if (release.digest !== 'sha256:' + hex) throw new Error('发布包 SHA-256 校验失败，请重试。');
    }
    var entries = await globalThis.PageAgentZipStore.read(buffer, { allowCompressed: true, maxBytes: MAX_BYTES, maxEntries: 20000 });
    var prefix = 'page-agent-extension/';
    var paths = new Set();
    var files = entries.map(function (entry) {
      if (!entry.name.startsWith(prefix)) throw new Error('发布包目录结构不正确。');
      var name = entry.name.slice(prefix.length);
      // 拒绝在 Windows 或不区分大小写的文件系统上发生路径别名覆盖。
      if (!name || /[<>"|?*]/.test(name) || name.split('/').some(function (part) { return /[. ]$/.test(part); })
          || paths.has(name.toLowerCase())) throw new Error('发布包存在无效或重复路径：' + name);
      paths.add(name.toLowerCase());
      return { name: name, data: entry.data };
    });
    var manifestFile = files.find(function (file) { return file.name === 'manifest.json'; });
    if (!manifestFile) throw new Error('发布包缺少 manifest.json。');
    var manifest = JSON.parse(new TextDecoder().decode(manifestFile.data));
    if (manifest.name !== current.name || manifest.version !== release.version
        || manifest.manifest_version !== current.manifest_version || manifest.key !== current.key
        || !files.some(function (file) { return file.name === (manifest.background || {}).service_worker; })
        || !files.some(function (file) { return file.name === manifest.options_page; })) {
      throw new Error('发布包的插件信息、版本或必要文件不正确。');
    }
    // 所有文件解压、校验完成后才开始写入，manifest 最后提交。
    return files.filter(function (file) { return file !== manifestFile; }).concat(manifestFile);
  }

  async function writeFile(handle, data) {
    var writable = await handle.createWritable();
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
  }

  function sameBytes(original, data) {
    if (original.byteLength !== data.byteLength) return false;
    var bytes = new Uint8Array(original);
    for (var index = 0; index < bytes.length; index++) {
      if (bytes[index] !== data[index]) return false;
    }
    return true;
  }

  async function applyFiles(directory, files, status, signal) {
    var changes = [], createdDirectories = [];
    var directories = new Map([['', directory]]);
    var written = 0, skipped = 0;
    try {
      for (var index = 0; index < files.length; index++) {
        checkAbort(signal);
        var file = files[index], parts = file.name.split('/'), name = parts.pop();
        status('正在处理更新（' + (index + 1) + '/' + files.length + '，已写入 ' + written + '，已跳过 ' + skipped + '）：' + file.name);
        var parent = directory, path = '';
        for (var part of parts) {
          path += part + '/';
          if (!directories.has(path)) {
            var child;
            try { child = await parent.getDirectoryHandle(part); }
            catch (error) {
              if (error.name !== 'NotFoundError') throw error;
              child = await parent.getDirectoryHandle(part, { create: true });
              createdDirectories.push({ parent: parent, name: part });
            }
            directories.set(path, child);
          }
          parent = directories.get(path);
        }
        var handle, original = null;
        try { handle = await parent.getFileHandle(name); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; handle = null; }
        // File 引用会在覆盖后失效，必须先读取字节，才能在写入失败时恢复。
        if (handle) original = await (await handle.getFile()).arrayBuffer();
        if (original !== null && sameBytes(original, file.data)) {
          skipped++;
          continue;
        }
        var change = { parent: parent, name: name, original: original, handle: handle };
        changes.push(change);
        if (!handle) change.handle = handle = await parent.getFileHandle(name, { create: true });
        await writeFile(handle, file.data);
        written++;
      }
      return { written: written, skipped: skipped };
    } catch (error) {
      status('应用失败，正在恢复原文件…');
      var restored = true;
      for (var change of changes.reverse()) {
        try {
          if (change.original !== null) await writeFile(change.handle, change.original);
          else await change.parent.removeEntry(change.name);
        } catch (rollbackError) {
          if (change.original !== null || rollbackError.name !== 'NotFoundError') restored = false;
        }
      }
      for (var created of createdDirectories.reverse()) {
        try { await created.parent.removeEntry(created.name); }
        catch (directoryError) { if (directoryError.name !== 'NotFoundError') restored = false; }
      }
      throw Object.assign(new Error((error.message || String(error)) + (restored
        ? '；已恢复原文件，请重试更新。'
        : '；部分文件未能恢复，请重试更新成功后再重新加载插件。')), {
        reason: restored ? 'UPDATE_ROLLED_BACK' : 'UPDATE_ROLLBACK_FAILED',
        code: 'UPSTREAM_FAILED', performed: restored ? 'no' : 'unknown',
      });
    }
  }

  async function directoryState(current) {
    var directory;
    try { directory = await directorySetting(); }
    catch (error) { throw failure('DIRECTORY_UNAVAILABLE', '读取插件目录失败：' + error.message); }
    var state = { directory: directory, directoryConfigured: !!directory, directoryName: directory ? directory.name : '',
      writePermission: null, directoryVersion: null, reloadRequired: false, reason: null, message: '' };
    if (!directory) {
      state.reason = 'DIRECTORY_NOT_CONFIGURED';
      state.message = '请先在「最新版本」页选择插件目录并授权写入。';
      return state;
    }
    try { state.writePermission = await directory.queryPermission({ mode: 'readwrite' }); }
    catch (error) { throw failure('DIRECTORY_UNAVAILABLE', '读取插件目录授权失败：' + error.message); }
    if (state.writePermission !== 'granted') {
      state.reason = 'DIRECTORY_PERMISSION_REQUIRED';
      state.message = '插件目录需要重新授权，请在「最新版本」页选择目录并授权写入。';
      return state;
    }
    try {
      var manifest = await readDirectoryManifest(directory, current);
      state.directoryVersion = manifest.version;
      state.reloadRequired = typeof manifest.version === 'string' && newerVersion(manifest.version, current.version);
      if (manifest.version !== current.version) {
        state.reason = state.reloadRequired ? 'RELOAD_REQUIRED' : 'DIRECTORY_VERSION_MISMATCH';
        state.message = state.reloadRequired ? '更新已写入，请在「最新版本」页重新加载插件。' : '插件目录版本不一致，请重新选择当前加载的目录。';
      }
    } catch (error) { state.reason = error.reason || 'DIRECTORY_UNAVAILABLE'; state.message = error.message; }
    return state;
  }

  async function getStatus() {
    var current = chrome.runtime.getManifest();
    var state = { currentVersion: current.version, latestVersion: null, updateAvailable: null,
      directoryConfigured: null, directoryName: '', writePermission: null, directoryVersion: null,
      reloadRequired: false, updating: false, canUpdate: false, reason: null, message: '',
      settingsUrl: chrome.runtime.getURL('options/options.html?section=release') };
    var release;
    try { release = await globalThis.ReleaseUpdate.fetchLatest(); }
    catch (error) { state.reason = 'CHECK_FAILED'; state.message = '检查更新失败：' + error.message; }
    if (release) {
      state.latestVersion = release.version;
      state.updateAvailable = newerVersion(release.version, current.version);
      state.message = state.updateAvailable ? '发现新版本 v' + release.version + '。' : '当前已是最新版本。';
    }
    await navigator.locks.request('page-agent-extension-update', { mode: 'shared', ifAvailable: true }, async function (lock) {
      if (!lock) {
        state.updating = true; state.reason = 'UPDATE_IN_PROGRESS'; state.message = '插件正在更新，请稍后查询。';
        return;
      }
      try {
        var directory = await directoryState(current);
        ['directoryConfigured', 'directoryName', 'writePermission', 'directoryVersion', 'reloadRequired'].forEach(function (key) { state[key] = directory[key]; });
        if (directory.reason) { state.reason = directory.reason; state.message = directory.message; }
      } catch (error) { state.reason = 'DIRECTORY_UNAVAILABLE'; state.message = '读取插件目录失败：' + error.message; }
    });
    if (!state.reason && release && !state.updateAvailable) state.reason = 'UP_TO_DATE';
    if (!state.reason && release && !release.downloadUrl) {
      state.reason = 'RELEASE_ASSET_MISSING'; state.message = '此版本尚未提供插件 ZIP 包。';
    }
    state.canUpdate = state.updateAvailable === true && !state.reason;
    if (state.updateAvailable && state.reason) state.message = '发现新版本 v' + state.latestVersion + '。' + state.message;
    return state;
  }

  async function update(options) {
    options = options || {};
    var current = chrome.runtime.getManifest();
    var status = options.status || function () {};
    return navigator.locks.request('page-agent-extension-update', { ifAvailable: true }, async function (lock) {
      if (!lock) throw failure('UPDATE_IN_PROGRESS', '插件正在更新，请等待完成。', 'RESOURCE_BUSY');
      checkAbort(options.signal);
      var directory = options.directory;
      if (!directory) {
        var state = await directoryState(current);
        if (state.reason) throw failure(state.reason, state.message, state.reason === 'DIRECTORY_PERMISSION_REQUIRED' ? 'FORBIDDEN' : 'RESOURCE_CONFLICT');
        directory = state.directory;
      }
      if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        throw failure('DIRECTORY_PERMISSION_REQUIRED', '插件目录需要重新授权，请在「最新版本」页选择目录并授权写入。', 'FORBIDDEN');
      }
      await validateDirectory(directory, current);
      var release = options.release;
      if (!release) {
        try { release = await globalThis.ReleaseUpdate.fetchLatest(); }
        catch (error) { throw failure('CHECK_FAILED', '检查更新失败：' + error.message, 'UPSTREAM_FAILED'); }
      }
      if (options.version && options.version !== release.version) throw failure('RELEASE_CHANGED', '最新版本已变化，请重新查询后更新。');
      if (!newerVersion(release.version, current.version)) throw failure('UP_TO_DATE', '当前已是最新版本。');
      if (!release.downloadUrl) throw failure('RELEASE_ASSET_MISSING', '此版本尚未提供插件 ZIP 包。');
      checkAbort(options.signal);
      var files;
      try { files = await downloadFiles(release, current, status, options.signal); }
      catch (error) {
        checkAbort(options.signal);
        throw failure('DOWNLOAD_FAILED', error.message, 'UPSTREAM_FAILED');
      }
      checkAbort(options.signal);
      var result = await applyFiles(directory, files, status, options.signal);
      return Object.assign(result, { currentVersion: current.version, appliedVersion: release.version, reloadRequired: true,
        message: '更新已写入，请在「最新版本」页重新加载插件。',
        settingsUrl: chrome.runtime.getURL('options/options.html?section=release') });
    });
  }

  globalThis.ExtensionUpdate = {
    directorySetting: directorySetting, newerVersion: newerVersion, validateDirectory: validateDirectory,
    getStatus: getStatus, update: update,
  };
})();
