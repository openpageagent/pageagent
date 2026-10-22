// Shared by the application loader and the resource capability directory.
(function (root) {
  'use strict';
  // UMD globals must exist before the editor installs Monaco's AMD loader.
  var textScripts = ['dependencies/marked/marked.min.js', 'dependencies/dompurify/purify.min.js', 'ui/code-editor.js'];
  var views = textScripts.concat(['ui/conversation-event-view.js']);
  var components = {
    'code-editor': {
      summary: '代码编辑、只读展示、差异对比和 JSON Schema 辅助', scripts: textScripts,
      api: { tagName: 'page-code-editor', attributes: ['language', 'readonly', 'disabled', 'rows', 'aria-label', 'placeholder', 'data-original', 'data-label'], properties: ['value', 'readOnly', 'disabled', 'schema'], methods: ['focus()', 'format()'], events: ['input：用户编辑', 'change：编辑后失焦', 'copy-result：工具栏复制完成，detail.error 为失败原因，成功时为空字符串'] },
      usage: 'load 完成后标签可用；编辑器可见时才加载 Monaco。language 支持 javascript/json/html/css/plaintext，其他语言按纯文本。data-label 可替换工具栏中的语言文字，用于标识字段；空字符串不显示标识。toolbar、surface part 可为附加控件预留空间。data-original 指定差异原文，value 为当前内容；schema 接受本地 JSON Schema 对象。程序设置 value 不触发 input。使用 --code-height 调整高度。移除元素后释放实例。',
      example: { html: '<page-code-editor id="editor" language="json" aria-label="JSON 内容" rows="12"></page-code-editor>', javascript: 'await PageAgent.ui.load("code-editor");\nconst editor = document.getElementById("editor");\neditor.value = "{}";\neditor.addEventListener("input", () => { /* 使用 editor.value */ });' }
    },
    markdown: {
      summary: 'Markdown 展示，包含表格、清洗后的链接、图片和只读代码块', scripts: views,
      api: { methods: ['create(container, {value?})'], instance: ['setValue(text)', 'destroy()'] },
      usage: 'value 为 Markdown 字符串，默认空串。原始 HTML 按文本展示；内容统一清洗。支持 HTTP(S)、数据图片及 PageAgent.asset() 返回的同扩展 Blob 图片。外部资源仍需按应用契约声明。不读取对话附件。组件占用容器内容，destroy 清空组件并释放实例；布局写在容器上。',
      example: { html: '<div id="preview"></div>', javascript: 'const markdown = await PageAgent.ui.load("markdown");\nconst view = markdown.create(document.getElementById("preview"), {value: "# 内容"});\nview.setValue("# 更新后的内容");' }
    },
    'message-list': {
      summary: '对话消息展示、流式内容更新、折叠详情和长列表', scripts: views.concat(['ui/conversation-list-view.js']),
      api: { methods: ['create(container, {messages?, virtualize?})'], instance: ['setMessages(messages)', 'scrollToEnd()', 'destroy()'], message: { id: '非空、不含首尾空格且唯一的稳定字符串', role: ['user', 'assistant', 'system', 'tool', 'error'], text: 'Markdown 字符串', status: ['pending', 'streaming', 'complete', 'error'], details: '可选 JSON 值，折叠展示' } },
      usage: 'messages 默认 []，virtualize 默认 true，消息 status 默认 complete。按同一 id 更新文本再 setMessages；在底部时跟随新增内容，向上查看时保留位置。容器可通过 --message-list-height 设置高度，默认 360px。组件只显示传入数据；输入表单、发送、停止、模型调用和保存由应用通过已有 SDK 编排。移除容器前调用 destroy。',
      example: { html: '<div id="messages"></div>', javascript: 'const messages = await PageAgent.ui.load("message-list");\nconst view = messages.create(document.getElementById("messages"));\nview.setMessages([{id:"a1",role:"assistant",text:"正在处理…",status:"streaming"}]);\nview.setMessages([{id:"a1",role:"assistant",text:"处理完成",status:"complete"}]);' }
    },
    icons: {
      summary: '当前可用应用图标目录及页面图标用法', scripts: [],
      api: { methods: ['create(name, {label?})'] },
      usage: '本资源的 icons 是当前可用图标 ID 全集，与管理界面的选择框共用目录。应用元数据 icon 和 create(name) 只能使用其中的 ID，不得猜测其他图标名；目录外的值会被拒绝。单独修改应用图标时，先读取 /apps/{appId} 的最新 ETag，再 PATCH /apps/{appId}，patch 仅包含 icon，并携带 preconditions.ifMatch 和 idempotencyKey；立即生效，无需源码或发布。页面内使用 create(name, {label}) 返回 span 元素，可 append 到按钮等容器。label 提供可访问名称；省略时作为装饰图标。图标继承当前颜色和字号。',
      example: { html: '<button id="done" type="button">完成</button>', javascript: 'const icons = await PageAgent.ui.load("icons");\ndocument.getElementById("done").prepend(icons.create("fa-check-square"));' }
    },
    feedback: {
      summary: '页面内普通、成功和错误提示', scripts: ['ui/feedback.js'],
      api: { methods: ['toast(text, {kind?, duration?}) → dismiss()'], kind: ['info', 'success', 'error'] },
      usage: 'text 按纯文本展示。kind 默认 info；duration 为 0 或 1000–60000 毫秒，默认 3000；0 表示常驻并显示关闭按钮，其余提示到期自动关闭。始终返回 dismiss 函数，可提前关闭。组件不执行保存或请求通知权限，成功提示必须以真实业务结果为依据。',
      example: { javascript: 'const feedback = await PageAgent.ui.load("feedback");\nconst dismiss = feedback.toast("操作完成", {kind:"success"});' }
    },
    floating: {
      summary: '浮动面板拖动、键盘移动和视口约束', scripts: ['content/page-element-position-controller.js'],
      api: { methods: ['create(panel, {handle, position?, onPositionChange?})'], instance: ['refresh()', 'destroy()'], position: { leftRatio: '0–1', topRatio: '0–1' } },
      usage: 'panel 必须已连接文档，handle 为其内部拖动手柄。控制器使用 fixed 定位，默认居中；手柄方向键移动，Shift 加速。交互结束调用 onPositionChange(position)，位置由应用决定是否保存到 PageAgent.data。按钮、输入等交互元素不触发拖动。destroy 恢复接管的样式和手柄属性。此模块不处理列表排序或停靠。',
      example: { html: '<aside id="panel" class="app-panel"><header id="handle">拖动面板</header><p>面板内容</p></aside>', javascript: 'const floating = await PageAgent.ui.load("floating");\nconst controller = floating.create(document.getElementById("panel"), {handle:document.getElementById("handle"), position:{leftRatio:0.5,topRatio:0.5}});' }
    }
  };
  function entry(id) { return Object.prototype.hasOwnProperty.call(components, id) ? components[id] : null; }
  function list() {
    return { apiVersion: 1, loader: 'PageAgent.ui.load(id)', components: Object.keys(components).map(function (id) {
      return { id: id, summary: components[id].summary, href: '/apps/capabilities/ui/' + id };
    }) };
  }
  function describe(id) {
    var item = entry(id);
    if (!item) throw root.AppContract.error('RESOURCE_NOT_FOUND', 'UI 组件不存在: ' + id);
    var result = { id: id, apiVersion: 1, summary: item.summary, api: item.api, usage: item.usage, example: item.example,
      lifecycle: 'UI 仅在应用文档使用，纯展示不需要 SDK 业务权限；不因暂时断线销毁输入，页面卸载统一清理。',
      theme: '沿用应用主题变量及回退值；--code-height、--message-list-height 控制各自高度。组件实现随插件提供，应用主题保持保存的快照。' };
    if (id === 'icons') result.icons = Object.keys(root.AppContract.ICONS);
    return JSON.parse(JSON.stringify(result));
  }
  root.AppUiContract = Object.freeze({ list: list, describe: describe, scripts: function (id) { var item = entry(id); return item ? item.scripts.slice() : null; } });
})(globalThis);
