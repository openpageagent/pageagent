'use strict';

const { simpleParser } = require('mailparser');
const { adaptMessage } = require('@koishijs/plugin-adapter-mail');

// adapter-mail 2.3.2 marks UNSEEN mail read before parsing it. Replace only its
// receive loop: one UID at a time, durable acceptance before the IMAP flag.
function installMailReceiver(ctx, accept, report) {
  ctx.on('bot-connect', bot => {
    if (bot.platform !== 'mail' || bot.adapter.pageAgentReceiver) return;
    const adapter = bot.adapter, imap = adapter.imap;
    adapter.pageAgentReceiver = true;
    let closed = false, scanning = false, mailbox = null;
    function operation(start) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); imap.removeListener('close', disconnected);
          error ? reject(error) : resolve(value);
        };
        const disconnected = () => finish(new Error('IMAP disconnected'));
        const timer = setTimeout(() => { finish(new Error('IMAP timeout')); imap.destroy(); }, 60000);
        imap.once('close', disconnected);
        try { start(finish); } catch (error) { finish(error); }
      });
    }
    function fetchMail(uid) {
      return operation(done => {
        let parsing = Promise.resolve(null), parseError;
        const fetch = imap.fetch([uid], { bodies: '', markSeen: false });
        fetch.on('message', message => {
          message.on('error', done);
          message.once('body', stream => {
            parsing = new Promise((resolve, reject) => {
              const chunks = []; let bytes = 0;
              stream.on('data', chunk => {
                bytes += chunk.length;
                if (bytes <= 32 * 1024 * 1024) chunks.push(chunk);
              });
              stream.once('error', reject);
              stream.once('end', () => {
                if (bytes > 32 * 1024 * 1024) { reject(new Error('Mail exceeds 32MB')); return; }
                simpleParser(Buffer.concat(chunks)).then(resolve, reject);
              });
            }).catch(error => { parseError = error; return null; });
          });
        });
        fetch.once('error', done);
        fetch.once('end', () => parsing.then(mail => done(parseError, mail), done));
      });
    }
    async function scan() {
      if (closed || scanning || !mailbox || !bot.isActive) return;
      scanning = true;
      let failed = false;
      try {
        const uids = await operation(done => imap.search(['UNSEEN'], done));
        for (const uid of uids) {
          if (closed || !mailbox || !bot.isActive) break;
          try {
            const mail = await fetchMail(uid);
            if (!mail || closed || !bot.isActive) continue;
            mail.messageId ||= 'imap:' + mailbox.uidvalidity + ':' + uid;
            const session = bot.session({ type: 'message' });
            await adaptMessage(bot, mail, session.event.message = {}, session.event);
            if (!accept(session)) break;
            // Preserve upstream Koishi event behavior. The receiver deduplicates
            // this second delivery against the already committed message ID.
            Object.defineProperty(session, 'mail', { value: mail });
            bot.dispatch(session);
            await operation(done => imap.addFlags([uid], ['\\Seen'], done));
          } catch (_) { failed = true; report('邮件读取或确认失败，未确认邮件保留未读并稍后重试；请检查邮箱、格式和单封 32MB 限制'); }
        }
        if (!failed) report('');
      } catch (_) { if (!closed) report('邮件扫描失败，未确认邮件保留未读并稍后重试'); }
      finally { scanning = false; }
    }
    adapter.scan = scan;
    adapter.inbox = (error, box) => {
      if (error) { report('无法打开 INBOX，请检查邮箱权限'); return; }
      mailbox = box; bot.online(); scan();
    };
    const disconnected = () => { mailbox = null; };
    imap.on('close', disconnected); imap.on('mail', scan);
    const timer = setInterval(scan, 30000); timer.unref();
    ctx.on('dispose', () => {
      closed = true; clearInterval(timer); imap.removeListener('close', disconnected); imap.removeListener('mail', scan);
    });
  });
}

module.exports = { installMailReceiver };
