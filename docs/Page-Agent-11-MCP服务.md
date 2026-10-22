# Page Agent MCP 服务

MCP Server 是可选的 Node.js 服务，通过 stdio 或 HTTP 接收 MCP 请求，通过 WebSocket 转发 ARP/1 请求到扩展。页面、Flow、Conversation、Knowledge 和权限由扩展处理。

```text
MCP Client --stdio / HTTP--> Node MCP Server --WebSocket--> 扩展 ARP/1 Router
```

## MCP 工具

MCP 对外提供六个方法工具：

```text
GET  POST  PUT  PATCH  DELETE  OPTIONS
```

`ASK_USER` 是扩展内 Agent 的对话工具，不通过 MCP 暴露。

调用参数使用 [ARP 协议](./Page-Agent-10-ARP协议.md)的固定外层。连接多个扩展时，在 arguments 顶层传入 `mcpClientId`：

```json
{
  "name": "GET",
  "arguments": {
    "mcpClientId": "pfa_client_1",
    "uri": "/flows?limit=20"
  }
}
```

请求和业务错误都返回完整 ARP Envelope，并同时写入 MCP 的 `content` 与 `structuredContent`。

Server 会移除传输专用字段后再发送给扩展；扩展根据已建立的连接生成可信权限上下文，不接受客户端自报的 actor、permission、origin、tab 或 window。

## 对话中的本地文件、命令与桌面

「启用本地文件、命令与桌面」默认开启，使用 `local.execute` 权限。
**未连接 MCP Server 时不向对话暴露这些能力**；连接成功且服务端支持时才提供。

工作目录必填，未自定义时由服务端运行目录自动填充并回显，已保存的自定义目录优先。
文件操作与 Bash 使用该目录，对话不能覆盖配置。工作目录不限制桌面操作范围。

普通窗口与隐私窗口分别保存设置；关闭、断线或更换目录后取消正在执行的命令，关闭或断线后隐藏目录并拒绝后续调用。
已完成的文件修改不会撤销。

| ARP 路径（POST） | 参数 | 行为 |
| --- | --- | --- |
| `/local/read` | `path`、可选 `offset` / `limit` | 读取 UTF-8 文本；行号从 1 开始，默认 200 行 |
| `/local/write` | `path`、`content` | 创建或覆盖文件，自动创建父目录 |
| `/local/delete` | `path` | 删除文件或符号链接，不递归删除目录 |
| `/local/grep` | `path`、`pattern`、可选 `limit` | 递归查找区分大小写的字面文本，默认最多 100 行匹配 |
| `/local/bash` | `command`、可选 `timeoutMs` | 从配置的工作目录启动独立 Bash 进程，默认超时 30 秒，最多 60 秒 |

文件与命令在 **MCP Server 所在机器** 上操作。

文件操作将相对路径解析到配置的工作目录，检查绝对路径、`..` 和符号链接是否越界；删除目录内的符号链接只删除链接本身。

Bash 的启动目录固定为该目录，执行需要服务端安装 Bash；Bash 本身不是目录沙箱，命令仍以服务端进程权限运行。

连接远程服务端须使用 `wss://`。

读取与查找只处理最多 4MB 的文本文件，写入最多 1MB；读取、查找和命令输出最多 64KB。

查找跳过符号链接、二进制、大文件及 `.git` / `node_modules` 目录，最多访问 5000 个条目或扫描 60 秒；返回 `skipped` 和 `truncated` 表明结果是否完整。

命令返回 stdout、stderr、退出码、超时和截断状态。
取消、断线或超时后不要自动重放写入或命令，先确认实际结果。

本地操作开关仅允许扩展界面修改。

### 桌面操作

桌面操作通过 `/local/*` 调用，作用于 **MCP Server 所在机器当前登录的桌面**，仅支持 macOS 和 Windows。

