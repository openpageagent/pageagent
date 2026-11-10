// Model Client — 外部模型聊天接口客户端（请求模型节点共用）
// 设置存 chrome.storage.local 'model_settings'。
// 可配置 OpenAI / Qwen / Moonshot / Ollama 等外部模型服务；
// 这里列举的是可配置后端示例，不是硬编码供应商端点或能力。
(function attachModelClient(root, factory) {
  root.ModelClient = factory();
})(globalThis, function () {

  var SETTINGS_KEY = 'model_settings';
  var DEFAULT_TIMEOUT_MS = 60000;
  var MAX_TIMEOUT_MS = 10 * 60 * 1000;
  var settingsStateByChrome = new WeakMap();

  function sharedSettingsState(chrome) {
    var state = settingsStateByChrome.get(chrome);
    if (state) return state;
    state = { cachedSettings: null, loadPromise: null, revision: 0 };
    if (chrome && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[SETTINGS_KEY]) {
          state.revision += 1;
          state.cachedSettings = null;
          state.loadPromise = null;
        }
      });
    }
    settingsStateByChrome.set(chrome, state);
    return state;
  }

  function createModelClient(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome || {};
    var addLog = deps.addLog || (function () {});
    var settingsState = sharedSettingsState(chrome);

    function getSettings() {
      if (settingsState.cachedSettings) return Promise.resolve(settingsState.cachedSettings);
      if (settingsState.loadPromise) return settingsState.loadPromise;
      if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function') {
        return Promise.reject(new Error('Chrome storage API 不可用，无法读取模型配置'));
      }
      var loadRevision = settingsState.revision;
      var loadPromise = new Promise(function (resolve, reject) {
        chrome.storage.local.get([SETTINGS_KEY], function (result) {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '读取模型配置失败'));
            return;
          }
          var source = result && result[SETTINGS_KEY] || {};
          var normalized = globalThis.ModelSettings.normalizeSettings(source);
          if (settingsState.revision === loadRevision) settingsState.cachedSettings = normalized;
          resolve(normalized);
        });
      });
      settingsState.loadPromise = loadPromise.finally(function () {
        if (settingsState.loadPromise === loadPromise || settingsState.loadPromise === guardedLoad) {
          settingsState.loadPromise = null;
        }
      });
      var guardedLoad = settingsState.loadPromise;
      return guardedLoad;
    }

    function ensureConfigured(service, needVision) {
      if (!service || !service.baseUrl || !service.model) {
        throw new Error('模型服务未配置：请到配置页「模型配置」填写接口地址与模型名');
      }
      if (needVision && !service.visionModel && !service.model) {
        throw new Error('视觉模型未配置：请到「模型配置」填写视觉模型名');
      }
    }

    // Flow inputs use inline screenshots or remote URLs; providers use image refs.
    // Keep this request's images in memory and resolve them through the same
    // provider hook used by conversations, without storing them in history.
    function providerUserInput(content) {
      var images = new Map();
      var user = Array.isArray(content) ? content.map(function (part, index) {
        if (!part || part.type !== 'image_url') return part;
        var image = part.image_url;
        var imageUrl = typeof image === 'string' ? image : image && image.url;
        var uri = '/image-artifacts/model-input-' + index;
        // Reject invalid request input before the history resolver can replace it.
        images.set(uri, globalThis.ProviderMessageNormalizer.normalizeImageSource(imageUrl));
        return { type: 'image', artifactUri: uri, detail: image && image.detail || 'high' };
      }) : content;
      return {
        content: user,
        resolveImageArtifact: function (uri) {
          if (!images.has(uri)) throw new Error('模型输入图片不存在');
          return images.get(uri);
        },
      };
    }

    // opts: { system, user, serviceId, useVision, timeoutMs, temperature, signal, sessionId }
    async function chat(opts) {
      opts = opts || {};
      var settings = await getSettings();
      var serviceId = String(opts.serviceId || '').trim();
      var service = serviceId
        ? globalThis.ModelSettings.getService(settings, serviceId, false)
        : globalThis.ModelSettings.getGeneratorService(settings);
      if (serviceId && !service) {
        var missingService = new Error('指定的模型服务不存在或已删除: ' + serviceId);
        missingService.code = 'SERVICE_NOT_FOUND';
        throw missingService;
      }
      ensureConfigured(service, opts.useVision);
      if (opts.signal && opts.signal.aborted) throw opts.signal.reason || new Error('模型调用已停止');
      var model = (opts.useVision && service.visionModel) ? service.visionModel : service.model;
      var input = providerUserInput(opts.user);
      var timeoutMs = globalThis.ModelSettings.normalizeRequestTimeoutMs(opts.timeoutMs, {
        defaultMs: service.requestTimeoutMs || DEFAULT_TIMEOUT_MS,
        minMs: 1000,
        maxMs: MAX_TIMEOUT_MS,
      });
      var gateway = globalThis.AgentProvider.create({
        service: service,
        assistant: { model: model, settings: {
          temperature: opts.temperature !== undefined ? opts.temperature : 0,
          timeoutMs: timeoutMs,
        } },
        modelSettings: globalThis.ModelSettings,
        resolveImageArtifact: input.resolveImageArtifact,
        fetch: async function (url, init) {
          if (typeof opts.authorizeRequest === 'function') {
            await opts.authorizeRequest({ serviceId: service.id, url: url, model: model, useVision: !!opts.useVision });
          }
          if (init.signal && init.signal.aborted) throw init.signal.reason || new Error('模型调用已停止');
          return globalThis.fetch(url, Object.assign({}, init, {
            redirect: typeof opts.authorizeRequest === 'function' ? 'error' : 'follow',
          }));
        },
      });
      var result = await gateway.request({
        purpose: 'main',
        serviceId: service.id,
        sessionId: String(opts.sessionId || ''),
        system: opts.system || '',
        messages: [{ role: 'user', content: input.content }],
        tools: [],
        signal: opts.signal,
        onEvent: function (event) {
          if (event.type === 'provider_warning') addLog(event.message, { scope: 'model' });
        },
      });
      if (opts.signal && opts.signal.aborted) throw opts.signal.reason || new Error('模型调用已停止');
      if (result.finishReason !== 'stop') {
        var detail = result.rawMeta && result.rawMeta.error;
        var failed = new Error(detail && detail.message || '模型响应未完成: ' + result.finishReason);
        failed.code = detail ? detail.errorCode || 'MODEL_PROVIDER_ERROR' : 'MODEL_RESPONSE_INCOMPLETE';
        failed.status = detail && detail.status || 0;
        failed.retryable = !!(detail && detail.retryable);
        failed.finishReason = result.finishReason;
        throw failed;
      }
      var content = globalThis.ProviderMessageNormalizer.contentText(result.content);
      if (!content) {
        var empty = new Error('模型接口返回缺少文本内容');
        empty.code = 'MODEL_RESPONSE_CONTENT_MISSING';
        throw empty;
      }
      return {
        content: content,
        model: result.rawMeta && result.rawMeta.responseModel || model,
        serviceId: service.id,
        serviceName: globalThis.ModelSettings.serviceDisplayName(service),
        usage: result.usage,
        finishReason: result.finishReason,
      };
    }

    function balancedJsonCandidate(text, start) {
      var stack = [];
      var inString = false;
      var escaped = false;
      for (var i = start; i < text.length; i++) {
        var ch = text.charAt(i);
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
          if (!stack.length || stack[stack.length - 1] !== ch) return '';
          stack.pop();
          if (!stack.length) return text.slice(start, i + 1);
        }
      }
      return '';
    }

    // 从模型回复中提取第一个合法 JSON 对象/数组。逐字符扫描可正确处理嵌套和字符串内括号。
    function extractJson(content) {
      var text = String(content || '').trim();
      try { return JSON.parse(text); } catch (_) {}
      for (var start = 0; start < text.length; start++) {
        var opening = text.charAt(start);
        if (opening !== '{' && opening !== '[') continue;
        var candidate = balancedJsonCandidate(text, start);
        if (!candidate) continue;
        try { return JSON.parse(candidate); } catch (_) {}
      }
      return undefined;
    }

    function buildUserContent(parts) {
      parts = Array.isArray(parts) ? parts : [];
      var content = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        if (p.text) content.push({ type: 'text', text: p.text });
        if (p.imageDataUrl) content.push({ type: 'image_url', image_url: { url: p.imageDataUrl } });
      }
      return content;
    }

    return {
      SETTINGS_KEY: SETTINGS_KEY,
      getSettings: getSettings,
      chat: chat,
      extractJson: extractJson,
      buildUserContent: buildUserContent,
    };
  }

  return { createModelClient: createModelClient };
});
