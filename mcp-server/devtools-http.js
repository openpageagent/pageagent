'use strict';

const http = require('node:http');
const https = require('node:https');
const arp = require('../resources/protocol');
const encode = value => {
  if (value === '.' || value === '..') throw arp.arpError('INVALID_REQUEST', '资源标识不能为点路径');
  return encodeURIComponent(String(value));
};

function request(config, route, options, execution) {
  const url = new URL(config.baseUrl.replace(/\/+$/, '') + route);
  for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const headers = { Accept: options.text ? 'text/plain' : 'application/json', ...options.headers };
  let body;
  if (options.form) { body = new URLSearchParams(options.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  else if (options.body !== undefined) { body = JSON.stringify(options.body); headers['Content-Type'] = 'application/json'; }
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  execution.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET', headers, signal: execution.signal,
      ...(config.ca ? { ca: config.ca } : {}), rejectUnauthorized: true,
    }, res => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        res.destroy();
        const performed = execution.write && status >= 500 ? 'unknown' : 'no';
        reject(arp.arpError('UPSTREAM_FAILED', '服务返回 HTTP ' + status + '，请核对地址、认证、权限与请求参数', { performed, retryable: false, details: { status } }));
        return;
      }
      if (execution.write) execution.confirm();
      if (options.headersOnly) { resolve({ status, headers: res.headers }); res.destroy(); return; }
      const limit = options.text ? 65536 : 1048576, chunks = [];
      let bytes = 0, completed = false;
      const finish = truncated => {
        if (completed) return; completed = true;
        const buffer = Buffer.concat(chunks), content = buffer.toString('utf8');
        if (!options.text && truncated) {
          reject(arp.arpError('RESOURCE_BUSY', '服务响应超过 1 MiB，请缩小查询范围或分页读取', { performed: execution.performed }));
          return;
        }
        try { resolve({ data: options.text ? content : content ? JSON.parse(content) : null,
          status, headers: res.headers, bytes: buffer.length, truncated }); }
        catch (_) { reject(arp.arpError('UPSTREAM_FAILED', '服务未返回有效 JSON，请检查 API 地址和反向代理', { performed: execution.performed })); }
      };
      res.on('data', chunk => {
        const available = limit - bytes;
        if (available > 0) { const part = chunk.subarray(0, available); chunks.push(part); bytes += part.length; }
        if (chunk.length > available) { finish(true); res.destroy(); }
      });
      res.once('end', () => finish(false)); res.once('error', reject);
    });
    req.once('error', reject);
    if (execution.write) execution.attempt();
    req.end(body);
  });
}

function authorization(config, basic = false) {
  return { Authorization: basic || config.auth === 'basic'
    ? 'Basic ' + Buffer.from(config.username + ':' + config.token).toString('base64') : 'Bearer ' + config.token };
}
function authenticated(valid) {
  if (!valid) throw arp.arpError('UPSTREAM_FAILED', '服务未确认登录身份，请核对地址、凭据和 API 访问权限', { performed: 'no', retryable: false });
  return { connected: true };
}
function adf(text) {
  return { type: 'doc', version: 1, content: String(text).split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) };
}
function jobPath(value) {
  if (!value) return '';
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw arp.arpError('INVALID_REQUEST', '任务路径必须由非空文件夹或任务名组成');
  return parts.map(part => '/job/' + encode(part)).join('');
}

