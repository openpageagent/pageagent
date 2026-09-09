# Page Agent 安装与打包

本文说明当前版本扩展的安装、升级、配置迁移和 ZIP 打包方式。扩展可以从 [GitHub Releases](https://github.com/openpageagent/pageagent/releases) 下载打包好的 ZIP 后解压加载，无需本地打包；也可以直接加载源码目录，或使用仓库根目录的 `page-agent-build.sh` 自行生成 ZIP。

## 直接安装

环境要求：Chromium 114 或更高版本（Chrome、Edge 等）以及 Manifest V3 支持。

1. 打开 [GitHub Releases](https://github.com/openpageagent/pageagent/releases)，在对应版本的 Assets 中下载 `page-agent-extension-<version>.zip` 并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”，指定解压后的 `page-agent-extension/` 目录，该目录应直接包含 `manifest.json`。
5. 点击扩展图标打开侧边栏，再进入配置中心填写模型服务。

也可以克隆仓库后按上述步骤加载源码，第 4 步选择仓库根目录即可。

API Key 和其他配置保存在当前浏览器的 `chrome.storage.local` 中。首次使用时需要在配置中心设置至少一个模型服务。

## 升级与迁移

升级时替换扩展目录中的文件，然后在扩展管理页点击刷新。浏览器本地配置不会因替换文件而删除。

迁移到另一台设备前，在配置中心导出配置 JSON；新设备加载扩展后使用导入功能恢复。导出文件不包含模型 API Key 等敏感凭据。

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

默认会压缩 JavaScript 和 CSS，但保留文件名、目录结构、全局名称和对象属性名。需要保留源文件格式时使用：

```bash
./page-agent-build.sh --no-minify
```

自定义 ZIP 路径：

```bash
./page-agent-build.sh --zip dist/page-agent-extension-custom.zip
```

ZIP 解压后得到的目录直接包含 `manifest.json`，可按上面的“直接安装”步骤加载。构建脚本会把 MCP Server 的单文件产物复制到 ZIP 的 `mcp-server/page-agent-mcp-server.cjs`；扩展本身不依赖 MCP Server。

## 可选的 MCP Server

需要让外部 MCP 客户端调用扩展，或通过 HTTP webhook 触发 Flow 时，才启动 MCP Server：

```bash
cd mcp-server
npm install
npm start
```

默认监听：

| 通道 | 地址 | 用途 |
| --- | --- | --- |
| MCP stdio | - | MCP 客户端进程通信 |
| WebSocket | `127.0.0.1:9999` | MCP Server 与扩展通信 |
| HTTP | `127.0.0.1:9998` | webhook、运行结果和健康检查 |

配置页的“MCP Server”选项必须开启 WebSocket 连接。端口可通过 `--ws-port`、`--http-port` 或同名环境变量修改。完整接口见 [Page-Agent-11-MCP服务](./Page-Agent-11-MCP服务.md)。

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
