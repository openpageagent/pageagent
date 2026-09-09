// Shared source and result contract for privileged page JavaScript execution.
(function attachPageJavascriptContract(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var factContract = commonJs ? require('./page-fact-contract.js') : root && root.PageFactContract;
  var api = factory(factContract);
  if (commonJs) module.exports = api;
  else if (root) root.PageJavascriptContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (factContract) {
  'use strict';

  var API_VERSION = 1;
  if (!factContract || typeof factContract.PageFactError !== 'function') {
    throw new Error('PageJavascriptContract requires PageFactContract');
  }

  function toExpression(source, sourceType) {
    source = String(source || '');
    if (String(sourceType || 'expression').toLowerCase() !== 'body') return source;
    return '(async function(){\n' + source + '\n})()';
  }

  function evaluatedValue(response, operation, performed) {
    if (response && response.exceptionDetails) {
      var details = response.exceptionDetails;
      var description = details.exception && (details.exception.description || details.exception.value);
      var error = new factContract.PageFactError(
        'PAGE_EVALUATION_FAILED',
        String(operation || '页面 JavaScript') + '执行失败: ' + String(description || details.text || '未知异常'),
        { exceptionDetails: factContract.clone(details) }
      );
      error.performed = String(performed || '') === 'unknown' ? 'unknown' : 'no';
      throw error;
    }
    return response && response.result && response.result.value;
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    toExpression: toExpression,
    evaluatedValue: evaluatedValue,
  });
});
