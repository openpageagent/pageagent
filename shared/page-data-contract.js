// Unified external contract for all model-visible Page Agent data windows.
(function attachPageDataContract(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageDataContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var API_VERSION = 2;
  var CONTRACT = 'page-data-character-window-v2';
  // Every JSON container/string needs at least two serialized characters
  // (`[]`, `{}`, or `""`). Smaller budgets cannot produce a truthful window.
  var MIN_CHARS = 2;
  var MAX_CHARS = 10000;
  var INTERNAL_SCAN_LIMIT = 10000;
  var INTERNAL_MAX_DEPTH = 8;

  function ContractError(message, details) {
    this.name = 'PageDataContractError';
    this.code = 'INVALID_REQUEST';
    this.message = String(message || 'Invalid page data window');
    this.details = Object.assign({
      contract: CONTRACT,
      unit: 'characters',
      maximumAppliedChars: MAX_CHARS,
    }, details || {});
    if (Error.captureStackTrace) Error.captureStackTrace(this, ContractError);
  }
  ContractError.prototype = Object.create(Error.prototype);
  ContractError.prototype.constructor = ContractError;

  function hasOwn(value, key) {
    return !!(value && Object.prototype.hasOwnProperty.call(value, key));
  }

  function normalizeWindow(input, label) {
    input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    label = String(label || 'Page data');
    if (!hasOwn(input, 'start') || !hasOwn(input, 'maxChars')) {
      throw new ContractError(label + ' requires explicit start and maxChars', {
        required: ['start', 'maxChars'],
      });
    }
    var start = Number(input.start);
    var maxChars = Number(input.maxChars);
    if (!Number.isInteger(start) || start < 0) {
      throw new ContractError(label + ' start must be a non-negative integer', { value: input.start });
    }
    if (!Number.isInteger(maxChars) || maxChars < MIN_CHARS) {
      throw new ContractError(label + ' maxChars must be an integer of at least ' + MIN_CHARS, {
        value: input.maxChars,
        minimum: MIN_CHARS,
      });
    }
    return Object.freeze({
      start: start,
      maxChars: Math.min(maxChars, MAX_CHARS),
    });
  }

  function inputProperties(startDescription, maxCharsDescription) {
    var liveReadStartDescription = '实时只读数据变化使 start 落入当前项内部时会保守回退，超过当前数据时返回已读完，不作为请求错误；响应 start 是实际采用的位置，后续仍只使用响应 nextStart。';
    var resolvedStartDescription = String(startDescription || '包含边界的字符起始位置，不是数组下标或对象属性序号。首次使用 0；hasMore=true 且 nextStart 不为 null 时，下一次必须把返回的 nextStart 原样作为 start，不能再次使用 0。重复读取仅在真实观察到页面或数据发生变化时才被允许。');
    if (resolvedStartDescription.indexOf(liveReadStartDescription) === -1) {
      resolvedStartDescription += ' ' + liveReadStartDescription;
    }
    return {
      start: {
        type: 'integer',
        minimum: 0,
        description: resolvedStartDescription,
      },
      maxChars: {
        type: 'integer',
        minimum: MIN_CHARS,
        description: String(maxCharsDescription
          || ('请求返回的序列化页面数据字符数。允许传入大于 ' + MAX_CHARS + ' 的值，但实际按 ' + MAX_CHARS + ' 应用。')),
      },
    };
  }

  function outputProperties() {
    return {
      start: {
        type: 'integer',
        minimum: 0,
        description: '本次响应实际使用的包含边界字符起始位置。',
      },
      maxChars: {
        type: 'integer',
        minimum: MIN_CHARS,
        maximum: MAX_CHARS,
        description: '实际应用的页面数据字符预算；不会超过 ' + MAX_CHARS + '。',
      },
      returnedChars: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_CHARS,
        description: '资源 data 字段在 maxChars 限制下实际返回的序列化字符数。',
      },
      remainingChars: {
        type: ['integer', 'null'],
        minimum: 0,
        description: '本窗口之后已知仍可读取的源数据字符数；仅当精确测量需要超出本次有界读取时为 null。',
      },
      nextStart: {
        type: ['integer', 'null'],
        minimum: 0,
        description: '下一个窗口应使用的权威字符起始位置，不是本次返回项数量；没有剩余数据时为 null。',
      },
      hasMore: {
        type: 'boolean',
        description: '当且仅当 nextStart 不为 null 时为 true。',
      },
      truncated: { type: 'boolean' },
    };
  }

  function windowGuidance(resourceLabel) {
    var label = String(resourceLabel || '页面数据');
    var outputFields = Object.keys(outputProperties()).join(', ');
    return [
      label + '使用显式的 start + maxChars 字符窗口。start 必须是非负整数；maxChars 必须是至少为 '
        + MIN_CHARS + ' 的整数。允许传入大于 ' + MAX_CHARS + ' 的值，但实际按 ' + MAX_CHARS + ' 应用。',
      'start 和 nextStart 都是字符边界位置，不是数组下标、对象属性序号或本次返回项数量。',
      '窗口响应包含 ' + outputFields + '。remainingChars=null 表示无法在本次有界读取内精确测量剩余量，不表示剩余量为零。',
      'hasMore=true 且 nextStart 不为 null 时，下一次读取必须把 nextStart 原样作为 start，这才是下一页；再次使用 start=0 只会重复第一页。重复读取仅在真实观察到页面或数据发生变化时才被允许。如果 nextStart 等于 start，保持 start 不变并增大 maxChars 后重试。hasMore=false 或 nextStart 为 null 均表示已读取完毕。',
      '只读数据在两次读取间变化时，原 start 可能落入当前结构化项内部或超过当前数据。服务会回退到不大于请求位置的最近完整项边界，最多重复相邻数据而不跳过数据；超过当前数据时返回空的已读完结果。响应 start 是本次实际采用的位置，后续仍只使用响应 nextStart。',
    ];
  }

  function inputSchema(startDescription, extraProperties, extraRequired) {
    return {
      type: 'object',
      properties: Object.assign(inputProperties(startDescription), extraProperties || {}),
      required: ['start', 'maxChars'].concat(Array.isArray(extraRequired) ? extraRequired : []),
      additionalProperties: false,
    };
  }

  function jsonChars(value) {
    try {
      var serialized = JSON.stringify(value);
      return serialized === undefined ? 0 : serialized.length;
    } catch (_) {
      return Infinity;
    }
  }

  function itemCharacterSpan(value, label) {
    var chars = jsonChars([value]);
    if (!Number.isFinite(chars)) {
      throw new ContractError(String(label || 'Page data') + ' contains an item that cannot be serialized');
    }
    return Math.max(0, chars - 2);
  }

  function itemBoundaryOffset(values, endIndex, label) {
    values = Array.isArray(values) ? values : [];
    endIndex = Number(endIndex);
    if (!Number.isInteger(endIndex) || endIndex < 0 || endIndex > values.length) {
      throw new ContractError(String(label || 'Page data') + ' item boundary is invalid', {
        value: endIndex,
        itemCount: values.length,
      });
    }
    var offset = 0;
    for (var index = 0; index < endIndex; index += 1) {
      offset += itemCharacterSpan(values[index], label);
      if (!Number.isSafeInteger(offset)) {
        throw new ContractError(String(label || 'Page data') + ' character boundary exceeds the safe integer range');
      }
    }
    return offset;
  }

  function itemBoundaryPosition(values, start, label) {
    values = Array.isArray(values) ? values : [];
    start = Number(start);
    if (!Number.isInteger(start) || start < 0) {
      throw new ContractError(String(label || 'Page data') + ' start must be a non-negative integer', {
        value: start,
      });
    }
    if (start === 0) return { index: 0, start: 0 };
    var offset = 0;
    for (var index = 0; index < values.length; index += 1) {
      var nextOffset = offset + itemCharacterSpan(values[index], label);
      if (!Number.isSafeInteger(nextOffset)) {
        throw new ContractError(String(label || 'Page data') + ' character boundary exceeds the safe integer range');
      }
      if (nextOffset === start) return { index: index + 1, start: start };
      if (nextOffset > start) return { index: index, start: offset };
      offset = nextOffset;
    }
    return { index: values.length, start: offset };
  }

  function itemBoundaryIndex(values, start, label) {
    return itemBoundaryPosition(values, start, label).index;
  }

  function propertyCharacterSpan(key, value, label) {
    var keyChars = jsonChars(String(key));
    var valueChars = itemCharacterSpan(value, label);
    if (!Number.isFinite(keyChars)) {
      throw new ContractError(String(label || 'Page data') + ' contains a property name that cannot be serialized');
    }
    return keyChars + 1 + valueChars;
  }

  function propertyBoundaryOffset(value, keys, endIndex, label) {
    var offset = 0;
    for (var index = 0; index < endIndex; index += 1) {
      offset += propertyCharacterSpan(keys[index], value[keys[index]], label);
      if (!Number.isSafeInteger(offset)) {
        throw new ContractError(String(label || 'Page data') + ' character boundary exceeds the safe integer range');
      }
    }
    return offset;
  }

  function propertyBoundaryPosition(value, keys, start, label) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    keys = Array.isArray(keys) ? keys : Object.keys(value);
    start = Number(start);
    if (!Number.isInteger(start) || start < 0) {
      throw new ContractError(String(label || 'Page data') + ' start must be a non-negative integer', {
        value: start,
      });
    }
    if (start === 0) return { index: 0, start: 0 };
    var offset = 0;
    for (var index = 0; index < keys.length; index += 1) {
      var nextOffset = offset + propertyCharacterSpan(keys[index], value[keys[index]], label);
      if (!Number.isSafeInteger(nextOffset)) {
        throw new ContractError(String(label || 'Page data') + ' character boundary exceeds the safe integer range');
      }
      if (nextOffset === start) return { index: index + 1, start: start };
      if (nextOffset > start) return { index: index, start: offset };
      offset = nextOffset;
    }
    return { index: keys.length, start: offset };
  }

  function propertyBoundaryIndex(value, keys, start, label) {
    return propertyBoundaryPosition(value, keys, start, label).index;
  }

  function windowFields(windowSpec, returnedChars, remainingChars, nextStart, truncated) {
    var hasMore = nextStart !== null;
    return {
      start: windowSpec.start,
      maxChars: windowSpec.maxChars,
      returnedChars: Math.max(0, Number(returnedChars) || 0),
      remainingChars: remainingChars === null ? null : Math.max(0, Number(remainingChars) || 0),
      hasMore: hasMore,
      nextStart: hasMore ? nextStart : null,
      truncated: !!truncated,
    };
  }

  function fitString(value, maxChars) {
    value = String(value === undefined || value === null ? '' : value);
    maxChars = Math.max(0, Math.floor(Number(maxChars) || 0));
    if (jsonChars(value) <= maxChars) return value;
    var low = 0;
    var high = value.length;
    while (low < high) {
      var middle = Math.ceil((low + high) / 2);
      if (jsonChars(value.slice(0, middle)) <= maxChars) low = middle;
      else high = middle - 1;
    }
    return value.slice(0, low);
  }

  function fitValue(value, maxChars, depth) {
    maxChars = Math.max(0, Math.floor(Number(maxChars) || 0));
    depth = Math.max(0, Number(depth) || 0);
    if (jsonChars(value) <= maxChars) return { value: value, truncated: false };
    if (maxChars <= 0) return { value: null, truncated: true };
    if (typeof value === 'string') return { value: fitString(value, maxChars), truncated: true };
    if (value === null || typeof value !== 'object' || depth >= INTERNAL_MAX_DEPTH) {
      return { value: fitString(String(value), maxChars), truncated: true };
    }
    if (Array.isArray(value)) {
      var array = [];
      for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) {
        var candidate = array.concat([value[arrayIndex]]);
        if (jsonChars(candidate) <= maxChars) {
          array = candidate;
          continue;
        }
        if (!array.length) {
          var fittedItem = fitValue(value[arrayIndex], Math.max(0, maxChars - 2), depth + 1);
          if (jsonChars([fittedItem.value]) <= maxChars) array.push(fittedItem.value);
        }
        break;
      }
      return { value: array, truncated: true };
    }
    var output = {};
    var keys = Object.keys(value);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      var key = keys[keyIndex];
      var candidateObject = Object.assign({}, output);
      candidateObject[key] = value[key];
      if (jsonChars(candidateObject) <= maxChars) {
        output = candidateObject;
        continue;
      }
      if (!Object.keys(output).length) {
        var emptyPropertyChars = jsonChars((function () { var item = {}; item[key] = null; return item; })());
        var fittedValue = fitValue(value[key], Math.max(0, maxChars - emptyPropertyChars + 4), depth + 1);
        output[key] = fittedValue.value;
        if (jsonChars(output) > maxChars) output = {};
      }
      break;
    }
    return { value: output, truncated: true };
  }

  function paginateText(value, input, label, dataKey) {
    var windowSpec = normalizeWindow(input, label);
    var text = String(value === undefined || value === null ? '' : value);
    var appliedWindowSpec = {
      start: Math.min(windowSpec.start, text.length),
      maxChars: windowSpec.maxChars,
    };
    var available = text.slice(appliedWindowSpec.start);
    var selected = fitString(available, appliedWindowSpec.maxChars);
    if (available && !selected) {
      throw new ContractError(label + ' maxChars is too small to return the next text character', {
        start: appliedWindowSpec.start,
        maxChars: appliedWindowSpec.maxChars,
      });
    }
    var end = Math.min(text.length, appliedWindowSpec.start + selected.length);
    var remainingText = text.slice(end);
    var returnedChars = jsonChars(selected);
    var remainingChars = remainingText ? jsonChars(remainingText) : 0;
    var nextStart = remainingText ? end : null;
    var output = {};
    output[String(dataKey || 'content')] = selected;
    return Object.assign(output, windowFields(
      appliedWindowSpec,
      returnedChars,
      remainingChars,
      nextStart,
      appliedWindowSpec.start > 0 || nextStart !== null
    ));
  }

  function paginateItems(values, input, label, options) {
    options = options || {};
    values = Array.isArray(values) ? values : [];
    var windowSpec = normalizeWindow(input, label);
    var startPosition = itemBoundaryPosition(values, windowSpec.start, label);
    var appliedWindowSpec = { start: startPosition.start, maxChars: windowSpec.maxChars };
    var nextIndex = startPosition.index;
    var selected = [];
    var itemTruncated = false;
    while (nextIndex < values.length) {
      var candidate = selected.concat([values[nextIndex]]);
      if (jsonChars(candidate) <= appliedWindowSpec.maxChars) {
        selected = candidate;
        nextIndex += 1;
        continue;
      }
      if (!selected.length) {
        if (options.preserveOversizedItem === true) {
          // Layered projections must keep one source fact structurally intact;
          // the model-facing adapter applies the final character budget.
          selected.push(values[nextIndex]);
          nextIndex += 1;
        } else {
          var fitted = fitValue(values[nextIndex], Math.max(0, appliedWindowSpec.maxChars - 2), 0);
          if (jsonChars([fitted.value]) <= appliedWindowSpec.maxChars) {
            selected.push(fitted.value);
            itemTruncated = true;
            nextIndex += 1;
          } else {
            throw new ContractError(label + ' maxChars is too small to return the item at start', {
              start: appliedWindowSpec.start,
              maxChars: appliedWindowSpec.maxChars,
            });
          }
        }
      }
      break;
    }
    var sourceTruncated = options.sourceTruncated === true;
    var hasKnownRemaining = !sourceTruncated;
    var hasMore = nextIndex < values.length;
    var nextOffset = itemBoundaryOffset(values, nextIndex, label);
    var remainingChars = hasKnownRemaining
      ? itemBoundaryOffset(values, values.length, label) - nextOffset
      : null;
    var nextStart = hasMore ? nextOffset : null;
    var output = {};
    output[String(options.dataKey || 'items')] = selected;
    return Object.assign(output, windowFields(
      appliedWindowSpec,
      jsonChars(selected),
      remainingChars,
      nextStart,
      appliedWindowSpec.start > 0 || hasMore || sourceTruncated || itemTruncated
    ));
  }

  function paginateObject(value, input, label, options) {
    options = options || {};
    value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var windowSpec = normalizeWindow(input, label);
    var keys = Object.keys(value);
    var startPosition = propertyBoundaryPosition(value, keys, windowSpec.start, label);
    var appliedWindowSpec = { start: startPosition.start, maxChars: windowSpec.maxChars };
    var nextIndex = startPosition.index;
    var selected = {};
    var itemTruncated = false;
    while (nextIndex < keys.length) {
      var key = keys[nextIndex];
      var candidate = Object.assign({}, selected);
      candidate[key] = value[key];
      if (jsonChars(candidate) <= appliedWindowSpec.maxChars) {
        selected = candidate;
        nextIndex += 1;
        continue;
      }
      if (!Object.keys(selected).length) {
        var empty = {};
        empty[key] = null;
        var fitted = fitValue(value[key], Math.max(0, appliedWindowSpec.maxChars - jsonChars(empty) + 4), 0);
        selected[key] = fitted.value;
        if (jsonChars(selected) <= appliedWindowSpec.maxChars) {
          itemTruncated = true;
          nextIndex += 1;
        } else {
          throw new ContractError(label + ' maxChars is too small to return the property at start', {
            start: appliedWindowSpec.start,
            maxChars: appliedWindowSpec.maxChars,
          });
        }
      }
      break;
    }
    var nextOffset = propertyBoundaryOffset(value, keys, nextIndex, label);
    var nextStart = nextIndex < keys.length ? nextOffset : null;
    var output = {};
    output[String(options.dataKey || 'value')] = selected;
    return Object.assign(output, windowFields(
      appliedWindowSpec,
      jsonChars(selected),
      nextStart === null ? 0 : propertyBoundaryOffset(value, keys, keys.length, label) - nextOffset,
      nextStart,
      appliedWindowSpec.start > 0 || nextStart !== null || itemTruncated
    ));
  }

  function paginateValue(value, input, label, options) {
    options = options || {};
    var dataKey = String(options.dataKey || 'value');
    if (typeof value === 'string') return paginateText(value, input, label, dataKey);
    if (Array.isArray(value)) return paginateItems(value, input, label, Object.assign({}, options, { dataKey: dataKey }));
    if (value && typeof value === 'object') return paginateObject(value, input, label, Object.assign({}, options, { dataKey: dataKey }));
    var windowSpec = normalizeWindow(input, label);
    var startPosition = itemBoundaryPosition([value], windowSpec.start, label);
    var appliedWindowSpec = { start: startPosition.start, maxChars: windowSpec.maxChars };
    var returned = startPosition.index === 0 ? value : null;
    var returnedChars = startPosition.index === 0 ? jsonChars(returned) : 0;
    if (returnedChars > appliedWindowSpec.maxChars) {
      throw new ContractError(label + ' maxChars is too small to return the scalar value', {
        start: appliedWindowSpec.start,
        maxChars: appliedWindowSpec.maxChars,
        requiredChars: returnedChars,
      });
    }
    var output = {};
    output[dataKey] = returned;
    return Object.assign(output, windowFields(appliedWindowSpec, returnedChars, 0, null, appliedWindowSpec.start > 0));
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    CONTRACT: CONTRACT,
    MIN_CHARS: MIN_CHARS,
    MAX_CHARS: MAX_CHARS,
    INTERNAL_SCAN_LIMIT: INTERNAL_SCAN_LIMIT,
    INTERNAL_MAX_DEPTH: INTERNAL_MAX_DEPTH,
    ContractError: ContractError,
    normalizeWindow: normalizeWindow,
    inputProperties: inputProperties,
    inputSchema: inputSchema,
    outputProperties: outputProperties,
    windowGuidance: windowGuidance,
    jsonChars: jsonChars,
    itemCharacterSpan: itemCharacterSpan,
    itemBoundaryOffset: itemBoundaryOffset,
    itemBoundaryPosition: itemBoundaryPosition,
    itemBoundaryIndex: itemBoundaryIndex,
    propertyBoundaryPosition: propertyBoundaryPosition,
    windowFields: windowFields,
    fitValue: fitValue,
    paginateText: paginateText,
    paginateItems: paginateItems,
    paginateObject: paginateObject,
    paginateValue: paginateValue,
  });
});
