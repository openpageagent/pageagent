'use strict';

const net = require('net');
const nodemailer = require('nodemailer');
const settings = require('../settings/mail-settings');

function mailError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

function smtpError(error) {
  if (error && error.code === 'EAUTH') return mailError('SMTP 认证失败，请检查用户名和服务商要求的密码、授权码或应用专用密码，并确认已开启 SMTP 服务');
  if (error && error.code === 'ETLS') return mailError('SMTP TLS 连接或证书校验失败，请检查服务器、端口和加密方式');
  if (error && error.code === 'EENVELOPE') return mailError('SMTP 拒绝发件人或全部收件地址，请检查邮箱配置');
  const code = Number(error && error.responseCode);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return mailError('SMTP 拒绝邮件（状态码 ' + code + '），请检查账户和邮件内容');
  // Provider messages can contain addresses, credentials, or message content.
  return mailError('SMTP 连接或发送失败，投递结果可能未知，请检查网络和邮箱投递记录后再重试');
}

function sendMail(payload, options = {}) {
  return new Promise((resolve, reject) => {
    let config;
    let message;
    try {
      config = settings.validate(payload && payload.config);
      message = settings.prepareMessage(payload && payload.message);
    } catch (error) {
      reject(mailError(error.message));
      return;
    }
    let socket;
    let transport;
    let timer;
    let settled = false;
    const signal = options.signal;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (socket) socket.destroy();
      if (transport) transport.close();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(mailError('邮件发送已取消或连接已断开；已提交 SMTP 的邮件仍可能送达，请确认后再重试'));
    if (signal && signal.aborted) { onAbort(); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(mailError('SMTP 发送超过 80 秒，投递结果未知，请确认后再重试')), settings.DELIVERY_LIMITS.sendTimeoutMs);

    try {
      transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.security === 'tls',
        requireTLS: config.security === 'starttls',
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
        tls: { rejectUnauthorized: true, servername: net.isIP(config.host) ? undefined : config.host },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
        // Hold the raw socket so cancellation also stops the non-pooled SMTP
        // transport. Nodemailer performs TLS/STARTTLS over this connection.
        getSocket(_options, callback) {
          if (settled) { callback(mailError('邮件发送已取消')); return; }
          socket = net.createConnection({ host: config.host, port: config.port });
          const onConnectTimeout = () => socket.destroy(new Error('SMTP connection timeout'));
          socket.setTimeout(15000, onConnectTimeout);
          socket.once('error', callback);
          socket.once('connect', () => {
            socket.removeListener('error', callback);
            if (settled) { socket.destroy(); callback(mailError('邮件发送已取消')); return; }
            socket.removeListener('timeout', onConnectTimeout);
            socket.setTimeout(0);
            callback(null, { connection: socket });
          });
        },
      });
      const recipients = Array.from(new Set(message.to.concat(message.cc, message.bcc)));
      const mail = {
        from: { name: config.fromName, address: config.from },
        to: message.to.map(address => ({ address })),
        cc: message.cc.map(address => ({ address })),
        // Bcc is only an envelope recipient, never a MIME header.
        envelope: { from: config.from, to: recipients },
        subject: message.subject,
        attachments: message.attachments.map(item => ({
          filename: item.fileName,
          contentType: item.mimeType || undefined,
          content: Buffer.from(item.content, item.contentMode === 'base64' ? 'base64' : 'utf8'),
        })),
        disableFileAccess: true,
        disableUrlAccess: true,
      };
      mail[message.bodyFormat === 'html' ? 'html' : 'text'] = message.body;
      transport.sendMail(mail).then(info => {
        const acceptedCount = (info.accepted || []).length;
        const rejected = (info.rejected || []).filter(address => recipients.includes(address));
        if (rejected.length) {
          finish(mailError('邮件部分投递：SMTP 接受 ' + acceptedCount + ' 个地址；拒收地址：' + rejected.join(', ')
            + '。请仅补发拒收地址。Message-ID：' + info.messageId));
        } else if (!acceptedCount) {
          finish(mailError('SMTP 未接受任何收件地址'));
        } else {
          finish(null, { messageId: info.messageId, acceptedCount, rejectedCount: 0 });
        }
      }, error => finish(smtpError(error)));
    } catch (error) {
      finish(smtpError(error));
    }
  });
}

module.exports = { sendMail };
