// Data transformation and checkpoint node helpers.
(function attachNodeDataOps(root, factory) {
  root.NodeDataOps = factory();
})(globalThis, function () {
  'use strict';

  function createDataOps(deps) {
    deps = deps || {};
    var chrome = deps.chrome || globalThis.chrome;
    var getRunCtx = deps.getRunCtx || function () { return {}; };
    var runCtx = getRunCtx() || {};
    var parseJsonValue = deps.parseJsonValue;
    var getContentValue = deps.getContentValue;
    var resolveCtxValue = deps.resolveCtxValue;
    var ensureArrayValue = deps.ensureArrayValue;
    var cloneJsonSafe = deps.cloneJsonSafe;
    var splitList = deps.splitList;
    var getObjectPath = deps.getObjectPath;
    var setObjectPath = deps.setObjectPath;
    var deleteObjectPath = deps.deleteObjectPath;
    var storageGet = deps.storageGet;
    var storageSet = deps.storageSet;
    var checkpointsKey = deps.checkpointsKey || 'automation_checkpoints';
    var clearDebugTrace = deps.clearDebugTrace || function () { return 0; };
    var compactEphemeralRunState = deps.compactEphemeralRunState || function () { return {}; };
    var CHECKPOINTS_KEY = checkpointsKey;

    function ensureNotAborted(execution) {
      var signal = execution && execution.signal;
      if (!signal || signal.aborted !== true) return;
      if (signal.reason instanceof Error) throw signal.reason;
      throw new Error('检查点操作已停止');
    }

    function abortable(value, execution) {
      var signal = execution && execution.signal;
      if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(value);
      if (signal.aborted) {
        Promise.resolve(value).catch(function () {});
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('检查点操作已停止'));
      }
      return new Promise(function (resolve, reject) {
        var settled = false;
        function cleanup() {
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        }
        function onAbort() {
          if (settled) return;
          settled = true;
          cleanup();
          reject(signal.reason instanceof Error ? signal.reason : new Error('检查点操作已停止'));
        }
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(value).then(function (result) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        }, function (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
    }

    function markUncertain(error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        try { error.performed = 'unknown'; error.retryable = false; } catch (_) {}
      }
      return error;
    }

    function defineDataProperty(target, key, value) {
      Object.defineProperty(target, String(key), {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return value;
    }

    function mergeDataRecords() {
      var output = {};
      for (var sourceIndex = 0; sourceIndex < arguments.length; sourceIndex++) {
        var source = arguments[sourceIndex];
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
        Object.keys(source).forEach(function (key) {
          var descriptor;
          try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch (_) {}
          if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            defineDataProperty(output, key, descriptor.value);
          }
        });
      }
      return output;
    }

    function syncRunCtx() {
      runCtx = getRunCtx() || {};
      return runCtx;
    }

    function parseEmbeddedJsonSpec(spec) {
      if (typeof spec !== 'string') return spec;
      var text = spec.trim();
      if (!text || (text[0] !== '{' && text[0] !== '[')) return spec;
      try { return JSON.parse(text); } catch (_) { return spec; }
    }

    function toNumberOrNull(v) {
      if (v === '' || v === null || v === undefined) return null;
      var n = Number(v);
      return isNaN(n) ? null : n;
    }

    function coerceDataValue(value, type) {
      type = String(type || '').trim().toLowerCase();
      if (!type || type === 'auto') return value;
      if (type === 'string') return value === undefined || value === null ? '' : String(value);
      if (type === 'number' || type === 'float') {
        var n = Number(value);
        return isNaN(n) ? 0 : n;
      }
      if (type === 'int' || type === 'integer') {
        var i = parseInt(value, 10);
        return isNaN(i) ? 0 : i;
      }
      if (type === 'boolean' || type === 'bool') {
        if (value === true || value === false) return value;
        return /^(true|1|yes|y)$/i.test(String(value || '').trim());
      }
      if (type === 'json') return parseJsonValue(value, value, '字段 JSON');
      if (type === 'date') {
        var d = new Date(value);
        return isNaN(d.getTime()) ? null : d.toISOString();
      }
      return value;
    }

    function parseMappingSpec(raw) {
      if (!raw) return [];
      if (typeof raw === 'object') {
        if (Array.isArray(raw)) return raw;
        return Object.keys(raw).map(function (target) {
          var spec = raw[target];
          if (spec && typeof spec === 'object') return mergeDataRecords({ target: target }, spec);
          return { target: target, source: spec };
        });
      }
      var text = String(raw || '').trim();
      if (!text) return [];
      if (text.charAt(0) === '[' || text.charAt(0) === '{') {
        return parseMappingSpec(parseJsonValue(text, [], '字段映射'));
      }
      return text.split('\n').map(function (line) {
        line = line.trim();
        if (!line || line.charAt(0) === '#') return null;
        if (line.indexOf('->') !== -1) {
          var sides = line.split('->');
          var left = sides[0].trim();
          var right = sides.slice(1).join('->').trim();
          var type = '';
          var typeIdx = right.lastIndexOf(':');
          if (typeIdx > 0) {
            type = right.slice(typeIdx + 1).trim();
            right = right.slice(0, typeIdx).trim();
          }
          return { source: left, target: right, type: type };
        }
        var parts = line.split('|').map(function (p) { return p.trim(); });
        return { target: parts[0], source: parts[1] || parts[0], type: parts[2] || '', defaultValue: parts[3] };
      }).filter(Boolean);
    }

    function localDataCtx(item, index) {
      var ctx = mergeDataRecords(runCtx);
      ctx.item = item;
      ctx.row = item;
      ctx.index = index;
      ctx.itemIndex = index;
      ctx.ctx = runCtx;
      return ctx;
    }

    function interpolateExpression(expr, ctx) {
      if (typeof expr !== 'string' || expr.indexOf('{{') === -1) return String(expr || '');
      return expr.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, rawExpr, offset) {
        var path = String(rawExpr || '').trim();
        var asJson = false;
        if (/^json\s+/.test(path)) {
          asJson = true;
          path = path.replace(/^json\s+/, '').trim();
        }
        var value = globalThis.Template.resolvePath(ctx || {}, path);
        var quote = expressionStringQuoteAt(expr, offset);
        if (!asJson && quote) return escapeExpressionString(value, quote);
        if (asJson || typeof value === 'string' || (value && typeof value === 'object')) {
          try { return JSON.stringify(value === undefined ? null : value); } catch (_) { return 'null'; }
        }
        if (value === undefined) return 'undefined';
        if (value === null) return 'null';
        return String(value);
      });
    }

    function expressionStringQuoteAt(expr, offset) {
      var quote = '';
      var escaped = false;
      for (var i = 0; i < offset; i++) {
        var ch = expr[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (quote) {
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
      }
      return quote;
    }

    function escapeExpressionString(value, quote) {
      if (value === undefined || value === null) return '';
      var text = '';
      if (typeof value === 'object') {
        try { text = JSON.stringify(value); } catch (_) { text = String(value); }
      } else {
        text = String(value);
      }
      return text
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, ' ')
        .replace(new RegExp(quote, 'g'), '\\' + quote);
    }

    function evalTemplateBool(expr, ctx, label) {
      var prepared = interpolateExpression(expr, ctx);
      var r = globalThis.Expression.evalBool(prepared);
      if (!r.ok) throw new Error((label || '表达式') + '解析失败: ' + r.error + ' — ' + prepared);
      return !!r.value;
    }

    function compareValues(actual, operator, expected) {
      operator = operator || '==';
      var an = toNumberOrNull(actual);
      var en = toNumberOrNull(expected);
      var numeric = an !== null && en !== null;
      if (operator === '==') return numeric ? an === en : String(actual) === String(expected);
      if (operator === '!=') return numeric ? an !== en : String(actual) !== String(expected);
      if (operator === '>') return numeric && an > en;
      if (operator === '>=') return numeric && an >= en;
      if (operator === '<') return numeric && an < en;
      if (operator === '<=') return numeric && an <= en;
      if (operator === 'contains') return String(actual).indexOf(String(expected)) !== -1;
      if (operator === 'notContains') return String(actual).indexOf(String(expected)) === -1;
      if (operator === 'regex') return new RegExp(String(expected)).test(String(actual));
      throw new Error('未知比较方式: ' + operator);
    }

    function execDataMap(params) {
      var source = resolveCtxValue(params.sourcePath || params.source, 'last');
      var mappings = parseMappingSpec(params.mappings);
      var keepUnmapped = params.keepUnmapped === true;

      function mapOne(item, index) {
        if (!mappings.length) return cloneJsonSafe(item);
        var out = keepUnmapped && item && typeof item === 'object' && !Array.isArray(item) ? cloneJsonSafe(item) : {};
        var ctx = localDataCtx(item, index);
        mappings.forEach(function (m) {
          if (!m || !m.target) return;
          var value;
          if (m.value !== undefined) {
            value = (typeof m.value === 'string') ? globalThis.Template.interpolate(m.value, ctx) : m.value;
          } else if (m.source && String(m.source).indexOf('{{') !== -1) {
            value = globalThis.Template.interpolate(String(m.source), ctx);
          } else {
            value = getObjectPath(item, m.source || m.target);
            if (value === undefined) value = globalThis.Template.resolvePath(ctx, m.source || m.target);
          }
          if ((value === undefined || value === null || value === '') && m.defaultValue !== undefined) value = m.defaultValue;
          setObjectPath(out, m.target, coerceDataValue(value, m.type));
        });
        return out;
      }

      var result = Array.isArray(source) ? source.map(mapOne) : mapOne(source || {}, 0);
      return { items: Array.isArray(result) ? result : undefined, result: result, count: Array.isArray(result) ? result.length : 1 };
    }

    function parseDataProjectFields(raw) {
      var parsed = parseJsonValue(raw, undefined, '数据投影字段');
      if (!parsed) return [];
      if (Array.isArray(parsed)) {
        return parsed.map(function (field) {
          field = parseEmbeddedJsonSpec(field);
          return (field && typeof field === 'object') ? field : null;
        }).filter(function (field) { return field && field.target; });
      }
      if (typeof parsed === 'object') {
        return Object.keys(parsed).map(function (target) {
          var spec = parseEmbeddedJsonSpec(parsed[target]);
          if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            return mergeDataRecords({ target: target }, spec);
          }
          return { target: target, value: spec };
        });
      }
      throw new Error('dataProject fields 必须是对象或数组 JSON');
    }

    function parseDataProjectSetPaths(raw) {
      var parsed = parseJsonValue(raw, undefined, '数据投影写入路径');
      if (!parsed) return [];
      if (Array.isArray(parsed)) {
        return parsed.map(function (item) {
          if (typeof item === 'string') return { path: item, valuePath: '$result' };
          return (item && typeof item === 'object') ? item : null;
        }).filter(function (item) { return item && item.path; });
      }
      if (typeof parsed === 'object') {
        return Object.keys(parsed).map(function (path) {
          return { path: path, valuePath: parsed[path] };
        });
      }
      throw new Error('dataProject setPaths 必须是对象或数组 JSON');
    }

    function normalizeProjectFilters(spec) {
      var filters = [];
      if (spec.filter) filters = filters.concat(Array.isArray(spec.filter) ? spec.filter : [spec.filter]);
      if (spec.filters) filters = filters.concat(Array.isArray(spec.filters) ? spec.filters : [spec.filters]);
      if (spec.filterPath || spec.filterValue !== undefined || spec.filterExpected !== undefined) {
        filters.push({
          path: spec.filterPath,
          operator: spec.filterOperator || spec.operator || '==',
          value: spec.filterValue !== undefined ? spec.filterValue : spec.filterExpected,
          values: spec.filterValues,
          flags: spec.filterFlags,
          caseInsensitive: spec.caseInsensitive,
        });
      }
      return filters.filter(function (filter) { return filter && typeof filter === 'object'; });
    }

    function normalizeComparableValue(value, caseInsensitive) {
      if (!caseInsensitive) return value;
      return value === undefined || value === null ? value : String(value).toLowerCase();
    }

    function resolveProjectExpected(value, ctx) {
      if (typeof value === 'string' && value.indexOf('{{') !== -1) {
        return globalThis.Template.interpolate(value, ctx);
      }
      return value;
    }

    function projectFilterMatches(item, index, filter) {
      var ctx = localDataCtx(item, index);
      var actual = getObjectPath(item, filter.path || filter.field || '');
      var operator = String(filter.operator || filter.op || '==').trim();
      var opLower = operator.toLowerCase();
      var expected = filter.values !== undefined
        ? filter.values
        : (filter.value !== undefined ? filter.value : filter.expected);
      expected = resolveProjectExpected(expected, ctx);
      var caseInsensitive = filter.caseInsensitive === true || /i/.test(String(filter.flags || ''));

      if (opLower === 'in' || opLower === 'notin' || opLower === 'not_in') {
        var values = Array.isArray(expected) ? expected : splitList(expected);
        var comparableActual = normalizeComparableValue(actual, caseInsensitive);
        var matched = values.some(function (value) {
          return normalizeComparableValue(resolveProjectExpected(value, ctx), caseInsensitive) === comparableActual;
        });
        return opLower === 'in' ? matched : !matched;
      }

      if (opLower === 'regex') {
        var flags = String(filter.flags || '');
        var regexFlags = flags.replace(/[^gimsuy]/g, '');
        if (caseInsensitive && regexFlags.indexOf('i') === -1) regexFlags += 'i';
        return new RegExp(String(expected), regexFlags).test(String(actual === undefined || actual === null ? '' : actual));
      }

      if (caseInsensitive) {
        actual = normalizeComparableValue(actual, true);
        expected = normalizeComparableValue(expected, true);
      }
      return compareValues(actual, operator, expected);
    }

    function applyProjectReplacements(value, spec) {
      var result = value === undefined || value === null ? '' : String(value);
      var replacements = [];
      if (spec.replace) replacements = replacements.concat(Array.isArray(spec.replace) ? spec.replace : [spec.replace]);
      if (spec.replacePattern) {
        replacements.push({
          pattern: spec.replacePattern,
          replacement: spec.replaceReplacement || '',
          flags: spec.replaceFlags || 'g',
        });
      }
      replacements.forEach(function (rule) {
        if (!rule) return;
        if (typeof rule === 'string') {
          result = result.split(rule).join('');
          return;
        }
        if (rule.pattern === undefined || rule.pattern === null) return;
        var flags = String(rule.flags || 'g').replace(/[^gimsuy]/g, '');
        result = result.replace(new RegExp(String(rule.pattern), flags), rule.replacement === undefined ? '' : String(rule.replacement));
      });
      if (spec.trim === true) result = result.trim();
      return result;
    }

    function projectFieldValue(spec, baseSource) {
      if (spec.value !== undefined) return spec.value;
      var source = spec.sourcePath ? resolveCtxValue(spec.sourcePath, '') : baseSource;
      var inferredMode = Array.isArray(source) || (source && (Array.isArray(source.items) || Array.isArray(source.rows))) ? 'join' : 'value';
      var mode = String(spec.mode || inferredMode).toLowerCase();
      var path = spec.contentPath || spec.valuePath || spec.path || '';

      if (mode === 'value') {
        var raw = path ? getObjectPath(source, path) : source;
        if ((raw === undefined || raw === null || raw === '') && spec.defaultValue !== undefined) raw = spec.defaultValue;
        if (spec.replace || spec.replacePattern || spec.trim === true) raw = applyProjectReplacements(raw, spec);
        return coerceDataValue(raw, spec.type);
      }

      var rows = ensureArrayValue(source, 'dataProject 数据源');
      var filters = normalizeProjectFilters(spec);
      var selected = rows.filter(function (item, index) {
        return filters.every(function (filter) { return projectFilterMatches(item, index, filter); });
      });

      if (mode === 'count') return selected.length;
      if (mode === 'array' || mode === 'items') {
        return selected.map(function (item) { return path ? getObjectPath(item, path) : item; });
      }
      if (mode === 'first' || mode === 'last') {
        var picked = mode === 'first' ? selected[0] : selected[selected.length - 1];
        var pickedValue = picked === undefined ? undefined : (path ? getObjectPath(picked, path) : picked);
        if ((pickedValue === undefined || pickedValue === null || pickedValue === '') && spec.defaultValue !== undefined) pickedValue = spec.defaultValue;
        if (spec.replace || spec.replacePattern || spec.trim === true) pickedValue = applyProjectReplacements(pickedValue, spec);
        return coerceDataValue(pickedValue, spec.type);
      }

      var joined = selected.map(function (item) {
        var value = path ? getObjectPath(item, path) : item;
        return value === undefined || value === null ? '' : String(value);
      }).join(spec.separator === undefined ? '' : String(spec.separator));
      if (!joined && spec.defaultValue !== undefined) joined = spec.defaultValue;
      joined = applyProjectReplacements(joined, spec);
      return coerceDataValue(joined, spec.type);
    }

    function resolveProjectSetValue(result, valuePath) {
      if (valuePath === undefined || valuePath === null || valuePath === '' || valuePath === '$result') return cloneJsonSafe(result);
      if (typeof valuePath !== 'string') return valuePath;
      return getObjectPath(result, valuePath);
    }

    function execDataProject(params) {
      var source = resolveCtxValue(params.sourcePath || params.source, 'last');
      var fields = parseDataProjectFields(params.fields);
      var result = {};
      fields.forEach(function (spec) {
        if (!spec || !spec.target) return;
        setObjectPath(result, spec.target, projectFieldValue(spec, source));
      });

      fields.forEach(function (spec) {
        var paths = splitList(spec.setPaths || spec.setPath);
        paths.forEach(function (path) {
          setObjectPath(runCtx, path, cloneJsonSafe(getObjectPath(result, spec.target)));
        });
      });

      parseDataProjectSetPaths(params.setPaths).forEach(function (entry) {
        setObjectPath(runCtx, entry.path, resolveProjectSetValue(result, entry.valuePath));
      });

      return result;
    }

    function parseDataComposeFields(raw) {
      var parsed = parseJsonValue(raw, undefined, '数据组合字段');
      if (!parsed) return [];
      if (Array.isArray(parsed)) {
        return parsed.map(function (field) {
          field = parseEmbeddedJsonSpec(field);
          return (field && typeof field === 'object') ? field : null;
        }).filter(function (field) { return field && field.target; });
      }
      if (typeof parsed === 'object') {
        return Object.keys(parsed).map(function (target) {
          var spec = parseEmbeddedJsonSpec(parsed[target]);
          if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            return mergeDataRecords({ target: target }, spec);
          }
          return { target: target, value: spec };
        });
      }
      throw new Error('dataCompose fields 必须是对象或数组 JSON');
    }

    function dataComposeCtx(result) {
      var ctx = mergeDataRecords(runCtx, result || {});
      ctx.result = result || {};
      ctx.ctx = runCtx;
      return ctx;
    }

    function textValue(value) {
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return '';
    }

    function truthyDataValue(value) {
      if (value === true || value === false) return value;
      if (typeof value === 'number') return value !== 0;
      var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
      if (!text) return false;
      return ['false', '0', 'no', 'n', 'off', 'disabled', 'null', 'undefined'].indexOf(text) === -1;
    }

    function resolveComposePath(path, ctx) {
      if (path === undefined || path === null || path === '') return undefined;
      var resolvedPath = typeof path === 'string' && path.indexOf('{{') !== -1
        ? globalThis.Template.interpolate(path, ctx)
        : path;
      return getContentValue(globalThis.Template.resolvePath(ctx, resolvedPath));
    }

    function firstComposePathValue(paths, ctx) {
      var list = Array.isArray(paths) ? paths : splitList(paths);
      for (var i = 0; i < list.length; i++) {
        var value = resolveComposePath(list[i], ctx);
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return undefined;
    }

    function interpolateComposeValue(value, ctx) {
      if (typeof value === 'string') return globalThis.Template.interpolate(value, ctx);
      return cloneJsonSafe(value);
    }

    function evaluateComposeCondition(spec, ctx) {
      var condition = spec.condition !== undefined ? spec.condition : (spec.when !== undefined ? spec.when : spec.expression);
      if (condition !== undefined && condition !== null && condition !== '') {
        if (typeof condition === 'boolean') return condition;
        return evalTemplateBool(String(condition), ctx, 'dataCompose 条件 ');
      }
      var conditionPath = spec.conditionPath || spec.whenPath;
      if (conditionPath) return truthyDataValue(resolveComposePath(conditionPath, ctx));
      return true;
    }

    function composeBranchValue(spec, ctx, prefix) {
      var templateKey = prefix ? prefix + 'Template' : 'template';
      var valueKey = prefix ? prefix + 'Value' : 'value';
      var pathKey = prefix ? prefix + 'Path' : (spec.valuePath !== undefined ? 'valuePath' : (spec.sourcePath !== undefined ? 'sourcePath' : 'path'));
      var coalesceKey = prefix ? prefix + 'CoalescePaths' : 'coalescePaths';
      var sourcePathsKey = prefix ? prefix + 'SourcePaths' : 'sourcePaths';

      if (spec[templateKey] !== undefined) return globalThis.Template.interpolate(String(spec[templateKey]), ctx);
      if (spec[valueKey] !== undefined) return interpolateComposeValue(spec[valueKey], ctx);
      if (spec[coalesceKey] !== undefined) return firstComposePathValue(spec[coalesceKey], ctx);
      if (spec[sourcePathsKey] !== undefined) return firstComposePathValue(spec[sourcePathsKey], ctx);
      if (spec[pathKey] !== undefined) return resolveComposePath(spec[pathKey], ctx);
      return undefined;
    }

    function composeFieldValue(spec, ctx) {
      var mode = String(spec.mode || '').trim().toLowerCase();
      if (mode === 'condition' || mode === 'boolcondition' || mode === 'booleancondition') {
        return evaluateComposeCondition(spec, ctx);
      }

      var conditionMet = evaluateComposeCondition(spec, ctx);
      var value = conditionMet ? composeBranchValue(spec, ctx, '') : composeBranchValue(spec, ctx, 'else');

      if (value === undefined && spec.defaultValue !== undefined) value = interpolateComposeValue(spec.defaultValue, ctx);

      if (mode === 'regex' || mode === 'match') {
        var pattern = spec.pattern || spec.regex || spec.matchPattern;
        if (!pattern) throw new Error('dataCompose regex 模式缺少 pattern');
        var flags = String(spec.flags || '').replace(/[^gimsuy]/g, '');
        var matched = new RegExp(String(pattern), flags).exec(String(value === undefined || value === null ? '' : value));
        var group = Number(spec.group !== undefined ? spec.group : (spec.index !== undefined ? spec.index : 1));
        value = matched && matched[group] !== undefined ? matched[group] : (spec.defaultValue !== undefined ? interpolateComposeValue(spec.defaultValue, ctx) : '');
        if (spec.decodeUri === true || spec.decodeURIComponent === true) {
          try { value = decodeURIComponent(String(value)); } catch (_) {}
        }
      }

      if (mode === 'exists') {
        value = value !== undefined && value !== null;
      } else if (mode === 'nonempty' || mode === 'non_empty' || mode === 'hasvalue') {
        value = textValue(value).trim() !== '';
      } else if (spec.replace || spec.replacePattern || spec.trim === true) {
        value = applyProjectReplacements(value, spec);
      }

      if (spec.trim === true && typeof value === 'string' && !(spec.replace || spec.replacePattern)) {
        value = value.trim();
      }
      return coerceDataValue(value, spec.type);
    }

    function execDataCompose(params) {
      var fields = parseDataComposeFields(params.fields);
      var result = {};
      fields.forEach(function (spec) {
        if (!spec || !spec.target) return;
        var ctx = dataComposeCtx(result);
        var value = composeFieldValue(spec, ctx);
        setObjectPath(result, spec.target, cloneJsonSafe(value));
        if (spec.writeContext !== false && spec.writeCtx !== false) {
          setObjectPath(runCtx, spec.setPath || spec.target, cloneJsonSafe(value));
        }
        splitList(spec.setPaths).forEach(function (path) {
          setObjectPath(runCtx, path, cloneJsonSafe(value));
        });
      });

      parseDataProjectSetPaths(params.setPaths).forEach(function (entry) {
        setObjectPath(runCtx, entry.path, resolveProjectSetValue(result, entry.valuePath));
      });

      return result;
    }

    function execContextPrune(params) {
      var paths = splitList(params.paths || params.path);
      var removed = [];
      paths.forEach(function (path) {
        if (deleteObjectPath(runCtx, path)) removed.push(path);
      });
      if (params.clearLast === true) {
        if (deleteObjectPath(runCtx, 'last')) removed.push('last');
        if (deleteObjectPath(runCtx, '_lastContent')) removed.push('_lastContent');
      }
      if (params.clearDebugTrace === true) {
        var count = clearDebugTrace();
        removed.push('debugTrace(' + count + ')');
      }
      var compacted = compactEphemeralRunState();
      return {
        removed: removed,
        removedCount: removed.length,
        compacted: compacted,
        remainingKeys: Object.keys(runCtx).length,
      };
    }

    function execDataFilter(params) {
      var rows = ensureArrayValue(resolveCtxValue(params.sourcePath || params.source, 'last'), 'dataFilter 数据源');
      var expression = params.expression || params.condition || '';
      var field = params.field || '';
      var operator = params.operator || '==';
      var expected = params.expected;
      var filtered = rows.filter(function (item, index) {
        var ctx = localDataCtx(item, index);
        if (expression) return evalTemplateBool(expression, ctx, '过滤表达式');
        if (!field) return true;
        return compareValues(getObjectPath(item, field), operator, globalThis.Template.interpolate(String(expected === undefined ? '' : expected), ctx));
      });
      return { items: filtered, count: filtered.length, total: rows.length };
    }

    function buildDataKey(item, index, fields, expression) {
      if (expression) return String(interpolateExpression(expression, localDataCtx(item, index)));
      if (!fields.length) return JSON.stringify(item);
      return JSON.stringify(fields.map(function (f) { return getObjectPath(item, f); }));
    }

    function execDataDedupe(params) {
      var rows = ensureArrayValue(resolveCtxValue(params.sourcePath || params.source, 'last'), 'dataDedupe 数据源');
      var fields = splitList(params.keyFields || params.fields);
      var keep = params.keep || 'first';
      var seen = Object.create(null);
      var result = [];
      rows.forEach(function (item, index) {
        var key = buildDataKey(item, index, fields, params.keyExpression);
        if (seen[key] === undefined) {
          seen[key] = result.length;
          result.push(item);
        } else if (keep === 'last') {
          result[seen[key]] = item;
        }
      });
      return { items: result, count: result.length, removed: rows.length - result.length, total: rows.length };
    }

    function execDataJoin(params) {
      if (!params.rightSourcePath && !params.rightSource) throw new Error('dataJoin 需要 rightSourcePath');
      var left = ensureArrayValue(resolveCtxValue(params.leftSourcePath || params.leftSource, 'last'), 'dataJoin 左侧数据源');
      var right = ensureArrayValue(resolveCtxValue(params.rightSourcePath || params.rightSource, ''), 'dataJoin 右侧数据源');
      var leftKey = params.leftKey || params.key;
      var rightKey = params.rightKey || params.key || leftKey;
      if (!leftKey || !rightKey) throw new Error('dataJoin 需要 leftKey/rightKey');
      var joinType = params.joinType || 'left';
      var rightPrefix = params.rightPrefix || '';
      var rightMap = Object.create(null);
      right.forEach(function (row, index) {
        var key = JSON.stringify(getObjectPath(row, rightKey));
        if (!rightMap[key]) rightMap[key] = [];
        rightMap[key].push({ row: row, index: index, matched: false });
      });
      var out = [];
      left.forEach(function (lrow) {
        var matches = rightMap[JSON.stringify(getObjectPath(lrow, leftKey))] || [];
        if (!matches.length) {
          if (joinType === 'left' || joinType === 'full') out.push(cloneJsonSafe(lrow));
          return;
        }
        matches.forEach(function (entry) {
          entry.matched = true;
          var merged = cloneJsonSafe(lrow) || {};
          var rcopy = cloneJsonSafe(entry.row) || {};
          Object.keys(rcopy).forEach(function (k) {
            defineDataProperty(merged, rightPrefix ? rightPrefix + k : k, rcopy[k]);
          });
          out.push(merged);
        });
      });
      if (joinType === 'full') {
        Object.keys(rightMap).forEach(function (key) {
          rightMap[key].forEach(function (entry) {
            if (!entry.matched) out.push(cloneJsonSafe(entry.row));
          });
        });
      }
      return { items: out, count: out.length, leftCount: left.length, rightCount: right.length, joinType: joinType };
    }

    function parseAggregateMetrics(raw, op, field, alias) {
      var metrics = [];
      if (raw) {
        String(raw).split('\n').forEach(function (line) {
          line = line.trim();
          if (!line || line.charAt(0) === '#') return;
          var m = /^(\w+)(?:\(([^)]*)\))?(?:\s+as\s+([A-Za-z0-9_.-]+))?$/i.exec(line);
          if (m) {
            metrics.push({ op: m[1], field: (m[2] || '').trim(), alias: m[3] || '' });
            return;
          }
          var parts = line.split('|').map(function (p) { return p.trim(); });
          metrics.push({ op: parts[0], field: parts[1] || '', alias: parts[2] || '' });
        });
      }
      if (!metrics.length) metrics.push({ op: op || 'count', field: field || '', alias: alias || '' });
      return metrics;
    }

    function aggregateGroup(rows, metrics) {
      var out = {};
      metrics.forEach(function (metric) {
        var op = String(metric.op || 'count').toLowerCase();
        var values = rows.map(function (row) { return metric.field ? getObjectPath(row, metric.field) : row; });
        var nums = values.map(Number).filter(function (n) { return !isNaN(n); });
        var key = metric.alias || (op + (metric.field ? '_' + metric.field.replace(/[^A-Za-z0-9_]+/g, '_') : ''));
        if (op === 'count') defineDataProperty(out, key, rows.length);
        else if (op === 'sum') defineDataProperty(out, key, nums.reduce(function (a, b) { return a + b; }, 0));
        else if (op === 'avg') defineDataProperty(out, key, nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : 0);
        else if (op === 'min') defineDataProperty(out, key, nums.length ? Math.min.apply(Math, nums) : null);
        else if (op === 'max') defineDataProperty(out, key, nums.length ? Math.max.apply(Math, nums) : null);
        else throw new Error('未知聚合操作: ' + op);
      });
      return out;
    }

    function execDataAggregate(params) {
      var rows = ensureArrayValue(resolveCtxValue(params.sourcePath || params.source, 'last'), 'dataAggregate 数据源');
      var groupFields = splitList(params.groupBy);
      var metrics = parseAggregateMetrics(params.metrics, params.operation, params.field, params.alias);
      if (!groupFields.length) return mergeDataRecords({ total: rows.length }, aggregateGroup(rows, metrics));
      var groups = Object.create(null);
      rows.forEach(function (row) {
        var keyValues = groupFields.map(function (f) { return getObjectPath(row, f); });
        var key = JSON.stringify(keyValues);
        if (!groups[key]) groups[key] = { values: keyValues, rows: [] };
        groups[key].rows.push(row);
      });
      var items = Object.keys(groups).map(function (key) {
        var group = groups[key];
        var out = {};
        groupFields.forEach(function (f, i) { defineDataProperty(out, f, group.values[i]); });
        return mergeDataRecords(out, aggregateGroup(group.rows, metrics));
      });
      return { items: items, count: items.length, total: rows.length };
    }

    function checkpointKey(params, state) {
      var scope = params.scope || (state && state.flowId) || 'global';
      var name = params.name || params.key || 'default';
      return scope + ':' + name;
    }

    function execCheckpointGet(params, state, execution) {
      ensureNotAborted(execution);
      return abortable(storageGet(CHECKPOINTS_KEY), execution).then(function (map) {
        ensureNotAborted(execution);
        map = map || {};
        var key = checkpointKey(params, state);
        var entry = map[key];
        var exists = !!entry;
        var value = exists ? entry.value : parseJsonValue(params.defaultValue, params.defaultValue, '默认游标');
        return { key: key, exists: exists, value: value, updatedAt: entry ? entry.updatedAt : 0 };
      });
    }

    function execCheckpointSet(params, state, execution) {
      ensureNotAborted(execution);
      var dispatched = false;
      return abortable(storageGet(CHECKPOINTS_KEY), execution).then(function (map) {
        ensureNotAborted(execution);
        map = map || {};
        var key = checkpointKey(params, state);
        var value = params.value !== '' && params.value !== undefined ? params.value : resolveCtxValue(params.sourcePath, 'last');
        if (params.parseJson) value = parseJsonValue(value, value, '游标值');
        map[key] = { value: value, updatedAt: Date.now() };
        var payload = {};
        payload[CHECKPOINTS_KEY] = map;
        dispatched = true;
        return abortable(storageSet(payload), execution).then(function () {
          ensureNotAborted(execution);
          return { key: key, value: value, updatedAt: map[key].updatedAt };
        });
      }).catch(function (error) {
        if (dispatched) throw markUncertain(error);
        throw error;
      });
    }

    function selectComparable(row, fields) {
      if (!fields.length) return row;
      var out = {};
      fields.forEach(function (f) { defineDataProperty(out, f, getObjectPath(row, f)); });
      return out;
    }

    function execDataDiff(params) {
      if (!params.oldSourcePath && !params.oldSource) throw new Error('dataDiff 需要 oldSourcePath');
      var oldRows = ensureArrayValue(resolveCtxValue(params.oldSourcePath || params.oldSource, ''), 'dataDiff 旧数据源');
      var newRows = ensureArrayValue(resolveCtxValue(params.newSourcePath || params.newSource, 'last'), 'dataDiff 新数据源');
      var keyFields = splitList(params.keyFields || params.key);
      if (!keyFields.length) throw new Error('dataDiff 需要 keyFields');
      var compareFields = splitList(params.compareFields);
      function keyOf(row) { return JSON.stringify(keyFields.map(function (f) { return getObjectPath(row, f); })); }
      var oldMap = Object.create(null);
      var newMap = Object.create(null);
      oldRows.forEach(function (row) { oldMap[keyOf(row)] = row; });
      newRows.forEach(function (row) { newMap[keyOf(row)] = row; });
      var created = [];
      var updated = [];
      var unchanged = [];
      var deleted = [];
      Object.keys(newMap).forEach(function (key) {
        if (!oldMap[key]) created.push(newMap[key]);
        else if (JSON.stringify(selectComparable(oldMap[key], compareFields)) !== JSON.stringify(selectComparable(newMap[key], compareFields))) {
          updated.push({ before: oldMap[key], after: newMap[key] });
        } else {
          unchanged.push(newMap[key]);
        }
      });
      Object.keys(oldMap).forEach(function (key) {
        if (!newMap[key]) deleted.push(oldMap[key]);
      });
      return { created: created, updated: updated, deleted: deleted, unchanged: unchanged, summary: { created: created.length, updated: updated.length, deleted: deleted.length, unchanged: unchanged.length } };
    }

    function wrapWithCtx(fn) {
      return function () {
        syncRunCtx();
        return fn.apply(null, arguments);
      };
    }

    return {
      coerceDataValue: coerceDataValue,
      parseMappingSpec: parseMappingSpec,
      localDataCtx: function (item, index) { syncRunCtx(); return localDataCtx(item, index); },
      interpolateExpression: interpolateExpression,
      evalTemplateBool: function (expr, ctx, label) { syncRunCtx(); return evalTemplateBool(expr, ctx, label); },
      compareValues: compareValues,
      execDataMap: wrapWithCtx(execDataMap),
      execDataProject: wrapWithCtx(execDataProject),
      execDataCompose: wrapWithCtx(execDataCompose),
      execContextPrune: wrapWithCtx(execContextPrune),
      execDataFilter: wrapWithCtx(execDataFilter),
      execDataDedupe: wrapWithCtx(execDataDedupe),
      execDataJoin: wrapWithCtx(execDataJoin),
      execDataAggregate: wrapWithCtx(execDataAggregate),
      execCheckpointGet: wrapWithCtx(execCheckpointGet),
      execCheckpointSet: wrapWithCtx(execCheckpointSet),
      execDataDiff: wrapWithCtx(execDataDiff),
    };
  }

  return {
    createDataOps: createDataOps,
  };
});
