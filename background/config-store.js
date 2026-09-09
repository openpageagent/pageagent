// Config Store — 用户配置与运行历史的持久化（chrome.storage.local）
(function attachConfigStore(root, factory) {
  root.ConfigStore = factory();
})(globalThis, function () {

  var CONFIG_KEY = 'automation_config';
  var RUNS_KEY = 'automation_runs';
  var INCOGNITO_RUNS_KEY = 'automation_runs_incognito';
  var MAX_RUNS = 50;
  var VALID_SECTIONS = ['pages', 'flows', 'flowGroups', 'scripts', 'schedules', 'urlTriggers'];

  var DEFAULT_CONFIG = {
    version: 1,
    pages: {},
    flows: {},
    flowGroups: {},
    scripts: {},
    schedules: {},
    urlTriggers: [],
  };

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function hasOwnDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!(descriptor && !descriptor.get && !descriptor.set
      && Object.prototype.hasOwnProperty.call(descriptor, 'value'));
  }

  function flowRefText(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }

  function normalizedFlowRef(value) {
    return flowRefText(value).replace(/^user:/, '');
  }

  function storedFlowIdForDelete(config, requestedId) {
    var flows = ownDataValue(config, 'flows');
    var rawId = flowRefText(requestedId);
    var normalizedId = normalizedFlowRef(rawId);
    var candidates = [rawId, normalizedId, normalizedId ? 'user:' + normalizedId : ''];
    var seen = Object.create(null);
    for (var index = 0; index < candidates.length; index++) {
      var candidate = candidates[index];
      if (!candidate || seen[candidate]) continue;
      seen[candidate] = true;
      if (hasOwnDataValue(flows, candidate)) return candidate;
    }
    return normalizedId || rawId;
  }

  function createConfigStore(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var runReport = deps.runReport || globalThis.RunReport;
    var incognito = deps.incognito === true || (deps.incognito === undefined
      && !!(chrome && chrome.extension && chrome.extension.inIncognitoContext));
    var runsKey = incognito ? INCOGNITO_RUNS_KEY : RUNS_KEY;
    if (!runReport) throw new Error('RunReport 未加载');
    var configWriteQueue = Promise.resolve();
    var runsWriteQueue = Promise.resolve();

    function genId(prefix) {
      return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function sectionIdPrefix(section) {
      var prefixes = {
        pages: 'pa',
        flows: 'fl',
        flowGroups: 'fg',
        scripts: 'sc',
        schedules: 'sc',
      };
      return prefixes[section] || section.slice(0, 2);
    }

    var LEGACY_CDP_CLICK_TYPE = ['cdp', 'input', 'click'].join('.');

    function migrateLegacyFlowConfig(config) {
      var flows = config && config.flows;
      if (!flows || typeof flows !== 'object') return config;
      Object.keys(flows).forEach(function (flowId) {
        var flow = flows[flowId];
        if (!flow || !Array.isArray(flow.nodes)) return;
        var usedNodeIds = Object.create(null);
        flow.nodes.forEach(function (node, index) {
          if (!node || typeof node !== 'object') return;

          var baseNodeId = String(node.nodeId || node.id || ('n_migrated_' + (index + 1))).trim();
          if (!baseNodeId) baseNodeId = 'n_migrated_' + (index + 1);
          var nodeId = baseNodeId;
          var suffix = 2;
          while (usedNodeIds[nodeId]) nodeId = baseNodeId + '_' + suffix++;
          usedNodeIds[nodeId] = true;
          node.nodeId = nodeId;
          delete node.id;

          if (node.type === LEGACY_CDP_CLICK_TYPE) {
            node.type = 'clickElement';
            if (node.params === undefined || node.params === null) {
              node.params = {};
            } else if (typeof node.params === 'object' && !Array.isArray(node.params)) {
              node.params = Object.assign({}, node.params);
              delete node.params.moveSteps;
            }
          }

          if (!node.params || typeof node.params !== 'object' || Array.isArray(node.params)) node.params = {};
          var definition = globalThis.NodeTypes && typeof globalThis.NodeTypes.getType === 'function'
            ? globalThis.NodeTypes.getType(node.type)
            : null;
          (definition && Array.isArray(definition.params) ? definition.params : []).forEach(function (param) {
            var key = param && param.key;
            if (!key || node.params[key] !== undefined || node[key] === undefined) return;
            node.params[key] = node[key];
            delete node[key];
          });
        });

        if (flow.inputExample !== undefined && typeof flow.inputExample !== 'string') {
          if (flow.inputExample && typeof flow.inputExample === 'object') {
            try { flow.inputExample = JSON.stringify(flow.inputExample); }
            catch (_) { flow.inputExample = ''; }
          } else {
            flow.inputExample = '';
          }
        }
      });
      return config;
    }

    function ensureConfig(raw) {
      var config = Object.assign({}, DEFAULT_CONFIG, raw || {});
      for (var i = 0; i < VALID_SECTIONS.length; i++) {
        var section = VALID_SECTIONS[i];
        if (section === 'urlTriggers') {
          if (!Array.isArray(config[section])) config[section] = [];
        } else {
          if (!config[section] || typeof config[section] !== 'object') config[section] = {};
        }
      }
      delete config['sui' + 'tes'];
      return migrateLegacyFlowConfig(config);
    }

    function stripRuntimeMetadata(value) {
      if (Array.isArray(value)) return value.map(stripRuntimeMetadata);
      if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (key) {
          if (key.indexOf('__builtin') === 0) return;
          if (key === 'mcpValidation') return;
          out[key] = stripRuntimeMetadata(value[key]);
        });
        return out;
      }
      return value;
    }

    function getConfig() {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.get(CONFIG_KEY, function (result) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(ensureConfig(result[CONFIG_KEY]));
        });
      });
    }

    function writeConfig(config) {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.set({ [CONFIG_KEY]: config }, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(config);
        });
      });
    }

    function enqueueConfigWrite(operation) {
      var queued = configWriteQueue.then(operation, operation);
      configWriteQueue = queued.catch(function () {});
      return queued;
    }

    function saveConfig(config) {
      var sanitized = ensureConfig(stripRuntimeMetadata(config));
      return enqueueConfigWrite(function () {
        return writeConfig(sanitized);
      });
    }

    // 通用变更：{ op: 'upsert'|'delete', section, item|id }
    function mutate(payload) {
      payload = payload || {};
      var mutation = {
        op: payload.op,
        section: payload.section,
        id: payload.id,
        item: stripRuntimeMetadata(payload.item),
      };
      var op = mutation.op;
      var section = mutation.section;
      if (VALID_SECTIONS.indexOf(section) === -1) {
        return Promise.reject(new Error('无效的配置分区: ' + section));
      }
      return enqueueConfigWrite(function () {
        return getConfig().then(function (config) {
          if (op === 'upsert') {
            var item = mutation.item;
            if (section === 'urlTriggers') {
              // urlTriggers 是数组，整体替换
              if (!Array.isArray(item)) throw new Error('urlTriggers 需要数组');
              config.urlTriggers = item;
            } else {
              if (!item || typeof item !== 'object') throw new Error('upsert 缺少 item');
              item = stripRuntimeMetadata(item);
              if (!item.id) item.id = genId(sectionIdPrefix(section));
              item.updatedAt = Date.now();
              config[section][item.id] = item;
            }
          } else if (op === 'delete') {
            var id = mutation.id;
            if (!id) throw new Error('delete 缺少 id');
            if (section === 'urlTriggers') {
              config.urlTriggers = (config.urlTriggers || []).filter(function (trigger) {
                return trigger && String(trigger.id || '') !== String(id);
              });
            } else if (section === 'flows') {
              var storedFlowId = storedFlowIdForDelete(config, id);
              delete config.flows[storedFlowId];
            } else if (section === 'flowGroups') {
              delete config.flowGroups[id];
            } else {
              delete config[section][id];
            }
          } else {
            throw new Error('无效的操作: ' + op);
          }
          return writeConfig(config);
        });
      });
    }

    // --- 运行历史 ---

    function getRuns() {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.get(runsKey, function (result) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          var runs = Array.isArray(result[runsKey]) ? result[runsKey] : [];
          resolve(runs.map(function (run) {
            return runReport.normalizeStoredRecord(run);
          }).filter(function (run) { return !!run; }));
        });
      });
    }

    function saveRuns(runs) {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.set({ [runsKey]: runs }, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(runs);
        });
      });
    }

    function mutateRuns(mutator) {
      // 运行历史是 read-modify-write；父流程组和子流程结束会并发写入，必须串行避免旧快照覆盖新状态。
      runsWriteQueue = runsWriteQueue.catch(function () {}).then(function () {
        return getRuns().then(function (runs) {
          var nextRuns = mutator(runs || []) || [];
          return saveRuns(nextRuns);
        });
      });
      return runsWriteQueue;
    }

    function storedRunId(run) {
      return String(run && (run.id || run.runId) || '').trim();
    }

    function trimRunsForStorage(runs) {
      if (!Array.isArray(runs) || runs.length <= MAX_RUNS) return runs;
      var activeIndexes = [];
      var finishedIndexes = [];
      runs.forEach(function (run, index) {
        if (runReport.isActiveStatus(run && run.status)) activeIndexes.push(index);
        else finishedIndexes.push(index);
      });
      var keep = {};
      var activeToKeep = activeIndexes.slice(-MAX_RUNS);
      var finishedSlots = Math.max(0, MAX_RUNS - activeToKeep.length);
      var finishedToKeep = finishedSlots > 0 ? finishedIndexes.slice(-finishedSlots) : [];
      activeToKeep.concat(finishedToKeep).forEach(function (index) { keep[index] = true; });
      return runs.filter(function (_run, index) { return keep[index] === true; });
    }

    // run: { id, flowId, flowLabel, trigger, startedAt, status }
    function appendRun(run) {
      try {
        run = runReport.normalizeRecord(run);
      } catch (error) {
        return Promise.reject(error);
      }
      return mutateRuns(function (runs) {
        var duplicate = runs.some(function (existing) {
          return storedRunId(existing) === run.id;
        });
        if (duplicate) throw new Error('运行报告已存在: ' + run.id);
        runs.push(run);
        return trimRunsForStorage(runs);
      }).then(function () { return run; });
    }

    function updateRun(runId, patch) {
      runId = String(runId || '').trim();
      try {
        patch = runReport.normalizePatch(patch || {});
      } catch (error) {
        return Promise.reject(error);
      }
      var outcome = null;
      return mutateRuns(function (runs) {
        for (var i = runs.length - 1; i >= 0; i--) {
          if (storedRunId(runs[i]) === runId) {
            outcome = runReport.applyPatch(runs[i], patch);
            if (outcome.updated) {
              runs.splice(i, 1);
              runs.push(outcome.record);
            }
            break;
          }
        }
        if (!outcome) throw runReport.createNotFoundError(runId);
        return trimRunsForStorage(runs);
      }).then(function () {
        return outcome;
      });
    }

    function isActiveRunStatus(status) {
      return runReport.isActiveStatus(status);
    }

    function shouldPreserveRun(run, options) {
      options = options || {};
      return options.preserveActive !== false && isActiveRunStatus(run && run.status);
    }

    function deleteRun(runId, options) {
      var removed = 0;
      options = options || {};
      return mutateRuns(function (runs) {
        return trimRunsForStorage((runs || []).filter(function (run) {
          var matches = !!(run && (run.id === runId || run.runId === runId));
          if (!matches) return true;
          if (shouldPreserveRun(run, options)) return true;
          removed += 1;
          return false;
        }));
      }).then(function () {
        return { removed: removed };
      });
    }

    function clearRunsBefore(timestampMs, options) {
      var removed = 0;
      var cutoff = Number(timestampMs);
      options = options || {};
      if (!isFinite(cutoff) || cutoff <= 0) return Promise.resolve({ removed: 0 });
      return mutateRuns(function (runs) {
        return trimRunsForStorage((runs || []).filter(function (run) {
          if (shouldPreserveRun(run, options)) return true;
          var startedAt = Number(run && run.startedAt);
          if (!isFinite(startedAt) || startedAt <= 0) return true;
          if (startedAt < cutoff) {
            removed += 1;
            return false;
          }
          return true;
        }));
      }).then(function () {
        return { removed: removed, cutoff: cutoff };
      });
    }

    function clearRuns(options) {
      var removed = 0;
      options = options || {};
      return mutateRuns(function (runs) {
        return trimRunsForStorage((runs || []).filter(function (run) {
          if (shouldPreserveRun(run, options)) return true;
          removed += 1;
          return false;
        }));
      }).then(function () {
        return { removed: removed };
      });
    }

    function estimateUtf8Bytes(value) {
      var text = '';
      try {
        text = JSON.stringify(value === undefined ? null : value);
      } catch (_) {
        text = String(value === undefined || value === null ? '' : value);
      }
      try {
        return new TextEncoder().encode(text).length;
      } catch (_) {
        return text.length * 2;
      }
    }

    function getRunStorageBytes() {
      return new Promise(function (resolve, reject) {
        if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.getBytesInUse !== 'function') {
          getRuns().then(function (runs) {
            resolve(estimateUtf8Bytes({ runs: runs }));
          }).catch(reject);
          return;
        }
        chrome.storage.local.getBytesInUse(runsKey, function (bytes) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(Number(bytes) || 0);
        });
      });
    }

    return {
      CONFIG_KEY: CONFIG_KEY,
      RUNS_KEY: runsKey,
      genId: genId,
      ensureConfig: ensureConfig,
      getConfig: getConfig,
      saveConfig: saveConfig,
      mutate: mutate,
      getRuns: getRuns,
      getRunStorageBytes: getRunStorageBytes,
      appendRun: appendRun,
      updateRun: updateRun,
      deleteRun: deleteRun,
      clearRunsBefore: clearRunsBefore,
      clearRuns: clearRuns,
    };
  }

  return { createConfigStore: createConfigStore };
});
