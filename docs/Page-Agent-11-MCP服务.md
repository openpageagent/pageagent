# Page Agent MCP 服务

MCP Server 提供服务端本地能力和 ARP 客户端通信。外部 Agent 通过 HTTP 使用本地能力或调用插件；插件通过配对的 WebSocket 使用服务端能力、发送邮件，也可调用同一服务端的其他客户端。支持多个服务端和多个客户端连接。

连接的「权限」控制经此连接进入当前插件的远程操作，适用于 HTTP Agent 和客户端转发。读取／查询、写入、执行默认开启，删除默认关闭。

服务需 Node.js 22.16.0 或更高版本。外部客户端使用 Streamable HTTP，不支持 stdio。

## MCP 工具

MCP 提供 `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS` 六个方法工具，参数遵循 [ARP 协议](./Page-Agent-10-ARP协议.md)。`OPTIONS /` 返回服务端资源目录，具体路径的 `OPTIONS` 返回可用方法与参数。`ASK_USER` 仅用于扩展内对话。

工具结果包含 ARP Envelope，写入 `content` 与 `structuredContent`；业务失败设置 `isError`。MCP 消息格式、方法或会话参数错误返回 JSON-RPC 错误；具体资源的参数校验失败返回 ARP 错误。截图保留内联图像。

HTTP Bearer 代表服务端操作者；WebSocket 身份由配对认证确定。客户端不能通过自报身份或权限扩大授权。

### 服务端本地能力

HTTP 本地能力独立于插件，无需客户端 ID 或插件在线。以下为通过 `/mcp` 方法工具访问的 ARP 路径：

| ARP 调用 | 用途 |
| --- | --- |
| `GET /local` | 服务端名称、工作目录、能力和调用链接 |
| `GET /local/environment`、`GET /local/disk` | 服务端环境、内存与工作目录磁盘空间 |
| `GET /local/desktop` | 平台支持的桌面动作 |
| `POST /local/{operation}` | 文件、Bash 或桌面操作 |

HTTP `/local` 始终指向当前服务端，不受插件绑定影响。文件操作限定在启动工作目录内；Bash 从该目录启动，按服务端进程权限执行。HTTP Bearer 可使用本地及平台支持的桌面能力，不依赖插件授权。

### 客户端通信

| ARP 调用 | 用途 |
| --- | --- |
| `GET /clients` | HTTP 查询服务端全部已连接客户端及总数 |
| `POST /clients/{clientId}/arp` | HTTP 调用指定客户端 |
| `GET /connections/{connectionId}/clients` | 插件查询服务端全部已连接客户端及总数 |
| `POST /connections/{connectionId}/clients/{clientId}/arp` | 插件调用指定客户端 |

转发请求体包含目标方法 `method` 和 ARP 参数 `request`；返回链接属于目标客户端。`connectionId` 是本插件保存的服务端连接 ID，`clientId` 是目标客户端 ID。插件查询需 `connections.read`，调用需 `connections.execute`。

连接与本地能力响应中的 `clients` 链接提供列表入口。列表含当前客户端，`total` 为服务端已连接客户端总数；`isSelf` 标识自己，自身不提供调用链接。默认助手具备连接查询权限。

服务端根据认证会话确认来源并拒绝自调用（`FORBIDDEN / SELF_CALL_FORBIDDEN`）。转发请求不能在目标插件中继续转发；来源取消或断线会取消请求，结果未知时不自动重放。插件本地操作仍受连接的目录与桌面授权约束。

## 连接与目录配置

扩展的「连接配置」管理 WebSocket 服务端连接及授权，`/mcp-servers` 管理外部 HTTP MCP 服务。普通与隐私环境分别保存身份、连接和凭据；各最多 32 条连接，每条最多 64 个目录（含 `startup`）。

在「连接配置」新增连接，填写别名和 WebSocket 地址，先配对，再开启连接并授权。多个服务端需分别配置，同机部署时使用不同状态目录和端口。目标离线时，任务不会转交其他连接。

连接别名在当前普通／隐私环境内唯一，目录别名在连接内唯一，均不区分大小写。别名仅供显示；调用使用查询返回的连接 ID（`connectionId`）、目录 ID（`workspaceId`）或完整链接。

同一环境中，每个服务端只配置一条连接，多个目录共用该连接。首次配对绑定 `serverId`，自动连接时身份不符会拒绝连接。首次连接、凭据失效或更换服务端，统一使用「配对」输入目标服务端密码；成功后更新凭据及绑定，无需先撤销旧配对。修改 URL 会断开并清除本机凭据，保存后重新配对即可。

### 目录与授权

新连接默认关闭，首次配对成功后才能开启连接。开启后使用保存的配对密钥连接；关闭时断开连接、停止重试并保留配对信息，关闭期间不能手动重连。

密钥丢失、凭据失效、修改服务端地址或重置客户端身份时，连接开关保持原状态，界面提示重新配对。配对成功后，开关开启则自动连接；关闭则只保存凭据并断开临时配对连接，不同步目录或自动重连。

