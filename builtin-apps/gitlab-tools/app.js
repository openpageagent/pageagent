import { GitLabClient, normalizeSite } from './client.js';
import { layout } from './views.js';

export async function mountGitLabTools() {
  document.getElementById('app-root').innerHTML = layout;
  const $ = id => document.getElementById(id);
  const tickets = { projects: 0, branches: 0, commit: 0, lookup: 0 };
  const timers = new Map();
  let client = null, projects = [], branches = [], targets = new Set(), resolvedCommit = null;
  let connecting = false, busy = false, settingsVersion = null;
  let resultLines = [];
  let branchTimestamp = createBranchTimestamp();

  function message(id, text, error = false) {
    $(id).textContent = text;
    $(id).title = text;
    $(id).classList.toggle('error', error);
    if (id === 'connection-status') updateConnectionSummary();
  }
  function openSettings() {
    $('project-filters').open = false;
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
    if (!$('site').value && !$('connection-fields').disabled) $('site').focus();
  }
  function updateConnectionSummary() {
    const summary = $('connection-summary'), error = $('connection-status').classList.contains('error');
    summary.dataset.state = connecting ? 'connecting' : error ? 'error' : client ? 'connected' : 'disconnected';
    summary.textContent = connecting ? $('connection-status').textContent || '正在连接…' : client
      ? `${new URL(client.site).host} · @${client.user.username}${error ? ' · 设置有提示' : ''}`
      : error ? '连接未就绪 · 打开设置' : '未连接 · 打开设置';
    summary.title = [client?.site, $('connection-status').textContent].filter(Boolean).join('\n');
  }
  function updateProjectFilterState() {
    const active = !!($('project-search').value.trim() || $('project-filter').value.trim());
    $('project-filters').dataset.active = String(active);
    $('project-filters').querySelector('summary').textContent = active ? '筛选中' : '筛选项目';
  }
  function invalidateReads() { Object.keys(tickets).forEach(key => tickets[key]++); }
  function readContext(kind, needsProject = true) {
    const revision = ++tickets[kind], connection = client, project = $('project').value;
    return { connection, project, current: () => client === connection && tickets[kind] === revision && !busy && (!needsProject || $('project').value === project) };
  }
  function permitted() { return !!PageAgent.state?.permissions.enabled; }
  function controls() {
    $('connection-fields').disabled = connecting || busy || !permitted();
    $('operation-fields').disabled = !client || connecting || busy || !permitted();
    $('run').disabled = !client || busy || !$('project').value || !$('commit').value.trim() || !targets.size;
    $('copy-results').disabled = busy || !resultLines.length;
    $('connect').textContent = connecting ? '连接中…' : '保存并连接';
    $('run').textContent = busy ? '正在执行…' : `${$('operation').value === 'merge' ? '创建合并请求' : '执行 Cherry-pick'}${targets.size ? ` (${targets.size})` : ''}`;
    updateConnectionSummary();
  }
  async function copyResults() {
    if (busy || !resultLines.length) return;
    const copiedLines = resultLines;
    try {
      await navigator.clipboard.writeText(copiedLines.join('\n'));
      if (copiedLines === resultLines) message('copy-status', `已复制 ${copiedLines.length} 条结果`);
    } catch (_) {
      if (copiedLines === resultLines) message('copy-status', '复制失败，请选中结果手动复制。', true);
    }
  }
  function debounceRead(id, kind, action) {
    $(id).addEventListener('input', () => {
      tickets[kind]++;
      clearTimeout(timers.get(kind));
      timers.set(kind, setTimeout(() => { if (client && !busy) void action(); }, 350));
    });
  }
  function matchFilter(text, regex) {
    const value = text.trim();
    if (!value) return () => true;
    if (regex) {
      let expression;
      try { expression = new RegExp(value, 'i'); } catch (_) { throw new Error('正则表达式无效，请修改过滤条件。'); }
      return name => expression.test(name);
    }
    return name => name.toLowerCase().includes(value.toLowerCase());
  }
  function createBranchTimestamp() {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(value => String(value).padStart(2, '0')).join('-');
  }
  function sourceBranch(commit, target) { return `cherry-pick-${commit.slice(0, 8)}-${target.replace('release-', '')}-${branchTimestamp}`; }
  function updatePreview() {
    const merge = $('operation').value === 'merge', commit = resolvedCommit?.id || $('commit').value.trim();
    $('lookup-panel').hidden = merge;
    $('remove-source-setting').hidden = !merge;
    $('operation-help').textContent = merge
      ? `创建临时分支 → Cherry-pick → 创建 MR。${$('remove-source').checked ? '合并后删除临时分支。' : '合并后保留临时分支。'}`
      : '直接修改待处理分支，不创建合并请求。';
    const preview = document.createDocumentFragment();
    for (const target of targets) {
      const item = document.createElement('li');
      item.textContent = merge ? `${sourceBranch(commit || '<commit>', target)} → ${target}` : `Cherry-pick ${commit || '<commit>'} → ${target}`;
      preview.append(item);
    }
    $('preview').replaceChildren(preview);
    $('preview-empty').hidden = targets.size > 0;
    controls();
  }
  function checkedNames(id) { return Array.from($(id).querySelectorAll('input:checked'), input => input.value); }
  function renderList(id, names, emptyText) {
    const checked = new Set(checkedNames(id)), fragment = document.createDocumentFragment();
    for (const name of names) {
      const label = document.createElement('label'); label.className = 'branch-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = name;
      checkbox.checked = checked.has(name);
      checkbox.disabled = id === 'available-branches' && targets.has(name);
      if (checkbox.disabled) checkbox.checked = false;
      const text = document.createElement('span'); text.className = 'branch-name'; text.textContent = name; text.title = name;
      label.append(checkbox, text); fragment.append(label);
    }
    if (!names.length) {
      const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = emptyText; fragment.append(empty);
    }
    $(id).replaceChildren(fragment);
  }
  function renderBranches() {
    let visible = [];
    try {
      visible = branches.filter(matchFilter($('branch-filter').value, $('branch-regex').checked));
      message('branch-status', $('project').value ? `已加载 ${branches.length} 个分支，当前显示 ${visible.length} 个。` : '请先选择项目。');
    } catch (error) { message('branch-status', error.message, true); }
    renderList('available-branches', visible, '没有可显示的分支');
    renderList('target-branches', [...targets], '勾选左侧分支后点击添加');
    $('available-count').textContent = `(${visible.length})`;
    $('target-count').textContent = `(${targets.size})`;
    updatePreview();
  }
  function clearProject() {
    tickets.branches++; tickets.commit++; tickets.lookup++;
    ['branches', 'commit'].forEach(kind => clearTimeout(timers.get(kind)));
    branches = []; targets.clear(); resolvedCommit = null;
    ['branch-search', 'branch-filter', 'commit', 'merge-title'].forEach(id => { $(id).value = ''; });
    $('branch-regex').checked = true;
    ['commit-status', 'lookup-status'].forEach(id => message(id, ''));
    const project = projects.find(item => String(item.id) === $('project').value);
    $('project-name').textContent = project?.path_with_namespace || '';
    $('project').title = project?.path_with_namespace || '';
    renderBranches();
  }
  function changeProject() {
    clearProject();
    if ($('project').value && client) void loadBranches();
  }
  function renderProjects() {
    const previous = $('project').value;
    let visible = [];
    try {
      const matches = matchFilter($('project-filter').value, $('project-regex').checked);
      visible = projects.filter(project => matches(project.name_with_namespace || project.name));
      message('project-status', `已加载 ${projects.length} 个项目，当前显示 ${visible.length} 个。`);
    } catch (error) { message('project-status', error.message, true); }
    const options = document.createDocumentFragment();
    options.append(new Option('请选择项目', ''));
    visible.forEach(project => options.append(new Option(project.name_with_namespace || project.name, String(project.id))));
    $('project').replaceChildren(options);
    $('project').value = visible.some(project => String(project.id) === previous) ? previous : '';
    if ($('project').value !== previous) changeProject();
    controls();
  }
  async function loadProjects() {
    if (!client || busy) return;
    const context = readContext('projects', false);
    message('project-status', '正在加载项目…');
    try {
      const result = await context.connection.list('/projects', { search: $('project-search').value.trim(), order_by: 'last_activity_at', sort: 'desc' }, context.current);
      if (!context.current() || !result) return;
      projects = result; renderProjects();
    } catch (error) { if (context.current()) message('project-status', error.message, true); }
  }
  async function loadBranches() {
    if (!client || busy || !$('project').value) return;
    const context = readContext('branches');
    message('branch-status', '正在加载分支…');
    try {
      const result = await context.connection.list(`/projects/${encodeURIComponent(context.project)}/repository/branches`, { search: $('branch-search').value.trim() }, context.current);
      if (!context.current() || !result) return;
      branches = [...new Set(result.map(branch => branch.name))]; renderBranches();
    } catch (error) { if (context.current()) message('branch-status', error.message, true); }
  }
  async function loadCommit() {
    if (!client || busy || !$('project').value || !$('commit').value.trim()) return;
    const context = readContext('commit'), commit = $('commit').value.trim();
    message('commit-status', '正在读取 Commit…');
    try {
      const result = await context.connection.get(`/projects/${encodeURIComponent(context.project)}/repository/commits/${encodeURIComponent(commit)}`);
      if (context.current()) {
        resolvedCommit = result;
        message('commit-status', `${result.title}\n${result.id}`);
        updatePreview();
      }
    } catch (error) { if (context.current()) message('commit-status', error.message, true); }
  }
  async function findBranches() {
    if (!client || busy || !$('project').value || !$('merge-title').value.trim()) {
      message('lookup-status', '请先选择项目并输入合并请求标题。', true); return;
    }
    const context = readContext('lookup');
    message('lookup-status', '正在查找未关闭的合并请求…');
    try {
      const title = $('merge-title').value.trim();
      const result = await context.connection.list(`/projects/${encodeURIComponent(context.project)}/merge_requests`, { search: title, in: 'title', state: 'opened' }, context.current);
      if (!context.current() || !result) return;
      targets = new Set(result.filter(mr => mr.title.toLowerCase().includes(title.toLowerCase())).map(mr => mr.source_branch).filter(Boolean));
      renderBranches();
      message('lookup-status', `已替换待处理列表，共 ${targets.size} 个源分支。`);
    } catch (error) { if (context.current()) message('lookup-status', error.message, true); }
  }
  function resetConnection() {
    client = null; invalidateReads();
    for (const timer of timers.values()) clearTimeout(timer);
    projects = []; $('project').replaceChildren(new Option('请选择项目', ''));
    clearProject();
    message('project-status', '');
    message('connection-status', '请连接站点。');
    $('token-settings').hidden = $('auth-mode').value !== 'token';
    $('session-help').hidden = $('auth-mode').value === 'token';
    controls();
  }
  async function connect() {
    if (busy || connecting || !permitted()) return;
    const previousUserId = client?.user.id;
    if (!client) resetConnection();
    invalidateReads();
    for (const timer of timers.values()) clearTimeout(timer);
    connecting = true; controls();
    message('connection-status', '正在连接 GitLab…');
    try {
      const connection = new GitLabClient($('site').value, $('auth-mode').value, $('token').value);
      const user = await connection.connect(text => message('connection-status', text));
      if (previousUserId && previousUserId !== user.id) resetConnection();
      client = connection; $('site').value = connection.site;
      const connectedMessage = `已连接：${user.name || user.username} (@${user.username}) · ${connection.mode === 'session' ? '浏览器登录态' : '访问令牌'}`;
      message('connection-status', 'GitLab 已连接，正在保存设置…');
      try {
        const record = await PageAgent.data.set('connection', {
          site: connection.site, mode: connection.mode,
          removeSource: $('remove-source').checked,
          token: connection.mode === 'token' && $('remember-token').checked ? connection.token : ''
        }, settingsVersion);
        settingsVersion = record.version;
        message('connection-status', connectedMessage);
        $('settings-dialog').close();
      } catch (error) { message('connection-status', `${connectedMessage}\n连接成功，但配置保存失败：${error.message}`, true); }
      void loadProjects();
    } catch (error) { resetConnection(); message('connection-status', error.message, true); openSettings(); }
    finally { connecting = false; controls(); }
  }
  async function run() {
    if (busy || !client || !permitted() || !$('project').value || !targets.size || !$('commit').value.trim()) return;
    const connection = client, project = $('project').value, commitInput = $('commit').value.trim();
    const selectedTargets = [...targets], merge = $('operation').value === 'merge', removeSource = $('remove-source').checked;
    const projectPath = `/projects/${encodeURIComponent(project)}`;
    busy = true; invalidateReads();
    for (const timer of timers.values()) clearTimeout(timer);
    ['project-status', 'branch-status', 'lookup-status'].forEach(id => message(id, ''));
    resultLines = []; message('copy-status', '');
    controls(); $('results').replaceChildren();
    message('run-status', '正在核对账号与 Commit…');
    let succeeded = 0, failed = 0;
    try {
      const user = await connection.get('/user');
      if (user.id !== connection.user.id) throw new Error('GitLab 登录账号已变化，请重新连接后操作。');
      const commit = await connection.get(`${projectPath}/repository/commits/${encodeURIComponent(commitInput)}`);
      if (!commit?.id) throw new Error('未取得有效的 Commit 信息，已停止操作。');
      const commitTitle = commit.title || `Cherry-Pick ${commit.id.slice(0, 8)}`;
      if (merge) branchTimestamp = createBranchTimestamp();
      resolvedCommit = commit; updatePreview();
      message('commit-status', `${commitTitle}\n${commit.id}`);
      for (const [index, target] of selectedTargets.entries()) {
        if (!permitted()) throw new Error('应用权限已关闭，已停止后续操作。');
        const source = sourceBranch(commit.id, target), item = document.createElement('p');
        $('results').append(item);
        item.textContent = `${target}：处理中…`;
        message('run-status', `正在处理 ${index + 1}/${selectedTargets.length}：${target}`);
        let stage = merge ? '创建临时分支' : 'Cherry-pick', created = false, picked = false;
        try {
          if (merge) {
            await connection.post(`${projectPath}/repository/branches`, { branch: source, ref: target });
            created = true;
          }
          stage = 'Cherry-pick';
          await connection.post(`${projectPath}/repository/commits/${encodeURIComponent(commit.id)}/cherry_pick`, { branch: merge ? source : target });
          picked = true;
          let mr;
          if (merge) {
            stage = '创建合并请求';
            mr = await connection.post(`${projectPath}/merge_requests`, { source_branch: source, target_branch: target, remove_source_branch: removeSource, title: commitTitle });
          }
          item.textContent = merge ? `${target}：合并请求已创建` : `${target}：已迁移 ${commit.id.slice(0, 8)}`;
          item.className = 'success';
          if (merge) {
            const projectInfo = projects.find(value => String(value.id) === project);
            const configuredUrl = mr?.iid && projectInfo?.path_with_namespace
              ? `${connection.site}/${projectInfo.path_with_namespace.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/${encodeURIComponent(mr.iid)}` : '';
            let url;
            for (const candidate of [configuredUrl, mr?.web_url]) {
              if (typeof candidate !== 'string' || !candidate.trim()) continue;
              try {
                const parsed = new URL(candidate, connection.site + '/');
                if (['https:', 'http:'].includes(parsed.protocol)) { url = parsed; break; }
              } catch (_) { /* Try the next available URL. */ }
            }
            if (url) {
              item.textContent = `${target}：`;
              const link = document.createElement('a'); link.href = url.href; link.textContent = url.href;
              link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link);
            } else {
              const note = document.createElement('span');
              note.textContent = '\nGitLab 未返回可用的 MR 地址或编号，请到项目的合并请求列表查看。';
              item.append(note);
            }
          }
          succeeded++;
        } catch (error) {
          failed++; item.className = 'error';
          item.textContent = `${target}：${stage}失败。${error.message}${created ? `\n已创建分支 ${source}${picked ? '，已完成 Cherry-pick' : ''}；请在 GitLab 检查并继续处理。` : ''}`;
        } finally {
          resultLines.push(item.textContent);
        }
      }
      message('run-status', `处理完成：成功 ${succeeded}，失败 ${failed}，共 ${selectedTargets.length} 个分支。`, failed > 0);
    } catch (error) { message('run-status', `已停止：${error.message}\n成功 ${succeeded}，失败 ${failed}，未处理 ${selectedTargets.length - succeeded - failed}。`, true); }
    finally { busy = false; controls(); }
  }

  $('settings-open').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  document.querySelector('.gitlab-app').addEventListener('click', event => {
    if (!$('project-filters').contains(event.target)) $('project-filters').open = false;
  });
  $('project-filters').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      $('project-filters').open = false;
      $('project-filters').querySelector('summary').focus();
      event.preventDefault();
    }
  });
  ['project-search', 'project-filter'].forEach(id => $(id).addEventListener('input', updateProjectFilterState));
  $('remove-source').addEventListener('change', updatePreview);
  $('site').addEventListener('input', () => {
    $('token').value = ''; $('remember-token').checked = false;
    resetConnection();
  });
  $('token').addEventListener('input', resetConnection);
  $('auth-mode').addEventListener('change', resetConnection);
  $('connect').addEventListener('click', connect);
  $('open-site').addEventListener('click', async () => {
    try { await chrome.tabs.create({ url: normalizeSite($('site').value) + '/' }); }
    catch (error) { message('connection-status', error.message, true); }
  });
  $('operation').addEventListener('change', () => { tickets.lookup++; updatePreview(); });
  $('project').addEventListener('change', () => { $('project-filters').open = false; changeProject(); });
  debounceRead('project-search', 'projects', loadProjects);
  debounceRead('branch-search', 'branches', loadBranches);
  debounceRead('commit', 'commit', loadCommit);
  $('commit').addEventListener('input', () => { resolvedCommit = null; message('commit-status', ''); updatePreview(); });
  $('project-filter').addEventListener('input', renderProjects);
  $('project-regex').addEventListener('change', renderProjects);
  $('branch-filter').addEventListener('input', renderBranches);
  $('branch-regex').addEventListener('change', renderBranches);
  $('refresh-projects').addEventListener('click', loadProjects);
  $('refresh-branches').addEventListener('click', loadBranches);
  $('merge-title').addEventListener('input', () => { tickets.lookup++; message('lookup-status', ''); });
  $('find-branches').addEventListener('click', findBranches);
  [['select-available', 'available-branches'], ['select-targets', 'target-branches']].forEach(([button, list]) => {
    $(button).addEventListener('click', () => $(list).querySelectorAll('input:not(:disabled)').forEach(input => { input.checked = true; }));
  });
  $('add-branches').addEventListener('click', () => {
    tickets.lookup++; checkedNames('available-branches').forEach(name => targets.add(name)); renderBranches();
  });
  $('remove-branches').addEventListener('click', () => {
    tickets.lookup++; checkedNames('target-branches').forEach(name => targets.delete(name)); renderBranches();
  });
  $('run').addEventListener('click', run);
  $('copy-results').addEventListener('click', copyResults);
  PageAgent.onChange(event => { if (event.change === 'state') controls(); });
  window.addEventListener('pagehide', () => {
    invalidateReads(); for (const timer of timers.values()) clearTimeout(timer);
  }, { once: true });

  await PageAgent.ready;
  let saved, settingsError;
  try {
    const record = await PageAgent.data.get('connection');
    settingsVersion = record.version; saved = record.value;
    if (saved?.site) {
      $('site').value = saved.site;
      $('auth-mode').value = saved.mode === 'token' ? 'token' : 'session';
      $('token').value = saved.token || '';
      $('remember-token').checked = !!saved.token;
      $('remove-source').checked = saved.removeSource !== false;
    }
  } catch (error) { settingsError = error; }
  resetConnection();
  if (!permitted()) message('connection-status', '请在应用权限中开启 SDK；保存配置需要 data.read 和 data.write 权限。', true);
  else if (settingsError) message('connection-status', `无法读取配置：${settingsError.message}。仍可手动连接。`, true);
  else if (saved?.site && (saved.mode !== 'token' || saved.token)) await connect();
  if (!client) openSettings();
}
