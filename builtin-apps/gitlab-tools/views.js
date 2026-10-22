const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17"/></svg>';

export const layout = `
<main class="gitlab-app">
  <header class="workspace-header">
    <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M6 8v13M6 8a10 10 0 0 0 9 10M18 3v9m-3-3 3 3 3-3"/></svg><h1>GitLab 批量操作</h1></div>
    <div class="workspace-account"><span id="connection-summary" class="connection-summary" role="status">正在加载配置…</span><button id="settings-open" class="icon-button" type="button" title="设置" aria-label="打开设置" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.6 2.4-2.1 1.2L4 6l-2 3.5 1.7 1.7v2.5L2 15.5 4 19l2.3-.6 2.1 1.2L9 22h4l.6-2.4 2.1-1.2 2.3.6 2-3.5-1.7-1.8v-2.5L20 9l-2-3-2.3.6-2.1-1.2L13 3Z"/><circle cx="11" cy="12.5" r="3.5"/></svg></button></div>
  </header>

  <fieldset id="operation-fields" disabled aria-label="GitLab 工作台">
    <div class="command-bar">
      <div class="project-control">
        <div class="field-heading">
          <label for="project">项目</label>
          <div class="field-actions">
            <details id="project-filters" class="project-filters"><summary>筛选项目</summary><div class="filter-popover">
              <label>接口搜索<input id="project-search" type="search" placeholder="按项目名称搜索" autocomplete="off"></label>
              <label>本地过滤<input id="project-filter" type="search" placeholder="过滤已加载的项目" autocomplete="off"></label>
              <label class="check"><input id="project-regex" type="checkbox" checked>使用正则表达式</label>
            </div></details>
            <button id="refresh-projects" class="icon-button small" type="button" title="刷新项目" aria-label="刷新项目">${refreshIcon}</button>
          </div>
        </div>
        <select id="project"><option value="">请选择项目</option></select>
        <p id="project-status" class="message compact-message" role="status"></p>
        <p id="project-name" class="sr-only"></p>
      </div>
      <div class="commit-control"><label for="commit" class="field-heading">Commit</label><input id="commit" type="text" placeholder="输入 Commit SHA，自动读取标题" autocomplete="off" spellcheck="false"></div>
      <div class="operation-control"><label for="operation" class="field-heading">操作</label><select id="operation"><option value="merge">创建合并请求</option><option value="cherry-pick">Cherry-pick</option></select></div>
      <div class="run-control"><span class="field-heading" aria-hidden="true">&nbsp;</span><button id="run" class="btn-primary" type="button" disabled>生成合并请求</button></div>
      <div class="info-row">
        <p id="commit-status" class="message info-box" role="status" aria-label="Commit 信息" tabindex="0"></p>
        <section class="preview-box info-box" aria-labelledby="preview-heading" tabindex="0"><h2 id="preview-heading">执行预览</h2><p id="operation-help" class="form-help"></p><p id="preview-empty" class="empty">添加待处理分支后，在这里确认迁移方向。</p><ul id="preview" class="preview"></ul></section>
      </div>
    </div>

    <div class="work-area">
      <section class="branch-pane available-pane" aria-labelledby="available-heading">
        <div class="pane-heading"><h2 id="available-heading">可选分支 <span id="available-count" class="count"></span></h2><button id="refresh-branches" class="icon-button small" type="button" title="刷新分支" aria-label="刷新分支">${refreshIcon}</button></div>
        <div class="branch-filters"><input id="branch-search" type="search" placeholder="搜索分支（接口）" aria-label="分支接口搜索" autocomplete="off" spellcheck="false"><div class="local-filter"><input id="branch-filter" type="search" placeholder="本地过滤" aria-label="分支本地过滤" autocomplete="off" spellcheck="false"><label class="check"><input id="branch-regex" type="checkbox" checked>正则</label></div></div>
        <p id="branch-status" class="message compact-message" role="status"></p>
        <div id="available-branches" class="branch-list" aria-label="可选分支列表"></div>
        <div class="pane-footer"><button id="select-available" type="button">全选</button><button id="add-branches" type="button">添加勾选 →</button></div>
      </section>

      <section class="branch-pane target-pane" aria-labelledby="target-heading">
        <div class="pane-heading"><h2 id="target-heading">待处理分支 <span id="target-count" class="count"></span></h2><span class="pane-hint">执行列表中全部分支</span></div>
        <div id="lookup-panel" class="lookup-panel" hidden><div class="lookup-fields"><input id="merge-title" type="search" placeholder="按已有 MR 标题查找源分支" aria-label="已有合并请求标题" autocomplete="off"><button id="find-branches" type="button" title="查找未关闭的合并请求，替换待处理分支列表">查找并替换</button></div><p id="lookup-status" class="message compact-message" role="status"></p></div>
        <div id="target-branches" class="branch-list" aria-label="待处理分支列表"></div>
        <div class="pane-footer"><button id="select-targets" type="button">全选</button><button id="remove-branches" type="button">← 移除勾选</button></div>
      </section>

    </div>
  </fieldset>

  <section class="results-panel" aria-labelledby="results-heading">
    <div class="results-heading"><h2 id="results-heading">执行结果</h2><p id="run-status" class="message" role="status">尚未执行。</p><span id="copy-status" class="message" role="status"></span><button id="copy-results" type="button" disabled>复制结果</button></div>
    <div id="results" class="results info-box" aria-label="执行结果内容" tabindex="0"></div>
  </section>

  <dialog id="settings-dialog" class="settings-dialog" aria-labelledby="settings-heading">
    <div class="dialog-heading"><h2 id="settings-heading">设置</h2><button id="settings-close" class="icon-button" type="button" title="关闭设置" aria-label="关闭设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
    <fieldset id="connection-fields" disabled aria-label="连接设置">
      <label>GitLab 站点<input id="site" type="url" placeholder="https://gitlab.example.com" autocomplete="url" spellcheck="false"></label>
      <label>认证方式<select id="auth-mode"><option value="session">使用浏览器登录态</option><option value="token">使用访问令牌</option></select></label>
      <p id="session-help" class="form-help">使用已登录的 GitLab 页面；没有打开的页面时，会打开后台标签页。操作期间请保留该标签页。</p>
      <div id="token-settings" hidden><label>访问令牌<input id="token" type="password" autocomplete="off" placeholder="需要 api 范围及对应项目权限" spellcheck="false"></label><label class="check"><input id="remember-token" type="checkbox">记住令牌（保存在本机）</label></div>
      <label id="remove-source-setting" class="check merge-setting"><input id="remove-source" type="checkbox" checked>合并后删除临时源分支</label>
      <p id="connection-status" class="message" role="status">正在加载配置…</p>
      <div class="settings-actions"><button id="open-site" type="button">打开站点 / 登录</button><button id="connect" class="btn-primary" type="button">保存并连接</button></div>
    </fieldset>
  </dialog>
</main>`;
