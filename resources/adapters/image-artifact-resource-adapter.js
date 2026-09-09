// ARP/1 adapter for dereferencing protected ImageArtifact resources.
(function attachImageArtifactResourceAdapter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../../resources/protocol/index.js') : root.AgentResourceProtocol;
  var api = factory(core);
  if (commonJs) module.exports = api;
  else if (root) root.ImageArtifactResourceAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  if (!core) throw new Error('ImageArtifactResourceAdapter requires AgentResourceProtocol');

  // Match the ImageArtifact store's existing per-image boundary. The MCP
  // WebSocket transport is sized separately to carry the base64 expansion and
  // ARP envelope without forcing an additional screenshot compression policy.
  var MAX_TRANSPORT_IMAGE_BYTES = 20 * 1024 * 1024;
  var MAX_BASE64_CHARS = Math.ceil(MAX_TRANSPORT_IMAGE_BYTES * 4 / 3) + 16;

  var IMAGE_CONTENT_SCHEMA = {
    type: 'object',
    properties: {
      type: { const: 'image' },
      data: { type: 'string', minLength: 1, maxLength: MAX_BASE64_CHARS },
      mimeType: { type: 'string', pattern: '^image/[A-Za-z0-9.+-]+$' },
      detail: { type: 'string', enum: ['high', 'original'] },
      alt: { type: 'string', maxLength: 500 },
    },
    required: ['type', 'data', 'mimeType'],
    additionalProperties: true,
  };

  var IMAGE_ARTIFACT_CONTENT_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      artifactUri: { type: 'string' },
      mimeType: { type: 'string' },
      byteLength: { type: 'number', minimum: 0 },
      transferredByteLength: { type: 'number', minimum: 0 },
      width: { type: 'number', minimum: 0 },
      height: { type: 'number', minimum: 0 },
      representation: { type: 'string' },
      sourceKind: { type: 'string' },
      acquisitionSource: { type: 'string' },
      sha256: { type: 'string' },
      detail: { type: 'string', enum: ['high', 'original'] },
      modelContent: { type: 'array', minItems: 1, maxItems: 1, items: IMAGE_CONTENT_SCHEMA },
    },
    required: ['id', 'artifactUri', 'mimeType', 'byteLength', 'transferredByteLength', 'detail', 'modelContent'],
    additionalProperties: true,
  };

  function transferredByteLength(base64) {
    var padding = /==$/.test(base64) ? 2 : (/=$/.test(base64) ? 1 : 0);
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  }

  function inlineImageData(resolved, detail) {
    var dataUrl = String(resolved && resolved.dataUrl || '');
    var matched = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!matched) {
      throw core.arpError('INTERNAL_ERROR', 'Image Artifact resolver returned an invalid data URL');
    }
    var mimeType = String(resolved.mimeType || matched[1]).toLowerCase();
    if (mimeType !== matched[1].toLowerCase()) {
      throw core.arpError('INTERNAL_ERROR', 'Image Artifact MIME type does not match its encoded bytes');
    }
    return {
      type: 'image',
      data: matched[2],
      mimeType: mimeType,
      detail: detail,
      alt: String(resolved.metadata && resolved.metadata.alt || '').slice(0, 500),
    };
  }

  function translateError(error) {
    var code = String(error && error.code || '');
    if (code === 'ARTIFACT_NOT_FOUND') {
      return core.arpError('RESOURCE_GONE', 'Image Artifact is missing or expired', {
        details: error && error.details,
      });
    }
    if (code === 'IMAGE_TOO_LARGE') {
      return core.arpError('SCHEMA_VALIDATION_FAILED', 'Image Artifact cannot fit the MCP transport limit', {
        details: error && error.details,
      });
    }
    if (code === 'IMAGE_FORMAT_UNSUPPORTED') {
      return core.arpError('UPSTREAM_FAILED', 'Image Artifact cannot be decoded for MCP delivery', {
        details: error && error.details,
      });
    }
    if (code === 'ARTIFACT_ACCESS_DENIED') {
      return core.arpError('FORBIDDEN', 'Image Artifact is not linked to the current Conversation', {
        details: error && error.details,
      });
    }
    return error instanceof core.ArpError ? error : core.arpError('INTERNAL_ERROR', 'Image Artifact resolution failed', {
      details: { cause: String(error && error.message || error || 'unknown error').slice(0, 500) },
    });
  }

  function routeContracts() {
    return [
      new core.RouteContract({
        template: '/image-artifacts/{artifactId}',
        resourceType: 'ImageArtifactContent',
        relation: 'image-artifact-content',
        summary: '读取已创建 ImageArtifact 的受限图像字节',
        aliases: ['read screenshot bytes', 'view image artifact', 'download captured image'],
        tags: ['image', 'artifact', 'screenshot', 'vision'],
        methods: {
          GET: {
            inputSchema: {
              type: 'object',
              properties: {
                detail: { type: 'string', enum: ['auto', 'high', 'original'] },
                maxBytes: { type: 'integer', minimum: 1024, maximum: MAX_TRANSPORT_IMAGE_BYTES },
              },
              additionalProperties: false,
            },
            outputSchema: IMAGE_ARTIFACT_CONTENT_SCHEMA,
            safety: 'read',
            idempotency: 'inherent',
            execution: 'sync',
            permissions: ['page.read'],
            preconditions: [],
            relation: 'read-image-artifact',
            summary: '读取 ImageArtifact，并作为标准 MCP image 内容返回',
            guidance: [
              '先通过页面截图或页面媒体资源创建 ImageArtifact，再读取其返回的 artifactUri。',
              '图像字节只用于当前 MCP 响应；文本投影不会重复暴露 Base64。',
            ],
          },
        },
      }),
    ];
  }

  function createImageArtifactResourceAdapter(options) {
    options = options || {};
    var store = options.imageArtifactStore;
    if (!store || typeof store.resolveImageArtifact !== 'function' || typeof store.canAccess !== 'function') {
      throw new Error('ImageArtifactResourceAdapter requires imageArtifactStore.resolveImageArtifact and canAccess');
    }

    function get(context, request) {
      var query = request.query || {};
      var detail = String(query.detail || 'high').toLowerCase();
      if (detail === 'auto') detail = 'high';
      var maxBytes = Math.max(1024, Math.min(
        MAX_TRANSPORT_IMAGE_BYTES,
        Number(query.maxBytes) || MAX_TRANSPORT_IMAGE_BYTES
      ));
      var uri = String(request.uri || '');
      var topicId = String(context && (context.conversationId || context.topicId) || '').trim();
      var access = topicId ? Promise.resolve(store.canAccess(uri, topicId, 0)) : Promise.resolve(true);
      return access.then(function (allowed) {
        if (!allowed) {
          var denied = new Error('Image Artifact is not linked to the current Conversation');
          denied.code = 'ARTIFACT_ACCESS_DENIED';
          throw denied;
        }
        return store.resolveImageArtifact(uri, { detail: detail, maxBytes: maxBytes, topicId: topicId });
      }).then(function (resolved) {
        var metadata = resolved.metadata || {};
        var imageContent = inlineImageData(resolved, detail);
        var data = Object.assign({}, metadata, {
          id: String(metadata.id || request.params.artifactId || ''),
          artifactUri: String(metadata.artifactUri || uri),
          mimeType: imageContent.mimeType,
          transferredByteLength: transferredByteLength(imageContent.data),
          detail: detail,
          modelContent: [imageContent],
        });
        return {
          primary: {
            uri: uri,
            type: 'ImageArtifactContent',
            data: data,
            links: [{ rel: 'self', href: uri, method: 'GET' }],
          },
          schemaValue: data,
        };
      }).catch(function (error) { throw translateError(error); });
    }

    return core.defineAdapter({
      root: 'image-artifacts',
      routeContracts: routeContracts(),
      get: get,
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    MAX_TRANSPORT_IMAGE_BYTES: MAX_TRANSPORT_IMAGE_BYTES,
    routeContracts: routeContracts,
    createAdapter: createImageArtifactResourceAdapter,
    createImageArtifactResourceAdapter: createImageArtifactResourceAdapter,
  });
});
