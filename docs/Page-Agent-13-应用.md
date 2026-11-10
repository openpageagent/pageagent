# Page Agent 应用

应用由 HTML、CSS、JavaScript、主题资源和能力声明组成，保存在扩展的 IndexedDB 中，在独立标签页运行。可在配置中心新建、导入或编辑，也可通过对话生成和修改。

## 管理与地址

「应用」是配置中心的默认首页，提供名称搜索、收藏、最近使用、拖拽排序和置顶。
搜索或只看收藏时暂停拖拽。

扩展图标菜单默认显示最近使用的应用。在「系统设置」开启「左键菜单仅显示收藏列表」后，按应用入口的收藏顺序显示全部收藏。开启时需至少有一个收藏；关闭后恢复最近使用。

普通与隐身窗口分别保存应用、业务数据和列表偏好。

点击卡片打开发布版本，未发布时打开草稿；相同路径已有标签页时激活该页。

点击「管理应用」打开抽屉，可编辑代码、对话调整、预览、发布、配置权限、导出、查看运行记录、关闭标签页、取消任务或删除应用。

管理抽屉显示完整 ID、别名和访问链接，点击图标可选择并立即保存新图标。

删除应用会移除其源码、权限、业务数据和主题资源，共享 Flow 等依赖保留。

| 地址 | 内容 |
| --- | --- |
| `chrome-extension://<扩展 ID>/apps/{appId}` | 发布版本 |
| `chrome-extension://<扩展 ID>/apps/{appId}/draft` | 草稿预览 |
| `chrome-extension://<扩展 ID>/apps/{slug}` | 使用别名访问发布版本 |
| `chrome-extension://<扩展 ID>/apps/{slug}/draft` | 使用别名访问草稿 |

- 别名为 1–64 位英文字母、数字，以单个横线连接，保存时转为小写。
- `source`、`capabilities`、`dependency` 为保留字。
- 同一普通／隐身范围内别名唯一，冲突返回 `ADDRESS_CONFLICT`。

别名保存后立即生效，留空恢复 ID 地址；旧别名失效，原 ID 链接始终可用。ARP 和 SDK 使用稳定的 `appId`。

应用草稿和发布页支持浮动对话入口，由全局浮动入口开关控制。面板显示当前应用及草稿／发布状态，对话修改保存到草稿，需另行发布；复制应用后，对话继续编辑副本。

页面工具截图时会临时隐藏对话面板和应用顶部提示条。

## 草稿、发布与数据

新建应用生成基础页面草稿。代码编辑器包含 HTML、CSS、JavaScript、主题及「功能与依赖」页签，并提供主题图片和字体上传。

- 保存、预览和发布分别操作，预览与发布使用已保存草稿。
- 保存携带读取时的修改标识；其他窗口或对话已修改内容时返回冲突，可通过「查看最新代码」核对后继续。
- 主题资源上传独立保存，代码输入需另行保存。

发布将草稿源码及主题资源复制到发布槽位，保留草稿和正式业务数据；校验失败保留原发布内容。

仅有发布内容时，读取草稿返回发布源码，保存会建立草稿。
未保存草稿时，预览返回 `DRAFT_NOT_FOUND`。

发布页通过 `PageAgent.data` 访问正式业务数据。
草稿预览使用实例内的临时数据，刷新、关闭预览或调用 `PageAgent.close()` 后丢失；后台连接断开不清空临时数据，下一次 SDK 请求会尝试重连。

**草稿中的动作会提交真实 Run，可能操作网页或发送网络请求。**

## 权限

权限设置包含三部分：

- SDK 总开关；
- 应用数据与绑定动作范围：`data.read`、`data.write`、`data.delete`、`actions.run`；
- 插件模块权限：通过 `PageAgent.resources.request()` 访问资源，以及绑定流程使用本地节点所需的权限。

