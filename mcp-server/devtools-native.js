'use strict';

const https = require('node:https');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createClient, ErrorReply } = require('@redis/client');
const { Client: SshClient } = require('ssh2');
const { S3Client, HeadBucketCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const arp = require('../resources/protocol');

async function redis(operation, input, config, execution) {
  const client = createClient({ RESP: 2, socket: { host: config.host, port: config.port, connectTimeout: 5000,
    reconnectStrategy: false, ...(config.tls ? { tls: true, rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) } : {}) },
    database: config.database, ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}), disableOfflineQueue: true, commandsQueueMaxLength: 4 });
  client.on('error', () => {});
  const stop = () => { if (client.isOpen) client.destroy(); };
  execution.signal.addEventListener('abort', stop, { once: true });
  try {
    execution.signal.throwIfAborted(); await client.connect(); execution.signal.throwIfAborted();
    const command = async args => {
      execution.signal.throwIfAborted(); if (execution.write) execution.attempt();
      try { const result = await client.sendCommand(args); if (execution.write) execution.confirm(); return result; }
      catch (error) {
        if (error instanceof ErrorReply) {
          throw arp.arpError('UPSTREAM_FAILED', 'Redis 拒绝命令，请检查键类型、ACL 权限和参数', { performed: 'no', retryable: false });
        }
        throw error;
      }
    };
    switch (operation) {
      case 'test': {
        const reply = await command(['PING']);
        if (reply !== 'PONG') throw arp.arpError('UPSTREAM_FAILED', 'Redis 未返回 PONG，请检查服务地址', { performed: 'no', retryable: false });
        return { connected: true };
      }
      case 'scan': {
        const value = await command(['SCAN', input.cursor || '0', ...(input.pattern ? ['MATCH', input.pattern] : []), 'COUNT', String(input.count || 50)]);
        return { cursor: value[0], keys: value[1] };
      }
      case 'get': return { value: await command(['GET', input.key]) };
      case 'hash': {
        const value = await command(['HSCAN', input.key, input.cursor || '0', 'COUNT', String(input.count || 50)]);
        const entries = []; for (let i = 0; i < value[1].length; i += 2) entries.push({ field: value[1][i], value: value[1][i + 1] });
        return { cursor: value[0], entries };
      }
      case 'info': return { type: await command(['TYPE', input.key]), ttlSeconds: await command(['TTL', input.key]) };
      case 'set': return { saved: await command(['SET', input.key, input.value, ...(input.ttlSeconds ? ['EX', String(input.ttlSeconds)] : [])]) === 'OK' };
      case 'delete': return { deleted: await command(['DEL', input.key]) };
    }
  } finally { execution.signal.removeEventListener('abort', stop); stop(); }
}

