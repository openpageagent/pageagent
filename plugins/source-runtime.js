// Editable plugin modules use the existing sandbox; Cordis owns the host effects.
(function (root) {
  'use strict';
  async function session(bridge, files, settings, inspect) {
    var controller = new AbortController(), callbacks = new Map(), calls = new Map(), timers = new Set(), disposers = [], registrations = [];
    var nextCallback = 0, stopped = false, rejectFailure;
    var failure = new Promise(function (_, reject) { rejectFailure = reject; });
    // A module can fail before the event loop starts awaiting this promise.
    failure.catch(function () {});
    function fail(error) { if (!stopped) rejectFailure(error instanceof Error ? error : new Error(String(error))); }
    async function remote(operation, input) {
      controller.signal.throwIfAborted();
      var result = await bridge.ctx.get(operation, input);
      if (result.error) throw Object.assign(new Error(result.error.message), result.error);
      return result.value;
    }
    function background(promise) { promise.catch(fail); return promise; }
    function register(kind, value, callback) {
      var id = String(++nextCallback);
      if (callback) callbacks.set(id, callback);
      registrations.push(background(remote('register', { id: id, kind: kind, value: value })));
      return function () { callbacks.delete(id); background(remote('unregister', { id: id })); };
    }
    function capability(value) {
      if (!value || typeof value.execute !== 'function') throw new Error('能力必须提供 execute 函数');
      var data = Object.assign({}, value); delete data.execute;
      return register('capability', data, value.execute);
    }
    function timeout(callback, delay) {
      var args = Array.prototype.slice.call(arguments, 2);
      var timer = setTimeout(function () {
        timers.delete(timer);
        if (!controller.signal.aborted) background(Promise.resolve().then(function () { return callback.apply(null, args); }));
      }, delay);
      timers.add(timer); return timer;
    }
    function clear(timer) { timers.delete(timer); clearTimeout(timer); }
    function interval(callback, delay) {
      var args = Array.prototype.slice.call(arguments, 2);
      var timer = setInterval(function () {
        if (!controller.signal.aborted) background(Promise.resolve().then(function () { return callback.apply(null, args); }));
      }, delay);
      timers.add(timer); return timer;
    }
    var service = {
      signal: controller.signal,
      registerCapability: capability,
      registerNode: function (value) { return capability(Object.assign({}, value, { node: true })); },
      registerUtility: function (value) { return capability(Object.assign({}, value, { utility: true, safety: 'read' })); },
      registerApp: function (value) { return register('app', value); },
      arp: function (method, request) { return remote('arp', { method: method, request: request }); },
      serverArp: function (connectionId, method, request) { return remote('serverArp', { connectionId: connectionId, method: method, request: request }); },
      conversation: function (command, input) { return remote('conversation', { command: command, input: input }); },
      events: {
        on: function (name, listener) { return register('event', name, listener); },
        emit: function (name, data) { return background(remote('emit', { name: name, data: data })); },
      },
    };
    var context = {
      pageAgent: service,
      on: function (name, listener) {
        if (name !== 'dispose') throw new Error('请通过 ctx.pageAgent.events 订阅宿主事件');
        disposers.push(listener); return function () { disposers = disposers.filter(function (value) { return value !== listener; }); };
      },
      effect: function (install) { var dispose = install(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    };
    var environment = {
      AgentResourceProtocol: {
        arpError: function (code, message, details) { return Object.assign(new Error(message), details || {}, { code: code }); },
        sha256: function (value) { return remote('hash', value); },
      },
      ProviderMessageNormalizer: globalThis.ProviderMessageNormalizer,
    };
    var chromeApi = { extension: { inIncognitoContext: settings.incognito }, storage: { local: {
      get: function (key) { return remote('storageGet', key); },
      set: function (value) { return remote('storageSet', value); },
    } } };
    var modules = new Map(), compiled = new Map();
    function load(name) {
      if (!Object.prototype.hasOwnProperty.call(files, name)) throw new Error('源码文件不存在：' + name);
      if (modules.has(name)) return modules.get(name).exports;
      var module = { exports: {} }; modules.set(name, module);
      try {
        if (name.endsWith('.json')) module.exports = JSON.parse(files[name]);
        else compiled.get(name)(module, module.exports, function (path) {
          if (typeof path !== 'string' || !/^\.\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(js|json)$/.test(path) || path.includes('..')) throw new Error('只能引用插件内的 ./文件名.js 或 ./文件名.json');
          return load(path.slice(2));
        }, environment, chromeApi, timeout, clear, interval, clear);
      } catch (error) { modules.delete(name); throw error; }
      return module.exports;
    }
    try {
      Object.keys(files).forEach(function (name) {
        try {
          if (name.endsWith('.json')) JSON.parse(files[name]);
          else compiled.set(name, new Function('module', 'exports', 'require', 'globalThis', 'chrome', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', '"use strict";\n' + files[name]));
        } catch (error) { throw new Error(name + '：' + error.message); }
      });
      var exported = load(settings.entry), plugin = exported && (exported.plugin || exported);
      if (!plugin || typeof plugin.apply !== 'function') throw new Error('插件源码须通过 module.exports 导出含 apply(ctx, config) 的对象');
      if (inspect) return { configSchema: exported.configSchema || settings.configSchema || { type: 'object' } };
      await plugin.apply(context, settings.config, settings.id);
      await Promise.all(registrations);
      await remote('ready');
      async function receive() {
        while (!controller.signal.aborted) {
          var message = await remote('next');
          if (!message) continue;
          if (message.cancel) {
            var pending = calls.get(message.id); if (pending) pending.abort(new Error('调用已取消'));
            continue;
          }
          var abort = new AbortController(); calls.set(message.id, abort);
          (function (request, signal) {
            var callback = callbacks.get(request.callback);
            var call = request.call ? {
              idempotencyKey: request.call.idempotencyKey, signal: signal,
              arp: function (method, input) { signal.throwIfAborted(); return remote('arp', { callId: request.id, method: method, request: input }); },
              serverArp: function (connectionId, method, input) { signal.throwIfAborted(); return remote('serverArp', { callId: request.id, connectionId: connectionId, method: method, request: input }); },
            } : undefined;
            background(Promise.resolve().then(function () { return callback && callback(request.input, call); }).then(function (value) {
              return remote('settle', { id: request.id, value: value });
            }, async function (error) {
              await remote('settle', { id: request.id, error: { message: error.message || String(error), code: error.code } });
            }).finally(function () { calls.delete(request.id); }));
          })(message, abort.signal);
        }
      }
      await Promise.race([receive(), failure]);
    } finally {
      stopped = true; controller.abort(new Error('插件已停止'));
      calls.forEach(function (call) { call.abort(controller.signal.reason); });
      timers.forEach(clearTimeout);
      disposers.reverse().forEach(function (dispose) { try { dispose(); } catch (_) {} });
    }
  }
  function script(definition, options, inspect) {
    return 'return (' + session.toString() + ')(api, ' + JSON.stringify(definition.files) + ', ' + JSON.stringify({
      id: definition.id, entry: definition.entry, config: definition.config, configSchema: definition.configSchema, incognito: !!options.incognito,
    }) + ', ' + !!inspect + ');';
  }
  async function inspect(definition, options, signal) {
    return options.runScript(script(definition, options, true), { signal: signal, timeoutMs: 5000,
      apiCall: function () { throw new Error('插件顶层只能声明模块，宿主操作请放在 apply 中'); } });
  }
  function start(definition, ctx, options) {
    var api = ctx.pageAgent, signal = api.signal, effects = new Map(), pending = new Map(), messages = [], waiting = null, sequence = 0;
    var readyResolve, readyReject, finished = false;
    var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
    var startup = setTimeout(function () { stop(new Error('插件启动超时')); }, 10000);
    var dataKey = 'page_agent_plugin_data_' + (options.incognito ? 'incognito_' : 'regular_') + definition.id;
    var storage = Promise.resolve();
    function stop(error) {
      if (finished) return;
      finished = true; clearTimeout(startup); readyReject(error);
      if (waiting) { waiting(null); waiting = null; }
      pending.forEach(function (call) { call.reject(error); }); pending.clear();
      if (!signal.aborted) options.onError(definition.id, error, signal);
    }
    signal.addEventListener('abort', function () { stop(signal.reason); }, { once: true });
    function send(message) {
      signal.throwIfAborted();
      if (waiting) { var resolve = waiting; waiting = null; resolve(message); }
      else {
        if (messages.length >= 128) throw new Error('插件待处理事件过多');
        messages.push(message);
      }
    }
    function invoke(callback, input, call) {
      return new Promise(function (resolve, reject) {
        var id = String(++sequence), timer;
        function cleanup() { clearTimeout(timer); pending.delete(id); if (call) call.signal.removeEventListener('abort', cancel); }
        function cancel() {
          cleanup(); reject(call.signal.reason);
          if (!signal.aborted) { try { send({ id: id, cancel: true }); } catch (error) { stop(error); } }
        }
        timer = setTimeout(function () { stop(new Error('插件处理超时')); }, 60000);
        pending.set(id, { call: call, resolve: function (value) { cleanup(); resolve(value); }, reject: function (error) { cleanup(); reject(error); } });
        if (call) { call.signal.addEventListener('abort', cancel, { once: true }); if (call.signal.aborted) { cancel(); return; } }
        try { send({ id: id, callback: callback, input: input, call: call ? { idempotencyKey: call.idempotencyKey } : null }); }
        catch (error) { cleanup(); reject(error); stop(error); }
      });
    }
    async function request(operation, input) {
      signal.throwIfAborted();
      if (operation === 'ready') { clearTimeout(startup); readyResolve(); return null; }
      if (operation === 'next') {
        if (messages.length) return messages.shift();
        if (waiting) throw new Error('插件事件读取重复');
        return new Promise(function (resolve) {
          var timer = setTimeout(function () { waiting = null; resolve(null); }, 25000);
          waiting = function (value) { clearTimeout(timer); resolve(value); };
        });
      }
      if (operation === 'register') {
        if (effects.size >= 64 || effects.has(input.id)) throw new Error('插件注册项过多或重复');
        var dispose;
        if (input.kind === 'event') dispose = api.events.on(input.value, function (event) { return invoke(input.id, event); });
        else if (input.kind === 'app') dispose = api.registerApp(input.value);
        else if (input.kind === 'capability') dispose = api.registerCapability(Object.assign({}, input.value, {
          permissions: Array.from(new Set(['plugins.execute'].concat(input.value.permissions || []))),
          execute: function (value, call) { return invoke(input.id, value, call); },
        }));
        else throw new Error('未知插件注册类型');
        effects.set(input.id, dispose); return null;
      }
      if (operation === 'unregister') { var dispose = effects.get(input.id); if (dispose) dispose(); effects.delete(input.id); return null; }
      if (operation === 'settle') {
        var task = pending.get(input.id);
        if (task) {
          if (input.error) {
            var error = Object.assign(new Error(input.error.message), input.error);
            task.reject(error);
            if (!task.call || !task.call.signal.aborted) stop(error);
          }
          else task.resolve(input.value);
        }
        return null;
      }
      if (operation === 'emit') { api.events.emit(input.name, input.data); return null; }
      if (operation === 'hash') return root.AgentResourceProtocol.sha256(input);
      if (operation === 'conversation') return api.conversation(input.command, input.input);
      if (operation === 'arp' || operation === 'serverArp') {
        var invocation = input.callId && pending.get(input.callId);
        if (input.callId && (!invocation || !invocation.call)) throw new Error('插件调用已结束');
        var target = invocation ? invocation.call : api;
        if (operation === 'arp') {
          var route = options.resourceRuntime.registry.resolve(input.request.uri.split('?')[0], input.method);
          if (input.method !== 'OPTIONS' && (!route || !route.methodContract || route.methodContract.permissions.some(function (permission) { return !definition.permissions.includes(permission); }))) throw new Error('插件未声明此资源权限');
          return target.arp(input.method, input.request);
        }
        return target.serverArp(input.connectionId, input.method, input.request);
      }
      if (operation === 'storageGet' || operation === 'storageSet') {
        var work = storage.then(async function () {
          signal.throwIfAborted();
          var record = await options.storageArea.get(dataKey), data = record[dataKey] || {};
          if (operation === 'storageGet') {
            if (typeof input !== 'string') throw new Error('storage.get 需要字符串键');
            return Object.prototype.hasOwnProperty.call(data, input) ? { [input]: data[input] } : {};
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('storage.set 需要对象');
          var next = Object.assign({}, data, input);
          if (JSON.stringify(next).length > 262144) throw new Error('插件数据超过 256 KB');
          signal.throwIfAborted(); await options.storageArea.set({ [dataKey]: next }); return null;
        });
        storage = work.catch(function () {}); return work;
      }
      throw new Error('不支持的插件宿主操作：' + operation);
    }
    options.runScript(script(definition, options, false), { signal: signal, persistent: true, tag: 'plugin:' + definition.id,
      apiCall: async function (name, args) {
        try {
          if (name !== 'ctx.get') throw new Error('请通过 ctx.pageAgent 使用插件宿主接口');
          return { value: await request(args[0], args[1]) };
        } catch (error) { return { error: { message: error.message || String(error), code: error.code } }; }
      },
    }).then(function () { stop(new Error('插件运行意外结束')); }, stop);
    return ready;
  }
  root.PageAgentPluginSource = Object.freeze({ inspect: inspect, start: start,
    blank: 'module.exports = {\n  apply(ctx, config) {\n    const api = ctx.pageAgent;\n    // 在这里注册能力或订阅事件。\n  },\n};\n' });
})(globalThis);
