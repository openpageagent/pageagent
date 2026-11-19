'use strict';

const { randomUUID } = require('crypto');
const { Bot, Schema, Universal, h } = require('@koishijs/core');
const { WSClient } = require('@wecom/aibot-node-sdk');
const { arpError } = require('../resources/protocol');

// SDK owns authentication, heartbeats, reconnection and reply acknowledgements.
// This adapter only maps the existing text-message contract to that SDK.
class WecomAiBot extends Bot {
  constructor(ctx, config) {
    super(ctx, config, 'wecom-aibot');
    this.selfId = config.botId;
    this.replies = new Map();
    this.client = null;
  }

  async start() {
    if (this.client) return;
    this.status = Universal.Status.CONNECT;
    const client = this.client = new WSClient({
      botId: this.config.botId, secret: this.config.secret,
      maxReconnectAttempts: -1,
      // SDK diagnostics can include message bodies and temporary credentials.
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    client.on('authenticated', () => this.online());
    client.on('disconnected', () => { this.replies.clear(); this.offline(); });
    client.on('reconnecting', () => { this.status = Universal.Status.RECONNECT; });
    client.on('error', () => {
      this.logger.error('企业微信智能机器人连接或操作失败，请检查 BotID、Secret 和网络');
      if (!client.isConnected) this.offline();
    });
    client.on('message.text', frame => this.receive(frame));
    client.connect();
  }

  async stop() {
    const client = this.client;
    this.client = null;
    if (client) { client.removeAllListeners(); client.disconnect(); }
    this.replies.clear();
    this.offline();
  }

  receive(frame) {
    const body = frame.body;
    if (!body || body.aibotid !== this.selfId || typeof body.msgid !== 'string'
      || typeof body.from?.userid !== 'string' || typeof body.text?.content !== 'string'
      || !['single', 'group'].includes(body.chattype)) return;
    const direct = body.chattype === 'single';
    const channelId = direct ? body.from.userid : body.chatid;
    if (!body.msgid || !body.from.userid || typeof channelId !== 'string' || !channelId) return;
    // Retain just the correlation header; never persist the callback frame.
    if (typeof frame.headers?.req_id === 'string' && frame.headers.req_id && !this.replies.has(body.msgid)) {
      this.replies.set(body.msgid, { headers: { req_id: frame.headers.req_id }, channelId, receivedAt: Date.now() });
      if (this.replies.size > 50) this.replies.delete(this.replies.keys().next().value);
    }
    const session = this.session({ type: 'message', user: { id: body.from.userid },
      channel: { id: channelId, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
      message: { id: body.msgid, elements: [h.text(body.text.content)] } });
    this.dispatch(session);
  }

  async sendMessage(channelId, content, _referrer, options = {}) {
    if (!this.client || this.status !== Universal.Status.ONLINE) {
      throw arpError('TEMPORARILY_UNAVAILABLE', '企业微信智能机器人未上线', { performed: 'no' });
    }
    const elements = h.toElementArray(content);
    if (elements.some(element => element.type !== 'text')) {
      throw arpError('INVALID_REQUEST', '企业微信智能机器人当前仅支持文本消息', { performed: 'no' });
    }
    const text = elements.map(element => element.attrs.content).join('');
    const messageId = options.session?.messageId;
    const saved = this.replies.get(messageId);
    // The platform allows callback replies for 24 hours. History replies without
    // a cached header use proactive send; a failed send is never retried here.
    const reply = saved?.channelId === channelId && Date.now() - saved.receivedAt < 24 * 60 * 60 * 1000 ? saved : null;
    if (!text || Buffer.byteLength(text, 'utf8') > 20480) {
      throw arpError('INVALID_REQUEST', '消息不能为空，且最多支持 20480 个 UTF-8 字节', { performed: 'no' });
    }
    const ack = reply
      ? await this.client.replyStream(reply, randomUUID(), text, true)
      : await this.client.sendMessage(channelId, { chat_type: options.session?.isDirect ? 1 : 2,
        msgtype: 'markdown', markdown: { content: text } });
    if (ack?.errcode !== 0 || typeof ack.headers?.req_id !== 'string' || !ack.headers.req_id) {
      throw arpError('UPSTREAM_FAILED', '企业微信未返回有效回执，请检查平台记录，勿自动重试', { performed: 'unknown' });
    }
    // This protocol acknowledges req_id, rather than returning a message ID.
    return [ack.headers.req_id];
  }
}

WecomAiBot.Config = Schema.object({
  botId: Schema.string().pattern(/\S/).required(),
  secret: Schema.string().pattern(/\S/).role('secret').required(),
});

module.exports = WecomAiBot;
