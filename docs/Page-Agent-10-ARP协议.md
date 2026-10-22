# Page Agent ARP/1 协议

ARP/1（Agent Resource Protocol）是 Page Agent 的统一资源接口。模型通过固定的方法和 Web request-target 访问页面、浏览器、Flow、Conversation、Knowledge、运行记录和外部连接。

## 协议面

模型侧固定使用七个工具：

```text
GET  POST  PUT  PATCH  DELETE  OPTIONS  ASK_USER
```

`OPTIONS` 描述当前权限下可用的能力；响应 `links` 提供可用 URI。`ASK_USER` 获取缺失的用户事实，不改变权限。调用步骤见 [ARP 工具调用](./Page-Agent-09-ARP工具调用.md)。

ARP 请求由四部分组成：

```text
HTTP 方法 + canonical resource path + 可选 query + Runtime 前置条件
```

所有写入经过中央 Router 的 schema、权限、幂等和审计检查。

## 资源路由

当前注册的资源域包括：

```text
/page                 页面读取与交互
/browser              Tab、Window、下载和 CDP
/flows                Flow、节点和运行
/flow-groups          FlowGroup 和运行
/conversations        对话、消息、事件和生成
/runs                 运行状态、报告和调试快照
/recordings/{id}       页面录制素材
/pages                页面配置
/scripts              脚本及运行
/apps                 应用、源码、数据和动作
/schedules            定时任务
/url-triggers         URL 触发器
/knowledge            知识条目
/knowledge-settings   知识设置
/skills               Skill 及其资源
/assistants           Assistant 配置
/node-types           Flow 节点目录
/model-services       模型服务
/connections          外部连接
/mcp-servers           外部 MCP 服务器和工具
/mcp-calls             MCP 调用记录
/local                本地文件与命令
/system-settings      系统设置
/mail-settings        邮件设置与发送
/config               扩展配置
```

完整路径目录由 `ResourceRegistry` 在运行时按权限和连接状态生成。资源 ID 是查询返回的不透明字符串。

## URI

canonical path 使用小写 kebab-case 资源名：

```text
/flows/{flowId}
/flows/{flowId}/runs
/conversations/{conversationId}/messages
```

GET 的筛选、分页和视图参数属于同一个 request-target：

```text
GET /flows/flow_123?view=validation
GET /recordings/r_1?view=events&fromSeq=1&toSeq=3&limit=20
```

GET 没有 body，也没有模型侧独立 `query` 字段。query 只能包含 RouteContract 声明的扁平标量或重复标量数组。外部 URL 和浏览器内部 URL 不能直接作为 ARP URI；页面导航或外部调用使用对应资源的参数。

## 方法语义

| 方法 | 语义 |
| --- | --- |
| GET | 读取 Representation，安全且幂等 |
| POST | 创建资源或记录一次 Interaction、Run、Call 等动作 |
| PUT | 使用完整 Representation 创建或替换，幂等 |
| PATCH | 使用非空 Merge Patch 局部修改 |
| DELETE | 删除资源或取消已声明可取消的 Operation |
| OPTIONS | 返回当前作用域的资源、方法、schema 和 links |

PATCH 的 media type 为 `application/merge-patch+json`，不接受 JSON Patch 操作数组。POST 和非天然幂等 PATCH 使用 Idempotency-Key。

## 输入合同

固定工具 schema 只负责外层，业务字段由 RouteContract 的 JSON Schema 定义：

| 工具 | 字段 |
| --- | --- |
| GET | `uri`；可选 `responseMode: "content" / "full"`、`ifNoneMatch` |
| POST | `uri`、按契约提供的 `body` |
| PUT | `uri`、完整 `body` |
| PATCH | `uri`、非空 `patch`；可选 `contentType` |
| DELETE | `uri`；仅契约声明时提供 `body` |
| OPTIONS | `uri`；可选 `match`、`relation`、`cursor`、`limit`（1–4） |
| ASK_USER | `mode: "input" / "choice"`、`prompt`；选择模式使用 `choices` |

POST、PUT、PATCH、DELETE 均接受 `preconditions` 和 `idempotencyKey`。

