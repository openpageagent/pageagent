// Local operations use the existing ARP catalog and Extension → Server socket.
(function (root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var api = factory(commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol,
    commonJs ? require('../resource-module-adapter.js') : root.ResourceModuleAdapter);
  if (commonJs) module.exports = api;
  else root.LocalResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, adapters) {
  'use strict';

  var PATH = { type: 'string', minLength: 1, maxLength: 4096, description: '配置的工作目录内的路径；相对路径基于该目录，绝对路径也必须在该目录内' };
  function schema(properties, required) {
    return { type: 'object', properties: properties, required: required, additionalProperties: false };
  }
  function action(name, properties, required) {
    return schema(Object.assign({ action: { const: name } }, properties), ['action'].concat(required || []));
  }
  var KEY = { type: 'string', minLength: 1, maxLength: 16,
    description: '单个英文字母/数字，或 enter、tab、space、backspace、delete、escape、left、right、up、down；安装 robotjs 后还支持 home/end/pageup/pagedown 和 f1-f12' };
  var COORDINATE = { type: 'integer', minimum: -100000, maximum: 100000 };
  var SIZE = { type: 'integer', minimum: 1, maximum: 100000 };
  var DURATION = { type: 'integer', minimum: 0, maximum: 10000, description: '移动耗时毫秒数，默认 300，使用缓入缓出轨迹' };
  var REGION = schema({ x: COORDINATE, y: COORDINATE, width: SIZE, height: SIZE }, ['x', 'y', 'width', 'height']);
  var PID = { type: 'integer', minimum: 1, maximum: 2147483647 };
  var OPERATIONS = Object.freeze({
    read: {
      summary: '读取本地 UTF-8 文本文件（最多 4MB），按行分页，返回内容最多 64KB',
      inputSchema: schema({ path: PATH, offset: { type: 'integer', minimum: 1, description: '起始行号，默认 1' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: '最多读取行数，默认 200' } }, ['path']),
    },
    write: {
      summary: '创建或覆盖本地 UTF-8 文本文件（最多 1MB），自动创建父目录',
      inputSchema: schema({ path: PATH, content: { type: 'string', maxLength: 1048576 } }, ['path', 'content']),
    },
    delete: {
      summary: '删除一个本地文件或符号链接，不递归删除目录',
      inputSchema: schema({ path: PATH }, ['path']),
    },
    grep: {
      summary: '在本地文件或目录递归查找字面文本，返回路径、行号和匹配行；跳过符号链接、二进制、超过 4MB 的文件及 .git/node_modules 目录',
      inputSchema: schema({ path: PATH, pattern: { type: 'string', minLength: 1, maxLength: 4096 },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多匹配行数，默认 100' } }, ['path', 'pattern']),
    },
    bash: {
      summary: '在配置的工作目录内启动 Bash 命令；每次独立运行，输出最多 64KB，不可通过参数更改工作目录',
      inputSchema: schema({ command: { type: 'string', minLength: 1, maxLength: 65536 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, description: '超时毫秒数，默认 30000' } }, ['command']),
    },
    desktop: {
      desktop: true, readOnly: true,
      summary: '查询 macOS/Windows 桌面支持范围及 robotjs 是否安装；鼠标和图片定位需要 robotjs，Linux 不支持',
      inputSchema: schema({}, []),
    },
    keyboard: {
      desktop: true,
      summary: 'macOS/Windows 当前焦点的单键、组合键或文本输入；type 默认粘贴并覆盖剪贴板，mode=keys 逐字输入；Windows 和逐字输入需要 robotjs',
      inputSchema: { oneOf: [
        action('press', { key: KEY }, ['key']),
        action('hotkey', { key: KEY, modifiers: { type: 'array', minItems: 1, maxItems: 4,
          items: { enum: ['primary', 'command', 'ctrl', 'alt', 'shift'] }, uniqueItems: true } }, ['key', 'modifiers']),
        action('type', { text: { type: 'string', minLength: 1, maxLength: 4096 }, mode: { enum: ['paste', 'keys'] },
          intervalMs: { type: 'integer', minimum: 0, maximum: 1000, description: 'mode=keys 时的字符间隔，默认 50 毫秒，总时长限 30 秒' } }, ['text']),
      ] },
    },
    mouse: {
      desktop: true, readActions: ['position'],
      summary: 'macOS/Windows 鼠标位置及屏幕列表、平滑移动、点击/双击、左键拖拽和滚轮；需要 robotjs，坐标允许副屏负值',
      inputSchema: { oneOf: [
        action('position', {}),
        action('move', { x: COORDINATE, y: COORDINATE, durationMs: DURATION }, ['x', 'y']),
        action('click', { x: COORDINATE, y: COORDINATE, durationMs: DURATION,
          button: { enum: ['left', 'middle', 'right'] }, double: { type: 'boolean' } }, ['x', 'y']),
        action('drag', { fromX: COORDINATE, fromY: COORDINATE, x: COORDINATE, y: COORDINATE,
          durationMs: DURATION }, ['fromX', 'fromY', 'x', 'y']),
        action('scroll', { deltaX: { type: 'integer', minimum: -100, maximum: 100 },
          deltaY: { type: 'integer', minimum: -100, maximum: 100, description: '竖直滚轮量，正数向上，负数向下' } }, ['deltaY']),
      ] },
    },
    clipboard: {
      desktop: true, readActions: ['read'],
      summary: 'macOS/Windows：读取、写入或清空服务端系统文本剪贴板，最多 64KB UTF-8',
      inputSchema: { oneOf: [action('read', {}), action('clear', {}),
        action('write', { text: { type: 'string', maxLength: 65536 } }, ['text'])] },
    },
    screenshot: {
      desktop: true, readOnly: true,
      summary: 'macOS/Windows 主屏幕或 region 截图，返回 PNG；robotjs 提供屏幕坐标换算信息，Windows 和区域截图需要 robotjs',
      inputSchema: schema({ region: REGION }, []),
    },
    locate: {
      desktop: true, readOnly: true,
      summary: '用 robotjs 在主屏幕或 region 中查找工作目录内的 PNG 模板，返回首个匹配位置及可点击中心坐标；非 OCR，不自动点击',
      inputSchema: schema({ templatePath: PATH, region: REGION,
        tolerance: { type: 'number', minimum: 0, maximum: 0.5, description: '颜色误差容忍度，0 为精确匹配，默认 0.1；不是置信度' } }, ['templatePath']),
    },
    application: {
      desktop: true,
      summary: 'macOS/Windows 启动应用；按 PID 请求退出（Windows 请求关闭主窗口）或激活应用并打开当前窗口的打印对话框，不自动确认打印',
      inputSchema: { oneOf: [
        action('open', { application: { type: 'string', minLength: 1, maxLength: 4096, description: 'macOS 应用名或 .app 路径；Windows 可执行文件路径或 PATH 中的名称，不是 shell 命令' },
          args: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 32 } }, ['application']),
        action('close', { pid: PID }, ['pid']),
        action('print', { pid: PID }, ['pid']),
      ] },
    },
    window: {
      desktop: true, readActions: ['list', 'bounds'],
      summary: 'macOS/Windows 窗口列表、按 PID 和唯一精确标题恢复并激活窗口、读取屏幕边界；Windows 包含 UI Automation 暴露的多窗口和对话框，macOS 还支持移动或调整大小',
      inputSchema: { oneOf: [
        action('list', { title: { type: 'string', maxLength: 512, description: '标题包含的文本，区分大小写' }, pid: PID }),
        action('activate', { pid: PID, title: { type: 'string', minLength: 1, maxLength: 512 } }, ['pid', 'title']),
        action('bounds', { pid: PID, title: { type: 'string', minLength: 1, maxLength: 512 } }, ['pid', 'title']),
        action('move', { pid: PID, title: { type: 'string', minLength: 1, maxLength: 512 }, x: COORDINATE, y: COORDINATE }, ['pid', 'title', 'x', 'y']),
        action('resize', { pid: PID, title: { type: 'string', minLength: 1, maxLength: 512 }, width: SIZE, height: SIZE }, ['pid', 'title', 'width', 'height']),
      ] },
    },
  });

  function isRead(name, input) {
    var definition = OPERATIONS[name];
    return name === 'read' || name === 'grep' || definition.readOnly === true
      || (definition.readActions || []).indexOf(input.action) >= 0;
  }

  function createAdapter(options) {
    var runtime = options.localOperations;
    async function attachScreenshot(data, context) {
      var topicId = String(context.conversationId || context.topicId || '').trim();
      if (!topicId) return data; // External MCP clients consume the inline image directly.
      var part = data.modelContent[0];
      var binary = atob(part.data);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      var stored = await options.imageArtifactStore.put(new Blob([bytes], { type: part.mimeType }), {
        topicId: topicId, turnId: String(context.turnId || ''), sourceKind: 'desktop-screenshot',
        representation: 'screenshot', mimeType: part.mimeType, width: data.width, height: data.height,
        detail: 'high', alt: '服务端桌面截图',
      });
      if (context.abortSignal && context.abortSignal.aborted) {
        if (stored.created !== false) await options.imageArtifactStore.delete(stored.id);
        throw new Error('截图已取消');
      }
      return Object.assign({}, data, { artifactUri: stored.artifactUri, modelContent: [{
        type: 'image', artifactUri: stored.artifactUri, mimeType: stored.mimeType,
        width: stored.width, height: stored.height, detail: 'high', alt: '服务端桌面截图',
      }] });
    }
    var routes = Object.keys(OPERATIONS).map(function (name) {
      var definition = OPERATIONS[name];
      return new arp.RouteContract({
        template: '/local/' + name, resourceType: 'LocalOperationResult', relation: 'local-' + name,
        summary: definition.summary, aliases: [name],
        tags: definition.desktop ? ['local', 'desktop', '桌面自动化', 'macOS', 'Windows'] : ['local', 'file', '本地文件', '命令'],
        visible: function () { return runtime.isAvailable(); },
        methods: { POST: {
          inputSchema: definition.inputSchema, outputSchema: { type: 'object' },
          safety: isRead(name, {}) ? 'read' : 'execute',
          idempotency: 'keyed', execution: 'sync', permissions: ['local.execute'], preconditions: [],
          relation: 'local-' + name, summary: definition.summary,
        } },
      });
    });
    var handlers = { POST: {} };
    Object.keys(OPERATIONS).forEach(function (name) {
      handlers.POST['/local/' + name] = async function (request, context) {
        var data = await runtime.execute(name, request.body, { signal: context.abortSignal });
        if (name === 'screenshot') data = await attachScreenshot(data, context);
        return { statusCode: 200, primary: { uri: request.uri, type: 'LocalOperationResult', data: data },
          receipt: { performed: isRead(name, request.body) ? 'no' : 'yes' } };
      };
    });
    return adapters.create({ root: 'local', resource: { routeContracts: routes, handlers: handlers } });
  }

  return Object.freeze({ OPERATIONS: OPERATIONS, createAdapter: createAdapter });
});
