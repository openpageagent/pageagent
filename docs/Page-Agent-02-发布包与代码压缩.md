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

包内包含扩展运行文件、内置资源、第三方运行时及许可证。MCP Server 位于 `mcp-server/page-agent-mcp-server.cjs`；Dockerfile、构建脚本、Compose、构建过滤规则和启动脚本统一位于 `docker/`，保留源码中的目录结构，可按 [Docker 部署说明](../docker/README.md) 部署。

`docs/`、测试目录、Git 元数据、开发依赖和包管理文件不进入发布包。

## 压缩行为

扩展 JavaScript 使用 Terser 压缩，CSS 使用 clean-css。压缩删除空白和注释、简化代码，未启用变量名混淆，保留：

- 文件名、目录结构和脚本引用路径；
- 全局导出名、对象属性名和消息字段；
- Flow schema、ARP 路径和配置字段。

内置应用、内置 Skill 和应用默认主题保留可读源码；部分第三方运行时不重复压缩。

`--no-minify` 原样复制扩展 JS/CSS，仍同步内置索引、准备运行时并打包 MCP Server。MCP 单文件由 esbuild 独立压缩，不受该选项影响。
