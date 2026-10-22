(function (U) {
  'use strict';
  const names = { class: 'className', for: 'htmlFor', 'http-equiv': 'httpEquiv', 'accept-charset': 'acceptCharset', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', contenteditable: 'contentEditable', spellcheck: 'spellCheck', autocomplete: 'autoComplete', autofocus: 'autoFocus', srcset: 'srcSet', crossorigin: 'crossOrigin', referrerpolicy: 'referrerPolicy', usemap: 'useMap', datetime: 'dateTime', frameborder: 'frameBorder', allowfullscreen: 'allowFullScreen', viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio' };
  const booleanNames = new Set('disabled checked selected multiple required readOnly autoFocus hidden controls loop muted open reversed noValidate formNoValidate allowFullScreen'.split(' '));
  const voidNames = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
  function styleObject(source) {
    const declarations = []; let start = 0, quote = '', depth = 0;
    for (let i = 0; i <= source.length; i++) {
      const char = source[i];
      if (char === '\\') { i++; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (i === source.length || char === ';' && depth === 0) { declarations.push(source.slice(start, i)); start = i + 1; }
    }
    const styles = Object.create(null);
    for (const declaration of declarations) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(':'); if (colon < 1) throw new Error('style 中的 CSS 声明缺少冒号');
      const property = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
      const key = property.startsWith('--') ? property : property.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      styles[key] = value;
    }
    return JSON.stringify(styles);
  }
  U.handlers.htmlToJsx = async input => {
    U.load('prettier'); U.load('html');
    const plugins = Object.values(prettierPlugins), { ast } = await prettier.__debug.parse(input, { parser: 'html', plugins });
    function render(node, depth = 0) {
      if (depth > 128) throw new Error('HTML 嵌套过深');
      if (node.type === 'docType') return '';
      if (node.type === 'comment') return '{/*' + node.value.replace(/\*\//g, '* /') + '*/}';
      if (node.type === 'text') return /^[\s]*$/.test(node.value) ? node.value : '{' + JSON.stringify(he.decode(node.value)) + '}';
      if (node.type !== 'element') throw new Error('暂不支持此 HTML 节点：' + node.type);
      const tag = node.rawName || node.name;
      const attributes = node.attrs.map(attribute => {
        const raw = attribute.rawName || attribute.name;
        if (/^on/i.test(raw)) throw new Error('请先移除内联事件 ' + raw + '，再在 React 中绑定函数');
        const name = names[raw.toLowerCase()] || (/^(data|aria)-/.test(raw) ? raw : raw.replace(/[-:]([a-z])/g, (_, char) => char.toUpperCase()));
        const value = he.decode(attribute.value || '', { isAttributeValue: true });
        if (name === 'style') return 'style={' + styleObject(value) + '}';
        return booleanNames.has(name) ? name : name + '={' + JSON.stringify(value) + '}';
      });
      const opening = '<' + tag + (attributes.length ? ' ' + attributes.join(' ') : '');
      if (voidNames.has(tag.toLowerCase()) || !node.children.length) return opening + ' />';
      const content = ['script', 'style'].includes(tag.toLowerCase()) ? '{' + JSON.stringify(node.children.map(child => child.value || '').join('')) + '}' : node.children.map(child => render(child, depth + 1)).join('');
      return opening + '>' + content + '</' + tag + '>';
    }
    const children = ast.children.filter(node => node.type !== 'docType' && !(node.type === 'text' && !node.value.trim()));
    const content = children.map(node => render(node)).join('\n');
    const jsx = children.length === 1 && children[0].type === 'element' ? content : '<div>' + content + '</div>';
    return (await prettier.format(jsx, { parser: 'babel', plugins, semi: false, singleQuote: true })).trim();
  };
})(OfflineTools);
