# Page Agent 模型服务兼容性

模型服务通过 `protocol` 选择请求协议，厂商差异由兼容适配器处理。

## 支持的协议

| `service.protocol` | 协议 |
| --- | --- |
| `chat_completions` | OpenAI Chat Completions |
| `responses` | OpenAI Responses |
| `anthropic` | Claude Anthropic Messages |

协议决定请求体、流事件、工具调用、历史消息和响应结构。Base URL、模型名和 API Key 不替代协议选择。

无认证服务（如本地 Ollama）可留空 API Key 和认证 Header；认证要求以服务端为准。

## Fast（优先处理）

在「模型配置」中将服务的「服务等级」设为「Fast（优先处理）」并保存；默认等级沿用服务端设置，与「思考级别」独立。

Fast 适用于 OpenAI Responses 和 Chat Completions 的文本、视觉及摘要请求，Anthropic Messages 不支持。实际可用性取决于模型、账户及服务商或代理，可能增加费用或额度消耗。

## Provider 与 compat

```text
service.protocol
  -> 标准 Protocol Provider
  -> compat/index.js 按 protocol + hostname 匹配
  -> 未匹配：passthrough
  -> 已匹配：只改写必要的厂商字段
```

标准 Provider 处理请求地址、消息转换、流解析、工具调用、usage 和历史回放。

Agent 对话、流程模型节点和脚本 `model.chat` 共用 Provider 的流式请求、缓存和重试机制。流程的 `timeoutMs` 为空闲超时，服务代理的超时限制独立生效。

脚本 `model.chat` 的 `user` 中，`image_url` 图片块支持 Base64 Data URL 和 HTTP(S) URL。远程图片由模型服务读取，无效地址在请求前报错。

兼容适配器按协议及主机名匹配，调整对应厂商的请求和响应字段；未匹配时使用标准协议处理。

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

各协议的适配行为：

- Chat Completions：转换思考字段，聚合 `delta.reasoning_content`，并在后续同服务同模型历史中回放 `reasoning_content`；
- Responses：映射 `reasoning.effort`，不依赖 `summary`、`encrypted_content`、`store`、`prompt_cache_key` 或 `prompt_cache_retention`；
- Anthropic Messages：使用 `/anthropic/messages`，映射 `thinking` 和 `output_config.effort`，移除顶层 `cache_control`，不伪造 thinking signature。

思考级别为 `auto` 或启用思考时，适配器移除相应采样字段；显式 `none` 时保留协议支持的采样参数。

## 缓存参数

三种协议共用消息历史；切换服务、协议或模型不保证复用缓存。

| 服务 / 协议 | 缓存行为 |
| --- | --- |
| 标准 Responses | 发送 `prompt_cache_key` |
| 标准 Chat Completions | 不发送本地缓存 key |
| 标准 Anthropic Messages | 主对话发送 `cache_control: { type: "ephemeral" }`，默认 5 分钟；摘要请求不主动启用 |
| DeepSeek 三种接口 | 服务端自动管理缓存，不发送 OpenAI / Claude 专用缓存控制字段 |

Anthropic 兼容服务需支持顶层 `cache_control`。服务端规则见 [Anthropic 缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)和 [DeepSeek 缓存](https://api-docs.deepseek.com/guides/kv_cache/)。

服务端是否命中以返回的 usage 为准，见[提示词缓存](./Page-Agent-07-提示词缓存.md#服务端缓存与统计)。

OpenAI 协议通过 `session-id`、`thread-id` 和 `session_id` 请求头传递持久对话 ID，是否采用由服务端决定。

## 历史消息与 replay

canonical history 保存统一消息、运行时上下文、工具调用和必要的 `providerReplay`。

只有 replay version、protocol、service id 和 model 都相同时，才按原协议回放厂商专用块；否则使用可移植内容，不把原始思考字段伪装成普通助手文本。

修改 Base URL 不会改变 service id。若地址切换到另一家厂商，应新建模型服务，避免旧 replay 进入新的厂商请求。
