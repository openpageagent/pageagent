// Page-local feedback shared by the configuration center and applications.
(function (root) {
  'use strict';
  function create(options) {
    options = options || {};
    var durationDefault = options.duration === undefined ? 3000 : options.duration;
    var lifetime = root.PageAutomationLifecycle.create(), host, content, previous, count = 0;
    function toast(message, input) {
      if (lifetime.isDestroyed()) throw new Error('提示组件已销毁');
      input = input || {};
      var kind = input.kind === undefined ? 'info' : input.kind;
      var duration = input.duration === undefined ? durationDefault : input.duration;
      if (!['info', 'success', 'error'].includes(kind)) throw new TypeError('未知提示 kind');
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration !== 0 && (duration < 1000 || duration > 60000)) throw new TypeError('duration 必须为 0 或 1000–60000 毫秒');
      if (options.replace && previous) previous();
      if (!host) {
        host = document.createElement('div');
        var shadow = host.attachShadow({ mode: 'open' }), style = document.createElement('style');
        style.textContent = [
          ':host{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483646;display:block;width:max-content;max-width:min(480px,calc(100vw - 32px));pointer-events:none;font:400 13px/1.5 var(--font-body,Roboto,system-ui,sans-serif)}',
          '*{box-sizing:border-box}.stack{display:flex;flex-direction:column;align-items:center;gap:8px}',
          '.toast{display:flex;align-items:center;gap:8px;max-width:100%;padding:8px 12px;border:1px solid var(--border,#d0dbe0);border-radius:var(--control-radius,4px);background:var(--bg,#fff);color:var(--text,#262626);box-shadow:0 2px 8px #00000014;pointer-events:auto}',
          '.toast::before{content:"";flex:0 0 6px;height:6px;border-radius:50%;background:var(--accent,#004849)}',
          '.toast span{min-width:0;overflow-wrap:anywhere}.success::before{background:var(--success,#3da67a)}.error::before{background:var(--danger,#ba554a)}',
          'button{display:inline-flex;align-items:center;justify-content:center;flex:0 0 24px;width:24px;height:24px;padding:0;border:0;border-radius:var(--control-radius,4px);background:transparent;color:var(--text-secondary,#728e9b);font:inherit;line-height:1;cursor:pointer}',
          'button:hover{background:var(--bg-muted,#eaeef0);color:var(--text,#262626)}button:focus-visible{outline:2px solid var(--accent,#004849);outline-offset:2px}'
        ].join('');
        content = document.createElement('div'); content.className = 'stack'; shadow.append(style, content); document.body.append(host);
      }
      var item = document.createElement('div'), label = document.createElement('span'), button, timer;
      item.className = 'toast ' + kind; item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      item.append(label);
      if (duration === 0) {
        button = document.createElement('button'); button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', '关闭提示'); item.append(button);
      }
      content.append(item); label.textContent = String(message == null ? '' : message); count++;
      var dismiss = lifetime.add(function () {
        clearTimeout(timer); if (button) button.onclick = null; item.remove(); count--;
        if (!count) { host.remove(); host = content = null; }
        if (previous === dismiss) previous = null;
      });
      if (button) button.onclick = dismiss;
      if (duration) timer = setTimeout(dismiss, duration);
      previous = dismiss;
      return dismiss;
    }
    return Object.freeze({ toast: toast, destroy: lifetime.destroy });
  }
  root.PageAgentFeedback = Object.freeze({ create: create });
})(globalThis);
