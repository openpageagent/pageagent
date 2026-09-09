// 通用工具函数
(function attachCoreUtils(root, factory) {
  root.CoreUtils = factory();
})(globalThis, function () {

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function deepMerge(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) return source;
    var result = {};
    var keys = Object.keys(target).concat(Object.keys(source));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!(k in result)) {
        result[k] = isPlainObject(target[k]) && isPlainObject(source[k])
          ? deepMerge(target[k], source[k])
          : (k in source ? source[k] : target[k]);
      }
    }
    return result;
  }

  function pickDefined(obj, keys) {
    var result = {};
    if (!isPlainObject(obj)) return result;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] in obj) result[keys[i]] = obj[keys[i]];
    }
    return result;
  }

  function parseUrlSafely(url) {
    try { return new URL(url); } catch (_) { return null; }
  }

  function normalizeHostname(raw) {
    if (!raw) return '';
    return raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  return {
    isPlainObject: isPlainObject,
    deepMerge: deepMerge,
    pickDefined: pickDefined,
    parseUrlSafely: parseUrlSafely,
    normalizeHostname: normalizeHostname,
    sleep: sleep,
  };
});
