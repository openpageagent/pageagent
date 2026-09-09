(function installConversationRecorder(root) {
  'use strict';
  if (root.__pageAutomationConversationRecorderInstalled) return;
  var contract = root.PageAutomationRecordingContract;
  if (!contract || contract.API_VERSION !== 1) throw new Error('RecordingContract must load before conversation-recorder');
  var positionControllerApi = root.PageAutomationPageElementPositionController;
  if (!positionControllerApi || typeof positionControllerApi.createFree !== 'function') {
    throw new Error('PageElementPositionController must load before conversation-recorder');
  }
  root.__pageAutomationConversationRecorderInstalled = true;

  var state = 'dormant';
  var recordingId = '';
  var capability = '';
  var startedAt = 0;
  var localNonce = randomId('document');
  var localSequence = 0;
  var batchSequence = 0;
  var queue = [];
  var ring = [];
  var ringDropped = 0;
  var pendingDiagnostics = [];
  var capturedCount = 0;
  var localLimitRequested = false;
  var fillPending = new Map();
  var batchTimer = 0;
  var normalOutbox = [];
  var normalSending = false;
  var normalRetryTimer = 0;
  var normalStopped = false;
  var normalDeliveryEpoch = 0;
  var indicatorHost = null;
  var indicatorCount = null;
  var indicatorTime = null;
  var indicatorStopButton = null;
  var indicatorBar = null;
  var indicatorPositionController = null;
  var indicatorTimer = 0;
  var extensionUiGuard = null;
  var stopRequestedAt = 0;
  var listenersInstalled = false;
  var lastFinalBatch = null;
  var INDICATOR_POSITION_STORAGE_KEY = 'page-agent-recording-indicator-position';

  function randomId(prefix) {
    localSequence += 1;
    var random = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2);
    return prefix + '_' + random + '_' + localSequence.toString(36);
  }
  function now() { return Date.now(); }
  function send(type, payload) {
    try { return Promise.resolve(chrome.runtime.sendMessage({ type: type, payload: payload || {} })); }
    catch (error) { return Promise.reject(error); }
  }
  function composedElements(event) {
    var path = event && typeof event.composedPath === 'function' ? event.composedPath() : [event && event.target];
    return path.filter(function (item) { return item && item.nodeType === 1; });
  }
  function isExtensionUi(event) {
    return composedElements(event).some(function (element) {
      return element === indicatorHost || element.hasAttribute && (element.hasAttribute('data-page-automation-ui') || element.id === 'page-automation-page-conversation');
    });
  }
  function hideExtensionUi() {
    if (root.top !== root || extensionUiGuard || !document.documentElement) return;
    extensionUiGuard = document.createElement('style');
    extensionUiGuard.setAttribute('data-page-automation-recording-ui-guard', '');
    extensionUiGuard.textContent = '[data-page-automation-ui]:not([data-page-automation-ui="conversation-recording-indicator"]){display:none!important}';
    document.documentElement.appendChild(extensionUiGuard);
  }
  function restoreExtensionUi() {
    if (extensionUiGuard && extensionUiGuard.parentNode) extensionUiGuard.parentNode.removeChild(extensionUiGuard);
    extensionUiGuard = null;
  }
  function interactiveTarget(event) {
    var elements = composedElements(event);
    var target = elements[0] || event.target;
    var current = target;
    var namedFallback = null;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < 8) {
      var tag = String(current.tagName || '').toLowerCase();
      var role = String(current.getAttribute && current.getAttribute('role') || '').toLowerCase();
      if (/^(?:a|button|input|select|textarea|summary|label)$/.test(tag)
          || /^(?:button|link|checkbox|radio|tab|menuitem|option)$/.test(role)
          || current.isContentEditable) return tag === 'label' && current.control ? current.control : current;
      var hasClickContract = !!(current.onclick || current.getAttribute && current.getAttribute('onclick'));
      var focusable = Number(current.tabIndex) >= 0;
      var pointer = false;
      try { pointer = root.getComputedStyle && root.getComputedStyle(current).cursor === 'pointer'; } catch (_) {}
      var pointerContract = pointer && current.matches && current.matches('[class*="button"],[class*="btn"],[class*="click"],[class*="toggle"],[class*="menu"],[class*="link"],[class*="item"],[class*="card"]');
      if (hasClickContract || focusable || pointerContract) return current;
      if (!namedFallback && accessibleName(current)) namedFallback = current;
      current = current.parentElement;
      depth += 1;
    }
    return namedFallback || (target && target.nodeType === 1 ? target : null);
  }
  function cssEscape(value) {
    return root.CSS && typeof root.CSS.escape === 'function' ? root.CSS.escape(String(value)) : String(value).replace(/([^A-Za-z0-9_-])/g, '\\$1');
  }
  function dynamicToken(value) {
    value = String(value || '');
    return !value || value.length > 48 || /^\d/.test(value) || /(?:^|[-_])(?:css|jss|sc|svelte|chakra|emotion)[-_]/i.test(value)
      || /[a-f0-9]{10,}/i.test(value) && /\d/.test(value);
  }
  function compactText(value, max) {
    value = String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, ' ');
    return value.slice(0, Math.max(1, Number(max) || 500));
  }
  function referencedText(element, attribute) {
    if (!element || !element.getAttribute) return '';
    var ids = compactText(element.getAttribute(attribute), 500).split(/\s+/).filter(Boolean);
    var values = ids.map(function (id) {
      var referenced = element.ownerDocument && element.ownerDocument.getElementById(id);
      return referenced ? compactText(referenced.innerText || referenced.textContent || '', 500) : '';
    }).filter(Boolean);
    return compactText(values.join(' '), 500);
  }
  function accessibleName(element) {
    if (!element) return '';
    var direct = compactText(element.getAttribute && element.getAttribute('aria-label'), 500);
    if (direct) return direct;
    var labelled = referencedText(element, 'aria-labelledby');
    if (labelled) return labelled;
    if (element.labels && element.labels.length) {
      var label = compactText(Array.prototype.map.call(element.labels, function (item) {
        return item && (item.innerText || item.textContent) || '';
      }).join(' '), 500);
      if (label) return label;
    }
    var visible = compactText(element.innerText || element.textContent || '', 500);
    if (visible) return visible;
    var title = compactText(element.getAttribute && element.getAttribute('title'), 500);
    if (title) return title;
    var alt = compactText(element.getAttribute && element.getAttribute('alt'), 500);
    if (alt) return alt;
    var image = element.querySelector && element.querySelector('img[alt],svg title');
    if (image) {
      var imageText = compactText(image.getAttribute && image.getAttribute('alt') || image.textContent || '', 500);
      if (imageText) return imageText;
    }
    var tag = String(element.tagName || '').toLowerCase();
    var type = String(element.type || '').toLowerCase();
    if ((tag === 'button' || tag === 'input' && /^(?:button|submit|reset)$/.test(type)) && element.value) {
      return compactText(element.value, 500);
    }
    return '';
  }
  function nearbyContext(element) {
    if (!element) return '';
    var controlled = compactText(element.getAttribute && element.getAttribute('aria-controls'), 256);
    if (controlled && element.ownerDocument) {
      var controlledElement = element.ownerDocument.getElementById(controlled);
      var controlledName = controlledElement && accessibleName(controlledElement);
      if (controlledName) return controlledName;
    }
    var siblings = [element.nextElementSibling, element.previousElementSibling];
    for (var index = 0; index < siblings.length; index += 1) {
      var siblingName = accessibleName(siblings[index]);
      if (siblingName) return siblingName;
    }
    var parent = element.parentElement;
    if (parent && parent.children) {
      for (var childIndex = 0; childIndex < parent.children.length; childIndex += 1) {
        var child = parent.children[childIndex];
        if (child === element || !child.matches || !child.matches('a,label,button,[role="link"],[role="heading"],.nav-link')) continue;
        var childName = accessibleName(child);
        if (childName) return childName;
      }
    }
    return compactText(parent && parent.getAttribute && parent.getAttribute('aria-label'), 500);
  }
  function landmarkContext(element) {
    var current = element && element.parentElement;
    var depth = 0;
    while (current && depth < 6) {
      var tag = String(current.tagName || '').toLowerCase();
      var role = String(current.getAttribute && current.getAttribute('role') || '').toLowerCase();
      var landmark = /^(?:nav|header|main|aside|section|form)$/.test(tag)
        || /^(?:navigation|banner|main|complementary|region|form|menu|menubar)$/.test(role);
      if (landmark) {
        var landmarkName = compactText(current.getAttribute && current.getAttribute('aria-label'), 500);
        if (!landmarkName) {
          var heading = current.querySelector && current.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
          landmarkName = accessibleName(heading);
        }
        return { tag: tag, role: role, name: landmarkName };
      }
      current = current.parentElement;
      depth += 1;
    }
    return null;
  }
  function targetPurpose(element) {
    if (!element) return 'element';
    var tag = String(element.tagName || '').toLowerCase();
    var type = String(element.type || '').toLowerCase();
    var role = String(element.getAttribute && element.getAttribute('role') || '').toLowerCase();
    var tokens = [element.id, element.className && typeof element.className === 'string' ? element.className : ''].join(' ');
    if (type === 'checkbox' || role === 'checkbox') return 'checkbox';
    if (type === 'radio' || role === 'radio') return 'radio';
    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select';
    if (tag === 'textarea' || tag === 'input' || element.isContentEditable) return 'input';
    if (element.getAttribute && (element.getAttribute('aria-expanded') !== null || element.getAttribute('aria-haspopup'))
        || /(?:^|[-_\s])(?:toggle|expand|collapse|burger|menu)(?:$|[-_\s])/i.test(tokens)) return 'toggle';
    if (type === 'submit') return 'submit';
    return tag === 'button' || role === 'button' ? 'button' : (role || tag || 'element');
  }
  function stableClasses(element) {
    if (!element || !element.classList) return [];
    return Array.prototype.filter.call(element.classList, function (value) { return !dynamicToken(value); }).slice(0, 8);
  }
  function attrSelector(name, value) { return '[' + name + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'; }
  function selectorFor(element) {
    if (!element || !element.tagName) return null;
    var tag = element.tagName.toLowerCase();
    var candidates = [];
    ['data-testid', 'data-test', 'data-cy', 'data-qa'].forEach(function (name) {
      var value = element.getAttribute(name);
      if (value) candidates.push(tag + attrSelector(name, value));
    });
    if (element.id && !dynamicToken(element.id)) candidates.push('#' + cssEscape(element.id));
    ['name', 'aria-label', 'aria-labelledby', 'title', 'placeholder'].forEach(function (name) {
      var value = element.getAttribute(name);
      if (value) candidates.push(tag + attrSelector(name, value));
    });
    var selector = '';
    for (var index = 0; index < candidates.length; index += 1) {
      try { if (element.ownerDocument.querySelectorAll(candidates[index]).length === 1) { selector = candidates[index]; break; } }
      catch (_) {}
    }
    if (!selector) selector = candidates[0] || boundedPath(element);
    var visibleText = compactText(element.innerText || element.textContent || '', 500);
    var label = accessibleName(element);
    var result = {};
    if (selector) result.selector = selector.slice(0, 1000);
    if (visibleText) result.textSelector = visibleText.slice(0, 500);
    if (label) result.label = label.slice(0, 500);
    return Object.keys(result).length ? result : null;
  }
  function boundedPath(element) {
    var parts = [];
    var current = element;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < 8) {
      var tag = String(current.tagName || '').toLowerCase();
      if (!tag) break;
      if (tag === 'html' || tag === 'body') { parts.unshift(tag); break; }
      var position = 1;
      var sibling = current;
      while ((sibling = sibling.previousElementSibling)) if (sibling.tagName === current.tagName) position += 1;
      parts.unshift(tag + ':nth-of-type(' + position + ')');
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(' > ').slice(0, 1000);
  }
  function targetData(element, locator) {
    if (!element) return null;
    var rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
    var name = accessibleName(element);
    var context = nearbyContext(element);
    var landmark = landmarkContext(element);
    var purpose = targetPurpose(element);
    var path = compactText(locator && locator.selector || boundedPath(element), 1000);
    var description = name || (context ? purpose + ' for ' + context : purpose + (path ? ' at ' + path : ''));
    var stateBefore = {};
    if (element.checked !== undefined && /^(?:checkbox|radio)$/.test(String(element.type || '').toLowerCase())) stateBefore.checked = element.checked === true;
    if (element.selected !== undefined && String(element.tagName || '').toLowerCase() === 'option') stateBefore.selected = element.selected === true;
    ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked'].forEach(function (attribute) {
      var value = element.getAttribute && element.getAttribute(attribute);
      if (value !== null && value !== '') stateBefore[attribute.replace('aria-', '')] = String(value);
    });
    return {
      tag: String(element.tagName || '').toLowerCase(),
      type: String(element.type || ''),
      role: String(element.getAttribute && element.getAttribute('role') || '').toLowerCase(),
      name: name,
      text: compactText(element.innerText || element.textContent || '', 500),
      title: compactText(element.getAttribute && element.getAttribute('title'), 500),
      context: context,
      landmark: landmark,
      purpose: purpose,
      description: compactText(description, 1000),
      selectorHint: path,
      classes: stableClasses(element),
      stateBefore: stateBefore,
      shadow: rootNode && rootNode !== document ? 'open' : '',
    };
  }
  function eventFor(kind, payload, occurredAt) {
    return { localEventId: randomId('event'), occurredAt: Number(occurredAt) || now(), kind: kind, payload: payload || {} };
  }
  function queueEvent(kind, payload, immediate) {
    if (capturedCount >= contract.LIMITS.MAX_CANDIDATE_EVENTS) return;
    var value = eventFor(kind, payload);
    capturedCount += 1;
    if (state === 'pending') {
      ring.push(value);
      if (ring.length > contract.LIMITS.CONTENT_RING_EVENTS) { ring.shift(); ringDropped += 1; }
      return;
    }
    if (state !== 'enabled') return;
    queue.push(value);
    if (immediate || queue.length >= contract.LIMITS.CONTENT_BATCH_EVENTS) flushBatch(false, '');
    else scheduleBatch();
    if (capturedCount >= contract.LIMITS.MAX_CANDIDATE_EVENTS && !localLimitRequested) {
      localLimitRequested = true;
      send(contract.UI_MESSAGES.STOP, {}).catch(function () {});
    }
  }
  function scheduleBatch() {
    if (batchTimer || state !== 'enabled') return;
    batchTimer = root.setTimeout(function () { batchTimer = 0; flushBatch(false, ''); }, contract.LIMITS.CONTENT_BATCH_DELAY_MS);
  }
  function takeBatch() {
    var value = queue.slice();
    queue.length = 0;
    return value;
  }
  function scheduleNormalRetry() {
    if (normalRetryTimer || normalStopped || state !== 'enabled') return;
    normalRetryTimer = root.setTimeout(function () {
      normalRetryTimer = 0;
      pumpNormalOutbox();
    }, 250);
  }
  function pumpNormalOutbox() {
    if (normalSending || normalStopped || state !== 'enabled' || !normalOutbox.length) return;
    var item = normalOutbox[0];
    var deliveryEpoch = normalDeliveryEpoch;
    normalSending = true;
    send(contract.DOCUMENT_MESSAGES.BATCH, item).then(function (response) {
      if (!response || response.ok !== true) throw new Error('Recording batch was not accepted');
      if (deliveryEpoch !== normalDeliveryEpoch) return;
      if (!normalStopped && normalOutbox[0] === item) normalOutbox.shift();
      normalSending = false;
      pumpNormalOutbox();
    }).catch(function () {
      if (deliveryEpoch !== normalDeliveryEpoch) return;
      normalSending = false;
      scheduleNormalRetry();
    });
  }
  function flushBatch(finalBatch, stopNonce) {
    if (batchTimer) { root.clearTimeout(batchTimer); batchTimer = 0; }
    var events = takeBatch();
    if (!events.length && !pendingDiagnostics.length && !finalBatch) return Promise.resolve({ ok: true });
    batchSequence += 1;
    var payload = {
      recordingId: recordingId, capability: capability,
      documentLocalBatchId: localNonce + ':' + batchSequence, events: events,
      diagnostics: pendingDiagnostics.slice(),
      finalBatch: finalBatch === true, stopNonce: String(stopNonce || ''),
    };
    pendingDiagnostics.length = 0;
    if (!finalBatch) {
      normalOutbox.push(payload);
      pumpNormalOutbox();
      return Promise.resolve({ ok: true, queued: true });
    }
    return send(contract.DOCUMENT_MESSAGES.BATCH, payload).then(function (response) {
      if (!response || response.ok !== true) throw new Error('Final Recording batch was not accepted');
      return response;
    });
  }
  function valueFor(element) {
    if (element.isContentEditable) return String(element.innerText !== undefined ? element.innerText : element.textContent || '');
    return String(element.value === undefined ? '' : element.value);
  }
  function fillKey(element) {
    if (!element.__pageAutomationRecordingFillKey) {
      try { Object.defineProperty(element, '__pageAutomationRecordingFillKey', { value: randomId('target') }); }
      catch (_) { return String(selectorFor(element) && selectorFor(element).selector || element.tagName || 'target'); }
    }
    return element.__pageAutomationRecordingFillKey;
  }
  function stageFill(element) {
    if (!element || element.type === 'checkbox' || element.type === 'radio' || element.type === 'file') return;
    var key = fillKey(element);
    var previous = fillPending.get(key);
    if (previous && previous.timer) root.clearTimeout(previous.timer);
    var locator = selectorFor(element);
    var pending = {
      element: element,
      payload: { locator: locator, target: targetData(element, locator), value: valueFor(element), targetKey: key,
        shadowUnreplayable: typeof ShadowRoot !== 'undefined' && element.getRootNode() instanceof ShadowRoot },
      timer: 0,
    };
    pending.timer = root.setTimeout(function () { flushFill(key); }, contract.LIMITS.FILL_DEBOUNCE_MS);
    fillPending.set(key, pending);
  }
  function flushFill(key) {
    var pending = fillPending.get(key);
    if (!pending) return;
    if (pending.timer) root.clearTimeout(pending.timer);
    fillPending.delete(key);
    queueEvent('fill', pending.payload, false);
  }
  function flushFills() { Array.from(fillPending.keys()).forEach(flushFill); }
  function modifiers(event) { return { alt: !!event.altKey, ctrl: !!event.ctrlKey, meta: !!event.metaKey, shift: !!event.shiftKey }; }
  function onClick(event) {
    if (isExtensionUi(event)) return;
    flushFills();
    var element = interactiveTarget(event);
    if (!element) return;
    var inputType = String(element.type || '').toLowerCase();
    var targetRole = String(element.getAttribute && element.getAttribute('role') || '').toLowerCase();
    var ariaChecked = String(element.getAttribute && element.getAttribute('aria-checked') || '').toLowerCase();
    var ariaExpanded = String(element.getAttribute && element.getAttribute('aria-expanded') || '').toLowerCase();
    var checkedState = inputType === 'checkbox' ? element.checked === true : (inputType === 'radio' ? true
      : (targetRole === 'checkbox' ? ariaChecked !== 'true' : (targetRole === 'radio' ? true : undefined)));
    var locator = selectorFor(element);
    queueEvent('click', {
      locator: locator, target: targetData(element, locator), targetKey: fillKey(element),
      input: { button: Number(event.button) || 0, clickCount: Number(event.detail) || 1, modifiers: modifiers(event),
        checked: checkedState, expanded: ariaExpanded === 'true' ? false : (ariaExpanded === 'false' ? true : undefined) },
      href: element.href === undefined ? undefined : String(element.href),
      shadowUnreplayable: typeof ShadowRoot !== 'undefined' && element.getRootNode() instanceof ShadowRoot,
    }, true);
  }
  function onInput(event) {
    if (isExtensionUi(event)) return;
    var element = event.target;
    if (!element || !(element.matches && element.matches('input,textarea') || element.isContentEditable)) return;
    stageFill(element);
  }
  function onChange(event) {
    if (isExtensionUi(event)) return;
    var element = event.target;
    if (!element || !element.matches) return;
    if (element.matches('select')) {
      flushFills();
      var locator = selectorFor(element);
      queueEvent('select', { locator: locator, target: targetData(element, locator), targetKey: fillKey(element), value: valueFor(element) }, true);
    } else if (element.matches('input,textarea') && element.type !== 'checkbox' && element.type !== 'radio' && element.type !== 'file') {
      stageFill(element);
      flushFill(fillKey(element));
      flushBatch(false, '');
    }
  }
  function onBlur(event) {
    var element = event.target;
    if (element && element.__pageAutomationRecordingFillKey) { flushFill(element.__pageAutomationRecordingFillKey); flushBatch(false, ''); }
  }
  function onKeydown(event) {
    if (isExtensionUi(event) || !contract.ALLOWED_KEYS[event.key]) return;
    flushFills();
    var element = interactiveTarget(event);
    var locator = selectorFor(element);
    queueEvent('key', { locator: locator, target: targetData(element, locator), targetKey: element ? fillKey(element) : '', input: { key: event.key, modifiers: modifiers(event) } }, true);
  }
  function onSubmit(event) {
    if (isExtensionUi(event)) return;
    flushFills();
    var form = event.target;
    var locator = selectorFor(form);
    queueEvent('submit', { locator: locator, target: targetData(form, locator), action: form && form.action === undefined ? undefined : String(form.action) }, true);
  }
  function onPageHide() {
    if (state !== 'enabled') return;
    flushFills();
    flushBatch(false, '');
  }
  function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('blur', onBlur, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('submit', onSubmit, true);
    root.addEventListener('pagehide', onPageHide, true);
    root.addEventListener('beforeunload', onPageHide, true);
  }
  function removeListeners() {
    if (!listenersInstalled) return;
    listenersInstalled = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('blur', onBlur, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('submit', onSubmit, true);
    root.removeEventListener('pagehide', onPageHide, true);
    root.removeEventListener('beforeunload', onPageHide, true);
  }
  function formatElapsed() {
    var elapsedAt = stopRequestedAt || now();
    var seconds = Math.max(0, Math.floor((elapsedAt - startedAt) / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }
  function updateIndicator(count) {
    if (indicatorCount && count !== undefined) indicatorCount.textContent = String(Number(count) || 0) + ' 个动作';
    if (indicatorTime) indicatorTime.textContent = formatElapsed();
    if (count !== undefined && indicatorPositionController) indicatorPositionController.refresh();
  }
  function removeIndicator() {
    if (indicatorTimer) root.clearInterval(indicatorTimer);
    indicatorTimer = 0;
    if (indicatorPositionController) indicatorPositionController.destroy();
    indicatorPositionController = null;
    if (indicatorHost) indicatorHost.remove();
    indicatorHost = indicatorBar = indicatorCount = indicatorTime = indicatorStopButton = null;
  }
  function setIndicatorStopping(stopping) {
    if (!indicatorStopButton) return;
    indicatorStopButton.disabled = stopping === true;
    indicatorStopButton.textContent = stopping === true ? '正在停止' : '停止';
    indicatorStopButton.title = stopping === true ? '正在停止页面操作录制' : '停止页面操作录制';
    indicatorStopButton.setAttribute('aria-label', indicatorStopButton.title);
  }
  function resumeAfterStopFailure() {
    if (state !== 'stop-requested') return;
    state = 'enabled';
    stopRequestedAt = 0;
    normalStopped = false;
    installListeners();
    pumpNormalOutbox();
    scheduleBatch();
    hideExtensionUi();
    showIndicator();
    setIndicatorStopping(false);
  }
  function requestStop() {
    if (state !== 'enabled') return;
    flushFills();
    state = 'stop-requested';
    stopRequestedAt = now();
    normalStopped = true;
    if (normalRetryTimer) root.clearTimeout(normalRetryTimer);
    normalRetryTimer = 0;
    if (batchTimer) root.clearTimeout(batchTimer);
    batchTimer = 0;
    removeListeners();
    setIndicatorStopping(true);
    send(contract.UI_MESSAGES.STOP, {}).then(function (response) {
      if (!response || response.ok !== true) resumeAfterStopFailure();
    }).catch(resumeAfterStopFailure);
  }
  function showIndicator() {
    if (root.top !== root || indicatorHost || !document.documentElement) return;
    indicatorHost = document.createElement('div');
    indicatorHost.setAttribute('data-page-automation-ui', 'conversation-recording-indicator');
    indicatorHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:auto;color-scheme:light';
    var shadow = indicatorHost.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = ':host{all:initial}*{box-sizing:border-box}.bar{display:flex;width:max-content;align-items:center;gap:8px;padding:8px 10px;border:1px solid #d9b3ae;border-radius:8px;background:rgba(255,250,249,.97);box-shadow:0 8px 24px rgba(62,20,16,.18);color:#5c2924;font:12px/1.3 Inter,Roboto,Arial,sans-serif;white-space:nowrap;cursor:grab;touch-action:none;user-select:none}.bar.dragging{cursor:grabbing}.dot{width:8px;height:8px;border-radius:50%;background:#ba554a;animation:pulse 1.2s ease-in-out infinite}.time{font-variant-numeric:tabular-nums;font-weight:650}.count{color:#835a56}button{height:26px;padding:0 9px;border:1px solid #ba554a;border-radius:5px;background:#ba554a;color:white;font:600 12px Inter,Roboto,Arial,sans-serif;cursor:pointer;touch-action:manipulation}button:focus-visible{outline:2px solid #004849;outline-offset:2px}button:disabled{cursor:wait;opacity:.68}@keyframes pulse{50%{opacity:.35}}';
    indicatorBar = document.createElement('div');
    indicatorBar.className = 'bar';
    var dot = document.createElement('span'); dot.className = 'dot';
    indicatorTime = document.createElement('span'); indicatorTime.className = 'time';
    indicatorCount = document.createElement('span'); indicatorCount.className = 'count'; indicatorCount.textContent = '0 个动作';
    indicatorStopButton = document.createElement('button'); indicatorStopButton.type = 'button';
    indicatorStopButton.textContent = '停止'; indicatorStopButton.title = '停止页面操作录制'; indicatorStopButton.setAttribute('aria-label', '停止页面操作录制');
    indicatorStopButton.addEventListener('click', requestStop);
    indicatorBar.appendChild(dot); indicatorBar.appendChild(indicatorTime); indicatorBar.appendChild(indicatorCount); indicatorBar.appendChild(indicatorStopButton);
    shadow.appendChild(style); shadow.appendChild(indicatorBar); document.documentElement.appendChild(indicatorHost);
    var sessionStorage = null;
    try { sessionStorage = root.sessionStorage; } catch (_) {}
    indicatorPositionController = positionControllerApi.createFree({
      window: root,
      document: document,
      host: indicatorHost,
      handle: indicatorBar,
      storage: sessionStorage,
      storageKey: INDICATOR_POSITION_STORAGE_KEY,
      defaultPosition: { leftRatio: 1, topRatio: 1 },
      interactiveSelector: 'button',
      layoutDelay: 0,
    });
    indicatorPositionController.init();
    updateIndicator(0);
    indicatorTimer = root.setInterval(updateIndicator, 1000);
  }
  function enable(payload) {
    if (!payload || payload.documentLocalNonce && payload.documentLocalNonce !== localNonce) return;
    var nextRecordingId = String(payload.recordingId || '');
    var nextCapability = String(payload.capability || '');
    if ((state === 'enabled' || state === 'stop-requested' || state === 'stopping')
        && recordingId === nextRecordingId && capability === nextCapability) {
      hideExtensionUi();
      if (payload.showIndicator) showIndicator();
      if (payload.count !== undefined) updateIndicator(payload.count);
      return;
    }
    var resumeEvents = [];
    var sameRecording = recordingId && recordingId === nextRecordingId && state === 'enabled';
    var resumeCapturedCount = sameRecording ? capturedCount : 0;
    if (sameRecording) {
      normalOutbox.forEach(function (batch) { resumeEvents = resumeEvents.concat(batch.events || []); });
      resumeEvents = resumeEvents.concat(takeBatch());
    }
    if (normalRetryTimer) root.clearTimeout(normalRetryTimer);
    normalRetryTimer = 0;
    normalOutbox.length = 0;
    normalSending = false;
    normalStopped = false;
    normalDeliveryEpoch += 1;
    stopRequestedAt = 0;
    capturedCount = sameRecording ? resumeCapturedCount : ring.length;
    localLimitRequested = false;
    recordingId = nextRecordingId;
    capability = nextCapability;
    startedAt = Number(payload.startedAt) || now();
    state = 'enabled';
    hideExtensionUi();
    installListeners();
    if (ringDropped) {
      pendingDiagnostics.push({ code: 'pending_ring_overflow', occurredAt: now(), count: ringDropped });
      ringDropped = 0;
    }
    if (ring.length || resumeEvents.length) {
      queue = ring.concat(resumeEvents, queue);
      ring.length = 0;
      flushBatch(false, '');
    }
    if (payload.showIndicator) showIndicator();
    if (payload.count !== undefined) updateIndicator(payload.count);
  }
  function stopAndFlush(payload) {
    if (!payload) return null;
    var requestedRecordingId = String(payload.recordingId || '');
    var requestedStopNonce = String(payload.stopNonce || '');
    if (lastFinalBatch && lastFinalBatch.recordingId === requestedRecordingId
        && lastFinalBatch.stopNonce === requestedStopNonce) return lastFinalBatch.batch;
    if ((state !== 'enabled' && state !== 'stop-requested') || requestedRecordingId !== recordingId) return null;
    if (state === 'enabled') flushFills();
    state = 'stopping';
    stopRequestedAt = stopRequestedAt || Number(payload.cutoffAt) || now();
    normalStopped = true;
    if (normalRetryTimer) root.clearTimeout(normalRetryTimer);
    normalRetryTimer = 0;
    removeListeners();
    setIndicatorStopping(true);
    if (batchTimer) { root.clearTimeout(batchTimer); batchTimer = 0; }
    batchSequence += 1;
    var finalEvents = [];
    var finalDiagnostics = pendingDiagnostics.slice();
    normalOutbox.forEach(function (batch) {
      finalEvents = finalEvents.concat(batch.events || []);
      finalDiagnostics = finalDiagnostics.concat(batch.diagnostics || []);
    });
    normalOutbox.length = 0;
    pendingDiagnostics.length = 0;
    finalEvents = finalEvents.concat(takeBatch());
    var batch = {
      recordingId: recordingId, capability: capability,
      documentLocalBatchId: localNonce + ':' + batchSequence,
      events: finalEvents,
      diagnostics: finalDiagnostics,
      finalBatch: true, stopNonce: requestedStopNonce,
    };
    lastFinalBatch = { recordingId: requestedRecordingId, stopNonce: requestedStopNonce, batch: batch };
    return batch;
  }
  function deactivate() {
    if (normalRetryTimer) root.clearTimeout(normalRetryTimer);
    normalRetryTimer = 0;
    normalOutbox.length = 0;
    normalSending = false;
    normalStopped = true;
    lastFinalBatch = null;
    state = 'dormant'; recordingId = ''; capability = ''; stopRequestedAt = 0;
    queue.length = 0; ring.length = 0; ringDropped = 0; pendingDiagnostics.length = 0; capturedCount = 0; localLimitRequested = false;
    fillPending.forEach(function (pending) { if (pending.timer) root.clearTimeout(pending.timer); });
    fillPending.clear();
    if (batchTimer) root.clearTimeout(batchTimer);
    batchTimer = 0;
    removeListeners();
    removeIndicator();
    restoreExtensionUi();
  }
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return;
    if (message.type === contract.DOCUMENT_MESSAGES.ENABLE) enable(message.payload || {});
    else if (message.type === contract.DOCUMENT_MESSAGES.STOP_AND_FLUSH) {
      // Return the final snapshot synchronously so stopping does not require a second batch/ACK round trip.
      var batch = stopAndFlush(message.payload || {});
      sendResponse(batch ? { ok: true, payload: { batch: batch } } : {
        ok: false, error: { code: 'RECORDING_STATE_CONFLICT', message: 'Recording document is not active' },
      });
    }
    else if (message.type === contract.UI_MESSAGES.STATE_CHANGED) {
      if (!message.payload || !message.payload.active) deactivate();
      else if (indicatorHost) updateIndicator(message.payload.active.count);
    }
  });
  state = 'pending';
  installListeners();
  send(contract.DOCUMENT_MESSAGES.HELLO, { documentLocalNonce: localNonce }).then(function (response) {
    var payload = response && response.ok === true ? response.payload : null;
    if (payload && payload.enabled) enable(payload);
    else if (payload && payload.pending) { state = 'pending'; installListeners(); }
    else { state = 'dormant'; ring.length = 0; ringDropped = 0; pendingDiagnostics.length = 0; removeListeners(); }
  }).catch(function () { state = 'dormant'; ring.length = 0; ringDropped = 0; pendingDiagnostics.length = 0; removeListeners(); });
})(typeof globalThis !== 'undefined' ? globalThis : this);
