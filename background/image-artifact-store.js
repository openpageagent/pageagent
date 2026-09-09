// Persistent binary store for Conversation image inputs. Conversation JSON only keeps artifact URIs.
(function attachImageArtifactStore(root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ImageArtifactStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var API_VERSION = 1;
  var DB_NAME = 'page_agent_image_artifacts';
  var STORE_NAME = 'artifacts';
  var DB_VERSION = 1;
  var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  var MAX_DECODED_PIXELS = 40 * 1000 * 1000;
  var SOFT_TOTAL_BYTES = 256 * 1024 * 1024;
  var MAX_DERIVED_CACHE_BYTES = 64 * 1024 * 1024;
  var ARTIFACT_URI_PATTERN = /^\/image-artifacts\/(img_[A-Za-z0-9._~-]{1,220})$/;

  function ArtifactError(code, message, details) {
    this.name = 'ArtifactError';
    this.code = String(code || 'ARTIFACT_STORE_FAILED');
    this.message = String(message || this.code);
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ArtifactError);
  }
  ArtifactError.prototype = Object.create(Error.prototype);
  ArtifactError.prototype.constructor = ArtifactError;

  function error(code, message, details) {
    return new ArtifactError(code, message, details);
  }

  function artifactId(value) {
    var text = String(value || '').trim();
    var matched = ARTIFACT_URI_PATTERN.exec(text);
    if (matched) return matched[1];
    if (/^img_[A-Za-z0-9._~-]{1,220}$/.test(text)) return text;
    throw error('ARTIFACT_NOT_FOUND', 'Invalid image Artifact URI');
  }

  function artifactUri(id) { return '/image-artifacts/' + artifactId(id); }

  function normalizeMimeType(value) {
    var mimeType = String(value || '').trim().toLowerCase().split(';')[0];
    if (!/^image\/[a-z0-9.+-]+$/.test(mimeType)) {
      throw error('IMAGE_FORMAT_UNSUPPORTED', 'The captured resource is not a supported image MIME type', { mimeType: mimeType });
    }
    return mimeType;
  }

  function uniqueStrings(values) {
    var seen = Object.create(null);
    return (Array.isArray(values) ? values : []).map(function (value) { return String(value || '').trim(); })
      .filter(function (value) {
        if (!value || seen[value]) return false;
        seen[value] = true;
        return true;
      });
  }

  function setTopicBinding(record, topicId, binding) {
    record.topicBindings = record.topicBindings && typeof record.topicBindings === 'object' && !Array.isArray(record.topicBindings)
      ? record.topicBindings : {};
    if (!topicId) return;
    Object.defineProperty(record.topicBindings, String(topicId), {
      value: binding, enumerable: true, configurable: true, writable: true,
    });
  }

  function publicRecord(record, overrides) {
    record = Object.assign({}, record || {}, overrides || {});
    return {
      id: record.id,
      artifactUri: record.artifactUri,
      topicIds: uniqueStrings(record.topicIds),
      topicId: String(record.topicId || record.topicIds && record.topicIds[0] || ''),
      turnId: String(record.turnId || ''),
      sourcePage: record.sourcePage && typeof record.sourcePage === 'object' ? Object.assign({}, record.sourcePage) : null,
      sourceKind: String(record.sourceKind || ''),
      acquisitionSource: String(record.acquisitionSource || ''),
      representation: String(record.representation || ''),
      mimeType: String(record.mimeType || ''),
      byteLength: Math.max(0, Number(record.byteLength) || 0),
      width: Math.max(0, Math.floor(Number(record.width) || 0)),
      height: Math.max(0, Math.floor(Number(record.height) || 0)),
      sha256: String(record.sha256 || ''),
      detail: String(record.detail || 'high'),
      alt: String(record.alt || '').slice(0, 500),
      createdAt: Math.max(0, Number(record.createdAt) || 0),
      lastAccessedAt: Math.max(0, Number(record.lastAccessedAt) || 0),
      expiresAt: Math.max(0, Number(record.expiresAt) || 0),
    };
  }

  function bytesToHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function detectedMimeType(buffer, declared) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && String.fromCharCode.apply(null, bytes.subarray(0, 6)).indexOf('GIF8') === 0) return 'image/gif';
    if (bytes.length >= 12 && String.fromCharCode.apply(null, bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode.apply(null, bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
    if (bytes.length >= 12 && String.fromCharCode.apply(null, bytes.subarray(4, 8)) === 'ftyp') {
      var brand = String.fromCharCode.apply(null, bytes.subarray(8, 12));
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    var prefix = '';
    try { prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^\uFEFF/, '').trimStart(); } catch (_) {}
    if ((declared === 'image/svg+xml' || /^<\?xml\b/i.test(prefix) || /^<svg\b/i.test(prefix))
        && /<svg\b/i.test(prefix.slice(0, 2048))) return 'image/svg+xml';
    return '';
  }

  function encodedDimensions(buffer, mimeType) {
    var bytes = new Uint8Array(buffer || 0);
    mimeType = String(mimeType || '');
    function u16be(offset) { return bytes[offset] << 8 | bytes[offset + 1]; }
    function u16le(offset) { return bytes[offset] | bytes[offset + 1] << 8; }
    function u24le(offset) { return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16; }
    function u32be(offset) {
      return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3])) >>> 0;
    }
    if (mimeType === 'image/png' && bytes.length >= 24) {
      return { width: u32be(16), height: u32be(20) };
    }
    if (mimeType === 'image/gif' && bytes.length >= 10) {
      return { width: u16le(6), height: u16le(8) };
    }
    if (mimeType === 'image/webp' && bytes.length >= 30) {
      var chunk = String.fromCharCode.apply(null, bytes.subarray(12, 16));
      if (chunk === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
      if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
        return {
          width: 1 + (bytes[21] | (bytes[22] & 0x3f) << 8),
          height: 1 + ((bytes[22] >> 6) | bytes[23] << 2 | (bytes[24] & 0x0f) << 10),
        };
      }
      if (chunk === 'VP8 ' && bytes.length >= 30
          && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      }
    }
    if (mimeType === 'image/jpeg' && bytes.length >= 4) {
      var offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        var marker = bytes[offset];
        if (marker === 0xd8 || marker === 0xd9) { offset += 1; continue; }
        if (offset + 2 >= bytes.length) break;
        var length = u16be(offset + 1);
        var isSof = marker >= 0xc0 && marker <= 0xc3
          || marker >= 0xc5 && marker <= 0xc7
          || marker >= 0xc9 && marker <= 0xcb
          || marker >= 0xcd && marker <= 0xcf;
        if (isSof && length >= 7 && offset + 7 < bytes.length) {
          return { width: u16be(offset + 6), height: u16be(offset + 4) };
        }
        if (length < 2) break;
        offset += 1 + length;
      }
    }
    return null;
  }

  function bytesToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    if (typeof btoa === 'function') {
      var chunks = [];
      for (var offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000))));
      }
      return btoa(chunks.join(''));
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    throw error('ARTIFACT_STORE_FAILED', 'No base64 encoder is available');
  }

  function requestValue(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || error('ARTIFACT_STORE_FAILED', 'IndexedDB request failed')); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onabort = transaction.onerror = function () {
        reject(transaction.error || error('ARTIFACT_STORE_FAILED', 'IndexedDB transaction failed'));
      };
    });
  }

  function createStore(options) {
    options = options || {};
    var indexedDb = options.indexedDB === undefined ? root && root.indexedDB : options.indexedDB;
    var cryptoObject = options.crypto || root && root.crypto;
    var runtimeScope = String(options.runtimeScope || '') === 'incognito' ? 'incognito' : 'regular';
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    var maxImageBytes = Math.max(1024, Number(options.maxImageBytes) || MAX_IMAGE_BYTES);
    var softTotalBytes = Math.max(maxImageBytes, Number(options.softTotalBytes) || SOFT_TOTAL_BYTES);
    var memory = options.memory === true || !indexedDb;
    var records = memory ? new Map() : null;
    var dbPromise = null;
    var derivedCache = new Map();
    var derivedCacheBytes = 0;

    function topicBindingKey(topicId) {
      topicId = String(topicId || '').trim();
      return topicId && runtimeScope === 'incognito' ? 'incognito:' + topicId : topicId;
    }

    function publicTopicId(bindingKey) {
      bindingKey = String(bindingKey || '');
      return runtimeScope === 'incognito' && bindingKey.indexOf('incognito:') === 0
        ? bindingKey.slice('incognito:'.length) : bindingKey;
    }

    function topicBindingScope(record, bindingKey) {
      var binding = record && record.topicBindings && record.topicBindings[bindingKey];
      var explicit = String(binding && binding.runtimeScope || '');
      return explicit === 'incognito' ? 'incognito' : 'regular';
    }

    function ownsStoredTopicBinding(record, bindingKey) {
      return !!(bindingKey && record && (record.topicIds || []).indexOf(bindingKey) !== -1
        && topicBindingScope(record, bindingKey) === runtimeScope);
    }

    function ownsTopicBinding(record, topicId) {
      return ownsStoredTopicBinding(record, topicBindingKey(topicId));
    }

    function runtimeBinding(value) {
      return Object.assign({}, value || {}, { runtimeScope: runtimeScope });
    }

    function scopedPublicRecord(record, overrides) {
      var bindingKeys = (record.topicIds || []).filter(function (bindingKey) {
        return ownsStoredTopicBinding(record, bindingKey);
      });
      var requestedBindingKey = topicBindingKey(overrides && overrides.topicId);
      var selectedBindingKey = ownsStoredTopicBinding(record, requestedBindingKey)
        ? requestedBindingKey : bindingKeys[0] || '';
      var binding = selectedBindingKey && record.topicBindings && record.topicBindings[selectedBindingKey] || null;
      var scopedOverrides = Object.assign({}, overrides || {});
      if (!Object.prototype.hasOwnProperty.call(scopedOverrides, 'turnId')) {
        scopedOverrides.turnId = String(binding && binding.turnId || '');
      }
      if (!Object.prototype.hasOwnProperty.call(scopedOverrides, 'sourcePage')) {
        scopedOverrides.sourcePage = binding && Object.prototype.hasOwnProperty.call(binding, 'sourcePage')
          ? binding.sourcePage : null;
      }
      var output = publicRecord(record, scopedOverrides);
      output.topicIds = bindingKeys.map(publicTopicId);
      output.topicId = publicTopicId(selectedBindingKey);
      return output;
    }

    function removeDerivedCacheForId(id) {
      var prefix = String(id || '') + '|';
      derivedCache.forEach(function (value, key) {
        if (key.indexOf(prefix) !== 0) return;
        derivedCache.delete(key);
        derivedCacheBytes -= Number(value && value.memoryBytes) || 0;
      });
      derivedCacheBytes = Math.max(0, derivedCacheBytes);
    }

    function cacheDerived(key, value) {
      if (!value || Number(value.memoryBytes) > MAX_DERIVED_CACHE_BYTES) return;
      if (derivedCache.has(key)) {
        derivedCacheBytes -= Number(derivedCache.get(key).memoryBytes) || 0;
        derivedCache.delete(key);
      }
      derivedCache.set(key, value);
      derivedCacheBytes += Number(value.memoryBytes) || 0;
      while (derivedCacheBytes > MAX_DERIVED_CACHE_BYTES && derivedCache.size) {
        var oldestKey = derivedCache.keys().next().value;
        var oldest = derivedCache.get(oldestKey);
        derivedCache.delete(oldestKey);
        derivedCacheBytes -= Number(oldest && oldest.memoryBytes) || 0;
      }
    }

    function openDb() {
      if (memory) return Promise.resolve(null);
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        var request;
        try { request = indexedDb.open(DB_NAME, DB_VERSION); }
        catch (openError) { reject(openError); return; }
        request.onupgradeneeded = function () {
          var db = request.result;
          var store = db.objectStoreNames.contains(STORE_NAME)
            ? request.transaction.objectStore(STORE_NAME)
            : db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          if (!store.indexNames.contains('topicIds')) store.createIndex('topicIds', 'topicIds', { multiEntry: true });
          if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt');
          if (!store.indexNames.contains('dedupKey')) store.createIndex('dedupKey', 'dedupKey');
        };
        request.onsuccess = function () {
          var db = request.result;
          db.onversionchange = function () { try { db.close(); } catch (_) {} dbPromise = null; };
          resolve(db);
        };
        request.onerror = function () { reject(request.error || error('ARTIFACT_STORE_FAILED', 'Failed to open image Artifact database')); };
        request.onblocked = function () { reject(error('ARTIFACT_STORE_FAILED', 'Image Artifact database upgrade is blocked')); };
      });
      return dbPromise;
    }

    function nextId() {
      if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return 'img_' + cryptoObject.randomUUID();
      return 'img_' + Number(clock()).toString(36) + '_' + Math.random().toString(36).slice(2, 12);
    }

    async function sha256(buffer) {
      if (!cryptoObject || !cryptoObject.subtle || typeof cryptoObject.subtle.digest !== 'function') {
        throw error('ARTIFACT_STORE_FAILED', 'Web Crypto SHA-256 is unavailable');
      }
      return bytesToHex(await cryptoObject.subtle.digest('SHA-256', buffer));
    }

    async function decodedDimensions(blob) {
      if (typeof root.createImageBitmap !== 'function') {
        if (!memory) throw error('IMAGE_FORMAT_UNSUPPORTED', 'The browser image decoder is unavailable');
        return null;
      }
      var bitmap;
      try { bitmap = await root.createImageBitmap(blob); }
      catch (_) { throw error('IMAGE_FORMAT_UNSUPPORTED', 'Image bytes could not be decoded'); }
      try {
        var width = Math.max(0, Math.floor(Number(bitmap.width) || 0));
        var height = Math.max(0, Math.floor(Number(bitmap.height) || 0));
        if (!width || !height) throw error('IMAGE_FORMAT_UNSUPPORTED', 'Decoded image has invalid dimensions');
        if (width * height > MAX_DECODED_PIXELS) {
          throw error('IMAGE_TOO_LARGE', 'Decoded image exceeds the pixel limit', {
            width: width, height: height, maxPixels: MAX_DECODED_PIXELS,
          });
        }
        return { width: width, height: height };
      } finally { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); }
    }

    function verifyEncodedDimensions(buffer, mimeType) {
      var dimensions = encodedDimensions(buffer, mimeType);
      if (!dimensions || !dimensions.width || !dimensions.height) return dimensions;
      if (dimensions.width * dimensions.height > MAX_DECODED_PIXELS) {
        throw error('IMAGE_TOO_LARGE', 'Encoded image dimensions exceed the pixel limit', {
          width: dimensions.width, height: dimensions.height, maxPixels: MAX_DECODED_PIXELS,
        });
      }
      return dimensions;
    }

    function validateBlob(blob, mimeHint) {
      if (!(blob && typeof blob.arrayBuffer === 'function' && typeof blob.size === 'number')) {
        throw error('IMAGE_FORMAT_UNSUPPORTED', 'Image Artifact input must be a Blob');
      }
      if (blob.size <= 0) throw error('IMAGE_FORMAT_UNSUPPORTED', 'Captured image is empty');
      if (blob.size > maxImageBytes) {
        throw error('IMAGE_TOO_LARGE', 'Captured image exceeds the per-image byte limit', {
          byteLength: blob.size, maxBytes: maxImageBytes,
        });
      }
      return normalizeMimeType(blob.type || mimeHint);
    }

    async function findByDedupKey(key) {
      if (memory) {
        var found = null;
        records.forEach(function (record) { if (!found && record.dedupKey === key) found = record; });
        return found;
      }
      var db = await openDb();
      var tx = db.transaction(STORE_NAME, 'readonly');
      return requestValue(tx.objectStore(STORE_NAME).index('dedupKey').get(key));
    }

    async function writeRecord(record) {
      if (memory) { records.set(record.id, record); return; }
      var db = await openDb();
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      await transactionDone(tx);
    }

    async function put(blob, metadata) {
      metadata = metadata || {};
      var declaredMimeType = validateBlob(blob, metadata.mimeType);
      var sourceBuffer = await blob.arrayBuffer();
      var mimeType = detectedMimeType(sourceBuffer, declaredMimeType);
      if (!mimeType) throw error('IMAGE_FORMAT_UNSUPPORTED', 'Image bytes do not match a supported raster or SVG format');
      if (blob.type !== mimeType) blob = blob.slice(0, blob.size, mimeType);
      if (mimeType !== 'image/svg+xml') verifyEncodedDimensions(sourceBuffer, mimeType);
      // SVG is never persisted as executable markup. Rasterize once at the trust
      // boundary so UI display, export, and provider delivery all use safe pixels.
      if (mimeType === 'image/svg+xml') {
        blob = await preparedOutputBlob(blob, 'original');
        validateBlob(blob, blob.type);
        sourceBuffer = await blob.arrayBuffer();
        mimeType = detectedMimeType(sourceBuffer, blob.type);
        if (!mimeType || mimeType === 'image/svg+xml') {
          throw error('IMAGE_FORMAT_UNSUPPORTED', 'SVG could not be safely rasterized');
        }
      }
      var dimensions = await decodedDimensions(blob);
      var digest = await sha256(sourceBuffer);
      var dedupKey = digest + '|' + mimeType;
      var topicId = String(metadata.topicId || '').trim();
      var bindingKey = topicBindingKey(topicId);
      var existing = await findByDedupKey(dedupKey);
      var now = Number(clock()) || Date.now();
      if (existing) {
        existing.topicIds = uniqueStrings((existing.topicIds || []).concat(bindingKey ? [bindingKey] : []));
        setTopicBinding(existing, bindingKey, runtimeBinding({
          sourcePage: metadata.sourcePage && typeof metadata.sourcePage === 'object'
            ? { tabId: Number(metadata.sourcePage.tabId) || 0, origin: String(metadata.sourcePage.origin || '') }
            : null,
          turnId: String(metadata.turnId || ''),
        }));
        existing.lastAccessedAt = now;
        await writeRecord(existing);
        return Object.assign(scopedPublicRecord(existing, Object.assign({}, metadata, {
          mimeType: existing.mimeType,
          byteLength: existing.byteLength,
          width: existing.width,
          height: existing.height,
          sha256: existing.sha256,
        })), { created: false });
      }
      var id = nextId();
      var record = {
        id: id,
        artifactUri: '/image-artifacts/' + id,
        topicIds: bindingKey ? [bindingKey] : [],
        topicBindings: bindingKey ? Object.defineProperty({}, bindingKey, {
          value: runtimeBinding({
            sourcePage: metadata.sourcePage && typeof metadata.sourcePage === 'object'
              ? { tabId: Number(metadata.sourcePage.tabId) || 0, origin: String(metadata.sourcePage.origin || '') }
              : null,
            turnId: String(metadata.turnId || ''),
          }), enumerable: true, configurable: true, writable: true,
        }) : {},
        topicId: bindingKey,
        turnId: String(metadata.turnId || ''),
        sourcePage: metadata.sourcePage && typeof metadata.sourcePage === 'object'
          ? { tabId: Number(metadata.sourcePage.tabId) || 0, origin: String(metadata.sourcePage.origin || '') }
          : null,
        sourceKind: String(metadata.sourceKind || ''),
        acquisitionSource: String(metadata.acquisitionSource || ''),
        representation: String(metadata.representation || ''),
        mimeType: mimeType,
        byteLength: blob.size,
        width: dimensions && dimensions.width || Math.max(0, Math.floor(Number(metadata.width) || 0)),
        height: dimensions && dimensions.height || Math.max(0, Math.floor(Number(metadata.height) || 0)),
        sha256: digest,
        dedupKey: dedupKey,
        detail: String(metadata.detail || 'high'),
        alt: String(metadata.alt || '').slice(0, 500),
        blob: blob,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt: Math.max(0, Number(metadata.expiresAt) || 0),
      };
      await writeRecord(record);
      await gc().catch(function () {});
      return Object.assign(scopedPublicRecord(record), { created: true });
    }

    async function importRecord(blob, metadata, topicId) {
      metadata = metadata || {};
      topicId = String(topicId || metadata.topicId || '').trim();
      var bindingKey = topicBindingKey(topicId);
      var declaredMimeType = validateBlob(blob, metadata.mimeType);
      var sourceBuffer = await blob.arrayBuffer();
      var mimeType = detectedMimeType(sourceBuffer, declaredMimeType);
      if (!mimeType) throw error('IMAGE_FORMAT_UNSUPPORTED', 'Imported Artifact bytes are not a supported image');
      if (mimeType !== declaredMimeType) {
        throw error('ARTIFACT_MIME_MISMATCH', 'Imported Artifact bytes do not match the manifest MIME type', {
          declared: declaredMimeType, detected: mimeType,
        });
      }
      if (blob.type !== mimeType) blob = blob.slice(0, blob.size, mimeType);
      if (mimeType !== 'image/svg+xml') verifyEncodedDimensions(sourceBuffer, mimeType);
      var digest = await sha256(sourceBuffer);
      if (metadata.sha256 && String(metadata.sha256).toLowerCase() !== digest) {
        throw error('ARTIFACT_HASH_MISMATCH', 'Imported Artifact SHA-256 does not match its manifest', {
          expected: String(metadata.sha256), actual: digest,
        });
      }
      if (mimeType === 'image/svg+xml') {
        blob = await preparedOutputBlob(blob, 'original');
        validateBlob(blob, blob.type);
        sourceBuffer = await blob.arrayBuffer();
        mimeType = detectedMimeType(sourceBuffer, blob.type);
        if (!mimeType || mimeType === 'image/svg+xml') {
          throw error('IMAGE_FORMAT_UNSUPPORTED', 'Imported SVG could not be safely rasterized');
        }
        digest = await sha256(sourceBuffer);
      }
      var dimensions = await decodedDimensions(blob);
      var dedupKey = digest + '|' + mimeType;
      var sourceUri = String(metadata.artifactUri || '');
      var deduplicated = await findByDedupKey(dedupKey);
      if (deduplicated) {
        deduplicated.topicIds = uniqueStrings((deduplicated.topicIds || []).concat(bindingKey ? [bindingKey] : []));
        setTopicBinding(deduplicated, bindingKey, runtimeBinding({ sourcePage: null, turnId: String(metadata.turnId || '') }));
        deduplicated.lastAccessedAt = Number(clock()) || Date.now();
        await writeRecord(deduplicated);
        return Object.assign(scopedPublicRecord(deduplicated, { topicId: topicId }), {
          sourceArtifactUri: sourceUri,
          remapped: !!sourceUri && sourceUri !== deduplicated.artifactUri,
        });
      }
      var requestedId = '';
      try { requestedId = artifactId(sourceUri || metadata.id); } catch (_) { requestedId = nextId(); }
      try {
        var occupied = await readRecord(requestedId);
        if (occupied && occupied.sha256 !== digest) requestedId = nextId();
      } catch (readError) {
        if (!readError || readError.code !== 'ARTIFACT_NOT_FOUND') throw readError;
      }
      var now = Number(clock()) || Date.now();
      var record = {
        id: requestedId,
        artifactUri: '/image-artifacts/' + requestedId,
        topicIds: bindingKey ? [bindingKey] : [],
        topicBindings: bindingKey ? Object.defineProperty({}, bindingKey, {
          value: runtimeBinding({ sourcePage: null, turnId: String(metadata.turnId || '') }),
          enumerable: true, configurable: true, writable: true,
        }) : {},
        topicId: bindingKey,
        turnId: String(metadata.turnId || ''),
        sourcePage: null,
        sourceKind: String(metadata.sourceKind || 'imported-conversation-media'),
        acquisitionSource: String(metadata.acquisitionSource || 'imported-artifact'),
        representation: String(metadata.representation || 'original'),
        mimeType: mimeType,
        byteLength: blob.size,
        width: dimensions && dimensions.width || Math.max(0, Math.floor(Number(metadata.width) || 0)),
        height: dimensions && dimensions.height || Math.max(0, Math.floor(Number(metadata.height) || 0)),
        sha256: digest,
        dedupKey: dedupKey,
        detail: String(metadata.detail || 'high'),
        alt: String(metadata.alt || '').slice(0, 500),
        blob: blob,
        createdAt: Math.max(0, Number(metadata.createdAt) || now),
        lastAccessedAt: now,
        expiresAt: 0,
      };
      await writeRecord(record);
      return Object.assign(scopedPublicRecord(record), {
        sourceArtifactUri: sourceUri,
        remapped: !!sourceUri && sourceUri !== record.artifactUri,
      });
    }

    async function readRecord(uriOrId) {
      var id = artifactId(uriOrId);
      var record;
      if (memory) record = records.get(id);
      else {
        var db = await openDb();
        var tx = db.transaction(STORE_NAME, 'readonly');
        record = await requestValue(tx.objectStore(STORE_NAME).get(id));
      }
      if (!record || !record.blob) throw error('ARTIFACT_NOT_FOUND', 'Image Artifact is missing or expired', { artifactUri: '/image-artifacts/' + id });
      return record;
    }

    async function get(uriOrId, metadataOptions) {
      var record = await readRecord(uriOrId);
      return { metadata: scopedPublicRecord(record, metadataOptions), blob: record.blob };
    }

    async function preparedOutputBlob(blob, detail, outputByteLimit) {
      detail = String(detail || 'high').toLowerCase();
      outputByteLimit = Math.max(1024, Math.min(maxImageBytes, Number(outputByteLimit) || maxImageBytes));
      var modelSafeMime = blob.type === 'image/png' || blob.type === 'image/jpeg' || blob.type === 'image/webp';
      var requiresFormatRasterization = !modelSafeMime;
      if (typeof root.createImageBitmap !== 'function' || typeof root.OffscreenCanvas !== 'function') {
        if (requiresFormatRasterization) throw error('IMAGE_FORMAT_UNSUPPORTED', 'This image format requires rasterization, but the image decoder is unavailable');
        return blob;
      }
      var bitmap;
      try { bitmap = await root.createImageBitmap(blob); }
      catch (decodeError) {
        if (blob.type === 'image/svg+xml') throw error('IMAGE_FORMAT_UNSUPPORTED', 'SVG could not be safely rasterized');
        throw error('IMAGE_FORMAT_UNSUPPORTED', 'Image could not be decoded');
      }
      try {
        var maxEdge = detail === 'original' ? 6000 : 2048;
        var scale = Math.min(1, maxEdge / Math.max(1, bitmap.width, bitmap.height), Math.sqrt(MAX_DECODED_PIXELS / Math.max(1, bitmap.width * bitmap.height)));
        if (detail !== 'original') {
          var patches = Math.ceil(bitmap.width / 32) * Math.ceil(bitmap.height / 32);
          if (patches > 2500) scale = Math.min(scale, Math.sqrt(2500 / patches));
          while (Math.ceil(Math.max(1, Math.round(bitmap.width * scale)) / 32)
              * Math.ceil(Math.max(1, Math.round(bitmap.height * scale)) / 32) > 2500) {
            scale *= 0.98;
          }
        }
        // Always re-encode model/display derivatives so EXIF (including GPS),
        // executable SVG, and unsupported animation/container metadata never
        // cross the provider/UI boundary. The raw Artifact remains untouched.
        var outputType = blob.type === 'image/jpeg' ? 'image/jpeg'
          : blob.type === 'image/webp' ? 'image/webp' : 'image/png';
        var quality = detail === 'original' ? 0.94 : 0.88;
        for (var attempt = 0; attempt < 6; attempt += 1) {
          var width = Math.max(1, Math.round(bitmap.width * scale));
          var height = Math.max(1, Math.round(bitmap.height * scale));
          var canvas = new root.OffscreenCanvas(width, height);
          canvas.getContext('2d', { alpha: true }).drawImage(bitmap, 0, 0, width, height);
          var output = await canvas.convertToBlob({ type: outputType, quality: quality });
          if (output && output.size > 0 && output.size <= outputByteLimit) return output;
          if (!output || output.size <= 0) break;
          if (outputType === 'image/png') outputType = 'image/webp';
          quality = Math.max(0.65, quality - 0.06);
          scale = Math.min(scale * 0.85, scale * Math.sqrt(outputByteLimit / output.size) * 0.9);
        }
        throw error('IMAGE_TOO_LARGE', 'Prepared image still exceeds the provider byte limit', { maxBytes: outputByteLimit });
      } catch (prepareError) {
        if (prepareError instanceof ArtifactError) throw prepareError;
        throw error('IMAGE_FORMAT_UNSUPPORTED', 'Image rasterization or encoding failed', {
          reason: String(prepareError && prepareError.message || prepareError).slice(0, 500),
        });
      } finally { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); }
    }

    async function resolveImageArtifact(uriOrId, resolveOptions) {
      var value = await get(uriOrId, { topicId: resolveOptions && resolveOptions.topicId });
      var detail = String(resolveOptions && resolveOptions.detail || 'high').toLowerCase();
      var outputByteLimit = Math.max(1024, Math.min(maxImageBytes,
        Number(resolveOptions && resolveOptions.maxBytes) || maxImageBytes));
      var cacheKey = value.metadata.id + '|' + detail + '|' + outputByteLimit + '|' + value.metadata.sha256;
      var cached = derivedCache.get(cacheKey);
      if (cached) {
        derivedCache.delete(cacheKey);
        derivedCache.set(cacheKey, cached);
        return { dataUrl: cached.dataUrl, mimeType: cached.mimeType, metadata: value.metadata };
      }
      var outputBlob = await preparedOutputBlob(value.blob, detail, outputByteLimit);
      var dataUrl = 'data:' + outputBlob.type + ';base64,' + bytesToBase64(await outputBlob.arrayBuffer());
      cacheDerived(cacheKey, { dataUrl: dataUrl, mimeType: outputBlob.type, memoryBytes: dataUrl.length * 2 });
      return {
        dataUrl: dataUrl,
        mimeType: outputBlob.type,
        metadata: value.metadata,
      };
    }

    async function rawDataUrl(uriOrId) {
      var value = await get(uriOrId);
      return {
        dataUrl: 'data:' + value.metadata.mimeType + ';base64,' + bytesToBase64(await value.blob.arrayBuffer()),
        mimeType: value.metadata.mimeType,
        metadata: value.metadata,
      };
    }

    async function allRecords() {
      if (memory) return Array.from(records.values());
      var db = await openDb();
      var tx = db.transaction(STORE_NAME, 'readonly');
      return requestValue(tx.objectStore(STORE_NAME).getAll());
    }

    async function listByTopic(topicId) {
      topicId = String(topicId || '').trim();
      if (!topicId) return [];
      var bindingKey = topicBindingKey(topicId);
      var values;
      if (memory) values = (await allRecords()).filter(function (record) { return ownsTopicBinding(record, topicId); });
      else {
        var db = await openDb();
        var tx = db.transaction(STORE_NAME, 'readonly');
        values = await requestValue(tx.objectStore(STORE_NAME).index('topicIds').getAll(bindingKey));
        values = values.filter(function (record) { return ownsTopicBinding(record, topicId); });
      }
      return values.map(function (record) {
        return scopedPublicRecord(record, { topicId: topicId });
      }).sort(function (left, right) { return left.createdAt - right.createdAt; });
    }

    async function canAccess(uriOrId, topicId, tabId, origin) {
      topicId = String(topicId || '').trim();
      tabId = Number(tabId) || 0;
      origin = String(origin || '').trim();
      if (!topicId) return false;
      var record = await readRecord(uriOrId);
      if (!ownsTopicBinding(record, topicId)) return false;
      if (!tabId) return true;
      var binding = record.topicBindings && record.topicBindings[topicBindingKey(topicId)];
      var sourcePage = binding && Object.prototype.hasOwnProperty.call(binding, 'sourcePage')
        ? binding.sourcePage : record.sourcePage;
      // Imported conversation media intentionally has no source tab. Its topic
      // binding is still authoritative, so it may render in that topic's page UI.
      if (!sourcePage && binding && binding.sourcePage === null) return true;
      if (Number(sourcePage && sourcePage.tabId || 0) !== tabId) return false;
      if (origin && sourcePage && sourcePage.origin && String(sourcePage.origin) !== origin) return false;
      return true;
    }

    async function deleteRecord(id) {
      id = artifactId(id);
      removeDerivedCacheForId(id);
      if (memory) { records.delete(id); return; }
      var db = await openDb();
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      await transactionDone(tx);
    }

    async function releaseTopic(topicId) {
      topicId = String(topicId || '').trim();
      if (!topicId) return { released: 0, deleted: 0 };
      var bindingKey = topicBindingKey(topicId);
      var values = await allRecords();
      var released = 0;
      var deleted = 0;
      for (var index = 0; index < values.length; index += 1) {
        var record = values[index];
        if (!ownsTopicBinding(record, topicId)) continue;
        released += 1;
        record.topicIds = (record.topicIds || []).filter(function (id) { return id !== bindingKey; });
        if (record.topicBindings && typeof record.topicBindings === 'object') delete record.topicBindings[bindingKey];
        record.topicId = record.topicIds[0] || '';
        if (!record.topicIds.length) { await deleteRecord(record.id); deleted += 1; }
        else await writeRecord(record);
      }
      return { released: released, deleted: deleted };
    }

    async function gc(options) {
      options = options || {};
      var now = Number(clock()) || Date.now();
      var orphanAgeMs = Math.max(0, Number(options.orphanAgeMs) || 7 * 24 * 60 * 60 * 1000);
      var values = await allRecords();
      var deleted = 0;
      for (var index = 0; index < values.length; index += 1) {
        var record = values[index];
        var expired = record.expiresAt > 0 && record.expiresAt <= now;
        var staleOrphan = !(record.topicIds || []).length && Number(record.createdAt || 0) + orphanAgeMs <= now;
        if (expired || staleOrphan) { await deleteRecord(record.id); deleted += 1; }
      }
      values = (await allRecords()).sort(function (left, right) {
        var leftOrphan = (left.topicIds || []).length ? 1 : 0;
        var rightOrphan = (right.topicIds || []).length ? 1 : 0;
        return leftOrphan - rightOrphan || Number(left.lastAccessedAt || 0) - Number(right.lastAccessedAt || 0);
      });
      var total = values.reduce(function (sum, record) { return sum + Number(record.byteLength || 0); }, 0);
      for (var prune = 0; total > softTotalBytes && prune < values.length; prune += 1) {
        if ((values[prune].topicIds || []).length) break;
        await deleteRecord(values[prune].id);
        total -= Number(values[prune].byteLength || 0);
        deleted += 1;
      }
      return { deleted: deleted, totalBytes: Math.max(0, total) };
    }

    async function exportTopic(topicId) {
      var metadata = await listByTopic(topicId);
      var files = [];
      for (var index = 0; index < metadata.length; index += 1) {
        var stored = await get(metadata[index].artifactUri);
        files.push({ metadata: metadata[index], blob: stored.blob });
      }
      return { manifest: metadata, files: files };
    }

    return Object.freeze({
      runtimeScope: runtimeScope,
      put: put,
      importRecord: importRecord,
      get: get,
      resolveImageArtifact: resolveImageArtifact,
      rawDataUrl: rawDataUrl,
      listByTopic: listByTopic,
      canAccess: canAccess,
      releaseTopic: releaseTopic,
      delete: deleteRecord,
      gc: gc,
      exportTopic: exportTopic,
      stats: async function () {
        var values = await allRecords();
        return {
          count: values.length,
          totalBytes: values.reduce(function (sum, record) { return sum + Number(record.byteLength || 0); }, 0),
        };
      },
    });
  }

  return Object.freeze({
    API_VERSION: API_VERSION,
    DB_NAME: DB_NAME,
    STORE_NAME: STORE_NAME,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_DECODED_PIXELS: MAX_DECODED_PIXELS,
    SOFT_TOTAL_BYTES: SOFT_TOTAL_BYTES,
    MAX_DERIVED_CACHE_BYTES: MAX_DERIVED_CACHE_BYTES,
    ArtifactError: ArtifactError,
    artifactId: artifactId,
    artifactUri: artifactUri,
    detectedMimeType: detectedMimeType,
    encodedDimensions: encodedDimensions,
    createStore: createStore,
  });
});
