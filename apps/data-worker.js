// Large values stay in the application instance. The bridge issues a small
// grant and the IDB transaction checks the current persisted grant again.
'use strict';
importScripts('/shared/app-contract.js', '/apps/app-store.js');
var temporary = new Map();
var store;
self.onmessage = async function (event) {
  var message = event.data, auth = message.authorization;
  try {
    if (!store) store = AppStore.create({ incognito: message.incognito });
    var operation = message.operation, input = message.input;
    if (!['get', 'list', 'set', 'delete'].includes(operation)) throw AppContract.error('UNSUPPORTED_CAPABILITY', '未知数据操作');
    var permissionName = operation === 'get' || operation === 'list' ? 'data.read' : operation === 'set' ? 'data.write' : 'data.delete';
    if (auth.permission !== permissionName) throw AppContract.error('PERMISSION_DENIED', '数据操作与授权票据不匹配');
    function guard(meta, permission) { AppContract.checkPermission(meta, permission, auth.slot, auth.permission, auth); }
    var result;
    if (auth.slot === 'published') result = await store.data(auth.appId, operation, input, guard);
    else {
      await store.tx(['app_meta', 'app_permissions'], 'readonly', function (t) {
        t.get('app_meta', auth.appId, function (meta) { t.get('app_permissions', auth.appId, function (permission) { guard(meta, permission); }); });
      });
      if (operation === 'list') {
        if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== 'string') throw AppContract.error('INVALID_CURSOR', '数据游标必须为字符串');
        var keys = Array.from(temporary.keys()).sort().filter(function (key) { return !input.cursor || key > input.cursor; });
        var limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 24))), page = keys.slice(0, limit);
        result = { items: page.map(function (key) { return temporary.get(key); }), nextCursor: keys.length > limit ? page[page.length - 1] : null };
      } else {
        if (typeof input.key !== 'string' || !input.key) throw new Error('数据 key 不能为空');
        var previous = temporary.get(input.key);
        if (operation === 'get') result = previous || { key: input.key, value: null, version: null };
        else {
          if ((previous ? previous.version : null) !== input.version) throw AppContract.error('DATA_CONFLICT', '预览数据已变化，请重新读取');
          if (operation === 'delete') { temporary.delete(input.key); result = { key: input.key, deleted: true }; }
          else { result = { key: input.key, value: JSON.parse(AppContract.json(input.value)), version: AppContract.revision() }; temporary.set(input.key, result); }
        }
      }
    }
    self.postMessage({ id: message.id, result: result });
  } catch (error) { self.postMessage({ id: message.id, error: { code: error.code || 'DATA_ERROR', message: error.message } }); }
};
