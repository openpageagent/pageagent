(function (root) {
  'use strict';
  var c = root.McpContract;
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function create(options) {
    var chrome = options.chrome || root.chrome;
    var incognito = !!chrome.extension.inIncognitoContext;
    var scope = incognito ? 'incognito' : 'regular';
    var key = incognito ? 'mcp_connections_v2_incognito' : 'mcp_connections_v2';
    var state = null, queue = Promise.resolve(), dbPromise, loading;
    var onChange = options.onChange || function () {};
    function credentialsDb() {
      if (!dbPromise) dbPromise = new Promise(function (resolve, reject) {
        var request = indexedDB.open('page-agent-mcp-auth', 1);
        request.onupgradeneeded = function () { request.result.createObjectStore('credentials', { keyPath: ['profileScope', 'connectionId'] }); };
        request.onsuccess = function () { resolve(request.result); }; request.onerror = function () { reject(request.error); };
      });
      return dbPromise;
    }
    async function credential(operation, connectionId, value) {
      c.id(connectionId); var db = await credentialsDb();
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction('credentials', operation === 'get' ? 'readonly' : 'readwrite');
        var store = transaction.objectStore('credentials'); var result;
        var request = operation === 'put' ? store.put(Object.assign({ profileScope: scope, connectionId: connectionId }, value))
          : operation === 'delete' ? store.delete([scope, connectionId]) : store.get([scope, connectionId]);
        request.onsuccess = function () { result = request.result; };
        transaction.oncomplete = function () { resolve(result || null); };
        transaction.onerror = transaction.onabort = function () { reject(transaction.error || new Error('凭据存储失败')); };
      });
    }
    function validate(value) {
      if (!value || value.version !== 2 || !c.record(value.connections) || !Array.isArray(value.order)) c.fail('INVALID_CONNECTION_STORE');
      c.id(value.clientId);
      var entries = Object.values(value.connections);
      if (entries.length > c.LIMITS.connections) c.fail('CONNECTION_LIMIT');
      c.uniqueAliases(entries);
      entries.forEach(function (item) {
        c.id(item.id); if (!c.own(value.connections, item.id) || value.connections[item.id] !== item) c.fail('INVALID_CONNECTION_ID');
        if (!item.migrationRepair) c.url(item.url); c.alias(item.alias);
        if (typeof item.enabled !== 'boolean' || typeof item.desktopEnabled !== 'boolean') c.fail('INVALID_CONFIGURATION');
        if (c.own(item, 'arpPermissions')) c.arpPermissions(item.arpPermissions);
        if (!item.migrationRepair) c.configure({ grantRevision: item.grantRevision, desktopEnabled: item.desktopEnabled,
          workspaces: item.workspaces.map(function (workspace) { return { id: workspace.id, kind: workspace.kind, permissions: workspace.permissions,
            ...(workspace.kind === 'custom' ? { path: workspace.path } : {}) }; }) });
        c.uniqueAliases(item.workspaces.filter(function (workspace) { return !workspace.migrationPending; }));
        item.workspaces.forEach(function (workspace) {
          if (workspace.kind === 'startup' && workspace.alias !== '工作目录' || workspace.kind === 'custom' && !workspace.migrationPending && workspace.alias.toLowerCase() === '工作目录') c.fail('STARTUP_ALIAS_RESERVED');
        });
      });
      return value;
    }
    function load() {
      if (state) return Promise.resolve(copy(state));
      if (!loading) loading = loadUncached().finally(function () { loading = null; });
      return loading.then(copy);
    }
    function ensureStartupRead(item) {
      var startup = item.workspaces.find(function (workspace) { return workspace.kind === 'startup'; });
      if (!startup || startup.permissions.read && !startup.needsAuthorization) return false;
      if (startup.needsAuthorization) startup.permissions = c.closedPermissions();
      startup.permissions.read = true;
      delete startup.needsAuthorization;
      return true;
    }
    async function loadUncached() {
      if (state) return copy(state);
      var stored = await chrome.storage.local.get(null);
      if (stored[key]) {
        var value = validate(stored[key]), updated = false;
        Object.values(value.connections).forEach(function (item) {
          // Normalize before clients capture the URL; equivalent addresses retain their credentials.
          if (!item.migrationRepair) {
            var url = c.url(item.url);
            if (item.url !== url) { item.url = url; updated = true; }
          }
          var grants = ensureStartupRead(item), missingArpPermissions = !c.own(item, 'arpPermissions');
          if (missingArpPermissions) item.arpPermissions = c.arpPermissions();
          if (grants || missingArpPermissions) { changed(item, grants); updated = true; }
        });
        if (updated) await chrome.storage.local.set({ [key]: value });
        state = value; return copy(state);
      }
      var suffix = incognito ? 'Incognito' : '';
      var clientId = stored['mcpClientId' + suffix] || crypto.randomUUID();
      var connections = Object.create(null), order = [], migration = null;
      if (['mcpUrl', 'mcpEnabled', 'mcpClientId'].some(function (name) { return c.own(stored, name + suffix); })) {
        var id = incognito ? 'local-mcp-incognito' : 'local-mcp';
        var url = stored['mcpUrl' + suffix] || 'ws://127.0.0.1:9999';
        var directory = stored['mcpLocalWorkingDirectory' + suffix] || '';
        var allowed = stored['mcpLocalToolsEnabled' + suffix] !== false;
        var permissions = { read: allowed, write: allowed, execute: allowed };
        var workspaces = [{ id: 'startup', kind: 'startup', alias: '工作目录', permissions: directory ? c.closedPermissions() : permissions }];
        var workspaceId = 'startup';
        if (directory) {
          workspaceId = crypto.randomUUID();
          // The legacy path is retained verbatim; remote confirmation completes alias/path migration.
          workspaces.push({ id: workspaceId, kind: 'custom', alias: '待确认旧目录', path: directory, permissions: permissions, migrationPending: true });
        }
        var alias = '待修复旧连接', repair = false;
        try { alias = new URL(url).host || alias; url = c.url(url); if (directory) c.workspacePath(directory); } catch (_) { repair = true; }
        connections[id] = { id: id, alias: alias, migrationRepair: repair, url: url, enabled: stored['mcpEnabled' + suffix] === true && !repair,
          expectedServerId: null, runTabMode: stored['mcpRunTabMode' + suffix] || 'reuseOpenTab',
          desktopEnabled: allowed, arpPermissions: c.arpPermissions(), grantRevision: 1, configRevision: 1, workspaces: workspaces };
        ensureStartupRead(connections[id]);
        order.push(id); migration = { connectionId: id, workspaceId: workspaceId, pending: true };
      }
      var migrated = { version: 2, clientId: clientId, clientName: String(stored['mcpClientName' + suffix] || 'Page Agent'), connections: connections, order: order, migration: migration };
      // Legacy invalid paths/URLs stay visible for repair and never become executable by fallback.
      await chrome.storage.local.set({ [key]: migrated }); state = migrated; return copy(state);
    }
    function transaction(change) {
      var work = queue.then(async function () {
        await load(); var next = copy(state); var result = await change(next);
        await chrome.storage.local.set({ [key]: next }); state = next;
        onChange(copy(state)); return copy(result === undefined ? next : result);
      });
      queue = work.catch(function () {}); return work;
    }
    function connection(value, id) {
      c.id(id); if (!c.own(value.connections, id)) c.fail('CONNECTION_NOT_FOUND', '连接不存在', 'RESOURCE_NOT_FOUND'); return value.connections[id];
    }
    function expected(item, etag) {
      if (etag === undefined) c.fail('ETAG_REQUIRED', '修改配置必须提供 If-Match', 'PRECONDITION_REQUIRED');
      if (etag !== '"mcp-' + item.configRevision + '"') c.fail('ETAG_MISMATCH', '配置已被其他编辑更新，请刷新后重试', 'PRECONDITION_FAILED');
    }
    function trusted(context) { if (!context || context.trustedConnectionUi !== true) c.fail('TRUSTED_UI_REQUIRED', '仅扩展连接配置页可以修改连接及目录授权', 'FORBIDDEN'); }
    function changed(item, grants) { item.configRevision = (item.configRevision || 1) + 1; if (grants) item.grantRevision++; }
    function validateNames(value, item) { c.uniqueAliases(Object.values(value.connections)); c.uniqueAliases(item.workspaces); }
    function importConnections(records, context, preview) {
      trusted(context);
      if (!Array.isArray(records) || records.length > c.LIMITS.connections) c.fail('CONNECTION_LIMIT');
      async function prepare(value) {
        var mapping = Object.create(null), imported = [], prepared = [];
        for (var record of records) {
          c.fields(record, ['source', 'overwriteId', 'ifMatch', 'importId', 'workspaceIds'], ['source']);
          var source = record.source;
          c.fields(source, ['id', 'alias', 'url', 'enabled', 'expectedServerId', 'runTabMode', 'desktopEnabled', 'arpPermissions', 'workspaces'], ['id', 'alias', 'url', 'workspaces']);
          c.id(source.id); if (c.own(mapping, source.id)) c.fail('DUPLICATE_CONNECTION');
          var previous = record.overwriteId ? connection(value, record.overwriteId) : null;
          if (previous) { if (!record.ifMatch) c.fail('ETAG_REQUIRED'); expected(previous, record.ifMatch); }
          var id = previous ? previous.id : record.importId || crypto.randomUUID(), workspaceMap = Object.create(null);
          c.id(id); if (!previous && c.own(value.connections, id)) c.fail('CONNECTION_ALREADY_EXISTS');
          if (source.expectedServerId) c.id(source.expectedServerId);
          var item = { id: id, alias: c.alias(source.alias), url: c.url(source.url), enabled: false,
            expectedServerId: source.expectedServerId || null, runTabMode: source.runTabMode || 'reuseOpenTab',
            desktopEnabled: source.desktopEnabled === true, arpPermissions: copy(c.arpPermissions(source.arpPermissions)),
            grantRevision: previous ? previous.grantRevision + 1 : 1,
            configRevision: previous ? previous.configRevision + 1 : 1, workspaces: [] };
          if (!['reuseOpenTab', 'fixedCurrentTab', 'fixedNewTab'].includes(item.runTabMode)) c.fail('INVALID_RUN_TAB_MODE');
          if (!Array.isArray(source.workspaces) || !source.workspaces.length || source.workspaces.length > c.LIMITS.workspaces) c.fail('WORKSPACE_LIMIT');
          for (var workspace of source.workspaces) {
            c.fields(workspace, ['id', 'kind', 'alias', 'path', 'permissions', 'lastResolvedPath'], ['id', 'kind', 'alias', 'permissions']);
            c.id(workspace.id); if (c.own(workspaceMap, workspace.id)) c.fail('DUPLICATE_WORKSPACE');
            if (c.own(workspace, 'lastResolvedPath')) c.workspacePath(workspace.lastResolvedPath);
            if (workspace.kind === 'startup' && (workspace.id !== 'startup' || workspace.alias !== '工作目录' || c.own(workspace, 'path'))) c.fail('STARTUP_IMMUTABLE');
            if (workspace.kind === 'custom' && workspace.id === 'startup') c.fail('INVALID_STARTUP');
            var old = previous && previous.workspaces.find(function (entry) { return entry.id === workspace.id && entry.path === workspace.path && entry.kind === workspace.kind; });
            var workspaceId = workspace.kind === 'startup' ? 'startup' : old ? old.id : record.workspaceIds && record.workspaceIds[workspace.id] || crypto.randomUUID();
            var lastResolvedPath = item.expectedServerId && (workspace.lastResolvedPath
              || old && previous.expectedServerId === item.expectedServerId && old.lastResolvedPath);
            var permissions = copy(c.permissions(workspace.permissions));
            c.id(workspaceId);
            workspaceMap[workspace.id] = workspaceId;
            item.workspaces.push({ id: workspaceId, kind: workspace.kind, alias: c.alias(workspace.alias),
              ...(workspace.kind === 'custom' ? { path: c.workspacePath(workspace.path) } : {}),
              ...(lastResolvedPath ? { lastResolvedPath: lastResolvedPath } : { needsAuthorization: true }),
              permissions: lastResolvedPath ? permissions : c.closedPermissions() });
          }
          ensureStartupRead(item);
          value.connections[id] = item; if (!previous) value.order.push(id);
          mapping[source.id] = { connectionId: id, workspaces: workspaceMap }; imported.push(item);
          prepared.push(Object.assign({}, record, { importId: id, workspaceIds: workspaceMap }));
        }
        validate(value);
        var serverIds = new Set();
        Object.values(value.connections).forEach(function (item) {
          if (item.expectedServerId && serverIds.has(item.expectedServerId)) c.fail('SERVER_ALREADY_CONFIGURED', '同一服务端已有连接，请在预览中明确覆盖原连接');
          if (item.expectedServerId) serverIds.add(item.expectedServerId);
        });
        if (!preview) for (var item of imported) { if (options.disconnect) options.disconnect(item.id, 'grant_revoked'); await credential('delete', item.id); }
        return { mapping: mapping, connections: imported, records: prepared };
      }
      return preview ? load().then(prepare) : transaction(prepare);
    }
    function add(body, context) {
      trusted(context); c.fields(body, ['alias', 'url'], ['alias', 'url']);
      return transaction(function (value) {
        if (Object.keys(value.connections).length >= c.LIMITS.connections) c.fail('CONNECTION_LIMIT');
        var id = crypto.randomUUID(); var item = { id: id, alias: c.alias(body.alias), url: c.url(body.url), enabled: false,
          expectedServerId: null, runTabMode: 'reuseOpenTab', desktopEnabled: false, arpPermissions: c.arpPermissions(), grantRevision: 1, configRevision: 1,
          workspaces: [{ id: 'startup', kind: 'startup', alias: '工作目录', permissions: c.closedPermissions() }] };
        ensureStartupRead(item);
        value.connections[id] = item; value.order.push(id); validateNames(value, item); return item;
      });
    }
    function update(id, patch, context, etag) {
      trusted(context); c.fields(patch, ['alias', 'url', 'enabled', 'runTabMode', 'desktopEnabled', 'arpPermissions']);
      return transaction(async function (value) {
        var item = connection(value, id); expected(item, etag); var grants = false;
        if (patch.enabled === true && !item.expectedServerId) c.fail('PAIRING_REQUIRED', '请先完成首次配对，再开启连接', 'RESOURCE_CONFLICT');
        if (c.own(patch, 'alias')) item.alias = c.alias(patch.alias);
        if (c.own(patch, 'url')) {
          var url = c.url(patch.url);
          if (item.url !== url) { if (options.disconnect) options.disconnect(id, 'grant_revoked'); await credential('delete', id); item.url = url; delete item.serverName; }
        }
        ['enabled', 'desktopEnabled'].forEach(function (name) {
          if (c.own(patch, name)) { if (typeof patch[name] !== 'boolean') c.fail('INVALID_BOOLEAN'); grants = grants || name === 'desktopEnabled' && item[name] !== patch[name]; item[name] = patch[name]; }
        });
        if (c.own(patch, 'arpPermissions')) {
          item.arpPermissions = Object.assign(c.arpPermissions(item.arpPermissions), c.arpPermissions(patch.arpPermissions, true));
        }
        if (c.own(patch, 'runTabMode')) {
          if (!['reuseOpenTab', 'fixedCurrentTab', 'fixedNewTab'].includes(patch.runTabMode)) c.fail('INVALID_RUN_TAB_MODE'); item.runTabMode = patch.runTabMode;
        }
        if (item.migrationRepair) { try { c.url(item.url); item.workspaces.forEach(function (workspace) { if (workspace.kind === 'custom') c.workspacePath(workspace.path); }); item.migrationRepair = false; } catch (_) {} }
        changed(item, grants); validateNames(value, item);
        if (patch.enabled === false && options.disconnect) options.disconnect(id, 'grant_revoked');
        return item;
      });
    }
    function remove(id, context, etag) {
      trusted(context); return transaction(async function (value) {
        expected(connection(value, id), etag); if (options.disconnect) options.disconnect(id, 'grant_revoked'); await credential('delete', id);
        delete value.connections[id]; value.order = value.order.filter(function (entry) { return entry !== id; }); return { id: id, deleted: true };
      });
    }
    function workspace(id, workspaceId, body, context, etag, action, pathStyle) {
      trusted(context);
      if (action !== 'delete') c.fields(body, ['alias', 'path', 'permissions'], action === 'create' ? ['path'] : []);
      return transaction(function (value) {
        var item = connection(value, id); if (action !== 'create') expected(item, etag);
        var entry = item.workspaces.find(function (entry) { return entry.id === workspaceId; });
        if (action === 'create') {
          if (item.workspaces.length >= c.LIMITS.workspaces) c.fail('WORKSPACE_LIMIT');
          entry = { id: crypto.randomUUID(), kind: 'custom', path: c.workspacePath(body.path, pathStyle),
            alias: c.own(body, 'alias') ? c.alias(body.alias) : c.defaultWorkspaceAlias(body.path, pathStyle), permissions: c.closedPermissions() };
          item.workspaces.push(entry);
        } else if (!entry) c.fail('WORKSPACE_NOT_FOUND', '目录不存在', 'RESOURCE_NOT_FOUND');
        if (entry.kind === 'startup' && (action === 'delete' || c.own(body, 'path') || c.own(body, 'alias'))) c.fail('STARTUP_IMMUTABLE');
        if (action === 'delete') { item.workspaces = item.workspaces.filter(function (value) { return value !== entry; }); changed(item, true); return { id: workspaceId, deleted: true }; }
        var pathChanged = c.own(body, 'path') && entry.path !== body.path;
        if (c.own(body, 'permissions')) {
          c.permissions(body.permissions, true);
          if (entry.kind === 'startup' && body.permissions.read === false) c.fail('STARTUP_READ_REQUIRED', '工作目录必须保持可读，不能关闭读取权限');
          if (pathChanged && Object.values(body.permissions).some(Boolean)) c.fail('PATH_CHANGE_REQUIRES_REAUTHORIZATION');
          if (entry.needsAuthorization && !entry.lastResolvedPath && Object.values(body.permissions).some(Boolean)) c.fail('WORKSPACE_CONFIRMATION_REQUIRED', '请先连接服务端确认有效目录的实际路径，再开启权限');
        }
        var grants = action === 'create' || pathChanged || c.own(body, 'permissions') && Object.keys(body.permissions).some(function (key) { return entry.permissions[key] !== body.permissions[key]; });
        if (pathChanged) { entry.path = c.workspacePath(body.path, pathStyle); entry.permissions = c.closedPermissions(); delete entry.lastResolvedPath; entry.needsAuthorization = true; }
        if (c.own(body, 'alias')) { entry.alias = c.alias(body.alias); entry.migrationPending = false; }
        if (entry.kind === 'custom' && entry.alias === '工作目录') c.fail('STARTUP_ALIAS_RESERVED');
        if (body.permissions) { Object.assign(entry.permissions, body.permissions); if (Object.values(body.permissions).some(Boolean)) entry.needsAuthorization = false; }
        if (item.migrationRepair) { try { c.url(item.url); item.workspaces.forEach(function (workspace) { if (workspace.kind === 'custom') c.workspacePath(workspace.path); }); item.migrationRepair = false; } catch (_) {} }
        changed(item, grants); validateNames(value, item); return entry;
      });
    }
    async function bind(id, response, url, clientId, pairingRevision) {
      return transaction(function (value) {
        var item = connection(value, id);
        if (item.url !== url || value.clientId !== clientId) c.fail('AUTHORIZATION_CHANGED', '配对期间连接配置已变化', 'AUTHORIZATION_CHANGED');
        if (pairingRevision !== undefined) expected(item, '"mcp-' + pairingRevision + '"');
        var serverChanged = !!item.expectedServerId && item.expectedServerId !== response.serverId;
        if (serverChanged && pairingRevision === undefined) c.fail('SERVER_ID_CHANGED', '服务端身份变化', 'DEPENDENCY_CHANGED');
        if (Object.values(value.connections).some(function (other) { return other.id !== id && other.expectedServerId === response.serverId; })) c.fail('SERVER_ALREADY_CONFIGURED', '此服务端已经存在连接', 'RESOURCE_CONFLICT');
        if (serverChanged) {
          item.desktopEnabled = false;
          delete item.serverName;
          item.workspaces.forEach(function (workspace) {
            workspace.permissions = c.closedPermissions(); workspace.needsAuthorization = true;
            delete workspace.lastResolvedPath;
          });
          ensureStartupRead(item);
          if (value.migration && value.migration.connectionId === id) value.migration = null;
        }
        item.expectedServerId = response.serverId;
        if (pairingRevision !== undefined) changed(item, serverChanged);
        return item;
      });
    }
    function confirm(id, configured, pathStyle, serverId, url, serverName) {
      return transaction(function (value) {
        var item = connection(value, id);
        if (item.expectedServerId !== serverId || item.url !== url) c.fail('AUTHORIZATION_CHANGED');
        if (configured.acceptedRevision !== item.grantRevision) return { resync: true, connection: item };
        item.serverName = serverName === undefined ? null : c.serverName(serverName);
        var resync = false;
        item.workspaces.forEach(function (entry) {
          var confirmed = configured.workspaces.find(function (target) { return target.id === entry.id; });
          if (!confirmed || !confirmed.resolvedPath) return;
          if ((entry.lastResolvedPath && entry.lastResolvedPath !== confirmed.resolvedPath || confirmed.state === 'changed')
            && (!entry.needsAuthorization || Object.values(entry.permissions).some(Boolean))) {
            entry.permissions = c.closedPermissions(); entry.needsAuthorization = true; resync = true;
          }
          if (!['ready', 'changed'].includes(confirmed.state)) return;
          entry.lastResolvedPath = confirmed.resolvedPath;
          if (entry.migrationPending) {
            try { entry.alias = c.defaultWorkspaceAlias(entry.path, pathStyle); entry.migrationPending = entry.alias === '工作目录'; }
            catch (_) { entry.permissions = c.closedPermissions(); entry.needsAuthorization = true; resync = true; }
          }
        });
        if (value.migration && value.migration.connectionId === id && value.migration.pending) {
          var legacy = item.workspaces.find(function (entry) { return entry.id === value.migration.workspaceId; });
          var startup = item.workspaces.find(function (entry) { return entry.id === 'startup'; });
          var legacyConfirmed = legacy && configured.workspaces.find(function (entry) { return entry.id === legacy.id; });
          var startupConfirmed = configured.workspaces.find(function (entry) { return entry.id === 'startup'; });
          if (legacy && legacy !== startup && legacyConfirmed && startupConfirmed && startupConfirmed.state === 'ready'
            && legacyConfirmed.resolvedPath && legacyConfirmed.resolvedPath === startupConfirmed.resolvedPath) {
            startup.permissions = legacy.permissions; item.workspaces = item.workspaces.filter(function (entry) { return entry !== legacy; });
            value.migration.workspaceId = 'startup'; resync = true;
          }
        }
        var aliases = new Set();
        item.workspaces.forEach(function (entry) {
          var name = entry.alias.toLowerCase(); if (aliases.has(name) && !entry.needsAuthorization) { entry.migrationPending = true; entry.permissions = c.closedPermissions(); entry.needsAuthorization = true; resync = true; } aliases.add(name);
        });
        if (ensureStartupRead(item)) resync = true;
        if (resync) changed(item, true);
        if (value.migration && value.migration.connectionId === id && value.migration.pending) {
          var migrated = configured.workspaces.find(function (workspace) { return workspace.id === value.migration.workspaceId; });
          value.migration.confirmed = !resync && !!migrated && migrated.state === 'ready';
        }
        return { resync: resync, connection: item };
      });
    }
    function updateName(name, context) {
      trusted(context); if (typeof name !== 'string' || name.length > 300) c.fail('INVALID_CLIENT_NAME');
      return transaction(function (value) { value.clientName = name.trim(); });
    }
    function resetId(context) {
      trusted(context); return transaction(async function (value) {
        for (var id of Object.keys(value.connections)) {
          if (options.disconnect) options.disconnect(id, 'grant_revoked'); await credential('delete', id);
          changed(value.connections[id], false);
        }
        value.clientId = crypto.randomUUID();
      });
    }
    // Called only by the packaged connection loader, never exposed through ARP.
    function ensureBuiltins(definitions, clientName) {
      if (clientName !== undefined && (typeof clientName !== 'string' || clientName.length > 300)) c.fail('INVALID_CLIENT_NAME');
      definitions.forEach(function (definition) { c.id(definition.id); c.url(definition.url); c.alias(definition.alias); });
      return transaction(async function (value) {
        if (clientName !== undefined) value.clientName = clientName.trim();
        var replaced = [];
        for (var definition of definitions) {
          var id = 'builtin:' + definition.id, previous = value.connections[id];
          var url = c.url(definition.url);
          var sameServer = previous && previous.url === url;
          if (previous && !sameServer) replaced.push(id);
          var item = sameServer ? copy(previous) : {
            id: id, expectedServerId: null, runTabMode: 'reuseOpenTab', desktopEnabled: false,
            enabled: false, grantRevision: 1, configRevision: 1,
            workspaces: [{ id: 'startup', kind: 'startup', alias: '工作目录', permissions: { read: true, write: false, execute: false } }],
          };
          item.builtinId = definition.id;
          item.alias = definition.alias; item.url = url;
          item.arpPermissions = copy(c.arpPermissions(definition.arpPermissions));
          if (definition.workspaces) item.workspaces = copy(definition.workspaces);
          ensureStartupRead(item);
          if (JSON.stringify(item) !== JSON.stringify(previous)) {
            if (previous) { item.configRevision = previous.configRevision + 1; item.grantRevision = previous.grantRevision + 1; }
            value.connections[id] = item;
          }
        }
        var builtinOrder = definitions.map(function (definition) { return 'builtin:' + definition.id; });
        value.order = builtinOrder.concat(value.order.filter(function (id) { return !builtinOrder.includes(id); }));
        validate(value);
        for (var id of replaced) {
          if (options.disconnect) options.disconnect(id, 'grant_revoked');
          await credential('delete', id);
        }
      });
    }
    return { key: key, scope: scope, load: load, transaction: transaction, add: add, update: update, remove: remove, workspace: workspace,
      ensureBuiltins: ensureBuiltins,
      bind: bind, confirm: confirm, updateName: updateName, resetId: resetId, importConnections: importConnections,
      getCredential: function (id) { return credential('get', id); },
      saveCredential: function (id, secret, url) {
        return transaction(async function (value) {
          var item = connection(value, id);
          if (item.url !== url || value.clientId !== secret.clientId || item.expectedServerId !== secret.serverId) c.fail('AUTHORIZATION_CHANGED');
          await credential('put', id, secret); return { saved: true };
        });
      } };
  }
  root.McpConnectionStore = Object.freeze({ create: create });
})(globalThis);
