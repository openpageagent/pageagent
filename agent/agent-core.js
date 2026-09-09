// Per-generation Page Agent resource projection. It owns no conversation or generation state.
(function attachAgentCore(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var api = factory(commonJs ? {
    arp: require('../resources/protocol/index.js'),
    projection: require('./tool-result-projection.js'),
  } : {
    arp: root.AgentResourceProtocol,
    projection: root.AgentToolResultProjection,
  });
  if (commonJs) module.exports = api;
  else root.AgentCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var API_VERSION = 1;
  var arp = deps.arp;
  var projection = deps.projection;
  // Keep this defensive runtime floor aligned with
  // ConversationProfileSchema.PAGE_AGENT_CORE_PERMISSION_SCOPE.
  var CORE_PERMISSION_SCOPE = Object.freeze([
    'page.read', 'page.interact',
    'browser.read', 'browser.tabs.write', 'browser.navigate',
    'flows.read', 'flows.write', 'flows.nodes.read', 'flows.nodes.write',
    'flow-groups.read', 'flow-groups.write', 'node-types.read', 'recordings.read',
    'runs.read', 'runs.report.read', 'runs.debug.read', 'runs.execute',
    'pages.read', 'pages.write',
    'url-triggers.read', 'url-triggers.write',
    'scripts.read', 'scripts.write',
    'schedules.read', 'schedules.write',
    'knowledge.read', 'knowledge.write', 'skills.read', 'assistants.read',
  ]);
  var CORE_ROOT_METHODS = Object.freeze({
    '/page': Object.freeze(['GET', 'POST', 'OPTIONS']),
    '/browser': Object.freeze(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']),
    '/flows': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/node-types': Object.freeze(['GET', 'OPTIONS']),
    '/flow-groups': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/recordings': Object.freeze(['GET', 'OPTIONS']),
    '/runs': Object.freeze(['GET', 'OPTIONS']),
    '/knowledge': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/skills': Object.freeze(['GET', 'OPTIONS']),
    '/assistants': Object.freeze(['GET', 'OPTIONS']),
    '/pages': Object.freeze(['GET', 'POST', 'PATCH', 'OPTIONS']),
    '/url-triggers': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/scripts': Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']),
    '/schedules': Object.freeze(['GET', 'POST', 'PATCH', 'OPTIONS']),
    // /current is an internal, permission-free ground-truth clock resource;
    // it is intentionally not an editable Assistant resource root.
    '/current': Object.freeze(['GET', 'OPTIONS']),
  });
  var RESOURCE_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value).trim(); }
  function selectedResourceIds(value) {
    var seen = Object.create(null);
    return (Array.isArray(value) ? value : []).map(text).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }
  function uriSegment(value) {
    return encodeURIComponent(text(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  function requestPath(uri, method) {
    try {
      return arp && typeof arp.parseRequestTarget === 'function'
        ? arp.parseRequestTarget(text(uri), text(method).toUpperCase()).path
        : text(uri).split('?')[0];
    } catch (_) { return ''; }
  }
  function requestTarget(uri, query) {
    return arp && typeof arp.buildRequestTarget === 'function'
      ? arp.buildRequestTarget(uri, query || {}) : text(uri);
  }
  function canonicalResourceUri(value) {
    var raw = String(value === undefined || value === null ? '' : value);
    if (!raw) return '/';
    try { return arp.canonicalizeUri(raw, { allowRoot: true }); } catch (_) { return '/'; }
  }
  function decodedSegment(value) {
    try { return decodeURIComponent(String(value || '')); } catch (_) { return ''; }
  }
  function selectedMcpRoute(assistant, method, uri) {
    var selected = selectedResourceIds(assistant && assistant.mcpServerIds);
    method = text(method).toUpperCase();
    uri = text(uri);
    if (/^\/mcp-calls(?:\/|$)/.test(uri)) {
      if (!selected.length) return { allowed: false, requiredPermission: 'mcp-calls.read' };
      if (method === 'GET' || method === 'OPTIONS') {
        return { allowed: true, requiredPermission: 'mcp-calls.read' };
      }
      return { allowed: false, requiredPermission: 'mcp-calls.read' };
    }
    var serverMatch = /^\/mcp-servers\/([^/]+)(?:\/|$)/.exec(uri);
    if (!serverMatch) {
      return /^\/mcp-servers(?:\/|$)/.test(uri)
        ? { allowed: false, requiredPermission: 'mcp-servers.read' }
        : null;
    }
    var serverId = decodedSegment(serverMatch[1]);
    if (selected.indexOf(serverId) === -1) {
      return { allowed: false, serverId: serverId, requiredPermission: method === 'POST' ? 'mcp-servers.call' : 'mcp-servers.read' };
    }
    if (method === 'GET') return { allowed: true, serverId: serverId, requiredPermission: 'mcp-servers.read' };
    if (method === 'OPTIONS') return { allowed: true, serverId: serverId, requiredPermission: 'mcp-servers.read' };
    if (method === 'POST' && /^\/mcp-servers\/[^/]+\/tools\/[^/]+\/calls$/.test(uri)) {
      return { allowed: true, serverId: serverId, requiredPermission: 'mcp-servers.call' };
    }
    return { allowed: false, serverId: serverId, requiredPermission: 'mcp-servers.call' };
  }
  function routerFrom(runtime) {
    var router = runtime && runtime.router ? runtime.router : runtime;
    if (!router || typeof router.dispatch !== 'function' || !router.registry) {
      throw new TypeError('AgentCore requires the canonical ARP Resource Runtime');
    }
    return router;
  }
  function resourcePermissionCatalog(runtime) {
    var catalog = Object.create(null);
    var router = runtime && runtime.router ? runtime.router : runtime;
    var routes = router && router.registry && router.registry.routes || [];
    routes.forEach(function (entry) {
      var route = entry && entry.route;
      if (!route) return;
      var rootUri = '/' + route.root;
      var methods = catalog[rootUri] || (catalog[rootUri] = Object.create(null));
      Object.keys(route.methods || {}).forEach(function (method) {
        var permissions = methods[method] || (methods[method] = []);
        (route.methods[method].permissions || []).forEach(function (permission) {
          if (permissions.indexOf(permission) === -1) permissions.push(permission);
        });
      });
      methods.OPTIONS = methods.OPTIONS || [];
    });
    return catalog;
  }
  function normalizedPolicy(assistant, catalog) {
    var policy = assistant && assistant.resourcePolicy;
    var roots = policy && policy.roots && typeof policy.roots === 'object' ? policy.roots : null;
    var output = Object.create(null);
    Object.keys(catalog).forEach(function (rootUri) {
      var configured = roots && roots[rootUri];
      var methods = configured && Array.isArray(configured.methods)
        ? configured.methods : (CORE_ROOT_METHODS[rootUri] || ['OPTIONS']);
      output[rootUri] = methods.map(function (method) { return text(method).toUpperCase(); }).filter(function (method) {
        return RESOURCE_METHODS.indexOf(method) !== -1;
      });
      if (rootUri === '/recordings' && output[rootUri].indexOf('GET') === -1) output[rootUri].push('GET');
      if (output[rootUri].indexOf('OPTIONS') === -1) output[rootUri].push('OPTIONS');
      (CORE_ROOT_METHODS[rootUri] || []).forEach(function (method) {
        if (output[rootUri].indexOf(method) === -1) output[rootUri].push(method);
      });
      output[rootUri] = RESOURCE_METHODS.filter(function (method) {
        return output[rootUri].indexOf(method) !== -1;
      });
    });
    return output;
  }
  function derivePermissionScope(runtime, assistant, ceiling) {
    var catalog = resourcePermissionCatalog(runtime);
    var policy = normalizedPolicy(assistant || {}, catalog);
    var selected = Object.create(null);
    Object.keys(policy).forEach(function (rootUri) {
      policy[rootUri].forEach(function (method) {
        (catalog[rootUri] && catalog[rootUri][method] || []).forEach(function (permission) { selected[permission] = true; });
      });
    });
    var configured = assistant && assistant.resourcePolicy && assistant.resourcePolicy.permissions;
    if (Array.isArray(configured)) {
      var explicit = Object.create(null);
      configured.map(text).filter(Boolean).forEach(function (permission) { explicit[permission] = true; });
      Object.keys(selected).forEach(function (permission) {
        if (!explicit[permission]) delete selected[permission];
      });
    }
    CORE_PERMISSION_SCOPE.forEach(function (permission) { selected[permission] = true; });
    if (selectedResourceIds(assistant && assistant.mcpServerIds).length) {
      selected['mcp-servers.read'] = true;
      selected['mcp-servers.call'] = true;
      selected['mcp-calls.read'] = true;
    }
    if (Array.isArray(ceiling) && ceiling.length) {
      var allowed = Object.create(null);
      ceiling.map(text).filter(Boolean).forEach(function (permission) { allowed[permission] = true; });
      Object.keys(selected).forEach(function (permission) { if (!allowed[permission]) delete selected[permission]; });
    }
    return Object.keys(selected).sort();
  }
  function allowedToolNames(runtime, assistant, ceiling) {
    var catalog = resourcePermissionCatalog(runtime);
    var policy = normalizedPolicy(assistant || {}, catalog);
    var effectiveCeiling = Array.isArray(ceiling) && ceiling.length
      ? ceiling : derivePermissionScope(runtime, assistant);
    var ceilingSet = Object.create(null);
    effectiveCeiling.map(text).filter(Boolean).forEach(function (permission) { ceilingSet[permission] = true; });
    var selected = Object.create(null);
    Object.keys(policy).forEach(function (rootUri) {
      policy[rootUri].forEach(function (method) {
        if (ceilingSet) {
          var required = catalog[rootUri] && catalog[rootUri][method] || [];
          if (required.length && !required.some(function (permission) { return !!ceilingSet[permission]; })) return;
        }
        selected[method] = true;
      });
    });
    if (selectedResourceIds(assistant && assistant.mcpServerIds).length) {
      if (ceilingSet['mcp-servers.read'] || ceilingSet['mcp-calls.read']) selected.GET = true;
      if (ceilingSet['mcp-servers.call']) selected.POST = true;
    }
    selected.ASK_USER = true;
    return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ASK_USER'].filter(function (name) { return selected[name]; });
  }
  function toolCallDecision(runtime, assistant, ceiling, call) {
    call = call && typeof call === 'object' ? call : {};
    var method = text(call.name).toUpperCase();
    if (method === 'ASK_USER') return { allowed: true };
    var catalog = resourcePermissionCatalog(runtime);
    var policy = normalizedPolicy(assistant || {}, catalog);
    var exposed = allowedToolNames(runtime, assistant, ceiling);
    if (exposed.indexOf(method) === -1) {
      return denied('当前 Assistant 未开放所请求的资源方法', {
        method: method,
      });
    }
    var args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? call.arguments : {};
    var uri = text(args.uri);
    // The fixed tool schema owns missing/malformed uri errors. Let Router
    // return INVALID_REQUEST instead of misclassifying a format error as a
    // capability denial during this permission-only preflight.
    if (!uri) return { allowed: true };
    var routeUri = requestPath(uri, method);
    var selectedMcp = selectedMcpRoute(assistant, method, routeUri);
    if (selectedMcp) {
      if (!selectedMcp.allowed) {
        return denied('所请求的 MCP Server 未被当前 Assistant 选择', {
          method: method, uri: uri, serverId: selectedMcp.serverId,
        });
      }
      var selectedScope = Array.isArray(ceiling) && ceiling.length
        ? ceiling : derivePermissionScope(runtime, assistant);
      if (selectedScope.indexOf(selectedMcp.requiredPermission) === -1) {
        return denied('当前入口权限上限不允许使用所选 MCP 能力', {
          method: method, uri: uri, missingPermissions: [selectedMcp.requiredPermission],
        });
      }
      if (method === 'OPTIONS') return { allowed: true };
      var selectedRouter = routerFrom(runtime);
      var selectedResolved;
      try { selectedResolved = selectedRouter.registry.resolve(routeUri, method); } catch (_) { selectedResolved = null; }
      if (!selectedResolved || !selectedResolved.methodContract) {
        // Server selection is an authorization fact, not a substitute for
        // route resolution. Let the central Router return the precise 404/405.
        return { allowed: true };
      }
      return { allowed: true, route: selectedResolved.route, methodContract: selectedResolved.methodContract };
    }
    // OPTIONS is resolved by the protocol introspector, not a normal route
    // method contract. Its exposure is still controlled by allowedToolNames.
    if (method === 'OPTIONS') return { allowed: true };
    var router = routerFrom(runtime);
    var resolved;
    try { resolved = router.registry.resolve(routeUri, method); } catch (_) { resolved = null; }
    if (!resolved || !resolved.methodContract) {
      // 路径不存在和方法不支持属于 ARP Router 的 404/405 合同，不是
      // Assistant 权限拒绝。这里放行到零副作用的 Router resolve 阶段，
      // 由中央协议层返回精确错误和恢复信息。
      return { allowed: true };
    }
    var rootUri = '/' + text(resolved.route && resolved.route.root);
    if (!policy[rootUri] || policy[rootUri].indexOf(method) === -1) {
      return denied('Assistant 策略不允许在所请求的资源根上使用此方法', {
        method: method, uri: uri, resourceRoot: rootUri,
      });
    }
    var scope = Array.isArray(ceiling) && ceiling.length
      ? ceiling : derivePermissionScope(runtime, assistant);
    var missing = (resolved.methodContract.permissions || []).filter(function (permission) {
      return scope.indexOf(permission) === -1;
    });
    if (missing.length) {
      return denied('当前 Assistant 策略未授权此资源路由', {
        method: method, uri: uri, missingPermissions: missing,
      });
    }
    return { allowed: true, route: resolved.route, methodContract: resolved.methodContract };
  }
  function routeProbeUri(route, assistant) {
    if (!route || typeof route.build !== 'function') return '';
    var selectedMcpServerIds = selectedResourceIds(assistant && assistant.mcpServerIds);
    var params = Object.create(null);
    (route.compiled && route.compiled.parameterNames || []).forEach(function (name) {
      params[name] = name === 'serverId' && selectedMcpServerIds.length
        ? selectedMcpServerIds[0] : 'catalog';
    });
    try { return route.build(params); } catch (_) { return ''; }
  }
  function deriveAllowedRouteMethods(runtime, assistant, ceiling) {
    var router = routerFrom(runtime);
    var output = Object.create(null);
    router.registry.listRoutes().slice().sort(function (left, right) {
      return left.template.localeCompare(right.template);
    }).forEach(function (route) {
      var uri = routeProbeUri(route, assistant);
      if (!uri) return;
      var methods = RESOURCE_METHODS.filter(function (method) {
        if (!route.methods[method]) return false;
        return toolCallDecision(runtime, assistant, ceiling, {
          name: method,
          arguments: { uri: uri },
        }).allowed === true;
      });
      if (methods.length) output[route.template] = methods;
    });
    return output;
  }
  function denied(message, details) { return { allowed: false, code: 'FORBIDDEN', message: message, details: details || undefined }; }
  // 入口（page/sidepanel/options/scheduled/mcp）只描述"当前状态"，不构成能力边界：
  // 授权只由助手策略的权限范围决定。/page/* 需要目标 tab 是事实约束（没有 tab
  // 就没有页面），由 PageService 在解析目标 tab 时给出可行动的错误，而非在此拦截。
  function authorizeResourceRequest(input) {
    input = input || {};
    var descriptor = input.descriptor || {};
    var context = input.context || {};
    var route = input.route || {};
    var request = input.request || {};
    var allowedRouteMethods = context.allowedRouteMethods && typeof context.allowedRouteMethods === 'object'
      ? context.allowedRouteMethods : null;
    if (allowedRouteMethods && route.template) {
      var allowedMethods = Array.isArray(allowedRouteMethods[route.template])
        ? allowedRouteMethods[route.template] : [];
      var method = text(request.method || descriptor.method).toUpperCase();
      if (allowedMethods.indexOf(method) === -1) {
        return denied('当前 Assistant 策略未开放此资源路由方法', {
          method: method,
          uri: text(request.uri || descriptor.href),
          routeTemplate: route.template,
        });
      }
    }
    var scope = Array.isArray(context.permissionScope) ? context.permissionScope : [];
    var missing = (descriptor.requiredPermissions || []).filter(function (permission) { return scope.indexOf(permission) === -1; });
    if (missing.length) return denied('当前 Assistant 策略未授予此资源权限', { missingPermissions: missing });
    return { allowed: true };
  }
  function responseError(response) {
    if (!response || !response.error) return null;
    var error = new Error(text(response.error.message || response.error.code || '资源请求失败'));
    error.code = text(response.error.code) || 'RESOURCE_REQUEST_FAILED';
    error.retryable = response.error.retryable === true;
    error.performed = text(response.receipt && response.receipt.performed || response.error.performed) || 'no';
    error.receipt = clone(response.receipt || null);
    error.details = clone(response.error.details || {});
    if (response.error.stage) error.details = Object.assign({}, error.details, { stage: text(response.error.stage) });
    if (response.trace !== undefined) {
      error.details = Object.assign({}, error.details, { trace: clone(response.trace) });
    }
    error.stage = text(response.error.stage);
    error.current = clone(response.error.current || null);
    error.warnings = clone(response.warnings || []);
    return error;
  }

  function create(options) {
    options = options || {};
    if (!arp || typeof arp.createToolScope !== 'function') throw new Error('AgentResourceProtocol must load before AgentCore');
    if (!projection || typeof projection.projectArpResponse !== 'function') {
      throw new Error('AgentToolResultProjection must load before AgentCore');
    }
    var resourceRuntime = options.resourceRuntime;
    var router = routerFrom(resourceRuntime);

    function createGeneration(input, lease, assistant) {
      input = input || {};
      assistant = assistant || {};
      var entry = clone(input.entry || {});
      entry.currentResource = canonicalResourceUri(entry.currentResource);
      var surface = clone(input.surface || {});
      var trustedSurfacePageTarget = text(surface.type) === 'page' || text(surface.type) === 'sidepanel';
      var entryTabId = Number(entry.tabId) > 0 ? Number(entry.tabId) : 0;
      var surfaceTabId = trustedSurfacePageTarget && Number(surface.tabId) > 0 ? Number(surface.tabId) : 0;
      var entryContext = entry.type === 'page' ? 'page' : entry.type === 'scheduled' ? 'scheduled' : 'global';
      var context = {
        actorId: 'assistant:' + text(input.assistantId),
        conversationId: text(input.conversationId),
        generationId: text(lease.generationId),
        entryContext: entryContext,
        origin: text(entry.origin),
        permissionScope: derivePermissionScope(resourceRuntime, assistant, entry.permissionScope),
        selectedMcpServerIds: selectedResourceIds(assistant.mcpServerIds),
        currentResource: entry.currentResource,
        visibleResourceUris: Array.from(new Set([entry.currentResource].concat(
          Array.isArray(input.recordingVisibleResourceUris) ? input.recordingVisibleResourceUris.map(canonicalResourceUri).filter(Boolean) : []
        ))),
        // 入口只描述当前状态：page/sidepanel 面板附着的 tab 是有意义的默认目标页面；
        // options/scheduled/mcp 的 surface tab 是扩展自身 UI，不是自动化目标，
        // 这些入口通过请求里的显式 tabId 指定目标页面（见 page adapter）。
        currentTabId: entryTabId || surfaceTabId,
        currentWindowId: surfaceTabId && (!entryTabId || entryTabId === surfaceTabId)
          ? Number(surface.windowId) || 0 : 0,
        incognito: surface.incognito === true,
        profileId: text(assistant.profileId || 'default'),
        assistantInvocationKind: text(surface.assistantInvocationKind),
      };
      context.allowedRouteMethods = deriveAllowedRouteMethods(
        resourceRuntime,
        assistant,
        context.permissionScope
      );
      var canReadModelService = context.permissionScope.indexOf('model-services.read') !== -1;
      var selectedResourceContextPromise = null;
      var scope = arp.createToolScope({
        router: router,
        contextProvider: function () {
          var snapshot = clone(context);
          // Keep cancellation runtime-only. The non-enumerable property is
          // available to PageResourceAdapter but cannot enter ARP payloads,
          // journal records, or model context serialization.
          if (lease && lease.signal) Object.defineProperty(snapshot, 'abortSignal', {
            value: lease.signal, enumerable: false, configurable: false,
          });
          return snapshot;
        },
        askUser: function (request) {
          return lease.requestInteraction({
            kind: 'user_input', prompt: request.prompt,
            options: request.mode === 'choice' ? clone(request.choices || []) : [],
          }).then(function (resolved) { return { answer: clone(resolved.answer) }; });
        },
      });

      function responseData(response) {
        if (!response || response.error) return null;
        return response.primary && response.primary.data !== undefined ? response.primary.data : null;
      }

      async function readSelectedResource(uri, query) {
        var response = await scope.dispatch('GET', { uri: requestTarget(uri, clone(query || {})) });
        if (response && response.error) {
          var resourceError = new Error(text(response.error.message || response.error.code || '资源不可用'));
          resourceError.code = text(response.error.code) || 'RESOURCE_UNAVAILABLE';
          throw resourceError;
        }
        return responseData(response);
      }

      async function readSelectedCollection(uri) {
        var items = [];
        var cursor = '';
        var seen = Object.create(null);
        for (var pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          var query = { limit: 100 };
          if (cursor) query.cursor = cursor;
          var data = await readSelectedResource(uri, query);
          if (data && Array.isArray(data.items)) items = items.concat(data.items);
          var nextCursor = text(data && data.nextCursor);
          if (!nextCursor || seen[nextCursor]) break;
          seen[nextCursor] = true;
          cursor = nextCursor;
        }
        return items;
      }

      function selectedResourceContext() {
        if (selectedResourceContextPromise) return selectedResourceContextPromise;
        var skillIds = selectedResourceIds(assistant.skillIds);
        var mcpServerIds = selectedResourceIds(assistant.mcpServerIds);
        if (!skillIds.length && !mcpServerIds.length) return Promise.resolve(null);
        selectedResourceContextPromise = Promise.all([
          Promise.all(skillIds.map(async function (skillId) {
            try {
              var skill = await readSelectedResource('/skills/' + uriSegment(skillId));
              if (!skill || skill.enabled === false || skill.archived === true || !text(skill.instructions)) {
                throw new Error('Skill 已停用、归档或没有正文');
              }
              return {
                value: {
                  id: skillId,
                  name: text(skill.name || skillId),
                  description: String(skill.description || ''),
                  instructions: String(skill.instructions || ''),
                },
              };
            } catch (error) {
              return { warning: { kind: 'skill', id: skillId, message: error && error.message || String(error) } };
            }
          })),
          Promise.all(mcpServerIds.map(async function (serverId) {
            try {
              var serverUri = '/mcp-servers/' + uriSegment(serverId);
              var server = await readSelectedResource(serverUri);
              if (!server || server.enabled !== true) throw new Error('MCP Server 不存在或已停用');
              var tools = await readSelectedCollection(serverUri + '/tools');
              var projectedTools = tools.map(function (tool) {
                var callUri = serverUri + '/tools/' + uriSegment(tool.name) + '/calls';
                var schemaHash = text(tool.schemaHash);
                return {
                  name: text(tool.name),
                  description: String(tool.description || ''),
                  callUri: callUri,
                  schemaHash: schemaHash,
                  argumentsSchema: clone(tool.inputSchema || { type: 'object', properties: {}, additionalProperties: true }),
                  invocation: {
                    providerTool: 'POST',
                    providerArguments: {
                      uri: callUri,
                      body: {
                        arguments: '<必须匹配 argumentsSchema 的 MCP 工具参数>',
                        schemaHash: schemaHash,
                      },
                    },
                    completion: '从返回回执读取 operationUri，再用 Provider GET 读取该 URI 直到调用结束',
                  },
                };
              }).filter(function (tool) { return tool.name && tool.schemaHash; });
              return {
                value: {
                  id: serverId,
                  name: text(server.name || serverId),
                  instructions: String(server.serverInstructions || ''),
                  tools: projectedTools,
                },
                resourceUris: projectedTools.map(function (tool) { return tool.callUri; }),
              };
            } catch (error) {
              return { warning: { kind: 'mcp', id: serverId, message: error && error.message || String(error) } };
            }
          })),
        ]).then(function (groups) {
          var skillResults = groups[0];
          var mcpResults = groups[1];
          return {
            skills: skillResults.map(function (result) { return result.value; }).filter(Boolean),
            mcpServers: mcpResults.map(function (result) { return result.value; }).filter(Boolean),
            resourceUris: mcpResults.reduce(function (uris, result) {
              return uris.concat(result.resourceUris || []);
            }, []),
            warnings: skillResults.concat(mcpResults).map(function (result) { return result.warning; }).filter(Boolean),
          };
        });
        return selectedResourceContextPromise;
      }

      function promoteDefaultTarget(response) {
        // A browser target is a causal fact of the completed page action. Keep
        // it as the next request's default even when Chrome did not activate
        // the tab; focus is presentation state, not the action destination.
        var primaryData = response && response.primary && response.primary.data || null;
        var candidates = [
          response && response.receipt,
          primaryData && primaryData.receipt,
          primaryData && primaryData.actionReceipt,
          primaryData,
        ];
        for (var index = 0; index < candidates.length; index += 1) {
          var candidate = candidates[index];
          var target = candidate && candidate.newNavigationTarget;
          if (!target || target.ambiguous === true || String(target.disposition || 'new_tab') !== 'new_tab') continue;
          var tabId = Math.floor(Number(target.tabId));
          if (!(tabId > 0)) continue;
          context.currentTabId = tabId;
          var windowId = Math.floor(Number(target.windowId));
          if (windowId > 0) context.currentWindowId = windowId;
          return;
        }
      }

      async function dispatchTool(call) {
        var payload = clone(call.arguments || {});
        var methodName = text(call.name).toUpperCase();
        if (methodName === 'ASK_USER') {
          var request = payload || {};
          return lease.requestInteraction({
            kind: 'user_input', toolCallId: call.id, prompt: request.prompt,
            options: request.mode === 'choice' ? clone(request.choices || []) : [],
          }).then(function (resolved) {
            return { answer: clone(resolved.answer), receipt: { performed: 'no' } };
          });
        }
        var capabilityDecision = toolCallDecision(resourceRuntime, assistant, context.permissionScope, call);
        if (!capabilityDecision.allowed) {
          var capabilityError = new Error(capabilityDecision.message);
          capabilityError.code = capabilityDecision.code === 'FORBIDDEN'
            ? 'CAPABILITY_UNAVAILABLE' : (capabilityDecision.code || 'CAPABILITY_UNAVAILABLE');
          capabilityError.performed = 'no';
          capabilityError.details = clone(capabilityDecision.details || {});
          throw capabilityError;
        }
        var response = await scope.dispatch(methodName, payload);
        var error = responseError(response);
        if (error) throw error;
        promoteDefaultTarget(response);
        return response;
      }
      function modelProjectionFor(call) {
        call = call || {};
        var method = text(call.name).toUpperCase();
        var args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
          ? call.arguments : {};
        if (method === 'OPTIONS') return { type: 'capabilities' };
        if (args.responseMode === 'full') return { type: 'full' };
        if (method === 'ASK_USER') return { type: 'data' };
        var uri = text(args.uri);
        if (!uri) return { type: 'data' };
        var routeUri = requestPath(uri, method);
        var resolved;
        try { resolved = router.registry.resolve(routeUri, method); } catch (_) { resolved = null; }
        var descriptor = clone(resolved && resolved.methodContract && resolved.methodContract.modelProjection
          || { type: 'data' });
        if (resolved && resolved.route) {
          descriptor.includeEtag = Object.keys(resolved.route.methods || {}).some(function (candidateMethod) {
            if (candidateMethod === 'GET') return false;
            var contract = resolved.route.methods[candidateMethod];
            return !!(contract && Array.isArray(contract.preconditions)
              && contract.preconditions.indexOf('if-match') !== -1);
          });
        }
        return descriptor;
      }
      async function durableToolResult(call, result) {
        var callArguments = call && call.arguments || {};
        var target = text(callArguments.uri);
        var uri = requestPath(target, 'GET');
        if (text(call && call.name).toUpperCase() !== 'GET' || uri.indexOf('/recordings/') !== 0) return clone(result);
        var sourceSha256 = text(result && result.primary && result.primary.data && result.primary.data.sourceSha256);
        if (!sourceSha256) {
          var missingHash = new Error('Recording 的 GET 响应未标识其不可变来源');
          missingHash.code = 'RESOURCE_NOT_FOUND';
          throw missingHash;
        }
        return {
          schemaVersion: 1,
          kind: 'recording-projection-ref',
          recordingUri: uri,
          requestTarget: target,
          sourceSha256: sourceSha256,
          modelSnapshot: projection.projectArpResponse(result, modelProjectionFor(call), call),
        };
      }
      async function materializeDurableToolResult(value) {
        if (!value || value.kind !== 'recording-projection-ref') return clone(value);
        var target = text(value.requestTarget) || text(value.recordingUri);
        var response = await dispatchTool({
          id: 'recording_projection_materialize',
          name: 'GET',
          arguments: { uri: target },
        });
        var actualHash = text(response && response.primary && response.primary.data && response.primary.data.sourceSha256);
        if (actualHash !== text(value.sourceSha256)) {
          var mismatch = new Error('Recording 投影的来源哈希发生变化');
          mismatch.code = 'RESOURCE_NOT_FOUND';
          throw mismatch;
        }
        return response;
      }

      var toolDispatcher = {
        API_VERSION: API_VERSION,
        async createBatchSnapshot() {
          if (resourceRuntime && typeof resourceRuntime.beginPageToolBatch === 'function') {
            await resourceRuntime.beginPageToolBatch(context);
          }
          return { context: clone(context) };
        },
        async finishBatchSnapshot() {
          if (resourceRuntime && typeof resourceRuntime.endPageToolBatch === 'function') {
            try { await resourceRuntime.endPageToolBatch(context); } catch (_) {}
          }
        },
        dispatch: dispatchTool,
        modelProjectionFor: modelProjectionFor,
        journalResult: durableToolResult,
        materializeJournalResult: materializeDurableToolResult,
        queryReceipt: function (details) {
          if (resourceRuntime && typeof resourceRuntime.queryReceipt === 'function') {
            return resourceRuntime.queryReceipt(text(details && details.idempotencyKey), clone(details || {}), clone(context));
          }
          return Promise.resolve({ performed: 'unknown' });
        },
      };
      return Object.freeze({
        API_VERSION: API_VERSION,
        toolDispatcher: toolDispatcher,
        allowedToolNames: allowedToolNames(resourceRuntime, assistant, context.permissionScope),
        isToolCallAllowed: function (call) {
          return toolCallDecision(resourceRuntime, assistant, context.permissionScope, call);
        },
        securityContext: clone(context),
        addVisibleResourceUris: function (uris) {
          (Array.isArray(uris) ? uris : []).map(canonicalResourceUri).filter(function (uri) { return uri !== '/'; }).forEach(function (uri) {
            if (context.visibleResourceUris.indexOf(uri) === -1) context.visibleResourceUris.push(uri);
          });
          return context.visibleResourceUris.slice();
        },
        resolveRuntimeContext: async function () {
          var selectedResources = await selectedResourceContext();
          return {
            currentResource: context.currentResource,
            assistantPrompt: assistant.prompt || '',
            modelService: canReadModelService ? clone(input.modelService || null) : null,
            selectedSkills: selectedResources && selectedResources.skills || [],
            selectedMcpContext: selectedResources && selectedResources.mcpServers.length
              ? {
                role: 'external-integration',
                servers: selectedResources.mcpServers,
              } : null,
            selectedResourceWarnings: selectedResources && selectedResources.warnings.length
              ? selectedResources.warnings : null,
            additionalResourceUris: selectedResources && selectedResources.resourceUris || [],
            recordingContext: clone(input.recordingContext || { recordings: [] }),
          };
        },
      });
    }

    return Object.freeze({ API_VERSION: API_VERSION, createGeneration: createGeneration });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    RESOURCE_METHODS: RESOURCE_METHODS,
    resourcePermissionCatalog: resourcePermissionCatalog,
    derivePermissionScope: derivePermissionScope,
    allowedToolNames: allowedToolNames,
    deriveAllowedRouteMethods: deriveAllowedRouteMethods,
    isToolCallAllowed: toolCallDecision,
    authorizeResourceRequest: authorizeResourceRequest,
    create: create,
    createAgentCore: create,
  });
});
