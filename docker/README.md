# Docker 部署、更新与备份

每个容器运行 MCP Server、Chromium 和 Page Agent 插件，通过 Selkies 查看和操作浏览器。

**所有命令都在项目根目录执行，即包含 `docker/` 的目录。**

- 开发时：使用当前工作区根目录。
- 发布后：使用 release 解压后的根目录。
- 两种目录使用相同命令，直接构建各自目录中的代码。

| 你要找的内容 | 位置 |
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

源码工作区和 release 解压目录都执行：

```bash
./docker/build.sh all
```

宿主机需要 Docker（含 Compose）和 Bash，无需安装 Node.js，也无需先生成发布包。

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

修改工作区代码或更新 release 文件后，在该项目根目录执行。保留原有的 `docker/.env` 和 `data/`。

```bash
./docker/build.sh app

docker compose --env-file ./docker/.env -f ./docker/compose.yaml \
  up -d --no-build --force-recreate
```

### 依赖也发生变化时

| 修改了什么 | 按顺序构建哪些层 |
| --- | --- |
| 插件、MCP Server、启动脚本 | `app` |
| Selkies 依赖 | `runtime` → `app` |
| Node.js、Chromium | `browser` → `runtime` → `app` |
| Ubuntu 或基础工具 | `all` |
| 环境变量 | 无需构建，重新创建容器 |

- 每层使用 `./docker/build.sh <构建层>` 执行。
- 构建完成后，执行上面的 `up --force-recreate` 命令。

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

**应用新镜像或新环境变量：** `restart` 不会加载这些变更，使用：

```bash
docker compose --env-file ./docker/.env -f ./docker/compose.yaml \
  up -d --no-build --force-recreate
```

## 修改配置

变量用途、默认值和示例见 [`docker/.env.example`](.env.example)。

### 启用可选环境变量

Compose 通过服务级 `env_file: .env` 将 `docker/.env` 中已启用的变量传入容器，包括配对密码、名称、HTTP 令牌、Selkies 登录认证、画面编码、启动同步、内置连接文件和模型密钥。

