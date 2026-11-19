/* Field names match the bundled adapters. Unknown saved options are preserved. */
window.PlatformForms = {
  lark: {
    console: 'https://open.feishu.cn/app', docs: 'https://open.feishu.cn/document/',
    steps: ['创建企业自建应用，在「添加应用能力」中启用机器人。', '从「凭证与基础信息」复制 App ID 和 App Secret。', '在「事件与回调」选择长连接，订阅接收消息事件 im.message.receive_v1，开通所需消息权限并发布版本。'],
    fields: [
      { key: 'appId', label: 'App ID', required: true, hint: '凭证与基础信息 → 应用凭证' },
      { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
      { key: 'protocol', label: '接收方式', options: [['ws', '长连接（推荐）'], ['http', 'HTTP 回调']] },
      { key: 'verificationToken', label: 'Verification Token', type: 'password', callback: true, hint: '事件与回调 → 加密策略' },
      { key: 'encryptKey', label: 'Encrypt Key', type: 'password', callback: true },
      { key: 'verifyToken', label: '验证回调令牌', type: 'checkbox', callback: true },
      { key: 'verifySignature', label: '验证回调签名', type: 'checkbox', callback: true },
      { key: 'path', label: '回调路径', placeholder: '/feishu', callback: true },
    ],
  },
  dingtalk: {
    console: 'https://open-dev.dingtalk.com/', docs: 'https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description',
    steps: ['创建企业内部应用，添加机器人能力。', '从「凭证与基础信息」复制 Client ID（AppKey）、Client Secret 和 AgentId。', '机器人消息接收模式选择 Stream，配置可用范围并发布应用。'],
    fields: [
      { key: 'appkey', label: 'Client ID / AppKey', required: true },
      { key: 'secret', label: 'Client Secret / AppSecret', type: 'password', required: true },
      { key: 'agentId', label: 'AgentId', type: 'number', hint: '凭证与基础信息中的应用 AgentId' },
    ],
  },
  qq: {
    console: 'https://q.qq.com/', docs: 'https://bot.q.qq.com/wiki/',
    steps: ['在 QQ 开放平台创建官方机器人，从开发设置复制 AppID 和 AppSecret。', '按平台当前允许的接入方式选择 WebSocket 或 Webhook；Webhook 需要平台可访问的 HTTPS 回调地址。', '勾选已获平台授权的消息事件。沙箱模式下，先在开放平台添加测试用户、群或频道。'],
    fields: [
      { key: 'id', label: 'AppID', required: true },
      { key: 'secret', label: 'AppSecret', type: 'password', required: true },
      { key: 'type', label: '机器人类型', options: [['public', '公域机器人'], ['private', '私域机器人']], hint: '与开放平台申请的类型一致' },
      { key: 'protocol', label: '接收方式', options: [['websocket', 'WebSocket'], ['webhook', 'Webhook 回调']] },
      { key: 'sandbox', label: '沙箱模式', type: 'checkbox' },
      { key: 'intents', label: '消息事件', type: 'checks', hint: '只选择开放平台已授权的事件，至少选择一项', options: [
        ['USER_MESSAGE', 'QQ 单聊与群聊'], ['PUBLIC_GUILD_MESSAGES', '频道 @ 消息'],
        ['DIRECT_MESSAGES', '频道私信'], ['GUILD_MESSAGES', '频道全部消息（私域权限）'],
      ] },
      { key: 'path', label: '回调路径', placeholder: '/qq', callback: true },
    ],
  },
  wecom: {
    console: 'https://work.weixin.qq.com/wework_admin/frame', docs: 'https://developer.work.weixin.qq.com/document/path/90930',
    steps: ['在企业微信管理后台「我的企业」复制企业 ID，在「应用管理」创建自建应用。', '复制应用 AgentId 和 Secret，设置应用可见范围及企业可信 IP。', '在「接收消息」设置服务器 URL、Token 和 EncodingAESKey；先保存并启用此账号，再在官方后台验证 URL。'],
    fields: [
      { key: 'corpId', label: '企业 ID / CorpID', required: true },
      { key: 'agentId', label: 'AgentId', required: true },
      { key: 'secret', label: 'Secret', type: 'password', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true, hint: '接收消息 → API 接收中的 Token' },
      { key: 'aesKey', label: 'EncodingAESKey', type: 'password', required: true, hint: '接收消息 → 随机生成，43 位' },
    ],
  },
  'wecom-aibot': {
    console: 'https://work.weixin.qq.com/wework_admin/frame', docs: 'https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21661',
    steps: ['在企业微信创建智能机器人，选择 API 模式，通过长连接接入。', '复制机器人的 BotID 和 Secret，填写后保存并启用账号；无需配置公网回调地址。', '将机器人添加到会话，发送文本消息；群聊中 @ 机器人。一个机器人仅由一个服务实例连接。'],
    fields: [
      { key: 'botId', label: 'BotID', required: true, hint: '智能机器人的 BotID' },
      { key: 'secret', label: 'Secret', type: 'password', required: true, hint: '智能机器人的专属 Secret' },
    ],
  },
  mail: {
    console: 'https://mail.qq.com/', docs: 'https://service.mail.qq.com/',
    steps: ['在邮箱设置中开启 SMTP；需要接收邮件时同时开启 IMAP。', '填写邮箱服务商提供的服务器地址和端口，密码通常填写邮箱授权码。', '接收范围为 INBOX 未读邮件，包含启用前的未读邮件；写入服务端成功后标记已读。'],
    fields: [
      { key: 'username', label: '邮箱账号', required: true, placeholder: 'name@example.com' },
      { key: 'password', label: '授权码 / 密码', type: 'password', required: true },
      { key: 'smtp.host', label: 'SMTP 服务器', required: true, placeholder: 'smtp.example.com' },
      { key: 'smtp.port', label: 'SMTP 端口', type: 'number', required: true, min: 1, max: 65535 },
      { key: 'smtp.tls', label: 'SMTP 加密', type: 'boolean-select', options: [['true', 'TLS（通常 465）'], ['false', 'STARTTLS（通常 587）']] },
      { key: 'selfId', label: '发件地址', hint: '留空使用邮箱账号' },
      { key: 'name', label: '发件人名称' },
      { key: 'subject', label: '默认主题' },
      { key: 'imap.host', label: 'IMAP 服务器', receive: true, required: true, placeholder: 'imap.example.com' },
      { key: 'imap.port', label: 'IMAP 端口', type: 'number', receive: true, required: true, min: 1, max: 65535 },
      { key: 'imap.tls', label: 'IMAP 使用 TLS', type: 'checkbox', receive: true },
    ],
  },
};
