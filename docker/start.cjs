'use strict';

// One server and one browser; the virtual display exposes only the browser.
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const { startSelkies } = require('./selkies.cjs');

const uid = 1000, gid = 1000;
const state = '/data', profile = '/data/browser', browserHome = '/data/browser-home', runtime = '/run/page-agent';
const extension = path.join(runtime, 'extension');
const modelApiKeyPrefix = 'PAGE_AGENT_MODEL_API_KEY_';
const children = new Set();
let stopping = false;

async function own(directory) {
  await fs.mkdir(directory, { recursive: true });
  await fs.chown(directory, uid, gid);
}
async function ownState(directory) {
  await fs.chown(directory, uid, gid);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await ownState(file);
    else if (entry.isFile()) await fs.chown(file, uid, gid);
  }
}
async function versionExtension() {
  const manifestFile = path.join(extension, 'manifest.json');
  const source = await fs.readFile(manifestFile);
  const manifest = JSON.parse(source.toString('utf8'));
  const releaseVersion = manifest.version_name || manifest.version;
  const hash = createHash('sha256').update(source).update(await fs.readFile(__filename));
  async function hashScripts(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await hashScripts(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        hash.update(path.relative(extension, file)).update('\0');
        hash.update(await fs.readFile(file)).update('\0');
      }
    }
  }
  await hashScripts(extension);
  // Give each build a distinct worker URL so registration cannot reuse the old
  // worker and its importScripts cache. Keep it at the root for relative imports.
  const digest = hash.digest();
  const version = [0, 2, 4, 6].map(offset => digest.readUInt16BE(offset));
  version[0] = version[0] || 1;
  delete manifest.version_name;
  manifest.version = version.join('.');
  const background = await fs.readFile(path.join(extension, manifest.background.service_worker), 'utf8');
  manifest.background.service_worker = 'background-' + manifest.version + '.js';
  await fs.writeFile(path.join(extension, manifest.background.service_worker),
    "self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));\n" + background);
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log('扩展版本：' + releaseVersion + '，容器代码版本：' + manifest.version
    + '，后台入口：' + manifest.background.service_worker);
  return JSON.parse(source.toString('utf8')).version;
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {} }
  const timer = setTimeout(() => {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }
  }, 12000);
  timer.unref();
}
function start(command, args, extraEnv = {}) {
  if (stopping) throw new Error('Container is stopping');
  const env = { ...process.env, HOME: browserHome, XDG_RUNTIME_DIR: runtime, DISPLAY: ':99' };
  delete env.PAGE_AGENT_PAIRING_PASSWORD;
  for (const name of Object.keys(env)) {
    if (name.startsWith(modelApiKeyPrefix)) delete env[name];
  }
  Object.assign(env, extraEnv);
  const child = spawn(command, args, { uid, gid, env, stdio: 'inherit', detached: true });
  children.add(child);
  child.on('error', error => { children.delete(child); console.error(command + ': ' + error.message); stop(1); });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) { console.error(command + ' exited: ' + (signal || code)); stop(code || 1); }
  });
  return child;
}
async function main() {
  const browserCache = path.join(state, 'browser-cache', 'selkies');
  await own(state); await own(profile); await own(browserHome); await own(runtime);
  await own(browserCache);
  await own(path.join(state, 'tls'));
  await fs.chmod(path.join(state, 'tls'), 0o700);
  await fs.chmod(runtime, 0o700);
  await ownState(state);
  // Dockerfile holds /data/browser.lock for this supervisor's lifetime.
  // Chromium's singleton links retain the old hostname after container recreation.
  for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await fs.unlink(path.join(profile, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  for (const file of ['/tmp/.X99-lock', '/tmp/.X11-unix/X99']) {
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  let password = String(process.env.PAGE_AGENT_PAIRING_PASSWORD || '').trim();
  delete process.env.PAGE_AGENT_PAIRING_PASSWORD;
  let existingAuth = false;
  try { await fs.access(path.join(state, 'auth.json')); existingAuth = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!existingAuth && !password) throw new Error('Set PAGE_AGENT_PAIRING_PASSWORD to initialize a new instance');
  if (password && password.length < 12) throw new Error('Pairing password must contain at least 12 characters');
  // Keep a stable unpacked-extension path across image and container upgrades.
  await fs.rm(extension, { recursive: true, force: true });
  await fs.cp('/opt/page-agent/extension', extension, { recursive: true });
  const applicationVersion = await versionExtension();
  const source = process.env.PAGE_AGENT_BUILTIN_CONNECTIONS_FILE || path.join(extension, 'builtin-connections/index.json');
  const builtin = JSON.parse(await fs.readFile(source, 'utf8'));
  if (builtin.version !== 1 || !Array.isArray(builtin.connections)) throw new Error('Invalid builtin-connections file');
  if (builtin.connections.some(item => item.id === 'container-local')) throw new Error('container-local is reserved for this container');
  const autoSyncSetting = String(process.env.PAGE_AGENT_AUTO_SYNC_ENABLED || 'true').trim().toLowerCase();
  if (!['true', 'false'].includes(autoSyncSetting)) throw new Error('PAGE_AGENT_AUTO_SYNC_ENABLED must be true or false');
  const autoSyncEnabled = autoSyncSetting === 'true';
  const syncVersion = String(process.env.PAGE_AGENT_AUTO_SYNC_VERSION || '').trim();
  if (syncVersion && !/^v\d{6,}$/.test(syncVersion)) throw new Error('PAGE_AGENT_AUTO_SYNC_VERSION must be a backup version such as v000001');
  const bucket = String(process.env.PAGE_AGENT_AUTO_SYNC_BUCKET || '').trim();
  if (bucket && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(bucket)
      || ['__proto__', 'constructor', 'prototype'].includes(bucket))) {
    throw new Error('PAGE_AGENT_AUTO_SYNC_BUCKET must be a bucket name of 1-80 ASCII letters, digits, underscores or hyphens, starting with a letter or digit; constructor and prototype are reserved');
  }
  const modelApiKeys = Object.create(null);
  for (const [name, key] of Object.entries(process.env)) {
    if (!name.startsWith(modelApiKeyPrefix)) continue;
    const id = name.slice(modelApiKeyPrefix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
      throw new Error('PAGE_AGENT_MODEL_API_KEY_ must be followed by a valid model configuration ID');
    }
    if (!key.trim()) throw new Error(name + ' must contain a non-empty API key');
    modelApiKeys[id] = key;
  }
  const clientName = String(process.env.PAGE_AGENT_CLIENT_NAME || '').trim() || builtin.clientName;
  const serverName = String(process.env.PAGE_AGENT_SERVER_NAME || '').trim() || os.hostname();
  if (clientName !== undefined && (typeof clientName !== 'string' || clientName.length > 300)) throw new Error('Client name must be a string of at most 300 characters');
  const local = {
    id: 'container-local', alias: String(process.env.PAGE_AGENT_LOCAL_CONNECTION_ALIAS || '').trim() || '容器内 MCP',
    url: 'ws://127.0.0.1:9999', ...(password ? { password } : {}),
    arpPermissions: { read: true, write: true, delete: true, execute: false },
    bucket: 'default',
    autoSync: !builtin.connections.some(item => item.autoSync === true),
    backup: true,
  };
  const syncSource = builtin.connections.find(item => item.autoSync === true) || local;
  const syncTarget = syncVersion ? {
    connectionId: 'builtin:' + syncSource.id,
    bucketId: bucket || syncSource.bucket || 'default',
  } : null;
  const target = path.join(extension, 'builtin-connections/index.json');
  await fs.writeFile(target, JSON.stringify({ version: 1, runtime: 'docker/start.cjs', applicationVersion,
    autoSyncEnabled, syncVersion, ...(syncTarget ? { syncTarget } : {}), modelApiKeys, clientName, connections: [local, ...builtin.connections] }), { mode: 0o600 });
  await fs.chmod(target, 0o600); await fs.chown(target, uid, gid);
  if (syncTarget) console.log('启动同步目标：' + JSON.stringify({ ...syncTarget, versionId: syncVersion, enabled: autoSyncEnabled }));
  console.log('启动名称：' + JSON.stringify({ clientName: clientName === undefined ? '(沿用插件名称)' : clientName,
    connectionAlias: local.alias, serverName }));
  start('node', ['/opt/page-agent/page-agent-mcp-server.cjs', '--host', '0.0.0.0', '--state-dir', state, '--server-name', serverName],
    existingAuth ? {} : { PAGE_AGENT_PAIRING_PASSWORD: password });
  password = '';
  const browser = require('/opt/browser/node_modules/playwright').chromium.executablePath();
  const dimensions = await startSelkies({ start, stopping: () => stopping, state });
  if (stopping) return;
  // Chromium 156's infobar_utils.cc skips the Chrome for Testing banner for test-type=gpu.
  start(browser, ['--window-position=0,0', '--window-size=' + dimensions.join(','),
    '--no-sandbox', '--test-type=gpu', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--user-data-dir=' + profile, '--disk-cache-dir=' + path.join(browserCache, 'chromium'),
    '--disable-extensions-except=' + extension, '--load-extension=' + extension, 'about:blank'],
    { XDG_CACHE_HOME: browserCache });
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
main().catch(error => {
  if (stopping) return;
  console.error(error.message); stop(1);
});