新建应用默认开启 SDK 和上述四项范围，模块使用系统默认运行权限，详见[内置助手](./Page-Agent-04-内置助手.md#提示词与权限)。
源码还需声明实际使用的数据和动作能力。

导入后 SDK 关闭、模块权限为空，需在本机重新开启。

权限作用于整个应用，草稿和发布共用，点击「保存权限」生效。
关闭能力不阻止源码保存和发布，修改源码也不会重新开启权限。

「重置为默认权限」同时恢复 SDK 开关、应用数据与绑定动作范围、插件模块权限，保存后生效。普通应用恢复系统默认值，声明默认权限的内置应用按包中配置恢复。

数据和动作调用检查 SDK 开关、能力范围、源码声明及当前会话；模块调用按保存的模块权限进入 ARP 校验。

绑定流程使用本地节点需授予 `local.execute`，并选择已配对、已启用且具备相应权限的连接；文件、命令和图片定位还需选择目录。纯本地动作的 `targets` 五个数组可为空。绑定流程按应用授权执行，节点说明见 [MCP 服务](./Page-Agent-11-MCP服务.md#在流程中调用)。

更换服务端、连接地址或目录后需重新确认应用依赖。定时任务和 URL 自动触发器在扩展配置页设置。

关闭或撤销授权、缩小范围、删除或导入应用时，后台请求取消失效任务，已经执行的操作不回滚。

## 源码、主题与组件

`GET /apps/capabilities` 返回源码 schema、SDK 接口、权限目录、限制及默认 UI 模板。完整 `code` 对象包含：

| 字段 | 内容 |
| --- | --- |
| `html` | 页面 body 内容 |
| `css`、`themeCss` | 应用样式、主题样式 |
| `javascript` | ES module 入口 |
| `files`（可选） | 应用自有 JS/CSS 原文，文件名到完整源码的映射 |
| `description` | 功能说明 |
| `parameters` | 启动参数声明：字段、示例及处理方式，默认无参数 |
| `capabilities` | 使用的数据与动作能力 |
| `actions` | 具名动作及输入、输出、目标声明 |
| `dependencies` | 依赖 URI 和内容指纹 |
| `customBehavior` | 自定义调用行为说明 |
| `externalResources` | 外部资源 URL、用途和类型 |
| `networkPolicy`（可选） | `offline` 限制页面和 Worker 的资源请求为扩展同源，允许本地图片/字体数据；禁止表单提交 |

schema 拒绝额外字段和远程 JavaScript 资源。
HTML 中的 script 标签会被移除，入口代码写在 `javascript` 中。

应用页面和模块依赖扩展 Service Worker 的资源分发；模块装载失败显示 `RUNTIME_UNSUPPORTED`。

新建应用使用默认主题，模板可从 `defaults.ui` 获取。主题保存后属于应用，插件更新不覆盖它；页面先加载 `themeCss`，再加载 `css`。

主题图片和字体使用简单文件名上传。
HTML/CSS 用 `app-asset:assets/{文件名}` 引用，JavaScript 用 `PageAgent.asset('assets/{文件名}')` 获取 Blob URL。
发布和导入会校验资源引用。

`code.files` 中的 JS/CSS 可在「源码文件」页签或通过对话逐个编辑，发布、复制、导出和导入均携带这些文件。

源码文件使用不含目录的 `.js` / `.css` 文件名，`__entry__.js` 为保留名称。入口与模块通过 `import './app.js'` 引用同一槽位的文件；HTML、`css`、`themeCss` 通过 `app-file:app.css` 引用。CSS 文件中的相对 `@import` 指向同槽位的 CSS 文件。文件请求携带源码版本，过期版本会被拒绝。

`networkPolicy: 'offline'` 限制页面和 Worker 加载外部资源；SDK 授权仍单独生效，主动打开外部链接仍可导航。该设置不提供任意代码隔离。

公共组件通过 `await PageAgent.ui.load(id)` 加载，可用 ID 包括 `code-editor`、`markdown`、`message-list`、`icons`、`feedback`、`floating`。

组件接口和示例见 `/apps/capabilities/ui/{componentId}`，图标目录见 `/apps/capabilities/ui/icons`。

纯 UI 组件不要求业务权限，也无需等待 SDK 就绪；消息列表只展示传入内容，发送消息和持久化由应用调用 SDK。

组件实例通过 `destroy()` 清理，页面卸载时统一释放。

## 页面 SDK

页面通过全局 `PageAgent` 使用 SDK：

| 接口 | 行为 |
| --- | --- |
| `ready` | 等待握手，返回会话和应用摘要；断开后重新读取可尝试重连 |
| `state`、`refresh()` | 读取缓存摘要或刷新摘要 |
| `onChange(listener)` | 订阅变化，返回取消订阅函数 |
| `resources.request(method, request)` | 调用 ARP，返回完整响应 |
| `data.get(key)` | 读取记录；不存在时返回 `{key, value: null, version: null}` |
| `data.list({cursor, limit})` | 按 key 分页，默认 24 条，最多 100 条 |
| `data.set(key, value, version)` | 按版本写入 JSON；省略版本等同 `null`，只允许新建 |
| `data.delete(key, version)` | 按版本删除 |
| `actions.run(name, input, {idempotencyKey})` | 提交本应用具名动作，返回 Run 引用 |
| `actions.status(runId)`、`actions.cancel(runId)` | 查询或请求取消本应用 Run |
| `apps.input` | `ready` 后读取页面启动参数，未传参为 `null` |
| `apps.describe(appId)` | 读取目标应用已发布动作及输入输出 schema |
| `apps.open(appId, input?, options?)` | 打开目标发布页，返回 `{tabId, url}` |
| `apps.run(appId, name, input?, options?)` | 调用目标应用已发布动作 |
| `apps.status(appId, runId)`、`apps.cancel(appId, runId, options?)` | 查询或取消目标应用 Run |
| `asset(name)` | 获取当前槽位资源的 Blob URL |
| `createWorker()` | 在专用模块 Worker 中加载同一份 `javascript` |
| `manageWorker(worker)`、`close()` | 纳管 Worker，或关闭 SDK 并释放资源 |

数据只接受普通 JSON 值，拒绝循环引用、类实例、访问器和自定义序列化。
修改和删除使用读取到的 `version`，冲突返回 `DATA_CONFLICT`。

模块调用支持六种 ARP 方法，调用方检查 `error`、`receipt`，从 `primary.data` 或 `capabilities` 读取结果。字段和前置条件见 [ARP 协议](./Page-Agent-10-ARP协议.md)。

`apps.open/run/cancel` 的 `options` 可含 `idempotencyKey`。

跨应用读取需要 `apps.read`，打开、执行和取消需要 `apps.execute`。
目标动作同时检查目标应用自身授权；Run 归属目标应用，不要求目标页面已打开。

`apps.open` 提供 `input` 时新建标签页，省略时可复用已有页。

参数为普通 JSON，须符合应用的启动参数声明，保存在 URL 的 `#page-agent-input=...` 中，编码后最多 16 KiB；参数不授予权限。

SDK 通知数据、Run、权限、源码及连接变化。

关闭页面会终止页面程序和已管理 Worker；已提交 Run 继续运行，可在管理入口取消。

跨应用 Run 不转发目标应用的 `onChange` 事件，需查询状态。

### 启动参数

在「启动参数」页签编辑 `code.parameters`，查看字段说明和调用示例；内置原版通过「查看源码与参数」只读查看。

按需选择 `mode`：

- `none`（默认）：无参数，可省略 `input` 或传 `{}`，非空参数会被拒绝。旧应用和旧备份缺少声明或值为 `null` 时也使用此默认值，无需手动补齐。
- `form`：通过 `bindings` 将标量字段映射到控件 ID，支持 input、checkbox、textarea、select 和 page-code-editor。省略字段保留原值，不触发输入事件或提交；需要联动时使用 `module`。
- `module`：通过 `module: "app.js"` 指定 `code.files` 中的 JS 文件，导出 `async function applyParameters(input)`，处理失败时抛错。`javascript` 入口须等待页面初始化完成后返回，由平台调用模块一次，无需在入口重复处理参数。

`schema` 为禁止额外字段的对象，每个字段需有说明，`example` 须符合 schema。嵌套字段的「父级内必填」表示传入所属对象时必须提供该字段。

默认声明、完整 schema 和模块示例见 `GET /apps/capabilities`；正式调用参数见 `GET /apps/{appId}` 的 `slots.published.parameters`。
草稿声明通过 `GET /apps/{appId}/draft/parameters` 读取，通过 `PATCH /apps/{appId}/draft` 的 `code.parameters` 整体替换。

### 内置开发工具联动

开发者工具箱（`app_developer_tools`）和 Developer Utils（`app_developer_utils`）支持打开指定工具并填入内容。对话通过 `POST /apps/{appId}/open` 调用，应用通过 `PageAgent.apps.open` 调用。

`GET /apps/{appId}` 返回的 `slots.published.parameters` 包含参数 schema、工具 ID 说明和调用示例。

启动参数为 `{ toolId: string, input: string, operation?: string }`：

- `toolId` 必填，使用目标应用自己的工具入口 ID；`input` 必填，允许空字符串。
- `operation` 可省略，使用该入口的首个接收操作。
- 不支持的工具、操作或额外字段会显示错误；单行输入工具拒绝多行文本。启动参数只应用一次。
- 接收后按工具的实时或手动模式处理，选项可在页面调整；未传参数时显示默认页面。

打开接口返回标签页信息。需要计算结果时使用 [ARP 离线计算](./Page-Agent-09-ARP工具调用.md#离线计算)；多步计算可将上一步的 `primary.data.value` 传入下一步，再把最终文本带入页面，结构化值先转成 JSON 字符串。

调用 `POST /apps/app_developer_utils/open` 打开 Developer Utils 解码页并传入 Base64 文本：

```json
{
  "input": {
    "toolId": "base64encode",
    "operation": "decode",
    "input": "SGVsbG8="
  }
}
```

开发者工具箱中的 Base64 工具 ID 为 `base64`；工具 ID 和操作以目标应用说明为准。

GitLab 批量操作（`app_gitlab_tools`）支持 `{ projectId, site?, commit?, operation?, branches?, removeSource? }`。`projectId` 为数字项目 ID，`operation` 为 `merge` 或 `cherry-pick`。参数用于预填页面，用户保存并连接、确认项目后，点击执行才写入 GitLab。启动参数不接收凭据，更换站点会清除旧令牌。

## 动作与依赖

每个动作以稳定名称绑定一个 Flow、FlowGroup 或 Script，声明 `inputSchema`、`outputSchema`、`sideEffects` 及 `targets`。
目标范围包含 `origins`、`methods`、`pageIds`、`pageOperations`、`modelServiceIds` 五个数组。

`GET /apps/dependency?uri=...` 返回依赖内容和 SHA-256 指纹。
保存时收集动作、页面、模型配置及传递依赖；不能确定的引用返回 `DEPENDENCY_UNRESOLVED`，内容与指纹不符返回 `DEPENDENCY_CHANGED`。

固定依赖其他应用时，将其 URI 和指纹加入 `code.dependencies`。
指纹覆盖目标应用名称、草稿、发布源码和传递依赖；目标草稿变化也可能使依赖失效。

运行时选择的应用可不预先绑定，调用其最新发布版。

动作提交前校验输入、权限和依赖，捕获执行定义后创建 Run。
页面使用 `fixedNewTab` 模式，执行器核对页面、站点、HTTP 方法和模型服务范围。

动作限制：

- HTTP 与模型请求拒绝重定向；模型请求使用绑定的服务 ID。
- 不支持捕获请求重放。
- 不支持 `runAssistant`、`setProxy`、`clearProxy`、`checkpointGet`、`checkpointSet`、`sendEmail`、`downloadMedia` 节点。
- 应用发起的 Flow 跳过流程结束邮件通知。

`run` 返回只表示任务已提交。状态成功后仍需检查 `outputValidation` 和 `outputRef`；后者指向运行记录，运行记录本身也有容量与截断限制，不能作为完整大结果的副本。

动作默认以 SDK 请求 ID 作为幂等键，可显式提供并在重试时复用；幂等账本在后台重启后失效。

请求超时或断开时，先查询实际状态，写入和动作可能已经执行。

| 限制 | 数值 |
| --- | --- |
| 单条控制消息 | 256 KiB，按 JSON 字符串长度乘 2 估算 |
| 每应用控制请求 | 最多 8 个在途请求，每秒 30 次 |
| 全部应用控制请求 | 最多 32 个在途请求 |
| 动作 Run | 每应用最多 4 个，全部应用最多 16 个 |
| SDK 请求及数据等待 | 60 秒 |

超限返回 `RESOURCE_BUSY`，同一会话累计 5 次超限后断开。

## ARP 资源接口

ARP 路径返回资源表示；浏览器访问地址加载应用页面。完整参数由对应路径的 `OPTIONS` 提供。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /apps`、`POST /apps` | 查询目录、创建草稿 |
| `GET /apps/capabilities` | SDK、源码 schema、权限、UI 和限制 |
| `GET /apps/capabilities/ui/{componentId}` | 组件接口或图标目录 |
| `GET /apps/dependency?uri=...` | 依赖内容及指纹 |
| `GET /apps/{appId}` | 摘要、权限和访问链接 |
| `PATCH /apps/{appId}` | 修改名称、别名、图标或描述，立即生效 |
| `DELETE /apps/{appId}` | 删除应用及数据 |
| `GET /apps/{appId}/draft`、`GET /apps/{appId}/published` | 完整源码 |
| `GET /apps/{appId}/{slot}/{field}` | 读取或搜索单个源码字段，slot 为 `draft` 或 `published` |
| `GET /apps/{appId}/{slot}/files` | 列出源码文件名、长度、行数和读取 URI |
| `GET /apps/{appId}/{slot}/files/{fileName}` | 按行读取或搜索单个 JS/CSS 文件，沿用源码字段的分页、grep 和 revision 参数 |
| `PUT`、`DELETE /apps/{appId}/draft/files/{fileName}` | 带应用 ETag 新增、完整替换或删除一个源码文件；PUT 的 body 为 `{source: "完整源码"}` |
| `POST /apps/{appId}/draft/edits` | 按原文片段修改草稿字段或已有源码文件 |
| `PUT /apps/{appId}/draft`、`PATCH /apps/{appId}/draft` | 保存完整草稿或指定 `code` 字段 |
| `POST /apps/{appId}/publish`、`POST /apps/{appId}/copy` | 本地发布、创建副本 |
| `PUT /apps/{appId}/assets/{assetName}` | 上传 Base64 与 MIME 表示的草稿资源 |
| `POST /apps/{appId}/open` | 打开发布页，可传 `input` |
| `POST /apps/{appId}/actions/{actionName}/runs` | 提交动作 |
| `GET /apps/{appId}/runs/{runId}` | 查询 Run |
| `POST /apps/{appId}/runs/{runId}/stop` | 请求取消 Run |
| `GET /apps/{appId}/data/{key}` | 读取正式数据 |
| `PUT /apps/{appId}/data/{key}` | 使用 `value`、`version` 写入数据 |
| `DELETE /apps/{appId}/data/{key}` | 使用数据版本删除 |

源码、元数据、资源写入、发布、复制和删除使用应用 ETag 作为 `preconditions.ifMatch`；删除业务数据使用该数据的版本。

资源权限为 `apps.read/write/execute/delete`，数据与动作还检查应用自身授权。

局部修改使用 `POST /apps/{appId}/draft/edits`，无需提交全文。例如修改一处 CSS：

```json
{
  "uri": "/apps/{appId}/draft/edits",
  "body": {
    "edits": [
      {
        "field": "css",
        "oldText": ".button { color: red; }",
        "newText": ".button { color: blue; }"
      }
    ]
  },
  "preconditions": { "ifMatch": "\"当前应用 revision\"" },
  "idempotencyKey": "本次编辑的唯一键"
}
```

`field` 支持 `html`、`css`、`javascript`、`themeCss`、`description`；修改已有源码文件时，使用 `field: "files"` 并指定 `fileName`。

- `oldText` 为非空原文片段，区分大小写与缩进，须唯一匹配；重复时补充上下文。
- `newText` 为替换内容；插入时保留原文锚点并加入内容，删除时设为空字符串。
- 每次支持 1–50 项，按顺序应用；任一项失败，整次不保存。后续修改使用成功回执中的最新 ETag。

`body.includeDiff` 可省略（小规模编辑自动返回差异）、设为 `true`（请求差异）或 `false`（关闭）。差异可能跳过、不可用或截断，不影响已成功的保存；需要核对时重新读取相关源码，不要为补取差异重复提交编辑。差异仅用于文本核对，不代表功能验证通过。

完整替换 CSS 使用 `PATCH /apps/{appId}/draft`：`patch: {"code":{"css":"完整的新 CSS"}}`。
字符串和数组整体替换，空字符串或空数组清空，省略保留，不接受 `null`。
`code.files` 映射同样整体替换；局部修改用片段编辑，新建或完整替换一个文件用单文件 PUT，避免覆盖其他文件。

元数据的 `slug` 支持空字符串或 `null` 清除别名。

搜索或按行读取源码：

```text
GET /apps/{appId}/draft/css?q=.button&fixedStrings=true
GET /apps/{appId}/published/javascript?q=submit&before=3&after=5
GET /apps/{appId}/draft/css?startLine=1&limit=50
```

搜索默认使用忽略大小写的正则，`fixedStrings=true` 使用字面匹配，`caseSensitive=true` 区分大小写。
`before/after` 各最多 20 行，`limit` 默认 5、最多 50 个命中，搜索片段单行最多 500 字符。

不传 `q` 时按行读取，最多 50 行、12000 个源码字符。
`hasMore=true` 时使用 `nextLine/nextColumn` 续读，并携带已读取内容的 `revision`；版本变化时拒绝混读。

数组字段直接返回 `value`。

PATCH 整体替换字段或 PUT 完整替换文件前需读齐目标；片段编辑只需读取待修改内容及唯一匹配所需的上下文。

## 对话调整

任意对话都可创建、编辑或修复应用。

Agent 写入前先读取 `/apps` 或目标应用，再完整读取 `/knowledge/builtin_app_generation_guide`，否则返回 `PRECONDITION_REQUIRED`；配置中心的直接编辑不受此读取门槛限制。

非 UI 写入还检查 `customBehavior`：该字段为空且 JavaScript 命中 `fetch(`、`XMLHttpRequest`、`WebSocket` 或 `chrome.` 字面模式时，返回 `SCHEMA_VALIDATION_FAILED`。这项检查不构成完整的代码安全审计。

创建或保存后，应用绑定到当前话题，后续上下文附带最新摘要和权限。输入框上方的「取消」停用绑定，保留输入、应用和关联记录。

应用目录的「对话调整」使用应用开发助手，优先复用该助手下与当前应用关联、未归档的最近话题；没有可用话题时新建。
助手已删除时重新创建，已有助手保留用户配置。

应用开发助手默认仅做必要修改和静态检查，功能测试由用户完成；可明确要求调整验证范围。

入口填入修改提示，由用户补充需求后发送。

对话中的生成、保存和发布结果提供应用跳转入口。

仅修改名称、别名、图标或描述使用元数据 PATCH，无需读取或保存源码。

## 导入与导出

应用可单独导出，也可作为一键备份的模块。导出格式为 `kind: "pfa-full-backup"`、版本 7，支持导入版本 6；单个 JSON 包最多 50 MiB。

导出包含草稿、发布源码、主题资源、别名、能力范围、可选正式数据及递归依赖。
SDK 开关、模块权限和运行会话不导出。

内置依赖只记录要求，模型依赖移除密钥等凭据；其他模块的凭据规则见[安装与打包](./Page-Agent-00-安装与打包.md#升级与迁移)。

导入仅支持合并模式，校验源码、资源、数据、别名冲突和依赖指纹。同内容共享依赖复用，异内容覆盖需确认，内置依赖不兼容或应用依赖成环时拒绝导入。

共享依赖先导入，应用按依赖顺序逐个提交；每个应用独立事务，中途失败会列出已提交和未提交项。

包内含业务数据时替换该应用正式数据，明确不含业务数据时保留本机数据。

导入关闭旧 SDK 会话，清空模块权限；随应用导入的定时任务和 URL 触发器保持关闭。模型凭据需在本机配置。

一并导入的连接和目录引用自动更新，应用中写死的路径仍需手动调整。导入连接默认禁用且需重新配对，详见 [扩展连接备份](./Page-Agent-11-MCP服务.md#扩展连接备份)。

## 内置应用

内置应用显示「内置」，支持打开、收藏、排序、授权和业务数据读写；源码、元数据和资源只读，不能直接发布、覆盖导入或删除。

一键备份排除内置原版，需要修改或导出时先「复制后修改」。

副本保留两个源码槽位（含 `code.files`）和主题资源，使用新 ID，清空别名、来源话题、业务数据和授权；共享依赖继续引用，副本不随内置包更新。

内置应用及随包提供的 Flow、FlowGroup、Script、PageSource 依赖自动安装。知识、助手、模型服务和连接需由本机提供匹配的 ID 与指纹；ID 或别名冲突时保留已有应用。

声明默认权限的内置应用在首次安装或尚未完成权限初始化时应用包内默认值；未声明时 SDK 默认关闭，模块权限为空。普通导入不会自动采用这些授权。

完成权限初始化后，内置包更新替换源码和主题，保留业务数据和用户授权，旧 SDK 会话失效。包更新或系统默认值扩展不会自动扩大授权，可通过「重置为默认权限」采用当前默认值。

| 应用 | 功能与默认权限 |
| --- | --- |
| [开发者工具箱](../builtin-apps/developer-tools/README.md)、[Developer Utils](../builtin-apps/developer-utils/README.md) | 离线计算工具；默认开启 SDK、四项应用数据与绑定动作范围及系统默认模块权限，包含 `utilities.read`、`utilities.execute`。 |
| [GitLab 批量操作](../builtin-apps/gitlab-tools/README.md) | 支持指定站点，使用浏览器登录态或访问令牌认证；提供批量合并请求、Cherry-pick、MR 标题反查分支和接口搜索过滤。默认仅启用 SDK 配置数据读写，访问受扩展站点权限限制；认证配置和选择记住的令牌作为业务数据保存在本机，不随副本复制；应用导出及全量备份会剔除连接配置中的令牌。 |

工具应用通过 `/utilities` 计算，复制或导出包含应用自有 JS/CSS 和主题，不包含插件算法库；运行环境需提供该能力。

扩展重新加载后，已从内置包移除的原版应用会转为普通应用，允许编辑、导出和删除，保留 ID、源码、主题、授权和业务数据。内置包加载或校验失败时保持原有内置身份。
