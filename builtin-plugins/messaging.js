(function (root) {
  'use strict';
  function text(max) { return { type: 'string', minLength: 1, maxLength: max || 500 }; }
  function schema(properties, required) { return { type: 'object', properties: properties, required: required, additionalProperties: false }; }
  function unwrap(response) {
    if (response.error) throw root.AgentResourceProtocol.arpError(response.error.code, response.error.message, {
      details: response.error.details, performed: response.receipt && response.receipt.performed || 'unknown',
      retryable: response.error.retryable === true,
    });
    return response.primary.data;
  }
  var builtinCommands = {
    assistant: '/assistant [助手名] [内容]', conversation: '/conversation 会话名 内容',
    flow: '/flow 流程名 参数', script: '/script 脚本名',
    app: '/app 应用名 [JSON参数]，/app 应用名 动作名 [JSON参数]',
    tool: '/tool 工具名 操作 文本（传选项用 --json {"input":"文本","options":{}}）', plugin: '/plugin 插件ID 能力ID [JSON参数]',
  };
  var sourceFields = ['connectionId', 'accountId', 'channelId', 'userId', 'platform', 'selfId', 'direct'];
  var allowedCommands = Object.keys(builtinCommands).concat(['chat', 'help', 'list', 'info', 'status', 'history', 'run', 'cancel', 'stop', 'new']);
  var authorizationSchema = schema({
    connectionId: Object.assign(text(), { title: '连接 ID' }),
    accountId: Object.assign(text(), { title: '账号 ID' }),
    // Keep legacy source fields optional so saved configurations remain valid.
    platform: Object.assign(text(80), { title: '平台标识' }),
    selfId: Object.assign(text(), { title: '机器人 ID' }),
    channelId: Object.assign(text(), { title: '频道 ID' }),
    userId: Object.assign(text(), { title: '发送者 ID' }),
    direct: { type: 'boolean', title: '私信', default: false },
    commands: { type: 'array', title: '允许的指令', uniqueItems: true,
      items: { type: 'string', enum: allowedCommands },
      description: '按需开启指令，支持全部开启；chat 允许自然语言对话。授权覆盖该指令可访问的全部资源；助手、流程和脚本可继续调用其他能力。' },
  }, ['connectionId', 'accountId', 'commands']);
  var resourceTypes = {
    assistant: { label: '助手', uri: '/assistants' }, conversation: { label: '会话', uri: '/conversations' },
    flow: { label: '流程', uri: '/flows' }, script: { label: '脚本', uri: '/scripts' },
    app: { label: '应用', uri: '/apps' }, tool: { label: '内置工具', uri: '/utilities', unpaged: true },
    plugin: { label: '插件', uri: '/plugins', unpaged: true }, group: { label: '流程组', uri: '/flow-groups' },
    schedule: { label: '定时任务', uri: '/schedules' }, knowledge: { label: '知识', uri: '/knowledge' },
    skill: { label: '技能', uri: '/skills' }, model: { label: '模型服务', uri: '/model-services' },
    connection: { label: '连接', uri: '/connections' }, page: { label: '页面配置', uri: '/pages' },
    run: { label: '运行记录', uri: '/runs' },
  };
  var accountProperties = {
    connectionId: text(), name: text(100), adapter: { enum: ['lark', 'dingtalk', 'qq', 'wecom', 'wecom-aibot', 'mail'] },
    enabled: { type: 'boolean' }, config: { type: 'object', description: '完整平台参数；从 accounts 读取适配器示例。保存时整体替换，已有凭据仅在服务端配置页编辑' },
    receiveEnabled: { type: 'boolean', description: '仅邮件：是否接收 IMAP 邮件；默认 true，false 时只需 SMTP 配置' },
    autoReply: Object.assign(schema({ enabled: { type: 'boolean' }, text: { type: 'string', maxLength: 16000 } }, ['enabled', 'text']),
      { description: '服务端收到新消息后的固定回复；默认关闭，更新时省略保留原设置。启用时 text 不能为空' }),
    callback: { anyOf: [{ type: 'null' }, schema({ host: text(200), port: { type: 'integer', minimum: 1, maximum: 65535 },
      selfUrl: { type: 'string', pattern: '^https?://', maxLength: 2000 } }, ['host', 'port', 'selfUrl'])],
      description: '回调监听；长连接和邮件使用 null，更新时保留原值或显式传 null 清除' },
  };
  var accountRequired = ['connectionId', 'name', 'adapter', 'enabled', 'config', 'callback'];
  var revisionSchema = { type: 'integer', minimum: 1, description: '最近读取的账号 revision；冲突后重新读取，不得自动覆盖' };
  var replyStorageQueues = new Map();
  async function saveAccount(input, call) {
    var body = Object.assign({}, input); delete body.connectionId; delete body.accountId;
    return unwrap(await call.serverArp(input.connectionId, 'POST', {
      uri: '/bots/accounts' + (input.accountId ? '/' + encodeURIComponent(input.accountId) : ''),
      body: body, idempotencyKey: call.idempotencyKey,
    }));
  }
  function apply(ctx, config, copyId) {
    var api = ctx.pageAgent, signal = api.signal, replies = new Map(), pending = 0, queue = Promise.resolve();
    var listView = root.PageAgentConversationListView, conversationView = root.PageAgentConversationShared;
    var authorizations = config && Array.isArray(config.authorizations) ? config.authorizations : [];
    var terminalTypes = ['generation_completed', 'generation_failed', 'generation_cancelled', 'generation_truncated', 'generation_blocked'];
    var replyEventTypes = ['generation_started', 'commentary_completed', 'reasoning_completed', 'model_response_completed',
      'tool_execution_started', 'tool_execution_completed', 'tool_execution_failed', 'tool_execution_unknown', 'tool_call_deferred',
      'interaction_requested', 'interaction_resolved', 'interaction_expired', 'interaction_cancelled'].concat(terminalTypes);
    var sessions = {}, sendQueues = new Map(), sessionError = null, savedReplies = {};
    var storageKey = 'page_agent_messaging_conversations_' + (copyId ? copyId + '_' : '') + (chrome.extension.inIncognitoContext ? 'incognito' : 'regular');
    var replyStorageKey = storageKey + '_replies';
    // A replacement instance must read after the previous instance's pending storage write.
    var sessionsReady = (replyStorageQueues.get(replyStorageKey) || Promise.resolve()).then(function () {
      signal.throwIfAborted();
      return chrome.storage.local.get([storageKey, replyStorageKey]);
    }).then(async function (stored) {
      signal.throwIfAborted();
      sessions = stored[storageKey] || {};
      savedReplies = stored[replyStorageKey] || {};
      for (var saved of Object.values(savedReplies)) {
        if (!isAuthorized(saved.message, saved.operation)) {
          delete savedReplies[saved.conversationId]; continue;
        }
        var reply = Object.assign(replyState({ id: saved.sourceId }, saved.message, saved.idempotencyKey), saved, {
          format: saved.format || 1, blocked: saved.format !== 2,
        });
        if (reply.batch && reply.batch.sending) reply.blocked = true;
        replies.set(reply.conversationId, reply);
      }
      await persistReplies();
      replies.forEach(function (reply) { scheduleReply(reply, true); });
    }).catch(function (error) { sessionError = error; });
    signal.addEventListener('abort', function () {
      replies.forEach(function (reply) { clearTimeout(reply.timer); }); replies.clear();
    }, { once: true });
    function matchesAccount(authorization, message) {
      return authorization && ['connectionId', 'accountId'].every(function (key) {
        return typeof authorization[key] === 'string' && !!authorization[key] && authorization[key] === message[key];
      });
    }
    function isAuthorized(message, operation) {
      return allowedCommands.includes(operation) && authorizations.some(function (authorization) {
        return matchesAccount(authorization, message) && Array.isArray(authorization.commands) && authorization.commands.includes(operation);
      });
    }
    function pause(ms) {
      signal.throwIfAborted();
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { signal.removeEventListener('abort', abort); resolve(); }, ms);
        function abort() { clearTimeout(timer); reject(signal.reason); }
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    function replyState(source, message, idempotencyKey) {
      return { sourceId: source.sourceId || source.id, command: source.replyCommand || '', message: message, idempotencyKey: idempotencyKey,
        format: 2, part: 0, sequence: 0, messageIds: [], timer: 0 };
    }
    function help() {
      return Object.values(builtinCommands).concat([
        '/list 查看资源分类；/list 类型 [关键词] [--page 页码] 搜索、翻页。',
        '/info 类型 名称或ID [动作名或能力ID] 查看详情和参数。',
        '/status 查看当前助手、模型、上下文占用、会话及回传状态和最近任务。',
        '/history [条数] [--before 序号] 查看当前会话最近消息或更早消息。',
        '/run [任务ID] 查看结果；/cancel [任务ID] 取消任务。省略 ID 使用本来源最近启动的任务。',
        '/assistant 查看助手列表，不改变当前选择；未匹配助手时使用默认助手，后面的全部内容用于对话。',
        '执行指令省略资源名可查看列表；名称含空格时用双引号，重名时使用 ID。',
        '直接发消息继续当前对话；使用 /assistant 助手名 选择助手，未选择时使用默认助手。',
        '/stop 取消当前对话执行；/new 清除选择，下一条消息使用默认助手开始新会话。',
        '/help [类型] 查看可用指令和该类资源的用法。',
      ]).join('\n');
    }
    function takeArgument(content) {
      var match = /^(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|(\S+))(?:\s+|$)/.exec(content.trimStart());
      if (!match) throw new Error('请填写资源名；名称含空格时用双引号');
      return { name: match.slice(1).find(function (value) { return value !== undefined; }), text: content.trimStart().slice(match[0].length) };
    }
    async function collection(uri) {
      var items = [], cursor = '', seen = new Set();
      do {
        var page = unwrap(await api.arp('GET', { uri: uri + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '') }));
        items.push.apply(items, page.items || []); cursor = page.nextCursor || '';
        if (cursor && seen.has(cursor)) throw new Error('资源列表分页异常');
        seen.add(cursor);
      } while (cursor);
      return items.filter(function (item) { return !item.archived; });
    }
    function resourceId(item) { return item.runId || item.appId || item.topicId || item.id; }
    function resourceName(item) { return item.label || item.name || item.title || item.alias || item.flowLabel || resourceId(item); }
    function resolveResource(items, name) {
      var exact = items.find(function (item) { return resourceId(item) === name; });
      if (exact) return exact;
      var matches = items.filter(function (item) { return resourceName(item) === name; });
      if (matches.length === 1) return matches[0];
      if (!matches.length) throw new Error('找不到资源：' + name + '。省略资源名可查看列表。');
      throw new Error('资源重名，请使用 ID：\n' + matches.map(function (item) { return resourceName(item) + ' · ' + resourceId(item); }).join('\n'));
    }
    function resourceType(name) {
      var key = Object.keys(resourceTypes).find(function (key) {
        return key === name || resourceTypes[key].label === name || resourceTypes[key].uri.slice(1) === name;
      });
      if (!key) throw new Error('未知资源类型：' + name + '。发送 /list 查看分类。');
      return key;
    }
    async function resourceItems(kind) {
      var type = resourceTypes[kind];
      if (!type.unpaged) return collection(type.uri);
      var result = unwrap(await api.arp('GET', { uri: type.uri }));
      return kind === 'tool' ? result.tools.filter(function (item) { return !item.pluginId; }) : result.items;
    }
    function bounded(content, limit) {
      content = String(content === undefined ? '' : content);
      return content.length > limit ? content.slice(0, limit) + '\n（内容过长，已截断）' : content;
    }
    function itemStatus(item, kind) {
      var status = item.status || item.state || (item.enabled === false ? '已停用' : '');
      if (kind === 'app') status = item.slots && item.slots.published ? '已发布' : '未发布';
      if (kind === 'plugin') status += ' · 优先级 ' + item.priority;
      return status ? ' [' + status + ']' : '';
    }
    async function showList(notice, content) {
      if (!content.trim()) return sendText(notice, '资源分类：\n' + Object.keys(resourceTypes).map(function (key) {
        return resourceTypes[key].label + '：/list ' + key;
      }).join('\n') + '\n用法：/list 类型 [关键词] [--page 页码]；/info 类型 名称或ID 查看详情。');
      var first = takeArgument(content), kind = resourceType(first.name), rest = first.text, page = 1, words = [];
      while (rest.trim()) {
        var part = takeArgument(rest); rest = part.text;
        if (part.name === '--page') {
          var value = takeArgument(rest); rest = value.text; page = Number(value.name);
          if (!Number.isSafeInteger(page) || page < 1) throw new Error('页码必须是正整数');
        } else words.push(part.name);
      }
      var query = words.join(' ').toLowerCase(), items = (await resourceItems(kind)).filter(function (item) {
        return !query || [resourceName(item), resourceId(item), item.description, item.summary, item.model, item.status, item.state].join(' ').toLowerCase().includes(query);
      });
      if (kind === 'plugin') items.sort(function (a, b) { return b.priority - a.priority; });
      var pages = Math.max(1, Math.ceil(items.length / 10));
      if (page > pages) throw new Error('只有 ' + pages + ' 页，请调整 --page。');
      var lines = items.slice((page - 1) * 10, page * 10).map(function (item) {
        return bounded(resourceName(item), 120) + ' · ' + resourceId(item) + itemStatus(item, kind)
          + (item.description || item.summary ? '\n  ' + bounded(item.description || item.summary, 120).replace(/\n/g, ' ') : '');
      });
      var next = '/list ' + kind + (words.length ? ' ' + words.map(function (word) { return JSON.stringify(word); }).join(' ') : '');
      return sendText(notice, resourceTypes[kind].label + '：共 ' + items.length + ' 项，第 ' + page + '/' + pages + ' 页\n'
        + (lines.join('\n') || '暂无匹配资源。') + '\n详情：/info ' + kind + ' 名称或ID'
        + (builtinCommands[kind] ? '\n使用：' + builtinCommands[kind] : '')
        + (page < pages ? '\n下一页：' + next + ' --page ' + (page + 1) : ''));
    }
    async function showInfo(notice, content) {
      if (!content.trim()) return sendText(notice, '用法：/info 类型 名称或ID [动作名或能力ID]。发送 /list 查看资源分类。');
      var first = takeArgument(content), kind = resourceType(first.name);
      if (!first.text.trim()) return showList(notice, kind);
      var selected = takeArgument(first.text);
      var item = resolveResource(await resourceItems(kind), selected.name), id = resourceId(item), member = selected.text.trim();
      if (member && kind !== 'app' && kind !== 'plugin') throw new Error('用法：/info ' + kind + ' 名称或ID');
      if (member) { var argument = takeArgument(member); if (argument.text.trim()) throw new Error('动作名或能力 ID 含空格时请加引号'); member = argument.name; }
      var detail = kind === 'plugin' ? item : unwrap(await api.arp('GET', {
        uri: kind === 'tool' ? item.uri : resourceTypes[kind].uri + '/' + encodeURIComponent(id) + (kind === 'run' ? '?includeFinalOutput=true' : ''),
      }));
      var info = {};
      ['description', 'summary', 'enabled', 'state', 'status', 'priority', 'version', 'model', 'protocol', 'modelServiceId', 'assistantId',
        'taskType', 'flowId', 'flowGroupId', 'trigger', 'tags', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'error',
        'output', 'result', 'content', 'sections', 'resourceCount', 'operations', 'inputSchema', 'outputSchema'].forEach(function (key) {
        if (detail[key] !== undefined && detail[key] !== '') info[key] = detail[key];
      });
      if (kind === 'page') info.url = detail.url;
      if (detail.nodes) info.nodeCount = detail.nodes.length;
      if (detail.steps) info.steps = detail.steps;
      if (kind === 'app') {
        var published = detail.slots && detail.slots.published;
        if (published) {
          info.parameters = published.parameters;
          var actions = unwrap(await api.arp('GET', { uri: '/apps/' + encodeURIComponent(id) + '/published/actions' })).value || [];
          if (member) actions = [resolveResource(actions.map(function (action) { return Object.assign({ id: action.name }, action); }), member)];
          info.actions = actions.map(function (action) {
            return member ? { name: action.name, description: action.purpose, inputSchema: action.inputSchema, outputSchema: action.outputSchema }
              : action.name + ' · ' + bounded(action.purpose, 80);
          });
        } else if (member) throw new Error('应用尚未发布，没有可执行动作');
      } else if (kind === 'plugin') {
        var capabilities = unwrap(await api.arp('GET', { uri: '/plugins/contributions' })).capabilities.filter(function (entry) { return entry.pluginId === id; });
        if (member) capabilities = [resolveResource(capabilities, member)];
        info.capabilities = capabilities.map(function (entry) {
          return member ? { id: entry.id, name: entry.label, description: entry.description, inputSchema: entry.inputSchema, outputSchema: entry.outputSchema }
            : entry.id + ' · ' + bounded(entry.label, 80);
        });
      }
      return sendText(notice, resourceTypes[kind].label + '：' + resourceName(item) + ' · ' + id + itemStatus(item, kind) + '\n'
        + bounded(JSON.stringify(info, null, 2), 14000) + (builtinCommands[kind] ? '\n使用：' + builtinCommands[kind] : '')
        + (kind === 'app' || kind === 'plugin' ? '\n指定详情：/info ' + kind + ' ' + JSON.stringify(id) + ' 动作名或能力ID' : ''));
    }
    function jsonInput(content) {
      var input;
      try { input = content.trim() ? JSON.parse(content) : {}; }
      catch (_) { throw new Error('参数需要有效的 JSON 对象'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数需要有效的 JSON 对象');
      return input;
    }
    async function currentConversation(source) {
      var target = sessions[source.id] && sessions[source.id].active;
      // Older entries also saved implicit defaults; only explicit selections may override the default.
      if (!target || target.explicit !== true) {
        var assistant = resolveResource(await resourceItems('assistant'), '默认助手');
        target = { kind: 'assistant', targetId: resourceId(assistant) };
      }
      var saved = target && sessions[source.id + ':' + target.kind + ':' + target.targetId];
      return { target: target, id: saved ? saved.conversationId : target && target.kind === 'conversation' ? target.targetId : '' };
    }
    async function conversationFooter(assistantId, serviceId, conversationId, generationId) {
      var assistant = assistantId ? unwrap(await api.arp('GET', { uri: '/assistants/' + encodeURIComponent(assistantId) })) : null;
      var request = {}, context = null;
      if (conversationId) {
        var page = await api.conversation('GET_EVENTS', { conversationId: conversationId, generationId: generationId,
          types: ['model_request_started'], includePayloads: true, limit: 1, view: 'full' });
        var event = page.events[0];
        request = event && event.payload && event.payload.request || {};
        context = request.contextTrace;
      }
      var model = request.model;
      if (!model) {
        serviceId = serviceId || assistant && assistant.modelServiceId;
        if (!serviceId) serviceId = unwrap(await api.arp('GET', { uri: '/agent-settings' })).defaultModelServiceId;
        if (serviceId) model = unwrap(await api.arp('GET', { uri: '/model-services/' + encodeURIComponent(serviceId) })).model;
      }
      var percent = context && Number.isFinite(context.inputTokens) && context.inputTokens >= 0
        && Number.isFinite(context.inputLimit) && context.inputLimit > 0
        ? Math.round(context.inputTokens / context.inputLimit * 100) + '%' : '0%';
      return (assistant ? resourceName(assistant) : '未指定助手') + ' · ' + (model || '未配置模型') + ' · ctx ' + percent;
    }
    async function showConversation(notice, source, name, content) {
      var current = await currentConversation(source), lines = [], page;
      if (name === 'status') {
        if (content.trim()) throw new Error('用法：/status');
        var assistantId = current.target.kind === 'assistant' ? current.target.targetId : '', serviceId = '', generationId;
        if (current.id) {
          var conversation = unwrap(await api.arp('GET', { uri: '/conversations/' + encodeURIComponent(current.id) }));
          page = await api.conversation('GET_CONVERSATION', { conversationId: current.id });
          var active = page.activeGeneration;
          assistantId = page.assistantId || conversation.assistantId || assistantId;
          serviceId = page.serviceId || conversation.modelServiceId;
          generationId = active && active.generationId;
          lines.push('会话：' + resourceName(conversation) + ' · ' + current.id,
            '状态：' + conversationView.statusLabel(active && active.state), '助手 ID：' + (assistantId || '未指定'),
            '模型服务 ID：' + (serviceId || '默认'));
          if (active && active.pendingInteraction) {
            lines.push('等待回答：' + active.pendingInteraction.prompt);
            (active.pendingInteraction.options || []).forEach(function (choice, index) { lines.push((index + 1) + '. ' + choice.label); });
            lines.push('直接回复答案或选项编号。');
          }
          var delivery = replies.get(current.id);
          if (delivery && delivery.sourceId === source.id) lines.push(replyStatus(delivery));
        } else lines.push('尚未开始会话，直接发送消息即可开始；/assistant 查看助手列表。');
        lines.unshift(await conversationFooter(assistantId, serviceId, current.id, generationId));
        var lastRun = sessions[source.id] && sessions[source.id].lastRunId;
        if (lastRun) lines.push('最近任务：' + lastRun + '\n结果：/run ' + lastRun + '\n取消：/cancel ' + lastRun);
        return sendText(notice, lines.join('\n'));
      }
      var count = 5, before, parts = content.trim() ? content.trim().split(/\s+/) : [];
      if (parts.length && parts[0] !== '--before') count = Number(parts.shift());
      if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('消息条数须为 1 到 20');
      if (parts.length) {
        if (parts.length !== 2 || parts[0] !== '--before') throw new Error('用法：/history [条数] [--before 序号]');
        before = Number(parts[1]);
        if (!Number.isSafeInteger(before) || before < 1) throw new Error('消息序号必须是正整数');
      }
      if (!current.id) return sendText(notice, '当前来源尚无会话记录，先发送消息或使用 /conversation 选择会话。');
      page = await api.conversation('GET_EVENTS', { conversationId: current.id, cursor: before ? { beforeSequence: before } : {},
        limit: count, includePayloads: true, view: 'conversation' });
      lines = listView.projectPage({ events: page.events }).projectedEvents.filter(conversationView.isVisibleEvent).map(function (event, index) {
        return '#' + event.sequence + ' ' + conversationView.renderEvent(event, index, { format: 'text', readOnly: true });
      });
      return sendText(notice, '会话：' + current.id + '\n' + (lines.join('\n\n') || '暂无消息。')
        + (page.hasMoreBefore && page.cursors.beforeSequence ? '\n更早消息：/history ' + count + ' --before ' + page.cursors.beforeSequence : ''));
    }
    async function handleRun(notice, source, name, content, idempotencyKey) {
      var selected = content.trim() ? takeArgument(content) : null;
      if (selected && selected.text.trim()) throw new Error('用法：/' + name + ' [任务ID]');
      var id = selected ? selected.name : sessions[source.id] && sessions[source.id].lastRunId;
      if (!id) return sendText(notice, '本来源尚未启动任务。发送 /list run 查看运行记录，再用 /' + name + ' 任务ID。');
      var uri = '/runs/' + encodeURIComponent(id);
      if (name === 'cancel') {
        unwrap(await api.arp('POST', { uri: uri + '/stop', body: {}, idempotencyKey: idempotencyKey }));
        return sendText(notice, '已请求取消任务 ' + id + '。使用 /run ' + id + ' 查看最终状态。');
      }
      var run = unwrap(await api.arp('GET', { uri: uri + '?includeFinalOutput=true' })), result = {};
      ['runId', 'kind', 'flowLabel', 'status', 'startedAt', 'endedAt', 'error', 'output', 'result', 'flowGroupResults'].forEach(function (key) {
        if (run[key] !== undefined) result[key] = run[key];
      });
      return sendText(notice, '任务：' + id + '\n' + bounded(JSON.stringify(result, null, 2), 14000));
    }
    async function handleBuiltin(source, message, idempotencyKey) {
      await sessionsReady; if (sessionError) throw sessionError;
      var notice = replyState(source, message, idempotencyKey + ':notice'), command = message.command;
      var plain = message.text.replace(/^(?:\s*<at\b[^>]*\/>)+\s*/, '').trim();
      if (command && command.error) throw new Error(command.error);
      var name = command && command.name;
      var commandText = command && command.text || '';
      if (plain === '/help' || name === 'help') {
        if (!commandText.trim()) return sendText(notice, help());
        var kind = resourceType(commandText.trim());
        return sendText(notice, resourceTypes[kind].label + '\n/list ' + kind + ' [关键词] [--page 页码]\n/info ' + kind + ' 名称或ID'
          + (builtinCommands[kind] ? '\n' + builtinCommands[kind] : '') + (kind === 'run' ? '\n/run [任务ID]\n/cancel [任务ID]' : ''));
      }
      if (name === 'list') return showList(notice, commandText);
      if (name === 'info') return showInfo(notice, commandText);
      if (name === 'status' || name === 'history') return showConversation(notice, source, name, commandText);
      if (name === 'run' || name === 'cancel') return handleRun(notice, source, name, commandText, idempotencyKey);
      var target, assistantNotice = '', content = plain;
      if (!plain.startsWith('/') || plain === '/stop' || plain === '/new') {
        target = (await currentConversation(source)).target;
      } else {
        if (!Object.prototype.hasOwnProperty.call(builtinCommands, name)) return sendText(notice, '未知指令。\n' + help());
        if (!commandText.trim()) return showList(notice, name);
        var items = name === 'tool' ? unwrap(await api.arp('GET', { uri: '/utilities' })).tools.filter(function (item) { return !item.pluginId; })
          : name === 'plugin' ? unwrap(await api.arp('GET', { uri: '/plugins/contributions' })).capabilities.map(function (item) {
            return Object.assign({}, item, { id: item.pluginId + '/' + item.id });
          }) : await resourceItems(name);
        if (name === 'app') items = items.filter(function (item) { return item.slots && item.slots.published; });
        var first = takeArgument(commandText), selector = first.name;
        content = first.text;
        if (name === 'plugin') {
          if (!content.trim()) {
            return showInfo(notice, 'plugin ' + JSON.stringify(selector));
          }
          var capability = takeArgument(content); selector += '/' + capability.name; content = capability.text;
        }
        var useDefaultAssistant = name === 'assistant' && !items.some(function (item) {
          return resourceId(item) === selector || resourceName(item) === selector;
        });
        var item = resolveResource(items, useDefaultAssistant ? '默认助手' : selector), id = resourceId(item), uri, body;
        if (name === 'assistant' || name === 'conversation') {
          target = { kind: name, targetId: id, explicit: !useDefaultAssistant };
          if (name === 'assistant') {
            if (useDefaultAssistant) {
              content = commandText;
              assistantNotice = '未匹配到助手名称或 ID，已使用默认助手；/assistant 后的全部内容将作为对话内容。';
            } else assistantNotice = '已选择助手：' + resourceName(item) + ' · ' + id
              + (content.trim() ? '。' : '。直接发送消息即可继续。');
          }
        } else {
          if (name === 'flow') {
            uri = '/flows/' + encodeURIComponent(id) + '/runs';
            body = { trigger: 'plugin:messaging', context: { input: content, args: command.args.slice(1), message: message } };
          } else if (name === 'script') {
            if (content.trim()) throw new Error('脚本入口不接收参数，请使用 /script 脚本名');
            uri = '/scripts/' + encodeURIComponent(id) + '/runs'; body = { trigger: 'plugin:messaging' };
          } else if (name === 'app') {
            uri = '/apps/' + encodeURIComponent(id);
            if (!content.trim() || content.trimStart().startsWith('{')) uri += '/open';
            else { var action = takeArgument(content); uri += '/actions/' + encodeURIComponent(action.name) + '/runs'; content = action.text; }
            body = { input: jsonInput(content) };
          } else if (name === 'tool') {
            if (!content.trim()) return showInfo(notice, 'tool ' + JSON.stringify(id));
            var operation = takeArgument(content);
            if (!item.operations.includes(operation.name)) throw new Error('可用操作：' + item.operations.join('、'));
            uri = item.operationUris[operation.name];
            body = /^--json(?:\s|$)/.test(operation.text) ? jsonInput(operation.text.slice(6)) : { input: operation.text, options: {} };
          } else { uri = item.uri; body = jsonInput(content); }
          return executeResource(source, message, idempotencyKey, uri, body);
        }
      }
      var conversationTarget = Object.assign({}, target, {
        id: source.id + ':' + target.kind + ':' + target.targetId, sourceId: source.id,
        replyCommand: target.explicit ? target.kind + ' ' + JSON.stringify(target.targetId) : '',
        resetSelection: plain === '/new',
      });
      if (name === 'assistant' || name === 'conversation') {
        if (target.explicit) sessions[source.id] = Object.assign({}, sessions[source.id], { active: target });
        else if (sessions[source.id]) delete sessions[source.id].active;
        await saveSessions();
      }
      if (assistantNotice) await sendText(replyState(source, message, idempotencyKey + ':selection'), assistantNotice);
      if (content.trim()) await handleConversation(conversationTarget, message, idempotencyKey, content);
      else if (!assistantNotice) await sendText(notice, '已选择对话，直接发送消息即可继续。');
    }
    async function executeResource(source, message, idempotencyKey, uri, body) {
      var envelope = await api.arp('POST', { uri: uri, body: body, idempotencyKey: idempotencyKey });
      var result = unwrap(envelope);
      var output = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
      var runId = output && output.runId || result && result.runId;
      if (runId) {
        sessions[source.id] = Object.assign({}, sessions[source.id], { lastRunId: runId });
        await saveSessions();
      }
      api.events.emit('messaging:triggered', { sourceId: source.id, message: message, result: result });
      var summary = envelope.status.code === 202 ? '已启动任务。\n' : '';
      summary += typeof output === 'string' ? output : JSON.stringify(output, null, 2) || '';
      if (summary.length > 16000) summary = summary.slice(0, 15950) + '\n（结果过长，已截断）';
      if (runId) summary += '\n查看结果：/run ' + runId + '\n取消任务：/cancel ' + runId;
      await sendText(replyState(source, message, idempotencyKey + ':result'), summary || '调用完成，没有返回内容。');
    }
    function persistReplies() {
      signal.throwIfAborted();
      var snapshot = JSON.parse(JSON.stringify(savedReplies));
      var work = (replyStorageQueues.get(replyStorageKey) || Promise.resolve()).then(function () {
        signal.throwIfAborted();
        return chrome.storage.local.set({ [replyStorageKey]: snapshot });
      });
      replyStorageQueues.set(replyStorageKey, work.catch(function () {}));
      return work;
    }
    async function saveReply(reply) {
      signal.throwIfAborted();
      if (replies.get(reply.conversationId) !== reply) return;
      savedReplies[reply.conversationId] = {
        sourceId: reply.sourceId, command: reply.command, operation: reply.operation, message: reply.message,
        conversationId: reply.conversationId, generationId: reply.generationId, commandId: reply.commandId,
        idempotencyKey: reply.idempotencyKey, format: reply.format, part: reply.part, sequence: reply.sequence,
        assistantId: reply.assistantId || '', serviceId: reply.serviceId || '', messageIds: reply.messageIds,
        batch: reply.batch || null, finished: !!reply.finished, error: reply.error || '',
      };
      await persistReplies();
    }
    function replyStatus(reply) {
      if (reply.blocked && reply.batch && reply.batch.sending) return '回传已暂停：有片段的发送结果未确认，不会自动重发。请先核对平台消息；/history 查看回复，/new 清除本次回传并新建会话。';
      if (reply.format !== 2) return '旧版回传记录缺少事件进度，已暂停。/history 查看回复，/new 开始新会话。';
      if (reply.blocked) return '回传已暂停：' + reply.error + '。/history 查看回复，处理问题后重新启用插件，或用 /new 开始新会话。';
      if (reply.error) return '回传等待恢复：' + reply.error;
      return '回传：' + (reply.batch ? '正在发送' : '等待助手回复');
    }
    async function closeReply(reply) {
      reply.closed = true; clearTimeout(reply.timer);
      if (replies.get(reply.conversationId) !== reply) return;
      replies.delete(reply.conversationId); delete savedReplies[reply.conversationId];
      await persistReplies();
    }
    async function sendText(reply, content) {
      if (!content.trim()) return;
      var batch = reply.batch, message = batch ? batch.message : reply.message;
      var accountKey = JSON.stringify([message.connectionId, message.accountId]);
      var sender = sendQueues.get(accountKey);
      if (!sender) { sender = { queue: Promise.resolve(), lastSent: 0 }; sendQueues.set(accountKey, sender); }
      var work = sender.queue.then(async function () {
        // Serialize and rate-limit each account, including concurrent conversations.
        for (var offset = batch ? batch.offset : 0; offset < content.length;) {
          signal.throwIfAborted();
          if (reply.closed) return;
          var delay = sender.lastSent + 1200 - Date.now();
          if (delay > 0) await pause(delay);
          if (reply.closed) return;
          var end = Math.min(offset + (message.platform === 'mail' ? 16000 : 1800), content.length);
          if (end < content.length && /[\uD800-\uDBFF]/.test(content.charAt(end - 1))) end--;
          var key = reply.idempotencyKey + ':reply:' + reply.part++;
          if (batch) {
            // Persist intent before sending; a crash here must never trigger a blind replay.
            batch.sending = true;
            await saveReply(reply);
            signal.throwIfAborted();
            if (reply.closed) return;
          }
          sender.lastSent = Date.now();
          try {
            var sent = unwrap(await api.serverArp(message.connectionId, 'POST', {
              uri: '/bots/accounts/' + encodeURIComponent(message.accountId) + '/messages',
              body: { replyTo: message.id, targetId: message.direct ? message.userId : message.channelId,
                direct: !!message.direct, text: content.slice(offset, end) },
              idempotencyKey: key,
            }));
            reply.messageIds.push.apply(reply.messageIds, sent.messageIds);
          } catch (error) {
            if (batch && error.performed === 'no') batch.sending = false;
            error.platformSend = true; throw error;
          }
          offset = end;
          if (batch) {
            batch.offset = end; batch.sending = false;
            await saveReply(reply);
          }
        }
      });
      sender.queue = work.catch(function () {});
      return work;
    }
    function scheduleReply(reply, immediate) {
      if (signal.aborted || reply.blocked || reply.starting || replies.get(reply.conversationId) !== reply) return;
      if (reply.checking) { reply.changed = true; return; }
      if (reply.timer) return;
      reply.timer = setTimeout(function () { reply.timer = 0; pumpReply(reply); }, reply.retryDelay || (immediate ? 0 : 2000));
    }
    function pumpReply(reply) {
      if (reply.work) return reply.work;
      reply.work = readReply(reply).finally(function () {
        reply.work = null;
        if (reply.changed) scheduleReply(reply);
      });
      return reply.work;
    }
    async function finishReply(reply) {
      if (signal.aborted || replies.get(reply.conversationId) !== reply) return;
      await closeReply(reply);
      if (signal.aborted) return;
      api.events.emit('messaging:replied', { sourceId: reply.sourceId, message: reply.message,
        conversationId: reply.conversationId, generationId: reply.generationId, messageIds: reply.messageIds });
    }
    async function flushReply(reply) {
      var batch = reply.batch;
      await sendText(reply, batch.content);
      if (signal.aborted || replies.get(reply.conversationId) !== reply) return true;
      reply.sequence = batch.throughSequence;
      reply.finished = batch.terminal;
      reply.batch = null; reply.error = ''; reply.retryDelay = 0;
      await saveReply(reply);
      if (reply.finished) await finishReply(reply);
      return reply.finished;
    }
    function replyEventText(reply, source) {
      if (source.type === 'generation_completed' || source.type === 'interaction_resolved') return '';
      if (terminalTypes.includes(source.type)) {
        // The model response owns the answer; generation events only report completion or failure.
        source = Object.assign({}, source, { payload: Object.assign({}, source.payload, { finalAnswer: '' }) });
      }
      // Reuse the UI's stateless event conversion, without building or comparing list cards.
      var event = listView.projectDurableEvent(source);
      if (!conversationView.isVisibleEvent(event)) return '';
      var content = conversationView.renderEvent(event, 0, { format: 'text', readOnly: true });
      if (source.type === 'interaction_requested') {
        var choices = (source.payload.options || []).map(function (choice, index) {
          return (index + 1) + '. ' + choice.label + (choice.description ? '：' + choice.description : '');
        });
        var prefix = reply.command ? '/' + reply.command + ' ' : '';
        content += (choices.length ? '\n' + choices.join('\n') : '')
          + '\n请' + (prefix ? '使用 ' + prefix + '后接' : '直接回复') + (choices.length ? '选项编号或内容' : '你的回答')
          + '，或发送 ' + prefix + '/stop 取消。';
      }
      return content;
    }
    async function readReply(reply) {
      if (signal.aborted || reply.blocked || reply.starting || replies.get(reply.conversationId) !== reply) return;
      reply.checking = true; reply.changed = false;
      try {
        if (reply.finished) return await finishReply(reply);
        if (reply.batch && await flushReply(reply)) return;
        var page;
        if (!reply.generationId) {
          // Recover the acceptance gap without starting the user's turn a second time.
          var after = 0, started;
          do {
            page = await api.conversation('GET_EVENTS', { conversationId: reply.conversationId,
              types: ['generation_started'], cursor: { afterSequence: after }, includePayloads: true, limit: 100 });
            signal.throwIfAborted();
            if (replies.get(reply.conversationId) !== reply) return;
            started = page.events.find(function (event) { return event.payload && event.payload.commandId === reply.commandId; });
            if (page.events.length) after = page.events[page.events.length - 1].sequence;
          } while (!started && page.hasMoreAfter);
          if (!started) throw new Error('未找到本次请求的执行记录，未重新执行；请用 /new 开始新会话');
          reply.generationId = started.generationId;
          await saveReply(reply);
        }
        var events = [], throughSequence = reply.sequence;
        do {
          page = await api.conversation('GET_EVENTS', { conversationId: reply.conversationId, generationId: reply.generationId,
            types: replyEventTypes, cursor: { afterSequence: throughSequence }, includePayloads: true, limit: 100, view: 'full' });
          signal.throwIfAborted();
          if (replies.get(reply.conversationId) !== reply) return;
          for (var event of page.events) {
            events.push(event); throughSequence = Math.max(throughSequence, event.sequence);
          }
        } while (page.hasMoreAfter);
        var hadError = !!reply.error;
        reply.error = ''; reply.retryDelay = 0;
        if (!events.length) { if (hadError) await saveReply(reply); return; }
        var terminal = events.some(function (event) { return terminalTypes.includes(event.type); });
        var tools = new Map(), interactions = new Map();
        events.forEach(function (event) {
          if (event.type === 'generation_started') {
            reply.assistantId = event.payload.assistantId; reply.serviceId = event.payload.serviceId;
          }
          if (event.type.startsWith('tool_')) tools.set(event.toolCallId, event);
          if (event.type.startsWith('interaction_')) interactions.set(event.interactionId, event);
        });
        var waiting = Array.from(interactions.values()).some(function (event) { return event.type === 'interaction_requested'; });
        var mail = reply.message.platform === 'mail', parts = [];
        if (mail && !terminal && !waiting) return;
        for (var event of events) {
          // Within this batch, report the latest execution state for each tool or interaction.
          if (event.type.startsWith('tool_') && tools.get(event.toolCallId) !== event) continue;
          if (event.type.startsWith('interaction_') && interactions.get(event.interactionId) !== event) continue;
          if (event.type === 'interaction_requested' && terminal) continue;
          if (mail && event.type !== 'model_response_completed' && !event.type.startsWith('interaction_')
              && !terminalTypes.includes(event.type)) continue;
          var content = replyEventText(reply, event);
          if (content) parts.push(content);
        }
        if (terminal) {
          try {
            parts.push(await conversationFooter(reply.assistantId, reply.serviceId, reply.conversationId, reply.generationId));
          } catch (error) {
            if (signal.aborted) throw error;
            // Optional status must not prevent delivery of the final answer.
            parts.push('助手信息读取失败 · 模型未知 · ctx 0%');
            api.events.emit('messaging:trigger-error', { sourceId: reply.sourceId, message: reply.message,
              conversationId: reply.conversationId, generationId: reply.generationId, stage: 'status', error: error.message });
          }
        }
        if (signal.aborted || replies.get(reply.conversationId) !== reply) return;
        if (parts.length) {
          reply.batch = { content: parts.join('\n\n'), throughSequence: throughSequence, terminal: terminal,
            message: reply.message, offset: 0, sending: false };
          await saveReply(reply);
          await flushReply(reply);
        } else {
          reply.sequence = throughSequence;
          await saveReply(reply);
        }
      } catch (error) {
        if (signal.aborted || replies.get(reply.conversationId) !== reply) return;
        reply.error = error.message;
        var transient = ['TEMPORARILY_UNAVAILABLE', 'RESOURCE_BUSY'].includes(error.code);
        reply.blocked = !!(reply.batch && reply.batch.sending) || !transient || (error.platformSend && error.performed !== 'no');
        reply.retryDelay = reply.blocked ? 0 : Math.min((reply.retryDelay || 2500) * 2, 30000);
        try { await saveReply(reply); }
        catch (storageError) { reply.blocked = true; reply.error += '；回传进度保存失败：' + storageError.message; }
        if (!signal.aborted) api.events.emit('messaging:trigger-error', { sourceId: reply.sourceId, message: reply.message,
          conversationId: reply.conversationId, generationId: reply.generationId, stage: 'reply', error: replyStatus(reply) });
      } finally {
        reply.checking = false;
        if (reply.retryDelay) scheduleReply(reply);
      }
    }
    api.events.on('host:CONVERSATION_JOURNAL_UPDATED', function (event) {
      var reply = replies.get(event.data.conversationId);
      if (reply) scheduleReply(reply);
    });
    async function saveSessions() { signal.throwIfAborted(); await chrome.storage.local.set({ [storageKey]: sessions }); }
    async function trackReply(target, message, result, idempotencyKey, page) {
      var reply = replies.get(result.conversationId);
      if (reply && reply.sourceId !== target.sourceId) throw new Error('此话题正在处理其他来源的消息，请用 /assistant 选择助手开启独立对话');
      if (reply && reply.blocked) throw new Error(replyStatus(reply));
      if (reply && reply.generationId === result.generationId) {
        reply.message = message; reply.operation = message.command && message.command.name || 'chat';
        await saveReply(reply); return reply;
      }
      if (!reply && replies.size >= 32) throw new Error('等待助手回复的任务已满，本条消息未处理');
      if (reply) throw new Error('上一轮回复尚未回传完毕，请稍后发送；/status 查看状态，/new 放弃回传并新建会话');
      reply = replyState(target, message, idempotencyKey + ':generation');
      reply.conversationId = result.conversationId; reply.generationId = result.generationId || '';
      reply.commandId = idempotencyKey; reply.starting = !reply.generationId;
      reply.operation = message.command && message.command.name || 'chat';
      reply.assistantId = result.assistantId || page && page.assistantId || '';
      reply.serviceId = result.serviceId || page && page.serviceId || '';
      if (page) reply.sequence = page.lastSequence || 0;
      replies.set(reply.conversationId, reply);
      try { await saveReply(reply); }
      catch (error) {
        reply.starting = false; reply.blocked = true; reply.error = '回传进度保存失败：' + error.message;
        throw error;
      }
      scheduleReply(reply, true); return reply;
    }
    async function handleConversation(target, message, idempotencyKey, content) {
      await sessionsReady; if (sessionError) throw sessionError;
      var command = content.replace(/^(?:\s*<at\b[^>]*\/>)+\s*/, '').trim(), response = replyState(target, message, idempotencyKey + ':notice');
      if ((command === '/stop' || command === '/new') && !isAuthorized(message, command.slice(1))) {
        throw new Error('此消息来源未获授权执行 ' + command);
      }
      if (!command) return sendText(response, '请填写要发送给助手的内容。');
      if (command === '/help') return sendText(response, help());
      var saved = sessions[target.id], conversation = null;
      var conversationId = saved ? saved.conversationId : target.kind === 'conversation' ? target.targetId : '';
      if (conversationId) {
        try { conversation = unwrap(await api.arp('GET', { uri: '/conversations/' + encodeURIComponent(conversationId) })); }
        catch (error) { if (error.code !== 'RESOURCE_NOT_FOUND') throw error; }
        if (conversation && conversation.archived) conversation = null;
      }
      var page = conversation ? await api.conversation('GET_CONVERSATION', { conversationId: conversationId }) : null;
      var active = page && page.activeGeneration;
      if (active && terminalTypes.includes('generation_' + active.state)) active = null;
      if (command === '/stop' || command === '/new') {
        if (active) {
          await api.conversation('CANCEL_GENERATION', { conversationId: conversationId, generationId: active.generationId, reason: '平台用户取消' });
        }
        var oldReply = replies.get(conversationId);
        if (oldReply) await closeReply(oldReply);
        if (command === '/stop') return sendText(response, active ? '已请求取消当前任务。' : '当前没有正在执行的任务。');
        if (target.kind === 'assistant' || target.resetSelection) {
          delete sessions[target.id];
          if (target.resetSelection) {
            if (sessions[target.sourceId]) delete sessions[target.sourceId].active;
            var defaultTarget = (await currentConversation({ id: target.sourceId })).target;
            var defaultKey = target.sourceId + ':' + defaultTarget.kind + ':' + defaultTarget.targetId;
            var defaultReply = sessions[defaultKey] && replies.get(sessions[defaultKey].conversationId);
            if (defaultReply && defaultReply.sourceId === target.sourceId) await closeReply(defaultReply);
            delete sessions[defaultKey];
          }
          await saveSessions();
          await sendText(response, target.resetSelection
            ? '已清除助手和会话选择，下一条消息将使用默认助手开始新会话。'
            : '已切换到新会话，下一条消息将开始新的对话。'); return;
        }
      }
      if (!conversation || command === '/new') {
        var assistantId = target.kind === 'assistant' ? target.targetId : conversation && conversation.assistantId;
        if (!assistantId) throw new Error('原话题不存在，请用 /assistant 助手名 内容 重新选择助手');
        unwrap(await api.arp('GET', { uri: '/assistants/' + encodeURIComponent(assistantId) }));
        conversation = unwrap(await api.arp('POST', { uri: '/conversations', body: { assistantId: assistantId,
          name: '平台消息：' + content.replace(/\s+/g, ' ').slice(0, 60), makeActive: false }, idempotencyKey: idempotencyKey + ':conversation' }));
        conversationId = conversation.topicId || conversation.id; active = null;
      }
      sessions[target.id] = { conversationId: conversationId }; await saveSessions();
      if (command === '/new') return sendText(response, '已切换到新会话，下一条消息将开始新的对话。');
      var result;
      if (active) {
        await trackReply(target, message, { conversationId: conversationId, generationId: active.generationId }, idempotencyKey, page);
        var interaction = active.pendingInteraction;
        if (active.state === 'waiting_user' && interaction) {
          var answer = content, index = /^\d+$/.test(command) ? Number(command) - 1 : -1;
          var choices = interaction.options || [], choice = choices[index] || choices.find(function (item) { return item.id === command || item.label === command; });
          if (choice) answer = { id: choice.id, label: choice.label };
          result = await api.conversation('RESOLVE_INTERACTION', { conversationId: conversationId, generationId: active.generationId,
            interactionId: interaction.interactionId, answer: answer });
        } else {
          result = await api.conversation('STEER_GENERATION', { conversationId: conversationId, generationId: active.generationId,
            commandId: idempotencyKey, message: { id: message.id, content: content, attachments: [] } });
          await sendText(response, '已收到补充指令，将在当前任务中继续处理。');
        }
      } else {
        var previous = replies.get(conversationId);
        if (previous) {
          await pumpReply(previous);
          // An in-flight read may predate the terminal snapshot; drain once more before replacing it.
          if (replies.get(conversationId) === previous) await pumpReply(previous);
          if (replies.get(conversationId) === previous) throw new Error(previous.blocked ? replyStatus(previous)
            : '上一轮回复尚未回传完毕，请稍后发送；/status 查看状态，/new 放弃回传并新建会话');
        }
        if (replies.size >= 32) throw new Error('等待助手回复的任务已满，本条消息未处理');
        var assistant = unwrap(await api.arp('GET', { uri: '/assistants/' + encodeURIComponent(target.kind === 'assistant' ? target.targetId : conversation.assistantId) }));
        var serviceId = conversation.modelServiceId || assistant.modelServiceId;
        if (!serviceId) serviceId = unwrap(await api.arp('GET', { uri: '/agent-settings' })).defaultModelServiceId;
        var settings = assistant.settings || {};
        var delivery = await trackReply(target, message, { conversationId: conversationId, assistantId: assistant.id, serviceId: serviceId }, idempotencyKey);
        try {
          result = await api.conversation('START_TURN', { schemaVersion: 1, commandId: idempotencyKey,
            conversationId: conversationId, assistantId: assistant.id, serviceId: serviceId,
            message: { id: message.id, content: content, attachments: [] },
            entry: { type: 'conversation', currentResource: '/conversations/' + encodeURIComponent(conversationId) },
            budgets: { maxModelRequests: Number(settings.maxIterations) || 30, maxIterations: Number(settings.maxIterations) || 30,
              maxToolCalls: Number(settings.maxToolCalls) || 100 },
            preferences: { streamOutput: true, contextCompression: settings.contextCompression === 'off' ? 'off' : 'auto' }, requestedAt: Date.now() });
          result.conversationId = conversationId; delivery.generationId = result.generationId;
          await saveReply(delivery);
        } finally {
          delivery.starting = false; scheduleReply(delivery, true);
        }
      }
      api.events.emit('messaging:triggered', { sourceId: target.sourceId, message: message, result: result });
    }
    function registerCapability(definition) {
      if (copyId) definition.permissions = ['plugins.execute'].concat(definition.permissions);
      return api.registerCapability(definition);
    }
    registerCapability({ id: 'accounts', label: '消息账号', description: '读取指定 MCP Server 的适配器示例及当前客户端的账号状态，不包含凭据；账号为空时可用 create-account 从零配置',
      safety: 'read', permissions: ['plugins.execute'], node: true,
      inputSchema: schema({ connectionId: text() }, ['connectionId']),
      execute: async function (input, call) { return unwrap(await call.serverArp(input.connectionId, 'GET', { uri: '/bots' })); } });
    registerCapability({ id: 'account-configuration', label: '读取账号配置',
      description: '读取当前客户端账号的配置摘要和 revision；不返回 config 或凭据，已有凭据仅在服务端配置页编辑',
      safety: 'read', permissions: ['plugins.execute'],
      inputSchema: schema({ connectionId: text(), accountId: text() }, ['connectionId', 'accountId']),
      execute: async function (input, call) {
        var account = unwrap(await call.serverArp(input.connectionId, 'GET', {
          uri: '/bots/accounts/' + encodeURIComponent(input.accountId) + '/configuration',
        }));
        // Older servers may still include credentials. Never expose them as a capability result.
        delete account.config;
        return account;
      } });
    registerCapability({ id: 'create-account', label: '创建服务端账号',
      description: '通过已配对的 WebSocket 从零配置 MCP Server 账号，无需 HTTP 令牌或独立配置页；自动授权当前客户端。保存后用 accounts 查看上线状态；结果未知时先查询，不得自动重试',
      safety: 'write', permissions: ['plugins.execute'],
      inputSchema: schema(accountProperties, accountRequired), execute: saveAccount });
    registerCapability({ id: 'update-account', label: '保存账号配置及启停',
      description: '修改当前客户端的 MCP Server 账号；先用 account-configuration 读取摘要及 revision，再提交完整参数。config 整体替换；没有完整参数时使用服务端配置页编辑。结果未知时先查询，不得自动重试',
      safety: 'write', permissions: ['plugins.execute'],
      inputSchema: schema(Object.assign({}, accountProperties, { accountId: text(), revision: revisionSchema }),
        accountRequired.concat(['accountId', 'revision'])), execute: saveAccount });
    registerCapability({ id: 'delete-account', label: '删除服务端账号',
      description: '删除当前客户端的账号、全部消息历史及消费者进度，并停止收信；不可恢复，必须提供最近读取的 revision。结果未知时先查询，不得自动重试',
      safety: 'write', permissions: ['plugins.execute'],
      inputSchema: schema({ connectionId: text(), accountId: text(), revision: revisionSchema }, ['connectionId', 'accountId', 'revision']),
      execute: async function (input, call) {
        return unwrap(await call.serverArp(input.connectionId, 'DELETE', {
          uri: '/bots/accounts/' + encodeURIComponent(input.accountId), body: { revision: input.revision },
          idempotencyKey: call.idempotencyKey,
        }));
      } });
    registerCapability({ id: 'events', label: '收到的消息', description: '读取持久消息历史，默认最近 50 条；after=0 从头分页；只读，不会重新触发流程',
      safety: 'read', permissions: ['plugins.execute'], node: true,
      inputSchema: schema({ connectionId: text(), accountId: text(), after: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['connectionId', 'accountId']),
      execute: async function (input, call) {
        var query = new URLSearchParams();
        if (input.after !== undefined) query.set('after', input.after);
        if (input.limit !== undefined) query.set('limit', input.limit);
        return unwrap(await call.serverArp(input.connectionId, 'GET', { uri: '/bots/accounts/' + encodeURIComponent(input.accountId) + '/events'
          + (query.size ? '?' + query.toString() : '') }));
      } });
    registerCapability({ id: 'send', label: '发送平台消息', description: '通过指定账号发送纯文本。direct=true 时 targetId 为用户 ID，否则为频道或群 ID；结果未知时不得自动重试',
      safety: 'write', permissions: ['plugins.execute'], node: true,
      inputSchema: schema({ connectionId: text(), accountId: text(), targetId: text(), text: text(16000),
        direct: { type: 'boolean' }, selfId: text(), platform: text(80), guildId: text(),
        replyTo: { type: 'string', minLength: 1, maxLength: 200, description: '收到的消息事件 id；从持久历史恢复回复目标；平台回复有效期仍适用' } }, ['connectionId', 'accountId', 'targetId', 'text']),
      execute: async function (input, call) {
        var body = Object.assign({}, input); delete body.connectionId; delete body.accountId;
        return unwrap(await call.serverArp(input.connectionId, 'POST', { uri: '/bots/accounts/' + encodeURIComponent(input.accountId) + '/messages',
          body: body, idempotencyKey: crypto.randomUUID() }));
      } });
    function receiveMessage(event, unmatched) {
      // Only the host's platform delivery may supply the source identity.
      if (event.pluginId !== 'messaging') return;
      var value = event.data;
      signal.throwIfAborted();
      if (!value || typeof value.text !== 'string' || !value.text) return;
      var plain = value.text.replace(/^(?:\s*<at\b[^>]*\/>)+\s*/, '').trim();
      var operation = plain.startsWith('/') ? value.command && value.command.name : 'chat';
      if (unmatched) {
        if (!plain.startsWith('/') || config && config.unmatchedCommand === 'ignore'
          || !authorizations.some(function (authorization) { return matchesAccount(authorization, value); })) return;
      } else if (value.command && value.command.error || !isAuthorized(value, operation)) return;
      if (pending >= 32) { api.events.emit('messaging:trigger-error', { message: value, error: '消息处理队列已满，本条未执行' }); return true; }
      pending++;
      var work = queue.then(async function () {
        signal.throwIfAborted();
        var source = {};
        sourceFields.forEach(function (key) {
          source[key] = value[key];
        });
        source.id = await root.AgentResourceProtocol.sha256(JSON.stringify(source));
        var idempotencyKey = await root.AgentResourceProtocol.sha256(JSON.stringify([copyId || 'messaging', source.id, value.id]));
        try {
          if (unmatched) await sendText(replyState(source, value, idempotencyKey + ':unmatched'), '未匹配到可用指令：指令不存在、未开启或格式不正确。');
          else await handleBuiltin(source, value, idempotencyKey);
        } catch (error) {
          if (signal.aborted) return;
          api.events.emit('messaging:trigger-error', { sourceId: source.id, message: value, error: error.message });
          if (!error.platformSend) {
            try { await sendText(replyState(source, value, idempotencyKey + ':error'), '消息处理未完成：' + error.message.slice(0, 500)); }
            catch (sendError) { if (!signal.aborted) api.events.emit('messaging:trigger-error', { sourceId: source.id, message: value, stage: 'reply', error: sendError.message }); }
          }
        }
      });
      queue = work.catch(function (error) {
        if (!signal.aborted) api.events.emit('messaging:trigger-error', { message: value, stage: 'reply', error: error.message });
      }).finally(function () { pending--; });
      return true;
    }
    api.events.on('messaging:dispatch', function (event) { return receiveMessage(event, false); });
    api.events.on('messaging:unmatched', function (event) { return receiveMessage(event, true); });
  }
  root.PageAgentMessagingPlugin = Object.freeze({
    id: 'messaging', name: '平台消息', version: '1.0.0', apiVersion: 1, enabled: true, priority: -100,
    description: '按账号与指令授权处理平台消息，未配置授权时不执行；默认低优先级，可调整优先级',
    sourcePath: 'builtin-plugins/messaging.js',
    resourceTypes: resourceTypes,
    config: { authorizations: [], unmatchedCommand: 'reply' }, configSchema: schema({
      authorizations: { type: 'array', title: '接受的账号', format: 'message-accounts', maxItems: 100, items: authorizationSchema,
        description: '选择账号并开启允许的指令，适用于该账号的所有发送者和会话；未选择账号时不处理消息，未开启的指令不执行。群聊结果会回复到原群。' },
      unmatchedCommand: { type: 'string', title: '未匹配指令', default: 'reply',
        oneOf: [{ const: 'reply', title: '回复未匹配提示' }, { const: 'ignore', title: '不回复' }],
        description: '指令消息在所有插件都未接管后，向已选择的账号回复未匹配提示；未设置时默认回复。' },
    }, []),
    plugin: { name: 'page-agent-messaging', apply: apply },
  });
  if (typeof module === 'object' && module.exports) module.exports = root.PageAgentMessagingPlugin;
})(globalThis);
