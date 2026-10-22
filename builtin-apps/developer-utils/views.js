import { iconFor } from './icons.js';

export function createRegexEditor(target, change) {
  const container = document.createElement('div'), highlights = document.createElement('pre'), input = document.createElement('textarea');
  container.className = 'regex-editor'; highlights.setAttribute('aria-hidden', 'true'); input.setAttribute('aria-label', '正则匹配文本'); input.maxLength = 65536; input.spellcheck = false; input.autocomplete = 'off';
  container.append(highlights, input); target.before(container);
  const sync = () => { highlights.scrollTop = input.scrollTop; highlights.scrollLeft = input.scrollLeft; };
  input.addEventListener('input', () => { highlights.textContent = input.value + '\n'; sync(); change(); }); input.addEventListener('scroll', sync);
  return {
    set hidden(value) { container.hidden = value; }, set disabled(value) { input.disabled = value; },
    get value() { return input.value; }, set value(value) { input.value = value; highlights.textContent = value + '\n'; },
    clear() { highlights.textContent = input.value + '\n'; sync(); },
    highlight(matches) {
      highlights.replaceChildren(); let offset = 0;
      for (const match of matches) { highlights.append(document.createTextNode(input.value.slice(offset, match.index))); const mark = document.createElement('mark'); mark.textContent = match.value; if (!match.value) mark.className = 'empty-match'; highlights.append(mark); offset = match.index + match.value.length; }
      highlights.append(document.createTextNode(input.value.slice(offset) + '\n')); sync();
    },
    select(match) { input.focus(); input.setSelectionRange(match.index, match.index + match.value.length); highlights.querySelectorAll('mark')[match.order]?.scrollIntoView({ block: 'nearest' }); input.scrollTop = highlights.scrollTop; }
  };
}

export function createRadixFields(target, copy, change, paste) {
  const inputs = new Map(); let customBase = 36, active = null;
  const customField = document.createElement('div'); customField.className = 'radix-custom';
  for (const base of [2, 8, 10, 16, 'custom']) {
    const field = valueField(base === 'custom' ? '自定义进制数值' : base + ' 进制', '', copy), input = field.querySelector('input');
    input.readOnly = false; input.maxLength = 4096; input.spellcheck = false;
    const update = () => { active = base; for (const [key, other] of inputs) if (key !== base) other.value = ''; change(input.value, base === 'custom' ? customBase : base); };
    input.addEventListener('input', update);
    for (const [label, action] of [['粘贴', () => paste(value => { input.value = value; update(); })], ['清空', () => { input.value = ''; update(); }]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); field.querySelector('.value-row').append(button);
    }
    inputs.set(base, input);
    if (base === 'custom') { field.firstElementChild.className = 'sr-only'; customField.append(field); target.append(customField); }
    else target.append(field);
  }
  return {
    customField,
    update(value) { for (const [base, input] of inputs) if (base !== active) input.value = value[base === 'custom' ? customBase : base] || ''; },
    setBase(base) { if (customBase !== base && active === 'custom') active = null; customBase = base; },
    clear() { active = null; for (const input of inputs.values()) input.value = ''; }
  };
}

export function valueField(label, value, copy) {
  const field = document.createElement('label'); field.className = 'value-field';
  const title = document.createElement('span'); title.textContent = label;
  const row = document.createElement('div'); row.className = 'value-row';
  const input = document.createElement('input'); input.type = 'text'; input.readOnly = true;
  input.value = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const button = document.createElement('button'); button.type = 'button'; button.title = '复制 ' + label;
  button.setAttribute('aria-label', button.title); button.append(iconFor('copy'));
  button.addEventListener('click', () => copy(input.value, '已复制 ' + label + '。'));
  row.append(input, button); field.append(title, row); return field;
}

export function renderFieldsPreview(target, groups, copy) {
  const grid = document.createElement('div'); grid.className = 'value-grid';
  for (const fields of groups) {
    const column = document.createElement('div'); column.className = 'value-column';
    for (const [label, value] of fields) column.append(valueField(label, value, copy));
    grid.append(column);
  }
  target.append(grid);
}

