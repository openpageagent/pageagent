# 平台消息插件

MCP Server 可独立收发平台消息。扩展内置“平台消息”插件提供账号管理、资源指令及自然语言对话，按账号和指令授权处理消息。

服务端已包含 Koishi 核心、平台适配器和配置页，无需另开 Koishi 服务。依赖许可见[第三方声明](../THIRD_PARTY_NOTICES.md)。

| 平台 | 接入方式 |
| --- | --- |
| 飞书 | 默认长连接 `ws`，支持 `http` 回调；`platform` 为 `feishu` |
| 钉钉 | 应用机器人的 Stream 模式，`protocol: "ws"` |
| QQ | 官方机器人 `websocket` 或 `webhook`，不支持个人账号 |
| 企业微信 | 企业自建应用加密回调，路径 `/wecom`；不支持个人微信或群机器人 webhook |
| 企业微信智能机器人 | API 模式长连接，BotID + Secret；无需公网回调地址 |
| 邮件 | SMTP 发送，可选 IMAP 接收 |

## 配置账号

**通过对话：** 在扩展「连接配置」配对并启用服务端，默认地址为 `ws://127.0.0.1:9999`。连接就绪且插件启用后，说明平台、目标连接和账号参数即可管理账号，新建账号归属当前客户端。

**通过独立配置页：**

1. 启动 MCP Server，打开 `http://127.0.0.1:9998/config`；自定义端口时使用实际地址。
2. 使用 HTTP Bearer 令牌登录，在「账号管理」点击“添加账号”。令牌由首次启动输出或 `PAGE_AGENT_HTTP_BEARER_TOKEN` 指定，与扩展配对密码不同。
3. 选择平台，填写账号参数，按需设置「收到消息后」「使用授权」，统一保存生效。
4. 进入账号管理时加载连接状态。「配置」用于编辑账号，「消息」用于查看消息、来源和回复结果，也可手动回复。

