(function (root) {
  'use strict';
  function connectionUrl(connection) {
    const url = new URL(connection.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('服务端 WebSocket 地址无效');
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.port = '9998'; url.pathname = '/config'; url.search = ''; url.hash = '';
    return url.href;
  }
  function openPairing(options) {
    const dialog = document.createElement('dialog'); dialog.className = 'server-pair-dialog';
    const form = document.createElement('form'), title = document.createElement('h3'); title.textContent = '一键配对';
    const label = document.createElement('label'); label.textContent = '配对码'; label.htmlFor = 'server-pair-code';
    const code = document.createElement('textarea'); code.id = 'server-pair-code'; code.rows = 5; code.required = true;
    code.autocomplete = 'off'; code.spellcheck = false; code.placeholder = '粘贴服务端「连接配置 → 一键配对」生成的配对码';
    const preview = document.createElement('p'); preview.className = 'form-help';
    const error = document.createElement('p'); error.setAttribute('role', 'status'); error.className = 'account-error';
    const actions = document.createElement('div'); actions.className = 'editor-actions';
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn-primary'; save.textContent = '配对';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = '取消';
    actions.append(save, cancel); form.append(title, label, code, preview, error, actions); dialog.append(form); document.body.append(dialog);
    let busy = false;
    function parse() {
      let input;
      try {
        const value = code.value.trim();
        if (!value.startsWith('PA1.') || value.length > 16000) throw new Error('Invalid code');
        input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.slice(4)), character => character.charCodeAt(0))));
      } catch (_) { throw new Error('请粘贴完整配对码'); }
      if (input?.type !== 'page-agent-pairing' || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.token)
        || typeof input.url !== 'string' || input.url.length > 4000 || typeof input.expiresAt !== 'number' || input.expiresAt <= Date.now()) throw new Error('配对码无效或已过期，请重新生成');
      const url = new URL(input.url);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('配对地址无效');
      return { url: url.href, alias: typeof input.name === 'string' ? input.name.slice(0, 200) || url.host : url.host, password: input.token };
    }
    code.addEventListener('input', () => {
      try { const input = parse(); preview.textContent = input.alias + ' · ' + input.url; error.textContent = ''; }
      catch (failure) { preview.textContent = ''; error.textContent = code.value ? failure.message : ''; }
    });
    function close() { if (!busy) { code.value = ''; dialog.close(); dialog.remove(); } }
    cancel.onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    form.onsubmit = async event => {
      event.preventDefault(); if (busy) return;
      let input;
      try { input = parse(); } catch (failure) { error.textContent = failure.message; return; }
      busy = true; save.disabled = cancel.disabled = code.disabled = true; error.textContent = ''; save.textContent = '配对中…';
      try { await options.pair(input); busy = false; close(); }
      catch (failure) { code.value = ''; preview.textContent = ''; error.textContent = failure.message + '；配对码可能已使用，请在服务端重新生成。'; }
      finally { input.password = ''; busy = false; save.disabled = cancel.disabled = code.disabled = false; save.textContent = '配对'; }
    };
    dialog.showModal(); code.focus();
  }
  root.OptionsServerConfigController = Object.freeze({ connectionUrl: connectionUrl, openPairing: openPairing });
})(globalThis);
