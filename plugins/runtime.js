// Builtin and user plugin definitions, settings and Cordis lifecycle.
(function (root) {
  'use strict';
  function create(options) {
    var ctx = new root.Cordis.Context(), records = new Map(), definitions = new Set(), saved = {}, queue = Promise.resolve(), seenMessages = new Set();
    var storageKey = 'page_agent_plugins_' + (options.incognito ? 'incognito' : 'regular');
    var userOptions = Object.assign({}, options, { onError: stopOnError }), sources = new Map();
    async function builtinDefinition(record) {
      var manifest = record.manifest;
      if (!manifest.sourcePath) throw new Error('此内置插件未提供源码');
      if (!sources.has(manifest.id)) {
        sources.set(manifest.id, fetch(chrome.runtime.getURL(manifest.sourcePath)).then(function (response) {
          if (!response.ok) throw new Error('读取内置插件源码失败');
          return response.text();
        }).catch(function (error) { sources.delete(manifest.id); throw error; }));
      }
      var entry = manifest.sourcePath.split('/').pop();
      return { id: manifest.id, name: manifest.name, description: manifest.description || '', enabled: record.enabled, priority: record.priority,
        base: manifest.id === 'messaging' ? 'messaging' : undefined, config: record.config,
        configSchema: manifest.configSchema || { type: 'object' }, entry: entry, files: { [entry]: await sources.get(manifest.id) },
        permissions: [], capabilities: [], subscriptions: [] };
    }
    function emit(name, data) {
      ctx.parallel(name, data).catch(function (error) { console.error('[Page Agent plugin event]', error); });
    }
    var host = root.PageAgentPluginHost.create(Object.assign({}, options, {
      emit: emit,
    }));
    ctx.provide('pageAgent');
    function changed() { options.onChanged(); }
    ctx.on('internal/status', function () { changed(); queueMicrotask(disableFailedPlugins); });
    ctx.on('internal/error', function (error) { console.error('[Page Agent plugins]', error); changed(); });
    options.plugins.forEach(function (entry) {
      root.PageAgentPluginHost.id(entry.id);
      if (records.has(entry.id) || definitions.has(entry.plugin) || !entry.plugin || entry.apiVersion !== 1) throw new Error('无效或重复的内置插件清单: ' + entry.id);
      definitions.add(entry.plugin);
      records.set(entry.id, { manifest: entry, enabled: false, priority: entry.priority || 0, config: {}, outer: null, instance: null, error: '' });
    });
    function state(record) {
      if (record.error) return 'failed';
      if (!record.enabled) return 'disabled';
      var scope = executionScope(record);
      if (!scope) return 'loading';
      return ['pending', 'loading', 'active', 'failed', 'disabled'][scope.status] || 'pending';
    }
    function executionScope(record) {
      var instance = record.instance;
      if (!instance) return record.outer && record.outer.runtime;
      return instance.runtime.hasError || !instance.runtime.isForkable ? instance.runtime : instance;
    }
    function summary(record, details) {
      var manifest = record.manifest, scope = executionScope(record);
      var error = record.error || scope && scope.error && (scope.error.message || String(scope.error)) || '';
      return { id: manifest.id, name: manifest.name || manifest.id, version: manifest.version || '',
        description: manifest.description || '', source: manifest.source || 'builtin', base: manifest.base || '', hasSource: manifest.source === 'user' || !!manifest.sourcePath, enabled: record.enabled, revision: record.revision || 1,
        priority: record.priority,
        conversationId: saved[manifest.id] && saved[manifest.id].conversationId || '',
        state: state(record), error: error ? details ? error : record.enabled ? '插件异常，请在配置中心查看详情' : '插件异常，已停用，请在配置中心查看详情' : '',
        configSchema: manifest.configSchema || { type: 'object' } };
    }
    function get(id) {
      var record = records.get(id);
      if (!record) throw root.AgentResourceProtocol.arpError('RESOURCE_NOT_FOUND', '插件不存在: ' + id);
      return record;
    }
    function validateConfig(record, value) {
      var result = root.AgentResourceProtocol.validateJsonSchema(record.manifest.configSchema || { type: 'object' }, value);
      if (!result.valid) throw new TypeError(result.errors.join('; '));
      return JSON.parse(JSON.stringify(value));
    }
    function validatePriority(value) {
      if (!Number.isSafeInteger(value)) throw new TypeError('消息处理优先级必须是安全整数');
      return value;
    }
    async function dispatchMessage(message) {
      var ordered = Array.from(records.values()).sort(function (a, b) { return b.priority - a.priority; });
      for (var record of ordered) {
        if (!record.enabled) continue;
        // Cordis owns each plugin's subscriptions and releases them on unload.
        if (await ctx.serial('page-agent:messaging:dispatch:' + record.manifest.id, message)) return;
      }
      // Offer unmatched messages only after every plugin has declined normal dispatch.
      for (var record of ordered) {
        if (!record.enabled) continue;
        if (await ctx.serial('page-agent:messaging:unmatched:' + record.manifest.id, message)) return;
      }
    }
    function messagingPermissions() {
      var permissions = new Set();
      function requireRoute(uri, method) {
        var route = options.resourceRuntime.registry.resolve(uri, method);
        if (route && route.methodContract) route.methodContract.permissions.forEach(function (permission) { permissions.add(permission); });
        var match = /^\/plugin-([^/]+)\/capabilities\/([^/]+)$/.exec(uri);
        var definition = match && saved[match[1]] && saved[match[1]].definition;
        if (definition && definition.capabilities.some(function (capability) { return capability.id === match[2]; })) {
          definition.permissions.forEach(function (permission) { permissions.add(permission); });
        }
      }
      Object.values(root.PageAgentMessagingPlugin.resourceTypes).forEach(function (type) {
        requireRoute(type.uri, 'GET'); requireRoute(type.uri + '/example', 'GET');
      });
      ['/plugins/contributions', '/agent-settings', '/apps/example/published/actions'].forEach(function (uri) { requireRoute(uri, 'GET'); });
      ['/conversations', '/flows/example/runs', '/scripts/example/runs', '/apps/example/open',
        '/apps/example/actions/example/runs', '/runs/example/stop'].forEach(function (uri) { requireRoute(uri, 'POST'); });
      root.OfflineToolCatalog.tools.forEach(function (tool) {
        requireRoute(tool.uri, 'GET');
        Object.values(tool.operationUris).forEach(function (uri) { requireRoute(uri, 'POST'); });
      });
      host.contributions().capabilities.forEach(function (capability) { requireRoute(capability.uri, 'POST'); });
      return Array.from(permissions);
    }
    function withMessagingPermissions(definition, context) {
      var permissions = root.SystemRuntimePermissions.normalizePluginPermissions(definition.permissions.concat(definition.base === 'messaging' ? messagingPermissions() : []));
      if (context && permissions.some(function (permission) { return !(context.permissionScope || []).includes(permission); })) {
        throw root.AgentResourceProtocol.arpError('FORBIDDEN', '插件权限不能超过当前调用方权限');
      }
      return Object.assign({}, definition, { permissions: permissions });
    }
    function unload(record) {
      if (record.outer) record.outer.dispose();
      record.outer = null; record.instance = null;
    }
    function stopOnError(id, error, signal) {
      if (signal && signal.aborted) return;
      var record = records.get(id);
      if (!record || !record.enabled) return;
      var manifest = record.manifest;
      record.enabled = false;
      record.error = '插件异常，已自动停用：' + (error && error.message || String(error));
      // Release registrations immediately; persist through the existing mutation queue.
      unload(record); changed();
      mutate(async function () {
        if (records.get(id) !== record || record.manifest !== manifest || record.enabled) return;
        var revision = record.revision + 1;
        var settings = Object.assign({}, saved[id], { enabled: false, error: record.error, revision: revision });
        if (settings.definition) settings.definition = Object.assign({}, settings.definition, { enabled: false });
        var next = Object.assign({}, saved, { [id]: settings });
        await options.storageArea.set({ [storageKey]: next });
        saved = next; record.revision = revision; changed();
      }).catch(function (failure) {
        if (records.get(id) === record && record.manifest === manifest && !record.enabled) {
          record.error += '；停用状态保存失败：' + failure.message; changed();
        }
        console.error('[Page Agent plugin disable]', failure);
      });
    }
    function disableFailedPlugins() {
      records.forEach(function (record, id) {
        if (record.manifest.source !== 'user' || !record.enabled) return;
        var scope = executionScope(record);
        if (record.error || scope && scope.hasError) stopOnError(id, record.error || scope.error);
      });
    }
    function load(record) {
      record.error = '';
      if (!record.enabled) return;
      try {
        record.outer = ctx.plugin({
          name: 'page-agent-host-' + record.manifest.id,
          apply: function (parent) {
            var scope = parent.isolate('pageAgent'), controller = new AbortController();
            scope.on('dispose', function () { controller.abort(new Error('插件已停用或重新配置')); });
            scope.set('pageAgent', host.bind(record.manifest.id, scope, controller.signal, record.manifest.permissions, record.manifest.base));
            record.instance = scope.plugin(record.manifest.plugin, JSON.parse(JSON.stringify(record.config)));
          },
        });
      } catch (error) { record.error = error.message; unload(record); disableFailedPlugins(); }
    }
    var initialized = options.storageArea.get(storageKey).then(async function (stored) {
      saved = stored[storageKey] || {};
      // Preserve existing source and configuration when upgrading to files.
      var migrated = false;
      if (saved.messaging && saved.messaging.config && Object.prototype.hasOwnProperty.call(saved.messaging.config, 'rules')) {
        saved.messaging = Object.assign({}, saved.messaging, { config: {}, revision: (saved.messaging.revision || 1) + 1 });
        migrated = true;
      }
      for (var id of Object.keys(saved)) {
        var definition = saved[id].definition;
        if (definition && Array.isArray(definition.permissions)) {
          var permissions = root.SystemRuntimePermissions.normalizePluginPermissions(definition.permissions);
          if (JSON.stringify(permissions) !== JSON.stringify(definition.permissions)) {
            definition.permissions = permissions;
            saved[id].revision = (saved[id].revision || 1) + 1;
            migrated = true;
          }
        }
        if (!definition || definition.files || (!definition.javascript && definition.base !== 'messaging')) continue;
        var settings = Object.assign({}, saved[id], { revision: (saved[id].revision || 1) + 1 });
        try {
          if (definition.javascript) settings.definition = root.PageAgentUserPlugin.validate(definition);
          else {
            var builtin = await builtinDefinition(get('messaging'));
            settings.definition = Object.assign({}, definition, { entry: builtin.entry, files: builtin.files, configSchema: builtin.configSchema });
          }
        } catch (error) {
          settings.enabled = false; settings.error = '读取插件源码失败：' + error.message;
          settings.definition = Object.assign({}, definition, { enabled: false });
        }
        saved[id] = settings; migrated = true;
      }
      if (migrated) await options.storageArea.set({ [storageKey]: saved });
      Object.keys(saved).forEach(function (id) {
        if (records.has(id) || !saved[id].definition) return;
        try {
          var manifest = root.PageAgentUserPlugin.manifest(saved[id].definition, userOptions);
          if (manifest.id !== id) throw new Error('保存的插件 ID 不一致');
          records.set(id, { manifest: manifest, enabled: false, priority: manifest.priority, config: {}, outer: null, instance: null, error: '' });
        } catch (error) {
          records.set(id, { manifest: { id: id, name: id, source: 'user' }, enabled: false, priority: 0, config: {}, error: error.message });
        }
      });
      records.forEach(function (record, id) {
        var settings = saved[id] || {};
        record.revision = settings.revision || 1;
        record.enabled = settings.enabled === undefined ? record.manifest.enabled !== false : settings.enabled === true;
        if (!record.manifest.plugin) return;
        try {
          record.priority = validatePriority(settings.priority === undefined ? record.manifest.priority || 0 : settings.priority);
          record.config = validateConfig(record, settings.config === undefined ? record.manifest.config || {} : settings.config);
          load(record);
        }
        catch (error) { record.error = error.message; }
        if (!record.enabled && settings.error) record.error = settings.error;
      });
      disableFailedPlugins();
      changed();
    }).catch(function (error) {
      records.forEach(function (record) { record.error = '插件配置加载失败: ' + error.message; });
      console.error('[Page Agent plugins]', error); changed();
    });
    var ready = initialized.then(function () { return ctx.start(); }).then(changed).catch(function (error) {
      console.error('[Page Agent plugin startup]', error); changed();
    });
    async function update(id, input, context) {
      await initialized;
      var record = get(id);
      if (input.revision !== undefined && input.revision !== record.revision) throw root.AgentResourceProtocol.arpError('PRECONDITION_FAILED', '插件已变化，请重新读取');
      if (typeof input.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值');
      var config = validateConfig(record, input.config);
      var priority = validatePriority(input.priority === undefined ? record.priority : input.priority);
      var revision = record.revision + 1;
      var settings = Object.assign({}, saved[id], { enabled: input.enabled, priority: priority, config: config, revision: revision, error: '' });
      if (settings.definition) settings.definition = withMessagingPermissions(Object.assign({}, settings.definition, { enabled: input.enabled, priority: priority, config: config }), context);
      var manifest = settings.definition ? root.PageAgentUserPlugin.manifest(settings.definition, userOptions) : record.manifest;
      var next = Object.assign({}, saved, { [id]: settings });
      await options.storageArea.set({ [storageKey]: next });
      saved = next; unload(record); record.manifest = manifest; record.enabled = input.enabled; record.priority = priority; record.config = config; record.revision = revision; load(record);
      changed();
      return summary(record);
    }
    function mutate(work) {
      var operation = queue.then(function () { return initialized; }).then(work);
      queue = operation.catch(function () {}); return operation;
    }
    async function saveDefinition(id, input, context) {
      var definition = Object.assign({}, input); delete definition.revision;
      definition = root.PageAgentUserPlugin.validate(definition);
      if (!definition.files && !definition.base && !definition.capabilities.length && !definition.subscriptions.length) {
        definition.entry = 'index.js'; definition.files = { 'index.js': root.PageAgentPluginSource.blank };
      }
      definition = withMessagingPermissions(definition, context);
      var previous = id ? get(id) : null;
      if (previous && (previous.manifest.source !== 'user' || definition.id !== id)) throw root.AgentResourceProtocol.arpError('FORBIDDEN', '只能更新自建插件且不能修改 ID');
      if (previous && input.revision !== previous.revision) throw root.AgentResourceProtocol.arpError('PRECONDITION_FAILED', '插件已变化，请重新读取后更新');
      if (!previous && records.has(definition.id)) throw root.AgentResourceProtocol.arpError('RESOURCE_CONFLICT', '插件 ID 已存在');
      if (!previous && Array.from(records.values()).filter(function (record) { return record.manifest.source === 'user'; }).length >= 20) throw new Error('最多保存 20 个自建插件');
      // Reject invalid handlers before replacing the saved definition or unloading a working plugin.
      await root.PageAgentUserPlugin.checkSyntax(definition, options, context.abortSignal);
      var manifest = root.PageAgentUserPlugin.manifest(definition, userOptions), revision = previous ? previous.revision + 1 : 1;
      var conversationId = !String(context.actorId || context.actor || '').startsWith('ui:') && context.conversationId;
      var next = Object.assign({}, saved, { [definition.id]: { definition: definition, config: definition.config, enabled: definition.enabled, priority: definition.priority, revision: revision,
        conversationId: conversationId || saved[definition.id] && saved[definition.id].conversationId || '' } });
      await options.storageArea.set({ [storageKey]: next });
      if (previous) unload(previous);
      saved = next;
      var record = { manifest: manifest, enabled: definition.enabled, priority: definition.priority, config: definition.config, revision: revision, outer: null, instance: null, error: '' };
      records.set(definition.id, record); load(record); changed();
      return summary(record);
    }
    return {
      initialized: initialized, ready: ready, host: host,
      list: function () { return Array.from(records.values()).map(function (record) { return summary(record); }); },
      settings: function (id) { var record = get(id); return Object.assign(summary(record, true), { config: JSON.parse(JSON.stringify(record.config)) }); },
      definition: async function (id) {
        var record = get(id);
        return Object.assign(summary(record, true), { config: JSON.parse(JSON.stringify(record.config)),
          definition: saved[id] && saved[id].definition ? Object.assign(JSON.parse(JSON.stringify(saved[id].definition)), { priority: record.priority }) : await builtinDefinition(record) });
      },
      saveDefinition: function (id, input, context) { return mutate(function () { return saveDefinition(id, input, context); }); },
      copy: function (id, input, context) { return mutate(async function () {
        var record = get(id);
        if (input.revision !== record.revision) throw root.AgentResourceProtocol.arpError('PRECONDITION_FAILED', '插件已变化，请重新读取');
        var definition = saved[id] && saved[id].definition;
        if (!definition) definition = await builtinDefinition(record);
        return saveDefinition(null, Object.assign({}, definition, { id: input.id, name: input.name, enabled: false, priority: record.priority, config: record.config }), context);
      }); },
      bindConversation: function (id, conversationId, previousConversationId) { return mutate(async function () {
        var record = get(id);
        if (typeof conversationId !== 'string' || conversationId.length > 240) throw new TypeError('无效的话题 ID');
        var settings = saved[id] || {};
        if (previousConversationId !== undefined && previousConversationId !== (settings.conversationId || '')) throw new Error('插件关联已变化，请重新打开');
        var next = Object.assign({}, saved, { [id]: Object.assign({}, settings, { conversationId: conversationId }) });
        await options.storageArea.set({ [storageKey]: next });
        saved = next; changed(); return summary(record);
      }); },
      remove: function (id, revision) { return mutate(async function () {
        var record = get(id);
        if (record.manifest.source !== 'user') throw root.AgentResourceProtocol.arpError('FORBIDDEN', '不能删除内置插件');
        if (revision !== record.revision) throw root.AgentResourceProtocol.arpError('PRECONDITION_FAILED', '插件已变化，请重新读取');
        var next = Object.assign({}, saved); delete next[id];
        await options.storageArea.set({ [storageKey]: next });
        saved = next; unload(record); records.delete(id); changed(); return { id: id, deleted: true };
      }); },
      update: function (id, input, context) {
        return mutate(function () { return update(id, input, context); });
      },
      emitHostEvent: function (event) {
        emit('page-agent:host:' + event.type, { data: event });
        if (event.type !== 'messaging' || !event.message) return;
        var key = event.connectionId + ':' + event.message.id;
        if (seenMessages.has(key)) return;
        seenMessages.add(key); if (seenMessages.size > 1000) seenMessages.delete(seenMessages.values().next().value);
        var message = { pluginId: 'messaging', data: Object.assign({ connectionId: event.connectionId }, event.message) };
        emit('page-agent:messaging:message', message);
        dispatchMessage(message).catch(function (error) { console.error('[Page Agent message dispatch]', error); });
      },
    };
  }
  root.PageAgentPluginRuntime = Object.freeze({ create: create });
})(globalThis);
