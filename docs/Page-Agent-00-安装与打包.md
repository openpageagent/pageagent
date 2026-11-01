# Page Agent 安装与打包

扩展支持下载 Release ZIP 后解压加载，也支持直接加载源码目录。

## 直接安装

环境要求：Chromium 116 或更高版本（Chrome、Edge 等）以及 Manifest V3 支持。

1. 打开 [GitHub Releases](https://github.com/openpageagent/pageagent/releases)，在对应版本的 Assets 中下载 `page-agent-extension-<version>.zip` 并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”，指定解压后的 `page-agent-extension/` 目录，该目录应直接包含 `manifest.json`。
5. 点击扩展图标，在菜单中选择「侧边栏」，或按 `Alt+Shift+,`（macOS：`⌥⇧,`）打开侧边栏，再进入配置中心填写模型服务。按 `Alt+Shift+.`（macOS：`⌥⇧.`）关闭侧边栏，分别使用键帽带 `<` / `>` 的逗号键和句号键。

快捷键可在 `chrome://extensions/shortcuts` 或 `edge://extensions/shortcuts` 中修改；扩展菜单显示浏览器实际分配的打开侧边栏和配置项快捷键。升级后若仍保留旧快捷键，可在上述页面重新设置。

加载源码时，克隆仓库并选择仓库根目录作为扩展目录。

模型服务配置保存在当前浏览器的 `chrome.storage.local` 中。
使用对话前需在配置中心设置至少一个模型服务。

应用源码和业务数据保存在 IndexedDB 中。

## 升级与迁移

升级时替换扩展文件，并在扩展管理页刷新。浏览器本地配置保留。

迁移到另一台设备前，在配置中心导出备份 JSON；新设备加载扩展后导入恢复，并重新配置模型凭据。

备份不含模型服务凭据和 MCP 配对凭据，导入连接后需重新配对。「邮件通知」模块包含明文 SMTP 密码／授权码；内置 GitLab 工具的导出会剔除访问令牌。

## 生成 ZIP

打包需要 Node.js 22.16.0 或更高版本、npm、Bash、rsync 和 zip。在仓库根目录安装依赖并打包：

```bash
npm install
cd mcp-server && npm install
cd ..
./page-agent-build.sh
```

版本号取自 `manifest.json`，产物为：

```text
dist/page-agent-extension-<version>/
dist/page-agent-extension-<version>.zip
```

默认压缩扩展 JavaScript 和 CSS。保留扩展源文件格式，生成带 `-no-minify` 后缀的 ZIP（MCP 单文件仍压缩）：

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

## 独立打包 MCP Server

需要 Node.js 22.16.0 或更高版本。在仓库根目录安装依赖并打包：

```bash
npm --prefix mcp-server ci
npm --prefix mcp-server run build:single
```

依赖未变化时可跳过安装。产物为 `mcp-server/dist/page-agent-mcp-server.cjs`，在仓库根目录运行：

```bash
node mcp-server/dist/page-agent-mcp-server.cjs
```

## 独立部署 MCP Server

需要 Node.js 22.16.0 或更高版本。将打包产物或 Release ZIP 中的 `mcp-server/page-agent-mcp-server.cjs` 复制到部署目录，在该目录启动：

```bash
node page-agent-mcp-server.cjs
```

部分桌面功能需额外安装 `robotjs`，见 [桌面操作](./Page-Agent-11-MCP服务.md#桌面操作)。迁移已有服务时，按 [服务端认证状态迁移](./Page-Agent-11-MCP服务.md#服务端认证状态迁移)保留身份与配对。

## 可选的 MCP Server

外部 MCP 客户端、本地文件、命令、桌面操作和邮件通知需要连接 MCP Server；普通页面对话和 Flow 不依赖该服务。

服务端需要 Node.js 22.16.0 或更高版本。在项目根目录启动源码：

```bash
npm --prefix ./mcp-server install
node mcp-server/index.js
```

使用 Release ZIP 时，在解压后的扩展目录启动服务：

```bash
node mcp-server/page-agent-mcp-server.cjs
```

首次启动自动生成并显示配对密码，后续启动复用已有密码。认证、审计和服务端状态默认统一保存在启动工作目录下的 `./data/`，可用 `--state-dir <目录>` 指定。旧版状态保存在工作目录根部时，按 [状态迁移说明](./Page-Agent-11-MCP服务.md#服务端认证状态迁移)迁移后启动。`--password <密码>` 用于设置或重置密码，并撤销已有配对；密码至少 12 个字符。

默认监听：

| 通道 | 地址 | 用途 |
| --- | --- | --- |
| WebSocket | `127.0.0.1:9999` | MCP Server 与扩展通信 |
| HTTP | `127.0.0.1:9998` | Streamable HTTP MCP、扩展连接列表和健康检查 |

扩展使用 WebSocket 配对连接；外部 MCP 客户端使用 Streamable HTTP 和 Bearer 令牌。HTTP 令牌可通过 `PAGE_AGENT_HTTP_BEARER_TOKEN` 设置，未配置时复用已有令牌，没有则自动生成并仅显示一次。
端口可通过 `--ws-port`、`--http-port` 或环境变量 `WS_PORT`、`HTTP_PORT` 修改。

服务能力、授权和调用范围见 [MCP 服务](./Page-Agent-11-MCP服务.md)。

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
