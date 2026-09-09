# Page Agent 提示词缓存

提示词缓存只优化请求成本和延迟，不改变消息的权威关系、工具能力或用户目标。当前请求分为可缓存前缀和每轮更新的运行时尾部。

## 两部分请求

```text
cacheable_prefix
  = System Core + Provider 工具定义 + Journal 全序消息
  + profile/request guidance 的追加更新

runtime_tail
  = 当前资源、时间、摘要、Recording、MCP、预算和恢复事实
```

`runtime_tail` 每轮重新生成，始终是最后一条 user/data-only 消息。它不写入持久的 `promptMessages`、历史或 profile guidance，也不能携带权限声明。Knowledge 不会自动注入，需要时由模型显式读取。

Journal 按 sequence 全序展开，不能先按“历史/当前”分组再拼接。首次进入某个缓存时期时，profile guidance 放在首个用户内容之前。

## Cache epoch

Cache epoch 是可以执行前缀比较的稳定时期。以下内容变化时开启新的 epoch：

- System Core 或提示词行为版本；
- Provider 可见工具集合或 schema；
- 目标服务、协议兼容层、实际 endpoint 或模型；
- Journal checkpoint 或明确的上下文替换边界。

单次请求参数（reasoning/thinking、采样、惩罚、输出上限和本地预算）不属于 epoch。它们在请求构造时按模型协议校验，不应造成无意义的前缀分裂。

## Guidance 更新

同一 epoch 内不要改写旧前缀或把新 guidance 插回历史。内容变化时在前缀末尾追加替换消息：

```text
旧 guidance
+ 当前 profile/request guidance，声明替换此前同类版本
+ 当前 runtime_tail
```

撤销 guidance 也追加明确的空更新。内容未变化时只根据 hash 复用，不能每轮重复大段文本。

缓存命中不等于 guidance 获得更高权威。System Core 仍是系统规则，guidance 仍是 user 层方法，runtime 仍是 data-only 事实，工具能力仍由代码注册表和 RouteContract 决定。

## 持久状态

`promptState` 至少记录：

```text
contextEpoch
cacheEpochHash
前缀 messageCount / messagesHash
systemPromptHash / toolSchemaHash
profileGuidanceHash / prefixProfileGuidanceText
requestGuidanceHash
```

下一轮重建同一 epoch 的前缀并校验数量和 hash。校验失败时报告前缀已改变或开启新的 epoch，不能静默重排、删除旧消息或覆盖旧 guidance。

## Provider 缓存字段

本地 `cacheEpochHash` 和 `promptCacheKey` 只表示本地状态或缓存分组意图，不能证明服务端已接受或命中。Provider 是否支持客户端 key、字段如何映射，由 [Page-Agent-08-模型服务兼容性](./Page-Agent-08-模型服务兼容性.md) 和对应适配器决定。

支持客户端 key 的服务：key 只能由稳定 epoch 派生，不得包含当前页面、动态 guidance 或单次输出。未传入 key 时省略该字段，不能回退为 session ID 或 conversation ID。

自动管理前缀缓存的服务：保持前缀稳定即可，实际命中以 Provider usage 中的缓存输入 token 为准。没有客户端 key 不代表没有缓存。

输入 token 归一化为不重复的三部分：

```text
measured_input = inputTokens + cacheReadTokens + cacheWriteTokens
```

缓存 token 仍占用上下文窗口，不能从预算中扣除。UI 不展示专用缓存指标，但 trace、事件和 Provider usage 保留原始字段。

## 工具变化与上下文预算

同一 generation 内，Provider 可见工具 schema 必须稳定。工具集合、schema 或权限 ceiling 变化时重新计算 hash 并开启 epoch；当前资源、路由合同或 request guidance 变化而工具 schema 不变时，只追加 guidance 更新。

预算按完整 Provider 投影计算：

```text
System + tools + cacheable_prefix + runtime_tail + Provider envelope
```

缓存只影响重复计算，不减少模型上下文占用。
