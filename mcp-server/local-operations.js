'use strict';

const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const arp = require('../resources/protocol/index.js');
const { OPERATIONS } = require('../resources/modules/local-resource.js');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function localPath(value, directory) {
  if (value.includes('\0')) throw new Error('路径不能包含空字符');
  const resolved = path.resolve(directory, value);
  assertInside(directory, resolved);
  return resolved;
}

function assertInside(directory, target) {
  const relative = path.relative(directory, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('文件路径必须位于配置的工作目录内');
  }
}

async function checkedPath(directory, target, allowMissing) {
  try {
    const resolved = await fs.realpath(target);
    assertInside(directory, resolved);
    return resolved;
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    // Check each existing ancestor before mkdir/write; never follow a link outside the directory.
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('不能写入断开的符号链接');
    } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    await checkedPath(directory, parent, true);
    return target;
  }
}

function checkCancelled(signal) {
  if (signal.aborted) throw new Error('本地操作已取消；已经完成的修改不会撤销');
}

async function readText(file, signal) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('只支持读取不超过 4MB 的普通文本文件');
    checkCancelled(signal);
    // Bound the actual read too: a file can grow after stat().
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, stat.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      checkCancelled(signal);
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stat.size) throw new Error('读取时文件已增长，请重新读取');
    const content = buffer.subarray(0, size);
    if (content.includes(0)) throw new Error('不支持二进制文件');
    return content.toString('utf8');
  } finally { await handle.close(); }
}

function bash(input, signal, cwd) {
  return new Promise((resolve, reject) => {
    checkCancelled(signal);
    const grouped = process.platform !== 'win32';
    const child = spawn('bash', ['-c', input.command], { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const capture = chunks => chunk => {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
      }
    };
    const kill = () => {
      try { if (grouped) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (_) {}
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, input.timeoutMs || 30000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); };
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (exitCode, exitSignal) => {
      cleanup();
      if (signal.aborted) { reject(new Error('命令已取消；已经完成的修改不会撤销')); return; }
      resolve({ cwd, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode, signal: exitSignal, timedOut, truncated });
    });
  });
}

async function execute(name, input, signal, workingDirectory) {
  checkCancelled(signal);
  if (!path.isAbsolute(workingDirectory)) throw new Error('工作目录必须是绝对路径');
  const directory = await fs.realpath(workingDirectory);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('工作目录不存在或不是目录');
  checkCancelled(signal);
  if (name === 'bash') return bash(input, signal, directory);
  const file = localPath(input.path, directory);
  if (name === 'write') {
    if (Buffer.byteLength(input.content, 'utf8') > 1024 * 1024) throw new Error('写入内容超过 1MB');
    await checkedPath(directory, file, true);
    try {
      if (!(await fs.stat(file)).isFile()) throw new Error('只能写入普通文件');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    checkCancelled(signal);
    await fs.mkdir(path.dirname(file), { recursive: true });
    checkCancelled(signal);
    await fs.writeFile(file, input.content, { encoding: 'utf8', signal,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NONBLOCK });
    return { path: file, bytesWritten: Buffer.byteLength(input.content, 'utf8') };
  }
  if (name === 'delete') {
    await checkedPath(directory, path.dirname(file), false);
    checkCancelled(signal);
    await fs.unlink(file);
    return { path: file, deleted: true };
  }
  if (name === 'read') {
    await checkedPath(directory, file, false);
    const lines = (await readText(file, signal)).split('\n');
    const offset = input.offset || 1;
    const limit = input.limit || 200;
    const selected = [];
    let bytes = 0;
    let index = offset - 1;
    for (; index < lines.length && selected.length < limit; index++) {
      const size = Buffer.byteLength(lines[index], 'utf8') + 1;
      if (bytes + size > MAX_OUTPUT_BYTES) {
        if (!selected.length) throw new Error('单行超过 64KB，请使用 bash 读取所需片段');
        break;
      }
      selected.push(lines[index]);
      bytes += size;
    }
    return { path: file, content: selected.join('\n'), offset, totalLines: lines.length,
      nextOffset: index < lines.length ? index + 1 : null, truncated: index < lines.length };
  }
  const matches = [];
  let visited = 0;
  let skipped = 0;
  let bytes = 0;
  let truncated = false;
  const deadline = Date.now() + 60000;
  async function visit(target) {
    checkCancelled(signal);
    if (truncated) return;
    if (++visited > 5000 || Date.now() > deadline) { truncated = true; return; }
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) { skipped++; return; }
    await checkedPath(directory, target, false);
    if (stat.isDirectory()) {
      const entries = await fs.opendir(target);
      for await (const entry of entries) {
        if (truncated) break;
        if (entry.name === '.git' || entry.name === 'node_modules') { skipped++; continue; }
        await visit(path.join(target, entry.name));
      }
      return;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skipped++; return; }
    let content;
    try { content = await readText(target, signal); }
    catch (error) { checkCancelled(signal); skipped++; return; }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].includes(input.pattern)) continue;
      const match = { path: target, line: index + 1, text: lines[index] };
      const size = Buffer.byteLength(JSON.stringify(match), 'utf8');
      if (matches.length >= (input.limit || 100) || bytes + size > MAX_OUTPUT_BYTES) { truncated = true; break; }
      matches.push(match);
      bytes += size;
    }
  }
  await visit(file);
  return { path: file, matches, skipped, truncated };
}

function createLocalConnection(reply) {
  let enabled = false;
  let workingDirectory = '';
  const active = new Map();
  const seen = new Set();
  function configure(value, directory) {
    const nextDirectory = typeof directory === 'string' ? directory.trim() : '';
    enabled = value === true && nextDirectory.length <= 4096 && path.isAbsolute(nextDirectory) && !nextDirectory.includes('\0');
    if (!enabled || workingDirectory !== nextDirectory) for (const controller of active.values()) controller.abort();
    workingDirectory = nextDirectory;
  }
  function handle(message) {
    const requestId = message.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId)) return;
    const respond = body => reply(Object.assign({ type: 'local.result', requestId }, body));
    if (message.type === 'local.cancel') {
      if (active.has(requestId)) active.get(requestId).abort();
      return;
    }
    if (!enabled) { respond({ ok: false, error: '本地操作未启用或插件连接尚未完成握手' }); return; }
    if (message.workingDirectory !== workingDirectory) { respond({ ok: false, error: '工作目录已变更，请使用当前连接配置' }); return; }
    if (seen.has(requestId)) return;
    if (seen.size >= 10000 || active.size >= 4) { respond({ ok: false, error: '本地操作请求过多，请稍后重试或重新连接' }); return; }
    seen.add(requestId);
    const definition = Object.prototype.hasOwnProperty.call(OPERATIONS, message.operation) && OPERATIONS[message.operation];
    if (!definition || !arp.validateJsonSchema(definition.inputSchema, message.input).valid) {
      respond({ ok: false, error: '无效的本地操作或参数' }); return;
    }
    const controller = new AbortController();
    active.set(requestId, controller);
    const directory = workingDirectory;
    execute(message.operation, message.input, controller.signal, directory).then(result => respond({
      ok: true, result: Object.assign({ workingDirectory: directory }, result),
    }),
      error => respond({ ok: false, error: error.message || '本地操作失败' }))
      .finally(() => active.delete(requestId));
  }
  return { handle, configure, close: () => { configure(false, ''); seen.clear(); } };
}

module.exports = { createLocalConnection };
