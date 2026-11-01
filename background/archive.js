(function (root) {
  'use strict';
  var SECTIONS = ['pages', 'scripts', 'flows', 'flowGroups', 'schedules', 'urlTriggers'];
  var FIELDS = { pageId: 'pages', targetPageId: 'pages', scriptId: 'scripts', flowId: 'flows', targetFlowId: 'flows',
    flowGroupId: 'flowGroups', assistantId: 'assistants', defaultAssistantId: 'assistants',
    modelServiceId: 'models', defaultModelServiceId: 'models', serviceId: 'models' };
  var ROOTS = { pages: 'pages', scripts: 'scripts', flows: 'flows', 'flow-groups': 'flowGroups',
    assistants: 'assistants', 'model-services': 'models', schedules: 'schedules', 'url-triggers': 'urlTriggers' };
  var KEY = 'archive_state';
  var BOOT_KEY = 'archive_browser_session';
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function fail(message, code) { throw root.AgentResourceProtocol.arpError(code || 'RESOURCE_CONFLICT', message); }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!record(value)) return value;
    var out = Object.create(null);
    Object.keys(value).sort().forEach(function (key) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('配置包含无效属性', 'INVALID_REQUEST');
      out[key] = stable(value[key]);
    });
    return out;
  }
  function clean(item) {
    var out = clone(item);
    ['createdAt', 'updatedAt', 'credentialMetadata', 'mcpValidation'].forEach(function (key) { delete out[key]; });
    Object.keys(out).filter(function (key) { return key.startsWith('__builtin'); }).forEach(function (key) { delete out[key]; });
    return out;
  }
  async function hash(value) { return (await root.AgentResourceProtocol.sha256(JSON.stringify(stable(value)))).replace(/^sha256:/, ''); }
  function dictionary(items) {
    var out = Object.create(null);
    items.forEach(function (item) {
      if (!record(item) || typeof item.id !== 'string' || !item.id || Object.prototype.hasOwnProperty.call(out, item.id)) fail('配置条目 ID 缺失或重复');
      out[item.id] = clean(item);
    });
    return out;
  }
  function pick(value, fields) {
    var out = {};
    fields.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = clone(value[key]); });
    return out;
  }
  function rewrite(value, maps, connections, inspect) {
    if (Array.isArray(value)) return value.map(function (entry) { return rewrite(entry, maps, connections, inspect); });
    if (!record(value)) return value;
    var out = clone(value);
    Object.keys(out).forEach(function (key) {
      var section = FIELDS[key], raw = out[key];
      if (key === 'groupId' && ['flowGroup', 'flow-group'].includes(value.taskType || value.targetKind || value.kind || value.type)) section = 'flowGroups';
      if (section && typeof raw === 'string' && raw) {
        if (/\{\{|\$\{/.test(raw)) return;
        var prefix = section === 'flows' && raw.startsWith('user:') ? 'user:' : '';
        var id = prefix ? raw.slice(5) : raw;
        if (inspect) inspect(section, id);
        if (maps[section] && maps[section][id]) out[key] = prefix + maps[section][id];
      } else if (key === 'uri' && typeof raw === 'string') {
        if (/\{\{|\$\{/.test(raw)) return;
        out[key] = raw.replace(/^\/(pages|scripts|flows|flow-groups|assistants|model-services|schedules|url-triggers)\/([^/?]+)(.*)$/, function (_, section, encoded, tail) {
          var id = decodeURIComponent(encoded), kind = ROOTS[section];
          if (inspect) inspect(kind, id);
          return '/' + section + '/' + encodeURIComponent(maps[kind] && maps[kind][id] || id) + tail;
        });
        if (connections) out[key] = out[key].replace(/^\/(local\/)?connections\/([^/?]+)(.*)$/, function (_, local, encoded, tail) {
          var target = connections[decodeURIComponent(encoded)];
          if (!target) fail('缺少目标连接绑定: ' + encoded);
          tail = tail.replace(/^\/workspaces\/([^/?]+)/, function (_, workspace) {
            var id = target.workspaces[decodeURIComponent(workspace)];
            if (!id) fail('缺少目标目录绑定: ' + workspace);
            return '/workspaces/' + encodeURIComponent(id);
          });
          return '/' + (local || '') + 'connections/' + encodeURIComponent(target.id) + tail;
        });
      } else out[key] = rewrite(raw, maps, connections, inspect);
    });
    if (typeof value.connectionId === 'string' && value.connectionId && !/\{\{|\$\{/.test(value.connectionId) && connections) {
      var target = connections[value.connectionId];
      if (!target) fail('缺少目标连接绑定: ' + value.connectionId);
      out.connectionId = target.id;
      if (value.workspaceId && !/\{\{|\$\{/.test(value.workspaceId)) {
        if (!target.workspaces[value.workspaceId]) fail('缺少目标目录绑定: ' + value.workspaceId);
        out.workspaceId = target.workspaces[value.workspaceId];
      }
    }
    return out;
  }
  function create(options) {
    var agent = options.agentConfigurationService, chrome = options.chrome;
    var stateKey = KEY + (options.incognito ? '_incognito' : '');
    var bootKey = BOOT_KEY + (options.incognito ? '_incognito' : '');
    var manualKey = bootKey + '_manual';
    var busy = false, recoveryPending = true, startupPending = true, sessionPromise, captureQueue = Promise.resolve();
    var resolveBinding;
    var bindingReady = new Promise(function (resolve) { resolveBinding = resolve; });
    async function state() { return (await chrome.storage.local.get(stateKey))[stateKey] || { maps: {} }; }
    var ready = state().then(function (stored) {
      recoveryPending = !!stored.operation && ['applying', 'failed'].includes(stored.operation.status);
    });
    async function exclusive(task, kind) {
      if (busy) fail('配置操作正在进行，请稍后重试', 'RESOURCE_BUSY');
      busy = kind;
      try { await ready; return await task(); }
      finally { busy = false; }
    }
    function save(value) { return chrome.storage.local.set({ [stateKey]: value }); }
    async function session() {
      if (!sessionPromise) sessionPromise = (async function () {
        var value = (await chrome.storage.session.get(bootKey))[bootKey];
        if (!value) { value = { id: crypto.randomUUID(), completed: false }; await chrome.storage.session.set({ [bootKey]: value }); }
        return value;
      })();
      return sessionPromise;
    }
    async function finishBoot(bootId) {
      var boot = await session();
      if (bootId !== boot.id || boot.completed) return;
      var completed = Object.assign({}, boot, { completed: true });
      await chrome.storage.session.set({ [bootKey]: completed });
      boot.completed = true; startupPending = false;
    }
    function protocol() { return Object.assign({ version: options.configuration().applicationVersion }, root.McpContract.CONFIGURATION); }
    async function configuredConnection(connectionId) {
      if (!connectionId || !(await options.connection().store.load()).connections[connectionId]) return null;
      return options.connection().getConnection(connectionId);
    }
    async function compatibility(connectionId) {
      var connection = await configuredConnection(connectionId);
      var local = protocol(), remote = connection && connection.capabilities && connection.capabilities.configuration;
      var reason = !connection || !connection.enabled ? 'CONNECTION_DISABLED' : !connection.ready ? 'CONNECTION_NOT_READY'
        : root.McpContract.configurationCompatibility(local, remote);
      var incompatible = !!connection && connection.ready && !!reason;
      if (incompatible && options.binding() && options.binding().connectionId === connectionId && !options.configuration().syncTarget) {
        await options.disableAutoSync(reason);
        await finishBoot((await session()).id);
      }
      return { compatible: reason ? incompatible ? false : null : true, reason: reason,
        clientVersion: local.version, serverVersion: connection && connection.serverVersion || null };
    }
    async function manualOperation(connectionId) {
      var grant = (await chrome.storage.session.get(manualKey))[manualKey];
      return grant && grant.connectionId === connectionId && options.target(connectionId)
        && grant.bucketId === options.target(connectionId).bucketId ? grant.operationId : null;
    }
    async function revokeManual(operationId) {
      var grant = (await chrome.storage.session.get(manualKey))[manualKey];
      if (grant && grant.operationId === operationId) await chrome.storage.session.remove(manualKey);
    }
    async function authorize(context, syncOnly, operationId) {
      var target = context && options.target(context.sourceConnectionId), binding = options.binding();
      if (!target || !context
          || context.sourcePrincipalTransport !== 'system' || context.sourcePrincipal !== 'archive') fail('此连接尚未配置同步和备份', 'FORBIDDEN');
      var connection = await options.connection().getConnection(target.connectionId);
      if (!connection || !connection.ready) fail('配置连接尚未就绪', 'TEMPORARILY_UNAVAILABLE');
      if (!connection.arpPermissions.read || syncOnly && !connection.arpPermissions.write) fail('配置连接权限不足', 'FORBIDDEN');
      if (syncOnly) {
        if ((await compatibility(target.connectionId)).compatible !== true) fail('同步版本不兼容', 'VERSION_INCOMPATIBLE');
        var manualId = await manualOperation(target.connectionId);
        var automatic = options.autoSyncEnabled() && binding && binding.connectionId === target.connectionId;
        if (!(operationId && manualId === operationId) && !automatic) fail('此操作未获得手动同步授权，自动同步已关闭', 'FORBIDDEN');
      }
      return connection;
    }
    async function all(method) {
      var items = [], cursor;
      do { var page = await method({ limit: 100, ...(cursor ? { cursor: cursor } : {}) }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
      return items;
    }
    async function injectModelApiKeys() {
      var keys = options.modelApiKeys();
      if (!Object.keys(keys).length) return;
      var stored = await state(), logicalIds = Object.create(null);
      Object.entries(stored.maps && stored.maps.models || {}).forEach(function (entry) { logicalIds[entry[1]] = entry[0]; });
      for (var model of await all(agent.listModelServices)) {
        var logicalId = logicalIds[model.id];
        var apiKey = keys[model.id] || logicalId && keys[logicalId];
        if (apiKey) await agent.patchModelService(model.id, { secret: { apiKey: apiKey } });
      }
    }
    async function read() {
      var config = await options.configStore.getConfig();
      var models = await all(agent.listModelServices), assistants = await all(agent.listAssistants);
      var settings = await agent.getAgentSettings(), stored = await state();
      var reverse = {};
      Object.keys(stored.maps || {}).forEach(function (section) {
        reverse[section] = Object.create(null);
        Object.keys(stored.maps[section]).forEach(function (id) { reverse[section][stored.maps[section][id]] = id; });
      });
      function module(section, values) {
        var items = Object.create(null);
        values.forEach(function (item) {
          if (item.__builtin || item.builtIn) return;
          var id = reverse[section] && reverse[section][item.id] || item.id;
          if (Object.prototype.hasOwnProperty.call(items, id)) fail('本机资源 ID 与同步配置的逻辑 ID 冲突: ' + id);
          items[id] = rewrite(clean(item), reverse, null); items[id].id = id;
        });
        return { items: items, order: Object.keys(items).sort() };
      }
      var modules = {};
      SECTIONS.forEach(function (section) {
        modules[section] = module(section, section === 'urlTriggers' ? config[section] || [] : Object.values(config[section] || {}));
      });
      var modelItems = module('models', models).items;
      modules.modelSettings = { value: { version: 1, services: Object.values(modelItems), agentSettings: rewrite(settings, reverse, null) } };
      modules.assistants = module('assistants', assistants);
      var connections = await options.connection().store.load();
      var bindings = Object.values(connections.connections).sort(function (a, b) { return a.id.localeCompare(b.id); }).map(function (entry) {
        return { id: entry.id, builtinId: entry.builtinId || '', url: entry.url,
          workspaces: entry.workspaces.map(function (workspace) { return pick(workspace, ['id', 'kind', 'alias', 'path']); }) };
      });
      var value = { package: { kind: 'pfa-full-backup', version: 7, modules: modules },
        sourceClientId: connections.clientId, extensionVersion: protocol().version, connections: bindings };
      return { backup: value, fingerprint: await hash(value) };
    }
    async function capture(context) {
      var work = captureQueue.then(function () { return exclusive(async function () {
        await authorize(context, false);
        if (recoveryPending) fail('上次配置应用未完成，请先恢复操作', 'RESOURCE_BUSY');
        var first = await read(), second = await read();
        if (first.fingerprint !== second.fingerprint) fail('备份期间配置发生变化，请重试', 'RESOURCE_BUSY');
        if (new TextEncoder().encode(JSON.stringify(first)).byteLength > 1024 * 1024) fail('备份超过 1 MiB；请缩减备份范围', 'PAYLOAD_TOO_LARGE');
        return first;
      }, 'capture'); });
      captureQueue = work.catch(function () {});
      return work;
    }
    async function status(connectionId) {
      var current = await state(), boot = await session(), binding = options.binding();
      var target = connectionId ? options.target(connectionId) : binding;
      var sameSource = target && current.connectionId === target.connectionId && current.bucketId === target.bucketId;
      var source = binding && await configuredConnection(binding.connectionId);
      var autoSyncEnabled = options.autoSyncEnabled() && (!!options.configuration().syncTarget || !!source && source.enabled);
      startupPending = autoSyncEnabled && !boot.completed;
      // Existing sync protocol peers require enabled in the wire status.
      return { enabled: true, autoSyncEnabled: autoSyncEnabled, syncVersion: options.configuration().syncVersion,
        binding: binding, bootId: boot.id, startupCompleted: boot.completed,
        versionId: sameSource ? current.versionId || null : null, operation: current.operation || null, applying: busy === 'apply',
        recoveryConnectionId: recoveryPending ? current.connectionId : null, recoveryPending: recoveryPending, startupPending: startupPending };
    }
    async function apply(input, context) {
      return exclusive(function () { return applyLocked(input, context); }, 'apply');
    }
    async function applyLocked(input, context) {
      var connection = await authorize(context, true, input.operationId);
      if (await options.hasRunningWork()) fail('当前有运行中的任务，请稍后同步配置', 'RESOURCE_BUSY');
      var binding = options.target(context.sourceConnectionId), stored = await state();
      root.McpContract.id(input.operationId); root.McpContract.id(input.versionId);
      if (input.bucketId !== binding.bucketId) fail('同步桶名不匹配');
      if (await manualOperation(binding.connectionId) !== input.operationId && input.versionId !== options.configuration().syncVersion) {
        fail('自动同步版本与启动设置不一致', 'FORBIDDEN');
      }
      var backupHash = await hash(input.backup);
      if (stored.operation && stored.operation.id === input.operationId) {
        if (stored.operation.versionId !== input.versionId || stored.operation.backupHash !== backupHash) fail('同一恢复操作不能变更版本内容');
        if (stored.operation.status === 'complete') { await finishBoot(input.bootId); await revokeManual(input.operationId); recoveryPending = false; return status(); }
      } else if (recoveryPending) fail('上次配置应用未完成，请先重试操作: ' + stored.operation.id, 'RESOURCE_BUSY');
      var resuming = stored.operation && stored.operation.id === input.operationId && stored.operation.status === 'failed';
      if (stored.operation && stored.operation.id === input.operationId && stored.operation.status === 'applying') resuming = true;
      var sameSource = stored.bucketId === binding.bucketId && stored.serverId === connection.serverId && stored.connectionId === binding.connectionId;
      if (!resuming && (await read()).fingerprint !== input.expectedFingerprint) fail('备份后本地配置已变化，请重新备份', 'PRECONDITION_FAILED');
      var backup = clone(input.backup);
      stable(backup);
      if (!backup.package || backup.package.kind !== 'pfa-full-backup' || backup.package.version !== 7) fail('不支持的备份格式');
      var modules = backup.package.modules;
      var allowed = SECTIONS.concat(['modelSettings', 'assistants']);
      if (!record(modules) || Object.keys(modules).some(function (key) { return !allowed.includes(key); }) || allowed.some(function (key) { return !record(modules[key]); })) fail('备份模块不完整或不受支持');
      var source = {};
      SECTIONS.concat(['assistants']).forEach(function (section) {
        if (!record(modules[section].items)) fail('配置模块缺少 items: ' + section);
        source[section] = modules[section].items;
      });
      if (!record(modules.modelSettings.value) || !Array.isArray(modules.modelSettings.value.services)) fail('模型配置无效');
      source.models = dictionary(modules.modelSettings.value.services);
      var current = await options.configStore.getConfig();
      var existing = { models: dictionary(await all(agent.listModelServices)), assistants: dictionary(await all(agent.listAssistants)) };
      SECTIONS.forEach(function (section) { existing[section] = section === 'urlTriggers' ? dictionary(current[section] || []) : current[section] || {}; });
      var connectionState = await options.connection().store.load(), connectionMap = Object.create(null);
      (backup.connections || []).forEach(function (entry) {
        var candidates = Object.values(connectionState.connections).filter(function (item) { return entry.builtinId ? item.builtinId === entry.builtinId : item.url === entry.url; });
        if (candidates.length !== 1) return;
        var target = candidates[0], workspaces = {};
        (entry.workspaces || []).forEach(function (workspace) {
          var match = target.workspaces.find(function (item) { return workspace.kind === 'startup' ? item.kind === 'startup' : item.kind === workspace.kind && item.path === workspace.path && item.alias === workspace.alias; });
          if (match) workspaces[workspace.id] = match.id;
        });
        connectionMap[entry.id] = { id: target.id, workspaces: workspaces };
      });
      // Keep mappings for removed resources and previous buckets so returning to
      // a version restores the IDs still referenced by conversation history.
      var mappingHistory = clone(stored.mappingHistory || {});
      if (stored.serverId && stored.bucketId) {
        var previousMappingKey = await hash([stored.serverId, stored.bucketId]);
        var previousMaps = mappingHistory[previousMappingKey] || {};
        Object.keys(stored.maps || {}).forEach(function (section) {
          previousMaps[section] = Object.assign({}, previousMaps[section], stored.maps[section]);
        });
        mappingHistory[previousMappingKey] = previousMaps;
      }
      var mappingKey = await hash([connection.serverId, binding.bucketId]);
      var maps = clone(mappingHistory[mappingKey] || (sameSource ? stored.maps : null) || {}), nextMaps = {}, deleted = {};
      for (var section of Object.keys(source)) {
        nextMaps[section] = {}; deleted[section] = [];
        for (var id of Object.keys(source[section])) {
          if (!record(source[section][id]) || source[section][id].id !== id) fail('配置条目 ID 无效: ' + section + '/' + id);
          var targetId = maps[section] && maps[section][id];
          if (!targetId) {
            targetId = backup.sourceClientId === connectionState.clientId && existing[section][id]
              ? id : 'cfg_' + (await hash([connection.serverId, binding.bucketId, section, id])).slice(0, 32);
            if (existing[section][targetId] && targetId !== id) fail('目标资源已被本机配置占用: ' + targetId);
          }
          nextMaps[section][id] = targetId;
        }
        var retainedIds = new Set(Object.values(nextMaps[section]));
        deleted[section] = Object.keys(existing[section]).filter(function (id) {
          return !retainedIds.has(id) && !existing[section][id].__builtin && !existing[section][id].builtIn;
        });
      }
      if (Object.values(deleted).some(function (items) { return items.length; }) && !connection.arpPermissions.delete) fail('强制同步需要删除所选版本中不存在的配置，请开放连接删除权限', 'FORBIDDEN');
      var prepared = {};
      Object.keys(source).forEach(function (section) {
        prepared[section] = {};
        Object.keys(source[section]).forEach(function (id) {
          var item = rewrite(source[section][id], nextMaps, connectionMap);
          item.id = nextMaps[section][id]; prepared[section][item.id] = item;
        });
      });
      var next = clone(current);
      SECTIONS.forEach(function (section) {
        var values = Object.assign({}, existing[section]);
        deleted[section].forEach(function (id) { delete values[id]; });
        Object.assign(values, prepared[section]);
        next[section] = section === 'urlTriggers' ? Object.values(values) : values;
      });
      var catalogs = {};
      Object.keys(source).forEach(function (section) {
        catalogs[section] = Object.assign({}, existing[section], prepared[section]);
        deleted[section].forEach(function (id) { delete catalogs[section][id]; });
      });
      var runtimeConfig = await options.resourceService.getConfig();
      ['flows', 'pages', 'scripts', 'flowGroups'].forEach(function (section) {
        Object.keys(runtimeConfig[section] || {}).forEach(function (id) { if (runtimeConfig[section][id].__builtin) catalogs[section][id] = runtimeConfig[section][id]; });
      });
      function reference(section, id) { if (id && !catalogs[section][id]) fail('配置仍引用不存在的资源: ' + section + '/' + id); }
      Object.keys(catalogs).forEach(function (section) { Object.values(catalogs[section]).forEach(function (item) { rewrite(item, {}, null, reference); }); });
      var agentSettings = rewrite(modules.modelSettings.value.agentSettings || {}, nextMaps, null, function () {});
      rewrite(agentSettings, {}, null, reference);
      options.resourceService.validateConfiguration(Object.assign({}, next, { pages: catalogs.pages, flows: catalogs.flows }));
      Object.values(next.schedules).forEach(function (item) { options.validateSchedule(item); });
      var keys = options.modelApiKeys(), secrets = Object.create(null);
      for (var logicalId of Object.keys(source.models)) {
        var modelId = nextMaps.models[logicalId];
        var apiKey = keys[modelId] || keys[logicalId];
        if (apiKey) secrets[logicalId] = { apiKey: apiKey };
        agent.validateModelService(Object.assign({}, prepared.models[modelId], secrets[logicalId] ? { secret: secrets[logicalId] } : {}));
      }
      for (var assistant of Object.values(prepared.assistants)) {
        if (typeof assistant.name !== 'string' || !assistant.name.trim()) fail('助手名称不能为空');
        for (var skillId of assistant.skillIds || []) await options.resourceService.getSkill(skillId);
        for (var mcpId of assistant.mcpServerIds || []) await options.mcpService.getMcpServer(mcpId);
      }
      // Save the complete identity plan before the first write. Repeating an
      // interrupted operation addresses the same resources after a worker restart.
      var union = {};
      Object.keys(nextMaps).forEach(function (section) { union[section] = Object.assign({}, maps[section], nextMaps[section]); });
      mappingHistory[mappingKey] = union;
      stored.mappingHistory = mappingHistory;
      stored.bucketId = binding.bucketId; stored.maps = union;
      stored.serverId = connection.serverId; stored.connectionId = binding.connectionId;
      stored.operation = { id: input.operationId, versionId: input.versionId, backupHash: backupHash, status: 'applying', startedAt: Date.now() };
      try {
        await save(stored);
        recoveryPending = true;
        for (var logicalId of Object.keys(source.models)) {
          var modelId = nextMaps.models[logicalId];
          var model = pick(prepared.models[modelId], agent.mutableKeyContract.modelService.filter(function (key) { return key !== 'secret'; }));
          if (secrets[logicalId]) model.secret = secrets[logicalId];
          if (existing.models[modelId]) await agent.patchModelService(modelId, model);
          else await agent.createModelService(Object.assign({ id: modelId }, model), { restoring: true });
        }
        for (var assistantId of Object.keys(prepared.assistants)) {
          var assistant = pick(prepared.assistants[assistantId], agent.mutableKeyContract.assistant);
          if (existing.assistants[assistantId]) await agent.patchAssistant(assistantId, assistant);
          else await agent.createAssistant(assistant, assistantId);
        }
        if (JSON.stringify(await options.configStore.getConfig()) !== JSON.stringify(current)) fail('应用期间本地流程配置已变化，请重新刷新', 'PRECONDITION_FAILED');
        for (var removedAssistant of deleted.assistants) {
          if (existing.assistants[removedAssistant]) await agent.deleteAssistant(removedAssistant, { preserveConversations: true });
        }
        for (var removedModel of deleted.models) {
          if (existing.models[removedModel]) await agent.deleteModelService(removedModel, { preserveConversations: true });
        }
        await agent.patchAgentSettings(pick(agentSettings, agent.mutableKeyContract.agentSettings));
        // Publish the complete flow/schedule configuration only after all of its
        // model/assistant dependencies and defaults are in place.
        await options.saveConfiguration(next);
        stored.maps = nextMaps; stored.versionId = input.versionId;
        stored.operation.status = 'complete'; stored.operation.completedAt = Date.now();
        await save(stored);
        await finishBoot(input.bootId);
        await revokeManual(input.operationId);
        recoveryPending = false;
        return await status();
      } catch (error) {
        recoveryPending = true;
        stored.operation.status = 'failed'; stored.operation.error = error.message;
        await save(stored); throw error;
      }
    }
    return { capture: capture, apply: apply, status: status, session: session, compatibility: compatibility,
      authorizeManual: async function (connectionId, operationId) {
        root.McpContract.id(operationId);
        var target = options.target(connectionId);
        if (!target || (await compatibility(connectionId)).compatible !== true) fail('连接尚未就绪或同步版本不兼容');
        if (busy) fail('配置操作正在进行', 'RESOURCE_BUSY');
        var stored = await state();
        if (recoveryPending && (stored.connectionId !== connectionId || stored.operation.id !== operationId)) fail('请先恢复未完成的同步操作', 'RESOURCE_BUSY');
        await chrome.storage.session.set({ [manualKey]: { connectionId: connectionId, bucketId: target.bucketId, operationId: operationId } });
      },
      isApplying: function () { return busy === 'apply' || recoveryPending; },
      isExecutionBlocked: function () { return busy === 'apply' || recoveryPending || startupPending; },
      whenBindingReady: function () { return bindingReady; },
      initializeBinding: async function () {
        await ready;
        // A new target's credentials belong to the models it is about to load.
        if (!options.autoSyncEnabled()) await injectModelApiKeys();
        var source = options.binding() && await configuredConnection(options.binding().connectionId);
        startupPending = options.autoSyncEnabled() && (!!options.configuration().syncTarget || !!source && source.enabled) && !(await session()).completed;
        resolveBinding();
      },
      configure: async function (task, disablingOnly) {
        if (disablingOnly) {
          await task();
          await finishBoot((await session()).id);
          return;
        }
        return exclusive(async function () {
          if (recoveryPending) fail('请先重试未完成的同步操作，再修改同步源或备份目标', 'RESOURCE_BUSY');
          await task();
          // Changing a source is explicit configuration, not a browser restart.
          if (!options.configuration().syncTarget) await finishBoot((await session()).id);
        }, 'configure');
      },
      remoteStatus: async function (context) {
        await authorize(context, false);
        var negotiation = await compatibility(context.sourceConnectionId);
        var value = await status(context.sourceConnectionId), target = options.target(context.sourceConnectionId);
        if (!target) fail('此连接已取消同步和备份用途', 'FORBIDDEN');
        var autoSync = !!value.binding && value.binding.connectionId === target.connectionId;
        var recovery = value.recoveryConnectionId === target.connectionId;
        return Object.assign({}, value, { binding: target, autoSync: autoSync, backupEnabled: target.backup,
          protocol: protocol(), compatibility: negotiation, manualOperationId: await manualOperation(target.connectionId),
          startupCompleted: !autoSync || !value.autoSyncEnabled || value.startupCompleted,
          startupPending: autoSync && value.startupPending, recoveryPending: recovery,
          operation: recovery ? value.operation : null });
      },
    };
  }
  root.Archive = Object.freeze({ create: create });
})(globalThis);
