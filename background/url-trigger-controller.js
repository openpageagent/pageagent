// URL Trigger Controller - matches top-level navigations and starts one configured target.
(function attachUrlTriggerController(root, factory) {
  root.UrlTriggerController = factory();
})(globalThis, function () {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('UrlTriggerController missing dependency: ' + name);
    return value;
  }

  function requireChrome(value) {
    if (!value || typeof value !== 'object' || !value.tabs || typeof value.tabs.get !== 'function') {
      throw new Error('UrlTriggerController missing dependency: chrome.tabs.get');
    }
    return value;
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function triggerEntries(triggers) {
    var entries = [];
    function append(value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value);
    }
    if (Array.isArray(triggers)) {
      for (var index = 0; index < triggers.length; index++) {
        var descriptor = Object.getOwnPropertyDescriptor(triggers, String(index));
        if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) continue;
        append(descriptor.value);
      }
      return entries;
    }
    if (!triggers || typeof triggers !== 'object') return entries;
    Object.keys(triggers).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(triggers, key);
      if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return;
      append(descriptor.value);
    });
    return entries;
  }

  function triggerPattern(trigger) {
    var pattern = ownDataValue(trigger, 'urlPattern');
    if (pattern === undefined || pattern === null) pattern = ownDataValue(trigger, 'url');
    return String(pattern === undefined || pattern === null ? '' : pattern);
  }

  function createUrlTriggerController(deps) {
    deps = deps || {};
    var chrome = requireChrome(deps.chrome);
    var getConfig = requireFunction(deps.getConfig, 'getConfig');
    var startFlowRun = requireFunction(deps.startFlowRun, 'startFlowRun');
    var runFlowGroup = requireFunction(deps.runFlowGroup, 'runFlowGroup');
    var isFlowRunning = requireFunction(deps.isFlowRunning, 'isFlowRunning');
    var isFlowGroupRunning = requireFunction(deps.isFlowGroupRunning, 'isFlowGroupRunning');
    var addLog = requireFunction(deps.addLog, 'addLog');
    var pendingTargets = Object.create(null);

    function matchUrlPattern(url, pattern) {
      var target = String(url || '');
      var wildcard = String(pattern || '').trim();
      if (!target || !wildcard) return false;
      var escaped = wildcard.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp('^' + escaped + '$').test(target);
    }

    function findFirstMatchingTrigger(triggers, url) {
      var entries = triggerEntries(triggers);
      for (var i = 0; i < entries.length; i++) {
        var trigger = entries[i];
        if (ownDataValue(trigger, 'enabled') === false || !ownDataValue(trigger, 'flowId')) continue;
        if (matchUrlPattern(url, triggerPattern(trigger))) return trigger;
      }
      return null;
    }

    function resolveTarget(trigger) {
      var configuredId = String(trigger && trigger.flowId || '');
      if (configuredId.indexOf('flowGroup:') === 0) {
        return {
          kind: 'flowGroup',
          id: configuredId.slice(10),
          resultFlowId: configuredId,
          pendingKey: 'flowGroup:' + configuredId.slice(10),
        };
      }
      var flowId = configuredId.replace(/^user:/, '');
      return {
        kind: 'flow',
        id: flowId,
        resultFlowId: flowId,
        pendingKey: 'flow:' + flowId,
      };
    }

    function targetKindLabel(target) {
      return target.kind === 'flowGroup' ? '流程组' : '流程';
    }

    function targetIsBusy(target) {
      if (pendingTargets[target.pendingKey]) return true;
      try {
        return target.kind === 'flowGroup'
          ? !!isFlowGroupRunning(target.id)
          : !!isFlowRunning(target.id);
      } catch (_) {
        return false;
      }
    }

    function groupExists(config, flowGroupId) {
      var groups = config && config.flowGroups;
      if (!groups || typeof groups !== 'object' || !hasOwn(groups, flowGroupId)) return false;
      var group = groups[flowGroupId];
      return !!(group && typeof group === 'object' && !Array.isArray(group));
    }

    function errorMessage(error) {
      return error && error.message || String(error);
    }

    function failedStart(trigger, target, error) {
      var message = errorMessage(error);
      addLog('URL 触发' + targetKindLabel(target) + '失败 [' + target.id + ']: ' + message, { level: 'error' });
      return {
        matched: true,
        started: false,
        reason: 'start-failed',
        flowId: target.resultFlowId,
        triggerId: trigger.id || '',
        error: message,
      };
    }

    function startTarget(target, trigger, details, tab) {
      var runOptions = {
        entry: 'urlTrigger',
        ownerTabId: details.tabId || 0,
        originTabId: details.tabId || 0,
        originWindowId: tab && tab.windowId || 0,
        incognito: !!(tab && tab.incognito),
        urlTriggerId: trigger.id || '',
      };
      var triggerName = 'url:' + triggerPattern(trigger);
      if (target.kind === 'flowGroup') {
        runOptions.trigger = triggerName;
        return runFlowGroup(target.id, runOptions);
      }
      return startFlowRun(target.id, triggerName, runOptions);
    }

    function tabForNavigation(details) {
      return Promise.resolve(chrome.tabs.get(details.tabId)).then(function (tab) { return tab; }, function (error) {
        if (/(?:No tab with id|Invalid tab ID|tab(?:\s+|-)not found|no such tab)/i.test(String(error && error.message || error || ''))) return null;
        throw error;
      });
    }

    function handleNavigation(details) {
      details = details || {};
      if (details.frameId !== 0) return Promise.resolve({ matched: false, reason: 'subframe' });
      if (!details.url) return Promise.resolve({ matched: false, reason: 'missing-url' });

      return Promise.resolve().then(getConfig).then(function (config) {
        var trigger = findFirstMatchingTrigger(config && config.urlTriggers, details.url);
        if (!trigger) return { matched: false, reason: 'no-match' };

        var target = resolveTarget(trigger);
        var kindLabel = targetKindLabel(target);
        if (!target.id) return failedStart(trigger, target, new Error(kindLabel + '目标缺少 ID'));
        if (target.kind === 'flowGroup' && !groupExists(config, target.id)) {
          return failedStart(trigger, target, new Error('流程组不存在: ' + target.id));
        }
        if (targetIsBusy(target)) {
          addLog('URL 触发器匹配，但' + kindLabel + '已在运行，本次跳过: '
            + triggerPattern(trigger) + ' → ' + kindLabel + ' ' + target.id, { level: 'warn' });
          return {
            matched: true,
            started: false,
            reason: 'already-running',
            flowId: target.resultFlowId,
            triggerId: trigger.id || '',
          };
        }

        pendingTargets[target.pendingKey] = true;
        addLog('URL 触发器匹配: ' + triggerPattern(trigger) + ' → ' + kindLabel + ' ' + target.id, { level: 'info' });
        return tabForNavigation(details).then(function (tab) {
          return Promise.resolve().then(function () {
            return startTarget(target, trigger, details, tab);
          });
        }).then(function (result) {
          return {
            matched: true,
            started: true,
            flowId: target.resultFlowId,
            triggerId: trigger.id || '',
            runId: result && result.runId || '',
          };
        }).catch(function (err) {
          return failedStart(trigger, target, err);
        }).finally(function () {
          delete pendingTargets[target.pendingKey];
        });
      });
    }

    return {
      matchUrlPattern: matchUrlPattern,
      findFirstMatchingTrigger: findFirstMatchingTrigger,
      handleNavigation: handleNavigation,
    };
  }

  return { createUrlTriggerController: createUrlTriggerController };
});
