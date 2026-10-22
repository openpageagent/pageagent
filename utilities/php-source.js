(function (U) {
  'use strict';
  // A data-literal grammar only: no PHP execution, variables, calls or includes.
  U.parsePhpSource = input => {
    let source = input.trim().replace(/^<\?php\s*/i, '').replace(/\?>\s*$/, ''), cursor = 0, nodes = 0;
    function whitespace() {
      while (cursor < source.length) {
        const match = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*)/.exec(source.slice(cursor));
        if (!match) break; cursor += match[0].length;
      }
    }
    function take(token) { whitespace(); if (source.startsWith(token, cursor)) { cursor += token.length; return true; } return false; }
    function expect(token) { if (!take(token)) throw new Error('PHP 第 ' + (cursor + 1) + ' 个字符处需要 ' + token); }
    function string() {
      const quote = source[cursor++]; let result = '';
      while (cursor < source.length) {
        let char = source[cursor++]; if (char === quote) return result;
        if (char === '$' && quote === '"') throw new Error('仅接受 PHP 字面量，不支持字符串变量插值');
        if (char !== '\\') { result += char; continue; }
        if (cursor >= source.length) break;
        char = source[cursor++];
        if (quote === "'") { result += char === "'" || char === '\\' ? char : '\\' + char; continue; }
        const escapes = { n: '\n', r: '\r', t: '\t', v: '\v', e: '\x1b', f: '\f', '\\': '\\', '"': '"', '$': '$' };
        if (Object.hasOwn(escapes, char)) result += escapes[char];
        else if (char === 'x' && /^[a-f\d]/i.test(source[cursor] || '')) { const hex = /^[a-f\d]{1,2}/i.exec(source.slice(cursor))[0]; result += String.fromCharCode(parseInt(hex, 16)); cursor += hex.length; }
        else if (char === 'u' && source[cursor] === '{') { const hex = /^\{([a-f\d]+)\}/i.exec(source.slice(cursor)); if (!hex || parseInt(hex[1], 16) > 0x10ffff) throw new Error('PHP Unicode 转义无效'); result += String.fromCodePoint(parseInt(hex[1], 16)); cursor += hex[0].length; }
        else if (/[0-7]/.test(char)) { const octal = char + (/^[0-7]{0,2}/.exec(source.slice(cursor))[0]); result += String.fromCharCode(parseInt(octal, 8) & 255); cursor += octal.length - 1; }
        else result += '\\' + char;
      }
      throw new Error('PHP 字符串未闭合');
    }
    function value(depth = 0) {
      if (++nodes > 20000 || depth > 100) throw new Error('PHP 数据嵌套过深或过大');
      whitespace();
      const object = /^\(\s*object\s*\)/i.exec(source.slice(cursor));
      if (object) {
        cursor += object[0].length; const child = value(depth + 1);
        if (child === null || typeof child !== 'object' || child instanceof Number) throw new Error('(object) 后需使用 array(...) 或 [...]');
        const result = Object.assign(Object.create(null), child); U.phpObjects.add(result);
        U.phpEntries.set(result, (U.phpEntries.get(child) || Object.entries(child)).map(([key, item]) => [String(key), item])); return result;
      }
      const longArray = /^array\s*\(/i.exec(source.slice(cursor));
      if (source[cursor] === '[' || longArray) {
        const end = longArray ? ')' : ']'; cursor += longArray ? longArray[0].length : 1;
        const entries = new Map(); let next = 0;
        while (!take(end)) {
          const first = value(depth + 1); let key = next, item = first;
          if (take('=>')) {
            key = first;
            if (key instanceof Number) key = key.valueOf();
            if (key === null) key = '';
            else if (typeof key === 'boolean') key = Number(key);
            else if (typeof key === 'number') key = Math.trunc(key);
            else if (typeof key !== 'string') throw new Error('PHP 数组键必须是标量');
            if (typeof key === 'string' && /^(?:0|-?[1-9]\d*)$/.test(key)) { if (!Number.isSafeInteger(Number(key))) throw new Error('数组整数键超出安全精度'); key = Number(key); }
            item = value(depth + 1);
          }
          entries.set(key, item); if (typeof key === 'number' && key >= next) next = key + 1;
          if (take(end)) break; expect(',');
        }
        if ([...entries.keys()].every((key, i) => key === i)) return [...entries.values()];
        const result = Object.assign(Object.create(null), Object.fromEntries(entries)); U.phpEntries.set(result, [...entries]); return result;
      }
      if (source[cursor] === "'" || source[cursor] === '"') return string();
      const literal = /^(true|false|null)\b/i.exec(source.slice(cursor));
      if (literal) { cursor += literal[0].length; return { true: true, false: false, null: null }[literal[0].toLowerCase()]; }
      const numeric = /^[+-]?(?:0x[a-f\d]+|0b[01]+|0o[0-7]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i.exec(source.slice(cursor));
      if (numeric) {
        cursor += numeric[0].length; const token = numeric[0], sign = token[0] === '-' ? -1 : 1, digits = token.replace(/^[+-]/, '');
        if (/^0\d+$/.test(digits) && /[89]/.test(digits)) throw new Error('PHP 八进制字面量无效');
        const result = sign * (/^0[0-7]+$/.test(digits) ? parseInt(digits, 8) : Number(digits));
        const floating = !/^0[xbo]/i.test(digits) && /[.e]/i.test(digits);
        if (!Number.isFinite(result) || !floating && !Number.isSafeInteger(result)) throw new Error('PHP 数值超出 JSON 安全精度'); return floating ? new Number(result) : result;
      }
      throw new Error('PHP 第 ' + (cursor + 1) + ' 个字符处不是数据字面量；仅支持数组、对象转换、字符串、数字、布尔值和 null');
    }
    whitespace(); const prefix = /^return\b/i.exec(source.slice(cursor)); if (prefix) cursor += prefix[0].length;
    const result = value(); take(';'); whitespace(); if (cursor !== source.length) throw new Error('PHP 字面量之后存在多余代码'); return result;
  };
})(OfflineTools);
