// Shared browser/Node contract for the authenticated Page Agent transport.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.McpContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var LIMITS = Object.freeze({ connections: 32, workspaces: 64, unauthenticated: 16,
    authBytes: 8192, frameBytes: 33554432, configureBytes: 1048576, authTimeoutMs: 10000,
    configureTimeoutMs: 10000, bashDefaultTimeoutMs: 30000, bashMaxTimeoutMs: 60000,
    fileTimeoutMs: 60000, desktopTimeoutMs: 30000, sampleTimeoutMs: 3000,
    dynamicTtlMs: 5000, sampleIntervalMs: 1000, stopWaitMs: 5000, clientWaitMs: 75000,
    readBytes: 4194304, writeBytes: 1048576, outputBytes: 65536, grepEntries: 5000,
    desktopOutputBytes: 1048576, desktopErrorBytes: 8192, imageBytes: 8388608,
    imagePixels: 20000000, clientActive: 4, serverActive: 8, seenRequests: 10000,
    settledCount: 256, settledTtlMs: 60000, httpSessions: 64, httpSessionActive: 8,
    httpActive: 32, httpBodyBytes: 2097152, httpIdleMs: 1800000,
    // JSON escaping can expand a local write request to 6 MiB; allow one record per active execution in the queue.
    auditRecordBytes: 8388608, auditQueueCount: 128, auditQueueBytes: 67108864,
    auditWaitMs: 2000, auditRecoverMs: 5000, auditRotateBytes: 10485760,
    auditTotalBytes: 104857600, auditRetainMs: 2592000000 });
  var DIRECTORY_OPERATIONS = Object.freeze({ read: 'read', grep: 'read', write: 'write',
    delete: 'write', bash: 'execute', locate: 'read' });
  var DESKTOP_OPERATIONS = Object.freeze(['keyboard', 'mouse', 'clipboard', 'screenshot', 'application', 'window']);
  var COMMON = ['type', 'transportProtocol', 'serverId', 'clientId', 'transportSessionId', 'requestId'];
  var FRAME_FIELDS = Object.freeze({
    hello: ['protocol', 'clientInfo', 'serverName', 'version', 'platform', 'startupWorkingDirectory', 'capabilities', 'environment'],
    'local.configure': ['grantRevision', 'desktopEnabled', 'workspaces'],
    'local.configured': ['ok', 'acceptedRevision', 'workspaces', 'desktopEnabled', 'error', 'audit'],
    'local.call': ['grantRevision', 'workspaceId', 'workingDirectory', 'operation', 'input', 'caller'],
    'local.result': ['ok', 'operation', 'workspaceId', 'workingDirectory', 'grantRevision', 'result', 'error', 'receipt', 'execution', 'audit'],
    'local.cancel': ['reason'], 'local.cancel.ack': ['status'], heartbeat: ['sentAt'],
    'server.status': ['audit', 'environmentRevision'],
    'environment.get': ['scope', 'refresh', 'caller', 'workspaceId', 'workingDirectory', 'grantRevision'],
    'environment.result': ['ok', 'scope', 'data', 'error', 'audit'],
    'arp.request': ['method', 'request', 'context', 'principal'], 'arp.result': ['envelope'],
    'arp.call': ['method', 'request', 'caller'], 'arp.response': ['envelope'], 'arp.call.cancel': ['reason'],
    'arp.cancel': ['reason'], 'mail.send': ['payload', 'caller'], 'mail.result': ['ok', 'result', 'error', 'receipt', 'audit'],
    'mail.cancel': ['reason'],
  });
  function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function fail(reason, message, code) {
    var error = new Error(message || reason); error.reason = reason; error.code = code || 'INVALID_REQUEST';
    error.details = { reason: reason }; error.performed = 'no';
    error.retryable = false; throw error;
  }
  function fields(value, allowed, required) {
    if (!record(value)) fail('INVALID_OBJECT');
    Object.keys(value).forEach(function (key) { if (allowed.indexOf(key) < 0) fail('UNKNOWN_FIELD', '不接受字段: ' + key); });
    (required || []).forEach(function (key) { if (!own(value, key)) fail('MISSING_FIELD', '缺少字段: ' + key); });
    return value;
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) fail('INVALID_ID');
    return value;
  }
  function alias(value) {
    if (typeof value !== 'string') fail('INVALID_ALIAS');
    var text = value.trim().normalize('NFC');
    if (!text || Array.from(text).length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(text)) fail('INVALID_ALIAS');
    return text;
  }
  function uniqueAliases(values) {
    var seen = new Set();
    values.forEach(function (value) {
      var key = alias(value.alias).toLowerCase();
      if (seen.has(key)) fail('ALIAS_CONFLICT', '别名已存在', 'RESOURCE_CONFLICT');
      seen.add(key);
    });
  }
  function permissions(value, partial) {
    fields(value, ['read', 'write', 'execute'], partial ? [] : ['read', 'write', 'execute']);
    Object.keys(value).forEach(function (key) { if (typeof value[key] !== 'boolean') fail('INVALID_PERMISSION'); });
    return value;
  }
  function closedPermissions() { return { read: false, write: false, execute: false }; }
  function arpPermissions(value, partial) {
    if (value === undefined) return { read: true, write: true, delete: false, execute: true };
    fields(value, ['read', 'write', 'delete', 'execute'], partial ? [] : ['read', 'write', 'delete', 'execute']);
    Object.keys(value).forEach(function (key) { if (typeof value[key] !== 'boolean') fail('INVALID_PERMISSION'); });
    return value;
  }
  function arpPermission(method, contract) {
    if (method === 'DELETE') return 'delete';
    if (method === 'GET' || method === 'OPTIONS' || contract && ['safe', 'read'].includes(contract.safety)) return 'read';
    return contract && ['execute', 'privileged'].includes(contract.safety) ? 'execute' : 'write';
  }
  function workspacePath(value, style) {
    if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) fail('INVALID_PATH');
    var windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(value);
    var posix = value.charAt(0) === '/';
    if (style === 'win32' ? !windows : style === 'posix' ? !posix : !windows && !posix) fail('ABSOLUTE_PATH_REQUIRED');
    return value;
  }
  function defaultWorkspaceAlias(value, style) {
    workspacePath(value, style);
    if (!style) fail('PATH_STYLE_REQUIRED', '请先连接以确认远端路径格式，或明确填写目录别名');
    if (style === 'posix' && (/^\/+$/).test(value)) return '/';
    if (style === 'win32') {
      var normalized = value.replace(/\//g, '\\');
      var driveRoot = /^([A-Za-z]:)\\+$/.exec(normalized);
      if (driveRoot) return alias(driveRoot[1] + '\\');
      var uncRoot = /^\\\\([^\\]+)\\([^\\]+)\\*$/.exec(normalized);
      if (uncRoot) return alias('\\\\' + uncRoot[1] + '\\' + uncRoot[2] + '\\');
    }
    var parts = value.replace(style === 'win32' ? /[\\/]+$/ : /\/+$/, '').split(style === 'win32' ? /[\\/]/ : /\//);
    var last = parts.pop();
    return alias(last && !/^[A-Za-z]:$/.test(last) ? last : value);
  }
  function url(value) {
    if (typeof value !== 'string' || value.length > 4000) fail('INVALID_URL');
    var parsed; try { parsed = new URL(value); } catch (_) { fail('INVALID_URL'); }
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) fail('INVALID_URL');
    return parsed.href;
  }
  function configure(value) {
    if (!Number.isSafeInteger(value.grantRevision) || value.grantRevision < 1 || typeof value.desktopEnabled !== 'boolean') fail('INVALID_GRANTS');
    if (!Array.isArray(value.workspaces) || !value.workspaces.length || value.workspaces.length > LIMITS.workspaces) fail('WORKSPACE_LIMIT');
    var seen = new Set(); var startup = 0;
    value.workspaces.forEach(function (item) {
      fields(item, ['id', 'kind', 'path', 'permissions'], ['id', 'kind', 'permissions']);
      id(item.id); permissions(item.permissions);
      if (seen.has(item.id)) fail('DUPLICATE_WORKSPACE'); seen.add(item.id);
      if (item.id === 'startup' && item.kind === 'startup' && !own(item, 'path')) startup++;
      else if (item.kind !== 'custom' || item.id === 'startup') fail('INVALID_STARTUP');
      else workspacePath(item.path);
    });
    if (startup !== 1) fail('STARTUP_REQUIRED');
    return value;
  }
  function clientInfo(value) {
    fields(value, ['clientId', 'clientName', 'extensionId', 'incognito', 'version', 'userAgent'], ['extensionId', 'incognito']);
    id(value.extensionId);
    if (typeof value.incognito !== 'boolean') fail('INVALID_CLIENT_INFO');
    if (value.clientId !== undefined) id(value.clientId);
    ['clientName', 'version', 'userAgent'].forEach(function (key) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > (key === 'version' ? 100 : 300))) fail('INVALID_CLIENT_INFO');
    });
  }
  function serverName(value) {
    if (typeof value !== 'string') fail('INVALID_SERVER_NAME');
    var name = value.trim().normalize('NFC');
    if (!name || name.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) fail('INVALID_SERVER_NAME', '服务端名称须为 1–300 个字符，且不能含控制字符');
    return name;
  }
  function caller(value) {
    fields(value, ['kind', 'actorId', 'conversationId', 'runId', 'parentRequest'], ['kind', 'actorId', 'conversationId', 'runId', 'parentRequest']);
    if (!['agent', 'flow', 'app', 'ui', 'external'].includes(value.kind)) fail('INVALID_CALLER');
    id(value.actorId);
    ['conversationId', 'runId'].forEach(function (key) { if (value[key] !== null) id(value[key]); });
    if (value.parentRequest !== null) {
      fields(value.parentRequest, ['transportSessionId', 'requestId'], ['transportSessionId', 'requestId']);
      id(value.parentRequest.transportSessionId); id(value.parentRequest.requestId);
    }
  }
  function nullableText(value, max) {
    if (value !== null && (typeof value !== 'string' || value.length > max || value.includes('\0'))) fail('INVALID_TEXT');
  }
  function timestamp(value) { if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail('INVALID_TIMESTAMP'); }
  function byteValue(value) { if (value !== null && (typeof value !== 'string' || !/^\d{1,40}$/.test(value))) fail('INVALID_BYTES'); }
  function environment(value) {
    fields(value, ['schemaVersion', 'revision', 'observedAt', 'stale', 'reason', 'os', 'runtime', 'shell', 'cpu', 'memory', 'executor'], ['schemaVersion', 'revision', 'observedAt', 'stale', 'reason', 'os', 'runtime', 'shell', 'cpu', 'memory', 'executor']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.stale !== 'boolean') fail('INVALID_ENVIRONMENT');
    timestamp(value.observedAt); nullableText(value.reason, 200);
    fields(value.os, ['platform', 'version', 'kernelRelease', 'distribution'], ['platform', 'version', 'kernelRelease', 'distribution']);
    if (typeof value.os.platform !== 'string') fail('INVALID_PLATFORM');
    ['platform', 'version', 'kernelRelease'].forEach(function (key) { nullableText(value.os[key], 500); });
    if (value.os.distribution !== null) {
      fields(value.os.distribution, ['id', 'version', 'name'], ['id', 'version', 'name']);
      Object.values(value.os.distribution).forEach(function (text) { nullableText(text, 500); });
    }
    fields(value.runtime, ['nodeVersion', 'arch', 'pathStyle'], ['nodeVersion', 'arch', 'pathStyle']);
    if (!['posix', 'win32'].includes(value.runtime.pathStyle) || typeof value.runtime.nodeVersion !== 'string' || typeof value.runtime.arch !== 'string') fail('INVALID_RUNTIME');
    nullableText(value.runtime.nodeVersion, 100); nullableText(value.runtime.arch, 100);
    if (value.shell !== null) {
      fields(value.shell, ['kind', 'executable', 'version', 'environment'], ['kind', 'executable', 'version', 'environment']);
      if (value.shell.kind !== 'bash' || value.shell.environment !== 'unknown' || value.shell.version !== null) fail('INVALID_SHELL'); workspacePath(value.shell.executable, value.runtime.pathStyle);
    }
    fields(value.cpu, ['logicalCount', 'availableParallelism'], ['logicalCount', 'availableParallelism']);
    Object.values(value.cpu).forEach(function (count) { if (count !== null && (!Number.isSafeInteger(count) || count < 0)) fail('INVALID_CPU'); });
    fields(value.memory, ['totalBytes'], ['totalBytes']); byteValue(value.memory.totalBytes);
    fields(value.executor, ['user', 'uid', 'gid'], ['user', 'uid', 'gid']); nullableText(value.executor.user, 1000);
    ['uid', 'gid'].forEach(function (key) { if (value.executor[key] !== null && (!Number.isSafeInteger(value.executor[key]) || value.executor[key] < 0)) fail('INVALID_EXECUTOR'); });
  }
  function capabilities(value) {
    var keys = ['localProtocol', 'files', 'bash', 'desktop', 'mail', 'serverPolicy', 'policyRevision', 'environment', 'execution', 'audit'];
    fields(value, keys.concat(['configuration']), keys);
    if (value.configuration !== undefined) {
      fields(value.configuration, ['protocol', 'formatVersion', 'version'], []);
      ['protocol', 'formatVersion'].forEach(function (key) {
        if (value.configuration[key] !== undefined && (!Number.isSafeInteger(value.configuration[key]) || value.configuration[key] < 1)) fail('INVALID_CAPABILITIES');
      });
      if (value.configuration.version !== undefined && (typeof value.configuration.version !== 'string' || value.configuration.version.length > 100)) fail('INVALID_CAPABILITIES');
    }
    if (value.localProtocol !== 'local/2' || value.serverPolicy !== 'allow-implemented' || value.policyRevision !== 1) fail('PROTOCOL_INCOMPATIBLE');
    if (!Array.isArray(value.files) || value.files.some(function (name) { return !['read', 'write', 'delete', 'grep'].includes(name); })) fail('INVALID_CAPABILITIES');
    fields(value.bash, ['supported', 'executable'], ['supported', 'executable']);
    if (typeof value.bash.supported !== 'boolean') fail('INVALID_CAPABILITIES');
    if (value.bash.supported) workspacePath(value.bash.executable); else if (value.bash.executable !== null) fail('INVALID_CAPABILITIES');
    fields(value.desktop, ['supported', 'actions', 'reason', 'permissionsVerified', 'requirements'], ['supported', 'actions', 'reason']);
    if (typeof value.desktop.supported !== 'boolean' || !record(value.desktop.actions)) fail('INVALID_CAPABILITIES');
    nullableText(value.desktop.reason, 200);
    if (value.desktop.permissionsVerified !== undefined && typeof value.desktop.permissionsVerified !== 'boolean') fail('INVALID_CAPABILITIES');
    if (value.desktop.requirements !== undefined) nullableText(value.desktop.requirements, 2000);
    Object.keys(value.desktop.actions).forEach(function (name) {
      if (!DESKTOP_OPERATIONS.concat(['locate']).includes(name) || !Array.isArray(value.desktop.actions[name]) || value.desktop.actions[name].length > 30
        || value.desktop.actions[name].some(function (action) { return typeof action !== 'string' || action.length > 100; })) fail('INVALID_CAPABILITIES');
    });
    fields(value.mail, ['supported', 'protocol'], ['supported', 'protocol']); if (typeof value.mail.supported !== 'boolean' || value.mail.protocol !== 'smtp/1') fail('INVALID_CAPABILITIES');
    fields(value.audit, ['enabled', 'available', 'commandContent'], ['enabled', 'available', 'commandContent']);
    if (value.audit.enabled !== true || typeof value.audit.available !== 'boolean' || !['hash', 'plain'].includes(value.audit.commandContent)) fail('INVALID_CAPABILITIES');
    fields(value.environment, ['schemaVersion', 'disk', 'dynamicTtlMs'], ['schemaVersion', 'disk', 'dynamicTtlMs']);
    if (value.environment.schemaVersion !== 1 || typeof value.environment.disk !== 'boolean' || value.environment.dynamicTtlMs !== LIMITS.dynamicTtlMs) fail('INVALID_CAPABILITIES');
    fields(value.execution, Object.keys(LIMITS).concat(['cancelAck', 'processTermination', 'cpuHardLimit', 'memoryHardLimit']), ['cancelAck', 'processTermination', 'cpuHardLimit', 'memoryHardLimit']);
    Object.keys(LIMITS).forEach(function (key) { if (value.execution[key] !== undefined && (!Number.isSafeInteger(value.execution[key]) || value.execution[key] < 1)) fail('INVALID_CAPABILITIES'); });
    if (value.execution.cancelAck !== true || value.execution.cpuHardLimit !== false || value.execution.memoryHardLimit !== false
      || !['posix-process-group', 'windows-taskkill-tree', 'windows-child-only'].includes(value.execution.processTermination)) fail('INVALID_CAPABILITIES');
  }
  function sample(value, disk) {
    var counts = disk ? ['totalBytes', 'availableBytes', 'freeBytes', 'quotaLimitBytes', 'quotaRemainingBytes'] : ['freeBytes', 'processAvailableBytes', 'processConstraintBytes'];
    var keys = ['observedAt', 'expiresAt', 'status', 'reason'].concat(counts, disk ? ['readOnly', 'workspaceId', 'resolvedPath', 'grantRevision'] : []);
    fields(value, keys, keys); timestamp(value.observedAt); timestamp(value.expiresAt); nullableText(value.reason, 200);
    if (!['ok', 'partial', 'unavailable'].includes(value.status)) fail('INVALID_SAMPLE'); counts.forEach(function (key) { byteValue(value[key]); });
    if (disk) { id(value.workspaceId); workspacePath(value.resolvedPath); if (!Number.isSafeInteger(value.grantRevision) || value.grantRevision < 1 || value.readOnly !== null && typeof value.readOnly !== 'boolean') fail('INVALID_SAMPLE'); }
  }
  function frame(value, identity) {
    if (!record(value) || !own(FRAME_FIELDS, value.type)) fail('UNKNOWN_FRAME');
    fields(value, COMMON.concat(FRAME_FIELDS[value.type]), COMMON);
    if (value.transportProtocol !== 'page-agent/2') fail('PROTOCOL_INCOMPATIBLE');
    ['serverId', 'clientId', 'transportSessionId', 'requestId'].forEach(function (key) { id(value[key]); });
    if (identity) ['serverId', 'clientId', 'transportSessionId'].forEach(function (key) {
      if (identity[key] !== value[key]) fail('IDENTITY_MISMATCH', '会话身份不匹配', 'FORBIDDEN');
    });
    if (value.type === 'hello') {
      if (value.protocol !== 'arp/1') fail('PROTOCOL_INCOMPATIBLE');
      if (value.clientInfo) {
        fields(value, COMMON.concat(['protocol', 'clientInfo']), COMMON.concat(['protocol', 'clientInfo'])); clientInfo(value.clientInfo);
      } else {
        fields(value, COMMON.concat(['protocol', 'serverName', 'version', 'platform', 'startupWorkingDirectory', 'capabilities', 'environment']), COMMON.concat(['protocol', 'version', 'platform', 'startupWorkingDirectory', 'capabilities', 'environment']));
        if (typeof value.version !== 'string' || value.version.length > 100 || typeof value.platform !== 'string') fail('INVALID_HELLO');
        if (value.serverName !== undefined) serverName(value.serverName);
        capabilities(value.capabilities); environment(value.environment); workspacePath(value.startupWorkingDirectory, value.environment.runtime.pathStyle);
        if (value.platform !== value.environment.os.platform) fail('INVALID_HELLO');
      }
    }
    if (value.type === 'local.configure') configure(value);
    if (value.type === 'local.call') {
      if (!own(DIRECTORY_OPERATIONS, value.operation) && !DESKTOP_OPERATIONS.includes(value.operation)) fail('UNKNOWN_OPERATION');
      if (!record(value.input)) fail('INVALID_INPUT'); caller(value.caller);
      if (!Number.isSafeInteger(value.grantRevision) || value.grantRevision < 1) fail('INVALID_GRANTS');
      if (own(DIRECTORY_OPERATIONS, value.operation)) { id(value.workspaceId); workspacePath(value.workingDirectory); }
      else if (own(value, 'workspaceId') || own(value, 'workingDirectory')) fail('DESKTOP_HAS_NO_WORKSPACE');
    }
    if (value.type === 'environment.get') {
      caller(value.caller);
      if (typeof value.refresh !== 'boolean' || !['server', 'workspace'].includes(value.scope)) fail('INVALID_ENVIRONMENT_SCOPE');
      if (value.scope === 'workspace') { id(value.workspaceId); workspacePath(value.workingDirectory); if (!Number.isSafeInteger(value.grantRevision) || value.grantRevision < 1) fail('INVALID_GRANTS'); }
      else if (['workspaceId', 'workingDirectory', 'grantRevision'].some(function (key) { return own(value, key); })) fail('UNEXPECTED_WORKSPACE');
    }
    if (value.type === 'local.cancel' && !['user', 'client_timeout', 'grant_revoked'].includes(value.reason)) fail('INVALID_STOP_REASON');
    if (value.type === 'local.cancel.ack' && !['accepted', 'settled', 'not_found'].includes(value.status)) fail('INVALID_CANCEL_STATUS');
    if (value.type === 'heartbeat' && (!Number.isFinite(value.sentAt) || value.sentAt < 0)) fail('INVALID_HEARTBEAT');
    if (value.type === 'server.status') {
      fields(value.audit, ['available'], ['available']); if (typeof value.audit.available !== 'boolean' || !Number.isSafeInteger(value.environmentRevision) || value.environmentRevision < 0) fail('INVALID_STATUS');
    }
    if (['local.result', 'local.configured', 'environment.result', 'mail.result'].includes(value.type)) {
      if (typeof value.ok !== 'boolean') fail('INVALID_RESULT');
      fields(value.audit, ['recorded'], ['recorded']); if (typeof value.audit.recorded !== 'boolean') fail('INVALID_AUDIT');
      if (!value.ok) {
        fields(value.error, ['code', 'reason', 'message', 'retryable'], ['code', 'reason', 'message', 'retryable']);
        if ([value.error.code, value.error.reason, value.error.message].some(function (text) { return typeof text !== 'string' || text.length > 2000; }) || typeof value.error.retryable !== 'boolean') fail('INVALID_ERROR');
      }
      if (value.type === 'mail.result') {
        fields(value.receipt, ['performed'], ['performed']);
        if (!['no', 'yes', 'unknown'].includes(value.receipt.performed)) fail('INVALID_RECEIPT');
      }
      if (value.type === 'local.result') {
        if (value.operation !== null && !own(DIRECTORY_OPERATIONS, value.operation) && !DESKTOP_OPERATIONS.includes(value.operation)) fail('INVALID_OPERATION');
        if (value.grantRevision !== null && (!Number.isSafeInteger(value.grantRevision) || value.grantRevision < 1)) fail('INVALID_GRANTS');
        if (own(value, 'workspaceId') || own(value, 'workingDirectory')) { id(value.workspaceId); workspacePath(value.workingDirectory); }
        fields(value.receipt, ['performed'], ['performed']); if (!['no', 'yes', 'unknown'].includes(value.receipt.performed)) fail('INVALID_RECEIPT');
        fields(value.execution, ['outcome', 'startedAt', 'finishedAt', 'durationMs', 'effectiveTimeoutMs', 'termination', 'stopReason', 'stopReasonAssurance', 'terminationScope'], ['outcome', 'startedAt', 'finishedAt', 'durationMs', 'effectiveTimeoutMs', 'termination', 'stopReason', 'stopReasonAssurance']);
        var execution = value.execution;
        if (!['rejected', 'succeeded', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(execution.outcome)
          || value.ok !== (execution.outcome === 'succeeded') || !['not_started', 'settled', 'unconfirmed'].includes(execution.termination)
          || !Number.isFinite(execution.durationMs) || execution.durationMs < 0
          || execution.effectiveTimeoutMs !== null && (!Number.isSafeInteger(execution.effectiveTimeoutMs) || execution.effectiveTimeoutMs < 1)
          || ![null, 'user', 'client_timeout', 'timeout', 'disconnect', 'grant_revoked', 'shutdown'].includes(execution.stopReason)
          || ![null, 'client_asserted', 'server_verified'].includes(execution.stopReasonAssurance)
          || (execution.stopReason === null) !== (execution.stopReasonAssurance === null)
          || execution.stopReasonAssurance === 'client_asserted' && !['user', 'client_timeout', 'grant_revoked'].includes(execution.stopReason)
          || own(execution, 'terminationScope') && !['process-group', 'process-tree', 'direct-child-only', 'unconfirmed'].includes(execution.terminationScope)) fail('INVALID_EXECUTION');
        ['startedAt', 'finishedAt'].forEach(function (name) { if (execution[name] !== null && (typeof execution[name] !== 'string' || !Number.isFinite(Date.parse(execution[name])))) fail('INVALID_EXECUTION_TIME'); });
      }
      if (value.type === 'local.configured' && value.ok) {
        if (!Number.isSafeInteger(value.acceptedRevision) || value.acceptedRevision < 1 || typeof value.desktopEnabled !== 'boolean' || !Array.isArray(value.workspaces) || value.workspaces.length > LIMITS.workspaces) fail('INVALID_CONFIGURATION');
        var workspaceIds = new Set();
        value.workspaces.forEach(function (workspace) {
          fields(workspace, ['id', 'kind', 'resolvedPath', 'state', 'reason', 'effectivePermissions'], ['id', 'kind', 'resolvedPath', 'state', 'reason', 'effectivePermissions']);
          id(workspace.id); if (workspaceIds.has(workspace.id)) fail('DUPLICATE_WORKSPACE'); workspaceIds.add(workspace.id);
          if (workspace.kind !== (workspace.id === 'startup' ? 'startup' : 'custom')) fail('INVALID_WORKSPACE_KIND'); nullableText(workspace.reason, 200);
          if (workspace.resolvedPath !== null) workspacePath(workspace.resolvedPath);
          if (!['ready', 'invalid', 'changed', 'unverified'].includes(workspace.state)) fail('INVALID_WORKSPACE_STATE'); permissions(workspace.effectivePermissions);
        });
        if (!workspaceIds.has('startup')) fail('STARTUP_REQUIRED');
      }
      if (value.type === 'environment.result' && (!['server', 'workspace'].includes(value.scope) || value.ok && !record(value.data))) fail('INVALID_ENVIRONMENT_RESULT');
      if (value.type === 'environment.result' && value.ok) {
        if (value.scope === 'server') { fields(value.data, ['environment', 'memory'], ['environment', 'memory']); environment(value.data.environment); sample(value.data.memory, false); }
        else { fields(value.data, ['disk'], ['disk']); sample(value.data.disk, true); }
      }
      if (value.type === 'mail.result' && value.ok && !record(value.result)) fail('INVALID_MAIL_RESULT');
    }
    if (['arp.cancel', 'arp.call.cancel', 'mail.cancel'].includes(value.type) && value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 500)) fail('INVALID_CANCEL_REASON');
    if (value.type === 'mail.send') { caller(value.caller); if (!record(value.payload)) fail('INVALID_INPUT'); }
    if (value.type === 'arp.request') {
      fields(value.principal, ['id', 'transport'], ['id', 'transport']);
      if (value.principal.transport === 'websocket') id(value.principal.id);
      else if (value.principal.transport === 'system' && value.principal.id === 'archive') { /* server-owned archive job */ }
      else if (value.principal.id !== 'http:operator' || value.principal.transport !== 'http') fail('INVALID_PRINCIPAL');
      fields(value.context, ['sessionId', 'conversationId', 'parentRequest'], ['sessionId', 'conversationId', 'parentRequest']);
      id(value.context.sessionId); id(value.context.conversationId);
      if (value.context.parentRequest !== null) { fields(value.context.parentRequest, ['transportSessionId', 'requestId'], ['transportSessionId', 'requestId']); id(value.context.parentRequest.transportSessionId); id(value.context.parentRequest.requestId); }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(value.method) || !record(value.request)) fail('INVALID_ARP_REQUEST');
    }
    if (value.type === 'arp.call') {
      caller(value.caller);
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(value.method) || !record(value.request)) fail('INVALID_ARP_REQUEST');
    }
    if (['arp.result', 'arp.response'].includes(value.type) && (!record(value.envelope) || value.envelope.protocol !== 'arp/1'
      || !record(value.envelope.status) || !Number.isInteger(value.envelope.status.code))) fail('INVALID_ARP_RESULT');
    return value;
  }
  function authFrame(value) {
    var base = ['type', 'transportProtocol', 'authProtocol'];
    var types = { 'auth.required': ['serverId'], 'auth.pair': ['requestId', 'clientId', 'clientInfo', 'password', 'expectedServerId'],
      'auth.resume': ['requestId', 'clientId', 'clientInfo', 'pairingId', 'token', 'expectedServerId', 'communicationKey'],
      'auth.ok': ['requestId', 'serverId', 'clientId', 'pairingId', 'transportSessionId', 'token', 'communicationKey'],
      'auth.error': ['requestId', 'code', 'reason', 'retryable', 'retryAfterMs'] };
    if (!record(value) || !own(types, value.type)) fail('PROTOCOL_INCOMPATIBLE');
    fields(value, base.concat(types[value.type], ['pairingVersion']), base);
    if (value.transportProtocol !== 'page-agent/2' || value.authProtocol !== 'auth/1') fail('PROTOCOL_INCOMPATIBLE');
    if (value.type !== 'auth.error' && value.pairingVersion !== 'v1') fail('PROTOCOL_INCOMPATIBLE');
    if (value.type === 'auth.required' && value.serverId !== undefined) id(value.serverId);
    if (['auth.pair', 'auth.resume'].includes(value.type)) {
      id(value.requestId); id(value.clientId); clientInfo(value.clientInfo);
      if (value.clientInfo.clientId && value.clientInfo.clientId !== value.clientId) fail('IDENTITY_MISMATCH');
      if (value.expectedServerId !== undefined && value.expectedServerId !== null) id(value.expectedServerId);
      if (value.type === 'auth.resume') {
        id(value.pairingId); id(value.expectedServerId);
        if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) fail('INVALID_CREDENTIAL');
        if (value.communicationKey !== undefined) communicationKey(value.communicationKey);
      }
      else password(value.password);
    }
    if (value.type === 'auth.ok') {
      ['requestId', 'serverId', 'clientId', 'pairingId', 'transportSessionId'].forEach(function (name) { id(value[name]); });
      if (value.token !== undefined && (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token))) fail('INVALID_CREDENTIAL');
      if (value.token !== undefined) communicationKey(value.communicationKey);
      else if (value.communicationKey !== undefined) fail('INVALID_CREDENTIAL');
    }
    if (value.type === 'auth.error' && (typeof value.code !== 'string' || typeof value.reason !== 'string' || typeof value.retryable !== 'boolean'
      || value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0))) fail('INVALID_AUTH_ERROR');
    return value;
  }
  function password(value) {
    if (typeof value !== 'string' || Array.from(value).length < 12 || Array.from(value).length > 256 || value.includes('\0')) fail('INVALID_PASSWORD', '密码长度必须为 12–256 个 Unicode 码点，且不能含 NUL');
    return value;
  }
  function communicationKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) fail('INVALID_COMMUNICATION_KEY');
    return value;
  }
  function resultTarget(value) {
    var operation = own(DIRECTORY_OPERATIONS, value.operation) || DESKTOP_OPERATIONS.includes(value.operation) ? value.operation : null;
    var target = { operation: operation, grantRevision: Number.isSafeInteger(value.grantRevision) && value.grantRevision > 0 ? value.grantRevision : null };
    if (operation && own(DIRECTORY_OPERATIONS, operation)) {
      try { id(value.workspaceId); workspacePath(value.workingDirectory); target.workspaceId = value.workspaceId; target.workingDirectory = value.workingDirectory; } catch (_) {}
    }
    return target;
  }
  var CONFIGURATION = Object.freeze({ protocol: 5, formatVersion: 7 });
  function configurationCompatibility(local, remote) {
    if (!remote || remote.protocol !== local.protocol) return 'SYNC_PROTOCOL_MISMATCH';
    if (remote.formatVersion !== local.formatVersion) return 'BACKUP_FORMAT_MISMATCH';
    var left = /^(\d+)\.\d+\.\d+(?:\.\d+)?$/.exec(local.version || '');
    var right = /^(\d+)\.\d+\.\d+(?:\.\d+)?$/.exec(remote.version || '');
    if (!left || !right || left[1] !== right[1]) return 'APPLICATION_VERSION_MISMATCH';
    return null;
  }
  return Object.freeze({ LIMITS: LIMITS, DIRECTORY_OPERATIONS: DIRECTORY_OPERATIONS, DESKTOP_OPERATIONS: DESKTOP_OPERATIONS,
    CONFIGURATION: CONFIGURATION, configurationCompatibility: configurationCompatibility,
    TRANSPORT: 'page-agent/2', AUTH: 'auth/1', PAIRING: 'v1', LOCAL: 'local/2', record: record, own: own, fail: fail,
    fields: fields, id: id, alias: alias, serverName: serverName, uniqueAliases: uniqueAliases, permissions: permissions,
    closedPermissions: closedPermissions, arpPermissions: arpPermissions, arpPermission: arpPermission,
    workspacePath: workspacePath, defaultWorkspaceAlias: defaultWorkspaceAlias,
    url: url, configure: configure, caller: caller, frame: frame, authFrame: authFrame, password: password,
    communicationKey: communicationKey, resultTarget: resultTarget });
});
