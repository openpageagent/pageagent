// The only ingress for starting or mutating Conversation generations.
(function attachConversationCommandBus(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var protocol = commonJs ? require('../agent/conversation-protocol') : root.ConversationProtocol;
  var capability = commonJs ? require('../agent/capability-policy') : root.CapabilityPolicy;
  var conversationListView = commonJs ? require('../ui/conversation-list-view') : root.PageAutomationConversationListView;
  var api = factory(root, protocol, capability, conversationListView);
  if (commonJs) module.exports = api;
  else root.ConversationCommandBus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, protocolModule, capabilityModule, conversationListView) {
  'use strict';

  var API_VERSION = 1;
  var RAW_HISTORY_SCAN_SIZE = 500;
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function extensionPath(chromeApi, path) {
    try { return chromeApi && chromeApi.runtime && chromeApi.runtime.getURL(path); } catch (_) { return ''; }
  }
  function trustedSurfaceFromSender(sender, chromeApi) {
    sender = sender || {};
    if (sender.internalSurface === 'scheduled') {
      return {
        type: 'scheduled', instanceId: text(sender.instanceId || sender.scheduleId),
        tabId: 0, windowId: 0, incognito: sender.incognito === true,
      };
    }
    if (sender.internalSurface === 'mcp') {
      var mcpSurface = {
        type: 'mcp', instanceId: text(sender.instanceId) || 'mcp-transport',
        tabId: 0, windowId: 0, incognito: sender.incognito === true,
      };
      if (sender.assistantInvocationKind) mcpSurface.assistantInvocationKind = text(sender.assistantInvocationKind);
      return mcpSurface;
    }
    if (chromeApi && chromeApi.runtime && sender.id && sender.id !== chromeApi.runtime.id) {
      throw protocolModule.error('INVALID_COMMAND', 'Conversation commands must originate from this extension');
    }
    var url = text(sender.url || sender.origin);
    var normalizedUrl = url.split('#')[0].split('?')[0];
    var type = '';
    if (normalizedUrl && normalizedUrl === extensionPath(chromeApi, 'options/options.html')) type = 'options';
    else if (normalizedUrl && normalizedUrl === extensionPath(chromeApi, 'sidepanel/sidepanel.html')) type = 'sidepanel';
    else if (/\/options\/options\.html$/.test(normalizedUrl)) type = 'options';
    else if (/\/sidepanel\/sidepanel\.html$/.test(normalizedUrl)) type = 'sidepanel';
    else if (sender.tab && Number(sender.tab.id) > 0 && /^(?:https?|file):/i.test(url)) type = 'page';
    if (!type) throw protocolModule.error('INVALID_COMMAND', 'Untrusted Conversation command sender');
    return {
      type: type,
      instanceId: text(sender.documentId) || (type === 'page' ? 'tab:' + Number(sender.tab.id) : type + ':' + (Number(sender.tab && sender.tab.windowId) || 0)),
      tabId: Number(sender.tab && sender.tab.id) || 0,
      windowId: Number(sender.tab && sender.tab.windowId) || 0,
      incognito: !!(sender.tab && sender.tab.incognito),
    };
  }
  function success(result) { return { ok: true, result: clone(result) }; }
  function surfaceCapabilities(surface) {
    var matrix = capabilityModule && capabilityModule.SURFACE_MATRIX;
    var value = matrix && matrix[surface && surface.type];
    if (!value) throw protocolModule.error('INVALID_COMMAND', 'Unknown trusted Conversation surface');
    return value;
  }
  function requireSurfaceCapability(surface, key, command) {
    if (surfaceCapabilities(surface)[key] === true) return;
    throw protocolModule.error('CAPABILITY_UNAVAILABLE', command + ' is unavailable on the ' + surface.type + ' surface');
  }
  /* GET_EVENTS is a UI history boundary. Its backwards/default limit counts
     projected cards, not transport rows, so a long stream-delta run cannot
     consume a whole page and leave the reader with one ASSISTANT card. Live
     afterSequence reads stay row-bounded because they are incremental tail
     synchronization rather than user-facing pagination. */
  function trimVisibleEventPage(events, target, listView) {
    events = Array.isArray(events) ? events : [];
    if (listView.mergeProjected(events, []).length <= target) return events;
    var low = 0;
    var high = events.length - 1;
    var best = 0;
    while (low <= high) {
      var middle = Math.floor((low + high) / 2);
      if (listView.mergeProjected(events.slice(middle), []).length >= target) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    /* Keep only non-card request context and the matching tool plan. Pulling
       every earlier event from the same request can add a reasoning/assistant
       card and violate the visible page size. */
    var selected = listView.mergeProjected(events.slice(best), []);
    var oldest = selected[0] || {};
    var requestId = text(oldest.modelRequestId);
    var toolCallId = text(oldest.toolCallId);
    if (requestId || toolCallId) {
      for (var index = 0; index < best; index += 1) {
        var event = events[index] || {};
        var eventPayload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        var eventType = text(event.type).toLowerCase();
        var requestContext = eventType === 'context_injected'
          || eventType === 'model_request_prepared'
          || eventType === 'model_request_started'
          || eventType === 'request/header'
          || eventType === 'request/context';
        var toolPlan = eventType === 'tool_call_planned'
          || eventType === 'tool/call'
          || eventType === 'tool_call';
        var sameRequest = requestId && text(event.modelRequestId || eventPayload.modelRequestId) === requestId;
        var sameTool = toolCallId && text(event.toolCallId || eventPayload.toolCallId || eventPayload.callId) === toolCallId;
        if ((requestContext && sameRequest) || (toolPlan && sameTool)) { best = index; break; }
      }
    }
    return events.slice(best);
  }

  async function collectVisibleEventPage(queryPage, input, listView) {
    var target = Math.max(1, Number(input && input.limit) || 1);
    var cursor = Object.assign({}, input && input.cursor || {});
    var collected = [];
    var firstPage = null;
    var lastPage = null;
    var previousBefore = null;
    for (;;) {
      var projectedCount = listView.mergeProjected(collected, []).length;
      var page = await queryPage(cursor, RAW_HISTORY_SCAN_SIZE);
      if (!firstPage) firstPage = page;
      lastPage = page;
      var events = page && Array.isArray(page.events) ? page.events : [];
      collected = listView.mergeJournalPages(events, collected);
      projectedCount = listView.mergeProjected(collected, []).length;
      if (projectedCount >= target || !page || !page.hasMoreBefore || !events.length) break;
      var beforeSequence = page.cursors && page.cursors.beforeSequence
        || events[0] && events[0].sequence;
      beforeSequence = Math.max(0, Number(beforeSequence) || 0);
      if (!beforeSequence || beforeSequence === previousBefore) break;
      previousBefore = beforeSequence;
      cursor = Object.assign({}, cursor, { beforeSequence: beforeSequence });
      delete cursor.afterSequence;
    }
    var collectedFirstSequence = collected.length ? Number(collected[0].sequence) || 0 : 0;
    collected = trimVisibleEventPage(collected, target, listView);
    var trimmedEarlierEvents = !!(collected.length && collectedFirstSequence
      && Number(collected[0].sequence) > collectedFirstSequence);
    firstPage = firstPage || {};
    lastPage = lastPage || firstPage;
    return Object.assign({}, firstPage, {
      events: collected,
      limit: target,
      hasMoreBefore: trimmedEarlierEvents || !!lastPage.hasMoreBefore,
      hasMoreAfter: !!firstPage.hasMoreAfter,
      cursors: {
        beforeSequence: collected.length ? Number(collected[0].sequence) || null : null,
        afterSequence: collected.length ? Number(collected[collected.length - 1].sequence) || null : null,
      },
    });
  }

  function create(options) {
    options = options || {};
    var coordinator = options.coordinator;
    var journal = options.journal;
    if (!coordinator || typeof coordinator.startTurn !== 'function') throw new TypeError('ConversationCommandBus requires TurnCoordinator');
    if (!journal || typeof journal.queryEvents !== 'function') throw new TypeError('ConversationCommandBus requires ConversationJournalStore');
    if (!conversationListView || typeof conversationListView.mergeProjected !== 'function'
        || typeof conversationListView.mergeJournalPages !== 'function') {
      throw new TypeError('ConversationCommandBus requires ConversationListView projection');
    }
    var chromeApi = options.chrome || root && root.chrome;
    var protocol = options.protocol || protocolModule.create({ resolveService: options.resolveService });
    var recordingAttachments = options.recordingAttachments || null;
    var resolveSurface = typeof options.resolveSurface === 'function'
      ? options.resolveSurface : function (sender) { return trustedSurfaceFromSender(sender, chromeApi); };
    var ready = options.ready ? Promise.resolve(options.ready) : Promise.resolve();

    async function hydratePage(page) {
      if (!page || !Array.isArray(page.events)) return page;
      var events = [];
      for (var index = 0; index < page.events.length; index += 1) {
        var event = clone(page.events[index]);
        if (event.payloadRef && typeof journal.getPayloadBlob === 'function') {
          var blob = await journal.getPayloadBlob(event.payloadRef.payloadId, event.payloadRef.sha256);
          if (blob) event.payload = clone(blob.value);
        }
        if (event.type === 'summary_committed' && event.payload && event.payload.checkpointId
            && typeof journal.getCheckpoint === 'function') {
          var checkpoint = await journal.getCheckpoint(event.conversationId, event.payload.checkpointId);
          if (checkpoint && checkpoint.summary !== undefined) event.payload.summary = clone(checkpoint.summary);
        }
        events.push(event);
      }
      return Object.assign({}, page, { events: events });
    }
    async function execute(normalized, surface, sender) {
      var command = normalized.command;
      var input = normalized.input;
      if (command === protocolModule.COMMANDS.START_TURN) {
        var startPrepared = recordingAttachments
          ? await recordingAttachments.prepareCommand(input, { surface: surface, sender: sender })
          : { input: input, operation: null };
        return coordinator.startTurn(startPrepared.input, startPrepared);
      }
      if (command === protocolModule.COMMANDS.CANCEL_GENERATION) {
        requireSurfaceCapability(surface, surface.type === 'scheduled' ? 'schedulerCancel' : 'userCancel', command);
        return coordinator.cancelGeneration(input);
      }
      if (command === protocolModule.COMMANDS.STEER_GENERATION) {
        requireSurfaceCapability(surface, 'steering', command);
        var steerPrepared = recordingAttachments
          ? await recordingAttachments.prepareCommand(input, { surface: surface, sender: sender })
          : { input: input, operation: null };
        return coordinator.steerGeneration(steerPrepared.input, steerPrepared);
      }
      if (command === protocolModule.COMMANDS.INTERRUPT_MODEL_REQUEST) {
        requireSurfaceCapability(surface, 'steering', command);
        return coordinator.interruptModelRequest(input);
      }
      if (command === protocolModule.COMMANDS.RESOLVE_INTERACTION) {
        requireSurfaceCapability(surface, 'askUser', command);
        return coordinator.resolveInteraction(Object.assign({}, input, { surface: surface }));
      }
      if (command === protocolModule.COMMANDS.GET_CONVERSATION) return coordinator.getSnapshot(input.conversationId);
      if (command === protocolModule.COMMANDS.GET_EVENTS) {
        var metadata = await journal.getMetadata(input.conversationId);
        if (!metadata) throw protocolModule.error('CONVERSATION_NOT_FOUND', 'Conversation does not exist', { conversationId: input.conversationId });
        var filtered = input.branchId || input.generationId || input.types.length || input.q || input.actorId;
        var forward = input.cursor && Object.prototype.hasOwnProperty.call(input.cursor, 'afterSequence');
        var queryPage = async function (cursor, limit) {
          var result = await journal.queryEvents(input.conversationId, Object.assign({}, cursor, {
            limit: limit, branchId: input.branchId, generationId: input.generationId,
            types: input.types, q: input.q, actorId: input.actorId,
          }));
          return input.includePayloads ? hydratePage(result) : result;
        };
        var page = !filtered && !forward
          ? await collectVisibleEventPage(queryPage, input, conversationListView)
          : await queryPage(input.cursor, input.limit);
        page.streamBuffers = typeof journal.listStreamBuffers === 'function'
          ? await journal.listStreamBuffers(input.conversationId, metadata.activeGeneration && metadata.activeGeneration.generationId)
          : [];
        return page;
      }
      if (command === protocolModule.COMMANDS.GET_SUMMARY) {
        var conversation = await journal.getMetadata(input.conversationId);
        if (!conversation) throw protocolModule.error('CONVERSATION_NOT_FOUND', 'Conversation does not exist', { conversationId: input.conversationId });
        return { conversationId: input.conversationId, checkpoint: await journal.getActiveCheckpoint(input.conversationId) };
      }
      throw protocolModule.error('INVALID_COMMAND', 'Unknown Conversation command');
    }
    async function dispatch(message, sender) {
      try {
        await ready;
        var surface = await Promise.resolve(resolveSurface(sender || {}));
        var normalized = protocol.normalizeCommand(message, surface);
        return success(await execute(normalized, surface, sender || {}));
      } catch (error) {
        return protocolModule.errorResponse(error);
      }
    }
    async function dispatchInternal(message, trustedSurface) {
      return dispatch(message, Object.assign({ internalSurface: trustedSurface && trustedSurface.type }, trustedSurface || {}));
    }

    return Object.freeze({ API_VERSION: API_VERSION, dispatch: dispatch, dispatchInternal: dispatchInternal });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    trustedSurfaceFromSender: trustedSurfaceFromSender,
    collectVisibleEventPage: collectVisibleEventPage,
    trimVisibleEventPage: trimVisibleEventPage,
    create: create,
  });
});