async function jira(operation, input, config, execution) {
  const cloud = config.deployment === 'cloud', api = '/rest/api/' + (cloud ? '3' : '2');
  const send = (route, options = {}) => request(config, api + route, { ...options, headers: authorization(config) }, execution).then(result => result.data);
  const issue = '/issue/' + encode(input.issueKey);
  switch (operation) {
    case 'test': {
      const user = await send('/myself');
      return authenticated(user?.accountId || user?.name);
    }
    case 'search':
      if (cloud && input.startAt !== undefined || !cloud && input.nextPageToken !== undefined) throw arp.arpError('INVALID_REQUEST', 'Cloud 使用 nextPageToken；Data Center 使用 startAt');
      return send(cloud ? '/search/jql' : '/search', { method: 'POST', body: {
        jql: input.jql, maxResults: input.maxResults || 20,
        fields: ['summary', 'description', 'status', 'assignee', 'updated', 'issuetype', 'project'],
        ...(cloud ? input.nextPageToken ? { nextPageToken: input.nextPageToken } : {} : { startAt: input.startAt || 0 }),
      } });
    case 'issue': return send(issue, { query: { fields: 'summary,description,status,assignee,reporter,updated,issuetype,project,labels' } });
    case 'create-issue': return send('/issue', { method: 'POST', body: { fields: {
      project: { key: input.projectKey }, issuetype: { id: input.issueTypeId }, summary: input.summary,
      ...(input.description ? { description: cloud ? adf(input.description) : input.description } : {}),
    } } });
    case 'comment': return send(issue + '/comment', { method: 'POST', body: { body: cloud ? adf(input.text) : input.text } });
    case 'transitions': return send(issue + '/transitions');
    case 'transition': await send(issue + '/transitions', { method: 'POST', body: { transition: { id: input.transitionId } } }); return { updated: true };
  }
}

async function confluence(operation, input, config, execution) {
  const cloud = config.deployment === 'cloud';
  const send = (route, options = {}) => request(config, route, { ...options, headers: authorization(config) }, execution).then(result => result.data);
  const storage = { representation: 'storage', value: input.content };
  switch (operation) {
    case 'test': {
      const user = await send('/rest/api/user/current');
      return authenticated(user?.type === 'known' && (user.accountId || user.username || user.userKey));
    }
    case 'search': {
      if (cloud && input.start !== undefined || !cloud && input.cursor !== undefined) throw arp.arpError('INVALID_REQUEST', 'Cloud 使用 cursor；Data Center 使用 start');
      const result = await send('/rest/api/search', { query: { cql: input.cql, limit: input.limit || 20,
        ...(cloud ? { cursor: input.cursor } : { start: input.start || 0 }) } });
      const next = result._links?.next;
      const params = next ? new URL(next, config.baseUrl).searchParams : null;
      return { ...result, ...(cloud ? { nextCursor: params?.get('cursor') || null }
        : { nextStart: params?.has('start') ? Number(params.get('start')) : null }) };
    }
    case 'page': return send(cloud ? '/api/v2/pages/' + encode(input.pageId) : '/rest/api/content/' + encode(input.pageId),
      { query: cloud ? { 'body-format': 'storage' } : { expand: 'body.storage,version,space' } });
    case 'create-page':
      if (cloud && !input.spaceId || !cloud && !input.spaceKey) throw arp.arpError('INVALID_REQUEST', 'Cloud 需要 spaceId，Data Center 需要 spaceKey');
      return send(cloud ? '/api/v2/pages' : '/rest/api/content', { method: 'POST', body: cloud
        ? { spaceId: input.spaceId, status: 'current', title: input.title, body: storage, ...(input.parentId ? { parentId: input.parentId } : {}) }
        : { type: 'page', title: input.title, space: { key: input.spaceKey }, body: { storage }, ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}) } });
    case 'update-page': return send(cloud ? '/api/v2/pages/' + encode(input.pageId) : '/rest/api/content/' + encode(input.pageId),
      { method: 'PUT', body: cloud
        ? { id: input.pageId, status: 'current', title: input.title, body: storage, version: { number: input.version } }
        : { type: 'page', title: input.title, body: { storage }, version: { number: input.version } } });
  }
}

