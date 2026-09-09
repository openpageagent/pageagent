'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = 'shared/page-engine-version.js';
const FINGERPRINT_FORMAT = 'page-agent-unified-page-engine-fingerprint-v1';
const HASH_MARKERS = {
  engineHash: /var engineHash = '[^'\r\n]*';/g,
  providerHash: /var providerHash = '[^'\r\n]*';/g,
};

function loadPageEngineVersion(root) {
  const modulePath = path.join(root, VERSION_FILE);
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function computeFingerprint(root, files, readFile) {
  const hash = crypto.createHash('sha256');
  const read = readFile || ((absolutePath) => fs.readFileSync(absolutePath));
  hash.update(FINGERPRINT_FORMAT + '\0');
  files.forEach((relativePath) => {
    const rawContent = read(path.join(root, relativePath), relativePath);
    const content = Buffer.from(Buffer.from(rawContent).toString('utf8').replace(/\r\n?/g, '\n'));
    hash.update(relativePath + '\0' + content.length + '\0');
    hash.update(content);
    hash.update('\0');
  });
  return hash.digest('hex');
}

function validateHashMarkers(source) {
  Object.keys(HASH_MARKERS).forEach((name) => {
    const matches = source.match(HASH_MARKERS[name]) || [];
    if (matches.length !== 1) {
      throw new Error(name + ' marker must appear exactly once in ' + VERSION_FILE + '; found ' + matches.length);
    }
  });
}

function replaceVersionFileAtomically(versionPath, source, mode) {
  const temporaryPath = versionPath + '.tmp-' + process.pid + '-' + Date.now()
    + '-' + Math.random().toString(16).slice(2);
  try {
    fs.writeFileSync(temporaryPath, source, { encoding: 'utf8', flag: 'wx', mode });
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, versionPath);
  } catch (err) {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw err;
  }
}

function computeEngineHashes(root, readFile) {
  root = root || DEFAULT_ROOT;
  const pageEngineVersion = loadPageEngineVersion(root);
  return {
    engine: 'page-engine:sha256:' + computeFingerprint(
      root,
      pageEngineVersion.getFingerprintFiles('engine'),
      readFile,
    ),
    provider: 'page-provider:sha256:' + computeFingerprint(
      root,
      pageEngineVersion.getFingerprintFiles('provider'),
      readFile,
    ),
  };
}

function updatePageEngineVersion(root) {
  root = root || DEFAULT_ROOT;
  const versionPath = path.join(root, VERSION_FILE);
  const source = fs.readFileSync(versionPath, 'utf8');
  validateHashMarkers(source);
  const hashes = computeEngineHashes(root);
  const next = source
    .replace(/var engineHash = '[^']*';/, "var engineHash = '" + hashes.engine + "';")
    .replace(/var providerHash = '[^']*';/, "var providerHash = '" + hashes.provider + "';");
  if (next !== source) {
    const mode = fs.statSync(versionPath).mode & 0o777;
    replaceVersionFileAtomically(versionPath, next, mode);
  }
  return hashes;
}

if (require.main === module) {
  const hashes = updatePageEngineVersion(DEFAULT_ROOT);
  process.stdout.write(hashes.engine + '\n' + hashes.provider + '\n');
}

module.exports = {
  computeEngineHashes,
  computeFingerprint,
  updatePageEngineVersion,
};
