// Live Cron view: expression, combined output, reference/generator.
import { copyText } from './feedback.js';

const examples = [
  ['* * * * *', '每分钟'],
  ['*/5 */5 * * *', '每隔 5 分钟，每隔 5 小时'],
  ['* 10/5 * * *', '每分钟，从 10 点开始每隔 5 小时'],
  ['1 1-10 * * *', '每天 1 点至 10 点，每小时的第 1 分钟'],
  ['0 1,2 * * *', '每天 01:00 和 02:00'],
  ['1 2 3 4,6,10 *', '四月、六月、十月的 3 日 02:01'],
  ['0 * L * *', '每月最后一天，每小时整点'],
  ['0 1 * * 0', '每周日 01:00'],
  ['0 1 * * 7', '每周日 01:00'],
  ['0 1 * * 1', '每周一 01:00'],
  ['0 1 * * 2-5', '每周二至周五 01:00'],
  ['0 1 * * 2,5', '每周二、周五 01:00'],
  ['0 1 * * 1L', '每月最后一个周一 01:00'],
  ['0 1 * * 1L,2L', '每月最后一个周一、周二 01:00'],
  ['*/5 1-10,17,22 L 1-2,3/2 1L,2L', '一月、二月及从三月起每隔两个月，最后一天或最后一个周一、周二，在 1—10 点、17 点、22 点每隔 5 分钟']
];
const parts = [
  { id: 'second', label: '秒', min: 0, max: 59 },
  { id: 'minute', label: '分', min: 0, max: 59 },
  { id: 'hour', label: '时', min: 0, max: 23 },
  { id: 'day', label: '日', min: 1, max: 31 },
  { id: 'month', label: '月', min: 1, max: 12 },
  { id: 'week', label: '周', min: 0, max: 7 }
];

function tabs(container, items, choose) {
  container.setAttribute('role', 'tablist');
  for (const [index, item] of items.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
    button.id = container.id + '-' + item.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', item.panel.id);
    item.panel.setAttribute('role', 'tabpanel'); item.panel.setAttribute('aria-labelledby', button.id);
    button.addEventListener('click', () => select(index)); container.append(button);
  }
  function select(index) {
    [...container.children].forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; items[i].panel.hidden = i !== index;
    });
    choose?.(items[index]);
  }
  container.addEventListener('keydown', event => {
    const buttons = [...container.children], current = buttons.indexOf(event.target);
    if (current < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    select(index); buttons[index].focus();
  });
  select(0);
  return select;
}

function table(headings, rows) {
  const element = document.createElement('table'), head = element.createTHead().insertRow(), body = element.createTBody();
  for (const heading of headings) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = heading; head.append(cell); }
  for (const values of rows) { const row = body.insertRow(); for (const value of values) { const cell = row.insertCell(); typeof value === 'string' ? cell.textContent = value : cell.append(value); } }
  return element;
}

