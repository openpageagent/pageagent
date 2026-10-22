(function (root) {
  'use strict';
  var C = root.AppContract;
  function install(service, options) {
    var sessions = new Set(), budgets = new Map(), active = 0;
    function senderEntry(sender) {
      if (!sender || sender.id !== chrome.runtime.id || !sender.tab || !sender.documentId || sender.frameId !== 0 || !!sender.tab.incognito !== !!options.incognito) return null;
      var url = new URL(sender.url || 'about:blank');
      return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && !url.search ? C.parsePath(url.pathname) : null;
    }
    function send(session, value) { if (!session.closed) { try { session.port.postMessage(value); } catch (_) { close(session); } } }
    function close(session) {
      if (session.closed) return;
      session.closed = true; sessions.delete(session);
      session.utilityAbort.abort();
      var budget = budgets.get(session.appId);
      if (budget && !budget.active && !Array.from(sessions).some(function (item) { return item.appId === session.appId; })) budgets.delete(session.appId);
      session.port.onMessage.removeListener(session.receive);
      try { session.port.disconnect(); } catch (_) {}
    }
    // Browser tab removal also closes the session when pagehide cannot run.
    // Submitted Flow/Script Runs retain their own lifecycle.
    chrome.tabs.onRemoved.addListener(function (tabId) {
      sessions.forEach(function (session) { if (session.tabId === tabId) close(session); });
    });
    async function invoke(session, message) {
      if (session.closed) throw C.error('SESSION_CLOSED', '应用会话已关闭');
      if (message.version !== C.VERSION) throw C.error('PROTOCOL_MISMATCH', '应用 SDK 版本不兼容');
      if (message.type === 'APP_READY') {
        if (message.revision !== undefined && message.revision !== null && (typeof message.revision !== 'string' || message.revision.length > 100)) throw C.error('INVALID_REQUEST', '无效的应用修改标识');
        var state = await service.summary(session.appId), slot = state.slots[session.slot];
        if (!slot) throw C.error(session.slot === 'draft' ? 'DRAFT_NOT_FOUND' : 'NOT_PUBLISHED', session.slot === 'draft' ? '此应用尚无草稿，请在编辑器保存后预览' : '应用尚未发布，请打开草稿预览');
        if (!session.revision) session.revision = message.revision || slot.revision;
        return { type: 'APP_INIT', session: session.id, version: C.VERSION, revision: session.revision, state: state };
      }
      if (!session.revision || message.type !== 'APP_REQUEST' || message.session !== session.id || message.revision !== session.revision) throw C.error('SESSION_CLOSED', '应用会话失效，请重新加载此应用');
      var input = message.input || {}, operation = message.operation;
      if (operation === 'state') return service.summary(session.appId);
      if (operation === 'resources.request') {
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(input.method) || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)) throw C.error('INVALID_REQUEST', '无效的资源请求');
        var resourceAuth = { appId: session.appId, slot: session.slot, revision: session.revision, generation: message.generation };
        var scope = await service.authorizeResources(resourceAuth);
        if (session.closed) throw C.error('SESSION_CLOSED', '应用会话已关闭');
        var utilitySignal = /^\/utilities(?:\/|$)/.test(input.request.uri) ? session.utilityAbort.signal : undefined;
        return options.dispatchResource(input.method, input.request, resourceAuth, scope, utilitySignal);
      }
      if (operation === 'runs.status' || operation === 'runs.cancel') return service.ownedRun(session.appId, input.runId, operation === 'runs.cancel');
      if (operation === 'data.changed') {
        // This notification follows a committed, authorized data transaction.
        // A later grant change must not hide that commit from other pages.
        if (typeof input.key !== 'string' || !['set', 'delete'].includes(input.operation)) throw C.error('INVALID_REQUEST', '无效的数据变化通知');
        if (session.slot === 'published') sessions.forEach(function (target) {
          if (target.appId === session.appId && target.slot === 'published') send(target, { type: 'APP_EVENT', session: target.id, event: { change: 'data', key: input.key } });
        });
        return { notified: true };
      }
      var permission = operation === 'actions.run' ? 'action:' + input.name : operation === 'data.get' || operation === 'data.list' ? 'data.read' : operation === 'data.set' ? 'data.write' : operation === 'data.delete' ? 'data.delete' : null;
      if (!permission) throw C.error('UNSUPPORTED_CAPABILITY', 'SDK 未提供该操作');
      var auth = { appId: session.appId, slot: session.slot, revision: session.revision, generation: message.generation, permission: permission };
      await service.authorize(auth);
      if (session.closed) throw C.error('SESSION_CLOSED', '应用会话已关闭');
      if (operation === 'actions.run') return options.dispatchAction(session.appId, input.name, input.input, auth, input.idempotencyKey || message.id);
      operation = operation.slice(5);
      // The fixed data worker performs the transaction in this application
      // instance and rechecks the persisted grant inside that transaction.
      return { authorization: auth };
    }
    chrome.runtime.onConnect.addListener(function (port) {
      if (port.name !== C.PORT) return;
      var entry = senderEntry(port.sender);
      if (!entry) { port.disconnect(); return; }
      var session = Object.assign(entry, { id: C.revision(), tabId: port.sender.tab.id, port: port, closed: false, revision: null, pending: new Set(), overloads: 0 });
      session.utilityAbort = new AbortController();
      sessions.add(session);
      // Resolve the browser-provided address once; every SDK operation stays bound to this ID.
      var resolved = entry.appId ? Promise.resolve(entry.appId) : service.store.findBySlug(entry.slug).then(function (meta) {
        session.appId = service.store.required(meta).appId;
        return session.appId;
      });
      resolved.catch(function () {});
      session.receive = async function (message) {
        if (session.closed) return;
        var id = message && message.id;
        function fail(error) { send(session, { type: 'APP_RESULT', id: id, session: session.id, error: { code: error.code || 'APP_ERROR', message: error.message || String(error) } }); }
        if (!message || typeof id !== 'string' || id.length > 100 || session.pending.has(id)) { fail(C.error('INVALID_REQUEST', '无效或重复请求 ID')); return; }
        session.pending.add(id);
        try { await resolved; } catch (error) { session.pending.delete(id); fail(error); return; }
        if (session.closed) return;
        var budget = budgets.get(session.appId) || { time: Date.now(), count: 0, active: 0 };
        if (Date.now() - budget.time >= 1000) { budget.time = Date.now(); budget.count = 0; }
        budgets.set(session.appId, budget);
        if (JSON.stringify(message).length * 2 > C.limits.messageBytes || budget.count++ >= C.limits.requestsPerSecond || budget.active >= C.limits.inFlight || active >= 32) {
          fail(C.error('RESOURCE_BUSY', '应用 SDK 消息过大或请求过于密集，请分批处理'));
          session.pending.delete(id);
          if (++session.overloads >= 5) close(session);
          return;
        }
        budget.active++; active++;
        Promise.resolve().then(function () { return invoke(session, message); }).then(function (result) {
          if (JSON.stringify(result).length * 2 > C.limits.messageBytes) {
            var runStatus = message.operation === 'runs.status' ? result : message.operation === 'resources.request' && result.primary && result.primary.type === 'AppRunStatus' ? result.primary.data : null;
            if (runStatus) {
              delete runStatus.output;
              runStatus.outputRef = { uri: runStatus.uri, message: '结果超过 SDK 控制消息大小，请在运行记录中查看或导出已保留的结果；运行记录仍受自身容量与截断规则限制' };
            } else throw C.error('RESOURCE_BUSY', '结果过大，请缩小分页或按键分批读取');
          }
          send(session, { type: 'APP_RESULT', id: id, session: session.id, result: result });
        }).catch(fail).finally(function () {
          budget.active--; active--; session.pending.delete(id);
          if (!budget.active && !Array.from(sessions).some(function (item) { return item.appId === session.appId; })) budgets.delete(session.appId);
        });
      };
      port.onMessage.addListener(session.receive);
      port.onDisconnect.addListener(function () { close(session); });
    });
    return {
      tabIds: function (appId, slot) { return Array.from(sessions).filter(function (session) { return session.appId && (appId === undefined || session.appId === appId) && (!slot || session.slot === slot); }).map(function (session) { return session.tabId; }); },
      runEvent: function (event) {
        if (event.type === 'RUN_HISTORY_UPDATED') {
          service.sweepRuns().then(function (finished) { finished.forEach(function (run) {
            sessions.forEach(function (session) { if (session.appId === run.appId) send(session, { type: 'APP_EVENT', session: session.id, event: { change: 'run', runId: run.runId, kind: 'completed' } }); });
          }); }).catch(function (error) { console.error('Application run cleanup failed', error); });
        }
        var runId = event.runId || event.payload && event.payload.runId, owner = runId && service.runOwner(runId);
        if (!owner) return;
        sessions.forEach(function (session) { if (session.appId === owner.appId) send(session, { type: 'APP_EVENT', session: session.id, event: { change: 'run', runId: runId, kind: event.type } }); });
      },
      changed: function (event) {
        sessions.forEach(function (session) {
          // The first handshake may trigger built-in installation. It reads the committed
          // state afterwards, so installation must not disconnect an uninitialized session.
          if (session.appId !== event.appId || !session.revision) return;
          if (['permissions', 'saved', 'published', 'deleted', 'imported'].includes(event.change)) {
            session.utilityAbort.abort();
            session.utilityAbort = new AbortController();
          }
          if (event.change === 'data' && session.slot !== 'published') return;
          send(session, { type: 'APP_EVENT', session: session.id, event: event });
          if (event.change === 'deleted' || event.change === 'imported') close(session);
        });
      }
    };
  }
  root.AppBridge = Object.freeze({ install: install });
})(globalThis);
