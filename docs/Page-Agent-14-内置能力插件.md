# 内置能力插件

扩展的插件由 [Cordis v3](https://github.com/cordiverse/cordis) 管理，为应用、流程、脚本和助手提供能力。内置插件随扩展发布，自建插件可编辑代码或通过对话编写，统一在「插件管理」中配置和启停。[平台消息插件](./Page-Agent-15-平台消息插件.md)提供账号管理、消息收发和指令调用。

## 配置与状态

内置插件默认启用；已保存的启停选择和配置优先，重启或升级后保留。内置源码只读，「复制后修改」生成停用的独立副本；自建插件也可复制。保存配置会重新加载插件，启动结果以列表状态为准。

配置表单由 `configSchema` 声明，支持文本、数字、开关、嵌套对象和列表。`title`、`description` 为名称与说明，`required` 标注必填项；`enum` 或简单 `oneOf` 提供下拉选项，`format: 'password'`、`format: 'multiline'` 分别显示密码框和多行文本。

对象需声明 `properties`，列表需声明单一 `items`；表单不解析 `$ref`、`anyOf`、`allOf` 或复杂 `oneOf`。初始值写入 `config`，Schema 的 `default` 不会填充已有配置。保存时校验配置，未编辑的字段保留。

消息按优先级从高到低处理，同级按插件注册顺序，首个接管后停止分发。普通插件默认 `0`，平台消息默认 `-100` 兜底，均可调整。优先级随配置保存、复制和导出。

停用或重新配置会移除插件注册的能力并取消正在进行的调用。用户流程、已创建的应用副本及其数据保留，依赖该插件的调用会报不可用。

普通与隐身窗口分别保存配置及自建插件源码，配置备份的「插件」模块包含源码与配置。

## 新建与编辑插件

「插件管理 → 新建插件」创建停用的空白插件，创建后 ID 不可修改。源码保存在 `definition.files`，`entry` 指定 JS 入口；`plugin.json` 是名称、配置、权限、优先级及启停状态的元数据视图。编辑器支持多文件编辑和整组保存。

自建插件提供「编辑代码」「对话调整」「复制后修改」。「对话调整」使用插件开发助手，并关联开发话题；插件与话题可相互跳转。

导入导出使用统一备份包，包含源码、入口、配置和权限声明，不包含运行数据、开发话题和运行会话。内置插件导入为自建副本；所有导入插件默认停用。

已启用插件保存后重新加载，不设草稿或发布版本。保存前校验定义和语法，失败时保留旧实例；`revision` 防止并发覆盖。自建插件启动失败或出现未处理异常时自动停用并保存错误，修复后可重新启用；正常取消调用不视为故障。

`GET /plugins/authoring` 提供声明格式和处理函数 API，插件管理接口如下：

| 操作 | 入口 |
| --- | --- |
| 创建 | `POST /plugins`，提交完整插件定义 |
| 复制 | `POST /plugins/{id}/copies`，提交新 `id`、`name` 和源 `revision` |
| 源码清单与读取 | `GET /plugins/{id}/files`、`GET /plugins/{id}/files/{fileName}` |
| 精确编辑 | `POST /plugins/{id}/edits`，提交 `revision`、`edits:[{fileName,oldText,newText}]`，返回保存回执与 diff |
| 新增或完整替换文件 | `PUT /plugins/{id}/files/{fileName}`，提交 `revision`、`source` |
| 删除文件 | `DELETE /plugins/{id}/files/{fileName}`，提交 `revision`；不可删除当前入口或 `plugin.json` |
| 读取或完整更新 | `GET / POST /plugins/{id}`，更新时提交完整定义及当前 `revision` |
| 启停及配置 | `POST /plugins/{id}/configuration`，提交 `enabled`、`config`、`revision`；可选整数 `priority`，省略则保留当前值 |
| 删除自建插件 | `DELETE /plugins/{id}`，提交当前 `revision` |
| 查找已注册能力 | `GET /plugins/contributions` |

源码支持按行读取、grep 和精确替换。写入携带当前 `revision`，精确替换要求原文唯一匹配；保存后返回回执及 diff，不保留历史版本。具体参数见接口合同。

`capabilities` 声明能力及参数合同，`subscriptions` 声明消息来源和可选指令名；`code` 为异步 JavaScript 函数体。处理函数通过 `api.ctx.get()` 读取输入、消息和配置，通过 `api.resources.request()` 调用应用、流程等现有资源，通过 `api.messaging.reply()` 回复来源。能力使用 `return` 返回结果。

平台消息副本保留完整源码和当前优先级，独立运行，不随内置源码更新。`base: "messaging"` 标记平台对话通道；保存时补充并校验内置指令所需权限。

JavaScript 入口通过 `module.exports` 导出 `{ apply(ctx, config) { ... } }` 或 `{ configSchema, plugin: { apply } }`。文件间使用 CommonJS 相对引用，仅支持本插件不含目录的 JS/JSON 文件，最多 20 个、总大小 256 KB。模块运行于脚本沙箱，不支持 npm，定时器和订阅随停用清理。

消息插件默认采用平台消息的配置格式：`config.authorizations` 为账号授权列表，每项包含 `connectionId`、`accountId`、`commands`；额外来源限制按用户要求配置。`format: "message-accounts"` 提供账号选择及指令开关，支持多个账号。未选择账号或未开启指令时不执行。

模块订阅 `messaging:dispatch`，从 `event.data` 读取消息并按配置检查授权，返回 `true` 表示接管。`configSchema` 提供表单和配置校验，`permissions` 控制资源调用权限；消息授权由处理代码检查。

`subscriptions` 用于固定来源订阅，精确指定连接、账号、频道和发送者，插件内按订阅注册顺序处理。`messaging:message` 仅供观察；浏览器及服务端连接需在线。

所有插件均未接管时，按相同顺序分发 `messaging:unmatched`；返回 `true` 后停止。

最多保存 20 个自建插件，每个插件最多 20 个独立能力和 20 个声明订阅，模块最多 64 个注册项。单次回调最长 60 秒，超时和停用不能强制打断同步死循环。插件独立存储上限为 256 KB。

## 插件声明

内置插件代码随扩展包发布，由 `background.js` 在 `builtin-plugins/index.js` 之前加载；清单位于 `builtin-plugins/index.js`。

| 清单字段 | 说明 |
| --- | --- |
| `id`、`plugin` | 唯一插件 ID 与 Cordis 插件对象；同一对象只能注册一次 |
| `apiVersion` | Page Agent 宿主接口版本，值为 `1` |
| `name`、`version`、`description` | 名称、版本和说明 |
| `enabled` | 默认是否启用，省略为 `true` |
| `priority` | 消息处理优先级，默认为 `0` |
| `config`、`configSchema` | 默认配置、配置表单与校验规则；配置默认为 `{}`，Schema 不自动填充默认值 |

插件及能力 ID 使用小写英文、数字和单横线，以英文字母开头。插件声明 `inject: ['pageAgent']` 后，通过 `ctx.pageAgent` 使用宿主接口。

## 能力注册

在 `apply(ctx, config)` 中注册能力，可同时提供流程节点和工具：

```js
ctx.pageAgent.registerCapability({
  id: 'normalize', label: '规范化文本',
  inputSchema: {
    type: 'object', properties: { text: { type: 'string' } },
    required: ['text'], additionalProperties: false,
  },
  outputSchema: { type: 'string' },
  safety: 'read', node: true, utility: true,
  execute: function (input) { return input.text.trim(); },
});
```

插件 ID 为 `text-basics` 时，调用入口如下：

| 入口 | 标识及行为 |
| --- | --- |
| ARP | `GET /plugin-text-basics/capabilities/normalize` 读取合同；`POST` 同路径执行 |
| 流程 | `plugin.text-basics.normalize`，位于“插件能力”分类，参数为 `input` JSON 对象 |
| 工具 | `text-basics.normalize`，出现在 `/utilities` 和开发者工具箱的“插件工具”分类 |
| 应用 SDK | `PageAgent.plugins.call('text-basics', 'normalize', { text: ' Hello ' })` |
| 脚本 | `api.plugins.call('text-basics', 'normalize', { text: ' Hello ' })` |

工具箱使用 JSON 对象输入，参数说明来自 `inputSchema`；它也遵守应用资源授权。已经打开的工具箱需要重新打开以更新插件目录。`node: true` 时支持复制该工具对应的流程节点。

## 宿主接口

注册函数返回释放函数，并绑定到调用插件的 Cordis 作用域；作用域释放、依赖失效或手动释放后，相应注册移除。服务方法需通过 `ctx.pageAgent` 调用，不支持脱离对象解构使用。

| 接口 | 用途 |
| --- | --- |
| `arp(method, request)` | 调用 ARP，支持 `GET / POST / PUT / PATCH / DELETE / OPTIONS` |
| `serverArp(connectionId, method, request)` | 通过配对连接调用指定 MCP Server 的 ARP；返回完整响应信封 |
| `registerCapability(definition)` | 注册有输入、输出合同的基本操作 |
| `registerNode(definition)` | 等价于注册 `node: true` 的能力 |
| `registerUtility(definition)` | 等价于注册 `utility: true, safety: 'read'` 的计算能力 |
| `registerResource(adapter)` | 注册 ARP 适配器，支持集合、状态资源等 |
| `registerApp({ id, input })` | 提供可创建副本的应用模板，`input` 为 `POST /apps` 请求体 |
| `utilities.list()` | 返回 `{ tools }`，包含宿主和插件工具描述 |
| `utilities.execute(toolId, input)` | 执行工具；插件工具传能力的 JSON 输入，宿主工具按目录合同传参 |
| `events.on(name, listener)` | 监听宿主或插件事件，随作用域释放 |
| `events.emit(name, data)` | 发出插件事件，监听方收到 `{ pluginId, data }` |
| `listen(chromeEvent, listener, ...args)` | 注册 Chrome 事件并自动移除监听器，`args` 为过滤条件等 |
| `signal` | 当前调用插件作用域的停止信号，可用于 `fetch` 等可取消接口 |
| `extend(point, definition)` | 向宿主定义的扩展点注册，随作用域释放 |

`registerCapability` 必填 `id`、`inputSchema`（object Schema）、`execute(input, call)`。可选 `label`、`description`、`outputSchema`、`safety`、`permissions`、`node`、`utility`；默认输出 Schema 为 `{}`，`safety` 为 `execute`。能力 ID 在插件内唯一。

`execute` 可返回 Promise，结果须可 JSON 序列化并满足输出 Schema，`undefined` 转为 `null`。ARP 响应的 `primary.data` 为 `{ value }`；SDK 与 `api.plugins.call` 直接返回 `value`。能力 POST 使用 ARP 幂等键。

`safety: 'read'` 表示没有业务副作用，这类流程节点可以重试；发送消息、写入数据等能力不能声明为 `read`。工具仅允许 `read`。

`call` 提供 `{ signal, idempotencyKey, arp, serverArp }`。单次服务端写入可将调用的幂等键传给 `serverArp`；取消调用或释放插件会触发 `signal`，耗时操作需主动响应。取消不能强制终止 JavaScript 或撤销已完成的外部操作。`registerResource` 处理函数需自行处理 `context.abortSignal` 与插件作用域信号。

## ARP 与调用方授权

所有插件共用“插件”权限项，新增插件沿用授权。对话默认开放 `plugins.read`、`plugins.write`、`plugins.execute`，插件及源码文件删除默认关闭。两个开发助手默认开放读取、修改和配置，旧开发话题与权限声明自动迁移。

能力统一要求 `plugins.execute`，`permissions` 可额外声明其他资源依赖。自建插件的声明不能超过创建或更新者的权限，嵌套调用同时检查调用方授权。

内置插件代码与扩展后台同权限。`ctx.pageAgent.arp(...)` 以插件身份调用已注册的 ARP 能力，经过参数、前置条件和运行状态校验；内置插件配置不提供权限隔离。

公开能力通过 `call.arp` 调用资源，保留应用、助手或连接的授权。

`arp` 返回完整信封，业务错误位于 `response.error`。写入和执行需按合同携带幂等键、前置条件；具体路径和参数通过 `GET` 或 `OPTIONS` 查询。

服务端调用使用 `call.serverArp(connectionId, method, request)` 保留调用身份和取消信号，要求连接已配对且就绪；经外部连接转发的调用不能再次调用服务端。插件自身的事件处理可使用 `ctx.pageAgent.serverArp`。

服务端另行校验客户端授权，未映射的路径及方法不开放。

`GET /plugins`、`GET /plugins/contributions` 需要 `plugins.read`，目录不返回配置值或详细启动错误；通过 `GET /plugins/{id}` 读取详情。插件配置保存在本地扩展存储，不加密。

## 流程、脚本与应用 SDK

流程节点使用 `input` JSON 参数，支持流程模板解析，输出为能力返回值。脚本通过 `api.plugins.list()` 查询目录，`api.plugins.call(插件ID, 能力ID, input)` 调用能力。

应用在 `await PageAgent.ready` 后通过 `PageAgent.plugins.list()`、`PageAgent.plugins.call(...)` 查询和调用。`call` 的第四个参数可传 `{ idempotencyKey }`。SDK 沿用 `resources.request` 的授权，关闭应用或撤销授权会取消调用。

`utilities.list()` 及 `api.utilities.list()` 返回工具目录。`ctx.pageAgent.utilities.execute` 和 `api.utilities.execute` 均返回 `{ tool, operation, value }`，插件工具的 `operation` 为 `execute`；输入以目录合同为准。

## 应用模板

`registerApp({ id, input })` 注册应用模板，`input` 使用[应用格式](./Page-Agent-13-应用.md)中的 `POST /apps` 请求体。

插件菜单和应用菜单中的“创建应用副本”会创建草稿并打开编辑器，需为副本授权所调用的插件能力。模板不自动安装或覆盖用户应用。

## 资源与扩展点

简单操作使用 `registerCapability`。多个资源方法、分页或状态查询使用 `registerResource(ResourceModuleAdapter.create(...))`，合同和处理函数格式见 `resources/modules/`。注册资源统一通过 ARP 发现、授权和校验。

资源适配器独占一级路径，重复路径会被拒绝。`plugins`、`plugin-*` 由插件宿主管理，不允许原始适配器占用；其他自定义根路径应加插件前缀。

`ctx.pageAgent.extend(point, definition)` 支持宿主定义的扩展点，预定义项为 `capability`、`node`、`utility`、`resource`、`app`；未知名称会报错。

## 事件与生命周期

`ctx.pageAgent.conversation(command, input)` 供平台消息插件及其副本启动对话、读取事件、补充指令、回答提问和取消。

`ctx.pageAgent.events` 使用 Cordis 事件总线，自定义事件采用 `<插件 ID>:<事件名>`。宿主广播以 `host:<广播 type>` 转发，载荷为 `{ data: 原广播 }`，不转发 `PLUGINS_CHANGED`。事件即时投递，不持久保存或重放。

网络访问受扩展权限、浏览器规则和隐身范围约束。第三方消息触发 ARP 前须验证来源并限制允许的操作。

- 子插件通过 `ctx.plugin` 组合，服务依赖通过 `inject` 声明；`pageAgent` 服务按清单项隔离。
- `apply` 支持有界异步初始化，能力目录随注册更新，查询返回当时的快照。
- 连接、定时器和订阅通过 `ctx.effect`、`ctx.on('dispose', ...)` 或宿主接口登记清理。`listen` 只移除监听器，不删除创建的 alarm；Cordis v3 不保证等待异步清理完成。
- Service Worker 重启后重新装配插件，停止前不保证执行 `dispose`。需恢复的数据应持久化，插件存储按插件 ID 和普通／隐身范围隔离。
- 内置插件处理函数在后台主线程执行，CPU 密集任务需使用 Worker 或 offscreen 执行器。

## 兼容范围

内置插件须随扩展包提供代码和依赖。浏览器后台使用 `importScripts`，不提供通用 `require`、npm 安装、ESM 解析或远程代码加载。Cordis 依赖来源见[第三方说明](../dependencies/cordis/NOTICE.md)。

| 插件类型 | 当前接入方式 |
| --- | --- |
| Cordis v3、浏览器可运行、依赖服务齐全 | 按清单加载，通过宿主接口接入 Page Agent |
| 依赖 Koishi 的 session、bot、database、console 等服务 | 需要提供对应服务的 Koishi 运行环境 |
| 依赖 Node.js 的 fs、net、进程或原生模块 | 不能直接在 MV3 后台运行，需要本机／服务器运行环境 |
| Cordis v4 插件 | 需要适配 v3 API 和服务合同 |
| 需要 DOM 的插件 | 后台没有 DOM，需要扩展页面或 offscreen 适配 |

MCP Server 内的 Koishi 核心及平台适配器与扩展内的插件各自管理生命周期。浏览器本地能力不依赖 MCP Server，服务端消息收发也不依赖浏览器在线；跨端调用需要配对连接。服务端支持范围见[平台消息插件](./Page-Agent-15-平台消息插件.md)。
