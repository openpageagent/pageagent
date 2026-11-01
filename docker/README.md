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

Compose 通过服务级 `env_file: .env` 将 `docker/.env` 中已启用的变量传入容器，包括配对密码、名称、HTTP 令牌、画面编码、启动同步、内置连接文件和模型密钥。

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
- Selkies 没有独立网页登录密码；访问范围由 Compose 的 `ports` 绑定决定。
- 需要限制远程访问时，使用已有认证反向代理或 SSH 隧道。

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
| `bucket` | 指定桶名；单独填写不会开启同步或备份 |

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

失败后在日志中重试；原操作完成前，不要切换同步源或桶。

### 容器启动时自动同步

所有环境支持手动同步和备份；启动自动同步仅适用于容器中的普通浏览器窗口。

1. 准备已标记为可同步的备份版本。
2. 在 `docker/.env` 中设置以下变量。
3. 重新创建容器。

| 变量 | 示例 | 用途 |
| --- | --- | --- |
| `PAGE_AGENT_BUCKET` | `project-a` | 与备份版本所在桶一致 |
| `PAGE_AGENT_SYNC_VERSION` | `v000002` | 指定要加载的版本 |
| `PAGE_AGENT_AUTO_SYNC_ENABLED` | `true` | 默认开启；设为 `false` 可关闭 |

- 未指定版本：不执行启动同步，也不会自动选择最新版本。
- 每次启动：按设置管理同步源、桶名、版本和开关。
- 正常连接重连：不会重复同步。
- 升级、回退或切换桶：修改目标并重新创建容器，保留原 `data/`。

### 权限与数据影响

| 操作 | 所需 ARP 权限 |
| --- | --- |
| 备份 | 读取 |
| 同步 | 读取、写入；删除配置时还需删除权限 |

| 数据 | 同步或备份行为 |
| --- | --- |
| 本地配置 | 同步前先保存备份，再替换；所选版本中不存在的本地配置会被删除 |
| 内置只读资源、话题、消息、附件、运行报告 | 同步时保留 |
| 模型 API Key、自定义认证 Headers、连接身份、应用和知识库内容 | 不进入配置备份 |

模型密钥可按 `docker/.env.example` 单独注入。配置备份不能代替整个 `data/` 的备份。

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
./docker/build.sh app ./dist/page-agent-extension-1.2.0
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
