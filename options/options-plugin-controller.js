(function (root) {
  'use strict';
  function create(options) {
    var section = document.getElementById('section-plugins');
    var disposed = false, busy = false, dirty = false, sequence = 0, selected = null, configurationRevision = null;
    var selectedPlugin = null, pluginEditor = null, configValue = {};
    var templateSequences = new WeakMap();
    function el(tag, text, className) {
      var node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function button(text, action) {
      var node = el('button', text, 'btn-secondary'); node.type = 'button';
      node.onclick = function () { Promise.resolve().then(action).catch(fail); };
      return node;
    }
    function fail(error) { if (!disposed) options.toast(error.message || String(error), true); }
    function unwrap(response) {
      if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      return response.primary.data;
    }
    async function manage(operation, id, input, appId) {
      var response = await chrome.runtime.sendMessage({ type: 'PLUGIN_MANAGE', operation: operation, pluginId: id, input: input, appId: appId });
      if (!response) throw new Error('扩展后台未响应');
      if (response.error) throw new Error(response.error.message);
      return response.result;
    }
    var header = el('header', undefined, 'section-header'), refresh = button('刷新', render);
    var createPlugin = button('新建插件', newPlugin); createPlugin.className = 'btn-primary';
    var importPlugin = button('导入插件', async function () {
      if (!await preparePluginDrawer()) return;
      document.getElementById('file-import-config').click();
    });
    var headerActions = el('div', undefined, 'app-actions'); headerActions.append(refresh, importPlugin, createPlugin);
    header.append(el('h2', '插件管理'), headerActions);
    var status = el('p', '', 'section-desc'); status.setAttribute('role', 'status');
    var list = el('div', undefined, 'item-list item-list-compact');
    var editor = el('form', undefined, 'editor hidden'); editor.id = 'plugin-editor';
    var title = el('h3');
    var configGuide = el('details', undefined, 'reference-panel drawer-guide');
    var configGuideBody = el('div', undefined, 'drawer-guide-content');
    configGuide.append(el('summary', '插件配置说明'), configGuideBody);
    var guide = el('details', undefined, 'reference-panel drawer-guide'), guideBody = el('div', undefined, 'drawer-guide-content');
    [
      ['启停与保存', '内置插件默认启用，手动停用后会保留选择。点击「保存配置」生效。新建和复制的插件默认停用；已启用插件保存后重新加载，无需发布。'],
      ['编辑代码', '自建插件可编辑代码或通过对话调整；调整内置源码请点击「复制后修改」。'],
      ['导入导出', '使用统一备份包保存全部源码、入口、配置和权限声明；导入后停用，内置源码导入为自建副本。运行数据与话题关联不随包迁移，外部连接等依赖可在完整备份中一并选择。'],
      ['平台账号', '在「连接配置」的连接卡片点击「打开配置页」，管理平台账号、查看消息来源或设置固定回复。'],
      ['接受的账号', '选择账号后按需开启允许的指令，也可点击「全部开启」。设置适用于该账号的所有发送者和会话；未选择账号时不处理消息，未开启的指令不执行。'],
      ['消息优先级', '数值越高越先处理，同级按插件注册顺序；接管后停止分发。普通插件默认 0，平台消息默认 -100 兜底，也可调整。平台消息范围为 all，无需触发规则。'],
      ['未匹配指令', '所有插件都未接管的指令消息，默认回复未匹配提示，可选择「不回复」。仅对已选择的账号生效，不会转为自然语言对话。'],
      ['内置指令', '执行指令只输入前缀可查看资源列表，/help 查看用法。/assistant 查看助手列表，不改变选择；未匹配助手时使用默认助手，后面的全部内容用于对话。'],
      ['资源查询', '/list 查看所有资源分类；/list flow 关键词 --page 2 搜索并翻页；/info app 应用名 查看启动参数和动作，/info plugin 插件ID 能力ID 查看能力参数。'],
      ['会话查询', '/status 查看当前助手、模型、上下文占用、会话及回传状态；/history 查看最近消息，返回的 --before 指令可继续查看更早消息。查询不会启动新对话。'],
      ['任务查询', '/list run 查看运行记录；/run 任务ID 查看结果；/cancel 任务ID 请求取消。省略任务 ID 使用当前消息来源最近启动的任务；/stop 用于取消助手执行。'],
      ['自然语言', '直接发送消息继续当前对话；使用 /assistant 助手名 选择助手，未选择时使用默认助手。助手沿用已有模型和权限，不同消息来源的会话独立。'],
      ['扩展行为', '需要额外指令或消息处理逻辑时，编写独立插件并订阅消息。'],
      ['触发流程', '/flow 流程名 参数 将参数文本放入 context.input，分词参数放入 context.args；context.message 包含原始消息，可使用「发送平台消息」节点回复来源。'],
      ['触发对话', '同一消息来源和助手会延续同一会话；执行中发送消息可补充指令，助手提问时可直接回复答案或选项编号。'],
      ['消息回传', '直接处理模型响应和工具事件，与界面复用转换。正文完成后分段发送到原私聊或群聊，工具状态、提问及失败或取消提示及时回传。每轮结束附加“助手名称 · 模型 · ctx 占用”；邮件仅发送完整回答、提问和结束状态。'],
      ['会话指令', '/stop 取消当前执行；/new 清除助手和会话选择，下一条消息使用默认助手开始新会话；/help 查看帮助。'],
    ].forEach(function (entry) {
      var paragraph = el('p'); paragraph.append(el('b', entry[0] + '：'), entry[1]); guideBody.append(paragraph);
    });
    guide.append(el('summary', '平台消息配置说明'), guideBody);
    var enabled = el('input'); enabled.type = 'checkbox'; enabled.id = 'plugin-enabled'; enabled.setAttribute('role', 'switch');
    var enableLabel = el('label', undefined, 'switch-label'), slider = el('span', undefined, 'switch-slider');
    slider.setAttribute('aria-hidden', 'true'); enableLabel.append(enabled, slider, el('span', '启用插件', 'switch-text'));
    var settings = el('div', undefined, 'form-row form-row-spaced'); settings.append(enableLabel);
    var priority = el('input'); priority.type = 'number'; priority.step = '1'; priority.required = true;
    priority.min = String(Number.MIN_SAFE_INTEGER); priority.max = String(Number.MAX_SAFE_INTEGER);
    var priorityRow = field('消息处理优先级', priority, 'plugin-priority');
    var priorityHelp = el('p');
    priorityHelp.append(el('b', '消息处理优先级：'), '数值越高越先处理，同级按插件注册顺序；接管后停止分发。普通插件默认 0，平台消息默认 -100，可调整。');
    priorityHelp.id = 'plugin-priority-help'; priority.setAttribute('aria-describedby', priorityHelp.id);
    var messagingInfo = el('p', '处理范围为 all，默认低优先级兜底；提高优先级后可先于其他插件处理。直接发送 /help 查看内置指令；额外行为请编写独立插件。'); messagingInfo.hidden = true;
    var configFields = el('fieldset', undefined, 'plugin-config-fields'); configFields.hidden = true;
    var errorText = el('p', undefined, 'form-help plugin-error'); errorText.setAttribute('role', 'status');
    var save = el('button', '保存配置', 'btn-primary'); save.type = 'submit';
    var cancel = button('取消', discard), actions = el('div', undefined, 'editor-actions');
    var removePlugin = button('删除', async function () {
      if (busy || dirty || pluginEditor || !selectedPlugin || selectedPlugin.source !== 'user') return;
      var item = selectedPlugin, revision = configurationRevision;
      busy = true; lock();
      try {
        if (!await options.confirm('删除插件“' + item.name + '”？其能力和订阅将被释放。') || disposed) return;
        unwrap(await options.resourceClient.delete('/plugins/' + encodeURIComponent(item.id), {
          body: { revision: revision }, idempotencyKey: crypto.randomUUID(),
        }));
        if (disposed) return;
        discard();
        options.toast('插件已删除'); await render();
      } finally { busy = false; lock(); }
    });
    removePlugin.className = 'btn-danger'; removePlugin.hidden = true;
    var converse = button('对话调整', function () { return options.converse(selectedPlugin.id); });
    var editSource = button('编辑代码', function () { return editPluginSource(selectedPlugin.id); });
    var copySource = button('复制后修改', copyPlugin);
    var exportSource = button('导出插件', async function () {
      if (busy || dirty || !selectedPlugin) return;
      busy = true; lock();
      try { await options.exportPlugin(selectedPlugin.id); options.toast('插件已导出'); }
      finally { busy = false; lock(); }
    });
    actions.append(save, cancel, removePlugin, el('span', undefined, 'spacer'), converse, editSource, copySource, exportSource);
    editor.append(title, configGuide, settings, priorityRow, configFields, errorText, actions);
    var templates = el('div');
    section.append(header, guide, status, list, editor, templates);
    var labels = { active: '运行中', disabled: '已停用', pending: '等待依赖', loading: '启动中', failed: '异常' };
    function lock() {
      section.setAttribute('aria-busy', String(busy));
      list.querySelectorAll('.item-card').forEach(function (card) {
        var active = card.dataset.pluginId === selected;
        card.classList.toggle('selected', active);
        card.setAttribute('aria-expanded', String(active));
        card.setAttribute('aria-disabled', String(busy || dirty || !!pluginEditor));
      });
      list.querySelectorAll('button').forEach(function (node) { node.disabled = busy || dirty || !!pluginEditor; });
      editor.setAttribute('aria-busy', String(busy));
      enabled.disabled = priority.disabled = save.disabled = cancel.disabled = busy || !!pluginEditor;
      configFields.disabled = busy || !!pluginEditor;
      removePlugin.disabled = editSource.disabled = converse.disabled = copySource.disabled = exportSource.disabled = busy || dirty || !!pluginEditor || !selectedPlugin;
      refresh.disabled = busy;
      createPlugin.disabled = importPlugin.disabled = busy || dirty;
      if (pluginEditor) {
        pluginEditor.container.setAttribute('aria-busy', String(busy));
        pluginEditor.container.querySelectorAll('input, select, textarea, button, page-code-editor').forEach(function (node) { node.disabled = busy; });
        pluginEditor.controls.forEach(function (node) { node.disabled = busy; });
      }
    }
    function edited() { dirty = true; lock(); }
    enabled.onchange = edited;
    priority.oninput = edited;
    function discard() {
      selected = null; configurationRevision = null; dirty = false;
      selectedPlugin = null;
      configValue = {}; configFields.replaceChildren(); configFields.hidden = true;
      editor.classList.add('hidden');
      errorText.textContent = ''; lock();
    }
    async function confirmDrawerClose(discard) {
      var current = pluginEditor;
      if (!current) return true;
      if (busy) return false;
      return discard === true || !current.dirty || await options.confirm('有未保存的修改，是否放弃？');
    }
    function handleDrawerClosed() {
      var current = pluginEditor;
      if (!current) return;
      var trigger = current.trigger;
      current.container.remove(); pluginEditor = null; lock();
      if (!disposed) (trigger && trigger.isConnected && trigger.getClientRects().length ? trigger : createPlugin).focus({ preventScroll: true });
    }
    async function preparePluginDrawer() {
      if (disposed || busy || dirty) return false;
      if (document.getElementById('drawer').classList.contains('active') && !await options.closeDrawer()) return false;
      discard();
      return !disposed;
    }
    function field(labelText, input, id) {
      var row = el('div', undefined, 'form-row'), label = el('label', labelText);
      input.id = id; label.htmlFor = id; row.append(label, input); return row;
    }
    function renderConfiguration(item) {
      configValue = item.config;
      configFields.replaceChildren();
      configGuide.open = false;
      configGuideBody.replaceChildren();
      if (item.description) configGuideBody.append(el('p', item.description));
      configGuideBody.append(priorityHelp, messagingInfo);
      var schema = item.configSchema || {}, fieldSequence = 0, helpSequence = 0, helpIds = new WeakMap();
      function describeFields(definition, path) {
        if (!definition || typeof definition !== 'object') return;
        if (definition.description) {
          var note = el('p'); note.id = 'plugin-config-help-' + (++helpSequence);
          note.append(el('b', (path || definition.title || '插件配置') + '：'), definition.description);
          configGuideBody.append(note); helpIds.set(definition, note.id);
        }
        Object.keys(definition.properties || {}).forEach(function (key) {
          var child = definition.properties[key], label = child && child.title || key;
          describeFields(child, path ? path + ' / ' + label : label);
        });
        if (definition.items && !Array.isArray(definition.items)) describeFields(definition.items, path);
      }
      describeFields(schema, '');
      var hasFields = Object.keys(schema.properties || {}).length > 0;
      configFields.hidden = !hasFields && !Object.keys(configValue).length;
      if (configFields.hidden) return;
      configFields.append(el('legend', schema.title || '插件配置'));
      if (!hasFields) {
        configFields.append(el('p', '插件作者尚未声明配置项，请通过「编辑代码」或「对话调整」补充配置表单。', 'form-help'));
        return;
      }
      function objectFields(container, definition, value, write) {
        Object.keys(definition.properties || {}).forEach(function (key) {
          var present = value && Object.prototype.hasOwnProperty.call(value, key);
          configField(container, key, definition.properties[key], present ? value[key] : undefined,
            (definition.required || []).includes(key), function (next) {
              value = Object.assign(Object.create(null), value);
              if (next === undefined) delete value[key]; else value[key] = next;
              write(value);
            });
        });
      }
      function messageAccounts(group, definition, value, write, id) {
        var commandDefinition = definition.items.properties.commands, commands = commandDefinition.items.enum;
        var commandHelpId = helpIds.get(commandDefinition);
        var values = [], accounts = [], loading = false;
        function key(account) { return JSON.stringify([account.connectionId, account.accountId]); }
        (Array.isArray(value) ? value : []).forEach(function (entry) {
          var existing = values.find(function (account) { return key(account) === key(entry); });
          if (!existing) {
            existing = { connectionId: entry.connectionId, accountId: entry.accountId, commands: [] }; values.push(existing);
          }
          existing.commands = commands.filter(function (command) {
            return existing.commands.includes(command) || (entry.commands || []).includes(command);
          });
        });
        var entries = el('div'), picker = el('select'), note = el('p', '', 'form-help');
        note.setAttribute('role', 'status');
        var reload = button('刷新账号', loadAccounts);
        group.append(entries, field('添加账号', picker, id + '-account'), reload, note);
        function accountName(account) {
          return (account.name || account.accountId) + ' · ' + account.platform + ' · ' + account.connectionName;
        }
        function showAccounts() {
          entries.replaceChildren(); picker.replaceChildren();
          if (!values.length) entries.append(el('p', '尚未选择账号。', 'form-help'));
          values.forEach(function (entry, index) {
            var account = accounts.find(function (account) { return key(account) === key(entry); });
            var card = el('fieldset', undefined, 'plugin-config-group plugin-config-entry');
            card.append(el('legend', account ? accountName(account)
              : '账号 ' + entry.accountId + ' · ' + entry.connectionId, 'plugin-account-name'));
            if (!account) card.append(el('p', loading ? '正在读取账号信息…' : '账号暂不可用，已保留选择。', 'form-help'));
            var switches = el('div', undefined, 'plugin-command-switches'), inputs = [];
            var allOn = button('全部开启', function () {
              entry.commands = commands.slice();
              inputs.forEach(function (input) { input.checked = true; });
              write(values); allOn.disabled = true;
            });
            allOn.disabled = commands.every(function (command) { return entry.commands.includes(command); });
            var remove = button('移除账号', function () {
              values = values.filter(function (_, position) { return position !== index; }); write(values); showAccounts();
            });
            remove.disabled = values.length <= (definition.minItems || 0);
            var actions = el('div', undefined, 'app-actions'); actions.append(allOn, remove);
            card.append(el('b', commandDefinition.title || '允许的指令'), actions, switches);
            commands.forEach(function (command) {
              var input = el('input'); input.type = 'checkbox'; input.checked = entry.commands.includes(command);
              input.setAttribute('role', 'switch'); inputs.push(input);
              if (commandHelpId) input.setAttribute('aria-describedby', commandHelpId);
              var label = el('label', undefined, 'switch-label'), slider = el('span', undefined, 'switch-slider');
              slider.setAttribute('aria-hidden', 'true');
              label.append(input, slider, el('span', command === 'chat' ? '自然语言对话' : '/' + command, 'switch-text'));
              input.onchange = function () {
                entry.commands = commands.filter(function (_, position) { return inputs[position].checked; });
                write(values); allOn.disabled = inputs.every(function (input) { return input.checked; });
              };
              switches.append(label);
            });
            entries.append(card);
          });
          var available = accounts.filter(function (account) { return !values.some(function (entry) { return key(entry) === key(account); }); });
          var placeholder = el('option', loading ? '正在读取账号…' : available.length ? '请选择账号' : '暂无可添加的账号');
          placeholder.value = ''; picker.append(placeholder);
          available.forEach(function (account) {
            var option = el('option', accountName(account)); option.value = key(account); picker.append(option);
          });
          picker.disabled = loading || !available.length || definition.maxItems !== undefined && values.length >= definition.maxItems;
          reload.disabled = loading;
        }
        picker.onchange = function () {
          var account = accounts.find(function (account) { return key(account) === picker.value; });
          if (!account || values.some(function (entry) { return key(entry) === key(account); })) return;
          values = values.concat([{ connectionId: account.connectionId, accountId: account.accountId, commands: [] }]);
          write(values); showAccounts();
        };
        async function loadAccounts() {
          if (loading) return;
          loading = true; showAccounts(); note.textContent = '正在读取已连接服务端的账号…';
          try {
            var result = await manage('message-accounts');
            if (disposed || !group.isConnected) return;
            accounts = result.items;
            note.textContent = (accounts.length ? '可选择 ' + accounts.length + ' 个账号。' : '未读取到账号，请检查服务端连接和账号授权。')
              + (result.warnings.length ? ' ' + result.warnings.join('；') : '');
          } catch (error) {
            if (!disposed && group.isConnected) note.textContent = '读取账号失败：' + error.message;
          } finally {
            loading = false;
            if (!disposed && group.isConnected) showAccounts();
          }
        }
        loadAccounts();
      }
      function configField(container, name, definition, value, required, write) {
        definition = definition || {};
        var label = (definition.title || name) + (required ? '（必填）' : '');
        var id = 'plugin-config-field-' + (++fieldSequence), type = definition.type;
        var choices = Array.isArray(definition.enum) ? definition.enum.map(function (entry) { return { value: entry, title: String(entry) }; })
          : Array.isArray(definition.oneOf) && definition.oneOf.every(function (entry) { return entry && Object.prototype.hasOwnProperty.call(entry, 'const'); })
            ? definition.oneOf.map(function (entry) { return { value: entry.const, title: entry.title || String(entry.const) }; }) : null;
        var row = el('div', undefined, 'form-row'), input;
        container.append(row);
        function help() {
          var helpId = helpIds.get(definition);
          if (helpId) (input || group || row).setAttribute('aria-describedby', helpId);
        }
        if (definition.$ref || definition.anyOf || definition.allOf || definition.oneOf && !choices) {
          row.append(el('b', label), el('p', '此配置项需要插件作者提供可编辑的配置声明。', 'form-help')); help(); return;
        }
        if (type === 'object' || type === 'array') {
          var group = el('fieldset', undefined, 'plugin-config-group'); group.append(el('legend', label)); row.append(group);
          if (type === 'array' && definition.format === 'message-accounts' && definition.items && definition.items.properties
              && definition.items.properties.commands && definition.items.properties.commands.items
              && Array.isArray(definition.items.properties.commands.items.enum)) messageAccounts(group, definition, value, write, id);
          else if (type === 'object' && Object.keys(definition.properties || {}).length) objectFields(group, definition, value, write);
          else if (type === 'array' && definition.items && !Array.isArray(definition.items)) {
            var entries = el('div'); group.append(entries);
            function showEntries() {
              entries.replaceChildren();
              var values = Array.isArray(value) ? value : [];
              values.forEach(function (entry, index) {
                var entryRow = el('div', undefined, 'plugin-config-entry'); entries.append(entryRow);
                configField(entryRow, '第 ' + (index + 1) + ' 项', definition.items, entry, true, function (next) {
                  value = values = values.slice(); value[index] = next; write(value);
                });
                var remove = button('删除第 ' + (index + 1) + ' 项', function () {
                  value = values.filter(function (_, position) { return position !== index; }); write(value); showEntries();
                });
                remove.disabled = definition.readOnly === true || values.length <= (definition.minItems || 0); entryRow.append(remove);
              });
              add.disabled = definition.readOnly === true || definition.maxItems !== undefined && values.length >= definition.maxItems;
            }
            var add = button('添加一项', function () {
              var itemSchema = definition.items;
              var initial = Object.prototype.hasOwnProperty.call(itemSchema, 'default') ? itemSchema.default
                : Object.prototype.hasOwnProperty.call(itemSchema, 'const') ? itemSchema.const
                  : itemSchema.enum ? itemSchema.enum[0] : itemSchema.type === 'object' ? {} : itemSchema.type === 'array' ? []
                    : itemSchema.type === 'boolean' ? false : itemSchema.type === 'number' || itemSchema.type === 'integer' ? 0 : '';
              value = (Array.isArray(value) ? value : []).concat([initial]); write(value); showEntries();
            });
            group.append(add); showEntries();
          } else group.append(el('p', '此配置项需要插件作者声明具体字段。', 'form-help'));
          group.disabled = definition.readOnly === true || Object.prototype.hasOwnProperty.call(definition, 'const'); help(); return;
        }
        if (choices && choices.every(function (entry) { return entry.value === null || ['string', 'number', 'boolean'].includes(typeof entry.value); })) {
          input = el('select');
          var empty = el('option', required ? '请选择' : '未设置'); empty.value = ''; input.append(empty);
          choices.forEach(function (entry, index) { var option = el('option', entry.title); option.value = String(index); input.append(option); });
          var current = choices.findIndex(function (entry) { return entry.value === value; });
          input.value = current < 0 ? '' : String(current);
          input.onchange = function () { write(input.value === '' ? undefined : choices[Number(input.value)].value); };
        } else if (type === 'boolean') {
          input = el('input'); input.type = 'checkbox'; input.checked = value === true; input.setAttribute('role', 'switch');
          input.onchange = function () { write(input.checked); };
        } else if (['string', 'number', 'integer'].includes(type)) {
          input = el(type === 'string' && definition.format === 'multiline' && !definition.writeOnly ? 'textarea' : 'input');
          if (type === 'string') {
            if (input.tagName === 'TEXTAREA') input.rows = 4;
            else input.type = definition.writeOnly || definition.format === 'password' ? 'password' : 'text';
            if (definition.minLength !== undefined) input.minLength = definition.minLength;
            if (definition.maxLength !== undefined) input.maxLength = definition.maxLength;
            if (input.type === 'password') input.autocomplete = 'new-password';
          } else {
            input.type = 'number'; input.step = type === 'integer' ? '1' : 'any';
            if (definition.minimum !== undefined) input.min = definition.minimum;
            if (definition.maximum !== undefined) input.max = definition.maximum;
          }
          input.value = value === undefined || value === null ? '' : String(value);
          input.oninput = function () {
            write(input.value === '' && (type !== 'string' || !required) ? undefined : type === 'string' ? input.value : input.valueAsNumber);
          };
        } else {
          row.append(el('b', label), el('p', '此配置项需要插件作者声明支持的字段类型。', 'form-help')); help(); return;
        }
        input.id = id; input.disabled = definition.readOnly === true || Object.prototype.hasOwnProperty.call(definition, 'const');
        var fieldLabel = el('label', label); fieldLabel.htmlFor = id;
        if (type === 'boolean' && !choices) {
          fieldLabel.className = 'switch-label';
          var switchSlider = el('span', undefined, 'switch-slider'); switchSlider.setAttribute('aria-hidden', 'true');
          fieldLabel.replaceChildren(input, switchSlider, el('span', label, 'switch-text')); row.append(fieldLabel);
        } else row.append(fieldLabel, input);
        help();
      }
      objectFields(configFields, schema, configValue, function (value) { configValue = value; edited(); });
    }
    async function newPlugin() {
      if (!await preparePluginDrawer()) return;
      var form = el('form'), name = el('input'), id = el('input'), description = el('textarea');
      form.id = 'plugin-create-form';
      name.type = 'text'; name.required = true; name.maxLength = 500; name.placeholder = '插件名称';
      id.type = 'text'; id.required = true; id.maxLength = 60; id.pattern = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
      id.value = 'plugin-' + crypto.randomUUID().slice(0, 8); id.spellcheck = false;
      description.rows = 3; description.maxLength = 1000; description.placeholder = '简要说明插件用途（可选）';
      var fields = el('section', undefined, 'drawer-section');
      fields.append(el('h4', '插件信息'), field('插件名称', name, 'plugin-create-name'), field('插件 ID', id, 'plugin-create-id'),
        field('描述', description, 'plugin-create-description'));
      var help = el('details', undefined, 'reference-panel drawer-guide'), helpBody = el('div', undefined, 'drawer-guide-content');
      helpBody.append(el('p', '创建后可编辑代码或通过对话调整；默认停用，完成编辑后启用。'),
        el('p', 'ID 自动生成，可在创建前修改：小写字母开头，可含数字和单横线。创建后固定，用于调用插件能力。'));
      help.append(el('summary', '新建插件说明'), helpBody);
      form.append(help, fields);
      var submit = el('button', '创建插件', 'btn-primary'); submit.type = 'submit'; submit.setAttribute('form', form.id);
      var close = button('取消', function () { return options.closeDrawer(); });
      var state = pluginEditor = { container: form, dirty: false, controls: [submit, close], trigger: document.activeElement };
      form.oninput = function () { state.dirty = true; };
      document.getElementById('drawer-title').textContent = '新建插件';
      document.getElementById('drawer-content').replaceChildren(form);
      document.getElementById('drawer-actions').replaceChildren(submit, close);
      options.openDrawer(); lock(); name.focus();
      form.onsubmit = async function (event) {
        event.preventDefault();
        if (busy || pluginEditor !== state) return;
        name.value = name.value.trim(); id.value = id.value.trim();
        if (!form.reportValidity()) return;
        var created;
        busy = true; lock();
        try {
          created = unwrap(await options.resourceClient.post('/plugins', {
            id: id.value, name: name.value, description: description.value.trim(), enabled: false,
            config: {}, permissions: [], capabilities: [], subscriptions: [],
          }));
          state.dirty = false; options.toast('插件已创建，当前为停用状态'); await render();
        } catch (error) { fail(error); }
        finally { busy = false; lock(); }
        if (created && !disposed) await editPluginSource(created.id);
      };
    }
    async function editPluginSource(id) {
      if (!await preparePluginDrawer()) return;
      var container = el('div', undefined, 'app-editor plugin-code-editor'), notice = el('p', '正在读取插件…', 'app-editor-notice');
      notice.setAttribute('role', 'status'); container.append(notice);
      var close = button('关闭', function () { return options.closeDrawer(); });
      var state = pluginEditor = { pluginId: id, container: container, dirty: false, controls: [close], trigger: document.activeElement };
      document.getElementById('drawer-title').textContent = '编辑插件代码';
      document.getElementById('drawer-content').replaceChildren(container);
      document.getElementById('drawer-actions').replaceChildren(close);
      options.openDrawer(); busy = true; lock();
      var current, authoring;
      try {
        var responses = await Promise.all([
          options.resourceClient.get('/plugins/' + encodeURIComponent(id)), options.resourceClient.get('/plugins/authoring'),
        ]);
        current = unwrap(responses[0]); authoring = unwrap(responses[1]);
        if (!current.definition) throw new Error('此插件没有源码');
      } catch (error) { notice.textContent = error.message; fail(error); return; }
      finally { busy = false; lock(); }
      if (disposed || pluginEditor !== state) return;
      var definition = current.definition, readOnly = current.source !== 'user', view = 'plugin.json', source = el('page-code-editor'), selector = el('select');
      var metadataSchema = Object.assign({}, authoring.schema, { properties: Object.assign({}, authoring.schema.properties) });
      delete metadataSchema.properties.javascript; delete metadataSchema.properties.files;
      state.revision = current.revision;
      source.className = 'app-source'; source.rows = 22; source.readOnly = readOnly;
      source.setAttribute('aria-label', '插件源码');
      var review = el('section', undefined, 'app-editor-review'); review.hidden = true;
      function report(message, error) { notice.textContent = message; notice.classList.toggle('error', !!error); }
      function reportState(item) {
        report(item.error || (item.enabled ? '已保存 · ' + (labels[item.state] || item.state) : '已保存 · 已停用'), !!item.error);
      }
      function readInput() {
        if (readOnly) return;
        if (view === 'plugin.json') {
          var parsed = JSON.parse(source.value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('插件定义必须是 JSON 对象');
          if (parsed.files !== undefined || parsed.javascript !== undefined) throw new Error('请通过文件列表编辑源码');
          if (definition.files) { parsed.files = definition.files; parsed.entry = parsed.entry || 'index.js'; }
          definition = parsed;
        } else if (Object.prototype.hasOwnProperty.call(definition.files || {}, view)) {
          definition.files[view] = source.value;
        } else {
          var parts = view.split(':'); definition[parts[0]][Number(parts[1])].code = source.value;
        }
      }
      function sourceValue(value, name) {
        if (typeof name !== 'string') return undefined;
        if (name === 'plugin.json') {
          var metadata = Object.assign({}, value); delete metadata.files; delete metadata.javascript;
          return JSON.stringify(metadata, null, 2);
        }
        if (Object.prototype.hasOwnProperty.call(value.files || {}, name)) return value.files[name];
        var parts = name.split(':'), handler = value[parts[0]] && value[parts[0]][Number(parts[1])];
        return handler && handler.code;
      }
      function showSource(nextView) {
        if (typeof sourceValue(definition, nextView) !== 'string') nextView = definition.entry || 'plugin.json';
        if (typeof sourceValue(definition, nextView) !== 'string') nextView = 'plugin.json';
        view = nextView;
        selector.replaceChildren();
        Object.keys(definition.files || {}).concat(['plugin.json']).forEach(function (name) {
          var option = el('option', name); option.value = name; selector.append(option);
        });
        ['capabilities', 'subscriptions'].forEach(function (key) {
          if (!Array.isArray(definition[key])) return;
          definition[key].forEach(function (item, index) {
            if (!item || typeof item.code !== 'string') return;
            var option = el('option', key === 'capabilities' ? '能力 · ' + (item.label || item.id || index + 1)
              : '消息订阅 · ' + (item.command || index + 1));
            option.value = key + ':' + index; selector.append(option);
          });
        });
        selector.value = view;
        source.setAttribute('language', view.endsWith('.json') ? 'json' : 'javascript');
        source.schema = view === 'plugin.json' ? metadataSchema : null;
        source.value = sourceValue(definition, view);
        removeFile.hidden = readOnly || view === 'plugin.json' || view.includes(':') || view === definition.entry;
        controls.hidden = readOnly || !!definition.files;
      }
      function editedSource() { state.dirty = true; report('有变更未保存'); }
      source.addEventListener('input', editedSource);
      selector.onchange = function () {
        var nextView = selector.value;
        try { readInput(); showSource(nextView); source.focus(); }
        catch (error) { selector.value = view; report('请先修正插件定义：' + error.message, true); }
      };
      var addCapability = button('添加能力', function () {
        readInput();
        if (!Array.isArray(definition.capabilities)) throw new Error('capabilities 必须是数组');
        if (definition.capabilities.length >= 20) throw new Error('最多添加 20 个能力');
        var capability = JSON.parse(JSON.stringify(authoring.example.capabilities[0]));
        capability.id = 'action-' + crypto.randomUUID().slice(0, 8);
        definition.capabilities.push(capability); showSource('capabilities:' + (definition.capabilities.length - 1)); editedSource(); source.focus();
      });
      var addSubscription = button('添加消息订阅', function () {
        readInput();
        if (!Array.isArray(definition.subscriptions)) throw new Error('subscriptions 必须是数组');
        if (definition.subscriptions.length >= 20) throw new Error('最多添加 20 个消息订阅');
        definition.subscriptions.push({ connectionId: '', accountId: '', channelId: '', userId: '',
          code: 'const { message } = await api.ctx.get();\nawait api.messaging.reply(message.text);' });
        showSource('plugin.json'); editedSource();
        report('请填写新订阅的连接、账号、频道和发送者，再选择对应订阅编辑 JavaScript。'); source.focus();
      });
      var controls = el('div', undefined, 'app-actions app-source-file-actions'); controls.append(addCapability, addSubscription);
      selector.setAttribute('aria-label', '选择源码文件');
      var addFile = button('新增文件', async function () {
        if (readOnly || busy) return;
        readInput();
        var name = await options.prompt('源码文件名，例如 helpers.js 或 data.json');
        if (name === null || pluginEditor !== state) return;
        name = name.trim();
        if (!new RegExp(authoring.schema.properties.files.propertyNames.pattern).test(name) || name.includes('..') || name === 'plugin.json') throw new Error('请填写不含目录的 JS/JSON 文件名，plugin.json 为保留名称');
        if (Object.prototype.hasOwnProperty.call(definition.files || {}, name)) throw new Error('文件已存在');
        if (Object.keys(definition.files || {}).length >= 20) throw new Error('最多添加 20 个源码文件');
        if (!definition.files && !name.endsWith('.js')) throw new Error('请先创建 JS 入口文件');
        if (!definition.files) {
          definition.files = {}; definition.entry = name;
          definition.files[name] = 'module.exports = {\n  apply(ctx, config) {\n  }\n};\n';
        } else definition.files[name] = name.endsWith('.json') ? '{}\n' : '';
        showSource(name); editedSource(); source.focus();
      }); addFile.className = 'btn-primary'; addFile.hidden = readOnly;
      var removeFile = button('删除文件', async function () {
        if (readOnly || busy) return;
        readInput();
        var name = view;
        if (!Object.prototype.hasOwnProperty.call(definition.files || {}, name)) return;
        if (name === definition.entry) throw new Error('请先在 plugin.json 中更改入口文件');
        if (!await options.confirm('删除源码文件 ' + name + '？请同时移除对它的引用。') || pluginEditor !== state) return;
        delete definition.files[name]; showSource(definition.entry); editedSource();
      }); removeFile.className = 'btn-danger';
      var fileActions = el('div', undefined, 'form-row app-actions app-source-file-actions'); fileActions.append(selector, addFile, removeFile);
      var saveCode = button('保存代码', async function () {
        if (busy || pluginEditor !== state || readOnly) return;
        try {
          readInput();
          if (definition.id !== id) throw new Error('不能修改插件 ID；请使用「复制后修改」创建新插件');
        } catch (error) { report(error.message, true); throw error; }
        busy = true; lock(); report('正在校验并保存…');
        try {
          var saved = unwrap(await options.resourceClient.post('/plugins/' + encodeURIComponent(id), Object.assign({}, definition, { revision: state.revision })));
          state.revision = saved.revision; state.dirty = false; review.hidden = true;
          document.getElementById('drawer-title').textContent = saved.name + ' · 编辑代码';
          reportState(saved); options.toast(saved.enabled ? '代码已保存，正在重新加载插件' : '代码已保存，插件保持停用');
          await render();
        } catch (error) {
          report(error.code === 'PRECONDITION_FAILED' ? '插件已在其他位置修改，当前输入已保留；请查看最新代码后合并。' : error.message, true);
          throw error;
        } finally { busy = false; lock(); }
      }); saveCode.className = 'btn-primary';
      var latest = button('查看最新代码', async function () {
        if (busy || pluginEditor !== state) return;
        busy = true; lock();
        try {
          var item = unwrap(await options.resourceClient.get('/plugins/' + encodeURIComponent(id)));
          if (!item.definition) throw new Error('此插件没有可编辑定义');
          var external = el('page-code-editor'); external.className = 'app-source'; external.rows = 18; external.readOnly = true;
          var latestFiles = el('select'), latestFileActions = el('div', undefined, 'form-row app-actions app-source-file-actions');
          latestFiles.setAttribute('aria-label', '选择最新源码文件'); latestFileActions.append(latestFiles);
          Object.keys(item.definition.files || {}).concat(['plugin.json']).forEach(function (name) {
            var option = el('option', name); option.value = name; latestFiles.append(option);
          });
          if (Object.prototype.hasOwnProperty.call(item.definition.files || {}, view) || view === 'plugin.json') latestFiles.value = view;
          function showLatest() {
            external.setAttribute('language', latestFiles.value.endsWith('.json') ? 'json' : 'javascript');
            external.value = sourceValue(item.definition, latestFiles.value);
          }
          latestFiles.onchange = showLatest; showLatest(); external.setAttribute('aria-label', '最新插件代码');
          var reviewActions = el('div', undefined, 'app-actions');
          reviewActions.append(button('保留输入，采用最新版本', function () {
            if (busy || pluginEditor !== state) return;
            state.revision = item.revision; editedSource(); review.hidden = true;
          }), button('载入最新代码', async function () {
            if (busy || pluginEditor !== state) return;
            if (state.dirty && !await options.confirm('确认放弃当前未保存输入，载入最新代码？')) return;
            definition = item.definition; state.revision = item.revision; state.dirty = false;
            showSource(view); reportState(item); review.hidden = true;
          }));
          review.replaceChildren(el('h4', '核对最新代码 · ' + item.name),
            el('p', '当前输入仍保留。可复制需要合并的内容，再选择保留输入或载入最新代码。', 'form-help'), latestFileActions, external, reviewActions);
          review.hidden = false; report(item.error || '已读取最新代码，请核对下方内容。', !!item.error);
        } catch (error) { report(error.message, true); throw error; }
        finally { busy = false; lock(); }
      });
      var converseCode = button('对话调整', async function () {
        if (await options.closeDrawer()) return options.converse(id);
      });
      state.controls = readOnly ? [close] : [saveCode, latest, converseCode, close];
      state.showStatus = function (item) {
        if (item.revision !== state.revision) report((item.error ? item.error + '；' : '') + '插件状态或代码已变化；当前输入保留，请查看最新代码。', !!item.error);
        else if (!state.dirty) reportState(item);
      };
      var codeSection = el('section', undefined, 'drawer-section plugin-source-section');
      codeSection.append(el('h4', '插件源码'), fileActions, controls, source);
      var help = el('details', undefined, 'reference-panel drawer-guide'), helpBody = el('div', undefined, 'drawer-guide-content');
      helpBody.append(el('p', '源码按文件编辑、整组保存。plugin.json 管理入口、名称、启停、优先级、配置和权限；entry 指向 JS 入口文件。内置源码只读，复制后可修改。'),
        el('p', '保存会先校验定义与 JavaScript 语法。已启用插件保存后重新加载；停用插件保存后仍停用，无需发布。未处理的运行异常会自动停用插件，修复后可重新启用。'),
        el('p', definition.files ? authoring.modules : authoring.handlers), el('p', authoring.configuration), el('p', authoring.resources));
      help.append(el('summary', '代码编辑说明与处理函数 API'), helpBody);
      container.replaceChildren(help, codeSection, review);
      var statusRow = el('div', undefined, 'app-editor-status'); statusRow.append(notice);
      document.getElementById('drawer-title').textContent = current.name + (readOnly ? ' · 查看源码' : ' · 编辑代码');
      document.getElementById('drawer-actions').replaceChildren.apply(document.getElementById('drawer-actions'), state.controls.concat([statusRow]));
      showSource(definition.entry || 'plugin.json'); reportState(current); lock(); source.focus();
    }
    async function copyPlugin() {
      if (busy || dirty || !selectedPlugin) return;
      var item = selectedPlugin;
      var copy;
      busy = true; lock();
      try {
        copy = unwrap(await options.resourceClient.post('/plugins/' + encodeURIComponent(item.id) + '/copies', {
          id: item.id.slice(0, 40).replace(/-$/, '') + '-copy-' + crypto.randomUUID().slice(0, 8),
          name: (item.name || item.id).slice(0, 490) + ' 副本', revision: configurationRevision,
        }));
        options.toast('已创建停用副本');
        await render();
      } finally { busy = false; lock(); }
      if (!disposed) await editPluginSource(copy.id);
    }
    async function configure(id) {
      if (busy || dirty || pluginEditor) return;
      busy = true; lock();
      try {
        var item = await manage('settings', id);
        if (disposed) return;
        selected = item.id; configurationRevision = item.revision; title.textContent = '编辑' + item.name;
        selectedPlugin = item; converse.hidden = removePlugin.hidden = item.source !== 'user';
        editSource.hidden = copySource.hidden = exportSource.hidden = !item.hasSource;
        editSource.textContent = item.source === 'user' ? '编辑代码' : '查看源码';
        enabled.checked = item.enabled;
        priority.value = String(item.priority);
        messagingInfo.hidden = item.id !== 'messaging' && item.base !== 'messaging';
        renderConfiguration(item);
        errorText.textContent = item.error || '';
        editor.classList.remove('hidden');
      } finally { busy = false; lock(); }
      options.scrollOpenedEditor(editor);
    }
    editor.onsubmit = async function (event) {
      event.preventDefault();
      if (busy || !selected || pluginEditor) return;
      if (!editor.reportValidity()) return;
      busy = true; lock();
      try {
        var priorityValue = priority.valueAsNumber;
        if (!Number.isSafeInteger(priorityValue)) throw new Error('消息处理优先级必须是安全整数');
        var item = await manage('update', selected, { enabled: enabled.checked, priority: priorityValue, config: configValue, revision: configurationRevision });
        if (disposed) return;
        configurationRevision = item.revision; dirty = false; errorText.textContent = item.error || '';
        options.toast(item.state === 'failed' ? '配置已保存，插件异常；重新选择插件可查看详情' : '插件配置已保存', item.state === 'failed');
      } catch (error) { fail(error); }
      finally { busy = false; lock(); if (!disposed) render().catch(fail); }
    };
    async function renderAppTemplates(container) {
      var ticket = (templateSequences.get(container) || 0) + 1;
      templateSequences.set(container, ticket);
      var contributions = unwrap(await options.resourceClient.get('/plugins/contributions'));
      if (disposed || templateSequences.get(container) !== ticket) return;
      container.replaceChildren(); container.hidden = !contributions.apps.length;
      if (!contributions.apps.length) return;
      container.append(el('h3', '插件应用模板'), el('p', '创建的应用副本可独立编辑，停用插件不会删除副本；依赖该插件的能力需要保持启用。', 'section-desc'));
      contributions.apps.forEach(function (app) {
        var card = el('div', undefined, 'item-card');
        var create = button('创建应用副本', async function () {
          if (busy) return;
          busy = true; lock(); create.disabled = true;
          var result;
          try { result = await manage('createApp', app.pluginId, undefined, app.id); }
          finally { busy = false; lock(); create.disabled = false; }
          if (!disposed) { options.toast('应用副本已创建'); await options.openApp(result.appId); }
        });
        card.append(el('span', app.name, 'item-title'), el('span', app.description || app.pluginId, 'item-sub'), create);
        container.append(card);
      });
    }
    async function render() {
      if (disposed) return;
      var ticket = ++sequence;
      status.textContent = '正在读取插件…';
      try {
        var catalog = unwrap(await options.resourceClient.get('/plugins'));
        if (disposed || ticket !== sequence) return;
        list.replaceChildren();
        catalog.items.sort(function (a, b) { return b.priority - a.priority; }).forEach(function (item) {
          var card = el('div', undefined, 'item-card');
          card.dataset.pluginId = item.id; card.tabIndex = 0;
          card.setAttribute('role', 'button'); card.setAttribute('aria-controls', editor.id);
          card.onclick = function (event) {
            if (event.target.closest('button')) return;
            configure(item.id).catch(fail);
          };
          card.onkeydown = function (event) {
            if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault(); configure(item.id).catch(fail);
          };
          var identity = button('ID: ' + item.id, async function () { await navigator.clipboard.writeText(item.id); options.toast('ID 已复制'); });
          identity.className = 'item-id'; identity.title = '点击复制 ID: ' + item.id;
          var name = el('span', item.name, 'item-title'); name.title = item.name;
          card.append(name, el('span', item.source === 'user' ? '自建' : '内置' + (item.version ? ' · ' + item.version : ''), 'badge'),
            el('span', '优先级 ' + item.priority, 'badge'));
          if (item.description) {
            var description = el('span', item.description, 'item-sub'); description.title = item.description;
            card.append(description);
          }
          var end = el('span', undefined, 'item-card-end');
          end.append(identity,
            el('span', item.state === 'failed' && !item.enabled ? '异常停用' : labels[item.state] || item.state, 'badge' + (item.state === 'active' ? ' status-success' : item.state === 'failed' ? ' status-failed' : '')));
          card.append(end);
          list.append(card);
          if (selected === item.id) {
            errorText.textContent = item.error ? item.error + (item.revision !== configurationRevision ? '。请重新选择插件读取最新配置。' : '') : '';
          }
          if (pluginEditor && pluginEditor.pluginId === item.id && pluginEditor.showStatus) pluginEditor.showStatus(item);
        });
        status.textContent = catalog.items.length ? catalog.items.length + ' 个插件' : '暂无插件，点击「新建插件」开始。';
        lock();
        await renderAppTemplates(templates);
      } catch (error) { if (!disposed && ticket === sequence) status.textContent = '加载失败：' + error.message; }
    }
    return { render: render, renderAppTemplates: renderAppTemplates, discard: discard,
      open: async function (id) { await render(); await configure(id); },
      confirmDrawerClose: confirmDrawerClose, handleDrawerClosed: handleDrawerClosed,
      getState: function () { return { dirty: dirty || !!(pluginEditor && pluginEditor.dirty), busy: busy }; },
      destroy: function () { disposed = true; sequence++; handleDrawerClosed(); discard(); } };
  }
  root.OptionsPluginController = Object.freeze({ create: create });
})(globalThis);
