(function (root) {
  'use strict';
  var C = root.AppContract, files = new Map(), modules = new Map(), owners = new WeakMap(), floatingOwners = new WeakMap(), disposed = false;
  // This host script runs with defer, before the remaining preloaded UI scripts.
  var hostScriptsReady = new Promise(function (resolve) {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
  var scriptGlobals = {
    'dependencies/marked/marked.min.js': 'marked',
    'dependencies/dompurify/purify.min.js': 'DOMPurify',
    'ui/code-editor.js': 'PageAgentCodeEditor',
    'ui/conversation-event-view.js': 'PageAgentConversationEventView',
    'ui/conversation-list-view.js': 'PageAgentConversationListView',
    'ui/feedback.js': 'PageAgentFeedback',
    'content/page-element-position-controller.js': 'PageAgentPageElementPositionController'
  };
  var lifetime = root.PageAgentLifecycle.create();
  var defaults = { bg: '#ffffff', 'bg-secondary': '#f9fafb', 'bg-muted': '#eaeef0', text: '#262626', 'text-secondary': '#728e9b', value: '#775351', border: '#d0dbe0', 'border-strong': '#aabbc3', 'border-link': '#ccdadb', 'table-header': '#728e9b', accent: '#004849', 'accent-soft': 'rgba(0,72,73,.08)', danger: '#ba554a', success: '#3da67a', transmitting: '#44a3cf', warn: '#cf9f5d', 'control-radius': '4px', 'control-border': '#ccdadb', 'control-bg': '#f9fafb', 'control-bg-hover': '#e3e8eb' };
  function invalid(message) { throw C.error('UI_INVALID_ARGUMENT', message); }
  function alive() { if (disposed) throw C.error('UI_UNAVAILABLE', '应用 UI 已卸载'); }
  function element(value) {
    alive();
    if (!value || value.nodeType !== 1 || value.ownerDocument !== document || !value.isConnected) invalid('UI 容器必须是当前文档中已挂载的元素');
    return value;
  }
  function text(value) { return String(value == null ? '' : value); }
  function managed(api, cleanup, container, ownerMap) {
    ownerMap = ownerMap || owners;
    var destroyed = false, result = {};
    Object.keys(api).forEach(function (key) {
      result[key] = function () {
        alive();
        if (destroyed) throw C.error('UI_INSTANCE_CLOSED', 'UI 实例已销毁');
        return api[key].apply(null, arguments);
      };
    });
    result.destroy = lifetime.add(function () {
      destroyed = true;
      if (container && ownerMap.get(container) === result.destroy) ownerMap.delete(container);
      cleanup();
    });
    if (container) ownerMap.set(container, result.destroy);
    return Object.freeze(result);
  }
  function surface(container, extraStyles) {
    element(container);
    if (owners.has(container)) owners.get(container)();
    var host = document.createElement('div'), shadow = host.attachShadow({ mode: 'open' }), style = document.createElement('style');
    style.textContent = ':host{display:block;min-width:0;color:var(--text);font:400 14px/1.6 var(--font-body,Roboto,system-ui,sans-serif)}*,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}' + (extraStyles || '');
    var content = document.createElement('div');
    shadow.append(style, content); container.replaceChildren(host);
    var computed = getComputedStyle(host);
    Object.keys(defaults).forEach(function (key) { if (!computed.getPropertyValue('--' + key).trim()) host.style.setProperty('--' + key, defaults[key]); });
    return { host: host, shadow: shadow, content: content, remove: function () { host.remove(); } };
  }
  function script(path) {
    if (files.has(path)) return files.get(path);
    // Re-executing preloaded UMD libraries would register them with Monaco's AMD loader.
    if (root[scriptGlobals[path]]) return Promise.resolve();
    var promise = new Promise(function (resolve, reject) {
      var node = document.createElement('script'); node.src = chrome.runtime.getURL(path);
      node.onload = function () { resolve(); };
      node.onerror = function () { node.remove(); reject(new Error('资源加载失败: ' + path)); };
      document.head.append(node);
    }).catch(function (error) { files.delete(path); throw error; });
    files.set(path, promise); return promise;
  }
  function markdownModule() {
    var view = root.PageAgentConversationEventView;
    if (!view || !root.marked || !root.DOMPurify) throw new Error('Markdown 依赖未完成初始化');
    return Object.freeze({ create: function (container, options) {
      var mount = surface(container, view.STYLE_TEXT);
      function setValue(value) {
        var next = document.createElement('div');
        next.innerHTML = view.renderMarkdown(text(value), { localImages: true });
        root.PageAgentCodeEditor.preserveViews(mount.content, next);
        mount.content.replaceChildren.apply(mount.content, Array.from(next.childNodes));
      }
      setValue(options && options.value);
      return managed({ setValue: setValue }, mount.remove, container);
    } });
  }
  function messageModule() {
    var view = root.PageAgentConversationEventView;
    if (!view || !root.marked || !root.DOMPurify || !root.PageAgentConversationListView) throw new Error('消息列表依赖未完成初始化');
    var titles = { user: '用户', assistant: '助手', system: '系统', tool: '工具', error: '错误' };
    function normalize(items) {
      if (!Array.isArray(items)) invalid('messages 必须为数组');
      var ids = new Set();
      return Array.from(items, function (item) {
        if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || ids.has(item.id)) invalid('消息 id 必须为非空、不含首尾空格且唯一的字符串');
        if (!Object.prototype.hasOwnProperty.call(titles, item.role)) invalid('未知消息 role');
        if (typeof item.text !== 'string') invalid('消息 text 必须为字符串');
        var status = item.status === undefined ? 'complete' : item.status;
        if (!['pending', 'streaming', 'complete', 'error'].includes(status)) invalid('未知消息 status');
        ids.add(item.id);
        return { id: item.id, role: item.role, text: item.text, status: status, details: item.details === undefined ? undefined : C.json(item.details) };
      });
    }
    return Object.freeze({ create: function (container, options) {
      options = options || {};
      var initial = normalize(options.messages === undefined ? [] : options.messages);
      var mount = surface(container, view.STYLE_TEXT + ':host{height:var(--message-list-height,360px)}.conversation-event-stream{height:100%;overflow:auto}');
      mount.content.className = 'conversation-event-stream';
      mount.content.setAttribute('role', 'log'); mount.content.setAttribute('aria-label', '消息');
      var list = root.PageAgentConversationListView.createVirtualList({
        container: mount.content, virtualize: options.virtualize !== false,
        renderItem: function (message, index) {
          var html = view.renderMarkdown(message.text, { localImages: true });
          if (message.details !== undefined) html += root.PageAgentCodeEditor.html(JSON.stringify(JSON.parse(message.details), null, 2), 'json', { 'aria-label': '消息详情' });
          return view.renderEvent({ eventId: message.id }, index, {
            kind: message.role, title: titles[message.role], status: { complete: 'completed', streaming: 'running' }[message.status] || message.status,
            detailHtml: html, codeValue: null, collapsible: message.details !== undefined, applicationLinks: false
          });
        }
      });
      var resize = new ResizeObserver(function () { list.render(); }); resize.observe(mount.content);
      function setMessages(items) {
        var next = normalize(items), node = mount.content;
        var pinned = node.scrollHeight - node.scrollTop - node.clientHeight <= 4;
        list.setItems(next, { stickToEnd: pinned });
      }
      list.setItems(initial, { stickToEnd: true });
      return managed({ setMessages: setMessages, scrollToEnd: list.scrollToEnd }, function () { resize.disconnect(); list.destroy(); mount.remove(); }, container);
    } });
  }
  async function iconModule() {
    var font = new FontFace('PageAgentAppIcons', 'url("' + chrome.runtime.getURL('assets/ui-fonts/font-awesome/fonts/fontawesome-webfont.woff2') + '")');
    await font.load(); alive(); document.fonts.add(font);
    return Object.freeze({ create: function (name, options) {
      alive();
      if (!Object.prototype.hasOwnProperty.call(C.ICONS, name)) invalid('未知图标: ' + name);
      var icon = document.createElement('span'); icon.textContent = C.ICONS[name];
      icon.style.cssText = 'display:inline-block;font-family:PageAgentAppIcons;font-style:normal;font-weight:normal;line-height:1';
      if (options && options.label) { icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', text(options.label)); }
      else icon.setAttribute('aria-hidden', 'true');
      return icon;
    } });
  }
  function feedbackModule() {
    var feedback = root.PageAgentFeedback.create();
    lifetime.add(feedback.destroy);
    return Object.freeze({ toast: function (message, options) { alive(); return feedback.toast(message, options); } });
  }
  function floatingModule() {
    function rememberStyle(node, properties) {
      var entries = properties.map(function (key) { return [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]; });
      return function () { entries.forEach(function (entry) { if (entry[1]) node.style.setProperty(entry[0], entry[1], entry[2]); else node.style.removeProperty(entry[0]); }); };
    }
    return Object.freeze({ create: function (panel, options) {
      element(panel); options = options || {};
      var handle = element(options.handle);
      if (!panel.contains(handle)) invalid('拖动手柄必须属于面板');
      if (options.onPositionChange !== undefined && typeof options.onPositionChange !== 'function') invalid('onPositionChange 必须为函数');
      var position = options.position || { leftRatio: 0.5, topRatio: 0.5 };
      if (['leftRatio', 'topRatio'].some(function (key) { return typeof position[key] !== 'number' || !Number.isFinite(position[key]) || position[key] < 0 || position[key] > 1; })) invalid('position 的比例必须在 0–1 之间');
      if (floatingOwners.has(panel)) floatingOwners.get(panel)();
      var restorePanel = rememberStyle(panel, ['position', 'left', 'right', 'top', 'bottom', 'transform']);
      var restoreHandle = rememberStyle(handle, ['touch-action', 'cursor']), tabIndex = handle.getAttribute('tabindex');
      panel.style.position = 'fixed'; handle.style.touchAction = 'none'; handle.style.cursor = 'move';
      if (handle.tabIndex < 0) handle.tabIndex = 0;
      var controller = root.PageAgentPageElementPositionController.createFree({
        window: root, document: document, host: panel, handle: handle, defaultPosition: position,
        interactiveSelector: 'button,select,textarea,input,a,[contenteditable]',
        onPositionChange: options.onPositionChange
      });
      function keydown(event) {
        var delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta || event.target !== handle || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); var step = event.shiftKey ? 40 : 10; controller.moveBy(delta[0] * step, delta[1] * step);
      }
      function click(event) { if (controller.consumeSuppressedClick()) { event.preventDefault(); event.stopPropagation(); } }
      handle.addEventListener('keydown', keydown); handle.addEventListener('click', click, true); controller.init();
      return managed({ refresh: controller.refresh }, function () {
        controller.destroy(); handle.removeEventListener('keydown', keydown); handle.removeEventListener('click', click, true);
        restorePanel(); restoreHandle();
        if (tabIndex === null) handle.removeAttribute('tabindex'); else handle.setAttribute('tabindex', tabIndex);
      }, panel, floatingOwners);
    } });
  }
  var factories = { 'code-editor': function () {
    if (!customElements.get('page-code-editor')) throw new Error('代码编辑器尚未注册');
    return Object.freeze({ tagName: 'page-code-editor' });
  }, markdown: markdownModule, 'message-list': messageModule, icons: iconModule, feedback: feedbackModule, floating: floatingModule };
  async function load(id) {
    alive();
    var paths = typeof id === 'string' && root.AppUiContract.scripts(id);
    if (!paths) throw C.error('UI_COMPONENT_NOT_FOUND', 'UI 组件不存在: ' + id);
    await hostScriptsReady;
    alive();
    if (!modules.has(id)) {
      var promise = (async function () {
        for (var path of paths) { alive(); await script(path); }
        alive(); return await factories[id]();
      })().catch(function (error) {
        modules.delete(id);
        if (error.code === 'UI_UNAVAILABLE') throw error;
        throw C.error('UI_COMPONENT_LOAD_FAILED', 'UI 组件 ' + id + ' 加载失败: ' + error.message);
      });
      modules.set(id, promise);
    }
    return modules.get(id);
  }
  root.addEventListener('pagehide', function () {
    disposed = true;
    lifetime.destroy();
  }, { once: true });
  root.PageAgentAppUi = Object.freeze({ apiVersion: 1, load: load });
})(globalThis);
