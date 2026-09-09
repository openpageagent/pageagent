(function attachOptionsBackupController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && typeof value.create === 'function');
  }

  var existing = root && root.OptionsBackupController;
  if (isApi(existing)) {
    if (typeof module === 'object' && module.exports) module.exports = existing;
    return;
  }

  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OptionsBackupController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsBackupController missing dependency: ' + name);
    return value;
  }

  function create(deps) {
    deps = deps || {};
    var globalThis = root;
    var chrome = deps.chrome || root.chrome;
    var document = deps.document || root.document;
    var window = deps.window || root;
    var FileReader = deps.FileReader || root.FileReader;
    var TextEncoder = deps.TextEncoder || root.TextEncoder;
    var BlobCtor = deps.Blob || root.Blob;
    var URLApi = deps.URL || root.URL;
    var download = deps.download;
    var resourceClientApi = deps.resourceClientApi || root.PageAutomationResourceClient;
    var lifecycleApi = deps.lifecycleApi || root.PageAutomationLifecycle;
    if (!lifecycleApi || typeof lifecycleApi.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsBackupController');
    }
    if (!resourceClientApi || typeof resourceClientApi.create !== 'function') {
      throw new Error('PageAutomationResourceClient must load before OptionsBackupController');
    }
    if (!chrome || !chrome.runtime) {
      throw new Error('OptionsBackupController requires chrome.runtime');
    }

    var resourceClient = deps.resourceClient || resourceClientApi.create(chrome.runtime);
    var $ = requireFunction(deps.$, '$');
    var $all = requireFunction(deps.$all, '$all');
    var esc = requireFunction(deps.esc, 'esc');
    var cssEscape = requireFunction(deps.cssEscape, 'cssEscape');
    var hasOwn = requireFunction(deps.hasOwn, 'hasOwn');
    var isBuiltinItem = requireFunction(deps.isBuiltinItem, 'isBuiltinItem');
    var isBuiltinConfigImport = requireFunction(deps.isBuiltinConfigImport, 'isBuiltinConfigImport');
    var fmtTime = requireFunction(deps.fmtTime, 'fmtTime');
    var formatStorageMegabytes = requireFunction(deps.formatStorageMegabytes, 'formatStorageMegabytes');
    var scheduleTaskKind = requireFunction(deps.scheduleTaskKind, 'scheduleTaskKind');
    var toast = requireFunction(deps.toast, 'toast');
    var confirm = requireFunction(deps.confirm, 'confirm');
    var openDrawer = requireFunction(deps.openDrawer, 'openDrawer');
    var closeDrawer = requireFunction(deps.closeDrawer, 'closeDrawer');
    var loadConfig = requireFunction(deps.loadConfig, 'loadConfig');
    var renderCurrentSection = requireFunction(deps.renderCurrentSection, 'renderCurrentSection');
    var renderMCP = requireFunction(deps.renderMCP, 'renderMCP');
    var readConfigSnapshot = requireFunction(deps.readConfigSnapshot, 'readConfigSnapshot');
    var mutateConfigResource = requireFunction(deps.mutateConfigResource, 'mutateConfigResource');
    var setFlowDirty = requireFunction(deps.setFlowDirty, 'setFlowDirty');
    var getCurrentSection = requireFunction(deps.getCurrentSection, 'getCurrentSection');
    var lifecycle = lifecycleApi.create(window);
    var initialized = false;
    var destroyed = false;
    var pendingBackupExport = null;
    var pendingBackupImport = null;
    var importInFlight = null;
    var importUiInFlight = null;
    var lastImportResult = null;
    var backupIncludeReasoning = true;
    var activeFileReads = [];
    var maxBackupBytes = Number(deps.maxBackupBytes);
    if (!Number.isFinite(maxBackupBytes) || maxBackupBytes <= 0) maxBackupBytes = 50 * 1024 * 1024;

    function dictionary() {
      return Object.create(null);
    }

    function setOwn(target, key, value) {
      Object.defineProperty(target, String(key), {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return value;
    }

    function safeClone(value, ancestors) {
      if (value === null || value === undefined) return value;
      var kind = typeof value;
      if (kind === 'string' || kind === 'boolean') return value;
      if (kind === 'number') return Number.isFinite(value) ? value : null;
      if (kind !== 'object') throw new Error('备份包含不支持的数据类型');
      ancestors = ancestors || [];
      if (ancestors.indexOf(value) !== -1) throw new Error('备份包含循环引用，无法处理');
      var nextAncestors = ancestors.concat([value]);
      if (Array.isArray(value)) {
        return value.map(function (item) {
          return item === undefined ? null : safeClone(item, nextAncestors);
        });
      }
      var out = dictionary();
      Object.keys(value).forEach(function (key) {
        var item = value[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return;
        setOwn(out, key, safeClone(item, nextAncestors));
      });
      return out;
    }

    function plainClone(value) {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    }

    function sanitizeRuntimeValue(value) {
      if (Array.isArray(value)) return value.map(sanitizeRuntimeValue);
      if (!value || typeof value !== 'object') return value;
      var out = dictionary();
      Object.keys(value).forEach(function (key) {
        if (key.indexOf('__builtin') === 0 || key === 'mcpValidation') return;
        setOwn(out, key, sanitizeRuntimeValue(value[key]));
      });
      return out;
    }

    var LEGACY_CDP_CLICK_TYPE = ['cdp', 'input', 'click'].join('.');

    function migrateLegacyPageNodes(item) {
      if (!item || !Array.isArray(item.nodes)) return item;
      item.nodes.forEach(function (node) {
        if (!node || node.type !== LEGACY_CDP_CLICK_TYPE) return;
        node.type = 'clickElement';
        if (node.params === undefined || node.params === null) {
          node.params = {};
        } else if (typeof node.params === 'object' && !Array.isArray(node.params)) {
          node.params = Object.assign({}, node.params);
          delete node.params.moveSteps;
        }
      });
      return item;
    }

    function backupByteSize(value) {
      var text = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value);
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
      try { return unescape(encodeURIComponent(text)).length; } catch (_) { return text.length * 2; }
    }

    function backupError(code, message) {
      var error = new Error(message);
      error.code = code;
      return error;
    }

    function assertBackupSize(value, label) {
      var bytes;
      try {
        bytes = backupByteSize(value);
      } catch (err) {
        throw backupError('invalid-backup-data', '备份数据无法序列化: ' + (err && err.message ? err.message : String(err)));
      }
      if (bytes > maxBackupBytes) {
        throw backupError('backup-too-large', (label || '备份数据') + '过大 (' + bytes + ' bytes)，最大允许 ' + maxBackupBytes + ' bytes');
      }
      return bytes;
    }

    function errorText(error) {
      return String(error && error.message ? error.message : (error || '未知错误'));
    }

    function resourceEnvelopeData(envelope, label) {
      var data = envelope && envelope.primary && envelope.primary.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error((label || '资源') + '返回了无效数据');
      }
      return safeClone(data);
    }

    function readLocalStorageValue(key) {
      var storage = chrome && chrome.storage && chrome.storage.local;
      if (!storage || typeof storage.get !== 'function') return Promise.resolve(undefined);
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, result) {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(result && result[key]);
        }
        function callback(result) {
          var lastError = chrome.runtime && chrome.runtime.lastError;
          finish(lastError ? new Error(lastError.message || String(lastError)) : null, result || {});
        }
        try {
          var returned = storage.get(key, callback);
          if (returned && typeof returned.then === 'function') {
            returned.then(function (result) { finish(null, result || {}); }, function (error) { finish(error); });
          }
        } catch (error) {
          finish(error);
        }
      });
    }

    function runtimeMessage(type, payload) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(response) {
          if (settled) return;
          settled = true;
          var lastError = chrome && chrome.runtime && chrome.runtime.lastError;
          if (lastError) { reject(new Error(lastError.message)); return; }
          if (!response || response.ok !== true) {
            var error = new Error(response && response.error || '后台消息失败: ' + type);
            error.code = response && response.code || 'RUNTIME_MESSAGE_FAILED';
            reject(error);
            return;
          }
          resolve(response.payload);
        }
        try {
          var returned = chrome.runtime.sendMessage({ type: type, payload: safeClone(payload || {}) }, finish);
          if (returned && typeof returned.then === 'function') returned.then(finish, reject);
        } catch (error) { reject(error); }
      });
    }

    function resourceSegment(value) {
      return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
        return '%' + character.charCodeAt(0).toString(16).toUpperCase();
      });
    }

    var backupResourceSequence = 0;
    function backupResourceIdempotencyKey(prefix) {
      backupResourceSequence += 1;
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return (prefix || 'backup') + '_' + root.crypto.randomUUID();
      }
      return (prefix || 'backup') + '_' + Date.now().toString(36) + '_' + backupResourceSequence.toString(36)
        + '_' + Math.random().toString(36).slice(2, 10);
    }

    function backupResourceMutationOptions(extra) {
      return Object.assign({
        idempotencyKey: backupResourceIdempotencyKey('knowledge_backup'),
      }, extra || {});
    }

    function uniqueBackupIds(ids) {
      var seen = dictionary();
      return (ids || []).map(function (id) { return String(id || ''); }).filter(function (id) {
        if (!id || hasOwn(seen, id)) return false;
        setOwn(seen, id, true);
        return true;
      });
    }

    function downloadFile(filename, content, mime) {
      var descriptor = {
        filename: String(filename || 'backup.json'),
        content: content,
        mime: mime || 'application/octet-stream',
      };
      if (destroyed) return { ok: false, destroyed: true, descriptor: descriptor };
      if (typeof download === 'function') {
        download(descriptor);
        return { ok: true, descriptor: descriptor };
      }
      if (typeof BlobCtor !== 'function' || !URLApi || typeof URLApi.createObjectURL !== 'function') {
        throw new Error('当前环境不支持文件下载');
      }
      var blob = new BlobCtor([content], { type: descriptor.mime });
      var url = URLApi.createObjectURL(blob);
      var releaseUrl = lifecycle.add(function () {
        if (URLApi && typeof URLApi.revokeObjectURL === 'function') URLApi.revokeObjectURL(url);
      });
      try {
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = descriptor.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        releaseUrl();
        throw error;
      }
      var timer = window.setTimeout(releaseUrl, 1000);
      lifecycle.add(function () { window.clearTimeout(timer); });
      return { ok: true, descriptor: descriptor, url: url };
    }

    var FULL_BACKUP_KIND = 'pfa-full-backup';
    var FULL_BACKUP_VERSION = 6;
    var CONFIG_BACKUP_SECTIONS = [
      { id: 'flowGroups', label: '流程组', configSection: 'flowGroups' },
      { id: 'flows', label: '流程', configSection: 'flows' },
      { id: 'pages', label: '页面', configSection: 'pages' },
      { id: 'scripts', label: '脚本', configSection: 'scripts' },
      { id: 'schedules', label: '定时运行', configSection: 'schedules' },
      { id: 'urlTriggers', label: 'URL 触发运行', configSection: 'urlTriggers' },
    ];
    var BACKUP_MODULE_DEFS = [
      { id: 'conversations', label: '对话', note: 'JSON 备份保存图片引用；含媒体的完整迁移请在对话页使用 ZIP 导出' },
      { id: 'assistants', label: '助手' },
      { id: 'knowledge', label: '知识' },
      { id: 'skills', label: 'Skill' },
      { id: 'mcpServers', label: 'HTTP MCP 服务器', note: '包含 Bearer Token 与自定义 Header 原值' },
      { id: 'modelSettings', label: '模型配置', note: 'API Key、Header 值等密钥不会导出' },
      { id: 'mcpSettings', label: 'MCP 服务器' },
    ].concat(CONFIG_BACKUP_SECTIONS);
    var BACKUP_MODULE_IDS = dictionary();
    BACKUP_MODULE_DEFS.forEach(function (def) { setOwn(BACKUP_MODULE_IDS, def.id, true); });

    function backupModuleDef(moduleId) {
      return BACKUP_MODULE_DEFS.filter(function (def) { return def.id === moduleId; })[0] || { id: moduleId, label: moduleId };
    }

    function backupModuleLabel(moduleId) {
      return backupModuleDef(moduleId).label || moduleId;
    }

    function backupFilenameTimestamp(date) {
      date = date || new Date();
      function pad(value) { return String(value).padStart(2, '0'); }
      return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
      ].join('-') + '-' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
      ].join('-');
    }

    function flowNodePageIds(node) {
      var ids = [];
      if (!node || typeof node !== 'object') return ids;
      if (node.pageId) ids.push(node.pageId);
      var params = node.params && typeof node.params === 'object' ? node.params : {};
      ['pageId', 'targetPageId'].forEach(function (key) {
        if (params[key]) ids.push(params[key]);
      });
      return uniqueBackupIds(ids);
    }

    function flowNodeScriptIds(node) {
      var ids = [];
      if (!node || typeof node !== 'object') return ids;
      if (node.scriptId) ids.push(node.scriptId);
      var params = node.params && typeof node.params === 'object' ? node.params : {};
      if (params.scriptId) ids.push(params.scriptId);
      return uniqueBackupIds(ids);
    }

    function flowNodeFlowIds(node) {
      var ids = [];
      if (!node || typeof node !== 'object') return ids;
      if (node.flowId) ids.push(node.flowId);
      var params = node.params && typeof node.params === 'object' ? node.params : {};
      ['flowId', 'targetFlowId'].forEach(function (key) {
        if (params[key]) ids.push(params[key]);
      });
      return uniqueBackupIds(ids);
    }

    function flowNodeAssistantIds(node) {
      if (!node || typeof node !== 'object' || node.type !== 'runAssistant') return [];
      var params = node.params && typeof node.params === 'object' ? node.params : {};
      return params.assistantId ? [String(params.assistantId)] : [];
    }

    function addConfigDependencyItemForBackup(out, raw, section, id) {
      id = String(id || '');
      if (!id || !raw || !raw[section] || !hasOwn(raw[section], id)) return false;
      if (isBuiltinItem(raw[section][id])) return false;
      if (!out[section] || typeof out[section] !== 'object') setOwn(out, section, dictionary());
      if (!hasOwn(out[section], id)) setOwn(out[section], id, sanitizeRuntimeValue(raw[section][id]));
      return true;
    }

    function addConfigDependencyClosureForBackup(out, raw) {
      raw = raw || {};
      var flowQueue = [];
      var queuedFlows = dictionary();
      var seenFlows = dictionary();

      function queueFlow(flowId) {
        flowId = String(flowId || '');
        if (!flowId || hasOwn(queuedFlows, flowId)) return;
        setOwn(queuedFlows, flowId, true);
        flowQueue.push(flowId);
      }

      Object.keys(out.flows || {}).forEach(queueFlow);
      Object.keys(out.flowGroups || {}).forEach(function (groupId) {
        var group = raw.flowGroups && hasOwn(raw.flowGroups, groupId) ? raw.flowGroups[groupId]
          : (out.flowGroups && hasOwn(out.flowGroups, groupId) ? out.flowGroups[groupId] : null);
        (group && group.steps || []).forEach(function (step) {
          var flowId = step && step.flowId;
          if (!flowId) return;
          addConfigDependencyItemForBackup(out, raw, 'flows', flowId);
          queueFlow(flowId);
        });
      });

      while (flowQueue.length) {
        var flowId = flowQueue.shift();
        if (hasOwn(seenFlows, flowId)) continue;
        setOwn(seenFlows, flowId, true);
        var flow = out.flows && hasOwn(out.flows, flowId) ? out.flows[flowId]
          : (raw.flows && hasOwn(raw.flows, flowId) ? raw.flows[flowId] : null);
        if (!flow) continue;
        (flow.nodes || []).forEach(function (node) {
          flowNodePageIds(node).forEach(function (pageId) {
            addConfigDependencyItemForBackup(out, raw, 'pages', pageId);
          });
          flowNodeScriptIds(node).forEach(function (scriptId) {
            addConfigDependencyItemForBackup(out, raw, 'scripts', scriptId);
          });
          flowNodeFlowIds(node).forEach(function (childFlowId) {
            if (addConfigDependencyItemForBackup(out, raw, 'flows', childFlowId)) queueFlow(childFlowId);
          });
        });
      }
      return out;
    }

    function storageConfigForExport(sourceConfig) {
      return safeClone(sourceConfig || {});
    }

    function objectFromArrayById(items, fallbackPrefix) {
      var map = dictionary();
      var order = [];
      (Array.isArray(items) ? items : []).forEach(function (item, index) {
        if (!item || typeof item !== 'object') return;
        var id = String(item.id || item.runId || item.topicId || item.checkpointId || '').trim();
        if (!id) id = (fallbackPrefix || 'item') + '_' + index;
        var copy = safeClone(item);
        if (!copy.id && fallbackPrefix === 'ut') copy.id = id;
        setOwn(map, id, copy);
        order.push(id);
      });
      return { items: map, order: order };
    }

    function orderedKeysForObject(map, preferredOrder) {
      map = map && typeof map === 'object' ? map : dictionary();
      var seen = dictionary();
      var keys = [];
      (preferredOrder || []).forEach(function (id) {
        id = String(id || '');
        if (id && hasOwn(map, id) && !hasOwn(seen, id)) {
          setOwn(seen, id, true);
          keys.push(id);
        }
      });
      Object.keys(map).forEach(function (id) {
        if (!hasOwn(seen, id)) keys.push(id);
      });
      return keys;
    }

    function serviceIsExportable(service) {
      if (!service) return false;
      return true;
    }

    function modelServiceForBackup(service) {
      service = service && typeof service === 'object' && !Array.isArray(service) ? service : {};
      var output = safeClone(service);
      if (!hasOwn(output, 'protocol') && hasOwn(output, 'apiStyle')) output.protocol = output.apiStyle;
      ['apiKey', 'headers', 'secret', 'apiStyle', 'providerType', 'provider_type', 'reasoningProviderType'].forEach(function (key) { delete output[key]; });
      return output;
    }

    function agentSettingsForBackup(settings) {
      settings = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
      return safeClone(settings);
    }

    function assistantForBackup(assistant, includeId) {
      assistant = assistant && typeof assistant === 'object' && !Array.isArray(assistant) ? assistant : {};
      var output = safeClone(assistant);
      if (includeId === false) delete output.id;
      return output;
    }

    function normalizeModelSettingsForBackup(raw) {
      raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      var services = Array.isArray(raw.services) ? raw.services : [];
      var normalized = {
        version: 1,
        services: services.map(modelServiceForBackup).filter(function (service) { return !!String(service.id || ''); }),
        agentSettings: agentSettingsForBackup(raw.agentSettings),
      };
      return safeClone(normalized);
    }

    function knowledgeItemIsExportable(item) {
      if (!item || typeof item !== 'object') return false;
      var source = item.source || {};
      return !(item.protected || item.builtIn || item.builtinSkill
        || item.sourceKind === 'builtin' || source.kind === 'builtin' || source.managed === 'builtin'
        || source.importer === 'builtin-skill-loader' || /^skill-builtin:/.test(String(source.key || '')));
    }

    function readKnowledgeSummariesForBackup() {
      var items = [];
      var seenCursors = dictionary();
      function read(cursor) {
        var query = { limit: 100, includeArchived: true, includeStale: true };
        if (cursor) query.cursor = String(cursor);
        return resourceClient.get('/knowledge', { query: query }).then(function (envelope) {
          var data = resourceEnvelopeData(envelope, '知识列表');
          if (Array.isArray(data.items)) {
            items = items.concat(data.items.filter(knowledgeItemIsExportable).map(function (item) { return safeClone(item); }));
          }
          var nextCursor = data.nextCursor === undefined || data.nextCursor === null ? '' : String(data.nextCursor);
          if (!nextCursor || hasOwn(seenCursors, nextCursor)) return items;
          setOwn(seenCursors, nextCursor, true);
          return read(nextCursor);
        });
      }
      return read('');
    }

    function readKnowledgeBackupModule() {
      return Promise.all([
        resourceClient.get('/knowledge-settings'),
        readKnowledgeSummariesForBackup(),
      ]).then(function (results) {
        var settings = resourceEnvelopeData(results[0], '知识设置');
        var summaries = results[1];
        var items = dictionary();
        var order = [];
        var updatedAt = 0;
        return summaries.reduce(function (chain, summary) {
          return chain.then(function () {
            var id = String(summary && summary.id || '').trim();
            if (!id) throw new Error('知识列表包含缺少 ID 的条目');
            return resourceClient.get('/knowledge/' + resourceSegment(id)).then(function (envelope) {
              var item = resourceEnvelopeData(envelope, '知识 ' + id);
              if (!knowledgeItemIsExportable(item)) return;
              setOwn(items, id, item);
              order.push(id);
              updatedAt = Math.max(updatedAt, Number(item.updatedAt) || 0);
            });
          });
        }, Promise.resolve()).then(function () {
          return {
            label: backupModuleLabel('knowledge'),
            source: '/knowledge',
            settings: settings,
            items: items,
            order: order,
            stateMeta: { updatedAt: updatedAt },
          };
        });
      });
    }

    function readModelServicesForBackup() {
      var items = [];
      var seenCursors = dictionary();
      function read(cursor) {
        var query = { limit: 100 };
        if (cursor) query.cursor = String(cursor);
        return resourceClient.get('/model-services', { query: query }).then(function (envelope) {
          var data = resourceEnvelopeData(envelope, '模型服务列表');
          if (Array.isArray(data.items)) {
            items = items.concat(data.items.map(modelServiceForBackup));
          }
          var nextCursor = String(data.nextCursor || '');
          if (!nextCursor || hasOwn(seenCursors, nextCursor)) return items;
          setOwn(seenCursors, nextCursor, true);
          return read(nextCursor);
        });
      }
      return read('');
    }

    function readAgentSettingsForBackup() {
      return resourceClient.get('/agent-settings').then(function (envelope) {
        return agentSettingsForBackup(resourceEnvelopeData(envelope, 'Agent Settings'));
      });
    }

    function readResourceCollection(uri, query) {
      var items = [];
      var seenCursors = dictionary();
      function read(cursor) {
        var nextQuery = Object.assign({ limit: 100 }, query || {});
        if (cursor) nextQuery.cursor = String(cursor);
        return resourceClient.get(uri, { query: nextQuery }).then(function (envelope) {
          var data = resourceEnvelopeData(envelope, uri);
          if (Array.isArray(data.items)) items = items.concat(data.items.map(function (item) { return safeClone(item); }));
          var nextCursor = String(data.nextCursor || '');
          if (!nextCursor || hasOwn(seenCursors, nextCursor)) return items;
          setOwn(seenCursors, nextCursor, true);
          return read(nextCursor);
        });
      }
      return read('');
    }

    function conversationForBackup(conversation, fallbackId) {
      conversation = conversation && typeof conversation === 'object' && !Array.isArray(conversation) ? conversation : {};
      function omitInlineImages(value) {
        if (typeof value === 'string') {
          return value.replace(/data:image\/[^,;\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/_=-]+/gi, '[embedded image omitted; export the topic ZIP to include media]');
        }
        if (Array.isArray(value)) return value.map(omitInlineImages);
        if (!value || typeof value !== 'object') return value;
        Object.keys(value).forEach(function (key) { value[key] = omitInlineImages(value[key]); });
        return value;
      }
      var output = omitInlineImages(safeClone(conversation));
      if (!String(output.topicId || '').trim()) setOwn(output, 'topicId', String(conversation.id || fallbackId || ''));
      return output;
    }

    function connectionForBackup(connection) {
      connection = connection && typeof connection === 'object' && !Array.isArray(connection) ? connection : {};
      return safeClone(connection);
    }

    function skillForBackup(skill) {
      skill = skill && typeof skill === 'object' && !Array.isArray(skill) ? skill : {};
      return safeClone(skill);
    }

    function skillIsExportable(skill) {
      var source = skill && skill.source && typeof skill.source === 'object' ? skill.source : {};
      return !!(skill && skill.builtinSkill !== true && skill.builtIn !== true && skill.protected !== true
        && source.kind !== 'builtin' && source.managed !== 'builtin'
        && source.importer !== 'builtin-skill-loader' && !/^skill-builtin:/.test(String(source.key || '')));
    }

    function backupItemIsExportable(moduleId, item) {
      if (moduleId === 'knowledge') return knowledgeItemIsExportable(item);
      if (moduleId === 'skills') return skillIsExportable(item);
      return true;
    }

    function filterBuiltinBackupItems(moduleId, module) {
      var output = safeClone(module || {});
      if (moduleId !== 'knowledge' && moduleId !== 'skills') return output;
      var items = backupModuleItemsObject(output);
      var filteredItems = dictionary();
      var filteredOrder = [];
      orderedKeysForObject(items, output.order || []).forEach(function (id) {
        if (!backupItemIsExportable(moduleId, items[id])) return;
        setOwn(filteredItems, id, items[id]);
        filteredOrder.push(id);
      });
      output.items = filteredItems;
      output.order = filteredOrder;
      return output;
    }

    function mcpServerForBackup(server) {
      server = server && typeof server === 'object' && !Array.isArray(server) ? server : {};
      return safeClone(server);
    }

    function readAssistantsForBackup() {
      return readResourceCollection('/assistants').then(function (items) {
        return items.map(function (item) { return assistantForBackup(item, true); });
      });
    }

    function readConversationsForBackup() {
      return readResourceCollection('/conversations', { includeArchived: true }).then(function (summaries) {
        return summaries.reduce(function (chain, summary) {
          return chain.then(function (items) {
            var id = String(summary && (summary.topicId || summary.id) || '').trim();
            if (!id) throw new Error('对话列表包含缺少 ID 的条目');
            return Promise.all([
              resourceClient.get('/conversations/' + resourceSegment(id)),
              runtimeMessage('EXPORT_CONVERSATION_BACKUP', {
                conversationId: id,
                includeReasoning: backupIncludeReasoning,
                includePayloads: true,
              }),
            ]).then(function (results) {
              var item = conversationForBackup(resourceEnvelopeData(results[0], '对话 ' + id), id);
              item.journalBackup = safeClone(results[1]);
              items.push(item);
              return items;
            });
          });
        }, Promise.resolve([]));
      });
    }

    function readMcpConnectionsForBackup() {
      return readResourceCollection('/connections').then(function (items) {
        return items.filter(function (item) { return item && item.kind === 'mcp-websocket'; }).map(connectionForBackup);
      });
    }

    function readSkillsForBackup() {
      return readResourceCollection('/skills', { includeArchived: true, includeDisabled: true }).then(function (summaries) {
        return summaries.filter(skillIsExportable).reduce(function (chain, summary) {
          return chain.then(function (items) {
            var id = String(summary && summary.id || '').trim();
            if (!id) throw new Error('Skill 列表包含缺少 ID 的条目');
            return resourceClient.get('/skills/' + resourceSegment(id)).then(function (envelope) {
              var skill = resourceEnvelopeData(envelope, 'Skill ' + id);
              if (skillIsExportable(skill)) items.push(skillForBackup(skill));
              return items;
            });
          });
        }, Promise.resolve([]));
      });
    }

    function readMcpServersForBackup() {
      var storageKey = chrome.extension && chrome.extension.inIncognitoContext
        ? 'mcp_http_servers_incognito' : 'mcp_http_servers';
      return readLocalStorageValue(storageKey).then(function (stored) {
        if (stored && stored.servers && typeof stored.servers === 'object' && !Array.isArray(stored.servers)) {
          return orderedKeysForObject(stored.servers, stored.order || []).map(function (id) {
            return mcpServerForBackup(stored.servers[id]);
          }).filter(function (item) { return !!String(item.id || ''); });
        }
        return readResourceCollection('/mcp-servers', { includeDisabled: true }).then(function (items) {
          return items.map(mcpServerForBackup).filter(function (item) { return !!String(item.id || ''); });
        });
      });
    }

    function buildBackupModules(source) {
      source = source || {};
      var modules = dictionary();
      var sourceConfig = storageConfigForExport(source.config || {});

      CONFIG_BACKUP_SECTIONS.forEach(function (def) {
        var section = def.configSection;
        if (section === 'urlTriggers') {
          var triggers = objectFromArrayById(sourceConfig.urlTriggers || [], 'ut');
          modules[def.id] = { label: def.label, source: 'automation_config.' + section, items: triggers.items, order: triggers.order };
          return;
        }
        modules[def.id] = {
          label: def.label,
          source: 'automation_config.' + section,
          items: safeClone(sourceConfig[section] || {}),
          order: Object.keys(sourceConfig[section] || {}),
        };
      });

      if (Array.isArray(source.modelServices) || source.agentSettings) {
        modules.modelSettings = {
          label: backupModuleLabel('modelSettings'),
          source: '/model-services + /agent-settings',
          value: normalizeModelSettingsForBackup({
            services: source.modelServices || [],
            agentSettings: source.agentSettings || {},
          }),
        };
      }

      if (Array.isArray(source.assistants)) {
        var assistants = dictionary();
        var assistantOrder = [];
        source.assistants.forEach(function (item) {
          var id = String(item && item.id || '').trim();
          if (!id) return;
          setOwn(assistants, id, assistantForBackup(item, true));
          assistantOrder.push(id);
        });
        modules.assistants = {
          label: backupModuleLabel('assistants'), source: '/assistants', items: assistants, order: assistantOrder,
          stateMeta: { defaultAssistantId: String(source.agentSettings && source.agentSettings.defaultAssistantId || '') },
        };
      }

      if (Array.isArray(source.conversations)) {
        var topics = dictionary();
        var topicOrder = [];
        source.conversations.forEach(function (item) {
          var id = String(item && (item.topicId || item.id) || '').trim();
          if (!id) return;
          setOwn(topics, id, conversationForBackup(item, id));
          topicOrder.push(id);
        });
        modules.conversations = {
          label: backupModuleLabel('conversations'), source: '/conversations', items: topics, order: topicOrder,
        };
      }

      if (source.knowledge && typeof source.knowledge === 'object') {
        modules.knowledge = filterBuiltinBackupItems('knowledge', source.knowledge);
      }

      if (Array.isArray(source.skills)) {
        var skills = dictionary();
        var skillOrder = [];
        source.skills.forEach(function (item) {
          if (!skillIsExportable(item)) return;
          var id = String(item && item.id || '').trim();
          if (!id) return;
          setOwn(skills, id, skillForBackup(item));
          skillOrder.push(id);
        });
        modules.skills = { label: backupModuleLabel('skills'), source: '/skills', items: skills, order: skillOrder };
      }

      if (Array.isArray(source.mcpServers)) {
        var mcpServers = dictionary();
        var mcpServerOrder = [];
        source.mcpServers.forEach(function (server) {
          var item = mcpServerForBackup(server);
          var id = String(item.id || '').trim();
          if (!id) return;
          setOwn(mcpServers, id, item);
          mcpServerOrder.push(id);
        });
        modules.mcpServers = {
          label: backupModuleLabel('mcpServers'), source: '/mcp-servers', items: mcpServers, order: mcpServerOrder,
        };
      }

      if (Array.isArray(source.mcpConnections) && source.mcpConnections.length) {
        var mcpItems = dictionary();
        var mcpOrder = [];
        source.mcpConnections.forEach(function (connection) {
          var id = String(connection && connection.id || '').trim();
          if (!id) return;
          setOwn(mcpItems, id, connectionForBackup(connection));
          mcpOrder.push(id);
        });
        modules.mcpSettings = { label: backupModuleLabel('mcpSettings'), source: '/connections', items: mcpItems, order: mcpOrder };
      }

      return modules;
    }

    function readBackupSourceData() {
      return Promise.all([
        readConfigSnapshot(),
        readKnowledgeBackupModule(),
        readModelServicesForBackup(),
        readAgentSettingsForBackup(),
        readAssistantsForBackup(),
        readConversationsForBackup(),
        readSkillsForBackup(),
        readMcpServersForBackup(),
        readMcpConnectionsForBackup(),
      ]).then(function (results) {
        var runtimeConfig = results[0];
        if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig)) {
          throw new Error('平台配置资源返回无效数据');
        }
        return {
          config: runtimeConfig,
          knowledge: results[1],
          modelServices: results[2],
          agentSettings: results[3],
          assistants: results[4],
          conversations: results[5],
          skills: results[6],
          mcpServers: results[7],
          mcpConnections: results[8],
        };
      });
    }

    function createBackupPackage(modules, selectedIds) {
      var selected = dictionary();
      selectedIds.forEach(function (moduleId) {
        if (hasOwn(modules, moduleId) && modules[moduleId]) {
          setOwn(selected, moduleId, filterBuiltinBackupItems(moduleId, modules[moduleId]));
        }
      });
      return {
        kind: FULL_BACKUP_KIND,
        version: FULL_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        modules: selected,
        notes: {
          scope: 'canonical ARP resources plus owned local HTTP MCP server state',
          importMode: 'merge by default; replace mode clears selected Flow/FlowGroup collections through canonical resources',
          configDependencies: 'flow and flow group dependencies are included in pages, scripts and flows when present in the source config',
          conversations: 'Conversation JSON contains Artifact references but not image bytes; use the per-topic ZIP export for a restorable media-complete archive',
          secrets: 'only Model Service credentials are omitted; other selected module values are preserved verbatim',
        },
      };
    }

    function backupModuleItemsObject(module) {
      if (!module || !module.items) return {};
      if (Array.isArray(module.items)) return objectFromArrayById(module.items, 'item').items;
      return module.items && typeof module.items === 'object' ? module.items : {};
    }

    function modelSettingsImportItems(module) {
      var settings = normalizeModelSettingsForBackup(module && module.value || {});
      var items = [];
      if (settings.agentSettings && Object.keys(settings.agentSettings).length) {
        items.push({
          id: '__agent_settings__',
          label: 'Agent 全局设置',
          meta: '默认 Assistant、默认模型、上下文预算、压缩策略与运行轨迹',
        });
      }
      (settings.services || []).forEach(function (service) {
        if (!serviceIsExportable(service)) return;
        var label = globalThis.ModelSettings && globalThis.ModelSettings.serviceDisplayName
          ? globalThis.ModelSettings.serviceDisplayName(service)
          : (service.name || service.model || service.id);
        var meta = [service.protocol || service.apiStyle || '', service.model || '', service.baseUrl || ''].filter(Boolean).join(' · ');
        items.push({ id: 'service:' + service.id, label: label || service.id, meta: meta });
      });
      return items;
    }

    function knowledgeImportItems(module) {
      module = module && typeof module === 'object' ? module : {};
      var items = [];
      if (module.settings && typeof module.settings === 'object') {
        items.push({ id: '__settings__', label: '知识设置', meta: '启用、自动沉淀、自动引用和引用条数' });
      }
      var knowledgeItems = backupModuleItemsObject(module);
      orderedKeysForObject(knowledgeItems, module.order || []).forEach(function (id) {
        var item = knowledgeItems[id];
        if (!knowledgeItemIsExportable(item)) return;
        items.push({
          id: id,
          label: item.title || item.summary || id,
          meta: [
            item.sourceLabel || item.sourceKind || item.source && item.source.kind || '',
            item.type || '',
            item.updatedAt ? fmtTime(item.updatedAt) : '',
          ].filter(Boolean).join(' · '),
        });
      });
      return items;
    }

    function backupItemTitle(moduleId, id, item, pkg) {
      item = item || {};
      if (moduleId === 'pages') return item.label || item.url || id;
      if (moduleId === 'flows') return item.label || id;
      if (moduleId === 'flowGroups') return item.label || item.name || id;
      if (moduleId === 'scripts') return item.label || id;
      if (moduleId === 'schedules') return item.label || item.flowGroupId || item.groupId || item.flowId || item.assistantId || id;
      if (moduleId === 'urlTriggers') return item.label || item.urlPattern || id;
      if (moduleId === 'assistants') return item.name || id;
      if (moduleId === 'conversations') return item.name || item.objective || id;
      if (moduleId === 'knowledge') return item.title || item.summary || id;
      if (moduleId === 'skills') return item.name || id;
      if (moduleId === 'mcpServers') return item.name || item.url || id;
      if (moduleId === 'mcpSettings') return item.clientName || item.url || id;
      return id;
    }

    function backupItemMeta(moduleId, id, item, pkg) {
      if (moduleId === 'mcpSettings') return [item && item.enabled === true ? '已启用' : '已停用', item && item.url || ''].filter(Boolean).join(' · ');
      item = item || {};
      if (moduleId === 'pages') return item.url || '';
      if (moduleId === 'flows') return item.description || ((item.nodes || []).length ? ((item.nodes || []).length + ' 个节点') : '');
      if (moduleId === 'flowGroups') return item.description || ((item.steps || []).length ? ((item.steps || []).length + ' 个步骤') : '');
      if (moduleId === 'scripts') return item.updatedAt ? fmtTime(item.updatedAt) : '';
      if (moduleId === 'schedules') {
        var scheduleKind = scheduleTaskKind(item);
        var scheduleKindLabel = scheduleKind === 'conversation' ? '对话' : (scheduleKind === 'flowGroup' ? '流程组' : '流程');
        return scheduleKindLabel + ' · ' + (item.enabled === false ? '已停用' : '已启用');
      }
      if (moduleId === 'urlTriggers') return item.enabled === false ? '已停用' : '已启用';
      if (moduleId === 'assistants') return item.description || '';
      if (moduleId === 'conversations') {
        var assistants = pkg && pkg.modules && pkg.modules.assistants && pkg.modules.assistants.items || {};
        var assistant = assistants[item.assistantId] || {};
        return [assistant.name || item.assistantId || '', item.updatedAt ? fmtTime(item.updatedAt) : ''].filter(Boolean).join(' · ');
      }
      if (moduleId === 'knowledge') return [item.sourceLabel || item.sourceKind || item.source && item.source.kind || '', item.type || '', item.updatedAt ? fmtTime(item.updatedAt) : ''].filter(Boolean).join(' · ');
      if (moduleId === 'skills') return [item.description || '', item.version || ''].filter(Boolean).join(' · ');
      if (moduleId === 'mcpServers') return [item.enabled === false ? '已停用' : '已启用', item.url || ''].filter(Boolean).join(' · ');
      return '';
    }

    function backupModuleItemList(moduleId, module, pkg) {
      if (!module) return [];
      if (moduleId === 'modelSettings') return modelSettingsImportItems(module);
      if (moduleId === 'knowledge') return knowledgeImportItems(module);
      var items = backupModuleItemsObject(module);
      var order = orderedKeysForObject(items, module.order || []).filter(function (id) {
        return backupItemIsExportable(moduleId, items[id]);
      });
      var list = order.map(function (id) {
        return {
          id: id,
          label: backupItemTitle(moduleId, id, items[id], pkg),
          meta: backupItemMeta(moduleId, id, items[id], pkg),
        };
      });
      if (moduleId === 'assistants' && module.stateMeta && hasOwn(module.stateMeta, 'defaultAssistantId')) {
        list.unshift({ id: '__default_assistant__', label: '默认助手', meta: String(module.stateMeta.defaultAssistantId || '未设置') });
      }
      return list;
    }

    function backupModuleHasData(moduleId, module) {
      if (!module) return false;
      if (moduleId === 'modelSettings') return modelSettingsImportItems(module).length > 0;
      if (backupModuleItemList(moduleId, module).length > 0) return true;
      return hasOwn(module, 'value') && module.value !== null && module.value !== undefined;
    }

    function backupSizeLabel(value) {
      var bytes = 0;
      try {
        bytes = new TextEncoder().encode(JSON.stringify(value === undefined ? null : value)).length;
      } catch (_) {
        try { bytes = JSON.stringify(value === undefined ? null : value).length * 2; } catch (err) { bytes = 0; }
      }
      if (bytes < 1024) return bytes + 'B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + 'KB';
      return formatStorageMegabytes(bytes);
    }

    function renderExportBackupDrawer(modules) {
      if (destroyed) return;
      var rows = BACKUP_MODULE_DEFS.map(function (def) {
        var module = modules[def.id];
        var count = backupModuleItemList(def.id, module).length;
        var enabled = backupModuleHasData(def.id, module);
        var note = def.note || (module && module.source) || '';
        return '<label class="backup-module-row' + (enabled ? '' : ' disabled') + '">'
          + '<input type="checkbox" data-export-backup-module="' + esc(def.id) + '"' + (enabled ? ' checked' : ' disabled') + '>'
          + '<span class="backup-module-main"><b>' + esc(def.label) + '</b>'
          + (note ? '<small>' + esc(note) + '</small>' : '')
          + '</span>'
          + '<span class="backup-module-count">' + (enabled ? (count || 1) + ' 项' : '无数据') + '</span>'
          + '</label>';
      }).join('');
      $('#drawer-title').textContent = '一键导出所有数据';
      $('#drawer-content').innerHTML =
        '<p class="drawer-hint">按模块选择要写入 v6 备份包的数据。模型服务密钥和授权类请求头不会导出；Conversation Journal 中的运行轨迹会按所选模块保留。</p>'
        + '<div class="backup-toolbar">'
        + '<button class="btn-small" data-action="select-all-export-backup">全选</button>'
        + '<button class="btn-small" data-action="clear-export-backup">清空</button>'
        + '</div>'
        + '<div class="backup-module-list" id="backup-export-list">' + rows + '</div>';
      $('#drawer-actions').innerHTML =
        '<button class="btn-secondary" data-action="cancel-drawer">取消</button>'
        + '<button class="btn-primary" data-action="confirm-export-backup">导出备份</button>';
      openDrawer();
    }

    function openExportBackupDrawer() {
      if (destroyed) return { ok: false, destroyed: true };
      $('#drawer-title').textContent = '一键导出所有数据';
      $('#drawer-content').innerHTML = '<p class="drawer-hint">正在读取插件本地数据...</p>';
      $('#drawer-actions').innerHTML = '<button class="btn-secondary" data-action="cancel-drawer">取消</button>';
      openDrawer();
      backupIncludeReasoning = true;
      readBackupSourceData().then(function (source) {
        if (destroyed) return;
        var modules = buildBackupModules(source);
        pendingBackupExport = { modules: modules };
        renderExportBackupDrawer(modules);
      }).catch(function (err) {
        if (destroyed) return;
        toast('读取备份数据失败: ' + (err && err.message ? err.message : String(err)), true);
        closeDrawer();
      });
      return { ok: true };
    }

    function selectedExportBackupModules() {
      return $all('#backup-export-list input[data-export-backup-module]').filter(function (input) {
        return input.checked && !input.disabled;
      }).map(function (input) {
        return input.dataset.exportBackupModule;
      });
    }

    function exportSelectedBackup() {
      if (destroyed) return { ok: false, destroyed: true };
      if (!pendingBackupExport || !pendingBackupExport.modules) {
        toast('备份数据尚未读取完成', true);
        return { ok: false, error: '备份数据尚未读取完成' };
      }
      var selected = selectedExportBackupModules();
      if (!selected.length) {
        toast('请选择至少一个模块', true);
        return { ok: false, error: '请选择至少一个模块' };
      }
      var pkg = createBackupPackage(pendingBackupExport.modules, selected);
      var result = downloadFile('pfa-full-backup-' + backupFilenameTimestamp(new Date()) + '.json', JSON.stringify(pkg, null, 2), 'application/json');
      toast('备份已导出');
      closeDrawer();
      return result;
    }

    function normalizeBackupPackage(raw) {
      if (raw === null || raw === undefined) return null;
      assertBackupSize(raw, '备份数据');
      if (raw && raw.kind === FULL_BACKUP_KIND) {
        if (!raw.modules || typeof raw.modules !== 'object' || Array.isArray(raw.modules)) {
          throw backupError('invalid-modules', '备份 modules 必须是对象');
        }
        if (raw.version !== FULL_BACKUP_VERSION) {
          throw backupError('unsupported-version', '仅支持 v6 备份，收到版本: ' + String(raw.version));
        }
        var pkg = {
          kind: FULL_BACKUP_KIND,
          version: FULL_BACKUP_VERSION,
          exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
          modules: dictionary(),
        };
        if (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes)) pkg.notes = safeClone(raw.notes);
        Object.keys(raw.modules || {}).forEach(function (moduleId) {
          if (!hasOwn(BACKUP_MODULE_IDS, moduleId)) {
            throw backupError('unknown-module', '备份包含未知模块: ' + moduleId);
          }
          var rawModule = raw.modules[moduleId];
          if (!rawModule || typeof rawModule !== 'object' || Array.isArray(rawModule)) {
            throw backupError('invalid-module', '备份模块 ' + moduleId + ' 必须是对象');
          }
          var module = safeClone(rawModule);
          if (hasOwn(rawModule, 'order') && !Array.isArray(rawModule.order)) {
            throw backupError('invalid-module-order', '备份模块 ' + moduleId + ' 的 order 必须是数组');
          }
          if (hasOwn(rawModule, 'items')) {
            var rawItems = rawModule.items;
            if (!rawItems || typeof rawItems !== 'object' || Array.isArray(rawItems)) {
              throw backupError('invalid-module-items', '备份模块 ' + moduleId + ' 的 items 必须是对象');
            }
            var normalizedItems = dictionary();
            Object.keys(rawItems).forEach(function (id) {
              var item = rawItems[id];
              if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw backupError('invalid-module-item', '备份模块 ' + moduleId + ' 的条目 ' + id + ' 格式无效');
              }
              setOwn(normalizedItems, id, safeClone(item));
            });
            module.items = normalizedItems;
            module.order = orderedKeysForObject(normalizedItems, (rawModule.order || []).map(function (id) {
              if (typeof id !== 'string' && typeof id !== 'number') {
                throw backupError('invalid-module-order', '备份模块 ' + moduleId + ' 包含无效的 order 条目');
              }
              return String(id);
            }));
          }
          if (moduleId === 'modelSettings' && hasOwn(rawModule, 'value')
              && (!rawModule.value || typeof rawModule.value !== 'object' || Array.isArray(rawModule.value))) {
            throw backupError('invalid-module-value', '备份模块 modelSettings 的 value 必须是对象');
          }
          setOwn(pkg.modules, moduleId, filterBuiltinBackupItems(moduleId, module));
        });
        assertBackupSize(pkg, '标准化后的备份数据');
        return pkg;
      }
      return null;
    }

    function orderedBackupModuleIds(modules) {
      var seen = dictionary();
      var ids = [];
      BACKUP_MODULE_DEFS.forEach(function (def) {
        if (modules && hasOwn(modules, def.id) && modules[def.id]) {
          setOwn(seen, def.id, true);
          ids.push(def.id);
        }
      });
      Object.keys(modules || {}).forEach(function (id) {
        if (!hasOwn(seen, id)) ids.push(id);
      });
      return ids;
    }

    function renderImportBackupDrawer(pkg) {
      if (destroyed) return;
      var moduleIds = orderedBackupModuleIds(pkg.modules || {});
      var rows = moduleIds.map(function (moduleId) {
        var module = pkg.modules[moduleId];
        var def = backupModuleDef(moduleId);
        var items = backupModuleItemList(moduleId, module, pkg);
        var enabled = backupModuleHasData(moduleId, module);
        var itemHtml = items.length ? '<div class="backup-item-list">' + items.map(function (item) {
          return '<label class="backup-item-row">'
            + '<input type="checkbox" data-import-backup-item="' + esc(item.id) + '" data-import-backup-module="' + esc(moduleId) + '">'
            + '<span><b>' + esc(item.label || item.id) + '</b>' + (item.meta ? '<small>' + esc(item.meta) + '</small>' : '') + '</span>'
            + '</label>';
        }).join('') + '</div>' : '<div class="backup-empty-detail">此模块按整体设置导入。</div>';
        return '<details class="backup-module-card" open>'
          + '<summary><label class="backup-module-summary">'
          + '<input type="checkbox" data-import-backup-module="' + esc(moduleId) + '"' + (enabled ? '' : ' disabled') + '>'
          + '<span><b>' + esc(def.label || module.label || moduleId) + '</b>'
          + '<small>' + esc((module && module.source) || '') + '</small></span>'
          + '<em>' + (enabled ? (items.length || 1) + ' 项 · ' + backupSizeLabel(module) : '无数据') + '</em>'
          + '</label></summary>'
          + itemHtml
          + '</details>';
      }).join('');
      var exportedAt = pkg.exportedAt ? fmtTime(Date.parse(pkg.exportedAt)) : '未知时间';
      $('#drawer-title').textContent = '一键导入备份数据';
      $('#drawer-content').innerHTML =
        '<p class="drawer-hint">选择要导入的模块和明细。所选条目会按 ID/key 写入并覆盖同名数据，未勾选的数据保持不变。</p>'
        + '<div class="backup-import-meta">备份时间：' + esc(exportedAt) + ' · v6</div>'
        + '<div class="backup-import-meta"><label><input type="radio" name="backup-import-mode" value="merge" checked> 合并</label> '
        + '<label><input type="radio" name="backup-import-mode" value="replace"> 替换所选 Flow/FlowGroup 集合</label></div>'
        + '<div class="backup-toolbar">'
        + '<button class="btn-small" data-action="select-all-import-backup">全选</button>'
        + '<button class="btn-small" data-action="clear-import-backup">清空</button>'
        + '</div>'
        + '<div class="backup-module-list" id="backup-import-list">' + rows + '</div>';
      $('#drawer-actions').innerHTML =
        '<button class="btn-secondary" data-action="cancel-drawer">取消</button>'
        + '<button class="btn-primary" data-action="confirm-import-backup">导入所选数据</button>';
      openDrawer();
    }

    function openImportBackupFromRaw(raw) {
      if (destroyed) return { ok: false, destroyed: true };
      var pkg;
      try {
        pkg = normalizeBackupPackage(raw);
      } catch (error) {
        toast('备份文件无效: ' + errorText(error), true);
        return { ok: false, error: errorText(error) };
      }
      if (!pkg) {
        toast('不是有效的备份数据文件', true);
        return { ok: false, error: '不是有效的备份数据文件' };
      }
      pendingBackupImport = { package: pkg };
      renderImportBackupDrawer(pkg);
      return { ok: true, package: pkg };
    }

    function collectImportBackupPlan() {
      var plan = dictionary();
      $all('#backup-import-list input[data-import-backup-module]').forEach(function (moduleInput) {
        if (moduleInput.dataset.importBackupItem) return;
        if (moduleInput.disabled) return;
        var moduleId = moduleInput.dataset.importBackupModule;
        var itemInputs = $all('#backup-import-list input[data-import-backup-item]').filter(function (input) {
          return input.dataset.importBackupModule === moduleId && !input.disabled;
        });
        if (!itemInputs.length) {
          if (moduleInput.checked) setOwn(plan, moduleId, null);
          return;
        }
        var ids = itemInputs.filter(function (input) { return input.checked; }).map(function (input) { return input.dataset.importBackupItem; });
        if (ids.length) setOwn(plan, moduleId, ids);
      });
      return plan;
    }

    function selectedImportMode() {
      var input = $('#drawer-content input[name="backup-import-mode"]:checked');
      return input && input.value === 'replace' ? 'replace' : 'merge';
    }

    function importBackupModuleInput(moduleId) {
      return $('#backup-import-list input[data-import-backup-module="' + cssEscape(moduleId) + '"]:not([data-import-backup-item])');
    }

    function importBackupItemInputs(moduleId) {
      return $all('#backup-import-list input[data-import-backup-item][data-import-backup-module="' + cssEscape(moduleId) + '"]').filter(function (input) {
        return !input.disabled;
      });
    }

    function updateImportBackupModuleCheckbox(moduleId) {
      var moduleInput = importBackupModuleInput(moduleId);
      if (!moduleInput || moduleInput.disabled) return;
      var itemInputs = importBackupItemInputs(moduleId);
      if (!itemInputs.length) {
        moduleInput.indeterminate = false;
        return;
      }
      var checkedCount = itemInputs.filter(function (input) { return input.checked; }).length;
      moduleInput.indeterminate = false;
      moduleInput.checked = checkedCount > 0 && checkedCount === itemInputs.length;
    }

    function updateAllImportBackupModuleCheckboxes() {
      $all('#backup-import-list input[data-import-backup-module]:not([data-import-backup-item])').forEach(function (moduleInput) {
        updateImportBackupModuleCheckbox(moduleInput.dataset.importBackupModule);
      });
    }

    function setImportBackupModuleSelection(moduleId, checked) {
      var moduleInput = importBackupModuleInput(moduleId);
      if (moduleInput && !moduleInput.disabled) {
        moduleInput.checked = !!checked;
        moduleInput.indeterminate = false;
      }
      importBackupItemInputs(moduleId).forEach(function (input) {
        input.checked = !!checked;
      });
    }

    function handleImportBackupCheckboxChange(event) {
      var input = event.target && event.target.closest && event.target.closest('#backup-import-list input[type="checkbox"]');
      if (!input || input.disabled) return;
      var moduleId = input.dataset.importBackupModule || '';
      if (!moduleId) return;
      if (input.dataset.importBackupItem) {
        updateImportBackupModuleCheckbox(moduleId);
      } else {
        setImportBackupModuleSelection(moduleId, input.checked);
      }
    }

    function selectedBackupIds(module, selectedIds) {
      var items = backupModuleItemsObject(module);
      var order = orderedKeysForObject(items, module && module.order || []);
      if (!selectedIds) return order;
      var selected = dictionary();
      selectedIds.forEach(function (id) { setOwn(selected, id, true); });
      return order.filter(function (id) { return hasOwn(selected, id); });
    }

    function selectableBackupIds(moduleId, module) {
      if (moduleId === 'modelSettings') {
        var settings = normalizeModelSettingsForBackup(module && module.value || {});
        var ids = (settings.services || []).filter(serviceIsExportable).map(function (service) {
          return 'service:' + String(service.id || '');
        }).filter(function (id) { return id !== 'service:'; });
        if (settings.agentSettings && Object.keys(settings.agentSettings).length) ids.unshift('__agent_settings__');
        return ids;
      }
      var items = backupModuleItemsObject(module);
      var ids = orderedKeysForObject(items, module && module.order || []).filter(function (id) {
        return backupItemIsExportable(moduleId, items[id]);
      });
      if (moduleId === 'assistants' && module && module.stateMeta && hasOwn(module.stateMeta, 'defaultAssistantId')) {
        ids.unshift('__default_assistant__');
      }
      if (moduleId === 'knowledge' && module.settings && typeof module.settings === 'object') ids.unshift('__settings__');
      return uniqueBackupIds(ids);
    }

    function normalizeImportPlan(pkg, rawPlan) {
      if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
        throw backupError('invalid-import-plan', '导入计划必须是对象');
      }
      var plan = dictionary();
      Object.keys(rawPlan).forEach(function (moduleId) {
        if (!hasOwn(BACKUP_MODULE_IDS, moduleId) || !hasOwn(pkg.modules, moduleId)) {
          throw backupError('invalid-import-plan', '导入计划包含未知或缺失模块: ' + moduleId);
        }
        var selected = rawPlan[moduleId];
        var availableIds = selectableBackupIds(moduleId, pkg.modules[moduleId]);
        if (selected === null) {
          if (!availableIds.length) {
            throw backupError('invalid-import-plan', '导入计划模块 ' + moduleId + ' 没有可导入条目');
          }
          setOwn(plan, moduleId, null);
          return;
        }
        if (!Array.isArray(selected)) {
          throw backupError('invalid-import-plan', '导入计划模块 ' + moduleId + ' 必须是 ID 数组或 null');
        }
        var available = dictionary();
        availableIds.forEach(function (id) { setOwn(available, id, true); });
        var ids = [];
        var seen = dictionary();
        selected.forEach(function (rawId) {
          if (typeof rawId !== 'string' && typeof rawId !== 'number') {
            throw backupError('invalid-import-plan', '导入计划模块 ' + moduleId + ' 包含无效 ID');
          }
          var id = String(rawId);
          if (!id || !hasOwn(available, id)) {
            throw backupError('invalid-import-plan', '导入计划模块 ' + moduleId + ' 不包含条目: ' + id);
          }
          if (!hasOwn(seen, id)) {
            setOwn(seen, id, true);
            ids.push(id);
          }
        });
        if (!ids.length) throw backupError('invalid-import-plan', '导入计划模块 ' + moduleId + ' 未选择任何条目');
        setOwn(plan, moduleId, ids);
      });
      if (!Object.keys(plan).length) throw backupError('invalid-import-plan', '导入计划未选择任何模块');
      return plan;
    }

    function selectedConfigSections(pkg, plan) {
      return CONFIG_BACKUP_SECTIONS.filter(function (def) {
        return hasOwn(plan, def.id) && hasOwn(pkg.modules, def.id);
      });
    }

    function buildNextConfig(runtimeConfig, pkg, plan) {
      var next = runtimeConfig && typeof runtimeConfig === 'object' && !Array.isArray(runtimeConfig)
        ? safeClone(runtimeConfig)
        : dictionary();
      CONFIG_BACKUP_SECTIONS.forEach(function (def) {
        if (def.configSection === 'urlTriggers') {
          if (!Array.isArray(next.urlTriggers)) next.urlTriggers = [];
        } else if (!next[def.configSection] || typeof next[def.configSection] !== 'object' || Array.isArray(next[def.configSection])) {
          setOwn(next, def.configSection, dictionary());
        }
      });
      selectedConfigSections(pkg, plan).forEach(function (def) {
        var module = pkg.modules[def.id];
        var items = backupModuleItemsObject(module);
        var ids = selectedBackupIds(module, plan[def.id]);
        if (def.configSection === 'urlTriggers') {
          var current = objectFromArrayById(next.urlTriggers || [], 'ut');
          ids.forEach(function (id) {
            if (!hasOwn(items, id)) return;
            var item = sanitizeRuntimeValue(items[id]);
            if (!item.id) setOwn(item, 'id', id);
            setOwn(current.items, id, item);
            if (current.order.indexOf(id) === -1) current.order.push(id);
          });
          next.urlTriggers = orderedKeysForObject(current.items, current.order.concat(module.order || [])).map(function (id) {
            return current.items[id];
          }).filter(Boolean);
          return;
        }
        var section = next[def.configSection];
        ids.forEach(function (id) {
          if (!hasOwn(items, id)) return;
          if (isBuiltinConfigImport(def.configSection, id, items[id], runtimeConfig)) return;
          var importedItem = sanitizeRuntimeValue(items[id]);
          setOwn(section, id, def.configSection === 'flows' ? migrateLegacyPageNodes(importedItem) : importedItem);
        });
      });
      return next;
    }

    function scheduleTargetValue(schedule, keys) {
      var task = schedule && schedule.task && typeof schedule.task === 'object' ? schedule.task : {};
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = schedule && schedule[key] !== undefined ? schedule[key] : task[key];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
      }
      return '';
    }

    function dependencyError(owner, section, id) {
      var labels = { pages: '页面', flows: '流程', flowGroups: '流程组', scripts: '脚本', assistants: '助手' };
      throw backupError('missing-dependency', owner + ' 缺少' + (labels[section] || section) + '依赖: ' + id);
    }

    function selectedAssistantBackupIds(pkg, plan) {
      if (!hasOwn(plan, 'assistants') || !pkg.modules.assistants) return [];
      var module = pkg.modules.assistants;
      var items = backupModuleItemsObject(module);
      return selectedBackupIds(module, plan.assistants).filter(function (id) {
        return hasOwn(items, id);
      });
    }

    function availableAssistantDependencyIds(currentAssistants, pkg, plan) {
      var available = dictionary();
      (currentAssistants || []).forEach(function (assistant) {
        var id = String(assistant && assistant.id || '').trim();
        if (id) setOwn(available, id, true);
      });
      selectedAssistantBackupIds(pkg, plan).forEach(function (id) {
        setOwn(available, id, true);
      });
      return available;
    }

    function validateConfigDependencyClosure(nextConfig, pkg, plan, availableAssistants) {
      var flowQueue = [];
      var queuedFlows = dictionary();
      var seenFlows = dictionary();

      function requireItem(section, id, owner) {
        id = String(id || '').trim();
        if (!id) return null;
        var map = nextConfig[section];
        if (!map || typeof map !== 'object' || !hasOwn(map, id)) dependencyError(owner, section, id);
        return map[id];
      }

      function requireAssistant(id, owner) {
        id = String(id || '').trim();
        if (!id || !hasOwn(availableAssistants, id)) dependencyError(owner, 'assistants', id || '(未设置)');
      }

      function queueFlow(id, owner) {
        id = String(id || '').replace(/^user:/, '').trim();
        if (!id) return;
        requireItem('flows', id, owner);
        if (!hasOwn(queuedFlows, id)) {
          setOwn(queuedFlows, id, true);
          flowQueue.push(id);
        }
      }

      function requireFlowGroup(id, owner) {
        id = String(id || '').replace(/^flowGroup:/, '').trim();
        var group = requireItem('flowGroups', id, owner);
        if (group.steps !== undefined && !Array.isArray(group.steps)) {
          throw backupError('invalid-dependency-shape', owner + ' 的 steps 必须是数组');
        }
        (group.steps || []).forEach(function (step) {
          if (step && step.flowId) queueFlow(step.flowId, owner);
        });
        return group;
      }

      if (hasOwn(plan, 'flows')) {
        selectedBackupIds(pkg.modules.flows, plan.flows).forEach(function (id) { queueFlow(id, '流程 ' + id); });
      }
      if (hasOwn(plan, 'flowGroups')) {
        selectedBackupIds(pkg.modules.flowGroups, plan.flowGroups).forEach(function (id) {
          requireFlowGroup(id, '流程组 ' + id);
        });
      }
      if (hasOwn(plan, 'schedules')) {
        selectedBackupIds(pkg.modules.schedules, plan.schedules).forEach(function (id) {
          var schedule = requireItem('schedules', id, '定时运行 ' + id);
          if (scheduleTaskKind(schedule) === 'conversation') {
            requireAssistant(scheduleTargetValue(schedule, ['assistantId']), '定时运行 ' + id);
          } else if (scheduleTaskKind(schedule) === 'flowGroup') {
            requireFlowGroup(scheduleTargetValue(schedule, ['flowGroupId', 'groupId']), '定时运行 ' + id);
          } else {
            var flowId = scheduleTargetValue(schedule, ['flowId']);
            if (flowId) queueFlow(flowId, '定时运行 ' + id);
          }
        });
      }
      if (hasOwn(plan, 'urlTriggers')) {
        var triggers = objectFromArrayById(nextConfig.urlTriggers || [], 'ut').items;
        selectedBackupIds(pkg.modules.urlTriggers, plan.urlTriggers).forEach(function (id) {
          var trigger = hasOwn(triggers, id) ? triggers[id] : null;
          if (!trigger) dependencyError('URL 触发运行 ' + id, 'flows', id);
          if (String(trigger.flowId || '').indexOf('flowGroup:') === 0) {
            requireFlowGroup(trigger.flowId, 'URL 触发运行 ' + id);
          } else if (trigger.flowId) queueFlow(trigger.flowId, 'URL 触发运行 ' + id);
        });
      }

      while (flowQueue.length) {
        var flowId = flowQueue.shift();
        if (hasOwn(seenFlows, flowId)) continue;
        setOwn(seenFlows, flowId, true);
        var flow = requireItem('flows', flowId, '流程 ' + flowId);
        if (flow.nodes !== undefined && !Array.isArray(flow.nodes)) {
          throw backupError('invalid-dependency-shape', '流程 ' + flowId + ' 的 nodes 必须是数组');
        }
        (flow.nodes || []).forEach(function (node) {
          flowNodePageIds(node).forEach(function (pageId) { requireItem('pages', pageId, '流程 ' + flowId); });
          flowNodeScriptIds(node).forEach(function (scriptId) { requireItem('scripts', scriptId, '流程 ' + flowId); });
          flowNodeFlowIds(node).forEach(function (childFlowId) { queueFlow(childFlowId, '流程 ' + flowId); });
          flowNodeAssistantIds(node).forEach(function (assistantId) { requireAssistant(assistantId, '流程 ' + flowId); });
        });
      }
    }

    function preflightImport(raw, rawPlan, rawMode) {
      if (destroyed) return Promise.reject(backupError('destroyed', '备份控制器已销毁'));
      var pkg = normalizeBackupPackage(raw);
      if (!pkg) return Promise.reject(backupError('invalid-backup', '不是有效的备份数据文件'));
      var plan = normalizeImportPlan(pkg, rawPlan);
      var needsAssistantCatalog = ['flows', 'flowGroups', 'schedules', 'urlTriggers'].some(function (moduleId) {
        return hasOwn(plan, moduleId);
      });
      var assistantCatalog = needsAssistantCatalog ? readResourceCollection('/assistants') : Promise.resolve([]);
      return Promise.all([readConfigSnapshot(), assistantCatalog]).then(function (values) {
        var runtimeConfig = values[0];
        var currentAssistants = values[1];
        if (destroyed) throw backupError('destroyed', '备份控制器已销毁');
        if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig)) {
          throw backupError('config-read-failed', '平台配置资源返回无效数据');
        }
        var importMode = String(rawMode || 'merge');
        if (importMode !== 'merge' && importMode !== 'replace') throw backupError('invalid-import-mode', '导入模式必须是 merge 或 replace');
        var nextConfig = buildNextConfig(runtimeConfig, pkg, plan);
        if (importMode === 'replace') {
          [{ moduleId: 'flows', section: 'flows' }, { moduleId: 'flowGroups', section: 'flowGroups' }].forEach(function (entry) {
            if (!hasOwn(plan, entry.moduleId) || !pkg.modules[entry.moduleId]) return;
            var replacement = dictionary();
            Object.keys(runtimeConfig[entry.section] || {}).forEach(function (id) {
              if (isBuiltinItem(runtimeConfig[entry.section][id])) setOwn(replacement, id, safeClone(runtimeConfig[entry.section][id]));
            });
            var module = pkg.modules[entry.moduleId];
            var items = backupModuleItemsObject(module);
            selectedBackupIds(module, plan[entry.moduleId]).forEach(function (id) {
              if (hasOwn(items, id) && !isBuiltinConfigImport(entry.section, id, items[id], runtimeConfig)) {
                setOwn(replacement, id, sanitizeRuntimeValue(items[id]));
              }
            });
            nextConfig[entry.section] = replacement;
          });
        }
        var selectedAssistantIds = dictionary();
        selectedAssistantBackupIds(pkg, plan).forEach(function (id) { setOwn(selectedAssistantIds, id, true); });
        validateConfigDependencyClosure(
          nextConfig,
          pkg,
          plan,
          availableAssistantDependencyIds(currentAssistants, pkg, plan)
        );
        return {
          package: pkg,
          plan: plan,
          runtimeConfig: safeClone(runtimeConfig),
          nextConfig: nextConfig,
          importMode: importMode,
          assistantIdMap: dictionary(),
          selectedAssistantIds: selectedAssistantIds,
        };
      });
    }

    function resourceNotFound(error) {
      return !!(error && (error.code === 'RESOURCE_NOT_FOUND' || Number(error.status) === 404));
    }

    function flowBackupResourceSpec(section) {
      return section === 'flows'
        ? { collection: '/flows', collectionRelation: 'flows', itemRelation: 'flow' }
        : { collection: '/flow-groups', collectionRelation: 'flow-groups', itemRelation: 'flow-group' };
    }

    function upsertFlowBackupResource(section, id, item) {
      var spec = flowBackupResourceSpec(section);
      var body = sanitizeRuntimeValue(item || {});
      body.id = String(id || body.id || '').trim();
      if (!body.id) return Promise.reject(new Error(section + ' 导入项缺少 ID'));
      if (section === 'flows' && !Array.isArray(body.nodes)) body.nodes = [];
      var uri = spec.collection + '/' + resourceSegment(body.id);
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedPut(uri, body, backupResourceMutationOptions({
          ifMatch: 'cached', criteria: { relation: spec.itemRelation },
        }));
      }, function (error) {
        if (!resourceNotFound(error)) throw error;
        return resourceClient.authorizedPost(spec.collection, body, backupResourceMutationOptions({
          criteria: { relation: spec.collectionRelation },
        }));
      });
    }

    function deleteFlowBackupCollection(section, failures) {
      var spec = flowBackupResourceSpec(section);
      return readResourceCollection(spec.collection).then(function (items) {
        return items.reduce(function (chain, item) {
          return chain.then(function () {
            var id = String(item && item.id || '').trim();
            if (!id || isBuiltinItem(item)) return;
            var uri = spec.collection + '/' + resourceSegment(id);
            return resourceClient.get(uri).then(function () {
              return resourceClient.authorizedDelete(uri, backupResourceMutationOptions({
                ifMatch: 'cached', criteria: { relation: spec.itemRelation },
              }));
            }).catch(function (error) {
              failures.push({ id: section + ':delete:' + id, error: errorText(error) });
            });
          });
        }, Promise.resolve());
      }).catch(function (error) {
        failures.push({ id: section + ':list', error: errorText(error) });
      });
    }

    function importedAssistantId(assistantId, preflight, owner) {
      assistantId = String(assistantId || '').trim();
      if (!assistantId) return '';
      var mapped = preflight.assistantIdMap[assistantId];
      if (mapped) return mapped;
      if (hasOwn(preflight.selectedAssistantIds, assistantId)) {
        throw new Error((owner || '导入项') + ' 依赖的助手未成功导入: ' + assistantId);
      }
      return assistantId;
    }

    function remapScheduleAssistant(item, preflight, owner) {
      if (!item || scheduleTaskKind(item) !== 'conversation') return item;
      var currentId = scheduleTargetValue(item, ['assistantId']);
      var mapped = importedAssistantId(currentId, preflight, owner);
      if (!mapped || mapped === currentId) return item;
      if (hasOwn(item, 'assistantId')) item.assistantId = mapped;
      if (item.task && typeof item.task === 'object' && hasOwn(item.task, 'assistantId')) item.task.assistantId = mapped;
      return item;
    }

    function remapFlowAssistants(item, preflight, owner) {
      if (!item || !Array.isArray(item.nodes)) return item;
      item.nodes.forEach(function (node) {
        if (!node || node.type !== 'runAssistant' || !node.params || typeof node.params !== 'object') return;
        var currentId = String(node.params.assistantId || '').trim();
        var mapped = importedAssistantId(currentId, preflight, owner);
        if (mapped && mapped !== currentId) node.params.assistantId = mapped;
      });
      return item;
    }

    function applyConfigBackupImport(pkg, plan, preflight) {
      var selectedSections = selectedConfigSections(pkg, plan);
      if (!selectedSections.length) return Promise.resolve('');
      var failures = [];
      var succeeded = 0;
      var operation = Promise.resolve();
      var selectedBySection = dictionary();
      selectedSections.forEach(function (def) { setOwn(selectedBySection, def.configSection, def); });

      if (preflight.importMode === 'replace') {
        ['flowGroups', 'flows'].forEach(function (section) {
          if (!hasOwn(selectedBySection, section)) return;
          operation = operation.then(function () { return deleteFlowBackupCollection(section, failures); });
        });
      }

      ['pages', 'scripts', 'flows', 'flowGroups', 'schedules', 'urlTriggers'].forEach(function (section) {
        var def = selectedBySection[section];
        if (!def) return;
        var module = pkg.modules[def.id];
        var sourceItems = backupModuleItemsObject(module);
        selectedBackupIds(module, plan[def.id]).forEach(function (id) {
          if (!hasOwn(sourceItems, id)) return;
          if (section !== 'urlTriggers' && isBuiltinConfigImport(section, id, sourceItems[id], preflight.runtimeConfig)) return;
          operation = operation.then(function () {
            var item = sanitizeRuntimeValue(sourceItems[id]);
            if (!item.id) item.id = id;
            if (section === 'flows') migrateLegacyPageNodes(item);
            if (section === 'schedules') remapScheduleAssistant(item, preflight, '定时运行 ' + id);
            if (section === 'flows') remapFlowAssistants(item, preflight, '流程 ' + id);
            var request = section === 'flows' || section === 'flowGroups'
              ? upsertFlowBackupResource(section, id, item)
              : mutateConfigResource('upsert', section, item);
            return request.then(function () { succeeded += 1; }).catch(function (error) {
              failures.push({ id: section + ':' + id, error: errorText(error) });
            });
          });
        });
      });

      return operation.then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('config-import-partial', '配置资源导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return selectedSections.map(function (def) { return def.label; }).join('、');
      });
    }

    function modelServiceImportBody(service, includeId) {
      service = service && typeof service === 'object' && !Array.isArray(service) ? service : {};
      var protocol = String(service.protocol || service.apiStyle || 'chat_completions');
      if (['chat_completions', 'responses', 'anthropic'].indexOf(protocol) === -1) {
        throw new Error('模型服务 ' + String(service.id || '') + ' 的 protocol 不受支持: ' + (protocol || '空'));
      }
      var body = dictionary();
      if (includeId) setOwn(body, 'id', String(service.id || ''));
      setOwn(body, 'protocol', protocol);
      [
        'name', 'baseUrl', 'model', 'visionModel', 'summaryModel', 'userAgent',
        'maxContextTokens', 'autoCompactTokenLimit', 'reasoningEffort', 'requestTimeoutMs',
        'maxRetries', 'maxRetryDelayMs', 'contextCompression',
      ].forEach(function (key) {
        if (hasOwn(service, key)) setOwn(body, key, safeClone(service[key]));
      });
      if (!String(body.name || '').trim()) throw new Error('模型服务 ' + String(service.id || '') + ' 缺少名称');
      return body;
    }

    function importModelServiceResource(service) {
      var serviceId = String(service && service.id || '').trim();
      if (!serviceId) return Promise.reject(new Error('模型服务缺少 ID'));
      var uri = '/model-services/' + resourceSegment(serviceId);
      var patch = modelServiceImportBody(service, false);
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedPatch(uri, patch, backupResourceMutationOptions({
          ifMatch: 'cached',
          criteria: { relation: 'model-service' },
        }));
      }, function (error) {
        if (!(error && (error.code === 'RESOURCE_NOT_FOUND' || Number(error.status) === 404))) throw error;
        return resourceClient.authorizedPost('/model-services', modelServiceImportBody(service, true), backupResourceMutationOptions({
          criteria: { relation: 'model-services' },
        }));
      });
    }

    function importAgentSettingsResource(settings) {
      settings = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
      var patch = dictionary();
      ['defaultAssistantId', 'defaultModelServiceId', 'contextBudget', 'contextCompression']
        .forEach(function (key) {
          if (hasOwn(settings, key)) setOwn(patch, key, safeClone(settings[key]));
        });
      if (!Object.keys(patch).length) return Promise.resolve(null);
      return resourceClient.get('/agent-settings').then(function () {
        return resourceClient.authorizedPatch('/agent-settings', patch, backupResourceMutationOptions({
          ifMatch: 'cached',
          criteria: { relation: 'agent-settings' },
        }));
      });
    }

    function applyModelSettingsBackupImport(pkg, plan) {
      if (!hasOwn(plan, 'modelSettings') || !pkg.modules.modelSettings) return Promise.resolve('');
      var module = pkg.modules.modelSettings;
      var selected = plan.modelSettings;
      var selectedMap = dictionary();
      (selected || []).forEach(function (id) { setOwn(selectedMap, id, true); });
      var backupSettings = normalizeModelSettingsForBackup(module.value || {});
      var importAll = !selected;
      var services = (backupSettings.services || []).filter(function (service) {
        return service && serviceIsExportable(service)
          && (importAll || hasOwn(selectedMap, 'service:' + service.id));
      });
      var importAgentSettings = importAll || hasOwn(selectedMap, '__agent_settings__');
      var failures = [];
      var succeeded = 0;
      var chain = Promise.resolve();
      services.forEach(function (service) {
        chain = chain.then(function () {
          return importModelServiceResource(service).then(function () {
            succeeded += 1;
          }).catch(function (error) {
            failures.push({ id: 'service:' + String(service.id || ''), error: errorText(error) });
          });
        });
      });
      if (importAgentSettings) {
        chain = chain.then(function () {
          return importAgentSettingsResource(backupSettings.agentSettings).then(function () {
            succeeded += 1;
          }).catch(function (error) {
            failures.push({ id: '__agent_settings__', error: errorText(error) });
          });
        });
      }
      return chain.then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('model-settings-import-partial', backupModuleLabel('modelSettings') + '导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? backupModuleLabel('modelSettings') : '';
      });
    }

    function assistantImportBody(item) {
      item = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      var body = dictionary();
      ['name', 'description', 'prompt', 'resourcePolicy', 'modelServiceId', 'settings']
        .forEach(function (key) {
          if (hasOwn(item, key)) setOwn(body, key, safeClone(item[key]));
        });
      if (!String(body.name || '').trim()) throw new Error('助手缺少名称');
      return body;
    }

    function importAssistantResource(backupId, item, preflight) {
      var uri = '/assistants/' + resourceSegment(backupId);
      var body = assistantImportBody(item);
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedPatch(uri, body, backupResourceMutationOptions({
          ifMatch: 'cached', criteria: { relation: 'assistant' },
        }));
      }, function (error) {
        if (!resourceNotFound(error)) throw error;
        return resourceClient.authorizedPost('/assistants', body, backupResourceMutationOptions({
          criteria: { relation: 'assistants' },
        }));
      }).then(function (envelope) {
        var imported = resourceEnvelopeData(envelope, '助手 ' + backupId);
        var actualId = String(imported.id || '').trim();
        if (!actualId) throw new Error('助手导入未返回 ID: ' + backupId);
        setOwn(preflight.assistantIdMap, backupId, actualId);
        return actualId;
      });
    }

    function applyAssistantsBackupImport(pkg, plan, preflight) {
      if (!hasOwn(plan, 'assistants') || !pkg.modules.assistants) return Promise.resolve('');
      var module = pkg.modules.assistants;
      var items = backupModuleItemsObject(module);
      var selected = plan.assistants;
      var selectedMap = dictionary();
      (selected || []).forEach(function (id) { setOwn(selectedMap, id, true); });
      var ids = selectedBackupIds(module, selected).filter(function (id) { return id !== '__default_assistant__'; });
      var importDefault = !selected || hasOwn(selectedMap, '__default_assistant__');
      var failures = [];
      var succeeded = 0;
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          return importAssistantResource(id, items[id], preflight).then(function () { succeeded += 1; }).catch(function (error) {
            failures.push({ id: id, error: errorText(error) });
          });
        });
      });
      if (importDefault && module.stateMeta && hasOwn(module.stateMeta, 'defaultAssistantId')) {
        chain = chain.then(function () {
          var backupId = String(module.stateMeta.defaultAssistantId || '');
          var actualId = preflight.assistantIdMap[backupId] || backupId;
          return importAgentSettingsResource({ defaultAssistantId: actualId }).then(function () {
            succeeded += 1;
          }).catch(function (error) {
            failures.push({ id: '__default_assistant__', error: errorText(error) });
          });
        });
      }
      return chain.then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('assistant-import-partial', '助手导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? '助手' : '';
      });
    }

    function conversationCreateBody(id, item, preflight) {
      item = conversationForBackup(item, id);
      var body = dictionary();
      setOwn(body, 'topicId', String(id || item.topicId || ''));
      [
        'assistantId', 'name', 'objective', 'activeTabId', 'activeWindowId', 'targetUrl',
        'targetTitle', 'modelServiceId', 'maxIterations', 'maxToolCalls', 'assistantSnapshot', 'contextMeta',
      ].forEach(function (key) {
        if (hasOwn(item, key)) setOwn(body, key, safeClone(item[key]));
      });
      if (item.budgets && typeof item.budgets === 'object' && !Array.isArray(item.budgets)) {
        if (!hasOwn(body, 'maxIterations') && hasOwn(item.budgets, 'maxIterations')) {
          setOwn(body, 'maxIterations', safeClone(item.budgets.maxIterations));
        }
        if (!hasOwn(body, 'maxToolCalls') && hasOwn(item.budgets, 'maxToolCalls')) {
          setOwn(body, 'maxToolCalls', safeClone(item.budgets.maxToolCalls));
        }
      }
      var assistantId = String(body.assistantId || '').trim();
      body.assistantId = importedAssistantId(assistantId, preflight, '对话 ' + id);
      if (!body.assistantId) throw new Error('对话缺少 assistantId: ' + id);
      return body;
    }

    function archiveImportedConversation(uri) {
      return resourceClient.get(uri).then(function (envelope) {
        var current = resourceEnvelopeData(envelope, '对话');
        if (current.archived === true) return envelope;
        return resourceClient.authorizedPatch(uri, { archived: true }, backupResourceMutationOptions({
          ifMatch: 'cached', criteria: { relation: 'conversation' },
        }));
      });
    }

    function importConversationResource(id, item, preflight) {
      var uri = '/conversations/' + resourceSegment(id);
      if (item && !item.journalBackup && (Array.isArray(item.history) || Array.isArray(item.events))) {
        return Promise.reject(backupError(
          'unsupported-legacy-conversation-backup',
          '仅支持 Conversation Journal v3 归档；旧版 history/events 数据不可导入'
        ));
      }
      var body = conversationCreateBody(id, item, preflight);
      var desiredArchived = item && item.archived === true;
      var journalImport = item && item.journalBackup
        ? runtimeMessage('IMPORT_CONVERSATION_BACKUP', {
          backup: item.journalBackup,
          assistantId: body.assistantId,
          replace: true,
        })
        : Promise.resolve(null);
      return journalImport.then(function () { return resourceClient.get(uri); }).then(function (envelope) {
        var current = resourceEnvelopeData(envelope, '对话 ' + id);
        if (current.archived === true) return envelope;
        var patch = dictionary();
        ['name', 'objective', 'assistantId', 'modelServiceId', 'assistantSnapshot', 'contextMeta']
          .forEach(function (key) {
          if (hasOwn(body, key)) setOwn(patch, key, safeClone(body[key]));
        });
        if (!Object.keys(patch).length) return envelope;
        return resourceClient.authorizedPatch(uri, patch, backupResourceMutationOptions({
          ifMatch: 'cached', criteria: { relation: 'conversation' },
        }));
      }, function (error) {
        if (!resourceNotFound(error)) throw error;
        return resourceClient.authorizedPost('/conversations', body, backupResourceMutationOptions({
          criteria: { relation: 'conversations' },
        }));
      }).then(function (envelope) {
        return desiredArchived ? archiveImportedConversation(uri) : envelope;
      });
    }

    function applyConversationsBackupImport(pkg, plan, preflight) {
      if (!hasOwn(plan, 'conversations') || !pkg.modules.conversations) return Promise.resolve('');
      var module = pkg.modules.conversations;
      var items = backupModuleItemsObject(module);
      var ids = selectedBackupIds(module, plan.conversations);
      var failures = [];
      var succeeded = 0;
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          return importConversationResource(id, items[id], preflight).then(function () { succeeded += 1; }).catch(function (error) {
            failures.push({ id: id, error: errorText(error) });
          });
        });
      });
      return chain.then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('conversation-import-partial', '对话导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? '对话' : '';
      });
    }

    function knowledgeSettingsImportPatch(settings) {
      settings = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
      var patch = dictionary();
      ['enabled', 'autoCapture'].forEach(function (key) {
        if (hasOwn(settings, key)) setOwn(patch, key, safeClone(settings[key]));
      });
      return patch;
    }

    function knowledgeItemImportBody(id, item) {
      var body = safeClone(item || {});
      body.id = String(id || body.id || '').trim();
      if (!body.id) throw new Error('知识条目缺少 ID');
      if (!knowledgeItemIsExportable(body)) throw new Error('扩展内置知识不能导入');
      var source = body.source && typeof body.source === 'object' && !Array.isArray(body.source)
        ? safeClone(body.source)
        : dictionary();
      var kind = String(body.sourceKind || source.kind || '').trim();
      source.kind = kind || 'auto';
      if (kind === 'mcp') {
        body.remoteSync = true;
        source.remoteSync = true;
        source.managed = 'remote';
      } else if (kind === 'skill') {
        body.remoteSync = true;
        body.skillImport = true;
        source.remoteSync = true;
        source.managed = 'remote';
        if (!source.importer) source.importer = 'skill-knowledge';
      }
      body.sourceKind = source.kind;
      body.source = source;
      return body;
    }

    function importKnowledgeSettings(settings) {
      var patch = knowledgeSettingsImportPatch(settings);
      if (!Object.keys(patch).length) return Promise.resolve(null);
      return resourceClient.get('/knowledge-settings').then(function () {
        return resourceClient.authorizedPatch('/knowledge-settings', patch, backupResourceMutationOptions({
          ifMatch: 'cached',
          criteria: { relation: 'knowledge-settings' },
        }));
      });
    }

    function importKnowledgeItem(id, item) {
      var body = knowledgeItemImportBody(id, item);
      var uri = '/knowledge/' + resourceSegment(body.id);
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedPut(uri, body, backupResourceMutationOptions({
          ifMatch: 'cached',
          criteria: { relation: 'knowledge-item' },
        }));
      }, function (error) {
        if (!(error && (error.code === 'RESOURCE_NOT_FOUND' || Number(error.status) === 404))) throw error;
        return resourceClient.authorizedPost('/knowledge', body, backupResourceMutationOptions({
          criteria: { relation: 'knowledge' },
        }));
      });
    }

    function knowledgeImportFailureText(error) {
      var code = error && error.code ? '[' + error.code + '] ' : '';
      return code + errorText(error);
    }

    function applyKnowledgeBackupImport(pkg, plan) {
      if (!hasOwn(plan, 'knowledge') || !pkg.modules.knowledge) return Promise.resolve('');
      var module = pkg.modules.knowledge;
      var selected = plan.knowledge;
      var selectedMap = dictionary();
      (selected || []).forEach(function (id) { setOwn(selectedMap, id, true); });
      var importAll = !selected;
      var items = backupModuleItemsObject(module);
      var ids = selectedBackupIds(module, selected).filter(function (id) {
        return id !== '__settings__' && knowledgeItemIsExportable(items[id]);
      });
      var failures = [];
      var succeeded = 0;
      var chain = Promise.resolve();

      function attempt(id, operation) {
        chain = chain.then(function () {
          return Promise.resolve().then(operation).then(function () {
            succeeded += 1;
          }).catch(function (error) {
            failures.push({ id: id, error: knowledgeImportFailureText(error) });
          });
        });
      }

      if ((importAll || hasOwn(selectedMap, '__settings__')) && module.settings && typeof module.settings === 'object') {
        attempt('__settings__', function () { return importKnowledgeSettings(module.settings); });
      }
      ids.forEach(function (id) {
        attempt(id, function () { return importKnowledgeItem(id, items[id]); });
      });
      return chain.then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('knowledge-import-partial', '知识导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? '知识' : '';
      });
    }

    function importSkillResource(id, item) {
      item = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      var body = dictionary();
      ['id', 'name', 'description', 'instructions', 'version', 'source', 'resources', 'tags', 'enabled', 'archived']
        .forEach(function (key) {
          if (hasOwn(item, key)) setOwn(body, key, safeClone(item[key]));
        });
      body.id = String(body.id || id);
      var uri = '/skills/' + resourceSegment(body.id);
      return resourceClient.get(uri).then(function () {
        var patch = safeClone(body);
        delete patch.id;
        return resourceClient.authorizedPatch(uri, patch, backupResourceMutationOptions({
          ifMatch: 'cached', criteria: { relation: 'skill' },
        }));
      }, function (error) {
        if (!resourceNotFound(error)) throw error;
        return resourceClient.authorizedPost('/skills', body, backupResourceMutationOptions({
          criteria: { relation: 'skills' },
        }));
      });
    }

    function applySkillsBackupImport(pkg, plan) {
      if (!hasOwn(plan, 'skills') || !pkg.modules.skills) return Promise.resolve('');
      var module = pkg.modules.skills;
      var items = backupModuleItemsObject(module);
      var ids = selectedBackupIds(module, plan.skills).filter(function (id) { return skillIsExportable(items[id]); });
      var failures = [];
      var succeeded = 0;
      return ids.reduce(function (chain, id) {
        return chain.then(function () {
          return importSkillResource(id, items[id]).then(function () { succeeded += 1; }).catch(function (error) {
            failures.push({ id: id, error: errorText(error) });
          });
        });
      }, Promise.resolve()).then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('skills-import-partial', 'Skill 导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? backupModuleLabel('skills') : '';
      });
    }

    function importMcpServerResource(id, item) {
      item = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      var body = dictionary();
      ['id', 'name', 'url', 'enabled', 'bearerToken', 'headersText', 'timeoutMs', 'protocolVersion']
        .forEach(function (key) {
          if (hasOwn(item, key)) setOwn(body, key, safeClone(item[key]));
        });
      body.id = String(body.id || id);
      var uri = '/mcp-servers/' + resourceSegment(body.id);
      return resourceClient.get(uri).then(function () {
        var patch = safeClone(body);
        delete patch.id;
        return resourceClient.authorizedPatch(uri, patch, backupResourceMutationOptions({
          ifMatch: 'cached', criteria: { relation: 'mcp-server' },
        }));
      }, function (error) {
        if (!resourceNotFound(error)) throw error;
        return resourceClient.authorizedPost('/mcp-servers', body, backupResourceMutationOptions({
          criteria: { relation: 'mcp-servers' },
        }));
      });
    }

    function applyMcpServersBackupImport(pkg, plan) {
      if (!hasOwn(plan, 'mcpServers') || !pkg.modules.mcpServers) return Promise.resolve('');
      var module = pkg.modules.mcpServers;
      var items = backupModuleItemsObject(module);
      var ids = selectedBackupIds(module, plan.mcpServers);
      var failures = [];
      var succeeded = 0;
      return ids.reduce(function (chain, id) {
        return chain.then(function () {
          return importMcpServerResource(id, items[id]).then(function () { succeeded += 1; }).catch(function (error) {
            failures.push({ id: id, error: errorText(error) });
          });
        });
      }, Promise.resolve()).then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('mcp-servers-import-partial', backupModuleLabel('mcpServers') + '导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? backupModuleLabel('mcpServers') : '';
      });
    }

    function applyMcpSettingsBackupImport(pkg, plan) {
      if (!hasOwn(plan, 'mcpSettings') || !pkg.modules.mcpSettings) return Promise.resolve('');
      var module = pkg.modules.mcpSettings;
      var items = backupModuleItemsObject(module);
      var ids = selectedBackupIds(module, plan.mcpSettings);
      var failures = [];
      var succeeded = 0;
      return readResourceCollection('/connections').then(function (currentItems) {
        var current = dictionary();
        currentItems.forEach(function (item) {
          var id = String(item && item.id || '').trim();
          if (id) setOwn(current, id, item);
        });
        return ids.reduce(function (chain, id) {
          return chain.then(function () {
            var backupItem = items[id];
            if (!backupItem || !hasOwn(current, id)) {
              failures.push({ id: id, error: '当前扩展缺少备份所需的 MCP Connection' });
              return;
            }
            var patch = dictionary();
            ['enabled', 'url', 'clientName', 'runTabMode'].forEach(function (key) {
              if (hasOwn(backupItem, key)) setOwn(patch, key, safeClone(backupItem[key]));
            });
            if (!Object.keys(patch).length) {
              failures.push({ id: id, error: '备份不包含任何受支持的 MCP Connection 配置字段' });
              return;
            }
            var uri = '/connections/' + resourceSegment(id);
            return resourceClient.get(uri).then(function () {
              return resourceClient.authorizedPatch(uri, patch, backupResourceMutationOptions({
                ifMatch: 'cached', criteria: { relation: 'connection' },
              }));
            }).then(function () { succeeded += 1; }).catch(function (error) {
              failures.push({ id: id, error: errorText(error) });
            });
          });
        }, Promise.resolve());
      }).catch(function (error) {
        failures.push({ id: 'connections:list', error: errorText(error) });
      }).then(function () {
        if (failures.length) {
          var details = failures.map(function (failure) { return failure.id + ': ' + failure.error; }).join('；');
          var error = backupError('mcp-settings-import-partial', backupModuleLabel('mcpSettings') + '导入失败项 (' + failures.length + '): ' + details);
          error.failures = failures;
          error.succeeded = succeeded;
          throw error;
        }
        return succeeded ? backupModuleLabel('mcpSettings') : '';
      });
    }

    function importedModelSettingsFocusServiceId(pkg, plan) {
      if (!hasOwn(plan, 'modelSettings') || !pkg.modules.modelSettings) return '';
      var selected = plan.modelSettings || [];
      for (var i = 0; i < selected.length; i++) {
        var id = String(selected[i] || '');
        if (id.indexOf('service:') === 0) return id.slice('service:'.length);
      }
      return '';
    }

    function refreshAfterBackupImport(pkg, plan) {
      if (destroyed) return;
      var touchedConfig = CONFIG_BACKUP_SECTIONS.some(function (def) { return hasOwn(plan, def.id); });
      if (touchedConfig) {
        setFlowDirty(false);
        loadConfig();
      } else {
        renderCurrentSection();
      }
      if ((hasOwn(plan, 'assistants') || hasOwn(plan, 'conversations')) && globalThis.Conversation && globalThis.Conversation.refresh) {
          globalThis.Conversation.refresh();
      }
      if ((hasOwn(plan, 'knowledge') || hasOwn(plan, 'skills') || hasOwn(plan, 'mcpServers'))
          && getCurrentSection() === 'knowledge' && globalThis.OptionsKnowledgePanel && globalThis.OptionsKnowledgePanel.render) {
          globalThis.OptionsKnowledgePanel.render();
      }
      if (hasOwn(plan, 'modelSettings') && globalThis.OptionsModelSettingsPanel && globalThis.OptionsModelSettingsPanel.reload) {
        globalThis.OptionsModelSettingsPanel.reload({ serviceId: importedModelSettingsFocusServiceId(pkg, plan) });
      }
      if ((hasOwn(plan, 'mcpSettings') || hasOwn(plan, 'mcpServers')) && getCurrentSection() === 'mcp') renderMCP();
    }

    function buildImportSteps(preflight) {
      var pkg = preflight.package;
      var plan = preflight.plan;
      var steps = [];
      function add(id, run) { steps.push({ id: id, run: run }); }
      if (hasOwn(plan, 'modelSettings')) {
        add('modelSettings', function () { return applyModelSettingsBackupImport(pkg, plan); });
      }
      if (hasOwn(plan, 'assistants')) {
        add('assistants', function () { return applyAssistantsBackupImport(pkg, plan, preflight); });
      }
      if (selectedConfigSections(pkg, plan).length) {
        add('config', function () { return applyConfigBackupImport(pkg, plan, preflight); });
      }
      if (hasOwn(plan, 'conversations')) {
        add('conversations', function () { return applyConversationsBackupImport(pkg, plan, preflight); });
      }
      if (hasOwn(plan, 'knowledge')) {
        add('knowledge', function () { return applyKnowledgeBackupImport(pkg, plan); });
      }
      if (hasOwn(plan, 'skills')) {
        add('skills', function () { return applySkillsBackupImport(pkg, plan); });
      }
      if (hasOwn(plan, 'mcpServers')) {
        add('mcpServers', function () { return applyMcpServersBackupImport(pkg, plan); });
      }
      if (hasOwn(plan, 'mcpSettings')) {
        add('mcpSettings', function () { return applyMcpSettingsBackupImport(pkg, plan); });
      }
      return steps;
    }

    function retryData(preflight) {
      return {
        package: plainClone(preflight.package),
        plan: plainClone(preflight.plan),
        mode: preflight.importMode,
      };
    }

    function executeImport(preflight) {
      var steps = buildImportSteps(preflight);
      var completed = [];
      var summary = [];
      var failures = [];
      var index = 0;

      function runNext() {
        if (destroyed) {
          return Promise.resolve({
            ok: false,
            partial: completed.length > 0,
            completed: completed.slice(),
            failedStep: index < steps.length ? steps[index].id : null,
            retry: retryData(preflight),
            destroyed: true,
            error: '备份控制器已销毁',
          });
        }
        if (index >= steps.length) {
          var ok = failures.length === 0;
          return Promise.resolve({
            ok: ok,
            partial: !ok && completed.length > 0,
            completed: completed.slice(),
            failedStep: ok ? null : failures[0].step,
            failedSteps: failures.map(function (failure) { return failure.step; }),
            failures: failures.slice(),
            error: ok ? '' : failures.map(function (failure) { return failure.step + ': ' + failure.error; }).join('；'),
            retry: ok ? null : retryData(preflight),
            summary: summary.slice(),
          });
        }
        var step = steps[index];
        return Promise.resolve().then(step.run).then(function (label) {
          completed.push(step.id);
          if (label) summary.push(label);
          index++;
          return runNext();
        }).catch(function (error) {
          failures.push({ step: step.id, error: errorText(error), items: error && error.failures || [] });
          index++;
          return runNext();
        });
      }

      return runNext();
    }

    function importPackage(raw, rawPlan, rawMode) {
      if (importInFlight) return importInFlight;
      var operation = Promise.resolve().then(function () {
        return preflightImport(raw, rawPlan, rawMode);
      }).then(executeImport).catch(function (error) {
        return {
          ok: false,
          partial: false,
          completed: [],
          failedStep: 'preflight',
          retry: null,
          destroyed: !!(error && error.code === 'destroyed'),
          error: errorText(error),
        };
      });
      importInFlight = operation;
      operation.then(function (result) {
        lastImportResult = result;
        if (importInFlight === operation) importInFlight = null;
      }, function (error) {
        lastImportResult = { ok: false, partial: false, completed: [], failedStep: 'preflight', retry: null, error: errorText(error) };
        if (importInFlight === operation) importInFlight = null;
      });
      return operation;
    }

    function importSelectedBackup() {
      if (importUiInFlight) return importUiInFlight;
      if (!pendingBackupImport || !pendingBackupImport.package) {
        if (!destroyed) toast('请先选择备份文件', true);
        return Promise.resolve({ ok: false, partial: false, completed: [], failedStep: 'selection', retry: null, error: '请先选择备份文件' });
      }
      var pkg = pendingBackupImport.package;
      var plan = collectImportBackupPlan();
      var importMode = selectedImportMode();
      var moduleIds = Object.keys(plan);
      if (!moduleIds.length) {
        if (!destroyed) toast('请选择至少一个模块或明细', true);
        return Promise.resolve({ ok: false, partial: false, completed: [], failedStep: 'selection', retry: null, error: '请选择至少一个模块或明细' });
      }
      if (!confirm(importMode === 'replace'
          ? '替换模式会先删除现有的所选 Flow/FlowGroup 集合，再导入备份条目。确定继续？'
          : '导入将写入所选数据，并覆盖相同 ID/key 的现有数据。未勾选数据会保留。确定继续？')) {
        return Promise.resolve({ ok: false, canceled: true, partial: false, completed: [], failedStep: null, retry: null, error: '用户取消导入' });
      }
      var operation = importPackage(pkg, plan, importMode).then(function (result) {
        if (destroyed || result.destroyed) return result;
        if (result.ok) {
          closeDrawer();
          pendingBackupImport = null;
          refreshAfterBackupImport(pkg, plan);
          toast('备份导入完成: ' + (result.summary.join('、') || '所选数据'));
          return result;
        }
        if (result.retry) pendingBackupImport = { package: result.retry.package };
        var partialText = result.partial && result.completed.length
          ? '（已完成: ' + result.completed.join('、') + '；可重试同一备份）'
          : '';
        toast('导入失败' + partialText + ': ' + result.error, true);
        return result;
      });
      importUiInFlight = operation;
      operation.then(function () {
        if (importUiInFlight === operation) importUiInFlight = null;
      }, function () {
        if (importUiInFlight === operation) importUiInFlight = null;
      });
      return operation;
    }

    function readJsonFile(file, onDone) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true, error: '备份控制器已销毁' });
      var fileSize = Number(file && file.size);
      if (Number.isFinite(fileSize) && fileSize > maxBackupBytes) {
        var sizeError = '文件过大 (' + fileSize + ' bytes)，最大允许 ' + maxBackupBytes + ' bytes';
        toast(sizeError, true);
        return Promise.resolve({ ok: false, error: sizeError, code: 'backup-too-large' });
      }
      if (typeof FileReader !== 'function') {
        var unavailable = '当前环境不支持读取文件';
        toast(unavailable, true);
        return Promise.resolve({ ok: false, error: unavailable, code: 'file-reader-unavailable' });
      }
      return new Promise(function (resolve) {
        var reader;
        var settled = false;
        var entry;

        function removeEntry() {
          var index = activeFileReads.indexOf(entry);
          if (index !== -1) activeFileReads.splice(index, 1);
        }

        function finish(result) {
          if (settled) return;
          settled = true;
          removeEntry();
          resolve(result);
        }

        function fail(message, code) {
          if (destroyed) {
            finish({ ok: false, destroyed: true, error: '备份控制器已销毁' });
            return;
          }
          toast(message, true);
          finish({ ok: false, error: message, code: code || 'file-read-failed' });
        }

        entry = {
          destroy: function () {
            finish({ ok: false, destroyed: true, error: '备份控制器已销毁' });
          },
        };
        activeFileReads.push(entry);
        try {
          reader = new FileReader();
        } catch (error) {
          fail('无法创建文件读取器: ' + errorText(error), 'file-reader-unavailable');
          return;
        }
        reader.onload = function () {
          if (settled) return;
          if (destroyed) {
            finish({ ok: false, destroyed: true, error: '备份控制器已销毁' });
            return;
          }
          var text = String(reader.result === undefined || reader.result === null ? '' : reader.result);
          try {
            assertBackupSize(text, '文件内容');
          } catch (error) {
            fail(errorText(error), error.code);
            return;
          }
          var parsed;
          try {
            parsed = JSON.parse(text);
          } catch (_) {
            fail('文件不是合法的 JSON', 'invalid-json');
            return;
          }
          try {
            var callbackResult = typeof onDone === 'function' ? onDone(parsed) : undefined;
            Promise.resolve(callbackResult).then(function (handlerResult) {
              if (settled) return;
              if (destroyed) {
                finish({ ok: false, destroyed: true, error: '备份控制器已销毁' });
                return;
              }
              if (handlerResult && handlerResult.ok === false) finish(handlerResult);
              else finish({ ok: true, value: parsed, handlerResult: handlerResult });
            }, function (error) {
              fail('处理 JSON 文件失败: ' + errorText(error), 'json-handler-failed');
            });
          } catch (error) {
            fail('处理 JSON 文件失败: ' + errorText(error), 'json-handler-failed');
          }
        };
        reader.onerror = function () {
          fail('读取文件失败: ' + errorText(reader.error || '未知读取错误'), 'file-read-failed');
        };
        reader.onabort = function () {
          if (destroyed) finish({ ok: false, destroyed: true, error: '备份控制器已销毁' });
          else fail('文件读取已取消', 'file-read-aborted');
        };
        try {
          reader.readAsText(file);
        } catch (error) {
          fail('读取文件失败: ' + errorText(error), 'file-read-failed');
        }
      });
    }


    function handleAction(action, event) {
      if (action === 'select-all-export-backup' || action === 'clear-export-backup') {
        if (event) event.stopPropagation();
        var exportChecked = action === 'select-all-export-backup';
        $all('#backup-export-list input[data-export-backup-module]').forEach(function (input) {
          if (!input.disabled) input.checked = exportChecked;
        });
        return true;
      }
      if (action === 'confirm-export-backup') {
        if (event) event.stopPropagation();
        exportSelectedBackup();
        return true;
      }
      if (action === 'select-all-import-backup' || action === 'clear-import-backup') {
        if (event) event.stopPropagation();
        var importChecked = action === 'select-all-import-backup';
        $all('#backup-import-list input[type="checkbox"]').forEach(function (input) {
          if (!input.disabled) input.checked = importChecked;
        });
        updateAllImportBackupModuleCheckboxes();
        return true;
      }
      if (action === 'confirm-import-backup') {
        if (event) event.stopPropagation();
        importSelectedBackup();
        return true;
      }
      return false;
    }

    function init() {
      if (initialized || destroyed) return;
      initialized = true;
      lifecycle.listen(document, 'change', handleImportBackupCheckboxChange);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pendingBackupExport = null;
      pendingBackupImport = null;
      activeFileReads.slice().forEach(function (entry) { entry.destroy(); });
      lifecycle.destroy();
    }

    return {
      init: init,
      destroy: destroy,
      handleAction: handleAction,
      openExportBackupDrawer: openExportBackupDrawer,
      openImportBackupFromRaw: openImportBackupFromRaw,
      exportSelectedBackup: exportSelectedBackup,
      importPackage: importPackage,
      importSelectedBackup: importSelectedBackup,
      readJsonFile: readJsonFile,
      renderImportBackupDrawer: renderImportBackupDrawer,
      normalizeBackupPackage: normalizeBackupPackage,
      createBackupPackage: createBackupPackage,
      buildBackupModules: buildBackupModules,
      downloadFile: downloadFile,
      isDestroyed: function () { return destroyed; },
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          importing: !!importInFlight,
          importUiPending: !!importUiInFlight,
          lastImportResult: lastImportResult ? plainClone(lastImportResult) : null,
        };
      },
    };
  }

  return { create: create };
});
