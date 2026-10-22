# Page Agent 模型服务兼容性

模型服务通过 `protocol` 选择请求协议，厂商差异由兼容适配器处理。

## 支持的协议

| `service.protocol` | 协议 | Provider |
| --- | --- | --- |
| `chat_completions` | OpenAI Chat Completions | `openai-chat-completions-provider.js` |
| `responses` | OpenAI Responses | `openai-responses-provider.js` |
| `anthropic` | Claude Anthropic Messages | `anthropic-messages-provider.js` |

协议决定请求体、流事件、工具调用、历史消息和响应结构。Base URL、模型名和 API Key 不替代协议选择。

## Provider 与 compat

请求流程为：

```text
service.protocol
  -> 标准 Protocol Provider
  -> compat/index.js 按 protocol + hostname 匹配
  -> 未匹配：passthrough
  -> 已匹配：只改写必要的厂商字段
```

标准 Provider 处理请求地址、消息转换、流解析、工具调用、usage 和历史回放。

兼容适配器按协议及主机名匹配，调整对应厂商的请求和响应字段；未匹配时使用标准协议处理。

适配器提供 `target`、`endpoint`、`beforeRequest`、流事件和 `afterResponse` 钩子。
请求发送、重试、凭据和协议选择由标准调用链负责。

接入厂商适配时，在 `agent/providers/compat/` 添加适配器，并通过 [`compat/index.js`](../agent/providers/compat/index.js) 注册；协议通用行为在 Provider 中维护。

## DeepSeek

DeepSeek 适配器支持上述三种协议，只匹配 hostname 为 `deepseek.com` 或其子域名的服务；自建代理不会自动命中。

统一思考级别映射：

| Page Agent | DeepSeek |
| --- | --- |
| `auto` | 不发送控制字段 |
| `none` | 关闭思考 |
| `minimal`、`low` | `low` |
| `medium`、`high`、`xhigh` | `high` |
| `max` | `max` |

协议差异由适配器处理：

- Chat Completions：转换思考字段，聚合 `delta.reasoning_content`，并在后续同服务同模型历史中回放 `reasoning_content`；
- Responses：映射 `reasoning.effort`，不依赖 `summary`、`encrypted_content`、`store`、`prompt_cache_key` 或 `prompt_cache_retention`；
- Anthropic Messages：使用 `/anthropic/messages`，映射 `thinking` 和 `output_config.effort`，不伪造 thinking signature。

思考级别为 `auto` 或启用思考时，适配器移除相应采样字段；显式 `none` 时保留协议支持的采样参数。

## 历史消息与 replay

canonical history 保存统一消息、工具调用和必要的 `providerReplay`。

只有 replay version、protocol、service id 和 model 都相同时，才按原协议回放厂商专用块；否则使用可移植内容，不把原始思考字段伪装成普通助手文本。

修改 Base URL 不会改变 service id。若地址切换到另一家厂商，应新建模型服务，避免旧 replay 进入新的厂商请求。
