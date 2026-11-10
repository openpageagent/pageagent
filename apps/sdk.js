(function (root) {
  'use strict';
  var C = root.AppContract, port, session, revision, state, closed = false, disposed = false, reconnecting;
  var pending = new Map(), listeners = new Set(), workers = new Set(), urls = new Set();
  var dataWorker, assetStore, launchInput = null, dataPending = new Map();
  async function readAsset(name) {
    await root.PageAgent.ready;
    if (closed) throw C.error('SESSION_CLOSED', '应用会话已断开，请先恢复连接');
    if (!name || name.includes('..') || name.startsWith('/')) throw C.error('INVALID_ADDRESS', '无效资源名称');
    var assetSession = session, entry = C.parsePath(location.pathname), assetRevision = revision;
    if (!assetStore) assetStore = root.AppStore.create({ incognito: chrome.extension.inIncognitoContext });
    var asset = await assetStore.tx(['app_meta', 'app_assets'], 'readonly', function (t) {
      t.get('app_meta', state.appId, function (meta) {
        if (!meta || !meta.slots[entry.slot] || meta.slots[entry.slot].revision !== assetRevision) throw C.error('CONTENT_CHANGED', '应用资源已更新，请加载新内容');
        t.get('app_assets', [state.appId, 'theme/' + entry.slot + '/' + name], t.result);
      });
    });
    if (closed || assetSession !== session) throw C.error('SESSION_CLOSED', '读取应用资源期间会话已关闭');
    if (!asset) throw C.error('RESOURCE_NOT_FOUND', '应用资源不存在: ' + name);
    return asset;
  }
  function failAll(error) { pending.forEach(function (item) { clearTimeout(item.timer); item.reject(error); }); pending.clear(); }
  function call(type, operation, input) {
    if (type === 'APP_REQUEST' && reconnecting) return reconnecting.then(function () { return call(type, operation, input); });
    if (closed && !disposed && type === 'APP_REQUEST') return reconnect().then(function () { return call(type, operation, input); });
    if (closed || !port) return Promise.reject(C.error('SESSION_CLOSED', '应用会话已断开，请重新加载此应用'));
    if (pending.size >= C.limits.inFlight) return Promise.reject(C.error('RESOURCE_BUSY', '应用请求过多，请等待当前操作完成'));
    var id = C.revision();
    var message;
    try {
      // Chrome ports use JSON serialization. Validate before dispatch so that
      // unsupported values never silently change an action's input.
      message = { type: type, id: id, version: C.VERSION, session: session || null, revision: revision || null, generation: state ? state.permissions.generation : null, operation: operation, input: input };
      if (input && Object.prototype.hasOwnProperty.call(input, 'idempotencyKey') && input.idempotencyKey === undefined) {
        message.input = Object.assign({}, input); delete message.input.idempotencyKey;
      }
      if (C.json(message).length * 2 > C.limits.messageBytes) throw C.error('RESOURCE_BUSY', '应用 SDK 消息过大，请分批处理');
    } catch (error) { return Promise.reject(error); }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { pending.delete(id); reject(C.error('REQUEST_TIMEOUT', '请求超时，写入或动作可能已执行，请查询状态，不要盲目重试')); }, C.limits.timeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try { port.postMessage(message); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function emit(event) { listeners.forEach(function (listener) { try { listener(event); } catch (error) { console.error(error); } }); }
  function updateAddress() {
    var entry = C.parsePath(location.pathname);
    if (!entry) return;
    var url = new URL(entry.slot === 'draft' ? state.links.preview : state.links.open);
    url.hash = location.hash;
    if (url.href !== location.href) history.replaceState(history.state, '', url.href);
  }
  async function refresh() {
    await root.PageAgent.ready;
    var latest = await call('APP_REQUEST', 'state', {});
    var previousDataRevision = state && state.dataRevision;
    if (!state || latest.permissions.generation >= state.permissions.generation) state = latest;
    updateAddress();
    emit({ change: 'state', state: state });
    if (C.parsePath(location.pathname).slot === 'published' && state.dataRevision !== previousDataRevision) emit({ change: 'data' });
    return state;
  }
  function connect() {
    var connection = chrome.runtime.connect({ name: C.PORT });
    port = connection; session = null; closed = false;
    connection.onMessage.addListener(function (message) {
      if (port !== connection) return;
      if (message.type === 'APP_EVENT' && message.session === session) {
        emit(message.event);
        if (message.event.change === 'deleted' || message.event.change === 'imported') { close(); return; }
        if (['permissions', 'saved', 'published', 'metadata'].includes(message.event.change)) refresh().catch(function (error) { emit({ change: 'error', error: error }); });
        return;
      }
      var item = pending.get(message.id);
      if (!item || message.type !== 'APP_RESULT' || session && message.session !== session) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(C.error(message.error.code, message.error.message));
      else item.resolve(message.result);
    });
    connection.onDisconnect.addListener(function () {
      if (disposed || port !== connection) return;
      closed = true; port = null; releaseRequests(); emit({ change: 'disconnected' });
    });
    return call('APP_READY', null, {}).then(function (init) {
      if (disposed || closed || port !== connection) throw C.error('SESSION_CLOSED', '应用实例已关闭');
      if (state && state.appId !== init.state.appId) throw C.error('CONTENT_CHANGED', '应用别名已指向其他应用，请重新加载页面');
      if (!state) launchInput = C.launchInput(location.hash);
      session = init.session; revision = init.revision; state = init.state; updateAddress(); return init;
    }).catch(function (error) {
      if (port === connection) { closed = true; port = null; connection.disconnect(); releaseRequests(); }
      throw error;
    });
  }
  function reconnect() {
    if (disposed) return Promise.reject(C.error('SESSION_CLOSED', '应用实例已关闭'));
    if (!reconnecting) {
      var previousDataRevision = state && state.dataRevision;
      reconnecting = connect().then(function (init) {
        emit({ change: 'state', state: init.state });
        if (C.parsePath(location.pathname).slot === 'published' && init.state.dataRevision !== previousDataRevision) emit({ change: 'data' });
        return init;
      }).finally(function () { reconnecting = null; });
      initialReady = reconnecting;
    }
    return reconnecting;
  }
  function releaseRequests() {
    failAll(C.error('SESSION_CLOSED', '应用连接已断开，未完成的操作可能已经执行；请先查询状态'));
  }
  function close() {
    if (disposed) return;
    disposed = true; closed = true; releaseRequests();
    // Page resources survive bridge disconnects and are released with the instance.
    workers.forEach(function (worker) { worker.terminate(); }); workers.clear(); dataWorker = null;
    urls.forEach(function (url) { URL.revokeObjectURL(url); }); urls.clear();
    dataPending.forEach(function (item) { clearTimeout(item.timer); item.reject(C.error('SESSION_CLOSED', '应用数据会话已关闭')); }); dataPending.clear();
    listeners.clear(); if (port) port.disconnect();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', close);
  }
  function visible() { if (!document.hidden && !disposed && revision) refresh().catch(function (error) { emit({ change: 'error', error: error }); }); }
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', close);
  async function data(operation, input) {
    // Validate in the caller's realm, before structured cloning can turn a
    // class instance into a plain object or evaluate its getters.
    if (operation === 'set') input.value = JSON.parse(C.json(input.value));
    await root.PageAgent.ready;
    var ticket = await call('APP_REQUEST', 'data.' + operation, {});
    if (closed) throw C.error('SESSION_CLOSED', '应用会话已关闭');
    if (!dataWorker) {
      dataWorker = new Worker(chrome.runtime.getURL('apps/data-worker.js')); workers.add(dataWorker);
      dataWorker.onmessage = function (event) {
        var item = dataPending.get(event.data.id); if (!item) return;
        dataPending.delete(event.data.id); clearTimeout(item.timer);
        if (event.data.error) item.reject(C.error(event.data.error.code, event.data.error.message));
        else {
          item.resolve(event.data.result);
          if (item.operation === 'set' || item.operation === 'delete') {
            if (C.parsePath(location.pathname).slot === 'draft') emit({ change: 'data', key: item.key });
            else call('APP_REQUEST', 'data.changed', { key: item.key, operation: item.operation }).catch(function (error) { emit({ change: 'error', error: error }); });
          }
        }
      };
      dataWorker.onerror = function (event) {
        dataPending.forEach(function (item) { clearTimeout(item.timer); item.reject(C.error('DATA_ERROR', event.message)); }); dataPending.clear();
        dataWorker.terminate(); workers.delete(dataWorker); dataWorker = null;
      };
    }
    if (dataPending.size >= C.limits.inFlight) throw C.error('RESOURCE_BUSY', '应用数据请求过多，请等待当前操作完成');
    var id = C.revision();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { dataPending.delete(id); reject(C.error('REQUEST_TIMEOUT', '数据请求超时，请读取状态确认是否已经提交')); }, C.limits.timeoutMs);
      dataPending.set(id, { resolve: resolve, reject: reject, timer: timer, operation: operation, key: input.key });
      try { dataWorker.postMessage({ id: id, authorization: ticket.authorization, operation: operation, input: input, incognito: chrome.extension.inIncognitoContext }); }
      catch (error) { clearTimeout(timer); dataPending.delete(id); reject(error); }
    });
  }
  async function appRequest(method, appId, suffix, body, options) {
    var request = { uri: '/apps/' + C.id(appId) + suffix };
    if (body !== undefined) request.body = body;
    if (method === 'POST') request.idempotencyKey = options && options.idempotencyKey !== undefined ? options.idempotencyKey : C.revision();
    var response = await root.PageAgent.resources.request(method, request);
    if (response.error) {
      var error = C.error(response.error.code, response.error.message);
      error.receipt = response.receipt;
      throw error;
    }
    return response.primary.data;
  }
  function segment(value) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..') throw C.error('INVALID_REQUEST', '无效的动作名称或运行 ID');
    return encodeURIComponent(value);
  }
  var initialReady = connect();
  root.PageAgent = Object.freeze({
    get ready() {
      if (disposed) return Promise.reject(C.error('SESSION_CLOSED', '应用实例已关闭'));
      return reconnecting || (closed ? reconnect() : initialReady);
    },
    refresh: refresh, close: close,
    ui: root.PageAgentAppUi,
    get state() { return state; },
    onChange: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    resources: Object.freeze({
      request: function (method, request) {
        return root.PageAgent.ready.then(function () { return call('APP_REQUEST', 'resources.request', { method: method, request: request }); });
      }
    }),
    apps: Object.freeze({
      get input() { return launchInput; },
      describe: async function (appId) { return (await appRequest('GET', appId, '/published/actions')).value; },
      open: function (appId, input, options) { return appRequest('POST', appId, '/open', input === undefined ? {} : { input: input }, options); },
      run: function (appId, name, input, options) { return appRequest('POST', appId, '/actions/' + segment(name) + '/runs', { input: input === undefined ? {} : input }, options); },
      status: function (appId, runId) { return appRequest('GET', appId, '/runs/' + segment(runId)); },
      cancel: function (appId, runId, options) { return appRequest('POST', appId, '/runs/' + segment(runId) + '/stop', {}, options); }
    }),
    data: Object.freeze({
      get: function (key) { return data('get', { key: key }); },
      list: function (query) { return data('list', query || {}); },
      set: function (key, value, version) { return data('set', { key: key, value: value, version: version === undefined ? null : version }); },
      delete: function (key, version) { return data('delete', { key: key, version: version }); }
    }),
    actions: Object.freeze({
      run: function (name, input, options) { return root.PageAgent.ready.then(function () { return call('APP_REQUEST', 'actions.run', { name: name, input: input === undefined ? {} : input, idempotencyKey: options && options.idempotencyKey }); }); },
      status: function (runId) { return root.PageAgent.ready.then(function () { return call('APP_REQUEST', 'runs.status', { runId: runId }); }); },
      cancel: function (runId) { return root.PageAgent.ready.then(function () { return call('APP_REQUEST', 'runs.cancel', { runId: runId }); }); }
    }),
    asset: async function (name) {
      var asset = await readAsset(name);
      var url = URL.createObjectURL(asset.blob); urls.add(url); return url;
    },
    createWorker: function () {
      if (!revision || closed) throw C.error('SESSION_CLOSED', '请等待 PageAgent.ready 完成后创建 Worker');
      var entry = C.parsePath(location.pathname);
      var worker = new Worker(C.sourceBase(state.appId, entry.slot, revision) + '__entry__.js', { type: 'module' });
      workers.add(worker); return worker;
    },
    manageWorker: function (worker) { if (closed) { worker.terminate(); throw C.error('SESSION_CLOSED', '应用会话已关闭'); } workers.add(worker); return worker; }
  });
})(globalThis);
