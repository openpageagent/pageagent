'use strict';
importScripts('/resources/mcp-tool-contract.js', '/resources/protocol/index.js', '/shared/app-contract.js', '/apps/app-store.js', '/apps/app-package.js');
var store;
function entries(name, appId) {
  return store.tx([name], 'readonly', function (t) {
    var values = [], request = t.store(name).openCursor(store.range(appId));
    request.onsuccess = function () { var cursor = request.result; if (!cursor) { t.result(values); return; } values.push(cursor.value); cursor.continue(); };
  });
}
async function exportApp(appId, includeData, limit) {
  var meta = store.required(await store.get('app_meta', appId));
  store.assertEditable(meta);
  if (meta.bytes - (includeData ? 0 : meta.dataBytes || 0) > limit) throw new Error('应用超出当前 JSON 备份大小上限，请缩小范围或取消业务数据');
  var permission = await store.get('app_permissions', appId);
  var item = { appId: appId, name: meta.name, slug: meta.slug || null, icon: meta.icon, description: meta.description, createdAt: meta.createdAt, sourceConversationId: meta.sourceConversationId, unpublished: meta.unpublished, generationScope: permission.generationScope, dataIncluded: includeData, slots: {}, assets: [], data: [] };
  for (var slot of Object.keys(meta.slots)) {
    var record = store.required(await store.get('app_code', [appId, slot]));
    if (record.revision !== meta.slots[slot].revision) throw AppContract.error('REVISION_CONFLICT', '导出期间应用已变化，请重试');
    item.slots[slot] = record.code;
  }
  for (var asset of await entries('app_assets', appId)) {
    var bytes = new Uint8Array(await asset.blob.arrayBuffer()), chunks = [];
    for (var offset = 0; offset < bytes.length; offset += 24576) chunks.push(btoa(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 24576))));
    item.assets.push({ name: asset.assetName, mime: asset.blob.type, base64: chunks.join('') });
  }
  if (includeData) {
    item.data = await entries('app_data', appId);
    // GitLab copies have independent IDs. Omit saved connection tokens from
    // exports; these cursor values are detached from the persisted records.
    item.data.forEach(function (record) {
      var value = record.value;
      if (record.key === 'connection' && value && typeof value.site === 'string'
          && (value.mode === 'token' || value.mode === 'session') && Object.prototype.hasOwnProperty.call(value, 'token')) {
        delete value.token;
        record.bytes = new Blob([JSON.stringify(value)]).size;
      }
    });
  }
  var current = store.required(await store.get('app_meta', appId));
  var currentPermission = store.required(await store.get('app_permissions', appId));
  if (current.revision !== meta.revision || includeData && current.dataRevision !== meta.dataRevision || AppContract.json(currentPermission.generationScope) !== AppContract.json(permission.generationScope)) throw AppContract.error('REVISION_CONFLICT', '导出期间内容、数据或生成范围已变化，请重试');
  item.exportStamp = { revision: meta.revision, dataRevision: meta.dataRevision || null, dataIncluded: includeData, generationScope: permission.generationScope };
  item.exportBytes = new Blob([JSON.stringify(item)]).size;
  if (item.exportBytes > limit) throw new Error('应用序列化后超出 JSON 备份大小上限');
  return item;
}
self.onmessage = async function (event) {
  var message = event.data;
  try {
    store = AppStore.create({ incognito: message.incognito });
    var result;
    if (message.operation === 'export') result = await exportApp(message.input.appId, message.input.includeData !== false, message.input.limit || 50 * 1024 * 1024);
    else if (message.operation === 'import') result = await AppPackage.importApp(store, message.input.item, message.input.scope, message.input.expected);
    else if (message.operation === 'validate') { AppPackage.validateItem(message.input.item, message.input.scope); result = true; }
    else if (message.operation === 'parse') {
      if (message.input.file.size > message.input.limit) throw new Error('备份超过现有大小上限，请按应用分包');
      result = JSON.parse(await message.input.file.text());
    } else if (message.operation === 'measure') result = new Blob([JSON.stringify(message.input.value)]).size;
    else if (message.operation === 'serialize') {
      result = new Blob([JSON.stringify(message.input.value, null, 2)], { type: 'application/json' });
      if (result.size > message.input.limit) throw new Error('备份超过现有大小上限，请缩小选择范围或按应用分包');
    } else if (message.operation === 'asset') result = await store.putAsset(message.input.appId, message.input.revision, message.input.name, message.input.file);
    else if (message.operation === 'prepare-code') {
      result = Object.assign(JSON.parse(message.input.declarations), message.input.fields);
      AppContract.validateCode(result, message.input.scope);
    } else throw new Error('未知备份操作');
    self.postMessage({ result: result });
  } catch (error) { self.postMessage({ error: { code: error.code || 'BACKUP_FAILED', message: error.message } }); }
};
