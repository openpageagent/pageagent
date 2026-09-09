# Page Agent 内置助手

内置助手是预先配置的 Assistant profile。用户选择助手后，profile 的提示词决定任务方法，`resourcePolicy` 决定实际可访问的资源和方法。

## 当前组成

助手行为由三层组成：

1. `agent/agent-prompt.js`：所有助手共用的身份、事实来源、信任边界、失败处理和停止条件。
2. Assistant `prompt`：该助手的任务范围、执行步骤、交付物和完成条件。
3. `resourcePolicy`：允许访问的 ARP 路径、HTTP 方法和 semantic permission，是能力上限。

Assistant prompt 不能覆盖系统提示词、用户当前要求、资源合同或运行时事实。公共规则已经由 System Core 提供时，不在每个助手中重复。

## 基础能力

所有助手默认可以完成 Page Agent 的基本闭环：读取页面、执行页面动作、读写 Flow 和 FlowGroup、运行并查看报告、读写页面配置和脚本、读写定时与 URL 触发器、读取节点类型、读取 Recording、读取 Knowledge/Skill 和读取助手定义。

这些能力对应的资源包括：

```text
/page       /browser       /flows       /flow-groups
/runs       /recordings    /pages       /scripts
/schedules  /url-triggers  /node-types  /knowledge
/skills     /assistants
```

创建或修改助手、写入 Skill、修改模型服务、管理 Connection/MCP Server、删除资源和直接执行外部调用，都不属于默认任务能力。只有职责明确需要时，才作为专用增量加入。入口和运行时仍可进一步收窄 profile 的权限。

## 设计一个助手

先定义交付物，再反推闭环：

```text
交付物 -> 必要证据 -> 必要动作 -> 验证 -> 结果回执
```

Prompt 至少说明：

- 处理的任务和最终交付物；
- 需要读取的证据及其顺序；
- 允许创建、修改或执行的资源；
- 何时读取 Knowledge 或 Skill；
- 完成判据、验证方式和无法继续时的报告内容；
- 明确不处理的相邻任务。

用可观察行为描述要求，例如“读取页面后再点击”“提交前检查运行报告”。“可靠”“聪明”等人格形容词不能替代执行条件。

Prompt 中的每个外部动作必须有对应的 route method 和 permission。权限不能因为“可能有用”而加入；删除、配置修改、外部连接和高风险执行应单独评估。

## 新增位置

内置助手模板定义在 `options/conversation-profile-schema.js` 的 `assistantTemplates()` 和 `buildTemplatePrompt()`。新增或修改助手时同步更新：

1. 模板名称、描述、prompt 和默认配置；
2. `resourcePolicy` 的路径、方法和 semantic permission；
3. 需要的 Knowledge/Skill 引用；
4. 交付物和完成条件。

运行时会在资源 Router 之前检查权限，因此只隐藏界面控件不能替代权限配置。助手拥有某项邻接权限，也不能据此扩大用户目标。
