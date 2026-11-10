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
  var ENVIRONMENT_INPUT_SCHEMA = Object.freeze(schema({ refresh: { type: 'boolean' } }, []));
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
      summary: '查询桌面支持范围及 robotjs 是否安装；macOS/Windows 鼠标和图片定位需要 robotjs，Linux 支持 X11 截图',
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
      summary: '桌面截图：屏幕、区域或活动窗口，可延迟；Linux/macOS 可交互选择。默认 PNG；Windows robotjs 另支持 BMP，Linux/macOS 可请求 JPEG/GIF；Linux 编码格式取决于 imlib2。支持范围见参数说明',
      inputSchema: schema({
        mode: { enum: ['screen', 'active', 'select'], description: '默认 screen：macOS/Windows 主屏幕，Linux 为 DISPLAY 全屏；可传 region。active：当前活动窗口；macOS/Windows 读取可见窗口边界后截图，不激活窗口。select：鼠标选择窗口/区域，仅 Linux/macOS，整个调用限 30 秒' },
        region: REGION,
        format: { enum: ['png', 'jpeg', 'bmp', 'gif'], description: '默认 png。Windows robotjs 仅支持 png/bmp；macOS JPEG/GIF 和交互选择使用系统 screencapture；Linux 使用 scrot/imlib2，缺少编码器时失败' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: '仅 Linux PNG/JPEG，可选，省略时使用 scrot 默认值。JPEG 数值越高压缩损失越少、文件通常越大；PNG 始终无损，只改变压缩。此参数不增加分辨率或源图细节，高清截图需提高显示器物理分辨率与应用渲染像素密度。其他格式/平台不接受此参数' },
        delayMs: { type: 'integer', minimum: 0, maximum: 10000, description: '启动截图或交互选择前等待的毫秒数，默认 0；计入 30 秒总超时，可取消' },
      }, []),
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
    if (name === 'environment' || name === 'disk') return true;
    var definition = OPERATIONS[name];
    return name === 'read' || name === 'grep' || definition.readOnly === true
      || (definition.readActions || []).indexOf(input.action) >= 0;
  }

  function createAdapter(options) {
    var runtime = options.localOperations;
    async function attachScreenshot(data, context) {
      if (context.sourceConnectionId) return data;
      var topicId = String(context.conversationId || context.topicId || '').trim();
      if (!topicId) return data; // External MCP clients consume the inline image directly.
      var part = data.modelContent[0];
      var binary = atob(part.data);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      var stored = await options.imageArtifactStore.put(new Blob([bytes], { type: part.mimeType }), {
        topicId: topicId, turnId: String(context.turnId || ''), sourceKind: 'desktop-screenshot',
        serverId: data.target && data.target.serverId, connectionId: data.target && data.target.connectionId,
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
    var scope = '/local/connections/{connectionId}';
    var workspaceScope = scope + '/workspaces/{workspaceId}';
    var directoryOperations = ['read', 'write', 'delete', 'grep', 'bash', 'locate'];
    var handlers = { GET: {}, POST: {} };
    var routes = [];
    function result(request, data) { return { statusCode: 200, primary: { uri: request.uri, type: 'LocalCapability', data: data }, schemaValue: data }; }
    function getRoute(template, refresh) {
      routes.push(new arp.RouteContract({ template: template, resourceType: 'LocalCapability', relation: 'local',
        summary: '发现当前授权的服务端、目录与执行环境；名称不作为路由标识', methods: { GET: {
          inputSchema: refresh ? ENVIRONMENT_INPUT_SCHEMA : schema(template === '/local' ? {
            cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } : {}, []),
          outputSchema: { type: 'object' }, safety: 'read', idempotency: 'inherent', execution: 'sync', permissions: ['local.execute'], preconditions: [],
          ...(refresh ? { modelProjection: { type: 'field', field: 'description' } } : {}),
        } } }));
    }
    ['/local', scope, workspaceScope].forEach(function (template) { getRoute(template); });
    getRoute(scope + '/environment', true); getRoute(workspaceScope + '/disk', true);
    handlers.GET['/local'] = async function (request, context) {
      var items = await runtime.discover(context); var query = request.query || {};
      var match = /^offset:(\d+)$/.exec(query.cursor || ''); var start = match ? Number(match[1]) : 0; var limit = Math.min(100, Math.max(1, query.limit || 30));
      return result(request, { items: items.slice(start, start + limit), total: items.length, ...(start + limit < items.length ? { nextCursor: 'offset:' + (start + limit) } : {}) });
    };
    [scope, workspaceScope].forEach(function (template) {
      handlers.GET[template] = async function (request, context) { return result(request, await runtime.discover(context, request.params.connectionId, request.params.workspaceId)); };
    });
    [scope + '/environment', workspaceScope + '/disk'].forEach(function (template) {
      handlers.GET[template] = async function (request, context) {
        return result(request, await runtime.environment({ connectionId: request.params.connectionId, workspaceId: request.params.workspaceId }, context, request.query && request.query.refresh, context.abortSignal));
      };
    });
    Object.keys(OPERATIONS).filter(function (name) { return name !== 'desktop'; }).forEach(function (name) {
      var definition = OPERATIONS[name];
      var template = directoryOperations.includes(name) ? workspaceScope + '/' + name : scope + '/desktop/' + name;
      routes.push(new arp.RouteContract({
        template: template, resourceType: 'LocalOperationResult', relation: 'local-' + name,
        summary: definition.summary, aliases: [name],
        tags: definition.desktop ? ['local', 'desktop', '桌面自动化', 'macOS', 'Windows'] : ['local', 'file', '本地文件', '命令'],
        visible: function (_context, href) { return href.indexOf('{') < 0; },
        methods: { POST: {
          inputSchema: definition.inputSchema, outputSchema: { type: 'object' },
          safety: isRead(name, {}) ? 'read' : 'execute',
          idempotency: 'keyed', execution: 'sync', permissions: ['local.execute'], preconditions: [],
          relation: 'local-' + name, summary: definition.summary,
        } },
      }));
      handlers.POST[template] = async function (request, context) {
        var data = await runtime.execute(name, request.body, { signal: context.abortSignal, context: context,
          expectedTarget: request.targetBinding,
          target: { connectionId: request.params.connectionId, ...(request.params.workspaceId ? { workspaceId: request.params.workspaceId } : {}) } });
        if (name === 'screenshot') data = await attachScreenshot(data, context);
        return { statusCode: 200, primary: { uri: request.uri, type: 'LocalOperationResult', data: data },
          receipt: data.receipt || { performed: isRead(name, request.body) ? 'no' : 'yes' } };
      };
    });
    Object.keys(OPERATIONS).forEach(function (name) {
      routes.push(new arp.RouteContract({ template: '/local/' + name, resourceType: 'LocalMigrationError', relation: 'legacy-local',
        summary: '旧入口需要显式目标', deprecated: true, visible: function () { return false; }, methods: { POST: {
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, safety: 'execute', idempotency: 'keyed', execution: 'sync', permissions: ['local.execute'], preconditions: [],
        } } }));
      handlers.POST['/local/' + name] = function () { throw arp.arpError('INVALID_REQUEST', '请先 GET /local，使用含连接和目录 ID 的执行链接', { performed: 'no', details: { reason: 'TARGET_REQUIRED', discovery: '/local' } }); };
    });
    async function resolveDescriptor(request, context, route) {
      if (request.method !== 'POST' || !route.methods.POST || route.relation === 'legacy-local') return null;
      var params = route.match(request.uri); var name = request.uri.split('/').pop();
      var resolved = await runtime.target(name, { connectionId: params.connectionId, ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}) }, context);
      var method = route.methods.POST; var input = method.inputSchema;
      if (OPERATIONS[name].desktop && input.oneOf) {
        var actions = resolved.connection.desktop.actions[name] || [];
        input = { oneOf: input.oneOf.filter(function (variant) { return actions.includes(variant.properties.action.const); }) };
      }
      return new arp.CapabilityDescriptor({ method: 'POST', href: request.uri, relation: method.relation || route.relation,
        summary: method.summary || route.summary, inputSchema: input, outputSchema: method.outputSchema,
        safety: method.safety, idempotency: method.idempotency, execution: method.execution,
        requiredPermissions: method.permissions, requiredPreconditions: method.preconditions });
    }
    var adapter = adapters.create({ root: 'local', resource: { routeContracts: routes, handlers: handlers, resolveCapabilityDescriptor: resolveDescriptor },
      introspect: async function (context, request) {
        var route = routes.find(function (item) { return item.match(request.uri); });
        if (!route) return [];
        var descriptor = await resolveDescriptor(Object.assign({}, request, { method: 'POST' }), context, route);
        if (route.methods.POST) return descriptor ? [descriptor] : [];
        var params = route.match(request.uri);
        if (params.connectionId && /\/(environment|disk)$/.test(request.uri)) {
          await runtime.target(params.workspaceId ? 'disk' : 'environment', { connectionId: params.connectionId,
            ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}) }, context);
        } else await runtime.discover(context, params.connectionId, params.workspaceId);
        var method = route.methods.GET;
        return [new arp.CapabilityDescriptor({ method: 'GET', href: request.uri, relation: route.relation, summary: route.summary,
          inputSchema: method.inputSchema, outputSchema: method.outputSchema, safety: method.safety, idempotency: method.idempotency,
          execution: method.execution, requiredPermissions: method.permissions, requiredPreconditions: method.preconditions })];
      } });
    adapter.prepareRequest = async function (context, request, route) {
      if (request.method !== 'POST' || route.relation === 'legacy-local') return;
      var params = route.match(request.uri); var name = request.uri.split('/').pop();
      var resolved = await runtime.target(name, { connectionId: params.connectionId, ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}) }, context);
      request.targetBinding = { serverId: resolved.snapshot.serverId, workspaceId: resolved.snapshot.workspaceId || null, resolvedPath: resolved.snapshot.resolvedPath || null };
    };
    return adapter;
  }

  return Object.freeze({ OPERATIONS: OPERATIONS, ENVIRONMENT_INPUT_SCHEMA: ENVIRONMENT_INPUT_SCHEMA, isRead: isRead, createAdapter: createAdapter });
});
