# Page Agent 知识系统

Knowledge 为对话提供可跨任务复用的产品知识、方法和外部工具说明。实时页面、运行报告、资源路径和节点参数不放在 Knowledge 中，它们分别由页面资源、运行资源、ARP RouteContract 和节点定义提供。

## 数据层次

| 层 | 来源 | 用途 |
| --- | --- | --- |
| P1 builtin | 仓库内置稳定知识 | 产品概念和通用方法 |
| P2 auto | 用户或 Agent 保存 | 已验证、可复用的经验 |
| P3 mcp | 外部 MCP 的工具目录 | 外部服务说明 |
| P4 skill | 内置或用户导入的 Skill | 完整方法与参考资料 |

层次只用于相关性接近时排序；当前页面和运行证据始终优先。

## 条目结构

小型条目使用默认 GET 结构，读取 `/knowledge/{knowledgeId}` 得到完整正文。大型文档可以声明 `retrieval: "grep"`：列表和普通 GET 只返回说明与带行号目录，再通过 grep 按节读取正文，避免一次占满上下文。存储上限为单条 1,000,000 字符，正常条目不会被截断。

grep 查询示例：

```text
GET /knowledge?mode=grep&q=登录&context=2
GET /knowledge?mode=grep&q=timeout&after=20
```

对话不会自动检索 Knowledge。模型根据当前任务需要，先用 `/knowledge` 的列表、grep 或 relevance 查询找到 `knowledgeId`，再读取条目；已知 Skill ID 可直接读取 `/skills/{skillId}`。

## Skill

一个 Skill 对应一条 Knowledge 记录，正文和可读文本资源完整内嵌在主记录中：

```text
builtin-skills/<slug>/SKILL.md
  -> skillInstructions
  -> skillResources[{id, path, kind, type, size, text}]
```

内置 Skill 由 `builtin-skills/index.json` 声明，扩展启动时同步为只读 P4；用户可以在配置中心导入 Skill。二进制文件不导入，脚本和资源只作为参考文本，扩展不会执行 Skill 中的脚本。

## MCP 知识

外部 MCP 服务器由 `/connections` 或 `/mcp-servers` 管理。服务器的 `tools/list` 结果保存为 P3 知识，实际调用仍走：

```text
POST /mcp-servers/{serverId}/tools/{toolName}/calls
```

远端工具名不会变成本地模型工具。用户编辑 P3 内容时会生成 P2 副本。

## 自动沉淀

当前运行时不会在每轮对话结束后自动发起沉淀请求。写入 Knowledge 的入口是 Agent 明确调用 `POST /knowledge` 或用户在知识面板中维护。适合保存的内容应已验证、可以脱离当前页面复用，不能是一次性结果、瞬时状态、敏感信息或未经验证的猜测。

## 代码位置

- `knowledge/knowledge.js`：知识域 API；
- `knowledge/knowledge-search.js`：list、search、grep 和 compact 投影；
- `knowledge/knowledge-store.js`：存储与归一化；
- `knowledge/skill-knowledge.js`：Skill 导入；
- `background/builtin-skill-loader.js`：内置 Skill 启动同步；
- `resources/modules/knowledge-resource.js`：ARP `/knowledge` 路由；
- `options/knowledge-panel.js`：知识面板。

工具和节点合同的权威来源是当前 RouteContract、`/node-types/{nodeType}` 和响应 links，不要再复制成固定工具手册。
