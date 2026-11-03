// Presentation presets only. Operations and fields use the shared utilities/catalog.js contract.
const jsonSample = '{"project":"Developer Utils","local":true,"tools":["JSON","Base64","UUID"],"version":1}';
const imageSample = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const profiles = [
  { id: 'unixtime', tool: 'time', title: 'Unix 时间转换', english: 'Unix Time Converter', group: '检查与预览', operations: ['inspect'], fixed: ['sourceZone'], defaults: { unit: 'auto' }, sample: '1729166400', description: '输入时间戳或日期即刻转换；支持 + − × ÷ 数值运算。' },
  { id: 'jsonformatter', tool: 'json', title: 'JSON 格式化 / 校验', english: 'JSON Format / Validate', icon: '{}', group: '格式化', operations: ['format', 'minify', 'sort', 'repair', 'schema', 'jsonpath', 'jmespath'], sample: jsonSample, options: { schema: '{"type":"object","required":["project"]}' }, description: '输入后自动格式化；格式化、压缩和排序均支持先用 JSONPath 提取内容，也可切换查询或 Schema 校验。' },
  { id: 'base64encode', tool: 'base64', title: 'Base64 文本编解码', english: 'Base64 String Encode / Decode', icon: '64', group: '编码与解码', sample: 'Hello, 开发者！', decodeSample: 'SGVsbG8sIOS4lueVjO+8gQ==' },
  { id: 'base64image', tool: 'base64Image', title: 'Base64 图片编解码', english: 'Base64 Image Encode / Decode', group: '编码与解码', operations: ['decode'], sample: imageSample, description: '左侧粘贴 Base64 或 data URL，右侧自动显示图片；也可以打开图片文件。' },
  { id: 'jwt', tool: 'jwt', title: 'JWT 调试', english: 'JWT Debugger', group: '检查与预览', sample: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIiwibmFtZSI6IkRldmVsb3BlciBVdGlscyIsImlhdCI6MTcyOTE2NjQwMH0.c2FtcGxl', description: '自动拆分 Header、Payload 和签名；填写 HMAC 密钥后验签。支持 HS256 / HS384 / HS512。' },
  { id: 'regextester', tool: 'regex', title: '正则表达式', english: 'RegExp Tester', group: '检查与预览', operations: ['inspect'], sample: 'Contact alice@example.com or bob@example.org', options: { expression: '[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}', flags: 'gi' }, description: '输入表达式后自动高亮匹配；输出模板支持 $0、$1、命名分组和 \\n。' },
  { id: 'urlencode', tool: 'url', title: 'URL 编解码', english: 'URL Encode / Decode', group: '编码与解码', defaults: { rfc3986: true }, fixed: ['rfc3986'], sample: 'hello world / 开发者', decodeSample: 'hello%20world%20%2F%20%E5%BC%80%E5%8F%91%E8%80%85' },
  { id: 'querystringparser', tool: 'urlParse', title: 'URL 解析', english: 'URL Parser', icon: '&', group: '检查与预览', sample: 'https://example.com:8080/api/users?page=2&tag=dev&tag=tools#results' },
  { id: 'htmlencode', tool: 'html', title: 'HTML 实体编解码', english: 'HTML Entity Encode / Decode', icon: '&#', group: '编码与解码', sample: '<p>Hello & welcome</p>', decodeSample: '&lt;p&gt;Hello &amp; welcome&lt;/p&gt;' },
  { id: 'backslash', tool: 'backslash', title: '反斜杠转义', english: 'Backslash Escape / Unescape', icon: '\\n', group: '编码与解码', sample: 'Hello "Developer Utils"\nC:\\projects\\demo', decodeSample: 'Hello \\"Developer Utils\\"\\nC:\\\\projects\\\\demo' },
  { id: 'uuidtool', tool: 'uuid', title: 'UUID / ULID 生成与解码', english: 'UUID / ULID Generate / Decode', group: '生成', operation: 'v4', operations: ['v4', 'v1', 'v3', 'v5', 'v6', 'v7', 'ulid', 'nanoId'], sample: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' },
  { id: 'htmlpreview', local: 'html', title: 'HTML 预览', english: 'HTML Preview', icon: '</>', group: '检查与预览', operations: ['preview'], sample: '<style>body{font:16px system-ui;padding:8px;color:#26344a}article{padding:8px;border:1px solid #dce3ef;border-radius:12px}h1{color:#3478f6}</style>\n<article><h1>Hello, Developer Utils.</h1><p>把灵感变成页面。</p><ul><li>本地预览</li><li>专注内容</li></ul></article>', description: '在隔离的页面中预览静态 HTML 与内联 CSS；脚本、表单、链接跳转和外部资源不会运行。' },
  { id: 'textdiff', tool: 'diffs', title: '文本差异', english: 'Text Diff Checker', icon: '±', group: '检查与预览', sample: 'Hello Developer Utils\nVersion 1\nLocal tools', options: { other: 'Hello Developer Utils\nVersion 2\nLocal tools\nNew layout' }, description: '比较两段文本，支持按行、词或字符计算差异。预览显示删除与新增内容，文本保留差异片段。' },
  { id: 'numberbase', tool: 'radix', title: '进制转换', english: 'Number Base Converter', group: '转换', operations: ['all'], fixed: ['from', 'alphabet'], defaults: { to: 36 }, sample: '255', description: '在任意进制字段输入，其他字段自动更新；支持 2–64 进制。' },
  { id: 'loremipsum', tool: 'loremIpsum', title: 'Lorem Ipsum 生成', english: 'Lorem Ipsum Generator', group: '生成', fixed: ['unit'], sample: '' },
  { id: 'qrcode', tool: 'qrCode', title: '二维码生成 / 识别', english: 'QR Code Reader / Generator', icon: '▦', group: '生成', sample: 'https://example.com/developer-utils' },
  { id: 'stringinspect', tool: 'stringInspect', title: '字符串检查', english: 'String Inspector', group: '检查与预览', fixed: ['selectionStart', 'selectionEnd'], sample: 'Hello, 世界 👋\nA local developer toolbox.', description: '右侧实时显示字符、字节、词数、选区位置及词频。' },
  { id: 'hashing', tool: 'hash', title: '哈希生成', english: 'Hash Generator', group: '生成', operations: ['all'], defaults: { uppercase: true }, fixed: ['inputEncoding'], sample: 'Hello, Developer Utils!', description: '输入后同时显示 MD2、MD4、MD5 和 SHA 系列摘要；读取文件时按原始字节计算。' },
  { id: 'html2jsx', tool: 'htmlToJsx', title: 'HTML 转 JSX', english: 'HTML to JSX', group: '转换', sample: '<!-- Hello world -->\n<div class="awesome" style="border: 1px solid red"><label for="name">Enter your name: </label><input type="text" id="name" /></div>\n<p>Enter your HTML here</p>' },
  { id: 'markdownpreview', tool: 'markdown', title: 'Markdown 预览', english: 'Markdown Preview', group: '检查与预览', sample: '# Hello, Developer Utils\n\n一个 **本地** 开发工作台。\n\n- 编码与转换\n- 格式化与预览\n\n```json\n{"local": true}\n```\n\n| 输入 | 结果 |\n| --- | --- |\n| Markdown | 预览 |', description: '输入后自动预览，可查看和复制 HTML，或下载包含样式的 HTML 文档。' },
  { id: 'stringcaseconverter', tool: 'variableConversion', title: '命名风格转换', english: 'String Case Converter', icon: 'aA', group: '转换', sample: 'hello world\nuser_profile_id\nXMLHttpRequest' },
  { id: 'cronparser', tool: 'crontab', title: 'Cron 表达式', english: 'Cron Job Parser', group: '检查与预览', operations: ['inspect'], defaults: { count: 5 }, sample: '*/5 * * * *', description: '输入 Cron 即显示解释、各时间字段与后续执行时间。' },
  { id: 'colortools', tool: 'color', title: '颜色转换', english: 'Color Converter', group: '转换', operations: ['inspect'], sample: '#5ccc7f', description: '输入或选择颜色，左侧复制颜色格式，右侧查看各平台代码和颜色分量。' },
  { id: 'randomstringgenerator', tool: 'randomRecipe', title: '随机字符串', english: 'Random String Generator', group: '生成', sample: '' },
  { id: 'svg2css', tool: 'svgToCss', title: 'SVG 转 CSS', english: 'SVG to CSS', icon: '◇', group: '转换', sample: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3478f6"/></svg>' },
  { id: 'quicktype', tool: 'json', title: 'JSON 转类型代码', english: 'JSON to Code', group: '转换', operations: ['toCode'], defaults: { plainTypes: false, language: 'swift' }, sample: jsonSample, description: '从 JSON 样本推导 11 种语言的代码；Swift 5 支持 Codable、初始化器、修改方法和可选网络扩展。' },
  { id: 'curl2code', tool: 'httpSnippet', title: 'cURL 转代码', english: 'cURL to Code', group: '转换', operations: ['fetch', 'python', 'go', 'java'], defaults: { from: 'curl', report: true }, fixed: ['from', 'report'], sample: "curl 'https://example.com/api/items' -H 'accept: application/json' --compressed", description: '粘贴 cURL，选择目标语言即生成请求代码；只转换文本，不发送请求。' },
  { id: 'certdecoder', tool: 'certificate', title: 'X.509 证书解码', english: 'Certificate Decoder (X.509)', group: '编码与解码', description: '粘贴 PEM 证书，自动显示主体、签发者、有效期、公钥和扩展信息。' },
  { id: 'hex2ascii', tool: 'hexString', title: 'Hex → ASCII / UTF-8', english: 'Hex to ASCII / UTF-8', group: '编码与解码', operations: ['decode'], decodeSample: '48 65 6C 6C 6F 2C 20 44 65 76 65 6C 6F 70 65 72 20 55 74 69 6C 73 21' },
  { id: 'ascii2hex', tool: 'hexString', title: 'ASCII / UTF-8 → Hex', english: 'ASCII / UTF-8 to Hex', group: '编码与解码', operations: ['encode'], defaults: { uppercase: true, separator: ' ' }, fixed: ['uppercase', 'separator'], sample: 'Hello, Developer Utils!' },
  { id: 'json2php', tool: 'serialize', title: 'JSON 转 PHP', english: 'JSON to PHP', group: '转换', defaults: { from: 'json', to: 'phpObject' }, fixed: ['from', 'to'], sample: jsonSample, description: 'JSON 对象输出为 (object) array(…)；JSON 数组保留为 PHP 数组。' },
  { id: 'php2json', tool: 'serialize', title: 'PHP 转 JSON', english: 'PHP to JSON', group: '转换', defaults: { from: 'phpSource', to: 'json' }, fixed: ['from', 'to'], sample: "(object) array('store' => (object) array('book' => array((object) array('title' => 'Hello', 'price' => 8.95, 'sold' => false))))", description: '将 PHP 数组及 (object) 字面量转换为 JSON；只解析数据，不执行 PHP 代码。' },
  { id: 'phpserializer', tool: 'serialize', title: 'PHP 序列化', english: 'PHP Serializer', group: '转换', defaults: { from: 'phpSource', to: 'php' }, fixed: ['from', 'to'], sample: "(object) array('name' => 'Developer Utils', 'local' => true, 'tools' => array('JSON', 'Base64'))", description: '将 PHP 数据字面量序列化，保留数组与 stdClass 对象；字符串长度按 UTF-8 字节计算。' },
  { id: 'phpunserializer', tool: 'serialize', title: 'PHP 反序列化', english: 'PHP Unserializer', group: '转换', defaults: { from: 'php', to: 'phpObject' }, fixed: ['from', 'to'], sample: 'O:8:"stdClass":2:{s:4:"name";s:15:"Developer Utils";s:5:"local";b:1;}', description: '将序列化数据还原为 PHP 字面量，支持标量、数组与 stdClass；暂不支持引用或自定义类。' },
  { id: 'linesortdedupe', tool: 'text', title: '行排序 / 去重', english: 'Line Sort / Dedupe', group: '文本', operations: ['processLines'], sample: 'banana\napple\nbanana\norange\n\napple', description: '选择排序方式和重复行策略，结果自动更新；两项设置同时生效。' }
];

for (const [from, to, sample] of [
  ['yaml', 'json', 'project: Developer Utils\nlocal: true\ntools:\n  - JSON\n  - Base64'],
  ['json', 'yaml', jsonSample], ['json', 'csv', '[{"name":"Alice","role":"developer"},{"name":"Bob","role":"designer"}]'],
  ['csv', 'json', 'name,role\nAlice,developer\nBob,designer']
]) profiles.push({ id: from + '2' + to, tool: 'serialize', title: from.toUpperCase() + ' → ' + to.toUpperCase(), english: from.toUpperCase() + ' to ' + to.toUpperCase(), icon: '⇄', group: '转换', defaults: { from, to, ...(to === 'csv' ? { flatten: true } : {}) }, fixed: ['from', 'to'], sample, description: '将 ' + from.toUpperCase() + ' 数据转换为 ' + to.toUpperCase() + '。CSV 使用首行字段名并保留字符串。' });

for (const [language, label, sample] of [
  ['html', 'HTML', '<main><h1>Hello Developer Utils</h1><p>Local tools</p></main>'],
  ['css', 'CSS', '.card{color:#3478f6;padding:8px;margin:0 auto}'],
  ['javascript', 'JavaScript', 'const tools=["json","base64"];function greet(name){return `Hello, ${name}`;}'],
  ['erb', 'ERB', '<% posts.each do |post| %>\n<p><%= post.title %></p>\n<% end %>'],
  ['less', 'LESS', '@brand: #3478f6;.card{color:@brand;.title{font-size:18px;}}'],
  ['scss', 'SCSS', '$brand: #3478f6;.card{color:$brand;.title{font-size:18px;}}'],
  ['xml', 'XML', '<tools><tool id="json">JSON</tool><tool id="base64">Base64</tool></tools>'],
  ['sql', 'SQL', 'select id,name from users where active=1 order by name']
]) profiles.push({ id: (language === 'javascript' ? 'js' : language) + 'formatter', tool: 'code', title: label + ' 格式化' + (language !== 'sql' ? ' / 压缩' : ''), english: label + ' Formatter' + (language !== 'sql' ? ' / Minifier' : ''), group: '格式化', defaults: { language }, fixed: ['language'], operations: language !== 'sql' ? ['format', 'minify'] : ['format'], sample, description: '整理 ' + label + ' 代码排版，不执行输入代码。' });

// This application has its own 47-tool menu; the shared catalog supplies implementations only.
const referenceOrder = ['unixtime', 'jsonformatter', 'base64encode', 'base64image', 'jwt', 'regextester', 'urlencode', 'querystringparser', 'htmlencode', 'backslash', 'uuidtool', 'htmlpreview', 'textdiff', 'yaml2json', 'json2yaml', 'numberbase', 'htmlformatter', 'cssformatter', 'jsformatter', 'erbformatter', 'lessformatter', 'scssformatter', 'xmlformatter', 'loremipsum', 'qrcode', 'stringinspect', 'json2csv', 'csv2json', 'hashing', 'html2jsx', 'markdownpreview', 'sqlformatter', 'stringcaseconverter', 'cronparser', 'colortools', 'php2json', 'json2php', 'phpserializer', 'phpunserializer', 'randomstringgenerator', 'svg2css', 'curl2code', 'quicktype', 'certdecoder', 'hex2ascii', 'ascii2hex', 'linesortdedupe'];
const order = new Map(referenceOrder.map((id, index) => [id, index]));
profiles.sort((a, b) => (order.get(a.id) ?? referenceOrder.length) - (order.get(b.id) ?? referenceOrder.length));

export function layoutFor(entry) {
  if (entry.id === 'colortools') return 'color';
  if (entry.id === 'numberbase') return 'radix';
  if (entry.id === 'uuidtool') return 'ids';
  if (['unixtime', 'cronparser'].includes(entry.id)) return 'compact';
  if (entry.tool === 'diffs') return 'diff';
  if (['base64', 'url', 'html', 'backslash', 'regex'].includes(entry.tool)) return 'stacked';
  if (['randomRecipe', 'loremIpsum'].includes(entry.tool)) return 'generator';
  return 'columns';
}

export function createEntries(catalog) {
  const byId = new Map(catalog.map(tool => [tool.id, tool]));
  return profiles.filter(profile => profile.local || byId.has(profile.tool)).map(profile => {
    const tool = byId.get(profile.tool);
    return { ...profile, contract: tool, operations: profile.operations || tool.operations, description: profile.description || tool.description || '输入后自动更新结果。' };
  });
}

export function visibleFields(entry, operation, values) {
  const fields = Object.keys(entry.contract?.fields || {}).filter(key => !entry.fixed?.includes(key));
  const only = keys => fields.filter(key => keys.includes(key));
  if (entry.id === 'hashing') return only(['uppercase']);
  if (entry.id === 'linesortdedupe') return only(['sortMode', 'duplicates']);
  if (entry.id === 'curl2code') return [];
  if (entry.id === 'base64encode') return only(['urlSafe']);
  if (entry.id === 'base64image') return [];
  if (['hex2ascii', 'ascii2hex'].includes(entry.id)) return [];
  if (entry.id === 'numberbase') return only(['to']);
  if (entry.tool === 'code') return fields.filter(key => (operation !== 'minify' || key !== 'indent') && (values.language === 'sql' || !['dialect', 'keywordCase'].includes(key)));
  if (entry.tool === 'serialize' && entry.fixed) return only(values.to === 'csv' ? ['delimiter', 'flatten'] : values.from === 'csv' ? ['delimiter', 'indent'] : ['json', 'phpObject'].includes(values.to) ? ['indent'] : []);
  if (entry.id === 'jsonformatter') return only(['indent', operation === 'schema' ? 'schema' : 'expression']);
  if (entry.tool === 'json') return only(operation === 'toCode' ? ['language', 'name', ...(values.language === 'swift' ? ['plainTypes', 'declaration', 'mutable', 'multiFile', ...(values.declaration === 'class' ? ['nsObject'] : []), ...(!values.plainTypes ? ['codingKeys', 'jsonMethods', 'urlSession', 'alamofire'] : [])] : [])] : operation === 'schema' ? ['schema'] : ['jsonpath', 'jmespath'].includes(operation) ? ['expression'] : ['format', 'sort'].includes(operation) ? ['indent'] : []);
  if (entry.tool === 'time') return only({ inspect: ['unit', 'zone'], timestamp: ['unit'], now: ['unit'], timezone: ['zone'], add: ['amount', 'interval'], difference: ['other'] }[operation] || []);
  if (entry.tool === 'uuid') return only(operation === 'validate' ? [] : operation === 'nanoId' ? ['count'] : operation === 'ulid' ? ['count', 'uppercase'] : ['v3', 'v5'].includes(operation) ? ['count', 'namespace', 'uppercase', 'hyphens'] : ['count', 'uppercase', 'hyphens']);
  if (entry.tool === 'regex') return only(operation === 'inspect' ? ['expression', 'flags', 'template'] : operation === 'replace' ? ['expression', 'flags', 'replacement'] : ['expression', 'flags']);
  if (entry.tool === 'text') return only(operation === 'sort' ? ['descending'] : operation === 'processLines' ? ['sortMode', 'duplicates'] : operation === 'transform' ? ['transformation', 'search', 'replacement', 'regular', 'escapeCharacters'] : []);
  if (entry.tool === 'diffs') return [];
  if (entry.tool === 'qrCode') return only(['level', 'cellSize', 'margin', 'imageFormat', 'image', 'imageSize']);
  if (entry.tool === 'crontab') return only(operation === 'describe' ? [] : operation === 'inspect' ? ['count', 'zone'] : ['count', 'zone', 'start']);
  return fields;
}

export function sampleFor(entry, operation) {
  if (entry.tool === 'qrCode' && operation === 'parse') return null;
  if (['decode', 'unescape'].includes(operation) && entry.decodeSample !== undefined) return entry.decodeSample;
  if (entry.tool === 'uuid' && ['v3', 'v5'].includes(operation)) return 'example.com';
  if (entry.tool === 'time' && !['timestamp', 'now'].includes(operation)) return '2026-10-17T08:00:00+08:00';
  if (entry.tool === 'json' && operation === 'unescape') return '"Hello\\nDeveloper Utils"';
  return entry.sample ?? null;
}
