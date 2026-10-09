// User-Agent and Client Hints headers for the extension's own network requests.
(function (root) {
  'use strict';

  function create(userAgent) {
    var ua = String(userAgent || '').trim();
    if (!ua || /[^\x20-\x7e]/.test(ua)) throw new Error('User-Agent 必须是非空的可打印 ASCII 字符串');
    var chromium = /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua);
    var edge = /Edg(?:A)?\/([\d.]+)/.exec(ua);
    var android = /Android\s+([\d.]+)/.exec(ua);
    var ios = /(?:CPU(?: iPhone)? OS|iPhone OS)\s+([\d_]+)/.exec(ua);
    var mac = /Mac OS X\s*([\d_.]*)/.exec(ua);
    var windows = /Windows NT\s+([\d.]+)/.exec(ua);
    var platform = android ? 'Android' : ios ? 'iOS' : windows ? 'Windows' : mac ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    var version = android || ios || mac;
    var platformVersion = version ? (version[1] || '').replace(/_/g, '.') : '';
    // Windows' reduced UA cannot distinguish Windows 10 from 11. Do not invent
    // a Client Hints platformVersion (which also uses a different version scheme).
    if (platformVersion) platformVersion = (platformVersion + '.0.0').split('.').slice(0, 3).join('.');
    var mobile = /Mobile|iPhone|iPod/.test(ua);
    var brands = [];
    var fullVersionList = [];
    if (chromium && !ios) {
      [['Chromium', chromium[1]], [edge ? 'Microsoft Edge' : 'Google Chrome', edge ? edge[1] : chromium[1]]].forEach(function (entry) {
        brands.push({ brand: entry[0], version: entry[1].split('.')[0] });
        fullVersionList.push({ brand: entry[0], version: entry[1] });
      });
    }
    return {
      userAgent: ua,
      hints: brands.length ? {
        brands: brands, mobile: mobile, platform: platform,
        architecture: /aarch64|arm/i.test(ua) ? 'arm' : /x86|x64|Win64|WOW64|Intel/i.test(ua) ? 'x86' : '',
        bitness: /x64|x86_64|Win64|WOW64|aarch64|arm64/i.test(ua) ? '64' : '',
        model: '', platformVersion: platformVersion,
        uaFullVersion: chromium[1], fullVersionList: fullVersionList,
        wow64: /WOW64/.test(ua), formFactors: [mobile ? 'Mobile' : /Android/.test(ua) ? 'Tablet' : 'Desktop'],
      } : null,
    };
  }

  function headerChanges(profile) {
    var hints = profile.hints;
    function brands(values) {
      return values.map(function (entry) { return JSON.stringify(entry.brand) + ';v=' + JSON.stringify(entry.version); }).join(', ');
    }
    var values = hints ? {
      'sec-ch-ua': brands(hints.brands),
      'sec-ch-ua-mobile': hints.mobile ? '?1' : '?0',
      'sec-ch-ua-platform': JSON.stringify(hints.platform),
      'sec-ch-ua-platform-version': JSON.stringify(hints.platformVersion),
      'sec-ch-ua-arch': JSON.stringify(hints.architecture),
      'sec-ch-ua-bitness': JSON.stringify(hints.bitness),
      'sec-ch-ua-model': JSON.stringify(hints.model),
      'sec-ch-ua-full-version': JSON.stringify(hints.uaFullVersion),
      'sec-ch-ua-full-version-list': brands(hints.fullVersionList),
      'sec-ch-ua-wow64': hints.wow64 ? '?1' : '?0',
      'sec-ch-ua-form-factors': hints.formFactors.map(function (value) { return JSON.stringify(value); }).join(', '),
    } : {};
    var names = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version',
      'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-full-version',
      'sec-ch-ua-full-version-list', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors'];
    return [{ header: 'user-agent', operation: 'set', value: profile.userAgent }].concat(names.map(function (name) {
      return Object.prototype.hasOwnProperty.call(values, name)
        ? { header: name, operation: 'set', value: values[name] } : { header: name, operation: 'remove' };
    }));
  }

  root.UserAgentProfile = {
    create: create,
    headerChanges: headerChanges,
  };
})(globalThis);