目录的读取、写入、命令执行权限相互独立且默认关闭；桌面权限也默认关闭，按连接单独开启。

| 条目 | 路径与别名 | 可修改内容 |
| --- | --- | --- |
| 启动目录 `startup` | 别名固定为“工作目录”；路径为服务进程启动时的真实工作目录 | 只可修改权限，不能删除 |
| 自定义目录 | 服务端的绝对路径，默认别名取目录名 | 别名、路径、权限；删除配置不删除文件 |

自定义目录填写服务端的绝对路径，不展开 `~` 或环境变量。目录必须存在，且不能与其他自定义目录指向同一实际位置。离线可保存配置，连接后确认目录有效并授权才能执行。

目录路径或实际位置变化会清除该目录的授权并取消相关请求，确认新路径后须单独重新授权。

| 操作 | 所需目录权限 | 额外条件 |
| --- | --- | --- |
| `read`、`grep` | `read` | 明确连接和目录 |
| `write`、`delete` | `write` | 不隐含读取授权 |
| `bash` | `execute` | 服务端存在可用 Bash |
| `locate` | `read` | 同时开启桌面权限且支持图片定位 |
| 鼠标、键盘、剪贴板、截图、应用、窗口 | 无 | 明确连接，开启桌面权限且支持相应动作 |
| 目录磁盘查询 | 任一项权限 | 目录有效且已确认 |

访问 `/local` 需调用者拥有 `local.execute`；目录的 `execute` 仅控制 Bash。实际执行还受连接状态、平台能力、目录及桌面授权限制。

撤销权限、删除或更换目录、停用连接、清除凭据或撤销配对会阻止新调用，并取消受影响的请求；已发生的修改不会撤销。

父目录授权覆盖其子目录，关闭子目录记录不能收回父目录权限。Bash 按服务端进程权限执行，不受文件读写开关限制；桌面授权作用于整个登录桌面。

连接、目录及授权只能在扩展配置页修改，Agent 和应用不能自行授权。重置客户端 ID 会断开当前环境的全部连接并清除本机凭据，目录配置保留，连接需重新配对。

## 本地文件、命令与桌面

下文为扩展内 ARP 路径。`GET /local` 返回连接、目录、权限和调用链接；连接未就绪或审计不可用时不提供执行链接。HTTP 直接操作使用 `/local/{operation}`，参数与执行限制相同。

使用查询返回的完整 URI 调用 `OPTIONS` 查看参数。文件、Bash 和图片定位需指定连接及目录，其他桌面操作只需连接；即使只有一个目标，也须明确指定。

| ARP 路径（POST） | 参数 | 行为 |
| --- | --- | --- |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/read` | `path`、可选 `offset` / `limit` | 读取 UTF-8 文本；行号从 1 开始，默认 200 行 |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/write` | `path`、`content` | 创建或覆盖文件，自动创建父目录 |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/delete` | `path` | 删除文件或符号链接，不递归删除目录 |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/grep` | `path`、`pattern`、可选 `limit` | 递归查找区分大小写的字面文本，默认最多 100 行匹配 |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/bash` | `command`、可选 `timeoutMs` | 从明确目录启动 Bash，默认 30 秒、最多 60 秒 |

文件与命令在 **MCP Server 所在机器** 上操作。

文件操作将相对路径解析到配置的工作目录，检查绝对路径、`..` 和符号链接是否越界；删除目录内的符号链接只删除链接本身。

Bash 的启动目录固定为该目录，执行需要服务端安装 Bash；Bash 本身不是目录沙箱，命令仍以服务端进程权限运行。

读取与查找只处理最多 4 MiB 的文本文件，写入最多 1 MiB。读取和查找各返回最多 64 KiB；Bash 的 stdout 与 stderr 合计最多 64 KiB。

查找跳过符号链接、二进制、大文件及 `.git` / `node_modules` 目录，最多访问 5000 个条目或扫描 60 秒；返回 `skipped` 和 `truncated` 表明结果是否完整。

命令返回 stdout、stderr、退出码、超时和截断状态。取消、断线或超时后的处理见 [执行限制与结果](#执行限制与结果)。

### 桌面操作

桌面操作通过 `/local/connections/{connectionId}/desktop/{operation}` 调用，作用于 **MCP Server 所在机器当前登录的桌面**，仅支持 macOS 和 Windows。

鼠标、模板匹配及部分键盘和截图功能需要可选依赖 `robotjs@0.9.1`。在服务端文件所在目录安装：

```bash
npm install --no-save --ignore-scripts robotjs@0.9.1
```

`--ignore-scripts` 禁止安装时回退到本地编译。使用单文件发布包时，依赖需保留在 `.cjs` 所在目录的 `node_modules` 中。

`GET /local/connections/{connectionId}` 返回平台、动作列表和系统权限要求。动作列表依据平台及可选依赖生成，不保证系统权限或原生模块可用。

| 平台 | 条件与范围 |
| --- | --- |
| macOS | 鼠标、逐字输入、区域截图和模板匹配需要 robotjs；未安装时可用剪贴板、基础键盘、主屏幕截图、应用和窗口操作。输入和窗口需「辅助功能」，系统脚本需「自动化」，截图需「屏幕录制」权限。 |
| Windows | 鼠标、键盘、截图和模板匹配需要 robotjs；剪贴板、关闭应用、打印和窗口操作需要 Windows PowerShell 5.1，窗口查询/激活/边界读取还需系统 UI Automation。需要交互式登录桌面，不支持 UAC 安全桌面及窗口移动/缩放。 |

| ARP 路径（POST） | 操作与参数 | 结果/边界 |
| --- | --- | --- |
| `/local/connections/{connectionId}/desktop/mouse` | `position/move/click/drag/scroll` | 需要 robotjs；移动/点击用 `x/y`，拖拽另需 `fromX/fromY`；`durationMs` 默认 300；click 支持 `button` 和 `double`；scroll 用 `deltaX/deltaY` |
| `/local/connections/{connectionId}/desktop/keyboard` | `press` + `key`；`hotkey` + `key/modifiers`；`type` + `text` | 作用于当前焦点；修饰键支持 primary/command、ctrl、alt、shift；primary 在 macOS 为 Command，Windows 为 Ctrl |
| `/local/connections/{connectionId}/desktop/clipboard` | `action: read/write/clear`；写入用 `text` | 仅文本，最多 64 KiB UTF-8 |
| `/local/connections/{connectionId}/desktop/screenshot` | `{}` 或 `region: {x,y,width,height}` | 默认主屏幕；PNG 最多 8 MiB、实际像素最多 2000 万 |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/locate` | `templatePath`；可选 `region/tolerance` | 同时需要目录读取和桌面授权；返回首个匹配，不自动点击 |
| `/local/connections/{connectionId}/desktop/application` | `open` + `application/args`；`close` + `pid`；`print` + `pid` | 支持范围见平台表；PID 从窗口列表获取 |
| `/local/connections/{connectionId}/desktop/window` | `list/activate/bounds/move/resize` | 窗口列表最多 200 个；后续动作要求 PID 下精确标题唯一，按 OPTIONS 取得平台支持的参数 |

