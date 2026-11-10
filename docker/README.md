# Docker 部署、更新与备份

每个容器运行 MCP Server、Chromium 和 Page Agent 插件，通过 Selkies 查看和操作浏览器。宿主机需安装 Docker（含 Compose）和 Bash，无需安装 Node.js。

**所有命令在包含 `docker/` 的项目根目录执行。** 源码工作区和 release 解压目录使用相同命令。

| 内容 | 位置 |
| --- | --- |
| 环境配置 | `docker/.env` |
| 容器配置 | `docker/compose.yaml` |
| 运行数据 | `data/` |

## 首次启动

### 1. 准备配置

仅在没有 `docker/.env` 时复制：

```bash
cp ./docker/.env.example ./docker/.env
```

编辑 `docker/.env`，填写 `PAGE_AGENT_PAIRING_PASSWORD`，至少 12 个字符。

### 2. 构建镜像

```bash
./docker/build.sh all
```

### 3. 启动容器

```bash
docker compose --env-file ./docker/.env -f ./docker/compose.yaml \
  up -d --no-build
```

打开 **<https://localhost:10000/>** 查看浏览器。

- 首次访问需信任自动生成的自签名证书。
- 插件自动配对容器内的 MCP Server。
- 已保存认证和浏览器配对数据时，重启无需再次提供密码。

## 日常更新

更新代码或 release 文件后，保留 `docker/.env` 和 `data/`，执行：

```bash
./docker/build.sh app

docker compose --env-file ./docker/.env -f ./docker/compose.yaml \
  up -d --no-build --force-recreate
```

启动脚本、插件和 MCP Server 从镜像加载；修改挂载目录不会更新运行代码。部署到其他主机时，先更新目标主机的镜像，再重新创建容器。

### 依赖也发生变化时

| 修改了什么 | 按顺序构建哪些层 |
| --- | --- |
| 插件、MCP Server、启动脚本 | `app` |
| Selkies 依赖 | `runtime` → `app` |
| Node.js、Chromium | `browser` → `runtime` → `app` |
| Ubuntu 或基础工具 | `all` |
| 环境变量 | 无需构建，重新创建容器 |

各层使用 `./docker/build.sh <构建层>` 构建，完成后重新创建容器。

## 常用操作

**查看日志：**

```bash
docker compose --env-file ./docker/.env -f ./docker/compose.yaml \
  logs --tail=100 page-agent
```

**仅重启现有容器：**

```bash
docker compose --env-file ./docker/.env -f ./docker/compose.yaml restart
```

**停止并移除容器：** 保留 `data/` 中的数据。

```bash
docker compose --env-file ./docker/.env -f ./docker/compose.yaml down
```

