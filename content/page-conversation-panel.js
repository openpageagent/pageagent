(function attachPageConversationPanel(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var recordingContract = commonJs ? require('../shared/recording-contract') : root.PageAgentRecordingContract;
  var syncEventStreamApi = commonJs ? require('../shared/sync-event-stream') : root.PageAgentSyncEventStream;
  var api = factory(recordingContract, syncEventStreamApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAgentPageConversationPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (recordingContract, syncEventStreamApi) {
  'use strict';

  function createSvg(parts) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    (parts || []).forEach(function (part) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', part.tag || 'path');
      Object.keys(part.attrs || {}).forEach(function (key) { node.setAttribute(key, part.attrs[key]); });
      svg.appendChild(node);
    });
    return svg;
  }

  function iconSend() {
    return createSvg([
      { attrs: { d: 'M12 19V5m-7 7 7-7 7 7' } },
    ]);
  }

  function iconStop() {
    return createSvg([{
      tag: 'rect',
      attrs: { x: '6', y: '6', width: '12', height: '12', rx: '1', fill: 'currentColor', stroke: 'none' },
    }]);
  }

  function iconClose() {
    return createSvg([{ attrs: { d: 'M18 6 6 18M6 6l12 12' } }]);
  }

  function iconNewTopic() {
    return createSvg([
      { attrs: { d: 'M12 5v14M5 12h14' } },
    ]);
  }

  function iconOpenConversation() {
    return createSvg([
      { attrs: { d: 'M15 3h6v6m-11 5L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' } },
    ]);
  }

  function iconLoader() {
    var icon = createSvg([{ attrs: { d: 'M20 12a8 8 0 1 1-8-8' } }]);
    icon.classList.add('spinning');
    return icon;
  }

  function iconStatus(kind) {
    if (kind === 'running') return iconLoader();
    if (kind === 'summarizing') {
      var dot = createSvg([{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '5', fill: 'currentColor', stroke: 'none' } }]);
      dot.classList.add('summary-breathe');
      return dot;
    }
    if (kind === 'stopped') return iconStop();
    if (kind === 'waiting') return createSvg([{ attrs: { d: 'M9 5v14M15 5v14' } }]);
    return createSvg([
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
      { attrs: { d: kind === 'failed' ? 'M12 8v4m0 4h.01' : 'm8 12 3 3 5-6' } },
    ]);
  }

  function iconChevron(expanded) {
    return createSvg([{ attrs: { d: expanded ? 'm6 9 6 6 6-6' : 'm6 15 6-6 6 6' } }]);
  }

  function replaceIcon(button, icon) {
    if (!button) return;
    button.textContent = '';
    button.appendChild(icon);
  }

  var LIVE_TOOL_STATUSES = Object.freeze({ planned: true, running: true, streaming: true });

  function create(options) {
    options = options || {};
    var win = options.window;
    var documentRef = options.document;
    var runtime = options.runtime;
    var syncEventStream = syncEventStreamApi && typeof syncEventStreamApi.create === 'function'
      ? syncEventStreamApi.create({ runtime: runtime })
      : null;
    var runtimeClient = options.runtimeClient;
    var contract = options.messageContract;
    var eventView = options.eventView;
    var listView = options.listView;
    var conversationShared = options.conversationShared;
    var imageArtifactClient = options.imageArtifactClient;
    var positionControllerApi = options.positionController;
    if (!win || !documentRef || !runtimeClient || typeof runtimeClient.send !== 'function') {
      throw new Error('page conversation panel requires window, document and runtime client');
    }
    if (!contract || contract.API_VERSION !== 1) throw new Error('page conversation panel requires message contract');
    if (!recordingContract || recordingContract.API_VERSION !== 1) throw new Error('page conversation panel requires Recording contract');
    if (!eventView || eventView.API_VERSION !== 1) throw new Error('page conversation panel requires conversation event view');
    if (!listView || listView.API_VERSION !== 1
        || typeof listView.mergeJournalPages !== 'function'
        || typeof listView.createVirtualList !== 'function') {
      throw new Error('page conversation panel requires conversation list view');
    }
    if (!conversationShared || conversationShared.API_VERSION !== 1) throw new Error('page conversation panel requires conversation shared');
    if (!positionControllerApi || typeof positionControllerApi.createFree !== 'function') {
      throw new Error('page conversation panel requires page element position controller');
    }
    var applicationEntry = win.AppContract && win.AppContract.parseUrl(win.location.href, runtime.getURL('/'));

    function hydrateImages() {
      if (!imageArtifactClient || typeof imageArtifactClient.hydrate !== 'function' || !messages) return;
      imageArtifactClient.hydrate(messages).catch(function () {});
    }

    var destroyed = false;
    var pendingConsent = null;
    var host = null;
    var panel = null;
    var title = null;
    var topicLabel = null;
    var statusDot = null;
    var statusText = null;
    var messages = null;
    var pendingSteeringHost = null;
    var virtualList = null;
    var virtualListTopicId = '';
    var eventDisclosureState = Object.create(null);
    var pendingInputHost = null;
    var pendingInputKey = '';
    var pendingSubmitButton = null;
    var assistantSelect = null;
    var recordButton = null;
    var recordingSummary = null;
    var recordingSummaryText = null;
    var recordingLibraryButton = null;
    var recordingDrawer = null;
    var recordingDrawerTitle = null;
    var recordingDrawerBody = null;
    var recordingDrawerClose = null;
    var recordingDrawerNotice = null;
    var recordingDrawerFocusKey = '';
    var newTopicButton = null;
    var openOptionsButton = null;
    var contextMeter = null;
    var contextMeterValue = null;
    var contextThreshold = null;
    var contextCompactButton = null;
    var contextPopover = null;
    var contextPopoverBody = null;
    var contextRefreshButton = null;
    var contextUsage = null;
    var contextRenderKey = '';
    var toggleButton = null;
    var closeButton = null;
    var headerStopButton = null;
    var panelHeader = null;
    var runtimeStatus = null;
    var input = null;
    var actionButton = null;
    var notice = null;
    var appContextNotice = null;
    var appContextTopicId = null;
    var appContext = null;
    var appContextRequest = 0;
    var assistants = [];
    var entryConfig = null;
    var selectedAssistantId = '';
    var topic = null;
    var conversationMetadata = null;
    var optimisticUserEvent = null;
    var newTopicDraft = false;
    var expanded = false;
    var busy = 'loading';
    var refreshPromise = null;
    var steeringCommandQueue = {
      tail: Promise.resolve(),
      pendingCount: 0,
      nextOrder: 0,
      failedDrafts: [],
    };
    var olderEventsPromise = null;
    var OLDER_LOAD_THRESHOLD = 120;
    var messagesScrollTopicId = '';
    var lastMessagesScrollTop = null;
    /* Keep raw Journal rows separate from the projected rows rendered by the
       shared list view. A refresh must never feed `topic.events` back into
       projectPage, otherwise tool/reasoning lifecycle rows can be overwritten. */
    var rawConversationEvents = [];
    var rawConversationEventsTopicId = '';
    var conversationEventsInitialized = false;
    var conversationEventsHasMoreBefore = false;
    var conversationEventsTotal = 0;
    var conversationEventsCursor = { beforeSequence: null, afterSequence: null };
    var conversationEventsStreamBuffers = [];
    var refreshQueued = false;
    var requestRevision = 0;
    var pollTimer = 0;
    var messageElapsedTimer = 0;
    var assistantRenderKey = null;
    var messageRenderCache = Object.create(null);
    var messageRenderCacheTopicId = '';
    var presentationInitialized = false;
    var presentationRunning = false;
    var presentationWaiting = false;
    var recordingState = null;
    var recordingLibrary = null;
    var RECORDING_SOURCE_PAGE_SIZE = 5;
    var recordingSourceLimit = RECORDING_SOURCE_PAGE_SIZE;
    var recordingSourceScrollTop = 0;
    var recordingBusy = '';
    var recordingTimer = 0;
    var recordingWarningNotifiedId = '';
    var previewState = { recordingId: '', manifest: null, events: [], query: {}, nextCursor: '', errorDetails: null, selectedSeqs: null };
    var RECORDING_CATEGORIES = [
      { id: 'all', label: '全部', kinds: [] },
      { id: 'actions', label: '页面操作', kinds: ['click', 'fill', 'select', 'key', 'submit'] },
      { id: 'pages', label: '页面与标签', kinds: ['recording_start', 'navigation', 'navigation_target', 'tab_created', 'tab_closed'] },
      { id: 'http', label: 'HTTP 请求', kinds: ['http'] },
      { id: 'websocket', label: 'WebSocket', kinds: ['websocket'] },
      { id: 'sse', label: 'SSE', kinds: ['sse'] },
    ];
    var PANEL_POSITION_STORAGE_KEY = 'page-agent-conversation-panel-position';
    var ASSISTANT_SELECTION_STORAGE_KEY_PREFIX = 'page-agent-conversation-selected-assistant:';
    var RECORDING_NETWORK_STORAGE_KEY = 'page-agent-recording-network-capture';
    var RECORDING_CONSENT_STORAGE_KEY = 'page-agent-recording-consent-version';
    var recordingPreferenceWrite = Promise.resolve();
    var panelPositionController = null;
    var RECORDING_PRIVACY_TERMS = [
      ['一、录制范围', '当前页面及录制期间新开标签中的操作，包括你和 Conversation、Flow、MCP 等自动化执行的操作。网络按勾选项采集，SSE 单独归类。'],
      ['二、采集限制', '监听启用前的请求和已有连接可能无法捕获；长正文会截断，二进制仅记录类型与大小。'],
      ['三、敏感信息', '内容可能包含密码、验证码、银行卡号、token、URL 参数等，将原样保存，不会自动脱敏。'],
      ['四、保存与使用', '录制会在主窗口与隐私窗口间共享并持久保留，关闭隐私窗口不会删除。选择事件后，Agent 可按需读取整份录制，内容可能发送给所选大模型。'],
    ];
    var cleanups = [];
    // pending 问答控件每轮 ASK_USER 都重建，监听器必须随旧控件一起释放，
    // 挂到 cleanups 会一直积累到 destroy。
    var pendingInputCleanups = [];

    function listen(target, type, handler, listenerOptions) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, listenerOptions);
      cleanups.push(function () { target.removeEventListener(type, handler, listenerOptions); });
    }

    function listenPending(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler);
      pendingInputCleanups.push(function () { target.removeEventListener(type, handler); });
    }

    function drainPendingInputCleanups() {
      while (pendingInputCleanups.length) {
        try { pendingInputCleanups.pop()(); } catch (_) {}
      }
    }

    function subscribe(event, handler) {
      if (!event || typeof event.addListener !== 'function') return;
      event.addListener(handler);
      cleanups.push(function () { if (event.removeListener) event.removeListener(handler); });
    }

    function send(type, payload) {
      var built = contract.request(type, payload || {});
      if (!built.ok) return Promise.resolve(built);
      return runtimeClient.send(built.message.type, built.message.payload).then(function (response) {
        return contract.response(response);
      });
    }

    function sendCommand(command, input) {
      return send(contract.TYPES.COMMAND, { command: command, input: input || {} });
    }

    function sendRecording(type, payload) {
      return send(type, payload || {});
    }

    function refreshPanelPosition() {
      if (panelPositionController) panelPositionController.refresh();
    }

    function recordingCollection() {
      return recordingLibrary && recordingLibrary.collection || recordingState && recordingState.collection || null;
    }

    function selectedRecordingRanges() {
      var collection = recordingCollection();
      return collection && Array.isArray(collection.selectedRanges) ? collection.selectedRanges : [];
    }

    function sourceSelectionState(source) {
      var sourceRanges = selectedRecordingRanges().filter(function (range) {
        return String(range.recordingId || '') === String(source && source.recordingId || '');
      }).slice().sort(function (left, right) { return Number(left.fromSeq) - Number(right.fromSeq); });
      var eventCount = Math.max(0, Number(source && source.stats && source.stats.eventCount) || 0);
      var nextSeq = 1;
      var selectedActionCount = 0;
      sourceRanges.forEach(function (range) {
        if (Number(range.fromSeq) <= nextSeq) nextSeq = Math.max(nextSeq, Number(range.toSeq) + 1);
        var fromSeq = Math.max(1, Number(range.fromSeq) || 0);
        var toSeq = Math.min(eventCount, Number(range.toSeq) || 0);
        if (toSeq >= fromSeq) selectedActionCount += toSeq - fromSeq + 1;
      });
      return {
        selected: sourceRanges.length > 0,
        fullySelected: eventCount > 0 && nextSeq > eventCount,
        selectedActionCount: selectedActionCount,
      };
    }

    function previewSelectionForSource(recordingId) {
      var selected = Object.create(null);
      selectedRecordingRanges().forEach(function (range) {
        if (String(range.recordingId || '') !== String(recordingId || '')) return;
        for (var seq = Number(range.fromSeq); seq <= Number(range.toSeq); seq += 1) selected[seq] = true;
      });
      return selected;
    }

    function syncPreviewSelection() {
      if (!previewState.recordingId) return;
      previewState.selectedSeqs = previewSelectionForSource(previewState.recordingId);
    }

    function refreshRecordingLibrary() {
      var collection = recordingState && recordingState.collection;
      if (!collection) {
        recordingLibrary = null;
        renderRecordingControls();
        return Promise.resolve(null);
      }
      return sendRecording(contract.TYPES.GET_RECORDING_LIBRARY, {
        draftCollectionId: collection.draftCollectionId,
      }).then(function (response) {
        if (destroyed) return response;
        if (response.ok) {
          recordingLibrary = response.payload || null;
          syncPreviewSelection();
        }
        else setNotice(response.error || '加载录制失败', true);
        renderRecordingControls();
        renderRecordingDrawer();
        return response;
      });
    }

    function refreshRecordingState() {
      if (destroyed) return Promise.resolve(null);
      return sendRecording(contract.TYPES.GET_RECORDING_STATE, {}).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) {
          setNotice(response.error || '加载录制状态失败', true);
          return response;
        }
        recordingState = response.payload || {};
        renderRecordingControls();
        if (recordingState.collection) return refreshRecordingLibrary().then(function () { return response; });
        recordingLibrary = null;
        renderRecordingDrawer();
        return response;
      });
    }

    async function showConsent(options) {
      options = options || {};
      if (pendingConsent || destroyed) return false;
      closeContextPopover(false);
      var cancelled = false;
      pendingConsent = function () { cancelled = true; };
      var networkCapture = recordingContract.normalizeNetworkCapture();
      var privacyAccepted = false;
      var storage = globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
      if (options.networkCapture && storage) {
        try {
          await recordingPreferenceWrite;
          var stored = await storage.get([RECORDING_NETWORK_STORAGE_KEY, RECORDING_CONSENT_STORAGE_KEY]);
          networkCapture = recordingContract.normalizeNetworkCapture(stored[RECORDING_NETWORK_STORAGE_KEY]);
          privacyAccepted = stored[RECORDING_CONSENT_STORAGE_KEY] === recordingContract.CONSENT_VERSION;
        } catch (_) {}
      }
      if (cancelled || destroyed) { pendingConsent = null; return false; }
      return new Promise(function (resolve) {
        var previous = panel.getRootNode().activeElement, settled = false;
        var overlay = documentRef.createElement('div');
        overlay.className = 'recording-consent-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'recording-consent-title');
        overlay.setAttribute('aria-describedby', 'recording-consent-copy');
        var dialog = documentRef.createElement('section');
        dialog.className = 'recording-consent';
        var dialogHeader = element('header', 'recording-consent-header');
        var heading = documentRef.createElement('h2');
        heading.id = 'recording-consent-title';
        heading.textContent = options.title || '开始录制';
        var body = documentRef.createElement('div');
        body.className = 'recording-consent-body';
        var copy = documentRef.createElement('p');
        copy.id = 'recording-consent-copy';
        copy.textContent = options.message || '按需勾选要同时采集的网络内容：';
        body.appendChild(copy);
        var networkChoices = documentRef.createElement('div');
        var networkInputs = {};
        var privacyConsent = null;
        function selectedNetworkCapture() {
          var selected = {};
          Object.keys(networkInputs).forEach(function (key) { selected[key] = networkInputs[key].checked; });
          return selected;
        }
        if (options.networkCapture) {
          networkChoices.className = 'recording-network-choices';
          networkChoices.setAttribute('role', 'group');
          networkChoices.setAttribute('aria-label', '同时录制的网络内容');
          [['http', 'HTTP（Fetch/XHR）', '请求与响应'], ['websocket', 'WebSocket', '连接与双向消息'], ['sse', 'SSE', '服务器推送事件']].forEach(function (choice) {
            var label = documentRef.createElement('label');
            label.title = choice[2];
            var checkbox = documentRef.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.setAttribute('aria-label', choice[1] + '：' + choice[2]);
            checkbox.checked = networkCapture[choice[0]];
            networkInputs[choice[0]] = checkbox;
            checkbox.addEventListener('change', function () {
              if (!storage) return;
              var value = {};
              value[RECORDING_NETWORK_STORAGE_KEY] = selectedNetworkCapture();
              recordingPreferenceWrite = recordingPreferenceWrite.then(function () { return storage.set(value); }).catch(function () {
                if (!destroyed) setNotice('录制选项保存失败，下次需要重新选择', true);
              });
            });
            label.appendChild(checkbox);
            label.appendChild(documentRef.createTextNode(choice[1]));
            networkChoices.appendChild(label);
          });
          body.appendChild(networkChoices);
          var agreement = documentRef.createElement('div');
          agreement.className = 'recording-privacy-agreement';
          var agreementLabel = documentRef.createElement('label');
          privacyConsent = documentRef.createElement('input');
          privacyConsent.type = 'checkbox';
          privacyConsent.checked = privacyAccepted;
          privacyConsent.setAttribute('aria-label', '我已阅读并同意录制隐私条款');
          agreementLabel.appendChild(privacyConsent);
          agreementLabel.appendChild(documentRef.createTextNode('我已阅读并同意录制隐私条款'));
          var termsLink = documentRef.createElement('button');
          termsLink.type = 'button';
          termsLink.className = 'recording-privacy-link';
          termsLink.textContent = '查看条款';
          termsLink.setAttribute('aria-expanded', 'false');
          termsLink.setAttribute('aria-controls', 'recording-privacy-terms');
          var terms = documentRef.createElement('section');
          terms.id = 'recording-privacy-terms';
          terms.className = 'recording-privacy-terms';
          terms.setAttribute('aria-label', '录制隐私条款');
          terms.tabIndex = 0;
          terms.hidden = true;
          RECORDING_PRIVACY_TERMS.forEach(function (clause) {
            var section = documentRef.createElement('section');
            var clauseTitle = documentRef.createElement('h3');
            clauseTitle.textContent = clause[0];
            var clauseText = documentRef.createElement('p');
            clauseText.textContent = clause[1];
            section.appendChild(clauseTitle); section.appendChild(clauseText);
            terms.appendChild(section);
          });
          termsLink.addEventListener('click', function () {
            terms.hidden = !terms.hidden;
            termsLink.setAttribute('aria-expanded', String(!terms.hidden));
            termsLink.textContent = terms.hidden ? '查看条款' : '收起条款';
            if (!terms.hidden) {
              terms.focus({ preventScroll: true });
              terms.scrollIntoView({ block: 'nearest' });
            }
          });
          agreement.appendChild(agreementLabel); agreement.appendChild(termsLink);
          body.appendChild(terms);
        }
        var actions = documentRef.createElement('div');
        actions.className = 'recording-consent-actions';
        var cancel = documentRef.createElement('button');
        cancel.type = 'button'; cancel.className = 'secondary-command'; cancel.textContent = '取消';
        var start = documentRef.createElement('button');
        start.type = 'button'; start.className = 'primary-command' + (options.danger ? ' danger-command' : ''); start.textContent = options.okText || '开始录制';
        if (privacyConsent) {
          var consentHint = element('p', 'recording-consent-hint', privacyAccepted ? '' : '请先同意条款');
          consentHint.id = 'recording-consent-hint';
          consentHint.setAttribute('role', 'status');
          start.setAttribute('aria-describedby', consentHint.id);
          actions.appendChild(agreement);
          start.disabled = !privacyAccepted;
          start.title = privacyAccepted ? '' : '请先勾选同意录制隐私条款';
          privacyConsent.addEventListener('change', function () {
            start.disabled = !privacyConsent.checked;
            start.title = privacyConsent.checked ? '' : '请先勾选同意录制隐私条款';
            consentHint.textContent = privacyConsent.checked ? '' : '请先同意条款';
            if (!storage) return;
            var value = {};
            value[RECORDING_CONSENT_STORAGE_KEY] = privacyConsent.checked ? recordingContract.CONSENT_VERSION : '';
            recordingPreferenceWrite = recordingPreferenceWrite.then(function () { return storage.set(value); }).catch(function () {
              if (destroyed) return;
              var message = '同意状态保存失败，下次需重新确认';
              if (overlay.isConnected) consentHint.textContent = message;
              else setNotice(message, true);
            });
          });
        }
        function finish(value) {
          if (settled) return;
          settled = true; pendingConsent = null; overlay.remove();
          dialogBackground.forEach(function (node) { node.inert = false; });
          if (!destroyed) refreshPanelPosition();
          if (previous && previous.isConnected && !destroyed) previous.focus({ preventScroll: true });
          else if (!destroyed && recordingDrawer && !recordingDrawer.hidden) recordingDrawerClose.focus({ preventScroll: true });
          resolve(value);
        }
        pendingConsent = function () { finish(false); };
        var dismiss = element('button', 'icon-button');
        dismiss.type = 'button'; dismiss.title = '取消并关闭';
        dismiss.setAttribute('aria-label', dismiss.title);
        dismiss.appendChild(iconClose());
        dismiss.addEventListener('click', function () { finish(false); });
        cancel.addEventListener('click', function () { finish(false); });
        start.addEventListener('click', function () {
          if (!options.networkCapture) { finish(true); return; }
          if (!privacyConsent.checked) return;
          finish(selectedNetworkCapture());
        });
        overlay.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
          if (event.key === 'Tab') {
            event.preventDefault();
            var focusable = Array.prototype.slice.call(dialog.querySelectorAll('input:not(:disabled),button:not(:disabled),[tabindex="0"]')).filter(function (node) {
              return !node.hidden && !node.closest('[hidden]');
            });
            var index = focusable.indexOf(overlay.getRootNode().activeElement);
            var nextIndex = index < 0 ? (event.shiftKey ? focusable.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
            if (focusable[nextIndex]) focusable[nextIndex].focus();
          }
        });
        actions.appendChild(start); actions.appendChild(cancel);
        if (consentHint) actions.appendChild(consentHint);
        dialogHeader.appendChild(heading); dialogHeader.appendChild(dismiss);
        dialog.appendChild(dialogHeader); dialog.appendChild(body);
        dialog.appendChild(actions); overlay.appendChild(dialog);
        var dialogBackground = Array.prototype.filter.call(panel.children, function (node) { return !node.inert; });
        dialogBackground.forEach(function (node) { node.inert = true; });
        panel.appendChild(overlay);
        refreshPanelPosition();
        cancel.focus({ preventScroll: true });
      });
    }

    function startOrStopRecording() {
      if (recordingBusy) return;
      var active = recordingState && recordingState.active;
      if (active) {
        recordingBusy = 'stopping';
        renderRecordingControls();
        sendRecording(contract.TYPES.STOP_RECORDING, {}).then(function (response) {
          if (destroyed) return response;
          if (!response.ok) setNotice(response.error || '停止录制失败', true);
          return refreshRecordingState();
        }).catch(function (error) {
          if (!destroyed) setNotice(error && error.message || '停止录制失败，请重试', true);
        }).finally(function () { recordingBusy = ''; renderRecordingControls(); });
        return;
      }
      showConsent({ networkCapture: true }).then(function (confirmed) {
        if (!confirmed || destroyed) return;
        recordingBusy = 'starting';
        renderRecordingControls();
        var collection = recordingCollection();
        return sendRecording(contract.TYPES.START_RECORDING, {
          draftCollectionId: String(collection && collection.draftCollectionId || ''),
          consentVersion: recordingContract.CONSENT_VERSION,
          confirmedAt: Date.now(),
          networkCapture: confirmed,
        }).then(function (response) {
          if (destroyed) return response;
          if (!response.ok) {
            setNotice(response.error || '开始录制失败', true);
            return response;
          }
          recordingState = Object.assign({}, recordingState || {}, response.payload || {});
          recordingLibrary = null;
          return refreshRecordingState();
        }).catch(function (error) {
          if (!destroyed) setNotice(error && error.message || '开始录制失败，请重试', true);
        }).finally(function () { recordingBusy = ''; renderRecordingControls(); });
      });
    }

    function nextId(prefix) {
      if (win.crypto && typeof win.crypto.randomUUID === 'function') return prefix + ':' + win.crypto.randomUUID();
      return prefix + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10);
    }

    function conversationStorageKey(assistantId) {
      return 'page-agent-conversation:' + String(entryConfig && entryConfig.tabId || 0) + ':' + String(assistantId || '')
        + (applicationEntry ? ':' + win.location.pathname : '');
    }

    function rememberConversationId(assistantId, conversationId) {
      assistantId = String(assistantId || '');
      conversationId = String(conversationId || '');
      if (!assistantId || !conversationId) return;
      try { win.sessionStorage.setItem(conversationStorageKey(assistantId), conversationId); } catch (_) {}
    }

    function conversationIdFor(assistantId, forceNew) {
      var key = conversationStorageKey(assistantId);
      var value = '';
      try { value = forceNew ? '' : String(win.sessionStorage.getItem(key) || ''); } catch (_) {}
      if (!value && applicationEntry && !forceNew) {
        var previous = (entryConfig && entryConfig.applicationConversations || []).find(function (item) {
          return item.assistantId === assistantId;
        });
        if (previous) {
          value = String(previous.conversationId || '');
          rememberConversationId(assistantId, value);
        }
      }
      if (!value) {
        value = 'page:' + String(entryConfig && entryConfig.tabId || 0) + ':' + String(assistantId || 'assistant');
        if (applicationEntry) value = nextId(value);
        else if (forceNew) value += ':' + Date.now().toString(36);
        try { win.sessionStorage.setItem(key, value); } catch (_) {}
      }
      return value;
    }

    function selectedAssistant() { return assistantById(selectedAssistantId) || {}; }

    function selectedServiceId() {
      var assistant = selectedAssistant();
      return String(assistant.modelServiceId || entryConfig && entryConfig.defaultModelServiceId || '').trim();
    }

    function assistantById(id) {
      for (var index = 0; index < assistants.length; index++) {
        if (assistants[index] && assistants[index].id === id) return assistants[index];
      }
      return null;
    }

    function assistantSelectionStorageKey() {
      var tabId = Number(entryConfig && entryConfig.tabId) || 0;
      return tabId ? ASSISTANT_SELECTION_STORAGE_KEY_PREFIX + tabId : '';
    }

    function rememberedAssistantId() {
      var key = assistantSelectionStorageKey();
      if (!key) return '';
      try { return String(win.sessionStorage.getItem(key) || ''); } catch (_) { return ''; }
    }

    function rememberAssistantId(assistantId) {
      var key = assistantSelectionStorageKey();
      if (!key) return;
      try {
        if (assistantId) win.sessionStorage.setItem(key, String(assistantId));
        else win.sessionStorage.removeItem(key);
      } catch (_) {}
    }

    function ensureSelectedAssistant() {
      if (assistantById(selectedAssistantId)) return selectedAssistantId;
      var remembered = selectedAssistantId ? '' : rememberedAssistantId();
      var previous = applicationEntry && (entryConfig && entryConfig.applicationConversations || []).find(function (item) {
        return !!assistantById(item.assistantId);
      });
      selectedAssistantId = String(assistantById(remembered) && remembered
        || previous && previous.assistantId
        || assistants[0] && assistants[0].id
        || '');
      rememberAssistantId(selectedAssistantId);
      return selectedAssistantId;
    }

    // 运行状态直接从轮询回来的事实推导：activeGeneration.inFlightTool 是
    // "此刻正在执行的资源操作"的权威信号，其次看最后一条事件的流式状态。
    function lastTopicEvent() {
      var source = displayEvents();
      return source.length ? source[source.length - 1] : null;
    }

    function runningStatusText() {
      var inFlight = topic && topic.inFlightTool;
      if (inFlight) {
        var method = String(inFlight.method || '');
        if (method === 'ASK_USER') return '工具调用：请求用户输入';
        var operation = listView.describeOperation(method, inFlight.canonicalUri);
        return operation ? '工具调用：' + operation : '工具调用：' + listView.toolTitle(method);
      }
      var last = lastTopicEvent();
      if (last) {
        var status = String(last.status || '');
        if (last.kind === 'assistant' && status === 'running') {
          return last.phase === 'commentary' ? '正在处理' : '正在回答';
        }
        if (last.kind === 'tool' && LIVE_TOOL_STATUSES[status]) {
          return last.operation ? '正在' + last.operation : String(last.title || '工具调用');
        }
      }
      return '正在思考';
    }

    function statusMeta() {
      if (busy === 'loading') return { text: '加载中', kind: 'running' };
      if (busy === 'sending') return { text: runningStatusText(), kind: 'running' };
      if (busy === 'interrupting') return { text: '正在切换', kind: 'running' };
      if (busy === 'answering') return { text: '正在提交', kind: 'running' };
      if (busy === 'stopping') return { text: '正在停止', kind: 'running' };
      if (!topic) return { text: newTopicDraft ? '新话题' : '就绪', kind: 'idle' };
      if (topic.pendingUserInput) return { text: '等待回答', kind: 'waiting' };
      if (topic.active || topic.status === 'running') {
        if (contextUsage && contextUsage.topicId === topic.topicId && contextUsage.data.summaryStatus === 'running') {
          return { text: '正在压缩摘要…', kind: 'summarizing' };
        }
        return { text: runningStatusText(), kind: 'running' };
      }
      if (topic.status === 'failed') return { text: '失败', kind: 'failed' };
      if (topic.status === 'stopped' || topic.status === 'aborted') return { text: '已停止', kind: 'stopped' };
      return { text: '就绪', kind: 'idle' };
    }

    var noticeTimer = 0;
    function setNotice(text, error, autoClearMs) {
      if (!notice) return;
      if (noticeTimer) { win.clearTimeout(noticeTimer); noticeTimer = 0; }
      notice.textContent = String(text || '');
      notice.className = 'notice' + (error ? ' error' : '');
      notice.hidden = !text;
      if (recordingDrawerNotice) {
        recordingDrawerNotice.textContent = String(text || '');
        recordingDrawerNotice.className = 'recording-drawer-notice' + (error ? ' error' : '');
        recordingDrawerNotice.hidden = !text || !recordingDrawer || recordingDrawer.hidden;
      }
      if (text && autoClearMs > 0) {
        noticeTimer = win.setTimeout(function () {
          noticeTimer = 0;
          if (!destroyed) setNotice('', false);
        }, autoClearMs);
      }
    }

    function renderAssistants() {
      if (!assistantSelect) return;
      var previous = String(assistantSelect.value || selectedAssistantId || '');
      if (assistantById(selectedAssistantId)) previous = selectedAssistantId;
      if (!assistantById(previous)) previous = assistants[0] && assistants[0].id || '';
      var nextRenderKey = assistants.map(function (assistant) {
        return [assistant.id, assistant.name, assistant.description].join('\n');
      }).join('\u001f');
      if (assistantRenderKey === nextRenderKey) {
        selectedAssistantId = previous;
        if (assistantSelect.value !== selectedAssistantId) assistantSelect.value = selectedAssistantId;
        return;
      }
      assistantRenderKey = nextRenderKey;
      assistantSelect.textContent = '';
      if (!assistants.length) {
        var empty = documentRef.createElement('option');
        empty.value = '';
        empty.textContent = '未配置助手';
        assistantSelect.appendChild(empty);
        selectedAssistantId = '';
      } else {
        assistants.forEach(function (assistant) {
          var option = documentRef.createElement('option');
          option.value = assistant.id;
          option.textContent = assistant.name || assistant.id;
          if (assistant.description) option.title = assistant.description;
          assistantSelect.appendChild(option);
        });
        selectedAssistantId = previous;
        assistantSelect.value = selectedAssistantId;
      }
    }

    function setExpanded(next, focusInput) {
      expanded = !!next;
      if (!expanded) closeContextPopover(false);
      if (!expanded && recordingDrawer) {
        recordingDrawer.hidden = true;
        panel.classList.remove('recording-open');
        recordingLibraryButton.setAttribute('aria-expanded', 'false');
      }
      if (panel) panel.classList.toggle('expanded', expanded);
      refreshPanelPosition();
      var collapsedRunning = !expanded && !!(topic && topic.active);
      if (runtimeStatus) runtimeStatus.setAttribute('aria-live', collapsedRunning ? 'off' : 'polite');
      if (toggleButton) {
        replaceIcon(toggleButton, iconChevron(expanded));
        toggleButton.title = expanded ? '收起对话' : '展开对话';
        toggleButton.setAttribute('aria-label', toggleButton.title);
        toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      }
      resizeInput();
      renderContextUsage();
      if (expanded) loadContextUsage(false);
      if (focusInput && input) win.setTimeout(function () {
        if (!destroyed && !pendingConsent && (!recordingDrawer || recordingDrawer.hidden)) input.focus();
      }, 0);
    }

    function syncRunPresentation(running, waitingForInput) {
      if (panel) panel.classList.toggle('running', running);
      if (!presentationInitialized) {
        presentationInitialized = true;
        presentationRunning = running;
        presentationWaiting = waitingForInput;
        if (running) setExpanded(waitingForInput, false);
        return;
      }
      if (running && waitingForInput && !presentationWaiting) {
        setExpanded(true, false);
      } else if (running && !waitingForInput && (!presentationRunning || presentationWaiting)) {
        if (!pendingConsent && (!recordingDrawer || recordingDrawer.hidden)
            && (!contextPopover || contextPopover.hidden)) setExpanded(false, false);
      } else if (!running && presentationRunning) {
        var revealingFromCollapsed = !expanded;
        setExpanded(true, true);
        // 完成态的消息已在本轮 renderMessages 中写入，但缩小态不参与
        // 完整列表布局。展开后的下一帧
        // 再对齐到底部；若用户原本已展开并主动上翻，则保留其位置。
        if (revealingFromCollapsed) scheduleMessagesScroll(true);
      }
      presentationRunning = running;
      presentationWaiting = waitingForInput;
    }

    function displayEvents() {
      var source = topic && Array.isArray(topic.events) ? topic.events : [];
      return source.filter(conversationShared.isVisibleEvent);
    }

    function renderedMessageEvents() {
      var events = displayEvents();
      if (topic && topic.active && !expanded && !pendingInputState() && events.length > 1) {
        // 运行态收起时只显示最新一条可见事件，展开后显示完整列表。
        return events.slice(-1);
      }
      return events;
    }

    function messageRenderVersion(event, index) {
      var detail = event && event.detail || {};
      var liveText = event && event.__live
        ? String(event.text || detail.content || detail.message || '') : '';
      return [
        event && (event.eventId || event.id || event.eventKey || event.liveKey) || '',
        event && event.canonicalType || '',
        event && (event.sequence || event.order) || 0,
        event && event.status || '',
        detail.status || '',
        event && event.__live ? Number(event.at) || 0 : 0,
        event && Number(event.startedAt) || 0,
        event && Number(event.durationMs) || 0,
        liveText,
        index,
      ].join('\u001f');
    }

    function renderMessageEvent(event, index) {
      var key = eventView.eventKey(event) || event && (event.id || event.eventId) || 'index:' + index;
      var version = messageRenderVersion(event, index);
      var cached = messageRenderCache[key];
      if (cached && cached.version === version) return cached.html;
      var html = conversationShared.renderEvent(event, index, {
        topicId: topic && topic.topicId || '',
      });
      messageRenderCache[key] = { version: version, html: html };
      return html;
    }

    function scheduleMessagesScroll(shouldStick) {
      if (!shouldStick) return;
      win.requestAnimationFrame(function () {
        if (!destroyed && messages) messages.scrollTop = messages.scrollHeight;
      });
    }

    function stopMessageElapsedTimer() {
      if (messageElapsedTimer) win.clearInterval(messageElapsedTimer);
      messageElapsedTimer = 0;
    }

    function syncMessageElapsedTimer() {
      // The shared document timer cannot reach labels inside this panel's Shadow DOM.
      if (destroyed || documentRef.hidden || !messages || !eventView.updateElapsedLabels(messages, Date.now())) {
        stopMessageElapsedTimer();
        return;
      }
      if (!messageElapsedTimer) messageElapsedTimer = win.setInterval(syncMessageElapsedTimer, 100);
    }

    function setHistoryLoading(active) {
      if (!messages) return;
      var indicator = messages.querySelector('[data-conversation-history-loading]');
      if (!indicator && !active) return;
      if (!indicator) {
        indicator = documentRef.createElement('div');
        indicator.className = 'conversation-history-loading';
        indicator.setAttribute('data-conversation-history-loading', '');
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        indicator.textContent = '正在加载更早消息...';
        messages.insertBefore(indicator, messages.firstChild || null);
      }
      indicator.hidden = !active;
    }

    function renderMessages(renderOptions) {
      if (!messages) return;
      renderOptions = renderOptions || {};
      var nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
      var events = renderedMessageEvents();
      var topicId = String(topic && topic.topicId || '');
      if (messageRenderCacheTopicId !== topicId) {
        messageRenderCache = Object.create(null);
        messageRenderCacheTopicId = topicId;
      }
      if (virtualList && virtualListTopicId !== topicId) {
        virtualList.destroy();
        virtualList = null;
        virtualListTopicId = '';
      }
      var preserveScroll = renderOptions.preserveScroll === true;
      var shouldStick = !preserveScroll && (!virtualList || nearBottom || busy === 'sending');
      if (panel) panel.classList.toggle('has-events', events.length > 0);
      if (!virtualList) {
        virtualList = listView.createVirtualList({
          container: messages,
          document: documentRef,
          // Message heights change with content and disclosure state; fixed-height
          // virtualization can leave spacers inside the visible viewport.
          virtualize: false,
          disclosureState: eventDisclosureState,
          disclosurePrefix: topicId,
          renderItem: renderMessageEvent,
          requestAnimationFrame: win.requestAnimationFrame && win.requestAnimationFrame.bind(win),
          onRendered: function (rows) {
            hydrateImages(rows);
            syncMessageElapsedTimer();
          },
        });
        virtualListTopicId = topicId;
      }
      setHistoryLoading(!!olderEventsPromise);
      var placeholder = messages.querySelector('[data-conversation-empty]');
      if (!events.length) {
        virtualList.setItems([], { preserveAnchor: true });
        if (!placeholder) {
          placeholder = documentRef.createElement('div');
          placeholder.className = 'placeholder';
          placeholder.setAttribute('data-conversation-empty', '');
          messages.appendChild(placeholder);
        }
        placeholder.textContent = newTopicDraft ? '新话题' : '等待对话';
      } else {
        if (placeholder) placeholder.remove();
        virtualList.setItems(events, {
          preserveAnchor: !shouldStick,
          stickToEnd: shouldStick,
        });
      }
      messagesScrollTopicId = topicId;
      lastMessagesScrollTop = Math.max(0, Number(messages.scrollTop) || 0);
    }

    function renderPendingSteering() {
      if (!pendingSteeringHost) return;
      var html = conversationShared.renderPendingSteering(topic && topic.pendingSteeringMessages, {
        canInterrupt: !!(topic && topic.active) && (!busy || busy === 'interrupting') && !pendingInputState(),
        interrupting: busy === 'interrupting',
      });
      if (pendingSteeringHost.innerHTML !== html) pendingSteeringHost.innerHTML = html;
      pendingSteeringHost.hidden = !html;
    }

    function pendingInputState() {
      var pending = topic && topic.pendingUserInput;
      return pending && pending.requestId && Array.isArray(pending.questions) && pending.questions.length
        ? pending
        : null;
    }

    function pendingAnswerState() {
      var result = { answers: {}, missing: null };
      if (!pendingInputHost || pendingInputHost.hidden) return result;
      pendingInputHost.querySelectorAll('.pending-question').forEach(function (question) {
        var questionId = String(question.getAttribute('data-question-id') || '');
        var checked = question.querySelector('input[type="radio"]:checked');
        var value = checked ? String(checked.value || '') : '';
        if (value === '__other__') {
          var other = question.querySelector('.pending-other-input');
          value = other ? String(other.value || '').trim() : '';
        }
        if (!value && !result.missing) result.missing = question;
        if (value) result.answers[questionId] = { answers: [value] };
      });
      return result;
    }

    function updatePendingInputControls() {
      if (!pendingInputHost || pendingInputHost.hidden) return;
      var disabled = !!busy || !(topic && topic.active);
      pendingInputHost.querySelectorAll('input,button').forEach(function (control) {
        if (control.disabled !== disabled) control.disabled = disabled;
      });
      if (pendingSubmitButton && !disabled) {
        pendingSubmitButton.disabled = !!pendingAnswerState().missing;
      }
    }

    function renderPendingUserInput() {
      if (!pendingInputHost) return;
      var pending = pendingInputState();
      if (!pending) {
        pendingInputKey = '';
        pendingSubmitButton = null;
        drainPendingInputCleanups();
        pendingInputHost.textContent = '';
        pendingInputHost.hidden = true;
        return;
      }
      if (pendingInputKey === pending.requestId) {
        updatePendingInputControls();
        return;
      }
      pendingInputKey = String(pending.requestId);
      drainPendingInputCleanups();
      pendingInputHost.textContent = '';
      pendingInputHost.hidden = false;

      var heading = documentRef.createElement('div');
      heading.className = 'pending-input-heading';
      heading.textContent = '需要你的回答';
      pendingInputHost.appendChild(heading);

      pending.questions.forEach(function (question, questionIndex) {
        var fieldset = documentRef.createElement('fieldset');
        fieldset.className = 'pending-question';
        fieldset.setAttribute('data-question-id', String(question.id || ''));
        var legend = documentRef.createElement('legend');
        var header = documentRef.createElement('span');
        header.textContent = String(question.header || '问题');
        var prompt = documentRef.createElement('b');
        prompt.textContent = String(question.question || '');
        legend.appendChild(header);
        legend.appendChild(prompt);
        fieldset.appendChild(legend);

        var optionList = documentRef.createElement('div');
        optionList.className = 'pending-options';
        (question.options || []).forEach(function (option, optionIndex) {
          var label = documentRef.createElement('label');
          label.className = 'pending-option';
          var radio = documentRef.createElement('input');
          radio.type = 'radio';
          radio.name = 'page-conversation-question-' + questionIndex;
          radio.value = String(option.label || '');
          radio.checked = optionIndex === 0;
          var copy = documentRef.createElement('span');
          var optionLabel = documentRef.createElement('b');
          optionLabel.textContent = String(option.label || '');
          var description = documentRef.createElement('small');
          description.textContent = String(option.description || '');
          copy.appendChild(optionLabel);
          copy.appendChild(description);
          label.appendChild(radio);
          label.appendChild(copy);
          optionList.appendChild(label);
          listenPending(radio, 'change', updatePendingInputControls);
        });

        var otherLabel = documentRef.createElement('label');
        otherLabel.className = 'pending-option pending-option-other';
        var otherRadio = documentRef.createElement('input');
        otherRadio.type = 'radio';
        otherRadio.name = 'page-conversation-question-' + questionIndex;
        otherRadio.value = '__other__';
        var otherCopy = documentRef.createElement('span');
        var otherTitle = documentRef.createElement('b');
        otherTitle.textContent = '其他';
        var otherInput = documentRef.createElement('input');
        otherInput.type = 'text';
        otherInput.className = 'pending-other-input';
        otherInput.maxLength = 1000;
        otherInput.placeholder = '输入回答';
        otherInput.setAttribute('aria-label', String(question.header || '问题') + '的其他回答');
        otherCopy.appendChild(otherTitle);
        otherCopy.appendChild(otherInput);
        otherLabel.appendChild(otherRadio);
        otherLabel.appendChild(otherCopy);
        optionList.appendChild(otherLabel);
        fieldset.appendChild(optionList);
        pendingInputHost.appendChild(fieldset);
        listenPending(otherRadio, 'change', updatePendingInputControls);
        listenPending(otherInput, 'focus', function () {
          otherRadio.checked = true;
          updatePendingInputControls();
        });
        listenPending(otherInput, 'input', updatePendingInputControls);
        listenPending(otherInput, 'keydown', function (event) {
          if (event.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            submitPendingUserInput();
          }
        });
      });

      var actions = documentRef.createElement('div');
      actions.className = 'pending-input-actions';
      pendingSubmitButton = documentRef.createElement('button');
      pendingSubmitButton.type = 'button';
      pendingSubmitButton.className = 'pending-submit';
      pendingSubmitButton.textContent = '提交回答';
      actions.appendChild(pendingSubmitButton);
      pendingInputHost.appendChild(actions);
      listenPending(pendingSubmitButton, 'click', submitPendingUserInput);
      updatePendingInputControls();
    }

    function resizeInput() {
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = Math.min(112, Math.max(30, input.scrollHeight)) + 'px';
    }

    function formatDuration(value) {
      var seconds = Math.max(0, Math.floor(Number(value) / 1000));
      return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }

    function activeRecordingElapsed() {
      var active = recordingState && recordingState.active;
      return active ? Math.max(0, Date.now() - Number(active.startedAt || Date.now())) : 0;
    }

    function syncRecordingTimer(active) {
      if (active && !recordingTimer) {
        recordingTimer = win.setInterval(function () { renderRecordingControls(); }, 1000);
      } else if (!active && recordingTimer) {
        win.clearInterval(recordingTimer);
        recordingTimer = 0;
      }
    }

    function renderRecordingControls() {
      if (!recordButton || destroyed) return;
      var active = recordingState && recordingState.active;
      var activeState = String(active && active.state || '');
      syncRecordingTimer(!!active);
      recordButton.textContent = '';
      if (active) {
        recordButton.className = 'record-button recording';
        var stopping = activeState !== 'recording' || recordingBusy === 'stopping';
        recordButton.textContent = stopping ? '正在停止' : '停止 ' + formatDuration(activeRecordingElapsed());
        recordButton.title = stopping ? '正在停止页面操作录制' : '停止页面操作录制';
        if (active.warning) recordButton.title += '（已达到事件上限的 80%）';
        recordButton.setAttribute('aria-label', recordButton.title + '，' + formatDuration(activeRecordingElapsed()) + '，' + String(Number(active.count) || 0) + ' 个事件');
        recordButton.disabled = !!recordingBusy || activeState !== 'recording';
      } else {
        recordButton.className = 'record-button';
        recordButton.textContent = recordingBusy === 'starting' ? '准备中' : '录制';
        recordButton.title = recordingBusy === 'starting' ? '正在开始录制' : '录制页面操作';
        recordButton.setAttribute('aria-label', recordButton.title);
        recordButton.disabled = !!recordingBusy;
      }
      var collection = recordingCollection();
      var sourceCount = collection && Array.isArray(collection.sourceRecordingIds) ? collection.sourceRecordingIds.length : 0;
      var selectedEventCount = 0;
      (recordingLibrary && recordingLibrary.sources || []).forEach(function (source) {
        selectedEventCount += sourceSelectionState(source).selectedActionCount;
      });
      recordingSummary.hidden = !sourceCount;
      recordingSummaryText.textContent = sourceCount + ' 份录制 · ' + (selectedEventCount
        ? '已选 ' + selectedEventCount + ' 个事件' : '尚未选择事件');
      recordingLibraryButton.textContent = '查看与选择';
      recordingLibraryButton.disabled = false;
      recordingLibraryButton.onclick = openRecordingLibrary;
    }

    function cleanSelectionRanges(ranges) {
      return (ranges || []).map(function (range, index) {
        return {
          recordingId: String(range.recordingId || ''), sourceSha256: String(range.sourceSha256 || ''),
          fromSeq: Number(range.fromSeq), toSeq: Number(range.toSeq), selectionOrder: index,
        };
      });
    }

    function updateRecordingSelection(ranges) {
      var collection = recordingCollection();
      if (!collection || recordingBusy) return Promise.resolve(null);
      recordingBusy = 'selection';
      renderRecordingControls();
      renderRecordingDrawer();
      var requested = cleanSelectionRanges(ranges);
      return sendRecording(contract.TYPES.UPDATE_RECORDING_SELECTION, {
        draftCollectionId: collection.draftCollectionId,
        expectedRevision: collection.revision,
        ranges: requested,
      }).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) {
          syncPreviewSelection();
          setNotice(response.error || '更新录制选择失败', true);
          return refreshRecordingState().then(function () { return response; });
        }
        if (!recordingState) recordingState = {};
        recordingState.collection = response.payload;
        if (recordingLibrary) recordingLibrary.collection = response.payload;
        syncPreviewSelection();
        var finalRanges = response.payload && response.payload.selectedRanges || [];
        if (JSON.stringify(cleanSelectionRanges(finalRanges)) !== JSON.stringify(requested)) {
          setNotice('重叠或重复范围已归一为：' + finalRanges.map(function (range) {
            return range.recordingId + ' ' + range.fromSeq + '..' + range.toSeq;
          }).join('；'), false, 5000);
        }
        return refreshRecordingLibrary();
      }).catch(function (error) {
        if (destroyed) return null;
        syncPreviewSelection();
        setNotice(error && error.message || '选择保存失败，请重试', true);
        return null;
      }).finally(function () { recordingBusy = ''; renderRecordingControls(); renderRecordingDrawer(); });
    }

    async function removeRecordingSource(source) {
      var collection = recordingCollection();
      if (!collection || recordingBusy) return;
      if (!await showConsent({ title: '删除录制', message: '永久删除此录制？录制正文、待提交选择和读取授权都会立即删除，已提交对话中的历史附件也将无法再读取。此操作不可恢复。', okText: '永久删除', danger: true })) return;
      if (destroyed || recordingBusy) return;
      recordingBusy = 'remove-source';
      renderRecordingControls();
      renderRecordingDrawer();
      sendRecording(contract.TYPES.REMOVE_RECORDING_SOURCE, {
        draftCollectionId: collection.draftCollectionId, recordingId: source.recordingId,
        expectedRevision: collection.revision,
      }).then(function (response) {
        if (!response.ok) { setNotice(response.error || '删除录制失败', true); return response; }
        if (destroyed) return response;
        recordingState.collection = response.payload;
        previewState = { recordingId: '', manifest: null, events: [], query: {}, nextCursor: '', errorDetails: null, selectedSeqs: null };
        return refreshRecordingLibrary();
      }).catch(function (error) {
        if (!destroyed) setNotice(error && error.message || '删除录制失败，请重试', true);
      }).finally(function () { recordingBusy = ''; renderRecordingControls(); renderRecordingDrawer(); });
    }

    function sourceById(recordingId) {
      return (recordingLibrary && recordingLibrary.sources || []).find(function (source) { return source.recordingId === recordingId; }) || null;
    }

    function selectRecordingSource(source, selected) {
      if (!source || recordingBusy) return;
      var existing = cleanSelectionRanges(selectedRecordingRanges());
      var firstSourceIndex = existing.findIndex(function (range) { return range.recordingId === source.recordingId; });
      var retained = existing.filter(function (range) { return range.recordingId !== source.recordingId; });
      if (selected) {
        var eventCount = Math.max(0, Number(source.stats && source.stats.eventCount) || 0);
        if (!eventCount || source.missing) {
          setNotice('这份录制没有可选择的事件', true);
          renderRecordingDrawer();
          return;
        }
        var insertAt = firstSourceIndex < 0 ? retained.length : Math.min(firstSourceIndex, retained.length);
        retained.splice(insertAt, 0, {
          recordingId: source.recordingId, sourceSha256: source.sourceSha256,
          fromSeq: 1, toSeq: eventCount, selectionOrder: insertAt,
        });
      }
      retained.forEach(function (range, index) { range.selectionOrder = index; });
      if (retained.length > recordingContract.LIMITS.MAX_COMMAND_RANGES) {
        setNotice('当前选择过于分散，请减少选择后重试', true, 6000);
        renderRecordingDrawer();
        return;
      }
      updateRecordingSelection(retained);
    }

    function sourceDisplayName(recordingId) {
      var sources = recordingLibrary && recordingLibrary.sources || [];
      var index = sources.findIndex(function (source) { return source.recordingId === recordingId; });
      return index >= 0 ? '录制 ' + (index + 1) : '录制';
    }

    function isPrimaryRecordingEvidence(recordingId, seq) {
      return selectedRecordingRanges().some(function (range) {
        return range.recordingId === recordingId && seq >= Number(range.fromSeq) && seq <= Number(range.toSeq);
      });
    }

    function previewRequest(source, query, append) {
      var collection = recordingCollection();
      if (destroyed || !collection || !source || recordingBusy) return Promise.resolve(null);
      var currentPreview = previewState;
      recordingBusy = 'preview';
      previewState.errorDetails = null;
      previewState.error = '';
      previewState.failedQuery = null;
      renderRecordingControls();
      renderRecordingDrawer();
      return sendRecording(contract.TYPES.GET_RECORDING_PREVIEW, {
        draftCollectionId: collection.draftCollectionId, recordingId: source.recordingId,
        expectedRevision: collection.revision,
        query: query || {},
      }).then(function (response) {
        if (destroyed || previewState !== currentPreview) return response;
        if (!response.ok) {
          previewState.errorDetails = response.details || null;
          previewState.error = response.error || '加载录制失败，请重试';
          previewState.failedQuery = query || {};
          previewState.failedAppend = append === true;
          return response;
        }
        var representation = response.payload || {};
        if (!query || !query.view || query.view === 'manifest') previewState.manifest = representation.data || null;
        else {
          var data = representation.data || {};
          var nextItems = data.events || data.results || [];
          previewState.events = append ? previewState.events.concat(nextItems) : nextItems;
          previewState.nextCursor = String(data.nextCursor || '');
          previewState.totalMatched = Number(data.totalMatched) || 0;
          previewState.errorDetails = null;
        }
        return response;
      }).catch(function (error) {
        if (destroyed || previewState !== currentPreview) return null;
        previewState.error = error && error.message || '加载录制失败，请重试';
        previewState.failedQuery = query || {};
        previewState.failedAppend = append === true;
        return null;
      }).finally(function () { recordingBusy = ''; renderRecordingControls(); renderRecordingDrawer(); });
    }

    function openRecordingSource(source) {
      if (!expanded || !recordingDrawer || !source || source.missing || recordingBusy) return;
      recordingSourceScrollTop = recordingDrawerBody.scrollTop;
      previewState = {
        recordingId: source.recordingId, manifest: null, events: [],
        query: { view: 'events', limit: 20 }, nextCursor: '', errorDetails: null,
        category: 'all', searchText: '', expandedSeqs: Object.create(null), totalMatched: 0,
        selectedSeqs: previewSelectionForSource(source.recordingId),
      };
      recordingDrawer.hidden = false;
      recordingDrawerFocusKey = '';
      recordingDrawerBody.scrollTop = 0;
      renderRecordingDrawer();
      recordingDrawerClose.focus({ preventScroll: true });
      var currentPreview = previewState;
      previewRequest(source, {}).then(function (response) {
        if (destroyed || previewState !== currentPreview || !response || !response.ok) return;
        return previewRequest(source, previewState.query, false);
      });
    }

    function openRecordingLibrary() {
      if (!recordingDrawer) return;
      closeContextPopover(false);
      if (!expanded) { setExpanded(true, false); renderMessages(); }
      previewState = { recordingId: '', manifest: null, events: [], query: {}, nextCursor: '', errorDetails: null, selectedSeqs: null };
      recordingSourceLimit = RECORDING_SOURCE_PAGE_SIZE;
      recordingSourceScrollTop = 0;
      recordingDrawerFocusKey = '';
      recordingDrawer.hidden = false;
      recordingDrawerBody.scrollTop = 0;
      panel.classList.add('recording-open');
      recordingLibraryButton.setAttribute('aria-expanded', 'true');
      renderRecordingDrawer();
      refreshPanelPosition();
      recordingDrawerClose.focus({ preventScroll: true });
    }

    function closeRecordingLibrary() {
      if (!recordingDrawer) return;
      if (sourceById(previewState.recordingId)) {
        var sourceId = previewState.recordingId;
        var listScrollTop = recordingSourceScrollTop;
        previewState = { recordingId: '', manifest: null, events: [], query: {}, nextCursor: '', errorDetails: null, selectedSeqs: null };
        recordingDrawerFocusKey = '';
        recordingDrawerClose.focus({ preventScroll: true });
        recordingDrawerBody.scrollTop = 0;
        renderRecordingDrawer();
        recordingDrawerBody.scrollTop = listScrollTop;
        var sourceButton = Array.prototype.find.call(recordingDrawerBody.querySelectorAll('[data-recording-focus]'), function (node) {
          return node.getAttribute('data-recording-focus') === 'preview-' + sourceId;
        });
        if (sourceButton) {
          if (!sourceButton.disabled) sourceButton.focus({ preventScroll: true });
          sourceButton.scrollIntoView({ block: 'nearest' });
        }
        recordingSourceScrollTop = recordingDrawerBody.scrollTop;
        return;
      }
      recordingDrawer.hidden = true;
      panel.classList.remove('recording-open');
      recordingLibraryButton.setAttribute('aria-expanded', 'false');
      renderMessages({ preserveScroll: true });
      refreshPanelPosition();
      recordingLibraryButton.focus({ preventScroll: true });
    }

    function filterRecordingEvents(category, searchText) {
      if (recordingBusy) return;
      var source = sourceById(previewState.recordingId);
      var filter = RECORDING_CATEGORIES.find(function (item) { return item.id === category; }) || RECORDING_CATEGORIES[0];
      var query = { view: 'events', limit: 20 };
      searchText = String(searchText || '').trim();
      if (filter.kinds.length) query.kinds = filter.kinds;
      if (searchText) { query.view = 'search'; query.q = searchText; query.context = 0; }
      previewState.category = filter.id;
      previewState.searchText = searchText;
      previewState.query = query;
      previewState.events = [];
      previewState.nextCursor = '';
      previewState.totalMatched = 0;
      recordingDrawerBody.scrollTop = 0;
      return previewRequest(source, query, false);
    }

    function element(tag, className, textValue) {
      var value = documentRef.createElement(tag);
      if (className) value.className = className;
      if (textValue !== undefined) value.textContent = textValue;
      return value;
    }

    function commandButton(label, handler, secondary) {
      var button = element('button', secondary ? 'secondary-command' : 'primary-command', label);
      button.type = 'button'; button.addEventListener('click', handler); return button;
    }

    function eventSequence(event) {
      return Number(event && (event.seq || event.match && event.match.seq)) || 0;
    }

    function eventRecord(event) {
      return event && event.match || event || {};
    }

    function compactDisplay(value, max) {
      value = String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, ' ');
      max = Math.max(1, Number(max) || 160);
      return value.length > max ? value.slice(0, max - 1) + '…' : value;
    }

    function displayValue(value, max) {
      if (value === undefined) return '';
      if (typeof value === 'string') return compactDisplay(value, max);
      if (Array.isArray(value)) return compactDisplay(value.join('、'), max);
      if (value && typeof value === 'object') return compactDisplay(Object.keys(value).map(function (key) {
        return key + ': ' + String(value[key]);
      }).join('；'), max);
      return compactDisplay(value, max);
    }

    function targetLabel(event) {
      event = eventRecord(event);
      var target = event.target || {};
      var locator = event.locator || {};
      var context = compactDisplay(target.context || target.landmark && target.landmark.name, 160);
      var name = compactDisplay(target.name || target.text || target.title, 160);
      var purpose = String(target.purpose || '').toLowerCase();
      if (purpose === 'toggle' && context) return '「' + context + '」菜单';
      if (purpose === 'checkbox' && (name || context)) return '复选框「' + (name || context) + '」';
      if (purpose === 'radio' && (name || context)) return '单选项「' + (name || context) + '」';
      if (purpose === 'link' && (name || context)) return '链接「' + (name || context) + '」';
      if (name) return '「' + name + '」';
      if (context) return '与「' + context + '」关联的' + (purpose === 'toggle' ? '展开/收起按钮' : '控件');
      var selector = compactDisplay(locator.selector || target.selectorHint || locator.label || locator.textSelector, 180);
      if (selector) return (target.tag ? '<' + target.tag + '> ' : '') + selector;
      return compactDisplay(target.description, 180) || '未命名页面元素';
    }

    function eventTitle(event) {
      event = eventRecord(event);
      if (event.network) {
        var network = event.network;
        var type = { fetch: 'Fetch', xhr: 'XHR', websocket: 'WebSocket', sse: 'SSE' }[network.resourceType] || '网络';
        var phase = { request: '发起', open: '连接打开', send: '发送', message: '接收', close: '连接关闭', error: '错误', response: '响应' }[network.phase] || '响应';
        return type + ' ' + phase + '：' + (event.kind === 'http' ? String(network.method || 'GET') + ' ' : '') + compactDisplay(event.url, 180);
      }
      var target = targetLabel(event);
      var value = displayValue(event.value, 160);
      var inputValue = event.input || {};
      if (event.kind === 'click') {
        if (inputValue.checked === true) return '勾选 ' + target;
        if (inputValue.checked === false) return '取消勾选 ' + target;
        if (event.target && event.target.purpose === 'toggle' && inputValue.expanded === true) return '展开 ' + target;
        if (event.target && event.target.purpose === 'toggle' && inputValue.expanded === false) return '收起 ' + target;
        if (event.target && event.target.purpose === 'toggle') return '切换 ' + target;
        if (Number(inputValue.clickCount) >= 2) return '双击 ' + target;
        return '点击 ' + target;
      }
      if (event.kind === 'fill') return '在 ' + target + ' 输入' + (value ? '「' + value + '」' : '内容');
      if (event.kind === 'select') return '在 ' + target + ' 选择' + (value ? '「' + value + '」' : '选项');
      if (event.kind === 'key') return '在 ' + target + ' 按下 ' + compactDisplay(inputValue.key, 40);
      if (event.kind === 'submit') return '提交 ' + target;
      if (event.kind === 'navigation') {
        var navigation = event.navigation || {};
        var destination = compactDisplay(navigation.to || event.url, 220) || '未知地址';
        if (navigation.status === 'error' || navigation.error) return '页面加载失败：' + destination;
        return (navigation.disposition === 'effect' ? '随后跳转到 ' : '打开 ') + destination;
      }
      if (event.kind === 'recording_start' || event.kind === 'tab_created' && event.tabEvent && (event.tabEvent.disposition === 'baseline' || event.tabEvent.baseline === true)) {
        return '录制起始页：' + compactDisplay(event.url, 220);
      }
      if (event.kind === 'tab_created') return '打开新标签页：' + compactDisplay(event.url, 220);
      if (event.kind === 'tab_closed') return '关闭标签页 ' + String(event.tab || '');
      if (event.kind === 'navigation_target') return '创建新的导航目标';
      return compactDisplay(event.kind, 80) + '：' + target;
    }

    function setPreviewSeq(seq, checked) {
      seq = Number(seq);
      if (!(seq > 0) || recordingBusy) return;
      if (!previewState.selectedSeqs) previewState.selectedSeqs = Object.create(null);
      if (checked) previewState.selectedSeqs[seq] = true;
      else delete previewState.selectedSeqs[seq];
      renderRecordingDrawer();
      persistPreviewSelection(sourceById(previewState.recordingId));
    }

    function clearPreviewSelection() {
      if (recordingBusy) return;
      previewState.selectedSeqs = Object.create(null);
      renderRecordingDrawer();
      persistPreviewSelection(sourceById(previewState.recordingId));
    }

    function selectLoadedPreviewEvents() {
      if (recordingBusy) return;
      if (!previewState.selectedSeqs) previewState.selectedSeqs = Object.create(null);
      previewState.events.forEach(function (event) { previewState.selectedSeqs[eventSequence(event)] = true; });
      persistPreviewSelection(sourceById(previewState.recordingId));
    }

    function rangesFromPreviewSelection(source) {
      var seqs = Object.keys(previewState.selectedSeqs || {}).filter(function (seq) {
        return previewState.selectedSeqs[seq] === true;
      }).map(Number).filter(function (seq) { return seq > 0; }).sort(function (left, right) { return left - right; });
      var ranges = [];
      seqs.forEach(function (seq) {
        var previous = ranges[ranges.length - 1];
        if (previous && seq === previous.toSeq + 1) previous.toSeq = seq;
        else ranges.push({ recordingId: source.recordingId, sourceSha256: source.sourceSha256, fromSeq: seq, toSeq: seq, selectionOrder: 0 });
      });
      return ranges;
    }

    function persistPreviewSelection(source) {
      if (!source) return;
      var existing = cleanSelectionRanges(selectedRecordingRanges());
      var replacements = rangesFromPreviewSelection(source);
      var firstSourceIndex = existing.findIndex(function (range) { return range.recordingId === source.recordingId; });
      var retained = existing.filter(function (range) { return range.recordingId !== source.recordingId; });
      var insertAt = firstSourceIndex < 0 ? retained.length : Math.min(firstSourceIndex, retained.length);
      var combined = retained.slice(0, insertAt).concat(replacements, retained.slice(insertAt));
      combined.forEach(function (range, index) { range.selectionOrder = index; });
      if (combined.length > recordingContract.LIMITS.MAX_COMMAND_RANGES) {
        setNotice('当前选择过于分散，请减少选择后重试。', true, 6000);
        syncPreviewSelection();
        renderRecordingDrawer();
        return;
      }
      updateRecordingSelection(combined);
    }

    function downloadTextFile(text, fileName, mimeType) {
      conversationShared.downloadFile(String(fileName || 'download.txt'), String(text || ''), mimeType || 'application/octet-stream');
    }

    async function exportRecordingSource(source) {
      var collection = recordingCollection();
      if (!collection || !source || recordingBusy) return;
      if (!await showConsent({ title: '导出录制', message: '导出文件包含整份录制中的页面操作、输入值、URL，以及勾选采集的网络请求和消息，可能含密码、验证码、账号或其他敏感信息。是否导出这份录制？', okText: '导出录制' })) return;
      if (destroyed || recordingBusy) return;
      recordingBusy = 'export';
      renderRecordingDrawer();
      var chunks = [];
      var expectedHash = String(source.sourceSha256 || '');
      function readChunk(start) {
        return sendRecording(contract.TYPES.EXPORT_RECORDING_SOURCE, {
          draftCollectionId: collection.draftCollectionId, recordingId: source.recordingId,
          expectedRevision: collection.revision,
          start: start, maxChars: recordingContract.LIMITS.MAX_EXPORT_CHUNK_CHARS,
        }).then(function (response) {
          if (!response.ok) throw new Error(response.error || '导出录制失败');
          var payload = response.payload || {};
          if (String(payload.sourceSha256 || '') !== expectedHash || Number(payload.start) !== Number(start)) throw new Error('导出内容与当前录制不一致');
          chunks.push(String(payload.chunk || ''));
          if (payload.hasMore) {
            if (!(Number(payload.nextStart) > Number(start))) throw new Error('导出分页没有前进');
            return readChunk(Number(payload.nextStart));
          }
          downloadTextFile(chunks.join(''), payload.fileName || source.recordingId + '.json', payload.mimeType || 'application/json;charset=utf-8');
          setNotice('录制已导出', false, 3000);
          return payload;
        });
      }
      readChunk(0).catch(function (error) {
        setNotice(error && error.message || '导出录制失败', true, 6000);
      }).finally(function () { recordingBusy = ''; renderRecordingDrawer(); });
    }

    function loadMoreRecordingSources() {
      if (destroyed || !recordingDrawer || recordingDrawer.hidden || sourceById(previewState.recordingId)) return;
      var sourceCount = (recordingLibrary && recordingLibrary.sources || []).length;
      if (recordingSourceLimit >= sourceCount) return;
      recordingSourceLimit = Math.min(sourceCount, recordingSourceLimit + RECORDING_SOURCE_PAGE_SIZE);
      renderRecordingDrawer();
    }

    function handleRecordingSourcesScroll() {
      if (destroyed || !recordingDrawer || recordingDrawer.hidden || sourceById(previewState.recordingId)) return;
      var previousTop = recordingSourceScrollTop;
      recordingSourceScrollTop = recordingDrawerBody.scrollTop;
      if (recordingSourceScrollTop > previousTop
          && recordingDrawerBody.scrollHeight - recordingSourceScrollTop - recordingDrawerBody.clientHeight <= 24) {
        loadMoreRecordingSources();
      }
    }

    function handleRecordingSourcesWheel(event) {
      if (event.deltaY > 0 && recordingDrawerBody.scrollHeight <= recordingDrawerBody.clientHeight + 1) {
        loadMoreRecordingSources();
      }
    }

    function renderSourceList(parent) {
      var sources = (recordingLibrary && recordingLibrary.sources || []).slice().sort(function (left, right) {
        return (Number(right.startedAt) || 0) - (Number(left.startedAt) || 0);
      });
      var section = element('section', 'recording-section recording-source-list');
      section.appendChild(element('p', 'recording-help', '勾选整份录制，或点击「查看」按需选择事件。'));
      if (!sources.length) {
        section.appendChild(element('p', 'recording-empty', '暂无录制。关闭此窗口，点击「录制」开始采集。'));
      }
      sources.slice(0, recordingSourceLimit).forEach(function (source) {
        var sourceName = sourceDisplayName(source.recordingId);
        var selection = sourceSelectionState(source);
        var selected = selection.selected;
        var row = element('div', 'recording-source-row' + (selected ? ' checked' : ''));
        var checkbox = element('input', 'recording-source-check');
        checkbox.type = 'checkbox'; checkbox.checked = selection.fullySelected;
        checkbox.indeterminate = selected && !selection.fullySelected;
        checkbox.disabled = !!recordingBusy || !!source.missing || !(Number(source.stats && source.stats.eventCount) > 0);
        checkbox.setAttribute('aria-label', (selection.fullySelected ? '取消全选' : '全选') + sourceName);
        checkbox.setAttribute('data-recording-focus', 'source-' + source.recordingId);
        checkbox.addEventListener('change', function () { selectRecordingSource(source, checkbox.checked); });
        var info = element('div', 'recording-source-copy');
        var sourceHeading = element('div', 'recording-source-heading');
        var sourceTitle = element('strong', '', sourceName);
        sourceHeading.appendChild(sourceTitle);
        if (source.startedAt) {
          var startedAt = new Date(source.startedAt);
          var timestamp = element('time', '', startedAt.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }));
          timestamp.title = startedAt.toLocaleString();
          sourceHeading.appendChild(timestamp);
        }
        info.appendChild(sourceHeading);
        info.appendChild(element('span', '', source.missing ? '录制缺失' : '已选 ' + selection.selectedActionCount + '/' + (Number(source.stats && source.stats.eventCount) || 0) + ' 项 · ' + formatDuration(source.durationMs)));
        var actions = element('div', 'recording-row-actions');
        var refineButton = commandButton('查看', function () { openRecordingSource(source); });
        refineButton.disabled = !!recordingBusy || !!source.missing;
        refineButton.setAttribute('data-recording-focus', 'preview-' + source.recordingId);
        actions.appendChild(refineButton);
        var exportButton = commandButton(recordingBusy === 'export' ? '导出中…' : '导出', function () { exportRecordingSource(source); }, true);
        exportButton.disabled = !!recordingBusy || !!source.missing;
        exportButton.setAttribute('data-recording-focus', 'export-' + source.recordingId);
        actions.appendChild(exportButton);
        var removeButton = commandButton('删除', function () { removeRecordingSource(source); }, true);
        removeButton.classList.add('danger-command');
        removeButton.disabled = !!recordingBusy;
        removeButton.setAttribute('data-recording-focus', 'remove-' + source.recordingId);
        actions.appendChild(removeButton);
        row.appendChild(checkbox); row.appendChild(info); row.appendChild(actions); section.appendChild(row);
      });
      if (recordingSourceLimit < sources.length) {
        var loadMore = commandButton('加载更多', loadMoreRecordingSources, true);
        loadMore.title = '向下滚动加载更多录制，每次 5 条';
        loadMore.setAttribute('data-recording-focus', 'load-more-sources');
        var moreActions = element('div', 'recording-row-actions');
        moreActions.appendChild(loadMore);
        section.appendChild(moreActions);
      }
      parent.appendChild(section);
    }

    function appendEventDetail(parent, label, value, className) {
      if (value === undefined || value === null || value === '') return;
      var row = element('div', 'recording-event-detail' + (className ? ' ' + className : ''));
      row.appendChild(element('span', '', label));
      row.appendChild(element('div', '', String(value)));
      parent.appendChild(row);
    }

    function booleanLabel(value) {
      return value === true ? '是' : (value === false ? '否' : '');
    }

    function modifierLabel(modifiers) {
      if (!modifiers) return '';
      var labels = [];
      if (modifiers.ctrl) labels.push('Ctrl');
      if (modifiers.alt) labels.push('Alt');
      if (modifiers.shift) labels.push('Shift');
      if (modifiers.meta) labels.push('Meta');
      return labels.join(' + ');
    }

    function appendStructuredEventDetails(parent, record) {
      var network = record.network;
      if (network) {
        appendEventDetail(parent, '请求方式', network.resourceType === 'websocket' ? '' : network.method);
        appendEventDetail(parent, '状态码', network.status || '');
        appendEventDetail(parent, '阶段', network.phase);
        appendEventDetail(parent, '耗时(ms)', network.durationMs);
        appendEventDetail(parent, '内容类型', network.contentType);
        appendEventDetail(parent, '请求头', network.requestHeaders ? JSON.stringify(network.requestHeaders, null, 2) : '');
        appendEventDetail(parent, '请求正文', network.requestBody, 'raw-value');
        appendEventDetail(parent, '响应/消息', network.bodyText, 'raw-value');
        appendEventDetail(parent, '连接标识', network.streamId);
        appendEventDetail(parent, '消息序号', network.streamSeq);
        appendEventDetail(parent, '事件名称', network.eventName);
        appendEventDetail(parent, '事件 ID', network.eventId);
        appendEventDetail(parent, '关闭代码', network.closeCode);
        appendEventDetail(parent, '关闭原因', network.closeReason);
        appendEventDetail(parent, '错误', network.error);
        appendEventDetail(parent, '采集截断', network.bodyTruncated || network.requestBodyTruncated ? '正文超过采集上限，已截断' : '');
        appendEventDetail(parent, '显示截断', record.fieldWindows ? '长字段仅显示摘要，可导出查看已采集正文' : '');
      }
      var navigation = record.navigation || {};
      appendEventDetail(parent, '来源页面', navigation.from);
      appendEventDetail(parent, '目标页面', navigation.to);
      appendEventDetail(parent, '加载状态', navigation.status);
      appendEventDetail(parent, '加载错误', navigation.error);
      appendEventDetail(parent, '跳转关系', navigation.disposition === 'effect' ? '由前一动作触发' : (navigation.disposition === 'explicit' ? '明确打开地址' : navigation.disposition));
      appendEventDetail(parent, '触发动作', navigation.triggerSeq ? '第 ' + navigation.triggerSeq + ' 项' : '');
      appendEventDetail(parent, '跳转类型', navigation.transitionType);
      appendEventDetail(parent, '跳转标记', Array.isArray(navigation.transitionQualifiers) ? navigation.transitionQualifiers.join('、') : '');

      var inputFact = record.input || {};
      appendEventDetail(parent, '按键', inputFact.key);
      appendEventDetail(parent, '点击次数', inputFact.clickCount);
      appendEventDetail(parent, '鼠标按钮', inputFact.button);
      appendEventDetail(parent, '已勾选', booleanLabel(inputFact.checked));
      appendEventDetail(parent, '已展开', booleanLabel(inputFact.expanded));
      appendEventDetail(parent, '组合键', modifierLabel(inputFact.modifiers));

      var locator = record.locator || {};
      appendEventDetail(parent, 'CSS 定位', locator.selector);
      appendEventDetail(parent, '文字定位', locator.textSelector);
      appendEventDetail(parent, '文字规则', locator.textPattern);
      appendEventDetail(parent, '标签定位', locator.label);
      appendEventDetail(parent, '范围定位', locator.scopeSelector);
      appendEventDetail(parent, '相对定位', displayValue(locator.relative, 1000));

      var causation = record.causation || {};
      appendEventDetail(parent, '因果类型', causation.kind);
      appendEventDetail(parent, '来源标签页', causation.sourceTab);
      appendEventDetail(parent, '来源 frame', causation.sourceFrame);
      var tabEvent = record.tabEvent || {};
      appendEventDetail(parent, '标签页动作', tabEvent.disposition);
      appendEventDetail(parent, '来源标签页', tabEvent.openerTab);
      appendEventDetail(parent, '新窗口', booleanLabel(tabEvent.windowCreated));
      appendEventDetail(parent, '窗口关闭', booleanLabel(tabEvent.windowClosing));
    }

    function renderEventCard(event, source) {
      var record = eventRecord(event);
      var seq = eventSequence(record);
      var selected = !!(previewState.selectedSeqs && previewState.selectedSeqs[seq]);
      var saved = isPrimaryRecordingEvidence(source.recordingId, seq);
      var card = element('article', 'recording-action-card' + (selected ? ' selected' : '') + (saved ? ' saved-evidence' : ''));
      var checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected;
      checkbox.disabled = !!recordingBusy;
      checkbox.setAttribute('aria-label', '选择事件 ' + seq + '：' + eventTitle(record));
      checkbox.id = 'recording-event-check-' + seq;
      checkbox.setAttribute('data-recording-focus', 'event-' + seq);
      checkbox.addEventListener('change', function () { setPreviewSeq(seq, checkbox.checked); });
      var order = element('span', 'recording-action-order', String(seq));
      var copy = element('label', 'recording-action-copy');
      copy.htmlFor = checkbox.id;
      var heading = element('span', 'recording-action-heading');
      heading.appendChild(element('strong', '', eventTitle(record)));
      copy.appendChild(heading);
      var category = RECORDING_CATEGORIES.find(function (item) { return item.kinds.indexOf(record.kind) !== -1; });
      copy.appendChild(element('span', 'recording-action-meta', (category ? category.label + ' · ' : '') + formatDuration(Number(record.t) || 0) + ' · ' + String(record.tab || 'T1') + (record.frame === 'child' ? ' · 子页面' : '') + (record.network && record.network.status ? ' · 状态 ' + record.network.status : '')));
      var details = element('details', 'recording-action-details');
      var detailSummary = element('summary', '', '查看详情');
      detailSummary.setAttribute('data-recording-focus', 'details-' + seq);
      details.appendChild(detailSummary);
      details.open = !!(previewState.expandedSeqs && previewState.expandedSeqs[seq]);
      details.addEventListener('toggle', function () {
        if (!details.isConnected || previewState.recordingId !== source.recordingId) return;
        if (!previewState.expandedSeqs) previewState.expandedSeqs = Object.create(null);
        previewState.expandedSeqs[seq] = details.open;
      });
      if (!record.network) appendEventDetail(details, '目标', targetLabel(record));
      appendEventDetail(details, '目标语境', record.target && record.target.context);
      appendEventDetail(details, '原始值', record.value, 'raw-value');
      appendEventDetail(details, '链接', record.href);
      appendEventDetail(details, '表单地址', record.action);
      appendEventDetail(details, '页面标题', record.title);
      appendEventDetail(details, record.network ? '请求地址' : '页面地址', record.url);
      appendStructuredEventDetails(details, record);
      card.appendChild(checkbox); card.appendChild(order); card.appendChild(copy); card.appendChild(details);
      return card;
    }

    function renderPreview(parent) {
      var source = sourceById(previewState.recordingId);
      if (!source) return;
      var section = element('section', 'recording-section recording-preview');
      if (previewState.error) {
        var errorBox = element('div', 'recording-error-hint');
        errorBox.setAttribute('role', 'alert');
        errorBox.appendChild(element('p', '', previewState.errorDetails && previewState.errorDetails.seq
          ? '第 ' + previewState.errorDetails.seq + ' 个事件内容较长，暂时无法展示。可返回列表导出录制查看。'
          : previewState.error));
        var retry = commandButton('重试', function () {
          var query = previewState.failedQuery;
          var currentPreview = previewState;
          previewRequest(source, query, previewState.failedAppend).then(function (response) {
            if (!destroyed && previewState === currentPreview && response && response.ok && (!query || !query.view)) {
              previewRequest(source, previewState.query, false);
            }
          });
        }, true);
        retry.disabled = !!recordingBusy;
        retry.setAttribute('data-recording-focus', 'retry');
        errorBox.appendChild(retry);
        section.appendChild(errorBox);
      }
      if (!previewState.manifest) {
        section.appendChild(element('p', 'recording-empty', recordingBusy === 'preview' ? '正在读取录制…' : '录制详情不可用'));
        parent.appendChild(section); return;
      }
      var manifest = previewState.manifest;
      var eventCount = Number(manifest.stats && manifest.stats.eventCount || 0);
      var selectedCount = Object.keys(previewState.selectedSeqs || {}).filter(function (seq) {
        return previewState.selectedSeqs[seq] === true;
      }).length;
      var filters = element('div', 'recording-filters');
      var categories = element('div', 'recording-categories');
      categories.setAttribute('role', 'group');
      categories.setAttribute('aria-label', '按事件分类筛选');
      RECORDING_CATEGORIES.forEach(function (category) {
        var categoryButton = commandButton(category.label, function () {
          filterRecordingEvents(category.id, previewState.searchText);
        }, true);
        categoryButton.setAttribute('aria-pressed', String((previewState.category || 'all') === category.id));
        categoryButton.setAttribute('data-recording-focus', 'category-' + category.id);
        categoryButton.disabled = !!recordingBusy;
        categories.appendChild(categoryButton);
      });
      filters.appendChild(categories);
      var search = element('form', 'recording-search');
      search.setAttribute('role', 'search');
      var searchInput = element('input');
      searchInput.type = 'search';
      searchInput.placeholder = '搜索请求地址、名称或内容';
      searchInput.setAttribute('aria-label', '在整份录制的当前分类中搜索');
      searchInput.setAttribute('data-recording-focus', 'search');
      searchInput.maxLength = recordingContract.LIMITS.MAX_SEARCH_QUERY;
      searchInput.value = previewState.searchText || '';
      searchInput.addEventListener('input', function () { previewState.searchText = searchInput.value; });
      searchInput.addEventListener('search', function () {
        if (!searchInput.value && !recordingBusy) filterRecordingEvents(previewState.category, '');
      });
      var searchButton = element('button', 'primary-command', '搜索');
      searchButton.type = 'submit'; searchButton.disabled = !!recordingBusy;
      searchButton.setAttribute('data-recording-focus', 'search-submit');
      search.addEventListener('submit', function (event) {
        event.preventDefault();
        filterRecordingEvents(previewState.category, searchInput.value);
      });
      search.appendChild(searchInput); search.appendChild(searchButton);
      if (previewState.query.q || previewState.category !== 'all') {
        var reset = commandButton('重置', function () { filterRecordingEvents('all', ''); }, true);
        reset.disabled = !!recordingBusy;
        reset.setAttribute('data-recording-focus', 'reset');
        search.appendChild(reset);
      }
      filters.appendChild(search);
      section.appendChild(filters);
      var selectionBar = element('div', 'recording-selection-bar');
      var selectionStatus = element('strong', '', '已选 ' + selectedCount + '/' + eventCount + (recordingBusy === 'selection' ? ' · 保存中…' : ''));
      selectionStatus.title = '选择自动保存';
      selectionStatus.setAttribute('role', 'status');
      selectionBar.appendChild(selectionStatus);
      var selectLoaded = commandButton('全选', selectLoadedPreviewEvents, true);
      selectLoaded.title = '全选当前已显示的事件';
      selectLoaded.setAttribute('aria-label', selectLoaded.title);
      selectLoaded.disabled = !!recordingBusy || !previewState.events.length || previewState.events.every(function (event) { return previewState.selectedSeqs && previewState.selectedSeqs[eventSequence(event)]; });
      selectLoaded.setAttribute('data-recording-focus', 'select-loaded');
      selectionBar.appendChild(selectLoaded);
      var clearSelection = commandButton('清空', clearPreviewSelection, true);
      clearSelection.title = '清空这份录制的所有已选事件';
      clearSelection.disabled = !!recordingBusy || selectedCount === 0;
      clearSelection.setAttribute('data-recording-focus', 'clear-selection');
      selectionBar.appendChild(clearSelection);
      section.appendChild(selectionBar);
      var resultText = recordingBusy === 'preview' ? '正在加载…' : '显示 ' + previewState.events.length + '/' + (previewState.totalMatched || 0) + ' 个匹配事件';
      if (previewState.query.q) resultText += ' · 搜索「' + previewState.query.q + '」';
      section.appendChild(element('p', 'recording-help', resultText));

      var events = element('div', 'recording-events recording-timeline');
      events.setAttribute('role', 'list');
      previewState.events.slice().sort(function (left, right) {
        return eventSequence(left) - eventSequence(right);
      }).forEach(function (event) {
        var card = renderEventCard(event, source);
        card.setAttribute('role', 'listitem');
        events.appendChild(card);
      });
      if (!previewState.events.length && !previewState.error && recordingBusy !== 'preview') events.appendChild(element('p', 'recording-empty', '没有匹配的事件。可切换分类或重置搜索；网络事件需要在录制前勾选对应采集项。'));
      section.appendChild(events);
      if (previewState.nextCursor) {
        var loadMore = commandButton(recordingBusy === 'preview' ? '加载中…' : '加载更多匹配事件', function () {
          previewRequest(source, Object.assign({}, previewState.query, { cursor: previewState.nextCursor }), true);
        }, true);
        loadMore.disabled = !!recordingBusy;
        loadMore.setAttribute('data-recording-focus', 'load-more');
        section.appendChild(loadMore);
      }
      parent.appendChild(section);
    }

    function renderRecordingDrawer() {
      if (destroyed || !recordingDrawer || recordingDrawer.hidden) return;
      var active = panel.getRootNode().activeElement;
      var restoreFocus = !active || recordingDrawerBody.contains(active);
      if (active && recordingDrawerBody.contains(active)) recordingDrawerFocusKey = active.getAttribute('data-recording-focus') || '';
      var selectionStart = active && active.tagName === 'INPUT' && active.type === 'search' ? active.selectionStart : null;
      var selectionEnd = selectionStart !== null ? active.selectionEnd : null;
      var scrollTop = recordingDrawerBody.scrollTop;
      var hasPreview = !!sourceById(previewState.recordingId);
      recordingDrawerTitle.textContent = hasPreview ? sourceDisplayName(previewState.recordingId) + ' · 录制详情' : '查看与选择录制';
      recordingDrawerClose.title = hasPreview ? '返回录制列表' : '关闭录制选择器';
      recordingDrawerClose.setAttribute('aria-label', recordingDrawerClose.title);
      recordingDrawerBody.textContent = '';
      if (hasPreview) renderPreview(recordingDrawerBody);
      else renderSourceList(recordingDrawerBody);
      recordingDrawerBody.scrollTop = scrollTop;
      if (restoreFocus && recordingDrawerFocusKey) {
        var next = Array.prototype.find.call(recordingDrawerBody.querySelectorAll('[data-recording-focus]'), function (node) {
          return node.getAttribute('data-recording-focus') === recordingDrawerFocusKey;
        });
        if (next && !next.disabled) {
          next.focus({ preventScroll: true });
          if (selectionStart !== null && next.type === 'search') next.setSelectionRange(selectionStart, selectionEnd);
        }
      }
      if (!hasPreview) recordingSourceScrollTop = recordingDrawerBody.scrollTop;
      refreshPanelPosition();
    }

    function refreshApplicationContext(force) {
      var conversationId = !newTopicDraft && topic && topic.topicId || '';
      if (!force && conversationId === appContextTopicId) return;
      appContextTopicId = conversationId;
      var request = ++appContextRequest;
      appContext = null;
      appContextNotice.hidden = true;
      if (!conversationId && !applicationEntry) return;
      runtime.sendMessage({ type: 'APP_CONVERSATION_CONTEXT', conversationId: conversationId }).then(function (response) {
        if (destroyed || request !== appContextRequest || !response || response.error || !response.result) return;
        var app = response.result;
        appContext = app;
        var label = '正在编辑应用：' + app.name;
        if (app.page) {
          label = '当前应用：' + app.page.name + ' · ' + (app.page.slot === 'draft' ? '草稿预览' : '发布版')
            + (app.page.appId !== app.appId ? '；正在编辑：' + app.name : '') + '；代码修改保存到草稿';
        }
        appContextNotice.textContent = label + (app.unavailable ? ' · ' + app.unavailable : '');
        appContextNotice.hidden = false;
      }).catch(function () {});
    }

    function ensureContextUsage() {
      var topicId = String(topic && topic.topicId || '');
      if (!contextUsage || contextUsage.topicId !== topicId) {
        closeContextPopover(false);
        contextUsage = { topicId: topicId, data: {}, sequence: 0, version: 0, summaryRevision: 0, dirty: true, request: null, error: '' };
        contextRenderKey = '';
      }
      return contextUsage;
    }

    function updateContextUsage(metadata, events) {
      var current = ensureContextUsage();
      (Array.isArray(events) ? events : []).forEach(function (event) {
        if (Number(event.sequence) <= current.sequence) return;
        current.sequence = Number(event.sequence);
        if (event.type === 'model_response_completed') current.dirty = true;
        var payload = event.payload || {};
        if (event.type === 'generation_started') {
          current.data.contextCompression = payload.preferences && payload.preferences.contextCompression || 'auto';
          current.summaryRevision += 1;
          current.version += 1;
        }
        if (/^(?:summary_requested|summary_committed|summary_failed)$/.test(event.type)) {
          current.data.summaryStatus = event.type === 'summary_requested' ? 'running'
            : event.type === 'summary_committed' ? 'completed' : 'failed';
          current.data.summaryError = event.type === 'summary_failed' ? payload.error || payload.errorCode || '' : '';
          current.summaryGenerationId = event.generationId;
          if (event.type === 'summary_committed') {
            current.data.checkpoint = {
              checkpointId: payload.checkpointId,
              createdAt: event.at,
            };
          }
          current.summaryRevision += 1;
          current.version += 1;
        }
      });
      var active = metadata && metadata.activeGeneration;
      if (current.data.summaryStatus === 'running' && (!active
          || ['starting', 'running', 'waiting_user', 'cancelling'].indexOf(active.state) === -1
          || current.summaryGenerationId && current.summaryGenerationId !== active.generationId)) {
        current.data.summaryStatus = 'interrupted';
        current.summaryRevision += 1;
        current.version += 1;
      }
    }

    function loadContextUsage(force) {
      var current = ensureContextUsage();
      if (destroyed || documentRef.hidden || !expanded || !current.topicId
          || !conversationMetadata || conversationMetadata.conversationId !== current.topicId) return null;
      if (current.request) return current.request;
      if (!force && !current.dirty) return null;
      current.dirty = false;
      current.error = '';
      var summaryRevision = current.summaryRevision;
      current.request = sendCommand(contract.COMMANDS.GET_SUMMARY, { conversationId: current.topicId }).then(function (response) {
        if (destroyed || contextUsage !== current) return;
        if (!response.ok) throw new Error(response.error || '读取上下文用量失败');
        var data = response.payload || {};
        // Summary events can arrive while this read is pending. Keep their
        // newer status while accepting the request's budget snapshot.
        if (current.summaryRevision !== summaryRevision) {
          ['summaryStatus', 'summaryError', 'contextCompression', 'checkpoint'].forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(current.data, key)) data[key] = current.data[key];
          });
        }
        current.data = data;
        if (summaryRevision === current.summaryRevision && data.summaryStatus === 'running') {
          current.summaryGenerationId = conversationMetadata.activeGeneration && conversationMetadata.activeGeneration.generationId;
        }
      }).catch(function (error) {
        if (!destroyed && contextUsage === current) current.error = String(error && error.message || error);
      }).finally(function () {
        current.request = null;
        if (destroyed || contextUsage !== current) return;
        current.version += 1;
        renderControls();
      });
      current.version += 1;
      renderContextUsage();
      return current.request;
    }

    function renderContextUsage() {
      if (!contextMeter || destroyed) return;
      var current = ensureContextUsage();
      var key = [current.topicId, current.version, expanded, contextPopover.hidden].join(':');
      if (contextRenderKey === key) return;
      contextRenderKey = key;
      var data = current.data;
      var context = data.context;
      var hasUsage = !current.error && context && Number.isFinite(context.inputTokens) && context.inputTokens >= 0
        && Number.isFinite(context.inputLimit) && context.inputLimit > 0;
      var percent = hasUsage ? context.inputTokens / context.inputLimit * 100 : 0;
      var hasRatio = hasUsage && context.highWaterRatio > 0 && context.highWaterRatio < 1;
      var thresholdPercent = hasRatio ? context.highWaterRatio * 100 : 85;
      var showThreshold = hasRatio && data.contextCompression !== 'off';
      var threshold = showThreshold ? Math.floor(context.inputLimit * context.highWaterRatio) : 0;
      var tone = !hasUsage ? 'unknown' : percent >= thresholdPercent ? 'high'
        : percent >= 70 ? 'warning' : percent >= 50 ? 'moderate' : 'low';
      var remainingText = showThreshold ? (context.inputTokens > threshold ? '已超过阈值'
        : '距阈值约 ' + (threshold - context.inputTokens).toLocaleString() + ' tokens') : '';
      var tooltip = hasUsage ? '最近请求上下文占用' + (context.estimated ? '约 ' : ' ') + percent.toFixed(1) + '%；'
        + context.inputTokens.toLocaleString() + ' / ' + context.inputLimit.toLocaleString() + ' tokens（可用输入预算）'
        : current.error || (current.request ? '正在读取上下文用量' : '暂无上下文用量');
      if (showThreshold) tooltip += '；刻度为自动摘要阈值 ' + thresholdPercent.toFixed(0) + '%，' + remainingText;
      tooltip += '。点击查看上下文。';
      contextMeter.className = 'context-meter is-' + tone;
      contextMeter.disabled = !current.topicId;
      contextMeterValue.textContent = hasUsage ? percent.toFixed(0) + '%' : '—';
      contextMeter.title = tooltip;
      contextMeter.setAttribute('aria-label', tooltip);
      contextMeter.style.setProperty('--context-usage', Math.min(100, percent) + '%');
      contextThreshold.hidden = !showThreshold;
      if (showThreshold) contextMeter.style.setProperty('--context-threshold', thresholdPercent + '%');
      contextCompactButton.hidden = expanded || tone !== 'high' || data.summaryStatus === 'running';
      contextCompactButton.textContent = '上下文 ' + percent.toFixed(0) + '%';
      contextCompactButton.title = tooltip;
      contextRefreshButton.disabled = !!current.request || !current.topicId;
      if (contextPopover.hidden) return;
      contextPopoverBody.textContent = '';
      contextPopoverBody.title = current.error || '';
      conversationShared.contextUsageRows(data, { error: current.error, loading: !!current.request }).forEach(function (row) {
        var item = element('div', 'context-detail-row');
        item.appendChild(element('b', '', row[0]));
        item.appendChild(element('span', '', row[1]));
        contextPopoverBody.appendChild(item);
      });
    }

    function closeContextPopover(restoreFocus) {
      if (!contextPopover || contextPopover.hidden) return;
      contextPopover.hidden = true;
      panel.classList.remove('context-open');
      contextRenderKey = '';
      contextMeter.setAttribute('aria-expanded', 'false');
      renderMessages({ preserveScroll: true });
      refreshPanelPosition();
      if (restoreFocus && expanded) contextMeter.focus();
    }

    function openContextPopover() {
      if (!topic || !topic.topicId || pendingConsent) return;
      if (!contextPopover.hidden) { closeContextPopover(true); return; }
      if (!expanded) setExpanded(true, false);
      contextPopover.hidden = false;
      panel.classList.add('context-open');
      contextMeter.setAttribute('aria-expanded', 'true');
      renderContextUsage();
      loadContextUsage(false);
      refreshPanelPosition();
      contextPopover.querySelector('.icon-button').focus();
    }

    function renderControls() {
      if (destroyed) return;
      ensureContextUsage();
      refreshApplicationContext(false);
      var meta = statusMeta();
      var running = !!(topic && topic.active);
      var collapsedRunning = running && !expanded && meta.kind === 'running';
      if (runtimeStatus) runtimeStatus.setAttribute('aria-live', collapsedRunning ? 'off' : 'polite');
      if (statusText.textContent !== meta.text) statusText.textContent = meta.text;
      if (statusDot.getAttribute('data-status') !== meta.kind) {
        statusDot.textContent = '';
        statusDot.appendChild(iconStatus(meta.kind));
        statusDot.setAttribute('data-status', meta.kind);
      }
      statusDot.className = 'status-dot ' + meta.kind;
      title.textContent = '页面对话';
      topicLabel.textContent = topic && topic.label || (newTopicDraft ? '新话题' : '');
      topicLabel.title = topicLabel.textContent;
      var waitingForInput = !!pendingInputState();
      var operationPending = !!busy;
      syncRunPresentation(running, waitingForInput);
      if (messages && !pendingConsent && contextPopover.hidden) messages.removeAttribute('inert');
      assistantSelect.disabled = operationPending || running || !assistants.length;
      newTopicButton.disabled = operationPending || running || !assistants.length;
      openOptionsButton.disabled = !selectedAssistantId;
      input.disabled = operationPending || waitingForInput || !assistants.length;
      input.placeholder = waitingForInput ? '请先回答上方问题' : (running ? '追加指令' : '输入消息');
      actionButton.disabled = operationPending || waitingForInput || !assistants.length || !String(input.value || '').trim();
      actionButton.className = 'action-button send';
      actionButton.title = running ? '追加指令' : '发送';
      actionButton.setAttribute('aria-label', actionButton.title);
      headerStopButton.disabled = operationPending || !running || !(topic && topic.topicId);
      headerStopButton.title = busy === 'stopping' ? '正在停止' : '停止运行';
      headerStopButton.setAttribute('aria-label', headerStopButton.title);
      updatePendingInputControls();
      renderRecordingControls();
      renderContextUsage();
      loadContextUsage(false);
      if (!assistants.length && !busy && notice.hidden) setNotice('请先在设置中创建助手', true);
    }

    function render() {
      syncRunPresentation(!!(topic && topic.active), !!pendingInputState());
      renderAssistants();
      renderMessages();
      renderPendingSteering();
      renderPendingUserInput();
      renderControls();
      resizeInput();
      syncPoll();
      refreshPanelPosition();
    }

    function stopPoll() {
      if (!pollTimer) return;
      win.clearInterval(pollTimer);
      pollTimer = 0;
    }

    function syncPoll() {
      if (destroyed || documentRef.hidden || !(topic && topic.active) || pollTimer) {
        if (documentRef.hidden || !(topic && topic.active)) stopPoll();
        return;
      }
      pollTimer = win.setInterval(function () {
        if (!refreshPromise) refreshState({ quiet: true });
      }, 180);
    }

    function pendingFromActive(active) {
      var interaction = active && active.pendingInteraction;
      if (!interaction || !interaction.interactionId) return null;
      var choices = Array.isArray(interaction.options) ? interaction.options.map(function (choice) {
        if (typeof choice === 'string') return { label: choice, description: '' };
        if (!choice || typeof choice !== 'object') return null;
        return { label: String(choice.label || choice.value || ''), description: String(choice.description || '') };
      }).filter(function (choice) { return choice && choice.label; }) : [];
      return {
        requestId: String(interaction.interactionId),
        kind: 'user_input',
        questions: [{
          id: 'answer',
          header: '问题',
          question: String(interaction.prompt || ''),
          options: choices,
        }],
      };
    }

    function resetConversationEventWindow(conversationId) {
      rawConversationEvents = [];
      rawConversationEventsTopicId = String(conversationId || '');
      conversationEventsInitialized = false;
      conversationEventsHasMoreBefore = false;
      conversationEventsTotal = 0;
      conversationEventsCursor = { beforeSequence: null, afterSequence: null };
      conversationEventsStreamBuffers = [];
    }

    function conversationEventWindowPage() {
      return {
        events: rawConversationEvents,
        streamBuffers: conversationEventsStreamBuffers,
        total: conversationEventsTotal,
        hasMoreBefore: conversationEventsHasMoreBefore,
        hasMoreAfter: false,
        cursors: conversationEventsCursor,
      };
    }

    function applyConversationEventPage(conversationId, page, direction) {
      conversationId = String(conversationId || '');
      page = page || {};
      if (rawConversationEventsTopicId !== conversationId || direction === 'initial') {
        resetConversationEventWindow(conversationId);
      }
      rawConversationEvents = listView.mergeJournalPages(rawConversationEvents, page.events || []);
      conversationEventsInitialized = true;
      if (direction === 'initial' || direction === 'older') {
        conversationEventsHasMoreBefore = !!page.hasMoreBefore;
      }
      conversationEventsTotal = Math.max(conversationEventsTotal, Number(page.total) || 0, rawConversationEvents.length);
      if (Array.isArray(page.streamBuffers)) conversationEventsStreamBuffers = page.streamBuffers.slice();
      conversationEventsCursor = {
        beforeSequence: rawConversationEvents.length ? Number(rawConversationEvents[0].sequence) || null : null,
        afterSequence: rawConversationEvents.length
          ? Number(rawConversationEvents[rawConversationEvents.length - 1].sequence) || null : null,
      };
      return conversationEventWindowPage();
    }

    function projectedTopic(metadata) {
      if (!metadata) return null;
      var active = metadata.activeGeneration || null;
      var terminal = active && ['completed', 'failed', 'cancelled', 'truncated', 'blocked'].indexOf(active.state) !== -1;
      var page = conversationEventWindowPage();
      var projectedPage = listView.projectPage(page || {});
      var assistant = assistantById(metadata.assistantId) || {};
      var inFlightTool = active && !terminal && active.inFlightTool && active.inFlightTool.method
        ? active.inFlightTool : null;
      var projectedEvents = (projectedPage.projectedEvents || []).slice();
      if (optimisticUserEvent
          && String(optimisticUserEvent.conversationId || '') === String(metadata.conversationId || '')) {
        var optimisticText = String(optimisticUserEvent.text || '').trim();
        var committed = projectedEvents.some(function (event) {
          return event && event.kind === 'user' && !event.__live
            && String(event.text || '').trim() === optimisticText
            && Number(event.sequence || 0) > Number(optimisticUserEvent.afterSequence || 0);
        });
        if (committed) optimisticUserEvent = null;
        else {
          var optimisticAfter = Number(optimisticUserEvent.afterSequence) || 0;
          var optimisticIndex = projectedEvents.findIndex(function (event) {
            return event && (event.__live || Number(event.sequence || 0) > optimisticAfter);
          });
          if (optimisticIndex < 0) projectedEvents.push(optimisticUserEvent);
          else projectedEvents.splice(optimisticIndex, 0, optimisticUserEvent);
        }
      }
      if (inFlightTool) {
        var toolCallId = String(inFlightTool.toolCallId || '');
        var operation = listView.describeOperation(inFlightTool.method, inFlightTool.canonicalUri)
          || listView.toolTitle(inFlightTool.method);
        var liveTool = {
          id: 'live-tool-execution:' + (toolCallId || String(inFlightTool.startedAt || Date.now())),
          eventId: '',
          eventKey: 'live-tool-execution:' + (toolCallId || String(inFlightTool.startedAt || Date.now())),
          sequence: Math.max(0, Number(metadata.lastSequence) || 0) + 1,
          conversationId: String(metadata.conversationId || ''),
          generationId: String(active.generationId || ''),
          modelRequestId: String(inFlightTool.modelRequestId || ''),
          toolCallId: toolCallId,
          at: Number(inFlightTool.startedAt) || Date.now(),
          canonicalType: 'tool_execution_started',
          kind: 'tool',
          title: operation,
          operation: operation,
          text: '正在执行：' + operation,
          status: 'running',
          __live: true,
        };
        var existingToolIndex = projectedEvents.findIndex(function (event) {
          return event && toolCallId && String(event.toolCallId || '') === toolCallId;
        });
        if (existingToolIndex >= 0) {
          projectedEvents[existingToolIndex] = Object.assign({}, projectedEvents[existingToolIndex], liveTool, {
            id: projectedEvents[existingToolIndex].id,
            eventKey: projectedEvents[existingToolIndex].eventKey,
            sequence: projectedEvents[existingToolIndex].sequence,
          });
        } else projectedEvents.push(liveTool);
      }
      return {
        topicId: String(metadata.conversationId || ''),
        conversationId: String(metadata.conversationId || ''),
        assistantId: String(metadata.assistantId || ''),
        assistantName: assistant.name || metadata.assistantId || '助手',
        label: assistant.name || '页面对话',
        status: active && active.state || 'idle',
        active: !!(active && !terminal),
        generationId: String(active && active.generationId || ''),
        inFlightTool: inFlightTool,
        pendingUserInput: pendingFromActive(active),
        pendingSteeringMessages: projectedPage.pendingSteeringMessages || [],
        events: projectedEvents,
        lastSequence: Math.max(0, Number(metadata.lastSequence) || 0),
        hasMoreBefore: conversationEventsHasMoreBefore,
        eventTotal: conversationEventsTotal,
        eventCursor: conversationEventsCursor,
      };
    }

    function loadOlderEvents() {
      if (destroyed || olderEventsPromise || !topic || !topic.hasMoreBefore
          || !topic.eventCursor || !topic.eventCursor.beforeSequence) return olderEventsPromise || Promise.resolve(null);
      var conversationId = topic.topicId;
      var beforeSequence = topic.eventCursor.beforeSequence;
      olderEventsPromise = sendCommand(contract.COMMANDS.GET_EVENTS, {
        conversationId: conversationId,
        cursor: { beforeSequence: beforeSequence },
        limit: listView.DEFAULT_PAGE_SIZE,
        includePayloads: true,
        view: 'conversation',
      }).then(function (response) {
        if (!response.ok || destroyed || !topic || topic.topicId !== conversationId) return response;
        applyConversationEventPage(conversationId, response.payload || {}, 'older');
        topic = projectedTopic(conversationMetadata);
        renderMessages({ preserveScroll: true });
        renderPendingSteering();
        return response;
      }).finally(function () {
        olderEventsPromise = null;
        setHistoryLoading(false);
      });
      setHistoryLoading(true);
      return olderEventsPromise;
    }

    function handleMessagesScroll() {
      if (!messages) return;
      if (messages.getAttribute('data-conversation-virtual-updating') === 'true') return;
      var currentTopicId = String(topic && topic.topicId || '');
      var currentTop = Math.max(0, Number(messages.scrollTop) || 0);
      if (messagesScrollTopicId !== currentTopicId) {
        messagesScrollTopicId = currentTopicId;
        lastMessagesScrollTop = currentTop;
        return;
      }
      var previousTop = lastMessagesScrollTop;
      lastMessagesScrollTop = currentTop;
      /* Virtual-list anchor restoration and tail following also emit scroll
         events. Only a real upward movement may request an older page. */
      if (previousTop !== null && currentTop < previousTop && currentTop <= OLDER_LOAD_THRESHOLD) loadOlderEvents().catch(function (error) {
        setNotice('加载更早消息失败: ' + (error && error.message || error), true);
      });
    }

    function handleMessagesWheel(event) {
      if (!messages || !event || Number(event.deltaY) >= 0) return;
      var currentTop = Math.max(0, Number(messages.scrollTop) || 0);
      if (currentTop > OLDER_LOAD_THRESHOLD || !topic || !topic.hasMoreBefore) return;
      loadOlderEvents().catch(function (error) {
        setNotice('加载更早消息失败: ' + (error && error.message || error), true);
      });
    }

    function applyState(payload) {
      payload = payload || {};
      if (payload.entryConfig) entryConfig = payload.entryConfig;
      assistants = Array.isArray(entryConfig && entryConfig.assistants) ? entryConfig.assistants : assistants;
      ensureSelectedAssistant();
      if (!newTopicDraft || payload.force) {
        conversationMetadata = payload.metadata || null;
        if (conversationMetadata) {
          var conversationId = String(conversationMetadata.conversationId || '');
          if (payload.page) applyConversationEventPage(conversationId, payload.page, payload.pageDirection || 'initial');
          else if (rawConversationEventsTopicId !== conversationId) resetConversationEventWindow(conversationId);
          topic = projectedTopic(conversationMetadata);
          updateContextUsage(conversationMetadata, payload.page && payload.page.events);
          if (payload.pageDirection === 'newer' && payload.page && payload.page.hasMoreAfter) {
            refreshQueued = true;
          }
        } else {
          resetConversationEventWindow('');
          topic = null;
        }
        if (topic && topic.assistantId) {
          selectedAssistantId = String(topic.assistantId);
          rememberConversationId(topic.assistantId, topic.topicId);
        }
      }
      ensureSelectedAssistant();
      render();
    }

    function refreshState(refreshOptions) {
      refreshOptions = refreshOptions || {};
      if (destroyed || newTopicDraft && !refreshOptions.force && entryConfig) return Promise.resolve(null);
      if (refreshPromise) {
        refreshQueued = true;
        return refreshPromise;
      }
      var revision = ++requestRevision;
      if (!refreshOptions.quiet) {
        busy = 'loading';
        renderControls();
      }
      // A running topic locks its assistant and service. Reusing that entry
      // snapshot removes one full configuration round trip from every page poll.
      var configRequest = refreshOptions.quiet && topic && topic.active && entryConfig
        ? Promise.resolve({ ok: true, payload: entryConfig })
        : send(contract.TYPES.GET_ENTRY_CONFIG, {});
      var operation = configRequest.then(function (configResponse) {
        if (!configResponse.ok && entryConfig) configResponse = { ok: true, payload: entryConfig };
        if (!configResponse.ok) return configResponse;
        entryConfig = configResponse.payload || entryConfig || {};
        assistants = Array.isArray(entryConfig.assistants) ? entryConfig.assistants : [];
        ensureSelectedAssistant();
        if (newTopicDraft && !refreshOptions.force) return { ok: true, payload: { entryConfig: entryConfig, force: false } };
        var activeConversationId = String(entryConfig.activeConversationId || '');
        var conversationId = String(topic && topic.topicId || activeConversationId
          || conversationIdFor(selectedAssistantId, false));
        return sendCommand(contract.COMMANDS.GET_CONVERSATION, { conversationId: conversationId }).then(function (metadataResponse) {
          if (!metadataResponse.ok && metadataResponse.code === 'CONVERSATION_NOT_FOUND') {
            return { ok: true, payload: { entryConfig: entryConfig, metadata: null, page: null, force: true } };
          }
          if (!metadataResponse.ok) return metadataResponse;
          var metadata = metadataResponse.payload || {};
          var cachedLastSequence = rawConversationEvents.length
            ? Number(rawConversationEvents[rawConversationEvents.length - 1].sequence) || 0 : 0;
          var initialPage = !conversationEventsInitialized
            || rawConversationEventsTopicId !== conversationId
            || Number(metadata.lastSequence || 0) < cachedLastSequence;
          var eventInput = {
            conversationId: conversationId,
            limit: listView.DEFAULT_PAGE_SIZE,
            includePayloads: true,
            view: 'conversation',
          };
          if (!initialPage) eventInput.cursor = { afterSequence: cachedLastSequence };
          return sendCommand(contract.COMMANDS.GET_EVENTS, eventInput).then(function (eventsResponse) {
            if (!eventsResponse.ok) return eventsResponse;
            return {
              ok: true,
              payload: {
                entryConfig: entryConfig,
                metadata: metadata,
                page: eventsResponse.payload,
                pageDirection: initialPage ? 'initial' : 'newer',
                force: true,
              },
            };
          });
        });
      }).then(function (response) {
        if (destroyed || revision !== requestRevision) return response;
        if (!response.ok) {
          if (!refreshOptions.quiet) setNotice(response.error || '加载对话失败', true);
          return response;
        }
        setNotice('', false);
        applyState(response.payload || {});
        return response;
      }).finally(function () {
        if (refreshPromise !== operation) return;
        refreshPromise = null;
        if (destroyed) return;
        if (busy === 'loading') busy = '';
        renderControls();
        if (refreshQueued) {
          refreshQueued = false;
          refreshState({ quiet: true });
        }
      });
      refreshPromise = operation;
      return operation;
    }

    function refreshAssistantCatalog() {
      return send(contract.TYPES.GET_ENTRY_CONFIG, {}).then(function (response) {
        if (!response.ok || destroyed) return response;
        entryConfig = response.payload || entryConfig || {};
        assistants = Array.isArray(entryConfig.assistants) ? entryConfig.assistants : [];
        ensureSelectedAssistant();
        render();
        return response;
      });
    }

    function optimisticTopic(message) {
      var assistant = assistantById(selectedAssistantId) || {};
      var previousEvents = topic && Array.isArray(topic.events) ? topic.events.slice() : [];
      var targetConversationId = topic && topic.topicId || conversationIdFor(selectedAssistantId, false);
      optimisticUserEvent = {
        id: 'pending-' + Date.now(),
        eventKey: 'pending-user-' + Date.now(),
        conversationId: targetConversationId,
        kind: 'user',
        title: '用户',
        text: message,
        status: '已发送',
        at: Date.now(),
        afterSequence: rawConversationEventsTopicId === targetConversationId
          ? Math.max(0, Number(conversationEventsCursor.afterSequence) || 0) : 0,
      };
      previousEvents.push(optimisticUserEvent);
      return {
        topicId: topic && topic.topicId || conversationIdFor(selectedAssistantId, false),
        generationId: topic && topic.generationId || '',
        assistantId: selectedAssistantId,
        assistantName: assistant.name || selectedAssistantId || '助手',
        label: topic && topic.label || message.slice(0, 36),
        status: 'running',
        active: true,
        events: previousEvents,
      };
    }

    function startTurn(message, recordingAttachmentInput) {
      var serviceId = selectedServiceId();
      if (!serviceId) {
        setNotice('当前助手未配置模型服务', true);
        return Promise.resolve({ ok: false, error: '当前助手未配置模型服务' });
      }
      var assistant = selectedAssistant();
      var settings = assistant.settings || {};
      var conversationId = String(topic && topic.topicId || conversationIdFor(selectedAssistantId, false));
      var commandId = nextId('page-start');
      return sendCommand(contract.COMMANDS.START_TURN, {
        schemaVersion: 1,
        commandId: commandId,
        conversationId: conversationId,
        assistantId: selectedAssistantId,
        serviceId: serviceId,
        message: { id: commandId + ':message', content: message, attachments: recordingAttachmentInput.attachments || [] },
        recordingSelectionClaim: recordingAttachmentInput.recordingSelectionClaim || undefined,
        entry: {
          type: 'page',
          currentResource: applicationEntry && appContext && appContext.appId ? '/apps/' + appContext.appId : '/page/current',
          origin: String(win.location && win.location.origin || ''),
        },
        budgets: {
          maxModelRequests: Math.max(1, Number(settings.maxModelRequests || settings.maxIterations) || 100),
          maxIterations: Math.max(1, Number(settings.maxIterations) || 100),
          maxToolCalls: Math.max(0, Number(settings.maxToolCalls) || 200),
          maxWallTimeMs: Math.max(0, Number(settings.maxWallTimeMs) || 0),
          maxContextTokens: Math.max(1024, Number(settings.maxContextTokens) || 1000000),
          maxOutputTokens: Math.max(1, Number(settings.maxTokens) || 4096),
        },
        preferences: {
          streamOutput: true,
          reasoningVisibility: settings.reasoningVisibility === 'collapsed' ? 'collapsed' : 'expanded',
          contextCompression: settings.contextCompression === 'off' ? 'off' : 'auto',
        },
        requestedAt: Date.now(),
      });
    }

    function steerTurn(conversationId, generationId, message, recordingAttachmentInput) {
      var commandId = nextId('page-steer');
      return sendCommand(contract.COMMANDS.STEER_GENERATION, {
        conversationId: conversationId,
        generationId: generationId,
        commandId: commandId,
        message: { id: commandId + ':message', content: message, attachments: recordingAttachmentInput.attachments || [] },
        recordingSelectionClaim: recordingAttachmentInput.recordingSelectionClaim || undefined,
      });
    }

    function claimRecordingSelection() {
      var collection = recordingCollection();
      if (!collection || !selectedRecordingRanges().length) return Promise.resolve({ ok: true, payload: { attachments: [], recordingSelectionClaim: null } });
      return sendRecording(contract.TYPES.CLAIM_RECORDING_SELECTION, {
        draftCollectionId: collection.draftCollectionId,
        expectedRevision: collection.revision,
      });
    }

    function submit() {
      if (destroyed || busy) return Promise.resolve(null);
      var message = String(input.value || '').trim();
      if (!selectedAssistantId) { setNotice('请选择助手', true); return Promise.resolve(null); }
      if (!message) { input.focus(); return Promise.resolve(null); }
      var previousTopic = topic;
      var previousNewTopicDraft = newTopicDraft;
      var steering = !!(topic && topic.active);
      if (steering) {
        var submittedDraft = input.value;
        var steeringConversationId = topic.topicId;
        var steeringGenerationId = topic.generationId;
        input.value = '';
        resizeInput();
        renderControls();
        var steeringQueue = steeringCommandQueue;
        var steeringOrder = steeringQueue.nextOrder++;
        steeringQueue.pendingCount += 1;
        var steeringOperation = steeringQueue.tail.catch(function () {}).then(function () {
          return claimRecordingSelection().then(function (claimResponse) {
            if (!claimResponse.ok) {
              var claimError = new Error(claimResponse.error || '录制范围读取失败');
              claimError.response = claimResponse;
              throw claimError;
            }
            return steerTurn(
              steeringConversationId,
              steeringGenerationId,
              message,
              claimResponse.payload || { attachments: [], recordingSelectionClaim: null }
            );
          }).then(function (response) {
            if (!response.ok) {
              var steeringError = new Error(response.error || '追加消息失败');
              steeringError.response = response;
              throw steeringError;
            }
            return response;
          });
        });
        steeringQueue.tail = steeringOperation;
        return steeringOperation.then(function (response) {
          if (destroyed) return response;
          setNotice('已加入待接收队列', false, 2000);
          refreshRecordingState().catch(function () {});
          resizeInput();
          renderControls();
          return response;
        }).catch(function (error) {
          steeringQueue.failedDrafts.push({ order: steeringOrder, draft: submittedDraft });
          if (!destroyed) {
            setNotice(error && error.message || String(error), true);
            resizeInput();
            renderControls();
          }
          return error && error.response || null;
        }).finally(function () {
          steeringQueue.pendingCount -= 1;
          if (destroyed) return;
          if (steeringQueue.pendingCount === 0) {
            var failedDraft = steeringQueue.failedDrafts.sort(function (left, right) {
              return left.order - right.order;
            }).map(function (item) { return item.draft; }).join('\n\n');
            if (failedDraft) {
              input.value = [failedDraft, input.value].filter(function (value) {
                return !!String(value || '').trim();
              }).join('\n\n');
              setNotice(steeringQueue.failedDrafts.length + ' 条追加消息失败，已恢复到输入框', true);
            }
            if (steeringCommandQueue === steeringQueue) {
              steeringCommandQueue = {
                tail: Promise.resolve(),
                pendingCount: 0,
                nextOrder: 0,
                failedDrafts: [],
              };
            }
          }
          resizeInput();
          renderControls();
          win.setTimeout(function () { refreshState({ quiet: true, force: true }); }, 0);
        });
      }
      busy = 'sending';
      topic = optimisticTopic(message);
      newTopicDraft = false;
      setNotice('', false);
      render();
      return claimRecordingSelection().then(function (claimResponse) {
        if (!claimResponse.ok) return claimResponse;
        var recordingAttachmentInput = claimResponse.payload || { attachments: [], recordingSelectionClaim: null };
        return startTurn(message, recordingAttachmentInput);
      }).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) {
          optimisticUserEvent = null;
          topic = previousTopic;
          newTopicDraft = previousNewTopicDraft;
          setNotice(response.error || '发送失败', true);
          return response;
        }
        var result = response.payload || {};
        topic.topicId = String(previousTopic && previousTopic.topicId || topic.topicId || conversationIdFor(selectedAssistantId, false));
        topic.generationId = String(result.generationId || topic.generationId || '');
        input.value = '';
        resizeInput();
        refreshRecordingState().catch(function () {});
        return response;
      }).finally(function () {
        if (destroyed) return;
        busy = '';
        render();
        if (topic && topic.topicId) {
          win.setTimeout(function () { refreshState({ quiet: true, force: true }); }, 80);
        }
      });
    }

    function stop() {
      if (destroyed || busy || !topic || !topic.topicId || !topic.active) return Promise.resolve(null);
      busy = 'stopping';
      renderControls();
      return sendCommand(contract.COMMANDS.CANCEL_GENERATION, {
        conversationId: topic.topicId,
        generationId: topic.generationId,
        reason: 'page_user_cancelled',
      }).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) setNotice(response.error || '停止失败', true);
        return response;
      }).finally(function () {
        if (destroyed) return;
        busy = '';
        renderControls();
        win.setTimeout(function () { refreshState({ quiet: true, force: true }); }, 80);
      });
    }

    function interruptCurrentModelRequest() {
      if (destroyed || busy || !topic || !topic.topicId || !topic.active) return Promise.resolve(null);
      if (!Array.isArray(topic.pendingSteeringMessages) || !topic.pendingSteeringMessages.length) {
        setNotice('没有待接收消息', true);
        return Promise.resolve(null);
      }
      busy = 'interrupting';
      render();
      return sendCommand(contract.COMMANDS.INTERRUPT_MODEL_REQUEST, {
        conversationId: topic.topicId,
        generationId: topic.generationId,
        commandId: nextId('page-interrupt'),
      }).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) setNotice(response.error || '立即处理失败', true);
        else setNotice('正在使用最新消息继续', false, 2000);
        return response;
      }).finally(function () {
        if (destroyed) return;
        busy = '';
        render();
        win.setTimeout(function () { refreshState({ quiet: true, force: true }); }, 0);
      });
    }

    function submitPendingUserInput() {
      var pending = pendingInputState();
      if (destroyed || busy || !topic || !topic.active || !pending) return Promise.resolve(null);
      var answerState = pendingAnswerState();
      if (answerState.missing) {
        setNotice('请完整回答所有问题', true);
        var missingInput = answerState.missing.querySelector('.pending-other-input');
        if (missingInput) missingInput.focus();
        return Promise.resolve(null);
      }
      busy = 'answering';
      setNotice('', false);
      renderControls();
      var answer = { answers: answerState.answers };
      return sendCommand(contract.COMMANDS.RESOLVE_INTERACTION, {
        conversationId: topic.topicId,
        generationId: topic.generationId,
        interactionId: pending.requestId,
        answer: answer,
      }).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) setNotice(response.error || '提交回答失败', true);
        else setNotice('回答已提交', false, 2500);
        return response;
      }).finally(function () {
        if (destroyed) return;
        busy = '';
        renderControls();
        win.setTimeout(function () { refreshState({ quiet: true, force: true }); }, 80);
      });
    }

    function startNewTopic() {
      if (destroyed || busy || topic && topic.active) return;
      optimisticUserEvent = null;
      topic = null;
      conversationIdFor(selectedAssistantId, true);
      newTopicDraft = true;
      ++requestRevision;
      setNotice('', false);
      setExpanded(true, true);
      render();
    }

    function handleAssistantChange() {
      if (destroyed || busy || topic && topic.active) return;
      optimisticUserEvent = null;
      selectedAssistantId = String(assistantSelect.value || '');
      rememberAssistantId(selectedAssistantId);
      topic = null;
      newTopicDraft = false;
      ++requestRevision;
      setNotice('', false);
      render();
      refreshState({ quiet: true, force: true }).finally(function () {
        if (!destroyed) {
          refreshRecordingState().catch(function () {});
          input.focus();
        }
      });
    }

    function openOptionsConversation() {
      if (!selectedAssistantId) return Promise.resolve(null);
      return send(contract.TYPES.OPEN_OPTIONS_CONVERSATION, {
        assistantId: selectedAssistantId,
        topicId: topic && topic.topicId || '',
      }).then(function (response) {
        if (!response.ok) setNotice(response.error || '打开对话页面失败', true);
        return response;
      });
    }

    function handleAction() {
      submit();
    }

    function handleInputKeydown(event) {
      if (event.isComposing) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    }

    function downloadEventMarkdown(event) {
      var meta = {
        topicTitle: topic && topic.label || '',
        assistantName: topic && topic.assistantName || '',
      };
      var result = conversationShared.downloadEventMarkdown(event, meta);
      setNotice(result.message, !result.ok, result.ok ? 3000 : undefined);
      return result;
    }

    function retryEvent(event) {
      if (!conversationShared.canRetryEvent(event)) {
        setNotice('这条消息不能重试', true);
        return Promise.resolve(null);
      }
      if (!topic || !topic.topicId) {
        setNotice('当前没有话题', true);
        return Promise.resolve(null);
      }
      if (topic.active) {
        setNotice('当前话题正在运行', true);
        return Promise.resolve(null);
      }
      var message = String(event.detail && event.detail.retryMessage || '').trim();
      if (!message) {
        setNotice('没有可重试的用户消息', true);
        return Promise.resolve(null);
      }
      busy = 'sending';
      setNotice('', false);
      renderControls();
      return startTurn(message, { attachments: [], recordingSelectionClaim: null }).then(function (response) {
        if (destroyed) return response;
        if (!response.ok) setNotice(response.error || '重试失败', true);
        else if (topic) {
          topic.active = true;
          topic.status = 'running';
          topic.generationId = String(response.payload && response.payload.generationId || '');
        }
        return response;
      }).finally(function () {
        if (destroyed) return;
        busy = '';
        render();
        win.setTimeout(function () { refreshState({ quiet: true, force: true }); }, 80);
      });
    }

    function handleMessageAction(event) {
      var interactive = event.target && event.target.closest && event.target.closest('button');
      var summary = !interactive && event.target && event.target.closest && event.target.closest('summary');
      var disclosure = summary && summary.parentElement;
      if (disclosure && disclosure.classList.contains('conversation-event-reasoning')) {
        var reasoningEvent = conversationShared.findEventByTarget(
          displayEvents(), disclosure.getAttribute('data-conversation-event-key'));
        var reasoningStatus = String(reasoningEvent && (reasoningEvent.status
          || reasoningEvent.detail && reasoningEvent.detail.status) || '').toLowerCase();
        if (reasoningStatus === 'thinking') {
          win.requestAnimationFrame(function () {
            if (destroyed || !messages || !disclosure.open || !messages.contains(disclosure)) return;
            if (virtualList) virtualList.scrollToEnd();
            else messages.scrollTop = messages.scrollHeight;
          });
        }
      }
      var button = event.target && event.target.closest && event.target.closest('[data-conversation-action]');
      if (!button || !messages || !messages.contains(button)) return;
      var action = String(button.getAttribute('data-conversation-action') || '');
      if (action !== 'copy-event' && action !== 'download-event-md' && action !== 'retry-event') return;
      var messageEvent = conversationShared.findEventByTarget(displayEvents(), button.getAttribute('data-event-id'));
      if (action === 'retry-event') {
        if (!messageEvent) {
          setNotice('这条消息不能重试', true);
          return;
        }
        retryEvent(messageEvent);
        return;
      }
      if (action === 'download-event-md') {
        downloadEventMarkdown(messageEvent);
        return;
      }
      conversationShared.copyEvent(messageEvent).then(function (result) {
        setNotice(result.message, !result.ok, result.ok ? 2000 : undefined);
      });
    }

    function handlePendingSteeringAction(event) {
      var button = event.target && event.target.closest
        && event.target.closest('[data-conversation-action="interrupt-model-request"]');
      if (!button || !pendingSteeringHost || !pendingSteeringHost.contains(button)) return;
      interruptCurrentModelRequest();
    }

    function handleRuntimeMessage(message) {
      if (destroyed || !message) return;
      if (message.type === 'APP_CHANGED') { if (!documentRef.hidden) refreshApplicationContext(true); return; }
      if (message.type === contract.TYPES.RECORDING_STATE_CHANGED) {
        if (!recordingState) recordingState = {};
        recordingState.active = message.payload && message.payload.active || null;
        if (recordingState.active && recordingState.active.warning && recordingWarningNotifiedId !== recordingState.active.recordingId) {
          recordingWarningNotifiedId = recordingState.active.recordingId;
          setNotice('录制事件数量已达到上限的 80%，达到硬限制后会统一停止并标记为 truncated。', false, 6000);
        }
        if (!recordingState.active) recordingWarningNotifiedId = '';
        renderRecordingControls();
        if (!recordingState.active) {
          refreshPanelPosition();
          refreshRecordingState().catch(function () {});
        }
        return;
      }
      if (message.type === contract.TYPES.RECORDING_LIBRARY_CHANGED) {
        refreshRecordingState().catch(function () {});
        return;
      }
      if (newTopicDraft) return;
      if (documentRef.hidden) return;
      if (message.type !== contract.TYPES.REFRESH) return;
      var incomingTopicId = String(message.topicId || message.payload && message.payload.topicId || '');
      if (topic && topic.topicId && incomingTopicId && incomingTopicId !== topic.topicId) return;
      refreshState({ quiet: true });
    }

    function handleSyncEvent(event) {
      if (destroyed || !event) return;
      var resource = String(event.resource || '');
      var id = String(event.id || '');
      if (resource === 'assistant') {
        refreshAssistantCatalog();
        return;
      }
      if (!newTopicDraft && resource === 'conversationTopic' && (!id || topic && String(topic.topicId || '') === id)) {
        refreshState({ quiet: true, force: true });
      }
    }

    function handleVisibility() {
      renderControls();
      syncMessageElapsedTimer();
      if (documentRef.hidden) stopPoll();
      else {
        refreshApplicationContext(true);
        if (!newTopicDraft) refreshState({ quiet: true });
        syncPoll();
      }
    }

    function createHost() {
      host = documentRef.createElement('div');
      host.id = 'page-agent-page-conversation';
      host.setAttribute('data-page-agent-ui', 'page-conversation');
      host.style.position = 'fixed';
      host.style.left = '50%';
      host.style.bottom = positionControllerApi.EDGE_GAP + 'px';
      host.style.width = 'min(468px, calc(100% - ' + (positionControllerApi.EDGE_GAP * 2) + 'px))';
      host.style.transform = 'translateX(-50%)';
      host.style.zIndex = '2147483646';
      host.style.pointerEvents = 'none';
      host.style.visibility = 'hidden';

      var shadow = host.attachShadow({ mode: 'closed' });
      cleanups.push(globalThis.PageAgentCodeEditor.attach(shadow));
      if (globalThis.PageAgentConversationEventView.attachApplications) cleanups.push(globalThis.PageAgentConversationEventView.attachApplications(shadow));
      // 键盘事件穿过 Shadow DOM 后会以 host 为目标，需阻止冒泡以免触发页面快捷键。
      ['keydown', 'keypress', 'keyup'].forEach(function (type) {
        listen(shadow, type, function (event) { event.stopPropagation(); });
      });
      var style = documentRef.createElement('style');
      style.textContent = [
        ':host{all:initial;color-scheme:light;--bg:#ffffff;--bg-secondary:#f9fafb;--bg-muted:#eaeef0;--text:#262626;--text-secondary:#728e9b;--value:#775351;--border:#d0dbe0;--border-strong:#aabbc3;--border-link:#ccdadb;--table-header:#728e9b;--accent:#004849;--accent-soft:rgba(0,72,73,.08);--danger:#ba554a;--success:#3da67a;--transmitting:#44a3cf;--warn:#cf9f5d;--control-radius:4px;--control-bg:rgba(249,250,251,.72);--control-bg-hover:#e3e8eb;--control-border:var(--border-link);--disabled:#a8a8a8;}',
        '*,*::before,*::after{box-sizing:border-box;letter-spacing:0;}',
        'button,select,textarea,input{font:inherit;letter-spacing:0;}',
        '.panel{position:relative;display:flex;flex-direction:column;width:100%;max-height:calc(100vh - 96px);margin:0 auto;overflow:hidden;border:1px solid rgba(193,207,214,.88);border-radius:var(--control-radius);background:rgba(255,255,255,.91);color:#10282b;box-shadow:0 16px 36px rgba(10,33,36,.15),0 2px 8px rgba(0,0,0,.10);font:13px/1.45 Inter,Roboto,Arial,sans-serif;pointer-events:auto;backdrop-filter:saturate(1.15) blur(14px);-webkit-backdrop-filter:saturate(1.15) blur(14px);transition:width .28s cubic-bezier(.22,1,.36,1),height .28s cubic-bezier(.22,1,.36,1),border-radius .24s ease,box-shadow .24s ease;animation:panel-enter .22s ease both;will-change:width,height;}.panel.positioning{transition:none!important;animation:none!important;}.panel.running{background:#fff;backdrop-filter:none;-webkit-backdrop-filter:none;will-change:auto;}',
        '.panel.expanded{height:min(420px,calc(100vh - 96px));min-height:min(300px,calc(100vh - 96px));}',
        '.panel:not(.expanded){height:auto;}',
        '.panel.running:not(.expanded){height:auto;max-height:calc(100vh - 96px);}',
        '.panel:not(.expanded) .messages,.panel:not(.expanded) .pending-input,.panel:not(.expanded) .notice{display:none;}',
        '.panel.has-events:not(.expanded) .messages{display:block;flex:0 1 auto;min-height:0;max-height:none;overflow-y:auto;padding:8px 8px 0;background:rgba(255,255,255,.78);pointer-events:auto;overscroll-behavior:contain;}',
        '.panel.has-events:not(.expanded) .messages>[data-conversation-virtual-spacer]{display:none;}',
        '.panel.has-events:not(.expanded) .conversation-event{display:none;}',
        '.panel.has-events:not(.expanded) [data-conversation-virtual-rows]>.conversation-event:last-child{display:block;max-height:none;overflow:visible;}',
        '.panel:not(.expanded) .notice:not([hidden]){display:block;}',
        '.panel-header{display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:4px 8px;border-bottom:1px solid rgba(220,228,231,.9);background:rgba(248,250,249,.82);cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;}.panel.dragging .panel-header{cursor:grabbing;}',
        '.heading{display:flex;align-items:center;min-width:0;gap:8px;}',
        '.brand-icon{width:18px;height:18px;flex:0 0 auto;border-radius:50%;}',
        '.heading-copy{display:flex;flex-direction:column;min-width:0;}',
        '.panel-title{font:600 13px/1.25 Inter,Roboto,Arial,sans-serif;color:#10282b;}',
        '.topic-label{max-width:240px;color:#72838a;font:11px/1.25 Inter,Roboto,Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.header-actions{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:4px;}',
        '.panel-header .icon-button svg{width:14px;height:14px}.panel:not(.expanded) .header-actions{gap:2px}',
        '.runtime-status{display:flex;align-items:center;gap:4px;min-width:0;height:24px;margin-right:4px;color:#61757c;font:11px/1.2 Inter,Roboto,Arial,sans-serif;white-space:nowrap;}',
        '.status-text{display:block;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;}',
        '.panel.running:not(.expanded) .runtime-status{flex:1;margin-right:4px;color:#36565b;font-size:12px;font-weight:500;}',
        '.status-dot{display:inline-flex;width:14px;height:14px;flex:0 0 auto;color:#637980}.status-dot svg{width:14px;height:14px}.status-dot.running{color:var(--accent)}.status-dot.waiting,.status-dot.stopped{color:#946323}.status-dot.failed{color:var(--danger)}',
        '.spinning{animation:icon-spin 1s linear infinite}@keyframes icon-spin{to{transform:rotate(360deg)}}',
        '.messages{flex:1;min-height:0;overflow-y:auto;padding:8px;scrollbar-color:#c5d0d4 transparent;scrollbar-width:thin;background:rgba(255,255,255,.78);}',
        '.placeholder{display:flex;align-items:center;justify-content:center;min-height:100%;color:var(--text-secondary);font:12px/1.4 Roboto,Arial,sans-serif;}',
        '.pending-input{flex:0 0 auto;max-height:min(46vh,310px);overflow:auto;padding:8px;border-top:1px solid #dce4e7;background:#f8faf9;}',
        '.pending-input[hidden]{display:none;}.pending-input-heading{margin:0 0 8px;color:#0f5555;font:600 12px/1.35 Inter,Roboto,Arial,sans-serif;}',
        '.pending-question{min-width:0;margin:0 0 8px;padding:0;border:0;}.pending-question legend{display:grid;width:100%;gap:2px;margin:0 0 6px;padding:0;color:#173336;}',
        '.pending-question legend span{color:#6d8388;font:600 10px/1.3 Inter,Roboto,Arial,sans-serif;}.pending-question legend b{font:500 12px/1.45 Inter,Roboto,Arial,sans-serif;}',
        '.pending-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:6px;}',
        '.pending-option{display:flex;min-width:0;min-height:48px;align-items:flex-start;gap:7px;padding:7px 8px;border:1px solid #cbd7db;border-radius:6px;background:#fff;cursor:pointer;}',
        '.pending-option:has(input[type="radio"]:checked){border-color:#478381;background:#edf6f4;}.pending-option>input[type="radio"]{flex:0 0 auto;margin:3px 0 0;accent-color:var(--accent);}',
        '.pending-option>span{display:grid;min-width:0;flex:1;gap:2px;}.pending-option b{color:#173336;font:500 11.5px/1.35 Inter,Roboto,Arial,sans-serif;}.pending-option small{color:#71858b;font:10.5px/1.4 Inter,Roboto,Arial,sans-serif;}',
        '.pending-other-input{display:block;width:100%;min-width:0;height:28px;margin-top:2px;padding:4px 6px;border:1px solid #cbd7db;border-radius:5px;background:#fff;color:#10282b;outline:none;}',
        '.pending-input-actions{display:flex;justify-content:flex-start;margin-top:2px;}.pending-submit{height:28px;padding:0 8px;border:1px solid #006d6b;border-radius:5px;background:#006d6b;color:#fff;cursor:pointer;font:500 11.5px/1 Inter,Roboto,Arial,sans-serif;}.pending-submit:hover,.pending-submit:focus-visible{background:#075856;border-color:#075856;outline:none;}.pending-submit:disabled{cursor:default;opacity:.45;}',
        '.composer{flex:0 0 auto;padding:7px 8px 8px;border-top:1px solid rgba(220,228,231,.9);background:rgba(248,250,249,.82);}',
        '.panel:not(.expanded) .composer{padding:7px 8px 8px;}',
        '.composer-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-height:26px;margin-bottom:5px}.composer-toolbar .assistant-select{flex:1 1 100px}',
        '.context-meter{--context-color:#16a085;display:grid;grid-template-rows:12px 3px;align-content:center;gap:3px;flex:0 0 100px;width:100px;height:26px;padding:0 6px;border:1px solid color-mix(in srgb,var(--context-color) 22%,var(--control-border));border-radius:6px;background:color-mix(in srgb,var(--context-color) 4%,var(--bg));color:var(--text-secondary);font:10px/12px Inter,Roboto,Arial,sans-serif;cursor:pointer}',
        '.context-meter:hover:not(:disabled){background:color-mix(in srgb,var(--context-color) 9%,var(--bg));border-color:color-mix(in srgb,var(--context-color) 55%,var(--control-border))}.context-meter:disabled{cursor:default;opacity:.65}.context-meter-caption{white-space:nowrap}.context-meter-value{color:color-mix(in srgb,var(--context-color) 65%,var(--text));font-variant-numeric:tabular-nums}.context-meter-track{position:relative;display:block;width:100%;height:3px;border-radius:2px;background:color-mix(in srgb,var(--context-color) 12%,var(--bg-muted))}.context-meter-fill{display:block;width:var(--context-usage,0%);height:100%;border-radius:inherit;background:var(--context-color)}',
        '.context-meter-threshold{position:absolute;top:-1px;left:var(--context-threshold);width:1px;height:5px;background:var(--text-secondary);opacity:.75}.context-meter.is-moderate{--context-color:#4a8ed8}.context-meter.is-warning{--context-color:var(--warn)}.context-meter.is-high{--context-color:var(--danger)}.context-meter.is-unknown{--context-color:var(--text-secondary)}.context-meter.is-unknown .context-meter-fill{width:100%;background:repeating-linear-gradient(135deg,transparent 0 4px,var(--border) 4px 6px)}',
        '.context-compact-button{flex:0 0 auto;height:24px;padding:0 5px;border:1px solid color-mix(in srgb,var(--danger) 30%,var(--border));border-radius:4px;background:color-mix(in srgb,var(--danger) 5%,var(--bg));color:var(--danger);font:10px/1 Inter,Roboto,Arial,sans-serif;cursor:pointer}.context-compact-button:hover{background:color-mix(in srgb,var(--danger) 10%,var(--bg))}.context-compact-button[hidden],.context-popover[hidden],.context-meter-threshold[hidden]{display:none}',
        '.status-dot.summarizing,.runtime-status:has(.summarizing){color:#8a72b7}.summary-breathe{animation:page-context-breathe 2s ease-in-out infinite}@keyframes page-context-breathe{0%,100%{opacity:.35}50%{opacity:1}}',
        '.context-popover{position:relative;z-index:8;display:flex;flex:1;min-height:0;flex-direction:column;background:var(--bg);color:var(--text);font:12px/1.5 Inter,Roboto,Arial,sans-serif}.context-popover-header{display:flex;align-items:center;gap:6px;flex-shrink:0;min-height:34px;padding:4px 8px;border-bottom:1px solid var(--border)}.context-popover-header h2{min-width:0;flex:1;margin:0;font-size:13px;font-weight:600}.context-popover-body{min-height:0;flex:1;padding:8px}.context-detail-row{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px;align-items:start;padding:4px 0;border-bottom:1px solid rgba(208,219,224,.55);font-size:12px}.context-detail-row:last-child{border-bottom:0}.context-detail-row b{color:var(--accent);font-weight:500}.context-detail-row span{min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
        '.panel:not(.expanded) .composer-toolbar{display:none;}',
        '.assistant-select{min-width:0;max-width:250px;height:26px;padding:0 24px 0 6px;border:1px solid var(--control-border);border-radius:var(--control-radius);background:var(--control-bg);color:#274248;font:12px/1 Inter,Roboto,Arial,sans-serif;outline:none;text-overflow:ellipsis;}',
        '.toolbar-spacer{flex:1;min-width:4px;}',
        '.record-button{all:unset;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;padding:0 7px;flex:0 0 auto;border:1px solid var(--control-border);border-radius:var(--control-radius);background:var(--control-bg);color:#536d73;font:400 12px/1 Inter,Roboto,Arial,sans-serif;cursor:pointer}.record-button:hover:not(:disabled){border-color:#a6463f;background:#fff7f6;color:#a6463f}.record-button:disabled{cursor:default;opacity:.5}.record-button.recording{color:#a6463f;border-color:#d9b3ae;background:#fff7f6;font-variant-numeric:tabular-nums}',
        '.recording-summary{display:flex;align-items:center;gap:6px;min-height:26px;margin:0 1px 5px;padding:0 6px;border:1px solid var(--border);border-radius:var(--control-radius);background:var(--control-bg);color:#536d73;font:11px/1.4 Inter,Roboto,Arial,sans-serif}.recording-summary[hidden]{display:none}.recording-summary-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recording-summary button{all:unset;display:inline-flex;align-items:center;height:24px;padding:0 4px;flex:0 0 auto;color:var(--accent);border-radius:var(--control-radius);cursor:pointer}.recording-summary button:hover{background:var(--accent-soft)}',
        '.icon-button,.action-button,.header-stop-button{all:unset;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;cursor:pointer;color:#536d73;}',
        '.icon-button{width:24px;height:24px;flex:0 0 auto;border-radius:var(--control-radius);transition:background .16s ease,color .16s ease;}.icon-button:hover:not(:disabled){background:#e8eeee;color:#004849;}',
        '.icon-button:active,.action-button:active{transform:scale(.92);}',
        '.icon-button svg{width:16px;height:16px;}',
        '.header-stop-button{display:none;width:24px;height:24px;flex:0 0 auto;border:0;border-radius:var(--control-radius);background:transparent;color:#a3423a;}',
        '.panel.running .header-stop-button{display:inline-flex;animation:control-enter .18s cubic-bezier(.22,1,.36,1) both;}.header-stop-button:hover:not(:disabled){background:#fceeed}.header-stop-button:active:not(:disabled){background:#f8dfdc}',
        '.header-stop-button svg{width:16px;height:16px;flex-shrink:0;}',
        '.icon-button:disabled,.action-button:disabled,.header-stop-button:disabled{cursor:default;opacity:.42;}',
        '.composer-row{display:flex;align-items:flex-end;gap:7px;}',
        '.message-input{display:block;min-width:0;flex:1;height:30px;min-height:30px;max-height:112px;padding:5px 7px;border:1px solid rgba(203,215,219,.94);border-radius:var(--control-radius);background:rgba(255,255,255,.9);color:#10282b;font:12.5px/1.45 Inter,Roboto,Arial,sans-serif;outline:none;resize:none;overflow:auto;}',
        'input:focus,select:focus,textarea:focus{outline:1px solid var(--accent);outline-offset:-1px;box-shadow:none;}',
        '.message-input::placeholder{color:#93a1a6;}.message-input:disabled{background:#f1f4f4;color:#829298;}',
        '.action-button{width:30px;height:28px;flex:0 0 auto;border:1px solid #004849;border-radius:var(--control-radius);background:#004849;color:#fff;transition:transform .16s ease,background .16s ease,border-color .16s ease,color .16s ease;}',
        '.action-button:hover,.action-button:focus-visible{outline:none;background:#103f44;border-color:#103f44;}',
        '.action-button svg{width:16px;height:16px;}',
        '.notice{margin:0 2px 6px;color:#60757b;font:11px/1.35 Inter,Roboto,Arial,sans-serif;overflow-wrap:anywhere;}.notice[hidden]{display:none;}.notice.error{color:#a3423a;}',
        '.recording-drawer{position:relative;z-index:8;display:flex;flex:1;min-height:0;flex-direction:column;background:var(--bg);color:var(--text)}.recording-drawer[hidden]{display:none}.recording-drawer-header{display:flex;align-items:center;gap:6px;flex-shrink:0;min-height:34px;padding:4px 8px;border-bottom:1px solid var(--border)}.recording-drawer-header h2{min-width:0;flex:1;margin:0;font-size:13px;font-weight:600}.recording-drawer-body{min-height:0;flex:1;overflow:auto;padding:8px;overscroll-behavior:contain;scrollbar-width:thin}.recording-section h3{margin:0;font-size:12px;font-weight:500}.recording-empty,.recording-help{margin:0 0 6px;color:#536d73;font-size:11px;line-height:1.4}.recording-empty{padding:8px 6px;text-align:center}.recording-error-hint{margin:0 0 6px;padding:6px;border-left:3px solid #c28a42;background:#fff9ee;color:#735526;font-size:12px;overflow-wrap:anywhere}.recording-error-hint p{margin:0 0 6px}.recording-drawer-notice{padding:6px 8px;background:#eef6f4;color:var(--accent);font-size:12px;overflow-wrap:anywhere}.recording-drawer-notice.error{background:#fff4f2;color:#a3423a}',
        '.recording-source-list{display:grid;gap:6px}.recording-source-list>.recording-help{margin:0}.recording-source-row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px 8px;border:1px solid var(--border);border-radius:var(--control-radius);background:#fff}.recording-source-row.checked{border-color:#80aaa4;background:#f2f8f6}.recording-source-check{width:14px;height:14px;margin:0;accent-color:var(--accent);cursor:pointer}.recording-source-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.recording-source-copy>span{color:#536d73;font-size:11px}.recording-source-heading{display:flex;min-width:0;align-items:baseline;gap:6px}.recording-source-heading strong{flex-shrink:0;font-size:12px;font-weight:500}.recording-source-heading time{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#536d73;font-size:11px}.recording-row-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}',
        '.primary-command,.secondary-command{display:inline-flex;box-sizing:border-box;min-width:0;height:24px;align-items:center;justify-content:center;gap:4px;padding:0 7px;border:1px solid var(--control-border);border-radius:var(--control-radius);background:var(--control-bg);color:var(--accent);cursor:pointer;white-space:nowrap;font:400 12px/1 Inter,Roboto,Arial,sans-serif}.primary-command:hover:not(:disabled),.secondary-command:hover:not(:disabled){background:var(--control-bg-hover);border-color:var(--accent)}.secondary-command[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}.danger-command{color:var(--danger);border-color:rgba(186,85,74,.45)}.danger-command:hover:not(:disabled){background:rgba(186,85,74,.08);border-color:var(--danger);color:var(--danger)}.primary-command:disabled,.secondary-command:disabled{cursor:default;opacity:1;background:var(--bg-muted);border-color:var(--border);color:var(--disabled)}',
        '.recording-filters{display:grid;gap:6px;margin-bottom:6px}.recording-categories{display:flex;min-width:0;gap:0;overflow-x:auto;scrollbar-width:thin}.recording-categories>button{flex:0 0 auto;padding:0 6px;border-radius:0;color:#536d73}.recording-categories>button+button{margin-left:-1px}.recording-categories>button:first-child{border-radius:var(--control-radius) 0 0 var(--control-radius)}.recording-categories>button:last-child{border-radius:0 var(--control-radius) var(--control-radius) 0}.recording-categories>button[aria-pressed="true"]{position:relative;z-index:1}.recording-search{display:flex;gap:4px}.recording-search input{min-width:0;flex:1;height:24px;padding:0 6px;border:1px solid var(--control-border);border-radius:var(--control-radius);font-size:12px;color:var(--text);background:#fff}.recording-selection-bar{position:sticky;top:-8px;z-index:2;display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border);background:var(--bg)}.recording-selection-bar>strong{margin-right:auto;font-size:11px;font-weight:400;white-space:nowrap}',
        '.recording-action-card{display:grid;grid-template-columns:14px 22px minmax(0,1fr);align-items:start;gap:3px 6px;margin-bottom:5px;padding:6px;border:1px solid var(--border);border-radius:var(--control-radius);background:#fff}.recording-action-card:hover{border-color:#8da7ad}.recording-action-card.selected{border-color:#80aaa4;background:#f2f8f6}.recording-action-card>input{width:14px;height:14px;margin:2px 0 0;accent-color:var(--accent);cursor:pointer}.recording-action-order{display:inline-flex;min-width:22px;min-height:18px;align-items:center;justify-content:center;color:#536d73;font:11px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.recording-action-copy{min-width:0;cursor:pointer}.recording-action-heading{display:block}.recording-action-heading strong{font-size:12px;font-weight:400;line-height:1.4;overflow-wrap:anywhere}.recording-action-meta{display:block;margin-top:2px;color:#536d73;font-size:11px}.recording-action-details{grid-column:3/4;min-width:0;color:#536d73;font-size:12px}.recording-action-details>summary{width:fit-content;color:var(--accent)}.recording-event-detail{display:grid;grid-template-columns:64px minmax(0,1fr);gap:6px;padding:4px 0;border-top:1px solid #e2e9eb}.recording-event-detail>div{min-width:0;color:#29464b;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}.recording-event-detail.raw-value>div{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
        '.recording-consent-overlay{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;padding:8px;background:rgba(20,40,43,.34)}.recording-consent{display:flex;flex-direction:column;width:100%;min-width:0;max-height:100%;overflow:hidden;padding:8px;border:1px solid var(--border);border-radius:6px;background:#fff;box-shadow:0 8px 24px rgba(10,33,36,.18)}.recording-consent-header{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-shrink:0}.recording-consent h2{flex:1;margin:0;font-size:13px;font-weight:600}.recording-consent p{margin:0;color:#4f6268;font-size:12px;line-height:1.5;white-space:pre-wrap}.recording-consent-body{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:0}.recording-consent-actions{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:5px 6px;flex-shrink:0;padding-top:6px;margin-top:6px;border-top:1px solid var(--border)}.recording-consent-actions>.primary-command,.recording-consent-actions>.secondary-command{height:26px;padding:0 8px}',
        '.recording-network-choices{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;margin:6px 0}.recording-network-choices label{display:inline-flex;align-items:center;gap:5px;min-height:24px;font-size:12px;white-space:nowrap;cursor:pointer}.recording-network-choices input,.recording-privacy-agreement input{flex-shrink:0;width:14px;height:14px;margin:0;accent-color:var(--accent)}',
        '.recording-privacy-agreement{display:flex;align-items:center;gap:4px 6px;flex-wrap:wrap;flex-basis:100%;font-size:12px}.recording-privacy-agreement label{display:inline-flex;align-items:center;gap:5px;min-height:24px;cursor:pointer}.recording-privacy-link{all:unset;display:inline-flex;align-items:center;min-height:24px;padding:0 2px;color:var(--accent);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}.recording-consent .recording-consent-hint{min-width:0;flex:1;color:#536d73;font-size:11px}',
        '.recording-privacy-terms{margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:var(--control-radius);background:var(--bg-secondary)}.recording-privacy-terms section+section{margin-top:8px}.recording-privacy-terms h3{margin:0 0 4px;font-size:12px}.recording-privacy-terms p{line-height:1.6;overflow-wrap:anywhere}',
        '.panel.expanded .messages,.panel.expanded .pending-input,.panel.expanded .composer{animation:content-reveal .24s .06s cubic-bezier(.22,1,.36,1) both;}',
        '@keyframes panel-enter{from{opacity:0;}to{opacity:1;}}',
        '@keyframes content-reveal{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}',
        '@keyframes control-enter{from{opacity:0;transform:scale(.78);}to{opacity:1;transform:scale(1);}}',
        '@media(max-width:640px){.topic-label{max-width:150px;}.runtime-status{font-size:10px;}.assistant-select{max-width:190px;}.pending-options{grid-template-columns:1fr;}}',
        '@media(max-width:390px){.topic-label{max-width:112px;}.assistant-select{max-width:150px;}.composer{padding-left:7px;padding-right:7px;}}',
        '.panel.recording-open>:not(.panel-header):not(.recording-drawer):not(.recording-consent-overlay){display:none}.panel.expanded:has(>.recording-consent-overlay),.panel:not(.expanded):has(>.recording-consent-overlay){height:min(400px,calc(100vh - 96px));min-height:0}',
        '.panel.context-open>:not(.panel-header):not(.context-popover):not(.recording-consent-overlay){display:none}',
        '.panel button:focus-visible,.panel summary:focus-visible,.panel [tabindex="0"]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.panel button{touch-action:manipulation}.recording-drawer-notice[hidden],.recording-privacy-terms[hidden]{display:none}',
        '@media(max-width:390px){.header-actions{gap:2px}.panel-header{gap:6px}.recording-event-detail{grid-template-columns:1fr;gap:2px}.recording-source-row{gap:5px;padding:6px}.recording-row-actions{gap:3px}.recording-row-actions button{padding:0 5px}.recording-source-heading{flex-wrap:wrap;gap:0 5px}.runtime-status{max-width:94px}.composer-toolbar{gap:4px}}',
        '@media(prefers-reduced-motion:reduce){.panel,.panel *{scroll-behavior:auto!important;transition:none!important;animation:none!important;}.status-dot.running{animation:none;}}',
      ].join('') + eventView.STYLE_TEXT + [
        '.recording-action-details>summary{display:flex;align-items:center;gap:6px;min-height:24px;padding:0 3px;list-style:none;cursor:pointer;}.recording-action-details>summary::-webkit-details-marker{display:none;}',
        '.recording-action-details>summary::before{content:"";flex:0 0 8px;width:8px;height:8px;border:solid currentColor;border-width:0 2px 2px 0;transform:translateX(-2px) rotate(-45deg);}.recording-action-details[open]>summary::before{transform:translateY(-2px) rotate(45deg);}',
        '.recording-action-details>summary:hover{background:var(--accent-soft);color:var(--accent);}.recording-action-details>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}',
        '.messages.conversation-event-stream{padding:8px;background:rgba(255,255,255,.74);}',
      ].join('');

      panel = documentRef.createElement('section');
      panel.className = 'panel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', '页面对话');

      var header = documentRef.createElement('header');
      header.className = 'panel-header';
      panelHeader = header;
      var heading = documentRef.createElement('div');
      heading.className = 'heading';
      var brandIcon = documentRef.createElement('img');
      brandIcon.className = 'brand-icon';
      brandIcon.alt = '';
      brandIcon.src = runtime.getURL('icons/icon48.png');
      var headingCopy = documentRef.createElement('div');
      headingCopy.className = 'heading-copy';
      title = documentRef.createElement('div');
      title.className = 'panel-title';
      topicLabel = documentRef.createElement('div');
      topicLabel.className = 'topic-label';
      headingCopy.appendChild(title);
      headingCopy.appendChild(topicLabel);
      heading.appendChild(brandIcon);
      heading.appendChild(headingCopy);
      runtimeStatus = documentRef.createElement('div');
      runtimeStatus.className = 'runtime-status';
      runtimeStatus.setAttribute('aria-live', 'polite');
      statusDot = documentRef.createElement('span');
      statusDot.className = 'status-dot';
      statusDot.setAttribute('aria-hidden', 'true');
      statusText = documentRef.createElement('span');
      statusText.className = 'status-text';
      runtimeStatus.appendChild(statusDot);
      runtimeStatus.appendChild(statusText);
      contextCompactButton = element('button', 'context-compact-button');
      contextCompactButton.type = 'button';
      contextCompactButton.hidden = true;
      contextCompactButton.setAttribute('aria-haspopup', 'dialog');
      contextCompactButton.setAttribute('aria-controls', 'page-context-popover');
      var headerActions = documentRef.createElement('div');
      headerActions.className = 'header-actions';
      toggleButton = documentRef.createElement('button');
      toggleButton.type = 'button';
      toggleButton.className = 'icon-button';
      closeButton = documentRef.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'icon-button';
      closeButton.title = '关闭对话';
      closeButton.setAttribute('aria-label', closeButton.title);
      closeButton.appendChild(iconClose());
      headerStopButton = documentRef.createElement('button');
      headerStopButton.type = 'button';
      headerStopButton.className = 'header-stop-button';
      headerStopButton.appendChild(iconStop());
      headerActions.appendChild(runtimeStatus);
      headerActions.appendChild(contextCompactButton);
      headerActions.appendChild(toggleButton);
      headerActions.appendChild(closeButton);
      headerActions.appendChild(headerStopButton);
      header.appendChild(heading);
      header.appendChild(headerActions);

      messages = documentRef.createElement('div');
      messages.className = 'messages conversation-event-stream';
      messages.setAttribute('aria-live', 'polite');

      pendingSteeringHost = documentRef.createElement('div');
      pendingSteeringHost.hidden = true;

      pendingInputHost = documentRef.createElement('section');
      pendingInputHost.className = 'pending-input';
      pendingInputHost.hidden = true;
      pendingInputHost.setAttribute('aria-live', 'polite');

      var composer = documentRef.createElement('footer');
      composer.className = 'composer';
      notice = documentRef.createElement('div');
      notice.className = 'notice';
      notice.hidden = true;
      appContextNotice = documentRef.createElement('div');
      appContextNotice.className = 'notice';
      appContextNotice.hidden = true;
      recordingSummary = documentRef.createElement('div');
      recordingSummary.className = 'recording-summary';
      recordingSummary.hidden = true;
      recordingSummaryText = documentRef.createElement('span');
      recordingSummaryText.className = 'recording-summary-text';
      recordingLibraryButton = documentRef.createElement('button');
      recordingLibraryButton.type = 'button';
      recordingLibraryButton.setAttribute('aria-expanded', 'false');
      recordingLibraryButton.setAttribute('aria-controls', 'recording-drawer');
      recordingSummary.appendChild(recordingSummaryText);
      recordingSummary.appendChild(recordingLibraryButton);
      var toolbar = documentRef.createElement('div');
      toolbar.className = 'composer-toolbar';
      assistantSelect = documentRef.createElement('select');
      assistantSelect.className = 'assistant-select';
      assistantSelect.setAttribute('aria-label', '选择助手');
      contextMeter = element('button', 'context-meter is-unknown');
      contextMeter.type = 'button';
      contextMeter.setAttribute('aria-expanded', 'false');
      contextMeter.setAttribute('aria-haspopup', 'dialog');
      contextMeter.setAttribute('aria-controls', 'page-context-popover');
      var contextCaption = element('span', 'context-meter-caption', '上下文占用：');
      contextCaption.setAttribute('aria-hidden', 'true');
      contextMeterValue = element('span', 'context-meter-value', '—');
      contextCaption.appendChild(contextMeterValue);
      var contextTrack = element('span', 'context-meter-track');
      contextTrack.setAttribute('aria-hidden', 'true');
      contextTrack.appendChild(element('span', 'context-meter-fill'));
      contextThreshold = element('span', 'context-meter-threshold');
      contextThreshold.hidden = true;
      contextTrack.appendChild(contextThreshold);
      contextMeter.appendChild(contextCaption);
      contextMeter.appendChild(contextTrack);
      var spacer = documentRef.createElement('span');
      spacer.className = 'toolbar-spacer';
      recordButton = documentRef.createElement('button');
      recordButton.type = 'button';
      recordButton.className = 'record-button';
      recordButton.title = '录制页面操作';
      recordButton.setAttribute('aria-label', '录制页面操作');
      recordButton.textContent = '录制';
      newTopicButton = documentRef.createElement('button');
      newTopicButton.type = 'button';
      newTopicButton.className = 'icon-button';
      newTopicButton.title = '新建话题';
      newTopicButton.setAttribute('aria-label', '新建话题');
      newTopicButton.appendChild(iconNewTopic());
      openOptionsButton = documentRef.createElement('button');
      openOptionsButton.type = 'button';
      openOptionsButton.className = 'icon-button';
      openOptionsButton.title = '在对话页面打开';
      openOptionsButton.setAttribute('aria-label', '在对话页面打开');
      openOptionsButton.appendChild(iconOpenConversation());
      toolbar.appendChild(assistantSelect);
      toolbar.appendChild(contextMeter);
      toolbar.appendChild(recordButton);
      toolbar.appendChild(spacer);
      toolbar.appendChild(openOptionsButton);
      toolbar.appendChild(newTopicButton);
      var composerRow = documentRef.createElement('div');
      composerRow.className = 'composer-row';
      input = documentRef.createElement('textarea');
      input.className = 'message-input';
      input.rows = 1;
      input.maxLength = 12000;
      input.placeholder = '输入消息';
      input.setAttribute('aria-label', '对话内容');
      actionButton = documentRef.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'action-button send';
      composerRow.appendChild(input);
      composerRow.appendChild(actionButton);
      composer.appendChild(notice);
      composer.appendChild(appContextNotice);
      composer.appendChild(recordingSummary);
      composer.appendChild(toolbar);
      composer.appendChild(composerRow);

      recordingDrawer = documentRef.createElement('section');
      recordingDrawer.id = 'recording-drawer';
      recordingDrawer.className = 'recording-drawer';
      recordingDrawer.hidden = true;
      recordingDrawer.setAttribute('role', 'dialog');
      recordingDrawer.setAttribute('aria-labelledby', 'recording-drawer-title');
      var recordingDrawerHeader = documentRef.createElement('header');
      recordingDrawerHeader.className = 'recording-drawer-header';
      recordingDrawerTitle = element('h2', '', '查看与选择录制');
      recordingDrawerTitle.id = 'recording-drawer-title';
      recordingDrawerHeader.appendChild(recordingDrawerTitle);
      recordingDrawerClose = documentRef.createElement('button');
      recordingDrawerClose.type = 'button'; recordingDrawerClose.className = 'icon-button';
      recordingDrawerClose.title = '关闭选择器'; recordingDrawerClose.setAttribute('aria-label', '关闭录制选择器');
      recordingDrawerClose.appendChild(iconClose());
      recordingDrawerClose.addEventListener('click', closeRecordingLibrary);
      recordingDrawerHeader.appendChild(recordingDrawerClose);
      recordingDrawerNotice = element('div', 'recording-drawer-notice');
      recordingDrawerNotice.hidden = true;
      recordingDrawerNotice.setAttribute('role', 'status');
      recordingDrawerBody = documentRef.createElement('div');
      recordingDrawerBody.className = 'recording-drawer-body';
      recordingDrawer.appendChild(recordingDrawerHeader); recordingDrawer.appendChild(recordingDrawerNotice); recordingDrawer.appendChild(recordingDrawerBody);
      recordingDrawer.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (event.target.type === 'search' && event.target.value && !recordingBusy) {
          filterRecordingEvents(previewState.category, '');
        } else closeRecordingLibrary();
      });

      contextPopover = element('section', 'context-popover');
      contextPopover.id = 'page-context-popover';
      contextPopover.hidden = true;
      contextPopover.setAttribute('role', 'dialog');
      contextPopover.setAttribute('aria-labelledby', 'page-context-title');
      var contextHeader = element('header', 'context-popover-header');
      var contextTitle = element('h2', '', '上下文');
      contextTitle.id = 'page-context-title';
      var contextClose = element('button', 'icon-button');
      contextClose.type = 'button';
      contextClose.title = '关闭上下文';
      contextClose.setAttribute('aria-label', contextClose.title);
      contextClose.appendChild(iconClose());
      contextPopoverBody = element('div', 'context-popover-body');
      contextRefreshButton = element('button', 'secondary-command', '刷新');
      contextRefreshButton.type = 'button';
      contextHeader.appendChild(contextTitle);
      contextHeader.appendChild(contextRefreshButton);
      contextHeader.appendChild(contextClose);
      contextPopover.appendChild(contextHeader);
      contextPopover.appendChild(contextPopoverBody);
      listen(contextMeter, 'click', openContextPopover);
      listen(contextCompactButton, 'click', openContextPopover);
      listen(contextClose, 'click', function () { closeContextPopover(true); });
      listen(contextRefreshButton, 'click', function () { loadContextUsage(true); });
      listen(contextPopover, 'keydown', function (event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeContextPopover(true);
        }
      });

      panel.appendChild(header);
      panel.appendChild(messages);
      panel.appendChild(pendingSteeringHost);
      panel.appendChild(pendingInputHost);
      panel.appendChild(composer);
      panel.appendChild(recordingDrawer);
      panel.appendChild(contextPopover);
      shadow.appendChild(style);
      shadow.appendChild(panel);
      documentRef.documentElement.appendChild(host);
      var sessionStorage = null;
      try { sessionStorage = win.sessionStorage; } catch (_) {}
      panelPositionController = positionControllerApi.createFree({
        window: win,
        document: documentRef,
        host: host,
        handle: panelHeader,
        boundaryElement: panel,
        dragClassTarget: panel,
        storage: sessionStorage,
        storageKey: PANEL_POSITION_STORAGE_KEY,
        defaultPosition: { leftRatio: 0.5, topRatio: 1 },
        verticalAnchor: 'bottom',
      });
      panelPositionController.init();
    }

    function revealInitialState() {
      if (destroyed || !host) return;
      if (panel) panel.classList.add('positioning');
      refreshPanelPosition();
      win.requestAnimationFrame(function () {
        if (destroyed || !host) return;
        refreshPanelPosition();
        win.requestAnimationFrame(function () {
          if (destroyed || !host) return;
          refreshPanelPosition();
          host.style.visibility = 'visible';
          if (panel) panel.classList.remove('positioning');
          if (expanded && input && !input.disabled) input.focus();
        });
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pendingConsent) pendingConsent();
      ++requestRevision;
      stopPoll();
      stopMessageElapsedTimer();
      if (panelPositionController) panelPositionController.destroy();
      panelPositionController = null;
      drainPendingInputCleanups();
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (_) {}
      }
      if (syncEventStream) syncEventStream.destroy();
      if (host && host.parentNode) host.parentNode.removeChild(host);
      if (virtualList) virtualList.destroy();
      virtualList = null;
      virtualListTopicId = '';
      messageRenderCache = Object.create(null);
      messageRenderCacheTopicId = '';
      host = null;
      panel = null;
      messages = null;
      pendingSteeringHost = null;
      pendingInputHost = null;
      pendingSubmitButton = null;
      input = null;
      actionButton = null;
      assistantSelect = null;
      recordButton = null;
      recordingSummary = null;
      recordingSummaryText = null;
      recordingLibraryButton = null;
      recordingDrawer = null;
      recordingDrawerTitle = null;
      recordingDrawerBody = null;
      recordingDrawerClose = null;
      recordingDrawerNotice = null;
      openOptionsButton = null;
      contextMeter = null;
      contextMeterValue = null;
      contextThreshold = null;
      contextCompactButton = null;
      contextPopover = null;
      contextPopoverBody = null;
      contextRefreshButton = null;
      contextUsage = null;
      closeButton = null;
      headerStopButton = null;
      panelHeader = null;
      runtimeStatus = null;
      runtimeClient = null;
      runtime = null;
      eventView = null;
      win = null;
      documentRef = null;
    }

    createHost();
    setExpanded(true, false);
    replaceIcon(actionButton, iconSend());
    listen(assistantSelect, 'change', handleAssistantChange);
    listen(recordButton, 'click', startOrStopRecording);
    listen(openOptionsButton, 'click', openOptionsConversation);
    listen(newTopicButton, 'click', startNewTopic);
    listen(toggleButton, 'click', function (event) {
      event.stopPropagation();
      setExpanded(!expanded, !expanded);
      renderMessages();
      renderControls();
    });
    listen(closeButton, 'click', function (event) {
      event.stopPropagation();
      if (typeof options.onClose === 'function') options.onClose();
      else destroy();
    });
    listen(headerStopButton, 'click', function (event) {
      event.stopPropagation();
      stop();
    });
    listen(panelHeader, 'click', function (event) {
      if (panelPositionController && panelPositionController.consumeSuppressedClick()) return;
      var interactive = event.target && event.target.closest && event.target.closest('button,select,textarea,input');
      if (!interactive) {
        setExpanded(!expanded, !expanded);
        renderMessages();
        renderControls();
      }
    });
    listen(actionButton, 'click', handleAction);
    listen(messages, 'click', handleMessageAction);
    listen(messages, 'copy', function (event) {
      conversationShared.copySelectionWithoutTrailingBlankLines(event, messages);
    });
    listen(pendingSteeringHost, 'click', handlePendingSteeringAction);
    listen(messages, 'scroll', handleMessagesScroll, { passive: true });
    listen(messages, 'wheel', handleMessagesWheel, { passive: true });
    listen(recordingDrawerBody, 'scroll', handleRecordingSourcesScroll, { passive: true });
    listen(recordingDrawerBody, 'wheel', handleRecordingSourcesWheel, { passive: true });
    listen(input, 'input', function () { resizeInput(); renderControls(); });
    listen(input, 'keydown', handleInputKeydown);
    listen(documentRef, 'visibilitychange', handleVisibility);
    subscribe(runtime && runtime.onMessage, handleRuntimeMessage);
    subscribe(globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.onChanged, function (changes, area) {
      if (area === 'local' && (changes.app_conversation_bindings_regular || changes.app_conversation_bindings_incognito)
          && !destroyed && !documentRef.hidden) refreshApplicationContext(true);
    });
    if (syncEventStream) cleanups.push(syncEventStream.subscribe(handleSyncEvent));
    render();
    refreshState().then(function () { return refreshRecordingState(); }).finally(revealInitialState);

    return Object.freeze({
      destroy: destroy,
      refresh: function () { return refreshState({ quiet: true }); },
    });
  }

  return Object.freeze({ API_VERSION: 1, create: create });
});
