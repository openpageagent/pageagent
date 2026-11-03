# Page Agent 对话入口与页面绑定

Conversation 是持久话题，generation 是话题中的一次运行。连续发送消息通常复用同一个 `conversationId`，每次发送创建新的 `generationId`。

## 对话入口

| 入口 | Conversation 行为 | 当前资源 | 默认页面 |
| --- | --- | --- | --- |
| 配置中心 | 使用当前话题；新建话题时创建 | `/conversations/{id}`，也可关联 Run/Flow | 无 |
| 网页内对话面板 | 按 `tabId + assistantId` 复用；点击“新对话”后创建 | `/page/current` | 打开面板的网页 Tab |
| 应用页对话面板（草稿／发布） | 按 Tab、助手、应用路径复用；点击“新对话”后创建 | `/apps/{appId}` | 打开面板的应用 Tab |
| Sidepanel | 每次运行助手时创建独立话题 | `/page/current` | 启动时的活动网页 Tab |
| 定时任务 | 每次触发创建独立话题 | `/schedules/{id}` | 无 |
| Flow `runAssistant` | 未指定 ID 时创建；指定 ID 时复用 | `/flows/{flowId}` 或 `/assistants/{assistantId}` | 节点传入的 `tabId`（可选） |
| 扩展内 ARP | `POST /conversations` 创建；向已有 ID 发消息时复用 | `/conversations/{id}` | 请求 `tabId`，其次是话题的 `activeTabId` |

外部 MCP 入口可读取已授权资源，不能创建、修改或启动对话；其页面目标规则见 [MCP 浏览器目标](./Page-Agent-11-MCP服务.md#浏览器目标)。

## 什么时候是新对话

判断标准只有 `conversationId` 是否改变：

- ID 不变：继续当前 Conversation，即使生成了新的 generation；
- ID 改变，或先执行 `POST /conversations`：新建 Conversation；
- steering、回答交互和取消运行：都不会新建 Conversation 或 generation。

网页内面板将话题 ID 保存在当前 Tab 的 Session Storage，按助手区分。

## 页面绑定

页面绑定指定页面工具的默认目标。

绑定页面不会自动读取 DOM、文本或截图，页面内容需通过 `/page` 资源显式获取。

没有默认目标时，页面服务返回 `PAGE_CONTEXT_REQUIRED`，不会自动选择浏览器中的其他标签页。

模型通过 `runtime_context.pageTarget` 获取绑定信息：

```json
{ "bound": true, "tabId": 123, "windowId": 456, "source": "entry" }
```

没有目标时为 `{ "bound": false }`。

目标优先级是入口显式 `tabId`，其次是已验证的网页或 Sidepanel 入口；配置中心和定时任务不把自身 UI Tab 当作目标。

## ARP 对话调用

```text
POST /conversations
POST /conversations/{conversationId}/messages
GET  /conversations/{conversationId}/events
DELETE /conversations/{conversationId}/generations/{generationId}
```

`POST /conversations/{conversationId}/messages` 在给定话题中创建 generation。

页面目标从请求 body 的 `tabId` 或话题的 `activeTabId` 获取；两者都没有时对话不绑定页面，调用需要目标的页面工具前需提供 `tabId`。
