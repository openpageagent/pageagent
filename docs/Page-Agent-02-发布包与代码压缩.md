# Page Agent 发布包与代码压缩

当前发布格式是 ZIP。扩展目录必须在 ZIP 根目录下直接包含 `manifest.json`。项目不把手工生成的 CRX 作为普通用户的安装格式：Chrome 和 Edge 对非商店、非企业管理的 CRX 有额外限制。

## 内部分发包

根目录脚本生成可加载的扩展 ZIP：

```bash
npm install
cd mcp-server && npm install
cd ..
./page-agent-build.sh
```

产物位于 `dist/`：

```text
page-agent-extension-<version>/
page-agent-extension-<version>.zip
```

脚本会同步内置 Flow 索引、构建 MCP Server 单文件包，并使用 Terser 和 clean-css 压缩 JavaScript/CSS。压缩不会修改文件名、目录结构、全局名称、消息字段或对象属性名。保留源代码格式可使用 `--no-minify`。

内部分发时，将 ZIP 解压后通过 `chrome://extensions` 或 `edge://extensions` 的“加载已解压的扩展程序”安装。升级时替换目录并刷新扩展即可。

## 压缩策略

推荐只做代码压缩：删除空白和注释、缩短局部变量名、保留运行时可识别的字段和路径。不要使用属性名混淆、顶层名称混淆、控制流扁平化、字符串隐藏、死代码注入或自防护等方式。

保留以下内容不变：

- `manifest.json`、HTML 和脚本引用的文件路径；
- `importScripts()`、`chrome.scripting.executeScript({ files })` 使用的文件名；
- Flow schema、ARP 路径、消息字段、配置字段和全局导出名。

仓库脚本默认只压缩，不混淆。修改压缩参数后应重新加载发布目录，检查扩展管理页、配置中心、页面对话和一个最小 Flow 是否能正常打开。

## 版本号

版本号来自 `manifest.json`，必须递增后再提交商店更新：

```json
{ "version": "1.0.1" }
```

市场审核材料应说明扩展的页面自动化用途、Manifest 权限、用户配置的模型请求和可选 MCP 连接。不要把开发过程记录或内部测试日志放进发布包。
