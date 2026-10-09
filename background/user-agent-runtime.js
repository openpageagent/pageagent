// MV3 network rules scoped to requests originating from this extension.
(function (root) {
  'use strict';

  var LEGACY_PAGE_RULE_ID = 870001;
  var SYSTEM_RULE_ID = 870002;
  var FETCH_RULE_ID = 870003;
  var RESOURCE_TYPES = ['stylesheet', 'script', 'image', 'font', 'object',
    'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];

  function create(chromeApi) {
    var settingsApi = root.PageAutomationSystemSettings;
    var profileApi = root.UserAgentProfile;
    var rulesApi = chromeApi.declarativeNetRequest;
    var queue = Promise.resolve();
    var appliedUserAgent = null;
    var pending = [];
    var active = 0;
    var activeUserAgent = null;
    var switching = false;
    var gate = null;
    var scope = chromeApi.extension && chromeApi.extension.inIncognitoContext ? 'incognito' : 'regular';
    var peer = scope === 'regular' ? 'incognito' : 'regular';
    var gateKey = 'ua_network_gate_' + scope;
    var peerKey = 'ua_network_gate_' + peer;
    var turnKey = 'ua_network_gate_turn';

    function enqueue(operation) {
      var result = queue.then(operation, operation);
      queue = result.catch(function () {});
      return result;
    }

    async function apply(settings, force) {
      var ua = settings.userAgent;
      if (!force && ua === appliedUserAgent) return;
      // Dynamic rules survive extension reloads. Remove the former page-wide
      // rule before validating/applying the narrower configuration.
      await rulesApi.updateDynamicRules({ removeRuleIds: [LEGACY_PAGE_RULE_ID] });
      // Only clean up an older registration if its API is still available.
      // This version neither requests userScripts permission nor registers scripts.
      if (chromeApi.userScripts) {
        try {
          var scripts = await chromeApi.userScripts.getScripts({ ids: ['page-agent-user-agent'] });
          if (scripts.length) await chromeApi.userScripts.unregister({ ids: ['page-agent-user-agent'] });
        } catch (error) { console.warn('[User-Agent] 清理旧页面脚本失败，请重新加载扩展并刷新网页:', error); }
      }
      var profile = ua ? profileApi.create(ua) : null;
      var changes = profile ? profileApi.headerChanges(profile) : [];
      var rules = [];
      if (profile) {
        // Downloads and WebSocket handshakes cannot go through the fetch adapter.
        // Model transports use fetch (xmlhttprequest), so they are excluded here.
        rules.push({
          id: SYSTEM_RULE_ID, priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: changes },
          condition: {
            urlFilter: '*', initiatorDomains: [chromeApi.runtime.id],
            resourceTypes: RESOURCE_TYPES,
          },
        });
      }
      await rulesApi.updateDynamicRules({ removeRuleIds: [SYSTEM_RULE_ID], addRules: rules });
      appliedUserAgent = ua;
    }

    function sync() {
      return enqueue(async function () {
        var settings = await settingsApi.load(chromeApi.storage.local, chromeApi.runtime);
        await apply(settings);
        return settings;
      });
    }

    function save(value) {
      return enqueue(async function () {
        var previous = await settingsApi.load(chromeApi.storage.local, chromeApi.runtime);
        var next = settingsApi.normalize(value);
        try {
          await apply(next, true);
          return await settingsApi.save(chromeApi.storage.local, chromeApi.runtime, next);
        } catch (error) {
          try { await apply(previous, true); }
          catch (rollbackError) { console.error('[User-Agent] 恢复规则失败:', rollbackError); }
          throw error;
        }
      });
    }

    // Chrome shares DNR session rules across split incognito/regular workers.
    // Peterson's two-party gate uses shared storage so both workers participate.
    // A renewed lease prevents a terminated worker from leaving a permanent lock.
    async function acquireGate() {
      var controller = new AbortController();
      var heartbeat = Promise.resolve();
      var renew = function () {
        return chromeApi.storage.local.set({ [gateKey]: { expiresAt: Date.now() + 30000 } });
      };
      var timer;
      async function release() {
        clearInterval(timer);
        await heartbeat;
        await chromeApi.storage.local.remove(gateKey);
      }
      await chromeApi.storage.local.set({ [gateKey]: { expiresAt: Date.now() + 30000 }, [turnKey]: peer });
      timer = setInterval(function () {
        heartbeat = heartbeat.then(renew).catch(function (error) { controller.abort(error); });
      }, 5000);
      try {
        while (true) {
          if (!pending.length || controller.signal.aborted) throw controller.signal.reason || new DOMException('Request aborted', 'AbortError');
          var state = await chromeApi.storage.local.get([peerKey, turnKey]);
          if (!state[peerKey] || state[peerKey].expiresAt <= Date.now() || state[turnKey] !== peer) break;
          await new Promise(function (resolve) {
            var timeout;
            function wake() {
              clearTimeout(timeout);
              chromeApi.storage.onChanged.removeListener(changed);
              resolve();
            }
            function changed(changes, area) {
              if (area === 'local' && (changes[peerKey] || changes[turnKey])) wake();
            }
            chromeApi.storage.onChanged.addListener(changed);
            timeout = setTimeout(wake, 250);
          });
        }
        return { signal: controller.signal, release: release };
      } catch (error) { await release(); throw error; }
    }

    async function releaseGate() {
      switching = true;
      try {
        await rulesApi.updateSessionRules({ removeRuleIds: [FETCH_RULE_ID] });
      } catch (error) { console.error('[User-Agent] 清理请求规则失败:', error); }
      finally {
        if (gate) {
          try { await gate.release(); }
          catch (error) { console.error('[User-Agent] 释放请求调度失败:', error); }
        }
        gate = null;
        activeUserAgent = null;
        switching = false;
      }
      pump();
    }

    // DNR cannot match a request's headers or JavaScript caller. All extension
    // HTTP fetches share this adapter: equal identities can run concurrently;
    // changing identity waits for response headers (including all redirects).
    // Response bodies/streams remain concurrent after fetch resolves.
    async function pump() {
      if (switching || !pending.length) return;
      var ua = pending[0].userAgent;
      if (active && ua !== activeUserAgent) return;
      if (ua !== activeUserAgent) {
        switching = true;
        try {
          if (!gate) gate = await acquireGate();
          var rules = ua ? [{
            id: FETCH_RULE_ID, priority: 2,
            action: { type: 'modifyHeaders', requestHeaders: profileApi.headerChanges(profileApi.create(ua)) },
            condition: { urlFilter: '*', initiatorDomains: [chromeApi.runtime.id], resourceTypes: ['xmlhttprequest'] },
          }] : [];
          await rulesApi.updateSessionRules({ removeRuleIds: [FETCH_RULE_ID], addRules: rules });
          activeUserAgent = ua;
        } catch (error) {
          while (pending.length && pending[0].userAgent === ua) {
            var failed = pending.shift();
            failed.cleanup();
            failed.reject(error);
          }
          if (gate) releaseGate();
          else { switching = false; pump(); }
          return;
        }
        switching = false;
      }
      while (pending.length && pending[0].userAgent === activeUserAgent) {
        var request = pending.shift();
        request.cleanup();
        active += 1;
        dispatch(request);
      }
      if (!active) releaseGate();
    }

    function dispatch(request) {
      Promise.resolve().then(request.send).then(request.resolve, request.reject).finally(function () {
        active -= 1;
        if (!active) releaseGate();
        else pump();
      });
    }

    function requestWithIdentity(url, init, fetchImpl, ua) {
      return new Promise(function (resolve, reject) {
        var signal = init && init.signal;
        var request = {
          userAgent: ua, resolve: resolve, reject: reject,
          send: function () {
            var requestSignal = signal ? AbortSignal.any([signal, gate.signal]) : gate.signal;
            return fetchImpl(url, Object.assign({}, init, { signal: requestSignal }));
          },
          cleanup: function () { if (signal) signal.removeEventListener('abort', cancel); },
        };
        function cancel() {
          var index = pending.indexOf(request);
          if (index !== -1) pending.splice(index, 1);
          request.cleanup();
          reject(signal.reason || new DOMException('Request aborted', 'AbortError'));
          pump();
        }
        if (signal && signal.aborted) { cancel(); return; }
        if (signal) signal.addEventListener('abort', cancel, { once: true });
        pending.push(request);
        pump();
      });
    }

    function fetchModel(url, init, fetchImpl) {
      var ua = new Headers(init && init.headers || {}).get('User-Agent') || '';
      return requestWithIdentity(url, init, fetchImpl || root.fetch.bind(root), ua);
    }

    async function fetchSystem(url, init, fetchImpl) {
      var settings = await settingsApi.load(chromeApi.storage.local, chromeApi.runtime);
      var headers = settingsApi.withUserAgent(init && init.headers, settings);
      var ua = new Headers(headers).get('User-Agent') || '';
      return requestWithIdentity(url, Object.assign({}, init, { headers: headers }), fetchImpl || root.fetch.bind(root), ua);
    }

    chromeApi.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[settingsApi.SETTINGS_KEY]) return;
      sync().catch(function (error) { console.error('[User-Agent] 应用系统配置失败:', error); });
    });
    sync().catch(function (error) { console.error('[User-Agent] 初始化失败:', error); });
    return { sync: sync, save: save, fetchSystem: fetchSystem, fetchModel: fetchModel };
  }

  root.UserAgentRuntime = { create: create };
})(globalThis);
