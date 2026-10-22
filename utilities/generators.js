(function (U) {
  'use strict';
  const H = U.handlers;
  H.pinyin = (input, _operation, options) => {
    U.load('pinyin');
    const result = input.split('\n').map(line => {
      const parts = []; let literal = '';
      for (const char of line) {
        if (!/[\u4e00-\u9fa5]/.test(char)) { literal += char; continue; }
        if (literal) { parts.push(literal); literal = ''; }
        const readings = [...new Set(pinyinPro.pinyin(char, { toneType: options.toneType, pattern: options.pattern, multiple: true, v: options.replaceV, type: 'array' }))];
        parts.push(readings[0] + (options.multiple && readings.length > 1 ? '(' + readings.slice(1).join(',') + ')' : ''));
      }
      if (literal) parts.push(literal); return parts.join(options.separator);
    }).join('\n');
    return options.uppercase ? result.toUpperCase() : result;
  };
  H.zhNumber = (input, operation, options) => {
    U.load('nzh');
    const converter = options.traditional ? Nzh.hk : Nzh.cn;
    if (operation !== 'convert') return converter[{ lower: 'encodeS', upper: 'encodeB', money: 'toMoney', decode: 'decodeS' }[operation]](input);
    if (options.from === 'money') throw new Error('金额大写仅作为输出');
    const number = options.from === 'number' ? input.replace(/[,\s]/g, '') : converter[options.from === 'upper' ? 'decodeB' : 'decodeS'](input);
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(number)) throw new Error('请输入有效数字');
    return { number, lower: converter.encodeS(number), upper: converter.encodeB(number), money: converter.toMoney(number) };
  };
  const unitGroups = [
    ['length', '长度', 'm', 'km m dm cm mm um nm pm lightyear astronomicalunit inch foot yard mile nauticalmile fathom furlong cnli cnzhang cnchi cncun cnfen cnliSmall cnhao'],
    ['area', '面积', 'm^2', 'km^2 hectare are m^2 dm^2 cm^2 mm^2 acre mile^2 yard^2 foot^2 inch^2 rod^2 cnqing cnmu cnfenArea cnchi^2 cncun^2'],
    ['volume', '体积', 'm^3', 'm^3 dm^3 cm^3 mm^3 l dl ml cl ul hl foot^3 inch^3 yard^3 acrefoot imperialgallon gallon imperialounce floz'],
    ['weight', '质量', 'kg', 'kg g mg ug tonne quintal carat lbm oz grain longton shortton imperialcwt cwt stone dram cndan cnjin cnliang cnqian'],
    ['temperature', '温度', 'K', 'degC degF K degR degRe'],
    ['pressure', '压力', 'Pa', 'Pa kPa hPa atm mmHg inchHg bar mbar psf psi mmH2O kgf/cm^2 kgf/m^2 MPa'],
    ['power', '功率', 'W', 'W kW hp metrichp kgf*m/s kcal/s BTU/s foot*lbf/s J/s N*m/s dBm dBW'],
    ['work', '功 / 能', 'J', 'J kgf*m metrichp*hour hp*hour kWh Wh cal kcal BTU foot*lbf kJ'],
    ['density', '密度', 'kg/m^3', 'kg/cm^3 kg/dm^3 kg/m^3 g/cm^3 g/dm^3 g/m^3'],
    ['strength', '力', 'N', 'N kN kgf gf tf lbf kip dyn'],
    ['time', '时间', 's', 'year week day hour minute s ms us ns'],
    ['speed', '速度', 'm/s', 'm/s km/s km/h lightspeed mach mile/h inch/s'],
    ['byte', '存储', 'byte', 'bit byte kibibyte mebibyte gibibyte tebibyte pebibyte exbibyte'],
    ['angle', '角度', 'deg', 'cycle rightangle grad deg arcmin arcsec rad mrad']
  ].map(([id, label, main, units]) => ({ id, label, main, units: units.split(' ') }));
  H.unit = (input, operation, options) => {
    if (operation === 'groups') return unitGroups;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(input.trim())) throw new Error('输入必须是数值，单位填在选项中');
    U.load('math');
    // Extend the existing mathjs unit registry; conversion still uses its Unit/BigNumber implementation.
    const definitions = { lightyear: '9460730472580800 m', astronomicalunit: '149597870700 m', nauticalmile: '1852 m', fathom: '1.8288 m', furlong: '201.168 m', cnli: '500 m', cnzhang: '3.333333333333333333333333333333333333 m', cnchi: '0.333333333333333333333333333333333333 m', cncun: '0.033333333333333333333333333333333333 m', cnfen: '0.003333333333333333333333333333333333 m', cnliSmall: '0.000333333333333333333333333333333333 m', cnhao: '0.000033333333333333333333333333333333 m', are: '100 m^2', cnqing: '66666.66666666666666666666666666666667 m^2', cnmu: '666.6666666666666666666666666666666667 m^2', cnfenArea: '66.66666666666666666666666666666666667 m^2', acrefoot: '1233.48183754752 m^3', imperialgallon: '4.54609 l', imperialounce: '0.0284130625 l', quintal: '100 kg', carat: '0.2 g', longton: '1016.0469088 kg', shortton: '907.18474 kg', imperialcwt: '50.80234544 kg', stone: '6.35029318 kg', cndan: '50 kg', cnjin: '0.5 kg', cnliang: '0.05 kg', cnqian: '0.005 kg', inchHg: '3386.389 Pa', psf: '47.88025898033584 Pa', kgf: '9.80665 N', gf: '0.00980665 N', tf: '9806.65 N', kip: '4448.2216152605 N', metrichp: '735.49875 W', cal: '4.184 J', kcal: '4184 J', lightspeed: '299792458 m/s', mach: '340.3 m/s', rightangle: '90 deg' };
    for (const [name, definition] of Object.entries(definitions)) if (!math.Unit.isValuelessUnit(name)) math.createUnit(name, definition);
    if (!math.Unit.isValuelessUnit('exbibyte')) math.createUnit('exbibyte', '1152921504606846976 byte');
    if (!math.Unit.isValuelessUnit('degRe')) math.createUnit('degRe', { definition: '1.25 K', offset: 218.52 });
    const logarithmic = unit => unit === 'dBm' || unit === 'dBW';
    const numeric = math.bignumber(input.trim()), value = logarithmic(options.from) ? math.unit(math.multiply(math.pow(math.bignumber(10), math.divide(numeric, 10)), options.from === 'dBm' ? .001 : 1), 'W') : math.unit(numeric, options.from);
    const convert = unit => {
      if (!logarithmic(unit)) return value.to(unit).toString();
      const watts = value.toNumber('W'); if (watts <= 0) return '-Infinity ' + unit;
      return math.multiply(10, math.log10(math.divide(math.bignumber(watts), unit === 'dBm' ? .001 : 1))).toString() + ' ' + unit;
    };
    if (options.to !== 'all') return convert(options.to);
    const group = unitGroups.find(item => item.id === options.group);
    if (!group) throw new Error('未知单位类别');
    return Object.fromEntries(group.units.map(unit => [unit, convert(unit)]));
  };
  H.crontab = (input, operation, options) => {
    if (operation === 'describe') { U.load('cronstrue'); return cronstrue.toString(input, { locale: 'zh_CN', use24HourTimeFormat: true, throwExceptionOnParseError: true }); }
    importScripts('../dependencies/croner/croner.umd.js');
    const CronConstructor = typeof Cron === 'function' ? Cron : Cron.Cron;
    const parts = input.trim().split(/\s+/);
    // Normalize last-weekday syntax for Croner, e.g. 1L to 1#L for the last Monday.
    if (parts.length === 5 || parts.length === 6) parts[parts.length - 1] = parts.at(-1).split(',').map(part => part.replace(/^([0-7])L$/i, '$1#L')).join(',');
    const cron = new CronConstructor(parts.join(' '), { timezone: options.zone, paused: true });
    try { return cron.nextRuns(options.count, options.start ? U.date(options.start) : new Date()).map(date => ({ iso: date.toISOString(), local: new Intl.DateTimeFormat('sv-SE', { timeZone: options.zone, dateStyle: 'short', timeStyle: 'long' }).format(date) })); }
    finally { cron.stop(); }
  };
  const generatedOutput = (values, format) => format === 'text' ? values.join('\n') : H.serialize(JSON.stringify(format === 'toml' ? { values } : format === 'properties' ? Object.fromEntries(values.map((value, index) => [index, value])) : format === 'xml' ? { items: { item: values } } : values), 'convert', { from: 'json', to: format });
  H.uuid = async (input, operation, options) => {
    const uuid = await U.esm('uuid/dist/esm-browser/index.js');
    if (operation === 'validate') { const valid = uuid.validate(input.trim()); return { valid, version: valid ? uuid.version(input.trim()) : null }; }
    const values = operation === 'format' ? input.trim().split(/\r?\n/) : Array.from({ length: options.count }, () => operation === 'v3' || operation === 'v5' ? uuid[operation](input, options.namespace) : uuid[operation]());
    return generatedOutput(values.map(value => {
      if (!uuid.validate(value)) throw new Error('请输入包含连字符的有效 UUID');
      if (options.bytes) return '[' + Array.from(uuid.parse(value)).join(',') + ']';
      const result = options.hyphens ? value : value.replace(/-/g, '');
      return options.uppercase ? result.toUpperCase() : result.toLowerCase();
    }), options.outputFormat);
  };
  H.ulid = (input, operation, options) => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    if (operation === 'format') return generatedOutput(input.trim().split(/\r?\n/).map(value => {
      if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(value)) throw new Error('ULID 格式错误');
      return options.uppercase ? value.toUpperCase() : value.toLowerCase();
    }), options.outputFormat);
    if (operation === 'decode') {
      const value = input.trim().toUpperCase();
      if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) throw new Error('ULID 必须是合法的 26 位 Crockford Base32，首位不大于 7');
      let number = 0n;
      for (const char of value) number = number * 32n + BigInt(alphabet.indexOf(char));
      const timestamp = Number(number >> 80n);
      return { ulid: value, timestamp, iso: new Date(timestamp).toISOString(), random: (number & ((1n << 80n) - 1n)).toString(16).padStart(20, '0') };
    }
    return generatedOutput(Array.from({ length: options.count }, () => {
      let number = BigInt(Date.now());
      for (const byte of crypto.getRandomValues(new Uint8Array(10))) number = number * 256n + BigInt(byte);
      let value = '';
      for (let index = 0; index < 26; index++) { value = alphabet[Number(number & 31n)] + value; number >>= 5n; }
      return options.uppercase ? value : value.toLowerCase();
    }), options.outputFormat);
  };
  H.loremIpsum = (_input, _operation, options) => {
    const sentences = [
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
      'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
      'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
    ];
    const units = options.unit === 'paragraphs' ? [sentences.join(' ')] : options.unit === 'sentences' ? sentences : sentences.join(' ').replace(/[,.]/g, '').split(' ');
    return Array.from({ length: options.count }, (_, index) => units[index % units.length]).join(options.unit === 'paragraphs' ? '\n\n' : ' ');
  };
  H.randomString = (input, operation, options) => {
    const format = values => {
      if (options.outputFormat === 'text') return values.map(value => options.addQuote ? '"' + value + '"' : value).join(options.delimiter.replace(/\\n/g, '\n'));
      if (options.outputFormat === 'xml') return H.serialize(JSON.stringify({ root: { row: values } }), 'convert', { from: 'json', to: 'xml', attributePrefix: options.attributePrefix || '@attribute_' });
      return generatedOutput(values, options.outputFormat);
    };
    if (operation === 'format') {
      const values = options.inputFormat === 'json' ? U.json(input) : input.split('\n');
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('待格式化数据必须是字符串数组');
      return format(values);
    }
    const alphabet = Array.from(options.alphabet);
    if (!alphabet.length) return format(Array(options.count).fill(''));
    const limit = Math.floor(4294967296 / alphabet.length) * alphabet.length, values = new Uint32Array(1024), output = [];
    let cursor = values.length;
    for (let row = 0; row < options.count; row++) {
      let result = '';
      for (let column = 0; column < options.length;) {
        if (cursor === values.length) { crypto.getRandomValues(values); cursor = 0; }
        const value = values[cursor++]; if (value >= limit) continue;
        result += alphabet[value % alphabet.length]; column++;
      }
      output.push(result);
    }
    return format(output);
  };
  H.qrCode = async (input, operation, options) => {
    if (operation === 'generate') {
      if (['hex', 'base64'].includes(options.inputEncoding)) input = U.decoder.decode(U.bytes(input, options.inputEncoding));
      U.load('qr'); const qr = qrcode(0, options.level); qr.addData(input, 'Byte'); qr.make();
      const n = qr.getModuleCount(), size = options.cellSize ? n * options.cellSize + options.margin * 2 : Math.min(2000, Math.max(1, Math.ceil(U.encoder.encode(input).length / 100)) * 300);
      const cell = options.cellSize || Math.floor((size - options.margin * 2) / n), margin = (size - n * cell) / 2, defs = [], drawing = [], paints = {};
      if (cell < 1) throw new Error('外边距过大，二维码没有足够的绘制空间');
      if (options.imageFormat === 'png' && size * size > 4194304) throw new Error('二维码图片最多 400 万像素');
      const canvas = options.imageFormat === 'png' ? new OffscreenCanvas(size, size) : null, context = canvas?.getContext('2d');
      const fill = key => {
        const start = options[key + 'Gradient'] ? options[key + 'Start'] || options[key + 'Color'] : options[key + 'Color'], end = options[key + 'End'];
        if (![start, end].every(value => /^#[0-9a-f]{6}$/i.test(value))) throw new Error('二维码颜色需要 #RRGGBB');
        paints[key] = start;
        if (!options[key + 'Gradient']) return start;
        const radial = options[key + 'GradientType'] === 'radial', tag = radial ? 'radialGradient' : 'linearGradient';
        const angle = options[key + 'Rotation'] * Math.PI / 180, dx = Math.cos(angle) * size / 2, dy = Math.sin(angle) * size / 2;
        if (context) {
          const gradient = radial ? context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2) : context.createLinearGradient(size / 2 - dx, size / 2 - dy, size / 2 + dx, size / 2 + dy);
          gradient.addColorStop(0, start); gradient.addColorStop(1, end); paints[key] = gradient;
        }
        defs.push('<' + tag + ' id="' + key + '" gradientUnits="userSpaceOnUse" ' + (radial ? 'cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + size / 2 + '"' : 'x1="' + (size / 2 - dx) + '" y1="' + (size / 2 - dy) + '" x2="' + (size / 2 + dx) + '" y2="' + (size / 2 + dy) + '"') + '><stop offset="0" stop-color="' + start + '"/><stop offset="1" stop-color="' + end + '"/></' + tag + '>'); return 'url(#' + key + ')';
      };
      const colors = Object.fromEntries(['dots', 'corners', 'center', 'background'].map(key => [key, fill(key)]));
      const corners = [[0, 0], [n - 7, 0], [0, n - 7]];
      const rectPath = (x, y, width, radius) => radius ? 'M' + (x + radius) + ',' + y + 'h' + (width - radius * 2) + 'q' + radius + ',0 ' + radius + ',' + radius + 'v' + (width - radius * 2) + 'q0,' + radius + ' -' + radius + ',' + radius + 'h-' + (width - radius * 2) + 'q-' + radius + ',0 -' + radius + ',-' + radius + 'v-' + (width - radius * 2) + 'q0,-' + radius + ' ' + radius + ',-' + radius + 'z' : 'M' + x + ',' + y + 'h' + width + 'v' + width + 'h-' + width + 'z';
      let image = '', logoSize = 0, path = '', shapes = '';
      if (options.image && options.imageSize) { image = await H.base64Image(options.image, 'decode'); logoSize = n * cell * options.imageSize / 20; }
      const logoStart = (size - logoSize) / 2;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (!qr.isDark(y, x) || corners.some(([cx, cy]) => x >= cx && x < cx + 7 && y >= cy && y < cy + 7)) continue;
        const px = margin + x * cell, py = margin + y * cell;
        if (logoSize && px + cell > logoStart - options.imageMargin && px < logoStart + logoSize + options.imageMargin && py + cell > logoStart - options.imageMargin && py < logoStart + logoSize + options.imageMargin) continue;
        const style = options.dotsStyle, connected = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([cx, cy]) => cx >= 0 && cy >= 0 && cx < n && cy < n && qr.isDark(cy, cx)).length;
        const radius = style === 'square' ? 0 : style === 'dots' ? cell / 2 : connected > 2 ? 0 : style === 'extra-rounded' || style === 'classy-rounded' ? cell / 2 : cell / 4;
        if (style === 'classy' || style === 'classy-rounded') {
          const curve = style === 'classy' ? cell : cell / 2;
          path += 'M' + (px + curve) + ',' + py + 'h' + (cell - curve) + 'v' + (cell - curve) + 'q0,' + curve + ' -' + curve + ',' + curve + 'h-' + (cell - curve) + 'v-' + (cell - curve) + 'q0,-' + curve + ' ' + curve + ',-' + curve + 'z';
        } else path += rectPath(px, py, cell, radius);
      }
      for (const [cx, cy] of corners) {
        const x = margin + cx * cell, y = margin + cy * cell, radius = options.cornersStyle === 'dot' ? cell * 3.5 : options.cornersStyle === 'extra-rounded' ? cell * 2 : 0;
        const border = rectPath(x, y, cell * 7, radius) + rectPath(x + cell, y + cell, cell * 5, Math.max(0, radius - cell));
        const center = rectPath(x + cell * 2, y + cell * 2, cell * 3, options.centerStyle === 'dot' ? cell * 1.5 : 0);
        shapes += '<path fill="' + colors.corners + '" fill-rule="evenodd" d="' + border + '"/><path fill="' + colors.center + '" d="' + center + '"/>';
        drawing.push(['corners', border, 'evenodd'], ['center', center, 'nonzero']);
      }
      if (canvas) {
        context.fillStyle = paints.background; context.fillRect(0, 0, size, size);
        for (const [key, data, rule] of [['dots', path, 'nonzero'], ...drawing]) { context.fillStyle = paints[key]; context.fill(new Path2D(data), rule); }
        if (image) {
          const comma = image.indexOf(','), bitmap = await createImageBitmap(new Blob([U.unbase64(image.slice(comma + 1))], { type: image.slice(5, image.indexOf(';')) }));
          try {
            const scale = logoSize / Math.max(bitmap.width, bitmap.height), width = bitmap.width * scale, height = bitmap.height * scale;
            context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
          } finally { bitmap.close(); }
        }
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        return options.outputEncoding === 'hex' ? U.hex(bytes) : options.outputEncoding === 'base64' ? U.base64(bytes) : { mime: 'image/png', filename: 'qrcode.png', width: size, height: size, encoding: 'base64', content: U.base64(bytes) };
      }
      const content = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><defs>' + defs.join('') + '</defs><rect width="100%" height="100%" fill="' + colors.background + '"/><path fill="' + colors.dots + '" d="' + path + '"/>' + shapes + (image ? '<image href="' + image + '" x="' + logoStart + '" y="' + logoStart + '" width="' + logoSize + '" height="' + logoSize + '"/>' : '') + '</svg>';
      return options.outputEncoding === 'hex' ? U.hex(U.encoder.encode(content)) : options.outputEncoding === 'base64' ? U.base64(U.encoder.encode(content)) : { mime: 'image/svg+xml', filename: 'qrcode.svg', width: size, height: size, content };
    }
    if (options.inputEncoding !== 'dataurl') {
      const bytes = U.bytes(input, options.inputEncoding), hex = U.hex(bytes.subarray(0, 12));
      const mime = hex.startsWith('89504e470d0a1a0a') ? 'image/png' : hex.startsWith('ffd8ff') ? 'image/jpeg' : hex.startsWith('52494646') && hex.slice(16) === '57454250' ? 'image/webp' : '';
      if (!mime) throw new Error('请选择 PNG/JPEG/WebP 图片'); input = 'data:' + mime + ';base64,' + U.base64(bytes);
    }
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(input)) throw new Error('解析需要 PNG/JPEG/WebP 的 Base64 数据 URL');
    U.load('qrParse');
    const comma = input.indexOf(','), mime = input.slice(5, input.indexOf(';'));
    const bitmap = await createImageBitmap(new Blob([U.unbase64(input.slice(comma + 1))], { type: mime }));
    try {
      if (bitmap.width * bitmap.height > 4194304) throw new Error('二维码图片最多 400 万像素');
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height);
      if (!result) throw new Error('未找到可识别的二维码');
      return { text: result.data, binary: result.binaryData, location: result.location, version: result.version, image: input };
    } finally { bitmap.close(); }
  };
  H.barcode = (input, _operation, options) => {
    U.load('barcode'); const target = {};
    if (![options.background, options.lineColor].every(value => /^#[0-9a-f]{6}$/i.test(value))) throw new Error('条码颜色需要 #RRGGBB');
    const showText = options.textPosition !== 'close', textHeight = showText ? Math.max(0, options.fontSize + options.textMargin) : 0;
    JsBarcode(target, input || 'Example 1234', { ...options, displayValue: showText });
    let x = options.margin, bars = '', captions = '';
    const top = options.margin + (options.textPosition === 'top' ? textHeight : 0);
    for (const encoding of target.encodings) {
      const start = x;
      for (const bit of encoding.data) { if (bit === '1') bars += '<rect x="' + x + '" y="' + top + '" width="' + options.width + '" height="' + options.height + '"/>'; x += options.width; }
      if (showText && encoding.text) {
        const position = options.textAlign === 'left' ? start : options.textAlign === 'right' ? x : (start + x) / 2;
        captions += '<text x="' + position + '" y="' + (options.textPosition === 'top' ? options.margin + options.fontSize : top + options.height + options.textMargin + options.fontSize) + '" text-anchor="' + ({ left: 'start', center: 'middle', right: 'end' })[options.textAlign] + '">' + U.escapeXml(encoding.text) + '</text>';
      }
    }
    const width = x + options.margin, height = options.height + options.margin * 2 + textHeight;
    return { mime: 'image/svg+xml', filename: 'barcode.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><title>' + U.escapeXml(input || 'Example 1234') + '</title><rect width="100%" height="100%" fill="' + options.background + '"/><g fill="' + options.lineColor + '">' + bars + '</g><g fill="' + options.lineColor + '" font-family="' + options.font + '" font-size="' + options.fontSize + '" font-weight="' + (options.bold ? 'bold' : 'normal') + '" font-style="' + (options.italic ? 'italic' : 'normal') + '">' + captions + '</g></svg>' };
  };
  H.color = (input, _operation, options) => {
    let r, g, b, alpha = 1, value = input.trim().toLowerCase();
    if (value.startsWith('{')) {
      const object = U.json(value), a = object.a ?? 1;
      if (['h', 's', 'v'].every(key => Number.isFinite(object[key]))) {
        const { h, s, v } = object, lightness = v * (1 - s / 200), saturation = lightness === 0 || lightness === 100 ? 0 : (v - lightness) / Math.min(lightness, 100 - lightness) * 100;
        if (s < 0 || s > 100 || v < 0 || v > 100) throw new Error('HSV 分量超出范围');
        value = 'hsla(' + h + ',' + saturation + '%,' + lightness + '%,' + a + ')';
      } else if (['l', 'a', 'b'].every(key => Number.isFinite(object[key]))) value = 'lab(' + object.l + '% ' + object.a + ' ' + object.b + ' / ' + (object.alpha ?? 1) + ')';
      else if (['x', 'y', 'z'].every(key => Number.isFinite(object[key]))) value = 'color(xyz-d50 ' + [object.x, object.y, object.z].map(n => n / 100).join(' ') + ' / ' + a + ')';
      else throw new Error('请输入 HSV、Lab 或 XYZ 对象');
    }
    const cmyk = /^cmyk\(([^)]+)\)$/.exec(value);
    if (cmyk) {
      const components = cmyk[1].split(/[,/\s]+/).filter(Boolean);
      if (![4, 5].includes(components.length) || components.some(part => !/^\d+(?:\.\d+)?%?$/.test(part))) throw new Error('CMYK 格式错误');
      const [c, m, y, k] = components.slice(0, 4).map(part => parseFloat(part) / 100);
      if ([c, m, y, k].some(n => n < 0 || n > 1)) throw new Error('CMYK 分量超出范围');
      value = 'rgba(' + [c, m, y].map(n => Math.round(255 * (1 - n) * (1 - k))).join(',') + ',' + (components[4] || 1) + ')';
    }
    const hex = /^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(value);
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value), hsl = /^hsla?\(([^)]+)\)$/.exec(value);
    const numeric = (text, scale) => {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)%?$/.test(text)) throw new Error('颜色分量格式错误');
      return parseFloat(text) * (text.endsWith('%') ? scale / 100 : 1);
    };
    const check = (n, max) => { if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('颜色分量超出范围'); return n; };
    if (hex) {
      const text = hex[1].length < 5 ? [...hex[1]].map(char => char + char).join('') : hex[1];
      [r, g, b] = [0, 2, 4].map(index => parseInt(text.slice(index, index + 2), 16)); if (text.length === 8) alpha = parseInt(text.slice(6), 16) / 255;
    } else if (rgb || hsl) {
      const parts = (rgb || hsl)[1].trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
      if (![3, 4].includes(parts.length)) throw new Error('颜色需要 3 个分量和可选透明度');
      if (parts.length === 4) alpha = check(numeric(parts[3], 1), 1);
      if (rgb) [r, g, b] = parts.slice(0, 3).map(part => check(numeric(part, 255), 255));
      else {
        const hue = numeric(parts[0].replace(/deg$/, ''), 360), s = check(numeric(parts[1], 1), 1), l = check(numeric(parts[2], 1), 1);
        if (!parts[1].endsWith('%') || !parts[2].endsWith('%')) throw new Error('HSL 饱和度和亮度需要百分号');
        const h = ((hue % 360) + 360) % 360 / 60, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
        [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h)].map(n => (n + m) * 255);
      }
    } else {
      // The browser already parses CSS color names, HWB, Lab and LCH in the worker.
      const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#010203'; context.fillStyle = value; const first = context.fillStyle;
      context.fillStyle = '#040506'; context.fillStyle = value;
      if (first !== context.fillStyle) throw new Error('无法识别颜色');
      context.clearRect(0, 0, 1, 1); context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data; [r, g, b] = pixel; alpha = pixel[3] / 255;
    }
    if (options.alpha !== '') alpha = check(Number(options.alpha), 1);
    [r, g, b] = [r, g, b].map(Math.round);
    const [red, green, blue] = [r, g, b].map(n => n / 255), max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min, lightness = (max + min) / 2;
    let hue = delta ? (max === red ? (green - blue) / delta % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4) * 60 : 0; if (hue < 0) hue += 360;
    const round = n => Math.round(n * 1000) / 1000, saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
    const linear = [red, green, blue].map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
    const [x, y, z] = [[.4360657, .3851515, .1430784], [.2224932, .7168871, .0606197], [.0139239, .0970812, .7140994]].map(row => row.reduce((sum, n, i) => sum + n * linear[i], 0) * 100);
    const [fx, fy, fz] = [x / 96.422, y / 100, z / 82.521].map(n => n > 216 / 24389 ? Math.cbrt(n) : (24389 / 27 * n + 16) / 116);
    const lab = { l: round(116 * fy - 16), a: round(500 * (fx - fy)), b: round(200 * (fy - fz)), alpha: round(alpha) };
    let angle = Math.atan2(lab.b, lab.a) * 180 / Math.PI; if (angle < 0) angle += 360;
    const names = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkturquoise darkviolet deeppink deepskyblue dimgray dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }); let name = '', distance = Infinity;
    for (const candidate of names) { context.fillStyle = candidate; context.fillRect(0, 0, 1, 1); const pixel = context.getImageData(0, 0, 1, 1).data; const next = (r - pixel[0]) ** 2 + (g - pixel[1]) ** 2 + (b - pixel[2]) ** 2; if (next < distance) { distance = next; name = candidate; } }
    return { name: alpha === 0 ? 'transparent' : name, hex: '#' + [r, g, b, ...(alpha < 1 ? [Math.round(alpha * 255)] : [])].map(n => n.toString(16).padStart(2, '0')).join(''), rgb: 'rgba(' + [r, g, b, round(alpha)].join(', ') + ')', hsl: 'hsla(' + round(hue) + ', ' + round(saturation * 100) + '%, ' + round(lightness * 100) + '%, ' + round(alpha) + ')',
      hwb: 'hwb(' + round(hue) + ' ' + round(min * 100) + '% ' + round((1 - max) * 100) + '% / ' + round(alpha) + ')',
      cmyk: 'cmyk(' + [red, green, blue].map(n => round(max ? (max - n) / max * 100 : 0)).concat(round((1 - max) * 100)).map(n => n + '%').join(', ') + ', ' + round(alpha) + ')',
      hsv: JSON.stringify({ h: round(hue), s: round(max ? delta / max * 100 : 0), v: round(max * 100), a: round(alpha) }), lab: JSON.stringify(lab), xyz: JSON.stringify({ x: round(x), y: round(y), z: round(z), a: round(alpha) }),
      lch: 'lch(' + lab.l + '% ' + round(Math.hypot(lab.a, lab.b)) + ' ' + round(angle) + ' / ' + round(alpha) + ')', r, g, b, alpha: round(alpha) };
  };
  const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  H.httpSnippet = (input, operation, options) => {
    const warnings = [], finish = code => options.report ? { code, warnings } : code;
    if (operation === 'requests') {
      const value = U.json(input), entries = value.log?.entries || (value.request ? [value] : value.url ? [{ request: value }] : []);
      if (!Array.isArray(entries)) throw new Error('HAR entries 必须是数组');
      return entries.slice(0, 10000).map((entry, index) => ({ entry: index + 1, url: entry?.request?.url })).filter(entry => typeof entry.url === 'string');
    }
    let request;
    if (options.from === 'curl') {
      const tokens = shellTokens(input); if (tokens.shift() !== 'curl') throw new Error('请输入一条 cURL 命令');
      request = { method: 'GET', headers: {} }; const data = []; let explicitMethod = false;
      while (tokens.length) {
        let token = tokens.shift(), attached;
        if (token.startsWith('--') && token.includes('=')) { const index = token.indexOf('='); attached = token.slice(index + 1); token = token.slice(0, index); }
        else if (/^-[XHdu].+/.test(token)) { attached = token.slice(2); token = token.slice(0, 2); }
        const take = () => { const value = attached ?? tokens.shift(); if (value === undefined) throw new Error(token + ' 缺少参数'); return value; };
        if (['--compressed', '--location', '-L', '--insecure', '-k', '--silent', '-s', '--show-error', '-S', '--include', '-i', '--verbose', '-v'].includes(token)) { warnings.push(token + ' 未转换，请按目标客户端配置对应行为。'); continue; }
        if (['--request', '-X'].includes(token)) { request.method = take(); explicitMethod = true; }
        else if (['--header', '-H'].includes(token)) { const value = take(), index = value.indexOf(':'); if (index < 1) throw new Error('请求头缺少冒号'); request.headers[value.slice(0, index).trim()] = value.slice(index + 1).trim(); }
        else if (['--data', '--data-raw', '--data-binary', '-d', '--data-urlencode'].includes(token)) { const value = take(); if (value.startsWith('@')) throw new Error('请用实际内容替换 cURL 文件引用'); const index = value.indexOf('='); data.push(token === '--data-urlencode' ? index < 0 ? encodeURIComponent(value) : value.slice(0, index + 1) + encodeURIComponent(value.slice(index + 1)) : value); }
        else if (token === '--url') request.url = take();
        else if (token === '--head' || token === '-I') { request.method = 'HEAD'; explicitMethod = true; }
        else if (token === '--user-agent' || token === '-A') request.headers['User-Agent'] = take();
        else if (token === '--cookie' || token === '-b') request.headers.Cookie = take();
        else if (token === '--user' || token === '-u') request.headers.Authorization = 'Basic ' + U.base64(U.encoder.encode(take()));
        else if (/^https?:\/\//i.test(token)) { if (request.url) throw new Error('一次只转换一个 URL'); request.url = token; }
        else throw new Error('尚不支持的 cURL 参数：' + token);
      }
      if (data.length) { request.body = data.join('&'); if (!explicitMethod) request.method = 'POST'; if (!Object.keys(request.headers).some(key => key.toLowerCase() === 'content-type')) request.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    } else if (options.from === 'har') {
      const value = U.json(input), entry = value.log?.entries?.[options.entry - 1]?.request || value.request || (value.url ? value : null);
      if (!entry) throw new Error('HAR 中没有对应请求');
      request = { url: entry.url, method: entry.method, headers: Object.fromEntries((entry.headers || []).map(item => [item.name, item.value])) };
      if (entry.postData) { request.body = entry.postData.text ?? new URLSearchParams((entry.postData.params || []).map(item => [item.name, item.value])).toString(); if (entry.postData.mimeType && !Object.keys(request.headers).some(key => key.toLowerCase() === 'content-type')) request.headers['Content-Type'] = entry.postData.mimeType; }
    } else request = U.json(input);
    if (!request || typeof request !== 'object' || typeof request.url !== 'string') throw new Error('需要 {url, method, headers, body} JSON 对象');
    const url = new URL(request.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('仅生成 HTTP(S) 示例');
    const method = String(request.method || 'GET').toUpperCase(); if (!/^[A-Z]+$/.test(method)) throw new Error('HTTP 方法无效');
    const headers = request.headers || {};
    if (typeof headers !== 'object' || Array.isArray(headers) || Object.entries(headers).some(([key, value]) => typeof value !== 'string' || /[\r\n]/.test(key + value))) throw new Error('headers 必须是字符串键值对象，不能含换行');
    const body = request.body === undefined ? null : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const quote = JSON.stringify;
    if (operation === 'curl') return finish('curl -X ' + method + ' ' + shellQuote(url.href) + Object.entries(headers).map(([key, value]) => ' \\\n  -H ' + shellQuote(key + ': ' + value)).join('') + (body === null ? '' : ' \\\n  --data-raw ' + shellQuote(body)));
    if (operation === 'fetch') return finish('const response = await fetch(' + quote(url.href) + ', ' + JSON.stringify({ method, headers, ...(body === null ? {} : { body }) }, null, 2) + ');\nconsole.log(await response.text());');
    if (operation === 'python') return finish('import requests\n\nresponse = requests.request(' + quote(method) + ', ' + quote(url.href) + ',\n    headers=' + JSON.stringify(headers) + (body === null ? '' : ',\n    data=' + quote(body)) + ')\nprint(response.text)');
    if (operation === 'go') return finish('package main\n\nimport ("fmt"; "io"; "net/http"; "strings")\n\nfunc main() {\n  req, err := http.NewRequest(' + quote(method) + ', ' + quote(url.href) + ', strings.NewReader(' + quote(body || '') + '))\n  if err != nil { panic(err) }\n' + Object.entries(headers).map(([key, value]) => '  req.Header.Set(' + quote(key) + ', ' + quote(value) + ')\n').join('') + '  res, err := http.DefaultClient.Do(req)\n  if err != nil { panic(err) }\n  defer res.Body.Close()\n  data, err := io.ReadAll(res.Body)\n  if err != nil { panic(err) }\n  fmt.Println(string(data))\n}');
    return finish('import java.net.URI;\nimport java.net.http.*;\n\nclass Example {\n  public static void main(String[] args) throws Exception {\n    var request = HttpRequest.newBuilder(URI.create(' + quote(url.href) + '))\n' + Object.entries(headers).map(([key, value]) => '      .header(' + quote(key) + ', ' + quote(value) + ')\n').join('') + '      .method(' + quote(method) + ', HttpRequest.BodyPublishers.' + (body === null ? 'noBody()' : 'ofString(' + quote(body) + ')') + ').build();\n    var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());\n    System.out.println(response.body());\n  }\n}');
  };
  function shellTokens(input) {
    const tokens = []; let token = '', quote = '', active = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (char === '\\' && quote !== "'") {
        if (i + 1 >= input.length) throw new Error('命令末尾转义不完整');
        if (input[i + 1] === '\n') { i++; continue; }
        if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 2; continue; }
        if (quote === '"' && !/[\\$`"]/.test(input[i + 1])) token += '\\';
        else token += input[++i];
        active = true;
      }
      else if (quote) {
        if (char === quote) quote = '';
        else { if (quote === '"' && /[$`]/.test(char)) throw new Error('不展开 Shell 表达式，请先提供实际值'); token += char; }
      }
      else if (char === '"' || char === "'") { quote = char; active = true; }
      else if (/\s/.test(char)) { if (active) tokens.push(token); token = ''; active = false; }
      else { if (/[;|&<>`]/.test(char) || char === '$') throw new Error('只接受单条命令及字面参数，不展开 Shell 表达式'); token += char; active = true; }
    }
    if (quote) throw new Error('命令引号未闭合'); if (active) tokens.push(token); return tokens;
  }
  H.dockerCompose = input => {
    const tokens = shellTokens(input);
    if (tokens.shift() !== 'docker' || tokens.shift() !== 'run') throw new Error('请输入一条 docker run 命令');
    const service = {}, warnings = [], networks = new Set();
    const flags = { '-p': 'ports', '--publish': 'ports', '-e': 'environment', '--env': 'environment', '-v': 'volumes', '--volume': 'volumes', '--env-file': 'env_file', '--device': 'devices', '--add-host': 'extra_hosts', '--dns': 'dns', '--cap-add': 'cap_add', '--cap-drop': 'cap_drop', '--label': 'labels', '-l': 'labels', '--name': 'container_name', '--hostname': 'hostname', '-h': 'hostname', '--user': 'user', '-u': 'user', '--workdir': 'working_dir', '-w': 'working_dir', '--restart': 'restart', '--entrypoint': 'entrypoint', '--memory': 'mem_limit', '-m': 'mem_limit', '--cpus': 'cpus', '--network': 'network', '--net': 'network', '--platform': 'platform', '--expose': 'expose' };
    const arrays = new Set(['ports', 'environment', 'volumes', 'env_file', 'devices', 'extra_hosts', 'dns', 'cap_add', 'cap_drop', 'labels', 'expose']);
    while (tokens.length && tokens[0].startsWith('-')) {
      let flag = tokens.shift(), attached;
      if (flag === '--') break;
      if (flag === '-d' || flag === '--detach') continue;
      if (/^-[dit]+$/.test(flag)) { if (flag.includes('i')) service.stdin_open = true; if (flag.includes('t')) service.tty = true; continue; }
      if (flag === '--rm') { warnings.push('--rm 是运行时行为；启动时使用 docker compose run --rm。'); continue; }
      if (flag === '--privileged') { service.privileged = true; continue; }
      if (flag === '--read-only') { service.read_only = true; continue; }
      if (flag === '--init') { service.init = true; continue; }
      if (flag.includes('=')) { const index = flag.indexOf('='); attached = flag.slice(index + 1); flag = flag.slice(0, index); }
      else if (/^-[pevlhumw].+/.test(flag)) { attached = flag.slice(2); flag = flag.slice(0, 2); }
      const key = flags[flag]; if (!key) throw new Error('尚未映射的 Docker 参数：' + flag + '；未生成可能丢失配置的 YAML');
      const value = attached === undefined ? tokens.shift() : attached; if (value === undefined) throw new Error(flag + ' 缺少参数');
      if (key === 'network') {
        if (['host', 'none'].includes(value) || value.startsWith('container:')) service.network_mode = value;
        else { (service.networks ||= []).push(value); networks.add(value); }
      } else if (arrays.has(key)) (service[key] ||= []).push(value);
      else if (key === 'cpus') { if (!(Number(value) > 0)) throw new Error('cpus 需要正数'); service[key] = Number(value); }
      else if (key === 'entrypoint') service[key] = [value];
      else service[key] = value;
    }
    service.image = tokens.shift(); if (!service.image) throw new Error('缺少 Docker 镜像');
    if (tokens.length) service.command = tokens;
    const name = (service.container_name || 'app').replace(/[^A-Za-z0-9_-]/g, '_');
    const document = { services: { [name]: service } };
    const volumes = new Set((service.volumes || []).map(value => value.split(':')[0]).filter(value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)));
    if (volumes.size) document.volumes = Object.fromEntries([...volumes].map(name => [name, {}]));
    if (networks.size) document.networks = Object.fromEntries([...networks].map(name => [name, { external: true }]));
    // Compose performs its own dollar interpolation; preserve literal shell values.
    function literalValues(value) {
      if (typeof value === 'string') return value.replace(/\$/g, '$$$$');
      if (Array.isArray(value)) return value.map(literalValues);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literalValues(item)]));
      return value;
    }
    U.load('yaml'); return warnings.map(value => '# ' + value + '\n').join('') + jsyaml.dump(literalValues(document), { noRefs: true });
  };
})(OfflineTools);
