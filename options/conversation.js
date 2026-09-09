// Conversation UI — options page assistant/topic runner
(function attachConversation(root, factory) {
  root.Conversation = factory();
})(globalThis, function () {
  'use strict';

  var conversationEventView = globalThis.PageAutomationConversationEventView;
  var imageArtifactClient = globalThis.PageAutomationImageArtifactClient;
  var toolResultProjection = globalThis.AgentToolResultProjection;
  var zipStore = globalThis.PageAutomationZipStore;
  var conversationShared = globalThis.PageAutomationConversationShared;
  var conversationListView = globalThis.PageAutomationConversationListView;
  var syncEventStream = globalThis.PageAutomationSyncEventStream
    && globalThis.PageAutomationSyncEventStream.create
    ? globalThis.PageAutomationSyncEventStream.create({ runtime: chrome.runtime })
    : null;
  if (!conversationEventView || conversationEventView.API_VERSION !== 1) {
    throw new Error('Conversation event view must load before Conversation');
  }
  if (!conversationShared || conversationShared.API_VERSION !== 1) {
    throw new Error('Conversation shared must load before Conversation');
  }
  if (!conversationListView || conversationListView.API_VERSION !== 1
      || typeof conversationListView.projectPage !== 'function'
      || typeof conversationListView.mergeJournalPages !== 'function'
      || typeof conversationListView.createVirtualList !== 'function') {
    throw new Error('Conversation list view must load before Conversation');
  }

  function hydrateConversationImages(container) {
    if (!imageArtifactClient || typeof imageArtifactClient.hydrate !== 'function' || !container) return;
    imageArtifactClient.hydrate(container).catch(function () {});
  }

  var state = null;
  var initialized = false;
  var renderQueued = false;
  var renderPending = false;
  var sidebarTab = 'assistant';
  var assistantMenuOpen = false;
  var topicMenuOpen = false;
  var assistantEditorDraft = null;
  var assistantEditorTab = 'base';
  var topicConfigTab = 'run';
  var confirmDialogEl = null;
  var confirmDialogFinish = null;
  var sidebarCollapsed = false;
  var composerDrafts = {};
  var steeringCommandQueuesByTopic = Object.create(null);
  var interruptingModelRequestByTopic = Object.create(null);
  var runInputDrafts = {};
  var modelServiceResources = [];
  var assistantSkillResources = [];
  var assistantMcpServerResources = [];
  var assistantResourceOptionsLoaded = false;
  var assistantResourceOptionsPromise = null;
  var agentSettingsResource = null;
  var newTopicModelServiceId = '';
  var lastRenderKey = '';
  var lastSidebarRenderKey = '';
  var eventStreamForceFollowTopicId = '';
  var eventDisclosureState = Object.create(null);
  var conversationVirtualList = null;
  var conversationVirtualContainer = null;
  var incrementalConversationTopicById = Object.create(null);
  var refreshPromise = null;
  var requestedOpenTarget = null;
  var topicSwitchLoadingTopicId = '';
  var topicSwitchSeq = 0;
  var assistantSwitchLoadingAssistantId = '';
  var assistantSwitchSeq = 0;
  var assistantDrag = null;
  var assistantDragSuppressClickUntil = 0;
  var assistantOrderMutationSeq = 0;
  var ASSISTANT_DRAG_ACTIVATION_PX = 8;
  var ASSISTANT_DRAG_DROP_MS = 150;
  var DEFAULT_MAX_ITERATIONS = 100;
  var DEFAULT_MAX_TOOL_CALLS = 200;
  var ASSISTANT_RUN_SETTING_KEYS = Object.freeze([
    'temperature', 'topP', 'maxTokens', 'maxContextTokens', 'reasoningEffort',
    'contextCompression', 'streamOutput', 'mode', 'maxIterations', 'maxToolCalls',
    'autoCreateNewTopic',
  ]);
  var CLEAN_CONTEXT_FAILURE_THRESHOLD = 2;
  var selectedTrajectoryCellId = '';
  var selectedTrajectoryRequestNumber = 0;
  var traceViewerSearch = '';
  var trajectoryCollapsedAssistantIds = Object.create(null);
  var trajectoryTimelineRange = null;
  var trajectoryTimelineViewport = null;
  var trajectoryTimelineAnchor = null;
  var trajectoryTimelinePan = null;
  var trajectoryInspectorTab = 'overview';
  var trajectoryInspectorOpen = false;
  /* Let the Harness-style clamp choose the initial width; a numeric value is
     only written after the user explicitly resizes the details pane. */
  var trajectoryInspectorWidth = 0;
  var trajectoryInspectorResize = null;
  var traceViewerRefreshTimer = 0;
  var traceViewerReloadPromise = null;
  var traceViewerRenderSignature = '';
  var traceViewerSelectedSignature = '';
  var trajectoryViewOpen = false;
  var trajectoryEventsByTopic = Object.create(null);
  var trajectoryItemsByTopic = Object.create(null);
  var trajectoryPageByTopic = Object.create(null);
  var trajectoryRequestByTopic = Object.create(null);
  var conversationEventsCompleteByTopic = Object.create(null);
  /* `topic.events` is the rendered projection consumed by the DOM. Keep the
     Journal rows that feed that projection separately; mixing the two shapes
     makes the next incremental read lose tool/reasoning/assistant rows. */
  var rawConversationEventsByTopic = Object.create(null);
  var trajectoryFollowsTail = true;
  var trajectoryScrollTopicId = '';
  var trajectoryVirtualState = null;
  var trajectoryVirtualFrame = 0;
  var topicControlAccessById = Object.create(null);
  var topicControlRequestById = Object.create(null);
  var readonlySnapshotRefreshTimer = 0;
  var readonlySnapshotRefreshTopicId = '';
  var readonlySnapshotControlRevalidatePending = false;
  var readonlySnapshotRefreshPending = false;
  var READONLY_SNAPSHOT_REFRESH_MS = 180;
  var CONVERSATION_OLDER_LOAD_THRESHOLD = 120;
  var journalRefreshTimersByTopic = Object.create(null);
  var journalRefreshRunningByTopic = Object.create(null);
  var journalRefreshQueuedByTopic = Object.create(null);
  var journalRefreshMetadataByTopic = Object.create(null);
  /* Journal reads can be triggered by both the mutation broadcast and the
     running-topic poll. Keep one in-flight hydrate per topic so an older
     response can never race a newer projection back into the event stream. */
  var topicHydrationByTopic = Object.create(null);
  var archivedTopicById = Object.create(null);
  var archivedTopicRequestById = Object.create(null);
  var arpResourceClient = null;
  var conversationProfileApi = null;

  function $(sel) { return document.querySelector(sel); }

  function optionsResourceClient() {
    if (arpResourceClient) return arpResourceClient;
    if (!globalThis.PageAutomationResourceClient
        || typeof globalThis.PageAutomationResourceClient.create !== 'function') {
      throw new Error('PageAutomationResourceClient 未初始化');
    }
    arpResourceClient = globalThis.PageAutomationResourceClient.create();
    return arpResourceClient;
  }

  function profileApi() {
    if (conversationProfileApi) return conversationProfileApi;
    if (!globalThis.ConversationProfileSchema
        || typeof globalThis.ConversationProfileSchema.create !== 'function') {
      throw new Error('ConversationProfileSchema 未初始化');
    }
    conversationProfileApi = globalThis.ConversationProfileSchema.create({
      defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
      defaultMaxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    });
    return conversationProfileApi;
  }

  function resourceSegment(value) {
    return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function resourceData(envelope) {
    var primary = envelope && envelope.primary;
    return primary && primary.data && typeof primary.data === 'object' ? primary.data : null;
  }

  function resourceErrorText(error) {
    var code = error && error.code ? '[' + error.code + '] ' : '';
    return code + String(error && error.message ? error.message : (error || '资源请求失败'));
  }

  function conversationUri(topicId) {
    return '/conversations/' + resourceSegment(topicId);
  }

  function assistantUri(assistantId) {
    return '/assistants/' + resourceSegment(assistantId);
  }

  function listResourceCollection(uri, requestTag) {
    var items = [];
    var seen = Object.create(null);
    function read(cursor) {
      var query = { limit: 100 };
      if (cursor) query.cursor = cursor;
      return optionsResourceClient().get(uri, {
        query: query,
        context: { requestTag: requestTag },
      }).then(function (envelope) {
        var data = resourceData(envelope) || {};
        if (Array.isArray(data.items)) items = items.concat(data.items);
        var nextCursor = String(data.nextCursor || '');
        if (!nextCursor || seen[nextCursor]) return items;
        seen[nextCursor] = true;
        return read(nextCursor);
      });
    }
    return read('');
  }

  function listAssistantResources() {
    return listResourceCollection('/assistants', 'conversation-assistant-list');
  }

  function loadAssistantResourceOptions() {
    if (assistantResourceOptionsPromise) return assistantResourceOptionsPromise;
    assistantResourceOptionsPromise = Promise.all([
      listResourceCollection('/skills', 'conversation-assistant-skill-list'),
      listResourceCollection('/mcp-servers', 'conversation-assistant-mcp-list'),
    ]).then(function (values) {
      assistantSkillResources = (values[0] || []).filter(function (skill) {
        return skill && skill.enabled !== false && skill.archived !== true;
      });
      assistantMcpServerResources = (values[1] || []).filter(function (server) {
        return server && server.enabled === true;
      });
      assistantResourceOptionsLoaded = true;
      return values;
    }).catch(function (error) {
      assistantResourceOptionsLoaded = true;
      throw error;
    }).finally(function () {
      assistantResourceOptionsPromise = null;
    });
    return assistantResourceOptionsPromise;
  }

  function getAssistantResource(assistantId) {
    return optionsResourceClient().get(assistantUri(assistantId), {
      context: { requestTag: 'conversation-assistant-read' },
    }).then(function (envelope) {
      var assistant = resourceData(envelope);
      if (!assistant || !assistant.id) throw new Error('助手资源未返回 id');
      return assistant;
    });
  }

  function createAssistantResource(body) {
    return optionsResourceClient().authorizedPost('/assistants', body, {
      criteria: { relation: 'assistants' },
      context: { requestTag: 'conversation-assistant-create' },
    }).then(function (envelope) {
      var assistant = resourceData(envelope);
      if (!assistant || !assistant.id) throw new Error('创建助手未返回 id');
      return assistant;
    });
  }

  function patchAssistantResource(assistantId, patch) {
    var uri = assistantUri(assistantId);
    return optionsResourceClient().get(uri, {
      context: { requestTag: 'conversation-assistant-precondition' },
    }).then(function (envelope) {
      var etag = String(envelope && envelope.primary && envelope.primary.etag || '');
      if (!etag) throw new Error('助手资源未返回更新所需的 ETag');
      return optionsResourceClient().authorizedPatch(uri, patch, {
        etag: etag,
        criteria: { relation: 'assistant' },
        context: { requestTag: 'conversation-assistant-patch' },
      });
    }).then(function (envelope) {
      var assistant = resourceData(envelope);
      if (!assistant || !assistant.id) throw new Error('更新助手未返回 id');
      return assistant;
    });
  }

  function deleteAssistantResource(assistantId) {
    var uri = assistantUri(assistantId);
    return optionsResourceClient().get(uri, {
      context: { requestTag: 'conversation-assistant-precondition' },
    }).then(function (envelope) {
      var etag = String(envelope && envelope.primary && envelope.primary.etag || '');
      if (!etag) throw new Error('助手资源未返回删除所需的 ETag');
      return optionsResourceClient().authorizedDelete(uri, {
        etag: etag,
        criteria: { relation: 'assistant' },
        context: { requestTag: 'conversation-assistant-delete' },
      });
    });
  }

  function listModelServiceResources() {
    return listResourceCollection('/model-services', 'conversation-model-service-list');
  }

  function getAgentSettingsResource() {
    return optionsResourceClient().get('/agent-settings', {
      context: { requestTag: 'conversation-agent-settings-read' },
    }).then(function (envelope) {
      var settings = resourceData(envelope);
      if (!settings || typeof settings !== 'object') throw new Error('Agent Settings 资源为空');
      return settings;
    });
  }

  function patchAgentSettingsResource(patch) {
    var uri = '/agent-settings';
    return optionsResourceClient().get(uri, {
      context: { requestTag: 'conversation-agent-settings-precondition' },
    }).then(function (envelope) {
      var etag = String(envelope && envelope.primary && envelope.primary.etag || '');
      if (!etag) throw new Error('Agent Settings 未返回更新所需的 ETag');
      return optionsResourceClient().authorizedPatch(uri, patch, {
        etag: etag,
        criteria: { relation: 'agent-settings' },
        context: { requestTag: 'conversation-agent-settings-patch' },
      });
    }).then(function (envelope) {
      var settings = resourceData(envelope);
      if (!settings || typeof settings !== 'object') throw new Error('更新 Agent Settings 未返回资源');
      agentSettingsResource = settings;
      return settings;
    });
  }

  function getConversationResource(topicId) {
    return optionsResourceClient().get(conversationUri(topicId), {
      context: { requestTag: 'conversation-ui-read' },
    }).then(function (envelope) {
      var topic = resourceData(envelope);
      if (!topic) throw new Error('对话资源未返回话题');
      return topic;
    });
  }

  function listConversationResources() {
    var items = [];
    var seen = Object.create(null);
    function read(cursor) {
      var query = { limit: 100, includeArchived: true };
      if (cursor) query.cursor = cursor;
      return optionsResourceClient().get('/conversations', {
        query: query,
        context: { requestTag: 'conversation-ui-list' },
      }).then(function (envelope) {
        var data = resourceData(envelope) || {};
        if (Array.isArray(data.items)) items = items.concat(data.items);
        var nextCursor = String(data.nextCursor || '');
        if (!nextCursor || seen[nextCursor]) return items;
        seen[nextCursor] = true;
        return read(nextCursor);
      });
    }
    return read('').then(function (summaries) {
      return Promise.all(summaries.map(function (summary) {
        return getConversationResource(summary.topicId || summary.id);
      }));
    });
  }

  function projectConversationResources(baseState, topics) {
    var next = Object.assign({}, baseState || {});
    var existingTopics = next.topics && typeof next.topics === 'object' ? next.topics : {};
    next.topics = {};
    next.topicOrder = [];
    (Array.isArray(topics) ? topics : []).forEach(function (topic) {
      var topicId = String(topic && (topic.topicId || topic.id) || '');
      if (!topicId) return;
      var existingTopic = existingTopics[topicId] || {};
      next.topics[topicId] = Object.assign({}, existingTopic, topic);
      // The list projection can legitimately omit a label while the detailed
      // topic already has one. Do not turn that temporary omission into an
      // unnamed conversation in the UI.
      ['name', 'objective'].forEach(function (key) {
        if (!String(next.topics[topicId][key] || '').trim() && String(existingTopic[key] || '').trim()) {
          next.topics[topicId][key] = existingTopic[key];
        }
      });
      next.topics[topicId].active = ['starting', 'running', 'waiting_user', 'cancelling']
        .indexOf(String(next.topics[topicId].status || '')) !== -1;
      next.topicOrder.push(topicId);
      if (next.topics[topicId].archived) archivedTopicById[topicId] = next.topics[topicId];
      else delete archivedTopicById[topicId];
    });
    if (!next.activeTopicId || !next.topics[next.activeTopicId]) next.activeTopicId = next.topicOrder[0] || '';
    return next;
  }

  function projectConversationResource(topic) {
    var topicId = String(topic && (topic.topicId || topic.id) || '');
    if (!topicId || !state) return topic;
    var topics = Object.assign({}, state.topics || {});
    // Mutation responses are metadata projections and intentionally omit
    // history/events. Preserve the detailed fields already loaded by the UI.
    var existingTopic = topics[topicId] || {};
    var projectedTopic = Object.assign({}, existingTopic, topic);
    ['name', 'objective'].forEach(function (key) {
      if (!String(projectedTopic[key] || '').trim() && String(existingTopic[key] || '').trim()) {
        projectedTopic[key] = existingTopic[key];
      }
    });
    topics[topicId] = projectedTopic;
    var topicOrder = (state.topicOrder || []).slice();
    if (topicOrder.indexOf(topicId) === -1) topicOrder.unshift(topicId);
    state = Object.assign({}, state, { topics: topics, topicOrder: topicOrder });
    if (projectedTopic.archived) archivedTopicById[topicId] = projectedTopic;
    else delete archivedTopicById[topicId];
    return projectedTopic;
  }

  function projectAssistantResources(baseState, assistants, settings) {
    var next = Object.assign({}, baseState || {});
    next.assistants = {};
    next.assistantOrder = [];
    (Array.isArray(assistants) ? assistants : []).forEach(function (assistant) {
      var assistantId = String(assistant && assistant.id || '');
      if (!assistantId) return;
      next.assistants[assistantId] = assistant;
      next.assistantOrder.push(assistantId);
    });
    var activeAssistantId = String(settings && settings.defaultAssistantId || '');
    next.activeAssistantId = next.assistants[activeAssistantId] ? activeAssistantId : '';
    if (next.activeTopicId) {
      var activeTopic = next.topics && next.topics[next.activeTopicId];
      if (!activeTopic || activeTopic.assistantId !== next.activeAssistantId) {
        next.activeTopicId = firstTopicIdForAssistant(next, next.activeAssistantId);
      }
    }
    return next;
  }

  function projectAssistantResource(assistant) {
    var assistantId = String(assistant && assistant.id || '');
    if (!assistantId || !state) return assistant;
    var assistants = Object.assign({}, state.assistants || {});
    assistants[assistantId] = assistant;
    var assistantOrder = (state.assistantOrder || []).slice();
    if (assistantOrder.indexOf(assistantId) === -1) assistantOrder.unshift(assistantId);
    state = Object.assign({}, state, { assistants: assistants, assistantOrder: assistantOrder });
    return assistant;
  }

  function normalizedAssistantOrder(order) {
    if (!state) return [];
    var assistants = state.assistants || {};
    var seen = Object.create(null);
    return (Array.isArray(order) ? order : [])
      .concat(Array.isArray(state.assistantOrder) ? state.assistantOrder : [])
      .concat(Object.keys(assistants))
      .map(function (id) { return String(id || '').trim(); })
      .filter(function (id) {
        if (!id || seen[id] || !assistants[id]) return false;
        seen[id] = true;
        return true;
      });
  }

  function sameAssistantOrder(left, right) {
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  function reorderAssistantCatalog(order) {
    if (!state) return Promise.resolve(state);
    var previousOrder = normalizedAssistantOrder(state.assistantOrder);
    var nextOrder = normalizedAssistantOrder(order);
    if (sameAssistantOrder(previousOrder, nextOrder)) return Promise.resolve(state);
    var mutationSeq = ++assistantOrderMutationSeq;
    state = Object.assign({}, state, { assistantOrder: nextOrder });
    assistantMenuOpen = false;
    topicMenuOpen = false;
    lastRenderKey = '';
    renderLoaded();
    return globalThis.ConversationState.reorderAssistants(nextOrder).then(function () {
      return state;
    }).catch(function (error) {
      if (mutationSeq !== assistantOrderMutationSeq) return state;
      state = Object.assign({}, state, { assistantOrder: previousOrder });
      lastRenderKey = '';
      renderLoaded();
      toast('保存助手顺序失败: ' + String(error && error.message || error), true);
      return state;
    });
  }

  function moveAssistantToTop(assistantId) {
    var order = normalizedAssistantOrder(state && state.assistantOrder);
    var index = order.indexOf(String(assistantId || ''));
    if (index <= 0) return Promise.resolve(state);
    var nextOrder = order.slice();
    nextOrder.splice(index, 1);
    nextOrder.unshift(assistantId);
    return reorderAssistantCatalog(nextOrder);
  }

  function assistantDragFrame(callback) {
    return window.requestAnimationFrame ? window.requestAnimationFrame(callback) : setTimeout(callback, 16);
  }

  function cancelAssistantDragFrame(frameId) {
    if (!frameId) return;
    if (window.cancelAnimationFrame) window.cancelAnimationFrame(frameId);
    else clearTimeout(frameId);
  }

  function scheduleAssistantDragUpdate() {
    if (!assistantDrag || !assistantDrag.active || assistantDrag.frameId) return;
    assistantDrag.frameId = assistantDragFrame(updateAssistantDragPosition);
  }

  function updateAssistantDragPosition() {
    var drag = assistantDrag;
    if (!drag || !drag.active) return;
    drag.frameId = 0;
    if (!drag.list.isConnected || !drag.overlay.isConnected) {
      finishAssistantDrag(null, true);
      return;
    }

    var listRect = drag.list.getBoundingClientRect();
    var edgeSize = Math.min(42, Math.max(24, listRect.height / 5));
    var scrollVelocity = 0;
    if (drag.lastClientY < listRect.top + edgeSize) {
      scrollVelocity = -Math.ceil((listRect.top + edgeSize - drag.lastClientY) / 4);
    } else if (drag.lastClientY > listRect.bottom - edgeSize) {
      scrollVelocity = Math.ceil((drag.lastClientY - (listRect.bottom - edgeSize)) / 4);
    }
    if (scrollVelocity) drag.list.scrollTop += Math.max(-14, Math.min(14, scrollVelocity));

    var scrollDelta = drag.list.scrollTop - drag.startScrollTop;
    var deltaY = drag.lastClientY - drag.startClientY;
    drag.overlay.style.transform = 'translate3d(0,' + deltaY + 'px,0) scale(1.02)';
    var draggedCenter = drag.sourceRect.top + deltaY + drag.sourceRect.height / 2;
    var targetIndex = 0;
    drag.rects.forEach(function (rect, index) {
      if (index === drag.sourceIndex) return;
      if (draggedCenter > rect.top - scrollDelta + rect.height / 2) targetIndex += 1;
    });
    drag.targetIndex = Math.max(0, Math.min(drag.rows.length - 1, targetIndex));
    drag.rows.forEach(function (row, index) {
      var shift = 0;
      if (drag.targetIndex < drag.sourceIndex && index >= drag.targetIndex && index < drag.sourceIndex) {
        shift = drag.displacement;
      } else if (drag.targetIndex > drag.sourceIndex && index > drag.sourceIndex && index <= drag.targetIndex) {
        shift = -drag.displacement;
      }
      row.style.transform = shift ? 'translate3d(0,' + shift + 'px,0)' : '';
    });
    if (scrollVelocity) scheduleAssistantDragUpdate();
  }

  function activateAssistantDrag(event) {
    var drag = assistantDrag;
    if (!drag || drag.active) return;
    drag.active = true;
    drag.startScrollTop = drag.list.scrollTop;
    drag.rects = drag.rows.map(function (row) { return row.getBoundingClientRect(); });
    drag.sourceRect = drag.rects[drag.sourceIndex];
    var listStyle = window.getComputedStyle(drag.list);
    var gap = parseFloat(listStyle.rowGap || listStyle.gap) || 0;
    drag.displacement = drag.sourceRect.height + gap;
    drag.targetIndex = drag.sourceIndex;
    drag.list.classList.add('is-sorting');
    drag.row.classList.add('is-drag-source');
    assistantMenuOpen = false;
    topicMenuOpen = false;
    drag.row.querySelectorAll('.conversation-assistant-menu').forEach(function (menu) { menu.remove(); });

    var overlay = drag.row.cloneNode(true);
    overlay.classList.remove('is-drag-source');
    overlay.classList.add('conversation-assistant-drag-overlay');
    overlay.removeAttribute('data-assistant-id');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.left = drag.sourceRect.left + 'px';
    overlay.style.top = drag.sourceRect.top + 'px';
    overlay.style.width = drag.sourceRect.width + 'px';
    overlay.style.height = drag.sourceRect.height + 'px';
    document.body.appendChild(overlay);
    document.body.classList.add('conversation-assistant-dragging');
    drag.overlay = overlay;
    if (document.getSelection) {
      var selection = document.getSelection();
      if (selection) selection.removeAllRanges();
    }
    if (event) event.preventDefault();
    scheduleAssistantDragUpdate();
  }

  function cleanupAssistantDrag(drag) {
    if (!drag) return;
    cancelAssistantDragFrame(drag.frameId);
    drag.rows.forEach(function (row) {
      row.style.transform = '';
      row.classList.remove('is-drag-source');
    });
    drag.list.classList.remove('is-sorting');
    if (drag.overlay && drag.overlay.parentNode) drag.overlay.parentNode.removeChild(drag.overlay);
    document.body.classList.remove('conversation-assistant-dragging');
    if (assistantDrag === drag) assistantDrag = null;
  }

  function finishAssistantDrag(event, cancelled) {
    var drag = assistantDrag;
    if (!drag || event && event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      assistantDrag = null;
      return;
    }
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!cancelled && drag.list.isConnected && drag.overlay && drag.overlay.isConnected) {
      cancelAssistantDragFrame(drag.frameId);
      drag.frameId = 0;
      updateAssistantDragPosition();
    }
    assistantDragSuppressClickUntil = Date.now() + 350;
    var targetIndex = cancelled ? drag.sourceIndex : drag.targetIndex;
    var nextOrder = null;
    if (targetIndex !== drag.sourceIndex) {
      nextOrder = drag.order.slice();
      var movedId = nextOrder.splice(drag.sourceIndex, 1)[0];
      nextOrder.splice(targetIndex, 0, movedId);
    }
    var scrollDelta = drag.list.scrollTop - drag.startScrollTop;
    var destinationTop = drag.rects[targetIndex].top - scrollDelta;
    drag.overlay.classList.add('is-dropping');
    drag.overlay.style.transform = 'translate3d(0,' + (destinationTop - drag.sourceRect.top) + 'px,0) scale(1.02)';
    setTimeout(function () {
      cleanupAssistantDrag(drag);
      if (nextOrder) reorderAssistantCatalog(nextOrder);
      else {
        lastRenderKey = '';
        renderLoaded();
      }
    }, ASSISTANT_DRAG_DROP_MS);
  }

  function handleAssistantPointerDown(event) {
    if (assistantDrag || event.isPrimary === false || event.button !== 0) return;
    var row = event.target.closest('.conversation-assistant-row[data-assistant-id]');
    if (!row || event.target.closest('.conversation-assistant-more, .conversation-assistant-menu')) return;
    var list = row.closest('.conversation-assistant-list');
    if (!list) return;
    var rows = Array.prototype.slice.call(list.querySelectorAll('.conversation-assistant-row[data-assistant-id]'));
    if (rows.length < 2) return;
    var sourceIndex = rows.indexOf(row);
    if (sourceIndex < 0) return;
    assistantDrag = {
      active: false,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      list: list,
      row: row,
      rows: rows,
      order: rows.map(function (item) { return String(item.dataset.assistantId || ''); }),
      sourceIndex: sourceIndex,
      targetIndex: sourceIndex,
      frameId: 0,
      overlay: null,
    };
  }

  function handleAssistantPointerMove(event) {
    var drag = assistantDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    if (!drag.active) {
      var deltaX = event.clientX - drag.startClientX;
      var deltaY = event.clientY - drag.startClientY;
      if (Math.sqrt(deltaX * deltaX + deltaY * deltaY) < ASSISTANT_DRAG_ACTIVATION_PX) return;
      activateAssistantDrag(event);
    }
    event.preventDefault();
    scheduleAssistantDragUpdate();
  }

  function createConversationResource(body) {
    return optionsResourceClient().authorizedPost('/conversations', body || {}, {
      criteria: { relation: 'conversations' },
      context: { requestTag: 'conversation-ui-create' },
    }).then(function (envelope) {
      var topic = resourceData(envelope);
      if (!topic || !topic.topicId) throw new Error('创建对话未返回 topicId');
      return topic;
    });
  }

  function patchConversationResource(topicId, patch) {
    var uri = conversationUri(topicId);
    return optionsResourceClient().get(uri, {
      context: { requestTag: 'conversation-ui-precondition' },
    }).then(function (envelope) {
      return optionsResourceClient().authorizedPatch(uri, patch, {
        etag: envelope.primary && envelope.primary.etag,
        criteria: { relation: 'conversation' },
        context: { requestTag: 'conversation-ui-patch' },
      });
    }).then(function (envelope) {
      var topic = resourceData(envelope);
      if (!topic || !topic.topicId) throw new Error('更新对话未返回 topicId');
      return projectConversationResource(topic);
    });
  }

  function deleteConversationResource(topicId) {
    var uri = conversationUri(topicId);
    return optionsResourceClient().get(uri, {
      context: { requestTag: 'conversation-ui-precondition' },
    }).then(function (envelope) {
      return optionsResourceClient().authorizedDelete(uri, {
        etag: envelope.primary && envelope.primary.etag,
        criteria: { relation: 'conversation' },
        context: { requestTag: 'conversation-ui-delete' },
      });
    });
  }

  function esc(value) { return conversationShared.escapeHtml(value); }

  function renderMarkdown(text) { return conversationShared.renderMarkdown(text); }

  function fmtTime(ts) { return conversationShared.fmtTime(ts); }

  function toast(message, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.className = isError ? 'error' : '';
    setTimeout(function () { el.className = 'hidden'; }, 2600);
  }

  function copyText(text) { return conversationShared.copyText(text); }

  function safeFileName(value) { return conversationShared.safeFileName(value); }

  function safeTimestamp(ts) { return conversationShared.safeTimestamp(ts); }

  function conversationArchiveBase64Bytes(value) {
    var binary = atob(String(value || ''));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function exportConversationArchive(topicId) {
    var topic = displayedTopic();
    if (!topic || String(topic.topicId || '') !== String(topicId || '')) {
      toast('当前话题不可导出', true);
      return;
    }
    var exportId = '';
    var includeReasoning = true;
    toast('正在导出完整 Journal、检查点与图片…');
    try {
      var prepared = await sendMessage('PREPARE_CONVERSATION_ARCHIVE_EXPORT', {
        conversationId: topic.topicId,
        includeReasoning: includeReasoning,
        includePayloads: true,
      });
      exportId = String(prepared && prepared.exportId || '').trim();
      var byteLength = Number(prepared && prepared.byteLength);
      var maxRangeBytes = Number(prepared && prepared.maxRangeBytes);
      if (!exportId || !Number.isSafeInteger(byteLength) || byteLength <= 0
          || !Number.isSafeInteger(maxRangeBytes) || maxRangeBytes <= 0
          || prepared.rangeUnit !== 'bytes' || prepared.rangeSemantics !== '[start,end)'
          || prepared.encoding !== 'base64') {
        throw new Error('后台返回了无效的归档范围合同');
      }

      var requestedRangeBytes = Math.min(4 * 1024 * 1024, maxRangeBytes);
      var parts = [];
      for (var start = 0; start < byteLength; start += requestedRangeBytes) {
        var end = Math.min(byteLength, start + requestedRangeBytes);
        var range = await sendMessage('READ_CONVERSATION_ARCHIVE_EXPORT_RANGE', {
          exportId: exportId,
          start: start,
          end: end,
        });
        if (!range || String(range.exportId || '') !== exportId
            || Number(range.start) !== start || Number(range.end) !== end
            || Number(range.byteLength) !== byteLength || range.encoding !== 'base64') {
          throw new Error('后台返回了错误的归档字节范围');
        }
        var bytes = conversationArchiveBase64Bytes(range.data);
        if (bytes.byteLength !== end - start) throw new Error('归档分块字节数与请求范围不一致');
        parts.push(bytes);
      }

      var archive = new Blob(parts, { type: 'application/zip' });
      if (archive.size !== byteLength) throw new Error('归档组装后的字节数不一致');
      conversationShared.downloadFile(String(prepared.filename || ('conversation-' + safeFileName(topic.name || topic.objective)
        + '-' + safeTimestamp(Date.now()) + '.zip')), archive, 'application/zip');
      toast('完整 Journal 归档已开始下载' + (includeReasoning ? '（包含思考）' : '（不含思考）'));
    } catch (error) {
      toast('导出对话失败: ' + (error && error.message || error), true);
    } finally {
      if (exportId) {
        await sendMessage('RELEASE_CONVERSATION_ARCHIVE_EXPORT', { exportId: exportId }).catch(function () {});
      }
    }
  }

  function bytesAsDataUrl(bytes, mimeType) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('读取归档图片失败')); };
      reader.readAsDataURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
    });
  }

  async function importConversationArchiveFile(file) {
    if (!zipStore || typeof zipStore.read !== 'function' || !imageArtifactClient
        || typeof imageArtifactClient.importTopic !== 'function') throw new Error('对话归档恢复组件未加载');
    var entries = await zipStore.read(file, { maxBytes: 256 * 1024 * 1024 });
    var byName = Object.create(null);
    entries.forEach(function (entry) {
      if (Object.prototype.hasOwnProperty.call(byName, entry.name)) throw new Error('归档包含重复文件: ' + entry.name);
      byName[entry.name] = entry.data;
    });
    var decoder = new TextDecoder('utf-8', { fatal: true });
    var requiredFiles = ['manifest.json', 'conversation.json', 'journal.jsonl', 'checkpoints.json', 'artifacts/payloads.json'];
    var backupFiles = Object.create(null);
    requiredFiles.forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(byName, name)) throw new Error('归档缺少 ' + name);
      backupFiles[name] = decoder.decode(byName[name]);
    });
    var journalManifest = JSON.parse(backupFiles['manifest.json']);
    if (!journalManifest || journalManifest.format !== 'page-agent-conversation-journal'
        || Number(journalManifest.formatVersion) !== 3) {
      throw new Error('不是受支持的 Conversation Journal 归档');
    }
    var targetTopicId = String(journalManifest.conversationId || '').trim();
    if (!targetTopicId) throw new Error('Journal manifest 缺少 conversationId');
    var artifactManifest = byName['image-artifacts.json']
      ? JSON.parse(decoder.decode(byName['image-artifacts.json']))
      : { version: 1, artifacts: [] };
    if (!artifactManifest || Number(artifactManifest.version) !== 1) throw new Error('image-artifacts.json 版本不受支持');
    var manifestItems = Array.isArray(artifactManifest.artifacts) ? artifactManifest.artifacts : [];
    if (manifestItems.length > 100) throw new Error('归档图片数量超过 100 张上限');
    var importItems = [];
    var manifestPaths = Object.create(null);
    var mediaBytes = 0;
    for (var index = 0; index < manifestItems.length; index += 1) {
      var metadata = manifestItems[index] || {};
      var path = String(metadata.path || '');
      if (!/^media\/[A-Za-z0-9._~-]+\.[A-Za-z0-9]+$/.test(path)) throw new Error('归档媒体路径无效: ' + path);
      if (manifestPaths[path]) throw new Error('Artifact manifest 包含重复媒体路径: ' + path);
      manifestPaths[path] = true;
      if (!Object.prototype.hasOwnProperty.call(byName, path)) throw new Error('归档缺少媒体文件: ' + path);
      if (!/^\/image-artifacts\/img_[A-Za-z0-9._~-]+$/.test(String(metadata.artifactUri || ''))
          || !/^image\/[A-Za-z0-9.+-]+$/.test(String(metadata.mimeType || ''))
          || !/^[a-f0-9]{64}$/i.test(String(metadata.sha256 || ''))) {
        throw new Error('Artifact manifest 图片元数据无效: ' + path);
      }
      mediaBytes += byName[path].byteLength;
      if (mediaBytes > 256 * 1024 * 1024) throw new Error('归档图片总量超过 256 MiB 上限');
      importItems.push({
        metadata: metadata,
        dataUrl: await bytesAsDataUrl(byName[path], metadata.mimeType || 'application/octet-stream'),
      });
    }
    var imported = await sendMessage('IMPORT_CONVERSATION_BACKUP', {
      backup: { files: backupFiles },
      replace: false,
    });
    invalidateTopicTrajectory(targetTopicId);
    if (importItems.length) await imageArtifactClient.importTopic(targetTopicId, importItems);
    await refresh().catch(function () {});
    toast('完整 Journal 和 ' + manifestItems.length + ' 张图片已恢复');
    return imported;
  }

  function chooseConversationArchive() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.hidden = true;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) { input.remove(); return; }
      toast('正在校验并恢复对话归档…');
      importConversationArchiveFile(file).catch(function (error) {
        toast('恢复对话失败: ' + (error && error.message || error), true);
      }).finally(function () { input.remove(); });
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  }

  function sendMessage(type, payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: type, payload: payload }, function (resp) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.ok) {
          reject(new Error(resp && resp.error ? resp.error : '消息调用失败'));
          return;
        }
        resolve(resp.payload);
      });
    });
  }

  function sendConversationCommand(command, input) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({
        type: 'CONVERSATION_COMMAND',
        payload: { command: command, input: input || {} },
      }, function (response) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!response || response.ok !== true) {
          var detail = response && response.error || {};
          var error = new Error(detail.message || 'Conversation command failed');
          error.code = detail.code || 'INVALID_COMMAND';
          error.details = detail.details || {};
          reject(error);
          return;
        }
        resolve(response.result);
      });
    });
  }

  function topicIsRunning(topic) {
    if (!topic) return false;
    /* hydrateTopicFromJournal marks terminal generations with active=false.
       Prefer that durable fact over a stale denormalized status string from
       ConversationState, which otherwise keeps the topic in the running UI. */
    if (topic.active === false) return false;
    return ['starting', 'running', 'waiting_user', 'cancelling'].indexOf(String(topic.status || '')) !== -1;
  }

  function setTopicControlAccess(topicId, access) {
    topicId = String(topicId || '').trim();
    if (!topicId) return null;
    var normalized = Object.assign({
      topicId: topicId,
      control: 'other',
      running: true,
      canControl: false,
      ownedByOtherPage: true,
    }, access || {});
    topicControlAccessById[topicId] = normalized;
    return normalized;
  }

  function topicControlledElsewhere(topic) {
    return false;
  }

  function conversationSectionVisible() {
    var section = $('#section-conversation');
    return !!(section && section.classList.contains('active') && !document.hidden);
  }

  function stopReadonlySnapshotRefresh() {
    if (readonlySnapshotRefreshTimer) clearInterval(readonlySnapshotRefreshTimer);
    readonlySnapshotRefreshTimer = 0;
    readonlySnapshotRefreshTopicId = '';
    readonlySnapshotControlRevalidatePending = false;
    readonlySnapshotRefreshPending = false;
  }

  function syncReadonlySnapshotRefresh(topic, controlledElsewhere) {
    var topicId = String(topic && topic.topicId || '').trim();
    if (!topicIsRunning(topic) || !topicId || !conversationSectionVisible()) {
      stopReadonlySnapshotRefresh();
      return;
    }
    if (readonlySnapshotRefreshTimer && readonlySnapshotRefreshTopicId === topicId) return;
    stopReadonlySnapshotRefresh();
    readonlySnapshotRefreshTopicId = topicId;
    readonlySnapshotRefreshTimer = setInterval(function () {
      var current = displayedTopic();
      if (!conversationSectionVisible() || !current || current.topicId !== readonlySnapshotRefreshTopicId
          || !topicIsRunning(current)) {
        stopReadonlySnapshotRefresh();
        return;
      }
      if (readonlySnapshotRefreshPending || !state) return;
      readonlySnapshotRefreshPending = true;
      hydrateTopicFromJournal(state, readonlySnapshotRefreshTopicId).then(function () {
        var currentTopic = displayedTopic();
        if (currentTopic && String(currentTopic.topicId || '') === readonlySnapshotRefreshTopicId) {
          patchRuntimeConversationView(currentTopic);
        }
      }).catch(function () {}).finally(function () {
        readonlySnapshotRefreshPending = false;
      });
    }, READONLY_SNAPSHOT_REFRESH_MS);
  }

  function loadTopicControlAccess(topicId, force) {
    topicId = String(topicId || '').trim();
    var topic = state && state.topics && state.topics[topicId];
    if (!topicId || !topicIsRunning(topic)) {
      if (topicId) setTopicControlAccess(topicId, {
        control: 'available',
        running: false,
        canControl: true,
        ownedByOtherPage: false,
      });
      return Promise.resolve(topicControlAccessById[topicId] || null);
    }
    if (!force && topicControlAccessById[topicId]) return Promise.resolve(topicControlAccessById[topicId]);
    if (topicControlRequestById[topicId]) return topicControlRequestById[topicId];
    var request = sendConversationCommand('GET_CONVERSATION', { conversationId: topicId }).then(function (snapshot) {
      var active = snapshot && snapshot.activeGeneration;
      return setTopicControlAccess(topicId, {
        control: 'owner', running: !!(active && topicIsRunning({ status: active.state })),
        canControl: true, ownedByOtherPage: false,
      });
    }).catch(function (error) {
      if (error && error.code === 'CONVERSATION_NOT_FOUND') {
        return setTopicControlAccess(topicId, { control: 'available', running: false, canControl: true, ownedByOtherPage: false });
      }
      return setTopicControlAccess(topicId, { control: 'owner', running: topicIsRunning(topic), canControl: true, ownedByOtherPage: false });
    }).finally(function () {
      if (topicControlRequestById[topicId] === request) delete topicControlRequestById[topicId];
    });
    topicControlRequestById[topicId] = request;
    return request;
  }

  function syncDisplayedTopicControl(force) {
    var topic = displayedTopic();
    return loadTopicControlAccess(topic && topic.topicId || '', force).then(function () {
      return state;
    });
  }

  function parseJsonTextarea(selector) {
    var el = $(selector);
    var text = el ? String(el.value || '').trim() : '';
    if (!text) return {};
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('入参必须是 JSON 对象');
    return parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? parsed : { input: parsed };
  }

  function currentDraftKey(topic, assistant) {
    if (topic && topic.topicId) return topic.topicId;
    if (assistant && assistant.id) return 'assistant:' + assistant.id;
    return 'global';
  }

  function runInputTextForTopic(topic) {
    if (!topic || !topic.topicId) return '{}';
    if (Object.prototype.hasOwnProperty.call(runInputDrafts, topic.topicId)) return runInputDrafts[topic.topicId];
    return JSON.stringify(topic.runInputExample || {}, null, 2);
  }

  function isMacOs() {
    var operatingSystem = navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || '';
    return /mac|iphone|ipad|ipod/i.test(operatingSystem);
  }

  function sendShortcutLabel() {
    return isMacOs() ? 'Command+Enter' : 'Ctrl+Enter';
  }

  function anyConversationRunning() {
    if (!state) return false;
    var order = state.topicOrder || [];
    for (var i = 0; i < order.length; i++) {
      var topic = state.topics[order[i]];
      if (!topic || !topic.topicId) continue;
      if (topicIsRunning(topic)) return true;
    }
    return false;
  }

  function activeRuntimeTopicMap(snapshot) {
    var source = snapshot || state;
    var active = {};
    if (!source) return active;
    (source.topicOrder || []).forEach(function (topicId) {
      if (topicId && topicIsRunning(source.topics[topicId])) active[topicId] = true;
    });
    return active;
  }

  function startTurnWithProjection(input) {
    input = Object.assign({}, input || {});
    var topicId = input.topic && input.topic.topicId || '';
    if (topicId) incrementalConversationTopicById[topicId] = true;
    eventStreamForceFollowTopicId = topicId;
    var assistant = input.assistant || {};
    var serviceId = String(input.serviceId || '').trim();
    var service = modelServiceResourceById(serviceId) || {};
    var selection = input.selection || { kind: 'conversation', conversationId: topicId };
    var readableId = function (value) { return Array.from(String(value || '')).map(function (character) {
      return /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/.test(character)
        || (character.charCodeAt(0) > 0x7f && !/[\s\u0080-\u009f]/u.test(character))
        ? character : encodeURIComponent(character);
    }).join(''); };
    var currentResource = '/conversations/' + readableId(topicId);
    if (selection.kind === 'run' && selection.runId) currentResource = '/runs/' + readableId(selection.runId);
    else if (selection.kind === 'flow' && selection.flowId) currentResource = '/flows/' + readableId(String(selection.flowId).replace(/^user:/, ''));
    var commandId = 'command_' + (globalThis.crypto && crypto.randomUUID
      ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
    return sendConversationCommand('START_TURN', {
      schemaVersion: 1,
      commandId: commandId,
      conversationId: topicId,
      assistantId: assistant.id || '',
      serviceId: serviceId,
      message: { id: commandId + ':message', content: String(input.message || '').trim(), attachments: [] },
      entry: { type: 'conversation', currentResource: currentResource },
      budgets: {
        maxModelRequests: Math.max(1, Number(assistant.settings && assistant.settings.maxIterations) || 30),
        maxIterations: Math.max(1, Number(assistant.settings && assistant.settings.maxIterations) || 30),
        maxToolCalls: Math.max(0, Number(assistant.settings && assistant.settings.maxToolCalls) || 100),
        maxWallTimeMs: 15 * 60 * 1000,
        maxContextTokens: Math.max(1024, Number(service.maxContextTokens) || 1000000),
        maxOutputTokens: Math.max(1, Number(assistant.settings && assistant.settings.maxTokens) || 4096),
      },
      preferences: {
        streamOutput: assistant.settings && assistant.settings.streamOutput !== false,
        reasoningVisibility: assistant.settings && assistant.settings.reasoningVisibility === 'collapsed' ? 'collapsed' : 'expanded',
        contextCompression: assistant.settings && assistant.settings.contextCompression === 'off' ? 'off' : 'auto',
      },
      requestedAt: Date.now(),
    }).then(function (result) {
      setTopicControlAccess(topicId, {
        control: 'owner', running: true, canControl: true, ownedByOtherPage: false,
      });
      if (input.topic) {
        input.topic.runtimeGenerationId = result.generationId;
        input.topic.runtimeTurnId = result.turnId;
        input.topic.status = result.state;
        input.topic.active = true;
      }
      return Object.assign({ topicId: topicId, runId: 'conversation:' + topicId }, result);
    });
  }

  function applyConversationSettings(settings) {
    lastRenderKey = '';
    if (state) renderLoaded();
    return settings;
  }

  function trajectoryEventTime(value) {
    var number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
    var parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function trajectoryEventSource(record, payload) {
    var explicit = String(payload && payload.source || '').trim();
    if (explicit) return explicit;
    if (String(record && (record.subagentId || payload && payload.subagentId) || '').trim()) return 'subagent';
    if (String(record && record.actorType || '').trim() === 'subagent') return 'subagent';
    var type = String(record && record.type || '');
    if (type.indexOf('provider_') === 0) return 'provider';
    if (type.indexOf('model_') === 0 || type.indexOf('reasoning_') === 0) return 'model';
    if (type.indexOf('tool_') === 0) return 'tool';
    if (type.indexOf('context_') === 0 || type.indexOf('summary_') === 0) return 'context-builder';
    if (type.indexOf('interaction_') === 0 || type.indexOf('user_') === 0) return 'user';
    return 'runtime';
  }

  function adaptTrajectoryEvent(record) {
    record = record && typeof record === 'object' ? record : {};
    var type = String(record.type || '');
    /* Native Journal records use payload/sequence/at.  Harness session events
       use data/seq/time.  Normalize both at this boundary so the cell fold
       remains format-agnostic. */
    var eventPayload = record.payload && typeof record.payload === 'object' ? record.payload
      : record.data && typeof record.data === 'object' ? record.data : {};
    var sequence = Number(record.sequence !== undefined ? record.sequence : record.seq) || 0;
    var displaySequence = type === 'steering_message_consumed'
      ? Number(eventPayload.sourceSequence) || sequence : sequence;
    var eventAt = trajectoryEventTime(record.at || record.time || record.timestamp || sequence);
    var eventId = String(record.eventId || record.id || sequence || '');
    var eventError = record.error || eventPayload.error;
    var conversationId = record.conversationId || record.sessionId || '';
    var generationId = record.generationId || eventPayload.generationId || '';
    var turnId = record.turnId || eventPayload.turnId || eventPayload.turn || record.turn || generationId;
    var messageSource = eventPayload.message && eventPayload.message.source
      && typeof eventPayload.message.source === 'object' ? eventPayload.message.source : {};
    return {
      sequence: Math.max(0, displaySequence),
      conversationId: String(conversationId),
      eventType: type,
      source: trajectoryEventSource(record, eventPayload),
      eventId: eventId,
      branchId: String(record.branchId || ''),
      generationId: String(generationId),
      actorId: String(record.actorId || eventPayload.actorId || ''),
      actorType: String(record.actorType || eventPayload.actorType || ''),
      subagentId: String(record.subagentId || eventPayload.subagentId || ''),
      parentEventId: String(record.parentEventId || ''),
      causationId: String(record.causationId || ''),
      correlationId: String(record.correlationId || ''),
      toolCallId: String(record.toolCallId || eventPayload.toolCallId || eventPayload.callId
        || eventPayload.call_id || eventPayload.tool_call_id || eventPayload.subCallId
        || eventPayload.sub_call_id || eventPayload.call && (eventPayload.call.callId || eventPayload.call.id)
        || eventPayload.message && eventPayload.message.source && eventPayload.message.source.callId || ''),
      parentCallId: String(record.parentCallId || eventPayload.parentCallId || eventPayload.parent_call_id || ''),
      rootCallId: String(record.rootCallId || eventPayload.rootCallId || eventPayload.root_call_id || ''),
      subCallId: String(record.subCallId || eventPayload.subCallId || eventPayload.sub_call_id || ''),
      modelRequestId: String(record.modelRequestId || eventPayload.modelRequestId
        || eventPayload.requestId || messageSource.modelRequestId || messageSource.requestId || ''),
      parentTurnId: String(turnId),
      step: Math.max(0, Number(record.step !== undefined ? record.step : eventPayload.step) || 0),
      at: eventAt,
      model: String(eventPayload.model || eventPayload.request && eventPayload.request.model || messageSource.model || ''),
      provider: String(eventPayload.provider || eventPayload.request && eventPayload.request.provider || messageSource.provider || ''),
      durationMs: Math.max(0, Number(eventPayload.durationMs) || 0),
      error: eventError ? String(eventError.message || eventError) : '',
      payload: eventPayload,
    };
  }

  function invalidateTopicTrajectory(topicId) {
    topicId = String(topicId || '').trim();
    if (!topicId) return;
    delete trajectoryEventsByTopic[topicId];
    delete trajectoryItemsByTopic[topicId];
    delete trajectoryPageByTopic[topicId];
    delete conversationEventsCompleteByTopic[topicId];
    delete rawConversationEventsByTopic[topicId];
    delete incrementalConversationTopicById[topicId];
  }

  function loadConversationEventsForTopic(topicId) {
    topicId = String(topicId || '').trim();
    var existingRaw = Array.isArray(rawConversationEventsByTopic[topicId])
      ? rawConversationEventsByTopic[topicId].slice() : [];
    var initialized = Object.prototype.hasOwnProperty.call(rawConversationEventsByTopic, topicId);
    var complete = conversationEventsCompleteByTopic[topicId] === true;
    if (!initialized) {
      return sendConversationCommand('GET_EVENTS', {
        conversationId: topicId,
        limit: conversationListView.DEFAULT_PAGE_SIZE,
        includePayloads: true,
      }).then(function (page) {
        var events = Array.isArray(page && page.events) ? page.events.slice() : [];
        rawConversationEventsByTopic[topicId] = events;
        conversationEventsCompleteByTopic[topicId] = !(page && page.hasMoreBefore);
        return {
          events: events,
          total: Number(page && page.total) || events.length,
          hasMoreBefore: !!(page && page.hasMoreBefore),
          hasMoreAfter: false,
          cursors: page && page.cursors || {
            beforeSequence: events.length ? Number(events[0].sequence) || null : null,
            afterSequence: events.length ? Number(events[events.length - 1].sequence) || null : null,
          },
          streamBuffers: page && page.streamBuffers || [],
        };
      });
    }
    var lastSequence = existingRaw.reduce(function (latest, event) {
      return Math.max(latest, Number(event && (event.sequence || event.order)) || 0);
    }, 0);
    return sendConversationCommand('GET_EVENTS', {
      conversationId: topicId,
      cursor: { afterSequence: lastSequence },
      limit: conversationListView.DEFAULT_PAGE_SIZE,
      includePayloads: true,
    }).then(function (page) {
      var events = page && Array.isArray(page.events) ? page.events : [];
      var merged = conversationListView.mergeJournalPages(existingRaw, events);
      rawConversationEventsByTopic[topicId] = merged;
      if (page && page.hasMoreAfter) scheduleJournalRefresh(topicId);
      return {
        events: merged,
        total: Math.max(merged.length, Number(page && page.total) || 0),
        hasMoreBefore: !complete,
        hasMoreAfter: !!(page && page.hasMoreAfter),
        cursors: {
          beforeSequence: merged.length ? Number(merged[0].sequence || merged[0].order) || null : null,
          afterSequence: merged.length ? Number(merged[merged.length - 1].sequence || merged[merged.length - 1].order) || null : null,
        },
        streamBuffers: page && page.streamBuffers || [],
      };
    });
  }

  function loadAllTrajectoryEvents(topicId, afterSequence) {
    var allEvents = [];
    var total = 0;
    function loadNext(cursor) {
      return sendConversationCommand('GET_EVENTS', {
        conversationId: topicId,
        cursor: { afterSequence: cursor },
        limit: 500,
        includePayloads: true,
      }).then(function (page) {
        var events = page && Array.isArray(page.events) ? page.events : [];
        allEvents = conversationListView.mergeJournalPages(allEvents, events);
        total = Math.max(total, Number(page && page.total) || 0, allEvents.length);
        var nextCursor = events.length
          ? Number(events[events.length - 1].sequence) || cursor
          : cursor;
        if (page && page.hasMoreAfter && nextCursor > cursor) return loadNext(nextCursor);
        return { events: allEvents, total: total };
      });
    }
    return loadNext(Math.max(0, Number(afterSequence) || 0));
  }

  function loadTopicTrajectory(topicId, force) {
    topicId = String(topicId || '').trim();
    if (!topicId) return Promise.resolve([]);
    var cachedItems = trajectoryItemsByTopic[topicId];
    if (!force && Object.prototype.hasOwnProperty.call(trajectoryItemsByTopic, topicId)) {
      return Promise.resolve(trajectoryItemsByTopic[topicId]);
    }
    var pending = trajectoryRequestByTopic[topicId];
    if (pending) return pending.promise;
    var request = loadAllTrajectoryEvents(topicId, 0).then(function (result) {
      var allEvents = result && Array.isArray(result.events) ? result.events : [];
      allEvents.sort(function (a, b) { return Number(a && a.sequence || 0) - Number(b && b.sequence || 0); });
      var records = projectTrajectoryCells(allEvents.map(adaptTrajectoryEvent));
      var firstSequence = allEvents.length ? Number(allEvents[0].sequence) || 0 : 0;
      var lastSequence = allEvents.length ? Number(allEvents[allEvents.length - 1].sequence) || 0 : 0;
      trajectoryEventsByTopic[topicId] = allEvents;
      trajectoryItemsByTopic[topicId] = records;
      trajectoryPageByTopic[topicId] = {
        start: firstSequence,
        end: lastSequence,
        total: Math.max(0, Number(result && result.total) || allEvents.length),
        pageSize: Math.max(1, allEvents.length),
        hasOlder: false,
        hasNewer: false,
      };
      return records;
    }).catch(function (error) {
      if (error && error.code === 'CONVERSATION_NOT_FOUND') {
        trajectoryEventsByTopic[topicId] = [];
        trajectoryItemsByTopic[topicId] = [];
        trajectoryPageByTopic[topicId] = { start: 0, end: 0, total: 0, pageSize: 1 };
        return [];
      }
      throw error;
    }).finally(function () {
      if (trajectoryRequestByTopic[topicId] && trajectoryRequestByTopic[topicId].promise === request) {
        delete trajectoryRequestByTopic[topicId];
      }
    });
    trajectoryRequestByTopic[topicId] = { start: 0, promise: request };
    return request;
  }

  /* Incremental refresh starts after the newest loaded Journal sequence, then
     folds the complete event set again so lifecycle cells stay coherent. */
  function loadLatestTopicTrajectory(topicId, force) {
    topicId = String(topicId || '').trim();
    if (!topicId) return Promise.resolve([]);
    var knownPage = trajectoryPageByTopic[topicId];
    if (!force || !knownPage) {
      return loadTopicTrajectory(topicId, force);
    }
    var pending = trajectoryRequestByTopic[topicId];
    if (pending) return pending.promise.catch(function () {}).then(function () { return loadLatestTopicTrajectory(topicId, force); });
    var cachedEvents = trajectoryEventsByTopic[topicId] || [];
    var lastSequence = cachedEvents.reduce(function (latest, event) {
      return Math.max(latest, Number(event && event.sequence) || 0);
    }, 0);
    var request = loadAllTrajectoryEvents(topicId, lastSequence).then(function (pageResult) {
      var events = pageResult && Array.isArray(pageResult.events) ? pageResult.events : [];
      events.sort(function (a, b) { return Number(a && a.sequence || 0) - Number(b && b.sequence || 0); });
      var bySequence = Object.create(null);
      cachedEvents.concat(events).forEach(function (event) {
        var sequence = Number(event && event.sequence) || 0;
        if (sequence > 0) bySequence[sequence] = event;
      });
      var mergedEvents = Object.keys(bySequence).map(function (sequence) { return bySequence[sequence]; });
      mergedEvents.sort(function (a, b) { return Number(a && a.sequence || 0) - Number(b && b.sequence || 0); });
      var cells = projectTrajectoryCells(mergedEvents.map(adaptTrajectoryEvent));
      var total = Math.max(Number(knownPage.total) || 0, Number(pageResult && pageResult.total) || 0, lastSequence + events.length);
      var records = cells;
      var start = mergedEvents.length ? Number(mergedEvents[0].sequence) || 0 : 0;
      var end = mergedEvents.length ? Number(mergedEvents[mergedEvents.length - 1].sequence) || 0 : 0;
      trajectoryEventsByTopic[topicId] = mergedEvents;
      trajectoryItemsByTopic[topicId] = records;
      trajectoryPageByTopic[topicId] = {
        start: start, end: end, total: Math.max(total, end),
        pageSize: Math.max(1, mergedEvents.length),
        hasOlder: false,
        hasNewer: false,
      };
      return records;
    }).catch(function (error) {
      if (error && error.code === 'CONVERSATION_NOT_FOUND') {
        trajectoryEventsByTopic[topicId] = [];
        trajectoryItemsByTopic[topicId] = [];
        trajectoryPageByTopic[topicId] = { start: 0, end: 0, total: 0, pageSize: 1 };
        return [];
      }
      throw error;
    }).finally(function () {
      if (trajectoryRequestByTopic[topicId] && trajectoryRequestByTopic[topicId].promise === request) delete trajectoryRequestByTopic[topicId];
    });
    trajectoryRequestByTopic[topicId] = { start: Number.MAX_SAFE_INTEGER, promise: request };
    return request;
  }

  function trajectoryTablePane() {
    return document.querySelector('#trajectory-view-content .conversation-trace-table-wrap');
  }

  function trajectoryPaneAtTail(pane) {
    return !pane || pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 2;
  }

  function trajectoryVirtualRowHeight(row) {
    return 30;
  }

  function applyTrajectoryVirtualization(content) {
    var pane = content && content.querySelector('.conversation-trace-table-wrap');
    var tbody = content && content.querySelector('.conversation-trace-turns');
    if (!pane || !tbody) return;
    var rows = Array.prototype.slice.call(tbody.children || []).filter(function (row) {
      return row && String(row.tagName || '').toLowerCase() === 'tr'
        && !row.classList.contains('conversation-trace-virtual-spacer');
    });
    var topic = displayedTopic();
    var topicId = String(topic && topic.topicId || '');
    var alreadyVirtual = !!tbody.querySelector('.conversation-trace-virtual-spacer');
    var previous = trajectoryVirtualState && trajectoryVirtualState.topicId === topicId
      ? trajectoryVirtualState : null;
    if (!alreadyVirtual && rows.length <= 100) {
      trajectoryVirtualState = null;
      return;
    }
    var entries = alreadyVirtual && previous ? previous.entries : rows.map(function (row, index) {
      var measured = Number(row.getBoundingClientRect && row.getBoundingClientRect().height) || 0;
      return {
        key: String(row.dataset && row.dataset.cellId || row.dataset && row.dataset.turnId || 'row:' + index) + ':' + index,
        html: row.outerHTML,
        height: measured > 0 ? measured : trajectoryVirtualRowHeight(row),
      };
    });
    var offsets = [0];
    entries.forEach(function (entry) { offsets.push(offsets[offsets.length - 1] + entry.height); });
    var totalHeight = offsets[offsets.length - 1];
    var viewport = Math.max(240, Number(pane.clientHeight) || 600);
    var scrollTop = Number(pane.scrollTop) || 0;
    var start = Math.max(0, Math.floor(scrollTop / 30) - 16);
    while (start > 0 && offsets[start] > scrollTop - viewport) start -= 1;
    var end = Math.min(entries.length, start + Math.ceil(viewport / 30) + 32);
    while (end < entries.length && offsets[end] < scrollTop + viewport * 1.5) end += 1;
    trajectoryVirtualState = {
      topicId: topicId, entries: entries, offsets: offsets, totalHeight: totalHeight,
      start: start, end: end,
    };
    var visible = entries.slice(start, end).map(function (entry) { return entry.html; }).join('');
    var topHeight = offsets[start];
    var bottomHeight = Math.max(0, totalHeight - offsets[end]);
    tbody.innerHTML = '<tr class="conversation-trace-virtual-spacer" aria-hidden="true"><td colspan="2" style="height:'
      + esc(topHeight) + 'px;padding:0;border:0"></td></tr>' + visible
      + '<tr class="conversation-trace-virtual-spacer" aria-hidden="true"><td colspan="2" style="height:'
      + esc(bottomHeight) + 'px;padding:0;border:0"></td></tr>';
    tbody.dataset.virtualStart = String(start);
    tbody.dataset.virtualEnd = String(end);
    if (previous && previous.start !== start && previous.end !== end) {
      pane.scrollTop = scrollTop;
    }
  }

  function refreshTrajectoryVirtualization() {
    if (!trajectoryViewOpen) return;
    var content = document.querySelector('#trajectory-view-content');
    if (!content) return;
    applyTrajectoryVirtualization(content);
    hydrateConversationImages(content.querySelector('.conversation-trace-turns'));
  }

  function scheduleTrajectoryVirtualization() {
    if (trajectoryVirtualFrame) return;
    var run = function () {
      trajectoryVirtualFrame = 0;
      refreshTrajectoryVirtualization();
    };
    trajectoryVirtualFrame = window.requestAnimationFrame
      ? window.requestAnimationFrame(run) : setTimeout(run, 0);
  }

  function positionTrajectoryAtTail(topicId) {
    trajectoryScrollTopicId = String(topicId || '');
    trajectoryFollowsTail = true;
    var position = function () {
      var pane = trajectoryTablePane();
      var topic = displayedTopic();
      if (!pane || !topic || String(topic.topicId || '') !== trajectoryScrollTopicId) return;
      pane.scrollTop = pane.scrollHeight;
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(position);
    else setTimeout(position, 0);
  }

  function loadSystemSettings() {
    if (!globalThis.PageAutomationSystemSettings) {
      return Promise.resolve(applyConversationSettings({}));
    }
    return globalThis.PageAutomationSystemSettings.load(chrome.storage && chrome.storage.local, chrome.runtime)
      .then(applyConversationSettings);
  }

  function modelServiceResourceById(serviceId) {
    serviceId = String(serviceId || '').trim();
    return (modelServiceResources || []).filter(function (service) {
      return service && service.id === serviceId;
    })[0] || null;
  }

  function defaultModelServiceId(assistant) {
    return String(assistant && assistant.modelServiceId
      || agentSettingsResource && agentSettingsResource.defaultModelServiceId || '').trim();
  }

  function currentConversationServiceId(topic) {
    return String(topic && topic.modelServiceId || newTopicModelServiceId
      || defaultModelServiceId(topic ? assistantForTopicRun(topic, selectedAssistant()) : selectedAssistant()) || '').trim();
  }

  function renderContextGovernanceStatus() {
    var title = '完整事实保留在 Journal；ContextBuilder 在每次模型请求前重新预算并按需推进 SummaryCheckpoint';
    return '<span class="conversation-chat-log-btn conversation-context-governance-status" title="' + esc(title) + '">自动摘要</span>';
  }

  function renderGeneratorServiceSelect(disabled, topic) {
    var selectedId = currentConversationServiceId(topic);
    var traceTopicId = String(topic && topic.topicId || '');
    var traceKnown = Object.prototype.hasOwnProperty.call(trajectoryEventsByTopic, traceTopicId);
    var traceAvailable = !!(topic && topicTrajectoryItems(topic).length);
    var traceButton = topic && topic.topicId
      ? '<button class="conversation-chat-log-btn" data-conversation-action="open-topic-trajectory" title="'
        + esc(traceAvailable ? '查看完整运行轨迹'
          : (traceKnown ? '当前话题暂无已提交轨迹，点击后重新读取' : '读取当前话题的运行轨迹'))
        + '">轨迹</button>'
      : '';
    var services = modelServiceResources || [];
    var options = services.map(function (service) {
      var label = String(service.name || service.id || '模型服务');
      if (service.model) label += ' · ' + service.model;
      if (service.id === String(agentSettingsResource && agentSettingsResource.defaultModelServiceId || '')) label += '（Agent 默认）';
      return '<option value="' + esc(service.id) + '"' + (service.id === selectedId ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
    if (selectedId && !modelServiceResourceById(selectedId)) {
      options = '<option value="' + esc(selectedId) + '" selected>不可用的模型服务 · ' + esc(selectedId) + '</option>' + options;
    }
    if (!options) options = '<option value="">未配置模型服务</option>';
    return '<div class="conversation-composer-service-row">'
      + '<label class="conversation-composer-service-label" title="' + (disabled ? '对话运行中不可切换服务' : '切换对话服务') + '">'
      + '<select id="conversation-service" aria-label="模型服务" title="' + (disabled ? '对话运行中不可切换服务' : '切换对话服务') + '" ' + (disabled ? 'disabled' : '') + '>' + options + '</select>'
      + '</label>'
      + traceButton
      + renderContextGovernanceStatus()
      + '</div>';
  }

  function topicTrajectoryItems(topic) {
    if (!topic) return [];
    var items = trajectoryItemsByTopic[String(topic.topicId || '')];
    return Array.isArray(items) ? items.slice() : [];
  }

  function topicTrajectoryPage(topic) {
    var topicId = String(topic && topic.topicId || '');
    var records = trajectoryItemsByTopic[topicId] || [];
    var page = trajectoryPageByTopic[topicId] || {};
    var start = Math.max(0, Number(page.start) || 0);
    var end = Math.max(start, Number(page.end) || start + records.length);
    var total = Object.prototype.hasOwnProperty.call(page, 'total')
      ? Math.max(0, Number(page.total) || 0)
      : Math.max(end, records.length);
    return {
      start: start,
      end: end,
      total: total,
      pageSize: Math.max(1, Number(page.pageSize) || Math.max(1, total || 1)),
      hasOlder: page.hasOlder === true,
    };
  }

  function trajectoryLoadingHtml() {
    return '<div class="conversation-llm-log"><div class="conversation-llm-log-meta"><b>…</b><span>正在加载运行轨迹…</span></div></div>';
  }

  function topicTrajectoryIsLoading(topic) {
    var topicId = String(topic && topic.topicId || '');
    return !!(topicId && trajectoryRequestByTopic[topicId]);
  }

  function trajectoryContentText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(trajectoryContentText).filter(Boolean).join('\n\n');
    if (typeof value !== 'object') return '';
    var nested = value.text !== undefined ? value.text
      : value.content !== undefined ? value.content
        : value.output_text !== undefined ? value.output_text
          : value.input_text !== undefined ? value.input_text
            : value.summary !== undefined ? value.summary
              : value.reasoning !== undefined ? value.reasoning
                : value.thinking !== undefined ? value.thinking
                  : value.message !== undefined ? value.message
                    : value.answer !== undefined ? value.answer
                      : value.prompt !== undefined ? value.prompt : '';
    return trajectoryContentText(nested);
  }

  function trajectoryAssistantText(value) {
    if (!Array.isArray(value)) return trajectoryContentText(value);
    return value.filter(function (part) {
      return !(part && typeof part === 'object'
        && /^(?:reasoning|thinking|thought|tool[_-]?call|tool[_-]?use)$/i.test(String(part.type || '')));
    }).map(trajectoryContentText).filter(Boolean).join('\n\n');
  }

  function trajectorySourceBlocks(value, fallbackType) {
    var list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return list.map(function (part) {
      if (typeof part === 'string') return { type: fallbackType || 'text', content: part };
      if (!part || typeof part !== 'object') return null;
      var type = String(part.type || fallbackType || 'text');
      var artifactUri = String(part.artifactUri || part.attachment && part.attachment.artifactUri || '');
      if (type === 'image' && artifactUri) {
        return {
          type: 'image', content: '',
          attachment: Object.assign({}, part.attachment || part, { artifactUri: artifactUri }),
        };
      }
      var blockArguments = part.arguments !== undefined ? part.arguments
        : part.args !== undefined ? part.args : undefined;
      return {
        type: type,
        content: trajectoryContentText(part) || (blockArguments === undefined ? ''
          : typeof blockArguments === 'string' ? blockArguments : trajectoryJson(blockArguments)),
        callId: String(part.callId || part.toolCallId || part.id || ''),
        toolName: String(part.name || part.toolName || ''),
      };
    }).filter(Boolean);
  }

  function trajectoryBlocksWithAttachments(content, attachments) {
    var blocks = trajectorySourceBlocks(content, 'text');
    (Array.isArray(attachments) ? attachments : []).forEach(function (attachment) {
      if (!attachment || !attachment.artifactUri) return;
      blocks.push({ type: 'image', content: '', attachment: attachment });
    });
    return blocks;
  }

  function trajectoryPreview(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    return text.length > 280 ? text.slice(0, 280) + '…' : text;
  }

  function trajectoryRoleText(messages, roles) {
    if (!Array.isArray(messages)) return '';
    return messages.filter(function (message) {
      return message && roles.indexOf(String(message.role || '').toLowerCase()) !== -1;
    }).map(function (message) {
      return trajectoryContentText(message.content !== undefined ? message.content : message.parts);
    }).filter(Boolean).join('\n\n');
  }

  /* Harness exposes context provenance as a stable role and producer label. */
  function trajectoryContextProvenance(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return { role: 'inject', label: '' };
    var kind = String(source.kind || '').trim();
    if (kind === 'session-reference') {
      var references = Array.isArray(source.references) ? source.references : [];
      var labels = references.map(function (reference) {
        return reference && String(reference.label || '').trim();
      }).filter(Boolean);
      return { role: 'recall', label: labels.join(', ') || kind };
    }
    if (kind === 'agent-instructions') {
      var changes = Array.isArray(source.changes) ? source.changes : [];
      var paths = changes.map(function (change) {
        return change && String(change.path || '').trim();
      }).filter(Boolean);
      return { role: 'inject', label: paths.join(', ') || kind };
    }
    if (kind === 'plugin') return { role: 'inject', label: String(source.plugin || kind) };
    if (kind === 'skill-invocation') return { role: 'inject', label: String(source.name || kind) };
    return { role: 'inject', label: kind };
  }

  function trajectoryJson(value) {
    try { return JSON.stringify(value === undefined ? null : value, null, 2); }
    catch (_) { return String(value); }
  }

  function trajectoryPromptDiffHtml(previous, current) {
    var beforeLines = trajectoryJson(previous || {}).split('\n');
    var afterLines = trajectoryJson(current || {}).split('\n');
    if (beforeLines.join('\n') === afterLines.join('\n')) return '<span class="conversation-trace-empty">没有变化</span>';
    var context = 3;
    var prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
    var suffix = 0;
    while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
        && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix += 1;
    var beforeChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
    var afterChanged = afterLines.slice(prefix, afterLines.length - suffix);
    var entries = [];
    beforeLines.slice(Math.max(0, prefix - context), prefix).forEach(function (line) {
      entries.push({ kind: 'context', text: line });
    });
    beforeChanged.forEach(function (line) { entries.push({ kind: 'removed', text: line }); });
    afterChanged.forEach(function (line) { entries.push({ kind: 'added', text: line }); });
    if (suffix) afterLines.slice(afterLines.length - suffix, afterLines.length - suffix + context).forEach(function (line) {
      entries.push({ kind: 'context', text: line });
    });
    return '<div class="conversation-trajectory-diff" role="list">' + entries.map(function (entry) {
      var mark = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '-' : ' ';
      return '<div class="' + entry.kind + '" role="listitem"><span aria-hidden="true">' + mark
        + '</span><code>' + esc(entry.text) + '</code></div>';
    }).join('') + '</div>';
  }

  function trajectoryUsage(payload) {
    var usage = payload && (payload.usage || payload.metrics || payload.tokenUsage);
    if (!usage || typeof usage !== 'object') return null;
    var provided = false;
    function number(keys) {
      for (var i = 0; i < keys.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(usage, keys[i])) continue;
        var value = Number(usage[keys[i]]);
        if (Number.isFinite(value) && value >= 0) {
          provided = true;
          return Math.round(value);
        }
      }
      return 0;
    }
    var input = number(['input_tokens', 'prompt_tokens', 'inputTokens']);
    var cacheRead = number(['cache_read_tokens', 'cacheReadTokens']);
    var cacheWrite = number(['cache_write_tokens', 'cacheWriteTokens']);
    var output = number(['output_tokens', 'completion_tokens', 'outputTokens']);
    var reasoning = number(['reasoning_tokens', 'reasoningTokens', 'think']);
    return provided
      ? { input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output, reasoning: reasoning }
      : null;
  }

  function trajectoryStatus(eventType, event) {
    var type = String(eventType || '').toLowerCase();
    if (event && event.error || /failed|error|unknown|interrupted|expired/.test(type)) return 'failed';
    if (/cancelled|canceled/.test(type)) return 'cancelled';
    if (/truncated/.test(type)) return 'truncated';
    if (/blocked/.test(type)) return 'blocked';
    if (/started|requested|planned|streaming|waiting|pending|stream_delta|tool\/call|code[_-]dispatch[-_]start|tool\/code-dispatch-start/.test(type)) return 'running';
    return 'completed';
  }

  /* Providers and older Journal migrations use several spellings for the same
     tool call fields. Keep the projection tolerant at this boundary. */
  function trajectoryCallId(value, fallback) {
    if (!value || typeof value !== 'object') return String(fallback || '');
    var fn = value.function && typeof value.function === 'object' ? value.function : {};
    var call = value.call && typeof value.call === 'object' ? value.call : {};
    var callFn = call.function && typeof call.function === 'object' ? call.function : {};
    var source = value.message && value.message.source && typeof value.message.source === 'object'
      ? value.message.source : {};
    return String(value.id || value.toolCallId || value.callId || value.call_id
      || value.tool_call_id || fn.id || fn.toolCallId || fn.callId || fn.call_id
      || fn.tool_call_id || call.id || call.callId || call.toolCallId || call.call_id
      || call.function && (call.function.id || call.function.callId || call.function.call_id)
      || source.callId || fallback || '');
  }

  function trajectoryCallArguments(value) {
    if (!value || typeof value !== 'object') return undefined;
    var fn = value.function && typeof value.function === 'object' ? value.function : {};
    var call = value.call && typeof value.call === 'object' ? value.call : {};
    var callFn = call.function && typeof call.function === 'object' ? call.function : {};
    var args = value.arguments !== undefined ? value.arguments
      : value.args !== undefined ? value.args
        : value.input !== undefined ? value.input
          : value.parameters !== undefined ? value.parameters
            : fn.arguments !== undefined ? fn.arguments
                : fn.args !== undefined ? fn.args
                  : call.arguments !== undefined ? call.arguments
                  : call.args !== undefined ? call.args
                    : callFn.arguments !== undefined ? callFn.arguments
                      : callFn.args !== undefined ? callFn.args : undefined;
    if (typeof args !== 'string') return args;
    var trimmed = args.trim();
    if (!trimmed) return args;
    try { return JSON.parse(trimmed); } catch (_) { return args; }
  }

  function trajectoryPayloadHasError(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.error || payload.isError === true) return true;
    var message = payload.message && typeof payload.message === 'object' ? payload.message : null;
    var content = message && Array.isArray(message.content) ? message.content : [];
    return content.some(function (part) { return part && typeof part === 'object' && part.isError === true; });
  }

  function projectTrajectoryCells(events) {
    events = (Array.isArray(events) ? events : []).slice().sort(function (left, right) {
      return Number(left && left.sequence || 0) - Number(right && right.sequence || 0);
    });
    var cells = [];
    var byCall = Object.create(null);
    var turnByKey = Object.create(null);
    var terminalByCall = Object.create(null);
    var terminalRequestById = Object.create(null);
    var terminalGenerationById = Object.create(null);
    var terminalGenerationBoundaryById = Object.create(null);
    var plannedByRequest = Object.create(null);
    var toolsByRequest = Object.create(null);
    var requestById = Object.create(null);
    var compactedByRequest = Object.create(null);
    var lastPromptSignature = '';
    var lastPromptSnapshot = null;
    var lastPromptCell = null;
    (Array.isArray(events) ? events : []).forEach(function (event) {
      var type = String(event && event.eventType || '').toLowerCase();
      var requestId = String(event && event.modelRequestId || '');
      var payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
      var generationId = String(event && event.generationId || '');
      var request = payload.request && typeof payload.request === 'object' ? payload.request : payload;
      if (requestId && Array.isArray(request.tools)) toolsByRequest[requestId] = request.tools;
      if (requestId) {
        var requestInfo = requestById[requestId] || (requestById[requestId] = {
          requestId: requestId, startSequence: Number(event.sequence) || 0,
          generationId: generationId,
          startedAt: null, completedAt: null, status: 'running',
        });
        if (!requestInfo.generationId && generationId) requestInfo.generationId = generationId;
        requestInfo.startSequence = Math.min(requestInfo.startSequence || Number(event.sequence) || 0,
          Number(event.sequence) || requestInfo.startSequence || 0);
        if (type === 'model_request_started') {
          requestInfo.startedAt = trajectoryEventTime(payload.startedAt) || event.at || requestInfo.startedAt;
          requestInfo.provider = String(payload.provider || requestInfo.provider || '');
          requestInfo.model = String(payload.model || request.model || requestInfo.model || '');
          requestInfo.attempt = Math.max(1, Number(payload.attempt) || 1);
          requestInfo.maxRetries = payload.maxRetries !== undefined ? Math.max(0, Number(payload.maxRetries) || 0)
            : request.maxRetries !== undefined ? Math.max(0, Number(request.maxRetries) || 0)
              : payload.maxAttempts !== undefined ? Math.max(0, Number(payload.maxAttempts) - 1 || 0) : requestInfo.maxRetries;
          requestInfo.config = Object.assign({}, requestInfo.config || {}, request);
        } else if (type === 'context_injected') {
          requestInfo.config = Object.assign({}, requestInfo.config || {}, {
            purpose: payload.purpose,
            system: payload.system,
            messages: payload.messages,
            tools: payload.tools,
            runtimeContext: payload.runtimeContext,
            contextAppendMessages: payload.contextAppendMessages,
            promptState: payload.promptState,
          });
        } else if (type === 'provider_request_started' || type === 'provider_response_completed'
            || type === 'provider_response_failed') {
          requestInfo.provider = String(payload.provider || payload.apiStyle || requestInfo.provider || '');
          requestInfo.model = String(payload.model || requestInfo.model || '');
          requestInfo.provenance = {
            provider: requestInfo.provider,
            model: requestInfo.model,
          };
          if (payload.attempt !== undefined) requestInfo.attempt = Math.max(1, Number(payload.attempt) || 1);
          if (payload.maxAttempts !== undefined) requestInfo.maxRetries = Math.max(0, Number(payload.maxAttempts) - 1 || 0);
        } else if (type === 'model_stream_delta' && !requestInfo.firstTokenTime) {
          requestInfo.firstTokenTime = event.at || null;
        }
        if (/^(?:model_response_completed|model_request_failed|model_request_interrupted)$/.test(type)) {
          requestInfo.completedAt = event.at || requestInfo.completedAt;
          requestInfo.status = trajectoryStatus(type, event);
          requestInfo.usage = trajectoryUsage(payload) || requestInfo.usage;
          requestInfo.error = event.error || String(payload.error || '');
          requestInfo.errorCode = String(payload.errorCode || payload.error && (payload.error.code || payload.error.errorCode) || requestInfo.errorCode || '');
          if (payload.retry !== undefined) requestInfo.retry = Number(payload.retry) || 0;
          if (payload.maxRetries !== undefined) requestInfo.maxRetries = Math.max(0, Number(payload.maxRetries) || 0);
          if (payload.retryDelayMs !== undefined) requestInfo.retryDelayMs = Math.max(0, Number(payload.retryDelayMs) || 0);
        }
      }
      if (generationId && /^generation_(?:completed|failed|cancelled|truncated|blocked)$/.test(type)) {
        terminalGenerationById[generationId] = ({
          generation_completed: 'completed',
          generation_failed: 'failed',
          generation_cancelled: 'cancelled',
          generation_truncated: 'truncated',
          generation_blocked: 'blocked',
        })[type] || 'failed';
        terminalGenerationBoundaryById[generationId] = event.at || null;
      }
      if (requestId && /^(?:model_response_completed|model_request_failed|model_request_interrupted|summary_committed|summary_failed)$/.test(type)) {
        terminalRequestById[requestId] = trajectoryStatus(type, event);
      }
      var callId = String(event && (event.toolCallId || trajectoryCallId(payload)) || '');
      if (callId && /^(?:tool_execution_completed|tool_execution_failed|tool_execution_unknown|tool_call_(?:completed|failed|result|deferred)|tool_call_deferred|tool_code_dispatch|tool\/code-dispatch|tool\/result)$/.test(type)) {
        terminalByCall[callId] = /failed|unknown|deferred/.test(type) || trajectoryPayloadHasError(payload)
          ? 'failed' : 'completed';
      }
      if ((type === 'tool_call_planned' || type === 'tool/call') && callId) {
        var plans = plannedByRequest[requestId] || (plannedByRequest[requestId] = []);
        plans.push(callId);
      }
    });
    Object.keys(requestById).forEach(function (requestId) {
      var requestInfo = requestById[requestId];
      var terminal = terminalGenerationById[String(requestInfo.generationId || '')];
      if (!terminal || requestInfo.status !== 'running') return;
      requestInfo.status = terminal;
      requestInfo.completedAt = terminalGenerationBoundaryById[String(requestInfo.generationId || '')]
        || requestInfo.completedAt;
    });
    var cumulativeUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    var cumulativeUsageProvided = false;
    Object.keys(requestById).sort(function (left, right) {
      return Number(requestById[left].startSequence) - Number(requestById[right].startSequence);
    }).forEach(function (requestId, index) {
      var requestInfo = requestById[requestId];
      requestInfo.number = index + 1;
      if (requestInfo.usage) {
        cumulativeUsageProvided = true;
        Object.keys(cumulativeUsage).forEach(function (key) {
          cumulativeUsage[key] += Math.max(0, Number(requestInfo.usage[key]) || 0);
        });
      }
      requestInfo.cumulativeUsage = cumulativeUsageProvided ? Object.assign({}, cumulativeUsage) : null;
    });
    var nextTurn = 0;
    function turnFor(event, type) {
      var key = String(event && (event.parentTurnId || event.generationId || event.parentEventId) || '');
      if (key) {
        // Steering is appended to a live generation but represents a new user
        // input. Start a new trajectory turn when that input is consumed;
        // subsequent model/tool events in the generation inherit it.
        if (type === 'steering_message_consumed') {
          nextTurn += 1;
          turnByKey[key] = nextTurn;
          return nextTurn;
        }
        if (!turnByKey[key]) {
          nextTurn += 1;
          turnByKey[key] = nextTurn;
        }
        return turnByKey[key];
      }
      if (/user_message|steering_message|interaction_resolved/.test(type)) nextTurn += 1;
      if (!nextTurn) nextTurn = 1;
      return nextTurn;
    }
    function add(cell) {
      cell.index = cells.length + 1;
      cells.push(cell);
      if (cell.callId) byCall[cell.callId] = cell;
      return cell;
    }
    function addSystemCell(base, event, payload, systemText) {
      var tools = payload.request && payload.request.tools || payload.tools || [];
      var requestConfig = payload.request && typeof payload.request === 'object' ? payload.request : payload;
      var snapshot = {
        config: {
          provider: String(payload.provider || requestConfig.provider || ''),
          model: String(payload.model || requestConfig.model || ''),
          serviceId: String(requestConfig.serviceId || ''),
          maxOutputTokens: Number(requestConfig.maxOutputTokens) || null,
        },
        system: systemText || '', tools: tools,
      };
      var contentSignature = trajectoryJson({ system: snapshot.system, tools: snapshot.tools });
      if (contentSignature === lastPromptSignature) {
        if (lastPromptCell && snapshot.config && (snapshot.config.model || snapshot.config.provider || snapshot.config.serviceId)) {
          lastPromptCell.promptDetail = snapshot;
          lastPromptSnapshot = snapshot;
        }
        return null;
      }
      var previous = lastPromptSnapshot;
      lastPromptSignature = contentSignature;
      lastPromptSnapshot = snapshot;
      lastPromptCell = add(Object.assign({}, base, {
        status: 'completed',
        recordId: 'trajectory:system:' + String(event.eventId || event.sequence),
        kind: 'system',
        text: trajectoryPreview(systemText || (previous ? '工具目录已更新' : 'System prompt')),
        detail: systemText || '',
        inputDetail: systemText || '',
        promptDetail: snapshot,
        promptTools: tools,
        previousPromptDetail: previous,
      }));
      return lastPromptCell;
    }
    function updateTool(cell, event, payload, type) {
      if (!cell) {
        var newCallId = String(event.toolCallId || event.subCallId || trajectoryCallId(payload) || '');
        cell = add({
          recordId: 'trajectory:tool:' + String(event.eventId || event.sequence || cells.length),
          kind: (event.parentCallId || payload.parentCallId) ? 'subtool' : 'tool',
          text: '', detail: '', result: '', status: 'running',
          sequence: event.sequence, startedAt: event.at || null, durationMs: 0,
          topicId: String(event.conversationId || ''),
          modelRequestId: String(event.modelRequestId || payload.modelRequestId || ''),
          generationId: String(event.generationId || payload.generationId || ''),
          step: Math.max(0, Number(event.step || payload.step) || 0),
          callId: newCallId,
          rootCallId: String(event.rootCallId || payload.rootCallId || ''),
          subCallId: String(event.subCallId || payload.subCallId || ''),
          parentCallId: String(event.parentCallId || payload.parentCallId || ''),
          toolName: String(payload.name || payload.method || payload.toolName
            || payload.function && payload.function.name
            || payload.call && (payload.call.name || payload.call.toolName)
            || payload.call && payload.call.function && payload.call.function.name
            || payload.message && payload.message.name || '工具'),
          turn: turnFor(event, type), usage: null,
        });
      }
      var name = payload.name || payload.method || payload.toolName
        || payload.function && payload.function.name
        || payload.call && (payload.call.name || payload.call.toolName)
        || payload.call && payload.call.function && payload.call.function.name
        || payload.message && payload.message.name || cell.toolName || '工具';
      var args = trajectoryCallArguments(payload);
      if (type === 'model_stream_delta' && payload.phase === 'tool_call'
          && payload.delta !== undefined) {
        var streamDelta = String(payload.delta || '');
        cell.streamingArguments = String(cell.streamingArguments || '') + streamDelta;
        args = cell.streamingArguments;
      }
      if (args === undefined) args = cell.arguments;
      if (name) cell.toolName = String(name);
      if (!cell.modelRequestId && (event.modelRequestId || payload.modelRequestId)) cell.modelRequestId = String(event.modelRequestId || payload.modelRequestId);
      if (!cell.step && (event.step || payload.step)) cell.step = Math.max(0, Number(event.step || payload.step) || 0);
      if (!cell.generationId && (event.generationId || payload.generationId)) cell.generationId = String(event.generationId || payload.generationId);
      if (!cell.parentCallId && (event.parentCallId || payload.parentCallId)) {
        cell.parentCallId = String(event.parentCallId || payload.parentCallId);
        cell.kind = 'subtool';
      }
      var requestTools = toolsByRequest[String(cell.modelRequestId || '')] || [];
      var toolSchema = requestTools.filter(function (tool) {
        var candidate = tool && (tool.function || tool);
        return candidate && String(candidate.name || '').toUpperCase() === String(cell.toolName || '').toUpperCase();
      })[0];
      if (toolSchema) cell.schemaDetail = trajectoryJson(toolSchema);
      if (args !== undefined) {
        cell.arguments = args;
        cell.detail = typeof args === 'string' ? args : trajectoryJson(args);
        cell.inputDetail = cell.detail;
        cell.text = trajectoryPreview(cell.toolName + ' ' + (typeof args === 'string' ? args : trajectoryJson(args)));
      }
      var result = payload.result !== undefined ? payload.result
        : payload.output !== undefined ? payload.output
          : payload.content !== undefined && /(?:tool\/result|tool_call_(?:completed|result)|tool[_-]code[_-]dispatch|tool\/code-dispatch)/.test(type) ? payload.content
            : payload.message && payload.message.content !== undefined && /(?:tool\/result|tool_call_(?:completed|result))/.test(type)
              ? payload.message.content : undefined;
      if (/^(?:tool_execution_completed|tool_execution_failed|tool_execution_unknown|tool_call_(?:completed|result|failed)|tool_call_deferred)$/.test(type)
          && toolResultProjection && typeof toolResultProjection.projectTerminalEvent === 'function') {
        var projectionType = type;
        if (/^tool_call_(?:completed|result)$/.test(type)) projectionType = 'tool_execution_completed';
        else if (type === 'tool_call_failed') projectionType = 'tool_execution_failed';
        result = toolResultProjection.projectTerminalEvent({
          type: projectionType,
          payload: payload,
        });
      }
      if (result !== undefined) {
        cell.resultDetail = trajectoryContentText(result) || trajectoryJson(result);
        cell.outputDetail = cell.resultDetail;
        cell.outputBlocks = trajectorySourceBlocks(toolResultProjection
          && typeof toolResultProjection.toolResultContent === 'function'
          ? toolResultProjection.toolResultContent(result) : result, 'text');
        cell.result = trajectoryPreview(cell.resultDetail);
      }
      var callId = String(cell.callId || event.toolCallId || event.subCallId || trajectoryCallId(payload) || '');
      var terminalStatus = callId && terminalByCall[callId];
      cell.status = terminalStatus || trajectoryStatus(type, event);
      if (event.error) cell.error = event.error;
      if (event.durationMs) cell.durationMs = event.durationMs;
      if (type === 'tool_execution_started' && event.at) cell.startedAt = event.at;
      else if (event.at && !cell.startedAt) cell.startedAt = event.at;
      if (!event.durationMs && cell.startedAt && event.at && event.at >= cell.startedAt
          && /^(?:tool_execution_completed|tool_execution_failed|tool_execution_unknown|tool_call_(?:completed|failed|result|deferred)|tool_call_deferred|tool_code_dispatch|tool\/code-dispatch|tool\/result)$/.test(type)) {
        cell.durationMs = event.at - cell.startedAt;
      }
      if (terminalStatus === 'completed' && cell.resultDetail === undefined) {
        cell.resultDetail = '';
        cell.outputDetail = '';
        cell.outputBlocks = [];
      }
      if (terminalStatus === 'failed') cell.isError = true;
      return cell;
    }
    (Array.isArray(events) ? events : []).slice().sort(function (a, b) {
      return Number(a.sequence || 0) - Number(b.sequence || 0);
    }).forEach(function (event) {
      var type = String(event.eventType || '').toLowerCase();
      var payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      var turn = turnFor(event, type);
      var base = {
        sequence: Number(event.sequence) || 0,
        startedAt: event.at || null,
        durationMs: Math.max(0, Number(event.durationMs) || 0),
        status: terminalRequestById[String(event.modelRequestId || '')] || trajectoryStatus(type, event),
        turn: turn,
        step: Math.max(0, Number(event.step) || 0),
        model: event.model || '',
        modelRequestId: String(event.modelRequestId || ''),
        generationId: String(event.generationId || ''),
        source: event.source || '',
        usage: trajectoryUsage(payload),
        error: event.error || '',
        topicId: String(event.conversationId || ''),
      };
      var baseRequest = requestById[String(event.modelRequestId || '')];
      if (baseRequest) {
        base.requestNumber = baseRequest.number;
        base.requestInfo = baseRequest;
        base.provider = baseRequest.provider || event.provider || '';
        base.model = baseRequest.model || base.model;
      }
      if (type === 'user_message_appended' || type === 'user/message' || type === 'steering_message_consumed'
          || type === 'interaction_resolved') {
        var userText = trajectoryContentText(payload.message && payload.message.content
          || payload.content || payload.answer || payload.message);
        if (userText) add(Object.assign({}, base, {
          recordId: 'trajectory:user:' + String(event.eventId || event.sequence),
          kind: 'user', text: trajectoryPreview(userText), detail: userText, inputDetail: userText,
          messageSource: payload.message && payload.message.source !== undefined
            ? payload.message.source : payload.source,
          sourceRole: trajectoryContextProvenance(payload.message && payload.message.source !== undefined
            ? payload.message.source : payload.source).role,
          sourceLabel: trajectoryContextProvenance(payload.message && payload.message.source !== undefined
            ? payload.message.source : payload.source).label,
          sourceBlocks: trajectoryBlocksWithAttachments(payload.message && payload.message.content
            || payload.content || payload.answer || payload.message,
          payload.message && payload.message.attachments || payload.attachments),
        }));
        return;
      }
      if (type === 'assistant/message') {
        var assistantMessage = payload.message && typeof payload.message === 'object' ? payload.message : payload;
        var assistantContent = assistantMessage.content !== undefined ? assistantMessage.content : payload.content;
        var assistantThinkingText = Array.isArray(assistantContent)
          ? assistantContent.filter(function (part) {
            return part && typeof part === 'object'
              && /^(?:reasoning|thinking|thought)$/i.test(String(part.type || ''));
          }).map(function (part) {
            return trajectoryContentText(part.content !== undefined ? part.content : part);
          }).filter(Boolean).join('\n\n')
          : '';
        var assistantText = Array.isArray(assistantContent)
          ? assistantContent.filter(function (part) {
            return !(part && typeof part === 'object'
              && /^(?:reasoning|thinking|thought|tool[_-]?call|tool[_-]?use)$/i.test(String(part.type || '')));
          }).map(function (part) {
            return trajectoryContentText(part);
          }).filter(Boolean).join('\n\n')
          : trajectoryContentText(assistantContent);
        var assistantTurn = Math.max(1, Number(payload.turn) || turn);
        var assistantStep = Math.max(0, Number(payload.step) || 0);
        var assistantRequestId = String(event.modelRequestId || payload.modelRequestId
          || assistantMessage.modelRequestId || 'harness:' + assistantTurn + ':' + assistantStep);
        var assistant = add(Object.assign({}, base, {
          recordId: 'trajectory:message:' + String(event.eventId || event.sequence),
          kind: 'message', text: trajectoryPreview(assistantText || assistantThinkingText || '助手消息'),
          detail: assistantText || '', outputDetail: assistantText || '',
          status: 'completed', turn: assistantTurn, step: assistantStep, modelRequestId: assistantRequestId,
          messagePhase: 'response', requestOnly: false,
          sourceBlocks: trajectorySourceBlocks(assistantContent, 'text'),
          thinkingDetail: assistantThinkingText,
          messageSource: assistantMessage.source,
          sourceRole: trajectoryContextProvenance(assistantMessage.source).role,
          sourceLabel: trajectoryContextProvenance(assistantMessage.source).label,
          usage: trajectoryUsage(payload.usage || assistantMessage.usage),
        }));
        var assistantCalls = Array.isArray(assistantContent) ? assistantContent.filter(function (part) {
          return part && typeof part === 'object' && /^(?:tool[_-]?call|tool[_-]?use)$/i.test(String(part.type || ''));
        }) : [];
        assistantCalls.forEach(function (call, index) {
          var callId = trajectoryCallId(call, assistantRequestId + ':call:' + index);
          updateTool(byCall[callId], Object.assign({}, event, {
            eventId: callId, modelRequestId: assistantRequestId, toolCallId: callId,
          }), {
            toolCallId: callId, modelRequestId: assistantRequestId,
            name: call.name || call.toolName || call.function && call.function.name || '工具',
            arguments: trajectoryCallArguments(call),
          }, 'tool_call_planned');
        });
        return assistant;
      }
      if (type === 'model_request_started') {
        var promptMessages = payload.promptMessages
          || payload.request && payload.request.messages;
        var systemText = trajectoryContentText(payload.system
          || payload.request && payload.request.system)
          || trajectoryRoleText(promptMessages, ['system', 'developer']);
        var requestSnapshot = requestById[String(event.modelRequestId || '')];
        if (!systemText && requestSnapshot && requestSnapshot.config
            && requestSnapshot.config.system !== undefined) {
          systemText = trajectoryContentText(requestSnapshot.config.system);
        }
        if (systemText || payload.request && Array.isArray(payload.request.tools)) {
          addSystemCell(base, event, payload, systemText);
        }
        add(Object.assign({}, base, {
          recordId: 'trajectory:message:request:' + String(event.modelRequestId || event.eventId || event.sequence),
          kind: 'message', text: '正在等待模型响应', detail: '正在等待模型响应',
          outputDetail: undefined,
          status: terminalRequestById[String(event.modelRequestId || '')]
            || terminalGenerationById[String(event.generationId || '')]
            || 'running',
          messagePhase: 'request', requestOnly: true,
        }));
        return;
      }
      if (type === 'model_request_prepared') {
        add(Object.assign({}, base, {
          recordId: 'trajectory:message:request:' + String(event.modelRequestId || event.eventId || event.sequence),
          kind: 'message', text: '正在等待模型响应', detail: '正在等待模型响应',
          outputDetail: undefined,
          status: terminalRequestById[String(event.modelRequestId || '')]
            || terminalGenerationById[String(event.generationId || '')]
            || 'running',
          messagePhase: 'request', requestOnly: true,
        }));
        return;
      }
      if (type === 'context_injected') {
        var injectedSystem = trajectoryContentText(payload.system);
        if (injectedSystem || Array.isArray(payload.tools)) addSystemCell(base, event, payload, injectedSystem);
        var contextText = trajectoryContentText(payload.contextAppendMessages
          || payload.runtimeContext || payload.content);
        if (contextText) add(Object.assign({}, base, {
          status: 'completed',
          recordId: 'trajectory:context:' + String(event.eventId || event.sequence),
          kind: 'context', text: trajectoryPreview(contextText), detail: contextText,
          inputDetail: contextText,
          messageSource: payload.source,
          sourceRole: trajectoryContextProvenance(payload.source).role,
          sourceLabel: trajectoryContextProvenance(payload.source).label,
          sourceBlocks: trajectorySourceBlocks(payload.contextAppendMessages
            || payload.runtimeContext || payload.content, 'text'),
        }));
        return;
      }
      if (/^summary_/.test(type) || type === 'checkpoint_committed') {
        var summaryValue = payload.summary !== undefined ? payload.summary
          : payload.content !== undefined ? payload.content : payload.reason;
        var summaryText = trajectoryContentText(summaryValue)
          || (summaryValue && typeof summaryValue === 'object' ? trajectoryJson(summaryValue) : '')
          || (type === 'summary_requested' ? '正在生成上下文摘要' : '上下文摘要检查点');
        var summaryRequestId = String(event.modelRequestId || payload.summaryRequestId || '');
        var compacted = summaryRequestId && compactedByRequest[summaryRequestId];
        if (compacted) {
          compacted.status = trajectoryStatus(type, event);
          compacted.text = trajectoryPreview(summaryText);
          compacted.detail = summaryText;
          if (/^(?:summary_committed|checkpoint_committed)$/.test(type)) {
            compacted.outputDetail = summaryText;
            compacted.outputBlocks = [{ type: 'text', content: summaryText }];
          }
          compacted.sequence = Math.min(Number(compacted.sequence) || Number(event.sequence) || 0,
            Number(event.sequence) || Number(compacted.sequence) || 0);
          if (event.at) compacted.durationMs = Math.max(0, Number(event.at) - Number(compacted.startedAt || event.at));
          if (event.error) { compacted.error = event.error; compacted.isError = true; }
        } else {
          compacted = add(Object.assign({}, base, {
            recordId: 'trajectory:compacted:' + String(event.eventId || event.sequence),
            kind: 'compacted', text: trajectoryPreview(summaryText), detail: summaryText,
            outputDetail: /^(?:summary_committed|checkpoint_committed)$/.test(type) ? summaryText : undefined,
            status: trajectoryStatus(type, event),
          }));
          if (summaryRequestId) compactedByRequest[summaryRequestId] = compacted;
        }
        return;
      }
      if (type === 'tool/call' || type === 'tool/result'
          || /^tool_call_(?:planned|started|completed|failed|result|deferred)$/.test(type)
          || /^tool_execution_/.test(type)
          || /^tool_(?:code[_-]dispatch)/.test(type)
          || /^tool\/code-dispatch/.test(type) || type === 'tool_call_deferred') {
        var eventCallId = String(event.toolCallId || event.subCallId || trajectoryCallId(payload) || '');
        updateTool(byCall[eventCallId], event, payload, type);
        return;
      }
      if (type === 'reasoning_completed' || type === 'commentary_completed' || type === 'model_stream_delta'
          || type === 'model_response_completed' || type === 'model_request_failed'
          || type === 'generation_failed') {
        var streamPhase = type === 'model_stream_delta' ? String(payload.phase || 'text') : '';
        var streamingToolCall = type === 'model_stream_delta' && streamPhase === 'tool_call';
        if (streamingToolCall && event.toolCallId) {
          updateTool(byCall[String(event.toolCallId)], event, payload, type);
        }
        var content = trajectoryAssistantText(streamingToolCall ? '' : type === 'model_stream_delta' ? payload.delta
          : payload.content || payload.commentary || payload.finalAnswer
          || payload.error || payload.reason);
        var calls = Array.isArray(payload.calls) ? payload.calls : [];
        if (!content && calls.length) content = '调用 ' + calls.length + ' 个工具';
        if (!content && type === 'reasoning_completed') content = '思考';
        if (content || (type !== 'reasoning_completed' && !streamingToolCall)) {
          var message = add(Object.assign({}, base, {
            recordId: 'trajectory:message:request:' + String(event.modelRequestId || event.eventId || event.sequence),
            kind: 'message', text: trajectoryPreview(content || '助手消息'), detail: content || '助手消息',
            outputDetail: type === 'reasoning_completed' || streamPhase === 'reasoning' ? undefined : content || '',
            sourceBlocks: trajectorySourceBlocks(type === 'model_stream_delta' ? payload.delta
              : payload.content || payload.commentary || payload.finalAnswer || payload.error || payload.reason,
            type === 'reasoning_completed' || streamPhase === 'reasoning' ? 'reasoning' : 'text'),
            thinkingDetail: type === 'reasoning_completed' || streamPhase === 'reasoning'
              ? content
              : type === 'model_response_completed' && Array.isArray(payload.content)
                ? payload.content.filter(function (part) {
                  return part && typeof part === 'object'
                    && /^(?:reasoning|thinking|thought)$/i.test(String(part.type || ''));
                }).map(function (part) {
                  return trajectoryContentText(part.content !== undefined ? part.content : part);
                }).filter(Boolean).join('\n\n')
                : '',
            streamDelta: type === 'model_stream_delta',
            messagePhase: type === 'reasoning_completed' || streamPhase === 'reasoning' ? 'reasoning'
              : type === 'commentary_completed' ? 'commentary' : type === 'model_stream_delta' ? 'stream' : 'response',
          }));
          calls.forEach(function (call, index) {
            if (!call || typeof call !== 'object') return;
            var requestPlans = plannedByRequest[String(event.modelRequestId || '')] || [];
            var callId = trajectoryCallId(call, requestPlans[index] || (event.eventId + ':call:' + index));
            updateTool(byCall[callId], Object.assign({}, event, { eventId: callId }), {
              toolCallId: callId,
              name: call.name || call.toolName || call.function && call.function.name || '工具',
              arguments: trajectoryCallArguments(call),
            }, 'tool_call_planned');
          });
          return message;
        }
        return;
      }
      if (type === 'interaction_requested') {
        var prompt = trajectoryContentText(payload.prompt || payload.message);
        add(Object.assign({}, base, {
          recordId: 'trajectory:user:' + String(event.eventId || event.sequence),
          kind: 'user', text: trajectoryPreview(prompt || '等待用户输入'), detail: prompt || '等待用户输入',
        }));
      }
    });
    /* Harness renders one assistant cell per request and keeps reasoning,
       commentary and final content inside that cell. Merge transport-level
       message rows before ordering so a tool step cannot split the assistant
       record into three unrelated rows. */
    var mergedCells = [];
    var messageByRequest = Object.create(null);
    cells.forEach(function (cell) {
      if (cell.kind !== 'message' || !cell.modelRequestId) {
        mergedCells.push(cell);
        return;
      }
      var key = String(cell.modelRequestId);
      var existing = messageByRequest[key];
      if (!existing) {
        messageByRequest[key] = cell;
        mergedCells.push(cell);
        return;
      }
      var phase = cell.messagePhase || 'response';
      if (phase === 'reasoning') {
        var reasoning = cell.thinkingDetail || cell.detail || '';
        existing.thinkingDetail = cell.streamDelta
          ? [existing.thinkingDetail, reasoning].filter(Boolean).join('')
          : reasoning;
      } else {
        var output = cell.detail || cell.text || '';
        /* Reasoning and answer are separate Harness fields. The old merge
           appended the answer to the reasoning detail, so Preview received
           the thought once from outputDetail and once from thinkingDetail. */
        if (existing.messagePhase === 'reasoning') {
          existing.detail = output === '助手消息' ? '' : output;
        } else if (phase === 'response' && existing.streamDelta) {
          existing.detail = output === '助手消息' ? '' : output;
        } else if (existing.requestOnly) {
          existing.detail = output === '助手消息' ? '' : output;
        } else if (output && output !== '助手消息' && output !== existing.detail) {
          existing.detail = existing.messagePhase === 'request' ? output
            : [existing.detail, output].filter(function (value) { return value && value !== '助手消息'; })
              .join(cell.streamDelta ? '' : '\n\n');
        }
        existing.requestOnly = false;
        existing.messagePhase = phase;
        existing.outputDetail = existing.detail || '';
      }
      existing.streamDelta = phase === 'response' ? false : existing.streamDelta === true || cell.streamDelta === true;
      var sourceBlocks = existing.sourceBlocks || [];
      if (phase === 'reasoning' && !cell.streamDelta) {
        sourceBlocks = sourceBlocks.filter(function (block) { return block.type !== 'reasoning'; });
      } else if (phase === 'response') {
        sourceBlocks = sourceBlocks.filter(function (block) { return block.type !== 'text'; });
      }
      existing.sourceBlocks = sourceBlocks.concat(cell.sourceBlocks || []);
      existing.text = trajectoryPreview(existing.detail || existing.thinkingDetail || (phase === 'response' ? '助手消息' : existing.text) || '助手消息');
      existing.sequence = Math.min(Number(existing.sequence) || Number(cell.sequence) || 0,
        Number(cell.sequence) || Number(existing.sequence) || 0);
      existing.startedAt = Math.min(Number(existing.startedAt) || Number(cell.startedAt) || 0,
        Number(cell.startedAt) || Number(existing.startedAt) || 0) || existing.startedAt || cell.startedAt || null;
      existing.durationMs = Math.max(Number(existing.durationMs) || 0, Number(cell.durationMs) || 0);
      if (existing.startedAt && cell.startedAt && cell.startedAt >= existing.startedAt) {
        existing.durationMs = Math.max(existing.durationMs, Number(cell.startedAt) - Number(existing.startedAt));
      }
      if (existing.status !== 'failed' && cell.status === 'failed') existing.status = 'failed';
      if (existing.status === 'running' && cell.status === 'completed') existing.status = 'completed';
      if (cell.usage) existing.usage = cell.usage;
      if (cell.requestInfo) existing.requestInfo = cell.requestInfo;
    });
    mergedCells.forEach(function (cell) {
      var requestInfo = cell.requestInfo || requestById[String(cell.modelRequestId || '')];
      if (!requestInfo) return;
      cell.requestNumber = requestInfo.number;
      cell.provider = requestInfo.provider || cell.provider || '';
      cell.model = requestInfo.model || cell.model || '';
      cell.requestConfig = requestInfo.config || null;
      /* Request timing/usage belongs to the assistant request record. Do not
         stamp it onto SYSTEM/CONTEXT/TOOL rows: Harness shows those rows as
         independent cells, so copying request metrics makes every row look
         like the same long-running operation. */
      if (cell.kind === 'message') {
        if (requestInfo.usage) cell.usage = requestInfo.usage;
        if (requestInfo.startedAt) cell.startedAt = requestInfo.startedAt;
        if (requestInfo.startedAt && requestInfo.completedAt) {
          cell.durationMs = Math.max(0, requestInfo.completedAt - requestInfo.startedAt);
        }
      }
      if (cell.kind === 'message') {
        cell.assistantMetrics = {
          timingRecorded: !!requestInfo.startedAt,
          stepStartTime: requestInfo.startedAt || null,
          firstTokenTime: requestInfo.firstTokenTime || null,
          completedTime: requestInfo.completedAt || null,
          usageProvided: !!requestInfo.usage,
          outputTokens: requestInfo.usage ? requestInfo.usage.output : null,
        };
      }
    });
    mergedCells.forEach(function (cell) {
      var terminalStatus = terminalGenerationById[String(cell.generationId || '')];
      if (!terminalStatus) return;
      if ((cell.kind === 'tool' || cell.kind === 'subtool') && cell.resultDetail === undefined) {
        cell.status = terminalStatus;
        if (terminalStatus !== 'completed') {
          cell.isError = true;
          cell.error = cell.error || (terminalStatus === 'cancelled' ? '已取消' : terminalStatus === 'blocked' ? '已阻塞' : 'Interrupted');
        }
        cell.resultDetail = '';
        cell.outputDetail = '';
        cell.outputBlocks = [];
      } else if (cell.kind === 'message' && cell.requestOnly === true) {
        cell.status = terminalStatus;
        if (terminalStatus !== 'completed') {
          cell.isError = true;
          cell.error = cell.error || 'Interrupted';
        }
      } else if (cell.kind === 'message' && cell.status === 'running') {
        cell.status = terminalStatus;
        if (terminalStatus !== 'completed') {
          cell.isError = true;
          cell.error = cell.error || 'Interrupted';
        }
      } else if (cell.kind === 'message' && terminalStatus === 'failed'
          && cell.status === 'failed' && !cell.error) {
        cell.isError = true;
        cell.error = 'Interrupted';
      } else if (cell.kind === 'compacted' && cell.outputDetail === undefined) {
        cell.status = terminalStatus;
        if (terminalStatus !== 'completed') {
          cell.isError = true;
          cell.error = cell.error || 'Interrupted';
        }
      }
      /* A generation boundary is request-level timing. Only an assistant
         message may use it as a fallback; USER/SYSTEM/CONTEXT and TOOL cells
         must keep their own timing (or remain untimed). */
      var boundary = Number(terminalGenerationBoundaryById[String(cell.generationId || '')]) || 0;
      if (cell.kind === 'message' && boundary && cell.startedAt && boundary >= cell.startedAt && !cell.durationMs) {
        cell.durationMs = boundary - cell.startedAt;
      }
    });
    mergedCells.sort(function (a, b) { return Number(a.sequence || 0) - Number(b.sequence || 0) || a.index - b.index; });
    mergedCells.forEach(function (cell, index) { cell.index = index + 1; });
    return mergedCells;
  }

  function trajectoryCellLabel(kind) {
    return ({ system: 'SYSTEM', user: 'USER', context: 'CONTEXT', compacted: 'COMPACTED', message: 'ASSISTANT', tool: 'TOOL', subtool: 'SUBTOOL' })[kind] || 'EVENT';
  }

  function trajectoryStatusMeta(cell) {
    cell = cell || {};
    /* Match Harness stateOf(): tools wait for a result, in-flight requests stay
       pending, and every terminal error state wins over lifecycle progress. */
    var lifecycle = String(cell.status || '').toLowerCase();
    var errorState = cell.isError === true || ['failed', 'error', 'unknown', 'cancelled', 'canceled', 'truncated', 'blocked', 'interrupted'].indexOf(lifecycle) !== -1;
    var running = !errorState && ((cell.kind === 'tool' || cell.kind === 'subtool')
      ? cell.resultDetail === undefined
      : cell.kind === 'compacted' ? cell.outputDetail === undefined && cell.status === 'running'
        : cell.kind === 'message' && cell.status === 'running');
    var label = lifecycle === 'cancelled' || lifecycle === 'canceled' ? '已取消'
      : lifecycle === 'truncated' ? '部分完成'
        : lifecycle === 'blocked' ? '已阻塞'
          : lifecycle === 'interrupted' ? '已中断'
            : errorState ? '失败' : running ? '进行中' : '完成';
    return { className: errorState ? 'failed' : running ? 'running' : 'completed', label: label };
  }

  function trajectoryFilteredCells(cells) {
    var query = String(traceViewerSearch || '').toLowerCase().trim();
    if (!query) return cells.slice();
    return cells.filter(function (cell) {
      return [cell.kind, cell.toolName, cell.text, cell.detail, cell.thinkingDetail, cell.result, cell.model, cell.source, cell.status]
        .join('\n').toLowerCase().indexOf(query) !== -1;
    });
  }

  function trajectoryInspectorTabs(cell) {
    if (cell.kind === 'system') return (cell.previousPromptDetail ? [{ id: 'diff', label: '差异' }] : [])
      .concat([{ id: 'system-prompt', label: '系统提示词' }, { id: 'tools', label: '工具' }]);
    if (cell.kind === 'compacted') return [
      { id: 'overview', label: '概述' }, { id: 'raw', label: '原始输出' },
    ];
    if (cell.kind === 'tool' || cell.kind === 'subtool') return [
      { id: 'overview', label: '概述' },
    ].concat(cell.inputDetail ? [{ id: 'input', label: '参数' }] : [])
      .concat(cell.outputDetail !== undefined ? [{ id: 'output', label: '结果' }] : [])
      .concat([{ id: 'schema', label: 'Schema' }, { id: 'timing', label: '计时' }]);
    var tabs = [{ id: 'overview', label: '概述' }, { id: 'rendered', label: '预览' }, { id: 'raw', label: '原始内容' }];
    if (cell.messageSource !== undefined) tabs.push({ id: 'source', label: '来源' });
    return tabs;
  }

  function trajectoryBlocksHtml(blocks, text, markdown, topicId) {
    blocks = Array.isArray(blocks) ? blocks : [];
    /* Reasoning is rendered in its own Harness-style section. Keeping it in
       Preview as well makes the same thought appear twice. */
    var contentBlocks = blocks.filter(function (block) {
      if (!block || block.type === 'image') return false;
      if (markdown && /^(?:reasoning|thinking|thought|tool[_-]?call|tool[_-]?use)$/i.test(String(block.type || ''))) return false;
      return true;
    });
    var content = contentBlocks.map(function (block) { return block.content || ''; })
      .filter(Boolean).join('\n\n');
    /* If Preview only contained reasoning, do not fall back to text because
       that text is the same reasoning payload. */
    if (!content && !(markdown && blocks.some(function (block) {
      return block && /^(?:reasoning|thinking|thought|tool[_-]?call|tool[_-]?use)$/i.test(String(block.type || ''));
    }))) content = String(text || '');
    var attachments = blocks.filter(function (block) { return block && block.attachment; })
      .map(function (block) { return block.attachment; });
    var body = content ? (markdown ? renderMarkdown(content) : '<pre>' + esc(content) + '</pre>') : '';
    if (attachments.length) body += '<div class="conversation-image-attachments">'
      + conversationEventView.renderAttachments(attachments, topicId || '') + '</div>';
    return body || '<span class="conversation-trace-empty">无内容</span>';
  }

  function renderTrajectoryDetail(cell, allCells) {
    var status = trajectoryStatusMeta(cell);
    var tabs = trajectoryInspectorTabs(cell);
    if (!tabs.some(function (tab) { return tab.id === trajectoryInspectorTab; })) trajectoryInspectorTab = tabs[0].id;
    var activeTab = trajectoryInspectorTab;
    var sections = [];
    function section(title, body) {
      if (!body) return;
      sections.push('<section class="conversation-trajectory-detail-section"><h4>' + esc(title) + '</h4><div>' + body + '</div></section>');
    }
    function metrics() {
      if (!cell.usage) return '';
      return '<div class="conversation-trajectory-metrics"><span>Input <b>' + esc(cell.usage.input || 0) + '</b></span>'
        + '<span>Cache read <b>' + esc(cell.usage.cacheRead || 0) + '</b></span><span>Cache write <b>' + esc(cell.usage.cacheWrite || 0) + '</b></span>'
        + '<span>Output <b>' + esc(cell.usage.output || 0) + '</b></span><span>Reasoning <b>' + esc(cell.usage.reasoning || 0) + '</b></span></div>';
    }
    if (activeTab === 'overview') {
      section('概述', '<dl class="conversation-trajectory-overview"><div><dt>状态</dt><dd>' + esc(status.label) + '</dd></div>'
        + (cell.sourceLabel ? '<div><dt>来源</dt><dd>' + esc(cell.sourceLabel) + '</dd></div>' : '')
        + (cell.requestNumber ? '<div><dt>Request</dt><dd>' + esc(cell.requestNumber) + '</dd></div>' : '')
        + (cell.provider ? '<div><dt>Provider</dt><dd>' + esc(cell.provider) + '</dd></div>' : '')
        + (cell.model ? '<div><dt>Model</dt><dd>' + esc(cell.model) + '</dd></div>' : '')
        + (cell.callId ? '<div><dt>Call ID</dt><dd>' + esc(cell.callId) + '</dd></div>' : '')
        + '<div><dt>时长</dt><dd>' + esc(cell.durationMs ? cell.durationMs + ' ms' : '—') + '</dd></div></dl>');
      if (cell.kind === 'tool' || cell.kind === 'subtool') {
        section('参数', trajectoryBlocksHtml([], cell.inputDetail || cell.detail, false, cell.topicId));
        section('结果', cell.outputDetail === undefined
          ? '<span class="conversation-trace-empty">等待工具结果</span>'
          : trajectoryBlocksHtml(cell.outputBlocks, cell.outputDetail, false, cell.topicId));
        if (cell.parentCallId) {
          var parent = (allCells || []).filter(function (candidate) { return candidate.callId === cell.parentCallId; })[0];
          if (parent) section('层级', '<button type="button" class="conversation-trajectory-link" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(parent.recordId) + '">父工具 · ' + esc(parent.toolName || parent.callId) + '</button>');
        }
      } else {
        var calls = cell.kind === 'message' ? (allCells || []).filter(function (candidate) {
          return (candidate.kind === 'tool' || candidate.kind === 'subtool') && candidate.modelRequestId && candidate.modelRequestId === cell.modelRequestId;
        }) : [];
        var thinkingSection = cell.kind === 'message' && cell.thinkingDetail
          ? '<section class="conversation-trajectory-detail-section"><h4>思考</h4><div>' + renderMarkdown(cell.thinkingDetail) + '</div></section>' : '';
        if (thinkingSection) sections.push(thinkingSection);
        section('Preview', trajectoryBlocksHtml(cell.sourceBlocks, cell.outputDetail || cell.inputDetail || cell.detail || cell.text, true, cell.topicId));
        if (calls.length) section('工具', calls.map(function (call) {
          return '<button type="button" class="conversation-trajectory-link" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(call.recordId) + '">' + esc(call.toolName || call.callId) + '</button>';
        }).join(''));
      }
      if (cell.usage) section('用量', metrics());
      if (cell.assistantMetrics) {
        var assistantTiming = cell.assistantMetrics;
        section('计时', '<dl class="conversation-trajectory-overview"><div><dt>TTFT</dt><dd>'
          + esc(assistantTiming.firstTokenTime && assistantTiming.stepStartTime
            ? Math.max(0, assistantTiming.firstTokenTime - assistantTiming.stepStartTime) + ' ms' : '—')
          + '</dd></div><div><dt>总时长</dt><dd>' + esc(cell.durationMs ? cell.durationMs + ' ms' : '—') + '</dd></div></dl>');
      }
    } else if (activeTab === 'system-prompt') {
      section('系统提示词', cell.detail ? renderMarkdown(cell.detail) : '<span class="conversation-trace-empty">空 System prompt</span>');
    } else if (activeTab === 'tools') {
      section('工具', Array.isArray(cell.promptTools) && cell.promptTools.length
        ? '<pre>' + esc(trajectoryJson(cell.promptTools)) + '</pre>' : '<span class="conversation-trace-empty">未暴露工具</span>');
    } else if (activeTab === 'diff') {
      section('差异', trajectoryPromptDiffHtml(cell.previousPromptDetail, cell.promptDetail));
    } else if (activeTab === 'rendered') {
      if (cell.thinkingDetail) section('思考', renderMarkdown(cell.thinkingDetail));
      section('预览', trajectoryBlocksHtml(cell.sourceBlocks, cell.outputDetail || cell.inputDetail || cell.detail || cell.text, true, cell.topicId));
      if (cell.kind === 'message') {
        var renderedCalls = (allCells || []).filter(function (candidate) {
          return (candidate.kind === 'tool' || candidate.kind === 'subtool') && candidate.modelRequestId && candidate.modelRequestId === cell.modelRequestId;
        });
        if (renderedCalls.length) section('工具', renderedCalls.map(function (call) {
          return '<button type="button" class="conversation-trajectory-link" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(call.recordId) + '">' + esc(call.toolName || call.callId) + '</button>';
        }).join(''));
      }
    } else if (activeTab === 'raw') {
      section('原始内容', '<pre>' + esc([cell.thinkingDetail, cell.outputDetail || cell.inputDetail || cell.detail].filter(Boolean).join('\n\n')) + '</pre>');
    } else if (activeTab === 'source') {
      section('来源', '<pre>' + esc(trajectoryJson(cell.messageSource !== undefined ? cell.messageSource : cell.sourceBlocks || [])) + '</pre>');
    } else if (activeTab === 'input') {
      section('参数', trajectoryBlocksHtml([], cell.inputDetail || cell.detail, false, cell.topicId));
    } else if (activeTab === 'output') {
      section('结果', cell.outputDetail === undefined
        ? '<span class="conversation-trace-empty">等待工具结果</span>'
        : trajectoryBlocksHtml(cell.outputBlocks, cell.outputDetail, false, cell.topicId));
    } else if (activeTab === 'schema') {
      section('Schema', cell.schemaDetail ? '<pre>' + esc(cell.schemaDetail) + '</pre>' : '<span class="conversation-trace-empty">Schema 不可用</span>');
    } else if (activeTab === 'timing') {
      section('计时', '<dl class="conversation-trajectory-overview"><div><dt>开始</dt><dd>' + esc(cell.startedAt ? new Date(cell.startedAt).toLocaleString() : '—') + '</dd></div><div><dt>时长</dt><dd>' + esc(cell.durationMs ? cell.durationMs + ' ms' : '—') + '</dd></div></dl>');
    }
    var meta = [cell.turn ? 'Turn ' + cell.turn : '', cell.step ? 'Step ' + cell.step : '', cell.model || cell.source || ''].filter(Boolean).join(' · ');
    var tabHtml = '<div class="conversation-trajectory-detail-tabs" role="tablist">' + tabs.map(function (tab) {
      return '<button type="button" role="tab" aria-selected="' + (tab.id === activeTab ? 'true' : 'false') + '" class="' + (tab.id === activeTab ? 'active' : '') + '" data-conversation-action="trajectory-inspector-tab" data-tab="' + esc(tab.id) + '">' + esc(tab.label) + '</button>';
    }).join('') + '</div>';
    return '<div class="conversation-trajectory-detail"><div class="drawer-header"><div><h3 class="conversation-trace-detail-kind ' + esc(cell.kind) + '">' + esc(trajectoryCellLabel(cell.kind)) + '</h3><span>' + esc(meta) + '</span></div><div><i class="conversation-trace-status ' + status.className + '">' + esc(status.label) + '</i><button type="button" class="drawer-close conversation-trajectory-detail-close" data-conversation-action="trajectory-close-inspector" aria-label="关闭详情" title="关闭详情"><span class="conversation-trace-icon conversation-trace-icon-close" aria-hidden="true"></span></button></div></div>' + tabHtml + '<div class="conversation-trajectory-detail-body drawer-body">' + sections.join('') + '</div></div>';
  }

  function renderTrajectoryRequestDetail(request, allCells) {
    var tabs = [
      { id: 'overview', label: '概述' }, { id: 'options', label: '选项' },
      { id: 'usage', label: '用量' }, { id: 'timing', label: '计时' },
    ];
    if (!tabs.some(function (tab) { return tab.id === trajectoryInspectorTab; })) trajectoryInspectorTab = 'overview';
    var activeTab = trajectoryInspectorTab;
    var usage = request.usage || null;
    var cumulative = request.cumulativeUsage || null;
    var config = request.config || {};
    var options = {
      purpose: config.purpose || '', serviceId: config.serviceId || '', model: config.model || request.model || '',
      maxOutputTokens: config.maxOutputTokens === undefined ? null : config.maxOutputTokens,
      promptCacheKey: config.promptCacheKey || '',
      maxRetries: request.maxRetries === undefined ? null : request.maxRetries,
    };
    var duration = request.startedAt && request.completedAt ? Math.max(0, request.completedAt - request.startedAt) : null;
    var related = (allCells || []).filter(function (cell) { return cell.requestNumber === request.number; });
    var tools = related.filter(function (cell) { return cell.kind === 'tool' || cell.kind === 'subtool'; });
    var rootTools = tools.filter(function (cell) { return cell.kind === 'tool'; });
    var subtools = tools.filter(function (cell) { return cell.kind === 'subtool'; });
    var result = related.filter(function (cell) { return cell.kind === 'message' && cell.requestOnly !== true; })[0];
    function usageValue(source, key) {
      return source && Object.prototype.hasOwnProperty.call(source, key)
        ? Number(source[key]).toLocaleString() : '—';
    }
    function usageRows(source) {
      return '<div class="conversation-trajectory-metrics"><span>Input <b>' + esc(usageValue(source, 'input')) + '</b></span>'
        + '<span>Cache read <b>' + esc(usageValue(source, 'cacheRead')) + '</b></span><span>Cache write <b>' + esc(usageValue(source, 'cacheWrite')) + '</b></span>'
        + '<span>Output <b>' + esc(usageValue(source, 'output')) + '</b></span><span>Reasoning <b>' + esc(usageValue(source, 'reasoning')) + '</b></span></div>';
    }
    var body = '';
    if (activeTab === 'overview') {
      body = '<section class="conversation-trajectory-detail-section"><dl class="conversation-trajectory-overview"><div><dt>状态</dt><dd>' + esc(statusLabel(request.status) || '完成') + '</dd></div>'
        + (config.purpose ? '<div><dt>用途</dt><dd>' + esc(config.purpose) + '</dd></div>' : '')
        + (request.provider ? '<div><dt>Provider</dt><dd>' + esc(request.provider) + '</dd></div>' : '')
        + (request.model ? '<div><dt>Model</dt><dd>' + esc(request.model) + '</dd></div>' : '')
        + '<div><dt>工具调用</dt><dd>' + esc(rootTools.length) + '</dd></div>'
        + (subtools.length ? '<div><dt>子工具调用</dt><dd>' + esc(subtools.length) + '</dd></div>' : '')
        + (request.attempt ? '<div><dt>Attempt</dt><dd>' + esc(request.attempt) + '</dd></div>' : '')
        + (request.maxRetries !== undefined ? '<div><dt>最大重试</dt><dd>' + esc(request.maxRetries) + '</dd></div>' : '')
        + (request.retry !== undefined ? '<div><dt>已调度重试</dt><dd>' + esc(request.retry) + '</dd></div>' : '')
        + (request.retryDelayMs !== undefined ? '<div><dt>重试延迟</dt><dd>' + esc(request.retryDelayMs + ' ms') + '</dd></div>' : '')
        + (request.errorCode ? '<div><dt>错误代码</dt><dd>' + esc(request.errorCode) + '</dd></div>' : '')
        + (request.error ? '<div><dt>错误</dt><dd>' + esc(request.error) + '</dd></div>' : '')
        + (result ? '<div><dt>结果</dt><dd><button type="button" class="conversation-trajectory-link" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(result.recordId) + '">助手消息</button></dd></div>' : '')
        + '</dl></section><section class="conversation-trajectory-detail-section"><h4>用量</h4>' + usageRows(usage)
        + '</section>';
    } else if (activeTab === 'options') {
      body = '<section class="conversation-trajectory-detail-section"><pre>' + esc(trajectoryJson(options)) + '</pre></section>';
    } else if (activeTab === 'usage') {
      body = '<section class="conversation-trajectory-detail-section"><h4>本次请求</h4>' + usageRows(usage)
        + '<h4>会话累计</h4>' + usageRows(cumulative) + '</section>';
    } else {
      var assistantCell = result && result.assistantMetrics || {};
      var ttft = assistantCell.firstTokenTime && request.startedAt
        ? Math.max(0, assistantCell.firstTokenTime - request.startedAt) : null;
      body = '<section class="conversation-trajectory-detail-section"><dl class="conversation-trajectory-overview"><div><dt>开始</dt><dd>' + esc(request.startedAt ? new Date(request.startedAt).toLocaleString() : '—') + '</dd></div><div><dt>首 Token</dt><dd>' + esc(assistantCell.firstTokenTime ? new Date(assistantCell.firstTokenTime).toLocaleString() : '—') + '</dd></div><div><dt>完成</dt><dd>' + esc(request.completedAt ? new Date(request.completedAt).toLocaleString() : '—') + '</dd></div><div><dt>TTFT</dt><dd>' + esc(ttft === null ? '—' : ttft + ' ms') + '</dd></div><div><dt>时长</dt><dd>' + esc(duration === null ? '—' : duration + ' ms') + '</dd></div></dl></section>';
    }
    var tabHtml = '<div class="conversation-trajectory-detail-tabs" role="tablist">' + tabs.map(function (tab) {
      return '<button type="button" role="tab" aria-selected="' + (tab.id === activeTab ? 'true' : 'false') + '" class="' + (tab.id === activeTab ? 'active' : '') + '" data-conversation-action="trajectory-inspector-tab" data-tab="' + esc(tab.id) + '">' + esc(tab.label) + '</button>';
    }).join('') + '</div>';
    return '<div class="conversation-trajectory-detail"><div class="drawer-header"><div><h3>Request #' + esc(request.number) + '</h3><span>' + esc([request.turn ? 'Turn ' + request.turn : '', request.step ? 'Step ' + request.step : '', request.requestId || ''].filter(Boolean).join(' · ')) + '</span></div><div><button type="button" class="drawer-close conversation-trajectory-detail-close" data-conversation-action="trajectory-close-inspector" aria-label="关闭详情" title="关闭详情"><span class="conversation-trace-icon conversation-trace-icon-close" aria-hidden="true"></span></button></div></div>' + tabHtml + '<div class="conversation-trajectory-detail-body drawer-body">' + body + '</div></div>';
  }

  function trajectoryGroupList(cells) {
    var turns = [];
    var byTurn = Object.create(null);
    var stepsByTurn = Object.create(null);
    (Array.isArray(cells) ? cells : []).forEach(function (cell) {
      if (cell.kind === 'compacted') {
        turns.push({
          turn: null,
          groups: [{ key: 'compaction:' + String(cell.recordId || cell.sequence || ''), title: 'Compaction', cells: [cell] }],
          byKey: Object.create(null),
        });
        return;
      }
      var turn = Math.max(1, Number(cell.turn) || 1);
      var turnKey = String(turn);
      var turnGroup = byTurn[turnKey];
      if (!turnGroup) {
        turnGroup = { turn: turn, groups: [], byKey: Object.create(null) };
        byTurn[turnKey] = turnGroup;
        turns.push(turnGroup);
      }
      var groupKey = 'message';
      var title = 'Message';
      if ((cell.kind === 'message' || cell.kind === 'tool' || cell.kind === 'subtool')
          && (cell.modelRequestId || cell.callId)) {
        groupKey = 'step:' + String(cell.modelRequestId || 'call:' + cell.callId);
        if (!turnGroup.byKey[groupKey]) {
          stepsByTurn[turnKey] = (stepsByTurn[turnKey] || 0) + 1;
        }
        title = 'Step ' + String(Number(cell.step) || stepsByTurn[turnKey] || 1);
      }
      var group = turnGroup.byKey[groupKey];
      if (!group) {
        group = { key: groupKey, title: title, cells: [] };
        turnGroup.byKey[groupKey] = group;
        turnGroup.groups.push(group);
      }
      group.cells.push(cell);
    });
    turns.sort(function (a, b) {
      var left = a.groups[0] && a.groups[0].cells[0];
      var right = b.groups[0] && b.groups[0].cells[0];
      return Number(left && left.sequence || 0) - Number(right && right.sequence || 0);
    });
    return turns;
  }

  function trajectoryCollapseTargets(cells) {
    var assistants = [];
    trajectoryGroupList(cells).forEach(function (turnGroup) {
      turnGroup.groups.forEach(function (group) {
        group.cells.forEach(function (cell, index) {
          if (cell.kind !== 'message') return;
          var next = group.cells[index + 1];
          if (next && (next.kind === 'tool' || next.kind === 'subtool')) assistants.push(cell.recordId);
        });
      });
    });
    return { assistants: assistants };
  }

  /* Keep the timeline projection in one stable domain: one slot per operation,
     so adjacent tool calls remain individually visible. */
  function trajectoryTimelineMode() {
    return 'sequence';
  }

  function trajectoryTimelineModel(cells, mode) {
    var source = (Array.isArray(cells) ? cells : []).filter(function (cell) {
      return cell && cell.requestOnly !== true;
    });
    if (!source.length) return null;
    if (mode === 'sequence') {
      var sequenceSpans = source.map(function (cell, offset) {
        return {
          cell: cell, index: Number(cell.index) || 0, kind: cell.kind,
          turn: Number(cell.turn) || 0, isError: cell.isError === true, start: offset, end: offset + 1,
        };
      });
      var sequenceTurns = Object.create(null);
      sequenceSpans.forEach(function (span) {
        if (!span.turn || sequenceTurns[span.turn] !== undefined) return;
        sequenceTurns[span.turn] = span.start;
      });
      return {
        start: 0, end: sequenceSpans.length, spans: sequenceSpans,
        turnBoundaries: Object.keys(sequenceTurns).map(function (turn) {
          return { turn: Number(turn), time: sequenceTurns[turn] };
        }).sort(function (left, right) { return left.time - right.time; }),
      };
    }
    var actualDuration = mode === 'duration' || mode === 'actual';
    var compressIdle = mode === 'duration';
    var raw = source.map(function (cell) {
      var start = Number(cell.startedAt);
      if (!Number.isFinite(start) || start <= 0) return null;
      var duration = Math.max(0, Number(cell.durationMs) || 0);
      return {
        cell: cell, index: Number(cell.index) || 0, kind: cell.kind,
        turn: Number(cell.turn) || 0, isError: cell.isError === true, rawStart: start, rawEnd: start + duration,
      };
    }).filter(Boolean);
    if (!raw.length) return null;
    var removedByIndex = Object.create(null);
    var removedIdle = 0;
    var coveredUntil = null;
    raw.slice().sort(function (left, right) {
      return left.rawStart - right.rawStart || left.rawEnd - right.rawEnd;
    }).forEach(function (span) {
      if (compressIdle && coveredUntil !== null && span.rawStart > coveredUntil) {
        removedIdle += span.rawStart - coveredUntil;
      }
      removedByIndex[span.index] = removedIdle;
      coveredUntil = coveredUntil === null ? span.rawEnd : Math.max(coveredUntil, span.rawEnd);
    });
    var spans = raw.map(function (span) {
      var offset = Number(removedByIndex[span.index]) || 0;
      var start = span.rawStart - offset;
      var end = (actualDuration ? span.rawEnd : span.rawStart) - offset;
      return {
        cell: span.cell, index: span.index, kind: span.kind, isError: span.isError,
        turn: span.turn, start: start, end: end,
      };
    });
    var timedTurns = Object.create(null);
    spans.forEach(function (span) {
      if (!span.turn || timedTurns[span.turn] !== undefined) return;
      timedTurns[span.turn] = span.start;
    });
    return {
      start: Math.min.apply(null, spans.map(function (span) { return span.start; })),
      end: Math.max.apply(null, spans.map(function (span) { return span.end; })),
      spans: spans,
      turnBoundaries: Object.keys(timedTurns).map(function (turn) {
        return { turn: Number(turn), time: timedTurns[turn] };
      }).sort(function (left, right) { return left.time - right.time; }),
    };
  }

  function trajectoryTimelineDomain(model, viewport) {
    if (!model) return { start: 0, end: 1 };
    var fullStart = Number(model.start) || 0;
    var fullEnd = Math.max(fullStart + 1, Number(model.end) || fullStart + 1);
    if (!viewport) return { start: fullStart, end: fullEnd };
    var span = Math.min(fullEnd - fullStart, Math.max(1, Number(viewport.end) - Number(viewport.start)));
    var start = Math.min(Math.max(Number(viewport.start) || fullStart, fullStart), fullEnd - span);
    return { start: start, end: start + span };
  }

  function trajectoryTimelineSpanForCell(model, cell) {
    if (!model || !cell) return null;
    return model.spans.filter(function (span) { return span.index === Number(cell.index); })[0] || null;
  }

  function trajectoryTimelineRangeContains(model, cell, range) {
    if (!range) return true;
    var span = trajectoryTimelineSpanForCell(model, cell);
    return !!(span && span.start <= Number(range.end) && span.end >= Number(range.start));
  }

  function trajectoryTimelinePoint(event, root, model) {
    var domain = trajectoryTimelineDomain(model, trajectoryTimelineViewport);
    var rect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, width: 1 };
    var fraction = Math.max(0, Math.min(1, (Number(event && event.clientX) - rect.left) / Math.max(1, rect.width)));
    return domain.start + fraction * (domain.end - domain.start);
  }

  function renderTrajectoryRows(cells, selected, timelineModel) {
    function rowText(cell) {
      if (cell.kind !== 'tool' && cell.kind !== 'subtool') {
        var messageText = cell.text || cell.detail || '—';
        /* Keep the assistant cell structure from Harness while making a
           reasoning-bearing turn discoverable in the ledger. The full text
           remains in the drawer's dedicated 思考 section. */
        if (cell.kind === 'message' && cell.thinkingDetail
            && messageText !== '思考' && messageText.indexOf('思考 · ') !== 0) {
          messageText = '思考 · ' + messageText;
        }
        return messageText;
      }
      var name = cell.toolName || '工具';
      var args = cell.inputDetail || cell.detail || '';
      var result = cell.outputDetail === undefined ? '' : ' → ' + (cell.result || cell.outputDetail || '');
      return name + (args ? ' ' + args : '') + result;
    }
    function eventCell(cell, assistantFold) {
      var label = trajectoryCellLabel(cell.kind);
      if (cell.kind === 'user') {
        return assistantFold + '<span class="conversation-trace-turn-label">Turn ' + esc(cell.turn || 1) + '</span><span class="conversation-trace-kind-tag user">USER</span>';
      }
      if (cell.kind === 'message' && cell.requestNumber) {
        return assistantFold + '<button type="button" class="conversation-trace-request" aria-label="Request #' + esc(cell.requestNumber) + '" data-label="Request #' + esc(cell.requestNumber) + '" data-conversation-action="trajectory-select-request" data-request-number="' + esc(cell.requestNumber) + '">Request #' + esc(cell.requestNumber) + '</button><span class="conversation-trace-kind-tag message">ASSISTANT</span>';
      }
      return assistantFold + '<span class="conversation-trace-kind-tag ' + esc(cell.kind) + '">' + esc(label) + '</span>';
    }
    function rowTiming(cell) {
      /* Request duration belongs to the assistant cell. Tool duration is the
         measured execution span. Other ledger roles intentionally stay quiet. */
      if (cell.kind !== 'message' && cell.kind !== 'tool' && cell.kind !== 'subtool') return '';
      var duration = Math.max(0, Number(cell.durationMs) || 0);
      return duration > 0 ? duration + ' ms' : '';
    }
    return trajectoryGroupList(cells).map(function (turnGroup) {
      var groupedCells = turnGroup.groups.reduce(function (all, group) { return all.concat(group.cells); }, []);
      if (!groupedCells.length) return '';
      var html = '';
      turnGroup.groups.forEach(function (group) {
        var collapsedAssistant = '';
        group.cells.forEach(function (cell) {
          if ((cell.kind === 'tool' || cell.kind === 'subtool') && collapsedAssistant) return;
          if (cell.kind !== 'tool' && cell.kind !== 'subtool') collapsedAssistant = '';
          var hasTools = cell.kind === 'message' && group.cells.some(function (candidate) {
            return (candidate.kind === 'tool' || candidate.kind === 'subtool') && candidate.modelRequestId === cell.modelRequestId;
          });
          var isCollapsed = cell.kind === 'message' && trajectoryCollapsedAssistantIds[cell.recordId] === true;
          if (isCollapsed) collapsedAssistant = cell.recordId;
          var status = trajectoryStatusMeta(cell);
          var selectedClass = selected && selected.recordId === cell.recordId ? ' selected' : '';
          var outsideClass = trajectoryTimelineRange && !trajectoryTimelineRangeContains(timelineModel, cell, trajectoryTimelineRange) ? ' timeline-outside' : '';
          var assistantFold = hasTools ? '<button type="button" class="conversation-trace-fold conversation-trace-assistant-fold" data-conversation-action="trajectory-toggle-assistant" data-assistant-cell-id="' + esc(cell.recordId) + '" aria-expanded="' + (isCollapsed ? 'false' : 'true') + '" aria-label="' + (isCollapsed ? '展开工具调用' : '折叠工具调用') + '" title="' + (isCollapsed ? '展开工具调用' : '折叠工具调用') + '"><span class="conversation-trace-fold-icon ' + (isCollapsed ? 'conversation-trace-icon-right' : 'conversation-trace-icon-down') + '" aria-hidden="true"></span></button>' : '';
          var rowLabel = eventCell(cell, assistantFold);
          var timing = rowTiming(cell);
          html += '<tr class="conversation-trace-row conversation-trace-row-' + esc(cell.kind) + selectedClass + outsideClass + '" data-state="' + esc(status.className) + '" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(cell.recordId) + '"><td class="conversation-trace-row-kind">' + rowLabel + '</td><td class="conversation-trace-row-content"><button type="button" class="conversation-trace-row-select' + (selectedClass ? ' selected' : '') + '" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(cell.recordId) + '"><span>' + esc(rowText(cell)) + '</span>' + (timing ? '<small>' + esc(timing) + '</small>' : '') + '</button></td></tr>';
        });
      });
      return html;
    }).join('');
  }

  function renderTopicTrajectory(topic) {
    var tracePage = topicTrajectoryPage(topic);
    var cells = topicTrajectoryItems(topic).slice().sort(function (a, b) {
      return Number(a.sequence || 0) - Number(b.sequence || 0) || Number(a.index || 0) - Number(b.index || 0);
    });
    if (!cells.length && topicTrajectoryIsLoading(topic)) {
      return trajectoryLoadingHtml();
    }
    if (!cells.length && !tracePage.total) {
      return '<div class="conversation-llm-log"><div class="conversation-llm-log-meta"><b>0</b><span>当前话题还没有轨迹记录。</span></div></div>';
    }
    var filtered = trajectoryFilteredCells(cells);
    var timelineMode = trajectoryTimelineMode();
    var timelineModel = trajectoryTimelineModel(cells, timelineMode);
    var timelineDomain = trajectoryTimelineDomain(timelineModel, trajectoryTimelineViewport);
    var timelineSpan = Math.max(1, timelineDomain.end - timelineDomain.start);
    var timelineCells = timelineModel ? timelineModel.spans.filter(function (span) {
      return span.end >= timelineDomain.start && span.start <= timelineDomain.end;
    }) : [];
    if (selectedTrajectoryCellId && !filtered.some(function (cell) { return cell.recordId === selectedTrajectoryCellId; })) {
      selectedTrajectoryCellId = '';
    }
    var selected = filtered.filter(function (cell) { return cell.recordId === selectedTrajectoryCellId; })[0] || null;
    var selectedRequest = selectedTrajectoryRequestNumber && cells.reduce(function (found, cell) {
      return found || (cell.requestNumber === selectedTrajectoryRequestNumber ? cell.requestInfo : null);
    }, null);
    var totalDuration = filtered.reduce(function (sum, cell) { return sum + (Number(cell.durationMs) || 0); }, 0);
    var totalTokens = filtered.reduce(function (sum, cell) {
      return sum + (cell.usage ? (Number(cell.usage.input) || 0) + (Number(cell.usage.output) || 0) : 0);
    }, 0);
    var assistantCollapseTargets = trajectoryCollapseTargets(filtered).assistants;
    var allAssistantsCollapsed = assistantCollapseTargets.length > 0 && assistantCollapseTargets.every(function (id) {
      return trajectoryCollapsedAssistantIds[id] === true;
    });
    /* History is a bounded visible-card window. Older rows are pulled by the
       scroll boundary, so the viewer needs no separate load-more button. */
    var paginationHtml = '<div class="conversation-trace-history-boundary conversation-trace-history-boundary-empty" aria-hidden="true"></div>';
    var timelineSelectionHtml = '<div class="conversation-trace-timeline-selection" style="display:none" aria-hidden="true"></div>';
    if (timelineModel && trajectoryTimelineRange) {
      var selectionStart = Math.max(timelineDomain.start, Math.min(timelineDomain.end, Number(trajectoryTimelineRange.start)));
      var selectionEnd = Math.max(timelineDomain.start, Math.min(timelineDomain.end, Number(trajectoryTimelineRange.end)));
      var selectionLeft = (Math.min(selectionStart, selectionEnd) - timelineDomain.start) * 100 / timelineSpan;
      var selectionWidth = Math.abs(selectionEnd - selectionStart) * 100 / timelineSpan;
      timelineSelectionHtml = '<div class="conversation-trace-timeline-selection" style="left:' + esc(selectionLeft) + '%;width:' + esc(Math.max(.1, selectionWidth)) + '%" aria-hidden="true"></div>';
    }
    var timelineEarlierHtml = '';
    var timelineTurnsHtml = timelineModel ? (timelineModel.turnBoundaries || []).filter(function (boundary) {
      return boundary.time > timelineDomain.start && boundary.time <= timelineDomain.end;
    }).map(function (boundary) {
      var left = (boundary.time - timelineDomain.start) * 100 / timelineSpan;
      return '<i class="conversation-trace-timeline-turn" style="left:' + esc(left) + '%" title="Turn ' + esc(boundary.turn) + '"></i>';
    }).join('') : '';
    var timelineHtml = '<section class="conversation-trace-timeline" aria-label="Trajectory timeline" data-mode="' + esc(timelineMode) + '"><div class="conversation-trace-timeline-body"><div class="conversation-trace-timeline-labels" aria-hidden="true"><span>Input</span><span>Model</span><span>Tools</span></div><div class="conversation-trace-timeline-lanes actual-time">'
      + timelineSelectionHtml + timelineTurnsHtml + timelineEarlierHtml + (timelineModel ? timelineCells.map(function (span) {
        var cell = span.cell;
        var status = trajectoryStatusMeta(cell);
        var lane = cell.kind === 'tool' || cell.kind === 'subtool' ? 3
          : cell.kind === 'message' || cell.kind === 'compacted' ? 2 : 1;
        var clippedStart = Math.max(timelineDomain.start, span.start);
        var clippedEnd = Math.min(timelineDomain.end, Math.max(span.end, span.start));
        var left = Math.max(0, Math.min(100, (clippedStart - timelineDomain.start) * 100 / timelineSpan));
        var width = Math.max(.7, (clippedEnd - clippedStart) * 100 / timelineSpan);
        if (timelineMode === 'sequence' || timelineMode === 'time') width = Math.max(width, 1.4);
        var timingStart = Number(cell.startedAt || 0);
        var timing = [trajectoryCellLabel(cell.kind), cell.requestNumber ? 'Request ' + cell.requestNumber : '', timingStart ? new Date(timingStart).toLocaleTimeString() : '', cell.durationMs ? cell.durationMs + ' ms' : ''].filter(Boolean).join(' · ');
        /* Keep adjacent calls visually distinct, matching Harness' timeline
           span geometry. Without this small gap, long tool sequences merge
           into one indistinguishable amber bar. */
        var spanWidth = Math.min(100 - left, width);
        var spanGap = Math.min(1, Math.max(0, spanWidth * 0.08));
        var spanStyle = 'left:calc(' + left + '% + ' + spanGap + 'px);width:calc(' + spanWidth + '% - ' + (spanGap * 2) + 'px);top:' + (7 + (lane - 1) * 14) + 'px';
        var searchMatch = traceViewerSearch
          ? (trajectoryFilteredCells([cell]).length ? ' search-match' : ' search-miss') : '';
        return '<button type="button" style="' + esc(spanStyle) + '" class="conversation-trace-timeline-span ' + esc(cell.kind) + ' ' + status.className + ' absolute' + searchMatch + (selected && selected.recordId === cell.recordId ? ' selected' : '') + '" data-conversation-action="select-trajectory-cell" data-cell-id="' + esc(cell.recordId) + '" data-cell-index="' + esc(cell.index) + '" data-timeline-start="' + esc(span.start) + '" data-timeline-end="' + esc(span.end) + '" title="' + esc(timing) + '"></button>';
      }).join('') : '<span class="conversation-trace-empty">没有可用计时数据</span>') + '</div></div><div class="conversation-trace-timeline-axis"><span>开始</span><span>' + esc(timelineCells.length) + ' cells</span><span>最新</span></div></section>';
    var inspectorHtml = selectedRequest
      ? renderTrajectoryRequestDetail(selectedRequest, cells)
      : selected ? renderTrajectoryDetail(selected, cells) : '<div class="conversation-trace-empty">选择一个轨迹 cell 查看详情</div>';
    var workspaceClass = 'conversation-trace-workspace' + (trajectoryInspectorOpen ? ' inspector-open' : ' inspector-closed');
    return '<div class="conversation-llm-log conversation-trace-viewer"><div class="conversation-trace-toolbar" role="toolbar" aria-label="Trajectory toolbar">'
      + '<div class="conversation-trace-toolbar-actions"><button type="button" class="conversation-trace-back" data-conversation-action="close-topic-trajectory" aria-label="返回对话" title="返回对话"><span class="conversation-trace-toolbar-icon conversation-trace-icon-back" aria-hidden="true"></span></button><button type="button" aria-pressed="' + (allAssistantsCollapsed ? 'true' : 'false') + '" class="conversation-trace-toolbar-toggle ' + (allAssistantsCollapsed ? 'active' : '') + '" data-conversation-action="trajectory-toggle-tools"><span class="conversation-trace-toolbar-icon ' + (allAssistantsCollapsed ? 'conversation-trace-icon-right' : 'conversation-trace-icon-down') + '" aria-hidden="true"></span>调用</button>' + (trajectoryTimelineRange ? '<button type="button" class="conversation-trace-clear-range" data-conversation-action="trajectory-clear-range">清除范围</button>' : '') + '</div>'
      + '<label class="conversation-trace-search"><span class="conversation-trace-search-icon" aria-hidden="true"></span><input type="search" aria-label="Search trajectory" value="' + esc(traceViewerSearch) + '" placeholder="搜索轨迹" data-conversation-action="trace-search"></label></div>'
      + timelineHtml
      + '<div class="' + workspaceClass + '"><div class="conversation-trace-ledger"><div class="conversation-trace-ledger-summary"><span>轨迹 Ledger</span><b>' + esc(filtered.length) + '</b><span class="conversation-trace-ledger-stats">' + esc(totalTokens.toLocaleString()) + ' tokens · ' + esc(totalDuration) + ' ms</span></div>' + paginationHtml + '<div class="conversation-trace-table-wrap"><table class="conversation-trace-table"><colgroup><col class="conversation-trace-table-kind"><col></colgroup><tbody class="conversation-trace-turns">' + (filtered.length ? renderTrajectoryRows(filtered, selected, timelineModel) : '<tr><td colspan="2" class="conversation-trace-empty conversation-trace-no-results">没有匹配的轨迹</td></tr>') + '</tbody></table></div></div>' + (trajectoryInspectorOpen ? '<div class="drawer-overlay active conversation-trace-overlay" data-conversation-action="trajectory-close-inspector" aria-hidden="true"></div><aside class="drawer conversation-trace-drawer active conversation-trace-main" role="complementary" aria-label="Event details"><div class="conversation-trace-resize" role="separator" tabindex="0" aria-label="调整详情宽度" data-conversation-action="trajectory-resize-inspector"></div>' + inspectorHtml + '</aside>' : '') + '</div></div>';
  }

  function renderTrajectoryPage(topic, body) {
    return '<div class="conversation-trajectory-page" id="trajectory-page-root" data-topic-id="' + esc(topic && topic.topicId || '') + '">'
      + '<div class="conversation-trajectory-page-content" id="trajectory-view-content">'
      + (body === undefined ? renderTopicTrajectory(topic) : body)
      + '</div>'
      + '</div>';
  }

  function selectedAssistant() {
    if (!state) return null;
    return state.assistants[state.activeAssistantId] || null;
  }

  function topicAssistant(topic) {
    if (!state) return null;
    if (topic && state.assistants[topic.assistantId]) return state.assistants[topic.assistantId];
    return selectedAssistant();
  }

  function activeAssistant() {
    if (!state) return null;
    return topicAssistant(activeTopic());
  }

  function activeTopic() {
    if (!state || !state.activeTopicId) return null;
    return state.topics[state.activeTopicId] || null;
  }

  function applyTopicSelection(snapshot, topicId) {
    topicId = String(topicId || '').trim();
    if (!topicId || !snapshot || !snapshot.topics || !snapshot.topics[topicId]) return snapshot;
    var topic = snapshot.topics[topicId];
    return Object.assign({}, snapshot, {
      activeTopicId: topicId,
      activeAssistantId: topic.assistantId || snapshot.activeAssistantId,
    });
  }

  function applyPendingTopicSelection(snapshot) {
    return applyTopicSelection(snapshot, topicSwitchLoadingTopicId);
  }

  function firstTopicIdForAssistant(snapshot, assistantId) {
    if (!snapshot || !assistantId) return '';
    var order = snapshot.topicOrder || [];
    for (var i = 0; i < order.length; i++) {
      var topic = snapshot.topics && snapshot.topics[order[i]];
      if (topic && topic.assistantId === assistantId) return topic.topicId || order[i];
    }
    return '';
  }

  function applyAssistantSelection(snapshot, assistantId) {
    assistantId = String(assistantId || '').trim();
    if (!assistantId || !snapshot || !snapshot.assistants || !snapshot.assistants[assistantId]) return snapshot;
    var activeTopic = snapshot.activeTopicId && snapshot.topics && snapshot.topics[snapshot.activeTopicId];
    var nextTopicId = activeTopic && activeTopic.assistantId === assistantId
      ? snapshot.activeTopicId
      : firstTopicIdForAssistant(snapshot, assistantId);
    return Object.assign({}, snapshot, {
      activeAssistantId: assistantId,
      activeTopicId: nextTopicId || '',
    });
  }

  function latestTopicForAssistant(assistantId) {
    if (!state || !assistantId) return null;
    for (var i = 0; i < (state.topicOrder || []).length; i++) {
      var topic = state.topics[state.topicOrder[i]];
      if (topic && topic.assistantId === assistantId) return topic;
    }
    return null;
  }

  function conversationTopic(assistant) {
    var topic = activeTopic();
    if (topic && (!assistant || topic.assistantId === assistant.id)) return topic;
    return latestTopicForAssistant(assistant && assistant.id);
  }

  function displayedTopic() {
    var topic = conversationTopic(selectedAssistant());
    if (topic && topic.archived && archivedTopicById[topic.topicId]) return archivedTopicById[topic.topicId];
    return topic;
  }

  function loadDisplayedArchivedTopic(topic) {
    var topicId = String(topic && topic.topicId || '').trim();
    if (!topicId || !topic.archived || archivedTopicById[topicId]) return Promise.resolve(topic);
    if (archivedTopicRequestById[topicId]) return archivedTopicRequestById[topicId];
    var request = getConversationResource(topicId).then(function (archived) {
      if (!archived) throw new Error('归档内容不存在');
      archivedTopicById[topicId] = archived;
      if (activeTopic() && activeTopic().topicId === topicId) {
        lastRenderKey = '';
        renderLoaded();
      }
      return archived;
    }).catch(function (err) {
      toast('加载归档话题失败: ' + err.message, true);
      return null;
    }).finally(function () {
      delete archivedTopicRequestById[topicId];
    });
    archivedTopicRequestById[topicId] = request;
    return request;
  }

  function assistantSnapshotFrom(assistant) {
    return profileApi().snapshot(assistant);
  }

  function assistantSignature(assistant) {
    return profileApi().signature(assistant);
  }

  function assistantForTopicRun(topic, fallback) {
    if (!topic) return fallback || selectedAssistant();
    var snapshot = topic.assistantSnapshot;
    if (snapshot) return profileApi().normalizeSnapshot(snapshot, { id: topic.assistantId });
    return fallback || state.assistants[topic.assistantId] || selectedAssistant();
  }

  function topicSnapshotDiffersFromAssistant(topic, assistant) {
    if (!topic || !assistant || !topic.assistantSnapshot) return false;
    return assistantSignature(topic.assistantSnapshot) !== assistantSignature(assistant);
  }

  function refreshTopicAssistantSnapshot(topic, assistant) {
    var snapshot = assistantSnapshotFrom(assistant);
    var budgets = Object.assign({}, topic.budgets || {}, {
      maxIterations: Number(snapshot.settings && snapshot.settings.maxIterations) || Number(topic.budgets && topic.budgets.maxIterations) || DEFAULT_MAX_ITERATIONS,
      maxToolCalls: Number(snapshot.settings && snapshot.settings.maxToolCalls) || Number(topic.budgets && topic.budgets.maxToolCalls) || DEFAULT_MAX_TOOL_CALLS,
      maxContextTokens: Number(snapshot.settings && snapshot.settings.maxContextTokens) || Number(topic.budgets && topic.budgets.maxContextTokens) || 0,
    });
    return patchConversationResource(topic.topicId, {
      assistantSnapshot: snapshot,
      budgets: budgets,
    }).then(function (nextTopic) {
      return { topic: nextTopic, assistant: assistantForTopicRun(nextTopic, assistant) };
    });
  }

  function resolveAssistantForTopicRun(topic, options) {
    options = options || {};
    if (!topic) return Promise.resolve({ topic: topic, assistant: selectedAssistant() });
    var liveAssistant = state.assistants[topic.assistantId] || selectedAssistant();
    var snapshotAssistant = assistantForTopicRun(topic, liveAssistant);
    if (!options.promptForStale || !topicSnapshotDiffersFromAssistant(topic, liveAssistant)) {
      return Promise.resolve({ topic: topic, assistant: snapshotAssistant });
    }
    return openConversationConfirm({
      title: '使用最新助手配置？',
      message: '这个历史话题使用的是创建时的助手配置。当前助手的模型、提示词或预算已经修改，是否用最新配置继续发送？',
      okText: '使用最新配置',
      cancelText: '继续使用快照',
      danger: false,
    }).then(function (useLatest) {
      if (useLatest) return refreshTopicAssistantSnapshot(topic, liveAssistant);
      return { topic: topic, assistant: snapshotAssistant };
    });
  }

  function statusLabel(status) { return conversationShared.statusLabel(status); }

  function conversationStatusBadgeTone(status) {
    status = String(status || '').toLowerCase();
    if (['starting', 'running', 'waiting_user', 'cancelling'].indexOf(status) !== -1) return 'running';
    if (['failed', 'error', 'cancelled', 'canceled', 'truncated', 'blocked', 'interrupted'].indexOf(status) !== -1) return 'failed';
    return 'success';
  }

  function topicGoalMeta(topic) {
    topic = topic || {};
    var meta = topic.contextMeta || {};
    var currentGoal = String(meta.currentGoal || topic.objective || topic.name || '').trim();
    var originalGoal = String(meta.originalGoal || topic.objective || currentGoal || '').trim();
    return {
      currentGoal: currentGoal,
      originalGoal: originalGoal,
      goalChangeReason: String(meta.goalChangeReason || '').trim(),
      architectureVersion: Number(meta.architectureVersion) || 0,
      lastContextMode: String(meta.lastContextMode || '').trim(),
      lastKnowledgeMode: String(meta.lastKnowledgeMode || '').trim(),
      decisionPolicy: meta.decisionPolicy && typeof meta.decisionPolicy === 'object' ? meta.decisionPolicy : {},
      decisionOutcome: meta.decisionOutcome && typeof meta.decisionOutcome === 'object' ? meta.decisionOutcome : {},
      pendingCleanContext: meta.pendingCleanContext === true,
      cleanContextTriggerReason: String(meta.cleanContextTriggerReason || '').trim(),
      windowNumber: Number(meta.windowNumber) || 0,
      lastTurnIntent: String(meta.lastTurnIntent || '').trim(),
      lastTurnReason: String(meta.lastTurnReason || '').trim(),
      lastFailureKind: String(meta.lastFailureKind || '').trim(),
      repeatedFailureCount: Number(meta.repeatedFailureCount) || 0,
    };
  }

  function topicEntryStatusMeta(topic) {
    topic = topic || {};
    var status = topic.contextMeta && topic.contextMeta.entryStatus || {};
    var entry = String(status.entry || '').trim();
    if (entry === 'floating') entry = 'floating-status';
    var tabId = Math.max(0, Math.floor(Number(status.tabId || status.activeTabId) || 0));
    var windowId = Math.max(0, Math.floor(Number(status.windowId || status.activeWindowId) || 0));
    var pageId = String(status.pageId || '').trim();
    var url = String(status.url || '').trim();
    var pageLabel = String(status.pageLabel || status.pageName || '').trim();
    if (!entry && !tabId && !windowId && !pageId && !url && !pageLabel) return null;
    return {
      entry: entry,
      tabId: tabId,
      windowId: windowId,
      pageId: pageId,
      url: url,
      pageLabel: pageLabel,
    };
  }

  function topicSemanticStatusMeta(topic) {
    topic = topic || {};
    var status = topic.contextMeta && topic.contextMeta.semanticStatus || {};
    var taskType = String(status.taskType || '').trim();
    var phase = String(status.phase || '').trim();
    var executionTarget = String(status.executionTarget || '').trim();
    var targetSource = String(status.targetSource || '').trim();
    var budget = String(status.contextBudgetProfile || '').trim();
    if (!taskType && !phase && !executionTarget && !targetSource && !budget) return null;
    return {
      taskType: taskType,
      phase: phase,
      executionTarget: executionTarget,
      targetSource: targetSource,
      contextBudgetProfile: budget,
      completionStandard: String(status.completionStandard || '').trim(),
    };
  }

  function topicCapabilityGapPlans(topic, includeClosed) {
    var artifacts = topic && topic.contextMeta && topic.contextMeta.artifacts || {};
    var plans = Array.isArray(artifacts.capabilityGapPlans) ? artifacts.capabilityGapPlans : [];
    return plans.filter(function (item) {
      if (!item || item.type && item.type !== 'capabilityGapPlan') return false;
      var status = String(item.status || 'open').trim();
      return includeClosed || status === 'open' || status === 'accepted';
    }).sort(function (a, b) {
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
  }

  function openCapabilityGapPlans(topic) {
    return topicCapabilityGapPlans(topic, false).filter(function (item) {
      return String(item.status || 'open') === 'open';
    });
  }

  function capabilityGapBadgeHtml(topic) {
    var count = openCapabilityGapPlans(topic).length;
    if (!count) return '';
    return '<button class="conversation-capability-gap-badge" data-conversation-action="open-capability-gaps" title="查看并导出需求">'
      + '<span>能力缺口</span><b>' + esc(count) + '</b>'
      + '</button>';
  }

  function listMarkdown(values) {
    values = Array.isArray(values) ? values : [];
    return values.length ? values.map(function (item) { return '- ' + String(item || '').trim(); }).join('\n') : '- 暂无';
  }

  function capabilityGapMarkdown(topic, gaps) {
    topic = topic || {};
    gaps = Array.isArray(gaps) ? gaps : [];
    var title = topic.name || topic.objective || '对话能力缺口';
    var lines = [
      '# 模型能力缺口待办',
      '',
      '- 话题: ' + title,
      '- topicId: ' + (topic.topicId || ''),
      '- 导出时间: ' + new Date().toISOString(),
      '- 建议落点: docs/conversation-capability-backlog/',
      '',
      '这份待办来自对话运行时的 capabilityGapPlans artifact，用于整理和提交后续版本优化需求。',
      '',
    ];
    if (!gaps.length) {
      lines.push('暂无待提交能力缺口。', '');
      return lines.join('\n');
    }
    gaps.forEach(function (gap, index) {
      lines = lines.concat([
        '## ' + (index + 1) + '. ' + (gap.title || gap.gapKind || '能力缺口'),
        '',
        '- gapId: ' + (gap.id || ''),
        '- status: ' + (gap.status || 'open'),
        '- gapKind: ' + (gap.gapKind || ''),
        '- requirement: ' + (gap.requirement || ''),
        '- currentGoal: ' + (gap.currentGoal || ''),
        '- failedTool: ' + (gap.failedTool || gap.tool || ''),
        '- failedArgPath: ' + (gap.failedArgPath || ''),
        '- requiredEvidence: ' + (gap.requiredEvidence || ''),
        '',
        '### Evidence',
        '',
        gap.evidence || gap.summary || '暂无',
        '',
        '### Tool Searches',
        '',
        listMarkdown(gap.searchQueries),
        '',
        '### Compared Tools',
        '',
        listMarkdown(gap.referencedToolNames),
        '',
        '### Impact',
        '',
        gap.impact || '暂无',
        '',
        '### Suggested Change',
        '',
        gap.suggestedChange || '暂无',
        '',
        '### Files To Change',
        '',
        listMarkdown(gap.filesToChange),
        '',
        '### Suggested Artifacts',
        '',
        listMarkdown((gap.suggestedArtifacts || []).map(function (artifact) {
          return (artifact.exists ? '[exists] ' : '[missing] ') + artifact.ref + ' - ' + artifact.purpose;
        })),
        '',
        '### Next Steps',
        '',
        listMarkdown(gap.nextSteps),
        '',
      ]);
    });
    return lines.join('\n');
  }

  function capabilityGapFileName(topic) {
    var title = topic && (topic.name || topic.objective) || 'topic';
    return 'conversation-capability-backlog-' + safeFileName(title).slice(0, 70) + '-' + safeTimestamp(Date.now()) + '.md';
  }

  function renderCapabilityGapInbox(topic) {
    var gaps = topicCapabilityGapPlans(topic, true);
    if (!gaps.length) return '<div class="placeholder">暂无能力缺口</div>';
    return '<div class="conversation-capability-gap-list">'
      + gaps.map(function (gap) {
        var status = String(gap.status || 'open');
        return '<article class="conversation-capability-gap-card">'
          + '<header><b>' + esc(gap.title || gap.gapKind || '能力缺口') + '</b><span class="badge status-' + esc(status === 'open' ? 'failed' : 'success') + '">' + esc(statusLabel(status)) + '</span></header>'
          + '<div class="conversation-config-row conversation-config-row-wide"><b>要求</b><div>' + esc(gap.requirement || gap.currentGoal || '未记录') + '</div></div>'
          + '<div class="conversation-config-row"><b>类型</b><span>' + esc(gap.gapKind || 'capability_gap') + '</span></div>'
          + '<div class="conversation-config-row"><b>已比较工具</b><span>' + esc((gap.referencedToolNames || []).join(', ') || '无匹配') + '</span></div>'
          + '<div class="conversation-config-row conversation-config-row-wide"><b>建议</b><div>' + esc(gap.suggestedChange || gap.summary || '暂无') + '</div></div>'
          + '<details><summary>证据和修改点</summary>'
          + '<pre>' + esc([
            gap.evidence ? 'Evidence:\n' + gap.evidence : '',
            gap.impact ? 'Impact:\n' + gap.impact : '',
            gap.filesToChange && gap.filesToChange.length ? 'Files:\n' + gap.filesToChange.join('\n') : '',
            gap.nextSteps && gap.nextSteps.length ? 'Next:\n' + gap.nextSteps.join('\n') : '',
          ].filter(Boolean).join('\n\n')) + '</pre>'
          + '</details>'
          + '</article>';
      }).join('')
      + '</div>';
  }

  function updateCapabilityGapStatuses(topic, gaps, status) {
    if (!topic || !topic.topicId) return Promise.resolve();
    var ids = {};
    (gaps || []).forEach(function (gap) {
      if (gap && gap.id) ids[gap.id] = true;
    });
    if (!Object.keys(ids).length) return Promise.resolve();
    var meta = topic.contextMeta || {};
    var artifacts = Object.assign({}, meta.artifacts || {});
    artifacts.capabilityGapPlans = (Array.isArray(artifacts.capabilityGapPlans) ? artifacts.capabilityGapPlans : []).map(function (gap) {
      if (!gap || !ids[gap.id]) return gap;
      return Object.assign({}, gap, { status: status, exportedAt: Date.now(), updatedAt: Date.now() });
    });
    return patchConversationResource(topic.topicId, {
      contextMeta: Object.assign({}, meta, { artifacts: artifacts }),
    });
  }

  function goalReasonLabel(reason) {
    var map = {
      topic_created: '创建话题',
      latest_user_request: '用户最新请求',
      user_requested_execution: '用户要求执行',
      user_requested_execution_from_existing_analysis: '沿用已有分析执行',
      user_requested_summary_or_review: '用户要求总结/审查',
      user_requested_stop_or_summary: '用户要求停止/收束',
      user_requested_retry_or_restart: '用户要求重试',
      user_requested_correction: '用户纠错',
      pending_clean_context_from_previous_failure: '失败后重开上下文',
      default_to_clean_analysis_context: '分析请求使用干净上下文',
    };
    var repeated = String(reason || '').match(/^repeated_(.+)_threshold_(\d+)$/);
    if (repeated) return '连续 ' + repeated[1] + ' 达到阈值 ' + repeated[2];
    return map[reason] || reason || '未变更';
  }

  function renderGoalGuardBar(topic) {
    if (!topic) return '';
    var goal = topicGoalMeta(topic);
    if (!goal.currentGoal && !goal.originalGoal) return '';
    var current = goal.currentGoal || goal.originalGoal || '未设置';
    var original = goal.originalGoal || current;
    var reason = goalReasonLabel(goal.goalChangeReason);
    var changed = current && original && current !== original;
    var meta = changed ? '已按最新请求调整' : reason;
    var title = [
      '任务焦点: ' + current,
      '初始诉求: ' + original,
      '调整依据: ' + reason,
    ].join('\n');
    return '<div class="conversation-goal-focus" aria-label="任务焦点" title="' + esc(title) + '">'
      + '<span class="conversation-goal-focus-label">任务焦点</span>'
      + '<span class="conversation-goal-focus-text">' + esc(current) + '</span>'
      + '<span class="conversation-goal-focus-meta">' + esc(meta) + '</span>'
      + (goal.pendingCleanContext
        ? '<em title="' + esc(goal.cleanContextTriggerReason || '下一轮将使用干净上下文') + '">下轮重整上下文</em>'
        : '')
      + '</div>';
  }

  function renderEntryStatusBar(topic) {
    var status = topicEntryStatusMeta(topic);
    if (!status) return '';
    var title = [
      'entry: ' + (status.entry || ''),
      'tabId: ' + (status.tabId || ''),
      'windowId: ' + (status.windowId || ''),
      'pageId: ' + (status.pageId || ''),
      'pageLabel: ' + (status.pageLabel || ''),
      'url: ' + (status.url || ''),
    ].join('\n');
    return '<div class="conversation-entry-status" aria-label="入口状态" title="' + esc(title) + '">'
      + '<span class="conversation-entry-status-label">入口状态</span>'
      + (status.entry ? '<span class="conversation-entry-status-chip">' + esc(status.entry) + '</span>' : '')
      + (status.tabId ? '<span class="conversation-entry-status-chip">tabId: ' + esc(status.tabId) + '</span>' : '')
      + (status.windowId ? '<span class="conversation-entry-status-chip">windowId: ' + esc(status.windowId) + '</span>' : '')
      + (status.pageId ? '<span class="conversation-entry-status-chip">pageId: ' + esc(status.pageId) + '</span>' : '')
      + (status.pageLabel ? '<span class="conversation-entry-status-chip">' + esc(status.pageLabel) + '</span>' : '')
      + (status.url ? '<span class="conversation-entry-status-url">' + esc(status.url) + '</span>' : '')
      + '</div>';
  }

  function renderSemanticStatusBar(topic) {
    var status = topicSemanticStatusMeta(topic);
    if (!status) return '';
    var title = [
      'taskType: ' + (status.taskType || ''),
      'phase: ' + statusLabel(status.phase),
      'executionTarget: ' + (status.executionTarget || ''),
      'targetSource: ' + (status.targetSource || ''),
      'contextBudgetProfile: ' + (status.contextBudgetProfile || ''),
      'completionStandard: ' + (status.completionStandard || ''),
    ].join('\n');
    return '<div class="conversation-entry-status conversation-semantic-status" aria-label="语义状态" title="' + esc(title) + '">'
      + '<span class="conversation-entry-status-label">语义状态</span>'
      + (status.taskType ? '<span class="conversation-entry-status-chip">' + esc(status.taskType) + '</span>' : '')
      + (status.phase ? '<span class="conversation-entry-status-chip">' + esc(statusLabel(status.phase)) + '</span>' : '')
      + (status.executionTarget ? '<span class="conversation-entry-status-chip">' + esc(status.executionTarget) + '</span>' : '')
      + (status.contextBudgetProfile ? '<span class="conversation-entry-status-chip">' + esc(status.contextBudgetProfile) + '</span>' : '')
      + '</div>';
  }

  function renderTopicGoalConfig(topic) {
    var goal = topicGoalMeta(topic);
    var clean = goal.pendingCleanContext
      ? '待重开' + (goal.cleanContextTriggerReason ? ' · ' + goal.cleanContextTriggerReason : '')
      : '无';
    var failure = goal.lastFailureKind
      ? goal.lastFailureKind + ' · 连续 ' + goal.repeatedFailureCount + ' / ' + CLEAN_CONTEXT_FAILURE_THRESHOLD
      : '无';
    var policy = goal.decisionPolicy || {};
    var outcome = goal.decisionOutcome || {};
    var permissionGroups = Array.isArray(policy.allowedPermissionGroups) ? policy.allowedPermissionGroups.join('/') : '';
    return '<div class="conversation-config-card">'
      + '<h3>任务焦点</h3>'
      + '<div class="conversation-config-row conversation-config-row-wide"><b>正在处理</b><div title="' + esc(goal.currentGoal || '未设置') + '">' + esc(goal.currentGoal || '未设置') + '</div></div>'
      + '<div class="conversation-config-row conversation-config-row-wide"><b>初始诉求</b><div title="' + esc(goal.originalGoal || '未设置') + '">' + esc(goal.originalGoal || '未设置') + '</div></div>'
      + '<div class="conversation-config-row"><b>调整依据</b><span>' + esc(goalReasonLabel(goal.goalChangeReason)) + '</span></div>'
      + '<div class="conversation-config-row"><b>上下文窗口</b><span>第 ' + esc(goal.windowNumber || 0) + ' 窗口</span></div>'
      + '<div class="conversation-config-row"><b>上下文策略</b><span>' + esc(goal.lastContextMode || '未运行') + '</span></div>'
      + '<div class="conversation-config-row"><b>知识策略</b><span>' + esc(goal.lastKnowledgeMode || '未运行') + '</span></div>'
      + '<div class="conversation-config-row"><b>决策风险</b><span>' + esc(policy.riskLevel || '未评估') + '</span></div>'
      + '<div class="conversation-config-row"><b>允许副作用</b><span>' + esc(permissionGroups || '无') + '</span></div>'
      + '<div class="conversation-config-row"><b>验证结果</b><span>' + esc(statusLabel(outcome.status) || '未运行') + '</span></div>'
      + '<div class="conversation-config-row"><b>重整上下文</b><span>' + esc(clean) + '</span></div>'
      + '<div class="conversation-config-row"><b>失败恢复</b><span>' + esc(failure) + '</span></div>'
      + '</div>';
  }

  function renderAssistantPanel(assistant, topic) {
    var activeTab = sidebarTab === 'topics' ? 'topics' : 'assistant';
    var assistantItems = (state.assistantOrder || []).map(function (id) {
      var item = state.assistants[id];
      var active = assistant && assistant.id === id ? ' selected' : '';
      var assistantIndex = (state.assistantOrder || []).indexOf(id);
      return '<div class="conversation-assistant-row' + active + '" data-assistant-id="' + esc(id) + '" draggable="false">'
        + '<button class="conversation-assistant-item" data-conversation-action="select-assistant" data-assistant-id="' + esc(id) + '">'
        + '<span class="conversation-assistant-drag-handle" aria-hidden="true">⋮⋮</span>'
        + '<span class="conversation-assistant-name">' + esc(item.name) + '</span>'
        + '</button>'
        + '<button class="conversation-sidebar-icon-btn conversation-assistant-more" data-conversation-action="toggle-assistant-menu" data-assistant-id="' + esc(id) + '" title="助手操作">&#8942;</button>'
        + (assistantMenuOpen === id ? '<div class="conversation-assistant-menu">'
          + (assistantIndex > 0 ? '<button data-conversation-action="pin-assistant" data-assistant-id="' + esc(id) + '">置顶</button>' : '')
          + '<button data-conversation-action="edit-assistant" data-assistant-id="' + esc(id) + '">编辑助手</button>'
          + '<button data-conversation-action="copy-assistant" data-assistant-id="' + esc(id) + '">复制助手</button>'
          + '<button data-conversation-action="clear-assistant-topics" data-assistant-id="' + esc(id) + '">清空话题</button>'
          + '<button class="danger" data-conversation-action="delete-assistant" data-assistant-id="' + esc(id) + '">删除助手</button>'
          + '</div>' : '')
        + '</div>';
    }).join('');
    var topicIds = (state.topicOrder || []).filter(function (id) {
      var item = state.topics[id];
      return item && assistant && item.assistantId === assistant.id;
    });
    var topics = topicIds.map(function (id) {
      var item = state.topics[id];
      var active = topic && topic.topicId === id ? ' selected' : '';
      var running = topicIsRunning(item);
      var topicActions = (item.archived ? ''
        : '<button data-conversation-action="archive-topic-id" data-topic-id="' + esc(id) + '"' + (running ? ' disabled' : '') + '>归档话题</button>')
        + '<button class="danger" data-conversation-action="delete-topic-id" data-topic-id="' + esc(id) + '"' + (running ? ' disabled' : '') + '>删除话题</button>';
      return '<div class="conversation-topic-row' + active + '">'
        + '<button class="conversation-topic-item" data-conversation-action="select-topic" data-topic-id="' + esc(id) + '">'
        + '<span class="conversation-topic-title">' + esc(item.name || item.objective || '未命名话题') + '</span>'
        + (item.archived ? '<span class="conversation-topic-archive-label">归档</span>' : '')
        + '</button>'
        + '<button class="conversation-sidebar-icon-btn conversation-assistant-more conversation-topic-more" data-conversation-action="toggle-topic-menu" data-topic-id="' + esc(id) + '" title="话题操作">&#8942;</button>'
        + (topicMenuOpen === id ? '<div class="conversation-assistant-menu conversation-topic-menu">' + topicActions + '</div>' : '')
        + '</div>';
    }).join('');
    var assistantContent = '<div class="conversation-sidebar-content">'
      + '<button class="conversation-sidebar-add" data-conversation-action="create-assistant"><span>+</span><span>添加助手</span></button>'
      + '<div class="conversation-assistant-list">' + assistantItems + '</div>'
      + '</div>';
    var topicContent = '<div class="conversation-sidebar-content">'
      + '<button class="conversation-sidebar-add" data-conversation-action="new-topic"><span>+</span><span>新建话题</span></button>'
      + '<div class="conversation-topic-list">'
      + (topics || '<div class="placeholder">还没有话题</div>')
      + '</div>'
      + '</div>';
    return '<aside class="conversation-sidebar">'
      + '<div class="conversation-sidebar-tabs">'
      + '<button class="' + (activeTab === 'assistant' ? 'selected' : '') + '" data-conversation-action="select-sidebar-tab" data-side-tab="assistant">助手</button>'
      + '<button class="' + (activeTab === 'topics' ? 'selected' : '') + '" data-conversation-action="select-sidebar-tab" data-side-tab="topics">话题</button>'
      + '</div>'
      + (activeTab === 'assistant' ? assistantContent : topicContent)
      + '</aside>';
  }

  function renderEvent(event, index, readOnly) {
    return conversationShared.renderEvent(event, index, {
      readOnly: readOnly,
      topicId: displayedTopic() && displayedTopic().topicId || '',
    });
  }

  function renderStreamEvents(topic) {
    if (!topic) return '<div class="placeholder">等待对话</div>';
    if (topic.archived && !archivedTopicById[topic.topicId]) {
      return '<div class="placeholder">正在加载归档内容</div>';
    }
    var allEvents = visibleTopicEvents(topic);
    /* Event rows are rendered by the virtual list. Only emit a bounded shell
       here; mapping every loaded event to HTML defeats virtualization. */
    return allEvents.length ? '' : '<div class="placeholder">等待对话</div>';
  }

  function renderPendingUserInput(topic) {
    var pending = topic && topic.pendingUserInput;
    if (!pending || !Array.isArray(pending.questions) || !pending.questions.length) return '';
    var questions = pending.questions.map(function (question, questionIndex) {
      var name = 'conversation-user-input-' + questionIndex;
      var options = (question.options || []).map(function (option, optionIndex) {
        var id = name + '-' + optionIndex;
        return '<label class="conversation-user-input-option" for="' + esc(id) + '">'
          + '<input id="' + esc(id) + '" type="radio" name="' + esc(name) + '" value="' + esc(option.label) + '" data-question-id="' + esc(question.id) + '"' + (optionIndex === 0 ? ' checked' : '') + '>'
          + '<span><b>' + esc(option.label) + '</b><small>' + esc(option.description) + '</small></span>'
          + '</label>';
      }).join('');
      var otherId = name + '-other';
      return '<fieldset class="conversation-user-input-question" data-question-id="' + esc(question.id) + '">'
        + '<legend><span>' + esc(question.header) + '</span>' + esc(question.question) + '</legend>'
        + '<div class="conversation-user-input-options">' + options
        + '<label class="conversation-user-input-option conversation-user-input-custom" for="' + esc(otherId) + '">'
        + '<input id="' + esc(otherId) + '" type="radio" name="' + esc(name) + '" value="__other__" data-question-id="' + esc(question.id) + '">'
        + '<span><b>其他</b><input type="text" maxlength="1000" class="conversation-user-input-other" data-question-id="' + esc(question.id) + '" placeholder="输入回答"></span>'
        + '</label></div></fieldset>';
    }).join('');
    return '<section class="conversation-user-input" data-request-id="' + esc(pending.requestId) + '" data-topic-id="' + esc(topic.topicId) + '">'
      + questions
      + '<div class="conversation-user-input-actions">'
      + '<button type="button" class="btn-danger" data-conversation-action="stop-topic">停止</button>'
      + '<button type="button" class="btn-primary" data-conversation-action="submit-user-input">提交回答</button>'
      + '</div></section>';
  }

  function isStreamPinnedToBottom(stream) {
    if (!stream) return true;
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 96;
  }

  function conversationInteractionKey(topic, controlledElsewhere) {
    if (controlledElsewhere) {
      return 'remote:' + (topic && topic.pendingUserInput && topic.pendingUserInput.requestId || 'running');
    }
    if (topic && topic.archived) return 'archived';
    if (topic && topic.pendingUserInput) return 'pending:' + String(topic.pendingUserInput.requestId || '');
    var running = topicIsRunning(topic);
    var stopping = topic && (topic.phase === 'stopping' || topic.status === 'cancelling');
    return 'composer:' + (running ? (stopping ? 'stopping' : 'running') : 'idle')
      + ':' + currentConversationServiceId(topic)
      + ':' + (anyConversationRunning() ? 'locked' : 'unlocked');
  }

  function renderStream(topic, assistant, eventsHtml, controlledElsewhere) {
    var archived = !!(topic && topic.archived);
    var archivedLogAction = archived && topic && topic.topicId
      ? '<button class="conversation-chat-log-btn" data-conversation-action="open-topic-trajectory" title="查看当前话题的运行轨迹">轨迹</button>'
      : '';
    var running = topicIsRunning(topic);
    var serviceSwitchLocked = running || anyConversationRunning();
    var stopping = topic && (topic.phase === 'stopping' || topic.status === 'cancelling');
    var title = topic ? (topic.name || topic.objective || '新话题') : (assistant && assistant.name || '对话');
    var subtitle = topic ? '' : '未创建话题';
    var draftKey = currentDraftKey(topic, assistant);
    var draftValue = Object.prototype.hasOwnProperty.call(composerDrafts, draftKey) ? composerDrafts[draftKey] : '';
    var pendingUserInput = topic && topic.pendingUserInput;
    var html = '<section class="conversation-topic-main">'
      + '<div class="conversation-chat-toolbar">'
      + '<div class="conversation-chat-title"><b>' + esc(assistant && assistant.name || '助手') + '</b><span>' + esc(title) + '</span></div>'
      + '<div class="conversation-chat-actions">'
      + (!archived && !controlledElsewhere ? capabilityGapBadgeHtml(topic) : '')
      + archivedLogAction
      + (topic ? '<button class="conversation-chat-log-btn" data-conversation-action="export-topic-archive" data-topic-id="' + esc(topic.topicId) + '" title="导出对话 JSON、Markdown 和图片 ZIP">导出</button>' : '')
      + '<button class="conversation-chat-log-btn" data-conversation-action="import-topic-archive" title="从完整对话 ZIP 恢复对话与图片">导入</button>'
      + (archived ? '<span class="badge conversation-archived-badge">已归档</span>' : (topic ? '<span class="badge status-' + conversationStatusBadgeTone(topic.status) + '">' + esc(statusLabel(topic.status)) + '</span>' : ''))
      + (archived ? '' : '<button class="conversation-chat-config-btn" data-conversation-action="open-topic-config" title="' + (controlledElsewhere ? '运行期间仅可查看对话' : '配置产物和运行') + '"' + (controlledElsewhere ? ' disabled' : '') + '>☷</button>')
      + '</div>'
      + '</div>'
      + (subtitle ? '<div class="conversation-chat-subtitle">' + esc(subtitle) + '</div>' : '')
      + '<div class="conversation-runtime-meta">'
      + renderGoalGuardBar(topic)
      + renderEntryStatusBar(topic)
      + renderSemanticStatusBar(topic)
      + '</div>';
    var events = eventsHtml !== undefined ? eventsHtml : renderStreamEvents(topic);
    var interaction = archived
      ? '<div class="conversation-archive-readonly"><span aria-hidden="true">&#xf187;</span><b>已归档</b><small>只读</small></div>'
      : (pendingUserInput ? renderPendingUserInput(topic) : (
      '<div class="conversation-composer">'
      + '<textarea id="conversation-input" rows="4" placeholder="描述要创建或修复的流程。' + esc(sendShortcutLabel()) + ' 发送。">' + esc(draftValue) + '</textarea>'
      + '<div class="conversation-composer-actions">'
      + '<div class="conversation-composer-service">' + renderGeneratorServiceSelect(serviceSwitchLocked, topic) + '</div>'
      + '<div class="conversation-composer-submit">'
      + '<button class="btn-primary" data-conversation-action="send-message"' + (stopping ? ' disabled' : '') + '>发送</button>'
      + (running ? '<button class="btn-danger" data-conversation-action="stop-topic"' + (stopping ? ' disabled' : '') + '>' + (stopping ? '停止中' : '停止') + '</button>' : '')
      + '</div>'
      + '</div>'
      + '</div>'
      ));
    var renderedInteraction = controlledElsewhere
      ? '<div class="conversation-readonly-interaction">'
        + '<div class="conversation-readonly-interaction-content" inert aria-hidden="true">' + interaction + '</div>'
        + '<div class="conversation-remote-run" role="status" aria-live="polite">'
        + '<b>正在其他页面运行</b><span>' + (pendingUserInput
          ? '请在发起对话的页面底部提交回答'
          : '每 5 秒自动刷新读取快照') + '</span>'
        + '</div>'
        + '</div>'
      : interaction;
    return html
      + '<div class="conversation-event-stream' + (controlledElsewhere || archived ? ' conversation-event-stream-readonly' : '') + '" id="conversation-event-stream" data-topic-id="' + esc(topic && topic.topicId || '') + '">' + events + '</div>'
      + '<div class="conversation-steering-slot">' + conversationShared.renderPendingSteering(topic && topic.pendingSteeringMessages, {
          canInterrupt: running && !pendingUserInput && !controlledElsewhere && !stopping,
          interrupting: !!(topic && interruptingModelRequestByTopic[topic.topicId]),
        }) + '</div>'
      + '<div class="conversation-interaction-slot" data-interaction-key="'
      + esc(conversationInteractionKey(topic, controlledElsewhere)) + '">' + renderedInteraction + '</div>'
      + '</section>';
  }

  function renderConfigPanelContent(topic) {
    if (!topic) return '<div class="placeholder">暂无配置产物</div>';
    var ids = topic.generatedConfigIds || { pages: [], flows: [], flowGroups: [] };
    var flowId = topic.activeFlowId || ids.flows && ids.flows[0] || '';
    var activeTab = topicConfigTab === 'permissions' ? 'permissions' : 'run';
    var runAssistant = assistantForTopicRun(topic, activeAssistant());
    function idList(values) {
      values = values || [];
      return values.length ? values.map(function (id) { return '<code>' + esc(id) + '</code>'; }).join('') : '<span class="conversation-muted">无</span>';
    }
    return '<div class="conversation-config-panel">'
      + renderDrawerTabs('topic-config', activeTab, [
        { id: 'run', label: '配置产物与运行' },
        { id: 'permissions', label: '模式和权限' },
      ])
      + '<section class="conversation-tab-panel' + (activeTab === 'run' ? ' active' : '') + '" data-conversation-tab-panel-group="topic-config" data-conversation-tab-panel="run">'
      + renderTopicGoalConfig(topic)
      + '<div class="conversation-config-card">'
      + '<h3>配置产物</h3>'
      + '<div class="conversation-config-row"><b>Pages</b><div>' + idList(ids.pages) + '</div></div>'
      + '<div class="conversation-config-row"><b>Flows</b><div>' + idList(ids.flows) + '</div></div>'
      + '<div class="conversation-config-row"><b>Groups</b><div>' + idList(ids.flowGroups) + '</div></div>'
      + '</div>'
      + '<div class="conversation-config-card">'
      + '<h3>运行</h3>'
      + '<div class="form-row"><label>运行入参 JSON</label><textarea id="conversation-run-input" rows="6">' + esc(runInputTextForTopic(topic)) + '</textarea></div>'
      + '<div class="conversation-panel-actions">'
      + '<button class="btn-secondary" data-conversation-action="validate-flow" ' + (flowId ? '' : 'disabled') + '>校验</button>'
      + '<button class="btn-primary" data-conversation-action="run-flow" ' + (flowId ? '' : 'disabled') + '>运行</button>'
      + '<button class="btn-secondary" data-conversation-action="continue-repair" ' + (topic.lastRunStatus && topic.lastRunStatus !== 'success' ? '' : 'disabled') + '>继续修复</button>'
      + '</div>'
      + '</div>'
      + '<div class="conversation-config-card">'
      + '<h3>预算</h3>'
      + '<div class="conversation-config-row"><b>轮次</b><span>' + esc(topic.counters && topic.counters.iterationCount || 0) + ' / ' + esc(topic.budgets && topic.budgets.maxIterations || '-') + '</span></div>'
      + '<div class="conversation-config-row"><b>工具</b><span>' + esc(topic.counters && topic.counters.toolCallCount || 0) + ' / ' + esc(topic.budgets && topic.budgets.maxToolCalls || '-') + '</span></div>'
      + '<div class="conversation-config-row"><b>上下文</b><span>' + (topic.budgets && topic.budgets.maxContextTokens ? esc(topic.budgets.maxContextTokens) + ' tokens' : '跟随模型服务') + '</span></div>'
      + '</div>'
      + '</section>'
      + '<section class="conversation-tab-panel' + (activeTab === 'permissions' ? ' active' : '') + '" data-conversation-tab-panel-group="topic-config" data-conversation-tab-panel="permissions">'
      + renderModePermissionControls(runAssistant, 'conversation-topic-permissions')
      + '</section>'
      + '</div>';
  }

  function sidebarCatalogSignature() {
    if (!state) return '';
    var assistants = (state.assistantOrder || []).map(function (id) {
      var assistant = state.assistants && state.assistants[id] || {};
      return [id, assistant.name || ''].join(':');
    });
    var assistant = selectedAssistant();
    var topics = (state.topicOrder || []).map(function (id) {
      var topic = state.topics && state.topics[id];
      if (!topic || !assistant || topic.assistantId !== assistant.id) return '';
      return [id, topic.name || '', topic.objective || '', topic.archived ? 1 : 0].join(':');
    }).filter(Boolean);
    return assistants.concat(topics).join('|');
  }

  function renderKeyFor(assistant, topic) {
    var title = topic ? (topic.name || topic.objective || '') : '';
    var subtitle = '';
    var goal = topic ? topicGoalMeta(topic) : {};
    var entryStatus = topic ? topicEntryStatusMeta(topic) : null;
    var semanticStatus = topic ? topicSemanticStatusMeta(topic) : null;
    return [
      sidebarCollapsed ? 'collapsed' : 'expanded',
      sidebarTab,
      sidebarCatalogSignature(),
      assistantMenuOpen || '',
      topicMenuOpen || '',
      assistant && assistant.id || '',
      topic && topic.topicId || '',
      topic && topic.status || '',
      title,
      subtitle,
      goal.currentGoal || '',
      goal.originalGoal || '',
      goal.goalChangeReason || '',
      goal.lastContextMode || '',
      goal.lastKnowledgeMode || '',
      goal.decisionPolicy && goal.decisionPolicy.riskLevel || '',
      goal.decisionPolicy && Array.isArray(goal.decisionPolicy.allowedPermissionGroups) ? goal.decisionPolicy.allowedPermissionGroups.join(',') : '',
      goal.decisionOutcome && goal.decisionOutcome.status || '',
      goal.pendingCleanContext ? 'pending-clean' : '',
      goal.repeatedFailureCount || 0,
      goal.windowNumber || 0,
      entryStatus && entryStatus.entry || '',
      entryStatus && entryStatus.tabId || 0,
      entryStatus && entryStatus.windowId || 0,
      entryStatus && entryStatus.pageId || '',
      entryStatus && entryStatus.url || '',
      entryStatus && entryStatus.pageLabel || '',
      semanticStatus && semanticStatus.taskType || '',
      semanticStatus && semanticStatus.phase || '',
      semanticStatus && semanticStatus.executionTarget || '',
      semanticStatus && semanticStatus.contextBudgetProfile || '',
      topic && topic.phase || '',
      topic && topic.pendingUserInput && topic.pendingUserInput.requestId || '',
      topic && topicTrajectoryItems(topic).length ? 'trace-ready' : '',
      topic ? openCapabilityGapPlans(topic).length : 0,
      topic ? currentConversationServiceId(topic) : currentConversationServiceId(null),
    ].join('\u001f');
  }

  function sidebarRenderKey(assistant, topic) {
    return [
      sidebarCollapsed ? 'collapsed' : 'expanded',
      sidebarTab,
      sidebarCatalogSignature(),
      assistantMenuOpen || '',
      topicMenuOpen || '',
      assistant && assistant.id || '',
      topic && topic.topicId || '',
    ].join('\u001f');
  }

  function patchEventStream(topic, scrollState) {
    var stream = $('#conversation-event-stream');
    if (!stream) return false;
    scrollState = scrollState || {};
    var topicId = String(topic && topic.topicId || '');
    var replacingList = !conversationVirtualList || conversationVirtualContainer !== stream;
    var preserveScroll = scrollState.preserveScroll === true;
    if (preserveScroll && eventStreamForceFollowTopicId === topicId) eventStreamForceFollowTopicId = '';
    var forceFollow = !preserveScroll && !!(topicId && eventStreamForceFollowTopicId === topicId);
    var shouldStick = !preserveScroll && (
      forceFollow || (typeof scrollState.stickToEnd === 'boolean'
        ? scrollState.stickToEnd
        : (replacingList ? true : isStreamPinnedToBottom(stream)))
    );
    if (replacingList) {
      if (conversationVirtualList) conversationVirtualList.destroy();
      conversationVirtualContainer = stream;
      conversationVirtualList = conversationListView.createVirtualList({
        container: stream,
        document: document,
        estimatedRowHeight: 104,
        virtualize: true,
        disclosureState: eventDisclosureState,
        disclosurePrefix: topicId,
        renderItem: function (event, index) {
          return renderEvent(event, index, displayedTopic() && displayedTopic().archived === true);
        },
        onRendered: function (rows) { hydrateConversationImages(rows); },
      });
    }
    setConversationHistoryLoading(stream, stream.dataset.loadingOlder === 'true');
    var events = visibleTopicEvents(topic);
    var placeholder = stream.querySelector('[data-conversation-empty]');
    if (!events.length) {
      conversationVirtualList.setItems([], { preserveAnchor: true });
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'placeholder';
        placeholder.setAttribute('data-conversation-empty', '');
        stream.appendChild(placeholder);
      }
      placeholder.textContent = topic && topic.archived && !archivedTopicById[topic.topicId]
        ? '正在加载归档内容' : '等待对话';
      stream.dataset.previousScrollTop = String(Math.max(0, Number(stream.scrollTop) || 0));
      return true;
    }
    if (placeholder) placeholder.remove();
    conversationVirtualList.setItems(events, {
      preserveAnchor: !shouldStick && scrollState.preserveScroll !== true,
      stickToEnd: shouldStick,
      scrollTop: !shouldStick && replacingList ? scrollState.scrollTop : undefined,
    });
    stream.dataset.previousScrollTop = String(Math.max(0, Number(stream.scrollTop) || 0));
    if (forceFollow) eventStreamForceFollowTopicId = '';
    return true;
  }

  function setConversationHistoryLoading(stream, active) {
    if (!stream) return;
    var indicator = stream.querySelector('[data-conversation-history-loading]');
    if (!indicator && !active) return;
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'conversation-history-loading';
      indicator.setAttribute('data-conversation-history-loading', '');
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.textContent = '正在加载更早消息...';
      stream.insertBefore(indicator, stream.firstChild || null);
    }
    indicator.hidden = !active;
  }

  function patchConversationShell(topic, assistant, controlledElsewhere) {
    var rootEl = $('#conversation-root');
    if (!rootEl) return;
    var title = topic ? (topic.name || topic.objective || '新话题') : (assistant && assistant.name || '对话');
    var titleEl = rootEl.querySelector('.conversation-chat-title');
    if (titleEl) {
      var assistantTitle = titleEl.querySelector('b');
      var topicTitle = titleEl.querySelector('span');
      if (assistantTitle) assistantTitle.textContent = assistant && assistant.name || '助手';
      if (topicTitle) topicTitle.textContent = title;
    }
    var status = rootEl.querySelector('.conversation-chat-actions > .badge[class*="status-"]');
    if (status && topic) {
      status.className = 'badge status-' + conversationStatusBadgeTone(topic.status);
      status.textContent = statusLabel(topic.status);
    }
    var config = rootEl.querySelector('.conversation-chat-config-btn');
    if (config) {
      config.disabled = !!controlledElsewhere || !!(topic && topic.archived);
      config.title = controlledElsewhere ? '运行期间仅可查看对话' : '配置产物和运行';
    }
  }

  function patchConversationSidebar(assistant, topic) {
    var rootEl = $('#conversation-root');
    var layout = rootEl && rootEl.querySelector('.conversation-layout');
    if (!layout) return;
    layout.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    var collapse = layout.querySelector('.conversation-sidebar-collapse-btn');
    if (collapse) {
      collapse.title = sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏';
      collapse.setAttribute('aria-label', collapse.title);
    }
    var nextKey = sidebarRenderKey(assistant, topic);
    if (nextKey === lastSidebarRenderKey) return;
    var currentSidebar = layout.querySelector('.conversation-sidebar');
    if (currentSidebar) {
      var staging = document.createElement('div');
      staging.innerHTML = renderAssistantPanel(assistant, topic);
      var nextSidebar = staging.firstElementChild;
      if (nextSidebar) currentSidebar.replaceWith(nextSidebar);
    }
    lastSidebarRenderKey = nextKey;
  }

  function patchRuntimeConversationView(topic) {
    var stream = $('#conversation-event-stream');
    var currentTopicId = String(stream && stream.dataset && stream.dataset.topicId || '');
    var topicId = String(topic && topic.topicId || '');
    if (!stream || !topicId || currentTopicId !== topicId) return false;
    var assistant = selectedAssistant();
    var controlledElsewhere = topicControlledElsewhere(topic);
    patchConversationSidebar(assistant, topic);
    patchConversationShell(topic, assistant, controlledElsewhere);
    /* Render only the bounded controls into a detached node. The existing root,
       sidebar, composer container and event stream remain mounted. */
    var staging = document.createElement('div');
    staging.innerHTML = renderStream(topic, assistantForTopicRun(topic, assistant), '', controlledElsewhere);
    var currentActions = $('#conversation-root .conversation-chat-actions');
    var nextActions = staging.querySelector('.conversation-chat-actions');
    if (currentActions && nextActions && currentActions.innerHTML !== nextActions.innerHTML) {
      currentActions.innerHTML = nextActions.innerHTML;
    }
    var currentMeta = $('#conversation-root .conversation-runtime-meta');
    var nextMeta = staging.querySelector('.conversation-runtime-meta');
    if (currentMeta && nextMeta && currentMeta.innerHTML !== nextMeta.innerHTML) {
      currentMeta.innerHTML = nextMeta.innerHTML;
    }
    var currentSteering = $('#conversation-root .conversation-steering-slot');
    var nextSteering = staging.querySelector('.conversation-steering-slot');
    if (currentSteering && nextSteering && currentSteering.innerHTML !== nextSteering.innerHTML) {
      currentSteering.innerHTML = nextSteering.innerHTML;
    }
    var currentInteraction = $('#conversation-root .conversation-interaction-slot');
    var nextInteraction = staging.querySelector('.conversation-interaction-slot');
    if (currentInteraction && nextInteraction
        && currentInteraction.getAttribute('data-interaction-key') !== nextInteraction.getAttribute('data-interaction-key')) {
      var currentComposer = currentInteraction.querySelector('.conversation-composer');
      var nextComposer = nextInteraction.querySelector('.conversation-composer');
      if (currentComposer && nextComposer) {
        /* The composer is resident across idle/running/completed transitions,
           matching Harness' DOM-identity contract. Only its bounded controls
           change; the textarea node and its selection remain untouched. */
        var currentService = currentComposer.querySelector('.conversation-composer-service');
        var nextService = nextComposer.querySelector('.conversation-composer-service');
        if (currentService && nextService && currentService.innerHTML !== nextService.innerHTML) {
          currentService.innerHTML = nextService.innerHTML;
        }
        var currentSubmit = currentComposer.querySelector('.conversation-composer-submit');
        var nextSubmit = nextComposer.querySelector('.conversation-composer-submit');
        if (currentSubmit && nextSubmit && currentSubmit.innerHTML !== nextSubmit.innerHTML) {
          currentSubmit.innerHTML = nextSubmit.innerHTML;
        }
        currentInteraction.setAttribute('data-interaction-key',
          nextInteraction.getAttribute('data-interaction-key') || '');
      } else {
        currentInteraction.replaceWith(nextInteraction);
      }
    }
    stream.classList.toggle('conversation-event-stream-readonly', !!controlledElsewhere || !!(topic && topic.archived));
    patchEventStream(topic);
    lastRenderKey = renderKeyFor(assistant, topic) + (controlledElsewhere ? '\u001fcontrolledElsewhere' : '');
    return true;
  }

  function renderLoaded() {
    var rootEl = $('#conversation-root');
    if (!rootEl || !state) return;
    var assistant = selectedAssistant();
    var topic = displayedTopic();
    if (topic && topic.archived && !archivedTopicById[topic.topicId]) loadDisplayedArchivedTopic(topic);
    var streamAssistant = topic ? assistantForTopicRun(topic, assistant) : assistant;
    var controlledElsewhere = topicControlledElsewhere(topic);
    syncReadonlySnapshotRefresh(topic, controlledElsewhere);
    if (trajectoryViewOpen) {
      if (!topic || !topic.topicId) {
        trajectoryViewOpen = false;
        stopTraceViewerAutoRefresh();
      } else {
        var trajectoryPageRoot = $('#trajectory-page-root');
        var trajectoryPageChanged = !!(trajectoryPageRoot
          && String(trajectoryPageRoot.dataset.topicId || '') !== String(topic.topicId));
        if (trajectoryPageChanged) {
          selectedTrajectoryCellId = '';
          selectedTrajectoryRequestNumber = 0;
          trajectoryInspectorTab = 'overview';
          trajectoryInspectorOpen = false;
        }
        if (!trajectoryPageRoot || String(trajectoryPageRoot.dataset.topicId || '') !== String(topic.topicId)) {
          rootEl.innerHTML = renderTrajectoryPage(topic, trajectoryLoadingHtml());
          trajectoryPageRoot = $('#trajectory-page-root');
        }
        if (!conversationSectionVisible()) stopTraceViewerAutoRefresh();
        else if (!traceViewerRefreshTimer && trajectoryPageRoot
            && trajectoryPageRoot.querySelector('.conversation-trace-viewer')) startTraceViewerAutoRefresh();
        if (trajectoryPageChanged && trajectoryPageRoot) {
          var pageTopicId = String(topic.topicId);
          loadLatestTopicTrajectory(pageTopicId, false).then(function () {
            var currentTopic = displayedTopic();
            var content = $('#trajectory-view-content');
            if (!trajectoryViewOpen || !content || !currentTopic || String(currentTopic.topicId || '') !== pageTopicId) return;
            content.innerHTML = renderTopicTrajectory(currentTopic);
            hydrateConversationImages(content);
            trajectoryVirtualState = null;
            applyTrajectoryVirtualization(content);
            positionTrajectoryAtTail(pageTopicId);
            if (conversationSectionVisible()) startTraceViewerAutoRefresh();
          }).catch(function (error) {
            var content = $('#trajectory-view-content');
            if (trajectoryViewOpen && content) content.innerHTML = '<div class="conversation-llm-log"><div class="conversation-llm-log-meta"><b>!</b><span>'
              + esc('加载运行轨迹失败: ' + (error && error.message || error)) + '</span></div></div>';
          });
        }
        return;
      }
    }
    var renderKey = renderKeyFor(assistant, topic)
      + (controlledElsewhere ? '\u001fcontrolledElsewhere' : '');
    var existingStream = $('#conversation-event-stream');
    var existingTopicId = String(existingStream && existingStream.dataset && existingStream.dataset.topicId || '');
    /* Journal and stream-buffer notifications must stay within the existing
       shell. Reconcile rows in place so a long conversation never pays the
       cost of rebuilding the sidebar, composer, and event container. */
    if (existingStream && existingTopicId === String(topic && topic.topicId || '')
        && (topicIsRunning(topic) || incrementalConversationTopicById[existingTopicId])) {
      patchRuntimeConversationView(topic);
      return;
    }
    if (renderKey === lastRenderKey && patchEventStream(topic)) {
      return;
    }

    var previousStream = $('#conversation-event-stream');
    var currentTopicId = String(topic && topic.topicId || '');
    var previousTopicId = String(previousStream && previousStream.dataset && previousStream.dataset.topicId || '');
    var previousScrollState = previousStream && previousTopicId === currentTopicId
      ? { stickToEnd: isStreamPinnedToBottom(previousStream), scrollTop: Number(previousStream.scrollTop) || 0 }
      : { stickToEnd: true, scrollTop: 0 };
    var eventsHtml = renderStreamEvents(topic);
    if (conversationVirtualList) conversationVirtualList.destroy();
    conversationVirtualList = null;
    conversationVirtualContainer = null;
    rootEl.innerHTML = '<div class="conversation-layout' + (sidebarCollapsed ? ' sidebar-collapsed' : '') + '">'
      + '<button class="conversation-sidebar-collapse-btn" data-conversation-action="toggle-sidebar-collapse" title="' + (sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏') + '" aria-label="' + (sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏') + '"></button>'
      + renderAssistantPanel(assistant, topic)
      + renderStream(topic, streamAssistant, eventsHtml, controlledElsewhere)
      + '</div>';
    lastRenderKey = renderKey;
    lastSidebarRenderKey = sidebarRenderKey(assistant, topic);
    hydrateConversationImages(rootEl);
    patchEventStream(topic, previousScrollState);
  }

  function projectListEventForOptions(event) {
    if (!event) return null;
    var kind = event.kind;
    if (kind === 'tool-result') kind = 'tool';
    if (kind === 'run' || kind === 'info') kind = 'warn';
    var projected = {
      eventId: event.eventId || event.id || '',
      eventKey: event.eventKey || event.id || '',
      sequence: Number(event.sequence) || Number(event.order) || 0,
      order: Number(event.sequence) || Number(event.at) || 0,
      at: event.at,
      kind: kind,
      title: kind === 'reasoning' ? '思考' : (event.title || ''),
      text: event.text || '',
      operation: event.operation || '',
      canonicalType: event.canonicalType || '',
      generationId: event.generationId || '',
      modelRequestId: event.modelRequestId || '',
      toolCallId: event.toolCallId || '',
      interactionId: event.interactionId || '',
      phase: event.phase || '',
      reasoningKind: event.reasoningKind || '',
      finishReason: event.finishReason || '',
      toolName: event.toolName || '',
      codeValue: event.codeValue,
      detail: Object.assign({}, event.detail && typeof event.detail === 'object' ? event.detail : {}, {
        content: event.text || '',
        message: event.text || '',
        error: kind === 'error' ? event.text || '' : '',
        status: event.status || '',
        attachments: event.attachments || [],
      }),
      __live: event.__live === true,
    };
    /* Preserve the structured tool payload. conversation-shared uses these
       fields to render the call/result card and its JSON preview. Dropping
       them here turns a real tool event into an empty generic event. */
    if (Object.prototype.hasOwnProperty.call(event, 'call')) projected.call = event.call;
    if (Object.prototype.hasOwnProperty.call(event, 'result')) projected.result = event.result;
    if (Object.prototype.hasOwnProperty.call(event, 'attachments')) projected.attachments = event.attachments;
    if (Object.prototype.hasOwnProperty.call(event, 'argumentsText')) projected.argumentsText = event.argumentsText;
    if (event.hidden === true) projected.hidden = true;
    if (Object.prototype.hasOwnProperty.call(event, 'startedAt')) {
      projected.startedAt = Math.max(0, Number(event.startedAt) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(event, 'durationMs')) {
      projected.durationMs = Math.max(0, Number(event.durationMs) || 0);
    }
    return projected;
  }

  function terminalGenerationStatusFromEvents(events, generationId) {
    var terminal = {
      generation_completed: 'completed',
      generation_failed: 'failed',
      generation_cancelled: 'cancelled',
      generation_truncated: 'truncated',
      generation_blocked: 'blocked',
    };
    var best = null;
    (Array.isArray(events) ? events : []).forEach(function (event) {
      var type = String(event && event.type || '');
      if (!terminal[type]) return;
      if (generationId && String(event.generationId || '') !== String(generationId)) return;
      if (!best || Number(event.sequence || 0) > Number(best.sequence || 0)) best = event;
    });
    return best ? terminal[String(best.type)] : '';
  }

  function hydrateTopicFromJournalOnce(snapshot, topicId) {
    var topic = snapshot && snapshot.topics && snapshot.topics[topicId];
    if (!topic) return Promise.resolve(snapshot);
    return Promise.all([
      sendConversationCommand('GET_CONVERSATION', { conversationId: topicId }),
      /* Project the bounded Journal window shared by both Conversation
         surfaces. Older history is fetched only when the reader scrolls up. */
      loadConversationEventsForTopic(topicId),
      /* The newest 100 events can contain no terminal marker after a long
         conversation. Query the terminal stream separately so stale
         ConversationState.status cannot keep a finished topic running. */
      sendConversationCommand('GET_EVENTS', {
        conversationId: topicId,
        types: ['generation_completed', 'generation_failed', 'generation_cancelled', 'generation_truncated', 'generation_blocked'],
        limit: 1,
        includePayloads: false,
      }),
    ]).then(function (parts) {
      var metadata = parts[0] || {};
      var active = metadata.activeGeneration || null;
      var activeStates = ['starting', 'running', 'waiting_user', 'cancelling'];
      var metadataState = String(active && active.state || '');
      var terminalStatus = active && ['completed', 'failed', 'cancelled', 'truncated', 'blocked'].indexOf(metadataState) !== -1
        ? metadataState
        : terminalGenerationStatusFromEvents(parts[2] && parts[2].events, active && active.generationId || '')
          || terminalGenerationStatusFromEvents(parts[1] && parts[1].events, active && active.generationId || '');
      topic.runtimeGenerationId = active && active.generationId || '';
      topic.runtimeTurnId = active && active.turnId || '';
      topic.status = terminalStatus || active && active.state || (!active ? 'idle' : topic.status && activeStates.indexOf(String(topic.status)) === -1 ? topic.status : 'idle');
      topic.phase = topic.status;
      topic.active = !terminalStatus && !!(active && activeStates.indexOf(active.state) !== -1);
      if (topic.active) incrementalConversationTopicById[topicId] = true;
      var projectedPage = conversationListView.projectPage(parts[1] || {});
      topic.events = (projectedPage.projectedEvents || []).map(projectListEventForOptions).filter(Boolean);
      topic.pendingSteeringMessages = projectedPage.pendingSteeringMessages || [];
      topic.eventCursor = parts[1] && parts[1].cursors || null;
      topic.eventTotal = Number(parts[1] && parts[1].total) || topic.events.length;
      topic.hasMoreBefore = !!(parts[1] && parts[1].hasMoreBefore);
      topic.pendingUserInput = null;
      var interaction = active && active.pendingInteraction;
      if (interaction) {
        topic.pendingUserInput = {
          requestId: interaction.interactionId,
          questions: [{
            id: 'answer', question: interaction.prompt,
            options: (interaction.options || []).map(function (option) {
              return { value: option.id || option.value || option.label, label: option.label || option.value || option.id, description: option.description || '' };
            }),
          }],
        };
      }
      setTopicControlAccess(topicId, { control: 'owner', running: topic.active, canControl: true, ownedByOtherPage: false });
      return snapshot;
    }).catch(function (error) {
      if (error && error.code === 'CONVERSATION_NOT_FOUND') return snapshot;
      throw error;
    });
  }

  function hydrateTopicFromJournal(snapshot, topicId) {
    topicId = String(topicId || '').trim();
    if (!topicId || !snapshot || !snapshot.topics || !snapshot.topics[topicId]) {
      return Promise.resolve(snapshot);
    }
    var pending = topicHydrationByTopic[topicId];
    if (pending && pending.snapshot === snapshot) return pending.promise;
    var previous = pending && pending.promise || Promise.resolve();
    var request = previous.catch(function () {}).then(function () {
      return hydrateTopicFromJournalOnce(snapshot, topicId);
    }).finally(function () {
      if (topicHydrationByTopic[topicId] && topicHydrationByTopic[topicId].promise === request) {
        delete topicHydrationByTopic[topicId];
      }
    });
    topicHydrationByTopic[topicId] = { snapshot: snapshot, promise: request };
    return request;
  }

  function scheduleJournalRefresh(topicId, refreshMetadata) {
    topicId = String(topicId || '').trim();
    if (!topicId) return;
    incrementalConversationTopicById[topicId] = true;
    if (refreshMetadata === true) journalRefreshMetadataByTopic[topicId] = true;
    if (journalRefreshRunningByTopic[topicId]) {
      journalRefreshQueuedByTopic[topicId] = true;
      return;
    }
    if (journalRefreshTimersByTopic[topicId]) return;
    journalRefreshTimersByTopic[topicId] = setTimeout(function () {
      delete journalRefreshTimersByTopic[topicId];
      journalRefreshRunningByTopic[topicId] = true;
      var traceTopic = displayedTopic();
      var isDisplayedTopic = !!(traceTopic && String(traceTopic.topicId || '') === topicId);
      var previousTracePage = trajectoryPageByTopic[topicId] || null;
      var traceViewerOpen = trajectoryViewOpen && isDisplayedTopic;
      var shouldRefreshMetadata = journalRefreshMetadataByTopic[topicId] === true;
      delete journalRefreshMetadataByTopic[topicId];
      /* The regular dialogue receives its bounded Journal projection below.
         Only refresh the trajectory cache when its drawer is visible. */
      var metadata = shouldRefreshMetadata
        ? getConversationResource(topicId).then(function (topicResource) {
          if (topicResource && topicResource.topicId) projectConversationResource(topicResource);
          return topicResource;
        }).catch(function () { return null; })
        : Promise.resolve();
      var hydrate = metadata.then(function () {
        return isDisplayedTopic && state && state.topics && state.topics[topicId]
          ? hydrateTopicFromJournal(state, topicId)
          : null;
      });
      var traceReload = traceViewerOpen
        ? (previousTracePage
          ? loadLatestTopicTrajectory(topicId, true)
          : loadTopicTrajectory(topicId, true))
        : Promise.resolve();
      Promise.all([hydrate, traceReload]).then(function () {
        var current = displayedTopic();
        if (!current || String(current.topicId || '') !== topicId) return;
        if (traceViewerOpen) {
          refreshOpenTraceViewer(true);
          return;
        }
        /* Status changes are reconciled against the existing shell. Do not
           invalidate `lastRenderKey` here: doing so routes a live Journal
           update through the full conversation-root rebuild. */
        renderLoaded();
      }).catch(function () {}).finally(function () {
        journalRefreshRunningByTopic[topicId] = false;
        if (journalRefreshQueuedByTopic[topicId]) {
          delete journalRefreshQueuedByTopic[topicId];
          scheduleJournalRefresh(topicId);
        }
      });
    }, 60);
  }

  function refresh() {
    if (renderQueued) {
      renderPending = true;
      return refreshPromise || Promise.resolve(state);
    }
    renderQueued = true;
    var openTarget = requestedOpenTarget;
    requestedOpenTarget = null;
    var resolvedOpenTarget = null;
    var refreshTopicSwitchSeq = topicSwitchSeq;
    var preferredTopicId = String(openTarget && openTarget.topicId || '')
      || topicSwitchLoadingTopicId || (state && state.activeTopicId) || '';
    var promise = globalThis.ConversationState.load({ fresh: true }).then(function (next) {
      return Promise.all([
        listConversationResources(),
        listAssistantResources(),
        listModelServiceResources(),
        getAgentSettingsResource(),
      ]).then(function (resources) {
        agentSettingsResource = resources[3];
        modelServiceResources = resources[2];
        next = projectConversationResources(next, resources[0]);
        return projectAssistantResources(next, resources[1], agentSettingsResource);
      }).then(function (projected) {
        var requestedTopicId = String(openTarget && openTarget.topicId || '');
        var requestedAssistantId = String(openTarget && openTarget.assistantId || '');
        if (requestedTopicId && projected.topics && projected.topics[requestedTopicId]) {
          projected = applyTopicSelection(projected, requestedTopicId);
          resolvedOpenTarget = {
            topicId: requestedTopicId,
            assistantId: String(projected.topics[requestedTopicId].assistantId || requestedAssistantId),
          };
        } else if (requestedAssistantId && projected.assistants && projected.assistants[requestedAssistantId]) {
          projected = applyAssistantSelection(projected, requestedAssistantId);
          resolvedOpenTarget = {
            topicId: String(projected.activeTopicId || ''),
            assistantId: requestedAssistantId,
          };
        }
        var journalTopicId = topicSwitchLoadingTopicId
          || resolvedOpenTarget && resolvedOpenTarget.topicId
          || preferredTopicId
          || projected.activeTopicId
          || '';
        return journalTopicId ? hydrateTopicFromJournal(projected, journalTopicId) : projected;
      });
    }).then(function (next) {
      if (resolvedOpenTarget && resolvedOpenTarget.topicId) {
        state = applyTopicSelection(next, resolvedOpenTarget.topicId);
      } else if (resolvedOpenTarget && resolvedOpenTarget.assistantId) {
        state = applyAssistantSelection(next, resolvedOpenTarget.assistantId);
      } else if (topicSwitchLoadingTopicId) state = applyPendingTopicSelection(next);
      else if (refreshTopicSwitchSeq !== topicSwitchSeq && preferredTopicId) state = applyTopicSelection(next, preferredTopicId);
      else if (preferredTopicId && next.topics && next.topics[preferredTopicId]) state = applyTopicSelection(next, preferredTopicId);
      else state = next;
      var current = displayedTopic();
      var revalidateControl = !!(readonlySnapshotControlRevalidatePending && current
        && current.topicId === readonlySnapshotRefreshTopicId);
      readonlySnapshotControlRevalidatePending = false;
      return syncDisplayedTopicControl(revalidateControl);
    }).then(function () {
      renderQueued = false;
      if (resolvedOpenTarget) sidebarTab = 'topics';
      renderLoaded();
      if (resolvedOpenTarget) {
        var assistantId = resolvedOpenTarget.assistantId;
        var persistAssistant = assistantId
            && assistantId !== String(agentSettingsResource && agentSettingsResource.defaultAssistantId || '')
          ? patchAgentSettingsResource({ defaultAssistantId: assistantId })
          : Promise.resolve(agentSettingsResource);
        persistAssistant.then(function () {
          if (resolvedOpenTarget.topicId) return globalThis.ConversationState.setActiveTopic(resolvedOpenTarget.topicId);
          return null;
        }).catch(function (error) {
          toast('保存对话定位失败: ' + resourceErrorText(error), true);
        });
      }
      if (renderPending) {
        renderPending = false;
        return refresh();
      }
      return state;
    }).catch(function (err) {
      renderQueued = false;
      renderPending = false;
      toast('加载对话状态失败: ' + err.message, true);
      return state;
    });
    refreshPromise = promise;
    return promise.finally(function () {
      if (refreshPromise === promise) refreshPromise = null;
    });
  }

  function selectTopic(topicId) {
    topicId = String(topicId || '').trim();
    if (!topicId || !state || !state.topics || !state.topics[topicId]) return;
    if (state.activeTopicId === topicId) {
      assistantMenuOpen = false;
      topicMenuOpen = false;
      renderLoaded();
      return;
    }
    assistantMenuOpen = false;
    topicMenuOpen = false;
    sidebarTab = 'topics';
    if (assistantSwitchLoadingAssistantId) assistantSwitchSeq += 1;
    assistantSwitchLoadingAssistantId = '';
    topicSwitchSeq += 1;
    var seq = topicSwitchSeq;
    topicSwitchLoadingTopicId = topicId;
    state = applyTopicSelection(state, topicId);
    lastRenderKey = '';
    renderLoaded();

    var startWrite = function () {
      if (seq !== topicSwitchSeq) return;
      var selectedTopic = state && state.topics && state.topics[topicId];
      var assistantId = String(selectedTopic && selectedTopic.assistantId || '');
      var selectAssistantResource = assistantId
          && assistantId !== String(agentSettingsResource && agentSettingsResource.defaultAssistantId || '')
        ? patchAgentSettingsResource({ defaultAssistantId: assistantId })
        : Promise.resolve(agentSettingsResource);
      selectAssistantResource.then(function () {
        return globalThis.ConversationState.setActiveTopic(topicId);
      }).then(function () {
        if (seq !== topicSwitchSeq) return;
        return hydrateTopicFromJournal(state, topicId);
      }).then(function () {
        if (seq !== topicSwitchSeq) return;
        topicSwitchLoadingTopicId = '';
        return syncDisplayedTopicControl(true).then(function () {
          if (seq !== topicSwitchSeq) return;
          lastRenderKey = '';
          renderLoaded();
        });
      }).catch(function (err) {
        if (seq !== topicSwitchSeq) return;
        topicSwitchLoadingTopicId = '';
        toast('切换话题失败: ' + resourceErrorText(err), true);
        refresh();
      });
    };
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(startWrite);
      });
    } else {
      setTimeout(startWrite, 16);
    }
  }

  function selectAssistant(assistantId) {
    assistantId = String(assistantId || '').trim();
    if (!assistantId || !state || !state.assistants || !state.assistants[assistantId]) return;
    if (state.activeAssistantId === assistantId) {
      assistantMenuOpen = false;
      topicMenuOpen = false;
      renderLoaded();
      return;
    }
    assistantMenuOpen = false;
    topicMenuOpen = false;
    if (topicSwitchLoadingTopicId) topicSwitchSeq += 1;
    topicSwitchLoadingTopicId = '';
    assistantSwitchSeq += 1;
    var seq = assistantSwitchSeq;
    assistantSwitchLoadingAssistantId = assistantId;
    return patchAgentSettingsResource({ defaultAssistantId: assistantId }).then(function (settings) {
      if (seq !== assistantSwitchSeq) return state;
      var selectedId = String(settings.defaultAssistantId || '');
      if (selectedId !== assistantId) throw new Error('Agent Settings 未确认所选助手');
      state = applyAssistantSelection(state, selectedId);
      assistantSwitchLoadingAssistantId = '';
      var nextTopicId = state && state.activeTopicId || '';
      var hydrate = nextTopicId ? hydrateTopicFromJournal(state, nextTopicId) : Promise.resolve(state);
      return hydrate.then(function () {
        return syncDisplayedTopicControl(true);
      }).then(function () {
        if (seq !== assistantSwitchSeq) return state;
        lastRenderKey = '';
        renderLoaded();
        return state;
      });
    }).catch(function (err) {
      if (seq !== assistantSwitchSeq) return state;
      assistantSwitchLoadingAssistantId = '';
      toast('切换助手失败: ' + resourceErrorText(err), true);
      lastRenderKey = '';
      renderLoaded();
      return state;
    });
  }

  function render() {
    if (!initialized) init();
    return refresh();
  }

  function openTarget(target) {
    target = target || {};
    requestedOpenTarget = {
      assistantId: String(target.assistantId || '').trim(),
      topicId: String(target.topicId || '').trim(),
    };
    return render();
  }

  function createTopicFromPrompt() {
    var assistant = selectedAssistant();
    if (!assistant) {
      toast('请先新建助手', true);
      return Promise.resolve();
    }
    var objective = '';
    sidebarTab = 'topics';
    newTopicModelServiceId = '';
    return createConversationResource({
      assistantId: assistant && assistant.id,
      objective: objective,
      name: '新话题',
      modelServiceId: defaultModelServiceId(assistant),
      maxIterations: assistant && assistant.settings && assistant.settings.maxIterations,
      maxToolCalls: assistant && assistant.settings && assistant.settings.maxToolCalls,
      makeActive: true,
      assistantSnapshot: assistantSnapshotFrom(assistant),
    }).then(function (topic) {
      projectConversationResource(topic);
      state = applyTopicSelection(state, topic.topicId);
      lastRenderKey = '';
      return refresh();
    }).catch(function (error) {
      toast('新建话题失败: ' + resourceErrorText(error), true);
    });
  }

  function activateNewAssistant(assistant) {
    return patchAgentSettingsResource({ defaultAssistantId: assistant.id }).then(function () {
      return createConversationResource({
        assistantId: assistant.id,
        objective: '',
        name: '新话题',
        modelServiceId: defaultModelServiceId(assistant),
        maxIterations: assistant.settings && assistant.settings.maxIterations,
        maxToolCalls: assistant.settings && assistant.settings.maxToolCalls,
        makeActive: true,
        assistantSnapshot: assistantSnapshotFrom(assistant),
      });
    }).then(function (topic) {
      projectConversationResource(topic);
      state = applyTopicSelection(state, topic.topicId);
      lastRenderKey = '';
      return refresh();
    });
  }

  function openConversationDrawer(title, body, actions) {
    var titleEl = $('#drawer-title');
    var contentEl = $('#drawer-content');
    var actionsEl = $('#drawer-actions');
    var overlayEl = $('#drawer-overlay');
    var drawerEl = $('#drawer');
    if (!titleEl || !contentEl || !actionsEl || !overlayEl || !drawerEl) return false;
    titleEl.textContent = title;
    contentEl.innerHTML = body;
    actionsEl.innerHTML = actions;
    overlayEl.classList.add('active');
    drawerEl.classList.add('active');
    return true;
  }

  function getAssistantTemplates() {
    return profileApi().assistantTemplates();
  }

  function resourcePolicyCatalog() {
    return profileApi().resourcePolicyCatalog();
  }

  function normalizeResourcePolicy(policy, base) {
    return profileApi().normalizeResourcePolicy(policy, base);
  }

  function resourceMethodEnabled(policy, rootUri, methodName) {
    policy = normalizeResourcePolicy(policy);
    var rootPolicy = policy.roots && policy.roots[rootUri] || {};
    return Array.isArray(rootPolicy.methods) && rootPolicy.methods.indexOf(methodName) !== -1;
  }

  function assistantModeValue(assistant) {
    return assistant && assistant.settings && assistant.settings.mode === 'normal' ? 'normal' : 'fullAuto';
  }

  function renderDrawerTabs(group, active, tabs) {
    return '<div class="conversation-drawer-tabs" data-conversation-tab-group="' + esc(group) + '">'
      + tabs.map(function (tab) {
        return '<button type="button" class="' + (active === tab.id ? 'selected' : '') + '" data-conversation-action="select-drawer-tab" data-conversation-tab-group="' + esc(group) + '" data-conversation-tab="' + esc(tab.id) + '">' + esc(tab.label) + '</button>';
      }).join('')
      + '</div>';
  }

  function reasoningEffortOptions(value) {
    value = globalThis.ModelSettings && globalThis.ModelSettings.normalizeReasoningEffort
      ? globalThis.ModelSettings.normalizeReasoningEffort(value)
      : String(value || 'auto');
    return ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(function (item) {
      var label = item === 'auto' ? 'auto（不覆盖）' : item;
      return '<option value="' + esc(item) + '"' + (value === item ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
  }

  function renderModePermissionControls(assistant, prefix) {
    assistant = assistant || {};
    var policy = normalizeResourcePolicy(assistant.resourcePolicy);
    var catalog = resourcePolicyCatalog();
    var mode = assistantModeValue(assistant);
    function renderPermissionRoot(root) {
      var supportedMethods = Array.isArray(root.supportedMethods) ? root.supportedMethods : null;
      var methods = (catalog.methods || []).filter(function (method) {
        return !supportedMethods || supportedMethods.indexOf(method.name) !== -1;
      });
      var coreMethods = catalog.coreRootMethods && catalog.coreRootMethods[root.uri] || [];
      return '<details class="conversation-permission-group">'
        + '<summary>'
        + '<div><b>' + esc(root.uri) + ' · ' + esc(root.label || '') + '</b><span>' + esc(root.description || '') + '</span></div>'
        + '<em>' + esc(methods.length) + ' 个方法</em>'
        + '</summary>'
        + '<div class="conversation-permission-actions">'
        + '<button type="button" class="btn-small" data-conversation-action="set-resource-root-methods" data-permission-prefix="' + esc(prefix) + '" data-resource-root="' + esc(root.uri) + '" data-permission-enabled="true">全部允许</button>'
        + '<button type="button" class="btn-small" data-conversation-action="set-resource-root-methods" data-permission-prefix="' + esc(prefix) + '" data-resource-root="' + esc(root.uri) + '" data-permission-enabled="false">仅内省</button>'
        + '</div>'
        + '<div class="conversation-permission-list">'
        + methods.map(function (method) {
          var alwaysAvailable = method.name === 'OPTIONS'
            || (root.uri === '/recordings' && method.name === 'GET');
          var coreRequired = coreMethods.indexOf(method.name) !== -1;
          var methodDescription = root.methodDescriptions && root.methodDescriptions[method.name]
            || method.description || '';
          return '<label class="conversation-permission-item">'
            + '<input type="checkbox" data-resource-permission-prefix="' + esc(prefix) + '" data-resource-root="' + esc(root.uri) + '" data-resource-method="' + esc(method.name) + '"'
            + (resourceMethodEnabled(policy, root.uri, method.name) ? ' checked' : '') + (alwaysAvailable || coreRequired ? ' disabled' : '') + '>'
            + '<span><b>' + esc(method.name) + ' · ' + esc(method.label || '') + '</b><small>' + esc(methodDescription) + '</small></span>'
            + '</label>';
        }).join('')
        + '</div>'
        + '</details>';
    }
    var renderedRoots = Object.create(null);
    var sectionHtml = (catalog.sections || []).map(function (section) {
      var roots = (catalog.roots || []).filter(function (root) {
        return root.section === section.id;
      });
      if (!roots.length) return '';
      roots.forEach(function (root) { renderedRoots[root.uri] = true; });
      return '<section class="conversation-permission-section" data-permission-section="' + esc(section.id) + '">'
        + '<div class="conversation-permission-section-heading">'
        + '<div><b>' + esc(section.label || '') + '</b><span>' + esc(section.description || '') + '</span></div>'
        + '<em>' + esc(roots.length) + ' 个资源</em>'
        + '</div>'
        + '<div class="conversation-permission-section-roots">' + roots.map(renderPermissionRoot).join('') + '</div>'
        + '</section>';
    }).join('');
    var ungroupedRoots = (catalog.roots || []).filter(function (root) { return !renderedRoots[root.uri]; });
    if (ungroupedRoots.length) {
      sectionHtml += '<section class="conversation-permission-section">'
        + '<div class="conversation-permission-section-heading"><div><b>其他</b><span>尚未归入 Options 菜单的资源。</span></div>'
        + '<em>' + esc(ungroupedRoots.length) + ' 个资源</em></div>'
        + '<div class="conversation-permission-section-roots">' + ungroupedRoots.map(renderPermissionRoot).join('') + '</div>'
        + '</section>';
    }
    return '<div class="conversation-mode-permissions">'
      + '<div class="form-row"><label>模式</label><select id="' + esc(prefix) + '-mode">'
      + '<option value="normal"' + (mode === 'normal' ? ' selected' : '') + '>普通模式</option>'
      + '<option value="fullAuto"' + (mode === 'fullAuto' ? ' selected' : '') + '>全自动模式</option>'
      + '</select><div class="form-help">所有资源操作都在助手已授权的方法范围内直接执行；OPTIONS 内省始终可用。</div></div>'
      + '<div class="conversation-permission-groups">' + sectionHtml + '</div>'
      + '</div>';
  }

  function collectResourcePolicyFromControls(prefix, fallbackPolicy) {
    var inputs = document.querySelectorAll('input[data-resource-permission-prefix="' + prefix + '"]');
    if (!inputs.length) return normalizeResourcePolicy(fallbackPolicy);
    var fallback = normalizeResourcePolicy(fallbackPolicy);
    var catalog = resourcePolicyCatalog();
    var roots = {};
    inputs.forEach(function (input) {
      var rootUri = input.dataset.resourceRoot || '';
      var methodName = input.dataset.resourceMethod || '';
      if (!rootUri || !methodName) return;
      if (!roots[rootUri]) roots[rootUri] = { methods: [] };
      if (input.checked) roots[rootUri].methods.push(methodName);
    });
    var managedPermissions = Object.create(null);
    var grantedPermissions = Object.create(null);
    (catalog.roots || []).forEach(function (root) {
      var methodPermissions = root && root.methodPermissions || {};
      Object.keys(methodPermissions).forEach(function (methodName) {
        (methodPermissions[methodName] || []).forEach(function (permission) {
          managedPermissions[permission] = true;
          if (roots[root.uri] && roots[root.uri].methods.indexOf(methodName) !== -1) {
            grantedPermissions[permission] = true;
          }
        });
      });
    });
    var permissions = (fallback.permissions || []).filter(function (permission) {
      return !managedPermissions[permission];
    });
    Object.keys(grantedPermissions).forEach(function (permission) {
      if (permissions.indexOf(permission) === -1) permissions.push(permission);
    });
    var policy = { roots: roots, permissions: permissions };
    return normalizeResourcePolicy(policy, fallback);
  }

  function collectModeFromControls(prefix, fallbackSettings) {
    var settings = Object.assign({}, fallbackSettings || {});
    var modeEl = $('#' + prefix + '-mode');
    settings.mode = modeEl && modeEl.value === 'fullAuto' ? 'fullAuto' : 'normal';
    return settings;
  }

  function activateDrawerTab(group, tab) {
    document.querySelectorAll('[data-conversation-tab-group="' + group + '"][data-conversation-tab]').forEach(function (button) {
      button.classList.toggle('selected', button.dataset.conversationTab === tab);
    });
    document.querySelectorAll('[data-conversation-tab-panel-group="' + group + '"]').forEach(function (panel) {
      panel.classList.toggle('active', panel.dataset.conversationTabPanel === tab);
    });
  }

  function setResourceRootMethods(prefix, rootUri, enabled) {
    document.querySelectorAll('input[data-resource-permission-prefix="' + prefix + '"][data-resource-root="' + rootUri + '"]').forEach(function (input) {
      if (!input.disabled) input.checked = enabled;
    });
  }

  function stopTraceViewerAutoRefresh() {
    if (traceViewerRefreshTimer) clearInterval(traceViewerRefreshTimer);
    traceViewerRefreshTimer = 0;
    traceViewerRenderSignature = '';
    traceViewerSelectedSignature = '';
  }

  function closeConversationDrawer() {
    var overlayEl = $('#drawer-overlay');
    var drawerEl = $('#drawer');
    if (overlayEl) overlayEl.classList.remove('active');
    if (drawerEl) {
      drawerEl.classList.remove('active');
    }
  }

  function closeTopicTrajectory() {
    trajectoryViewOpen = false;
    selectedTrajectoryCellId = '';
    selectedTrajectoryRequestNumber = 0;
    trajectoryTimelineRange = null;
    trajectoryTimelineViewport = null;
    trajectoryTimelinePan = null;
    trajectoryVirtualState = null;
    trajectoryScrollTopicId = '';
    stopTraceViewerAutoRefresh();
    renderLoaded();
  }

  function closeConversationConfirm() {
    if (confirmDialogEl) {
      confirmDialogEl.remove();
      confirmDialogEl = null;
    }
    confirmDialogFinish = null;
  }

  function cancelConversationConfirm() {
    if (confirmDialogFinish) {
      confirmDialogFinish(false);
      return;
    }
    closeConversationConfirm();
  }

  function compactForUi(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) {}
    }
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }

  function openConversationConfirm(options) {
    options = options || {};
    cancelConversationConfirm();
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      var danger = options.danger !== false;
      var detailHtml = options.detail !== undefined && options.detail !== null && options.detail !== ''
        ? '<pre class="conversation-confirm-detail">' + esc(options.detail) + '</pre>'
        : '';
      var settled = false;
      confirmDialogEl = overlay;
      overlay.className = 'conversation-confirm-overlay';
      overlay.innerHTML = '<div class="conversation-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-confirm-title">'
        + '<div class="conversation-confirm-header"><h3 id="conversation-confirm-title">' + esc(options.title || '确认操作') + '</h3></div>'
        + '<div class="conversation-confirm-body"><p>' + esc(options.message || '确认继续？') + '</p>' + detailHtml + '</div>'
        + '<div class="conversation-confirm-actions">'
        + '<button class="btn-secondary" type="button" data-conversation-confirm="cancel">' + esc(options.cancelText || '取消') + '</button>'
        + '<button class="' + (danger ? 'btn-danger' : 'btn-primary') + '" type="button" data-conversation-confirm="ok">' + esc(options.okText || '确认') + '</button>'
        + '</div>'
        + '</div>';
      function finish(value) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown, true);
        if (confirmDialogEl) {
          confirmDialogEl.remove();
          confirmDialogEl = null;
        }
        confirmDialogFinish = null;
        resolve(value);
      }
      confirmDialogFinish = finish;
      function onKeydown(event) {
        if (event.key === 'Escape') finish(false);
      }
      overlay.addEventListener('click', function (event) {
        event.stopPropagation();
        if (event.target === overlay) finish(false);
      });
      overlay.querySelector('[data-conversation-confirm="cancel"]').addEventListener('click', function () { finish(false); });
      overlay.querySelector('[data-conversation-confirm="ok"]').addEventListener('click', function () { finish(true); });
      document.addEventListener('keydown', onKeydown, true);
      document.body.appendChild(overlay);
      setTimeout(function () {
        var cancelBtn = overlay.querySelector('[data-conversation-confirm="cancel"]');
        if (cancelBtn) cancelBtn.focus();
      }, 0);
    });
  }

  function canonicalAssistantRunSettings(value) {
    value = value && typeof value === 'object' ? value : {};
    var output = {};
    ASSISTANT_RUN_SETTING_KEYS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key];
    });
    return output;
  }

  function modelServiceOptions(selectedId) {
    selectedId = String(selectedId || '');
    var options = ['<option value=""' + (!selectedId ? ' selected' : '') + '>使用 Agent 默认模型服务</option>'];
    (modelServiceResources || []).forEach(function (service) {
      var label = String(service.name || service.id || '模型服务');
      if (service.model) label += ' · ' + service.model;
      if (service.protocol) label += ' · ' + service.protocol;
      options.push('<option value="' + esc(service.id) + '"' + (service.id === selectedId ? ' selected' : '') + '>' + esc(label) + '</option>');
    });
    if (selectedId && !modelServiceResourceById(selectedId)) {
      options.splice(1, 0, '<option value="' + esc(selectedId) + '" selected>不可用的模型服务 · ' + esc(selectedId) + '</option>');
    }
    return options.join('');
  }

  function renderAssistantResourceChecks(items, selectedIds, kindLabel, inputName) {
    var selected = Object.create(null);
    (Array.isArray(selectedIds) ? selectedIds : []).forEach(function (id) {
      id = String(id || '').trim();
      if (id) selected[id] = true;
    });
    var seen = Object.create(null);
    var rows = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      var id = String(item && item.id || '').trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      var name = String(item.name || item.title || id);
      var detail = String(item.description || '').trim();
      if (kindLabel === 'MCP' && Number(item.toolCount) >= 0) {
        detail = Number(item.toolCount) + ' 个工具' + (detail ? ' · ' + detail : '');
      }
      rows.push('<label class="conversation-resource-option">'
        + '<input type="checkbox" name="' + esc(inputName) + '" value="' + esc(id) + '"' + (selected[id] ? ' checked' : '') + '>'
        + '<span><b>' + esc(name) + '</b>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>'
        + '</label>');
    });
    Object.keys(selected).forEach(function (id) {
      if (seen[id]) return;
      rows.unshift('<label class="conversation-resource-option conversation-resource-option-unavailable">'
        + '<input type="checkbox" name="' + esc(inputName) + '" value="' + esc(id) + '" checked>'
        + '<span><b>不可用的 ' + esc(kindLabel) + '</b><small>' + esc(id) + ' · 可取消选择</small></span>'
        + '</label>');
    });
    return rows.length ? rows.join('') : '<div class="conversation-resource-empty">暂无可用的 ' + esc(kindLabel) + '</div>';
  }

  function checkedResourceValues(inputName) {
    return Array.from(document.querySelectorAll('input[name="' + inputName + '"]:checked')).map(function (input) {
      return String(input.value || '').trim();
    }).filter(Boolean);
  }

  function renderAssistantEditorDrawer() {
    if (!assistantEditorDraft) return;
    var templates = getAssistantTemplates();
    var templateOptions = (templates.order || []).map(function (id) {
      var item = templates.items[id];
      if (!item) return '';
      var selected = assistantEditorDraft.templateId === id ? ' selected' : '';
      return '<option value="' + esc(id) + '"' + selected + '>' + esc(item.name || id) + '</option>';
    }).join('');
    var activeTab = assistantEditorTab === 'permissions' || assistantEditorTab === 'resources'
      ? assistantEditorTab : 'base';
    var body = '<div class="conversation-assistant-editor">'
      + renderDrawerTabs('assistant-editor', activeTab, [
        { id: 'base', label: '基础' },
        { id: 'resources', label: 'MCP 和 Skill' },
        { id: 'permissions', label: '模式和权限' },
      ])
      + '<section class="conversation-tab-panel' + (activeTab === 'base' ? ' active' : '') + '" data-conversation-tab-panel-group="assistant-editor" data-conversation-tab-panel="base">'
      + (assistantEditorDraft.mode === 'create'
        ? '<div class="form-row"><label>基于助手</label><select id="conversation-editor-base-assistant">' + templateOptions + '</select></div>'
        : '')
      + '<div class="form-row"><label>助手名称</label><input type="text" id="conversation-editor-name" value="' + esc(assistantEditorDraft.name || '') + '"></div>'
      + '<div class="form-row"><label>描述</label><input type="text" id="conversation-editor-description" value="' + esc(assistantEditorDraft.description || '') + '"></div>'
      + '<div class="form-row"><label>模型服务</label><select id="conversation-editor-model-service">' + modelServiceOptions(assistantEditorDraft.modelServiceId) + '</select><div class="form-help">列表来自脱敏的 Model Service 资源；凭据不会发送到此页面。</div></div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>最大轮次</label><input type="number" id="conversation-editor-max-iterations" value="' + esc(assistantEditorDraft.settings && assistantEditorDraft.settings.maxIterations || DEFAULT_MAX_ITERATIONS) + '"></div>'
      + '<div class="form-row"><label>最大工具调用</label><input type="number" id="conversation-editor-max-tool-calls" value="' + esc(assistantEditorDraft.settings && assistantEditorDraft.settings.maxToolCalls || DEFAULT_MAX_TOOL_CALLS) + '"></div>'
      + '<div class="form-row"><label>最大上下文 Token</label><input type="number" id="conversation-editor-max-context-tokens" min="0" step="1024" value="' + esc(assistantEditorDraft.settings && assistantEditorDraft.settings.maxContextTokens || 0) + '"><div class="form-help">0 表示跟随当前模型服务。</div></div>'
      + '</div>'
      + '<div class="form-grid">'
      + '<div class="form-row"><label>思考级别</label><select id="conversation-editor-reasoning-effort">' + reasoningEffortOptions(assistantEditorDraft.settings && assistantEditorDraft.settings.reasoningEffort) + '</select></div>'
      + '<div class="form-row"><label>会话压缩</label><select id="conversation-editor-context-compression">'
      + '<option value="auto"' + (!assistantEditorDraft.settings || assistantEditorDraft.settings.contextCompression !== 'off' ? ' selected' : '') + '>自动压缩</option>'
      + '<option value="off"' + (assistantEditorDraft.settings && assistantEditorDraft.settings.contextCompression === 'off' ? ' selected' : '') + '>关闭历史预压缩</option>'
      + '</select></div>'
      + '</div>'
      + '<div class="form-row checkbox-row"><label class="switch-label"><input type="checkbox" id="conversation-editor-stream-output"' + (assistantEditorDraft.settings && assistantEditorDraft.settings.streamOutput !== false ? ' checked' : '') + '><span class="switch-slider"></span><span class="switch-text">流式输出</span></label></div>'
      + '<div class="form-row"><label>提示词</label><textarea id="conversation-editor-prompt" rows="12">' + esc(assistantEditorDraft.prompt || '') + '</textarea><div class="form-help">这个助手的身份、领域方法与交付偏好。作为用户选择的助手指令注入，权限与完成规则仍由 Runtime 决定。</div></div>'
      + '</section>'
      + '<section class="conversation-tab-panel' + (activeTab === 'resources' ? ' active' : '') + '" data-conversation-tab-panel-group="assistant-editor" data-conversation-tab-panel="resources">'
      + '<div class="conversation-selected-resources">'
      + '<div class="form-row conversation-resource-section">'
      + '<div class="conversation-resource-heading"><label>Skill</label><button type="button" class="btn-small" data-conversation-action="clear-assistant-resource-selection" data-resource-kind="skill">清空选择</button></div>'
      + '<div class="conversation-resource-picker">'
      + renderAssistantResourceChecks(assistantSkillResources, assistantEditorDraft.skillIds, 'Skill', 'conversation-editor-skill')
      + '</div><div class="form-help">支持多选和直接取消。只把明确勾选的 Skill 正文注入普通对话。</div></div>'
      + '<div class="form-row conversation-resource-section">'
      + '<div class="conversation-resource-heading"><label>HTTP MCP</label><button type="button" class="btn-small" data-conversation-action="clear-assistant-resource-selection" data-resource-kind="mcp">清空选择</button></div>'
      + '<div class="conversation-resource-picker">'
      + renderAssistantResourceChecks(assistantMcpServerResources, assistantEditorDraft.mcpServerIds, 'MCP', 'conversation-editor-mcp-server')
      + '</div><div class="form-help">支持多选和直接取消。每次新 generation 读取所选服务器的当前工具 schema，并只允许调用所选服务器。</div></div>'
      + (!assistantResourceOptionsLoaded ? '<div class="form-help">正在读取可选资源…</div>' : '')
      + '</div>'
      + '</section>'
      + '<section class="conversation-tab-panel' + (activeTab === 'permissions' ? ' active' : '') + '" data-conversation-tab-panel-group="assistant-editor" data-conversation-tab-panel="permissions">'
      + renderModePermissionControls(assistantEditorDraft, 'conversation-editor')
      + '</section>'
      + '</div>';
    openConversationDrawer(assistantEditorDraft.mode === 'edit' ? '编辑助手' : '新建助手', body,
      '<button class="btn-secondary" data-conversation-action="cancel-assistant-editor">取消</button>'
      + '<button class="btn-primary" data-conversation-action="save-assistant-editor">保存</button>');
  }

  function openTopicConfigDrawer() {
    topicConfigTab = topicConfigTab === 'permissions' ? 'permissions' : 'run';
    openConversationDrawer('配置产物与运行', renderConfigPanelContent(displayedTopic()),
      '<button class="btn-secondary" data-conversation-action="close-conversation-drawer">关闭</button>'
      + '<button class="btn-primary" data-conversation-action="save-topic-permissions">保存模式和权限</button>');
  }

  function assistantDraftFromProfile(profile, mode) {
    profile = profile || {};
    var defaultPolicy = profileApi().createResourcePolicy();
    var settings = Object.assign({ streamOutput: true, mode: 'fullAuto' }, canonicalAssistantRunSettings(profile.settings));
    if (mode !== 'edit') settings.mode = 'fullAuto';
    return {
      mode: mode || 'create',
      assistantId: mode === 'edit' ? (profile.id || '') : '',
      templateId: '',
      name: mode === 'edit' ? (profile.name || '') : '',
      description: mode === 'edit' ? (profile.description || '') : (profile.description || '对话'),
      prompt: profile.prompt || '',
      skillIds: Array.isArray(profile.skillIds) ? profile.skillIds.slice() : [],
      mcpServerIds: Array.isArray(profile.mcpServerIds) ? profile.mcpServerIds.slice() : [],
      modelServiceId: profile.modelServiceId || '',
      settings: settings,
      resourcePolicy: normalizeResourcePolicy(profile.resourcePolicy || defaultPolicy),
    };
  }

  function beginCreateAssistantEditor() {
    var templates = getAssistantTemplates();
    var templateId = templates.order[0] || '';
    var base = templates.items[templateId] || {};
    assistantMenuOpen = false;
    assistantEditorDraft = assistantDraftFromProfile(base, 'create');
    assistantEditorDraft.templateId = templateId;
    assistantEditorTab = 'base';
    sidebarTab = 'assistant';
    renderLoaded();
    renderAssistantEditorDrawer();
    return loadAssistantResourceOptions().then(function () {
      refreshAssistantEditorAfterResourceLoad('', 'create');
    }).catch(function (error) {
      toast('读取 MCP/Skill 选项失败: ' + resourceErrorText(error), true);
      refreshAssistantEditorAfterResourceLoad('', 'create');
    });
  }

  function beginEditAssistantEditor(assistantId) {
    assistantId = String(assistantId || selectedAssistant() && selectedAssistant().id || '');
    if (!assistantId) return Promise.resolve();
    assistantMenuOpen = false;
    return getAssistantResource(assistantId).then(function (assistant) {
      projectAssistantResource(assistant);
      assistantEditorDraft = assistantDraftFromProfile(assistant, 'edit');
      assistantEditorTab = 'base';
      sidebarTab = 'assistant';
      renderLoaded();
      renderAssistantEditorDrawer();
      return loadAssistantResourceOptions().then(function () {
        refreshAssistantEditorAfterResourceLoad(assistantId, 'edit');
      }).catch(function (error) {
        toast('读取 MCP/Skill 选项失败: ' + resourceErrorText(error), true);
        refreshAssistantEditorAfterResourceLoad(assistantId, 'edit');
      });
    }).catch(function (error) {
      toast(resourceErrorText(error), true);
    });
  }

  function collectAssistantEditorDraft() {
    if (!assistantEditorDraft) return null;
    var settings = Object.assign({}, canonicalAssistantRunSettings(assistantEditorDraft.settings), {
      maxIterations: Math.max(1, Number($('#conversation-editor-max-iterations').value) || DEFAULT_MAX_ITERATIONS),
      maxToolCalls: Math.max(1, Number($('#conversation-editor-max-tool-calls').value) || DEFAULT_MAX_TOOL_CALLS),
      maxContextTokens: Math.max(0, Number($('#conversation-editor-max-context-tokens').value) || 0),
      reasoningEffort: globalThis.ModelSettings && globalThis.ModelSettings.normalizeReasoningEffort
        ? globalThis.ModelSettings.normalizeReasoningEffort($('#conversation-editor-reasoning-effort').value)
        : ($('#conversation-editor-reasoning-effort').value || 'auto'),
      contextCompression: globalThis.ModelSettings && globalThis.ModelSettings.normalizeContextCompression
        ? globalThis.ModelSettings.normalizeContextCompression($('#conversation-editor-context-compression').value)
        : ($('#conversation-editor-context-compression').value === 'off' ? 'off' : 'auto'),
      streamOutput: $('#conversation-editor-stream-output') ? $('#conversation-editor-stream-output').checked : assistantEditorDraft.settings.streamOutput !== false,
    });
    settings = collectModeFromControls('conversation-editor', settings);
    var resourcePolicy = collectResourcePolicyFromControls('conversation-editor', assistantEditorDraft.resourcePolicy);
    return Object.assign({}, assistantEditorDraft, {
      name: String($('#conversation-editor-name').value || '').trim(),
      description: String($('#conversation-editor-description').value || '').trim(),
      prompt: String($('#conversation-editor-prompt').value || ''),
      skillIds: checkedResourceValues('conversation-editor-skill'),
      mcpServerIds: checkedResourceValues('conversation-editor-mcp-server'),
      modelServiceId: String($('#conversation-editor-model-service').value || '').trim(),
      settings: settings,
      resourcePolicy: resourcePolicy,
    });
  }

  function refreshAssistantEditorAfterResourceLoad(assistantId, mode) {
    if (!assistantEditorDraft || assistantEditorDraft.mode !== mode) return;
    if (assistantId && assistantEditorDraft.assistantId !== assistantId) return;
    var preserved = collectAssistantEditorDraft();
    if (preserved) assistantEditorDraft = preserved;
    renderAssistantEditorDrawer();
  }

  function saveAssistantEditor() {
    var draft = collectAssistantEditorDraft();
    if (!draft) return Promise.resolve();
    if (!draft.name) {
      toast('请输入助手名称', true);
      return Promise.resolve();
    }
    var payload = {
      name: draft.name,
      description: draft.description,
      prompt: draft.prompt,
      skillIds: draft.skillIds,
      mcpServerIds: draft.mcpServerIds,
      resourcePolicy: draft.resourcePolicy,
      modelServiceId: draft.modelServiceId,
      settings: canonicalAssistantRunSettings(draft.settings),
    };
    var editing = draft.mode === 'edit' && draft.assistantId;
    var op = editing
      ? patchAssistantResource(draft.assistantId, payload)
      : createAssistantResource(payload);
    return op.then(function (assistant) {
      projectAssistantResource(assistant);
      assistantEditorDraft = null;
      closeConversationDrawer();
      if (editing) return refresh();
      return activateNewAssistant(assistant);
    }).catch(function (error) {
      toast('保存助手失败: ' + resourceErrorText(error), true);
    });
  }

  function saveTopicPermissions() {
    var topic = displayedTopic();
    if (!topic) return Promise.resolve();
    var assistant = assistantForTopicRun(topic, activeAssistant()) || {};
    var settings = collectModeFromControls('conversation-topic-permissions', assistant.settings || {});
    var resourcePolicy = collectResourcePolicyFromControls('conversation-topic-permissions', assistant.resourcePolicy);
    var snapshot = assistantSnapshotFrom(Object.assign({}, assistant, {
      settings: settings,
      resourcePolicy: resourcePolicy,
    }));
    return patchConversationResource(topic.topicId, {
      assistantSnapshot: snapshot,
    }).then(function () {
      toast('已保存模式和权限');
      openTopicConfigDrawer();
      refresh();
    }).catch(function (err) {
      toast('保存模式和权限失败: ' + err.message, true);
    });
  }

  function cancelAssistantEditor() {
    assistantEditorDraft = null;
    closeConversationDrawer();
    return Promise.resolve();
  }

  function applyAssistantTemplate(templateId) {
    if (!assistantEditorDraft || assistantEditorDraft.mode !== 'create') return;
    var templates = getAssistantTemplates();
    var base = templates.items[templateId];
    if (!base) return;
    var currentName = $('#conversation-editor-name') ? String($('#conversation-editor-name').value || '').trim() : '';
    assistantEditorDraft = assistantDraftFromProfile(base, 'create');
    assistantEditorDraft.templateId = templateId;
    assistantEditorDraft.name = currentName;
    renderAssistantEditorDrawer();
  }

  function copyAssistant(assistantId) {
    assistantId = String(assistantId || selectedAssistant() && selectedAssistant().id || '');
    if (!assistantId) return Promise.resolve();
    assistantMenuOpen = false;
    return getAssistantResource(assistantId).then(function (assistant) {
      return createAssistantResource({
        name: (assistant.name || '助手') + ' 副本',
        description: assistant.description || '',
        prompt: assistant.prompt || '',
        skillIds: Array.isArray(assistant.skillIds) ? assistant.skillIds.slice() : [],
        mcpServerIds: Array.isArray(assistant.mcpServerIds) ? assistant.mcpServerIds.slice() : [],
        resourcePolicy: normalizeResourcePolicy(assistant.resourcePolicy),
        modelServiceId: assistant.modelServiceId || '',
        settings: canonicalAssistantRunSettings(assistant.settings),
      });
    }).then(function (assistant) {
      projectAssistantResource(assistant);
      return activateNewAssistant(assistant);
    }).catch(function (error) {
      toast('复制助手失败: ' + resourceErrorText(error), true);
    });
  }

  function countAssistantTopics(assistantId) {
    if (!state || !assistantId) return 0;
    return (state.topicOrder || []).filter(function (topicId) {
      var topic = state.topics[topicId];
      return topic && topic.assistantId === assistantId;
    }).length;
  }

  function assistantHasRunningTopics(assistantId) {
    if (!state || !assistantId) return false;
    return (state.topicOrder || []).some(function (topicId) {
      var topic = state.topics[topicId];
      return topic && topic.assistantId === assistantId && topicIsRunning(topic);
    });
  }

  function abortAssistantTopics(assistantId) {
    if (!state || !assistantId) return Promise.resolve([]);
    return Promise.all((state.topicOrder || []).map(function (topicId) {
      var topic = state.topics[topicId];
      if (!topic || topic.assistantId !== assistantId || !topic.runtimeGenerationId || !topicIsRunning(topic)) return null;
      return sendConversationCommand('CANCEL_GENERATION', {
        conversationId: topicId, generationId: topic.runtimeGenerationId, reason: 'assistant_cleared',
      }).catch(function () { return null; });
    }));
  }

  function deleteAssistantConversationResources(assistantId) {
    var topicIds = (state && state.topicOrder || []).filter(function (topicId) {
      return state.topics[topicId] && state.topics[topicId].assistantId === assistantId;
    });
    return topicIds.reduce(function (chain, topicId) {
      return chain.then(function () { return deleteConversationResource(topicId); });
    }, Promise.resolve());
  }

  function clearAssistantTopics(assistantId) {
    var assistant = assistantId && state.assistants[assistantId] || selectedAssistant();
    if (!assistant) return Promise.resolve();
    assistantMenuOpen = false;
    if (assistantHasRunningTopics(assistant.id)) {
      renderLoaded();
      toast('助手仍有运行中的话题，不能清空', true);
      return Promise.resolve();
    }
    var count = countAssistantTopics(assistant.id);
    renderLoaded();
    return openConversationConfirm({
      title: '清空话题',
      message: '清空「' + (assistant.name || '助手') + '」下的 ' + count + ' 个话题？此操作不会删除已写入的页面或流程配置。',
      okText: '清空',
    }).then(function (confirmed) {
      if (!confirmed) return null;
      abortAssistantTopics(assistant.id);
      return deleteAssistantConversationResources(assistant.id).then(refresh);
    });
  }

  function deleteAssistant(assistantId) {
    var assistant = assistantId && state.assistants[assistantId] || null;
    if (!assistant) return Promise.resolve();
    assistantMenuOpen = false;
    if (assistantHasRunningTopics(assistant.id)) {
      renderLoaded();
      toast('助手仍有运行中的话题，不能删除', true);
      return Promise.resolve();
    }
    var count = countAssistantTopics(assistant.id);
    renderLoaded();
    return openConversationConfirm({
      title: '删除助手',
      message: '删除「' + (assistant.name || '助手') + '」？当前关联的 ' + count + ' 个话题及其运行内容会一并删除。',
      okText: '删除',
    }).then(function (confirmed) {
      if (!confirmed) return null;
      return deleteAssistantResource(assistant.id).then(refresh);
    }).catch(function (error) {
      toast('删除助手失败: ' + resourceErrorText(error), true);
      return null;
    });
  }

  function sendCurrentMessage() {
    var displayed = displayedTopic();
    if (displayed && displayed.archived) {
      toast('归档话题为只读，不能继续对话', true);
      return Promise.resolve();
    }
    var inputEl = $('#conversation-input');
    var submittedDraft = inputEl ? String(inputEl.value || '') : '';
    var message = submittedDraft.trim();
    if (!message) {
      toast('请输入内容或继续指令', true);
      return Promise.resolve();
    }
    var assistant = selectedAssistant();
    if (!assistant) {
      toast('请先新建助手', true);
      return Promise.resolve();
    }
    var topic = conversationTopic(assistant);
    if (topicControlledElsewhere(topic)) {
      toast('当前话题正在其他页面运行，完成后查看', true);
      return Promise.resolve();
    }
    var initialDraftKey = currentDraftKey(topic, assistant);
    var running = topicIsRunning(topic);
    if (running) {
      eventStreamForceFollowTopicId = topic.topicId;
      var steerCommandId = 'steer_' + (globalThis.crypto && crypto.randomUUID
        ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
      var steeringTopicId = topic.topicId;
      var steeringGenerationId = topic.runtimeGenerationId;
      if (inputEl) inputEl.value = '';
      if (composerDrafts[initialDraftKey] === submittedDraft) delete composerDrafts[initialDraftKey];
      var steeringQueue = steeringCommandQueuesByTopic[steeringTopicId];
      if (!steeringQueue) {
        steeringQueue = {
          tail: Promise.resolve(),
          pendingCount: 0,
          nextOrder: 0,
          failedDrafts: [],
        };
        steeringCommandQueuesByTopic[steeringTopicId] = steeringQueue;
      }
      var steeringOrder = steeringQueue.nextOrder++;
      steeringQueue.pendingCount += 1;
      var runtimeInput = steeringQueue.tail.catch(function () {}).then(function () {
        return sendConversationCommand('STEER_GENERATION', {
          conversationId: steeringTopicId,
          generationId: steeringGenerationId,
          commandId: steerCommandId,
          message: { id: steerCommandId + ':message', content: message, attachments: [] },
        });
      }).then(function (result) {
        if (!result || result.accepted !== true) throw new Error('当前运行未接受这条输入');
        return result;
      });
      steeringQueue.tail = runtimeInput;
      return Promise.resolve(runtimeInput).then(function (result) {
        toast('已加入待接收队列');
        return result;
      }).catch(function (err) {
        steeringQueue.failedDrafts.push({ order: steeringOrder, draft: submittedDraft });
        toast(err.message, true);
      }).finally(function () {
        steeringQueue.pendingCount -= 1;
        if (steeringQueue.pendingCount === 0) {
          var failedDraft = steeringQueue.failedDrafts.sort(function (left, right) {
            return left.order - right.order;
          }).map(function (item) { return item.draft; }).join('\n\n');
          if (failedDraft) {
            var currentTopic = displayedTopic();
            var currentInput = currentTopic && currentTopic.topicId === steeringTopicId
              ? $('#conversation-input') : null;
            var currentDraft = Object.prototype.hasOwnProperty.call(composerDrafts, initialDraftKey)
              ? String(composerDrafts[initialDraftKey] || '')
              : String(currentInput && currentInput.value || '');
            var restoredDraft = [failedDraft, currentDraft].filter(function (value) {
              return !!String(value || '').trim();
            }).join('\n\n');
            composerDrafts[initialDraftKey] = restoredDraft;
            if (currentInput) currentInput.value = restoredDraft;
            toast(steeringQueue.failedDrafts.length + ' 条追加消息失败，已恢复到输入框', true);
          }
          delete steeringCommandQueuesByTopic[steeringTopicId];
        }
        return refresh();
      });
    }
    var selectedServiceId = currentConversationServiceId(topic);
    var ensure = topic ? Promise.resolve(state) : createConversationResource({
        assistantId: assistant && assistant.id,
        objective: message,
        name: message.slice(0, 36),
        modelServiceId: selectedServiceId,
        maxIterations: assistant && assistant.settings && assistant.settings.maxIterations,
        maxToolCalls: assistant && assistant.settings && assistant.settings.maxToolCalls,
        makeActive: true,
        assistantSnapshot: assistantSnapshotFrom(assistant),
      }).then(function () { return refresh(); });
    return ensure.then(function (nextState) {
      state = nextState || state;
      topic = topic && state.topics[topic.topicId] || activeTopic();
      var draftKey = currentDraftKey(topic, assistant);
      var rename = (!topic.objective && (!topic.name || topic.name === '新话题'))
        ? patchConversationResource(topic.topicId, {
            objective: message,
            name: message.slice(0, 36),
          }).then(function (nextTopic) {
            state.topics[topic.topicId] = nextTopic;
            topic = nextTopic;
          })
        : Promise.resolve();
      return rename.then(function () {
        return resolveAssistantForTopicRun(topic, { promptForStale: true });
      }).then(function (resolved) {
        topic = resolved.topic || topic;
        assistant = resolved.assistant || assistant;
        if (inputEl) inputEl.value = '';
        delete composerDrafts[initialDraftKey];
        delete composerDrafts[draftKey];
        return startTurnWithProjection({
          topic: topic,
          assistant: assistant,
          message: message,
          serviceId: currentConversationServiceId(topic),
          onStateChange: refresh,
        });
      });
    }).catch(function (err) {
      toast(err.message, true);
    }).finally(refresh);
  }

  function interruptCurrentModelRequest() {
    var topic = displayedTopic();
    if (!topic || !topicIsRunning(topic) || !topic.runtimeGenerationId) {
      toast('当前没有可切换的运行', true);
      return Promise.resolve(null);
    }
    if (topicControlledElsewhere(topic)) {
      toast('当前话题正在其他页面运行', true);
      return Promise.resolve(null);
    }
    if (!Array.isArray(topic.pendingSteeringMessages) || !topic.pendingSteeringMessages.length) {
      toast('没有待接收消息', true);
      return Promise.resolve(null);
    }
    if (interruptingModelRequestByTopic[topic.topicId]) return interruptingModelRequestByTopic[topic.topicId];
    var topicId = topic.topicId;
    var commandId = 'interrupt_' + (globalThis.crypto && crypto.randomUUID
      ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
    var operation = sendConversationCommand('INTERRUPT_MODEL_REQUEST', {
      conversationId: topicId,
      generationId: topic.runtimeGenerationId,
      commandId: commandId,
    }).then(function (result) {
      if (!result || result.accepted !== true) throw new Error('当前运行未接受立即处理请求');
      toast('正在使用最新消息继续');
      return result;
    }).catch(function (error) {
      toast(error && error.message || String(error), true);
      return null;
    }).finally(function () {
      delete interruptingModelRequestByTopic[topicId];
      return refresh();
    });
    interruptingModelRequestByTopic[topicId] = operation;
    renderLoaded();
    return operation;
  }

  function submitPendingUserInput() {
    var panel = document.querySelector('.conversation-user-input');
    var topic = displayedTopic();
    if (!panel || !topic || !topic.pendingUserInput) return Promise.resolve();
    if (topicControlledElsewhere(topic)) {
      toast('当前话题正在其他页面运行，不能在此提交回答', true);
      return Promise.resolve();
    }
    var answers = {};
    var missing = '';
    panel.querySelectorAll('.conversation-user-input-question').forEach(function (questionEl) {
      var questionId = questionEl.dataset.questionId || '';
      var checked = questionEl.querySelector('input[type="radio"]:checked');
      var value = checked ? checked.value : '';
      if (value === '__other__') {
        var other = questionEl.querySelector('.conversation-user-input-other');
        value = other ? String(other.value || '').trim() : '';
      }
      if (!value && !missing) missing = questionId;
      if (value) answers[questionId] = { answers: [value] };
    });
    if (missing) {
      toast('请完整回答所有问题', true);
      return Promise.resolve();
    }
    var submit = panel.querySelector('[data-conversation-action="submit-user-input"]');
    if (submit) submit.disabled = true;
    return sendConversationCommand('RESOLVE_INTERACTION', {
      conversationId: topic.topicId,
      generationId: topic.runtimeGenerationId,
      interactionId: topic.pendingUserInput.requestId,
      answer: { answers: answers },
    }).then(function () {
      toast('回答已提交');
      return refresh();
    }).catch(function (error) {
      if (submit) submit.disabled = false;
      toast(error.message || String(error), true);
    });
  }

  function stopCurrentTopic() {
    var current = displayedTopic();
    if (!current || !current.runtimeGenerationId) return Promise.resolve();
    if (topicControlledElsewhere(current)) {
      toast('当前话题正在其他页面运行，不能在此停止', true);
      return Promise.resolve();
    }
    cancelConversationConfirm();
    toast('停止请求已发送，等待运行时确认');
    return sendConversationCommand('CANCEL_GENERATION', {
      conversationId: current.topicId,
      generationId: current.runtimeGenerationId,
      reason: 'user_cancelled',
    }).catch(function (error) {
      toast(error.message || String(error), true);
    }).finally(refresh);
  }

  function validateFlow() {
    var topic = displayedTopic();
    if (!topic) return Promise.resolve();
    var flowId = topic.activeFlowId || topic.generatedConfigIds && topic.generatedConfigIds.flows && topic.generatedConfigIds.flows[0] || '';
    if (!flowId) {
      return Promise.reject(new Error('流程资源运行时未初始化'));
    }
    var uri = '/flows/' + resourceSegment(String(flowId).replace(/^user:/, ''));
    var client;
    try { client = optionsResourceClient(); }
    catch (error) { return Promise.reject(error); }
    return client.get(uri + '?view=validation', {
      context: { requestTag: 'conversation-flow-validation' },
    }).then(function (envelope) {
      var result = resourceData(envelope) || {};
      toast(result.valid === true ? '流程校验通过' : '流程校验未通过', result.valid !== true);
      return result;
    }).then(refresh).catch(function (err) {
      toast(err.message, true);
    });
  }

  function runFlow() {
    var topic = displayedTopic();
    if (!topic) return Promise.resolve();
    var flowId = topic.activeFlowId || topic.generatedConfigIds && topic.generatedConfigIds.flows && topic.generatedConfigIds.flows[0] || '';
    if (!flowId) return Promise.resolve();
    var context;
    try {
      context = parseJsonTextarea('#conversation-run-input');
      if (topic.topicId && $('#conversation-run-input')) runInputDrafts[topic.topicId] = $('#conversation-run-input').value;
    } catch (err) {
      toast(err.message, true);
      return Promise.resolve();
    }
    var uri = '/flows/' + resourceSegment(String(flowId).replace(/^user:/, '')) + '/runs';
    return optionsResourceClient().authorizedPost(uri, {
      trigger: 'conversation',
      context: context,
      totalRuns: 1,
      maxRetries: 0,
    }, {
      criteria: { relation: 'flow-runs' },
      context: { requestTag: 'conversation-flow-run' },
    }).then(function (envelope) {
      var result = resourceData(envelope) || {};
      var operationUri = String(envelope && envelope.receipt && envelope.receipt.operationUri
        || envelope && envelope.primary && envelope.primary.uri || '');
      var runId = String(result.runId || result.id || '');
      if (!runId && operationUri) {
        var segments = operationUri.split('/').filter(Boolean);
        if (segments.length) runId = decodeURIComponent(segments[segments.length - 1]);
      }
      if (!runId) throw new Error('运行资源未返回 runId');
      result.runId = runId;
      return globalThis.ConversationState.updateTopic(topic.topicId, {
        pendingRunId: runId,
        lastRunStatus: 'running',
      }).then(function () { return result; });
    }).then(refresh).catch(function (err) {
      toast('运行失败: ' + err.message, true);
    });
  }

  function summarizeRunForRepair(run) {
    run = run || {};
    return {
      runId: run.runId || run.id || '',
      flowId: run.flowId || '',
      status: run.status || '',
      errors: run.errors || [],
      warnings: run.warnings || [],
      failedNodeId: run.failedNodeId || '',
      failureScreenshots: run.failureScreenshots || [],
      stepSummary: run.stepSummary || {},
      output: run.output,
      result: run.result,
    };
  }

  function isTerminalRunStatus(status) {
    return [
      'success', 'failed', 'stopped', 'skipped', 'interrupted',
      'completed', 'complete', 'passed', 'aborted', 'cancelled', 'canceled',
    ].indexOf(String(status || '').trim().toLowerCase()) !== -1;
  }

  function syncRunResult() {
    return globalThis.ConversationState.load({ fresh: true }).then(function (latest) {
      var pending = Object.keys(latest.topics || {}).map(function (id) { return latest.topics[id]; })
        .filter(function (topic) { return topic && topic.pendingRunId; });
      if (!pending.length) return null;
      var chain = Promise.resolve();
      pending.forEach(function (topic) {
        chain = chain.then(function () {
          var uri = '/runs/' + resourceSegment(topic.pendingRunId);
          return optionsResourceClient().get(uri, {
            context: { requestTag: 'conversation-run-status' },
          }).then(function (runEnvelope) {
            var run = resourceData(runEnvelope) || {};
            var status = String(run.status || '').toLowerCase();
            if (!isTerminalRunStatus(status)) return null;
            return optionsResourceClient().get(uri + '/report', {
              context: { requestTag: 'conversation-run-report' },
            }).then(function (reportEnvelope) {
              return Object.assign({}, run, resourceData(reportEnvelope) || {});
            });
          }).then(function (run) {
            if (!run) return null;
            var summary = summarizeRunForRepair(run);
            return { run: run, summary: summary };
          }).then(function (settled) {
            if (!settled) return null;
            return globalThis.ConversationState.updateTopic(topic.topicId, {
              pendingRunId: '',
              lastRunId: settled.summary.runId,
              lastRunStatus: settled.run.status || '',
              lastRunResult: settled.summary,
            });
          });
        });
      });
      return chain;
    }).then(refresh).catch(function () {});
  }

  function continueRepair() {
    var topic = displayedTopic();
    if (!topic || !topic.lastRunResult) return Promise.resolve();
    var message = '根据最近一次运行失败结果继续修复这个流程。读取对应的 /runs、/flows 和 FlowNode 资源，只做必要修改，再创建新的 Run 验证结果。运行结果摘要:\n'
      + JSON.stringify(topic.lastRunResult, null, 2);
    return resolveAssistantForTopicRun(topic, { promptForStale: true }).then(function (resolved) {
      return startTurnWithProjection({
        topic: resolved.topic || topic,
        assistant: resolved.assistant,
        message: message,
        serviceId: currentConversationServiceId(resolved.topic || topic),
        selection: { kind: 'run', runId: topic.lastRunId || topic.lastRunResult.runId },
        onStateChange: refresh,
      });
    }).catch(function (err) {
      toast(err.message, true);
    }).finally(refresh);
  }

  function confirmDeleteTopic(topicId) {
    if (!topicId) return Promise.resolve();
    var topic = state && state.topics && state.topics[topicId];
    if (topicIsRunning(topic)) {
      toast('运行中的话题不能删除，请先在控制页面停止', true);
      return Promise.resolve();
    }
    return openConversationConfirm({
      title: '删除话题',
      message: '删除这个话题？此操作不会删除已写入的页面或流程配置。',
      okText: '删除',
    }).then(function (confirmed) {
      if (!confirmed) return null;
      return deleteConversationResource(topicId).then(function () {
        delete archivedTopicById[topicId];
        invalidateTopicTrajectory(topicId);
        lastRenderKey = '';
        return refresh();
      });
    });
  }

  function confirmArchiveTopic(topicId) {
    if (!topicId) return Promise.resolve();
    var topic = state && state.topics && state.topics[topicId];
    if (!topic || topic.archived) return Promise.resolve();
    if (topicIsRunning(topic)) {
      toast('运行中的话题不能归档，请先停止', true);
      return Promise.resolve();
    }
    return openConversationConfirm({
      title: '归档话题',
      message: '归档后仍可查看和导出，但不能继续对话。',
      okText: '归档',
      danger: false,
    }).then(function (confirmed) {
      if (!confirmed) return null;
      return patchConversationResource(topicId, { archived: true }).then(function (archivedTopic) {
        archivedTopicById[topicId] = archivedTopic;
        lastRenderKey = '';
        toast('话题已归档');
        return refresh();
      });
    }).catch(function (err) {
      toast('归档话题失败: ' + err.message, true);
      return null;
    });
  }

  function mergedTopicEvents(topic) {
    return (topic && topic.events || []).map(function (event, index) {
      return Object.assign({ __index: index, __stableIndex: index }, event || {});
    });
  }

  function visibleTopicEvents(topic) {
    var events = mergedTopicEvents(topic).filter(function (event) {
      return !!event;
    }).filter(function (event) {
      return conversationShared.isVisibleEvent(event);
    });
    var failure = String(topic && topic.error || '').trim();
    if (failure && topic && topic.status === 'failed'
        && !events.some(function (event) { return event && event.kind === 'error'; })) {
      events.push({
        eventId: 'topic-error-' + String(topic.topicId || 'current'),
        at: Number(topic.updatedAt || 0) || Date.now(),
        kind: 'error',
        title: '运行失败',
        detail: { error: failure, status: '失败' },
      });
    }
    return events.sort(function (a, b) {
      var aOrder = a.order !== undefined && a.order !== null && a.order !== '' ? Number(a.order) : NaN;
      var bOrder = b.order !== undefined && b.order !== null && b.order !== '' ? Number(b.order) : NaN;
      if (a.__liveOnly || b.__liveOnly) {
        if (a.__liveOnly !== b.__liveOnly) return a.__liveOnly ? 1 : -1;
        return Number(a.__stableIndex || 0) - Number(b.__stableIndex || 0);
      }
      if (!Number.isFinite(aOrder)) aOrder = Number(a.at || 0) * 1000 + Number(a.__index || 0);
      if (!Number.isFinite(bOrder)) bOrder = Number(b.at || 0) * 1000 + Number(b.__index || 0);
      return aOrder - bOrder;
    });
  }

  function findEventForCopy(eventId) {
    return conversationShared.findEventByTarget(visibleTopicEvents(displayedTopic()), eventId);
  }

  function copyEvent(eventId) {
    var event = findEventForCopy(eventId);
    return conversationShared.copyEvent(event).then(function (result) {
      toast(result.message, !result.ok);
      return result;
    });
  }

  function downloadEventMarkdown(eventId) {
    var topic = displayedTopic();
    var event = findEventForCopy(eventId);
    var assistant = topicAssistant(topic);
    var meta = {
      topicTitle: topic && (topic.name || topic.objective) || '',
      assistantName: assistant && assistant.name || '',
    };
    var result = conversationShared.downloadEventMarkdown(event, meta);
    toast(result.message, !result.ok);
    return Promise.resolve(result);
  }

  function retryEvent(eventId) {
    var event = findEventForCopy(eventId);
    if (!conversationShared.canRetryEvent(event)) {
      toast('这条消息不能重试', true);
      return Promise.resolve();
    }
    var topic = displayedTopic();
    if (!topic || !topic.topicId) {
      toast('当前没有话题', true);
      return Promise.resolve();
    }
    if (topic.archived) {
      toast('归档话题为只读，不能重试', true);
      return Promise.resolve();
    }
    if (topicIsRunning(topic)) {
      toast('当前话题正在运行', true);
      return Promise.resolve();
    }
    var message = String(event.detail && event.detail.retryMessage || '').trim();
    var retryEventId = String(event.eventId || '').trim();
    var retryEventGeneration = {
      topicCreatedAt: Number(topic.createdAt || 0) || 0,
      eventAt: Number(event.at || 0) || 0,
    };
    if (!message) {
      toast('没有可重试的用户消息', true);
      return Promise.resolve();
    }
    return resolveAssistantForTopicRun(topic, { promptForStale: true }).then(function (resolved) {
      topic = resolved.topic || topic;
      var assistant = resolved.assistant || assistantForTopicRun(topic, activeAssistant());
      return startTurnWithProjection({
        topic: topic,
        assistant: assistant,
        message: message,
        serviceId: currentConversationServiceId(topic),
        retryEvent: {
          eventId: retryEventId,
          generation: retryEventGeneration,
        },
        onStateChange: refresh,
      });
    }).catch(function (err) {
      toast(err.message, true);
    }).finally(refresh);
  }

  function exportCapabilityGaps(topicId) {
    topicId = String(topicId || '').trim();
    var topic = topicId && state && state.topics ? state.topics[topicId] : displayedTopic();
    if (!topic || !topic.topicId) {
      toast('当前没有话题', true);
      return Promise.resolve();
    }
    var gaps = openCapabilityGapPlans(topic);
    if (!gaps.length) {
      toast('没有待提交能力缺口', true);
      return Promise.resolve();
    }
    conversationShared.downloadFile(capabilityGapFileName(topic), capabilityGapMarkdown(topic, gaps), 'text/markdown;charset=utf-8');
    return updateCapabilityGapStatuses(topic, gaps, 'exported').then(function () {
      toast('已下载能力缺口 Markdown');
      renderLoaded();
    }).catch(function (err) {
      toast('下载完成，但更新状态失败: ' + (err && err.message || err), true);
    });
  }

  function openCapabilityGapInbox(topicId) {
    topicId = String(topicId || '').trim();
    var topic = topicId && state && state.topics ? state.topics[topicId] : displayedTopic();
    if (!topic || !topic.topicId) {
      toast('当前没有话题', true);
      return;
    }
    var openCount = openCapabilityGapPlans(topic).length;
    openConversationDrawer('能力缺口收件箱', renderCapabilityGapInbox(topic),
      '<button class="btn-primary" data-conversation-action="export-capability-gaps" data-topic-id="' + esc(topic.topicId) + '"' + (openCount ? '' : ' disabled') + '>下载需求</button>'
      + '<button class="btn-secondary" data-conversation-action="close-conversation-drawer">关闭</button>');
  }

  function openTopicTrajectory() {
    var topic = displayedTopic();
    if (!topic || !topic.topicId) {
      toast('当前没有话题', true);
      return;
    }
    var topicId = String(topic.topicId);
    closeConversationDrawer();
    stopTraceViewerAutoRefresh();
    trajectoryViewOpen = true;
    selectedTrajectoryCellId = '';
    selectedTrajectoryRequestNumber = 0;
    trajectoryInspectorOpen = false;
    trajectoryTimelineRange = null;
    trajectoryTimelineViewport = null;
    trajectoryTimelinePan = null;
    trajectoryVirtualState = null;
    trajectoryScrollTopicId = topicId;
    trajectoryFollowsTail = true;
    renderLoaded();
    loadLatestTopicTrajectory(topicId, false).then(function () {
      var content = $('#trajectory-view-content');
      var currentTopic = displayedTopic();
      if (!trajectoryViewOpen || !content || !currentTopic || String(currentTopic.topicId || '') !== topicId) return;
      content.innerHTML = renderTopicTrajectory(currentTopic);
      hydrateConversationImages(content);
      trajectoryVirtualState = null;
      applyTrajectoryVirtualization(content);
      positionTrajectoryAtTail(topicId);
      startTraceViewerAutoRefresh();
    }).catch(function (error) {
      var content = $('#trajectory-view-content');
      if (trajectoryViewOpen && content) {
        content.innerHTML = '<div class="conversation-llm-log"><div class="conversation-llm-log-meta"><b>!</b><span>'
          + esc('加载运行轨迹失败: ' + (error && error.message || error)) + '</span></div></div>';
      }
      toast('加载运行轨迹失败: ' + (error && error.message || error), true);
    });
  }

  function traceViewerSignature(topic) {
    var page = topicTrajectoryPage(topic);
    return [page.start, page.end, page.total].join(':') + '|' + topicTrajectoryItems(topic).map(function (cell) {
      return [cell.recordId, cell.status, cell.text, cell.result, cell.durationMs].join(':');
    }).join('|');
  }

  function traceEventSignature(event) {
    if (!event) return '';
    return [event.recordId, event.status, event.text, event.result, event.durationMs].join(':');
  }

  function refreshOpenTraceViewer(force) {
    var content = $('#trajectory-view-content');
    var topic = displayedTopic();
    if (!trajectoryViewOpen || !content || !topic) return;
    var signature = traceViewerSignature(topic);
    if (!force && signature === traceViewerRenderSignature) return;
    var cells = topicTrajectoryItems(topic);
    var selectedEvent = cells.filter(function (item) { return item.recordId === selectedTrajectoryCellId; })[0] || null;
    var selectedSignature = traceEventSignature(selectedEvent);
    var main = content.querySelector('.conversation-trace-main');
    var turns = content.querySelector('.conversation-trace-turns');
    var tableWrap = content.querySelector('.conversation-trace-table-wrap');
    var mainScrollTop = main ? main.scrollTop : 0;
    var turnsScrollTop = tableWrap ? tableWrap.scrollTop : 0;
    var selectedButton = turns && turns.querySelector('button.selected');
    var selectedOffset = selectedButton && tableWrap ? selectedButton.getBoundingClientRect().top - tableWrap.getBoundingClientRect().top : null;
    var preserveInteractiveMain = !force && !!(main && main.contains(document.activeElement));
    var staging = document.createElement('div');
    staging.innerHTML = renderTopicTrajectory(topic);
    var nextToolbar = staging.querySelector('.conversation-trace-toolbar');
    var nextTimeline = staging.querySelector('.conversation-trace-timeline');
    var nextLedgerSummary = staging.querySelector('.conversation-trace-ledger-summary');
    var nextHistoryBoundary = staging.querySelector('.conversation-trace-history-boundary');
    var nextTurns = staging.querySelector('.conversation-trace-turns');
    var nextMain = staging.querySelector('.conversation-trace-main');
    var currentToolbar = content.querySelector('.conversation-trace-toolbar');
    var currentTimeline = content.querySelector('.conversation-trace-timeline');
    var currentLedgerSummary = content.querySelector('.conversation-trace-ledger-summary');
    var currentHistoryBoundary = content.querySelector('.conversation-trace-history-boundary');
    if (!currentToolbar || !currentTimeline || !currentLedgerSummary || !turns || !main
        || !nextToolbar || !nextTimeline || !nextLedgerSummary || !nextTurns || !nextMain
        || !currentHistoryBoundary || !nextHistoryBoundary) {
      content.innerHTML = staging.innerHTML;
    } else {
      currentToolbar.replaceWith(nextToolbar);
      currentTimeline.replaceWith(nextTimeline);
      currentLedgerSummary.replaceWith(nextLedgerSummary);
      currentHistoryBoundary.replaceWith(nextHistoryBoundary);
      turns.replaceWith(nextTurns);
      if (!preserveInteractiveMain && (force || selectedSignature !== traceViewerSelectedSignature)) main.replaceWith(nextMain);
      else {
      }
    }
    traceViewerRenderSignature = signature;
    main = content.querySelector('.conversation-trace-main');
    turns = content.querySelector('.conversation-trace-turns');
    tableWrap = content.querySelector('.conversation-trace-table-wrap');
    applyTrajectoryVirtualization(content);
    tableWrap = content.querySelector('.conversation-trace-table-wrap');
    if (main && selectedSignature === traceViewerSelectedSignature) main.scrollTop = mainScrollTop;
    if (turns && tableWrap) {
      if (trajectoryFollowsTail && trajectoryScrollTopicId === String(topic.topicId || '')) {
        tableWrap.scrollTop = tableWrap.scrollHeight;
      } else {
        tableWrap.scrollTop = turnsScrollTop;
      }
      var restoredButton = turns.querySelector('button.selected');
      if (restoredButton && selectedOffset !== null) {
        tableWrap.scrollTop += restoredButton.getBoundingClientRect().top - tableWrap.getBoundingClientRect().top - selectedOffset;
      }
    }
    hydrateConversationImages(content);
    traceViewerSelectedSignature = selectedSignature;
  }

  function startTraceViewerAutoRefresh() {
    if (traceViewerRefreshTimer) clearInterval(traceViewerRefreshTimer);
    traceViewerRenderSignature = traceViewerSignature(displayedTopic());
    var cells = topicTrajectoryItems(displayedTopic());
    traceViewerSelectedSignature = traceEventSignature(cells.filter(function (item) { return item.recordId === selectedTrajectoryCellId; })[0]);
    traceViewerRefreshTimer = setInterval(function () {
      if (!trajectoryViewOpen || !conversationSectionVisible()) {
        stopTraceViewerAutoRefresh();
        return;
      }
      var topic = displayedTopic();
      if (!topic || !topic.topicId) return;
      var topicId = String(topic.topicId);
      var page = topicTrajectoryPage(topic);
      var followLatest = !page || page.end >= page.total;
      if (!followLatest) return;
      if (traceViewerReloadPromise) return;
      var reload = loadLatestTopicTrajectory(topicId, true);
      traceViewerReloadPromise = reload.then(function () {
        var current = displayedTopic();
        if (current && String(current.topicId || '') === topicId) refreshOpenTraceViewer(false);
      }).catch(function () {}).finally(function () {
        traceViewerReloadPromise = null;
      });
    }, 800);
  }

  function setConversationService(serviceId) {
    if (anyConversationRunning()) {
      toast('对话运行中不可切换服务', true);
      renderLoaded();
      return Promise.resolve();
    }
    return Promise.resolve().then(function () {
      if (!modelServiceResourceById(serviceId)) throw new Error('选择的 Model Service 不存在');
      var topic = displayedTopic();
      if (!topic || !topic.topicId) {
        newTopicModelServiceId = serviceId;
        return null;
      }
      return patchConversationResource(topic.topicId, { modelServiceId: serviceId });
    }).then(function () {
      renderLoaded();
    }).catch(function (err) {
      toast(err.message, true);
      renderLoaded();
    });
  }

  function handleClick(event) {
    if (Date.now() < assistantDragSuppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    var target = event.target.closest('[data-conversation-action]');
    if (!target) {
      if (assistantMenuOpen || topicMenuOpen) {
        assistantMenuOpen = false;
        topicMenuOpen = false;
        renderLoaded();
      }
      return;
    }
    var action = target.dataset.conversationAction;
    if (action === 'copy-event') {
      event.preventDefault();
      event.stopPropagation();
      copyEvent(target.dataset.eventId || '');
      return;
    }
    if (action === 'retry-event') {
      event.preventDefault();
      event.stopPropagation();
      retryEvent(target.dataset.eventId || '');
      return;
    }
    if (action === 'download-event-md') {
      event.preventDefault();
      event.stopPropagation();
      downloadEventMarkdown(target.dataset.eventId || '');
      return;
    }
    if (action === 'export-topic-archive') {
      event.preventDefault();
      event.stopPropagation();
      exportConversationArchive(target.dataset.topicId || '');
      return;
    }
    if (action === 'import-topic-archive') {
      event.preventDefault();
      event.stopPropagation();
      chooseConversationArchive();
      return;
    }
    if (action === 'open-topic-trajectory') {
      event.preventDefault();
      event.stopPropagation();
      openTopicTrajectory();
      return;
    }
    if (action === 'close-topic-trajectory') {
      event.preventDefault();
      event.stopPropagation();
      closeTopicTrajectory();
      return;
    }
    if (action === 'trajectory-inspector-tab') {
      event.preventDefault();
      trajectoryInspectorTab = target.dataset.tab || 'overview';
      refreshOpenTraceViewer(true);
      return;
    }
    if (action === 'trajectory-select-request') {
      event.preventDefault();
      event.stopPropagation();
      selectedTrajectoryRequestNumber = Math.max(0, Number(target.dataset.requestNumber) || 0);
      trajectoryInspectorTab = 'overview';
      trajectoryInspectorOpen = true;
      refreshOpenTraceViewer(true);
      return;
    }
    if (action === 'trajectory-clear-range') {
      event.preventDefault();
      trajectoryTimelineRange = null;
      refreshOpenTraceViewer(true);
      return;
    }
    if (action === 'trajectory-toggle-assistant') {
      event.preventDefault();
      var assistantId = String(target.dataset.assistantCellId || '');
      if (assistantId) trajectoryCollapsedAssistantIds[assistantId] = trajectoryCollapsedAssistantIds[assistantId] !== true;
      refreshOpenTraceViewer(true);
      return;
    }
    if (action === 'trajectory-toggle-tools') {
      event.preventDefault();
      var assistantTargets = trajectoryCollapseTargets(topicTrajectoryItems(displayedTopic())).assistants;
      var collapseAssistants = !(assistantTargets.length && assistantTargets.every(function (id) { return trajectoryCollapsedAssistantIds[id] === true; }));
      assistantTargets.forEach(function (id) { trajectoryCollapsedAssistantIds[id] = collapseAssistants; });
      refreshOpenTraceViewer(true);
      return;
    }
    if (action === 'trajectory-close-inspector') {
      event.preventDefault();
      event.stopPropagation();
      trajectoryInspectorOpen = false;
      refreshOpenTraceViewer(true);
      return;
    }
    if (action === 'select-trajectory-cell') {
      event.preventDefault();
      var clickedCellId = target.dataset.cellId || '';
      var rangeTopic = displayedTopic();
      var rangeCells = rangeTopic ? topicTrajectoryItems(rangeTopic) : [];
      var clickedCell = rangeCells.filter(function (item) { return item.recordId === clickedCellId; })[0];
      if (event.shiftKey && clickedCell) {
        var anchorCell = rangeCells.filter(function (item) { return item.recordId === selectedTrajectoryCellId; })[0] || clickedCell;
        var rangeModel = trajectoryTimelineModel(rangeCells, trajectoryTimelineMode());
        var anchorSpan = trajectoryTimelineSpanForCell(rangeModel, anchorCell);
        var clickedSpan = trajectoryTimelineSpanForCell(rangeModel, clickedCell);
        if (anchorSpan && clickedSpan) trajectoryTimelineRange = {
          start: Math.min(anchorSpan.start, clickedSpan.start),
          end: Math.max(anchorSpan.end, clickedSpan.end),
        };
      }
      selectedTrajectoryCellId = clickedCellId;
      selectedTrajectoryRequestNumber = 0;
      trajectoryInspectorTab = 'overview';
      var selectedTimelineModel = trajectoryTimelineModel(rangeCells, trajectoryTimelineMode());
      var selectedTimelineSpan = trajectoryTimelineSpanForCell(selectedTimelineModel, clickedCell);
      if (selectedTimelineSpan && trajectoryTimelineViewport) {
        var selectedDomain = trajectoryTimelineDomain(selectedTimelineModel, trajectoryTimelineViewport);
        if (selectedTimelineSpan.end <= selectedDomain.start || selectedTimelineSpan.start >= selectedDomain.end) {
          var selectedDuration = selectedDomain.end - selectedDomain.start;
          var selectedStart = selectedTimelineSpan.end <= selectedDomain.start
            ? selectedTimelineSpan.start : selectedTimelineSpan.end - selectedDuration;
          selectedStart = Math.min(Math.max(selectedStart, selectedTimelineModel.start),
            Math.max(selectedTimelineModel.start, selectedTimelineModel.end - selectedDuration));
          trajectoryTimelineViewport = { start: selectedStart, end: selectedStart + selectedDuration };
        }
      }
      if (!trajectoryInspectorOpen) {
        trajectoryInspectorOpen = true;
        refreshOpenTraceViewer(true);
        return;
      }
      var traceContent = $('#trajectory-view-content');
      var traceTopic = displayedTopic();
      if (traceContent && traceTopic) {
        var cells = topicTrajectoryItems(traceTopic);
        var selectedEvent = cells.filter(function (item) { return item.recordId === selectedTrajectoryCellId; })[0];
        traceContent.querySelectorAll('.conversation-trace-turns button').forEach(function (button) {
          button.classList.toggle('selected', button.dataset.cellId === selectedTrajectoryCellId);
        });
        traceContent.querySelectorAll('.conversation-trace-row').forEach(function (row) {
          row.classList.toggle('selected', row.dataset.cellId === selectedTrajectoryCellId);
        });
        traceContent.querySelectorAll('.conversation-trace-timeline-span').forEach(function (button) {
          button.classList.toggle('selected', button.dataset.cellId === selectedTrajectoryCellId);
        });
        var traceMain = traceContent.querySelector('.conversation-trace-main');
        if (traceMain && selectedEvent) {
          traceMain.innerHTML = renderTrajectoryDetail(selectedEvent, cells);
          hydrateConversationImages(traceMain);
          traceMain.scrollTop = 0;
        }
        var selectedRow = Array.prototype.filter.call(
          traceContent.querySelectorAll('.conversation-trace-row'),
          function (row) { return row.dataset.cellId === selectedTrajectoryCellId; }
        )[0];
        var tableWrap = traceContent.querySelector('.conversation-trace-table-wrap');
        if (!selectedRow && tableWrap && selectedEvent) {
          /* Match Harness virtualizer's scroll-to-index behavior. The fallback
             row estimate is corrected on the next animation-frame measure. */
          var estimatedTop = Math.max(0, (Math.max(1, Number(selectedEvent.index) || 1) - 1) * 30);
          tableWrap.scrollTop = Math.max(0, estimatedTop - Math.max(0, tableWrap.clientHeight - 120));
          trajectoryVirtualState = null;
          refreshOpenTraceViewer(true);
        } else if (selectedRow && tableWrap) {
          var rowTop = selectedRow.getBoundingClientRect().top - tableWrap.getBoundingClientRect().top;
          if (rowTop < 0 || rowTop + selectedRow.getBoundingClientRect().height > tableWrap.clientHeight) {
            tableWrap.scrollTop += rowTop - Math.max(0, tableWrap.clientHeight / 2 - 40);
          }
        }
        traceViewerRenderSignature = traceViewerSignature(traceTopic);
        traceViewerSelectedSignature = traceEventSignature(selectedEvent);
      }
      return;
    }
    if (action === 'open-capability-gaps') {
      event.preventDefault();
      event.stopPropagation();
      openCapabilityGapInbox(displayedTopic() && displayedTopic().topicId || '');
      return;
    }
    if (action === 'export-capability-gaps') {
      event.preventDefault();
      event.stopPropagation();
      var exportTopicId = target.dataset.topicId || '';
      exportCapabilityGaps(exportTopicId).finally(function () {
        openCapabilityGapInbox(exportTopicId);
      });
      return;
    }
    if (action === 'select-drawer-tab') {
      event.preventDefault();
      event.stopPropagation();
      var tabGroup = target.dataset.conversationTabGroup || '';
      var tab = target.dataset.conversationTab || '';
      if (tabGroup === 'assistant-editor') {
        assistantEditorTab = tab === 'permissions' || tab === 'resources' ? tab : 'base';
      }
      if (tabGroup === 'topic-config') topicConfigTab = tab === 'permissions' ? 'permissions' : 'run';
      activateDrawerTab(tabGroup, tab);
      return;
    }
    if (action === 'set-resource-root-methods') {
      event.preventDefault();
      event.stopPropagation();
      setResourceRootMethods(target.dataset.permissionPrefix || '', target.dataset.resourceRoot || '', target.dataset.permissionEnabled === 'true');
      return;
    }
    if (action === 'clear-assistant-resource-selection') {
      event.preventDefault();
      event.stopPropagation();
      var resourceInputName = target.dataset.resourceKind === 'mcp'
        ? 'conversation-editor-mcp-server' : 'conversation-editor-skill';
      document.querySelectorAll('input[name="' + resourceInputName + '"]:checked').forEach(function (input) {
        input.checked = false;
      });
      return;
    }
    if (action === 'toggle-sidebar-collapse') {
      event.preventDefault();
      event.stopPropagation();
      assistantMenuOpen = false;
      topicMenuOpen = false;
      sidebarCollapsed = !sidebarCollapsed;
      renderLoaded();
      return;
    }
    var clickedSidebarMenu = !!target.closest('.conversation-assistant-menu')
      || action === 'toggle-assistant-menu' || action === 'toggle-topic-menu';
    var closedMenuByOtherClick = (assistantMenuOpen || topicMenuOpen) && !clickedSidebarMenu;
    if (closedMenuByOtherClick) {
      assistantMenuOpen = false;
      topicMenuOpen = false;
    }
    if (action === 'interrupt-model-request') interruptCurrentModelRequest();
    else if (action === 'new-topic') createTopicFromPrompt();
    else if (action === 'create-assistant') beginCreateAssistantEditor();
    else if (action === 'toggle-assistant-menu') {
      var assistantId = target.dataset.assistantId || '';
      topicMenuOpen = false;
      assistantMenuOpen = assistantMenuOpen === assistantId ? false : assistantId;
      renderLoaded();
    } else if (action === 'pin-assistant') {
      event.preventDefault();
      event.stopPropagation();
      moveAssistantToTop(target.dataset.assistantId || '');
    } else if (action === 'toggle-topic-menu') {
      var menuTopicId = target.dataset.topicId || '';
      assistantMenuOpen = false;
      topicMenuOpen = topicMenuOpen === menuTopicId ? false : menuTopicId;
      renderLoaded();
    } else if (action === 'edit-assistant') {
      beginEditAssistantEditor(target.dataset.assistantId);
    } else if (action === 'copy-assistant') {
      copyAssistant(target.dataset.assistantId);
    } else if (action === 'clear-assistant-topics') {
      clearAssistantTopics(target.dataset.assistantId);
    } else if (action === 'delete-assistant') {
      deleteAssistant(target.dataset.assistantId);
    } else if (action === 'save-assistant-editor') {
      saveAssistantEditor();
    } else if (action === 'save-topic-permissions') {
      saveTopicPermissions();
    } else if (action === 'cancel-assistant-editor') {
      cancelAssistantEditor();
    } else if (action === 'open-topic-config') {
      assistantMenuOpen = false;
      openTopicConfigDrawer();
    } else if (action === 'close-conversation-drawer') {
      closeConversationDrawer();
    }
    else if (action === 'select-sidebar-tab') {
      sidebarTab = target.dataset.sideTab === 'topics' ? 'topics' : 'assistant';
      assistantMenuOpen = false;
      topicMenuOpen = false;
      renderLoaded();
    } else if (action === 'select-assistant') {
      selectAssistant(target.dataset.assistantId);
    }
    else if (action === 'archive-topic-id') {
      var archiveTopicId = target.dataset.topicId;
      topicMenuOpen = false;
      renderLoaded();
      confirmArchiveTopic(archiveTopicId);
    } else if (action === 'delete-topic-id') {
      var deleteTopicId = target.dataset.topicId;
      topicMenuOpen = false;
      renderLoaded();
      confirmDeleteTopic(deleteTopicId);
    } else if (action === 'select-topic') {
      selectTopic(target.dataset.topicId);
    } else if (action === 'send-message') {
      sendCurrentMessage();
    } else if (action === 'submit-user-input') {
      submitPendingUserInput();
    } else if (action === 'stop-topic') {
      stopCurrentTopic();
    } else if (action === 'validate-flow') {
      validateFlow();
    } else if (action === 'run-flow') {
      runFlow();
    } else if (action === 'continue-repair') {
      continueRepair();
    }
    if (closedMenuByOtherClick && action !== 'select-assistant' && action !== 'select-topic' && action !== 'select-sidebar-tab') {
      setTimeout(renderLoaded, 0);
    }
  }

  function handleChange(event) {
    if (event.target && event.target.id === 'conversation-editor-base-assistant') {
      applyAssistantTemplate(event.target.value);
      return;
    }
    if (event.target && event.target.id === 'conversation-service') {
      setConversationService(event.target.value);
      return;
    }
    if (event.target && event.target.id === 'conversation-assistant') {
      selectAssistant(event.target.value);
    }
  }

  function handleInput(event) {
    if (!event.target) return;
    if (event.target.dataset && event.target.dataset.conversationAction === 'trace-search') {
      traceViewerSearch = event.target.value || '';
      refreshOpenTraceViewer(true);
      var searchInput = document.querySelector('[data-conversation-action="trace-search"]');
      if (searchInput) { searchInput.focus(); searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); }
    } else if (event.target.id === 'conversation-input') {
      var topic = displayedTopic();
      var assistant = selectedAssistant();
      composerDrafts[currentDraftKey(topic, assistant)] = event.target.value;
    } else if (event.target.id === 'conversation-run-input') {
      var selectedTopic = displayedTopic();
      if (selectedTopic && selectedTopic.topicId) runInputDrafts[selectedTopic.topicId] = event.target.value;
    } else if (event.target.classList && event.target.classList.contains('conversation-user-input-other')) {
      var question = event.target.closest('.conversation-user-input-question');
      var otherRadio = question && question.querySelector('input[type="radio"][value="__other__"]');
      if (otherRadio) otherRadio.checked = true;
    }
  }

  function handleTrajectoryInspectorPointerDown(event) {
    if (!event.isPrimary) return;
    var timelineRoot = event.target && event.target.closest && event.target.closest('.conversation-trace-timeline');
    var timelineLane = timelineRoot && timelineRoot.querySelector('.conversation-trace-timeline-lanes');
    if (timelineRoot && event.button === 2) {
      trajectoryTimelinePan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        moved: false,
        viewport: trajectoryTimelineViewport && Object.assign({}, trajectoryTimelineViewport),
      };
      if (timelineLane && timelineLane.setPointerCapture) {
        try { timelineLane.setPointerCapture(event.pointerId); } catch (_) {}
      }
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    var timelineCell = event.target.closest('.conversation-trace-timeline-span[data-cell-index]');
    if (timelineRoot && timelineLane) {
      var timelineTopic = displayedTopic();
      var timelineCells = timelineTopic ? topicTrajectoryItems(timelineTopic) : [];
      var timelineModel = trajectoryTimelineModel(timelineCells, trajectoryTimelineMode());
      if (!timelineModel) return;
      trajectoryTimelineAnchor = {
        pointerId: event.pointerId,
        start: trajectoryTimelinePoint(event, timelineLane, timelineModel),
        end: trajectoryTimelinePoint(event, timelineLane, timelineModel),
        cellIndex: Number(timelineCell && timelineCell.dataset.cellIndex) || 0,
        startX: event.clientX,
      };
      if (timelineLane.setPointerCapture) {
        try { timelineLane.setPointerCapture(event.pointerId); } catch (_) {}
      }
      return;
    }
    if (!trajectoryInspectorOpen) return;
    var handle = event.target.closest('.conversation-trace-resize');
    if (!handle) return;
    var panel = handle.parentElement;
    if (!panel) return;
    trajectoryInspectorResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: panel.getBoundingClientRect().width };
    if (handle.setPointerCapture) {
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    }
    event.preventDefault();
  }

  function handleTrajectoryInspectorPointerMove(event) {
    if (trajectoryTimelinePan && event.pointerId === trajectoryTimelinePan.pointerId) {
      var panRoot = event.target && event.target.closest && event.target.closest('.conversation-trace-timeline-lanes');
      var panTopic = displayedTopic();
      var panCells = panTopic ? topicTrajectoryItems(panTopic) : [];
      var panViewport = trajectoryTimelinePan.viewport;
      var panModel = trajectoryTimelineModel(panCells, trajectoryTimelineMode());
      if (panRoot && panModel && panViewport) {
        var panWidth = Math.max(1, panRoot.getBoundingClientRect().width);
        var span = Math.max(1, Number(panViewport.end) - Number(panViewport.start));
        var shift = (event.clientX - trajectoryTimelinePan.startX) / panWidth * span;
        if (Math.abs(shift) >= 1) trajectoryTimelinePan.moved = true;
        var nextStart = Math.min(Math.max(Number(panViewport.start) - shift, panModel.start), panModel.end - span);
        trajectoryTimelineViewport = { start: nextStart, end: nextStart + span };
      }
      return;
    }
    if (trajectoryTimelineAnchor && event.pointerId === trajectoryTimelineAnchor.pointerId) {
      var hover = document.elementFromPoint(event.clientX, event.clientY);
      var timelineRoot = hover && hover.closest && hover.closest('.conversation-trace-timeline-lanes');
      var moveTopic = displayedTopic();
      var moveCells = moveTopic ? topicTrajectoryItems(moveTopic) : [];
      var moveModel = trajectoryTimelineModel(moveCells, trajectoryTimelineMode());
      if (timelineRoot && moveModel) trajectoryTimelineAnchor.end = trajectoryTimelinePoint(event, timelineRoot, moveModel);
    }
    if (!trajectoryInspectorResize || event.pointerId !== trajectoryInspectorResize.pointerId) return;
    var width = trajectoryInspectorResize.startWidth - (event.clientX - trajectoryInspectorResize.startX);
    trajectoryInspectorWidth = Math.max(320, Math.min(720, Math.round(width)));
    var main = document.querySelector('.conversation-trace-main');
    if (main) main.style.width = trajectoryInspectorWidth + 'px';
  }

  function handleTrajectoryInspectorPointerUp(event) {
    if (trajectoryTimelinePan && (!event || event.pointerId === trajectoryTimelinePan.pointerId)) {
      var moved = trajectoryTimelinePan.moved;
      trajectoryTimelinePan = null;
      if (!moved) {
        trajectoryTimelineViewport = null;
      }
      refreshOpenTraceViewer(true);
      return;
    }
    if (trajectoryTimelineAnchor && event.pointerId === trajectoryTimelineAnchor.pointerId) {
      var anchor = trajectoryTimelineAnchor;
      trajectoryTimelineAnchor = null;
      var endPoint = anchor.end;
      var endRoot = event.target && event.target.closest && event.target.closest('.conversation-trace-timeline-lanes');
      var endTopic = displayedTopic();
      var endModel = trajectoryTimelineModel(endTopic ? topicTrajectoryItems(endTopic) : [], trajectoryTimelineMode());
      if (endRoot && endModel) endPoint = trajectoryTimelinePoint(event, endRoot, endModel);
      if (anchor.start !== endPoint && Math.abs(event.clientX - anchor.startX) > 3) {
        trajectoryTimelineRange = { start: Math.min(anchor.start, endPoint), end: Math.max(anchor.start, endPoint) };
        refreshOpenTraceViewer(true);
      }
    }
    if (trajectoryInspectorResize && (!event || event.pointerId === trajectoryInspectorResize.pointerId)) trajectoryInspectorResize = null;
  }

  function handleTrajectoryTimelineWheel(event) {
    if (!trajectoryViewOpen || !event || !event.target || !event.target.closest) return;
    var timeline = event.target.closest('.conversation-trace-timeline-lanes');
    if (!timeline) return;
    var topic = displayedTopic();
    var cells = topic ? topicTrajectoryItems(topic) : [];
    var mode = trajectoryTimelineMode();
    var model = trajectoryTimelineModel(cells, mode);
    if (!model || model.spans.length < 2) return;
    event.preventDefault();
    var current = trajectoryTimelineDomain(model, trajectoryTimelineViewport);
    var fullSpan = Math.max(1, model.end - model.start);
    var currentSpan = Math.max(1, current.end - current.start);
    var minimumSpan = mode === 'sequence' ? Math.min(5, fullSpan) : Math.min(20, fullSpan);
    var nextSpan = Math.min(fullSpan, Math.max(minimumSpan,
      currentSpan * Math.exp(Number(event.deltaY || 0) * 0.0015)));
    if (nextSpan >= fullSpan * .999) {
      trajectoryTimelineViewport = null;
      refreshOpenTraceViewer(true);
      return;
    }
    var rect = timeline.getBoundingClientRect();
    var fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    var anchor = current.start + fraction * currentSpan;
    var nextStart = Math.min(Math.max(anchor - fraction * nextSpan, model.start), model.end - nextSpan);
    trajectoryTimelineViewport = { start: nextStart, end: nextStart + nextSpan };
    refreshOpenTraceViewer(true);
  }

  function handleTrajectoryTimelineReset(event) {
    if (!trajectoryViewOpen || !event || !event.target || !event.target.closest
        || !event.target.closest('.conversation-trace-timeline')) return;
    event.preventDefault();
    trajectoryTimelineViewport = null;
    trajectoryTimelineRange = null;
    refreshOpenTraceViewer(true);
  }

  function handleTrajectoryTimelineContextMenu(event) {
    if (trajectoryViewOpen && event.target && event.target.closest
        && event.target.closest('.conversation-trace-timeline')) event.preventDefault();
  }

  function handleEventStreamScroll(event) {
    var stream = event.target;
    if (trajectoryViewOpen && stream && stream.classList
        && stream.classList.contains('conversation-trace-table-wrap')) {
      trajectoryFollowsTail = trajectoryPaneAtTail(stream);
      if (trajectoryVirtualState) scheduleTrajectoryVirtualization();
      return;
    }
    if (!stream || stream.id !== 'conversation-event-stream'
        || stream.getAttribute('data-conversation-virtual-updating') === 'true') return;
    var currentTop = Math.max(0, Number(stream.scrollTop) || 0);
    var previousValue = stream.dataset.previousScrollTop;
    stream.dataset.previousScrollTop = String(currentTop);
    /* Appending rows, following the tail and restoring a prepend anchor all
       emit scroll events. Older pages are user-driven and load only while the
       viewport is actually moving upward into the top edge. */
    if (previousValue === undefined || currentTop >= Math.max(0, Number(previousValue) || 0)
        || currentTop > CONVERSATION_OLDER_LOAD_THRESHOLD || stream.dataset.loadingOlder === 'true') return;
    var topic = displayedTopic();
    if (!topic || String(topic.topicId || '') !== String(stream.dataset.topicId || '')) return;
    var topicId = String(topic.topicId || '');
    if (!topic.hasMoreBefore) return;
    requestOlderConversationEvents(stream, topic, topicId);
  }

  function requestOlderConversationEvents(stream, topic, topicId) {
    if (!stream || !topic || !topicId || !topic.hasMoreBefore || stream.dataset.loadingOlder === 'true') return;
    var beforeSequence = topic.eventCursor && topic.eventCursor.beforeSequence;
    if (!beforeSequence) return;
    stream.dataset.loadingOlder = 'true';
    setConversationHistoryLoading(stream, true);
    var operation = sendConversationCommand('GET_EVENTS', {
        conversationId: topicId,
        cursor: { beforeSequence: beforeSequence },
        limit: conversationListView.DEFAULT_PAGE_SIZE,
        includePayloads: true,
      }).then(function (page) {
        var current = displayedTopic();
        if (!current || current.topicId !== topicId) return;
        var olderRaw = page && Array.isArray(page.events) ? page.events : [];
        var cachedRaw = Array.isArray(rawConversationEventsByTopic[topicId])
          ? rawConversationEventsByTopic[topicId].slice() : [];
        var mergedRaw = conversationListView.mergeJournalPages(cachedRaw, olderRaw);
        rawConversationEventsByTopic[topicId] = mergedRaw;
        conversationEventsCompleteByTopic[topicId] = !(page && page.hasMoreBefore);
        var projectedPage = conversationListView.projectPage({
          events: mergedRaw,
          streamBuffers: page && page.streamBuffers || [],
        });
        current.events = (projectedPage.projectedEvents || []).map(projectListEventForOptions).filter(Boolean);
        current.eventCursor = {
          beforeSequence: mergedRaw.length ? Number(mergedRaw[0].sequence) || null : null,
          afterSequence: mergedRaw.length ? Number(mergedRaw[mergedRaw.length - 1].sequence) || null : null,
        };
        current.eventTotal = Number(page && page.total) || current.eventTotal;
        current.hasMoreBefore = !!(page && page.hasMoreBefore);
      });
    operation.then(function () {
      var current = displayedTopic();
      if (!current || current.topicId !== topicId || !stream.isConnected) return;
      patchEventStream(current, { stickToEnd: false, preserveScroll: true });
    }).catch(function (error) {
      toast('加载更早消息失败: ' + (error && error.message || error), true);
    }).finally(function () {
      delete stream.dataset.loadingOlder;
      setConversationHistoryLoading(stream, false);
    });
  }

  function handleEventStreamWheel(event) {
    if (!event || Number(event.deltaY) >= 0 || !event.target || !event.target.closest) return;
    var stream = event.target.closest('#conversation-event-stream');
    if (!stream || stream.getAttribute('data-conversation-virtual-updating') === 'true') return;
    var currentTop = Math.max(0, Number(stream.scrollTop) || 0);
    if (currentTop > CONVERSATION_OLDER_LOAD_THRESHOLD || stream.dataset.loadingOlder === 'true') return;
    var topic = displayedTopic();
    if (!topic || String(topic.topicId || '') !== String(stream.dataset.topicId || '') || !topic.hasMoreBefore) return;
    requestOlderConversationEvents(stream, topic, String(topic.topicId || ''));
  }

  function handleKeydown(event) {
    var action = event.target && event.target.dataset && event.target.dataset.conversationAction;
    if (action === 'trajectory-resize-inspector' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      trajectoryInspectorWidth = Math.max(320, Math.min(720,
        trajectoryInspectorWidth + (event.key === 'ArrowLeft' ? 16 : -16)));
      refreshOpenTraceViewer(true);
      return;
    }
    if (trajectoryViewOpen && event.key === 'Escape' && trajectoryInspectorOpen) {
      event.preventDefault();
      trajectoryInspectorOpen = false;
      refreshOpenTraceViewer(true);
      return;
    }
    if (trajectoryViewOpen && event.key === 'Escape' && trajectoryTimelineRange) {
      trajectoryTimelineRange = null;
      refreshOpenTraceViewer(true);
      return;
    }
    if (!event.target || event.target.id !== 'conversation-input' || event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229) return;
    var shortcutSend = isMacOs() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    var osShortcutSend = !event.shiftKey && !event.altKey && shortcutSend;
    if (osShortcutSend) {
      event.preventDefault();
      sendCurrentMessage();
    }
  }

  function handleConversationCopy(event) {
    conversationShared.copySelectionWithoutTrailingBlankLines(event, $('#conversation-event-stream'));
  }

  function init() {
    if (initialized) return;
    initialized = true;
    conversationEventView.installStyles(document);
    var section = $('#section-conversation');
    if (section) {
      section.addEventListener('keydown', handleKeydown);
      section.addEventListener('copy', handleConversationCopy);
    }
    document.addEventListener('click', handleClick);
    document.addEventListener('pointerdown', handleAssistantPointerDown, true);
    document.addEventListener('pointermove', handleAssistantPointerMove, true);
    document.addEventListener('pointerup', function (event) { finishAssistantDrag(event, false); }, true);
    document.addEventListener('pointercancel', function (event) { finishAssistantDrag(event, true); }, true);
    document.addEventListener('pointerdown', handleTrajectoryInspectorPointerDown, true);
    document.addEventListener('pointermove', handleTrajectoryInspectorPointerMove, true);
    document.addEventListener('pointerup', handleTrajectoryInspectorPointerUp, true);
    document.addEventListener('pointercancel', handleTrajectoryInspectorPointerUp, true);
    document.addEventListener('change', handleChange);
    document.addEventListener('input', handleInput);
    document.addEventListener('scroll', handleEventStreamScroll, true);
    document.addEventListener('wheel', handleEventStreamWheel, { capture: true, passive: true });
    document.addEventListener('wheel', handleTrajectoryTimelineWheel, { capture: true, passive: false });
    document.addEventListener('dblclick', handleTrajectoryTimelineReset, true);
    document.addEventListener('contextmenu', handleTrajectoryTimelineContextMenu, true);
    document.addEventListener('visibilitychange', function () {
      var topic = displayedTopic();
      var controlledElsewhere = topicControlledElsewhere(topic);
      if (!conversationSectionVisible()) {
        if (trajectoryViewOpen) stopTraceViewerAutoRefresh();
        stopReadonlySnapshotRefresh();
        return;
      }
      if (trajectoryViewOpen) renderLoaded();
      if (controlledElsewhere) refresh();
      else syncReadonlySnapshotRefresh(topic, false);
    });
    var drawerOverlay = $('#drawer-overlay');
    var drawerClose = $('#drawer-close');
    function clearAssistantEditorOnDrawerClose() {
      assistantEditorDraft = null;
    }
    if (drawerOverlay) drawerOverlay.addEventListener('click', clearAssistantEditorOnDrawerClose);
    if (drawerClose) drawerClose.addEventListener('click', clearAssistantEditorOnDrawerClose);
    loadSystemSettings().catch(function () {});
    if (syncEventStream) {
      syncEventStream.subscribe(function (event) {
        var resource = String(event && event.resource || '');
        if (resource === 'conversationTopic') {
          var changedTopicId = String(event && event.id || '').trim();
          var currentTopic = displayedTopic();
          /* The Journal broadcast is the authoritative stream for the open
             topic. Avoid a second catalog refresh for the same mutation; it
             destroys the sidebar/event container while the row is streaming. */
          if (changedTopicId && currentTopic && String(currentTopic.topicId || '') === changedTopicId) {
            scheduleJournalRefresh(changedTopicId, true);
          } else {
            refresh();
          }
          return;
        }
        if (resource === 'assistant'
            || ['page', 'flow', 'flowGroup', 'script', 'schedule', 'urlTrigger', 'config'].indexOf(resource) >= 0) {
          refresh();
        }
      });
      window.addEventListener('pagehide', function (event) {
        if (!event.persisted) syncEventStream.destroy();
      });
    }
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && globalThis.PageAutomationSystemSettings
            && changes[globalThis.PageAutomationSystemSettings.SETTINGS_KEY]) {
          applyConversationSettings(globalThis.PageAutomationSystemSettings.normalize(
            changes[globalThis.PageAutomationSystemSettings.SETTINGS_KEY].newValue
          ));
        }
      });
    }
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message) return;
      if (message.type === 'CONVERSATION_JOURNAL_UPDATED') {
        var traceTopicId = String(message.conversationId || '').trim();
        if (!traceTopicId) return;
        scheduleJournalRefresh(traceTopicId);
        return;
      }
      if (message.type === 'RUN_HISTORY_UPDATED' && !topicControlledElsewhere(displayedTopic())) syncRunResult();
    });
  }

  return {
    init: init,
    render: render,
    refresh: refresh,
    openTarget: openTarget,
  };
});
