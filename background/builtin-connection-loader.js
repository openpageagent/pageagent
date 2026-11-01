(function (root) {
  'use strict';
  var c = root.McpContract;
  function create(options) {
    var definitions = [], initialized = false, loading = null, running = null;
    var attemptKey = 'builtin_connection_pairing_attempts';
    var alarm = 'page-agent-builtin-connections';
    var incognito = !!chrome.extension.inIncognitoContext;
    var settingsKey = 'archive_sync_backup' + (incognito ? '_incognito' : '');
    var autoSyncAvailable = false, environmentAllowsSync = false;
    var applicationVersion = chrome.runtime.getManifest().version;
    var syncVersion = '', syncTarget = null, modelApiKeys = {};
    var settings = { autoSyncEnabled: true, syncConnectionId: null, targets: [] };
    function target(connectionId) {
      return settings.targets.find(function (item) { return item.connectionId === connectionId; }) || null;
    }
    function binding() { return target(settings.syncConnectionId); }
    function validateSettings(value, connections) {
      c.fields(value, ['autoSyncEnabled', 'autoSyncDisabledReason', 'syncConnectionId', 'targets'], ['syncConnectionId', 'targets']);
      if (value.autoSyncEnabled !== undefined && typeof value.autoSyncEnabled !== 'boolean') throw new Error('自动同步开关无效');
      if (value.autoSyncDisabledReason !== undefined && typeof value.autoSyncDisabledReason !== 'string') throw new Error('自动同步状态无效');
      if (!Array.isArray(value.targets)) throw new Error('备份目标必须为连接列表');
      var seen = new Set(), servers = new Set();
      value.targets.forEach(function (item) {
        c.fields(item, ['connectionId', 'bucketId', 'backup', 'backupIntervalMinutes', 'retainCount'], ['connectionId', 'bucketId', 'backup']);
        c.id(item.connectionId);
        if (seen.has(item.connectionId)) throw new Error('同一个连接只能配置一次');
        seen.add(item.connectionId);
        if (typeof item.bucketId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.bucketId)) {
          throw new Error('桶名须为 1–80 个字符，以英文字母或数字开头，仅允许英文字母、数字、下划线和连字符，不允许中文');
        }
        if (['constructor', 'prototype'].includes(item.bucketId)) throw new Error('此桶名为保留名称，请更换');
        if (typeof item.backup !== 'boolean') throw new Error('备份开关无效');
        if (item.backupIntervalMinutes !== undefined && (!Number.isInteger(item.backupIntervalMinutes) || item.backupIntervalMinutes < 1 || item.backupIntervalMinutes > 525600)) throw new Error('备份间隔须为 1 至 525600 分钟');
        if (item.retainCount !== undefined && (!Number.isInteger(item.retainCount) || item.retainCount < 1 || item.retainCount > 1000)) throw new Error('保留版本数须为 1 至 1000');
        if (connections) {
          var connection = connections[item.connectionId];
          if (!connection) throw new Error('连接已删除，请刷新后重新选择');
          var server = connection.expectedServerId || connection.url;
          if (servers.has(server)) throw new Error('同一个服务端请选择一个连接，避免重复同步或备份');
          servers.add(server);
          if (item.backup && !connection.arpPermissions.read || item.connectionId === value.syncConnectionId
              && value.autoSyncEnabled !== false && environmentAllowsSync && (!connection.arpPermissions.read || !connection.arpPermissions.write)) {
            throw new Error('备份需要连接的 ARP 读取权限；同步源还需要写入权限');
          }
        }
      });
      if (value.syncConnectionId !== null && !seen.has(value.syncConnectionId)) throw new Error('自动同步源必须为一个已选择的连接');
      return Object.assign({ autoSyncEnabled: true }, JSON.parse(JSON.stringify(value)));
    }
    async function load() {
      var response = await fetch(chrome.runtime.getURL('builtin-connections/index.json'), { cache: 'no-store' });
      if (!response.ok) throw new Error('无法读取内置连接配置');
      var file = await response.json();
      c.fields(file, ['version', 'clientName', 'connections', 'runtime', 'applicationVersion', 'autoSyncEnabled', 'syncVersion', 'syncTarget', 'modelApiKeys'], ['version', 'connections']);
      if (file.version !== 1 || !Array.isArray(file.connections)) throw new Error('内置连接格式无效');
      if (file.autoSyncEnabled !== undefined && typeof file.autoSyncEnabled !== 'boolean') throw new Error('启动自动同步开关必须为布尔值');
      if (file.syncVersion !== undefined && (typeof file.syncVersion !== 'string' || file.syncVersion && !/^v\d{6,}$/.test(file.syncVersion))) throw new Error('启动同步版本无效');
      if (file.modelApiKeys !== undefined) {
        if (!c.record(file.modelApiKeys)) throw new Error('模型密钥配置必须为对象');
        Object.entries(file.modelApiKeys).forEach(function (entry) {
          c.id(entry[0]);
          if (['__proto__', 'constructor', 'prototype'].includes(entry[0]) || typeof entry[1] !== 'string' || !entry[1].trim()) throw new Error('模型密钥配置无效');
        });
      }
      if (file.clientName !== undefined && (typeof file.clientName !== 'string' || file.clientName.length > 300)) throw new Error('客户端名称须为不超过 300 个字符的字符串');
      var storedSettings = (await chrome.storage.local.get(settingsKey))[settingsKey];
      var previousConnections = !incognito && !storedSettings ? (await options.runtime.store.load()).connections : {};
      // Migrate implicit roles only for connections already installed by an older loader.
      // Persist the result below so new definitions always require explicit roles.
      var legacySources = new Set(file.connections.filter(function (entry) {
        var previous = previousConnections['builtin:' + entry.id];
        return previous && previous.builtinId === entry.id && previous.url === entry.url
          && entry.bucket && entry.autoSync === undefined && entry.backup === undefined;
      }).map(function (entry) { return entry.id; }));
      var ids = new Set(), defaults = { autoSyncEnabled: true, syncConnectionId: null, targets: [] };
      file.connections.forEach(function (entry) {
        c.fields(entry, ['id', 'alias', 'url', 'password', 'arpPermissions', 'workspaces', 'bucket', 'autoSync', 'backup'], ['id', 'alias', 'url', 'arpPermissions']);
        c.id(entry.id); c.url(entry.url); c.alias(entry.alias); c.arpPermissions(entry.arpPermissions);
        if (ids.has(entry.id)) throw new Error('内置连接 ID 重复: ' + entry.id);
        ids.add(entry.id);
        if (entry.password !== undefined) c.password(entry.password);
        ['autoSync', 'backup'].forEach(function (key) {
          if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new Error(key + ' 必须为布尔值');
        });
        var legacy = legacySources.has(entry.id);
        var autoSync = entry.autoSync === true || legacy;
        if (file.runtime === 'docker/start.cjs' && entry.id === 'container-local' && legacySources.size) autoSync = false;
        if (autoSync || entry.backup || legacy) {
          var connectionId = 'builtin:' + entry.id;
          if (autoSync) {
            if (defaults.syncConnectionId) throw new Error('自动同步只能开启一个连接');
            defaults.syncConnectionId = connectionId;
          }
          defaults.targets.push({ connectionId: connectionId, bucketId: entry.bucket || 'default', backup: entry.backup === true || legacy });
        }
      });
      if (!incognito) await options.runtime.store.ensureBuiltins(file.connections, file.clientName);
      definitions = incognito ? [] : file.connections;
      autoSyncAvailable = !incognito && file.runtime === 'docker/start.cjs';
      environmentAllowsSync = autoSyncAvailable && file.autoSyncEnabled !== false;
      syncVersion = autoSyncAvailable ? file.syncVersion || '' : '';
      modelApiKeys = autoSyncAvailable ? file.modelApiKeys || {} : {};
      applicationVersion = file.applicationVersion || applicationVersion;
      settings = validateSettings(storedSettings || (incognito ? { autoSyncEnabled: false, syncConnectionId: null, targets: [] } : defaults));
      if (!storedSettings) await chrome.storage.local.set({ [settingsKey]: settings });
      if (autoSyncAvailable && syncVersion && file.syncTarget !== undefined) {
        c.fields(file.syncTarget, ['connectionId', 'bucketId'], ['connectionId', 'bucketId']);
        var source = defaults.targets.find(function (item) { return item.connectionId === file.syncTarget.connectionId; });
        if (!source || defaults.syncConnectionId !== source.connectionId) throw new Error('启动同步目标必须使用唯一内置同步源');
        syncTarget = { connectionId: source.connectionId, bucketId: file.syncTarget.bucketId };
        var policy = target(source.connectionId) || source;
        settings.targets = settings.targets.filter(function (item) { return item.connectionId !== source.connectionId; });
        settings.targets.push(Object.assign({}, policy, { bucketId: syncTarget.bucketId }));
        settings.syncConnectionId = source.connectionId;
        settings.autoSyncEnabled = environmentAllowsSync;
        delete settings.autoSyncDisabledReason;
        settings = validateSettings(settings);
      }
      await options.onLoaded();
      initialized = true;
    }
    function initialize() {
      if (initialized) return Promise.resolve();
      if (!loading) loading = load().finally(function () { loading = null; });
      return loading;
    }
    async function connect() {
      if (chrome.extension.inIncognitoContext) return;
      if (running) return running;
      running = (async function () {
        await initialize();
        var attempts = (await chrome.storage.session.get(attemptKey))[attemptKey] || {};
        var retry = false;
        for (var entry of definitions) {
          var id = 'builtin:' + entry.id;
          var pairedNow = false;
          var connection = await options.runtime.getConnection(id);
          var secret = await options.runtime.store.getCredential(id);
          if (!secret && !connection.expectedServerId && entry.password && (attempts[id] || 0) < 5) {
            try {
              attempts[id] = (attempts[id] || 0) + 1;
              await chrome.storage.session.set({ [attemptKey]: attempts });
              await options.runtime.pair(id, entry.password, '"mcp-' + connection.configRevision + '"');
              pairedNow = true;
              connection = await options.runtime.getConnection(id);
            } catch (error) {
              options.log('内置连接 ' + entry.alias + ' 配对失败: ' + error.message);
              if (attempts[id] < 5) retry = true;
              continue;
            }
          }
          if ((pairedNow || syncTarget && syncTarget.connectionId === id && environmentAllowsSync)
              && connection.expectedServerId && !connection.enabled) {
            await options.runtime.updateConnection(id, { enabled: true }, { trustedConnectionUi: true }, '"mcp-' + connection.configRevision + '"');
          }
        }
        await options.runtime.initClient();
        if (!retry) await chrome.alarms.clear(alarm);
      })().finally(function () { running = null; });
      return running;
    }
    chrome.alarms.onAlarm.addListener(function (value) {
      if (value.name === alarm) connect().catch(function (error) { options.log(error.message); });
    });
    return {
      start: async function () {
        if (chrome.extension.inIncognitoContext) return initialize();
        await chrome.alarms.create(alarm, { periodInMinutes: 1 });
        return connect();
      },
      binding: binding,
      target: target,
      modelApiKeys: function () { return Object.assign(Object.create(null), modelApiKeys); },
      configuration: function () { return { autoSyncAvailable: autoSyncAvailable, environmentAllowsSync: environmentAllowsSync,
        autoSyncEnabled: environmentAllowsSync && !!syncVersion && settings.autoSyncEnabled !== false, syncVersion: syncVersion,
        syncTarget: syncTarget && Object.assign({}, syncTarget),
        applicationVersion: applicationVersion,
        settings: JSON.parse(JSON.stringify(settings)) }; },
      disableAutoSync: async function (reason) {
        if (settings.autoSyncEnabled === false && settings.autoSyncDisabledReason === reason) return;
        settings = Object.assign({}, settings, { autoSyncEnabled: false, autoSyncDisabledReason: reason });
        await chrome.storage.local.set({ [settingsKey]: settings });
      },
      saveConfiguration: async function (value) {
        if (syncTarget) {
          var source = value && Array.isArray(value.targets) && value.targets.find(function (item) { return item.connectionId === syncTarget.connectionId; });
          if (!source || source.bucketId !== syncTarget.bucketId || value.syncConnectionId !== syncTarget.connectionId
              || value.autoSyncEnabled !== environmentAllowsSync) throw new Error('同步源、桶名和开关由容器启动设置管理，请修改环境变量后重建容器');
        }
        var connections = (await options.runtime.store.load()).connections;
        var disablingOnly = value && value.autoSyncEnabled === false && value.syncConnectionId === settings.syncConnectionId
          && JSON.stringify(value.targets) === JSON.stringify(settings.targets);
        var next = validateSettings(value, disablingOnly ? null : connections);
        if (!autoSyncAvailable) next.autoSyncEnabled = false;
        if (next.syncConnectionId && next.autoSyncEnabled && environmentAllowsSync && !connections[next.syncConnectionId].enabled
            && (settings.autoSyncEnabled === false || next.syncConnectionId !== settings.syncConnectionId)) throw new Error('自动同步源必须是已开启的连接');
        if (next.autoSyncEnabled) delete next.autoSyncDisabledReason;
        await chrome.storage.local.set({ [settingsKey]: next });
        settings = next;
      },
      initialize: initialize,
      ready: connect,
    };
  }
  root.BuiltinConnectionLoader = Object.freeze({ create: create });
})(globalThis);
