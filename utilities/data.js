(function (U) {
  'use strict';
  const H = U.handlers;
  function sort(value, descending = false) {
    if (Array.isArray(value)) return value.map(item => sort(item, descending));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0) * (descending ? -1 : 1)).map(key => [key, sort(value[key], descending)]));
  }
  H.json = async (input, operation, options) => {
    if (operation === 'escape') return JSON.stringify(input);
    if (operation === 'repair') { U.load('jsonrepair'); return jsonrepair.jsonrepair(input); }
    const value = U.json(input);
    if (operation === 'unescape') { if (typeof value !== 'string') throw new Error('请输入 JSON 字符串'); return value; }
    if (operation === 'format' || operation === 'minify' || operation === 'sort') {
      let output = value;
      if (options.expression?.trim()) {
        U.load('jsonpath');
        output = JSONPath.JSONPath({ path: options.expression.trim(), json: value, eval: 'safe', wrap: true });
      }
      return JSON.stringify(operation === 'sort' ? sort(output, options.descending) : output, null, operation === 'minify' ? 0 : options.indent === 'tab' ? '\t' : Number(options.indent || 2));
    }
    if (operation === 'unicode') { const result = JSON.stringify(value, null, 2); return options.decodeUnicode ? result : result.replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')); }
    if (operation === 'rename') {
      const rename = value => {
        if (Array.isArray(value)) return value.map(rename);
        if (!value || typeof value !== 'object') return value;
        const result = Object.create(null);
        for (const [key, item] of Object.entries(value)) { const name = H.variableConversion(key, options.naming); if (Object.hasOwn(result, name)) throw new Error('键名转换后重复：' + name); result[name] = rename(item); }
        return result;
      };
      return JSON.stringify(rename(value), null, 2);
    }
    if (operation === 'jsonpath') { U.load('jsonpath'); return JSONPath.JSONPath({ path: options.expression, json: value, eval: 'safe', wrap: true }); }
    if (operation === 'jmespath') { U.load('jmespath'); return jmespath.search(value, options.expression); }
    if (operation === 'schema') {
      const { Validator } = await U.esm('@cfworker/json-schema/dist/esm/index.js');
      return new Validator(U.json(options.schema), '2020-12', false).validate(value);
    }
    return U.toCode(value, options.language, options.name, options);
  };
  H.diffs = (input, operation, options) => {
    U.load('diff');
    return Diff[{ lines: 'diffLines', words: 'diffWordsWithSpace', characters: 'diffChars' }[operation]](input, options.other)
      .map(part => ({ added: !!part.added, removed: !!part.removed, value: part.value, count: part.count }));
  };
  H.code = async (input, operation, options) => {
    const language = options.language;
    if (operation === 'minify') {
      if (language === 'json') return JSON.stringify(U.json(input));
      if (language === 'javascript') {
        U.load('terser'); const result = await Terser.minify(input, { compress: false, mangle: false, format: { comments: 'some' } });
        return result.code;
      }
      if (language === 'css') { U.load('css'); return csso.minify(input, { restructure: false }).css; }
      throw new Error('压缩支持 JavaScript、JSON、CSS；其他语言请选择 format，避免改变语义');
    }
    if (language === 'sql') { U.load('sql'); return sqlFormatter.format(input, { language: options.dialect || 'sql', keywordCase: options.keywordCase || 'preserve', tabWidth: Number(options.indent) || 2, useTabs: options.indent === 'tab' }); }
    if (language === 'xml') {
      U.load('xml');
      const valid = fxp.XMLValidator.validate(input); if (valid !== true) throw new Error(valid.err.msg);
      const parsed = new fxp.XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false,
        parseTagValue: false, parseAttributeValue: false, commentPropName: '#comment', cdataPropName: '#cdata', processEntities: false }).parse(input);
      return new fxp.XMLBuilder({ preserveOrder: true, ignoreAttributes: false, format: true,
        indentBy: options.indent === 'tab' ? '\t' : ' '.repeat(Number(options.indent) || 2), commentPropName: '#comment', cdataPropName: '#cdata', processEntities: false }).build(parsed);
    }
    if (language === 'java') return formatJava(input);
    U.load('prettier'); if (language === 'php') U.load('php');
    const parser = { javascript: 'babel', typescript: 'typescript', json: 'json', html: 'html', vue: 'vue', css: 'css', less: 'less', scss: 'scss', markdown: 'markdown', yaml: 'yaml', php: 'php', graphql: 'graphql' }[language];
    return prettier.format(input, { parser, plugins: Object.values(prettierPlugins), tabWidth: Number(options.indent) || 2, useTabs: options.indent === 'tab', printWidth: 100 });
  };
  function formatJava(input) {
    // Token-preserving brace indentation, including strings, text blocks and comments.
    const tokens = input.match(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\s+|[^\s]/g) || [];
    let depth = 0, parentheses = 0, line = '', result = '';
    function flush() { if (line.trim()) result += '  '.repeat(depth) + line.trim() + '\n'; line = ''; }
    for (const token of tokens) {
      if (/^\s+$/.test(token)) { if (line && !line.endsWith(' ')) line += ' '; continue; }
      if (token === '(') parentheses++;
      if (token === ')') parentheses = Math.max(0, parentheses - 1);
      if (token === '{') { line += token; flush(); depth++; }
      else if (token === '}') { flush(); depth = Math.max(0, depth - 1); line = token; flush(); }
      else { line += token; if (token.startsWith('//') || token === ';' && !parentheses) flush(); }
    }
    flush(); return result;
  }
  H.sqlFillParameter = (input, _operation, options) => {
    const parameters = options.parameterFormat === 'mybatis' ? options.parameters.replace(/^\s*(?:==>\s*)?Parameters:\s*/i, '').split(/(?<=\))\s*,\s*|(?<=\bnull)\s*,\s*/).filter(part => part.trim()).map(part => {
      const match = /^([\s\S]*?)\(([^()]+)\)\s*$/.exec(part.trim());
      if (part.trim() === 'null') return null;
      if (!match) throw new Error('MyBatis 参数需包含类型，例如 1(Integer), Alice(String)');
      const [, value, type] = match;
      if (/^(Integer|Long|Short|Byte|Float|Double|BigDecimal|BigInteger)$/i.test(type)) { if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new Error('数值参数格式错误'); return { sqlNumber: value }; }
      if (/^Boolean$/i.test(type)) { if (!/^(true|false)$/i.test(value)) throw new Error('布尔参数格式错误'); return value.toLowerCase() === 'true'; }
      return value;
    }) : U.json(options.parameters);
    if (!parameters || typeof parameters !== 'object') throw new Error('参数必须是 JSON 数组或对象');
    let index = 0;
    function literal(value) {
      if (value === null) return 'NULL';
      if (options.parameterFormat === 'mybatis' && typeof value === 'object' && value.sqlNumber) return value.sqlNumber;
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      if (typeof value === 'number') return String(value);
      if (typeof value !== 'string') throw new Error('SQL 参数只支持字符串、数值、布尔值或 null');
      return "'" + value.replace(/'/g, "''") + "'";
    }
    // Quotes/comments/dollar-quoted bodies are consumed before placeholders.
    return input.replace(/'(?:''|\\.|[^'\\])*'|"(?:""|[^"\\]|\\.)*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]\w*|)\$[\s\S]*?\$\1\$|::[A-Za-z_]\w*|\?|\$\d+|:[A-Za-z_]\w*/g, token => {
      let key;
      if (options.dialect === 'question' && token === '?') key = index++;
      else if (options.dialect === 'numbered' && /^\$\d+$/.test(token)) key = Number(token.slice(1)) - 1;
      else if (options.dialect === 'named' && /^:[A-Za-z_]\w*$/.test(token)) key = token.slice(1);
      else return token;
      if (!Object.hasOwn(parameters, key)) throw new Error('缺少参数：' + token + '（' + key + '）');
      return literal(parameters[key]);
    });
  };
})(OfflineTools);
