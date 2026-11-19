// @cordisjs/core 3.18.1 (MIT). Local browser wrapper; see NOTICE.md.
(function (root) {
'use strict';
var module = { exports: {} };
function require(name) {
  if (name === 'cosmokit' && root.PageAgentCosmokit) return root.PageAgentCosmokit;
  throw new Error('Unsupported Cordis dependency: ' + name);
}
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  Context: () => Context,
  CordisError: () => CordisError,
  EffectScope: () => EffectScope,
  ForkScope: () => ForkScope,
  Inject: () => Inject,
  Lifecycle: () => events_default,
  MainScope: () => MainScope,
  ReflectService: () => reflect_default,
  Registry: () => registry_default,
  ScopeStatus: () => ScopeStatus,
  Service: () => Service,
  createCallable: () => createCallable,
  getTraceable: () => getTraceable,
  isBailed: () => isBailed,
  isConstructor: () => isConstructor,
  isObject: () => isObject,
  isUnproxyable: () => isUnproxyable,
  joinPrototype: () => joinPrototype,
  resolveConfig: () => resolveConfig,
  symbols: () => symbols,
  withProps: () => withProps
});
module.exports = __toCommonJS(src_exports);

// src/context.ts
var import_cosmokit6 = require("cosmokit");

// src/events.ts
var import_cosmokit3 = require("cosmokit");

// src/reflect.ts
var import_cosmokit2 = require("cosmokit");

// src/utils.ts
var import_cosmokit = require("cosmokit");
var symbols = {
  // internal symbols
  shadow: Symbol.for("cordis.shadow"),
  receiver: Symbol.for("cordis.receiver"),
  original: Symbol.for("cordis.original"),
  // context symbols
  store: Symbol.for("cordis.store"),
  events: Symbol.for("cordis.events"),
  static: Symbol.for("cordis.static"),
  filter: Symbol.for("cordis.filter"),
  expose: Symbol.for("cordis.expose"),
  isolate: Symbol.for("cordis.isolate"),
  internal: Symbol.for("cordis.internal"),
  intercept: Symbol.for("cordis.intercept"),
  // service symbols
  setup: Symbol.for("cordis.setup"),
  invoke: Symbol.for("cordis.invoke"),
  extend: Symbol.for("cordis.extend"),
  tracker: Symbol.for("cordis.tracker"),
  provide: Symbol.for("cordis.provide"),
  immediate: Symbol.for("cordis.immediate")
};
var GeneratorFunction = function* () {
}.constructor;
var AsyncGeneratorFunction = async function* () {
}.constructor;
function isConstructor(func) {
  if (!func.prototype) return false;
  if (func instanceof GeneratorFunction) return false;
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false;
  return true;
}
__name(isConstructor, "isConstructor");
function resolveConfig(plugin, config) {
  const schema = plugin["Config"] || plugin["schema"];
  if (schema && plugin["schema"] !== false) config = schema(config);
  return config ?? {};
}
__name(resolveConfig, "resolveConfig");
function isUnproxyable(value) {
  return [Map, Set, Date, Promise].some((constructor) => value instanceof constructor);
}
__name(isUnproxyable, "isUnproxyable");
function joinPrototype(proto1, proto2) {
  if (proto1 === Object.prototype) return proto2;
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2));
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key));
  }
  return result;
}
__name(joinPrototype, "joinPrototype");
function isObject(value) {
  return value && (typeof value === "object" || typeof value === "function");
}
__name(isObject, "isObject");
function getTraceable(ctx, value, noTrap) {
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value);
  }
  const tracker = value[symbols.tracker];
  if (!tracker) return value;
  return createTraceable(ctx, value, tracker, noTrap);
}
__name(getTraceable, "getTraceable");
function withProps(target, props) {
  if (!props) return target;
  return new Proxy(target, {
    get: /* @__PURE__ */ __name((target2, prop, receiver) => {
      if (prop in props && prop !== "constructor") return Reflect.get(props, prop, receiver);
      return Reflect.get(target2, prop, receiver);
    }, "get"),
    set: /* @__PURE__ */ __name((target2, prop, value, receiver) => {
      if (prop in props && prop !== "constructor") return Reflect.set(props, prop, value, receiver);
      return Reflect.set(target2, prop, value, receiver);
    }, "set")
  });
}
__name(withProps, "withProps");
function withProp(target, prop, value) {
  return withProps(target, Object.defineProperty(/* @__PURE__ */ Object.create(null), prop, {
    value,
    writable: false
  }));
}
__name(withProp, "withProp");
function createShadow(ctx, target, property, receiver) {
  if (!property) return receiver;
  const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value;
  if (!origin) return receiver;
  return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }));
}
__name(createShadow, "createShadow");
function createShadowMethod(ctx, value, outer, shadow) {
  return new Proxy(value, {
    apply: /* @__PURE__ */ __name((target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow;
      args = args.map((arg) => {
        if (typeof arg !== "function" || arg[symbols.original]) return arg;
        return new Proxy(arg, {
          get: /* @__PURE__ */ __name((target2, prop, receiver) => {
            if (prop === symbols.original) return target2;
            const value2 = Reflect.get(target2, prop, receiver);
            if (prop === "toString" && value2 === Function.prototype.toString) {
              return function(...args2) {
                return Reflect.apply(value2, this === receiver ? target2 : this, args2);
              };
            }
            return value2;
          }, "get"),
          apply: /* @__PURE__ */ __name((target2, thisArg2, args2) => {
            return Reflect.apply(target2, getTraceable(ctx, thisArg2), args2.map((arg2) => getTraceable(ctx, arg2)));
          }, "apply"),
          construct: /* @__PURE__ */ __name((target2, args2, newTarget) => {
            return Reflect.construct(target2, args2.map((arg2) => getTraceable(ctx, arg2)), newTarget);
          }, "construct")
        });
      });
      return getTraceable(ctx, Reflect.apply(target, thisArg, args));
    }, "apply")
  });
}
__name(createShadowMethod, "createShadowMethod");
function createTraceable(ctx, value, tracker, noTrap) {
  if (ctx[symbols.shadow]) {
    ctx = Object.getPrototypeOf(ctx);
  }
  const proxy = new Proxy(value, {
    get: /* @__PURE__ */ __name((target, prop, receiver) => {
      if (prop === symbols.original) return target;
      if (prop === tracker.property) return ctx;
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver));
      }
      const shadow = createShadow(ctx, target, tracker.property, receiver);
      const innerValue = Reflect.get(target, prop, shadow);
      const innerTracker = innerValue?.[symbols.tracker];
      if (innerTracker) {
        return createTraceable(ctx, innerValue, innerTracker);
      } else if (!noTrap && typeof innerValue === "function") {
        return createShadowMethod(ctx, innerValue, receiver, shadow);
      } else {
        return innerValue;
      }
    }, "get"),
    set: /* @__PURE__ */ __name((target, prop, value2, receiver) => {
      if (prop === symbols.original) return false;
      if (prop === tracker.property) return false;
      if (typeof prop === "symbol") {
        return Reflect.set(target, prop, value2, receiver);
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value2, withProp(ctx, symbols.receiver, receiver));
      }
      const shadow = createShadow(ctx, target, tracker.property, receiver);
      return Reflect.set(target, prop, value2, shadow);
    }, "set"),
    apply: /* @__PURE__ */ __name((target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args);
    }, "apply")
  });
  return proxy;
}
__name(createTraceable, "createTraceable");
function applyTraceable(proxy, value, thisArg, args) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args);
  return value[symbols.invoke].apply(proxy, args);
}
__name(applyTraceable, "applyTraceable");
function createCallable(name, proto, tracker) {
  const self = /* @__PURE__ */ __name(function(...args) {
    const proxy = createTraceable(self["ctx"], self, tracker);
    return applyTraceable(proxy, self, this, args);
  }, "self");
  (0, import_cosmokit.defineProperty)(self, "name", name);
  return Object.setPrototypeOf(self, proto);
}
__name(createCallable, "createCallable");

