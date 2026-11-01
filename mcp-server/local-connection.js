'use strict';

const fs = require('fs/promises');
const path = require('path');
const contract = require('../shared/mcp-contract');
const arp = require('../resources/protocol');
const { OPERATIONS, isRead } = require('../resources/modules/local-resource');
const { execute, localPath, checkedPath } = require('./local-operations');
const { safeError, checkSignal } = require('./execution-control');
const { LIMITS } = contract;

function denied(reason, code = 'FORBIDDEN') { contract.fail(reason, reason, code); }
function createLocalConnection(options) {
  const { identity, reply, auth, audit, execution, environment, capabilities, startupDirectory, shell } = options;
  let snapshot = null, signature = '', queue = Promise.resolve(), closed = false, configuring = 0, configurationRecorded = false;
  const seen = options.seen || new Set(); const settled = new Map();
  const sameSession = item => item.identity.transportSessionId === identity.transportSessionId;
  const context = message => {
    let caller = null; try { contract.caller(message.caller); caller = message.caller; } catch (_) {}
    return { transportSessionId: identity.transportSessionId, requestId: typeof message.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(message.requestId) ? message.requestId : null,
    parentRequest: caller ? caller.parentRequest : null,
    principal: { transport: 'websocket', id: identity.clientId, clientId: identity.clientId, pairingId: identity.pairingId },
    caller: caller ? { kind: caller.kind, actorId: caller.actorId, conversationId: caller.conversationId, runId: caller.runId } : null,
    callerAssurance: 'client_asserted', parentAssurance: caller && caller.parentRequest ? 'client_asserted' : null,
    executor: { ...environment.base.executor, pid: null }, operation: contract.resultTarget(message).operation || ['hello', 'local.configure', 'environment.get', 'mail.send'].includes(message.type) && message.type || 'invalid',
    policyRevision: 1, grantRevision: contract.resultTarget(message).grantRevision };
  };
  function configure(message) {
    contract.configure(message);
    configuring += 1;
    // A reduction takes effect before filesystem checks or durable expansion records.
    if (snapshot && message.grantRevision > snapshot.acceptedRevision) {
      if (!message.desktopEnabled) snapshot.desktopEnabled = false;
      snapshot.workspaces.forEach(old => {
        const requested = message.workspaces.find(item => item.id === old.id);
        for (const permission of Object.keys(old.effectivePermissions)) {
          if (!requested || !requested.permissions[permission] || (requested.kind === 'custom' && requested.path !== old.configuredPath)) old.effectivePermissions[permission] = false;
        }
      });
      execution.cancelWhere(item => {
        if (!sameSession(item)) return false;
        if (OPERATIONS[item.operation] && OPERATIONS[item.operation].desktop && !snapshot.desktopEnabled) return true;
        if (!item.workspaceId) return false;
        const workspace = snapshot.workspaces.find(value => value.id === item.workspaceId);
        const permission = contract.DIRECTORY_OPERATIONS[item.operation];
        return !workspace || (permission ? !workspace.effectivePermissions[permission] : !Object.values(workspace.effectivePermissions).some(Boolean));
      }, 'grant_revoked');
    }
    const work = queue.then(async () => {
      contract.configure(message); await auth.assertActive(identity);
      const nextSignature = JSON.stringify([message.grantRevision, message.desktopEnabled, message.workspaces]);
      if (snapshot && message.grantRevision < snapshot.acceptedRevision) denied('GRANT_REVISION_CHANGED', 'AUTHORIZATION_CHANGED');
      if (snapshot && message.grantRevision === snapshot.acceptedRevision) {
        if (signature !== nextSignature) denied('GRANT_REVISION_CONFLICT', 'RESOURCE_CONFLICT');
        return publicSnapshot(snapshot, configurationRecorded);
      }
      const workspaces = await Promise.all(message.workspaces.map(async workspace => {
        const item = { id: workspace.id, kind: workspace.kind, configuredPath: workspace.path || startupDirectory,
          resolvedPath: null, state: 'invalid', reason: null, effectivePermissions: contract.closedPermissions() };
        try {
          contract.workspacePath(item.configuredPath, process.platform === 'win32' ? 'win32' : 'posix');
          item.resolvedPath = await fs.realpath(item.configuredPath);
          if (!(await fs.stat(item.resolvedPath)).isDirectory()) throw new Error('NOT_DIRECTORY');
          item.state = 'ready'; item.effectivePermissions = { ...workspace.permissions };
          const previous = snapshot && snapshot.workspaces.find(old => old.id === workspace.id);
          if (previous && previous.resolvedPath && previous.resolvedPath !== item.resolvedPath) {
            item.state = 'changed'; item.reason = 'WORKSPACE_CHANGED'; item.effectivePermissions = contract.closedPermissions();
          }
        } catch (_) { item.reason = 'WORKSPACE_INVALID'; }
        return item;
      }));
      for (const item of workspaces) {
        const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
        if (item.resolvedPath && item.id !== 'startup' && workspaces.some(other => other !== item && other.resolvedPath && key(other.resolvedPath) === key(item.resolvedPath))) {
          item.state = 'invalid'; item.reason = 'DUPLICATE_ROOT'; item.effectivePermissions = contract.closedPermissions();
        }
      }
      const next = { acceptedRevision: message.grantRevision, workspaces,
        desktopEnabled: message.desktopEnabled && capabilities.desktop.supported };
      const expanded = next.desktopEnabled && !(snapshot && snapshot.desktopEnabled)
        || workspaces.some(item => {
          const old = snapshot && snapshot.workspaces.find(value => value.id === item.id);
          return Object.keys(item.effectivePermissions).some(key => item.effectivePermissions[key] && (!old || old.resolvedPath !== item.resolvedPath || !old.effectivePermissions[key]));
        });
      const auditContext = { ...context(message), parameters: { previousRevision: snapshot ? snapshot.acceptedRevision : null,
        nextRevision: next.acceptedRevision, desktopEnabled: next.desktopEnabled,
        permissions: workspaces.map(item => ({ id: item.id, ...audit.parameters('workspace', { path: item.resolvedPath }), permissions: item.effectivePermissions })) } };
      if (expanded) await audit.write('execution.intent', { ...auditContext, parameters: undefined });
      await auth.assertActive(identity); if (closed) denied('CONNECTION_NOT_READY', 'TEMPORARILY_UNAVAILABLE');
      if (snapshot && message.grantRevision <= snapshot.acceptedRevision) denied('GRANT_REVISION_CHANGED', 'AUTHORIZATION_CHANGED');
      execution.cancelWhere(item => {
        if (!sameSession(item)) return false;
        if (OPERATIONS[item.operation] && OPERATIONS[item.operation].desktop && !next.desktopEnabled) return true;
        if (!item.workspaceId) return false;
        const current = next.workspaces.find(value => value.id === item.workspaceId);
        const old = snapshot && snapshot.workspaces.find(value => value.id === item.workspaceId);
        const permission = contract.DIRECTORY_OPERATIONS[item.operation];
        return !current || current.state !== 'ready' || !old || old.resolvedPath !== current.resolvedPath
          || (permission ? !current.effectivePermissions[permission] : !Object.values(current.effectivePermissions).some(Boolean));
      }, 'grant_revoked');
      snapshot = next; signature = nextSignature;
      configurationRecorded = await audit.bestEffort('grants.changed', auditContext);
      return publicSnapshot(next, configurationRecorded);
    });
    const completed = work.finally(() => { configuring -= 1; });
    queue = completed.catch(() => {}); return completed;
  }
  function publicSnapshot(value, recorded) {
    return { acceptedRevision: value.acceptedRevision, desktopEnabled: value.desktopEnabled, audit: { recorded },
      workspaces: value.workspaces.map(({ configuredPath, ...workspace }) => workspace) };
  }
  async function authorize(message, admitted = false) {
    const rules = ['session.authenticated', 'credential.active'];
    try {
    await auth.assertActive(identity);
    rules.push('target.current', 'platform.supported', 'server.allow_implemented');
    if (closed || !snapshot) denied('CONNECTION_NOT_READY', 'TEMPORARILY_UNAVAILABLE');
    if (configuring && !admitted) denied('GRANT_REVISION_CHANGED', 'AUTHORIZATION_CHANGED');
    if (message.grantRevision !== undefined && !admitted && message.grantRevision !== snapshot.acceptedRevision) denied('GRANT_REVISION_CHANGED', 'AUTHORIZATION_CHANGED');
    let workspace;
    if (message.workspaceId) {
      workspace = snapshot.workspaces.find(item => item.id === message.workspaceId);
      if (!workspace) denied('WORKSPACE_NOT_FOUND', 'RESOURCE_NOT_FOUND');
      if (workspace.state !== 'ready' || workspace.resolvedPath !== message.workingDirectory) denied('WORKSPACE_CHANGED', 'DEPENDENCY_CHANGED');
      let currentPath = null;
      try {
        currentPath = await fs.realpath(workspace.configuredPath);
        if (!(await fs.stat(currentPath)).isDirectory()) currentPath = null;
      } catch (_) {}
      if (currentPath !== workspace.resolvedPath) {
        workspace.state = 'changed'; workspace.reason = 'WORKSPACE_CHANGED'; workspace.effectivePermissions = contract.closedPermissions();
        environment.invalidate(workspace.resolvedPath); execution.cancelWhere(item => sameSession(item) && item.workspaceId === workspace.id, 'grant_revoked');
        denied('WORKSPACE_CHANGED', 'DEPENDENCY_CHANGED');
      }
      const permission = contract.DIRECTORY_OPERATIONS[message.operation];
      if (permission) { rules.push('workspace.' + permission); if (!workspace.effectivePermissions[permission]) denied('WORKSPACE_PERMISSION_DENIED'); }
      else if (!Object.values(workspace.effectivePermissions).some(Boolean)) denied('WORKSPACE_PERMISSION_DENIED');
    }
    const definition = OPERATIONS[message.operation];
    if (definition && definition.desktop) {
      rules.push('desktop.enabled');
      if (!capabilities.desktop.supported || !capabilities.desktop.actions[message.operation]) denied('PLATFORM_UNSUPPORTED', 'UNSUPPORTED_CAPABILITY');
      if (!snapshot.desktopEnabled) denied('DESKTOP_PERMISSION_DENIED');
      if (message.input.action && !capabilities.desktop.actions[message.operation].includes(message.input.action)) denied('ACTION_UNSUPPORTED', 'UNSUPPORTED_CAPABILITY');
    }
    if (message.operation === 'bash' && !shell) denied('BASH_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY');
    return { workspace, decision: 'allow', ruleIds: rules, policyRevision: 1, grantRevision: message.grantRevision || snapshot.acceptedRevision };
    } catch (error) { error.ruleIds = rules; throw error; }
  }
  function remember(requestId) {
    settled.set(requestId, Date.now());
    for (const [key, time] of settled) if (Date.now() - time > LIMITS.settledTtlMs || settled.size > LIMITS.settledCount) settled.delete(key);
  }
  async function handle(message) {
    if (message.type === 'local.cancel') {
      const found = execution.cancel(identity, message.requestId, message.reason, 'client_asserted');
      for (const [key, time] of settled) if (Date.now() - time > LIMITS.settledTtlMs) settled.delete(key);
      reply({ type: 'local.cancel.ack', requestId: message.requestId, status: found || (settled.has(message.requestId) ? 'settled' : 'not_found') }); return;
    }
    const environmental = message.type === 'environment.get';
    let auditContext = context(message);
    const base = { type: environmental ? 'environment.result' : 'local.result', requestId: message.requestId,
      ...(environmental ? { scope: message.scope } : contract.resultTarget(message)) };
    try {
      contract.frame(message, identity);
      if (seen.has(message.requestId)) throw Object.assign(new Error('重复请求，原执行结果不可推断'), { code: 'RESOURCE_CONFLICT', reason: 'DUPLICATE_REQUEST', performed: 'unknown' });
      if (seen.size >= LIMITS.seenRequests) denied('SESSION_REQUEST_LIMIT', 'RESOURCE_BUSY');
      seen.add(message.requestId);
      if (!environmental && (!OPERATIONS[message.operation] || !arp.validateJsonSchema(OPERATIONS[message.operation].inputSchema, message.input).valid)) denied('INVALID_INPUT', 'INVALID_REQUEST');
      auditContext.parameters = audit.parameters(environmental ? 'environment' : message.operation, environmental ? message : message.input, shell);
      if (message.caller && message.caller.parentRequest && options.validateParent) {
        auditContext.parentAssurance = options.validateParent(message.caller.parentRequest, identity) ? 'server_verified' : 'client_asserted';
      }
      let authorization, directory, targetPath;
      const timeoutMs = environmental ? LIMITS.sampleTimeoutMs : message.operation === 'bash' ? message.input.timeoutMs || LIMITS.bashDefaultTimeoutMs
        : OPERATIONS[message.operation].desktop ? LIMITS.desktopTimeoutMs : LIMITS.fileTimeoutMs;
      const value = await execution.run({ identity, requestId: message.requestId, operation: environmental ? 'environment' : message.operation,
        workspaceId: message.workspaceId, timeoutMs, readOnly: environmental || isRead(message.operation, message.input), context: auditContext,
        timeoutResult: environmental ? async () => {
          await authorize(message, true);
          return environment.unavailable(authorization.workspace, message.grantRevision);
        } : null,
        validate: async signal => {
          checkSignal(signal); authorization = await authorize(message);
          directory = authorization.workspace ? authorization.workspace.resolvedPath : startupDirectory;
          const inputPath = message.input && (message.input.path || message.input.templatePath);
          targetPath = inputPath ? localPath(inputPath, directory) : null;
          Object.assign(auditContext, authorization, { workspace: undefined, workspaceId: message.workspaceId || null,
            resolvedPath: message.workspaceId ? directory : null, targetPath });
          if (targetPath) {
            const checked = await checkedPath(directory, message.operation === 'delete' ? path.dirname(targetPath) : targetPath, message.operation === 'write');
            auditContext.targetPath = message.operation === 'delete' ? path.join(checked, path.basename(targetPath)) : checked;
          }
          if (options.validateParent && message.caller) await options.validateParent(message.caller.parentRequest, identity);
        },
        execute: async signal => {
          if (!environmental) return execute(message.operation, message.input, signal, directory, shell);
          const data = message.scope === 'server' ? await environment.server(message.refresh)
            : await environment.disk(authorization.workspace, message.grantRevision, message.refresh);
          await authorize(message, true); return data;
        } });
      remember(message.requestId);
      if (environmental) reply({ ...base, ok: value.ok, ...(value.ok ? { data: value.result } : { error: value.error }), audit: value.audit });
      else reply({ ...base, ...value });
    } catch (error) {
      const recorded = await audit.bestEffort('authorization.denied', { ...auditContext, decision: 'deny', errorReason: error.reason || 'INVALID_REQUEST' });
      reply({ ...base, ok: false, error: safeError(error), audit: { recorded }, ...(environmental ? {} : {
        receipt: { performed: error.performed || 'no' }, execution: { outcome: 'rejected', startedAt: null, finishedAt: null,
          durationMs: 0, effectiveTimeoutMs: null, termination: 'not_started', stopReason: null, stopReasonAssurance: null } }) });
    }
  }
  return { configure, handle, context, getSnapshot: () => snapshot,
    close: (reason = 'disconnect') => { closed = true; execution.cancelWhere(sameSession, reason); } };
}
module.exports = { createLocalConnection };
