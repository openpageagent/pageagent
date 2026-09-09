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

    // opts: { system, user, serviceId, useVision, timeoutMs, temperature, signal }
    function chat(opts) {
      opts = opts || {};
      return getSettings().then(function (settings) {
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
        var model = (opts.useVision && service.visionModel) ? service.visionModel : service.model;
        var messages = [];
        if (opts.system) messages.push({ role: 'system', content: opts.system });
        messages.push({ role: 'user', content: opts.user });

        var body = {
          model: model,
          messages: messages,
          temperature: opts.temperature !== undefined ? opts.temperature : 0,
        };
        var modelRequest = globalThis.ModelSettings.buildModelHttpRequest(body, service, { reserveTokens: 1024 });
        if (globalThis.ProviderCompat && typeof globalThis.ProviderCompat.resolve === 'function') {
          var compatibility = globalThis.ProviderCompat.resolve(service, service.protocol);
          var compatibleRequest = compatibility.beforeRequest({
            body: modelRequest.body,
            headers: modelRequest.headers,
            reasoningEffort: service.reasoningEffort,
            maxTokens: modelRequest.body && (modelRequest.body.max_tokens || modelRequest.body.max_output_tokens),
          });
          modelRequest.url = compatibility.endpoint(modelRequest.url);
          modelRequest.body = compatibleRequest.body;
          modelRequest.headers = compatibleRequest.headers;
        }
        if (!modelRequest.url) throw new Error('模型接口地址未配置');
        body = modelRequest.body;
        if (modelRequest.meta && modelRequest.meta.compacted) {
          addLog('模型请求上下文已压缩: ' + modelRequest.meta.estimatedTokens + ' -> ' + modelRequest.meta.outputTokens + ' tokens', { scope: 'model' });
        }

        var timeoutMs = globalThis.ModelSettings.normalizeRequestTimeoutMs(opts.timeoutMs, {
          defaultMs: DEFAULT_TIMEOUT_MS,
          minMs: 1000,
          maxMs: MAX_TIMEOUT_MS,
        });
        var controller = new AbortController();
        var parentSignal = opts.signal || null;
        var timedOut = false;
        var forwardAbort = null;
        if (parentSignal && parentSignal.aborted) {
          throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error('模型调用已停止');
        }
        if (parentSignal && typeof parentSignal.addEventListener === 'function') {
          forwardAbort = function () {
            try { controller.abort(parentSignal.reason); } catch (_) { controller.abort(); }
          };
          parentSignal.addEventListener('abort', forwardAbort, { once: true });
        }
        var timer = setTimeout(function () {
          timedOut = true;
          try { controller.abort(new Error('模型调用超时')); } catch (_) { controller.abort(); }
        }, timeoutMs);

        return fetch(modelRequest.url, {
          method: 'POST',
          headers: modelRequest.headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }).then(function (response) {
          return response.text().then(function (text) {
            if (!response.ok) {
              throw globalThis.ModelSettings.createChatCompletionHttpError(response.status, response.statusText, text);
            }
            var normalized = globalThis.ModelSettings.parseModelResponse(text, service);
            return {
              content: normalized.content,
              model: normalized.model || model,
              serviceId: service.id || '',
              serviceName: globalThis.ModelSettings.serviceDisplayName(service),
              usage: normalized.usage,
              finishReason: normalized.finishReason,
            };
          });
        }).catch(function (err) {
          if (timedOut) {
            throw new Error('模型调用超时 (' + timeoutMs + 'ms)');
          }
          if (parentSignal && parentSignal.aborted) {
            throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error('模型调用已停止');
          }
          throw err;
        }).finally(function () {
          clearTimeout(timer);
          if (parentSignal && forwardAbort && typeof parentSignal.removeEventListener === 'function') {
            try { parentSignal.removeEventListener('abort', forwardAbort); } catch (_) {}
          }
        });
      });
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
