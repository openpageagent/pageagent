// MV3 startup recovery orchestration. Durable generation mutations remain owned by TurnCoordinator.
(function attachConversationRecovery(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function create(options) {
    options = options || {};
    var journal = options.journal;
    var coordinator = options.coordinator;
    if (!journal || typeof journal.listActiveConversations !== 'function') {
      throw new TypeError('ConversationRecovery requires ConversationJournalStore');
    }
    if (!coordinator || typeof coordinator.recoverActiveGenerations !== 'function') {
      throw new TypeError('ConversationRecovery requires TurnCoordinator');
    }
    var started = null;

    function recoverActiveGenerations() {
      if (!started) {
        started = Promise.resolve().then(function () {
          return coordinator.recoverActiveGenerations();
        }).catch(function (error) {
          started = null;
          throw error;
        });
      }
      return started;
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      recoverActiveGenerations: recoverActiveGenerations,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
