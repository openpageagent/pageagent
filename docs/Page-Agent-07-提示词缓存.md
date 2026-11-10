# Page Agent 提示词缓存

模型请求保留已发送的消息，按轮追加指导和运行时状态。缓存影响重复输入的计算成本和延迟，缓存内容仍占用上下文窗口。

## 请求结构

```text
请求 = System Core + 工具定义 + 按顺序展开的持久对话消息
     + 本轮 profile/request guidance 更新 + 本轮运行时快照或字段更新
```

运行时消息是 user 层 data-only 数据，随对话保存并按原顺序回放。Knowledge 按需显式读取。

首次请求、新用户回合、新 generation、摘要压缩后或缺少状态基准时，发送 `mode="snapshot"` 完整快照，替换此前状态。后续以 `mode="update"` 追加更新：`set` 整体替换顶层字段，`remove` 删除字段，未提及字段沿用最近有效值。

当前目标、时间、预算及已有的恢复信息每轮发送，其余事实变化时更新。运行时状态不替代更新的工具观测。

MCP 连接、权限、审计和环境状态按轮更新，不改变稳定前缀中的工具定义。

缓存周期建立时，profile guidance 位于用户消息序列之前。同一周期内，guidance 变化时追加更新，撤销时追加空更新；未变化的内容按 hash 复用。

Journal 消息按 sequence 全序展开，guidance 和运行时更新追加到前缀末尾，不插回已有消息之间。
System Core 保持系统规则的权威，guidance 是 user 层方法，运行时上下文是事实数据；缓存位置不授予额外权限。

## 缓存周期

以下变化会开启新的 cache epoch：

- System Core 或提示词行为版本；
- 模型可见的工具集合或 schema；
- 服务、协议适配、请求地址或模型；
- Journal checkpoint 或上下文替换边界。

思考级别、采样、惩罚、输出上限和本地预算属于单次请求参数，不计入缓存周期标识。

## 持久状态

[`agent/context-builder.js`](../agent/context-builder.js) 在 `promptState` 中记录：

| 字段 | 用途 |
| --- | --- |
| `contextEpoch`、`cacheEpochHash` | 上下文和缓存周期标识 |
| `messageCount`、`messagesHash` | 已保存前缀的消息数量和内容 hash |
| `systemPromptHash`、`toolSchemaHash` | 系统提示词和工具 schema 标识 |
| `profileGuidanceHash`、`prefixProfileGuidanceText` | 当前 profile guidance 标识及前缀中的文本 |
| `requestGuidanceHash` | 当前请求 guidance 标识 |

后续请求按消息数量和 hash 校验已发送前缀，包括运行时消息。同一缓存周期内前缀不一致时返回 `PROMPT_PREFIX_CHANGED`。

## 工具变化与上下文预算

同一 generation 内，Provider 可见的工具集合和 schema 必须稳定。
工具定义在 generation 建立时确定，不随剩余调用预算逐轮增删；执行预算在调用分发时检查。

新 generation 按权限上限（ceiling）确定可用工具。只有实际工具集合或 schema 变化时，才更新 `toolSchemaHash` 并开启新的 cache epoch；权限上限本身不单独计入缓存 hash。

工具 schema 不变时，当前资源或路由合同引起的 guidance 变化，以及 request guidance 的其他变化，只追加 guidance 更新。
页面、时间、预算等事实按轮追加运行时更新。

预算按完整 Provider 投影计算：

```text
System + tools + 持久消息 + 本轮新增指导和运行时消息 + Provider envelope
```

历史运行时消息按实际发送内容计入预算。System 和 tools 不重复计算，另为模型输出和安全余量预留空间。

启用上下文压缩时，输入超限先尝试历史摘要；无法压缩至预算内时返回 `CONTEXT_EXHAUSTED`。

## 服务端缓存与统计

`cacheEpochHash` 用于本地前缀校验；`promptCacheKey` 从持久对话 ID 派生，恢复对话或压缩上下文时保持不变。

流程模型节点和脚本 `model.chat` 的缓存标识由运行环境、流程 ID 和节点 ID 派生，跨次运行保持一致。

缓存参数由协议和兼容适配器决定，详见[模型服务兼容性](./Page-Agent-08-模型服务兼容性.md#缓存参数)。本地 key 和前缀校验不代表服务端命中，实际以返回的 usage 为准。

输入 token 归一化为互不重复的三部分：

```text
measured_input = inputTokens + cacheReadTokens + cacheWriteTokens
```

Responses 缓存随正常请求建立，命中量记录在 `cacheReadTokens`；`cacheWriteTokens` 为零不表示未建立缓存。

trace、事件和 Provider usage 保留缓存字段，界面不单独展示缓存指标。
