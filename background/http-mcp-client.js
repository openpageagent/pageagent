// HTTP MCP Client — Streamable HTTP transport for remote MCP servers.
(function attachHttpMcpClient(root, factory) {
  root.HttpMcpClient = factory(root);
})(globalThis, function (root) {
  'use strict';

  var STORAGE_KEY = 'mcp_http_servers';
  var VERSION = 1;
  var DEFAULT_PROTOCOL_VERSION = '2025-11-25';
  var SUPPORTED_PROTOCOL_VERSIONS = {
    '2025-11-25': true,
    '2025-06-18': true,
  };
  var DEFAULT_TIMEOUT_MS = 120000;
  var MAX_TIMEOUT_MS = 600000;
  var MAX_TOOLS_PER_SYNC = 500;
  function createHttpMcpManager(deps) {
    deps = deps || {};
    var chromeApi = deps.chrome || root.chrome;
    var incognito = deps.incognito === true || (deps.incognito === undefined
      && !!(chromeApi && chromeApi.extension && chromeApi.extension.inIncognitoContext));
    var storageKey = incognito ? STORAGE_KEY + '_incognito' : STORAGE_KEY;
    var knowledge = deps.knowledge || root.Knowledge;
    var addLog = deps.addLog || function () {};
    var sessions = {};
    var sessionInitializations = {};
    var clientInfo = Object.assign({
      name: 'Page Agent Extension',
      title: 'Page Agent',
      version: chromeApi && chromeApi.runtime && chromeApi.runtime.getManifest
        ? chromeApi.runtime.getManifest().version
        : 'extension',
    }, deps.clientInfo || {});

    function log(message, options) {
      options = Object.assign({ scope: 'mcp', source: 'http-mcp-client' }, options || {});
      addLog(message, options);
    }

    function storageGet(key) {
      return new Promise(function (resolve, reject) {
        chromeApi.storage.local.get(key, function (res) {
          if (chromeApi.runtime && chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
          else resolve(res || {});
        });
      });
    }

    function storageSet(value) {
      return new Promise(function (resolve, reject) {
        chromeApi.storage.local.set(value, function () {
          if (chromeApi.runtime && chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
          else resolve(value);
        });
      });
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    }

    function compactString(value, max) {
      var text = String(value === undefined || value === null ? '' : value);
      max = Math.max(20, Number(max) || 2000);
      return text.length > max ? text.slice(0, max) + '\n... omitted ' + (text.length - max) + ' chars' : text;
    }

    function nowId(prefix) {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return prefix + '_' + root.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      }
      return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function safeIdFromText(value) {
      var id = String(value || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
      return id || nowId('mcp');
    }

    function defaultState() {
      return {
        version: VERSION,
        servers: {},
        order: [],
        updatedAt: Date.now(),
      };
    }

    function normalizeTimeoutMs(value) {
      return Math.min(Math.max(Number(value) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    }

    function normalizeUrl(value) {
      var text = String(value || '').trim();
      if (!text) return '';
      try {
        var url = new URL(text);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return text;
        return url.toString();
      } catch (_) {
        return text;
      }
    }

    function assertValidEndpointUrl(urlText) {
      try {
        var url = new URL(String(urlText || '').trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('HTTP MCP URL 只支持 http/https');
        }
        if (url.username || url.password) {
          throw new Error('HTTP MCP URL 不允许包含 username/password，请改用 Bearer Token 或自定义 Header');
        }
      } catch (err) {
        if (err && /^HTTP MCP URL/.test(err.message || '')) throw err;
        throw new Error('HTTP MCP URL 格式无效');
      }
    }

    function compactTool(tool) {
      tool = tool && typeof tool === 'object' ? tool : {};
      return {
        name: compactString(String(tool.name || '').trim(), 160),
        title: compactString(String(tool.title || '').trim(), 180),
        description: compactString(String(tool.description || '').trim(), 1600),
        inputSchema: clone(tool.inputSchema || { type: 'object' }),
        outputSchema: tool.outputSchema ? clone(tool.outputSchema) : undefined,
        annotations: tool.annotations ? clone(tool.annotations) : undefined,
        execution: tool.execution ? clone(tool.execution) : undefined,
      };
    }

    function normalizeServer(raw) {
      raw = raw && typeof raw === 'object' ? raw : {};
      var url = normalizeUrl(raw.url || raw.baseUrl || raw.endpoint || '');
      var name = String(raw.name || raw.title || '').trim() || (url ? url : 'HTTP MCP Server');
      var id = String(raw.id || '').trim() || safeIdFromText(name + '_' + url);
      var tools = Array.isArray(raw.tools) ? raw.tools.map(compactTool).filter(function (tool) { return !!tool.name; }) : [];
      return {
        id: id,
        name: compactString(name, 120),
        url: url,
        enabled: raw.enabled !== false,
        bearerToken: String(raw.bearerToken || raw.token || '').trim(),
        headersText: String(raw.headersText || '').trim(),
        protocolVersion: String(raw.protocolVersion || DEFAULT_PROTOCOL_VERSION).trim() || DEFAULT_PROTOCOL_VERSION,
        timeoutMs: normalizeTimeoutMs(raw.timeoutMs || raw.timeout || DEFAULT_TIMEOUT_MS),
        tools: tools,
        syncedAt: Number(raw.syncedAt) || 0,
        lastTestedAt: Number(raw.lastTestedAt) || 0,
        lastStatus: String(raw.lastStatus || '').trim(),
        lastError: compactString(String(raw.lastError || '').trim(), 1200),
        serverInfo: raw.serverInfo && typeof raw.serverInfo === 'object' ? clone(raw.serverInfo) : {},
        serverInstructions: compactString(String(raw.serverInstructions || raw.instructions || '').trim(), 4000),
        capabilities: raw.capabilities && typeof raw.capabilities === 'object' ? clone(raw.capabilities) : {},
        owner: raw.owner && typeof raw.owner === 'object' && !Array.isArray(raw.owner)
          ? clone(raw.owner)
          : { scope: 'extension-profile' },
        createdAt: Number(raw.createdAt) || 1,
        updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || 1,
      };
    }

    function sanitizedUrl(value) {
      var text = String(value || '').trim();
      try {
        var url = new URL(text);
        url.username = '';
        url.password = '';
        return url.toString();
      } catch (_) {
        return text.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
      }
    }

    function customHeaderNames(text) {
      var headers;
      try {
        headers = parseCustomHeaders(text);
      } catch (_) {
        return [];
      }
      return Object.keys(headers || {}).map(function (key) {
        return String(key || '').trim();
      }).filter(Boolean).sort();
    }

    function redactServer(server) {
      var out = normalizeServer(server);
      var headerNames = customHeaderNames(out.headersText);
      out.url = sanitizedUrl(out.url);
      out.hasBearerToken = !!out.bearerToken;
      out.hasCustomHeaders = headerNames.length > 0;
      out.customHeaderNames = headerNames;
      delete out.bearerToken;
      delete out.headersText;
      return out;
    }

    function ensureState(raw) {
      var state = Object.assign(defaultState(), raw && typeof raw === 'object' ? raw : {});
      state.version = VERSION;
      state.servers = state.servers && typeof state.servers === 'object' ? state.servers : {};
      var normalized = {};
      Object.keys(state.servers).forEach(function (id) {
        var server = normalizeServer(state.servers[id]);
        if (server.id) normalized[server.id] = server;
      });
      state.servers = normalized;
      state.order = (Array.isArray(state.order) ? state.order : Object.keys(normalized)).filter(function (id) {
        return !!normalized[id];
      });
      Object.keys(normalized).forEach(function (id) {
        if (state.order.indexOf(id) === -1) state.order.push(id);
      });
      state.updatedAt = Number(state.updatedAt) || Date.now();
      return state;
    }

    function loadRaw() {
      return storageGet(storageKey).then(function (res) {
        return ensureState(res && res[storageKey]);
      });
    }

    function saveRaw(state) {
      state = ensureState(state);
      state.updatedAt = Date.now();
      var payload = {};
      payload[storageKey] = state;
      return storageSet(payload).then(function () { return state; });
    }

    function update(mutator) {
      return loadRaw().then(function (state) {
        return saveRaw(mutator(state) || state);
      });
    }

    function listServers(args) {
      args = args || {};
      return loadRaw().then(function (state) {
        var servers = (state.order || []).map(function (id) { return state.servers[id]; }).filter(function (server) {
          return !!server && (args.includeDisabled !== false || server.enabled !== false);
        });
        return {
          provider: 'http-mcp-client',
          storageKey: storageKey,
          servers: servers.map(redactServer),
          total: servers.length,
          updatedAt: state.updatedAt,
        };
      });
    }

    function getServer(serverId) {
      serverId = String(serverId || '').trim();
      if (!serverId) return Promise.reject(new Error('缺少 HTTP MCP serverId'));
      return loadRaw().then(function (state) {
        var server = state.servers[serverId];
        if (!server) throw new Error('HTTP MCP Server 不存在: ' + serverId);
        return clone(server);
      });
    }

    function upsertServer(input) {
      input = input || {};
      if (!String(input.url || '').trim()) return Promise.reject(new Error('HTTP MCP URL 不能为空'));
      try { assertValidEndpointUrl(input.url); } catch (err) { return Promise.reject(err); }
      var savedId = '';
      return update(function (state) {
        var existing = input.id && state.servers[input.id] || null;
        var merged = normalizeServer(Object.assign({}, existing || {}, input || {}));
        var now = Date.now();
        merged.createdAt = Number(existing && existing.createdAt) || now;
        merged.updatedAt = now;
        if (input.bearerToken === undefined && existing && existing.bearerToken) merged.bearerToken = existing.bearerToken;
        if (existing && serverConnectionFingerprint(existing) !== serverConnectionFingerprint(merged)) delete sessions[existing.id];
        if (merged.enabled === false) delete sessions[merged.id];
        state.servers[merged.id] = merged;
        savedId = merged.id;
        state.order = [merged.id].concat((state.order || []).filter(function (id) { return id !== merged.id; }));
        return state;
      }).then(function (state) {
        var saved = state.servers[savedId] || null;
        if (saved && saved.enabled === false) {
          return archiveServerKnowledge(saved.id).then(function () {
            return { provider: 'http-mcp-client', server: redactServer(saved) };
          });
        }
        return { provider: 'http-mcp-client', server: redactServer(saved) };
      });
    }

    function removeServer(input) {
      var serverId = String(input && input.id || input && input.serverId || '').trim();
      var knowledgeMode = String(input && (input.knowledgeMode || input.mode) || 'archive').trim();
      if (knowledgeMode !== 'delete') knowledgeMode = 'archive';
      if (!serverId) return Promise.reject(new Error('缺少 HTTP MCP serverId'));
      delete sessions[serverId];
      return loadRaw().then(function (state) {
        if (!state.servers[serverId]) throw new Error('HTTP MCP Server 不存在: ' + serverId);
        return knowledgeMode === 'delete' ? deleteServerKnowledge(serverId) : archiveServerKnowledge(serverId);
      }).then(function (knowledgeResult) {
        return update(function (state) {
          if (!state.servers[serverId]) throw new Error('HTTP MCP Server 不存在: ' + serverId);
          delete state.servers[serverId];
          state.order = (state.order || []).filter(function (id) { return id !== serverId; });
          return state;
        }).then(function () {
          return knowledgeResult;
        });
      }).then(function (knowledgeResult) {
        return {
          provider: 'http-mcp-client',
          deleted: true,
          id: serverId,
          knowledgeMode: knowledgeMode,
          archivedKnowledge: knowledgeMode === 'archive',
          deletedKnowledge: knowledgeMode === 'delete',
          deletedKnowledgeCount: knowledgeResult && knowledgeResult.deleted || 0,
        };
      });
    }

    function serverConnectionFingerprint(server) {
      server = normalizeServer(server);
      return JSON.stringify({
        url: server.url,
        bearerToken: server.bearerToken,
        headersText: server.headersText,
        protocolVersion: server.protocolVersion,
      });
    }

    function parseCustomHeaders(text) {
      text = String(text || '').trim();
      if (!text) return {};
      var out = {};
      if (/^\s*\{/.test(text)) {
        var parsed = JSON.parse(text);
        Object.keys(parsed || {}).forEach(function (key) {
          if (parsed[key] !== undefined && parsed[key] !== null) out[String(key)] = String(parsed[key]);
        });
        return out;
      }
      text.split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (!line || line.charAt(0) === '#') return;
        var idx = line.indexOf(':');
        if (idx === -1) idx = line.indexOf('=');
        if (idx === -1) return;
        var key = line.slice(0, idx).trim();
        var value = line.slice(idx + 1).trim();
        if (key) out[key] = value;
      });
      return out;
    }

    function buildHeaders(server, session, options) {
      options = options || {};
      var headers = parseCustomHeaders(server.headersText);
      Object.keys(headers).forEach(function (key) {
        if (/^(content-type|accept|mcp-session-id|mcp-protocol-version)$/i.test(key)) delete headers[key];
      });
      if (server.bearerToken && !headers.Authorization && !headers.authorization) {
        headers.Authorization = 'Bearer ' + server.bearerToken;
      }
      headers.Accept = options.accept || 'application/json, text/event-stream';
      if (options.method !== 'GET') headers['Content-Type'] = 'application/json';
      var protocolVersion = session && session.protocolVersion || server.protocolVersion || DEFAULT_PROTOCOL_VERSION;
      headers['MCP-Protocol-Version'] = protocolVersion;
      if (session && session.sessionId) headers['MCP-Session-Id'] = session.sessionId;
      return headers;
    }

    function jsonRpcErrorToMessage(error) {
      if (!error) return 'JSON-RPC error';
      var message = String(error.message || error.code || 'JSON-RPC error');
      if (error.data !== undefined) {
        try { message += ': ' + JSON.stringify(error.data).slice(0, 1000); } catch (_) {}
      }
      return message;
    }

    function parseSseEventData(event) {
      if (!event || event.data === undefined || event.data === null || event.data === '') return null;
      try { return JSON.parse(event.data); } catch (_) { return null; }
    }

    function parseSseText(text) {
      var events = [];
      var event = {};
      String(text || '').split(/\r?\n/).forEach(function (line) {
        if (!line) {
          if (event.data !== undefined || event.event || event.id) events.push(event);
          event = {};
          return;
        }
        if (line.charAt(0) === ':') return;
        var idx = line.indexOf(':');
        var field = idx === -1 ? line : line.slice(0, idx);
        var value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
        if (field === 'data') event.data = event.data === undefined ? value : event.data + '\n' + value;
        else if (field === 'event') event.event = value;
        else if (field === 'id') event.id = value;
        else if (field === 'retry') event.retry = Number(value) || 0;
      });
      if (event.data !== undefined || event.event || event.id) events.push(event);
      return events.map(parseSseEventData).filter(Boolean);
    }

    function responseSessionId(resp) {
      if (!resp || !resp.headers) return '';
      return resp.headers.get('MCP-Session-Id') || resp.headers.get('mcp-session-id') || '';
    }

    function parseRpcResponse(resp, text, requestId) {
      if (resp.status === 202 && !text) return null;
      var contentType = resp.headers && resp.headers.get('content-type') || '';
      var messages;
      if (/text\/event-stream/i.test(contentType)) {
        messages = parseSseText(text);
      } else {
        var parsed = text ? JSON.parse(text) : null;
        messages = Array.isArray(parsed) ? parsed : [parsed];
      }
      messages = (messages || []).filter(Boolean);
      if (requestId === undefined || requestId === null) return messages[0] || null;
      var response = messages.filter(function (msg) {
        return msg && Object.prototype.hasOwnProperty.call(msg, 'id') && String(msg.id) === String(requestId);
      })[0];
      if (!response) throw new Error('HTTP MCP 响应中没有匹配的 JSON-RPC id: ' + requestId);
      if (response.error) throw new Error(jsonRpcErrorToMessage(response.error));
      return response.result === undefined ? null : response.result;
    }

    function handleServerMessage(server, session, msg) {
      if (!msg || typeof msg !== 'object') return Promise.resolve();
      var hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
      if (!hasId || !msg.method) return Promise.resolve();
      var response = {
        jsonrpc: '2.0',
        id: msg.id,
      };
      if (msg.method === 'ping') {
        response.result = {};
      } else {
        response.error = {
          code: -32601,
          message: 'Unsupported server request: ' + String(msg.method || ''),
        };
      }
      return postJsonRpc(server, response, session, 30000).catch(function (err) {
        log('HTTP MCP 服务端请求响应失败: ' + (err && err.message ? err.message : String(err)), { level: 'warn' });
      });
    }

    function readSseResponse(server, session, resp, requestId) {
      var reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      if (!reader) {
        return resp.text().then(function (text) {
          return {
            result: parseRpcResponse(resp, text, requestId),
            sessionId: responseSessionId(resp),
          };
        });
      }
      var decoder = new TextDecoder();
      var buffer = '';
      var event = {};
      var sessionId = responseSessionId(resp);

      function dispatchEvent(current) {
        var msg = parseSseEventData(current);
        if (!msg) return Promise.resolve(null);
        if (current.id && session) session.lastEventId = current.id;
        var isTarget = requestId !== undefined && requestId !== null
          && Object.prototype.hasOwnProperty.call(msg, 'id')
          && String(msg.id) === String(requestId);
        if (isTarget) {
          if (msg.error) throw new Error(jsonRpcErrorToMessage(msg.error));
          return Promise.resolve({
            matched: true,
            result: msg.result === undefined ? null : msg.result,
          });
        }
        return handleServerMessage(server, session, msg).then(function () { return null; });
      }

      function processLine(line) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) {
          var current = event;
          event = {};
          if (current.data !== undefined || current.event || current.id) return dispatchEvent(current);
          return Promise.resolve(null);
        }
        if (line.charAt(0) === ':') return Promise.resolve(null);
        var idx = line.indexOf(':');
        var field = idx === -1 ? line : line.slice(0, idx);
        var value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
        if (field === 'data') event.data = event.data === undefined ? value : event.data + '\n' + value;
        else if (field === 'event') event.event = value;
        else if (field === 'id') event.id = value;
        else if (field === 'retry' && session) session.retry = Number(value) || session.retry || 0;
        return Promise.resolve(null);
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            buffer += decoder.decode();
            var finalLine = buffer;
            buffer = '';
            var finalLineResult = finalLine ? processLine(finalLine) : Promise.resolve(null);
            return finalLineResult.then(function (lineResult) {
              if (lineResult && lineResult.matched) return lineResult;
              if (event.data === undefined && !event.event && !event.id) {
                throw new Error('HTTP MCP SSE 结束但没有匹配的 JSON-RPC id: ' + requestId);
              }
              return dispatchEvent(event).then(function (result) {
                if (result && result.matched) return result;
                throw new Error('HTTP MCP SSE 结束但没有匹配的 JSON-RPC id: ' + requestId);
              });
            });
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          var chain = Promise.resolve(null);
          lines.forEach(function (line) {
            chain = chain.then(function (matched) {
              if (matched) return matched;
              return processLine(line);
            });
          });
          return chain.then(function (matched) {
            if (matched && matched.matched) {
              try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {}
              return matched;
            }
            return pump();
          });
        });
      }

      return pump().then(function (matched) {
        return {
          result: matched ? matched.result : null,
          sessionId: sessionId,
        };
      });
    }

    function fetchWithTimeout(server, init, timeoutMs, consumeResponse) {
      var controller = new AbortController();
      var durationMs = normalizeTimeoutMs(timeoutMs || server.timeoutMs);
      var timer = setTimeout(function () {
        try { controller.abort(new Error('HTTP MCP 请求超时')); } catch (_) { controller.abort(); }
      }, durationMs);
      init = Object.assign({}, init || {}, { signal: controller.signal });
      return fetch(server.url, init).then(function (resp) {
        return consumeResponse(resp);
      }).catch(function (err) {
        if (controller.signal.aborted) {
          throw new Error('HTTP MCP 请求超时 (' + durationMs + 'ms)');
        }
        throw err;
      }).finally(function () {
        clearTimeout(timer);
      });
    }

    function postJsonRpc(server, message, session, timeoutMs) {
      if (!server.url) return Promise.reject(new Error('HTTP MCP URL 不能为空'));
      var bodyText = JSON.stringify(message);
      var hasSession = !!(session && session.sessionId);
      return fetchWithTimeout(server, {
        method: 'POST',
        headers: buildHeaders(server, session, { method: 'POST' }),
        body: bodyText,
      }, timeoutMs, function (resp) {
        if (resp.status === 404 && hasSession) {
          if (sessions[server.id] === session) delete sessions[server.id];
          var err = new Error('HTTP MCP session expired');
          err.sessionExpired = true;
          err.expiredSession = session;
          throw err;
        }
        var contentType = resp.headers && resp.headers.get('content-type') || '';
        if (resp.ok && /text\/event-stream/i.test(contentType)) {
          return readSseResponse(server, session, resp, message.id);
        }
        return resp.text().then(function (text) {
          if (!resp.ok && resp.status !== 202) {
            throw new Error('HTTP MCP 请求失败 HTTP ' + resp.status + ': ' + compactString(text, 600));
          }
          return {
            result: parseRpcResponse(resp, text, message.id),
            sessionId: responseSessionId(resp),
          };
        });
      });
    }

    function rpcRequest(server, method, params, options) {
      options = options || {};
      return ensureSession(server, { timeoutMs: options.timeoutMs }).then(function (session) {
        var message = {
          jsonrpc: '2.0',
          id: nowId('rpc'),
          method: method,
          params: params || {},
        };
        return postJsonRpc(server, message, session, options.timeoutMs).catch(function (err) {
          if (!err || !err.sessionExpired) throw err;
          return ensureSession(server, { force: true, expiredSession: err.expiredSession, timeoutMs: options.timeoutMs }).then(function (newSession) {
            return postJsonRpc(server, message, newSession, options.timeoutMs);
          });
        }).then(function (response) {
          return response.result;
        });
      });
    }

    function initializeSession(server, options) {
      options = options || {};
      if (!SUPPORTED_PROTOCOL_VERSIONS[server.protocolVersion || DEFAULT_PROTOCOL_VERSION]) {
        return Promise.reject(new Error('不支持的 MCP 协议版本: ' + (server.protocolVersion || DEFAULT_PROTOCOL_VERSION)));
      }
      var initialize = {
        jsonrpc: '2.0',
        id: nowId('rpc'),
        method: 'initialize',
        params: {
          protocolVersion: server.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: clientInfo,
        },
      };
      return postJsonRpc(server, initialize, null, options.timeoutMs || Math.max(server.timeoutMs, 30000)).then(function (response) {
        var result = response.result || {};
        var protocolVersion = String(result.protocolVersion || server.protocolVersion || DEFAULT_PROTOCOL_VERSION);
        if (!SUPPORTED_PROTOCOL_VERSIONS[protocolVersion]) {
          throw new Error('远端 MCP 返回了不支持的协议版本: ' + protocolVersion);
        }
        var session = {
          serverId: server.id,
          sessionId: response.sessionId || '',
          protocolVersion: protocolVersion,
          serverInfo: result.serverInfo || {},
          capabilities: result.capabilities || {},
          instructions: result.instructions || '',
          initializedAt: Date.now(),
        };
        var initialized = {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        };
        return postJsonRpc(server, initialized, session, options.timeoutMs || 30000).then(function () {
          // A session is usable only after the initialized notification has
          // completed. Caching earlier would preserve a half-open handshake.
          sessions[server.id] = session;
          return session;
        });
      });
    }

    function ensureSession(server, options) {
      options = options || {};
      if (options.force) {
        var current = sessions[server.id];
        if (current && options.expiredSession && current !== options.expiredSession) return Promise.resolve(current);
        if (!options.expiredSession || current === options.expiredSession) delete sessions[server.id];
      }
      if (sessions[server.id]) return Promise.resolve(sessions[server.id]);
      // Session-expiry recovery can race across concurrent RPC calls. Share the
      // fresh handshake even when every caller requested a forced refresh.
      if (sessionInitializations[server.id]) return sessionInitializations[server.id];
      var initialization = initializeSession(server, options).finally(function () {
        if (sessionInitializations[server.id] === initialization) delete sessionInitializations[server.id];
      });
      sessionInitializations[server.id] = initialization;
      return initialization;
    }

    function listToolsForServer(server, options) {
      options = options || {};
      var tools = [];
      var cursor = options.cursor || '';
      var pages = 0;
      function next() {
        pages += 1;
        if (pages > 20 || tools.length >= MAX_TOOLS_PER_SYNC) return Promise.resolve(tools);
        var params = cursor ? { cursor: cursor } : {};
        return rpcRequest(server, 'tools/list', params, options).then(function (result) {
          result = result || {};
          (Array.isArray(result.tools) ? result.tools : []).forEach(function (tool) {
            if (tools.length < MAX_TOOLS_PER_SYNC) tools.push(compactTool(tool));
          });
          cursor = String(result.nextCursor || '');
          return cursor ? next() : tools;
        });
      }
      return ensureSession(server, { timeoutMs: options.timeoutMs }).then(function (session) {
        if (!session.capabilities || !session.capabilities.tools) {
          throw new Error('远端 MCP Server 未声明 tools capability，不能读取 tools/list');
        }
        return next();
      });
    }

    function updateServerAfterProbe(server, patch) {
      return update(function (state) {
        var existing = state.servers[server.id] || server;
        state.servers[server.id] = normalizeServer(Object.assign({}, existing, patch || {}, { updatedAt: Date.now() }));
        return state;
      }).then(function (state) {
        return state.servers[server.id];
      });
    }

    function testServer(input) {
      var serverPromise = input && input.server ? Promise.resolve(normalizeServer(input.server)) : getServer(input && (input.id || input.serverId));
      return serverPromise.then(function (server) {
        if (!server.enabled) throw new Error('HTTP MCP Server 已停用: ' + server.id);
        return listToolsForServer(server, { timeoutMs: input && input.timeoutMs }).then(function (tools) {
          return updateServerAfterProbe(server, {
            tools: tools,
            lastStatus: 'ok',
            lastError: '',
            lastTestedAt: Date.now(),
            serverInfo: sessions[server.id] && sessions[server.id].serverInfo || {},
            capabilities: sessions[server.id] && sessions[server.id].capabilities || {},
            serverInstructions: sessions[server.id] && sessions[server.id].instructions || '',
          }).then(function (saved) {
            log('HTTP MCP 连接成功: ' + server.name + ' tools=' + tools.length);
            return {
              provider: 'http-mcp-client',
              ok: true,
              server: redactServer(saved),
              toolCount: tools.length,
              tools: tools,
            };
          });
        }).catch(function (err) {
          return updateServerAfterProbe(server, {
            lastStatus: 'error',
            lastError: err && err.message ? err.message : String(err),
            lastTestedAt: Date.now(),
          }).then(function (saved) {
            throw Object.assign(new Error(saved.lastError), { server: redactServer(saved) });
          });
        });
      });
    }

    function knowledgeKey(server, tool) {
      return 'mcp-http:' + server.id + ':tool:' + String(tool.name || '').trim();
    }

    function toolKnowledgeContent(server, tool) {
      var lines = [
        '远端 MCP Streamable HTTP 工具。',
        '',
        'Server ID: ' + server.id,
        'Server: ' + server.name,
        'Endpoint: ' + server.url,
        'Tool: ' + tool.name,
      ];
      if (tool.title) lines.push('Title: ' + tool.title);
      if (tool.description) lines.push('Description: ' + tool.description);
      if (server.serverInstructions) {
        lines.push('', 'Server Instructions:', server.serverInstructions);
      }
      lines.push('', 'Input Schema:', JSON.stringify(tool.inputSchema || { type: 'object' }, null, 2));
      if (tool.outputSchema) lines.push('', 'Output Schema:', JSON.stringify(tool.outputSchema, null, 2));
      if (tool.execution) lines.push('', 'Execution:', JSON.stringify(tool.execution, null, 2));
      lines.push('', '对话调用方式:', '使用 call_http_mcp_tool({ serverId: "' + server.id + '", toolName: "' + tool.name + '", arguments: { ... }, timeoutMs }) 调用。');
      return lines.join('\n');
    }

    function upsertToolKnowledge(server, tool) {
      if (!knowledge || typeof knowledge.upsert !== 'function') return Promise.resolve(null);
      var title = 'MCP HTTP 工具: ' + (tool.title || tool.name);
      var summary = (server.name ? server.name + ' / ' : '') + (tool.description || tool.name);
      var tags = ['MCP', 'HTTP MCP', 'Streamable HTTP', server.name, tool.name].filter(Boolean);
      return knowledge.upsert({
        type: 'mcp',
        sourceKind: 'mcp',
        remoteSync: true,
        title: title,
        summary: compactString(summary, 700),
        content: toolKnowledgeContent(server, tool),
        tags: tags,
        source: {
          kind: 'mcp',
          key: knowledgeKey(server, tool),
          toolName: tool.name,
          uri: server.url,
          remoteSync: true,
          managed: 'remote',
        },
        confidence: 0.9,
        archived: false,
      });
    }

    function archiveStaleKnowledge(server, liveKeys) {
      if (!knowledge || typeof knowledge.list !== 'function' || typeof knowledge.upsert !== 'function') return Promise.resolve({ archived: 0 });
      var archived = 0;
      var cursor = 0;
      function page() {
        return knowledge.list({ sourceKind: 'mcp', includeArchived: true, cursor: cursor, limit: 120 }).then(function (result) {
          var items = result && result.items || [];
          var chain = Promise.resolve();
          items.forEach(function (item) {
            var key = item && item.source && item.source.key || '';
            if (key.indexOf('mcp-http:' + server.id + ':tool:') !== 0 || liveKeys[key] || item.archived) return;
            chain = chain.then(function () {
              archived += 1;
              return knowledge.upsert({
                id: item.id,
                title: item.title,
                content: item.summary || item.title,
                sourceKind: 'mcp',
                remoteSync: true,
                source: Object.assign({}, item.source || {}, { remoteSync: true, managed: 'remote' }),
                archived: true,
              });
            });
          });
          return chain.then(function () {
            cursor = result && result.nextCursor !== null && result.nextCursor !== undefined ? result.nextCursor : null;
            return cursor !== null ? page() : { archived: archived };
          });
        });
      }
      return page();
    }

    function archiveServerKnowledge(serverId) {
      return archiveStaleKnowledge({ id: String(serverId || '') }, {});
    }

    function deleteServerKnowledge(serverId) {
      serverId = String(serverId || '').trim();
      if (!serverId) return Promise.resolve({ deleted: 0 });
      if (!knowledge || typeof knowledge.removeManagedSource !== 'function') {
        return Promise.reject(new Error('Knowledge 不支持 MCP 同步知识硬删除'));
      }
      return knowledge.removeManagedSource({
        sourceKind: 'mcp',
        sourceKeyPrefix: 'mcp-http:' + serverId + ':tool:',
      });
    }

    function findSyncedTool(server, toolName) {
      var wanted = String(toolName || '').trim();
      var tools = Array.isArray(server.tools) ? server.tools : [];
      for (var i = 0; i < tools.length; i++) {
        if (String(tools[i] && tools[i].name || '').trim() === wanted) return tools[i];
      }
      return null;
    }

    function schemaTypeOf(value) {
      if (Array.isArray(value)) return 'array';
      if (value === null) return 'null';
      return typeof value;
    }

    function stableJsonValue(value) {
      if (Array.isArray(value)) return value.map(stableJsonValue);
      if (!value || typeof value !== 'object') return value;
      var out = {};
      Object.keys(value).sort().forEach(function (key) {
        out[key] = stableJsonValue(value[key]);
      });
      return out;
    }

    function jsonValuesEqual(left, right) {
      try { return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right)); } catch (_) { return left === right; }
    }

    function resolveLocalSchemaRef(rootSchema, ref) {
      if (ref === '#') return rootSchema;
      if (String(ref || '').indexOf('#/') !== 0) return undefined;
      var current = rootSchema;
      var parts = String(ref).slice(2).split('/').map(function (part) {
        return part.replace(/~1/g, '/').replace(/~0/g, '~');
      });
      for (var i = 0; i < parts.length; i++) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, parts[i])) return undefined;
        current = current[parts[i]];
      }
      return current;
    }

    function validateJsonSchemaValue(schema, value, path, errors, rootSchema, refTrail) {
      path = path || '$';
      errors = errors || [];
      if (rootSchema === undefined) rootSchema = schema;
      refTrail = refTrail || {};
      if (schema === true || schema === undefined || schema === null) return errors;
      if (schema === false) {
        errors.push(path + ' 被 false schema 禁止');
        return errors;
      }
      schema = typeof schema === 'object' ? schema : {};
      if (schema.$ref !== undefined) {
        var ref = String(schema.$ref || '');
        var resolved = resolveLocalSchemaRef(rootSchema, ref);
        var refKey = ref + '@' + path;
        if (resolved === undefined) {
          errors.push(path + ' 包含无法解析或非本地的 schema.$ref: ' + ref);
        } else if (refTrail[refKey]) {
          errors.push(path + ' 包含循环 schema.$ref: ' + ref);
        } else {
          var nextRefTrail = Object.assign({}, refTrail);
          nextRefTrail[refKey] = true;
          validateJsonSchemaValue(resolved, value, path, errors, rootSchema, nextRefTrail);
        }
      }
      if (Array.isArray(schema.allOf)) {
        schema.allOf.forEach(function (branch) {
          validateJsonSchemaValue(branch, value, path, errors, rootSchema, refTrail);
        });
      }
      if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
        var anyMatches = schema.anyOf.some(function (branch) {
          return validateJsonSchemaValue(branch, value, path, [], rootSchema, refTrail).length === 0;
        });
        if (!anyMatches) errors.push(path + ' 不符合 anyOf 中的任何一种结构');
      }
      if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
        var oneMatches = schema.oneOf.reduce(function (count, branch) {
          return count + (validateJsonSchemaValue(branch, value, path, [], rootSchema, refTrail).length === 0 ? 1 : 0);
        }, 0);
        if (oneMatches !== 1) errors.push(path + ' 必须且只能符合 oneOf 中的一种结构');
      }
      if (schema.not && validateJsonSchemaValue(schema.not, value, path, [], rootSchema, refTrail).length === 0) {
        errors.push(path + ' 不得符合 schema.not');
      }
      if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
        if (!jsonValuesEqual(schema.const, value)) errors.push(path + ' 必须等于 schema.const');
      }
      if (Array.isArray(schema.enum) && schema.enum.length) {
        var ok = schema.enum.some(function (item) {
          return jsonValuesEqual(item, value);
        });
        if (!ok) errors.push(path + ' 必须是枚举值之一');
      }
      var types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
      if (types.length) {
        var actual = schemaTypeOf(value);
        var typeOk = types.some(function (type) {
          if (type === 'integer') return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
          if (type === 'number') return typeof value === 'number' && isFinite(value);
          if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
          return actual === type;
        });
        if (!typeOk) {
          errors.push(path + ' 类型不匹配，期望 ' + types.join('|') + '，实际 ' + actual);
          return errors;
        }
      }
      if (typeof value === 'string') {
        var stringLength = Array.from(value).length;
        if (schema.minLength !== undefined && stringLength < Number(schema.minLength)) {
          errors.push(path + ' 长度不能小于 ' + schema.minLength);
        }
        if (schema.maxLength !== undefined && stringLength > Number(schema.maxLength)) {
          errors.push(path + ' 长度不能大于 ' + schema.maxLength);
        }
        if (schema.pattern !== undefined) {
          try {
            if (!(new RegExp(String(schema.pattern))).test(value)) errors.push(path + ' 不符合 pattern: ' + schema.pattern);
          } catch (_) {
            errors.push(path + ' 的 schema.pattern 无效');
          }
        }
      }
      if (typeof value === 'number' && isFinite(value)) {
        if (schema.minimum !== undefined && value < Number(schema.minimum)) errors.push(path + ' 不能小于 ' + schema.minimum);
        if (schema.maximum !== undefined && value > Number(schema.maximum)) errors.push(path + ' 不能大于 ' + schema.maximum);
        if (schema.exclusiveMinimum !== undefined && value <= Number(schema.exclusiveMinimum)) errors.push(path + ' 必须大于 ' + schema.exclusiveMinimum);
        if (schema.exclusiveMaximum !== undefined && value >= Number(schema.exclusiveMaximum)) errors.push(path + ' 必须小于 ' + schema.exclusiveMaximum);
        if (schema.multipleOf !== undefined) {
          var divisor = Number(schema.multipleOf);
          if (!(divisor > 0) || Math.abs(value / divisor - Math.round(value / divisor)) > 1e-10) {
            errors.push(path + ' 必须是 ' + schema.multipleOf + ' 的倍数');
          }
        }
      }
      var hasObjectConstraints = schema.type === 'object'
        || types.indexOf('object') !== -1
        || schema.properties
        || schema.required
        || schema.additionalProperties !== undefined
        || schema.minProperties !== undefined
        || schema.maxProperties !== undefined;
      if (hasObjectConstraints && value && typeof value === 'object' && !Array.isArray(value)) {
        var required = Array.isArray(schema.required) ? schema.required : [];
        required.forEach(function (key) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(path + '.' + key + ' 为必填');
        });
        Object.keys(schema.properties || {}).forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            validateJsonSchemaValue(schema.properties[key], value[key], path + '.' + key, errors, rootSchema, refTrail);
          }
        });
        var propertyKeys = Object.keys(schema.properties || {});
        var valueKeys = Object.keys(value);
        if (schema.minProperties !== undefined && valueKeys.length < Number(schema.minProperties)) {
          errors.push(path + ' 属性数量不能小于 ' + schema.minProperties);
        }
        if (schema.maxProperties !== undefined && valueKeys.length > Number(schema.maxProperties)) {
          errors.push(path + ' 属性数量不能大于 ' + schema.maxProperties);
        }
        valueKeys.forEach(function (key) {
          if (propertyKeys.indexOf(key) !== -1) return;
          if (schema.additionalProperties === false) {
            errors.push(path + '.' + key + ' 是 schema 不允许的额外属性');
          } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
            validateJsonSchemaValue(schema.additionalProperties, value[key], path + '.' + key, errors, rootSchema, refTrail);
          }
        });
      }
      if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < Number(schema.minItems)) errors.push(path + ' 元素数量不能小于 ' + schema.minItems);
        if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) errors.push(path + ' 元素数量不能大于 ' + schema.maxItems);
        if (schema.uniqueItems === true) {
          for (var i = 0; i < value.length; i++) {
            for (var j = i + 1; j < value.length; j++) {
              if (jsonValuesEqual(value[i], value[j])) errors.push(path + ' 元素必须唯一');
            }
          }
        }
        if (Array.isArray(schema.items)) {
          schema.items.forEach(function (itemSchema, index) {
            if (index < value.length) validateJsonSchemaValue(itemSchema, value[index], path + '[' + index + ']', errors, rootSchema, refTrail);
          });
        } else if (schema.items) {
          value.forEach(function (item, index) {
            validateJsonSchemaValue(schema.items, item, path + '[' + index + ']', errors, rootSchema, refTrail);
          });
        }
      }
      return errors;
    }

    function validateToolArguments(tool, args) {
      var schema = tool && Object.prototype.hasOwnProperty.call(tool, 'inputSchema')
        ? tool.inputSchema
        : { type: 'object' };
      var errors = validateJsonSchemaValue(schema, args || {}, '$', []);
      if (errors.length) {
        throw new Error('HTTP MCP 工具参数不符合 inputSchema: ' + errors.slice(0, 6).join('; '));
      }
    }

    function syncServer(input) {
      input = input || {};
      return getServer(input.id || input.serverId).then(function (server) {
        if (!server.enabled) throw new Error('HTTP MCP Server 已停用: ' + server.id);
        return listToolsForServer(server, { timeoutMs: input.timeoutMs }).then(function (tools) {
          var session = sessions[server.id] || {};
          var liveKeys = {};
          var savedServer;
          return updateServerAfterProbe(server, {
            tools: tools,
            syncedAt: Date.now(),
            lastStatus: 'ok',
            lastError: '',
            lastTestedAt: Date.now(),
            serverInfo: session.serverInfo || {},
            capabilities: session.capabilities || {},
            serverInstructions: session.instructions || '',
          }).then(function (updated) {
            savedServer = updated;
            var chain = Promise.resolve();
            tools.forEach(function (tool) {
              liveKeys[knowledgeKey(savedServer, tool)] = true;
              chain = chain.then(function () { return upsertToolKnowledge(savedServer, tool); });
            });
            return chain;
          }).then(function () {
            return archiveStaleKnowledge(savedServer, liveKeys);
          }).then(function (stale) {
            log('HTTP MCP 工具已同步到知识: ' + savedServer.name + ' tools=' + tools.length);
            return {
              provider: 'http-mcp-client',
              ok: true,
              server: redactServer(savedServer),
              synced: tools.length,
              archived: stale && stale.archived || 0,
              tools: tools,
            };
          });
        }).catch(function (err) {
          return updateServerAfterProbe(server, {
            lastStatus: 'error',
            lastError: err && err.message ? err.message : String(err),
            lastTestedAt: Date.now(),
          }).then(function () {
            throw err;
          });
        });
      });
    }

    function callTool(input) {
      input = input || {};
      var serverId = String(input.serverId || input.id || '').trim();
      var toolName = String(input.toolName || input.name || '').trim();
      if (!serverId) return Promise.reject(new Error('call_http_mcp_tool 缺少 serverId'));
      if (!toolName) return Promise.reject(new Error('call_http_mcp_tool 缺少 toolName'));
      return getServer(serverId).then(function (server) {
        if (!server.enabled) throw new Error('HTTP MCP Server 已停用: ' + server.id);
        var tool = findSyncedTool(server, toolName);
        if (!tool) throw new Error('HTTP MCP 工具未在已同步目录中，先同步 P3 知识后再调用: ' + server.id + '/' + toolName);
        var args = input.arguments !== undefined ? input.arguments : (input.args || {});
        validateToolArguments(tool, args || {});
        var timeoutMs = normalizeTimeoutMs(input.timeoutMs || server.timeoutMs);
        return ensureSession(server, { timeoutMs: timeoutMs }).then(function (session) {
          if (!session.capabilities || !session.capabilities.tools) {
            throw new Error('远端 MCP Server 未声明 tools capability，不能调用 tools/call');
          }
          return rpcRequest(server, 'tools/call', { name: toolName, arguments: args || {} }, { timeoutMs: timeoutMs });
        }).then(function (result) {
          log('HTTP MCP 工具调用完成: ' + server.name + '/' + toolName);
          return {
            provider: 'http-mcp-client',
            serverId: server.id,
            serverName: server.name,
            toolName: toolName,
            timeoutMs: timeoutMs,
            result: result,
          };
        });
      });
    }

    return {
      STORAGE_KEY: storageKey,
      listServers: listServers,
      getServer: getServer,
      upsertServer: upsertServer,
      removeServer: removeServer,
      testServer: testServer,
      syncServer: syncServer,
      callTool: callTool,
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    createHttpMcpManager: createHttpMcpManager,
  };
});
