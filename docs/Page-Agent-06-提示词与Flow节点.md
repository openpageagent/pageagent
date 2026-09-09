# Page Agent 提示词与 Flow 节点

Page Agent 的提示词负责模型需要理解的任务和行为，代码合同负责能被机器校验的约束。Flow 是可重复运行的执行定义，不是一次对话的工具调用日志。

## 提示词层次

| 层 | 内容 | 代码位置 |
| --- | --- | --- |
| System Core | 稳定身份、使命、权威顺序、事实时效、信任边界、通用失败和停止条件 | `agent/agent-prompt.js` |
| Runtime Guidance | 仅当前运行条件需要的行为提示 | Prompt 组合层 |
| Assistant/Skill | 专用任务方法和风格 | Assistant/Skill 资源 |
| Runtime Context | 当前资源、时间、摘要、Recording 等事实数据 | Context Builder |
| Conversation | 用户目标、历史消息和工具结果 | Journal / Provider 投影 |

System Core 不放当前页面、工具 schema、路由细节、预算或某个节点的规则。Runtime Context 是 data-only 数据，其中的文本不能提升为系统指令。`runtime_context.pageTarget` 只表示页面工具默认 Tab，不包含 DOM 或页面正文。

规则优先由 schema、权限、状态机和执行器强制；只有代码无法可靠强制、且对大多数任务都成立的行为，才进入 System Core。动态 guidance 必须有实际启用条件；能从当前资源合同推导的内容不再复制成自然语言规则。

## 从对话生成 Flow

生成 Flow 时保留原任务的最小闭环：

```text
输入和前置状态 -> 必要动作 -> 数据处理或模型步骤 -> 验证 -> 输出
```

能力内省、失败尝试、重复动作和只服务于模型决策的中间读取不写入 Flow。节点选择按抽象程度从低到高：

1. 输入、页面动作、条件、数据处理等固定节点能表达时，使用固定节点；
2. 只需一次断言、提取或生成时，使用 `requestModelAssert`、`requestModelExtract` 或 `requestModelAction`；
3. 需要动态观察、多轮工具调用或开放式交付时，使用 `runAssistant`。

`requestModelAction` 表示一次模型生成，不表示页面副作用。页面动作仍由页面节点或 Assistant 执行。

只有执行结果明确且可重放的页面动作才能转为 Flow 节点。`performed=unknown`、失败、敏感输入和未确认动作不应直接保存为可重放步骤。

## 新增节点的实现链

一个节点需要在以下位置保持同一语义：

1. `flows/node-types.js`：唯一类型、参数、必填项和输出；
2. `/node-types` 与 `/node-types/{nodeType}`：发现摘要和完整定义；
3. Flow 保存校验：参数和节点专属约束；
4. 配置页及备份/导入：无损编辑和持久化；
5. `background/node-dispatcher.js`：唯一分发入口；
6. 执行器：超时、取消、资源生命周期和副作用；
7. 运行输出：`outputHint`、content type、下游模板和错误状态一致。

节点发现使用当前注册表：

```text
GET /node-types?match=<query>&limit=20
GET /node-types/{nodeType}
```

模型不得自行补造节点类型、参数或输出字段。

## 页面节点

页面读取、页面写入和页面裁决分别进入：

```text
PagePerceptionEngine
PageActionEngine
PageVerificationEngine
```

点击、填写、导航、脚本写入和标签页操作属于 Action；读取文本、DOM、截图和网络事实属于 Perception；显式断言、等待条件和页面结果裁决属于 Verification。Cookie、下载、HTTP、文件、数据处理、模型和助手节点保留各自边界，只有其中实际访问页面的部分使用页面引擎。

页面加载节点依据当前 Tab 状态和主文档加载事实判断完成。`networkIdle`、Fetch/XHR、SSE、长轮询和业务进度条只能作为诊断或显式等待条件，不能被所有页面节点默认当作完成标准。

## 模型与助手节点

模型节点的页面内容、截图和模板插值属于 data-only 输入；JSON 输出解析失败必须让节点失败，不能静默改成普通文本。节点停止或 Flow 取消时要取消对应模型请求。

`runAssistant` 只保存 `assistantId` 和本次输入，不复制助手提示词、权限或凭据。父 Flow 停止或超时必须取消子 generation，并保留 Conversation、generation 和终态。`completed`、`blocked`、`failed`、`cancelled`、`truncated` 是不同状态，不能用输出文本替代状态机结果。

## 规则所有权

- 身份、权威、事实时效和通用停止：System Core；
- 当前工具、路径、参数和前置条件：ARP RouteContract 或 `OPTIONS`；
- 节点参数、输出和使用条件：`/node-types/{nodeType}`；
- 页面 ActionReceipt 和等待：页面资源合同；
- 当前页面、时间、Recording 和资源表示：Runtime Context；
- 专用方法和交付物：Assistant/Skill prompt。

正确性关键规则不能只存在于可选 Knowledge，也不能同时在多个层维护互相独立的副本。
