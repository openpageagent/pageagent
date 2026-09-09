// Schedule editor state, rendering, validation, and runtime-status loading for options.html.
(function attachOptionsScheduleController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && typeof value.create === 'function' && typeof value.scheduleTaskKind === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsScheduleController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsScheduleController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsScheduleController missing dependency: ' + name);
    return value;
  }

  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function isSafeKey(value) {
    return typeof value === 'string' && !UNSAFE_KEYS[value];
  }

  function isSafeId(value) {
    return isSafeKey(value) && value.length > 0;
  }

  function cloneData(value, ancestors, path) {
    path = path || '$';
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType !== 'object') throw new TypeError('定时任务数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('定时任务数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
        throw new TypeError('定时任务数据禁止自定义 toJSON: ' + path);
      }
      var array = new Array(value.length);
      for (var index = 0; index < value.length; index++) {
        var arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!arrayDescriptor) {
          array[index] = null;
          continue;
        }
        if (arrayDescriptor.get || arrayDescriptor.set || !Object.prototype.hasOwnProperty.call(arrayDescriptor, 'value')) {
          throw new TypeError('定时任务数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = arrayDescriptor.value === undefined
          ? null
          : cloneData(arrayDescriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
      throw new TypeError('定时任务数据禁止自定义 toJSON: ' + path);
    }
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('定时任务数据禁止访问器字段: ' + path + '.' + key);
      }
      if (descriptor.value === undefined || typeof descriptor.value === 'function' || typeof descriptor.value === 'symbol') return;
      Object.defineProperty(output, key, {
        value: cloneData(descriptor.value, nextAncestors, path + '.' + key),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    return output;
  }

  function scheduleTaskKind(schedule) {
    var task = schedule && schedule.task || {};
    var kind = String((schedule && (schedule.taskType || schedule.targetKind)) || task.kind || task.type || '').trim();
    if (!kind) {
      var conversationHint = schedule && (schedule.assistantId || schedule.message || schedule.prompt)
        || task.assistantId || task.message;
      var flowGroupHint = schedule && (schedule.flowGroupId || schedule.groupId)
        || task.flowGroupId || task.groupId;
      kind = conversationHint ? 'conversation' : (flowGroupHint ? 'flowGroup' : 'flow');
    }
    if (kind === 'conversation') return 'conversation';
    return kind === 'flowGroup' || kind === 'flow-group' ? 'flowGroup' : 'flow';
  }

  function scheduleTaskValue(schedule, keys) {
    var task = schedule && schedule.task || {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = schedule && schedule[key] !== undefined ? schedule[key] : task[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function scheduleFlowId(schedule) {
    return scheduleTaskValue(schedule, ['flowId']).replace(/^user:/, '');
  }

  function scheduleFlowGroupId(schedule) {
    return scheduleTaskValue(schedule, ['flowGroupId', 'groupId']).replace(/^flowGroup:/, '');
  }

  function scheduleAssistantId(schedule) {
    return scheduleTaskValue(schedule, ['assistantId']);
  }

  function scheduleMessage(schedule) {
    return scheduleTaskValue(schedule, ['message', 'prompt', 'input']);
  }

  function scheduleTrigger(schedule) {
    var trigger = Object.assign({}, schedule && schedule.trigger || {});
    if (!trigger.kind && schedule && schedule.cronExpression) {
      trigger.kind = 'cron';
      trigger.expression = schedule.cronExpression;
    }
    if (!trigger.kind) trigger.kind = 'interval';
    return trigger;
  }

  function scheduleTriggerText(trigger) {
    trigger = trigger || {};
    if (trigger.kind === 'daily') return '每天 ' + (trigger.time || '08:00');
    if (trigger.kind === 'cron') return 'Cron ' + (trigger.expression || trigger.cron || '');
    return '每 ' + (trigger.minutes || 30) + ' 分钟';
  }

  function create(options) {
    options = options || {};
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsScheduleController');
    }

    var window = options.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    var lifecycle = options.lifecycle || lifecycleFactory.create(window);
    var $ = requireFunction(options.$, '$');
    var esc = requireFunction(options.esc, 'esc');
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var mutateConfig = requireFunction(options.mutateConfig, 'mutateConfig');
    var sortedValues = requireFunction(options.sortedValues, 'sortedValues');
    var renderConfigListItems = requireFunction(options.renderConfigListItems, 'renderConfigListItems');
    var resetConfigListPage = requireFunction(options.resetConfigListPage, 'resetConfigListPage');
    var listableFlows = requireFunction(options.listableFlows, 'listableFlows');
    var isBuiltinItem = requireFunction(options.isBuiltinItem, 'isBuiltinItem');
    var itemIdHtml = requireFunction(options.itemIdHtml, 'itemIdHtml');
    var scrollOpenedEditor = requireFunction(options.scrollOpenedEditor, 'scrollOpenedEditor');
    var toast = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var isActive = requireFunction(options.isActive, 'isActive');
    var loadConversationState = typeof options.loadConversationState === 'function'
      ? options.loadConversationState
      : function () { return Promise.resolve({ assistants: {}, assistantOrder: [] }); };

    var initialized = false;
    var destroyed = false;
    var draft = null;
    var conversationState = { assistants: {}, assistantOrder: [] };
    var refreshSequence = 0;
    var draftRevision = 0;
    var refreshInFlight = null;
    var saveInFlight = null;
    var saveRevision = -1;
    var deleteInFlight = Object.create(null);

    function hasOwn(value, key) {
      return Object.prototype.hasOwnProperty.call(value || {}, key);
    }

    function orderedKeysForObject(map, preferredOrder) {
      map = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
      var seen = Object.create(null);
      var keys = [];
      (Array.isArray(preferredOrder) ? preferredOrder : []).forEach(function (rawId) {
        var id = String(rawId === undefined || rawId === null ? '' : rawId);
        var descriptor = isSafeId(id) ? Object.getOwnPropertyDescriptor(map, id) : null;
        if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value') || hasOwn(seen, id)) return;
        seen[id] = true;
        keys.push(id);
      });
      Object.keys(map).forEach(function (id) {
        var descriptor = isSafeId(id) ? Object.getOwnPropertyDescriptor(map, id) : null;
        if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value') || hasOwn(seen, id)) return;
        seen[id] = true;
        keys.push(id);
      });
      return keys;
    }

    function currentConfig() {
      var config = getConfig();
      return config && typeof config === 'object' ? config : {};
    }

    function findSchedule(id) {
      var schedules = currentConfig().schedules;
      if (!isSafeId(id) || !schedules || typeof schedules !== 'object') return null;
      var descriptor = Object.getOwnPropertyDescriptor(schedules, id);
      if (!descriptor || descriptor.get || descriptor.set || !hasOwn(descriptor, 'value')) return null;
      return cloneData(descriptor.value);
    }

    function missingReferenceLabel(kind, id) {
      id = String(id || '');
      return kind + '不存在' + (id ? '（' + id + '）' : '');
    }

    function assistantLabel(assistantId) {
      var assistants = conversationState && conversationState.assistants || {};
      var assistant = hasOwn(assistants, assistantId) ? assistants[assistantId] : null;
      return assistant ? (assistant.name || assistant.id) : missingReferenceLabel('助手', assistantId);
    }

    function assistantOptionsHtml(selectedAssistantId) {
      selectedAssistantId = String(selectedAssistantId || '');
      var assistantIds = orderedKeysForObject(conversationState.assistants || {}, conversationState.assistantOrder || []);
      if (isSafeId(selectedAssistantId) && assistantIds.indexOf(selectedAssistantId) === -1) assistantIds.unshift(selectedAssistantId);
      return '<option value="">— 选择助手 —</option>' + assistantIds.map(function (assistantId) {
        var assistant = conversationState.assistants && hasOwn(conversationState.assistants, assistantId)
          ? conversationState.assistants[assistantId]
          : null;
        var label = assistant ? (assistant.name || assistant.id) : missingReferenceLabel('助手', assistantId);
        return '<option value="' + esc(assistantId) + '"' + (selectedAssistantId === assistantId ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('');
    }

    function loadConversationSnapshot() {
      return Promise.resolve().then(loadConversationState).then(function (state) {
        return state && typeof state === 'object' && !Array.isArray(state)
          ? cloneData(state)
          : { assistants: {}, assistantOrder: [] };
      }).catch(function () {
        return { assistants: {}, assistantOrder: [] };
      });
    }

    function refresh(refreshOptions) {
      refreshOptions = refreshOptions || {};
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      var sequence = ++refreshSequence;
      var conversationPromise = refreshOptions.conversation === false
        ? Promise.resolve(conversationState)
        : loadConversationSnapshot();
      var operation = Promise.resolve(conversationPromise).then(function (nextConversationState) {
        if (destroyed) return { ok: false, destroyed: true };
        if (sequence !== refreshSequence) return { ok: false, stale: true };
        conversationState = nextConversationState;
        var rendered = false;
        if (refreshOptions.render !== false && isActive()) {
          render();
          rendered = true;
        }
        return { ok: true, rendered: rendered };
      });
      refreshInFlight = operation;
      operation.then(function () {
        if (refreshInFlight === operation) refreshInFlight = null;
      }, function () {
        if (refreshInFlight === operation) refreshInFlight = null;
      });
      return operation;
    }

    function refreshAssistantReferences() {
      return loadConversationSnapshot().then(function (nextConversationState) {
        if (destroyed) return { ok: false, destroyed: true };
        conversationState = nextConversationState;
        if (!isActive()) return { ok: true, rendered: false };
        if (!draft) {
          render();
          return { ok: true, rendered: true };
        }
        var select = $('#sched-assistant');
        if (select) {
          var selectedAssistantId = String(select.value || scheduleAssistantId(draft));
          select.innerHTML = assistantOptionsHtml(selectedAssistantId);
        }
        return { ok: true, rendered: !!select };
      });
    }

    function render() {
      if (destroyed) return { ok: false, destroyed: true };
      var config = currentConfig();
      var list = $('#schedules-list');
      var schedules = sortedValues(config.schedules);
      list.innerHTML = renderConfigListItems('schedules', schedules, '<div class="placeholder">还没有定时任务，点击「新建定时任务」开始</div>', function (schedule) {
        var taskKind = scheduleTaskKind(schedule);
        var flowId = scheduleFlowId(schedule);
        var flowGroupId = scheduleFlowGroupId(schedule);
        var assistantId = scheduleAssistantId(schedule);
        var flow = flowId && config.flows && hasOwn(config.flows, flowId) ? config.flows[flowId] : null;
        var flowGroup = flowGroupId && config.flowGroups && hasOwn(config.flowGroups, flowGroupId) ? config.flowGroups[flowGroupId] : null;
        var triggerText = scheduleTriggerText(scheduleTrigger(schedule));
        var targetText = taskKind === 'conversation'
          ? '对话 · ' + assistantLabel(assistantId)
          : (taskKind === 'flowGroup'
            ? (flowGroup
              ? '流程组 · ' + (flowGroup.label || flowGroup.name || flowGroupId)
              : missingReferenceLabel('流程组', flowGroupId))
            : (flow
              ? (flow.label || flow.name || flowId)
              : missingReferenceLabel('流程', flowId)));
        return '<div class="item-card' + (draft && draft.id === schedule.id ? ' selected' : '') + '" data-action="edit-schedule" data-id="' + esc(schedule.id) + '">'
          + '<span class="item-title">' + esc(schedule.label || '(未命名)') + '</span>'
          + '<span class="item-sub">' + esc(triggerText) + ' → ' + esc(targetText) + '</span>'
          + '<span class="badge' + (schedule.enabled ? ' on' : '') + '">' + (schedule.enabled ? '已启用' : '已停用') + '</span>'
          + itemIdHtml(schedule.id)
          + '</div>';
      });
      renderEditor();
      return { ok: true, draftOpen: !!draft };
    }

    function renderEditor() {
      var editor = $('#schedule-editor');
      if (!draft) {
        editor.classList.add('hidden');
        editor.innerHTML = '';
        return;
      }
      var config = currentConfig();
      var schedule = draft;
      var trigger = scheduleTrigger(schedule);
      var taskKind = scheduleTaskKind(schedule);
      var selectedFlowId = scheduleFlowId(schedule);
      var selectedFlowGroupId = scheduleFlowGroupId(schedule);
      var selectedAssistantId = scheduleAssistantId(schedule);
      var selectedMessage = scheduleMessage(schedule);
      var flows = listableFlows();
      if (selectedFlowId && config.flows && hasOwn(config.flows, selectedFlowId)
          && !flows.some(function (flow) { return flow.id === selectedFlowId; })) {
        flows.push(config.flows[selectedFlowId]);
      }
      var flowOptions = '<option value="">— 选择流程 —</option>' + flows.map(function (flow) {
        return '<option value="' + esc(flow.id) + '"' + (selectedFlowId === flow.id ? ' selected' : '') + '>'
          + esc(flow.label) + (isBuiltinItem(flow) ? '（内置）' : '') + '</option>';
      }).join('');
      if (selectedFlowId && !flows.some(function (flow) { return flow.id === selectedFlowId; })) {
        flowOptions += '<option value="' + esc(selectedFlowId) + '" selected>'
          + esc(missingReferenceLabel('流程', selectedFlowId)) + '</option>';
      }
      var flowGroups = sortedValues(config.flowGroups || {});
      var flowGroupOptions = '<option value="">— 选择流程组 —</option>' + flowGroups.map(function (group) {
        return '<option value="' + esc(group.id) + '"' + (selectedFlowGroupId === group.id ? ' selected' : '') + '>'
          + esc(group.label || group.name || group.id) + '</option>';
      }).join('');
      if (selectedFlowGroupId && !flowGroups.some(function (group) { return group.id === selectedFlowGroupId; })) {
        flowGroupOptions += '<option value="' + esc(selectedFlowGroupId) + '" selected>'
          + esc(missingReferenceLabel('流程组', selectedFlowGroupId)) + '</option>';
      }
      var assistantOptions = assistantOptionsHtml(selectedAssistantId);

      editor.classList.remove('hidden');
      editor.innerHTML =
        '<h3>' + (schedule.id ? '编辑定时任务' : '新建定时任务') + '</h3>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>任务名称</label><input type="text" id="sched-label" value="' + esc(schedule.label) + '" placeholder="如：每小时扫描报表"></div>'
        + '<div class="form-row"><label>任务类型</label><select id="sched-task-kind">'
        + '<option value="flow"' + (taskKind === 'flow' ? ' selected' : '') + '>运行流程</option>'
        + '<option value="flowGroup"' + (taskKind === 'flowGroup' ? ' selected' : '') + '>运行流程组</option>'
        + '<option value="conversation"' + (taskKind === 'conversation' ? ' selected' : '') + '>对话</option>'
        + '</select></div>'
        + '</div>'
        + '<div class="form-grid">'
        + '<div class="form-row" id="sched-flow-row"' + (taskKind !== 'flow' ? ' style="display:none"' : '') + '><label>绑定流程</label><select id="sched-flow">' + flowOptions + '</select></div>'
        + '<div class="form-row" id="sched-flow-group-row"' + (taskKind !== 'flowGroup' ? ' style="display:none"' : '') + '><label>绑定流程组</label><select id="sched-flow-group">' + flowGroupOptions + '</select></div>'
        + '<div class="form-row" id="sched-conversation-assistant-row"' + (taskKind !== 'conversation' ? ' style="display:none"' : '') + '><label>绑定助手</label><select id="sched-assistant">' + assistantOptions + '</select></div>'
        + '</div>'
        + '<div class="form-row" id="sched-conversation-message-row"' + (taskKind !== 'conversation' ? ' style="display:none"' : '') + '><label>输入对话内容</label><textarea id="sched-message" rows="5" placeholder="定时发送给助手的内容">' + esc(selectedMessage) + '</textarea></div>'
        + '<div class="form-grid">'
        + '<div class="form-row"><label>触发方式</label><select id="sched-kind">'
        + '<option value="interval"' + (trigger.kind !== 'daily' && trigger.kind !== 'cron' ? ' selected' : '') + '>固定间隔</option>'
        + '<option value="daily"' + (trigger.kind === 'daily' ? ' selected' : '') + '>每天固定时间</option>'
        + '<option value="cron"' + (trigger.kind === 'cron' ? ' selected' : '') + '>Cron</option>'
        + '</select></div>'
        + '<div class="form-row" id="sched-interval-row"' + (trigger.kind === 'daily' || trigger.kind === 'cron' ? ' style="display:none"' : '') + '><label>间隔（分钟，最小 1）</label><input type="number" id="sched-minutes" min="1" value="' + esc(trigger.minutes || 30) + '"></div>'
        + '<div class="form-row" id="sched-daily-row"' + (trigger.kind !== 'daily' ? ' style="display:none"' : '') + '><label>触发时间</label><input type="time" id="sched-time" value="' + esc(trigger.time || '08:00') + '"></div>'
        + '<div class="form-row" id="sched-cron-row"' + (trigger.kind !== 'cron' ? ' style="display:none"' : '') + '><label>Cron 表达式</label><input type="text" id="sched-cron" value="' + esc(trigger.expression || trigger.cron || schedule.cronExpression || '') + '" placeholder="*/30 * * * *"></div>'
        + '</div>'
        + '<div class="form-row checkbox-row"><input type="checkbox" id="sched-enabled"' + (schedule.enabled !== false ? ' checked' : '') + '><label for="sched-enabled">启用</label></div>'
        + '<div class="editor-actions">'
        + '<button class="btn-primary" data-action="save-schedule">保存</button>'
        + '<button class="btn-secondary" data-action="cancel-schedule">取消</button>'
        + '<span class="spacer"></span>'
        + (schedule.id ? '<button class="btn-danger" data-action="delete-schedule" data-id="' + esc(schedule.id) + '">删除</button>' : '')
        + '</div>';
    }

    function handleEditorChange(event) {
      if (destroyed) return;
      var target = event && event.target;
      if (!target) return;
      if (target.id === 'sched-task-kind') {
        var isConversation = target.value === 'conversation';
        var isFlowGroup = target.value === 'flowGroup';
        $('#sched-flow-row').style.display = !isConversation && !isFlowGroup ? '' : 'none';
        $('#sched-flow-group-row').style.display = isFlowGroup ? '' : 'none';
        $('#sched-conversation-assistant-row').style.display = isConversation ? '' : 'none';
        $('#sched-conversation-message-row').style.display = isConversation ? '' : 'none';
      } else if (target.id === 'sched-kind') {
        var isDaily = target.value === 'daily';
        var isCron = target.value === 'cron';
        $('#sched-interval-row').style.display = (isDaily || isCron) ? 'none' : '';
        $('#sched-daily-row').style.display = isDaily ? '' : 'none';
        $('#sched-cron-row').style.display = isCron ? '' : 'none';
      }
    }

    function openNew() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      draft = {
        label: '',
        taskType: 'flow',
        flowId: '',
        flowGroupId: '',
        assistantId: '',
        message: '',
        enabled: true,
        trigger: { kind: 'interval', minutes: 30 },
      };
      var revision = ++draftRevision;
      return refresh({ render: false }).then(function (result) {
        if (!result.ok || destroyed || revision !== draftRevision || !draft) return result;
        if (isActive()) {
          render();
          scrollOpenedEditor('#schedule-editor');
        }
        return { ok: true, rendered: isActive() };
      });
    }

    function edit(scheduleId) {
      if (destroyed) return { ok: false, destroyed: true };
      var nextDraft;
      try {
        nextDraft = findSchedule(scheduleId);
      } catch (error) {
        var message = '无法打开定时任务: ' + (error && error.message || error);
        toast(message, true);
        return { ok: false, error: message };
      }
      if (!nextDraft) return { ok: false, error: '定时任务不存在' };
      draft = nextDraft;
      draftRevision++;
      render();
      scrollOpenedEditor('#schedule-editor');
      return { ok: true };
    }

    function clearDraft(clearOptions) {
      clearOptions = clearOptions || {};
      draft = null;
      draftRevision++;
      if (clearOptions.render !== false && !destroyed && isActive()) render();
      return { ok: !destroyed, destroyed: destroyed };
    }

    function validationFailure(message) {
      if (!destroyed) toast(message, true);
      return Promise.resolve({ ok: false, error: message });
    }

    function save() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (saveInFlight && saveRevision === draftRevision) return saveInFlight;
      if (!draft) return validationFailure('没有可保存的定时任务');

      var kind = $('#sched-kind').value;
      var taskKindValue = $('#sched-task-kind').value;
      var taskKind = taskKindValue === 'conversation' ? 'conversation' : (taskKindValue === 'flowGroup' ? 'flowGroup' : 'flow');
      var trigger;
      if (kind === 'daily') {
        trigger = { kind: 'daily', time: $('#sched-time').value || '08:00' };
      } else if (kind === 'cron') {
        trigger = { kind: 'cron', expression: $('#sched-cron').value.trim() };
      } else {
        trigger = { kind: 'interval', minutes: Math.max(1, Number($('#sched-minutes').value) || 30) };
      }
      var item = Object.assign({}, draft, {
        label: $('#sched-label').value.trim(),
        taskType: taskKind,
        enabled: $('#sched-enabled').checked,
        trigger: trigger,
      });
      delete item.task;
      delete item.cronExpression;
      if (taskKind === 'conversation') {
        item.flowId = '';
        item.flowGroupId = '';
        item.assistantId = $('#sched-assistant').value;
        item.message = $('#sched-message').value.trim();
        if (!item.assistantId) return validationFailure('请选择要绑定的助手');
        var assistants = conversationState && conversationState.assistants || {};
        if (!hasOwn(assistants, item.assistantId)) return validationFailure('绑定助手不存在，请重新选择');
        if (!item.message) return validationFailure('请输入对话内容');
      } else if (taskKind === 'flowGroup') {
        item.flowId = '';
        item.flowGroupId = $('#sched-flow-group').value;
        item.assistantId = '';
        item.message = '';
        if (!item.flowGroupId) return validationFailure('请选择要触发的流程组');
        var groups = currentConfig().flowGroups || {};
        if (!hasOwn(groups, item.flowGroupId)) return validationFailure('绑定流程组不存在，请重新选择');
      } else {
        item.flowId = $('#sched-flow').value;
        item.flowGroupId = '';
        item.assistantId = '';
        item.message = '';
        if (!item.flowId) return validationFailure('请选择要触发的流程');
      }
      if (kind === 'cron') {
        if (!trigger.expression) return validationFailure('请输入 Cron 表达式');
        if (trigger.expression.trim().split(/\s+/).length !== 5) return validationFailure('Cron 表达式需要 5 段');
      }

      var revision = draftRevision;
      function stillCurrent() {
        return !destroyed && revision === draftRevision;
      }
      function persist() {
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        return Promise.resolve().then(function () {
          return mutateConfig('upsert', 'schedules', item);
        }).then(function (config) {
          if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
          if (!config) return { ok: false, error: '保存失败' };
          draft = null;
          draftRevision++;
          resetConfigListPage('schedules');
          toast('定时任务已保存');
          return refresh().then(function () { return { ok: true, item: cloneData(item) }; });
        }).catch(function (error) {
          if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
          var message = '保存失败: ' + (error && error.message || error);
          toast(message, true);
          return { ok: false, error: message };
        });
      }

      var operation = persist();
      saveInFlight = operation;
      saveRevision = revision;
      operation.then(function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
        }
      }, function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
        }
      });
      return operation;
    }

    function remove(scheduleId) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      scheduleId = String(scheduleId || '');
      if (!isSafeId(scheduleId)) return Promise.resolve({ ok: false, error: '定时任务不存在' });
      if (deleteInFlight[scheduleId]) return deleteInFlight[scheduleId];
      if (!confirmAction('确定删除该定时任务？')) return Promise.resolve({ ok: false, canceled: true });
      if (draft && String(draft.id) === scheduleId) draftRevision++;
      var operation = Promise.resolve().then(function () {
        return mutateConfig('delete', 'schedules', scheduleId);
      }).then(function (config) {
        if (destroyed) return { ok: false, destroyed: true };
        if (!config) return { ok: false, error: '删除失败' };
        if (draft && String(draft.id) === scheduleId) {
          draft = null;
          draftRevision++;
        }
        toast('定时任务已删除');
        if (isActive()) render();
        return { ok: true };
      }).catch(function (error) {
        if (destroyed) return { ok: false, destroyed: true };
        var message = '删除失败: ' + (error && error.message || error);
        toast(message, true);
        return { ok: false, error: message };
      });
      deleteInFlight[scheduleId] = operation;
      operation.then(function () {
        if (deleteInFlight[scheduleId] === operation) delete deleteInFlight[scheduleId];
      }, function () {
        if (deleteInFlight[scheduleId] === operation) delete deleteInFlight[scheduleId];
      });
      return operation;
    }

    function handleAction(action, scheduleId) {
      if (action === 'edit-schedule') {
        edit(scheduleId);
        return true;
      }
      if (action === 'save-schedule') {
        save();
        return true;
      }
      if (action === 'cancel-schedule') {
        clearDraft();
        return true;
      }
      if (action === 'delete-schedule') {
        remove(scheduleId);
        return true;
      }
      return false;
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      lifecycle.listen($('#btn-new-schedule'), 'click', openNew);
      lifecycle.listen($('#schedule-editor'), 'change', handleEditorChange);
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      refreshSequence++;
      draftRevision++;
      draft = null;
      lifecycle.destroy();
      return { ok: true, destroyed: true };
    }

    return {
      init: init,
      destroy: destroy,
      refresh: refresh,
      refreshAssistantReferences: refreshAssistantReferences,
      render: render,
      handleAction: handleAction,
      clearDraft: clearDraft,
      scheduleTaskKind: scheduleTaskKind,
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          refreshing: !!refreshInFlight,
          saving: !!saveInFlight,
          deleting: Object.keys(deleteInFlight).length > 0,
          draftId: draft && draft.id || '',
        };
      },
    };
  }

  return {
    create: create,
    scheduleTaskKind: scheduleTaskKind,
  };
});