async function jenkins(operation, input, config, execution) {
  const send = (route, options = {}) => request(config, route, { ...options, headers: authorization(config, true) }, execution);
  const job = jobPath(input.job), build = job + '/' + (input.buildNumber || 'lastBuild');
  switch (operation) {
    case 'test': return authenticated((await send('/whoAmI/api/json')).data?.authenticated === true);
    case 'jobs': return (await send(jobPath(input.folder) + '/api/json', { query: { tree: 'jobs[name,url,color,_class]' } })).data;
    case 'build': return (await send(build + '/api/json', { query: { tree: 'number,url,building,result,timestamp,duration,estimatedDuration,queueId' } })).data;
    case 'log': {
      const start = input.start || 0, result = await send(build + '/logText/progressiveText', { query: { start }, text: true });
      const reported = Number(result.headers['x-text-size']);
      return { text: result.data, nextStart: result.truncated ? start + result.bytes : Number.isSafeInteger(reported) && reported >= start ? reported : start + result.bytes,
        hasMore: result.truncated || result.headers['x-more-data'] === 'true', truncated: result.truncated };
    }
    case 'trigger': {
      // Jenkins API-token authentication is exempt from CSRF crumbs. Do not
      // retry a rejected POST with alternative credentials or a fresh crumb.
      const hasParams = input.parameters && Object.keys(input.parameters).length;
      if (hasParams && Object.keys(input.parameters).some(key => !key.length || key.length > 100)) throw arp.arpError('INVALID_REQUEST', '构建参数名长度应为 1–100 个字符');
      const result = await send(job + (hasParams ? '/buildWithParameters' : '/build'), { method: 'POST', headersOnly: true, ...(hasParams ? { form: input.parameters } : {}) });
      const match = /\/queue\/item\/(\d+)\/?(?:\?.*)?$/.exec(String(result.headers.location || ''));
      return { accepted: true, queueId: match ? Number(match[1]) : null };
    }
    case 'queue': return (await send('/queue/item/' + input.queueId + '/api/json', { query: { tree: 'id,cancelled,blocked,buildable,stuck,why,executable[number,url]' } })).data;
  }
}

async function gitlab(operation, input, config, execution) {
  const send = (route, options = {}) => request(config, '/api/v4' + route, { ...options, headers: { 'PRIVATE-TOKEN': config.token } }, execution);
  const project = '/projects/' + encode(input.project), pagination = { page: input.page || 1, per_page: input.perPage || 20 };
  async function list(route, query) {
    const result = await send(route, { query });
    return { items: result.data, nextPage: result.headers['x-next-page'] ? Number(result.headers['x-next-page']) : null };
  }
  switch (operation) {
    case 'test': {
      const user = (await send('/user')).data;
      return authenticated(Number.isInteger(user?.id) && user.id > 0 && user.username);
    }
    case 'projects': return list('/projects', { ...pagination, membership: true, search: input.search, simple: true });
    case 'merge-requests': return list(project + '/merge_requests', { ...pagination, state: input.state || 'opened' });
    case 'merge-request': return (await send(project + '/merge_requests/' + input.iid)).data;
    case 'create-merge-request': return (await send(project + '/merge_requests', { method: 'POST', body: {
      source_branch: input.sourceBranch, target_branch: input.targetBranch, title: input.title, description: input.description || '',
    } })).data;
    case 'pipelines': return list(project + '/pipelines', { ...pagination, ref: input.ref });
    case 'pipeline': return (await send(project + '/pipelines/' + input.pipelineId)).data;
    case 'run-pipeline': return (await send(project + '/pipeline', { method: 'POST', body: {
      ref: input.ref, variables: (input.variables || []).map(item => ({ ...item, variable_type: 'env_var' })),
    } })).data;
    case 'pipeline-jobs': return list(project + '/pipelines/' + input.pipelineId + '/jobs', pagination);
    case 'job-log': { const result = await send(project + '/jobs/' + input.jobId + '/trace', { text: true }); return { text: result.data, truncated: result.truncated }; }
  }
}

module.exports = { jira, confluence, jenkins, gitlab };
