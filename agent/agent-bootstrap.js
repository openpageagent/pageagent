// One assembly point for Journal -> Runtime -> TurnCoordinator -> Conversation Command Bus.
(function attachAgentBootstrap(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var deps = commonJs ? {
    journal: require('../background/conversation-journal-store'),
    migration: require('../background/conversation-journal-migration'),
    runtime: require('./conversation-runtime'),
    coordinator: require('./turn-coordinator'),
    commandBus: require('../background/conversation-command-bus'),
    materializer: require('../background/conversation-journal-materializer'),
  } : {
    journal: root.ConversationJournalStore,
    migration: root.ConversationJournalMigration,
    runtime: root.ConversationRuntime,
    coordinator: root.TurnCoordinator,
    commandBus: root.ConversationCommandBus,
    materializer: root.ConversationJournalMaterializer,
  };
  var api = factory(root, deps);
  if (commonJs) module.exports = api;
  else root.AgentBootstrap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, deps) {
  'use strict';

  var API_VERSION = 1;
  function required(value, name, method) {
    if (!value || typeof value[method || 'create'] !== 'function') throw new Error(name + ' must load before AgentBootstrap');
    return value;
  }

  function create(options) {
    options = options || {};
    required(deps.journal, 'ConversationJournalStore');
    required(deps.migration, 'ConversationJournalMigration');
    required(deps.runtime, 'ConversationRuntime');
    required(deps.coordinator, 'TurnCoordinator');
    required(deps.commandBus, 'ConversationCommandBus');
    required(deps.materializer, 'ConversationJournalMaterializer');
    if (!options.resourceRuntime || typeof options.resourceRuntime.dispatch !== 'function') {
      throw new TypeError('AgentBootstrap requires the canonical ARP Resource Runtime');
    }
    if (typeof options.resolveService !== 'function' || typeof options.resolveAssistant !== 'function') {
      throw new TypeError('AgentBootstrap requires resolveService and resolveAssistant');
    }
    var journal = options.journal || deps.journal.create({
      indexedDB: options.indexedDB || root.indexedDB,
      IDBKeyRange: options.IDBKeyRange || root.IDBKeyRange,
      crypto: options.crypto || root.crypto,
      clock: options.clock,
      idGenerator: options.idGenerator,
    });
    var migration = options.migration || deps.migration.create({
      journal: journal,
      storage: options.storage || root.chrome && root.chrome.storage && root.chrome.storage.local,
      storageKey: options.storageKey || root.ConversationState && root.ConversationState.STORAGE_KEY || 'conversation_state',
      archiveStoragePrefix: options.archiveStoragePrefix
        || root.ConversationState && root.ConversationState.ARCHIVE_STORAGE_PREFIX
        || 'conversation_archived_topic_',
      crypto: options.crypto || root.crypto,
      clock: options.clock,
      idGenerator: options.idGenerator,
      resolveConversationMetadata: options.resolveConversationMetadata,
    });
    // Conversation Journal v3 is the sole runtime source of truth. Backup
    // import/export is explicit and must never trigger a startup migration.
    var migrationReady = Promise.resolve({ skipped: true });
    var materializer = options.journalMaterializer || deps.materializer.create({ journal: journal });
    deps.runtime.installResourceRuntime(options.resourceRuntime);
    var runtime = deps.runtime.create({
      journal: journal,
      resourceRuntime: options.resourceRuntime,
      resolveService: options.resolveService,
      resolveAssistant: options.resolveAssistant,
      resolveScheduleGrant: options.resolveScheduleGrant,
      modelSettings: options.modelSettings || root.ModelSettings,
      fetch: options.fetch || root.fetch && root.fetch.bind(root),
      resolveImageArtifact: options.resolveImageArtifact || options.resourceRuntime.resolveImageArtifact,
      appendSessionEvent: options.appendSessionEvent,
      tokenizer: options.tokenizer,
      clock: options.clock,
      idGenerator: options.idGenerator,
      faultInjector: options.faultInjector,
      journalMaterializer: materializer,
      recordingAttachments: options.recordingAttachments,
    });
    var coordinator = deps.coordinator.create({
      journal: journal,
      executeGeneration: runtime.executeGeneration,
      reconcileGeneration: runtime.reconcileGeneration,
      runtimeInstanceId: options.runtimeInstanceId,
      clock: options.clock,
      idGenerator: options.idGenerator,
      schedule: options.schedule,
      faultInjector: options.faultInjector,
      recordingAttachments: options.recordingAttachments,
      journalMaterializer: materializer,
      endPageGeneration: typeof options.resourceRuntime.endPageGeneration === 'function'
        ? options.resourceRuntime.endPageGeneration.bind(options.resourceRuntime)
        : null,
    });
    var commandBus = deps.commandBus.create({
      coordinator: coordinator,
      journal: journal,
      resolveService: options.resolveServiceSync || options.resolveService,
      resolveSurface: options.resolveSurface,
      ready: Promise.all([Promise.resolve(options.ready), migrationReady]),
      chrome: options.chrome || root.chrome,
      recordingAttachments: options.recordingAttachments,
    });
    return Object.freeze({
      API_VERSION: API_VERSION,
      journal: journal,
      migration: migration,
      migrationReady: migrationReady,
      runtime: runtime,
      coordinator: coordinator,
      commandBus: commandBus,
      journalMaterializer: materializer,
      recover: function () {
        return migrationReady.then(function () { return coordinator.recoverActiveGenerations(); });
      },
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create, bootstrap: create });
});
