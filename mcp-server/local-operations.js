'use strict';

const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { OPERATIONS } = require('../resources/modules/local-resource.js');
const { executeDesktop } = require('./desktop-operations.js');
const { LIMITS } = require('../shared/mcp-contract');
const { terminateChild, observeChild } = require('./execution-control');

const MAX_FILE_BYTES = LIMITS.readBytes;
const MAX_OUTPUT_BYTES = LIMITS.outputBytes;

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

function bash(input, signal, cwd, executable) {
  return new Promise((resolve, reject) => {
    checkCancelled(signal);
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, ['-c', input.command], { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    observeChild(signal, child);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let truncated = false;
    let spawnError = null;
    const capture = chunks => chunk => {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
      }
    };
    const kill = () => { terminateChild(child, signal).catch(() => {}); };
    const cleanup = () => { signal.removeEventListener('abort', kill); };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', error => { spawnError = error; });
    child.once('close', (exitCode, exitSignal) => {
      cleanup();
      if (spawnError) { reject(spawnError); return; }
      resolve({ cwd, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode, signal: exitSignal, timedOut: signal.aborted && signal.reason === 'timeout',
        cancelled: signal.aborted && exitSignal !== null, truncated });
    });
  });
}

async function execute(name, input, signal, workingDirectory, executable) {
  checkCancelled(signal);
  if (OPERATIONS[name].desktop && name !== 'locate') return executeDesktop(name, input, signal, workingDirectory);
  if (!path.isAbsolute(workingDirectory)) throw new Error('工作目录必须是绝对路径');
  const directory = await fs.realpath(workingDirectory);
  if (directory !== workingDirectory) throw Object.assign(new Error('执行目录已变化，请重新确认目标'), { code: 'DEPENDENCY_CHANGED', reason: 'WORKSPACE_CHANGED' });
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('工作目录不存在或不是目录');
  checkCancelled(signal);
  if (OPERATIONS[name].desktop) return executeDesktop(name, input, signal, directory);
  if (name === 'bash') return bash(input, signal, directory, executable);
  const file = localPath(input.path, directory);
  if (name === 'write') {
    if (Buffer.byteLength(input.content, 'utf8') > LIMITS.writeBytes) throw new Error('写入内容超过 1MB');
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
  async function visit(target) {
    checkCancelled(signal);
    if (truncated) return;
    if (++visited > LIMITS.grepEntries) { truncated = true; return; }
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
      if (index % 128 === 0) { await new Promise(resolve => setImmediate(resolve)); checkCancelled(signal); }
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

module.exports = { execute, localPath, checkedPath };
