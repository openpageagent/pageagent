(function (U) {
  'use strict';
  const H = U.handlers;
  // RFC 1319 / RFC 1320 legacy digests, retained for inspecting existing data.
  function md2(bytes) {
    const substitution = [41,46,67,201,162,216,124,1,61,54,84,161,236,240,6,19,98,167,5,243,192,199,115,140,152,147,43,217,188,76,130,202,30,155,87,60,253,212,224,22,103,66,111,24,138,23,229,18,190,78,196,214,218,158,222,73,160,251,245,142,187,47,238,122,169,104,121,145,21,178,7,63,148,194,16,137,11,34,95,33,128,127,93,154,90,144,50,39,53,62,204,231,191,247,151,3,255,25,48,179,72,165,181,209,215,94,146,42,172,86,170,198,79,184,56,210,150,164,125,182,118,252,107,226,156,116,4,241,69,157,112,89,100,113,135,32,134,91,207,101,230,45,168,2,27,96,37,173,174,176,185,246,28,70,97,105,52,64,126,15,85,71,163,35,221,81,175,58,195,92,249,206,186,197,234,38,44,83,13,110,133,40,132,9,211,223,205,244,65,129,77,82,106,220,55,200,108,193,171,250,36,225,123,8,12,189,177,74,120,136,149,139,227,99,232,109,233,203,213,254,59,0,29,57,242,239,183,14,102,88,208,228,166,119,114,248,235,117,75,10,49,68,80,180,143,237,31,26,219,153,141,51,159,17,131,20];
    const padding = 16 - bytes.length % 16, data = new Uint8Array(bytes.length + padding + 16), checksum = new Uint8Array(16), state = new Uint8Array(48);
    data.set(bytes); data.fill(padding, bytes.length, bytes.length + padding);
    let last = 0;
    for (let offset = 0; offset < data.length - 16; offset += 16) for (let j = 0; j < 16; j++) { checksum[j] ^= substitution[data[offset + j] ^ last]; last = checksum[j]; }
    data.set(checksum, data.length - 16);
    for (let offset = 0; offset < data.length; offset += 16) {
      for (let j = 0; j < 16; j++) { state[16 + j] = data[offset + j]; state[32 + j] = state[16 + j] ^ state[j]; }
      let t = 0;
      for (let round = 0; round < 18; round++) { for (let k = 0; k < 48; k++) { state[k] ^= substitution[t]; t = state[k]; } t = (t + round) & 255; }
    }
    return U.hex(state.subarray(0, 16));
  }
  function md4(bytes) {
    const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64), view = new DataView(data.buffer);
    data.set(bytes); data[bytes.length] = 128; view.setBigUint64(data.length - 8, BigInt(bytes.length) * 8n, true);
    const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476], rotate = (n, s) => n << s | n >>> (32 - s);
    const order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let offset = 0; offset < data.length; offset += 64) {
      let [a, b, c, d] = state;
      for (let round = 0; round < 3; round++) for (let i = 0; i < 16; i++) {
        const f = round === 0 ? b & c | ~b & d : round === 1 ? b & c | b & d | c & d : b ^ c ^ d;
        const k = round === 0 ? i : round === 1 ? i % 4 * 4 + Math.floor(i / 4) : order[i];
        const n = rotate((a + f + view.getUint32(offset + k * 4, true) + [0, 0x5a827999, 0x6ed9eba1][round]) | 0, [[3, 7, 11, 19], [3, 5, 9, 13], [3, 9, 11, 15]][round][i % 4]);
        [a, b, c, d] = [d, n, b, c];
      }
      [a, b, c, d].forEach((value, i) => { state[i] = (state[i] + value) >>> 0; });
    }
    const output = new DataView(new ArrayBuffer(16)); state.forEach((value, i) => output.setUint32(i * 4, value, true)); return U.hex(new Uint8Array(output.buffer));
  }
  H.hash = (input, operation, options) => {
    if (operation === 'all') return { bytes: U.bytes(input, options.inputEncoding).length, hashes: Object.fromEntries(['MD2', 'MD4', 'MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512'].map(algorithm => [algorithm, H.hash(input, 'digest', { ...options, algorithm, multiple: false, salted: false })])) };
    const digest = bytes => {
      if (options.algorithm === 'MD2') return md2(bytes);
      if (options.algorithm === 'MD4') return md4(bytes);
      if (options.algorithm === 'SM3') { U.load('sm3'); return sm3(Array.from(bytes)); }
      U.load('crypto'); return CryptoJS[options.algorithm === 'Keccak512' ? 'SHA3' : options.algorithm](CryptoJS.enc.Hex.parse(U.hex(bytes))).toString(CryptoJS.enc.Hex);
    };
    const calculate = value => {
      if (!options.salted) return digest(U.bytes(value, options.inputEncoding));
      if (options.inputEncoding !== 'utf8') throw new Error('加盐仅支持文本输入');
      const expression = options.expression.replace(/\s/g, ''); let cursor = 0;
      function parse(depth = 0) {
        if (depth > 32) throw new Error('盐值表达式嵌套过深');
        let result = '';
        do {
          if (expression.startsWith('$input', cursor)) { result += value; cursor += 6; }
          else if (expression.startsWith('$salt', cursor)) { result += options.salt; cursor += 5; }
          else if (expression.startsWith('hash(', cursor)) { cursor += 5; const part = parse(depth + 1); if (expression[cursor++] !== ')') throw new Error('盐值表达式括号未闭合'); result += digest(U.encoder.encode(part)); }
          else throw new Error('盐值表达式只支持 hash、$input、$salt 和点号拼接');
          if (result.length > 100000) throw new Error('盐值表达式结果过大');
          if (expression[cursor] !== '.') break; cursor++;
        } while (true);
        return result;
      }
      const result = parse(); if (cursor !== expression.length) throw new Error('盐值表达式有多余内容'); return result;
    };
    if (options.multiple && options.inputEncoding !== 'utf8') throw new Error('逐行计算仅支持文本输入');
    const result = (options.multiple ? input.split(/\r?\n/) : [input]).map(calculate).join('\n');
    return options.uppercase ? result.toUpperCase() : result;
  };
  H.hmac = (input, _operation, options) => {
    if (options.multiple && options.inputEncoding !== 'utf8') throw new Error('逐行计算仅支持文本输入');
    const key = U.bytes(options.key, options.keyEncoding);
    const result = (options.multiple ? input.split(/\r?\n/) : [input]).map(value => {
      const bytes = U.bytes(value, options.inputEncoding);
      if (options.algorithm === 'SM3') { U.load('sm3'); return sm3(Array.from(bytes), { key: U.hex(key), mode: 'hmac' }); }
      U.load('crypto'); return CryptoJS['Hmac' + (options.algorithm === 'Keccak512' ? 'SHA3' : options.algorithm)](CryptoJS.enc.Hex.parse(U.hex(bytes)), CryptoJS.enc.Hex.parse(U.hex(key))).toString(CryptoJS.enc.Hex);
    }).join('\n');
    return options.uppercase ? result.toUpperCase() : result;
  };
  for (const [id, name] of [['aes', 'AES'], ['des', 'DES'], ['tripleDes', 'TripleDES'], ['rc4', 'RC4'], ['rabbit', 'Rabbit']]) {
    H[id] = (input, operation, options) => {
      U.load('crypto');
      if (!options.key) throw new Error('请输入密钥');
      const inputBytes = U.bytes(input, operation === 'decrypt' && options.inputEncoding === 'utf8' ? 'base64' : options.inputEncoding);
      const outputEncoding = options.outputEncoding === 'auto' ? operation === 'decrypt' ? 'utf8' : 'base64' : options.outputEncoding;
      const encode = bytes => outputEncoding === 'hex' ? U.hex(bytes) : outputEncoding === 'utf8' ? U.decoder.decode(bytes) : U.base64(bytes);
      if (options.type === 'simple') {
        if (!options.key) throw new Error('请输入密钥');
        if (operation === 'encrypt') {
          const value = CryptoJS[name].encrypt(CryptoJS.enc.Hex.parse(U.hex(inputBytes)), options.key).toString();
          return outputEncoding === 'base64' ? value : encode(U.unbase64(value));
        }
        const value = CryptoJS[name].decrypt(U.base64(inputBytes), options.key);
        if (value.sigBytes < 0) throw new Error('解密失败'); return encode(U.unhex(value.toString(CryptoJS.enc.Hex)));
      }
      const secret = (value, size, fill) => {
        if (options.keyEncoding === 'hex') return U.unhex(value);
        if (size) {
          if (!fill && value.length !== size) throw new Error('密钥 / IV 长度不正确');
          value = value.slice(0, size).padEnd(size, '\0');
        }
        return U.encoder.encode(value);
      };
      const keyBytes = secret(options.key, id === 'aes' ? Number(options.keySize) / 8 : id === 'des' ? 8 : 0, true), ivBytes = options.mode === 'ECB' || id === 'rc4' ? new Uint8Array() : secret(options.iv || '', id === 'aes' ? 16 : 8, options.fill);
      const sizes = { aes: [16, 24, 32], des: [8], tripleDes: [16, 24], rabbit: [16] };
      if (!keyBytes.length || sizes[id] && !sizes[id].includes(keyBytes.length)) throw new Error('密钥字节数不符合 ' + name + ' 要求');
      const block = id === 'aes' ? 16 : 8, stream = id === 'rc4' || id === 'rabbit';
      if (!stream && options.mode !== 'ECB' && ivBytes.length !== block || id === 'rabbit' && ivBytes.length !== 0 && ivBytes.length !== 8) throw new Error('IV 字节数不正确');
      const key = CryptoJS.enc.Hex.parse(U.hex(keyBytes));
      const config = {};
      if (ivBytes.length) config.iv = CryptoJS.enc.Hex.parse(U.hex(ivBytes));
      if (!stream) { config.mode = CryptoJS.mode[options.mode]; config.padding = CryptoJS.pad[options.padding]; }
      if (!stream && options.padding === 'NoPadding' && ['CBC', 'ECB'].includes(options.mode)) {
        const size = inputBytes.length;
        if (size % block) throw new Error('不填充时输入长度必须是分组长度的整数倍');
      }
      if (operation === 'encrypt') return encode(U.unhex(CryptoJS[name].encrypt(CryptoJS.enc.Hex.parse(U.hex(inputBytes)), key, config).ciphertext.toString(CryptoJS.enc.Hex)));
      const ciphertext = CryptoJS.enc.Hex.parse(U.hex(inputBytes));
      const decrypted = CryptoJS[name].decrypt({ ciphertext }, key, config);
      if (decrypted.sigBytes < 0) throw new Error('解密失败，请检查密钥、IV、模式和填充');
      return encode(U.unhex(decrypted.toString(CryptoJS.enc.Hex)));
    };
  }
  H.sm2 = (input, operation, options) => {
    U.load('sm2');
    if (operation === 'keypair') return sm2.generateKeyPairHex();
    const mode = options.cipherMode === 'C1C3C2' ? 1 : 0;
    const bytes = U.bytes(input, operation === 'decrypt' && options.inputEncoding === 'utf8' ? 'hex' : options.inputEncoding), key = ['encrypt', 'verify'].includes(operation) && options.key.length === 128 ? '04' + options.key : options.key;
    const encode = bytes => options.outputEncoding === 'base64' ? U.base64(bytes) : options.outputEncoding === 'utf8' || options.outputEncoding === 'auto' && operation === 'decrypt' ? U.decoder.decode(bytes) : U.hex(bytes);
    if (operation === 'encrypt') return encode(U.unhex(sm2.doEncrypt(Array.from(bytes), key, mode)));
    if (operation === 'decrypt') return encode(Uint8Array.from(sm2.doDecrypt(U.hex(bytes), key, mode, { output: 'array' })));
    const config = { hash: true, userId: options.userId };
    if (operation === 'sign') return encode(U.unhex(sm2.doSignature(Array.from(bytes), key, config)));
    return { valid: sm2.doVerifySignature(Array.from(bytes), U.hex(U.bytes(options.signature, options.signatureEncoding)), key, config) };
  };
  H.sm4 = (input, operation, options) => {
    U.load('sm4'); const key = U.bytes(options.key, options.keyEncoding), iv = options.mode === 'cbc' ? U.bytes(options.iv, options.ivEncoding) : new Uint8Array();
    if (key.length !== 16) throw new Error('SM4 密钥必须是 16 字节');
    if (options.mode === 'cbc' && iv.length !== 16) throw new Error('SM4 CBC 的 IV 必须是 16 字节');
    const bytes = U.bytes(input, operation === 'decrypt' && options.inputEncoding === 'utf8' ? 'hex' : options.inputEncoding);
    if (!options.padding && bytes.length % 16) throw new Error('不填充时输入长度必须是 16 的倍数');
    const result = Uint8Array.from(sm4[operation](Array.from(bytes), U.hex(key), { mode: options.mode, iv: U.hex(iv), padding: options.padding ? 'pkcs#7' : 'none', output: 'array' }));
    return options.outputEncoding === 'base64' ? U.base64(result) : options.outputEncoding === 'utf8' || options.outputEncoding === 'auto' && operation === 'decrypt' ? U.decoder.decode(result) : U.hex(result);
  };
  function pem(label, bytes) { return '-----BEGIN ' + label + '-----\n' + U.base64(new Uint8Array(bytes)).match(/.{1,64}/g).join('\n') + '\n-----END ' + label + '-----'; }
  H.rsa = async (input, operation, options) => {
    const algorithm = { name: 'RSA-OAEP', hash: options.hash };
    if (operation === 'keypair') {
      const pair = await crypto.subtle.generateKey({ ...algorithm, modulusLength: options.bits, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
      return { publicKey: pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey)), privateKey: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)) };
    }
    const key = await crypto.subtle.importKey(operation === 'encrypt' ? 'spki' : 'pkcs8', U.unbase64(options.key.replace(/-----[^-]+-----/g, '')), algorithm, false, [operation]);
    const result = new Uint8Array(await crypto.subtle[operation](algorithm, key, U.bytes(input, operation === 'decrypt' && options.inputEncoding === 'utf8' ? 'base64' : options.inputEncoding)));
    return options.outputEncoding === 'hex' ? U.hex(result) : options.outputEncoding === 'utf8' || options.outputEncoding === 'auto' && operation === 'decrypt' ? U.decoder.decode(result) : U.base64(result);
  };
  H.sign = async (input, operation, options) => {
    const ec = options.algorithm.includes('ECDSA'), hash = options.algorithm.split('with')[0].replace('SHA', 'SHA-');
    const algorithm = ec ? { name: 'ECDSA', namedCurve: options.curve === 'secp384r1' ? 'P-384' : 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash };
    if (operation === 'keypair') {
      const pair = await crypto.subtle.generateKey(ec ? algorithm : { ...algorithm, modulusLength: Number(options.bits || 2048), publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
      return { publicKey: pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey)), privateKey: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)) };
    }
    const key = await crypto.subtle.importKey(operation === 'sign' ? 'pkcs8' : 'spki', U.unbase64(options.key.replace(/-----[^-]+-----/g, '')), algorithm, false, [operation]);
    const config = ec ? { name: 'ECDSA', hash } : algorithm;
    return operation === 'sign' ? U.base64(new Uint8Array(await crypto.subtle.sign(config, key, U.encoder.encode(input)))) : { valid: await crypto.subtle.verify(config, key, U.unbase64(options.signature), U.encoder.encode(input)) };
  };
  H.bcrypt = (input, operation, options) => {
    U.load('bcrypt'); if (U.encoder.encode(input).length > 72) throw new Error('bcrypt 密码最多 72 个 UTF-8 字节，拒绝静默截断');
    return new Promise((resolve, reject) => {
      const callback = (error, value) => error ? reject(error) : resolve(operation === 'verify' ? { valid: value } : value);
      if (operation === 'verify') dcodeIO.bcrypt.compare(input, options.hash, callback);
      else dcodeIO.bcrypt.genSalt(options.rounds, (error, salt) => {
        if (error) return reject(error);
        dcodeIO.bcrypt.hash(input, salt.replace(/^\$2a\$/, '$' + options.version + '$'), callback);
      });
    });
  };
  H.dataValidation = (input, _operation, options) => {
    const bytes = U.bytes(input, options.encoding);
    let result = 0, digits = 2;
    if (options.algorithm === 'BCC') result = bytes.reduce((value, byte) => value ^ byte, 0);
    else if (options.algorithm === 'LRC') result = -bytes.reduce((value, byte) => value + byte, 0) & 255;
    else {
      const definitions = { CRC8: [8, 0x07, 0, false, 0], 'CRC16-MODBUS': [16, 0xa001, 0xffff, true, 0], 'CRC16-CCITT': [16, 0x1021, 0xffff, false, 0], CRC32: [32, 0xedb88320, 0xffffffff, true, 0xffffffff] };
      const [width, polynomial, initial, reflected, xor] = definitions[options.algorithm]; result = initial; digits = width / 4;
      for (const byte of bytes) {
        result ^= reflected ? byte : byte << (width - 8);
        for (let i = 0; i < 8; i++) result = reflected ? result & 1 ? result >>> 1 ^ polynomial : result >>> 1 : result & 1 << (width - 1) ? result << 1 ^ polynomial : result << 1;
        if (width < 32) result &= (1 << width) - 1;
      }
      result = (result ^ xor) >>> 0;
    }
    return { algorithm: options.algorithm, hex: result.toString(16).padStart(digits, '0').toUpperCase(), decimal: result, octal: result.toString(8), binary: result.toString(2).padStart(digits * 4, '0') };
  };
})(OfflineTools);
