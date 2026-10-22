# Page Agent 发布包与代码压缩

发布包由根目录的 `page-agent-build.sh` 生成，格式为 ZIP。安装和打包命令见[安装与打包](./Page-Agent-00-安装与打包.md)。

## 产物

版本号读取自 `manifest.json`，输出为：

```text
dist/page-agent-extension-<version>/
dist/page-agent-extension-<version>.zip
```

ZIP 内的顶层目录固定为 `page-agent-extension/`，其中直接包含 `manifest.json`。`--no-minify` 输出的 ZIP 带 `-no-minify` 后缀；`--zip <path>` 指定 ZIP 路径。

## 打包内容

脚本同步内置 Flow 和应用索引，准备 Turndown 运行时，构建 MCP Server 单文件包，再复制扩展资源、压缩并生成 ZIP。

包内包含扩展运行文件、内置资源、第三方运行时及许可证。MCP Server 位于 `mcp-server/page-agent-mcp-server.cjs`。

`docs/`、测试目录、Git 元数据、开发依赖和包管理文件不进入发布包。

## 压缩行为

JavaScript 使用 Terser，CSS 使用 clean-css。压缩删除空白和注释、缩短局部变量名，保留：

- 文件名、目录结构和脚本引用路径；
- 全局导出名、对象属性名和消息字段；
- Flow schema、ARP 路径和配置字段。

`--no-minify` 原样复制扩展 JS/CSS，仍执行索引同步、运行时准备和 MCP Server 打包。
