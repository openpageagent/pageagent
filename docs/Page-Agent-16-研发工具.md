# 研发工具

PostgreSQL、MySQL、Jira、Confluence、Jenkins、Redis、GitLab、SSH、S3 通过 MCP Server 连接已有服务，供助手、脚本、流程和应用调用。扩展内置插件默认启用，直接 HTTP MCP 调用无需浏览器在线。依赖许可见[第三方声明](../THIRD_PARTY_NOTICES.md)。

## 配置连接

使用 HTTP 令牌登录服务端 `/config`，在「研发工具 → 添加连接」中选择连接类型，填写连接名称和参数。所有类型均为可选，支持多个连接，总计最多 50 个。保存只校验格式，测试或调用时才连接远端，地址以 MCP Server 所在机器为准。

连接支持 JSON 导入、导出，包含配置和明文凭据。导入按 ID 合并，恢复启用状态与操作权限，仅保留当前服务器有效的客户端授权。

「测试连接」使用当前表单配置，无需保存或启用；凭据留空沿用已保存的值。

| 工具 | 连接测试范围 |
| --- | --- |
| PostgreSQL / MySQL | 只读 `SELECT 1` |
| Redis | `PING`，需对应 ACL 权限 |
| Jira / Confluence / Jenkins / GitLab | 验证当前登录身份，需身份查询权限 |
| S3 | `HeadBucket` 检查桶访问，AWS 通常需 `s3:ListBucket` 权限 |
| SSH | 验证主机指纹和账号认证，不执行命令 |

| 工具 | 连接与认证 |
| --- | --- |
| PostgreSQL / MySQL | 主机、端口、数据库、用户和密码，默认端口分别为 `5432` / `3306`；按需启用 TLS 和自定义 CA |
| Jira | 选择 Cloud / Data Center；Cloud 通常为 `https://站点.atlassian.net`，Data Center 包含部署路径。支持 Basic 用户名 / 邮箱 + Token 或 Bearer Token |
| Confluence | 选择 Cloud / Data Center；Cloud 地址通常以 `/wiki` 结尾，Data Center 包含部署路径。认证方式与 Jira 相同，API 路径分别处理 |
| Jenkins | 服务地址、用户名和 API Token，包含部署路径；不使用登录密码，依赖 API Token 的 CSRF crumb 豁免 |
| Redis | 主机、端口、数据库编号，可选 ACL 用户名、密码、TLS 和 CA；支持单节点连接 |
| GitLab | 服务地址不含末尾 `/api/v4`，使用 `PRIVATE-TOKEN`；权限同时受 Token scope 和项目角色约束 |
| SSH | 主机、端口、用户、可信来源的主机密钥 `SHA256:...` 指纹；密码或 PEM / OpenSSH 私钥，可填私钥口令，同时填写时优先私钥 |
| S3 对象存储 | 支持 Amazon S3、MinIO 等兼容服务。填写区域、桶和访问密钥，可选 Session Token；AWS 可留空 Endpoint，MinIO 等填写 S3 API 地址，按需开启 Path-style |

Atlassian scoped Token 可能需要官方网关基址；私有 CA 使用 PEM。S3 每个连接固定一个桶，SSH 不读取系统 SSH config 或 Agent。

「启用连接」控制是否允许调用；操作授权按工具区分，如数据库写入、S3 上传／删除对象、SSH 执行命令。

操作契约向模型提供删除确认约定：已有权限内可读取、新增和修改；删除、清空及脚本间接删除须先说明目标和风险，征得用户确认。用户已明确授权的删除无需重复确认；开启写入或执行权限不等于授权删除。

配置页显示删除风险提示。此约定由模型遵守，服务端不提供逐次确认拦截，脚本、流程和直接工具调用需自行控制。

浏览器调用统一使用“插件”模块的 `plugins.execute`，还需启用对应插件并授予客户端连接权限。HTTP MCP 可使用全部已启用连接；两种入口均受连接操作授权及远端账号权限限制。

连接保存在状态目录 `devtools-connections.json`，文件权限为 `0600`，未额外加密。编辑时凭据不回显，留空保留旧值，开启清除开关可删除。扩展备份不包含服务端连接。

## 基础能力与调用

| 插件 ID | 查询能力 | 写入能力 |
| --- | --- | --- |
| `postgres` | `connections`、`status`、`query` | `execute` |
| `mysql` | `connections`、`query` | `execute` |
| `jira` | `search`、`issue`、`transitions` | `create-issue`、`comment`、`transition` |
| `confluence` | `search`、`page` | `create-page`、`update-page` |
| `jenkins` | `jobs`、`build`、`log`、`queue` | `trigger` |
| `redis` | `scan`、`get`、`hash`、`info` | `set`、`delete` |
| `gitlab` | `projects`、`merge-requests`、`merge-request`、`pipelines`、`pipeline`、`pipeline-jobs`、`job-log` | `create-merge-request`、`run-pipeline` |
| `ssh` | 无；所有命令按写操作授权 | `exec` |
| `s3` | `list`、`get` | `put`、`delete` |