export function createCrontabView(container, { request, permitted }) {
  container.className = 'cron-view'; container.hidden = true;
  container.innerHTML = `
    <div class="cron-expression app-actions"><label for="cron-input">表达式</label><input id="cron-input" type="text" spellcheck="false" autocomplete="off" maxlength="65536" aria-describedby="cron-live-status"><button id="cron-generate" type="button" aria-pressed="false" aria-controls="cron-side">生成</button></div>
    <div class="cron-workspace">
      <div class="cron-output"><textarea id="cron-output" readonly spellcheck="false" aria-label="表达式说明和最近10次执行时间" placeholder="最近执行时间"></textarea><button id="cron-copy" type="button" disabled>复制</button></div>
      <section id="cron-side" class="cron-side app-panel" aria-label="Cron 参考与生成">
        <div id="cron-reference"><div id="cron-reference-tabs" aria-label="Cron 参考"></div><section id="cron-examples" class="cron-reference-panel"></section><section id="cron-format" class="cron-reference-panel"><pre aria-label="Cron 字段顺序">┌──────────── 秒（可选，0–59）
│ ┌────────── 分（0–59）
│ │ ┌──────── 时（0–23）
│ │ │ ┌────── 日（1–31）
│ │ │ │ ┌──── 月（1–12）
│ │ │ │ │ ┌── 周（0–7，0 和 7 表示周日）
│ │ │ │ │ │
* * * * * *</pre><p>五段表达式从“分”开始；六段表达式的第一段是“秒”。时间按当前浏览器的时区计算。</p></section><section id="cron-symbols" class="cron-reference-panel"></section></div>
        <div id="cron-builder" hidden><div id="cron-builder-tabs" aria-label="生成字段"></div><div id="cron-builder-fields"></div><p id="cron-builder-status" class="status-error" role="status"></p></div>
      </section>
    </div><p id="cron-live-status" class="sr-only" role="status" aria-live="polite"></p>`;
  const $ = id => container.querySelector('#' + id);
  let active = false, closed = false, enabled = false, version = 0, timer = null, running = false, pending = false, uris = null;
  let generator = false;
  const fields = new Map();
  const input = $('cron-input'), output = $('cron-output');

  function changed(delay = 180) {
    version++; clearTimeout(timer); pending = false; output.value = ''; $('cron-copy').disabled = true;
    $('cron-live-status').textContent = '';
    if (!active || closed || !input.value.trim()) return;
    if (!permitted()) { output.value = '请在应用权限中开启 SDK 和工具权限。'; return; }
    timer = setTimeout(() => { pending = true; void calculate(); }, delay);
  }
  async function calculate() {
    if (running || !pending || !active || closed || !permitted()) return;
    pending = false; running = true;
    const current = version, expression = input.value.trim(), lines = [];
    const isCurrent = () => current === version && active && !closed && permitted();
    try {
      if (![5, 6].includes(expression.split(/\s+/).length)) throw new Error('请输入五段或六段 Cron 表达式');
      $('cron-live-status').textContent = '正在计算执行时间';
      const description = await request('POST', uris.describe, { input: expression });
      if (!isCurrent()) return;
      if (/L/i.test(expression)) lines.push('使用 L 前，请确认目标运行环境支持。', '');
      if (expression.split(/\s+/).length === 6) lines.push('此表达式包含秒，请确认目标运行环境支持。', '');
      lines.push(description.value, '', '最近10次执行时间');
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const response = await request('POST', uris.next, { input: expression, options: { count: 10, zone, start: new Date().toISOString() } });
      if (!isCurrent()) return;
      const format = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      response.value.forEach((item, index) => lines.push('第' + (index + 1) + '次: ' + format.format(new Date(item.iso))));
      if (!response.value.length) lines.push('没有后续执行时间');
      output.value = lines.join('\n'); $('cron-copy').disabled = false; $('cron-live-status').textContent = '已更新执行时间';
    } catch (error) {
      if (isCurrent()) { output.value = [...lines, error.message].join('\n'); $('cron-copy').disabled = !lines.length; $('cron-live-status').textContent = '表达式计算失败'; }
    } finally {
      running = false;
      if (pending && active && !closed) void calculate();
    }
  }

  $('cron-examples').append(table(['例子', '描述'], examples));
  $('cron-symbols').append(table(['特殊符号', '描述'], [
    ['*', '匹配当前字段内的所有值。例如分字段为 * 时，每分钟执行。'],
    [',', '指定多个值。例如 0 3,6 * * * 表示每天 03:00 和 06:00。'],
    ['-', '指定包含两端的范围。例如 20 8-12 * * * 表示 08:20 至 12:20，每小时执行。'],
    ['/n', '按间隔取值。例如 */5 * * * * 表示每隔 5 分钟。']
  ]));
  const selectReference = tabs($('cron-reference-tabs'), [
    { id: 'examples', label: '例子', panel: $('cron-examples') },
    { id: 'format', label: '格式', panel: $('cron-format') },
    { id: 'symbols', label: '特殊符号', panel: $('cron-symbols') }
  ]);

  function writeExpression() {
    if (!generator) return;
    const values = [];
    $('cron-builder-status').textContent = '';
    try {
      for (const part of parts) {
        const field = fields.get(part.id), mode = field.panel.querySelector('input[type=radio]:checked').value;
        let value = '*';
        if (mode === 'ignore') continue;
        if (mode === 'scope') {
          const start = field.start.valueAsNumber, end = field.end.valueAsNumber;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < part.min || end > part.max || start > end) throw new Error(part.label + '的范围应在 ' + part.min + '–' + part.max + ' 内，起点不得大于终点');
          value = start + '-' + end;
        }
        if (mode === 'interval') {
          const start = field.intervalStart.value.trim(), step = field.step.valueAsNumber;
          if (!Number.isInteger(step) || step < 1 || step > part.max) throw new Error(part.label + '的间隔必须在 1–' + part.max + ' 之间');
          if (!['', '*', '0'].includes(start) && (!/^\d+$/.test(start) || Number(start) < part.min || Number(start) > part.max)) throw new Error(part.label + '的间隔起点必须是 * 或范围内的整数');
          value = (start === '' || start === '0' ? '*' : start) + '/' + step;
        }
        if (mode === 'list') value = [...field.list.querySelectorAll('input:checked')].map(box => box.value).join(',') || '*';
        values.push(value);
      }
      input.value = values.join(' '); changed();
    } catch (error) { $('cron-builder-status').textContent = error.message; }
  }
  function number(part, label, initial, min = part.min, max = part.max) {
    const control = document.createElement('input'); control.type = 'number'; control.min = min; control.max = max; control.step = '1'; control.value = initial; control.setAttribute('aria-label', part.label + label); return control;
  }
  for (const part of parts) {
    const panel = document.createElement('section'); panel.id = 'cron-field-' + part.id; panel.className = 'cron-field';
    const modes = new Map();
    function option(id, title) {
      const row = document.createElement('div'); row.className = 'cron-mode';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'cron-mode-' + part.id; radio.value = id; radio.id = 'cron-' + part.id + '-' + id;
      radio.checked = id === (part.id === 'second' ? 'ignore' : 'any');
      const label = document.createElement('label'); label.htmlFor = radio.id; label.textContent = title;
      const value = document.createElement('div'); value.className = 'cron-mode-value'; row.append(radio, label, value); panel.append(row); modes.set(id, radio);
      row.addEventListener('click', event => { if (event.target !== radio && !radio.checked) { radio.checked = true; writeExpression(); } });
      row.addEventListener('input', () => { radio.checked = true; writeExpression(); });
      radio.addEventListener('change', writeExpression); return value;
    }
    if (part.id === 'second') option('ignore', '忽略');
    option('any', '任意').textContent = '*';
    const scope = option('scope', '范围'), start = number(part, '范围起点', 2), end = number(part, '范围终点', 5); scope.append(start, ' – ', end);
    const interval = option('interval', '间隔'), intervalStart = document.createElement('input'), step = number(part, '间隔', 5, 1);
    intervalStart.type = 'text'; intervalStart.value = '*'; intervalStart.setAttribute('aria-label', part.label + '间隔起点'); interval.append(intervalStart, ' / ', step);
    const list = option('list', '指定'); list.classList.add('cron-values');
    const values = Array.from({ length: part.max - part.min + 1 }, (_, index) => String(index + part.min));
    if (part.id === 'day') values.push('L');
    if (part.id === 'week') values.push('1L', '2L', '3L', '4L', '5L', '6L', '7L');
    for (const value of values) {
      const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.value = value; label.append(box, value); list.append(label);
    }
    fields.set(part.id, { panel, modes, start, end, intervalStart, step, list }); $('cron-builder-fields').append(panel);
  }
  const selectPart = tabs($('cron-builder-tabs'), parts.map(part => ({ ...part, panel: fields.get(part.id).panel })));
  selectPart(1);

  function startGenerator() {
    // Generator defaults: optional seconds omitted, all other fields '*'.
    for (const part of parts) {
      const field = fields.get(part.id); field.modes.get(part.id === 'second' ? 'ignore' : 'any').checked = true;
      field.start.value = '2'; field.end.value = '5'; field.intervalStart.value = '*'; field.step.value = '5';
      for (const box of field.list.querySelectorAll('input')) box.checked = false;
    }
    selectPart(1); writeExpression();
  }
  $('cron-generate').addEventListener('click', () => {
    generator = !generator; $('cron-generate').setAttribute('aria-pressed', String(generator));
    $('cron-reference').hidden = generator; $('cron-builder').hidden = !generator;
    if (generator) startGenerator(); else selectReference(0);
  });
  input.addEventListener('input', () => changed());
  $('cron-copy').addEventListener('click', () => copyText(output.value, '已复制结果'));
  return {
    activate(tool) {
      active = !!tool; container.hidden = !active; version++; clearTimeout(timer); pending = false;
      if (!active) return;
      uris = tool.operationUris; enabled = permitted(); input.value = '2,3 */5 * * 2-5';
      generator = false; $('cron-generate').setAttribute('aria-pressed', 'false'); $('cron-reference').hidden = false; $('cron-builder').hidden = true;
      selectReference(0); $('cron-builder-status').textContent = '';
      changed(0);
    },
    refresh() { const next = permitted(); if (next !== enabled) { enabled = next; changed(0); } },
    loadInput(value) { input.value = value; changed(); },
    close() { closed = true; version++; clearTimeout(timer); pending = false; },
    nodeInput() { return { operation: 'next', input: input.value.trim(), options: { count: 10, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } }; }
  };
}
