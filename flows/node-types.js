// Node Types — 用户可配置节点类型的元数据与参数 schema
// background 执行器与配置页表单共用此 schema
(function attachNodeTypes(root, factory) {
  root.NodeTypes = factory(root.PageActionContract, root.PageVerificationContract);
})(globalThis, function (pageActionContract, pageVerificationContract) {

  var PAGE_DATA_MAX_CHARS = 10000;
  var PAGE_DATA_WINDOW_DESCRIPTION = '有效范围 2-10000，默认 10000，硬上限 10000。公共分页契约按 Math.min(maxChars, 10000) 应用请求；start 和 nextStart 都是字符边界位置，不是数组下标、对象属性序号或本页返回项数量；hasMore=true 且 nextStart 不为 null 时，下一次读取必须把本页 nextStart 原样填入 start，这才是下一页，不能再次使用 start=0，也不能把当前页当作完整结果；重复读取仅在真实观察到页面或数据发生变化时才被允许；hasMore=false 或 nextStart 为 null 均表示已读取完毕。实时只读数据变化使 start 落入当前项内部时，服务会保守回退到不大于请求位置的最近完整项边界；超过当前数据时返回空的已读完结果，不作为请求错误。响应 start 是实际采用的位置，后续仍只使用响应 nextStart。单个结构化数组项或对象属性超过窗口时会被有损投影，truncated 会标记不完整，但被裁掉的项内字段不保证能由 nextStart 恢复；应缩小读取范围或改读原始文本。';
  var MODEL_PAGE_CONTEXT_DESCRIPTION = '有效范围 2-10000，默认 10000，硬上限 10000。该模型节点只附带页面文本的第一页，不会自动读取下一页，也不提供 nextStart；需要完整页面内容时，应先用页面读取节点逐页聚合，再通过模板变量传给模型。';

  var EDITABLE_PAGE_ACTION_KINDS = pageActionContract && Array.isArray(pageActionContract.EDITABLE_FLOW_KINDS)
    ? pageActionContract.EDITABLE_FLOW_KINDS.slice()
    : ['click', 'doubleClick', 'contextClick', 'fill', 'select', 'scroll'];
  var WAIT_CONDITION_TYPES = pageVerificationContract && Array.isArray(pageVerificationContract.WAIT_CONDITION_TYPES)
    ? pageVerificationContract.WAIT_CONDITION_TYPES.slice()
    : ['page_change', 'url_change', 'url_matches', 'text_present', 'text_absent', 'document_ready', 'target_state'];

  function enumOptions(values, labels) {
    return values.map(function (value) { return { value: value, label: labels[value] || value }; });
  }

  var WAIT_CONDITION_LABELS = {
    text_present: '页面出现文本',
    text_absent: '页面文本消失',
    url_change: 'URL 发生变化',
    url_matches: 'URL 匹配',
    page_change: '页面发生变化',
    document_ready: '文档达到指定状态',
    target_state: '目标元素状态',
  };

  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function locatorParamDefinitions(options) {
    options = options || {};
    var prefix = String(options.prefix || '');
    var locatorKeyPrefix = prefix ? prefix + 'Locator' : 'locator';
    var labelPrefix = String(options.labelPrefix || (prefix ? '容器' : '目标'));
    return [
      { key: prefix ? prefix + 'Selector' : 'selector', label: labelPrefix + ' CSS 选择器', kind: 'text', placeholder: options.selectorPlaceholder || '#submit-btn' },
      { key: prefix ? prefix + 'TextSelector' : 'textSelector', label: labelPrefix + '文本（可选）', kind: 'text', placeholder: '搜索、提交、保存' },
      { key: prefix ? prefix + 'TextPattern' : 'textPattern', label: labelPrefix + '文本正则（可选）', kind: 'text', placeholder: '查询|搜索' },
      { key: locatorKeyPrefix + 'Label', label: labelPrefix + '标签文本（可选）', kind: 'text', placeholder: '模块' },
      { key: prefix ? prefix + 'ScopeSelector' : 'scopeSelector', label: labelPrefix + '作用域选择器（可选）', kind: 'text', placeholder: 'form, .dialog' },
      { key: prefix ? prefix + 'Index' : 'elementIndex', label: labelPrefix + '第几个匹配（留空=第一个，-1=最后一个）', kind: 'text', placeholder: '' },
      { key: prefix ? prefix + 'Relative' : 'relative', label: labelPrefix + '相对定位', kind: 'select', default: '', options: [
        { value: '', label: '匹配元素本身' },
        { value: 'prevSibling', label: '前一个兄弟元素' },
        { value: 'nextSibling', label: '后一个兄弟元素' },
        { value: 'parent', label: '父元素' },
      ] },
    ];
  }

  function addLocatorParams(target, locator, prefix) {
    locator = locator && typeof locator === 'object' && !Array.isArray(locator) ? locator : {};
    prefix = String(prefix || '');
    var keyMap = {
      selector: prefix ? prefix + 'Selector' : 'selector',
      textSelector: prefix ? prefix + 'TextSelector' : 'textSelector',
      textPattern: prefix ? prefix + 'TextPattern' : 'textPattern',
      label: (prefix ? prefix + 'Locator' : 'locator') + 'Label',
      scopeSelector: prefix ? prefix + 'ScopeSelector' : 'scopeSelector',
      elementIndex: prefix ? prefix + 'Index' : 'elementIndex',
      relative: prefix ? prefix + 'Relative' : 'relative',
    };
    Object.keys(keyMap).forEach(function (key) {
      if (locator[key] !== undefined && locator[key] !== null && locator[key] !== '') {
        target[keyMap[key]] = cloneJson(locator[key]);
      }
    });
    return target;
  }

  function addEditableValue(params, value) {
    if (value === undefined) return params;
    if (typeof value === 'string') params.value = value;
    else {
      params.valueMode = 'json';
      params.value = JSON.stringify(value);
    }
    return params;
  }

  function confirmationParamDefinition() {
    return {
      key: 'confirmationMode',
      label: '结果确认方式',
      kind: 'select',
      default: 'required',
      options: [
        { value: 'required', label: '本节点必须确认（默认）' },
        { value: 'deferred', label: '由紧随的条件等待节点确认' },
      ],
    };
  }

  function projectedNode(type, params, pageId) {
    var node = { type: type, params: params || {} };
    pageId = String(pageId || '').trim();
    if (pageId) node.pageId = pageId;
    return node;
  }

  function projectPageActionNode(actionSpec, pageId) {
    actionSpec = actionSpec && typeof actionSpec === 'object' && !Array.isArray(actionSpec) ? actionSpec : {};
    var kind = String(actionSpec.kind || '');
    var input = actionSpec.input && typeof actionSpec.input === 'object' && !Array.isArray(actionSpec.input) ? actionSpec.input : {};
    var params = addLocatorParams({}, actionSpec.locator, '');
    params.timeoutMs = Number(actionSpec.timeoutMs) || 10000;
    if (actionSpec.expect) params.expect = cloneJson(actionSpec.expect);
    if (actionSpec.confirmationMode !== undefined) params.confirmationMode = actionSpec.confirmationMode;

    if (/^(?:click|doubleClick|contextClick)$/.test(kind)) {
      params.clickType = kind === 'doubleClick' ? 'dblclick' : (kind === 'contextClick' ? 'contextmenu' : 'click');
      if (input.offsetX !== undefined) params.offsetX = input.offsetX;
      if (input.offsetY !== undefined) params.offsetY = input.offsetY;
      if (input.activation !== undefined) params.activation = input.activation;
      return projectedNode('clickElement', params, pageId);
    }
    if (kind === 'fill') {
      addEditableValue(params, input.value);
      return projectedNode('fillInput', params, pageId);
    }
    if (kind === 'select') {
      addEditableValue(params, input.value);
      if (input.optionText !== undefined) params.optionText = input.optionText;
      if (input.optionIndex !== undefined) params.optionIndex = input.optionIndex;
      if (input.optionMatch !== undefined) params.optionMatch = input.optionMatch;
      if (input.optionIndexBase !== undefined) params.optionIndexBase = input.optionIndexBase;
      if (input.optionSelector !== undefined) params.optionSelector = input.optionSelector;
      if (input.search !== undefined) params.search = input.search;
      if (input.searchDelayMs !== undefined) params.searchDelayMs = input.searchDelayMs;
      if (input.dropdownWaitMs !== undefined) params.dropdownWaitMs = input.dropdownWaitMs;
      return projectedNode('selectOption', params, pageId);
    }
    if (kind === 'scroll') {
      params.mode = input.to === 'target' ? 'toElement'
        : (input.to === 'top' ? 'toTop' : (input.to === 'bottom' ? 'toBottom' : 'byAmount'));
      if (input.axis !== undefined) params.axis = input.axis;
      if (input.pages !== undefined && input.amountPx === undefined) {
        params.distanceUnit = 'pages';
        params.pages = input.pages;
      } else if (input.amountPx !== undefined) {
        params.distanceUnit = 'pixels';
        params.amountPx = input.amountPx;
      }
      if (input.humanLike !== undefined) params.humanLike = input.humanLike;
      if (input.maxScrollRounds !== undefined) params.maxScrollRounds = input.maxScrollRounds;
      if (input.topStableMs !== undefined) params.topStableMs = input.topStableMs;
      addLocatorParams(params, input.containerLocator, 'container');
      return projectedNode('scrollPage', params, pageId);
    }
    return projectedNode('pageAction', {
      kind: kind,
      locator: cloneJson(actionSpec.locator || {}),
      input: cloneJson(input),
      expect: actionSpec.expect ? cloneJson(actionSpec.expect) : null,
      timeoutMs: params.timeoutMs,
      sensitive: actionSpec.sensitive === true,
    }, pageId);
  }

  function projectPageWaitNode(waitSpec, pageId) {
    waitSpec = waitSpec && typeof waitSpec === 'object' && !Array.isArray(waitSpec) ? waitSpec : {};
    var condition = waitSpec.condition && typeof waitSpec.condition === 'object' && !Array.isArray(waitSpec.condition)
      ? waitSpec.condition : {};
    // The wait runtime gives condition.locator precedence over the optional
    // top-level locator. Preserve that same target when projecting to Flow.
    var conditionLocator = condition.locator && typeof condition.locator === 'object' && !Array.isArray(condition.locator)
      ? condition.locator : null;
    var params = addLocatorParams({}, conditionLocator && Object.keys(conditionLocator).length
      ? conditionLocator : waitSpec.locator, '');
    params.conditionType = String(condition.type || condition.kind || '');
    ['fromUrl', 'pattern', 'text', 'state', 'value', 'checked', 'selected', 'expanded', 'visible', 'enabled', 'editable', 'connected', 'pollIntervalMs'].forEach(function (key) {
      if (condition[key] !== undefined) params[key] = cloneJson(condition[key]);
    });
    if (waitSpec.pollIntervalMs !== undefined) params.pollIntervalMs = cloneJson(waitSpec.pollIntervalMs);
    params.timeoutMs = Number(waitSpec.timeoutMs || condition.timeoutMs) || 10000;
    return projectedNode('waitForCondition', params, pageId);
  }

  function projectPageJavascriptNode(spec, pageId) {
    spec = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
    return projectedNode('executePageJavascript', {
      source: String(spec.source || ''),
      world: String(spec.world || 'MAIN').toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'MAIN',
      mode: String(spec.mode || 'read').toLowerCase() === 'write' ? 'write' : 'read',
      start: Math.max(0, Number(spec.start) || 0),
      maxChars: Math.max(2, Number(spec.maxChars) || 10000),
      timeoutMs: Math.max(100, Number(spec.timeoutMs) || 10000),
    }, pageId);
  }

  // param.kind: text | textarea | number | boolean | select | page | script | assistant | modelService
  var TYPES = [
    {
      type: 'openPage',
      label: '打开页面',
      needsPage: true,
      description: '按页面配置打开或复用页面，并返回后续页面节点使用的 tabId',
      params: [
        { key: 'openMode', label: '打开方式', kind: 'select', default: 'navigate', options: [
          { value: 'navigate', label: '认领已打开的标签（默认）' },
          { value: 'attach', label: '固定新开标签页' },
        ] },
        { key: 'forceReopen', label: '认领后立即刷新（如果是新开，跳过）', kind: 'boolean', default: false },
        { key: 'maxReuseMinutes', label: '标签页最长复用时长（分钟，0=不限）', kind: 'number', default: 0 },
        { key: 'urlOverride', label: '覆盖 URL（可选，支持模板）', kind: 'text', placeholder: '留空使用页面配置的 URL' },
        { key: 'waitStable', label: '等待浏览器导航加载完成', kind: 'boolean', default: true },
      ],
      outputHint: '{ tabId, url, created, reused, actionReceipt, activationReceipt }',
    },
    {
      type: 'refreshPage',
      label: '刷新页面',
      needsPage: true,
      description: '刷新该页面对应的标签页',
      params: [
        { key: 'ignoreCache', label: '忽略缓存重新加载', kind: 'boolean', default: false },
        { key: 'waitStable', label: '等待浏览器导航加载完成', kind: 'boolean', default: true },
      ],
      outputHint: '{ tabId, reloaded, kind, status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'navigate',
      label: '跳转地址',
      needsPage: true,
      description: '将该页面的标签页导航到新地址；相对 URL 会基于目标标签页的当前 URL 解析',
      params: [
        { key: 'url', label: '目标 URL（支持模板和相对路径）', kind: 'text', required: true, placeholder: 'https://... 或 /path' },
        { key: 'waitStable', label: '等待浏览器导航加载完成', kind: 'boolean', default: true },
      ],
      outputHint: '{ tabId, url, navigated, kind, status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'pageAction',
      label: '页面动作（兼容）',
      needsPage: true,
      description: '低层 PageActionContract 兼容节点；新建流程优先使用可视化的点击、填写、选择和滚动节点',
      params: [
        { key: 'kind', label: '动作类型', kind: 'select', required: true, default: 'click', options: enumOptions(EDITABLE_PAGE_ACTION_KINDS, {
          click: '单击', doubleClick: '双击', contextClick: '右键', fill: '填写', select: '选择下拉选项', scroll: '滚动',
        }) },
        { key: 'locator', label: '目标 locator JSON', kind: 'textarea', valueFormat: 'json', placeholder: '{"selector":"button.primary"}' },
        { key: 'input', label: '动作 input JSON', kind: 'textarea', valueFormat: 'json', default: {}, placeholder: '{"value":"{{module}}"}' },
        { key: 'expect', label: '动作后置条件 JSON（可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"完成"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '动作超时(ms)', kind: 'number', default: 10000 },
        { key: 'sensitive', label: '敏感输入', kind: 'boolean', default: false },
      ],
      outputHint: '{ kind, status, performed, confirmed, unconfirmed, actionReceipt, receipt, actionFacts, verification, result }',
    },
    {
      type: 'clickElement',
      label: '点击按钮/元素',
      needsPage: true,
      description: '通过 CSS 选择器或文本匹配点击页面元素，支持双击/右键、按序号/随机选取、相对定位',
      params: locatorParamDefinitions({ labelPrefix: '目标', selectorPlaceholder: '#submit-btn 或 button.primary' }).concat([
        { key: 'clickType', label: '点击方式', kind: 'select', default: 'click', options: [
          { value: 'click', label: '单击' },
          { value: 'dblclick', label: '双击' },
          { value: 'contextmenu', label: '右键' },
        ] },
        { key: 'activation', label: '激活补充方式', kind: 'select', default: 'mouse', options: [
          { value: 'mouse', label: '仅鼠标事件（默认）' },
          { value: 'keyboard', label: '点击后补 Enter' },
          { value: 'both', label: '鼠标 + Enter' },
        ] },
        { key: 'offsetX', label: '水平偏移(px，可选)', kind: 'number', default: 0 },
        { key: 'offsetY', label: '垂直偏移(px，可选)', kind: 'number', default: 0 },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"完成","locator":{"selector":".result-list"}}' },
        confirmationParamDefinition(),
        { key: 'optional', label: '未找到时继续执行', kind: 'boolean', default: false },
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ]),
      outputHint: '{ clicked, clickType, kind, status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'fillInput',
      label: '填充输入框',
      needsPage: true,
      description: '通过统一 CDP 输入向文本框、contenteditable、复选框、单选框或下拉框写入期望值',
      params: locatorParamDefinitions({ labelPrefix: '输入框', selectorPlaceholder: '#username' }).concat([
        { key: 'valueMode', label: '值类型', kind: 'select', default: 'text', options: [
          { value: 'text', label: '文本（默认）' },
          { value: 'json', label: 'JSON 值（数字/布尔/null）' },
        ] },
        { key: 'value', label: '填充值（支持模板）', kind: 'text', placeholder: '{{myVar}}' },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"target_state","value":"{{myVar}}"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ]),
      outputHint: '{ filled, kind, status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'selectOption',
      label: '选择下拉选项',
      needsPage: true,
      description: '通过统一 PageActionEngine 在原生 select 或组件下拉框中选择指定选项',
      params: locatorParamDefinitions({ labelPrefix: '下拉框', selectorPlaceholder: '.el-select' }).concat([
        { key: 'valueMode', label: 'value 类型', kind: 'select', default: 'text', options: [
          { value: 'text', label: '文本（默认）' },
          { value: 'json', label: 'JSON 值（数字/布尔）' },
        ] },
        { key: 'value', label: '按 option value 选择（可选）', kind: 'text', placeholder: '{{module}}' },
        { key: 'optionText', label: '按选项文本选择（可选）', kind: 'text', placeholder: 'ersoft-kratos' },
        { key: 'optionMatch', label: '文本匹配方式', kind: 'select', default: 'smart', options: [
          { value: 'smart', label: '智能：精确或包含' },
          { value: 'exact', label: '精确匹配' },
          { value: 'contains', label: '包含匹配' },
        ] },
        { key: 'optionIndex', label: '按索引选择（可选，0=第一个）', kind: 'text', placeholder: '' },
        { key: 'optionIndexBase', label: '索引基准', kind: 'select', default: '0', options: [
          { value: '0', label: '从 0 开始（Agent 契约）' },
          { value: '1', label: '从 1 开始' },
        ] },
        { key: 'optionSelector', label: '下拉选项 CSS 选择器（可选）', kind: 'text', placeholder: '.el-select-dropdown__item' },
        { key: 'search', label: '下拉内搜索词（可选）', kind: 'text', placeholder: '{{module}}' },
        { key: 'searchDelayMs', label: '展开后输入搜索的等待(ms)', kind: 'number', default: 100 },
        { key: 'dropdownWaitMs', label: '等待下拉选项出现(ms)', kind: 'number', default: 5000 },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"target_state","value":"ersoft-kratos"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '等待选项超时(ms)', kind: 'number', default: 10000 },
      ]),
      outputHint: '{ selected, selectedOption, kind, status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'fillFormFields',
      label: '批量填写表单',
      needsPage: true,
      description: '一次填写多个表单字段；所有文本、勾选和下拉操作均由统一 CDP 输入执行并逐字段返回 ActionReceipt',
      params: [
        { key: 'selector', label: '表单/抽屉范围选择器（可选）', kind: 'text', placeholder: '.el-drawer__body 或 form' },
        { key: 'ref', label: '表单/抽屉范围 ref（可选）', kind: 'text', placeholder: 'inspect_structure/inspect_form_fields 返回的 ref' },
        { key: 'fields', label: '字段数组 JSON（支持模板）', kind: 'textarea', valueFormat: 'json', placeholder: '[\n  {"selector":"label[for=\\"last_name\\"]+.el-form-item__content input","value":"{{employeeData.lastName}}"},\n  {"selector":"label[for=\\"department_id\\"]+.el-form-item__content .el-select","kind":"select","dropdownMode":"first"},\n  {"label":"岗位","kind":"select","search":"工程师","dropdownMode":"text","optionText":"工程师"}\n]' },
        { key: 'values', label: '简写 values JSON（无 fields 时使用）', kind: 'textarea', valueFormat: 'json', placeholder: '{"姓名":"张三","手机号":"13800000000"}' },
        { key: 'dropdownMode', label: '默认下拉选择策略', kind: 'select', default: '', options: [
          { value: '', label: '按字段 value/optionText 匹配（默认）' },
          { value: 'text', label: '按选项文本智能匹配' },
          { value: 'exact', label: '按选项文本精确匹配' },
          { value: 'contains', label: '按选项文本包含匹配' },
          { value: 'value', label: '按 option value 匹配' },
          { value: 'first', label: '选择第一个可用选项' },
          { value: 'last', label: '选择最后一个可用选项' },
          { value: 'index', label: '按 optionIndex 选择（1=第一个，-1=最后）' },
          { value: 'random', label: '随机选择一个可用选项' },
        ] },
        { key: 'optionMatch', label: '默认文本匹配方式', kind: 'select', default: 'smart', options: [
          { value: 'smart', label: '智能匹配：精确或包含' },
          { value: 'exact', label: '精确匹配' },
          { value: 'contains', label: '包含匹配' },
        ] },
        { key: 'dropdownSearch', label: '默认下拉搜索词（可选）', kind: 'text', placeholder: '为空时使用字段 value/optionText 搜索' },
        { key: 'dropdownWaitMs', label: '下拉选项等待超时(ms)', kind: 'number', default: 5000 },
        { key: 'dropdownEmptyWaitMs', label: '空结果稳定等待(ms)', kind: 'number', default: 1800 },
        { key: 'searchDelayMs', label: '输入搜索词后等待(ms)', kind: 'number', default: 120 },
        { key: 'allowEmptyOptions', label: '下拉无结果时跳过该字段', kind: 'boolean', default: false },
        { key: 'stopOnError', label: '遇到首个失败字段立即中止', kind: 'boolean', default: true },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"保存成功"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '单字段默认超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ ok, total, processed, passed, confirmed, unconfirmed, failed, results:[{field,kind,receipt,error?,skipped?}], receipt, actionFacts, derivedFacts }',
    },
    {
      type: 'waitForElement',
      label: '等待元素出现',
      needsPage: true,
      description: '等待指定元素出现在页面中',
      params: [
        { key: 'selector', label: 'CSS 选择器', kind: 'text', required: true, placeholder: '.report-table' },
        { key: 'elementIndex', label: '第几个匹配（留空=第一个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'minCount', label: '至少匹配数量（可选）', kind: 'number', placeholder: '2' },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 15000 },
      ],
      outputHint: '{ target, targetRef, count, status, performed:"no", conditionMet:true, actionReceipt, receipt, verification }',
    },
    {
      type: 'waitForCondition',
      label: '等待页面条件',
      needsPage: true,
      description: '与 Agent /page/waits 使用同一验证引擎，等待 URL、文本、文档状态或目标元素状态',
      params: locatorParamDefinitions({ labelPrefix: '目标', selectorPlaceholder: '.result' }).concat([
        { key: 'conditionType', label: '条件类型', kind: 'select', required: true, default: 'text_present', options: enumOptions(WAIT_CONDITION_TYPES, WAIT_CONDITION_LABELS) },
        { key: 'text', label: '等待的文本（text 条件）', kind: 'text', placeholder: '操作成功' },
        { key: 'fromUrl', label: '原 URL（URL/page change 可选）', kind: 'text', placeholder: '{{last.url}}' },
        { key: 'pattern', label: 'URL 匹配模式', kind: 'text', placeholder: '/dashboard' },
        { key: 'state', label: '文档状态', kind: 'select', default: 'complete', options: [
          { value: 'loading', label: 'loading' },
          { value: 'interactive', label: 'interactive' },
          { value: 'complete', label: 'complete' },
        ] },
        { key: 'value', label: '目标期望值（可选）', kind: 'text', placeholder: '{{expectedValue}}' },
        { key: 'visible', label: '目标可见性', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '可见' }, { value: 'false', label: '不可见' },
        ] },
        { key: 'enabled', label: '目标可用性', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '可用' }, { value: 'false', label: '不可用' },
        ] },
        { key: 'editable', label: '目标可编辑性', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '可编辑' }, { value: 'false', label: '不可编辑' },
        ] },
        { key: 'checked', label: '目标勾选状态', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '已勾选' }, { value: 'false', label: '未勾选' },
        ] },
        { key: 'selected', label: '目标选中状态', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '已选中' }, { value: 'false', label: '未选中' },
        ] },
        { key: 'expanded', label: '目标展开状态', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '已展开' }, { value: 'false', label: '未展开' },
        ] },
        { key: 'connected', label: '目标连接到 DOM', kind: 'select', default: '', options: [
          { value: '', label: '不检查' }, { value: 'true', label: '已连接' }, { value: 'false', label: '已断开' },
        ] },
        { key: 'pollIntervalMs', label: '轮询间隔(ms)', kind: 'number', default: 100 },
        { key: 'timeoutMs', label: '等待超时(ms)', kind: 'number', default: 10000 },
      ]),
      outputHint: '{ kind:"wait", status, performed:"no", conditionMet, result:{conditionMet}, actionReceipt, receipt, verification }',
    },
    {
      type: 'waitForPageLoad',
      label: '等待页面加载完成',
      needsPage: true,
      description: '等待 Chrome 标签退出 loading、待提交导航清空，且当前主文档完成加载；用 loaderId 排除上一份文档。不推断 Fetch/XHR、SPA 业务渲染或页面自定义进度条完成',
      params: [
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 300000 },
        { key: 'stableMs', label: '稳定窗口(ms，加载完成事实连续保持)', kind: 'number', default: 800 },
      ],
      outputHint: '{ loaded:true, tabId, url, frameId, loaderId, readyState, tabStatus, loadEventEnd, loadEvidence, loadChecks:{tabComplete,noPendingUrl,readyStateComplete,loaderMatchesExpected,hasLoadEvidence}, stableMs, waitDurationMs, status, performed:"no", conditionMet:true, actionReceipt, receipt, verification }',
    },
    {
      type: 'activateTab',
      label: '激活页面标签',
      needsPage: true,
      description: '先连接或打开该页面，再把目标标签页设为其窗口内的活动标签；需要把浏览器窗口提到最前时单独启用“聚焦浏览器窗口”',
      params: [
        { key: 'focusWindow', label: '聚焦浏览器窗口', kind: 'boolean', default: false },
      ],
      outputHint: '{ activated, tabId, kind, status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'getCurrentTab',
      label: '获取当前标签 URL',
      needsPage: true,
      description: '读取该页面在当前运行会话中绑定的标签页信息，不打开、不刷新、不跳转',
      params: [],
      outputHint: '{ tabId, windowId, url, committedUrl, pendingUrl, title, active, status, discarded }',
    },
    {
      type: 'executePageJavascript',
      label: '执行页面 JavaScript',
      needsPage: true,
      description: '与 Agent /page/javascript-executions 使用同一页面运行时，支持只读/写入和 MAIN/ISOLATED world',
      params: [
        { key: 'source', label: 'JavaScript 源码', kind: 'textarea', required: true, placeholder: 'return document.title' },
        { key: 'world', label: '执行 world', kind: 'select', default: 'MAIN', options: [
          { value: 'MAIN', label: 'MAIN（页面上下文）' },
          { value: 'ISOLATED', label: 'ISOLATED（隔离上下文）' },
        ] },
        { key: 'mode', label: '执行模式', kind: 'select', default: 'read', options: [
          { value: 'read', label: '只读' },
          { value: 'write', label: '写入/修改页面' },
        ] },
        { key: 'start', label: '结果起始字符', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '结果最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '执行超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ result, start, maxChars, returnedChars, remainingChars, hasMore, nextStart, actionReceipt, receipt, status, performed, verification }',
    },
    {
      type: 'delay',
      label: '延时等待',
      needsPage: false,
      description: '暂停指定毫秒数',
      params: [
        { key: 'ms', label: '等待时长(ms)', kind: 'number', required: true, default: 1000 },
      ],
      outputHint: '{ waitedMs }',
    },
    {
      type: 'statusBreak',
      label: '状态位跳出',
      needsPage: false,
      description: '在循环中按条件写入固定长度状态位图；条件为 true 写 1，false 写 0，最近 N 位全为 0 时触发 loopBreak。适合表达“连续 N 次未满足状态则跳出”。',
      params: [
        { key: 'condition', label: '状态条件（true 写 1，false 写 0）', kind: 'textarea', required: true, placeholder: 'hasValue({{json currentValue}}) && {{json currentValue}} !== {{json prevValue}}' },
        { key: 'count', label: '连续 false 次数', kind: 'number', default: 10 },
        { key: 'stateKey', label: '状态键（同一流程内隔离）', kind: 'text', placeholder: 'assistant-answer' },
        { key: 'reset', label: '重置该状态后再判断', kind: 'boolean', default: false },
      ],
      outputHint: '{ done, loopBreak, status, mask, maskBinary, previousMask, previousMaskBinary, bitIndex, bit, index, samples, count, maxMask, filled, stateKey }',
    },
    {
      type: 'extractTable',
      label: '提取表格数据',
      needsPage: true,
      description: '从页面表格提取结构化数据（按表头映射为对象数组）',
      params: [
        { key: 'selector', label: '表格选择器', kind: 'text', default: 'table', placeholder: 'table.report' },
        { key: 'headerMode', label: '表头来源', kind: 'select', default: 'th', options: [
          { value: 'th', label: 'thead/th 单元格' },
          { value: 'firstRow', label: '第一行作为表头' },
          { value: 'none', label: '无表头（col0/col1…）' },
        ] },
        { key: 'maxRows', label: '最大行数（0=不限）', kind: 'number', default: 0 },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '等待表格超时(ms)', kind: 'number', default: 15000 },
      ],
      outputHint: '{ headers, rows, rowCount, returnedRowCount, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'extractList',
      label: '提取列表数据',
      needsPage: true,
      description: '从页面当前已渲染 DOM 中提取列表结构数据；字段选择器写 "." 表示当前列表项本身，可取 id/data-* 等属性',
      params: [
        { key: 'autoDetect', label: '自动检测列表', kind: 'boolean', default: true },
        { key: 'itemSelector', label: '列表项选择器（autoDetect=false 时必填）', kind: 'text', placeholder: '.item, li' },
        { key: 'fields', label: '字段映射（每行：字段名|选择器|属性）', kind: 'textarea', placeholder: 'title|.title|text\nurl|a|href\nindex|.rank|text' },
        { key: 'maxItems', label: '最大条数（0=不限）', kind: 'number', default: 0 },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '等待列表超时(ms)', kind: 'number', default: 15000 },
      ],
      outputHint: '{ items, count, returnedCount, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
      examples: [
        {
          title: '提取当前列表项自身属性和子元素文本',
          params: {
            autoDetect: false,
            itemSelector: 'article[id^="post_"]',
            fields: 'postNumber|.|id\npostId|.|data-post-id\nauthor|.author|text\ncontent|.content|text',
            maxItems: 0,
          },
        },
      ],
    },
    {
      type: 'extractScrollingList',
      label: '滚动提取列表数据',
      needsPage: true,
      description: '通用滚动列表采集：从页面或滚动容器中反复提取当前已渲染列表项，使用统一页面引擎连续手势滚动后合并去重，适合虚拟列表、懒加载列表、长帖子等场景',
      params: [
        { key: 'itemSelector', label: '列表项选择器', kind: 'text', required: true, placeholder: '.item, li, article' },
        { key: 'fields', label: '字段映射（每行：字段名|选择器|属性；选择器 "." 表示当前列表项）', kind: 'textarea', required: true, placeholder: 'id|.|data-id\ntitle|.title|text\nurl|a|href' },
        { key: 'keyFields', label: '去重字段（逗号或换行；为空则按整行 JSON 去重）', kind: 'text', placeholder: 'id' },
        { key: 'containerSelector', label: '滚动容器选择器（可选，留空滚动整页）', kind: 'text', placeholder: '.scroll-area' },
        { key: 'containerIndex', label: '第几个滚动容器（留空=第一个，2=第二个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'scrollStepPx', label: '每轮滚动距离(px)', kind: 'number', default: 600 },
        { key: 'maxIterations', label: '最大滚动轮数', kind: 'number', default: 30 },
        { key: 'maxItems', label: '最大采集条数（0=不限）', kind: 'number', default: 0 },
        { key: 'stopOnNoNewRounds', label: '连续无新增轮数后停止', kind: 'number', default: 3 },
        { key: 'scrollToTop', label: '开始前滚动到顶部', kind: 'boolean', default: true },
        { key: 'humanLike', label: '连续滚动手势', kind: 'boolean', default: true },
        { key: 'settleMs', label: '每次滚动后等待(ms)', kind: 'number', default: 150 },
        { key: 'thresholdPx', label: '到底判定容差(px)', kind: 'number', default: 20 },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '等待首个列表项/容器超时(ms)', kind: 'number', default: 15000 },
      ],
      outputHint: '{ items, count, returnedCount, iterations, atBottom, scroll, scrollReceipts, itemSelector, keyFields, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
      examples: [
        {
          title: '采集长列表/虚拟列表',
          params: {
            itemSelector: '.item',
            fields: 'id|.|data-id\ntitle|.title|text\nurl|a|href',
            keyFields: 'id',
            scrollStepPx: 800,
            maxIterations: 50,
            stopOnNoNewRounds: 3,
          },
        },
      ],
    },
    {
      type: 'getRequests',
      label: '获取请求返回数据',
      needsPage: true,
      description: '读取页面捕获的网络请求响应（需在页面配置中开启“捕获网络请求”）',
      params: [
        { key: 'urlFilter', label: 'URL 包含', kind: 'text', placeholder: '/api/list' },
        { key: 'method', label: '请求方法', kind: 'select', default: '', options: [
          { value: '', label: '不限' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'resourceType', label: '资源类型', kind: 'select', default: '', options: [
          { value: '', label: '不限' },
          { value: 'fetch', label: 'fetch' },
          { value: 'xhr', label: 'XHR' },
          { value: 'sse', label: 'SSE / EventStream' },
        ] },
        { key: 'latestOnly', label: '只取最新一条', kind: 'boolean', default: true },
        { key: 'retentionMs', label: '捕获保留窗口(ms，0=默认)', kind: 'number', default: 0 },
        { key: 'parseJson', label: '响应体解析为 JSON', kind: 'boolean', default: true },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '等待匹配请求超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ type:"network-log", entries, totalCount, returnedCount, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'replayRequest',
      label: '重放页面请求',
      needsPage: true,
      description: '在页面上下文重发已捕获请求，或直接按 URL/method/headers/body 发送请求',
      params: [
        { key: 'entryId', label: '请求 ID（来自 getRequests）', kind: 'text', placeholder: 'req_...' },
        { key: 'url', label: '直接请求 URL（没有 entryId 时必填）', kind: 'text', placeholder: 'https://example.com/api' },
        { key: 'method', label: '请求方法（可选）', kind: 'select', default: '', options: [
          { value: '', label: '沿用原请求/默认 GET' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'headers', label: '请求头 JSON（可选）', kind: 'textarea', placeholder: '{"content-type":"application/json"}' },
        { key: 'body', label: '请求体（可选）', kind: 'textarea', placeholder: '{"id":1}' },
        { key: 'parseJson', label: '响应解析为 JSON', kind: 'boolean', default: true },
        { key: 'start', label: '正文起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '正文每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ type:"http-response", url, status, ok, contentType, body, start, maxChars, returnedChars, remainingChars, hasMore, nextStart, actionReceipt, receipt }',
    },
    {
      type: 'patchPage',
      label: '页面补丁',
      needsPage: true,
      description: '临时修改页面元素以让流程继续运行，如隐藏/移除遮罩、设置样式/属性、解禁按钮。会改变页面状态，谨慎使用',
      params: [
        { key: 'selector', label: '目标元素选择器', kind: 'text', required: true, placeholder: '.modal-backdrop' },
        { key: 'action', label: '补丁动作', kind: 'select', default: 'hide', options: [
          { value: 'hide', label: '隐藏元素' },
          { value: 'remove', label: '移除元素' },
          { value: 'style', label: '设置样式' },
          { value: 'attribute', label: '设置属性' },
          { value: 'removeAttribute', label: '移除属性' },
          { value: 'enable', label: '解禁元素' },
        ] },
        { key: 'name', label: '样式/属性名', kind: 'text', placeholder: 'display / aria-disabled' },
        { key: 'value', label: '样式/属性值', kind: 'text', placeholder: 'none / false' },
        { key: 'all', label: '作用于全部匹配元素', kind: 'boolean', default: false },
      ],
      outputHint: '{ kind:"patch", status, performed, confirmed, actionReceipt, receipt, result:{ matched, action } }',
    },
    {
      type: 'callPageFunction',
      label: '调用页面函数',
      needsPage: true,
      description: '在页面 MAIN world 调用已存在的业务函数',
      params: [
        { key: 'path', label: '函数路径', kind: 'text', required: true, placeholder: 'window.__APP__.encrypt / app.login' },
        { key: 'args', label: '参数数组 JSON', kind: 'textarea', placeholder: '["foo", 123]' },
        { key: 'thisPath', label: 'this 对象路径（可选）', kind: 'text', placeholder: 'window.__APP__' },
        { key: 'start', label: '结果起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '结果每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ result, start, maxChars, returnedChars, remainingChars, hasMore, nextStart, executionLog, risk, actionReceipt, receipt, status, performed }',
    },
    {
      type: 'runtimeModuleAction',
      label: '调用页面运行时模块',
      needsPage: true,
      description: '从 webpack/rspack 等页面打包运行时加载模块导出，并按固定动作链读取/调用/过滤/拼接/替换数据。用于复用页面自身 store 或工具函数，不执行任意 JS 字符串',
      params: [
        { key: 'chunkGlobalPattern', label: 'chunk 全局名正则', kind: 'text', default: '(?:webpack|rspack)Chunk', placeholder: '(?:webpack|rspack)Chunk' },
        { key: 'moduleId', label: '模块 ID', kind: 'text', required: true, placeholder: '67808' },
        { key: 'exportPath', label: '导出路径', kind: 'text', placeholder: 'L / default / store' },
        { key: 'actions', label: '动作链 JSON', kind: 'textarea', required: true, valueFormat: 'json', placeholder: '[\n  {\"op\":\"call\",\"path\":\"getState\"},\n  {\"op\":\"call\",\"path\":\"getSession\",\"args\":[\"{{sessionId}}\"]},\n  {\"op\":\"get\",\"path\":\"messageStore\"},\n  {\"op\":\"values\"},\n  {\"op\":\"replace\",\"pattern\":\"\\\\\\\\[reference:\\\\d+\\\\\\\\]\",\"replacement\":\"\"}\n]' },
        { key: 'returnPath', label: '返回路径（可选）', kind: 'text', placeholder: 'current' },
        { key: 'start', label: '结果起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '结果每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ result, start, maxChars, returnedChars, remainingChars, hasMore, nextStart, executionLog, risk, actionReceipt, receipt, status, performed }',
    },
    {
      type: 'cdp.inspect_dom_snapshot',
      label: 'CDP DOM 快照',
      needsPage: true,
      description: '通过 Chrome Debugging Protocol 读取 DOMSnapshot.captureSnapshot。会附加 debugger，仅用于调试/定位',
      params: [
        { key: 'computedStyles', label: '计算样式属性（逗号分隔）', kind: 'text', placeholder: 'display,visibility,position' },
        { key: 'includeDOMRects', label: '包含 DOM Rects', kind: 'boolean', default: true },
        { key: 'includePaintOrder', label: '包含绘制顺序', kind: 'boolean', default: false },
        { key: 'start', label: '快照起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '快照每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ type:"dom-snapshot", snapshot, capturedAt, evidenceSource, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'cdp.inspect_ax_tree',
      label: 'CDP AX 树',
      needsPage: true,
      description: '通过 Accessibility.getFullAXTree/getPartialAXTree 读取可访问性树，用于稳定定位 role/name',
      params: [
        { key: 'selector', label: '限定元素选择器（可选）', kind: 'text', placeholder: 'button.primary' },
        { key: 'fetchRelatives', label: '局部树包含相关节点', kind: 'boolean', default: true },
        { key: 'start', label: '节点起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '节点每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ type:"ax-tree", nodes, totalNodes, returnedNodeCount, evidenceSource, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'cdp.inspect_network',
      label: 'CDP 网络观测',
      needsPage: true,
      description: '启用 CDP Network 域并读取本扩展捕获到的请求事件。首次调用只能捕获之后发生的请求',
      params: [
        { key: 'urlFilter', label: 'URL 包含', kind: 'text', placeholder: '/api/' },
        { key: 'method', label: '请求方法', kind: 'select', default: '', options: [
          { value: '', label: '不限' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'latestOnly', label: '只取最新一条', kind: 'boolean', default: false },
        { key: 'includeBody', label: '尝试读取响应体', kind: 'boolean', default: false },
        { key: 'listenMs', label: '本次监听时长(ms)', kind: 'number', default: 1000 },
        { key: 'start', label: '请求起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '请求每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ result:{ type:"network-log", entries, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }, executionLog, risk }',
    },
    {
      type: 'cdp.analyze_performance',
      label: 'CDP 性能分析',
      needsPage: true,
      description: '面向流程编排的 CDP 耗时分析：可采样页面加载；action=click 会附加 debugger 并注入输入事件，仅用于调试确认',
      params: [
        { key: 'sampleMs', label: '采样窗口(ms)', kind: 'number', default: 5000 },
        { key: 'reload', label: '采样时刷新页面', kind: 'boolean', default: false },
        { key: 'ignoreCache', label: '刷新时忽略缓存', kind: 'boolean', default: false },
        { key: 'action', label: '采样触发动作', kind: 'select', default: 'none', options: [
          { value: 'none', label: '不触发动作' },
          { value: 'click', label: '点击元素/坐标' },
        ] },
        { key: 'selector', label: '点击元素选择器', kind: 'text', placeholder: 'button.expand / .menu-item' },
        { key: 'x', label: '点击 X 坐标（无 selector 时）', kind: 'number' },
        { key: 'y', label: '点击 Y 坐标（无 selector 时）', kind: 'number' },
        { key: 'afterActionDelayMs', label: '动作后额外等待再采样(ms)', kind: 'number', default: 0 },
        { key: 'longTaskThresholdMs', label: '长任务阈值(ms)', kind: 'number', default: 50 },
        { key: 'urlFilter', label: '慢请求 URL 包含（可选）', kind: 'text', placeholder: '/api/' },
        { key: 'networkLimit', label: '网络条目上限', kind: 'number', default: 50 },
        { key: 'maxTraceEvents', label: 'Trace 事件上限', kind: 'number', default: 6000 },
        { key: 'start', label: '分析结果起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '分析结果每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ result:{ type:"performance-analysis", analysis, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }, executionLog, risk }',
    },
    {
      type: 'cdp.replay_request',
      label: 'CDP 重放请求',
      needsPage: true,
      description: '通过 CDP Runtime 在页面上下文重放请求',
      params: [
        { key: 'entryId', label: 'CDP 请求 ID（来自 cdp.inspect_network）', kind: 'text', placeholder: 'requestId' },
        { key: 'url', label: '直接请求 URL', kind: 'text', placeholder: 'https://example.com/api' },
        { key: 'method', label: '请求方法', kind: 'select', default: '', options: [
          { value: '', label: '沿用原请求/默认 GET' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'headers', label: '请求头 JSON 或 Key: Value', kind: 'textarea', placeholder: '{"content-type":"application/json"}' },
        { key: 'body', label: '请求体', kind: 'textarea', placeholder: '{"id":1}' },
        { key: 'parseJson', label: '响应解析为 JSON', kind: 'boolean', default: true },
        { key: 'start', label: '正文起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '正文每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ result:{ type:"http-response", url, status, ok, contentType, body, start, maxChars, returnedChars, remainingChars, hasMore, nextStart, actionReceipt }, executionLog, risk }',
    },
    {
      type: 'cdp.screenshot',
      label: 'CDP 截图',
      needsPage: true,
      description: '通过 Page.captureScreenshot 截图，支持元素 clip 和 captureBeyondViewport',
      params: [
        { key: 'selector', label: '元素选择器（可选）', kind: 'text', placeholder: '.panel' },
        { key: 'format', label: '格式', kind: 'select', default: 'jpeg', options: [
          { value: 'jpeg', label: 'JPEG' },
          { value: 'png', label: 'PNG' },
        ] },
        { key: 'quality', label: 'JPEG 质量', kind: 'number', default: 70 },
        { key: 'captureBeyondViewport', label: '尝试截取视口外内容', kind: 'boolean', default: false },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ dataUrl, format, clip, capturedAt, evidenceSource }',
    },
    {
      type: 'getSseEvents',
      label: '获取 SSE 事件',
      needsPage: true,
      description: '读取页面捕获的 Server-Sent Events / text/event-stream 数据（需在页面配置中开启“捕获网络请求”）',
      params: [
        { key: 'urlFilter', label: 'URL 包含', kind: 'text', placeholder: '/events 或 /api/data' },
        { key: 'streamId', label: '流 ID（可选）', kind: 'text', placeholder: 'stream_...' },
        { key: 'eventName', label: '事件名（可选）', kind: 'text', placeholder: 'message / update / delta' },
        { key: 'phase', label: '事件阶段', kind: 'select', default: 'message', options: [
          { value: 'message', label: '消息数据' },
          { value: 'request', label: '连接请求' },
          { value: 'open', label: '连接打开' },
          { value: 'error', label: '连接错误' },
          { value: 'close', label: '连接关闭' },
          { value: 'all', label: '全部阶段' },
        ] },
        { key: 'latestOnly', label: '只取最新一条', kind: 'boolean', default: true },
        { key: 'retentionMs', label: '捕获保留窗口(ms，0=默认)', kind: 'number', default: 0 },
        { key: 'parseJson', label: '事件 data 解析为 JSON', kind: 'boolean', default: true },
        { key: 'start', label: '事件起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '事件每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '等待匹配事件超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ type:"network-log", entries, totalCount, returnedCount, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'clearNetworkCapture',
      label: '清空网络捕获',
      needsPage: true,
      description: '清空当前页面已捕获的网络请求与 SSE 事件，适合在触发操作前调用，避免读到历史请求',
      params: [],
      outputHint: '{ cleared }',
    },
    {
      type: 'logData',
      label: '输出日志',
      needsPage: false,
      description: '把数据打印到日志（侧边栏与运行历史可见），用于查看提取到的数据',
      params: [
        { key: 'message', label: '日志内容（支持模板，{{json 变量}} 打印完整 JSON）', kind: 'textarea', default: '{{json last}}', placeholder: '提取结果: {{json orders}}' },
        { key: 'level', label: '日志级别', kind: 'select', default: 'info', options: [
          { value: 'info', label: 'info' },
          { value: 'warn', label: 'warn' },
          { value: 'error', label: 'error' },
        ] },
        { key: 'maxLength', label: '最大长度（字符，0=不截断）', kind: 'number', default: 3000 },
      ],
      outputHint: '—（透传上一节点输出 ctx.last）',
    },
    {
      type: 'runScript',
      label: '执行脚本',
      needsPage: false,
      description: '兜底节点：仅当普通流程节点无法表达复合逻辑时，在扩展沙箱中执行自定义 JS 脚本；必须说明 runScriptJustification。脚本可调用页面、HTTP 和文件副作用，因此不允许节点级自动重试。可调用 api.page/api.http/api.file/api.ctx；page.open(pageId) 返回 tabId，后续 page.* 操作传 tabId；可用 page.getCurrentTab(tabId) / page.getCurrentUrl(tabId) 读取标签。写出数据：① await ctx.set("name", v) 直接写变量；② return 值 + 节点 outputVar 写入变量；③ 未设置 outputVar 时 return 纯对象会自动按键展开为变量，后续节点用 {{键名}} 引用',
      params: [
        { key: 'scriptId', label: '选择已保存脚本', kind: 'script' },
        { key: 'inlineCode', label: '或内联代码（优先级低于已选脚本）', kind: 'textarea', placeholder: 'const t = await ctx.get("orders");\nawait ctx.set("count", t.rows.length); // 写出变量，后续 {{count}}\nreturn { total: t.rows.length };      // 不设 outputVar 时自动展开为 {{total}}' },
        { key: 'runScriptJustification', label: '脚本兜底原因', kind: 'textarea', required: true, placeholder: '说明为什么 click/extract/saveFile/loop/condition 等普通节点无法表达这段逻辑' },
        { key: 'timeoutMs', label: '执行超时(ms)', kind: 'number', default: 60000 },
      ],
      outputHint: '脚本 return 的值（未设 outputVar 且 return 纯对象时，各键自动写入变量）',
    },
    {
      type: 'webhook',
      label: 'Webhook 推送',
      needsPage: false,
      description: '向下游系统发送 HTTP 请求',
      params: [
        { key: 'url', label: 'Webhook URL（支持模板）', kind: 'text', required: true, placeholder: 'https://downstream.example.com/hook' },
        { key: 'method', label: '方法', kind: 'select', default: 'POST', options: [
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'GET', label: 'GET' },
        ] },
        { key: 'headers', label: '请求头（每行 Key: Value）', kind: 'textarea', placeholder: 'Content-Type: application/json\nAuthorization: Bearer xxx' },
        { key: 'bodyTemplate', label: '请求体模板', kind: 'textarea', placeholder: '{"rows": {{json orders.rows}}, "count": {{orders.rowCount}}}' },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ status, ok, json, body }',
    },
    {
      type: 'turndownToMarkdown',
      label: 'Turndown HTML 转 Markdown',
      needsPage: false,
      description: '使用 Turndown 默认规则和可配置 customRules 将完整 HTML 字符串转换为 Markdown。不同页面的特殊 DOM 语义必须由 Agent 在本节点配置声明式规则；上游 hasMore=true 且 nextStart 不为 null 时，下一次读取必须把 nextStart 原样填入 start，逐页拼接完整 HTML 后再转换。',
      params: [
        { key: 'sourceMode', label: 'HTML 来源', kind: 'select', default: 'last', options: [
          { value: 'last', label: '上一节点输出' },
          { value: 'variable', label: '指定变量/路径' },
          { value: 'literal', label: '自定义 HTML' },
        ] },
        { key: 'sourcePath', label: '变量/路径', kind: 'text', default: 'last', placeholder: 'pageContent', description: '来源必须是完整 HTML。若指向 inspectHtml/extractText 等分页结果的 content/value，先确认 hasMore=false 或 nextStart 为 null；hasMore=true 且 nextStart 不为 null 时，下一次读取必须把 nextStart 原样填入 start，直接转换当前页会在页边界截断。' },
        { key: 'html', label: '自定义 HTML（支持模板）', kind: 'textarea', placeholder: '<h1>{{title}}</h1>{{content}}' },
        { key: 'headingStyle', label: '标题风格', kind: 'select', default: 'atx', options: [
          { value: 'atx', label: '# 标题' }, { value: 'setext', label: '下划线标题' },
        ] },
        { key: 'bulletListMarker', label: '无序列表符号', kind: 'select', default: '-', options: [
          { value: '-', label: '-' }, { value: '*', label: '*' }, { value: '+', label: '+' },
        ] },
        { key: 'codeBlockStyle', label: '代码块风格', kind: 'select', default: 'fenced', options: [
          { value: 'fenced', label: '``` 围栏' },
          { value: 'indented', label: '缩进' },
        ] },
        { key: 'emDelimiter', label: '斜体分隔符', kind: 'select', default: '*', options: [
          { value: '*', label: '*' }, { value: '_', label: '_' },
        ] },
        { key: 'strongDelimiter', label: '粗体分隔符', kind: 'select', default: '**', options: [
          { value: '**', label: '**' }, { value: '__', label: '__' },
        ] },
        { key: 'gfm', label: '启用 GFM 规则', kind: 'boolean', default: true, description: '启用表格、删除线、任务列表等 GitHub Flavored Markdown 规则。' },
        { key: 'customRules', label: '页面自定义规则 JSON', kind: 'textarea', valueFormat: 'json', default: [], placeholder: '[\n  {\n    "name": "ascii-pre",\n    "selector": "pre.ascii",\n    "action": "fencedCode",\n    "contentMode": "text",\n    "language": "ascii",\n    "stripExistingFence": true,\n    "trimBoundaryNewlines": true\n  },\n  {\n    "name": "katex",\n    "selector": ".katex",\n    "action": "replace",\n    "contentSelector": "annotation[encoding=\\"application/x-tex\\"]",\n    "contentMode": "text",\n    "replacement": "$$$CONTENT$$"\n  }\n]', description: '数组第一条优先。action 支持 replace/remove/keep/fencedCode；contentMode 支持 markdown/text/html/outerHTML/attribute；占位符支持 $CONTENT、$MARKDOWN、$TEXT、$HTML、$OUTER_HTML。' },
        { key: 'timeoutMs', label: '转换超时(ms)', kind: 'number', default: 60000, minimum: 1000, maximum: 120000 },
      ],
      outputHint: 'Markdown 字符串',
      implementation: {
        dispatcher: 'background/node-dispatcher.js',
        module: 'background/node-executor.js',
        handler: 'execTurndownToMarkdown',
        sourceResolver: 'flows/template.js#resolvePath',
        outputContract: 'string',
      },
    },
    {
      type: 'downloadMedia',
      label: '下载并本地化多媒体',
      needsPage: false,
      description: '从 HTML、Markdown 或 URL 列表发现图片/GIF、音视频和 HLS 流媒体，优先复用当前页面已加载的原始响应，再下载缺失资源并把正文引用改写为本地相对路径；相对 URL 必须提供原页面基准地址',
      params: [
        { key: 'sourceMode', label: '内容来源', kind: 'select', default: 'last', options: [
          { value: 'last', label: '上一节点输出' },
          { value: 'variable', label: '指定变量/路径' },
          { value: 'literal', label: '自定义内容' },
        ] },
        { key: 'sourcePath', label: '变量/路径', kind: 'text', default: 'last', placeholder: 'pageMarkdown' },
        { key: 'content', label: '自定义 HTML / Markdown / URL 列表（支持模板）', kind: 'textarea', placeholder: '![图片](/assets/image.png)' },
        { key: 'sourceFormat', label: '内容格式', kind: 'select', default: 'auto', options: [
          { value: 'auto', label: '自动识别 HTML + Markdown' },
          { value: 'markdown', label: 'Markdown' },
          { value: 'html', label: 'HTML' },
          { value: 'urlList', label: 'URL 列表（换行、逗号或 JSON 数组）' },
        ] },
        { key: 'baseUrl', label: '原页面基准 URL（解析相对地址）', kind: 'text', placeholder: 'https://dev.java/learn/intellij-idea/' },
        { key: 'tabId', label: '页面 tabId（驻留资源复用，可选）', kind: 'text', default: '{{tabId}}', placeholder: '{{tabId}}' },
        { key: 'residentResourceMode', label: '页面驻留资源模式', kind: 'select', default: 'auto', options: [
          { value: 'auto', label: '优先复用，未命中再下载' },
          { value: 'required', label: '只用驻留资源，禁止网络回退' },
          { value: 'off', label: '关闭复用，保持原下载行为' },
        ] },
        { key: 'maxResidentAssetBytes', label: '单个驻留资源上限（字节）', kind: 'number', default: 20971520 },
        { key: 'maxResidentTotalBytes', label: '本节点驻留资源总上限（字节）', kind: 'number', default: 67108864 },
        { key: 'directory', label: '下载目录下的资源目录', kind: 'text', default: 'PageAgent/assets', placeholder: 'PageAgent/devjava/assets' },
        { key: 'linkPrefix', label: '正文中的本地相对路径前缀', kind: 'text', default: 'assets', placeholder: 'assets' },
        { key: 'downloadImages', label: '下载图片和 GIF', kind: 'boolean', default: true },
        { key: 'downloadVideo', label: '下载普通视频文件', kind: 'boolean', default: true },
        { key: 'downloadAudio', label: '下载音频文件', kind: 'boolean', default: true },
        { key: 'downloadStreams', label: '下载 HLS 资源包；DASH 仅保存清单并给出警告', kind: 'boolean', default: true },
        { key: 'rewriteLinks', label: '将正文链接改写为本地路径', kind: 'boolean', default: true },
        { key: 'maxAssets', label: '最多下载资源数（含 HLS 分片）', kind: 'number', default: 500 },
        { key: 'concurrency', label: '并发下载数', kind: 'number', default: 3 },
        { key: 'continueOnError', label: '单个资源失败时继续', kind: 'boolean', default: true },
        { key: 'waitComplete', label: '等待全部下载完成', kind: 'boolean', default: true },
        { key: 'timeoutMs', label: '每个资源等待超时(ms)', kind: 'number', default: 120000 },
      ],
      outputHint: '{ content, assets, discoveredCount, downloadedCount, completedCount, startedCount, failedCount, residentHitCount, residentMissCount, residentTooLargeCount, residentByteLength, networkDownloadCount, networkFetchCount, generatedCount, residentResourceMode, warnings }；后接 saveFile(sourcePath=last.content)',
      implementation: {
        dispatcher: 'background/node-dispatcher.js',
        module: 'background/node-file-ops.js',
        handler: 'execDownloadMedia',
        sourceResolver: 'flows/template.js#resolvePath',
        outputContract: '{ content: string, assets: array, discoveredCount: number, downloadedCount: number, completedCount: number, startedCount: number, failedCount: number, residentHitCount: number, residentMissCount: number, residentTooLargeCount: number, residentByteLength: number, networkDownloadCount: number, networkFetchCount: number, generatedCount: number, residentResourceMode: string, warnings: array }',
      },
    },
    {
      type: 'loopStart',
      label: '循环开始',
      needsPage: false,
      description: '标记循环体开始；设置 itemsPath 后逐项循环，并在循环体内暴露 {{item.xxx}}、{{index}}、{{loop.index}}、{{loop.count}}',
      params: [
        { key: 'loopId', label: '循环 ID', kind: 'text', required: true },
        { key: 'itemsPath', label: '循环数组路径（可选）', kind: 'text', placeholder: 'pageLinks.items' },
        { key: 'maxIterations', label: '最大循环次数（0=不限）', kind: 'number', default: 0 },
        { key: 'breakCondition', label: '跳出条件（安全表达式，支持模板与 contains(...) 等函数）', kind: 'textarea', placeholder: '{{index}} >= 5 || contains({{json last.text}}, "完成")' },
      ],
      outputHint: '{ index, count, item, loopBreak?, loopEmpty? }；循环体内可用 {{item.xxx}} / {{loop.item.xxx}}',
    },
    {
      type: 'loopEnd',
      label: '循环结束',
      needsPage: false,
      description: '标记循环体结束',
      params: [
        { key: 'loopId', label: '循环 ID', kind: 'text', required: true },
      ],
      outputHint: '{ loopEnd: true }',
    },
    {
      type: 'loopBreak',
      label: 'Break 跳出循环',
      needsPage: false,
      description: '立即跳出当前循环',
      params: [
        { key: 'condition', label: '条件（可选，安全表达式）', kind: 'textarea', placeholder: '{{last.status}} === "done"' },
      ],
      outputHint: '{ loopBreak }',
    },
    {
      type: 'loopContinue',
      label: 'Continue 继续下一轮',
      needsPage: false,
      description: '跳过本轮剩余节点，进入下一轮循环',
      params: [
        { key: 'condition', label: '条件（可选，安全表达式）', kind: 'textarea', placeholder: '{{last.skip}} === true' },
      ],
      outputHint: '{ loopContinue }',
    },
    {
      type: 'assertElement',
      label: '断言: 元素状态',
      needsPage: true,
      description: '断言元素存在/不存在/可见/隐藏，超时仍不满足则断言失败',
      params: [
        { key: 'selector', label: 'CSS 选择器（支持 || 分隔备选链）', kind: 'text', required: true, placeholder: '.success-toast' },
        { key: 'condition', label: '断言条件', kind: 'select', default: 'exists', options: [
          { value: 'exists', label: '存在' },
          { value: 'notExists', label: '不存在' },
          { value: 'visible', label: '可见' },
          { value: 'hidden', label: '隐藏或不存在' },
        ] },
        { key: 'timeoutMs', label: '等待超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ passed: true, actual, expected, verification }',
    },
    {
      type: 'assertText',
      label: '断言: 元素文本',
      needsPage: true,
      description: '断言元素文本内容匹配预期',
      params: [
        { key: 'selector', label: 'CSS 选择器（支持 || 分隔备选链）', kind: 'text', required: true, placeholder: '.order-status' },
        { key: 'matchMode', label: '匹配方式', kind: 'select', default: 'contains', options: [
          { value: 'contains', label: '包含' },
          { value: 'equals', label: '完全相等' },
          { value: 'regex', label: '正则匹配' },
          { value: 'notContains', label: '不包含' },
        ] },
        { key: 'expected', label: '预期值（支持模板）', kind: 'text', required: true, placeholder: '已完成' },
        { key: 'elementIndex', label: '第几个匹配（留空=第一个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ passed:true, actual, expected, verification }',
    },
    {
      type: 'assertValue',
      label: '断言: 变量/数据',
      needsPage: false,
      description: '断言上下文变量或表达式结果符合预期（接口断言可先用「获取请求返回数据」+「JSON 数据提取」取值）',
      params: [
        { key: 'actual', label: '实际值（支持模板）', kind: 'text', required: true, placeholder: '{{orders.rowCount}}' },
        { key: 'operator', label: '比较方式', kind: 'select', default: '==', options: [
          { value: '==', label: '等于' },
          { value: '!=', label: '不等于' },
          { value: '>', label: '大于' },
          { value: '>=', label: '大于等于' },
          { value: '<', label: '小于' },
          { value: '<=', label: '小于等于' },
          { value: 'contains', label: '包含' },
          { value: 'notContains', label: '不包含' },
          { value: 'regex', label: '正则匹配' },
        ] },
        { key: 'expected', label: '预期值（支持模板）', kind: 'text', placeholder: '10' },
      ],
      outputHint: '{ passed:true, actual, expected, operator }',
    },
    {
      type: 'assertUrl',
      label: '断言: 页面地址',
      needsPage: true,
      description: '断言页面当前 URL 匹配预期（验证跳转结果）',
      params: [
        { key: 'matchMode', label: '匹配方式', kind: 'select', default: 'contains', options: [
          { value: 'contains', label: '包含' },
          { value: 'equals', label: '完全相等' },
          { value: 'regex', label: '正则匹配' },
        ] },
        { key: 'expected', label: '预期值（支持模板）', kind: 'text', required: true, placeholder: '/dashboard' },
      ],
      outputHint: '{ passed: true, actual, expected, verification }',
    },
    {
      type: 'scrollPage',
      label: '滚动页面',
      needsPage: true,
      description: '通过统一 PageActionEngine 使用鼠标滚轮滚动页面/容器（滚动到元素、指定距离、顶部或底部），可触发懒加载',
      params: locatorParamDefinitions({ labelPrefix: '目标元素', selectorPlaceholder: '.load-more' }).concat([
        { key: 'mode', label: '滚动方式', kind: 'select', default: 'byAmount', options: [
          { value: 'toElement', label: '滚动到元素' },
          { value: 'untilElement', label: '循环滚动直到元素出现（懒加载列表）' },
          { value: 'byAmount', label: '滚动指定距离' },
          { value: 'toBottom', label: '滚动到底部' },
          { value: 'toTop', label: '滚动到顶部' },
        ] },
        { key: 'axis', label: '滚动方向', kind: 'select', default: 'vertical', options: [
          { value: 'vertical', label: '垂直' },
          { value: 'horizontal', label: '水平' },
        ] },
        { key: 'distanceUnit', label: '滚动距离单位', kind: 'select', default: 'pixels', options: [
          { value: 'pixels', label: '像素' },
          { value: 'pages', label: '视口页数' },
        ] },
        { key: 'amountPx', label: '滚动距离(px，可为负)', kind: 'number', default: 600 },
        { key: 'pages', label: '按视口页数滚动', kind: 'number', default: 1 },
        { key: 'containerSelector', label: '滚动容器选择器', kind: 'text', placeholder: '整页留空，容器使用 .scroll-area' },
        { key: 'containerTextSelector', label: '容器文本匹配选择器（可选）', kind: 'text', placeholder: '' },
        { key: 'containerTextPattern', label: '容器文本正则（可选）', kind: 'text', placeholder: '' },
        { key: 'containerLocatorLabel', label: '容器标签文本（可选）', kind: 'text', placeholder: '' },
        { key: 'containerScopeSelector', label: '容器作用域选择器（可选）', kind: 'text', placeholder: '' },
        { key: 'containerIndex', label: '第几个滚动容器（留空=第一个，2=第二个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'containerRelative', label: '容器相对定位', kind: 'select', default: '', options: [
          { value: '', label: '匹配元素本身' },
          { value: 'prevSibling', label: '前一个兄弟元素' },
          { value: 'nextSibling', label: '后一个兄弟元素' },
          { value: 'parent', label: '父元素' },
        ] },
        { key: 'humanLike', label: '连续滚动手势', kind: 'boolean', default: true },
        { key: 'maxScrollRounds', label: '最大滚动轮数（滚到底部）', kind: 'number', default: 40 },
        { key: 'topStableMs', label: '到顶稳定窗口(ms)', kind: 'number', default: 700 },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"加载完成"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '滚动节点超时(ms)', kind: 'number', default: 10000 },
      ]),
      outputHint: '{ scrolled, atTop, atBottom, atLeft, atRight, scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth, viewportHeight, viewportWidth, remainingPx (vertical; horizontal when axis=horizontal), maxTop, maxLeft, scrollableY, scrollableX, documentScroller, bounds, beforeLeft, beforeTop, appliedX, appliedY, kind, status, performed, actionReceipt, receipt, result }',
    },
    {
      type: 'scrollInfo',
      label: '获取滚动状态',
      needsPage: true,
      description: '读取页面/容器滚动位置，输出 atBottom/atTop 等，配合条件分支或循环跳出条件（如 {{s.atBottom}}）',
      params: [
        { key: 'containerSelector', label: '滚动容器选择器（可选，留空读整页）', kind: 'text', placeholder: '.scroll-area' },
        { key: 'containerIndex', label: '第几个滚动容器（留空=第一个，2=第二个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'thresholdPx', label: '判定容差(px，距底部小于该值视为到底)', kind: 'number', default: 4 },
        { key: 'stableMs', label: '到底稳定窗口(ms)', kind: 'number', default: 800 },
        { key: 'timeoutMs', label: '等待容器超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ atBottom, atTop, atLeft, atRight, scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth, viewportHeight, viewportWidth, maxTop, maxLeft, remainingPx, scrollableY, scrollableX, documentScroller, bounds }',
    },
    {
      type: 'hoverElement',
      label: '悬停元素',
      needsPage: true,
      description: '通过 CDP 鼠标移动悬停元素（触发下拉菜单、tooltip 等）',
      params: [
        { key: 'selector', label: 'CSS 选择器（支持 || 分隔备选链）', kind: 'text', required: true, placeholder: '.menu-item' },
        { key: 'elementIndex', label: '第几个匹配（留空=第一个，-1=最后一个，random=随机）', kind: 'text', placeholder: '' },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"target_state","expanded":true}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ hovered, kind:"hover", status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'keyPress',
      label: '键盘按键',
      needsPage: true,
      description: '通过 CDP 键盘输入向元素（或当前焦点元素）发送按键',
      params: [
        { key: 'selector', label: '目标元素选择器（可选，留空用当前焦点元素）', kind: 'text', placeholder: '#search-input' },
        { key: 'key', label: '按键', kind: 'select', default: 'Enter', options: [
          { value: 'Enter', label: 'Enter' },
          { value: 'Escape', label: 'Escape' },
          { value: 'Tab', label: 'Tab' },
          { value: 'ArrowDown', label: '↓ ArrowDown' },
          { value: 'ArrowUp', label: '↑ ArrowUp' },
          { value: 'ArrowLeft', label: '← ArrowLeft' },
          { value: 'ArrowRight', label: '→ ArrowRight' },
          { value: 'Backspace', label: 'Backspace' },
          { value: 'Delete', label: 'Delete' },
        ] },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"查询完成"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ pressed, key, kind:"press", status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'uploadFile',
      label: '上传文件',
      needsPage: true,
      description: '通过 native host 安全物化文本/base64 临时文件，再由统一 PageActionEngine 使用 CDP DOM.setFileInputFiles 上传并清理',
      params: [
        { key: 'selector', label: '文件输入框选择器', kind: 'text', required: true, placeholder: 'input[type=file]' },
        { key: 'fileName', label: '文件名', kind: 'text', required: true, placeholder: 'data.csv' },
        { key: 'mimeType', label: 'MIME 类型', kind: 'text', default: 'text/plain', placeholder: 'text/csv' },
        { key: 'contentMode', label: '内容格式', kind: 'select', default: 'text', options: [
          { value: 'text', label: '纯文本' },
          { value: 'base64', label: 'Base64' },
        ] },
        { key: 'content', label: '文件内容（支持模板）', kind: 'textarea', placeholder: 'a,b,c\n1,2,3' },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"上传成功"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ uploaded, fileInputConfirmed, fileName, size, byteLength, materialized, cleanupDeferred, kind:"upload", status, performed, actionReceipt, receipt, result }',
    },
    {
      type: 'webStorage',
      label: '页面存储读写',
      needsPage: true,
      description: '读写页面的 localStorage / sessionStorage（注入 token、清理登录态等）',
      params: [
        { key: 'storageType', label: '存储类型', kind: 'select', default: 'local', options: [
          { value: 'local', label: 'localStorage' },
          { value: 'session', label: 'sessionStorage' },
        ] },
        { key: 'action', label: '操作', kind: 'select', default: 'get', options: [
          { value: 'get', label: '读取' },
          { value: 'set', label: '写入' },
          { value: 'remove', label: '删除' },
          { value: 'clear', label: '清空' },
        ] },
        { key: 'key', label: 'Key', kind: 'text', placeholder: 'access_token' },
        { key: 'value', label: '值（写入时使用，支持模板）', kind: 'textarea', placeholder: '{{token}}' },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '读取每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '读取返回 { value|entries, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }；写入返回 { kind:"webStorage", status, performed, confirmed, actionReceipt, receipt, verification, result:{ stored|removed|cleared } }',
    },
    {
      type: 'setCookie',
      label: '写入 Cookie',
      needsPage: false,
      description: '为指定 URL 写入 Cookie（注入登录态）',
      params: [
        { key: 'url', label: '目标 URL（支持模板）', kind: 'text', required: true, placeholder: 'https://app.example.com' },
        { key: 'name', label: 'Cookie 名', kind: 'text', required: true, placeholder: 'session_id' },
        { key: 'value', label: 'Cookie 值（支持模板）', kind: 'text', placeholder: '{{sessionId}}' },
        { key: 'expiresDays', label: '有效期（天，0=会话 Cookie）', kind: 'number', default: 0 },
      ],
      outputHint: '{ set: true, name }',
    },
    {
      type: 'getCookie',
      label: '读取 Cookie',
      needsPage: false,
      description: '读取指定 URL 的 Cookie 值（配合输出变量名使用）',
      params: [
        { key: 'url', label: '目标 URL（支持模板）', kind: 'text', required: true, placeholder: 'https://app.example.com' },
        { key: 'name', label: 'Cookie 名', kind: 'text', required: true, placeholder: 'session_id' },
      ],
      outputHint: 'Cookie 值（不存在为 null）',
    },
    {
      type: 'clearCookies',
      label: '清除 Cookie',
      needsPage: false,
      description: '清除指定 URL 的全部（或指定名称）Cookie，用于重置登录态',
      params: [
        { key: 'url', label: '目标 URL（支持模板）', kind: 'text', required: true, placeholder: 'https://app.example.com' },
        { key: 'name', label: 'Cookie 名（可选，留空清除全部）', kind: 'text', placeholder: '' },
      ],
      outputHint: '{ removed: n }',
    },
    {
      type: 'setProxy',
      label: '按 Host 设置代理',
      needsPage: true,
      description: '为匹配 Host 设置浏览器代理（chrome.proxy 为 profile 级设置，其他标签页访问相同 Host 也会受影响）',
      params: [
        { key: 'proxyServer', label: '代理服务器（host:port 或 scheme://host:port）', kind: 'text', required: true, placeholder: '127.0.0.1:7890 或 socks5://127.0.0.1:1080' },
        { key: 'urlPattern', label: 'Host 匹配模式（可选，留空自动使用当前域名）', kind: 'text', placeholder: '*.example.com' },
        { key: 'bypassList', label: '绕过代理 Host（逗号或换行分隔）', kind: 'text', placeholder: 'localhost,127.0.0.1,<local>' },
      ],
      outputHint: '{ success, tabId, proxyServer, proxyScheme, hostPattern, bypassList, activeRules, mode, scope, note }',
    },
    {
      type: 'clearProxy',
      label: '清除会话代理',
      needsPage: false,
      description: '清除当前运行会话登记的代理规则；其他会话规则仍会保留并重新合并 PAC',
      params: [],
      outputHint: '{ cleared, activeRules }',
    },
    {
      type: 'ifStart',
      label: '条件分支 If',
      needsPage: false,
      description: '条件为真执行 If 体，否则跳到 Else 分支（或分支结束）',
      params: [
        { key: 'ifId', label: '分支 ID', kind: 'text', required: true },
        { key: 'condition', label: '条件（安全表达式，支持模板与 contains(...) 等函数）', kind: 'textarea', required: true, placeholder: '{{orders.rowCount}} > 0' },
      ],
      outputHint: '{ conditionMet }',
    },
    {
      type: 'elseBlock',
      label: 'Else 分支',
      needsPage: false,
      description: '条件分支的 Else 标记（可选，需与 If 的分支 ID 一致）',
      params: [
        { key: 'ifId', label: '分支 ID', kind: 'text', required: true },
      ],
      outputHint: '{}',
    },
    {
      type: 'ifEnd',
      label: '条件分支结束',
      needsPage: false,
      description: '条件分支结束标记',
      params: [
        { key: 'ifId', label: '分支 ID', kind: 'text', required: true },
      ],
      outputHint: '{}',
    },
    {
      type: 'extractText',
      label: '提取元素文本/属性',
      needsPage: true,
      description: '提取单个（或全部匹配）元素的文本、属性、表单值到变量',
      params: [
        { key: 'selector', label: 'CSS 选择器（支持 || 分隔备选链）', kind: 'text', required: true, placeholder: '.order-no' },
        { key: 'attr', label: '提取内容', kind: 'select', default: 'text', options: [
          { value: 'text', label: '文本内容' },
          { value: 'innerText', label: '可见文本（保留换行）' },
          { value: 'textContent', label: '原始 textContent' },
          { value: 'value', label: '表单值 (input/select)' },
          { value: 'html', label: 'innerHTML' },
          { value: 'attribute', label: '指定属性（下方填属性名）' },
        ] },
        { key: 'attributeName', label: '属性名（提取内容选「指定属性」时必填）', kind: 'text', placeholder: 'href / data-id' },
        { key: 'childSelector', label: '子元素选择器（可选，限定在命中的父元素内提取并拼接）', kind: 'text', placeholder: '.item-title' },
        { key: 'childSeparator', label: '子元素拼接分隔符', kind: 'text', default: '\n', placeholder: '\\n' },
        { key: 'all', label: '提取全部匹配（输出数组）', kind: 'boolean', default: false },
        { key: 'elementIndex', label: '第几个匹配（留空=第一个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ type:"extracted-value", value, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'elementInfo',
      label: '获取元素状态',
      needsPage: true,
      description: '按 selector/ref/locator 探测元素状态（不存在也不报错），输出 exists/visible/count/text/bounds/framework/selectors，配合条件分支使用',
      params: [
        { key: 'selector', label: 'CSS 选择器（支持 || 分隔备选链）', kind: 'text', placeholder: '.error-banner' },
        { key: 'ref', label: '元素 ref（可选，来自 inspectStructure/inspectElement）', kind: 'text', placeholder: 'body/child:0/child:1' },
        { key: 'locator', label: '结构化 locator JSON（可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"selector":".error-banner"}' },
        { key: 'elementIndex', label: '第几个匹配（留空=第一个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'timeoutMs', label: '等待出现时长(ms，0=立即检查不等待)', kind: 'number', default: 0 },
      ],
      outputHint: '{ exists, visible, count, text, bounds, framework, selectors }',
    },
    {
      type: 'inspectStructure',
      label: '观测页面结构',
      needsPage: true,
      description: '输出页面或局部区域的结构化 DOM 骨架 JSON，适合 SPA/Web Components 页面定位与调试',
      params: [
        { key: 'selector', label: '限定区域选择器（留空=body）', kind: 'text', placeholder: 'body / main / .app' },
        { key: 'ref', label: '元素 ref（可选，来自上次观测）', kind: 'text', placeholder: 'body/child:0/...' },
        { key: 'mode', label: '观测模式', kind: 'select', default: 'skeleton', options: [
          { value: 'skeleton', label: '骨架（少量文本）' },
          { value: 'interactive', label: '交互元素优先' },
          { value: 'all', label: '包含隐藏元素' },
        ] },
        { key: 'maxDepth', label: '最大深度', kind: 'number', default: 5 },
        { key: 'start', label: '节点起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '{ type:"structure", items, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'inspectText',
      label: '观测页面文本',
      needsPage: true,
      description: '分页读取页面或局部区域的纯文本，避免大型 SPA 内容一次性截断',
      params: [
        { key: 'selector', label: '限定区域选择器（留空=body）', kind: 'text', placeholder: '.content' },
        { key: 'ref', label: '元素 ref（可选）', kind: 'text', placeholder: '' },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '{ type:"text", content, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'inspectHtml',
      label: '观测页面 HTML',
      needsPage: true,
      description: '分页读取页面或局部区域 HTML，适合在结构观测后深挖某个容器',
      params: [
        { key: 'selector', label: '限定区域选择器（留空=body）', kind: 'text', placeholder: '.content' },
        { key: 'ref', label: '元素 ref（可选）', kind: 'text', placeholder: '' },
        { key: 'outer', label: '包含元素自身 outerHTML', kind: 'boolean', default: false },
        { key: 'start', label: '读取起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '{ type:"innerHTML|outerHTML", content, start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'inspectCss',
      label: '观测 CSS',
      needsPage: true,
      description: '读取样式表或指定元素的计算样式，支持分页',
      params: [
        { key: 'selector', label: '元素选择器（可选；填写则返回计算样式）', kind: 'text', placeholder: '.btn-primary' },
        { key: 'ref', label: '元素 ref（可选）', kind: 'text', placeholder: '' },
        { key: 'properties', label: '计算样式属性（逗号分隔）', kind: 'text', placeholder: 'display,position,color' },
        { key: 'start', label: '读取起始位置（仅全局样式表）', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '样式表每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '{ type:"css", computed? 或 content/start/maxChars/returnedChars/remainingChars/hasMore/nextStart }',
    },
    {
      type: 'inspectJavascript',
      label: '观测 JS 状态',
      needsPage: true,
      description: '只读观测页面 JS 环境：框架、路由、存储 key、脚本列表、指定全局变量摘要；不执行任意代码',
      params: [
        { key: 'globalKeys', label: '全局变量白名单（逗号分隔）', kind: 'text', placeholder: '__APP__,app,$nuxt' },
        { key: 'start', label: '脚本起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '{ type:"javascript", frameworks, location, items:[{kind:"global|localStorage-key|sessionStorage-key|script",...}], start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'searchPage',
      label: '搜索页面内容',
      needsPage: true,
      description: '按关键字/正则全域搜索页面元素、文本、HTML、CSS、脚本，返回命中位置 where、上下文片段和元素 ref，避免整页观测导致上下文过大',
      params: [
        { key: 'query', label: '搜索词/正则', kind: 'text', placeholder: '登录 / submit / data-testid / color' },
        { key: 'types', label: '搜索范围（可选）', kind: 'text', placeholder: '默认全部；可填 text,element,html,css,script' },
        { key: 'selector', label: '限定区域或元素选择器（可选）', kind: 'text', placeholder: 'main / button.primary / script[src*=\"app\"]' },
        { key: 'ref', label: '限定区域 ref（可选）', kind: 'text', placeholder: 'body/child:0/...' },
        { key: 'regex', label: '按正则匹配', kind: 'boolean', default: false },
        { key: 'caseSensitive', label: '区分大小写', kind: 'boolean', default: false },
        { key: 'includeHidden', label: '包含隐藏元素', kind: 'boolean', default: false },
        { key: 'contextChars', label: '上下文字符数', kind: 'number', default: 120 },
        { key: 'start', label: '命中起始位置', kind: 'number', required: true, default: 0 },
        { key: 'maxChars', label: '每页最大字符数', kind: 'number', required: true, default: 10000 },
      ],
      outputHint: '{ type:"search", matches:[{where:{type,...}, match/snippet, element/ref}], start, maxChars, returnedChars, remainingChars, hasMore, nextStart }',
    },
    {
      type: 'assertAttribute',
      label: '断言: 属性/样式/表单值',
      needsPage: true,
      description: '断言元素 HTML 属性、CSS 计算样式、表单值或勾选状态匹配预期',
      params: [
        { key: 'selector', label: 'CSS 选择器（支持 || 分隔备选链）', kind: 'text', required: true, placeholder: 'input#agree' },
        { key: 'checkType', label: '检查内容', kind: 'select', default: 'attribute', options: [
          { value: 'attribute', label: 'HTML 属性' },
          { value: 'css', label: 'CSS 计算样式' },
          { value: 'value', label: '表单值 (input/select)' },
          { value: 'checked', label: '勾选状态 (checkbox/radio，预期填 true/false)' },
        ] },
        { key: 'name', label: '属性/样式名（检查属性或样式时必填）', kind: 'text', placeholder: 'disabled / background-color' },
        { key: 'matchMode', label: '匹配方式', kind: 'select', default: 'equals', options: [
          { value: 'equals', label: '完全相等' },
          { value: 'contains', label: '包含' },
          { value: 'regex', label: '正则匹配' },
          { value: 'notContains', label: '不包含' },
        ] },
        { key: 'expected', label: '预期值（支持模板）', kind: 'text', placeholder: 'true' },
        { key: 'elementIndex', label: '第几个匹配（留空=第一个，-1=最后一个）', kind: 'text', placeholder: '' },
        { key: 'timeoutMs', label: '等待超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ passed:true, actual, expected, verification }',
    },
    {
      type: 'dragDrop',
      label: '拖拽元素',
      needsPage: true,
      description: '通过 CDP 鼠标序列拖拽源元素，并在提供 drag data 时通过 Input.dispatchDragEvent 完成 HTML5 拖放',
      params: [
        { key: 'sourceSelector', label: '源元素选择器', kind: 'text', required: true, placeholder: '.card[data-id="1"]' },
        { key: 'targetSelector', label: '目标元素选择器', kind: 'text', required: true, placeholder: '.column.done' },
        { key: 'steps', label: '鼠标移动分步数（拟人）', kind: 'number', default: 8 },
        { key: 'dragItems', label: 'HTML5 DragData 条目（JSON，可选）', kind: 'textarea', placeholder: '[{"mimeType":"text/plain","data":"card-1"}]' },
        { key: 'dragOperationsMask', label: 'HTML5 拖放操作掩码', kind: 'number', default: 1 },
        { key: 'expect', label: '动作后置条件（高级，可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{"type":"text_present","text":"已移动"}' },
        confirmationParamDefinition(),
        { key: 'timeoutMs', label: '等待元素超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ dragged, dragTargetRef, kind:"drag", status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'screenshot',
      label: '截图',
      needsPage: true,
      description: '通过统一页面感知引擎截取页面可视区域，输出 dataUrl 可供 Webhook/脚本使用',
      params: [
        { key: 'quality', label: 'JPEG 质量(1-100)', kind: 'number', default: 70 },
      ],
      outputHint: '{ dataUrl, capturedAt }',
    },
    {
      type: 'assertScreenshot',
      label: '断言: 视觉对比',
      needsPage: true,
      description: '截图与基线对比（像素差异率超阈值则失败）。首次运行自动保存基线；改版后勾选「更新基线」重新采集',
      params: [
        { key: 'baselineKey', label: '基线标识（留空=自动按节点生成，跨流程复用基线时填写）', kind: 'text', placeholder: '' },
        { key: 'mismatchThresholdPct', label: '允许差异率(%)', kind: 'number', default: 1 },
        { key: 'updateBaseline', label: '本次运行更新基线（采集后请关闭）', kind: 'boolean', default: false },
      ],
      outputHint: '{ passed:true, mismatchPct?, baselineCreated?, baselineKey, verification }',
    },
    {
      type: 'httpRequest',
      label: 'HTTP 请求 (API 测试)',
      needsPage: false,
      description: '发送 HTTP 请求并输出响应（status/json/body），配合「断言: 变量/数据」「JSON 数据提取」做接口断言',
      params: [
        { key: 'url', label: '请求 URL（支持模板）', kind: 'text', required: true, placeholder: 'https://api.example.com/orders' },
        { key: 'method', label: '方法', kind: 'select', default: 'GET', options: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'headers', label: '请求头（每行 Key: Value，支持模板）', kind: 'textarea', placeholder: 'Authorization: Bearer {{token}}' },
        { key: 'body', label: '请求体（支持模板）', kind: 'textarea', placeholder: '{"page": 1}' },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ status, ok, json, body }',
    },
    {
      type: 'httpLoadTest',
      label: 'HTTP 性能压测',
      needsPage: false,
      description: '对 HTTP 接口发起轻量并发压测并统计吞吐、错误率和延迟分位数。适合接口冒烟压测；浏览器扩展不是专业压测机，不应用于高并发生产压测',
      params: [
        { key: 'url', label: '请求 URL（支持模板）', kind: 'text', required: true, placeholder: 'https://api.example.com/orders' },
        { key: 'method', label: '方法', kind: 'select', default: 'GET', options: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'headers', label: '请求头（每行 Key: Value，支持模板）', kind: 'textarea', placeholder: 'Authorization: Bearer {{token}}' },
        { key: 'body', label: '请求体（支持模板）', kind: 'textarea', placeholder: '{"page": 1}' },
        { key: 'concurrency', label: '并发数', kind: 'number', default: 5 },
        { key: 'maxRequests', label: '最大请求数（0=按时长运行）', kind: 'number', default: 50 },
        { key: 'durationMs', label: '最长运行时长(ms，0=不限)', kind: 'number', default: 0 },
        { key: 'requestTimeoutMs', label: '单请求超时(ms)', kind: 'number', default: 30000 },
        { key: 'p95ThresholdMs', label: 'P95 延迟阈值(ms，0=不检查)', kind: 'number', default: 0 },
        { key: 'maxErrorRatePct', label: '最大错误率(%，0=不检查)', kind: 'number', default: 0 },
        { key: 'failOnThreshold', label: '超过阈值时让节点失败', kind: 'boolean', default: true },
      ],
      outputHint: '{ total, ok, failed, errorRatePct, elapsedMs, rps, latency:{min,max,avg,p50,p90,p95,p99}, statusCounts, errors, thresholdPassed, thresholdFailures }',
    },
    {
      type: 'dataMap',
      label: '数据映射转换',
      needsPage: false,
      description: '对对象或数组做字段映射、重命名和类型转换。映射每行格式：目标字段|来源路径|类型|默认值，也支持 source -> target:type',
      params: [
        { key: 'sourcePath', label: '数据源路径', kind: 'text', default: 'last', placeholder: 'last / orders.items' },
        { key: 'mappings', label: '字段映射', kind: 'textarea', placeholder: 'id|order.id|string\namount|price|number\nactive|enabled|boolean' },
        { key: 'keepUnmapped', label: '保留未映射字段', kind: 'boolean', default: false },
      ],
      outputHint: '{ result, items?, count }',
    },
    {
      type: 'dataProject',
      label: '数据投影聚合',
      needsPage: false,
      description: '从上下文对象或数组生成新的结构化对象；支持按字段过滤数组、取值/拼接/计数/数组输出、正则替换，并可把结果写回多个上下文路径。适合把页面数据片段投影为 result、items 等通用变量',
      params: [
        { key: 'sourcePath', label: '数据源路径', kind: 'text', default: 'last', placeholder: 'last / currentFragments / response.items' },
        { key: 'fields', label: '输出字段 JSON', kind: 'textarea', required: true, valueFormat: 'json', placeholder: '{\n  "content": {\n    "mode": "join",\n    "contentPath": "text",\n    "filter": { "path": "type", "operator": "in", "values": ["answer"], "caseInsensitive": true },\n    "replace": [{ "pattern": "\\\\[ref:\\\\d+\\\\]", "replacement": "", "flags": "g" }]\n  }\n}' },
        { key: 'setPaths', label: '写入上下文路径 JSON（可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{\n  "result": "$result",\n  "currentValue": "content"\n}' },
      ],
      outputHint: '按 fields 生成的对象；setPaths 可同步写入 ctx.result/currentValue 等路径',
    },
    {
      type: 'dataCompose',
      label: '上下文变量组合',
      needsPage: false,
      description: '从当前 ctx 路径、coalesce 路径、条件表达式、正则提取和模板生成多个变量；字段按声明顺序计算，后续字段可引用前面字段。适合把请求入参、状态标志和包装模板组合为下游输入',
      params: [
        { key: 'fields', label: '组合字段 JSON', kind: 'textarea', required: true, valueFormat: 'json', placeholder: '{\n  "title": { "coalescePaths": ["input.title", "fallbackTitle"], "trim": true },\n  "hasTitle": { "mode": "nonEmpty", "path": "title" },\n  "id": { "mode": "regex", "path": "url", "pattern": "/items/([^/?#]+)", "group": 1 },\n  "message": {\n    "condition": "{{json hasTitle}} === true",\n    "template": "标题：{{title}}\\n正文：{{body}}",\n    "elsePath": "body"\n  }\n}' },
        { key: 'setPaths', label: '额外写入上下文路径 JSON（可选）', kind: 'textarea', valueFormat: 'json', placeholder: '{\n  "stream": "$result",\n  "payload.message": "message"\n}' },
      ],
      outputHint: '按 fields 生成的对象；字段默认写入同名 ctx 变量，也可用 setPaths 额外写入',
    },
    {
      type: 'dataFilter',
      label: '数据过滤',
      needsPage: false,
      description: '按表达式过滤数组。表达式支持 {{item.xxx}}、{{index}}，例如 {{item.amount}} > 100',
      params: [
        { key: 'sourcePath', label: '数组数据源路径', kind: 'text', default: 'last', placeholder: 'last.items' },
        { key: 'expression', label: '过滤表达式', kind: 'textarea', placeholder: '{{item.status}} == "paid" && {{item.amount}} > 100' },
        { key: 'field', label: '字段路径（无表达式时使用）', kind: 'text', placeholder: 'status' },
        { key: 'operator', label: '比较方式', kind: 'select', default: '==', options: [
          { value: '==', label: '等于' },
          { value: '!=', label: '不等于' },
          { value: '>', label: '大于' },
          { value: '>=', label: '大于等于' },
          { value: '<', label: '小于' },
          { value: '<=', label: '小于等于' },
          { value: 'contains', label: '包含' },
          { value: 'notContains', label: '不包含' },
          { value: 'regex', label: '正则' },
        ] },
        { key: 'expected', label: '预期值（无表达式时使用）', kind: 'text', placeholder: 'paid' },
      ],
      outputHint: '{ items, count, total }',
    },
    {
      type: 'dataJoin',
      label: '数据关联合并',
      needsPage: false,
      description: '按 key 合并两组数组数据，支持 left/inner/full join',
      params: [
        { key: 'leftSourcePath', label: '左侧数组路径', kind: 'text', default: 'last', placeholder: 'orders.items' },
        { key: 'rightSourcePath', label: '右侧数组路径', kind: 'text', required: true, placeholder: 'customers.items' },
        { key: 'leftKey', label: '左侧 key 路径', kind: 'text', required: true, placeholder: 'customerId' },
        { key: 'rightKey', label: '右侧 key 路径', kind: 'text', required: true, placeholder: 'id' },
        { key: 'joinType', label: '关联方式', kind: 'select', default: 'left', options: [
          { value: 'left', label: 'left' },
          { value: 'inner', label: 'inner' },
          { value: 'full', label: 'full' },
        ] },
        { key: 'rightPrefix', label: '右侧字段前缀', kind: 'text', placeholder: 'customer_' },
      ],
      outputHint: '{ items, count, leftCount, rightCount, joinType }',
    },
    {
      type: 'dataDedupe',
      label: '数据去重',
      needsPage: false,
      description: '按字段或表达式对数组去重',
      params: [
        { key: 'sourcePath', label: '数组数据源路径', kind: 'text', default: 'last', placeholder: 'last.items' },
        { key: 'keyFields', label: '去重字段（逗号或换行）', kind: 'text', placeholder: 'id,email' },
        { key: 'keyExpression', label: '去重表达式（可选）', kind: 'textarea', placeholder: '{{item.id}}-{{item.version}}' },
        { key: 'keep', label: '保留策略', kind: 'select', default: 'first', options: [
          { value: 'first', label: '保留第一条' },
          { value: 'last', label: '保留最后一条' },
        ] },
      ],
      outputHint: '{ items, count, removed, total }',
    },
    {
      type: 'dataAggregate',
      label: '数据汇总',
      needsPage: false,
      description: '对数组做 count/sum/avg/min/max 汇总，可按字段 groupBy',
      params: [
        { key: 'sourcePath', label: '数组数据源路径', kind: 'text', default: 'last', placeholder: 'last.items' },
        { key: 'groupBy', label: '分组字段（逗号或换行，可选）', kind: 'text', placeholder: 'status,region' },
        { key: 'metrics', label: '汇总指标（每行 op|field|alias 或 sum(amount) as total）', kind: 'textarea', placeholder: 'count||count\nsum|amount|totalAmount\navg(amount) as avgAmount' },
        { key: 'operation', label: '单指标操作（metrics 为空时）', kind: 'select', default: 'count', options: [
          { value: 'count', label: 'count' },
          { value: 'sum', label: 'sum' },
          { value: 'avg', label: 'avg' },
          { value: 'min', label: 'min' },
          { value: 'max', label: 'max' },
        ] },
        { key: 'field', label: '单指标字段', kind: 'text', placeholder: 'amount' },
        { key: 'alias', label: '单指标输出名', kind: 'text', placeholder: 'totalAmount' },
      ],
      outputHint: '无 groupBy 输出汇总对象；有 groupBy 输出 { items, count, total }',
    },
    {
      type: 'checkpointGet',
      label: '读取同步游标',
      needsPage: false,
      description: '从本地存储读取流程同步游标',
      params: [
        { key: 'scope', label: '游标作用域（留空=当前流程）', kind: 'text', placeholder: 'orders-sync' },
        { key: 'name', label: '游标名称', kind: 'text', default: 'default', placeholder: 'updatedAt' },
        { key: 'defaultValue', label: '默认值', kind: 'text', placeholder: '0 或 "2026-01-01T00:00:00Z"' },
      ],
      outputHint: '{ key, exists, value, updatedAt }',
    },
    {
      type: 'checkpointSet',
      label: '保存同步游标',
      needsPage: false,
      description: '把指定值或上一节点输出保存为流程同步游标',
      params: [
        { key: 'scope', label: '游标作用域（留空=当前流程）', kind: 'text', placeholder: 'orders-sync' },
        { key: 'name', label: '游标名称', kind: 'text', default: 'default', placeholder: 'updatedAt' },
        { key: 'value', label: '游标值（留空使用 sourcePath）', kind: 'textarea', placeholder: '{{last.maxUpdatedAt}}' },
        { key: 'sourcePath', label: '游标值来源路径', kind: 'text', placeholder: 'last.maxUpdatedAt' },
        { key: 'parseJson', label: '按 JSON 解析游标值', kind: 'boolean', default: false },
      ],
      outputHint: '{ key, value, updatedAt }',
    },
    {
      type: 'dataDiff',
      label: '数据差异比较',
      needsPage: false,
      description: '比较新旧数组，输出新增、更新、删除和未变化记录',
      params: [
        { key: 'oldSourcePath', label: '旧数据数组路径', kind: 'text', required: true, placeholder: 'oldRows' },
        { key: 'newSourcePath', label: '新数据数组路径', kind: 'text', default: 'last', placeholder: 'last.items' },
        { key: 'keyFields', label: '主键字段（逗号或换行）', kind: 'text', required: true, placeholder: 'id' },
        { key: 'compareFields', label: '比较字段（留空比较整行）', kind: 'text', placeholder: 'name,amount,status' },
      ],
      outputHint: '{ created, updated, deleted, unchanged, summary }',
    },
    {
      type: 'forEachParallel',
      label: '数组并发处理',
      needsPage: false,
      description: '在单个节点内部对数组并发执行 HTTP/Webhook/模板转换，支持并发数限制；不是流程分支编排',
      params: [
        { key: 'sourcePath', label: '数组数据源路径', kind: 'text', default: 'last', placeholder: 'last.items' },
        { key: 'concurrency', label: '并发数', kind: 'number', default: 5 },
        { key: 'action', label: '处理动作', kind: 'select', default: 'identity', options: [
          { value: 'identity', label: '原样返回' },
          { value: 'template', label: '模板转换' },
          { value: 'httpRequest', label: 'HTTP 请求' },
          { value: 'webhook', label: 'Webhook' },
        ] },
        { key: 'url', label: 'URL（HTTP/Webhook，支持 {{item.xxx}}）', kind: 'text', placeholder: 'https://api.example.com/items/{{item.id}}' },
        { key: 'method', label: '方法', kind: 'select', default: 'AUTO', options: [
          { value: 'AUTO', label: '自动（HTTP=GET，Webhook=POST）' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'headers', label: '请求头', kind: 'textarea', placeholder: 'Authorization: Bearer {{token}}' },
        { key: 'bodyTemplate', label: '请求体模板', kind: 'textarea', placeholder: '{{json item}}' },
        { key: 'resultTemplate', label: '结果模板（template 动作用）', kind: 'textarea', placeholder: '{"id": {{json item.id}}, "index": {{index}}}' },
        { key: 'failFast', label: '任一失败立即中止', kind: 'boolean', default: true },
        { key: 'timeoutMs', label: '单项超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ items:[{index, ok, value/error}], total, ok, failed }',
    },
    {
      type: 'exportTestReport',
      label: '导出流程报告',
      needsPage: false,
      outputType: 'flow-report',
      description: '导出当前运行的 JSON、HTML 或 JUnit 流程报告，可附带产物和调试追踪',
      params: [
        { key: 'format', label: '报告格式', kind: 'select', default: 'json', options: [
          { value: 'json', label: 'JSON' },
          { value: 'html', label: 'HTML' },
          { value: 'junit', label: 'JUnit XML' },
        ] },
        { key: 'saveFile', label: '保存到下载目录', kind: 'boolean', default: true },
        { key: 'directory', label: '下载子目录', kind: 'text', default: 'PageAgent/reports' },
        { key: 'fileName', label: '文件名（留空自动生成）', kind: 'text', placeholder: 'flow-report.html' },
        { key: 'includeContext', label: '包含运行上下文', kind: 'boolean', default: false },
        { key: 'includeDebugTrace', label: '包含调试追踪', kind: 'boolean', default: true },
        { key: 'waitComplete', label: '等待文件保存完成', kind: 'boolean', default: true },
        { key: 'timeoutMs', label: '保存超时(ms)', kind: 'number', default: 60000 },
      ],
      outputHint: '{ format, report, content, file? }',
    },
    {
      type: 'attachArtifact',
      label: '附加运行产物',
      needsPage: false,
      description: '把截图、日志、下载文件或任意数据附加到当前流程报告',
      params: [
        { key: 'name', label: '产物名称', kind: 'text', required: true, placeholder: 'error-screenshot' },
        { key: 'artifactType', label: '产物类型', kind: 'select', default: 'data', options: [
          { value: 'data', label: '数据' },
          { value: 'screenshot', label: '截图' },
          { value: 'log', label: '日志' },
          { value: 'file', label: '文件' },
        ] },
        { key: 'sourcePath', label: '内容来源路径', kind: 'text', default: 'last' },
        { key: 'content', label: '直接内容（留空使用来源路径）', kind: 'textarea', placeholder: '{{json last}}' },
        { key: 'mimeType', label: 'MIME 类型', kind: 'text', placeholder: 'application/json' },
      ],
      outputHint: '{ attached, artifact, count }',
    },
    {
      type: 'assertPerformance',
      label: '断言: 性能阈值',
      needsPage: false,
      description: '基于 httpLoadTest 或 CDP 性能结果做阈值断言',
      params: [
        { key: 'sourcePath', label: '性能结果路径', kind: 'text', default: 'last' },
        { key: 'maxP95Ms', label: '最大 P95(ms，0=不检查)', kind: 'number', default: 0 },
        { key: 'maxP99Ms', label: '最大 P99(ms，0=不检查)', kind: 'number', default: 0 },
        { key: 'maxAvgMs', label: '最大平均耗时(ms，0=不检查)', kind: 'number', default: 0 },
        { key: 'maxErrorRatePct', label: '最大错误率(%，0=不检查)', kind: 'number', default: 0 },
        { key: 'maxLongTasks', label: '最大长任务数（-1=不检查）', kind: 'number', default: -1 },
      ],
      outputHint: '{ passed:true, checked:true, source }',
    },
    {
      type: 'exitGate',
      label: 'CI 退出门禁',
      needsPage: false,
      description: '按断言、报告或运行摘要生成 CI 成败状态',
      params: [
        { key: 'sourcePath', label: '汇总数据路径（留空使用当前节点状态）', kind: 'text', placeholder: 'last.summary' },
        { key: 'condition', label: '通过条件表达式（可选）', kind: 'textarea', placeholder: '{{summary.failed}} == 0' },
        { key: 'maxFailures', label: '最大失败数', kind: 'number', default: 0 },
        { key: 'requiredStatus', label: '要求状态（可选）', kind: 'text', placeholder: 'success' },
      ],
      outputHint: '{ passed, summary }',
    },
    {
      type: 'exportRunSummary',
      label: '导出运行摘要',
      needsPage: false,
      description: '输出机器可读的运行摘要 JSON',
      params: [
        { key: 'saveFile', label: '保存到下载目录', kind: 'boolean', default: true },
        { key: 'directory', label: '下载子目录', kind: 'text', default: 'PageAgent/reports' },
        { key: 'fileName', label: '文件名（留空自动生成）', kind: 'text', placeholder: 'run-summary.json' },
        { key: 'waitComplete', label: '等待文件保存完成', kind: 'boolean', default: true },
      ],
      outputHint: '{ summary, file? }',
    },
    {
      type: 'accessibilityCheck',
      label: '可访问性检查',
      needsPage: true,
      description: '基于统一页面快照运行内置可访问性规则检查',
      params: [
        { key: 'maxViolations', label: '允许违规数', kind: 'number', default: 0 },
        { key: 'failOnViolation', label: '超过阈值时失败', kind: 'boolean', default: true },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ passed:true, engine:"PagePerceptionEngine", violations, count, verification, actionReceipt, receipt }',
    },
    {
      type: 'coverageMark',
      label: '覆盖点标记',
      needsPage: false,
      description: '标记页面或功能覆盖点，后续报告会包含覆盖记录',
      params: [
        { key: 'markId', label: '覆盖点 ID', kind: 'text', required: true, placeholder: 'checkout.submit' },
        { key: 'name', label: '覆盖点名称', kind: 'text', placeholder: '提交订单' },
        { key: 'status', label: '覆盖状态', kind: 'select', default: 'covered', options: [
          { value: 'covered', label: '已覆盖' },
          { value: 'partial', label: '部分覆盖' },
          { value: 'skipped', label: '跳过' },
        ] },
        { key: 'detail', label: '备注', kind: 'textarea', placeholder: '已覆盖主路径' },
      ],
      outputHint: '{ marked, mark, count }',
    },
    {
      type: 'mockNetwork',
      label: 'Mock 网络请求',
      needsPage: true,
      description: '在页面 MAIN world 拦截后续 fetch 请求并返回 mock 响应',
      params: [
        { key: 'action', label: '操作', kind: 'select', default: 'set', options: [
          { value: 'set', label: '追加规则' },
          { value: 'replace', label: '替换规则' },
          { value: 'clear', label: '清除规则' },
        ] },
        { key: 'urlFilter', label: 'URL 匹配', kind: 'text', placeholder: '/api/orders' },
        { key: 'matchMode', label: '匹配方式', kind: 'select', default: 'contains', options: [
          { value: 'contains', label: '包含' },
          { value: 'regex', label: '正则' },
        ] },
        { key: 'method', label: '请求方法（留空不限）', kind: 'select', default: '', options: [
          { value: '', label: '不限' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'status', label: '响应状态码', kind: 'number', default: 200 },
        { key: 'responseHeaders', label: '响应头', kind: 'textarea', placeholder: 'Content-Type: application/json' },
        { key: 'responseBody', label: '响应体', kind: 'textarea', placeholder: '{"ok":true}' },
        { key: 'delayMs', label: '延迟(ms)', kind: 'number', default: 0 },
        { key: 'timeoutMs', label: '注入超时(ms)', kind: 'number', default: 30000 },
      ],
      outputHint: '{ mocked, cleared?, rules, hits?, actionReceipt, receipt }',
    },
    {
      type: 'routeAssert',
      label: '断言: 网络路由',
      needsPage: true,
      description: '断言页面捕获的请求是否发生、次数、状态码和响应内容。需在页面配置中开启捕获网络请求',
      params: [
        { key: 'urlFilter', label: 'URL 包含', kind: 'text', required: true, placeholder: '/api/orders' },
        { key: 'method', label: '请求方法', kind: 'select', default: '', options: [
          { value: '', label: '不限' },
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ] },
        { key: 'resourceType', label: '资源类型', kind: 'select', default: '', options: [
          { value: '', label: '不限' },
          { value: 'fetch', label: 'fetch' },
          { value: 'xhr', label: 'XHR' },
          { value: 'sse', label: 'SSE' },
        ] },
        { key: 'minCount', label: '最少次数', kind: 'number', default: 1 },
        { key: 'maxCount', label: '最多次数（0=不限制）', kind: 'number', default: 0 },
        { key: 'status', label: '期望状态码（可选）', kind: 'number', default: 0 },
        { key: 'bodyContains', label: '响应体包含（可选）', kind: 'text', placeholder: '"success":true' },
        { key: 'maxDurationMs', label: '最大耗时(ms，捕获到 durationMs 时检查)', kind: 'number', default: 0 },
        { key: 'timeoutMs', label: '等待超时(ms)', kind: 'number', default: 10000 },
      ],
      outputHint: '{ passed, count, entries, verification, actionReceipt, receipt }',
    },
    {
      type: 'setVariable',
      label: '设置变量',
      needsPage: false,
      description: '把模板计算结果写入上下文变量（下游节点用 {{变量名}} 引用）',
      params: [
        { key: 'name', label: '变量名', kind: 'text', required: true, placeholder: 'orderNo' },
        { key: 'value', label: '值（支持模板）', kind: 'textarea', placeholder: '{{t.rows[0].订单号}}' },
        { key: 'parseJson', label: '解析为 JSON（值是 JSON 文本时勾选）', kind: 'boolean', default: false },
      ],
      outputHint: '变量值',
    },
    {
      type: 'contextPrune',
      label: '清理上下文变量',
      needsPage: false,
      description: '删除指定 ctx 路径，释放长流程中不再需要的中间结果；也可清空 last/_lastContent 或调试追踪。适合放在循环尾部或阶段切换处',
      params: [
        { key: 'paths', label: '要删除的 ctx 路径（逗号或换行分隔）', kind: 'textarea', placeholder: 'largeHtml\nrawRows\ntemp.response' },
        { key: 'clearLast', label: '同时清空 last/_lastContent', kind: 'boolean', default: false },
        { key: 'clearDebugTrace', label: '清空调试追踪', kind: 'boolean', default: false },
      ],
      outputHint: '{ removed, removedCount, compacted, remainingKeys }',
    },
    {
      type: 'addAttribute',
      label: '添加 FlowData 属性',
      needsPage: false,
      description: '向当前 FlowData 添加或修改 attributes 元数据（用于标记数据、路由决策、调试追踪）',
      params: [
        { key: 'key', label: '属性键', kind: 'text', required: true, placeholder: 'validation.status' },
        { key: 'value', label: '属性值（支持模板）', kind: 'text', required: true, placeholder: 'approved 或 {{status}}' },
        { key: 'mode', label: '添加模式', kind: 'select', default: 'add', options: [
          { value: 'add', label: '添加/覆盖（键存在则覆盖）' },
          { value: 'addIfAbsent', label: '仅在键不存在时添加' },
        ] },
      ],
      outputHint: 'FlowData（attributes 已更新）',
    },
    {
      type: 'randomData',
      label: '生成测试数据',
      needsPage: false,
      description: '本地生成自动化测试数据，支持单值、批量数组和字段模板对象（数字/字符串/姓名/手机号/邮箱/身份证/银行卡/地址等）',
      params: [
        { key: 'kind', label: '数据类型', kind: 'select', default: 'string', options: [
          { value: 'uuid', label: 'UUID' },
          { value: 'int', label: '随机整数（min~max）' },
          { value: 'float', label: '随机小数（min~max，2 位小数）' },
          { value: 'string', label: '随机字符串（指定长度）' },
          { value: 'digits', label: '随机数字串' },
          { value: 'name', label: '中文姓名' },
          { value: 'phone', label: '手机号' },
          { value: 'email', label: '邮箱' },
          { value: 'username', label: '用户名' },
          { value: 'password', label: '密码' },
          { value: 'idCard', label: '中国大陆身份证号（18 位校验）' },
          { value: 'bankCard', label: '银行卡号（Luhn 校验）' },
          { value: 'birthday', label: '生日日期' },
          { value: 'date', label: '日期' },
          { value: 'timestamp', label: '当前时间戳(ms)' },
          { value: 'datetime', label: '当前时间（YYYY-MM-DD HH:mm:ss）' },
          { value: 'address', label: '中文地址' },
          { value: 'province', label: '省/直辖市' },
          { value: 'city', label: '城市' },
          { value: 'company', label: '公司名' },
          { value: 'url', label: 'URL' },
          { value: 'ip', label: 'IPv4 地址' },
          { value: 'boolean', label: '布尔值' },
        ] },
        { key: 'min', label: 'min（数字类型用）', kind: 'number', default: 0 },
        { key: 'max', label: 'max（数字类型用）', kind: 'number', default: 100 },
        { key: 'decimals', label: '小数位数（float 用）', kind: 'number', default: 2 },
        { key: 'length', label: '长度（字符串用）', kind: 'number', default: 8 },
        { key: 'count', label: '生成数量（1=单值，>1 输出 items 数组）', kind: 'number', default: 1 },
        { key: 'prefix', label: '前缀（字符串/邮箱/用户名/URL 用，支持模板）', kind: 'text', placeholder: 'test_' },
        { key: 'suffix', label: '后缀（字符串/用户名用，支持模板）', kind: 'text', placeholder: '' },
        { key: 'charset', label: '字符集（字符串/密码用）', kind: 'select', default: 'alnum', options: [
          { value: 'alnum', label: '字母+数字' },
          { value: 'alpha', label: '字母' },
          { value: 'lower', label: '小写字母' },
          { value: 'upper', label: '大写字母' },
          { value: 'digits', label: '数字' },
          { value: 'hex', label: '十六进制' },
          { value: 'password', label: '密码安全字符' },
          { value: 'custom', label: '自定义字符集' },
        ] },
        { key: 'customChars', label: '自定义字符集（charset=custom）', kind: 'text', placeholder: 'ABCabc123' },
        { key: 'gender', label: '性别（姓名/身份证用）', kind: 'select', default: 'random', options: [
          { value: 'random', label: '随机' },
          { value: 'male', label: '男' },
          { value: 'female', label: '女' },
        ] },
        { key: 'minAge', label: '最小年龄（生日/身份证用）', kind: 'number', default: 18 },
        { key: 'maxAge', label: '最大年龄（生日/身份证用）', kind: 'number', default: 65 },
        { key: 'dateFrom', label: '起始日期（date 用，可选）', kind: 'text', placeholder: '2024-01-01' },
        { key: 'dateTo', label: '结束日期（date 用，可选）', kind: 'text', placeholder: '2026-12-31' },
        { key: 'dateFormat', label: '日期格式', kind: 'select', default: 'YYYY-MM-DD', options: [
          { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
          { value: 'YYYY-MM-DD HH:mm:ss', label: 'YYYY-MM-DD HH:mm:ss' },
          { value: 'timestamp', label: '时间戳(ms)' },
          { value: 'iso', label: 'ISO 字符串' },
        ] },
        { key: 'emailDomain', label: '邮箱域名', kind: 'text', placeholder: 'example.com' },
        { key: 'areaCode', label: '身份证地区码（可选）', kind: 'text', placeholder: '110105' },
        { key: 'cardBin', label: '银行卡 BIN 前缀（可选）', kind: 'text', placeholder: '622000' },
        { key: 'cardLength', label: '银行卡长度', kind: 'number', default: 19 },
        { key: 'seed', label: '随机种子（可选，填写后可复现）', kind: 'text', placeholder: 'case-001' },
        { key: 'unique', label: '批量生成时尽量去重', kind: 'boolean', default: false },
        { key: 'outputMode', label: '输出模式', kind: 'select', default: 'auto', options: [
          { value: 'auto', label: '自动（单个返回值，多个返回 items）' },
          { value: 'array', label: '总是输出 {items,count}' },
        ] },
        { key: 'fields', label: '字段模板（可选；每行 field|kind|参数JSON，或 JSON 对象/数组）', kind: 'textarea', placeholder: 'name|name\nmobile|phone\nidNo|idCard|{"minAge":18,"maxAge":60}\namount|float|{"min":1,"max":999,"decimals":2}' },
      ],
      outputHint: '单值；count>1 时 { items, count }；配置 fields 时生成对象或对象数组',
    },
    {
      type: 'handleDialog',
      label: '处理弹窗 (alert/confirm)',
      needsPage: true,
      description: '通过 CDP 处理当前已打开的原生弹窗（alert/confirm/prompt）；当前无弹窗时安装本次 Flow 生命周期内的自动应答策略，也可读取弹窗记录',
      params: [
        { key: 'action', label: '操作', kind: 'select', default: 'accept', options: [
          { value: 'accept', label: '自动确认（confirm=true，prompt 返回下方文本）' },
          { value: 'dismiss', label: '自动取消（confirm/prompt 返回 false/null）' },
          { value: 'read', label: '读取已拦截的弹窗记录' },
        ] },
        { key: 'promptText', label: 'prompt 应答文本（自动确认时使用，支持模板）', kind: 'text', placeholder: '' },
      ],
      outputHint: '{ handled?, armed?, dialogs?, kind:"handleDialog", status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'closePage',
      label: '关闭页面',
      needsPage: true,
      description: '关闭该页面对应的标签页（测试收尾清理）',
      params: [],
      outputHint: '{ closed, tabId, kind:"closeTab", status, performed, confirmed, actionReceipt, receipt, result }',
    },
    {
      type: 'waitDownload',
      label: '等待下载完成',
      needsPage: false,
      description: '等待浏览器出现匹配的下载任务并完成（验证导出/下载功能），从节点执行时刻开始匹配新下载',
      params: [
        { key: 'filenamePattern', label: '文件名匹配正则（留空=任意新下载）', kind: 'text', placeholder: '\\.xlsx$' },
        { key: 'timeoutMs', label: '超时(ms)', kind: 'number', default: 60000 },
      ],
      outputHint: '{ downloadId, fileName, filePath, fileSize, mime, state }',
    },
    {
      type: 'saveFile',
      label: '保存文件到下载目录',
      needsPage: false,
      description: '把上一节点输出、指定变量或自定义内容保存为下载目录下的文件。浏览器插件只能写入下载目录内的相对路径，不能静默写任意系统绝对路径',
      params: [
        { key: 'directory', label: '下载目录下的子目录（支持模板）', kind: 'text', default: 'PageAgent', placeholder: 'PageAgent/reports' },
        { key: 'fileName', label: '文件名（支持模板）', kind: 'text', required: true, default: 'data.json', placeholder: 'orders.json' },
        { key: 'sourceMode', label: '保存来源', kind: 'select', default: 'last', options: [
          { value: 'last', label: '上一节点输出' },
          { value: 'variable', label: '指定变量/路径' },
          { value: 'literal', label: '自定义内容' },
        ] },
        { key: 'sourcePath', label: '变量/路径（保存来源为指定变量时使用）', kind: 'text', default: 'last', placeholder: 'orders.rows 或 last' },
        { key: 'content', label: '自定义内容（保存来源为自定义内容时使用，支持模板）', kind: 'textarea', placeholder: '{{json last}}' },
        { key: 'format', label: '内容格式', kind: 'select', default: 'auto', options: [
          { value: 'auto', label: '自动（对象保存 JSON，字符串保存文本）' },
          { value: 'json', label: 'JSON（对象自动序列化）' },
          { value: 'text', label: '文本' },
          { value: 'base64', label: 'Base64 内容' },
          { value: 'dataUrl', label: 'Data URL（如截图 data:image/...）' },
        ] },
        { key: 'mimeType', label: 'MIME 类型（留空自动推断）', kind: 'text', placeholder: 'application/json / text/csv / image/jpeg' },
        { key: 'prettyJson', label: 'JSON 格式化缩进', kind: 'boolean', default: true },
        { key: 'addUtf8Bom', label: '文本前添加 UTF-8 BOM（Excel CSV 需要时勾选）', kind: 'boolean', default: false },
        { key: 'conflictAction', label: '同名文件处理', kind: 'select', default: 'uniquify', options: [
          { value: 'uniquify', label: '自动重命名（推荐）' },
          { value: 'overwrite', label: '覆盖已有文件' },
          { value: 'prompt', label: '询问用户' },
        ] },
        { key: 'saveAs', label: '弹出另存为对话框', kind: 'boolean', default: false },
        { key: 'waitComplete', label: '等待保存完成', kind: 'boolean', default: true },
        { key: 'timeoutMs', label: '等待超时(ms)', kind: 'number', default: 60000 },
      ],
      outputHint: '{ downloadId, fileName, filePath, relativePath, fileSize, mime, state }',
      implementation: {
        dispatcher: 'background/node-dispatcher.js',
        module: 'background/node-file-ops.js',
        handler: 'execSaveFile',
        sourceResolver: 'flows/template.js#resolvePath',
        outputContract: '{ downloadId, fileName, filePath, relativePath, fileSize, mime, state }',
      },
    },
    {
      type: 'requestModelAssert',
      label: '请求模型断言',
      needsPage: true,
      description: '用自然语言描述预期，模型根据页面截图/文本判定是否满足（需在「模型配置」配置模型）。适合无法用选择器表达的模糊验证',
      params: [
        { key: 'serviceId', label: '模型服务（可选）', kind: 'modelService', placeholder: '使用全局默认模型服务', description: '留空使用全局默认模型服务；显式指定的服务不存在或已删除时以 SERVICE_NOT_FOUND 失败，不回退默认服务。' },
        { key: 'assertion', label: '断言描述（自然语言；模板值按 data-only 输入）', kind: 'textarea', required: true, placeholder: '页面显示了订单列表，且没有报错提示' },
        { key: 'source', label: '判定依据', kind: 'select', default: 'screenshot', options: [
          { value: 'screenshot', label: '页面截图（需视觉模型）' },
          { value: 'text', label: '页面文本' },
          { value: 'both', label: '截图 + 文本' },
        ] },
        { key: 'selector', label: '限定区域选择器（可选，仅取该区域文本）', kind: 'text', placeholder: '' },
        { key: 'timeoutMs', label: '模型调用超时(ms)', kind: 'number', default: 60000, minimum: 1000, maximum: 600000 },
      ],
      outputHint: '{ passed: true, reason, verification }',
    },
    {
      type: 'requestModelExtract',
      label: '请求模型数据提取',
      needsPage: true,
      description: '用自然语言指令让模型从页面内容提取结构化 JSON 数据（需在「模型配置」配置模型）。适合无规律 DOM 的页面',
      params: [
        { key: 'serviceId', label: '模型服务（可选）', kind: 'modelService', placeholder: '使用全局默认模型服务', description: '留空使用全局默认模型服务；显式指定的服务不存在或已删除时以 SERVICE_NOT_FOUND 失败，不回退默认服务。' },
        { key: 'instruction', label: '提取指令（说明字段与结构；模板值按 data-only 输入）', kind: 'textarea', required: true, placeholder: '提取页面中所有商品，输出 JSON 数组，字段：name(名称)、price(数字价格)' },
        { key: 'source', label: '提取来源', kind: 'select', default: 'text', options: [
          { value: 'text', label: '页面文本' },
          { value: 'screenshot', label: '页面截图（需视觉模型）' },
          { value: 'both', label: '截图 + 文本' },
        ] },
        { key: 'selector', label: '限定区域选择器（可选，仅取该区域文本）', kind: 'text', placeholder: '.product-list' },
        { key: 'maxChars', label: '页面文本最大字符数', kind: 'number', default: 10000, minimum: 2 },
        { key: 'timeoutMs', label: '模型调用超时(ms)', kind: 'number', default: 60000, minimum: 1000, maximum: 600000 },
      ],
      outputHint: '模型提取的 JSON 对象或数组',
    },
    {
      type: 'requestModelAction',
      label: '请求模型自定义动作',
      needsPage: false,
      optionalPage: true,
      description: '单次自定义模型生成：自定义任务提示词（其中 {{变量}} 作为 data-only 输入），可选附带页面文本/截图，输出写入变量供下游使用；该节点本身不执行页面或资源副作用（需在「模型配置」配置模型）',
      params: [
        { key: 'tabId', label: '页面 tabId（附带页面内容时可选）', kind: 'text', placeholder: '{{tabId}}' },
        { key: 'serviceId', label: '模型服务（可选）', kind: 'modelService', placeholder: '使用全局默认模型服务', description: '留空使用全局默认模型服务；显式指定的服务不存在或已删除时以 SERVICE_NOT_FOUND 失败，不回退默认服务。' },
        { key: 'systemPrompt', label: '系统提示词（可选，仅静态角色与规则，不支持运行变量）', kind: 'textarea', placeholder: '你是数据清洗助手，把输入的表格数据规范化…' },
        { key: 'prompt', label: '用户提示词（模板值按 data-only 输入，{{json 变量}} 可注入完整数据）', kind: 'textarea', required: true, placeholder: '把以下订单数据按金额排序并汇总：\n{{json orders.rows}}' },
        { key: 'pageContext', label: '附带页面内容', kind: 'select', default: 'none', options: [
          { value: 'none', label: '不附带（纯文本任务）' },
          { value: 'text', label: '附带页面文本' },
          { value: 'screenshot', label: '附带页面截图（需视觉模型）' },
          { value: 'both', label: '附带文本 + 截图' },
        ] },
        { key: 'selector', label: '限定区域选择器（附带页面文本时可选）', kind: 'text', placeholder: '' },
        { key: 'maxChars', label: '页面文本最大字符数', kind: 'number', default: 10000, minimum: 2 },
        { key: 'outputFormat', label: '输出格式', kind: 'select', default: 'text', options: [
          { value: 'text', label: '原始文本' },
          { value: 'json', label: 'JSON 对象或数组（自动解析，解析失败则报错）' },
        ], description: '选择 json 时会解析模型回复；prompt 应明确给出期望的 JSON 对象或数组结构，无法解析时以 MODEL_OUTPUT_INVALID_JSON 失败。' },
        { key: 'temperature', label: '温度(0-2，0=最确定)', kind: 'number', default: 0, minimum: 0, maximum: 2 },
        { key: 'timeoutMs', label: '模型调用超时(ms)', kind: 'number', default: 60000, minimum: 1000, maximum: 600000 },
      ],
      outputHint: '模型回复（文本或解析后的 JSON 对象/数组），配合「输出变量名」给下游使用',
    },
    {
      type: 'runAssistant',
      label: '调用助手',
      needsPage: false,
      optionalPage: true,
      description: '在 Flow 中启动一个已有助手，等待其完成页面/浏览器/流程等 Agent 操作，并把最终回答与运行标识返回给下游。节点为非交互运行，助手不能中途询问用户；确定性任务优先使用普通节点。该节点可能产生外部副作用，不允许自动重试。',
      params: [
        { key: 'assistantId', label: '助手', kind: 'assistant', required: true },
        { key: 'prompt', label: '交给助手的任务（模板值按 data-only 输入）', kind: 'textarea', required: true, placeholder: '检查当前订单并处理异常；输入：\n{{json last}}' },
        { key: 'tabId', label: '默认目标 tabId（可选，支持模板）', kind: 'text', default: '{{tabId}}', placeholder: '{{tabId}}' },
        { key: 'serviceId', label: '模型服务（可选）', kind: 'modelService', placeholder: '使用助手绑定或全局默认模型服务', description: '留空时依次使用 Assistant 绑定的模型服务和全局默认服务；显式指定或 Assistant 绑定的服务不存在时以 SERVICE_NOT_FOUND 失败，不回退其他服务。' },
        { key: 'conversationId', label: '复用对话 ID（可选）', kind: 'text', placeholder: '留空则每次创建独立助手运行', description: '留空会创建独立且可审计的 Conversation；仅在需要延续同一 Assistant 历史时复用已有 ID，同一 conversationId 不要在并发运行间共享。' },
        { key: 'outputFormat', label: '结果格式', kind: 'select', default: 'text', options: [
          { value: 'text', label: '文本' },
          { value: 'json', label: 'JSON（自动解析）' },
        ], description: '选择 json 时会解析 Assistant 的最终回答并写入 result；prompt 应明确给出期望的 JSON 结构，无法解析时以 ASSISTANT_INVALID_JSON 失败。' },
        { key: 'maxIterations', label: '最大迭代次数（0=使用助手配置）', kind: 'number', default: 0, minimum: 0, maximum: 1000 },
        { key: 'maxToolCalls', label: '最大工具调用数（0=使用助手配置）', kind: 'number', default: 0, minimum: 0, maximum: 10000 },
        { key: 'timeoutMs', label: '等待助手完成超时(ms)', kind: 'number', default: 900000, minimum: 1000, maximum: 86400000 },
      ],
      outputHint: '{ assistantId, assistantName, serviceId, conversationId, generationId, state, reason, finalAnswer, result, counters, usage, startedAt, endedAt, durationMs }',
    },
    {
      type: 'jsonExtract',
      label: 'JSON 数据提取',
      needsPage: false,
      description: '从 JSON 对象中提取指定路径的字段',
      params: [
        { key: 'source', label: '数据源变量', kind: 'text', default: 'last', placeholder: 'last 或其他变量名' },
        { key: 'path', label: 'JSON 路径', kind: 'text', placeholder: 'data.cards[0].content' },
        { key: 'defaultValue', label: '默认值（提取失败时）', kind: 'text', placeholder: 'null' },
      ],
      outputHint: '提取的数据',
    },
  ];

  // Retry is fail-closed: only nodes whose execution is known to be free of
  // durable page/browser/file/model side effects are automatically replayed.
  var REPLAY_SAFE_TYPES = {
    waitForElement: true,
    waitForCondition: true,
    waitForPageLoad: true,
    getCurrentTab: true,
    delay: true,
    statusBreak: true,
    extractTable: true,
    extractList: true,
    getRequests: true,
    'cdp.inspect_dom_snapshot': true,
    'cdp.inspect_ax_tree': true,
    'cdp.inspect_network': true,
    'cdp.screenshot': true,
    getSseEvents: true,
    logData: true,
    turndownToMarkdown: true,
    waitDownload: true,
    loopStart: true,
    loopEnd: true,
    loopBreak: true,
    loopContinue: true,
    assertElement: true,
    assertText: true,
    assertValue: true,
    assertUrl: true,
    scrollInfo: true,
    getCookie: true,
    ifStart: true,
    elseBlock: true,
    ifEnd: true,
    extractText: true,
    elementInfo: true,
    inspectStructure: true,
    inspectText: true,
    inspectHtml: true,
    inspectCss: true,
    inspectJavascript: true,
    searchPage: true,
    assertAttribute: true,
    screenshot: true,
    dataMap: true,
    dataProject: true,
    dataCompose: true,
    dataFilter: true,
    dataJoin: true,
    dataDedupe: true,
    dataAggregate: true,
    checkpointGet: true,
    dataDiff: true,
    assertPerformance: true,
    exitGate: true,
    accessibilityCheck: true,
    routeAssert: true,
    setVariable: true,
    contextPrune: true,
    addAttribute: true,
    jsonExtract: true,
  };

  function replayOwnValue(value, key, fallback) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return fallback;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) {}
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : fallback;
  }

  function isNodeReplaySafe(node) {
    var type = String(replayOwnValue(node, 'type', '') || '');
    var params = replayOwnValue(node, 'params', null);
    if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};
    if (type === 'cdp.analyze_performance') {
      var reload = replayOwnValue(params, 'reload', false);
      var reloadIsKnownFalse = reload === false || reload === undefined || reload === null || reload === ''
        || /^(?:false|no|0|off|unchecked|unselected)$/i.test(String(reload));
      var performanceAction = String(replayOwnValue(params, 'action', 'none') || 'none').toLowerCase();
      return reloadIsKnownFalse && performanceAction === 'none';
    }
    if (REPLAY_SAFE_TYPES[type] === true) return true;
    if (type === 'webStorage') return String(replayOwnValue(params, 'action', 'get') || 'get') === 'get';
    if (type === 'handleDialog') return String(replayOwnValue(params, 'action', 'accept') || 'accept') === 'read';
    if (/^(?:exportTestReport|exportRunSummary)$/.test(type)) return replayOwnValue(params, 'saveFile', true) === false;
    // A load test is inherently non-replayable: repeating it changes the
    // measured latency/error distribution and imposes another request burst,
    // even when the selected HTTP method is GET/HEAD/OPTIONS.
    if (type === 'httpLoadTest') return false;
    if (type === 'forEachParallel') {
      var action = String(replayOwnValue(params, 'action', 'identity') || 'identity');
      if (action === 'identity' || action === 'template') return true;
      if (action !== 'httpRequest') return false;
    }
    if (!/^(?:httpRequest|forEachParallel)$/.test(type)) return false;
    var method = String(replayOwnValue(params, 'method', '') || '').toUpperCase();
    if (/^(?:httpRequest|httpLoadTest)$/.test(type)) method = method || 'GET';
    if (type === 'forEachParallel' && (!method || method === 'AUTO')) method = 'GET';
    return /^(?:GET|HEAD|OPTIONS)$/.test(method);
  }

  var PAGE_START_NODE_TYPES = {
    openPage: true,
  };

  var PARAM_LIMIT_RULES = [
    {
      types: ['pageAction', 'clickElement', 'fillInput', 'selectOption', 'fillFormFields', 'scrollPage', 'hoverElement', 'keyPress', 'uploadFile', 'dragDrop', 'replayRequest', 'cdp.replay_request'],
      key: 'timeoutMs', minimum: 100, maximum: 120000,
      description: '公共页面动作超时有效范围 100-120000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['executePageJavascript', 'callPageFunction', 'runtimeModuleAction', 'mockNetwork'],
      key: 'timeoutMs', minimum: 100, maximum: 120000,
      description: '页面 JavaScript 执行超时有效范围 100-120000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['waitForElement', 'waitForCondition'],
      key: 'timeoutMs', minimum: 100, maximum: 120000,
      description: '页面等待超时有效范围 100-120000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['waitForPageLoad'],
      key: 'timeoutMs', minimum: 100, maximum: 300000,
      description: '页面加载等待超时有效范围 100-300000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['assertElement', 'assertText', 'assertAttribute'],
      key: 'timeoutMs', minimum: 0, maximum: 120000,
      description: '断言等待有效范围 0-120000ms；0 表示只检查当前状态，运行时超界值按边界钳制。',
    },
    {
      types: ['extractText', 'extractTable', 'extractList', 'extractScrollingList', 'scrollInfo'],
      key: 'timeoutMs', minimum: 1000, maximum: 60000,
      description: '页面只读查询的单次执行超时有效范围 1000-60000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.inspect_dom_snapshot', 'cdp.inspect_ax_tree', 'cdp.screenshot'],
      key: 'timeoutMs', minimum: 500, maximum: 120000,
      description: '底层 CDP 命令超时有效范围 500-120000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.inspect_network', 'cdp.analyze_performance'],
      key: 'timeoutMs', minimum: 1000, maximum: 180000,
      description: 'CDP 诊断操作超时有效范围 1000-180000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['waitForCondition'], key: 'pollIntervalMs', minimum: 25, maximum: 2000,
      description: '轮询间隔有效范围 25-2000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['waitForPageLoad'], key: 'stableMs', minimum: 0, maximum: 5000,
      description: '加载完成事实的连续稳定窗口有效范围 0-5000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['selectOption', 'fillFormFields'], key: 'dropdownWaitMs', minimum: 100, maximum: 30000,
      description: '下拉选项等待有效范围 100-30000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['selectOption', 'fillFormFields'], key: 'searchDelayMs', minimum: 50,
      description: '运行时至少等待 50ms；更小值会被提升到 50ms。',
    },
    {
      types: ['statusBreak'], key: 'count', minimum: 1, maximum: 30,
      description: '状态位图长度有效范围 1-30；运行时超界值按边界钳制。',
    },
    {
      types: ['extractScrollingList'], key: 'maxIterations', minimum: 1, maximum: 200,
      description: '滚动轮数有效范围 1-200；运行时超界值按边界钳制。',
    },
    {
      types: ['extractScrollingList'], key: 'maxItems', minimum: 0, maximum: 10000,
      label: '最大采集条数（0=使用硬上限 10000）',
      description: '采集硬上限为 10000 条；0 会回落到 10000，并不表示无限。',
    },
    {
      types: ['extractScrollingList'], key: 'stopOnNoNewRounds', minimum: 1, maximum: 50,
      description: '连续无新增轮数有效范围 1-50；运行时超界值按边界钳制。',
    },
    {
      types: ['extractScrollingList'], key: 'settleMs', minimum: 20,
      description: '每轮滚动后的运行时等待至少 20ms；更小值会被提升到 20ms。',
    },
    {
      types: ['extractScrollingList', 'scrollInfo'], key: 'thresholdPx', minimum: 1,
      description: '滚动边界判定容差至少为 1px；更小值会被提升到 1px。',
    },
    {
      types: ['scrollInfo'], key: 'stableMs', minimum: 0, maximum: 5000,
      description: '到底事实的连续稳定窗口有效范围 0-5000ms；0 表示只读当前状态。',
    },
    {
      types: ['scrollPage'], key: 'maxScrollRounds', minimum: 1, maximum: 200,
      description: '滚动轮数有效范围 1-200；运行时超界值按边界钳制。',
    },
    {
      types: ['scrollPage'], key: 'topStableMs', minimum: 0, maximum: 10000,
      description: '到顶稳定窗口有效范围 0-10000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['dragDrop'], key: 'steps', minimum: 2, maximum: 60,
      description: '拖拽移动分步数有效范围 2-60；运行时超界值按边界钳制。',
    },
    {
      types: ['routeAssert'], key: 'timeoutMs', minimum: 100, maximum: 120000,
      description: '路由断言等待有效范围 100-120000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['accessibilityCheck'], key: 'timeoutMs', minimum: 500, maximum: 120000,
      description: '页面快照命令超时有效范围 500-120000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['getRequests', 'getSseEvents'], key: 'retentionMs', minimum: 0, maximum: 86400000,
      description: '0 使用默认 1 小时；非零值运行时限制在 300000-86400000ms（5 分钟到 24 小时）。',
    },
    {
      types: ['cdp.inspect_network'], key: 'listenMs', minimum: 1, maximum: 10000,
      description: '本次监听有效范围 1-10000ms；0 会回落到默认 1000ms，运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.analyze_performance'], key: 'sampleMs', minimum: 1000, maximum: 60000,
      description: '性能采样窗口有效范围 1000-60000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.analyze_performance'], key: 'afterActionDelayMs', minimum: 0, maximum: 10000,
      description: '动作后额外等待有效范围 0-10000ms；运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.analyze_performance'], key: 'longTaskThresholdMs', minimum: 16, maximum: 500,
      description: '长任务阈值有效范围 16-500ms；运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.analyze_performance'], key: 'networkLimit', minimum: 1, maximum: 200,
      description: '网络摘要最多保留 200 条；运行时超界值按边界钳制。',
    },
    {
      types: ['cdp.analyze_performance'], key: 'maxTraceEvents', minimum: 500, maximum: 20000,
      description: 'Trace 事件预算有效范围 500-20000；达到预算后结果会标记 truncated。',
    },
    {
      types: ['downloadMedia'], key: 'maxAssets', minimum: 1,
      description: '至少允许 1 个资源；达到此配置值后节点失败并要求提高 maxAssets 或缩小正文范围。',
    },
    {
      types: ['downloadMedia'], key: 'concurrency', minimum: 1, maximum: 10,
      description: '并发下载数有效范围 1-10；运行时超界值按边界钳制。',
    },
    {
      types: ['downloadMedia'], key: 'maxResidentAssetBytes', minimum: 1024,
      description: '单个驻留资源预算至少为 1024 字节；更小值会被提升到 1024。',
    },
    {
      types: ['downloadMedia'], key: 'maxResidentTotalBytes', minimum: 1024,
      description: '驻留资源总预算不会小于单资源预算；配置更小时运行时会提升到单资源预算。',
    },
    {
      types: ['forEachParallel'], key: 'concurrency', minimum: 1, maximum: 50,
      description: '并发数有效范围 1-50；运行时超界值按边界钳制。',
    },
    {
      types: ['httpRequest', 'webhook', 'forEachParallel'], key: 'timeoutMs', minimum: 0, maximum: 600000,
      description: '0 使用默认 30000ms；非零值运行时限制在 1-600000ms，并覆盖响应正文读取；父 Flow 停止会取消进行中的请求。',
    },
    {
      types: ['runScript'], key: 'timeoutMs', minimum: 1000, maximum: 86400000,
      description: '沙箱脚本超时有效范围 1000ms-24 小时；脚本失败后不会自动重放。',
    },
    {
      types: ['waitDownload', 'saveFile', 'downloadMedia', 'exportTestReport'], key: 'timeoutMs', minimum: 1000, maximum: 86400000,
      description: '下载或保存等待超时有效范围 1000ms-24 小时；父 Flow 停止会中止等待。',
    },
    {
      types: ['delay'], key: 'ms', minimum: 0, maximum: 86400000,
      description: '单次延时有效范围 0ms-24 小时。',
    },
    {
      types: ['loopStart'], key: 'maxIterations', minimum: 0,
      description: '0 表示不额外限制循环次数；非零值必须为正数。',
    },
    {
      types: ['setCookie'], key: 'expiresDays', minimum: 0,
      description: '0 创建会话 Cookie；正数表示从当前时间起的有效天数。',
    },
    {
      types: ['assertScreenshot'], key: 'mismatchThresholdPct', minimum: 0, maximum: 100,
      description: '视觉差异率阈值有效范围 0%-100%。',
    },
    {
      types: ['httpLoadTest', 'assertPerformance'], key: 'maxErrorRatePct', minimum: 0, maximum: 100,
      description: '错误率阈值有效范围 0%-100%；0 表示不检查。',
    },
    {
      types: ['httpLoadTest'], key: 'p95ThresholdMs', minimum: 0,
      description: 'P95 阈值不能为负；0 表示不检查。',
    },
    {
      types: ['httpLoadTest'], key: 'concurrency', minimum: 1, maximum: 100,
      description: '压测并发数有效范围 1-100；运行时超界值按边界钳制。',
    },
    {
      types: ['httpLoadTest'], key: 'requestTimeoutMs', minimum: 1000,
      description: '单请求超时至少为 1000ms；更小值会被提升到 1000ms。',
    },
    {
      types: ['httpLoadTest'], key: 'maxRequests', minimum: 0,
      description: '0 表示按 durationMs 运行；若 maxRequests 和 durationMs 同时为 0，运行时回落为最多 50 个请求，并非无限运行。',
    },
    {
      types: ['httpLoadTest'], key: 'durationMs', minimum: 0,
      description: '0 表示不按时长停止；若 durationMs 和 maxRequests 同时为 0，运行时回落为最多 50 个请求。',
    },
    {
      types: ['randomData'], key: 'decimals', minimum: 1, maximum: 10,
      description: 'float 小数位数有效范围 1-10；0 会回落到默认 2 位，运行时超界值按边界钳制。需要整数时使用 int 类型。',
    },
    {
      types: ['randomData'], key: 'length', minimum: 1,
      description: '通用长度至少为 1；password 类型运行时至少使用 8。',
    },
    {
      types: ['randomData'], key: 'count', minimum: 1, maximum: 10000,
      description: '单节点生成数量有效范围 1-10000；运行时超界值按边界钳制。',
    },
    {
      types: ['randomData'], key: 'cardLength', minimum: 12, maximum: 30,
      description: '银行卡长度有效范围 12-30；运行时超界值按边界钳制。',
    },
    {
      types: ['screenshot', 'cdp.screenshot'], key: 'quality', minimum: 1, maximum: 100,
      description: 'JPEG 质量有效范围 1-100；PNG 格式忽略该参数。',
    },
    {
      types: ['inspectStructure'], key: 'maxDepth', minimum: 1, maximum: 12,
      description: '结构遍历深度有效范围 1-12；0 会回落到默认 4 层，运行时超界值按边界钳制。',
    },
    {
      types: ['searchPage'], key: 'contextChars', minimum: 40,
      description: '每个命中的上下文片段至少保留 40 字符；更小值会被提升到 40。',
    },
    {
      types: ['logData'], key: 'maxLength', minimum: 0,
      description: '0 仅表示本节点不截断消息；不会取消日志条数和持久化报告的固定保留上限。',
    },
  ];

  var NODE_LIMIT_NOTES = {
    pageAction: '低层 input JSON 仍受可视化动作节点的同一运行时边界约束；新 Flow 应优先选用可直接读取参数范围的具体动作节点。',
    getCurrentTab: '输出投影会将 url、committedUrl、pendingUrl 各保留前 4000 字符，title 保留前 500 字符。',
    extractScrollingList: '单次最多采集 10000 条；maxItems=0 仍使用该硬上限，不代表无限。',
    getRequests: '网络捕获缓冲最多 300 条；单响应正文保留 65536 字符、单请求正文保留 16384 字符、正文总预算 6291456 字符，超限时按 FIFO 淘汰旧条目。',
    getSseEvents: '网络捕获缓冲最多 300 条；单响应正文保留 65536 字符、单请求正文保留 16384 字符、正文总预算 6291456 字符，超限时按 FIFO 淘汰旧条目。',
    replayRequest: '按 entryId 重放时只能使用网络捕获缓冲中仍保留的请求；捕获请求体最多 16384 字符，超过部分无法通过重放恢复。需要完整请求体时应直接填写 body。',
    logData: 'Flow 内存日志只保留最近 500 条；持久运行报告只保留最近 300 条，且每条消息最多 500 字符。',
    webhook: 'HTTP 响应 body 只保留前 65536 字符；json 若能从完整响应解析成功，仍返回完整解析对象。非只读方法会禁用整轮自动重试。',
    httpRequest: 'HTTP 响应 body 只保留前 65536 字符；json 若能从完整响应解析成功，仍返回完整解析对象。非只读方法会禁用整轮自动重试。',
    forEachParallel: 'HTTP/Webhook 子任务的响应 body 只保留前 65536 字符；json 若能从完整响应解析成功，仍返回完整解析对象。非只读方法会禁用整轮自动重试。',
    uploadFile: '文本或 base64 解码后的文件内容硬上限为 20MiB；临时文件服务单次请求最多等待 60000ms，整个页面动作仍受 timeoutMs 上限约束。',
    downloadMedia: '驻留资源读取子阶段的超时会限制在 30000-120000ms，HLS 清单网络读取最长 600000ms，浏览器下载完成等待仍使用节点 timeoutMs；并发下载硬上限为 10。该节点不会自动续读上游分页内容，只会发现实际传入 HTML/Markdown 中的资源。',
    inspectStructure: '结构投影最多输出 5000 个节点；每个元素最多继续遍历 500 个直接子元素，每节点文本摘要最多 300 字符。分页只能读取该有界投影，不能恢复未遍历节点。',
    inspectJavascript: '该节点只返回摘要：字符串全局值最多 500 字符、对象最多 50 个键、脚本列表最多 500 条。',
    searchPage: '搜索最多保留 5000 个命中；count 表示实际发现数，分页只能读取已保留的 matches，不能恢复第 5000 条之后的命中。',
    'cdp.inspect_dom_snapshot': 'computedStyles 最多采用前 50 个属性名；快照正文仍受 maxChars=10000 的公共分页契约约束。',
    'cdp.inspect_network': 'CDP 网络缓冲只保留最近 300 条请求，单请求事件历史最多 20 条；本次最多返回其中最近 200 条，分页只能读取这组有界结果。',
    'cdp.analyze_performance': '性能条目中的慢资源、Long Task、measure 各最多 30 条；Trace 的长任务和热点摘要各最多 20 条，网络慢项摘要最多 10 条。',
    'cdp.replay_request': '按 entryId 重放时只能使用 CDP 网络缓冲中仍保留的最近 300 条请求；捕获请求体最多 16384 字符，超过部分无法通过重放恢复。需要完整请求体时应直接填写 body。',
    exportTestReport: 'includeDebugTrace 只包含最近 50 条诊断快照；单值预算 16384 字符，字符串预览 2048 字符，数组 50 项、对象 80 键、深度 6。',
    attachArtifact: '运行上下文只保留最近 30 个产物，超限后按 FIFO 淘汰；报告不会包含已淘汰产物。',
    coverageMark: '运行上下文只保留最近 1000 个覆盖点，超限后按 FIFO 淘汰；报告不会包含已淘汰覆盖点。',
    routeAssert: '断言只能检查网络捕获缓冲中仍保留的最近 300 条记录；旧记录可能因条数、正文总预算或保留时间上限被 FIFO 淘汰。',
    assertScreenshot: '基线和当前截图固定使用 JPEG 质量 80；任一 RGB 通道差值不超过 24 的像素不计为差异，截图尺寸不一致时直接判定失败。',
    accessibilityCheck: '检查基于有界 PageState，而不是完整 DOM 扫描；单次快照最多包含 1200 个页面目标，页面目标被截断时其余节点不会进入本次规则检查。',
    httpLoadTest: 'maxRequests 与 durationMs 同时为 0 时回落为最多 50 个请求，并非无限压测。压测节点会改变服务负载和测量分布，始终禁用节点级与整轮自动重试。',
    randomData: 'unique=true 时每个重复值最多重新生成 50 次，取值空间不足时仍可能出现重复，因此只是尽量去重。字段模板中的同类参数也使用相同运行时边界。',
    handleDialog: '没有当前弹窗时，自动应答策略在本次 Flow 生命周期内有效；读取记录时最多返回最近 20 条。',
    waitDownload: '每轮轮询只检索浏览器最近 20 条下载记录，并接受节点启动前约 2 秒内开始的任务；并发下载很多时，目标任务可能被最近 20 条窗口挤出。',
    requestModelAssert: 'source=text/both 时页面文本固定只取首个最多 8000 字符窗口，节点不会自动续读；截图输入固定使用 JPEG 质量 60。需要基于完整正文断言时，应先分页聚合并改用可接收变量的节点。',
    requestModelExtract: '附带页面文本时只取首个 maxChars 窗口，节点不会自动续读或暴露 nextStart；截图输入固定使用 JPEG 质量 60。需要完整正文时，应先分页聚合再把变量交给模型。',
    requestModelAction: 'pageContext=text/both 时只取首个 maxChars 窗口，节点不会自动续读或暴露 nextStart；截图输入固定使用 JPEG 质量 60。需要完整正文时，应先分页聚合并通过 prompt 模板变量传入。',
    runAssistant: '助手预算会把模型请求总数限制为 Math.min(maxIterations * 2, 1000)；即使 maxIterations 配到 1000，模型请求硬上限仍为 1000。',
  };

  function appendMetadataDescription(target, description) {
    if (!target || !description) return;
    var current = String(target.description || '');
    if (current.indexOf(description) !== -1) return;
    target.description = current ? current + ' ' + description : description;
  }

  function applyParamLimitMetadata(typeDef, param) {
    PARAM_LIMIT_RULES.forEach(function (rule) {
      if (!rule || rule.key !== param.key || rule.types.indexOf(typeDef.type) === -1) return;
      if (rule.minimum !== undefined) param.minimum = rule.minimum;
      if (rule.maximum !== undefined) param.maximum = rule.maximum;
      if (rule.label) param.label = rule.label;
      appendMetadataDescription(param, rule.description);
    });
  }

  function ensureRuntimeTabParam(typeDef) {
    typeDef.params = typeDef.params || [];
    for (var i = 0; i < typeDef.params.length; i++) {
      if (typeDef.params[i] && typeDef.params[i].key === 'tabId') return;
    }
    typeDef.params.unshift({
      key: 'tabId',
      label: '运行 tabId（未选目标页面时填写）',
      kind: 'text',
      required: false,
      placeholder: '{{tabId}} 或数字 tabId',
      description: '仅在未选择目标页面时使用；选了 pageId 时始终以页面配置为准',
    });
  }

  TYPES.forEach(function (typeDef) {
    (typeDef.params || []).forEach(function (param) {
      if (!param) return;
      if (param.required === true && param.default !== undefined) param.required = false;
      applyParamLimitMetadata(typeDef, param);
      if (param.key === 'maxChars') {
        param.minimum = 2;
        param.maximum = PAGE_DATA_MAX_CHARS;
        if (String(param.label || '').indexOf('上限 10000') === -1) {
          param.label = String(param.label || '最大字符数') + '（上限 10000）';
        }
        appendMetadataDescription(param, /^(?:requestModelExtract|requestModelAction)$/.test(typeDef.type)
          ? MODEL_PAGE_CONTEXT_DESCRIPTION
          : PAGE_DATA_WINDOW_DESCRIPTION);
      }
      if (param.key === 'start' && (typeDef.params || []).some(function (candidate) { return candidate && candidate.key === 'maxChars'; })) {
        param.minimum = 0;
        appendMetadataDescription(param, '必须是非负整数字符边界位置，不是数组下标、对象属性序号或本页返回项数量；首次读取使用 0。hasMore=true 且 nextStart 不为 null 时，下一次读取必须把上一页 nextStart 原样填入 start，这才是下一页；不能再次使用 0。重复读取仅在真实观察到页面或数据发生变化时才被允许。实时只读数据变化使 start 落入当前项内部时，服务会保守回退；超过当前数据时返回已读完，不作为请求错误。响应 start 是实际采用的位置，后续仍只使用响应 nextStart。');
      }
    });
    appendMetadataDescription(typeDef, NODE_LIMIT_NOTES[typeDef.type]);
    if (!typeDef || !typeDef.needsPage || PAGE_START_NODE_TYPES[typeDef.type]) return;
    typeDef.needsPage = false;
    typeDef.optionalPage = true;
    typeDef.needsTab = true;
    typeDef.description = (typeDef.description || '') + '；选择目标页面时由 pageId 认领或打开标签页，未选页面时才使用 tabId';
    ensureRuntimeTabParam(typeDef);
  });

  var typeMap = {};
  for (var i = 0; i < TYPES.length; i++) typeMap[TYPES[i].type] = TYPES[i];

  // 节点分类（配置页选择抽屉分组展示）
  var CATEGORIES = [
    { id: 'nav', label: '🌐 页面导航', types: ['openPage', 'refreshPage', 'navigate', 'waitForPageLoad', 'activateTab', 'getCurrentTab', 'closePage'] },
    { id: 'interact', label: '🖱 页面交互', types: ['clickElement', 'fillInput', 'selectOption', 'fillFormFields', 'hoverElement', 'keyPress', 'scrollPage', 'dragDrop', 'uploadFile', 'handleDialog', 'pageAction'] },
    { id: 'wait-assert', label: '✅ 等待与断言', types: ['waitForCondition', 'waitForElement', 'delay', 'assertElement', 'assertText', 'assertValue', 'assertUrl', 'assertAttribute', 'assertScreenshot', 'assertPerformance', 'routeAssert', 'waitDownload'] },
    { id: 'data', label: '📊 数据提取', types: ['extractText', 'extractTable', 'extractList', 'extractScrollingList', 'elementInfo', 'inspectStructure', 'inspectText', 'inspectHtml', 'inspectCss', 'inspectJavascript', 'searchPage', 'cdp.inspect_dom_snapshot', 'cdp.inspect_ax_tree', 'cdp.inspect_network', 'cdp.analyze_performance', 'getRequests', 'replayRequest', 'cdp.replay_request', 'getSseEvents', 'clearNetworkCapture', 'jsonExtract', 'scrollInfo'] },
    { id: 'transform', label: '🧩 数据转换', types: ['turndownToMarkdown', 'downloadMedia', 'dataMap', 'dataCompose', 'dataProject', 'dataFilter', 'dataJoin', 'dataDedupe', 'dataAggregate', 'dataDiff', 'checkpointGet', 'checkpointSet', 'forEachParallel'] },
    { id: 'vars', label: '🧮 变量与数据', types: ['setVariable', 'contextPrune', 'addAttribute', 'randomData', 'coverageMark'] },
    { id: 'model-dialog', label: '🤖 模型对话', types: ['runAssistant', 'requestModelAssert', 'requestModelExtract', 'requestModelAction'] },
    { id: 'control', label: '🔀 流程控制', types: ['ifStart', 'elseBlock', 'ifEnd', 'loopStart', 'loopEnd', 'loopBreak', 'loopContinue', 'statusBreak'] },
    { id: 'session', label: '🔑 会话与存储', types: ['webStorage', 'setCookie', 'getCookie', 'clearCookies', 'setProxy', 'clearProxy'] },
    { id: 'flow-report', label: '📋 流程报告', types: ['exportTestReport', 'attachArtifact', 'exportRunSummary', 'exitGate'] },
    { id: 'debug', label: '🧪 诊断与注入', types: ['accessibilityCheck', 'mockNetwork'] },
    { id: 'misc', label: '📤 输出与集成', types: ['logData', 'saveFile', 'screenshot', 'cdp.screenshot', 'executePageJavascript', 'patchPage', 'callPageFunction', 'runtimeModuleAction', 'runScript', 'webhook', 'httpRequest', 'httpLoadTest'] },
  ];

  function getType(type) {
    return typeMap[type] || null;
  }

  function getTypeLabel(type) {
    var t = typeMap[type];
    return t ? t.label : type;
  }

  // 数字取值解析：支持纯数字、"min~max" 随机范围（每次调用重新随机）
  var RANGE_RE = /^\s*(-?\d+(?:\.\d+)?)\s*~\s*(-?\d+(?:\.\d+)?)\s*$/;

  function resolveNumberValue(v, fallback) {
    if (typeof v === 'number') return isFinite(v) ? v : (Number(fallback) || 0);
    var m = RANGE_RE.exec(String(v));
    if (m) {
      var min = Number(m[1]);
      var max = Number(m[2]);
      if (min > max) { var t = min; min = max; max = t; }
      if (Number.isInteger(min) && Number.isInteger(max)) {
        return min + Math.floor(Math.random() * (max - min + 1));
      }
      return min + Math.random() * (max - min);
    }
    return Number(v) || Number(fallback) || 0;
  }

  function resolveBooleanValue(v, fallback) {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null || v === '') return fallback === true;
    if (/^(?:true|yes|1|on|checked|selected)$/i.test(String(v))) return true;
    if (/^(?:false|no|0|off|unchecked|unselected)$/i.test(String(v))) return false;
    throw new TypeError('布尔参数只支持 true/false、yes/no、1/0 或 on/off');
  }

  // 将参数规范化：填充默认值、数值/布尔类型转换
  function normalizeParams(type, rawParams) {
    var def = typeMap[type];
    var result = {};
    if (!def) return Object.assign({}, rawParams || {});
    rawParams = rawParams || {};
    for (var i = 0; i < def.params.length; i++) {
      var p = def.params[i];
      var v = rawParams[p.key];
      if (v === undefined || v === null || v === '') {
        if (p.default !== undefined) v = p.default;
        else if (p.kind === 'boolean') v = false;
        else v = '';
      }
      if (p.kind === 'number') {
        var numericText = String(v).trim();
        if (!numericText) numericText = '0';
        var numericRange = RANGE_RE.exec(numericText);
        var numericValues = numericRange
          ? [Number(numericRange[1]), Number(numericRange[2])]
          : [Number(numericText)];
        if (numericValues.some(function (value) { return !isFinite(value); })) {
          throw new TypeError('参数「' + p.label + '」必须是数字或有效随机范围');
        }
        if (p.minimum !== undefined && numericValues.some(function (value) { return value < Number(p.minimum); })) {
          throw new RangeError('参数「' + p.label + '」不能小于 ' + p.minimum);
        }
        if (p.maximum !== undefined && numericValues.some(function (value) { return value > Number(p.maximum); })) {
          throw new RangeError('参数「' + p.label + '」不能大于 ' + p.maximum);
        }
        v = resolveNumberValue(v);
      }
      if (p.kind === 'boolean') v = resolveBooleanValue(v, p.default === true);
      if (p.kind === 'select') {
        var allowedValues = (Array.isArray(p.options) ? p.options : []).map(function (option) {
          return String(option && option.value);
        });
        if (v !== '' && allowedValues.indexOf(String(v)) === -1) {
          throw new TypeError('参数「' + p.label + '」不支持值: ' + v);
        }
      }
      result[p.key] = v;
    }
    if (type === 'exportTestReport') {
      var legacyReportPrefixRe = new RegExp('^test' + '-report-');
      if (!result.fileName || legacyReportPrefixRe.test(String(result.fileName))) {
        var format = result.format || 'json';
        var ext = format === 'html' ? 'html' : (format === 'junit' ? 'xml' : 'json');
        result.fileName = 'flow-report-' + Date.now() + '.' + ext;
      }
    }
    return result;
  }

  // 节点通用字段（存储在节点实例顶层）：失败策略与节点级重试
  function normalizeCommonFields(node) {
    node = node || {};
    return {
      onFailure: node.onFailure === 'continue' ? 'continue' : 'abort',
      retries: isNodeReplaySafe(node) ? Math.max(0, Number(node.retries) || 0) : 0,
      retryDelayMs: Math.max(0, resolveNumberValue(node.retryDelayMs, 1000)),
      requiresForeground: node.requiresForeground === true,
      foreground: node.foreground === true,
      reveal: node.reveal === true,
    };
  }

  function hasLocatorParams(params, prefix) {
    prefix = String(prefix || '');
    var keys = prefix
      ? [prefix + 'Selector', prefix + 'TextSelector', prefix + 'TextPattern', prefix + 'LocatorLabel']
      : ['selector', 'textSelector', 'textPattern', 'locatorLabel'];
    return keys.some(function (key) { return String(params && params[key] || '').trim() !== ''; });
  }

  function validateObjectParam(errors, node, def, params, key) {
    var value = params[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') {
      if (/^\s*\{\{[^}]+\}\}\s*$/.test(value)) return null;
      try { value = JSON.parse(value); }
      catch (_) {
        errors.push('[' + (node.title || def.label) + '] ' + key + ' 必须是有效 JSON 对象');
        return null;
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push('[' + (node.title || def.label) + '] ' + key + ' 必须是对象');
      return null;
    }
    return value;
  }

  function validateTurndownRules(errors, node, params) {
    var rules = params.customRules;
    if (rules === undefined || rules === null || rules === ''
        || (typeof rules === 'string' && /^\s*\{\{[^}]+\}\}\s*$/.test(rules))) return;
    if (typeof rules === 'string') {
      try { rules = JSON.parse(rules); }
      catch (_) {
        errors.push('[' + (node.title || 'Turndown HTML 转 Markdown') + '] customRules 必须是有效 JSON 数组');
        return;
      }
    }
    if (!Array.isArray(rules)) {
      errors.push('[' + (node.title || 'Turndown HTML 转 Markdown') + '] customRules 必须是数组');
      return;
    }
    if (rules.length > 50) {
      errors.push('[' + (node.title || 'Turndown HTML 转 Markdown') + '] customRules 最多 50 条');
    }
    var actions = { replace: true, remove: true, keep: true, fencedCode: true };
    var contentModes = { markdown: true, text: true, html: true, outerHTML: true, attribute: true };
    rules.forEach(function (rule, index) {
      var prefix = '[' + (node.title || 'Turndown HTML 转 Markdown') + '] customRules[' + index + ']';
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push(prefix + ' 必须是对象');
        return;
      }
      if (!String(rule.selector || '').trim()) errors.push(prefix + '.selector 不能为空');
      if (!actions[String(rule.action || 'replace')]) errors.push(prefix + '.action 不受支持');
      if (rule.contentSelector !== undefined && typeof rule.contentSelector !== 'string') {
        errors.push(prefix + '.contentSelector 必须是字符串');
      }
      if (rule.contentMode !== undefined && !contentModes[String(rule.contentMode)]) {
        errors.push(prefix + '.contentMode 不受支持');
      }
      if (rule.contentMode === 'attribute' && !String(rule.attribute || '').trim()) {
        errors.push(prefix + '.attribute 不能为空');
      }
      if (rule.replacement !== undefined && typeof rule.replacement !== 'string') {
        errors.push(prefix + '.replacement 必须是字符串');
      }
      if (rule.fenceCharacter !== undefined && ['`', '~'].indexOf(rule.fenceCharacter) === -1) {
        errors.push(prefix + '.fenceCharacter 仅支持 ` 或 ~');
      }
    });
  }

  function validateLiteralHttpUrl(errors, node, def, value, label) {
    var text = String(value || '').trim();
    if (!text || text.indexOf('{{') !== -1) return;
    try {
      var parsed = new URL(text);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    } catch (_) {
      errors.push('[' + (node.title || def.label) + '] ' + (label || 'URL') + ' 必须是有效的 http/https URL');
    }
  }

  // Page request replay also accepts relative URLs, which are resolved by the
  // target document. Reject an explicitly supplied non-web scheme while
  // leaving relative paths and protocol-relative URLs valid.
  function validateLiteralReplayUrl(errors, node, def, value, label) {
    var text = String(value || '').trim();
    if (!text || text.indexOf('{{') !== -1 || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return;
    try {
      var parsed = new URL(text);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    } catch (_) {
      errors.push('[' + (node.title || def.label) + '] ' + (label || 'URL') + ' 仅支持 http/https 或相对 URL');
    }
  }

  // 校验节点实例，返回错误消息数组
  function validateNodeInstance(node) {
    var errors = [];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push('节点必须是对象');
      return errors;
    }
    var def = typeMap[node.type];
    if (!def) {
      errors.push('未知节点类型: ' + node.type);
      return errors;
    }
    if (def.needsPage && !node.pageId) {
      errors.push('[' + (node.title || def.label) + '] 必须选择目标页面');
    }
    var params = node.params;
    if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
      errors.push('[' + (node.title || def.label) + '] params 必须是对象');
      return errors;
    }
    params = params || {};
    if (def.needsTab && !node.pageId && !String(params.tabId || '').trim()) {
      errors.push('[' + (node.title || def.label) + '] 必须选择目标页面或传入 params.tabId');
    }
    for (var i = 0; i < def.params.length; i++) {
      var p = def.params[i];
      if (p.required && (params[p.key] === undefined || params[p.key] === null || params[p.key] === '')) {
        if (p.default === undefined) {
          errors.push('[' + (node.title || def.label) + '] 缺少必填参数: ' + p.label);
        }
      }
      if (p.kind === 'number') {
        var nv = params[p.key];
        if (typeof nv === 'string' && nv.trim() !== '' && nv.indexOf('{{') === -1
            && !/^\s*-?\d+(?:\.\d+)?\s*(?:~\s*-?\d+(?:\.\d+)?\s*)?$/.test(nv)) {
          errors.push('[' + (node.title || def.label) + '] 参数「' + p.label + '」格式无效：应为数字、{{变量}} 或 最小~最大 随机范围');
        } else if (nv !== undefined && nv !== null && nv !== ''
            && !(typeof nv === 'string' && nv.indexOf('{{') !== -1)) {
          var range = RANGE_RE.exec(String(nv));
          var values = range ? [Number(range[1]), Number(range[2])] : [Number(nv)];
          if (p.minimum !== undefined && values.some(function (value) { return value < Number(p.minimum); })) {
            errors.push('[' + (node.title || def.label) + '] 参数「' + p.label + '」不能小于 ' + p.minimum);
          }
          if (p.maximum !== undefined && values.some(function (value) { return value > Number(p.maximum); })) {
            errors.push('[' + (node.title || def.label) + '] 参数「' + p.label + '」不能大于 ' + p.maximum);
          }
        }
      }
      if (p.kind === 'select') {
        var selectedValue = params[p.key];
        if (selectedValue !== undefined && selectedValue !== null && selectedValue !== ''
            && !(typeof selectedValue === 'string' && selectedValue.indexOf('{{') !== -1)) {
          var allowedValues = (Array.isArray(p.options) ? p.options : []).map(function (option) {
            return String(option && option.value);
          });
          if (allowedValues.indexOf(String(selectedValue)) === -1) {
            errors.push('[' + (node.title || def.label) + '] 参数「' + p.label + '」不支持值: ' + selectedValue);
          }
        }
      }
      if (p.kind === 'boolean') {
        var booleanValue = params[p.key];
        var dynamicBoolean = typeof booleanValue === 'string' && booleanValue.indexOf('{{') !== -1;
        var literalBoolean = typeof booleanValue === 'boolean'
          || /^(?:true|false|yes|no|1|0|on|off|checked|unchecked|selected|unselected)$/i.test(String(booleanValue));
        if (booleanValue !== undefined && booleanValue !== null && booleanValue !== ''
            && !dynamicBoolean && !literalBoolean) {
          errors.push('[' + (node.title || def.label) + '] 参数「' + p.label + '」必须是布尔值');
        }
      }
    }
    var outputVar = node.outputVar;
    if (outputVar !== undefined && outputVar !== null && outputVar !== '') {
      if (typeof outputVar !== 'string' || outputVar !== outputVar.trim()
          || /^(?:__proto__|prototype|constructor)$/.test(outputVar)) {
        errors.push('[' + (node.title || def.label) + '] 输出变量名必须是不带首尾空白的非原型保留字符串');
      }
    }
    if (!isNodeReplaySafe(node) && Math.max(0, Number(node.retries) || 0) > 0) {
      errors.push('[' + (node.title || def.label) + '] 该节点不能证明可安全重放，不能配置自动重试');
    }
    if (node.type === 'runScript' && !String(params.scriptId || '').trim() && !String(params.inlineCode || '').trim()) {
      errors.push('[' + (node.title || def.label) + '] 必须选择已保存脚本或填写内联代码');
    }
    if (node.type === 'forEachParallel' && /^(?:httpRequest|webhook)$/.test(String(params.action || 'identity'))
        && !String(params.url || '').trim()) {
      errors.push('[' + (node.title || def.label) + '] HTTP/Webhook 并发处理必须提供 URL');
    }
    if (/^(?:httpRequest|webhook|httpLoadTest|setCookie|getCookie|clearCookies)$/.test(node.type)) {
      validateLiteralHttpUrl(errors, node, def, params.url, '请求 URL');
    }
    if (node.type === 'forEachParallel' && /^(?:httpRequest|webhook)$/.test(String(params.action || 'identity'))) {
      validateLiteralHttpUrl(errors, node, def, params.url, '请求 URL');
    }
    if (node.type === 'downloadMedia' && String(params.baseUrl || '').trim()) {
      validateLiteralHttpUrl(errors, node, def, params.baseUrl, '页面基准 URL');
    }
    if (node.type === 'setVariable'
        && /^(?:__proto__|prototype|constructor)$/.test(String(params.name || '').trim())) {
      errors.push('[' + (node.title || def.label) + '] 变量名不能使用原型保留字段');
    }
    if (node.type === 'addAttribute'
        && /^(?:__proto__|prototype|constructor)$/.test(String(params.key || '').trim())) {
      errors.push('[' + (node.title || def.label) + '] 属性键不能使用原型保留字段');
    }
    if (node.type === 'statusBreak'
        && /^(?:__proto__|prototype|constructor)$/.test(String(params.stateKey || '').trim())) {
      errors.push('[' + (node.title || def.label) + '] 状态键不能使用原型保留字段');
    }
    if (node.type === 'waitDownload' && String(params.filenamePattern || '').trim()
        && String(params.filenamePattern).indexOf('{{') === -1) {
      try { new RegExp(String(params.filenamePattern)); }
      catch (_) { errors.push('[' + (node.title || def.label) + '] 文件名匹配正则无效'); }
    }
    if (node.type === 'requestModelAction' && String(params.pageContext || 'none') !== 'none'
        && !node.pageId && !String(params.tabId || '').trim()) {
      errors.push('[' + (node.title || def.label) + '] 附带页面内容时必须选择目标页面或传入 params.tabId');
    }
    if (node.type === 'turndownToMarkdown') validateTurndownRules(errors, node, params);
    if (node.type === 'requestModelAction' && /\{\{[^{}]+\}\}/.test(String(params.systemPrompt || ''))) {
      errors.push('[' + (node.title || def.label) + '] systemPrompt 不能注入运行变量；请把动态数据放入用户提示词');
    }
    if (/^(?:clickElement|fillInput|selectOption)$/.test(node.type)) {
      if (!hasLocatorParams(params, '')) {
        errors.push('[' + (node.title || def.label) + '] 至少填写一种目标定位方式');
      }
      validateObjectParam(errors, node, def, params, 'expect');
    }
    if (node.type === 'selectOption') {
      var hasOptionValue = params.value !== undefined && params.value !== null && String(params.value).trim() !== '';
      var hasOptionText = params.optionText !== undefined && params.optionText !== null && String(params.optionText).trim() !== '';
      var hasOptionIndex = params.optionIndex !== undefined && params.optionIndex !== null && String(params.optionIndex).trim() !== '';
      if (!hasOptionValue && !hasOptionText && !hasOptionIndex) {
        errors.push('[' + (node.title || def.label) + '] 必须填写 option value、选项文本或选项索引之一');
      }
    }
    if (node.type === 'waitForCondition') {
      var waitType = String(params.conditionType || '');
      if (WAIT_CONDITION_TYPES.indexOf(waitType) === -1) {
        errors.push('[' + (node.title || def.label) + '] 不支持的等待条件: ' + waitType);
      }
      if (/^text_(?:present|absent)$/.test(waitType) && !String(params.text || '').trim()) {
        errors.push('[' + (node.title || def.label) + '] 文本条件必须填写等待文本');
      }
      if (waitType === 'url_matches' && !String(params.pattern || '').trim()) {
        errors.push('[' + (node.title || def.label) + '] URL 匹配条件必须填写模式');
      }
      if (waitType === 'target_state' && !hasLocatorParams(params, '')) {
        errors.push('[' + (node.title || def.label) + '] 目标状态条件必须填写定位方式');
      }
    }
    if (node.type === 'scrollPage') {
      validateObjectParam(errors, node, def, params, 'expect');
      if (/^(?:toElement|untilElement)$/.test(String(params.mode || 'byAmount')) && !hasLocatorParams(params, '')) {
        errors.push('[' + (node.title || def.label) + '] 滚动到元素时必须填写目标定位方式');
      }
      if (String(params.mode || 'byAmount') === 'byAmount'
          && String(params.distanceUnit || 'pixels') === 'pages'
          && params.pages !== undefined && params.pages !== null && String(params.pages).trim() !== ''
          && !(typeof params.pages === 'string' && params.pages.indexOf('{{') !== -1)
          && Number(params.pages) === 0) {
        errors.push('[' + (node.title || def.label) + '] 按视口页数滚动时页数不能为 0');
      }
    }
    if (node.type === 'patchPage') {
      var patchAction = String(params.action || 'hide');
      if (/^(?:style|attribute|removeAttribute)$/.test(patchAction)
          && !String(params.name || '').trim()) {
        errors.push('[' + (node.title || def.label) + '] 页面补丁动作 ' + patchAction + ' 必须提供 name');
      }
      if (/^(?:style|attribute)$/.test(patchAction)
          && (params.value === undefined || params.value === null || String(params.value).trim() === '')) {
        errors.push('[' + (node.title || def.label) + '] 页面补丁动作 ' + patchAction + ' 必须提供 value');
      }
    }
    if (node.type === 'webStorage') {
      var storageAction = String(params.action || 'get').toLowerCase();
      var dynamicStorageAction = storageAction.indexOf('{{') !== -1;
      if (!dynamicStorageAction && !/^(?:get|set|remove|clear)$/.test(storageAction)) {
        errors.push('[' + (node.title || def.label) + '] 不支持的页面存储动作: ' + storageAction);
      }
      if (!dynamicStorageAction && /^(?:set|remove)$/.test(storageAction) && !String(params.key || '').trim()
          && !(typeof params.key === 'string' && params.key.indexOf('{{') !== -1)) {
        errors.push('[' + (node.title || def.label) + '] 页面存储动作 ' + storageAction + ' 必须提供 key');
      }
      if (!dynamicStorageAction && storageAction === 'set' && (params.value === undefined || params.value === null)) {
        errors.push('[' + (node.title || def.label) + '] 页面存储动作 set 必须提供 value');
      }
    }
    if (/^(?:replayRequest|cdp\.replay_request)$/.test(node.type)) {
      var replayEntryId = params.entryId;
      var replayUrl = params.url;
      var replayHasEntry = replayEntryId !== undefined && replayEntryId !== null && String(replayEntryId).trim() !== '';
      var replayHasUrl = replayUrl !== undefined && replayUrl !== null && String(replayUrl).trim() !== '';
      var replayDynamic = function (value) { return typeof value === 'string' && value.indexOf('{{') !== -1; };
      if (!replayHasEntry && !replayHasUrl && !replayDynamic(replayEntryId) && !replayDynamic(replayUrl)) {
        errors.push('[' + (node.title || def.label) + '] 必须提供 entryId 或 url');
      }
      validateLiteralReplayUrl(errors, node, def, replayUrl, '请求 URL');
    }
    if (/^(?:fillFormFields|hoverElement|keyPress|uploadFile|dragDrop)$/.test(node.type)) {
      validateObjectParam(errors, node, def, params, 'expect');
    }
    if (node.type === 'pageAction') {
      var pageActionKind = String(params.kind || 'click');
      if (EDITABLE_PAGE_ACTION_KINDS.indexOf(pageActionKind) === -1) {
        errors.push('[' + (node.title || def.label) + '] 不支持的 pageAction.kind: ' + pageActionKind);
      }
      function pageActionObject(value, key, allowEmpty) {
        if (value === undefined || value === null || value === '') return allowEmpty ? null : {};
        if (typeof value === 'string') {
          if (/^\s*\{\{[^}]+\}\}\s*$/.test(value)) return null;
          try { value = JSON.parse(value); }
          catch (_) {
            errors.push('[' + (node.title || def.label) + '] ' + key + ' 必须是有效 JSON 对象');
            return null;
          }
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push('[' + (node.title || def.label) + '] ' + key + ' 必须是对象');
          return null;
        }
        return value;
      }
      var dynamicPageActionLocator = typeof params.locator === 'string'
        && /^\s*\{\{[^}]+\}\}\s*$/.test(params.locator);
      var pageActionLocator = pageActionObject(params.locator, 'locator', true);
      var pageActionInput = pageActionObject(params.input, 'input', false);
      pageActionObject(params.expect, 'expect', true);
      if (/^(?:click|doubleClick|contextClick|fill|select)$/.test(pageActionKind)
          && !dynamicPageActionLocator
          && (!pageActionLocator || !Object.keys(pageActionLocator).length)) {
        errors.push('[' + (node.title || def.label) + '] ' + pageActionKind + ' 必须提供 locator');
      }
      if (pageActionKind === 'fill' && pageActionInput
          && !Object.prototype.hasOwnProperty.call(pageActionInput, 'value')) {
        errors.push('[' + (node.title || def.label) + '] fill 必须提供 input.value');
      }
      if (pageActionKind === 'select' && pageActionInput) {
        var pageActionSelection = /^(?:first|last|random)$/.test(String(pageActionInput.dropdownMode || ''))
          || pageActionInput.optionIndex !== undefined && pageActionInput.optionIndex !== null && String(pageActionInput.optionIndex).trim() !== ''
          || pageActionInput.index !== undefined && pageActionInput.index !== null && String(pageActionInput.index).trim() !== ''
          || pageActionInput.optionText !== undefined && pageActionInput.optionText !== null && String(pageActionInput.optionText).trim() !== ''
          || pageActionInput.label !== undefined && pageActionInput.label !== null && String(pageActionInput.label).trim() !== ''
          || pageActionInput.value !== undefined && pageActionInput.value !== null && String(pageActionInput.value).trim() !== '';
        if (!pageActionSelection) errors.push('[' + (node.title || def.label) + '] select 必须提供选择值、索引或 first/last/random 策略');
      }
    }
    if (node.type === 'fillFormFields') {
      var fields = params.fields;
      var values = params.values;
      var dynamicFields = typeof fields === 'string' && /^\s*\{\{[^}]+\}\}\s*$/.test(fields);
      var dynamicValues = typeof values === 'string' && /^\s*\{\{[^}]+\}\}\s*$/.test(values);
      if (typeof fields === 'string' && fields.trim() && !dynamicFields) {
        try { fields = JSON.parse(fields); }
        catch (_) { errors.push('[' + (node.title || def.label) + '] fields 必须是有效 JSON 数组'); }
      }
      if (fields !== undefined && fields !== null && fields !== '' && !dynamicFields && !Array.isArray(fields)) {
        errors.push('[' + (node.title || def.label) + '] fields 必须是数组');
      }
      if (Array.isArray(fields)) {
        fields.forEach(function (field, index) {
          if (!field || typeof field !== 'object' || Array.isArray(field)) {
            errors.push('[' + (node.title || def.label) + '] fields[' + index + '] 必须是对象');
          }
        });
      }
      if (typeof values === 'string' && values.trim() && !dynamicValues) {
        try { values = JSON.parse(values); }
        catch (_) { errors.push('[' + (node.title || def.label) + '] values 必须是有效 JSON 对象'); }
      }
      if (values !== undefined && values !== null && values !== '' && !dynamicValues
          && (!values || typeof values !== 'object' || Array.isArray(values))) {
        errors.push('[' + (node.title || def.label) + '] values 必须是对象');
      }
      var hasFields = dynamicFields || (Array.isArray(fields) && fields.length > 0);
      var hasValues = dynamicValues || (values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length > 0);
      if (!hasFields && !hasValues) {
        errors.push('[' + (node.title || def.label) + '] fillFormFields 至少需要一个 fields 字段或 values 值');
      }
    }
    if (node.type === 'setProxy') {
      var proxyServer = params.proxyServer;
      if (typeof proxyServer === 'string' && proxyServer.indexOf('{{') === -1 && /\s/.test(proxyServer.trim())) {
        errors.push('[' + (node.title || def.label) + '] 代理服务器不能包含空白字符');
      }
      var hostPattern = params.urlPattern;
      if (typeof hostPattern === 'string' && hostPattern.trim() && hostPattern.indexOf('{{') === -1) {
        if (hostPattern.indexOf('://') !== -1 || /[\/?#]/.test(hostPattern)) {
          errors.push('[' + (node.title || def.label) + '] Host 匹配模式只支持主机名通配符，不支持完整 URL 或路径');
        }
      }
    }
    if (node.type === 'elementInfo') {
      var locator = params.locator;
      var hasLocator = false;
      if (typeof locator === 'string') {
        var locatorText = locator.trim();
        if (/^[\[{]/.test(locatorText)) {
          try {
            var parsedLocator = JSON.parse(locatorText);
            hasLocator = !!(parsedLocator && (parsedLocator.selector || parsedLocator.ref));
          } catch (_) {
            hasLocator = locatorText !== '';
          }
        } else {
          hasLocator = locatorText !== '';
        }
      } else if (locator && typeof locator === 'object') {
        hasLocator = !!(locator.selector || locator.ref);
      }
      if (!params.selector && !params.ref && !hasLocator) {
        errors.push('[' + (node.title || def.label) + '] selector/ref/locator 至少填写一个');
      }
    }
    return errors;
  }

  return {
    TYPES: TYPES,
    CATEGORIES: CATEGORIES,
    getType: getType,
    getTypeLabel: getTypeLabel,
    resolveNumberValue: resolveNumberValue,
    normalizeParams: normalizeParams,
    normalizeCommonFields: normalizeCommonFields,
    isNodeReplaySafe: isNodeReplaySafe,
    validateNodeInstance: validateNodeInstance,
    projectPageActionNode: projectPageActionNode,
    projectPageWaitNode: projectPageWaitNode,
    projectPageJavascriptNode: projectPageJavascriptNode,
  };
});