`keyboard type` 默认 `mode: "paste"`，通过剪贴板粘贴 Unicode 文本，**会覆盖当前剪贴板文本**。安装 robotjs 后可选 `mode: "keys"` 逐字输入，`intervalMs` 默认 50，总预计时长限 30 秒。输入是否生效取决于当前焦点、键盘布局和应用。

鼠标平滑移动，拖拽使用左键。`mouse position` 同时返回显示器列表，坐标允许副屏的负值。截图和找图区域须位于同一显示器内。

原生截图返回 `originX/originY/pixelsPerUnitX/pixelsPerUnitY`，图像点换算为屏幕点：`x = originX + pixelX / pixelsPerUnitX`，`y = originY + pixelY / pixelsPerUnitY`，取整后用于鼠标。图片定位直接返回换算后的 `center`。macOS 未安装 robotjs 时仍可用系统命令截取主屏幕，但不提供该换算信息。

模板匹配的 `tolerance` 是颜色误差容忍度，默认 0.1，0 为精确匹配。PNG 模板最多 8 MiB、200 万像素，需与截图保持相同像素比例，且不得通过符号链接越出工作目录。匹配返回首个结果，未找到返回 `found:false`；不支持多尺度搜索或语义识别。

应用启动使用参数数组，不解析 shell；macOS 的应用名示例为 `Calculator`，Windows 可传 `calc.exe`，仅接受 `.exe/.com`。打开应用只表示已请求启动，需再查窗口确认就绪。

关闭应用在 macOS 请求正常退出，Windows 请求关闭主窗口；保存提示可能阻止退出。打印向指定应用发送打印快捷键，返回 `printed:false`，不自动确认打印。

Windows 窗口列表包含 UI Automation 暴露的多窗口和对话框。无标题窗口、同 PID 下同标题窗口，以及未暴露的自绘弹层，不能通过窗口接口确定操作目标。

窗口列表的 `skipped` 表示存在不可访问或已失效的元素，`truncated` 表示达到结果上限（200 个）或 Windows 枚举上限（2000 个候选窗口）。Windows 窗口操作在枚举不完整时拒绝执行，可按 PID 缩小范围。

`activate` 恢复最小化窗口并确认焦点，成功返回 `{pid,title,x,y,width,height,minimized:false,active:true}`；无法激活时返回错误。`bounds` 返回边界和当前 `active` 状态，不激活窗口；最小化窗口需先激活，Windows 不可见窗口也会报错。

窗口边界使用屏幕坐标，可用于截图和找图的区域参数；跨屏或超出屏幕时需缩小区域。窗口移动或焦点变化后需重新获取状态，找图不能识别被遮挡的内容。

