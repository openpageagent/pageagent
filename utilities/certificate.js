// Decode certificate metadata with the shared ASN.1 parser; no trust or network lookup.
(function (U) {
  'use strict';
  const names = {
    '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.5': 'serialNumber',
    '1.2.840.113549.1.9.1': 'emailAddress', '0.9.2342.19200300.100.1.25': 'DC',
    '1.2.840.113549.1.1.1': 'rsaEncryption', '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
    '1.2.840.113549.1.1.10': 'rsassaPss', '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
    '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption', '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
    '1.2.840.10045.2.1': 'id-ecPublicKey', '1.2.840.10045.3.1.7': 'prime256v1', '1.3.132.0.34': 'secp384r1', '1.3.132.0.35': 'secp521r1',
    '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256', '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384', '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
    '1.3.101.112': 'ED25519', '1.3.101.113': 'ED448',
    '2.5.29.14': 'Subject Key Identifier', '2.5.29.15': 'Key Usage', '2.5.29.17': 'Subject Alternative Name',
    '2.5.29.19': 'Basic Constraints', '2.5.29.35': 'Authority Key Identifier', '2.5.29.37': 'Extended Key Usage',
    '1.3.6.1.5.5.7.3.1': 'TLS Web Server Authentication', '1.3.6.1.5.5.7.3.2': 'TLS Web Client Authentication',
    '1.3.6.1.5.5.7.3.3': 'Code Signing', '1.3.6.1.5.5.7.3.4': 'E-mail Protection', '1.3.6.1.5.5.7.3.8': 'Time Stamping'
  };
  const is = (node, tag, tagClass = 0) => node?.tag === tag && node.tagClass === tagClass;
  function expect(node, tag, tagClass = 0) {
    if (!is(node, tag, tagClass)) throw new Error('X.509 证书结构无效');
    return node;
  }
  const label = oid => names[oid] || oid;
  const hex = value => (value.match(/../g) || []).join(':').toUpperCase();
  const decodedExtensions = new Set(['2.5.29.14', '2.5.29.15', '2.5.29.17', '2.5.29.19', '2.5.29.35', '2.5.29.37']);
  function parse(value, encoding = 'hex') {
    const nodes = U.handlers.asn1(value, 'decode', { encoding, outputFormat: 'json' });
    if (nodes.length !== 1) throw new Error('请输入一张完整的 X.509 证书');
    return nodes[0];
  }
  function name(node) {
    return expect(node, 16).children.map(set => expect(set, 17).children.map(item => {
      const [oid, value] = expect(item, 16).children;
      return label(expect(oid, 6).oid) + '=' + (value?.text ?? '#' + (value?.hex || ''));
    }).join(' + ')).join(', ');
  }
  function date(node) {
    if (!is(node, 23) && !is(node, 24)) throw new Error('X.509 有效期格式无效');
    const match = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(node.text || '');
    if (!match || match[1].length !== (node.tag === 23 ? 2 : 4)) throw new Error('X.509 有效期格式无效');
    const [, rawYear, month, day, hour, minute, second] = match;
    const year = rawYear.length === 2 ? (Number(rawYear) < 50 ? '20' : '19') + rawYear : rawYear;
    return U.date(year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second + 'Z').toISOString();
  }
  function algorithm(node) {
    const children = expect(node, 16).children;
    const oid = expect(children[0], 6).oid;
    return label(oid) + (is(children[1], 6) ? ' (' + label(children[1].oid) + ')' : '');
  }
  function extension(oid, node) {
    if (oid === '2.5.29.19') {
      const items = expect(node, 16).children;
      return 'CA:' + (items.find(item => is(item, 1))?.value ? 'TRUE' : 'FALSE') + (items.some(item => is(item, 2)) ? ', pathlen:' + items.find(item => is(item, 2)).decimal : '');
    }
    if (oid === '2.5.29.14') return hex(expect(node, 4).hex);
    if (oid === '2.5.29.35') return expect(node, 16).children.map(item => (is(item, 0, 2) ? 'keyid:' : 'field ' + item.tag + ':') + hex(item.hex)).join('\n');
    if (oid === '2.5.29.37') return expect(node, 16).children.map(item => label(expect(item, 6).oid)).join(', ');
    if (oid === '2.5.29.17') return expect(node, 16).children.map(item => {
      const bytes = U.unhex(item.hex);
      if (item.tagClass !== 2) throw new Error('X.509 Subject Alternative Name 无效');
      if ([1, 2, 6].includes(item.tag)) return ({ 1: 'email:', 2: 'DNS:', 6: 'URI:' })[item.tag] + U.decoder.decode(bytes);
      if (item.tag === 7 && bytes.length === 4) return 'IP Address:' + Array.from(bytes).join('.');
      if (item.tag === 7 && bytes.length === 16) return 'IP Address:' + item.hex.match(/.{4}/g).join(':');
      if (item.tag === 4) return 'DirName:' + name(item.children?.[0]);
      return 'GeneralName [' + item.tag + ']:' + hex(item.hex);
    }).join(', ');
    if (oid === '2.5.29.15') {
      const bits = U.unhex(expect(node, 3).hex);
      if (!bits.length || bits[0] > 7) throw new Error('X.509 Key Usage 无效');
      const usages = ['Digital Signature', 'Non Repudiation', 'Key Encipherment', 'Data Encipherment', 'Key Agreement', 'Certificate Sign', 'CRL Sign', 'Encipher Only', 'Decipher Only'];
      return usages.filter((_, index) => index < (bits.length - 1) * 8 - bits[0] && (bits[1 + Math.floor(index / 8)] & (128 >> index % 8))).join(', ');
    }
    return hex(node.hex);
  }
  U.handlers.certificate = input => {
    const source = input.trim(), pem = /^-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+)\s*-----END CERTIFICATE-----$/.exec(source);
    if (source.includes('-----') && !pem) throw new Error('请输入单张 PEM CERTIFICATE，不接受私钥或证书请求');
    const certificate = expect(parse(pem ? pem[1] : source, 'base64'), 16);
    if (certificate.children.length !== 3) throw new Error('X.509 证书结构无效');
    const [tbs, signatureAlgorithm, signature] = certificate.children, fields = expect(tbs, 16).children;
    let offset = 0, version = 1;
    if (is(fields[0], 0, 2)) { version = Number(expect(fields[offset++].children?.[0], 2).decimal) + 1; }
    if (![1, 2, 3].includes(version)) throw new Error('X.509 版本无效');
    const serial = expect(fields[offset++], 2), signing = fields[offset++], issuer = fields[offset++], validity = expect(fields[offset++], 16), subject = fields[offset++], spki = expect(fields[offset++], 16);
    if (validity.children.length !== 2 || spki.children.length !== 2) throw new Error('X.509 证书字段不完整');
    const [keyAlgorithm, publicKey] = spki.children, key = expect(publicKey, 3).hex;
    if (!key.startsWith('00') || !expect(signature, 3).hex.startsWith('00')) throw new Error('X.509 公钥或签名位串无效');
    const lines = ['Certificate:', '    Data:', '        Version: ' + version + ' (0x' + (version - 1) + ')',
      '        Serial Number: ' + hex(serial.hex), '        Signature Algorithm: ' + algorithm(signing),
      '        Issuer: ' + name(issuer), '        Validity', '            Not Before: ' + date(validity.children[0]), '            Not After : ' + date(validity.children[1]),
      '        Subject: ' + name(subject), '        Subject Public Key Info:', '            Public Key Algorithm: ' + algorithm(keyAlgorithm)];
    const block = (title, value, indent = '                ') => {
      lines.push(indent + title);
      for (const part of value.match(/.{1,36}/g) || []) lines.push(indent + '    ' + hex(part));
    };
    const keyOid = keyAlgorithm.children[0].oid;
    if (['1.2.840.113549.1.1.1', '1.2.840.113549.1.1.10'].includes(keyOid)) {
      const rsa = expect(parse(key.slice(2)), 16).children, modulus = expect(rsa[0], 2).hex.replace(/^(00)+/, ''), exponent = expect(rsa[1], 2);
      const bits = modulus ? (modulus.length / 2 - 1) * 8 + (32 - Math.clz32(parseInt(modulus.slice(0, 2), 16))) : 0;
      lines.push('                Public-Key: (' + bits + ' bit)'); block('Modulus:', modulus);
      lines.push('                Exponent: ' + exponent.decimal + ' (0x' + exponent.hex + ')');
    } else block('Public-Key:', key.slice(2));
    for (const field of fields.slice(offset)) {
      if (!is(field, 3, 2)) continue;
      lines.push('        X509v3 extensions:');
      for (const item of expect(field.children?.[0], 16).children) {
        const children = expect(item, 16).children, oid = expect(children[0], 6).oid, critical = is(children[1], 1) && children[1].value;
        const value = expect(children[is(children[1], 1) ? 2 : 1], 4);
        lines.push('            ' + label(oid) + ':' + (critical ? ' critical' : ''));
        const decoded = decodedExtensions.has(oid) ? extension(oid, parse(value.hex)) : hex(value.hex);
        lines.push(...decoded.split('\n').map(line => '                ' + line));
      }
    }
    lines.push('    Signature Algorithm: ' + algorithm(signatureAlgorithm)); block('Signature Value:', signature.hex.slice(2), '    ');
    return lines.join('\n');
  };
})(OfflineTools);
