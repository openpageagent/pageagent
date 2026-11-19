// User-authored handlers run in the existing script sandbox. Cordis owns their registrations.
(function (root) {
  'use strict';
  var arp = root.AgentResourceProtocol;
  function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
  var identifier = { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 60 };
  var text = { type: 'string', minLength: 1, maxLength: 500 };
  var code = { type: 'string', minLength: 1, maxLength: 65536, description: '异步 JavaScript 函数体；通过 await api.ctx.get() 读取 { input, message, config }，可 return JSON 结果。API 见 GET /plugins/authoring' };
  var filePattern = '^[A-Za-z0-9_][A-Za-z0-9_.-]*\\.(js|json)$';
  function fileName(name) {
    if (typeof name !== 'string' || !new RegExp(filePattern).test(name) || name.includes('..') || name === 'plugin.json') throw arp.arpError('INVALID_REQUEST', '源码文件须为不含目录的 JS/JSON 文件名，plugin.json 为保留名称');
    return name;
  }
  var definitionSchema = object({
    id: identifier, name: text, description: { type: 'string', maxLength: 1000 }, enabled: { type: 'boolean' },
    priority: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: '消息处理优先级，数值越高越先处理；同级按插件注册顺序' },
    base: { const: 'messaging', description: '平台消息插件：使用平台对话通道' },
    javascript: { type: 'string', minLength: 1, maxLength: 262144, description: '兼容旧单文件定义，保存时转为 files[index.js]；新插件使用 files 和 entry' },
    entry: { type: 'string', pattern: filePattern, description: '插件入口 JS 文件名，默认 index.js' },
    files: { type: 'object', propertyNames: { pattern: filePattern }, additionalProperties: { type: 'string' }, description: '插件自有 JS/JSON 文件，键为不含目录的文件名，值为完整源码；通过 require("./文件名") 引用。plugin.json 为配置编辑入口的保留名称。' },
    configSchema: { type: 'object', description: '插件作者声明配置表单与校验规则：根为 object，properties 定义字段；字段 title 为名称、description 为说明，支持 string/number/integer/boolean/object/array、enum 或带 title/const 的 oneOf 选项。密码用 writeOnly:true，多行文本用 format:multiline；无配置项不显示配置区。详见 GET /plugins/authoring 的 configuration。' },
    config: { type: 'object' },
    permissions: { type: 'array', uniqueItems: true, maxItems: 100, items: text, description: '处理函数可调用的资源权限；不能超过创建或更新者的权限' },
    capabilities: { type: 'array', maxItems: 20, items: object({
      id: identifier, label: text, description: { type: 'string', maxLength: 1000 },
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      safety: { enum: ['read', 'write', 'execute'] }, node: { type: 'boolean' }, utility: { type: 'boolean' }, code: code,
    }, ['id', 'inputSchema', 'code']) },
    subscriptions: { type: 'array', maxItems: 20, items: object({
      connectionId: text, accountId: text, channelId: text, userId: text,
      command: { type: 'string', pattern: '^[a-z\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]{0,59}$' }, code: code,
    }, ['connectionId', 'accountId', 'channelId', 'userId', 'code']) },
  }, ['id', 'name', 'enabled', 'config', 'permissions', 'capabilities', 'subscriptions']);
  function validate(input) {
    var result = arp.validateJsonSchema(definitionSchema, input);
    if (!result.valid) throw arp.arpError('SCHEMA_VALIDATION_FAILED', result.errors.join('; '));
    input = JSON.parse(JSON.stringify(input));
    input.permissions = root.SystemRuntimePermissions.normalizePluginPermissions(input.permissions);
    if (input.priority === undefined) input.priority = 0;
    if (input.javascript !== undefined) {
      if (input.files) throw arp.arpError('INVALID_REQUEST', '请仅使用 files 保存源码，不要同时提交 javascript');
      input.entry = input.entry || 'index.js'; input.files = { [input.entry]: input.javascript }; delete input.javascript;
    }
    if (input.files) {
      var names = Object.keys(input.files);
      if (!names.length || names.length > 20 || JSON.stringify(input.files).length > 262144) throw arp.arpError('INVALID_REQUEST', '插件最多 20 个源码文件，总大小不超过 256 KB');
      names.forEach(fileName);
      input.entry = input.entry || 'index.js';
      if (!input.entry.endsWith('.js') || !Object.prototype.hasOwnProperty.call(input.files, input.entry)) throw arp.arpError('INVALID_REQUEST', '插件入口必须指向已有 JS 文件');
    } else if (input.entry) throw arp.arpError('INVALID_REQUEST', '插件入口缺少源码文件');
    if (['authoring', 'contributions'].includes(input.id)) throw arp.arpError('INVALID_REQUEST', '此插件 ID 为系统保留名称');
    if (new Set(input.capabilities.map(function (item) { return item.id; })).size !== input.capabilities.length) throw arp.arpError('INVALID_REQUEST', '插件能力 ID 不能重复');
    if (input.base === 'messaging' && !input.files) {
      var configCheck = arp.validateJsonSchema(root.PageAgentMessagingPlugin.configSchema, input.config);
      if (!configCheck.valid) throw arp.arpError('SCHEMA_VALIDATION_FAILED', configCheck.errors.join('; '));
    }
    input.capabilities.forEach(function (item) {
      if (item.inputSchema.type !== 'object') throw arp.arpError('INVALID_REQUEST', '能力 inputSchema 必须声明 type: object');
      if (item.utility && item.safety !== 'read') throw arp.arpError('INVALID_REQUEST', '工具必须声明 safety: read');
    });
    return input;
  }
  async function checkSyntax(definition, options, signal) {
    if (definition.files) {
      var module = await root.PageAgentPluginSource.inspect(definition, options, signal);
      var configCheck = arp.validateJsonSchema(module.configSchema, definition.config);
      if (!configCheck.valid) throw arp.arpError('SCHEMA_VALIDATION_FAILED', configCheck.errors.join('; '));
      definition.configSchema = module.configSchema;
    }
    var sources = definition.capabilities.concat(definition.subscriptions).map(function (item) { return item.code; });
    if (!sources.length) return;
    await options.runScript('for (const source of ' + JSON.stringify(sources) + ') new Function("api", '
      + JSON.stringify('"use strict";\nreturn (async function(){\n') + ' + source + "\\n})();");',
      { signal: signal, timeoutMs: 5000, apiCall: function () { throw new Error('源码检查不调用 API'); } });
  }
  function manifest(definition, options) {
    var value = validate(definition);
    return { id: value.id, name: value.name, description: value.description || '', version: '1.0.0', apiVersion: 1,
      source: 'user', base: value.base || '', enabled: value.enabled, priority: value.priority, config: value.config,
      configSchema: value.configSchema || (value.base === 'messaging' ? root.PageAgentMessagingPlugin.configSchema : { type: 'object' }), permissions: value.permissions,
      plugin: { name: 'user-' + value.id, apply: async function (ctx, config) {
        var api = ctx.pageAgent, pending = 0, queue = Promise.resolve();
        // Check syntax in the sandbox before publishing any contributions.
        await checkSyntax(value, options, api.signal);
        api.signal.throwIfAborted();
        async function execute(source, input, message, call) {
          var sequence = 0, key = call ? await arp.sha256(call.idempotencyKey) : crypto.randomUUID();
          return options.runScript(source, { signal: call ? AbortSignal.any([api.signal, call.signal]) : api.signal,
            timeoutMs: 60000, tag: 'plugin:' + value.id,
            apiCall: async function (name, args, execution) {
              api.signal.throwIfAborted(); execution.signal.throwIfAborted();
              if (name === 'ctx.get') {
                var data = { input: input, message: message, config: config };
                return args[0] === undefined ? data : Object.prototype.hasOwnProperty.call(data, args[0]) ? data[args[0]] : null;
              }
              if (name === 'resources.request') {
                var method = args[0], request = args[1];
                if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) || !request || typeof request.uri !== 'string') throw new Error('请提供有效的资源方法和请求');
                var resolved = options.resourceRuntime.registry.resolve(request.uri.split('?')[0], method);
                if (method !== 'OPTIONS' && (!resolved || !resolved.methodContract
                  || resolved.methodContract.permissions.some(function (permission) { return !value.permissions.includes(permission); }))) throw new Error('插件未声明此资源权限');
                var body = Object.assign({}, request);
                if (!['GET', 'OPTIONS'].includes(method)) body.idempotencyKey = key + ':' + sequence++;
                return call ? call.arp(method, body, execution.signal) : api.arp(method, body, execution.signal);
              }
              if (name === 'messaging.reply' && message) {
                if (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > 16000) throw new Error('回复必须是 1–16000 字符的文本');
                var result = await api.serverArp(message.connectionId, 'POST', {
                  uri: '/bots/accounts/' + encodeURIComponent(message.accountId) + '/messages',
                  body: { replyTo: message.id, targetId: message.direct ? message.userId : message.channelId, direct: !!message.direct, text: args[0] },
                  idempotencyKey: key + ':reply:' + sequence++,
                }, execution.signal);
                if (result.error) throw new Error(result.error.message);
                return result.primary.data;
              }
              throw new Error('现场插件不支持此 API：' + name + '；使用 api.resources.request 调用已授权的资源');
            } }).catch(function (error) {
              if (!api.signal.aborted && !(call && call.signal.aborted)) {
                if (message) api.events.emit('messaging:trigger-error', { message: message, error: error.message });
                options.onError(value.id, error, api.signal);
              }
              throw error;
            });
        }
        value.capabilities.forEach(function (item) {
          api.registerCapability(Object.assign({}, item, { permissions: ['plugins.execute'],
            execute: function (input, call) { return execute(item.code, input, null, call); } }));
        });
        value.subscriptions.forEach(function (subscription) {
          api.events.on('messaging:dispatch', function (event) {
            var message = event.data;
            if (!['connectionId', 'accountId', 'channelId', 'userId'].every(function (key) { return subscription[key] === message[key]; })
              || subscription.command && subscription.command !== (message.command && message.command.name)) return;
            if (pending >= 32) {
              api.events.emit('messaging:trigger-error', { message: message, error: '插件消息队列已满，本条未执行' }); return true;
            }
            pending++;
            var work = queue.then(function () {
              api.signal.throwIfAborted();
              if (message.command && message.command.error) throw new Error(message.command.error);
              return execute(subscription.code, {}, message, null);
            });
            queue = work.catch(function (error) {
              if (!api.signal.aborted) api.events.emit('messaging:trigger-error', { message: message, error: error.message });
            }).finally(function () { pending--; });
            return true;
          });
        });
        if (value.files) await root.PageAgentPluginSource.start(Object.assign({}, value, { config: config }), ctx, options);
        else if (value.base === 'messaging') root.PageAgentMessagingPlugin.plugin.apply(ctx, config, value.id);
      } },
    };
  }
  root.PageAgentUserPlugin = Object.freeze({ schema: definitionSchema, fileName: fileName, validate: validate, checkSyntax: checkSyntax, manifest: manifest });
})(globalThis);
