// Pure non-page data assertions for background node execution.
(function attachNodeAssertionOps(root, factory) {
  'use strict';
  var api = factory();
  var commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  if (!commonJs && root) root.NodeAssertionOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 1;

  function hasOwn(value, key) { return !!(value && Object.prototype.hasOwnProperty.call(value, key)); }
  function ownDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
    return descriptor && !descriptor.get && !descriptor.set && hasOwn(descriptor, 'value') ? descriptor : null;
  }
  function ownValue(value, key, fallback) {
    var descriptor = ownDescriptor(value, key);
    return descriptor ? descriptor.value : fallback;
  }
  function requireOwnInput(value, key, label) {
    var descriptor = ownDescriptor(value, key);
    if (!descriptor || descriptor.value === undefined) {
      throw new Error('[断言输入错误] 缺少有效的 ' + (label || key) + ' 参数');
    }
    return descriptor.value;
  }
  function toNumberOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    var number = Number(value);
    return isNaN(number) ? null : number;
  }

  function createAssertionOps() {
    function execAssertValue(params) {
      var actual = requireOwnInput(params, 'actual', 'actual');
      var expected = requireOwnInput(params, 'expected', 'expected');
      var operatorValue = ownValue(params, 'operator', undefined);
      var operator = operatorValue || '==';
      var actualNumber = toNumberOrNull(actual);
      var expectedNumber = toNumberOrNull(expected);
      var bothNumeric = actualNumber !== null && expectedNumber !== null;
      var passed;

      switch (operator) {
        case '==': passed = bothNumeric ? actualNumber === expectedNumber : String(actual) === String(expected); break;
        case '!=': passed = bothNumeric ? actualNumber !== expectedNumber : String(actual) !== String(expected); break;
        case '>': passed = bothNumeric && actualNumber > expectedNumber; break;
        case '>=': passed = bothNumeric && actualNumber >= expectedNumber; break;
        case '<': passed = bothNumeric && actualNumber < expectedNumber; break;
        case '<=': passed = bothNumeric && actualNumber <= expectedNumber; break;
        case 'contains': passed = String(actual).indexOf(String(expected)) !== -1; break;
        case 'notContains': passed = String(actual).indexOf(String(expected)) === -1; break;
        case 'regex': passed = new RegExp(String(expected)).test(String(actual)); break;
        default: throw new Error('未知比较方式: ' + operator);
      }

      if (!passed) {
        throw new Error('[断言失败] 数据断言 (' + operator + ') — 实际: "' + String(actual).slice(0, 200) + '", 预期: "' + String(expected).slice(0, 200) + '"');
      }
      return { passed: true, actual: actual, expected: expected, operator: operator };
    }

    return Object.freeze({
      execAssertValue: execAssertValue,
    });
  }

  return Object.freeze({ API_VERSION: API_VERSION, createAssertionOps: createAssertionOps });
});
