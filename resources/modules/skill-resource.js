// ARP/1 Skill resources with deterministic progressive disclosure.
(function attachSkillResource(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var support = commonJs ? require('../resource-module-support') : root.ResourceModuleSupport;
  var adapter = commonJs ? require('../resource-module-adapter') : root.ResourceModuleAdapter;
  if (!support || !adapter) throw new Error('SkillResource dependencies are incomplete');
  var api = factory(support, adapter);
  if (commonJs) module.exports = api;
  else root.SkillResource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (support, ResourceModuleAdapter) {
  'use strict';
  var SKILL_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 240 }, name: { type: 'string', minLength: 1, maxLength: 300 },
      description: { type: 'string', maxLength: 10000 }, instructions: { type: 'string', minLength: 1, maxLength: 500000 },
      version: { type: 'string', maxLength: 100 }, source: { type: 'object' },
      resources: { type: 'array', maxItems: 1000, items: true },
      tags: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 200 } },
      enabled: { type: 'boolean' }, archived: { type: 'boolean' },
    },
    required: ['name', 'instructions'], additionalProperties: false,
  });
  var RESOURCE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' },
      version: { type: 'string' }, source: { type: 'object' }, resources: { type: 'array', items: true },
      tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, archived: { type: 'boolean' },
      builtinSkill: { type: 'boolean' }, builtIn: { type: 'boolean' }, protected: { type: 'boolean' },
      managedSkill: { type: 'boolean' }, knowledgeId: { type: 'string' }, resourceCount: { type: 'integer', minimum: 0 },
      href: { type: 'string' }, instructionsHref: { type: 'string' }, resourcesHref: { type: 'string' },
      createdAt: { type: 'number' }, updatedAt: { type: 'number' },
    },
    required: ['id', 'name', 'description', 'instructions', 'version', 'source', 'resources', 'tags', 'enabled', 'archived'],
    additionalProperties: false,
  });
  var SUMMARY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' },
      source: { type: 'object' }, resources: { type: 'array', items: true }, resourceCount: { type: 'integer', minimum: 0 },
      tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, archived: { type: 'boolean' },
      builtinSkill: { type: 'boolean' }, builtIn: { type: 'boolean' }, protected: { type: 'boolean' }, managedSkill: { type: 'boolean' },
      knowledgeId: { type: 'string' }, href: { type: 'string' }, instructionsHref: { type: 'string' }, resourcesHref: { type: 'string' },
      createdAt: { type: 'number' }, updatedAt: { type: 'number' },
    },
    required: ['id', 'name', 'description', 'version', 'source', 'resourceCount', 'tags', 'enabled', 'archived', 'href', 'instructionsHref', 'resourcesHref'],
    additionalProperties: false,
  });
  var COLLECTION_SCHEMA = Object.freeze({
    type: 'object', properties: { items: { type: 'array', items: SUMMARY_SCHEMA }, total: { type: 'integer', minimum: 0 }, nextCursor: { type: 'string' } },
    required: ['items', 'total'], additionalProperties: false,
  });
  var INSTRUCTIONS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      skillId: { type: 'string' }, mediaType: { type: 'string' }, content: { type: 'string' },
      href: { type: 'string' }, resourcesHref: { type: 'string' },
    },
    required: ['skillId', 'mediaType', 'content', 'href', 'resourcesHref'], additionalProperties: false,
  });
  var BUNDLED_RESOURCE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string' }, skillId: { type: 'string' }, path: { type: 'string' }, kind: { type: 'string' },
      mediaType: { type: 'string' }, href: { type: 'string' }, sourceUri: { type: 'string' }, summary: { type: 'string' },
      content: { type: 'string' }, text: { type: 'string' }, markdown: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' },
    },
    required: ['id', 'skillId', 'path', 'kind', 'mediaType', 'href', 'content'], additionalProperties: true,
  });
  var RESOURCE_COLLECTION_SCHEMA = Object.freeze({
    type: 'object', properties: { items: { type: 'array', items: true }, total: { type: 'integer', minimum: 0 }, nextCursor: { type: 'string' } },
    required: ['items', 'total'], additionalProperties: false,
  });
  var SKILL_PATCH_PROPERTIES = Object.freeze({
    name: SKILL_SCHEMA.properties.name,
    description: SKILL_SCHEMA.properties.description,
    instructions: SKILL_SCHEMA.properties.instructions,
    version: SKILL_SCHEMA.properties.version,
    source: SKILL_SCHEMA.properties.source,
    resources: SKILL_SCHEMA.properties.resources,
    tags: SKILL_SCHEMA.properties.tags,
    enabled: SKILL_SCHEMA.properties.enabled,
    archived: SKILL_SCHEMA.properties.archived,
  });
  var PATCH_SCHEMA = Object.freeze({
    type: 'object', properties: SKILL_PATCH_PROPERTIES, minProperties: 1, additionalProperties: false,
  });
  var SKILLS_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      q: { type: 'string', maxLength: 1000 },
      includeDisabled: { type: 'boolean' },
      includeArchived: { type: 'boolean' },
    },
    additionalProperties: false,
  });
  var SKILL_RESOURCES_QUERY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      q: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  });
  var DELETED_SCHEMA = Object.freeze({
    type: 'object', properties: { id: { type: 'string' }, deleted: { const: true } },
    required: ['id', 'deleted'], additionalProperties: true,
  });
  var ROUTES = Object.freeze([
    support.route({
      template: '/skills', resourceType: 'SkillCollection', relation: 'skills',
      summary: '列出或创建按需披露内容的用户 Skill', aliases: ['技能'], tags: ['skill', 'knowledge'],
      entryWeights: { global: 25, conversation: 25 },
      methods: {
        GET: support.read(SKILLS_QUERY_SCHEMA, 'skills.read', 'skills', '列出 Skill 摘要', COLLECTION_SCHEMA),
        POST: support.create(SKILL_SCHEMA, 'skills.write', 'skills', '创建一个用户 Skill', { outputSchema: RESOURCE_SCHEMA }),
      },
    }),
    support.route({
      template: '/skills/{skillId}', resourceType: 'Skill', relation: 'skill',
      summary: '读取、修改、归档或删除一个用户 Skill', aliases: ['技能详情'], tags: ['skill', 'knowledge'],
      entryWeights: { global: 25, conversation: 25 },
      methods: {
        GET: support.read(support.EMPTY_QUERY, 'skills.read', 'skill', '读取一个 Skill 及其直接内容链接', RESOURCE_SCHEMA),
        PATCH: support.patch('skills.write', 'skill', '局部修改或归档一个用户 Skill；内置 Skill 只读', PATCH_SCHEMA, RESOURCE_SCHEMA),
        DELETE: support.remove('skills.delete', 'skill', '删除一个用户 Skill；内置 Skill 会被拒绝', DELETED_SCHEMA),
      },
    }),
    support.route({
      template: '/skills/{skillId}/instructions', resourceType: 'SkillInstructions', relation: 'skill-instructions',
      summary: '读取完整的 Skill 指令', aliases: ['技能正文', 'SKILL.md'], tags: ['skill', 'instructions'],
      entryWeights: { global: 30, conversation: 30 },
      methods: { GET: support.read(support.EMPTY_QUERY, 'skills.read', 'skill-instructions', '读取完整的 Skill 指令正文', INSTRUCTIONS_SCHEMA, {
        modelProjection: { type: 'field', field: 'content' },
      }) },
    }),
    support.route({
      template: '/skills/{skillId}/resources', resourceType: 'SkillResourceCollection', relation: 'skill-resources',
      summary: '列出一个 Skill 随附的可读资源', aliases: ['技能资源'], tags: ['skill', 'resource'],
      entryWeights: { global: 25, conversation: 25 },
      methods: { GET: support.read(SKILL_RESOURCES_QUERY_SCHEMA, 'skills.read', 'skill-resources', '列出可读的 Skill 资源链接', RESOURCE_COLLECTION_SCHEMA) },
    }),
    support.route({
      template: '/skills/{skillId}/resources/{resourceId}', resourceType: 'SkillResource', relation: 'skill-resource',
      summary: '读取一个 Skill 随附的文本资源', aliases: ['技能资源正文'], tags: ['skill', 'resource'],
      entryWeights: { global: 25, conversation: 25 },
      methods: { GET: support.read(support.EMPTY_QUERY, 'skills.read', 'skill-resource', '读取完整的 Skill 资源正文', BUNDLED_RESOURCE_SCHEMA, {
        modelProjection: { type: 'field', field: 'content' },
      }) },
    }),
  ]);

  function skillLinks(uri) {
    return [
      { rel: 'self', href: uri, method: 'GET' },
      { rel: 'instructions', href: uri + '/instructions', method: 'GET' },
      { rel: 'resources', href: uri + '/resources', method: 'GET' },
      { rel: 'capabilities', href: uri, method: 'OPTIONS' },
    ];
  }
  function create(options) {
    options = options || {};
    var service = support.injectedService(options, 'resourceService', 'SkillResource');
    var handlers = { GET: {}, POST: {}, PUT: {}, PATCH: {}, DELETE: {} };
    handlers.GET['/skills'] = function (request) { return service.listSkills(request.query).then(function (data) { return support.result(request.uri, 'SkillCollection', data, service); }); };
    handlers.GET['/skills/{skillId}'] = function (request) { return service.getSkill(request.params.skillId).then(function (data) { return support.result(request.uri, 'Skill', data, service, 200, skillLinks(request.uri)); }); };
    handlers.GET['/skills/{skillId}/instructions'] = function (request) { return service.getSkillInstructions(request.params.skillId).then(function (data) { return support.result(request.uri, 'SkillInstructions', data, service); }); };
    handlers.GET['/skills/{skillId}/resources'] = function (request) { return service.listSkillResources(request.params.skillId, request.query).then(function (data) { return support.result(request.uri, 'SkillResourceCollection', data, service); }); };
    handlers.GET['/skills/{skillId}/resources/{resourceId}'] = function (request) { return service.getSkillResource(request.params.skillId, request.params.resourceId).then(function (data) { return support.result(request.uri, 'SkillResource', data, service); }); };
    handlers.POST['/skills'] = function (request) { return service.createSkill(request.body).then(function (data) { return support.result('/skills/' + support.segment(data.id), 'Skill', data, service, 201, skillLinks('/skills/' + support.segment(data.id))); }); };
    handlers.PATCH['/skills/{skillId}'] = function (request) { return service.patchSkill(request.params.skillId, request.patch).then(function (data) { return support.result(request.uri, 'Skill', data, service, 200, skillLinks(request.uri)); }); };
    handlers.DELETE['/skills/{skillId}'] = function (request) { return service.deleteSkill(request.params.skillId).then(function (data) { return support.result(request.uri, 'DeletedResource', data, service); }); };
    return { service: service, routeContracts: ROUTES, handlers: handlers, preconditionState: service.preconditionState };
  }
  function createAdapter(options) { return ResourceModuleAdapter.create({ root: 'skills', resource: create(options) }); }
  return Object.freeze({ API_VERSION: 1, ROUTE_CONTRACTS: ROUTES, create: create, createAdapter: createAdapter });
});
