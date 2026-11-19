'use strict';

const { parseStringPromise } = require('xml2js');

// adapter-wecom 2.5.0 verifies signatures only for encrypted messages. Require
// that envelope before its handler, and accept application/xml as well as text/xml.
function installWecomCallback(ctx) {
  ctx.inject(['server'], scope => {
    async function encryptedCallback(request, next) {
      let body, envelope;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request.req) {
          size += chunk.length;
          if (size > 1024 * 1024) { request.status = 413; return; }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString('utf8');
        envelope = (await parseStringPromise(body, { explicitArray: false }))?.xml;
      } catch (_) { request.status = 400; return; }
      const query = request.request.query;
      if (typeof envelope?.Encrypt !== 'string' || !envelope.Encrypt
        || !['timestamp', 'nonce', 'msg_signature'].every(key => typeof query[key] === 'string' && query[key])) {
        request.status = 403; return;
      }
      request.request.body = body;
      request[Symbol.for('isBodyParsed')] = true;
      return next(); // The official handler validates the signature and decrypts.
    }
    encryptedCallback[Symbol.for('noParseBody')] = true;
    scope.server.post('/wecom', encryptedCallback);
  });
}

module.exports = { installWecomCallback };
