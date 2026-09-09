(function attachConversationRecordingCoordinator(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var contract = commonJs ? require('../shared/recording-contract') : root.PageAutomationRecordingContract;
  var api = factory(root, contract);
  if (commonJs) module.exports = api;
  if (root) root.PageAutomationConversationRecordingCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, contract) {
  'use strict';
  if (!contract || contract.API_VERSION !== 1) throw new Error('RecordingContract must load before ConversationRecordingCoordinator');
  var API_VERSION = 1;
  var SESSION_MARKER_KEY = 'conversation_recording_browser_session_id';
  var AUTO_ALARM_BASE_PREFIX = 'conversation-recording-auto-stop:';
  var DRAIN_ALARM_BASE_PREFIX = 'conversation-recording-drain:';
  function clone(value) { return contract.clone(value); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function boundedText(value, label, maxLength, required) {
    var output = text(value);
    if (required && !output) throw contract.error('INVALID_REQUEST', label + ' is required');
    if (output.length > maxLength) throw contract.error('INVALID_REQUEST', label + ' exceeds ' + maxLength + ' characters');
    return output;
  }
  function revision(value, label) {
    var output = Number(value);
    if (!Number.isSafeInteger(output) || output < 1) throw contract.error('INVALID_REQUEST', label + ' is invalid');
    return output;
  }
  function randomId(prefix, cryptoApi) {
    var random = cryptoApi && cryptoApi.randomUUID ? cryptoApi.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return prefix + '_' + random;
  }
  function isWebUrl(value) { return /^(?:https?|file):/i.test(String(value || '')); }
  function isInjectableUrl(value) { return /^(?:https?|file|about:blank)/i.test(String(value || '')); }
  function invoke(target, method, args) {
    args = Array.isArray(args) ? args.slice() : [];
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(error, value) { if (settled) return; settled = true; if (error) reject(error); else resolve(value); }
      function callback(value) {
        var error = root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
        finish(error ? new Error(error.message || String(error)) : null, value);
      }
      try {
        var result = target[method].apply(target, args.concat(callback));
        if (result && typeof result.then === 'function') result.then(function (value) { finish(null, value); }, finish);
      } catch (error) { finish(error); }
    });
  }
  function withTimeout(promise, timeoutMs, message) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = root.setTimeout(function () {
        finish(new Error(message || 'Operation timed out'));
      }, Math.max(1, Number(timeoutMs) || 1));
      function finish(error, value) {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      }
      Promise.resolve(promise).then(function (value) { finish(null, value); }, finish);
    });
  }
  function create(options) {
    options = options || {};
    var runtimeScope = options.runtimeScope === 'incognito' ? 'incognito' : 'regular';
    var AUTO_ALARM_PREFIX = AUTO_ALARM_BASE_PREFIX + runtimeScope + ':';
    var DRAIN_ALARM_PREFIX = DRAIN_ALARM_BASE_PREFIX + runtimeScope + ':';
    var chromeApi = options.chrome || root.chrome;
    var store = options.store;
    var compiler = options.compiler;
    var projector = options.projector;
    if (!chromeApi || !store || !compiler || !projector) throw new TypeError('ConversationRecordingCoordinator requires chrome, store, compiler and projector');
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var cryptoApi = options.crypto || root.crypto;
    var sessionMarkerKey = text(options.sessionMarkerKey) || SESSION_MARKER_KEY;
    var broadcast = typeof options.broadcast === 'function' ? options.broadcast : function (message) {
      try { chromeApi.runtime.sendMessage(message, function () { void chromeApi.runtime.lastError; }); } catch (_) {}
    };
    var onBadgeReleased = typeof options.onBadgeReleased === 'function'
      ? options.onBadgeReleased : function () {};
    var browserSessionId = '';
    var intake = Promise.resolve();
    var pendingHellos = Object.create(null);
    var pendingNavigationTargets = Object.create(null);
    var documentEpochs = Object.create(null);
    var navigationCurrent = Object.create(null);
    var navigationLastSeen = Object.create(null);
    var navigationReconcileTimers = Object.create(null);
    var preparedArtifacts = Object.create(null);
    var recordingEventCaches = Object.create(null);
    function enqueue(operation) {
      var next = intake.catch(function () {}).then(function () { return recordingReady; }).then(operation);
      intake = next.catch(function () {});
      return next;
    }
    function storageGet(key) { return invoke(chromeApi.storage.session, 'get', [key]); }
    function storageSet(value) { return invoke(chromeApi.storage.session, 'set', [value]); }
    async function boot() {
      await store.open();
      var stored = await storageGet([sessionMarkerKey]).catch(function () { return {}; });
      browserSessionId = text(stored && stored[sessionMarkerKey]);
      if (!browserSessionId) {
        browserSessionId = randomId('browser', cryptoApi);
        await storageSet((function () { var value = {}; value[sessionMarkerKey] = browserSessionId; return value; })());
      }
      await store.reconcileBrowserSession(browserSessionId);
      var active = await store.getActiveSession();
      if (active) await recoverActive(active);
      else await setBadge(false);
      await store.gc().catch(function () {});
      return { browserSessionId: browserSessionId, active: active };
    }
    var recordingReady = boot();
    function surfaceContext(sender) {
      var tabId = Number(sender && sender.tab && sender.tab.id) || 0;
      if (!tabId) throw contract.error('FORBIDDEN', 'Conversation Recording UI requires a page sender');
      return {
        seedTabId: tabId, profileId: 'default', incognito: !!(sender.tab && sender.tab.incognito),
      };
    }
    function tabKey(tabId) { return 'tab:' + Number(tabId); }
    function trustedDocument(sender, localNonce) {
      var tabId = Number(sender && sender.tab && sender.tab.id) || 0;
      var frameId = Number(sender && sender.frameId) || 0;
      if (!tabId) throw contract.error('FORBIDDEN', 'Recorder document sender is invalid');
      var epochKey = tabId + ':' + frameId;
      if (!sender.documentId && !documentEpochs[epochKey]) documentEpochs[epochKey] = 1;
      var documentKey = sender.documentId ? 'document:' + text(sender.documentId) : 'frame:' + epochKey + ':epoch:' + documentEpochs[epochKey];
      return {
        tabId: tabId, tabKey: tabKey(tabId), frameId: frameId, documentId: text(sender.documentId), documentKey: documentKey,
        localNonce: text(localNonce), url: String(sender.url || sender.tab && sender.tab.url || ''), top: frameId === 0,
      };
    }
    async function setBadgeTarget(target, active, state) {
      if (!chromeApi.action) return;
      try {
        if (active) {
          await invoke(chromeApi.action, 'setBadgeBackgroundColor', [Object.assign({ color: '#c73a32' }, target)]);
          await invoke(chromeApi.action, 'setBadgeText', [Object.assign({ text: 'REC' }, target)]);
          await invoke(chromeApi.action, 'setTitle', [Object.assign({ title: state === contract.STATES.RECORDING ? 'Page Agent - REC' : 'Page Agent - 正在停止录制' }, target)]);
        } else {
          await invoke(chromeApi.action, 'setBadgeText', [Object.assign({ text: '' }, target)]);
          await invoke(chromeApi.action, 'setTitle', [Object.assign({ title: '运行面板' }, target)]);
        }
      } catch (_) {}
    }
    async function setBadge(active, state) {
      if (!chromeApi.action) return;
      await setBadgeTarget({}, active, state);
      var tabs = await invoke(chromeApi.tabs, 'query', [{}]).catch(function () { return []; });
      await Promise.all((tabs || []).filter(function (tab) { return Number(tab && tab.id) > 0; }).map(function (tab) {
        return setBadgeTarget({ tabId: Number(tab.id) }, active, state);
      }));
      if (!active) {
        try { onBadgeReleased(); } catch (_) {}
      }
    }
    function publicSession(session) {
      if (!session) return null;
      return {
        recordingId: session.recordingId, state: session.state, startedAt: session.startedAt,
        count: session.acceptedEventCount, truncated: session.truncated === true,
        warning: Number(session.acceptedEventCount) >= contract.LIMITS.MAX_CANDIDATE_EVENTS * contract.LIMITS.WARNING_RATIO,
        draftCollectionId: session.draftCollectionId,
      };
    }
    function pushState(session) {
      broadcast({ type: contract.UI_MESSAGES.STATE_CHANGED, payload: { active: publicSession(session) } });
    }
    function pushLibrary(collection) {
      broadcast({ type: contract.UI_MESSAGES.LIBRARY_CHANGED, payload: collection ? {
        draftCollectionId: collection.draftCollectionId, revision: collection.revision,
        sourceCount: collection.sourceRecordingIds.length, selectedRangeCount: collection.selectedRanges.length,
      } : null });
    }
    async function sendToDocument(document, message) {
      var options = {};
      if (document.documentId) options.documentId = document.documentId;
      else options.frameId = Number(document.frameId) || 0;
      return invoke(chromeApi.tabs, 'sendMessage', [Number(document.tabId), message, options]);
    }
    async function enableDocument(session, document) {
      var capability = randomId('document_capability', cryptoApi);
      var capabilityHash = await store.hashToken(capability);
      var registered = Object.assign({}, document, { capabilityHash: capabilityHash, enabledAt: Number(clock()) });
      await store.registerDocument(session.recordingId, registered);
      var message = {
        type: contract.DOCUMENT_MESSAGES.ENABLE,
        payload: {
          recordingId: session.recordingId, capability: capability, documentLocalNonce: document.localNonce || '',
          state: session.state, showIndicator: document.top === true, startedAt: session.startedAt,
          count: session.acceptedEventCount,
        },
      };
      try { await sendToDocument(registered, message); }
      catch (error) {
        await store.recordDiagnostic(session.recordingId, {
          code: 'document_enable_failed', occurredAt: Number(clock()),
          tabId: Number(document.tabId) || 0, frameId: Number(document.frameId) || 0,
        });
      }
      return message.payload;
    }
    async function enableAllFrames(session, tabId) {
      var frames = [];
      if (chromeApi.webNavigation && chromeApi.webNavigation.getAllFrames) {
        try { frames = await invoke(chromeApi.webNavigation, 'getAllFrames', [{ tabId: Number(tabId) }]) || []; } catch (_) {}
      }
      if (!frames.length) frames = [{ frameId: 0, url: session.startUrl }];
      for (var index = 0; index < frames.length; index += 1) {
        var frame = frames[index];
        var epochKey = tabId + ':' + Number(frame.frameId || 0);
        if (!documentEpochs[epochKey]) documentEpochs[epochKey] = 1;
        await enableDocument(session, {
          tabId: Number(tabId), tabKey: tabKey(tabId), frameId: Number(frame.frameId) || 0,
          documentId: text(frame.documentId), documentKey: frame.documentId ? 'document:' + frame.documentId : 'frame:' + epochKey + ':epoch:' + documentEpochs[epochKey],
          localNonce: '', url: String(frame.url || ''), top: Number(frame.frameId) === 0,
        });
      }
    }
    function terminalStateFor(session) {
      var diagnostics = session && session.diagnostics || [];
      if (session && session.terminalStateHint) return session.terminalStateHint;
      if (session && session.truncated) return contract.STATES.TRUNCATED;
      if (session && (session.interrupted === true || diagnostics.some(function (diagnostic) {
        return diagnostic.code === 'flush_timeout' || diagnostic.code === 'pending_ring_overflow';
      }))) return contract.STATES.INTERRUPTED;
      return contract.STATES.READY;
    }
    async function prepareArtifact(recordingId, appendedEvents) {
      var session = await store.getSession(recordingId);
      if (!session || (session.state !== contract.STATES.RECORDING && session.state !== contract.STATES.DRAINING)) return null;
      var terminalState = terminalStateFor(session);
      var existing = preparedArtifacts[recordingId];
      if (existing
          && Number(existing.preparedAppendSeq) === Number(session.appendSeq)
          && existing.artifact && existing.artifact.state === terminalState) return existing;
      // Keep the derived artifact current while recording; stopping can then commit this snapshot directly.
      var additions = Array.isArray(appendedEvents) ? appendedEvents : [];
      var eventCache = recordingEventCaches[recordingId];
      var events;
      if (!eventCache && additions.length === Number(session.appendSeq)) {
        events = additions.slice();
      } else if (eventCache && Number(eventCache.appendSeq) + additions.length === Number(session.appendSeq)) {
        events = eventCache.events.concat(additions);
      } else if (eventCache && Number(eventCache.appendSeq) === Number(session.appendSeq)) {
        events = eventCache.events;
      } else events = await store.listEvents(recordingId);
      recordingEventCaches[recordingId] = { appendSeq: Number(session.appendSeq) || 0, events: events };
      var compileSession = Object.assign({}, session, { terminalState: terminalState });
      if (!Number(compileSession.cutoffAt)) compileSession.cutoffAt = Number(clock());
      var compiled = await compiler.compile({
        session: compileSession, events: events,
      }, { crypto: cryptoApi });
      preparedArtifacts[recordingId] = {
        recordingId: recordingId, sourceSha256: compiled.sourceSha256,
        artifact: compiled.artifact, preparedAppendSeq: Number(session.appendSeq) || 0,
      };
      return preparedArtifacts[recordingId];
    }
    async function appendTrusted(session, kind, payload, tabId, frameId, occurredAt) {
      if (!session || (session.state !== contract.STATES.RECORDING && session.state !== contract.STATES.DRAINING)) return null;
      var result = await store.appendEventBatch({
        recordingId: session.recordingId, trustedBackground: true,
        documentKey: 'background', capabilityHash: 'background', documentLocalBatchId: randomId('background_batch', cryptoApi),
        events: [{ localEventId: randomId('background_event', cryptoApi), occurredAt: Number(occurredAt) || Number(clock()), kind: kind, payload: clone(payload || {}) }],
        source: { tabId: Number(tabId) || 0, tabKey: tabKey(tabId), frameId: Number(frameId) || 0, documentKey: 'background' },
        finalBatch: false,
      });
      await prepareArtifact(session.recordingId, result.appendedEvents).catch(function () {});
      delete result.appendedEvents;
      return result;
    }
    async function scheduleRecordingAlarms(session) {
      try {
        chromeApi.alarms.create(AUTO_ALARM_PREFIX + session.recordingId + ':' + session.autoStopRevision, { when: session.startedAt + contract.LIMITS.MAX_DURATION_MS });
      } catch (_) {}
    }
    async function clearRecordingAlarms(recordingId) {
      if (!chromeApi.alarms) return;
      var alarms = await invoke(chromeApi.alarms, 'getAll', []).catch(function () { return []; });
      await Promise.all((alarms || []).filter(function (alarm) {
        return alarm.name.indexOf(AUTO_ALARM_PREFIX + recordingId + ':') === 0 || alarm.name.indexOf(DRAIN_ALARM_PREFIX + recordingId + ':') === 0;
      }).map(function (alarm) { return invoke(chromeApi.alarms, 'clear', [alarm.name]).catch(function () {}); }));
    }
    async function start(payload, sender) {
      contract.assertExactKeys(payload, {
        draftCollectionId: true, consentVersion: true, confirmedAt: true,
      }, 'START_CONVERSATION_RECORDING payload');
      boundedText(payload.draftCollectionId, 'draftCollectionId', 256, false);
      boundedText(payload.consentVersion, 'consentVersion', 128, true);
      var confirmedAt = Number(payload.confirmedAt);
      if (payload.consentVersion !== contract.CONSENT_VERSION || !(confirmedAt > 0)
          || confirmedAt > Number(clock()) + 30000 || Number(clock()) - confirmedAt > 5 * 60 * 1000) {
        throw contract.error('INVALID_REQUEST', 'Current recording consent is required');
      }
      var surface = surfaceContext(sender);
      var context = surface;
      var tabs = await invoke(chromeApi.tabs, 'query', [{}]);
      var seed = sender.tab;
      var startedAt = Number(clock());
      var result = await store.startRecording({
        recordingId: randomId('rec', cryptoApi), browserSessionId: browserSessionId, startedAt: startedAt,
        startUrl: String(seed.url || ''), startTitle: String(seed.title || ''), seedTabKey: tabKey(seed.id), seedTabId: seed.id,
        profileId: context.profileId || surface.profileId,
        incognito: surface.incognito, draftCollectionId: text(payload.draftCollectionId),
        consentVersion: payload.consentVersion, confirmedAt: payload.confirmedAt,
        trackedTabs: (function () { var value = {}; value[tabKey(seed.id)] = { tabId: seed.id, tabKey: tabKey(seed.id), windowId: seed.windowId, createdAt: startedAt, initialUrl: String(seed.url || ''), seed: true }; return value; })(),
        excludedTabIds: (tabs || []).filter(function (tab) { return Number(tab.id) !== Number(seed.id); }).map(function (tab) { return Number(tab.id); }),
        knownWindowIds: Array.from(new Set((tabs || []).map(function (tab) { return Number(tab.windowId) || 0; }).filter(Boolean))),
      });
      try {
        await appendTrusted(result.session, 'recording_start', {
          url: String(seed.url || ''), title: String(seed.title || ''),
          openerTabKey: '', windowCreated: false, seed: true,
        }, seed.id, 0, startedAt);
        result.session = await store.getSession(result.session.recordingId);
      } catch (error) {
        await store.finalizeFailed({
          recordingId: result.session.recordingId, state: contract.STATES.FAILED,
          failure: { code: text(error && error.name || 'recording_store_write_failed'), message: String(error && error.message || error) },
        }).catch(function () {});
        throw error;
      }
      await setBadge(true, contract.STATES.RECORDING);
      await scheduleRecordingAlarms(result.session);
      await enableAllFrames(result.session, seed.id);
      pushState(result.session);
      pushLibrary(result.collection);
      return { active: publicSession(result.session), collection: clone(result.collection) };
    }
    async function stopActive(reason) {
      var session = await store.getActiveSession();
      if (!session) {
        var control = await store.getControl();
        var prior = control.lastStopRecordingId ? await store.getSession(control.lastStopRecordingId) : null;
        if (!prior || !prior.stopOperationId) return { active: null, stopped: false };
        var priorArtifact = contract.TERMINAL_STATES[prior.state] ? await store.getArtifact(prior.recordingId) : null;
        return {
          active: null, stopped: true, operationId: prior.stopOperationId, state: prior.state,
          result: priorArtifact ? {
            recordingId: priorArtifact.recordingId, recordingUri: priorArtifact.recordingUri,
            sourceSha256: priorArtifact.sourceSha256, state: priorArtifact.state,
          } : null,
        };
      }
      if (session.state === contract.STATES.DRAINING || session.state === contract.STATES.COMPILING) {
        return { active: publicSession(session), stopped: true, operationId: session.stopOperationId, state: session.state, result: null };
      }
      var cutoffAt = Number(clock());
      var stopNonce = randomId('stop', cryptoApi);
      var stopOperationId = randomId('recording_stop_operation', cryptoApi);
      session = await store.beginDrain({ recordingId: session.recordingId, stopOperationId: stopOperationId, stopNonce: stopNonce, cutoffAt: cutoffAt, drainDeadlineAt: cutoffAt + contract.LIMITS.DRAIN_TIMEOUT_MS, reason: reason });
      await setBadge(true, contract.STATES.DRAINING);
      var completed = await finishStop(session);
      var artifact = completed && contract.TERMINAL_STATES[completed.state] ? await store.getArtifact(completed.recordingId) : null;
      return {
        active: null, stopped: true, operationId: session.stopOperationId,
        state: completed && completed.state || session.state,
        result: artifact ? {
          recordingId: artifact.recordingId, recordingUri: artifact.recordingUri,
          sourceSha256: artifact.sourceSha256, state: artifact.state,
        } : null,
      };
    }
    async function finishStop(session) {
      var activeDocuments = Object.keys(session.documents || {}).map(function (key) { return session.documents[key]; }).filter(function (document) {
        return document.expectedAtStop !== false;
      });
      var documents = activeDocuments.filter(function (document) {
        return document.ackedStopNonce !== session.stopNonce;
      });
      var finalBatches = await Promise.all(documents.map(function (document) {
        return withTimeout(sendToDocument(document, {
          type: contract.DOCUMENT_MESSAGES.STOP_AND_FLUSH,
          payload: { recordingId: session.recordingId, stopNonce: session.stopNonce, cutoffAt: session.cutoffAt },
        }), contract.LIMITS.DRAIN_TIMEOUT_MS, 'Recording document flush timed out').then(function (response) {
          var batch = response && response.ok === true && response.payload && response.payload.batch;
          if (!batch) throw new Error('Recording document did not return its final batch');
          return { document: document, batch: batch };
        }).catch(function () { return { document: document, batch: null }; });
      }));
      var appendedEvents = [];
      for (var batchIndex = 0; batchIndex < finalBatches.length; batchIndex += 1) {
        var finalBatch = finalBatches[batchIndex];
        if (!finalBatch.batch) continue;
        try {
          var appendResult = await appendReturnedFinalBatch(session, finalBatch.document, finalBatch.batch);
          appendedEvents = appendedEvents.concat(appendResult.appendedEvents || []);
        }
        catch (_) {}
      }
      await prepareArtifact(session.recordingId, appendedEvents).catch(function () {});
      try { return await finalizeDrain(session.recordingId, true); }
      finally {
        await Promise.all(activeDocuments.map(function (document) {
          return sendToDocument(document, {
            type: contract.UI_MESSAGES.STATE_CHANGED, payload: { active: null },
          }).catch(function () {});
        }));
      }
    }
    async function finalizeDrain(recordingId, force) {
      var session = await store.getSession(recordingId);
      if (!session || contract.TERMINAL_STATES[session.state]) return session;
      var diagnostics = [];
      if (session.state === contract.STATES.DRAINING) {
        var missing = Object.keys(session.documents || {}).filter(function (key) {
          return session.documents[key].expectedAtStop !== false && session.documents[key].ackedStopNonce !== session.stopNonce;
        });
        if (missing.length && !force && Number(clock()) < session.drainDeadlineAt) return session;
        diagnostics = missing.map(function (key) {
          var document = session.documents[key];
          return {
            code: 'flush_timeout', occurredAt: Number(clock()),
            document: document.documentId ? 'document' : 'frame', tabKey: document.tabKey, frameId: document.frameId,
          };
        });
        session = await store.enterCompiling(recordingId, diagnostics);
      } else if (session.state !== contract.STATES.COMPILING) return session;
      try {
        var terminalState = terminalStateFor(session);
        var compiled = preparedArtifacts[recordingId] || await store.getArtifact(recordingId);
        if (!compiled || Number(compiled.preparedAppendSeq) !== Number(session.appendSeq)
            || !compiled.artifact || compiled.artifact.state !== terminalState) {
          var events = await store.listEvents(recordingId);
          var compileSession = Object.assign({}, session, { terminalState: terminalState });
          compiled = await compiler.compile({ session: compileSession, events: events }, { crypto: cryptoApi });
        }
        var committed = await store.commitArtifact({ recordingId: recordingId, sourceSha256: compiled.sourceSha256, artifact: compiled.artifact, state: terminalState, createdAt: Number(clock()) });
        await clearRecordingAlarms(recordingId);
        await setBadge(false);
        pushState(null);
        pushLibrary(committed.collection);
        delete preparedArtifacts[recordingId];
        delete recordingEventCaches[recordingId];
        return committed.session;
      } catch (error) {
        delete preparedArtifacts[recordingId];
        delete recordingEventCaches[recordingId];
        await store.finalizeFailed({ recordingId: recordingId, state: contract.STATES.FAILED, failure: { code: text(error.code || 'compile_failed'), message: String(error.message || error) } }).catch(function () {});
        await clearRecordingAlarms(recordingId);
        await setBadge(false);
        pushState(null);
        throw error;
      }
    }
    async function handleHello(payload, sender) {
      contract.assertExactKeys(payload, { documentLocalNonce: true }, 'RECORDER_DOCUMENT_HELLO payload');
      var document = trustedDocument(sender, boundedText(payload.documentLocalNonce, 'documentLocalNonce', 180, true));
      var session = await store.getActiveSession();
      if (!session || session.state !== contract.STATES.RECORDING) return { enabled: false, pending: false };
      if (!session.trackedTabs[document.tabKey]) {
        if ((session.excludedTabIds || []).indexOf(document.tabId) !== -1) return { enabled: false, pending: false };
        pendingHellos[document.documentKey] = document;
        return { enabled: false, pending: true };
      }
      var enabled = await enableDocument(session, document);
      return Object.assign({ enabled: true }, enabled);
    }
    async function handleBatch(payload, sender) {
      contract.assertExactKeys(payload, { recordingId: true, capability: true, documentLocalBatchId: true, events: true, diagnostics: true, finalBatch: true, stopNonce: true }, 'RECORDER_EVENT_BATCH payload');
      contract.canonicalRecordingUri(payload.recordingId);
      boundedText(payload.capability, 'document capability', 512, true);
      boundedText(payload.documentLocalBatchId, 'documentLocalBatchId', 512, true);
      if (!Array.isArray(payload.events) || payload.events.length > contract.LIMITS.MAX_CANDIDATE_EVENTS) throw contract.error('INVALID_REQUEST', 'Recording batch events are invalid');
      var document = trustedDocument(sender, '');
      if (payload.diagnostics !== undefined && (!Array.isArray(payload.diagnostics) || payload.diagnostics.length > 8)) {
        throw contract.error('INVALID_REQUEST', 'Recording batch diagnostics are invalid');
      }
      var diagnostics = (payload.diagnostics || []).map(function (diagnostic) {
        contract.assertExactKeys(diagnostic, { code: true, occurredAt: true, count: true }, 'Recording document diagnostic');
        if (text(diagnostic.code) !== 'pending_ring_overflow') throw contract.error('INVALID_REQUEST', 'Unknown Recording document diagnostic');
        var diagnosticAt = Number(diagnostic.occurredAt);
        var diagnosticCount = Number(diagnostic.count);
        if (!Number.isFinite(diagnosticAt) || diagnosticAt < 0 || !Number.isSafeInteger(diagnosticCount) || diagnosticCount < 1 || diagnosticCount > contract.LIMITS.MAX_CANDIDATE_EVENTS) {
          throw contract.error('INVALID_REQUEST', 'Recording document diagnostic is invalid');
        }
        return { code: 'pending_ring_overflow', occurredAt: diagnosticAt, count: diagnosticCount, documentKey: document.documentKey };
      });
      if (typeof payload.finalBatch !== 'boolean') throw contract.error('INVALID_REQUEST', 'finalBatch must be boolean');
      var batchStopNonce = boundedText(payload.stopNonce, 'stopNonce', 256, payload.finalBatch === true);
      if (!payload.finalBatch && batchStopNonce) throw contract.error('INVALID_REQUEST', 'A regular Recording batch cannot carry stopNonce');
      var capabilityHash = await store.hashToken(text(payload.capability));
      var result;
      try {
        result = await store.appendEventBatch({
          recordingId: text(payload.recordingId), documentKey: document.documentKey, capabilityHash: capabilityHash,
          documentLocalBatchId: text(payload.documentLocalBatchId), events: payload.events, diagnostics: diagnostics,
          source: document, finalBatch: payload.finalBatch === true, stopNonce: text(payload.stopNonce),
        });
      } catch (error) {
        var code = text(error && error.code);
        var expected = code && /^(?:INVALID_REQUEST|FORBIDDEN|RESOURCE_NOT_FOUND|RECORDING_)/.test(code);
        if (!expected) {
          delete preparedArtifacts[text(payload.recordingId)];
          delete recordingEventCaches[text(payload.recordingId)];
          await store.finalizeFailed({
            recordingId: text(payload.recordingId), state: contract.STATES.FAILED,
            failure: { code: text(error && error.name || 'recording_store_write_failed'), message: String(error && error.message || error) },
          }).catch(function () {});
          await clearRecordingAlarms(text(payload.recordingId));
          await setBadge(false);
          pushState(null);
        }
        throw error;
      }
      var session = await store.getSession(payload.recordingId);
      await prepareArtifact(payload.recordingId, result.appendedEvents).catch(function () {});
      delete result.appendedEvents;
      pushState(session);
      if (result.truncated && session.state === contract.STATES.RECORDING) await stopActive('event_limit');
      return result;
    }
    async function appendReturnedFinalBatch(session, document, payload) {
      contract.assertExactKeys(payload, {
        recordingId: true, capability: true, documentLocalBatchId: true,
        events: true, diagnostics: true, finalBatch: true, stopNonce: true,
      }, 'Final RECORDER_EVENT_BATCH payload');
      if (text(payload.recordingId) !== session.recordingId || text(payload.stopNonce) !== session.stopNonce
          || payload.finalBatch !== true || !Array.isArray(payload.events)
          || payload.events.length > contract.LIMITS.MAX_CANDIDATE_EVENTS) {
        throw contract.error('INVALID_REQUEST', 'Recording final batch is invalid');
      }
      boundedText(payload.capability, 'document capability', 512, true);
      boundedText(payload.documentLocalBatchId, 'documentLocalBatchId', 512, true);
      var diagnostics = (payload.diagnostics || []).map(function (diagnostic) {
        contract.assertExactKeys(diagnostic, { code: true, occurredAt: true, count: true }, 'Recording document diagnostic');
        var count = Number(diagnostic.count);
        var occurredAt = Number(diagnostic.occurredAt);
        if (text(diagnostic.code) !== 'pending_ring_overflow' || !Number.isSafeInteger(count) || count < 1
            || count > contract.LIMITS.MAX_CANDIDATE_EVENTS || !Number.isFinite(occurredAt) || occurredAt < 0) {
          throw contract.error('INVALID_REQUEST', 'Recording document diagnostic is invalid');
        }
        return { code: 'pending_ring_overflow', occurredAt: occurredAt, count: count, documentKey: document.documentKey };
      });
      var capabilityHash = await store.hashToken(text(payload.capability));
      var result = await store.appendEventBatch({
        recordingId: session.recordingId, documentKey: document.documentKey, capabilityHash: capabilityHash,
        documentLocalBatchId: text(payload.documentLocalBatchId), events: payload.events, diagnostics: diagnostics,
        source: document, finalBatch: true, stopNonce: session.stopNonce,
      });
      await store.acknowledgeDocument({
        recordingId: session.recordingId, documentKey: document.documentKey, capabilityHash: capabilityHash,
        tabId: document.tabId, frameId: document.frameId, stopNonce: session.stopNonce, ackedAt: Number(clock()),
      });
      return result;
    }
    async function handleAck(payload, sender) {
      contract.assertExactKeys(payload, { recordingId: true, capability: true, stopNonce: true }, 'RECORDER_FLUSH_ACK payload');
      contract.canonicalRecordingUri(payload.recordingId);
      boundedText(payload.capability, 'document capability', 512, true);
      boundedText(payload.stopNonce, 'stopNonce', 256, true);
      var document = trustedDocument(sender, '');
      var capabilityHash = await store.hashToken(text(payload.capability));
      var session = await store.acknowledgeDocument({ recordingId: text(payload.recordingId), documentKey: document.documentKey, capabilityHash: capabilityHash, tabId: document.tabId, frameId: document.frameId, stopNonce: text(payload.stopNonce), ackedAt: Number(clock()) });
      await finalizeDrain(session.recordingId, false);
      return { acknowledged: true };
    }
    async function surfaceInput(payload, sender) {
      var surface = surfaceContext(sender);
      var collectionId = boundedText(payload.draftCollectionId, 'draftCollectionId', 256, true);
      return Object.assign({}, surface, { draftCollectionId: collectionId });
    }
    function assertCollectionContext(collection, surface, message) {
      if (!collection) throw contract.error('RESOURCE_NOT_FOUND', 'Draft Recording collection does not exist');
      if (collection.profileId !== surface.profileId) {
        throw contract.error('FORBIDDEN', message || 'Recording collection is unavailable to this profile');
      }
      return collection;
    }
    async function state(payload, sender) {
      contract.assertExactKeys(payload, {}, 'GET_CONVERSATION_RECORDING_STATE payload');
      var surface = surfaceContext(sender);
      var active = await store.getActiveSession();
      var collection = await store.getLatestCollection(surface);
      return {
        active: publicSession(active),
        collection: collection ? clone(collection) : null,
      };
    }
    async function library(payload, sender) {
      contract.assertExactKeys(payload, { draftCollectionId: true }, 'GET_CONVERSATION_RECORDING_LIBRARY payload');
      var surface = await surfaceInput(payload, sender);
      return store.collectionLibrary(surface);
    }
    async function preview(payload, sender) {
      contract.assertExactKeys(payload, { draftCollectionId: true, recordingId: true, expectedRevision: true, query: true }, 'GET_CONVERSATION_RECORDING_SOURCE_PREVIEW payload');
      var surface = await surfaceInput(payload, sender);
      revision(payload.expectedRevision, 'expectedRevision');
      contract.canonicalRecordingUri(payload.recordingId);
      var collection = await store.getCollection(surface.draftCollectionId);
      assertCollectionContext(collection, surface, 'Recording preview is unavailable to this profile');
      if (Number(collection.revision) !== Number(payload.expectedRevision)) throw contract.error('RECORDING_REVISION_CONFLICT', 'Collection revision is stale', { currentRevision: collection.revision });
      if (collection.sourceRecordingIds.indexOf(text(payload.recordingId)) === -1) throw contract.error('FORBIDDEN', 'Recording is not in this collection');
      var artifact = await store.getArtifact(payload.recordingId);
      if (!artifact) throw contract.error('RESOURCE_NOT_FOUND', 'Recording Artifact is missing');
      return projector.project({ recordingId: artifact.recordingId, sourceSha256: artifact.sourceSha256, artifact: artifact.artifact, query: payload.query || {} });
    }
    async function exportSource(payload, sender) {
      contract.assertExactKeys(payload, {
        draftCollectionId: true, recordingId: true,
        expectedRevision: true, start: true, maxChars: true,
      }, 'EXPORT_CONVERSATION_RECORDING_SOURCE payload');
      var surface = await surfaceInput(payload, sender);
      revision(payload.expectedRevision, 'expectedRevision');
      contract.canonicalRecordingUri(payload.recordingId);
      var start = Number(payload.start);
      var maxChars = Number(payload.maxChars);
      if (!Number.isInteger(start) || start < 0 || start > Number.MAX_SAFE_INTEGER) throw contract.error('INVALID_REQUEST', 'Export start is invalid');
      if (!Number.isInteger(maxChars) || maxChars < 1024 || maxChars > contract.LIMITS.MAX_EXPORT_CHUNK_CHARS) throw contract.error('INVALID_REQUEST', 'Export maxChars is invalid');
      var collection = await store.getCollection(surface.draftCollectionId);
      assertCollectionContext(collection, surface, 'Recording export is unavailable to this profile');
      if (Number(collection.revision) !== Number(payload.expectedRevision)) throw contract.error('RECORDING_REVISION_CONFLICT', 'Collection revision is stale', { currentRevision: collection.revision });
      if (collection.sourceRecordingIds.indexOf(text(payload.recordingId)) === -1) throw contract.error('FORBIDDEN', 'Recording is not in this collection');
      var artifact = await store.getArtifact(payload.recordingId);
      if (!artifact) throw contract.error('RESOURCE_NOT_FOUND', 'Recording Artifact is missing');
      var serialized = JSON.stringify({
        schemaVersion: 1,
        kind: 'page-action-recording-export',
        recordingId: artifact.recordingId,
        recordingUri: artifact.recordingUri,
        sourceSha256: artifact.sourceSha256,
        state: artifact.state,
        artifact: artifact.artifact,
      }, null, 2);
      var boundedStart = Math.min(start, serialized.length);
      var end = Math.min(serialized.length, boundedStart + maxChars);
      if (end < serialized.length && end > boundedStart && /[\uD800-\uDBFF]/.test(serialized.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(serialized.charAt(end))) end -= 1;
      return {
        recordingId: artifact.recordingId, sourceSha256: artifact.sourceSha256,
        fileName: artifact.recordingId + '.page-action-recording.json', mimeType: 'application/json;charset=utf-8',
        start: boundedStart, returnedChars: Math.max(0, end - boundedStart), totalChars: serialized.length,
        chunk: serialized.slice(boundedStart, end), hasMore: end < serialized.length, nextStart: end < serialized.length ? end : null,
      };
    }
    async function updateSelection(payload, sender) {
      contract.assertExactKeys(payload, { draftCollectionId: true, expectedRevision: true, ranges: true }, 'UPDATE_CONVERSATION_RECORDING_SELECTION payload');
      var surface = await surfaceInput(payload, sender);
      revision(payload.expectedRevision, 'expectedRevision');
      var collection = await store.updateSelection(Object.assign({}, surface, { expectedRevision: payload.expectedRevision, ranges: payload.ranges }));
      pushLibrary(collection);
      return collection;
    }
    async function removeSource(payload, sender) {
      contract.assertExactKeys(payload, { draftCollectionId: true, expectedRevision: true, recordingId: true }, 'REMOVE_CONVERSATION_RECORDING_SOURCE payload');
      var surface = await surfaceInput(payload, sender);
      revision(payload.expectedRevision, 'expectedRevision');
      contract.canonicalRecordingUri(payload.recordingId);
      var collection = await store.removeSource(Object.assign({}, surface, { expectedRevision: payload.expectedRevision, recordingId: payload.recordingId }));
      pushLibrary(collection);
      return collection;
    }
    async function claimSelection(payload, sender) {
      contract.assertExactKeys(payload, { draftCollectionId: true, expectedRevision: true }, 'CLAIM_CONVERSATION_RECORDING_SELECTION payload');
      var surface = await surfaceInput(payload, sender);
      revision(payload.expectedRevision, 'expectedRevision');
      var collection = await store.getCollection(surface.draftCollectionId);
      assertCollectionContext(collection, surface, 'Recording selection is unavailable to this profile');
      if (Number(collection.revision) !== Number(payload.expectedRevision)) throw contract.error('RECORDING_REVISION_CONFLICT', 'Collection revision is stale', { currentRevision: collection.revision });
      if (!collection.selectedRanges.length) return { attachments: [], recordingSelectionClaim: null };
      var attachments = [];
      for (var index = 0; index < collection.selectedRanges.length; index += 1) {
        var range = collection.selectedRanges[index];
        var artifact = await store.getArtifact(range.recordingId);
        if (!artifact || artifact.sourceSha256 !== range.sourceSha256) throw contract.error('RECORDING_HASH_MISMATCH', 'Selected Recording source is missing or changed');
        attachments.push({
          kind: 'page-action-recording-range', artifactUri: range.recordingUri, name: '页面操作录制 ' + range.recordingId,
          sha256: range.sourceSha256,
          metadata: {
            schemaVersion: artifact.artifact.schemaVersion, eventCount: artifact.artifact.stats.eventCount, durationMs: artifact.artifact.durationMs,
            tabCount: artifact.artifact.stats.tabCount, domainCount: artifact.artifact.stats.domainCount,
            state: artifact.state,
            fromSourceSeq: range.fromSeq, toSourceSeq: range.toSeq,
          },
        });
      }
      return {
        attachments: attachments,
        recordingSelectionClaim: {
          draftCollectionId: collection.draftCollectionId, selectionId: collection.selectionId,
          expectedRevision: collection.revision,
          orderedRanges: collection.selectedRanges.map(function (range) {
            return { recordingId: range.recordingId, recordingUri: range.recordingUri, sourceSha256: range.sourceSha256, fromSeq: range.fromSeq, toSeq: range.toSeq, selectionOrder: range.selectionOrder };
          }),
        },
      };
    }
    async function handleUi(type, payload, sender) {
      if (type === contract.UI_MESSAGES.GET_STATE) return state(payload, sender);
      if (type === contract.UI_MESSAGES.START) return start(payload, sender);
      if (type === contract.UI_MESSAGES.STOP) { contract.assertExactKeys(payload, {}, 'STOP_CONVERSATION_RECORDING payload'); return stopActive('user'); }
      if (type === contract.UI_MESSAGES.GET_LIBRARY) return library(payload, sender);
      if (type === contract.UI_MESSAGES.GET_PREVIEW) return preview(payload, sender);
      if (type === contract.UI_MESSAGES.EXPORT_SOURCE) return exportSource(payload, sender);
      if (type === contract.UI_MESSAGES.UPDATE_SELECTION) return updateSelection(payload, sender);
      if (type === contract.UI_MESSAGES.REMOVE_SOURCE) return removeSource(payload, sender);
      if (type === contract.UI_MESSAGES.CLAIM_SELECTION) return claimSelection(payload, sender);
      throw contract.error('INVALID_REQUEST', 'Unknown Conversation Recording UI message');
    }
    function handleMessage(message, sender, sendResponse) {
      var type = text(message && message.type);
      var documentTypes = contract.DOCUMENT_MESSAGES;
      var uiTypes = contract.UI_MESSAGES;
      var isDocument = type === documentTypes.HELLO || type === documentTypes.BATCH || type === documentTypes.ACK;
      var isUi = Object.keys(uiTypes).some(function (key) { return uiTypes[key] === type; }) && type !== uiTypes.STATE_CHANGED && type !== uiTypes.LIBRARY_CHANGED;
      if (!isDocument && !isUi) return { handled: false, keepChannel: false };
      enqueue(async function () {
        if (type === documentTypes.HELLO) return handleHello(message.payload || {}, sender);
        if (type === documentTypes.BATCH) return handleBatch(message.payload || {}, sender);
        if (type === documentTypes.ACK) return handleAck(message.payload || {}, sender);
        return handleUi(type, message.payload || {}, sender);
      }).then(function (payload) { sendResponse({ ok: true, payload: payload }); }, function (error) {
        sendResponse({ ok: false, error: { code: text(error && error.code || 'RECORDING_FAILED'), message: String(error && error.message || error), details: error && error.details } });
      });
      return { handled: true, keepChannel: true };
    }
    async function onTabCreated(tab) {
      var session = await store.getActiveSession();
      if (!session || session.state !== contract.STATES.RECORDING) return;
      await setBadgeTarget({ tabId: Number(tab.id) }, true, session.state);
      var createdAt = Number(clock());
      var alreadyTracked = !!session.trackedTabs[tabKey(tab.id)];
      var windowCreated = (session.knownWindowIds || []).indexOf(Number(tab.windowId)) === -1;
      if (!alreadyTracked) {
        await store.registerTrackedTab(session.recordingId, {
          tabId: Number(tab.id), tabKey: tabKey(tab.id), windowId: Number(tab.windowId) || 0,
          openerTabId: Number(tab.openerTabId) || 0, createdAt: createdAt, initialUrl: String(tab.pendingUrl || tab.url || ''), seed: false,
        });
        session = await store.getSession(session.recordingId);
        await appendTrusted(session, 'tab_created', { url: String(tab.pendingUrl || tab.url || ''), openerTabKey: tab.openerTabId ? tabKey(tab.openerTabId) : '', windowCreated: windowCreated }, tab.id, 0, createdAt);
      }
      if (pendingNavigationTargets[tab.id]) {
        var target = pendingNavigationTargets[tab.id];
        delete pendingNavigationTargets[tab.id];
        await appendTrusted(session, 'navigation_target', target.payload, tab.id, 0, target.occurredAt);
      }
      var pending = Object.keys(pendingHellos).filter(function (key) { return pendingHellos[key].tabId === Number(tab.id); });
      for (var index = 0; index < pending.length; index += 1) {
        var document = pendingHellos[pending[index]];
        delete pendingHellos[pending[index]];
        await enableDocument(session, document);
      }
    }
    async function onTabRemoved(tabId, removeInfo) {
      var session = await store.getActiveSession();
      if (!session || session.state !== contract.STATES.RECORDING || !session.trackedTabs[tabKey(tabId)]) return;
      await store.retireTabDocuments(session.recordingId, tabId, Number(clock()));
      await appendTrusted(session, 'tab_closed', { windowClosing: !!(removeInfo && removeInfo.isWindowClosing) }, tabId, 0);
      if (navigationReconcileTimers[tabId]) root.clearTimeout(navigationReconcileTimers[tabId]);
      delete navigationReconcileTimers[tabId];
      Object.keys(navigationCurrent).forEach(function (key) { if (key.indexOf(tabId + ':') === 0) delete navigationCurrent[key]; });
      Object.keys(navigationLastSeen).forEach(function (key) { if (key.indexOf(tabId + ':') === 0) delete navigationLastSeen[key]; });
    }
    async function reconcileUpdatedUrl(tabId, expectedUrl, occurredAt) {
      var session = await store.getActiveSession();
      if (!session || !session.trackedTabs[tabKey(tabId)] || session.trackedTabs[tabKey(tabId)].closedAt || session.state !== contract.STATES.RECORDING) return;
      var tab = await invoke(chromeApi.tabs, 'get', [Number(tabId)]).catch(function () { return null; });
      var url = String(tab && (tab.pendingUrl || tab.url) || expectedUrl || '');
      if (!url || url !== String(expectedUrl || '')) return;
      var key = tabId + ':0';
      var seen = navigationLastSeen[key];
      if (!seen || seen.url !== url) {
        var occurrenceId = randomId('navigation', cryptoApi);
        await appendTrusted(session, 'navigation', {
          occurrenceId: occurrenceId, status: 'reconciled', url: url, to: url,
          from: seen && seen.url || '', transitionType: '', transitionQualifiers: [], error: '', documentId: '',
        }, tabId, 0, occurredAt);
        navigationLastSeen[key] = { url: url, at: Number(occurredAt) };
      }
    }
    async function onTabUpdated(tabId, changeInfo) {
      if (!changeInfo || !changeInfo.url) return;
      var session = await store.getActiveSession();
      if (!session || !session.trackedTabs[tabKey(tabId)] || session.state !== contract.STATES.RECORDING) return;
      if (!isInjectableUrl(changeInfo.url)) await store.recordDiagnostic(session.recordingId, {
        code: 'restricted_page', occurredAt: Number(clock()), tabId: Number(tabId) || 0, frameId: 0,
      });
      if (navigationReconcileTimers[tabId]) root.clearTimeout(navigationReconcileTimers[tabId]);
      var occurredAt = Number(clock());
      navigationReconcileTimers[tabId] = root.setTimeout(function () {
        delete navigationReconcileTimers[tabId];
        enqueue(function () { return reconcileUpdatedUrl(tabId, changeInfo.url, occurredAt); }).catch(function () {});
      }, 120);
    }
    async function onNavigation(kind, details) {
      var session = await store.getActiveSession();
      if (!session || !session.trackedTabs[tabKey(details.tabId)] || session.state !== contract.STATES.RECORDING) return;
      var key = details.tabId + ':' + Number(details.frameId || 0);
      var occurredAt = Number(details.timeStamp) || Number(clock());
      var url = String(details.url || '');
      var seen = navigationLastSeen[key];
      if (Number(details.frameId || 0) === 0 && navigationReconcileTimers[details.tabId]) {
        root.clearTimeout(navigationReconcileTimers[details.tabId]);
        delete navigationReconcileTimers[details.tabId];
      }
      if ((kind === 'history' || kind === 'fragment') && seen && seen.url === url) return;
      if (kind === 'committed' && !text(details.documentId)) {
        documentEpochs[key] = Math.max(0, Number(documentEpochs[key]) || 0) + 1;
      }
      var occurrenceId;
      if (kind === 'committed') {
        occurrenceId = text(details.documentId) || randomId('navigation', cryptoApi);
        navigationCurrent[key] = occurrenceId;
      } else if (kind === 'history' || kind === 'fragment') {
        occurrenceId = randomId('navigation', cryptoApi);
      } else occurrenceId = navigationCurrent[key] || text(details.documentId) || randomId('navigation', cryptoApi);
      await appendTrusted(session, 'navigation', {
        occurrenceId: occurrenceId, status: kind, url: url, to: url,
        from: seen && seen.url || '',
        transitionType: String(details.transitionType || ''), transitionQualifiers: clone(details.transitionQualifiers || []),
        error: String(details.error || ''), documentId: text(details.documentId),
      }, details.tabId, details.frameId, occurredAt);
      if (kind === 'committed' || kind === 'history' || kind === 'fragment') {
        navigationLastSeen[key] = { url: url, at: occurredAt };
      }
      if (kind === 'completed' || kind === 'error') delete navigationCurrent[key];
    }
    async function onCreatedNavigationTarget(details) {
      var session = await store.getActiveSession();
      if (!session || session.state !== contract.STATES.RECORDING) return;
      var target = {
        url: String(details.url || ''), sourceTab: session.trackedTabs[tabKey(details.sourceTabId)] ? tabKey(details.sourceTabId) : '', sourceFrameId: Number(details.sourceFrameId) || 0,
      };
      if (!session.trackedTabs[tabKey(details.tabId)]) {
        pendingNavigationTargets[details.tabId] = { payload: target, occurredAt: Number(clock()) };
        return;
      }
      await appendTrusted(session, 'navigation_target', target, details.tabId, 0, Number(clock()));
    }
    async function onAlarm(alarm) {
      var name = text(alarm && alarm.name);
      var prefix = name.indexOf(AUTO_ALARM_PREFIX) === 0 ? AUTO_ALARM_PREFIX : (name.indexOf(DRAIN_ALARM_PREFIX) === 0 ? DRAIN_ALARM_PREFIX : '');
      if (!prefix) return;
      var parts = name.slice(prefix.length).split(':');
      var recordingId = parts[0];
      var revision = Number(parts[1]) || 0;
      var session = await store.getSession(recordingId);
      if (!session) return;
      if (prefix === AUTO_ALARM_PREFIX && Number(session.autoStopRevision) === revision && session.state === contract.STATES.RECORDING) await stopActive('duration_limit');
      if (prefix === DRAIN_ALARM_PREFIX && Number(session.drainRevision) === revision && session.state === contract.STATES.DRAINING) await finalizeDrain(recordingId, true);
    }
    async function recoverActive(session) {
      if (session.browserSessionId !== browserSessionId) {
        if (session.state === contract.STATES.COMPILING && session.terminalStateHint === contract.STATES.INTERRUPTED) {
          await finalizeDrain(session.recordingId, true);
        }
        return;
      }
      if (session.state === contract.STATES.RECORDING) {
        await setBadge(true, session.state);
        await scheduleRecordingAlarms(session);
        var currentTabs = await invoke(chromeApi.tabs, 'query', [{}]).catch(function () { return []; });
        var excluded = session.excludedTabIds || [];
        for (var tabIndex = 0; tabIndex < currentTabs.length; tabIndex += 1) {
          var currentTab = currentTabs[tabIndex];
          if (excluded.indexOf(Number(currentTab.id)) !== -1 || session.trackedTabs[tabKey(currentTab.id)]) continue;
          var recoveredWindowCreated = (session.knownWindowIds || []).indexOf(Number(currentTab.windowId)) === -1;
          await store.registerTrackedTab(session.recordingId, {
            tabId: Number(currentTab.id), tabKey: tabKey(currentTab.id), windowId: Number(currentTab.windowId) || 0,
            openerTabId: Number(currentTab.openerTabId) || 0, createdAt: Number(clock()),
            initialUrl: String(currentTab.pendingUrl || currentTab.url || ''), seed: false, recoveredAfterWorkerRestart: true,
          });
          session = await store.getSession(session.recordingId);
          await appendTrusted(session, 'tab_created', {
            url: String(currentTab.pendingUrl || currentTab.url || ''), openerTabKey: currentTab.openerTabId ? tabKey(currentTab.openerTabId) : '',
            windowCreated: recoveredWindowCreated, recoveredAfterWorkerRestart: true,
          }, currentTab.id, 0, Number(clock()));
        }
        session = await store.getSession(session.recordingId);
        var tabs = Object.keys(session.trackedTabs || {}).map(function (key) { return session.trackedTabs[key]; });
        await Promise.all(tabs.map(function (tab) { return enableAllFrames(session, tab.tabId).catch(function () {}); }));
      } else if (session.state === contract.STATES.DRAINING) {
        await setBadge(true, session.state);
        await finishStop(session);
      } else if (session.state === contract.STATES.COMPILING) await finalizeDrain(session.recordingId, true);
    }
    chromeApi.tabs.onCreated.addListener(function (tab) { enqueue(function () { return onTabCreated(tab); }).catch(function () {}); });
    chromeApi.tabs.onRemoved.addListener(function (tabId, info) { enqueue(function () { return onTabRemoved(tabId, info); }).catch(function () {}); });
    chromeApi.tabs.onUpdated.addListener(function (tabId, changeInfo) { enqueue(function () { return onTabUpdated(tabId, changeInfo); }).catch(function () {}); });
    if (chromeApi.webNavigation) {
      chromeApi.webNavigation.onCommitted.addListener(function (details) { enqueue(function () { return onNavigation('committed', details); }).catch(function () {}); });
      chromeApi.webNavigation.onCompleted.addListener(function (details) { enqueue(function () { return onNavigation('completed', details); }).catch(function () {}); });
      chromeApi.webNavigation.onErrorOccurred.addListener(function (details) { enqueue(function () { return onNavigation('error', details); }).catch(function () {}); });
      chromeApi.webNavigation.onHistoryStateUpdated.addListener(function (details) { enqueue(function () { return onNavigation('history', details); }).catch(function () {}); });
      chromeApi.webNavigation.onReferenceFragmentUpdated.addListener(function (details) { enqueue(function () { return onNavigation('fragment', details); }).catch(function () {}); });
      chromeApi.webNavigation.onCreatedNavigationTarget.addListener(function (details) { enqueue(function () { return onCreatedNavigationTarget(details); }).catch(function () {}); });
    }
    chromeApi.alarms.onAlarm.addListener(function (alarm) { enqueue(function () { return onAlarm(alarm); }).catch(function () {}); });
    return Object.freeze({
      API_VERSION: API_VERSION, ready: recordingReady, handleMessage: handleMessage,
      stopActive: function (reason) { return enqueue(function () { return stopActive(reason); }); },
      getState: function (payload, sender) { return enqueue(function () { return state(payload || {}, sender); }); },
      finalizeDrain: function (recordingId, force) { return enqueue(function () { return finalizeDrain(recordingId, force); }); },
      refreshBadge: function () {
        return enqueue(async function () {
          var session = await store.getActiveSession();
          if (!session || !/^(?:recording|draining|compiling)$/.test(session.state)) return false;
          await setBadge(true, session.state);
          return true;
        });
      },
    });
  }
  return Object.freeze({ API_VERSION: API_VERSION, create: create, SESSION_MARKER_KEY: SESSION_MARKER_KEY });
});
