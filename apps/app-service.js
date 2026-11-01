(function (root) {
  'use strict';
  var C = root.AppContract;
  function create(options) {
    var store = options.store, resources = options.resourceService;
    var runOwners = new Map(), launching = new Map(), sweeping;
    var runStorageKey = 'app_run_owners_' + (options.incognito ? 'incognito' : 'regular');
    var bindingKey = 'app_conversation_bindings_' + (options.incognito ? 'incognito' : 'regular');
    var ready = chrome.storage.session.get(runStorageKey).then(function (value) {
      (value[runStorageKey] || []).forEach(function (item) { runOwners.set(item[0], item[1]); });
    });
    var runWrites = Promise.resolve(), bindingWrites = Promise.resolve();
    function persistRuns() {
      runWrites = runWrites.catch(function () {}).then(function () { return chrome.storage.session.set({ [runStorageKey]: Array.from(runOwners) }); });
      return runWrites;
    }
    function terminal(status) { return ['success', 'failed', 'stopped', 'completed', 'cancelled', 'interrupted'].includes(status); }
    function sweepRuns() {
      if (sweeping) return sweeping;
      sweeping = ready.then(async function () {
        var finished = [];
        for (var entry of Array.from(runOwners)) {
          try {
            var result = await resources.getRun(entry[0]);
            if (!terminal(result.status)) continue;
          } catch (error) { if (error.code !== 'RESOURCE_NOT_FOUND') continue; }
          runOwners.delete(entry[0]); finished.push({ runId: entry[0], appId: entry[1].appId });
        }
        if (finished.length) await persistRuns();
        return finished;
      }).finally(function () { sweeping = null; });
      return sweeping;
    }
    function stable(value, nested) {
      if (Array.isArray(value)) return value.map(function (item) { return stable(item, true); });
      if (!value || typeof value !== 'object') return value;
      var result = Object.create(null);
      Object.keys(value).sort().forEach(function (key) {
        if (nested || key.indexOf('__builtin') !== 0 && !['updatedAt', 'createdAt', 'mcpValidation'].includes(key)) result[key] = stable(value[key], true);
      });
      return result;
    }
    async function fingerprint(value, kind) {
      if (kind === 'connections') value = { id: value.id, url: value.url, expectedServerId: value.expectedServerId || null,
        runTabMode: value.runTabMode, workspaces: (value.workspaces || []).map(function (workspace) {
          return { id: workspace.id, kind: workspace.kind, ...(workspace.kind === 'custom' ? { path: workspace.path } : {}) };
        }).sort(function (left, right) { return left.id.localeCompare(right.id); }) };
      var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(value))));
      return Array.from(new Uint8Array(bytes), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    }
    function dependencyValue(kind, value) {
      if (kind === 'model-services') {
        value = Object.assign({}, value);
        if (!value.protocol && value.apiStyle) value.protocol = value.apiStyle;
        ['apiKey', 'headers', 'customHeaders', 'authorization', 'secret', 'credentialMetadata', 'hasApiKey', 'maskedApiKey', 'apiStyle', 'providerType', 'provider_type', 'reasoningProviderType'].forEach(function (key) { delete value[key]; });
      }
      if (kind === 'connections') {
        value = { id: value.id, alias: value.alias, url: value.url, enabled: value.enabled === true,
          expectedServerId: value.expectedServerId || null, runTabMode: value.runTabMode, desktopEnabled: value.desktopEnabled === true,
          workspaces: (value.workspaces || []).map(function (workspace) { return { id: workspace.id, kind: workspace.kind,
            alias: workspace.alias, ...(workspace.kind === 'custom' ? { path: workspace.path } : {}),
            ...(workspace.lastResolvedPath ? { lastResolvedPath: workspace.lastResolvedPath } : {}), permissions: workspace.permissions }; }) };
      }
      return value;
    }
    async function readDependency(uri) {
      var match = /^\/(flows|flow-groups|scripts|pages|knowledge|assistants|model-services|connections|apps)\/([^/?#]+)$/.exec(uri);
      if (!match) throw C.error('DEPENDENCY_UNSUPPORTED', '无法识别依赖资源: ' + uri);
      var kind = match[1], id = decodeURIComponent(match[2]), value, builtin = false;
      if (kind === 'apps') {
        var app = store.required(await store.get('app_meta', id));
        builtin = app.__builtin === true;
        value = { appId: id, name: app.name, slots: {} };
        for (var slot of Object.keys(app.slots)) value.slots[slot] = store.required(await store.get('app_code', [id, slot])).code;
      }
      else {
        var methods = { flows: 'getFlow', 'flow-groups': 'getFlowGroup', scripts: 'getScript', pages: 'getPage', knowledge: 'getKnowledge' };
        if (methods[kind]) value = await resources[methods[kind]](id);
        else value = await options.readResource(uri);
      }
      value = dependencyValue(kind, value);
      return { uri: uri, kind: kind, id: id, value: value, fingerprint: await fingerprint(value, kind), builtin: builtin || !!(value.__builtin || value.builtIn || value.protected) };
    }
    function references(item) {
      var result = [], map = { flowId: 'flows', subFlowId: 'flows', flowGroupId: 'flow-groups', scriptId: 'scripts', pageId: 'pages', pageSourceId: 'pages', assistantId: 'assistants', serviceId: 'model-services', modelServiceId: 'model-services', knowledgeId: 'knowledge', connectionId: 'connections', appId: 'apps' };
      function walk(value) {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(function (key) {
          var child = value[key];
          if (map[key] && typeof child === 'string' && child) {
            if (/\{\{|\$\{|^=/.test(child)) throw C.error('DEPENDENCY_UNRESOLVED', item.uri + ' 的 ' + key + ' 是动态引用；请使用确定的资源绑定。脚本内部的动态引用需显式声明依赖并通过固定绑定参数传入。');
            result.push('/' + map[key] + '/' + encodeURIComponent(child.replace(/^user:/, '')));
          } else if (child && typeof child === 'object') walk(child);
        });
      }
      if (item.kind !== 'apps') walk(item.value);
      else Object.values(item.value.slots || {}).forEach(function (code) { codeDependencies(code).forEach(function (dependency) { result.push(dependency.uri); }); });
      return Array.from(new Set(result));
    }
    async function collect(declarations, lookup) {
      var items = new Map(), requested = new Map();
      for (var dependency of declarations) {
        if (requested.get(dependency.uri) && dependency.fingerprint && requested.get(dependency.uri) !== dependency.fingerprint) throw C.error('DEPENDENCY_CHANGED', '两个槽位依赖不同内容: ' + dependency.uri);
        if (!requested.has(dependency.uri) || dependency.fingerprint) requested.set(dependency.uri, dependency.fingerprint);
      }
      async function visit(uri) {
        if (items.has(uri)) return;
        var item = await (lookup || readDependency)(uri);
        items.set(uri, item);
        if (requested.get(uri) && requested.get(uri) !== item.fingerprint) throw C.error('DEPENDENCY_CHANGED', '依赖内容已变化，请更新绑定后保存应用: ' + uri);
        for (var reference of references(item)) await visit(reference);
      }
      for (var uri of requested.keys()) await visit(uri);
      return Array.from(items.values());
    }
    function codeDependencies(code) {
      return C.codeDependencies(code);
    }
    async function checkCode(code, scope, lookup) {
      C.validateCode(code, scope);
      var items = await collect(codeDependencies(code), lookup);
      checkSupported(items);
      // Save the transitive execution binding; a later shared dependency change is never silently accepted.
      code.dependencies = items.map(function (item) { return { uri: item.uri, fingerprint: item.fingerprint }; });
      return code;
    }
    function checkSupported(items) {
      function walk(value) {
        if (!value || typeof value !== 'object') return;
        if (typeof value.type === 'string') C.assertNode(value);
        Object.values(value).forEach(walk);
      }
      items.forEach(function (item) { if (item.kind === 'flows') walk(item.value.nodes); });
    }
    function localPermission(meta, permission, slot, name, auth) {
      return C.checkPermission(meta, permission, slot, name, auth);
    }
    function resourceCatalog() {
      var entries = new Map();
      var labels = root.ConversationProfileSchema.create().resourcePolicyCatalog().roots;
      options.resourceRoutes().forEach(function (route) {
        Object.values(route.methods).forEach(function (method) {
          method.permissions.forEach(function (name) {
            if (entries.has(name)) return;
            var module = name.split('.')[0], label = labels.find(function (item) { return item.uri === '/' + module; });
            entries.set(name, { name: name, group: label ? label.label : module, description: method.summary || route.summary });
          });
        });
      });
      return Array.from(entries.values()).sort(function (a, b) { return a.name.localeCompare(b.name); });
    }
    function defaultResourcePermissions() {
      var defaults = root.SystemRuntimePermissions.permissions;
      return resourceCatalog().map(function (item) { return item.name; }).filter(function (name) { return defaults.includes(name); });
    }
    async function authorizeResources(auth, required) {
      return store.tx(['app_meta', 'app_permissions'], 'readonly', function (t) {
        t.get('app_meta', auth.appId, function (meta) {
          t.get('app_permissions', auth.appId, function (permission) {
            if (!meta || !permission) throw C.error('SESSION_CLOSED', '应用已删除');
            if (!meta.slots[auth.slot] || meta.slots[auth.slot].revision !== auth.revision) throw C.error('CONTENT_CHANGED', '应用已更新，请加载新内容');
            if (permission.generation !== auth.generation) throw C.error('AUTHORIZATION_CHANGED', '权限已变化，请刷新后操作');
            if (!permission.enabled) throw C.error('PERMISSION_DENIED', '用户已关闭 SDK 调用');
            var scope = permission.resources || [];
            (required || []).forEach(function (name) { if (!scope.includes(name)) throw C.error('PERMISSION_DENIED', '未授予模块权限: ' + name); });
            t.result(scope);
          });
        });
      });
    }
    async function checkAppDependency(auth, appId) {
      if (!auth) return;
      await authorizeResources(auth);
      var record = store.required(await store.get('app_code', [auth.appId, auth.slot]));
      if (record.revision !== auth.revision) throw C.error('CONTENT_CHANGED', '应用已更新，请加载新内容');
      var uri = '/apps/' + encodeURIComponent(appId);
      var dependency = record.code.dependencies.find(function (item) { return item.uri === uri; });
      var expectedRevision;
      if (dependency) {
        var target = store.required(await store.get('app_meta', appId));
        if (!target.slots.published) throw C.error('NOT_PUBLISHED', '目标应用尚未发布');
        expectedRevision = target.slots.published.revision;
        await collect(record.code.dependencies);
      }
      await authorizeResources(auth);
      return expectedRevision;
    }
    async function summary(appId) {
      var values = await store.tx(['app_meta', 'app_permissions'], 'readonly', function (t) {
        t.get('app_meta', appId, function (meta) { t.get('app_permissions', appId, function (permission) { t.result([meta, permission]); }); });
      });
      var meta = store.required(values[0]), p = values[1];
      var defaults = meta.__builtin && meta.__builtinDefaultPermissions;
      return Object.assign({}, meta, { permissions: {
        appId: appId, generationScope: p.generationScope, enabled: p.enabled, resources: p.resources || [],
        defaultEnabled: defaults ? defaults.enabled : true,
        defaultGenerationScope: defaults && defaults.generationScope ? defaults.generationScope.slice() : C.CAPABILITIES.slice(),
        defaultResources: defaults && defaults.resources !== 'system' ? defaults.resources.slice() : defaultResourcePermissions(),
        resourceCatalog: resourceCatalog(), generation: p.generation,
      }, guidance: C.guidance, links: links(appId, meta.slug) });
    }
    function readCodeLines(source, query) {
      var lines = source.split(/\r?\n/), start = (query.startLine || 1) - 1;
      var limit = query.limit || 50, budget = 12000;
      var output = { mode: 'lines', totalLines: lines.length, totalChars: source.length, hasMore: false, nextLine: null, nextColumn: null };
      function fragment(index, column, length) {
        var text = lines[index].slice(column, column + length);
        return { line: index + 1, column: column + 1, text: text, lineLength: lines[index].length, truncated: column > 0 || column + text.length < lines[index].length };
      }
      var column = (query.startColumn || 1) - 1, index = start, rows = [], used = 0;
      if (index < lines.length && column > lines[index].length) throw C.error('SCHEMA_VALIDATION_FAILED', 'startColumn 超出起始行长度');
      while (index < lines.length && rows.length < limit && used < budget) {
        var item = fragment(index, column, budget - used);
        rows.push(item); used += item.text.length + 1;
        column += item.text.length;
        if (column < lines[index].length) break;
        index++; column = 0;
      }
      output.lines = rows;
      if (index < lines.length) { output.nextLine = index + 1; output.nextColumn = column + 1; }
      output.hasMore = output.nextLine !== null;
      return output;
    }
    function links(appId, slug) {
      return { open: chrome.runtime.getURL(C.path(appId, 'published', slug).slice(1)), preview: chrome.runtime.getURL(C.path(appId, 'draft', slug).slice(1)), edit: chrome.runtime.getURL('options/options.html?section=apps&appId=' + appId + '&action=edit'), permissions: chrome.runtime.getURL('options/options.html?section=apps&appId=' + appId + '&action=permissions') };
    }
    async function authorizationState(auth) {
      var values = await store.tx(['app_meta', 'app_permissions'], 'readonly', function (t) {
        t.get('app_meta', auth.appId, function (meta) { t.get('app_permissions', auth.appId, function (permission) { t.result([meta, permission]); }); });
      });
      if (auth.execution) {
        if (!values[0] || !values[1]) throw C.error('SESSION_CLOSED', '应用已删除');
        var permission = values[1];
        // Submitted runs keep their execution snapshot. Content publication is
        // independent of revoking the grant under which that snapshot started.
        if (!permission.enabled || !permission.generationScope.includes('actions.run')
            || (permission.channelGeneration || 1) !== auth.channelGeneration) throw C.error('AUTHORIZATION_CHANGED', '本次任务的授权已撤销或调整');
      } else {
        localPermission(values[0], values[1], auth.slot, auth.permission, auth);
      }
      return values;
    }
    async function authorize(auth, operation) {
      var values = await authorizationState(auth);
      // Only dependencies still resolved live need a fresh fingerprint check.
      // Flow, script and page definitions are already fixed in the run snapshot.
      if (auth.dependencies) await collect(auth.execution ? auth.liveDependencies || [] : auth.dependencies);
      if (operation) {
        var targets = auth.targets;
        if (!targets) throw C.error('PERMISSION_DENIED', '动作缺少目标范围');
        var targetUrl = operation.url;
        if (operation.pageId) {
          if (!targets.pageIds.includes(operation.pageId)) throw C.error('PERMISSION_DENIED', '页面不在授权范围: ' + operation.pageId);
          if (!targetUrl) targetUrl = auth.pageUrls && auth.pageUrls[operation.pageId] || (await resources.getPage(operation.pageId)).url;
        }
        if (targetUrl) {
          var url = new URL(targetUrl);
          if (operation.kind === 'model') {
            var model = (await readDependency('/model-services/' + encodeURIComponent(operation.modelServiceId))).value;
            var endpoint = root.ModelSettings.buildModelEndpointUrl(model.baseUrl, model.protocol);
            if (root.ProviderCompat) endpoint = root.ProviderCompat.resolve(model, model.protocol).endpoint(endpoint);
            if (new URL(endpoint).href !== url.href || (operation.useVision && model.visionModel || model.model) !== operation.model) throw C.error('DEPENDENCY_CHANGED', '模型请求与授权绑定的配置不一致');
          } else if (!targets.origins.includes(url.origin)) throw C.error('PERMISSION_DENIED', '目标不在动作授权范围: ' + url.origin);
          if (!await chrome.permissions.contains({ origins: [url.origin + '/*'] })) throw C.error('PERMISSION_DENIED', '插件缺少目标站点权限: ' + url.origin);
        }
        if (operation.kind === 'http' && !targets.methods.includes(operation.method)) throw C.error('PERMISSION_DENIED', 'HTTP 方法不在授权范围: ' + operation.method);
        if (operation.pageId && !targets.pageIds.includes(operation.pageId)) throw C.error('PERMISSION_DENIED', '页面不在授权范围: ' + operation.pageId);
        if (operation.kind === 'page' && !targets.pageOperations.includes(operation.command)) throw C.error('PERMISSION_DENIED', '页面操作不在授权范围: ' + operation.command);
        if (operation.kind === 'page' && ['replayRequest', 'cdp.replay_request'].includes(operation.command)) throw C.error('UNSUPPORTED_CAPABILITY', '应用 SDK 尚不支持校验捕获请求的重放目标，请使用绑定最终地址的 HTTP 动作');
        if (operation.tabId) {
          var tab = await chrome.tabs.get(operation.tabId);
          if (!!tab.incognito !== !!options.incognito) throw C.error('PERMISSION_DENIED', '目标标签页与应用的普通／隐身范围不一致');
          if (String(tab.url || '').startsWith(chrome.runtime.getURL('/'))) throw C.error('PERMISSION_DENIED', '应用标签页和插件页面不能作为应用动作目标');
          var tabUrl = (!tab.url || tab.url === 'about:blank') && tab.pendingUrl ? tab.pendingUrl : tab.url;
          if (!tabUrl || !/^https?:/.test(tabUrl) || !targets.origins.includes(new URL(tabUrl).origin)
              || tab.pendingUrl && (!/^https?:/.test(tab.pendingUrl) || !targets.origins.includes(new URL(tab.pendingUrl).origin))) throw C.error('PERMISSION_DENIED', '目标标签页已导航到未授权站点');
          var tabOrigins = Array.from(new Set([tabUrl, tab.pendingUrl].filter(Boolean).map(function (value) { return new URL(value).origin + '/*'; })));
          if (!await chrome.permissions.contains({ origins: tabOrigins })) throw C.error('PERMISSION_DENIED', '插件缺少目标标签页的实际站点权限');
        }
        if (operation.kind === 'model' && !operation.modelServiceId) throw C.error('PERMISSION_DENIED', '应用动作必须明确指定已授权的 serviceId，不能隐式使用默认模型');
        if (operation.modelServiceId && !targets.modelServiceIds.includes(operation.modelServiceId)) throw C.error('PERMISSION_DENIED', '模型配置不在授权范围');
      }
      // Dependency hashing and browser lookups yield to permission changes.
      // Recheck the persisted grant after those reads, immediately before use.
      if (operation || auth.dependencies && auth.dependencies.length) values = await authorizationState(auth);
      if (operation && operation.kind === 'local' && !(values[1].resources || []).includes('local.execute')) {
        throw C.error('PERMISSION_DENIED', '未授予模块权限: local.execute');
      }
      if (operation && operation.kind === 'utility') {
        var utilityPermission = operation.command === 'list' ? 'utilities.read' : 'utilities.execute';
        if (!(values[1].resources || []).includes(utilityPermission)) throw C.error('PERMISSION_DENIED', '未授予模块权限: ' + utilityPermission);
      }
      return values;
    }
    async function action(appId, name, input, auth, expectedRevision) {
      await sweepRuns();
      var active = Array.from(runOwners.values()).filter(function (owner) { return owner.appId === appId; }).length;
      var pending = launching.get(appId) || 0, totalPending = Array.from(launching.values()).reduce(function (sum, count) { return sum + count; }, 0);
      if (active + pending >= 4 || runOwners.size + totalPending >= 16) throw C.error('RESOURCE_BUSY', '应用任务并发已满，请等待或取消现有任务');
      launching.set(appId, pending + 1);
      try { return await startAction(appId, name, input, auth, expectedRevision); }
      finally { var remaining = (launching.get(appId) || 1) - 1; if (remaining) launching.set(appId, remaining); else launching.delete(appId); }
    }
    async function startAction(appId, name, input, auth, expectedRevision) {
      var state = await summary(appId), slot = auth && auth.slot || 'published';
      var slotMeta = state.slots[slot];
      if (!slotMeta) throw C.error('NOT_PUBLISHED', '请先发布应用；草稿动作只能从预览会话调用');
      if (expectedRevision && slotMeta.revision !== expectedRevision) throw C.error('DEPENDENCY_CHANGED', '目标应用在依赖检查后已更新，请重新读取依赖');
      auth = Object.assign({ appId: appId, slot: slot, revision: slotMeta.revision, generation: state.permissions.generation }, auth || {}, { permission: 'action:' + name });
      var authorized = await authorize(auth);
      var record = store.required(await store.get('app_code', [appId, slot]));
      if (record.revision !== auth.revision) throw C.error('CONTENT_CHANGED', '应用已更新，请重新读取');
      var binding = record.code.actions.find(function (item) { return item.name === name; });
      if (!binding) throw C.error('RESOURCE_NOT_FOUND', '动作不存在: ' + name);
      C.validateExecutionDependencies(record.code);
      var validation = root.AgentResourceProtocol.validateJsonSchema(binding.inputSchema, input);
      if (!validation.valid) throw C.error('SCHEMA_VALIDATION_FAILED', validation.errors.join('; '));
      auth.dependencies = record.code.dependencies;
      auth.targets = binding.targets;
      auth.outputSchema = binding.outputSchema;
      auth.channelGeneration = authorized[1].channelGeneration || 1;
      await authorize(auth);
      var captured = await collect(auth.dependencies), appConfig = { pages: {}, flows: {}, flowGroups: {}, scripts: {} }, appNodeSets = {};
      C.validateExecutionDependencies(record.code, captured);
      captured.forEach(function (item) {
        var section = item.kind === 'flow-groups' ? 'flowGroups' : item.kind;
        if (Object.prototype.hasOwnProperty.call(appConfig, section)) appConfig[section][item.id] = item.value;
      });
      Object.keys(appConfig.flows).forEach(function (id) { appNodeSets['user:' + id] = options.buildNodes(appConfig.flows[id], appConfig); });
      auth.liveDependencies = captured.filter(function (item) { return !['flows', 'flow-groups', 'scripts', 'pages'].includes(item.kind); }).map(function (item) { return { uri: item.uri, fingerprint: item.fingerprint }; });
      auth.pageUrls = Object.create(null);
      Object.keys(appConfig.pages).forEach(function (id) { auth.pageUrls[id] = appConfig.pages[id].url; });
      await authorize(auth);
      auth.execution = true;
      var resource = /^\/(flows|flow-groups|scripts)\/([^/]+)$/.exec(binding.resource.uri);
      var body = { context: Object.assign({}, binding.context || {}, { input: input }), trigger: 'app:' + appId, appAuthorization: auth, appConfig: appConfig, appNodeSets: appNodeSets, runTabMode: 'fixedNewTab', incognito: options.incognito };
      var run;
      if (resource[1] === 'flows') run = await resources.createFlowRun(decodeURIComponent(resource[2]), body, { appAuthorization: auth });
      else if (resource[1] === 'flow-groups') run = await resources.createFlowGroupRun(decodeURIComponent(resource[2]), body, { appAuthorization: auth });
      else run = await resources.createScriptRun(decodeURIComponent(resource[2]), body, { appAuthorization: auth });
      await ready;
      var runId = run.runId || run.id;
      runOwners.set(runId, auth);
      try { await persistRuns(); } catch (error) { await resources.stopRun(runId).catch(function () {}); throw error; }
      // A revocation racing with launch must cancel the newly registered task too.
      try { await authorize(auth); } catch (error) { await resources.stopRun(runId).catch(function () {}); throw error; }
      return { id: runId, runId: runId, status: run.status || 'running', appId: appId, action: name, uri: '/runs/' + encodeURIComponent(runId) };
    }
    async function ownedRun(appId, runId, cancel) {
      await ready;
      var owner = runOwners.get(runId);
      var result = await resources.getRun(runId, { includeFinalOutput: true });
      // Script input is the trusted runner body; Flow input is user data.
      var application = result.application || result.kind === 'script' && result.input && result.input.appAuthorization;
      if ((owner || application || {}).appId !== appId) throw C.error('PERMISSION_DENIED', '该任务不属于当前应用');
      if (cancel) return resources.stopRun(runId);
      var contract = owner || application;
      if (contract && contract.outputSchema && result.status === 'success') {
        var output = result.output === undefined ? result.result : result.output;
        var validation = root.AgentResourceProtocol.validateJsonSchema(contract.outputSchema, output);
        if (!validation.valid) result = Object.assign({}, result, { outputValidation: { valid: false, errors: validation.errors } });
      }
      if (terminal(result.status) && runOwners.delete(runId)) await persistRuns();
      return { runId: runId, status: result.status, startedAt: result.startedAt, endedAt: result.endedAt, error: result.error, output: result.output === undefined ? result.result : result.output, outputValidation: result.outputValidation, uri: '/runs/' + encodeURIComponent(runId) };
    }
    async function changed(event) {
      await ready;
      for (var entry of runOwners) {
        if (event.appId && entry[1].appId !== event.appId) continue;
        try { await authorize(entry[1]); }
        catch (_) { await resources.stopRun(entry[0]).catch(function () {}); }
      }
      await sweepRuns();
    }
    async function cancelRuns(appId) {
      await sweepRuns();
      var ids = Array.from(runOwners).filter(function (entry) { return entry[1].appId === appId; }).map(function (entry) { return entry[0]; }), failures = [];
      for (var id of ids) {
        try { await resources.stopRun(id); } catch (error) { failures.push(id + ': ' + error.message); }
      }
      if (failures.length) throw C.error('APP_ERROR', '部分任务未能取消：' + failures.join('；'));
      return { requested: ids.length };
    }
    function bindConversation(conversationId, appId) {
      var operation = bindingWrites.catch(function () {}).then(async function () {
        var app = appId === null ? null : await summary(appId);
        var current = await chrome.storage.local.get(bindingKey), bindings = current[bindingKey] || {};
        if (app) bindings[conversationId] = { appId: appId, name: app.name, revision: app.revision, boundAt: Date.now() };
        else if (bindings[conversationId]) bindings[conversationId].active = false;
        await chrome.storage.local.set({ [bindingKey]: bindings });
        if (app) store.emit(appId, 'bound');
        return bindings[conversationId] || null;
      });
      bindingWrites = operation;
      return operation;
    }
    async function conversationContext(conversationId) {
      var stored = await chrome.storage.local.get(bindingKey), binding = stored[bindingKey] && stored[bindingKey][conversationId];
      if (!binding || binding.active === false) return null;
      try { return Object.assign(await summary(binding.appId), { editingSlot: 'draft' }); } catch (error) { return { appId: binding.appId, name: binding.name, unavailable: error.message }; }
    }
    async function preflightImport(item, modules, scope, plan, rebindConnections) {
      store.assertEditable(await store.get('app_meta', item.appId));
      var aliasOwner = await store.findBySlug(item.slug);
      if (aliasOwner && aliasOwner.appId !== item.appId) throw C.error('ADDRESS_CONFLICT', '导入应用别名“' + C.slug(item.slug) + '”已被应用“' + aliasOwner.name + '”使用，请先修改应用别名');
      for (var code of Object.values(item.slots)) C.validateCode(code, scope);
      var dependencies = Object.values(item.slots).flatMap(codeDependencies), conflicts = [], reuse = [], resolved = new Map();
      async function lookup(uri) {
        if (!resolved.has(uri)) resolved.set(uri, await lookupImported(uri));
        return resolved.get(uri);
      }
      async function lookupImported(uri) {
        var match = /^\/([^/]+)\/([^/]+)$/.exec(uri);
        if (!match) throw C.error('DEPENDENCY_UNRESOLVED', '无效的依赖路径: ' + uri);
        var kind = match[1], id = decodeURIComponent(match[2]), moduleId = { 'flow-groups': 'flowGroups', 'model-services': 'modelSettings', connections: 'mcpSettings' }[kind] || kind;
        var module = modules[moduleId], value = module && module.items && module.items[id];
        var selectedId = kind === 'model-services' ? 'service:' + id : id;
        if (plan && (!Object.prototype.hasOwnProperty.call(plan, moduleId) || plan[moduleId] !== null && !plan[moduleId].includes(selectedId))) module = null;
        value = module && module.items && module.items[id];
        if (kind === 'model-services') value = module && module.value && module.value.services && module.value.services.find(function (service) { return service.id === id; });
        if (kind === 'apps' && value) value = { appId: id, name: value.name, slots: value.slots };
        if (!value) return readDependency(uri);
        value = dependencyValue(kind, value);
        var hash = await fingerprint(value, kind);
        try {
          var local = await readDependency(uri);
          if (local.builtin && local.fingerprint !== hash) throw C.error('DEPENDENCY_CHANGED', '内置依赖不兼容: ' + uri);
          if (local.fingerprint !== hash) conflicts.push(uri);
          else if (kind !== 'apps') reuse.push({ module: moduleId, id: selectedId, kind: kind, resourceId: id });
        } catch (error) { if (error.code !== 'RESOURCE_NOT_FOUND') throw error; }
        return { uri: uri, kind: kind, id: id, value: value, fingerprint: hash };
      }
      if (rebindConnections) {
        // Remapped resources establish new fingerprints only from selected package content.
        for (var dependency of dependencies) {
          var match = /^\/([^/]+)\/([^/]+)$/.exec(dependency.uri);
          if (!match) continue;
          var kind = match[1], id = decodeURIComponent(match[2]), moduleId = { 'flow-groups': 'flowGroups', 'model-services': 'modelSettings', connections: 'mcpSettings' }[kind] || kind;
          var source = modules[moduleId], selectedId = kind === 'model-services' ? 'service:' + id : id;
          if (!source || !plan || !Object.prototype.hasOwnProperty.call(plan, moduleId) || plan[moduleId] !== null && !plan[moduleId].includes(selectedId)) continue;
          if (source.items && Object.prototype.hasOwnProperty.call(source.items, id) || kind === 'model-services' && source.value && (source.value.services || []).some(function (service) { return service.id === id; })) dependency.fingerprint = (await lookup(dependency.uri)).fingerprint;
        }
      }
      checkSupported(await collect(dependencies, lookup));
      var bindings = {}, actions = {};
      for (var slot of Object.keys(item.slots)) {
        var code = await checkCode(item.slots[slot], scope, lookup);
        bindings[slot] = code.dependencies;
        actions[slot] = code.actions;
      }
      var old = await store.get('app_meta', item.appId);
      return { revision: old ? old.revision : null, dataRevision: old && old.dataRevision || null, conflicts: Array.from(new Set(conflicts.concat(old ? ['/apps/' + item.appId] : []))), reuse: reuse, bindings: bindings, actions: actions };
    }
    async function remapImported(item, idMap, modules, committedApps) {
      // Normalizing an earlier app changes its content hash. Rebind only after
      // checking the complete content that this import actually committed.
      var appBindings = new Map();
      for (var dependency of Object.values(item.slots).flatMap(codeDependencies)) {
        var appMatch = /^\/apps\/([^/]+)$/.exec(dependency.uri);
        if (!appMatch || !(committedApps || []).includes(decodeURIComponent(appMatch[1])) || appBindings.has(dependency.uri)) continue;
        var importedApp = modules.apps && modules.apps.items[decodeURIComponent(appMatch[1])];
        var currentApp = await readDependency(dependency.uri);
        if (!importedApp || await fingerprint({ appId: importedApp.appId, name: importedApp.name, slots: importedApp.slots }) !== currentApp.fingerprint) throw C.error('DEPENDENCY_CHANGED', '已导入的应用依赖发生变化: ' + dependency.uri);
        appBindings.set(dependency.uri, { uri: dependency.uri, fingerprint: currentApp.fingerprint });
      }
      if (appBindings.size) Object.values(item.slots).forEach(function (code) {
        code.dependencies = code.dependencies.map(function (dependency) { return appBindings.get(dependency.uri) || dependency; });
        code.actions.forEach(function (action) { action.dependencies = (action.dependencies || []).map(function (dependency) { return appBindings.get(dependency.uri) || dependency; }); });
      });
      var referenced = new Set(Object.values(item.slots).flatMap(codeDependencies).map(function (dependency) { return dependency.uri; }));
      var changed = Object.keys(idMap || {}).some(function (id) { return idMap[id] !== id && referenced.has('/assistants/' + encodeURIComponent(id)); });
      if (!changed) {
        for (var code of Object.values(item.slots)) await checkCode(code, item.generationScope);
        return item;
      }
      if (Object.values(item.slots).some(function (code) { return code.customBehavior.length; })) throw C.error('DEPENDENCY_UNRESOLVED', '自定义代码可能含无法可靠改写的资源引用，请修正引用后再导入');
      function remap(value, key) {
        if (key === 'assistantId' && typeof value === 'string') return idMap[value] || value;
        if (Array.isArray(value)) return value.map(function (item) { return remap(item); });
        if (!value || typeof value !== 'object') return value;
        var output = Object.create(null);
        Object.keys(value).forEach(function (field) { output[field] = remap(value[field], field); });
        return output;
      }
      var fingerprints = new Map();
      for (var dependency of Object.values(item.slots).flatMap(codeDependencies)) {
        var match = /^\/([^/]+)\/([^/]+)$/.exec(dependency.uri), kind = match[1], oldId = decodeURIComponent(match[2]);
        var id = kind === 'assistants' ? idMap[oldId] || oldId : oldId, uri = '/' + kind + '/' + encodeURIComponent(id);
        if (fingerprints.has(dependency.uri)) continue;
        var current = await readDependency(uri);
        var moduleId = { 'flow-groups': 'flowGroups', 'model-services': 'modelSettings', connections: 'mcpSettings' }[kind] || kind;
        var module = modules[moduleId], expected = module && module.items && module.items[oldId];
        if (expected) {
          expected = dependencyValue(kind, remap(expected)); if (kind === 'assistants') expected.id = id;
          if (await fingerprint(expected, kind) !== current.fingerprint) throw C.error('DEPENDENCY_CHANGED', '重映射后的依赖与已写入内容不一致: ' + uri);
        } else if (dependency.fingerprint && dependency.fingerprint !== current.fingerprint) throw C.error('DEPENDENCY_CHANGED', '依赖已变化: ' + uri);
        fingerprints.set(dependency.uri, { uri: uri, fingerprint: current.fingerprint });
      }
      Object.values(item.slots).forEach(function (code) {
        code.dependencies = code.dependencies.map(function (dependency) { return fingerprints.get(dependency.uri) || dependency; });
        code.actions.forEach(function (action) {
          action.resource = fingerprints.get(action.resource.uri) || action.resource;
          action.dependencies = (action.dependencies || []).map(function (dependency) { return fingerprints.get(dependency.uri) || dependency; });
          action.context = remap(action.context || {});
        });
      });
      for (var code of Object.values(item.slots)) await checkCode(code, item.generationScope);
      return item;
    }
    async function openApp(appId, slot, input, expectedRevision, openOptions) {
      openOptions = openOptions || {};
      var meta = store.required(await store.get('app_meta', appId));
      slot = slot || (meta.slots.published ? 'published' : 'draft');
      if (!meta.slots[slot]) throw C.error(slot === 'draft' ? 'DRAFT_NOT_FOUND' : 'NOT_PUBLISHED', slot === 'draft' ? '此应用只有发布内容，请编辑并保存草稿后预览' : '请先发布应用');
      if (expectedRevision && meta.slots[slot].revision !== expectedRevision) throw C.error('DEPENDENCY_CHANGED', '目标应用在依赖检查后已更新，请重新读取依赖');
      var url = chrome.runtime.getURL(C.path(appId, slot, meta.slug).slice(1)), legacyUrl = chrome.runtime.getURL(C.path(appId, slot).slice(1));
      if (input !== undefined) url += C.launchHash(input);
      var sessionTabs = root.PageAgentAppBridge ? root.PageAgentAppBridge.tabIds(appId, slot) : [];
      var connectedTabs = root.PageAgentAppBridge ? root.PageAgentAppBridge.tabIds() : [];
      var tabs = await chrome.tabs.query(Number.isInteger(openOptions.windowId) ? { windowId: openOptions.windowId } : {});
      var tab = tabs.find(function (item) {
        if (input !== undefined || openOptions.newTab) return false;
        if (!!item.incognito !== !!options.incognito) return false;
        if (!item.pendingUrl && connectedTabs.includes(item.id)) return sessionTabs.includes(item.id);
        return [url, legacyUrl].includes(String(item.pendingUrl || item.url || '').split(/[?#]/)[0]);
      });
      if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
      else {
        var active = openOptions.active !== false;
        var windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(function (item) { return !!item.incognito === !!options.incognito; });
        var targetWindow = windows.find(function (item) { return item.id === openOptions.windowId; }) || windows.find(function (item) { return item.focused; }) || windows[0];
        if (targetWindow) tab = await chrome.tabs.create({ windowId: targetWindow.id, url: url, active: active });
        else {
          targetWindow = await chrome.windows.create({ url: url, incognito: !!options.incognito, focused: active });
          tab = targetWindow.tabs && targetWindow.tabs[0] || (await chrome.tabs.query({ windowId: targetWindow.id }))[0];
        }
        if (active) await chrome.windows.update(targetWindow.id, { focused: true });
      }
      var usage = await store.touch(appId, true);
      return Object.assign({ tabId: tab.id, url: url }, usage);
    }
    return {
      store: store, summary: summary, fingerprint: fingerprint, readDependency: readDependency, collect: collect, codeDependencies: codeDependencies, checkCode: checkCode,
      authorize: authorize, localPermission: localPermission, action: action, ownedRun: ownedRun, changed: changed, open: openApp, links: links,
      resourceCatalog: resourceCatalog, defaultResourcePermissions: defaultResourcePermissions, authorizeResources: authorizeResources, checkAppDependency: checkAppDependency,
      bindConversation: bindConversation, conversationContext: conversationContext, preflightImport: preflightImport,
      remapImported: remapImported, sweepRuns: sweepRuns, cancelRuns: cancelRuns,
      runOwner: function (runId) { return runOwners.get(runId); },
      async create(input) { input.code = await checkCode(input.code, input.generationScope === undefined ? C.CAPABILITIES : input.generationScope); input.resourcePermissions = defaultResourcePermissions(); var meta = await store.create(input); return summary(meta.appId); },
      async patchMetadata(appId, revision, input) { await store.patchMetadata(appId, revision, input); return summary(appId); },
      async save(appId, revision, input) { var p = store.required(await store.get('app_permissions', appId)); input.code = await checkCode(input.code, p.generationScope); await store.save(appId, revision, input); return summary(appId); },
      async publish(appId, revision) { var p = store.required(await store.get('app_permissions', appId)); var code = store.required(await store.get('app_code', [appId, 'draft'])); await checkCode(code.code, p.generationScope); await store.publish(appId, revision); return summary(appId); },
      async updatePermissions(appId, input) {
        if (input.resources !== undefined) {
          var names = resourceCatalog().map(function (item) { return item.name; });
          if (!Array.isArray(input.resources) || input.resources.some(function (name) { return !names.includes(name); })) throw C.error('SCHEMA_VALIDATION_FAILED', '无效的模块权限');
        }
        await store.permissions(appId, input.generation, input); return summary(appId);
      },
      async getCode(appId, slot, field, query, fileName) {
        query = query || {};
        if (field !== undefined && !Object.prototype.hasOwnProperty.call(C.codeSchema.properties, field)) throw C.error('RESOURCE_NOT_FOUND', '应用源码字段不存在：' + field);
        if (query.q !== undefined && (query.startLine !== undefined || query.startColumn !== undefined)) throw C.error('SCHEMA_VALIDATION_FAILED', '搜索使用 q；按行读取请省略 q');
        if (query.q === undefined && (query.fixedStrings !== undefined || query.caseSensitive !== undefined || query.before !== undefined || query.after !== undefined)) throw C.error('SCHEMA_VALIDATION_FAILED', '搜索选项必须与 q 一起使用');
        var record = await store.get('app_code', [appId, slot]), inherited = !record && slot === 'draft';
        if (inherited) record = await store.get('app_code', [appId, 'published']);
        store.required(record);
        var state = await summary(appId), current = state.slots[inherited ? 'published' : slot];
        if (!current || current.revision !== record.revision || inherited && state.slots.draft) throw C.error('REVISION_CONFLICT', '读取期间应用已变化，请重新读取最新源码');
        if (query.revision && query.revision !== state.revision) throw C.error('REVISION_CONFLICT', '源码读取版本已变化，请重新搜索或读取');
        if (field !== undefined) {
          var source = record.code[field], data;
          if (field === 'files') {
            var files = record.code.files || {};
            if (fileName === undefined) {
              if (Object.keys(query).some(function (key) { return key !== 'revision'; })) throw C.error('SCHEMA_VALIDATION_FAILED', '请先选择源码文件再搜索或按行读取');
              return { appId: appId, revision: state.revision, slot: slot, inheritedFromPublished: inherited, items: Object.keys(files).map(function (name) {
                return { name: name, chars: files[name].length, lines: files[name].split(/\r?\n/).length, uri: '/apps/' + appId + '/' + slot + '/files/' + name };
              }) };
            }
            C.sourceFileName(fileName);
            if (!Object.prototype.hasOwnProperty.call(files, fileName)) throw C.error('RESOURCE_NOT_FOUND', '应用源码文件不存在: ' + fileName);
            source = files[fileName];
          }
          if (typeof source !== 'string') {
            if (Object.keys(query).some(function (key) { return key !== 'revision'; })) throw C.error('SCHEMA_VALIDATION_FAILED', '此字段不是文本，不支持搜索或按行读取参数');
            data = { value: source };
          } else if (query.q !== undefined) {
            var matcher;
            try { matcher = root.KnowledgeSearch.createGrep(Object.assign({}, query, { query: query.q, perItemLimit: query.limit })); }
            catch (error) { throw C.error('SCHEMA_VALIDATION_FAILED', error.message); }
            data = matcher.search(source);
          } else data = readCodeLines(source, query);
          return Object.assign({ appId: appId, revision: state.revision, slot: slot, field: field, inheritedFromPublished: inherited }, fileName === undefined ? {} : { fileName: fileName }, data);
        }
        return Object.assign({}, state, { code: record.code, slot: slot, inheritedFromPublished: inherited });
      }
    };
  }
  root.AppService = Object.freeze({ create: create });
})(globalThis);
