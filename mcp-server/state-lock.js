'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireLock(file, timeoutMs = 2000) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = performance.now() + timeoutMs;
  const owner = { pid: process.pid, nonce: randomUUID() };
  for (;;) {
    let handle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
      await handle.close();
      return async () => {
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        if (current.nonce !== owner.nonce) throw new Error('STATE_LOCK_OWNERSHIP_CHANGED');
        await fs.unlink(file);
      };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw error; }
      if (error.code !== 'EEXIST') throw error;
      try {
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!alive(current.pid)) {
          // Serialize stale-owner removal. An inode check alone has an unlink race.
          // A crashed recovery guard fails closed and needs operator inspection.
          const recoveryFile = file + '.recovery';
          const recovery = await fs.open(recoveryFile, 'wx', 0o600);
          let removed = false;
          try {
            await recovery.writeFile(JSON.stringify(owner)); await recovery.sync();
            const again = JSON.parse(await fs.readFile(file, 'utf8'));
            if (again.nonce === current.nonce && !alive(again.pid)) { await fs.unlink(file); removed = true; }
          } finally { await recovery.close(); await fs.unlink(recoveryFile); }
          if (removed) continue;
        }
      } catch (readError) { if (readError.code === 'ENOENT') continue; }
      if (performance.now() >= deadline) throw Object.assign(new Error('STATE_LOCK_TIMEOUT'), { code: 'STATE_LOCK_TIMEOUT' });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function atomicJson(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); throw error;
  }
}

module.exports = { acquireLock, atomicJson };
