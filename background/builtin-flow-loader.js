// Builtin Flow Loader — loads exported flow and flow-group bundles packaged with the extension.
// Built-in flows are product templates for page automation, not model-provider
// endpoints or model aliases.
(function attachBuiltinFlowLoader(root, factory) {
  root.BuiltinFlowLoader = factory();
})(globalThis, function () {

  var INDEX_PATH = 'builtin-flows/index.json';
  var BUILTIN_META_PREFIX = '__builtin';
  var LEGACY_CDP_CLICK_TYPE = ['cdp', 'input', 'click'].join('.');

  function createBuiltinFlowLoader(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || (function () {});

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function migrateLegacyPageNodes(item) {
      if (!item || !Array.isArray(item.nodes)) return item;
      item.nodes.forEach(function (node) {
        if (!node || node.type !== LEGACY_CDP_CLICK_TYPE) return;
        node.type = 'clickElement';
        node.params = Object.assign({}, node.params || {});
        delete node.params.moveSteps;
      });
      return item;
    }

    function markBuiltin(item, section, entry, role) {
      item[BUILTIN_META_PREFIX] = true;
      item.__builtinSection = section;
      item.__builtinRole = role || '';
      item.__builtinFile = (entry && entry.file) || '';
      item.__builtinFlowId = (entry && entry.id) || '';
      item.__builtinLabel = (entry && entry.label) || '';
      item.__builtinHash = (entry && entry.hash) || '';
      return item;
    }

    function canReplaceWithBuiltin(existing) {
      if (!existing) return true;
      return existing.__builtin === true;
    }

    function upsertBuiltinItem(runtimeConfig, section, id, item, entry, role) {
      if (!runtimeConfig[section]) runtimeConfig[section] = {};
      if (!canReplaceWithBuiltin(runtimeConfig[section][id])) return false;
      runtimeConfig[section][id] = markBuiltin(section === 'flows' ? migrateLegacyPageNodes(clone(item)) : clone(item), section, entry, role);
      return true;
    }

    function resourceUrl(path) {
      return chrome.runtime.getURL(path);
    }

    function loadJson(path) {
      return fetch(resourceUrl(path), { cache: 'no-store' }).then(function (resp) {
        if (!resp.ok) throw new Error(path + ' 加载失败: HTTP ' + resp.status);
        return resp.json();
      });
    }

    function loadIndex() {
      return loadJson(INDEX_PATH).catch(function (err) {
        addLog('未加载内置流程索引: ' + err.message, { level: 'warn' });
        return { version: 1, flows: [], flowGroups: [] };
      });
    }

    function validateBundle(bundle, file) {
      if (!bundle || typeof bundle !== 'object') {
        throw new Error(file + ' 不是有效的内置导出包');
      }
      if (bundle.kind === 'pfa-flow' && bundle.flow && bundle.flow.id) {
        return bundle;
      }
      if (bundle.kind === 'pfa-flow-group' && bundle.flowGroup && bundle.flowGroup.id) {
        return bundle;
      }
      throw new Error(file + ' 不是有效的 pfa-flow / pfa-flow-group 导出包');
    }

    function loadBundles() {
      return loadIndex().then(function (index) {
        var flowEntries = (Array.isArray(index.flows) ? index.flows : []).map(function (entry) {
          return Object.assign({ kind: 'pfa-flow' }, entry || {});
        });
        var flowGroupEntries = (Array.isArray(index.flowGroups) ? index.flowGroups : []).map(function (entry) {
          return Object.assign({ kind: 'pfa-flow-group' }, entry || {});
        });
        var entries = flowEntries.concat(flowGroupEntries);
        var tasks = entries.map(function (entry) {
          var file = entry && entry.file;
          if (!file || /(^|\/)\.\.?($|\/)/.test(file)) {
            return Promise.resolve(null);
          }
          return loadJson('builtin-flows/' + file).then(function (bundle) {
            return { entry: entry, bundle: validateBundle(bundle, file) };
          }).catch(function (err) {
            addLog('内置流程加载失败: ' + err.message, { level: 'warn' });
            return null;
          });
        });
        return Promise.all(tasks).then(function (items) {
          return items.filter(Boolean);
        });
      });
    }

    function mergeBundle(runtimeConfig, item) {
      var bundle = item.bundle;

      Object.keys(bundle.pages || {}).forEach(function (id) {
        upsertBuiltinItem(runtimeConfig, 'pages', id, bundle.pages[id], item.entry, 'dependency');
      });

      Object.keys(bundle.scripts || {}).forEach(function (id) {
        upsertBuiltinItem(runtimeConfig, 'scripts', id, bundle.scripts[id], item.entry, 'dependency');
      });

      Object.keys(bundle.flows || {}).forEach(function (id) {
        var dependencyFlow = clone(bundle.flows[id]);
        if (!dependencyFlow.id) dependencyFlow.id = id;
        upsertBuiltinItem(runtimeConfig, 'flows', dependencyFlow.id, dependencyFlow, item.entry, 'dependency');
      });

      if (bundle.kind === 'pfa-flow') {
        var flow = clone(bundle.flow);
        upsertBuiltinItem(runtimeConfig, 'flows', flow.id, flow, item.entry, 'main');
      } else if (bundle.kind === 'pfa-flow-group') {
        var flowGroup = clone(bundle.flowGroup);
        upsertBuiltinItem(runtimeConfig, 'flowGroups', flowGroup.id, flowGroup, item.entry, 'main');
      }
    }

    function applyToConfig(config) {
      return loadBundles().then(function (items) {
        var runtimeConfig = clone(config || {});
        runtimeConfig.pages = runtimeConfig.pages || {};
        runtimeConfig.flows = runtimeConfig.flows || {};
        runtimeConfig.flowGroups = runtimeConfig.flowGroups || {};
        runtimeConfig.scripts = runtimeConfig.scripts || {};
        runtimeConfig.schedules = runtimeConfig.schedules || {};
        runtimeConfig.urlTriggers = Array.isArray(runtimeConfig.urlTriggers) ? runtimeConfig.urlTriggers : [];

        var flowCount = 0;
        var flowGroupCount = 0;
        for (var i = 0; i < items.length; i++) {
          mergeBundle(runtimeConfig, items[i]);
          if (items[i].bundle && items[i].bundle.kind === 'pfa-flow-group') flowGroupCount++;
          else flowCount++;
        }
        if (items.length) addLog('内置流程已加载: ' + flowCount + ' 个，内置流程组: ' + flowGroupCount + ' 个');
        return runtimeConfig;
      });
    }

    return {
      INDEX_PATH: INDEX_PATH,
      loadBundles: loadBundles,
      applyToConfig: applyToConfig,
      BUILTIN_META_PREFIX: BUILTIN_META_PREFIX,
    };
  }

  return { createBuiltinFlowLoader: createBuiltinFlowLoader };
});
