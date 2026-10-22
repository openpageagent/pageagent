(function (U) {
  'use strict';
  U.phpObjects = new WeakSet();
  U.phpEntries = new WeakMap();
  function phpWrite(value, depth = 0) {
    if (depth > 100) throw new Error('PHP 数据嵌套过深');
    if (value === null) return 'N;';
    if (typeof value === 'boolean') return 'b:' + Number(value) + ';';
    if (typeof value === 'number') return (Number.isInteger(value) ? 'i:' : 'd:') + value + ';';
    if (value instanceof Number) return 'd:' + value.valueOf() + ';';
    if (typeof value === 'string') return 's:' + U.encoder.encode(value).length + ':"' + value + '";';
    const object = U.phpObjects.has(value), pairs = U.phpEntries.get(value) || Object.entries(value).map(([key, item]) => [Array.isArray(value) ? Number(key) : key, item]);
    return (object ? 'O:8:"stdClass":' : 'a:') + pairs.length + ':{' + pairs.map(([key, item]) => phpWrite(object ? String(key) : key, depth + 1) + phpWrite(item, depth + 1)).join('') + '}';
  }
  function phpRead(input) {
    const bytes = U.encoder.encode(input); let cursor = 0, nodes = 0;
    function expect(token) { for (const byte of U.encoder.encode(token)) if (bytes[cursor++] !== byte) throw new Error('PHP 序列化格式错误'); }
    function until(delimiter) {
      const start = cursor; while (cursor < bytes.length && bytes[cursor] !== delimiter.charCodeAt(0)) cursor++;
      if (cursor >= bytes.length) throw new Error('PHP 序列化内容不完整');
      const value = U.decoder.decode(bytes.slice(start, cursor)); cursor++; return value;
    }
    function read(depth = 0) {
      if (++nodes > 20000 || depth > 100) throw new Error('PHP 结构过深或过大');
      const type = String.fromCharCode(bytes[cursor++]);
      if (type === 'N') { expect(';'); return null; }
      expect(':');
      if (type === 'b') { const value = until(';'); if (!/^[01]$/.test(value)) throw new Error('无效布尔值'); return value === '1'; }
      if (type === 'i' || type === 'd') {
        const value = until(';'); if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new Error('无效数值');
        if (type === 'i' && !/^[+-]?\d+$/.test(value)) throw new Error('无效整数');
        const number = Number(value); if (!Number.isFinite(number) || type === 'i' && !Number.isSafeInteger(number)) throw new Error('数值超出 JSON 安全精度'); return type === 'd' ? new Number(number) : number;
      }
      if (type === 's') {
        const count = until(':'); if (!/^\d+$/.test(count) || +count > bytes.length - cursor - 3) throw new Error('无效字符串长度');
        expect('"'); const value = U.decoder.decode(bytes.slice(cursor, cursor + +count)); cursor += +count; expect('";'); return value;
      }
      if (type === 'O') {
        const length = until(':'); if (!/^\d+$/.test(length) || +length > bytes.length - cursor - 3) throw new Error('无效类名长度');
        expect('"'); const name = U.decoder.decode(bytes.slice(cursor, cursor + +length)); cursor += +length; expect('":');
        if (name !== 'stdClass') throw new Error('仅支持 stdClass 数据对象，不实例化自定义类');
        const count = until(':'); if (!/^\d+$/.test(count) || +count > 10000) throw new Error('对象属性过多'); expect('{');
        const result = Object.create(null), entries = new Map(); U.phpObjects.add(result);
        for (let i = 0; i < +count; i++) { const key = read(depth + 1); if (typeof key !== 'string') throw new Error('对象属性名必须是字符串'); const item = read(depth + 1); result[key] = item; entries.set(key, item); }
        expect('}'); U.phpEntries.set(result, [...entries]); return result;
      }
      if (type === 'a') {
        const count = until(':'); if (!/^\d+$/.test(count) || +count > 10000) throw new Error('数组长度过大'); expect('{');
        const entries = new Map();
        for (let i = 0; i < +count; i++) { const key = read(depth + 1); if (!['number', 'string'].includes(typeof key)) throw new Error('非法 PHP 数组键'); entries.set(key, read(depth + 1)); }
        expect('}'); if ([...entries.keys()].every((key, i) => key === i)) return [...entries.values()];
        const result = Object.assign(Object.create(null), Object.fromEntries(entries)); U.phpEntries.set(result, [...entries]); return result;
      }
      throw new Error('仅支持 PHP 标量、数组和 stdClass；暂不支持引用或自定义类');
    }
    const result = read(); if (cursor !== bytes.length) throw new Error('PHP 序列化尾部存在多余内容'); return result;
  }
  function phpArray(value, level = 0) {
    if (level > 100) throw new Error('PHP 数据嵌套过深');
    if (value === null) return 'null';
    if (value instanceof Number) return Number.isInteger(value.valueOf()) ? value.valueOf() + '.0' : String(value.valueOf());
    if (typeof value === 'string') return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (typeof value !== 'object') return String(value);
    return '[\n' + Object.entries(value).map(([key, item]) => '  '.repeat(level + 1) + (Array.isArray(value) ? '' : phpArray(key) + ' => ') + phpArray(item, level + 1)).join(',\n') + '\n' + '  '.repeat(level) + ']';
  }
  function phpLiteral(value, level = 0, jsonObjects = false, indent = '  ') {
    if (level > 100) throw new Error('PHP 数据嵌套过深');
    if (value === null || typeof value !== 'object' || value instanceof Number) return phpArray(value);
    const object = U.phpObjects.has(value) || jsonObjects && !Array.isArray(value);
    const entries = U.phpEntries.get(value) || Object.entries(value).map(([key, item]) => [Array.isArray(value) ? Number(key) : key, item]);
    return (object ? '(object) ' : '') + 'array(' + (entries.length ? '\n' + entries.map(([key, item]) => indent.repeat(level + 1) + phpArray(key) + ' => ' + phpLiteral(item, level + 1, jsonObjects, indent)).join(',\n') + '\n' + indent.repeat(level) : '') + ')';
  }
  function propertiesRead(input) {
    const logical = []; let pending = '';
    for (const line of input.split(/\r?\n/)) {
      pending += pending ? line.trimStart() : line;
      const slashes = /\\*$/.exec(pending)[0].length;
      if (slashes % 2) pending = pending.slice(0, -1);
      else { logical.push(pending); pending = ''; }
    }
    if (pending) logical.push(pending);
    const decode = value => value.replace(/\\u([a-f\d]{4})|\\(.)/gi, (_, code, char) => code ? String.fromCharCode(parseInt(code, 16)) : ({ n: '\n', r: '\r', t: '\t', f: '\f' })[char] || char);
    const result = Object.create(null);
    for (const raw of logical) {
      const line = raw.trimStart(); if (!line || /^[#!]/.test(line)) continue;
      let index = 0; for (; index < line.length; index++) { if (line[index] === '\\') index++; else if (/[=:\s]/.test(line[index])) break; }
      const key = decode(line.slice(0, index));
      result[key] = decode(line.slice(index).replace(/^\s*[=:]?\s*/, ''));
    }
    return result;
  }
  U.handlers.serialize = async (input, _operation, options) => {
    let value;
    if (options.from === 'json') value = U.json(input);
    if (options.from === 'yaml') { U.load('yaml'); value = jsyaml.load(input, { schema: jsyaml.JSON_SCHEMA }); }
    if (options.from === 'xml') {
      U.load('xml'); if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('XML 不接受 DTD 或实体声明');
      const valid = fxp.XMLValidator.validate(input); if (valid !== true) throw new Error(valid.err.msg);
      value = new fxp.XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false }).parse(input);
    }
    if (options.from === 'toml') { const toml = await U.esm('smol-toml/dist/index.js'); value = toml.parse(input); }
    if (options.from === 'csv') {
      U.load('csv'); const parsed = Papa.parse(input, { header: true, skipEmptyLines: true, dynamicTyping: false, delimiter: options.delimiter || ',' });
      if (parsed.errors.length) throw new Error(parsed.errors.map(error => error.message).join('; ')); value = parsed.data;
    }
    if (options.from === 'properties') value = propertiesRead(input);
    if (options.from === 'php') value = phpRead(input);
    if (options.from === 'phpSource') value = U.parsePhpSource(input);
    if (value === undefined) throw new Error('输入中没有可转换的数据');
    if (options.to === 'json') return JSON.stringify(value, null, options.indent === 'tab' ? '\t' : Number(options.indent || 2));
    if (options.to === 'yaml') { U.load('yaml'); return jsyaml.dump(value, { schema: jsyaml.JSON_SCHEMA, noRefs: true }); }
    if (options.to === 'xml') { U.load('xml'); return new fxp.XMLBuilder({ ignoreAttributes: false, format: true, ...(options.attributePrefix ? { attributeNamePrefix: options.attributePrefix } : {}) }).build(value); }
    if (options.to === 'toml') { const toml = await U.esm('smol-toml/dist/index.js'); return toml.stringify(value); }
    if (options.to === 'csv') {
      U.load('csv');
      if (!Array.isArray(value) && value && Object.keys(value).length === 1 && Array.isArray(value.data)) value = value.data;
      if (!Array.isArray(value)) throw new Error('CSV 输出需要记录数组或 {data: [...]}');
      if (options.flatten) value = value.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('CSV 每条记录必须是对象');
        const row = Object.create(null);
        const visit = (item, path, depth) => {
          if (depth > 100) throw new Error('嵌套超过 100 层');
          if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) for (const [key, child] of Object.entries(item)) visit(child, path ? path + '.' + key : key, depth + 1);
          else { if (Object.hasOwn(row, path)) throw new Error('展开字段重名：' + path); row[path] = item && typeof item === 'object' ? JSON.stringify(item) : item; }
        };
        for (const [key, child] of Object.entries(record)) visit(child, key, 0); return row;
      });
      const columns = [...new Set(value.flatMap(row => Object.keys(row)))];
      return Papa.unparse(value, { columns, delimiter: options.delimiter || ',' });
    }
    if (options.to === 'php') return phpWrite(value);
    if (options.to === 'phpArray') return '<?php\nreturn ' + phpArray(value) + ';\n';
    if (options.to === 'phpObject') return phpLiteral(value, 0, options.from === 'json', options.indent === 'tab' ? '\t' : ' '.repeat(Number(options.indent) || 2));
    if (!value || typeof value !== 'object') throw new Error('properties 输出需要对象或数组');
    const escape = text => String(text).replace(/[\\\n\r\t =:#!]/g, char => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' })[char] || '\\' + char);
    const entries = new Map();
    const flatten = (object, prefix = '', depth = 0) => {
      if (depth > 100) throw new Error('properties 对象嵌套过深');
      for (const [key, item] of Object.entries(object)) {
        const path = prefix ? prefix + '.' + key : key;
        if (item !== null && typeof item === 'object') flatten(item, path, depth + 1);
        else { if (entries.has(path)) throw new Error('properties 展平后键名重复：' + path); entries.set(path, item); }
      }
    };
    flatten(value); return [...entries].map(([key, item]) => escape(key) + '=' + escape(item)).join('\n');
  };
})(OfflineTools);
