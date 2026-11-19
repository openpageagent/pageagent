(function (root) {
  'use strict';
  root.DevToolsPanel = { create: function (ui) {
    const { $, el, button, itemCard, switchLabel, passwordInput, admin, request, run, toast, confirmAction } = ui;
    const kinds = root.PageAgentDevToolsCatalog.kinds;
    const writeHints = {
      postgres: '开启后可新增、修改、清空或删除数据，也可能删除表等数据库对象，请谨慎授权。',
      mysql: '开启后可新增、修改或删除数据，误操作可能影响整张表，请谨慎授权。',
      jira: '开启后可创建工单、添加评论或变更工单状态，请确认项目和操作范围。',
      confluence: '开启后可创建页面或更新页面内容，可能覆盖现有正文，请谨慎授权。',
      jenkins: '开启后可触发构建，构建脚本可能执行部署、删除文件等操作，请谨慎授权。',
      gitlab: '开启后可创建合并请求或触发流水线，流水线可能执行部署、删除等操作，请谨慎授权。',
      redis: '开启后可覆盖键值或删除键，也可能改变数据有效期，请谨慎授权。',
      ssh: '开启后可执行远程命令，可能删除文件、目录或更改系统配置，请谨慎授权。',
      s3: '开启后可上传、覆盖或删除对象，删除指定版本不可恢复，请谨慎授权。',
    };
    let items = [], clients = [], revision = 0, selected = null, dirty = false, loaded = false;
    for (const kind of kinds) {
      const option = el('option', kind.name); option.value = kind.id; $('devtools-kind').append(option);
      const guide = el('details', undefined, 'reference-panel drawer-guide'), content = el('div', undefined, 'drawer-guide-content'), operations = el('ul');
      for (const operation of kind.operations) {
        const item = el('li');
        item.append(el('code', operation.id), document.createTextNode(' · ' + operation.label + (operation.write ? '（需操作授权）' : '（查询）')));
        operations.append(item);
      }
      content.append(operations); guide.append(el('summary', kind.name + ' · 支持的操作'), content); $('devtools-operations').append(guide);
    }
    function fields(kind, item) {
      $('devtools-write-label').textContent = kind.writeLabel || '允许写入';
      $('devtools-write-hint').textContent = writeHints[kind.id];
      $('devtools-write-control').hidden = !kind.operations.some(operation => operation.write);
      clearTestResult();
      $('devtools-fields').replaceChildren();
      for (const field of kind.fields) {
        const row = el('div', undefined, 'form-row' + (field.type === 'textarea' ? ' form-row-wide' : '')), id = 'devtools-config-' + field.key;
        const input = el(field.type === 'select' ? 'select' : field.type === 'textarea' ? 'textarea' : 'input');
        input.id = id; input.dataset.key = field.key;
        if (field.type === 'select') for (const [value, name] of field.choices) { const option = el('option', name); option.value = value; input.append(option); }
        else if (field.type === 'textarea') input.rows = 4;
        else input.type = field.secret ? 'password' : field.type === 'checkbox' ? 'checkbox' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text';
        input.autocomplete = field.secret ? 'new-password' : 'off';
        if (field.maxLength) input.maxLength = field.maxLength;
        if (field.type === 'number') { input.min = field.min; input.max = field.max; input.required = true; }
        const value = item?.config[field.key] ?? field.default;
        if (field.type === 'checkbox') input.checked = value; else input.value = field.secret ? '' : value;
        if (field.type === 'checkbox') row.append(switchLabel(input, field.label));
        else {
          const label = el('label', field.label); label.htmlFor = id;
          row.append(label, input.type === 'password' ? passwordInput(input, field.label) : input);
        }
        if (field.hint) row.append(el('p', field.hint, 'form-help'));
        if (field.secret) {
          row.append(el('p', item?.secrets[field.key] ? '已保存；留空保留。' : '未保存；按认证方式填写。', 'form-help'));
          if (item?.secrets[field.key]) {
            const clear = el('input');
            clear.type = 'checkbox'; clear.dataset.clear = field.key;
            row.append(switchLabel(clear, '清除此凭据'));
          }
        }
        $('devtools-fields').append(row);
      }
    }
    function renderClients(item) {
      $('devtools-clients').replaceChildren();
      for (const client of clients) {
        const input = el('input');
        input.type = 'checkbox'; input.value = client.clientId; input.checked = !!item?.authorizedClientIds.includes(client.clientId);
        $('devtools-clients').append(switchLabel(input, client.name + ' · ' + client.clientId + (client.online ? '（在线）' : '（离线）')));
      }
      if (!clients.length) $('devtools-clients').append(el('p', '暂无已配对客户端。', 'form-help'));
    }
    async function edit(item) {
      if (dirty && !await confirmAction('放弃当前未保存的连接配置？')) return;
      selected = item; dirty = false;
      $('devtools-editor').hidden = false;
      $('devtools-editor-title').textContent = item ? '编辑连接 · ' + item.name : '添加连接';
      $('devtools-kind').value = item?.kind || kinds[0].id; $('devtools-kind').disabled = !!item;
      $('devtools-name').value = item?.name || '';
      $('devtools-enabled').checked = item?.enabled || false;
      $('devtools-write').checked = item?.allowWrites || false;
      $('devtools-timeout').value = item?.timeoutMs || 30000;
      fields(kinds.find(kind => kind.id === $('devtools-kind').value), item); renderClients(item);
    }
    function renderList() {
      $('devtools-list').replaceChildren();
      for (const item of items) {
        const kind = kinds.find(kind => kind.id === item.kind);
        const card = itemCard(item.name, kind.name, item.enabled ? 'enabled' : 'disabled', item.id,
          item.allowWrites ? kind.writeLabel || '允许写入' : kind.operations.some(operation => !operation.write) ? '只读' : '操作未授权', [button('配置', () => edit(item)), button('删除', async () => {
          if (!await confirmAction('删除连接「' + item.name + '」及其保存的凭据？远端业务数据不会被删除。', '删除连接', '删除', '取消')) return;
          const value = await admin('devtools/remove', { id: item.id, revision });
          revision = value.revision; items = value.items;
          if (selected?.id === item.id) { selected = null; dirty = false; $('devtools-editor').hidden = true; }
          renderList(); toast('连接已删除');
        }, 'btn-danger')]);
        $('devtools-list').append(card);
      }
      if (!items.length) $('devtools-list').append(el('p', '尚未配置研发工具连接。点击「添加连接」选择连接类型。', 'placeholder'));
    }
    async function refresh() {
      const results = await Promise.allSettled([admin('devtools'), request('GET', '/bots/clients')]);
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      const [value, paired] = results.map(result => result.value);
      revision = value.revision; items = value.items; clients = paired.items; loaded = true; dirty = false;
      selected = null; $('devtools-editor').hidden = true; renderList();
    }
    function closeEditor() {
      selected = null; dirty = false; $('devtools-editor').hidden = true; clearTestResult();
    }
    function connectionInput() {
      const kind = kinds.find(kind => kind.id === $('devtools-kind').value), config = {};
      for (const field of kind.fields) {
        const input = $('devtools-config-' + field.key);
        if (field.secret && !input.value) continue;
        config[field.key] = field.type === 'checkbox' ? input.checked : field.type === 'number' ? Number(input.value) : field.secret ? input.value : input.value.trim();
      }
      return { revision, ...(selected ? { id: selected.id } : {}), kind: kind.id,
        timeoutMs: Number($('devtools-timeout').value), config,
        clearSecrets: [...$('devtools-fields').querySelectorAll('input[data-clear]:checked')].map(input => input.dataset.clear) };
    }
    function clearTestResult() {
      $('devtools-test-result').hidden = true; $('devtools-test-result').textContent = '';
      $('devtools-test-result').classList.remove('account-error');
    }
    async function testConnection() {
      const result = $('devtools-test-result');
      result.hidden = false; result.classList.remove('account-error'); result.textContent = '正在测试连接…';
      try {
        const value = await admin('devtools/test', connectionInput());
        if (!loaded) return;
        result.textContent = '连接测试通过 · ' + value.durationMs + ' 毫秒' + (value.auditRecorded === false ? '（审计记录未写入）' : '');
      } catch (error) {
        if (!loaded) return;
        result.classList.add('account-error'); result.textContent = '连接测试失败：' + (error.message || '请求失败');
      }
    }
    async function save() {
      const previousId = selected?.id;
      const value = await admin('devtools', { ...connectionInput(),
        name: $('devtools-name').value.trim(), enabled: $('devtools-enabled').checked, allowWrites: $('devtools-write').checked,
        authorizedClientIds: [...$('devtools-clients').querySelectorAll('input:checked')].map(input => input.value) });
      revision = value.revision; items = value.items; dirty = false; renderList();
      await edit(items.find(item => item.id === previousId) || items[items.length - 1]); toast('连接已保存，下次调用生效');
    }
    $('devtools-form').addEventListener('input', () => { dirty = true; clearTestResult(); });
    $('devtools-form').addEventListener('submit', event => { event.preventDefault(); run(save); });
    $('devtools-kind').onchange = () => { fields(kinds.find(kind => kind.id === $('devtools-kind').value), null); $('devtools-write').checked = false; dirty = true; };
    $('test-devtools').onclick = () => run(testConnection);
    $('add-devtools').onclick = () => run(() => edit(null));
    $('cancel-devtools').onclick = () => run(async () => {
      if (dirty && !await confirmAction('放弃未保存的连接配置？')) return;
      closeEditor();
    });
    return { refresh, closeEditor, get dirty() { return dirty; },
      lock(busy) { $('devtools-form-fields').disabled = busy; $('devtools-kind').disabled = busy || !!selected; $('add-devtools').disabled = busy || !loaded; },
      reset() { items = []; clients = []; selected = null; dirty = false; loaded = false; revision = 0;
        clearTestResult();
        $('devtools-form').reset(); $('devtools-list').replaceChildren(); $('devtools-fields').replaceChildren(); $('devtools-clients').replaceChildren(); $('devtools-editor').hidden = true; },
    };
  } };
})(window);
