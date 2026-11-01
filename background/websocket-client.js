(function (root) {
  'use strict';
  var c = root.McpContract;
  function createWebSocketClient(deps) {
    var config = deps.connection, clientInfo = deps.clientInfo, socket = null, identity = null, serverInfo = null;
    var state = 'disconnected', reason = null, retryCount = 0, retryLimit = 20, retryTimer, heartbeatTimer, handshakeTimer;
    var pending = new Map(), inbound = new Map(), seen = new Set(), logs = [], waiters = [];
    var observations = { memory: null, disks: {} };
    var reconnect = true, generation = 0, acknowledged = null, configureQueue = Promise.resolve();
    var authRequestId = null, helloRequestId = null, helloPending = false, helloInfo = null, authStarted = false;
    var cipher = null, sendQueue = Promise.resolve();
    function hello() {
      if (helloPending) return;
      helloPending = true; helloInfo = JSON.stringify(clientInfo); helloRequestId = crypto.randomUUID();
      send({ type: 'hello', requestId: helloRequestId, protocol: 'arp/1', clientInfo: clientInfo });
    }
    function log(level, message) { logs.push({ timestamp: Date.now(), level: level, message: message }); if (logs.length > 80) logs.shift(); }
    function transition(next, detail) {
      state = next; reason = detail || null; log(next === 'ready' ? 'success' : 'info', next + (detail ? ': ' + detail : ''));
      if (deps.onChange) deps.onChange();
    }
    function status() { return { state: state, reason: reason, connected: !!socket && socket.readyState === WebSocket.OPEN,
      connecting: state === 'connecting', ready: state === 'ready', url: config.url, retryCount: retryCount, retryLimit: retryLimit,
      clientInfo: clientInfo, serverInfo: serverInfo, serverId: identity && identity.serverId,
      transportSessionId: identity && identity.transportSessionId, configured: acknowledged, observations: observations, logs: logs.slice() }; }
    function settleWaiters(error) {
      waiters.splice(0).forEach(function (waiter) { clearTimeout(waiter.timer); if (error) waiter.reject(error); else waiter.resolve(status()); });
    }
    function send(body, expectedSocket) {
      var current = expectedSocket || socket;
      if (!current || current !== socket || current.readyState !== WebSocket.OPEN || !identity || !cipher) c.fail('CONNECTION_NOT_READY', '连接未就绪', 'TEMPORARILY_UNAVAILABLE');
      var text = JSON.stringify(Object.assign({}, body, { transportProtocol: c.TRANSPORT, serverId: identity.serverId,
        clientId: identity.clientId, transportSessionId: identity.transportSessionId, requestId: body.requestId || crypto.randomUUID() }));
      var currentCipher = cipher, epoch = generation;
      sendQueue = sendQueue.then(async function () {
        if (epoch !== generation || current !== socket || current.readyState !== WebSocket.OPEN) return;
        var encrypted = await currentCipher.encrypt(text);
        if (epoch === generation && current === socket && current.readyState === WebSocket.OPEN) current.send(encrypted);
      }).catch(function (error) { if (epoch === generation && current === socket) failConnection(error); });
    }
    function unknown(message) { return Object.assign(new Error(message), { code: 'UPSTREAM_FAILED', reason: 'RESULT_UNKNOWN', performed: 'unknown', retryable: false,
      execution: { outcome: 'unknown', termination: 'unconfirmed', finishedAt: null }, receipt: { performed: 'unknown' } }); }
    function finish(id, error, value) {
      var entry = pending.get(id); if (!entry) return;
      pending.delete(id); clearTimeout(entry.timer); clearTimeout(entry.stopTimer);
      if (entry.signal) entry.signal.removeEventListener('abort', entry.abort);
      if (entry.stopping && deps.onExecutionState) deps.onExecutionState({ connectionId: config.id, requestId: id,
        conversationId: entry.body.caller && entry.body.caller.conversationId,
        state: error && error.reason === 'RESULT_UNKNOWN' ? 'unknown' : 'settled' });
      if (error) {
        error.requestId = id; error.transportSessionId = entry.transportSessionId;
        entry.reject(error);
      } else entry.resolve(value);
    }
    function cancel(id, stopReason) {
      var entry = pending.get(id); if (!entry || entry.stopping) return;
      entry.stopping = true; clearTimeout(entry.timer);
      try { send({ type: entry.type === 'arp.call' ? 'arp.call.cancel' : entry.type === 'mail.send' ? 'mail.cancel' : 'local.cancel', requestId: id, reason: stopReason }, entry.socket); } catch (_) {}
      if (deps.onExecutionState) deps.onExecutionState({ connectionId: config.id, requestId: id, state: 'stopping', conversationId: entry.body.caller && entry.body.caller.conversationId });
      entry.stopTimer = setTimeout(function () { finish(id, unknown('停止请求已发送，但未确认执行结束；请勿自动重试')); }, c.LIMITS.stopWaitMs);
    }
    function request(type, body, options) {
      options = options || {};
      if (state !== 'ready' && type !== 'local.configure') return Promise.reject(Object.assign(new Error('连接未就绪'), { code: 'TEMPORARILY_UNAVAILABLE', reason: 'CONNECTION_NOT_READY', performed: 'no' }));
      if (options.signal && options.signal.aborted) return Promise.reject(Object.assign(new Error('请求已取消，尚未发送'), { performed: 'no' }));
      return new Promise(function (resolve, reject) {
        var id = crypto.randomUUID();
        var entry = { type: type, body: body, resolve: resolve, reject: reject, socket: socket,
          transportSessionId: identity && identity.transportSessionId, signal: options.signal, stopping: false };
        entry.abort = function () { cancel(id, 'user'); };
        entry.timer = setTimeout(function () {
          if (type === 'local.configure') {
            var error = Object.assign(new Error('目录同步超时'), { reason: 'CONFIGURE_TIMEOUT', code: 'TEMPORARILY_UNAVAILABLE' });
            finish(id, error); failConnection(error);
          }
          else cancel(id, 'client_timeout');
        }, type === 'local.configure' ? c.LIMITS.configureTimeoutMs : type === 'arp.call' ? 180000 : type === 'mail.send' ? 150000 : c.LIMITS.clientWaitMs);
        pending.set(id, entry); if (entry.signal) entry.signal.addEventListener('abort', entry.abort, { once: true });
        try { send(Object.assign({ type: type, requestId: id }, body)); }
        catch (error) { error.performed = 'no'; finish(id, error); }
      });
    }
    function synchronize() {
      var epoch = generation;
      var work = configureQueue.then(async function () {
        if (epoch !== generation || !identity || !serverInfo) return;
        transition('configuring');
        var current = config;
        var response = await request('local.configure', { grantRevision: current.grantRevision, desktopEnabled: current.desktopEnabled,
          workspaces: current.workspaces.map(function (workspace) { return { id: workspace.id, kind: workspace.kind,
            permissions: workspace.permissions, ...(workspace.kind === 'custom' ? { path: workspace.path } : {}) }; }) });
        if (epoch !== generation) return;
        var confirmation = await deps.confirm(response, serverInfo.environment.runtime.pathStyle, identity.serverId, config.url, serverInfo.serverName);
        if (epoch !== generation) return;
        config = confirmation.connection;
        if (confirmation.resync || response.acceptedRevision !== config.grantRevision) {
          // Queue the new complete snapshot after the current configure has settled.
          Promise.resolve().then(synchronize).catch(failConnection); return;
        }
        Object.keys(observations.disks).forEach(function (id) {
          var observed = observations.disks[id], workspace = response.workspaces.find(function (item) { return item.id === id; });
          if (!workspace || workspace.state !== 'ready' || !Object.values(workspace.effectivePermissions).some(Boolean) || observed.resolvedPath !== workspace.resolvedPath || observed.grantRevision !== response.acceptedRevision) delete observations.disks[id];
        });
        acknowledged = response; reconnect = config.enabled; transition('ready'); retryCount = 0; settleWaiters();
      });
      work = work.catch(function (error) { if (epoch === generation) throw error; });
      configureQueue = work.catch(function () {}); return work;
    }
    function connectionClosed(current, detail) {
      if (!current || current !== socket) return;
      generation++;
      socket = null; identity = null; cipher = null; acknowledged = null;
      clearInterval(heartbeatTimer); clearTimeout(handshakeTimer); clearTimeout(retryTimer);
      pending.forEach(function (_, id) { finish(id, unknown('连接中断，执行结果未知；请勿自动重试')); });
      inbound.forEach(function (controller) { controller.abort('连接断开'); }); inbound.clear(); seen.clear();
      if (detail === 'CREDENTIAL_REVOKED') { reconnect = false; transition('revoked', detail); }
      else if (!['auth-failed', 'pairing-required', 'identity-conflict', 'incompatible', 'revoked'].includes(state)) transition('disconnected', detail || 'NETWORK_DISCONNECTED');
      if (reconnect && config.enabled) {
        if (retryCount < retryLimit) retryTimer = setTimeout(function () { connect(); }, Math.min(30000, 1000 * Math.pow(2, retryCount++)));
        else { reconnect = false; transition('disconnected', 'RETRY_LIMIT_REACHED'); }
      }
      settleWaiters(new Error(reason || '连接断开'));
    }
    function failConnection(error) {
      var current = socket;
      var transient = ['AUTH_TIMEOUT', 'HELLO_TIMEOUT', 'CONFIGURE_TIMEOUT'].includes(error.reason)
        || identity && ['TEMPORARILY_UNAVAILABLE', 'RESOURCE_BUSY'].includes(error.code);
      if (!transient) {
        reconnect = false;
        transition(error.reason === 'SERVER_ID_CHANGED' || error.reason === 'SERVER_ALREADY_CONFIGURED' ? 'identity-conflict'
          : error.reason === 'PROTOCOL_INCOMPATIBLE' ? 'incompatible' : error.reason === 'CREDENTIAL_REVOKED' ? 'revoked'
            : ['INVALID_CREDENTIAL', 'INVALID_COMMUNICATION_KEY'].includes(error.reason) ? 'pairing-required' : 'auth-failed', error.reason || 'CONFIGURATION_FAILED');
      }
      settleWaiters(error);
      // Retire this generation immediately so a late hello/configured response
      // cannot make a timed-out connection ready while close is in progress.
      if (current) { connectionClosed(current, transient ? error.reason || 'NETWORK_DISCONNECTED' : null); current.close(); }
    }
    function update(next, info) {
      var previous = config; config = next; clientInfo = info || clientInfo;
      var previousPermissions = c.arpPermissions(previous.arpPermissions), nextPermissions = c.arpPermissions(next.arpPermissions);
      if (Object.keys(previousPermissions).some(function (key) { return previousPermissions[key] && !nextPermissions[key]; })) {
        inbound.forEach(function (controller) {
          controller.abort(Object.assign(new Error('连接的远程操作权限已收紧'), {
            code: 'FORBIDDEN', reason: 'CONNECTION_PERMISSION_REVOKED', performed: 'unknown', retryable: false,
          }));
        });
      }
      if (next.runTabMode !== previous.runTabMode && deps.onResetTargets) deps.onResetTargets();
      pending.forEach(function (entry, id) {
        if (!['local.call', 'environment.get'].includes(entry.type)) return;
        var body = entry.body, workspace = next.workspaces.find(function (item) { return item.id === body.workspaceId; });
        var old = previous.workspaces.find(function (item) { return item.id === body.workspaceId; });
        var permission = c.DIRECTORY_OPERATIONS[body.operation];
        if (!next.enabled || (root.LocalResource.OPERATIONS[body.operation] && root.LocalResource.OPERATIONS[body.operation].desktop && !next.desktopEnabled)
          || body.workspaceId && (!workspace || !old || workspace.path !== old.path || permission && !workspace.permissions[permission]
            || entry.type === 'environment.get' && !Object.values(workspace.permissions).some(Boolean))) cancel(id, 'grant_revoked');
      });
      if (!next.enabled) { disconnect('disabled', 'grant_revoked'); return; }
      if (next.url !== previous.url) { disconnect(); connect(); return; }
      if (identity && serverInfo && next.grantRevision !== previous.grantRevision) { transition('configuring'); synchronize().catch(failConnection); }
      if (identity && info) hello();
    }
    async function handleInbound(message, current, epoch) {
      var controller;
      try {
        if (state !== 'ready') c.fail('CONNECTION_NOT_READY', '连接正在同步配置，尚未执行请求', 'TEMPORARILY_UNAVAILABLE');
        if (seen.has(message.requestId)) throw Object.assign(new Error('重复请求，原执行结果不可推断'), {
          code: 'RESOURCE_CONFLICT', reason: 'DUPLICATE_REQUEST', performed: 'unknown' });
        if (seen.size >= c.LIMITS.seenRequests) c.fail('SESSION_REQUEST_LIMIT', '此会话的请求容量已满', 'RESOURCE_BUSY');
        seen.add(message.requestId); controller = new AbortController(); inbound.set(message.requestId, controller);
        var context = await deps.createTrustedContext(message.context, { method: message.method, request: message.request,
          connectionId: config.id, connection: config, principal: message.principal, identity: identity, abortSignal: controller.signal });
        if (controller.signal.aborted) c.fail('REQUEST_CANCELLED', '请求已取消，尚未执行', 'UPSTREAM_FAILED');
        var envelope = await deps.dispatchResource(message.method, message.request, context);
        if (epoch === generation && current === socket) send({ type: 'arp.result', requestId: message.requestId, envelope: envelope }, current);
      } catch (error) {
        if (epoch === generation && current === socket) send({ type: 'arp.result', requestId: message.requestId,
          envelope: deps.arp.createErrorResponse(crypto.randomUUID(), deps.arp.arpError(error.code || 'UPSTREAM_FAILED', error.message,
            { performed: error.performed || 'unknown', retryable: false, details: { reason: error.reason } })) }, current);
      } finally { if (controller && inbound.get(message.requestId) === controller) inbound.delete(message.requestId); }
    }
    async function message(value, current, epoch, passwordHolder) {
      if (epoch !== generation || current !== socket) return;
      if (!identity) {
        c.authFrame(value);
        if (value.type === 'auth.required') {
          if (authStarted) c.fail('DUPLICATE_AUTH'); authStarted = true;
          transition('authenticating'); var credential = await deps.getCredential();
          if (passwordHolder.value !== undefined) await deps.validatePairing(value.serverId);
          if (epoch !== generation || current !== socket) return;
          authRequestId = crypto.randomUUID();
          var payload = { transportProtocol: c.TRANSPORT, authProtocol: c.AUTH, requestId: authRequestId,
            pairingVersion: c.PAIRING,
            clientId: clientInfo.clientId, clientInfo: clientInfo,
            expectedServerId: passwordHolder.value !== undefined ? value.serverId : config.expectedServerId };
          if (passwordHolder.value !== undefined) { payload.type = 'auth.pair'; payload.password = passwordHolder.value; passwordHolder.value = undefined; }
          else if (credential && credential.clientId === clientInfo.clientId && credential.serverId === config.expectedServerId) {
            if (credential.pairingVersion === undefined && credential.communicationKey === undefined) {
              var key = btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(32))))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
              credential = Object.assign({}, credential, { pairingVersion: c.PAIRING, communicationKey: key, communicationKeyPending: true });
              // Persist before sending so interrupted upgrades retry the same key.
              await deps.saveCredential(credential);
              if (epoch !== generation || current !== socket) return;
            }
            if (credential.pairingVersion !== c.PAIRING) c.fail('PROTOCOL_INCOMPATIBLE');
            c.communicationKey(credential.communicationKey); passwordHolder.credential = credential;
            Object.assign(payload, { type: 'auth.resume', pairingId: credential.pairingId, token: credential.token });
            if (credential.communicationKeyPending) payload.communicationKey = credential.communicationKey;
          } else { reconnect = false; transition('pairing-required', 'PAIRING_REQUIRED'); settleWaiters(new Error('需要配对')); current.close(); return; }
          current.send(JSON.stringify(payload)); delete payload.password; delete payload.token; delete payload.communicationKey; return;
        }
        if (value.type === 'auth.error') {
          reconnect = false; transition(value.reason === 'CREDENTIAL_REVOKED' ? 'revoked' : value.reason === 'SERVER_ID_CHANGED' ? 'identity-conflict'
            : value.reason === 'PROTOCOL_INCOMPATIBLE' ? 'incompatible'
              : value.reason === 'AUTH_FAILED' && passwordHolder.credential ? 'pairing-required' : 'auth-failed', value.reason);
          settleWaiters(Object.assign(new Error(value.reason), { code: value.code, reason: value.reason })); current.close(); return;
        }
        if (value.type !== 'auth.ok' || value.requestId !== authRequestId || value.clientId !== clientInfo.clientId) c.fail('IDENTITY_MISMATCH');
        c.id(value.serverId); c.id(value.transportSessionId); c.id(value.pairingId);
        var resumed = passwordHolder.credential;
        if (resumed ? value.token !== undefined || value.pairingId !== resumed.pairingId : !value.token) c.fail('INVALID_CREDENTIAL');
        var nextCipher;
        try {
          nextCipher = await root.WebSocketEncryption.create(value.communicationKey || resumed && resumed.communicationKey, value, true);
          if (epoch !== generation || current !== socket) return;
          config = await deps.bind(value);
          if (epoch !== generation || current !== socket) return;
          if (value.token || resumed && resumed.communicationKeyPending) await deps.saveCredential({ serverId: value.serverId, clientId: value.clientId,
            pairingId: value.pairingId, token: value.token || resumed.token,
            pairingVersion: c.PAIRING, communicationKey: value.communicationKey || resumed.communicationKey });
        } finally { delete value.token; delete value.communicationKey; passwordHolder.credential = null; }
        if (epoch !== generation || current !== socket) return;
        // Pairing while disabled only saves credentials; the switch controls the live session.
        if (!config.enabled) { settleWaiters(); disconnect('disabled', 'grant_revoked'); return; }
        cipher = nextCipher;
        identity = { serverId: value.serverId, clientId: value.clientId, transportSessionId: value.transportSessionId };
        // Pairing credentials have been saved; recovery can now resume with
        // those credentials without retaining or replaying the password.
        reconnect = config.enabled;
        clearTimeout(handshakeTimer); transition('configuring');
        // Pairing succeeds once the new credentials are saved; connection setup has its own status.
        if (!resumed) settleWaiters();
        hello();
        handshakeTimer = setTimeout(function () { failConnection(Object.assign(new Error('能力握手超时'), { reason: 'HELLO_TIMEOUT' })); }, c.LIMITS.configureTimeoutMs);
        heartbeatTimer = setInterval(function () { if (identity) try { send({ type: 'heartbeat', sentAt: Date.now() }); } catch (_) {} }, 20000);
        return;
      }
      c.frame(value, identity);
      if (value.type === 'hello') {
        if (value.requestId !== helloRequestId || !value.capabilities || value.capabilities.localProtocol !== c.LOCAL) c.fail('PROTOCOL_INCOMPATIBLE');
        helloPending = false;
        clearTimeout(handshakeTimer); var first = !serverInfo; serverInfo = value;
        if (helloInfo !== JSON.stringify(clientInfo)) hello();
        if (first) await synchronize(); else if (deps.onChange) deps.onChange(); return;
      }
      if (value.type === 'server.status') {
        if (serverInfo) serverInfo.capabilities.audit.available = value.audit.available;
        if (serverInfo && value.environmentRevision > serverInfo.environment.revision) {
          serverInfo.environment = Object.assign({}, serverInfo.environment, { stale: true, reason: 'ENVIRONMENT_CHANGED' });
          hello();
        }
        if (deps.onChange) deps.onChange(); return;
      }
      if (value.type === 'arp.cancel') { var controller = inbound.get(value.requestId); if (controller) controller.abort('远端入口已取消'); return; }
      if (value.type === 'arp.request') { handleInbound(value, current, epoch).catch(failConnection); return; }
      if (value.type === 'local.cancel.ack') {
        var cancelled = pending.get(value.requestId);
        if (cancelled && deps.onExecutionState) deps.onExecutionState({ connectionId: config.id, requestId: value.requestId, state: 'stopping', cancelStatus: value.status,
          conversationId: cancelled.body.caller && cancelled.body.caller.conversationId });
        return;
      }
      var entry = pending.get(value.requestId);
      if (!entry || entry.socket !== current) return;
      var expectedType = { 'arp.call': 'arp.response', 'local.call': 'local.result', 'local.configure': 'local.configured', 'environment.get': 'environment.result', 'mail.send': 'mail.result' }[entry.type];
      if (value.type !== expectedType) c.fail('RESPONSE_TYPE_MISMATCH');
      if (entry.type === 'arp.call') { finish(value.requestId, null, value.envelope); return; }
      if (value.type === 'local.result' && (value.operation !== entry.body.operation || value.grantRevision !== entry.body.grantRevision
          || (value.workspaceId || null) !== (entry.body.workspaceId || null) || (value.workingDirectory || null) !== (entry.body.workingDirectory || null))) c.fail('RESPONSE_TARGET_MISMATCH');
      if (value.ok === true) {
        if (entry.type === 'local.configure') finish(value.requestId, null, value);
        else if (entry.type === 'environment.get') {
          if (value.scope !== entry.body.scope) c.fail('RESPONSE_TARGET_MISMATCH');
          if (value.scope === 'workspace' && (!value.data.disk || value.data.disk.workspaceId !== entry.body.workspaceId || value.data.disk.resolvedPath !== entry.body.workingDirectory || value.data.disk.grantRevision !== entry.body.grantRevision)) c.fail('RESPONSE_TARGET_MISMATCH');
          if (value.data.environment && serverInfo) serverInfo.environment = value.data.environment;
          if (value.data.memory) observations.memory = value.data.memory;
          if (value.data.disk) observations.disks[entry.body.workspaceId] = value.data.disk;
          finish(value.requestId, null, Object.assign({}, value.data, { audit: value.audit }));
        }
        else finish(value.requestId, null, Object.assign({}, value.result, { execution: value.execution, receipt: value.receipt, audit: value.audit,
          target: { connectionId: config.id, serverId: identity.serverId, workspaceId: value.workspaceId || null, resolvedPath: value.workingDirectory || null,
            alias: config.alias, workspaceAlias: (config.workspaces.find(function (entry) { return entry.id === value.workspaceId; }) || {}).alias || null },
          transportSessionId: identity.transportSessionId, requestId: value.requestId }));
      } else {
        var error = Object.assign(new Error(value.error && value.error.message || '操作失败'), value.error || {}, {
          performed: value.receipt && value.receipt.performed || (entry.type === 'mail.send' ? 'unknown' : 'no'), receipt: value.receipt, execution: value.execution, result: value.result, audit: value.audit });
        finish(value.requestId, error);
        if (['WORKSPACE_CHANGED', 'GRANT_REVISION_CHANGED'].includes(error.reason)) { transition('configuring'); synchronize().catch(failConnection); }
      }
    }
    async function connect(password) {
      if (!config.enabled && password === undefined) { disconnect('disabled', 'grant_revoked'); return; }
      if (socket) return;
      clearTimeout(retryTimer);
      reconnect = password === undefined; var epoch = ++generation;
      try {
        c.url(config.url);
        var credential = password === undefined ? await deps.getCredential() : null;
        if (epoch !== generation) return;
        if (password === undefined && (!credential || credential.clientId !== clientInfo.clientId || credential.serverId !== config.expectedServerId)) {
          reconnect = false; transition('pairing-required', 'PAIRING_REQUIRED'); settleWaiters(new Error('需要配对')); return;
        }
        identity = null; cipher = null; sendQueue = Promise.resolve(); serverInfo = null; acknowledged = null; observations = { memory: null, disks: {} }; authStarted = false; helloPending = false; authRequestId = null; helloRequestId = null;
        transition('connecting'); var current = new WebSocket(config.url); socket = current;
        var passwordHolder = { value: password, credential: null }, receiveQueue = Promise.resolve(); password = undefined;
        handshakeTimer = setTimeout(function () {
          if (epoch === generation && current === socket) failConnection(Object.assign(new Error('认证握手超时'), { reason: 'AUTH_TIMEOUT' }));
        }, c.LIMITS.authTimeoutMs);
        current.onopen = function () { if (epoch === generation) transition('authenticating'); };
        current.onmessage = function (event) {
          receiveQueue = receiveQueue.then(async function () {
            if (epoch !== generation || current !== socket) return;
            var authenticating = !identity;
            if (typeof event.data !== 'string' || event.data.length > (authenticating ? c.LIMITS.authBytes : root.WebSocketEncryption.MAX_FRAME_BYTES)) c.fail('INVALID_FRAME');
            var value = JSON.parse(event.data);
            if (!authenticating) value = JSON.parse(await cipher.decrypt(value));
            var work = message(value, current, epoch, passwordHolder);
            // A hello handler waits for a later configuration reply; do not block message delivery on it.
            if (authenticating) await work;
            else work.catch(function (error) { if (epoch === generation && current === socket) failConnection(error); });
          }).catch(function (error) {
            if (epoch !== generation || current !== socket) return;
            failConnection(error);
          });
        };
        current.onclose = function (event) {
          passwordHolder.value = undefined; passwordHolder.credential = null; connectionClosed(current, event.reason === 'CREDENTIAL_REVOKED' ? event.reason : null);
        };
        current.onerror = function () { log('error', 'WebSocket 连接失败'); };
      } catch (error) { if (epoch === generation) failConnection(error); }
    }
    function disconnect(nextState, stopReason) {
      reconnect = false; generation++; clearTimeout(retryTimer); clearTimeout(handshakeTimer); clearInterval(heartbeatTimer);
      if (deps.onResetTargets) deps.onResetTargets();
      pending.forEach(function (_, id) { cancel(id, stopReason || 'user'); finish(id, unknown('连接已关闭，执行结果可能未知')); });
      inbound.forEach(function (controller) { controller.abort('连接关闭'); }); inbound.clear(); seen.clear();
      var old = socket; socket = null; if (old) old.close(); identity = null; cipher = null; acknowledged = null; serverInfo = null;
      transition(nextState || 'disconnected'); settleWaiters(new Error('连接已关闭'));
    }
    function connectAttempt(options) {
      options = options || {}; if (state === 'ready') return Promise.resolve(status());
      if (!socket) retryCount = 0;
      return new Promise(function (resolve, reject) {
        var waiter = { resolve: resolve, reject: reject, timer: null };
        waiter.timer = setTimeout(function () { waiters = waiters.filter(function (item) { return item !== waiter; }); reject(new Error('连接尝试超时')); }, options.timeoutMs || 30000);
        waiters.push(waiter); connect(options.password);
      });
    }
    return { connect: connect, connectAttempt: connectAttempt, disconnect: disconnect, update: update, getStatus: status,
      isConnected: function () { return state === 'ready'; }, clearLogs: function () { logs = []; },
      callLocal: function (operation, input, options) { return request('local.call', Object.assign({ operation: operation, input: input }, options.frame), options); },
      getEnvironment: function (body, options) { return request('environment.get', body, options); },
      callArp: function (method, input, options) { return request('arp.call', { method: method, request: input, caller: options.caller }, options); },
      sendMail: function (payload, options) { return request('mail.send', { payload: payload, caller: options.caller }, options); } };
  }
  root.WebSocketClient = Object.freeze({ createWebSocketClient: createWebSocketClient });
})(globalThis);
