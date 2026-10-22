// Shared offline SDK operations for the developer utilities application.
(function () {
  'use strict';
  const U = OfflineTools, H = U.handlers;
  H.randomRecipe = async (_input, _operation, options) => {
    let state = 0;
    if (options.seed) state = new DataView(await crypto.subtle.digest('SHA-256', U.encoder.encode(options.seed))).getUint32(0, true);
    const random = () => {
      if (!options.seed) return crypto.getRandomValues(new Uint32Array(1))[0];
      state = (state + 0x6d2b79f5) | 0; let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return (value ^ value >>> 14) >>> 0;
    };
    const index = size => { const limit = Math.floor(4294967296 / size) * size; let value; do { value = random(); } while (value >= limit); return value % size; };
    const groups = { upper: Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), lower: Array.from('abcdefghijklmnopqrstuvwxyz'), digits: Array.from('0123456789'), symbols: Array.from('!@#$%^&*()[]{}<>?/+-_=~:;.,'), custom: [...new Set(Array.from(options.alphabet))], words: 'amber apple autumn blue brook cedar cloud coral dawn delta dream earth fern field forest frost green harbor hill island lake leaf light maple moon ocean pine rain river silver sky snow spring star stone summer sun tree valley wave wind winter wood'.split(' ') };
    if (options.custom && !groups.custom.length) throw new Error('请填写自定义字符集');
    return Array.from({ length: options.count }, () => {
      const parts = [];
      for (const [name, alphabet] of Object.entries(groups)) for (let i = 0; i < options[name]; i++) parts.push(alphabet[index(alphabet.length)]);
      for (let i = parts.length - 1; i > 0; i--) { const j = index(i + 1); [parts[i], parts[j]] = [parts[j], parts[i]]; }
      if (!options.groupSize) return parts.join(options.separator);
      const chars = Array.from(parts.join('')), chunks = []; for (let i = 0; i < chars.length; i += options.groupSize) chunks.push(chars.slice(i, i + options.groupSize).join('')); return chunks.join(options.separator);
    }).join('\n');
  };
  H.markdown = input => {
    if (!self.marked) importScripts('../dependencies/marked/marked.min.js');
    return marked.parse(input, { gfm: true, async: false });
  };
  const crontab = H.crontab;
  const color = H.color;
  H.color = (input, operation, options) => {
    const value = color(input, operation, options); if (operation !== 'inspect') return value;
    const { r, g, b, alpha } = value, hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join(''), a = Math.round(alpha * 255), normalized = [r, g, b].map(n => Number((n / 255).toFixed(4)));
    const hsv = JSON.parse(value.hsv), formats = { Hex: hex, 'Hex with alpha': hex + a.toString(16).padStart(2, '0'), RGB: 'rgb(' + [r, g, b].join(', ') + ')', RGBA: value.rgb, HSL: value.hsl.replace('hsla(', 'hsl(').replace(/, [^,]+\)$/, ')'), HSLA: value.hsl, 'HSB (HSV)': 'hsb(' + hsv.h + ', ' + hsv.s + '%, ' + hsv.v + '%)', HWB: value.hwb, CMYK: value.cmyk };
    const variables = { r, g, b, alpha, alphaByte: a, red: normalized[0], green: normalized[1], blue: normalized[2], hue: hsv.h, saturation: hsv.s, brightness: hsv.v, hueUnit: hsv.h / 360, saturationUnit: hsv.s / 100, brightnessUnit: hsv.v / 100, hex, hexa: formats['Hex with alpha'], hsl: formats.HSL, hsla: value.hsl, hslComponents: formats.HSL.slice(4, -1).replace(/,\s*/g, ' ') };
    const templateSource = {
      'CSS': 'color: {{hex}};\ncolor: {{hexa}};\ncolor: rgb({{r}}, {{g}}, {{b}});\ncolor: rgba({{r}}, {{g}}, {{b}}, {{alpha}});\ncolor: {{hsl}};\ncolor: {{hsla}};',
      'CSS Level 4': 'color: rgb({{r}} {{g}} {{b}});\ncolor: rgb({{r}} {{g}} {{b}} / {{alpha}});\ncolor: hsl({{hslComponents}});\ncolor: hsl({{hslComponents}} / {{alpha}});',
      'Swift': 'NSColor(calibratedRed: {{red}}, green: {{green}}, blue: {{blue}}, alpha: {{alpha}})\nNSColor(calibratedHue: {{hueUnit}}, saturation: {{saturationUnit}}, brightness: {{brightnessUnit}}, alpha: {{alpha}})\nUIColor(red: {{red}}, green: {{green}}, blue: {{blue}}, alpha: {{alpha}})\nUIColor(hue: {{hueUnit}}, saturation: {{saturationUnit}}, brightness: {{brightnessUnit}}, alpha: {{alpha}})',
      '.NET': 'Color.FromArgb({{r}}, {{g}}, {{b}})\nColor.FromArgb({{alphaByte}}, {{r}}, {{g}}, {{b}})',
      'Java': 'new Color({{r}}, {{g}}, {{b}})\nnew Color({{r}}, {{g}}, {{b}}, {{alphaByte}})',
      'Android': 'Color.rgb({{r}}, {{g}}, {{b}})\nColor.argb({{alphaByte}}, {{r}}, {{g}}, {{b}})'
    };
    const templates = Object.fromEntries(Object.entries(templateSource).map(([name, source]) => [name, source.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key])]));
    return { ...value, formats, templates, templateSource, variables };
  };
  H.crontab = (input, operation, options) => {
    if (operation !== 'inspect') return crontab(input, operation, options);
    const next = crontab(input, 'next', options), description = crontab(input, 'describe', options);
    const parts = input.trim().split(/\s+/), definitions = [['分钟', 0, 59], ['小时', 0, 23], ['日', 1, 31], ['月', 1, 12], ['星期', 0, 7]];
    if (parts.length === 6) definitions.unshift(['秒', 0, 59]);
    const fields = definitions.map(([name, min, max], index) => {
      const part = parts[index] || '';
      if (part === '*' || part === '?') return [name, '全部'];
      const values = new Set();
      for (const token of part.split(',')) {
        const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(token);
        if (!match) return [name, part];
        const start = match[1] === '*' ? min : Number(match[1]), end = match[2] ? Number(match[2]) : match[1] === '*' || match[3] ? max : start, step = Number(match[3] || 1);
        if (step < 1 || start < min || end > max || start > end) throw new Error('Cron 字段范围错误');
        for (let value = start; value <= end; value += step) values.add(value);
      }
      return [name, [...values].sort((a, b) => a - b).map(value => String(value).padStart(2, '0')).join('、')];
    });
    return { expression: input.trim(), description, fields: Object.fromEntries(fields), zone: options.zone, next };
  };
  H.stringInspect = (input, _operation, options) => {
    const counts = H.text(input, 'statistics', {}), frequency = new Map();
    for (const item of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(input)) if (item.isWordLike) {
      const word = options.caseSensitive ? item.segment : item.segment.toLowerCase(); frequency.set(word, (frequency.get(word) || 0) + 1);
    }
    const start = Math.min(options.selectionStart, input.length), end = Math.max(start, Math.min(options.selectionEnd, input.length)), selected = input.slice(start, end), prefix = input.slice(0, start);
    const char = selected || (start < input.length ? String.fromCodePoint(input.codePointAt(start)) : ''), point = Array.from(char).length === 1 ? char.codePointAt(0) : null;
    return { counts: { characters: counts.characters, bytes: counts.utf8Bytes, words: counts.words, lines: counts.lines, graphemes: Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input)).length }, selection: { location: start, length: end - start, line: prefix.split('\n').length, column: start - prefix.lastIndexOf('\n'), ascii: point !== null && point < 128 ? point : '—', unicode: point !== null && (selected || start < input.length) ? 'U+' + point.toString(16).toUpperCase().padStart(4, '0') : '—' }, frequency: [...frequency].sort((a, b) => b[1] - a[1]).slice(0, 1000) };
  };
  const lorem = H.loremIpsum;
  H.loremIpsum = (input, operation, options) => {
    const pick = values => values[crypto.getRandomValues(new Uint32Array(1))[0] % values.length];
    const first = () => pick(['Alex', 'Morgan', 'Taylor', 'Casey', 'Jordan', 'Riley']), last = () => pick(['Smith', 'Lee', 'Brown', 'Miller', 'Wilson', 'Clark']);
    const generators = { title: () => 'Lorem Ipsum Dolor Sit Amet', firstName: first, lastName: last, fullName: () => first() + ' ' + last(), email: () => (first() + '.' + last()).toLowerCase() + '@example.com', url: () => 'https://example.com/' + first().toLowerCase(), shortText: () => lorem('', operation, { unit: 'sentences', count: 1 }), longText: () => lorem('', operation, { unit: 'sentences', count: 3 }) };
    const value = Object.hasOwn(generators, options.unit) ? Array.from({ length: options.count }, generators[options.unit]).join('\n') : lorem('', operation, options);
    return options.append && input ? input + '\n\n' + value : value;
  };
  const code = H.code;
  H.code = async (input, operation, options) => {
    if (operation === 'minify' && ['less', 'scss'].includes(options.language)) {
      await code(input, 'format', options);
      return input.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|url\((?:\\[\s\S]|[^)\\])*\)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$)|\\[\s\S]|\s+/gi, token => /^\s+$/.test(token) ? ' ' : token).trim();
    }
    if (options.language === 'erb') {
      const fragments = [], prefix = 'PAGE_AGENT_ERB_' + crypto.randomUUID().replace(/-/g, '') + '_';
      const protectedSource = input.replace(/<%[\s\S]*?%>/g, (fragment, offset) => {
        const marker = prefix + fragments.length, before = input.slice(0, offset), inTag = before.lastIndexOf('<') > before.lastIndexOf('>');
        const token = inTag || /^<%[=%]/.test(fragment) ? marker : '<!--' + marker + '-->';
        fragments.push([token, fragment]); return token;
      });
      if (protectedSource.includes('<%')) throw new Error('ERB 标签未闭合');
      let result = await H.code(protectedSource, operation, { ...options, language: 'html' });
      for (const [marker, fragment] of fragments) result = result.split(marker).join(fragment);
      return result;
    }
    if (operation === 'minify' && ['html', 'xml'].includes(options.language)) {
      if (options.language === 'xml') { U.load('xml'); const valid = fxp.XMLValidator.validate(input); if (valid !== true) throw new Error(valid.err.msg); }
      // Only collapse whitespace inside markup, outside quoted values. Text nodes remain exact.
      return input.replace(/<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/gi, token => {
        if (/^<(?:script|style|pre|textarea)\b|^<!/i.test(token)) return token;
        return token.replace(/"[^"]*"|'[^']*'|\s+/g, part => /^\s/.test(part) ? ' ' : part);
      });
    }
    return code(input, operation, options);
  };
  const uuid = H.uuid;
  H.uuid = async (input, operation, options) => {
    if (operation === 'ulid') return H.ulid(input, 'generate', options);
    if (operation === 'nanoId') return H.randomString('', 'generate', { length: 21, count: options.count, alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-', outputFormat: 'text', delimiter: '\\n' });
    if (operation !== 'inspect') return uuid(input, operation, options);
    const value = input.trim();
    if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(value)) return H.ulid(value, 'decode', options);
    const library = await U.esm('uuid/dist/esm-browser/index.js');
    if (!library.validate(value)) throw new Error('请输入有效 UUID 或 ULID');
    const version = library.version(value), hex = value.replace(/-/g, '').toLowerCase();
    const result = { uuid: value.toLowerCase(), raw: hex.match(/../g).join(':'), version, variant: (parseInt(hex[16], 16) & 12) === 8 ? 'RFC 9562' : 'Reserved' };
    let ms;
    if (version === 7) ms = Number(BigInt('0x' + hex.slice(0, 12)));
    if (version === 1 || version === 6) {
      const ticks = BigInt('0x' + (version === 1 ? hex.slice(13, 16) + hex.slice(8, 12) + hex.slice(0, 8) : hex.slice(0, 12) + hex.slice(13, 16)));
      ms = Number((ticks - 122192928000000000n) / 10000n);
    }
    if (ms !== undefined) result.iso = new Date(ms).toISOString();
    return result;
  };
  const jwt = H.jwt;
  H.jwt = async (input, operation, options) => {
    const value = jwt(input, operation, options);
    value.dates = Object.fromEntries(['iat', 'nbf', 'exp'].filter(key => Number.isFinite(value.payload?.[key]) && Number.isFinite(new Date(value.payload[key] * 1000).getTime())).map(key => [key, new Date(value.payload[key] * 1000).toISOString()]));
    value.signatureVerified = null;
    if (options.secret) {
      if (value.header.alg !== options.algorithm) throw new Error('Token 算法与所选验签算法不一致');
      const key = await crypto.subtle.importKey('raw', U.encoder.encode(options.secret), { name: 'HMAC', hash: 'SHA-' + options.algorithm.slice(2) }, false, ['verify']);
      const parts = input.trim().split('.');
      value.signatureVerified = await crypto.subtle.verify('HMAC', key, U.unbase64(parts[2]), U.encoder.encode(parts[0] + '.' + parts[1]));
    }
    return value;
  };
  const time = H.time;
  H.time = (input, operation, options) => {
    if (operation !== 'inspect') return time(input, operation, options);
    const expression = input.replace(/[×÷−]/g, char => ({ '×': '*', '÷': '/', '−': '-' })[char]);
    if (!/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(input.trim()) && /^[\d\s.+*/()%-]+$/.test(expression) && /[+*/()%]|\d\s*-/.test(expression)) {
      U.load('math');
      const node = math.parse(expression);
      node.traverse(part => {
        if (!part.isConstantNode && !part.isParenthesisNode && !(part.isOperatorNode && ['+', '-', '*', '/', '%'].includes(part.op))) throw new Error('仅支持数值与 + - * / % 运算');
      });
      input = String(node.evaluate());
    }
    const value = time(input, 'timestamp', options), date = new Date(value.iso), zone = options.zone;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date).map(item => [item.type, item.value]));
    const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
    const wall = new Date(0); wall.setUTCFullYear(year, month - 1, day); wall.setUTCHours(0, 0, 0, 0);
    const start = new Date(wall); start.setUTCMonth(0, 1);
    const dayOfYear = Math.floor((wall - start) / 86400000) + 1;
    const thursday = new Date(wall); thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
    const weekStart = new Date(thursday); weekStart.setUTCMonth(0, 1);
    const weekOfYear = Math.ceil(((thursday - weekStart) / 86400000 + 1) / 7);
    const elapsed = (date.getTime() - Date.now()) / 1000, unit = Math.abs(elapsed) < 60 ? 'second' : Math.abs(elapsed) < 3600 ? 'minute' : Math.abs(elapsed) < 86400 ? 'hour' : 'day';
    const format = settings => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, ...settings }).format(date);
    return { ...value, local: format({ dateStyle: 'full', timeStyle: 'long' }), dayOfYear, weekOfYear, leapYear: year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), relative: new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(Math.round(elapsed / { second: 1, minute: 60, hour: 3600, day: 86400 }[unit]), unit),
      formats: { '本地日期': format({ dateStyle: 'long' }), '短日期': format({ dateStyle: 'short' }), 'ISO 日期（本地）': [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-'), '日期与时间': format({ dateStyle: 'short', timeStyle: 'short' }), '月日与时间': format({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }), '月份': format({ year: 'numeric', month: 'long' }), '月日年': [month, day, year].join('/'), '时间': format({ hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false }) }
    };
  };
})();
