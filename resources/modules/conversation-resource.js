// ARP/1 Conversation resources.
(function attachConversationResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var arp = commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!arp || !support || !adapter) throw new Error('ConversationResource dependencies are incomplete');
  var api = factory(arp, support, adapter);
  if (commonJs) module.exports = api;
  else root.ConversationResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (arp, support, ResourceModuleAdapter) {
  'use strict';
  var QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  // Conversation snapshots and context metadata are persisted by the trusted
  // Options surface. They are intentionally absent from Agent-visible schemas:
  // an Agent starts turns through its own runtime, rather than assembling UI
  // persistence state. The background stamps ui:* actors; callers cannot set
  // that context through the ARP transport.
  var JSON_VALUE_SCHEMA = Object.freeze({ type: ['object', 'array', 'string', 'number', 'boolean', 'null'] });
  var STRING_LIST_SCHEMA = Object.freeze({ type: 'array', maxItems: 240, items: { type: 'string', maxLength: 12000 } });
  var RESOURCE_POLICY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      roots: { type: 'object', additionalProperties: { type: 'object' } },
      permissions: { type: 'array', items: { type: 'string', maxLength: 160 } },
    },
    required: ['roots', 'permissions'], additionalProperties: false,
  });
  var SNAPSHOT_SETTINGS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      runner: { const: 'agent-core' }, temperature: { type: 'number' }, topP: { type: 'number' },
      maxTokens: { type: 'integer', minimum: 1 }, maxContextTokens: { type: 'integer', minimum: 0 },
      reasoningEffort: { type: 'string', maxLength: 40 }, contextCompression: { type: 'string', enum: ['auto', 'off'] },
      streamOutput: { type: 'boolean' }, mode: { type: 'string', enum: ['normal', 'fullAuto'] },
      maxIterations: { type: 'integer', minimum: 1 }, maxToolCalls: { type: 'integer', minimum: 1 },
      autoCreateNewTopic: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var ASSISTANT_SNAPSHOT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      profileVersion: { type: 'integer', minimum: 0 }, id: { type: 'string', maxLength: 240 },
      name: { type: 'string', maxLength: 300 }, description: { type: 'string', maxLength: 10000 },
      settings: SNAPSHOT_SETTINGS_SCHEMA, prompt: { type: 'string', maxLength: 100000 },
      skillIds: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 240 } },
      mcpServerIds: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 240 } },
      modelServiceId: { type: 'string', maxLength: 240 }, resourcePolicy: RESOURCE_POLICY_SCHEMA,
      sourceUpdatedAt: { type: 'integer', minimum: 0 }, snapshotAt: { type: 'integer', minimum: 0 },
      // This is stable JSON, not a fixed-size digest. JSON escaping can expand
      // the bounded 100k prompt by 6x; the remainder covers IDs and policy.
      signature: { type: 'string', maxLength: 700000 },
    },
    additionalProperties: false,
  });
  var BUDGETS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      maxModelRequests: { type: 'integer', minimum: 0 }, maxIterations: { type: 'integer', minimum: 1 },
      maxToolCalls: { type: 'integer', minimum: 0 }, maxWallTimeMs: { type: 'integer', minimum: 0 },
      maxContextTokens: { type: 'integer', minimum: 0 }, listContextCatalog: { type: 'integer', minimum: 0 },
      searchContext: { type: 'integer', minimum: 0 }, getContextDetail: { type: 'integer', minimum: 0 },
      screenshot: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  });
  var CONTEXT_ARTIFACT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 240 }, type: { type: 'string', maxLength: 120 },
      title: { type: 'string', maxLength: 1200 }, pageId: { type: 'string', maxLength: 240 },
      flowId: { type: 'string', maxLength: 240 }, selector: { type: 'string', maxLength: 12000 },
      ref: { type: 'string', maxLength: 500 }, tool: { type: 'string', maxLength: 240 },
      sourceToolCallId: { type: 'string', maxLength: 240 }, summary: { type: 'string', maxLength: 2400 },
      updatedAt: { type: 'integer', minimum: 0 }, fields: { type: 'array', maxItems: 80, items: JSON_VALUE_SCHEMA },
      candidates: { type: 'array', maxItems: 80, items: JSON_VALUE_SCHEMA }, nodes: { type: 'array', maxItems: 80, items: JSON_VALUE_SCHEMA },
      filesToChange: STRING_LIST_SCHEMA, nextSteps: STRING_LIST_SCHEMA,
      searchQueries: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 500 } },
      searchIds: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
      referencedToolNames: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 160 } },
      searchedTools: { type: 'array', maxItems: 80, items: { type: 'string', maxLength: 160 } },
      missingArtifactRefs: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 500 } },
      suggestedArtifacts: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
        ref: { type: 'string', maxLength: 500 }, purpose: { type: 'string', maxLength: 800 }, exists: { type: 'boolean' },
      }, required: ['ref', 'purpose', 'exists'], additionalProperties: false } },
      gapKind: { type: 'string', maxLength: 120 }, status: { type: 'string', maxLength: 40 },
      currentGoal: { type: 'string', maxLength: 600 }, evidence: { type: 'string', maxLength: 2400 },
      impact: { type: 'string', maxLength: 1200 }, suggestedChange: { type: 'string', maxLength: 1600 },
      failedTool: { type: 'string', maxLength: 160 }, failedArgPath: { type: 'string', maxLength: 240 },
      requiredEvidence: { type: 'string', maxLength: 800 }, requirement: { type: 'string', maxLength: 1200 },
      reason: { type: 'string', maxLength: 2400 }, currentToolsInsufficient: { type: 'boolean' },
      meta: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  });
  var CONTEXT_META_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      windowNumber: { type: 'integer', minimum: 0 }, historyVersion: { type: 'integer', minimum: 0 },
      originalGoal: { type: 'string', maxLength: 12000 }, currentGoal: { type: 'string', maxLength: 12000 },
      goalChangeReason: { type: 'string', maxLength: 2400 }, lastGoalChangedAt: { type: 'integer', minimum: 0 },
      lastTurnIntent: { type: 'string', maxLength: 2400 }, lastTurnReason: { type: 'string', maxLength: 2400 },
      architectureVersion: { type: 'integer', minimum: 0 }, lastContextMode: { type: 'string', maxLength: 120 },
      lastKnowledgeMode: { type: 'string', maxLength: 120 }, lastKnowledgeIds: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 160 } },
      lastKnowledgeSelectionAt: { type: 'integer', minimum: 0 },
      decisionPolicy: { type: 'object', properties: {
        version: { type: 'integer', minimum: 0 }, riskLevel: { type: 'string', maxLength: 40 },
        allowedPermissionGroups: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 160 } },
        evidenceFloor: { type: 'string', maxLength: 240 }, requiresVerification: { type: 'boolean' }, requiresFreshEvidence: { type: 'boolean' },
        completionStandard: { type: 'string', maxLength: 400 }, uncertaintyAction: { type: 'string', maxLength: 160 },
        stopConditions: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 160 } },
      }, additionalProperties: false },
      decisionOutcome: { type: 'object', properties: {
        status: { type: 'string', maxLength: 60 }, required: { type: 'boolean' },
        evidenceRefs: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 240 } },
        missing: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } }, at: { type: 'integer', minimum: 0 },
      }, additionalProperties: false },
      activeGoal: { type: 'object', properties: {
        required: { type: 'boolean' }, objective: { type: 'string', maxLength: 12000 }, status: { type: 'string', maxLength: 40 },
        summary: { type: 'string', maxLength: 600 }, evidence: STRING_LIST_SCHEMA, remaining: STRING_LIST_SCHEMA,
        requirements: { type: 'array', maxItems: 24, items: { type: 'object', properties: {
          id: { type: 'string', maxLength: 120 }, description: { type: 'string', maxLength: 800 }, status: { type: 'string', maxLength: 40 },
          evidenceRefs: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 300 } },
        }, required: ['id', 'description', 'status', 'evidenceRefs'], additionalProperties: false } },
        evidenceLedger: { type: 'array', maxItems: 240, items: { type: 'object', properties: {
          ref: { type: 'string', maxLength: 300 }, toolCallId: { type: 'string', maxLength: 200 }, tool: { type: 'string', maxLength: 160 },
          success: { type: 'boolean' }, errorKind: { type: 'string', maxLength: 120 }, retryable: { type: 'boolean' },
          artifactRefs: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 300 } }, at: { type: 'integer', minimum: 0 },
        }, required: ['ref', 'toolCallId', 'tool', 'success', 'errorKind', 'retryable', 'artifactRefs', 'at'], additionalProperties: false } },
        continuationCount: { type: 'integer', minimum: 0 },
        limits: { type: 'object', properties: { maxContinuations: { type: 'integer', minimum: 0 }, maxTokens: { type: 'integer', minimum: 0 }, maxDurationMs: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        usage: { type: 'object', properties: { continuations: { type: 'integer', minimum: 0 }, inputTokens: { type: 'integer', minimum: 0 }, outputTokens: { type: 'integer', minimum: 0 }, totalTokens: { type: 'integer', minimum: 0 }, elapsedMs: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        verification: { type: 'object', properties: { status: { type: 'string', maxLength: 60 }, missing: STRING_LIST_SCHEMA, verifiedAt: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        terminalSource: { type: 'string', maxLength: 120 }, terminalReason: { type: 'string', maxLength: 600 }, terminalAt: { type: 'integer', minimum: 0 },
        createdAt: { type: 'integer', minimum: 0 }, updatedAt: { type: 'integer', minimum: 0 },
      }, additionalProperties: false },
      lastTurnMessage: { type: 'string', maxLength: 12000 }, lastTurnMessageChars: { type: 'integer', minimum: 0 },
      pendingCleanContext: { type: 'boolean' }, lastCleanContextAt: { type: 'integer', minimum: 0 }, cleanContextTriggerReason: { type: 'string', maxLength: 2400 },
      lastFailureKind: { type: 'string', maxLength: 160 }, lastFailureSignature: { type: 'string', maxLength: 400 }, repeatedFailureCount: { type: 'integer', minimum: 0 },
      lastFailureAt: { type: 'integer', minimum: 0 }, lastToolFailureAt: { type: 'integer', minimum: 0 },
      entryStatus: { type: 'object', properties: {
        entry: { type: 'string', maxLength: 40 }, tabId: { type: 'integer', minimum: 0 }, windowId: { type: 'integer', minimum: 0 },
        pageId: { type: 'string', maxLength: 160 }, url: { type: 'string', maxLength: 1000 }, pageLabel: { type: 'string', maxLength: 240 }, origin: { type: 'string', maxLength: 1000 },
        conversationId: { type: 'string', maxLength: 240 }, flowId: { type: 'string', maxLength: 240 }, flowGroupId: { type: 'string', maxLength: 240 }, runId: { type: 'string', maxLength: 240 }, knowledgeId: { type: 'string', maxLength: 240 },
      }, additionalProperties: false },
      semanticStatus: { type: 'object', properties: {
        taskType: { type: 'string', maxLength: 80 }, phase: { type: 'string', maxLength: 80 }, completionMode: { type: 'string', maxLength: 40 }, executionTarget: { type: 'string', maxLength: 80 }, targetSource: { type: 'string', maxLength: 120 }, linkSemantics: { type: 'string', maxLength: 160 }, contextBudgetProfile: { type: 'string', maxLength: 80 }, highRiskFallbackAllowed: { type: 'boolean' }, oneOffScriptAllowed: { type: 'boolean' }, hardRequirements: STRING_LIST_SCHEMA, requiredPhases: STRING_LIST_SCHEMA, preferredTools: STRING_LIST_SCHEMA, preferredNodes: STRING_LIST_SCHEMA, forbiddenActions: STRING_LIST_SCHEMA, allowedFallbacks: STRING_LIST_SCHEMA, completionStandard: { type: 'string', maxLength: 300 },
      }, additionalProperties: false },
      artifacts: { type: 'object', properties: {
        pageStructureSnapshots: { type: 'array', maxItems: 8, items: CONTEXT_ARTIFACT_SCHEMA }, formMaps: { type: 'array', maxItems: 12, items: CONTEXT_ARTIFACT_SCHEMA }, selectorPlans: { type: 'array', maxItems: 16, items: CONTEXT_ARTIFACT_SCHEMA }, flowNodePlans: { type: 'array', maxItems: 12, items: CONTEXT_ARTIFACT_SCHEMA }, componentProtocols: { type: 'array', maxItems: 8, items: CONTEXT_ARTIFACT_SCHEMA }, capabilityGapPlans: { type: 'array', maxItems: 20, items: CONTEXT_ARTIFACT_SCHEMA },
      }, additionalProperties: false },
      lastHistoryRewriteAt: { type: 'integer', minimum: 0 }, agentSession: { type: 'object', properties: { conversationId: { type: 'string', maxLength: 240 }, branchId: { type: 'string', maxLength: 240 }, currentResource: { type: 'string', maxLength: 1000 }, contractLedger: { type: 'array', maxItems: 240, items: JSON_VALUE_SCHEMA }, goal: JSON_VALUE_SCHEMA }, additionalProperties: false },
      permissionScope: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 160 } }, lastDeterministicCompactionAt: { type: 'integer', minimum: 0 }, lastCompactionDroppedMessages: { type: 'integer', minimum: 0 }, lastHistoryRecoveryAt: { type: 'integer', minimum: 0 }, lastHistoryRecoveryDroppedMessages: { type: 'integer', minimum: 0 }, updatedAt: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  });
  function nullableProperties(properties) {
    var output = {};
    Object.keys(properties).forEach(function (key) { output[key] = { anyOf: [properties[key], { type: 'null' }] }; });
    return output;
  }
  function trustedPatchSchema(properties) {
    return Object.freeze({ type: 'object', properties: nullableProperties(properties), minProperties: 1, additionalProperties: false });
  }
  var CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      topicId: { type: 'string', minLength: 1, maxLength: 240 },
      assistantId: { type: 'string', minLength: 1, maxLength: 240 },
      name: { type: 'string', maxLength: 300 }, objective: { type: 'string', maxLength: 12000 },
      activeTabId: { type: 'integer', minimum: 0 }, activeWindowId: { type: 'integer', minimum: 0 },
      targetUrl: { type: 'string', maxLength: 20000 }, targetTitle: { type: 'string', maxLength: 1000 },
      modelServiceId: { type: 'string', maxLength: 240 }, maxIterations: { type: 'integer', minimum: 1, maximum: 1000 },
      maxToolCalls: { type: 'integer', minimum: 1, maximum: 5000 }, makeActive: { type: 'boolean' },
    },
    required: ['assistantId'], additionalProperties: false,
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      name: { type: ['string', 'null'], maxLength: 300 }, objective: { type: ['string', 'null'], maxLength: 12000 },
      assistantId: { type: 'string', minLength: 1, maxLength: 240 }, modelServiceId: { type: 'string', maxLength: 240 },
      archived: { const: true },
    },
    minProperties: 1, additionalProperties: false,
  });
  var TRUSTED_UI_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: Object.assign({}, CREATE_SCHEMA.properties, {
      assistantSnapshot: ASSISTANT_SNAPSHOT_SCHEMA, contextMeta: CONTEXT_META_SCHEMA,
    }),
    required: ['assistantId'], additionalProperties: false,
  });
  var TRUSTED_UI_PATCH_SCHEMA = trustedPatchSchema(Object.assign({}, PATCH_SCHEMA.properties, {
    assistantSnapshot: ASSISTANT_SNAPSHOT_SCHEMA, budgets: BUDGETS_SCHEMA, contextMeta: CONTEXT_META_SCHEMA,
  }));
  var RESOURCE_SCHEMA = Object.freeze({
    type: 'object',
    properties: { topicId: { type: 'string' }, id: { type: 'string' }, archived: { type: 'boolean' } },
    required: ['topicId'], additionalProperties: true,
  });
  var DELETED_SCHEMA = Object.freeze({
    type: 'object', properties: { id: { type: 'string' }, deleted: { const: true } },
    required: ['id', 'deleted'], additionalProperties: true,
  });
  var MESSAGE_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 200000 },
      assistantId: { type: 'string', minLength: 1, maxLength: 240, description: '仅本轮生效：覆盖该 Conversation 当前绑定的 Assistant' },
      serviceId: { type: 'string', minLength: 1, maxLength: 240, description: '仅本轮生效：覆盖本轮使用的 ModelService' },
      tabId: { type: 'integer', minimum: 1, description: '仅本轮生效：本轮页面动作的入口标签页' },
      attachments: {
        type: 'array', maxItems: 32,
        description: '产物附件引用。Recording 范围附件（kind=recording/source-range）另有由运行时精确校验的必填 metadata 合同',
        items: {
          type: 'object',
          properties: {
            artifactUri: { type: 'string', minLength: 1, maxLength: 2048 },
            kind: { type: 'string', maxLength: 1024 }, mimeType: { type: 'string', maxLength: 1024 },
            name: { type: 'string', maxLength: 1024 }, sha256: { type: 'string', maxLength: 1024 },
            size: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 0 },
            height: { type: 'integer', minimum: 0 }, metadata: { type: 'object' },
          },
          required: ['artifactUri'], additionalProperties: false,
        },
      },
    },
    required: ['message'], additionalProperties: false,
  });
  var TURN_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      conversationId: { type: 'string' }, commandId: { type: 'string' },
      generationId: { type: 'string' }, turnId: { type: 'string' }, state: { type: 'string' },
    },
    required: ['conversationId', 'generationId'], additionalProperties: true,
  });
  var EVENTS_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      afterSequence: { type: 'integer', minimum: 0 },
      beforeSequence: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      includePayloads: { type: 'boolean' },
      branchId: { type: 'string', maxLength: 256 },
      generationId: { type: 'string', maxLength: 256 },
      actorId: { type: 'string', maxLength: 256 },
      types: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 128 } },
      q: { type: 'string', maxLength: 4000 },
    },
    description: 'afterSequence 与 beforeSequence 互斥，同一请求只能携带其一',
    anyOf: [
      { properties: { afterSequence: false } },
      { properties: { beforeSequence: false } },
    ],
    additionalProperties: false,
  });
  var EXPORT_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      includeReasoning: { type: 'boolean' },
      includePayloads: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var SEARCH_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      q: { type: 'string', maxLength: 4000 }, branchId: { type: 'string', maxLength: 256 },
      generationId: { type: 'string', maxLength: 256 }, actorId: { type: 'string', maxLength: 256 },
      types: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 128 } },
      fromSequence: { type: 'integer', minimum: 0 }, toSequence: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500 }, includePayloads: { type: 'boolean' },
    }, additionalProperties: false,
  });
  var CONVERSATIONS_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      q: { type: 'string', maxLength: 1000 },
      status: { type: 'string', maxLength: 100 },
      includeArchived: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var ROUTES = Object.freeze([
    support.route({
      template: '/conversations', resourceType: 'ConversationCollection', relation: 'conversations',
      summary: '列出或创建 Conversation', aliases: ['对话'], tags: ['conversation'],
      entryWeights: { conversation: 35, global: 15 },
      methods: {
        GET: support.read(CONVERSATIONS_QUERY_SCHEMA, 'conversations.read', 'conversations', '列出 Conversation 摘要'),
        POST: support.create(CREATE_SCHEMA, 'conversations.write', 'conversations', '创建一个 Conversation', { outputSchema: RESOURCE_SCHEMA }),
      },
    }),
    support.route({
      template: '/conversations/{conversationId}', resourceType: 'Conversation', relation: 'conversation',
      summary: '读取、归档或删除一个 Conversation', aliases: ['话题', 'conversation topic'],
      tags: ['conversation'], entryWeights: { conversation: 35, global: 15 },
      methods: {
        GET: support.read(QUERY_SCHEMA, 'conversations.read', 'conversation', '读取一个 Conversation，不包含原始模型 I/O', RESOURCE_SCHEMA),
        PATCH: support.patch('conversations.write', 'conversation', '局部修改元数据或归档一个 Conversation', PATCH_SCHEMA, RESOURCE_SCHEMA),
        DELETE: support.remove('conversations.delete', 'conversation', '删除一个未运行的 Conversation 及其归档', DELETED_SCHEMA),
      },
    }),
    support.route({
      template: '/conversations/{conversationId}/messages', resourceType: 'ConversationMessageCollection',
      relation: 'conversation-messages', summary: '发送一条用户消息并启动异步 Conversation 轮次',
      aliases: ['发送对话', 'send message'], tags: ['conversation', 'turn'],
      entryWeights: { conversation: 35, global: 15 },
      methods: {
        POST: support.method(MESSAGE_CREATE_SCHEMA, {
          safety: 'execute', idempotency: 'keyed', execution: 'async',
          permissions: ['conversations.execute'], preconditions: [],
          relation: 'conversation-messages',
          summary: '发送一条消息并创建一次 generation', outputSchema: TURN_SCHEMA,
        }),
      },
    }),
    support.route({
      template: '/conversations/{conversationId}/events', resourceType: 'ConversationEventPage',
      relation: 'conversation-events', summary: '分页读取 Conversation 事件日志和 generation 状态',
      aliases: ['对话结果', 'conversation events'], tags: ['conversation', 'events'],
      entryWeights: { conversation: 35, global: 15 },
      methods: {
        GET: support.read(EVENTS_QUERY_SCHEMA, 'conversations.read', 'conversation-events', '读取 Conversation 事件和活动 generation 状态'),
      },
    }),
    support.route({
      template: '/conversations/{conversationId}/search', resourceType: 'ConversationEventPage',
      relation: 'conversation-search', summary: '从同一 Journal 检索 Conversation 事件', aliases: ['检索对话事件'], tags: ['conversation', 'events'],
      entryWeights: { conversation: 35, global: 15 },
      methods: { GET: support.read(SEARCH_QUERY_SCHEMA, 'conversations.read', 'conversation-search', '按 Journal 条件检索事件') },
    }),
    support.route({
      template: '/conversations/{conversationId}/export', resourceType: 'ConversationExport',
      relation: 'conversation-export', summary: '把一个 Conversation 导出为可移植的 Journal 备份包',
      aliases: ['导出对话', 'conversation backup'], tags: ['conversation', 'export'],
      entryWeights: { conversation: 35, global: 15 },
      methods: {
        GET: support.read(EXPORT_QUERY_SCHEMA, 'conversations.export.read', 'conversation-export', '读取可移植的 Conversation 备份文件'),
      },
    }),
    support.route({
      template: '/conversations/{conversationId}/generations/{generationId}', resourceType: 'ConversationGeneration',
      relation: 'conversation-generation', summary: '取消一个正在运行的 Conversation generation',
      aliases: ['停止对话', 'cancel generation'], tags: ['conversation', 'generation'],
      entryWeights: { conversation: 35, global: 15 },
      methods: {
        DELETE: support.method(null, {
          safety: 'write', idempotency: 'inherent', execution: 'sync',
          permissions: ['conversations.execute'], preconditions: [],
          relation: 'conversation-generation',
          summary: '取消指定的 generation',
        }),
      },
    }),
  ]);

  function isTrustedUi(context) {
    return /^ui:/.test(String(context && (context.actorId || context.actor) || ''));
  }

  function trustedUiDescriptor(request, context, route, inputSchema) {
    if (!isTrustedUi(context) || !route) return null;
    var methodName = String(request && request.method || '').toUpperCase();
    var contract = route.methods && route.methods[methodName];
    if (!contract) return null;
    return new arp.CapabilityDescriptor({
      schemaVersion: arp.PROTOCOL,
      method: methodName,
      href: request.uri,
      relation: contract.relation || route.relation,
      summary: contract.summary || route.summary,
      inputSchema: inputSchema,
      outputSchema: contract.outputSchema,
      safety: contract.safety,
      idempotency: contract.idempotency,
      execution: contract.execution,
      requiredPermissions: contract.permissions,
      requiredPreconditions: contract.preconditions,
      guidance: route.guidance.concat(contract.guidance || []),
      patchMediaTypes: contract.patchMediaTypes,
      deprecated: contract.deprecated || route.deprecated,
    });
  }

  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'ConversationResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/conversations'] = function (request) { return service.listConversations(request.query).then(function (data) { return support.result(request.uri, 'ConversationCollection', data, service); }); };
    handlers.GET['/conversations/{conversationId}'] = function (request) { return service.getConversation(request.params.conversationId, request.query).then(function (data) { return support.result(request.uri, 'Conversation', data, service); }); };
    handlers.POST['/conversations'] = function (request) { return service.createConversation(request.body).then(function (data) { return support.result('/conversations/' + support.segment(data.topicId || data.id), 'Conversation', data, service, 201); }); };
    handlers.PATCH['/conversations/{conversationId}'] = function (request) { return service.patchConversation(request.params.conversationId, request.patch).then(function (data) { return support.result(request.uri, 'Conversation', data, service); }); };
    handlers.DELETE['/conversations/{conversationId}'] = function (request) { return service.deleteConversation(request.params.conversationId).then(function (data) { return support.result(request.uri, 'DeletedResource', data, service); }); };
    handlers.POST['/conversations/{conversationId}/messages'] = function (request, context) {
      return service.startConversationTurn(request.params.conversationId, request.body, context).then(function (data) {
        var eventsUri = '/conversations/' + support.segment(request.params.conversationId) + '/events';
        var output = support.result(eventsUri, 'ConversationTurn', data, service, 202, [
          { rel: 'self', href: eventsUri, method: 'GET' },
          { rel: 'capabilities', href: eventsUri, method: 'OPTIONS' },
          { rel: 'conversation', href: '/conversations/' + support.segment(request.params.conversationId), method: 'GET' },
        ]);
        output.receipt = { performed: 'yes', operationUri: eventsUri, retryAfterMs: 500, state: 'running' };
        return output;
      });
    };
    handlers.GET['/conversations/{conversationId}/events'] = function (request) {
      return service.listConversationEvents(request.params.conversationId, request.query).then(function (data) {
        return support.result(request.uri, 'ConversationEventPage', data, service);
      });
    };
    handlers.GET['/conversations/{conversationId}/search'] = function (request) {
      return service.searchConversationEvents(request.params.conversationId, request.query).then(function (data) {
        return support.result(request.uri, 'ConversationEventPage', data, service);
      });
    };
    handlers.GET['/conversations/{conversationId}/export'] = function (request) {
      return service.exportConversationArchive(request.params.conversationId, request.query).then(function (data) {
        return support.result(request.uri, 'ConversationExport', data, service);
      });
    };
    handlers.DELETE['/conversations/{conversationId}/generations/{generationId}'] = function (request) {
      return service.cancelConversationGeneration(request.params.conversationId, request.params.generationId).then(function (data) {
        return support.result(request.uri, 'ConversationGeneration', data, service);
      });
    };
    function resolveCapabilityDescriptor(request, context, route) {
      if (!isTrustedUi(context)) return null;
      if ((route.template === '/conversations' && request.method === 'POST')
          || (route.template === '/conversations/{conversationId}' && request.method === 'PATCH')) {
        return trustedUiDescriptor(request, context, route,
          route.template === '/conversations' ? TRUSTED_UI_CREATE_SCHEMA : TRUSTED_UI_PATCH_SCHEMA);
      }
      return null;
    }
    return {
      service: service, routeContracts: ROUTES, handlers: handlers,
      resolveCapabilityDescriptor: resolveCapabilityDescriptor,
      preconditionState: service.preconditionState,
    };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'conversations', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
