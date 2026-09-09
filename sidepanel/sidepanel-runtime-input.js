(function attachSidepanelRuntimeInputController(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidepanelRuntimeInputController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('SidepanelRuntimeInputController requires ' + name);
    return value;
  }

  function create(options) {
    options = options || {};
    var document = options.document;
    var win = options.window;
    var container = options.container;
    var lifecycleApi = options.lifecycleApi;
    var getSelectedRunTarget = requireFunction(options.getSelectedRunTarget, 'getSelectedRunTarget');
    var isConversationRunTarget = requireFunction(options.isConversationRunTarget, 'isConversationRunTarget');
    var isConversationSession = requireFunction(options.isConversationSession, 'isConversationSession');
    var escapeHtml = requireFunction(options.escapeHtml, 'escapeHtml');

    if (!document || !win || !container) {
      throw new Error('SidepanelRuntimeInputController requires a complete DOM context');
    }
    if (!lifecycleApi || typeof lifecycleApi.create !== 'function') {
      throw new Error('SidepanelRuntimeInputController requires lifecycleApi');
    }
    options = null;

    var lifecycle = lifecycleApi.create(win);
    var initialized = false;
    var destroyed = false;
    var helpOpen = false;
    var helpTargetValue = '';
    var inputTargetValue = '';
    var inputDirty = false;
    var inputSourceKey = '';

    function query(selector) {
      return container ? container.querySelector(selector) : null;
    }

    function getInputLabel() {
      return query('[data-runtime-input-label]');
    }

    function getRequiredMeta() {
      return query('[data-runtime-required]');
    }

    function getFormatButton() {
      return query('[data-runtime-format]');
    }

    function getHelpTrigger() {
      return query('[data-runtime-help]');
    }

    function getInputField() {
      return query('#runtime-input-json');
    }

    function getInputError() {
      return query('#runtime-input-error');
    }

    function setInputError(message) {
      var element = getInputError();
      if (!element) return;
      element.textContent = message || '';
      element.hidden = !message;
    }

    function clearInputError() {
      setInputError('');
    }

    function updateInputChrome(target) {
      var label = getInputLabel();
      var required = getRequiredMeta();
      var field = getInputField();
      var formatButton = getFormatButton();
      var conversationTarget = isConversationRunTarget(target);
      if (label) label.textContent = conversationTarget ? '任务内容' : '入参';
      if (required) required.textContent = conversationTarget ? '必填' : '可选';
      if (formatButton) {
        formatButton.textContent = conversationTarget ? 'JSON' : '格式化';
        formatButton.title = conversationTarget ? '转为或格式化 JSON' : '格式化 JSON';
      }
      if (field) {
        field.placeholder = conversationTarget
          ? (target.inputPlaceholder || '直接输入对话内容，例如：请帮我检查当前页面并给出建议')
          : '{"input":{"keyword":"订单"}} 或 {"keyword":"订单"}';
      }
    }

    function hasHelp(target) {
      return !!(target && (target.description || target.inputDescription));
    }

    function helpHtml(target) {
      var parts = [];
      if (target.description) {
        parts.push('<div class="runtime-help-block"><b>运行说明</b><p>' + escapeHtml(target.description) + '</p></div>');
      }
      if (target.inputDescription) {
        parts.push('<div class="runtime-help-block"><b>入参说明</b><p>' + escapeHtml(target.inputDescription) + '</p></div>');
      }
      return parts.join('');
    }

    function ensureHelpPopover() {
      var popover = document.querySelector('.runtime-help-popover');
      if (popover) return popover;
      popover = document.createElement('div');
      popover.className = 'runtime-help-popover';
      popover.hidden = true;
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', '运行说明');
      document.body.appendChild(popover);
      return popover;
    }

    function positionHelpPopover(popover) {
      var trigger = getHelpTrigger();
      if (!popover || !trigger) return;
      var rect = trigger.getBoundingClientRect();
      var margin = 10;
      var width = Math.min(320, win.innerWidth - margin * 2);
      popover.style.width = width + 'px';
      popover.style.left = Math.min(
        Math.max(margin, rect.right - width),
        win.innerWidth - width - margin
      ) + 'px';
      popover.style.top = (rect.bottom + 8) + 'px';
    }

    function hideHelpPopover() {
      var popover = document.querySelector('.runtime-help-popover');
      if (popover) popover.hidden = true;
      helpOpen = false;
      helpTargetValue = '';
      var trigger = getHelpTrigger();
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    function showHelpPopover(target) {
      if (!hasHelp(target)) return;
      var popover = ensureHelpPopover();
      popover.innerHTML = helpHtml(target);
      positionHelpPopover(popover);
      popover.hidden = false;
      helpOpen = true;
      helpTargetValue = target.value || '';
      var trigger = getHelpTrigger();
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
    }

    function toggleHelpPopover(event) {
      if (event && event.stopPropagation) event.stopPropagation();
      var target = getSelectedRunTarget();
      if (!hasHelp(target)) return;
      var popover = ensureHelpPopover();
      if (popover.hidden) showHelpPopover(target);
      else hideHelpPopover();
    }

    function updateHelpButton(target, keepOpen) {
      var trigger = getHelpTrigger();
      if (!trigger) return;
      var available = hasHelp(target);
      trigger.hidden = !available;
      trigger.disabled = !available;
      trigger.title = available ? '运行说明' : '未填写运行说明';
      if (!available || (target && helpTargetValue && helpTargetValue !== target.value)) {
        hideHelpPopover();
        return;
      }
      if (helpOpen && keepOpen) {
        var popover = ensureHelpPopover();
        positionHelpPopover(popover);
        popover.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      } else if (!helpOpen) {
        trigger.setAttribute('aria-expanded', 'false');
      }
    }

    function parseForUi() {
      var field = getInputField();
      var raw = field ? String(field.value || '').trim() : '';
      var target = getSelectedRunTarget();
      if (isConversationRunTarget(target)) {
        if (!raw) {
          clearInputError();
          return { ok: true, empty: true, raw: raw, mode: 'text' };
        }
        if (raw.charAt(0) === '{') {
          try {
            var conversationParams = JSON.parse(raw);
            if (!conversationParams || typeof conversationParams !== 'object' || Array.isArray(conversationParams)) {
              setInputError('对话高级参数必须是 JSON 对象');
              return { ok: false, raw: raw };
            }
            clearInputError();
            return { ok: true, raw: raw, parsed: conversationParams, mode: 'json' };
          } catch (_) {
            clearInputError();
            return { ok: true, raw: raw, mode: 'text' };
          }
        }
        clearInputError();
        return { ok: true, raw: raw, mode: 'text' };
      }
      if (!raw) {
        clearInputError();
        return { ok: true, empty: true, raw: raw };
      }
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setInputError('入参必须是 JSON 对象');
          return { ok: false, raw: raw };
        }
        clearInputError();
        return { ok: true, raw: raw, parsed: parsed };
      } catch (error) {
        setInputError('JSON 语法错误: ' + error.message);
        return { ok: false, raw: raw };
      }
    }

    function formatInput(event) {
      if (event && event.preventDefault) event.preventDefault();
      if (event && event.stopPropagation) event.stopPropagation();
      var field = getInputField();
      if (!field) return;
      var result = parseForUi();
      var target = getSelectedRunTarget();
      if (!result.ok) return;
      if (result.empty) {
        if (!isConversationRunTarget(target)) return;
        field.value = JSON.stringify({
          message: '请帮我检查当前页面并给出建议',
          label: '',
          modelServiceId: '',
        }, null, 2);
      } else if (isConversationRunTarget(target) && result.mode !== 'json') {
        field.value = JSON.stringify({ message: result.raw || '' }, null, 2);
      } else {
        field.value = JSON.stringify(result.parsed, null, 2);
      }
      field.scrollTop = 0;
      inputTargetValue = (getSelectedRunTarget() || {}).value || inputTargetValue;
      inputDirty = true;
      clearInputError();
    }

    function sessionInputToJson(input) {
      if (input === undefined || input === null) return '';
      try { return JSON.stringify(input, null, 2); } catch (_) { return ''; }
    }

    function readTextField(source, keys) {
      if (!source || typeof source !== 'object') return '';
      for (var i = 0; i < keys.length; i++) {
        var value = source[keys[i]];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    }

    function applySessionInput(session) {
      if (destroyed) return;
      var field = getInputField();
      var formatButton = getFormatButton();
      var sessionKey = session ? ('session:' + session.runId) : '';
      if (!session) {
        if (inputSourceKey.indexOf('session:') === 0) {
          inputSourceKey = '';
          inputDirty = false;
          render();
        }
        return;
      }
      if (inputSourceKey === sessionKey && inputDirty) return;
      if (field) {
        field.value = isConversationSession(session)
          ? ''
          : sessionInputToJson(session.input);
        field.disabled = false;
      }
      if (formatButton) formatButton.disabled = false;
      container.classList.remove('is-disabled');
      inputSourceKey = sessionKey;
      inputTargetValue = (getSelectedRunTarget() || {}).value || inputTargetValue;
      inputDirty = false;
      clearInputError();
      updateInputChrome(isConversationSession(session) ? {
        type: 'assistant',
        inputPlaceholder: session.status === 'running'
          ? '后台任务运行中，请等待完成'
          : '输入内容可启动新的后台任务',
      } : getSelectedRunTarget());
      updateHelpButton(isConversationSession(session) ? null : getSelectedRunTarget(), true);
    }

    function render(renderOptions) {
      if (destroyed) return;
      renderOptions = renderOptions || {};
      var field = getInputField();
      var formatButton = getFormatButton();
      var target = getSelectedRunTarget();
      updateInputChrome(target);
      if (!target) {
        hideHelpPopover();
        if (inputSourceKey.indexOf('session:') !== 0) {
          container.classList.add('is-disabled');
          if (field) {
            field.value = '';
            field.disabled = true;
          }
          if (formatButton) formatButton.disabled = true;
          inputDirty = false;
          clearInputError();
        }
        inputTargetValue = '';
        updateHelpButton(null);
        return;
      }
      container.classList.remove('is-disabled');
      if (field) field.disabled = false;
      if (formatButton) formatButton.disabled = false;
      var sameTarget = inputTargetValue === target.value;
      if (sameTarget && !renderOptions.forceTargetInput) {
        if (field && inputSourceKey === 'target:' + target.value && !inputDirty && !field.value && target.inputExample) {
          field.value = target.inputExample;
        }
        updateHelpButton(target, true);
        return;
      }
      if (field) field.value = target.inputExample || '';
      inputTargetValue = target.value;
      inputSourceKey = 'target:' + target.value;
      inputDirty = false;
      clearInputError();
      updateHelpButton(target, true);
    }

    function lastUserMessageText(messages) {
      if (!Array.isArray(messages)) return '';
      for (var i = messages.length - 1; i >= 0; i--) {
        var message = messages[i] || {};
        if (message.role && message.role !== 'user') continue;
        if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
        if (Array.isArray(message.content)) {
          for (var j = 0; j < message.content.length; j++) {
            var item = message.content[j];
            if (typeof item === 'string' && item.trim()) return item.trim();
            if (item && typeof item.text === 'string' && item.text.trim()) return item.text.trim();
          }
        }
      }
      return '';
    }

    function collectConversationInput(raw) {
      if (!raw) {
        setInputError('请输入对话内容');
        throw new Error('对话缺少 message');
      }
      if (raw.charAt(0) !== '{') {
        clearInputError();
        return {
          message: raw,
          label: raw.slice(0, 36),
          modelServiceId: '',
          input: { message: raw },
        };
      }
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        clearInputError();
        return {
          message: raw,
          label: raw.slice(0, 36),
          modelServiceId: '',
          input: { message: raw },
        };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setInputError('对话高级参数必须是 JSON 对象');
        throw new Error('对话高级参数必须是 JSON 对象');
      }
      var nestedInput = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
        ? parsed.input
        : null;
      var input = nestedInput || parsed;
      var message = readTextField(input, ['message', 'prompt', 'question', 'content'])
        || readTextField(parsed, ['message', 'prompt', 'question', 'content'])
        || (typeof parsed.input === 'string' ? parsed.input.trim() : '')
        || lastUserMessageText(input.messages || parsed.messages);
      if (!message) {
        setInputError('对话缺少 message');
        throw new Error('对话缺少 message');
      }
      var label = readTextField(input, ['label', 'topic', 'name', 'title'])
        || readTextField(parsed, ['label', 'topic', 'name', 'title'])
        || message.slice(0, 36);
      var modelServiceId = readTextField(input, ['modelServiceId'])
        || readTextField(parsed, ['modelServiceId']);
      clearInputError();
      return {
        message: message,
        label: label,
        modelServiceId: modelServiceId,
        input: parsed,
      };
    }

    function collect(target) {
      if (!target || destroyed) return {};
      var field = getInputField();
      var raw = field ? String(field.value || '').trim() : '';
      if (isConversationRunTarget(target)) return collectConversationInput(raw);
      if (!raw) return {};
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        setInputError('JSON 语法错误: ' + error.message);
        throw new Error('入参 JSON 无效: ' + error.message);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setInputError('入参必须是 JSON 对象');
        throw new Error('入参必须是 JSON 对象');
      }
      clearInputError();
      return parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
        ? parsed
        : { input: parsed };
    }

    function setDisabled(disabled) {
      var fields = container.querySelectorAll('input, textarea, select, button');
      for (var i = 0; i < fields.length; i++) fields[i].disabled = !!disabled;
    }

    function resetContext() {
      inputSourceKey = '';
      inputDirty = false;
      hideHelpPopover();
    }

    function clear() {
      var field = getInputField();
      if (field) field.value = '';
      inputDirty = false;
      clearInputError();
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      lifecycle.listen(getHelpTrigger(), 'click', toggleHelpPopover);
      lifecycle.listen(getFormatButton(), 'click', formatInput);
      var field = getInputField();
      if (field) {
        lifecycle.listen(field, 'input', function () {
          inputDirty = true;
          clearInputError();
        });
        lifecycle.listen(field, 'blur', parseForUi);
      }
      lifecycle.listen(document, 'click', function (event) {
        if (!event.target) return;
        var popover = document.querySelector('.runtime-help-popover');
        if (!popover || popover.hidden) return;
        var trigger = getHelpTrigger();
        if ((trigger && trigger.contains(event.target)) || popover.contains(event.target)) return;
        hideHelpPopover();
      });
      lifecycle.listen(document, 'keydown', function (event) {
        if (event.key === 'Escape') hideHelpPopover();
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycle.destroy();
      var popover = document.querySelector('.runtime-help-popover');
      if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
      container = null;
      document = null;
      win = null;
    }

    return {
      init: init,
      render: render,
      collect: collect,
      applySessionInput: applySessionInput,
      setDisabled: setDisabled,
      resetContext: resetContext,
      clear: clear,
      destroy: destroy,
    };
  }

  return { create: create };
});
