(function () {
  'use strict';
  function element(id) { return document.getElementById('archive-' + id); }
  var panel = element('panel'), root = element('controls');
  var autoPanel = element('auto-panel'), autoRoot = element('auto-controls');
  var latest = null, bucket = null, busy = false, autoDirty = false, connectionDirty = false;
  var selectedConnectionId = null, renderedConnectionId = null, logSignature = '', autoLogSignature = '', cleared = new Set();
  var editorOpen = false, connectionsSignature = '';
  var selectedSourceId = null, sourcesSignature = '', selectedVersionId = null, versionsSignature = '';
  var statusSequence = 0;
  var drawerApi = null, versionsOpen = false;
  var incompatibility = {
    SYNC_PROTOCOL_MISMATCH: '同步协议不兼容，请更新双方版本',
    BACKUP_FORMAT_MISMATCH: '备份格式不兼容，请更新双方版本',
    APPLICATION_VERSION_MISMATCH: '应用主版本不兼容，请更新双方版本',
    CONNECTION_DISABLED: '连接未开启', CONNECTION_NOT_READY: '等待连接就绪',
  };
  function setText(id, text) {
    var item = element(id);
    if (item.textContent !== text) item.textContent = text;
  }
  function message(text, scope) {
    (scope === 'auto' ? ['auto-status'] : ['status', 'version-status']).forEach(function (id) {
      setText(id, text || ''); element(id).hidden = !text;
    });
  }
  function node(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function time(timestamp) {
    var date = new Date(timestamp);
    function pad(value, width) { return String(value).padStart(width || 2, '0'); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' '
      + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3);
  }
  function connection() { return latest && latest.connections.find(function (item) { return item.id === selectedConnectionId; }); }
  async function control(action, values) {
    var pending = chrome.runtime.sendMessage({ type: 'ARCHIVE_CONTROL',
      payload: Object.assign({ action: action, connectionId: selectedConnectionId }, values) });
    var response, timer;
    try {
      response = action === 'status' ? await Promise.race([pending, new Promise(function (_, reject) {
        timer = window.setTimeout(function () { reject(new Error('读取状态超时，将自动重试。')); }, 15000);
      })]) : await pending;
    } finally { window.clearTimeout(timer); }
    if (!response || !response.ok) throw new Error(response && response.error || '无法连接扩展后台');
    return response.result;
  }
  function controls() {
    [root, autoRoot, element('versions-content')].forEach(function (section) {
      section.querySelectorAll('button,input,select').forEach(function (item) { item.disabled = busy || !latest; });
    });
    element('connections-list').querySelectorAll('.item-card').forEach(function (item) { item.setAttribute('aria-disabled', String(busy || !latest)); });
    element('versions-list').querySelectorAll('.item-card').forEach(function (item) { item.setAttribute('aria-disabled', String(busy || !latest)); });
    element('versions-close').disabled = false;
    element('connection-editor').setAttribute('aria-busy', String(busy));
    element('reload').disabled = busy;
    if (!latest) return;
    var current = latest.selectedConnectionId === selectedConnectionId ? connection() : null;
    var selectedVersion = latest.versions && latest.versions.items.find(function (item) { return item.id === selectedVersionId; });
    var usable = !!current && current.ready && !!latest.compatibility && latest.compatibility.compatible === true;
    element('auto-sync').disabled = busy || !latest.autoSyncAvailable || !!latest.syncTarget;
    element('sources-list').querySelectorAll('.item-card').forEach(function (card) {
      var item = latest.connections.find(function (item) { return item.id === card.dataset.id; });
      var radio = card.querySelector('input');
      radio.disabled = busy || !latest.autoSyncAvailable || !!latest.syncTarget || !item || !item.enabled || !item.arpPermissions.read || !item.arpPermissions.write;
      radio.checked = selectedSourceId === card.dataset.id;
      card.classList.toggle('selected', radio.checked);
      card.setAttribute('aria-disabled', String(radio.disabled));
      card.title = !latest.autoSyncAvailable ? '当前环境不支持自动同步'
        : latest.syncTarget ? '同步源由容器启动设置管理'
        : !item || !item.enabled ? '请先在上方开启此连接'
          : !item.arpPermissions.read || !item.arpPermissions.write ? '此连接需要读取和写入权限' : '';
    });
    element('save-auto').disabled = busy || !latest.autoSyncAvailable || !!latest.syncTarget || !autoDirty;
    setText('save-auto', autoDirty ? '保存（未保存）' : '保存');
    ['bucket', 'auto-backup', 'interval', 'retain'].forEach(function (id) { element(id).disabled = busy || !current; });
    element('interval').disabled = element('interval').disabled || !element('auto-backup').checked;
    element('save').disabled = busy || !current || !connectionDirty && !!latest.target;
    setText('save', connectionDirty ? '保存（未保存）' : '保存');
    element('create-version').disabled = busy || connectionDirty || !usable || !bucket;
    element('versions').disabled = busy || connectionDirty || !usable || !bucket;
    element('apply').disabled = busy || connectionDirty || !usable || !bucket || !selectedVersion || !selectedVersion.syncable || !current.arpPermissions.write;
    element('syncable').disabled = busy || connectionDirty || !usable || !bucket || !selectedVersion;
    ['log-clear', 'log-reload'].forEach(function (id) { element(id).disabled = busy || !current || !latest.target; });
    element('operations').querySelectorAll('[data-retry]').forEach(function (button) { button.disabled = busy || connectionDirty || !usable; });
    element('log-identity').querySelectorAll('.mcp-log-copy').forEach(function (button) { button.disabled = busy || !button.dataset.copyValue; });
  }
  function connectionCard(item) {
    var card = node('div', 'item-card connection-card'); card.dataset.id = item.id;
    var summary = node('span', 'connection-summary');
    var title = node('span', 'item-title', item.alias || item.url); title.title = title.textContent;
    var description = node('span', 'item-sub', item.url + ' · ' + (item.platform || '待确认平台')); description.title = description.textContent;
    var id = node('button', 'item-id', 'ID: ' + item.id); id.type = 'button';
    id.dataset.action = 'copy-id'; id.dataset.id = item.id;
    id.setAttribute('aria-label', '复制 ID: ' + item.id); id.title = '点击复制 ID: ' + item.id;
    summary.append(title, description, id);
    var state = ({ disabled: '已配对 · 已关闭', disconnected: '网络断开', connecting: '连接中', authenticating: '认证中',
      'pairing-required': '需要配对', pairing: '配对中', configuring: '同步目录中', ready: '已就绪', 'auth-failed': '认证失败',
      revoked: '凭据已撤销', 'identity-conflict': '服务端身份冲突', incompatible: '协议不兼容，请同步升级' })[item.state] || '尚未连接';
    var stateLabel = item.state === 'pairing' ? '配对中'
      : item.needsPairing ? item.paired ? (item.enabled ? '已开启' : '已关闭') + ' · 待重新配对' : '未配对'
        : item.reason === 'RETRY_LIMIT_REACHED' ? '已开启 · 重试已停止' : state;
    var badge = node('span', 'badge' + (item.ready ? ' on' : ''), stateLabel); badge.title = item.reason || '';
    card.append(summary, badge);
    return card;
  }
  function replaceCards(list, cards) {
    var active = document.activeElement, focusedCard = active.closest('.item-card');
    var focusedId = focusedCard && list.contains(focusedCard) ? focusedCard.dataset.id : null;
    var selector = active.matches('.item-id') ? '.item-id' : active.matches('input') ? 'input' : null;
    list.replaceChildren(cards);
    if (focusedId) {
      var focused = Array.from(list.children).find(function (item) { return item.dataset.id === focusedId; });
      if (focused) (selector ? focused.querySelector(selector) : focused).focus({ preventScroll: true });
    }
  }
  function renderConnections() {
    var list = element('connections-list');
    var signature = JSON.stringify([latest.connections, editorOpen, selectedConnectionId]);
    if (signature === connectionsSignature) return;
    connectionsSignature = signature;
    var cards = document.createDocumentFragment();
    latest.connections.forEach(function (item) {
      var expanded = editorOpen && item.id === selectedConnectionId;
      var card = connectionCard(item); card.classList.add('archive-connection-card');
      card.classList.toggle('selected', expanded); card.tabIndex = 0;
      card.setAttribute('role', 'button'); card.setAttribute('aria-expanded', String(expanded));
      card.setAttribute('aria-controls', 'archive-connection-editor');
      card.setAttribute('aria-disabled', String(busy));
      cards.appendChild(card);
    });
    if (!latest.connections.length) cards.appendChild(node('div', 'placeholder', '还没有服务端，请先在上方添加连接'));
    replaceCards(list, cards);
  }
  function renderSources() {
    var signature = JSON.stringify(latest.connections);
    if (signature === sourcesSignature) return;
    sourcesSignature = signature;
    var cards = document.createDocumentFragment();
    latest.connections.forEach(function (item) {
      var card = connectionCard(item); card.classList.add('archive-source-card');
      var radio = node('input'); radio.type = 'radio'; radio.name = 'archive-source'; radio.value = item.id;
      radio.setAttribute('aria-label', '自动同步源：' + (item.alias || item.url));
      card.prepend(radio); cards.appendChild(card);
    });
    if (!latest.connections.length) cards.appendChild(node('div', 'placeholder', '还没有服务端，请先在上方添加连接'));
    replaceCards(element('sources-list'), cards);
  }
  function renderVersions() {
    var versions = latest.versions && latest.versions.items || [];
    if (!versions.some(function (item) { return item.id === selectedVersionId; })) selectedVersionId = null;
    var selectedVersion = versions.find(function (item) { return item.id === selectedVersionId; });
    if (versionsOpen) {
      var title = '备份版本' + (connection() ? ' · ' + (connection().alias || connection().url) : '')
        + (bucket ? ' · ' + bucket.id : '');
      var heading = document.getElementById('drawer-title');
      if (heading.textContent !== title) heading.textContent = title;
    }
    element('version-actions').hidden = !selectedVersionId;
    setText('version-title', '版本 ' + (selectedVersionId || ''));
    setText('syncable', selectedVersion && selectedVersion.syncable ? '取消可同步' : '标记为可同步');
    var signature = JSON.stringify([selectedConnectionId, bucket && bucket.id, latest.error, latest.versions, selectedVersionId]);
    if (signature === versionsSignature) return;
    versionsSignature = signature;
    var cards = document.createDocumentFragment();
    versions.forEach(function (version) {
      var expanded = version.id === selectedVersionId;
      var card = node('div', 'item-card connection-card archive-version-card' + (expanded ? ' selected' : ''));
      card.tabIndex = 0; card.dataset.id = version.id;
      card.setAttribute('role', 'button'); card.setAttribute('aria-expanded', String(expanded));
      card.setAttribute('aria-controls', 'archive-version-actions');
      var summary = node('span', 'connection-summary');
      var description = node('span', 'item-sub', time(version.createdAt));
      description.title = '备份时间：' + description.textContent + ' · 来源客户端：' + version.sourceClientId;
      summary.append(node('span', 'item-title', version.id), description);
      card.append(summary, node('span', 'badge' + (version.syncable ? ' on' : ''), version.syncable ? '可同步' : '备份'));
      cards.appendChild(card);
    });
    if (!versions.length) cards.appendChild(node('div', 'placeholder', latest.error || (!bucket
      ? '暂时无法读取版本，请检查此连接的状态'
      : !latest.versions ? '正在读取备份版本…' : '暂无备份版本，请先关闭抽屉并点击「立即备份」')));
    replaceCards(element('versions-list'), cards);
  }
  function closeVersionsDrawer() {
    if (versionsOpen) return drawerApi.closeDrawer();
  }
  function handleDrawerClosed() {
    if (!versionsOpen) return;
    versionsOpen = false;
    statusSequence += 1;
    latest.versions = null;
    element('versions-host').append(element('versions-content'), element('versions-close'));
    selectedVersionId = null; element('version-actions').hidden = true;
    element('versions').setAttribute('aria-expanded', 'false');
    if (editorOpen && !element('versions').disabled) element('versions').focus({ preventScroll: true });
  }
  function setEditorOpen(open) {
    editorOpen = open && !!connection();
    element('connection-editor').classList.toggle('hidden', !editorOpen);
    setText('editor-title', '备份配置' + (connection() ? ' · ' + (connection().alias || connection().url) : ''));
    renderConnections();
    if (editorOpen) element('connection-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    else {
      var card = Array.from(element('connections-list').children).find(function (item) { return item.dataset.id === selectedConnectionId; });
      if (card) { card.focus({ preventScroll: true }); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
    controls();
  }
  function discardConnectionDraft() {
    if (connectionDirty && !window.confirm('此连接有未保存的备份配置，是否放弃修改？')) return false;
    connectionDirty = false;
    return true;
  }
  function validateBucketName() {
    var input = element('bucket');
    input.setCustomValidity(!input.value ? '请填写桶名'
      : input.validity.patternMismatch ? '桶名须为 1–80 个字符，以英文字母或数字开头，仅允许英文字母、数字、下划线和连字符，不允许中文'
      : ['constructor', 'prototype'].includes(input.value) ? '此桶名为保留名称，请更换'
      : '');
  }
  function renderPolicy(target) {
    var client = latest && latest.selectedConnectionId === selectedConnectionId && latest.archive && target
      ? latest.archive.clients.find(function (item) { return item.id === latest.clientId && item.bucketId === target.bucketId; }) : null;
    var interval = target && target.backupIntervalMinutes !== undefined ? target.backupIntervalMinutes
      : client ? client.backupIntervalMinutes : 60;
    element('bucket').value = target ? target.bucketId : 'default';
    validateBucketName();
    element('auto-backup').checked = !!target && target.backup && interval !== 0;
    element('interval').value = interval || 60;
    element('retain').value = target && target.retainCount || client && client.retainCount || 20;
  }
  function renderIdentity() {
    var current = connection() || {};
    [['log-client-name', latest.clientName, '未设置'], ['log-client-id', latest.clientId, '尚未生成'],
      ['log-server-name', current.serverName, '待连接'], ['log-server-id', current.serverId, '尚未配对']].forEach(function (item) {
      var button = element(item[0]); setText(item[0], item[1] || item[2]); button.dataset.copyValue = item[1] || ''; button.title = item[1] || '';
    });
    setText('log-bucket', latest.target && latest.target.connectionId === selectedConnectionId ? '桶 ' + latest.target.bucketId : '');
    element('log-identity').title = [current.alias, current.url].filter(Boolean).join(' · ');
  }
  function renderLogs(operations, automatic) {
    var target = automatic ? { connectionId: latest.settings.syncConnectionId } : latest.target;
    var entries = (operations || []).filter(function (item) {
      return target && item.clientId === latest.clientId
        && (automatic || !cleared.has(target.connectionId + ':' + item.id));
    }).sort(function (a, b) { return (a.completedAt || a.createdAt) - (b.completedAt || b.createdAt); });
    var signature = JSON.stringify([target, entries, automatic && latest.syncError]);
    if (signature === (automatic ? autoLogSignature : logSignature)) return;
    if (automatic) autoLogSignature = signature; else logSignature = signature;
    var viewport = element(automatic ? 'auto-log-list' : 'log-list'), follow = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8;
    var rows = document.createDocumentFragment();
    entries.forEach(function (operation) {
      var warnings = operation.warnings || [];
      var level = operation.status === 'failed' ? 'error' : operation.status === 'interrupted' || warnings.length ? 'warn' : 'info';
      var row = node('div', 'mcp-log-entry mcp-log-' + (operation.status === 'complete' && !warnings.length ? 'success' : level));
      var text = (operation.kind === 'apply' ? 'sync' : 'backup') + ' ' + (operation.status === 'complete' ? 'completed' : operation.status)
        + ' trigger=' + operation.reason + ' bucket=' + operation.bucketId;
      if (operation.versionId) text += ' version=' + operation.versionId;
      if (operation.backupVersionId) text += ' backup=' + (operation.backupBucketId || operation.bucketId) + '/' + operation.backupVersionId;
      if (warnings.length) text += ' warnings=' + warnings.length;
      text += ' operation=' + operation.id;
      if (operation.error) text += ' error=' + (/^[A-Z_]+$/.test(operation.errorCode || '') ? operation.errorCode : 'OPERATION_FAILED');
      row.append(node('span', 'mcp-log-time', time(operation.completedAt || operation.createdAt)), document.createTextNode(' '),
        node('span', 'mcp-log-level', level), document.createTextNode(' '), node('span', 'mcp-log-message', text));
      if (operation.error || warnings.length) row.appendChild(node('span', 'mcp-log-detail', ' ' + [operation.error].concat(warnings).filter(Boolean).join('；')));
      if (!automatic && ['failed', 'interrupted'].includes(operation.status)) {
        var retry = node('button', 'btn-small', 'Retry'); retry.type = 'button'; retry.dataset.retry = operation.id;
        retry.addEventListener('click', function () { run(function () { return operate('retry', { operationId: operation.id }); }); });
        row.appendChild(retry);
      }
      rows.appendChild(row);
    });
    if (automatic && latest.syncError) rows.appendChild(node('div', 'mcp-log-empty', latest.syncError));
    else if (!entries.length) rows.appendChild(node('div', 'mcp-log-empty', '暂无日志'));
    element(automatic ? 'auto-operations' : 'operations').replaceChildren(rows);
    if (follow) viewport.scrollTop = viewport.scrollHeight;
  }
  function render(value) {
    latest = value; panel.hidden = false; autoPanel.hidden = false;
    root.hidden = false; autoRoot.hidden = false;
    if (selectedConnectionId && selectedConnectionId !== value.selectedConnectionId) {
      closeVersionsDrawer(); editorOpen = false; connectionDirty = false;
    }
    selectedConnectionId = value.selectedConnectionId || null;
    var changed = renderedConnectionId !== selectedConnectionId;
    var current = connection(), source = value.settings.syncConnectionId;
    element('connection-editor').classList.toggle('hidden', !editorOpen);
    setText('editor-title', '备份配置' + (current ? ' · ' + (current.alias || current.url) : ''));
    renderConnections();
    if (!autoDirty) {
      element('auto-sync').checked = value.autoSyncAvailable && value.settings.autoSyncEnabled !== false;
      selectedSourceId = source || null;
    }
    renderSources();
    var reason = value.settings.autoSyncDisabledReason || value.sourceCompatibility && value.sourceCompatibility.reason;
    var summary = !value.autoSyncAvailable ? '当前环境不支持自动同步；可通过对应连接的「备份版本」手动同步。'
      : !value.environmentAllowsSync ? '当前运行设置禁止自动同步。'
      : value.settings.autoSyncDisabledReason ? '自动同步已关闭：' + (incompatibility[reason] || reason)
      : value.settings.autoSyncEnabled === false ? '自动同步已关闭，仍可手动同步。'
      : !value.syncVersion ? '未指定自动同步版本。'
      : !source ? '请选择一个已开启的连接作为同步源。'
      : reason ? incompatibility[reason] || reason
      : '自动同步版本：' + value.syncVersion + '，下次启动时加载。';
    if (value.syncTarget) {
      var sourceConnection = value.connections.find(function (item) { return item.id === value.syncTarget.connectionId; });
      summary = '启动同步目标：' + (sourceConnection ? sourceConnection.alias || sourceConnection.url : value.syncTarget.connectionId)
        + ' / 桶 ' + value.syncTarget.bucketId + ' / ' + value.syncVersion + '。由容器启动设置管理。' + summary;
    }
    if (value.recoveryPending) summary += ' 有未完成的同步，可到对应连接的日志中重试；不阻断其他任务。';
    if (selectedSourceId && !value.connections.some(function (item) { return item.id === selectedSourceId; })) summary += ' 原同步源连接已删除，请重新选择。';
    setText('summary', summary);
    var negotiation = value.compatibility;
    setText('connection-status', !current ? '请先在上方添加服务端连接。'
      : current.url + ' · ' + (negotiation && negotiation.compatible === true ? '版本兼容' : incompatibility[negotiation && negotiation.reason] || '等待协商')
        + (negotiation ? ' · 当前版本 ' + negotiation.clientVersion + ' / 服务端版本 ' + (negotiation.serverVersion || '未知') : ''));
    bucket = value.archive && value.target ? value.archive.buckets.find(function (item) { return item.id === value.target.bucketId; }) : null;
    if (!connectionDirty) renderPolicy(value.target);
    var description = value.error || (!value.target ? '请先保存此连接的备份配置，再使用自动备份或立即备份。'
      : !value.archive ? '连接就绪且版本兼容后可读取备份版本。'
      : !bucket ? '暂时无法读取此连接的备份桶。'
      : '');
    setText('description', description); element('description').hidden = !description;
    if (changed) selectedVersionId = null;
    if (versionsOpen) renderVersions();
    renderedConnectionId = selectedConnectionId;
    renderIdentity(); renderLogs(value.archive ? value.archive.operations : []); renderLogs(value.syncOperations || [], true); controls();
  }
  function isEditing() {
    return (root.contains(document.activeElement) || autoRoot.contains(document.activeElement))
      && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
  }
  async function reload(quiet) {
    var sequence = ++statusSequence;
    try {
      var value = await control('status', { includeVersions: versionsOpen });
      if (sequence !== statusSequence || quiet && (busy || isEditing())) return;
      render(value);
    } catch (error) {
      if (sequence === statusSequence && (!quiet || !busy && !isEditing())) {
        if (versionsOpen && latest) {
          latest.error = error.message; latest.versions = null;
          renderVersions(); controls();
        }
        throw error;
      }
    }
  }
  async function run(action, scope) {
    if (busy) return;
    // Explicit actions supersede any status request already in flight.
    statusSequence += 1;
    busy = true; message('', scope); controls();
    try { await action(); } catch (error) { message(error.message, scope); }
    finally { busy = false; controls(); }
  }
  async function save(settings) {
    settings.targets = settings.targets.filter(function (target) { return latest.connections.some(function (item) { return item.id === target.connectionId; }); });
    if (!settings.targets.some(function (item) { return item.connectionId === settings.syncConnectionId; })) settings.syncConnectionId = null;
    var result = await control('settings', { settings: settings });
    return result.warning;
  }
  async function operate(action, values) {
    var operation = await control(action, values), deadline = Date.now() + 190000;
    while (true) {
      var operations = latest.archive ? latest.archive.operations.filter(function (item) { return item.id !== operation.id; }) : [];
      renderLogs(operations.concat(operation)); controls();
      if (!['pending', 'running'].includes(operation.status) || Date.now() >= deadline) break;
      message(operation.kind === 'backup' ? '正在备份…' : '正在同步…');
      await new Promise(function (resolve) { setTimeout(resolve, 1500); });
      operation = await control('operation', { operationId: operation.id });
    }
    await reload();
    if (operation.status !== 'complete') throw new Error(operation.error || '操作尚未完成，请在日志中查看后续结果。');
    if (operation.warnings && operation.warnings.length) { message('同步完成，存在告警：' + operation.warnings.join('；')); return; }
    message('操作完成');
  }
  element('auto-sync').addEventListener('change', function () { autoDirty = true; controls(); });
  element('sources-list').addEventListener('click', function (event) {
    var card = event.target.closest('.archive-source-card');
    if (!card || event.target.closest('button,input')) return;
    var radio = card.querySelector('input');
    if (!radio.disabled) { radio.click(); radio.focus({ preventScroll: true }); }
  });
  element('sources-list').addEventListener('change', function (event) {
    var radio = event.target;
    if (!radio.matches('input[type="radio"]') || radio.disabled || !radio.checked) return;
    selectedSourceId = radio.value; autoDirty = true; controls();
  });
  ['bucket', 'auto-backup', 'interval', 'retain'].forEach(function (id) { element(id).addEventListener('input', function () {
    if (id === 'bucket') validateBucketName();
    connectionDirty = true; controls();
  }); });
  element('save-auto').addEventListener('click', function () {
    run(async function () {
      var settings = JSON.parse(JSON.stringify(latest.settings));
      settings.autoSyncEnabled = element('auto-sync').checked; settings.syncConnectionId = selectedSourceId;
      var source = latest.connections.find(function (item) { return item.id === selectedSourceId; });
      if (settings.autoSyncEnabled && (!source || !source.enabled || !source.arpPermissions.read || !source.arpPermissions.write)) {
        throw new Error('请选择一个已开启且允许读取和写入的连接作为同步源');
      }
      if (settings.syncConnectionId && !settings.targets.some(function (item) { return item.connectionId === settings.syncConnectionId; })) {
        settings.targets.push({ connectionId: settings.syncConnectionId, bucketId: 'default', backup: false });
      }
      var warning = await save(settings); autoDirty = false; await reload(); message(warning || '自动同步设置已保存', 'auto');
    }, 'auto');
  });
  element('save').addEventListener('click', function () {
    validateBucketName();
    if (!['bucket', 'interval', 'retain'].every(function (id) { return element(id).reportValidity(); })) return;
    run(async function () {
      var settings = JSON.parse(JSON.stringify(latest.settings));
      settings.targets = settings.targets.filter(function (item) { return item.connectionId !== selectedConnectionId; });
      settings.targets.push({ connectionId: selectedConnectionId, bucketId: element('bucket').value.trim(), backup: element('auto-backup').checked,
        backupIntervalMinutes: Number(element('interval').value) || 60, retainCount: Number(element('retain').value) });
      var warning = await save(settings); connectionDirty = false; await reload(); message(warning || '此连接配置已保存');
    });
  });
  element('connections-list').addEventListener('click', function (event) {
    var card = event.target.closest('.archive-connection-card');
    if (!card || event.target.closest('button') || busy || !latest || !discardConnectionDraft()) return;
    if (editorOpen && selectedConnectionId === card.dataset.id) { setEditorOpen(false); return; }
    selectedConnectionId = card.dataset.id; bucket = null; logSignature = ''; renderedConnectionId = null; selectedVersionId = null;
    renderPolicy(latest.settings.targets.find(function (item) { return item.connectionId === selectedConnectionId; }));
    element('operations').replaceChildren(node('div', 'mcp-log-empty', 'Loading events...'));
    element('connection-status').textContent = '';
    element('description').textContent = '正在读取此连接…';
    element('description').hidden = false;
    renderIdentity(); setEditorOpen(true);
    run(reload).then(function () {
      if (editorOpen && !element('bucket').disabled) element('bucket').focus({ preventScroll: true });
    });
  });
  element('cancel').addEventListener('click', function () {
    if (busy || !discardConnectionDraft()) return;
    setEditorOpen(false);
  });
  element('create-version').addEventListener('click', function () { run(function () { return operate('backup'); }); });
  element('versions').addEventListener('click', async function () {
    if (!drawerApi || busy || element('versions').disabled) return;
    if (document.getElementById('drawer').classList.contains('active') && !await drawerApi.closeDrawer()) return;
    if (busy || element('versions').disabled) return;
    document.getElementById('drawer-content').replaceChildren(element('versions-content'));
    document.getElementById('drawer-actions').replaceChildren(element('versions-close'));
    versionsOpen = true;
    latest.versions = null; delete latest.error;
    selectedVersionId = null; message(''); renderVersions(); controls();
    drawerApi.openDrawer(); element('versions').setAttribute('aria-expanded', 'true');
    element('versions-close').focus({ preventScroll: true });
    try { await reload(); } catch (error) { message(error.message); }
    if (versionsOpen && document.activeElement === element('versions-close')) {
      var first = element('versions-list').querySelector('.item-card');
      if (first) first.focus({ preventScroll: true });
    }
  });
  document.getElementById('drawer').addEventListener('keydown', function (event) {
    if (!versionsOpen || event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); closeVersionsDrawer();
  });
  element('versions-list').addEventListener('click', function (event) {
    var card = event.target.closest('.archive-version-card');
    if (!card || busy) return;
    selectedVersionId = selectedVersionId === card.dataset.id ? null : card.dataset.id;
    renderVersions(); controls();
    if (selectedVersionId) element('version-actions').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  element('apply').addEventListener('click', function () {
    var versionId = selectedVersionId;
    if (!window.confirm('将从「' + connection().alias + '」同步 ' + versionId + '，覆盖本地配置。'
      + (connection().arpPermissions.delete ? '版本中不存在的可写配置会被删除。' : '未开放删除权限，将保留版本之外的本地配置。')
      + '缺失的助手 Skill/MCP 引用会跳过并记录告警。同步前会先备份。继续？')) return;
    run(function () { return operate('apply', { versionId: versionId }); });
  });
  element('syncable').addEventListener('click', function () { run(async function () {
    var version = latest.versions.items.find(function (item) { return item.id === selectedVersionId; });
    var syncable = !version.syncable;
    await control('syncable', { versionId: version.id, syncable: syncable, revision: bucket.revision });
    await reload(); message(syncable ? '已标记为可同步' : '已取消可同步');
  }); });
  ['reload', 'log-reload'].forEach(function (id) { element(id).addEventListener('click', function () { run(reload); }); });
  element('log-clear').addEventListener('click', function () {
    if (!latest.target || !latest.archive) return;
    latest.archive.operations.forEach(function (item) { if (item.clientId === latest.clientId && item.status === 'complete') cleared.add(selectedConnectionId + ':' + item.id); });
    renderLogs(latest.archive.operations); controls();
  });
  element('log-identity').addEventListener('click', function (event) {
    var button = event.target.closest('.mcp-log-copy');
    if (button && !button.disabled && button.dataset.copyValue) navigator.clipboard.writeText(button.dataset.copyValue)
      .then(function () { message('已复制'); }, function () { message('复制失败，请手动选中复制'); });
  });
  async function poll() {
    if (!busy && !document.hidden && document.getElementById('section-mcp').offsetParent && !isEditing()) {
      try { await reload(true); } catch (error) { message(error.message); }
    }
    window.setTimeout(poll, 5000);
  }
  globalThis.OptionsArchive = {
    init: function (options) { drawerApi = options; },
    handleDrawerClosed: handleDrawerClosed,
  };
  panel.hidden = false; autoPanel.hidden = false;
  run(reload).then(function () { window.setTimeout(poll, 5000); });
})();