// src/reflect.ts
var ReflectService = class _ReflectService {
  constructor(ctx) {
    this.ctx = ctx;
    (0, import_cosmokit2.defineProperty)(this, symbols.tracker, {
      associate: "reflect",
      property: "ctx"
    });
    this._mixin("reflect", ["get", "set", "provide", "accessor", "mixin", "alias"]);
    this._mixin("scope", ["config", "runtime", "effect", "collect", "accept", "decline"]);
    this._mixin("registry", ["using", "inject", "plugin"]);
    this._mixin("lifecycle", ["on", "once", "parallel", "emit", "serial", "bail", "start", "stop"]);
  }
  static {
    __name(this, "ReflectService");
  }
  static resolveInject(ctx, name) {
    let internal = ctx[symbols.internal][name];
    while (internal?.type === "alias") {
      name = internal.name;
      internal = ctx[symbols.internal][name];
    }
    return [name, internal];
  }
  static checkInject(ctx, name, error) {
    ctx = ctx[symbols.shadow] ?? ctx;
    if (["prototype", "then", "registry", "lifecycle"].includes(name)) return;
    if (name[0] === "$" || name[0] === "_") return;
    if (!ctx.runtime.plugin) return;
    if (ctx.bail(ctx, "internal/inject", name)) return;
    const lines = error.stack.split("\n");
    lines.splice(1, 1);
    error.stack = lines.join("\n");
    ctx.emit(ctx, "internal/warning", error);
  }
  static handler = {
    get: /* @__PURE__ */ __name((target, prop, ctx) => {
      if (typeof prop !== "string") return Reflect.get(target, prop, ctx);
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx), true);
      }
      const [name, internal] = _ReflectService.resolveInject(target, prop);
      const error = new Error(`property ${name} is not registered, declare it as \`inject\` to suppress this warning`);
      if (!internal) {
        _ReflectService.checkInject(ctx, name, error);
        return Reflect.get(target, name, ctx);
      } else if (internal.type === "accessor") {
        return internal.get.call(ctx, ctx[symbols.receiver]);
      } else {
        if (!internal.builtin) _ReflectService.checkInject(ctx, name, error);
        return ctx.reflect.get(name);
      }
    }, "get"),
    set: /* @__PURE__ */ __name((target, prop, value, ctx) => {
      if (typeof prop !== "string") return Reflect.set(target, prop, value, ctx);
      const [name, internal] = _ReflectService.resolveInject(target, prop);
      if (!internal) {
        return Reflect.set(target, name, value, ctx);
      }
      if (internal.type === "accessor") {
        if (!internal.set) return false;
        return internal.set.call(ctx, value, ctx[symbols.receiver]);
      } else {
        ctx.reflect.set(name, value);
        return true;
      }
    }, "set"),
    has: /* @__PURE__ */ __name((target, prop) => {
      if (typeof prop !== "string") return Reflect.has(target, prop);
      if (Reflect.has(target, prop)) return true;
      const [, internal] = _ReflectService.resolveInject(target, prop);
      return !!internal;
    }, "has")
  };
  get(name) {
    const internal = this.ctx[symbols.internal][name];
    if (internal?.type !== "service") return;
    const key = this.ctx[symbols.isolate][name];
    const value = this.ctx[symbols.store][key]?.value;
    return getTraceable(this.ctx, value);
  }
  set(name, value) {
    this.provide(name);
    const key = this.ctx[symbols.isolate][name];
    const oldValue = this.ctx[symbols.store][key]?.value;
    value ??= void 0;
    let dispose = /* @__PURE__ */ __name(() => {
    }, "dispose");
    if (oldValue === value) return dispose;
    if (!(0, import_cosmokit2.isNullable)(value) && !(0, import_cosmokit2.isNullable)(oldValue)) {
      throw new Error(`service ${name} has been registered`);
    }
    const ctx = this.ctx;
    if (!(0, import_cosmokit2.isNullable)(value)) {
      dispose = ctx.effect(() => () => {
        ctx.set(name, void 0);
      });
    }
    if (isUnproxyable(value)) {
      ctx.emit(ctx, "internal/warning", new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`));
    }
    const self = Object.create(ctx);
    self[symbols.filter] = (ctx2) => {
      return ctx[symbols.isolate][name] === ctx2[symbols.isolate][name];
    };
    ctx.emit(self, "internal/before-service", name, value);
    ctx[symbols.store][key] = { value, source: ctx };
    ctx.emit(self, "internal/service", name, oldValue);
    return dispose;
  }
  provide(name, value, builtin) {
    const internal = this.ctx.root[symbols.internal];
    if (name in internal) return;
    const key = Symbol(name);
    internal[name] = { type: "service", builtin };
    this.ctx.root[symbols.isolate][name] = key;
    if (!isObject(value)) return;
    this.ctx[symbols.store][key] = { value, source: null };
    (0, import_cosmokit2.defineProperty)(value, symbols.tracker, {
      associate: name,
      property: "ctx"
    });
  }
  _accessor(name, options) {
    const internal = this.ctx.root[symbols.internal];
    if (name in internal) return () => {
    };
    internal[name] = { type: "accessor", ...options };
    return () => delete this.ctx.root[symbols.isolate][name];
  }
  accessor(name, options) {
    this.ctx.scope.effect(() => {
      return this._accessor(name, options);
    });
  }
  alias(name, aliases) {
    const internal = this.ctx.root[symbols.internal];
    if (name in internal) return;
    for (const key of aliases) {
      internal[key] ||= { type: "alias", name };
    }
  }
  _mixin(source, mixins) {
    const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key]) : Object.entries(mixins);
    const getTarget = typeof source === "string" ? (ctx) => ctx[source] : () => source;
    const disposables = entries.map(([key, value]) => {
      return this._accessor(value, {
        get(receiver) {
          const service = getTarget(this);
          if ((0, import_cosmokit2.isNullable)(service)) return service;
          const mixin = receiver ? withProps(receiver, service) : service;
          const value2 = Reflect.get(service, key, mixin);
          if (typeof value2 !== "function") return value2;
          return value2.bind(mixin ?? service);
        },
        set(value2, receiver) {
          const service = getTarget(this);
          const mixin = receiver ? withProps(receiver, service) : service;
          return Reflect.set(service, key, value2, mixin);
        }
      });
    });
    return () => disposables.forEach((dispose) => dispose());
  }
  mixin(source, mixins) {
    this.ctx.scope.effect(() => {
      return this._mixin(source, mixins);
    });
  }
  trace(value) {
    return getTraceable(this.ctx, value);
  }
  bind(callback) {
    return new Proxy(callback, {
      apply: /* @__PURE__ */ __name((target, thisArg, args) => {
        return target.apply(this.trace(thisArg), args.map((arg) => this.trace(arg)));
      }, "apply")
    });
  }
};
var reflect_default = ReflectService;

// src/events.ts
function isBailed(value) {
  return value !== null && value !== false && value !== void 0;
}
__name(isBailed, "isBailed");
var Lifecycle = class {
  constructor(ctx) {
    this.ctx = ctx;
    (0, import_cosmokit3.defineProperty)(this, symbols.tracker, {
      associate: "lifecycle",
      property: "ctx"
    });
    (0, import_cosmokit3.defineProperty)(this.on("internal/listener", function(name, listener, options) {
      const method = options.prepend ? "unshift" : "push";
      if (name === "ready") {
        if (!this.lifecycle.isActive) return;
        this.scope.ensure(async () => listener());
        return () => false;
      } else if (name === "dispose") {
        this.scope.disposables[method](listener);
        (0, import_cosmokit3.defineProperty)(listener, "name", "event <dispose>");
        return () => (0, import_cosmokit3.remove)(this.scope.disposables, listener);
      } else if (name === "fork") {
        this.scope.runtime.forkables[method](listener);
        return this.scope.collect("event <fork>", () => (0, import_cosmokit3.remove)(this.scope.runtime.forkables, listener));
      }
    }), Context.static, ctx.scope);
    for (const level of ["info", "error", "warning"]) {
      (0, import_cosmokit3.defineProperty)(this.on(`internal/${level}`, (format, ...param) => {
        if (this._hooks[`internal/${level}`].length > 1) return;
        console.info(format, ...param);
      }), Context.static, ctx.scope);
    }
    (0, import_cosmokit3.defineProperty)(this.on("internal/before-service", function(name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue;
        const scopes = runtime.isReusable ? runtime.children : [runtime];
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue;
          scope.updateStatus();
          scope.reset();
        }
      }
    }, { global: true }), Context.static, ctx.scope);
    (0, import_cosmokit3.defineProperty)(this.on("internal/service", function(name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue;
        const scopes = runtime.isReusable ? runtime.children : [runtime];
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue;
          scope.start();
        }
      }
    }, { global: true }), Context.static, ctx.scope);
    const checkInject = /* @__PURE__ */ __name((scope, name) => {
      if (!scope.runtime.plugin) return false;
      for (const key in scope.runtime.inject) {
        if (name === reflect_default.resolveInject(scope.ctx, key)[0]) return true;
      }
      return checkInject(scope.parent.scope, name);
    }, "checkInject");
    (0, import_cosmokit3.defineProperty)(this.on("internal/inject", function(name) {
      return checkInject(this.scope, name);
    }, { global: true }), Context.static, ctx.scope);
  }
  static {
    __name(this, "Lifecycle");
  }
  isActive = false;
  _tasks = /* @__PURE__ */ new Set();
  _hooks = {};
  async flush() {
    while (this._tasks.size) {
      await Promise.all(Array.from(this._tasks));
    }
  }
  filterHooks(hooks, thisArg) {
    thisArg = getTraceable(this.ctx, thisArg);
    return hooks.slice().filter((hook) => {
      const filter = thisArg?.[Context.filter];
      return hook.global || !filter || filter.call(thisArg, hook.ctx);
    });
  }
  *dispatch(type, args) {
    const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
    const name = args.shift();
    if (name !== "internal/event") {
      this.emit("internal/event", type, name, args, thisArg);
    }
    for (const hook of this.filterHooks(this._hooks[name] || [], thisArg)) {
      yield hook.callback.apply(thisArg, args);
    }
  }
  async parallel(...args) {
    await Promise.all(this.dispatch("emit", args));
  }
  emit(...args) {
    Array.from(this.dispatch("emit", args));
  }
  async serial(...args) {
    for await (const result of this.dispatch("serial", args)) {
      if (isBailed(result)) return result;
    }
  }
  bail(...args) {
    for (const result of this.dispatch("bail", args)) {
      if (isBailed(result)) return result;
    }
  }
  register(label, hooks, callback, options) {
    const method = options.prepend ? "unshift" : "push";
    hooks[method]({ ctx: this.ctx, callback, ...options });
    return this.ctx.state.collect(label, () => this.unregister(hooks, callback));
  }
  unregister(hooks, callback) {
    const index = hooks.findIndex((hook) => hook.callback === callback);
    if (index >= 0) {
      hooks.splice(index, 1);
      return true;
    }
  }
  on(name, listener, options) {
    if (typeof options !== "object") {
      options = { prepend: options };
    }
    this.ctx.scope.assertActive();
    listener = this.ctx.reflect.bind(listener);
    const result = this.bail(this.ctx, "internal/listener", name, listener, options);
    if (result) return result;
    const hooks = this._hooks[name] ||= [];
    const label = typeof name === "string" ? `event <${name}>` : "event (Symbol)";
    return this.register(label, hooks, listener, options);
  }
  once(name, listener, options) {
    const dispose = this.on(name, function(...args) {
      dispose();
      return listener.apply(this, args);
    }, options);
    return dispose;
  }
  async start() {
    this.isActive = true;
    const hooks = this._hooks.ready || [];
    while (hooks.length) {
      const { ctx, callback } = hooks.shift();
      ctx.scope.ensure(async () => callback());
    }
    await this.flush();
  }
  async stop() {
    this.isActive = false;
    this.ctx.scope.reset();
  }
};
var events_default = Lifecycle;

// src/registry.ts
var import_cosmokit5 = require("cosmokit");

// src/scope.ts
var import_cosmokit4 = require("cosmokit");
var ScopeStatus = /* @__PURE__ */ ((ScopeStatus2) => {
  ScopeStatus2[ScopeStatus2["PENDING"] = 0] = "PENDING";
  ScopeStatus2[ScopeStatus2["LOADING"] = 1] = "LOADING";
  ScopeStatus2[ScopeStatus2["ACTIVE"] = 2] = "ACTIVE";
  ScopeStatus2[ScopeStatus2["FAILED"] = 3] = "FAILED";
  ScopeStatus2[ScopeStatus2["DISPOSED"] = 4] = "DISPOSED";
  return ScopeStatus2;
})(ScopeStatus || {});
var CordisError = class _CordisError extends Error {
  constructor(code, message) {
    super(message ?? _CordisError.Code[code]);
    this.code = code;
  }
  static {
    __name(this, "CordisError");
  }
};
((CordisError2) => {
  CordisError2.Code = {
    INACTIVE_EFFECT: "cannot create effect on inactive context"
  };
})(CordisError || (CordisError = {}));
var EffectScope = class {
  constructor(parent, config) {
    this.parent = parent;
    this.config = config;
    this.uid = parent.registry ? parent.registry.counter : 0;
    this.ctx = this.context = parent.extend({ scope: this });
    this.proxy = new Proxy({}, {
      get: /* @__PURE__ */ __name((target, key) => Reflect.get(this.config, key), "get")
    });
  }
  static {
    __name(this, "EffectScope");
  }
  uid;
  ctx;
  disposables = [];
  error;
  status = 0 /* PENDING */;
  isActive = false;
  // Same as `this.ctx`, but with a more specific type.
  context;
  proxy;
  acceptors = [];
  tasks = /* @__PURE__ */ new Set();
  hasError = false;
  get _config() {
    return this.runtime.isReactive ? this.proxy : this.config;
  }
  assertActive() {
    if (this.uid !== null || this.isActive) return;
    throw new CordisError("INACTIVE_EFFECT");
  }
  effect(callback, config) {
    this.assertActive();
    const result = isConstructor(callback) ? new callback(this.ctx, config) : callback(this.ctx, config);
    let disposed = false;
    const original = typeof result === "function" ? result : result.dispose.bind(result);
    const wrapped = /* @__PURE__ */ __name((...args) => {
      if (disposed) return;
      disposed = true;
      (0, import_cosmokit4.remove)(this.disposables, wrapped);
      return original(...args);
    }, "wrapped");
    this.disposables.push(wrapped);
    if (typeof result === "function") return wrapped;
    result.dispose = wrapped;
    return result;
  }
  collect(label, callback) {
    const dispose = (0, import_cosmokit4.defineProperty)(() => {
      (0, import_cosmokit4.remove)(this.disposables, dispose);
      return callback();
    }, "name", label);
    this.disposables.push(dispose);
    return dispose;
  }
  restart() {
    this.reset();
    this.error = null;
    this.hasError = false;
    this.status = 0 /* PENDING */;
    this.start();
  }
  _getStatus() {
    if (this.uid === null) return 4 /* DISPOSED */;
    if (this.hasError) return 3 /* FAILED */;
    if (this.tasks.size) return 1 /* LOADING */;
    if (this.ready) return 2 /* ACTIVE */;
    return 0 /* PENDING */;
  }
  updateStatus(callback) {
    const oldValue = this.status;
    callback?.();
    this.status = this._getStatus();
    if (oldValue !== this.status) {
      this.context.emit("internal/status", this, oldValue);
    }
  }
  ensure(callback) {
    const task = callback().catch((reason) => {
      this.context.emit(this.ctx, "internal/error", reason);
      this.cancel(reason);
    }).finally(() => {
      this.updateStatus(() => this.tasks.delete(task));
      this.context.events._tasks.delete(task);
    });
    this.updateStatus(() => this.tasks.add(task));
    this.context.events._tasks.add(task);
  }
  cancel(reason) {
    this.error = reason;
    this.updateStatus(() => this.hasError = true);
    this.reset();
  }
  get ready() {
    return Object.entries(this.runtime.inject).every(([name, inject]) => {
      return !inject.required || !(0, import_cosmokit4.isNullable)(this.ctx.get(name));
    });
  }
  reset() {
    this.isActive = false;
    this.disposables = this.disposables.splice(0).filter((dispose) => {
      if (this.uid !== null && dispose[Context.static] === this) return true;
      (async () => dispose())().catch((reason) => {
        this.context.emit(this.ctx, "internal/error", reason);
      });
    });
  }
  init(error) {
    if (!this.config) {
      this.cancel(error);
    } else {
      this.start();
    }
  }
  start() {
    if (!this.ready || this.isActive || this.uid === null) return true;
    this.isActive = true;
    this.updateStatus(() => this.hasError = false);
  }
  accept(...args) {
    const keys = Array.isArray(args[0]) ? args.shift() : null;
    const acceptor = { keys, callback: args[0], ...args[1] };
    return this.effect(() => {
      this.acceptors.push(acceptor);
      if (acceptor.immediate) acceptor.callback?.(this.config);
      return () => (0, import_cosmokit4.remove)(this.acceptors, acceptor);
    });
  }
  decline(keys) {
    return this.accept(keys, () => true);
  }
  checkUpdate(resolved, forced) {
    if (forced || !this.config) return [true, true];
    if (forced === false) return [false, false];
    const modified = /* @__PURE__ */ Object.create(null);
    const checkPropertyUpdate = /* @__PURE__ */ __name((key) => {
      const result = modified[key] ??= !(0, import_cosmokit4.deepEqual)(this.config[key], resolved[key]);
      hasUpdate ||= result;
      return result;
    }, "checkPropertyUpdate");
    const ignored = /* @__PURE__ */ new Set();
    let hasUpdate = false, shouldRestart = false;
    let fallback = this.runtime.isReactive || null;
    for (const { keys, callback, passive } of this.acceptors) {
      if (!keys) {
        fallback ||= !passive;
      } else if (passive) {
        keys?.forEach((key) => ignored.add(key));
      } else {
        let hasUpdate2 = false;
        for (const key of keys) {
          hasUpdate2 ||= checkPropertyUpdate(key);
        }
        if (!hasUpdate2) continue;
      }
      const result = callback?.(resolved);
      if (result) shouldRestart = true;
    }
    for (const key in { ...this.config, ...resolved }) {
      if (fallback === false) continue;
      if (!(key in modified) && !ignored.has(key)) {
        const hasUpdate2 = checkPropertyUpdate(key);
        if (fallback === null) shouldRestart ||= hasUpdate2;
      }
    }
    return [hasUpdate, shouldRestart];
  }
};
var ForkScope = class extends EffectScope {
  constructor(parent, runtime, config, error) {
    super(parent, config);
    this.runtime = runtime;
    this.dispose = (0, import_cosmokit4.defineProperty)(parent.scope.collect(`fork <${parent.runtime.name}>`, () => {
      this.uid = null;
      this.reset();
      this.context.emit("internal/fork", this);
      const result = (0, import_cosmokit4.remove)(runtime.disposables, this.dispose);
      if ((0, import_cosmokit4.remove)(runtime.children, this) && !runtime.children.length) {
        parent.registry.delete(runtime.plugin);
      }
      return result;
    }), Context.static, runtime);
    runtime.children.push(this);
    runtime.disposables.push(this.dispose);
    this.context.emit("internal/fork", this);
    this.init(error);
  }
  static {
    __name(this, "ForkScope");
  }
  dispose;
  start() {
    if (super.start()) return true;
    for (const fork of this.runtime.forkables) {
      this.ensure(async () => fork(this.context, this._config));
    }
  }
  update(config, forced) {
    const oldConfig = this.config;
    const state = this.runtime.isForkable ? this : this.runtime;
    if (state.config !== oldConfig) return;
    let resolved;
    try {
      resolved = resolveConfig(this.runtime.plugin, config);
    } catch (error) {
      this.context.emit("internal/error", error);
      return this.cancel(error);
    }
    const [hasUpdate, shouldRestart] = state.checkUpdate(resolved, forced);
    this.context.emit("internal/before-update", this, config);
    this.config = resolved;
    state.config = resolved;
    if (hasUpdate) {
      this.context.emit("internal/update", this, oldConfig);
    }
    if (shouldRestart) state.restart();
  }
};
var MainScope = class extends EffectScope {
  constructor(ctx, plugin, config, error) {
    super(ctx, config);
    this.plugin = plugin;
    if (!plugin) {
      this.name = "root";
      this.isActive = true;
    } else {
      this.setup();
      this.init(error);
    }
  }
  static {
    __name(this, "MainScope");
  }
  value;
  runtime = this;
  schema;
  name;
  inject = /* @__PURE__ */ Object.create(null);
  forkables = [];
  children = [];
  isReusable = false;
  isReactive = false;
  get isForkable() {
    return this.forkables.length > 0;
  }
  fork(parent, config, error) {
    return new ForkScope(parent, this, config, error);
  }
  dispose() {
    this.uid = null;
    this.reset();
    this.context.emit("internal/runtime", this);
    return true;
  }
  setup() {
    const { name } = this.plugin;
    if (name && name !== "apply") this.name = name;
    this.schema = this.plugin["Config"] || this.plugin["schema"];
    this.inject = Inject.resolve(this.plugin["using"] || this.plugin["inject"]);
    this.isReusable = this.plugin["reusable"];
    this.isReactive = this.plugin["reactive"];
    this.context.emit("internal/runtime", this);
    if (this.isReusable) {
      this.forkables.push(this.apply);
    }
  }
  apply = /* @__PURE__ */ __name((context, config) => {
    if (typeof this.plugin !== "function") {
      return this.plugin.apply(context, config);
    } else if (isConstructor(this.plugin)) {
      const instance = new this.plugin(context, config);
      const name = instance[Context.expose];
      if (name) {
        context.set(name, instance);
      }
      if (instance["fork"]) {
        this.forkables.push(instance["fork"].bind(instance));
      }
      return instance;
    } else {
      return this.plugin(context, config);
    }
  }, "apply");
  reset() {
    super.reset();
    for (const fork of this.children) {
      fork.reset();
    }
  }
  start() {
    if (super.start()) return true;
    if (!this.isReusable && this.plugin) {
      this.ensure(async () => this.value = this.apply(this.ctx, this._config));
    }
    for (const fork of this.children) {
      fork.start();
    }
  }
  update(config, forced) {
    if (this.isForkable) {
      const warning = new Error(`attempting to update forkable plugin "${this.plugin.name}", which may lead to unexpected behavior`);
      this.context.emit(this.ctx, "internal/warning", warning);
    }
    const oldConfig = this.config;
    let resolved;
    try {
      resolved = resolveConfig(this.runtime.plugin || this.context.constructor, config);
    } catch (error) {
      this.context.emit("internal/error", error);
      return this.cancel(error);
    }
    const [hasUpdate, shouldRestart] = this.checkUpdate(resolved, forced);
    const state = this.children.find((fork) => fork.config === oldConfig);
    this.config = resolved;
    if (state) {
      this.context.emit("internal/before-update", state, config);
      state.config = resolved;
      if (hasUpdate) {
        this.context.emit("internal/update", state, oldConfig);
      }
    }
    if (shouldRestart) this.restart();
  }
};

// src/registry.ts
function isApplicable(object) {
  return object && typeof object === "object" && typeof object.apply === "function";
}
__name(isApplicable, "isApplicable");
function Inject(inject) {
  return function(value, ctx) {
    if (ctx.kind === "class") {
      value.inject = inject;
    } else if (ctx.kind === "method") {
      ctx.addInitializer(function() {
        const property = this[symbols.tracker]?.property;
        if (!property) throw new Error("missing context tracker");
        this[property].inject(inject, (ctx2) => {
          value.call(withProps(this, { [property]: ctx2 }));
        });
      });
    } else {
      throw new Error("@Inject can only be used on class or class methods");
    }
  };
}
__name(Inject, "Inject");
((Inject2) => {
  function resolve(inject) {
    if (!inject) return {};
    if (Array.isArray(inject)) {
      return Object.fromEntries(inject.map((name) => [name, { required: true }]));
    }
    const { required, optional, ...rest } = inject;
    if (Array.isArray(required)) {
      Object.assign(rest, Object.fromEntries(required.map((name) => [name, { required: true }])));
    }
    if (Array.isArray(optional)) {
      Object.assign(rest, Object.fromEntries(optional.map((name) => [name, { required: false }])));
    }
    return rest;
  }
  Inject2.resolve = resolve;
  __name(resolve, "resolve");
})(Inject || (Inject = {}));
var Registry = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    (0, import_cosmokit5.defineProperty)(this, symbols.tracker, {
      associate: "registry",
      property: "ctx"
    });
    this.context = ctx;
    const runtime = new MainScope(ctx, null, config);
    ctx.scope = runtime;
    runtime.ctx = ctx;
    this.set(null, runtime);
  }
  static {
    __name(this, "Registry");
  }
  _counter = 0;
  _internal = /* @__PURE__ */ new Map();
  context;
  get counter() {
    return ++this._counter;
  }
  get size() {
    return this._internal.size;
  }
  resolve(plugin, assert = false) {
    if (plugin === null) return plugin;
    if (typeof plugin === "function") return plugin;
    if (isApplicable(plugin)) return plugin.apply;
    if (assert) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin);
  }
  get(plugin) {
    const key = this.resolve(plugin);
    return key && this._internal.get(key);
  }
  has(plugin) {
    const key = this.resolve(plugin);
    return !!key && this._internal.has(key);
  }
  set(plugin, state) {
    const key = this.resolve(plugin);
    this._internal.set(key, state);
  }
  delete(plugin) {
    const key = this.resolve(plugin);
    const runtime = key && this._internal.get(key);
    if (!runtime) return;
    this._internal.delete(key);
    runtime.dispose();
    return runtime;
  }
  keys() {
    return this._internal.keys();
  }
  values() {
    return this._internal.values();
  }
  entries() {
    return this._internal.entries();
  }
  forEach(callback) {
    return this._internal.forEach(callback);
  }
  using(inject, callback) {
    return this.inject(inject, callback);
  }
  inject(inject, callback) {
    return this.plugin({ inject, apply: callback, name: callback.name });
  }
  plugin(plugin, config, error) {
    this.resolve(plugin, true);
    this.ctx.scope.assertActive();
    if (!error) {
      try {
        config = resolveConfig(plugin, config);
      } catch (reason) {
        this.context.emit(this.ctx, "internal/error", reason);
        error = reason;
        config = null;
      }
    }
    let runtime = this.get(plugin);
    if (runtime) {
      if (!runtime.isForkable) {
        this.context.emit(this.ctx, "internal/warning", new Error(`duplicate plugin detected: ${plugin.name}`));
      }
      return runtime.fork(this.ctx, config, error);
    }
    runtime = new MainScope(this.ctx, plugin, config, error);
    this.set(plugin, runtime);
    return runtime.fork(this.ctx, config, error);
  }
};
var registry_default = Registry;

// src/context.ts
var Context = class _Context {
  static {
    __name(this, "Context");
  }
  static store = symbols.store;
  static events = symbols.events;
  static static = symbols.static;
  static filter = symbols.filter;
  static expose = symbols.expose;
  static isolate = symbols.isolate;
  static internal = symbols.internal;
  static intercept = symbols.intercept;
  static origin = "ctx";
  static current = "ctx";
  static is(value) {
    return !!value?.[_Context.is];
  }
  static {
    _Context.is[Symbol.toPrimitive] = () => Symbol.for("cordis.is");
    _Context.prototype[_Context.is] = true;
  }
  /** @deprecated use `Service.traceable` instead */
  static associate(object, name) {
    return object;
  }
  constructor(config) {
    config = resolveConfig(this.constructor, config);
    this[symbols.store] = /* @__PURE__ */ Object.create(null);
    this[symbols.isolate] = /* @__PURE__ */ Object.create(null);
    this[symbols.internal] = /* @__PURE__ */ Object.create(null);
    this[symbols.intercept] = /* @__PURE__ */ Object.create(null);
    const self = new Proxy(this, reflect_default.handler);
    self.root = self;
    self.reflect = new reflect_default(self);
    self.registry = new registry_default(self, config);
    self.lifecycle = new events_default(self);
    const attach = /* @__PURE__ */ __name((internal) => {
      if (!internal) return;
      attach(Object.getPrototypeOf(internal));
      for (const key of Object.getOwnPropertyNames(internal)) {
        const constructor = internal[key]["prototype"]?.constructor;
        if (!constructor) continue;
        self[internal[key]["key"]] = new constructor(self, config);
        (0, import_cosmokit6.defineProperty)(self[internal[key]["key"]], "ctx", self);
      }
    }, "attach");
    attach(this[symbols.internal]);
    return self;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Context <${this.name}>`;
  }
  get name() {
    let runtime = this.runtime;
    while (runtime && !runtime.name) {
      runtime = runtime.parent.runtime;
    }
    return runtime?.name;
  }
  get events() {
    return this.lifecycle;
  }
  /** @deprecated */
  get state() {
    return this.scope;
  }
  extend(meta = {}) {
    const source = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value;
    const self = Object.assign(Object.create(getTraceable(this, this)), meta);
    if (!source) return self;
    return Object.assign(Object.create(self), { [symbols.shadow]: source });
  }
  isolate(name, label) {
    const shadow = Object.create(this[symbols.isolate]);
    shadow[name] = label ?? Symbol(name);
    return this.extend({ [symbols.isolate]: shadow });
  }
  intercept(name, config) {
    const intercept = Object.create(this[symbols.intercept]);
    intercept[name] = config;
    return this.extend({ [symbols.intercept]: intercept });
  }
};
Context.prototype[Context.internal] = /* @__PURE__ */ Object.create(null);

// src/service.ts
var import_cosmokit7 = require("cosmokit");
var Service = class _Service {
  static {
    __name(this, "Service");
  }
  static setup = symbols.setup;
  static invoke = symbols.invoke;
  static extend = symbols.extend;
  static tracker = symbols.tracker;
  static provide = symbols.provide;
  static immediate = symbols.immediate;
  start() {
  }
  stop() {
  }
  ctx;
  name;
  config;
  constructor(...args) {
    let _ctx, name, immediate, config;
    if (Context.is(args[0])) {
      _ctx = args[0];
      if (typeof args[1] === "string") {
        name = args[1];
        immediate = args[2];
      } else {
        config = args[1];
      }
    } else {
      config = args[0];
    }
    name ??= this.constructor[symbols.provide];
    immediate ??= this.constructor[symbols.immediate];
    let self = this;
    const tracker = {
      associate: name,
      property: "ctx"
    };
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
    }
    if (_ctx) {
      self.ctx = _ctx;
    } else {
      self[symbols.setup]();
    }
    self.name = name;
    self.config = config;
    (0, import_cosmokit7.defineProperty)(self, symbols.tracker, tracker);
    self.ctx.provide(name);
    self.ctx.runtime.name = name;
    if (immediate) {
      if (_ctx) self[symbols.expose] = name;
      else self.ctx.set(name, self);
    }
    self.ctx.on("ready", async () => {
      await Promise.resolve();
      await self.start();
      if (!immediate) self.ctx.set(name, self);
    });
    self.ctx.on("dispose", () => self.stop());
    return self;
  }
  [symbols.filter](ctx) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
  }
  [symbols.setup]() {
    this.ctx = new Context();
  }
  [symbols.extend](props) {
    let self;
    if (this[_Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker]);
    } else {
      self = Object.create(this);
    }
    return Object.assign(self, props);
  }
  static [Symbol.hasInstance](instance) {
    let constructor = instance.constructor;
    while (constructor) {
      constructor = constructor.prototype?.constructor;
      if (constructor === this) return true;
      constructor = Object.getPrototypeOf(constructor);
    }
    return false;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Context,
  CordisError,
  EffectScope,
  ForkScope,
  Inject,
  Lifecycle,
  MainScope,
  ReflectService,
  Registry,
  ScopeStatus,
  Service,
  createCallable,
  getTraceable,
  isBailed,
  isConstructor,
  isObject,
  isUnproxyable,
  joinPrototype,
  resolveConfig,
  symbols,
  withProps
});
//# sourceMappingURL=index.cjs.map
root.Cordis = module.exports;
})(globalThis);
