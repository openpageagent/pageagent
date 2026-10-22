# 第三方依赖声明

本项目使用的第三方组件遵循各自许可证。npm 依赖的版本和依赖关系见[根目录锁文件](package-lock.json)及 [MCP Server 锁文件](mcp-server/package-lock.json)；离线工具依赖另见下方清单。完整许可文本保留在随包许可文件或上游发布包中。

## 直接依赖

| 依赖 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| croner | 10.0.1 | 浏览器端定时任务 | [MIT](dependencies/croner/LICENSE) |
| marked | 14.0.0 | Markdown / GFM 解析 | [MIT](dependencies/marked/LICENSE.md) |
| dompurify | 3.4.15 | HTML 净化 | [Apache-2.0](dependencies/dompurify/LICENSE)（上游亦提供 MPL-2.0） |
| monaco-editor | 0.57.0 | 代码编辑与差异对比 | [MIT](dependencies/monaco/LICENSE) |
| turndown | 7.2.4 | HTML 转 Markdown | [MIT](dependencies/turndown/NOTICE.md) |
| turndown-plugin-gfm | 1.0.2 | Turndown GFM 支持 | [MIT](dependencies/turndown/NOTICE.md) |
| clean-css-cli | 5.6.3 | 发布包 CSS 压缩 | MIT |
| esbuild | 0.28.1（根目录）；0.19.12（MCP） | 发布包构建 | MIT |
| terser | 5.49.0 | 发布包 JavaScript 压缩 | BSD-2-Clause |
| fake-indexeddb | 6.2.4 | Node 环境兼容 IndexedDB API | Apache-2.0 |
| zod | 4.4.3（根目录） | schema 校验 | MIT |
| @modelcontextprotocol/sdk | 0.5.0 | MCP 协议 | MIT |
| ws | 8.21.0 | MCP Server WebSocket 传输 | MIT |
| nodemailer | 8.0.11 | SMTP/MIME 邮件发送 | [MIT-0](mcp-server/NODEMAILER_LICENSE) |
| robotjs（可选） | 0.9.1 | 桌面输入、截图和模板匹配 | MIT |

传递依赖的版本与许可标识见锁文件。MCP 单文件包保留上游许可注释，本声明随发布包提供。

## 随包代码与归属

- marked 和 DOMPurify：使用对应版本的官方预构建 UMD 文件，内容未经修改；DOMPurify 按 Apache-2.0 分发。
- Monaco Editor：使用 0.57.0 的部分预构建 `min/vs/` 文件，内容未经修改；第三方组件声明见 [ThirdPartyNotices.txt](dependencies/monaco/ThirdPartyNotices.txt)。
- pi-mono：部分 Provider 流式处理、消息转换、JSON 修复和错误归一化代码由其改编，采用 MIT License。版权归属及完整许可见 [PI_UPSTREAM_NOTICE.md](agent/providers/PI_UPSTREAM_NOTICE.md)。

## 离线工具

离线工具及其预构建文件内的依赖、版本、来源和完整许可见[工具箱第三方许可清单](utilities/THIRD_PARTY_NOTICES.html)。相关许可文件随 `dependencies/utilities/` 分发。

开发者工具箱参考 baiy/Ctool 的工具范围和页面交互，来源与致谢见[工具箱声明](builtin-apps/developer-tools/THIRD_PARTY_NOTICES.md)。

## 字体和图标

- Roboto 与 Roboto Slab：来自 Google Fonts，采用 Apache-2.0。
- Font Awesome 4.7.0：字体采用 SIL Open Font License 1.1，CSS 采用 MIT。
- flowfont：Page Agent contributors 的项目内置图标字体，采用 Apache-2.0。

字体随 `assets/ui-fonts/` 分发，版权归属及许可说明见[字体声明](assets/ui-fonts/NOTICE.md)。