各插件通过 `connections` 列出获授权的连接。`connectionId` 是浏览器配对的 MCP 连接 ID，`profileId` 是研发工具连接 ID，可从配置页或 `connections` 获取。

| 入口 | 调用方式 |
| --- | --- |
| 助手 | 根据插件能力合同选择操作，使用获授权的连接 |
| 脚本 / 应用 | `api.plugins.call('mysql', 'query', input)` / `PageAgent.plugins.call('mysql', 'query', input)` |
| 流程 | `plugin.mysql.query` 等节点，参数放入 `input` |
| 浏览器 ARP | `GET /plugin-mysql/capabilities/query` 读取合同，`POST` 执行 |
| 直接 MCP | `GET /devtools?kind=postgres` 发现连接，`POST /devtools/postgres/query` 等路径执行，正文包含 `profileId`；其他工具替换类型和操作 |

具体参数通过对应路径的 `OPTIONS` 查询。直接 MCP 不需要 `connectionId`，资源路径填入通用工具的 `uri`。查询能力也可在工具箱调用。

```js
const response = await api.plugins.call('mysql', 'query', {
  connectionId: 'MCP 连接 ID',
  profileId: 'MySQL 连接 ID',
  sql: 'SELECT id, title FROM tickets WHERE status = ? LIMIT 20',
  params: ['open'],
});
return response.result;
```

`/devtools` 业务操作返回 `{ result, auditRecorded }`，连接目录返回 `{ items }`。PostgreSQL 插件及 `/postgres/query`、`/postgres/execute` 直接返回查询结果和 `auditRecorded`；`GET /postgres?profileId=连接ID` 读取连接状态。

## 数据库操作

每次执行单条参数化 SQL。PostgreSQL 使用 `$1`、`$2`，MySQL 使用 `?`；占位符只代替值，表名和列名写入 SQL。MySQL JSON 参数以字符串传入。

`query` 使用只读事务。MySQL 查询支持 `SELECT`、`SHOW`、`DESCRIBE`、`EXPLAIN`、`WITH`；`execute` 支持 `INSERT`、`UPDATE`、`DELETE`、`REPLACE`、`WITH`，不开放 CALL、DDL、事务或会话管理语句。

结果包含 `columns`、数组 `rows`、`rowCount` 和 `truncated`；MySQL 另含 `affectedRows`、`insertId`、`warningCount`，PostgreSQL 另含 `command`。大整数和精确小数可能为字符串；MySQL 日期及 JSON 列也保留为字符串。

默认最多返回 100 行，`maxRows` 可设为 1–1000，行数据最多 1 MiB；实际查询或修改范围由 SQL 限定。每次使用独立连接和事务，不支持跨调用事务或批量 SQL；MySQL 非事务表不能保证回滚。

## 研发工具约定

| 工具 | 行为说明 |
| --- | --- |
| Jira | JQL 搜索，Cloud 用 `nextPageToken` 分页，Data Center 用 `startAt`。先查询 `transitions` 再按 ID 流转；建单和流转不支持额外自定义必填字段 |
| Confluence | CQL 搜索，Cloud 将 `nextCursor` 传为 `cursor`，Data Center 将 `nextStart` 传为 `start`。正文用 storage HTML；创建使用 Cloud `spaceId` / Data Center `spaceKey`，更新需当前版本号 + 1 |
| Jenkins | 任务路径为 `team/backend`。触发返回队列 ID，经 `queue` 获取构建号后查 `build`；接受请求不代表构建成功。日志以 `nextStart` 继续读取 |
| Redis | SCAN / HSCAN 遍历至游标 `"0"`，COUNT 仅是提示，结果可能重复。SET 省略 TTL 会清除旧过期时间；删除仅针对单键，值按 UTF-8 处理 |
| GitLab | 项目使用 ID 字符串或 `group/project`，列表以 `nextPage` 分页。触发流水线后另查状态；作业日志只返回前 64 KiB |
| SSH | 返回退出码、信号和标准输出，需检查退出码。每次独立连接，无交互终端；取消不保证终止远端子进程 |
| S3 | 列表以 `nextContinuationToken` 分页；对象读写最多 1 MiB，二进制使用 base64。上传默认拒绝覆盖，覆盖需 `overwrite: true`；指定版本删除可能永久删除该版本 |

## 执行与限制

研发工具合计最多 8 个并发，超时默认 30 秒，可设为 1–120 秒。PostgreSQL 连接超时为 5 秒、语句超时为 15 秒。HTTP JSON 响应最多 1 MiB，日志最多 64 KiB，最终结果最多 2 MiB。

写入不自动重试，`performed: unknown` 时先核对远端状态。ARP 幂等缓存约 60 秒，重启后失效。修改或停用连接对后续调用生效，已发出的操作可能继续完成。

审计不保存 SQL、命令和参数原文，`auditRecorded: false` 表示结果审计未写入。跨系统操作没有共同事务，当前不支持 Redis Cluster / Sentinel、任意 Redis 命令和 SSH 文件传输。
