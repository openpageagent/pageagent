// Sample-to-type generation for Page Agent.
(function (U) {
  'use strict';
  U.toCode = function (value, language, requestedName, options = {}) {
    if (language === 'javascript') return 'export const data = ' + JSON.stringify(value, null, 2) + ';\n';
    if (language === 'php') return U.handlers.serialize(JSON.stringify(value), 'convert', { from: 'json', to: 'phpArray' });
    if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(requestedName)) throw new Error('类型名称需以英文字母开头，只含字母、数字、下划线，最多 61 字符');
    const rootName = requestedName[0].toUpperCase() + requestedName.slice(1), records = [];
    function infer(samples, name, depth = 0) {
      if (depth > 40 || records.length > 500) throw new Error('样本结构过深或类型过多');
      const kinds = new Set(samples.map(item => item === null ? 'any' : Array.isArray(item) ? 'array' : typeof item));
      if (kinds.size !== 1) return { kind: 'any' };
      const kind = [...kinds][0];
      if (kind === 'array') {
        const items = samples.flat();
        return { kind, item: items.length ? infer(items, name + 'Item', depth + 1) : { kind: 'any' } };
      }
      if (kind !== 'object') return { kind };
      const record = { kind, name, fields: [] };
      const keys = [...new Set(samples.flatMap(Object.keys))];
      for (const [index, key] of keys.entries()) {
        const present = samples.filter(item => Object.hasOwn(item, key));
        record.fields.push({ key, index, optional: present.length !== samples.length,
          type: infer(present.map(item => item[key]), name + 'Field' + (index + 1), depth + 1) });
      }
      records.push(record); return record;
    }
    let root = infer([value], rootName);
    if (root.kind !== 'object') { root = { kind: 'object', name: rootName, fields: [{ key: 'value', index: 0, optional: false, type: root }] }; records.push(root); }
    const usedNames = new Set(records.map(record => record.name));
    function reserveName(base) { let name = base, suffix = 0; while (usedNames.has(name)) name = base + 'Helper' + (++suffix === 1 ? '' : suffix); usedNames.add(name); return name; }
    const dynamicName = reserveName('JSONValue'), networkingName = reserveName('Networking');
    const swiftNames = new Map();
    for (const record of records) {
      const used = new Set();
      for (const field of record.fields) {
        const preferred = !(options.declaration === 'class' && options.nsObject) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.key) && !['_', 'self', 'Self', 'super'].includes(field.key) ? field.key : 'field' + (field.index + 1);
        let name = preferred, suffix = 1; while (used.has(name)) name = preferred + '_' + (++suffix);
        used.add(name); swiftNames.set(field, '`' + name + '`');
      }
    }
    const hasDynamic = records.some(record => record.fields.some(function dynamic(field) { return field.type.kind === 'any' || field.type.kind === 'array' && dynamic({ type: field.type.item }); }));
    const types = {
      typescript: { string: 'string', number: 'number', boolean: 'boolean', any: 'unknown' },
      java: { string: 'String', number: 'Double', boolean: 'Boolean', any: 'Object' },
      csharp: { string: 'string', number: 'double', boolean: 'bool', any: 'JsonElement' },
      go: { string: 'string', number: 'float64', boolean: 'bool', any: 'any' },
      python: { string: 'str', number: 'float', boolean: 'bool', any: 'Any' },
      protobuf: { string: 'string', number: 'double', boolean: 'bool', any: 'google.protobuf.Value' },
      rust: { string: 'String', number: 'f64', boolean: 'bool', any: 'serde_json::Value' },
      swift: { string: 'String', number: 'Double', boolean: 'Bool', any: options.plainTypes === false ? dynamicName : 'Any' },
      kotlin: { string: 'String', number: 'Double', boolean: 'Boolean', any: 'JsonElement' },
    };
    function type(item) {
      if (item.kind === 'object') return item.name;
      if (item.kind !== 'array') return types[language][item.kind] || types[language].any;
      const child = type(item.item);
      return ({ typescript: 'Array<' + child + '>', java: 'List<' + child + '>', csharp: 'List<' + child + '>', go: '[]' + child,
        python: 'list[' + child + ']', protobuf: item.item.kind === 'array' ? 'google.protobuf.Value' : 'repeated ' + child,
        rust: 'Vec<' + child + '>', swift: '[' + child + ']', kotlin: 'List<' + child + '>' })[language];
    }
    const quote = JSON.stringify;
    const swiftQuote = text => '"' + Array.from(text, char => char === '"' || char === '\\' ? '\\' + char : char.codePointAt(0) < 32 ? '\\u{' + char.codePointAt(0).toString(16) + '}' : char).join('') + '"';
    const rustQuote = text => '"' + Array.from(text, char => {
      if (char === '"' || char === '\\') return '\\' + char;
      return char.codePointAt(0) < 32 || char.codePointAt(0) === 127 ? '\\u{' + char.codePointAt(0).toString(16) + '}' : char;
    }).join('') + '"';
    // Predictable field names avoid keywords, punctuation and collisions; mappings retain original JSON keys.
    function fieldName(field) { return language === 'swift' ? swiftNames.get(field) : 'field' + (field.index + 1); }
    const blocks = records.map(record => {
      const fields = record.fields;
      if (language === 'typescript') return 'export interface ' + record.name + ' {\n' + fields.map(f => '  ' + quote(f.key) + (f.optional ? '?' : '') + ': ' + type(f.type) + ';').join('\n') + '\n}';
      if (language === 'java') return 'record ' + record.name + '(\n' + fields.map(f => '  @JsonProperty(' + quote(f.key) + ') ' + type(f.type) + ' ' + fieldName(f)).join(',\n') + '\n) {}';
      if (language === 'csharp') return 'public record ' + record.name + '(\n' + fields.map(f => '  [property: JsonPropertyName(' + quote(f.key) + ')] ' + type(f.type) + (f.optional ? '?' : '') + ' Field' + (f.index + 1)).join(',\n') + '\n);';
      if (language === 'go') return 'type ' + record.name + ' struct {\n' + fields.map(f => '  Field' + (f.index + 1) + ' ' + (f.optional ? '*' : '') + type(f.type) + ' ' + quote('json:' + quote(f.key + (f.optional ? ',omitempty' : '')))).join('\n') + '\n}';
      if (language === 'python') return record.name + ' = TypedDict(' + quote(record.name) + ', {\n' + fields.map(f => '  ' + quote(f.key) + ': ' + (f.optional ? 'NotRequired[' + type(f.type) + ']' : type(f.type))).join(',\n') + '\n})';
      if (language === 'protobuf') return 'message ' + record.name + ' {\n' + fields.map(f => '  ' + type(f.type) + ' ' + fieldName(f) + ' = ' + (f.index + 1) + ' [json_name = ' + quote(f.key) + '];').join('\n') + '\n}';
      if (language === 'rust') return '#[derive(Debug, Serialize, Deserialize)]\npub struct ' + record.name + ' {\n' + fields.map(f => '  #[serde(rename = ' + rustQuote(f.key) + ')]\n  pub field_' + (f.index + 1) + ': ' + (f.optional ? 'Option<' + type(f.type) + '>' : type(f.type)) + ',').join('\n') + '\n}';
      if (language === 'swift') {
        const codable = options.plainTypes === false, classType = options.declaration === 'class', nsObject = classType && options.nsObject;
        const inheritance = [nsObject ? 'NSObject' : '', codable ? 'Codable' : ''].filter(Boolean);
        let block = (classType ? 'final class ' : 'struct ') + record.name + (inheritance.length ? ': ' + inheritance.join(', ') : '') + ' {\n' + fields.map(f => '  ' + (options.mutable ? 'var ' : 'let ') + fieldName(f) + ': ' + type(f.type) + (f.optional ? '?' : '')).join('\n');
        if (classType || codable && options.jsonMethods) block += '\n\n  ' + (nsObject && !fields.length ? 'override ' : '') + 'init(' + fields.map(f => fieldName(f) + ': ' + type(f.type) + (f.optional ? '?' : '')).join(', ') + ') {\n' + fields.map(f => '    self.' + fieldName(f) + ' = ' + fieldName(f)).join('\n') + (nsObject ? '\n    super.init()' : '') + '\n  }';
        if (codable && (options.codingKeys || fields.some(f => fieldName(f) !== '`' + f.key + '`')) && fields.length) block += '\n\n  enum CodingKeys: String, CodingKey {\n' + fields.map(f => '    case ' + fieldName(f) + ' = ' + swiftQuote(f.key)).join('\n') + '\n  }';
        block += '\n}';
        if (codable && options.jsonMethods) {
          const initializer = classType ? 'convenience init' : 'init', assignments = fields.map(f => fieldName(f) + ': value.' + fieldName(f)).join(', ');
          block += '\n\nextension ' + record.name + ' {\n  static func fromJSON(_ data: Data) throws -> ' + record.name + ' {\n    return try JSONDecoder().decode(Self.self, from: data)\n  }\n  ' + initializer + '(data: Data) throws {\n    let value = try Self.fromJSON(data)\n    self.init(' + assignments + ')\n  }\n  ' + initializer + '(_ json: String, using encoding: String.Encoding = .utf8) throws {\n    guard let data = json.data(using: encoding) else { throw CocoaError(.fileReadInapplicableStringEncoding) }\n    try self.init(data: data)\n  }\n  ' + initializer + '(fromURL url: URL) throws {\n    try self.init(data: Data(contentsOf: url))\n  }\n  func with(' + fields.map(f => fieldName(f) + ': ' + type(f.type) + (f.optional ? '??' : '?') + ' = nil').join(', ') + ') -> ' + record.name + ' {\n    return ' + record.name + '(' + fields.map(f => fieldName(f) + ': ' + fieldName(f) + ' ?? self.' + fieldName(f)).join(', ') + ')\n  }\n  func toJSON() throws -> Data {\n    return try JSONEncoder().encode(self)\n  }\n  func jsonString(using encoding: String.Encoding = .utf8) throws -> String? {\n    return String(data: try toJSON(), encoding: encoding)\n  }\n}';
        }
        return block;
      }
      if (!fields.length) return 'class ' + record.name;
      return 'data class ' + record.name + '(\n' + fields.map(f => '  @SerialName(' + quote(f.key).replace(/\$/g, '\\$') + ') val ' + fieldName(f) + ': ' + type(f.type) + (f.optional ? '? = null' : '')).join(',\n') + '\n)';
    });
    const headers = {
      typescript: '// Types inferred from the supplied sample; unknown covers null/mixed values.\n',
      java: 'import java.util.List;\nimport com.fasterxml.jackson.annotation.JsonProperty;\n// Java 17 records, Jackson annotations.\n',
      csharp: 'using System.Collections.Generic;\nusing System.Text.Json;\nusing System.Text.Json.Serialization;\n',
      go: 'package model\n', python: 'from typing import Any, TypedDict, NotRequired\n# Python 3.11+\n',
      protobuf: 'syntax = "proto3";\nimport "google/protobuf/struct.proto";\n',
      rust: 'use serde::{Deserialize, Serialize};\n// Requires serde (derive) and serde_json.\n',
      swift: 'import Foundation\n// Swift 5. Generated from the supplied JSON sample.\n' + (options.alamofire && options.plainTypes === false ? 'import Alamofire\n' : ''),
      kotlin: 'import kotlinx.serialization.SerialName\nimport kotlinx.serialization.json.JsonElement\n',
    };
    const dynamic = language === 'swift' && options.plainTypes === false && blocks.some(block => block.includes('JSONValue')) ? '\nindirect enum JSONValue: Codable {\n  case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])\n  init(from decoder: Decoder) throws {\n    let value = try decoder.singleValueContainer()\n    if value.decodeNil() { self = .null }\n    else if let item = try? value.decode(Bool.self) { self = .bool(item) }\n    else if let item = try? value.decode(Double.self) { self = .number(item) }\n    else if let item = try? value.decode(String.self) { self = .string(item) }\n    else if let item = try? value.decode([JSONValue].self) { self = .array(item) }\n    else { self = .object(try value.decode([String: JSONValue].self)) }\n  }\n  func encode(to encoder: Encoder) throws {\n    var value = encoder.singleValueContainer()\n    switch self {\n    case .null: try value.encodeNil()\n    case .bool(let item): try value.encode(item)\n    case .number(let item): try value.encode(item)\n    case .string(let item): try value.encode(item)\n    case .array(let item): try value.encode(item)\n    case .object(let item): try value.encode(item)\n    }\n  }\n}\n' : '';
    const dynamicSource = hasDynamic ? dynamic.replace(/\bJSONValue\b/g, dynamicName) : '';
    let networking = '';
    if (language === 'swift' && options.plainTypes === false) {
      if (options.urlSession) networking += '\nextension URLSession {\n  func ' + rootName[0].toLowerCase() + rootName.slice(1) + 'Task(with url: URL, completion: @escaping (' + rootName + '?, URLResponse?, Error?) -> Void) -> URLSessionDataTask {\n    return dataTask(with: url) { data, response, error in\n      if let error = error { completion(nil, response, error); return }\n      guard let data = data else { completion(nil, response, URLError(.badServerResponse)); return }\n      do { completion(try JSONDecoder().decode(' + rootName + '.self, from: data), response, nil) }\n      catch { completion(nil, response, error) }\n    }\n  }\n}\n';
      if (options.alamofire) networking += '\n// Requires Alamofire 5.\nextension DataRequest {\n  @discardableResult\n  func response' + rootName + '(queue: DispatchQueue = .main, completionHandler: @escaping (AFDataResponse<' + rootName + '>) -> Void) -> Self {\n    return responseDecodable(of: ' + rootName + '.self, queue: queue, completionHandler: completionHandler)\n  }\n}\n';
    }
    if (language === 'swift' && options.multiFile) {
      const files = Object.fromEntries(records.map((record, index) => [record.name + '.swift', headers.swift + '\n' + blocks[index] + '\n']));
      if (dynamicSource) files[dynamicName + '.swift'] = 'import Foundation\n' + dynamicSource;
      if (networking) files[networkingName + '.swift'] = headers.swift + networking;
      return { files };
    }
    return headers[language] + '\n' + blocks.join('\n\n') + '\n' + dynamicSource + networking;
  };
})(OfflineTools);