export function renderToolPreview(target, entry, body, value, copy, selectMatch, updateOutput) {
  if (entry.tool === 'randomRecipe' && body.options.colors) {
    const pre = document.createElement('pre'); pre.className = 'random-output';
    for (const text of value.match(/\p{N}+|[^\p{L}\p{N}\s]+|[\p{L}\s]+/gu) || []) {
      const span = document.createElement('span'); span.textContent = text; span.className = /^\p{N}/u.test(text) ? 'random-digit' : /^[^\p{L}\p{N}\s]/u.test(text) ? 'random-symbol' : ''; pre.append(span);
    }
    target.append(pre); return true;
  }
  if (entry.id === 'colortools') {
    const tabs = document.createElement('div'); tabs.className = 'result-tabs';
    const content = document.createElement('pre'); content.className = 'color-code';
    const templateText = templates => Object.entries(templates).map(([name, code]) => '# ' + name + '\n\n' + code).join('\n\n');
    const views = { '代码模板': templateText(value.templates), '模板源码': templateText(value.templateSource), '颜色分量': JSON.stringify(value.variables, null, 2) };
    for (const [label, text] of Object.entries(views)) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => {
        content.textContent = text; target.dataset.colorView = label;
        for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab === button));
        updateOutput?.(text, label === '颜色分量' ? 'json' : 'plaintext');
      }); tabs.append(button);
    }
    ([...tabs.children].find(button => button.textContent === target.dataset.colorView) || tabs.firstChild).click();
    target.append(tabs, content); return true;
  }
  if (entry.id === 'cronparser') {
    const summary = document.createElement('p'); summary.className = 'cron-description'; summary.textContent = value.description;
    const list = document.createElement('dl'); list.className = 'result-table';
    for (const [label, text] of [...Object.entries(value.fields), ['后续执行时间（' + value.zone + '）', value.next.map(item => item.local).join('\n')]]) {
      const title = document.createElement('dt'), content = document.createElement('dd'); title.textContent = label; content.textContent = text; list.append(title, content);
    }
    target.append(summary, list); return true;
  }
  if (entry.id === 'hashing') {
    const count = document.createElement('p'); count.textContent = value.bytes + ' 字节'; target.append(count);
    renderFieldsPreview(target, [Object.entries(value.hashes)], copy); return true;
  }
  if (entry.id === 'stringinspect') {
    const labels = { characters: 'Unicode 字符', graphemes: '可见字素', bytes: 'UTF-8 字节', words: '词数', lines: '行数', location: '位置', length: '选区长度', line: '当前行', column: '列', ascii: 'ASCII', unicode: 'Unicode' };
    for (const [heading, entries] of [['计数', Object.entries(value.counts)], ['字符', Object.entries(value.selection).filter(([key]) => ['ascii', 'unicode'].includes(key))], ['选区', Object.entries(value.selection).filter(([key]) => !['ascii', 'unicode'].includes(key))]]) {
      const title = document.createElement('h3'), list = document.createElement('dl'); title.textContent = heading; list.className = 'inspect-counts';
      for (const [key, item] of entries) { const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = labels[key]; detail.textContent = item; list.append(term, detail); }
      target.append(title, list);
    }
    const title = document.createElement('h3'); title.textContent = '词频';
    const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = '筛选词语'; filter.setAttribute('aria-label', '筛选词频');
    const list = document.createElement('pre'); const render = () => { list.textContent = value.frequency.filter(([word]) => word.includes(filter.value)).map(([word, count]) => word + ': ' + count).join('\n'); };
    filter.addEventListener('input', render); render(); target.append(title, filter, list); return true;
  }
  if (entry.tool === 'diffs') {
    const pre = document.createElement('pre'); pre.className = 'inline-diff';
    const changes = [];
    for (const part of value) { const span = document.createElement(part.added ? 'ins' : part.removed ? 'del' : 'span'); span.textContent = part.value; pre.append(span); if (part.added || part.removed) { span.tabIndex = -1; changes.push(span); } }
    const navigation = document.createElement('div'), count = document.createElement('span'); navigation.className = 'diff-navigation'; count.textContent = changes.length + ' 处差异'; navigation.append(count);
    let active = -1;
    for (const [label, step] of [['上一处', -1], ['下一处', 1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = !changes.length;
      button.addEventListener('click', () => { active = active < 0 ? step > 0 ? 0 : changes.length - 1 : (active + step + changes.length) % changes.length; changes[active].focus({ preventScroll: true }); changes[active].scrollIntoView({ block: 'nearest' }); count.textContent = (active + 1) + ' / ' + changes.length + ' 处差异'; }); navigation.append(button);
    }
    target.append(navigation, pre); return true;
  }
  if (entry.tool === 'urlParse') {
    const fields = [['Protocol', value.protocol], ['Host', value.hostname], ['Path', value.pathname], ['File name', value.pathname.split('/').pop()], ['Query', value.search]];
    for (const [key, label] of [['port', 'Port'], ['username', 'Username'], ['password', 'Password'], ['hash', 'Fragment']]) if (value[key]) fields.push([label, value[key]]);
    const list = document.createElement('dl'); list.className = 'url-components';
    for (const [label, value] of fields) { const term = document.createElement('dt'), content = document.createElement('dd'); term.textContent = label; content.textContent = value; list.append(term, content); }
    target.append(list);
    const heading = document.createElement('h3'); heading.textContent = 'Query string';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '复制'; button.addEventListener('click', () => copy(JSON.stringify(value.query, null, 2), '已复制查询参数。')); heading.append(button);
    const editor = document.createElement('page-code-editor'); editor.setAttribute('language', 'json'); editor.setAttribute('readonly', ''); editor.setAttribute('aria-label', 'URL 查询参数');
    editor.value = JSON.stringify(value.query, null, 2); target.append(heading, editor); return true;
  }
  if (entry.tool === 'regex' && body.operation === 'inspect') {
    const layout = document.createElement('div'); layout.className = 'regex-results';
    const output = document.createElement('pre'), groups = document.createElement('div'); groups.className = 'match-groups'; output.textContent = value.output;
    const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = '搜索匹配与分组'; filter.setAttribute('aria-label', filter.placeholder); groups.append(filter);
    const details = [];
    for (const [index, match] of value.matches.entries()) {
      const detail = document.createElement('details'), title = document.createElement('summary');
      title.textContent = (index + 1) + '. ' + JSON.stringify(match.value) + ' [' + match.index + ', ' + (match.index + match.value.length) + ']'; detail.append(title);
      title.addEventListener('click', () => selectMatch({ ...match, order: index }));
      for (const [key, group] of Object.entries(match.namedGroups || {})) detail.append(valueField(key, group, copy));
      match.groups.forEach((group, i) => detail.append(valueField('Group ' + (i + 1), group, copy))); groups.append(detail); details.push(detail);
    }
    filter.addEventListener('input', () => { for (const detail of details) detail.hidden = !detail.textContent.toLowerCase().includes(filter.value.toLowerCase()); });
    const navigation = document.createElement('div'), count = document.createElement('span'); navigation.className = 'diff-navigation'; count.textContent = value.matches.length + ' 个匹配'; navigation.append(count);
    let active = -1;
    for (const [label, step] of [['上一处', -1], ['下一处', 1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = !value.matches.length;
      button.addEventListener('click', () => { active = active < 0 ? step > 0 ? 0 : value.matches.length - 1 : (active + step + value.matches.length) % value.matches.length; selectMatch({ ...value.matches[active], order: active }); details[active].open = true; count.textContent = (active + 1) + ' / ' + value.matches.length + ' 个匹配'; }); navigation.append(button);
    }
    target.append(navigation); layout.append(output, groups); target.append(layout); return true;
  }
  if (entry.id === 'unixtime') {
    value ||= {};
    const unit = body.options.unit, unixLabel = unit === 'milliseconds' ? 'Unix 时间（毫秒）' : unit === 'nanoseconds' ? 'Unix 时间（纳秒）' : 'Unix 时间（秒）';
    const unixValue = unit === 'milliseconds' ? value.milliseconds : unit === 'nanoseconds' ? value.nanoseconds : value.seconds;
    const formats = ['本地日期', '短日期', 'ISO 日期（本地）', '日期与时间', '月日与时间', '月份', '月日年', '时间'];
    renderFieldsPreview(target, [
      [['本地时间', value.local], ['UTC（ISO 8601）', value.iso], ['相对时间', value.relative], [unixLabel, unixValue]],
      [['年内天数', value.dayOfYear], ['ISO 周数', value.weekOfYear], ['闰年', value.leapYear == null ? null : value.leapYear ? '是' : '否']],
      formats.map(label => [label, value.formats?.[label]])
    ], copy);
    for (const field of target.querySelectorAll('.value-field')) field.querySelector('button').disabled = field.querySelector('input').value === '';
    const otherFormats = target.querySelector('.value-column:last-child'); otherFormats.classList.add('time-other-formats');
    for (const label of otherFormats.querySelectorAll('.value-field > span')) label.className = 'sr-only';
    const heading = document.createElement('h3'); heading.textContent = '其他格式（本地）'; otherFormats.prepend(heading);
    return true;
  }
  return false;
}