1. 在 `docker/.env` 中填写对应变量。
2. 按[常用操作](#常用操作)重新创建容器，无需构建镜像。

命令行 `--env-file ./docker/.env` 为 Compose 中的镜像名等变量提供插值；服务级 `env_file` 负责传入容器变量，其路径相对于 `docker/compose.yaml`。运行配置直接修改 `docker/.env` 即可，无需逐项添加 `environment` 映射。

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

- 首次启动生成 `data/tls/selkies.crt` 和 `data/tls/selkies.key`，后续复用。
- 可替换为受信任的证书链和私钥。
- 通过域名或局域网 IP 访问时，证书 SAN 必须包含实际地址。
- Selkies 网页登录认证默认关闭；可按下文启用，也可使用已有认证反向代理或 SSH 隧道限制访问。

### Selkies 网页登录密码

在 `docker/.env` 中配置：

```dotenv
SELKIES_ENABLE_BASIC_AUTH='true'
SELKIES_BASIC_AUTH_USER='admin'
SELKIES_BASIC_AUTH_PASSWORD='替换为你的独立登录密码'
```

三项一起启用，用户名和密码均需填写。重新创建容器后，打开 Selkies 页面时使用上述用户名和密码登录。
此密码与 `PAGE_AGENT_PAIRING_PASSWORD`、`PAGE_AGENT_HTTP_BEARER_TOKEN` 独立；修改它不会改变浏览器配对或 MCP 认证。

### 多人或多个标签页访问

直接打开同一地址即可共同查看和操作同一个浏览器；只需观看时使用 `https://localhost:10000/#shared`。它们共享同一桌面，不是独立浏览器会话。

Selkies 2.1.0 的普通共享连接有一处停流恢复遗漏：首个标签进入后台并暂停采集后，新页面加入时仅请求关键帧，没有恢复采集，会停在 `Waiting for stream...`。
应用镜像通过 [`selkies-2.1.0.patch`](selkies-2.1.0.patch) 在该分支调用已有的恢复采集逻辑。按[日常更新](#日常更新)重建 `app` 镜像并重新创建容器即可应用。

## 保留数据与迁移

**升级或迁移时，保留 `docker/.env` 和整个 `data/`。**

| 宿主机位置 | 容器内位置 | 用途 |
| --- | --- | --- |
| 当前项目根目录 | `/app` | 文件与 Bash 操作的默认工作目录 |
| 当前项目根目录下的 `data/` | `/data` | 认证、浏览器状态、证书和备份 |

- 插件和 MCP Server 从构建好的镜像加载。
- 文件和 Bash 操作在容器内执行；其他宿主机目录需要显式挂载。
- 服务以 UID/GID 1000 运行，启动时会调整数据文件属主。
- 同一份 `data/` 不要同时给两个容器使用。

### 从旧目录布局迁移

1. 使用原 Compose 配置停止旧容器。
2. 将环境文件迁至 `docker/.env`，按示例合并配置。
3. 保留原 `data/`，在项目根目录按本文命令启动。

### 数据文件用途

```text
data/
  auth.json                       服务端身份与凭据校验信息（沿用现有文件）
  audit/                          审计
  browser/                        Chromium 配置、插件本地存储和配对凭据
  browser.lock                    容器浏览器进程锁，避免并发使用同一份数据
  browser-cache/
    selkies/                      浏览器磁盘缓存
  browser-home/                   浏览器账户的主目录、下载与访问层缓存
  tls/
    selkies.crt                   Selkies HTTPS 证书
    selkies.key                   对应私钥
  builtin-connections.json         可选：额外连接配置，由你提供
  archive/
    index.json                    备份桶、版本索引、客户端和操作状态
    <bucket>/<version>.json        不可变备份版本
```

## 添加额外连接

容器默认创建本机连接 `container-local`，作为自动同步源和备份目标。

- `container-local` 是保留 ID，不能用于额外连接。
- 默认开放 ARP 读、写、删除权限，关闭执行权限。
- 默认本地文件目录只读。

需要连接其他服务端时：

1. 将 [`docker/builtin-connections.example.json`](builtin-connections.example.json) 复制到 `data/builtin-connections.json`。
2. 填写地址、服务端配对密码和权限；远程连接使用 WSS。
3. 按[启用可选环境变量](#启用可选环境变量)设置 `PAGE_AGENT_BUILTIN_CONNECTIONS_FILE=/data/builtin-connections.json`。
4. 重新创建容器。

含真实密码的文件保存在 `data/`，不放入通用发布包。完成配对后，连接使用已保存的凭据。

| 连接选项 | 作用 |
| --- | --- |
| `autoSync: true` | 指定自动同步源；额外连接最多一条，替换本机同步源 |
| `backup: true` | 增加备份目标；可有多条，本机连接仍保留为备份目标 |
| `bucket` | 本机备份在此连接上的写入桶；单独填写不会开启同步或备份 |

连接文件中的 `bucket` 是初始备份设置；插件已有保存的备份设置时，以「自动备份」中显示的桶为准，可在该界面修改。容器本机连接的初始备份桶为 `default`。

## 备份与同步

### 创建备份

1. 打开「连接配置 → 自动备份」，选择备份连接。
2. 保存桶名、自动备份开关、间隔和保留数量。
3. 点击「立即备份」。
4. 在「备份版本」中，将需要同步的版本标记为可同步。

各连接的备份策略独立；关闭自动备份后仍可手动备份。

| 桶名要求 | 规则 |
| --- | --- |
| 是否必填 | 必填，默认 `default`，例如 `project-a` |
| 长度 | 1–80 个字符 |
| 字符 | 以英文字母或数字开头，仅允许英文字母、数字、`_`、`-` |
| 禁用名称 | `constructor`、`prototype`；不支持中文桶名 |

### 手动同步指定版本

1. 确认连接就绪、版本兼容、依赖和权限齐全。
2. 等待当前运行任务结束，同步期间暂缓自动任务。
3. 选择已标记为可同步的版本，点击「同步所选版本」。

失败后在对应连接的「同步和备份日志」中重试。仅在实际应用配置期间暂停其他任务；等待连接、缺失依赖或同步失败不会持续阻断任务。已经部分写入的操作保留恢复状态，需要重试原操作后再切换同步源或备份目标。

### 容器启动时自动同步

所有环境支持手动同步和备份；启动自动同步仅适用于容器中的普通浏览器窗口。

1. 准备已标记为可同步的备份版本。
2. 在 `docker/.env` 中设置以下变量。
3. 重新创建容器。

| 变量 | 示例 | 用途 |
| --- | --- | --- |
| `PAGE_AGENT_AUTO_SYNC_BUCKET` | `shared-config` | 启动同步的读取桶，必须是所选版本所在的桶；不覆盖备份写入桶 |
| `PAGE_AGENT_AUTO_SYNC_VERSION` | `v000001` | 指定要加载的版本 |
| `PAGE_AGENT_AUTO_SYNC_ENABLED` | `true` | 默认开启；设为 `false` 可关闭 |

启动同步的环境变量统一使用 `PAGE_AGENT_AUTO_SYNC_*`。已有部署升级时，请将桶名和版本的变量名更新为上表中的名称；旧名称不再读取。

- 未指定版本：不执行启动同步，也不会自动选择最新版本。
- 每次启动：按设置管理同步源、桶名、版本和开关。
- 正常连接重连：不会重复同步。
- 升级、回退或切换桶：修改目标并重新创建容器，保留原 `data/`。

两个桶**不要求相同**。桶属于服务端，相同桶名在不同服务端也不是同一个桶：

| 配置位置 | 方向 | 示例 |
| --- | --- | --- |
| `data/builtin-connections.json` 的 `connections[].bucket` | 本机配置 → 该连接服务端的备份桶 | `instance-backup` |
| `docker/.env` 的 `PAGE_AGENT_AUTO_SYNC_BUCKET` | 同步源服务端的版本 → 本机配置 | `shared-config` |

例如来源实例已在配置服务端的 `shared-config` 桶创建 `v000001` 并标记可同步。容器的额外连接指向该服务端，设置 `autoSync: true`、`backup: true`、`bucket: "instance-backup"`；在 `.env` 中填写：

```dotenv
PAGE_AGENT_BUILTIN_CONNECTIONS_FILE=/data/builtin-connections.json
PAGE_AGENT_AUTO_SYNC_BUCKET=shared-config
PAGE_AGENT_AUTO_SYNC_VERSION=v000001
PAGE_AGENT_AUTO_SYNC_ENABLED=true
```

启动时读取该远端的 `shared-config/v000001`；定时备份、手动备份、同步前的保护备份写入远端 `instance-backup`。容器本机连接仍单独备份到本机的 `default` 桶。如果希望读写同一个桶，两处都填 `shared-config` 即可。未填写 `PAGE_AGENT_AUTO_SYNC_BUCKET` 时，沿用同步源连接文件的 `bucket`，再未填写则用 `default`；建议显式填写以免混淆。未设置额外连接的 `autoSync: true` 时，同步源是容器本机服务端。

### 同步日志与旧备份

- 「连接配置 → 自动同步 → 同步源日志」直接显示所选同步源的同步结果、错误全文和告警，不依赖当前选中的备份连接或备份桶。
- 「自动备份 → 选择连接 → 同步和备份日志」显示此连接的操作及实际桶名，失败操作可点 `Retry`。错误不会只藏在 `index.json` 中。
- 服务端标准输出记录开始、完成、失败和告警，包含客户端、桶、版本、操作 ID 和错误信息。容器部署可查看 `docker compose --env-file ./docker/.env -f ./docker/compose.yaml logs -f page-agent`；同步源在远端时，查看远端服务端的日志。
- `archive/index.json` 是一个持久化索引；其中 `operations` 是操作记录，`buckets.*.versions` 才是备份版本。同一客户端内容不变时复用备份版本；同一启动目标反复失败时复用失败操作，避免每次重启新增相同错误记录。成功的实际同步仍记录操作。
- 旧版本遗漏的 Skill 和 HTTP MCP 服务器配置无法从索引补回。请在配置完整的来源端升级后重新备份，将新版本标记可同步，再更新 `PAGE_AGENT_AUTO_SYNC_VERSION`。读取缺少这些模块的旧备份时保留本机对应配置，跳过缺失的助手 Skill/MCP 引用并显示告警。
- 当前同步协议为 7，插件和对应 MCP Server 都需更新；旧的格式 7 备份仍可读取。

### 权限与数据影响

| 操作 | 所需 ARP 权限 |
| --- | --- |
| 备份 | 读取 |
| 同步 | 读取、写入；有删除权限时清理多余配置，无删除权限时保留并告警 |

| 数据 | 同步或备份行为 |
| --- | --- |
| 本地配置 | 同步前先保存备份，再替换；具有删除权限时清理所选版本之外的可写配置 |
| 自定义 Skill（含导入的 Skill） | 备份正文、附属资源全文、状态及标签；先恢复 Skill，再恢复助手并映射引用 ID |
| HTTP MCP 服务器配置 | 备份名称、地址、启用状态、Bearer Token、自定义 Header、浏览器 Cookie 使用开关、超时和协议版本；先恢复服务器，再恢复助手并映射引用 ID |
| 内置只读资源、话题、消息、附件、运行报告 | 同步时保留 |
| 模型 API Key、模型认证 Headers、MCP 连接配对身份、浏览器 Cookie 内容、应用和普通知识库内容 | 不进入配置备份 |

HTTP MCP 的认证字段与手动完整备份保持一致，会写入配置备份。工具目录和连接会话属于运行缓存，不随配置备份；新恢复的服务器可在 HTTP MCP 页面刷新工具目录。模型密钥可按 `docker/.env.example` 单独注入。配置备份不能代替整个 `data/` 的备份。

配置备份是明文 JSON，HTTP MCP 的令牌和 Header 值也在其中；服务端新写入的版本文件权限为 `0600`。`data/` 和实际使用的 `.env` 文件已从 Git、扩展发布包和 Docker 构建上下文中排除，但手动复制、上传这些文件仍会带出凭据。服务端首次自动生成的配对密码和 HTTP Bearer 令牌会进入启动日志；容器配对密码由 `.env` 提供，HTTP 令牌也可通过 `PAGE_AGENT_HTTP_BEARER_TOKEN` 显式提供，避免自动生成时打印明文。Bash 审计默认保存命令原文，命令参数中的密钥也会被记录；服务端可使用 `--audit-command-content hash` 只保存摘要。

## 构建问题与参考

### 提示项目文件缺失

```text
Project root must contain manifest.json and MCP server source or bundle: <项目根目录>
```

- 检查项目根目录是否有 `manifest.json`。
- 源码工作区应有 `mcp-server/index.js`。
- release 解压目录应有 `mcp-server/page-agent-mcp-server.cjs`。

### 源码与 release 如何构建

| 项目内容 | 镜像构建方式 |
| --- | --- |
| 源码工作区 | 复制当前插件代码，在 Docker 构建阶段生成 MCP Server 单文件 |
| release 解压目录 | 复制当前插件代码，直接使用包内已有的 MCP Server 单文件 |

源码构建会在 Docker 内安装 MCP 构建依赖。开发依赖和中间产物不会复制到最终镜像。

在源码工作区中，也可以指定已打包的 release 目录，用于验证发布产物：

```bash
./docker/build.sh app ./dist/page-agent-extension-1.2.1
```

第二个参数是应用构建目录，相对路径以执行命令时的当前目录为基准。插件、MCP Server 和容器启动脚本均从该目录复制；release 中已有的 MCP Server 单文件会直接复用。构建时会打印实际使用的目录。

### 构建参数

| 参数或规则 | 行为 |
| --- | --- |
| 不传构建层 | 默认构建 `app` |
| `app [project-dir]` | 使用指定目录构建应用镜像；省略目录时使用本项目代码 |
| `all` | 按顺序构建 `base`、`browser`、`runtime`、`app` |
| 应用构建目录 | 默认是脚本所在 `docker/` 目录的上一级；`app`、`all` 支持第二个参数指定目录 |
| Dockerfile 来源 | 始终使用构建脚本所在目录中的文件 |
| 构建 `runtime` | 复用已有 `browser` 镜像，缺少时自动构建 |

### 镜像分层

依赖顺序：`base` → `browser` → `runtime` → `app`。

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
  builtin-connections.example.json
  README.md
```
