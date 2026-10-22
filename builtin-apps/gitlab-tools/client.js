export function normalizeSite(value) {
  let url;
  try { url = new URL(value.trim()); } catch (_) { throw new Error('请输入完整的 GitLab 站点地址，例如 https://gitlab.example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('站点地址仅支持 HTTP / HTTPS，可包含部署子路径，不可包含账号、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

function isSitePage(value, site) {
  try {
    const url = new URL(value), base = new URL(site);
    return url.origin === base.origin && (url.pathname === base.pathname || url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'));
  } catch (_) { return false; }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

// Serialized by chrome.scripting: keep this function self-contained.
async function sessionRequest(site, path, method, body) {
  const base = new URL(site);
  if (location.origin !== base.origin || !(location.pathname === base.pathname || location.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))) {
    return { error: 'GitLab 标签页已离开所选站点，请重新连接。' };
  }
  const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (method !== 'GET') {
    if (!csrf) return { error: '当前 GitLab 页面没有 CSRF 信息，请在该标签页登录并刷新后重新连接。' };
    headers['Content-Type'] = 'application/json';
  }
  try {
    const response = await fetch(site + path, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body),
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000)
    });
    return { status: response.status, text: await response.text(), nextPage: response.headers.get('x-next-page') };
  } catch (_) {
    return { error: method === 'GET' ? 'GitLab 请求未完成，请检查登录状态、网络和标签页。' : '请求未完成，服务端可能已执行。请先在 GitLab 核实结果，勿直接重复提交。' };
  }
}

async function waitForTab(tabId) {
  await new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    };
    const updated = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
    const removed = id => { if (id === tabId) finish(new Error('GitLab 标签页已关闭，请重新连接。')); };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    timer = setTimeout(() => finish(new Error('GitLab 页面加载超时（15 秒），请打开该标签页完成登录后重新连接。')), 15000);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(); }, finish);
  });
}

export class GitLabClient {
  constructor(site, mode, token) {
    this.site = normalizeSite(site);
    this.mode = mode;
    this.token = mode === 'token' ? token.trim() : '';
    this.tabId = null;
    if (mode === 'token' && !this.token) throw new Error('请填写访问令牌。');
  }

  async connect(onProgress = () => {}) {
    if (!globalThis.PageAgent?.state?.permissions?.enabled) throw new Error('应用权限已关闭，请在应用权限中开启 SDK。');
    if (this.mode === 'session') {
      onProgress('正在查找 GitLab 登录页面…');
      const tabs = (await chrome.tabs.query({})).filter(tab =>
        !tab.discarded && !tab.frozen && tab.incognito === chrome.extension.inIncognitoContext && isSitePage(tab.url, this.site));
      const readyTabs = tabs.filter(tab => tab.status === 'complete');
      const tab = readyTabs.find(tab => tab.active) || readyTabs[0] || tabs.find(tab => tab.active) || tabs[0];
      if (tab) {
        this.tabId = tab.id;
      } else {
        onProgress('正在打开 GitLab 登录页面…');
        this.tabId = (await chrome.tabs.create({ url: this.site + '/', active: false })).id;
        await waitForTab(this.tabId);
      }
    }
    onProgress(this.mode === 'session' ? '正在读取 GitLab 登录账号…' : '正在验证 GitLab 访问令牌…');
    // Bound the read from the app: a stalled page can delay script injection before fetch starts.
    this.user = await withTimeout(this.get('/user'), 15000, this.mode === 'session'
      ? '读取 GitLab 登录账号超时（15 秒），请切换到 GitLab 标签页，确认页面可正常访问后重新连接。'
      : '验证 GitLab 访问令牌超时（15 秒），请检查站点地址和网络后重新连接。');
    if (!this.user?.id || !this.user.username) throw new Error('未取得 GitLab 用户信息，请检查站点地址和登录状态。');
    return this.user;
  }

  async request(path, { method = 'GET', body } = {}) {
    if (!globalThis.PageAgent?.state?.permissions?.enabled) throw new Error('应用权限已关闭，已停止请求。');
    if (!path.startsWith('/') || path.startsWith('//') || !['GET', 'POST'].includes(method)) throw new Error('无效的 GitLab 请求。');
    const apiPath = '/api/v4' + path;
    let result;
    if (this.mode === 'session') {
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (!isSitePage(tab.url, this.site) || tab.incognito !== chrome.extension.inIncognitoContext) throw new Error('站点已变化');
        const frames = await chrome.scripting.executeScript({
          target: { tabId: this.tabId }, world: 'ISOLATED', injectImmediately: true,
          func: sessionRequest, args: [this.site, apiPath, method, body ?? null]
        });
        result = frames[0]?.result;
        if (!result) throw new Error('页面没有返回结果');
      } catch (_) {
        throw new Error(method === 'GET' ? '无法访问 GitLab 标签页，请完成登录后重新连接。' : 'GitLab 标签页请求中断，结果未确认。请到站点核实后重新连接，勿直接重复提交。');
      }
    } else {
      try {
        const response = await fetch(this.site + apiPath, {
          method, headers: { Accept: 'application/json', 'PRIVATE-TOKEN': this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000)
        });
        result = { status: response.status, text: await response.text(), nextPage: response.headers.get('x-next-page') };
      } catch (_) {
        throw new Error(method === 'GET' ? '连接失败，请检查站点地址、证书和网络。' : '请求未完成，服务端可能已执行。请先在 GitLab 核实结果，勿直接重复提交。');
      }
    }
    if (result.error) throw new Error(result.error);
    let data;
    try { data = JSON.parse(result.text); } catch (_) { throw new Error(`GitLab 返回非 JSON 内容（HTTP ${result.status}），请检查站点地址、登录状态或代理配置。`); }
    if (result.status < 200 || result.status >= 300) {
      const detail = typeof data?.message === 'string' ? data.message : JSON.stringify(data?.message || data?.error || data);
      const hint = result.status === 401 ? '请重新登录，或检查令牌是否有效。' : result.status === 403 ? '请检查项目权限、令牌 api 范围；登录模式可刷新 GitLab 页面后重新连接。' : '';
      throw new Error(`HTTP ${result.status}：${detail.slice(0, 1200)} ${hint}`.trim());
    }
    return { data, nextPage: result.nextPage };
  }

  async get(path) { return (await this.request(path)).data; }

  async post(path, body) { return (await this.request(path, { method: 'POST', body })).data; }

  async list(path, query = {}, isCurrent = () => true) {
    const items = [];
    let page = 1;
    while (isCurrent()) {
      const params = new URLSearchParams({ ...query, per_page: '100', page: String(page) });
      const result = await this.request(path + '?' + params);
      if (!isCurrent()) return null;
      if (!Array.isArray(result.data)) throw new Error('GitLab 列表响应格式不正确。');
      items.push(...result.data);
      if (result.nextPage === '' || result.nextPage === null && result.data.length < 100) return items;
      const next = result.nextPage === null ? page + 1 : Number(result.nextPage);
      if (!Number.isInteger(next) || next <= page) throw new Error('GitLab 返回了无效的分页信息。');
      page = next;
    }
    return null;
  }
}
