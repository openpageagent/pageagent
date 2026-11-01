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

调用外部 MCP 工具：

```text
POST /mcp-servers/{serverId}/tools/{toolName}/calls
```

P3 内容由工具同步维护，在配置页只读。需要补充使用经验时，可另存为 P2 知识。

## 应用生成知识

`builtin_app_generation_guide` 是受保护的内置知识。

Agent 创建或修改应用前，先读取 `/apps` 或目标应用，再完整读取 `/knowledge/builtin_app_generation_guide`；摘要和 grep 片段不满足读取要求。

普通对话不自动注入该正文。SDK、权限和依赖以当前应用资源契约及工具结果为准，应用使用说明见[应用](./Page-Agent-13-应用.md)。

该知识也包含 `/utilities` 离线计算能力的使用说明，支持对话、应用、流程和脚本调用，接口见 [ARP 工具调用](./Page-Agent-09-ARP工具调用.md#离线计算)。
