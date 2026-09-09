// flow-data.js — FlowData 数据结构工具库
// 将数据分为 attributes（元数据）和 content（内容）
(function attachFlowData(root, factory) {
  root.FlowData = factory();
})(globalThis, function () {
  'use strict';

  // FlowData 标记符号（用于快速识别）
  var FLOW_DATA_MARKER = '__isFlowData';

  function ownDataDescriptor(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor : null;
  }

  function safeAttributeKey(key) {
    return typeof key === 'string' && key.length > 0
      && key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
  }

  function copyAttributeData() {
    var output = {};
    for (var sourceIndex = 0; sourceIndex < arguments.length; sourceIndex++) {
      var source = arguments[sourceIndex];
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      Object.keys(source).forEach(function (key) {
        if (!safeAttributeKey(key)) throw new Error('FlowData attribute 不能使用原型保留字段: ' + key);
        var descriptor = ownDataDescriptor(source, key);
        if (!descriptor) return;
        Object.defineProperty(output, key, {
          value: descriptor.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
    }
    return output;
  }

  /**
   * 创建 FlowData 对象
   * @param {*} content - 实际数据内容
   * @param {Object} attributes - 元数据键值对（可选）
   * @returns {Object} FlowData 对象
   */
  function createFlowData(content, attributes) {
    var flowData = {
      attributes: copyAttributeData(attributes || {}),
      content: content,
    };
    // 添加快速识别标记（不可枚举，避免序列化）
    Object.defineProperty(flowData, FLOW_DATA_MARKER, {
      value: true,
      enumerable: false,
      writable: false,
    });
    return flowData;
  }

  /**
   * 判断对象是否为 FlowData
   * @param {*} obj - 待检测对象
   * @returns {boolean}
   */
  function isFlowData(obj) {
    if (!obj || typeof obj !== 'object') return false;
    // 优先使用快速标记
    var marker = ownDataDescriptor(obj, FLOW_DATA_MARKER);
    if (marker && marker.value === true) return true;
    // 降级检测：结构匹配
    var attributes = ownDataDescriptor(obj, 'attributes');
    var content = ownDataDescriptor(obj, 'content');
    return !!(attributes && content && attributes.value && typeof attributes.value === 'object');
  }

  /**
   * 提取 content（实际数据）
   * @param {Object} flowData - FlowData 对象
   * @returns {*} 内容数据，如果不是 FlowData 则返回原值
   */
  function getContent(flowData) {
    if (isFlowData(flowData)) {
      return ownDataDescriptor(flowData, 'content').value;
    }
    return flowData; // 非 FlowData，直接返回
  }

  /**
   * 提取 attributes（元数据）
   * @param {Object} flowData - FlowData 对象
   * @returns {Object} 属性对象，如果不是 FlowData 则返回空对象
   */
  function getAttributes(flowData) {
    if (isFlowData(flowData)) {
      return ownDataDescriptor(flowData, 'attributes').value || {};
    }
    return {}; // 非 FlowData，返回空对象
  }

  /**
   * 添加或修改 attribute（返回新 FlowData，不修改原对象）
   * @param {Object} flowData - FlowData 对象
   * @param {string} key - 属性键
   * @param {*} value - 属性值
   * @returns {Object} 新的 FlowData 对象
   */
  function addAttribute(flowData, key, value) {
    if (!isFlowData(flowData)) {
      throw new Error('addAttribute 需要 FlowData 对象');
    }
    if (!safeAttributeKey(key)) throw new Error('FlowData attribute 不能使用原型保留字段: ' + key);
    var newAttributes = copyAttributeData(getAttributes(flowData));
    Object.defineProperty(newAttributes, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return createFlowData(getContent(flowData), newAttributes);
  }

  /**
   * 批量添加 attributes（返回新 FlowData）
   * @param {Object} flowData - FlowData 对象
   * @param {Object} attributesToAdd - 要添加的属性键值对
   * @returns {Object} 新的 FlowData 对象
   */
  function addAttributes(flowData, attributesToAdd) {
    if (!isFlowData(flowData)) {
      throw new Error('addAttributes 需要 FlowData 对象');
    }
    var newAttributes = copyAttributeData(getAttributes(flowData), attributesToAdd || {});
    return createFlowData(getContent(flowData), newAttributes);
  }

  /**
   * 获取单个 attribute 的值
   * @param {Object} flowData - FlowData 对象
   * @param {string} key - 属性键
   * @returns {*} 属性值，不存在返回 undefined
   */
  function getAttribute(flowData, key) {
    if (!isFlowData(flowData)) return undefined;
    var descriptor = ownDataDescriptor(getAttributes(flowData), key);
    return descriptor ? descriptor.value : undefined;
  }

  /**
   * 更新 content（返回新 FlowData，保留 attributes）
   * @param {Object} flowData - FlowData 对象
   * @param {*} newContent - 新内容
   * @returns {Object} 新的 FlowData 对象
   */
  function updateContent(flowData, newContent) {
    if (!isFlowData(flowData)) {
      throw new Error('updateContent 需要 FlowData 对象');
    }
    return createFlowData(newContent, getAttributes(flowData));
  }

  /**
   * 从 FlowData 中移除指定的 attributes（返回新 FlowData）
   * @param {Object} flowData - FlowData 对象
   * @param {Array<string>} keysToRemove - 要移除的键列表
   * @returns {Object} 新的 FlowData 对象
   */
  function removeAttributes(flowData, keysToRemove) {
    if (!isFlowData(flowData)) {
      throw new Error('removeAttributes 需要 FlowData 对象');
    }
    var newAttributes = copyAttributeData(getAttributes(flowData));
    (keysToRemove || []).forEach(function (key) {
      delete newAttributes[key];
    });
    return createFlowData(getContent(flowData), newAttributes);
  }

  /**
   * 将普通值转换为 FlowData（如果已经是 FlowData 则直接返回）
   * @param {*} value - 任意值
   * @param {Object} defaultAttributes - 默认 attributes（可选）
   * @returns {Object} FlowData 对象
   */
  function ensureFlowData(value, defaultAttributes) {
    if (isFlowData(value)) return value;
    return createFlowData(value, defaultAttributes || {});
  }

  /**
   * 克隆 FlowData（深拷贝 attributes，浅拷贝 content）
   * @param {Object} flowData - FlowData 对象
   * @returns {Object} 新的 FlowData 对象
   */
  function cloneFlowData(flowData) {
    if (!isFlowData(flowData)) {
      throw new Error('cloneFlowData 需要 FlowData 对象');
    }
    var newAttributes = JSON.parse(JSON.stringify(getAttributes(flowData) || {}));
    return createFlowData(getContent(flowData), newAttributes);
  }

  // 导出公共 API
  return {
    createFlowData: createFlowData,
    isFlowData: isFlowData,
    getContent: getContent,
    getAttributes: getAttributes,
    getAttribute: getAttribute,
    addAttribute: addAttribute,
    addAttributes: addAttributes,
    updateContent: updateContent,
    removeAttributes: removeAttributes,
    ensureFlowData: ensureFlowData,
    cloneFlowData: cloneFlowData,
  };
});
