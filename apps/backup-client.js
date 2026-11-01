(function (root) {
  'use strict';
  var C = root.AppContract, workers = new Set();
  function work(operation, input) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker(chrome.runtime.getURL('apps/backup-worker.js')); workers.add(worker);
      function close() { worker.terminate(); workers.delete(worker); }
      worker.onmessage = function (event) { close(); if (event.data.error) reject(Object.assign(new Error(event.data.error.message), event.data.error)); else resolve(event.data.result); };
      worker.onerror = function (event) { close(); reject(new Error('应用备份 Worker 失败: ' + event.message)); };
      try { worker.postMessage({ operation: operation, input: input, incognito: chrome.extension.inIncognitoContext }); }
      catch (error) { close(); reject(error); }
    });
  }
  function manage(operation, input) { return chrome.runtime.sendMessage({ type: 'APP_MANAGE', operation: operation, input: input }).then(function (response) { if (response.error) throw Object.assign(new Error(response.error.message), response.error); return response.result; }); }
  function moduleId(kind) { return { 'flow-groups': 'flowGroups', 'model-services': 'modelSettings', connections: 'mcpSettings' }[kind] || kind; }
  function keyOf(item) { return item.kind === 'model-services' ? 'service:' + item.id : item.id; }
  function controlItem(item) {
    var slots = {};
    Object.keys(item.slots).forEach(function (slot) { slots[slot] = Object.assign({}, item.slots[slot], { html: '', css: '', javascript: '', themeCss: '' }); });
    return { appId: item.appId, name: item.name, slug: item.slug, slots: slots, generationScope: item.generationScope };
  }
  function dependencyModules(modules) {
    var selected = {};
    ['flows', 'flowGroups', 'scripts', 'pages', 'knowledge', 'assistants', 'modelSettings', 'mcpSettings'].forEach(function (key) { if (modules[key]) selected[key] = modules[key]; });
    if (modules.apps) {
      selected.apps = { items: Object.create(null) };
      Object.keys(modules.apps.items).forEach(function (id) { var item = modules.apps.items[id]; selected.apps.items[id] = { appId: item.appId, name: item.name, slots: item.slots }; });
    }
    return selected;
  }
  async function exportApps(ids, includeData) {
    var modules = { apps: { label: '应用', source: '/apps', items: Object.create(null), order: [] } }, queue = ids.slice(), seen = new Set(), bytes = 0, limit = 50 * 1024 * 1024;
    async function account(value) {
      bytes += await work('measure', { value: value });
      if (bytes > limit) throw new Error('所选应用及依赖合计超过 50 MiB JSON 备份上限，请按应用分包或取消业务数据');
    }
    while (queue.length) {
      var appId = queue.shift(); if (seen.has(appId)) continue; seen.add(appId);
      if (bytes >= limit) throw new Error('所选应用及依赖已达到 50 MiB JSON 备份上限，请按应用分包');
      var item = await work('export', { appId: appId, includeData: includeData, limit: limit - bytes });
      bytes += item.exportBytes;
      var declarations = Object.values(item.slots).flatMap(C.codeDependencies);
      var dependencies = await manage('dependencies', { dependencies: declarations });
      item.required = [];
      for (var dependency of dependencies) {
        var kind = moduleId(dependency.kind), id = keyOf(dependency);
        item.required.push({ uri: dependency.uri, module: kind, id: id, fingerprint: dependency.fingerprint, builtin: dependency.builtin });
        if (dependency.builtin) continue;
        if (kind === 'apps') { queue.push(dependency.id); continue; }
        if (kind === 'modelSettings') {
          if (!modules[kind]) modules[kind] = { label: '模型配置', value: { services: [], agentSettings: {} } };
          if (!modules[kind].value.services.some(function (service) { return service.id === dependency.id; })) {
            var service = structuredClone(dependency.value);
            delete service.apiKey; delete service.headers; delete service.customHeaders; delete service.authorization;
            await account(service); modules[kind].value.services.push(service);
          }
        } else {
          if (!modules[kind]) modules[kind] = { label: kind, source: '/' + dependency.kind, items: Object.create(null), order: [] };
          if (!Object.prototype.hasOwnProperty.call(modules[kind].items, id)) { await account(dependency.value); modules[kind].items[id] = dependency.value; modules[kind].order.push(id); }
        }
      }
      modules.apps.items[appId] = item; modules.apps.order.push(appId);
    }
    await verifyExport(modules);
    return modules;
  }
  async function verifyExport(modules) {
    if (!modules.apps) return;
    for (var item of Object.values(modules.apps.items)) {
      await manage('verify-export', { stamps: [{ appId: item.appId, stamp: item.exportStamp }], dependencies: (item.required || []).map(function (dep) { return { uri: dep.uri, fingerprint: dep.fingerprint }; }) });
    }
  }
  function selected(pkg, plan) { return pkg.modules.apps && plan.apps ? (plan.apps === null ? pkg.modules.apps.order : plan.apps) : plan.apps === null && pkg.modules.apps ? pkg.modules.apps.order : []; }
  function assertSelectedDependencies(pkg, plan) {
    selected(pkg, plan).forEach(function (id) {
      var app = pkg.modules.apps.items[id];
      (app.required || []).forEach(function (dependency) {
        if (dependency.builtin) return;
        if (!Object.prototype.hasOwnProperty.call(plan, dependency.module) || plan[dependency.module] !== null && !plan[dependency.module].includes(dependency.id)) throw new Error(app.name + ' 需要同时选择依赖 ' + dependency.uri);
      });
    });
  }
  async function preflight(pkg, plan, scopes, rebindConnections, confirmAction) {
    assertSelectedDependencies(pkg, plan);
    var order = importOrder(pkg, plan);
    var aliases = new Set();
    order.forEach(function (appId) {
      var slug = C.slug(pkg.modules.apps.items[appId].slug);
      if (!slug) return;
      if (aliases.has(slug)) throw C.error('ADDRESS_CONFLICT', '待导入的应用别名重复：' + slug);
      aliases.add(slug);
    });
    var expected = Object.create(null), reuse = new Map();
    for (var appId of order) {
      var item = pkg.modules.apps.items[appId], scope = scopes && scopes[appId] || item.generationScope;
      if (item.appId !== appId) throw new Error('应用包的条目 ID 与 appId 不一致：' + appId);
      await work('validate', { item: item, scope: scope });
      var result = await manage('preflight-import', { item: controlItem(item), modules: dependencyModules(pkg.modules), scope: scope, plan: plan, rebindConnections: rebindConnections === true });
      if (result.conflicts.length && (!confirmAction || !await confirmAction('以下应用或共享依赖内容不同，是否覆盖？\n' + result.conflicts.join('\n')))) throw new Error('已取消冲突导入，尚未写入');
      expected[appId] = { revision: result.revision, dataRevision: result.dataRevision, bindings: result.bindings };
      if (rebindConnections) Object.keys(item.slots).forEach(function (slot) {
        item.slots[slot].dependencies = result.bindings[slot]; item.slots[slot].actions = result.actions[slot];
      });
      (result.reuse || []).forEach(function (item) { reuse.set(item.module + ':' + item.id, item); });
    }
    // The resolved closure can expose app cycles hidden behind Flow dependencies.
    importOrder(pkg, plan, expected);
    return { revisions: expected, reuse: Array.from(reuse.values()) };
  }
  function importOrder(pkg, plan, expected) {
    var ids = new Set(selected(pkg, plan)), visiting = new Set(), done = new Set(), ordered = [];
    function visit(id) {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error('应用依赖形成循环，无法逐应用提交，请先解除循环绑定：' + Array.from(visiting).concat(id).join(' → '));
      visiting.add(id);
      var item = pkg.modules.apps.items[id];
      var references = expected && expected[id] ? Object.values(expected[id].bindings).flat() : Object.values(item.slots).flatMap(C.codeDependencies);
      references.forEach(function (dependency) {
        var match = /^\/apps\/([^/]+)$/.exec(dependency.uri);
        if (match && ids.has(decodeURIComponent(match[1]))) visit(decodeURIComponent(match[1]));
      });
      visiting.delete(id); done.add(id); ordered.push(id);
    }
    ids.forEach(visit); return ordered;
  }
  async function importApps(pkg, plan, scopes, expected, idMap) {
    var completed = [], order = importOrder(pkg, plan, expected);
    for (var appId of order) {
      try {
        var original = pkg.modules.apps.items[appId], item = Object.assign({}, original, { slots: {} });
        var scope = scopes && scopes[appId] || item.generationScope;
        var control = controlItem(original); control.generationScope = scope;
        Object.keys(control.slots).forEach(function (slot) { control.slots[slot].dependencies = expected[appId].bindings[slot]; });
        var remapped = await manage('remap-import', { item: control, idMap: idMap || {}, modules: dependencyModules(pkg.modules), committedApps: completed });
        Object.keys(original.slots).forEach(function (slot) {
          item.slots[slot] = Object.assign({}, original.slots[slot], { dependencies: remapped.slots[slot].dependencies, actions: remapped.slots[slot].actions });
        });
        var result = await work('import', { item: item, scope: scope, expected: expected[appId] });
        completed.push(appId);
        // Later applications compare against the dependency that was actually
        // committed, including any structured assistant-ID remapping.
        pkg.modules.apps.items[appId] = item;
        await manage('imported', result);
      } catch (error) {
        var unfinished = order.filter(function (id) { return !completed.includes(id); });
        error.message += '；已提交应用：' + (completed.join('、') || '无') + '；未提交应用：' + (unfinished.join('、') || '无');
        error.completed = completed.map(function (id) { return 'apps:' + id; });
        error.failures = unfinished.map(function (id) { return { id: id, error: id === appId ? error.message : '前置应用未完成，本项尚未写入' }; });
        throw error;
      }
    }
    return { count: completed.length, completed: completed };
  }
  window.addEventListener('pagehide', function () { workers.forEach(function (worker) { worker.terminate(); }); workers.clear(); });
  root.AppBackup = Object.freeze({ work: work, exportApps: exportApps, verifyExport: verifyExport, preflight: preflight, importApps: importApps, assertSelectedDependencies: assertSelectedDependencies, selected: selected });
})(globalThis);