最多保存 20 个账号，可独立启停。HTTP 操作者管理全部账号及授权，配对客户端只能管理获授权的账号。普通与隐身环境分别授权；实时消息投递给所有已授权且在线的客户端，可能由多个客户端分别处理。页面访问和反向代理见[独立配置页](./Page-Agent-11-MCP服务.md#独立配置页)。

账号支持 JSON 导入、导出，包含配置和明文凭据，不含消息历史。导入按 ID 合并，恢复启用状态与回复设置，仅保留当前服务器有效的客户端授权。

飞书自建应用需启用机器人能力、订阅消息事件、申请权限并发布；钉钉应用机器人需启用 Stream。QQ 的 `intents` 使用意图名称（如 `USER_MESSAGE`），不使用事件名称。凭据、权限与平台限制以平台及适配器说明为准。

企业微信智能机器人选择「API 模式 → 长连接」，填写 BotID 和 Secret；接口使用 `adapter: "wecom-aibot"`、`config: { botId, secret }`、`callback: null`。支持私聊和群聊文本，群聊需 @ 机器人；每个 BotID 仅连接一个服务实例。见[官方说明](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21661)。

**邮件接收会读取 INBOX 中所有未读邮件，包括首次启用前的邮件。** 单封上限 32 MB，持久化成功后标记已读，失败保留未读并重试。关闭“接收邮件（IMAP）”（`receiveEnabled: false`）可仅发送邮件。

邮件账号也供 `sendEmail` 节点和流程通知使用，HTML、附件、抄送和密送见[邮件通知](./Page-Agent-12-邮件通知.md)。

### 收到消息后如何处理

服务端账号默认接收、保存消息并投递给在线的已授权客户端，服务端固定回复默认关闭。处理方式包括：

- **手动回复：** 服务端「账号管理 → 消息 → 回复」，填写文本后发送到原私信或群／频道。
- **固定回复：** QQ、飞书、钉钉和企微在账号「配置 → 收到消息后」选择「固定回复」并填写内容。服务端独立响应新消息，无需浏览器在线。
- **指令／自然语言：** 在扩展的「插件管理 → 平台消息 → 接受的账号」中选择账号并开启允许的指令，结果回复到原私聊或群聊。流程可通过「发送平台消息」节点回复。
- **外部程序：** 使用下文的消息历史或 pull／ack 接口消费消息，再调用已有发送接口回复。

固定回复使用 `autoReply: { "enabled": true, "text": "已收到你的消息。" }`，更新时省略则保留原设置。仅新消息触发，历史和重复消息不补发，结果未知时不自动重试。固定回复与客户端插件可同时回复；邮件使用手动回复或扩展流程。

### 回调监听

飞书 HTTP、QQ Webhook 和企业微信自建应用需要填写回调监听 JSON，长连接及邮件留空：

```json
{
  "host": "127.0.0.1",
  "port": 5140,
  "selfUrl": "https://bot.example.com"
}
```

`host`、`port` 为监听地址，`selfUrl` 为平台可访问的公开地址。每个启用的回调账号使用独立端口，需将公开 HTTPS 地址反向代理到该端口。企微路径为 `/wecom`，只接受加密回调；飞书／QQ 路径由适配器的 `path` 参数指定。

Docker 部署需将 `host` 设为 `0.0.0.0`，发布对应端口并配置反向代理。MCP 端口不接收平台回调。

## 基础能力

扩展调用要求 WebSocket 连接就绪、插件启用。下列能力统一使用 `plugins.execute`，对话默认开放，应用在“插件”模块配置授权。

| 能力 | 输入 | 用途 |
| --- | --- | --- |
| `messaging.accounts` | `connectionId` | 读取账号状态及内置适配器目录 |
| `messaging.account-configuration` | `connectionId, accountId` | 读取配置摘要和 `revision`，不含凭据 |
| `messaging.create-account` | `connectionId, name, adapter, enabled, config, callback`，可选 `receiveEnabled, autoReply` | 创建账号，归属当前客户端 |
| `messaging.update-account` | 创建参数加 `accountId, revision` | 保存完整配置及启停 |
| `messaging.delete-account` | `connectionId, accountId, revision` | 删除账号、消息历史及消费者进度 |
| `messaging.events` | `connectionId, accountId`，可选 `after, limit` | 默认最近 50 条；`after=0` 从头分页，返回 `nextCursor, hasMore` |
| `messaging.send` | `connectionId, accountId, targetId, text`，可选 `direct, replyTo, platform, selfId, guildId` | 发送纯文本 |

ARP 路径为 `/plugin-messaging/capabilities/{能力名}`，`GET` 读取合同，`POST` 执行。流程节点支持 `plugin.messaging.accounts`、`plugin.messaging.events`、`plugin.messaging.send`，参数放在 `input` 中。

修改账号前先读取摘要及 `revision`。`config` 整体替换，需提交完整参数；没有完整参数时通过服务端配置页编辑。`callback` 必须提供，长连接和邮件填 `null`。写操作使用幂等键，结果未知时先查询状态，不自动重试。

应用调用示例：

```js
await PageAgent.ready;
const result = await PageAgent.plugins.call('messaging', 'send', {
  connectionId: '你的 MCP 连接 ID',
  accountId: '账号 ID',
  targetId: '群或频道 ID',
  text: '任务已完成',
  direct: false,
}, { idempotencyKey: crypto.randomUUID() });
// result.messageIds：平台返回的消息回执 ID
```

脚本使用 `api.plugins.call('messaging', 'send', input)`。`direct: true` 时目标为用户 ID，否则为频道或群 ID；邮件和企业微信自建应用要求 `direct: true`，目标分别为邮箱地址和成员 ID。企业微信智能机器人使用 `platform: "wecom-aibot"`，私聊目标为收到消息中的 `userId`，群聊目标为 `channelId`。QQ 频道机器人使用 `platform: "qqguild"`，普通 QQ 使用 `qq`；主动 QQ 频道私聊需按平台要求提供 `guildId`。

回复消息使用 `replyTo: event.id` 和 `targetId: event.direct ? event.userId : event.channelId`，不能用平台 `messageId` 代替事件 `id`。平台的主动发送权限、回复时限、频率和长度限制仍然生效。

企业微信智能机器人需先收到对应会话的消息才能主动推送。文本按 Markdown 展示，单条最多 20,480 个 UTF-8 字节，且不超过通用接口的 16,000 字符上限；`messageIds` 为平台确认的回执关联标识，可能重复。

发送结果未知时先查询平台记录；取消调用或停用插件不能撤回已发消息。

## 指令与自然语言

在「插件管理 → 平台消息 → 接受的账号」选择账号，列表读取已连接服务端中有权访问的账号，无需填写 ID。允许的指令为独立开关，可多选或点击「全部开启」，保存配置后生效。未选择账号时不处理消息，未开启的指令不执行。

账号授权适用于其所有发送者和会话。`commands` 保存开启的指令，`chat` 表示自然语言对话，`stop`、`new` 需分别开启；助手和流程沿用自身权限。

平台消息默认优先级为 `-100`，普通插件为 `0`；数值越高越先处理，同级按注册顺序，首个接管后停止分发。

「未匹配指令」（`unmatchedCommand`）处理所有插件均未接管的 `/` 开头消息，仅对已选择账号生效：`reply`（默认）回复提示，`ignore` 不回复。

内置指令按名称或 ID 选择已有资源，名称含空格时加引号，重名时使用 ID。只发送前缀可查看该类资源列表，`/help [类型]` 提供指令说明。

资源查询、会话状态和任务控制入口如下：

| 指令 | 行为 |
| --- | --- |
| `/list [类型] [关键词] [--page 页码]` | 查看分类或搜索资源，每页 10 项；`run` 类型为运行记录 |
| `/info 类型 名称或ID [动作名或能力ID]` | 查看资源详情、应用动作或插件能力参数 |
| `/status` | 查看当前助手、模型、上下文占用、会话状态和待回答问题 |
| `/history [条数] [--before 序号]` | 查看最近或更早消息，默认 5 条，可设为 1–20 条 |
| `/run [任务ID]` | 查看任务状态和结果 |
| `/cancel [任务ID]` | 请求取消任务，最终状态通过 `/run` 查询 |

资源类型支持英文标识或中文分类名，完整分类由 `/list` 列出。列表标明未发布、停用等状态，查询不会启动资源、创建对话或改变当前选择。

`/run`、`/cancel` 省略 ID 时使用当前来源最近启动的任务。取消支持活动流程、流程组和应用 SDK 启动的脚本，不支持独立脚本及单节点任务。

| 指令 | 行为 |
| --- | --- |
| `/assistant [助手名] [内容]` | 选择匹配的助手；未匹配时清除选择，使用默认助手处理指令后的全部输入并提示 |
| `/conversation 会话名 内容` | 继续已有会话 |
| `/script 脚本名` | 运行脚本，不接收额外参数 |
| `/flow 流程名 参数` | 运行流程；参数文本、分词参数和原消息分别写入 `context.input`、`context.args`、`context.message` |
| `/app 应用名 [JSON参数]` | 打开已发布应用并传入启动参数 |
| `/app 应用名 动作名 [JSON参数]` | 调用已发布动作 |
| `/tool 工具名 操作 文本` | 调用内置工具；需选项时用 `/tool 工具名 操作 --json {"input":"文本","options":{…}}` |
| `/plugin 插件ID 能力ID [JSON参数]` | 调用插件能力；只写插件 ID 时查看状态和能力目录 |

普通消息继续当前对话，未选择时使用默认助手。`/stop` 取消执行。单独发送 `/new` 清除选择，后续使用默认助手新建会话；附在助手或会话指令后时使用指定目标，旧话题均保留。来源按连接、账号、平台、机器人、频道、发送者及私聊／群聊区分，各自保存显式选择并沿用助手的模型和权限。

额外指令和消息逻辑通过[独立插件](./Page-Agent-14-内置能力插件.md#新建与编辑插件)实现。指令使用 Koishi 分词，不执行插值。

同步调用直接回复结果，异步任务回复启动记录及查询、取消入口。应用打开结果仅确认页面已打开，流程可通过「发送平台消息」节点回复。

平台直接处理模型响应、工具执行和提问事件，与界面复用事件转换。正文在模型响应完成后发送，回合结束仅补充结束状态和尾部信息。运行中可补充指令，提问时可回复答案或选项编号。邮件仅发送完整回答、提问和结束状态；暂不支持图片、文件和交互卡片。

每轮结束显示助手名称、模型及 `ctx` 占用百分比。占用按最近请求的输入量与可用输入预算计算，暂无数据时显示 `ctx 0%`。

助手回传按事件序号和片段保存进度，重新启用、重新配置或后台重启后在授权范围内恢复，已确认发送的片段不重发。明确未发送的连接未就绪、账号繁忙等暂时错误会等待重试；发送结果未确认时暂停，`/status` 显示原因，可用 `/history` 查看回复。`/stop`、`/new` 清除当前回传；平台长度、频率和回复时限仍然适用。

## 事件与服务端 ARP

插件通过 `messaging:dispatch` 订阅处理消息，返回 `true` 表示接管；`messaging:message` 仅供观察。数据位于 `event.data`，包含 `connectionId, id, accountId, platform, selfId, userId, channelId, guildId, messageId, text, direct, timestamp`。停用插件会释放订阅。

全部插件均未接管时，按相同顺序分发 `messaging:unmatched`，数据格式相同；返回 `true` 后停止。

指令消息另含 `command: { name, text, args }`，分别为规范化名称、指令后的正文和分词参数；解析失败时带 `error`，不会执行指令。

`text` 最长 16000 字符，展示时按文本处理；事件不包含附件。固定回复状态通过消息历史中的 `autoReply.state` 查询。`messaging:triggered`、`messaging:replied`、`messaging:trigger-error` 分别提供触发结果、回传结果和错误。

HTTP MCP 可独立访问以下资源，具体参数通过对应路径的 `OPTIONS` 查询：

| ARP 调用 | 用途 |
| --- | --- |
| `GET /bots`、`GET /bots/clients` | 查询账号及可授权客户端 |
| `POST /bots/accounts` | 创建账号 |
| `GET /bots/accounts/{id}/configuration` | HTTP 操作者读取完整配置，配对客户端读取摘要；均含版本 |
| `POST /bots/accounts/{id}`、`DELETE /bots/accounts/{id}` | 修改或删除账号，要求当前 `revision` |
| `GET /bots/accounts/{id}/events` | 读取消息历史 |
| `POST /bots/accounts/{id}/messages` | 发送文本 |

写请求需携带幂等键。HTTP 创建账号的 `authorizedClientIds` 默认为 `[]`，可填写有效配对的客户端 ID；插件创建账号默认授权当前客户端。授权名单仅由 HTTP 操作者修改。

插件调用服务端使用 `ctx.pageAgent.serverArp`，公开能力内部使用 `call.serverArp` 保留调用方授权，见[内置能力插件](./Page-Agent-14-内置能力插件.md#arp-与调用方授权)。

## 标准 MCP 订阅

服务端在 `initialize` 响应中声明 `resources.subscribe: true`。客户端完成 `notifications/initialized` 后，在同一会话发送：

```json
{"jsonrpc":"2.0","id":2,"method":"resources/subscribe","params":{"uri":"arp:///bots/accounts/账号ID/events"}}
```

随后以 `GET /mcp` 打开 SSE，携带 `Authorization: Bearer <HTTP令牌>`、`Mcp-Session-Id`、协商的 `MCP-Protocol-Version` 及 `Accept: text/event-stream`。收到消息时服务端发送标准通知：

```text
event: message
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"arp:///bots/accounts/账号ID/events"}}
```

支持订阅 `arp:///bots` 账号状态及具体账号的 `/events`，取消使用 `resources/unsubscribe`。每个会话最多 256 个订阅、一个 SSE 流。断开 SSE 保留订阅，会话失效后需重新初始化和订阅。

通知仅表示资源变化，`resources/read` 返回最近一页。完整消费使用 `/pull`、`/ack`，历史查询使用 `/events`，见下节。SSE 不重放事件，反向代理需关闭缓冲并允许长连接。

## 普通 HTTP 客户端领取消息

无需 MCP 初始化或安装扩展。所有请求使用同一个 HTTP Bearer 认证；JSON 写请求带 `Content-Type: application/json`。

| 请求 | 用途 |
| --- | --- |
| `GET /api/bots` | 发现账号 ID |
| `POST /api/bots/accounts/{id}/pull` | 领取下一批，正文 `{"consumerId":"my-service","limit":50}` |
| `POST /api/bots/accounts/{id}/ack` | 处理完成后确认，正文 `{"consumerId":"my-service","receipt":"领取响应中的凭证"}` |
| `GET /api/bots/accounts/{id}/events?after=0&limit=100` | 从头回看历史，不改变消费进度；用返回的 `nextCursor` 继续分页 |
| `DELETE /api/bots/accounts/{id}/consumers/my-service` | 删除进度，之后从头消费 |

`pull` 返回 `items`、确认凭证 `receipt` 和重复投递标志 `redelivered`。`limit` 为 1–100，默认 50；无消息时凭证为 `null`。处理后通过 `ack` 推进并保存进度，未确认时再次领取返回原批次，业务侧按事件 `id` 去重。

新消费者从最早消息开始，进度按账号、调用身份和 `consumerId` 隔离，重启后保留。HTTP 的 REST 与 MCP 共用进度，配对扩展按客户端隔离，最多 1000 个消费者。历史查询不改变进度。

## 运行与数据保存

账号配置保存在 `bot-accounts.json`，含明文凭据，文件权限为 `0600`；完整配置仅供 HTTP 操作者读取。通过对话提交的配置会进入模型上下文和对话记录。

消息和消费进度保存在 `bot-events.sqlite`，重启或重新配置后保留，不自动清理。删除账号会删除其全部消息和进度。

这些数据不包含在浏览器备份中。备份或迁移前停止服务，保留整个状态目录（含 SQLite 文件及 WAL）；授权给浏览器的账号还需保留对应配对身份。

- 停用扩展内的插件不会停用服务端账号，停止接收需停用账号。
- 历史消息不自动清理，磁盘占用会增长。写盘失败会停止对应接收账号，恢复磁盘后需重新启用；平台断线期间的消息补投由上游决定。
- 浏览器离线不补触发，队列或待回复对话达到上限时会报错；补处理使用 pull／ack。
