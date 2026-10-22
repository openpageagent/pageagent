# 开发者工具箱

Page Agent 内置的离线工具集合，覆盖加密校验、编解码、文本与数据处理、数值与时间转换、内容生成和网络文本处理。应用、流程、脚本和对话共用插件的 `/utilities` 能力，完整工具与操作对应关系见 [TOOL-MAP.md](./TOOL-MAP.md)。

## 使用

在「应用」中打开「开发者工具箱」，按分类选择工具，或搜索工具名称。应用 ID 为 `app_developer_tools`，别名为 `developer-tools`。

- **处理内容**：按页面提示输入文本、选择文件或调整参数。实时工具随输入更新，生成工具按页面按钮生成或刷新；支持复制结果、下载文件及二维码、条形码预览。
- **对话联动**：对话可通过 `POST /apps/app_developer_tools/open` 传入 `{input:{toolId,input,operation?}}`，直接打开指定工具并填入文本。多个工具的计算通过 `/utilities` 串联。启动约定可从应用摘要的 `slots.published.customBehavior` 读取，示例见[应用文档](../../docs/Page-Agent-13-应用.md#内置开发工具联动)。
- **管理常用**：在同一列表中勾选工具，新勾选的工具追加到常用末尾。已选项左侧显示六点标记，可直接拖拽整行排序；悬停时右侧显示三点按钮，点击后可选择「置顶」。聚焦已选行后也支持方向键移动、Home 置顶、End 置底；调整后点击「保存」。默认常用包含 Docker → Compose。
- **独立配置**：常用工具及顺序按应用 ID 独立保存，立即写入本机应用数据，无需保存插件全局配置；内置应用更新保留已有设置，不保存工具输入或结果。「恢复默认」后需点击「保存」才生效。
- **权限**：工具调用需要开启 SDK，并允许 `utilities.read`、`utilities.execute`；保存常用配置还需应用数据读写权限。权限被关闭时，可在「应用权限」中调整，或「重置为默认权限」后保存。

## 流程、脚本与对话

### 流程

在流程编辑器的「开发者工具箱」分类下添加工具节点，直接配置输入和参数。也可在应用中点击「复制流程节点」，然后在流程的「添加节点 → 粘贴节点 JSON」中导入并保存。

节点输出统一为 `{tool, operation, value}`。后续节点通过 `{{last.value}}` 读取结果；对象结果使用 `{{json last.value}}`。

### 脚本

单操作工具使用 `api.utilities.<tool>(input, options)`，多操作工具使用 `api.utilities.<tool>.<operation>(input, options)`，直接返回计算值：

```js
const digest = await api.utilities.hash('abc', { algorithm: 'SHA256' });
const encoded = await api.utilities.base64.encode('abc');
const formatted = await api.utilities.json.format('{"name":"demo"}');
return { digest, encoded, formatted };
```

动态选择工具时，使用 `api.utilities.execute(toolId, {operation, input, options})`，返回 `{tool, operation, value}`。`api.utilities.list()` 用于查询可用工具，无需在每次调用前执行。执行工具需 `utilities.execute`，查询目录需 `utilities.read`。

### 应用与对话接口

已知操作地址和参数时，直接调用 `POST /utilities/{tool}/{operation}`。请求体只含 `input`、`options`，操作由 URI 确定。应用通过现有 SDK 调用：

```js
const response = await PageAgent.resources.request('POST', {
  uri: '/utilities/hash/digest',
  idempotencyKey: crypto.randomUUID(),
  body: { input: 'abc', options: { algorithm: 'SHA256' } }
});
if (response.error) throw new Error(response.error.message);
const digest = response.primary.data.value;
```

不清楚工具或参数时，使用 `GET /utilities` 查询目录、`GET /utilities/{tool}` 查询工具说明，或 `OPTIONS /utilities/{tool}/{operation}` 查询执行契约。执行地址以目录返回的 `operationUris` 为准；路径使用小写连字符，例如 `qrCode` 对应 `/utilities/qr-code`。

对话使用同一资源接口，需要对应权限。生成的图片等内容以数据返回，不会自动打开工具箱页面。

## 能力边界

- 所有计算在本地进行，不提供在线查询、URL 内容读取或代码执行。应用不保存输入历史；对话、流程及公共接口的执行记录沿用宿主策略。
- JWT 仅解码，不验证签名；RSA 加解密使用 RSA-OAEP 与 SPKI/PKCS#8 PEM；ECDSA 使用 P1363 签名格式。
- JSON Schema 使用 2020-12，只处理输入中的本地 schema，不下载远程引用。JSON 转代码从样本推导类型，生成结果需按业务需求复核。
- 代码压缩支持 JS/JSON/CSS；Java 格式化仅调整词法缩进。XML 转 JSON 不保证无损往返；PHP 序列化仅支持标量和数组，不实例化对象或解析引用。
- HTTP 工具生成请求示例文本，不执行请求或展开 Shell；Docker 转换遇到未支持的参数会报错。
- 二维码公共接口默认输出 SVG，页面使用 PNG；解析接受 PNG/JPEG/WebP 图片，最多约 400 万像素。
- 最多同时执行两个任务，超额报忙；单次计算期限 15 秒。输入文本上限为 65,536 字符，整体参数 JSON 上限为 100,000 字符，结果 JSON 上限为 98,304 字符。

具体操作和参数以 [catalog.js](../../utilities/catalog.js) 为准。

## 开发与维护

本应用的界面 JS/CSS 和默认主题通过 `sourceFiles` 安装到 `code.files`，支持「复制后修改」。副本的「源码文件」页签和对话接口均可编辑这些文件，发布和导出会携带原文。公共工具算法仍使用插件的 `/utilities` 服务。

| 文件 | 职责 |
| --- | --- |
| [developer-tools.json](../developer-tools.json) | 应用声明、HTML 与本地模块入口 |
| [app.js](./app.js) | 导航、通用表单与工具调用 |
| [views.js](./views.js)、[crontab.js](./crontab.js) | 组合页面、联动输入与 Cron 交互 |
| [app.css](./app.css) | 布局、间距与编辑区尺寸 |
| [default-theme.css](../../apps/default-theme.css) | 共用界面主题 |
| [utilities/](../../utilities/) | 工具目录与计算实现 |

直接加载源码目录开发时：

- 修改应用 JSON 后，同步 [builtin-apps/index.json](../index.json) 中的 SHA-256 指纹，再重新加载扩展并重新打开应用。可运行 `node scripts/sync-builtin-app-index.js`，仅同步索引，无需编译；指纹不一致时，加载器会拒绝更新应用。
- 修改本地界面 JS 或 CSS 后，重新加载扩展并重新打开应用。

副本导出的应用 JSON 携带界面模块与主题原文；公共代码编辑器、字体及 `/utilities` 服务仍由目标插件提供。默认发布打包跳过内置应用 JS/CSS 和默认主题的压缩。

来源、致谢与许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)；随包算法库许可入口为 [utilities/THIRD_PARTY_NOTICES.html](../../utilities/THIRD_PARTY_NOTICES.html)。
