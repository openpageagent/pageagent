// Linked inputs and composite pages. Computation stays in /utilities.
import { copyText } from './feedback.js';

const viewIds = new Set(['ascii', 'radix', 'zhNumber', 'time', 'unit', 'json', 'color', 'jwt', 'urlParse', 'ipcalc', 'text', 'randomString']);
const inputOperations = { ascii: ['convert'], radix: ['all'], zhNumber: ['convert'], time: ['timestamp'], unit: ['convert'], json: ['format'], color: ['convert'], jwt: ['decode'], urlParse: ['parse'], ipcalc: ['ipv4', 'ipv6'], text: ['statistics'], randomString: [] };
let fieldId = 0;
const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const element = (tag, className = '') => { const node = document.createElement(tag); node.className = className; return node; };
function input(value = '', type = 'text') { const node = element('input'); node.type = type; node.value = value; node.autocomplete = 'off'; node.spellcheck = false; return node; }
function select(items, value) {
  const node = element('select'); node.append(...items.map(item => Array.isArray(item) ? new Option(item[1], item[0]) : new Option(item, item)));
  if (value !== undefined) node.value = value; return node;
}
function button(title, action) { const node = element('button'); node.type = 'button'; node.textContent = title; node.addEventListener('click', action); return node; }
function copyButton(control) {
  const node = button('复制', () => copyText(control.value)); node.setAttribute('aria-label', '复制' + (control.getAttribute('aria-label') || '内容')); return node;
}
function label(title, control, withCopy = true) {
  const node = element('div', 'view-field'), caption = element('label');
  if (!control.id) control.id = 'view-field-' + ++fieldId;
  caption.htmlFor = control.id; caption.textContent = title; node.append(caption, control); control.setAttribute('aria-label', title);
  if (withCopy && (control.tagName === 'TEXTAREA' || control.tagName === 'INPUT' && control.type === 'text' && control.readOnly)) node.append(copyButton(control));
  return node;
}
function checkbox(title, checked = false) { const control = input('', 'checkbox'); control.checked = checked; return { control, label: label(title, control) }; }
function editor(title, readonly = false, language = 'plaintext', showTitle = true) {
  const panel = element('section', 'view-editor'), control = element('page-code-editor');
  if (showTitle) { const heading = element('h3'); heading.textContent = title; panel.append(heading); }
  else control.setAttribute('placeholder', title);
  control.setAttribute('aria-label', title); control.setAttribute('language', language); control.toggleAttribute('readonly', readonly); panel.append(control); return { panel, control };
}
function tabs(items, chosen, change) {
  const node = element('div'); node.setAttribute('role', 'tablist');
  for (const [id, title] of items) {
    const tab = button(title, () => {
      if (id === chosen) return;
      chosen = id;
      for (const child of node.children) { child.setAttribute('aria-selected', String(child === tab)); child.tabIndex = child === tab ? 0 : -1; }
      change(id);
    });
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(id === chosen)); tab.tabIndex = id === chosen ? 0 : -1; node.append(tab);
  }
  node.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const list = [...node.children], index = list.indexOf(document.activeElement); if (index < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    list[next].focus(); list[next].click();
  });
  return node;
}

