// Canonical Model Service and Agent Settings options panel.
(function attachOptionsModelSettingsPanel(root, factory) {
  root.OptionsModelSettingsPanel = factory(root);
})(globalThis, function (root) {
  'use strict';

  var MODEL_COLLECTION_URI = '/model-services';
  var AGENT_SETTINGS_URI = '/agent-settings';
  var PROTOCOLS = Object.freeze({
    chat_completions: 'OpenAI Chat Completions',
    responses: 'OpenAI Responses',
    anthropic: 'Claude Anthropic Messages',
  });
  var REASONING_EFFORTS = Object.freeze({
    auto: true, none: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
  });
  var SERVICE_TIERS = Object.freeze({ auto: true, priority: true });
  var CONTEXT_COMPRESSION = Object.freeze({ auto: true, off: true });
  var TOKENS_PER_K = 1000;
  var activePanel = null;

  function reload(options) {
    if (!activePanel) return Promise.reject(new Error('OptionsModelSettingsPanel 尚未初始化'));
    return activePanel.reload(options);
  }

  function getState() {
    return activePanel ? activePanel.getState() : null;
  }

  function discard() {
    if (activePanel) activePanel.discard();
  }

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function segment(value) {
    return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function envelopeData(envelope, label) {
    var data = envelope && envelope.primary && envelope.primary.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error((label || '资源') + '返回了无效数据');
    }
    return clone(data);
  }

  function strictValue(value, allowed, label) {
    value = text(value);
    if (!allowed[value]) throw new Error((label || '值') + '不受支持: ' + (value || '空'));
    return value;
  }

  function init(deps) {
    deps = deps || {};
    var $ = deps.$ || function (selector) { return document.querySelector(selector); };
    var esc = deps.esc || function (value) { return String(value == null ? '' : value); };
    var toast = deps.toast || function () {};
    var scrollOpenedEditor = deps.scrollOpenedEditor || function () {};
    var resourceClient = deps.resourceClient;
    if (!resourceClient || typeof resourceClient.get !== 'function'
        || typeof resourceClient.authorizedPost !== 'function'
        || typeof resourceClient.authorizedPatch !== 'function'
        || typeof resourceClient.authorizedDelete !== 'function') {
      throw new Error('OptionsModelSettingsPanel requires PageAgentResourceClient');
    }

    var modelServices = [];
    var agentSettings = null;
    var modelEditingServiceId = '';
    var modelEditorOpen = false;
    var modelEditorDirty = false;
    var modelContextBaseline = '';
    var draftService = null;
    var loading = false;
    var loadError = '';
    var mutating = false;
    var pendingReload = false;
    var loadRevision = 0;
    var modelTestRevision = 0;
    var modelTestTimer = 0;
    var maxContextTokens = Math.max(
      0,
      Number(root.ModelSettings && root.ModelSettings.MAX_CONTEXT_TOKENS_LIMIT)
        || Number(root.ModelSettings && root.ModelSettings.DEFAULT_MAX_CONTEXT_TOKENS)
        || 1000000
    );
    var maxContextTokensInputK = maxContextTokens / TOKENS_PER_K;
    var maxRetriesDefault = Math.max(0, Number(root.ModelSettings && root.ModelSettings.DEFAULT_MAX_RETRIES) || 15);
    var maxRetriesLimit = Math.max(maxRetriesDefault, Number(root.ModelSettings && root.ModelSettings.MAX_RETRIES_LIMIT) || 50);

    function itemUri(serviceId) {
      return MODEL_COLLECTION_URI + '/' + segment(serviceId);
    }

    function mutationOptions(relation, extra) {
      return Object.assign({
        criteria: { relation: relation },
      }, extra || {});
    }

    function errorText(error) {
      var code = error && error.code ? '[' + error.code + '] ' : '';
      return code + String(error && error.message || error || '资源请求失败');
    }

    function retireModelTest() {
      modelTestRevision += 1;
      return modelTestRevision;
    }

    function findService(serviceId) {
      serviceId = text(serviceId);
      for (var index = 0; index < modelServices.length; index += 1) {
        if (modelServices[index] && modelServices[index].id === serviceId) return modelServices[index];
      }
      return null;
    }

    function currentService() {
      if (draftService) return draftService;
      var service = findService(modelEditingServiceId);
      if (!service) {
        service = modelServices[0] || null;
        modelEditingServiceId = service && service.id || '';
      }
      return service;
    }

    function replaceService(service) {
      if (!service || !service.id) return;
      var found = false;
      modelServices = modelServices.map(function (item) {
        if (!item || item.id !== service.id) return item;
        found = true;
        return clone(service);
      });
      if (!found) modelServices.push(clone(service));
    }

    function displayName(service) {
      return text(service && service.name) || text(service && service.model) || text(service && service.baseUrl) || '未命名服务';
    }

    function renderServiceList() {
      var list = $('#model-services-list');
      var focusedCard = document.activeElement.closest('.model-service-card');
      var focusedId = focusedCard && list.contains(focusedCard) ? focusedCard.dataset.id : '';
      var focusedCopy = document.activeElement.matches('[data-action="copy-id"]');
      var defaultServiceId = text(agentSettings && agentSettings.defaultModelServiceId);
      list.innerHTML = modelServices.map(function (service) {
        var expanded = modelEditorOpen && service.id === modelEditingServiceId;
        var configured = !!(text(service.baseUrl) && text(service.model));
        var description = (PROTOCOLS[service.protocol] || service.protocol || '未选择协议')
          + ' · ' + (service.model || '未设置模型') + ' · ' + (service.baseUrl || '未设置地址');
        return '<div role="button" tabindex="0" class="item-card connection-card model-service-card' + (expanded ? ' selected' : '')
          + '" data-id="' + esc(service.id) + '" aria-expanded="' + expanded + '" aria-controls="model-service-editor"'
          + (loading || mutating ? ' aria-disabled="true"' : '') + '>'
          + '<span class="connection-summary"><span class="item-title" title="' + esc(displayName(service)) + '">' + esc(displayName(service)) + '</span>'
          + '<span class="item-sub" title="' + esc(description) + '">' + esc(description) + '</span>'
          + deps.itemIdHtml(service.id) + '</span>'
          + (service.id === defaultServiceId ? '<span class="badge">全局默认</span>' : '')
          + '<span class="badge' + (configured ? ' on' : '') + '">' + (configured ? '已配置' : '待配置') + '</span>'
          + '</div>';
      }).join('') || (modelEditorOpen && !loading && !loadError ? ''
        : '<div class="placeholder">' + esc(loading ? '正在加载模型服务…' : loadError || '还没有模型服务，点击「新增服务」配置') + '</div>');
      if (focusedId) {
        var focused = Array.from(list.children).find(function (item) { return item.dataset.id === focusedId; });
        if (focused) (focusedCopy ? focused.querySelector('.item-id') : focused).focus({ preventScroll: true });
      }
    }

    function setEditorOpen(open) {
      var editor = $('#model-service-editor');
      var restoreFocus = editor.contains(document.activeElement);
      modelEditorOpen = open && !!currentService();
      editor.classList.toggle('hidden', !modelEditorOpen);
      renderServiceList();
      if (modelEditorOpen) scrollOpenedEditor(editor);
      else if (restoreFocus) {
        var card = Array.from($('#model-services-list').children).find(function (item) {
          return item.dataset.id === modelEditingServiceId;
        }) || $('#btn-model-add-service');
        card.focus({ preventScroll: true });
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    async function confirmEditorChange() {
      if (loading || mutating) return false;
      return !modelEditorDirty || await deps.confirm('有未保存的修改，是否放弃？');
    }

    function readAllModelServices() {
      var items = [];
      var seen = Object.create(null);
      function read(cursor) {
        var query = { limit: 100 };
        if (cursor) query.cursor = cursor;
        return resourceClient.get(MODEL_COLLECTION_URI, { query: query }).then(function (envelope) {
          var data = envelopeData(envelope, '模型服务列表');
          if (Array.isArray(data.items)) items = items.concat(data.items.map(clone));
          var nextCursor = text(data.nextCursor);
          if (!nextCursor || seen[nextCursor]) return items;
          seen[nextCursor] = true;
          return read(nextCursor);
        });
      }
      return read('');
    }

    function readAgentSettings() {
      return resourceClient.get(AGENT_SETTINGS_URI).then(function (envelope) {
        return envelopeData(envelope, 'Agent Settings');
      });
    }

    function parseMaxContextTokensInput(value) {
      var kiloTokens = Number(value);
      if (!isFinite(kiloTokens) || kiloTokens < 0) throw new Error('最大上下文 Token 必须是非负数字');
      return Math.min(maxContextTokens, Math.floor(kiloTokens * TOKENS_PER_K));
    }

    function renderMaxContextTokens(value) {
      var tokens = Math.max(0, Math.min(maxContextTokens, Math.floor(Number(value) || 0)));
      return String(Number((tokens / TOKENS_PER_K).toFixed(3)));
    }

    function parseAutoCompactTokenLimitInput(value, contextTokens) {
      var percent = Math.floor(Number(value));
      if (!isFinite(percent) || percent < 50 || percent > 90) throw new Error('自动压缩阈值必须在 50-90 之间');
      if (percent >= 90) return 0;
      return contextTokens ? Math.floor(contextTokens * percent / 100) : 0;
    }

    function renderAutoCompactTokenLimit(value, contextTokens) {
      value = Math.max(0, Math.floor(Number(value) || 0));
      if (!value || !contextTokens) return '90';
      return String(Math.max(50, Math.min(90, Math.round(value * 100 / contextTokens))));
    }

    function contextPatchFromControls() {
      var contextTokens = parseMaxContextTokensInput($('#model-max-context-tokens').value);
      return {
        contextBudget: {
          maxContextTokens: contextTokens,
          autoCompactTokenLimit: parseAutoCompactTokenLimitInput(
            $('#model-auto-compact-token-limit').value,
            contextTokens
          ),
        },
        contextCompression: strictValue(
          $('#model-context-compression').value,
          CONTEXT_COMPRESSION,
          '会话压缩模式'
        ),
      };
    }

    function contextSignature() {
      return JSON.stringify(['#model-max-context-tokens', '#model-auto-compact-token-limit', '#model-context-compression'].map(function (selector) {
        return $(selector).value;
      }));
    }

    function parseMaxRetriesInput(value) {
      if (text(value) === '') return maxRetriesDefault;
      var retries = Math.floor(Number(value));
      if (!isFinite(retries) || retries < 0 || retries > maxRetriesLimit) {
        throw new Error('请求重试次数必须在 0-' + maxRetriesLimit + ' 之间');
      }
      return retries;
    }

    function servicePatchFromControls() {
      var patch = {
        name: text($('#model-service-name').value),
        baseUrl: text($('#model-base-url').value),
        protocol: strictValue($('#model-protocol').value, PROTOCOLS, '协议'),
        userAgent: text($('#model-user-agent').value),
        model: text($('#model-name').value),
        visionModel: text($('#model-vision-model').value),
        summaryModel: text($('#model-summary-model').value),
        reasoningEffort: strictValue($('#model-reasoning-effort').value, REASONING_EFFORTS, '思考级别'),
        serviceTier: strictValue($('#model-service-tier').value, SERVICE_TIERS, '服务等级'),
        maxRetries: parseMaxRetriesInput($('#model-max-retries').value),
      };
      if (!patch.name) throw new Error('服务名称不能为空');
      var apiKey = String($('#model-api-key').value || '');
      if (apiKey) patch.secret = { apiKey: apiKey };
      return patch;
    }

    function setControlsDisabled(hasService) {
      [
        '#model-protocol', '#model-service-name', '#model-base-url', '#model-api-key',
        '#model-user-agent', '#model-name', '#model-vision-model', '#model-summary-model',
        '#model-reasoning-effort', '#model-max-retries',
      ].forEach(function (selector) {
        var element = $(selector);
        if (element) element.disabled = loading || mutating || !hasService;
      });
      var reasoningControl = $('#model-reasoning-effort');
      if (reasoningControl) {
        reasoningControl.disabled = loading || mutating || !hasService;
      }
      $('#model-service-tier').disabled = loading || mutating || !hasService || $('#model-protocol').value === 'anthropic';
      ['#model-max-context-tokens', '#model-auto-compact-token-limit', '#model-context-compression'].forEach(function (selector) {
        var element = $(selector);
        if (element) element.disabled = loading || mutating || !agentSettings;
      });
      Array.from($('#model-services-list').children).forEach(function (card) {
        if (card.classList.contains('model-service-card')) card.setAttribute('aria-disabled', String(loading || mutating));
      });
      var addButton = $('#btn-model-add-service');
      if (addButton) addButton.disabled = loading || mutating;
      ['#btn-model-copy-service', '#btn-model-delete-service', '#btn-model-save', '#btn-model-test', '#btn-model-set-default']
        .forEach(function (selector) {
          var element = $(selector);
          if (element) element.disabled = loading || mutating || !hasService;
        });
      ['#btn-model-copy-service', '#btn-model-delete-service', '#btn-model-set-default'].forEach(function (selector) {
        if (draftService) $(selector).disabled = true;
      });
      $('#btn-model-cancel').disabled = loading || mutating;
      var clearButton = $('#btn-model-clear-key');
      var service = currentService();
      var defaultButton = $('#btn-model-set-default');
      if (defaultButton && service && agentSettings && service.id === agentSettings.defaultModelServiceId) {
        defaultButton.disabled = true;
      }
      if (clearButton) {
        clearButton.disabled = loading || mutating || !hasService
          || !(service.credentialMetadata && service.credentialMetadata.apiKeyConfigured === true);
      }
    }

    function renderCredentialStatus() {
      var service = currentService() || {};
      var hasSecret = (service.credentialMetadata || {}).hasSecret === true;
      $('#model-api-key').placeholder = hasSecret ? '已配置；留空保持不变' : '输入 API Key';
      $('#model-api-key-help').textContent = hasSecret ? '密钥已配置' : '尚未配置密钥';
    }

    function render() {
      var defaultServiceId = text(agentSettings && agentSettings.defaultModelServiceId);
      if (!draftService && !findService(modelEditingServiceId)) {
        modelEditingServiceId = findService(defaultServiceId)
          ? defaultServiceId
          : (modelServices[0] && modelServices[0].id || '');
      }
      var service = currentService() || {};
      var hasService = !!(draftService || service.id);
      $('#model-editor-title').textContent = draftService ? '新建模型服务' : '编辑模型服务';
      $('#model-service-name').value = service.name || '';
      $('#model-base-url').value = service.baseUrl || '';
      $('#model-user-agent').value = service.userAgent || '';
      $('#model-name').value = service.model || '';
      $('#model-vision-model').value = service.visionModel || '';
      $('#model-summary-model').value = service.summaryModel || '';
      $('#model-reasoning-effort').value = REASONING_EFFORTS[service.reasoningEffort] ? service.reasoningEffort : '';
      $('#model-service-tier').value = SERVICE_TIERS[service.serviceTier] ? service.serviceTier : 'auto';
      $('#model-max-retries').value = service.maxRetries === undefined || service.maxRetries === null
        ? '' : String(Math.max(0, Math.floor(Number(service.maxRetries) || 0)));
      $('#model-protocol').value = PROTOCOLS[service.protocol] ? service.protocol : 'chat_completions';

      $('#model-api-key').value = '';
      renderCredentialStatus();

      var budget = agentSettings && agentSettings.contextBudget || {};
      var contextTokens = Math.max(0, Number(budget.maxContextTokens) || 0);
      $('#model-max-context-tokens').max = String(maxContextTokensInputK);
      $('#model-max-context-tokens').value = renderMaxContextTokens(contextTokens);
      $('#model-auto-compact-token-limit').value = renderAutoCompactTokenLimit(
        budget.autoCompactTokenLimit,
        contextTokens
      );
      $('#model-context-compression').value = CONTEXT_COMPRESSION[agentSettings && agentSettings.contextCompression]
        ? agentSettings.contextCompression
        : '';

      modelEditorDirty = false;
      modelContextBaseline = contextSignature();
      modelEditorOpen = modelEditorOpen && hasService;
      $('#model-service-editor').classList.toggle('hidden', !modelEditorOpen);
      renderServiceList();
      setControlsDisabled(hasService);
      refreshPendingModelSettings();
    }

    function refreshPendingModelSettings() {
      if (!pendingReload || loading || mutating || deps.lifecycle.isDestroyed()
          || modelEditorOpen && (modelEditorDirty || draftService)) return;
      loadModelSettings().catch(function () {});
    }

    function loadModelSettings(options) {
      options = options || {};
      if (mutating || modelEditorOpen && (modelEditorDirty || draftService)) {
        pendingReload = true;
        return Promise.resolve(null);
      }
      pendingReload = false;
      var revision = ++loadRevision;
      retireModelTest();
      loading = true;
      loadError = '';
      renderServiceList();
      setControlsDisabled(!!currentService());
      return Promise.all([readAllModelServices(), readAgentSettings()]).then(function (values) {
        if (revision !== loadRevision) return null;
        modelServices = values[0];
        agentSettings = values[1];
        var requested = text(options.serviceId);
        if (findService(requested)) modelEditingServiceId = requested;
        else if (!findService(modelEditingServiceId)) {
          modelEditingServiceId = findService(agentSettings.defaultModelServiceId)
            ? agentSettings.defaultModelServiceId
            : (modelServices[0] && modelServices[0].id || '');
        }
        return { services: clone(modelServices), agentSettings: clone(agentSettings) };
      }).catch(function (error) {
        if (revision === loadRevision) {
          loadError = '模型资源加载失败: ' + errorText(error);
          toast(loadError, true);
        }
        throw error;
      }).finally(function () {
        if (revision !== loadRevision) return;
        loading = false;
        render();
      });
    }

    function patchAgentSettings(patch) {
      return resourceClient.get(AGENT_SETTINGS_URI).then(function (envelope) {
        agentSettings = envelopeData(envelope, 'Agent Settings');
        return resourceClient.authorizedPatch(AGENT_SETTINGS_URI, patch, mutationOptions('agent-settings', {
          ifMatch: 'cached',
        }));
      }).then(function (envelope) {
        agentSettings = envelopeData(envelope, 'Agent Settings');
        return agentSettings;
      });
    }

    function persistCurrentService(options) {
      options = options || {};
      var service = currentService();
      if (!service) return Promise.reject(new Error('没有可保存的模型服务'));
      var creating = !service.id;
      var servicePatch = servicePatchFromControls();
      var contextPatch = options.includeContext === false ? null : contextPatchFromControls();
      var request = service.id
        ? resourceClient.get(itemUri(service.id)).then(function () {
          return resourceClient.authorizedPatch(itemUri(service.id), servicePatch, mutationOptions('model-service', { ifMatch: 'cached' }));
        })
        : resourceClient.authorizedPost(MODEL_COLLECTION_URI, servicePatch, mutationOptions('model-services'));
      return request.then(function (envelope) {
        var saved = envelopeData(envelope, '模型服务');
        replaceService(saved);
        draftService = null;
        modelEditingServiceId = saved.id;
        $('#model-api-key').value = '';
        modelEditorDirty = contextSignature() !== modelContextBaseline;
        if (!contextPatch) {
          return creating ? readAgentSettings().then(function (settings) { agentSettings = settings; return saved; }) : saved;
        }
        return patchAgentSettings(contextPatch).then(function () {
          modelContextBaseline = contextSignature();
          modelEditorDirty = false;
          return saved;
        });
      });
    }

    function runMutation(operation, successMessage) {
      if (loading || mutating) return Promise.reject(new Error('模型配置正在更新'));
      mutating = true;
      setControlsDisabled(!!currentService());
      return Promise.resolve().then(operation).then(function (value) {
        if (successMessage) toast(successMessage);
        return value;
      }).catch(function (error) {
        toast(errorText(error), true);
        throw error;
      }).finally(function () {
        mutating = false;
        renderServiceList();
        renderCredentialStatus();
        setControlsDisabled(!!currentService());
        refreshPendingModelSettings();
      });
    }

    function createServiceBody(source, name) {
      source = source || {};
      var protocolValue = source.protocol === undefined ? source.apiStyle : source.protocol;
      var protocol = protocolValue === undefined
        ? 'chat_completions'
        : strictValue(protocolValue, PROTOCOLS, '协议');
      return {
        name: text(name || source.name) || '新模型服务',
        baseUrl: text(source.baseUrl),
        model: text(source.model),
        visionModel: text(source.visionModel),
        summaryModel: text(source.summaryModel),
        protocol: protocol,
        userAgent: text(source.userAgent),
        reasoningEffort: REASONING_EFFORTS[source.reasoningEffort] ? source.reasoningEffort : 'auto',
        serviceTier: SERVICE_TIERS[source.serviceTier] ? source.serviceTier : 'auto',
      };
    }

    function formatAttempt(attempt) {
      attempt = attempt || {};
      var protocol = PROTOCOLS[attempt.protocol] || attempt.protocol || '未知协议';
      var latency = Math.max(0, Number(attempt.latencyMs) || 0);
      if (attempt.status === 'succeeded') return '✅ ' + protocol + ' · ' + latency + 'ms · 连接成功';
      if (attempt.status === 'failed') {
        return '❌ ' + protocol + ' · ' + latency + 'ms · '
          + String(attempt.error && attempt.error.message || '连接失败');
      }
      if (attempt.status === 'interrupted') {
        return '⚠️ ' + protocol + ' · 连接测试被扩展运行时中断';
      }
      return '⏳ ' + protocol + ' · 连接测试中…';
    }

    function pollConnectionAttempt(operationUri, initialAttempt, revision, retryAfterMs) {
      var resultElement = $('#model-test-result');
      var startedAt = Date.now();
      var active = { running: true };
      function accept(attempt) {
        if (revision !== modelTestRevision) return attempt;
        resultElement.textContent = formatAttempt(attempt);
        if (!active[attempt.status]) return attempt;
        if (Date.now() - startedAt >= 130000) throw new Error('连接测试结果等待超时');
        return new Promise(function (resolve) {
          modelTestTimer = root.setTimeout(resolve, retryAfterMs);
        }).then(function () {
          modelTestTimer = 0;
          return resourceClient.get(operationUri).then(function (envelope) {
            return accept(envelopeData(envelope, '连接测试'));
          });
        });
      }
      return accept(initialAttempt);
    }

    function startConnectionAttempt() {
      var service = currentService();
      if (!service) return Promise.reject(new Error('没有可测试的模型服务'));
      var revision = retireModelTest();
      $('#model-test-result').textContent = '⏳ 正在保存并创建连接测试…';
      return Promise.resolve().then(function () {
        return persistCurrentService({ includeContext: false });
      }).then(function (saved) {
        var uri = itemUri(saved.id) + '/connection-attempts';
        return resourceClient.authorizedPost(uri, {}, mutationOptions('model-service-connection-attempts'));
      }).then(function (envelope) {
        var attempt = envelopeData(envelope, '连接测试');
        var operationUri = text(envelope.receipt && envelope.receipt.operationUri)
          || text(envelope.primary && envelope.primary.uri);
        if (!operationUri) throw new Error('连接测试未返回 operation URI');
        var retryAfterMs = Math.max(100, Math.min(2000, Number(envelope.receipt && envelope.receipt.retryAfterMs) || 250));
        return pollConnectionAttempt(operationUri, attempt, revision, retryAfterMs);
      }).catch(function (error) {
        if (revision === modelTestRevision) $('#model-test-result').textContent = '❌ ' + errorText(error);
        throw error;
      });
    }

    $('#model-services-list').addEventListener('click', async function (event) {
      var card = event.target.closest('.model-service-card');
      if (!card || loading || mutating || !findService(card.dataset.id) || !await confirmEditorChange()) return;
      var open = !modelEditorOpen || modelEditingServiceId !== card.dataset.id;
      retireModelTest();
      draftService = null;
      modelEditingServiceId = card.dataset.id;
      $('#model-test-result').textContent = '';
      render();
      setEditorOpen(open);
    });

    ['input', 'change'].forEach(function (eventName) {
      $('#model-service-editor').addEventListener(eventName, function (event) {
        if (!event.target.matches('input, select')) return;
        if (event.target.id === 'model-protocol') setControlsDisabled(!!currentService());
        modelEditorDirty = true;
        retireModelTest();
        $('#model-test-result').textContent = '';
      });
    });

    $('#btn-model-add-service').addEventListener('click', async function () {
      if (!await confirmEditorChange()) return;
      retireModelTest();
      draftService = createServiceBody({}, '');
      draftService.name = '';
      draftService.maxRetries = maxRetriesDefault;
      modelEditingServiceId = '';
      $('#model-test-result').textContent = '';
      render();
      setEditorOpen(true);
    });

    function discardEditor() {
      retireModelTest();
      draftService = null;
      modelEditorDirty = false;
      setEditorOpen(false);
      render();
    }

    $('#btn-model-cancel').addEventListener('click', async function () {
      if (await confirmEditorChange()) discardEditor();
    });

    $('#btn-model-copy-service').addEventListener('click', async function () {
      if (!await confirmEditorChange()) return;
      retireModelTest();
      var source = currentService();
      if (!source) return;
      runMutation(function () {
        return resourceClient.authorizedPost(
          MODEL_COLLECTION_URI,
          createServiceBody(source, displayName(source) + ' 副本'),
          mutationOptions('model-services')
        ).then(function (envelope) {
          var service = envelopeData(envelope, '模型服务');
          replaceService(service);
          return service;
        });
      }, '模型服务已复制；密钥不会被复制').then(function (service) {
        modelEditingServiceId = service.id;
        $('#model-test-result').textContent = '';
        render();
        setEditorOpen(true);
      }).catch(function () {});
    });

    $('#btn-model-delete-service').addEventListener('click', async function () {
      retireModelTest();
      var service = currentService();
      if (!service || !await deps.confirm('确定删除模型服务“' + displayName(service) + '”？相关助手和对话会解除该服务绑定。')) return;
      var deleted = false;
      runMutation(function () {
        var uri = itemUri(service.id);
        return resourceClient.get(uri).then(function () {
          return resourceClient.authorizedDelete(uri, mutationOptions('model-service', { ifMatch: 'cached' }));
        }).then(function () {
          modelServices = modelServices.filter(function (item) { return item && item.id !== service.id; });
          modelEditingServiceId = modelServices[0] && modelServices[0].id || '';
          deleted = true;
          return readAgentSettings().then(function (settings) { agentSettings = settings; });
        });
      }, '模型服务已删除').catch(function () {}).finally(function () {
        if (!deleted) return;
        setEditorOpen(false);
        render();
        $('#model-test-result').textContent = '';
      });
    });

    $('#btn-model-save').addEventListener('click', function () {
      retireModelTest();
      runMutation(function () { return persistCurrentService({ includeContext: true }); }, '模型与 Agent 上下文设置已保存')
        .then(function () {
          render();
          setEditorOpen(false);
        })
        .catch(function () {});
    });

    $('#btn-model-set-default').addEventListener('click', function () {
      retireModelTest();
      var service = currentService();
      if (!service) return;
      runMutation(function () {
        return patchAgentSettings({ defaultModelServiceId: service.id });
      }, '全局默认模型服务已更新').catch(function () {});
    });

    var clearKeyButton = $('#btn-model-clear-key');
    if (clearKeyButton) clearKeyButton.addEventListener('click', async function () {
      retireModelTest();
      var service = currentService();
      if (!service || !await deps.confirm('确定清除“' + displayName(service) + '”的 API Key？')) return;
      runMutation(function () {
        var uri = itemUri(service.id);
        return resourceClient.get(uri).then(function () {
          return resourceClient.authorizedPatch(uri, { secret: { clearApiKey: true } }, mutationOptions('model-service', {
            ifMatch: 'cached',
          }));
        }).then(function (envelope) {
          replaceService(envelopeData(envelope, '模型服务'));
          $('#model-api-key').value = '';
          $('#model-test-result').textContent = '';
        });
      }, 'API Key 已清除').catch(function () {});
    });

    $('#btn-model-test').addEventListener('click', function () {
      if (loading || mutating) return;
      mutating = true;
      setControlsDisabled(!!currentService());
      startConnectionAttempt().catch(function () {}).finally(function () {
        mutating = false;
        renderServiceList();
        renderCredentialStatus();
        setControlsDisabled(!!currentService());
        refreshPendingModelSettings();
      });
    });

    deps.lifecycle.subscribe(root.chrome.storage.onChanged, function (changes, area) {
      if (area !== 'local' || !changes[root.ModelSettings.SETTINGS_KEY]) return;
      pendingReload = true;
      refreshPendingModelSettings();
    });

    activePanel = {
      reload: loadModelSettings,
      discard: discardEditor,
      getState: function () {
        return {
          services: clone(modelServices),
          agentSettings: clone(agentSettings),
          editingServiceId: modelEditingServiceId,
          loading: loading,
          mutating: mutating,
          dirty: modelEditorOpen && modelEditorDirty,
        };
      },
    };
    loadModelSettings().catch(function () {});
  }

  return Object.freeze({
    init: init,
    reload: reload,
    getState: getState,
    discard: discard,
    PROTOCOLS: PROTOCOLS,
    API_STYLES: PROTOCOLS,
  });
});
