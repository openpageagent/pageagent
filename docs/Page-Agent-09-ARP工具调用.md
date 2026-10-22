# Page Agent ARP 工具调用

模型通过固定工具调用资源或询问用户。

## 固定工具

协议定义以下七个工具，运行时按入口和权限确定可用集合：

```text
GET  POST  PUT  PATCH  DELETE  OPTIONS  ASK_USER
```

资源工具 schema 描述通用 Web 请求外层，业务能力由资源路径和 RouteContract 定义。
同一 generation 内工具集合和 schema 保持稳定。

| 方法 | 模型输入 |
| --- | --- |
| GET | `uri`，可选 `responseMode`、`ifNoneMatch` |
| POST | `uri`，路由需要时的 `body` |
| PUT | `uri`、完整 `body` |
| PATCH | `uri`、非空 `patch` |
| DELETE | `uri`，路由声明时才有 `body` |
| OPTIONS | `uri`，可选 `match`、`relation`、`cursor`、`limit` |
| ASK_USER | `mode`、`prompt`，选择模式可附 `choices`；只询问当前资源和运行时无法提供、且会改变结果的用户事实 |

写入方法还支持 `preconditions` 和 `idempotencyKey`，按路由契约提供。
PATCH 可指定 `contentType: "application/merge-patch+json"`，省略时由运行时补全。

外层 schema 是闭合对象。
GET 不接受独立 `query` 或 body；PATCH 不用 `body` 代替 `patch`；`resourceUri` 等同义字段不属于当前协议。

完整字段约束、响应及错误码见 [ARP 协议](./Page-Agent-10-ARP协议.md)。

## 查找资源

路径来自当前权限下的资源目录、上下文 URI、响应 `links` 或 `OPTIONS`。资源 ID 使用查询得到的真实值。

路径或参数未知时，对最窄的已知资源调用 `OPTIONS`。返回的 RouteContract 描述 query、body、patch、前置条件和输出；`OPTIONS` 本身不读取业务数据或执行动作。

## 读取

GET 查询参数写在 `uri` 中：

```json
{ "uri": "/flows/flow_123?view=validation" }
```

数组使用重复参数，例如 `/recordings/r_1?fromSeq=1&toSeq=3&kinds=click&kinds=navigate`。

参数类型由目标路由的 schema 定义。

默认返回路由声明的内容；需要 ETag 等协议元数据时设置 `responseMode: "full"`。

## 写入与执行

1. 读取目标资源及其契约；需要版本保护时，取得同一 URI 的当前 ETag。
2. 按方法提供 `body` 或非空 `patch`，将 ETag 放入 `preconditions.ifMatch`。
3. POST 和非天然幂等 PATCH 使用 `idempotencyKey`；一次操作的重试复用同一个键。
4. 检查响应状态和 `receipt`；异步任务通过返回的运行 URI 查询结果。

PATCH 使用 `application/merge-patch+json`，字符串和数组按字段整体替换。DELETE 仅在路由契约声明时接受 body。

每次写入或执行请求表达一个用户意图；存在副作用的调用顺序执行。
`performed: "unknown"` 时保留原幂等键，读取状态确认结果，不通过更换键重放操作。

## 离线计算

离线工具通过 `POST /utilities/{tool}/{operation}` 执行，操作由路径确定，请求体只含 `input` 和可选的 `options`。例如：

```json
{
  "uri": "/utilities/hash/digest",
  "body": { "input": "abc", "options": { "algorithm": "SHA256" } }
}
```

已知契约时可直接执行；工具或参数未知时，通过 `GET /utilities`、`GET /utilities/{tool}` 或具体操作的 `OPTIONS` 查询。目录中的 `uri`、`operationUris` 提供准确地址。

执行结果为 `{tool, operation, value}`，完整 ARP 响应中位于 `primary.data`。
读取目录需要 `utilities.read`，执行需要 `utilities.execute`；系统默认包含这两项，实际调用受入口权限范围限制。

工具范围、输入输出和限制见[开发者工具箱](../builtin-apps/developer-tools/README.md)。Developer Utils 的 HTML/Markdown 页面预览不属于计算资源。

## 错误处理

| 结果 | 后续操作 |
| --- | --- |
| `404`、`405`、`422` | 检查错误详情，必要时对已知 URI 读取 `OPTIONS` |
| `428` | 补齐契约要求的前置条件 |
| `412` | 重新读取资源，核对修改后再提交 |
| `403` | 检查当前授权范围 |
| `performed: "unknown"` | 查询实际状态，确认结果后再决定是否重试 |

## 规范化边界

运行时规范化固定方法名的大小写和首尾空白，按路由 schema 转换查询参数类型；契约明确时补全空对象、Merge Patch 类型或幂等键。

未知路径、额外字段和越界参数返回错误。
运行时不把相似路径自动映射，不将 JSON Patch 改为 Merge Patch，也不补造业务字段或拆分多个动作。
