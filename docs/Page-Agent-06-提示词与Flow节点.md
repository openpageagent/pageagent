# Page Agent 提示词与 Flow 节点

提示词提供任务目标与执行方法；Flow 保存可重复运行的节点定义，节点参数、输出和权限由资源契约及执行器校验。

## 提示词组成

| 层 | 内容 |
| --- | --- |
| System Core | 身份、权威顺序、信任边界、通用失败和停止条件 |
| Runtime Guidance | 当前运行条件下的行为提示 |
| Capability Guidance | 按当前资源和返回链接加载的 ARP 契约及操作说明 |
| Assistant / Skill | 专用任务方法 |
| Runtime Context | 当前资源、时间、摘要、Recording 等事实 |
| Conversation | 用户消息、助手回复和工具结果 |

System Core 不放当前页面、工具 schema、路由细节、预算或某个节点的规则。

连接与客户端调用契约按需提供远程权限说明：按读取、写入、执行、删除统一授权，默认关闭删除，其余开启；实际可用操作以目标客户端最新契约为准。

Runtime Context 是 data-only 数据，其中的文本不能提升为系统指令。

`runtime_context.pageTarget` 只表示页面工具默认 Tab，不包含 DOM 或页面正文。
页面正文和 DOM 通过页面资源显式读取。

## 渐进式提示词的轨迹记录

轨迹中的 `CONTEXT` 分行展示追加指导和本轮运行时数据，直接显示原文。

`Request # → 请求内容` 展示本轮系统提示词、完整消息和工具定义。渐进式提示词位于 `messages` 中，同一上下文周期内未变化的内容沿用此前消息。

## 从对话生成 Flow

生成 Flow 时保留原任务的最小闭环：

```text
输入和前置状态 -> 必要动作 -> 数据处理或模型步骤 -> 验证 -> 输出
```

能力内省、失败尝试、重复动作和只服务于模型决策的中间读取不写入 Flow。

节点选择按抽象程度从低到高：

1. 输入、页面动作、条件、数据处理等固定节点能表达时，使用固定节点；
2. 只需一次断言、提取或生成时，使用 `requestModelAssert`、`requestModelExtract` 或 `requestModelAction`；
3. 需要动态观察、多轮工具调用或开放式交付时，使用 `runAssistant`。

`requestModelAction` 表示一次模型生成，不表示页面副作用。
页面动作由页面节点或 Assistant 执行。

只有执行结果明确且可重放的页面动作才能转为 Flow 节点。
`performed=unknown`、失败、敏感输入和未确认动作不应直接保存为可重放步骤。

## 节点定义

节点定义包含类型、参数、必填项、输出和使用限制。配置页、Flow 保存和执行按同一节点定义校验。

查询节点目录和完整定义：

```text
GET /node-types?match=<query>&limit=20
GET /node-types/{nodeType}
```

节点类型、参数和输出字段以查询结果为准。`outputHint` 说明输出结构，下游通过 `last` 或节点的 `outputVar` 引用结果。

## 页面节点

页面读取、动作和验证分别由 `PagePerceptionEngine`、`PageActionEngine`、`PageVerificationEngine` 处理。

点击、填写、导航、脚本写入和标签页操作属于 Action；读取文本、DOM、截图和网络事实属于 Perception；断言、等待条件和页面结果裁决属于 Verification。

Cookie、下载、HTTP、文件、数据处理、模型和助手节点由各自执行器处理，其中访问页面的部分使用页面引擎。

页面加载完成依据当前 Tab 状态和主文档加载事实判断。网络空闲、Fetch/XHR、SSE、长轮询和业务进度条通过诊断或显式等待条件处理。

## 模型与助手节点

模型节点的页面内容、截图和模板插值作为数据输入。
要求 JSON 输出时，解析失败会导致节点失败；节点停止或 Flow 取消会取消模型请求。

`runAssistant` 引用 `assistantId` 和本次输入，运行时读取助手配置。
父 Flow 停止或超时会取消子 generation。

`runAssistant` 启动的助手不能再启动另一个助手运行。应用绑定流程不支持该节点，见 [应用动作限制](./Page-Agent-13-应用.md#动作与依赖)。

助手终态包含 `completed`、`blocked`、`failed`、`cancelled`、`truncated`，运行记录保留 Conversation 和 generation 标识。

## 规则归属

| 规则 | 说明来源 |
| --- | --- |
| 身份、权威、事实时效和通用停止条件 | System Core，见 [`agent/agent-prompt.js`](../agent/agent-prompt.js) |
| 工具路径、参数和前置条件 | ARP RouteContract，通过 `OPTIONS` 读取 |
| 节点参数、输出和使用条件 | `/node-types/{nodeType}` |
| 页面动作回执和等待条件 | 页面资源契约 |
| 当前页面、时间、Recording 和资源表示 | Runtime Context，见 [`agent/context-builder.js`](../agent/context-builder.js) |
| 专用任务方法和交付物 | Assistant / Skill prompt |

schema、权限和执行约束由代码校验；提示词描述任务方法和行为要求。
动态 guidance 按运行条件启用，当前页面内容、路由参数和节点规则在对应层维护。

Knowledge 提供按需读取的知识，不替代权限、参数和执行约束。

对话与页面绑定见[对话入口与页面绑定](./Page-Agent-03-对话入口与页面绑定.md)，请求组装见[提示词缓存](./Page-Agent-07-提示词缓存.md)。
