(function (root) {
  'use strict';

  var activePanel = null;

  function init(options) {
    var form = document.getElementById('mail-settings-form');
    if (!form) return;
    var settings = root.PageAgentMailSettings;
    var fields = document.getElementById('mail-settings-fields');
    var status = document.getElementById('mail-settings-status');
    var connectionCard = document.getElementById('mail-connection-card');
    var savedConfig = null;
    var busy = false;
    var mailEnabled = true;
    var mailReady = false;
    var connectionText = '正在读取状态…';
    var statusLoading = false;
    var availableConnections = [];
    var testResult = { message: '', error: false };
    var keys = { connectionId: 'connection-id', host: 'host', port: 'port', security: 'security', username: 'username', password: 'password', from: 'from', fromName: 'from-name' };
    async function refreshConnections() {
      var response = await chrome.runtime.sendMessage({ type: 'ARP_RESOURCE_REQUEST', payload: { method: 'GET', request: { uri: '/connections?limit=100' } } });
      var envelope = response && (response.payload || response.envelope || response.result);
      var items = envelope && envelope.primary && envelope.primary.data && envelope.primary.data.items || [];
      availableConnections = items;
      var select = input('connection-id'), selected = select.value;
      select.replaceChildren(new Option('请选择明确的连接', ''));
      items.forEach(function (connection) { select.add(new Option(connection.alias + ' · ' + connection.state, connection.id)); });
      if (selected && !items.some(function (item) { return item.id === selected; })) select.add(new Option('已失效的连接 · ' + selected, selected));
      select.value = selected;
      updateSelectedStatus();
    }

    function updateSelectedStatus() {
      var connection = availableConnections.find(function (item) { return item.id === input('connection-id').value; });
      mailReady = !!(connection && connection.ready && connection.capabilities && connection.capabilities.mail.supported && connection.capabilities.audit.available);
      connectionText = connection ? connection.alias + ' · ' + (mailReady ? '已就绪' : connection.reason || connection.state) : '请选择可用的邮件服务端';
      syncControls();
    }

    function input(id) { return document.getElementById('mail-' + id); }
    function showStatus(message, error, target) {
      target = target || status;
      target.textContent = message;
      target.classList.toggle('mail-error', error === true);
    }
    function renderConnectionSummary() {
      if (!savedConfig) return;
      var connection = availableConnections.find(function (item) { return item.id === savedConfig.connectionId; });
      var ready = !!(connection && connection.ready && connection.capabilities && connection.capabilities.mail.supported && connection.capabilities.audit.available);
      var configured = !!(savedConfig.host && savedConfig.from && savedConfig.connectionId);
      var title = savedConfig.host ? savedConfig.host + ':' + savedConfig.port : 'SMTP 服务器';
      var description = savedConfig.host
        ? (savedConfig.security === 'starttls' ? 'STARTTLS' : 'TLS') + ' · ' + (connection ? connection.alias : '未连接服务端')
        : '尚未配置发件账户';
      var from = savedConfig.from || '未设置发件邮箱';
      input('summary-title').textContent = input('summary-title').title = title;
      input('summary-description').textContent = input('summary-description').title = description;
      input('summary-from').textContent = input('summary-from').title = from;
      input('summary-status').textContent = !savedConfig.enabled ? '已关闭' : !configured ? '未配置' : ready ? '已配置' : '待连接';
      input('summary-status').classList.toggle('on', savedConfig.enabled && configured && ready);
    }
    function setEditorOpen(open) {
      form.classList.toggle('hidden', !open);
      connectionCard.classList.toggle('selected', open);
      connectionCard.setAttribute('aria-expanded', String(open));
      if (open) options.scrollOpenedEditor(form);
      else {
        connectionCard.focus({ preventScroll: true });
        connectionCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    options.lifecycle.listen(connectionCard, 'click', async function () {
      if (busy) return;
      if (!form.classList.contains('hidden')) {
        if (isDirty() && !await options.confirm('有未保存的修改，是否放弃？')) return;
        render(savedConfig);
      }
      setEditorOpen(form.classList.contains('hidden'));
    });

    function isDirty() {
      return !!savedConfig && Object.keys(keys).some(function (key) {
        return String(input(keys[key]).value) !== String(savedConfig[key] == null ? '' : savedConfig[key]);
      });
    }

    activePanel = {
      getState: function () { return { dirty: isDirty(), busy: busy }; },
      discard: function () { if (savedConfig) render(savedConfig); setEditorOpen(false); },
    };
    function syncControls() {
      fields.disabled = busy;
      connectionCard.disabled = busy;
      input('save-settings').disabled = busy;
      input('enabled').checked = mailEnabled;
      input('enabled').disabled = busy;
      input('test-open').disabled = busy || !mailEnabled || !mailReady;
      var testFields = input('test-fields');
      var testSend = input('test-send');
      if (testFields) testFields.disabled = busy;
      if (testSend) testSend.disabled = busy || !mailEnabled || !mailReady;
      input('connection-status').textContent = mailEnabled ? connectionText : '已关闭';
      var testConnectionStatus = input('test-connection-status');
      if (testConnectionStatus) testConnectionStatus.textContent = input('connection-status').textContent;
      renderConnectionSummary();
    }
    function setBusy(value) {
      busy = value;
      syncControls();
    }
    async function refreshConnectionStatus() {
      if (statusLoading) return;
      statusLoading = true;
      try {
        await refreshConnections();
      } catch (_) {
        availableConnections = [];
        mailReady = false;
        connectionText = '状态读取失败，请刷新页面后重试';
      } finally {
        statusLoading = false;
        syncControls();
      }
    }
    function readConfig() {
      var config = { enabled: mailEnabled };
      Object.keys(keys).forEach(function (key) { config[key] = input(keys[key]).value; });
      return settings.validate(config);
    }
    function render(config, enabledOnly) {
      config = settings.normalize(config);
      savedConfig = config;
      mailEnabled = config.enabled;
      if (!enabledOnly) {
        if (config.connectionId && !Array.from(input('connection-id').options).some(function (option) { return option.value === config.connectionId; })) input('connection-id').add(new Option(config.connectionId, config.connectionId));
        Object.keys(keys).forEach(function (key) { input(keys[key]).value = config[key]; });
        refreshConnections().catch(function () {});
      }
      syncControls();
    }
    options.lifecycle.subscribe(chrome.storage.onChanged, function (changes, area) {
      if (area !== 'local' || !changes[settings.SETTINGS_KEY]) return;
      var change = changes[settings.SETTINGS_KEY];
      var previous = settings.normalize(change.oldValue);
      var current = settings.normalize(change.newValue);
      // Toggling the switch must not overwrite unsaved SMTP fields.
      render(current, isDirty() || Object.keys(keys).every(function (key) { return previous[key] === current[key]; }));
    });
    async function request(type, payload) {
      var response = await chrome.runtime.sendMessage({ type: type, payload: payload });
      if (!response || response.ok !== true) throw new Error(response && response.error || '邮件操作失败');
      return response.payload;
    }
    function readFile(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('无法读取测试附件：' + file.name)); };
        reader.onload = function () {
          var dataUrl = String(reader.result || '');
          resolve({ fileName: file.name, mimeType: file.type || 'application/octet-stream', contentMode: 'base64', content: dataUrl.slice(dataUrl.indexOf(',') + 1) });
        };
        reader.readAsDataURL(file);
      });
    }

    options.lifecycle.listen(input('enabled'), 'change', async function (event) {
      if (busy) return;
      var previous = mailEnabled;
      mailEnabled = event.target.checked;
      setBusy(true);
      try {
        render(await request('MAIL_ENABLED_SET', { enabled: mailEnabled }), true);
        showStatus(mailEnabled ? '邮件通知已启用' : '邮件通知已关闭');
      } catch (error) {
        mailEnabled = previous;
        showStatus(error.message || '邮件通知开关保存失败', true);
      } finally { setBusy(false); }
    });
    options.lifecycle.listen(input('connection-id'), 'change', updateSelectedStatus);

    options.lifecycle.listen(form, 'submit', async function (event) {
      event.preventDefault();
      if (busy) return;
      var saved = false;
      try {
        var config = readConfig();
        setBusy(true);
        showStatus('正在保存邮件配置…');
        render(await request('MAIL_SETTINGS_SAVE', config));
        showStatus('邮件配置已保存，流程结束通知和邮件节点使用此账户。');
        saved = true;
      } catch (error) {
        showStatus(error.message || '邮件配置保存失败', true);
      } finally { setBusy(false); }
      if (saved) {
        setEditorOpen(false);
        options.toast('邮件服务器连接已保存');
      }
    });

    async function sendTest(event) {
      event.preventDefault();
      if (busy || !mailEnabled || !mailReady) return;
      var testForm = event.currentTarget;
      var testStatus = testForm.querySelector('#mail-test-status');
      function report(message, error) {
        testResult = { message: message, error: error === true };
        showStatus(message, error, testStatus);
      }
      try {
        var config = readConfig();
        var message = {
          to: settings.recipients(testForm.querySelector('#mail-test-to').value, '收件人'),
          cc: settings.recipients(testForm.querySelector('#mail-test-cc').value, '抄送'),
          bcc: settings.recipients(testForm.querySelector('#mail-test-bcc').value, '密送'),
          subject: 'Page Agent 邮件通知测试',
          body: '这是一封 Page Agent 测试邮件，用于验证当前 SMTP 配置和附件发送。',
        };
        if (!message.to.length && !message.cc.length && !message.bcc.length) throw new Error('请至少填写一个测试收件地址');
        var files = Array.from(testForm.querySelector('#mail-test-attachments').files || []);
        if (files.length > 20 || files.reduce(function (sum, file) { return sum + file.size; }, 0) > 20 * 1024 * 1024) {
          throw new Error('测试附件最多 20 个，总计不能超过 20MB');
        }
        setBusy(true);
        report('正在发送测试邮件…');
        message.attachments = await Promise.all(files.map(readFile));
        var result = await request('MAIL_TEST_SEND', { config: config, message: message });
        report('SMTP 已接受测试邮件，共 ' + result.acceptedCount + ' 个收件地址，请检查收件箱。Message-ID：' + result.messageId);
      } catch (error) {
        report(error.message || '测试邮件发送失败，请确认投递情况后再重试', true);
      } finally { setBusy(false); }
    }

    options.lifecycle.listen(input('test-open'), 'click', function () {
      if (busy || !mailEnabled || !mailReady || !form.reportValidity()) return;
      try { readConfig(); }
      catch (error) { showStatus(error.message, true); return; }
      document.getElementById('drawer-title').textContent = '发送测试邮件';
      document.getElementById('drawer-content').replaceChildren(input('test-template').content.cloneNode(true));
      document.getElementById('drawer-actions').innerHTML =
        '<button id="mail-test-send" type="submit" form="mail-test-form" class="btn-primary">发送测试邮件</button>'
        + '<button type="button" class="btn-secondary" data-action="cancel-drawer">关闭</button>';
      input('test-form').addEventListener('submit', sendTest);
      showStatus(testResult.message, testResult.error, input('test-status'));
      input('test-connection-status').textContent = input('connection-status').textContent;
      syncControls();
      options.openDrawer();
      input('test-to').focus();
      refreshConnectionStatus();
    });

    setBusy(true);
    refreshConnectionStatus();
    options.lifecycle.interval(function () {
      var section = document.getElementById('section-mcp');
      if (!document.hidden && section && section.classList.contains('active')) refreshConnectionStatus();
    }, 3000);
    request('MAIL_SETTINGS_GET').then(function (config) {
      render(config);
      setBusy(false);
      showStatus('');
    }).catch(function (error) {
      showStatus('邮件配置加载失败：' + error.message + '。请刷新页面后重试。', true);
      input('summary-status').textContent = '加载失败';
      setEditorOpen(true);
    });
  }

  root.OptionsMailController = Object.freeze({
    init: init,
    getState: function () { return activePanel && activePanel.getState(); },
    discard: function () { if (activePanel) activePanel.discard(); },
  });
})(globalThis);
