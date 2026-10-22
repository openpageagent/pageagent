// One definition for the offline API, application forms and flow nodes.
(function (root) {
  'use strict';
  const tools = [];
  const text = (label, value = '') => ({ type: 'string', title: label, default: value, maxLength: 65536 });
  const select = (label, values, value = values[0]) => ({ type: 'string', title: label, enum: values, default: value });
  const number = (label, value, min, max) => ({ type: 'integer', title: label, default: value, minimum: min, maximum: max });
  const bool = (label, value = false) => ({ type: 'boolean', title: label, default: value });
  const pathSegment = value => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  function add(id, label, category, operations, fields = {}, description = '') {
    const uri = '/utilities/' + pathSegment(id);
    const operationUris = Object.fromEntries(operations.map(operation => [operation, uri + '/' + pathSegment(operation)]));
    tools.push({ id, label, category, operations, fields, description, uri, operationUris, nodeType: 'utility' + id[0].toUpperCase() + id.slice(1) });
  }
  const hashes = ['MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'Keccak512', 'RIPEMD160', 'SM3'];
  const inputEncoding = () => select('输入格式', ['utf8', 'hex', 'base64']);
  const digestFields = () => ({ inputEncoding: inputEncoding(), uppercase: bool('大写'), multiple: bool('逐行计算') });
  add('hash', '哈希摘要', '加密与校验', ['digest', 'all'], { algorithm: select('算法', ['MD2', 'MD4', ...hashes], 'SHA256'), ...digestFields(), salted: bool('加盐'), salt: text('盐值'), expression: text('盐值表达式', 'hash($input.$salt)') }, '输入文本或编码字节，输出十六进制摘要。all 同时返回 MD2/MD4/MD5 与 SHA 系列。盐值表达式仅支持 hash、$input、$salt 和拼接，不执行代码。Keccak512 区别于 NIST SHA3。');
  add('hmac', 'HMAC', '加密与校验', ['digest'], { algorithm: select('算法', hashes, 'SHA256'), key: text('密钥'), keyEncoding: select('密钥格式', ['utf8', 'hex', 'base64']), ...digestFields() }, 'Keccak512 对应 CryptoJS 的 SHA3 实现，区别于 NIST SHA3。');
  for (const [id, label] of [['aes', 'AES'], ['des', 'DES'], ['tripleDes', 'Triple DES'], ['rc4', 'RC4'], ['rabbit', 'Rabbit']]) {
    const fields = { type: select('参数模式', ['advanced', 'simple']), key: text('密钥'), keyEncoding: select('密钥 / IV 格式', ['hex', 'utf8']), inputEncoding: inputEncoding(), outputEncoding: select('输出格式', ['auto', 'base64', 'hex', 'utf8']), fill: bool('自动填充 IV', true) };
    if (id !== 'rc4') fields.iv = text('IV');
    if (!['rc4', 'rabbit'].includes(id)) Object.assign(fields, { mode: select('模式', ['CBC', 'ECB', 'CFB', 'OFB', 'CTR']), padding: select('填充', ['Pkcs7', 'ZeroPadding', 'NoPadding', 'AnsiX923', 'Iso10126', 'Iso97971']) });
    if (id === 'aes') fields.keySize = select('密钥位数', ['128', '192', '256']);
    add(id, label, '加密与校验', ['encrypt', 'decrypt'], fields, '高级模式支持文本或十六进制密钥；简单模式复用 CryptoJS 的 OpenSSL 密码格式。');
  }
  add('sm2', 'SM2', '加密与校验', ['keypair', 'encrypt', 'decrypt', 'sign', 'verify'], { key: text('公钥或私钥（十六进制）'), signature: text('签名'), signatureEncoding: select('签名格式', ['hex', 'base64']), cipherMode: select('密文格式', ['C1C3C2', 'C1C2C3']), userId: text('用户标识', '1234567812345678'), inputEncoding: inputEncoding(), outputEncoding: select('输出格式', ['auto', 'hex', 'base64', 'utf8']) });
  add('sm4', 'SM4', '加密与校验', ['encrypt', 'decrypt'], { key: text('密钥'), keyEncoding: select('密钥格式', ['hex', 'utf8', 'base64']), iv: text('IV'), ivEncoding: select('IV 格式', ['hex', 'utf8', 'base64']), mode: select('模式', ['ecb', 'cbc']), padding: bool('Padding', true), inputEncoding: inputEncoding(), outputEncoding: select('输出格式', ['auto', 'hex', 'base64', 'utf8']) }, '密钥为 16 字节，CBC 的 IV 为 16 字节。');
  add('rsa', 'RSA', '加密与校验', ['keypair', 'encrypt', 'decrypt'], { key: text('PEM 公钥或私钥'), bits: number('密钥位数', 2048, 2048, 4096), hash: select('OAEP 摘要', ['SHA-256', 'SHA-1']), inputEncoding: inputEncoding(), outputEncoding: select('输出格式', ['auto', 'base64', 'hex', 'utf8']) }, 'RSA-OAEP；输出 PEM SPKI 公钥、PKCS#8 私钥，默认密文为 Base64。');
  add('sign', '数字签名', '加密与校验', ['keypair', 'sign', 'verify'], { key: text('PEM 密钥'), signature: text('签名（Base64）'), algorithm: select('算法', ['SHA256withRSA', 'SHA1withRSA', 'SHA384withRSA', 'SHA512withRSA', 'SHA256withECDSA', 'SHA384withECDSA']), curve: select('EC 曲线', ['secp256r1', 'secp384r1']), bits: select('RSA 密钥位数', ['2048', '4096']) }, '浏览器 WebCrypto；PEM SPKI 公钥 / PKCS#8 私钥。RSA 使用 PKCS#1 v1.5；ECDSA 签名为 P1363（r||s）格式的 Base64，非 DER。');
  add('bcrypt', 'bcrypt', '加密与校验', ['hash', 'verify'], { rounds: number('成本因子', 10, 4, 16), hash: text('待验证的 bcrypt 哈希'), version: select('版本', ['2a', '2b', '2y'], '2a') });
  add('dataValidation', 'BCC / CRC / LRC', '加密与校验', ['checksum'], { algorithm: select('算法', ['BCC', 'LRC', 'CRC8', 'CRC16-MODBUS', 'CRC16-CCITT', 'CRC32']), encoding: select('输入编码', ['utf8', 'hex', 'base64']) });
  add('base64', 'Base64', '编码与解码', ['encode', 'decode'], { urlSafe: bool('URL 安全格式'), inputEncoding: inputEncoding(), outputEncoding: select('解码输出', ['utf8', 'hex', 'image', 'download']) }, '文本、十六进制或文件字节与 Base64 转换。');
  add('base64Image', 'Base64 图片', '编码与解码', ['encode', 'decode'], { representation: select('文本格式', ['raw', 'dataUrl', 'css']) }, 'PNG/JPEG/GIF/WebP 图片与 Base64 转换。支持原始 Base64、data URL 与 CSS background-image；图片最多 32 KiB、400 万像素。');
  add('backslash', '反斜杠转义', '编码与解码', ['escape', 'unescape'], {}, '使用 JSON 字符串转义规则处理换行、引号、反斜杠和 Unicode；输入和输出均不包含外层双引号。');
  add('svgToCss', 'SVG → CSS', '编码与解码', ['convert'], { encoding: select('输出编码', ['url', 'base64']) }, '校验 SVG XML 并生成 URL 编码或 Base64 的 background-image 声明。');
  add('url', 'URL 编解码', '编码与解码', ['encode', 'decode'], { component: bool('编码 URI 组件', true), rfc3986: bool('RFC 3986 严格组件编码') });
  add('unicode', 'Unicode 转义', '编码与解码', ['encode', 'decode'], { style: select('格式', ['javascript', 'wide', 'codepoint', 'number', 'html', 'decimal', 'css']), ignoreASCII: bool('忽略 ASCII') });
  add('hexString', 'UTF-8 / Hex', '编码与解码', ['encode', 'decode'], { inputEncoding: inputEncoding(), outputEncoding: select('解码输出', ['utf8', 'base64']), uppercase: bool('大写'), separator: text('字节分隔符') });
  add('html', 'HTML 实体', '编码与解码', ['encode', 'decode']);
  add('htmlToJsx', 'HTML / SVG → JSX', '格式与数据', ['convert'], {}, '转换 HTML/SVG 属性、样式和注释，不执行源码；内联事件须由使用者改为 React 函数。');
  add('markdown', 'Markdown → HTML', '格式与数据', ['render'], {}, '使用插件内的 Marked 转换 Markdown，返回 HTML 文本，不执行或加载其中的内容。');
  add('gzip', 'Gzip', '编码与解码', ['encode', 'decode'], { deflate: bool('Deflate'), inputEncoding: inputEncoding(), outputEncoding: select('输出格式', ['auto', 'base64', 'hex', 'utf8', 'download']) }, '支持 Gzip / Deflate；解压限制输出大小。');
  add('punycode', 'Punycode', '编码与解码', ['encode', 'decode'], {}, '转换 Unicode 域名与 ASCII 域名。');
  add('jwt', 'JWT 解析', '编码与解码', ['decode'], { algorithm: select('验签算法', ['HS256', 'HS384', 'HS512']), secret: text('HMAC 密钥（留空仅解码）') }, '解析 Header、Payload、签名和时间声明；填写密钥时按明确选择的 HMAC 算法验签。验签不代表声明或身份可信。');
  add('asn1', 'ASN.1 解码', '编码与解码', ['decode'], { encoding: select('输入格式', ['pem', 'hex', 'base64']), outputFormat: select('输出格式', ['json', 'xml']) }, '解析 BER/DER 标签、长度、嵌套值和 OID；保留原始十六进制，不查询在线 OID 数据库。');
  add('certificate', 'X.509 证书解码', '编码与解码', ['decode'], {}, '解析单张 PEM 或 Base64 DER 证书的版本、序列号、签发者、有效期、主体、公钥、扩展及签名；不验证证书信任链。');
  add('json', 'JSON 工具', '格式与数据', ['format', 'minify', 'sort', 'escape', 'unescape', 'repair', 'jsonpath', 'jmespath', 'schema', 'toCode', 'rename', 'unicode'], {
    indent: select('缩进', ['2', '4', 'tab'], '2'),
    expression: text('JSONPath / JMESPath 表达式'), schema: text('JSON Schema', '{}'), language: select('代码语言', ['typescript', 'javascript', 'java', 'csharp', 'go', 'python', 'php', 'protobuf', 'rust', 'swift', 'kotlin']), name: text('类型名称', 'Root'), descending: bool('键倒序'), naming: select('键名格式', ['camel', 'pascal', 'snake', 'kebab', 'constant']), decodeUnicode: bool('Unicode 转中文'), plainTypes: bool('只生成类型', true), declaration: select('Swift 声明', ['struct', 'class']), mutable: bool('使用 var'), codingKeys: bool('显式 CodingKeys', true), jsonMethods: bool('JSON 编解码方法', true), nsObject: bool('继承 NSObject'), urlSession: bool('URLSession 扩展'), alamofire: bool('Alamofire 扩展'), multiFile: bool('按类型分文件')
  }, '结构化查询不执行用户脚本；Schema 使用 2020-12，远程引用不联网解析。toCode 从样本推导类型，null/混合类型用动态类型表示，不推测日期、枚举或业务约束。');
  add('serialize', '序列化转换', '格式与数据', ['convert'], { from: select('源格式', ['json', 'yaml', 'xml', 'toml', 'csv', 'properties', 'php', 'phpSource']), to: select('目标格式', ['json', 'yaml', 'xml', 'toml', 'csv', 'properties', 'php', 'phpArray', 'phpObject']), indent: select('缩进', ['2', '4', 'tab']), delimiter: select('CSV 分隔符', [',', ';', '\t', '|']), flatten: bool('展开嵌套字段') });
  add('code', '代码格式化', '格式与数据', ['format', 'minify'], { language: select('语言', ['javascript', 'typescript', 'json', 'html', 'vue', 'css', 'less', 'scss', 'markdown', 'yaml', 'xml', 'sql', 'php', 'java', 'graphql', 'erb']), indent: select('缩进', ['2', '4', 'tab']), dialect: select('SQL 方言', ['sql', 'mysql', 'postgresql', 'sqlite', 'mariadb', 'bigquery', 'db2', 'hive', 'plsql', 'redshift', 'snowflake', 'spark', 'transactsql', 'trino']), keywordCase: select('关键字', ['preserve', 'upper', 'lower']) }, '不执行代码。HTML/XML 压缩保留文本和属性值；ERB 只整理模板布局，不执行 Ruby。');
  add('diffs', '文本差异', '文本', ['lines', 'words', 'characters'], { other: text('对比文本') }, '输出有序差异片段：added / removed / value。');
  add('regex', '正则表达式', '文本', ['match', 'replace', 'split', 'inspect'], { expression: text('正则表达式'), flags: text('标志', 'g'), replacement: text('替换文本'), template: text('输出模板', '$0\\n') }, '执行在独立 Worker 中，超时终止。inspect 返回匹配和模板提取结果；模板支持 $0、$1、$<name> 和 \\n。');
  add('text', '文本处理', '文本', ['statistics', 'dedupe', 'sort', 'reverse', 'trim', 'upper', 'lower', 'removeEmpty', 'transform', 'processLines'], { descending: bool('倒序'), sortMode: select('排序', ['original', 'textAsc', 'textDesc', 'numericAsc', 'numericDesc'], 'textAsc'), duplicates: select('重复行', ['keep', 'remove']), transformation: select('文本操作', ['upperLineStart', 'lowerLineStart', 'upperWordStart', 'lowerWordStart', 'addLineNumbers', 'removeLineNumbers', 'reverseLines', 'reverseEachLine', 'removeBreaks', 'punctuationZh', 'punctuationEn', 'replace', 'escape', 'unescape']), search: text('查找'), replacement: text('替换为'), regular: bool('正则表达式'), escapeCharacters: text('转义字符名称 JSON 数组（留空使用 JSON 转义）') });
  add('variableConversion', '命名转换', '文本', ['camel', 'pascal', 'snake', 'kebab', 'constant', 'words', 'dot', 'path', 'title', 'sentence', 'train', 'upper', 'lower', 'swap']);
  add('stringInspect', '字符串检查', '文本', ['inspect'], { caseSensitive: bool('区分大小写', true), selectionStart: number('选区起点', 0, 0, 65536), selectionEnd: number('选区终点', 0, 0, 65536) }, '统计字符、UTF-8 字节、词频和选区信息。');
  add('pinyin', '汉字拼音', '文本', ['convert'], { toneType: select('声调', ['symbol', 'num', 'none']), pattern: select('模式', ['pinyin', 'initial', 'final', 'first']), separator: text('分隔符', ' '), multiple: bool('多音字'), replaceV: bool('ü → v'), uppercase: bool('大写') });
  add('zhNumber', '中文数字', '文本', ['lower', 'upper', 'money', 'decode', 'convert'], { from: select('输入类型', ['number', 'lower', 'upper', 'money']), traditional: bool('繁体') });
  add('ascii', 'ASCII 码表', '文本', ['table', 'encode', 'decode', 'convert'], { from: select('输入格式', ['text', 'binary', 'octal', 'decimal', 'hex']) });
  add('radix', '进制转换', '数值与时间', ['convert', 'all'], { from: number('源进制', 10, 2, 64), to: number('目标进制', 16, 2, 64), alphabet: text('字符表', '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_@') }, '支持 2–64 进制和自定义字符表；整数使用 BigInt，小数保留最多 20 位。');
  add('binary', '原码 / 反码 / 补码', '数值与时间', ['convert'], { bits: select('位宽', ['8', '16', '32', '64', '128']) }, '输入每行一个有符号十进制整数。');
  add('unit', '单位换算', '数值与时间', ['convert', 'groups'], { from: text('源单位', 'm'), to: text('目标单位', 'km'), group: text('单位类别', 'length') }, '支持长度、面积、体积、质量、速度、时间、温度、压力等兼容单位；to=all 返回该类别全部单位。');
  add('time', '时间工具', '数值与时间', ['timestamp', 'timezone', 'add', 'difference', 'now', 'analyze', 'zones', 'inspect'], { unit: select('时间戳单位', ['milliseconds', 'seconds', 'nanoseconds', 'auto']), zone: text('目标 IANA 时区', 'Asia/Shanghai'), sourceZone: text('输入 IANA 时区（无时区的日期使用此值）'), other: text('第二个时间'), amount: number('增减量', 1, -100000000, 100000000), interval: select('增减单位', ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years']), period: select('分析周期', ['year', 'quarter', 'month']) }, '带时区的 ISO 时间直接解析；本地日期须明确指定 sourceZone。zones 返回当前 UTC 偏移与中文时区名称。');
  add('crontab', 'Cron 表达式', '数值与时间', ['describe', 'next', 'inspect'], { count: number('未来执行次数', 10, 1, 50), zone: text('时区', 'Asia/Shanghai'), start: text('开始时间（ISO，可留空）') });
  add('color', '颜色转换', '数值与时间', ['convert', 'inspect'], { alpha: text('透明度（0–1，留空沿用输入）') }, '支持颜色名称、Hex、RGB、HSL、HWB、CMYK、LCH 以及 HSV / Lab / XYZ 对象。inspect 提供可复制字段与平台代码。');
  const generatedFormat = () => select('输出格式', ['text', 'json', 'xml', 'yaml', 'toml', 'properties', 'phpArray']);
  add('uuid', 'UUID', '生成', ['v1', 'v3', 'v4', 'v5', 'v6', 'v7', 'validate', 'format', 'inspect', 'ulid', 'nanoId'], { count: number('数量', 1, 1, 1000), namespace: text('v3/v5 命名空间', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), uppercase: bool('大写'), hyphens: bool('连字符', true), bytes: bool('字节数组'), outputFormat: generatedFormat() });
  add('ulid', 'ULID', '生成', ['generate', 'decode', 'format'], { count: number('数量', 1, 1, 1000), uppercase: bool('大写', true), outputFormat: generatedFormat() }, '生成 48 位毫秒时间戳与 80 位密码学随机数组成的 ULID，或解码时间和随机部分。同一毫秒内不保证单调排序。');
  add('loremIpsum', 'Lorem Ipsum', '生成', ['generate'], { unit: select('单位', ['paragraphs', 'sentences', 'words', 'title', 'firstName', 'lastName', 'fullName', 'email', 'url', 'shortText', 'longText']), count: number('数量', 3, 1, 100), append: bool('追加到结果') }, '生成占位文本和虚构示例资料；邮件和 URL 使用 example.com。');
  add('randomString', '随机字符串', '生成', ['generate', 'format'], {
    length: number('长度', 32, 0, 4096), count: number('数量', 1, 0, 100), alphabet: text('字符', '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'), outputFormat: generatedFormat(),
    addQuote: bool('添加引号'), delimiter: text('分隔符', '\\n'), attributePrefix: text('XML 属性前缀'), inputFormat: select('待格式化数据', ['lines', 'json'])
  }, '使用浏览器密码学随机源和拒绝采样。Text 支持引号和分隔符（\\n 表示换行）；format 默认按行读取，也接受 JSON 字符串数组以保留值中的换行。');
  add('randomRecipe', '随机字符串组合', '生成', ['generate'], { seed: text('种子（留空使用密码学随机源）'), upper: number('大写字母', 18, 0, 100), lower: number('小写字母', 18, 0, 100), symbols: number('符号', 2, 0, 100), digits: number('数字', 8, 0, 100), words: number('单词', 0, 0, 100), separator: select('分隔符', ['', '-', '_', ' ', '.']), groupSize: number('每组字符数（0 不分组）', 0, 0, 100), custom: number('自定义字符数量', 0, 0, 100), alphabet: text('自定义字符集'), count: number('数量', 10, 1, 100), colors: bool('字符着色', true) }, '按各类别数量抽样并打乱。填写种子时产生可重复的伪随机结果；留空使用密码学随机源。');
  const qrFields = { margin: number('外边距', 10, 0, 1000), level: select('纠错', ['L', 'M', 'Q', 'H'], 'Q'), cellSize: number('模块像素（0 为自动尺寸）', 0, 0, 20), image: text('中心图片 data URL'), imageSize: number('大小', 4, 0, 10), imageMargin: number('外边距', 4, 0, 1000), inputEncoding: select('输入类型', ['dataurl', 'utf8', 'base64', 'hex']), outputEncoding: select('输出类型', ['image', 'hex', 'base64']), imageFormat: select('图片格式', ['svg', 'png']) };
  for (const [key, title, color] of [['dots', '内容', '#000000'], ['corners', '定位边框', '#000000'], ['center', '定位符', '#000000'], ['background', '背景', '#ffffff']]) {
    qrFields[key + 'Color'] = text(title + '颜色', color);
    qrFields[key + 'Gradient'] = bool('渐变'); qrFields[key + 'Start'] = text('起点颜色'); qrFields[key + 'End'] = text('终点颜色', color);
    qrFields[key + 'GradientType'] = select('渐变方式', ['linear', 'radial']); qrFields[key + 'Rotation'] = number('旋转', 0, 0, 360);
  }
  qrFields.dotsStyle = select('样式', ['square', 'dots', 'rounded', 'classy', 'extra-rounded', 'classy-rounded']);
  qrFields.cornersStyle = select('样式', ['dot', 'square', 'extra-rounded'], 'square'); qrFields.centerStyle = select('样式', ['dot', 'square'], 'square');
  add('qrCode', '二维码', '生成', ['generate', 'parse'], qrFields, '文本、Hex 或 Base64 解码为 UTF-8 内容后生成 SVG 或 PNG；默认按每 100 个 UTF-8 字节增加 300px，最大 2000px。支持内容、定位边框、定位符和背景设置；解析 PNG/JPEG/WebP 图片。');
  add('barcode', '条形码', '生成', ['generate'], { format: select('格式', ['CODE128', 'CODE128A', 'CODE128B', 'CODE128C', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF14', 'ITF', 'MSI', 'MSI10', 'MSI11', 'MSI1010', 'MSI1110', 'pharmacode', 'codabar']), background: text('背景色', '#ffffff'), lineColor: text('条码颜色', '#000000'), width: number('条宽', 2, 1, 4), height: number('条高', 50, 10, 400), margin: number('边距', 10, 0, 25), textPosition: select('文字位置', ['close', 'top', 'bottom'], 'bottom'), textMargin: number('文字间距', 0, -15, 40), textAlign: select('文字对齐', ['left', 'center', 'right'], 'center'), font: select('字体', ['monospace', 'sans-serif', 'serif', 'fantasy', 'cursive']), fontSize: number('文字大小', 20, 8, 36), bold: bool('粗体'), italic: bool('斜体') }, '生成 SVG，不依赖页面 Canvas。');
  add('ipcalc', 'IP 子网计算', '网络文本', ['ipv4', 'ipv6'], { targetPrefix: number('子网前缀', 64, 0, 128), ptrPrefix: number('PTR 前缀', 128, 0, 128), abbreviated: bool('缩写'), subnets: bool('列出子网'), limit: number('输出数量', 100, 1, 1000), random: bool('随机子网'), maskHosts: number('按可用地址数设置 IPv4 掩码（0 不启用）', 0, 0, 4294967294) }, '输入 CIDR；IPv4 支持整数、点分十/八/十六/二进制地址与掩码；IPv6 支持完整/缩写、PTR 与子网列表，完全本地。');
  add('urlParse', 'URL 拆分', '网络文本', ['parse'], {}, '仅解析 URL 文本，不访问地址。');
  add('httpSnippet', 'HTTP 代码生成', '网络文本', ['curl', 'fetch', 'python', 'go', 'java', 'requests'], { from: select('输入格式', ['json', 'curl', 'har']), entry: number('HAR 请求序号', 1, 1, 10000), report: bool('返回转换说明') }, '输入 cURL、HAR 或 {url, method, headers, body} JSON。requests 列出 HAR 请求序号及 URL。仅生成代码，不发送请求。');
  add('sqlFillParameter', 'SQL 参数填充', '格式与数据', ['fill'], { parameters: text('参数', '[]'), parameterFormat: select('参数格式', ['json', 'mybatis']), dialect: select('占位符', ['question', 'numbered', 'named']) }, '支持 JSON 参数和 MyBatis 类型参数；只替换字符串和注释之外的占位符，不连接数据库。');
  add('dockerCompose', 'Docker → Compose', '网络文本', ['convert'], {}, '输入 docker run 命令文本，仅生成 Compose YAML，不执行命令。');

  const byId = new Map(tools.map(item => [item.id, item]));
  function get(id) { const value = byId.get(id); if (!value) throw new Error('未知离线工具：' + id); return value; }
  function inputSchema(id) {
    const tool = get(id);
    // ARP selects the operation through its concrete URI, never a body discriminator.
    return { type: 'object', properties: {
      input: { type: 'string', maxLength: 65536 },
      options: { type: 'object', properties: tool.fields, additionalProperties: false }
    }, additionalProperties: false };
  }
  function normalize(id, input) {
    const tool = get(id), data = input || {}, options = {};
    if (typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['input', 'operation', 'options'].includes(key))) throw new Error('工具参数无效');
    if (!tool.operations.includes(data.operation)) throw new Error('不支持的操作：' + data.operation);
    if (data.input !== undefined && (typeof data.input !== 'string' || data.input.length > 65536)) throw new Error('输入必须是最多 65536 个字符的文本');
    const given = data.options === undefined ? {} : data.options;
    if (!given || typeof given !== 'object' || Array.isArray(given) || Object.keys(given).some(key => !Object.hasOwn(tool.fields, key))) throw new Error('未知工具选项');
    for (const [key, spec] of Object.entries(tool.fields)) {
      const value = Object.hasOwn(given, key) ? given[key] : spec.default;
      if (spec.type === 'integer' ? !Number.isInteger(value) || value < spec.minimum || value > spec.maximum
        : typeof value !== spec.type || spec.enum && !spec.enum.includes(value) || typeof value === 'string' && value.length > 65536) throw new Error('选项无效：' + spec.title);
      options[key] = value;
    }
    if (JSON.stringify(data).length > 100000) throw new Error('单次工具参数过大');
    return { input: data.input || '', operation: data.operation, options };
  }
  root.OfflineToolCatalog = Object.freeze({ tools, get, inputSchema, normalize });
})(globalThis);