export function createToolViews(container, { request, permitted, message, createIcon }) {
  let current = null, catalog = [], revision = 0, timer, queue = Promise.resolve(), refresh = () => {}, snapshot = () => null, cleanup = () => {};
  let fillInput = null;
  const stale = Symbol('stale');
  function schedule(work, delay = 180) {
    clearTimeout(timer); const ticket = ++revision;
    timer = setTimeout(() => {
      queue = queue.catch(() => {}).then(async () => {
        if (ticket !== revision || !permitted() || !current) return;
        const call = async (id, operation, value = '', options = {}) => {
          if (ticket !== revision || !permitted()) throw stale;
          const tool = catalog.find(item => item.id === id);
          const result = await request('POST', tool.operationUris[operation], { input: value, options });
          if (ticket !== revision || !permitted()) throw stale;
          return result.value;
        };
        try { await work(call); if (ticket === revision) message(''); }
        catch (error) { if (error !== stale && ticket === revision) message(error.message, true); }
      });
    }, delay);
  }
  function clearControls(controls) { revision++; clearTimeout(timer); controls.forEach(control => { control.value = ''; }); message(''); }
  function attachRefresh(node, action) { node.addEventListener('input', action); }
  function linked(id) {
    const types = id === 'ascii' ? [['text', '文本'], ['binary', '二进制'], ['octal', '八进制'], ['decimal', '十进制'], ['hex', '十六进制']]
      : [['number', '数字'], ['lower', '中文小写'], ['upper', '中文大写'], ['money', '金额大写']];
    const rows = new Map(), traditional = checkbox('繁体'); let source = types[0][0];
    if (id === 'ascii') container.classList.add('ascii-view');
    const update = () => {
      const value = rows.get(source).value;
      if (!value) { clearControls([...rows.values()]); return; }
      for (const [key, control] of rows) if (key !== source) control.value = '';
      schedule(async call => {
        const result = await call(id, 'convert', value, { from: source, ...(id === 'zhNumber' ? { traditional: traditional.control.checked } : {}) });
        for (const [key, control] of rows) if (key !== source) control.value = result[key];
      });
    };
    for (const [key, title] of types) {
      const control = id === 'ascii' ? element('textarea') : input(); control.rows = 3; control.readOnly = key === 'money';
      rows.set(key, control);
      if (id === 'ascii') {
        const row = element('div', 'ascii-field'), actions = element('div', 'app-actions');
        control.setAttribute('aria-label', title); control.placeholder = title; control.spellcheck = false;
        const copy = copyButton(control); copy.textContent = title; copy.title = '复制' + title; actions.append(copy); row.append(control, actions); container.append(row);
      } else { const row = label(title, control); if (!control.readOnly) row.append(copyButton(control)); container.append(row); }
      attachRefresh(control, () => { source = key; update(); });
    }
    if (id === 'zhNumber') { const actions = element('div', 'toolbar'); actions.append(traditional.label); container.append(actions); attachRefresh(traditional.control, update); }
    else {
      const reference = element('dialog'), table = element('table'); reference.append(button('关闭', () => reference.close()), table); container.append(reference);
      container.firstElementChild.querySelector('.app-actions').prepend(button('码表', () => { reference.showModal(); if (!table.children.length) schedule(async call => {
        const values = await call('ascii', 'table');
        const head = element('tr'); for (const title of ['十进制', '十六进制', '字符']) { const cell = element('th'); cell.textContent = title; head.append(cell); } table.append(head);
        for (const item of values) { const row = element('tr'); for (const value of [item.code, item.hex, item.character]) { const cell = element('td'); cell.textContent = value; row.append(cell); } table.append(row); }
      }, 0); })); reference.addEventListener('close', update);
    }
    refresh = update;
    snapshot = () => ({ operation: 'convert', input: rows.get(source).value, options: { from: source, ...(id === 'zhNumber' ? { traditional: traditional.control.checked } : {}) } });
    fillInput = value => { source = types[0][0]; rows.get(source).value = value; update(); };
  }
  function radix() {
    const alphabet = input(current.fields.alphabet.default), rows = [], results = element('div', 'conversion-grid'), more = element('dialog'), settings = element('div', 'view-stack'), actions = element('div', 'toolbar');
    more.append(button('关闭', () => more.close()), results); actions.hidden = true; let source = 2;
    const update = () => {
      const value = rows[source].control.value;
      actions.hidden = true; settings.hidden = false;
      if (!value) { clearControls(rows.map(row => row.control)); rows.forEach(row => { row.base.disabled = false; }); results.replaceChildren(); return; }
      rows.forEach((row, index) => { row.base.disabled = false; if (index !== source) row.control.value = ''; }); results.replaceChildren();
      schedule(async call => {
        const result = await call('radix', 'all', value, { from: Number(rows[source].base.value), alphabet: alphabet.value });
        rows.forEach((row, index) => { if (index !== source) row.control.value = result[row.base.value]; row.base.disabled = index === source; });
        actions.hidden = false; settings.hidden = true;
        results.replaceChildren();
        for (const [base, value] of Object.entries(result)) { const control = input(value); control.readOnly = true; results.append(label(base + ' 进制', control)); }
      });
    };
    for (const base of [2, 8, 10, 16, 60, 64]) {
      const row = element('div', 'linked-row'), choice = select(Array.from({ length: 63 }, (_, index) => [index + 2, index + 2 + ' 进制']), base), control = input();
      const index = rows.length; choice.setAttribute('aria-label', '进制'); control.setAttribute('aria-label', base + ' 进制数值'); row.append(control, choice, copyButton(control)); rows.push({ base: choice, control }); container.append(row);
      attachRefresh(control, () => { source = index; update(); }); choice.addEventListener('change', update);
    }
    settings.append(label('字符表（64 个不同字符）', alphabet), button('重置字符表', () => { alphabet.value = current.fields.alphabet.default; update(); })); attachRefresh(alphabet, update);
    actions.append(button('更多进制', () => more.showModal()), button('清空', () => { clearControls(rows.map(row => row.control)); update(); }));
    container.append(settings, actions, more);
    refresh = update; snapshot = () => ({ operation: 'all', input: rows[source].control.value, options: { from: Number(rows[source].base.value), alphabet: alphabet.value } });
    fillInput = value => { source = 2; rows[source].base.value = '10'; rows[source].control.value = value; update(); };
  }
  function randomString() {
    container.classList.add('random-string-view');
    const specs = current.fields, defaultAlphabet = specs.alphabet.default;
    const output = editor('随机字符串', true, 'plaintext', false), outputPanel = element('section', 'app-panel random-output');
    const format = select([['text', 'Text'], ['json', 'JSON'], ['xml', 'XML'], ['yaml', 'YAML'], ['toml', 'TOML'], ['properties', 'Properties'], ['phpArray', 'PHP Array']], 'text');
    const formatGroup = element('div', 'app-actions random-format'), outputOptions = element('div', 'random-output-options'), optionBody = element('div', 'random-option-body');
    const textOptions = element('div', 'app-actions'), xmlOptions = element('div', 'app-actions');
    const quote = checkbox('添加引号'), delimiter = input(',\\n'), attributePrefix = input();
    const controls = element('div', 'app-panel app-actions random-controls'), alphabetGroup = element('div', 'random-alphabet');
    const alphabet = input(defaultAlphabet), length = input(specs.length.default, 'number'), count = input(10, 'number');
    let alphabetValue = defaultAlphabet, raw = null, formatCollapsed = false, optionsCollapsed = false;
    output.control.setAttribute('rows', '16'); output.control.setAttribute('data-label', ''); output.panel.classList.add('random-editor');
    format.id = 'random-output-format'; format.setAttribute('aria-label', '输出格式'); optionBody.id = 'random-output-options';
    alphabet.setAttribute('aria-label', '字符'); alphabet.maxLength = specs.alphabet.maxLength;
    delimiter.maxLength = specs.delimiter.maxLength; attributePrefix.maxLength = specs.attributePrefix.maxLength;
    for (const [control, spec] of [[length, specs.length], [count, specs.count]]) {
      control.min = spec.minimum; control.max = spec.maximum; control.step = '1'; control.required = true;
    }
    const generationOptions = () => {
      for (const [control, spec] of [[length, specs.length], [count, specs.count]]) {
        if (!control.checkValidity()) throw new Error(spec.title + '须为 ' + spec.minimum + '–' + spec.maximum + ' 的整数');
      }
      return { alphabet: alphabetValue, length: length.valueAsNumber, count: count.valueAsNumber };
    };
    const formatOptions = () => ({ outputFormat: format.value,
      ...(format.value === 'text' ? { addQuote: quote.control.checked, delimiter: delimiter.value } : {}),
      ...(format.value === 'xml' ? { attributePrefix: attributePrefix.value } : {})
    });
    const syncFormat = () => {
      format.hidden = formatCollapsed;
      outputOptions.dataset.collapsed = String(optionsCollapsed);
      for (const [control, collapsed, title] of [[toggleFormat, formatCollapsed, '输出格式'], [toggleOptions, optionsCollapsed, '格式选项']]) {
        control.title = (collapsed ? '展开' : '收起') + title;
        control.setAttribute('aria-label', control.title); control.setAttribute('aria-expanded', String(!collapsed));
      }
      const hasOptions = ['text', 'xml'].includes(format.value);
      toggleOptions.style.visibility = hasOptions ? '' : 'hidden'; toggleOptions.inert = !hasOptions;
      for (const [panel, type] of [[textOptions, 'text'], [xmlOptions, 'xml']]) {
        const active = format.value === type && !optionsCollapsed;
        panel.dataset.active = String(active); panel.inert = !active; panel.setAttribute('aria-hidden', String(!active));
      }
    };
    const update = (generate = false, delay = 180) => {
      if (generate) raw = null;
      syncFormat();
      schedule(async call => {
        const ticket = revision;
        try {
          // Keep the batch as JSON so a character such as a newline cannot split a value.
          if (raw === null) raw = await call('randomString', 'generate', '', { ...generationOptions(), outputFormat: 'json' });
          const options = formatOptions(), result = raw === '[]' ? '' : await call('randomString', 'format', raw, { ...options, inputFormat: 'json' });
          output.control.setAttribute('language', ({ text: 'plaintext', phpArray: 'php' })[options.outputFormat] || options.outputFormat);
          output.control.value = result;
        } catch (error) { if (error !== stale && ticket === revision) output.control.value = ''; throw error; }
      }, delay);
    };
    const iconButton = (icon, title, action) => {
      const control = button('', action); control.append(createIcon(icon)); control.className = 'random-icon-button'; control.title = title; control.setAttribute('aria-label', title); return control;
    };
    const toggleFormat = iconButton('fa-caret-left', '收起输出格式', () => { formatCollapsed = !formatCollapsed; syncFormat(); });
    const toggleOptions = iconButton('fa-caret-right', '收起格式选项', () => { optionsCollapsed = !optionsCollapsed; syncFormat(); });
    toggleFormat.setAttribute('aria-controls', format.id); toggleOptions.setAttribute('aria-controls', optionBody.id);
    const settings = element('dialog', 'random-settings'), header = element('div', 'app-actions random-settings-header'), title = element('h3');
    const draft = element('textarea'), groups = element('div', 'app-actions random-character-groups'), checks = [];
    title.textContent = '设置 字符'; title.id = 'random-settings-title'; settings.setAttribute('aria-labelledby', title.id);
    draft.setAttribute('aria-label', '字符'); draft.autofocus = true; draft.spellcheck = false; draft.maxLength = specs.alphabet.maxLength;
    const syncChecks = () => { for (const [control, characters] of checks) control.checked = [...characters].some(char => draft.value.includes(char)); };
    for (const [name, characters] of [['数字', '0123456789'], ['小写字母', 'abcdefghijklmnopqrstuvwxyz'], ['大写字母', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'], ['特殊符号', '`~!@#$%^&*()-_=+[{]}|;:\',<.>/?']]) {
      const choice = checkbox(name); checks.push([choice.control, characters]); groups.append(choice.label);
      choice.control.addEventListener('change', () => {
        const values = choice.control.checked ? [...draft.value, ...characters] : [...draft.value].filter(char => !characters.includes(char));
        draft.value = [...new Set(values)].join(''); syncChecks();
      });
    }
    draft.addEventListener('input', syncChecks);
    groups.append(button('重置', () => { draft.value = defaultAlphabet; syncChecks(); }));
    const confirm = button('确定', () => {
      if (draft.value !== alphabetValue) { alphabetValue = draft.value; alphabet.value = alphabetValue; update(true); }
      settings.close();
    });
    confirm.className = 'btn-primary random-settings-confirm';
    header.append(title, iconButton('fa-times', '关闭字符设置', () => settings.close())); settings.append(header, draft, groups, confirm);
    alphabetGroup.append(alphabet, iconButton('fa-cog', '设置字符', () => { draft.value = alphabetValue; syncChecks(); settings.showModal(); }));
    controls.append(alphabetGroup, label('长度', length), label('数量', count), iconButton('fa-refresh', '重新生成', () => update(true, 0)));
    textOptions.append(quote.label, label('分隔符', delimiter)); xmlOptions.append(label('属性前缀', attributePrefix)); optionBody.append(textOptions, xmlOptions);
    formatGroup.append(toggleFormat, format); outputOptions.append(formatGroup, toggleOptions, optionBody);
    outputPanel.append(output.panel, outputOptions); container.append(outputPanel, controls, settings);
    alphabet.addEventListener('input', () => { alphabetValue = alphabet.value; update(true); });
    for (const control of [length, count]) control.addEventListener('input', () => update(true));
    format.addEventListener('change', () => update(false, 0));
    for (const control of [quote.control, delimiter, attributePrefix]) control.addEventListener('input', () => update());
    cleanup = () => { if (settings.open) settings.close(); };
    snapshot = () => ({ operation: 'generate', input: '', options: { ...generationOptions(), ...formatOptions() } });
    refresh = () => update(false, 0); refresh();
  }
  function unit() {
    const categories = element('div', 'unit-categories'), controls = element('div', 'unit-inputs'), value = input('1'), from = select([]), to = select([]), output = element('div', 'conversion-grid');
    let groups = [], group;
    const swap = button('⇄', () => { if (to.value === 'all') return; const old = from.value; from.value = to.value; to.value = old; update(); }); swap.setAttribute('aria-label', '交换单位');
    [value, from, to, swap].forEach(control => { control.disabled = true; });
    const update = () => { swap.disabled = !group || to.value === 'all'; output.replaceChildren(); if (!group || !value.value) { revision++; return; } schedule(async call => {
      const result = await call('unit', 'convert', value.value, { group: group.id, from: from.value, to: to.value }); output.replaceChildren();
      if (typeof result === 'string') { const equation = element('p', 'unit-equation'); equation.textContent = value.value + ' ' + from.value + ' = ' + result; output.append(equation); }
      else for (const [key, item] of Object.entries(result)) { const control = input(item); control.readOnly = true; output.append(label(key, control)); }
    }); };
    const choose = item => { group = item; from.replaceChildren(...item.units.map(unit => new Option(unit, unit))); to.replaceChildren(new Option('全部', 'all'), ...item.units.map(unit => new Option(unit, unit))); from.value = item.main; to.value = 'all'; update(); };
    controls.append(label('数值', value), label('从', from), swap, label('到', to));
    container.append(categories, controls, output); [value, from, to].forEach(control => attachRefresh(control, update));
    refresh = () => { if (groups.length) update(); else schedule(async call => {
      groups = await call('unit', 'groups');
      [value, from, to].forEach(control => { control.disabled = false; });
      for (const item of groups) { const control = input('', 'radio'); control.name = 'unit-group'; control.checked = item.id === 'length'; control.addEventListener('change', () => choose(item)); categories.append(label(item.label, control)); }
      choose(groups[0]);
    }, 0); };
    snapshot = () => ({ operation: 'convert', input: value.value, options: { group: group?.id || 'length', from: from.value, to: to.value } }); refresh();
    fillInput = text => { value.value = text; if (group) update(); };
  }
  function time() {
    container.classList.add('time-view');
    const body = element('section'), browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', panes = new Map();
    let feature = 'timestamp', zoneOptions = [], active, incoming = null;
    const zoneSelect = value => select(zoneOptions.map(item => [item.value, item.label]), value);
    const copyValue = value => { if (value) void copyText(value); };
    function timestamp() {
      const panel = element('div', 'time-body timestamp-fields'), zone = zoneSelect(browserZone), source = input(incoming ?? '');
      const unitNames = { seconds: 'Unix时间戳(秒)', milliseconds: 'Unix时间戳(毫秒)', nanoseconds: 'Unix时间戳(纳秒)' };
      const kind = select([['auto', '自动识别类型'], ...Object.entries(unitNames)], 'auto'), inputRow = label('输入', source), rows = new Map(), precision = element('div', 'timestamp-precision');
      source.placeholder = '支持 YYYY-MM-DD HH:mm:ss[.\\d+] 与 时间戳(秒/毫秒/纳秒) 输入';
      kind.setAttribute('aria-label', '时间戳类型'); inputRow.classList.add('timestamp-input');
      const clear = button('清空', () => { source.value = ''; update(); });
      panel.append(label('时区', zone), inputRow);
      for (const [key, title] of [['seconds', '秒'], ['milliseconds', '毫秒'], ['nanoseconds', '纳秒']]) {
        const control = input(); control.readOnly = true; const field = label(title, control, false), copy = copyButton(control);
        rows.set(key, { control, field, copy }); (key === 'seconds' ? panel : precision).append(field);
      }
      const examples = element('table', 'time-examples'), head = element('thead'), heading = element('tr'), exampleBody = element('tbody'), clockStatus = element('caption'), exampleRows = [];
      clockStatus.hidden = true;
      for (const title of ['格式', '值', '操作']) { const cell = element('th'); cell.scope = 'col'; cell.textContent = title; heading.append(cell); }
      head.append(heading); examples.append(clockStatus, head, exampleBody); panel.append(precision, examples);
      for (const [key, title] of [['formatted', '标准时间(秒)'], ['seconds', 'Unix时间戳(秒)'], ['formattedMilliseconds', '标准时间(毫秒)'], ['milliseconds', 'Unix时间戳(毫秒)']]) {
        const row = element('tr'), name = element('td'), data = element('td'), link = element('a'), action = element('td'); name.textContent = title;
        link.href = '#'; link.title = '复制'; link.setAttribute('aria-label', '复制' + title); link.addEventListener('click', event => { event.preventDefault(); copyValue(link.textContent); });
        const load = button('加载', () => { source.value = link.textContent; update(); }); load.hidden = true;
        data.append(link); action.append(load); row.append(name, data, action); exampleBody.append(row); exampleRows.push({ key, link, load });
      }
      const update = () => {
        clearControls([...rows.values()].map(row => row.control)); for (const row of rows.values()) row.copy.remove();
        kind.options[0].text = '自动识别类型';
        if (/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(source.value.trim())) {
          if (kind.parentNode !== inputRow) inputRow.insertBefore(kind, clear.parentNode === inputRow ? clear : null);
        } else kind.remove();
        if (source.value) { if (clear.parentNode !== inputRow) inputRow.append(clear); } else clear.remove();
        if (!source.value.trim()) return;
        schedule(async call => {
          try {
            const value = await call('time', 'timestamp', source.value, { zone: zone.value, sourceZone: zone.value, unit: kind.value });
            for (const [key, row] of rows) { row.control.value = value.display[key]; row.field.append(row.copy); }
            kind.options[0].text = '自动识别类型:' + unitNames[value.autoUnit];
          } catch (error) { if (error === stale) throw error; for (const row of rows.values()) row.control.value = error.message; throw error; }
        });
      };
      let clockTimer;
      const stopClock = () => { clearTimeout(clockTimer); document.removeEventListener('visibilitychange', startClock); };
      const startClock = () => {
        stopClock(); document.addEventListener('visibilitychange', startClock);
        if (document.hidden || !permitted()) return;
        try {
          const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone.value, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
          const tick = () => {
            if (document.hidden || !permitted()) return;
            // Read the wall clock locally so display updates do not wait for utility requests.
            const now = Date.now(), parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
            const formatted = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
            const values = { formatted, seconds: String(Math.floor(now / 1000)), formattedMilliseconds: formatted + '.' + String(now % 1000).padStart(3, '0'), milliseconds: String(now) };
            for (const row of exampleRows) {
              if (row.link.textContent !== values[row.key]) row.link.textContent = values[row.key];
              row.load.hidden = false;
            }
            clockTimer = setTimeout(tick, 100);
          };
          clockStatus.hidden = true; tick();
        } catch (error) { clockStatus.textContent = error.message; clockStatus.hidden = false; }
      };
      [source, kind].forEach(control => attachRefresh(control, update));
      attachRefresh(zone, () => { update(); for (const row of exampleRows) { row.link.textContent = ''; row.load.hidden = true; } startClock(); });
      return { panel, refresh() { update(); startClock(); }, stop: stopClock,
        load: value => { source.value = value; update(); },
        snapshot: () => ({ operation: 'timestamp', input: source.value, options: { zone: zone.value, sourceZone: zone.value, unit: kind.value } }) };
    }
    function timezone() {
      const panel = element('div', 'time-body'), rows = [], list = element('div', 'view-stack'), footer = element('div', 'time-zone-footer'), actions = element('div', 'time-zone-actions');
      const more = element('dialog'), all = element('div', 'view-stack time-zone-more'); more.setAttribute('aria-label', '全部时区'); more.append(button('关闭', () => more.close()), all); panel.append(list, footer, more);
      let source = 0, converted = null;
      const paint = () => {
        const origin = rows[source].zone.value, raw = rows[source].control.value;
        for (const row of rows) { row.control.value = row.zone.value === origin ? raw : converted[row.zone.value]; row.zone.disabled = row.zone.value === origin; row.panel.append(row.copy); }
        footer.replaceChildren(actions);
      };
      const update = (now = false) => {
        converted = null; if (now) source = 0;
        clearControls(rows.filter((_, index) => index !== source).map(row => row.control));
        for (const row of rows) { row.zone.disabled = false; row.copy.remove(); }
        footer.replaceChildren(currentButton);
        if (!now && !rows[source].control.value.trim()) return;
        schedule(async call => {
          try {
            const origin = rows[source].zone.value;
            if (now) rows[source].control.value = (await call('time', 'now', '', { zone: origin })).formatted;
            converted = await call('time', 'timezone', rows[source].control.value, { sourceZone: origin, zone: 'all' }); paint();
          } catch (error) { if (error === stale) throw error; rows.forEach((row, index) => { if (index !== source) row.control.value = error.message; }); throw error; }
        });
      };
      for (const zone of [...new Set([browserZone, 'Asia/Shanghai', 'Europe/London', 'Asia/Tokyo', 'America/Chicago', 'Europe/Berlin', 'Africa/Cairo', 'Asia/Calcutta'])].slice(0, 7)) {
        const row = element('div', 'linked-row time-zone-row'), control = input(), choice = zoneSelect(zone), index = rows.length;
        control.placeholder = '支持 YYYY-MM-DD HH:mm:ss[.SSS] 时间格式 输入'; control.setAttribute('aria-label', '当地时间 ' + (index + 1)); choice.setAttribute('aria-label', '时区 ' + (index + 1));
        rows.push({ panel: row, control, zone: choice, copy: copyButton(control) }); row.append(control, choice); list.append(row);
        attachRefresh(control, () => { source = index; update(); }); choice.addEventListener('change', () => { if (converted) paint(); else update(); });
      }
      const currentButton = button('当前时间', () => update(true));
      actions.append(button('更多', () => {
        if (!converted) return; all.replaceChildren();
        for (const item of zoneOptions) {
          if (converted[item.value] === undefined) continue;
          const row = element('div', 'linked-row time-zone-row'), control = input(converted[item.value]); control.readOnly = true; control.setAttribute('aria-label', item.label);
          const copy = button(item.label, () => copyValue(control.value)); copy.title = '复制'; copy.classList.toggle('btn-danger', item.value === rows[source].zone.value);
          row.append(control, copy); all.append(row);
        }
        more.showModal();
      }), button('清空', () => { rows[source].control.value = ''; update(); }));
      return { panel, refresh: () => update(), stop: () => { if (more.open) more.close(); }, snapshot: () => ({ operation: 'timezone', input: rows[source].control.value, options: { sourceZone: rows[source].zone.value, zone: rows.find((_, index) => index !== source).zone.value } }) };
    }
    function calculator() {
      const panel = element('div', 'time-calculators'), units = [['years', '年'], ['months', '月'], ['weeks', '周'], ['days', '天'], ['hours', '小时'], ['minutes', '分钟'], ['seconds', '秒']];
      const first = input(), second = input(), diffUnit = select(units, 'seconds'), base = input(), amount = input('1', 'number'), sign = select([['', '添加'], ['-', '减少']]), addUnit = select(units, 'days'), analyze = input(), period = select([['year', '年'], ['quarter', '季度'], ['month', '月']]);
      const context = { zone: browserZone, sourceZone: browserZone }; let initialized = false, operation = 'difference';
      const card = title => { const card = element('section', 'app-panel'), heading = element('h3'), row = element('div', 'time-calculator-row'), error = element('output', 'status-error'); heading.textContent = title; error.setAttribute('role', 'status'); card.append(heading, row, error); panel.append(card); return { row, error }; };
      const difference = card('差值计算器'), addition = card('时间操作'), analysis = card('时间分析'), diffResult = input(); diffResult.readOnly = true;
      const addResult = button('', () => copyValue(addResult.textContent)), analysisResult = button('', () => copyValue(analysisResult.textContent)); addResult.hidden = analysisResult.hidden = true;
      addResult.title = analysisResult.title = '复制';
      for (const [control, title] of [[first, '开始时间'], [second, '结束时间'], [base, '时间操作输入'], [analyze, '时间分析输入']]) { control.setAttribute('aria-label', title); control.classList.add('time-date'); }
      for (const [control, title] of [[diffResult, '相差'], [diffUnit, '差值单位'], [sign, '时间操作'], [amount, '数量'], [addUnit, '时间单位'], [period, '分析周期']]) control.setAttribute('aria-label', title);
      const diffQuantity = element('div', 'time-quantity'), addQuantity = element('div', 'time-quantity'); diffQuantity.append(diffResult, diffUnit); addQuantity.append(amount, addUnit);
      difference.row.append(first, '与', second, '相差', diffQuantity); addition.row.append(base, sign, addQuantity, '后, 为', addResult); analysis.row.append(analyze, period, analysisResult);
      const update = () => {
        clearControls([diffResult]); addResult.hidden = analysisResult.hidden = true;
        for (const card of [difference, addition, analysis]) card.error.textContent = '';
        schedule(async call => {
          const fill = async (card, control, work) => {
            try { const value = String(await work()); if (control === diffResult) control.value = value; else { control.textContent = value; control.hidden = false; } }
            catch (error) { if (error === stale) throw error; card.error.textContent = error.message; }
          };
          if (first.value && second.value) await fill(difference, diffResult, async () => (await call('time', 'difference', first.value, { ...context, other: second.value, interval: diffUnit.value })).value);
          if (base.value && amount.value !== '' && Number(amount.value) !== 0) await fill(addition, addResult, async () => { const date = await call('time', 'add', base.value, { ...context, amount: Number(sign.value + amount.value), interval: addUnit.value }); return (await call('time', 'timestamp', date, context)).formatted; });
          if (analyze.value) await fill(analysis, analysisResult, async () => (await call('time', 'analyze', analyze.value, { ...context, period: period.value })).description);
        });
      };
      amount.min = 0; amount.step = 1;
      for (const [id, card, controls] of [['difference', difference, [first, second, diffUnit]], ['add', addition, [base, amount, sign, addUnit]], ['analyze', analysis, [analyze, period]]]) {
        card.row.addEventListener('focusin', () => { operation = id; });
        controls.forEach(control => attachRefresh(control, () => { initialized = true; operation = id; update(); }));
      }
      return { panel, refresh() {
        if (initialized) { update(); return; }
        schedule(async call => {
          const now = await call('time', 'now', '', context), tomorrow = await call('time', 'add', now.iso, { ...context, amount: 1, interval: 'days' });
          const next = await call('time', 'timestamp', tomorrow, context);
          first.value = base.value = analyze.value = now.formatted; second.value = next.formatted; initialized = true; update();
        }, 0);
      }, snapshot: () => ({ operation, input: operation === 'difference' ? first.value : operation === 'add' ? base.value : analyze.value, options: { ...context, ...(operation === 'difference' ? { other: second.value, interval: diffUnit.value } : operation === 'add' ? { amount: Number(sign.value + amount.value), interval: addUnit.value } : { period: period.value }) } }) };
    }
    function render() {
      if (!zoneOptions.length) { loadZones(); return; }
      revision++; clearTimeout(timer); active?.stop?.();
      if (!panes.has(feature)) panes.set(feature, ({ timestamp, timezone, calculator })[feature]());
      active = panes.get(feature); body.replaceChildren(active.panel); refresh = active.refresh; snapshot = active.snapshot; refresh();
    }
    const loadZones = () => schedule(async call => { zoneOptions = await call('time', 'zones', '', { zone: browserZone }); render(); }, 0);
    cleanup = () => active?.stop?.(); refresh = loadZones;
    fillInput = value => { incoming = value; if (panes.has('timestamp')) panes.get('timestamp').load(value); };
    container.append(tabs([['timestamp', '时间戳'], ['timezone', '时区'], ['calculator', '计算器']], feature, value => { feature = value; render(); }), body); render();
  }
  function json() {
    container.classList.add('json-view');
    const main = editor('JSON 输入', false, 'json', false), side = editor('JSONPath 输出', true, 'json', false), source = editor('CSV 输入', false, 'plaintext', false);
    const editors = element('div', 'json-editors'), options = element('div', 'toolbar'), navigation = element('div', 'json-navigation');
    const expression = input(), expressions = { jsonpath: '', jmespath: '' }, schema = editor('JSON Schema 输入', false, 'json', false);
    const schemaPanel = element('section', 'json-schema-panel');
    const name = input(current.fields.name.default), formats = catalog.find(item => item.id === 'serialize').fields;
    const names = { csv: 'CSV', xml: 'XML', yaml: 'YAML', toml: 'TOML', properties: 'Properties', phpArray: 'PHP Array', php: 'Php Serialize', jsonpath: 'JSONPath', jmespath: 'JMESPath', typescript: 'TypeScript', javascript: 'JavaScript', java: 'Java', csharp: 'C#', go: 'Go', python: 'Python', protobuf: 'Protocol Buffers', rust: 'Rust', swift: 'Swift', kotlin: 'Kotlin' };
    const formatOrder = ['csv', 'xml', 'yaml', 'toml', 'properties', 'phpArray', 'php'];
    const editorLanguage = format => ({ csv: 'plaintext', properties: 'ini', phpArray: 'php', php: 'plaintext' })[format] || format;
    let feature = 'common', query = 'jsonpath', language = current.fields.language.default, from = 'csv', to = 'xml', schemaOpen = false, last = { operation: 'minify', options: {} };
    const objectDialog = element('dialog', 'json-object-dialog'), objectBody = element('div', 'json-object-body'), objectOptions = element('aside', 'app-panel'), objectTitle = element('h3'), pathOptions = label('JSONPath', expression);
    objectDialog.setAttribute('aria-label', '转实体类');
    objectOptions.append(objectTitle, label('类型名称', name)); objectBody.append(objectOptions); objectDialog.append(button('关闭', () => objectDialog.close()), objectBody);
    const currentTask = () => feature === 'path' ? { operation: query, options: { expression: expression.value } }
      : feature === 'object' ? { operation: 'toCode', options: { language, name: name.value } }
      : schemaOpen ? { operation: 'schema', options: { schema: schema.control.value } } : last;
    const run = (operation, operationOptions = {}) => {
      if (!main.control.value.trim()) return;
      last = { operation, options: operationOptions };
      schedule(async call => {
        main.control.value = text(await call('json', operation, main.control.value, operationOptions));
        update();
      }, 0);
    };
    const update = () => {
      revision++; clearTimeout(timer); side.control.value = ''; message('');
      if (!main.control.value.trim()) return;
      if (feature === 'to') schedule(async call => { side.control.value = text(await call('serialize', 'convert', main.control.value, { from: 'json', to })); });
      else if ((feature === 'path' && expression.value.trim()) || (feature === 'object' && objectDialog.open) || (schemaOpen && schema.control.value.trim())) {
        const task = currentTask();
        schedule(async call => { side.control.value = text(await call('json', task.operation, main.control.value, task.options)); });
      }
    };
    const convertSource = () => {
      revision++; clearTimeout(timer); message('');
      if (feature !== 'from' || !source.control.value.trim()) return;
      schedule(async call => { main.control.value = await call('serialize', 'convert', source.control.value, { from, to: 'json' }); });
    };
    const group = (title, items, choose) => {
      const choices = select([['', title], ...items]); choices.setAttribute('aria-label', title); choices.options[0].disabled = true; options.append(choices);
      choices.addEventListener('change', () => { const value = choices.value; choices.value = ''; if (value) choose(value); });
    };
    function render() {
      revision++; clearTimeout(timer); options.replaceChildren(); side.control.value = '';
      pathOptions.remove(); side.panel.classList.toggle('json-path-panel', feature === 'path');
      editors.dataset.columns = feature === 'object' || feature === 'common' && !schemaOpen ? 'one' : 'two';
      source.panel.hidden = feature !== 'from';
      schemaPanel.hidden = !schemaOpen;
      side.panel.hidden = !schemaOpen && !['path', 'to', 'object'].includes(feature);
      const sideParent = feature === 'object' ? objectBody : schemaOpen ? schemaPanel : editors;
      if (side.panel.parentElement !== sideParent) sideParent.insertBefore(side.panel, sideParent === objectBody ? objectOptions : null);
      if (feature === 'common') {
        options.append(button('压缩', () => run('minify')));
        group('转义', [['escape', '添加转义'], ['unescape', '移除转义']], value => run(value));
        group('Unicode', [['decode', 'Unicode转中文'], ['encode', '中文转Unicode']], value => run('unicode', { decodeUnicode: value === 'decode' }));
        group('键排序', [['asc', '升序'], ['desc', '降序']], value => run('sort', { descending: value === 'desc' }));
        group('键命名', [['kebab', 'kebab-case'], ['constant', 'SNAKE_CASE'], ['pascal', 'CamelCase'], ['camel', 'camelCase'], ['snake', 'snake_case']], value => run('rename', { naming: value }));
        const schemaButton = button('Schema', () => { schemaOpen = !schemaOpen; render(); }); schemaButton.setAttribute('aria-pressed', String(schemaOpen)); options.append(schemaButton);
      } else if (feature === 'path') {
        pathOptions.querySelector('label').textContent = names[query]; expression.setAttribute('aria-label', names[query]);
        side.panel.prepend(pathOptions);
        for (const id of ['jsonpath', 'jmespath']) { const choice = button(names[id], () => { if (query === id) return; query = id; expression.value = expressions[id]; render(); }); choice.setAttribute('aria-pressed', String(query === id)); options.append(choice); }
      } else if (feature === 'object') {
        for (const id of [...current.fields.language.enum].sort()) { const choice = button(id === 'php' ? 'PHP' : names[id] || id, () => { language = id; render(); objectDialog.showModal(); update(); }); choice.setAttribute('aria-pressed', String(language === id)); options.append(choice); }
      } else {
        for (const id of formatOrder.filter(id => formats[feature].enum.includes(id))) {
          const choice = button(names[id], () => {
            if ((feature === 'from' ? from : to) === id) return;
            if (feature === 'from') { from = id; source.control.value = ''; } else to = id;
            render();
          });
          choice.setAttribute('aria-pressed', String((feature === 'from' ? from : to) === id)); options.append(choice);
        }
      }
      const sideLabel = feature === 'object' ? (language === 'php' ? 'PHP' : names[language]) + ' 输出' : feature === 'to' ? names[to] + ' 输出' : schemaOpen ? 'JSON Schema 验证结果' : names[query] + ' 输出';
      side.control.setAttribute('aria-label', sideLabel); side.control.setAttribute('placeholder', sideLabel);
      side.control.setAttribute('language', feature === 'object' ? language : feature === 'to' ? editorLanguage(to) : 'json');
      source.control.setAttribute('aria-label', names[from] + ' 输入'); source.control.setAttribute('placeholder', names[from] + ' 输入'); source.control.setAttribute('language', editorLanguage(from));
      objectTitle.textContent = language === 'php' ? 'PHP' : names[language];
      if (feature === 'from') convertSource(); else update();
    }
    [main.control, schema.control, name].forEach(control => attachRefresh(control, update));
    attachRefresh(source.control, convertSource); attachRefresh(expression, () => { expressions[query] = expression.value; update(); });
    navigation.append(tabs([['common', '常用'], ['path', 'Path'], ['object', '转实体类'], ['from', '来自于'], ['to', '转换成']], feature, value => { feature = value; schemaOpen = false; render(); }), button('JSON 修复', () => run('repair')));
    // Keep shared editors connected so tab changes do not reload their shadow styles.
    schemaPanel.append(schema.panel); editors.append(source.panel, main.panel, side.panel, schemaPanel);
    container.append(editors, navigation, options, objectDialog);
    refresh = () => feature === 'from' ? convertSource() : update(); snapshot = () => feature === 'from' || feature === 'to' ? null : ({ ...currentTask(), input: main.control.value }); render();
    fillInput = value => { main.control.value = value; update(); };
  }
  function jwt() {
    container.classList.add('jwt-view');
    const source = editor('JWT', false, 'plaintext', false), result = editor('解析结果', true, 'json', false), header = checkbox('Header'), payload = checkbox('Payload', true), actions = element('div', 'app-actions editor-format');
    const format = select(['json', 'xml', 'yaml', 'toml', 'phpArray', 'properties']), formatRow = element('div', 'editor-format');
    source.control.setAttribute('rows', '6'); result.control.setAttribute('rows', '12'); format.setAttribute('aria-label', '输出格式');
    source.panel.classList.add('editor-with-format'); result.panel.classList.add('editor-with-format');
    const update = () => { result.control.value = ''; result.control.setAttribute('language', format.value); if (!source.control.value) { clearControls([result.control]); return; } schedule(async call => {
      const value = await call('jwt', 'decode', source.control.value); const displayed = {};
      if (header.control.checked) displayed.header = value.header; if (payload.control.checked) displayed.payload = value.payload;
      result.control.value = await call('serialize', 'convert', JSON.stringify(displayed), { from: 'json', to: format.value });
    }); };
    actions.append(header.label, payload.label); source.panel.append(actions); formatRow.append(format); result.panel.append(formatRow); container.append(source.panel, result.panel);
    [source.control, header.control, payload.control, format].forEach(control => attachRefresh(control, update)); refresh = update; snapshot = () => ({ operation: 'decode', input: source.control.value, options: {} });
    fillInput = value => { source.control.value = value; update(); };
  }
  function urlParse() {
    container.classList.add('url-parse-view');
    const source = editor('URL', false, 'plaintext', false), rows = new Map(), result = editor('Query', true, 'json', false), format = select(['json', 'xml', 'yaml', 'toml', 'phpArray', 'properties']);
    const details = element('div', 'url-details'), formatRow = element('div', 'editor-format');
    source.control.setAttribute('rows', '5'); result.control.setAttribute('rows', '12'); format.setAttribute('aria-label', 'Query 格式');
    container.append(source.panel, details);
    for (const [key, title] of [['origin', 'Base'], ['pathname', 'Path'], ['hash', 'Hash']]) {
      const control = input(), row = element('div', 'linked-row'); control.readOnly = true; control.setAttribute('aria-label', title); control.placeholder = title;
      const copy = copyButton(control); copy.textContent = title; copy.title = '复制' + title; rows.set(key, control); row.append(control, copy); details.append(row);
    }
    formatRow.append(format); result.panel.classList.add('editor-with-format'); result.panel.append(formatRow); container.append(result.panel);
    const update = () => {
      clearControls([...rows.values(), result.control]); result.control.setAttribute('language', format.value); if (!source.control.value) return;
      schedule(async call => {
        let value;
        try { value = await call('urlParse', 'parse', source.control.value); }
        catch (error) { if (error !== stale) rows.get('origin').value = error.message; throw error; }
        const query = await call('serialize', 'convert', JSON.stringify(value.query), { from: 'json', to: format.value });
        for (const [key, control] of rows) control.value = value[key]; result.control.value = query;
      });
    };
    [source.control, format].forEach(control => attachRefresh(control, update)); refresh = update; snapshot = () => ({ operation: 'parse', input: source.control.value, options: {} });
    fillInput = value => { source.control.value = value; update(); };
  }
  function ipcalc() {
    const address = input('192.168.0.1'), prefix = input('24'), options = element('div', 'toolbar'), result = element('div', 'ip-results'); let operation = 'ipv4';
    const target = select(Array.from({ length: 129 }, (_, index) => [index, '/' + index]), 64), ptr = select(Array.from({ length: 33 }, (_, index) => [index * 4, '/' + index * 4]), 32), abbreviated = checkbox('缩写'), limit = input('100', 'number'), random = checkbox('随机');
    const subnetDialog = element('dialog'), subnet = editor('子网 / 地址列表', true), subnetOptions = element('div', 'toolbar'), maskDialog = element('dialog'), hosts = input('254', 'number');
    const outputs = new Map(), maskControl = label('掩码', prefix), targetControl = label('子网前缀', target), ptrControl = label('PTR 前缀', ptr);
    limit.min = 1; limit.max = 1000; hosts.min = 1; hosts.max = 4294967294;
    const requestOptions = () => ({ ...(operation === 'ipv6' ? { targetPrefix: Number(target.value), ptrPrefix: Number(ptr.value), abbreviated: abbreviated.control.checked } : {}), ...(subnetDialog.open ? { subnets: true, limit: Number(limit.value), ...(operation === 'ipv6' ? { random: random.control.checked } : {}) } : {}) });
    const update = () => {
      clearControls([...outputs.values(), subnet.control]); if (!address.value) return;
      schedule(async call => {
        const value = await call('ipcalc', operation, address.value + '/' + prefix.value, requestOptions());
        for (const [key, control] of outputs) control.value = key.split('.').reduce((object, key) => object?.[key], value) ?? '-';
        if (value.subnets) subnet.control.value = value.subnets.join('\n') + (value.truncated ? '\n… 仅显示前 ' + limit.value + ' 个地址' : '');
      });
    };
    const maskButton = button('设置掩码', () => maskDialog.showModal()), maskActions = element('div', 'app-actions');
    maskActions.append(button('取消', () => maskDialog.close()), button('确定', () => schedule(async call => {
      const value = await call('ipcalc', 'ipv4', address.value + '/' + prefix.value, { maskHosts: Number(hosts.value) }); prefix.value = value.prefix; maskDialog.close(); update();
    }, 0)));
    maskDialog.append(label('可用地址数', hosts), maskActions);
    subnetOptions.append(label('数量（最多 1000）', limit), random.label); subnetDialog.append(button('关闭', () => subnetDialog.close()), subnetOptions, subnet.panel);
    function render() {
      revision++; clearTimeout(timer); result.replaceChildren(); outputs.clear();
      options.append(maskControl, maskButton); maskButton.hidden = operation !== 'ipv4'; random.label.hidden = operation !== 'ipv6';
      const card = (title, entries, controls = []) => {
        const panel = element('section', 'app-panel'), heading = element('h3'), toolbar = element('div', 'toolbar'), grid = element('div', 'conversion-grid'); heading.textContent = title;
        for (const [key, title] of entries) { const control = input(); control.readOnly = true; outputs.set(key, control); grid.append(label(title, control)); }
        toolbar.append(...controls); panel.append(heading, toolbar, grid); result.append(panel);
      };
      const showSubnets = button('子网', () => { subnetDialog.showModal(); update(); });
      if (operation === 'ipv4') {
        card('IP 信息', [['address', '点分十进制'], ['addressFormats.decimal', '整数'], ['addressFormats.octal', '八进制'], ['addressFormats.hex', '十六进制'], ['addressFormats.binary', '二进制']]);
        card('掩码信息', [['prefix', '位数'], ['mask', '掩码'], ['maskFormats.decimal', '整数'], ['hostMask', '反掩码'], ['maskFormats.octal', '八进制'], ['maskFormats.hex', '十六进制'], ['maskFormats.binary', '二进制']]);
        card('网络信息', [['usableHosts', '可用地址'], ['totalAddresses', '地址总数'], ['network', '网络地址'], ['firstHost', '首个主机'], ['lastHost', '末个主机'], ['broadcast', '广播地址']], [showSubnets]);
      } else {
        card('IP 信息', [['full', '完整'], ['short', '缩写']]);
        card('网络信息', [['subnetCount', '子网数量'], ['network', '起始地址'], ['lastAddress', '结束地址']], [maskControl, targetControl, abbreviated.label, showSubnets]);
        card('PTR', [['ptr', '反向解析']], [ptrControl]);
      }
      update();
    }
    options.append(label('IP 地址', address));
    container.append(tabs([['ipv4', 'IPv4'], ['ipv6', 'IPv6']], operation, value => { operation = value; prefix.value = value === 'ipv4' ? 24 : 32; address.value = value === 'ipv4' ? '192.168.0.1' : '2404:68::'; render(); }), options, result, subnetDialog, maskDialog);
    [address, prefix, target, ptr, abbreviated.control, limit, random.control].forEach(control => attachRefresh(control, update));
    refresh = update; snapshot = () => ({ operation, input: address.value + '/' + prefix.value, options: requestOptions() }); render();
    fillInput = (value, mode) => {
      container.querySelector('[role=tablist]').children[mode === 'ipv6' ? 1 : 0].click();
      const parts = value.split('/'); address.value = parts[0]; prefix.value = parts[1] ?? (mode === 'ipv6' ? '128' : '32'); update();
    };
  }
  function color() {
    const picker = input('#409eff', 'color'), alpha = input('1', 'range'), controls = element('div', 'color-picker'), rows = element('div'), values = new Map();
    alpha.min = 0; alpha.max = 1; alpha.step = .01; controls.append(label('颜色', picker), label('透明度', alpha)); container.classList.add('color-view'); container.append(controls, rows); let source = 'hex';
    const update = () => { for (const [key, control] of values) if (key !== source) control.value = ''; if (!values.get(source).value) { revision++; return; } schedule(async call => {
      const result = await call('color', 'convert', values.get(source).value); for (const [key, control] of values) if (key !== source) control.value = result[key] || '';
      picker.value = result.hex.slice(0, 7); alpha.value = result.alpha;
    }); };
    for (const key of ['name', 'hex', 'rgb', 'hsl', 'hwb', 'cmyk', 'lch', 'hsv', 'lab', 'xyz']) {
      const control = input(), row = element('div', 'linked-row'); control.setAttribute('aria-label', key.toUpperCase()); control.placeholder = key.toUpperCase(); values.set(key, control);
      const copy = copyButton(control); copy.textContent = key.toUpperCase(); copy.title = '复制 ' + key.toUpperCase(); row.append(control, copy); rows.append(row);
      attachRefresh(control, () => { source = key; update(); });
    }
    const updatePicker = () => { source = 'hex'; schedule(async call => {
      const value = await call('color', 'convert', picker.value, { alpha: alpha.value });
      for (const [key, control] of values) control.value = value[key] || '';
    }); };
    attachRefresh(picker, updatePicker); attachRefresh(alpha, updatePicker);
    values.get('hex').value = picker.value; refresh = update; snapshot = () => ({ operation: 'convert', input: values.get(source).value, options: {} }); update();
    fillInput = value => { source = 'hex'; values.get(source).value = value; update(); };
  }
  function textView() {
    container.classList.add('text-view');
    const source = editor('文本', false, 'plaintext', false), actions = element('div', 'app-panel app-actions text-actions'), replace = element('dialog'), search = editor('查找内容', false, 'plaintext', false), replacement = editor('替换为（留空为删除）', false, 'plaintext', false), regular = checkbox('正则表达式');
    source.panel.classList.add('app-panel', 'text-input'); source.control.setAttribute('rows', '16');
    search.control.setAttribute('data-label', '查找'); replacement.control.setAttribute('data-label', '替换（留空为删除）'); replace.classList.add('text-replace');
    const escaping = element('dialog'), escapeOptions = element('div', 'toolbar'), escapeActions = element('div', 'app-actions'), escapeChoices = new Map();
    const statisticsDialog = element('dialog'), statisticsTable = element('table'), explanations = element('table'); explanations.hidden = true;
    const stats = button('字数 0 · UTF-8 0 · GBK 估算 0', () => statisticsDialog.showModal()); stats.title = '更多统计';
    statisticsDialog.append(tabs([['statistics', '统计'], ['explanations', '统计说明']], 'statistics', value => { statisticsTable.hidden = value !== 'statistics'; explanations.hidden = value !== 'explanations'; }), statisticsTable, explanations, button('关闭', () => statisticsDialog.close()));
    for (const [title, description] of [['字符数', '按 UTF-16 单元计数，不含换行；普通中英文字符各计 1，部分表情计 2。'], ['字数', '中文字符、英文单词、中英文标点和数字单词数量之和。'], ['UTF-8 字节', '按 UTF-8 编码计算实际字节数。'], ['GBK 估算字节', '按字符编码值估算单字节或双字节，不等同于实际 GBK 编码。'], ['数字字符 / 单词', '分别统计每个数字字符及独立的数字单词。'], ['行数', '空行计入行数，空文本为 0 行。']]) { const row = element('tr'), name = element('th'), detail = element('td'); name.textContent = title; detail.textContent = description; row.append(name, detail); explanations.append(row); }
    let last = { operation: 'statistics', input: '', options: {} };
    const statistics = async call => {
      const value = await call('text', 'statistics', source.control.value); stats.textContent = '字数 ' + value.wordCount + ' · UTF-8 字节 ' + value.utf8Bytes + ' · GBK 估算字节 ' + value.gbkEstimatedBytes;
      statisticsTable.replaceChildren();
      const entries = [['contentCharacters', '字符（不含换行）'], ['wordCount', '字数'], ['lines', '行数'], ['utf8Bytes', 'UTF-8 字节'], ['gbkEstimatedBytes', 'GBK 估算字节'], ['chineseCharacters', '中文字符'], ['chinesePunctuation', '中文标点'], ['englishLetters', '英文字母'], ['englishWords', '英文单词'], ['englishPunctuation', '英文标点'], ['digits', '数字字符'], ['numbers', '数字单词']];
      for (let index = 0; index < entries.length; index += 2) {
        const row = element('tr');
        for (const [key, title] of entries.slice(index, index + 2)) { const name = element('th'), data = element('td'); name.textContent = title; data.textContent = value[key]; row.append(name, data); }
        statisticsTable.append(row);
      }
    };
    const run = (operation, options = {}, id = 'text') => {
      last = { toolId: id, operation, input: source.control.value, options };
      schedule(async call => { source.control.value = await call(id, operation, source.control.value, options); await statistics(call); }, 0);
    };
    const group = (title, items, choose) => {
      const choices = select([['', title], ...items]); actions.append(choices);
      choices.addEventListener('change', () => { if (!choices.value) return; choose(choices.value); choices.value = ''; });
    };
    group('大小写', [['upper', '全部大写'], ['lower', '全部小写'], ['upperLineStart', '行首大写'], ['lowerLineStart', '行首小写'], ['upperWordStart', '词首大写'], ['lowerWordStart', '词首小写']], value => run(['upper', 'lower'].includes(value) ? value : 'transform', ['upper', 'lower'].includes(value) ? {} : { transformation: value }));
    group('标点', [['punctuationEn', '中文 → 英文'], ['punctuationZh', '英文 → 中文']], value => run('transform', { transformation: value }));
    actions.append(button('替换', () => replace.showModal()));
    actions.append(button('转义', () => escaping.showModal()));
    for (const [key, title] of [['backslash', '反斜杠'], ['singleQuote', '单引号'], ['doubleQuote', '双引号'], ['newLine', '换行'], ['carriageReturn', '回车'], ['tab', 'Tab'], ['verticalTab', '垂直 Tab'], ['backspace', '退格'], ['formFeed', '换页']]) { const choice = checkbox(title, true); escapeChoices.set(key, choice.control); escapeOptions.append(choice.label); }
    escapeActions.append(button('关闭', () => escaping.close()));
    for (const [value, title] of [['escape', '添加转义'], ['unescape', '移除转义']]) escapeActions.append(button(title, () => { run('transform', { transformation: value, escapeCharacters: JSON.stringify([...escapeChoices].filter(([, control]) => control.checked).map(([key]) => key)) }); escaping.close(); }));
    escaping.append(escapeOptions, escapeActions);
    actions.append(button('行去重', () => run('dedupe')));
    group('命名转换', [['camel', '小驼峰'], ['pascal', '大驼峰'], ['snake', '下划线'], ['kebab', '连字符'], ['constant', '常量名']], value => run(value, {}, 'variableConversion'));
    group('行号', [['addLineNumbers', '添加行号'], ['removeLineNumbers', '移除行号']], value => run('transform', { transformation: value }));
    group('排序', [['asc', '行升序'], ['desc', '行降序'], ['reverseLines', '反转行序'], ['reverseEachLine', '逐行字符反转'], ['reverse', '全部反转']], value => run(['asc', 'desc'].includes(value) ? 'sort' : value === 'reverse' ? 'reverse' : 'transform', { descending: value === 'desc', ...(!['asc', 'desc', 'reverse'].includes(value) ? { transformation: value } : {}) }));
    group('过滤', [['trim', '去首尾空白'], ['removeEmpty', '移除空行'], ['removeBreaks', '移除所有换行']], value => run(value === 'removeBreaks' ? 'transform' : value, value === 'removeBreaks' ? { transformation: value } : {}));
    const pair = element('div', 'json-editors'), replaceActions = element('div', 'app-actions'), hint = element('p', 'section-desc'); hint.textContent = '可输入多行，按行进行批量替换。';
    pair.append(search.panel, replacement.panel); search.panel.append(regular.label);
    replaceActions.append(button('取消', () => replace.close()), button('替换', () => { run('transform', { transformation: 'replace', search: search.control.value, replacement: replacement.control.value, regular: regular.control.checked }); replace.close(); })); replace.append(pair, hint, replaceActions);
    const statisticsRow = element('div', 'app-actions text-statistics'); statisticsRow.append(stats); source.panel.append(statisticsRow);
    container.append(source.panel, actions, replace, escaping, statisticsDialog);
    refresh = () => schedule(statistics);
    attachRefresh(source.control, () => { last = { operation: 'statistics', input: source.control.value, options: {} }; refresh(); });
    snapshot = () => last; refresh();
    fillInput = value => { source.control.value = value; last = { operation: 'statistics', input: value, options: {} }; refresh(); };
  }
  return {
    supports: id => viewIds.has(id),
    inputOperations: id => inputOperations[id],
    loadInput(value, operation) {
      if (!fillInput) throw new Error('当前工具不支持启动输入。');
      fillInput(value, operation);
    },
    activate(tool, tools) {
      cleanup(); cleanup = () => {};
      revision++; clearTimeout(timer); current = tool && viewIds.has(tool.id) ? tool : null; catalog = tools;
      container.replaceChildren(); container.className = 'specialized-view'; container.hidden = !current; refresh = () => {}; snapshot = () => null; fillInput = null;
      if (current) ({ ascii: () => linked('ascii'), zhNumber: () => linked('zhNumber'), radix, unit, time, json, color, jwt, urlParse, ipcalc, text: textView, randomString })[current.id]();
    },
    refresh: () => refresh(), nodeInput: () => snapshot(), close() { cleanup(); cleanup = () => {}; current = null; revision++; clearTimeout(timer); }
  };
}
