# Page Agent 知识系统

Knowledge 保存可跨任务复用的产品知识、方法和外部工具说明。页面状态、运行结果和接口参数分别从页面资源、运行资源和当前资源契约获取。

## 来源

| 层 | 来源 | 内容 |
| --- | --- | --- |
| P1 builtin | 仓库内置知识 | 产品概念和通用方法 |
| P2 auto | 用户或 Agent 保存 | 可复用知识与经验 |
| P3 mcp | 外部 MCP 工具目录 | 外部服务说明 |
| P4 skill | 内置或导入的 Skill | 方法正文与参考资料 |

来源层次用于相关性接近时的排序。

## 查询与维护

对话按需显式读取知识：先查询候选条目，再按 ID 读取正文。

```text
GET /knowledge
GET /knowledge?mode=relevance&q=登录
GET /knowledge?mode=grep&q=登录&context=2
GET /knowledge/{knowledgeId}
```

普通条目的 GET 返回正文；声明 `retrieval: "grep"` 的大条目返回说明与带行号目录，正文通过集合的 grep 查询读取。

用户可在配置中心维护知识，Agent 可通过 `POST /knowledge` 保存已验证、可跨任务复用的内容。

运行时不会在每轮对话结束后自动发起知识保存请求。

## Skill

每个 Skill 对应一条知识记录，包含 `SKILL.md` 正文和可读文本资源。

内置 Skill 在启动时同步为只读 P4；用户可在配置中心导入 Skill。

二进制文件不导入，脚本仅作为参考文本保存。已知 ID 时可直接读取 `/skills/{skillId}`。

知识库、Skill 列表和导入预览默认每页 50 项，可选 25、50 或 100 项。导入目录的勾选包含未展开或未显示在本页的子项。

## MCP 知识

外部 HTTP MCP 服务器通过 `/mcp-servers` 管理，`tools/list` 结果保存为 P3。Page Agent 直连服务端使用独立的 `/connections` 配置，见 [MCP 服务](./Page-Agent-11-MCP服务.md)。

P3 按“连接 ID + 工具名”保存工具说明与查询入口。同步按连接整批更新，内容未变的条目不重写，已移除的工具归档。各连接的数据范围和权限独立。

完整工具定义和服务器说明从对应 MCP 资源按需读取。

调用外部 MCP 工具时，先读取工具定义与当前 `schemaHash`：

```text
GET /mcp-servers/{serverId}/tools/{toolName}
POST /mcp-servers/{serverId}/tools/{toolName}/calls
```

调用请求的 body 包含 `arguments` 和当前 `schemaHash`。调用异步执行，通过回执中的 `operationUri` 查询状态与结果。

插件内对话需在当前助手中选择对应 MCP。上下文预载服务器说明、工具名称与说明，以及定义和调用地址；参数结构按需读取。名称和说明完全相同的工具共用说明，各连接保留独立入口。

搜索和显式读取结果中的重复 MCP 说明或参数结构，可在模型上下文中引用已保留的相同内容。原始结果及各连接的标识保留，引用规则见[提示词缓存](./Page-Agent-07-提示词缓存.md#请求结构)。

外部 Agent 可通过 Page Agent MCP Server 复用插件保存的 HTTP MCP 配置与认证。先 `GET /clients` 选择目标，再通过 `POST /clients/{clientId}/arp` 转发 `GET /mcp-servers`、工具查询、调用及结果查询。

插件须在线，连接开放读取和执行权限，目标 HTTP MCP 已启用并同步工具。MCP 工具说明包含发现和调用路径，无需重复配置上游 MCP。

P3 内容由工具同步维护，在配置页只读。需要补充使用经验时，可另存为 P2 知识。

## 应用生成知识

`builtin_app_generation_guide` 是受保护的内置知识。

Agent 创建或修改应用前，先读取 `/apps` 或目标应用，再完整读取 `/knowledge/builtin_app_generation_guide`；摘要和 grep 片段不满足读取要求。

普通对话不自动注入该正文。SDK、权限和依赖以当前应用资源契约及工具结果为准，应用使用说明见[应用](./Page-Agent-13-应用.md)。

该知识也包含 `/utilities` 离线计算能力的使用说明，支持对话、应用、流程和脚本调用，接口见 [ARP 工具调用](./Page-Agent-09-ARP工具调用.md#离线计算)。
