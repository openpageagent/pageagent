// Stateless bridge from the unified perception layer to the page's network-capture fact buffer.
(function installPageNetworkProvider() {
  'use strict';
  if (self.PageNetworkFactProviderInstalled) return;
  self.PageNetworkFactProviderInstalled = true;
  var sequence = 0;

  function requestEvent(eventName, responseName, detail, timeoutMs) {
    return new Promise(function (resolve) {
      var requestId = 'networkFact_' + (++sequence) + '_' + Date.now();
      var timer = setTimeout(function () {
        document.removeEventListener(responseName, onResponse);
        resolve(null);
      }, Math.max(200, Number(timeoutMs) || 1800));
      function onResponse(event) {
        var response;
        try { response = JSON.parse(event.detail || '{}'); } catch (_) { response = {}; }
        if (response.reqId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener(responseName, onResponse);
        resolve(response);
      }
      document.addEventListener(responseName, onResponse);
      document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(Object.assign({ reqId: requestId }, detail || {})) }));
    });
  }
  function onMessage(message, _sender, sendResponse) {
    if (!message || message.type !== 'PAGE_NETWORK_FACT_QUERY') return undefined;
    var payload = message.payload || {};
    var operation;
    if (payload.kind === 'clear') {
      operation = requestEvent('__pfa_net_req', '__pfa_net_res', { action: 'clear' }, payload.timeoutMs)
        .then(function (response) { return response ? { available: true, cleared: Number(response.cleared) || 0 } : { available: false }; });
    } else {
      operation = requestEvent('__pfa_net_req', '__pfa_net_res', { filter: payload.filter || {} }, payload.timeoutMs)
        .then(function (response) { return response ? { available: true, entries: response.entries || [] } : { available: false, entries: [] }; });
    }
    operation.then(function (result) { sendResponse({ ok: true, result: result }); }, function (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }
  chrome.runtime.onMessage.addListener(onMessage);
})();
