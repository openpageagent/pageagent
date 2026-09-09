// Scheduler — 基于 chrome.alarms 的定时任务调度 + 页面自动刷新/保活
// alarm 命名: pfa-sched:<runtimeScope>:<schedId> 等；split incognito 下运行态互不覆盖。
(function attachScheduler(root, factory) {
  root.Scheduler = factory();
})(globalThis, function () {

  var SCHED_BASE_PREFIX = 'pfa-sched:';
  var REFRESH_BASE_PREFIX = 'pfa-refresh:';
  var KEEPALIVE_BASE_PREFIX = 'pfa-keepalive:';
  var CALENDAR_TRIGGER_GRACE_MS = 5 * 60 * 1000;

  function createScheduler(deps) {
    deps = deps || {};
    var runtimeScope = deps.runtimeScope === 'incognito' ? 'incognito' : 'regular';
    var SCHED_PREFIX = SCHED_BASE_PREFIX + runtimeScope + ':';
    var REFRESH_PREFIX = REFRESH_BASE_PREFIX + runtimeScope + ':';
    var KEEPALIVE_PREFIX = KEEPALIVE_BASE_PREFIX + runtimeScope + ':';
    var chrome = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || (function () {});
    var getConfig = deps.getConfig || (function () { return { schedules: {}, pages: {} }; });
    var isFlowRunning = deps.isFlowRunning || (function () { return false; });
    var startFlowRun = deps.startFlowRun || (function () {});
    var startFlowGroupRun = deps.startFlowGroupRun || (function () { return Promise.reject(new Error('FlowGroup 调度未接线')); });
    var isFlowGroupRunning = deps.isFlowGroupRunning || (function () { return false; });
    var startConversation = deps.startConversation || (function () { return Promise.reject(new Error('对话调度未接线')); });
    var isConversationScheduleRunning = deps.isConversationScheduleRunning || (function () { return false; });
    var getTabId = deps.getTabId || (function () { return null; });
    var execPageKeepAlive = deps.execPageKeepAlive || (function () { return Promise.resolve(); });
    var syncPageKeepAliveState = deps.syncPageKeepAliveState || (function () { return Promise.resolve(); });
    var isTabRunning = deps.isTabRunning || (function () { return false; });
    var pageAutomation = deps.pageAutomation;
    if (!pageAutomation || !pageAutomation.action || typeof pageAutomation.action.act !== 'function') {
      throw new Error('Scheduler requires PageAutomationRuntime');
    }
    var activeConversationSchedules = Object.create(null);
    var activeFlowStarts = Object.create(null);

    function isLegacyAlarmName(name, basePrefix) {
      if (name.indexOf(basePrefix) !== 0) return false;
      var suffix = name.slice(basePrefix.length);
      return suffix.indexOf('regular:') !== 0 && suffix.indexOf('incognito:') !== 0;
    }

    // --- 计算 daily / cron 触发的下次时刻 ---

    function nextDailyTime(timeStr) {
      var text = String(timeStr || '08:00').trim();
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error('每天固定时间必须是 HH:mm');
      var parts = text.split(':');
      var hours = parseInt(parts[0], 10);
      var minutes = parseInt(parts[1], 10);
      var next = new Date();
      next.setHours(hours, minutes, 0, 0);
      if (next.getTime() <= Date.now()) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }

    function normalizeCronExpression(expression) {
      var text = String(expression || '').trim().replace(/\s+/g, ' ');
      var parts = text ? text.split(' ') : [];
      if (parts.length !== 5) throw new Error('cron 表达式需要 5 段: 分 时 日 月 周');
      return text;
    }

    function cronConstructor() {
      var ctor = deps.Cron || globalThis.Cron;
      if (ctor && typeof ctor.Cron === 'function') ctor = ctor.Cron;
      if (typeof ctor !== 'function') throw new Error('Cron 解析库未加载');
      return ctor;
    }

    function createCronExpression(expression) {
      var text = normalizeCronExpression(expression);
      try {
        return new (cronConstructor())(text, { paused: true, mode: '5-part' });
      } catch (err) {
        throw new Error('cron 表达式无效: ' + (err && err.message || err));
      }
    }

    function nextCronTime(expression, afterMs) {
      var after = Number(afterMs);
      if (!isFinite(after)) after = Date.now();
      var next = createCronExpression(expression).nextRun(new Date(after).toISOString());
      if (!next || !isFinite(next.getTime())) throw new Error('未来找不到 cron 下次触发时间');
      return next.getTime();
    }

    function validateCronExpression(expression) {
      nextCronTime(expression);
      return true;
    }

    function triggerForSchedule(sched) {
      var trigger = Object.assign({}, sched && sched.trigger || {});
      if (!trigger.kind && sched && sched.cronExpression) {
        trigger.kind = 'cron';
        trigger.expression = sched.cronExpression;
      }
      if (!trigger.kind) trigger.kind = 'interval';
      return trigger;
    }

    function scheduleTaskKind(sched) {
      var task = sched && sched.task || {};
      var kind = String((sched && (sched.taskType || sched.targetKind)) || task.kind || task.type || '').trim();
      if (!kind) {
        var conversationHint = sched && (sched.assistantId || sched.message || sched.prompt)
          || task.assistantId || task.message;
        var flowGroupHint = sched && (sched.flowGroupId || sched.groupId)
          || task.flowGroupId || task.groupId;
        kind = conversationHint ? 'conversation' : (flowGroupHint ? 'flowGroup' : 'flow');
      }
      if (kind === 'conversation') return 'conversation';
      return kind === 'flowGroup' || kind === 'flow-group' ? 'flowGroup' : 'flow';
    }

    function scheduleFlowId(sched) {
      var task = sched && sched.task || {};
      return String((sched && sched.flowId) || task.flowId || '').replace(/^user:/, '');
    }

    function scheduleFlowGroupId(sched) {
      var task = sched && sched.task || {};
      return String((sched && (sched.flowGroupId || sched.groupId)) || task.flowGroupId || task.groupId || '').replace(/^flowGroup:/, '');
    }

    function scheduleAssistantId(sched) {
      var task = sched && sched.task || {};
      return String((sched && sched.assistantId) || task.assistantId || '').trim();
    }

    function scheduleMessage(sched) {
      var task = sched && sched.task || {};
      return String((sched && (sched.message || sched.prompt || sched.input)) || task.message || task.prompt || task.input || '').trim();
    }

    function scheduleRunnable(sched) {
      if (scheduleTaskKind(sched) === 'conversation') return !!(scheduleAssistantId(sched) && scheduleMessage(sched));
      if (scheduleTaskKind(sched) === 'flowGroup') return !!scheduleFlowGroupId(sched);
      return !!scheduleFlowId(sched);
    }

    function calendarTriggerLateness(trigger, fireTime) {
      if (!trigger || (trigger.kind !== 'daily' && trigger.kind !== 'cron')) return 0;
      var scheduledTime = Number(fireTime);
      if (!isFinite(scheduledTime) || scheduledTime <= 0) return 0;
      return Math.max(0, Date.now() - scheduledTime);
    }

    function createAlarm(name, alarmInfo, failureMessage) {
      var created;
      try {
        created = chrome.alarms.create(name, alarmInfo);
      } catch (err) {
        addLog(failureMessage + ': ' + (err && err.message || err), { level: 'warn' });
        return Promise.resolve(false);
      }
      return Promise.resolve(created).then(function () {
        return true;
      }).catch(function (err) {
        addLog(failureMessage + ': ' + (err && err.message || err), { level: 'warn' });
        return false;
      });
    }

    function createAlarmForSchedule(sched) {
      var name = SCHED_PREFIX + sched.id;
      var trigger = triggerForSchedule(sched);
      try {
        if (trigger.kind === 'interval') {
          var minutes = Math.max(1, Number(trigger.minutes) || 30);
          return createAlarm(name, { periodInMinutes: minutes, delayInMinutes: minutes }, '定时任务 [' + (sched.label || sched.id) + '] 未创建 alarm');
        } else if (trigger.kind === 'daily') {
          return createAlarm(name, { when: nextDailyTime(trigger.time) }, '定时任务 [' + (sched.label || sched.id) + '] 未创建 alarm');
        } else if (trigger.kind === 'cron') {
          var expression = trigger.expression || trigger.cron || sched.cronExpression || '';
          return createAlarm(name, { when: nextCronTime(expression) }, '定时任务 [' + (sched.label || sched.id) + '] 未创建 alarm');
        } else {
          throw new Error('未知触发方式: ' + trigger.kind);
        }
      } catch (err) {
        addLog('定时任务 [' + (sched.label || sched.id) + '] 未创建 alarm: ' + (err && err.message || err), { level: 'warn' });
        return Promise.resolve(false);
      }
    }

    // --- 同步 alarms 与配置 ---

    function syncAlarms(config) {
      return chrome.alarms.getAll().then(function (alarms) {
        var clears = [];
        for (var i = 0; i < alarms.length; i++) {
          var name = alarms[i].name;
          if (name.indexOf(SCHED_PREFIX) === 0
              || name.indexOf(REFRESH_PREFIX) === 0
              || name.indexOf(KEEPALIVE_PREFIX) === 0
              || isLegacyAlarmName(name, SCHED_BASE_PREFIX)
              || isLegacyAlarmName(name, REFRESH_BASE_PREFIX)
              || isLegacyAlarmName(name, KEEPALIVE_BASE_PREFIX)) {
            clears.push(chrome.alarms.clear(name));
          }
        }
        return Promise.all(clears);
      }).then(function () {
        var schedIds = Object.keys(config.schedules || {});
        var created = 0;
        var creations = [];
        for (var i = 0; i < schedIds.length; i++) {
          var sched = config.schedules[schedIds[i]];
          if (!sched.enabled || !scheduleRunnable(sched)) continue;
          creations.push(createAlarmForSchedule(sched).then(function (ok) {
            if (ok) created++;
          }));
        }

        var pageIds = Object.keys(config.pages || {});
        var refreshes = 0;
        var keepAlives = 0;
        for (var j = 0; j < pageIds.length; j++) {
          var page = config.pages[pageIds[j]];
          var refreshMinutes = Number(page.autoRefreshMinutes) || 0;
          if (refreshMinutes > 0) {
            creations.push(createAlarm(REFRESH_PREFIX + page.id, {
              periodInMinutes: Math.max(1, refreshMinutes),
              delayInMinutes: Math.max(1, refreshMinutes),
            }, '页面 [' + (page.label || page.id) + '] 未创建自动刷新 alarm').then(function (ok) {
              if (ok) refreshes++;
            }));
          }
          var keepAlive = page.keepAlive || {};
          var keepAliveMinutes = Number(keepAlive.intervalMinutes) || 0;
          if (keepAlive.enabled && keepAliveMinutes > 0) {
            creations.push(createAlarm(KEEPALIVE_PREFIX + page.id, {
              periodInMinutes: Math.max(1, keepAliveMinutes),
              delayInMinutes: Math.max(1, Math.min(keepAliveMinutes, 1)),
            }, '页面 [' + (page.label || page.id) + '] 未创建保活 alarm').then(function (ok) {
              if (ok) keepAlives++;
            }));
          }
        }
        return Promise.all(creations).then(function () {
          return Promise.resolve().then(function () { return syncPageKeepAliveState(config); });
        }).then(function () {
          addLog('定时任务已同步: ' + created + ' 个调度, ' + refreshes + ' 个页面自动刷新, ' + keepAlives + ' 个页面保活');
        });
      });
    }

    // --- alarm 触发处理 ---

    function handleScheduleAlarm(schedId, fireTime) {
      return Promise.resolve().then(getConfig).then(function (config) {
        var sched = config.schedules && config.schedules[schedId];
        if (!sched || !sched.enabled) {
          chrome.alarms.clear(SCHED_PREFIX + schedId);
          return;
        }

        var trigger = triggerForSchedule(sched);
        var taskKind = scheduleTaskKind(sched);

        // daily / cron 为一次性 alarm，触发后重建下次
        var rescheduled = trigger.kind === 'daily' || trigger.kind === 'cron'
          ? createAlarmForSchedule(sched)
          : Promise.resolve(true);
        var lateness = calendarTriggerLateness(trigger, fireTime);
        if (lateness > CALENDAR_TRIGGER_GRACE_MS) {
          return rescheduled.then(function () {
            addLog('定时任务 [' + (sched.label || schedId) + '] 的触发时刻已错过 '
              + Math.floor(lateness / 60000) + ' 分钟，本次不补跑', { level: 'warn' });
          });
        }

        if (taskKind === 'conversation') {
          var conversationBusy = !!activeConversationSchedules[schedId];
          if (!conversationBusy) activeConversationSchedules[schedId] = true;
          var durableBusy = conversationBusy ? Promise.resolve(true) : Promise.resolve().then(function () {
            return isConversationScheduleRunning(schedId);
          }).catch(function (error) {
            addLog('定时对话运行状态检查失败 [' + (sched.label || schedId) + ']: ' + (error && error.message || error), { level: 'warn' });
            return false;
          });
          return Promise.all([rescheduled, durableBusy]).then(function (values) {
            if (values[1]) {
              addLog('定时任务 [' + (sched.label || schedId) + '] 触发，但该对话仍在运行，本次跳过', { level: 'warn' });
              return;
            }
            addLog('定时对话触发: ' + (sched.label || schedId));
            return Promise.resolve().then(function () {
              return startConversation(sched, 'schedule:' + schedId, {
                entry: 'schedule', scheduleId: schedId,
                fireTime: Math.max(0, Math.floor(Number(fireTime) || Date.now())),
              });
            }).catch(function (err) {
              addLog('定时对话失败 [' + (sched.label || schedId) + ']: ' + (err && err.message || err), { level: 'error' });
            });
          }).finally(function () {
            if (!conversationBusy) delete activeConversationSchedules[schedId];
          });
        }

        var flowGroupTask = taskKind === 'flowGroup';
        var flowId = flowGroupTask ? scheduleFlowGroupId(sched) : scheduleFlowId(sched);
        var activeKey = (flowGroupTask ? 'flowGroup:' : 'flow:') + flowId;
        var flowBusy = !!activeFlowStarts[activeKey] || (flowGroupTask ? isFlowGroupRunning(flowId) : isFlowRunning(flowId));
        if (!flowBusy) activeFlowStarts[activeKey] = true;
        return rescheduled.then(function () {
          if (flowBusy) {
            addLog('定时任务 [' + (sched.label || schedId) + '] 触发，但该流程已在运行，本次跳过', { level: 'warn' });
            return;
          }
          addLog('定时任务触发: ' + (sched.label || schedId));
          return Promise.resolve().then(function () {
            return flowGroupTask
              ? startFlowGroupRun(flowId, { trigger: 'schedule:' + schedId, entry: 'schedule', scheduleId: schedId, forceCdpKeepAlive: true })
              : startFlowRun(flowId, 'schedule:' + schedId, { entry: 'schedule', scheduleId: schedId, forceCdpKeepAlive: true });
          }).catch(function (err) {
            addLog('定时任务启动失败 [' + (sched.label || schedId) + ']: ' + (err && err.message || err), { level: 'error' });
          });
        }).finally(function () {
          if (!flowBusy) delete activeFlowStarts[activeKey];
        });
      });
    }

    function handleRefreshAlarm(pageId) {
      return Promise.resolve().then(getConfig).then(function (config) {
        var page = config.pages && config.pages[pageId];
        if (!page || !(Number(page.autoRefreshMinutes) > 0)) {
          chrome.alarms.clear(REFRESH_PREFIX + pageId);
          return;
        }
        var tabId = getTabId('page:' + pageId);
        if (!tabId) return; // 页面未打开则不刷新
        if (isTabRunning(tabId)) {
          addLog('自动刷新跳过运行中的页面: ' + (page.label || page.url) + ' tabId=' + tabId);
          return;
        }
        return chrome.tabs.get(tabId).then(function (tab) { return tab; }, function (error) {
          if (/(?:No tab with id|Invalid tab ID|tab(?:\s+|-)not found|no such tab)/i.test(String(error && error.message || error || ''))) return null;
          throw error;
        }).then(function (tab) {
          if (!tab) return;
          addLog('自动刷新页面: ' + (page.label || page.url));
          return pageAutomation.action.act({
            source: 'flow',
            owner: 'Scheduler:auto-refresh:' + pageId,
            tabId: tabId,
            kind: 'reload',
            input: {},
            timeoutMs: 30000,
          }).then(function (result) {
            if (result && result.receipt && result.receipt.status !== 'failed') return result.receipt;
            var error = new Error(result && result.receipt && result.receipt.verification && result.receipt.verification.reason || '自动刷新失败');
            error.receipt = result && result.receipt || null;
            throw error;
          });
        });
      });
    }

    function handleKeepAliveAlarm(pageId) {
      return Promise.resolve().then(getConfig).then(function (config) {
        var page = config.pages && config.pages[pageId];
        var keepAlive = page && page.keepAlive || {};
        if (!page || !keepAlive.enabled || !(Number(keepAlive.intervalMinutes) > 0)) {
          chrome.alarms.clear(KEEPALIVE_PREFIX + pageId);
          return;
        }
        return execPageKeepAlive(pageId, page).then(function (result) {
          if (!result || result.skipped) return;
          var label = page.label || page.name || page.url || pageId;
          var bits = [];
          if (result.heartbeat) bits.push('心跳 ' + result.heartbeat.status);
          if (result.activity && result.activity.sent) bits.push('活动');
          if (result.locked) bits.push('检测到锁屏');
          if (result.versionChanged) bits.push('版本变化');
          if (result.reloaded) bits.push('已刷新');
          addLog('页面保活: ' + label + (bits.length ? ' (' + bits.join(', ') + ')' : ''));
        }).catch(function (err) {
          addLog('页面保活失败 [' + (page.label || pageId) + ']: ' + (err && err.message || err), { level: 'warn' });
        });
      });
    }

    function handleAlarm(alarm) {
      var name = alarm.name || '';
      if (name.indexOf(SCHED_PREFIX) === 0) {
        return handleScheduleAlarm(name.slice(SCHED_PREFIX.length), alarm.scheduledTime);
      }
      if (name.indexOf(REFRESH_PREFIX) === 0) {
        return handleRefreshAlarm(name.slice(REFRESH_PREFIX.length));
      }
      if (name.indexOf(KEEPALIVE_PREFIX) === 0) {
        return handleKeepAliveAlarm(name.slice(KEEPALIVE_PREFIX.length));
      }
    }

    function getStatus() {
      return chrome.alarms.getAll().then(function (alarms) {
        return alarms
          .filter(function (a) {
            return a.name.indexOf(SCHED_PREFIX) === 0 || a.name.indexOf(REFRESH_PREFIX) === 0 || a.name.indexOf(KEEPALIVE_PREFIX) === 0;
          })
          .map(function (a) {
            return { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes };
          });
      });
    }

    return {
      SCHED_PREFIX: SCHED_PREFIX,
      REFRESH_PREFIX: REFRESH_PREFIX,
      KEEPALIVE_PREFIX: KEEPALIVE_PREFIX,
      syncAlarms: syncAlarms,
      handleAlarm: handleAlarm,
      getStatus: getStatus,
      nextCronTime: nextCronTime,
      validateCronExpression: validateCronExpression,
    };
  }

  return { createScheduler: createScheduler };
});
