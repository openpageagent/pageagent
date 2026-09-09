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
    var resourceClient = deps.resourceClient;
    if (!resourceClient || typeof resourceClient.get !== 'function'
        || typeof resourceClient.authorizedPost !== 'function'
        || typeof resourceClient.authorizedPatch !== 'function'
        || typeof resourceClient.authorizedDelete !== 'function') {
      throw new Error('OptionsModelSettingsPanel requires PageAutomationResourceClient');
    }

    var modelServices = [];
    var agentSettings = null;
    var modelEditingServiceId = '';
    var loading = false;
    var mutating = false;
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
      ['#model-max-context-tokens', '#model-auto-compact-token-limit', '#model-context-compression'].forEach(function (selector) {
        var element = $(selector);
        if (element) element.disabled = loading || mutating || !agentSettings;
      });
      var select = $('#model-service-select');
      if (select) select.disabled = loading || mutating || !modelServices.length;
      var addButton = $('#btn-model-add-service');
      if (addButton) addButton.disabled = loading || mutating;
      ['#btn-model-copy-service', '#btn-model-delete-service', '#btn-model-save', '#btn-model-test', '#btn-model-set-default']
        .forEach(function (selector) {
          var element = $(selector);
          if (element) element.disabled = loading || mutating || !hasService;
        });
      var clearButton = $('#btn-model-clear-key');
      var service = currentService();
      if (clearButton) {
        clearButton.disabled = loading || mutating || !hasService
          || !(service.credentialMetadata && service.credentialMetadata.apiKeyConfigured === true);
      }
    }

    function render() {
      var select = $('#model-service-select');
      var defaultServiceId = text(agentSettings && agentSettings.defaultModelServiceId);
      if (!findService(modelEditingServiceId)) {
        modelEditingServiceId = findService(defaultServiceId)
          ? defaultServiceId
          : (modelServices[0] && modelServices[0].id || '');
      }
      if (select) {
        select.innerHTML = modelServices.map(function (service) {
          var label = displayName(service);
          if (service.id === defaultServiceId) label += '（全局默认）';
          return '<option value="' + esc(service.id) + '">' + esc(label) + '</option>';
        }).join('');
        select.value = modelEditingServiceId;
      }

      var service = currentService() || {};
      var hasService = !!service.id;
      $('#model-service-name').value = service.name || '';
      $('#model-base-url').value = service.baseUrl || '';
      $('#model-user-agent').value = service.userAgent || '';
      $('#model-name').value = service.model || '';
      $('#model-vision-model').value = service.visionModel || '';
      $('#model-summary-model').value = service.summaryModel || '';
      $('#model-reasoning-effort').value = REASONING_EFFORTS[service.reasoningEffort] ? service.reasoningEffort : '';
      $('#model-max-retries').value = service.maxRetries === undefined || service.maxRetries === null
        ? '' : String(Math.max(0, Math.floor(Number(service.maxRetries) || 0)));
      $('#model-protocol').value = PROTOCOLS[service.protocol] ? service.protocol : 'chat_completions';

      var apiKeyInput = $('#model-api-key');
      var secretMetadata = service.credentialMetadata || {};
      var hasSecret = secretMetadata.hasSecret === true;
      apiKeyInput.value = '';
      apiKeyInput.placeholder = hasSecret
        ? '凭据已配置；留空保持不变'
        : '输入 API Key';
      var apiKeyHelp = $('#model-api-key-help');
      if (apiKeyHelp) {
        apiKeyHelp.textContent = hasSecret
          ? '已配置凭据。服务端只返回 hasSecret；留空不会修改，清除 API Key 需点击“清除密钥”。'
          : '尚未配置密钥。输入值只会作为 secret 写入，不会回显。';
      }

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

      var defaultService = findService(defaultServiceId);
      $('#model-default-service-name').textContent = defaultService ? displayName(defaultService) : '未配置';
      setControlsDisabled(hasService);
    }

    function loadModelSettings(options) {
      options = options || {};
      var revision = ++loadRevision;
      retireModelTest();
      loading = true;
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
        if (revision === loadRevision) toast('模型资源加载失败: ' + errorText(error), true);
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
      var uri = itemUri(service.id);
      var servicePatch = servicePatchFromControls();
      var contextPatch = options.includeContext === false ? null : contextPatchFromControls();
      $('#model-api-key').value = '';
      return resourceClient.get(uri).then(function () {
        return resourceClient.authorizedPatch(uri, servicePatch, mutationOptions('model-service', {
          ifMatch: 'cached',
        }));
      }).then(function (envelope) {
        var saved = envelopeData(envelope, '模型服务');
        replaceService(saved);
        if (!contextPatch) return saved;
        return patchAgentSettings(contextPatch).then(function () { return saved; });
      });
    }

    function runMutation(operation, successMessage) {
      if (mutating) return Promise.reject(new Error('模型配置正在更新'));
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
        render();
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
      return persistCurrentService({ includeContext: false }).then(function () {
        var uri = itemUri(service.id) + '/connection-attempts';
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

    $('#model-service-select').addEventListener('change', function (event) {
      retireModelTest();
      modelEditingServiceId = text(event.target.value);
      $('#model-test-result').textContent = '';
      render();
    });

    $('#model-protocol').addEventListener('change', function () {
      retireModelTest();
      $('#model-test-result').textContent = '';
      setControlsDisabled(!!currentService());
    });

    $('#btn-model-add-service').addEventListener('click', function () {
      retireModelTest();
      runMutation(function () {
        return resourceClient.authorizedPost(
          MODEL_COLLECTION_URI,
          createServiceBody({}, '新服务 ' + (modelServices.length + 1)),
          mutationOptions('model-services')
        ).then(function (envelope) {
          var service = envelopeData(envelope, '模型服务');
          replaceService(service);
          modelEditingServiceId = service.id;
          return readAgentSettings().then(function (settings) { agentSettings = settings; return service; });
        });
      }, '模型服务已创建').catch(function () {});
    });

    $('#btn-model-copy-service').addEventListener('click', function () {
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
          modelEditingServiceId = service.id;
          return service;
        });
      }, '模型服务已复制；密钥不会被复制').catch(function () {});
    });

    $('#btn-model-delete-service').addEventListener('click', function () {
      retireModelTest();
      var service = currentService();
      if (!service || !root.confirm('确定删除模型服务“' + displayName(service) + '”？相关助手和对话会解除该服务绑定。')) return;
      runMutation(function () {
        var uri = itemUri(service.id);
        return resourceClient.get(uri).then(function () {
          return resourceClient.authorizedDelete(uri, mutationOptions('model-service', { ifMatch: 'cached' }));
        }).then(function () {
          modelServices = modelServices.filter(function (item) { return item && item.id !== service.id; });
          modelEditingServiceId = modelServices[0] && modelServices[0].id || '';
          return readAgentSettings().then(function (settings) { agentSettings = settings; });
        });
      }, '模型服务已删除').catch(function () {});
    });

    $('#btn-model-save').addEventListener('click', function () {
      retireModelTest();
      runMutation(function () { return persistCurrentService({ includeContext: true }); }, '模型与 Agent 上下文设置已保存')
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
    if (clearKeyButton) clearKeyButton.addEventListener('click', function () {
      retireModelTest();
      var service = currentService();
      if (!service || !root.confirm('确定清除“' + displayName(service) + '”的 API Key？')) return;
      runMutation(function () {
        var uri = itemUri(service.id);
        return resourceClient.get(uri).then(function () {
          return resourceClient.authorizedPatch(uri, { secret: { clearApiKey: true } }, mutationOptions('model-service', {
            ifMatch: 'cached',
          }));
        }).then(function (envelope) {
          replaceService(envelopeData(envelope, '模型服务'));
        });
      }, 'API Key 已清除').catch(function () {});
    });

    $('#btn-model-test').addEventListener('click', function () {
      if (mutating) return;
      mutating = true;
      setControlsDisabled(!!currentService());
      startConnectionAttempt().catch(function () {}).finally(function () {
        mutating = false;
        render();
      });
    });


    activePanel = {
      reload: loadModelSettings,
      getState: function () {
        return {
          services: clone(modelServices),
          agentSettings: clone(agentSettings),
          editingServiceId: modelEditingServiceId,
          loading: loading,
          mutating: mutating,
        };
      },
    };
    loadModelSettings().catch(function () {});
  }

  return Object.freeze({
    init: init,
    reload: reload,
    getState: getState,
    PROTOCOLS: PROTOCOLS,
    API_STYLES: PROTOCOLS,
  });
});
