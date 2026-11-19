// Page Agent owns extension points. Cordis only owns contributed effects.
(function (root) {
  'use strict';
  var arp = root.AgentResourceProtocol;
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function id(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) throw new TypeError('插件及能力 ID 必须为小写英文、数字和单横线');
    return value;
  }
  function fail(message) { throw arp.arpError('RESOURCE_NOT_FOUND', message); }
  function unwrap(response) {
    if (response.error) throw arp.arpError(response.error.code, response.error.message, {
      details: response.error.details, performed: response.receipt && response.receipt.performed || 'unknown',
      retryable: response.error.retryable === true,
    });
    return response.primary.data;
  }
  function serverPermissions(method, input) {
    var target = arp.parseRequestTarget(input && input.uri, method);
    var uri = arp.canonicalizeUri(target.path), permission;
    if (method === 'GET' && (uri === '/bots' || /^\/bots\/accounts\/[^/]+\/(events|sources)$/.test(uri))
      || method === 'POST' && /^\/bots\/accounts\/[^/]+\/(pull|ack)$/.test(uri)
      || method === 'DELETE' && /^\/bots\/accounts\/[^/]+\/consumers\/[^/]+$/.test(uri)) permission = 'plugins.execute';
    else if (method === 'GET' && (uri === '/bots/clients' || /^\/bots\/accounts\/[^/]+\/configuration$/.test(uri))
      || method === 'POST' && uri === '/bots/accounts'
      || ['POST', 'DELETE'].includes(method) && /^\/bots\/accounts\/[^/]+$/.test(uri)) permission = 'plugins.execute';
    else if (method === 'POST' && /^\/bots\/accounts\/[^/]+\/(messages|mail)$/.test(uri)) permission = 'plugins.execute';
    else if (method === 'GET' && uri === '/postgres' || method === 'POST' && uri === '/postgres/query') permission = 'plugins.execute';
    else if (method === 'POST' && uri === '/postgres/execute') permission = 'plugins.execute';
    if (permission) return [permission];
    var kinds = root.PageAgentDevToolsCatalog.kinds;
    if (method === 'GET' && uri === '/devtools') {
      var selected = target.query.kind === undefined ? kinds : kinds.filter(function (kind) { return kind.id === target.query.kind; });
      if (selected.length) return ['plugins.execute'];
    }
    if (method === 'POST') {
      for (var kind of kinds) {
        var operation = kind.operations.find(function (item) { return uri === '/devtools/' + kind.id + '/' + item.id; });
        if (operation) return ['plugins.execute'];
      }
    }
    throw arp.arpError('FORBIDDEN', '插件不能直接调用此服务端路径或方法', { performed: 'no' });
  }
  function create(options) {
    var runtime = options.resourceRuntime;
    var capabilities = new Map(), apps = new Map(), points = new Map();
    var changedQueued = false;
    function changed() {
      if (changedQueued) return;
      changedQueued = true;
      queueMicrotask(function () {
        changedQueued = false;
        root.NodeTypes.replacePluginTypes(nodeTypes());
        options.onChanged();
      });
    }
    function permissions() {
      var names = new Set();
      runtime.registry.listRoutes().forEach(function (route) {
        Object.values(route.methods).forEach(function (method) {
          (method.permissions || []).forEach(function (name) { names.add(name); });
        });
      });
      return Array.from(names);
    }
    function request(owner, method, input, context) {
      var caller = Object.assign({ actorId: 'plugin:' + owner, pluginId: owner, entryContext: 'global',
        incognito: !!options.incognito, permissionScope: permissions() }, context || {});
      return runtime.dispatch(method, input, caller);
    }
    function serverRequest(connectionId, method, input, context, declaredPermissions) {
      var required = serverPermissions(method, input);
      if (required.some(function (permission) {
        return declaredPermissions && !declaredPermissions.includes(permission)
          || !(context.permissionScope || []).includes(permission);
      })) throw arp.arpError('FORBIDDEN', '服务端操作必须同时获得插件声明和调用方授权', { performed: 'no' });
      return options.serverArp(connectionId, method, input, context);
    }
    function publicCapability(item) {
      var value = copy(item.definition);
      value.pluginId = item.owner;
      value.uri = item.uri;
      value.nodeType = item.definition.node ? 'plugin.' + item.owner + '.' + value.id : null;
      return value;
    }
    function nodeTypes() {
      return Array.from(capabilities.values()).filter(function (item) { return item.definition.node; }).map(function (item) {
        var definition = item.definition;
        return { type: 'plugin.' + item.owner + '.' + definition.id, pluginId: item.owner,
          capabilityId: definition.id, label: definition.label, description: definition.description,
          needsPage: false, params: [{ key: 'input', label: '输入 JSON', kind: 'textarea',
            valueFormat: 'json', editorLanguage: 'json', default: {},
            description: '参数合同：' + JSON.stringify(definition.inputSchema) }],
          output: { description: definition.description, schema: definition.outputSchema },
          replaySafe: definition.safety === 'read' };
      });
    }
    function utilities() {
      return Array.from(capabilities.values()).filter(function (item) { return item.definition.utility; }).map(function (item) {
        var definition = item.definition;
        return { id: item.owner + '.' + definition.id, pluginId: item.owner, label: definition.label,
          description: definition.description, category: '插件工具', operations: ['execute'], fields: {},
          uri: item.uri, operationUris: { execute: item.uri }, inputSchema: definition.inputSchema,
          permissions: definition.permissions.slice(),
          nodeType: definition.node ? 'plugin.' + item.owner + '.' + definition.id : null };
      });
    }
    function appTemplates() {
      return Array.from(apps.values()).map(function (item) {
        return { pluginId: item.owner, id: item.id, name: item.input.name, description: item.input.description || '' };
      });
    }
    function contributions() {
      return { capabilities: Array.from(capabilities.values()).map(publicCapability),
        nodes: nodeTypes(), utilities: utilities(), apps: appTemplates() };
    }
    function routeRoot(owner) { return 'plugin-' + owner; }
    function refreshRoutes(owner) {
      var name = routeRoot(owner), handlers = { GET: {}, POST: {} }, routes = [];
      capabilities.forEach(function (item) {
        if (item.owner !== owner) return;
        var def = item.definition, uri = item.uri;
        routes.push(root.ResourceModuleSupport.route({ template: uri, resourceType: 'PluginCapability', relation: name + '-' + def.id,
          summary: def.label + '：' + def.description, tags: ['plugin', owner], methods: {
            GET: root.ResourceModuleSupport.read(root.ResourceModuleSupport.EMPTY_QUERY, 'plugins.read', name + '-' + def.id, '读取能力参数合同'),
            POST: { inputSchema: def.inputSchema,
              outputSchema: { type: 'object', properties: { value: def.outputSchema }, required: ['value'], additionalProperties: false },
              safety: def.safety, idempotency: 'keyed', execution: 'sync', permissions: def.permissions,
              preconditions: [], summary: def.description, relation: name + '-' + def.id },
          } }));
        handlers.GET[uri] = function (req) {
          return { statusCode: 200, primary: { uri: req.uri, type: 'PluginCapability', data: publicCapability(item) } };
        };
        handlers.POST[uri] = async function (req, context) {
          if (!item.active) fail('插件能力已释放');
          var controller = new AbortController(), upstream = context.abortSignal;
          var abort = function () { controller.abort(upstream.reason); };
          if (upstream) { upstream.addEventListener('abort', abort, { once: true }); if (upstream.aborted) abort(); }
          item.calls.add(controller);
          try {
            controller.signal.throwIfAborted();
            var callContext = Object.assign({}, context, { abortSignal: controller.signal });
            var value = await item.execute(copy(req.body), {
              signal: controller.signal,
              idempotencyKey: req.idempotencyKey,
              // Nested operations retain the application's/assistant's authorization.
              arp: function (method, input, signal) { return runtime.dispatchNested(method, input, context, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal); },
              serverArp: function (connectionId, method, input) { return serverRequest(connectionId, method, input, callContext, item.permissionScope); },
            });
            controller.signal.throwIfAborted();
            return { statusCode: 200, primary: { uri: req.uri, type: 'PluginResult', data: { value: value === undefined ? null : value } },
              receipt: { performed: def.safety === 'read' ? 'no' : 'yes' } };
          } finally {
            item.calls.delete(controller);
            if (upstream) upstream.removeEventListener('abort', abort);
          }
        };
      });
      // Validate before replacing the existing adapter, so a bad addition is atomic.
      var adapter = routes.length ? root.ResourceModuleAdapter.create({ root: name, resource: { routeContracts: routes, handlers: handlers } }) : null;
      if (adapter) arp.createResourceRegistry().register(adapter);
      runtime.registry.unregister(name);
      delete runtime.adapters[name];
      if (adapter) { runtime.registry.register(adapter); runtime.adapters[name] = adapter; }
      changed();
    }
    function registerCapability(owner, input, permissionScope) {
      var key = owner + '.' + id(input.id);
      if (capabilities.has(key)) throw new Error('插件能力重复: ' + key);
      if (typeof input.execute !== 'function') throw new TypeError('插件能力必须提供 execute');
      if (!input.inputSchema || input.inputSchema.type !== 'object') throw new TypeError('插件能力必须声明 object inputSchema');
      var def = copy({ id: input.id, label: input.label || input.id, description: input.description || '',
        inputSchema: input.inputSchema, outputSchema: input.outputSchema === undefined ? {} : input.outputSchema,
        permissions: input.permissions || ['plugins.execute'], safety: input.safety || 'execute',
        node: !!input.node, utility: !!input.utility });
      if (def.utility && def.safety !== 'read') throw new TypeError('utility 必须是无业务副作用的计算能力，safety 为 read');
      if (!Array.isArray(def.permissions) || !def.permissions.length) throw new TypeError('能力必须声明权限');
      def.permissions = root.SystemRuntimePermissions.normalizePluginPermissions(['plugins.execute'].concat(def.permissions));
      // A sandboxed capability can also call ctx.pageAgent or schedule work without a callId.
      // Require its entire declared scope up front so those paths cannot elevate its caller.
      if (permissionScope) def.permissions = root.SystemRuntimePermissions.normalizePluginPermissions(def.permissions.concat(permissionScope));
      var item = { owner: owner, definition: def, execute: input.execute, active: true, calls: new Set(),
        permissionScope: permissionScope,
        uri: '/' + routeRoot(owner) + '/capabilities/' + input.id };
      capabilities.set(key, item);
      try { refreshRoutes(owner); }
      catch (error) { capabilities.delete(key); throw error; }
      return function () {
        item.active = false;
        item.calls.forEach(function (controller) { controller.abort(new Error('插件能力已释放')); });
        capabilities.delete(key); refreshRoutes(owner);
      };
    }
    function defineExtensionPoint(name, install) {
      if (points.has(name) || typeof install !== 'function') throw new Error('扩展点重复或无效: ' + name);
      points.set(name, install);
    }
    defineExtensionPoint('capability', registerCapability);
    defineExtensionPoint('node', function (owner, definition, permissionScope) { return registerCapability(owner, Object.assign({}, definition, { node: true }), permissionScope); });
    defineExtensionPoint('utility', function (owner, definition, permissionScope) {
      return registerCapability(owner, Object.assign({}, definition, { utility: true, safety: 'read' }), permissionScope);
    });
    defineExtensionPoint('resource', function (owner, adapter) {
      if (adapter.root === 'plugins' || adapter.root.startsWith('plugin-')) throw new Error('此资源根路径由插件宿主管理');
      runtime.registry.register(adapter); runtime.adapters[adapter.root] = adapter; changed();
      return function () {
        if (runtime.registry.getAdapter(adapter.root) !== adapter) return;
        runtime.registry.unregister(adapter.root); delete runtime.adapters[adapter.root]; changed();
      };
    });
    defineExtensionPoint('app', function (owner, definition) {
      var key = owner + '.' + id(definition.id);
      if (apps.has(key)) throw new Error('插件应用模板重复: ' + key);
      var input = copy(definition.input);
      var contract = runtime.registry.resolve('/apps', 'POST').methodContract;
      var validation = arp.validateJsonSchema(contract.inputSchema, input);
      if (!validation.valid) throw new TypeError('应用模板无效: ' + validation.errors.join('; '));
      root.AppContract.validateCode(input.code, input.generationScope || root.AppContract.CAPABILITIES);
      apps.set(key, { owner: owner, id: definition.id, input: input }); changed();
      return function () { apps.delete(key); changed(); };
    });
    function bind(owner, ctx, signal, permissionScope, base) {
      var signals = new WeakMap();
      function active(caller) {
        caller = caller || ctx;
        caller.scope.assertActive(); signal.throwIfAborted();
        if (!caller.scope.isActive) throw new Error('插件作用域已停止');
      }
      function scopedSignal(caller) {
        active(caller);
        if (signals.has(caller.scope)) return signals.get(caller.scope);
        var controller = new AbortController();
        var abort = function () { controller.abort(signal.reason); };
        caller.effect(function () {
          signal.addEventListener('abort', abort, { once: true });
          return function () {
            signal.removeEventListener('abort', abort);
            controller.abort(new Error('插件作用域已释放'));
            signals.delete(caller.scope);
          };
        });
        signals.set(caller.scope, controller.signal);
        return controller.signal;
      }
      function extend(point, definition) {
        var caller = this && this.ctx || ctx;
        active(caller);
        var install = points.get(point);
        if (!install) throw new Error('未知宿主扩展点: ' + point);
        return caller.effect(function () { return install(owner, definition, permissionScope); });
      }
      var service = {
        ctx: ctx,
        arp: function (method, input, signal) {
          var scopeSignal = scopedSignal(this.ctx);
          return request(owner, method, input, { abortSignal: signal ? AbortSignal.any([scopeSignal, signal]) : scopeSignal,
            permissionScope: permissionScope || permissions() });
        },
        conversation: function (command, input) {
          if (owner !== 'messaging' && base !== 'messaging') throw new Error('平台对话通道仅供平台消息插件及其副本使用');
          return options.conversationCommand(command, copy(input), scopedSignal(this.ctx), owner);
        },
        serverArp: function (connectionId, method, input, signal) {
          var scopeSignal = scopedSignal(this.ctx);
          return serverRequest(connectionId, method, input, { actorId: 'plugin:' + owner,
            permissionScope: permissionScope || permissions(),
            abortSignal: signal ? AbortSignal.any([scopeSignal, signal]) : scopeSignal }, permissionScope);
        },
        extend: extend,
        registerResource: function (adapter) { return extend.call(this, 'resource', adapter); },
        registerCapability: function (definition) { return extend.call(this, 'capability', definition); },
        registerNode: function (definition) { return extend.call(this, 'node', definition); },
        registerUtility: function (definition) { return extend.call(this, 'utility', definition); },
        registerApp: function (definition) { return extend.call(this, 'app', definition); },
        get utilities() {
          var caller = this.ctx;
          return {
            list: function () { active(caller); return { tools: copy(root.OfflineToolCatalog.tools).concat(utilities()) }; },
            execute: function (tool, input) {
              var abortSignal = scopedSignal(caller);
              var item = capabilities.get(tool);
              if (item && item.definition.utility) return call(item.owner, item.definition.id, input, { abortSignal: abortSignal }).then(function (value) {
                return { tool: tool, operation: 'execute', value: value };
              });
              return options.utilityService.execute(tool, input, { signal: abortSignal });
            },
          };
        },
        get events() {
          var caller = this.ctx;
          return {
            on: function (name, listener) {
              active(caller);
              var channel = 'page-agent:' + name + (name === 'messaging:dispatch' || name === 'messaging:unmatched' ? ':' + owner : '');
              return caller.on(channel, function (event) {
                if (signal.aborted) return;
                return Promise.resolve().then(function () { return listener(event); }).catch(function (error) {
                  console.error('[Page Agent plugin event]', owner, name, error);
                });
              });
            },
            emit: function (name, data) { active(caller); options.emit('page-agent:' + name, { pluginId: owner, data: data }); },
          };
        },
        listen: function (event, listener) {
          var caller = this.ctx;
          active(caller);
          var args = Array.prototype.slice.call(arguments, 2);
          return caller.effect(function () {
            function receive() { if (!signal.aborted) return listener.apply(null, arguments); }
            event.addListener.apply(event, [receive].concat(args));
            return function () { event.removeListener(receive); };
          });
        },
        get signal() { return scopedSignal(this.ctx); },
      };
      Object.defineProperty(service, root.Cordis.Service.tracker, { value: { associate: 'pageAgent', property: 'ctx' } });
      return service;
    }
    async function call(owner, name, input, context) {
      var item = capabilities.get(id(owner) + '.' + id(name));
      if (!item || !item.active) fail('插件能力不存在或未启用: ' + owner + '/' + name);
      var response = await request(owner, 'POST', { uri: item.uri, body: input === undefined ? {} : input, idempotencyKey: crypto.randomUUID() }, context);
      return unwrap(response).value;
    }
    return {
      bind: bind, request: request, call: call, contributions: contributions, utilities: utilities,
      defineExtensionPoint: defineExtensionPoint,
      utility: function (key) { var item = capabilities.get(key); return item && item.definition.utility ? publicCapability(item) : null; },
      node: function (type) { return nodeTypes().find(function (definition) { return definition.type === type; }); },
      createApp: function (owner, name) {
        var item = apps.get(id(owner) + '.' + id(name));
        if (!item) fail('应用模板不存在或插件未启用');
        // A user-created copy owns its data and remains after the provider is disabled.
        var input = copy(item.input); delete input.slug;
        return request(owner, 'POST', { uri: '/apps', body: input, idempotencyKey: crypto.randomUUID() }).then(unwrap);
      },
    };
  }
  root.PageAgentPluginHost = Object.freeze({ create: create, id: id });
})(globalThis);
