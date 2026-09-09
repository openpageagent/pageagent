// Shared Journal -> UI projection and virtualized list for every interactive Conversation surface.
(function attachConversationListView(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var projection = root && root.AgentToolResultProjection;
  if (!projection && commonJs && typeof require === 'function') {
    projection = require('../agent/tool-result-projection');
  }
  var api = factory(root, projection);
  if (commonJs) module.exports = api;
  if (root) root.PageAutomationConversationListView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, projection) {
  'use strict';

  var API_VERSION = 1;
  var DEFAULT_PAGE_SIZE = 10;
  var DEFAULT_OVERSCAN = 8;
  var DEFAULT_ROW_HEIGHT = 96;
  var TERMINAL_TYPES = Object.freeze({
    generation_completed: 'completed',
    generation_failed: 'failed',
    generation_cancelled: 'cancelled',
    generation_truncated: 'truncated',
    generation_blocked: 'blocked',
  });
  var IMAGE_URI = /^\/image-artifacts\/[A-Za-z0-9._~-]{1,240}$/;

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value === undefined || value === null ? '' : value); }
  function trimmed(value) { return text(value).trim(); }
  function isRecord(value) { return !!(value && typeof value === 'object' && !Array.isArray(value)); }
  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }

  function shouldDisplayReasoning(value) {
    return !!trimmed(value);
  }

  function isToolCallsFinishReason(value) {
    var source = trimmed(value);
    return source.toLowerCase() === 'tool_calls' || source === '调用工具';
  }

  function displayFinishStatus(value) {
    return isToolCallsFinishReason(value) ? '' : trimmed(value);
  }

  function isVisibleReasoningEvent(event) {
    if (!event || event.kind !== 'reasoning') return true;
    return shouldDisplayReasoning(event.text);
  }
  function contentText(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) {
      if (!isRecord(value)) return '';
      if (value.text !== undefined) return contentText(value.text);
      if (value.content !== undefined) return contentText(value.content);
      if (value.message !== undefined) return contentText(value.message);
      return '';
    }
    return value.map(contentText).filter(Boolean).join('\n');
  }

  function userMessageText(event, data) {
    data = isRecord(data) ? data : {};
    var message = data.message !== undefined ? data.message : event && event.message;
    var messageObject = isRecord(message) ? message : null;
    var candidates = [
      messageObject ? messageObject.content : message,
      messageObject && messageObject.parts,
      messageObject && messageObject.text,
      messageObject && messageObject.prompt,
      messageObject && messageObject.message,
      data.content,
      data.prompt,
      data.text,
      event && event.content,
      event && event.text,
    ];
    for (var index = 0; index < candidates.length; index += 1) {
      var value = candidates[index];
      var result = contentText(value);
      if (trimmed(result)) return trimmed(result);
    }
    return '';
  }

  /* Model response content may be an array containing provider reasoning
     blocks alongside public text/tool blocks. Reasoning has its own durable
     event and must not leak into the assistant message a second time. */
  function assistantContentText(value) {
    if (!Array.isArray(value)) return contentText(value);
    return value.filter(function (item) {
      return !(isRecord(item)
        && /^(?:reasoning|thinking|thought|tool[_-]?call|tool[_-]?use)$/i.test(String(item.type || '')));
    }).map(function (item) { return contentText(item); }).filter(Boolean).join('\n');
  }

  function interactionAnswerText(value) {
    if (typeof value === 'string') return trimmed(value);
    if (Array.isArray(value)) {
      return value.map(interactionAnswerText).filter(Boolean).join('；');
    }
    if (!isRecord(value)) return trimmed(value);
    if (Array.isArray(value.answers)) {
      return value.answers.map(interactionAnswerText).filter(Boolean).join('；');
    }
    if (isRecord(value.answers)) {
      var answers = Object.keys(value.answers).map(function (key) {
        return interactionAnswerText(value.answers[key]);
      }).filter(Boolean);
      if (answers.length) return answers.join('\n');
    }
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return text(value); }
  }

  function payload(event) {
    if (isRecord(event && event.payload)) return event.payload;
    // Older Harness exports call this field `data`; accepting it here keeps
    // the conversation tab in lockstep with the trajectory importer.
    return isRecord(event && event.data) ? event.data : {};
  }
  function projectionApi() {
    var candidate = root && root.AgentToolResultProjection || projection;
    return candidate
        && typeof candidate.projectTerminalEvent === 'function'
        && typeof candidate.toolResultContent === 'function'
        && typeof candidate.contentText === 'function'
        && typeof candidate.imageParts === 'function'
      ? candidate : null;
  }
  function fallbackProjectionValue(event) {
    var data = payload(event);
    return clone(hasOwn(data, 'result') ? data.result : data);
  }
  function fallbackProjectionText(value) {
    var direct = contentText(value);
    if (direct || value === undefined || value === null) return direct;
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return text(value); }
  }
  function fallbackImageParts(value) {
    var found = [];
    var seen = [];
    function visit(item, depth) {
      if (!item || typeof item !== 'object' || depth > 8 || seen.indexOf(item) !== -1) return;
      seen.push(item);
      if (isRecord(item) && item.type === 'image' && IMAGE_URI.test(trimmed(item.artifactUri))) {
        found.push(clone(item));
      }
      if (Array.isArray(item)) item.forEach(function (child) { visit(child, depth + 1); });
      else Object.keys(item).forEach(function (key) { visit(item[key], depth + 1); });
    }
    visit(value, 0);
    var unique = Object.create(null);
    return found.filter(function (part) {
      var uri = trimmed(part.artifactUri);
      if (!uri || unique[uri]) return false;
      unique[uri] = true;
      return true;
    }).slice(0, 4);
  }

  function durableEventKey(event) {
    event = event || {};
    var type = trimmed(event.type);
    if (type === 'commentary_completed') return 'commentary:' + trimmed(event.modelRequestId || event.eventId || event.sequence);
    if (type === 'reasoning_completed') return 'reasoning:' + trimmed(event.modelRequestId || event.eventId || event.sequence);
    if (type === 'model_response_completed') return 'response:' + trimmed(event.modelRequestId || event.eventId || event.sequence);
    if (isToolLifecycleType(type)) {
      return 'tool:' + trimmed(toolCallIdFromData(event, payload(event)) || event.eventId || event.sequence);
    }
    if (/^interaction_/.test(type)) return 'interaction:' + trimmed(event.interactionId || event.eventId || event.sequence);
    if (TERMINAL_TYPES[type]) return 'terminal:' + trimmed(event.generationId || event.eventId || event.sequence);
    return trimmed(event.eventId) || 'sequence:' + Math.max(0, Number(event.sequence) || 0);
  }

  // Journal migrations and Harness-compatible streams use both slash and
  // underscore spellings. Keep the UI projection format-agnostic at this
  // boundary so a tool step cannot disappear merely because its event type
  // came from an older transport.
  function isToolLifecycleType(type) {
    type = trimmed(type).toLowerCase();
    return type === 'tool/call' || type === 'tool/result' || type === 'tool_call'
      || /^tool_call_(?:planned|started|completed|failed|result|deferred)$/.test(type)
      || /^tool_execution_/.test(type)
      || /^tool_(?:code[_-]dispatch)/.test(type)
      || /^tool\/code-dispatch/.test(type) || type === 'tool_call_deferred';
  }

  function toolCallIdFromData(event, data) {
    data = isRecord(data) ? data : {};
    var call = isRecord(data.call) ? data.call : {};
    var fn = isRecord(data.function) ? data.function : {};
    return trimmed(event && (event.toolCallId || event.subCallId))
      || trimmed(data.toolCallId || data.callId || data.call_id || data.tool_call_id || data.subCallId)
      || trimmed(call.id || call.callId || call.toolCallId || fn.id || fn.callId)
      || trimmed(data.message && data.message.source && data.message.source.callId);
  }

  // ARP method+URI -> 人类可读操作标题。所有对话界面共用这一份映射：
  // 用户看到“在做什么”，REST 方法与 URI 细节保留在事件详情里。
  var RESOURCE_LABELS = Object.freeze({
    current: '当前时间', page: '页面', browser: '浏览器',
    flows: '流程', 'node-types': '节点类型', 'flow-groups': '流程组',
    conversations: '对话', pages: '页面存档', 'url-triggers': 'URL 触发器',
    scripts: '脚本', config: '配置', skills: '技能', runs: '运行记录',
    schedules: '定时任务', knowledge: '知识', 'knowledge-settings': '知识设置',
    assistants: '助手', 'model-services': '模型服务', 'agent-settings': 'Agent 设置',
    connections: '连接', 'mcp-servers': 'MCP 服务', 'mcp-calls': 'MCP 工具',
    'image-artifacts': '图像产物',
  });
  var METHOD_VERBS = Object.freeze({ GET: '读取', POST: '提交', PUT: '替换', PATCH: '更新', DELETE: '删除', OPTIONS: '查询' });
  var TOOL_PREPARATION_LABELS = Object.freeze({
    GET: '准备读取资源', POST: '准备提交请求', PUT: '准备替换资源',
    PATCH: '准备更新资源', DELETE: '准备删除资源', OPTIONS: '准备查询资源能力',
  });

  function operationRoute(pattern, capabilityLabel, operations) {
    return Object.freeze({
      pattern: pattern,
      capabilityLabel: capabilityLabel,
      operations: Object.freeze(operations || {}),
    });
  }

  function decodedSegment(value) {
    try { return decodeURIComponent(String(value || '')); } catch (_) { return String(value || ''); }
  }

  function indexedOperation(verb, noun) {
    return function (match) {
      var target = decodedSegment(match && match[1]);
      return verb + noun + (target ? ' ' + target : '');
    };
  }

  // 与当前注册的 ARP route contracts 一一对应。操作名按语义命名，不能仅由
  // HTTP 动词猜测：例如 POST 也可能表示截图、运行、导航或连接测试。
  var OPERATION_ROUTES = Object.freeze([
    operationRoute(/^\/agent-settings$/, 'Agent 设置', { GET: '读取 Agent 设置', PATCH: '更新 Agent 设置' }),
    operationRoute(/^\/assistants$/, '助手列表', { GET: '读取助手列表', POST: '新建助手' }),
    operationRoute(/^\/assistants\/[^/]+$/, '助手', { GET: '读取助手', PATCH: '更新助手', DELETE: '删除助手' }),

    operationRoute(/^\/browser\/cdp-sessions$/, 'CDP 会话', { POST: '建立 CDP 会话' }),
    operationRoute(/^\/browser\/cdp-sessions\/[^/]+$/, 'CDP 会话', { GET: '读取 CDP 会话', DELETE: '断开 CDP 会话' }),
    operationRoute(/^\/browser\/cdp-sessions\/[^/]+\/commands$/, 'CDP 命令', { POST: '执行 CDP 命令' }),
    operationRoute(/^\/browser\/cdp-sessions\/[^/]+\/commands\/[^/]+$/, 'CDP 命令结果', { GET: '读取 CDP 命令结果' }),
    operationRoute(/^\/browser\/downloads$/, '下载任务', { GET: '读取下载任务列表', POST: '开始下载' }),
    operationRoute(/^\/browser\/downloads\/[^/]+$/, '下载任务', { GET: '读取下载任务' }),
    operationRoute(/^\/browser\/tabs$/, '标签页列表', { GET: '读取标签页列表', POST: '打开新标签页' }),
    operationRoute(/^\/browser\/tabs\/[^/]+$/, '标签页', { GET: '读取标签页', PATCH: '更新标签页', DELETE: '关闭标签页' }),
    operationRoute(/^\/browser\/tabs\/[^/]+\/navigations$/, '标签页导航', { POST: '打开网址' }),
    operationRoute(/^\/browser\/tabs\/[^/]+\/navigations\/[^/]+$/, '标签页导航结果', { GET: '读取标签页导航结果' }),
    operationRoute(/^\/browser\/windows$/, '窗口列表', { GET: '读取窗口列表', POST: '打开新窗口' }),
    operationRoute(/^\/browser\/windows\/[^/]+$/, '窗口', { GET: '读取窗口', PATCH: '更新窗口', DELETE: '关闭窗口' }),

    operationRoute(/^\/config$/, '配置索引', { GET: '读取配置索引' }),
    operationRoute(/^\/config\/[^/]+$/, '配置分区', { GET: '读取配置分区' }),

    operationRoute(/^\/connections$/, '连接列表', { GET: '读取连接列表' }),
    operationRoute(/^\/connections\/[^/]+$/, '连接', { GET: '读取连接', PATCH: '更新连接' }),
    operationRoute(/^\/connections\/[^/]+\/attempts$/, '连接测试', { POST: '测试连接' }),
    operationRoute(/^\/connections\/[^/]+\/attempts\/[^/]+$/, '连接测试结果', { GET: '读取连接测试结果' }),
    operationRoute(/^\/connections\/[^/]+\/logs$/, '连接日志', { GET: '读取连接日志', DELETE: '清空连接日志' }),

    operationRoute(/^\/conversations$/, '对话列表', { GET: '读取对话列表', POST: '新建对话' }),
    operationRoute(/^\/conversations\/[^/]+$/, '对话', { GET: '读取对话', PATCH: '更新对话', DELETE: '删除对话' }),
    operationRoute(/^\/conversations\/[^/]+\/events$/, '对话事件', { GET: '读取对话事件' }),
    operationRoute(/^\/conversations\/[^/]+\/search$/, '对话事件检索', { GET: '检索对话事件' }),
    operationRoute(/^\/conversations\/[^/]+\/export$/, '对话导出', { GET: '导出对话' }),
    operationRoute(/^\/conversations\/[^/]+\/generations\/[^/]+$/, '对话生成', { DELETE: '取消对话生成' }),
    operationRoute(/^\/conversations\/[^/]+\/messages$/, '对话消息', { POST: '发送用户消息' }),

    operationRoute(/^\/current\/date$/, '当前日期', { GET: '读取当前日期' }),
    operationRoute(/^\/current\/now$/, '当前时间', { GET: '读取当前日期和时间' }),

    operationRoute(/^\/flow-groups$/, '流程组列表', { GET: '读取流程组列表', POST: '新建流程组' }),
    operationRoute(/^\/flow-groups\/[^/]+$/, '流程组', { GET: '读取流程组', PUT: '替换流程组', PATCH: '更新流程组', DELETE: '删除流程组' }),
    operationRoute(/^\/flow-groups\/[^/]+\/runs$/, '流程组运行', { POST: '运行流程组' }),

    operationRoute(/^\/flows$/, '流程列表', { GET: '读取流程列表', POST: '新建流程' }),
    operationRoute(/^\/flows\/[^/]+$/, '流程', { GET: '读取流程', PUT: '替换流程', PATCH: '更新流程', DELETE: '删除流程' }),
    operationRoute(/^\/flows\/[^/]+\/nodes$/, '流程节点', { POST: '新建流程节点' }),
    operationRoute(/^\/flows\/[^/]+\/nodes\/[^/]+$/, '流程节点', { GET: '读取流程节点', PUT: '替换流程节点', PATCH: '更新流程节点', DELETE: '删除流程节点' }),
    operationRoute(/^\/flows\/[^/]+\/runs$/, '流程运行', { POST: '运行流程' }),

    operationRoute(/^\/image-artifacts\/[^/]+$/, '图像产物', { GET: '读取图像产物' }),

    operationRoute(/^\/knowledge$/, '知识列表', { GET: '读取知识列表', POST: '新建知识' }),
    operationRoute(/^\/knowledge\/[^/]+$/, '知识', { GET: '读取知识', PUT: '替换知识', PATCH: '更新知识', DELETE: '删除知识' }),
    operationRoute(/^\/knowledge-settings$/, '知识设置', { GET: '读取知识设置', PATCH: '更新知识设置' }),

    operationRoute(/^\/mcp-calls$/, 'MCP 调用列表', { GET: '读取 MCP 调用列表' }),
    operationRoute(/^\/mcp-calls\/[^/]+$/, 'MCP 调用结果', { GET: '读取 MCP 调用结果' }),
    operationRoute(/^\/mcp-servers$/, 'MCP 服务列表', { GET: '读取 MCP 服务列表', POST: '新建 MCP 服务' }),
    operationRoute(/^\/mcp-servers\/[^/]+$/, 'MCP 服务', { GET: '读取 MCP 服务', PATCH: '更新 MCP 服务', DELETE: '删除 MCP 服务' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/connection-attempts$/, 'MCP 连接测试', { POST: '测试 MCP 服务连接' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/connection-attempts\/[^/]+$/, 'MCP 连接测试结果', { GET: '读取 MCP 连接测试结果' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/tool-discoveries$/, 'MCP 工具发现', { POST: '发现 MCP 工具' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/tool-discoveries\/[^/]+$/, 'MCP 工具发现结果', { GET: '读取 MCP 工具发现结果' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/tools$/, 'MCP 工具列表', { GET: '读取 MCP 工具列表' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/tools\/[^/]+$/, 'MCP 工具定义', { GET: '读取 MCP 工具定义' }),
    operationRoute(/^\/mcp-servers\/[^/]+\/tools\/[^/]+\/calls$/, 'MCP 工具调用', { POST: '调用 MCP 工具' }),

    operationRoute(/^\/model-services$/, '模型服务列表', { GET: '读取模型服务列表', POST: '新建模型服务' }),
    operationRoute(/^\/model-services\/[^/]+$/, '模型服务', { GET: '读取模型服务', PATCH: '更新模型服务', DELETE: '删除模型服务' }),
    operationRoute(/^\/model-services\/[^/]+\/connection-attempts$/, '模型服务连接测试', { POST: '测试模型服务连接' }),
    operationRoute(/^\/model-services\/[^/]+\/connection-attempts\/[^/]+$/, '模型服务连接测试结果', { GET: '读取模型服务连接测试结果' }),

    operationRoute(/^\/node-types$/, '节点类型列表', { GET: '读取节点类型列表' }),
    operationRoute(/^\/node-types\/[^/]+$/, '节点类型', { GET: '读取节点类型定义' }),

    operationRoute(/^\/page\/current$/, '页面内容', { GET: '读取页面内容' }),
    operationRoute(/^\/page\/clicks$/, '页面点击', { POST: '点击页面元素' }),
    operationRoute(/^\/page\/fills$/, '页面填写', { POST: '填写页面元素' }),
    operationRoute(/^\/page\/selections$/, '页面选择', { POST: '选择页面元素' }),
    operationRoute(/^\/page\/element$/, '页面元素', { GET: '读取页面元素' }),
    operationRoute(/^\/page\/interactions\/[^/]+$/, '页面交互结果', { GET: '读取页面交互结果' }),
    operationRoute(/^\/page\/javascript-executions$/, '页面脚本执行', { POST: '执行页面脚本' }),
    operationRoute(/^\/page\/media$/, '页面媒体列表', { GET: '读取页面媒体列表' }),
    operationRoute(/^\/page\/media\/([^/]+)$/, '页面媒体', { GET: indexedOperation('读取', '页面媒体') }),
    operationRoute(/^\/page\/media\/([^/]+)\/artifacts$/, '页面媒体图像', { POST: indexedOperation('获取', '页面媒体图像') }),
    operationRoute(/^\/page\/screenshots$/, '页面截图', { POST: '截取页面截图' }),
    operationRoute(/^\/page\/scrolls$/, '页面滚动', { POST: '滚动页面' }),
    operationRoute(/^\/page\/waits$/, '页面等待', { POST: '等待页面变化' }),

    operationRoute(/^\/pages$/, '页面存档列表', { GET: '读取页面存档列表', POST: '新建页面存档' }),
    operationRoute(/^\/pages\/[^/]+$/, '页面存档', { GET: '读取页面存档', PATCH: '更新页面存档', DELETE: '删除页面存档' }),

    operationRoute(/^\/recordings\/[^/]+$/, '页面操作录制', { GET: '读取页面操作录制' }),

    operationRoute(/^\/runs$/, '运行记录列表', { GET: '读取运行记录列表', DELETE: '清理运行记录' }),
    operationRoute(/^\/runs\/[^/]+$/, '运行记录', { GET: '读取运行记录', DELETE: '删除运行记录' }),
    operationRoute(/^\/runs\/[^/]+\/debug-snapshot$/, '运行调试快照', { GET: '读取运行调试快照' }),
    operationRoute(/^\/runs\/[^/]+\/report$/, '运行报告', { GET: '读取运行报告' }),

    operationRoute(/^\/schedules$/, '定时任务列表', { GET: '读取定时任务列表', POST: '新建定时任务' }),
    operationRoute(/^\/schedules\/[^/]+$/, '定时任务', { GET: '读取定时任务', PATCH: '更新定时任务', DELETE: '删除定时任务' }),
    operationRoute(/^\/schedules\/[^/]+\/runs$/, '定时任务运行', { POST: '立即运行定时任务' }),

    operationRoute(/^\/scripts$/, '脚本列表', { GET: '读取脚本列表', POST: '新建脚本' }),
    operationRoute(/^\/scripts\/[^/]+$/, '脚本', { GET: '读取脚本', PUT: '替换脚本', PATCH: '更新脚本', DELETE: '删除脚本' }),
    operationRoute(/^\/scripts\/[^/]+\/runs$/, '脚本运行', { POST: '运行脚本' }),

    operationRoute(/^\/skills$/, '技能列表', { GET: '读取技能列表', POST: '新建技能' }),
    operationRoute(/^\/skills\/[^/]+$/, '技能', { GET: '读取技能', PATCH: '更新技能', DELETE: '删除技能' }),
    operationRoute(/^\/skills\/[^/]+\/instructions$/, '技能说明', { GET: '读取技能说明' }),
    operationRoute(/^\/skills\/[^/]+\/resources$/, '技能资源列表', { GET: '读取技能资源列表' }),
    operationRoute(/^\/skills\/[^/]+\/resources\/[^/]+$/, '技能资源', { GET: '读取技能资源' }),

    operationRoute(/^\/url-triggers$/, 'URL 触发器列表', { GET: '读取 URL 触发器列表', POST: '新建 URL 触发器' }),
    operationRoute(/^\/url-triggers\/[^/]+$/, 'URL 触发器', { GET: '读取 URL 触发器', PUT: '替换 URL 触发器', PATCH: '更新 URL 触发器', DELETE: '删除 URL 触发器' }),
  ]);

  function matchedOperationRoute(uri) {
    for (var index = 0; index < OPERATION_ROUTES.length; index++) {
      var match = OPERATION_ROUTES[index].pattern.exec(uri);
      if (match) return { route: OPERATION_ROUTES[index], match: match };
    }
    return null;
  }

  function queryParameter(query, name) {
    var pairs = String(query || '').split('&');
    for (var index = 0; index < pairs.length; index++) {
      var parts = pairs[index].split('=');
      if (decodedSegment(parts.shift().replace(/\+/g, ' ')) !== name) continue;
      return decodedSegment(parts.join('=').replace(/\+/g, ' '));
    }
    return '';
  }

  function describeOperation(method, uri) {
    method = trimmed(method).toUpperCase();
    var rawUri = trimmed(uri).split('#')[0];
    var queryIndex = rawUri.indexOf('?');
    var query = queryIndex === -1 ? '' : rawUri.slice(queryIndex + 1);
    uri = queryIndex === -1 ? rawUri : rawUri.slice(0, queryIndex);
    if (!METHOD_VERBS[method] || uri.charAt(0) !== '/') return '';
    if (uri.length > 1) uri = uri.replace(/\/+$/, '');
    var seg = uri.split('/').filter(Boolean);
    if (!seg.length) return method === 'OPTIONS' ? '查询可用能力' : '';
    var matched = matchedOperationRoute(uri);
    if (method === 'OPTIONS') {
      if (uri === '/capabilities') return '查询可用能力';
      var scopeLabel = matched && matched.route.capabilityLabel
        || (seg[0] === 'page' ? '页面' : seg[0] === 'browser' ? '浏览器' : RESOURCE_LABELS[seg[0]])
        || uri;
      return '查询' + scopeLabel + '能力';
    }
    if (matched) {
      if (method === 'GET' && /^\/flows\/[^/]+$/.test(uri)) {
        if (queryParameter(query, 'view') === 'validation') return '读取流程验证结果';
      }
      if (method === 'GET' && uri === '/knowledge') {
        var knowledgeMode = queryParameter(query, 'mode');
        if (knowledgeMode === 'grep') return '检索知识';
        if (knowledgeMode === 'relevance') return '搜索知识';
      }
      if (method === 'GET' && /^\/recordings\/[^/]+$/.test(uri)) {
        var recordingView = queryParameter(query, 'view');
        if (recordingView === 'events') return '读取页面操作录制事件';
        if (recordingView === 'search') return '搜索页面操作录制';
      }
      var operation = matched.route.operations[method];
      if (typeof operation === 'function') return operation(matched.match);
      if (operation) return operation;
    }
    // 新增路由尚未来得及补专名时仍展示真实方法与 URI，绝不回退成
    // “资源操作”这种无法判断正在做什么的标题。
    var label = RESOURCE_LABELS[seg[0]];
    return METHOD_VERBS[method] + (label ? label + ' ' : '资源 ') + uri;
  }

  function toolTitle(name) {
    name = trimmed(name).toUpperCase();
    if (name === 'ASK_USER') return '请求用户输入';
    var method = name.toUpperCase();
    if (TOOL_PREPARATION_LABELS[method]) return TOOL_PREPARATION_LABELS[method];
    return name ? '调用工具 ' + name : '工具调用';
  }

  function toolOperation(data) {
    data = data || {};
    var args = isRecord(data.arguments) ? data.arguments : {};
    // requestTarget 保留 query（view/mode 等功能细分）；canonicalUri 是
    // 解析后的纯 path，只作兜底，避免执行结果卡片丢失操作细分。
    return describeOperation(data.method || data.name, data.requestTarget || args.uri || data.canonicalUri);
  }

  function updateToolCardValue(projected) {
    var value = {};
    if (hasOwn(projected, 'call')) value.call = clone(projected.call);
    if (hasOwn(projected, 'result')) value.result = clone(projected.result);
    if (Object.keys(value).length) projected.codeValue = value;
    return projected;
  }

  function applyModelToolProjection(projected, event) {
    var api = projectionApi();
    var projectionEvent = event;
    if (event && !isRecord(event.payload) && isRecord(event.data)) {
      projectionEvent = Object.assign({}, event, { payload: event.data });
    }
    var modelValue = api ? api.projectTerminalEvent(projectionEvent) : fallbackProjectionValue(projectionEvent);
    var modelContent = api ? api.toolResultContent(modelValue) : modelValue;
    projected.text = api ? api.contentText(modelContent) : fallbackProjectionText(modelContent);
    projected.result = clone(modelContent);
    updateToolCardValue(projected);
    var images = api ? api.imageParts(modelContent) : fallbackImageParts(modelContent);
    if (images.length) projected.attachments = images;
    return modelValue;
  }

  function projectDurableEvent(event, options) {
    if (!event || event.type === 'provider_protocol_blocks_stored') return null;
    options = options || {};
    var data = payload(event);
    var type = trimmed(event.type);
    var projected = {
      id: trimmed(event.eventId) || durableEventKey(event),
      eventId: trimmed(event.eventId),
      eventKey: durableEventKey(event),
      sequence: Math.max(0, Number(event.sequence) || 0),
      conversationId: trimmed(event.conversationId),
      generationId: trimmed(event.generationId || data.generationId),
      modelRequestId: trimmed(event.modelRequestId || data.modelRequestId || data.requestId),
      toolCallId: toolCallIdFromData(event, data),
      interactionId: trimmed(event.interactionId),
      at: Math.max(0, Number(event.at) || 0),
      canonicalType: type,
      kind: 'info',
      title: type || '事件',
      text: '',
      status: trimmed(event.status),
    };
    if (type === 'steering_message_consumed') {
      var sourceSequence = Math.max(0, Number(data.sourceSequence) || 0);
      if (sourceSequence) projected.sequence = sourceSequence;
    }
    if (type === 'steering_message_appended') {
      return null;
    } else if (type === 'user_message_appended' || type === 'user/message' || type === 'steering_message_consumed') {
      projected.kind = 'user';
      projected.title = '用户';
      projected.phase = type === 'steering_message_consumed' ? 'steering' : 'user';
      projected.text = userMessageText(event, data);
    } else if (type === 'commentary_completed') {
      projected.kind = 'assistant';
      projected.title = '助手';
      projected.phase = 'commentary';
      projected.text = contentText(data.content || data.commentary);
      projected.status = 'completed';
    } else if (type === 'reasoning_completed') {
      projected.kind = 'reasoning';
      projected.title = '思考';
      projected.reasoningKind = trimmed(data.reasoningKind) || 'raw';
      if (hasOwn(data, 'startedAt')) projected.startedAt = Math.max(0, Number(data.startedAt) || 0);
      if (hasOwn(data, 'durationMs')) projected.durationMs = Math.max(0, Number(data.durationMs) || 0);
      projected.text = contentText(data.content);
      projected.status = 'completed';
    } else if (type === 'model_response_completed') {
      projected.kind = 'assistant';
      projected.title = '助手';
      projected.text = assistantContentText(data.content);
      var finishReason = trimmed(data.finishReason);
      // tool_calls only closes this model turn; the generation continues with
      // the separately rendered tool events. Do not expose the protocol token
      // as an assistant-message status.
      projected.finishReason = finishReason;
      projected.status = finishReason === 'stop' ? 'completed'
        : (finishReason ? displayFinishStatus(finishReason) : 'completed');
    } else if (type === 'tool/call' || type === 'tool/result' || type === 'tool_call') {
      var slashToolCallId = toolCallIdFromData(event, data);
      var slashCall = isRecord(data.call) ? data.call : {};
      var slashFunction = isRecord(data.function) ? data.function : {};
      var slashName = trimmed(data.name || data.toolName || slashCall.name || slashFunction.name);
      var slashArguments = data.arguments !== undefined ? data.arguments
        : data.args !== undefined ? data.args
          : data.input !== undefined ? data.input
            : slashCall.arguments !== undefined ? slashCall.arguments : slashCall.args;
      if (typeof slashArguments === 'string') {
        try { slashArguments = JSON.parse(slashArguments); } catch (_) {}
      }
      projected.toolCallId = slashToolCallId;
      projected.title = toolTitle(slashName);
      projected.operation = toolOperation({ name: slashName, arguments: slashArguments || {} });
      if (type === 'tool/result') {
        projected.kind = 'tool-result';
        var normalizedTerminal = Object.assign({}, event, { type: 'tool_execution_completed', payload: data });
        applyModelToolProjection(projected, normalizedTerminal);
        projected.status = 'completed';
      } else {
        projected.kind = 'tool';
        projected.call = { name: slashName, arguments: clone(slashArguments || {}) };
        projected.text = trimmed(slashArguments && slashArguments.uri);
        updateToolCardValue(projected);
        projected.status = type === 'tool/call' || type === 'tool_call' ? 'planned' : projected.status || 'running';
      }
    } else if (type === 'tool_call_planned' || /^tool_call_(?:started|completed|failed|result)$/.test(type)) {
      projected.kind = 'tool';
      projected.operation = toolOperation(data);
      projected.title = projected.operation || toolTitle(data.name);
      var hasToolArguments = data.arguments !== undefined || data.args !== undefined || data.input !== undefined;
      var toolArguments = data.arguments !== undefined ? data.arguments : data.args !== undefined ? data.args : data.input;
      if (typeof toolArguments === 'string') {
        try { toolArguments = JSON.parse(toolArguments); } catch (_) {}
      }
      if (hasToolArguments) {
        projected.text = trimmed(toolArguments && toolArguments.uri);
        projected.call = { name: trimmed(data.name), arguments: clone(toolArguments || {}) };
        updateToolCardValue(projected);
      }
      projected.status = /completed|result$/.test(type) ? 'completed'
        : /failed$/.test(type) ? 'failed'
          : /deferred$/.test(type) ? 'deferred' : type === 'tool_call_started' ? 'running' : 'planned';
      if (/completed|result$/.test(type)) {
        projected.kind = 'tool-result';
        applyModelToolProjection(projected, Object.assign({}, event, {
          type: 'tool_execution_completed', payload: data,
        }));
      }
    } else if (type === 'tool_execution_started') {
      projected.kind = 'tool';
      projected.operation = toolOperation(data);
      projected.title = projected.operation || toolTitle(data.name || data.method);
      projected.text = projected.operation
        ? '正在执行：' + projected.operation
        : [trimmed(data.method), trimmed(data.canonicalUri)].filter(Boolean).join(' ');
      projected.status = 'running';
    } else if (type === 'tool_execution_completed') {
      projected.kind = 'tool-result';
      projected.operation = toolOperation(data);
      projected.title = projected.operation || toolTitle(data.name);
      var modelValue = applyModelToolProjection(projected, event);
      var resultValue = modelValue && typeof modelValue === 'object' && !Array.isArray(modelValue) ? modelValue : {};
      var projectedResult = isRecord(resultValue.result) ? resultValue.result : resultValue;
      var receipt = resultValue.receipt || projectedResult.receipt || projectedResult.actionReceipt
        || projectedResult.interaction && (projectedResult.interaction.receipt || projectedResult.interaction)
        || resultValue.primary && resultValue.primary.data && resultValue.primary.data.actionReceipt || null;
      var verificationStatus = trimmed(receipt && (receipt.verificationStatus || receipt.status || receipt.verification && receipt.verification.status));
      var performed = trimmed(receipt && receipt.performed || data.performed);
      if (trimmed(data.name).toUpperCase() === 'ASK_USER') projected.status = 'answered';
      else if (verificationStatus === 'failed') {
        projected.kind = 'error';
        projected.status = 'failed';
      } else if (verificationStatus === 'unconfirmed') {
        projected.kind = 'warn';
        projected.status = 'unconfirmed';
      } else if (verificationStatus === 'confirmed') projected.status = 'confirmed';
      else projected.status = performed === 'unknown' ? 'unknown' : (performed === 'no' ? 'not_performed' : 'completed');
    } else if (type === 'tool_execution_failed') {
      projected.kind = 'error';
      projected.operation = toolOperation(data);
      projected.title = projected.operation || toolTitle(data.name);
      applyModelToolProjection(projected, event);
      projected.status = 'failed';
    } else if (type === 'tool_execution_unknown') {
      projected.kind = 'warn';
      projected.operation = toolOperation(data);
      projected.title = projected.operation || toolTitle(data.name);
      applyModelToolProjection(projected, event);
      projected.status = 'unknown';
    } else if (type === 'tool_call_deferred') {
      projected.kind = 'warn';
      projected.operation = toolOperation(data);
      projected.title = projected.operation || toolTitle(data.name);
      applyModelToolProjection(projected, event);
      projected.status = 'deferred';
    } else if (type === 'interaction_requested') {
      projected.kind = 'run';
      projected.title = '等待回答';
      projected.text = trimmed(data.prompt);
      projected.status = 'open';
    } else if (type === 'interaction_resolved') {
      projected.kind = 'user';
      projected.title = '用户';
      projected.phase = 'interaction_response';
      projected.text = interactionAnswerText(data.answer);
      projected.status = 'answered';
    } else if (type === 'interaction_expired' || type === 'interaction_cancelled') {
      projected.kind = 'warn';
      projected.title = type === 'interaction_expired' ? '交互已过期' : '交互已取消';
      projected.text = trimmed(data.reason);
      projected.status = type === 'interaction_expired' ? 'expired' : 'cancelled';
    } else if (TERMINAL_TYPES[type]) {
      projected.kind = type === 'generation_completed' ? 'assistant' : type === 'generation_failed' ? 'error' : 'warn';
      projected.title = type === 'generation_completed' ? '助手' : '运行结束';
      if (type === 'generation_completed') projected.phase = 'final_answer';
      projected.text = trimmed(data.finalAnswer || data.error || data.reason);
      projected.status = TERMINAL_TYPES[type];
    } else if (type === 'summary_committed') {
      projected.kind = 'info';
      projected.title = '上下文摘要检查点';
      var throughSequence = Math.max(0, Number(data.throughSequence) || 0);
      var summaryText = data.summary === undefined || data.summary === null
        ? '' : (typeof data.summary === 'string' ? data.summary : JSON.stringify(data.summary, null, 2));
      projected.text = summaryText
        ? '后续模型使用以下摘要替代 Journal sequence ' + throughSequence + ' 及之前的原始对话：\n\n' + summaryText
        : '后续模型使用摘要替代 Journal sequence ' + throughSequence + ' 及之前的原始对话';
      if (data.summary !== undefined) projected.codeValue = clone(data.summary);
      projected.status = 'completed';
    } else if (type === 'generation_started' || type === 'generation_state_changed'
        || type === 'model_request_prepared' || type === 'model_request_started'
        || type === 'summary_requested' || type === 'runtime_recovered'
        || type === 'model_request_interrupt_requested' || type === 'model_request_interrupted') {
      return null;
    } else if (type === 'model_request_failed' || type === 'summary_failed') {
      projected.kind = 'error';
      projected.title = type === 'summary_failed' ? '摘要失败' : '模型请求失败';
      projected.text = trimmed(data.error || data.reason || data.code);
      projected.status = 'failed';
    } else {
      projected.text = trimmed(data.message || data.reason || data.error);
      if (!projected.text) return null;
    }
    if (!projected.text && projected.kind === 'assistant') return null;
    return projected;
  }

  function liveEvents(streamBuffers) {
    var result = [];
    (Array.isArray(streamBuffers) ? streamBuffers : []).forEach(function (buffer) {
      if (!buffer) return;
      var requestId = trimmed(buffer.modelRequestId);
      var reasoning = text(buffer.reasoning);
      var reasoningStartedAt = Math.max(0, Number(buffer.startedAt) || 0);
      var reasoningRunning = buffer.thinking !== false;
      var reasoningDurationMs = reasoningRunning ? 0 : Math.max(0, Number(buffer.durationMs)
        || (reasoningStartedAt ? Number(buffer.updatedAt) - reasoningStartedAt : 0));
      if (buffer.thinking === true || reasoning) result.push({
        id: 'live-reasoning:' + requestId,
        eventKey: 'reasoning:' + requestId,
        kind: 'reasoning', title: '思考',
        text: reasoning || '正在思考...', status: reasoningRunning ? 'thinking' : 'completed',
        reasoningKind: trimmed(buffer.reasoningKind) || 'raw', modelRequestId: requestId,
        generationId: trimmed(buffer.generationId),
        startedAt: reasoningStartedAt,
        durationMs: reasoningDurationMs,
        at: reasoningStartedAt || Math.max(0, Number(buffer.updatedAt) || 0), __live: true,
      });
      if (trimmed(buffer.commentary)) result.push({
        id: 'live-commentary:' + requestId,
        eventKey: 'commentary:' + requestId,
        kind: 'assistant', title: '助手', phase: 'commentary',
        text: text(buffer.commentary), status: 'running',
        modelRequestId: requestId, generationId: trimmed(buffer.generationId),
        at: Math.max(0, Number(buffer.updatedAt) || 0), __live: true,
      });
      var liveText = text(buffer.text);
      if (trimmed(liveText)) result.push({
        id: 'live-response:' + requestId,
        eventKey: 'response:' + requestId,
        kind: 'assistant', title: '助手', text: liveText, status: 'running',
        modelRequestId: requestId, generationId: trimmed(buffer.generationId),
        at: Math.max(0, Number(buffer.updatedAt) || 0), __live: true,
      });
      (Array.isArray(buffer.toolCalls) ? buffer.toolCalls : []).forEach(function (call) {
        var callId = trimmed(call && (call.toolCallId || call.callId));
        if (!callId) return;
        var callName = trimmed(call && call.name);
        result.push({
          id: 'live-tool:' + callId,
          eventKey: 'tool:' + callId,
          kind: 'tool',
          title: toolTitle(callName),
          text: call.receivedChars ? '正在接收工具参数（' + Math.max(0, Number(call.receivedChars) || 0) + ' 字符）' : '正在接收工具调用',
          status: 'streaming', toolCallId: callId,
          modelRequestId: requestId, generationId: trimmed(buffer.generationId),
          at: Math.max(0, Number(buffer.updatedAt) || 0), __live: true,
        });
      });
    });
    return result;
  }

  function containsPageUserCancelled(value) {
    return trimmed(value).toLowerCase().indexOf('page_user_cancelled') !== -1;
  }

  function userStopSequences(events) {
    var sequences = Object.create(null);
    (Array.isArray(events) ? events : []).forEach(function (event) {
      if (!event) return;
      var type = trimmed(event.type || event.canonicalType);
      if (type !== 'cancellation_requested' && type !== 'generation_cancelled') return;
      var data = payload(event);
      var reason = data.reason || data.error || data.errorCode || data.code || event.text;
      if (!containsPageUserCancelled(reason)) return;
      var generationId = trimmed(event.generationId);
      if (!generationId) return;
      var sequence = Math.max(0, Number(event.sequence) || 0);
      if (!hasOwn(sequences, generationId) || sequence < sequences[generationId]) {
        sequences[generationId] = sequence;
      }
    });
    return sequences;
  }

  function mergeProjected(events, buffers, options) {
    var order = [];
    var byKey = Object.create(null);
    var sourceEvents = Array.isArray(events) ? events : [];
    var stoppedByUser = userStopSequences(sourceEvents);
    sourceEvents.forEach(function (event) {
      var projected = event && event.canonicalType ? clone(event) : projectDurableEvent(event, options);
      if (!projected) return;
      var stoppedSequence = stoppedByUser[projected.generationId];
      var afterUserStop = hasOwn(stoppedByUser, projected.generationId)
        && projected.sequence >= stoppedSequence;
      if (afterUserStop && projected.canonicalType === 'model_request_failed') return;
      if (afterUserStop && (projected.canonicalType === 'cancellation_requested'
          || projected.canonicalType === 'generation_cancelled')) {
        projected.eventKey = 'user-stop:' + projected.generationId;
        projected.kind = 'warn';
        projected.title = '用户停止';
        projected.text = '';
        projected.status = '';
      }
      if (projected.kind === 'reasoning') projected.title = '思考';
      if (projected.kind === 'assistant' && isToolCallsFinishReason(projected.status || projected.finishReason)) {
        projected.finishReason = projected.finishReason || projected.status;
        projected.status = '';
      }
      if (!isVisibleReasoningEvent(projected)) return;
      var key = projected.eventKey || projected.id;
      var previous = byKey[key];
      // 同一 toolCallId 的 planned/started/completed 共用 eventKey 依次覆盖；
      // 旧数据的 completed 事件缺 URI 时，从更早事件承接人类可读操作名。
      if (previous && previous.operation && !projected.operation
          && projected.toolCallId && previous.toolCallId === projected.toolCallId) {
        projected.operation = previous.operation;
        projected.title = previous.operation;
      }
      var sameTool = previous && projected.toolCallId && previous.toolCallId === projected.toolCallId;
      if (sameTool && hasOwn(previous, 'call') && !hasOwn(projected, 'call')) {
        projected.call = clone(previous.call);
      }
      if (sameTool && hasOwn(previous, 'result') && !hasOwn(projected, 'result')) {
        projected.result = clone(previous.result);
      }
      if (hasOwn(projected, 'call') || hasOwn(projected, 'result')) {
        updateToolCardValue(projected);
      } else if (sameTool && previous.codeValue !== undefined && projected.codeValue === undefined) {
        // Preserve pre-unified projected events that only carried codeValue.
        projected.codeValue = clone(previous.codeValue);
      }
      if (!previous) order.push(key);
      byKey[key] = projected;
    });
    liveEvents(buffers).forEach(function (event) {
      var key = event.eventKey;
      if (byKey[key]) return;
      order.push(key);
      byKey[key] = event;
    });
    var merged = order.map(function (key) { return byKey[key]; }).sort(function (left, right) {
      var leftSequence = Math.max(0, Number(left.sequence) || 0);
      var rightSequence = Math.max(0, Number(right.sequence) || 0);
      if (leftSequence && rightSequence) return leftSequence - rightSequence;
      if (leftSequence) return -1;
      if (rightSequence) return 1;
      return Number(left.at || 0) - Number(right.at || 0);
    });
    var duplicateResponses = Object.create(null);
    var terminalGenerations = Object.create(null);
    for (var index = 0; index < merged.length; index += 1) {
      var terminal = merged[index];
      if (!terminal || terminal.canonicalType !== 'generation_completed' || !trimmed(terminal.text)) continue;
      terminalGenerations[terminal.generationId] = true;
      var terminalResponseFound = false;
      for (var previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
        var candidate = merged[previousIndex];
        if (!candidate || candidate.generationId !== terminal.generationId) continue;
        if (candidate.canonicalType !== 'model_response_completed' || !trimmed(candidate.text)) continue;
        // generation_completed 是唯一的最终回答投影；最近一条非空模型回答正是
        // 该终局的来源，更早的完全同文副本也一并折叠。
        /* Only the same final prose is a duplicate. A model response that
           ended in tool calls (or commentary) is a distinct Harness assistant
           step and must remain visible alongside the terminal generation row. */
        if (trimmed(candidate.text) === trimmed(terminal.text)) {
          duplicateResponses[candidate.eventKey || candidate.id] = true;
        }
        terminalResponseFound = true;
      }
    }
    return merged.filter(function (event) {
      if (event.__live && terminalGenerations[event.generationId]) return false;
      return !duplicateResponses[event.eventKey || event.id];
    });
  }

  function mergeProjectedPages(olderEvents, newerEvents) {
    var merged = [];
    var indexByKey = Object.create(null);
    [olderEvents, newerEvents].forEach(function (events) {
      (Array.isArray(events) ? events : []).forEach(function (event) {
        if (!event) return;
        var key = trimmed(event.eventKey || event.liveKey || event.eventId || event.id);
        if (!key || !hasOwn(indexByKey, key)) {
          if (key) indexByKey[key] = merged.length;
          merged.push(event);
          return;
        }
        // A page boundary may split tool planned/started/terminal events. Keep
        // the newer page's state at the logical card's original position.
        merged[indexByKey[key]] = event;
      });
    });
    return merged;
  }

  /* Merge Journal pages before projection. Journal pages are directional:
     an initial request returns the tail, `afterSequence` returns newer rows,
     and `beforeSequence` returns older rows. Keep this operation shared by
     every Conversation surface so neither surface accidentally merges a UI
     projection back into the raw Journal stream. */
  function mergeJournalPages(existingEvents, pageEvents) {
    var byKey = Object.create(null);
    var order = [];
    function add(event) {
      if (!event || typeof event !== 'object') return;
      var sequence = Number(event.sequence) || 0;
      var eventId = trimmed(event.eventId || event.id);
      var key = sequence > 0 ? 'sequence:' + sequence : (eventId ? 'event:' + eventId : '');
      if (!key) return;
      if (!hasOwn(byKey, key)) order.push(key);
      byKey[key] = event;
    }
    (Array.isArray(existingEvents) ? existingEvents : []).forEach(add);
    (Array.isArray(pageEvents) ? pageEvents : []).forEach(add);
    return order.map(function (key) { return byKey[key]; }).sort(function (left, right) {
      var leftSequence = Number(left && left.sequence) || 0;
      var rightSequence = Number(right && right.sequence) || 0;
      if (leftSequence && rightSequence) return leftSequence - rightSequence;
      if (leftSequence) return -1;
      if (rightSequence) return 1;
      return Number(left && left.at || 0) - Number(right && right.at || 0);
    });
  }

  function pendingSteeringMessages(events) {
    var consumed = Object.create(null);
    (Array.isArray(events) ? events : []).forEach(function (event) {
      if (!event || trimmed(event.type) !== 'steering_message_consumed') return;
      var data = payload(event);
      var commandId = trimmed(data.commandId);
      if (commandId) consumed[commandId] = true;
    });
    return (Array.isArray(events) ? events : []).filter(function (event) {
      if (!event || trimmed(event.type) !== 'steering_message_appended') return false;
      var data = payload(event);
      var commandId = trimmed(data.commandId);
      return !commandId || consumed[commandId] !== true;
    }).map(function (event) {
      var data = payload(event);
      var message = data.message || data;
      return {
        id: trimmed(event.eventId) || 'pending-steering:' + Math.max(0, Number(event.sequence) || 0),
        commandId: trimmed(data.commandId),
        sequence: Math.max(0, Number(event.sequence) || 0),
        at: Math.max(0, Number(event.at) || 0),
        text: userMessageText(event, data),
        status: 'pending',
      };
    }).filter(function (item) { return !!item.text; });
  }

  function projectPage(page) {
    page = page || {};
    // Runtime transport already gives the UI its own snapshot. Deep-cloning the
    // complete page here duplicated every payload before projecting its events.
    return Object.assign({}, page, {
      projectedEvents: mergeProjected(page.events || [], page.streamBuffers || [], page.preferences || {}),
      pendingSteeringMessages: pendingSteeringMessages(page.events || []),
    });
  }

  function search(events, query) {
    query = trimmed(query).toLocaleLowerCase();
    var projected = (events || []).map(function (event) {
      return event && event.canonicalType ? event : projectDurableEvent(event);
    }).filter(function (event) { return !!event && isVisibleReasoningEvent(event); });
    if (!query) return projected.slice();
    return projected.filter(function (event) {
      return [event.title, event.text, event.status, event.canonicalType]
        .some(function (value) { return text(value).toLocaleLowerCase().indexOf(query) !== -1; });
    });
  }

  function exportJournal(events, options) {
    options = options || {};
    var source = (events || []).filter(function (event) {
      return options.includeReasoning !== false
        || trimmed(event.type || event.canonicalType) !== 'reasoning_completed';
    });
    if (options.format === 'jsonl') return source.map(function (event) { return JSON.stringify(event); }).join('\n');
    return JSON.stringify(source, null, 2);
  }

  function createVirtualList(options) {
    options = options || {};
    var container = options.container;
    var renderItem = options.renderItem;
    if (!container || typeof container.addEventListener !== 'function') throw new TypeError('Virtual list requires a scroll container');
    if (typeof renderItem !== 'function') throw new TypeError('Virtual list requires renderItem(item, index)');
    var documentRef = options.document || container.ownerDocument;
    var rowHeight = Math.max(24, Number(options.estimatedRowHeight) || DEFAULT_ROW_HEIGHT);
    var overscan = Math.max(1, Math.floor(Number(options.overscan) || DEFAULT_OVERSCAN));
    var virtualize = options.virtualize !== false;
    var items = [];
    var destroyed = false;
    var frame = 0;
    var renderedHtmlByKey = Object.create(null);
    var disclosureState = options.disclosureState || Object.create(null);
    var disclosurePrefix = String(options.disclosurePrefix || '');
    var topSpacer = documentRef.createElement('div');
    var rows = documentRef.createElement('div');
    var bottomSpacer = documentRef.createElement('div');
    var rowTemplate = documentRef.createElement('template');
    var canReconcileRows = !!(rowTemplate && rowTemplate.content && rows.children
      && typeof rows.insertBefore === 'function' && typeof rows.removeChild === 'function');
    topSpacer.setAttribute('data-conversation-virtual-spacer', 'top');
    rows.setAttribute('data-conversation-virtual-rows', '');
    bottomSpacer.setAttribute('data-conversation-virtual-spacer', 'bottom');
    container.textContent = '';
    container.appendChild(topSpacer);
    container.appendChild(rows);
    container.appendChild(bottomSpacer);

    function keyOf(item, index) {
      return trimmed(item && (item.eventKey || item.eventId || item.id)) || 'index:' + index;
    }
    function disclosureKey(key) {
      return disclosurePrefix ? disclosurePrefix + '\n' + key : key;
    }
    function rememberDisclosureState() {
      if (!canReconcileRows) return;
      var children = Array.prototype.slice.call(rows.children || []);
      children.forEach(function (node) {
        if (!node || String(node.tagName || '').toLowerCase() !== 'details') return;
        var key = String(node.getAttribute('data-conversation-virtual-key') || '');
        if (key) disclosureState[disclosureKey(key)] = !!node.open;
      });
    }
    function applyDisclosureState(node, key) {
      if (!node || String(node.tagName || '').toLowerCase() !== 'details') return;
      var storedKey = disclosureKey(key);
      if (Object.prototype.hasOwnProperty.call(disclosureState, storedKey)) {
        node.open = disclosureState[storedKey] === true;
      }
    }
    function createRowNode(html, key) {
      rowTemplate.innerHTML = String(html || '').trim();
      var node = rowTemplate.content.firstElementChild;
      if (!node) {
        node = documentRef.createElement('div');
        node.hidden = true;
      }
      node.setAttribute('data-conversation-virtual-key', key);
      applyDisclosureState(node, key);
      return node;
    }
    function reconcileRows(nextRows) {
      if (!canReconcileRows) {
        rows.innerHTML = nextRows.map(function (entry) { return entry.html; }).join('');
        renderedHtmlByKey = Object.create(null);
        return;
      }
      rememberDisclosureState();
      var existingByKey = Object.create(null);
      Array.prototype.slice.call(rows.children || []).forEach(function (node) {
        var key = String(node.getAttribute('data-conversation-virtual-key') || '');
        if (key) existingByKey[key] = node;
      });
      var desired = Object.create(null);
      var nextHtmlByKey = Object.create(null);
      nextRows.forEach(function (entry) {
        var node = existingByKey[entry.key];
        if (!node || renderedHtmlByKey[entry.key] !== entry.html) {
          var replacement = createRowNode(entry.html, entry.key);
          if (node && node.parentNode === rows) rows.replaceChild(replacement, node);
          node = replacement;
        }
        desired[entry.key] = node;
        nextHtmlByKey[entry.key] = entry.html;
      });
      Array.prototype.slice.call(rows.children || []).forEach(function (node) {
        var key = String(node.getAttribute('data-conversation-virtual-key') || '');
        if (!key || !desired[key]) rows.removeChild(node);
      });
      nextRows.forEach(function (entry, index) {
        var node = desired[entry.key];
        var reference = rows.children[index] || null;
        if (node !== reference) rows.insertBefore(node, reference);
      });
      renderedHtmlByKey = nextHtmlByKey;
    }
    function render(renderOptions) {
      frame = 0;
      if (destroyed) return;
      var forceEnd = !!(renderOptions && renderOptions.end === true);
      var height = Math.max(rowHeight, Number(container.clientHeight) || rowHeight * 6);
      var start = 0;
      var end = items.length;
      if (virtualize) {
        var count = Math.ceil(height / rowHeight) + overscan * 2;
        var maxStart = Math.max(0, items.length - count);
        var estimatedStart = Math.max(0, Math.floor(Number(container.scrollTop) / rowHeight) - overscan);
        var currentScrollHeight = Number(container.scrollHeight) || 0;
        var pinnedToEnd = currentScrollHeight > height
          && currentScrollHeight - Number(container.scrollTop || 0) - height <= 2;
        start = forceEnd || pinnedToEnd ? maxStart : Math.min(maxStart, estimatedStart);
        end = Math.min(items.length, start + count);
      }
      topSpacer.style.height = start * rowHeight + 'px';
      bottomSpacer.style.height = Math.max(0, items.length - end) * rowHeight + 'px';
      var nextRows = [];
      for (var index = start; index < end; index += 1) {
        nextRows.push({ key: keyOf(items[index], index), html: String(renderItem(items[index], index) || '') });
      }
      reconcileRows(nextRows);
      rows.setAttribute('data-conversation-virtual-start', String(start));
      rows.setAttribute('data-conversation-virtual-end', String(end));
      if (typeof options.onRendered === 'function') options.onRendered(rows, start, end);
      if (forceEnd) {
        var scrollHeight = Number(container.scrollHeight);
        if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) scrollHeight = items.length * rowHeight;
        container.scrollTop = Math.max(0, scrollHeight - Number(container.clientHeight || 0));
      }
    }
    function scheduleRender() {
      if (destroyed || frame) return;
      var raf = options.requestAnimationFrame || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (callback) { return setTimeout(callback, 0); });
      frame = raf(render);
    }
    function setItems(nextItems, setOptions) {
      setOptions = setOptions || {};
      var updatingAttribute = 'data-conversation-virtual-updating';
      var canMarkUpdating = typeof container.setAttribute === 'function'
        && typeof container.getAttribute === 'function';
      var hadUpdatingAttribute = canMarkUpdating && container.getAttribute(updatingAttribute) !== null;
      if (canMarkUpdating) container.setAttribute(updatingAttribute, 'true');
      try {
        var previousTop = Number(container.scrollTop) || 0;
        var previousIndex = Math.max(0, Math.floor(previousTop / rowHeight));
        var anchorKey = keyOf(items[previousIndex], previousIndex);
        var anchorOffset = previousTop - previousIndex * rowHeight;
        items = Array.isArray(nextItems) ? nextItems.slice() : [];
        var anchorScrollTop = null;
        if (virtualize && setOptions.preserveAnchor !== false && anchorKey) {
          var nextIndex = -1;
          for (var index = 0; index < items.length; index += 1) {
            if (keyOf(items[index], index) === anchorKey) { nextIndex = index; break; }
          }
          if (nextIndex >= 0) anchorScrollTop = nextIndex * rowHeight + anchorOffset;
        }
        if (setOptions.stickToEnd === true) {
          render({ end: true });
        } else {
          /* Render the new spacers before restoring a prepend anchor. Setting a
             larger scrollTop against the old, shorter DOM is clamped to zero and
             makes the top-edge loader request every older page in a loop. */
          render();
          var restoredScrollTop = Number(setOptions.scrollTop);
          var nextScrollTop = Number.isFinite(restoredScrollTop) && restoredScrollTop >= 0
            ? restoredScrollTop : anchorScrollTop;
          if (Number.isFinite(nextScrollTop) && nextScrollTop >= 0) {
            container.scrollTop = nextScrollTop;
            render();
          }
        }
      } finally {
        if (canMarkUpdating) {
          if (hadUpdatingAttribute) container.setAttribute(updatingAttribute, 'true');
          else if (typeof container.removeAttribute === 'function') container.removeAttribute(updatingAttribute);
        }
      }
    }
    function scrollToEnd() {
      render({ end: true });
    }
    function destroy() {
      if (destroyed) return;
      rememberDisclosureState();
      destroyed = true;
      if (virtualize) container.removeEventListener('scroll', scheduleRender);
      container.textContent = '';
      items = [];
      renderedHtmlByKey = Object.create(null);
    }
    if (virtualize) container.addEventListener('scroll', scheduleRender, { passive: true });
    render();
    return Object.freeze({
      API_VERSION: API_VERSION,
      setItems: setItems,
      render: render,
      scrollToEnd: scrollToEnd,
      getItems: function () { return items.slice(); },
      destroy: destroy,
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
    describeOperation: describeOperation,
    toolTitle: toolTitle,
    durableEventKey: durableEventKey,
    projectDurableEvent: projectDurableEvent,
    liveEvents: liveEvents,
    mergeProjected: mergeProjected,
    mergeProjectedPages: mergeProjectedPages,
    mergeJournalPages: mergeJournalPages,
    pendingSteeringMessages: pendingSteeringMessages,
    projectPage: projectPage,
    search: search,
    exportJournal: exportJournal,
    shouldDisplayReasoning: shouldDisplayReasoning,
    isToolCallsFinishReason: isToolCallsFinishReason,
    displayFinishStatus: displayFinishStatus,
    createVirtualList: createVirtualList,
  });
});
