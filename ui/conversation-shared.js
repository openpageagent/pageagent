// 页面底部 Conversation 入口（content/page-conversation-panel.js）与配置中心
// Conversation 入口（options/conversation.js）共用的对话事件处理逻辑。
// 实现以 options/conversation.js 为准：两处入口只保留各自的事件列表来源、
// DOM/状态与反馈载体，其余文本、标题、可见性、渲染、复制与下载全部走这里。
(function attachConversationShared(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationConversationShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;
  var rootRef = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
  var eventView = rootRef && rootRef.PageAutomationConversationEventView;

  // ---- 基础工具（与 conversation 一致） ----

  function escapeHtml(value) {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderMarkdown(text) {
    if (!eventView || typeof eventView.renderMarkdown !== 'function') return String(text || '');
    return eventView.renderMarkdown(text);
  }

  function statusLabel(status) {
    if (String(status || '').trim().toLowerCase() === 'tool_calls' || String(status || '').trim() === '调用工具') return '';
    var label = eventView && typeof eventView.statusLabel === 'function' ? eventView.statusLabel(status) : '';
    return label || '空闲';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function pad(number, length) {
      var text = String(number);
      while (text.length < length) text = '0' + text;
      return text;
    }
    var time = pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2)
      + '.' + pad(d.getMilliseconds(), 3);
    return d.toLocaleDateString() + ' ' + time;
  }

  function safeFileName(value) {
    return String(value || 'topic').trim().replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^_+|_+$/g, '') || 'topic';
  }

  function safeTimestamp(ts) {
    var d = new Date(ts || Date.now());
    function pad(value) { return String(value).padStart(2, '0'); }
    return d.getFullYear()
      + pad(d.getMonth() + 1)
      + pad(d.getDate())
      + '-'
      + pad(d.getHours())
      + pad(d.getMinutes())
      + pad(d.getSeconds());
  }

  function copyText(text) {
    text = String(text === undefined || text === null ? '' : text);
    function legacyCopy() {
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
          if (document.execCommand('copy')) resolve();
          else reject(new Error('copy failed'));
        } catch (err) {
          reject(err);
        } finally {
          ta.remove();
        }
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(); });
    }
    return legacyCopy();
  }

  function copySelectionWithoutTrailingBlankLines(event, container) {
    if (!event || !event.clipboardData || !container || !container.ownerDocument) return false;
    var doc = container.ownerDocument;
    var selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return false;
    if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return false;
    var text = String(selection.toString() || '')
      .replace(/[ \t\u00a0]*(?:\r?\n[ \t\u00a0]*)+$/, '')
      .replace(/[ \t\u00a0]+$/, '');
    if (!text) return false;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    return true;
  }

  // 与 conversation 的 statusLabel 一致：tool_calls 不显示状态。
  function formatTokenEstimate(value) {
    var count = Math.max(0, Number(value) || 0);
    if (count >= 1000) return (Math.round(count / 100) / 10) + 'k';
    return String(count);
  }

  // ---- 事件语义文本（conversation eventCopyText 全量实现） ----

  function isKnowledgeCaptureEvent(event) {
    var title = String(event && event.title || '');
    return title === '知识已新建' || title === '知识已复用' || title === '知识已合并';
  }

  function isUserInputEvent(event) {
    var title = String(event && event.title || '');
    return event && event.kind === 'user-input'
      || title === '需要你的回答'
      || title === '已收到你的回答'
      || title === '用户输入请求已取消';
  }

  function isContextCompactedEvent(event) {
    var title = String(event && event.title || '');
    var detail = event && (event.result !== undefined ? event.result : event.detail) || {};
    return title === 'Context compacted' || title === '上下文已压缩' || detail && detail.implementation === 'model-summary' && detail.reason === 'history-context-budget';
  }

  function isContextResetEvent(event) {
    var title = String(event && event.title || '');
    var detail = event && (event.result !== undefined ? event.result : event.detail) || {};
    return title === 'Context reset' || title === '上下文已重置' || detail && detail.implementation === 'clean-fact-pack';
  }

  function isDecisionVerificationEvent(event) {
    var title = String(event && event.title || '');
    return title === 'Verification incomplete' || title === 'Verification failed'
      || title === '验证未完成' || title === '验证失败';
  }

  function contextEventDetail(event) {
    var detail = event && (event.result !== undefined ? event.result : event.detail) || {};
    return detail && typeof detail === 'object' ? detail : {};
  }

  function decisionVerificationTitle(event) {
    var detail = contextEventDetail(event);
    if (detail.status === 'blocked') return '目标受阻';
    return String(event && event.title || '') === 'Verification failed' || detail.status === 'failed'
      ? '验证失败'
      : '验证未完成';
  }

  function decisionVerificationMissingLabel(value) {
    if (value === 'tool-backed evidence satisfying the completion standard') {
      return '缺少满足完成标准的工具验证证据';
    }
    if (value === 'successful task-specific verification after the latest tool failure') {
      return '最新工具失败后，缺少成功的任务专项验证';
    }
    if (value === 'valid model response and required verification evidence') {
      return '缺少有效的模型回复和必要的验证证据';
    }
    return value;
  }

  function decisionVerificationEventText(event) {
    var detail = contextEventDetail(event);
    var title = decisionVerificationTitle(event);
    var missing = (Array.isArray(detail.missing) ? detail.missing : [])
      .map(decisionVerificationMissingLabel).filter(Boolean);
    var evidenceRefs = Array.isArray(detail.evidenceRefs) ? detail.evidenceRefs.filter(Boolean) : [];
    var lines = detail.status === 'blocked'
      ? [title + (missing[0] ? '：' + missing[0] : '') + '。']
      : [title + '：' + (missing[0] || '本轮没有取得满足完成标准的验证证据') + '。'];
    if (missing.length > 1) lines.push('仍缺少：' + missing.slice(1).join('；') + '。');
    if (evidenceRefs.length) lines.push('已取得证据：' + evidenceRefs.join('、') + '。');
    return lines.join('\n');
  }

  function decisionVerificationEventHtml(event) {
    return renderMarkdown(decisionVerificationEventText(event));
  }

  function compactReasonLabel(reason) {
    if (reason === 'history-context-budget') return '历史上下文超过预算';
    return reason || '自动压缩';
  }

  function contextResetReasonLabel(reason) {
    if (reason === 'user_requested_stop_or_summary') return '用户要求停止或收束';
    if (reason === 'user_requested_summary_or_review') return '用户要求总结或评审';
    if (reason === 'user_requested_retry_or_restart') return '用户要求重试或重开';
    if (reason === 'user_requested_correction') return '用户要求纠正方向';
    if (reason === 'pending_clean_context_from_previous_failure') return '上轮失败后重新整理上下文';
    if (reason === 'default_to_clean_analysis_context') return '分析类请求使用干净上下文';
    if (reason === 'user_requested_execution') return '用户要求继续执行';
    if (reason === 'user_requested_execution_from_existing_analysis') return '沿用已有分析继续执行';
    return reason || '开启干净上下文窗口';
  }

  function contextResetIntentLabel(intent) {
    if (intent === 'stop') return '停止/收束';
    if (intent === 'summary') return '总结';
    if (intent === 'review') return '评审';
    if (intent === 'retry') return '重试';
    if (intent === 'correction') return '纠正';
    if (intent === 'execution') return '执行';
    if (intent === 'analysis') return '分析';
    return intent || '当前请求';
  }

  function contextCompactedEventText(event) {
    var detail = contextEventDetail(event);
    var before = Math.max(0, Number(detail.estimatedHistoryTokens || detail.estimatedTokens) || 0);
    var after = Math.max(0, Number(detail.outputTokens) || 0);
    var kept = Math.max(0, Number(detail.keptMessages) || 0);
    var dropped = Math.max(0, Number(detail.droppedMessages) || 0);
    var lines = [];
    lines.push('上下文已压缩：'
      + (before ? formatTokenEstimate(before) + ' -> ' : '')
      + formatTokenEstimate(after) + ' tokens。');
    lines.push('触发原因：' + compactReasonLabel(detail.reason)
      + '；保留 ' + kept + ' 条，丢弃 ' + dropped + ' 条'
      + '；触发方式：' + (detail.forced ? '手动/强制' : '自动') + '。');
    return lines.join('\n');
  }

  function contextCompactedEventHtml(event) {
    return renderMarkdown(contextCompactedEventText(event));
  }

  function contextResetEventText(event) {
    var detail = contextEventDetail(event);
    var source = Math.max(0, Number(detail.sourceMessages) || 0);
    var kept = Math.max(0, Number(detail.keptMessages) || 0);
    var dropped = Math.max(0, Number(detail.droppedMessages) || 0);
    var budget = Math.max(0, Number(detail.inputBudget) || 0);
    var lines = [];
    lines.push('上下文已重置：已用最近事实包' + (detail.cleanWindow === false ? '重组上下文。' : '开启干净上下文窗口。'));
    lines.push('触发原因：' + contextResetReasonLabel(detail.reason)
      + '；当前意图：' + contextResetIntentLabel(detail.intent) + '。');
    lines.push('历史消息：来源 ' + source + ' 条，保留 ' + kept + ' 条，丢弃 ' + dropped + ' 条'
      + (budget ? '；输入预算：' + formatTokenEstimate(budget) + ' tokens' : '')
      + '。');
    return lines.join('\n');
  }

  function contextResetEventHtml(event) {
    return renderMarkdown(contextResetEventText(event));
  }

  function userInputEventText(event) {
    var detail = contextEventDetail(event);
    var questions = Array.isArray(detail.questions) ? detail.questions : [];
    var answers = detail.answers && typeof detail.answers === 'object' ? detail.answers : {};
    var title = String(event && event.title || '用户输入');
    var lines = [title + '：'];
    questions.forEach(function (question, index) {
      question = question && typeof question === 'object' ? question : {};
      var header = String(question.header || '').trim() || '问题 ' + (index + 1);
      var prompt = String(question.question || '').trim();
      var answer = answers[question.id];
      var values = answer && typeof answer === 'object' && Array.isArray(answer.answers)
        ? answer.answers
        : (Array.isArray(answer) ? answer : []);
      values = values.map(function (value) { return String(value || '').trim(); }).filter(Boolean);
      lines.push(header + (prompt ? '：' + prompt : ''));
      if (values.length) lines.push('回答：' + values.join('；'));
    });
    if (detail.error) lines.push('原因：' + String(detail.error));
    if (!questions.length && detail.status) lines.push('状态：' + statusLabel(detail.status));
    return lines.join('\n');
  }

  function userInputEventHtml(event) {
    return renderMarkdown(userInputEventText(event));
  }

  function knowledgeCaptureEventText(event) {
    event = event || {};
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    var result = event.result && typeof event.result === 'object' ? event.result : {};
    var title = detail.knowledgeTitle || result.title || '未命名知识';
    var summary = detail.knowledgeSummary || result.summary || '';
    var knowledgeId = detail.knowledgeId || result.id || '';
    var type = detail.knowledgeType || result.typeLabel || result.type || '知识';
    var sourceKind = detail.sourceKind || result.sourceKind || result.source && result.source.kind || 'auto';
    var priorityTier = detail.priorityTier || result.priorityTier || (sourceKind === 'builtin' ? 1 : sourceKind === 'mcp' ? 3 : sourceKind === 'skill' ? 4 : 2);
    var tags = Array.isArray(detail.tags) && detail.tags.length ? detail.tags : (Array.isArray(result.tags) ? result.tags : []);
    var count = detail.captureCount || result.captureCount || 0;
    var decision = String(detail.action || '');
    var action = decision === 'create' ? '新建知识' : (decision === 'deduplicate' ? '复用已有知识' : '合并知识');
    return [
      action + ': ' + title,
      summary ? '摘要: ' + summary : '',
      knowledgeId ? '知识 ID: ' + knowledgeId : '',
      '类型: ' + type,
      '来源: ' + sourceKind + ' / P' + priorityTier,
      tags.length ? '标签: ' + tags.slice(0, 8).join(', ') : '',
      count ? '累计沉淀: ' + count + ' 次' : '',
    ].filter(Boolean).join('\n');
  }

  function toolEventName(event) {
    event = event || {};
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    var call = event.call && typeof event.call === 'object'
      ? event.call : (detail.call && typeof detail.call === 'object' ? detail.call : {});
    var fn = call.function && typeof call.function === 'object' ? call.function : {};
    var tool = call.tool && typeof call.tool === 'object' ? call.tool : {};
    var title = String(event.title || '');
    var fromTitle = /^调用工具\s*[:：]\s*(.+)$/.exec(title);
    var name = String(detail.name || call.name || fn.name || tool.name || event.toolName || event.tool_name
      || (fromTitle && fromTitle[1]) || '').trim();
    return name.toUpperCase();
  }

  function toolEventArguments(event) {
    event = event || {};
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    var call = event.call && typeof event.call === 'object'
      ? event.call : (detail.call && typeof detail.call === 'object' ? detail.call : {});
    var fn = call.function && typeof call.function === 'object' ? call.function : {};
    var value = call.arguments !== undefined ? call.arguments
      : (fn.arguments !== undefined ? fn.arguments : detail.argumentsText);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function toolEventDisplayName(event) {
    event = event || {};
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    var provided = String(detail.displayName || '').trim();
    if (provided && !/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)(?:\s|$)|^ASK_USER$|^执行资源操作$/i.test(provided)) return provided;
    var name = toolEventName(event);
    if (name === 'ASK_USER') return '请求用户输入';
    if (typeof event.operation === 'string' && event.operation.trim()) return event.operation.trim();
    var listView = rootRef && rootRef.PageAutomationConversationListView;
    var args = toolEventArguments(event);
    var described = listView && typeof listView.describeOperation === 'function'
      ? listView.describeOperation(name || detail.method, args.uri || detail.canonicalUri)
      : '';
    if (described) return described;
    if (listView && typeof listView.toolTitle === 'function') return listView.toolTitle(name);
    return name ? '调用工具 ' + name : '工具调用';
  }

  function toolEventDetailValue(event) {
    event = event || {};
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    var call = event.call && typeof event.call === 'object'
      ? event.call : (detail.call && typeof detail.call === 'object' ? detail.call : {});
    var args = toolEventArguments(event);
    var name = toolEventName(event);
    var target = detail.target || '';
    var invocation = {
      name: name,
      displayName: toolEventDisplayName(event) || String(event.title || '').trim() || '工具调用',
      target: target,
      status: statusLabel(detail.status),
    };
    if (event.call !== undefined) invocation.call = event.call;
    else if (detail.call !== undefined) invocation.call = detail.call;
    if (detail.argumentsText) invocation.argumentsText = detail.argumentsText;
    if (event.result !== undefined) return { tool: invocation, result: event.result };
    return Object.assign({}, detail, invocation);
  }

  function toolEventCodeValue(event) {
    if (!event) return undefined;
    if (Object.prototype.hasOwnProperty.call(event, 'codeValue')) return event.codeValue;
    if (event.kind !== 'tool' && event.kind !== 'tool-result') return undefined;
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    if (event.result !== undefined || event.call !== undefined
        || detail.call !== undefined || detail.argumentsText) {
      return toolEventDetailValue(event);
    }
    return detail.content || detail.message || event.text;
  }

  function isToolEvent(event) {
    return !!(event && (event.kind === 'tool' || event.kind === 'tool-result'
      || /^tool_(?:call|execution)_/.test(String(event.canonicalType || ''))
      || String(event.operation || '').trim()));
  }

  // 事件正文：conversation eventCopyText 全量实现（产品事件 + 工具 + 通用回退链）。
  function eventText(event) {
    if (isKnowledgeCaptureEvent(event)) return knowledgeCaptureEventText(event);
    if (isUserInputEvent(event)) return userInputEventText(event);
    if (isContextCompactedEvent(event)) return contextCompactedEventText(event);
    if (isContextResetEvent(event)) return contextResetEventText(event);
    if (isDecisionVerificationEvent(event)) return decisionVerificationEventText(event);
    if (event && event.kind === 'tool') {
      var toolDetail = toolEventDetailValue(event);
      if (typeof toolDetail === 'string' && toolDetail) return toolDetail;
      if (toolDetail && typeof toolDetail === 'object') {
        if (typeof toolDetail.content === 'string' && toolDetail.content) return toolDetail.content;
        if (typeof toolDetail.message === 'string' && toolDetail.message) return toolDetail.message;
        if (typeof toolDetail.error === 'string' && toolDetail.error) return toolDetail.error;
      }
      if (typeof event.text === 'string') return event.text;
      return '';
    }
    var detail = event && event.result !== undefined ? event.result : event && event.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (detail && typeof detail === 'object') {
      if (typeof detail.content === 'string' && detail.content) return detail.content;
      if (typeof detail.message === 'string' && detail.message) return detail.message;
      if (typeof detail.error === 'string' && detail.error) return detail.error;
    }
    if (event && typeof event.text === 'string') return event.text;
    return '';
  }

  // 事件详情 HTML（conversation eventDetailHtml，含产品事件语义渲染）。
  function eventDetailHtml(event) {
    if (!event) return '';
    if (isKnowledgeCaptureEvent(event)) return renderMarkdown(knowledgeCaptureEventText(event));
    if (isUserInputEvent(event)) return userInputEventHtml(event);
    if (isContextCompactedEvent(event)) return contextCompactedEventHtml(event);
    if (isContextResetEvent(event)) return contextResetEventHtml(event);
    if (isDecisionVerificationEvent(event)) return decisionVerificationEventHtml(event);
    var detail = event.kind === 'tool' ? toolEventDetailValue(event)
      : (event.result !== undefined ? event.result : event.detail);
    if (typeof detail === 'string' && detail) return renderMarkdown(detail);
    if (detail && typeof detail === 'object') {
      if (typeof detail.content === 'string' && detail.content) return renderMarkdown(detail.content);
      if (typeof detail.message === 'string' && detail.message) return renderMarkdown(detail.message);
      if (typeof detail.error === 'string' && detail.error) return '<p class="conversation-error-text">' + escapeHtml(detail.error) + '</p>';
    }
    // Journal 投影事件把路由声明的 model-facing 工具结果放在 .text。
    // 界面与模型投影保持一致：模型看到什么，详情就展示什么。
    if ((event.kind === 'tool' || event.kind === 'tool-result') && typeof event.text === 'string' && event.text) {
      return renderMarkdown(event.text);
    }
    var text = eventText(event);
    if (text) {
      return event.kind === 'error'
        ? '<p class="conversation-error-text">' + escapeHtml(text) + '</p>'
        : renderMarkdown(text);
    }
    return '';
  }

  function compactEventSummary(event) {
    if (!event) return '';
    if (isToolEvent(event)) return '';
    var detail = event.result !== undefined ? event.result : event.detail;
    if (event.kind === 'llm-request' && detail && detail.request) {
      var body = detail.request.body || {};
      var messages = Array.isArray(body.messages) ? body.messages.length : 0;
      var tools = Array.isArray(body.tools) ? body.tools.length : 0;
      return [body.model || detail.model || '', messages ? 'messages ' + messages : '', tools ? 'tools ' + tools : '', body.stream ? 'stream' : 'non-stream'].filter(Boolean).join(' · ');
    }
    if (event.kind === 'llm-response' && detail && detail.response) {
      var response = detail.response || {};
      return [response.statusCode ? 'HTTP ' + response.statusCode : '', response.ok === false ? 'error' : '', response.rawBody ? String(response.rawBody).length + ' chars' : ''].filter(Boolean).join(' · ');
    }
    if (event && event.detail && event.detail.status) {
      var name = event.kind === 'tool' ? toolEventDisplayName(event) : (event.detail.name || event.title || '');
      return (name ? name + ' ' : '') + statusLabel(event.detail.status);
    }
    if (isKnowledgeCaptureEvent(event)) {
      var knowledgeDetail = event.detail || {};
      var knowledgeResult = event.result || {};
      return knowledgeDetail.knowledgeTitle || knowledgeResult.title || '';
    }
    if (isContextCompactedEvent(event)) {
      var compactDetail = contextEventDetail(event);
      var before = Math.max(0, Number(compactDetail.estimatedHistoryTokens || compactDetail.estimatedTokens) || 0);
      var after = Math.max(0, Number(compactDetail.outputTokens) || 0);
      return [compactReasonLabel(compactDetail.reason), before ? formatTokenEstimate(before) + ' -> ' + formatTokenEstimate(after) + ' tokens' : ''].filter(Boolean).join(' · ');
    }
    if (isContextResetEvent(event)) {
      var resetDetail = contextEventDetail(event);
      var source = Math.max(0, Number(resetDetail.sourceMessages) || 0);
      var kept = Math.max(0, Number(resetDetail.keptMessages) || 0);
      return [
        contextResetReasonLabel(resetDetail.reason),
        contextResetIntentLabel(resetDetail.intent),
        source ? 'messages ' + source + ' -> ' + kept : '',
      ].filter(Boolean).join(' · ');
    }
    if (isDecisionVerificationEvent(event)) {
      var verificationDetail = contextEventDetail(event);
      var verificationMissing = Array.isArray(verificationDetail.missing) && verificationDetail.missing.length
        ? decisionVerificationMissingLabel(verificationDetail.missing[0])
        : '';
      return verificationMissing;
    }
    if (!detail || typeof detail !== 'object') return '';
    if (detail.error) return detail.error;
    if (detail.message) return detail.message;
    if (detail.pageId) return 'pageId: ' + detail.pageId;
    if (detail.page && detail.page.id) return 'pageId: ' + detail.page.id;
    if (detail.touched) {
      return 'pages ' + ((detail.touched.pages || []).length)
        + ', flows ' + ((detail.touched.flows || []).length)
        + ', groups ' + ((detail.touched.flowGroups || []).length);
    }
    if (detail.validation) {
      return 'errors ' + ((detail.validation.errors || []).length)
        + ', warnings ' + ((detail.validation.warnings || []).length);
    }
    return '';
  }

  function isInternalAgentMarker(event) {
    var title = event && (event.title || event.type) || '';
    return title === 'agent_content_end' || title === 'agent_reasoning_end';
  }

  function isResolvedRetryEvent(event) {
    var detail = event && event.detail || {};
    return detail && detail.reason === 'empty_model_response' && detail.resolved === true;
  }

  function isEmptyAssistantEvent(event) {
    return !!(event && event.kind === 'assistant' && !eventText(event).trim());
  }

  // 事件是否在对话流中展示（conversation visibleTopicEvents 的过滤规则）。
  function isVisibleEvent(event) {
    if (!event) return false;
    if (event.hidden === true || event.detail && event.detail.hidden === true) return false;
    if (event.kind === 'reasoning') {
      var listView = rootRef && rootRef.PageAutomationConversationListView;
      if (listView && typeof listView.shouldDisplayReasoning === 'function'
          && !listView.shouldDisplayReasoning(eventText(event))) return false;
    }
    if (isResolvedRetryEvent(event)) return false;
    if (isEmptyAssistantEvent(event)) return false;
    if (isInternalAgentMarker(event)) return false;
    if (event.kind === 'llm-request' || event.kind === 'llm-response') return false;
    return true;
  }

  function canRetryEvent(event) {
    var detail = event && event.detail || {};
    if (!detail || detail.retryable !== true) return false;
    if (detail.resolved === true) return false;
    if (detail.reason !== 'empty_model_response') return false;
    if (!String(detail.retryMessage || '').trim()) return false;
    return event.kind === 'warn';
  }

  // 事件标题（conversation renderEvent 的标题推导）。
  function eventTitle(event) {
    var kind = event && event.kind || 'info';
    var toolName = isToolEvent(event) ? toolEventDisplayName(event) : '';
    return isContextCompactedEvent(event) ? '上下文已压缩'
      : (isContextResetEvent(event) ? '上下文已重置'
        : (isDecisionVerificationEvent(event) ? decisionVerificationTitle(event)
          : (toolName ? toolName
            : (event && event.title || kind || '事件'))));
  }

  // 事件按钮/查找目标，与 conversation-event-view 的 target 构造一致。
  function eventTarget(event, index) {
    if (event && event.eventId) return event.eventId;
    if (event && event.eventKey) return event.eventKey;
    if (event && event.liveKey) return event.liveKey;
    if (event && event.id) return event.id;
    return 'idx_' + index;
  }

  function findEventByTarget(events, target) {
    target = String(target || '');
    if (target.indexOf('idx_') === 0) return events[Number(target.slice(4))] || null;
    return (Array.isArray(events) ? events : []).filter(function (event) {
      return event && String(event.eventId || event.eventKey || event.liveKey || event.id || '') === target;
    })[0] || null;
  }

  // 对话事件卡的唯一装配入口。调用方只提供话题和入口特有状态，事件正文、
  // 标题、状态、操作与标签均保持 Conversation 的产品语义。
  function renderEvent(event, index, options) {
    if (!event || !eventView || typeof eventView.renderEvent !== 'function') return '';
    options = options || {};
    var text = eventText(event);
    var reasoningEvent = event.kind === 'reasoning';
    var summary = reasoningEvent ? '' : compactEventSummary(event);
    var detailHtml = eventDetailHtml(event);
    var eventStatus = event.detail && event.detail.status || event.status || '';
    var toolEvent = isToolEvent(event);
    var codeValue = toolEvent ? toolEventCodeValue(event) : undefined;
    var normalizedStatus = String(eventStatus).trim().toLowerCase();
    var renderOptions = {
      kind: event.kind || 'info',
      title: eventTitle(event),
      text: text,
      status: eventStatus,
      eventKey: eventView.eventKey(event),
      target: eventTarget(event, index),
      timeText: fmtTime(event.at),
      summary: summary,
      detailHtml: detailHtml,
      codeValue: codeValue,
      retry: options.readOnly !== true && canRetryEvent(event),
      copy: codeValue !== undefined || !!text,
      download: !!text && isDownloadable(event),
      topicId: String(options.topicId || ''),
    };
    if (reasoningEvent) {
      var reasoningStartedAt = Math.max(0, Number(event.startedAt) || 0);
      if (reasoningStartedAt) renderOptions.elapsedStartedAt = reasoningStartedAt;
      if (Object.prototype.hasOwnProperty.call(event, 'durationMs')) {
        renderOptions.elapsedDurationMs = Math.max(0, Number(event.durationMs) || 0);
      }
      renderOptions.elapsedRunning = normalizedStatus === 'thinking' && reasoningStartedAt > 0;
    }
    if (toolEvent && (normalizedStatus === 'running' || normalizedStatus === 'streaming')) {
      renderOptions.collapsible = false;
    } else if (toolEvent && !!(summary || detailHtml)) {
      renderOptions.collapsible = true;
    } else if (reasoningEvent && !!detailHtml) {
      renderOptions.collapsible = true;
    }
    return eventView.renderEvent(event, index, renderOptions);
  }

  function renderPendingSteering(messages, options) {
    options = options || {};
    messages = Array.isArray(messages) ? messages.filter(function (item) {
      return !!String(item && item.text || '').trim();
    }) : [];
    if (!messages.length) return '';
    var interruptAction = options.canInterrupt === true
      ? '<button type="button" class="conversation-steering-interrupt" data-conversation-action="interrupt-model-request" title="立即停止当前模型请求并处理这些消息"'
        + (options.interrupting === true ? ' disabled' : '') + '>'
        + (options.interrupting === true ? '正在切换' : '立即处理') + '</button>'
      : '';
    return '<section class="conversation-steering-queue" role="status" aria-live="polite">'
      + '<header><b>待 Agent 接收</b><span>' + messages.length + ' 条</span>' + interruptAction + '</header>'
      + '<ol>' + messages.map(function (item) {
        return '<li><span>' + escapeHtml(item.text) + '</span><small>等待接收</small></li>';
      }).join('') + '</ol></section>';
  }

  // ---- 下载 / Markdown 导出（以 conversation 为准） ----

  function isDownloadable(event) {
    var title = String(event && event.title || '');
    if (title === '对话摘要' || title === '思考摘要' || title === '思考') return true;
    if (event && event.kind === 'reasoning' && eventText(event).trim()) return true;
    return !!(event && event.kind === 'assistant' && eventText(event).trim());
  }

  function markdownText(event, meta) {
    var text = eventText(event);
    if (!text) return '';
    var title = event && event.kind === 'reasoning'
      ? '思考'
      : String(event && event.title || '对话摘要').trim() || '对话摘要';
    var topicTitle = String(meta && meta.topicTitle || '');
    var assistantName = String(meta && meta.assistantName || '');
    var lines = [
      '# ' + title,
      '',
      topicTitle ? '- 话题: ' + topicTitle : '',
      assistantName ? '- 助手: ' + assistantName : '',
      event && event.at ? '- 时间: ' + fmtTime(event.at) : '',
      '',
      '---',
      '',
      text,
      '',
    ].filter(function (line, index, list) {
      if (line) return true;
      return !(index > 1 && !list[index - 1] && !list[index + 1]);
    });
    return lines.join('\n');
  }

  function markdownFileName(event, meta) {
    var title = safeFileName(meta && meta.topicTitle || 'topic');
    var prefix = isDownloadable(event) && (event.title === '思考摘要' || event.title === '思考' || event.kind === 'reasoning')
      ? 'conversation-reasoning-summary' : 'conversation-summary';
    return prefix + '-' + title.slice(0, 80) + '-' + safeTimestamp(event && event.at) + '.md';
  }

  function downloadFile(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([String(content || '')], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function copyEvent(event) {
    var text = eventText(event);
    if (isToolEvent(event)) {
      var codeValue = toolEventCodeValue(event);
      if (codeValue !== undefined) {
        try { text = JSON.stringify(codeValue, null, 2) || text; } catch (_) {}
      }
    }
    if (!text) return Promise.resolve({ ok: false, message: '没有可复制的内容' });
    return copyText(text).then(function () {
      return { ok: true, message: '已复制' };
    }).catch(function (error) {
      return {
        ok: false,
        message: '复制失败: ' + String(error && error.message || error || '未知错误'),
        error: error,
      };
    });
  }

  function downloadEventMarkdown(event, meta) {
    if (!isDownloadable(event)) return { ok: false, message: '这条消息不能下载' };
    var text = markdownText(event, meta);
    if (!text) return { ok: false, message: '没有可下载的 Markdown 内容' };
    downloadFile(markdownFileName(event, meta), text, 'text/markdown;charset=utf-8');
    return { ok: true, message: '已开始下载 Markdown' };
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    escapeHtml: escapeHtml,
    renderMarkdown: renderMarkdown,
    statusLabel: statusLabel,
    fmtTime: fmtTime,
    safeFileName: safeFileName,
    safeTimestamp: safeTimestamp,
    copyText: copyText,
    copySelectionWithoutTrailingBlankLines: copySelectionWithoutTrailingBlankLines,
    eventText: eventText,
    eventDetailHtml: eventDetailHtml,
    compactEventSummary: compactEventSummary,
    toolEventCodeValue: toolEventCodeValue,
    eventTitle: eventTitle,
    eventTarget: eventTarget,
    findEventByTarget: findEventByTarget,
    isVisibleEvent: isVisibleEvent,
    canRetryEvent: canRetryEvent,
    renderEvent: renderEvent,
    renderPendingSteering: renderPendingSteering,
    isDownloadable: isDownloadable,
    markdownText: markdownText,
    markdownFileName: markdownFileName,
    downloadFile: downloadFile,
    copyEvent: copyEvent,
    downloadEventMarkdown: downloadEventMarkdown,
  });
});
