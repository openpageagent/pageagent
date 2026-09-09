// Turndown adapter for the offscreen document. Page-specific behavior is
// supplied as declarative flow-node rules; this module only interprets them.
(function attachTurndownAdapter(root, factory) {
  root.PageAgentTurndown = factory(root.TurndownService, root.turndownPluginGfm);
})(globalThis, function (TurndownService, turndownPluginGfm) {
  'use strict';

  var RULE_ACTIONS = { replace: true, remove: true, keep: true, fencedCode: true };
  var CONTENT_MODES = { markdown: true, text: true, html: true, outerHTML: true, attribute: true };
  var MAX_CUSTOM_RULES = 50;

  function own(value, key, fallback) {
    return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : fallback;
  }

  function blockResult(value, block) {
    value = String(value === undefined || value === null ? '' : value);
    return block === true ? '\n\n' + value.replace(/^\n+|\n+$/g, '') + '\n\n' : value;
  }

  function validateSelector(selector, label) {
    selector = String(selector || '').trim();
    if (!selector) throw new Error(label + ' selector 不能为空');
    try { document.documentElement.matches(selector); }
    catch (error) { throw new Error(label + ' selector 无效: ' + error.message); }
    return selector;
  }

  function normalizeRule(input, index) {
    var label = 'customRules[' + index + ']';
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(label + ' 必须是对象');
    }
    var action = String(own(input, 'action', 'replace') || 'replace');
    if (!RULE_ACTIONS[action]) throw new Error(label + ' action 不受支持: ' + action);
    var contentMode = String(own(input, 'contentMode', 'markdown') || 'markdown');
    if (!CONTENT_MODES[contentMode]) throw new Error(label + ' contentMode 不受支持: ' + contentMode);
    var contentSelector = String(own(input, 'contentSelector', '') || '').trim();
    if (contentSelector) validateSelector(contentSelector, label + '.contentSelector');
    if (contentMode === 'attribute' && !String(own(input, 'attribute', '') || '').trim()) {
      throw new Error(label + ' contentMode=attribute 时必须提供 attribute');
    }
    if (input.replacement !== undefined && typeof input.replacement !== 'string') {
      throw new Error(label + ' replacement 必须是字符串');
    }
    return {
      name: String(own(input, 'name', 'custom-rule-' + (index + 1)) || 'custom-rule-' + (index + 1)),
      selector: validateSelector(input.selector, label),
      action: action,
      contentSelector: contentSelector,
      contentMode: contentMode,
      attribute: String(own(input, 'attribute', '') || ''),
      replacement: input.replacement === undefined ? '$CONTENT' : input.replacement,
      block: own(input, 'block', false) === true,
      requiredContent: own(input, 'requiredContent', false) === true,
      language: String(own(input, 'language', '') || ''),
      stripExistingFence: own(input, 'stripExistingFence', false) === true,
      trimBoundaryNewlines: own(input, 'trimBoundaryNewlines', false) === true,
      fenceCharacter: String(own(input, 'fenceCharacter', '`') || '`').charAt(0),
    };
  }

  function selectedNode(node, rule) {
    if (!rule.contentSelector) return node;
    var selected = node.querySelector(rule.contentSelector);
    if (!selected && rule.requiredContent) {
      throw new Error('Turndown 规则「' + rule.name + '」未找到 contentSelector: ' + rule.contentSelector);
    }
    return selected;
  }

  function selectedContent(service, node, markdown, rule) {
    var selected = selectedNode(node, rule);
    if (!selected) return '';
    if (rule.contentMode === 'markdown') {
      return rule.contentSelector ? service.turndown(selected.innerHTML || '') : markdown;
    }
    if (rule.contentMode === 'text') return selected.textContent || '';
    if (rule.contentMode === 'html') return selected.innerHTML || '';
    if (rule.contentMode === 'outerHTML') return selected.outerHTML || '';
    if (rule.contentMode === 'attribute') return selected.getAttribute(rule.attribute) || '';
    return markdown;
  }

  function templateReplacement(service, markdown, node, rule) {
    var values = {
      CONTENT: selectedContent(service, node, markdown, rule),
      MARKDOWN: markdown,
      TEXT: node.textContent || '',
      HTML: node.innerHTML || '',
      OUTER_HTML: node.outerHTML || '',
    };
    // Replace against the template once. Content inserted for one placeholder
    // must never be interpreted as another placeholder.
    var result = rule.replacement.replace(/\$(CONTENT|MARKDOWN|TEXT|HTML|OUTER_HTML)/g, function (_, key) {
      return String(values[key] === undefined || values[key] === null ? '' : values[key]);
    });
    return blockResult(result, rule.block);
  }

  function stripLiteralFence(code, fallbackLanguage) {
    var lines = code.split('\n');
    var first = 0;
    while (first < lines.length && !lines[first].trim()) first++;
    var opening = first < lines.length && /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/.exec(lines[first]);
    if (!opening) return { code: code, language: fallbackLanguage };

    var language = fallbackLanguage || opening[2] || '';
    lines.splice(0, first + 1);
    var last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    if (last >= 0) {
      var closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[last]);
      if (closing
          && closing[1].charAt(0) === opening[1].charAt(0)
          && closing[1].length >= opening[1].length) lines.splice(last);
    }
    return { code: lines.join('\n'), language: language };
  }

  function fencedCodeReplacement(node, rule) {
    var selected = selectedNode(node, rule) || node;
    var code = String(selected.textContent || '').replace(/\r\n?/g, '\n');
    var language = rule.language;
    if (rule.stripExistingFence) {
      var stripped = stripLiteralFence(code, language);
      code = stripped.code;
      language = stripped.language;
    }
    if (rule.trimBoundaryNewlines) code = code.replace(/^\n+|\n+$/g, '');
    else code = code.replace(/\n$/, '');

    var fenceCharacter = rule.fenceCharacter === '~' ? '~' : '`';
    var fenceSize = 3;
    var matches = code.match(new RegExp('^ {0,3}' + fenceCharacter + '{3,}', 'gm')) || [];
    for (var i = 0; i < matches.length; i++) {
      var candidateSize = matches[i].replace(/^ +/, '').length;
      fenceSize = Math.max(fenceSize, candidateSize + 1);
    }
    var fence = new Array(fenceSize + 1).join(fenceCharacter);
    language = String(language || '').replace(/[^A-Za-z0-9_+.-]/g, '');
    return '\n\n' + fence + language + '\n' + code + '\n' + fence + '\n\n';
  }

  function addCustomRule(service, rule, index) {
    service.addRule(rule.name || 'custom-rule-' + index, {
      filter: function (node) { return node.matches(rule.selector); },
      replacement: function (content, node) {
        if (rule.action === 'remove') return '';
        if (rule.action === 'keep') return blockResult(node.outerHTML || '', rule.block || node.isBlock);
        if (rule.action === 'fencedCode') return fencedCodeReplacement(node, rule);
        return templateReplacement(service, content, node, rule);
      },
    });
  }

  function addDefaultSemanticRules(service) {
    // A naked <pre> is valid HTML but is not a Markdown fenced-code shape.
    // Always add a balanced, collision-safe fence so literal fences in the
    // source cannot swallow the rest of the document.
    service.addRule('default-naked-pre', {
      filter: function (node) {
        return node.nodeName === 'PRE' && (!node.firstChild || node.firstChild.nodeName !== 'CODE');
      },
      replacement: function (content, node, options) {
        if (options.codeBlockStyle === 'indented') {
          var code = String(node.textContent || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
          return '\n\n    ' + code.replace(/\n/g, '\n    ') + '\n\n';
        }
        return fencedCodeReplacement(node, {
          contentMode: 'text', language: '', stripExistingFence: false,
          trimBoundaryNewlines: false, fenceCharacter: '`',
        });
      },
    });
  }

  function createService(config) {
    config = config || {};
    var options = config.options || {};
    var service = new TurndownService({
      headingStyle: options.headingStyle === 'setext' ? 'setext' : 'atx',
      hr: '---',
      bulletListMarker: ['-', '*', '+'].indexOf(options.bulletListMarker) !== -1 ? options.bulletListMarker : '-',
      codeBlockStyle: options.codeBlockStyle === 'indented' ? 'indented' : 'fenced',
      fence: '```',
      emDelimiter: options.emDelimiter === '_' ? '_' : '*',
      strongDelimiter: options.strongDelimiter === '__' ? '__' : '**',
      linkStyle: 'inlined',
      preformattedCode: true,
    });
    if (options.gfm !== false && turndownPluginGfm && typeof turndownPluginGfm.gfm === 'function') {
      service.use(turndownPluginGfm.gfm);
    }

    addDefaultSemanticRules(service);

    var rules = config.customRules || [];
    if (!Array.isArray(rules)) throw new Error('customRules 必须是 JSON 数组');
    if (rules.length > MAX_CUSTOM_RULES) throw new Error('customRules 最多允许 ' + MAX_CUSTOM_RULES + ' 条');
    var normalized = rules.map(normalizeRule);
    // Turndown prepends rules. Reverse registration preserves array order as priority.
    for (var i = normalized.length - 1; i >= 0; i--) addCustomRule(service, normalized[i], i);
    return service;
  }

  function convert(html, config) {
    if (typeof TurndownService !== 'function') throw new Error('Turndown 运行时未加载');
    if (typeof html !== 'string') throw new Error('Turndown 输入必须是 HTML 字符串');
    return createService(config).turndown(html);
  }

  return Object.freeze({ convert: convert });
});
