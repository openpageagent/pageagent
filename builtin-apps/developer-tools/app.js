import { createCrontabView } from './crontab.js';
import { createToolViews } from './views.js';
import { copyText, notify } from './feedback.js';
import { receiveToolInput } from './tool-input.js';

// Page features and API operations are different: a page can combine several operations.
const defaultCommon = ['hash', 'json', 'base64', 'url', 'time', 'qrCode', 'pinyin', 'code', 'unicode', 'text', 'randomString', 'diffs', 'dockerCompose'];
const categories = [
  { id: 'common', label: '常用' },
  { id: 'encryption', label: '加解密/签名', tools: ['hash', 'hmac', 'aes', 'des', 'tripleDes', 'rc4', 'rabbit', 'sm2', 'sm4', 'rsa', 'sign', 'base64', 'bcrypt'] },
  { id: 'check', label: '校验', tools: ['sign', 'regex', 'diffs', 'crontab', 'bcrypt', 'dataValidation'] },
  { id: 'encoding', label: '编解码', tools: ['base64', 'base64Image', 'url', 'unicode', 'jwt', 'hexString', 'html', 'gzip', 'asn1', 'punycode', 'backslash'] },
  { id: 'conversion', label: '转换', tools: ['json', 'pinyin', 'radix', 'serialize', 'unit', 'time', 'ascii', 'variableConversion', 'hexString', 'httpSnippet', 'color', 'urlParse', 'dockerCompose', 'zhNumber', 'svgToCss'] },
  { id: 'generate', label: '生成', tools: ['qrCode', 'barcode', 'randomString', 'uuid', 'ulid', 'loremIpsum', 'binary', 'ipcalc', 'sqlFillParameter', 'httpSnippet'] },
  { id: 'other', label: '其他', tools: ['code', 'unit', 'text'] }
];
const labels = { digest: '计算摘要', encrypt: '加密', decrypt: '解密', keypair: '生成密钥对', sign: '签名', verify: '验证', hash: '生成哈希', checksum: '计算校验码', encode: '编码', decode: '解码', format: '格式化', minify: '压缩', sort: '排序', escape: '转义', unescape: '反转义', repair: '修复', jsonpath: 'JSONPath 查询', jmespath: 'JMESPath 查询', schema: 'Schema 验证', toCode: '生成类型代码', convert: '转换', lines: '按行比较', words: '按词比较', characters: '按字符比较', match: '匹配', replace: '替换', split: '拆分', statistics: '统计', dedupe: '去重', reverse: '反转', trim: '去首尾空格', upper: '大写', lower: '小写', removeEmpty: '移除空行', table: '码表', timestamp: '时间戳', timezone: '时区', add: '时间增减', difference: '时间差', now: '当前时间', describe: '解释表达式', next: '后续执行时间', validate: '验证', generate: '生成', parse: '解析', fill: '填充参数', money: '金额大写', camel: '小驼峰', pascal: '大驼峰', snake: '下划线', kebab: '连字符', constant: '常量名', ipv4: 'IPv4', ipv6: 'IPv6' };
const resultLabels = { publicKey: '公钥', privateKey: '私钥', header: 'Header', payload: 'Payload', signature: '签名片段', signatureVerified: '已验证签名', signMagnitude: '原码', onesComplement: '反码', twosComplement: '补码', input: '十进制输入', valid: '验证通过', iso: 'ISO 8601', timestamp: '时间戳', zone: '时区', formatted: '当地时间', milliseconds: '毫秒', seconds: '秒', minutes: '分钟', hours: '小时', days: '天', characters: 'Unicode 字符', utf16Units: 'UTF-16 单元', utf8Bytes: 'UTF-8 字节', lines: '行数', words: '词数', parameters: '查询参数', pathname: '路径', hostname: '主机名', port: '端口', protocol: '协议', search: '查询字符串', hash: '片段', origin: '源', href: '完整地址', username: '用户名', password: '密码' };
const textValue = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
// Navigation switches feature views. Buttons and live transformations stay in the page.
const featureOperations = {
  aes: ['encrypt', 'decrypt'], des: ['encrypt', 'decrypt'], tripleDes: ['encrypt', 'decrypt'], rc4: ['encrypt', 'decrypt'], rabbit: ['encrypt', 'decrypt'],
  sm2: ['encrypt', 'decrypt', 'sign', 'verify'], sm4: ['encrypt', 'decrypt'], rsa: ['encrypt', 'decrypt'],
  base64: ['encode', 'decode'], base64Image: ['encode', 'decode'], url: ['encode', 'decode'], unicode: ['encode', 'decode'],
  hexString: ['encode', 'decode'], gzip: ['encode', 'decode'], punycode: ['encode', 'decode'], qrCode: ['generate', 'parse'], ipcalc: ['ipv4', 'ipv6']
};
const liveTools = new Set(['hash', 'hmac', 'aes', 'des', 'tripleDes', 'rc4', 'rabbit', 'sm2', 'sm4', 'rsa', 'base64', 'base64Image', 'url', 'unicode', 'hexString', 'html', 'gzip', 'punycode', 'pinyin', 'serialize', 'regex', 'diffs', 'binary', 'jwt', 'asn1', 'dataValidation', 'qrCode', 'barcode', 'urlParse', 'httpSnippet', 'dockerCompose', 'sqlFillParameter', 'variableConversion']);
const actionTools = new Set(['json', 'code', 'text', 'sign', 'bcrypt']);
const cryptoTools = new Set(['aes', 'des', 'tripleDes', 'rc4', 'rabbit']);
const defaultDigests = id => id === 'hash' ? ['MD5', 'SHA1', 'SHA256', 'SHA512', 'SM3'] : ['MD5', 'SHA1', 'SHA256', 'SHA512', 'SM3', 'RIPEMD160'];

function visibleFields(tool, operation, value) {
  let keys = Object.keys(tool.fields);
  const only = list => keys.filter(key => list.includes(key));
  switch (tool.id) {
    case 'hash': return value('salted') && value('inputEncoding') === 'utf8' ? keys : keys.filter(key => !['salt', 'expression'].includes(key));
    case 'httpSnippet': return value('from') === 'har' ? keys : keys.filter(key => key !== 'entry');
    case 'base64': return only(operation === 'encode' ? ['inputEncoding', 'urlSafe'] : ['outputEncoding']);
    case 'hexString': return only(operation === 'encode' ? ['inputEncoding', 'uppercase', 'separator'] : ['separator', 'outputEncoding']);
    case 'json': return only(operation === 'toCode' ? ['language', 'name'] : operation === 'schema' ? ['schema'] : ['jsonpath', 'jmespath'].includes(operation) ? ['expression'] : []);
    case 'time': return only({ timestamp: ['unit'], now: ['unit'], timezone: ['zone'], add: ['amount', 'interval'], difference: ['other'] }[operation] || []);
    case 'uuid': return only(operation === 'validate' ? [] : ['v3', 'v5'].includes(operation) ? ['count', 'namespace', 'outputFormat'] : ['count', 'outputFormat']);
    case 'ulid': return only(operation === 'decode' ? [] : ['count', 'uppercase', 'outputFormat']);
    case 'regex': return only(['expression', 'flags', 'replacement']);
    case 'text': return only(operation === 'sort' ? ['descending'] : []);
    case 'qrCode': return operation === 'parse' ? only(['inputEncoding']) : keys.filter(key => !['cellSize', 'imageFormat'].includes(key));
    case 'crontab': return only(operation === 'describe' ? [] : ['count', 'zone', 'start']);
    case 'bcrypt': return only(['hash', 'rounds', 'version']);
    case 'rsa': return only(operation === 'keypair' ? ['bits', 'hash'] : ['key', 'hash', 'inputEncoding', 'outputEncoding']);
    case 'sm2': return only(operation === 'keypair' ? [] : ['encrypt', 'decrypt'].includes(operation) ? ['key', 'cipherMode', 'inputEncoding', 'outputEncoding'] : operation === 'verify' ? ['key', 'signature', 'signatureEncoding', 'userId', 'inputEncoding'] : ['key', 'userId', 'inputEncoding', 'outputEncoding']);
    case 'sign':
      keys = only(operation === 'keypair' ? ['algorithm', 'curve'] : operation === 'verify' ? ['algorithm', 'key', 'signature', 'curve'] : ['algorithm', 'key', 'curve']);
      return value('algorithm').includes('ECDSA') ? keys : keys.filter(key => key !== 'curve');
    case 'aes': case 'des': case 'tripleDes': return value('type') === 'simple' ? only(['type', 'key', 'inputEncoding', 'outputEncoding']) : keys.filter(key => key !== 'keyEncoding');
    case 'sqlFillParameter': return only(['parameters']);
    case 'rc4': case 'rabbit': return only(['key', 'inputEncoding', 'outputEncoding']);
    case 'unicode': return operation === 'decode' ? only(['style']) : keys;
    default: return keys;
  }
}

function inputKind(tool, operation) {
  if (operation === 'keypair' || tool === 'ascii' && operation === 'table' || tool === 'time' && operation === 'now'
    || ['randomString', 'loremIpsum'].includes(tool) || tool === 'ulid' && operation === 'generate'
    || tool === 'uuid' && ['v1', 'v4', 'v6', 'v7'].includes(operation)) return 'none';
  if (['time', 'crontab', 'radix', 'unit', 'color', 'barcode', 'ipcalc', 'zhNumber', 'uuid', 'ulid'].includes(tool)) return 'line';
  return 'editor';
}

// An upload is a capability of this input, not a universal editor action.
function fileKind(tool, operation) {
  if (tool === 'base64Image' && operation === 'encode') return 'image';
  if (tool === 'qrCode' && operation === 'parse') return 'qr-image';
  if (tool === 'qrCode' && operation === 'generate') return 'text';
  if (tool === 'gzip' && operation === 'decode') return 'gzip';
  if (['hash', 'hmac', 'dataValidation'].includes(tool)) return 'bytes';
  if (['base64', 'gzip', 'hexString'].includes(tool) && operation === 'encode') return 'bytes';
  if (['aes', 'des', 'tripleDes', 'rc4', 'rabbit', 'sm2', 'sm4'].includes(tool) && operation === 'encrypt') return 'bytes';
  if (tool === 'sm2' && ['sign', 'verify'].includes(operation)) return 'bytes';
  return '';
}

function isPanel(tool, key) {
  return key === 'schema' || key === 'parameters' || tool === 'diffs' && key === 'other'
    || ['rsa', 'sign'].includes(tool) && key === 'key' || key === 'signature' || tool === 'bcrypt' && key === 'hash';
}