鼠标、模板匹配及部分键盘和截图功能需要可选依赖 `robotjs@0.9.1`。在服务端文件所在目录安装：

```bash
npm install --no-save --ignore-scripts robotjs@0.9.1
```

`--ignore-scripts` 禁止安装时回退到本地编译。使用单文件发布包时，依赖需保留在 `.cjs` 所在目录的 `node_modules` 中。

`POST /local/desktop`（body 为 `{}`）返回平台、依赖状态、支持的动作和系统权限要求。依赖状态仅表示包可被找到，不验证原生二进制兼容性或系统权限；实际调用失败时返回原因。

| 平台 | 条件与范围 |
| --- | --- |
| macOS | 鼠标、逐字输入、区域截图和模板匹配需要 robotjs；未安装时可用剪贴板、基础键盘、主屏幕截图、应用和窗口操作。输入和窗口需「辅助功能」，系统脚本需「自动化」，截图需「屏幕录制」权限。 |
| Windows | 鼠标、键盘、截图和模板匹配需要 robotjs；剪贴板、关闭应用、打印和窗口操作需要 Windows PowerShell 5.1，窗口查询/激活/边界读取还需系统 UI Automation。需要交互式登录桌面，不支持 UAC 安全桌面及窗口移动/缩放。 |

| ARP 路径（POST） | 操作与参数 | 结果/边界 |
| --- | --- | --- |
| `/local/desktop` | `{}` | 平台、已安装依赖、支持的动作和系统权限要求 |
| `/local/mouse` | `position/move/click/drag/scroll` | 需要 robotjs；移动/点击用 `x/y`，拖拽另需 `fromX/fromY`；`durationMs` 默认 300；click 支持 `button` 和 `double`；scroll 用 `deltaX/deltaY` |
| `/local/keyboard` | `press` + `key`；`hotkey` + `key/modifiers`；`type` + `text` | 作用于当前焦点；修饰键支持 primary/command、ctrl、alt、shift；primary 在 macOS 为 Command，Windows 为 Ctrl |
| `/local/clipboard` | `action: read/write/clear`；写入用 `text` | 仅文本，最多 64KB UTF-8 |
| `/local/screenshot` | `{}` 或 `region: {x,y,width,height}` | 默认主屏幕；原生截图返回区域和像素换算比例；PNG 最多 8MB、实际像素最多 2000 万 |
| `/local/locate` | `templatePath`；可选 `region/tolerance` | 需要 robotjs；工作目录内 PNG 模板，最多 8MB、200 万像素；返回首个匹配的 `found/bounds/center`，不自动点击 |
| `/local/application` | `open` + `application/args`；`close` + `pid`；`print` + `pid` | 支持范围见平台表；PID 从窗口列表获取 |
| `/local/window` | `list` 可选 `title/pid`；`activate/bounds` 需 `pid/title`；macOS 的 `move` 需 `pid/title/x/y`，`resize` 需 `pid/title/width/height` | 列表按标题包含文本过滤，最多 200 个窗口；操作时要求 PID 下精确标题唯一；activate 恢复并激活窗口，bounds 只读边界 |

详细的互斥参数和范围通过 `OPTIONS /local/<名称>` 获取。

`keyboard type` 默认 `mode: "paste"`，通过剪贴板粘贴 Unicode 文本，**会覆盖当前剪贴板文本**。安装 robotjs 后可选 `mode: "keys"` 逐字输入，`intervalMs` 默认 50，总预计时长限 30 秒。输入是否生效取决于当前焦点、键盘布局和应用。

鼠标平滑移动，拖拽使用左键。`mouse position` 同时返回显示器列表，坐标允许副屏的负值。截图和找图区域须位于同一显示器内。

原生截图返回 `originX/originY/pixelsPerUnitX/pixelsPerUnitY`，图像点换算为屏幕点：`x = originX + pixelX / pixelsPerUnitX`，`y = originY + pixelY / pixelsPerUnitY`，取整后用于鼠标。图片定位直接返回换算后的 `center`。macOS 未安装 robotjs 时仍可用系统命令截取主屏幕，但不提供该换算信息。

