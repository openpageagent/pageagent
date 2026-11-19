'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const arp = require('../resources/protocol');
const { atomicJson } = require('./state-lock');
const catalog = require('./bot-adapters');
const { ACCOUNT } = require('./bot-resource');
const { installWecomCallback } = require('./bot-wecom-callback');
const { BotEventStore } = require('./bot-event-store');
const { installMailReceiver } = require('./bot-mail-receiver');
const mailSettings = require('../settings/mail-settings');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, performed = 'no') => { throw arp.arpError(code, message, { performed }); };
const exported = value => value.default || value;
function smtpConfig(config) {
  return mailSettings.validate({ host: config.smtp?.host,
    port: config.smtp?.port === undefined ? config.smtp?.tls === false ? 25 : 465 : config.smtp.port,
    security: config.smtp?.tls === false ? 'starttls' : 'tls', username: config.username,
    password: config.password, from: config.selfId || config.username, fromName: config.name });
}

class BotService {
  constructor(server) {
    this.server = server;
    this.file = path.join(server.auth.directory, 'bot-accounts.json');
    this.accounts = new Map(); this.live = new Map(); this.roots = new Map(); this.storageErrors = new Map();
    this.queue = Promise.resolve(); this.closed = false; this.pendingReplies = new Set();
  }
  async init() {
    this.eventStore = new BotEventStore(this.server.auth.directory);
    let state;
    try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('无法读取机器人账号配置'); }
    if (state.version !== 1 || !Array.isArray(state.accounts) || state.accounts.length > 20) throw new Error('机器人账号配置格式无效');
    for (const item of state.accounts) {
      catalog.definition(item.adapter);
      item.authorizedClientIds ??= item.ownerClientId ? [item.ownerClientId] : [];
      if (!item.id || this.accounts.has(item.id) || !Array.isArray(item.authorizedClientIds)
        || item.authorizedClientIds.some(id => typeof id !== 'string' || !id)) throw new Error('机器人账号身份无效');
      delete item.ownerClientId;
      this.accounts.set(item.id, item);
    }
    // Start asynchronously: an unavailable platform must not delay MCP startup.
    for (const item of this.accounts.values()) if (item.enabled) this.start(item);
  }
  engine() {
    if (this.koishi) return this.koishi;
    // The facade also exports the disk-based plugin loader; fixed adapters only
    // need core, which can be included in the single-file server bundle.
    const koishi = require('@koishijs/core');
    // Adapter HTTP errors can contain Authorization headers or temporary tokens.
    // Keep diagnostics to account/type; never print upstream request objects.
    koishi.Logger.targets = [{ levels: { base: 2 }, record: log => {
      const live = this.roots.get(log.meta?.ctx?.root);
      if (live && log.type === 'error') live.error = '适配器连接或操作失败，请检查平台权限、配置与网络';
    } }];
    this.koishi = koishi;
    return koishi;
  }
  visible(item, context) { return !context.sourceIdentity || item.authorizedClientIds.includes(context.sourceIdentity.clientId); }
  account(id, context) {
    const item = this.accounts.get(id);
    if (!item || !this.visible(item, context)) fail('RESOURCE_NOT_FOUND', '机器人账号不存在');
    return item;
  }
  summary(item) {
    const live = this.live.get(item.id), bots = live?.ctx ? Array.from(live.ctx.bots) : [];
    const online = bots.some(bot => bot.status === this.koishi?.Universal.Status.ONLINE);
    const offline = live?.started && bots.length && bots.every(bot => bot.status === this.koishi?.Universal.Status.OFFLINE);
    return { id: item.id, name: item.name, adapter: item.adapter, enabled: item.enabled, revision: item.revision,
      receiveEnabled: item.receiveEnabled !== false,
      autoReply: copy(item.autoReply || { enabled: false, text: '' }),
      lastReceivedAt: this.eventStore.history(item.id, { limit: 1 }).items[0]?.timestamp || null,
      state: !item.enabled ? 'disabled' : this.storageErrors.has(item.id) || live?.receiveError ? 'failed'
        : item.adapter === 'mail' && item.receiveEnabled === false ? 'ready' : online ? 'online' : live?.error || offline ? 'failed' : 'connecting',
      error: this.storageErrors.get(item.id) || live?.receiveError || (online ? '' : live?.error || (offline ? '账号离线，请核对平台配置和网络' : '')),
      bots: bots.map(bot => ({ platform: bot.platform, selfId: bot.selfId || '', status: bot.status })),
      callback: item.callback || null, authorizedClientIds: [...item.authorizedClientIds] };
  }
  list(context) { return { adapters: catalog.catalog(), items: [...this.accounts.values()].filter(item => this.visible(item, context)).map(item => this.summary(item)) }; }
  async clients(context) {
    if (context.sourceIdentity) fail('FORBIDDEN', '请在服务端独立配置页管理客户端授权');
    const clients = new Map();
    for (const pairing of await this.server.auth.list()) {
      if (pairing.revokedAt) continue;
      const connected = this.server.clients.get(pairing.clientId);
      clients.set(pairing.clientId, { clientId: pairing.clientId, incognito: pairing.incognito,
        name: connected?.clientInfo?.clientName || pairing.clientName || pairing.clientId, online: connected?.state === 'ready' });
    }
    return { items: [...clients.values()] };
  }
  settings(id, context) {
    const item = this.account(id, context);
    // Browser pairing permits account use, not credential export to message senders.
    return context.sourceIdentity ? this.summary(item) : { ...this.summary(item), config: copy(item.config) };
  }
  exportSettings() {
    return [...this.accounts.values()].map(({ revision, ...item }) => copy(item));
  }
  async importSettings(items, revisions) {
    return this.mutate(async () => {
      if (!Array.isArray(items) || items.length > 20 || !Array.isArray(revisions) || revisions.length > 20
        || revisions.some(item => !item || typeof item.id !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1)) fail('INVALID_REQUEST', '账号备份格式无效');
      const expected = new Map(revisions.map(item => [item.id, item.revision]));
      if (expected.size !== revisions.length || expected.size !== this.accounts.size
        || [...this.accounts.values()].some(item => expected.get(item.id) !== item.revision)) fail('PRECONDITION_FAILED', '账号配置已变化，请重新导入');
      const active = new Set((await this.server.auth.list()).filter(pairing => !pairing.revokedAt).map(pairing => pairing.clientId));
      const next = new Map(this.accounts), imported = new Set();
      let removedAuthorizations = 0;
      for (const entry of items) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_REQUEST', '账号备份条目无效');
        const { id, ...input } = entry;
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || imported.has(id)
          || !arp.validateJsonSchema(ACCOUNT, input).valid || !input.name.trim()
          || Object.hasOwn(input, 'ownerClientId') || Object.hasOwn(input, 'revision')) fail('INVALID_REQUEST', '账号备份包含无效字段或重复 ID');
        const previous = this.accounts.get(id);
        if (previous && previous.adapter !== input.adapter) fail('RESOURCE_CONFLICT', '同 ID 账号的平台不同，无法合并');
        const authorized = input.authorizedClientIds || [];
        const authorizedClientIds = authorized.filter(clientId => active.has(clientId));
        removedAuthorizations += authorized.length - authorizedClientIds.length;
        next.set(id, { id, name: input.name.trim(), adapter: input.adapter, enabled: input.enabled, config: copy(input.config),
          receiveEnabled: input.adapter === 'mail' ? input.receiveEnabled !== false : true,
          autoReply: copy(input.autoReply || { enabled: false, text: '' }), callback: input.callback || null,
          authorizedClientIds, revision: (previous?.revision || 0) + 1 });
        imported.add(id);
      }
      if (next.size > 20) fail('RESOURCE_BUSY', '导入后超过 20 个账号，请先删除不需要的账号');
      for (const id of imported) this.validateAccount(next.get(id), next);
      if (!imported.size) return { imported: 0, removedAuthorizations: 0 };
      await atomicJson(this.file, { version: 1, accounts: [...next.values()] });
      this.accounts = next;
      // Stop all changed listeners before starting any, including swapped ports.
      const ids = [...imported], stopped = await Promise.allSettled(ids.map(id => this.stop(id)));
      ids.forEach((id, index) => {
        if (stopped[index].status === 'rejected') this.storageErrors.set(id, '配置已导入，账号重启失败，请检查服务状态后重新启用');
        else if (next.get(id).enabled) this.start(next.get(id));
        this.changed(id);
      });
      return { imported: imported.size, removedAuthorizations, restartFailures: stopped.filter(result => result.status === 'rejected').length };
    });
  }
  validateAccount(item, accounts = this.accounts) {
    catalog.definition(item.adapter);
    if (item.autoReply.enabled && !item.autoReply.text.trim()) fail('INVALID_REQUEST', '启用固定回复时请填写回复内容');
    if (item.autoReply.enabled && item.adapter === 'mail') fail('INVALID_REQUEST', '邮件请通过手动回复或扩展流程处理');
    if (JSON.stringify(item.config).length > 65536) fail('INVALID_REQUEST', '账号配置过大');
    if (item.adapter === 'lark' && item.config.platform !== 'feishu') fail('INVALID_REQUEST', '本期飞书适配器 platform 必须为 feishu');
    if (item.adapter === 'dingtalk' && item.config.protocol !== 'ws') fail('INVALID_REQUEST', '钉钉适配器本期使用 Stream（protocol: ws）');
    if (item.enabled) {
      if (item.adapter === 'wecom-aibot' && [...accounts.values()].some(other => other.id !== item.id
        && other.enabled && other.adapter === item.adapter && other.config.botId === item.config.botId)) {
        fail('RESOURCE_CONFLICT', '此 BotID 已有启用的智能机器人账号，请先停用原账号');
      }
      try {
        if (item.adapter === 'mail') smtpConfig(item.config);
        if (item.adapter !== 'mail' || item.receiveEnabled) this.engine().resolveConfig(catalog.load(item.adapter), item.config);
      }
      catch (_) { fail('INVALID_REQUEST', '适配器配置无效，请核对账号参数及平台说明'); }
      if (catalog.needsCallback(item.adapter, item.config) && !item.callback) fail('INVALID_REQUEST', '此接收方式需要回调监听配置');
      if (item.callback && [...accounts.values()].some(other => other.id !== item.id && other.enabled && other.callback?.port === item.callback.port)) {
        fail('RESOURCE_CONFLICT', '此回调端口已被其他账号占用，请选择独立端口');
      }
    }
  }
  events(id, context, query) {
    this.account(id, context);
    return this.eventStore.history(id, query);
  }
  sources(id, context) {
    this.account(id, context);
    return this.eventStore.sources(id);
  }
  consumerOwner(context) { return context.sourceIdentity ? 'client:' + context.sourceIdentity.clientId : 'http:operator'; }
  pull(id, input, context) {
    this.account(id, context);
    return this.eventStore.pull(id, this.consumerOwner(context), input.consumerId, input.limit);
  }
  acknowledge(id, input, context) {
    this.account(id, context);
    return this.eventStore.acknowledge(id, this.consumerOwner(context), input.consumerId, input.receipt);
  }
  removeConsumer(id, consumerId, context) {
    this.account(id, context);
    return this.eventStore.removeConsumer(id, this.consumerOwner(context), consumerId);
  }
  changed(id) {
    this.server.httpHandler?.resourceUpdated('/bots');
    if (id) this.server.httpHandler?.resourceUpdated('/bots/accounts/' + encodeURIComponent(id) + '/events');
  }
  mutate(work) {
    const next = this.queue.then(() => { if (this.closed) fail('TEMPORARILY_UNAVAILABLE', '服务端正在关闭'); return work(); });
    this.queue = next.catch(() => {}); return next;
  }
  async save(id, input, context) {
    return this.mutate(async () => {
      const previous = id ? this.account(id, context) : null;
      if (previous && previous.revision !== input.revision) fail('PRECONDITION_FAILED', '账号配置已变化，请刷新后编辑');
      if (!previous && this.accounts.size >= 20) fail('RESOURCE_BUSY', '最多支持 20 个机器人账号');
      let authorizedClientIds = previous ? [...previous.authorizedClientIds] : context.sourceIdentity ? [context.sourceIdentity.clientId] : [];
      if (Object.hasOwn(input, 'ownerClientId') && Object.hasOwn(input, 'authorizedClientIds')) fail('INVALID_REQUEST', '请只提交 authorizedClientIds');
      const requested = input.authorizedClientIds ?? (Object.hasOwn(input, 'ownerClientId') ? input.ownerClientId ? [input.ownerClientId] : [] : null);
      if (requested && (requested.length !== authorizedClientIds.length || requested.some(id => !authorizedClientIds.includes(id)))) {
        if (context.sourceIdentity) fail('FORBIDDEN', '只有服务端操作者可以修改客户端授权');
        const active = new Set((await this.server.auth.list()).filter(pairing => !pairing.revokedAt).map(pairing => pairing.clientId));
        if (requested.some(id => !active.has(id))) fail('INVALID_REQUEST', '请选择有效的已配对客户端');
        authorizedClientIds = [...requested];
      }
      const item = { id: previous?.id || randomUUID(), authorizedClientIds,
        name: input.name, adapter: input.adapter, enabled: input.enabled, config: copy(input.config),
        receiveEnabled: input.adapter === 'mail' ? input.receiveEnabled ?? previous?.receiveEnabled ?? true : true,
        autoReply: copy(input.autoReply || previous?.autoReply || { enabled: false, text: '' }),
        callback: input.callback || null, revision: (previous?.revision || 0) + 1 };
      this.validateAccount(item);
      const next = new Map(this.accounts); next.set(item.id, item);
      await atomicJson(this.file, { version: 1, accounts: [...next.values()] });
      this.accounts = next;
      await this.stop(item.id);
      if (item.enabled) this.start(item);
      this.changed(item.id);
      return this.summary(item);
    });
  }
  async remove(id, revision, context) {
    return this.mutate(async () => {
      const item = this.account(id, context);
      if (item.revision !== revision) fail('PRECONDITION_FAILED', '账号配置已变化，请刷新');
      const next = new Map(this.accounts); next.delete(id);
      await atomicJson(this.file, { version: 1, accounts: [...next.values()] });
      this.accounts = next; await this.stop(id);
      this.eventStore.removeAccount(id); this.changed(id); return { deleted: true };
    });
  }
  start(item) {
    this.storageErrors.delete(item.id);
    if (item.adapter === 'mail' && item.receiveEnabled === false) return;
    const live = { ctx: null, error: '', replies: new Map(), sending: 0, starting: null };
    this.live.set(item.id, live);
    try {
      const { Context } = this.engine();
      const ctx = live.ctx = new Context(); this.roots.set(ctx, live);
      ctx.plugin(exported(require('@koishijs/plugin-http')), { timeout: 30000 });
      if (catalog.needsCallback(item.adapter, item.config)) {
        if (!item.callback) throw new Error('Callback configuration required');
        ctx.plugin(exported(require('@koishijs/plugin-server')), { ...item.callback, maxPort: item.callback.port });
      }
      if (item.adapter === 'wecom') installWecomCallback(ctx);
      if (item.adapter === 'mail') installMailReceiver(ctx, session => this.receive(item, live, session), message => {
        if (this.live.get(item.id) !== live) return;
        live.receiveError = message; this.changed();
      });
      ctx.on('internal/error', () => { live.error = '适配器启动或连接失败，请核对配置、回调端口和网络'; });
      ctx.on('message', session => this.receive(item, live, session));
      ctx.on('bot-status-updated', () => this.changed());
      live.fork = ctx.plugin(catalog.load(item.adapter), copy(item.config));
      live.starting = ctx.start().catch(() => { live.error = '适配器启动失败，请核对配置、端口和网络'; })
        .finally(() => { live.started = true; });
    } catch (_) { live.error = '适配器加载失败，请核对账号配置及服务端版本'; }
  }
  receive(item, live, session) {
    if (this.closed || this.live.get(item.id) !== live || !this.accounts.get(item.id)?.enabled) return false;
    if (!session.userId || session.userId === session.selfId || session.event?.user?.isBot) return true;
    const messageId = String(session.messageId || '');
    const id = messageId ? createHash('sha256').update(JSON.stringify([item.id, session.platform, session.selfId, messageId])).digest('hex') : randomUUID();
    const event = { id, accountId: item.id, platform: String(session.platform || item.adapter).slice(0, 80),
      selfId: String(session.selfId || '').slice(0, 500), userId: String(session.userId).slice(0, 500),
      channelId: String(session.channelId || '').slice(0, 500), guildId: String(session.guildId || '').slice(0, 500),
      userName: String(session.event?.user?.name || session.username || '').slice(0, 200),
      channelName: String(session.event?.channel?.name || session.event?.guild?.name || '').slice(0, 200),
      messageId: messageId.slice(0, 500), text: String(session.content || '').slice(0, 16000),
      direct: !!session.isDirect, timestamp: Date.now(),
      ...(item.autoReply?.enabled ? { autoReply: { state: 'pending' } } : {}) };
    const command = /^\/([a-zA-Z\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_-]{0,59})(?:\s+([\s\S]*))?$/.exec(event.text.replace(/^(?:\s*<at\b[^>]*\/>)+\s*/, '').trim());
    if (command) {
      const { Argv, Command, h } = this.engine();
      const input = command[2] || '';
      // Use Koishi's quoting/token rules, but never execute message interpolation.
      // Commands are bound to local resources by the authorized browser plugin.
      try {
        const tokens = Argv.parse(input).tokens;
        if (tokens.length > 100) throw new Error('Too many command arguments');
        const args = tokens.map(token => { Argv.revert(token); return h.unescape(token.content); });
        event.command = { name: Command.normalize(command[1]), text: h.unescape(input), args };
      } catch (_) {
        event.command = { name: Command.normalize(command[1]), text: h.unescape(input), args: [], error: '指令参数无法解析，最多支持 100 个参数' };
      }
    }
    try {
      if (!this.eventStore.append(event, Number.isFinite(session.timestamp) ? session.timestamp : event.timestamp)) return true;
    } catch (_) {
      this.storageErrors.set(item.id, '消息写入磁盘失败，账号已停止；请检查磁盘空间和状态目录后重新启用');
      this.stop(item.id).catch(() => {});
      console.error('[Bot] 消息持久化失败，账号已停止：' + item.id);
      this.changed(item.id);
      return false;
    }
    this.changed(item.id);
    // Retain only the fields needed for a platform reply, never email attachments
    // or upstream HTTP objects. QQ also keeps its reply sequence on this session.
    live.replies.set(id, session.bot.session({ type: 'message', timestamp: session.timestamp || event.timestamp,
      user: { id: event.userId }, channel: { id: event.channelId, type: event.direct ? 1 : 0 },
      guild: event.guildId ? { id: event.guildId } : undefined, message: { id: event.messageId } }));
    if (live.replies.size > 50) live.replies.delete(live.replies.keys().next().value);
    if (item.autoReply?.enabled) {
      const pending = this.autoReply(item, live, event).finally(() => this.pendingReplies.delete(pending));
      this.pendingReplies.add(pending);
    }
    for (const clientId of item.authorizedClientIds) {
      const record = this.server.clients.get(clientId);
      if (!record || record.state !== 'ready') continue;
      this.server.auth.assertActive(record.identity).then(() => {
        if (this.closed || this.live.get(item.id) !== live || record.state !== 'ready'
          || !this.accounts.get(item.id)?.authorizedClientIds.includes(clientId)) return;
        this.server.send(record.socket, { type: 'bot.event', event });
      }).catch(() => {});
    }
    return true;
  }
  async autoReply(item, live, event) {
    const context = { actorId: 'server:auto-reply' };
    const audit = { transportSessionId: 'server:auto-reply', requestId: randomUUID(), operation: 'bot.auto-reply',
      principal: { transport: 'internal', id: context.actorId }, parameters: { accountId: item.id, eventId: event.id } };
    let result;
    try {
      await this.server.audit.write('execution.intent', audit);
      if (this.closed || this.live.get(item.id) !== live || this.accounts.get(item.id) !== item) {
        fail('PRECONDITION_FAILED', '账号已停用或重新配置，本条未自动回复');
      }
      const sent = await this.send(item.id, { replyTo: event.id, targetId: event.direct ? event.userId : event.channelId,
        direct: event.direct, text: item.autoReply.text }, context);
      result = { state: 'sent', messageIds: sent.messageIds };
    } catch (error) {
      result = { state: error.performed === 'unknown' ? 'unknown' : 'failed',
        error: error instanceof arp.ArpError ? error.message : '自动回复未发送，请检查服务端审计与账号状态' };
    }
    await this.server.audit.bestEffort('execution.finished', { ...audit,
      receipt: { performed: result.state === 'sent' ? 'yes' : result.state === 'unknown' ? 'unknown' : 'no' },
      errorReason: result.state === 'sent' ? null : 'AUTO_REPLY_' + result.state.toUpperCase() });
    try {
      this.eventStore.recordAutoReply(item.id, event.id, { ...result, timestamp: Date.now() });
    } catch (_) {
      this.storageErrors.set(item.id, '自动回复结果写入失败，请检查平台记录和磁盘状态；不会自动重试');
      if (this.live.get(item.id) === live) await this.stop(item.id).catch(() => {});
    }
    this.changed(item.id);
  }
  async send(id, input, context) {
    const item = this.account(id, context), live = this.live.get(id);
    if (item.adapter === 'mail') {
      const saved = input.replyTo && this.eventStore.find(id, input.replyTo);
      if (input.replyTo && !saved) fail('RESOURCE_NOT_FOUND', '回复消息不存在');
      if (saved && saved.event.userId !== input.targetId) fail('INVALID_REQUEST', '回复目标与收到的消息不一致');
      if (input.direct !== true) fail('INVALID_REQUEST', '邮件使用 direct=true，targetId 为邮箱地址');
      const result = await this.sendMail(id, { to: input.targetId, subject: item.config.subject || 'Page Agent', body: input.text }, context);
      return { messageIds: [result.messageId], accountId: id };
    }
    let reply = input.replyTo && live?.replies.get(input.replyTo);
    if (input.replyTo && !reply && live?.ctx) {
      const saved = this.eventStore.find(id, input.replyTo);
      const bot = saved && Array.from(live.ctx.bots).find(bot => bot.platform === saved.event.platform && bot.selfId === saved.event.selfId);
      if (bot) {
        const event = saved.event;
        reply = bot.session({ type: 'message', timestamp: saved.sourceTimestamp, user: { id: event.userId },
          channel: { id: event.channelId, type: event.direct ? 1 : 0 },
          guild: event.guildId ? { id: event.guildId } : undefined, message: { id: event.messageId } });
        live.replies.set(input.replyTo, reply);
        if (live.replies.size > 50) live.replies.delete(live.replies.keys().next().value);
      }
    }
    if (input.replyTo && !reply) fail('RESOURCE_NOT_FOUND', '回复消息不存在或原机器人尚未上线');
    const direct = reply ? reply.isDirect : !!input.direct;
    if (reply && (input.targetId !== (direct ? reply.userId : reply.channelId)
      || input.direct !== undefined && input.direct !== direct)) fail('INVALID_REQUEST', '回复目标与收到的消息不一致');
    const bot = reply ? reply.bot : live?.ctx && Array.from(live.ctx.bots).find(bot =>
      bot.platform === (input.platform || (item.adapter === 'lark' ? 'feishu' : item.adapter)) && (!input.selfId || bot.selfId === input.selfId));
    if (!item.enabled || !bot || bot.status !== this.koishi.Universal.Status.ONLINE) fail('TEMPORARILY_UNAVAILABLE', '机器人账号未上线');
    if (live.sending >= 4) fail('RESOURCE_BUSY', '此账号的发送请求过多');
    if (context.abortSignal?.aborted) fail('INVALID_REQUEST', '发送已取消');
    if (item.adapter === 'wecom' && !direct) fail('INVALID_REQUEST', '企微应用消息使用 direct=true，targetId 为成员 ID');
    live.sending++;
    try {
      const channelId = reply ? reply.channelId
        : direct && bot.platform === 'qqguild' ? (await bot.createDirectChannel(input.targetId, input.guildId)).id : input.targetId;
      if (context.abortSignal?.aborted || this.closed || this.accounts.get(id) !== item || this.live.get(id) !== live) {
        fail('PRECONDITION_FAILED', '发送已取消或账号已重新配置');
      }
      const session = reply || bot.session({ type: 'send', user: direct ? { id: input.targetId } : undefined,
        channel: { id: channelId, type: direct ? 1 : 0 }, guild: input.guildId ? { id: input.guildId } : undefined });
      const messages = await bot.sendMessage(channelId, this.koishi.h.text(input.text), undefined, { session });
      if (!Array.isArray(messages) || !messages.length) fail('UPSTREAM_FAILED', '平台未返回消息回执', 'unknown');
      return { messageIds: messages, accountId: id };
    } catch (error) {
      if (error instanceof arp.ArpError) throw error;
      fail('UPSTREAM_FAILED', '消息发送未确认，请先检查平台记录，勿自动重试', 'unknown');
    }
    finally { live.sending--; }
  }
  async stop(id) {
    const live = this.live.get(id); if (!live) return;
    this.live.delete(id);
    if (!live.ctx) return;
    // Detach first so a late platform event cannot trigger a disabled account.
    // Let pending startup hooks finish before closing the resources they open.
    await live.starting;
    const bots = Array.from(live.ctx.bots);
    await Promise.allSettled(bots.map(async bot => {
      await bot.stop();
      // adapter-mail 2.3.2 exposes stop(), but does not implement disconnect().
      if (bot.platform === 'mail') { bot.adapter?.stop(); bot.internal?.transporter?.close(); }
      bot.offline();
    }));
    // Dispose the adapter while Satori's bot registry is still available.
    // Root shutdown otherwise removes it before QQ's disposal hook calls stop().
    live.fork?.dispose();
    const listener = live.ctx.server?._http;
    const closed = listener?.listening ? new Promise(resolve => listener.once('close', resolve)) : Promise.resolve();
    await live.ctx.stop();
    listener?.closeAllConnections();
    await closed;
    this.roots.delete(live.ctx);
  }
  async sendMail(id, input, context) {
    const pending = this.deliverMail(id, input, context);
    this.server.mailRequests.add(pending);
    try { return await pending; } finally { this.server.mailRequests.delete(pending); }
  }
  async deliverMail(id, input, context) {
    if (this.closed || this.server.closing) fail('TEMPORARILY_UNAVAILABLE', '服务端正在关闭');
    const item = this.account(id, context);
    if (item.adapter !== 'mail') fail('INVALID_REQUEST', '此账号不是邮件账号');
    if (!item.enabled) fail('TEMPORARILY_UNAVAILABLE', '邮件账号未启用');
    let payload;
    try {
      payload = { config: smtpConfig(item.config),
        message: mailSettings.prepareMessage(input) };
    } catch (error) { fail('INVALID_REQUEST', error.message); }
    const auditContext = { transportSessionId: context.sessionId || 'http:operator', requestId: randomUUID(),
      parentRequest: context.parentRequest || null, operation: 'bot.mail',
      principal: { transport: context.sourceIdentity ? 'websocket' : 'http', id: context.actorId },
      parameters: { accountId: id }, decision: 'allow' };
    let sending = false, result, failure;
    try {
      result = await this.server.mailQueue.enqueue(payload, { signal: context.abortSignal,
        beforeSend: async () => {
          const current = this.account(id, context);
          if (!current.enabled || current.revision !== item.revision) fail('PRECONDITION_FAILED', '邮件账号已停用或重新配置，邮件尚未发送');
          if (context.sourceIdentity) await this.server.auth.assertActive(context.sourceIdentity);
          await this.server.audit.write('execution.intent', auditContext);
          if (this.closed || this.server.closing || this.account(id, context) !== item) fail('PRECONDITION_FAILED', '邮件账号或服务状态已变化，邮件尚未发送');
          sending = true;
        } });
    } catch (error) { failure = error; }
    const performed = failure ? failure.performed || (sending ? 'unknown' : 'no') : 'yes';
    const recorded = await this.server.audit.bestEffort('execution.finished', { ...auditContext, receipt: { performed },
      errorReason: failure ? (performed === 'no' ? 'MAIL_NOT_SENT' : 'MAIL_DELIVERY_UNKNOWN') : null });
    if (failure) throw arp.arpError(failure.code || 'UPSTREAM_FAILED', failure.message, { performed, retryable: false, details: { audit: { recorded } } });
    return { ...result, audit: { recorded } };
  }
  async close() {
    this.closed = true; await this.queue;
    await Promise.allSettled(this.pendingReplies);
    await Promise.allSettled([...this.live.keys()].map(id => this.stop(id)));
    this.eventStore?.close();
  }
}
module.exports = { BotService };
