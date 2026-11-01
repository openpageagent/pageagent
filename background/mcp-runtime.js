(function (root) {
  'use strict';
  var c = root.McpContract;
  function createMcpRuntime(deps) {
    var chrome = deps.chrome || root.chrome, clients = new Map(), pairing = new Map(), queue = Promise.resolve(), syncScheduled = false;
    var store = root.McpConnectionStore.create({ chrome: chrome, disconnect: disconnect, onChange: function (value) {
      // Tighten live permissions immediately; network setup must not delay revocation.
      clients.forEach(function (client, id) {
        if (pairing.has(id)) return;
        var connection = c.own(value.connections, id) && value.connections[id];
        if (!connection || !connection.enabled || connection.migrationRepair || client.getStatus().clientInfo.clientId !== value.clientId) disconnect(id, 'grant_revoked');
        else client.update(connection);
      });
      if (syncScheduled) return; syncScheduled = true;
      Promise.resolve().then(function () { syncScheduled = false; return initClient(); }).catch(function (error) { deps.addLog(error.message, { scope: 'mcp', level: 'error' }); });
    } });
    function notify() { if (deps.onChange) deps.onChange(); }
    function getClient(id) { c.id(id); return clients.get(id) || null; }
    function disconnect(id, stopReason) {
      var attempt = pairing.get(id); if (attempt) attempt.cancelled = true;
      var client = clients.get(id); if (client) { client.disconnect(undefined, stopReason); clients.delete(id); }
    }
    function info(value, network) { return { clientId: value.clientId, clientName: value.clientName,
      extensionId: chrome.runtime.id, incognito: !!chrome.extension.inIncognitoContext,
      version: chrome.runtime.getManifest().version, userAgent: String(network && network.userAgent || '').slice(0, 300) }; }
    function createClient(connection, clientInfo) {
      var client = root.WebSocketClient.createWebSocketClient({ connection: connection, clientInfo: clientInfo,
        arp: root.AgentResourceProtocol, dispatchResource: deps.dispatchResource, createTrustedContext: deps.createTrustedContext,
        getCredential: function () { return store.getCredential(connection.id); },
        saveCredential: function (value) { return store.saveCredential(connection.id, value, connection.url); },
        validatePairing: async function (serverId) {
          var value = await store.load(), current = value.connections[connection.id];
          if (!current || current.configRevision !== connection.configRevision || value.clientId !== clientInfo.clientId)
            c.fail('AUTHORIZATION_CHANGED', '配对期间连接配置已变化，请重新打开配对', 'AUTHORIZATION_CHANGED');
          if (Object.values(value.connections).some(function (other) { return other.id !== connection.id && other.expectedServerId === serverId; }))
            c.fail('SERVER_ALREADY_CONFIGURED', '此服务端已经存在连接，请在原连接中配对', 'RESOURCE_CONFLICT');
        },
        bind: function (response) { return store.bind(connection.id, response, connection.url, clientInfo.clientId,
          response.token ? connection.configRevision : undefined); },
        confirm: function (response, style, serverId, url, serverName) { return store.confirm(connection.id, response, style, serverId, url, serverName); },
        onChange: notify, onExecutionState: deps.onExecutionState,
        onResetTargets: function () { if (deps.onResetTargets) deps.onResetTargets(connection.id); } });
      clients.set(connection.id, client); return client;
    }
    function initClient(options) {
      options = options || {};
      var work = queue.then(async function () {
        if (deps.beforeConnect) await deps.beforeConnect();
        var network = await deps.prepareNetwork(); var value = await store.load();
        if (deps.migrate) { await deps.migrate(value); value = await store.load(); }
        var clientInfo = info(value, network);
        for (var id of Array.from(clients.keys())) if (!pairing.has(id) && (!c.own(value.connections, id) || !value.connections[id].enabled || options.reconnect)) disconnect(id);
        for (var connection of Object.values(value.connections)) {
          if (!connection.enabled || connection.migrationRepair || pairing.has(connection.id)) continue;
          var client = clients.get(connection.id);
          if (!client) { client = createClient(connection, clientInfo); client.connect(); }
          else {
            var previous = client.getStatus().clientInfo;
            client.update(connection, JSON.stringify(previous) === JSON.stringify(clientInfo) ? null : clientInfo);
          }
        }
        notify(); return value;
      }); queue = work.catch(function () {}); return work;
    }
    async function publicConnection(id) {
      var value = await store.load();
      if (!c.own(value.connections, id)) return null;
      var credential = await store.getCredential(id);
      var config = value.connections[id], client = clients.get(id), status = client ? client.getStatus() : {};
      // A previous pairing remains recorded when its credentials need replacement.
      var paired = !!config.expectedServerId;
      var needsPairing = !credential || credential.clientId !== value.clientId || credential.serverId !== config.expectedServerId
        || ['pairing-required', 'revoked', 'identity-conflict'].includes(status.state);
      var isPairing = pairing.has(id);
      var info = status.serverInfo || {}, configured = status.configured || {};
      function observed(sample) {
        return sample ? Object.assign({}, sample, { stale: status.state !== 'ready' || Date.now() >= Date.parse(sample.expiresAt) }) : null;
      }
      return Object.assign({}, config, { kind: 'mcp-websocket', clientId: value.clientId, clientName: value.clientName, paired: paired, needsPairing: needsPairing,
        state: isPairing ? 'pairing' : config.enabled ? status.state || (needsPairing ? 'pairing-required' : 'disconnected') : paired ? 'disabled' : 'pairing-required', reason: status.reason || null,
        connected: config.enabled && !isPairing && !!status.connected, ready: config.enabled && !isPairing && status.state === 'ready', connecting: config.enabled && !isPairing && !!status.connecting,
        retryCount: status.retryCount || 0, retryLimit: status.retryLimit || 20, incognito: !!chrome.extension.inIncognitoContext,
        owner: { scope: 'extension-profile', incognito: !!chrome.extension.inIncognitoContext },
        serverId: status.serverId || config.expectedServerId || null, platform: info.platform || null,
        serverName: status.serverInfo ? info.serverName || null : config.serverName || null, serverVersion: info.version || null,
        links: [{ rel: 'clients', href: '/connections/' + encodeURIComponent(id) + '/clients', method: 'GET' }],
        capabilities: info.capabilities || null, environment: info.environment || null,
        observations: status.observations ? { historical: status.state !== 'ready', memory: observed(status.observations.memory),
          disks: Object.fromEntries(Object.entries(status.observations.disks).map(function (entry) { return [entry[0], observed(entry[1])]; })) } : null,
        acceptedRevision: configured.acceptedRevision || null,
        workspaces: config.workspaces.map(function (entry) {
          var confirmed = (configured.workspaces || []).find(function (item) { return item.id === entry.id; });
          var ready = config.enabled && !isPairing && status.state === 'ready' && configured.acceptedRevision === config.grantRevision;
          var invalid = ready && confirmed && confirmed.state === 'invalid';
          return Object.assign({}, entry, { configRevision: config.configRevision, connectionId: id,
            resolvedPath: confirmed && confirmed.resolvedPath || entry.lastResolvedPath || null,
            state: invalid ? 'invalid' : entry.needsAuthorization ? 'changed' : ready && confirmed ? confirmed.state : 'unverified',
            reason: invalid ? confirmed.reason : entry.migrationPending ? 'LEGACY_WORKSPACE_REPAIR_REQUIRED' : entry.needsAuthorization ? 'WORKSPACE_REAUTHORIZATION_REQUIRED' : confirmed && confirmed.reason || (!ready ? 'CONNECTION_NOT_READY' : null),
            effectivePermissions: ready && confirmed && !entry.needsAuthorization ? confirmed.effectivePermissions : c.closedPermissions() });
        }) });
    }
    async function listConnections() {
      var value = await store.load();
      var order = value.order.filter(function (id) { return c.own(value.connections, id); });
      Object.keys(value.connections).forEach(function (id) { if (!order.includes(id)) order.push(id); });
      return Promise.all(order.map(publicConnection));
    }
    function canDiscover(context) { return !!context && Array.isArray(context.permissionScope) && (context.permissionScope.includes('local.execute') || context.permissionScope.includes('*')); }
    function assertContext(context, id) {
      if (!canDiscover(context)) c.fail('LOCAL_PERMISSION_DENIED', '当前调用者没有 local.execute 权限', 'FORBIDDEN');
      if (context.sourceConnectionId && context.sourceConnectionId !== id) c.fail('CROSS_CONNECTION_FORWARDING_DISABLED', '外部请求不能跨服务端转发', 'FORBIDDEN');
    }
    function projection(connection) {
      var capabilities = connection.capabilities || {}, audit = capabilities.audit || {};
      var ready = connection.ready && audit.available === true;
      var base = '/local/connections/' + encodeURIComponent(connection.id);
      return Object.assign({}, connection, { allowed: ready, reason: !connection.ready ? connection.reason || 'CONNECTION_NOT_READY' : !audit.available ? 'AUDIT_UNAVAILABLE' : null,
        links: [{ rel: 'self', href: base, method: 'GET' }, ...connection.links, ...(ready ? [{ rel: 'environment', href: base + '/environment', method: 'GET' }] : [])],
        desktop: { supported: !!(capabilities.desktop && capabilities.desktop.supported), allowed: ready && connection.desktopEnabled && !!(capabilities.desktop && capabilities.desktop.supported),
          actions: capabilities.desktop && capabilities.desktop.actions || {},
          links: ready && connection.desktopEnabled ? c.DESKTOP_OPERATIONS.filter(function (name) { return capabilities.desktop && capabilities.desktop.actions[name]; })
            .map(function (name) { return { rel: name, href: base + '/desktop/' + name, method: 'POST' }; }) : [] },
        workspaces: connection.workspaces.map(function (workspace) {
          var path = base + '/workspaces/' + encodeURIComponent(workspace.id);
          var operations = ready && workspace.state === 'ready' ? Object.keys(c.DIRECTORY_OPERATIONS).filter(function (name) {
            return workspace.effectivePermissions[c.DIRECTORY_OPERATIONS[name]] && (name !== 'bash' || capabilities.bash && capabilities.bash.supported)
              && (name !== 'locate' || connection.desktopEnabled && capabilities.desktop && capabilities.desktop.actions.locate);
          }) : [];
          return Object.assign({}, workspace, { operations: operations, links: [{ rel: 'self', href: path, method: 'GET' }]
            .concat(operations.map(function (name) { return { rel: name, href: path + '/' + name, method: 'POST' }; }))
            .concat(ready && Object.values(workspace.effectivePermissions).some(Boolean) ? [{ rel: 'disk', href: path + '/disk', method: 'GET' }] : []) });
        }) });
    }
    async function discover(context, id, workspaceId) {
      if (!canDiscover(context)) c.fail('LOCAL_PERMISSION_DENIED', '没有本地能力发现权限', 'FORBIDDEN');
      if (context.appAuthorization) await root.PageAgentApps.authorize(context.appAuthorization, { kind: 'local', command: 'discover' });
      if (context.appResourceSession) await root.PageAgentApps.authorizeResources(context.appResourceSession, ['local.execute']);
      if (id) {
        assertContext(context, id); var connection = await publicConnection(id);
        if (!connection) c.fail('CONNECTION_NOT_FOUND', '连接不存在', 'RESOURCE_NOT_FOUND');
        var projected = projection(connection);
        if (!workspaceId) return projected;
        var workspace = projected.workspaces.find(function (item) { return item.id === workspaceId; });
        if (!workspace) c.fail('WORKSPACE_NOT_FOUND', '目录不存在', 'RESOURCE_NOT_FOUND');
        return Object.assign({}, workspace, { serverId: connection.serverId, connectionAlias: connection.alias, grantRevision: connection.grantRevision });
      }
      return (await listConnections()).filter(function (item) { return !context.sourceConnectionId || item.id === context.sourceConnectionId; }).map(projection);
    }
    async function target(operation, requested, context, expected) {
      if (!requested || !requested.connectionId) c.fail('TARGET_REQUIRED', '必须明确指定连接和目录');
      assertContext(context, requested.connectionId);
      var connection = await discover(context, requested.connectionId);
      var needsDirectory = c.own(c.DIRECTORY_OPERATIONS, operation) || operation === 'disk';
      if (needsDirectory && !requested.workspaceId) c.fail('TARGET_REQUIRED', '此操作必须明确指定目录');
      if (!needsDirectory && requested.workspaceId) c.fail('DESKTOP_HAS_NO_WORKSPACE');
      if (!connection.ready) c.fail('CONNECTION_NOT_READY', '连接未就绪: ' + connection.state, 'TEMPORARILY_UNAVAILABLE');
      if (!connection.allowed) c.fail('AUDIT_UNAVAILABLE', '服务端审计不可用', 'TEMPORARILY_UNAVAILABLE');
      var workspace = requested.workspaceId && connection.workspaces.find(function (item) { return item.id === requested.workspaceId; });
      if (needsDirectory && !workspace) c.fail('WORKSPACE_NOT_FOUND', '目录不存在', 'RESOURCE_NOT_FOUND');
      if (workspace && workspace.state !== 'ready') c.fail('WORKSPACE_CHANGED', '目录尚未确认或需要重新授权', 'DEPENDENCY_CHANGED');
      if (workspace && (operation === 'disk' ? !Object.values(workspace.effectivePermissions).some(Boolean) : !workspace.operations.includes(operation))) c.fail('WORKSPACE_PERMISSION_DENIED', '所选目录未授权此操作', 'FORBIDDEN');
      if (c.DESKTOP_OPERATIONS.includes(operation) && (!connection.desktop.allowed || !connection.desktop.actions[operation])) c.fail('DESKTOP_PERMISSION_DENIED', '桌面操作不支持或未授权', 'FORBIDDEN');
      var snapshot = { connectionId: connection.id, serverId: connection.serverId, ...(workspace ? { workspaceId: workspace.id, resolvedPath: workspace.resolvedPath } : {}) };
      var binding = expected || context.localTarget && context.localTarget.connectionId === snapshot.connectionId
        && (context.localTarget.workspaceId || null) === (snapshot.workspaceId || null) && context.localTarget;
      if (binding && (binding.serverId !== snapshot.serverId || (binding.resolvedPath || null) !== (snapshot.resolvedPath || null))) c.fail('WORKSPACE_CHANGED', '运行绑定的目标身份或目录已变化，请重新绑定', 'DEPENDENCY_CHANGED');
      return { connection: connection, workspace: workspace, snapshot: snapshot, client: getClient(connection.id) };
    }
    async function caller(context) {
      async function safe(value) { if (!value) return null; value = String(value); return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ? value : root.AgentResourceProtocol.sha256(value); }
      return { kind: context.sourceConnectionId ? 'external' : context.appAuthorization || context.appResourceSession || context.appSession ? 'app' : context.runId ? 'flow'
        : context.trustedConnectionUi ? 'ui' : 'agent', actorId: await safe(context.actorId) || 'runtime',
        conversationId: await safe(context.conversationId), runId: await safe(context.runId), parentRequest: context.parentRequest || null };
    }
    async function execute(operation, input, options) {
      options = options || {}; var context = options.context || {};
      var resolved = await target(operation, options.target, context, options.expectedTarget);
      if (operation === 'desktop') return resolved.connection;
      var frame = { grantRevision: resolved.connection.grantRevision, caller: await caller(context) };
      if (resolved.workspace) Object.assign(frame, { workspaceId: resolved.workspace.id, workingDirectory: resolved.workspace.resolvedPath });
      try { return await resolved.client.callLocal(operation, input, { frame: frame, signal: options.signal }); }
      catch (error) { throw root.AgentResourceProtocol.arpError(error.code || 'UPSTREAM_FAILED', error.message, { performed: error.performed || 'no', retryable: false,
        details: { reason: error.reason, execution: error.execution, receipt: error.receipt, result: error.result, audit: error.audit,
          target: Object.assign({}, resolved.snapshot, { alias: resolved.connection.alias, workspaceAlias: resolved.workspace && resolved.workspace.alias || null }),
          transportSessionId: error.transportSessionId || null, requestId: error.requestId || null } }); }
    }
    async function environment(targetValue, context, refresh, signal, expectedTarget) {
      var resolved = await target(targetValue.workspaceId ? 'disk' : 'environment', targetValue, context, expectedTarget);
      var frame = { scope: targetValue.workspaceId ? 'workspace' : 'server', refresh: refresh === true, caller: await caller(context) };
      if (resolved.workspace) Object.assign(frame, { workspaceId: resolved.workspace.id, workingDirectory: resolved.workspace.resolvedPath, grantRevision: resolved.connection.grantRevision });
      try {
        var data = await resolved.client.getEnvironment(frame, { signal: signal });
        var description = root.ServerInfoDescription;
        return Object.assign({}, data, { description: description.text(resolved.workspace
          ? description.disk(data.disk) : description.environment(resolved.connection, data)) });
      }
      catch (error) { throw root.AgentResourceProtocol.arpError(error.code || 'UPSTREAM_FAILED', error.message, { performed: 'no', retryable: false,
        details: { reason: error.reason, audit: error.audit, target: resolved.snapshot } }); }
    }
    async function callServerArp(connectionId, method, request, context) {
      context = context || {};
      try {
        if (context.sourceConnectionId) c.fail('NESTED_CLIENT_FORWARDING_DISABLED', '转发进入的请求不能再次调用其他客户端', 'FORBIDDEN');
        var connection = await publicConnection(connectionId), client = getClient(connectionId);
        if (!connection || !connection.ready || !client) c.fail('CONNECTION_NOT_READY', '服务端连接未就绪', 'TEMPORARILY_UNAVAILABLE');
        return await client.callArp(method, request, { caller: await caller(context), signal: context.abortSignal });
      } catch (error) {
        throw root.AgentResourceProtocol.arpError(error.code || 'UPSTREAM_FAILED', error.message, {
          performed: error.performed || 'no', retryable: false, details: { reason: error.reason },
        });
      }
    }
    async function pair(id, password, etag) {
      if (deps.beforeConnect) await deps.beforeConnect();
      c.password(password); var value = await store.load(); if (!c.own(value.connections, id)) c.fail('CONNECTION_NOT_FOUND');
      if (pairing.size) c.fail('PAIRING_IN_PROGRESS', '正在配对，请等待结果', 'RESOURCE_BUSY');
      var connection = value.connections[id];
      if (etag !== '"mcp-' + connection.configRevision + '"') c.fail('ETAG_MISMATCH', '连接配置已变化，请重新打开配对', 'PRECONDITION_FAILED');
      disconnect(id); var attempt = { cancelled: false }; pairing.set(id, attempt);
      try {
        var network = await deps.prepareNetwork();
        if (attempt.cancelled) c.fail('PAIRING_CANCELLED', '配对已取消');
        var client = createClient(connection, info(value, network));
        await client.connectAttempt({ password: password, timeoutMs: 30000 }); return { state: client.getStatus().state };
      }
      finally {
        password = ''; pairing.delete(id);
        var latest = await store.load(), current = c.own(latest.connections, id) && latest.connections[id];
        if (!current || !current.enabled || latest.clientId !== value.clientId) disconnect(id);
        else if (clients.has(id)) clients.get(id).update(current);
      }
    }
    async function updateConnection(id, patch, context, etag) { await store.update(id, patch, context, etag); await initClient(); return publicConnection(id); }
    async function changeWorkspace(id, workspaceId, body, context, etag, action) {
      var connection = await publicConnection(id); var style = connection && connection.environment && connection.environment.runtime.pathStyle;
      var result = await store.workspace(id, workspaceId, body || {}, context, etag, action, style);
      await initClient(); if (result.deleted) return result;
      return (await publicConnection(id)).workspaces.find(function (item) { return item.id === result.id; });
    }
    return { store: store, getClient: getClient, initClient: initClient, listConnections: listConnections, getConnection: publicConnection,
      createConnection: async function (body, context) { var item = await store.add(body, context); return publicConnection(item.id); },
      updateConnection: updateConnection, deleteConnection: async function (id, context, etag) { return store.remove(id, context, etag); },
      changeWorkspace: changeWorkspace, pair: pair, caller: caller, target: target,
      discover: discover, execute: execute, environment: environment, callServerArp: callServerArp,
      attemptConnection: async function (id, options) {
        if (pairing.has(id)) c.fail('PAIRING_IN_PROGRESS', '此连接正在配对，请等待结果', 'RESOURCE_BUSY');
        await initClient();
        if (pairing.has(id)) c.fail('PAIRING_IN_PROGRESS', '此连接正在配对，请等待结果', 'RESOURCE_BUSY');
        var client = getClient(id); if (!client) c.fail('CONNECTION_DISABLED');
        client.disconnect();
        await client.connectAttempt(options); return publicConnection(id);
      },
      getConnectionLogs: async function (id) { var client = getClient(id); return client ? client.getStatus().logs : []; },
      clearConnectionLogs: async function (id) { var client = getClient(id); var removed = client ? client.getStatus().logs.length : 0; if (client) client.clearLogs(); return { removed: removed }; },
      updateName: async function (name, context) { await store.updateName(name, context); await initClient(); },
      resetId: async function (context) { await store.resetId(context); await initClient(); } };
  }
  root.McpRuntime = Object.freeze({ createMcpRuntime: createMcpRuntime });
})(globalThis);