模板匹配的 `tolerance` 是颜色误差容忍度，默认 0.1，0 为精确匹配。模板需与截图保持相同像素比例，返回首个匹配，未找到返回 `found:false`；不支持多尺度搜索或语义识别。PNG 模板不得通过符号链接越出工作目录。

应用启动使用参数数组，不解析 shell；macOS 的应用名示例为 `Calculator`，Windows 可传 `calc.exe`，仅接受 `.exe/.com`。打开应用只表示已请求启动，需再查窗口确认就绪。

关闭应用在 macOS 请求正常退出，Windows 请求关闭主窗口；保存提示可能阻止退出。打印向指定应用发送打印快捷键，返回 `printed:false`，不自动确认打印。

Windows 窗口列表包含 UI Automation 暴露的多窗口和对话框。无标题窗口、同 PID 下同标题窗口，以及未暴露的自绘弹层，不能通过窗口接口确定操作目标。

窗口列表的 `skipped` 表示存在不可访问或已失效的元素，`truncated` 表示达到结果上限（200 个）或 Windows 枚举上限（2000 个候选窗口）。Windows 窗口操作在枚举不完整时拒绝执行，可按 PID 缩小范围。

`activate` 恢复最小化窗口并确认焦点，成功返回 `{pid,title,x,y,width,height,minimized:false,active:true}`；无法激活时返回错误。`bounds` 返回边界和当前 `active` 状态，不激活窗口；最小化窗口需先激活，Windows 不可见窗口也会报错。

窗口边界使用屏幕坐标，可用于截图和找图的区域参数；跨屏或超出屏幕时需缩小区域。窗口移动或焦点变化后需重新获取状态，找图不能识别被遮挡的内容。

同一服务端进程同时只执行一个桌面操作，冲突请求失败。系统命令和图片匹配超时为 30 秒；取消或超时不会撤销已发生的操作，不应自动重放。

### 在流程中调用

流程编辑器的 **桌面自动化** 分类使用坐标、文本、PID 等表单参数，无需选择目标网页。文件和 Bash 节点在「本地文件与命令」分类。

| 节点 | 类型 | 主要参数 |
| --- | --- | --- |
| 查询桌面能力 | `localDesktopCapabilities` | 无 |
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
| 截取桌面图像 | `localScreenshot` | 可选区域参数，见下文 |
| 查找桌面图片 | `localLocate` | `templatePath/tolerance`；可选区域参数 |
| 打开桌面应用 | `localApplicationOpen` | `application`；`args` 为每行一个参数的文本 |
| 请求关闭桌面应用 | `localApplicationClose` | `pid` |
| 打开应用打印对话框 | `localApplicationPrint` | `pid`，不自动确认打印 |
| 获取桌面窗口 | `localWindowList` | `title` 可空；`pid:0` 不限制进程 |
| 激活桌面窗口 | `localWindowActivate` | `pid/title`；恢复最小化窗口，确认激活并返回边界 |
| 获取窗口边界 | `localWindowBounds` | `pid/title`；只读返回 `x/y/width/height/active` |
| 移动桌面窗口 | `localWindowMove` | `pid/title/x/y`，仅 macOS |
| 调整桌面窗口大小 | `localWindowResize` | `pid/title/width/height`，仅 macOS |

截图和图片定位默认使用主屏幕，勾选 `useRegion` 后使用表单中的 `x/y/width/height`。拖拽先移动到起点再拖到终点，两段各使用 `durationMs`。

节点使用连接配置中的本地操作开关和工作目录。改变桌面状态的操作（包括窗口激活）禁用自动重试，只读操作支持重试。

