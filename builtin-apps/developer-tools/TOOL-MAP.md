# 工具资源、脚本方法与流程节点对应表

本表按当前工作区静态核对：52 类工具、136 个操作。每个操作独立注册 POST 资源；表中的 `{a,b}` 是多个地址的缩写，不是通配路由。路径使用小写连字符命名，工具 ID、脚本方法和流程节点保留原名，例如 `qrCode` 对应 `/utilities/qr-code`、`toCode` 对应 `/to-code`。请求体只有 `input`、`options`，不传 `operation`。例如直接 `POST /utilities/base64/encode`，body 为 `{"input":"abc"}`，无需先 list；只有契约未知时才 OPTIONS 具体地址。`GET /utilities` 和 GET 工具详情地址通过 `operationUris` 列出执行地址。

脚本方法均省略 `api.utilities.` 前缀；例如 `base64.{encode, decode}()` 表示两个独立方法 `api.utilities.base64.encode(input, options)` 和 `api.utilities.base64.decode(input, options)`。所有方法直接返回计算值，不要求先调用 `list()`。

每行的工具 ID 固定对应 `OfflineTools.handlers[工具 ID]` 处理函数。流程编辑器的「开发者工具箱」是分类；分类中的每个节点有自己的类型、参数与执行路由，配置节点不需要另填工具 ID。算法处理器按职责放在对应文件，共用参数校验、Worker 调度、超时和取消机制。

