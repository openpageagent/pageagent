// Template — 运行上下文 {{var}} 插值
// 支持 {{var}}、{{var.path[0].x}}、{{json var}}（JSON 序列化）
(function attachTemplate(root, factory) {
  root.Template = factory();
})(globalThis, function () {

  // 检测是否为 FlowData（避免循环依赖，直接内联检测逻辑）
  function isFlowDataInternal(obj) {
    if (!obj || typeof obj !== 'object') return false;
    // 快速标记检测
    if (obj.__isFlowData === true) return true;
    // 结构匹配降级检测
    return 'attributes' in obj && 'content' in obj && obj.attributes && typeof obj.attributes === 'object';
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 解析 a.b[0].c 风格路径
  // FlowData 对业务路径保持透明；attributes 是唯一显式元数据入口。
  // 当业务负载本身也有 content 字段时，foo.content 应读取负载的 content，
  // 而不是停在 FlowData 外壳上。
  function resolvePath(ctx, path) {
    if (!path) return undefined;
    var normalized = String(path).replace(/\[(\d+)\]/g, '.$1');
    var parts = normalized.split('.').filter(function (p) { return p !== ''; });
    var cur = ctx;

    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;

      var part = parts[i];

      // FlowData 自动解包逻辑
      if (isFlowDataInternal(cur)) {
        // attributes 是显式元数据入口。
        if (part === 'attributes') {
          cur = cur.attributes;
          continue;
        }

        var payload = cur.content;
        if (part === 'content') {
          // 兼容 last.content.rowCount 这类显式外壳路径；如果业务负载
          // 自己声明了 content，则优先读取业务字段，消除 content 重名歧义。
          if (payload && typeof payload === 'object' && hasOwn(payload, 'content')) {
            cur = payload.content;
          } else {
            cur = payload;
          }
          continue;
        }

        // 默认行为：自动解包到业务负载（向后兼容）。
        cur = payload;
      }

      if (cur && typeof cur === 'object') {
        if (hasOwn(cur, part)) {
          cur = cur[part];
          continue;
        }

        // attributes 中大量使用 "node.type" 这类带点键；优先匹配最长原始键。
        var matchedDottedKey = false;
        for (var end = parts.length; end > i + 1; end--) {
          var dottedKey = parts.slice(i, end).join('.');
          if (hasOwn(cur, dottedKey)) {
            cur = cur[dottedKey];
            i = end - 1;
            matchedDottedKey = true;
            break;
          }
        }
        if (matchedDottedKey) continue;
      }

      cur = cur[part];
    }

    // {{last}} / {{json last}} 也应保持旧行为：返回节点原始输出 content。
    return isFlowDataInternal(cur) ? cur.content : cur;
  }

  function stringifyValue(value, asJson) {
    if (asJson) {
      try { return JSON.stringify(value === undefined ? null : value); } catch (_) { return 'null'; }
    }
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  }

  function normalizeMarkdownText(value) {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseHelperArgs(raw) {
    var parts = String(raw || '').split(/\s+/).filter(Boolean);
    var result = { sourcePath: parts.shift() || '', options: {} };
    parts.forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq <= 0) return;
      result.options[part.slice(0, eq)] = part.slice(eq + 1);
    });
    return result;
  }

  function resolveOptionPath(ctx, options, key) {
    return options[key] ? resolvePath(ctx, options[key]) : '';
  }

  function resolveItemField(item, field) {
    return field ? resolvePath(item || {}, field) : '';
  }

  function markdownRecords(ctx, records, options) {
    options = options || {};
    var rows = Array.isArray(records) ? records : [];
    var label = options.label || 'Records';
    var title = normalizeMarkdownText(resolveOptionPath(ctx, options, 'titlePath'));
    var url = normalizeMarkdownText(resolveOptionPath(ctx, options, 'urlPath'));
    var countValue = resolveOptionPath(ctx, options, 'countPath');
    var count = countValue === undefined || countValue === null || countValue === '' ? rows.length : countValue;
    var lines = title ? ['# ' + title] : [];
    if (url) lines.push(lines.length ? '' : '', '- URL: ' + url);
    lines.push('- ' + label + ': ' + count);
    if (!rows.length) return lines.join('\n');
    lines.push('', '## ' + label);
    rows.forEach(function (post, index) {
      post = post || {};
      var recordId = resolveItemField(post, options.id) || ('item_' + (index + 1));
      var author = resolveItemField(post, options.author);
      var createdAt = resolveItemField(post, options.time);
      var content = resolveItemField(post, options.content);
      var heading = '### ' + recordId;
      if (author) heading += ' - ' + author;
      if (createdAt) heading += ' - ' + createdAt;
      lines.push('', heading, '', normalizeMarkdownText(content));
    });
    return lines.join('\n');
  }

  function resolveExpression(ctx, expr) {
    expr = String(expr || '').trim();
    var spaceIndex = expr.search(/\s/);
    if (spaceIndex > 0) {
      var helper = expr.slice(0, spaceIndex);
      var helperArgs = parseHelperArgs(expr.slice(spaceIndex + 1).trim());
      var value = resolvePath(ctx, helperArgs.sourcePath);
      if (helper === 'markdownRecords' || helper === 'markdownItems') {
        return markdownRecords(ctx, value, helperArgs.options);
      }
    }
    return resolvePath(ctx, expr);
  }

  // 对字符串做模板插值
  function interpolate(str, ctx) {
    if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
    ctx = ctx || {};
    return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, expr) {
      var asJson = false;
      if (/^json\s+/.test(expr)) {
        asJson = true;
        expr = expr.replace(/^json\s+/, '');
      }
      var value = resolveExpression(ctx, expr.trim());
      return stringifyValue(value, asJson);
    });
  }

  // Preserve the instruction/data boundary when runtime values enter model-facing text.
  function interpolateData(str, ctx) {
    if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
    ctx = ctx || {};
    return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, rawExpression) {
      var expression = String(rawExpression || '').trim().replace(/^json\s+/, '');
      var value = resolveExpression(ctx, expression);
      var serialized;
      try {
        serialized = JSON.stringify({ source: expression, value: value === undefined ? null : value });
      } catch (_) {
        serialized = JSON.stringify({ source: expression, value: null, serializationError: true });
      }
      serialized = serialized.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
      return '<template_data trust="data-only">\n' + serialized + '\n</template_data>';
    });
  }

  // 对对象中所有字符串字段做插值（浅层，参数对象足够）
  function interpolateParams(params, ctx) {
    var result = {};
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = params[k];
      result[k] = (typeof v === 'string') ? interpolate(v, ctx) : v;
    }
    return result;
  }

  return {
    resolvePath: resolvePath,
    resolveExpression: resolveExpression,
    interpolate: interpolate,
    interpolateData: interpolateData,
    interpolateParams: interpolateParams,
  };
});
