// Proxy Manager — one browser proxy configuration, with flow rules before the system default.
(function attachProxyManager(root, factory) {
  root.ProxyManager = factory();
})(globalThis, function () {
  var PROXY_PAC_TYPES = { http: 'PROXY', https: 'HTTPS', socks4: 'SOCKS', socks5: 'SOCKS5' };

  function parseProxyServer(raw) {
    var text = String(raw || '').trim();
    if (!text) throw new Error('代理服务器地址不能为空');
    if (text.length > 2048 || /\s/.test(text)) throw new Error('代理服务器地址过长或包含空白字符');
    var urlText = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text;
    var url;
    try { url = new URL(urlText); }
    catch (_) { throw new Error('代理服务器格式无效，应为 host:port 或 scheme://host:port'); }
    var scheme = url.protocol.slice(0, -1).toLowerCase();
    if (!PROXY_PAC_TYPES[scheme]) throw new Error('不支持的代理协议（支持 http/https/socks4/socks5）');
    if (url.username || url.password || urlText.split('/')[2].indexOf('@') !== -1) {
      throw new Error('请在代理用户名和密码字段填写认证信息');
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash || /[\\?#]/.test(urlText)) {
      throw new Error('代理服务器只填写 host:port，不支持路径、查询参数或 hash');
    }
    // URL.port omits explicit default ports such as http://host:80.
    var authority = urlText.slice(urlText.indexOf('://') + 3).replace(/\/$/, '');
    var portMatch = /:(\d+)$/.exec(authority);
    var port = portMatch ? Number(portMatch[1]) : 0;
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('代理服务器必须包含 host 和 1-65535 之间的 port');
    }
    var server = url.hostname + ':' + port;
    return { scheme: scheme, host: url.hostname, port: port, server: server, pacValue: PROXY_PAC_TYPES[scheme] + ' ' + server };
  }

  function normalizeHostPattern(raw, label, allowLocal) {
    var text = String(raw || '').trim().toLowerCase();
    label = label || '匹配域名';
    if (allowLocal && text === '<local>') return text;
    if (!text || text.length > 253 || !/^[a-z0-9*?.:_\-\[\]]+$/.test(text)) {
      throw new Error(label + '应为域名、IP 或主机通配符，不支持 URL 和路径');
    }
    return text;
  }

  function parseHostList(raw, label, allowLocal) {
    var text = String(raw || '');
    if (text.length > 8192) throw new Error(label + '过长');
    return text.split(/[,\n]/).map(function (item) { return item.trim(); }).filter(Boolean).map(function (item) {
      return normalizeHostPattern(item, label, allowLocal);
    });
  }

  function parseAuthentication(proxy, username, password) {
    username = String(username || '');
    password = String(password || '');
    if (!username && !password) return null;
    if (proxy.scheme !== 'http' && proxy.scheme !== 'https') {
      throw new Error('Chrome 原生 SOCKS 代理不支持用户名密码认证，请使用 HTTP 代理或无认证 SOCKS5 代理');
    }
    if (!username || username.length > 1024 || password.length > 1024 || /[\r\n\x00:]/.test(username) || /[\r\n\x00]/.test(password)) {
      throw new Error('代理用户名不能为空，用户名和密码不得包含换行或超过 1024 字符，用户名不能包含冒号');
    }
    return { username: username, password: password };
  }

  function hostMatches(host, pattern) {
    if (pattern === '<local>') return host.indexOf('.') === -1;
    var expression = pattern.split('').map(function (character) {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return /[a-z0-9_:]/i.test(character) ? character : '\\' + character;
    }).join('');
    return new RegExp('^' + expression + '$', 'i').test(host);
  }

  function publicRule(rule) {
    var value = Object.assign({}, rule);
    if (Array.isArray(rule.hostPatterns)) value.hostPatterns = rule.hostPatterns.slice();
    if (Array.isArray(rule.bypassList)) value.bypassList = rule.bypassList.slice();
    delete value.authCredentials;
    return value;
  }

  function createProxyManager(deps) {
    deps = deps || {};
    var chromeApi = deps.chrome || globalThis.chrome;
    var addLog = deps.addLog || null;
    var proxyScope = deps.incognito === true ? 'incognito_session_only' : 'regular';
    var sessionRules = {};
    var opQueue = Promise.resolve();
    var settingsApi = globalThis.PageAutomationSystemSettings;
    var systemProxy = null;
    var systemProxyServer = null;
    var systemProxySignature = null;
    var authAttempts = new Map();

    function enqueue(action) {
      var run = opQueue.then(action, action);
      opQueue = run.catch(function () {});
      return run;
    }

    function cloneRule(rule) {
      var copy = Object.assign({}, rule || {});
      if (Array.isArray(copy.hostPatterns)) copy.hostPatterns = copy.hostPatterns.slice();
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
      routingRules(rules).forEach(function (rule) {
        var matches = (rule.hostPatterns || [rule.hostPattern]).map(function (pattern) {
          return 'shExpMatch(host, ' + JSON.stringify(pattern) + ')';
        });
        lines.push('  if (' + matches.join(' || ') + ') {');
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

    function routingRules(rules) {
      return systemProxy ? rules.concat([systemProxy]) : rules;
    }

    function proxyEndpoint(host, port) {
      return String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') + ':' + Number(port);
    }

    function assertCompatibleAuthentication() {
      var credentials = new Map();
      routingRules(collectRules()).forEach(function (rule) {
        var endpoint = proxyEndpoint(rule.host, rule.port);
        var identity = JSON.stringify(rule.authCredentials || null);
        if (credentials.has(endpoint) && credentials.get(endpoint) !== identity) {
          throw new Error('同一代理服务器不能同时配置不同的认证信息: ' + endpoint);
        }
        credentials.set(endpoint, identity);
      });
    }

    function handleProxyAuth(details, callback) {
      if (!details.isProxy) { callback({}); return; }
      // Restore persisted credentials before answering a challenge that wakes the worker.
      sync().then(readStatus).then(function (status) {
        if (!status.controlledByThisExtension) return {};
        var host = new URL(details.url).hostname.toLowerCase();
        var rules = routingRules(collectRules());
        var rule = rules.find(function (candidate) {
          return (candidate.hostPatterns || [candidate.hostPattern]).some(function (pattern) { return hostMatches(host, pattern); });
        });
        if (!rule || !rule.authCredentials || rule.bypassList.some(function (pattern) { return hostMatches(host, pattern); })) return {};
        var challenger = details.challenger || {};
        var endpoint = proxyEndpoint(rule.host, rule.port);
        if (endpoint !== proxyEndpoint(challenger.host, challenger.port)) return {};
        var attempts = authAttempts.get(details.requestId) || new Set();
        if (attempts.has(endpoint)) return { cancel: true };
        attempts.add(endpoint);
        authAttempts.set(details.requestId, attempts);
        return { authCredentials: rule.authCredentials };
      }).then(callback, function (error) {
        console.error('[Proxy] 处理代理认证失败:', error);
        callback({});
      });
    }

    function clearAuthAttempt(details) { authAttempts.delete(details.requestId); }

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

    function readStatus() {
      return new Promise(function (resolve, reject) {
        if (!chromeApi.proxy || !chromeApi.proxy.settings) {
          reject(new Error('当前环境不支持 chrome.proxy'));
          return;
        }
        chromeApi.proxy.settings.get({ incognito: deps.incognito === true }, function (details) {
          if (chromeApi.runtime.lastError) {
            reject(new Error('读取代理状态失败: ' + chromeApi.runtime.lastError.message));
            return;
          }
          if (!details) {
            reject(new Error('浏览器未返回代理状态'));
            return;
          }
          resolve({
            levelOfControl: details.levelOfControl,
            controlledByThisExtension: details.levelOfControl === 'controlled_by_this_extension',
            mode: details.value && details.value.mode || '',
            scope: proxyScope,
            systemProxyServer: systemProxyServer || '',
            activeRules: collectRules().length,
          });
        });
      });
    }

    function applyCurrentRules(reason) {
      assertCompatibleAuthentication();
      var rules = collectRules();
      if (!rules.length && !systemProxy) {
        return clearProxyConfig().then(function () {
          if (addLog) addLog('浏览器代理规则已全部清除，已释放扩展代理控制' + (reason ? ': ' + reason : ''));
          return readStatus();
        });
      }
      var pacScript = buildPacScript(rules);
      var value = {
        mode: 'pac_script',
        pacScript: { data: pacScript, mandatory: true },
      };
      return setProxyConfig(value).then(readStatus).then(function (status) {
        if (addLog) addLog(status.controlledByThisExtension
          ? '浏览器代理已应用，流程规则 ' + rules.length + ' 条，系统代理' + (systemProxy ? '已启用' : '未启用')
          : '代理配置已登记，但当前浏览器代理未由本扩展控制', { level: status.controlledByThisExtension ? 'info' : 'warn' });
        return Object.assign(status, { pacScript: pacScript });
      });
    }

    async function applySystemSettings(settings) {
      var server = settings.proxyServer;
      var signature = JSON.stringify(settingsApi.PROXY_FIELDS.map(function (key) { return settings[key]; }));
      if (signature === systemProxySignature) return;
      var hostPatterns = parseHostList(settings.proxyHostPatterns, '匹配域名', false);
      var bypassList = parseHostList(settings.proxyBypassList, '绕过域名', true);
      var parsed = server ? parseProxyServer(server) : null;
      if (parsed) {
        parsed.authCredentials = parseAuthentication(parsed, settings.proxyUsername, settings.proxyPassword);
        parsed.hostPatterns = hostPatterns.length ? hostPatterns : ['*'];
        parsed.bypassList = bypassList;
        parsed.proxyPacValue = parsed.pacValue;
      }
      var previous = systemProxy;
      systemProxy = parsed;
      try {
        await applyCurrentRules('system_settings');
        systemProxyServer = server;
        systemProxySignature = signature;
      } catch (error) {
        systemProxy = previous;
        try { await applyCurrentRules('rollback'); }
        catch (rollbackError) { console.error('[Proxy] 恢复代理失败:', rollbackError); }
        throw error;
      }
    }

    function sync() {
      return enqueue(async function () {
        var settings = await settingsApi.load(chromeApi.storage.local, chromeApi.runtime);
        await applySystemSettings(settings);
        return settings;
      });
    }

    function saveSystemSettings(value) {
      return enqueue(async function () {
        var previous = await settingsApi.load(chromeApi.storage.local, chromeApi.runtime);
        var next = settingsApi.normalize(value);
        try {
          await applySystemSettings(next);
          return await deps.saveSettings(next);
        } catch (error) {
          try { await applySystemSettings(previous); }
          catch (rollbackError) { console.error('[Proxy] 恢复系统代理失败:', rollbackError); }
          throw error;
        }
      });
    }

    function setRule(session, rule) {
      if (!session || !session.runId) return Promise.reject(new Error('代理规则缺少运行会话，无法保证自动清理'));
      return enqueue(async function () {
        var status = await readStatus();
        if (status.levelOfControl === 'controlled_by_other_extensions' || status.levelOfControl === 'not_controllable') {
          throw new Error('无法设置流程代理：浏览器代理由其他扩展或策略控制');
        }
        var sessionId = session.runId;
        var ruleId = rule.ruleId || String(rule.tabId || rule.hostPattern || Date.now());
        var copy = cloneRule(rule);
        var proxy = parseProxyServer(copy.proxyScheme + '://' + copy.proxyServer);
        copy.host = proxy.host;
        copy.port = proxy.port;
        copy.authCredentials = parseAuthentication(proxy, copy.proxyUsername, copy.proxyPassword);
        delete copy.proxyUsername;
        delete copy.proxyPassword;
        copy.sessionId = sessionId;
        copy.ruleId = ruleId;
        copy.appliedAt = Date.now();
        if (!sessionRules[sessionId]) sessionRules[sessionId] = {};
        var previous = sessionRules[sessionId][ruleId];
        sessionRules[sessionId][ruleId] = copy;
        session.proxyConfigs = session.proxyConfigs || {};
        try {
          var result = await applyCurrentRules('set');
          if (!result.controlledByThisExtension) throw new Error('流程代理未生效：浏览器代理未由本扩展控制');
          session.proxyConfigs[ruleId] = publicRule(copy);
          return Object.assign({ rule: publicRule(copy) }, result);
        } catch (error) {
          if (previous) sessionRules[sessionId][ruleId] = previous;
          else delete sessionRules[sessionId][ruleId];
          try { await applyCurrentRules('rollback'); }
          catch (rollbackError) { console.error('[Proxy] 恢复流程代理失败:', rollbackError); }
          throw error;
        }
      });
    }

    function clearSession(session, reason) {
      var sessionId = typeof session === 'string' ? session : (session && session.runId);
      if (!sessionId) return Promise.resolve({ cleared: false, activeRules: collectRules().length });
      return enqueue(async function () {
        var hadRules = !!(sessionRules[sessionId] && Object.keys(sessionRules[sessionId]).length);
        if (!hadRules) return { cleared: false, activeRules: collectRules().length };
        var previous = sessionRules[sessionId];
        delete sessionRules[sessionId];
        try {
          var result = await applyCurrentRules(reason || 'clear_session');
          if (session && session.proxyConfigs) session.proxyConfigs = {};
          return Object.assign({ cleared: true }, result);
        } catch (error) {
          sessionRules[sessionId] = previous;
          try { await applyCurrentRules('rollback'); }
          catch (rollbackError) { console.error('[Proxy] 恢复会话代理失败:', rollbackError); }
          throw error;
        }
      });
    }

    chromeApi.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[settingsApi.SETTINGS_KEY]) return;
      sync().catch(function (error) { console.error('[Proxy] 应用系统代理失败:', error); });
    });
    if (chromeApi.webRequest && chromeApi.webRequest.onAuthRequired) {
      chromeApi.webRequest.onAuthRequired.addListener(handleProxyAuth, { urls: ['<all_urls>'] }, ['asyncBlocking']);
      chromeApi.webRequest.onCompleted.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });
      chromeApi.webRequest.onErrorOccurred.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });
    }
    sync().catch(function (error) { console.error('[Proxy] 初始化失败:', error); });

    return {
      scope: proxyScope,
      sync: sync,
      saveSystemSettings: saveSystemSettings,
      getStatus: function () { return enqueue(readStatus); },
      setRule: setRule,
      clearSession: clearSession,
      getActiveRules: function () { return collectRules().map(publicRule); },
    };
  }

  return {
    createProxyManager: createProxyManager, parseProxyServer: parseProxyServer,
    parseHostList: parseHostList,
  };
});
