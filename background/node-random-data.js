// Random data node executor helpers.
(function attachNodeRandomData(root, factory) {
  root.NodeRandomData = factory();
})(globalThis, function () {
  'use strict';

  var RANDOM_SURNAMES = ['张', '王', '李', '赵', '刘', '陈', '杨', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '高', '罗', '郑', '梁'];
  var RANDOM_GIVENS_MALE = ['伟', '磊', '军', '洋', '勇', '杰', '涛', '明', '超', '平', '辉', '宇', '强', '健', '峰', '晨'];
  var RANDOM_GIVENS_FEMALE = ['芳', '娜', '敏', '静', '艳', '霞', '婷', '雪', '琳', '欣', '慧', '佳', '倩', '蕾', '雅', '雯'];
  var RANDOM_AREAS = [
    { code: '110105', province: '北京市', city: '北京市', county: '朝阳区' },
    { code: '310104', province: '上海市', city: '上海市', county: '徐汇区' },
    { code: '440106', province: '广东省', city: '广州市', county: '天河区' },
    { code: '440305', province: '广东省', city: '深圳市', county: '南山区' },
    { code: '330106', province: '浙江省', city: '杭州市', county: '西湖区' },
    { code: '320106', province: '江苏省', city: '南京市', county: '鼓楼区' },
    { code: '510107', province: '四川省', city: '成都市', county: '武侯区' },
    { code: '420106', province: '湖北省', city: '武汉市', county: '武昌区' },
    { code: '610113', province: '陕西省', city: '西安市', county: '雁塔区' },
    { code: '500103', province: '重庆市', city: '重庆市', county: '渝中区' },
  ];
  var RANDOM_STREETS = ['建设路', '人民路', '中山路', '解放路', '科技路', '文一路', '长安街', '滨河路', '软件大道', '创业路'];
  var RANDOM_COMPANY_WORDS = ['华信', '云启', '启明', '中科', '远航', '新联', '智维', '数源', '蓝海', '卓越'];
  var RANDOM_COMPANY_SUFFIXES = ['科技有限公司', '信息技术有限公司', '网络科技有限公司', '软件有限公司', '数据服务有限公司', '电子商务有限公司'];
  var PHONE_PREFIXES = ['130', '131', '132', '135', '136', '137', '138', '139', '150', '151', '152', '157', '158', '159', '170', '171', '172', '178', '180', '181', '182', '183', '185', '186', '187', '188', '198', '199'];
  var BANK_BINS = ['622000', '621000', '623000', '622202', '621226', '622848', '621661'];

  function hashSeed(seed) {
    var text = String(seed || '');
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function createRandom(seed) {
    if (seed === undefined || seed === null || seed === '') return Math.random;
    var a = hashSeed(seed);
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(min, max, rng) {
    rng = rng || Math.random;
    min = Math.ceil(Number(min) || 0);
    max = Math.floor(Number(max) || 0);
    if (min > max) { var t = min; min = max; max = t; }
    return Math.floor(rng() * (max - min + 1)) + min;
  }

  function pickRandom(arr, rng) {
    return arr[randInt(0, arr.length - 1, rng)];
  }

  function padLeft(value, len) {
    var s = String(value);
    while (s.length < len) s = '0' + s;
    return s;
  }

  function pad2(n) { return padLeft(n, 2); }

  function charsetFor(name, customChars) {
    if (name === 'alpha') return 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (name === 'lower') return 'abcdefghijklmnopqrstuvwxyz';
    if (name === 'upper') return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (name === 'digits') return '0123456789';
    if (name === 'hex') return '0123456789abcdef';
    if (name === 'password') return 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_-+=';
    if (name === 'custom' && customChars) return String(customChars);
    return 'abcdefghijklmnopqrstuvwxyz0123456789';
  }

  function randString(length, charset, customChars, rng) {
    var chars = charsetFor(charset || 'alnum', customChars);
    var out = '';
    length = Number(length);
    if (isNaN(length)) length = 8;
    length = Math.max(0, Math.floor(length));
    for (var i = 0; i < length; i++) out += chars.charAt(randInt(0, chars.length - 1, rng));
    return out;
  }

  function randomUuid(rng) {
    var bytes = [];
    for (var i = 0; i < 16; i++) bytes.push(randInt(0, 255, rng));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = bytes.map(function (b) { return padLeft(b.toString(16), 2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function normalizeGender(gender, rng) {
    if (gender === 'male' || gender === 'female') return gender;
    return rng() < 0.5 ? 'male' : 'female';
  }

  function randomName(params, rng) {
    var gender = normalizeGender(params.gender, rng);
    var givenPool = gender === 'female' ? RANDOM_GIVENS_FEMALE : RANDOM_GIVENS_MALE;
    return pickRandom(RANDOM_SURNAMES, rng)
      + pickRandom(givenPool, rng)
      + (rng() < 0.55 ? pickRandom(givenPool, rng) : '');
  }

  function parseDateInput(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    var d = new Date(raw);
    return isNaN(d.getTime()) ? fallback : d;
  }

  function randomDateBetween(from, to, rng) {
    var start = from.getTime();
    var end = to.getTime();
    if (start > end) { var t = start; start = end; end = t; }
    return new Date(start + Math.floor(rng() * (end - start + 1)));
  }

  function formatDate(d, format) {
    format = format || 'YYYY-MM-DD';
    if (format === 'timestamp') return d.getTime();
    if (format === 'iso') return d.toISOString();
    var map = {
      YYYY: String(d.getFullYear()),
      MM: pad2(d.getMonth() + 1),
      DD: pad2(d.getDate()),
      HH: pad2(d.getHours()),
      mm: pad2(d.getMinutes()),
      ss: pad2(d.getSeconds()),
    };
    return String(format).replace(/YYYY|MM|DD|HH|mm|ss/g, function (token) { return map[token]; });
  }

  function randomBirthdayDate(params, rng) {
    var minAge = Number(params.minAge);
    var maxAge = Number(params.maxAge);
    if (isNaN(minAge)) minAge = 18;
    if (isNaN(maxAge)) maxAge = 65;
    minAge = Math.max(0, minAge);
    maxAge = Math.max(minAge, maxAge);
    var now = new Date();
    var latest = new Date(now.getFullYear() - minAge, now.getMonth(), now.getDate(), 23, 59, 59);
    var earliest = new Date(now.getFullYear() - maxAge, now.getMonth(), now.getDate(), 0, 0, 0);
    return randomDateBetween(earliest, latest, rng);
  }

  function randomGenericDate(params, rng) {
    var now = Date.now();
    var from = parseDateInput(params.dateFrom, new Date(now - 365 * 24 * 60 * 60 * 1000));
    var to = parseDateInput(params.dateTo, new Date(now + 365 * 24 * 60 * 60 * 1000));
    return randomDateBetween(from, to, rng);
  }

  function normalizeAreaCode(areaCode, rng) {
    var code = String(areaCode || '').replace(/\D/g, '');
    if (/^\d{6}$/.test(code)) return code;
    return pickRandom(RANDOM_AREAS, rng).code;
  }

  function idCardCheckDigit(body17) {
    var weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    var codes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += Number(body17.charAt(i)) * weights[i];
    return codes[sum % 11];
  }

  function randomIdCard(params, rng) {
    var gender = normalizeGender(params.gender, rng);
    var area = normalizeAreaCode(params.areaCode, rng);
    var birth = formatDate(randomBirthdayDate(params, rng), 'YYYYMMDD');
    var seq = gender === 'male' ? (randInt(0, 499, rng) * 2 + 1) : (randInt(1, 499, rng) * 2);
    var body = area + birth + padLeft(seq, 3);
    return body + idCardCheckDigit(body);
  }

  function luhnCheckDigit(body) {
    var sum = 0;
    var doubleDigit = true;
    for (var i = body.length - 1; i >= 0; i--) {
      var d = Number(body.charAt(i));
      if (doubleDigit) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      doubleDigit = !doubleDigit;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function randomBankCard(params, rng) {
    var length = Math.max(12, Math.min(30, Number(params.cardLength) || 19));
    var bin = String(params.cardBin || pickRandom(BANK_BINS, rng)).replace(/\D/g, '');
    if (!bin) bin = '622000';
    if (bin.length >= length) bin = bin.slice(0, length - 1);
    var body = bin + randString(length - bin.length - 1, 'digits', '', rng);
    return body + luhnCheckDigit(body);
  }

  function randomPhone(rng) {
    return pickRandom(PHONE_PREFIXES, rng) + randString(8, 'digits', '', rng);
  }

  function cleanEmailLocal(text) {
    var cleaned = String(text || '').replace(/[^a-zA-Z0-9._+-]/g, '');
    return cleaned || 'test';
  }

  function randomEmail(params, rng) {
    var domain = String(params.emailDomain || 'example.com').replace(/^@+/, '').trim() || 'example.com';
    return cleanEmailLocal((params.prefix || 'test_') + randString(8, 'lower', '', rng)) + '@' + domain;
  }

  function randomAddress(rng) {
    var area = pickRandom(RANDOM_AREAS, rng);
    return area.province + area.city + area.county + pickRandom(RANDOM_STREETS, rng) + randInt(1, 999, rng) + '号';
  }

  function randomCompany(rng) {
    var area = pickRandom(RANDOM_AREAS, rng);
    var city = area.city.replace(/市$/, '');
    return city + pickRandom(RANDOM_COMPANY_WORDS, rng) + pickRandom(RANDOM_COMPANY_SUFFIXES, rng);
  }

  function randomUrl(params, rng) {
    var domain = String(params.emailDomain || 'example.com').replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || 'example.com';
    var prefix = params.prefix || 'test-';
    return 'https://' + domain + '/' + cleanEmailLocal(prefix + randString(8, 'lower', '', rng));
  }

  function randomIp(rng) {
    var first = randInt(1, 223, rng);
    if (first === 127) first = 126;
    return [first, randInt(0, 255, rng), randInt(0, 255, rng), randInt(1, 254, rng)].join('.');
  }

  function defaultSetObjectPath(obj, path, value) {
    var normalized = String(path || '').replace(/\[(\d+)\]/g, '.$1');
    var parts = normalized.split('.').filter(Boolean);
    if (!parts.length) return value;
    if (parts.some(function (part) { return /^(?:__proto__|prototype|constructor)$/.test(part); })) {
      throw new Error('随机数据字段路径不能包含保留字段');
    }
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i];
      if (!Object.prototype.hasOwnProperty.call(cur, p) || !cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }

  function createRandomDataExecutor(deps) {
    deps = deps || {};
    var parseJsonValue = deps.parseJsonValue || function (raw, fallback) {
      if (raw === undefined || raw === null || raw === '') return fallback;
      if (typeof raw !== 'string') return raw;
      try { return JSON.parse(raw); } catch (_) { return fallback; }
    };
    var setObjectPath = deps.setObjectPath || defaultSetObjectPath;

    function parseRandomFields(raw) {
      if (raw === undefined || raw === null || raw === '') return [];
      if (typeof raw === 'object') {
        if (Array.isArray(raw)) {
          return raw.map(normalizeRandomField).filter(Boolean);
        }
        return Object.keys(raw).map(function (field) {
          var spec = raw[field];
          if (typeof spec === 'string') return normalizeRandomField({ field: field, kind: spec });
          if (spec && typeof spec === 'object') return normalizeRandomField(Object.assign({ field: field }, spec));
          return normalizeRandomField({ field: field, value: spec });
        }).filter(Boolean);
      }
      var text = String(raw || '').trim();
      if (!text) return [];
      if (text.charAt(0) === '[' || text.charAt(0) === '{') {
        return parseRandomFields(parseJsonValue(text, [], '随机数据字段模板'));
      }
      return text.split('\n').map(function (line) {
        line = line.trim();
        if (!line || line.charAt(0) === '#') return null;
        var parts = line.split('|');
        var params = {};
        if (parts.length > 2) params = parseJsonValue(parts.slice(2).join('|'), {}, '随机数据字段参数');
        return normalizeRandomField({ field: parts[0], kind: parts[1] || 'string', params: params });
      }).filter(Boolean);
    }

    function normalizeRandomField(spec) {
      if (!spec) return null;
      var field = String(spec.field || spec.name || spec.key || '').trim();
      if (!field) return null;
      var params = spec.params || spec.options || {};
      if (typeof params === 'string') params = parseJsonValue(params, {}, '随机数据字段参数');
      var merged = Object.assign({}, params, spec);
      delete merged.field;
      delete merged.name;
      delete merged.key;
      delete merged.params;
      delete merged.options;
      var hasValue = Object.prototype.hasOwnProperty.call(spec, 'value');
      return {
        field: field,
        kind: spec.kind || spec.type || merged.kind || 'string',
        params: merged,
        hasValue: hasValue,
        value: spec.value,
      };
    }

    function generateRandomValue(params, rng) {
      params = params || {};
      rng = rng || Math.random;
      var kind = String(params.kind || 'string');
      var min = Number(params.min);
      var max = Number(params.max);
      if (isNaN(min)) min = 0;
      if (isNaN(max)) max = 100;
      var length = Math.max(1, Number(params.length) || 8);
      var decimals = Math.max(0, Math.min(10, Number(params.decimals) || 2));
      var prefix = String(params.prefix || '');
      var suffix = String(params.suffix || '');

      switch (kind) {
        case 'uuid':
          return randomUuid(rng);
        case 'int':
        case 'integer':
        case 'number':
          return randInt(min, max, rng);
        case 'float': {
          if (min > max) { var t = min; min = max; max = t; }
          var scale = Math.pow(10, decimals);
          return Math.round((min + rng() * (max - min)) * scale) / scale;
        }
        case 'digits':
          return prefix + randString(length, 'digits', '', rng) + suffix;
        case 'name':
          return randomName(params, rng);
        case 'phone':
        case 'mobile':
          return randomPhone(rng);
        case 'email':
          return randomEmail(params, rng);
        case 'username':
          return cleanEmailLocal((prefix || 'user_') + randString(length, 'lower', '', rng) + suffix);
        case 'password':
          return randString(Math.max(8, length), params.charset === 'alnum' ? 'password' : params.charset, params.customChars, rng);
        case 'idCard':
        case 'idcard':
        case 'identityCard':
          return randomIdCard(params, rng);
        case 'bankCard':
        case 'bankcard':
        case 'creditCard':
          return randomBankCard(params, rng);
        case 'birthday':
          return formatDate(randomBirthdayDate(params, rng), params.dateFormat || 'YYYY-MM-DD');
        case 'date':
          return formatDate(randomGenericDate(params, rng), params.dateFormat || 'YYYY-MM-DD');
        case 'timestamp':
          return Date.now();
        case 'datetime':
          return formatDate(new Date(), 'YYYY-MM-DD HH:mm:ss');
        case 'address':
          return randomAddress(rng);
        case 'province':
          return pickRandom(RANDOM_AREAS, rng).province;
        case 'city':
          return pickRandom(RANDOM_AREAS, rng).city;
        case 'company':
          return randomCompany(rng);
        case 'url':
          return randomUrl(params, rng);
        case 'ip':
        case 'ipv4':
          return randomIp(rng);
        case 'boolean':
        case 'bool':
          return rng() < 0.5;
        default:
          return prefix + randString(length, params.charset, params.customChars, rng) + suffix;
      }
    }

    function generateRandomItems(count, unique, factory) {
      var items = [];
      var seen = {};
      for (var i = 0; i < count; i++) {
        var value = factory(i);
        if (unique) {
          var attempts = 0;
          var key = JSON.stringify(value);
          while (seen[key] && attempts < 50) {
            value = factory(i);
            key = JSON.stringify(value);
            attempts++;
          }
          seen[key] = true;
        }
        items.push(value);
      }
      return items;
    }

    function generateRandomObject(fields, baseParams, rng, rowIndex) {
      var out = {};
      fields.forEach(function (field) {
        var params = Object.assign({}, baseParams, field.params || {}, { kind: field.kind });
        params.fields = '';
        params.count = 1;
        params.seed = '';
        params.unique = false;
        params.rowIndex = rowIndex;
        var value = field.hasValue ? field.value : generateRandomValue(params, rng);
        setObjectPath(out, field.field, value);
      });
      return out;
    }

    function execRandomData(params) {
      params = params || {};
      var rng = createRandom(params.seed);
      var count = Math.max(1, Math.min(10000, Number(params.count) || 1));
      var fields = parseRandomFields(params.fields);

      if (fields.length) {
        var objects = generateRandomItems(count, params.unique === true, function (index) {
          return generateRandomObject(fields, params, rng, index);
        });
        if (params.outputMode === 'array' || count > 1) return { items: objects, count: objects.length };
        return objects[0] || {};
      }

      var values = generateRandomItems(count, params.unique === true, function () {
        return generateRandomValue(params, rng);
      });
      if (params.outputMode === 'array' || count > 1) return { items: values, count: values.length };
      return values[0];
    }

    return {
      execRandomData: execRandomData,
    };
  }

  return {
    createRandomDataExecutor: createRandomDataExecutor,
  };
});
