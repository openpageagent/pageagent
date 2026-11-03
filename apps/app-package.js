// Shared package validation and atomic installation for backups and built-in apps.
(function (root) {
  'use strict';
  var C = root.AppContract;
  var RESOURCE_SECTIONS = ['pages', 'scripts', 'flows', 'flowGroups'];
  function builtinSourceFiles(item) {
    var files = item.sourceFiles;
    if (files === undefined) return {};
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('内置应用 sourceFiles 必须为文件名与插件路径的映射');
    Object.keys(files).forEach(function (name) {
      C.sourceFileName(name);
      var path = files[name];
      if (typeof path !== 'string' || path.includes('..') || !/^builtin-apps\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(js|css)$/.test(path) && path !== 'apps/default-theme.css'
          || path.slice(path.lastIndexOf('.')) !== name.slice(name.lastIndexOf('.'))) throw new Error('无效的内置应用源码路径: ' + path);
      Object.values(item.slots).forEach(function (code) {
        if (code.files && Object.prototype.hasOwnProperty.call(code.files, name)) throw new Error('内置应用源码文件重复: ' + name);
      });
    });
    return files;
  }
  function builtinDefaultPermissions(item) {
    var value = item.defaultPermissions;
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(function (key) { return key !== 'enabled' && key !== 'resources'; })
        || typeof value.enabled !== 'boolean'
        || value.resources !== 'system' && (!Array.isArray(value.resources)
          || value.resources.some(function (name) { return typeof name !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name); })
          || new Set(value.resources).size !== value.resources.length)) throw new Error('内置应用 defaultPermissions 必须声明 enabled，resources 为 system 或不重复的模块权限数组');
    return { enabled: value.enabled, generationScope: item.generationScope.slice(), resources: value.resources === 'system' ? 'system' : value.resources.slice() };
  }
  function builtinIsCurrent(meta, item, hash) {
    return !!(meta && meta.__builtin && meta.__builtinHash === hash
      && (item.defaultPermissions === undefined || meta.__builtinPermissionsInitialized === true));
  }
  function validateItem(item, scope) {
    C.id(item.appId);
    C.slug(item.slug);
    if (typeof item.name !== 'string' || !item.name.trim() || !item.slots || !item.slots.draft && !item.slots.published) throw new Error('应用包缺少名称或源码槽位');
    if (item.name.length > C.limits.nameLength) throw new Error('应用名称最多 ' + C.limits.nameLength + ' 个字符');
    Object.keys(item.slots).forEach(function (slot) {
      if (slot !== 'draft' && slot !== 'published') throw new Error('应用包只允许 draft 和 published 两个槽位');
      C.validateCode(item.slots[slot], scope, { parameterFiles: item.sourceFiles });
    });
    if (!Array.isArray(item.assets) || !Array.isArray(item.data)) throw new Error('应用资源与数据格式无效');
    if (typeof item.dataIncluded !== 'boolean' || !item.dataIncluded && item.data.length) throw new Error('应用包必须明确是否包含业务数据，未包含时 data 必须为空');
    var names = new Set(), keys = new Set();
    item.assets.forEach(function (asset) {
      if (!/^theme\/(draft|published)\/[A-Za-z0-9_./-]+$/.test(asset.name) || asset.name.includes('..') || names.has(asset.name)) throw new Error('主题资源路径非法或重复');
      names.add(asset.name);
      if (!item.slots[asset.name.split('/')[1]]) throw new Error('主题资源引用了不存在的槽位');
      atob(asset.base64);
    });
    Object.keys(item.slots).forEach(function (slot) { C.validateAssets(item.slots[slot], slot, names); });
    item.data.forEach(function (record) {
      if (typeof record.key !== 'string' || !record.key || keys.has(record.key)) throw new Error('业务数据 key 非法或重复');
      keys.add(record.key); C.json(record.value);
    });
  }
  function validateBuiltin(pkg) {
    // Keep packages already exported before the export entry points were unified readable.
    if (pkg && pkg.kind === 'pfa-app' && pkg.version === 1 && Array.isArray(pkg.apps)) {
      var modules = { apps: { items: Object.create(null) } };
      pkg.apps.forEach(function (item) {
        C.id(item && item.appId);
        if (modules.apps.items[item.appId]) throw new Error('内置应用 ID 重复: ' + item.appId);
        modules.apps.items[item.appId] = item;
      });
      Object.keys(pkg.resources || {}).forEach(function (section) {
        if (!RESOURCE_SECTIONS.includes(section)) throw new Error('不支持自动内置此依赖模块: ' + section);
        modules[section] = { items: pkg.resources[section] };
      });
      pkg = { kind: 'pfa-full-backup', version: 7, modules: modules };
    }
    if (!pkg || pkg.kind !== 'pfa-full-backup' || ![6, 7].includes(pkg.version) || !pkg.modules || typeof pkg.modules !== 'object' || Array.isArray(pkg.modules)) throw new Error('请使用「导出应用」生成的 JSON 包（版本 6 或 7）');
    var appModule = pkg.modules.apps, items = appModule && appModule.items;
    if (!items || typeof items !== 'object' || Array.isArray(items) || !Object.keys(items).length) throw new Error('导出包中没有应用');
    var apps = Object.keys(items).map(function (id) {
      if (!items[id] || items[id].appId !== id) throw new Error('应用条目 ID 与 appId 不一致: ' + id);
      return items[id];
    });
    var ids = new Set(), slugs = new Set();
    apps.forEach(function (item) {
      validateItem(item, item.generationScope);
      builtinDefaultPermissions(item);
      builtinSourceFiles(item);
      if (!item.slots.published) throw new Error('内置应用必须已发布: ' + item.name);
      if (item.dataIncluded !== false || item.data.length) throw new Error('用于内置的应用包不能包含业务数据，请重新导出并选择不包含业务数据: ' + item.name);
      if (ids.has(item.appId)) throw new Error('内置应用 ID 重复: ' + item.appId);
      ids.add(item.appId);
      var slug = C.slug(item.slug);
      if (slug && slugs.has(slug)) throw new Error('内置应用别名重复: ' + slug);
      if (slug) slugs.add(slug);
      Object.values(item.slots).forEach(function (code) {
        C.validateParameters(code, { parameterFiles: item.sourceFiles });
        C.validateExecutionDependencies(code);
      });
    });
    var resources = {};
    RESOURCE_SECTIONS.forEach(function (section) {
      if (!Object.prototype.hasOwnProperty.call(pkg.modules, section)) return;
      var module = pkg.modules[section], items = module && module.items;
      if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('内置依赖必须按 ID 存储: ' + section);
      Object.keys(items).forEach(function (id) {
        if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || !items[id] || typeof items[id] !== 'object' || Array.isArray(items[id]) || items[id].id && items[id].id !== id) throw new Error('无效的内置依赖: ' + section + '/' + id);
      });
      resources[section] = items;
    });
    return { apps: apps, resources: resources };
  }
  async function importApp(store, item, scope, expected, builtin) {
    validateItem(item, scope);
    // Only the packaged built-in loader may grant declared defaults. A regular import cannot.
    var defaults = builtin ? builtinDefaultPermissions(item) : null;
    var defaultResources = defaults && (defaults.resources === 'system' ? root.SystemRuntimePermissions.permissions : defaults.resources);
    Object.values(item.slots).forEach(function (code) { C.validateExecutionDependencies(code); });
    var records = {}, slots = {}, bytes = 0, dataBytes = 0, assetBytesBySlot = { draft: 0, published: 0 };
    Object.keys(item.slots).forEach(function (slot) {
      var record = store.codeRecord(item.appId, slot, C.revision(), item.slots[slot]); records[slot] = record; slots[slot] = store.summarySlot(record); bytes += record.bytes;
    });
    var assets = item.assets.map(function (asset) {
      var raw = atob(asset.base64), bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      assetBytesBySlot[asset.name.split('/')[1]] += bytes.length;
      return { appId: item.appId, assetName: asset.name, blob: new Blob([bytes], { type: asset.mime || 'application/octet-stream' }) };
    });
    var data = item.data.map(function (record) { var size = new Blob([JSON.stringify(record.value)]).size; dataBytes += size; return { appId: item.appId, key: record.key, value: record.value, version: C.revision(), bytes: size }; });
    var assetBytes = assetBytesBySlot.draft + assetBytesBySlot.published, revision = C.revision();
    return store.tx(['app_meta', 'app_code', 'app_permissions', 'app_data', 'app_assets'], 'readwrite', function (t) {
      t.get('app_meta', item.appId, function (current) {
        if (builtin) {
          if (current && !current.__builtin) throw C.error('RESOURCE_CONFLICT', '内置应用与已有应用 ID 冲突，保留已有应用: ' + item.appId);
          if (builtinIsCurrent(current, item, builtin.hash)) { t.result({ appId: item.appId, revision: current.revision, unchanged: true }); return; }
        } else {
          store.assertEditable(current);
          if (!expected || (current ? current.revision : null) !== expected.revision
              || item.dataIncluded && (current && current.dataRevision || null) !== expected.dataRevision) throw C.error('REVISION_CONFLICT', '导入目标的源码或业务数据已变化，请重新检查覆盖选择');
        }
        t.get('app_permissions', item.appId, function (old) {
          var p = builtin && old ? Object.assign({}, old) : store.initialPermissions(item.appId, scope);
          var permissionsInitialized = builtin && current && current.__builtinPermissionsInitialized === true;
          // Earlier installers could save the declaration without applying it. Repair once,
          // then preserve user choices regardless of permission generation or package updates.
          if (defaults && (!old || !permissionsInitialized)) {
            p.enabled = defaults.enabled;
            p.generationScope = defaults.generationScope.slice();
            p.resources = defaultResources.slice();
            permissionsInitialized = true;
          }
          p.generation = old ? old.generation + 1 : 1;
          if (builtin && old) p.channelGeneration = (old.channelGeneration || 1) + 1;
          t.store('app_permissions').put(p);
          var preserveData = item.dataIncluded === false;
          if (preserveData) dataBytes = current && current.dataBytes || 0;
          ['app_code', 'app_assets'].concat(preserveData ? [] : ['app_data']).forEach(function (name) { t.store(name).delete(store.range(item.appId)); });
          Object.values(records).forEach(function (record) { t.store('app_code').put(record); });
          assets.forEach(function (asset) { t.store('app_assets').put(asset); });
          if (!preserveData) data.forEach(function (record) { t.store('app_data').put(record); });
          var meta = { appId: item.appId, name: item.name, normalizedName: C.normalizeName(item.name), slug: C.slug(item.slug === undefined && current ? current.slug : item.slug), icon: Object.prototype.hasOwnProperty.call(C.ICONS, item.icon) ? item.icon : 'fa-cube', description: item.description || '', createdAt: current && builtin ? current.createdAt : item.createdAt || Date.now(), updatedAt: Date.now(), lastUsedAt: current && current.lastUsedAt || 0, revision: revision, dataRevision: builtin && current ? current.dataRevision : C.revision(), sourceConversationId: builtin ? '' : item.sourceConversationId || '', slots: slots, unpublished: item.unpublished === true || !slots.published, bytes: bytes + assetBytes + dataBytes, dataBytes: dataBytes, assetBytes: assetBytes, assetBytesBySlot: assetBytesBySlot };
          if (current && Number.isSafeInteger(current.openCount)) meta.openCount = current.openCount;
          if (builtin) Object.assign(meta, { __builtin: true, __builtinFile: builtin.file, __builtinHash: builtin.hash });
          if (defaults) meta.__builtinDefaultPermissions = defaults;
          // Commit the marker atomically with the initialized permissions, never from a declaration alone.
          if (permissionsInitialized) meta.__builtinPermissionsInitialized = true;
          store.putMeta(t, meta); t.result({ appId: item.appId, revision: revision });
        });
      });
    });
  }
  root.AppPackage = Object.freeze({ validateItem: validateItem, validateBuiltin: validateBuiltin, builtinSourceFiles: builtinSourceFiles, builtinIsCurrent: builtinIsCurrent, importApp: importApp });
})(globalThis);
