(function (root) {
  'use strict';
  const loaded = new Set();
  const paths = {
    crypto: ['crypto-js/crypto-js.js'], sm2: ['sm-crypto/dist/sm2.js'], sm3: ['sm-crypto/dist/sm3.js'], sm4: ['sm-crypto/dist/sm4.js'],
    bcrypt: ['bcryptjs/dist/bcrypt.min.js'],
    qr: ['qrcode-generator/qrcode.js', 'qrcode-generator/qrcode_UTF8.js'], qrParse: ['jsqr/dist/jsQR.js'], barcode: ['jsbarcode/dist/JsBarcode.all.min.js'],
    pinyin: ['pinyin-pro/dist/index.js'], yaml: ['js-yaml/dist/js-yaml.min.js'], csv: ['papaparse/papaparse.min.js'], xml: ['fast-xml-parser/lib/fxp.min.js'],
    jsonpath: ['jsonpath-plus/dist/index-browser-umd.js'], jmespath: ['jmespath/jmespath.js'], jsonrepair: ['jsonrepair/lib/umd/jsonrepair.js'],
    prettier: ['prettier/standalone.js', 'prettier/plugins/babel.js', 'prettier/plugins/estree.js', 'prettier/plugins/typescript.js', 'prettier/plugins/html.js', 'prettier/plugins/postcss.js', 'prettier/plugins/markdown.js', 'prettier/plugins/yaml.js', 'prettier/plugins/graphql.js'],
    php: ['@prettier/plugin-php/standalone.js'], sql: ['sql-formatter/dist/sql-formatter.min.js'],
    terser: ['terser/dist/bundle.min.js'], css: ['csso/dist/csso.js'], math: ['mathjs/lib/browser/math.js'],
    cronstrue: ['cronstrue/dist/cronstrue-i18n.min.js'], nzh: ['nzh/dist/nzh.min.js'], diff: ['diff/dist/diff.js'], html: ['he/he.js']
  };
  function load(name) {
    if (loaded.has(name)) return;
    if (!Object.hasOwn(paths, name)) throw new Error('未知本地算法库');
    importScripts(...paths[name].map(path => '../dependencies/utilities/' + path));
    loaded.add(name);
  }
  function esm(path) { return import(new URL('../dependencies/utilities/' + path, self.location.href).href); }
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  function hex(bytes) { return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
  function unhex(value) {
    value = value.replace(/\s/g, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('十六进制输入必须是完整的字节对');
    return Uint8Array.from(value.match(/../g) || [], part => parseInt(part, 16));
  }
  function base64(bytes) {
    let value = '';
    for (let start = 0; start < bytes.length; start += 8192) value += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(value);
  }
  function unbase64(value) {
    const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.replace(/=+$/, '').length % 4 === 1) throw new Error('Base64 格式错误');
    return Uint8Array.from(atob(normalized), char => char.charCodeAt(0));
  }
  function escapeXml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }
  function json(value) { return JSON.parse(value); }
  function date(value) {
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/i.exec(value);
    if (!match) throw new Error('请使用带时区的 ISO 8601 时间，例如 2026-10-17T08:00:00+08:00');
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) throw new Error('无效日期或时间');
    const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new Error('无效日期'); return result;
  }
  const bytes = (input, encoding) => encoding === 'hex' ? unhex(input) : encoding === 'base64' ? unbase64(input) : encoder.encode(input);
  root.OfflineTools = { handlers: Object.create(null), load, esm, encoder, decoder, hex, unhex, base64, unbase64, bytes, escapeXml, json, date };
})(globalThis);
