// Conversation metadata and UI catalog state. Execution facts live only in Conversation Journal.
(function attachConversationState(root, factory) {
  var profileSchema = root && root.ConversationProfileSchema;
  if (!profileSchema) throw new Error('ConversationProfileSchema must load before ConversationState');
  root.ConversationState = factory(profileSchema);
})(globalThis, function (ConversationProfileSchema) {
  'use strict';

  var INCOGNITO_CONTEXT = !!(typeof chrome !== 'undefined' && chrome.extension
    && chrome.extension.inIncognitoContext);
  var ASSISTANTS_STORAGE_KEY = 'conversation_assistants';
  var STORAGE_KEY = INCOGNITO_CONTEXT ? 'conversation_state_incognito' : 'conversation_state';
  var SELECTION_STORAGE_KEY = INCOGNITO_CONTEXT ? 'conversation_selection_incognito' : 'conversation_selection';
  // Topic drafts are runtime-local; assistant definitions use the shared catalog key.
  var DRAFTS_STORAGE_KEY = INCOGNITO_CONTEXT ? 'conversation_drafts_incognito' : 'conversation_drafts';
  var ARCHIVE_STORAGE_PREFIX = INCOGNITO_CONTEXT ? 'conversation_archived_topic_incognito_' : 'conversation_archived_topic_';
  var DEFAULT_MAX_ITERATIONS = 100;
  var DEFAULT_MAX_TOOL_CALLS = 200;
  var writeQueue = Promise.resolve();
  var cachedState = null;
  var cachedStateValid = false;

  function cloneForRead(value) {
    if (value === undefined || value === null) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return clone(value);
  }

  function nowId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function newCodexUuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return nowId('uuid');
  }

  function ensureTopicCodexSessionId(topic) {
    if (!topic) return '';
    if (!topic.codexSessionId) topic.codexSessionId = newCodexUuid();
    return topic.codexSessionId;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function markStateNeedsPersist(state) {
    if (!state) return;
    try {
      Object.defineProperty(state, '__needsPersist', {
        value: true,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    } catch (_) {
      state.__needsPersist = true;
    }
  }

  function invalidateCache() {
    cachedState = null;
    cachedStateValid = false;
  }

  function releaseTopicArtifacts(topicId) {
    topicId = String(topicId || '').trim();
    if (!topicId) return Promise.resolve();
    var direct = globalThis.PageAutomationImageArtifacts;
    if (direct && typeof direct.releaseTopic === 'function') {
      return Promise.resolve(direct.releaseTopic(topicId)).catch(function () {});
    }
    if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function finish() { if (!settled) { settled = true; resolve(); } }
      try {
        var returned = chrome.runtime.sendMessage({
          type: 'IMAGE_ARTIFACT_RELEASE_TOPIC', payload: { topicId: topicId },
        }, finish);
        if (returned && typeof returned.then === 'function') returned.then(finish, finish);
      } catch (_) { finish(); }
    });
  }

  function cloneConversationValue(value, seen) {
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || value === null) return value;
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) throw new TypeError('History values cannot contain cycles');
    seen.push(value);
    var output;
    if (Array.isArray(value)) {
      output = value.map(function (item) { return cloneConversationValue(item, seen); });
    } else {
      output = {};
      Object.keys(value).forEach(function (key) {
        var item = cloneConversationValue(value[key], seen);
        if (item !== undefined) output[key] = item;
      });
    }
    seen.pop();
    return output;
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  var profileSchema = ConversationProfileSchema.create({
    defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
    defaultMaxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    normalizeReasoningEffort: globalThis.ModelSettings && globalThis.ModelSettings.normalizeReasoningEffort,
    normalizeContextCompression: globalThis.ModelSettings && globalThis.ModelSettings.normalizeContextCompression,
  });
  var normalizeResourcePolicy = profileSchema.normalizeResourcePolicy;
  var createResourcePolicy = profileSchema.createResourcePolicy;
  var resourcePolicyCatalog = profileSchema.resourcePolicyCatalog;

  function assistantMode(assistant) {
    var mode = String(assistant && assistant.settings && assistant.settings.mode || '').trim();
    return mode === 'normal' ? 'normal' : 'fullAuto';
  }

  function compactString(value, max) {
    var text = String(value === undefined || value === null ? '' : value);
    max = Number(max) || 0;
    return max && text.length > max ? text.slice(0, max) : text;
  }

  if (!globalThis.ConversationAssistantStateRuntime
      || globalThis.ConversationAssistantStateRuntime.API_VERSION !== 1
      || typeof globalThis.ConversationAssistantStateRuntime.create !== 'function') {
    throw new Error('ConversationAssistantStateRuntime must load before ConversationState');
  }
  var assistantStateRuntime = globalThis.ConversationAssistantStateRuntime.create({
    schemaApi: ConversationProfileSchema,
    profileSchema: profileSchema,
    nowId: nowId,
    now: function () { return Date.now(); },
    compactString: compactString,
    markStateNeedsPersist: markStateNeedsPersist,
  });
  var assistantConfigSignature = assistantStateRuntime.signature;
  var assistantSnapshot = assistantStateRuntime.snapshot;

  function topicLastConversationAt(topic) {
    topic = topic || {};
    var explicit = Number(topic.lastConversationAt || 0);
    if (explicit > 0) return explicit;
    return Number(topic.updatedAt || topic.createdAt || 0) || 0;
  }

  function normalizeContextArtifactItem(item, type) {
    item = item && typeof item === 'object' ? item : {};
    var out = {
      id: String(item.id || '').trim(),
      type: String(item.type || type || '').trim(),
      title: String(item.title || '').trim(),
      pageId: String(item.pageId || '').trim(),
      flowId: String(item.flowId || '').trim(),
      selector: String(item.selector || '').trim(),
      ref: String(item.ref || '').trim(),
      tool: String(item.tool || '').trim(),
      sourceToolCallId: String(item.sourceToolCallId || '').trim(),
      summary: String(item.summary || '').trim().slice(0, 2400),
      updatedAt: Math.max(0, Math.floor(Number(item.updatedAt) || 0)),
    };
    if (Array.isArray(item.fields)) out.fields = item.fields.slice(0, 80);
    if (Array.isArray(item.candidates)) out.candidates = item.candidates.slice(0, 80);
    if (Array.isArray(item.nodes)) out.nodes = item.nodes.slice(0, 80);
    if (Array.isArray(item.filesToChange)) out.filesToChange = item.filesToChange.slice(0, 24);
    if (Array.isArray(item.nextSteps)) out.nextSteps = item.nextSteps.slice(0, 24);
    if (Array.isArray(item.searchQueries)) out.searchQueries = item.searchQueries.map(function (value) { return String(value || '').trim().slice(0, 500); }).filter(Boolean).slice(0, 8);
    if (Array.isArray(item.searchIds)) out.searchIds = item.searchIds.map(function (value) { return String(value || '').trim().slice(0, 200); }).filter(Boolean).slice(0, 20);
    if (Array.isArray(item.referencedToolNames)) out.referencedToolNames = item.referencedToolNames.map(function (value) { return String(value || '').trim().slice(0, 160); }).filter(Boolean).slice(0, 24);
    if (Array.isArray(item.searchedTools)) out.searchedTools = item.searchedTools.map(function (value) { return String(value || '').trim().slice(0, 160); }).filter(Boolean).slice(0, 80);
    if (Array.isArray(item.missingArtifactRefs)) out.missingArtifactRefs = item.missingArtifactRefs.map(function (value) { return String(value || '').trim().slice(0, 500); }).filter(Boolean).slice(0, 12);
    if (Array.isArray(item.suggestedArtifacts)) out.suggestedArtifacts = item.suggestedArtifacts.map(function (artifact) {
      artifact = artifact && typeof artifact === 'object' ? artifact : {};
      return {
        ref: String(artifact.ref || '').trim().slice(0, 500),
        purpose: String(artifact.purpose || '').trim().slice(0, 800),
        exists: artifact.exists === true,
      };
    }).filter(function (artifact) { return artifact.ref && artifact.purpose; }).slice(0, 12);
    if (item.gapKind !== undefined) out.gapKind = String(item.gapKind || '').trim().slice(0, 120);
    if (item.status !== undefined) out.status = String(item.status || 'open').trim().slice(0, 40) || 'open';
    if (item.currentGoal !== undefined) out.currentGoal = String(item.currentGoal || '').trim().slice(0, 600);
    if (item.evidence !== undefined) out.evidence = String(item.evidence || '').trim().slice(0, 2400);
    if (item.impact !== undefined) out.impact = String(item.impact || '').trim().slice(0, 1200);
    if (item.suggestedChange !== undefined) out.suggestedChange = String(item.suggestedChange || '').trim().slice(0, 1600);
    if (item.failedTool !== undefined) out.failedTool = String(item.failedTool || '').trim().slice(0, 160);
    if (item.failedArgPath !== undefined) out.failedArgPath = String(item.failedArgPath || '').trim().slice(0, 240);
    if (item.requiredEvidence !== undefined) out.requiredEvidence = String(item.requiredEvidence || '').trim().slice(0, 800);
    if (item.requirement !== undefined) out.requirement = String(item.requirement || '').trim().slice(0, 1200);
    if (item.reason !== undefined) out.reason = String(item.reason || '').trim().slice(0, 2400);
    if (item.currentToolsInsufficient !== undefined) out.currentToolsInsufficient = item.currentToolsInsufficient === true;
    if (item.meta && typeof item.meta === 'object') out.meta = item.meta;
    if (!out.id) out.id = [out.type || type || 'artifact', out.pageId || out.flowId || 'global', out.selector || out.ref || out.tool || 'item'].join(':').slice(0, 220);
    return out;
  }

  function normalizeContextArtifactList(list, type, limit) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(function (item) {
      return normalizeContextArtifactItem(item, type);
    }).filter(function (item) {
      if (!item.id || seen[item.id]) return false;
      seen[item.id] = true;
      return true;
    }).sort(function (a, b) {
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    }).slice(0, limit || 12);
  }

  function normalizeContextArtifacts(artifacts) {
    artifacts = artifacts && typeof artifacts === 'object' ? artifacts : {};
    return {
      pageStructureSnapshots: normalizeContextArtifactList(artifacts.pageStructureSnapshots, 'pageStructureSnapshot', 8),
      formMaps: normalizeContextArtifactList(artifacts.formMaps, 'formMap', 12),
      selectorPlans: normalizeContextArtifactList(artifacts.selectorPlans, 'selectorPlan', 16),
      flowNodePlans: normalizeContextArtifactList(artifacts.flowNodePlans, 'flowNodePlan', 12),
      componentProtocols: normalizeContextArtifactList(artifacts.componentProtocols, 'componentProtocol', 8),
      capabilityGapPlans: normalizeContextArtifactList(artifacts.capabilityGapPlans, 'capabilityGapPlan', 20),
    };
  }

  function normalizeTopicEntryStatus(entryStatus) {
    entryStatus = entryStatus && typeof entryStatus === 'object' ? entryStatus : {};
    var entry = compactString(entryStatus.entry || '', 60).trim().toLowerCase().replace(/_/g, '-');
    if (entry === 'floating' || entry === 'floating-status' || entry === 'page-conversation' || entry === 'sidepanel') entry = 'page';
    else if (entry === 'flowgroup') entry = 'flow-group';
    else if (entry === 'options' || entry === 'assistant' || !entry) entry = 'conversation';
    if (['page', 'conversation', 'flow', 'flow-group', 'run', 'knowledge', 'global'].indexOf(entry) === -1) entry = 'conversation';
    return {
      entry: entry,
      tabId: Math.max(0, Math.floor(Number(entryStatus.tabId || entryStatus.activeTabId) || 0)),
      windowId: Math.max(0, Math.floor(Number(entryStatus.windowId || entryStatus.activeWindowId) || 0)),
      pageId: compactString(entryStatus.pageId || '', 160).trim(),
      url: compactString(entryStatus.url || entryStatus.pageUrl || '', 1000).trim(),
      pageLabel: compactString(entryStatus.pageLabel || entryStatus.pageName || '', 240).trim(),
      origin: compactString(entryStatus.origin || '', 1000).trim(),
      conversationId: compactString(entryStatus.conversationId || entryStatus.topicId || '', 240).trim(),
      flowId: compactString(entryStatus.flowId || '', 240).trim(),
      flowGroupId: compactString(entryStatus.flowGroupId || entryStatus.groupId || '', 240).trim(),
      runId: compactString(entryStatus.runId || '', 240).trim(),
      knowledgeId: compactString(entryStatus.knowledgeId || '', 240).trim(),
    };
  }

  function normalizePendingUserInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var questions = (Array.isArray(value.questions) ? value.questions : []).map(function (question) {
      question = question && typeof question === 'object' ? question : {};
      return {
        id: compactString(question.id || '', 64).trim(),
        header: compactString(question.header || '', 12).trim(),
        question: compactString(question.question || '', 500).trim(),
        options: (Array.isArray(question.options) ? question.options : []).map(function (option) {
          option = option && typeof option === 'object' ? option : {};
          return {
            label: compactString(option.label || '', 80).trim(),
            description: compactString(option.description || '', 300).trim(),
          };
        }).filter(function (option) { return option.label && option.description; }).slice(0, 3),
      };
    }).filter(function (question) { return question.id && question.header && question.question && question.options.length >= 2; }).slice(0, 3);
    var requestId = compactString(value.requestId || '', 160).trim();
    var turnId = compactString(value.turnId || '', 160).trim();
    var callId = compactString(value.callId || '', 200).trim();
    return requestId && turnId && callId && questions.length ? {
      requestId: requestId,
      turnId: turnId,
      callId: callId,
      questions: questions,
      requestedAt: Math.max(0, Math.floor(Number(value.requestedAt) || 0)),
    } : null;
  }

  function normalizeSemanticStatus(status) {
    status = status && typeof status === 'object' ? status : {};
    function list(value, limit) {
      return (Array.isArray(value) ? value : []).map(function (item) {
        return compactString(item || '', 120).trim();
      }).filter(Boolean).slice(0, limit || 8);
    }
    return {
      taskType: compactString(status.taskType || '', 80).trim(),
      phase: compactString(status.phase || '', 80).trim(),
      completionMode: compactString(status.completionMode || '', 40).trim(),
      executionTarget: compactString(status.executionTarget || '', 80).trim(),
      targetSource: compactString(status.targetSource || '', 120).trim(),
      linkSemantics: compactString(status.linkSemantics || '', 160).trim(),
      contextBudgetProfile: compactString(status.contextBudgetProfile || '', 80).trim(),
      highRiskFallbackAllowed: status.highRiskFallbackAllowed === true,
      oneOffScriptAllowed: status.oneOffScriptAllowed === true,
      hardRequirements: list(status.hardRequirements, 8),
      requiredPhases: list(status.requiredPhases, 8),
      preferredTools: list(status.preferredTools, 12),
      preferredNodes: list(status.preferredNodes, 12),
      forbiddenActions: list(status.forbiddenActions, 10),
      allowedFallbacks: list(status.allowedFallbacks, 8),
      completionStandard: compactString(status.completionStandard || '', 300).trim(),
    };
  }

  function normalizeDecisionPolicy(policy) {
    policy = policy && typeof policy === 'object' ? policy : {};
    function list(value, limit) {
      return (Array.isArray(value) ? value : []).map(function (item) {
        return compactString(item || '', 160).trim();
      }).filter(Boolean).slice(0, limit || 12);
    }
    return {
      version: Math.max(0, Math.floor(Number(policy.version) || 0)),
      riskLevel: compactString(policy.riskLevel || '', 40).trim(),
      allowedPermissionGroups: list(policy.allowedPermissionGroups, 4),
      evidenceFloor: compactString(policy.evidenceFloor || '', 240).trim(),
      requiresVerification: policy.requiresVerification === true,
      requiresFreshEvidence: policy.requiresFreshEvidence === true,
      completionStandard: compactString(policy.completionStandard || '', 400).trim(),
      uncertaintyAction: compactString(policy.uncertaintyAction || '', 160).trim(),
      stopConditions: list(policy.stopConditions, 12),
    };
  }

  function normalizeDecisionOutcome(outcome) {
    outcome = outcome && typeof outcome === 'object' ? outcome : {};
    return {
      status: compactString(outcome.status || '', 60).trim(),
      required: outcome.required === true,
      evidenceRefs: (Array.isArray(outcome.evidenceRefs) ? outcome.evidenceRefs : []).map(function (item) {
        return compactString(item || '', 240).trim();
      }).filter(Boolean).slice(0, 12),
      missing: (Array.isArray(outcome.missing) ? outcome.missing : []).map(function (item) {
        return compactString(item || '', 200).trim();
      }).filter(Boolean).slice(0, 8),
      at: Math.max(0, Math.floor(Number(outcome.at) || 0)),
    };
  }

  function normalizeActiveGoal(goal) {
    goal = goal && typeof goal === 'object' ? goal : {};
    function list(value) {
      return (Array.isArray(value) ? value : []).map(function (item) {
        return compactString(item || '', 500).trim();
      }).filter(Boolean).slice(0, 12);
    }
    function requirements(value) {
      return (Array.isArray(value) ? value : []).map(function (item, index) {
        item = item && typeof item === 'object' ? item : {};
        return {
          id: compactString(item.id || 'requirement_' + (index + 1), 120).trim(),
          description: compactString(item.description || item.requirement || '', 800).trim(),
          status: compactString(item.status || 'pending', 40).trim(),
          evidenceRefs: (Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []).map(function (ref) {
            return compactString(ref || '', 300).trim();
          }).filter(Boolean).slice(0, 12),
        };
      }).filter(function (item) { return item.id && item.description; }).slice(0, 24);
    }
    function ledger(value) {
      return (Array.isArray(value) ? value : []).map(function (item) {
        item = item && typeof item === 'object' ? item : {};
        return {
          ref: compactString(item.ref || '', 300).trim(),
          toolCallId: compactString(item.toolCallId || '', 200).trim(),
          tool: compactString(item.tool || '', 160).trim(),
          success: item.success === true,
          errorKind: compactString(item.errorKind || '', 120).trim(),
          retryable: item.retryable === true,
          artifactRefs: (Array.isArray(item.artifactRefs) ? item.artifactRefs : []).map(function (ref) {
            return compactString(ref || '', 300).trim();
          }).filter(Boolean).slice(0, 24),
          at: Math.max(0, Math.floor(Number(item.at) || 0)),
        };
      }).filter(function (item) { return item.ref && item.toolCallId; }).slice(-240);
    }
    var limits = goal.limits && typeof goal.limits === 'object' ? goal.limits : {};
    var usage = goal.usage && typeof goal.usage === 'object' ? goal.usage : {};
    var verification = goal.verification && typeof goal.verification === 'object' ? goal.verification : {};
    return {
      required: goal.required === true,
      objective: compactString(goal.objective || '', 12000).trim(),
      status: compactString(goal.status || '', 40).trim(),
      summary: compactString(goal.summary || '', 600).trim(),
      evidence: list(goal.evidence),
      remaining: list(goal.remaining),
      requirements: requirements(goal.requirements),
      evidenceLedger: ledger(goal.evidenceLedger),
      continuationCount: Math.max(0, Math.floor(Number(goal.continuationCount) || 0)),
      limits: {
        maxContinuations: Math.max(0, Math.floor(Number(limits.maxContinuations) || 0)),
        maxTokens: Math.max(0, Math.floor(Number(limits.maxTokens) || 0)),
        maxDurationMs: Math.max(0, Math.floor(Number(limits.maxDurationMs) || 0)),
      },
      usage: {
        continuations: Math.max(0, Math.floor(Number(usage.continuations) || Number(goal.continuationCount) || 0)),
        inputTokens: Math.max(0, Math.floor(Number(usage.inputTokens) || 0)),
        outputTokens: Math.max(0, Math.floor(Number(usage.outputTokens) || 0)),
        totalTokens: Math.max(0, Math.floor(Number(usage.totalTokens) || 0)),
        elapsedMs: Math.max(0, Math.floor(Number(usage.elapsedMs) || 0)),
      },
      verification: {
        status: compactString(verification.status || 'pending', 60).trim(),
        missing: list(verification.missing),
        verifiedAt: Math.max(0, Math.floor(Number(verification.verifiedAt) || 0)),
      },
      terminalSource: compactString(goal.terminalSource || '', 120).trim(),
      terminalReason: compactString(goal.terminalReason || '', 600).trim(),
      terminalAt: Math.max(0, Math.floor(Number(goal.terminalAt) || 0)),
      createdAt: Math.max(0, Math.floor(Number(goal.createdAt) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(goal.updatedAt) || 0)),
    };
  }

  function normalizeTopicAgentSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
    try {
      return {
        conversationId: String(session.conversationId || ''),
        branchId: String(session.branchId || ''),
        currentResource: String(session.currentResource || ''),
        contractLedger: JSON.parse(JSON.stringify(Array.isArray(session.contractLedger) ? session.contractLedger : [])),
        goal: session.goal && typeof session.goal === 'object' && !Array.isArray(session.goal)
          ? JSON.parse(JSON.stringify(session.goal))
          : null,
      };
    } catch (_) {
      return null;
    }
  }

  function normalizeTopicContextMeta(meta) {
    meta = meta && typeof meta === 'object' ? meta : {};
    return {
      windowNumber: Math.max(0, Math.floor(Number(meta.windowNumber) || 0)),
      historyVersion: Math.max(0, Math.floor(Number(meta.historyVersion) || 0)),
      originalGoal: String(meta.originalGoal || '').trim(),
      currentGoal: String(meta.currentGoal || '').trim(),
      goalChangeReason: String(meta.goalChangeReason || '').trim(),
      lastGoalChangedAt: Math.max(0, Math.floor(Number(meta.lastGoalChangedAt) || 0)),
      lastTurnIntent: String(meta.lastTurnIntent || '').trim(),
      lastTurnReason: String(meta.lastTurnReason || '').trim(),
      architectureVersion: Math.max(0, Math.floor(Number(meta.architectureVersion) || 0)),
      lastContextMode: String(meta.lastContextMode || '').trim(),
      lastKnowledgeMode: String(meta.lastKnowledgeMode || '').trim(),
      lastKnowledgeIds: (Array.isArray(meta.lastKnowledgeIds) ? meta.lastKnowledgeIds : []).map(function (id) {
        return compactString(id || '', 160).trim();
      }).filter(Boolean).slice(0, 12),
      lastKnowledgeSelectionAt: Math.max(0, Math.floor(Number(meta.lastKnowledgeSelectionAt) || 0)),
      decisionPolicy: normalizeDecisionPolicy(meta.decisionPolicy),
      decisionOutcome: normalizeDecisionOutcome(meta.decisionOutcome),
      activeGoal: normalizeActiveGoal(meta.activeGoal),
      lastTurnMessage: String(meta.lastTurnMessage || '').trim(),
      lastTurnMessageChars: Math.max(0, Math.floor(Number(meta.lastTurnMessageChars) || 0)),
      pendingCleanContext: meta.pendingCleanContext === true,
      lastCleanContextAt: Math.max(0, Math.floor(Number(meta.lastCleanContextAt) || 0)),
      cleanContextTriggerReason: String(meta.cleanContextTriggerReason || '').trim(),
      lastFailureKind: String(meta.lastFailureKind || '').trim(),
      lastFailureSignature: String(meta.lastFailureSignature || '').trim(),
      repeatedFailureCount: Math.max(0, Math.floor(Number(meta.repeatedFailureCount) || 0)),
      lastFailureAt: Math.max(0, Math.floor(Number(meta.lastFailureAt) || 0)),
      lastToolFailureAt: Math.max(0, Math.floor(Number(meta.lastToolFailureAt) || 0)),
      entryStatus: normalizeTopicEntryStatus(meta.entryStatus || meta.entryContext),
      semanticStatus: normalizeSemanticStatus(meta.semanticStatus),
      artifacts: normalizeContextArtifacts(meta.artifacts),
      lastHistoryRewriteAt: Math.max(0, Math.floor(Number(meta.lastHistoryRewriteAt) || 0)),
      agentSession: normalizeTopicAgentSession(meta.agentSession),
      permissionScope: (Array.isArray(meta.permissionScope) ? meta.permissionScope : []).map(function (item) {
        return String(item || '').trim();
      }).filter(Boolean).slice(0, 64),
      lastDeterministicCompactionAt: Math.max(0, Math.floor(Number(meta.lastDeterministicCompactionAt) || 0)),
      lastCompactionDroppedMessages: Math.max(0, Math.floor(Number(meta.lastCompactionDroppedMessages) || 0)),
      lastHistoryRecoveryAt: Math.max(0, Math.floor(Number(meta.lastHistoryRecoveryAt) || 0)),
      lastHistoryRecoveryDroppedMessages: Math.max(0, Math.floor(Number(meta.lastHistoryRecoveryDroppedMessages) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(meta.updatedAt) || 0)),
    };
  }

  function touchTopicConversation(topic, at) {
    if (!topic) return 0;
    var timestamp = Number(at) || Date.now();
    topic.lastConversationAt = timestamp;
    return timestamp;
  }

  function assistantTemplates() {
    return assistantStateRuntime.assistantTemplates();
  }


  function defaultState() {
    var state = {
      version: 1,
      assistants: {},
      assistantOrder: [],
      topics: {},
      topicOrder: [],
      activeAssistantId: '',
      activeTopicId: '',
      updatedAt: Date.now(),
    };
    var templates = assistantTemplates();
    var template = templates.items[templates.order[0]];
    assistantStateRuntime.createAssistant(state, template || { name: '默认助手' });
    return state;
  }

  function emptyDraftState() {
    return {
      assistants: {},
      assistantOrder: [],
      topics: {},
      topicOrder: [],
      updatedAt: 0,
    };
  }

  function assistantCatalogForState(state) {
    state = state || {};
    return {
      version: 1,
      assistants: ConversationProfileSchema.safeShallowMerge(state.assistants || {}),
      assistantOrder: (Array.isArray(state.assistantOrder) ? state.assistantOrder : []).slice(),
      updatedAt: Math.max(0, Number(state.updatedAt) || Date.now()),
    };
  }

  function normalizeAssistantCatalog(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var state = {
      version: 1,
      assistants: raw.assistants && typeof raw.assistants === 'object' && !Array.isArray(raw.assistants)
        ? ConversationProfileSchema.safeShallowMerge(raw.assistants) : {},
      assistantOrder: Array.isArray(raw.assistantOrder) ? raw.assistantOrder.slice() : [],
      topics: {}, topicOrder: [], activeAssistantId: '', activeTopicId: '',
      updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
    };
    assistantStateRuntime.normalizeCatalog(state);
    return assistantCatalogForState(state);
  }

  function assistantCatalogFromStorage(stored) {
    stored = stored || {};
    var shared = stored[ASSISTANTS_STORAGE_KEY];
    if (shared && typeof shared === 'object' && !Array.isArray(shared)
        && shared.assistants && typeof shared.assistants === 'object') {
      return normalizeAssistantCatalog(shared);
    }
    var regular = stored.conversation_state;
    var incognito = stored.conversation_state_incognito;
    var merged = { assistants: {}, assistantOrder: [], updatedAt: 0 };
    [incognito, regular].forEach(function (legacy, index) {
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;
      var assistants = legacy.assistants && typeof legacy.assistants === 'object'
        && !Array.isArray(legacy.assistants) ? legacy.assistants : {};
      Object.keys(assistants).forEach(function (id) {
        // The regular-window catalog is authoritative when legacy split data
        // contains the same Assistant id in both browsing contexts.
        if (index === 1 || !hasOwn(merged.assistants, id)) merged.assistants[id] = assistants[id];
      });
      merged.updatedAt = Math.max(merged.updatedAt, Number(legacy.updatedAt) || 0);
    });
    merged.assistantOrder = (regular && Array.isArray(regular.assistantOrder) ? regular.assistantOrder : [])
      .concat(incognito && Array.isArray(incognito.assistantOrder) ? incognito.assistantOrder : []);
    return normalizeAssistantCatalog(merged);
  }

  function stateWithAssistantCatalog(rawState, catalog) {
    var state = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
      ? ConversationProfileSchema.safeShallowMerge(rawState) : {};
    state.assistants = ConversationProfileSchema.safeShallowMerge(catalog.assistants || {});
    state.assistantOrder = (catalog.assistantOrder || []).slice();
    return state;
  }

  function scopedStateForStorage(state) {
    var scoped = cloneForRead(state || {});
    scoped.assistants = {};
    scoped.assistantOrder = [];
    return scoped;
  }

  function normalizeDraftState(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var drafts = emptyDraftState();
    drafts.assistants = raw.assistants && typeof raw.assistants === 'object' && !Array.isArray(raw.assistants)
      ? ConversationProfileSchema.safeShallowMerge(raw.assistants)
      : {};
    drafts.topics = raw.topics && typeof raw.topics === 'object' && !Array.isArray(raw.topics)
      ? ConversationProfileSchema.safeShallowMerge(raw.topics)
      : {};
    var seenAssistants = {};
    drafts.assistantOrder = (Array.isArray(raw.assistantOrder) ? raw.assistantOrder : [])
      .concat(Object.keys(drafts.assistants)).map(String).filter(function (id) {
        if (!id || seenAssistants[id] || !drafts.assistants[id]) return false;
        seenAssistants[id] = true;
        return true;
      });
    var seenTopics = {};
    drafts.topicOrder = (Array.isArray(raw.topicOrder) ? raw.topicOrder : [])
      .concat(Object.keys(drafts.topics)).map(String).filter(function (id) {
        if (!id || seenTopics[id] || !drafts.topics[id]) return false;
        seenTopics[id] = true;
        return true;
      });
    drafts.updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
    return drafts;
  }

  function mergeDraftState(rawState, rawDrafts) {
    var drafts = normalizeDraftState(rawDrafts);
    if (!drafts.assistantOrder.length && !drafts.topicOrder.length) return rawState;
    var state = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
      ? ConversationProfileSchema.safeShallowMerge(rawState)
      : {};
    state.assistants = state.assistants && typeof state.assistants === 'object' && !Array.isArray(state.assistants)
      ? ConversationProfileSchema.safeShallowMerge(state.assistants)
      : {};
    drafts.assistantOrder.forEach(function (id) {
      if (!hasOwn(state.assistants, id)) state.assistants[id] = drafts.assistants[id];
    });
    var seenAssistants = {};
    state.assistantOrder = drafts.assistantOrder.concat(Array.isArray(state.assistantOrder) ? state.assistantOrder : [])
      .concat(Object.keys(state.assistants)).map(String).filter(function (id) {
        if (!id || seenAssistants[id] || !state.assistants[id]) return false;
        seenAssistants[id] = true;
        return true;
      });
    state.topics = state.topics && typeof state.topics === 'object' && !Array.isArray(state.topics)
      ? ConversationProfileSchema.safeShallowMerge(state.topics)
      : {};
    drafts.topicOrder.forEach(function (id) {
      if (!hasOwn(state.topics, id)) state.topics[id] = drafts.topics[id];
    });
    var seenTopics = {};
    state.topicOrder = drafts.topicOrder.concat(Array.isArray(state.topicOrder) ? state.topicOrder : [])
      .concat(Object.keys(state.topics)).map(String).filter(function (id) {
        if (!id || seenTopics[id] || !state.topics[id]) return false;
        seenTopics[id] = true;
        return true;
      });
    state.updatedAt = Math.max(Number(state.updatedAt) || 0, drafts.updatedAt);
    return state;
  }

  function selectionForState(state) {
    state = state || {};
    return {
      activeAssistantId: String(state.activeAssistantId || ''),
      activeTopicId: String(state.activeTopicId || ''),
      updatedAt: Date.now(),
    };
  }

  function applyStoredSelection(state, selection) {
    if (!state || !selection || typeof selection !== 'object' || Array.isArray(selection)) return state;
    var assistantId = String(selection.activeAssistantId || '').trim();
    var topicId = String(selection.activeTopicId || '').trim();
    var topic = topicId && state.topics && state.topics[topicId];
    if (topic) {
      state.activeTopicId = topicId;
      state.activeAssistantId = topic.assistantId || assistantId || state.activeAssistantId;
      return state;
    }
    if (hasOwn(selection, 'activeTopicId') && !topicId) state.activeTopicId = '';
    if (assistantId && state.assistants && state.assistants[assistantId]) state.activeAssistantId = assistantId;
    return state;
  }

  function ensureState(raw) {
    var hasStoredState = !!(raw && typeof raw === 'object' && !Array.isArray(raw));
    var needsBootstrapAssistant = !(hasStoredState && hasOwn(raw, 'assistants'));
    var emptyState = {
      version: 1,
      assistants: {},
      assistantOrder: [],
      topics: {},
      topicOrder: [],
      activeAssistantId: '',
      activeTopicId: '',
      updatedAt: Date.now(),
    };
    var state = ConversationProfileSchema.safeShallowMerge(
      needsBootstrapAssistant ? defaultState() : emptyState,
      hasStoredState ? raw : {}
    );
    if (needsBootstrapAssistant) markStateNeedsPersist(state);
    assistantStateRuntime.normalizeCatalog(state);

    var rawTopics = state.topics && typeof state.topics === 'object' && !Array.isArray(state.topics)
      ? ConversationProfileSchema.safeShallowMerge(state.topics)
      : {};
    state.topics = {};
    Object.keys(rawTopics).forEach(function (topicId) {
      var topic = rawTopics[topicId];
      if (!topic || typeof topic !== 'object' || Array.isArray(topic)) {
        markStateNeedsPersist(state);
        return;
      }
      state.topics[topicId] = topic;
    });
    Object.keys(state.topics).forEach(function (topicId) {
      var topic = state.topics[topicId];
      if (topic && !topic.archived) assistantStateRuntime.normalizeTopicIdentity(state, topic);
      if (topic) {
        var journalMigrationFinalized = topic.journalMigration && topic.journalMigration.state === 'finalized';
        if (topic.archived) {
          topic.pendingUserInput = null;
          if (journalMigrationFinalized) {
            delete topic.history;
            delete topic.events;
          }
          return;
        }
        topic.contextMeta = normalizeTopicContextMeta(topic.contextMeta);
        topic.pendingUserInput = normalizePendingUserInput(topic.pendingUserInput);
        if (journalMigrationFinalized) {
          delete topic.history;
          delete topic.events;
        }
        var conversationAt = topicLastConversationAt(topic);
        if (Number(topic.lastConversationAt || 0) !== conversationAt) {
          topic.lastConversationAt = conversationAt;
          markStateNeedsPersist(state);
        }
      }
    });
    var requestedTopicOrder = Array.isArray(state.topicOrder) ? state.topicOrder : [];
    var seenTopics = {};
    state.topicOrder = requestedTopicOrder.concat(Object.keys(state.topics)).map(function (id) {
      return String(id || '').trim();
    }).filter(function (id) {
      if (!id || seenTopics[id] || !state.topics[id]) return false;
      seenTopics[id] = true;
      return true;
    });
    if (!ConversationProfileSchema.sameValue(requestedTopicOrder, state.topicOrder)) markStateNeedsPersist(state);
    if (!state.activeAssistantId || !state.assistants[state.activeAssistantId]) state.activeAssistantId = state.assistantOrder[0] || '';
    if (state.activeTopicId && !state.topics[state.activeTopicId]) state.activeTopicId = '';
    return state;
  }

  function queueStateOperation(operation) {
    var result = writeQueue.then(operation);
    writeQueue = result.catch(function () {});
    return result;
  }

  function loadDirect(options) {
    options = options || {};
    if (cachedStateValid && cachedState) {
      return Promise.resolve(cloneForRead(cachedState));
    }
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get([
        STORAGE_KEY, SELECTION_STORAGE_KEY, DRAFTS_STORAGE_KEY, ASSISTANTS_STORAGE_KEY,
        'conversation_state', 'conversation_state_incognito',
      ], function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        var state;
        try {
          var assistantCatalog = assistantCatalogFromStorage(res);
          state = ensureState(mergeDraftState(
            stateWithAssistantCatalog(res && res[STORAGE_KEY], assistantCatalog),
            res && res[DRAFTS_STORAGE_KEY]
          ));
          applyStoredSelection(state, res && res[SELECTION_STORAGE_KEY]);
        } catch (error) {
          // 同步异常必须 reject，否则 load()/enqueueUpdate 的 Promise 永不 settle，
          // 所有对话入口都会静默挂死。
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        var storedAssistantCatalog = res && res[ASSISTANTS_STORAGE_KEY];
        var normalizedAssistantCatalog = assistantCatalogForState(state);
        var assistantsNeedPersist = !(storedAssistantCatalog
          && storedAssistantCatalog.assistants && typeof storedAssistantCatalog.assistants === 'object')
          || !ConversationProfileSchema.sameValue(
            storedAssistantCatalog.assistants,
            normalizedAssistantCatalog.assistants
          )
          || !ConversationProfileSchema.sameValue(
            storedAssistantCatalog.assistantOrder,
            normalizedAssistantCatalog.assistantOrder
          );
        if (state && state.__needsPersist && options.persistMigration === false && !assistantsNeedPersist) {
          resolve(cloneForRead(state));
          return;
        }
        if ((!state || !state.__needsPersist) && !assistantsNeedPersist) {
          cachedState = cloneForRead(state);
          cachedStateValid = true;
          resolve(cloneForRead(state));
          return;
        }
        var migrationValues = {
          [STORAGE_KEY]: scopedStateForStorage(state),
          [SELECTION_STORAGE_KEY]: selectionForState(state),
          [DRAFTS_STORAGE_KEY]: emptyDraftState(),
        };
        if (assistantsNeedPersist) migrationValues[ASSISTANTS_STORAGE_KEY] = normalizedAssistantCatalog;
        chrome.storage.local.set(migrationValues, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else {
            cachedState = cloneForRead(state);
            cachedStateValid = true;
            resolve(cloneForRead(state));
          }
        });
      });
    });
  }

  function saveDirect(state, options) {
    options = options || {};
    state = ensureState(state);
    state.updatedAt = Date.now();
    var values = {
      [STORAGE_KEY]: scopedStateForStorage(state),
      [DRAFTS_STORAGE_KEY]: emptyDraftState(),
    };
    if (options.persistAssistantCatalog === true) {
      values[ASSISTANTS_STORAGE_KEY] = assistantCatalogForState(state);
    }
    if (options.persistSelection === true) values[SELECTION_STORAGE_KEY] = selectionForState(state);
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(values, function () {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else {
          cachedState = cloneForRead(state);
          cachedStateValid = true;
          resolve(cloneForRead(state));
        }
      });
    });
  }

  function load(options) {
    options = options || {};
    return queueStateOperation(function () {
      if (options.fresh === true) invalidateCache();
      return loadDirect({ persistMigration: true });
    });
  }

  function loadArchivedTopic(topicId) {
    topicId = String(topicId || '').trim();
    if (!topicId) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(ARCHIVE_STORAGE_PREFIX + topicId, function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        var topic = res && res[ARCHIVE_STORAGE_PREFIX + topicId];
        if (topic && typeof topic === 'object' && !Array.isArray(topic)) {
          topic = cloneForRead(topic);
          delete topic.history;
          delete topic.events;
        }
        resolve(topic || null);
      });
    });
  }

  function save(state) {
    return queueStateOperation(function () {
      return saveDirect(state, { persistSelection: true, persistAssistantCatalog: true });
    });
  }

  function enqueueUpdate(mutator, options) {
    return queueStateOperation(function () {
      if ((options && options.fresh === true) || typeof document !== 'undefined') invalidateCache();
      return loadDirect({ persistMigration: false }).then(function (state) {
        var next = mutator(state) || state;
        return saveDirect(next, options);
      });
    });
  }

  function mutateDraftState(mutator) {
    return queueStateOperation(function () {
      var source = cachedStateValid && cachedState
        ? Promise.resolve(cachedState)
        : loadDirect({ persistMigration: false });
      return source.then(function (currentState) {
        return new Promise(function (resolve, reject) {
          chrome.storage.local.get(DRAFTS_STORAGE_KEY, function (res) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            var drafts = normalizeDraftState(res && res[DRAFTS_STORAGE_KEY]);
            var mergedState = mergeDraftState(currentState, drafts);
            var mutation;
            try {
              mutation = mutator(mergedState, drafts) || {};
            } catch (err) {
              reject(err);
              return;
            }
            drafts.updatedAt = Date.now();
            var values = { [DRAFTS_STORAGE_KEY]: drafts };
            if (mutation.selection) values[SELECTION_STORAGE_KEY] = mutation.selection;
            chrome.storage.local.set(values, function () {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              cachedState = mergeDraftState(mergedState, drafts);
              if (mutation.selection) applyStoredSelection(cachedState, mutation.selection);
              cachedStateValid = true;
              resolve(cloneForRead(mutation.value));
            });
          });
        });
      });
    });
  }

  // Document contexts reload explicitly on coalesced runtime notifications. Do not
  // subscribe them to every streaming storage write, because Chrome must materialize
  // the full changed value before invoking a storage listener.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes) return;
      var selectionChange = changes[SELECTION_STORAGE_KEY];
      if (selectionChange && cachedStateValid && cachedState) {
        applyStoredSelection(cachedState, selectionChange.newValue);
      }
      if (changes[ASSISTANTS_STORAGE_KEY] || changes[STORAGE_KEY] || changes[DRAFTS_STORAGE_KEY]) {
        invalidateCache();
      }
    });
  }

  function newTopicForState(state, input) {
    var assistantId = input.assistantId || state.activeAssistantId || state.assistantOrder[0] || '';
    if (assistantId && !state.assistants[assistantId]) {
      if (input.strictAssistant) throw new Error('助手不存在: ' + assistantId);
      assistantId = state.assistantOrder[0] || '';
    }
    var assistant = assistantId ? state.assistants[assistantId] : null;
    if (!assistant) throw new Error('请先新建或选择助手');
    var snapshot = assistantSnapshot(assistant);
    if (input.assistantSnapshot && typeof input.assistantSnapshot === 'object' && !Array.isArray(input.assistantSnapshot)) {
      snapshot = profileSchema.mergeSnapshot(snapshot, input.assistantSnapshot, { id: assistantId });
    }
    var topicId = input.topicId || nowId('topic');
    var inputContextMeta = input.contextMeta && typeof input.contextMeta === 'object' ? input.contextMeta : {};
    var topic = {
      topicId: topicId,
      assistantId: assistantId,
      assistantSnapshot: snapshot,
      name: input.name || compactString(input.objective || '新话题', 36),
      objective: input.objective || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeTabId: input.activeTabId || 0,
      activeWindowId: input.activeWindowId || 0,
      targetUrl: input.targetUrl || '',
      targetTitle: input.targetTitle || '',
      modelServiceId: input.modelServiceId || '',
      codexSessionId: newCodexUuid(),
      phase: 'understand',
      status: 'idle',
      budgets: {
        maxIterations: Number(input.maxIterations) || Number(snapshot.settings && snapshot.settings.maxIterations) || DEFAULT_MAX_ITERATIONS,
        maxToolCalls: Number(input.maxToolCalls) || Number(snapshot.settings && snapshot.settings.maxToolCalls) || DEFAULT_MAX_TOOL_CALLS,
        maxContextTokens: Number(snapshot.settings && snapshot.settings.maxContextTokens) || 0,
        listContextCatalog: 4,
        searchContext: 6,
        getContextDetail: 8,
        screenshot: 1,
      },
      counters: {
        iterationCount: 0,
        toolCallCount: 0,
      },
      generatedConfigIds: { pages: [], flows: [], flowGroups: [] },
      activeFlowId: '',
      pendingUserInput: null,
      runInputExample: {},
      lastConversationAt: 0,
      contextMeta: normalizeTopicContextMeta(ConversationProfileSchema.safeMerge(inputContextMeta, {
        windowNumber: 0,
        historyVersion: 0,
        originalGoal: inputContextMeta.originalGoal || input.objective || '',
        currentGoal: inputContextMeta.currentGoal || input.objective || '',
        goalChangeReason: inputContextMeta.goalChangeReason || (input.objective ? 'topic_created' : ''),
        lastGoalChangedAt: Math.max(0, Math.floor(Number(inputContextMeta.lastGoalChangedAt) || 0)) || (input.objective ? Date.now() : 0),
        pendingCleanContext: inputContextMeta.pendingCleanContext === true,
      })),
      result: null,
      error: null,
    };
    if (hasOwn(input, 'history') || hasOwn(input, 'events')) {
      throw new Error('Conversation execution history/events must be imported through Conversation Journal');
    }
    return topic;
  }

  function createTopic(input) {
    input = input && typeof input === 'object' && !Array.isArray(input) ? ConversationProfileSchema.safeMerge(input) : {};
    return mutateDraftState(function (state, drafts) {
      var topic = newTopicForState(state, input);
      drafts.topics[topic.topicId] = topic;
      drafts.topicOrder = [topic.topicId].concat(drafts.topicOrder.filter(function (id) {
        return id !== topic.topicId;
      }));
      var makeActive = input.makeActive !== false;
      var selection = makeActive ? {
        activeTopicId: topic.topicId,
        activeAssistantId: topic.assistantId,
        updatedAt: Date.now(),
      } : null;
      return {
        selection: selection,
        value: {
          topic: topic,
          activeTopicId: makeActive ? topic.topicId : state.activeTopicId || '',
          activeAssistantId: makeActive ? topic.assistantId : state.activeAssistantId || '',
        },
      };
    });
  }

  function setActiveTopic(topicId) {
    topicId = String(topicId || '').trim();
    return queueStateOperation(function () {
      var resolveSelection = function (state) {
        var topic = state && state.topics && state.topics[topicId];
        if (!topic) throw new Error('话题不存在: ' + topicId);
        var selection = {
          activeTopicId: topicId,
          activeAssistantId: topic.assistantId || state.activeAssistantId || '',
          updatedAt: Date.now(),
        };
        return new Promise(function (resolve, reject) {
          chrome.storage.local.set({ [SELECTION_STORAGE_KEY]: selection }, function () {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else {
              if (cachedStateValid && cachedState) applyStoredSelection(cachedState, selection);
              resolve(selection);
            }
          });
        });
      };
      if (cachedStateValid && cachedState) return resolveSelection(cachedState);
      return loadDirect({ persistMigration: false }).then(resolveSelection);
    });
  }

  function setActiveAssistant(assistantId) {
    assistantId = String(assistantId || '').trim();
    return queueStateOperation(function () {
      var resolveSelection = function (state) {
        if (!state || !state.assistants || !state.assistants[assistantId]) {
          throw new Error('助手不存在: ' + assistantId);
        }
        var topicId = String(state.activeTopicId || '');
        var topic = topicId && state.topics && state.topics[topicId];
        if (!topic || topic.assistantId !== assistantId) {
          topicId = '';
          for (var i = 0; i < (state.topicOrder || []).length; i++) {
            var candidateId = state.topicOrder[i];
            var candidate = state.topics && state.topics[candidateId];
            if (candidate && candidate.assistantId === assistantId) {
              topicId = candidateId;
              break;
            }
          }
        }
        var selection = {
          activeAssistantId: assistantId,
          activeTopicId: topicId,
          updatedAt: Date.now(),
        };
        return new Promise(function (resolve, reject) {
          chrome.storage.local.set({ [SELECTION_STORAGE_KEY]: selection }, function () {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else {
              if (cachedStateValid && cachedState) applyStoredSelection(cachedState, selection);
              resolve(selection);
            }
          });
        });
      };
      if (cachedStateValid && cachedState) return resolveSelection(cachedState);
      return loadDirect({ persistMigration: false }).then(resolveSelection);
    });
  }

  function createAssistant(input) {
    input = input && typeof input === 'object' && !Array.isArray(input)
      ? ConversationProfileSchema.safeMerge(input)
      : {};
    return queueStateOperation(function () {
      // The assistant catalog is shared by regular and incognito contexts; always
      // read it fresh before a catalog mutation to avoid cross-context lost updates.
      invalidateCache();
      return loadDirect({ persistMigration: false }).then(function (state) {
        assistantStateRuntime.createAssistant(state, input);
        state.updatedAt = Date.now();
        var assistantId = state.activeAssistantId;
        var assistant = state.assistants[assistantId];
        var selection = {
          activeAssistantId: assistantId,
          activeTopicId: '',
          updatedAt: Date.now(),
        };
        var values = {
          [ASSISTANTS_STORAGE_KEY]: assistantCatalogForState(state),
          [SELECTION_STORAGE_KEY]: selection,
        };
        return new Promise(function (resolve, reject) {
          chrome.storage.local.set(values, function () {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            applyStoredSelection(state, selection);
            cachedState = cloneForRead(state);
            cachedStateValid = true;
            resolve(cloneForRead({
              assistant: assistant,
              activeAssistantId: assistantId,
              activeTopicId: '',
            }));
          });
        });
      });
    });
  }

  function removeArchivedStorageKeys(keys, value) {
    keys = (Array.isArray(keys) ? keys : []).filter(Boolean);
    if (!keys.length) return Promise.resolve(value);
    return new Promise(function (resolve, reject) {
      chrome.storage.local.remove(keys, function () {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(value);
      });
    });
  }

  function updateAssistant(assistantId, patch) {
    patch = patch && typeof patch === 'object' && !Array.isArray(patch)
      ? ConversationProfileSchema.safeMerge(patch)
      : {};
    return enqueueUpdate(function (state) {
      return assistantStateRuntime.updateAssistant(state, assistantId, patch);
    }, { fresh: true, persistAssistantCatalog: true });
  }

  function deleteTopicsByAssistant(assistantId) {
    var archivedStorageKeys = [];
    var removedTopicIds = [];
    return enqueueUpdate(function (state) {
      if (!assistantId) return state;
      var remove = {};
      (state.topicOrder || []).forEach(function (topicId) {
        var topic = state.topics[topicId];
        if (topic && topic.assistantId === assistantId) {
          remove[topicId] = true;
          removedTopicIds.push(topicId);
          if (topic.archived) archivedStorageKeys.push(topic.archiveStorageKey || ARCHIVE_STORAGE_PREFIX + topicId);
        }
      });
      Object.keys(remove).forEach(function (topicId) {
        delete state.topics[topicId];
      });
      state.topicOrder = (state.topicOrder || []).filter(function (topicId) { return !remove[topicId]; });
      if (remove[state.activeTopicId]) state.activeTopicId = '';
      return state;
    }, { persistSelection: true }).then(function (next) {
      return removeArchivedStorageKeys(archivedStorageKeys, next);
    }).then(function (next) {
      return Promise.all(removedTopicIds.map(releaseTopicArtifacts)).then(function () { return next; });
    });
  }

  function deleteAssistant(assistantId) {
    return enqueueUpdate(function (state) {
      return assistantStateRuntime.deleteAssistant(state, assistantId);
    }, { persistSelection: true, fresh: true, persistAssistantCatalog: true });
  }

  function reorderAssistants(order) {
    return enqueueUpdate(function (state) {
      return assistantStateRuntime.reorderAssistants(state, order);
    }, { fresh: true, persistAssistantCatalog: true });
  }

  function updateTopic(topicId, patch) {
    patch = patch && typeof patch === 'object' && !Array.isArray(patch) ? ConversationProfileSchema.safeMerge(patch) : {};
    if (hasOwn(patch, 'history') || hasOwn(patch, 'events')) {
      return Promise.reject(new Error('Conversation execution history/events are immutable outside Conversation Journal'));
    }
    return enqueueUpdate(function (state) {
      var topic = state.topics[topicId];
      if (!topic) return state;
      if (hasOwn(patch, 'assistantId')) {
        var requestedAssistantId = String(patch.assistantId || '').trim();
        if (!requestedAssistantId || !state.assistants[requestedAssistantId]) {
          throw new Error('助手不存在: ' + requestedAssistantId);
        }
        patch = ConversationProfileSchema.safeMerge(patch, { assistantId: requestedAssistantId });
      }
      var next = ConversationProfileSchema.safeMerge(topic, patch, { updatedAt: Date.now() });
      if (hasOwn(patch, 'assistantSnapshot')) {
        var baseSnapshot = topic.assistantSnapshot;
        if (!baseSnapshot && state.assistants[next.assistantId]) baseSnapshot = assistantSnapshot(state.assistants[next.assistantId]);
        next.assistantSnapshot = profileSchema.mergeSnapshot(baseSnapshot || {}, patch.assistantSnapshot, { id: next.assistantId });
      } else if (next.assistantId !== topic.assistantId && state.assistants[next.assistantId]) {
        next.assistantSnapshot = assistantSnapshot(state.assistants[next.assistantId]);
      }
      if (hasOwn(patch, 'contextMeta')) {
        next.contextMeta = normalizeTopicContextMeta(ConversationProfileSchema.safeMerge(topic.contextMeta || {}, patch.contextMeta || {}));
      } else if (topic.contextMeta) {
        next.contextMeta = normalizeTopicContextMeta(topic.contextMeta);
      }
      state.topics[topicId] = next;
      return state;
    });
  }

  function deleteTopic(topicId) {
    var archivedStorageKey = '';
    return enqueueUpdate(function (state) {
      var topic = state.topics[topicId];
      if (topic && topic.archived) archivedStorageKey = topic.archiveStorageKey || ARCHIVE_STORAGE_PREFIX + topicId;
      delete state.topics[topicId];
      state.topicOrder = state.topicOrder.filter(function (id) { return id !== topicId; });
      if (state.activeTopicId === topicId) state.activeTopicId = state.topicOrder[0] || '';
      return state;
    }, { persistSelection: true }).then(function (next) {
      return removeArchivedStorageKeys([archivedStorageKey], next);
    }).then(function (next) {
      return releaseTopicArtifacts(topicId).then(function () { return next; });
    });
  }

  function archiveTopic(topicId) {
    topicId = String(topicId || '').trim();
    return queueStateOperation(function () {
      if (typeof document !== 'undefined') invalidateCache();
      return loadDirect({ persistMigration: false }).then(function (state) {
        var topic = state.topics && state.topics[topicId];
        if (!topic) throw new Error('话题不存在: ' + topicId);
        if (topic.archived) throw new Error('话题已经归档');
        var archivedAt = Date.now();
        var archivedTopic = cloneForRead(topic);
        archivedTopic.archiveMeta = {
          archivedAt: archivedAt,
          previousStatus: topic.status || 'idle',
          previousPhase: topic.phase || '',
        };
        archivedTopic.archivedAt = archivedAt;
        archivedTopic.archived = true;
        archivedTopic.status = 'archived';
        archivedTopic.phase = 'archived';
        archivedTopic.pendingUserInput = null;
        delete archivedTopic.history;
        delete archivedTopic.events;
        archivedTopic.updatedAt = archivedAt;

        var archiveValue = {};
        archiveValue[ARCHIVE_STORAGE_PREFIX + topicId] = archivedTopic;
        return new Promise(function (resolve, reject) {
          chrome.storage.local.set(archiveValue, function () {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        }).then(function () {
          state.topics[topicId] = {
            topicId: topicId,
            assistantId: topic.assistantId || '',
            name: topic.name || topic.objective || '已归档话题',
            createdAt: topic.createdAt || archivedAt,
            updatedAt: archivedAt,
            lastConversationAt: topic.lastConversationAt || topic.updatedAt || topic.createdAt || 0,
            archived: true,
            archivedAt: archivedAt,
            archiveStorageKey: ARCHIVE_STORAGE_PREFIX + topicId,
            status: 'archived',
            phase: 'archived',
          };
          return saveDirect(state);
        }).then(function (next) {
          return { state: next, archivedTopic: cloneForRead(archivedTopic) };
        });
      });
    });
  }

  function updateGeneratedIds(topicId, patch) {
    return enqueueUpdate(function (state) {
      var topic = state.topics[topicId];
      if (!topic) return state;
      var current = Object.assign({ pages: [], flows: [], flowGroups: [] }, topic.generatedConfigIds || {});
      current.pages = Array.isArray(current.pages) ? current.pages : [];
      current.flows = Array.isArray(current.flows) ? current.flows : [];
      current.flowGroups = Array.isArray(current.flowGroups) ? current.flowGroups : [];
      ['pages', 'flows', 'flowGroups'].forEach(function (section) {
        var values = patch && patch[section] || [];
        values.forEach(function (id) {
          if (id && current[section].indexOf(id) === -1) current[section].push(id);
        });
      });
      topic.generatedConfigIds = current;
      if (!topic.activeFlowId && current.flows.length) topic.activeFlowId = current.flows[0];
      topic.updatedAt = Date.now();
      return state;
    });
  }

  return {
    ASSISTANTS_STORAGE_KEY: ASSISTANTS_STORAGE_KEY,
    STORAGE_KEY: STORAGE_KEY,
    SELECTION_STORAGE_KEY: SELECTION_STORAGE_KEY,
    DRAFTS_STORAGE_KEY: DRAFTS_STORAGE_KEY,
    ARCHIVE_STORAGE_PREFIX: ARCHIVE_STORAGE_PREFIX,
    INCOGNITO_CONTEXT: INCOGNITO_CONTEXT,
    load: load,
    loadArchivedTopic: loadArchivedTopic,
    save: save,
    ensureState: ensureState,
    mergeDraftState: mergeDraftState,
    createTopic: createTopic,
    setActiveTopic: setActiveTopic,
    setActiveAssistant: setActiveAssistant,
    createAssistant: createAssistant,
    updateAssistant: updateAssistant,
    deleteAssistant: deleteAssistant,
    reorderAssistants: reorderAssistants,
    deleteTopicsByAssistant: deleteTopicsByAssistant,
    updateTopic: updateTopic,
    deleteTopic: deleteTopic,
    archiveTopic: archiveTopic,
    topicLastConversationAt: topicLastConversationAt,
    normalizeTopicContextMeta: normalizeTopicContextMeta,
    updateGeneratedIds: updateGeneratedIds,
    nowId: nowId,
    newCodexUuid: newCodexUuid,
    assistantTemplates: assistantTemplates,
    assistantSnapshot: assistantSnapshot,
    assistantConfigSignature: assistantConfigSignature,
    normalizeAssistantProfile: profileSchema.normalizeProfile,
    mergeAssistantProfile: profileSchema.mergeProfile,
    normalizeAssistantSnapshot: profileSchema.normalizeSnapshot,
    normalizeResourcePolicy: normalizeResourcePolicy,
    createResourcePolicy: createResourcePolicy,
    resourcePolicyCatalog: resourcePolicyCatalog,
    assistantMode: assistantMode,
  };
});
