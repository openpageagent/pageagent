// Scheduler — 基于 chrome.alarms 的定时任务与页面会话保活调度
// alarm 命名: pfa-sched:<runtimeScope>:<schedId> 等；split incognito 下运行态互不覆盖。
(function attachScheduler(root, factory) {
  root.Scheduler = factory();
})(globalThis, function () {

  var SCHED_BASE_PREFIX = 'pfa-sched:';
  var HEARTBEAT_BASE_PREFIX = 'pfa-heartbeat:';
  var REFRESH_BASE_PREFIX = 'pfa-refresh:';
  var KEEPALIVE_BASE_PREFIX = 'pfa-keepalive:';
  var CALENDAR_TRIGGER_GRACE_MS = 5 * 60 * 1000;

  function createScheduler(deps) {
    deps = deps || {};
    var runtimeScope = deps.runtimeScope === 'incognito' ? 'incognito' : 'regular';
    var SCHED_PREFIX = SCHED_BASE_PREFIX + runtimeScope + ':';
    var HEARTBEAT_PREFIX = HEARTBEAT_BASE_PREFIX + runtimeScope + ':';
    var chrome = deps.chrome || globalThis.chrome;
    var scheduleUtils = deps.scheduleUtils || globalThis.ScheduleUtils;
    var addLog = deps.addLog || (function () {});
    var getConfig = deps.getConfig || (function () { return { schedules: {} }; });
    var isFlowRunning = deps.isFlowRunning || (function () { return false; });
    var startFlowRun = deps.startFlowRun || (function () {});
    var startFlowGroupRun = deps.startFlowGroupRun || (function () { return Promise.reject(new Error('FlowGroup 调度未接线')); });
    var isFlowGroupRunning = deps.isFlowGroupRunning || (function () { return false; });
    var startConversation = deps.startConversation || (function () { return Promise.reject(new Error('对话调度未接线')); });
    var isConversationScheduleRunning = deps.isConversationScheduleRunning || (function () { return false; });
    var activeConversationSchedules = Object.create(null);
    var activeFlowStarts = Object.create(null);
    var runPageHeartbeat = deps.runPageHeartbeat || (function () { return Promise.reject(new Error('页面会话保活未接线')); });

    function isLegacyAlarmName(name, basePrefix) {
      if (name.indexOf(basePrefix) !== 0) return false;
      var suffix = name.slice(basePrefix.length);
      return suffix.indexOf('regular:') !== 0 && suffix.indexOf('incognito:') !== 0;
    }

    function isRetiredPageAlarm(name) {
      return [REFRESH_BASE_PREFIX, KEEPALIVE_BASE_PREFIX].some(function (prefix) {
        return name.indexOf(prefix + runtimeScope + ':') === 0 || isLegacyAlarmName(name, prefix);
      });
    }

    // --- 计算固定日期 / daily / cron 触发的下次时刻 ---

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

    function validateSchedule(sched) {
      scheduleUtils.validate(sched);
      var trigger = triggerForSchedule(sched);
      if (trigger.kind === 'cron') validateCronExpression(trigger.expression || trigger.cron || sched.cronExpression || '');
    }

    function resolveContext(sched, fireTime) {
      return Promise.resolve().then(function () {
        validateSchedule(sched);
        var context = JSON.parse(JSON.stringify(sched.context || {}));
        var trigger = triggerForSchedule(sched);
        if (!sched.includeCalendar && (!trigger.dayFilter || trigger.dayFilter === 'all')) return context;
        var date = scheduleUtils.localDate(new Date(Number(fireTime) || Date.now()));
        context.calendar = scheduleUtils.calendarDay(date, sched.calendar);
        return context;
      });
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
      if (!trigger || (trigger.kind !== 'daily' && trigger.kind !== 'cron' && trigger.kind !== 'dates')) return 0;
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
        validateSchedule(sched);
        if (trigger.kind === 'interval') {
          var minutes = Math.max(1, Number(trigger.minutes) || 30);
          return createAlarm(name, { periodInMinutes: minutes, delayInMinutes: minutes }, '定时任务 [' + (sched.label || sched.id) + '] 未创建 alarm');
        } else if (trigger.kind === 'daily' || trigger.kind === 'dates') {
          var next = scheduleUtils.nextTime(trigger);
          if (next === null) return Promise.resolve(false);
          return createAlarm(name, { when: next }, '定时任务 [' + (sched.label || sched.id) + '] 未创建 alarm');
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
              || name.indexOf(HEARTBEAT_PREFIX) === 0
              || isRetiredPageAlarm(name)
              || isLegacyAlarmName(name, SCHED_BASE_PREFIX)) {
            clears.push(chrome.alarms.clear(name));
          }
        }
        return Promise.all(clears);
      }).then(function () {
        var schedIds = Object.keys(config.schedules || {});
        var created = 0;
        var heartbeats = 0;
        var creations = [];
        for (var i = 0; i < schedIds.length; i++) {
          var sched = config.schedules[schedIds[i]];
          if (!sched.enabled || !scheduleRunnable(sched)) continue;
          creations.push(createAlarmForSchedule(sched).then(function (ok) {
            if (ok) created++;
          }));
        }
        Object.keys(config.pages || {}).forEach(function (pageId) {
          var page = config.pages[pageId];
          var heartbeat = page && page.keepAlive;
          if (!heartbeat || heartbeat.enabled !== true || !String(heartbeat.requestUrl || '').trim()) return;
          var minutes = Math.max(1, Number(heartbeat.intervalMinutes) || 5);
          creations.push(createAlarm(HEARTBEAT_PREFIX + pageId,
            { periodInMinutes: minutes, delayInMinutes: minutes },
            '页面会话保活 [' + (page.label || pageId) + '] 未创建 alarm').then(function (ok) {
              if (ok) heartbeats++;
            }));
        });

        return Promise.all(creations).then(function () {
          addLog('定时任务已同步: ' + created + ' 个调度，' + heartbeats + ' 个页面会话保活');
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
        // 固定时刻为一次性 alarm；先登记下次，再读取已保存的日历信息。
        var rescheduled = trigger.kind === 'daily' || trigger.kind === 'cron' || trigger.kind === 'dates'
          ? createAlarmForSchedule(sched)
          : Promise.resolve(true);
        var lateness = calendarTriggerLateness(trigger, fireTime);
        if (lateness > CALENDAR_TRIGGER_GRACE_MS) {
          return rescheduled.then(function () {
            addLog('定时任务 [' + (sched.label || schedId) + '] 的触发时刻已错过 '
              + Math.floor(lateness / 60000) + ' 分钟，本次不补跑', { level: 'warn' });
          });
        }

        return rescheduled.then(function () {
          return resolveContext(sched, fireTime);
        }).then(function (context) {
          if (!scheduleUtils.matchesDay(trigger.dayFilter, context.calendar)) {
            addLog('定时任务 [' + (sched.label || schedId) + '] 不符合日期筛选，本次跳过');
            return;
          }
          if (calendarTriggerLateness(trigger, fireTime) > CALENDAR_TRIGGER_GRACE_MS) {
            addLog('定时任务 [' + (sched.label || schedId) + '] 准备期间错过触发时刻，本次不补跑', { level: 'warn' });
            return;
          }
          return runScheduledTask(sched, schedId, fireTime, context);
        }).catch(function (error) {
          addLog('定时任务 [' + (sched.label || schedId) + '] 未运行: ' + (error && error.message || error), { level: 'warn' });
        });
      });
    }

    function runScheduledTask(sched, schedId, fireTime, context) {
        var taskKind = scheduleTaskKind(sched);

        if (taskKind === 'conversation') {
          var conversationBusy = !!activeConversationSchedules[schedId];
          if (!conversationBusy) activeConversationSchedules[schedId] = true;
          var durableBusy = conversationBusy ? Promise.resolve(true) : Promise.resolve().then(function () {
            return isConversationScheduleRunning(schedId);
          }).catch(function (error) {
            addLog('定时对话运行状态检查失败 [' + (sched.label || schedId) + ']: ' + (error && error.message || error), { level: 'warn' });
            return false;
          });
          return durableBusy.then(function (busy) {
            if (busy) {
              addLog('定时任务 [' + (sched.label || schedId) + '] 触发，但该对话仍在运行，本次跳过', { level: 'warn' });
              return;
            }
            addLog('定时对话触发: ' + (sched.label || schedId));
            return Promise.resolve().then(function () {
              return startConversation(sched, 'schedule:' + schedId, {
                entry: 'schedule', scheduleId: schedId,
                initialContext: context,
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
        return Promise.resolve().then(function () {
          if (flowBusy) {
            addLog('定时任务 [' + (sched.label || schedId) + '] 触发，但该流程已在运行，本次跳过', { level: 'warn' });
            return;
          }
          addLog('定时任务触发: ' + (sched.label || schedId));
          return Promise.resolve().then(function () {
            return flowGroupTask
              ? startFlowGroupRun(flowId, { trigger: 'schedule:' + schedId, entry: 'schedule', scheduleId: schedId, initialContext: context })
              : startFlowRun(flowId, 'schedule:' + schedId, { entry: 'schedule', scheduleId: schedId, initialContext: context });
          }).catch(function (err) {
            addLog('定时任务启动失败 [' + (sched.label || schedId) + ']: ' + (err && err.message || err), { level: 'error' });
          });
        }).finally(function () {
          if (!flowBusy) delete activeFlowStarts[activeKey];
        });
    }

    function handleAlarm(alarm) {
      var name = alarm.name || '';
      if (name.indexOf(SCHED_PREFIX) === 0) {
        return handleScheduleAlarm(name.slice(SCHED_PREFIX.length), alarm.scheduledTime);
      }
      if (name.indexOf(HEARTBEAT_PREFIX) === 0) {
        var pageId = name.slice(HEARTBEAT_PREFIX.length);
        return Promise.resolve().then(getConfig).then(function (config) {
          var page = config.pages && config.pages[pageId];
          var heartbeat = page && page.keepAlive;
          if (!heartbeat || heartbeat.enabled !== true || !String(heartbeat.requestUrl || '').trim()) {
            return chrome.alarms.clear(name);
          }
          return runPageHeartbeat(pageId, page);
        }).catch(function (error) {
          addLog('页面会话保活 [' + pageId + '] 未执行: ' + String(error && error.message || error), { level: 'warn' });
        });
      }
      if (isRetiredPageAlarm(name)) return chrome.alarms.clear(name);
    }

    function getStatus() {
      return chrome.alarms.getAll().then(function (alarms) {
        return alarms
          .filter(function (a) {
            return a.name.indexOf(SCHED_PREFIX) === 0 || a.name.indexOf(HEARTBEAT_PREFIX) === 0;
          })
          .map(function (a) {
            return { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes };
          });
      });
    }

    return {
      SCHED_PREFIX: SCHED_PREFIX,
      syncAlarms: syncAlarms,
      handleAlarm: handleAlarm,
      getStatus: getStatus,
      nextCronTime: nextCronTime,
      validateCronExpression: validateCronExpression,
      validateSchedule: validateSchedule,
      resolveContext: resolveContext,
    };
  }

  return { createScheduler: createScheduler };
});
