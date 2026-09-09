// Proxy Manager — session-scoped chrome.proxy PAC rules.
(function attachProxyManager(root, factory) {
  root.ProxyManager = factory();
})(globalThis, function () {
  function createProxyManager(deps) {
    deps = deps || {};
    var chromeApi = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || null;
    var proxyScope = deps.incognito === true ? 'incognito_session_only' : 'regular';
    var sessionRules = {};
    var opQueue = Promise.resolve();

    function enqueue(action) {
      var run = opQueue.then(action, action);
      opQueue = run.catch(function () {});
      return run;
    }

    function cloneRule(rule) {
      var copy = Object.assign({}, rule || {});
      copy.bypassList = Array.isArray(rule && rule.bypassList) ? rule.bypassList.slice() : [];
      return copy;
    }

    function collectRules() {
      var rules = [];
      Object.keys(sessionRules).forEach(function (sessionId) {
        Object.keys(sessionRules[sessionId] || {}).forEach(function (ruleId) {
          rules.push(sessionRules[sessionId][ruleId]);
        });
      });
      return rules.sort(function (a, b) {
        return (b.appliedAt || 0) - (a.appliedAt || 0);
      });
    }

    function buildPacScript(rules) {
      var lines = [
        'function FindProxyForURL(url, host) {',
        '  host = String(host || "").toLowerCase();',
      ];
      rules.forEach(function (rule) {
        lines.push('  if (shExpMatch(host, ' + JSON.stringify(rule.hostPattern) + ')) {');
        (rule.bypassList || []).forEach(function (pattern) {
          if (!pattern) return;
          if (pattern === '<local>') {
            lines.push('    if (isPlainHostName(host)) return "DIRECT";');
          } else {
            lines.push('    if (shExpMatch(host, ' + JSON.stringify(pattern) + ')) return "DIRECT";');
          }
        });
        lines.push('    return ' + JSON.stringify(rule.proxyPacValue) + ';');
        lines.push('  }');
      });
      lines.push('  return "DIRECT";');
      lines.push('}');
      return lines.join('\n');
    }

    function setProxyConfig(value) {
      return new Promise(function (resolve, reject) {
        if (!chromeApi.proxy || !chromeApi.proxy.settings) {
          reject(new Error('当前环境不支持 chrome.proxy'));
          return;
        }
        chromeApi.proxy.settings.set({ value: value, scope: proxyScope }, function () {
          if (chromeApi.runtime.lastError) {
            reject(new Error('设置代理失败: ' + chromeApi.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    }

    function clearProxyConfig() {
      return new Promise(function (resolve, reject) {
        if (!chromeApi.proxy || !chromeApi.proxy.settings) {
          reject(new Error('当前环境不支持 chrome.proxy'));
          return;
        }
        chromeApi.proxy.settings.clear({ scope: proxyScope }, function () {
          if (chromeApi.runtime.lastError) {
            reject(new Error('清除代理失败: ' + chromeApi.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    }

    function applyCurrentRules(reason) {
      var rules = collectRules();
      if (!rules.length) {
        return clearProxyConfig().then(function () {
          if (addLog) addLog('浏览器代理规则已全部清除，已释放扩展代理控制' + (reason ? ': ' + reason : ''));
          return { activeRules: 0 };
        });
      }
      var pacScript = buildPacScript(rules);
      return setProxyConfig({
        mode: 'pac_script',
        pacScript: { data: pacScript },
      }).then(function () {
        if (addLog) addLog('浏览器代理 PAC 已更新，活跃规则 ' + rules.length + ' 条');
        return { activeRules: rules.length, pacScript: pacScript };
      });
    }

    function setRule(session, rule) {
      if (!session || !session.runId) return Promise.reject(new Error('代理规则缺少运行会话，无法保证自动清理'));
      return enqueue(function () {
        var sessionId = session.runId;
        var ruleId = rule.ruleId || String(rule.tabId || rule.hostPattern || Date.now());
        var copy = cloneRule(rule);
        copy.sessionId = sessionId;
        copy.ruleId = ruleId;
        copy.appliedAt = Date.now();
        if (!sessionRules[sessionId]) sessionRules[sessionId] = {};
        sessionRules[sessionId][ruleId] = copy;
        session.proxyConfigs = session.proxyConfigs || {};
        session.proxyConfigs[ruleId] = copy;
        return applyCurrentRules('set').then(function (result) {
          return Object.assign({ rule: copy }, result);
        });
      });
    }

    function clearSession(session, reason) {
      var sessionId = typeof session === 'string' ? session : (session && session.runId);
      if (!sessionId) return Promise.resolve({ cleared: false, activeRules: collectRules().length });
      return enqueue(function () {
        var hadRules = !!(sessionRules[sessionId] && Object.keys(sessionRules[sessionId]).length);
        delete sessionRules[sessionId];
        if (session && session.proxyConfigs) session.proxyConfigs = {};
        if (!hadRules) return { cleared: false, activeRules: collectRules().length };
        return applyCurrentRules(reason || 'clear_session').then(function (result) {
          return Object.assign({ cleared: true }, result);
        });
      });
    }

    return {
      scope: proxyScope,
      setRule: setRule,
      clearSession: clearSession,
      getActiveRules: collectRules,
    };
  }

  return { createProxyManager: createProxyManager };
});
