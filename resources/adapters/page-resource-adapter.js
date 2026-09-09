// ARP/1 adapter over the unified PagePerception/PageAction/PageVerification engines.
(function attachPageResourceAdapter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var pageDataContract = commonJs ? require('../../shared/page-data-contract.js') : root.PageDataContract;
  var pageActionContract = commonJs ? require('../../shared/page-action-contract.js') : root.PageActionContract;
  var pageVerificationContract = commonJs ? require('../../shared/page-verification-contract.js') : root.PageVerificationContract;
  var api = factory(core, pageDataContract, pageActionContract, pageVerificationContract);
  if (commonJs) module.exports = api;
  else if (root) root.PageResourceAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, pageDataContract, pageActionContract, pageVerificationContract) {
  'use strict';
  if (!core) throw new Error('PageResourceAdapter requires AgentResourceProtocol');
  if (!pageDataContract) throw new Error('PageResourceAdapter requires PageDataContract');
  if (!pageActionContract || !Array.isArray(pageActionContract.EDITABLE_FLOW_KINDS)) {
    throw new Error('PageResourceAdapter requires PageActionContract.EDITABLE_FLOW_KINDS');
  }
  if (!pageVerificationContract || !Array.isArray(pageVerificationContract.WAIT_CONDITION_TYPES)) {
    throw new Error('PageResourceAdapter requires PageVerificationContract.WAIT_CONDITION_TYPES');
  }

  var EDITABLE_PAGE_ACTION_KINDS = pageActionContract.EDITABLE_FLOW_KINDS.slice();
  var WAIT_CONDITION_TYPES = pageVerificationContract.WAIT_CONDITION_TYPES.slice();
  var ACTION_TIMEOUT_MIN_MS = Number(pageActionContract.TIMEOUT_MIN_MS) || 100;
  var ACTION_TIMEOUT_MAX_MS = Number(pageActionContract.TIMEOUT_MAX_MS) || 120000;
  var WAIT_TIMEOUT_MIN_MS = Number(pageVerificationContract.WAIT_TIMEOUT_MIN_MS) || 100;
  var WAIT_TIMEOUT_MAX_MS = Number(pageVerificationContract.WAIT_TIMEOUT_MAX_MS) || 120000;
  var WAIT_POLL_INTERVAL_MIN_MS = Number(pageVerificationContract.WAIT_POLL_INTERVAL_MIN_MS) || 25;
  var WAIT_POLL_INTERVAL_MAX_MS = Number(pageVerificationContract.WAIT_POLL_INTERVAL_MAX_MS) || 2000;

  function receiptState(status) {
    status = String(status || '');
    return status === 'confirmed' ? 'succeeded' : (status === 'unconfirmed' ? 'unconfirmed' : 'failed');
  }

  function actionEnvelopeReceipt(receipt, fallback, operationUri) {
    receipt = receipt && typeof receipt === 'object' ? receipt : {};
    fallback = fallback || {};
    var status = String(receipt.status || fallback.status || 'unconfirmed');
    return Object.assign({}, receipt, {
      performed: receipt.performed || fallback.performed || 'unknown',
      state: receiptState(status),
      verificationStatus: status,
      conditionMet: Object.prototype.hasOwnProperty.call(receipt, 'conditionMet') ? receipt.conditionMet === true : fallback.conditionMet === true,
      operationUri: operationUri,
    });
  }

  function pageWindowOutputProperties() {
    return pageDataContract.outputProperties();
  }

  function elementWindowInputProperties() {
    return pageDataContract.inputProperties(
      'Inclusive character start in the selected element representation. Start with 0. When hasMore is true and nextStart is not null, the next read must use that nextStart as start; using 0 again repeats the first page. Re-reading is allowed only after an observed page or data change.'
    );
  }

  var LOCATOR_SCHEMA = {
    type: 'object',
    properties: {
      selector: { type: 'string', minLength: 1, maxLength: 1000 },
      textSelector: { type: 'string', minLength: 1, maxLength: 500, description: '目标元素包含的文本，与 selector 组合使用时用于过滤匹配元素；不是 CSS 选择器。' },
      textPattern: { type: 'string', minLength: 1, maxLength: 500 },
      label: { type: 'string', minLength: 1, maxLength: 500 },
      scopeSelector: { type: 'string', minLength: 1, maxLength: 1000 },
      relative: { type: 'string', enum: ['parent', 'prevSibling', 'nextSibling'] },
    },
    minProperties: 1,
    additionalProperties: false,
  };

  function elementLocatorFromQuery(query) {
    query = query || {};
    var locator = {};
    if (query.locator !== undefined) locator.selector = query.locator;
    ['textSelector', 'textPattern', 'label', 'scopeSelector', 'relative'].forEach(function (field) {
      if (query[field] !== undefined) locator[field] = query[field];
    });
    return locator;
  }

  var EXPECTATION_SCHEMA = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: WAIT_CONDITION_TYPES.slice() },
      locator: LOCATOR_SCHEMA,
      fromUrl: { type: 'string', maxLength: 4000 },
      pattern: { type: 'string', maxLength: 1000 },
      text: { type: 'string', minLength: 1, maxLength: 10000 },
      state: { type: 'string', enum: ['loading', 'interactive', 'complete'] },
      value: { type: 'string', maxLength: 10000 },
      checked: { type: 'boolean' },
      selected: { type: 'boolean' },
      expanded: { type: 'boolean' },
      visible: { type: 'boolean' },
      enabled: { type: 'boolean' },
      editable: { type: 'boolean' },
      connected: { type: 'boolean' },
      timeoutMs: { type: 'integer', minimum: WAIT_TIMEOUT_MIN_MS, maximum: WAIT_TIMEOUT_MAX_MS },
      pollIntervalMs: { type: 'integer', minimum: WAIT_POLL_INTERVAL_MIN_MS, maximum: WAIT_POLL_INTERVAL_MAX_MS },
    },
    required: ['type'],
    additionalProperties: false,
  };

  var VISUAL_EVIDENCE_SCHEMA = { type: 'string', enum: ['auto', 'always', 'never'] };
  var PAGE_STATE_SCHEMA = {
    type: 'object',
    properties: Object.assign({
      contract: { type: 'string' },
      capturedAt: { type: 'string' },
      phase: { type: 'string', enum: ['initial', 'paged'] },
      page: { type: 'object' },
      application: { type: 'object' },
      layout: { type: 'object' },
      coverage: { type: 'object' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            locator: LOCATOR_SCHEMA,
            kind: { type: 'string', enum: ['control', 'message', 'heading', 'element', 'text'] },
            tag: { type: 'string' },
            role: { type: 'string' },
            name: { type: 'string' },
            text: { type: 'string' },
            value: true,
            attributes: { type: 'object' },
            state: { type: 'object' },
            bounds: { type: 'object' },
            inViewport: { type: 'boolean' },
            dataTruncated: { type: 'boolean' },
          },
          required: ['locator', 'kind', 'tag', 'role', 'name', 'text', 'state', 'bounds', 'inViewport'],
          additionalProperties: false,
        },
      },
      elementCount: { type: 'integer' },
      discoveredElementCount: { type: 'integer' },
      discoveryComplete: { type: 'boolean' },
    }, pageWindowOutputProperties()),
    required: ['contract', 'capturedAt', 'phase', 'page', 'layout', 'elements',
      'start', 'maxChars', 'returnedChars', 'remainingChars', 'hasMore', 'nextStart', 'truncated'],
    additionalProperties: false,
  };

  var ELEMENT_SCHEMA = {
    type: 'object',
    properties: Object.assign({
      locator: LOCATOR_SCHEMA,
      kind: { type: 'string', enum: ['control', 'message', 'heading', 'element', 'text'] },
      tag: { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string' },
      text: { type: 'string' },
      value: true,
      attributes: { type: 'object' },
      representation: { type: 'string', enum: ['text', 'outerHTML'] },
      content: { type: 'string' },
      outerHTML: { type: 'string' },
      state: { type: 'object' },
      bounds: { type: 'object' },
      inViewport: { type: 'boolean' },
      dataTruncated: { type: 'boolean' },
      truncated: { type: 'boolean' },
    }, pageWindowOutputProperties()),
    required: ['locator', 'tag', 'name', 'bounds', 'representation', 'start', 'maxChars', 'returnedChars', 'remainingChars', 'hasMore', 'nextStart', 'truncated'],
    additionalProperties: false,
  };

  var MEDIA_DESCRIPTOR_SCHEMA = {
    type: 'object',
    properties: {
      index: { type: 'integer', minimum: 0 },
      generation: { type: 'number' },
      kind: { type: 'string', enum: ['img', 'css-background', 'canvas', 'svg', 'video', 'iframe'] },
      name: { type: 'string' },
      alt: { type: 'string' },
      currentSrc: { type: 'string' },
      mimeHint: { type: 'string' },
      naturalWidth: { type: 'number', minimum: 0 },
      naturalHeight: { type: 'number', minimum: 0 },
      bounds: { type: 'object' },
      visible: { type: 'boolean' },
      sourceReadable: { type: 'boolean' },
      renderedReadable: { type: 'boolean' },
    },
    required: ['index', 'generation', 'kind', 'name', 'bounds', 'visible'],
    additionalProperties: true,
  };

  var MEDIA_COLLECTION_SCHEMA = {
    type: 'object',
    properties: Object.assign({
      observedAt: { type: 'string' },
      generation: { type: 'number' },
      media: { type: 'array', items: MEDIA_DESCRIPTOR_SCHEMA },
      mediaCount: { type: 'integer', minimum: 0 },
      discoveredMediaCount: { type: 'integer', minimum: 0 },
      discoveryComplete: { type: 'boolean' },
    }, pageWindowOutputProperties()),
    required: ['observedAt', 'generation', 'media', 'mediaCount',
      'start', 'maxChars', 'returnedChars', 'remainingChars', 'hasMore', 'nextStart', 'truncated'],
    additionalProperties: true,
  };

  var IMAGE_ARTIFACT_SCHEMA = {
    type: 'object',
    properties: {
      artifactUri: { type: 'string' },
      mimeType: { type: 'string' },
      byteLength: { type: 'number', minimum: 0 },
      width: { type: 'number', minimum: 0 },
      height: { type: 'number', minimum: 0 },
      representation: { type: 'string', enum: ['original', 'rendered'] },
      sourceKind: { type: 'string' },
      acquisitionSource: { type: 'string' },
      sha256: { type: 'string' },
      modelContent: { type: 'array' },
      artifacts: { type: 'array' },
    },
    required: ['artifactUri', 'mimeType', 'byteLength', 'representation', 'modelContent'],
    additionalProperties: true,
  };

  var INTERACTION_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', enum: ['click', 'fill', 'select', 'scroll', 'wait'] },
      status: { type: 'string', enum: ['confirmed', 'unconfirmed', 'failed'] },
      performed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
      conditionMet: { type: 'boolean' },
      locator: LOCATOR_SCHEMA,
      result: true,
      verification: { type: 'object' },
      receipt: { type: 'object' },
      actionFacts: { type: 'object' },
      startedAt: { type: 'string' },
      completedAt: { type: 'string' },
      durationMs: { type: 'number', minimum: 0 },
      targetTabId: { type: 'integer', minimum: 0 },
      targetDisposition: { type: 'string', enum: ['new_tab', 'same_tab', 'same_tab_navigation', 'none'] },
      targetUrl: { type: 'string' },
      targetActive: { type: ['boolean', 'null'] },
      newNavigationTarget: {
        type: ['object', 'null'],
        properties: {
          kind: { type: 'string', enum: ['new_tab'] },
          disposition: { type: 'string', enum: ['new_tab'] },
          sourceTabId: { type: 'integer', minimum: 1 },
          tabId: { type: 'integer', minimum: 0 },
          windowId: { type: 'integer', minimum: 0 },
          url: { type: 'string' },
          active: { type: ['boolean', 'null'] },
          status: { type: 'string' },
          openedTabIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          targets: { type: 'array', items: { type: 'object' } },
          ambiguous: { type: 'boolean' },
        },
        required: ['kind', 'sourceTabId', 'tabId', 'openedTabIds', 'ambiguous'],
        additionalProperties: true,
      },
      visualEvidence: { type: 'object' },
      modelContent: { type: 'array' },
      actionSpec: {
        type: 'object',
        description: '与 PageActionContract 一致的可重放动作描述；flowNode 是其可在配置页编辑的 Flow 投影。',
        properties: {
          kind: { type: 'string', enum: EDITABLE_PAGE_ACTION_KINDS.slice() },
          locator: { type: 'object' }, input: { type: 'object' }, expect: { type: ['object', 'null'] },
          timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
        },
        required: ['kind', 'locator', 'input', 'expect', 'timeoutMs'], additionalProperties: false,
      },
      flowNode: {
        type: 'object',
        description: '可复制到 Flow.nodes 的可视化节点片段；优先为 clickElement、fillInput、selectOption、scrollPage 或 waitForCondition。没有 pageId 时会尽量携带当前 params.tabId 供立即重放；创建可复用 Flow 前仍应复用或创建 PageSource 并绑定 pageId。',
      },
      verificationRequired: { type: 'boolean' },
      verificationHint: { type: 'string' },
    },
    required: ['id', 'kind', 'status', 'performed', 'verification'],
    additionalProperties: true,
  };

  var PAGE_INTERACTION_GUIDANCE = Object.freeze([
    '以 ActionReceipt 为准：status 只能是 confirmed、unconfirmed 或 failed，performed 只能是 yes、no 或 unknown。传输命令返回不等于业务成功，dom_changed 也只是弱证据；status=unconfirmed 或 performed=unknown 时，不得声称成功。',
    '可重放且未失败、未处于 unknown 状态的页面操作会返回 flowNode。status=unconfirmed 时 flowNode 是待验证候选，带 confirmationMode=deferred，必须紧跟同一页面的 waitForCondition 节点，两个节点的 onFailure 都必须为 abort；可通过 POST /page/waits 取得该可视化等待节点。不要把候选节点单独保存成成功流程，也不要猜测节点类型或用 fillFormFields 模拟单个 select。',
    '显式 expect 或 wait 如果按文本验证业务结果，应通过 locator 限定到真实结果容器，并使用动作前不成立的持久条件；不要用输入框或下拉框中本来就存在的同名文本证明动作成功。',
    '操作 checkbox、radio 或 switch 前先依据当前 PageState 的 checked/selected 判断目标状态；状态已经满足时不要重复点击。',
    'flowNode 没有 pageId 时会尽量携带执行动作时的 params.tabId，可直接用于当前标签仍存在时的一次性重放。创建可复用 Flow 应先从 /pages 复用匹配的 PageSource；没有匹配项再按当前页面 URL 创建 PageSource，把返回的 id 写入节点 pageId，并删除临时 tabId。普通页面节点会自行认领或打开 PageSource，不要因为页面绑定再额外添加 openPage。',
    '沉淀 Flow 只保留完成用户业务意图的最小动作链，不复制能力内省、只读诊断、失败尝试或重复开关动作。下拉选择应优先使用一次 /page/selections 对应的 selectOption 节点，不要固化“先点开、再点选项”的组件内部步骤。',
  ]);

  var JAVASCRIPT_EXECUTION_SCHEMA = {
    type: 'object',
    properties: Object.assign({
      id: { type: 'string' },
      world: { type: 'string', enum: ['MAIN', 'ISOLATED'] },
      mode: { type: 'string', enum: ['read', 'write'] },
      performed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
      value: true,
      valueType: { type: 'string' },
      flowNode: { type: 'object', description: '可复制到 Flow.nodes 的 executePageJavascript 节点片段；没有 pageId 时会尽量携带当前 params.tabId，长期复用前应在配置页改绑目标页面。' },
    }, pageWindowOutputProperties()),
    required: ['id', 'world', 'mode', 'performed',
      'start', 'maxChars', 'returnedChars', 'remainingChars', 'hasMore', 'nextStart', 'truncated'],
    additionalProperties: true,
  };

  function method(input) {
    var merged = Object.assign({
      outputSchema: true,
      safety: 'safe',
      idempotency: 'inherent',
      execution: 'sync',
      permissions: [],
      preconditions: [],
    }, input || {});
    // 所有 /page 方法都接受显式 tabId 指定目标标签页（GET 走 query，POST 走
    // body）：入口只提供默认绑定，不限制可操作的页面。
    var schema = merged.inputSchema;
    if (schema && typeof schema === 'object' && !Array.isArray(schema)
        && schema.type === 'object' && schema.properties && !schema.properties.tabId) {
      merged.inputSchema = Object.assign({}, schema, {
        properties: Object.assign({}, schema.properties, {
          tabId: { type: 'integer', minimum: 1, description: '目标标签页 ID；默认使用入口绑定的标签页。' },
        }),
      });
    }
    return merged;
  }

  function resolveEntryActionContracts() {
    return [
      {
        method: 'POST', relation: 'click-element',
        routeTemplate: '/page/clicks',
        href: '/page/clicks',
        requiredPreconditions: [],
      },
      {
        method: 'POST', relation: 'fill-element',
        routeTemplate: '/page/fills',
        href: '/page/fills',
        requiredPreconditions: [],
      },
      {
        method: 'POST', relation: 'select-option',
        routeTemplate: '/page/selections',
        href: '/page/selections',
        requiredPreconditions: [],
      },
      {
        method: 'POST', relation: 'scroll-page',
        routeTemplate: '/page/scrolls',
        href: '/page/scrolls',
        requiredPreconditions: [],
      },
      {
        method: 'POST', relation: 'drag-element',
        routeTemplate: '/page/drags',
        href: '/page/drags',
        requiredPreconditions: [],
      },
      {
        method: 'POST', relation: 'wait-for-page',
        routeTemplate: '/page/waits',
        href: '/page/waits',
        requiredPreconditions: [],
      },
    ];
  }

  function pageCurrentAffordances() {
    return [
      { rel: 'read-page-element', href: '/page/element', method: 'GET' },
    ].concat(resolveEntryActionContracts().map(function (contract) {
      return { rel: contract.relation, href: contract.href, method: contract.method };
    }), [
      { rel: 'page-media', href: '/page/media', method: 'GET' },
      { rel: 'capture-page-viewport', href: '/page/screenshots', method: 'POST' },
    ]);
  }

  function routeContracts() {
    return [
      new core.RouteContract({
        template: '/page/current',
        resourceType: 'PageState',
        relation: 'current-page-state',
        summary: '读取当前实时页面中已呈现元素和文本的有界 PageState；数据续读与页面滚动是两件事',
        tags: ['page', 'observe', 'current'],
        entryWeights: { page: 100 },
        affordances: pageCurrentAffordances(),
        methods: {
          GET: method({
            inputSchema: pageDataContract.inputSchema('PageState 候选项的包含边界字符起始位置，不是元素下标或本页返回元素数量。首次使用 0；后续必须使用上一页返回的 nextStart。实时元素变化导致旧位置落入当前项内部或超过当前数据时，服务会回退到不大于请求位置的最近当前项边界并继续读取，不把这种只读数据漂移作为请求错误。', {
              timeoutMs: {
                type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS,
                description: '页面观测整体超时毫秒，默认 10000。',
              },
            }),
            outputSchema: PAGE_STATE_SCHEMA,
            safety: 'read',
            permissions: ['page.read'],
            relation: 'observe-page',
            guidance: pageDataContract.windowGuidance('PageState').concat([
              '首次读取使用 GET /page/current?start=0&maxChars=10000。hasMore=true 且 nextStart 不为 null 时，下一次必须把 nextStart 原样作为 start：GET /page/current?start=<nextStart>&maxChars=10000，这才是下一页；再次使用 start=0 只会重复读取第一页。重复读取仅在真实观察到页面发生变化时才被允许。',
              'hasMore 只表示本次实时 PageState 仍有候选项没有返回，不表示任务必须穷尽它们，也不表示需要滚动。只有当前结果仍缺少任务直接相关的证据时才继续读取；不要为了耗尽 hasMore、寻找推测存在的页尾、分页或页脚而滚动。',
              '页面实时变化使请求 start 不再精确命中当前项边界时，服务会确定性地回退到不大于请求位置的最近边界，最多重复相邻数据而不跳过数据；响应 start 是实际采用的位置，后续仍只使用响应 nextStart。',
              'PageState 是当前视口中已呈现元素和可见文本的有界外部投影。页面操作或元素读取只能使用最近一次 PageState 实际返回的规范 locator。locator.selector 可能是最短可解析后缀，不是可编辑的完整 DOM 路径；必须原样复制，不能添加 body、删减层级、拼接父子路径或根据页面常识猜测 locator、textSelector、label。内部元素标识不属于协议。',
            ]),
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/screenshots',
        resourceType: 'ImageArtifact',
        relation: 'capture-page-viewport',
        summary: '截取当前可见页面视口，生成供视觉模型使用的 Artifact',
        aliases: ['take page screenshot', 'view current page visually', 'capture viewport'],
        tags: ['page', 'screenshot', 'vision', 'artifact'],
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                detail: { type: 'string', enum: ['auto', 'high', 'original'] },
                format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
                quality: { type: 'integer', minimum: 10, maximum: 100 },
                alt: { type: 'string', maxLength: 2000, description: '截图 Artifact 的替代描述文本。' },
                timeoutMs: {
                  type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS,
                  description: '截图整体超时毫秒，默认 30000。',
                },
                clip: {
                  type: 'object',
                  description: '按当前页面视口的 CSS 像素裁剪，并以统一 scale 等比输出。',
                  properties: {
                    x: { type: 'number', minimum: 0 },
                    y: { type: 'number', minimum: 0 },
                    width: { type: 'number', exclusiveMinimum: 0 },
                    height: { type: 'number', exclusiveMinimum: 0 },
                    scale: { type: 'number', minimum: 0.1, maximum: 4 },
                  },
                  required: ['x', 'y', 'width', 'height'],
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
            outputSchema: IMAGE_ARTIFACT_SCHEMA,
            safety: 'read', idempotency: 'keyed', permissions: ['page.read'],
            relation: 'capture-page-viewport',
            guidance: [
              'clip 使用当前页面视口的 CSS 像素坐标；scale 同时作用于宽和高，不会改变宽高比。',
              '例如从 1756x765 视口截取 1360x765，并设置 scale=1.411764705882353，可得到 1920x1080。',
            ],
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/media',
        resourceType: 'PageMediaCollection',
        relation: 'page-media',
        summary: '枚举当前页面中的可见图片和已渲染媒体',
        aliases: ['list page images', 'find page pictures', 'inspect visible media'],
        tags: ['page', 'image', 'media', 'vision'],
        methods: {
          GET: method({
            inputSchema: pageDataContract.inputSchema(
              '媒体项的包含边界字符起始位置，不是媒体下标或本页返回项数量。首次使用 0；hasMore=true 且 nextStart 不为 null 时，下一次必须把返回的 nextStart 原样作为 start，不能再次使用 0。重复读取仅在真实观察到页面或数据发生变化时才被允许。',
              {
                visibleOnly: { type: 'boolean' },
                timeoutMs: {
                  type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS,
                  description: '媒体观测整体超时毫秒，默认 30000。',
                },
              }
            ),
            outputSchema: MEDIA_COLLECTION_SCHEMA,
            safety: 'read', permissions: ['page.read'], relation: 'enumerate-page-media',
            guidance: pageDataContract.windowGuidance('页面媒体').concat([
              '媒体列表来自当前实时页面。实时布局或媒体集合变化使请求 start 不再精确命中当前项边界时，服务会回退到不大于请求位置的最近边界继续读取，最多重复相邻媒体而不跳过数据；响应 start 是实际采用的位置。',
            ]),
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/media/{index}',
        resourceType: 'PageMedia',
        relation: 'page-media-item',
        summary: '从当前页面媒体观测中读取一项图片描述',
        tags: ['page', 'image', 'media'],
        methods: {
          GET: method({
            inputSchema: {
              type: 'object',
              properties: { generation: { type: 'number' } },
              required: ['generation'],
              additionalProperties: false,
            },
            outputSchema: MEDIA_DESCRIPTOR_SCHEMA,
            safety: 'read', permissions: ['page.read'],
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/media/{index}/artifacts',
        resourceType: 'ImageArtifact',
        relation: 'capture-page-media',
        summary: '获取原始图片字节或元素渲染截图，作为视觉模型输入',
        aliases: ['view page image', 'read image visually', 'capture image element'],
        tags: ['page', 'image', 'vision', 'artifact'],
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                representation: { type: 'string', enum: ['auto', 'original', 'rendered', 'both'] },
                detail: { type: 'string', enum: ['auto', 'high', 'original'] },
                format: { type: 'string', enum: ['auto', 'png', 'jpeg', 'webp'] },
                quality: { type: 'integer', minimum: 10, maximum: 100 },
                generation: { type: 'number' },
              },
              required: ['generation'],
              additionalProperties: false,
            },
            outputSchema: IMAGE_ARTIFACT_SCHEMA,
            safety: 'read', idempotency: 'keyed', permissions: ['page.read'],
            relation: 'capture-page-media',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/element',
        resourceType: 'PageElement',
        relation: 'page-element',
        summary: '解析一个规范 locator，并以可续读方式读取完整元素文本或 outerHTML',
        aliases: ['read page content', 'extract element text', 'inspect element html'],
        tags: ['page', 'element', 'content', 'text'],
        methods: {
          GET: method({
            inputSchema: {
              type: 'object',
              properties: Object.assign({
                locator: {
                  type: 'string', minLength: 1, maxLength: 1000,
                  description: '规范 locator 的 selector。直接作为扁平 query 参数传递，不得传 JSON 对象。',
                },
                textSelector: { type: 'string', minLength: 1, maxLength: 500, description: '目标元素包含的文本；不是 CSS 选择器。' },
                textPattern: { type: 'string', minLength: 1, maxLength: 500 },
                label: { type: 'string', minLength: 1, maxLength: 500 },
                scopeSelector: { type: 'string', minLength: 1, maxLength: 1000 },
                relative: { type: 'string', enum: ['parent', 'prevSibling', 'nextSibling'] },
                representation: {
                  type: 'string', enum: ['text', 'outerHTML'],
                  description: '需要浏览器计算后的完整元素文本时使用 text；只有需要 DOM 结构时才使用 outerHTML。默认为 outerHTML。',
                },
              }, elementWindowInputProperties()),
              required: ['start', 'maxChars'],
              anyOf: [
                { required: ['locator'] },
                { required: ['textSelector'] },
                { required: ['textPattern'] },
                { required: ['label'] },
                { required: ['scopeSelector'] },
              ],
              additionalProperties: false,
            },
            outputSchema: ELEMENT_SCHEMA, safety: 'read', permissions: ['page.read'],
            guidance: pageDataContract.windowGuidance('页面元素表示').concat([
              'GET 使用标准扁平 query，例如 GET /page/element?locator=main+article&start=0&maxChars=4000。locator 对应规范 locator.selector；不得把 locator 作为 JSON 对象传入 URL。',
              'locator、textSelector、textPattern、label 和 scopeSelector 只能原样使用最近一次实时 PageState 已返回的值。locator.selector 是不可编辑的选择器，不保证从 body 开始；禁止添加 body、删除片段、组合父子路径或猜测 footer、main、next 等未返回目标。目标未在当前 PageState 中出现时，应报告读取缺口或基于已观察事实决定是否重新观测，不能试探未知元素。',
              '需要浏览器计算后的完整元素文本时使用 representation=text；只有需要 DOM 结构时才使用 representation=outerHTML。读取已解析目标的直接父元素时，保持原定位值完全不变并使用 relative=parent，不得自行改写定位值来构造父元素。',
              '续读每个窗口时保持 locator、其他定位参数和 representation 不变。',
            ]),
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/clicks',
        resourceType: 'ClickInteraction',
        relation: 'click-element',
        summary: '在实时页面中解析规范 locator，并点击解析得到的元素',
        aliases: ['click button', 'press link', 'activate element'],
        tags: ['page', 'click', 'interaction'],
        guidance: PAGE_INTERACTION_GUIDANCE,
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                locator: LOCATOR_SCHEMA,
                clickType: {
                  type: 'string', enum: ['click', 'dblclick', 'contextmenu'],
                  description: '鼠标手势：单击、双击或右键单击。',
                },
                offsetX: {
                  type: 'number', minimum: -10000, maximum: 10000,
                  description: '相对于解析目标中心点的水平 CSS 像素偏移。',
                },
                offsetY: {
                  type: 'number', minimum: -10000, maximum: 10000,
                  description: '相对于解析目标中心点的垂直 CSS 像素偏移。',
                },
                expect: EXPECTATION_SCHEMA,
                timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
                visualEvidence: VISUAL_EVIDENCE_SCHEMA,
                sensitive: { type: 'boolean', description: '敏感动作：动作值不写入可回放节点、调试与录制记录。' },
              },
              required: ['locator'],
              additionalProperties: false,
            },
            outputSchema: INTERACTION_SCHEMA,
            safety: 'execute', idempotency: 'keyed', permissions: ['page.interact'],
            preconditions: [], relation: 'click-element',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/fills',
        resourceType: 'FillInteraction',
        relation: 'fill-element',
        summary: '在实时页面中解析规范 locator，并填写解析得到的元素',
        aliases: ['type text', 'fill input', 'enter value'],
        tags: ['page', 'fill', 'form'],
        guidance: PAGE_INTERACTION_GUIDANCE,
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                locator: LOCATOR_SCHEMA,
                value: { type: ['string', 'number', 'boolean'], maxLength: 100000 },
                expect: EXPECTATION_SCHEMA,
                timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
                visualEvidence: VISUAL_EVIDENCE_SCHEMA,
                sensitive: { type: 'boolean', description: '敏感输入：填写值不写入可回放节点、调试与录制记录。' },
              },
              required: ['locator', 'value'], additionalProperties: false,
            },
            outputSchema: INTERACTION_SCHEMA,
            safety: 'write', idempotency: 'keyed', permissions: ['page.interact'],
            preconditions: [], relation: 'fill-element',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/selections',
        resourceType: 'SelectionInteraction',
        relation: 'select-option',
        summary: '在实时页面中解析规范 locator，并在解析得到的元素中选择选项',
        aliases: ['choose dropdown option', 'select value'],
        tags: ['page', 'select', 'form'],
        guidance: PAGE_INTERACTION_GUIDANCE,
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                locator: LOCATOR_SCHEMA,
                value: { type: ['string', 'number', 'boolean'], maxLength: 10000 },
                label: { type: 'string', minLength: 1, maxLength: 10000 },
                index: { type: 'integer', minimum: 0 },
                exact: { type: 'boolean' },
                optionSelector: { type: 'string', minLength: 1, maxLength: 1000 },
                search: { type: 'string', minLength: 1, maxLength: 10000 },
                searchDelayMs: { type: 'integer', minimum: 50, maximum: 30000 },
                dropdownWaitMs: { type: 'integer', minimum: 100, maximum: 30000 },
                expect: EXPECTATION_SCHEMA,
                timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
                visualEvidence: VISUAL_EVIDENCE_SCHEMA,
                sensitive: { type: 'boolean', description: '敏感动作：选择值不写入可回放节点、调试与录制记录。' },
              },
              required: ['locator'],
              anyOf: [{ required: ['value'] }, { required: ['label'] }, { required: ['index'] }],
              additionalProperties: false,
            },
            outputSchema: INTERACTION_SCHEMA,
            safety: 'write', idempotency: 'keyed', permissions: ['page.interact'],
            preconditions: [], relation: 'select-option',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/scrolls',
        resourceType: 'ScrollInteraction',
        relation: 'scroll-page',
        summary: '在明确定位的容器上执行一次确定性滚动',
        aliases: ['scroll page', 'scroll container', 'scroll element', 'scroll horizontally', 'scroll to top', 'scroll to bottom'],
        tags: ['page', 'scroll', 'interaction'],
        guidance: PAGE_INTERACTION_GUIDANCE.concat([
          '滚动会改变实时 PageState 的可见元素集合。不要因为 /page/current 返回 hasMore=true、remainingChars>0，或为了寻找推测存在的页尾、分页、页脚而滚动；只有用户目标确实需要尚未呈现的页面区域，且已有页面事实支持该需要时才滚动。滚动后页面观察已经变化，重新读取 /page/current 时从 start=0 开始。',
        ]),
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                axis: { type: 'string', enum: ['vertical', 'horizontal'] },
                amountPx: { type: 'number', minimum: -1000000, maximum: 1000000 },
                pages: { type: 'number', minimum: -100, maximum: 100 },
                to: { type: 'string', enum: ['top', 'bottom', 'target'] },
                locator: Object.assign({}, LOCATOR_SCHEMA, {
                  description: '需要滚动到可见的元素；to 为 target 时必填。',
                }),
                containerLocator: Object.assign({}, LOCATOR_SCHEMA, {
                  description: '必填的滚动容器。滚动文档时使用 {"selector":"html"}。',
                }),
                expect: EXPECTATION_SCHEMA,
                timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
                visualEvidence: VISUAL_EVIDENCE_SCHEMA,
                sensitive: { type: 'boolean', description: '敏感动作：动作值不写入可回放节点、调试与录制记录。' },
              },
              required: ['containerLocator'],
              anyOf: [
                { required: ['locator'] },
                { properties: { to: { enum: ['top', 'bottom'] } } },
              ],
              additionalProperties: false,
            },
            outputSchema: INTERACTION_SCHEMA,
            safety: 'execute', idempotency: 'keyed', permissions: ['page.interact'],
            preconditions: [], relation: 'scroll-page',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/drags',
        resourceType: 'DragInteraction',
        relation: 'drag-element',
        summary: '在实时页面中解析源元素和目标元素并执行一次拖拽',
        aliases: ['drag element', 'drop element', 'move element'],
        tags: ['page', 'drag', 'interaction'],
        guidance: PAGE_INTERACTION_GUIDANCE.concat([
          '拖拽前必须先通过 GET /page/current 或 GET /page/element 观察并取得源元素与目标元素的规范 locator；sourceLocator 是拖动源，targetLocator 是放置目标。不要猜测选择器、使用坐标或把目标元素改写成父子选择器。',
          '默认执行 CDP 鼠标拖拽；只有页面明确依赖 HTML5 DataTransfer 时才提供 dragItems。拖拽命令完成不等于业务状态完成，优先提供动作前不成立且限定结果容器的 expect。',
          '拖拽改变页面状态后，如需继续操作，应重新 GET /page/current 观察；不要复用拖拽前的过期元素事实。',
        ]),
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                sourceLocator: Object.assign({}, LOCATOR_SCHEMA, { description: '已从当前 PageState 取得的拖动源元素 locator。' }),
                targetLocator: Object.assign({}, LOCATOR_SCHEMA, { description: '已从当前 PageState 取得的放置目标元素 locator。' }),
                steps: { type: 'integer', minimum: 2, maximum: 60, default: 12 },
                dragItems: {
                  type: 'array', maxItems: 100,
                  items: { type: 'object', properties: {
                    mimeType: { type: 'string', minLength: 1, maxLength: 500 },
                    data: { type: 'string', maxLength: 100000 },
                  }, required: ['mimeType', 'data'], additionalProperties: false },
                },
                dragOperationsMask: { type: 'integer', minimum: 1, maximum: 7, default: 1 },
                expect: EXPECTATION_SCHEMA,
                timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
                visualEvidence: VISUAL_EVIDENCE_SCHEMA,
                sensitive: { type: 'boolean' },
              },
              required: ['sourceLocator', 'targetLocator'], additionalProperties: false,
            },
            outputSchema: INTERACTION_SCHEMA,
            safety: 'execute', idempotency: 'keyed', permissions: ['page.interact'],
            preconditions: [], relation: 'drag-element',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/waits',
        resourceType: 'PageWait',
        relation: 'wait-for-page',
        summary: '等待一个语义明确的页面条件，不进行盲目休眠',
        aliases: ['wait for page change', 'wait for text', 'wait for navigation'],
        tags: ['page', 'wait', 'condition'],
        guidance: PAGE_INTERACTION_GUIDANCE,
        methods: {
          POST: method({
            inputSchema: {
              type: 'object',
              properties: {
                condition: EXPECTATION_SCHEMA,
                timeoutMs: { type: 'integer', minimum: WAIT_TIMEOUT_MIN_MS, maximum: WAIT_TIMEOUT_MAX_MS },
                pollIntervalMs: {
                  type: 'integer', minimum: 25, maximum: 2000,
                  description: '条件轮询间隔毫秒；优先于 condition.pollIntervalMs。',
                },
                locator: LOCATOR_SCHEMA,
              },
              required: ['condition'], additionalProperties: false,
            },
            outputSchema: INTERACTION_SCHEMA,
            safety: 'execute', idempotency: 'keyed', permissions: ['page.interact'],
            preconditions: [], relation: 'wait-for-page',
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/javascript-executions',
        resourceType: 'JavaScriptExecution',
        relation: 'execute-page-javascript',
        summary: '在目标页面 world 中执行有界 JavaScript',
        aliases: ['evaluate page javascript', 'run script in page'],
        tags: ['page', 'javascript', 'privileged'],
        methods: {
          POST: method({
            inputSchema: pageDataContract.inputSchema(
              '顶层脚本结果中的包含边界字符起始位置，不是数组下标、对象属性序号或本页返回项数量。首次使用 0；hasMore=true 且 nextStart 不为 null 时，下一次必须把返回的 nextStart 原样作为 start，不能再次使用 0。重复读取仅在真实观察到页面或数据发生变化时才被允许。',
              {
                source: { type: 'string', minLength: 1, maxLength: 100000 },
                world: { type: 'string', enum: ['MAIN', 'ISOLATED'] },
                mode: { type: 'string', enum: ['read', 'write'] },
                timeoutMs: { type: 'integer', minimum: ACTION_TIMEOUT_MIN_MS, maximum: ACTION_TIMEOUT_MAX_MS },
              },
              ['source', 'world', 'mode']
            ),
            outputSchema: JAVASCRIPT_EXECUTION_SCHEMA,
            safety: 'privileged', idempotency: 'keyed', permissions: ['page.javascript'],
            preconditions: [], relation: 'execute-page-javascript',
            guidance: pageDataContract.windowGuidance('页面 JavaScript 结果').concat([
              '页面 JavaScript 不是标准交互失败后的兜底方案；不要分发合成的 DOM 或框架事件来模拟 click、fill、select、scroll 或 wait。',
            ]),
          }),
        },
      }),
      new core.RouteContract({
        template: '/page/interactions/{interactionId}',
        resourceType: 'PageInteraction',
        relation: 'page-interaction',
        summary: '读取本次运行会话产生的一项页面交互',
        tags: ['page', 'interaction', 'receipt'],
        guidance: PAGE_INTERACTION_GUIDANCE,
        methods: {
          GET: method({ inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: true, safety: 'read', permissions: ['page.read'] }),
        },
      }),
    ];
  }

  function encodeSegment(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function mediaUri(index) {
    return '/page/media/' + encodeSegment(index);
  }

  function privilegedVisible(context, permission) {
    context = context || {};
    var permissions = context.permissionScope || context.permissions || [];
    return Array.isArray(permissions) && permissions.indexOf(permission) !== -1;
  }

  function compactDataString(value, maximum) {
    var text = String(value === undefined || value === null ? '' : value);
    return text.length > maximum ? text.slice(0, maximum) : text;
  }

  function fitDecoratedValue(value, field, budget) {
    if (pageDataContract.jsonChars(value) <= budget) return value;
    var candidates = [];
    if (field === 'elements') {
      var state = value && value.state || {};
      var elementBase = {
        locator: value.locator,
        kind: value.kind,
        tag: compactDataString(value.tag, 40),
        role: compactDataString(value.role, 40),
        name: compactDataString(value.name, 80),
        text: '',
        state: {
          disabled: !!state.disabled,
          readOnly: !!state.readOnly,
          checked: state.checked,
          selected: state.selected,
          expanded: compactDataString(state.expanded, 20),
        },
        bounds: value.bounds || {},
        inViewport: !!value.inViewport,
        dataTruncated: true,
      };
      candidates.push(elementBase);
      candidates.push({
        locator: value.locator,
        kind: value.kind,
        tag: '',
        role: '',
        name: '',
        text: '',
        value: null,
        attributes: {},
        state: {},
        bounds: value.bounds || {},
        inViewport: !!value.inViewport,
        dataTruncated: true,
      });
    } else if (field === 'media') {
      var mediaBase = {
        index: value.index,
        generation: value.generation,
        kind: value.kind,
        name: compactDataString(value.name, 80),
        bounds: value.bounds || {},
        visible: !!value.visible,
        uri: value.uri,
        dataTruncated: true,
      };
      candidates.push(Object.assign({}, mediaBase, { affordances: value.affordances || [] }));
      candidates.push(mediaBase);
      candidates.push({
        index: value.index,
        generation: value.generation,
        kind: value.kind,
        name: '',
        bounds: {},
        visible: !!value.visible,
        uri: value.uri,
        dataTruncated: true,
      });
    }
    for (var index = 0; index < candidates.length; index += 1) {
      if (pageDataContract.jsonChars(candidates[index]) <= budget) return candidates[index];
    }
    return null;
  }

  function pageProjectionChars(data, values) {
    return pageDataContract.jsonChars({
      page: data.page,
      application: data.application,
      layout: data.layout,
      coverage: Object.assign({}, data.coverage || {}, { returned: values.length }),
      elements: values,
    });
  }

  function pageElementBoundaryValue(element) {
    element = element && typeof element === 'object' ? element : {};
    var locator = element.locator && typeof element.locator === 'object' ? element.locator : {};
    return {
      selector: String(locator.selector || ''),
      tag: String(element.tag || ''),
      kind: String(element.kind || ''),
    };
  }

  function pageElementBoundaryValues(values) {
    return (Array.isArray(values) ? values : []).map(pageElementBoundaryValue);
  }

  function currentPageWindow(page, query) {
    query = query || {};
    var values = Array.isArray(page && page.elements) ? page.elements.slice() : [];
    // PageState is rebuilt from the live page on every read. Geometry and
    // exposure facts can legitimately vary between two reads without the DOM
    // element sequence changing, so continuation boundaries use only stable
    // element identity fields. No page state is retained between requests.
    var boundaryValues = pageElementBoundaryValues(values);
    var windowSpec;
    var startPosition;
    try {
      windowSpec = pageDataContract.normalizeWindow(query, 'PageState');
      startPosition = pageDataContract.itemBoundaryPosition(boundaryValues, windowSpec.start, 'PageState');
    } catch (error) {
      throw core.arpError('INVALID_REQUEST', error.message, { performed: 'no', details: error.details || {} });
    }
    var appliedWindowSpec = { start: startPosition.start, maxChars: windowSpec.maxChars };
    var startIndex = startPosition.index;
    var sourceTruncated = page && page.truncated === true;
    var data = Object.assign({}, page, {
      phase: appliedWindowSpec.start > 0 ? 'paged' : 'initial',
      coverage: { discovered: values.length, returned: 0 },
      elements: [],
      elementCount: 0,
      discoveredElementCount: values.length,
      discoveryComplete: false,
      start: appliedWindowSpec.start,
      maxChars: appliedWindowSpec.maxChars,
      returnedChars: 0,
      remainingChars: null,
      hasMore: false,
      nextStart: null,
      truncated: sourceTruncated,
    });
    var emptyChars = pageProjectionChars(data, []);
    if (emptyChars > appliedWindowSpec.maxChars) {
      throw new pageDataContract.ContractError('Page resource maxChars is too small for the required response metadata', {
        field: 'elements', maxChars: appliedWindowSpec.maxChars, requiredChars: emptyChars,
      });
    }
    var selected = [];
    var consumedCount = 0;
    var fittedItem = false;
    while (startIndex + consumedCount < values.length) {
      var value = values[startIndex + consumedCount];
      var nextSelected = selected.concat([value]);
      var nextChars = pageProjectionChars(data, nextSelected);
      if (nextChars > appliedWindowSpec.maxChars) {
        if (selected.length) break;
        value = fitDecoratedValue(value, 'elements', appliedWindowSpec.maxChars - emptyChars);
        if (!value) {
          throw new pageDataContract.ContractError('Page resource maxChars is too small to return the next item', {
            field: 'elements', maxChars: appliedWindowSpec.maxChars,
          });
        }
        nextSelected = [value];
        nextChars = pageProjectionChars(data, nextSelected);
        fittedItem = true;
      }
      selected = nextSelected;
      consumedCount += 1;
      data.returnedChars = nextChars;
    }
    var nextIndex = startIndex + consumedCount;
    var nextOffset = pageDataContract.itemBoundaryOffset(boundaryValues, nextIndex, 'PageState');
    data.elements = selected;
    data.elementCount = selected.length;
    data.coverage.returned = selected.length;
    data.hasMore = nextIndex < values.length;
    data.nextStart = data.hasMore ? nextOffset : null;
    data.remainingChars = sourceTruncated
      ? null : (pageDataContract.itemBoundaryOffset(boundaryValues, boundaryValues.length, 'PageState') - nextOffset);
    data.discoveryComplete = !data.hasMore && !sourceTruncated;
    data.truncated = data.hasMore || sourceTruncated || fittedItem;
    if (!selected.length) data.returnedChars = emptyChars;
    return data;
  }

  function enforceDecoratedCharacterWindow(data, field, countField, boundaryValue) {
    var values = Array.isArray(data && data[field]) ? data[field] : [];
    var boundaryValues = typeof boundaryValue === 'function' ? values.map(boundaryValue) : values;
    var windowSpec = pageDataContract.normalizeWindow(data, 'Page resource ' + field);
    var startPosition = pageDataContract.itemBoundaryPosition(boundaryValues, windowSpec.start, 'Page resource ' + field);
    var startIndex = startPosition.index;
    var maxChars = windowSpec.maxChars;
    var selected = [];
    var mapBase = field === 'elements' ? {
      page: data.page,
      application: data.application,
      layout: data.layout,
      coverage: data.coverage,
    } : {};
    function decoratedChars(items) {
      var payload = Object.assign({}, mapBase);
      payload[field] = items;
      return pageDataContract.jsonChars(payload);
    }
    var returnedChars = decoratedChars([]);
    if (returnedChars > maxChars) {
      throw new pageDataContract.ContractError('Page resource maxChars is too small for the required response metadata', {
        field: field,
        maxChars: maxChars,
        requiredChars: returnedChars,
      });
    }
    var consumedCount = 0;
    var fittedItem = false;
    while (startIndex + consumedCount < values.length) {
      var value = values[startIndex + consumedCount];
      var nextSelected = selected.concat([value]);
      var nextReturnedChars = decoratedChars(nextSelected);
      if (nextReturnedChars > maxChars) {
        if (selected.length) break;
        value = fitDecoratedValue(value, field, maxChars - returnedChars);
        if (!value) {
          throw new pageDataContract.ContractError('Page resource maxChars is too small to return the next item', {
            field: field,
            start: Math.max(0, Number(data.start) || 0),
            maxChars: maxChars,
          });
        }
        nextSelected = [value];
        nextReturnedChars = decoratedChars(nextSelected);
        fittedItem = true;
      }
      selected = nextSelected;
      returnedChars = nextReturnedChars;
      consumedCount += 1;
    }
    data[field] = selected;
    data[countField] = selected.length;
    data.start = startPosition.start;
    data.maxChars = windowSpec.maxChars;
    data.returnedChars = returnedChars;
    var nextIndex = startIndex + consumedCount;
    var nextOffset = pageDataContract.itemBoundaryOffset(boundaryValues, nextIndex, 'Page resource ' + field);
    data.hasMore = nextIndex < values.length;
    data.nextStart = data.hasMore ? nextOffset : null;
    data.remainingChars = pageDataContract.itemBoundaryOffset(boundaryValues, boundaryValues.length, 'Page resource ' + field) - nextOffset;
    data.discoveryComplete = !data.hasMore;
    data.truncated = data.hasMore || fittedItem;
    return data;
  }

  function pageRepresentation(page, context, query) {
    var base = '/page/current';
    var data = currentPageWindow(page, query);
    var links = [{ rel: 'self', href: base, method: 'GET' }]
      .concat(pageCurrentAffordances(), [{ rel: 'introspect', href: base, method: 'OPTIONS' }]);
    if (data.nextStart !== null) links.push({
      rel: 'next',
      href: base + '?start=' + data.nextStart + '&maxChars=' + data.maxChars,
      method: 'GET',
    });
    if (privilegedVisible(context, 'page.javascript')) {
      links.push({ rel: 'execute-page-javascript', href: '/page/javascript-executions', method: 'POST' });
    }
    return {
      uri: base,
      type: 'PageState',
      data: data,
      links: links,
    };
  }

  function mediaCollectionRepresentation(collection) {
    var data = enforceDecoratedCharacterWindow(Object.assign({}, collection, {
      media: (collection.media || []).map(function (item) {
        var uri = mediaUri(item.index);
        return Object.assign({}, item, {
          uri: uri,
          affordances: [{ rel: 'capture-page-media', method: 'POST', href: uri + '/artifacts' }],
        });
      }),
    }), 'media', 'mediaCount', function (item) {
      item = item && typeof item === 'object' ? item : {};
      return {
        targetId: String(item.targetId || ''),
        kind: String(item.kind || ''),
        currentSrc: String(item.currentSrc || ''),
        index: Math.max(0, Number(item.index) || 0),
      };
    });
    return {
      uri: '/page/media', type: 'PageMediaCollection', data: data,
      links: [{ rel: 'self', href: '/page/media', method: 'GET' }, { rel: 'current-page-state', href: '/page/current', method: 'GET' }],
    };
  }

  function mediaRepresentation(media) {
    var uri = mediaUri(media.index);
    return {
      uri: uri, type: 'PageMedia', data: media,
      links: [
        { rel: 'page-media', href: '/page/media', method: 'GET' },
        { rel: 'capture-page-media', href: uri + '/artifacts', method: 'POST' },
      ],
    };
  }

  function elementRepresentation(element) {
    var uri = '/page/element';
    var data = Object.assign({}, element);
    var links = [
      { rel: 'current-page-state', href: '/page/current', method: 'GET' },
      { rel: 'click-element', href: '/page/clicks', method: 'POST' },
      { rel: 'fill-element', href: '/page/fills', method: 'POST' },
      { rel: 'select-option', href: '/page/selections', method: 'POST' },
      { rel: 'introspect', href: uri, method: 'OPTIONS' },
    ];
    return {
      uri: uri,
      type: 'PageElement',
      data: data,
      links: links,
    };
  }

  function interactionRepresentation(interaction) {
    var uri = '/page/interactions/' + encodeSegment(interaction.id);
    var data = Object.assign({}, interaction);
    if (!data.locator || !Object.keys(data.locator).length) delete data.locator;
    return {
      uri: uri,
      type: interaction.kind.charAt(0).toUpperCase() + interaction.kind.slice(1) + 'Interaction',
      data: data,
      links: [{ rel: 'self', href: uri, method: 'GET' }],
    };
  }

  function translateError(error, context) {
    if (error instanceof core.ArpError) return error;
    var sourceCode = String(error && error.code || 'INTERNAL_ERROR');
    var code = sourceCode;
    if (sourceCode === 'PAGE_STATE_UNAVAILABLE') code = 'TEMPORARILY_UNAVAILABLE';
    else if (/^(?:TARGET_NOT_FOUND|MEDIA_NOT_FOUND|ARTIFACT_NOT_FOUND)$/.test(sourceCode)) code = 'RESOURCE_NOT_FOUND';
    else if (sourceCode === 'PAGE_CONTEXT_REQUIRED') code = 'INVALID_REQUEST';
    else if (sourceCode === 'TARGET_STALE' || sourceCode === 'TARGET_NOT_ACTIONABLE') code = 'RESOURCE_CONFLICT';
    else if (/^(?:MEDIA_SOURCE_UNREADABLE|MEDIA_CAPTURE_FAILED|IMAGE_FORMAT_UNSUPPORTED|IMAGE_TOO_LARGE)$/.test(sourceCode)) code = 'UPSTREAM_FAILED';
    else if (sourceCode === 'TRANSPORT_INTERRUPTED') code = 'UPSTREAM_FAILED';
    // 用户随时可能刷新或跳转页面。状态失配与传输中断不是死路：错误自带
    // 恢复路径（失败即路标），模型读取新的 PageState 后自行决定下一步。
    var recovery = '';
    if (sourceCode === 'PAGE_STATE_UNAVAILABLE') {
      recovery = '已知 Page 资源的实时页面状态暂不可用。通过 GET /page/current?start=0&maxChars=10000 这一 canonical 恢复入口重新观测；不要把它当作路由或目标资源不存在，也不要猜测其他路径。';
    } else if (/^(?:TARGET_NOT_FOUND|TARGET_STALE|TARGET_NOT_ACTIONABLE)$/.test(sourceCode)) {
      recovery = 'locator 无法在实时页面中解析。调用 GET /page/current?start=0&maxChars=10000，从当前实时 PageState 中选择规范 locator，再决定下一步。绝不要猜测替代 locator。';
    } else if (sourceCode === 'TRANSPORT_INTERRUPTED') {
      recovery = '输入传输在操作过程中关闭。不要重放该操作。调用 GET /page/current 读取最新 PageState，根据新事实判断结果，并在选定规范 locator 后再继续。';
    }
    var current = error && error.currentPage
      ? pageRepresentation(error.currentPage, context, { start: 0, maxChars: pageDataContract.MAX_CHARS })
      : undefined;
    return core.arpError(code, String(error && error.message || 'Page 资源操作失败'), {
      performed: error && error.performed || 'no',
      retryable: error && error.retryable === true,
      details: Object.assign(
        { pageErrorCode: sourceCode },
        recovery ? { recovery: recovery, pageState: { method: 'GET', href: '/page/current' } } : {},
        error && error.details || {}
      ),
      current: current,
      warnings: error && error.warnings || [],
    });
  }

  function createPageResourceAdapter(options) {
    options = options || {};
    var pageService = options.pageService;
    if (!pageService) throw new Error('createPageResourceAdapter requires pageService');
    ['beginToolBatch', 'endToolBatch', 'endGeneration', 'observe', 'getElement', 'listMedia', 'getMedia', 'createMediaArtifacts', 'createViewportArtifact', 'interact', 'executeJavascript'].forEach(function (name) {
      if (typeof pageService[name] !== 'function') throw new Error('PageResourceAdapter requires pageService.' + name);
    });
    var routes = routeContracts();
    var interactions = new Map();

    function retain(representation) {
      var retained = representation;
      if (representation && representation.data && Array.isArray(representation.data.modelContent)) {
        var retainedData = Object.assign({}, representation.data);
        delete retainedData.modelContent;
        retained = Object.assign({}, representation, { data: retainedData });
      }
      interactions.set(representation.data.id, retained);
      while (interactions.size > 200) interactions.delete(interactions.keys().next().value);
      return representation;
    }

    // 页面操作的事实约束是"必须有一个目标 tab"，而非入口类型：page/sidepanel
    // 入口自带绑定 tab；其他入口通过 query 或 body 里的 tabId 显式指定目标页面。
    // 显式 tabId 优先于入口绑定，使任何入口都能操作任意标签页。
    function targetContext(context, request) {
      var explicit = Number(request && request.query && request.query.tabId
        || request && request.body && request.body.tabId) || 0;
      if (!(explicit > 0)) return context;
      var next = Object.assign({}, context, { currentTabId: explicit, currentWindowId: 0 });
      // Preserve the generation-only cancellation channel across an explicit
      // tab override without making it enumerable or part of ARP context data.
      if (context && context.abortSignal) Object.defineProperty(next, 'abortSignal', {
        value: context.abortSignal, enumerable: false, configurable: false,
      });
      return next;
    }

    function get(context, request) {
      context = targetContext(context, request);
      var template = request.routeTemplate;
      var result;
      if (template === '/page/current') result = pageService.observe(context, request.query || {});
      else if (template === '/page/media') {
        return pageService.listMedia(context, request.query || {}).then(function (collection) {
          var representation = mediaCollectionRepresentation(collection);
          return { primary: representation, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, context); });
      } else if (template === '/page/media/{index}') {
        return pageService.getMedia(context, Number(request.params.index), request.query && request.query.generation).then(function (media) {
          var representation = mediaRepresentation(media);
          return { primary: representation, schemaValue: representation.data };
        }).catch(function (error) { throw translateError(error, context); });
      }
      else if (template === '/page/element') {
        result = pageService.getElement(
          context,
          elementLocatorFromQuery(request.query),
          request.query && request.query.start,
          request.query && request.query.maxChars,
          request.query && request.query.representation
        ).then(function (element) {
          return { element: element };
        });
      } else if (template === '/page/interactions/{interactionId}') {
        var retained = interactions.get(String(request.params.interactionId));
        if (!retained) throw core.arpError('RESOURCE_GONE', '当前运行时未保留此页面交互');
        return Promise.resolve({ primary: retained, schemaValue: retained.data });
      } else throw core.arpError('RESOURCE_NOT_FOUND', '未知 Page 资源路由');
      return Promise.resolve(result).then(function (value) {
        if (value && value.element) {
          var elementRep = elementRepresentation(value.element);
          return { primary: elementRep, schemaValue: elementRep.data };
        }
        var representation = pageRepresentation(value, context, request.query || {});
        return {
          primary: representation,
          schemaValue: representation.data,
        };
      }).catch(function (error) { throw translateError(error, context); });
    }

    function post(context, request) {
      context = targetContext(context, request);
      var template = request.routeTemplate;
      var body = request.body || {};
      var operation;
      if (template === '/page/screenshots') {
        return pageService.createViewportArtifact(context, body).then(function (artifact) {
          var primary = {
            uri: artifact.artifactUri,
            type: 'ImageArtifact',
            data: artifact,
            links: [{ rel: 'current-page-state', href: '/page/current', method: 'GET' }],
          };
          return {
            statusCode: 201,
            primary: primary,
            receipt: { performed: 'yes', state: 'succeeded', operationUri: primary.uri },
            schemaValue: artifact,
          };
        }).catch(function (error) { throw translateError(error, context); });
      } else if (template === '/page/media/{index}/artifacts') {
        return pageService.createMediaArtifacts(context, Number(request.params.index), body).then(function (artifact) {
          var primary = {
            uri: artifact.artifactUri,
            type: 'ImageArtifact',
            data: artifact,
            links: [
              { rel: 'page-media-item', href: mediaUri(request.params.index), method: 'GET' },
              { rel: 'page-media', href: '/page/media', method: 'GET' },
            ],
          };
          return {
            statusCode: 201,
            primary: primary,
            receipt: { performed: 'yes', state: 'succeeded', operationUri: primary.uri },
            schemaValue: artifact,
          };
        }).catch(function (error) { throw translateError(error, context); });
      } else if (template === '/page/clicks') {
        operation = pageService.interact(context, 'click', { locator: body.locator, input: body });
      } else if (template === '/page/fills') {
        operation = pageService.interact(context, 'fill', { locator: body.locator, input: body });
      } else if (template === '/page/selections') {
        operation = pageService.interact(context, 'select', { locator: body.locator, input: body });
      } else if (template === '/page/scrolls') {
        operation = pageService.interact(context, 'scroll', { locator: body.locator, input: body });
      } else if (template === '/page/drags') {
        operation = pageService.interact(context, 'drag', {
          locator: body.sourceLocator,
          input: Object.assign({}, body, {
            targetSelector: body.targetLocator && body.targetLocator.selector,
            targetText: body.targetLocator && body.targetLocator.text,
            targetRefName: body.targetLocator && body.targetLocator.ref,
            targetIndex: body.targetLocator && body.targetLocator.elementIndex,
          }),
        });
      } else if (template === '/page/waits') {
        operation = pageService.interact(context, 'wait', { input: body });
      } else if (template === '/page/javascript-executions') {
        return pageService.executeJavascript(context, body).then(function (result) {
          var execution = result.execution;
          var uri = '/page/interactions/' + encodeSegment(execution.id);
          var primary = {
            uri: uri,
            type: 'JavaScriptExecution',
            data: execution,
            links: [{ rel: 'current-page-state', href: '/page/current', method: 'GET' }],
          };
          retain(primary);
          return {
            statusCode: 201,
            primary: primary,
            receipt: actionEnvelopeReceipt(execution.receipt, execution, uri),
            schemaValue: execution,
          };
        }).catch(function (error) { throw translateError(error, context); });
      } else throw core.arpError('RESOURCE_NOT_FOUND', '未知 Page 操作路由');

      return Promise.resolve(operation).then(function (result) {
        var primary = retain(interactionRepresentation(result.interaction));
        return {
          statusCode: 201,
          primary: primary,
          receipt: actionEnvelopeReceipt(result.interaction.receipt, result.interaction, primary.uri),
          warnings: result.warnings || [],
          schemaValue: primary.data,
        };
      }).catch(function (error) { throw translateError(error, context); });
    }

    function descriptor(route, methodName, href) {
      var contract = route.methods[methodName];
      return new core.CapabilityDescriptor({
        method: methodName,
        href: href,
        relation: contract.relation || route.relation,
        summary: contract.summary || route.summary,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        safety: contract.safety,
        idempotency: contract.idempotency,
        execution: contract.execution,
        requiredPermissions: contract.permissions,
        requiredPreconditions: contract.preconditions,
        patchMediaTypes: contract.patchMediaTypes,
      });
    }

    function introspect(context, request) {
      var uri = core.canonicalizeUri(request.uri);
      var matched = routes.find(function (route) { return !!route.match(uri); });
      if (!matched) return [];
      if (matched.template.indexOf('/javascript-executions') !== -1 && !privilegedVisible(context, 'page.javascript')) return [];
      return Object.keys(matched.methods).map(function (methodName) { return descriptor(matched, methodName, uri); });
    }

    var adapter = core.defineAdapter({
      root: 'page',
      routeContracts: routes,
      get: get,
      post: post,
      introspect: introspect,
    });
    adapter.beginToolBatch = function (context) { return pageService.beginToolBatch(context); };
    adapter.endToolBatch = function (context) { return pageService.endToolBatch(context); };
    adapter.endGeneration = function (context) { return pageService.endGeneration(context); };
    return adapter;
  }

  return Object.freeze({
    API_VERSION: 1,
    createAdapter: createPageResourceAdapter,
    createPageResourceAdapter: createPageResourceAdapter,
    createRouteContracts: routeContracts,
    resolveEntryActionContracts: resolveEntryActionContracts,
    routeContracts: routeContracts,
  });
});
