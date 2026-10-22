# Page Agent Developer Utils

Page Agent 内置的离线开发工具应用，提供 47 项编码、格式化、转换、生成与预览工具，使用插件默认主题和本地计算能力。

## 打开与操作

在插件「应用」中打开 **Developer Utils**，入口为 `/apps/developer-utils`。

- 支持中英文搜索和分类筛选；`Ctrl / ⌘ + K` 搜索，`Ctrl / ⌘ + Enter` 重新处理。
- 转换、检查和格式化随输入自动更新；生成工具提供生成或重新生成操作。
- 输入与结果仅保留在当前页面，切换工具会重置输入。剪贴板和文件操作由用户主动触发。
- 对话可通过 `POST /apps/app_developer_utils/open` 传入 `{input:{toolId,input,operation?}}`，直接打开指定工具并填入文本。多个工具的计算通过 `/utilities` 串联。启动约定可从应用摘要的 `slots.published.customBehavior` 读取，示例见[应用文档](../../docs/Page-Agent-13-应用.md#内置开发工具联动)。

改名后遗留的旧应用会保留为普通应用，可在应用管理中手动删除。

## 插件能力与 SDK

[应用包](../developer-utils.json) 定义应用 ID `app_developer_utils`；[app.js](./app.js) 为界面入口，[tools.js](./tools.js) 定义菜单与参数预设。

计算通过 `PageAgent.resources.request` 向工具的 `operationUris` 发起 POST，请求体为 `{ input, options }`。接口由 [utilities/catalog.js](../../utilities/catalog.js) 定义，算法在离线 Worker 中执行，需要 `utilities.read`、`utilities.execute` 权限。

应用无需独立构建。界面与主题通过 `sourceFiles` 安装到 `code.files`，支持「复制后修改」；副本可在「源码文件」页签或通过对话编辑，导出时携带原文。发布打包跳过内置应用 JS/CSS 和默认主题的压缩。公共工具目录、算法、UI 组件与字体仍由插件提供。依赖许可见[第三方许可](../../utilities/THIRD_PARTY_NOTICES.html)。

## 实现边界

- X.509 只解码，不验证信任链；JWT 支持解码及 HS256/384/512 验签，不支持签发。
- HTML 预览禁用脚本、表单、导航和外部资源；Markdown 转 HTML 后经清洗再预览。
- PHP 仅解析数据字面量，序列化支持标量、数组和 stdClass，不支持对象引用或自定义类；ERB 不执行 Ruby，cURL 转代码不发送请求。
- JSON 转代码从样本推导类型，不推断业务约束；生成代码所需的外部依赖由使用方提供。
- Base64 图片上限为 32 KiB、400 万像素；哈希文件上限为 48 KiB。输入、超时与结果大小还受共用服务限制。
- ULID 同一毫秒内不保证单调排序；随机字符串指定种子时产生可重复的伪随机结果。