export async function mountDeveloperTools() {
  const $ = id => document.getElementById(id);
  let tools = [], selected = null, category = 'common', operation = '', fields = new Map();
  let keyDrafts = { public: '', private: '' };
  let result = null, hasResult = false, previewUrl = null, busy = false, revision = 0, loading = false, closed = false;
  let autoTimer = null, autoPending = false;
  let icons;
  let launchHandled = false;
  let uuidRaw = '';
  let qrSection = 'common';
  let qrHex = null;
  const qrDrafts = new Map();
  let pinyinMode = 'normal';
  let common = [...defaultCommon], commonDraft = [], commonVersion = null, commonLoaded = false, savingCommon = false;
  let commonLoadError = '', draggedCommon = null;
  const toolbox = document.querySelector('.toolbox'), cronContainer = document.createElement('section');
  const toolbar = $('run').parentElement;
  $('description').after(cronContainer);
  const diffContainer = document.createElement('section'); diffContainer.className = 'diff-view'; diffContainer.hidden = true; cronContainer.after(diffContainer);
  const cron = createCrontabView(cronContainer, { request, permitted: () => !closed && selected?.id === 'crontab' && permitted() });
  const viewContainer = document.createElement('section'); cronContainer.after(viewContainer);
  const views = createToolViews(viewContainer, { request, permitted: () => !closed && permitted(), message, createIcon: name => icons.create(name) });
  const actionChoices = document.createElement('span'); actionChoices.id = 'tool-actions'; actionChoices.className = 'tool-actions'; $('run').before(actionChoices);
  const inputOptions = document.createElement('div'), outputOptions = document.createElement('div');
  inputOptions.className = outputOptions.className = 'editor-options';
  $('input-panel').append(inputOptions); $('output-panel').append(outputOptions);
  // Reserve the actual wrapped footer height inside Monaco, keeping both editor borders aligned.
  const optionResize = new ResizeObserver(entries => {
    for (const entry of entries) toolbox.style.setProperty(entry.target === inputOptions ? '--input-options-height' : '--output-options-height', entry.target.offsetHeight + 'px');
  });
  optionResize.observe(inputOptions); optionResize.observe(outputOptions);
  const categoryTools = new Map(), toolOperations = new Map();
  const operationLabel = value => selected?.id === 'httpSnippet' ? ({ curl: 'cURL', fetch: 'JavaScript / fetch', python: 'Python / requests', go: 'Go', java: 'Java' }[value] || value) : selected?.id === 'variableConversion' && value === 'words' ? '空格分词' : labels[value] || value;
  const categoryItems = id => (id === 'common' ? common : categories.find(item => item.id === id).tools).map(id => tools.find(tool => tool.id === id)).filter(Boolean);
  const fieldValue = key => { const field = fields.get(key); return field?.spec.type === 'boolean' ? field.control.checked : field?.control.value; };
  const primary = () => selected?.id === 'html' && operation === 'decode' ? $('output') : $('input-panel').dataset.kind === 'line' ? $('input-line') : $('input');
  const keyKind = value => ['encrypt', 'verify'].includes(value) ? 'public' : 'private';
  const allDigests = () => ['hash', 'hmac'].includes(selected?.id) && fieldValue('algorithm') === 'all';
  const inPlace = () => ['code', 'text'].includes(selected?.id) || selected?.id === 'json' && ['format', 'minify', 'sort', 'escape', 'unescape', 'repair'].includes(operation);
  const autoGenerate = () => selected?.id === 'uuid' || selected?.id === 'ulid' && operation === 'generate';
  function message(text, error = false) { $('status').textContent = text; $('status').className = error ? 'status-error' : 'status-pending'; }
  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null; $('preview').replaceChildren(); $('download-file')?.remove();
  }
  function renderResultFields(entries, columns = 'one') {
    const container = $('result-fields'), existing = [...container.children];
    container.dataset.columns = columns;
    if (existing.length === entries.length && entries.every(([key], index) => existing[index].dataset.key === key)) {
      entries.forEach(([, item], index) => { existing[index].querySelector('page-code-editor').value = textValue(item); });
      $('output').hidden = true; return;
    }
    container.replaceChildren();
    for (const [key, item] of entries) {
      const section = document.createElement('section'), title = (selected.id === 'hmac' ? 'HMAC-' : '') + (resultLabels[key] || key);
      section.dataset.key = key;
      const output = document.createElement('page-code-editor'); output.setAttribute('readonly', ''); output.setAttribute('aria-label', title); output.setAttribute('data-label', title);
      output.setAttribute('rows', '4');
      output.setAttribute('language', item && typeof item === 'object' ? 'json' : 'plaintext'); output.value = textValue(item);
      section.append(output); $('result-fields').append(section);
    }
    $('output').hidden = true;
  }
  function emptyResultFields() {
    if (allDigests()) renderResultFields(defaultDigests(selected.id).map(id => [id, '']));
    else if (selected?.id === 'variableConversion') renderResultFields(selected.operations.map(id => [operationLabel(id), '']));
    else if (selected?.id === 'binary') renderResultFields(['signMagnitude', 'onesComplement', 'twosComplement'].map(id => [id, '']));
    else if (selected?.id === 'dataValidation') renderResultFields(['Hex', 'Dec', 'Oct', 'Bin'].map(id => [id, '']));
    else $('result-fields').replaceChildren();
  }
  function invalidateResult() {
    clearTimeout(autoTimer); autoPending = false;
    uuidRaw = ''; qrHex = null;
    revision++; result = null; hasResult = false; clearPreview();
    (selected?.id === 'html' && operation === 'decode' ? $('input') : $('output')).value = '';
    $('output').hidden = inPlace() || ['sign', 'bcrypt', 'barcode'].includes(selected?.id);
    emptyResultFields();
    updateQrResult();
    if (['bcrypt', 'sign'].includes(selected?.id)) { const button = actionChoices.querySelector('[data-operation=verify]'); if (button) button.textContent = '验证'; }
  }
  function scheduleAuto() {
    if (views.supports(selected?.id) || selected?.id === 'diffs') return;
    if (!selected || closed || !permitted() || !autoGenerate() && (!liveTools.has(selected.id) || primary().value === '' && selected.id !== 'barcode' && !(selected.id === 'diffs' && fieldValue('other') !== ''))) return;
    if ((cryptoTools.has(selected.id) || ['hmac', 'sm2', 'sm4', 'rsa'].includes(selected.id)) && !fieldValue('key')) return;
    if (selected.id === 'sm2' && operation === 'verify' && !fieldValue('signature')) return;
    if (selected.id === 'regex' && !fieldValue('expression')) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { autoPending = true; if (!busy) void execute(); }, 180);
  }
  function inputChanged() {
    if (selected?.id === 'regex') {
      const deleting = $('regex-delete').checked;
      operation = deleting || fieldValue('replacement') !== '' ? 'replace' : 'match';
      fields.get('replacement').control.disabled = deleting;
    }
    invalidateResult();
    message(''); scheduleAuto();
  }
  async function request(method, uri, body) {
    const input = { uri };
    if (body !== undefined) { input.body = body; input.idempotencyKey = crypto.randomUUID(); }
    const response = await PageAgent.resources.request(method, input);
    if (response.error) throw new Error(response.error.message || response.error.code);
    if (!response.primary) throw new Error('未收到工具结果');
    return response.primary.data;
  }
  function permitted() {
    const permissions = PageAgent.state?.permissions;
    return permissions?.enabled && ['utilities.read', 'utilities.execute'].every(name => permissions.resources.includes(name));
  }
  function controls() {
    $('permissions').href = PageAgent.state?.links?.permissions || '/options/options.html?section=apps';
    $('grant').hidden = !!permitted();
    $('run').disabled = busy || !selected || !permitted() || closed;
    for (const button of actionChoices.querySelectorAll('button')) button.disabled = busy || !permitted() || closed;
    for (const id of ['input-file', 'qr-image-file', 'qr-image-upload']) if ($(id)) $(id).disabled = closed;
    $('copy-node').disabled = !selected || closed || allDigests() || selected.id === 'variableConversion';
    $('copy-node').title = allDigests() ? '选择单个算法后可复制对应节点配置' : selected?.id === 'variableConversion' ? '此页同时展示多种转换；流程节点每次选择一种转换' : '';
    $('common-settings').disabled = !tools.length || closed;
    cron.refresh();
  }
  function renderTabs(id, items, current, panelId, choose) {
    const container = $(id), focused = container.contains(document.activeElement) ? document.activeElement.id : '';
    container.replaceChildren(); $(panelId).removeAttribute('aria-labelledby');
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button'; button.id = id + '-' + item.id; button.textContent = item.label;
      if (id === 'tools') { const mark = document.createElement('input'); mark.type = 'checkbox'; mark.checked = item.id === current; mark.tabIndex = -1; mark.setAttribute('aria-hidden', 'true'); button.prepend(mark); }
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panelId);
      button.setAttribute('aria-selected', String(item.id === current)); button.tabIndex = item.id === current ? 0 : -1;
      if (item.id === current) $(panelId).setAttribute('aria-labelledby', button.id);
      button.addEventListener('click', () => choose(item.id)); container.append(button);
    }
    if (focused) $(focused)?.focus();
  }
  function openSignKeypair() {
    const dialog = document.createElement('dialog'), form = document.createElement('form'), heading = document.createElement('h3');
    heading.textContent = '生成密钥对'; form.method = 'dialog';
    const choices = {};
    for (const [key, title, values] of [['algorithm', '算法', selected.fields.algorithm.enum], ['bits', 'RSA 密钥位数', [2048, 4096]], ['curve', 'EC 曲线', selected.fields.curve.enum]]) {
      const label = document.createElement('label'), control = document.createElement('select'); label.className = 'option-field';
      control.append(...values.map(value => new Option(value, value))); control.value = fieldValue(key) || values[0]; label.append(title, control); choices[key] = control; form.append(label);
    }
    const update = () => { const ec = choices.algorithm.value.includes('ECDSA'); choices.bits.parentElement.hidden = ec; choices.curve.parentElement.hidden = !ec; };
    choices.algorithm.addEventListener('change', update); update();
    const actions = document.createElement('div'), cancel = document.createElement('button'), generate = document.createElement('button'); actions.className = 'app-actions';
    cancel.type = 'button'; cancel.textContent = '取消'; cancel.addEventListener('click', () => dialog.close()); generate.type = 'submit'; generate.textContent = '生成';
    actions.append(cancel, generate); form.append(actions); dialog.append(heading, form); toolbox.append(dialog);
    form.addEventListener('submit', event => {
      event.preventDefault(); fields.get('algorithm').control.value = choices.algorithm.value; fields.get('curve').control.value = choices.curve.value; fields.get('bits').control.value = choices.bits.value;
      const options = { algorithm: choices.algorithm.value, curve: choices.curve.value, bits: choices.bits.value };
      updateForm(); dialog.close(); void execute({ operation: 'keypair', input: '', options });
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  }
  function renderOperations() {
    actionChoices.replaceChildren(); toolbar.hidden = true;
    if (views.supports(selected.id)) {
      $('operations').hidden = true; $('operations').replaceChildren(); $('run').hidden = true; return;
    }
    $('run').hidden = liveTools.has(selected.id) || actionTools.has(selected.id) || selected.id === 'crontab';
    if (actionTools.has(selected.id)) {
      const operations = selected.id === 'sign' ? ['sign', 'verify', 'keypair'] : selected.id === 'code' && !['javascript', 'json', 'css'].includes(fieldValue('language')) ? ['format'] : selected.operations;
      for (const id of operations) {
        if (id === 'format' && (selected.id === 'json' || selected.id === 'code' && ['javascript', 'json', 'html', 'css'].includes(fieldValue('language')))) continue;
        const button = document.createElement('button'); button.type = 'button'; button.textContent = operationLabel(id); button.dataset.operation = id;
        button.addEventListener('click', () => {
          if (id === 'keypair') { openSignKeypair(); return; }
          selectOperation(id);
          if (!['jsonpath', 'jmespath', 'schema', 'toCode'].includes(id) || primary().value.trim()) void execute();
        }); actionChoices.append(button);
      }
      if (selected.id === 'bcrypt') actionChoices.prepend(fields.get('rounds').wrapper, fields.get('version').wrapper);
      if (selected.id === 'sign') {
        const left = document.createElement('span'), right = document.createElement('span'); left.className = right.className = 'app-actions';
        left.append(fields.get('algorithm').wrapper, fields.get('curve').wrapper, actionChoices.querySelector('[data-operation=sign]'));
        right.append(actionChoices.querySelector('[data-operation=verify]'), actionChoices.querySelector('[data-operation=keypair]'));
        actionChoices.append(left, right);
      }
    }
    if (selected.id === 'sm2') {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '生成密钥对';
      button.addEventListener('click', () => { void execute({ operation: 'keypair', input: '', options: {} }); });
      actionChoices.append(button);
    }
    if (selected.id === 'crontab') {
      $('operations').hidden = true; $('operations').replaceChildren();
      $('tool-content').removeAttribute('role'); $('tool-content').setAttribute('aria-labelledby', 'title'); return;
    }
    if (selected.id === 'dataValidation') {
      const algorithm = fieldValue('algorithm'), current = algorithm.startsWith('CRC') ? 'CRC' : algorithm;
      $('operations').hidden = false; $('tool-content').setAttribute('role', 'tabpanel');
      renderTabs('operations', ['BCC', 'CRC', 'LRC'].map(id => ({ id, label: id })), current, 'tool-content', id => {
        if (id === current) return;
        fields.get('algorithm').control.value = id === 'CRC' ? 'CRC32' : id;
        invalidateResult(); updateForm(); message(''); scheduleAuto();
      });
      $('run').textContent = '计算校验码'; return;
    }
    const operations = featureOperations[selected.id] || [];
    $('operations').hidden = operations.length < 2;
    if (operations.length > 1) {
      $('tool-content').setAttribute('role', 'tabpanel');
      renderTabs('operations', operations.map(id => ({ id, label: operationLabel(id) })), operation, 'tool-content', selectOperation);
    } else {
      $('operations').replaceChildren(); $('tool-content').removeAttribute('role'); $('tool-content').setAttribute('aria-labelledby', 'title');
    }
    $('run').textContent = autoGenerate() ? '重新生成' : operationLabel(operation);
    // Additional API capabilities remain available as local controls, without inventing feature tabs.
    if (!operations.length && !actionTools.has(selected.id) && selected.operations.length > 1 && !['regex', 'diffs', 'variableConversion', 'html', 'uuid'].includes(selected.id)) {
      const select = document.createElement('select'); select.setAttribute('aria-label', '操作');
      select.append(...selected.operations.filter(id => id !== 'requests' && (id !== 'format' || selected.id !== 'ulid')).map(id => new Option(operationLabel(id), id))); select.value = operation;
      select.addEventListener('change', () => selectOperation(select.value)); actionChoices.append(select);
    }
    toolbar.hidden = $('run').hidden && !actionChoices.childElementCount;
    controls();
  }
  function renderNavigation() {
    renderTabs('categories', categories, category, 'category-panel', selectCategory);
    renderTabs('tools', categoryItems(category), selected?.id, 'tool-panel', id => selectTool(tools.find(tool => tool.id === id)));
    $('empty-common').hidden = category !== 'common' || categoryItems(category).length > 0;
    $('tool-panel').hidden = !selected;
    if (selected) renderOperations();
  }
  function selectCategory(id) {
    if (category === id) return;
    category = id;
    const items = categoryItems(id);
    const tool = items.find(item => item.id === categoryTools.get(id)) || items[0];
    if (tool) selectTool(tool);
    else { selected = null; cron.activate(null); views.close(); invalidateResult(); renderNavigation(); controls(); }
  }
  function renderSearch() {
    const query = $('search').value.trim().toLowerCase();
    $('search-results').hidden = !query; $('search-tools').replaceChildren();
    if (!query) return;
    const matches = tools.filter(tool => (tool.label + ' ' + tool.id + ' ' + tool.category).toLowerCase().includes(query));
    $('search-status').textContent = matches.length ? '找到 ' + matches.length + ' 个工具' : '没有匹配的工具';
    for (const tool of matches) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = tool.label;
      button.addEventListener('click', () => {
        $('search').value = ''; renderSearch();
        if (!categoryItems(category).includes(tool)) category = common.includes(tool.id) ? 'common' : categories.find(item => item.tools?.includes(tool.id)).id;
        selectTool(tool); $('tools-' + tool.id)?.focus();
      });
      $('search-tools').append(button);
    }
  }
  function selectOperation(value) {
    if (!selected || value === operation || !selected.operations.includes(value)) return;
    if (selected.id === 'qrCode') qrDrafts.set(operation, { input: primary().value, encoding: fieldValue('inputEncoding'), files: primary().value ? $('input-file')?.files : null });
    if ($('file-panel')) { $('input').value = ''; $('file-panel').remove(); }
    $('file-source-field')?.remove();
    if (['rsa', 'sm2'].includes(selected.id) && operation !== 'keypair') keyDrafts[keyKind(operation)] = fieldValue('key');
    operation = value;
    if (cryptoTools.has(selected.id) || ['gzip', 'sm4', 'sm2', 'rsa'].includes(selected.id)) {
      fields.get('inputEncoding').control.value = value === 'decrypt' || value === 'decode' ? 'base64' : 'utf8';
      fields.get('outputEncoding').control.value = value === 'decrypt' || value === 'decode' ? 'utf8' : 'base64';
      if (selected.id === 'sm4') { fields.get('inputEncoding').control.value = value === 'decrypt' ? 'hex' : 'utf8'; fields.get('outputEncoding').control.value = value === 'decrypt' ? 'utf8' : 'hex'; }
      if (selected.id === 'sm2') { fields.get('inputEncoding').control.value = value === 'decrypt' ? 'hex' : 'utf8'; fields.get('outputEncoding').control.value = value === 'decrypt' ? 'utf8' : 'hex'; }
    }
    toolOperations.set(selected.id, value); invalidateResult(); renderOperations(); updateForm();
    if (selected.id === 'qrCode') {
      const draft = qrDrafts.get(value);
      fields.get('inputEncoding').control.value = draft?.encoding || (value === 'parse' ? 'upload' : 'utf8');
      updateForm(); primary().value = draft?.input || '';
      if ($('input-file') && draft?.files?.length) { $('input-file').files = draft.files; $('file-panel').querySelector('p').textContent = '已读取文件'; }
    }
    if (['rsa', 'sm2'].includes(selected.id)) fields.get('key').control.value = keyDrafts[keyKind(value)];
    message('');
    scheduleAuto();
  }
  function createFields() {
    // Restore the shared controls before disposing a tool's input panels.
    $('editors').before(toolbar, $('options'));
    $('editors').append($('inputs'), $('output-panel'));
    $('output-panel').querySelector('.section-title').after($('output'));
    $('qr-settings')?.parentElement.remove();
    for (const field of fields.values()) (field.panel ? $('field-panels') : $('options')).append(field.wrapper);
    for (const group of document.querySelectorAll('.tool-field-group')) group.remove();
    inputOptions.replaceChildren(); outputOptions.replaceChildren();
    $('qr-output-footer')?.remove();
    $('options').replaceChildren(); $('field-panels').replaceChildren(); fields = new Map();
    diffContainer.replaceChildren(); diffContainer.hidden = selected.id !== 'diffs';
    if (selected.id === 'randomString') return;
    for (const [key, spec] of Object.entries(selected.fields)) {
      if (['rc4', 'rabbit'].includes(selected.id) && !['key', 'inputEncoding', 'outputEncoding'].includes(key)) continue;
      if (selected.id === 'qrCode' && ['cellSize', 'imageFormat'].includes(key)) continue;
      const panel = isPanel(selected.id, key), flags = selected.id === 'regex' && key === 'flags';
      const composite = cryptoTools.has(selected.id) && key === 'type' || selected.id === 'pinyin' && ['pattern', 'toneType'].includes(key) || selected.id === 'sm4' && key === 'mode' || selected.id === 'qrCode' && (key === 'image' || key.endsWith('GradientType'));
      const wrapper = document.createElement(panel ? 'section' : flags ? 'fieldset' : composite ? 'div' : 'label');
      wrapper.className = panel ? 'field-panel' : 'option-field';
      const caption = document.createElement(panel ? 'h3' : flags ? 'legend' : 'span'); caption.textContent = spec.title;
      const multiline = selected.id === 'regex' && ['expression', 'replacement'].includes(key);
      const choices = selected.id === 'bcrypt' && key === 'rounds' ? Array.from({ length: spec.maximum - spec.minimum + 1 }, (_, index) => spec.minimum + index) : selected.id === 'httpSnippet' && key === 'entry' ? [1] : selected.id === 'pinyin' && key === 'separator' ? ['', ' ', '-', '_', '.'] : spec.enum;
      const control = document.createElement(choices ? 'select' : panel ? 'page-code-editor' : multiline ? 'textarea' : 'input');
      control.id = 'option-' + key; control.setAttribute('aria-label', spec.title);
      if (choices) control.append(...choices.map(value => new Option(value === '' ? '无分隔符' : value === ' ' ? '空格' : String(value), value)));
      else if (panel) { control.setAttribute('language', ['schema', 'parameters'].includes(key) ? 'json' : 'plaintext'); control.setAttribute('data-label', spec.title); control.setAttribute('placeholder', spec.title); control.setAttribute('rows', '8'); }
      else if (spec.type === 'boolean') { control.type = 'checkbox'; wrapper.classList.add('checkbox-field'); }
      else if (spec.type === 'integer') { control.type = 'number'; control.min = spec.minimum; control.max = spec.maximum; control.step = '1'; }
      else { if (!multiline) control.type = 'text'; else control.rows = 3; control.maxLength = 65536; control.spellcheck = false; control.autocomplete = 'off'; }
      if (spec.type === 'boolean') control.checked = spec.default; else control.value = spec.default;
      control.addEventListener('input', () => {
        if (selected.id === 'qrCode' && key === 'outputEncoding') { void formatQrOutput(); return; }
        if (key === 'inputEncoding' || selected.id === 'dataValidation' && key === 'encoding') { $('input').value = ''; $('file-panel')?.remove(); }
        if (key === 'outputFormat' && uuidRaw && selected.id === 'uuid') { clearTimeout(autoTimer); autoTimer = setTimeout(() => { void formatUuid(); }, 180); }
        else inputChanged();
      });
      if (['mode', 'algorithm', 'language', 'from', 'to', 'type', 'salted', 'inputEncoding', 'encoding', 'textPosition', 'parameterFormat'].includes(key)) control.addEventListener('change', updateForm);
      if (panel) wrapper.append(control); else if (spec.type === 'boolean') wrapper.append(control, caption); else wrapper.append(caption, control);
      (panel ? $('field-panels') : $('options')).append(wrapper);
      fields.set(key, { control, spec, wrapper, caption, panel });
    }
    if (cryptoTools.has(selected.id) && !['rc4', 'rabbit'].includes(selected.id)) {
      fields.get('keyEncoding').control.value = 'utf8';
      for (const key of ['mode', 'keySize', 'padding']) if (fields.has(key)) fields.get(key).caption.hidden = true;
      fields.get('key').caption.textContent = 'key'; fields.get('iv').caption.textContent = 'iv';
      const field = fields.get('type'), tabs = document.createElement('span'); tabs.className = 'crypto-tabs'; tabs.setAttribute('role', 'tablist'); field.control.hidden = true; field.caption.hidden = true;
      for (const [value, title] of [['advanced', '高级'], ['simple', '简单']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.dataset.value = value; button.setAttribute('role', 'tab');
        button.addEventListener('click', () => { field.control.value = value; inputChanged(); updateForm(); }); tabs.append(button);
      }
      field.wrapper.append(tabs);
    }
    if (selected.id === 'httpSnippet') {
      fields.get('from').control.value = 'curl'; fields.get('entry').caption.hidden = true;
      fields.get('from').control.addEventListener('change', () => { fields.get('entry').control.replaceChildren(new Option('1', '1')); updateForm(); });
    }
    if (selected.id === 'serialize') fields.get('to').control.value = 'xml';
    if (selected.id === 'pinyin') {
      pinyinMode = 'normal'; fields.get('separator').control.value = ''; fields.get('toneType').control.value = 'none';
      const pattern = fields.get('pattern'); pattern.control.hidden = true; pattern.caption.hidden = true;
      for (const [value, title] of [['normal', '普通'], ['tone', '声调'], ['abbr', '首字母']]) {
        const label = document.createElement('label'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'pinyin-mode'; radio.checked = value === 'normal'; label.append(radio, title); pattern.wrapper.append(label);
        radio.addEventListener('change', () => { pinyinMode = value; pattern.control.value = value === 'abbr' ? 'first' : 'pinyin'; fields.get('toneType').control.value = value === 'tone' ? $('pinyin-number-tone').checked ? 'num' : 'symbol' : 'none'; inputChanged(); updateForm(); });
      }
      const tone = fields.get('toneType'), number = document.createElement('input'); tone.control.hidden = true; number.type = 'checkbox'; number.id = 'pinyin-number-tone'; tone.caption.textContent = '数字声调'; tone.wrapper.prepend(number); tone.wrapper.classList.add('checkbox-field');
      number.addEventListener('change', () => { tone.control.value = number.checked ? 'num' : 'symbol'; inputChanged(); });
    }
    if (selected.id === 'sqlFillParameter') {
      fields.get('parameterFormat').control.value = 'mybatis'; fields.get('parameters').control.value = '';
      fields.get('parameters').control.setAttribute('placeholder', '1(Integer),zhangshan(String)');
    }
    if (selected.id === 'hexString') fields.get('separator').control.value = ' ';
    if (selected.id === 'dataValidation') fields.get('encoding').control.value = 'hex';
    if (selected.id === 'asn1') { fields.get('encoding').control.value = 'hex'; fields.get('outputFormat').control.value = 'xml'; }
    if (['sm2', 'rsa'].includes(selected.id)) {
      fields.get('inputEncoding').control.value = operation === 'decrypt' ? selected.id === 'sm2' ? 'hex' : 'base64' : 'utf8';
      fields.get('outputEncoding').control.value = operation === 'decrypt' ? 'utf8' : selected.id === 'sm2' ? 'hex' : 'base64';
    }
    if (cryptoTools.has(selected.id) || selected.id === 'gzip') {
      fields.get('inputEncoding').control.value = ['decrypt', 'decode'].includes(operation) ? 'base64' : 'utf8';
      fields.get('outputEncoding').control.value = ['decrypt', 'decode'].includes(operation) ? 'utf8' : 'base64';
    }
    if (selected.id === 'sm4') {
      fields.get('inputEncoding').control.value = operation === 'decrypt' ? 'hex' : 'utf8'; fields.get('outputEncoding').control.value = operation === 'decrypt' ? 'utf8' : 'hex';
      const field = fields.get('mode'), box = document.createElement('input'); box.type = 'checkbox'; box.checked = field.control.value === 'cbc'; field.control.hidden = true; field.caption.textContent = 'CBC'; field.wrapper.prepend(box); field.wrapper.classList.add('checkbox-field');
      box.addEventListener('change', () => { field.control.value = box.checked ? 'cbc' : 'ecb'; inputChanged(); updateForm(); });
    }
    if (selected.id === 'qrCode') {
      qrSection = 'common';
      const label = document.createElement('label'), checkbox = document.createElement('input'), tabs = document.createElement('div'), panels = document.createElement('div');
      checkbox.type = 'checkbox'; checkbox.id = 'qr-settings'; label.className = 'option-field checkbox-field qr-settings'; label.append(checkbox, '设置'); $('input-panel').append(label);
      tabs.id = 'qr-setting-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '二维码设置');
      panels.id = 'qr-setting-panels';
      for (const [value, title] of [['common', '常用'], ['dots', '内容'], ['corners', '定位边框'], ['center', '定位符'], ['background', '背景']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.dataset.value = value; button.setAttribute('role', 'tab');
        const panel = document.createElement('div'); panel.id = 'qr-setting-panel-' + value; panel.className = 'qr-setting-panel'; panel.dataset.section = value; panel.setAttribute('role', 'tabpanel');
        button.id = 'qr-setting-tab-' + value; button.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', button.id);
        button.addEventListener('click', () => { if (qrSection === value) return; qrSection = value; updateQrSettings(); }); tabs.append(button); panels.append(panel);
      }
      tabs.addEventListener('keydown', event => {
        const index = [...tabs.children].indexOf(event.target);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.children.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.children.length) % tabs.children.length;
        tabs.children[next].click(); tabs.children[next].focus();
      });
      $('options').append(tabs, panels); checkbox.addEventListener('change', () => { inputChanged(); updateQrSettings(); });
      const footer = document.createElement('div'); footer.id = 'qr-output-footer'; $('output-panel').append(footer);
      const input = fields.get('inputEncoding'), output = fields.get('outputEncoding');
      input.caption.hidden = output.caption.hidden = true; input.wrapper.classList.add('qr-input-type'); output.wrapper.classList.add('qr-output-type');
      input.control.value = operation === 'generate' ? 'utf8' : 'dataurl';
      output.control.replaceChildren(new Option('图片', 'image'), new Option('Hex', 'hex'), new Option('Base64', 'base64'));
      const image = fields.get('image'); image.control.hidden = image.caption.hidden = true;
      const styleTitles = { square: '方形', dots: '点', rounded: '圆形', classy: '平滑', 'extra-rounded': '圆角', 'classy-rounded': '平滑圆角', dot: '圆形' };
      for (const [key, field] of fields) {
        if (/Color$|Start$|End$/.test(key)) {
          field.control.type = 'color'; field.caption.hidden = true;
          if (key.endsWith('Start')) field.control.value = fields.get(key.replace(/Start$/, 'Color')).control.value;
        }
        if (key.endsWith('Style')) for (const option of field.control.options) option.text = styleTitles[option.value];
        if (key.endsWith('Gradient')) field.control.addEventListener('change', updateQrSettings);
        if (key.endsWith('GradientType')) {
          field.control.hidden = field.caption.hidden = true;
          const group = document.createElement('span'); group.className = 'app-actions'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', '渐变方式');
          for (const [value, title] of [['linear', '线性'], ['radial', '径向']]) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.dataset.value = value;
            button.addEventListener('click', () => { if (field.control.value === value) return; field.control.value = value; inputChanged(); updateQrSettings(); }); group.append(button);
          }
          field.wrapper.append(group);
        }
      }
    }
    if (['hash', 'hmac'].includes(selected.id)) {
      const algorithm = fields.get('algorithm').control;
      algorithm.prepend(new Option('全部算法', 'all')); algorithm.value = 'all';
    }
    if (selected.id === 'hmac') {
      const group = document.createElement('div'); group.className = 'tool-field-group hmac-key'; group.append(fields.get('key').wrapper, fields.get('keyEncoding').wrapper); $('input-panel').prepend(group);
      fields.get('key').control.placeholder = '密钥'; fields.get('key').caption.hidden = fields.get('keyEncoding').caption.hidden = true;
      for (const option of fields.get('keyEncoding').control.options) option.text = { utf8: '文本', hex: 'Hex', base64: 'Base64' }[option.value];
    }
    if (cryptoTools.has(selected.id) && fields.has('iv')) {
      const group = document.createElement('div'); group.className = 'tool-field-group crypto-iv'; $('options').append(group);
      fields.get('fill').caption.hidden = true; fields.get('fill').wrapper.title = '自动填充 IV';
    }
    if (selected.id === 'binary') for (const option of fields.get('bits').control.options) option.text = option.value + ' 位';
    if (selected.id === 'barcode') {
      const titles = { close: '不显示', top: '上方', bottom: '下方', left: '左对齐', center: '居中', right: '右对齐', monospace: '等宽', 'sans-serif': '无衬线', serif: '衬线', fantasy: '装饰', cursive: '手写' };
      for (const key of ['textPosition', 'textAlign', 'font']) for (const option of fields.get(key).control.options) option.text = titles[option.value];
    }
    if (selected.id === 'loremIpsum') for (const option of fields.get('unit').control.options) option.text = { paragraphs: '段落', sentences: '句子', words: '单词' }[option.value];
    if (selected.id === 'hash') {
      const presets = document.createElement('datalist'); presets.id = 'hash-salt-presets';
      presets.append(...['hash(hash($input))', 'hash($input.$salt)', 'hash(hash($input).$salt)', 'hash($input).hash($salt)', 'hash(hash(hash($input)))', 'hash($salt.$input.$salt)', 'hash(hash($input.$salt).$salt)', 'hash($salt.hash($input.$salt).$salt)', 'hash($salt.hash($salt.$input.$salt).$salt)'].map(value => new Option(value, value)));
      fields.get('expression').control.setAttribute('list', presets.id); fields.get('expression').wrapper.append(presets);
    }
    if (selected.id === 'regex') createRegexFlags();
    if (selected.id === 'diffs') {
      const editor = document.createElement('page-code-editor'); editor.setAttribute('data-original', ''); editor.setAttribute('data-diff-editable', '');
      editor.setAttribute('language', 'plaintext'); editor.setAttribute('aria-label', '左侧原始文本，右侧对比文本，均可编辑');
      editor.addEventListener('input', () => { $('input').value = editor.getAttribute('data-original'); fields.get('other').control.value = editor.value; inputChanged(); });
      diffContainer.append(editor);
    }
    if (['uuid', 'ulid'].includes(selected.id)) fields.get('count').control.value = 10;
    if (selected.id === 'uuid') {
      for (const [id, title, checked] of [['ulid', 'ULID', false], ['upper', '大写', false], ['hyphens', '连字符', true], ['bytes', '字节数组', false]]) {
        const label = document.createElement('label'), box = document.createElement('input'); label.className = 'option-field checkbox-field';
        box.type = 'checkbox'; box.id = 'uuid-' + id; box.checked = checked; label.append(box, title); $('options').append(label);
        box.addEventListener('change', () => {
          if (id === 'ulid') {
            $('uuid-hyphens').disabled = $('uuid-bytes').disabled = box.checked;
            uuidRaw = ''; inputChanged();
          } else if (uuidRaw) { clearTimeout(autoTimer); autoTimer = setTimeout(() => { void formatUuid(); }, 180); }
          else controls();
        });
      }
    }
    if (selected.id === 'sign') {
      const field = fields.get('key');
      field.wrapper.classList.add('key-pair'); field.wrapper.replaceChildren(); field.keyControls = {};
      for (const [kind, title] of [['public', '公钥（PEM）'], ['private', '私钥（PEM）']]) {
        const section = document.createElement('section'), control = document.createElement('page-code-editor');
        control.id = 'sign-' + kind; control.setAttribute('aria-label', title); control.setAttribute('data-label', title); control.setAttribute('placeholder', title); control.setAttribute('language', 'plaintext'); control.setAttribute('rows', '8');
        control.addEventListener('input', inputChanged); section.append(control); field.wrapper.append(section); field.keyControls[kind] = control;
      }
      $('field-panels').prepend(fields.get('signature').wrapper);
    }
  }
  function createRegexFlags() {
    const field = fields.get('flags'); field.control.type = 'hidden';
    field.control.value = 'gi';
    const group = document.createElement('span'); group.className = 'flag-options';
    for (const [flag, title] of [['g', '全局'], ['i', '忽略大小写'], ['m', '多行'], ['s', '点匹配换行'], ['u', 'Unicode'], ['y', '粘连']]) {
      const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.checked = field.control.value.includes(flag);
      label.append(box, title + ' (' + flag + ')'); group.append(label);
      box.addEventListener('change', () => {
        field.control.value = box.checked ? field.control.value + flag : field.control.value.replace(flag, ''); inputChanged();
      });
    }
    field.wrapper.append(group);
    const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.id = 'regex-delete';
    label.className = 'option-field checkbox-field'; label.append(box, '删除匹配内容'); box.addEventListener('change', inputChanged); $('options').append(label);
  }
  function selectTool(tool) {
    if (!tool) return;
    categoryTools.set(category, tool.id);
    if (selected?.id === tool.id) { renderNavigation(); return; }
    selected = tool; operation = ['html', 'regex'].includes(tool.id) ? tool.operations[0] : toolOperations.get(tool.id) || { rsa: 'encrypt', sm2: 'encrypt', sign: 'sign', uuid: 'v4', httpSnippet: 'fetch' }[tool.id] || tool.operations[0];
    toolbox.dataset.tool = tool.id; cron.activate(tool.id === 'crontab' ? tool : null);
    toolbox.dataset.specialized = String(views.supports(tool.id)); views.activate(tool, tools);
    keyDrafts = { public: '', private: '' }; uuidRaw = ''; qrDrafts.clear();
    invalidateResult(); $('input').value = ''; $('input-line').value = ''; $('file-panel')?.remove(); $('file-source-field')?.remove();
    $('title').textContent = tool.label; $('description').textContent = tool.description || '在当前浏览器内处理输入。';
    createFields(); updateForm(); renderNavigation(); controls(); message('输入内容只保留在当前页面，切换工具或关闭页面后清空。');
    if (tool.id === 'regex') { fields.get('expression').control.value = '[\\dheo]'; primary().value = new Date().getFullYear() + ' hello WORLD 你好世界'; }
    scheduleAuto();
  }
  function updateUpload() {
    const upload = fileKind(selected.id, operation), field = fields.get(selected.id === 'dataValidation' ? 'encoding' : 'inputEncoding');
    const custom = upload === 'image';
    if (field) {
      let formats = field.spec.enum;
      if (selected.id === 'base64') formats = operation === 'encode' ? ['utf8', 'hex'] : ['base64'];
      else if (selected.id === 'hexString') formats = operation === 'encode' ? ['utf8', 'base64'] : ['hex'];
      else if (selected.id === 'qrCode' && operation === 'parse') formats = ['base64', 'hex'];
      else if (selected.id === 'qrCode') formats = ['utf8', 'hex', 'base64'];
      else if (operation === 'decrypt' && (cryptoTools.has(selected.id) || ['sm2', 'sm4', 'rsa'].includes(selected.id)) || selected.id === 'gzip' && operation === 'decode') formats = selected.id === 'sm4' ? ['hex', 'base64'] : ['base64', 'hex'];
      if (upload && !custom) formats = [...formats, 'upload'];
      const titles = { utf8: '文本', hex: 'Hex', base64: 'Base64', dataurl: '图片 data URL', upload: '上传' }, previous = field.control.value;
      if (field.control.options.length !== formats.length || formats.some((value, index) => field.control.options[index]?.value !== value || field.control.options[index]?.text !== titles[value])) {
        field.control.replaceChildren(...formats.map(value => new Option(titles[value], value)));
        field.control.value = formats.includes(previous) ? previous : upload === 'qr-image' ? 'upload' : formats[0];
        if (field.control.value !== previous) { $('input').value = ''; $('file-panel')?.remove(); }
      }
    }
    if (!upload) { $('file-panel')?.remove(); $('file-source-field')?.remove(); return; }
    let format;
    if (custom) {
      format = $('file-source');
      if (!format) {
        const label = document.createElement('label'); label.id = 'file-source-field'; label.className = 'option-field';
        format = document.createElement('select'); format.id = 'file-source'; format.setAttribute('aria-label', '输入类型');
        format.append(new Option('图片 data URL', 'text'), new Option('上传', 'upload'));
        format.value = 'upload'; $('input').value = '';
        label.append(format); inputOptions.append(label);
        format.addEventListener('change', () => { $('input').value = ''; $('file-panel')?.remove(); inputChanged(); updateForm(); });
      }
    } else {
      $('file-source-field')?.remove(); format = field.control;
    }
    if (format.value !== 'upload') { $('file-panel')?.remove(); return; }
    $('input').hidden = true;
    let panel = $('file-panel');
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'file-panel'; panel.className = 'app-panel file-input'; panel.tabIndex = 0;
      const file = document.createElement('input'), status = document.createElement('p'); file.id = 'input-file'; file.type = 'file';
      file.setAttribute('aria-label', upload.includes('image') ? '选择图片' : upload === 'gzip' ? '选择压缩文件' : upload === 'text' ? '选择 UTF-8 文本文件' : '选择文件');
      status.className = 'section-desc'; status.setAttribute('role', 'status'); status.textContent = '可在此粘贴文件';
      file.addEventListener('change', () => { void readInputFile(file.files[0], upload, panel); });
      panel.addEventListener('paste', event => { const file = event.clipboardData?.files[0]; if (file) { event.preventDefault(); void readInputFile(file, upload, panel); } });
      panel.append(file, status); $('input').after(panel);
    }
    $('input-file').accept = upload === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : upload === 'qr-image' ? 'image/png,image/jpeg,image/webp' : upload === 'gzip' ? fieldValue('deflate') ? '.deflate,application/octet-stream' : '.gz,application/gzip' : '';
  }
  function updateQrImageUpload() {
    const image = fields.get('image');
    if (operation !== 'generate' || !$('qr-settings').checked) { $('qr-image-file')?.remove(); $('qr-image-upload')?.remove(); return; }
    if (!$('qr-image-file')) {
      const file = document.createElement('input'), button = document.createElement('button');
      file.id = 'qr-image-file'; file.type = 'file'; file.accept = 'image/png,image/jpeg,image/gif,image/webp'; file.hidden = true; file.setAttribute('aria-label', '中心图片');
      button.id = 'qr-image-upload'; button.type = 'button'; button.className = 'btn-secondary'; button.textContent = '上传图片'; button.addEventListener('click', () => file.click()); image.wrapper.append(file, button);
      const read = async chosen => {
        if (!chosen || closed) return;
        invalidateResult(); const ticket = revision;
        try {
          if (chosen.size > 32768 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(chosen.type)) throw new Error('中心图片请选择不超过 32 KiB 的 PNG/JPEG/GIF/WebP');
          const value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(chosen); });
          if (ticket !== revision) return; image.control.value = value; inputChanged(); updateQrSettings();
        } catch (error) { if (ticket === revision) message(error.message, true); }
        finally { file.value = ''; }
      };
      file.addEventListener('change', () => { void read(file.files[0]); });
      button.addEventListener('paste', event => { const chosen = event.clipboardData?.files[0]; if (chosen) { event.preventDefault(); void read(chosen); } });
    }
  }
  function updateQrSettings() {
    $('options').hidden = operation !== 'generate' || !$('qr-settings').checked;
    for (const button of $('qr-setting-tabs').children) {
      button.setAttribute('aria-selected', String(button.dataset.value === qrSection)); button.tabIndex = button.dataset.value === qrSection ? 0 : -1;
    }
    for (const panel of $('qr-setting-panels').children) {
      const section = panel.dataset.section, active = section === qrSection, gradient = fieldValue(section + 'Gradient');
      panel.dataset.active = String(active); panel.toggleAttribute('inert', !active); panel.setAttribute('aria-hidden', String(!active));
      const keys = section === 'common' ? ['margin', 'level', 'image', 'imageSize', 'imageMargin'] : ['Style', 'Gradient', 'Color', 'Start', 'End', 'GradientType', 'Rotation'].map(suffix => section + suffix);
      for (const key of keys) {
        const field = fields.get(key); if (!field) continue;
        if (field.wrapper.parentElement !== panel) panel.append(field.wrapper);
        field.wrapper.hidden = key.endsWith('Color') ? !!gradient : /Start$|End$|GradientType$|Rotation$/.test(key) ? !gradient : false;
        if (key.endsWith('GradientType')) for (const button of field.wrapper.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === field.control.value));
      }
    }
    updateQrImageUpload();
  }
  function updateQrResult() {
    if (selected?.id !== 'qrCode' || !$('qr-output-footer')) return;
    const generating = operation === 'generate';
    const image = generating && fieldValue('outputEncoding') === 'image' && (hasResult || !$('output').value);
    $('output').hidden = image;
    $('preview').hidden = generating && !image;
    $('qr-output-footer').hidden = !generating;
    const settings = $('qr-settings');
    settings.parentElement.hidden = !generating;
    settings.parentElement.style.visibility = hasResult || settings.checked ? '' : 'hidden';
    if ($('download-file')) $('download-file').hidden = !image || !hasResult;
  }
  async function formatQrOutput() {
    if (selected?.id !== 'qrCode' || operation !== 'generate') return;
    const file = result, encoding = fieldValue('outputEncoding'), current = revision;
    if (!hasResult || file?.encoding !== 'base64') { updateQrResult(); return; }
    try {
      let value = encoding === 'base64' ? file.content : '';
      if (encoding === 'hex') {
        qrHex ||= request('POST', tools.find(tool => tool.id === 'base64').operationUris.decode, { input: file.content, options: { outputEncoding: 'hex' } });
        value = (await qrHex).value;
      }
      if (closed || current !== revision || file !== result || fieldValue('outputEncoding') !== encoding) return;
      $('output').value = value; updateQrResult();
    } catch (error) {
      if (closed || current !== revision || file !== result) return;
      qrHex = null;
      if (fieldValue('outputEncoding') !== encoding) return;
      $('output').value = error.message; updateQrResult(); message(error.message, true);
    }
  }
  function updateForm() {
    if (!selected) return;
    const generated = ['uuid', 'ulid', 'loremIpsum'].includes(selected.id) && inputKind(selected.id, operation) === 'none';
    const fitted = !views.supports(selected.id) && !['crontab', 'qrCode'].includes(selected.id);
    toolbox.dataset.fitted = String(fitted); toolbox.dataset.generated = String(generated);
    for (const id of ['input-panel', 'output-panel', 'options']) $(id).classList.toggle('app-panel', selected.id === 'qrCode' || selected.id === 'barcode' && id !== 'input-panel' || (cryptoTools.has(selected.id) || selected.id === 'pinyin' || generated) && id === 'options');
    $('preview').hidden = false;
    // Keep mounted editors and their layout stable when only options change.
    const outputParent = selected.id === 'qrCode' && operation === 'parse' ? $('input-panel') : $('output-panel');
    if ($('output').parentElement !== outputParent) {
      if (outputParent === $('output-panel')) outputParent.querySelector('.section-title').after($('output'));
      else outputParent.append($('output'));
    }
    for (const field of fields.values()) {
      if (!field.panel) $('options').append(field.wrapper);
    }
    if (selected.id === 'code') {
      if (operation === 'minify' && !['javascript', 'json', 'css'].includes(fieldValue('language'))) {
        operation = 'format'; toolOperations.set(selected.id, operation);
      }
      renderOperations();
    }
    const visible = new Set(visibleFields(selected, operation, fieldValue));
    for (const [key, field] of fields) { field.wrapper.hidden = !visible.has(key); field.control.toggleAttribute('disabled', !visible.has(key)); }
    if (cryptoTools.has(selected.id) && !['rc4', 'rabbit'].includes(selected.id)) {
      $('options').dataset.mode = fieldValue('type');
      for (const button of fields.get('type').wrapper.querySelectorAll('button')) button.setAttribute('aria-selected', String(button.dataset.value === fieldValue('type')));
      const disabled = fieldValue('mode') === 'ECB';
      if (fields.has('iv')) fields.get('iv').control.disabled = disabled;
      fields.get('fill').control.disabled = disabled;
    }
    if (['hash', 'hmac'].includes(selected.id)) {
      fields.get('multiple').control.disabled = fieldValue('inputEncoding') !== 'utf8';
      if (fields.has('salted')) fields.get('salted').control.disabled = fieldValue('inputEncoding') !== 'utf8';
    }
    if (selected.id === 'barcode') for (const key of ['textMargin', 'textAlign', 'font', 'fontSize', 'bold', 'italic']) fields.get(key).wrapper.hidden = fieldValue('textPosition') === 'close';
    if (selected.id === 'httpSnippet') fields.get('entry').wrapper.hidden = fieldValue('from') !== 'har' || fields.get('entry').control.options.length < 2;
    if (selected.id === 'sm4') for (const key of ['iv', 'ivEncoding']) fields.get(key).control.disabled = fieldValue('mode') !== 'cbc';
    if (selected.id === 'pinyin') fields.get('toneType').wrapper.hidden = pinyinMode !== 'tone';
    if (selected.id === 'sqlFillParameter') fields.get('parameters').control.setAttribute('language', fieldValue('parameterFormat') === 'json' ? 'json' : 'plaintext');
    if (selected.id === 'regex') fields.get('replacement').control.disabled = $('regex-delete').checked;
    if (selected.id === 'dataValidation') {
      const field = fields.get('algorithm'); field.wrapper.hidden = !field.control.value.startsWith('CRC');
      for (const option of field.control.options) option.hidden = !option.value.startsWith('CRC');
      renderOperations();
    }
    if (selected.id === 'sign') {
      const key = fields.get('key'); key.control = key.keyControls[keyKind(operation)];
      for (const control of Object.values(key.keyControls)) control.toggleAttribute('disabled', operation === 'keypair');
      // Signing and verification share the same four inputs.
      const signature = fields.get('signature'); signature.wrapper.hidden = operation === 'keypair'; signature.control.toggleAttribute('disabled', operation === 'keypair');
    }
    $('options').hidden = ![...fields].some(([key, field]) => visible.has(key) && !field.panel);
    const oldInput = primary().value, kind = inputKind(selected.id, operation);
    $('input-panel').dataset.kind = kind; primary().value = oldInput;
    $('input-panel').hidden = kind === 'none'; $('input').hidden = kind !== 'editor'; $('input-line').hidden = kind !== 'line';
    const panels = [...fields].filter(([key, field]) => visible.has(key) && field.panel).length;
    $('inputs').dataset.columns = panels ? 'two' : 'one';
    const stacked = ['base64', 'url', 'unicode', 'hexString', 'gzip', 'punycode', 'pinyin', 'aes', 'des', 'tripleDes', 'rc4', 'rabbit', 'sm2', 'sm4', 'asn1'].includes(selected.id);
    $('editors').dataset.layout = inPlace() ? 'inplace' : kind === 'none' ? 'generator' : panels ? 'multiple' : kind === 'line' ? 'compact' : stacked ? 'stacked' : 'columns';
    $('output').hidden = inPlace() || ['sign', 'bcrypt', 'barcode'].includes(selected.id);
    $('output').toggleAttribute('readonly', selected.id !== 'html');
    for (const id of ['input', 'output']) {
      if (fitted || selected.id === 'qrCode') $(id).setAttribute('rows', '12');
      else { $(id).removeAttribute('rows'); $(id).style.removeProperty('--code-height'); }
      $(id).removeAttribute('data-label'); $(id).removeAttribute('placeholder');
    }
    $('inputs').hidden = kind === 'none' && !panels;
    let title = selected.id === 'diffs' ? '原始文本' : selected.id === 'sqlFillParameter' ? 'SQL' : selected.id === 'bcrypt' ? '密码' : selected.id === 'json' ? 'JSON 输入' : '输入';
    if (selected.id === 'uuid' && ['v3', 'v5'].includes(operation)) title = '名称';
    if (selected.id === 'time') title = operation === 'difference' ? '第一个 ISO 时间' : operation === 'timestamp' ? '时间戳或 ISO 日期' : 'ISO 日期时间';
    if (selected.id === 'crontab') title = 'Cron 表达式';
    if (selected.id === 'base64Image') title = operation === 'encode' ? '图片 data URL' : '图片 Base64 / data URL';
    if (selected.id === 'qrCode' && operation === 'parse') title = '待解析二维码图片';
    primary().setAttribute('aria-label', title);
    if (['bcrypt', 'sign', 'sqlFillParameter', 'variableConversion', 'binary'].includes(selected.id)) $('input').setAttribute('data-label', { bcrypt: '密码', sign: '原文', sqlFillParameter: 'SQL', variableConversion: '原文', binary: '十进制' }[selected.id]);
    if (selected.id === 'sqlFillParameter') $('input').setAttribute('placeholder', 'SELECT * FROM T WHERE id=? AND name = ?');
    if (selected.id === 'barcode') $('input-line').placeholder = 'Example 1234';
    $('output').setAttribute('aria-label', selected.id === 'html' ? 'HTML 实体' : '处理结果');
    if (selected.id === 'html') $('input').setAttribute('aria-label', '原文');
    if (fields.has('key') && ['rsa', 'sm2'].includes(selected.id)) {
      const publicKey = ['encrypt', 'verify'].includes(operation), title = (publicKey ? '公钥' : '私钥') + (selected.id === 'sm2' ? '（十六进制）' : '（PEM）');
      fields.get('key').caption.textContent = title; fields.get('key').control.setAttribute('aria-label', title); fields.get('key').control.setAttribute('data-label', title);
    }
    let inputLanguage = 'plaintext', outputLanguage = 'plaintext';
    if (selected.id === 'json') { inputLanguage = operation === 'escape' ? 'plaintext' : 'json'; outputLanguage = operation === 'toCode' ? fieldValue('language') : 'json'; }
    if (selected.id === 'serialize') { inputLanguage = fieldValue('from'); outputLanguage = fieldValue('to'); }
    if (selected.id === 'code') inputLanguage = outputLanguage = fieldValue('language');
    if (selected.id === 'asn1') outputLanguage = fieldValue('outputFormat');
    if (selected.id === 'svgToCss') { inputLanguage = 'html'; outputLanguage = 'css'; }
    if (selected.id === 'httpSnippet') inputLanguage = fieldValue('from') === 'curl' ? 'plaintext' : 'json';
    const supported = ['javascript', 'json', 'html', 'css'];
    $('input').setAttribute('language', supported.includes(inputLanguage) ? inputLanguage : 'plaintext');
    $('output').setAttribute('language', supported.includes(outputLanguage) ? outputLanguage : 'plaintext');
    $('editors').before(toolbar, $('options'));
    if (['json', 'code', 'text', 'bcrypt', 'uuid', 'ulid', 'loremIpsum'].includes(selected.id)) $('editors').after($('options'), toolbar);
    if (selected.id === 'sign') { fields.get('key').wrapper.before(toolbar); renderOperations(); }
    if (liveTools.has(selected.id) && selected.id !== 'diffs') $('input-panel').querySelector('.section-title').append(toolbar);
    if (['aes', 'des', 'tripleDes', 'rc4', 'rabbit', 'sm2', 'sm4', 'gzip', 'pinyin'].includes(selected.id)) $('inputs').after($('options'));
    if (selected.id === 'rsa' && fields.get('key').wrapper.parentElement !== $('inputs')) $('inputs').prepend(fields.get('key').wrapper);
    if (selected.id === 'rsa') outputOptions.append(fields.get('hash').wrapper);
    if (selected.id === 'sm2') fields.get('signature').wrapper.append(fields.get('signatureEncoding').wrapper);
    if (['serialize', 'httpSnippet'].includes(selected.id)) {
      if (fields.has('from')) inputOptions.append(fields.get('from').wrapper);
      if (fields.has('to')) outputOptions.append(fields.get('to').wrapper);
      if (selected.id === 'httpSnippet') outputOptions.append(fields.get('entry').wrapper, toolbar);
    }
    if (selected.id === 'barcode') { $('editors').prepend($('output-panel')); $('editors').after($('options')); $('options').prepend($('inputs')); }
    if (selected.id === 'barcode') { fields.get('background').control.type = 'color'; fields.get('lineColor').control.type = 'color'; }
    if (selected.id === 'binary') inputOptions.append($('options'));
    if (selected.id === 'dataValidation') inputOptions.append($('options'));
    if (['hash', 'hmac'].includes(selected.id)) {
      inputOptions.append($('options'));
      if (selected.id === 'hmac') document.querySelector('.hmac-key').append(fields.get('key').wrapper, fields.get('keyEncoding').wrapper);
    }
    if (fields.has('inputEncoding')) inputOptions.append(fields.get('inputEncoding').wrapper);
    if (fields.has('outputEncoding')) outputOptions.append(fields.get('outputEncoding').wrapper);
    if (fields.has('outputFormat')) outputOptions.append(fields.get('outputFormat').wrapper);
    if (cryptoTools.has(selected.id)) {
      for (const key of ['type', 'mode', 'keySize', 'padding', 'key', 'iv', 'fill']) if (fields.has(key)) $('options').append(fields.get(key).wrapper);
      const iv = document.querySelector('.crypto-iv');
      if (iv) { iv.append(fields.get('iv').wrapper, fields.get('fill').wrapper); iv.hidden = fields.get('iv').wrapper.hidden; $('options').append(iv); }
      const field = fields.get('outputEncoding'), allowed = operation === 'encrypt' ? ['base64', 'hex'] : ['utf8', 'hex', 'base64'];
      if (!allowed.includes(field.control.value)) field.control.value = allowed[0];
      for (const option of field.control.options) option.hidden = !allowed.includes(option.value);
    }
    if (selected.id === 'bcrypt') actionChoices.prepend(fields.get('rounds').wrapper, fields.get('version').wrapper);
    if (generated) $('options').append(toolbar);
    if (selected.id === 'qrCode') {
      toolbox.dataset.qrOperation = operation;
      $('input-panel').append(fields.get('inputEncoding').wrapper);
      $('input-panel').append($('qr-settings').parentElement); $('qr-output-footer').append(fields.get('outputEncoding').wrapper);
      $('options').prepend($('qr-setting-tabs'), $('qr-setting-panels')); $('editors').after($('options'));
      updateQrSettings();
      $('output').setAttribute('rows', '12');
      updateQrResult();
    }
    updateUpload();
    $('input-panel').append(inputOptions); $('output-panel').append(outputOptions);
    if (selected.id !== 'qrCode') $('options').hidden = ![...$('options').children].some(child => !child.hidden);
    if (!hasResult) emptyResultFields();
    controls();
  }
  function inputValue() {
    if (selected.id === 'crontab') return cron.nodeInput();
    if (views.supports(selected.id)) { const value = views.nodeInput(); if (!value) throw new Error('当前组合页面请使用对应的序列化转换节点'); return value; }
    const options = {}, active = new Set(visibleFields(selected, operation, fieldValue));
    if (selected.id === 'qrCode' && operation === 'generate' && !$('qr-settings').checked) for (const key of active) if (!['inputEncoding', 'outputEncoding', 'image'].includes(key)) active.delete(key);
    for (const [key, { control, spec }] of fields) {
      if (!active.has(key)) continue;
      if (control.disabled && !(selected.id === 'regex' && key === 'replacement')) continue;
      if (selected.id === 'qrCode' && /Start$|End$|GradientType$|Rotation$/.test(key) && !fieldValue(key.replace(/Start$|End$|GradientType$|Rotation$/, 'Gradient'))) continue;
      if (selected.id === 'bcrypt' && (operation === 'hash' ? key === 'hash' : key === 'rounds')) continue;
      if (selected.id === 'regex' && operation !== 'replace' && key === 'replacement') continue;
      const value = spec.type === 'boolean' ? control.checked : spec.type === 'integer' ? Number(control.value) : control.value;
      if (spec.type === 'integer' && (!control.value || !Number.isInteger(value) || value < spec.minimum || value > spec.maximum)) throw new Error(spec.title + ' 超出允许范围');
      if (typeof value === 'string' && value.length > 65536) throw new Error(spec.title + ' 最多 65536 个字符');
      options[key] = value;
    }
    if ($('file-panel')) {
      const upload = fileKind(selected.id, operation);
      if (upload === 'bytes' || upload === 'gzip') options[selected.id === 'dataValidation' ? 'encoding' : 'inputEncoding'] = 'base64';
      if (upload === 'qr-image') options.inputEncoding = 'dataurl';
      if (upload === 'text' && selected.id === 'qrCode') options.inputEncoding = 'utf8';
    }
    if (selected.id === 'qrCode' && operation === 'generate') options.imageFormat = 'png';
    if (['rc4', 'rabbit'].includes(selected.id)) options.type = 'simple';
    if (cryptoTools.has(selected.id)) options.keyEncoding = 'utf8';
    if (selected.id === 'sqlFillParameter') Object.assign(options, { parameterFormat: 'mybatis', dialect: 'question' });
    if (['hash', 'hmac'].includes(selected.id) && options.inputEncoding !== 'utf8') { options.multiple = false; if (selected.id === 'hash') options.salted = false; }
    if (selected.id === 'regex' && $('regex-delete').checked) options.replacement = '';
    if (selected.id === 'uuid') Object.assign(options, { uppercase: $('uuid-upper').checked, ...(!$('uuid-ulid').checked ? { hyphens: $('uuid-hyphens').checked, bytes: $('uuid-bytes').checked } : {}) });
    const input = inputKind(selected.id, operation) === 'none' ? '' : primary().value;
    if (input.length > 65536) throw new Error('输入最多 65536 个字符');
    if (JSON.stringify({ input, options }).length > 100000) throw new Error('单次参数超过 100000 字符，请缩小输入');
    return { operation, input, options };
  }
  async function formatUuid() {
    const current = ++revision, tool = tools.find(item => item.id === ($('uuid-ulid').checked ? 'ulid' : 'uuid'));
    try {
      const options = { outputFormat: fieldValue('outputFormat'), uppercase: $('uuid-upper').checked, ...(tool.id === 'uuid' ? { hyphens: $('uuid-hyphens').checked, bytes: $('uuid-bytes').checked } : {}) };
      const response = await request('POST', tool.operationUris.format, { input: uuidRaw, options });
      if (current !== revision) return;
      result = response.value; hasResult = true; $('output').value = result; message(''); controls();
    } catch (error) { if (current === revision) message(error.message, true); }
  }
  function appendDownload(file, parent) {
    const download = document.createElement('button'); download.id = 'download-file'; download.type = 'button'; download.textContent = '下载';
    download.addEventListener('click', () => {
      let blob = new Blob([file.encoding === 'base64' ? Uint8Array.from(atob(file.content), char => char.charCodeAt(0)) : file.content], { type: file.mime }), filename = file.filename;
      if (file.mime === 'image') {
        const match = /^data:(image\/(png|jpeg|gif|webp));base64,(.*)$/i.exec(file.content);
        if (match) { blob = new Blob([Uint8Array.from(atob(match[3]), char => char.charCodeAt(0))], { type: match[1] }); filename = 'image.' + match[2]; }
      }
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    parent.append(download);
  }
  function showResult(value, tool, body) {
    hasResult = true;
    if (tool.id === 'html') {
      $(body.operation === 'decode' ? 'input' : 'output').value = value;
      return;
    }
    if (tool.id === 'qrCode') {
      if (body.operation === 'parse') {
        $('output').value = value.text;
        const img = document.createElement('img'); img.src = value.image; img.alt = '待解析二维码'; $('preview').append(img);
      } else if (typeof value === 'string') $('output').value = value;
      else if (value?.mime === 'image/png' || value?.mime === 'image/svg+xml') {
        // A file result belongs in the preview, never in the text editor.
        $('output').value = '';
        const blob = new Blob([value.encoding === 'base64' ? Uint8Array.from(atob(value.content), char => char.charCodeAt(0)) : value.content], { type: value.mime });
        previewUrl = URL.createObjectURL(blob);
        const img = document.createElement('img'), caption = document.createElement('p'); img.src = previewUrl; img.alt = '生成的二维码';
        if (value.mime === 'image/png') {
          img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', '复制二维码图片'); img.title = '点击复制图片';
          const copy = async () => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); await notify('已复制图片'); } catch (error) { await notify('复制失败：' + error.message, true); } };
          img.addEventListener('click', copy);
          img.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); void copy(); } });
        }
        caption.className = 'section-desc'; caption.textContent = value.filename + (value.width && value.height ? ' (' + value.width + ' × ' + value.height + ')' : '');
        $('preview').append(img, caption); appendDownload(value, $('qr-output-footer'));
      }
      updateQrResult();
      if (body.operation === 'generate') void formatQrOutput();
      return;
    }
    if (tool.id !== 'barcode') $('output').value = textValue(value);
    if (tool.id === 'regex' && body.operation === 'match') {
      $('output').value = value.length ? '共 ' + value.length + ' 个匹配\n' + value.map(item => item.value).join('\n') : '没有匹配结果';
      result = $('output').value;
    }
    if (tool.id === 'bcrypt') {
      if (body.operation === 'hash') fields.get('hash').control.value = value;
      else { const button = actionChoices.querySelector('[data-operation=verify]'); if (button) button.textContent = value.valid ? '验证（通过）' : '验证（失败）'; }
      $('output').hidden = true; return;
    }
    if (inPlace() && typeof value === 'string') { primary().value = value; $('output').hidden = true; }
    if (body.operation === 'keypair' && value?.publicKey && value?.privateKey) {
      keyDrafts = { public: value.publicKey, private: value.privateKey };
      if (tool.id === 'sign') {
        const controls = fields.get('key').keyControls;
        controls.public.value = value.publicKey; controls.private.value = value.privateKey;
      } else fields.get('key').control.value = keyDrafts[keyKind(operation)];
      $('output').hidden = true; return;
    }
    if (['sign', 'sm2'].includes(tool.id) && body.operation === 'sign') {
      fields.get('signature').control.value = value;
      if (tool.id === 'sm2') fields.get('signatureEncoding').control.value = body.options.outputEncoding === 'base64' ? 'base64' : 'hex';
      if (tool.id === 'sign') $('output').hidden = true;
    }
    if (tool.id === 'sign' && body.operation === 'verify') {
      const button = actionChoices.querySelector('[data-operation=verify]'); if (button) button.textContent = value.valid ? '验证（通过）' : '验证（失败）';
      return;
    }
    const structured = ['hash', 'hmac', 'variableConversion', 'time', 'jwt', 'rsa', 'sign', 'sm2', 'dataValidation', 'color', 'urlParse', 'ipcalc', 'ulid', 'uuid', 'text'].includes(tool.id);
    const object = structured && value && typeof value === 'object' && !Array.isArray(value) && !value.mime;
    const binary = tool.id === 'binary' && Array.isArray(value);
    if (object || binary) {
      const entries = binary ? ['signMagnitude', 'onesComplement', 'twosComplement'].map(key => [key, value.map(item => item[key] ?? '超出表示范围').join('\n')]) : tool.id === 'dataValidation' ? [['Hex', value.hex], ['Dec', value.decimal], ['Oct', value.octal], ['Bin', value.binary]] : Object.entries(value);
      renderResultFields(entries, tool.id === 'jwt' ? 'two' : 'one');
    }
    if (value?.mime === 'image/svg+xml' && typeof value.content === 'string') {
      previewUrl = URL.createObjectURL(new Blob([value.content], { type: value.mime }));
      const img = document.createElement('img'); img.src = previewUrl; img.alt = tool.label + '生成结果'; $('preview').append(img); $('output').hidden = true;
      if (tool.id === 'barcode') {
        img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', '复制条形码图片'); img.title = '点击复制图片';
        const copy = async () => {
          try {
            await img.decode();
            const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4000000) throw new Error('图片尺寸超过复制范围，请下载 SVG');
            canvas.getContext('2d').drawImage(img, 0, 0);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!blob) throw new Error('无法读取图片');
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); await notify('已复制图片');
          } catch (error) { await notify('复制失败：' + error.message, true); }
        };
        img.addEventListener('click', copy); img.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); void copy(); } });
      }
    }
    if (value?.mime === 'image') { const img = document.createElement('img'); img.src = value.content; img.alt = 'Base64 图片'; $('preview').append(img); $('output').hidden = true; }
    if (value?.encoding === 'base64') $('output').value = value.content;
    if (tool.id === 'base64Image' && body.operation === 'decode' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)) {
      const img = document.createElement('img'); img.src = value; img.alt = 'Base64 解码图片'; $('preview').append(img); $('output').hidden = true;
    }
    const file = value?.mime ? value : tool.id === 'base64Image' && body.operation === 'decode' ? { content: value, mime: 'image', filename: 'decoded-image' } : null;
    if (file) appendDownload(file, $('output-panel').querySelector('.section-title'));
  }
  for (const id of ['categories', 'tools', 'operations']) {
    $(id).addEventListener('keydown', event => {
      const tabs = [...$(id).querySelectorAll('[role=tab]')], index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    });
  }
  async function execute(override) {
    if (!selected || busy || closed || !permitted()) return;
    const tool = selected;
    invalidateResult(); const current = revision;
    try {
      const body = override || inputValue(); busy = true; controls(); message('正在本地计算…');
      let value;
      if (['hash', 'hmac'].includes(tool.id) && body.options.algorithm === 'all') {
        value = {};
        // Reuse the existing single-algorithm contract, keeping at most one worker active.
        for (const algorithm of defaultDigests(tool.id)) {
          const response = await request('POST', tool.operationUris[body.operation], { input: body.input, options: { ...body.options, algorithm } });
          if (current !== revision) return;
          value[algorithm] = response.value;
        }
      } else if (tool.id === 'variableConversion') {
        value = {};
        for (const id of tool.operations) {
          const response = await request('POST', tool.operationUris[id], { input: body.input });
          if (current !== revision) return;
          value[operationLabel(id)] = response.value;
        }
      } else {
        if (tool.id === 'httpSnippet' && body.options.from === 'har') {
          const entries = (await request('POST', tool.operationUris.requests, { input: body.input, options: { from: 'har' } })).value;
          if (current !== revision) return;
          const field = fields.get('entry'), chosen = entries.some(item => item.entry === body.options.entry) ? body.options.entry : entries[0]?.entry || 1;
          field.control.replaceChildren(...entries.map(item => new Option(item.entry + '. ' + item.url, item.entry)));
          field.control.value = String(chosen); field.wrapper.hidden = entries.length < 2; body.options.entry = chosen;
        }
        const uri = tool.id === 'uuid' && $('uuid-ulid').checked ? tools.find(item => item.id === 'ulid').operationUris.generate : tool.operationUris[body.operation];
        let options = tool.id === 'uuid' ? { count: body.options.count, ...(body.options.namespace ? { namespace: body.options.namespace } : {}) } : body.options;
        if (tool.id === 'qrCode' && body.operation === 'generate') options = { ...options, outputEncoding: 'image' };
        if (tool.id === 'uuid' && $('uuid-ulid').checked) delete options.namespace;
        const response = await request('POST', uri, { input: body.input, options });
        value = response.value;
      }
      if (current !== revision) return;
      if (tool.id === 'uuid') {
        uuidRaw = value;
        const target = $('uuid-ulid').checked ? tools.find(item => item.id === 'ulid') : tool;
        const options = { outputFormat: body.options.outputFormat, uppercase: body.options.uppercase, ...(target.id === 'uuid' ? { hyphens: body.options.hyphens, bytes: body.options.bytes } : {}) };
        value = (await request('POST', target.operationUris.format, { input: value, options })).value;
        if (current !== revision) return;
      }
      result = value; showResult(result, tool, body); message('处理完成。');
    } catch (error) {
      if (current === revision) {
        message(error.message, true);
        if (tool.id === 'barcode') $('preview').textContent = '生成失败：' + error.message;
        else if (liveTools.has(tool.id) && tool.id !== 'html' && !$('result-fields').childElementCount) { $('output').hidden = false; $('output').value = error.message; }
        updateQrResult();
      }
    }
    finally { busy = false; controls(); if (autoPending) void execute(); }
  }
  $('run').addEventListener('click', () => { void execute(); });
  $('search').addEventListener('input', renderSearch);
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('search').value = ''; renderSearch(); }
    if (event.key === 'Enter') { event.preventDefault(); $('search-tools').querySelector('button')?.click(); }
  });
  $('input').addEventListener('input', () => {
    if (selected?.id === 'html') operation = 'encode';
    if (selected?.id === 'httpSnippet') { const field = fields.get('entry'); field.control.replaceChildren(new Option('1', '1')); field.wrapper.hidden = true; }
    inputChanged();
  });
  $('output').addEventListener('input', () => { if (selected?.id === 'html') { operation = 'decode'; inputChanged(); } });
  $('input-line').addEventListener('input', inputChanged);
  $('copy-node').addEventListener('click', async () => {
    if ($('copy-node').disabled) return;
    try {
      const body = inputValue();
      const tool = body.toolId ? tools.find(item => item.id === body.toolId) : selected.id === 'uuid' && $('uuid-ulid').checked ? tools.find(item => item.id === 'ulid') : selected;
      const node = { nodeId: 'utility_' + crypto.randomUUID().replace(/-/g, ''), type: tool.nodeType, title: tool.label, params: { operation: tool.id === 'ulid' && selected.id === 'uuid' ? 'generate' : body.operation, input: body.input, ...body.options } };
      await copyText(JSON.stringify(node, null, 2), '已复制，可在流程「添加节点 → 粘贴节点 JSON」中添加。');
    } catch (error) { await notify(error.message, true); }
  });
  async function readInputFile(file, upload, panel) {
    if (!file || !panel.isConnected || closed) return;
    invalidateResult(); $('input').value = ''; const current = revision, status = panel.querySelector('p'); status.textContent = '正在读取文件…';
    try {
      const picker = panel.querySelector('input');
      if (picker.files[0] !== file) { const transfer = new DataTransfer(); transfer.items.add(file); picker.files = transfer.files; }
      const image = upload.includes('image');
      const binaryInput = upload === 'bytes' || upload === 'gzip';
      const limit = upload === 'image' ? 32768 : image || upload === 'gzip' || binaryInput ? 49152 : 262144;
      if (file.size > limit) throw new Error('文件最多 ' + limit / 1024 + ' KiB，请缩小输入');
      let value;
      if (image) {
        const allowed = upload === 'image' ? ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp'];
        if (!allowed.includes(file.type)) throw new Error('请选择 ' + (upload === 'image' ? 'PNG / JPEG / GIF / WebP' : 'PNG / JPEG / WebP') + ' 图片');
        value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (binaryInput) {
          if (upload === 'gzip' && !fieldValue('deflate') && (bytes[0] !== 0x1f || bytes[1] !== 0x8b)) throw new Error('请选择 Gzip 压缩文件；Base64 内容可直接粘贴到输入框');
          value = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
        } else {
          try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { throw new Error('此输入只支持 UTF-8 文本文件'); }
        }
      }
      if (value.length > 65536) throw new Error('文件内容超过 65536 字符，请缩小输入');
      if (current === revision && panel.isConnected) { primary().value = value; status.textContent = '已读取文件'; inputChanged(); updateForm(); }
    } catch (error) { if (current === revision && panel.isConnected) { panel.querySelector('input').value = ''; status.textContent = error.message; message(error.message, true); } }
  }
  function renderCommonSettings() {
    const focused = $('common-form').contains(document.activeElement) ? document.activeElement.id : '';
    closeCommonMenu(); endCommonDrag(); $('common-choices').replaceChildren();
    const ordered = [...commonDraft.map(id => tools.find(tool => tool.id === id)), ...tools.filter(tool => !commonDraft.includes(tool.id))];
    for (const tool of ordered) {
      const row = document.createElement('li'); row.id = 'common-row-' + tool.id; row.className = 'common-choice'; row.dataset.toolId = tool.id;
      const handle = document.createElement('span'); handle.className = 'common-drag-handle'; handle.setAttribute('aria-hidden', 'true'); row.append(handle);
      const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.id = 'common-choice-' + tool.id; box.checked = commonDraft.includes(tool.id);
      box.addEventListener('change', () => { commonDraft = box.checked ? [...commonDraft, tool.id] : commonDraft.filter(id => id !== tool.id); renderCommonSettings(); });
      label.append(box, tool.label); row.append(label);
      if (box.checked) {
        row.classList.add('is-selected'); row.draggable = true; row.tabIndex = 0;
        row.title = '拖拽整行排序；方向键移动，Home 置顶，End 置底';
        row.addEventListener('keydown', event => {
          if (event.target !== row) return;
          const index = commonDraft.indexOf(tool.id);
          const target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: commonDraft.length - 1 }[event.key];
          if (target === undefined || savingCommon || closed) return;
          event.preventDefault(); moveCommon(tool.id, Math.max(0, Math.min(commonDraft.length - 1, target)));
        });
        const more = document.createElement('button'), menu = document.createElement('div'), pin = document.createElement('button');
        more.type = 'button'; more.className = 'common-more'; more.id = 'common-more-' + tool.id; more.title = '常用工具操作';
        menu.id = 'common-menu-' + tool.id; menu.className = 'common-menu'; menu.popover = 'auto';
        more.popoverTargetElement = menu;
        more.setAttribute('aria-label', tool.label + '操作'); more.setAttribute('aria-controls', menu.id); more.setAttribute('aria-expanded', 'false');
        pin.type = 'button'; pin.textContent = '置顶'; pin.disabled = commonDraft[0] === tool.id;
        pin.addEventListener('click', () => { if (!savingCommon && !closed) moveCommon(tool.id, 0); });
        more.addEventListener('click', event => { if (savingCommon || closed) event.preventDefault(); });
        menu.addEventListener('toggle', () => {
          const open = menu.matches(':popover-open'); more.setAttribute('aria-expanded', String(open));
          if (!open) return;
          const rect = more.getBoundingClientRect();
          menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
          menu.style.top = (rect.bottom + menu.offsetHeight + 4 <= window.innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - menu.offsetHeight - 4)) + 'px';
          pin.focus({ preventScroll: true });
        });
        menu.append(pin); row.append(more, menu);
      }
      $('common-choices').append(row);
    }
    if (focused) $(focused)?.focus();
  }
  function moveCommon(id, index) {
    const previous = commonDraft.indexOf(id);
    if (previous < 0 || previous === index) return;
    commonDraft.splice(previous, 1); commonDraft.splice(index, 0, id);
    renderCommonSettings(); $('common-row-' + id)?.focus();
  }
  function closeCommonMenu() {
    $('common-choices').querySelector('.common-menu:popover-open')?.hidePopover();
  }
  function clearCommonDrop() {
    for (const row of $('common-choices').querySelectorAll('[data-drop]')) delete row.dataset.drop;
  }
  function endCommonDrag() {
    draggedCommon = null; clearCommonDrop();
    for (const row of $('common-choices').querySelectorAll('.is-dragging')) row.classList.remove('is-dragging');
  }
  function commonDropTarget(event) {
    const row = event.target.closest('.common-choice');
    return draggedCommon && !savingCommon && !closed && row && $('common-choices').contains(row) && row.dataset.toolId !== draggedCommon && commonDraft.includes(row.dataset.toolId) ? row : null;
  }
  $('common-choices').addEventListener('pointerdown', event => {
    const row = event.target.closest('.common-choice');
    if (row) row.draggable = !savingCommon && !closed && commonDraft.includes(row.dataset.toolId) && !event.target.closest('input, button, .common-menu');
  });
  $('common-choices').addEventListener('dragstart', event => {
    const row = event.target.closest('.common-choice');
    if (!row?.draggable || savingCommon || closed) { event.preventDefault(); return; }
    closeCommonMenu(); draggedCommon = row.dataset.toolId;
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggedCommon);
    row.classList.add('is-dragging');
  });
  $('common-choices').addEventListener('dragover', event => {
    const row = commonDropTarget(event); clearCommonDrop();
    if (!row) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect(); row.dataset.drop = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
  });
  $('common-choices').addEventListener('dragleave', event => { if (!$('common-choices').contains(event.relatedTarget)) clearCommonDrop(); });
  $('common-choices').addEventListener('drop', event => {
    const row = commonDropTarget(event);
    if (!row) { endCommonDrag(); return; }
    event.preventDefault();
    const id = draggedCommon, rect = row.getBoundingClientRect();
    const index = commonDraft.filter(value => value !== id).indexOf(row.dataset.toolId) + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
    endCommonDrag(); moveCommon(id, index);
  });
  $('common-choices').addEventListener('dragend', endCommonDrag);
  $('common-choices').addEventListener('scroll', closeCommonMenu);
  $('common-dialog').addEventListener('scroll', closeCommonMenu);
  $('common-settings').addEventListener('click', () => {
    if (savingCommon || closed) return;
    commonDraft = [...common]; renderCommonSettings(); $('common-status').textContent = ''; $('common-status').className = 'status-pending'; $('common-dialog').showModal();
    if (!commonLoaded) { $('common-status').textContent = '常用设置读取失败：' + commonLoadError; $('common-status').className = 'status-error'; }
    $('common-save').disabled = !commonLoaded;
  });
  $('common-reset').addEventListener('click', () => { commonDraft = defaultCommon.filter(id => tools.some(tool => tool.id === id)); renderCommonSettings(); });
  $('common-cancel').addEventListener('click', () => $('common-dialog').close());
  $('common-dialog').addEventListener('close', () => { closeCommonMenu(); endCommonDrag(); });
  $('common-dialog').addEventListener('cancel', event => { if (savingCommon) event.preventDefault(); });
  $('common-save').addEventListener('click', async () => {
    if (savingCommon || !commonLoaded || closed) return;
    savingCommon = true; $('common-form').disabled = true; $('common-status').textContent = '正在保存…'; $('common-status').className = 'status-pending';
    try {
      const saved = await PageAgent.data.set('developer-tools.common', commonDraft, commonVersion);
      if (closed) return;
      commonVersion = saved.version; common = [...commonDraft];
      if (category === 'common' && !common.includes(selected?.id)) {
        const tool = categoryItems('common')[0];
        if (tool) selectTool(tool); else { selected = null; cron.activate(null); views.close(); invalidateResult(); }
      }
      renderNavigation(); controls(); $('common-dialog').close(); void notify('已保存常用工具及顺序。');
    } catch (error) { $('common-status').textContent = '保存失败：' + error.message + '。请重新加载后再修改。'; $('common-status').className = 'status-error'; }
    finally { savingCommon = false; $('common-form').disabled = false; }
  });
  async function loadCatalog() {
    controls();
    if (!permitted() || loading || tools.length || closed) return;
    loading = true;
    try {
      const catalog = await request('GET', '/utilities');
      if (closed) return;
      tools = catalog.tools;
      if (!tools.length) { message('当前没有可用工具。'); return; }
      try {
        const stored = await PageAgent.data.get('developer-tools.common'); commonVersion = stored.version; commonLoaded = true;
        if (Array.isArray(stored.value)) common = [...new Set(stored.value)].filter(id => tools.some(tool => tool.id === id));
      } catch (error) { commonLoaded = false; commonLoadError = error.message; }
      if (closed) return;
      const tool = categoryItems('common')[0];
      if (tool) selectTool(tool); else { renderNavigation(); controls(); message('可在「管理常用」中选择常用工具。'); }
      renderSearch();
      void receiveLaunch();
    } finally { loading = false; }
  }
  async function receiveLaunch() {
    if (launchHandled || closed) return;
    launchHandled = true;
    const entries = tools.filter(tool => categories.some(item => item.tools?.includes(tool.id))).map(tool => ({
      id: tool.id,
      operations: views.supports(tool.id) ? views.inputOperations(tool.id) : tool.id === 'crontab' ? ['next']
        : tool.id === 'base64Image' ? ['decode'] : tool.id === 'uuid' ? ['v3', 'v5'] : tool.id === 'regex' ? ['match']
        : tool.operations.filter(value => inputKind(tool.id, value) !== 'none')
    })).filter(entry => entry.operations.length);
    try {
      await receiveToolInput(PageAgent.apps.input, entries, payload => {
        if (closed) return;
        const tool = tools.find(tool => tool.id === payload.toolId);
        if (inputKind(tool.id, payload.operation) === 'line' && /[\r\n]/.test(payload.input)) throw new Error('此工具只接收单行文本，请选择其他工具。');
        category = common.includes(tool.id) ? 'common' : categories.find(item => item.tools?.includes(tool.id)).id;
        selectTool(tool);
        if (views.supports(tool.id)) views.loadInput(payload.input, payload.operation);
        else if (tool.id === 'crontab') cron.loadInput(payload.input);
        else {
          selectOperation(payload.operation);
          if (tool.id === 'qrCode' && operation === 'parse') { fields.get('inputEncoding').control.value = 'base64'; updateForm(); }
          primary().value = tool.id === 'qrCode' && operation === 'parse' ? payload.input.replace(/^data:image\/[^;,]+;base64,/i, '') : payload.input;
          if (tool.id === 'diffs') diffContainer.querySelector('page-code-editor').setAttribute('data-original', payload.input);
          invalidateResult(); scheduleAuto();
        }
        message('已接收内容。');
      });
    } catch (error) { if (!closed) message('无法接收内容：' + error.message, true); }
  }
  try {
    await PageAgent.ready;
    await PageAgent.ui.load('code-editor');
    icons = await PageAgent.ui.load('icons');
    await loadCatalog();
    PageAgent.onChange(event => {
      if (['disconnected', 'deleted', 'imported'].includes(event.change)) { closed = true; cron.close(); views.close(); invalidateResult(); controls(); message('应用连接或内容已变化，请重新加载页面。', true); }
      if (['state', 'permissions'].includes(event.change)) {
        if (!permitted()) invalidateResult();
        loadCatalog().then(() => { if (!hasResult) scheduleAuto(); if (permitted()) views.refresh(); }).catch(error => message(error.message, true));
      }
    });
  } catch (error) { message(error.message, true); }
  window.addEventListener('pagehide', () => { closed = true; cron.close(); views.close(); optionResize.disconnect(); clearTimeout(autoTimer); revision++; clearPreview(); });
}
