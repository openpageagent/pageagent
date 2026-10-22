(function (U) {
  'use strict';
  const H = U.handlers;
  H.base64 = async (input, operation, options) => {
    if (operation === 'encode') { const value = U.base64(U.bytes(input, options.inputEncoding)); return options.urlSafe ? value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : value; }
    const bytes = U.unbase64(input);
    if (options.outputEncoding === 'hex') return U.hex(bytes);
    if (options.outputEncoding === 'download') return { mime: 'application/octet-stream', filename: 'decoded.bin', content: U.base64(bytes), encoding: 'base64' };
    if (options.outputEncoding === 'image') return { mime: 'image', content: await H.base64Image(input, 'decode'), filename: 'decoded-image' };
    return U.decoder.decode(bytes);
  };
  H.base64Image = async (input, operation, options = {}) => {
    const source = input.trim(), css = /^(?:background-image\s*:\s*)?url\(\s*(["']?)(data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+)\1\s*\)\s*;?$/i.exec(source);
    const value = css ? css[2] : source, match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(value);
    if (operation === 'encode' && !match) throw new Error('请读取 PNG/JPEG/GIF/WebP 图片，或输入图片 data URL');
    const bytes = U.unbase64(match ? match[2] : value);
    if (!bytes.length || bytes.length > 32768) throw new Error('图片大小必须在 1 字节到 32 KiB 之间');
    const hex = U.hex(bytes.subarray(0, 12));
    const mime = hex.startsWith('89504e470d0a1a0a') ? 'image/png'
      : hex.startsWith('ffd8ff') ? 'image/jpeg'
      : hex.startsWith('474946383761') || hex.startsWith('474946383961') ? 'image/gif'
      : hex.startsWith('52494646') && hex.slice(16) === '57454250' ? 'image/webp' : '';
    if (!mime || match && match[1].toLowerCase() !== mime) throw new Error('图片内容与 PNG/JPEG/GIF/WebP 格式不匹配');
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    try { if (bitmap.width * bitmap.height > 4194304) throw new Error('图片最多 400 万像素'); }
    finally { bitmap.close(); }
    const encoded = U.base64(bytes);
    const dataUrl = 'data:' + mime + ';base64,' + encoded;
    return operation !== 'encode' || options.representation === 'dataUrl' ? dataUrl : options.representation === 'css' ? 'background-image: url("' + dataUrl + '");' : encoded;
  };
  H.backslash = (input, operation) => operation === 'escape' ? JSON.stringify(input).slice(1, -1) : JSON.parse('"' + input + '"');
  H.svgToCss = (input, _operation, options = {}) => {
    U.load('xml');
    const valid = fxp.XMLValidator.validate(input);
    if (valid !== true) throw new Error(valid.err.msg);
    const value = new fxp.XMLParser({ ignoreAttributes: true, processEntities: false }).parse(input);
    const roots = Object.keys(value).filter(key => !key.startsWith('?'));
    if (roots.length !== 1 || roots[0] !== 'svg' || /<!DOCTYPE/i.test(input)) throw new Error('请输入以 svg 为根元素且不含 DOCTYPE 的 XML');
    const encoded = options.encoding === 'base64' ? ';base64,' + U.base64(U.encoder.encode(input)) : ',' + encodeURIComponent(input).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return 'background-image: url("data:image/svg+xml' + encoded + '");\nbackground-repeat: no-repeat;';
  };
  H.url = (input, operation, options) => {
    if (operation === 'decode') return options.component ? decodeURIComponent(input) : decodeURI(input);
    const encoded = options.component ? encodeURIComponent(input) : encodeURI(input);
    return options.component && options.rfc3986 ? encoded.replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) : encoded;
  };
  H.hexString = (input, operation, options) => {
    if (operation === 'decode') { const bytes = U.unhex(options.separator ? input.split(options.separator).join('') : input); return options.outputEncoding === 'base64' ? U.base64(bytes) : U.decoder.decode(bytes); }
    const value = Array.from(U.bytes(input, options.inputEncoding), byte => byte.toString(16).padStart(2, '0')).join(options.separator);
    return options.uppercase ? value.toUpperCase() : value;
  };
  H.unicode = (input, operation, options) => {
    if (operation === 'encode') return (options.style === 'javascript' ? input.split('') : Array.from(input)).map(char => {
      const code = char.codePointAt(0); if (options.ignoreASCII && code < 128) return char;
      const hex = code.toString(16).padStart(4, '0');
      return options.style === 'decimal' ? '&#' + code + ';' : options.style === 'html' ? '&#x' + code.toString(16) + ';' : options.style === 'codepoint' ? '\\u{' + code.toString(16) + '}' : options.style === 'number' ? 'U+' + hex.toUpperCase() : options.style === 'css' ? '\\' + hex + ' ' : '\\u' + hex;
    }).join('');
    if (options.style === 'wide') return input.replace(/\\u([0-9a-f]{1,6})/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    if (options.style === 'number') return input.replace(/U\+([0-9a-f]{1,6})/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    if (options.style === 'css') return input.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    return input.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|&#x([0-9a-f]+);|&#(\d+);/gi, (_, code, unit, hex, decimal) => decimal ? String.fromCodePoint(Number(decimal)) : code || hex ? String.fromCodePoint(parseInt(code || hex, 16)) : String.fromCharCode(parseInt(unit, 16)));
  };
  H.html = (input, operation) => { U.load('html'); return operation === 'encode' ? he.encode(input, { useNamedReferences: true }) : he.decode(input); };
  H.punycode = async (input, operation) => { const { default: punycode } = await U.esm('punycode/punycode.es6.js'); return operation === 'encode' ? punycode.toASCII(input) : punycode.toUnicode(input); };
  H.jwt = input => {
    const parts = input.trim().split('.'); if (parts.length !== 3) throw new Error('JWT 必须由三个点分片段组成');
    return { header: U.json(U.decoder.decode(U.unbase64(parts[0]))), payload: U.json(U.decoder.decode(U.unbase64(parts[1]))), signature: parts[2], signatureVerified: false };
  };
  H.gzip = async (input, operation, options) => {
    const format = options.deflate ? 'deflate' : 'gzip';
    const stream = new Blob([U.bytes(input, operation === 'decode' && options.inputEncoding === 'utf8' ? 'base64' : options.inputEncoding)]).stream().pipeThrough(operation === 'encode' ? new CompressionStream(format) : new DecompressionStream(format));
    const reader = stream.getReader(), chunks = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length; if (length > 1048576) throw new Error('解压或压缩结果超过 1 MiB'); chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const result = new Uint8Array(length); let offset = 0;
    for (const part of chunks) { result.set(part, offset); offset += part.length; }
    if (options.outputEncoding === 'download') return { mime: operation === 'encode' ? options.deflate ? 'application/octet-stream' : 'application/gzip' : 'application/octet-stream', filename: operation === 'encode' ? options.deflate ? 'compressed.deflate' : 'compressed.gz' : 'decompressed.bin', content: U.base64(result), encoding: 'base64' };
    return options.outputEncoding === 'hex' ? U.hex(result) : options.outputEncoding === 'utf8' || options.outputEncoding === 'auto' && operation === 'decode' ? U.decoder.decode(result) : U.base64(result);
  };
  H.urlParse = input => {
    const url = new URL(input), query = Object.create(null);
    for (const [key, value] of url.searchParams) query[key] = Object.hasOwn(query, key) ? [].concat(query[key], value) : value;
    return { href: url.href, protocol: url.protocol, username: url.username, password: url.password, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, parameters: Array.from(url.searchParams), query, hash: url.hash, origin: url.origin };
  };
  H.radix = (input, operation, options) => {
    if (operation === 'all') return Object.fromEntries(Array.from({ length: 63 }, (_, index) => [index + 2, H.radix(input, 'convert', { ...options, to: index + 2 })]));
    const digits = Array.from(options.alphabet), raw = input.trim(), parts = raw.replace(/^[+-]/, '').split('.');
    if (digits.length !== 64 || new Set(digits).size !== 64 || /[+\-.\s]/.test(options.alphabet)) throw new Error('字符表需要 64 个不同字符，不能包含符号 + - . 或空白');
    if (!raw || parts.length > 2 || !parts.some(Boolean)) throw new Error('请输入不带进制前缀的数值');
    let numerator = 0n, denominator = 1n;
    for (const char of parts.join('')) {
      let digit = digits.indexOf(char);
      if (digit >= options.from && options.from <= 36 && options.alphabet === '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_@') digit = digits.indexOf(char.toLowerCase());
      if (digit < 0 || digit >= options.from) throw new Error('源进制中不存在该数字：' + char);
      numerator = numerator * BigInt(options.from) + BigInt(digit);
    }
    if (parts[1]) denominator = BigInt(options.from) ** BigInt(Array.from(parts[1]).length);
    const base = BigInt(options.to); let integer = numerator / denominator, fraction = numerator % denominator, result = '';
    do { result = digits[Number(integer % base)] + result; integer /= base; } while (integer);
    if (fraction) {
      result += '.';
      for (let index = 0; fraction && index < 20; index++) { fraction *= base; result += digits[Number(fraction / denominator)]; fraction %= denominator; }
    }
    return (raw.startsWith('-') && numerator ? '-' : '') + result;
  };
  H.binary = (input, _operation, options) => input.trim().split(/\r?\n/).map(line => {
    const value = BigInt(line.trim()), bits = BigInt(options.bits), magnitude = value < 0n ? -value : value, signLimit = 1n << (bits - 1n), mask = (1n << bits) - 1n;
    if (value < -signLimit || value >= signLimit) throw new Error('整数超出指定位宽');
    const binary = number => number.toString(2).padStart(Number(bits), '0');
    return { input: line, signMagnitude: magnitude >= signLimit ? null : binary((value < 0n ? signLimit : 0n) | magnitude), onesComplement: magnitude >= signLimit ? null : binary(value < 0n ? mask ^ magnitude : value), twosComplement: binary(value & mask) };
  });
  H.ascii = (input, operation, options) => {
    const names = 'NUL SOH STX ETX EOT ENQ ACK BEL BS HT LF VT FF CR SO SI DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN EM SUB ESC FS GS RS US SPACE'.split(' ');
    const name = code => code === 127 ? 'DEL' : names[code];
    if (operation === 'table') return Array.from({ length: 128 }, (_, code) => ({ code, hex: code.toString(16).padStart(2, '0').toUpperCase(), character: name(code) || String.fromCharCode(code) }));
    const from = operation === 'encode' ? 'text' : operation === 'decode' ? 'decimal' : options.from;
    if (operation === 'convert' && from === 'text') input = input.replace(/\[([A-Z0-9]+)\]/g, (token, value) => value === 'DEL' ? '\x7f' : names.includes(value) ? String.fromCharCode(names.indexOf(value)) : token);
    const bases = { binary: 2, octal: 8, decimal: 10, hex: 16 };
    const codes = from === 'text' ? Array.from(input, char => char.codePointAt(0)) : input.trim() ? input.trim().split(/\s+/).map(part => {
      if (!({ binary: /^[01]+$/, octal: /^[0-7]+$/, decimal: /^\d+$/, hex: /^[\da-f]+$/i })[from].test(part)) throw new Error('数值不符合输入进制');
      return parseInt(part, bases[from]);
    }) : [];
    if (codes.some(code => code > 127)) throw new Error('ASCII 数值必须在 0–127');
    const result = { text: codes.map(code => operation === 'convert' && name(code) && ![9, 10, 13, 32].includes(code) ? '[' + name(code) + ']' : String.fromCharCode(code)).join(''), ...Object.fromEntries(Object.entries(bases).map(([key, base]) => [key, codes.map(code => key === 'binary' ? code.toString(2).padStart(8, '0') : key === 'hex' ? code.toString(16).toUpperCase() : code.toString(base)).join(' ')])) };
    return operation === 'encode' ? result.decimal : operation === 'decode' ? result.text : result;
  };
  H.text = (input, operation, options) => {
    const lines = input.split(/\r?\n/);
    if (operation === 'processLines') {
      const output = options.duplicates === 'remove' ? [...new Set(lines)] : lines;
      if (options.sortMode !== 'original') {
        const numeric = options.sortMode.startsWith('numeric'), direction = options.sortMode.endsWith('Desc') ? -1 : 1;
        output.sort((a, b) => {
          const left = a.trim() ? Number(a) : NaN, right = b.trim() ? Number(b) : NaN;
          const difference = numeric && Number.isFinite(left) && Number.isFinite(right) ? left - right : numeric && Number.isFinite(left) !== Number.isFinite(right) ? Number.isFinite(left) ? -1 : 1 : a.localeCompare(b, 'en', { numeric });
          return difference * direction;
        });
      }
      return output.join('\n');
    }
    if (operation === 'transform') {
      const action = options.transformation;
      if (action === 'upperLineStart' || action === 'lowerLineStart') return lines.map(line => line ? line[0][action === 'upperLineStart' ? 'toUpperCase' : 'toLowerCase']() + line.slice(1) : '').join('\n');
      if (action === 'upperWordStart' || action === 'lowerWordStart') return input.replace(/\b\w/g, char => char[action === 'upperWordStart' ? 'toUpperCase' : 'toLowerCase']());
      if (action === 'addLineNumbers') return lines.map((line, index) => index + 1 + '. ' + line).join('\n');
      if (action === 'removeLineNumbers') return input.replace(/^\s*\d+\.?/gm, '');
      if (action === 'reverseLines') return lines.reverse().join('\n');
      if (action === 'reverseEachLine') return lines.map(line => Array.from(line).reverse().join('')).join('\n');
      if (action === 'removeBreaks') return input.replace(/[\r\n]/g, '');
      if (action === 'escape' || action === 'unescape') {
        if (!options.escapeCharacters) return H.backslash(input, action);
        const characters = { backslash: '\\', singleQuote: "'", doubleQuote: '"', newLine: '\n', carriageReturn: '\r', tab: '\t', verticalTab: '\v', backspace: '\b', formFeed: '\f' };
        const escaped = { backslash: '\\\\', singleQuote: "\\'", doubleQuote: '\\"', newLine: '\\n', carriageReturn: '\\r', tab: '\\t', verticalTab: '\\v', backspace: '\\b', formFeed: '\\f' }, selected = U.json(options.escapeCharacters);
        if (!Array.isArray(selected) || selected.some(key => typeof key !== 'string' || !Object.hasOwn(characters, key))) throw new Error('转义字符名称无效');
        const pairs = new Map(selected.map(key => action === 'escape' ? [characters[key], escaped[key]] : [escaped[key], characters[key]]));
        return input.replace(action === 'escape' ? /[\\'"\n\r\t\v\b\f]/g : /\\[\\'"nrtvbf]/g, token => pairs.get(token) ?? token);
      }
      if (action === 'replace') {
        if (options.regular) return H.regex(input, 'replace', { expression: options.search, flags: 'g', replacement: options.replacement });
        const replacements = options.replacement.split('\n'); return options.search.split('\n').reduce((value, search, index) => search ? value.split(search).join(replacements[index] || '') : value, input);
      }
      const zh = ['“', '”', '‘', '’', '。', '，', '；', '：', '？', '！', '……', '—', '～', '（', '）', '《', '》'], en = ['"', '"', "'", "'", '.', ',', ';', ':', '?', '!', '…', '-', '~', '(', ')', '<', '>'];
      return (action === 'punctuationZh' ? en : zh).reduce((value, search, index) => value.split(search).join((action === 'punctuationZh' ? zh : en)[index]), input);
    }
    if (operation === 'statistics') {
      const count = pattern => (input.match(pattern) || []).length;
      const chineseCharacters = count(/[\u4e00-\u9fa5]/g), chinesePunctuation = count(/[。？！、，；：“”‘’（）《》〈〉【】『』「」﹃﹄〔〕…—～﹏￥]/g), digits = count(/[0-9]/g), numbers = count(/\b\d+\b/g), englishLetters = count(/[A-Za-z]/g), englishWords = count(/\b\w+\b/g) - numbers, englishPunctuation = count(/[~`!@#$%^&*()\-_+=|\\[\]{};:"',<.>/?]/g);
      const gbkEstimatedBytes = input.split('').reduce((size, char) => size + (char.charCodeAt(0) <= 128 ? 1 : 2), 0);
      return { characters: Array.from(input).length, utf16Units: input.length, utf8Bytes: U.encoder.encode(input).length, lines: input ? lines.length : 0, words: Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(input)).filter(item => item.isWordLike).length,
        contentCharacters: input.replace(/\r?\n/g, '').length, chineseCharacters, chinesePunctuation, englishLetters, englishWords, englishPunctuation, digits, numbers, gbkEstimatedBytes, wordCount: chineseCharacters + chinesePunctuation + englishWords + englishPunctuation + numbers };
    }
    if (operation === 'upper') return input.toUpperCase(); if (operation === 'lower') return input.toLowerCase();
    if (operation === 'trim') return lines.map(line => line.trim()).join('\n');
    if (operation === 'reverse') return Array.from(input).reverse().join('');
    if (operation === 'dedupe') return [...new Set(lines)].join('\n');
    if (operation === 'removeEmpty') return lines.filter(line => line.trim()).join('\n');
    return lines.sort((a, b) => a.localeCompare(b, 'zh-CN') * (options.descending ? -1 : 1)).join('\n');
  };
  H.variableConversion = (input, operation) => input.split(/\r?\n/).map(line => {
    if (operation === 'upper') return line.toUpperCase();
    if (operation === 'lower') return line.toLowerCase();
    if (operation === 'swap') return Array.from(line, char => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join('');
    const words = line.replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2').replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2').split(/[\s_.:/\\-]+/u).filter(Boolean).map(word => word.toLowerCase());
    const capitalize = word => { const [first, ...rest] = Array.from(word); return first.toUpperCase() + rest.join(''); };
    if (operation === 'dot' || operation === 'path') return words.join(operation === 'dot' ? '.' : '/');
    if (operation === 'title' || operation === 'train') return words.map(capitalize).join(operation === 'title' ? ' ' : '-');
    if (operation === 'sentence') return words.map((word, i) => i ? word : capitalize(word)).join(' ');
    if (operation === 'snake' || operation === 'constant') return words.join('_')[operation === 'constant' ? 'toUpperCase' : 'toString']();
    if (operation === 'kebab' || operation === 'words') return words.join(operation === 'kebab' ? '-' : ' ');
    return words.map((word, index) => operation === 'pascal' || index ? capitalize(word) : word).join('');
  }).join('\n');
  H.regex = (input, operation, options) => {
    const regex = new RegExp(options.expression, options.flags);
    if (operation === 'replace') return input.replace(regex, options.replacement);
    if (operation === 'split') return input.split(regex);
    const matches = []; let match;
    while ((match = regex.exec(input))) {
      matches.push({ value: match[0], index: match.index, groups: match.slice(1).map(value => value === undefined ? null : value), namedGroups: match.groups || null });
      if (!regex.global || matches.length >= 10000) break;
      if (match[0] === '') regex.lastIndex += regex.unicode && input.codePointAt(regex.lastIndex) > 65535 ? 2 : 1;
    }
    if (matches.length >= 10000) throw new Error('匹配数量达到 10000，请缩小输入');
    if (operation === 'inspect') {
      const template = options.template ?? '$0\\n';
      const output = matches.map(match => template.replace(/\\([nrt\\])|\$(\d{1,2})|\$<([^>]+)>|\$\$/g, (token, escape, index, name) => {
        if (escape) return { n: '\n', r: '\r', t: '\t', '\\': '\\' }[escape];
        if (index !== undefined) return Number(index) === 0 ? match.value : match.groups[Number(index) - 1] ?? '';
        return name !== undefined ? match.namedGroups?.[name] ?? '' : '$';
      })).join('');
      return { matches, output };
    }
    return matches;
  };
  H.time = (input, operation, options) => {
    const zone = options.zone, sourceZone = options.sourceZone || zone;
    const parts = (date, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(item => item.type !== 'literal').map(item => [item.type, Number(item.value)]));
    const utc = p => { const date = new Date(0); date.setUTCFullYear(p.year, p.month - 1, p.day); date.setUTCHours(p.hour || 0, p.minute || 0, p.second || 0, p.ms || 0); return date.getTime(); };
    const local = (p, timeZone) => {
      const target = utc(p); let instant = target;
      for (let index = 0; index < 5; index++) {
        const delta = target - utc({ ...parts(new Date(instant), timeZone), ms: p.ms || 0 });
        if (!delta) return new Date(instant);
        instant += delta;
      }
      throw new Error('该当地时间不存在，请检查夏令时或日期');
    };
    const parse = text => {
      const raw = text.trim();
      if (!options.sourceZone || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return U.date(raw);
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(raw);
      if (!match) throw new Error('请输入 YYYY-MM-DD HH:mm:ss 或带时区的 ISO 日期');
      const p = { year: +match[1], month: +match[2], day: +match[3], hour: +(match[4] || 0), minute: +(match[5] || 0), second: +(match[6] || 0), ms: +(match[7] || '').padEnd(3, '0') };
      const check = new Date(utc(p));
      if (check.getUTCFullYear() !== p.year || check.getUTCMonth() + 1 !== p.month || check.getUTCDate() !== p.day || p.hour > 23 || p.minute > 59 || p.second > 59) throw new Error('日期或时间超出范围');
      return local(p, sourceZone);
    };
    const formatted = (date, timeZone = zone) => {
      const p = parts(date, timeZone), pad = value => String(value).padStart(2, '0');
      return p.year + '-' + pad(p.month) + '-' + pad(p.day) + ' ' + pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second);
    };
    let zoneIds;
    if (operation === 'zones' || operation === 'timezone' && zone === 'all') {
      if (!U.timezoneNames) importScripts('timezone-names.js');
      zoneIds = [...new Set([...Object.keys(U.timezoneNames), ...Intl.supportedValuesOf('timeZone'), 'UTC', operation === 'zones' ? zone : sourceZone])];
    }
    if (operation === 'zones') {
      const now = new Date(), atUTC = utc(parts(now, 'UTC'));
      return zoneIds.flatMap(value => {
        try {
          const offset = (utc(parts(now, value)) - atUTC) / 60000, minutes = Math.abs(offset);
          const canonical = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
          const name = U.timezoneNames[value] || U.timezoneNames[canonical] || (canonical === 'UTC' ? U.timezoneNames['Etc/UTC'] : '');
          return [{ value, label: 'UTC' + (offset < 0 ? '-' : '+') + String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0') + ' ' + value + (name ? ' - ' + name : '') }];
        } catch { return []; }
      }).sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    }
    const magnitude = /^[+-]?(\d+)(?:\.\d+)?(?:e([+-]?\d+))?$/i.exec(input.trim()), digits = magnitude ? magnitude[1].length + Number(magnitude[2] || 0) : 0;
    const autoUnit = digits >= 17 ? 'nanoseconds' : digits >= 13 ? 'milliseconds' : 'seconds', unit = options.unit === 'auto' ? autoUnit : options.unit;
    const numeric = operation === 'timestamp' && /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(input.trim());
    let date, nanoseconds;
    if (operation === 'now') { date = new Date(); nanoseconds = BigInt(date.getTime()) * 1000000n; }
    else if (numeric) {
      const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(input.trim()), fraction = match[3] || '', shift = Number(match[4] || 0) + (unit === 'seconds' ? 9 : unit === 'milliseconds' ? 6 : 0) - fraction.length;
      if (Math.abs(shift) > 65536) throw new Error('时间戳超出范围');
      const digits = BigInt(match[2] + fraction);
      nanoseconds = (match[1] === '-' ? -1n : 1n) * (shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift));
      date = new Date(Number(nanoseconds >= 0 ? nanoseconds / 1000000n : (nanoseconds - 999999n) / 1000000n));
    } else {
      const fraction = /\.(\d{1,9})(?=Z|[+-]\d\d:\d\d|$)/i.exec(input.trim());
      date = parse(fraction ? input.replace(fraction[0], '.' + fraction[1].slice(0, 3)) : input);
      nanoseconds = BigInt(date.getTime()) * 1000000n + BigInt(fraction ? fraction[1].padEnd(9, '0').slice(3) : 0);
    }
    if (!Number.isFinite(date.getTime())) throw new Error('日期超出范围');
    if (['now', 'timestamp'].includes(operation)) {
      const localDate = formatted(date), fraction = ((nanoseconds % 1000000000n + 1000000000n) % 1000000000n).toString().padStart(9, '0');
      return { iso: date.toISOString(), formatted: localDate, formattedMilliseconds: localDate + '.' + fraction.slice(0, 3), timestamp: unit === 'nanoseconds' ? nanoseconds.toString() : date.getTime() / (unit === 'seconds' ? 1000 : 1), seconds: date.getTime() / 1000, milliseconds: date.getTime(), nanoseconds: nanoseconds.toString(), numeric, autoUnit, display: numeric ? { seconds: localDate, milliseconds: localDate + '.' + fraction.slice(0, 3), nanoseconds: localDate + '.' + fraction } : { seconds: String(Math.floor(date.getTime() / 1000)), milliseconds: String(date.getTime()), nanoseconds: nanoseconds.toString() } };
    }
    if (operation === 'timezone') {
      const fraction = /\.\d+/.test(input) ? '.' + String(date.getUTCMilliseconds()).padStart(3, '0') : '';
      if (zone === 'all') return Object.fromEntries(zoneIds.flatMap(timeZone => {
        try { return [[timeZone, formatted(date, timeZone) + fraction]]; } catch { return []; }
      }));
      return { iso: date.toISOString(), zone, formatted: formatted(date) + fraction };
    }
    const calendarAdd = (base, amount, interval) => {
      if (!['months', 'years'].includes(interval)) return new Date(base.getTime() + amount * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 }[interval]);
      const p = parts(base, sourceZone), wall = new Date(utc({ ...p, ms: base.getUTCMilliseconds() }));
      wall.setUTCDate(1); wall.setUTCMonth(wall.getUTCMonth() + amount * (interval === 'years' ? 12 : 1));
      const end = new Date(wall); end.setUTCMonth(end.getUTCMonth() + 1, 0);
      wall.setUTCDate(Math.min(p.day, end.getUTCDate()));
      return local({ year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), second: wall.getUTCSeconds(), ms: wall.getUTCMilliseconds() }, sourceZone);
    };
    if (operation === 'difference') {
      const other = parse(options.other), ms = other.getTime() - date.getTime(), a = parts(date, sourceZone), b = parts(other, sourceZone);
      let months = (b.year - a.year) * 12 + b.month - a.month;
      const anchor = calendarAdd(date, months, 'months');
      if (ms >= 0 && anchor > other) months--; else if (ms < 0 && anchor < other) months++;
      const result = { milliseconds: ms, seconds: ms / 1000, minutes: ms / 60000, hours: ms / 3600000, days: ms / 86400000, weeks: ms / 604800000, months, years: Math.trunc(months / 12) };
      return { ...result, value: Math.trunc(result[options.interval]) };
    }
    if (operation === 'analyze') {
      const p = parts(date, sourceZone), month = options.period === 'year' ? 1 : options.period === 'quarter' ? Math.floor((p.month - 1) / 3) * 3 + 1 : p.month;
      const start = local({ year: p.year, month, day: 1 }, sourceZone), end = calendarAdd(start, { year: 12, quarter: 3, month: 1 }[options.period], 'months');
      const seconds = Math.floor((date.getTime() - start.getTime()) / 1000), quarter = Math.ceil(p.month / 3), elapsedDays = Math.floor((utc(parts(date, sourceZone)) - utc(parts(start, sourceZone))) / 86400000);
      const thursday = new Date(utc({ year: p.year, month: p.month, day: p.day })); thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
      const week = options.period === 'year' ? Math.ceil(((thursday.getTime() - utc({ year: thursday.getUTCFullYear(), month: 1, day: 1 })) / 86400000 + 1) / 7) : Math.ceil(seconds / 604800);
      const description = (options.period === 'year' ? p.year + '年:' + quarter + '季度,' : options.period === 'quarter' ? quarter + '季度:' : p.month + '月:') + week + '周,' + (options.period === 'month' ? '' : (options.period === 'year' ? elapsedDays + 1 : Math.ceil(seconds / 86400)) + '天,') + Math.ceil(seconds / 3600) + '小时,' + Math.ceil(seconds / 60) + '分钟,' + seconds + '秒';
      return { start: start.toISOString(), end: new Date(end.getTime() - 1).toISOString(), days: Math.round((utc(parts(end, sourceZone)) - utc(parts(start, sourceZone))) / 86400000), elapsedDays, description };
    }
    return calendarAdd(date, options.amount, options.interval).toISOString();
  };
  H.ipcalc = (input, operation, options) => {
    const parts = input.trim().split('/'); if (parts.length !== 2) throw new Error('请输入 CIDR 地址，例如 192.168.1.10/24 或 2001:db8::1/64');
    const width = operation === 'ipv4' ? 32 : 128; let prefix;
    let address;
    const ipv4 = value => {
      if (/^\d+$/.test(value)) { const number = BigInt(value); if (number > 0xffffffffn) throw new Error('IPv4 整数超出范围'); return number; }
      const groups = value.split('.').map(part => /^0x[\da-f]+$/i.test(part) || /^0b[01]+$/i.test(part) ? Number(part) : /^0[0-7]{3}$/.test(part) ? parseInt(part, 8) : /^\d{1,3}$/.test(part) ? Number(part) : NaN);
      if (groups.length !== 4 || groups.some(part => !Number.isInteger(part) || part > 255)) throw new Error('IPv4 格式错误');
      return groups.reduce((result, part) => result * 256n + BigInt(part), 0n);
    };
    if (width === 32 && options.maskHosts) prefix = 32 - Math.ceil(Math.log2(options.maskHosts + 2));
    else if (width === 32 && (parts[1].includes('.') || /^\d+$/.test(parts[1]) && Number(parts[1]) > 32)) { const mask = ipv4(parts[1]).toString(2).padStart(32, '0'); if (!/^1*0*$/.test(mask)) throw new Error('掩码必须是连续的 1'); prefix = mask.indexOf('0') < 0 ? 32 : mask.indexOf('0'); }
    else { if (!/^\d+$/.test(parts[1])) throw new Error('前缀长度需要整数'); prefix = Number(parts[1]); }
    if (prefix > width) throw new Error('前缀长度超出范围');
    if (width === 32) address = ipv4(parts[0]);
    else {
      let value = parts[0].toLowerCase();
      if (value.includes('.')) { const index = value.lastIndexOf(':'); const tail = ipv4(value.slice(index + 1)); value = value.slice(0, index + 1) + (tail >> 16n).toString(16) + ':' + (tail & 65535n).toString(16); }
      const halves = value.split('::'); if (halves.length > 2) throw new Error('IPv6 格式错误');
      const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) throw new Error('IPv6 组数错误');
      const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
      if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) throw new Error('IPv6 格式错误');
      address = groups.reduce((result, part) => result * 65536n + BigInt('0x' + part), 0n);
    }
    const hostBits = BigInt(width - prefix), size = 1n << hostBits, mask = ((1n << BigInt(width)) - 1n) ^ (size - 1n), network = address & mask, last = network + size - 1n;
    const format = value => width === 32 ? [24n, 16n, 8n, 0n].map(shift => String(value >> shift & 255n)).join('.') : Array.from({ length: 8 }, (_, index) => (value >> BigInt((7 - index) * 16) & 65535n).toString(16)).join(':');
    const result = { address: format(address), prefix, network: format(network), lastAddress: format(last), mask: format(mask), totalAddresses: size.toString(), ...(width === 32 ? { broadcast: prefix < 31 ? format(last) : null, firstHost: format(prefix < 31 ? network + 1n : network), lastHost: format(prefix < 31 ? last - 1n : last), usableHosts: (prefix < 31 ? size - 2n : size).toString() } : {}) };
    if (width === 32) {
      const representation = value => ({ decimal: value.toString(), octal: format(value).split('.').map(part => '0' + Number(part).toString(8).padStart(3, '0')).join('.'), hex: format(value).split('.').map(part => '0x' + Number(part).toString(16).padStart(2, '0').toUpperCase()).join('.'), binary: format(value).split('.').map(part => '0b' + Number(part).toString(2).padStart(8, '0')).join('.') });
      result.addressFormats = representation(address); result.maskFormats = representation(mask); result.hostMask = format(size - 1n);
      if (options.subnets) {
        const count = BigInt(result.usableHosts), first = prefix < 31 ? network + 1n : network;
        result.subnets = Array.from({ length: Number(count < BigInt(options.limit) ? count : BigInt(options.limit)) }, (_, index) => format(first + BigInt(index)));
        result.truncated = count > BigInt(options.limit);
      }
    }
    if (width === 128) {
      const short = value => {
        const groups = format(value).split(':'); let start = -1, length = 1;
        for (let i = 0; i < 8;) { if (groups[i] !== '0') { i++; continue; } const begin = i; while (groups[i] === '0') i++; if (i - begin > length) { start = begin; length = i - begin; } }
        return start < 0 ? groups.join(':') : groups.slice(0, start).join(':') + '::' + groups.slice(start + length).join(':');
      };
      result.full = format(address).split(':').map(group => group.padStart(4, '0')).join(':'); result.short = short(address);
      result.subnetCount = options.targetPrefix >= prefix ? (1n << BigInt(options.targetPrefix - prefix)).toString() : '0';
      if (options.ptrPrefix % 4) throw new Error('PTR 前缀必须是 4 的倍数');
      result.ptr = address.toString(16).padStart(32, '0').slice(0, options.ptrPrefix / 4).split('').reverse().join('.') + (options.ptrPrefix ? '.' : '') + 'ip6.arpa';
      if (options.abbreviated) { result.network = short(network); result.lastAddress = short(last); }
      if (options.subnets) {
        if (options.targetPrefix < prefix) throw new Error('子网前缀不能小于网络前缀');
        const count = 1n << BigInt(options.targetPrefix - prefix), step = 1n << BigInt(128 - options.targetPrefix), length = Number(count < BigInt(options.limit) ? count : BigInt(options.limit));
        result.subnets = Array.from({ length }, (_, index) => {
          let position = BigInt(index);
          if (options.random) { position = 0n; for (const byte of crypto.getRandomValues(new Uint8Array(16))) position = position * 256n + BigInt(byte); position %= count; }
          const value = network + position * step; return (options.abbreviated ? short(value) : format(value)) + '/' + options.targetPrefix;
        });
      }
    }
    return result;
  };
  H.asn1 = (input, _operation, options) => {
    const bytes = options.encoding === 'hex' ? U.unhex(input) : U.unbase64(options.encoding === 'pem' ? input.replace(/-----[^-]+-----/g, '') : input);
    let count = 0;
    function parse(start, end, depth, indefinite = false) {
      if (depth > 64) throw new Error('ASN.1 嵌套超过 64 层');
      const result = []; let offset = start;
      while (offset < end) {
        if (++count > 10000 || end - offset < 2) throw new Error('ASN.1 数据不完整或节点过多');
        if (bytes[offset] === 0 && bytes[offset + 1] === 0) {
          if (!indefinite) throw new Error('ASN.1 意外的结束标记');
          return { nodes: result, offset: offset + 2, contentEnd: offset };
        }
        const begin = offset, tag = bytes[offset++]; let tagNumber = tag & 31;
        if (tagNumber === 31) { tagNumber = 0; let octets = 0; do { if (offset >= end || ++octets > 5) throw new Error('ASN.1 标签无效'); const b = bytes[offset++]; tagNumber = tagNumber * 128 + (b & 127); if (!(b & 128)) break; } while (true); }
        if (offset >= end) throw new Error('ASN.1 缺少长度');
        let length = bytes[offset++];
        if (length === 128) {
          if (!(tag & 32)) throw new Error('ASN.1 不定长度只能用于构造类型');
          const child = parse(offset, end, depth + 1, true);
          result.push({ offset: begin, tagClass: tag >> 6, tag: tagNumber, constructed: true, indefinite: true,
            length: child.contentEnd - offset, hex: U.hex(bytes.subarray(offset, child.contentEnd)), children: child.nodes });
          offset = child.offset; continue;
        }
        if (length & 128) { const size = length & 127; if (size > 4 || !size || offset + size > end) throw new Error('ASN.1 长度无效'); length = 0; for (let i = 0; i < size; i++) length = length * 256 + bytes[offset++]; }
        if (offset + length > end) throw new Error('ASN.1 内容长度超出输入');
        const data = bytes.subarray(offset, offset + length), item = { offset: begin, tagClass: tag >> 6, tag: tagNumber, constructed: !!(tag & 32), length, hex: U.hex(data) };
        if (tag & 32) item.children = parse(offset, offset + length, depth + 1).nodes;
        else if ((tag >> 6) === 0 && [12, 19, 20, 22, 23, 24].includes(tagNumber)) { try { item.text = U.decoder.decode(data); } catch (_) {} }
        else if ((tag >> 6) === 0 && tagNumber === 30) item.text = new TextDecoder('utf-16be', { fatal: true }).decode(data);
        else if ((tag >> 6) === 0 && tagNumber === 1 && length === 1) item.value = data[0] !== 0;
        else if ((tag >> 6) === 0 && [2, 10].includes(tagNumber) && length) {
          let number = BigInt('0x' + U.hex(data)); if (data[0] & 128) number -= 1n << BigInt(length * 8); item.decimal = number.toString();
        } else if ((tag >> 6) === 0 && tagNumber === 6 && length) {
          const components = []; let component = 0n;
          for (const byte of data) { component = component * 128n + BigInt(byte & 127); if (!(byte & 128)) { components.push(component); component = 0n; } }
          if (data[data.length - 1] & 128) throw new Error('OID 编码不完整');
          const first = components.shift(), arc = first < 40n ? 0n : first < 80n ? 1n : 2n;
          item.oid = [arc, first - arc * 40n, ...components].join('.');
        }
        result.push(item); offset += length;
      }
      if (indefinite) throw new Error('ASN.1 不定长度缺少结束标记');
      return { nodes: result, offset };
    }
    const nodes = parse(0, bytes.length, 0).nodes;
    if (options.outputFormat !== 'xml') return nodes;
    const tags = { 1: 'BOOLEAN', 2: 'INTEGER', 3: 'BIT_STRING', 4: 'OCTET_STRING', 5: 'NULL', 6: 'OBJECT_IDENTIFIER', 10: 'ENUMERATED', 12: 'UTF8String', 16: 'SEQUENCE', 17: 'SET', 19: 'PrintableString', 20: 'TeletexString', 22: 'IA5String', 23: 'UTCTime', 24: 'GeneralizedTime', 30: 'BMPString' };
    const xml = (node, depth) => {
      const tag = node.tagClass === 0 ? tags[node.tag] || 'NODE' : 'NODE', indent = '  '.repeat(depth), attributes = tag === 'NODE' ? ' Sign="a' + node.tag + '"' : '';
      const content = node.children ? '\n' + node.children.map(child => xml(child, depth + 1)).join('\n') + '\n' + indent : U.escapeXml(node.text ?? node.oid ?? node.value ?? (node.tag === 5 ? '' : node.decimal || '0x' + node.hex));
      return indent + '<' + tag + attributes + '>' + content + '</' + tag + '>';
    };
    return nodes.map(node => xml(node, 0)).join('\n');
  };
})(OfflineTools);
