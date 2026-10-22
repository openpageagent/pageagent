'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
globalThis.AgentResourceProtocol = require('../resources/protocol/index.js');
require('../shared/app-contract.js');
require('../apps/app-package.js');

const directory = path.resolve(__dirname, '../builtin-apps');
const indexFile = path.join(directory, 'index.json');
fs.mkdirSync(directory, { recursive: true });
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json') && file !== 'index.json').sort();
const apps = [], ids = new Set(), slugs = new Set(), resources = new Map();
for (const file of files) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(file) || file.includes('..')) throw new Error(`${file}: 内置应用文件名只能使用英文字母、数字、下划线、横线和点，不能含 ..`);
  if (fs.statSync(path.join(directory, file)).size > 50 * 1024 * 1024) throw new Error(`${file}: 超过 50 MiB`);
  const raw = fs.readFileSync(path.join(directory, file), 'utf8');
  let bundle;
  try { bundle = globalThis.AppPackage.validateBuiltin(JSON.parse(raw)); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
  for (const app of bundle.apps) {
    if (ids.has(app.appId)) throw new Error(`${file}: 应用 ID 重复: ${app.appId}`);
    ids.add(app.appId);
    const slug = globalThis.AppContract.slug(app.slug);
    if (slug && slugs.has(slug)) throw new Error(`${file}: 应用别名重复: ${slug}`);
    if (slug) slugs.add(slug);
  }
  for (const [section, items] of Object.entries(bundle.resources)) {
    for (const [id, value] of Object.entries(items)) {
      const key = `${section}/${id}`, content = globalThis.AgentResourceProtocol.stableStringify(value);
      if (resources.has(key) && resources.get(key) !== content) throw new Error(`${file}: 内置依赖内容冲突: ${key}`);
      resources.set(key, content);
    }
  }
  apps.push({ file, ids: bundle.apps.map((app) => app.appId), hash: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex') });
}
const next = JSON.stringify({ version: 1, apps }, null, 2) + '\n';
if (!fs.existsSync(indexFile) || fs.readFileSync(indexFile, 'utf8') !== next) fs.writeFileSync(indexFile, next);
console.log(`已同步 builtin-apps/index.json（${apps.length} 个包，${ids.size} 个应用）`);
