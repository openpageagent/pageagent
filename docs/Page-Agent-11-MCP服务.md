# Page Agent MCP 服务

MCP Server 是可选的 Node.js 传输层。它通过 stdio 接收 MCP 请求，通过 WebSocket 转发 ARP/1 请求到扩展；页面、Flow、Conversation、Knowledge 和权限逻辑仍由扩展内的 Resource Router 处理。

```text
MCP Client --stdio--> Node MCP Server --WebSocket--> Chrome Extension
                                             -> ARP/1 Router
```

## MCP 工具

MCP 对外提供六个方法工具：

```text
GET  POST  PUT  PATCH  DELETE  OPTIONS
```

`ASK_USER` 是扩展内 Agent 的对话工具，不通过 MCP 暴露。产品新增能力只增加 ARP Resource Route，不增加 MCP Tool。

调用参数沿用 [Page-Agent-10-ARP协议](./Page-Agent-10-ARP协议.md) 的固定外层。连接多个扩展时，在顶层传入 `mcpClientId`：

```json
{
  "name": "GET",
  "arguments": {
    "mcpClientId": "pfa_client_1",
    "uri": "/flows?limit=20"
  }
}
```

请求和业务错误都返回完整 ARP Envelope，并同时写入 MCP 的 `content` 与 `structuredContent`。Server 会移除传输专用字段后再发送给扩展；扩展根据已建立的连接生成可信权限上下文，不接受客户端自报的 actor、permission、origin、tab 或 window。

## 对话中的本地文件与命令

「允许对话操作本地文件与执行命令」默认开启。**未连接 MCP Server 时不向对话暴露这些能力**；连接成功且服务端支持时才提供。工作目录必填，未自定义时由服务端运行目录自动填充并回显，已保存的自定义目录优先。五项操作统一使用该目录，对话不能覆盖配置。普通窗口与隐私窗口分别保存设置；关闭、断线或更换目录后取消正在执行的命令，关闭或断线后隐藏目录并拒绝后续调用。已完成的文件修改不会撤销。

| ARP 路径（POST） | 参数 | 行为 |
| --- | --- | --- |
| `/local/read` | `path`、可选 `offset` / `limit` | 读取 UTF-8 文本；行号从 1 开始，默认 200 行 |
| `/local/write` | `path`、`content` | 创建或覆盖文件，自动创建父目录 |
| `/local/delete` | `path` | 删除文件或符号链接，不递归删除目录 |
| `/local/grep` | `path`、`pattern`、可选 `limit` | 递归查找区分大小写的字面文本，默认最多 100 行匹配 |
| `/local/bash` | `command`、可选 `timeoutMs` | 从配置的工作目录启动独立 Bash 进程，默认超时 30 秒，最多 60 秒 |

文件与命令在 **MCP Server 所在机器** 上操作。文件操作将相对路径解析到配置的工作目录，检查绝对路径、`..` 和符号链接是否越界；删除目录内的符号链接只删除链接本身。Bash 的启动目录固定为该目录，执行需要服务端安装 Bash；Bash 本身不是目录沙箱，命令仍以服务端进程权限运行。连接远程服务端须使用 `wss://`。

读取与查找只处理最多 4MB 的文本文件，写入最多 1MB；读取、查找和命令输出最多 64KB。查找跳过符号链接、二进制、大文件及 `.git` / `node_modules` 目录，最多访问 5000 个条目或扫描 60 秒；返回 `skipped` 和 `truncated` 表明结果是否完整。命令返回 stdout、stderr、退出码、超时和截断状态。取消、断线或超时后不要自动重放写入或命令，先确认实际结果。

能力沿用现有 WebSocket 与六个 ARP 方法工具，无需添加 MCP 服务器或额外依赖。开关仅允许扩展界面修改，对话不能自行开启。

## MCP Resources

MCP Resource URI 是 ARP URI 的可逆包装：

```text
ARP URI       /flows
MCP URI       arp:///flows
```

`resources/list` 从 `OPTIONS /` 获取根和一级资源。读取 `arp:///page` 或 `arp:///browser` 等聚合入口等价于局部 OPTIONS；读取 `arp:///flows`、`arp:///skills` 等业务资源等价于 GET。需要 query、创建或修改时使用六个方法工具，不在 Resource URI 中隐藏命令。

## 启动

开发方式：

```bash
cd mcp-server
npm install
npm start
```

默认地址：

```text
WebSocket  127.0.0.1:9999
HTTP       127.0.0.1:9998
```

构建单文件发布包：

```bash
npm run build:single
```

产物为 `mcp-server/dist/page-agent-mcp-server.cjs`，可由任意 MCP 客户端以 Node.js 启动：

```json
{
  "mcpServers": {
    "page-agent": {
      "command": "node",
      "args": ["/absolute/path/page-agent-mcp-server.cjs"]
    }
  }
}
```

## 配置项

命令行参数：

```text
--ws-port <port>       WebSocket 端口
--http-port <port>     HTTP 端口
--host <host>          默认绑定地址
--ws-host <host>       WebSocket 绑定地址
--http-host <host>     HTTP 绑定地址
--default-client-id <id>
--default-client-name <name>
```

对应环境变量为 `WS_PORT`、`HTTP_PORT`、`PAGE_AGENT_HOST`、`PAGE_AGENT_WS_HOST`、`PAGE_AGENT_HTTP_HOST`、`PAGE_AGENT_DEFAULT_CLIENT_ID`、`PAGE_AGENT_DEFAULT_CLIENT_NAME` 和 `PAGE_AGENT_HTTP_CORS_ORIGINS`。

`default-client-*` 只用于 HTTP webhook 等兼容入口。连接多个扩展时，MCP 方法工具必须显式提供 `mcpClientId`。

## HTTP API

HTTP 服务提供 Flow、FlowGroup webhook、运行结果和连接状态：

```text
POST /webhook/run/{flowId}
POST /webhook/run-group/{groupId}
GET  /webhook/result/{runId}
GET  /healthz
GET  /mcp/clients
```

示例：

```bash
curl -X POST http://localhost:9998/webhook/run/flow_123 \
  -H 'Content-Type: application/json' \
  -d '{"input":{"keyword":"example"}}'
```

默认等待 Run 进入终态；使用 `?wait=false` 立即返回 `202`，再通过 `/webhook/result/{runId}` 查询。`?timeoutMs=...` 可调整等待上限。请求体中的 `input` 可在 Flow 模板中通过 `{{input}}` 使用。

可选请求头：`Idempotency-Key`、`X-Page-Agent-Session-Id`、`X-Page-Agent-MCP-Client-Id`、`X-Page-Agent-MCP-Client-Name`。HTTP 响应始终是 ARP Envelope。

## 代码位置

- MCP 入口和 stdio：`mcp-server/index.js`；
- WebSocket 转发：`mcp-server/extension-request-broker.js`；
- HTTP webhook：`mcp-server/http-api.js`；
- 单文件构建：`mcp-server/scripts/build-single.js`。