function ssh(operation, input, config, execution) {
  return new Promise((resolve, reject) => {
    const client = new SshClient(); let completed = false, channel;
    const stdout = [], stderr = []; let bytes = 0, truncated = false;
    function finish(error, value) {
      if (completed) return; completed = true;
      execution.signal.removeEventListener('abort', abort);
      channel?.close(); client.destroy();
      if (error) reject(error); else resolve(value);
    }
    function abort() { finish(arp.arpError('UPSTREAM_FAILED', operation === 'test' ? 'SSH 连接测试已取消或超时'
      : 'SSH 请求已取消或超时；远程进程可能仍在执行', { performed: execution.performed, retryable: false })); }
    function collect(target, chunk) {
      const part = chunk.subarray(0, Math.max(0, 65536 - bytes));
      bytes += part.length; if (part.length) target.push(part); if (part.length < chunk.length) truncated = true;
    }
    execution.signal.addEventListener('abort', abort, { once: true });
    if (execution.signal.aborted) { abort(); return; }
    client.once('error', error => finish(error));
    client.once('close', () => { if (!completed) finish(new Error('SSH connection closed')); });
    client.once('ready', () => {
      if (completed) return;
      if (operation === 'test') { finish(null, { connected: true }); return; }
      execution.attempt();
      client.exec(input.command, (error, stream) => {
        if (error) { finish(error); return; }
        channel = stream;
        if (completed) { stream.close(); return; }
        stream.on('data', chunk => collect(stdout, chunk)); stream.stderr.on('data', chunk => collect(stderr, chunk));
        stream.once('error', error => finish(error)); stream.stderr.once('error', error => finish(error));
        stream.once('close', (code, signal) => {
          if (completed) return;
          if (!Number.isInteger(code) && !signal) { finish(new Error('SSH command completion unknown')); return; }
          execution.confirm();
          finish(null, { exitCode: Number.isInteger(code) ? code : null, signal: signal || null,
            stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
        });
      });
    });
    try {
      client.connect({ host: config.host, port: config.port, username: config.username, readyTimeout: 5000,
        keepaliveInterval: 10000, keepaliveCountMax: 2,
        ...(config.privateKey ? { privateKey: config.privateKey, ...(config.passphrase ? { passphrase: config.passphrase } : {}) }
          : { password: config.password }),
        hostVerifier: publicKey => {
          const expected = Buffer.from(config.hostFingerprint.slice('SHA256:'.length), 'base64');
          const actual = createHash('sha256').update(publicKey).digest();
          return actual.length === expected.length && timingSafeEqual(actual, expected);
        },
      });
    } catch (error) { finish(error); }
  });
}

async function s3(operation, input, config, execution) {
  const client = new S3Client({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle, maxAttempts: 1, followRegionRedirects: false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}) },
    requestHandler: { connectionTimeout: 5000, requestTimeout: 0,
      httpsAgent: new https.Agent({ rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) }) } });
  const base = { Bucket: config.bucket, Key: input.key };
  async function send(command) {
    execution.signal.throwIfAborted(); if (execution.write) execution.attempt();
    try { const result = await client.send(command, { abortSignal: execution.signal }); if (execution.write) execution.confirm(); return result; }
    catch (error) {
      const status = error.$metadata?.httpStatusCode;
      if (status) throw arp.arpError('UPSTREAM_FAILED', 'S3 返回 HTTP ' + status + (operation === 'test'
        ? '，请核对地址、Region、凭据及桶访问权限（HeadBucket）' : '，请核对桶、键、权限与覆盖条件'),
        { performed: execution.write && status >= 500 ? 'unknown' : 'no', retryable: false, details: { status } });
      throw error;
    }
  }
  try {
    switch (operation) {
      case 'test':
        await send(new HeadBucketCommand({ Bucket: config.bucket }));
        return { connected: true };
      case 'list': {
        const result = await send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: input.prefix || '',
          MaxKeys: input.maxKeys || 50, ContinuationToken: input.continuationToken }));
        return { items: (result.Contents || []).map(item => ({ key: item.Key, size: item.Size, etag: item.ETag, lastModified: item.LastModified })),
          nextContinuationToken: result.NextContinuationToken || null, truncated: !!result.IsTruncated };
      }
      case 'get': {
        const result = await send(new GetObjectCommand({ ...base, VersionId: input.versionId }));
        const body = result.Body, chunks = []; let bytes = 0;
        const stop = () => body?.destroy();
        execution.signal.addEventListener('abort', stop, { once: true });
        try {
          execution.signal.throwIfAborted();
          if (result.ContentLength > 1048576) throw arp.arpError('RESOURCE_BUSY', '对象超过 1 MiB，请使用对象存储客户端下载');
          for await (const chunk of body) {
            execution.signal.throwIfAborted(); bytes += chunk.length;
            if (bytes > 1048576) throw arp.arpError('RESOURCE_BUSY', '对象超过 1 MiB，请使用对象存储客户端下载');
            chunks.push(chunk);
          }
          execution.signal.throwIfAborted();
          return { content: Buffer.concat(chunks).toString(input.encoding === 'base64' ? 'base64' : 'utf8'),
            encoding: input.encoding || 'text', contentType: result.ContentType || '', size: bytes,
            etag: result.ETag, versionId: result.VersionId || null };
        } finally { execution.signal.removeEventListener('abort', stop); stop(); }
      }
      case 'put': {
        if (input.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content))) {
          throw arp.arpError('INVALID_REQUEST', 'content 必须是标准 base64 字符串');
        }
        const body = Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
        if (body.length > 1048576) throw arp.arpError('INVALID_REQUEST', '上传内容最多 1 MiB');
        const result = await send(new PutObjectCommand({ ...base, Body: body, ContentType: input.contentType || 'application/octet-stream',
          ...(input.overwrite ? {} : { IfNoneMatch: '*' }) }));
        return { etag: result.ETag, versionId: result.VersionId || null, size: body.length };
      }
      case 'delete': {
        const result = await send(new DeleteObjectCommand({ ...base, VersionId: input.versionId }));
        return { deleted: true, deleteMarker: !!result.DeleteMarker, versionId: result.VersionId || null };
      }
    }
  } finally { client.destroy(); }
}

module.exports = { redis, ssh, s3 };
