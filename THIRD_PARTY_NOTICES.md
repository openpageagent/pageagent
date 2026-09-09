# 第三方依赖声明

下列是项目直接声明或随项目分发的第三方依赖。版本以仓库中的 `package-lock.json` 和 `mcp-server/package-lock.json` 为准；完整许可证文本以依赖目录中的 `LICENSE`、`NOTICE.md` 或上游发布包为准。

| 依赖 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| croner | 10.0.1 | 浏览器端定时任务 | MIT |
| turndown | 7.2.4 | HTML 转 Markdown | MIT |
| turndown-plugin-gfm | 1.0.2 | Turndown GFM 支持 | MIT |
| clean-css-cli | 5.6.3 | 发布包 CSS 压缩 | MIT |
| esbuild | 0.28.1（根目录）；0.19.12（MCP） | 发布包构建 | MIT |
| terser | 5.49.0 | 发布包 JavaScript 压缩 | BSD-2-Clause |
| fake-indexeddb | 6.2.4 | Node 环境兼容 IndexedDB API | Apache-2.0 |
| zod | 4.4.3（根目录） | schema 校验 | MIT |
| @modelcontextprotocol/sdk | 0.5.0 | MCP Server 协议实现（同时进入发布的 MCP 单文件包） | MIT |
| ws | 8.21.0（lockfile 解析版本） | MCP Server WebSocket 传输 | MIT |

MCP Server 的 lockfile 还包含由上述组件引入的 `bytes`、`content-type`、`depd`、`http-errors`、`iconv-lite`、`inherits`、`raw-body`、`safer-buffer`、`setprototypeof`、`statuses`、`toidentifier`、`unpipe` 和 `zod`。它们的版本、许可证和完整依赖关系以 `mcp-server/package-lock.json` 为准；MCP 单文件构建会保留上游 legal comments。

浏览器端运行时副本位于 `dependencies/`，其中的 `dependencies/croner/LICENSE` 与 `dependencies/turndown/NOTICE.md` 随源码保留。MCP Server 的源码依赖不随仓库提交的 `node_modules/` 分发，安装时由 npm 根据 lockfile 获取；发布 ZIP 中的 `mcp-server/page-agent-mcp-server.cjs` 是由这些依赖生成的单文件包，本声明随发布包一并提供。

## 上游代码

`agent/providers/` 中部分 Provider 流式处理、消息转换、JSON 修复和错误归一化代码改编自 pi-mono，采用 MIT License。完整版权和许可证文本见 [`agent/providers/PI_UPSTREAM_NOTICE.md`](agent/providers/PI_UPSTREAM_NOTICE.md)。

## 字体和图标

- Roboto 与 Roboto Slab：来源为 Google Fonts，采用 Apache License 2.0；对应字体文件随 `assets/ui-fonts/` 分发。
- Font Awesome 4.7.0：采用 SIL Open Font License 1.1（字体）和 MIT（CSS）；来源及完整条款应随字体分发。
- `flowfont`：Page Agent contributors 的项目内置图标字体，随项目按 Apache License 2.0 分发，说明见 `assets/ui-fonts/NOTICE.md`。
