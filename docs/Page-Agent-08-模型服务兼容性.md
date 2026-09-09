# Page Agent 模型服务兼容性

模型服务配置只选择协议。当前支持三种标准协议，厂商差异由 compat 适配器在标准协议之上处理。

## 支持的协议

| `service.protocol` | 协议 | Provider |
| --- | --- | --- |
| `chat_completions` | OpenAI Chat Completions | `openai-chat-completions-provider.js` |
| `responses` | OpenAI Responses | `openai-responses-provider.js` |
| `anthropic` | Claude Anthropic Messages | `anthropic-messages-provider.js` |

协议决定请求体、流事件、工具调用、历史消息和响应结构。Base URL、模型名和 API Key 不替代协议选择。

旧配置读取时按 `protocol`、`apiStyle`/`api_style`、`callStyle`/`call_style` 顺序兼容；未知值回退为 `chat_completions`。新建、编辑和导出只使用 `protocol`，旧 `providerType` 等字段不参与路由。

## Provider 与 compat

请求流程为：

```text
service.protocol
  -> 标准 Protocol Provider
  -> compat/index.js 按 protocol + hostname 匹配
  -> 未匹配：passthrough
  -> 已匹配：只改写必要的厂商字段
```

标准 Provider 负责 endpoint、消息投影、流解析、工具调用、usage、错误和 replay。compat 只能在这些阶段提供 `target`、`endpoint`、`beforeRequest`、流事件和 `afterResponse` 钩子；不能自行发请求、重试、保存凭据或切换协议。

未匹配适配器时，标准协议请求必须保持原样。新增厂商只需在 `agent/providers/compat/` 增加适配器并通过 `compat/index.js` 注册，不复制整个 Provider。

## DeepSeek

当前 DeepSeek 作为三种标准协议的兼容层，不是第四种协议。适配器只匹配解析后 hostname 为 `deepseek.com` 或其子域名的服务；自建代理不会自动命中。

统一思考级别映射：

| Page Agent | DeepSeek |
| --- | --- |
| `auto` | 不发送控制字段 |
| `none` | 关闭思考 |
| `minimal`、`low` | `low` |
| `medium`、`high`、`xhigh` | `high` |
| `max` | `max` |

`minimal -> low` 是本地兼容映射，不是 DeepSeek 的独立等级。

协议差异由适配器处理：

- Chat Completions：转换思考字段，聚合 `delta.reasoning_content`，并在后续同服务同模型历史中回放 `reasoning_content`；
- Responses：映射 `reasoning.effort`，不依赖 `summary`、`encrypted_content`、`store`、`prompt_cache_key` 或 `prompt_cache_retention`；
- Anthropic Messages：使用 `/anthropic/messages`，映射 `thinking` 和 `output_config.effort`，不伪造 thinking signature。

思考开启时，适配器会移除目标协议不支持的采样字段；显式 `none` 时保留协议支持的采样参数。

## 历史消息与 replay

canonical history 保存统一消息、工具调用和必要的 `providerReplay`。只有 replay version、protocol、service id 和 model 都相同时，才按原协议回放厂商专用块；否则使用可移植内容，不把原始思考字段伪装成普通助手文本。

修改 Base URL 不会改变 service id。若地址切换到另一家厂商，应新建模型服务，避免旧 replay 进入新的厂商请求。

## 代码位置

- 协议和请求字段：`settings/model-settings.js`；
- 模型服务 UI：`options/model-settings-panel.js`、`options/options.html`；
- 标准 Provider：`agent/providers/`；
- compat 注册：`agent/providers/compat/index.js`；
- DeepSeek 适配器：`agent/providers/compat/deepseek.js`；
- 非 Agent 请求：`background/model-client.js`。
