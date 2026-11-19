(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const credentialKey = 'page-agent.config.credential';
  const intentBits = { USER_MESSAGE: 1 << 25, PUBLIC_GUILD_MESSAGES: 1 << 30, DIRECT_MESSAGES: 1 << 12, GUILD_MESSAGES: 1 << 9 };
  const labels = { online: '在线', ready: '就绪', offline: '离线', enabled: '已启用', disabled: '已停用', failed: '失败',
    connecting: '连接中', authenticating: '认证中', authenticated: '已认证', configuring: '同步中', initializing: '初始化', closing: '关闭中' };
  const eventLabels = { 'auth.succeeded': '认证成功', 'auth.denied': '认证失败', 'connection.closed': '连接断开',
    'pairing.created': '完成配对', 'pairing.revoked': '撤销配对', 'execution.intent': '操作准备',
    'execution.started': '开始执行', 'execution.finished': '执行结束', 'execution.unconfirmed': '结果未确认',
    'authorization.denied': '拒绝授权', 'request.received': '收到请求', 'grants.changed': '权限变更',
    'password.changed': '密码变更', 'audit.recovered': '审计恢复', 'cancel.requested': '请求取消', 'process.spawned': '进程启动' };
  let credential = '', sessionId = '', protocol = '', sequence = 0, initializing = null;
  let authenticated = false, busy = false, dirty = false, selected = null, catalog = [], clients = [], auditItems = [];
  let baseConfig = {}, fields = [], snapshot = null, panel = 'accounts-panel', returnFocus = null;
  let accountSection = null, confirmation = null, toastTimer = null, messageDirty = false, editorReturnFocus = null;
  const endpoint = location.origin + '/mcp';
  $('endpoint').textContent = endpoint;
  $('client-config').textContent = JSON.stringify({ mcpServers: { 'page-agent': {
    type: 'streamableHttp', url: endpoint, headers: { Authorization: 'Bearer <HTTP令牌>' },
  } } }, null, 2);
  const devtoolsPanel = window.DevToolsPanel.create({ $, el, button, itemCard, switchLabel, passwordInput, admin, request, run, toast, confirmAction });

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action, className = 'btn-secondary') {
    const node = el('button', text, className); node.type = 'button';
    node.addEventListener('click', () => run(action)); return node;
  }
  function switchLabel(input, text) {
    const label = el('label', undefined, 'switch-label'), slider = el('span', undefined, 'switch-slider');
    input.setAttribute('role', 'switch'); slider.setAttribute('aria-hidden', 'true');
    label.append(input, slider, el('span', text, 'switch-text'));
    return label;
  }
  function passwordInput(input, label) {
    const wrapper = el('div', undefined, 'password-input'), toggle = el('button', undefined, 'btn-icon password-toggle');
    toggle.type = 'button'; toggle.setAttribute('aria-controls', input.id);
    const update = () => {
      const visible = input.type === 'text', action = (visible ? '隐藏' : '显示') + label;
      toggle.setAttribute('aria-pressed', String(visible)); toggle.setAttribute('aria-label', action); toggle.title = action;
    };
    toggle.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; update(); };
    update(); wrapper.append(input, toggle); return wrapper;
  }
  function toast(message, error = false) {
    const node = $('toast'); clearTimeout(toastTimer);
    $('toast-message').textContent = message;
    node.dataset.kind = error ? 'error' : 'info'; node.setAttribute('role', error ? 'alert' : 'status');
    if (node.matches(':popover-open')) node.hidePopover();
    node.showPopover();
    toastTimer = setTimeout(() => node.hidePopover(), 2600);
  }
  function lock() {
    $('login-screen').hidden = authenticated; $('app').hidden = !authenticated;
    document.querySelectorAll('button').forEach(node => {
      if (!node.closest('.conversation-confirm-dialog')) node.disabled = busy || node.dataset.unavailable === 'true';
    });
    $('accounts').querySelectorAll('.item-card').forEach(card => {
      const expanded = !$('editor').hidden && selected?.id === card.dataset.accountId;
      card.classList.toggle('selected', expanded);
      card.setAttribute('aria-expanded', String(expanded)); card.setAttribute('aria-disabled', String(busy));
    });
    $('token').disabled = busy; $('editor-fields').disabled = busy; $('account-drawer-fields').disabled = busy;
    devtoolsPanel.lock(busy);
    document.querySelectorAll('.reply-form textarea').forEach(node => { node.disabled = busy; });
    $('adapter').disabled = busy || !!selected; $('add').disabled = busy || !catalog.length;
    $('name').disabled = busy || !$('adapter').value;
    document.body.setAttribute('aria-busy', String(busy));
  }
  async function run(work) {
    if (busy) return;
    const focused = document.activeElement, accountFocus = accountSection?.returnFocus;
    busy = true; lock();
    try { await work(); }
    catch (error) { toast(error.message || '请求失败', true); }
    finally {
      busy = false; lock();
      if (!authenticated) $('token').focus();
      else {
        const active = $('account-drawer').open ? $('account-drawer') : $('drawer').open ? $('drawer') : null;
        if (active && (document.activeElement === active || document.activeElement === document.body)) {
          if (focused?.isConnected && active.contains(focused) && !focused.disabled) focused.focus();
          else if (accountFocus?.isConnected && active.contains(accountFocus) && !accountFocus.disabled) accountFocus.focus();
          else if (active === $('account-drawer')) $('close-account-drawer').focus();
          else $('close-drawer').focus();
        } else if (!active && document.activeElement === document.body) {
          if (!$('editor').hidden && panel === 'accounts-panel') (selected ? $('name') : $('adapter')).focus();
          else if (returnFocus?.isConnected) returnFocus.focus();
        }
      }
    }
  }
  function rememberCredential() {
    try {
      if (credential) sessionStorage.setItem(credentialKey, credential);
      else sessionStorage.removeItem(credentialKey);
    } catch (_) { /* Login still works when the browser disables storage. */ }
  }
  function resetSession() {
    authenticated = false; credential = sessionId = protocol = ''; selected = null; dirty = false;
    rememberCredential();
    closeEditor(); closeDrawer(); catalog = []; clients = []; snapshot = null; auditItems = [];
    $('server-name').textContent = 'MCP Server';
    devtoolsPanel.reset();
    for (const scope of ['accounts', 'devtools']) {
      $(scope + '-transfer-result').hidden = true; $(scope + '-transfer-result').textContent = '';
      $('file-import-' + scope).value = '';
    }
    for (const id of ['accounts', 'clients', 'sessions', 'audit-list', 'connection-logs', 'tools', 'capabilities', 'runtime-summary', 'queues']) $(id).replaceChildren();
    $('audit-filters').reset(); updateAuditChoices(); $('audit-result-count').textContent = '';
    $('token').value = ''; lock(); $('token').focus();
  }
  function headers() {
    return { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': protocol } : {}) };
  }
  async function transport(path, method, body) {
    let response;
    try {
      response = await fetch(path, { method, headers: headers(), credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(185000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (_) { throw new Error(method === 'GET' ? '读取失败，请检查网络后刷新。' : '请求结果未确认，请先刷新状态，勿直接重复提交。'); }
    if (response.status === 401 || path === '/mcp' && response.status === 404) {
      resetSession(); throw new Error('令牌或会话已失效，请重新登录。');
    }
    if (response.status === 202 || response.status === 204) return {};
    const value = await response.json();
    if (!response.ok || value.error) throw new Error(value.error?.message || '请求失败：HTTP ' + response.status);
    return { value, response };
  }
  async function rpc(method, params = {}, notification = false) {
    if (method !== 'initialize' && method !== 'notifications/initialized') {
      if (initializing) await initializing;
      else if (!sessionId) await initialize();
    }
    const { value, response } = await transport('/mcp', 'POST', { jsonrpc: '2.0', ...(notification ? {} : { id: ++sequence }), method, params });
    if (notification) return;
    if (method === 'initialize') {
      sessionId = response.headers.get('Mcp-Session-Id') || ''; protocol = value.result?.protocolVersion || '';
      if (!sessionId || !protocol) throw new Error('服务端没有返回有效会话');
      const info = value.result.serverInfo;
      $('server-name').textContent = (info.title || info.name) + ' · ' + info.version;
      $('usage-prompt').textContent = value.result.instructions || '';
    }
    return value.result;
  }
  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      sessionId = protocol = '';
      await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'page-agent-server-config', version: '1.0.0' }, capabilities: {} });
      await rpc('notifications/initialized', {}, true); authenticated = true; rememberCredential();
    })();
    try { await initializing; }
    catch (error) { sessionId = protocol = ''; throw error; }
    finally { initializing = null; }
  }
  async function request(method, uri, body) {
    const result = await rpc('tools/call', { name: method, arguments: { uri,
      ...(method === 'GET' ? {} : { body, idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('') }) } });
    const envelope = result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
    if (envelope.error) throw Object.assign(new Error(envelope.error.message), { performed: envelope.receipt?.performed });
    if (result.isError || !envelope.primary) throw new Error('服务端未返回有效结果');
    return envelope.primary.data;
  }
  async function admin(path, body) { return (await transport('/api/config/' + path, body === undefined ? 'GET' : 'POST', body)).value; }
  function bindConfigTransfer(scope, options) {
    const label = scope === 'accounts' ? '账号' : '研发工具连接', status = $(scope + '-transfer-result');
    const report = (message, error = false) => {
      status.hidden = false; status.textContent = message; status.classList.toggle('account-error', error);
    };
    $('export-' + scope).onclick = () => run(async () => {
      try {
        const backup = await admin(scope + '/export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2) + '\n'], { type: 'application/json' }));
        const link = el('a'); link.href = url;
        link.download = 'page-agent-mcp-' + scope + '-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        report('已导出 ' + backup.items.length + ' 个' + label + '的已保存配置（含凭据）。');
      } catch (error) { if (authenticated) report('导出失败：' + error.message, true); }
    });
    const fileInput = $('file-import-' + scope);
    $('import-' + scope).onclick = () => { if (!busy) fileInput.click(); };
    fileInput.onchange = () => {
      const file = fileInput.files[0]; fileInput.value = '';
      if (!file) return;
      run(async () => {
        let result;
        try {
          if (file.size > 16777216) throw new Error('备份文件不能超过 16 MiB');
          let backup;
          try { backup = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
          catch (_) { throw new Error('请选择有效的 JSON 备份文件'); }
          if (backup?.type !== 'page-agent-mcp-' + scope || backup.version !== 1 || !Array.isArray(backup.items)
            || backup.items.some(item => !item || typeof item.id !== 'string')) throw new Error('备份类型或版本不匹配，请选择' + label + '导出的文件');
          if (!backup.items.length) { report('备份中没有' + label + '，未修改配置。'); return; }
          const current = await options.read(), ids = new Set(current.items.map(item => item.id));
          const updated = backup.items.filter(item => ids.has(item.id)).length;
          if (!await confirmAction('将新增 ' + (backup.items.length - updated) + ' 个、更新 ' + updated + ' 个' + label
            + '，保留其他配置。启用状态与权限随配置恢复，失效的客户端授权将移除。'
            + (options.dirty() ? '当前未保存的编辑将被放弃。' : ''), '导入' + label, '导入', '取消')) return;
          report('正在导入…');
          result = await admin(scope + '/import', { backup, ...(scope === 'accounts'
            ? { revisions: current.items.map(({ id, revision }) => ({ id, revision })) } : { revision: current.revision }) });
          options.close();
          await options.refresh();
          report('已导入 ' + result.imported + ' 个' + label + '。'
            + (result.removedAuthorizations ? '已移除 ' + result.removedAuthorizations + ' 项失效的客户端授权。' : '')
            + (result.restartFailures ? result.restartFailures + ' 个账号重启失败，请查看账号状态。' : '')
            + (result.auditRecorded === false ? '审计记录未写入。' : ''), !!result.restartFailures);
        } catch (error) {
          if (authenticated) report((result ? '已导入 ' + result.imported + ' 个' + label + '，列表刷新失败：' : '导入未完成：') + error.message, true);
        }
      });
    };
  }
  async function together(tasks) {
    const results = await Promise.allSettled(tasks), failed = results.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(item => item.value);
  }
  function date(value) { return value ? new Date(value).toLocaleString() : '—'; }
  function formatLogTime(value) {
    const time = new Date(value), pad = (number, length = 2) => String(number).padStart(length, '0');
    if (!Number.isFinite(time.getTime())) return '—';
    return pad(time.getFullYear(), 4) + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) + ' '
      + pad(time.getHours()) + ':' + pad(time.getMinutes()) + ':' + pad(time.getSeconds()) + '.' + pad(time.getMilliseconds(), 3);
  }
  function badge(state) {
    return el('span', labels[state] || state, 'badge ' + (['online', 'ready', 'enabled'].includes(state) ? 'status-success' : state === 'failed' ? 'status-failed' : ''));
  }
  function empty(container, text) { container.append(el('p', text, 'placeholder')); }
  function itemCard(name, tag, state, id, description, actions) {
    const card = el('div', undefined, 'item-card'), title = el('span', name, 'item-title'); title.title = name;
    const identity = button('ID: ' + id, () => copy(id), 'item-id');
    identity.title = '点击复制 ID: ' + id; identity.setAttribute('aria-label', '复制 ID: ' + id);
    const summary = el('span', description, 'item-sub'); summary.title = description;
    const end = el('span', undefined, 'item-card-end'); end.append(identity, ...actions, badge(state));
    card.append(title, el('span', tag, 'badge'), summary, end);
    return card;
  }
  function drawerButton(text, action) {
    const node = button(text, action, 'btn-small');
    node.setAttribute('aria-haspopup', 'dialog'); node.setAttribute('aria-controls', 'drawer'); return node;
  }
  function details(data) {
    const list = el('dl', undefined, 'details-grid');
    for (const [key, value] of Object.entries(data)) list.append(el('dt', key), el('dd', value === undefined || value === null || value === '' ? '—' : String(value)));
    return list;
  }
  function confirmAction(message, title = '未保存的修改', okText = '放弃修改', cancelText = '继续编辑') {
    if (confirmation) return Promise.resolve(false);
    return new Promise(resolve => {
      const dialog = el('dialog', undefined, 'conversation-confirm-dialog code-input-dialog'), previous = document.activeElement;
      dialog.setAttribute('aria-labelledby', 'config-confirm-title'); dialog.setAttribute('aria-describedby', 'config-confirm-message');
      const form = el('form'), header = el('header', undefined, 'conversation-confirm-header'), heading = el('h3', title);
      heading.id = 'config-confirm-title'; header.append(heading);
      const body = el('div', undefined, 'conversation-confirm-body'), content = el('p', message, 'settings-dialog-message');
      content.id = 'config-confirm-message'; body.append(content);
      const actions = el('footer', undefined, 'conversation-confirm-actions');
      const accept = el('button', okText, 'btn-danger'), cancel = el('button', cancelText, 'btn-secondary');
      accept.type = 'submit'; cancel.type = 'button'; actions.append(accept, cancel);
      form.append(header, body, actions); dialog.append(form);
      const finish = value => {
        confirmation = null; dialog.close(); dialog.remove();
        if (previous?.isConnected) previous.focus(); resolve(value);
      };
      confirmation = dialog;
      cancel.onclick = () => finish(false);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      form.onsubmit = event => { event.preventDefault(); finish(true); };
      document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  function openDrawer(title) {
    if (!$('drawer').open) returnFocus = document.activeElement;
    $('drawer-title').textContent = title;
    $('detail-content').replaceChildren(); $('drawer-actions').replaceChildren(); messageDirty = false;
    if (!$('drawer').open) $('drawer').showModal();
    $('drawer-body').scrollTop = 0;
    $('drawer-actions').append(button('关闭', cancelDrawer));
  }
  async function cancelDrawer() {
    if (messageDirty && !await confirmAction('有未发送的回复，是否放弃？')) return;
    closeDrawer();
  }
  function closeDrawer() {
    $('drawer').close(); messageDirty = false;
    $('detail-content').replaceChildren(); $('drawer-actions').replaceChildren();
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function closeEditor() {
    closeAccountDrawer(true);
    $('editor').hidden = true; $('editor').reset(); $('account-settings-form').reset();
    $('platform-fields').replaceChildren(); $('client-choices').replaceChildren(); $('editor-actions').replaceChildren();
    $('platform-links').replaceChildren(); $('platform-steps').replaceChildren();
    selected = null; dirty = false; baseConfig = {}; fields = [];
    returnFocus = editorReturnFocus?.isConnected ? editorReturnFocus : $('add'); editorReturnFocus = null;
    if (!returnFocus.disabled) returnFocus.focus();
  }
  async function cancelEditor() {
    if (dirty && !await confirmAction('有未保存的账号配置，是否放弃？')) return;
    closeEditor();
  }
  function accountDraft() {
    return { autoReply: { enabled: $('reply-mode').value === 'fixed', text: $('reply-text').value },
      authorizedClientIds: [...$('client-choices').querySelectorAll('input:checked')].map(input => input.value) };
  }
  function accountSectionDirty() {
    return !!accountSection && JSON.stringify(accountDraft()) !== JSON.stringify(accountSection.draft);
  }
  function updateAccountSummaries() {
    const draft = accountDraft();
    $('reply-summary').textContent = $('adapter').value === 'mail' && !$('receive-enabled').checked ? '仅发送邮件'
      : draft.autoReply.enabled ? '服务端固定回复' : '仅接收，手动或外部处理';
    $('authorization-summary').textContent = '服务端 · ' + (draft.authorizedClientIds.length
      ? draft.authorizedClientIds.length + ' 个客户端' : '未选择客户端');
  }
  function openAccountDrawer(kind) {
    if (busy || accountSection || $('editor').hidden) return;
    accountSection = { kind, draft: accountDraft(), returnFocus: document.activeElement };
    for (const section of ['reply', 'authorization']) {
      $(section + '-settings').hidden = section !== kind; $(section + '-settings').disabled = section !== kind;
    }
    $('account-drawer-title').textContent = kind === 'reply' ? '收到消息后' : '使用授权';
    $(kind + '-settings').querySelector('details').open = false;
    $('reply-text').setCustomValidity(''); updateReplyFields();
    $('account-drawer').showModal(); $('account-drawer').querySelector('.drawer-body').scrollTop = 0;
    const first = $(kind + '-settings').querySelector('select:not(:disabled), input:not(:disabled)');
    (first || $('close-account-drawer')).focus();
  }
  function closeAccountDrawer(discard = false) {
    if (!accountSection) return;
    const previous = accountSection;
    if (discard) {
      $('reply-mode').value = previous.draft.autoReply.enabled ? 'fixed' : 'manual'; $('reply-text').value = previous.draft.autoReply.text;
      $('client-choices').querySelectorAll('input').forEach(input => { input.checked = previous.draft.authorizedClientIds.includes(input.value); });
    }
    $('account-drawer').close(); accountSection = null;
    for (const id of ['reply-settings', 'authorization-settings']) { $(id).hidden = true; $(id).disabled = true; }
    $('reply-text').setCustomValidity(''); updateReplyFields(); updateAccountSummaries();
    if (previous.returnFocus?.isConnected) previous.returnFocus.focus();
  }
  async function cancelAccountDrawer() {
    if (accountSectionDirty() && !await confirmAction('有未保存的修改，是否放弃？')) return;
    closeAccountDrawer(true);
  }
  function applyAccountSection() {
    if (!accountSection) return;
    $('reply-text').value = $('reply-text').value.trim();
    dirty = dirty || accountSectionDirty();
    closeAccountDrawer();
  }
  async function copy(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); toast('已复制'); return; } catch (_) { /* HTTP deployments may need selection copying. */ }
    }
    const input = el('textarea', undefined, 'copy-input'), focused = document.activeElement;
    input.value = text; input.readOnly = true;
    ($('account-drawer').open ? $('account-drawer') : $('drawer').open ? $('drawer') : document.body).append(input);
    try {
      input.select();
      if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请选中文本后手动复制。');
    } finally { input.remove(); if (focused?.isConnected) focused.focus(); }
    toast('已复制');
  }
  async function refreshAccounts() {
    const [data, paired] = await together([request('GET', '/bots'), request('GET', '/bots/clients')]);
    catalog = data.adapters; clients = paired.items;
    if ($('editor').hidden) {
      $('adapter').replaceChildren(...catalog.map(item => { const option = el('option', item.name); option.value = item.id; return option; }));
    }
    $('account-count').textContent = data.items.length + ' 个账号 · 最多 20 个'; $('accounts').replaceChildren();
    for (const item of data.items) {
      const authorized = item.authorizedClientIds || [], online = clients.filter(client => authorized.includes(client.clientId) && client.online).length;
      const processing = item.adapter === 'mail' && !item.receiveEnabled ? '仅发送' : item.autoReply?.enabled ? '服务端固定回复' : '服务端仅接收';
      const card = itemCard(item.name, catalog.find(adapter => adapter.id === item.adapter)?.name || item.adapter, item.state, item.id,
        processing + ' · 客户端在线 ' + online + '/' + authorized.length + ' · ' + (item.lastReceivedAt ? '最近收信 ' + date(item.lastReceivedAt) : '尚未收到消息'),
        [drawerButton('消息', () => showMessages(item))]);
      card.dataset.accountId = item.id; card.tabIndex = 0;
      card.setAttribute('role', 'button'); card.setAttribute('aria-controls', 'editor');
      card.onclick = event => {
        if (busy || event.target.closest('button')) return;
        card.focus({ preventScroll: true }); run(() => configure(item));
      };
      card.onkeydown = event => {
        if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault(); card.click();
      };
      if (item.error) {
        const summary = card.querySelector('.item-sub');
        summary.append(el('span', item.error, 'account-error'));
        summary.title += '\n' + item.error;
      }
      $('accounts').append(card);
    }
    if (!data.items.length) empty($('accounts'), '还没有账号，点击「添加账号」开始');
  }
  function configGet(config, path) { return path.split('.').reduce((value, key) => value?.[key], config); }
  function configSet(config, path, value) {
    const keys = path.split('.'), last = keys.pop();
    const parent = keys.reduce((object, key) => object[key] ||= {}, config);
    if (value === undefined) delete parent[last]; else parent[last] = value;
  }
  function needsCallback() {
    const protocolField = fields.find(item => item.key === 'protocol');
    return $('adapter').value === 'wecom' || ['http', 'webhook'].includes(protocolField?.input.value);
  }
  function updateReplyFields() {
    const mail = $('adapter').value === 'mail';
    $('reply-mode').disabled = mail;
    if (mail) $('reply-mode').value = 'manual';
    const fixed = $('reply-mode').value === 'fixed';
    $('reply-text-row').hidden = !fixed; $('reply-text').disabled = !fixed;
    $('reply-text').required = fixed;
  }
  function updateConditionalFields() {
    const callback = needsCallback(); $('callback-fields').hidden = !callback; $('callback-fields').disabled = !callback;
    updateReplyFields(); updateAccountSummaries();
    for (const field of fields) {
      const hidden = field.callback && !callback || field.receive && !$('receive-enabled').checked;
      field.row.hidden = !!hidden;
      field.row.querySelectorAll('input,select,button').forEach(input => { input.disabled = !!hidden; });
    }
    for (const id of ['callback-host', 'callback-port', 'callback-url']) $(id).required = callback && $('enabled').checked;
    for (const field of fields) if (field.input) field.input.required = !!field.required && $('enabled').checked && !field.row.hidden;
    const path = fields.find(item => item.key === 'path');
    $('callback-preview').textContent = $('callback-url').value.replace(/\/$/, '') + (path?.input.value || path?.placeholder || '/wecom');
  }
  function buildFields(config) {
    const id = $('adapter').value, definition = window.PlatformForms[id];
    baseConfig = clone(config); fields = [];
    $('platform-fields').replaceChildren(); $('platform-links').replaceChildren(); $('platform-steps').replaceChildren();
    $('platform-settings').hidden = !definition;
    $('mail-receive-row').hidden = id !== 'mail';
    if (!definition) { updateConditionalFields(); return; }
    for (const [label, href] of [[id === 'mail' ? 'QQ 邮箱（示例）' : '官方控制台', definition.console], ['官方文档', definition.docs]]) {
      const link = el('a', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('platform-links').append(link);
    }
    definition.steps.forEach(step => $('platform-steps').append(el('li', step)));
    for (const spec of definition.fields) {
      const row = el('div', undefined, 'form-row' + (spec.type === 'checks' ? ' form-row-wide' : ''));
      const field = { ...spec, row }, value = configGet(config, spec.key), inputId = 'field-' + spec.key.replace(/\./g, '-');
      const label = el('label', spec.label); label.htmlFor = inputId;
      if (spec.type === 'checks') {
        row.append(el('span', spec.label)); field.checks = [];
        // Schema.bitset accepts named arrays; retain existing subscriptions outside the common choices.
        const options = [...spec.options];
        if (Array.isArray(value)) for (const name of value) if (!options.some(item => item[0] === name)) options.push([name, name]);
        for (const [name, title] of options) {
          const checkLabel = el('label', undefined, 'check-label'), input = el('input'); input.type = 'checkbox'; input.value = name;
          input.checked = Array.isArray(value) ? value.includes(name) : typeof value === 'number' && !!(value & intentBits[name]);
          checkLabel.append(input, el('span', title)); row.append(checkLabel); field.checks.push(input);
        }
      } else {
        const input = el(spec.options ? 'select' : 'input'); input.id = inputId; field.input = input;
        if (spec.options) {
          for (const [key, title] of spec.options) { const option = el('option', title); option.value = key; input.append(option); }
          input.value = String(value ?? spec.options[0][0]);
        } else {
          input.type = spec.type || 'text'; input.autocomplete = 'off'; input.spellcheck = false;
          if (spec.type === 'checkbox') input.checked = !!value; else input.value = value ?? '';
          if (spec.placeholder) input.placeholder = spec.placeholder;
          if (spec.type === 'number') { input.min = spec.min ?? 0; if (spec.max) input.max = spec.max; input.step = '1'; }
        }
        if (spec.type === 'checkbox') { label.className = 'check-label'; label.prepend(input); row.append(label); }
        else row.append(label, spec.type === 'password' ? passwordInput(input, spec.label) : input);
      }
      if (spec.hint) row.append(el('small', spec.hint, 'form-help'));
      $('platform-fields').append(row); fields.push(field);
    }
    updateConditionalFields();
  }
  async function configure(item) {
    if (dirty && !await confirmAction('放弃当前未保存的账号配置？')) return;
    const [value, paired] = await together([item ? request('GET', '/bots/accounts/' + encodeURIComponent(item.id) + '/configuration') : Promise.resolve(null), request('GET', '/bots/clients')]);
    if ($('editor').hidden) editorReturnFocus = document.activeElement;
    clients = paired.items; selected = value; dirty = false;
    $('editor').hidden = false; $('editor-actions').replaceChildren();
    $('editor-title').textContent = value ? '编辑账号 · ' + value.name : '添加账号';
    $('name').value = value?.name || ''; $('adapter').value = value?.adapter || catalog[0]?.id || '';
    $('enabled').checked = value?.enabled ?? true; $('receive-enabled').checked = value?.receiveEnabled !== false;
    $('reply-mode').value = value?.autoReply?.enabled ? 'fixed' : 'manual'; $('reply-text').value = value?.autoReply?.text || '';
    $('callback-host').value = value?.callback?.host || '127.0.0.1'; $('callback-port').value = value?.callback?.port || 5140;
    $('callback-url').value = value?.callback?.selfUrl || '';
    buildFields(value?.config || catalog.find(item => item.id === $('adapter').value)?.example || {});
    $('platform-guide').open = false;
    $('client-choices').replaceChildren();
    const authorized = value?.authorizedClientIds || [];
    const choices = [...clients, ...authorized.filter(id => !clients.some(client => client.clientId === id)).map(id => ({ clientId: id, name: '配对已撤销', revoked: true }))];
    for (const client of choices) {
      const label = el('label', undefined, 'check-label'), input = el('input'); input.type = 'checkbox'; input.value = client.clientId;
      input.checked = authorized.includes(client.clientId);
      const text = el('span', client.name + (client.incognito ? '（隐身）' : '') + ' · ' + (client.revoked ? '请取消授权' : client.online ? '在线' : '离线'));
      text.append(el('small', client.clientId)); label.append(input, text); $('client-choices').append(label);
    }
    if (!choices.length) empty($('client-choices'), '暂无已配对扩展，可在「连接配置」中配对。');
    updateAccountSummaries();
    const save = el('button', '保存', 'btn-primary'); save.type = 'submit';
    $('editor-actions').append(save, button('取消', cancelEditor));
    if (value) {
      $('editor-actions').append(el('span', undefined, 'spacer'), button('消息', () => showMessages(value)), button('删除', async () => {
        if (!await confirmAction('删除「' + value.name + '」及全部消息历史和消费进度？此操作不可恢复。', '删除账号', '删除', '取消')) return;
        await request('DELETE', '/bots/accounts/' + encodeURIComponent(value.id), { revision: selected.revision });
        closeEditor(); await refreshAccounts(); toast('已删除');
      }, 'btn-danger'));
    }
    if (value?.error) toast(value.error, true);
    $('editor-title').focus({ preventScroll: true });
    $('editor').scrollIntoView({ block: 'nearest' });
  }
  async function showMessages(account) {
    if (messageDirty && !await confirmAction('放弃未发送的回复并刷新消息？')) return;
    const data = await request('GET', '/bots/accounts/' + encodeURIComponent(account.id) + '/events');
    if ($('drawer').open) closeDrawer();
    openDrawer(account.name + ' · 最近消息');
    $('detail-content').append(el('p', '最近 50 条，最新在前。回复会发回消息来源；QQ 等平台的回复时限和权限仍然生效。', 'form-help'));
    const list = el('div', undefined, 'message-list'); $('detail-content').append(list);
    const replyStates = { pending: '等待发送或结果尚未确认（中断后不自动重试）', sent: '已发送', failed: '未发送', unknown: '结果未确认，请检查平台记录' };
    for (const message of data.items.slice().reverse()) {
      const row = el('article', undefined, 'message-entry');
      row.append(el('p', date(message.timestamp) + ' · ' + message.userId + ' · ' + (message.direct ? '私信' : '群组 / 频道'), 'form-help'),
        el('pre', message.text || '（非文本消息）'));
      const info = el('details', undefined, 'reference-panel drawer-guide'), infoBody = el('div', undefined, 'drawer-guide-content');
      infoBody.append(details({ 账号ID: account.id, 平台: message.platform, 用户ID: message.userId,
        频道ID: message.channelId, 群组ID: message.guildId, 事件ID: message.id, 平台消息ID: message.messageId }));
      info.append(el('summary', '消息来源'), infoBody);
      row.append(info);
      if (message.autoReply) row.append(el('p', '固定回复：' + (replyStates[message.autoReply.state] || message.autoReply.state)
        + (message.autoReply.error ? ' · ' + message.autoReply.error : ''), message.autoReply.state === 'failed' || message.autoReply.state === 'unknown' ? 'account-error' : 'form-help'));
      const form = el('form', undefined, 'reply-form'); form.hidden = true;
      const field = el('div', undefined, 'form-row'), label = el('label', '回复内容'), input = el('textarea'); input.id = 'reply-' + message.id;
      input.rows = 3; input.required = true; input.maxLength = 16000; label.htmlFor = input.id;
      const result = el('p', '', 'form-help'); result.setAttribute('role', 'status');
      const send = el('button', '发送回复', 'btn-primary'); send.type = 'submit';
      input.oninput = () => { messageDirty = true; };
      field.append(label, input); form.append(field, send, result);
      form.onsubmit = event => {
        event.preventDefault();
        if (send.dataset.unavailable === 'true') return;
        run(async () => {
          const text = input.value.trim(); if (!text) throw new Error('请填写回复内容');
          result.textContent = '发送中…'; send.dataset.unavailable = 'true';
          try {
            const sent = await request('POST', '/bots/accounts/' + encodeURIComponent(account.id) + '/messages', {
              replyTo: message.id, targetId: message.direct ? message.userId : message.channelId, direct: message.direct, text,
            });
            input.value = ''; result.textContent = '已发送 · 回执 ' + sent.messageIds.join('、');
            messageDirty = [...document.querySelectorAll('.reply-form textarea')].some(node => node.value.length);
          } catch (error) {
            if (error.performed === 'no') send.dataset.unavailable = 'false';
            result.textContent = error.message + (error.performed === 'no' ? '' : ' 请先检查平台记录，勿重复提交。');
            throw error;
          }
        });
      };
      const actions = el('div', undefined, 'actions'), reply = el('button', '回复', 'btn-small'); reply.type = 'button';
      reply.onclick = () => { if (!busy) { form.hidden = false; reply.setAttribute('aria-expanded', 'true'); input.focus(); } };
      reply.setAttribute('aria-expanded', 'false');
      actions.append(reply, button('复制来源 ID', () => copy(JSON.stringify({ accountId: account.id, channelId: message.channelId, userId: message.userId }, null, 2)), 'btn-small'));
      row.append(actions, form); list.append(row);
    }
    if (!data.items.length) empty(list, '还没有收到消息。请检查平台消息订阅、沙箱测试范围，以及群聊是否需要 @ 机器人；在线不代表消息已送达。');
  }
  async function saveAccount() {
    const config = clone(baseConfig);
    for (const field of fields) {
      if (field.row.hidden) continue;
      let value;
      if (field.checks) {
        value = field.checks.filter(input => input.checked).map(input => input.value);
        if (!value.length && $('enabled').checked) throw new Error('请至少选择一个已获授权的消息事件');
        if (typeof baseConfig[field.key] === 'number') {
          const known = Object.values(intentBits).reduce((bits, bit) => bits | bit, 0);
          value = value.reduce((bits, key) => bits | intentBits[key], baseConfig[field.key] & ~known);
        }
      } else if (field.type === 'checkbox') value = field.input.checked;
      else if (field.type === 'boolean-select') value = field.input.value === 'true';
      else if (field.type === 'number') value = field.input.value === '' ? undefined : Number(field.input.value);
      else value = field.input.value.trim() || undefined;
      configSet(config, field.key, value);
    }
    if (needsCallback() && config.path && !config.path.startsWith('/')) throw new Error('回调路径必须以 / 开头');
    const callback = needsCallback() && $('callback-url').value.trim() ? { host: $('callback-host').value.trim(),
      port: Number($('callback-port').value), selfUrl: $('callback-url').value.trim() } : null;
    if (callback) {
      const url = new URL(callback.selfUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('公网地址必须为不含凭据的 HTTP 或 HTTPS 地址');
    }
    const input = { name: $('name').value.trim(), adapter: $('adapter').value, enabled: $('enabled').checked,
      receiveEnabled: $('receive-enabled').checked, config, callback, ...accountDraft(),
      ...(selected ? { revision: selected.revision } : {}) };
    if (!input.name) throw new Error('请填写账号名称');
    await request('POST', selected ? '/bots/accounts/' + encodeURIComponent(selected.id) : '/bots/accounts', input);
    closeEditor();
    try { await refreshAccounts(); toast('已保存'); }
    catch (error) { toast('已保存，状态刷新失败：' + error.message, true); }
  }
  function metric(container, label, value, hint = '') {
    const card = el('div', undefined, 'metric'); card.append(el('span', label), el('strong', String(value)), el('small', hint)); container.append(card);
  }
  function logLevel(item) {
    if (item.level) return item.level;
    if (item.event === 'connection.closed') return item.errorReason === 'shutdown' ? 'info' : 'warn';
    return item.errorReason || item.decision === 'deny' || item.event.endsWith('.denied') ? 'error'
      : item.event === 'execution.unconfirmed' ? 'warn'
        : ['auth.succeeded', 'pairing.created'].includes(item.event) || item.performed === 'yes' ? 'success' : 'info';
  }
  function updateLogOverflow(container) {
    if (!container.clientWidth) return;
    const rows = [...container.querySelectorAll('.mcp-log-entry')];
    rows.forEach(row => { row.querySelector('button').hidden = true; });
    const overflowing = rows.filter(row => [...row.querySelectorAll('.mcp-log-content, .mcp-log-time')]
      .some(node => node.scrollWidth > node.clientWidth));
    overflowing.forEach(row => { row.querySelector('button').hidden = false; });
  }
  function renderLogs(container, items, emptyMessage = '暂无日志') {
    container.replaceChildren();
    for (const item of items) {
      const level = logLevel(item);
      const row = el('div', undefined, 'mcp-log-entry mcp-log-' + level);
      const title = item.message || eventLabels[item.event] || item.event;
      const metadata = ['operation', 'clientId', 'transport', 'address', 'decision', 'performed', 'sessionId', 'requestId', 'reason', 'errorReason']
        .filter(key => item[key] !== undefined && item[key] !== null && item[key] !== '')
        .map(key => key + '=' + item[key]).join(' ');
      const message = title + (metadata ? ' ' + metadata : '');
      const view = drawerButton('查看', () => {
        openDrawer('日志');
        const log = el('pre', undefined, 'log-content mcp-log-' + level);
        log.append(el('span', formatLogTime(item.timestamp) + ' ', 'mcp-log-time'),
          el('span', level + ' ', 'mcp-log-level'), document.createTextNode(message));
        $('detail-content').append(log);
      });
      view.hidden = true;
      const content = el('span', undefined, 'mcp-log-content');
      content.append(el('span', title, 'mcp-log-message'));
      if (metadata) content.append(document.createTextNode(' '), el('span', metadata, 'mcp-log-detail'));
      row.append(el('span', formatLogTime(item.timestamp), 'mcp-log-time'),
        el('span', level, 'mcp-log-level'),
        content, view);
      container.append(row);
    }
    if (!items.length) container.append(el('div', emptyMessage, 'mcp-log-empty'));
    updateLogOverflow(container);
  }
  function renderRuntime(data) {
    snapshot = data; $('server-name').textContent = data.name + ' · ' + data.version;
    $('sample-time').textContent = '更新于 ' + date(data.sampledAt) + ' · 自动刷新间隔 5 秒';
    $('runtime-summary').replaceChildren();
    metric($('runtime-summary'), 'WebSocket', data.websocket.listening ? '监听中' : '已停止', '端口 ' + (data.websocket.address?.port || '—') + ' · ' + data.websocket.sockets + ' 个连接');
    metric($('runtime-summary'), '扩展客户端', data.clients.filter(item => item.state === 'ready').length + ' / ' + data.clients.length, '已就绪 / 已配对');
    metric($('runtime-summary'), 'HTTP 会话', data.sessions.length, '包含当前配置页');
    metric($('runtime-summary'), '运行时间', Math.floor(data.uptime / 60) + ' 分钟', '服务进程');
    $('clients').replaceChildren();
    for (const item of data.clients) {
      const detail = drawerButton('详情', () => {
        openDrawer(item.name);
        $('detail-content').append(details({ 客户端ID: item.clientId, 状态: labels[item.state] || item.state, 地址: item.address,
          浏览环境: item.incognito ? '隐身' : '普通', 扩展ID: item.extensionId, 版本: item.version,
          配对时间: date(item.createdAt), 连接时间: date(item.connectedAt), 最近心跳: date(item.lastSeenAt),
          待返回请求: item.pending, 发送缓冲: item.bufferedBytes + ' B' }));
        $('drawer-actions').prepend(button('撤销配对', async () => {
          if (!await confirmAction('撤销此客户端的配对并断开连接？', '撤销配对', '撤销', '取消')) return;
          await admin('revoke', { pairingId: item.pairingId }); closeDrawer(); await refreshRuntime(); toast('已撤销');
        }, 'btn-danger'));
      });
      $('clients').append(itemCard(item.name, item.incognito ? '隐身客户端' : '扩展客户端', item.state, item.clientId, item.address || '尚未连接', [detail]));
    }
    if (!data.clients.length) empty($('clients'), '还没有配对客户端');
    $('sessions').replaceChildren();
    for (const item of data.sessions) {
      const detail = drawerButton('详情', () => {
        openDrawer(item.name);
        $('detail-content').append(details({ 会话ID: item.id, 状态: labels[item.state] || item.state, 地址: item.address, 版本: item.version,
          建立时间: date(item.createdAt), 最近活动: date(item.lastSeenAt), 目标客户端: item.target?.clientId || item.target || '未绑定',
          活动请求: item.active, 通知流: item.streaming ? 'SSE 已连接' : '未订阅流', 订阅数: item.subscriptions, 待通知: item.pending }));
      });
      $('sessions').append(itemCard(item.name, item.id === sessionId ? '当前页面' : 'HTTP MCP', item.state, item.id, item.address || '', [detail]));
    }
    if (!data.sessions.length) empty($('sessions'), '暂无 HTTP 会话');
    const queues = data.queues; $('queues').replaceChildren();
    metric($('queues'), '邮件发送', queues.mail.active + ' / ' + queues.mail.maxConcurrent, queues.mail.closed ? '已关闭' : '使用中 / 并发上限');
    metric($('queues'), '邮件排队', queues.mail.waiting + ' / ' + queues.mail.maxQueued, Math.ceil(queues.mail.queuedBytes / 1024) + ' KB 等待内容');
    metric($('queues'), '本地执行', queues.executions, '正在执行的请求');
    metric($('queues'), '扩展转发', queues.forwards, '等待扩展返回');
    metric($('queues'), 'HTTP 请求', queues.http, '正在处理');
    metric($('queues'), '审计写入', queues.audit.pending, (queues.audit.available ? '可用' : '不可用') + ' · ' + queues.audit.bytes + ' B 排队');
    $('reset-token').dataset.unavailable = String(data.tokenManagedByEnvironment);
    $('token-source').textContent = data.tokenManagedByEnvironment ? '由启动配置管理，请修改部署配置后重启' : '';
    if (!$('ws-url').value) {
      const ws = new URL(location.origin); ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws.port = String(data.websocket.address?.port || 9999); $('ws-url').value = ws.href;
    }
  }
  async function refreshRuntime() {
    const [data, logs] = await together([admin('status'), admin('connections')]);
    renderRuntime(data); renderLogs($('connection-logs'), logs.items);
  }
  function filterAudit() {
    const query = $('audit-filter').value.trim().toLowerCase(), level = $('audit-level').value;
    const client = $('audit-client').value.trim().toLowerCase(), event = $('audit-event').value;
    const duration = Number($('audit-time').value), now = Date.now();
    const items = auditItems.filter(item => (!level || logLevel(item) === level)
      && (!duration || Date.parse(item.timestamp) >= now - duration && Date.parse(item.timestamp) <= now)
      && (!client || (item.clientId || '').toLowerCase().includes(client))
      && (!event || item.event === event)
      && (!query || (JSON.stringify(item) + (eventLabels[item.event] || '')).toLowerCase().includes(query)));
    renderLogs($('audit-list'), items, auditItems.length ? '没有匹配的日志，请调整筛选条件' : '暂无日志');
    $('audit-result-count').textContent = '已加载 ' + auditItems.length + ' 条，匹配 ' + items.length + ' 条';
  }
  function updateAuditChoices() {
    const current = $('audit-event').value, all = el('option', '全部事件'); all.value = '';
    const events = [...new Set([...auditItems.map(item => item.event), current].filter(Boolean))].sort();
    $('audit-event').replaceChildren(all, ...events.map(event => {
      const option = el('option', eventLabels[event] || event); option.value = event; return option;
    }));
    $('audit-event').value = current;
    $('audit-client-options').replaceChildren(...[...new Set(auditItems.map(item => item.clientId).filter(Boolean))].sort().map(id => {
      const option = el('option'); option.value = id; return option;
    }));
  }
  async function refreshAudit() {
    auditItems = (await admin('audit')).items; updateAuditChoices(); filterAudit();
  }
  async function refreshConnection() {
    const [tools, local, data] = await together([rpc('tools/list'), request('GET', '/local'), admin('status')]);
    renderRuntime(data); $('tools').replaceChildren(); $('tool-count').textContent = tools.tools.length;
    for (const tool of tools.tools) {
      const entry = el('details', undefined, 'reference-panel drawer-guide'), content = el('div', undefined, 'drawer-guide-content');
      content.append(el('p', tool.description, 'form-help'), el('pre', JSON.stringify(tool.inputSchema, null, 2)));
      entry.append(el('summary', tool.name), content);
      $('tools').append(entry);
    }
    $('capabilities').replaceChildren();
    $('capabilities').append(details({ 服务端: data.name, 服务端ID: data.serverId, 工作目录: local.workingDirectory }));
    const links = el('ul', undefined, 'capability-list');
    for (const link of local.links || []) links.append(el('li', link.method + ' ' + link.href));
    $('capabilities').append(links);
  }
  async function showPanel(id) {
    panel = id;
    $('nav').querySelectorAll('button').forEach(node => {
      const current = node.getAttribute('aria-controls') === id;
      node.classList.toggle('active', current);
      if (current) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
      const section = $(node.getAttribute('aria-controls')); section.hidden = !current; section.classList.toggle('active', current);
    });
    if (id === 'accounts-panel') await refreshAccounts();
    if (id === 'connection-panel') await refreshConnection();
    if (id === 'runtime-panel') await refreshRuntime();
    if (id === 'audit-panel') await refreshAudit();
    if (id === 'devtools-panel' && !devtoolsPanel.dirty) await devtoolsPanel.refresh();
  }
  $('login').addEventListener('submit', event => {
    event.preventDefault(); run(async () => {
      credential = $('token').value.trim(); $('token').value = '';
      try { await initialize(); } catch (error) { resetSession(); throw error; }
      await showPanel('accounts-panel');
    });
  });
  $('logout').onclick = () => run(async () => {
    if ((dirty || devtoolsPanel.dirty) && !await confirmAction('有未保存的配置，是否放弃并退出令牌登录？', '退出令牌登录', '退出', '继续编辑')) return;
    try { await transport('/mcp', 'DELETE'); } finally { resetSession(); }
  });
  $('nav').querySelectorAll('button').forEach(node => {
    node.title = node.textContent.trim();
    node.onclick = () => run(() => showPanel(node.getAttribute('aria-controls')));
  });
  function setGlobalSidebarCollapsed(collapsed) {
    $('app').classList.toggle('global-sidebar-collapsed', collapsed);
    const toggle = $('btn-toggle-sidebar');
    toggle.title = collapsed ? '显示侧边栏' : '隐藏侧边栏';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('page-agent.config.sidebar-collapsed', collapsed ? '1' : '0'); } catch (_) {}
  }
  setGlobalSidebarCollapsed((() => {
    try { return localStorage.getItem('page-agent.config.sidebar-collapsed') === '1'; } catch (_) { return false; }
  })());
  $('btn-toggle-sidebar').onclick = () => setGlobalSidebarCollapsed(!$('app').classList.contains('global-sidebar-collapsed'));
  $('add').onclick = () => run(() => configure(null));
  bindConfigTransfer('accounts', { read: () => request('GET', '/bots'), dirty: () => dirty, close: closeEditor, refresh: refreshAccounts });
  bindConfigTransfer('devtools', { read: () => admin('devtools'), dirty: () => devtoolsPanel.dirty,
    close: () => devtoolsPanel.closeEditor(), refresh: () => devtoolsPanel.refresh() });
  $('audit-filters').oninput = filterAudit;
  $('audit-filters').onsubmit = event => { event.preventDefault(); filterAudit(); };
  $('audit-reset').onclick = () => { $('audit-filters').reset(); filterAudit(); };
  const logObserver = new ResizeObserver(entries => entries.forEach(entry => updateLogOverflow(entry.target)));
  for (const id of ['connection-logs', 'audit-list']) logObserver.observe($(id));
  $('close-drawer').onclick = () => run(cancelDrawer);
  $('drawer').addEventListener('cancel', event => { event.preventDefault(); run(cancelDrawer); });
  $('edit-reply').onclick = () => openAccountDrawer('reply');
  $('edit-authorization').onclick = () => openAccountDrawer('authorization');
  $('close-account-drawer').onclick = $('cancel-account-drawer').onclick = () => run(cancelAccountDrawer);
  $('account-drawer').addEventListener('cancel', event => { event.preventDefault(); run(cancelAccountDrawer); });
  $('account-settings-form').addEventListener('input', () => { $('reply-text').setCustomValidity(''); updateReplyFields(); });
  $('account-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !accountSection) return;
    if (accountSection.kind === 'reply' && $('reply-mode').value === 'fixed' && !$('reply-text').value.trim()) {
      $('reply-text').setCustomValidity('请填写回复内容'); $('reply-text').reportValidity(); return;
    }
    applyAccountSection();
  });
  $('editor').addEventListener('input', () => { dirty = true; updateConditionalFields(); });
  $('adapter').onchange = () => { buildFields(catalog.find(item => item.id === $('adapter').value)?.example || {}); dirty = true; lock(); };
  $('editor').addEventListener('submit', event => { event.preventDefault(); run(saveAccount); });
  $('copy-endpoint').onclick = () => run(() => copy(endpoint));
  $('copy-config').onclick = () => run(() => copy($('client-config').textContent));
  $('copy-prompt').onclick = () => run(() => copy($('usage-prompt').textContent));
  $('pair').onclick = () => run(async () => {
    const url = new URL($('ws-url').value.trim());
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.href.length > 4000) throw new Error('请填写不含凭据的 WebSocket 地址（最多 4000 字符）');
    const ticket = await admin('pairing', {});
    const code = 'PA1.' + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({
      type: 'page-agent-pairing', url: url.href, name: snapshot?.name || 'Page Agent', token: ticket.token, expiresAt: ticket.expiresAt,
    }))));
    openDrawer('一键配对');
    $('detail-content').append(el('p', '复制配对码，在扩展「MCP 服务器连接 → 一键配对」粘贴并点击「配对」。', 'form-help'),
      el('p', '有效至 ' + date(ticket.expiresAt) + '，仅可使用一次。', 'form-help'), el('pre', code));
    $('drawer-actions').prepend(button('复制', () => copy(code), 'btn-primary'));
  });
  $('reset-token').onclick = () => run(async () => {
    openDrawer('重置 HTTP 令牌');
    $('detail-content').append(el('p', '重置后，旧 HTTP 令牌立即失效，所有 HTTP 会话会断开。请保存新令牌并更新外部客户端配置。扩展 WebSocket 配对不受影响。'));
    $('drawer-actions').prepend(button('重置', async () => {
      const result = await admin('token', {});
      credential = result.token; sessionId = protocol = '';
      rememberCredential();
      openDrawer('保存新令牌');
      $('detail-content').append(el('p', '仅此次显示，关闭前请保存。', 'form-help'), el('pre', result.token));
      $('drawer-actions').prepend(button('复制', () => copy(result.token), 'btn-primary'));
      // Reinitialize lazily on the next MCP request; keep the new token visible
      // even if the network becomes unavailable immediately after rotation.
    }, 'btn-danger'));
  });
  setInterval(() => {
    if (!authenticated || busy || document.hidden || $('drawer').open || panel !== 'runtime-panel' || !$('auto-refresh').checked) return;
    run(refreshRuntime);
  }, 5000);
  addEventListener('beforeunload', event => { if (dirty || messageDirty || devtoolsPanel.dirty || busy || accountSectionDirty()) { event.preventDefault(); event.returnValue = ''; } });
  try { credential = sessionStorage.getItem(credentialKey) || ''; }
  catch (_) { /* Fall back to manual login when browser storage is unavailable. */ }
  lock();
  if (credential) run(async () => {
    await initialize();
    await showPanel('accounts-panel');
  });
})();
