// Pure MCP tool definition, argument, and result contracts.
(function attachMcpToolContract(root, factory) {
  'use strict';

  function isContractApi(value) {
    return !!(value
      && typeof value.createDefinitionCatalog === 'function'
      && typeof value.validateToolArguments === 'function'
      && typeof value.normalizeToolResult === 'function');
  }

  var existing = root && root.McpToolContract;
  if (isContractApi(existing)) {
    if (typeof module === 'object' && module.exports) module.exports = existing;
    return;
  }

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.McpToolContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function hasOwn(value, key) {
    return !!(value
      && (typeof value === 'object' || typeof value === 'function')
      && Object.prototype.hasOwnProperty.call(value, key));
  }

  function ownValue(value, key) {
    return hasOwn(value, key) ? value[key] : undefined;
  }

  function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }

  function cloneValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function stableValue(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('Cannot stringify circular MCP value');
    seen.push(value);
    var out;
    if (Array.isArray(value)) {
      out = value.map(function (item) { return stableValue(item, seen); });
    } else {
      out = Object.create(null);
      Object.keys(value).sort().forEach(function (key) {
        out[key] = stableValue(value[key], seen);
      });
    }
    seen.pop();
    return out;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function createDefinitionCatalog(definitions) {
    var source = Array.isArray(definitions) ? cloneValue(definitions) : [];
    var byName = Object.create(null);
    source.forEach(function (definition, index) {
      var name = String(definition && definition.name !== undefined ? definition.name : '').trim();
      if (!name) throw new Error('MCP tool definition #' + index + ' is missing name');
      if (hasOwn(byName, name)) throw new Error('Duplicate MCP tool definition: ' + name);
      definition.name = name;
      byName[name] = definition;
    });

    function list(names) {
      var wanted = Array.isArray(names) && names.length ? new Set(names.map(String)) : null;
      return source.filter(function (definition) {
        return !wanted || wanted.has(definition.name);
      }).map(cloneValue);
    }

    function get(name) {
      name = String(name === undefined || name === null ? '' : name);
      return hasOwn(byName, name) ? cloneValue(byName[name]) : null;
    }

    function has(name) {
      name = String(name === undefined || name === null ? '' : name);
      return hasOwn(byName, name);
    }

    return {
      get: get,
      has: has,
      list: list,
      names: function () { return source.map(function (definition) { return definition.name; }); },
    };
  }

  function jsonEqual(left, right) {
    try { return stableStringify(left) === stableStringify(right); } catch (_) { return left === right; }
  }

  function decodePointerPart(value) {
    return String(value || '').replace(/~1/g, '/').replace(/~0/g, '~');
  }

  function resolveLocalRef(rootSchema, ref) {
    if (typeof ref !== 'string' || ref.indexOf('#/') !== 0) return null;
    var current = rootSchema;
    var parts = ref.slice(2).split('/').map(decodePointerPart);
    for (var i = 0; i < parts.length; i++) {
      if (!hasOwn(current, parts[i])) return null;
      current = current[parts[i]];
    }
    return current;
  }

  function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
    return typeof value;
  }

  function matchesType(type, value) {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return isRecord(value);
    if (type === 'integer') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  }

  function expectedTypes(schema) {
    if (Array.isArray(schema && schema.type)) return schema.type.map(String);
    if (schema && schema.type !== undefined) return [String(schema.type)];
    return [];
  }

  function validateSchema(schema, value, path, errors, rootSchema, refTrail) {
    if (schema === true || schema === undefined || schema === null) return errors;
    if (schema === false) {
      errors.push(path + ' is rejected by schema');
      return errors;
    }
    if (!isRecord(schema)) return errors;

    if (value === undefined) {
      errors.push(path + ' cannot be undefined');
      return errors;
    }
    var primitiveType = typeof value;
    if (primitiveType === 'bigint' || primitiveType === 'function' || primitiveType === 'symbol') {
      errors.push(path + ' is not a JSON value');
      return errors;
    }
    if (primitiveType === 'number' && !Number.isFinite(value)) {
      errors.push(path + ' must be a finite number');
      return errors;
    }

    refTrail = refTrail || [];
    if (schema.$ref) {
      if (refTrail.indexOf(schema.$ref) !== -1) {
        errors.push(path + ' contains a circular $ref: ' + schema.$ref);
        return errors;
      }
      var resolved = resolveLocalRef(rootSchema, schema.$ref);
      if (!resolved) {
        errors.push(path + ' has an unresolved $ref: ' + schema.$ref);
        return errors;
      }
      validateSchema(resolved, value, path, errors, rootSchema, refTrail.concat(schema.$ref));
    }

    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach(function (branch) {
        validateSchema(branch, value, path, errors, rootSchema, refTrail);
      });
    }
    if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
      var anyMatches = schema.anyOf.some(function (branch) {
        return validateSchema(branch, value, path, [], rootSchema, refTrail).length === 0;
      });
      if (!anyMatches) errors.push(path + ' does not match anyOf');
    }
    if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
      var oneMatches = schema.oneOf.reduce(function (count, branch) {
        return count + (validateSchema(branch, value, path, [], rootSchema, refTrail).length === 0 ? 1 : 0);
      }, 0);
      if (oneMatches !== 1) errors.push(path + ' must match exactly one oneOf branch');
    }
    if (schema.not && validateSchema(schema.not, value, path, [], rootSchema, refTrail).length === 0) {
      errors.push(path + ' matches a forbidden not schema');
    }

    if (hasOwn(schema, 'const') && !jsonEqual(value, schema.const)) {
      errors.push(path + ' must equal const');
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(function (item) { return jsonEqual(value, item); })) {
      errors.push(path + ' must be one of enum');
    }

    var types = expectedTypes(schema);
    if (types.length && !types.some(function (type) { return matchesType(type, value); })) {
      errors.push(path + ' must be ' + types.join('|') + ', got ' + valueType(value));
      return errors;
    }

    if (typeof value === 'string') {
      if (Number.isFinite(Number(schema.minLength)) && value.length < Number(schema.minLength)) {
        errors.push(path + ' is shorter than minLength ' + schema.minLength);
      }
      if (Number.isFinite(Number(schema.maxLength)) && value.length > Number(schema.maxLength)) {
        errors.push(path + ' is longer than maxLength ' + schema.maxLength);
      }
      if (schema.pattern !== undefined) {
        try {
          if (!(new RegExp(String(schema.pattern))).test(value)) errors.push(path + ' does not match pattern ' + schema.pattern);
        } catch (_) {
          errors.push(path + ' has invalid schema pattern ' + schema.pattern);
        }
      }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      if (schema.minimum !== undefined && value < Number(schema.minimum)) errors.push(path + ' is below minimum ' + schema.minimum);
      if (schema.maximum !== undefined && value > Number(schema.maximum)) errors.push(path + ' is above maximum ' + schema.maximum);
      if (schema.exclusiveMinimum !== undefined && value <= Number(schema.exclusiveMinimum)) errors.push(path + ' must exceed ' + schema.exclusiveMinimum);
      if (schema.exclusiveMaximum !== undefined && value >= Number(schema.exclusiveMaximum)) errors.push(path + ' must be below ' + schema.exclusiveMaximum);
      if (schema.multipleOf !== undefined && Number(schema.multipleOf) > 0 && value % Number(schema.multipleOf) !== 0) {
        errors.push(path + ' must be a multiple of ' + schema.multipleOf);
      }
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < Number(schema.minItems)) errors.push(path + ' has fewer than minItems ' + schema.minItems);
      if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) errors.push(path + ' has more than maxItems ' + schema.maxItems);
      if (schema.uniqueItems === true) {
        var unique = Object.create(null);
        value.forEach(function (item, index) {
          var key;
          try { key = stableStringify(item); } catch (_) { key = 'index:' + index; }
          if (hasOwn(unique, key)) errors.push(path + '[' + index + '] violates uniqueItems');
          else unique[key] = true;
        });
      }
      if (Array.isArray(schema.prefixItems)) {
        schema.prefixItems.forEach(function (itemSchema, index) {
          if (index < value.length) validateSchema(itemSchema, value[index], path + '[' + index + ']', errors, rootSchema, refTrail);
        });
      }
      if (schema.items && !Array.isArray(schema.items)) {
        value.forEach(function (item, index) {
          validateSchema(schema.items, item, path + '[' + index + ']', errors, rootSchema, refTrail);
        });
      }
    }

    if (isRecord(value)) {
      var properties = isRecord(schema.properties) ? schema.properties : {};
      var required = Array.isArray(schema.required) ? schema.required : [];
      required.forEach(function (key) {
        if (!hasOwn(value, key)) errors.push(path + '.' + key + ' is required');
      });
      Object.keys(properties).forEach(function (key) {
        if (hasOwn(value, key)) validateSchema(properties[key], value[key], path + '.' + key, errors, rootSchema, refTrail);
      });

      var patterns = isRecord(schema.patternProperties) ? schema.patternProperties : {};
      Object.keys(value).forEach(function (key) {
        if (hasOwn(UNSAFE_KEYS, key)) {
          errors.push(path + '.' + key + ' is forbidden');
          return;
        }
        if (hasOwn(properties, key)) return;
        var matchedPattern = false;
        Object.keys(patterns).forEach(function (pattern) {
          var matches = false;
          try { matches = (new RegExp(pattern)).test(key); } catch (_) {}
          if (!matches) return;
          matchedPattern = true;
          validateSchema(patterns[pattern], value[key], path + '.' + key, errors, rootSchema, refTrail);
        });
        if (matchedPattern) return;
        if (schema.additionalProperties === false) {
          errors.push(path + '.' + key + ' is forbidden by additionalProperties=false');
        } else if (isRecord(schema.additionalProperties)) {
          validateSchema(schema.additionalProperties, value[key], path + '.' + key, errors, rootSchema, refTrail);
        }
      });
      if (schema.minProperties !== undefined && Object.keys(value).length < Number(schema.minProperties)) {
        errors.push(path + ' has fewer than minProperties ' + schema.minProperties);
      }
      if (schema.maxProperties !== undefined && Object.keys(value).length > Number(schema.maxProperties)) {
        errors.push(path + ' has more than maxProperties ' + schema.maxProperties);
      }
    }
    return errors;
  }

  function normalizeJsonValue(value, path, seen) {
    if (value === null || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError(path + ' contains a circular value');
    seen.push(value);
    var out;
    if (Array.isArray(value)) {
      out = value.map(function (item, index) { return normalizeJsonValue(item, path + '[' + index + ']', seen); });
    } else {
      out = Object.create(null);
      Object.keys(value).forEach(function (key) {
        if (hasOwn(UNSAFE_KEYS, key)) throw new TypeError(path + '.' + key + ' is forbidden');
        out[key] = normalizeJsonValue(value[key], path + '.' + key, seen);
      });
    }
    seen.pop();
    return out;
  }

  function validateToolArguments(tool, args) {
    tool = tool && typeof tool === 'object' ? tool : {};
    var value = args === undefined ? Object.create(null) : args;
    var schema = tool.inputSchema || { type: 'object', additionalProperties: true };
    var errors = validateSchema(schema, value, '$', [], schema, []);
    if (errors.length) {
      var error = new TypeError('MCP tool ' + String(tool.name || '') + ' 参数无效: ' + errors.join('; '));
      error.code = 'MCP_INVALID_TOOL_ARGUMENTS';
      error.errorKind = 'argument_or_schema';
      error.retryable = true;
      error.details = errors.slice();
      throw error;
    }
    return normalizeJsonValue(value, '$', []);
  }

  function jsonText(value) {
    var payload = value === undefined ? null : value;
    var text = JSON.stringify(payload, null, 2);
    return text === undefined ? 'null' : text;
  }

  function normalizeOutcome(value) {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
      var shapeError = new TypeError('MCP tool outcome 必须显式提供 boolean success');
      shapeError.errorKind = 'tool_protocol_error';
      shapeError.retryable = false;
      throw shapeError;
    }
    var success = value.success;
    var outcome = { success: success };
    if (!success) {
      if (typeof value.errorKind !== 'string' || !value.errorKind.trim() || typeof value.retryable !== 'boolean') {
        var failureShapeError = new TypeError('失败的 MCP tool outcome 必须显式提供 errorKind 和 boolean retryable');
        failureShapeError.errorKind = 'tool_protocol_error';
        failureShapeError.retryable = false;
        throw failureShapeError;
      }
      outcome.errorKind = value.errorKind.trim();
      outcome.retryable = value.retryable;
    }
    return outcome;
  }

  function makeJsonContent(value, title, outcomeInput) {
    var payload = value === undefined ? null : value;
    if (title && isRecord(payload)) {
      var titled = Object.create(null);
      titled.title = title;
      Object.keys(payload).forEach(function (key) { titled[key] = payload[key]; });
      payload = titled;
    }
    var outcome = normalizeOutcome(outcomeInput);
    return {
      content: [{ type: 'text', text: jsonText(payload) }],
      isError: !outcome.success,
      success: outcome.success,
      ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
      ...(typeof outcome.retryable === 'boolean' ? { retryable: outcome.retryable } : {}),
    };
  }

  function contentText(response) {
    var content = response && response.content;
    if (!Array.isArray(content) || !content.length || !content[0] || !hasOwn(content[0], 'text')) return '';
    var value = content[0].text;
    return value === undefined || value === null ? '' : String(value);
  }

  function parseJsonContent(response) {
    var text = contentText(response);
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function normalizeToolResult(value) {
    if (!isRecord(value) || !Array.isArray(value.content)) {
      var error = new TypeError('MCP tool handler 必须返回显式 outcome 的 content result');
      error.errorKind = 'tool_protocol_error';
      error.retryable = false;
      throw error;
    }
    var out = Object.assign({}, value);
    out.content = value.content.map(function (item) {
      if (!isRecord(item) || item.type !== 'text') return item;
      var next = Object.assign({}, item);
      if (typeof next.text !== 'string') {
        next.text = next.text === undefined || next.text === null ? '' : String(next.text);
      }
      return next;
    });
    var outcome = normalizeOutcome(value);
    out.success = outcome.success;
    out.isError = !outcome.success;
    if (outcome.errorKind) out.errorKind = outcome.errorKind;
    else delete out.errorKind;
    if (typeof outcome.retryable === 'boolean') out.retryable = outcome.retryable;
    else delete out.retryable;
    return out;
  }

  return {
    cloneValue: cloneValue,
    contentText: contentText,
    createDefinitionCatalog: createDefinitionCatalog,
    hasOwn: hasOwn,
    makeJsonContent: makeJsonContent,
    normalizeOutcome: normalizeOutcome,
    normalizeToolResult: normalizeToolResult,
    ownValue: ownValue,
    parseJsonContent: parseJsonContent,
    stableStringify: stableStringify,
    validateJsonSchema: function (schema, value) {
      return validateSchema(schema, value, '$', [], schema || {}, []);
    },
    validateToolArguments: validateToolArguments,
  };
});
