// Portable Conversation Journal v3 backup codec.
(function attachConversationJournalMigration(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var nodeCrypto = null;
  if (commonJs) {
    try { nodeCrypto = require('node:crypto'); } catch (_) { nodeCrypto = null; }
  }
  var api = factory(root, nodeCrypto);
  if (commonJs) module.exports = api;
  else root.ConversationJournalMigration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, nodeCrypto) {
  'use strict';

  var API_VERSION = 1;

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function isRecord(value) { return !!(value && typeof value === 'object' && !Array.isArray(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function stable(value, seen) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('Conversation backup values cannot contain cycles');
    seen.push(value);
    var output;
    if (Array.isArray(value)) output = value.map(function (item) { return stable(item, seen); });
    else {
      output = {};
      Object.keys(value).sort().forEach(function (key) {
        output[key] = stable(value[key], seen);
      });
    }
    seen.pop();
    return output;
  }
  function stableStringify(value) { return JSON.stringify(stable(value)); }
  function hex(bytes) {
    return Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }
  async function sha256(value, cryptoApi) {
    var serialized = typeof value === 'string' ? value : stableStringify(value);
    if (nodeCrypto && nodeCrypto.createHash) {
      return 'sha256:' + nodeCrypto.createHash('sha256').update(serialized).digest('hex');
    }
    cryptoApi = cryptoApi || root && root.crypto;
    if (!cryptoApi || !cryptoApi.subtle || typeof TextEncoder !== 'function') {
      throw new Error('SHA-256 is required for Conversation Journal backups');
    }
    var digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return 'sha256:' + hex(new Uint8Array(digest));
  }
  function migrationError(code, message, details) {
    var error = new Error(message || code);
    error.name = 'ConversationMigrationError';
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }

  function create(options) {
    options = options || {};
    var journal = options.journal;
    if (!journal || typeof journal.exportConversation !== 'function' || typeof journal.importConversation !== 'function') {
      throw new TypeError('ConversationJournalMigration requires a ConversationJournalStore');
    }
    var cryptoApi = options.crypto || root && root.crypto;
    var resolveConversationMetadata = typeof options.resolveConversationMetadata === 'function'
      ? options.resolveConversationMetadata : async function () { return null; };

    function portableTopicSnapshot(value, conversationId) {
      value = isRecord(value) ? value : {};
      var output = { conversationId: conversationId, topicId: conversationId };
      [
        'assistantId', 'name', 'objective', 'assistantSnapshot', 'modelServiceId',
        'budgets', 'contextMeta', 'activeTabId', 'activeWindowId', 'targetUrl', 'targetTitle',
        'archived', 'createdAt', 'updatedAt',
      ].forEach(function (key) {
        if (hasOwn(value, key)) output[key] = clone(value[key]);
      });
      return output;
    }

    function exportedJournalEvent(event, includeReasoning) {
      var output = clone(event || {});
      if (includeReasoning !== false || output.type !== 'model_response_completed' || !isRecord(output.payload)) {
        return output;
      }
      // providerReplay may contain the same reasoning bytes required for
      // Provider protocol continuity. A no-reasoning Journal export must not
      // retain that second representation after removing reasoning_completed.
      output.payload.providerReplay = null;
      return output;
    }

    async function exportBackup(conversationId, exportOptions) {
      exportOptions = exportOptions || {};
      var data = await journal.exportConversation(conversationId, exportOptions);
      var topicMetadata = await resolveConversationMetadata(conversationId);
      var journalMetadata = clone(data.conversation || {});
      var portableConversation = {
        schemaVersion: 3,
        conversationId: conversationId,
        assistantId: text(journalMetadata.assistantId || topicMetadata && topicMetadata.assistantId),
        topicSnapshot: portableTopicSnapshot(topicMetadata, conversationId),
        journalMetadata: journalMetadata,
      };
      var exportedJournal = (data.journal || []).map(function (event) {
        return exportedJournalEvent(event, exportOptions.includeReasoning !== false);
      });
      var files = {
        'conversation.json': JSON.stringify(portableConversation, null, 2),
        'journal.jsonl': exportedJournal.map(function (event) { return JSON.stringify(event); }).join('\n') + (exportedJournal.length ? '\n' : ''),
        'checkpoints.json': JSON.stringify(data.checkpoints, null, 2),
        'artifacts/payloads.json': JSON.stringify(data.payloads || [], null, 2),
      };
      var hashes = {};
      for (var path of Object.keys(files)) hashes[path] = await sha256(files[path], cryptoApi);
      var manifest = Object.assign({}, data.manifest, {
        files: hashes,
        formatVersion: 3,
        conversationSchemaVersion: 3,
      });
      files['manifest.json'] = JSON.stringify(manifest, null, 2);
      return { manifest: manifest, files: files };
    }

    async function importBackup(backup, importOptions) {
      var files = backup && backup.files || backup;
      if (!isRecord(files)) throw migrationError('INVALID_BACKUP', 'Backup files are missing');
      var manifest;
      try { manifest = JSON.parse(text(files['manifest.json'])); }
      catch (_) { throw migrationError('INVALID_BACKUP', 'Backup manifest is invalid'); }
      if (!manifest || manifest.format !== 'page-agent-conversation-journal'
          || Number(manifest.formatVersion) !== 3) {
        throw migrationError('INVALID_BACKUP', 'Unsupported conversation backup manifest');
      }
      if (!isRecord(manifest.files)) throw migrationError('INVALID_BACKUP', 'Conversation backup manifest has no file hashes');
      ['conversation.json', 'journal.jsonl', 'checkpoints.json', 'artifacts/payloads.json'].forEach(function (path) {
        if (!hasOwn(files, path) || !hasOwn(manifest.files, path)) {
          throw migrationError('INVALID_BACKUP', 'Conversation backup is missing required file: ' + path);
        }
      });
      for (var path of Object.keys(manifest.files || {})) {
        if (!hasOwn(files, path)) throw migrationError('INVALID_BACKUP', 'Backup file is missing: ' + path);
        var actual = await sha256(String(files[path]), cryptoApi);
        if (actual !== manifest.files[path]) throw migrationError('BACKUP_HASH_MISMATCH', 'Backup file hash mismatch: ' + path);
      }
      var journalEvents = text(files['journal.jsonl']).split(/\r?\n/).filter(Boolean).map(function (line, index) {
        try { return JSON.parse(line); }
        catch (_) { throw migrationError('INVALID_BACKUP', 'Invalid journal.jsonl line ' + (index + 1)); }
      });
      var conversationEnvelope;
      try { conversationEnvelope = JSON.parse(text(files['conversation.json'])); }
      catch (_) { throw migrationError('INVALID_BACKUP', 'conversation.json is invalid'); }
      if (!isRecord(conversationEnvelope)) {
        throw migrationError('INVALID_BACKUP', 'conversation.json must contain an object');
      }
      if (Number(manifest.conversationSchemaVersion) !== 3
          || Number(conversationEnvelope.schemaVersion) !== 3) {
        throw migrationError('INVALID_BACKUP', 'Conversation backup v3 has an invalid schema declaration');
      }
      if (!isRecord(conversationEnvelope.topicSnapshot) || !isRecord(conversationEnvelope.journalMetadata)) {
        throw migrationError('INVALID_BACKUP', 'Conversation backup v3 requires topicSnapshot and journalMetadata');
      }
      var topicSnapshot = clone(conversationEnvelope.topicSnapshot);
      var conversation = clone(conversationEnvelope.journalMetadata);
      var envelopeConversationId = text(conversationEnvelope.conversationId);
      var journalConversationId = text(conversation.conversationId);
      var topicConversationId = text(topicSnapshot.conversationId || topicSnapshot.topicId);
      if (!envelopeConversationId || journalConversationId !== envelopeConversationId
          || topicConversationId !== envelopeConversationId) {
        throw migrationError('INVALID_BACKUP', 'Conversation backup contains inconsistent conversationId values');
      }
      if (text(manifest.conversationId) !== envelopeConversationId) {
        throw migrationError('INVALID_BACKUP', 'Conversation backup manifest and envelope conversationId differ');
      }
      var assistantIdOverride = text(importOptions && importOptions.assistantId);
      if (assistantIdOverride) {
        conversation.assistantId = assistantIdOverride;
        topicSnapshot.assistantId = assistantIdOverride;
        journalEvents = journalEvents.map(function (event) {
          if (event.type !== 'generation_started') return event;
          event = clone(event);
          event.payload = Object.assign({}, event.payload || {}, { assistantId: assistantIdOverride });
          return event;
        });
      }
      return journal.importConversation({
        manifest: manifest,
        conversation: conversation,
        journal: journalEvents,
        checkpoints: JSON.parse(text(files['checkpoints.json']) || '[]'),
        payloads: JSON.parse(text(files['artifacts/payloads.json']) || '[]'),
      }, importOptions || {}).then(function (result) {
        return Object.assign({}, result, { topicSnapshot: topicSnapshot });
      });
    }

    return Object.freeze({
      API_VERSION: API_VERSION,
      exportBackup: exportBackup,
      importBackup: importBackup,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    create: create,
  });
});
