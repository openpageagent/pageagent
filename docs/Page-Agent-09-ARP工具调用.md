# Page Agent ARP 工具调用

ARP 调用成功依赖三类确定信息：当前可用的资源路径、目标路径的 RouteContract，以及固定的工具外层。运行时只处理能证明不改变语义的小瑕疵，不替模型猜测业务意图。

## 固定工具

模型始终使用七个工具：

```text
GET  POST  PUT  PATCH  DELETE  OPTIONS  ASK_USER
```

工具 schema 只描述通用 Web 请求外层，业务能力通过资源路径和 RouteContract 扩展。新增资源不新增模型工具。同一 generation 内工具集合和 schema 保持稳定。

| 方法 | 模型输入 |
| --- | --- |
| GET | `uri`，可选 `responseMode`、`ifNoneMatch` |
| POST | `uri`，路由需要时的 `body` |
| PUT | `uri`、完整 `body` |
| PATCH | `uri`、非空 `patch` |
| DELETE | `uri`，路由声明时才有 `body` |
| OPTIONS | `uri`，可选 `match`、`relation`、`cursor`、`limit` |
| ASK_USER | 当前资源和运行时无法提供、且会改变结果的用户事实 |

外层 schema 是闭合对象。GET 不接受独立 `query` 或 body；PATCH 不用 `body` 代替 `patch`；`resourceUri` 等同义字段不属于当前协议。

## 路径和 ID

模型可使用的路径只来自：

1. 当前权限下 `ResourceRegistry` 生成的路径目录；
2. 当前上下文中的 canonical URI 或真实 ID；
3. 资源表示的 `links[].href`；
4. `OPTIONS` 返回的 RouteContract。

不能根据产品名称、自然语言动词、旧接口或 REST 惯例创造同义路径。`{id}` 只能替换为已经取得的真实 ID。

路径使用小写 kebab-case，资源只有一个 canonical path。执行、运行、交互和外部调用建模为 POST 创建的资源，不能隐藏在 GET 或 PATCH 中。

## GET request-target

GET 的 query 属于 `uri`：

```json
{ "uri": "/flows/flow_123?view=validation" }
```

query 字段必须符合该路径的闭合 schema，只能是字符串、数字、整数、布尔值或重复参数形式的一维标量数组：

```text
/recordings/r_1?fromSeq=1&toSeq=3&kinds=click&kinds=navigate
```

不要把对象或 JSON 文本塞进 query。Runtime 会拆分 path/query，并按 RouteContract 做有限类型转换；不会替换路径、补造字段或改变业务值。request-target 保持可读，网络传输的最终 URL 编码由传输层完成。

## RouteContract 与 OPTIONS

路径目录回答“有哪些路径”，RouteContract 回答“这个路径如何调用”。query、body、patch、前置条件和返回结构都必须来自当前 RouteContract 或 `OPTIONS`，不能凭字段名猜测。

当路径或精确合同未披露时，先对最窄的已知 URI 调用 `OPTIONS`。`OPTIONS` 只返回能力描述，不读取业务数据，也不执行动作。已知路径但收到 `404`、`405` 或 `422` 时，使用错误中的精确恢复信息或再次对同一 URI 调用 `OPTIONS`。

## 前置条件和幂等

RouteContract 声明 `If-Match` 时，先 GET 同一 canonical URI 取得当前 ETag，再执行 PUT、PATCH 或 DELETE。不能猜 ETag、跨资源复用或在 `412` 后直接重放旧请求。

POST 和非天然幂等 PATCH 使用 Idempotency-Key。一次不安全调用只表达一个用户意图；写入和执行请求不并行。`performed=unknown` 表示结果不确定，不能更换 Key 自动重放，只能读取状态或报告未知。

## 允许的规范化

运行时只做唯一、确定且不改变语义的处理：

- 聚合同一协议的流式工具参数片段；
- 规范化固定方法名大小写和首尾空白；
- 依据已匹配 schema 转换 query 标量类型；
- 合同明确时补空对象、Merge Patch media type 或幂等 Key；
- 对 request-target 做必要的分隔字符转义。

不存在唯一解释时必须返回错误。不得把相似路径自动映射、恢复旧 `query` 外层、把 JSON Patch 改成 Merge Patch、截断越界值、补造业务字段或拆分一个请求中的多个动作。

## 结构化错误

工具结果包含 `performed`、`retryable`、错误阶段和可用恢复信息。常见错误：

| 情况 | 状态 |
| --- | --- |
| 外层字段错误 | `400 INVALID_REQUEST` |
| 路径未注册 | `404 RESOURCE_NOT_FOUND` |
| 方法不允许 | `405 METHOD_NOT_ALLOWED` |
| media type 不支持 | `415 UNSUPPORTED_MEDIA_TYPE` |
| RouteContract 校验失败 | `422 SCHEMA_VALIDATION_FAILED` |
| 缺少前置条件 | `428 PRECONDITION_REQUIRED` |
| ETag 冲突 | `412 ETAG_MISMATCH` |
| 权限不足 | `403 FORBIDDEN` |

恢复逻辑优先使用结构化字段和 links，不能把所有失败统一重试一次。工具卡片和 trace 同时保留原始 `uri`、解析后的 canonical path、匹配的 route template、校验结果和终态 `performed`。

## 成功率的实现重点

提高首次成功率的顺序是：先补齐当前路径目录，再披露 RouteContract，再处理确定性规范化，最后才分析模型差异。缓存相关的前缀和 guidance 行为见 [Page-Agent-07-提示词缓存](./Page-Agent-07-提示词缓存.md)，完整方法和响应合同见 [Page-Agent-10-ARP协议](./Page-Agent-10-ARP协议.md)。
