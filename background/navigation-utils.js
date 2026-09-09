// Navigation Utilities — URL 解析、分类与导航工具
(function attachNavigationUtils(root, factory) {
  root.NavigationUtils = factory();
})(globalThis, function () {

  function parseUrlSafely(url) {
    try { return new URL(url); } catch (_) { return null; }
  }

  function isLocalhostUrl(url) {
    var parsed = parseUrlSafely(url);
    if (!parsed) return false;
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  }

  function isLocalhostOAuthCallbackUrl(url) {
    var parsed = parseUrlSafely(url);
    if (!parsed) return false;
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return false;
    return parsed.searchParams.has('code') && parsed.searchParams.has('state');
  }

  function normalizeUrl(url, defaultBase) {
    var trimmed = (url || '').trim();
    if (!trimmed) return defaultBase || '';
    if (!/^https?:\/\//i.test(trimmed)) trimmed = 'https://' + trimmed;
    return trimmed.replace(/\/+$/, '');
  }

  return {
    parseUrlSafely: parseUrlSafely,
    isLocalhostUrl: isLocalhostUrl,
    isLocalhostOAuthCallbackUrl: isLocalhostOAuthCallbackUrl,
    normalizeUrl: normalizeUrl,
  };
});
