import { createEntries, visibleFields, sampleFor, layoutFor } from './tools.js';
import { iconFor } from './icons.js';
import { renderToolPreview, renderFieldsPreview, createRadixFields, createRegexEditor } from './views.js';
import { receiveToolInput } from './tool-input.js';
import { notify } from './feedback.js';
import '/utilities/catalog.js';

let parameterReceiver;
export async function applyParameters(input) {
  if (!parameterReceiver) throw new Error('工具编辑器尚未就绪，无法应用启动参数。');
  await parameterReceiver(input);
}

const labels = {
  digest: '计算摘要', encrypt: '加密', decrypt: '解密', keypair: '生成密钥对', sign: '签名', verify: '验证', hash: '生成哈希', checksum: '计算校验码',
  encode: '编码', decode: '解码', format: '格式化 / 校验', minify: '压缩', sort: '排序', escape: '转义', unescape: '反转义', repair: '修复',
  jsonpath: 'JSONPath 查询', jmespath: 'JMESPath 查询', schema: 'Schema 校验', toCode: '生成类型代码', convert: '转换',
  lines: '按行比较', words: '按词比较', characters: '按字符比较', match: '匹配', replace: '替换', split: '拆分', statistics: '统计',
  dedupe: '去重', reverse: '反转', trim: '去首尾空格', upper: '大写', lower: '小写', removeEmpty: '移除空行', table: '码表',
  timestamp: '时间戳 ↔ 日期', timezone: '转换时区', add: '时间增减', difference: '时间差', now: '当前时间', describe: '解释表达式', next: '后续执行时间',
  validate: '校验', generate: '生成', parse: '解析', fill: '填充参数', money: '金额大写', preview: '预览',
  camel: 'camelCase', pascal: 'PascalCase', snake: 'snake_case', kebab: 'kebab-case', constant: 'CONSTANT_CASE', dot: 'dot.case', path: 'path/case', title: 'Title Case', sentence: 'Sentence case', train: 'Train-Case', swap: '大小写互换'
};
const resultLabels = { iso: 'ISO 8601', timestamp: '时间戳', zone: '时区', formatted: '当地时间', characters: 'Unicode 字符', utf16Units: 'UTF-16 单元', utf8Bytes: 'UTF-8 字节', lines: '行数', words: '词数', header: 'Header', payload: 'Payload', signature: '签名片段', signatureVerified: '已验证签名', valid: '有效', version: '版本', random: '随机部分' };
const textValue = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export async function mountDeveloperUtils() {
  const $ = id => document.getElementById(id);
  $('search').before(iconFor('search'));
  $('empty-result')?.remove();
  const entries = createEntries(globalThis.OfflineToolCatalog.tools);
  let selected = null, fields = new Map(), values = {}, result = null;
  let busy = false, loading = false, revision = 0, previewUrl = null, markdownView = null, editorReady = false, closed = false;
  let editorError = '';
  let automaticTimer = null, pending = false, generatedText = '', qrReadInput = '', hashFile = null;
  const actionBar = $('operation').parentElement;
  $('subtitle')?.remove();
  document.querySelector('.tool-description')?.remove();
  $('about').querySelectorAll('p')[1].textContent = '转换和检查工具会随输入自动更新，生成工具使用生成按钮。输入仅保留在当前页面，不自动读取剪贴板；切换工具会重置输入，Unix 时间转换默认显示当前时间。';
  const operationButtons = document.createElement('div'); operationButtons.className = 'operation-buttons';
  actionBar.append(operationButtons);
  const compactInput = document.createElement('input'); compactInput.id = 'compact-input'; compactInput.type = 'text';
  compactInput.autocomplete = 'off'; compactInput.spellcheck = false; compactInput.maxLength = 65536; compactInput.setAttribute('aria-label', '工具输入');
  $('input').before(compactInput);
  const colorFields = document.createElement('div'); colorFields.className = 'color-fields'; $('input').before(colorFields);
  const colorPicker = document.createElement('input'); colorPicker.type = 'color'; colorPicker.setAttribute('aria-label', '选择颜色'); colorPicker.className = 'color-picker';
  $('input-panel').querySelector('.panel-bar').append(colorPicker);
  const colorInputRow = document.createElement('div'); colorInputRow.className = 'color-input-row'; compactInput.before(colorInputRow);
  colorPicker.addEventListener('input', () => { setInput(colorPicker.value); invalidate(); });
  const nowButton = document.createElement('button'); nowButton.type = 'button'; nowButton.textContent = '现在';
  $('paste').before(nowButton);
  const copyCompact = document.createElement('button'); copyCompact.type = 'button'; copyCompact.textContent = '复制输入'; copyCompact.addEventListener('click', () => copy(getInput(), '已复制输入。')); $('paste').before(copyCompact);
  nowButton.addEventListener('click', () => { values.unit = 'seconds'; setInput(String(Math.floor(Date.now() / 1000))); renderFields(); invalidate(); });
  const timeSettings = document.createElement('div'); timeSettings.id = 'time-settings'; timeSettings.className = 'time-settings'; timeSettings.popover = 'auto';
  timeSettings.setAttribute('aria-label', '时区设置'); $('input-panel').append(timeSettings);
  const timeSettingsButton = document.createElement('button'); timeSettingsButton.id = 'time-settings-button'; timeSettingsButton.type = 'button';
  timeSettingsButton.title = '时区设置'; timeSettingsButton.setAttribute('aria-label', '时区设置'); timeSettingsButton.popoverTargetElement = timeSettings;
  timeSettingsButton.append(iconFor('settings')); $('clear').after(timeSettingsButton);
  timeSettings.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const bounds = timeSettingsButton.getBoundingClientRect();
    timeSettings.style.left = Math.max(16, Math.min(bounds.left, window.innerWidth - 336)) + 'px';
    timeSettings.style.top = bounds.bottom + 6 + 'px';
  });
  compactInput.addEventListener('input', () => invalidate());
  const cronExamples = document.createElement('select'); cronExamples.setAttribute('aria-label', 'Cron 示例');
  cronExamples.append(new Option('选择常用表达式…', ''), ...[['每 5 分钟', '*/5 * * * *'], ['每小时', '0 * * * *'], ['每天零点', '0 0 * * *'], ['工作日早上 9 点', '0 9 * * 1-5'], ['每月 1 日', '0 0 1 * *']].map(([label, value]) => new Option(label, value)));
  $('input-panel').querySelector('.panel-bar').append(cronExamples);
  cronExamples.addEventListener('change', () => { if (cronExamples.value) { setInput(cronExamples.value); invalidate(); } });
  const inspectInput = document.createElement('textarea'); inspectInput.className = 'inspect-input'; inspectInput.hidden = true; inspectInput.maxLength = 65536; inspectInput.spellcheck = false; inspectInput.setAttribute('aria-label', '检查字符串'); $('input').before(inspectInput);
  const regexInput = createRegexEditor($('input'), () => invalidate());
  for (const event of ['input', 'select', 'keyup', 'click']) inspectInput.addEventListener(event, () => {
    values.selectionStart = inspectInput.selectionStart; values.selectionEnd = inspectInput.selectionEnd; invalidate();
  });
  const idInspector = document.createElement('section'); idInspector.className = 'id-inspector'; idInspector.hidden = true;
  const idInput = document.createElement('input'); idInput.type = 'text'; idInput.placeholder = '粘贴 UUID / ULID 查看字段'; idInput.setAttribute('aria-label', '解码 UUID / ULID');
  const idDetails = document.createElement('div'); idInspector.append(idInput, idDetails); $('input').before(idInspector);
  const radixPanel = document.createElement('div'); radixPanel.className = 'radix-fields'; radixPanel.hidden = true; $('input').before(radixPanel);
  const radixFields = createRadixFields(radixPanel, copy, (value, from) => { values.from = from; setInput(value, true); invalidate(); }, async apply => {
    const current = revision;
    try { const value = await navigator.clipboard.readText(); if (value.length > 4096) throw new Error('数值最多 4096 个字符'); if (current === revision) apply(value); }
    catch (error) { if (current === revision) message('无法粘贴：' + error.message, true); }
  });
  const imageTextActions = document.createElement('div'); imageTextActions.className = 'image-text-actions';
  const imageFormat = document.createElement('select'); imageFormat.setAttribute('aria-label', '图片文本格式');
  imageFormat.append(new Option('Raw String', 'raw'), new Option('Data URL', 'dataUrl'), new Option('CSS Attribute', 'css')); imageFormat.value = 'dataUrl';
  imageFormat.addEventListener('change', async () => {
    const current = ++revision, dataUrl = result?.value;
    if (selected?.tool !== 'base64Image' || typeof dataUrl !== 'string') return;
    try {
      const data = await request('POST', selected.contract.operationUris.encode, { input: dataUrl, options: { representation: imageFormat.value } });
      if (current === revision) { setInput(data.value); invalidate(); }
    } catch (error) { if (current === revision) message(error.message, true); }
  });
  const copyImageText = document.createElement('button'); copyImageText.type = 'button'; copyImageText.textContent = '复制文本'; copyImageText.addEventListener('click', () => copy(getInput(), '已复制图片文本。'));
  imageTextActions.append(imageFormat, copyImageText); $('input-panel').querySelector('.panel-bar').append(imageTextActions);
  const pasteImage = document.createElement('button'); pasteImage.type = 'button'; pasteImage.textContent = '粘贴图片';
  pasteImage.addEventListener('click', async () => {
    const current = revision, qr = selected.tool === 'qrCode';
    try {
      const items = await navigator.clipboard.read(), item = items.find(item => item.types.includes('image/png'));
      if (!item) throw new Error('剪贴板没有 PNG 图片');
      const blob = await item.getType('image/png');
      if (blob.size > 32768) throw new Error('图片最多 32 KiB');
      const value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
      if (current === revision) {
        if (qr) { $('operation').value = 'parse'; renderFields(); updateLayout(); updateLanguage(); renderActions(); }
        setInput(value); imageFormat.value = 'dataUrl'; invalidate();
      }
    } catch (error) { if (current === revision) message('无法粘贴图片：' + error.message, true); }
  });
  $('output-panel').querySelector('.panel-actions').prepend(pasteImage);
  const qrTemplates = document.createElement('select'); qrTemplates.setAttribute('aria-label', '二维码内容模板');
  qrTemplates.append(new Option('选择模板…', ''), new Option('URL', 'url'), new Option('vCard', 'vcard'), new Option('Wi-Fi', 'wifi')); $('input-panel').querySelector('.panel-bar').append(qrTemplates);
  qrTemplates.addEventListener('change', () => {
    if (!qrTemplates.value) return;
    $('operation').value = 'generate'; qrReadInput = '';
    setInput({ url: 'https://example.com', vcard: 'BEGIN:VCARD\nVERSION:3.0\nN:Smith;Alex;;;\nFN:Alex Smith\nEMAIL:alex@example.com\nTEL:+1-555-0100\nEND:VCARD', wifi: 'WIFI:T:WPA;S:Example Network;P:example-password;;' }[qrTemplates.value]);
    renderFields(); updateLayout(); updateLanguage(); renderActions(); invalidate();
  });
  const clearOutput = document.createElement('button'); clearOutput.type = 'button'; clearOutput.textContent = '清空';
  clearOutput.addEventListener('click', () => {
    if (selected.tool === 'base64Image') setInput('');
    generatedText = ''; invalidate('已清空结果。'); clearTimeout(automaticTimer); pending = false;
  });
  $('output-panel').querySelector('.panel-actions').append(clearOutput);
  const htmlFormat = document.createElement('select'); htmlFormat.className = 'panel-format'; htmlFormat.setAttribute('aria-label', '整理 HTML');
  htmlFormat.append(new Option('格式化…', ''), new Option('格式化 HTML', 'format'), new Option('压缩 HTML', 'minify')); $('input-panel').querySelector('.panel-bar').append(htmlFormat);
  htmlFormat.addEventListener('change', async () => {
    if (!htmlFormat.value) return;
    const current = ++revision, operation = htmlFormat.value;
    try {
      const data = await request('POST', '/utilities/code/' + operation, { input: getInput(), options: { language: 'html' } });
      if (current === revision) { setInput(data.value); invalidate(); }
    } catch (error) { if (current === revision) message(error.message, true); }
    finally { htmlFormat.value = ''; }
  });
  const reloadPreview = document.createElement('button'); reloadPreview.type = 'button'; reloadPreview.textContent = '刷新'; reloadPreview.addEventListener('click', run); $('output-panel').querySelector('.panel-actions').append(reloadPreview);
  const openPreview = document.createElement('button'); openPreview.type = 'button'; openPreview.textContent = '新标签页打开'; openPreview.addEventListener('click', () => { try { download(true); } catch (error) { message(error.message, true); } }); $('output-panel').querySelector('.panel-actions').append(openPreview);
  const codeFiles = document.createElement('select'); codeFiles.setAttribute('aria-label', '生成的代码文件'); codeFiles.hidden = true; $('output-panel').querySelector('.panel-bar').append(codeFiles);
  codeFiles.addEventListener('change', () => {
    if (result?.entry.id !== 'quicktype' || !result.value.files) return;
    result.text = result.value.files[codeFiles.value]; $('output').value = result.text; $('output-count').textContent = result.text.length.toLocaleString() + ' 字符';
  });
  const comparisonActions = document.createElement('div'); comparisonActions.className = 'panel-actions';
  for (const [label, action] of [['粘贴', async () => {
    const current = revision;
    try { const value = await navigator.clipboard.readText(); if (value.length > 65536) throw new Error('剪贴板文本超过 65536 字符'); if (current === revision) { $('other').value = value; invalidate(); } }
    catch (error) { if (current === revision) message('无法粘贴：' + error.message, true); }
  }], ['清空', () => { $('other').value = ''; invalidate(); }]]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); comparisonActions.append(button);
  }
  $('swap-inputs').before(comparisonActions); comparisonActions.append($('swap-inputs'));
  const comparisonFooter = $('input-count').parentElement.cloneNode(true);
  const comparisonCount = comparisonFooter.querySelector('#input-count'); comparisonCount.id = 'other-count';
  $('comparison').append(comparisonFooter);
  const outputSecondaryActions = document.createElement('div'); outputSecondaryActions.className = 'panel-actions';
  outputSecondaryActions.append($('use-output'), $('download'));
  $('output-panel').querySelector('.panel-footer').append(outputSecondaryActions);
  $('output-panel').querySelector('.panel-bar').append($('result-tabs'));
  const codeSettings = document.createElement('aside'); codeSettings.id = 'code-settings'; codeSettings.className = 'editor-panel'; codeSettings.hidden = true;
  const codeSettingsBar = document.createElement('div'); codeSettingsBar.className = 'panel-bar';
  const codeSettingsHeading = document.createElement('h2'); codeSettingsHeading.id = 'code-settings-heading'; codeSettingsHeading.textContent = '生成选项';
  codeSettings.setAttribute('aria-labelledby', codeSettingsHeading.id);
  codeSettingsBar.append(codeSettingsHeading); codeSettings.append(codeSettingsBar); $('editors').append(codeSettings);
  const panelSections = [];
  for (const panel of document.querySelectorAll('.editor-panel')) {
    for (const [name, selector] of [['header', '.panel-bar'], ['status', '.panel-footer']]) {
      const content = panel.querySelector(selector);
      if (!content) continue;
      const frame = document.createElement('div'); frame.className = 'panel-' + name;
      content.before(frame); frame.append(content); panelSections.push({ panel, name, content, frame });
    }
  }
  let panelLayoutFrame = 0;
  // Measure the natural contents, so shared row heights can also shrink after a tool change.
  const panelObserver = new ResizeObserver(() => {
    if (panelLayoutFrame) return;
    panelLayoutFrame = requestAnimationFrame(() => {
      panelLayoutFrame = 0;
      const rows = new Map();
      for (const section of panelSections) {
        if (!section.content.getClientRects().length) continue;
        const key = section.panel.offsetTop + ':' + section.name;
        if (!rows.has(key)) rows.set(key, { height: 0, sections: [] });
        const row = rows.get(key);
        row.height = Math.max(row.height, Math.ceil(section.content.getBoundingClientRect().height) + 1);
        row.sections.push(section);
      }
      for (const { height, sections } of rows.values()) {
        for (const { frame } of sections) frame.style.minHeight = height + 'px';
      }
    });
  });
  for (const { content } of panelSections) panelObserver.observe(content);
  panelObserver.observe($('editors'));
  let idRevision = 0, idTimer;
  idInput.addEventListener('input', () => {
    const current = ++idRevision; clearTimeout(idTimer); idDetails.replaceChildren();
    if (!idInput.value.trim() || !permitted() || closed) return;
    idTimer = setTimeout(async () => {
      try {
        const data = await request('POST', '/utilities/uuid/inspect', { input: idInput.value, options: {} });
        if (current === idRevision && selected.id === 'uuidtool' && !closed) renderFieldsPreview(idDetails, [Object.entries(data.value)], copy);
      } catch (error) { if (current === idRevision) idDetails.textContent = error.message; }
    }, 260);
  });
  document.querySelector('.action-hint').textContent = '输入后自动更新';
  const automatic = () => selected && !['uuid', 'loremIpsum'].includes(selected.tool);
  const getInput = () => selected?.id === 'hashing' && hashFile ? hashFile.content : selected?.tool === 'qrCode' && $('operation').value === 'parse' ? qrReadInput : selected?.id === 'regextester' ? regexInput.value : selected?.id === 'stringinspect' ? inspectInput.value : ['compact', 'color'].includes($('editors').dataset.layout) ? compactInput.value : $('input').value || '';
  function setInput(value, fromRadix = false) {
    if (selected?.id === 'hashing') { hashFile = null; values.inputEncoding = 'utf8'; }
    if (selected?.id === 'numberbase' && !fromRadix) { values.from = 10; radixFields.clear(); }
    if (selected?.id === 'uuidtool' && !['v3', 'v5'].includes($('operation').value)) { idInput.value = value; idInput.dispatchEvent(new Event('input')); }
    if (selected?.tool === 'qrCode' && $('operation').value === 'parse') qrReadInput = value;
    compactInput.value = value; inspectInput.value = value; regexInput.value = value; if (editorReady) $('input').value = value;
  }
  function schedule() {
    clearTimeout(automaticTimer); pending = false;
    if (!automatic() || !editorReady || closed || !selected.local && !permitted() || !getInput() && !['randomRecipe', 'hash', 'stringInspect', 'diffs'].includes(selected.tool)) return;
    automaticTimer = setTimeout(() => { if (busy) pending = true; else run(); }, 260);
  }
  const availability = document.createElement('span');
  $('grant').replaceChildren(availability, $('permissions'), $('retry'));

  function message(text, error = false) {
    $('status').textContent = text;
    $('status').classList.toggle('error', error);
  }
  function permitted() {
    const permissions = PageAgent.state?.permissions;
    return permissions?.enabled && permissions.resources.includes('utilities.execute');
  }
  function controls() {
    const unavailable = !selected || !editorReady || closed;
    const readingQr = selected?.tool === 'qrCode' && $('operation').value === 'parse';
    $('grant').hidden = !!permitted() && !editorError;
    availability.textContent = editorError || '工具执行权限已关闭，请在应用权限中开启 SDK 和 utilities.execute。';
    $('permissions').hidden = !!permitted();
    $('permissions').href = PageAgent.state?.links?.permissions || '/options/options.html?section=apps';
    $('run').disabled = unavailable || busy || !selected.local && !permitted();
    for (const id of ['paste', 'open-file', 'clear', 'operation', 'swap-inputs']) $(id).disabled = unavailable;
    $('sample').disabled = unavailable || sampleFor(selected, $('operation').value) === null;
    $('copy-node').disabled = unavailable || busy || !selected.contract;
    for (const id of ['copy', 'download', 'use-output']) $(id).disabled = unavailable || result === null || busy;
    $('use-output').hidden = $('editors').dataset.layout === 'generator' || ['unixtime', 'colortools'].includes(selected?.id) || ['qrCode', 'base64Image'].includes(selected?.tool);
    $('download').hidden = selected?.id === 'unixtime';
    $('input').toggleAttribute('disabled', unavailable);
    $('input').toggleAttribute('readonly', selected?.id === 'hashing' && hashFile !== null);
    $('other').toggleAttribute('disabled', unavailable);
    compactInput.disabled = unavailable; nowButton.disabled = timeSettingsButton.disabled = unavailable;
    copyCompact.disabled = idInput.disabled = unavailable;
    inspectInput.disabled = regexInput.disabled = unavailable;
    for (const button of operationButtons.children) button.disabled = unavailable || !selected.local && !permitted();
    for (const [key, { control, imageActions }] of fields) {
      const inapplicable = readingQr || selected?.id === 'jsonformatter' && (
        key === 'indent' && !['format', 'sort'].includes($('operation').value) ||
        key === 'expression' && $('operation').value === 'repair');
      control.disabled = closed || inapplicable;
      if (imageActions) {
        imageActions.choose.disabled = imageActions.file.disabled = unavailable || readingQr;
        imageActions.remove.disabled = unavailable || readingQr || !control.value;
      }
    }
    for (const id of ['text-tab', 'preview-tab']) $(id).disabled = unavailable || selected?.tool === 'qrCode' && result === null;
    imageFormat.disabled = unavailable || busy || result === null; copyImageText.disabled = pasteImage.disabled = unavailable;
    clearOutput.disabled = unavailable;
    qrTemplates.disabled = unavailable || readingQr;
    htmlFormat.disabled = unavailable || !permitted(); reloadPreview.disabled = unavailable || busy;
    openPreview.disabled = unavailable || busy || result === null;
    codeFiles.disabled = unavailable || busy || result === null;
    $('retry').disabled = loading;
  }
  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (markdownView) { markdownView.destroy(); markdownView = null; }
    $('preview').replaceChildren();
    const unixTime = selected?.id === 'unixtime';
    $('preview').hidden = !unixTime;
    $('result-tabs').hidden = selected?.tool !== 'qrCode';
    $('output').hidden = unixTime;
    if (selected?.tool === 'qrCode') showPreview(false);
    if (unixTime) renderToolPreview($('preview'), selected, { options: values }, null, copy);
    if (selected?.tool === 'diffs' && !getInput() && !$('other').value) {
      renderToolPreview($('preview'), selected, null, [], copy);
      $('result-tabs').hidden = false;
      showPreview(true);
    }
  }
  function invalidate(status = '', preserveDiff = true) {
    revision++;
    const keepDiff = preserveDiff && selected?.tool === 'diffs' && !closed && permitted() && (getInput() || $('other').value) && $('preview').querySelector('.inline-diff');
    result = null;
    codeFiles.hidden = true;
    if (!keepDiff) clearPreview();
    colorFields.replaceChildren();
    regexInput.clear();
    if (editorReady && !keepDiff) $('output').value = '';
    $('output-count').textContent = keepDiff ? '等待比较…' : '等待输入';
    $('input-count').textContent = selected?.id === 'hashing' && hashFile ? hashFile.size.toLocaleString() + ' 字节' : getInput().length.toLocaleString() + ' 字符';
    comparisonCount.textContent = ($('other').value || '').length.toLocaleString() + ' 字符';
    $('result-kind').textContent = '本地处理';
    controls();
    if (status) message(status);
    schedule();
  }
  async function request(method, uri, body) {
    const input = { uri };
    if (body !== undefined) { input.body = body; input.idempotencyKey = crypto.randomUUID(); }
    const response = await PageAgent.resources.request(method, input);
    if (response.error) throw new Error(response.error.message || response.error.code);
    if (!response.primary) throw new Error('未收到工具响应');
    return response.primary.data;
  }
  function renderNavigation() {
    const query = $('search').value.trim().toLowerCase(), category = $('category').value;
    const matched = entries.filter(entry => (!category || entry.group === category) && (entry.title + ' ' + entry.english + ' ' + entry.group + ' ' + entry.tool + ' ' + entry.description).toLowerCase().includes(query));
    const scroll = $('tools').scrollTop, fragment = document.createDocumentFragment();
    for (const entry of matched) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tool-link'; button.title = entry.title;
      if (selected?.id === entry.id) button.setAttribute('aria-current', 'page');
      const icon = document.createElement('span'); icon.className = 'nav-icon'; icon.append(iconFor(entry)); icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'nav-label'; label.textContent = entry.title;
      button.append(icon, label); button.addEventListener('click', () => { if (selected?.id !== entry.id) selectTool(entry); }); fragment.append(button);
    }
    if (!matched.length) { const empty = document.createElement('p'); empty.className = 'nav-empty'; empty.textContent = '没有匹配的工具，试试英文名或其他分类。'; fragment.append(empty); }
    $('tools').replaceChildren(fragment); $('tools').scrollTop = scroll;
    $('tool-count').textContent = matched.length === entries.length ? entries.length + ' 个工具入口' : matched.length + ' / ' + entries.length + ' 个工具入口';
  }
  function selectTool(entry) {
    idRevision++; clearTimeout(idTimer); idInput.value = ''; idDetails.replaceChildren();
    radixFields.clear();
    generatedText = ''; qrReadInput = ''; hashFile = null;
    selected = entry;
    values = Object.fromEntries(Object.entries(entry.contract?.fields || {}).map(([key, spec]) => [key, spec.default]));
    Object.assign(values, entry.defaults);
    if (entry.id === 'numberbase') radixFields.setBase(values.to);
    if (entry.id === 'unixtime') values.zone = values.sourceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (entry.id === 'cronparser') values.zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    $('title').textContent = entry.title;
    $('operation').replaceChildren(...entry.operations.map(value => new Option(value === 'words' && entry.tool === 'variableConversion' ? '空格分词' : value === 'format' && entry.tool !== 'json' ? '格式化' : labels[value] || value, value)));
    $('operation').value = entry.operation || entry.operations[0];
    // Setting value before registration would shadow the custom editor's setter.
    setInput(entry.id === 'unixtime' ? String(Math.floor(Date.now() / 1000)) : ''); if (editorReady) $('other').value = '';
    $('file').value = '';
    $('input-heading').textContent = entry.tool === 'diffs' ? '原始文本' : '输入';
    renderFields(); updateLayout(); updateLanguage(); renderNavigation(); renderActions();
    document.querySelector('.workspace').scrollTop = 0;
    invalidate(editorError || (editorReady ? entry.id === 'unixtime' ? '已填入当前时间。' : '就绪 · 输入内容或载入示例。' : '工具目录已就绪，正在加载编辑器…'), false);
  }
  function updateLayout() {
    const layout = layoutFor(selected);
    $('editors').dataset.layout = layout;
    codeSettings.hidden = selected.id !== 'quicktype';
    idInspector.hidden = layout !== 'ids';
    radixPanel.hidden = layout !== 'radix';
    inspectInput.hidden = selected.id !== 'stringinspect';
    regexInput.hidden = selected.id !== 'regextester';
    $('editors').dataset.namedId = String(['v3', 'v5'].includes($('operation').value));
    $('editors').dataset.tool = selected.id;
    $('input-heading').textContent = selected.tool === 'base64Image' ? 'Base64 / Data URL' : selected.tool === 'diffs' ? '原始文本' : '输入';
    $('output-panel').querySelector('h2').textContent = selected.tool === 'base64Image' ? '图片' : selected.local ? '预览' : '结果';
    imageTextActions.hidden = selected.tool !== 'base64Image'; pasteImage.hidden = !['base64Image', 'qrCode'].includes(selected.tool);
    qrTemplates.hidden = selected.tool !== 'qrCode'; qrTemplates.value = '';
    clearOutput.hidden = !['uuidtool', 'loremipsum', 'randomstringgenerator', 'base64image'].includes(selected.id);
    htmlFormat.hidden = reloadPreview.hidden = selected.local !== 'html';
    openPreview.hidden = selected.local !== 'html' && selected.tool !== 'markdown';
    $('copy').textContent = selected.tool === 'base64Image' || selected.tool === 'qrCode' && $('operation').value === 'generate' ? '复制图片' : '复制';
    if (selected.tool === 'base64Image') $('output-panel').querySelector('.panel-actions').prepend($('open-file'));
    else $('sample').after($('open-file'));
    compactInput.hidden = !['compact', 'color'].includes(layout); nowButton.hidden = selected.id !== 'unixtime';
    colorInputRow.hidden = layout !== 'color';
    if (layout === 'color') colorInputRow.append(compactInput, colorPicker);
    else { colorInputRow.before(compactInput); $('input-panel').querySelector('.panel-bar').append(colorPicker); }
    copyCompact.hidden = layout !== 'compact' || selected.id === 'unixtime';
    $('sample').hidden = $('open-file').hidden = selected.id === 'unixtime';
    timeSettingsButton.hidden = selected.id !== 'unixtime';
    if (timeSettings.matches(':popover-open')) timeSettings.hidePopover();
    colorFields.hidden = colorPicker.hidden = layout !== 'color';
    cronExamples.hidden = selected.id !== 'cronparser'; cronExamples.value = '';
    $('comparison').hidden = layout !== 'diff';
    if (layout === 'generator') $('input-panel').prepend($('options'));
    else if (selected.id === 'quicktype') codeSettings.append($('options'));
    else if (layout === 'color') colorFields.before($('options'));
    else if (layout === 'compact') $('input-panel').append($('options'));
    else $('input-panel').querySelector('.panel-status').before($('options'));
  }
  function renderActions() {
    actionBar.append($('operation'), operationButtons);
    $('operation').hidden = true; actionBar.querySelector('label').hidden = true;
    $('run').hidden = true;
    document.querySelector('.action-hint').hidden = !automatic();
    operationButtons.replaceChildren();
    if (['jsonformatter', 'stringcaseconverter', 'curl2code'].includes(selected.id) || selected.tool === 'code' && selected.operations.length > 1) {
      $('operation').hidden = false; $('operation').setAttribute('aria-label', '输出格式');
      if (selected.id === 'curl2code') for (const option of $('operation').options) option.textContent = { fetch: 'JavaScript / Fetch', python: 'Python / Requests', go: 'Go', java: 'Java' }[option.value];
      $('output-panel').querySelector('.panel-bar').append($('operation')); actionBar.hidden = true; return;
    }
    if (selected.tool === 'randomRecipe') {
      const presets = document.createElement('select'); presets.setAttribute('aria-label', '随机字符串预设');
      presets.append(new Option('选择预设…', ''), new Option('字母数字', 'mixed'), new Option('数字验证码', 'digits'), new Option('单词短语', 'words'));
      presets.addEventListener('change', () => {
        if (!presets.value) return; fieldValues();
        Object.assign(values, { upper: 0, lower: 0, digits: 0, words: 0, symbols: 0, custom: 0, groupSize: 0, separator: '' }, { mixed: { upper: 8, lower: 8, digits: 4 }, digits: { digits: 6 }, words: { words: 4, separator: '-' } }[presets.value]);
        renderFields(); invalidate();
      });
      const generate = document.createElement('button'); generate.type = 'button'; generate.textContent = '重新生成'; generate.addEventListener('click', run);
      operationButtons.append(presets, generate); $('input-panel').prepend(operationButtons); actionBar.hidden = true; return;
    }
    if (selected.tool === 'loremIpsum') {
      const names = ['段落', '句子', '单词', '标题', '名', '姓', '姓名', 'Email', 'URL', '短文本', '长文本'];
      selected.contract.fields.unit.enum.forEach((unit, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = names[index];
        button.addEventListener('click', () => { values.unit = unit; if (!busy) run(); }); operationButtons.append(button);
      });
      $('input-panel').append(operationButtons); actionBar.hidden = true; return;
    }
    if (selected.id === 'uuidtool') {
      const version = document.createElement('select'); version.setAttribute('aria-label', 'ID 类型');
      version.append(...selected.operations.map(op => new Option(op === 'ulid' ? 'ULID' : op === 'nanoId' ? 'Nano ID' : 'UUID ' + op, op))); version.value = $('operation').value;
      version.addEventListener('change', () => { fieldValues(); $('operation').value = version.value; renderFields(); updateLayout(); invalidate(); });
      const generate = document.createElement('button'); generate.type = 'button'; generate.textContent = '生成'; generate.addEventListener('click', run);
      operationButtons.append(version, generate); $('output-panel').querySelector('.panel-bar').prepend(operationButtons); actionBar.hidden = true; return;
    }
    if (selected.operations.length > 1 || !automatic()) {
      for (const operation of selected.operations) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = selected.tool === 'qrCode' ? operation === 'parse' ? '读取二维码图片' : '生成二维码' : labels[operation] || operation.toUpperCase(); button.setAttribute('aria-pressed', String(operation === $('operation').value));
        button.addEventListener('click', () => {
          fieldValues(); $('operation').value = operation; renderFields(); updateLayout(); updateLanguage(); renderActions(); invalidate();
          if (selected.tool === 'qrCode' && operation === 'parse') { $('file').click(); return; }
          clearTimeout(automaticTimer); if (busy) pending = true; else run();
        });
        operationButtons.append(button);
      }
    }
    actionBar.hidden = !operationButtons.childNodes.length;
    if (selected.operations.length <= 3 && automatic() && operationButtons.childNodes.length) {
      $(selected.tool === 'diffs' ? 'output-panel' : 'input-panel').querySelector('.panel-bar').append(operationButtons); actionBar.hidden = true;
    }
  }
  function fieldValues() {
    for (const [key, { control, spec }] of fields) values[key] = spec.type === 'boolean' ? selected.id === 'hashing' && key === 'uppercase' ? !control.checked : control.checked : spec.type === 'integer' ? (control.value === '' ? '' : Number(control.value)) : control.value;
    if (selected?.tool === 'diffs') values.other = $('other').value;
    return values;
  }
  function renderFields() {
    for (const { control } of fields.values()) control.closest('label').remove();
    fields = new Map(); $('options').replaceChildren(); $('options').dataset.tool = selected.id;
    for (const key of visibleFields(selected, $('operation').value, values)) {
      const spec = selected.contract.fields[key], label = document.createElement('label'), caption = document.createElement('span');
      label.className = 'option-field'; caption.textContent = spec.title; label.append(caption);
      const multiline = !spec.enum && (['schema', 'parameters', 'key', 'signature'].includes(key) || selected.id === 'jsonformatter' && key === 'expression');
      const control = document.createElement(spec.enum ? 'select' : multiline ? 'textarea' : 'input');
      control.id = 'option-' + key;
      label.dataset.field = key;
      if (spec.enum) control.append(...spec.enum.map(value => new Option(String(value), value)));
      else if (spec.type === 'boolean') control.type = 'checkbox';
      else if (spec.type === 'integer') { control.type = 'number'; control.min = spec.minimum; control.max = spec.maximum; control.step = '1'; }
      else { if (!multiline) control.type = 'text'; control.maxLength = 65536; control.spellcheck = false; control.autocomplete = 'off'; }
      if (spec.type === 'boolean') control.checked = values[key]; else control.value = values[key];
      if (selected.id === 'unixtime' && key === 'unit') {
        caption.className = 'sr-only';
        for (const option of control.options) option.textContent = { auto: '自动识别时间戳单位', seconds: 'Unix 时间戳（秒）', milliseconds: 'Unix 时间戳（毫秒）', nanoseconds: 'Unix 时间戳（纳秒）' }[option.value];
      }
      if (selected.id === 'hashing' && key === 'uppercase') { caption.textContent = '小写'; control.checked = !values[key]; }
      if (key === 'sortMode') for (const option of control.options) option.textContent = { original: '原始顺序', textAsc: '文本升序', textDesc: '文本降序', numericAsc: '数值升序', numericDesc: '数值降序' }[option.value];
      if (key === 'duplicates') for (const option of control.options) option.textContent = option.value === 'keep' ? '保留重复行' : '移除重复行';
      control.addEventListener('input', () => {
        fieldValues();
        if (['uuidtool', 'loremipsum'].includes(selected.id)) { revision++; message('参数已更新，下次生成时生效。'); }
        else invalidate();
        updateLanguage();
      });
      if (selected.id === 'numberbase' && key === 'to') control.addEventListener('input', () => radixFields.setBase(values.to));
      if (selected.id === 'unixtime' && key === 'zone') control.addEventListener('input', () => { values.sourceZone = values.zone; });
      if (['mode', 'language', 'plainTypes', 'declaration'].includes(key)) control.addEventListener('change', () => { fieldValues(); renderFields(); controls(); });
      label.append(control); $('options').append(label); fields.set(key, { control, spec });
      if (selected.id === 'quicktype' && spec.type === 'boolean') label.prepend(control);
      if (selected.id === 'numberbase' && key === 'to') {
        caption.textContent = '自定义进制（' + spec.minimum + '–' + spec.maximum + '）';
        radixFields.customField.prepend(label);
      }
      if (selected.id === 'unixtime' && key === 'zone') { caption.textContent = '时区'; timeSettings.append(label); }
      if (selected.tool === 'randomRecipe' && key === 'seed') {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '更新种子';
        button.addEventListener('click', () => { control.value = crypto.randomUUID(); fieldValues(); invalidate(); });
        const row = document.createElement('div'); row.className = 'option-row'; row.append(control, button); label.append(row);
      }
      if (selected.tool === 'randomRecipe' && ['upper', 'lower', 'symbols', 'digits', 'words', 'groupSize', 'custom'].includes(key)) {
        if (key === 'groupSize') { caption.textContent = '每组字符数'; control.title = spec.title; }
        const range = document.createElement('input'); range.type = 'range'; range.min = spec.minimum; range.max = spec.maximum; range.value = values[key]; range.setAttribute('aria-label', spec.title);
        range.addEventListener('input', () => { control.value = range.value; fieldValues(); invalidate(); }); control.addEventListener('input', () => { range.value = control.value; }); label.append(range);
      }
      if (selected.tool === 'randomRecipe' && ['count', 'colors'].includes(key)) $('output-panel').querySelector('.panel-bar').append(label);
      if (key === 'indent') $('output-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'quicktype' && key === 'language') $('output-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'hashing') $('output-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'stringinspect') $('input-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'linesortdedupe') $(key === 'duplicates' ? 'input-panel' : 'output-panel').querySelector('.panel-bar').append(label);
      if (['csv2json', 'json2csv'].includes(selected.id)) $(key === 'indent' ? 'output-panel' : 'input-panel').querySelector('.panel-bar').append(label);
      if (selected.tool === 'jwt' && key === 'algorithm') $('input-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'regextester' && key === 'template') $('output-panel').querySelector('.panel-bar').append(label);
      if (selected.tool === 'svgToCss') $('output-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'sqlformatter' && ['dialect', 'keywordCase'].includes(key)) $(key === 'dialect' ? 'input-panel' : 'output-panel').querySelector('.panel-bar').append(label);
      if (selected.id === 'jsonformatter' && key === 'expression') {
        const operation = $('operation').value;
        caption.textContent = operation === 'jmespath' ? 'JMESPath' : 'JSONPath';
        control.placeholder = operation === 'repair' ? '修复模式不使用 JSONPath' : operation === 'jmespath' ? 'tools[*]' : operation === 'jsonpath' ? '$.tools[*]' : '$.tools[*]（留空显示完整 JSON）';
      }
      if (['urlencode', 'base64encode'].includes(selected.id)) $('input-panel').querySelector('.panel-bar').append(label);
      if (selected.tool === 'loremIpsum') $('output-panel').querySelector('.panel-bar').append(label);
      if (selected.tool === 'qrCode' && key === 'imageSize') caption.textContent = '中心图片大小';
      if (selected.tool === 'qrCode' && key === 'image') {
        control.placeholder = 'PNG / JPEG 图片 data URL';
        const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/gif,image/webp'; file.hidden = true;
        const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = '选择图片'; choose.addEventListener('click', () => file.click());
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除图片'; remove.addEventListener('click', () => { control.value = ''; fieldValues(); invalidate(); });
        const actions = document.createElement('div'); actions.className = 'option-actions'; actions.append(choose, remove);
        fields.get(key).imageActions = { choose, remove, file };
        file.addEventListener('change', async () => {
          const image = file.files[0], current = revision; if (!image) return;
          try {
            if (image.size > 32768) throw new Error('中心图片最多 32 KiB');
            const value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(image); });
            if (current === revision) { control.value = value; fieldValues(); invalidate(); }
          } catch (error) { if (current === revision) message(error.message, true); }
          finally { file.value = ''; }
        });
        label.append(actions, file); control.hidden = true; caption.textContent = '中心图片';
      }
    }
    if (selected.id === 'quicktype') {
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '恢复默认设置';
      reset.addEventListener('click', () => { values = Object.fromEntries(Object.entries(selected.contract.fields).map(([key, spec]) => [key, spec.default])); Object.assign(values, selected.defaults); renderFields(); updateLayout(); updateLanguage(); invalidate(); }); $('options').append(reset);
    }
  }
  function updateLanguage() {
    if (!selected) return;
    let input = 'plaintext', output = 'plaintext';
    if (selected.tool === 'json') { input = $('operation').value === 'escape' ? 'plaintext' : 'json'; output = $('operation').value === 'toCode' ? values.language : 'json'; }
    if (selected.tool === 'serialize') { input = values.from; output = values.to; }
    if (selected.tool === 'serialize' && values.from === 'phpSource') input = 'php';
    if (selected.tool === 'serialize' && ['phpArray', 'phpObject'].includes(values.to)) output = 'php';
    if (selected.tool === 'code') input = output = values.language === 'erb' ? 'html' : values.language;
    if (selected.tool === 'htmlToJsx') { input = 'html'; output = 'javascript'; }
    if (selected.tool === 'markdown') { input = 'markdown'; output = 'html'; }
    if (selected.id === 'curl2code') output = { fetch: 'javascript', python: 'python', go: 'go', java: 'java' }[$('operation').value];
    if (selected.local === 'html') input = output = 'html';
    if (selected.tool === 'svgToCss') { input = 'html'; output = 'css'; }
    const supported = ['javascript', 'json', 'html', 'css', 'yaml', 'xml', 'sql', 'php', 'less', 'scss', 'typescript', 'markdown', 'python', 'go', 'java', 'swift', 'kotlin', 'csharp', 'rust', 'protobuf'];
    $('input').setAttribute('language', supported.includes(input) ? input : 'plaintext');
    $('output').setAttribute('language', supported.includes(output) ? output : 'plaintext');
    $('file').accept = selected.tool === 'base64Image' ? 'image/png,image/jpeg,image/gif,image/webp' : selected.tool === 'qrCode' && $('operation').value === 'parse' ? 'image/png,image/jpeg,image/webp' : '';
  }
  function inputValue() {
    fieldValues();
    const options = {}, visible = new Set(visibleFields(selected, $('operation').value, values));
    for (const [key, spec] of Object.entries(selected.contract?.fields || {})) {
      const active = visible.has(key) && !(selected.tool === 'qrCode' && $('operation').value === 'parse') || selected.fixed?.includes(key) || selected.tool === 'diffs' && key === 'other';
      const value = active ? values[key] : spec.default;
      if (spec.type === 'integer' && (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum)) throw new Error(spec.title + ' 必须在 ' + spec.minimum + '–' + spec.maximum + ' 之间');
      options[key] = value;
    }
    const input = selected.tool === 'loremIpsum' && values.append ? generatedText : getInput();
    if (input.length > 65536) throw new Error('输入最多 65536 个字符');
    const body = { operation: $('operation').value, input, options };
    if (JSON.stringify(body).length > 100000) throw new Error('单次参数超过 100000 字符，请缩小输入');
    return body;
  }
  function showPreview(preview) {
    $('preview').hidden = !preview; $('output').hidden = preview;
    $('preview-tab').setAttribute('aria-pressed', String(preview)); $('text-tab').setAttribute('aria-pressed', String(!preview));
  }
  function table(value) {
    const list = document.createElement('dl'); list.className = 'result-table';
    for (const [key, item] of Object.entries(value)) {
      const term = document.createElement('dt'), definition = document.createElement('dd');
      term.textContent = resultLabels[key] || key; definition.textContent = textValue(item); list.append(term, definition);
    }
    $('preview').append(list);
  }
  function imagePreview(src, title) {
    const current = revision;
    const img = document.createElement('img'); img.alt = title; img.src = src;
    img.addEventListener('error', () => { if (current === revision) message('图片预览失败，仍可复制或下载结果。', true); }, { once: true });
    $('preview').append(img);
  }
  function renderPreview(entry, body, value, markdown) {
    if (entry.id === 'unixtime' || entry.tool === 'diffs') $('preview').replaceChildren();
    if (entry.id === 'colortools') { colorPicker.value = value.formats.Hex; renderFieldsPreview(colorFields, [Object.entries(value.formats)], copy); }
    if (entry.id === 'numberbase') { radixFields.setBase(body.options.to); radixFields.update(value); }
    if (entry.id === 'regextester') regexInput.highlight(value.matches);
    if (renderToolPreview($('preview'), entry, body, value, copy, match => regexInput.select(match), (text, language) => {
      result.text = text; $('output').value = text; $('output').setAttribute('language', language);
      $('output-count').textContent = text.length.toLocaleString() + ' 字符';
    })) {
      // Tool-specific content is ready; apply the shared result controls below.
    }
    else if (entry.tool === 'markdown') markdownView = markdown.create($('preview'), { value: body.input });
    else if (entry.tool === 'svgToCss') {
      const heading = document.createElement('h3'); heading.textContent = '预览'; $('preview').append(heading);
      previewUrl = URL.createObjectURL(new Blob([body.input], { type: 'image/svg+xml' })); imagePreview(previewUrl, 'SVG 图片预览');
    }
    else if (entry.id === 'curl2code' && value.warnings.length) {
      const note = document.createElement('p'); note.className = 'conversion-notes'; note.textContent = value.warnings.join('\n'); $('preview').append(note);
    }
    else if (entry.local === 'html') {
      const frame = document.createElement('iframe'); frame.title = '静态 HTML 预览'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer';
      const clean = DOMPurify.sanitize(body.input, {
        WHOLE_DOCUMENT: true,
        FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'link', 'svg', 'math'],
        FORBID_ATTR: ['href', 'srcset', 'action', 'formaction', 'target', 'ping', 'srcdoc']
      });
      const previewDocument = new DOMParser().parseFromString(clean, 'text/html'), policy = previewDocument.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
      previewDocument.head.prepend(policy);
      frame.srcdoc = '<!doctype html>' + previewDocument.documentElement.outerHTML;
      $('preview').append(frame);
    } else if (entry.tool === 'diffs') {
      const diff = document.createElement('page-code-editor'); diff.setAttribute('readonly', ''); diff.setAttribute('language', 'plaintext'); diff.setAttribute('aria-label', '文本差异视图');
      diff.setAttribute('data-original', body.input); diff.value = body.options.other; $('preview').append(diff);
    } else if (['qrCode', 'barcode'].includes(entry.tool) && value?.mime === 'image/svg+xml' && typeof value.content === 'string') {
      previewUrl = URL.createObjectURL(new Blob([value.content], { type: value.mime })); imagePreview(previewUrl, entry.title + '结果');
    } else if (entry.tool === 'qrCode' && value?.mime === 'image/png') {
      imagePreview('data:image/png;base64,' + value.content, '二维码');
    } else if (entry.tool === 'qrCode' && body.operation === 'parse') {
      imagePreview(value.image, '读取的二维码');
      const text = document.createElement('pre'); text.textContent = value.text; $('preview').append(text);
    } else if (entry.tool === 'base64Image') {
      imageFormat.value = /^data:/i.test(body.input.trim()) ? 'dataUrl' : /^(?:background-image\s*:|url\()/i.test(body.input.trim()) ? 'css' : 'raw';
      imagePreview(body.operation === 'decode' ? value : body.input.trim(), 'Base64 图片');
      $('preview').querySelector('img').addEventListener('load', event => { if (result?.body === body) $('result-kind').textContent = event.target.naturalWidth + ' × ' + event.target.naturalHeight; }, { once: true });
    } else if (entry.tool === 'jwt' && value && typeof value === 'object') {
      for (const key of ['header', 'payload', 'signature']) {
        const section = document.createElement('section'), title = document.createElement('h3'), content = document.createElement('pre');
        section.className = 'jwt-section'; title.textContent = resultLabels[key]; content.textContent = textValue(value[key]);
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '复制'; button.addEventListener('click', () => copy(content.textContent, '已复制 ' + key + '。')); title.append(button);
        section.append(title, content); $('preview').append(section);
        if (key === 'payload' && Object.keys(value.dates || {}).length) table(value.dates);
      }
      const note = document.createElement('p'); note.className = value.signatureVerified === true ? 'status-success' : value.signatureVerified === false ? 'status-error' : '';
      note.classList.add('jwt-status'); note.setAttribute('role', 'status');
      note.textContent = value.signatureVerified === null ? '未验证签名' : value.signatureVerified ? '签名验证通过' : '签名不匹配'; $('preview').append(note);
    } else if (value && typeof value === 'object' && !Array.isArray(value) && ['time', 'color', 'text', 'urlParse', 'uuid', 'ulid', 'ipcalc'].includes(entry.tool)) {
      if (entry.tool === 'color') { const swatch = document.createElement('div'); swatch.className = 'color-swatch'; swatch.style.backgroundColor = value.hex; swatch.setAttribute('aria-label', '颜色预览 ' + value.hex); $('preview').append(swatch); }
      table(value);
    }
    const available = $('preview').childNodes.length > 0;
    $('text-tab').textContent = entry.tool === 'markdown' ? 'HTML' : '文本';
    $('result-tabs').hidden = !available && entry.tool !== 'qrCode'; showPreview(available);
    if (entry.tool === 'svgToCss' || entry.id === 'curl2code') { $('output').hidden = false; $('result-tabs').hidden = true; }
  }
  async function run() {
    if ($('run').disabled) return;
    clearTimeout(automaticTimer); pending = false;
    const current = ++revision, entry = selected, start = performance.now();
    try {
      const body = inputValue(); busy = true; result = null;
      if (entry.tool !== 'diffs') { clearPreview(); $('output').value = ''; }
      else $('output-count').textContent = '正在比较…';
      controls(); message('正在本地处理…');
      let value, markdown;
      if (entry.local) { if (entry.local === 'markdown') markdown = await PageAgent.ui.load('markdown'); value = body.input; }
      else value = (await request('POST', entry.contract.operationUris[body.operation], { input: body.input, options: body.options })).value;
      if (entry.tool === 'markdown') { markdown = await PageAgent.ui.load('markdown'); value = DOMPurify.sanitize(value); }
      if (current !== revision || closed) return;
      const file = ['qrCode', 'barcode'].includes(entry.tool) && body.operation === 'generate' && ['image/svg+xml', 'image/png'].includes(value?.mime);
      result = { entry, body, value, file, text: file ? value.content : entry.id === 'curl2code' ? value.code : entry.id === 'regextester' ? value.output : entry.tool === 'qrCode' && body.operation === 'parse' ? value.text : textValue(value) };
      if (entry.id === 'quicktype' && value.files) {
        const previous = codeFiles.value, names = Object.keys(value.files), rootFile = body.options.name[0].toUpperCase() + body.options.name.slice(1) + '.swift';
        codeFiles.replaceChildren(...names.map(name => new Option(name, name))); codeFiles.value = names.includes(previous) ? previous : names.includes(rootFile) ? rootFile : names[0];
        codeFiles.hidden = false; result.text = value.files[codeFiles.value];
      } else codeFiles.hidden = true;
      if (entry.tool === 'loremIpsum') generatedText = result.text;
      if (entry.tool === 'qrCode' && body.operation === 'parse') { $('input').value = value.text; $('input-count').textContent = value.text.length.toLocaleString() + ' 字符'; }
      $('output').value = result.text;
      if (value && typeof value === 'object' && !file && !['curl2code', 'regextester', 'qrcode', 'quicktype'].includes(entry.id)) $('output').setAttribute('language', 'json');
      $('output-count').textContent = result.text.length.toLocaleString() + ' 字符';
      $('result-kind').textContent = Math.round(performance.now() - start) + ' ms';
      renderPreview(entry, body, value, markdown);
      message(entry.local ? '预览已生成 · 复制和下载保留输入源码。' : '处理完成 · 输入和结果仅保留在当前页面。');
    } catch (error) {
      if (current === revision) {
        if (entry.tool === 'diffs') { result = null; clearPreview(); $('output').value = ''; $('output-count').textContent = '比较失败'; }
        message(error.message, true);
      }
    }
    finally { busy = false; controls(); if (pending) { pending = false; run(); } }
  }
  async function copy(text, success) {
    const current = revision;
    try { await navigator.clipboard.writeText(text); if (current === revision) await notify(success); }
    catch (error) { if (current === revision) await notify('复制失败：' + (error.message || '无法写入剪贴板'), true); }
  }
  function download(open = false) {
    if (!result) return;
    const { value, entry, body, text } = result;
    let content = text, mime = 'text/plain;charset=utf-8', filename = entry.id + '.txt';
    if (result.file) { content = value.encoding === 'base64' ? Uint8Array.from(atob(value.content), char => char.charCodeAt(0)) : value.content; mime = value.mime; filename = value.filename; }
    else if (entry.id === 'quicktype' && value.files) filename = codeFiles.value;
    else if (entry.tool === 'base64Image' && body.operation === 'decode') {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/.exec(value);
      mime = match[1]; content = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0)); filename = 'image.' + mime.split('/')[1];
    } else if (entry.local) filename = entry.id + (entry.local === 'html' ? '.html' : '.md');
    else if (entry.tool === 'markdown') {
      const theme = getComputedStyle(document.documentElement);
      const css = 'body{max-width:900px;margin:8px auto;padding:0 8px;line-height:1.7;background:' + theme.getPropertyValue('--bg') + ';color:' + theme.getPropertyValue('--text') + ';font-family:system-ui,sans-serif}pre{overflow:auto;padding:8px}code{font-family:monospace}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid;padding:6px 8px}blockquote{border-left:3px solid;padding-left:8px}';
      content = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'"><title>Markdown</title><style>' + css + '</style></head><body>' + text + '</body></html>';
      filename = 'markdown.html'; mime = 'text/html;charset=utf-8';
    }
    else if ($('output').getAttribute('language') === 'json') { filename = entry.id + '.json'; mime = 'application/json'; }
    if (open && entry.local === 'html') { content = $('preview').querySelector('iframe')?.srcdoc; if (!content) return; mime = 'text/html;charset=utf-8'; }
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const anchor = document.createElement('a'); anchor.href = url;
    if (open) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } else anchor.download = filename;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), open ? 60000 : 1000);
  }
  function bindEditors() {
    for (const id of ['input', 'other']) $(id).addEventListener('input', () => {
      if (id === 'input' && selected.tool === 'qrCode' && $('operation').value === 'parse') { $('operation').value = 'generate'; qrReadInput = ''; renderFields(); updateLayout(); updateLanguage(); renderActions(); }
      invalidate();
    });
  }
  async function loadEditors() {
    if (editorReady || loading || closed) return;
    loading = true; editorError = ''; controls();
    try {
      await PageAgent.ui.load('code-editor');
      if (closed) return;
      editorReady = true; bindEditors();
      invalidate(permitted() || selected.local ? '就绪 · 输入内容或载入示例。' : '工具目录已加载，执行工具前请恢复应用权限。');
      parameterReceiver = receiveLaunch;
    } catch (error) { editorError = '编辑器加载失败：' + error.message + '。点击「重新加载」重试。'; message(editorError, true); }
    finally { loading = false; controls(); }
  }
  async function reload() {
    await loadEditors();
    try {
      await PageAgent.refresh();
      controls();
    } catch (error) { message(error.message, true); }
  }

  async function receiveLaunch(input) {
    if (closed) throw new Error('应用已关闭，无法应用启动参数。');
    const receivers = entries.filter(entry => !['randomRecipe', 'loremIpsum'].includes(entry.tool));
    await receiveToolInput(input, receivers, payload => {
      const entry = entries.find(entry => entry.id === payload.toolId);
      if (['compact', 'color', 'radix'].includes(layoutFor(entry)) && /[\r\n]/.test(payload.input)) throw new Error('此工具只接收单行文本，请选择其他工具。');
      selectTool(entry);
      $('operation').value = payload.operation;
      setInput(payload.input);
      if (selected.id === 'numberbase') radixFields.update({ 10: payload.input });
      renderFields(); updateLayout(); updateLanguage(); renderActions();
      invalidate('已接收内容。');
    });
  }

  $('search').addEventListener('input', renderNavigation);
  $('category').addEventListener('change', renderNavigation);
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('search').value = ''; renderNavigation(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); $('tools').querySelector('button')?.focus(); }
    if (event.key === 'Enter') $('tools').querySelector('button')?.click();
  });
  $('run').addEventListener('click', run);
  $('operation').addEventListener('change', () => { fieldValues(); renderFields(); updateLayout(); updateLanguage(); renderActions(); invalidate(); });
  $('clear').addEventListener('click', () => { setInput(''); radixFields.clear(); generatedText = ''; invalidate('已清空输入。'); });
  $('swap-inputs').addEventListener('click', () => {
    const original = $('input').value; $('input').value = $('other').value; $('other').value = original;
    invalidate('已交换两段文本。');
  });
  $('sample').addEventListener('click', () => {
    const sample = sampleFor(selected, $('operation').value); if (sample === null) return;
    setInput(sample); fieldValues(); Object.assign(values, selected.options); $('other').value = values.other || '';
    if (selected.tool === 'time') values.other = '2026-10-18T08:00:00+08:00';
    if ($('operation').value === 'jmespath') values.expression = 'tools[*]';
    if ($('operation').value === 'jsonpath') values.expression = '$.tools[*]';
    renderFields(); updateLayout(); updateLanguage(); invalidate('已载入示例。');
  });
  $('paste').addEventListener('click', async () => {
    const current = revision;
    try {
      const value = await navigator.clipboard.readText(); if (current !== revision) return; if (value.length > 65536) throw new Error('剪贴板文本超过 65536 字符');
      if (selected.tool === 'qrCode' && $('operation').value === 'parse') { $('operation').value = 'generate'; qrReadInput = ''; renderFields(); updateLayout(); updateLanguage(); renderActions(); }
      setInput(value); invalidate('已粘贴。');
    }
    catch (error) { if (current === revision) message('无法读取剪贴板，请直接粘贴到编辑器：' + error.message, true); }
  });
  $('open-file').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async event => {
    const file = event.target.files[0], current = revision, entry = selected, operation = $('operation').value;
    if (!file || !entry) return;
    try {
      if (entry.id === 'hashing') {
        if (file.size > 49152) throw new Error('文件哈希最多 48 KiB（工具输入限制）');
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        if (current === revision) {
          setInput('文件：' + file.name + '\n' + file.size + ' 字节 · 按原始字节计算；粘贴文本或清空可返回文本输入。');
          hashFile = { content: dataUrl.slice(dataUrl.indexOf(',') + 1), size: file.size }; values.inputEncoding = 'base64'; invalidate('已读取 ' + file.name + ' 的原始字节。');
        }
        return;
      }
      const image = entry.tool === 'base64Image' || entry.tool === 'qrCode' && operation === 'parse';
      if (file.size > (entry.tool === 'base64Image' ? 32768 : 262144)) throw new Error('文件过大；图片编解码最多 32 KiB，其他输入文件最多 256 KiB');
      const value = image ? await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }) : await file.text();
      if (value.length > 65536) throw new Error('文件内容超过 65536 字符，请缩小输入');
      if (current === revision) { setInput(value); if (entry.tool === 'base64Image') imageFormat.value = 'dataUrl'; invalidate('已读取 ' + file.name + '。'); }
    } catch (error) { if (current === revision) message(error.message, true); }
    finally { event.target.value = ''; }
  });
  $('copy').addEventListener('click', async () => {
    if (!result) return;
    if (result.entry.tool === 'qrCode' && result.body.operation === 'generate') {
      const current = revision, { body, entry, value } = result;
      try {
        const png = (async () => {
          const image = value.mime === 'image/png' ? value : (await request('POST', entry.contract.operationUris.generate, { input: body.input, options: { ...body.options, imageFormat: 'png', outputEncoding: 'image' } })).value;
          return new Blob([Uint8Array.from(atob(image.content), char => char.charCodeAt(0))], { type: 'image/png' });
        })();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        if (current === revision) await notify('已复制二维码图片。');
      } catch (error) { if (current === revision) await notify('无法复制二维码：' + error.message, true); }
      return;
    }
    if (result.entry.tool !== 'base64Image') { copy(result.text, '已复制结果。'); return; }
    const current = revision, dataUrl = result.value;
    try {
      const png = (async () => {
        const [header, encoded] = dataUrl.split(','), bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: header.slice(5, -7) }));
        try { const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败')), 'image/png')); }
        finally { bitmap.close(); }
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      if (current === revision) await notify('已复制图片。');
    } catch (error) { if (current === revision) await notify('无法复制图片：' + error.message, true); }
  });
  $('download').addEventListener('click', () => { try { download(); } catch (error) { message(error.message, true); } });
  $('use-output').addEventListener('click', () => {
    if (!result) return;
    if (result.text.length > 65536) { message('结果超过输入的 65536 字符上限，请复制需要的部分。', true); return; }
    setInput(result.text); invalidate('结果已用作输入。');
  });
  $('copy-node').addEventListener('click', () => {
    if (!selected?.contract) return;
    try {
      const body = inputValue(), node = { id: 'utility_' + crypto.randomUUID().replace(/-/g, ''), type: selected.contract.nodeType, title: selected.title, params: { operation: body.operation, input: body.input, ...body.options } };
      copy(JSON.stringify(node, null, 2), '已复制，可在流程「添加节点 → 粘贴节点 JSON」中添加。');
    } catch (error) { void notify(error.message, true); }
  });
  $('text-tab').addEventListener('click', () => showPreview(false));
  $('preview-tab').addEventListener('click', () => showPreview(true));
  $('about-button').addEventListener('click', () => $('about').showModal());
  $('retry').addEventListener('click', reload);
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  $('search-key').textContent = modifier + ' K'; $('run-key').textContent = modifier + ' ↵';
  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || $('about').open) return;
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); $('search').focus(); $('search').select(); }
    if (event.key === 'Enter') { event.preventDefault(); run(); }
  }, { capture: true });
  $('category').append(...[...new Set(entries.map(entry => entry.group))].map(group => new Option(group, group)));
  selectTool(entries.find(entry => entry.id === 'unixtime') || entries[0]);
  PageAgent.onChange(event => {
    if (event.change === 'permissions' || event.change === 'state') {
      if (!permitted()) invalidate('工具执行权限已关闭，可继续浏览目录或使用本地预览。');
      controls();
    }
    if (['deleted', 'imported'].includes(event.change)) { closed = true; invalidate('应用内容已变化，请重新加载页面。'); }
    if (event.change === 'disconnected') invalidate('应用连接已断开，可重新处理或重新加载页面。');
  });
  await loadEditors();
  window.addEventListener('pagehide', () => { closed = true; revision++; idRevision++; clearTimeout(idTimer); clearTimeout(automaticTimer); panelObserver.disconnect(); cancelAnimationFrame(panelLayoutFrame); clearPreview(); }, { once: true });
}
