(async function () {
  'use strict';
  var C = AppContract, entry = C.parsePath(location.pathname);
  var bannerHost = document.createElement('div'), shadow = bannerHost.attachShadow({ mode: 'closed' });
  bannerHost.id = 'page-agent-app-banner';
  bannerHost.setAttribute('data-page-agent-ui', 'app-banner');
  bannerHost.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647';
  shadow.innerHTML = '<style>:host{font:14px system-ui}div{padding:8px;background:#fff5d6;color:#392b00;border-bottom:1px solid #d8c792;display:flex;gap:12px;align-items:center}[hidden]{display:none}button,a{font:inherit;color:inherit}span{flex:1}</style><div hidden><span></span><button type="button">加载新内容</button><a>权限</a></div>';
  var panel = shadow.querySelector('div'), text = shadow.querySelector('span'), reload = shadow.querySelector('button'), permission = shadow.querySelector('a');
  reload.onclick = function () { PageAgent.close(); location.reload(); };
  document.body.append(bannerHost);
  function show(message, allowReload) { panel.hidden = false; text.textContent = message; reload.hidden = !allowReload; }
  function error(error) { show((error.code ? error.code + ': ' : '') + error.message, true); }
  window.addEventListener('error', function (event) { if (event.error) error(event.error); });
  window.addEventListener('unhandledrejection', function (event) { error(event.reason instanceof Error ? event.reason : new Error(String(event.reason))); });
  if (!entry || location.search) { show('无效的应用地址', false); return; }
  permission.hidden = true;
  permission.target = '_blank';
  PageAgent.onChange(function (event) {
    if (event.change === 'deleted') { show('应用已删除', false); document.getElementById('app-root').inert = true; }
    else if (event.change === 'imported') show('应用内容已导入，请加载新内容', true);
    else if (event.change === 'disconnected') show('应用连接已断开，输入仍保留。下一次操作会重新连接；预览临时数据已释放。', true);
    else if (event.change === 'error') error(event.error);
    else if (event.change === 'state') {
      document.title = event.state.name;
      var slot = event.state.slots[entry.slot];
      if (!slot || slot.revision !== loadedRevision) show(entry.slot === 'draft' ? '草稿已更新' : '应用已更新', true);
    } else if (event.slot === entry.slot && (event.change === 'saved' || event.change === 'published' || event.change === 'imported')) show(entry.slot === 'draft' ? '草稿已更新' : '应用已更新', true);
  });
  var loadedRevision;
  try {
    var init = await PageAgent.ready;
    entry.appId = init.state.appId;
    permission.href = init.state.links.permissions; permission.hidden = false;
    loadedRevision = init.revision;
    var store = AppStore.create({ incognito: chrome.extension.inIncognitoContext });
    var record = await store.get('app_code', [entry.appId, entry.slot]);
    if (!record || record.revision !== loadedRevision) throw C.error('CONTENT_CHANGED', '应用已更新，请加载新内容');
    var input = location.hash.startsWith('#page-agent-input=') ? PageAgent.apps.input : undefined;
    C.validateLaunchInput(record.code, input);
    document.title = init.state.name;
    if (entry.slot === 'draft') show('草稿预览 · 使用临时数据', false);
    var names = C.assetReferences(Object.assign({}, record.code, { javascript: '' })), assets = new Map(), assetErrors = [];
    for (var name of names) {
      try { assets.set(name, await PageAgent.asset(name)); }
      catch (failure) {
        if (failure.code !== 'RESOURCE_NOT_FOUND') throw failure;
        assetErrors.push(failure.message);
        assets.set(name, 'about:invalid#missing-app-asset');
      }
    }
    function resolveAssets(source) {
      source = C.resolveSourceFiles(source, C.sourceBase(entry.appId, entry.slot, loadedRevision), record.code.files);
      return source.replace(/app-asset:([A-Za-z0-9_./-]+)/g, function (_match, name) { return assets.get(name); });
    }
    var documentSource = new DOMParser().parseFromString(resolveAssets(record.code.html), 'text/html');
    // The JS field is the executable entry. HTML is loaded only after a complete commit.
    documentSource.querySelectorAll('script').forEach(function (script) { script.remove(); });
    var target = document.getElementById('app-root');
    target.replaceChildren.apply(target, Array.from(documentSource.body.childNodes).map(function (node) { return document.importNode(node, true); }));
    [record.code.themeCss, record.code.css].forEach(function (source) {
      var style = document.createElement('style'); style.textContent = resolveAssets(source); document.head.append(style);
    });
    if (assetErrors.length) show((entry.slot === 'draft' ? '草稿预览 · ' : '') + assetErrors.join('；'), true);
    if (record.code.javascript.trim()) {
      await import(C.sourceBase(entry.appId, entry.slot, loadedRevision) + '__entry__.js');
    }
    var parameters = record.code.parameters ?? C.noParameters();
    if (input !== undefined && parameters.mode !== 'none') {
      if (parameters.mode === 'form') {
        // Resolve every target before changing any field. Filling never submits a form.
        var assignments = Object.keys(input).map(function (name) {
          var control = document.getElementById(parameters.bindings[name]), value = input[name];
          if (!control || !target.contains(control) || !['INPUT', 'TEXTAREA', 'SELECT', 'PAGE-CODE-EDITOR'].includes(control.tagName)
              || control.matches(':disabled') || control.disabled || control.readOnly || control.tagName === 'INPUT' && ['file', 'password', 'hidden', 'button', 'submit', 'reset', 'image', 'radio'].includes(control.type)) throw C.error('INVALID_REQUEST', '参数未绑定到可填写控件：' + name);
          if (typeof value === 'boolean' ? control.type !== 'checkbox' : control.type === 'checkbox') throw C.error('INVALID_REQUEST', '参数与控件类型不匹配：' + name);
          if (control.tagName === 'SELECT' && !Array.from(control.options).some(function (option) { return option.value === String(value) && !option.disabled; })) throw C.error('INVALID_REQUEST', '参数不在可选项中：' + name);
          return { control: control, name: name, value: value, previous: typeof value === 'boolean' ? control.checked : control.value };
        });
        try {
          assignments.forEach(function (item) {
            if (typeof item.value === 'boolean') item.control.checked = item.value;
            else {
              item.control.value = String(item.value);
              if (item.control.value !== String(item.value)) throw C.error('INVALID_REQUEST', '控件无法接收参数值：' + item.name);
            }
          });
        } catch (failure) {
          assignments.forEach(function (item) {
            if (typeof item.value === 'boolean') item.control.checked = item.previous;
            else item.control.value = item.previous;
          });
          throw failure;
        }
      } else {
        var adapter = await import(C.sourceBase(entry.appId, entry.slot, loadedRevision) + parameters.module);
        if (typeof adapter.applyParameters !== 'function') throw C.error('UNSUPPORTED_CAPABILITY', '参数适配模块未导出 applyParameters(input)');
        await adapter.applyParameters(input);
      }
      show((entry.slot === 'draft' ? '草稿预览 · ' : '') + '已应用启动参数' + (assetErrors.length ? ' · ' + assetErrors.join('；') : ''), !!assetErrors.length);
    }
    await store.touch(entry.appId);
  } catch (failure) {
    if (failure.code === 'NOT_PUBLISHED') {
      show('应用尚未发布', false);
      var preview = document.createElement('a'); preview.href = C.path(entry.appId, 'draft', entry.slug); preview.textContent = '打开草稿预览'; shadow.querySelector('div').append(preview);
    } else error(failure);
  }
})();