应用绑定流程也支持本地文件、Bash 和桌面节点，权限要求见[应用权限](./Page-Agent-13-应用.md#权限)。

操作结果写入 `last` 或节点的 `outputVar`。表单支持 `{{变量}}`，数值字段插值后转成数字，文本变量不会被再次解释。

典型流程：查询窗口 → 确认唯一目标 → 激活窗口 → 按返回边界找图 → 找到后点击。条件节点会改变 `last`，窗口和找图结果可分别保存到 `outputVar`。窗口移动后使用边界节点重新读取位置。

截图返回 `modelContent[0].data`（PNG Base64）、`modelContent[0].mimeType` 和尺寸，使用 robotjs 截图时还返回坐标换算信息。流程不自动触发视觉模型或保存图片文件。

## MCP Resources

MCP Resource URI 是 ARP URI 的可逆包装：

```text
ARP URI       /flows
MCP URI       arp:///flows
```

`resources/list` 从 `OPTIONS /` 获取根和一级资源。

读取 `arp:///page` 或 `arp:///browser` 等聚合入口等价于局部 OPTIONS；读取 `arp:///flows`、`arp:///skills` 等业务资源等价于 GET。

需要 query、创建或修改时使用六个方法工具，不在 Resource URI 中隐藏命令。

## 启动

服务端需要 Node.js 16 或更高版本。在扩展的「连接配置」中开启 MCP Server 连接。

源码启动：

```bash
cd mcp-server
npm install
npm start
```

默认地址：

```text
WebSocket  127.0.0.1:9999
HTTP       127.0.0.1:9998
```

单文件发布包 `page-agent-mcp-server.cjs` 可在 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "page-agent": {
      "command": "node",
      "args": ["/absolute/path/page-agent-mcp-server.cjs"]
    }
  }
}
```

## 配置项

扩展的「系统配置 → 浏览器代理」支持 `http://host:port`、`socks5://host:port`。
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
--default-client-id <id>
--default-client-name <name>
```

对应环境变量为 `WS_PORT`、`HTTP_PORT`、`PAGE_AGENT_HOST`、`PAGE_AGENT_WS_HOST`、`PAGE_AGENT_HTTP_HOST`、`PAGE_AGENT_DEFAULT_CLIENT_ID`、`PAGE_AGENT_DEFAULT_CLIENT_NAME` 和 `PAGE_AGENT_HTTP_CORS_ORIGINS`。

`default-client-*` 只用于 HTTP webhook 等兼容入口。连接多个扩展时，MCP 方法工具必须显式提供 `mcpClientId`。

## HTTP API

HTTP 服务提供 MCP JSON-RPC、Flow／FlowGroup webhook、运行结果和连接状态：

```text
POST /mcp
POST /webhook/run/{flowId}
POST /webhook/run-group/{groupId}
GET  /webhook/result/{runId}
GET  /healthz
GET  /mcp/clients
```

`POST /mcp` 接收 MCP JSON-RPC 消息。配置环境变量 `PAGE_AGENT_HTTP_BEARER_TOKEN` 后，该入口要求 `Authorization: Bearer <token>`；此配置不作用于 webhook。

Flow webhook 示例：

```bash
curl -X POST http://localhost:9998/webhook/run/flow_123 \
  -H 'Content-Type: application/json' \
  -d '{"input":{"keyword":"example"}}'
```

默认等待 Run 进入终态；使用 `?wait=false` 立即返回 `202`，再通过 `/webhook/result/{runId}` 查询。
`?timeoutMs=...` 可调整等待上限。

请求体中的 `input` 可在 Flow 模板中通过 `{{input}}` 使用。

webhook 可选请求头：`Idempotency-Key`、`X-Page-Agent-Session-Id`、`X-Page-Agent-MCP-Client-Id`、`X-Page-Agent-MCP-Client-Name`。

webhook 返回 ARP Envelope；`/healthz` 和 `/mcp/clients` 返回普通 JSON，`/mcp` 返回 JSON-RPC 响应。