| 工具 ID | POST 资源路径 | 直接脚本方法 | 流程节点类型 | 处理器文件 |
| --- | --- | --- | --- | --- |
| `hash` | `/utilities/hash/digest` | `hash()` | `utilityHash` | `cryptography.js` |
| `hmac` | `/utilities/hmac/digest` | `hmac()` | `utilityHmac` | `cryptography.js` |
| `aes` | `/utilities/aes/{encrypt,decrypt}` | `aes.{encrypt, decrypt}()` | `utilityAes` | `cryptography.js` |
| `des` | `/utilities/des/{encrypt,decrypt}` | `des.{encrypt, decrypt}()` | `utilityDes` | `cryptography.js` |
| `tripleDes` | `/utilities/triple-des/{encrypt,decrypt}` | `tripleDes.{encrypt, decrypt}()` | `utilityTripleDes` | `cryptography.js` |
| `rc4` | `/utilities/rc4/{encrypt,decrypt}` | `rc4.{encrypt, decrypt}()` | `utilityRc4` | `cryptography.js` |
| `rabbit` | `/utilities/rabbit/{encrypt,decrypt}` | `rabbit.{encrypt, decrypt}()` | `utilityRabbit` | `cryptography.js` |
| `sm2` | `/utilities/sm2/{keypair,encrypt,decrypt,sign,verify}` | `sm2.{keypair, encrypt, decrypt, sign, verify}()` | `utilitySm2` | `cryptography.js` |
| `sm4` | `/utilities/sm4/{encrypt,decrypt}` | `sm4.{encrypt, decrypt}()` | `utilitySm4` | `cryptography.js` |
| `rsa` | `/utilities/rsa/{keypair,encrypt,decrypt}` | `rsa.{keypair, encrypt, decrypt}()` | `utilityRsa` | `cryptography.js` |
| `sign` | `/utilities/sign/{keypair,sign,verify}` | `sign.{keypair, sign, verify}()` | `utilitySign` | `cryptography.js` |
| `bcrypt` | `/utilities/bcrypt/{hash,verify}` | `bcrypt.{hash, verify}()` | `utilityBcrypt` | `cryptography.js` |
| `dataValidation` | `/utilities/data-validation/checksum` | `dataValidation()` | `utilityDataValidation` | `cryptography.js` |
| `base64` | `/utilities/base64/{encode,decode}` | `base64.{encode, decode}()` | `utilityBase64` | `encoding.js` |
| `base64Image` | `/utilities/base64-image/{encode,decode}` | `base64Image.{encode, decode}()` | `utilityBase64Image` | `encoding.js` |
| `backslash` | `/utilities/backslash/{escape,unescape}` | `backslash.{escape, unescape}()` | `utilityBackslash` | `encoding.js` |
| `svgToCss` | `/utilities/svg-to-css/convert` | `svgToCss()` | `utilitySvgToCss` | `encoding.js` |
| `url` | `/utilities/url/{encode,decode}` | `url.{encode, decode}()` | `utilityUrl` | `encoding.js` |
| `unicode` | `/utilities/unicode/{encode,decode}` | `unicode.{encode, decode}()` | `utilityUnicode` | `encoding.js` |
| `hexString` | `/utilities/hex-string/{encode,decode}` | `hexString.{encode, decode}()` | `utilityHexString` | `encoding.js` |
| `html` | `/utilities/html/{encode,decode}` | `html.{encode, decode}()` | `utilityHtml` | `encoding.js` |
| `gzip` | `/utilities/gzip/{encode,decode}` | `gzip.{encode, decode}()` | `utilityGzip` | `encoding.js` |
| `punycode` | `/utilities/punycode/{encode,decode}` | `punycode.{encode, decode}()` | `utilityPunycode` | `encoding.js` |
| `jwt` | `/utilities/jwt/decode` | `jwt()` | `utilityJwt` | `encoding.js` |
| `asn1` | `/utilities/asn1/decode` | `asn1()` | `utilityAsn1` | `encoding.js` |
| `json` | `/utilities/json/{format,minify,sort,escape,unescape,repair,jsonpath,jmespath,schema,to-code,rename,unicode}` | `json.{format, minify, sort, escape, unescape, repair, jsonpath, jmespath, schema, toCode, rename, unicode}()` | `utilityJson` | `data.js` |
| `serialize` | `/utilities/serialize/convert` | `serialize()` | `utilitySerialize` | `serialization.js` |
| `code` | `/utilities/code/{format,minify}` | `code.{format, minify}()` | `utilityCode` | `data.js` |
| `diffs` | `/utilities/diffs/{lines,words,characters}` | `diffs.{lines, words, characters}()` | `utilityDiffs` | `data.js` |
| `regex` | `/utilities/regex/{match,replace,split}` | `regex.{match, replace, split}()` | `utilityRegex` | `encoding.js` |
| `text` | `/utilities/text/{statistics,dedupe,sort,reverse,trim,upper,lower,remove-empty,transform}` | `text.{statistics, dedupe, sort, reverse, trim, upper, lower, removeEmpty, transform}()` | `utilityText` | `encoding.js` |
| `variableConversion` | `/utilities/variable-conversion/{camel,pascal,snake,kebab,constant,words}` | `variableConversion.{camel, pascal, snake, kebab, constant, words}()` | `utilityVariableConversion` | `encoding.js` |
| `pinyin` | `/utilities/pinyin/convert` | `pinyin()` | `utilityPinyin` | `generators.js` |
| `zhNumber` | `/utilities/zh-number/{lower,upper,money,decode,convert}` | `zhNumber.{lower, upper, money, decode, convert}()` | `utilityZhNumber` | `generators.js` |
| `ascii` | `/utilities/ascii/{table,encode,decode,convert}` | `ascii.{table, encode, decode, convert}()` | `utilityAscii` | `encoding.js` |
| `radix` | `/utilities/radix/{convert,all}` | `radix()`、`radix.{convert, all}()` | `utilityRadix` | `encoding.js` |
| `binary` | `/utilities/binary/convert` | `binary()` | `utilityBinary` | `encoding.js` |
| `unit` | `/utilities/unit/{convert,groups}` | `unit()`、`unit.{convert, groups}()` | `utilityUnit` | `generators.js` |
| `time` | `/utilities/time/{timestamp,timezone,add,difference,now,analyze}` | `time.{timestamp, timezone, add, difference, now, analyze}()` | `utilityTime` | `encoding.js` |
| `crontab` | `/utilities/crontab/{describe,next}` | `crontab.{describe, next}()` | `utilityCrontab` | `generators.js` |
| `color` | `/utilities/color/convert` | `color()` | `utilityColor` | `generators.js` |
| `uuid` | `/utilities/uuid/{v1,v3,v4,v5,v6,v7,validate,format}` | `uuid.{v1, v3, v4, v5, v6, v7, validate, format}()` | `utilityUuid` | `generators.js` |
| `ulid` | `/utilities/ulid/{generate,decode,format}` | `ulid.{generate, decode, format}()` | `utilityUlid` | `generators.js` |
| `loremIpsum` | `/utilities/lorem-ipsum/generate` | `loremIpsum()` | `utilityLoremIpsum` | `generators.js` |
| `randomString` | `/utilities/random-string/{generate,format}` | `randomString()`、`randomString.{generate, format}()` | `utilityRandomString` | `generators.js` |
| `qrCode` | `/utilities/qr-code/{generate,parse}` | `qrCode.{generate, parse}()` | `utilityQrCode` | `generators.js` |
| `barcode` | `/utilities/barcode/generate` | `barcode()` | `utilityBarcode` | `generators.js` |
| `ipcalc` | `/utilities/ipcalc/{ipv4,ipv6}` | `ipcalc.{ipv4, ipv6}()` | `utilityIpcalc` | `encoding.js` |
| `urlParse` | `/utilities/url-parse/parse` | `urlParse()` | `utilityUrlParse` | `encoding.js` |
| `httpSnippet` | `/utilities/http-snippet/{curl,fetch,python,go,java,requests}` | `httpSnippet.{curl, fetch, python, go, java, requests}()` | `utilityHttpSnippet` | `generators.js` |
| `sqlFillParameter` | `/utilities/sql-fill-parameter/fill` | `sqlFillParameter()` | `utilitySqlFillParameter` | `data.js` |
| `dockerCompose` | `/utilities/docker-compose/convert` | `dockerCompose()` | `utilityDockerCompose` | `generators.js` |