`preconditions` 包含 `ifMatch`、`ifNoneMatch`；幂等键长度为 8–256 字符。
具体必填条件由路由声明。

```json
{
  "uri": "/apps/app_example",
  "patch": { "name": "新名称" },
  "preconditions": { "ifMatch": "\"读取到的 ETag\"" },
  "idempotencyKey": "rename-app-example-001"
}
```

示例 ID 和 ETag 需替换为读取到的值。PATCH 的 `contentType` 省略时补为 `application/merge-patch+json`。

## 响应 Envelope

ARP 完整响应使用统一外壳；模型 GET 默认可返回路由声明的内容，设置 `responseMode: "full"` 可取得完整响应：

```json
{
  "protocol": "arp/1",
  "requestId": "arp_request_x",
  "status": { "code": 200, "reason": "OK" },
  "primary": {
    "uri": "/flows/flow_123",
    "type": "Flow",
    "etag": "\"abc\"",
    "data": {},
    "links": [{ "rel": "runs", "href": "/flows/flow_123/runs", "method": "POST" }]
  },
  "receipt": { "performed": "yes", "state": "succeeded" }
}
```

写操作和页面动作的 `receipt.performed` 为 `yes`、`no` 或 `unknown`。
`unknown` 表示请求可能已经产生副作用，需先查询实际状态。

异步操作还返回 `operationUri`、状态和 `retryAfterMs`。

错误包含结构化 `code`、`retryable` 和 `details`。

## 权限与并发

授权链为：

```text
Assistant resourcePolicy
  -> trusted permissionScope
  -> RouteContract.requiredPermissions
  -> Router authorizeResourceRequest
```

模型请求不能声明权限。权限不足返回 `403 FORBIDDEN`。

写操作按路由要求在 `preconditions.ifMatch` 中携带读取到的 ETag；缺失返回 `428`，不匹配返回 `412`。

所有请求经过：URI 规范化、路由匹配、输入校验、权限和前置条件、幂等检查、Adapter 执行、输出校验、脱敏审计和 Envelope 序列化。

## 页面资源

页面内容不会因入口绑定而自动读取。模型先读取：

```text
GET /page/current
```

页面动作使用资源化 POST，例如：

```text
POST /page/clicks
POST /page/fills
POST /page/selections
POST /page/scrolls
POST /page/waits
POST /page/javascript-executions
```

动作参数使用 canonical locator；执行前由页面引擎在当前 document 重新解析。
定位失效返回 `TARGET_NOT_FOUND` 或 `TARGET_STALE`，不会静默替换相似元素。

页面读取、动作和验证分别由 `PagePerceptionEngine`、`PageActionEngine`、`PageVerificationEngine` 负责。

导航会使旧文档的元素定位失效，Runtime 不自动读取新页面或重放动作。CDP lease 按 generation 持有，在 generation 终态统一释放。

## Conversation 与 Recording

对话运行使用：

```text
POST   /conversations
POST   /conversations/{id}/messages
GET    /conversations/{id}/events
DELETE /conversations/{id}/generations/{generationId}
```

Recording 使用一个 canonical path，通过 query 选择视图：

```text
GET /recordings/{id}
GET /recordings/{id}?view=events&fromSeq=1&toSeq=3
GET /recordings/{id}?view=search&q=checkout&context=1
```

读取 Recording 除了路由权限，还需要当前 Conversation 和 generation 的授权关联；知道 URI 或 hash 不能绕过该授权。

## 状态码

常见错误码：

```text
400 INVALID_REQUEST              401 AUTHENTICATION_REQUIRED
403 FORBIDDEN                    404 RESOURCE_NOT_FOUND
405 METHOD_NOT_ALLOWED           409 RESOURCE_CONFLICT
409 IDEMPOTENCY_CONFLICT         412 ETAG_MISMATCH
415 UNSUPPORTED_MEDIA_TYPE       422 SCHEMA_VALIDATION_FAILED
428 PRECONDITION_REQUIRED        429 RATE_LIMITED
502 UPSTREAM_FAILED              503 TEMPORARILY_UNAVAILABLE
504 OPERATION_TIMEOUT
```
