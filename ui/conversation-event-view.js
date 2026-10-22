(function attachConversationEventView(root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PageAutomationConversationEventView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var API_VERSION = 1;
  var STYLE_ATTRIBUTE = 'data-page-automation-conversation-event-view';
  var markdown;

  function esc(value) {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderMarkdown(text, options) {
    text = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
    try {
      if (!markdown) markdown = new root.marked.Marked({
        gfm: true, breaks: true, async: false,
        renderer: {
          // Keep user/model HTML as text, including conversation action attributes.
          html: function (token) { return esc(token.text).replace(/\n/g, '<br>'); },
          code: function (token) {
            var language = String(token.lang || '').trim().split(/\s+/)[0] || 'plaintext';
            return '<pre><code class="language-' + esc(language) + '">' + esc(token.text) + '</code></pre>\n';
          }
        }
      });
      var sanitizeOptions = {
        ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
        ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'align', 'start', 'type', 'checked', 'disabled', 'class'],
        ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
      };
      if (options && options.localImages === true) {
        sanitizeOptions.ALLOWED_URI_REGEXP = /^(?:https?:\/\/|mailto:|data:image\/(?:png|jpeg|gif|webp|avif);base64,|blob:chrome-extension:\/\/)/i;
      }
      var fragment = root.DOMPurify.sanitize(markdown.parse(text), sanitizeOptions);
      // A template keeps custom elements inert while we serialize the shared view.
      var template = root.document.createElement('template');
      template.content.appendChild(fragment);
      template.content.querySelectorAll('a').forEach(function (link) {
        // Conversations have no document base: relative URLs would differ between the two hosts.
        if (!/^(https?:\/\/|mailto:)/i.test(link.getAttribute('href') || '')) {
          link.replaceWith(...link.childNodes);
          return;
        }
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      });
      template.content.querySelectorAll('img').forEach(function (image) {
        var source = image.getAttribute('src') || '';
        var localImage = options && options.localImages === true && root.location && root.location.protocol === 'chrome-extension:'
          && source.startsWith('blob:chrome-extension://' + root.location.host + '/');
        if (!localImage && !/^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i.test(source)) {
          image.replaceWith(root.document.createTextNode(image.getAttribute('alt') || ''));
          return;
        }
        image.setAttribute('loading', 'lazy');
        image.setAttribute('decoding', 'async');
        image.setAttribute('referrerpolicy', 'no-referrer');
      });
      template.content.querySelectorAll('table').forEach(function (table) {
        var wrapper = root.document.createElement('div');
        wrapper.className = 'conversation-markdown-table';
        table.replaceWith(wrapper); wrapper.appendChild(table);
      });
      // Only our generated code blocks become editor elements, after HTML sanitization.
      template.content.querySelectorAll('pre > code').forEach(function (code) {
        var editor = root.document.createElement('template');
        editor.innerHTML = root.PageAgentCodeEditor.html(code.textContent, code.className.slice('language-'.length) || 'plaintext');
        code.parentNode.replaceWith(editor.content);
      });
      return '<div class="conversation-markdown">' + template.innerHTML + '</div>';
    } catch (error) {
      // A malformed message must not interrupt the conversation controls or streaming updates.
      console.error('Markdown 渲染失败', error);
      return '<div class="conversation-markdown"><p>' + esc(text).replace(/\n/g, '<br>') + '</p></div>';
    }
  }

  function eventText(event) {
    event = event || {};
    if (typeof event.text === 'string') return event.text;
    var detail = event.result !== undefined ? event.result : event.detail;
    if (typeof detail === 'string') return detail;
    if (!detail || typeof detail !== 'object') return '';
    if (typeof detail.content === 'string') return detail.content;
    if (typeof detail.message === 'string') return detail.message;
    if (typeof detail.error === 'string') return detail.error;
    return '';
  }

  function eventKey(event) {
    return String(event && (event.eventKey || event.liveKey || event.eventId || event.id) || '').trim();
  }

  function formatTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    function pad(number, length) {
      var text = String(number);
      while (text.length < length) text = '0' + text;
      return text;
    }
    var time = pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2)
      + '.' + pad(date.getMilliseconds(), 3);
    return date.toLocaleDateString() + ' ' + time;
  }

  function optionValue(options, key, fallback) {
    return options && Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback;
  }

  function formatElapsedDuration(value) {
    var milliseconds = Math.max(0, Number(value) || 0);
    var seconds = Math.round(milliseconds / 100) / 10;
    return String(seconds) + '秒';
  }

  var elapsedTimer = 0;
  var elapsedTimerEmptyTicks = 0;

  function updateElapsedLabels(rootNode, now) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return 0;
    var current = Math.max(0, Number(now) || Date.now());
    var nodes = rootNode.querySelectorAll('[data-conversation-elapsed-started-at]');
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index];
      var startedAt = Math.max(0, Number(node.getAttribute('data-conversation-elapsed-started-at')) || 0);
      if (startedAt) node.textContent = formatElapsedDuration(current - startedAt);
    }
    return nodes.length;
  }

  function ensureElapsedTimer() {
    if (elapsedTimer || !root || !root.document || typeof root.setInterval !== 'function') return;
    elapsedTimerEmptyTicks = 0;
    elapsedTimer = root.setInterval(function () {
      if (updateElapsedLabels(root.document, Date.now())) {
        elapsedTimerEmptyTicks = 0;
        return;
      }
      elapsedTimerEmptyTicks += 1;
      if (elapsedTimerEmptyTicks < 5) return;
      root.clearInterval(elapsedTimer);
      elapsedTimer = 0;
      elapsedTimerEmptyTicks = 0;
    }, 100);
  }

  function jsonCodeText(value) {
    if (value && typeof value === 'object') {
      try { return JSON.stringify(value, null, 2); }
      catch (_) { return ''; }
    }
    if (typeof value !== 'string') return '';
    var source = value.trim();
    if (!source || (source.charAt(0) !== '{' && source.charAt(0) !== '[')) return '';
    try { return JSON.stringify(JSON.parse(source), null, 2); }
    catch (_) { return ''; }
  }

  function renderJsonCode(value) {
    var source = jsonCodeText(value);
    if (!source) return '';
    return globalThis.PageAgentCodeEditor.html(source, 'json', { 'aria-label': 'JSON 详情' });
  }

  function statusLabel(value) {
    var original = String(value === undefined || value === null ? '' : value).trim();
    if (!original) return '';
    if (original === '已计划') return '待执行';
    if (original === '已延后') return '未执行';
    if (original === '完成（无副作用）') return '完成';
    var normalized = original.toLowerCase().replace(/[\s-]+/g, '_');
    // This is a provider finish reason, not a user-facing event status. The
    // corresponding tool events carry the visible operation and progress.
    if (normalized === 'tool_calls' || original === '调用工具') return '';
    var labels = {
      idle: '空闲', pending: '等待中', queued: '排队中', starting: '启动中',
      running: '运行中', thinking: '思考中', processing: '处理中', in_progress: '进行中',
      waiting: '等待中', waiting_user_input: '等待回答',
      ready: '就绪', stopping: '正在停止', retrying: '重试中', verifying: '验证中',
      completed: '完成', complete: '完成', done: '完成', received: '完成', stop: '完成',
      success: '成功', succeeded: '成功', passed: '通过',
      confirmed: '已确认', unconfirmed: '未确认',
      fail: '失败', failed: '失败', failure: '失败', error: '失败',
      stopped: '已停止', abort: '已停止', aborted: '已停止',
      cancel: '已取消', canceled: '已取消', cancelled: '已取消',
      partial: '部分完成', incomplete: '未完成', blocked: '已阻塞', skipped: '已跳过',
      interrupted: '已中断', timeout: '超时', timed_out: '超时', rejected: '已拒绝',
      open: '待处理', resolved: '已解决', answered: '已回答', closed: '已关闭', not_applicable: '不适用', unknown: '未知',
      not_performed: '未执行', deferred: '未执行', planned: '待执行',
    };
    return labels[normalized] || original;
  }

  function statusTone(value) {
    var label = statusLabel(value);
    if (['完成', '成功', '通过', '已确认', '已解决', '已回答', '已关闭'].indexOf(label) !== -1) return 'success';
    if (['启动中', '运行中', '思考中', '处理中', '进行中', '正在停止', '重试中', '验证中'].indexOf(label) !== -1) return 'active';
    if (['失败', '已停止', '已取消', '已阻塞', '已中断', '超时', '已拒绝'].indexOf(label) !== -1) return 'error';
    return 'neutral';
  }

  function eventAttachments(event, options) {
    var selected = optionValue(options, 'attachments', null);
    if (!Array.isArray(selected)) {
      selected = Array.isArray(event && event.attachments)
        ? event.attachments
        : event && event.detail && Array.isArray(event.detail.attachments) ? event.detail.attachments : [];
    }
    return selected.filter(function (item) {
      return item && item.type === 'image'
        && /^\/image-artifacts\/[A-Za-z0-9._~-]+$/.test(String(item.artifactUri || ''));
    }).slice(0, 4);
  }

  function formatBytes(value) {
    var bytes = Math.max(0, Number(value) || 0);
    if (!bytes) return '';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KiB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  }

  function renderAttachments(attachments, topicId) {
    function acquisitionLabel(value) {
      var labels = {
        'page-resource-cache': '页面缓存',
        'page-data-url': '页面数据',
        'page-blob': '页面 Blob',
        'page-canvas': 'Canvas',
        'page-svg-raster': 'SVG 栅格化',
        'page-video-frame': '视频帧',
        'page-context-fetch': '页面缓存优先读取',
        'extension-cache-fetch': '扩展缓存优先读取',
        'element-rendered-capture': '页面截图',
        'operation-viewport-capture': '操作视觉证据',
      };
      return labels[String(value || '')] || '';
    }
    return (attachments || []).map(function (item) {
      var representation = String(item.representation || '') === 'rendered' ? '渲染截图' : '原图';
      var dimensions = Number(item.width) > 0 && Number(item.height) > 0
        ? Math.round(Number(item.width)) + '×' + Math.round(Number(item.height)) : '';
      var meta = [representation, acquisitionLabel(item.acquisitionSource), dimensions, formatBytes(item.byteLength)].filter(Boolean).join(' · ');
      return '<figure class="conversation-image-attachment" data-image-artifact="' + esc(item.artifactUri) + '" data-topic-id="' + esc(topicId || '') + '">'
        + '<button type="button" class="conversation-image-preview" data-image-artifact-action="open" title="查看大图">'
        + '<img data-image-artifact-img alt="' + esc(item.alt || '页面图片') + '" hidden>'
        + '<span class="conversation-image-placeholder" data-image-artifact-placeholder>正在加载图片…</span></button>'
        + '<figcaption><span>' + esc(meta || representation) + '</span>'
        + '<button type="button" data-image-artifact-action="download" title="下载图片">下载</button></figcaption>'
        + '</figure>';
    }).join('');
  }

  function renderEvent(event, index, options) {
    if (!event) return '';
    options = options || {};
    if (event.hidden === true || event.detail && event.detail.hidden === true) return '';
    var kind = String(optionValue(options, 'kind', event.kind || 'info'));
    var text = String(optionValue(options, 'text', eventText(event)) || '');
    var title = kind === 'reasoning' ? '思考' : String(optionValue(options, 'title', event.title || kind || '事件'));
    var detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    var statusValue = optionValue(options, 'status', detail.status || event.status || '');
    var status = statusLabel(statusValue);
    var key = String(optionValue(options, 'eventKey', eventKey(event)) || '');
    var target = String(optionValue(options, 'target', event.eventId || key || 'idx_' + index));
    var timeText = String(optionValue(options, 'timeText', formatTime(event.at)) || '');
    var summary = String(optionValue(options, 'summary', '') || '');
    var codeValue = optionValue(options, 'codeValue', event.codeValue);
    var elapsedStartedAt = Math.max(0, Number(optionValue(options, 'elapsedStartedAt', 0)) || 0);
    var elapsedRunning = optionValue(options, 'elapsedRunning', false) === true && elapsedStartedAt > 0;
    var hasElapsedDuration = Object.prototype.hasOwnProperty.call(options, 'elapsedDurationMs');
    var elapsedDurationMs = Math.max(0, Number(optionValue(options, 'elapsedDurationMs', 0)) || 0);
    // 内容格式与事件语义是两条独立维度。工具结果可能因验证状态被标成
    // warn/error，用户或助手也可能直接返回 JSON；这些内容都应使用同一
    // 个可滚动代码视图，不能由 kind 决定是否按 JSON 展示。
    var codeHtml = renderJsonCode(codeValue === undefined ? text : codeValue);
    var detailHtml = codeHtml || optionValue(options, 'detailHtml', text
      ? (kind === 'error' ? '<p class="conversation-error-text">' + esc(text) + '</p>' : renderMarkdown(text))
      : '');
    var attachmentHtml = renderAttachments(eventAttachments(event, options), optionValue(options, 'topicId', event.topicId || ''));
    var application = options.applicationLinks === false ? null : applicationResult(event.result || event.detail || event.text);
    if (options.applicationLinks !== false && !application && event.text) application = applicationResult(event.text);
    if (attachmentHtml) detailHtml += '<div class="conversation-image-attachments">' + attachmentHtml + '</div>';
    var collapsible = optionValue(options, 'collapsible', (kind === 'tool' || kind === 'tool-result'
      || kind === 'llm-request' || kind === 'llm-response') && !!(summary || detailHtml) && !attachmentHtml);
    var attrs = ' data-conversation-event-index="' + esc(index) + '"'
      + (key ? ' data-conversation-event-key="' + esc(key) + '"' : '');
    var actions = '<span class="conversation-event-actions">'
      + (status ? '<span class="conversation-event-status conversation-event-status-' + statusTone(statusValue) + '">' + esc(status) + '</span>' : '')
      + (options.retry === true ? '<button class="conversation-event-copy conversation-event-retry" data-conversation-action="retry-event" data-event-id="' + esc(target) + '" title="重试">↻</button>' : '')
      + (options.copy === true ? '<button type="button" class="conversation-event-copy" data-conversation-action="copy-event" data-event-id="' + esc(target) + '" title="复制" aria-label="复制"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg></button>' : '')
      + (application ? '<button type="button" class="conversation-event-copy" data-app-open="' + esc(application.appId) + '" title="打开应用：' + esc(application.name) + '" aria-label="打开应用：' + esc(application.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"></path></svg></button>' : '')
      + (options.download === true ? '<button type="button" class="conversation-event-copy" data-conversation-action="download-event-md" data-event-id="' + esc(target) + '" title="下载 Markdown" aria-label="下载 Markdown"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14"></path></svg></button>' : '')
      + '<time>' + esc(timeText) + '</time></span>';
    var titleHtml = esc(title);
    if (elapsedRunning) {
      titleHtml += '（<span class="conversation-event-elapsed" data-conversation-elapsed-started-at="'
        + esc(elapsedStartedAt) + '">' + esc(formatElapsedDuration(Date.now() - elapsedStartedAt)) + '</span>）';
      ensureElapsedTimer();
    } else if (hasElapsedDuration) {
      titleHtml += '（<span class="conversation-event-elapsed">' + esc(formatElapsedDuration(elapsedDurationMs)) + '</span>）';
    }
    var header = '<span class="conversation-event-title">' + titleHtml + '</span>' + actions;
    if (collapsible) {
      return '<details class="conversation-event conversation-event-' + esc(kind) + '"' + attrs + '>'
        + '<summary>' + header + '</summary>'
        + (summary ? '<p class="conversation-event-summary">' + esc(summary) + '</p>' : '')
        + detailHtml + '</details>';
    }
    return '<article class="conversation-event conversation-event-' + esc(kind) + '"' + attrs + '>'
      + '<header>' + header + '</header>' + detailHtml + '</article>';
  }

  function applicationResult(value, depth) {
    depth = depth || 0;
    if (!value || depth > 4) return null;
    if (typeof value === 'string') { if (!value.includes('"appId"')) return null; try { value = JSON.parse(value); } catch (_) { return null; } }
    if (typeof value !== 'object') return null;
    if (/^app_[A-Za-z0-9_-]+$/.test(value.appId || '') && value.name && value.permissions && value.links) return value;
    for (var key of ['result', 'primary', 'data', 'content']) { var found = applicationResult(value[key], depth + 1); if (found) return found; }
    return null;
  }
  function applicationClick(event) {
    var target = event.target && event.target.closest && event.target.closest('[data-app-open]');
    if (!target) return;
    var appId = target.dataset.appOpen;
    if (!/^app_[A-Za-z0-9_-]+$/.test(appId)) return;
    event.preventDefault();
    event.stopPropagation();
    root.chrome.runtime.sendMessage({ type: 'APP_OPEN', appId: appId }).then(function (result) {
      if (result && result.error) throw new Error(result.error.message);
    }).catch(function (error) { target.title = error.message; });
  }
  function attachApplications(container) {
    if (!root.chrome || !root.chrome.runtime) return function () {};
    container.addEventListener('click', applicationClick);
    return function () { container.removeEventListener('click', applicationClick); };
  }

  function keyedEventNode(container, key) {
    if (!container || !key) return null;
    var nodes = container.querySelectorAll('[data-conversation-event-key]');
    for (var index = 0; index < nodes.length; index++) {
      if (nodes[index].getAttribute('data-conversation-event-key') === key) return nodes[index];
    }
    return null;
  }

  function replaceKeyedEvent(container, key, html) {
    var node = keyedEventNode(container, key);
    if (!node) return false;
    var wasOpen = node.tagName && node.tagName.toLowerCase() === 'details' && node.open;
    if (!html) {
      node.remove();
      return true;
    }
    node.outerHTML = html;
    if (wasOpen) {
      var next = keyedEventNode(container, key);
      if (next && next.tagName && next.tagName.toLowerCase() === 'details') next.open = true;
    }
    return true;
  }

  var STYLE_TEXT = [
    '.conversation-event-stream{position:relative;flex:1 1 auto;height:auto;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;padding:14px 14px 12px;border:0;background:var(--bg);}',
    '.conversation-history-loading{position:absolute;z-index:3;top:6px;left:50%;display:inline-flex;min-height:24px;box-sizing:border-box;align-items:center;justify-content:center;transform:translateX(-50%);padding:3px 9px;border:1px solid var(--border-strong);border-radius:var(--control-radius);background:var(--bg-secondary);box-shadow:0 2px 8px rgba(20,40,43,.12);color:var(--text-secondary);font-size:11px;line-height:1.2;pointer-events:none;white-space:nowrap;}.conversation-history-loading[hidden]{display:none;}',
    '.conversation-event{margin:0 0 8px;padding:9px 10px;border:1px solid var(--border);border-left:3px solid var(--border-strong);border-radius:var(--control-radius);background:var(--bg);}',
    '.conversation-event header,.conversation-event summary{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;padding:0;color:var(--accent);font-size:12px;font-weight:500;}',
    '.conversation-event-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.conversation-event-actions{display:inline-flex;flex-shrink:0;align-items:center;gap:6px;}',
    '.conversation-event-status{display:inline-flex;align-items:center;gap:5px;min-height:20px;padding:0 6px;border:0;border-radius:3px;background:var(--bg-muted);color:var(--text-secondary);font-size:11px;font-weight:600;line-height:1;}.conversation-event-status::before{width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:currentColor;content:"";}.conversation-event-status-success{background:rgba(61,166,122,.12);color:var(--success);}.conversation-event-status-active{background:rgba(68,163,207,.12);color:var(--transmitting);}.conversation-event-status-error{background:rgba(186,85,74,.1);color:var(--danger);}',
    '.conversation-event-copy{box-sizing:border-box;display:grid;place-items:center;width:24px;min-width:24px;max-width:24px;height:24px;min-height:24px;max-height:24px;flex:0 0 24px;padding:0;border:1px solid var(--control-border);border-radius:var(--control-radius);background:var(--control-bg);color:var(--accent);line-height:1;cursor:pointer;appearance:none;}',
    '.conversation-event-copy svg{display:block;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}',
    '.conversation-event-copy:hover{background:var(--control-bg-hover);border-color:var(--accent);color:var(--accent);}.conversation-event-retry{font-size:15px;}',
    '.conversation-event>summary{min-height:24px;margin-bottom:0;list-style:none;cursor:pointer;}.conversation-event>summary::-webkit-details-marker{display:none;}.conversation-event[open]>summary{margin-bottom:6px;}',
    '.conversation-event>summary::before{content:"";box-sizing:border-box;flex:0 0 8px;width:8px;height:8px;border:solid currentColor;border-width:0 2px 2px 0;color:var(--text-secondary);transform:translateX(-2px) rotate(-45deg);}.conversation-event[open]>summary::before{transform:translateY(-2px) rotate(45deg);}',
    '.conversation-event>summary>.conversation-event-title{flex:1;}.conversation-event>summary:hover{background:var(--accent-soft);}.conversation-event>summary:hover::before{color:var(--accent);}.conversation-event>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}',
    '.conversation-event time{flex-shrink:0;color:var(--text-secondary);font-size:11px;font-weight:400;}',
    '.conversation-event p{margin:0;color:var(--text);font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}',
    '.conversation-markdown{color:var(--text);font-size:13px;line-height:1.58;word-break:break-word;}',
    '.conversation-markdown h1,.conversation-markdown h2,.conversation-markdown h3,.conversation-markdown h4,.conversation-markdown h5,.conversation-markdown h6{margin:10px 0 6px;color:var(--accent);font-family:Roboto,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-weight:500;line-height:1.35;}',
    '.conversation-markdown h1{font-size:18px}.conversation-markdown h2{font-size:16px}.conversation-markdown h3,.conversation-markdown h4,.conversation-markdown h5,.conversation-markdown h6{font-size:14px}',
    '.conversation-markdown p{margin:0 0 8px;white-space:normal;}.conversation-markdown p:last-child,.conversation-markdown ul:last-child,.conversation-markdown ol:last-child,.conversation-markdown blockquote:last-child,.conversation-markdown page-code-editor:last-child,.conversation-markdown table:last-child,.conversation-markdown-table:last-child{margin-bottom:0;}',
    '.conversation-markdown ul,.conversation-markdown ol{margin:0 0 8px 20px;padding:0;}.conversation-markdown li{margin:3px 0;}',
    '.conversation-markdown input[type="checkbox"]{display:inline-block;box-sizing:border-box;width:14px;height:14px;min-height:0;margin:0 6px 0 0;padding:0;vertical-align:-2px;accent-color:var(--accent);pointer-events:none;}',
    '.conversation-markdown blockquote{margin:0 0 8px;padding:6px 10px;border-left:3px solid var(--border-strong);background:var(--bg-secondary);color:var(--text-secondary);}',
    '.conversation-markdown code{padding:1px 4px;border:1px solid var(--border);background:var(--bg-muted);color:var(--value);font-family:"SF Mono","JetBrains Mono",Consolas,monospace;font-size:12px;}',
    '.conversation-markdown page-code-editor{display:block;min-width:0;width:100%;--code-height:260px;margin:0 0 8px;}',
    '.conversation-markdown table{width:100%;margin:0 0 8px;border-collapse:collapse;font-size:12px;}.conversation-markdown th,.conversation-markdown td{padding:5px 7px;border:1px solid var(--border);text-align:left;vertical-align:top;}.conversation-markdown th{background:var(--table-header);color:#fff;font-weight:500;}',
    '.conversation-markdown-table{max-width:100%;overflow-x:auto;margin:0 0 8px;}.conversation-markdown th[align="center"],.conversation-markdown td[align="center"]{text-align:center;}.conversation-markdown th[align="right"],.conversation-markdown td[align="right"]{text-align:right;}',
    '.conversation-markdown img{max-width:100%;height:auto;vertical-align:middle;}',
    '.conversation-markdown a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;}.conversation-markdown hr{height:1px;margin:10px 0;border:0;background:var(--border);}',
    '.conversation-event-summary{margin-top:6px!important;color:var(--text-secondary)!important;font-size:12px!important;}',
    '.conversation-event page-code-editor{display:block;min-width:0;width:100%;--code-height:220px;max-height:40vh;margin:6px 0;}',
    '.conversation-image-attachments{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,360px));gap:8px;margin-top:8px;}.conversation-image-attachment{max-width:360px;margin:0;border:1px solid var(--border);background:var(--bg-muted);}.conversation-image-preview{display:grid;width:100%;min-height:96px;max-height:280px;padding:0;place-items:center;overflow:hidden;border:0;background:var(--bg-secondary);cursor:zoom-in;}.conversation-image-preview img{display:block;width:100%;height:auto;max-height:280px;object-fit:contain;}.conversation-image-placeholder{padding:16px;color:var(--text-secondary);font-size:12px;}.conversation-image-attachment figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;color:var(--text-secondary);font-size:11px;}.conversation-image-attachment figcaption button{padding:3px 7px;border:1px solid var(--control-border);background:var(--control-bg);color:var(--accent);cursor:pointer;}.conversation-image-attachment.is-missing .conversation-image-placeholder{color:var(--danger);}',
    '.conversation-image-lightbox{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;padding:32px;background:rgba(0,0,0,.82);}.conversation-image-lightbox img{max-width:calc(100vw - 64px);max-height:calc(100vh - 64px);object-fit:contain;box-shadow:0 8px 36px rgba(0,0,0,.5);}.conversation-image-lightbox button{position:absolute;top:14px;right:18px;width:38px;height:38px;border:1px solid rgba(255,255,255,.65);border-radius:50%;background:rgba(0,0,0,.45);color:#fff;font-size:28px;line-height:1;cursor:pointer;}',
    '.conversation-event-user{border-left-color:var(--accent)}.conversation-event-assistant{border-left-color:var(--success)}.conversation-event-tool,.conversation-event-tool-result,.conversation-event-run{border-left-color:var(--transmitting)}.conversation-event-llm-request,.conversation-event-llm-response{border-left-color:var(--value)}.conversation-event-warn,.conversation-event-reasoning{border-left-color:var(--warn)}.conversation-event-error{border-left-color:var(--danger)}.conversation-error-text{color:var(--danger)!important;}',
    '.conversation-steering-queue{flex:0 0 auto;margin:0;padding:8px 10px;border-top:1px solid var(--border);background:var(--bg-secondary);color:var(--text);}.conversation-steering-queue header{display:flex;align-items:center;gap:8px;margin-bottom:6px;}.conversation-steering-queue header b{color:var(--accent);font-size:12px;font-weight:600;}.conversation-steering-queue header span{margin-left:auto;color:var(--text-secondary);font-size:11px;}.conversation-steering-interrupt{min-height:26px;padding:3px 8px;border:1px solid var(--danger);border-radius:5px;background:transparent;color:var(--danger);cursor:pointer;font-size:11px;font-weight:600;}.conversation-steering-interrupt:hover,.conversation-steering-interrupt:focus-visible{background:color-mix(in srgb,var(--danger) 10%,transparent);outline:none;}.conversation-steering-interrupt:disabled{cursor:default;opacity:.45;}.conversation-steering-queue ol{display:grid;gap:5px;margin:0;padding:0;list-style:none;}.conversation-steering-queue li{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:6px 8px;border:1px solid var(--border);background:var(--bg);font-size:12px;}.conversation-steering-queue li span{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;}.conversation-steering-queue li small{flex:0 0 auto;color:var(--warn);font-size:10px;white-space:nowrap;}',
  ].join('');

  function installStyles(rootNode) {
    if (!rootNode || typeof rootNode.querySelector !== 'function' || typeof rootNode.createElement !== 'function') return null;
    var existing = rootNode.querySelector('style[' + STYLE_ATTRIBUTE + ']');
    if (existing) return existing;
    var style = rootNode.createElement('style');
    style.setAttribute(STYLE_ATTRIBUTE, '');
    style.textContent = STYLE_TEXT;
    (rootNode.head || rootNode.documentElement || rootNode).appendChild(style);
    return style;
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    STYLE_TEXT: STYLE_TEXT,
    escapeHtml: esc,
    renderMarkdown: renderMarkdown,
    statusLabel: statusLabel,
    eventText: eventText,
    eventKey: eventKey,
    eventAttachments: eventAttachments,
    renderAttachments: renderAttachments,
    formatTime: formatTime,
    formatElapsedDuration: formatElapsedDuration,
    updateElapsedLabels: updateElapsedLabels,
    renderEvent: renderEvent,
    attachApplications: attachApplications,
    keyedEventNode: keyedEventNode,
    replaceKeyedEvent: replaceKeyedEvent,
    installStyles: installStyles,
  });
});
