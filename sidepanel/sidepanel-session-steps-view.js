// Flow steps and background-run status DOM renderer.
(function attachSidepanelSessionStepsView(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.SidepanelSessionStepsView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var API_VERSION = 1;
  function create(options) {
    options = options || {};
    var container = options.container;
    var title = options.title || null;
    var escapeHtml = options.escapeHtml;
    var statusClasses = options.statusClasses || {};
    var statusIcons = options.statusIcons || {};
    var destroyed = false;
    if (!container || typeof escapeHtml !== 'function') throw new Error('SidepanelSessionStepsView missing dependency');
    function live() { return !destroyed; }
    function setTitle(backgroundMode) { if (live() && title) title.textContent = backgroundMode ? '运行状态' : '步骤进度'; }
    function renderLoading(model) {
      if (!live()) return;
      model = model || {};
      setTitle(model.conversationMode === true);
      container.innerHTML = '<div class="steps-switch-loading" role="status" aria-live="polite">'
        + '<span class="steps-switch-spinner"></span><b>' + escapeHtml(model.text || '') + '</b>'
        + (model.label ? '<span>' + escapeHtml(model.label) + '</span>' : '') + '</div>';
    }
    function renderFlow(model) {
      if (!live()) return;
      model = model || {};
      var nodes = Array.isArray(model.nodes) ? model.nodes : [];
      if (!nodes.length) { container.innerHTML = '<p class="placeholder">该会话没有节点信息</p>'; return; }
      var html = '';
      if (model.showContinueBanner) html += '<div class="continue-banner"><span>已停止，可从停止处继续执行（保留变量与循环进度）</span>'
        + '<button class="btn-primary btn-continue" data-continue="' + escapeHtml(model.runId || '') + '">继续</button></div>';
      nodes.forEach(function (node, index) {
        var status = node.status || 'pending';
        html += '<div class="step-item ' + (statusClasses[status] || '') + '" data-node-id="' + escapeHtml(node.nodeId || '') + '">'
          + '<span class="step-icon">' + escapeHtml(statusIcons[status] || '?') + '</span>'
          + '<span class="step-order">' + escapeHtml(node.displayOrder || (index + 1)) + '.</span>'
          + '<span class="step-title">' + escapeHtml(node.title || node.nodeId || '') + '</span>'
          + (model.showNodeResume ? '<button class="step-resume" data-resume="' + escapeHtml(node.nodeId || '')
            + '" title="从此节点继续运行（之前节点跳过，保留变量）">继续</button>' : '') + '</div>';
      });
      container.innerHTML = html;
    }
    function renderBackgroundStatus(model) {
      if (!live()) return;
      model = model || {};
      setTitle(true);
      var status = model.status || 'running';
      container.innerHTML = '<div class="step-item ' + (statusClasses[status] || '') + '" role="status" aria-live="polite">'
        + '<span class="step-icon">' + escapeHtml(statusIcons[status] || '•') + '</span>'
        + '<span class="step-title">' + escapeHtml(model.text || '') + '</span></div>';
    }
    function destroy() { destroyed = true; container = null; title = null; }
    return Object.freeze({ setTitle: setTitle, renderLoading: renderLoading, renderFlow: renderFlow,
      renderBackgroundStatus: renderBackgroundStatus, destroy: destroy });
  }
  return Object.freeze({ API_VERSION: API_VERSION, create: create });
});
