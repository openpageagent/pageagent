# Page Agent 对话入口与页面绑定

Conversation 是持久话题，generation 是话题中的一次运行。连续发送消息通常复用同一个 `conversationId`，每次发送创建新的 `generationId`。

## 当前入口

| 入口 | Conversation 行为 | 当前资源 | 默认页面 |
| --- | --- | --- | --- |
| 配置中心 | 使用当前话题；新建话题时创建 | `/conversations/{id}`，也可关联 Run/Flow | 无 |
| 网页内对话面板 | 按 `tabId + assistantId` 复用；点击“新对话”后创建 | `/page/current` | 打开面板的网页 Tab |
| Sidepanel | 每次点击运行创建独立话题 | `/page/current` | 启动时的活动网页 Tab |
| 定时任务 | 每次触发创建独立话题 | `/schedules/{id}` | 无 |
| Flow `runAssistant` | 未指定 ID 时创建；指定 ID 时复用 | `/flows/{flowId}` 或 `/assistants/{assistantId}` | 节点传入的 `tabId`（可选） |
| ARP/MCP | `POST /conversations` 创建；向已有 ID 发消息时复用 | `/conversations/{id}` | 请求 `tabId`，其次是话题的 `activeTabId` |

所有入口最终通过 Conversation Command Bus 的 `START_TURN` 启动 generation。实现位置主要在 `agent/conversation-protocol.js`、`content/page-conversation-panel.js`、`sidepanel/sidepanel-run-entry.js`、`background.js` 和 `resources/services/resource-service.js`。

## 什么时候是新对话

判断标准只有 `conversationId` 是否改变：

- ID 不变：继续当前 Conversation，即使生成了新的 generation；
- ID 改变，或先执行 `POST /conversations`：新建 Conversation；
- steering、回答交互和取消运行：都不会新建 Conversation 或 generation。

网页内面板把 ID 保存在当前 Tab 的 Session Storage：

```text
page-agent-conversation:{tabId}:{assistantId}
```

Sidepanel 使用 `sidepanel:{windowId}:{assistantId}:{timestamp}`，定时任务使用 `scheduled:{scheduleId}:{fireTime}`。未传 `conversationId` 的 `runAssistant` 使用运行时生成的独立 ID。

## 页面绑定

页面绑定只表示页面工具的默认目标，不表示已经读取页面内容：

```text
entry.tabId -> AgentCore.currentTabId -> 页面服务默认目标
```

页面 DOM、文本和截图只有模型显式读取 `/page` 资源后才进入上下文。没有默认目标时，页面服务返回 `PAGE_CONTEXT_REQUIRED`，不会自动选择浏览器中的其他标签页。

Provider 可见的页面目标只有 `runtime_context.pageTarget`：

```json
{ "bound": true, "tabId": 123, "windowId": 456, "source": "entry" }
```

没有目标时为 `{ "bound": false }`。目标优先级是入口显式 `tabId`，其次是可信的网页或 Sidepanel surface；配置中心和定时任务不把自身 UI Tab 当作目标。

## ARP/MCP 对话调用

```text
POST /conversations
POST /conversations/{conversationId}/messages
GET  /conversations/{conversationId}/events
DELETE /conversations/{conversationId}/generations/{generationId}
```

`POST /conversations/{conversationId}/messages` 只在给定 ID 的话题中创建 generation。页面目标从请求 body 的 `tabId` 或话题的 `activeTabId` 获取；两者都没有时必须先提供目标，不能依赖当前活动标签页猜测。
