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
