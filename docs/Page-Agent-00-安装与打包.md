# Page Agent 安装与打包

扩展支持下载 Release ZIP 后解压加载，也支持直接加载源码目录。

## 直接安装

环境要求：Chromium 116 或更高版本（Chrome、Edge 等）以及 Manifest V3 支持。

1. 打开 [GitHub Releases](https://github.com/openpageagent/pageagent/releases)，在对应版本的 Assets 中下载 `page-agent-extension-<version>.zip` 并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”，指定解压后的 `page-agent-extension/` 目录，该目录应直接包含 `manifest.json`。
5. 点击扩展图标打开侧边栏，再进入配置中心填写模型服务。

也可以克隆仓库后按上述步骤加载源码，第 4 步选择仓库根目录即可。

模型服务配置保存在当前浏览器的 `chrome.storage.local` 中。
使用对话前需在配置中心设置至少一个模型服务。

应用源码和业务数据保存在 IndexedDB 中。

## 升级与迁移

升级时替换扩展目录中的文件，然后在扩展管理页点击刷新。浏览器本地配置不会因替换文件而删除。

迁移到另一台设备前，在配置中心导出备份 JSON；新设备加载扩展后导入恢复，并重新配置模型凭据。

备份排除模型服务凭据，其他所选模块保留原值；「邮件通知」模块包含明文 SMTP 密码／授权码。

## 生成 ZIP

在仓库根目录安装依赖后执行：

```bash
npm install
cd mcp-server && npm install
cd ..
./page-agent-build.sh
```

脚本读取 `manifest.json` 的版本号，在 `dist/` 生成：

```text
dist/page-agent-extension-<version>/
dist/page-agent-extension-<version>.zip
```

默认压缩 JavaScript 和 CSS。保留源文件格式时使用以下命令，ZIP 文件名带 `-no-minify` 后缀：

```bash
./page-agent-build.sh --no-minify
```

自定义 ZIP 路径：

```bash
./page-agent-build.sh --zip dist/page-agent-extension-custom.zip
```

ZIP 内的顶层目录为 `page-agent-extension/`，其中直接包含 `manifest.json`。
包内附带 `mcp-server/page-agent-mcp-server.cjs`。

发布内容和压缩行为见[发布包与代码压缩](./Page-Agent-02-发布包与代码压缩.md)。

## 可选的 MCP Server

外部 MCP 客户端、HTTP webhook、本地文件与命令操作、邮件通知需要连接 MCP Server；普通页面对话和 Flow 不依赖该服务。

服务端需要 Node.js 16 或更高版本。使用源码时：

```bash
cd mcp-server
npm install
npm start
```

使用 Release ZIP 时，直接在解压后的扩展目录运行：

```bash
node mcp-server/page-agent-mcp-server.cjs
```

默认监听：

| 通道 | 地址 | 用途 |
| --- | --- | --- |
| MCP stdio | - | MCP 客户端进程通信 |
| WebSocket | `127.0.0.1:9999` | MCP Server 与扩展通信 |
| HTTP | `127.0.0.1:9998` | webhook、运行结果和健康检查 |

在配置中心的「连接配置」中开启 MCP Server 连接。
端口可通过 `--ws-port`、`--http-port` 或环境变量 `WS_PORT`、`HTTP_PORT` 修改。

完整接口见 [MCP 服务](./Page-Agent-11-MCP服务.md)。

## 模型服务

在配置中心的模型服务中填写：

- Base URL（例如 `https://api.example.com/v1` 或本地 Ollama 地址）；
- 模型名称，必要时填写视觉模型；
- API Key；
- 协议：OpenAI Chat Completions、OpenAI Responses 或 Claude Anthropic Messages；
- 请求超时、上下文长度和思考级别等可选参数。

扩展只向配置的地址发起模型请求，不会替用户脱敏页面内容、录制内容或 URL 参数。

## 常见问题

- **提示缺少 `manifest.json`**：加载目录选错，应选择包含该文件的目录。
- **更新后页面仍使用旧代码**：在扩展管理页刷新扩展，并刷新目标网页。
- **HTTP API 提示扩展未连接**：确认 MCP Server 正在运行，且配置页已启用 WebSocket 连接。
