// Expression — 安全表达式求值器（无 eval，兼容 MV3 CSP）
// 输入应是已完成 {{var}} 模板插值的纯表达式字符串
// 支持: 数字/字符串/true/false/null/undefined 字面量、|| && 比较 加减乘除取模 一元!- 括号
// 以及少量安全白名单函数：contains/notContains/startsWith/endsWith/matches/isEmpty/hasValue/trim/lower/upper/length
(function attachExpression(root, factory) {
  root.Expression = factory();
})(globalThis, function () {

  function tokenize(input) {
    var tokens = [];
    var i = 0;
    var len = input.length;
    var TWO_CHAR = ['||', '&&', '==', '!=', '>=', '<='];
    var THREE_CHAR = ['===', '!=='];

    while (i < len) {
      var ch = input[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

      if (ch >= '0' && ch <= '9' || (ch === '.' && input[i + 1] >= '0' && input[i + 1] <= '9')) {
        var num = '';
        while (i < len && (input[i] >= '0' && input[i] <= '9' || input[i] === '.')) { num += input[i]; i++; }
        tokens.push({ type: 'number', value: parseFloat(num) });
        continue;
      }

      if (ch === '"' || ch === "'") {
        var quote = ch;
        var str = '';
        i++;
        while (i < len && input[i] !== quote) {
          if (input[i] === '\\' && i + 1 < len) { str += input[i + 1]; i += 2; continue; }
          str += input[i];
          i++;
        }
        if (i >= len) throw new Error('字符串未闭合');
        i++;
        tokens.push({ type: 'string', value: str });
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        var word = '';
        while (i < len && /[A-Za-z0-9_$]/.test(input[i])) { word += input[i]; i++; }
        if (word === 'true') tokens.push({ type: 'boolean', value: true });
        else if (word === 'false') tokens.push({ type: 'boolean', value: false });
        else if (word === 'null') tokens.push({ type: 'null', value: null });
        else if (word === 'undefined') tokens.push({ type: 'undefined', value: undefined });
        else tokens.push({ type: 'identifier', value: word });
        continue;
      }

      var three = input.slice(i, i + 3);
      if (THREE_CHAR.indexOf(three) !== -1) { tokens.push({ type: 'op', value: three }); i += 3; continue; }
      var two = input.slice(i, i + 2);
      if (TWO_CHAR.indexOf(two) !== -1) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
      if ('><+-*/%!(),'.indexOf(ch) !== -1) { tokens.push({ type: 'op', value: ch }); i++; continue; }

      throw new Error('无法识别的字符: ' + ch);
    }
    return tokens;
  }

  function createParser(tokens) {
    var pos = 0;

    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function expectOp(op) {
      var t = next();
      if (!t || t.type !== 'op' || t.value !== op) throw new Error('期望 "' + op + '"');
    }

    // or → and → equality/relational → additive → multiplicative → unary → primary
    function parseOr() {
      var left = parseAnd();
      while (peek() && peek().type === 'op' && peek().value === '||') {
        next();
        var right = parseAnd();
        left = (truthy(left) ? left : right);
      }
      return left;
    }

    function parseAnd() {
      var left = parseComparison();
      while (peek() && peek().type === 'op' && peek().value === '&&') {
        next();
        var right = parseComparison();
        left = (truthy(left) ? right : left);
      }
      return left;
    }

    function parseComparison() {
      var left = parseAdditive();
      var t = peek();
      if (t && t.type === 'op' && ['==', '===', '!=', '!==', '>', '>=', '<', '<='].indexOf(t.value) !== -1) {
        next();
        var right = parseAdditive();
        switch (t.value) {
          case '==': return looseEq(left, right);
          case '===': return left === right;
          case '!=': return !looseEq(left, right);
          case '!==': return left !== right;
          case '>': return Number(left) > Number(right);
          case '>=': return Number(left) >= Number(right);
          case '<': return Number(left) < Number(right);
          case '<=': return Number(left) <= Number(right);
        }
      }
      return left;
    }

    function parseAdditive() {
      var left = parseMultiplicative();
      while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
        var op = next().value;
        var right = parseMultiplicative();
        if (op === '+') {
          left = (typeof left === 'string' || typeof right === 'string') ? String(left) + String(right) : Number(left) + Number(right);
        } else {
          left = Number(left) - Number(right);
        }
      }
      return left;
    }

    function parseMultiplicative() {
      var left = parseUnary();
      while (peek() && peek().type === 'op' && ['*', '/', '%'].indexOf(peek().value) !== -1) {
        var op = next().value;
        var right = parseUnary();
        if (op === '*') left = Number(left) * Number(right);
        else if (op === '/') left = Number(left) / Number(right);
        else left = Number(left) % Number(right);
      }
      return left;
    }

    function parseUnary() {
      var t = peek();
      if (t && t.type === 'op' && t.value === '!') { next(); return !truthy(parseUnary()); }
      if (t && t.type === 'op' && t.value === '-') { next(); return -Number(parseUnary()); }
      return parsePrimary();
    }

    function parsePrimary() {
      var t = next();
      if (!t) throw new Error('表达式不完整');
      if (t.type === 'identifier') return parseIdentifier(t.value);
      if (t.type === 'op' && t.value === '(') {
        var v = parseOr();
        expectOp(')');
        return v;
      }
      if (t.type === 'number' || t.type === 'string' || t.type === 'boolean' || t.type === 'null' || t.type === 'undefined') {
        return t.value;
      }
      throw new Error('意外的 token: ' + t.value);
    }

    function parseIdentifier(name) {
      if (peek() && peek().type === 'op' && peek().value === '(') {
        next();
        var args = [];
        if (!(peek() && peek().type === 'op' && peek().value === ')')) {
          while (true) {
            args.push(parseOr());
            if (peek() && peek().type === 'op' && peek().value === ',') {
              next();
              continue;
            }
            break;
          }
        }
        expectOp(')');
        return callFunction(name, args);
      }
      throw new Error('未知标识符: ' + name + '（变量请用 {{var}} 模板插值；函数仅支持白名单）');
    }

    return {
      parse: function () {
        var result = parseOr();
        if (pos < tokens.length) throw new Error('表达式末尾有多余内容: ' + tokens[pos].value);
        return result;
      },
    };
  }

  function truthy(v) {
    return !!v;
  }

  function asString(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function callFunction(name, args) {
    if (name === 'contains') return asString(args[0]).indexOf(asString(args[1])) !== -1;
    if (name === 'notContains') return asString(args[0]).indexOf(asString(args[1])) === -1;
    if (name === 'startsWith') return asString(args[0]).indexOf(asString(args[1])) === 0;
    if (name === 'endsWith') {
      var source = asString(args[0]);
      var suffix = asString(args[1]);
      return suffix === '' || source.slice(source.length - suffix.length) === suffix;
    }
    if (name === 'matches') return new RegExp(asString(args[1])).test(asString(args[0]));
    if (name === 'isEmpty') return asString(args[0]).trim() === '';
    if (name === 'hasValue') return asString(args[0]).trim() !== '';
    if (name === 'trim') return asString(args[0]).trim();
    if (name === 'lower') return asString(args[0]).toLowerCase();
    if (name === 'upper') return asString(args[0]).toUpperCase();
    if (name === 'length') return asString(args[0]).length;
    throw new Error('不支持的函数: ' + name);
  }

  // 模拟 JS 宽松相等的常用子集（数字字符串与数字、null/undefined 互等）
  function looseEq(a, b) {
    if (a === b) return true;
    if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
    if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
    if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b);
    return false;
  }

  // 求值；出错返回 { ok:false, error }，成功返回 { ok:true, value }
  function evaluate(expr) {
    if (expr === undefined || expr === null || String(expr).trim() === '') {
      return { ok: true, value: undefined };
    }
    try {
      var tokens = tokenize(String(expr));
      var value = createParser(tokens).parse();
      return { ok: true, value: value };
    } catch (err) {
      return { ok: false, error: err.message, value: undefined };
    }
  }

  // 便捷方法：求值为布尔；解析失败按 false 处理
  function evalBool(expr) {
    var r = evaluate(expr);
    return { ok: r.ok, value: truthy(r.value), error: r.error };
  }

  return {
    evaluate: evaluate,
    evalBool: evalBool,
  };
});
