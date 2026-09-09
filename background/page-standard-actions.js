// Standard business actions shared by Flow nodes, script page.* APIs and ARP.
// The owning PageActionEngine executes every operation and remains responsible
// for CDP, sessions, serialization, command facts and receipts.
(function attachPageStandardActions(root, factory) {
  'use strict';
  var api = factory(root && root.PageFactContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageStandardActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (factContract) {
  'use strict';

  var API_VERSION = 1;
  var TARGET_KINDS = Object.freeze([
    'click', 'doubleClick', 'contextClick', 'hover', 'press',
    'type', 'fill', 'select', 'check', 'scroll', 'drag', 'upload',
  ]);
  var DEFAULT_CUSTOM_OPTION_SELECTOR = [
    '[role="option"]', '[role="menuitem"]', '[role="treeitem"]', 'option',
    '.el-select-dropdown__item', '.ant-select-item-option', '.ant-select-dropdown-menu-item',
    '.MuiMenuItem-root', '.mat-option', '.mat-mdc-option',
  ].join(',');
  var SCROLL_READ_INTERVAL_MS = 50;
  var HUMAN_SCROLL_SPEED_PX_PER_SECOND = 2400;
  var HUMAN_SCROLL_MAX_GESTURE_PX = 6000;

  function pageError(code, message, details) {
    return new factContract.PageFactError(code, message, details || {});
  }

  function booleanInput(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return fallback;
    if (/^(?:true|yes|1|on|checked|selected)$/i.test(String(value))) return true;
    if (/^(?:false|no|0|off|unchecked|unselected)$/i.test(String(value))) return false;
    return fallback;
  }

  function meaningfulLocator(locator) {
    if (!locator || typeof locator !== 'object') return false;
    if (locator.elementIndex !== undefined && locator.elementIndex !== null && locator.elementIndex !== '') return true;
    return ['selector', 'textSelector', 'textPattern', 'text', 'ref', 'label'].some(function (key) {
      return locator[key] !== '' && locator[key] !== undefined && locator[key] !== null;
    });
  }

  function canonicalScrollMode(input) {
    var mode = String(input.mode || input.to || 'amount');
    if (mode === 'top' || mode === 'toTop') return 'top';
    if (mode === 'bottom' || mode === 'toBottom') return 'bottom';
    if (mode === 'target' || mode === 'toElement') return 'target';
    if (mode === 'untilElement') return 'untilElement';
    return 'amount';
  }

  function scrollAxis(input) {
    if (String(input.axis || '') === 'horizontal') return 'horizontal';
    if (!input.axis && Number.isFinite(Number(input.deltaX)) && Number(input.deltaX) !== 0
        && (!Number.isFinite(Number(input.deltaY)) || Number(input.deltaY) === 0)) return 'horizontal';
    return 'vertical';
  }

  function scrollPosition(info, axis) {
    return Number(axis === 'horizontal' ? info && info.scrollLeft : info && info.scrollTop) || 0;
  }

  function scrollMaximum(info, axis) {
    return Math.max(0, Number(axis === 'horizontal' ? info && info.maxLeft : info && info.maxTop) || 0);
  }

  function scrollBoundaryReached(info, axis, direction, thresholdPx) {
    var position = scrollPosition(info, axis);
    var maximum = scrollMaximum(info, axis);
    return direction < 0 ? position <= thresholdPx : maximum - position <= thresholdPx;
  }

  function scrollTargetVisible(target, containerInfo) {
    if (!target || !target.target || target.target.visible !== true) return false;
    var targetBounds = target.target.bounds || {};
    var containerBounds = containerInfo && containerInfo.bounds || {};
    var targetX = Number(targetBounds.x);
    var targetY = Number(targetBounds.y);
    var targetWidth = Number(targetBounds.width);
    var targetHeight = Number(targetBounds.height);
    var containerX = Number(containerBounds.x);
    var containerY = Number(containerBounds.y);
    var containerWidth = Number(containerBounds.width);
    var containerHeight = Number(containerBounds.height);
    if (![targetX, targetY, targetWidth, targetHeight, containerX, containerY, containerWidth, containerHeight].every(Number.isFinite)) {
      return target.target.inViewport === true;
    }
    return targetWidth > 0 && targetHeight > 0 && containerWidth > 0 && containerHeight > 0
      && targetX < containerX + containerWidth && targetX + targetWidth > containerX
      && targetY < containerY + containerHeight && targetY + targetHeight > containerY;
  }

  function scrollTargetDirection(target, containerInfo, axis, fallback) {
    if (!target || !target.target) return fallback;
    var targetBounds = target.target.bounds || {};
    var containerBounds = containerInfo && containerInfo.bounds || {};
    var targetCenter = Number(axis === 'horizontal' ? targetBounds.x : targetBounds.y)
      + Number(axis === 'horizontal' ? targetBounds.width : targetBounds.height) / 2;
    var containerCenter = Number(axis === 'horizontal' ? containerBounds.x : containerBounds.y)
      + Number(axis === 'horizontal' ? containerBounds.width : containerBounds.height) / 2;
    if (Number.isFinite(targetCenter) && Number.isFinite(containerCenter)) {
      return targetCenter < containerCenter ? -1 : 1;
    }
    return fallback;
  }

  function scrollFacts(initial, current, axis) {
    var result = Object.assign({}, current || {});
    result.beforeLeft = Number(initial && initial.scrollLeft) || 0;
    result.beforeTop = Number(initial && initial.scrollTop) || 0;
    result.appliedX = (Number(current && current.scrollLeft) || 0) - result.beforeLeft;
    result.appliedY = (Number(current && current.scrollTop) || 0) - result.beforeTop;
    if (axis === 'horizontal') {
      result.remainingPx = Math.max(0, (Number(current && current.maxLeft) || 0) - (Number(current && current.scrollLeft) || 0));
    }
    return result;
  }

  function selectionMode(input) {
    var dropdownMode = String(input && input.dropdownMode || '');
    if (/^(?:first|last|random|index|value|exact|contains)$/.test(dropdownMode)) return dropdownMode;
    return String(input && input.optionMatch || 'smart');
  }

  function selectionText(input) {
    input = input || {};
    if (input.optionText !== undefined) return input.optionText;
    if (input.label !== undefined) return input.label;
    return input.value === undefined ? '' : input.value;
  }

  function selectOptionIndex(options, input) {
    options = options || [];
    var enabled = options.filter(function (option) { return !option.disabled; });
    if (!enabled.length) return -1;
    var mode = selectionMode(input);
    if (mode === 'random') return enabled[Math.floor(Math.random() * enabled.length)].index;
    if (mode === 'first') return enabled[0].index;
    if (mode === 'last') return enabled[enabled.length - 1].index;
    var rawIndex = input.optionIndex !== undefined ? input.optionIndex : (input.index !== undefined ? input.index : null);
    if (String(rawIndex).toLowerCase() === 'random') return enabled[Math.floor(Math.random() * enabled.length)].index;
    if (rawIndex !== null && rawIndex !== '') {
      var index = Number(rawIndex);
      if (Number.isInteger(index)) {
        if (index < 0) index = enabled.length + index;
        else if (Number(input.optionIndexBase) !== 0 && index > 0) index -= 1;
        return enabled[index] ? enabled[index].index : -1;
      }
    }
    if (mode === 'index') return -1;
    var expected = String(mode === 'value'
      ? (input.value === undefined ? '' : input.value)
      : selectionText(input));
    var exact = enabled.find(function (option) {
      return mode === 'value' ? String(option.value) === expected : option.text === expected || String(option.value) === expected;
    });
    if (exact) return exact.index;
    if (mode !== 'exact' && mode !== 'value') {
      var contains = enabled.find(function (option) { return option.text.indexOf(expected) !== -1 || expected.indexOf(option.text) !== -1; });
      if (contains) return contains.index;
    }
    return -1;
  }

  function hasSelectionChoice(input) {
    input = input || {};
    var mode = String(input.dropdownMode || '');
    if (/^(?:first|last|random)$/.test(mode)) return true;
    var index = input.optionIndex !== undefined ? input.optionIndex : input.index;
    if (mode === 'index') return index !== undefined && index !== null && String(index).trim() !== '';
    if (index !== undefined && index !== null && String(index).trim() !== '') return true;
    if (mode === 'value') return input.value !== undefined && input.value !== null && String(input.value).trim() !== '';
    var text = input.optionText !== undefined ? input.optionText : input.label;
    if (text !== undefined && text !== null && String(text).trim() !== '') return true;
    return input.value !== undefined && input.value !== null && String(input.value).trim() !== '';
  }

  function normalizeDragData(input) {
    input = input || {};
    var raw = input.dragData;
    if (typeof raw === 'string' && raw.trim()) {
      try { raw = JSON.parse(raw); }
      catch (_) { raw = {}; }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    var items = raw.items !== undefined ? raw.items : input.dragItems;
    if (typeof items === 'string' && items.trim()) {
      try { items = JSON.parse(items); }
      catch (_) { items = []; }
    }
    if (!Array.isArray(items) || !items.length) return null;
    var normalizedItems = items.map(function (item) {
      if (typeof item === 'string') return { mimeType: 'text/plain', data: item };
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      var normalized = {
        mimeType: String(item.mimeType || item.type || 'text/plain'),
        data: String(item.data !== undefined ? item.data : (item.value !== undefined ? item.value : '')),
      };
      if (item.title !== undefined) normalized.title = String(item.title);
      if (item.baseURL !== undefined || item.baseUrl !== undefined) normalized.baseURL = String(item.baseURL !== undefined ? item.baseURL : item.baseUrl);
      return normalized;
    }).filter(Boolean);
    if (!normalizedItems.length) return null;
    var mask = Number(raw.dragOperationsMask !== undefined ? raw.dragOperationsMask : input.dragOperationsMask);
    if (!Number.isInteger(mask) || mask < 0) mask = 1;
    return { items: normalizedItems, dragOperationsMask: mask };
  }

  function keyCombination(value) {
    var parts = String(value || 'Enter').split('+');
    var key = parts.pop() || 'Enter';
    var modifiers = 0;
    parts.forEach(function (part) {
      if (/ctrl/i.test(part)) modifiers |= 2;
      else if (/meta|cmd/i.test(part)) modifiers |= 4;
      else if (/alt/i.test(part)) modifiers |= 1;
      else if (/shift/i.test(part)) modifiers |= 8;
    });
    return { key: key, modifiers: modifiers };
  }

  function formFields(input) {
    var fieldsInput = input.fields;
    if (typeof fieldsInput === 'string') {
      try { fieldsInput = JSON.parse(fieldsInput || '[]'); }
      catch (error) { throw pageError('ACTION_INVALID', 'fillFormFields.fields 必须是有效 JSON 数组', { reason: String(error && error.message || error) }); }
    }
    if (!Array.isArray(fieldsInput) || !fieldsInput.length) {
      var values = input.values;
      if (typeof values === 'string') {
        try { values = JSON.parse(values || '{}'); }
        catch (error) { throw pageError('ACTION_INVALID', 'fillFormFields.values 必须是有效 JSON 对象', { reason: String(error && error.message || error) }); }
      }
      fieldsInput = Object.keys(values || {}).map(function (key) {
        var selectorLike = /^[.#\[]/.test(key) || /(?:\s[>+~]\s|::?|\]|=)/.test(key);
        return selectorLike ? { selector: key, value: values[key] } : { label: key, value: values[key] };
      });
    }
    if (!fieldsInput.length) throw pageError('ACTION_INVALID', 'fillFormFields 至少需要一个字段', { fields: 0 });
    return fieldsInput;
  }

  function businessState(context, kind, confirmed, details) {
    context.derivedFacts.businessState = Object.assign({
      kind: String(kind || context.intent.kind || ''),
      confirmed: confirmed === true,
    }, details || {});
    return context.derivedFacts.businessState;
  }

  function perform(context, operation, input) {
    return context.engine.perform(operation, input || {});
  }

  async function refreshTarget(context, resolved) {
    if (!resolved || !resolved.targetRef) return null;
    try {
      return await perform(context, 'target.resolve', {
        locator: {},
        targetRef: resolved.targetRef,
        options: { wait: false, visible: false, requireGeometry: false },
      });
    } catch (error) {
      if (/^(?:TARGET_NOT_FOUND|TARGET_STALE|PAGE_STATE_UNAVAILABLE)$/.test(String(error && error.code || ''))) return null;
      throw error;
    }
  }

  function normalizedText(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function selectedValueConfirmed(target, selectedOption, input) {
    target = target && target.target || {};
    var attributes = target.attributes || {};
    var actualValues = [target.value, target.text, target.name, attributes['aria-valuetext']]
      .map(normalizedText).filter(Boolean);
    var expectedValues = [
      selectedOption && selectedOption.value,
      selectedOption && selectedOption.text,
      input.value,
      selectionText(input),
    ].map(normalizedText).filter(Boolean);
    return expectedValues.some(function (expected) {
      return actualValues.some(function (actual) { return actual === expected; });
    });
  }

  function fileNameFromValue(value) {
    var parts = String(value || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  function createPageStandardActions() {
    if (!factContract || typeof factContract.PageFactError !== 'function') {
      throw new Error('PageStandardActions requires PageFactContract');
    }

    async function executeClick(context) {
      var input = context.input;
      var coordinates = context.resolved && context.resolved.coordinates;
      var clickKind = String(context.intent.kind || 'click');
      await perform(context, 'pointer.show', { kind: clickKind, resolved: context.resolved });
      await perform(context, 'pointer.click', { point: coordinates, clickType: clickKind });
      if (input.activation === 'keyboard' || input.activation === 'both') {
        await perform(context, 'keyboard.press', { key: 'Enter', modifiers: 0 });
      }
      context.derivedFacts.activation = String(input.activation || 'mouse');
      return { resolved: context.resolved };
    }

    async function executeHover(context) {
      var coordinates = context.resolved && context.resolved.coordinates;
      await perform(context, 'pointer.show', { kind: 'hover', resolved: context.resolved });
      await perform(context, 'pointer.move', { point: coordinates });
      return { resolved: context.resolved };
    }

    async function executePress(context) {
      var resolved = context.resolved;
      if (resolved) {
        await perform(context, 'pointer.show', { kind: 'press', resolved: resolved });
        await perform(context, 'pointer.click', { point: resolved.coordinates, clickType: 'click' });
      }
      var combination = keyCombination(context.input.key || 'Enter');
      await perform(context, 'keyboard.press', combination);
      context.derivedFacts.key = combination.key;
      context.derivedFacts.modifiers = combination.modifiers;
      return { resolved: resolved };
    }

    async function executeFill(context) {
      var input = context.input;
      var resolved = context.resolved;
      var targetType = String(resolved.target.attributes && resolved.target.attributes.type || '').toLowerCase();
      var targetRole = String(resolved.target.role || '').toLowerCase();
      if (resolved.target.tag === 'select' || /^(?:combobox|listbox)$/.test(targetRole)) {
        context.derivedFacts.effectiveKind = 'select';
        if (input.optionText === undefined && input.value !== undefined) input.optionText = input.value;
        return executeSelect(context);
      }
      if (/^(?:checkbox|radio)$/.test(targetType) || /^(?:checkbox|radio|switch)$/.test(targetRole)) {
        context.derivedFacts.effectiveKind = 'check';
        if (input.checked === undefined) input.checked = booleanInput(input.value, true);
        return executeCheck(context);
      }
      if (resolved.target.editable !== true) {
        throw pageError('INVALID_ACTION_INPUT', '填写目标不是可编辑控件', { targetRef: resolved.targetRef });
      }
      context.derivedFacts.effectiveKind = 'fill';
      var text = String(input.value === undefined ? input.text || '' : input.value);
      var valueBefore = resolved.target.value === null || resolved.target.value === undefined ? '' : String(resolved.target.value);
      var commit = String(input.commit || '').toLowerCase();
      var replace = input.replace !== undefined ? input.replace !== false : context.intent.kind !== 'type';
      await perform(context, 'pointer.show', { kind: 'fill', resolved: resolved });
      await perform(context, 'pointer.click', { point: resolved.coordinates, clickType: 'click' });
      if (replace) {
        var info = await perform(context, 'platform.read');
        await perform(context, 'keyboard.press', { key: 'a', modifiers: info.os === 'mac' ? 4 : 2 });
        await perform(context, 'keyboard.press', { key: 'Backspace', modifiers: 0 });
      }
      await perform(context, 'text.insert', { text: text });
      if (commit === 'enter') await perform(context, 'keyboard.press', { key: 'Enter', modifiers: 0 });
      else if (commit === 'tab') await perform(context, 'keyboard.press', { key: 'Tab', modifiers: 0 });
      var refreshed = await refreshTarget(context, resolved);
      var valueAfter = refreshed && refreshed.target && refreshed.target.value;
      var confirmed = refreshed !== null && (replace
        ? String(valueAfter === null || valueAfter === undefined ? '' : valueAfter) === text
        : (text ? String(valueAfter === null || valueAfter === undefined ? '' : valueAfter) !== valueBefore : true));
      context.derivedFacts.valueBefore = valueBefore;
      context.derivedFacts.valueAfter = valueAfter === undefined ? null : valueAfter;
      context.derivedFacts.valueExpected = replace ? text : null;
      businessState(context, 'fill', confirmed, {
        targetRef: resolved.targetRef,
        expectedValue: replace ? text : null,
        actualValue: valueAfter === undefined ? null : valueAfter,
      });
      return { resolved: refreshed || resolved };
    }

    async function resolveCustomOption(context, resolved) {
      var input = context.input;
      var mode = selectionMode(input);
      var dropdownIndex = input.optionIndex;
      if (Number(input.optionIndexBase) === 0 && Number.isInteger(Number(dropdownIndex)) && Number(dropdownIndex) >= 0) dropdownIndex = Number(dropdownIndex) + 1;
      if (dropdownIndex === undefined || dropdownIndex === null || dropdownIndex === '') {
        if (mode === 'first') dropdownIndex = 1;
        else if (mode === 'last') dropdownIndex = -1;
        else if (mode === 'random') dropdownIndex = 'random';
      }
      var optionLocator = {
        selector: input.optionSelector || DEFAULT_CUSTOM_OPTION_SELECTOR,
        text: /^(?:first|last|random|index|value)$/.test(mode) ? '' : String(selectionText(input)),
        exact: mode === 'exact',
        elementIndex: dropdownIndex,
        frameId: resolved.target.frameId || '',
      };
      var optionDeadline = Date.now() + Math.max(100, Math.min(Number(input.dropdownWaitMs) || 5000, 30000));
      var stableMissMs = Math.max(0, Math.min(Number(input.dropdownEmptyWaitMs) || 0, 30000));
      var missingSince = 0;
      while (true) {
        var optionTarget = null;
        try {
          if (mode === 'value') {
            var first = await perform(context, 'target.resolve', { locator: Object.assign({}, optionLocator, { elementIndex: 1 }), targetRef: null });
            var count = Math.max(1, Number(first.count) || 1);
            var expected = String(input.value === undefined ? '' : input.value);
            for (var optionIndex = 1; optionIndex <= count; optionIndex += 1) {
              var candidate = optionIndex === 1 ? first : await perform(context, 'target.resolve', { locator: Object.assign({}, optionLocator, { elementIndex: optionIndex }), targetRef: null });
              var attributes = candidate.target && candidate.target.attributes || {};
              var candidateValue = candidate.target && candidate.target.value;
              if (candidateValue === null || candidateValue === undefined) candidateValue = attributes.value !== undefined ? attributes.value : attributes['data-value'];
              if (String(candidateValue === undefined ? '' : candidateValue) === expected) { optionTarget = candidate; break; }
            }
          } else {
            optionTarget = await perform(context, 'target.resolve', { locator: optionLocator, targetRef: null });
          }
        } catch (error) {
          if (!/^(?:TARGET_NOT_FOUND|TARGET_STALE|PAGE_STATE_UNAVAILABLE)$/.test(String(error && error.code || ''))) throw error;
        }
        if (optionTarget) return optionTarget;
        if (!missingSince) missingSince = Date.now();
        if (Date.now() >= optionDeadline || stableMissMs && Date.now() - missingSince >= stableMissMs) return null;
        await perform(context, 'delay', { ms: 100, operation: 'dropdown-option' });
      }
    }

    async function executeSelect(context) {
      var input = context.input;
      var resolved = context.resolved;
      if (!hasSelectionChoice(input)) {
        throw pageError('INVALID_ACTION_INPUT', '选择下拉选项必须明确填写 value、选项文本或选项索引');
      }
      var selectState = await perform(context, 'target.options', { resolved: resolved });
      await perform(context, 'pointer.show', { kind: 'select', resolved: resolved });
      if (selectState.tag === 'select') {
        var chosenIndex = selectOptionIndex(selectState.options, input);
        if (chosenIndex < 0) throw pageError('TARGET_NOT_FOUND', '未找到可选择的原生 option', { stage: 'option', input: input });
        context.derivedFacts.selectMode = 'native';
        var selectedOption = selectState.options.find(function (option) { return option.index === chosenIndex; }) || null;
        context.derivedFacts.selectedOption = selectedOption;
        if (Number(selectState.selectedIndex) === chosenIndex || selectedOption && selectedOption.selected === true) {
          context.derivedFacts.satisfiedBeforeAction = true;
          businessState(context, 'select', true, { mode: 'native', selectedOption: selectedOption });
          return { resolved: resolved };
        }
        await perform(context, 'pointer.click', { point: resolved.coordinates, clickType: 'click' });
        await perform(context, 'keyboard.press', { key: 'Home', modifiers: 0 });
        var enabledIndex = selectState.options.filter(function (option) { return !option.disabled; }).findIndex(function (option) { return option.index === chosenIndex; });
        for (var arrowIndex = 0; arrowIndex < enabledIndex; arrowIndex += 1) await perform(context, 'keyboard.press', { key: 'ArrowDown', modifiers: 0 });
        await perform(context, 'keyboard.press', { key: 'Enter', modifiers: 0 });
        var nativeAfter = null;
        try { nativeAfter = await perform(context, 'target.options', { resolved: resolved }); }
        catch (error) {
          if (!/^(?:TARGET_NOT_FOUND|TARGET_STALE|PAGE_STATE_UNAVAILABLE)$/.test(String(error && error.code || ''))) throw error;
        }
        var actualOption = nativeAfter && (nativeAfter.options || []).find(function (option) {
          return option.index === Number(nativeAfter.selectedIndex) || option.selected === true;
        }) || null;
        var nativeConfirmed = !!nativeAfter && (Number(nativeAfter.selectedIndex) === chosenIndex
          || (nativeAfter.options || []).some(function (option) { return option.index === chosenIndex && option.selected === true; }));
        context.derivedFacts.selectedOption = actualOption || selectedOption;
        businessState(context, 'select', nativeConfirmed, {
          mode: 'native', expectedIndex: chosenIndex,
          actualIndex: nativeAfter ? Number(nativeAfter.selectedIndex) : null,
          selectedOption: actualOption || selectedOption,
        });
        return { resolved: resolved };
      }
      await perform(context, 'pointer.click', { point: resolved.coordinates, clickType: 'click' });
      var searchDelayMs = Math.max(50, Number(input.searchDelayMs) || 100);
      await perform(context, 'delay', { ms: searchDelayMs, operation: 'dropdown-open' });
      if (input.search) {
        await perform(context, 'text.insert', { text: input.search });
        await perform(context, 'delay', { ms: searchDelayMs, operation: 'dropdown-search' });
      }
      var optionTarget = await resolveCustomOption(context, resolved);
      if (!optionTarget) {
        throw pageError('TARGET_NOT_FOUND', '下拉选项未在等待时间内出现', {
          stage: 'option',
          optionSelector: input.optionSelector || DEFAULT_CUSTOM_OPTION_SELECTOR,
          dropdownWaitMs: input.dropdownWaitMs || 5000,
        });
      }
      await perform(context, 'pointer.click', { point: optionTarget.coordinates, clickType: 'click' });
      context.derivedFacts.selectMode = 'custom';
      context.derivedFacts.selectedOption = { text: optionTarget.target.text || optionTarget.target.name, value: optionTarget.target.value, targetRef: optionTarget.targetRef };
      var customAfter = await refreshTarget(context, resolved);
      businessState(context, 'select', selectedValueConfirmed(customAfter, context.derivedFacts.selectedOption, input), {
        mode: 'custom', selectedOption: context.derivedFacts.selectedOption,
        actualValue: customAfter && customAfter.target ? customAfter.target.value : null,
      });
      return { resolved: customAfter || resolved };
    }

    async function executeCheck(context) {
      var input = context.input;
      var resolved = context.resolved;
      var expected = booleanInput(input.checked, true);
      var current = resolved.target.checked;
      if (typeof current !== 'boolean') {
        throw pageError('PAGE_STATE_UNAVAILABLE', '无法读取目标当前勾选状态，不能安全执行状态型点击', { targetRef: resolved.targetRef });
      }
      context.derivedFacts.checkedBefore = current;
      context.derivedFacts.checkedExpected = expected;
      if (current === expected) {
        context.derivedFacts.satisfiedBeforeAction = true;
        context.derivedFacts.checkedAfter = current;
        businessState(context, 'check', true, { expected: expected, actual: current });
        return { resolved: resolved };
      }
      var targetType = String(resolved.target.attributes && resolved.target.attributes.type || '').toLowerCase();
      var targetRole = String(resolved.target.role || '').toLowerCase();
      if (expected === false && (targetType === 'radio' || targetRole === 'radio')) {
        throw pageError('INVALID_ACTION_INPUT', '单选按钮不能通过再次点击取消；请选择同组中的其他单选项', { targetRef: resolved.targetRef });
      }
      await perform(context, 'pointer.show', { kind: 'check', resolved: resolved });
      await perform(context, 'pointer.click', { point: resolved.coordinates, clickType: 'click' });
      var checkedTarget = await refreshTarget(context, resolved);
      var checkedAfter = checkedTarget && checkedTarget.target ? checkedTarget.target.checked : null;
      context.derivedFacts.checkedAfter = checkedAfter;
      businessState(context, 'check', checkedAfter === expected, { expected: expected, actual: checkedAfter });
      return { resolved: checkedTarget || resolved };
    }

    async function executeScroll(context) {
      var input = context.input;
      var containerLocator = input.containerLocator && typeof input.containerLocator === 'object' ? input.containerLocator : null;
      if (!meaningfulLocator(containerLocator) && String(input.containerSelector || '').trim()) {
        containerLocator = { selector: String(input.containerSelector).trim() };
        if (input.containerIndex !== undefined && input.containerIndex !== null && input.containerIndex !== '') containerLocator.elementIndex = input.containerIndex;
      }
      if (!input.containerTargetRef && !meaningfulLocator(containerLocator)) {
        // An empty container selector is the documented whole-page mode for
        // scrollPage/pageAction. Resolve the document scroller explicitly so
        // the same intent works for both node and script callers.
        containerLocator = { selector: 'html' };
      }
      var resolvedContainer = await perform(context, 'target.resolve', {
        locator: containerLocator || {}, targetRef: input.containerTargetRef || null,
        options: { wait: true, visible: false },
      });
      var scrollInput = { containerTargetRef: resolvedContainer.targetRef, thresholdPx: Math.max(1, Number(input.thresholdPx) || 2) };
      var mode = canonicalScrollMode(input);
      var axis = scrollAxis(input);
      if ((mode === 'target' || mode === 'untilElement') && !context.intent.targetRef && !meaningfulLocator(context.intent.locator)) {
        throw pageError('ACTION_INVALID', '滚动到目标元素必须提供目标 locator');
      }
      // Human-like mode delegates the complete motion to Chrome's gesture
      // synthesizer. The action reads state only after the gesture finishes.
      var humanLike = booleanInput(input.humanLike, true);
      var configuredSettleMs = Number(input.settleMs);
      var settleMs = Number.isFinite(configuredSettleMs) && configuredSettleMs >= 0 ? configuredSettleMs : SCROLL_READ_INTERVAL_MS;
      var maximumRounds = Math.max(1, Math.min(Math.floor(Number(input.maxScrollRounds) || 40), 200));
      var configuredTopStableMs = Number(input.topStableMs);
      var topStableMs = Math.max(0, Math.min(Number.isFinite(configuredTopStableMs) ? configuredTopStableMs : 700, 10000));
      var current = await perform(context, 'scroll.read', { input: scrollInput });
      var initial = current;
      var configuredAmount = Number(input.amountPx);
      if (!Number.isFinite(configuredAmount)) {
        var configuredPages = Number(input.pages);
        if (Number.isFinite(configuredPages)) configuredAmount = configuredPages * Math.max(1, Number(axis === 'horizontal' ? current.clientWidth : current.clientHeight) || 1);
      }
      if (!Number.isFinite(configuredAmount)) configuredAmount = Number(axis === 'horizontal' ? input.deltaX : input.deltaY);
      if (!Number.isFinite(configuredAmount)) configuredAmount = 600;
      var wheelDispatches = 0;
      var wheelPoint = null;
      var targetResolved = null;
      var targetReached = false;

      async function sendWheel(delta) {
        var maximum = scrollMaximum(current, axis);
        var position = Math.max(0, Math.min(scrollPosition(current, axis), maximum));
        var boundedDelta = Math.max(-position, Math.min(maximum - position, Number(delta) || 0));
        if (Math.abs(boundedDelta) < 0.5) return 0;
        var x = Number(current && current.x);
        var y = Number(current && current.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw pageError('PAGE_STATE_UNAVAILABLE', '滚动容器当前没有可用的滚轮输入坐标', { bounds: current && current.bounds || null });
        }
        var before = current;
        var wheelInput = {
          point: { x: x, y: y },
          deltaX: axis === 'horizontal' ? boundedDelta : 0,
          deltaY: axis === 'vertical' ? boundedDelta : 0,
        };
        if (humanLike) {
          wheelInput.speed = HUMAN_SCROLL_SPEED_PX_PER_SECOND;
          await perform(context, 'pointer.scrollGesture', wheelInput);
        } else {
          await perform(context, 'pointer.wheel', wheelInput);
        }
        wheelDispatches += 1;
        wheelPoint = { x: x, y: y };
        await perform(context, 'delay', { ms: settleMs, operation: '滚动完成后稳定窗口' });
        current = await perform(context, 'scroll.read', { input: scrollInput });
        return scrollPosition(current, axis) - scrollPosition(before, axis);
      }

      async function resolveScrollTarget(optional) {
        try {
          return await perform(context, 'target.resolve', {
            locator: context.intent.locator || {}, targetRef: context.intent.targetRef || null,
            options: { wait: false, visible: false },
          });
        }
        catch (error) {
          if (optional && /^(?:TARGET_NOT_FOUND|PAGE_STATE_UNAVAILABLE)$/.test(String(error && error.code || ''))) return null;
          throw error;
        }
      }

      async function stableAtTop() {
        if (!topStableMs) return true;
        var stableSince = Date.now();
        while (Date.now() - stableSince < topStableMs) {
          await perform(context, 'delay', {
            ms: Math.min(SCROLL_READ_INTERVAL_MS, topStableMs - (Date.now() - stableSince)),
            operation: '到顶稳定窗口',
          });
          current = await perform(context, 'scroll.read', { input: scrollInput });
          if (!scrollBoundaryReached(current, axis, -1, scrollInput.thresholdPx)) return false;
        }
        return true;
      }

      if (mode === 'amount') {
        var requestedMagnitude = Math.abs(configuredAmount);
        if (!requestedMagnitude) context.derivedFacts.satisfiedBeforeAction = true;
        if (requestedMagnitude) {
          await sendWheel(configuredAmount);
          // At a scroll boundary sendWheel intentionally does not dispatch an
          // input command because the requested delta is clamped to zero. The
          // requested amount is therefore already satisfied by the page's
          // reachable state; keep this no-op from being misreported as an
          // undelivered browser command by Flow verification.
          if (!wheelDispatches && scrollBoundaryReached(current, axis, configuredAmount < 0 ? -1 : 1, scrollInput.thresholdPx)) {
            context.derivedFacts.satisfiedBeforeAction = true;
          }
        }
      } else if (mode === 'top' || mode === 'bottom') {
        var boundaryDirection = mode === 'top' ? -1 : 1;
        var boundaryStep = Math.max(1, Math.abs(configuredAmount) || 600);
        var boundaryConfirmed = scrollBoundaryReached(current, axis, boundaryDirection, scrollInput.thresholdPx)
          && (mode !== 'top' || await stableAtTop());
        if (boundaryConfirmed) context.derivedFacts.satisfiedBeforeAction = true;
        for (var boundaryRound = 0; boundaryRound < maximumRounds; boundaryRound += 1) {
          if (boundaryConfirmed) break;
          var atBoundary = scrollBoundaryReached(current, axis, boundaryDirection, scrollInput.thresholdPx);
          if (atBoundary) {
            boundaryConfirmed = mode !== 'top' || await stableAtTop();
            if (boundaryConfirmed) break;
          }
          var boundaryRemaining = boundaryDirection < 0 ? scrollPosition(current, axis) : scrollMaximum(current, axis) - scrollPosition(current, axis);
          var boundaryDelta = humanLike
            ? Math.min(HUMAN_SCROLL_MAX_GESTURE_PX, boundaryRemaining)
            : Math.max(boundaryStep, boundaryRemaining);
          var boundaryMovement = await sendWheel(boundaryDirection * boundaryDelta);
          if (Math.abs(boundaryMovement) < 0.5 && scrollBoundaryReached(current, axis, boundaryDirection, scrollInput.thresholdPx)) {
            boundaryConfirmed = mode !== 'top' || await stableAtTop();
            if (boundaryConfirmed) break;
          }
        }
        if (!boundaryConfirmed && scrollBoundaryReached(current, axis, boundaryDirection, scrollInput.thresholdPx)) {
          boundaryConfirmed = mode !== 'top' || await stableAtTop();
        }
        if (!boundaryConfirmed) {
          throw pageError('ACTION_INCOMPLETE', mode === 'top' ? '达到最大滚动轮数后仍未稳定到顶' : '达到最大滚动轮数后仍未滚动到底', {
            maxScrollRounds: maximumRounds,
            scrollPosition: scrollPosition(current, axis),
            scrollMaximum: scrollMaximum(current, axis),
          });
        }
      } else {
        var optionalTarget = mode === 'untilElement';
        var targetStep = Math.max(1, Math.abs(configuredAmount) || 600);
        var targetFallbackDirection = configuredAmount < 0 ? -1 : 1;
        for (var targetRound = 0; targetRound <= maximumRounds; targetRound += 1) {
          targetResolved = await resolveScrollTarget(optionalTarget);
          if (scrollTargetVisible(targetResolved, current)) {
            targetReached = true;
            if (!wheelDispatches) context.derivedFacts.satisfiedBeforeAction = true;
            break;
          }
          if (targetRound === maximumRounds) break;
          var targetDirection = scrollTargetDirection(targetResolved, current, axis, targetFallbackDirection);
          var targetMovement = await sendWheel(targetDirection * targetStep);
          if (Math.abs(targetMovement) < 0.5 && scrollBoundaryReached(current, axis, targetDirection, scrollInput.thresholdPx)) break;
        }
        if (!targetReached) {
          throw pageError('TARGET_NOT_FOUND', mode === 'untilElement' ? '达到滚动终止条件前未找到目标元素' : '目标元素未能滚动到容器可见区域', {
            maxScrollRounds: maximumRounds,
          });
        }
      }
      context.derivedFacts.wheelDispatches = wheelDispatches;
      context.derivedFacts.wheelPoint = wheelPoint;
      context.derivedFacts.scrollMode = mode;
      context.derivedFacts.scrollAxis = axis;
      context.derivedFacts.targetReached = mode === 'target' || mode === 'untilElement' ? targetReached : null;
      context.derivedFacts.scrollAfter = scrollFacts(initial, current, axis);
      var applied = axis === 'horizontal'
        ? Number(context.derivedFacts.scrollAfter.appliedX) || 0
        : Number(context.derivedFacts.scrollAfter.appliedY) || 0;
      var amountConfirmed = mode !== 'amount' || !Math.abs(configuredAmount)
        || applied * (configuredAmount < 0 ? -1 : 1) > 0
        || scrollBoundaryReached(current, axis, configuredAmount < 0 ? -1 : 1, scrollInput.thresholdPx);
      businessState(context, 'scroll', mode === 'amount' ? amountConfirmed : true, {
        mode: mode, axis: axis, targetReached: context.derivedFacts.targetReached,
        appliedX: context.derivedFacts.scrollAfter.appliedX,
        appliedY: context.derivedFacts.scrollAfter.appliedY,
      });
      return { resolved: targetResolved || resolvedContainer, context: targetResolved && targetResolved.context || resolvedContainer.context };
    }

    async function executeDrag(context) {
      var input = context.input;
      var resolved = context.resolved;
      var dragTargetRef = input.targetTargetRef || input.dropTargetRef || null;
      var targetLocator = dragTargetRef ? {} : {
        selector: input.targetSelector || '', text: input.targetText || '', ref: input.targetRefName || '',
        elementIndex: input.targetIndex, frameId: input.targetFrameId || resolved.target && resolved.target.frameId || '',
      };
      var targetResolved = await perform(context, 'target.resolve', {
        locator: targetLocator, targetRef: dragTargetRef, options: { wait: true },
      });
      var from = resolved.coordinates;
      var to = targetResolved.coordinates;
      var steps = Math.max(2, Math.min(Number(input.steps) || 12, 60));
      await perform(context, 'pointer.show', { kind: 'drag', resolved: resolved });
      var dragData = normalizeDragData(input);
      await perform(context, 'pointer.drag', { from: from, to: to, steps: steps, dragData: dragData });
      context.derivedFacts.dragTargetRef = targetResolved.targetRef;
      context.derivedFacts.dragSource = { targetRef: resolved.targetRef, coordinates: from };
      context.derivedFacts.dragDestination = { targetRef: targetResolved.targetRef, coordinates: to };
      return { resolved: resolved, context: targetResolved.context };
    }

    async function executeUpload(context) {
      var input = context.input;
      var resolved = context.resolved;
      var temp = await perform(context, 'file.materialize', { input: input });
      await perform(context, 'file.set', { resolved: resolved, path: temp.path });
      var refreshed = await refreshTarget(context, resolved);
      var targetValue = refreshed && refreshed.target ? refreshed.target.value : null;
      var expectedFileName = String(temp.fileName || input.fileName || '');
      var actualFileName = fileNameFromValue(targetValue);
      var confirmed = !!expectedFileName && actualFileName === expectedFileName;
      context.derivedFacts.upload = {
        fileName: expectedFileName,
        byteLength: temp.byteLength,
        materialized: true,
        cleanupDeferred: true,
        targetValue: targetValue,
        fileInputConfirmed: confirmed,
      };
      businessState(context, 'upload', confirmed, {
        targetRef: resolved.targetRef,
        expectedFileName: expectedFileName,
        actualFileName: actualFileName,
      });
      return { resolved: refreshed || resolved };
    }

    async function executeTarget(kind, context) {
      context.input = context.intent.input || {};
      if (/^(?:click|doubleClick|contextClick)$/.test(kind)) return executeClick(context);
      if (kind === 'hover') return executeHover(context);
      if (kind === 'press') return executePress(context);
      if (kind === 'type' || kind === 'fill') return executeFill(context);
      if (kind === 'select') return executeSelect(context);
      if (kind === 'check') return executeCheck(context);
      if (kind === 'scroll') return executeScroll(context);
      if (kind === 'drag') return executeDrag(context);
      if (kind === 'upload') return executeUpload(context);
      throw pageError('ACTION_INVALID', 'PageStandardActions 不支持动作: ' + kind);
    }

    async function executeForm(input, context) {
      var fieldsInput = formFields(input);
      var results = [];
      var browserFacts = { facts: [], newTabs: [], ambiguous: false };
      var scopeSelector = String(input.selector || input.scopeSelector || '');
      var scopeRef = String(input.ref || input.scopeRef || '');
      for (var index = 0; index < fieldsInput.length; index += 1) {
        var field = fieldsInput[index] || {};
        var kind = field.kind === 'select' ? 'select' : (field.kind === 'check' || field.checked !== undefined ? 'check' : 'fill');
        var fieldSelector = String(field.selector || '');
        var dropdownSearch = [field.search, input.dropdownSearch, field.optionText, field.value].find(function (value) {
          return value !== undefined && value !== null && String(value).trim() !== '';
        });
        if (scopeSelector && fieldSelector) fieldSelector = scopeSelector + ' ' + fieldSelector;
        var child = await context.executeField({
          field: field,
          kind: kind,
          locator: { selector: fieldSelector, label: fieldSelector ? '' : field.label || '', scopeSelector: fieldSelector ? '' : scopeSelector, scopeRef: fieldSelector ? '' : scopeRef, elementIndex: field.elementIndex },
          input: Object.assign({}, input, field, { search: dropdownSearch === undefined ? '' : dropdownSearch, value: field.value, checked: field.checked }),
        });
        (child.browserFacts && child.browserFacts.facts || []).forEach(function (fact) { browserFacts.facts.push(fact); });
        var childTarget = child.receipt && child.receipt.newNavigationTarget;
        (childTarget && childTarget.candidates || []).forEach(function (candidate) {
          if (!browserFacts.newTabs.some(function (existing) { return Number(existing.tabId) === Number(candidate.tabId); })) browserFacts.newTabs.push(candidate);
        });
        if (childTarget && childTarget.ambiguous === true) browserFacts.ambiguous = true;
        var allowedEmpty = kind === 'select' && (field.allowEmptyOptions === true || input.allowEmptyOptions === true)
          && child.receipt.status === 'failed' && child.error && child.error.code === 'TARGET_NOT_FOUND'
          && child.error.details && child.error.details.stage === 'option';
        results.push({ field: field.label || field.selector || String(index), kind: kind, receipt: child.receipt, error: child.error, skipped: allowedEmpty });
        var childUnconfirmedButPerformed = child.receipt.status === 'unconfirmed' && child.receipt.performed === 'yes';
        var childDeferred = context.confirmationDeferred && child.receipt.status === 'unconfirmed';
        if (child.receipt.status !== 'confirmed' && !allowedEmpty && !childUnconfirmedButPerformed && !childDeferred && input.stopOnError !== false) break;
      }
      return { fields: fieldsInput, results: results, browserFacts: browserFacts };
    }

    function prepareDialog(input) {
      var action = String(input.action || 'accept').toLowerCase();
      if (!/^(?:accept|dismiss|read)$/.test(action)) {
        throw pageError('INVALID_ACTION_INPUT', '不支持的原生弹窗动作: ' + action);
      }
      return { action: action, promptText: String(input.promptText || '') };
    }

    function preparePatch(input) {
      var action = String(input.action || 'hide');
      if (!String(input.selector || '').trim()) throw pageError('INVALID_ACTION_INPUT', '页面补丁必须提供 selector');
      if (!/^(?:remove|hide|style|attribute|removeAttribute|enable)$/.test(action)) {
        throw pageError('INVALID_ACTION_INPUT', '不支持的页面补丁动作: ' + action);
      }
      if (/^(?:style|attribute|removeAttribute)$/.test(action) && !String(input.name || '').trim()) {
        throw pageError('INVALID_ACTION_INPUT', '页面补丁动作 ' + action + ' 必须提供 name');
      }
      if (/^(?:style|attribute)$/.test(action)
          && (input.value === undefined || input.value === null || String(input.value).trim() === '')) {
        throw pageError('INVALID_ACTION_INPUT', '页面补丁动作 ' + action + ' 必须提供 value');
      }
      return Object.assign({}, input, { action: action });
    }

    function completePatch(input, result) {
      if (!(Number(result && result.matched) > 0)) {
        throw pageError('TARGET_NOT_FOUND', '页面补丁选择器未匹配任何元素', { selector: input.selector });
      }
      return result;
    }

    function prepareStorage(input) {
      input = input || {};
      var action = String(input.action || 'get').toLowerCase();
      if (!/^(?:get|set|remove|clear)$/.test(action)) {
        throw pageError('INVALID_ACTION_INPUT', '不支持的页面存储动作: ' + action);
      }
      if (/^(?:set|remove)$/.test(action) && !String(input.key || '').trim()) {
        throw pageError('INVALID_ACTION_INPUT', '页面存储动作 ' + action + ' 必须提供 key');
      }
      if (action === 'set' && (input.value === undefined || input.value === null)) {
        throw pageError('INVALID_ACTION_INPUT', '页面存储动作 set 必须提供 value');
      }
      return Object.assign({}, input, {
        action: action,
        storageType: String(input.storageType || 'local').toLowerCase(),
      });
    }

    function completeStorage(input, result) {
      var confirmed = !!(result && (result.confirmed === true || input.action === 'get'));
      return {
        result: result,
        businessState: {
          kind: 'webStorage',
          action: input.action,
          confirmed: confirmed,
          key: input.key === undefined ? null : String(input.key),
        },
      };
    }

    return Object.freeze({
      handlesTarget: function (kind) { return TARGET_KINDS.indexOf(String(kind || '')) !== -1; },
      executeTarget: executeTarget,
      executeForm: executeForm,
      prepareDialog: prepareDialog,
      preparePatch: preparePatch,
      completePatch: completePatch,
      prepareStorage: prepareStorage,
      completeStorage: completeStorage,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, createPageStandardActions: createPageStandardActions });
});
