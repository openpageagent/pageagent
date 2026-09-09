// Source Registry — 页面身份识别与 Content Script 驱动管理
(function attachSourceRegistry(root, factory) {
  root.SourceRegistry = factory();
})(globalThis, function () {

  var UNKNOWN_SOURCE = 'unknown-source';

  // --- URL 匹配规则引擎 ---

  function matchesHostname(rule, hostname) {
    if (rule.hostnames && Array.isArray(rule.hostnames)) {
      return rule.hostnames.some(function (h) { return hostname === h; });
    }
    if (rule.hostnameIgnores && Array.isArray(rule.hostnameIgnores)) {
      if (rule.hostnameIgnores.some(function (h) { return hostname === h; })) return false;
    }
    return null; // 规则不适用
  }

  function matchesSuffix(rule, hostname) {
    if (rule.hostnameEndsWith && Array.isArray(rule.hostnameEndsWith)) {
      return rule.hostnameEndsWith.some(function (s) { return hostname.endsWith(s); });
    }
    return null;
  }

  function matchesUrlPattern(rule, url) {
    if (rule.urlIncludes && Array.isArray(rule.urlIncludes)) {
      return rule.urlIncludes.some(function (s) { return url.indexOf(s) !== -1; });
    }
    return null;
  }

  function matchesPath(rule, url) {
    if (rule.pathPrefixes && Array.isArray(rule.pathPrefixes)) {
      var parsed = parseUrlSafely(url);
      if (!parsed) return null;
      return rule.pathPrefixes.some(function (p) { return parsed.pathname.startsWith(p); });
    }
    if (rule.pathEquals && Array.isArray(rule.pathEquals)) {
      var p = parseUrlSafely(url);
      if (!p) return null;
      return rule.pathEquals.some(function (pe) { return p.pathname === pe; });
    }
    return null;
  }

  function matchesRegex(rule, hostname) {
    if (rule.hostnameRegex) {
      try {
        var flags = rule.hostnameRegexFlags || '';
        return new RegExp(rule.hostnameRegex, flags).test(hostname);
      } catch (_) { return false; }
    }
    return null;
  }

  function parseUrlSafely(url) {
    try { return new URL(url); } catch (_) { return null; }
  }

  // 遍历规则数组，任一匹配即返回 true；所有规则都 must match (AND 语义) 时全部 match 才返回 true
  function matchRuleList(matchers, info) {
    if (!matchers || !matchers.length) return false;
    var matchMode = 'any';

    for (var i = 0; i < matchers.length; i++) {
      var m = matchers[i];
      if (m.matchMode === 'all') matchMode = 'all';

      var results = [];
      results.push(matchesHostname(m, info.hostname));
      results.push(matchesSuffix(m, info.hostname));
      results.push(matchesUrlPattern(m, info.url));
      results.push(matchesPath(m, info.url));
      results.push(matchesRegex(m, info.hostname));

      var applicable = results.filter(function (r) { return r !== null; });
      if (applicable.length === 0) {
        if (matchMode === 'all') return false;
        continue;
      }

      var matched = applicable.every(function (r) { return r === true; });
      if (matched) {
        if (matchMode === 'any') return true;
      } else {
        if (matchMode === 'all') return false;
      }
    }

    return matchMode === 'all';
  }

  // --- Source Registry ---

  function createSourceRegistry(deps) {
    deps = deps || {};

    var sourceDefinitions = deps.sourceDefinitions || {};
    var driverDefinitions = deps.driverDefinitions || {};
    var sourceAliases = deps.sourceAliases || {};

    // 注册 source 定义
    function registerSource(sourceId, definition) {
      sourceDefinitions[sourceId] = definition;
    }

    function unregisterSource(sourceId) {
      var existed = Object.prototype.hasOwnProperty.call(sourceDefinitions, sourceId);
      delete sourceDefinitions[sourceId];
      Object.keys(sourceAliases).forEach(function (alias) {
        if (alias === sourceId || sourceAliases[alias] === sourceId) delete sourceAliases[alias];
      });
      return existed;
    }

    // 注册 driver 定义（content script → commands 映射）
    function registerDriver(driverId, definition) {
      driverDefinitions[driverId] = definition;
    }

    // 批量注册（从 flow 定义中导入）
    function registerFromFlow(flowSources, flowDrivers, flowAliases) {
      if (flowSources) Object.assign(sourceDefinitions, flowSources);
      if (flowDrivers) Object.assign(driverDefinitions, flowDrivers);
      if (flowAliases) Object.assign(sourceAliases, flowAliases);
    }

    // 从 URL 检测当前页面匹配哪个 source
    function detectSourceFromLocation(location) {
      var url = location.url || '';
      var hostname = location.hostname || '';
      if (!hostname && url) {
        var p = parseUrlSafely(url);
        if (p) hostname = p.hostname;
      }
      var info = { url: url, hostname: hostname };

      var sourceIds = Object.keys(sourceDefinitions);
      for (var i = 0; i < sourceIds.length; i++) {
        var sid = sourceIds[i];
        var def = sourceDefinitions[sid];
        if (def.kind === 'virtual-page') continue;
        var matchers = def.detectionMatchers;
        if (matchers && matchRuleList(matchers, info)) {
          return sid;
        }
      }
      return UNKNOWN_SOURCE;
    }

    // 判断 URL 是否属于某 source 家族
    function matchesSourceUrlFamily(sourceId, url) {
      var def = sourceDefinitions[sourceId];
      if (!def || !def.familyMatchers) return false;
      var p = parseUrlSafely(url);
      if (!p) return false;
      return matchRuleList(def.familyMatchers, { url: url, hostname: p.hostname });
    }

    // 查询 API
    function getSourceMeta(sourceId) {
      return sourceDefinitions[sourceId] || null;
    }

    function getSourceLabel(sourceId) {
      var meta = sourceDefinitions[sourceId];
      return (meta && meta.label) ? meta.label : sourceId;
    }

    function getDriverIdForSource(sourceId) {
      var meta = sourceDefinitions[sourceId];
      return (meta && meta.driverId) ? meta.driverId : null;
    }

    function getDriverMeta(driverId) {
      return driverDefinitions[driverId] || null;
    }

    function driverAcceptsCommand(driverId, command) {
      var meta = driverDefinitions[driverId];
      if (!meta || !meta.commands) return false;
      return meta.commands.indexOf(command) !== -1;
    }

    function getRegisteredSourceIds() {
      return Object.keys(sourceDefinitions);
    }

    // 解析 alias
    function resolveCanonicalSource(sourceId) {
      return sourceAliases[sourceId] || sourceId;
    }

    return {
      registerSource: registerSource,
      unregisterSource: unregisterSource,
      registerDriver: registerDriver,
      registerFromFlow: registerFromFlow,
      detectSourceFromLocation: detectSourceFromLocation,
      matchesSourceUrlFamily: matchesSourceUrlFamily,
      getSourceMeta: getSourceMeta,
      getSourceLabel: getSourceLabel,
      getDriverIdForSource: getDriverIdForSource,
      getDriverMeta: getDriverMeta,
      driverAcceptsCommand: driverAcceptsCommand,
      getRegisteredSourceIds: getRegisteredSourceIds,
      resolveCanonicalSource: resolveCanonicalSource,
      UNKNOWN_SOURCE: UNKNOWN_SOURCE,
    };
  }

  return {
    createSourceRegistry: createSourceRegistry,
    UNKNOWN_SOURCE: UNKNOWN_SOURCE,
    // 暴露匹配函数以方便外部扩展
    matchRuleList: matchRuleList,
  };
});
