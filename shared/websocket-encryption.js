// Pairing v1: AES-256-GCM. Call encrypt/decrypt in wire order per connection.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mcp-contract'));
  else root.WebSocketEncryption = factory(root.McpContract);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (c) {
  'use strict';
  var MAX_FRAME_BYTES = Math.ceil((c.LIMITS.frameBytes + 16) / 3) * 4 + 256;
  var encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  function encode(bytes) {
    var chunks = [];
    for (var offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768)));
    return btoa(chunks.join(''));
  }
  function decode(value) { return Uint8Array.from(atob(value), function (character) { return character.charCodeAt(0); }); }
  async function create(communicationKey, identity, isClient) {
    c.communicationKey(communicationKey);
    // Include the client's fresh authentication request ID so replaying auth.ok cannot reuse its sending key/IV.
    var binding = JSON.stringify([c.TRANSPORT, c.PAIRING, identity.serverId, identity.clientId, identity.pairingId, identity.transportSessionId, identity.requestId]);
    var material = await crypto.subtle.importKey('raw', decode(communicationKey.replace(/-/g, '+').replace(/_/g, '/') + '='), 'HKDF', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(identity.transportSessionId),
      info: encoder.encode(binding) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    var sent = 0, received = 0;
    function parameters(sequence, fromClient) {
      var iv = new Uint8Array(12), view = new DataView(iv.buffer);
      // Direction + sequence is unique under the key derived for this session.
      view.setUint32(0, fromClient ? 1 : 2); view.setBigUint64(4, BigInt(sequence));
      return { name: 'AES-GCM', iv: iv, tagLength: 128,
        additionalData: encoder.encode(JSON.stringify([binding, fromClient ? 'client' : 'server', sequence])) };
    }
    return {
      encrypt: async function (text) {
        var bytes = encoder.encode(text);
        if (bytes.length > c.LIMITS.frameBytes) c.fail('FRAME_TOO_LARGE');
        if (!Number.isSafeInteger(sent + 1)) c.fail('SESSION_REQUEST_LIMIT');
        var sequence = ++sent;
        var encrypted = await crypto.subtle.encrypt(parameters(sequence, isClient), key, bytes);
        return JSON.stringify({ version: c.PAIRING, sequence: sequence, data: encode(new Uint8Array(encrypted)) });
      },
      decrypt: async function (frame) {
        if (!c.record(frame) || frame.version !== c.PAIRING) c.fail('PROTOCOL_INCOMPATIBLE');
        c.fields(frame, ['version', 'sequence', 'data'], ['version', 'sequence', 'data']);
        if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== received + 1) c.fail('INVALID_ENCRYPTED_SEQUENCE');
        if (typeof frame.data !== 'string' || frame.data.length > MAX_FRAME_BYTES || frame.data.length % 4 !== 0
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) c.fail('INVALID_ENCRYPTED_FRAME');
        var bytes = decode(frame.data);
        if (bytes.length < 16 || bytes.length > c.LIMITS.frameBytes + 16) c.fail('INVALID_ENCRYPTED_FRAME');
        var plaintext;
        try { plaintext = await crypto.subtle.decrypt(parameters(frame.sequence, !isClient), key, bytes); }
        catch (_) { c.fail('DECRYPTION_FAILED'); }
        received = frame.sequence;
        return decoder.decode(plaintext);
      }
    };
  }
  return Object.freeze({ create: create, MAX_FRAME_BYTES: MAX_FRAME_BYTES });
});