桌面操作的超时、并发及取消规则见 [执行限制与结果](#执行限制与结果)。

## 对话、流程与邮件

同一对话可使用多个已授权服务端。助手需有 `local.execute`，按任务选择连接与目录；目标不明确时会要求补充信息。

### 在流程中调用

流程编辑器的 **桌面自动化** 分类使用坐标、文本、PID 等表单参数，无需选择目标网页。环境、磁盘、文件和 Bash 节点在「本地文件与命令」分类。

所有本地节点均需选择连接（`connectionId`），磁盘、文件、命令和图片定位还需选择目录（`workspaceId`）。

| 信息节点 | 类型 | 其他参数与条件 |
| --- | --- | --- |
| 查询服务端环境 | `localEnvironment` | `refresh/outputFormat`；连接就绪，无需目录或桌面授权 |
| 查询目录磁盘 | `localDisk` | `refresh/outputFormat`；目录已确认，至少有读取、写入或执行中的一项权限 |

`outputFormat` 默认 `json`，环境查询返回 `{ environment, memory, description, audit }`，磁盘查询返回 `{ disk, description, audit }`。`description` 与连接配置页的说明一致；环境描述包含系统、运行环境、CPU、内存、执行限制和审计信息。

选择「说明文本」（`outputFormat: "text"`）时，节点直接输出描述字符串。例如将 `outputVar` 设为 `serverInfo`，下游用 `{{serverInfo}}` 引用说明；JSON 模式用 `{{serverInfo.description}}` 读取说明，或从结构化字段取值。

`refresh` 默认关闭，可复用有效采样；开启后请求刷新，仍受服务端采样间隔限制。采样失败或部分不可用时须查看返回的状态、原因和采样时间，未知值不等于零。

| 节点 | 类型 | 其他参数 |
| --- | --- | --- |
| 查询桌面能力 | `localDesktopCapabilities` | 无；返回完整连接快照，桌面能力在 `capabilities.desktop`，授权状态在 `desktop`；查询本身无需桌面授权 |
| 获取鼠标位置 | `localMousePosition` | 无；返回坐标和显示器列表 |
| 移动鼠标 | `localMouseMove` | `x/y/durationMs` |
| 点击鼠标 | `localMouseClick` | `x/y/button/double/durationMs` |
| 拖拽鼠标 | `localMouseDrag` | `fromX/fromY/x/y/durationMs` |
| 滚动鼠标滚轮 | `localMouseScroll` | `deltaX/deltaY` |
| 按下键盘按键 | `localKeyPress` | `key` |
| 发送键盘快捷键 | `localHotkey` | `key`；修饰键开关 `primary/ctrl/alt/shift`，默认开启 primary |
| 输入桌面文本 | `localTypeText` | `text/mode/intervalMs` |
| 读取剪贴板 | `localClipboardRead` | 无 |
| 写入剪贴板 | `localClipboardWrite` | `text`，允许空文本 |
| 清空剪贴板 | `localClipboardClear` | 无 |
| 截取桌面图像 | `localScreenshot` | 可选 `useRegion/x/y/width/height` |
| 查找桌面图片 | `localLocate` | `templatePath/tolerance`；可选 `useRegion/x/y/width/height` |
| 打开桌面应用 | `localApplicationOpen` | `application`；`args` 为每行一个参数的文本 |
| 请求关闭桌面应用 | `localApplicationClose` | `pid` |
| 打开应用打印对话框 | `localApplicationPrint` | `pid`，不自动确认打印 |
| 获取桌面窗口 | `localWindowList` | `title` 可空；`pid:0` 不限制进程 |
| 激活桌面窗口 | `localWindowActivate` | `pid/title`；恢复最小化窗口，确认激活并返回边界 |
| 获取窗口边界 | `localWindowBounds` | `pid/title`；只读返回 `x/y/width/height/active` |
| 移动桌面窗口 | `localWindowMove` | `pid/title/x/y`，仅 macOS |
| 调整桌面窗口大小 | `localWindowResize` | `pid/title/width/height`，仅 macOS |

截图和图片定位默认使用主屏幕，勾选 `useRegion` 后使用表单中的 `x/y/width/height`。拖拽先移动到起点再拖到终点，两段各使用 `durationMs`。

运行中目标离线、变化或权限不足会导致调用失败。写入、删除、Bash 和改变桌面状态的操作不自动重试。

Bash 非零退出码、超时或取消按失败处理，不写入成功输出变量。服务端已返回的命令结果保留在错误详情的 `result` 中；取消或断线时不保证能取得结果。非零退出的原因是 `COMMAND_EXIT_NONZERO`；退出码为零且执行成功时，`stdout/stderr` 等结果可供下游使用。

应用绑定流程也支持本地文件、Bash 和桌面节点，权限要求见[应用权限](./Page-Agent-13-应用.md#权限)。

操作结果写入 `last` 或节点的 `outputVar`。表单支持 `{{变量}}`，数值字段插值后转成数字，文本变量不会被再次解释。

典型流程：查询窗口 → 确认唯一目标 → 激活窗口 → 按返回边界找图 → 找到后点击。条件节点会改变 `last`，窗口和找图结果可分别保存到 `outputVar`。窗口移动后使用边界节点重新读取位置。

截图返回 `modelContent[0].data`（PNG Base64）、`modelContent[0].mimeType` 和尺寸，使用 robotjs 截图时还返回坐标换算信息。流程不自动触发视觉模型或保存图片文件。

### 邮件

邮件使用唯一 SMTP 配置，由 `connectionId` 指定发送服务端，不自动切换。发送方式与回执见[邮件通知](./Page-Agent-12-邮件通知.md)。

## 浏览器目标

外部 MCP 的 `/page` 操作按连接选择默认标签页策略；`OPTIONS` 和历史查询不绑定或创建标签页。

| 策略 | 未显式指定 `tabId` 时的行为 |
| --- | --- |
| `reuseOpenTab` 复用已打开标签 | 每次请求读取最后聚焦窗口的当前标签；切换当前页会改变后续请求的目标 |
| `fixedCurrentTab` 固定当前标签 | 首次页面请求绑定当时的当前标签；随后切换焦点不会改变目标 |
| `fixedNewTab` 固定打开标签 | 首次页面请求在当前窗口新开后台标签并固定，仅复制当前页 URL；当前页须为 HTTP(S) 页面 |

显式指定 `tabId` 可覆盖当次请求的默认目标，标签须属于当前普通／隐私环境。`/browser` 和 CDP 使用各自指定的目标。多个连接可操作同一页面，仍受页面锁和权限限制。

固定标签关闭后返回 `RESOURCE_GONE`，可指定 `tabId` 或点击「重新连接」重新绑定。修改策略、停用连接、配对、手动重连或扩展后台重启会清除绑定；网络自动重连保留绑定。已创建的标签不会自动关闭。

## MCP Resources

MCP Resource URI 是 ARP URI 的可逆包装：

```text
ARP URI       /flows
MCP URI       arp:///flows
```

`resources/list` 从 `OPTIONS /` 获取根和一级资源。

读取 `arp:///`、`arp:///page` 或 `arp:///browser` 等价于 OPTIONS；其他资源按 GET 读取，例如 `arp:///flows`、`arp:///skills`。

需要查询参数或执行已授权操作时使用六个方法工具；Resource URI 不接受 query 或片段。

## 启动

单文件服务端见[独立打包](./Page-Agent-00-安装与打包.md#独立打包-mcp-server)和[独立部署](./Page-Agent-00-安装与打包.md#独立部署-mcp-server)。

在仓库根目录安装依赖并启动源码服务：

```bash
npm --prefix ./mcp-server install
node mcp-server/index.js
```

默认地址：

```text
WebSocket  127.0.0.1:9999
HTTP       127.0.0.1:9998
```

首次启动自动生成并在终端显示配对密码，后续启动复用已有密码，不再显示。在扩展「连接配置」中输入密码完成配对，再打开连接开关。

服务端名称默认取运行机器的 hostname，可用 `node mcp-server/index.js --server-name "开发机"` 或环境变量 `PAGE_AGENT_SERVER_NAME` 指定，命令行优先；名称最多 300 个字符，不能包含控制字符。每次启动重新读取配置，修改后重启服务即可。名称会显示在启动日志、扩展的 MCP 连接日志标题以及 HTTP MCP 初始化响应的 `serverInfo.title` 中。

连接日志标题显示「客户端 名称 · ID」和「服务端 名称 · ID」，名称及 ID 均可点击复制。扩展会保存最近确认的服务端名称，断开后仍可查看；更换连接地址或重新配对到其他服务端时清除旧名称。服务端名称用于展示，身份校验使用 `serverId`，修改名称无需重新配对。连接别名仍由扩展单独管理。

数据目录默认是启动工作目录下的 `./data/`，认证、审计和服务端持久状态统一保存于此，启动时会显示实际路径。`data/auth.json` 保存服务端身份、配对信息和 HTTP 令牌校验值，`data/audit/` 保存审计记录；进程锁、认证锁及状态写入的临时文件也位于数据目录内。重启需使用同一数据目录；改变启动目录时，用 `--state-dir <原数据目录>` 保留身份与配对。一个数据目录同时只允许一个服务进程。

外部 MCP 客户端配置（字段名以客户端界面为准）：

```text
Transport: Streamable HTTP
URL: http://127.0.0.1:9998/mcp
Authorization: Bearer <HTTP令牌>
```

HTTP 令牌与配对密码独立生成：优先使用显式配置，否则复用已保存的凭据；尚无凭据时自动生成，明文仅在终端显示一次，请保存。`auth.json` 只保存各自的校验值，重启后继续有效。

通过 `PAGE_AGENT_HTTP_BEARER_TOKEN` 设置或重置 HTTP 令牌，空值视为未配置；设置后即使移除环境变量也会复用该令牌。忘记令牌时，设置新值并重启即可。

### Docker Compose

Docker 文件和部署说明统一位于 `docker/`。开发时在工作区根目录操作，发布后在 release 解压根目录操作。

- 首次构建：`./docker/build.sh all`。
- 日常更新：`./docker/build.sh app`。
- 两种目录使用相同命令，宿主机无需安装 Node.js，也无需先生成发布包。

镜像分层、首次配对、HTTPS、环境变量、更新与数据保留方式见 [Docker、同步和备份](../docker/README.md)。容器同时运行 MCP Server、Chromium 和插件，支持启动自动同步；各环境均可手动同步和备份。

## 配对与 WebSocket 会话

首次配对使用服务端密码，需通过可信通道进行；后续连接使用保存的配对凭据。认证后的 WebSocket 通信使用 AES-256-GCM 加密，校验失败会断开连接。远程 WebSocket 使用 WSS，远程 HTTP MCP 使用 HTTPS 和独立 Bearer 凭据。

凭据按普通／隐私环境及连接隔离，不出现在资源查询、模型上下文、日志或连接备份中。

在服务启动工作目录管理配对，命令默认读取同一个 `./data/`；自定义数据目录需附加相同的 `--state-dir`。以下命令分别列出配对、撤销指定配对和生成新密码：

```bash
node mcp-server/index.js auth pairings list
node mcp-server/index.js auth pairings revoke <pairingId>
node mcp-server/index.js auth set-password
```

使用单文件发布包时，将命令中的 `mcp-server/index.js` 换成实际 `.cjs` 文件路径。也可在启动时用 `node mcp-server/index.js --password '你的密码至少12个字符'` 指定 12–256 个字符的密码。

改密会撤销全部配对并保留服务端身份；指定撤销只影响对应客户端。重新配对在密码验证成功后撤销当前服务端上同一客户端的旧凭据并签发新凭据，旧会话随之失效。同一服务端重新配对保留连接的启用状态及授权；密码错误不会清除原有凭据和绑定。删除连接只清除扩展本机记录，需要撤销服务端凭据时仍可使用上述命令。

更换数据目录后出现 `SERVER_ID_CHANGED`，表示当前服务端身份与扩展保存的绑定不一致。在「连接配置」选择原连接，打开「配对」并输入新服务端密码即可更新绑定。

配对到不同服务端时，仅重置这条连接的授权：保留连接开关、连接 ID、目录 ID、别名和配置路径，清除旧目录确认状态，关闭桌面和自定义目录权限；工作目录恢复默认只读。配对成功后按开关状态自动连接，并重新设置所需权限。原服务端上的配对记录不会被删除。

如果只是迁移目录并希望继续使用原身份与配对，按下方「服务端认证状态迁移」恢复原 `auth.json`，无需重新配对。

WebSocket 地址支持 `ws://` 与 `wss://`，不接受用户名、密码、查询参数或片段。

已开启且保存凭据的连接遇到网络故障或握手超时，首次尝试后最多自动重试 20 次，间隔按 1、2、4、8、16、30 秒递增，之后保持 30 秒；连接就绪后重置次数，不重放业务请求。达到上限后停止自动重试并提示手动重连，开关保持开启。密钥缺失、凭据被拒绝或撤销时停止自动尝试并提示重新配对；协议不兼容需同步升级。「重新连接」会取消该连接的进行中请求，并重置重试次数和默认页面绑定。

## 配置项

扩展的「系统配置 → 浏览器代理」支持 `http://host:port`、`https://host:port`、`socks4://host:port` 和 `socks5://host:port`。
HTTP / HTTPS 代理的用户名和密码填写在独立字段中；Chrome 原生 SOCKS 代理不支持用户名密码认证，填写后会报错。
修改地址、认证或域名规则后点击「保存代理设置」。

系统代理覆盖浏览器发起的远程 HTTP MCP 和 WebSocket 连接，也影响模型请求与其他标签页。
Chrome 默认绕过 localhost 和回环地址，因此默认的本机 MCP 连接通常仍然直连；MCP Server 进程自身的网络请求不受此设置控制。

「设置会话代理」和系统代理都支持匹配域名、绕过域名及 HTTP / HTTPS 认证。

- 域名用逗号或换行分隔，支持 `*`、`?` 通配符；系统匹配域名留空表示全部，流程节点留空使用目标页面域名。
- 先匹配流程规则，再匹配系统规则；命中一条规则后，若命中该规则的绕过域名则直连，否则走该代理。没有匹配规则时直连。
- `*.example.com` 不包含 `example.com`，需要时分别填写；`<local>` 表示不含点的简单主机名。
- 同一代理服务器在同时生效的规则中必须使用一致的认证信息。

「清除会话代理」或流程结束会移除当前流程的规则，保留系统代理与其他会话规则。
系统代理留空且没有流程规则时，扩展释放代理控制，浏览器可能恢复其他扩展或系统的代理配置。

系统配置页显示实际控制权；其他扩展或浏览器策略可能使本扩展的配置无法生效。

HTTP 认证只响应匹配的代理认证挑战；`/system-settings` 响应不返回代理密码。

系统 User-Agent 用于扩展的非模型请求，包括 HTTP MCP、WebSocket 握手和 MCP 客户端信息；HTTP MCP 显式配置的 `User-Agent` 请求头优先。

保存系统代理或 User-Agent 后，启用的 MCP WebSocket 会自动重连，进行中的请求可能中断。

模型 User-Agent 仍使用各模型服务自己的配置。

命令行参数：

```text
--ws-port <port>       WebSocket 端口
--http-port <port>     HTTP 端口
--host <host>          默认绑定地址
--ws-host <host>       WebSocket 绑定地址
--http-host <host>     HTTP 绑定地址
--server-name <name>   服务端显示名称，默认 hostname
--state-dir <directory>  认证、审计与状态数据目录，默认工作目录下的 ./data
--password <password>  设置或重置配对密码；首次启动省略时自动生成，后续省略时复用
--audit-command-content hash|plain  命令审计内容，默认 plain
```

监听环境变量为 `WS_PORT`、`HTTP_PORT`、`PAGE_AGENT_HOST`、`PAGE_AGENT_WS_HOST`、`PAGE_AGENT_HTTP_HOST`；HTTP 使用 `PAGE_AGENT_HTTP_BEARER_TOKEN` 和 `PAGE_AGENT_HTTP_CORS_ORIGINS`。

## HTTP API

| 接口 | 用途 |
| --- | --- |
| `POST /mcp` | MCP 工具与资源访问 |
| `DELETE /mcp` | 结束 MCP 会话并取消进行中的请求 |
| `GET /mcp/clients` | 查询已连接扩展的客户端 ID |
| `GET /healthz` | 检查服务是否存活，不代表扩展或审计已就绪 |

除 `GET /healthz` 和 `OPTIONS` 预检外均需 `Authorization: Bearer <HTTP令牌>`，令牌来自显式配置或启动时自动生成的值。MCP 使用 Streamable HTTP，支持协议版本 `2025-11-25` 和 `2025-06-18`，提供 JSON 响应，不提供 SSE 或资源变更推送。

`POST /mcp` 的请求体最多 2 MiB，需设置 `Content-Type: application/json`，且 `Accept` 同时包含 `application/json` 和 `text/event-stream`。客户端先完成 `initialize` 与 `notifications/initialized`，后续请求携带返回的 `Mcp-Session-Id`；若携带 `MCP-Protocol-Version`，须与会话协商版本一致。

本地能力无需客户端 ID。插件请求可通过 `/clients/{clientId}/arp` 指定目标，也可使用 URL 参数 `mcpClientId`、请求头 `X-Page-Agent-MCP-Client-Id` 或工具参数 `mcpClientId`。各处 ID 必须一致；会话绑定后不能更换目标，多客户端调用使用未绑定会话。

HTTP 和 WebSocket 转发到插件的请求可读取资源、操作页面／浏览器及使用当前服务端已授权的本地能力；不能创建、修改或启动 Flow、流程组、脚本、对话、定时任务或应用动作，也不能转发到其他服务端执行本地操作。

服务最多支持 64 个 HTTP 会话；无活动请求且空闲 30 分钟后会话过期。每会话最多 8 个并发调用，全服务最多 32 个，超限返回 429。会话过期或服务重启后需重新连接。

结束会话或执行中断开 HTTP 连接会取消对应请求；取消不保证操作立即停止，结果未知时应先核对实际效果。

CORS 默认允许回环和扩展来源，可用 `PAGE_AGENT_HTTP_CORS_ORIGINS` 追加逗号分隔的来源。

## 环境与磁盘

HTTP 直接调用使用 `/local/environment`、`/local/disk`；下表为扩展内路径：

| ARP 路径（GET） | 返回内容 |
| --- | --- |
| `/local/connections/{connectionId}/environment` | 基础环境与动态内存 |
| `/local/connections/{connectionId}/workspaces/{workspaceId}/disk` | 授权目录根所在文件系统的空间 |

两类查询均支持 `?refresh=true`。环境信息包含操作系统、Node、架构、Bash、CPU、内存及执行账号；内存区分系统空闲量与进程可用量。

磁盘查询需目录已确认且至少有一项权限，返回所在文件系统的总量、可用量和空闲量；实际写入仍受配额与只读限制。

结果带采样时间和可用状态，未知值为空，过期或离线数据会标记为过期。查询失败不关闭文件或命令能力。

## 执行限制与结果

| 项目 | 限制 |
| --- | --- |
| Bash | 超时可设为 1–60 秒，默认 30 秒；输出超额截断但不因此终止命令 |
| 文件读写、删除、查找 | 最长 60 秒 |
| 桌面 | 最长 30 秒；同一服务进程内只执行一个桌面操作 |
| 本地及环境请求 | 每客户端最多 4 个并发请求，全服务最多 8 个；超额返回 `RESOURCE_BUSY` |

并发请求不保证完成顺序；多步桌面操作之间可能插入其他客户端的操作。Bash 和桌面没有单次请求的 CPU／内存硬限制。

| 结果字段 | 含义 |
| --- | --- |
| `execution.outcome` | `rejected/succeeded/failed/cancelled/timed_out/unknown`；仅 succeeded 对应 `ok: true` |
| `execution.termination` | `not_started` 未启动；`settled` 受控执行已结束；`unconfirmed` 尚未确认结束 |
| `receipt.performed` | `no` 无业务修改、`yes` 已生效、`unknown` 效果未确认；只读请求的 no 不表示没有执行读取 |
| `audit.recorded` | 结果审计是否成功持久化 |

Bash 非零退出视为失败，保留退出码及输出。失败、超时或取消的操作可能已部分生效，不会自动撤销修改，应结合 `receipt.performed` 核对实际结果。

取消请求被接收不代表操作已停止。无法确认停止时，结果标记为未知，操作仍占用并发额度，重连也不会释放。取消、断线或结果未知时，应先核对实际效果，不自动重放请求。

### 常见拒绝原因

| 提示 | 处理方式 |
| --- | --- |
| 未配对或凭据已撤销 | 在连接配置中重新配对 |
| 缺少连接或目录 | 选择目标，调用时使用 `GET /local` 返回的完整 URI |
| 目录不存在或权限不足 | 检查服务端路径及目录、桌面授权 |
| 服务端身份或目录路径变化 | 核对目标后重新配置或授权 |
| 连接未就绪或审计不可用 | 检查连接状态、服务日志及审计目录是否可写 |
| 磁盘已满、配额不足或只读 | 检查服务端存储空间与文件系统权限 |

## 服务端审计

审计保存在 `<state-dir>/audit/`，记录连接和配对的时间、客户端身份，以及实际权限变更。握手、重复提交同一版权限、协议心跳和配置状态轮询不单独记录。文件、命令、桌面、邮件、环境查询和转发请求均依赖审计可用。

执行审计记录执行前的意图和最终结果，通过会话和请求 ID 关联。Bash 命令默认明文记录一次，包含命令中的路径和参数；使用 `--audit-command-content hash` 仅记录摘要。其他本地操作只记录参数的 SHA-256 摘要和字节数，文件路径和转发 URI 也仅记录摘要；文件正文、搜索词、键盘和剪贴板输入、操作返回内容、邮件内容和认证凭据不明文写入。

配置同步和备份记录发起者（客户端、HTTP 操作者或自动任务）、目标客户端、备份桶、同步版本、备份版本及结果；重试记录本次发起者。操作结果的 `audit.recorded` 表示最终审计是否持久化。

文件按 UTC 日期或 10 MiB 轮转，关闭文件最多保留 30 天，总量最多 100 MiB。

审计不可用时拒绝新执行和授权扩大，撤权与停止仍生效。操作完成后审计写入失败，会保留实际结果并标记审计失败；恢复后不重放旧请求。

清空连接日志不删除审计文件；审计文件不提供防篡改保证。

## Linux 与远程部署

Linux 支持文件、Bash、环境和磁盘查询，不支持桌面操作。使用普通账号运行，在进程管理工具中固定工作目录、Node 路径和 HTTP Bearer；需要单独保存状态时指定 `--state-dir`。

远程接入使用 WSS／HTTPS，内部端口监听回环地址。反向代理需转发 WebSocket Upgrade、Origin、Authorization 和 MCP 会话头。

## 备份与恢复

### 服务端认证状态迁移

迁移服务端身份、配对和 HTTP 令牌时，先停止服务，将完整的 `auth.json` 复制到新状态目录，再指定该目录启动：

```bash
node page-agent-mcp-server.cjs --state-dir /srv/page-agent-state
```

启动时不要附加 `--password`，该参数会重置密码并撤销全部配对。状态目录默认是 `./data/`，可用 `--state-dir .` 指定启动工作目录；状态文件需手动迁移。文件操作的默认工作目录由启动时的当前工作目录决定。

续用原配对还需保留原浏览器中的身份与凭据，并保持连接 URL 不变。修改 URL 或导入连接备份后需重新配对。

HTTP Bearer 随 `auth.json` 迁移，客户端可继续使用原令牌；新部署若显式配置不同的 `PAGE_AGENT_HTTP_BEARER_TOKEN`，则替换为新令牌。业务文件另行迁移，需要历史审计时一并复制 `audit/`。锁文件及临时文件不迁移。

### 扩展连接备份

连接备份包含地址、别名、服务端身份、远程操作权限、目录授权和引用，不含配对凭据、客户端身份或运行会话。SMTP 密码规则见[邮件备份](./Page-Agent-12-邮件通知.md#配置备份与恢复)。

导入连接（含覆盖）均禁用并清除本机凭据，需重新配对。目录权限须与服务端实际路径核对；缺少有效路径记录或路径变化时需重新授权。应用附带的连接遵循相同规则。

一并导入的流程、邮件及任务会自动更新连接和目录引用；别名冲突需在预览中解决。无法确认目标时，需重新选择连接与目录。导入不恢复未完成请求。