参数与操作定义见 [catalog.js](../../utilities/catalog.js)。处理器文件位于 [cryptography.js](../../utilities/cryptography.js)、[encoding.js](../../utilities/encoding.js)、[data.js](../../utilities/data.js)、[serialization.js](../../utilities/serialization.js)、[generators.js](../../utilities/generators.js)。

脚本方法由 [sandbox.js](../../sandbox/sandbox.js) 在本地绑定；节点由 [node-types.js](../../flows/node-types.js) 定义，由 [node-dispatcher.js](../../background/node-dispatcher.js) 逐个登记路由，最终交给 [worker.js](../../utilities/worker.js) 选择对应处理器。没有运行算法、浏览器或流程测试；本表说明静态接入关系。

## 对话接入复核（2026-10-18）

- [utility-resource.js](../../resources/modules/utility-resource.js) 根据目录为 136 个操作逐个注册固定路径和 POST 处理器。操作由 URI 选择，路径片段使用小写连字符；52 个工具详情资源继续支持 GET。
- 两个应用均使用目录中的 `operationUris` 直接执行。对话、应用、脚本和流程最终调用同一工具处理器；脚本与节点内部的 operation 参数不是 ARP 请求体，保留现有合同。
- 系统默认权限包括 `utilities.read`、`utilities.execute` 及 `/utilities` 的 GET/POST/OPTIONS。资源发现、对话授权与结果投影没有排除任何工具；入口权限上限仍生效。
- 52 类计算工具均有算法处理器、脚本方法、流程节点和对应操作资源。二维码默认返回 SVG，也可用 `imageFormat: png` 返回 Base64 编码的 PNG 文件内容；条形码返回 SVG。Base64 图片返回编码文本或 data URL，不能把返回数据等同于在对话中自动显示预览。
- **页面功能边界**：Developer Utils 的 HTML 预览和 Markdown 预览只在应用页面渲染，没有对应的 `/utilities` 资源、脚本方法或流程节点，不计入 52 类计算工具。`/utilities/html` 是实体编解码；`/utilities/code/format` 可格式化 Markdown，两者都不是预览接口。
- 本次仅检查当前工作区的契约、调用链、目录覆盖、导入路径、语法及 JSON。没有启动插件、调用算法、编译或执行测试，因此不宣称运行时及算法结果已验证。
