# Page Agent

Page Agent 是一个 Chromium 页面自动化扩展，支持通过自然语言操作网页、创建可复用流程和应用。

当前版本：`1.1.0`

## 从对话到可复用的产出

下面的示例通过对话读取 Books to Scrape 的 11 本书，提取书名、价格和库存，并保存为可重复运行的 Flow。

![Page Agent：从对话到可复用的产出](assets/readme-demo/page-agent-demo.gif)

## 主要能力

- **页面自动化**：读取网页、执行操作、提取数据，支持录制和截图。
- **流程编排**：创建 Flow、FlowGroup 和脚本，支持手动、定时或 URL 触发，并查看运行报告。
- **应用开发**：通过对话或代码创建应用，预览发布并调用流程和脚本。
- **离线工具**：编解码、格式转换、加密校验等，支持对话、应用、流程和脚本调用。
- **模型与知识**：支持 OpenAI Chat/Responses、Anthropic Messages 及兼容服务，可配置助手、知识和 Skill。
- **邮件通知**：通过已连接的 MCP Server 发送流程通知，支持附件。见[邮件配置](docs/Page-Agent-12-邮件通知.md)。
- **浏览器代理**：支持域名匹配、绕过规则和 HTTP／HTTPS 代理认证。

## 应用与离线工具

在配置中心的「应用」中打开或创建应用，点击「对话调整」继续修改。内置「开发者工具箱」、Developer Utils 和「GitLab 批量操作」，支持离线计算、多分支 Cherry-pick 和批量创建合并请求；需要定制时可「复制后修改」。

用法见[应用说明](docs/Page-Agent-13-应用.md)、[开发者工具箱](builtin-apps/developer-tools/README.md)、[Developer Utils](builtin-apps/developer-utils/README.md)和[GitLab 批量操作](builtin-apps/gitlab-tools/README.md)。

## 定时运行

在配置中心设置流程、流程组或对话的运行计划，支持固定间隔、每天多个时刻、指定日期和 Cron，也可按工作日或节假日批量选日。

运行使用浏览器本地时区，浏览器需保持运行；错过超过 5 分钟的固定时刻不补跑。

## 安装扩展

需要 Chromium 116 或更高版本。

1. 从 [GitHub Releases](https://github.com/openpageagent/pageagent/releases) 下载 `page-agent-extension-<version>.zip` 并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式。
3. 点击“加载已解压的扩展程序”，选择解压后的 `page-agent-extension/` 目录（该目录应直接包含 `manifest.json`）。
4. 点击扩展图标打开侧边栏，在配置中心填写模型服务；API Key 仅保存于本地浏览器存储。

也可克隆仓库后加载根目录。详见[安装说明](docs/Page-Agent-00-安装与打包.md)。

## 可选 MCP Server

MCP Server 通过 ARP/1 让外部 Agent 调用扩展，也提供本地文件、Bash、桌面操作和邮件发送能力。扩展本体可独立运行。从解压后的发布目录启动：

```bash
node mcp-server/page-agent-mcp-server.cjs
```

默认监听 WebSocket `127.0.0.1:9999` 和 HTTP `127.0.0.1:9998`。桌面操作支持 macOS 和 Windows，部分能力需安装可选依赖并授予系统权限。源码启动、连接配置与平台要求见 [MCP 服务说明](docs/Page-Agent-11-MCP服务.md)。

## 打包

安装 Node.js、npm、`rsync` 和 `zip`，分别在根目录及 `mcp-server/` 安装依赖后执行：

```bash
./page-agent-build.sh
```

ZIP 输出到 `dist/`。内置应用源码和默认主题保留可读形式，详见[打包说明](docs/Page-Agent-02-发布包与代码压缩.md)。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `manifest.json`、`background.js`、`content/`、`options/`、`sidepanel/` | Chromium 扩展运行时 |
| `agent/`、`flows/`、`resources/`、`shared/` | Agent、Flow 和 ARP/1 核心 |
| `apps/`、`builtin-apps/` | 应用管理、页面 SDK、备份与内置应用 |
| `utilities/`、`ui/` | 离线计算工具与共享界面组件 |
| `mcp-server/` | 可选 Node.js MCP 传输服务 |
| `dependencies/` | 随扩展分发的浏览器端第三方运行时 |
| `builtin-flows/`、`builtin-skills/` | 内置 Flow 和 Skill |
| `docs/` | 安装、协议、兼容性和分发说明 |

## 权限与数据

扩展需要访问网页、Cookie、下载、代理和调试接口等权限。请审阅应用授权、流程、模型及 MCP 配置；页面内容、录制和模型请求可能包含敏感信息，项目不会自动脱敏。

## 依赖与许可证

项目使用 Apache License 2.0。第三方依赖与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，使用前请阅读 [DISCLAIMER.md](DISCLAIMER.md)。

## 致谢

感谢 [Linux.do](https://linux.do/) 社区以及各位佬友的经验分享。

## 联系与协作

唯一公开联系方式：`harrylee@linux.do`。个人项目，业余维护，不提供商业服务或即时响应承诺。

代码与文档由 AI 工具生成和维护。反馈问题请提供日志、复现步骤和最小示例；修复通过 GitHub Pull Request 提交。

请先阅读[问题反馈说明](docs/Page-Agent-01-贡献与问题反馈.md)和 [CONTRIBUTING.md](CONTRIBUTING.md)，提交时使用 [Pull Request 模板](.github/pull_request_template.md)。安全问题按 [SECURITY.md](SECURITY.md) 报告。
