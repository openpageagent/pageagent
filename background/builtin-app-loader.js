(function (root) {
  'use strict';
  function create(options) {
    var bundles, installed, currentIds;
    function warn(error) { options.addLog('内置应用加载失败: ' + error.message, { level: 'warn' }); }
    async function read(path) {
      var response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
      if (!response.ok) throw new Error(path + ' 加载失败: HTTP ' + response.status);
      var raw = await response.text();
      if (new Blob([raw]).size > 50 * 1024 * 1024) throw new Error(path + ' 超过 50 MiB');
      return raw;
    }
    async function hash(raw) {
      var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return 'sha256:' + Array.from(new Uint8Array(digest), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    }
    function loadBundles() {
      if (!bundles) bundles = (async function () {
        var index = JSON.parse(await read('builtin-apps/index.json'));
        if (index.version !== 1 || !Array.isArray(index.apps)) throw new Error('无效的内置应用索引');
        var result = [], ids = new Set(), slugs = new Set(), complete = true;
        for (var entry of index.apps) {
          try {
            if (!entry || typeof entry.file !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(entry.file) || entry.file.includes('..') || entry.file === 'index.json') throw new Error('无效的内置应用文件名');
            var raw = await read('builtin-apps/' + entry.file), digest = await hash(raw);
            if (entry.hash !== digest) throw new Error(entry.file + ' 与索引指纹不一致，请重新同步索引');
            var bundle = root.AppPackage.validateBuiltin(JSON.parse(raw));
            // Snapshot declared source files into the same code records used by editing and backups.
            // Their content participates in updates even when the application JSON is unchanged.
            for (var app of bundle.apps) {
              var files = {};
              for (var pair of Object.entries(root.AppPackage.builtinSourceFiles(app))) files[pair[0]] = await read(pair[1]);
              if (Object.keys(files).length) Object.values(app.slots).forEach(function (code) { code.files = Object.assign({}, code.files, files); });
              root.AppPackage.validateItem(app, app.generationScope);
            }
            digest = await hash(raw + '\n' + JSON.stringify(bundle.apps.map(function (app) { return app.slots; })));
            bundle.apps.forEach(function (app) {
              var slug = root.AppContract.slug(app.slug);
              if (ids.has(app.appId) || slug && slugs.has(slug)) throw new Error(entry.file + ' 的应用 ID 或别名与其他包重复: ' + app.appId);
            });
            bundle.apps.forEach(function (app) { ids.add(app.appId); if (app.slug) slugs.add(root.AppContract.slug(app.slug)); });
            result.push({ file: entry.file, hash: digest, bundle: bundle });
          } catch (error) { complete = false; warn(error); }
        }
        // Loading failures must not be mistaken for removed applications.
        if (complete) currentIds = ids;
        return result;
      })().catch(function (error) { warn(error); return []; });
      return bundles;
    }
    async function applyToConfig(config) {
      var runtime = structuredClone(config);
      for (var item of await loadBundles()) {
        Object.keys(item.bundle.resources).forEach(function (section) {
          runtime[section] = runtime[section] || {};
          Object.keys(item.bundle.resources[section]).forEach(function (id) {
            // A packaged dependency must never overwrite a user resource or another template.
            if (Object.prototype.hasOwnProperty.call(runtime[section], id)) return;
            var value = root.PageAgentConfigMigration.cleanItem(section, structuredClone(item.bundle.resources[section][id]));
            runtime[section][id] = Object.assign(value, { __builtin: true, __builtinSection: section, __builtinRole: 'dependency', __builtinFile: item.file, __builtinHash: item.hash });
          });
        });
      }
      return runtime;
    }
    function install(store) {
      if (!installed) installed = (async function () {
        var items = await loadBundles();
        if (currentIds) {
          var converted = await store.tx(['app_meta'], 'readwrite', function (t) {
            var updated = [], request = t.store('app_meta').openCursor();
            request.onsuccess = function () {
              var cursor = request.result;
              if (!cursor) { t.result(updated); return; }
              var meta = cursor.value;
              if (meta.__builtin === true && !currentIds.has(meta.appId)) {
                delete meta.__builtin;
                delete meta.__builtinFile;
                delete meta.__builtinHash;
                delete meta.__builtinDefaultPermissions;
                delete meta.__builtinPermissionsInitialized;
                meta.revision = root.AppContract.revision();
                meta.updatedAt = Date.now();
                cursor.update(meta);
                updated.push({ appId: meta.appId, revision: meta.revision });
              }
              cursor.continue();
            };
          });
          converted.forEach(function (app) { store.emit(app.appId, 'metadata', null, app.revision); });
        }
        for (var item of items) {
          for (var app of item.bundle.apps) {
            try {
              var current = await store.get('app_meta', app.appId);
              if (root.AppPackage.builtinIsCurrent(current, app, item.hash)) continue;
              var result = await root.AppPackage.importApp(store, app, app.generationScope, null, item);
              if (!result.unchanged) store.emit(app.appId, 'imported', null, result.revision);
            } catch (error) { warn(new Error(item.file + ' / ' + app.appId + ': ' + error.message)); }
          }
        }
      })();
      return installed;
    }
    return { applyToConfig: applyToConfig, install: install };
  }
  root.BuiltinAppLoader = Object.freeze({ create: create });
})(globalThis);
