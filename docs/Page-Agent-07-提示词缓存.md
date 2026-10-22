# Page Agent 提示词缓存

模型请求由稳定前缀和每轮更新的运行时尾部组成。缓存影响重复输入的计算成本和延迟，缓存内容仍占用上下文窗口。

## 请求结构

```text
稳定前缀 = System Core + 工具定义 + 按顺序展开的对话消息
         + profile/request guidance 更新
运行时尾部 = 当前资源、时间、摘要、Recording、预算和恢复事实
```

运行时尾部是最后一条 user 层数据消息，每轮重新生成，不写入持久消息历史。Knowledge 按需显式读取。

缓存周期建立时，profile guidance 位于用户消息序列之前。

同一缓存周期内，guidance 变化通过追加消息更新，撤销时追加空更新；未变化的内容按 hash 复用。

Journal 消息按 sequence 全序展开，guidance 更新追加到前缀末尾，不插回已有消息之间。
System Core 保持系统规则的权威，guidance 是 user 层方法，运行时尾部是事实数据；缓存位置不授予额外权限。

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

后续组装按数量和 hash 校验已有前缀。同一周期内前缀被改写时返回 `PROMPT_PREFIX_CHANGED`，不能通过重排或覆盖已保存消息掩盖差异。

## 工具变化与上下文预算

同一 generation 内，Provider 可见的工具集合和 schema 必须稳定。
工具定义在 generation 建立时确定，不随剩余调用预算逐轮增删；执行预算在调用分发时检查。

权限 ceiling 参与确定可用工具。新 generation 按其权限重新确定工具集合；工具集合或 schema 变化时，重新计算 `toolSchemaHash` 并开启新的 cache epoch。
权限 ceiling 本身不单独计入缓存 hash；实际工具集合和 schema 未变化时，不因 ceiling 变化而单独开启 cache epoch。

工具 schema 不变时，当前资源或路由合同引起的 guidance 变化，以及 request guidance 的其他变化，只追加 guidance 更新。
页面、时间、预算等事实按轮更新运行时尾部。

预算按完整 Provider 投影计算：

```text
System + tools + cacheable_prefix + runtime_tail + Provider envelope
```

其中 `cacheable_prefix` 指持久消息前缀，System 和 tools 已单独计入，不重复计算。
缓存命中的输入仍占用上下文窗口；预算还需为模型输出和安全余量预留空间。

## 服务端缓存与统计

`cacheEpochHash` 标识本地缓存周期，`promptCacheKey` 从该周期派生。

客户端 key 是否发送由协议和兼容适配器决定，详见[模型服务兼容性](./Page-Agent-08-模型服务兼容性.md)。

本地 key 不表示服务端已命中缓存；实际命中以服务返回的 usage 为准。输入 token 归一化为互不重复的三部分：

```text
measured_input = inputTokens + cacheReadTokens + cacheWriteTokens
```

trace、事件和 Provider usage 保留缓存字段，界面不单独展示缓存指标。