`restart` 仅重启原容器；应用新镜像或环境变量时，使用[日常更新](#日常更新)中的 `up --force-recreate` 命令。

## 修改配置

变量用途、默认值和示例见 [`docker/.env.example`](.env.example)。

### 启用可选环境变量

在 `docker/.env` 中启用所需变量后，按[常用操作](#常用操作)重新创建容器，无需构建镜像。

命令行 `--env-file` 用于 Compose 插值，服务级 `env_file` 将变量传入容器；两者均读取 `docker/.env`，无需逐项添加 `environment` 映射。

### 自定义镜像或部署多个实例

| 需求 | 操作 |
| --- | --- |
| 自定义镜像 | 在 `docker/.env` 填写完整镜像名和标签；构建前 `export` 同名同值的变量 |
| 多个实例 | 每个实例使用独立项目目录和 `data/`，设置不同的 `COMPOSE_PROJECT_NAME` 与宿主机端口 |
| 注入模型密钥 | 在 `docker/.env` 中按示例填写模型 ID 对应的变量 |
| 模型 ID 含 `-`、`.`、`:` | 在 Compose 的 `environment` 中直接填写完整键名和值 |

构建脚本只读取 shell 环境，不自动加载 `docker/.env`。

## 访问服务

| 地址 | 用途 |
| --- | --- |
| `https://localhost:10000/` | 查看和操作浏览器 |
| `ws://127.0.0.1:9999` | 插件连接 MCP Server |
| `http://127.0.0.1:9998/mcp` | 外部 HTTP MCP 客户端，使用独立 Bearer 令牌 |

### HTTPS 与远程访问

首次启动生成 `data/tls/selkies.crt` 和 `data/tls/selkies.key`，后续复用。可替换为受信任的证书链和私钥，证书 SAN 须包含实际访问的域名或 IP。

Selkies 网页认证默认关闭，可按下文启用，或通过认证反向代理、SSH 隧道限制访问。

### Selkies 网页登录密码

在 `docker/.env` 中配置：

```dotenv
SELKIES_ENABLE_BASIC_AUTH='true'
SELKIES_BASIC_AUTH_USER='admin'
SELKIES_BASIC_AUTH_PASSWORD='替换为你的独立登录密码'
```

三项一起启用，重新创建容器后生效。网页登录密码、配对密码和 HTTP Bearer 令牌相互独立。

### 多人或多个标签页访问

多个客户端打开同一地址时共享同一浏览器桌面；仅观看可使用 `https://localhost:10000/#shared`。

应用镜像包含 [Selkies 2.1.0 补丁](selkies-2.1.0.patch)，修复采集暂停后新连接停留在 `Waiting for stream...` 的问题。

### 浏览器桌面截图

Chromium、Selkies 和 MCP Server 共用 Xvfb 显示器 `:99`。MCP 通过 `scrot` 截取完整桌面，包含页面、浏览器栏和弹窗，原样返回图片字节；截图不依赖 Selkies 网页连接或视频编码。

Openbox 通过 [`openbox.xml`](openbox.xml) 将浏览器窗口设为无边框、最大化。逻辑桌面为 1920×1080，`PAGE_AGENT_DISPLAY_SCALE` 同时控制浏览器渲染密度和显示器物理尺寸。

在 `docker/.env` 中设置倍率，仅支持以下值；未设置或留空时使用 `2`，其他值启动报错。

| 值（渲染倍率） | 全屏截图物理尺寸 |
| --- | --- |
| `1` | 1920×1080 |
| `2`（默认） | 3840×2160 |
| `3` | 5760×3240 |

3 倍配置示例：

```dotenv
PAGE_AGENT_DISPLAY_SCALE='3'
```

修改倍率按[环境变量配置](#启用可选环境变量)生效；较高倍率会增加渲染和传输开销。旧镜像需先按[日常更新](#日常更新)升级。

外部 MCP 客户端通过 `POST` 工具截取全屏 PNG：

```json
{"uri":"/local/screenshot","body":{"format":"png"}}
```

结果包含 `width`、`height`、`format` 和 MCP `image` 内容块（Base64），最多 8 MiB、2000 万像素。图片超限时可缩小区域或使用 JPEG。

区域截图的 `region: {x,y,width,height}` 使用原图物理像素，坐标非负且区域须完全位于显示器内。`quality` 控制编码压缩，不改变分辨率；PNG 始终无损。模式、格式和延迟参数见 [MCP 桌面操作](../docs/Page-Agent-11-MCP服务.md#桌面操作)。

插件内使用 `/local/connections/{connectionId}/desktop/screenshot`，需启用连接的桌面权限。流程使用 `localScreenshot` 节点，定时截图由调度触发。

升级前不含 `scrot` 或 `openbox` 的镜像时，依次构建 `runtime`、`app` 并重新创建容器，具体命令见[依赖也发生变化时](#依赖也发生变化时)。

## 保留数据与迁移

**升级或迁移时，保留 `docker/.env` 和整个 `data/`。**

| 宿主机位置 | 容器内位置 | 用途 |
| --- | --- | --- |
| 当前项目根目录 | `/app` | 文件与 Bash 操作的默认工作目录 |
| 当前项目根目录下的 `data/` | `/data` | 认证、浏览器状态、证书和备份 |

文件和 Bash 操作在容器内执行，其他宿主机目录需显式挂载。服务以 UID/GID 1000 运行，启动时调整数据文件属主；每个容器须使用独立的 `data/`。

### 从旧目录布局迁移

1. 使用原 Compose 配置停止旧容器。
2. 将环境文件迁至 `docker/.env`，按示例合并配置。
3. 保留原 `data/`，在项目根目录按本文命令启动。

### 数据文件用途

```text
data/
  auth.json                       服务端身份与凭据校验信息
  audit/                          审计
  browser/                        Chromium 配置、插件本地存储和配对凭据
  browser.lock                    浏览器进程锁
  browser-cache/
    selkies/                      浏览器磁盘缓存
  browser-home/                   浏览器账户的主目录、下载与访问层缓存
  tls/
    selkies.crt                   Selkies HTTPS 证书
    selkies.key                   对应私钥
  builtin-connections.json         可选的额外连接配置
  archive/
    index.json                    备份桶、版本索引、客户端和操作状态
    <bucket>/<version>.json        不可变备份版本
```

## 添加额外连接

容器默认创建本机连接 `container-local`，用作同步源和备份目标。该 ID 保留；默认开放 ARP 读、写、删除权限，关闭执行权限，本地文件目录只读。

需要连接其他服务端时：

1. 将 [`docker/builtin-connections.example.json`](builtin-connections.example.json) 复制到 `data/builtin-connections.json`。
2. 填写地址、服务端配对密码和权限；远程连接使用 WSS。
3. 在 `docker/.env` 中设置 `PAGE_AGENT_BUILTIN_CONNECTIONS_FILE=/data/builtin-connections.json`，重新创建容器。

含真实密码的文件保存在 `data/`，不放入通用发布包。完成配对后，连接使用已保存的凭据。

| 连接选项 | 作用 |
| --- | --- |
| `autoSync: true` | 指定自动同步源；额外连接最多一条，替换本机同步源 |
| `backup: true` | 增加备份目标；可有多条，本机连接仍保留为备份目标 |
| `bucket` | 本机备份在此连接上的写入桶；单独填写不会开启同步或备份 |

`bucket` 用作初始备份桶；已有保存设置时，以「自动备份」中的配置为准。本机连接的初始桶为 `default`。

## 备份与同步

### 创建备份

1. 在「连接配置 → 自动备份」选择连接，保存桶名、开关、间隔和保留数量。
2. 点击「立即备份」。
3. 在「备份版本」中，将需要同步的版本标记为可同步。

各连接的备份策略独立；关闭自动备份后仍可手动备份。

桶名必填，默认 `default`；长度为 1–80 个字符，以英文字母或数字开头，仅允许英文字母、数字、`_`、`-`，禁用 `constructor`、`prototype`。

### 手动同步指定版本

1. 确认连接就绪、版本兼容、依赖和权限齐全。
2. 等待当前运行任务结束。
3. 选择已标记为可同步的版本，点击「同步所选版本」。

实际应用配置期间暂停其他任务。失败后在对应连接的「同步和备份日志」中重试；已部分写入时，须重试原操作后再切换同步源或备份目标。

### 容器启动时自动同步

启动自动同步仅适用于容器中的普通浏览器窗口。准备已标记为可同步的版本，在 `docker/.env` 中设置以下变量后重新创建容器。

| 变量 | 示例 | 用途 |
| --- | --- | --- |
| `PAGE_AGENT_AUTO_SYNC_BUCKET` | `shared-config` | 启动同步的读取桶，必须是所选版本所在的桶；不覆盖备份写入桶 |
| `PAGE_AGENT_AUTO_SYNC_VERSION` | `v000001` | 指定要加载的版本 |
| `PAGE_AGENT_AUTO_SYNC_ENABLED` | `true` | 默认开启；设为 `false` 可关闭 |

未指定版本时不执行启动同步，正常连接重连不重复同步。升级、回退或切换桶时修改目标并重新创建容器，保留 `data/`。

备份写入桶与同步读取桶独立配置。桶属于各自服务端，相同名称不表示同一个桶：

| 配置位置 | 方向 | 示例 |
| --- | --- | --- |
| `data/builtin-connections.json` 的 `connections[].bucket` | 本机配置 → 该连接服务端的备份桶 | `instance-backup` |
| `docker/.env` 的 `PAGE_AGENT_AUTO_SYNC_BUCKET` | 同步源服务端的版本 → 本机配置 | `shared-config` |

例如，额外连接设置 `autoSync: true`、`backup: true`、`bucket: "instance-backup"`，读取该服务端已标记可同步的 `shared-config/v000001`：

```dotenv
PAGE_AGENT_BUILTIN_CONNECTIONS_FILE=/data/builtin-connections.json
PAGE_AGENT_AUTO_SYNC_BUCKET=shared-config
PAGE_AGENT_AUTO_SYNC_VERSION=v000001
PAGE_AGENT_AUTO_SYNC_ENABLED=true
```

启动读取远端 `shared-config/v000001`，自动、手动及同步前的保护备份写入远端 `instance-backup`；本机连接备份到本机 `default` 桶。

未指定读取桶时，依次使用同步源连接文件的 `bucket`、`default`。未指定额外同步源时，使用容器本机服务端。

### 同步日志与旧备份

| 位置 | 内容 |
| --- | --- |
| 连接配置 → 自动同步 → 同步源日志 | 所选同步源的结果、错误和告警 |
| 自动备份 → 选择连接 → 同步和备份日志 | 连接操作、实际桶名及失败重试入口 `Retry` |
| 服务端标准输出 | 开始、完成、失败和告警，包含客户端、桶、版本及操作 ID；远端同步源需查看远端日志 |

`archive/index.json` 中，`operations` 记录操作，`buckets.*.versions` 记录备份版本。同一客户端内容未变化时复用版本，同一启动目标失败时复用失败操作记录。

当前同步协议为 7，插件与 MCP Server 需匹配，旧格式 7 备份仍可读取。旧备份缺少 Skill 或 HTTP MCP 配置时，保留本机对应配置，跳过缺失引用并告警；完整恢复需在来源端升级后重新备份、标记可同步，再更新启动版本。

### 权限与数据影响

| 操作 | 所需 ARP 权限 |
| --- | --- |
| 备份 | 读取 |
| 同步 | 读取、写入；有删除权限时清理多余配置，无删除权限时保留并告警 |

| 数据 | 同步或备份行为 |
| --- | --- |
| 本地配置 | 同步前先保存备份，再替换；具有删除权限时清理所选版本之外的可写配置 |
| 自定义 Skill（含导入的 Skill） | 备份正文、附属资源、状态及标签；恢复后映射助手引用 |
| HTTP MCP 服务器配置 | 备份名称、地址、启用状态、Bearer Token、Header、Cookie 使用开关、超时和协议版本；恢复后映射助手引用 |
| 内置只读资源、话题、消息、附件、运行报告 | 同步时保留 |
| 模型 API Key、模型认证 Headers、MCP 连接配对身份、浏览器 Cookie 内容、应用和普通知识库内容 | 不进入配置备份 |

工具目录和连接会话不进入备份；恢复后可在 HTTP MCP 页面刷新工具目录。模型密钥通过 `.env` 单独注入。配置备份不能代替整个 `data/` 的备份。

配置备份为明文 JSON，包含 HTTP MCP 令牌和 Header，版本文件权限为 `0600`。`data/` 和实际 `.env` 已排除在 Git、发布包和构建上下文之外，手动复制时仍包含凭据。

服务端自动生成的配对密码和 HTTP Bearer 令牌会写入启动日志；容器配对密码由 `.env` 提供，HTTP 令牌可通过 `PAGE_AGENT_HTTP_BEARER_TOKEN` 显式设置。Bash 审计默认记录命令原文，含参数中的密钥；`--audit-command-content hash` 可改为只保存摘要。

## 构建问题与参考

### 提示项目文件缺失

```text
Project root must contain manifest.json and MCP server source or bundle: <项目根目录>
```

项目根目录须包含 `manifest.json`，以及源码 `mcp-server/index.js` 或发布文件 `mcp-server/page-agent-mcp-server.cjs`。

### 源码与 release 如何构建

| 项目内容 | 镜像构建方式 |
| --- | --- |
| 源码工作区 | 复制当前插件代码，在 Docker 构建阶段生成 MCP Server 单文件 |
| release 解压目录 | 复制当前插件代码，直接使用包内已有的 MCP Server 单文件 |

源码的 MCP 构建依赖和中间产物仅保留在构建阶段。也可指定 release 目录构建：

```bash
./docker/build.sh app ./dist/page-agent-extension-1.2.2
```

相对路径以当前执行目录为基准，构建时打印实际使用的目录。

### 构建参数

| 参数或规则 | 行为 |
| --- | --- |
| 不传构建层 | 默认构建 `app` |
| `all` | 按顺序构建 `base`、`browser`、`runtime`、`app` |
| 应用构建目录 | `app`、`all` 支持第二个参数指定目录；默认是构建脚本所在 `docker/` 的上一级，应用代码与启动脚本均从该目录读取 |
| Dockerfile 来源 | 始终使用构建脚本所在目录中的文件 |
| 构建 `runtime` | 复用已有 `browser` 镜像，缺少时自动构建 |

### 镜像分层

按下表顺序构建：

| 层 | 默认镜像 | 内容 |
| --- | --- | --- |
| `base` | `page-agent-base:latest` | Ubuntu 与基础工具 |
| `browser` | `page-agent-browser:latest` | Node.js 与 Chromium |
| `runtime` | `page-agent-runtime:latest` | Selkies 运行环境 |
| `app` | `page-agent:latest` | 插件、MCP Server 与启动脚本 |

### `docker/` 文件用途

```text
docker/
  build.sh                    分层镜像构建入口
  compose.yaml                容器部署配置
  .env.example                环境变量用途、默认值与配置示例
  base.Dockerfile             操作系统与基础工具
  browser.Dockerfile          Node.js 与 Chromium
  runtime.Dockerfile          Selkies 运行环境
  Dockerfile                  Page Agent 应用镜像
  .dockerignore               基础层构建上下文过滤
  Dockerfile.dockerignore      应用镜像构建上下文过滤
  start.cjs                   容器启动入口
  selkies.cjs                 浏览器显示服务
  openbox.xml                 浏览器窗口规则
  selkies-2.1.0.patch          Selkies 共享连接修复
  builtin-connections.example.json  额外连接示例
```
