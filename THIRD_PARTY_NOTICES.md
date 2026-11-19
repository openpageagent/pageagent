# 第三方依赖声明

本项目使用的第三方组件遵循各自许可证。npm 依赖的版本和依赖关系见[根目录锁文件](package-lock.json)及 [MCP Server 锁文件](mcp-server/package-lock.json)；离线工具依赖另见下方清单。完整许可文本保留在随包许可文件或上游发布包中。

## 直接依赖

| 依赖 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| @cordisjs/core | 3.18.1 | 内置能力插件生命周期和依赖注入 | [MIT](dependencies/cordis/LICENSE) |
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
| pg | 8.23.1 | 服务端 PostgreSQL 参数化 SQL，供 MCP 与浏览器扩展共用 | [MIT](mcp-server/POSTGRES_LICENSE) |
| mysql2 | 3.24.6 | 服务端 MySQL 参数化查询与授权写入，供 MCP 与浏览器扩展共用 | [MIT](mcp-server/MYSQL2_LICENSE) |
| @redis/client | 6.3.1 | 服务端 Redis 业务键查询与授权写入 | [MIT](mcp-server/REDIS_LICENSE) |
| ssh2 | 1.17.0 | 校验主机密钥的 SSH 命令执行，使用 Node.js 加密实现 | [MIT](mcp-server/SSH2_LICENSE) |
| @aws-sdk/client-s3 | 3.1171.0 | S3 / MinIO 对象查询、上传和删除 | [Apache-2.0](mcp-server/AWS_S3_LICENSE) |
| nodemailer | 8.0.11 | SMTP/MIME 邮件发送 | [MIT-0](mcp-server/NODEMAILER_LICENSE) |
| robotjs（可选） | 0.9.1 | 桌面输入、截图和模板匹配 | MIT |
| @koishijs/core / koishi | 4.18.11 | MCP Server 使用核心；koishi 满足官方适配器 peer 依赖，不加载其 Loader、Chat、Console 或市场 | MIT |
| @koishijs/plugin-http | 0.6.3 | 适配器 HTTP／WebSocket 客户端服务 | MIT |
| @koishijs/plugin-server | 3.2.9 | 适配器回调监听 | MIT |
| @koishijs/plugin-adapter-lark | 3.12.6 | 飞书消息适配 | MIT |
| @koishijs/plugin-adapter-dingtalk | 2.5.2 | 钉钉消息适配 | MIT |
| @koishijs/plugin-adapter-qq | 4.14.0 | QQ 官方机器人适配 | MIT |
| @koishijs/plugin-adapter-wecom | 2.5.0 | 企业微信应用适配 | MIT |
| [@wecom/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk) | 1.0.7 | 企业微信智能机器人长连接接入 | [MIT](mcp-server/WECOM_AIBOT_LICENSE) |
| @koishijs/plugin-adapter-mail | 2.3.2 | IMAP／SMTP 邮件适配 | MIT |
| xml2js | 0.6.2 | 企微加密回调信封检查（亦为官方适配器依赖） | MIT |

传递依赖的版本与许可标识见锁文件。MCP 单文件包保留上游许可注释，本声明随发布包提供。

Koishi 核心及上述适配器随 MCP 单文件打包，[Koishi／Satori／Cordis 许可文本](mcp-server/KOISHI_LICENSE)嵌入产物注释。回调服务间接依赖 Formidable 2，构建时将其内置解析器的动态路径加载改为静态索引引用，保留上游解析器。适配器依赖对应的 `@satorijs/adapter-*`（MIT）；邮件适配器另有自己的 Nodemailer 6.x 依赖，不替换现有 SMTP 通知服务的 Nodemailer 8.x。来源见 [Koishi](https://github.com/koishijs/koishi)、[官方适配器包装](https://github.com/koishijs/upstream)及 [Satori](https://github.com/satorijs/satori)。

## 随包代码与归属

- marked 和 DOMPurify：使用对应版本的官方预构建 UMD 文件，内容未经修改；DOMPurify 按 Apache-2.0 分发。
- Monaco Editor：使用 0.57.0 的部分预构建 `min/vs/` 文件，内容未经修改；第三方组件声明见 [ThirdPartyNotices.txt](dependencies/monaco/ThirdPartyNotices.txt)。
- Cordis Core 3.18.1 与其依赖 Cosmokit 1.6.2：使用上游已发布文件，添加局部浏览器加载包装；来源、修改范围及许可证见 [Cordis 声明](dependencies/cordis/NOTICE.md)。
- pi-mono：部分 Provider 流式处理、消息转换、JSON 修复和错误归一化代码由其改编，采用 MIT License。版权归属及完整许可见 [PI_UPSTREAM_NOTICE.md](agent/providers/PI_UPSTREAM_NOTICE.md)。

## 离线工具

离线工具及其预构建文件内的依赖、版本、来源和完整许可见[工具箱第三方许可清单](utilities/THIRD_PARTY_NOTICES.html)。相关许可文件随 `dependencies/utilities/` 分发。

开发者工具箱参考 baiy/Ctool 的工具范围和页面交互，来源与致谢见[工具箱声明](builtin-apps/developer-tools/THIRD_PARTY_NOTICES.md)。

## 字体和图标

- Roboto 与 Roboto Slab：来自 Google Fonts，采用 Apache-2.0。
- Font Awesome 4.7.0：字体采用 SIL Open Font License 1.1，CSS 采用 MIT。
- flowfont：Page Agent contributors 的项目内置图标字体，采用 Apache-2.0。

字体随 `assets/ui-fonts/` 分发，版权归属及许可说明见[字体声明](assets/ui-fonts/NOTICE.md)。
