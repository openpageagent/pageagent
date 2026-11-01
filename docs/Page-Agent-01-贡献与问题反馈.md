# Page Agent 贡献与问题反馈

项目通过 GitHub Issue 接收问题，通过 Pull Request（PR）接收改动。

## 报告问题

创建 Issue 时请提供：

- 浏览器及版本、操作系统、扩展版本；
- 可重复的操作步骤；
- 预期结果和实际结果；
- 相关 Flow、节点、模型协议或 MCP 配置的脱敏信息；
- 控制台、运行报告或 MCP 日志中与问题直接相关的片段；
- 是否稳定复现，以及受影响的扩展版本（如果已知）。

提交前删除 API Key、Cookie、密码、个人信息、完整 URL 参数、录制原文和其他业务数据。安全漏洞不要公开创建 Issue，请按仓库根目录的 [`SECURITY.md`](../SECURITY.md) 报告。

## 提交代码

从默认分支创建分支，提交 PR 时说明问题、改动范围、验证情况和已知影响。

JavaScript 差异格式与语法检查：

```bash
git diff --check
node --check path/to/changed-file.js
```

PR 格式见 [Pull Request 模板](../.github/pull_request_template.md)，贡献流程和代码约定见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

## 联系方式

公开联系邮箱为 `harrylee@linux.do`。项目是个人开源项目，不提供商业支持、定制开发或即时响应。
