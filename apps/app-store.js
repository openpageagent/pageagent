// Applications are content, never part of page_agent_config. Opening is lazy.
(function (root) {
  'use strict';
  var C = root.AppContract;
  function create(options) {
    options = options || {};
    var pending;
    var notify = options.notify || function () {};
    function open() {
      if (pending) return pending;
      pending = new Promise(function (resolve, reject) {
        var request = indexedDB.open('page_agent_apps_' + (options.incognito ? 'incognito' : 'regular'), 2);
        request.onupgradeneeded = function (event) {
          var db = request.result;
          if (event.oldVersion < 1) {
            var meta = db.createObjectStore('app_meta', { keyPath: 'appId' });
            meta.createIndex('name', ['normalizedName', 'appId']);
            meta.createIndex('used', ['lastUsedAt', 'appId']);
            meta.createIndex('updated', ['updatedAt', 'appId']);
            db.createObjectStore('app_code', { keyPath: ['appId', 'slot'] });
            db.createObjectStore('app_permissions', { keyPath: 'appId' });
            db.createObjectStore('app_data', { keyPath: ['appId', 'key'] });
            db.createObjectStore('app_assets', { keyPath: ['appId', 'assetName'] });
          }
          request.transaction.objectStore('app_meta').createIndex('slug', 'slug', { unique: true });
        };
        request.onsuccess = function () {
          var db = request.result;
          db.onversionchange = function () { db.close(); pending = null; };
          resolve(db);
        };
        request.onerror = function () { pending = null; reject(storageError(request.error)); };
        request.onblocked = function () { pending = null; reject(C.error('STORAGE_BUSY', '应用数据库升级被占用，请关闭旧应用页面后重试')); };
      });
      return pending;
    }
    function storageError(error) {
      if (error && error.code && typeof error.code === 'string') return error;
      return C.error(error && error.name === 'QuotaExceededError' ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_FAILED', '应用存储失败，已提交的数据仍保留: ' + (error && error.message || error));
    }
    function normalizePermissions(permission) {
      if (!permission || !permission.slots) return permission;
      // Keep explicit denials when folding the old per-version grants into one application scope.
      var disabled = new Set();
      Object.values(permission.slots).forEach(function (grants) {
        Object.keys(grants).forEach(function (name) {
          if (grants[name].enabled === false) disabled.add(name.indexOf('action:') === 0 ? 'actions.run' : name);
        });
      });
      permission.generationScope = permission.generationScope.filter(function (name) { return !disabled.has(name); });
      delete permission.slots; delete permission.defaultEnabled;
      return permission;
    }
    function tx(stores, mode, work) {
      return Promise.resolve().then(function () { if (options.beforeAccess) return options.beforeAccess(); }).then(open).then(function (db) {
        return new Promise(function (resolve, reject) {
          var transaction = db.transaction(stores, mode);
          var result, failure;
          var context = {
            store: function (name) { return transaction.objectStore(name); },
            result: function (value) { result = value; },
            fail: function (error) { failure = error; transaction.abort(); },
            get: function (name, key, callback) {
              var request = transaction.objectStore(name).get(key);
              request.onsuccess = function () { try { callback(name === 'app_permissions' ? normalizePermissions(request.result) : request.result); } catch (error) { context.fail(error); } };
            }
          };
          transaction.oncomplete = function () { resolve(result); };
          transaction.onabort = function () { reject(storageError(failure || transaction.error)); };
          transaction.onerror = function () {};
          try { work(context); } catch (error) { context.fail(error); }
        });
      });
    }
    function get(store, key) { return tx([store], 'readonly', function (t) { t.get(store, key, t.result); }); }
    function findBySlug(value) {
      var slug = C.slug(value);
      if (!slug) return Promise.resolve(undefined);
      return tx(['app_meta'], 'readonly', function (t) {
        var request = t.store('app_meta').index('slug').get(slug);
        request.onsuccess = function () { t.result(request.result); };
      });
    }
    function putMeta(t, meta, add) {
      var request = t.store('app_meta')[add ? 'add' : 'put'](meta);
      request.onerror = function () {
        if (request.error.name === 'ConstraintError' && meta.slug) t.fail(C.error('ADDRESS_CONFLICT', '应用别名“' + meta.slug + '”已被其他应用使用，请更换'));
      };
    }
    function required(value) { if (!value) throw C.error('RESOURCE_NOT_FOUND', '应用不存在或已删除'); return value; }
    function assertEditable(meta) { if (meta && meta.__builtin) throw C.error('RESOURCE_CONFLICT', '内置应用不能直接修改、覆盖或删除，请使用“复制后修改”创建副本'); }
    function match(actual, expected) {
      if (!expected || actual !== expected) throw C.error('REVISION_CONFLICT', '内容已被其他编辑修改，请重新读取；当前未保存输入已保留');
    }
    function range(appId) { return IDBKeyRange.bound([appId], [appId, []]); }
    function removeRange(t, store, appId) { t.store(store).delete(range(appId)); }
    function emitted(appId, type, slot, revision, generation) {
      notify({ type: 'APP_CHANGED', appId: appId, change: type, slot: slot || null, revision: revision || null, generation: generation });
    }
    function initialPermissions(appId, scope) { return { appId: appId, generationScope: scope, enabled: false, resources: [], generation: 1, channelGeneration: 1 }; }
    function codeRecord(appId, slot, revision, code) {
      return { appId: appId, slot: slot, revision: revision, code: code, bytes: new Blob([code.html, code.css, code.javascript, code.themeCss, JSON.stringify(Object.assign({}, code, { html: '', css: '', javascript: '', themeCss: '' }))]).size };
    }
    function summarySlot(record) { return { revision: record.revision, bytes: record.bytes, description: record.code.description, parameters: record.code.parameters ?? C.noParameters(), files: Object.keys(record.code.files || {}), capabilities: record.code.capabilities, declarations: C.declarations(record.code), dependencies: record.code.dependencies, customBehavior: record.code.customBehavior, externalResources: record.code.externalResources }; }
    function metadata(input, old) {
      var name = String(input.name === undefined && old ? old.name : input.name || '').trim();
      if (!name) throw C.error('SCHEMA_VALIDATION_FAILED', '应用名称不能为空');
      if (name.length > C.limits.nameLength && (!old || input.name !== undefined)) throw C.error('SCHEMA_VALIDATION_FAILED', '应用名称最多 ' + C.limits.nameLength + ' 个字符');
      var icon = input.icon || old && old.icon || 'fa-cube';
      if (!Object.prototype.hasOwnProperty.call(C.ICONS, icon)) throw C.error('SCHEMA_VALIDATION_FAILED', '请选择当前图标目录中的图标');
      return { name: name, normalizedName: C.normalizeName(name), slug: C.slug(input.slug === undefined && old ? old.slug : input.slug), icon: icon, description: input.description === undefined ? old ? old.description : String(input.code && input.code.description || '') : String(input.description || '') };
    }
    async function createApp(input) {
      var appId = 'app_' + C.revision().replace(/-/g, '');
      var scope = input.generationScope === undefined ? C.CAPABILITIES.slice() : input.generationScope;
      C.validateCode(input.code, scope);
      var rev = C.revision(), now = Date.now();
      var record = codeRecord(appId, 'draft', rev, input.code);
      var meta = Object.assign(metadata(input), { appId: appId, revision: rev, createdAt: now, updatedAt: now, lastUsedAt: 0, sourceConversationId: input.sourceConversationId || '', slots: { draft: summarySlot(record) }, unpublished: true, bytes: record.bytes });
      var permission = initialPermissions(appId, scope);
      permission.enabled = true; permission.resources = input.resourcePermissions || [];
      await tx(['app_meta', 'app_code', 'app_permissions'], 'readwrite', function (t) {
        putMeta(t, meta, true); t.store('app_code').add(record); t.store('app_permissions').add(permission);
      });
      emitted(appId, 'created', 'draft', rev, 1);
      return meta;
    }
    async function patchMetadata(appId, expected, input) {
      var result = await tx(['app_meta'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta); assertEditable(meta); match(meta.revision, expected);
          Object.assign(meta, metadata(input, meta), { revision: C.revision(), updatedAt: Date.now() });
          putMeta(t, meta); t.result(meta);
        });
      });
      emitted(appId, 'metadata', null, result.revision);
      return result;
    }
    async function save(appId, expected, input) {
      var rev = C.revision();
      var record = codeRecord(appId, 'draft', rev, input.code);
      var result = await tx(['app_meta', 'app_code', 'app_permissions', 'app_assets'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta); assertEditable(meta); match(meta.revision, expected);
          t.get('app_permissions', appId, function (permission) {
            C.validateCode(input.code, permission.generationScope);
            if (!meta.slots.draft && meta.slots.published) {
              meta.assetBytesBySlot = meta.assetBytesBySlot || { draft: 0, published: 0 };
              meta.assetBytesBySlot.draft = meta.assetBytesBySlot.published;
              meta.assetBytes = meta.assetBytesBySlot.draft + meta.assetBytesBySlot.published;
              var assets = t.store('app_assets'), cursor = assets.openCursor(IDBKeyRange.bound([appId, 'theme/published/'], [appId, 'theme/published/\uffff']));
              cursor.onsuccess = function () {
                var item = cursor.result; if (!item) return;
                assets.put(Object.assign({}, item.value, { assetName: item.value.assetName.replace('theme/published/', 'theme/draft/') })); item.continue();
              };
            }
            Object.assign(meta, metadata(input, meta), { revision: rev, updatedAt: Date.now(), unpublished: true });
            meta.slots.draft = summarySlot(record);
            meta.bytes = record.bytes + (meta.slots.published ? meta.slots.published.bytes : 0) + (meta.assetBytes || 0) + (meta.dataBytes || 0);
            permission.generation++;
            putMeta(t, meta); t.store('app_code').put(record); t.store('app_permissions').put(permission);
            t.result({ meta: meta, generation: permission.generation });
          });
        });
      });
      emitted(appId, 'saved', 'draft', rev, result.generation);
      return result.meta;
    }
    async function publish(appId, expected) {
      var result = await tx(['app_meta', 'app_code', 'app_permissions', 'app_assets'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta); assertEditable(meta); match(meta.revision, expected);
          t.get('app_code', [appId, 'draft'], function (draft) {
            required(draft);
            t.get('app_permissions', appId, function (permission) {
              C.validateCode(draft.code, permission.generationScope);
              C.validateExecutionDependencies(draft.code);
              var rev = C.revision();
              var record = Object.assign({}, draft, { slot: 'published', revision: rev });
              meta.slots.published = summarySlot(record);
              meta.assetBytesBySlot = meta.assetBytesBySlot || { draft: 0, published: 0 };
              meta.assetBytesBySlot.published = meta.assetBytesBySlot.draft;
              meta.assetBytes = meta.assetBytesBySlot.draft + meta.assetBytesBySlot.published;
              meta.revision = rev; meta.updatedAt = Date.now(); meta.unpublished = false; meta.bytes = draft.bytes + record.bytes + meta.assetBytes + (meta.dataBytes || 0);
              permission.generation++;
              var assets = t.store('app_assets'), names = new Set();
              assets.delete(IDBKeyRange.bound([appId, 'theme/published/'], [appId, 'theme/published/\uffff']));
              var cursor = assets.openCursor(IDBKeyRange.bound([appId, 'theme/draft/'], [appId, 'theme/draft/\uffff']));
              cursor.onsuccess = function () {
                var item = cursor.result;
                if (!item) {
                  try { C.validateAssets(draft.code, 'draft', names); } catch (error) { t.fail(error); }
                  return;
                }
                names.add(item.value.assetName);
                assets.put(Object.assign({}, item.value, { assetName: item.value.assetName.replace('theme/draft/', 'theme/published/') }));
                item.continue();
              };
              t.store('app_code').put(record); t.store('app_meta').put(meta); t.store('app_permissions').put(permission);
              t.result({ meta: meta, generation: permission.generation });
            });
          });
        });
      });
      emitted(appId, 'published', 'published', result.meta.revision, result.generation);
      return result.meta;
    }
    async function permissions(appId, expectedGeneration, input) {
      var result = await tx(['app_meta', 'app_permissions'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta);
          t.get('app_permissions', appId, function (p) {
            if (p.generation !== expectedGeneration) throw C.error('AUTHORIZATION_CHANGED', '权限已变化，请重新读取后操作');
            if (input.enabled !== undefined && p.enabled !== (input.enabled === true)) { p.enabled = input.enabled === true; p.channelGeneration = (p.channelGeneration || 1) + 1; }
            if (input.generationScope !== undefined) {
              if (!Array.isArray(input.generationScope) || input.generationScope.some(function (key) { return C.CAPABILITIES.indexOf(key) === -1; })) throw C.error('SCHEMA_VALIDATION_FAILED', '无效的生成范围');
              if (p.generationScope.some(function (key) { return !input.generationScope.includes(key); })) p.channelGeneration = (p.channelGeneration || 1) + 1;
              p.generationScope = input.generationScope;
            }
            if (input.resources !== undefined) {
              // Running actions also consume module permissions through local nodes.
              if ((p.resources || []).some(function (name) { return !input.resources.includes(name); })) p.channelGeneration = (p.channelGeneration || 1) + 1;
              p.resources = input.resources.slice();
            }
            p.generation++;
            t.store('app_permissions').put(p); t.result(p);
          });
        });
      });
      emitted(appId, 'permissions', null, null, result.generation);
      return result;
    }
    async function remove(appId, expected) {
      await tx(['app_meta', 'app_code', 'app_permissions', 'app_data', 'app_assets'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta); assertEditable(meta); match(meta.revision, expected);
          t.store('app_permissions').delete(appId);
          t.store('app_meta').delete(appId);
          ['app_code', 'app_data', 'app_assets'].forEach(function (name) { removeRange(t, name, appId); });
        });
      });
      emitted(appId, 'deleted');
      return { appId: appId, deleted: true };
    }
    async function copyApp(appId, expected) {
      var copyId = 'app_' + C.revision().replace(/-/g, ''), revision = C.revision(), now = Date.now();
      await tx(['app_meta', 'app_code', 'app_permissions', 'app_assets'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (source) {
          required(source); match(source.revision, expected);
          t.get('app_permissions', appId, function (permission) {
            var suffix = '（副本）', copyName = source.name.slice(0, C.limits.nameLength - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
            var meta = Object.assign(metadata({ name: copyName, icon: source.icon, description: source.description }), { appId: copyId, revision: revision, createdAt: now, updatedAt: now, lastUsedAt: 0, sourceConversationId: '', slots: {}, unpublished: source.unpublished, bytes: source.bytes - (source.dataBytes || 0), dataBytes: 0, assetBytes: source.assetBytes || 0, assetBytesBySlot: source.assetBytesBySlot || { draft: 0, published: 0 } });
            t.store('app_permissions').add(initialPermissions(copyId, permission.generationScope));
            Object.keys(source.slots).forEach(function (slot) {
              t.get('app_code', [appId, slot], function (record) {
                required(record);
                var copied = codeRecord(copyId, slot, revision, record.code);
                meta.slots[slot] = summarySlot(copied); t.store('app_code').add(copied);
                if (Object.keys(meta.slots).length === Object.keys(source.slots).length) putMeta(t, meta, true);
              });
            });
            var request = t.store('app_assets').openCursor(range(appId));
            request.onsuccess = function () {
              var cursor = request.result; if (!cursor) return;
              t.store('app_assets').add(Object.assign({}, cursor.value, { appId: copyId })); cursor.continue();
            };
          });
        });
      });
      emitted(copyId, 'created', null, revision, 1);
      return { appId: copyId, revision: revision };
    }
    function list(query) {
      query = query || {};
      var prefix = C.normalizeName(query.prefix), sort = prefix ? 'name' : query.sort === 'updated' ? 'updated' : 'used';
      var limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 24)));
      var after;
      if (query.cursor) {
        try { after = JSON.parse(query.cursor); } catch (_) { throw C.error('INVALID_CURSOR', '无效游标'); }
        if (!after || after.sort !== sort || after.prefix !== prefix || !Array.isArray(after.key) || after.key.length !== 2 || typeof after.key[1] !== 'string' || typeof after.key[0] !== (sort === 'name' ? 'string' : 'number')) throw C.error('INVALID_CURSOR', '无效游标，搜索或排序变化后需重新分页');
      }
      return tx(['app_meta'], 'readonly', function (t) {
        var bounds = prefix ? IDBKeyRange.bound([prefix, ''], [prefix + '\uffff', '\uffff']) : null;
        var index = t.store('app_meta').index(sort), result = { items: [], total: 0, nextCursor: null };
        var count = index.count(bounds || undefined);
        count.onsuccess = function () { result.total = count.result; };
        if (after) bounds = sort === 'name' ? IDBKeyRange.bound(after.key, [prefix + '\uffff', '\uffff'], true, false) : IDBKeyRange.upperBound(after.key, true);
        var items = result.items, lastKey = null;
        var request = index.openCursor(bounds, sort === 'name' ? 'next' : 'prev');
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor) { t.result(result); return; }
          if (items.length === limit) { result.nextCursor = JSON.stringify({ sort: sort, prefix: prefix, key: lastKey }); t.result(result); return; }
          var meta = cursor.value;
          Object.values(meta.slots).forEach(function (slot) { slot.parameters = slot.parameters ?? C.noParameters(); });
          items.push(meta); lastKey = cursor.key; cursor.continue();
        };
      });
    }
    function data(appId, operation, input, guard) {
      input = input || {};
      var valueBytes = 0;
      if (!['get', 'list', 'set', 'delete'].includes(operation)) throw C.error('UNSUPPORTED_CAPABILITY', '未知数据操作');
      if (operation === 'set') {
        var serialized = C.json(input.value);
        input.value = JSON.parse(serialized); valueBytes = new Blob([serialized]).size;
      }
      if (operation !== 'list' && (typeof input.key !== 'string' || !input.key)) throw C.error('SCHEMA_VALIDATION_FAILED', '数据 key 不能为空');
      return tx(['app_data', 'app_meta', 'app_permissions'], operation === 'get' || operation === 'list' ? 'readonly' : 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta);
          t.get('app_permissions', appId, function (permission) {
            if (guard) guard(meta, permission);
            var store = t.store('app_data');
            if (operation === 'list') {
              if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== 'string') throw C.error('INVALID_CURSOR', '数据游标必须为字符串');
              var items = [], last = null, limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 24)));
              var request = store.openCursor(IDBKeyRange.bound([appId, input.cursor || ''], [appId, []], !!input.cursor));
              request.onsuccess = function () {
                var cursor = request.result;
                if (!cursor) { t.result({ items: items, nextCursor: null }); return; }
                if (items.length === limit) { t.result({ items: items, nextCursor: last }); return; }
                items.push(cursor.value); last = cursor.value.key; cursor.continue();
              };
            } else t.get('app_data', [appId, input.key], function (old) {
              if (operation === 'get') { t.result(old || { key: input.key, value: null, version: null }); return; }
              if ((old ? old.version : null) !== input.version) throw C.error('DATA_CONFLICT', '业务数据已变化，请读取最新数据后重试');
              var result = { appId: appId, key: input.key, value: input.value, version: C.revision(), bytes: valueBytes };
              if (operation === 'delete') { store.delete([appId, input.key]); result = { key: input.key, deleted: true }; }
              else store.put(result);
              var byteDelta = (operation === 'delete' ? 0 : valueBytes) - (old && old.bytes || 0);
              meta.dataBytes = (meta.dataBytes || 0) + byteDelta; meta.bytes += byteDelta;
              meta.dataRevision = C.revision(); t.store('app_meta').put(meta);
              t.result(result);
            });
          });
        });
      });
    }
    function touch(appId, countOpen) {
      return tx(['app_meta'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          if (!meta) return;
          meta.lastUsedAt = Date.now();
          if (countOpen) meta.openCount = (Number.isSafeInteger(meta.openCount) ? meta.openCount : 0) + 1;
          t.store('app_meta').put(meta);
          t.result({ lastUsedAt: meta.lastUsedAt, openCount: meta.openCount || 0 });
        });
      });
    }
    async function putAsset(appId, expected, name, blob) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..') || !(blob instanceof Blob)) throw C.error('SCHEMA_VALIDATION_FAILED', '资源必须是带简单文件名的 Blob');
      var revision = C.revision();
      var result = await tx(['app_meta', 'app_code', 'app_assets', 'app_permissions'], 'readwrite', function (t) {
        t.get('app_meta', appId, function (meta) {
          required(meta); assertEditable(meta); match(meta.revision, expected);
          t.get('app_code', [appId, 'draft'], function (record) {
            required(record);
            t.get('app_assets', [appId, 'theme/draft/assets/' + name], function (old) {
              t.get('app_permissions', appId, function (permission) {
                var delta = blob.size - (old ? old.blob.size : 0);
                record.revision = revision; meta.slots.draft = summarySlot(record);
                meta.assetBytesBySlot = meta.assetBytesBySlot || { draft: 0, published: 0 };
                meta.assetBytesBySlot.draft += delta; meta.assetBytes = (meta.assetBytes || 0) + delta; meta.bytes += delta;
                meta.revision = revision; meta.updatedAt = Date.now(); meta.unpublished = true; permission.generation++;
                t.store('app_assets').put({ appId: appId, assetName: 'theme/draft/assets/' + name, blob: blob });
                t.store('app_meta').put(meta); t.store('app_code').put(record); t.store('app_permissions').put(permission);
                t.result(meta);
              });
            });
          });
        });
      });
      emitted(appId, 'saved', 'draft', revision);
      return result;
    }
    return { tx: tx, get: get, findBySlug: findBySlug, putMeta: putMeta, list: list, create: createApp, patchMetadata: patchMetadata, save: save, publish: publish, permissions: permissions, remove: remove, copy: copyApp, data: data, touch: touch, putAsset: putAsset, required: required, assertEditable: assertEditable, range: range, emit: emitted, initialPermissions: initialPermissions, codeRecord: codeRecord, summarySlot: summarySlot };
  }
  root.AppStore = Object.freeze({ create: create });
})(globalThis);
