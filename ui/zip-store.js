// Minimal UTF-8 ZIP writer using the STORE method. No third-party runtime or base64 is needed.
(function attachZipStore(root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.PageAutomationZipStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var crcTable = null;

  function table() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (var index = 0; index < 256; index += 1) {
      var value = index;
      for (var bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
      crcTable[index] = value >>> 0;
    }
    return crcTable;
  }

  function crc32(bytes) {
    var value = 0xffffffff;
    var values = table();
    for (var index = 0; index < bytes.length; index += 1) value = values[(value ^ bytes[index]) & 0xff] ^ value >>> 8;
    return (value ^ 0xffffffff) >>> 0;
  }

  function writer(length) {
    var bytes = new Uint8Array(length);
    var view = new DataView(bytes.buffer);
    return {
      bytes: bytes,
      u16: function (offset, value) { view.setUint16(offset, value, true); },
      u32: function (offset, value) { view.setUint32(offset, value >>> 0, true); },
    };
  }

  function utf8(value) { return new TextEncoder().encode(String(value || '')); }

  function dataBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === 'string') return utf8(value);
    throw new TypeError('ZIP file data must be text, Uint8Array, or ArrayBuffer');
  }

  function dosTime(date) {
    date = date || new Date();
    return ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
  }

  function dosDate(date) {
    date = date || new Date();
    return (((Math.max(1980, date.getFullYear()) - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  }

  function create(files, options) {
    options = options || {};
    var now = options.date || new Date();
    var offset = 0;
    var localParts = [];
    var centralParts = [];
    (Array.isArray(files) ? files : []).forEach(function (file) {
      var name = utf8(file && file.name);
      var data = dataBytes(file && file.data);
      if (!name.length || name.length > 65535) throw new Error('ZIP entry name is invalid');
      var checksum = crc32(data);
      var local = writer(30 + name.length);
      local.u32(0, 0x04034b50);
      local.u16(4, 20);
      local.u16(6, 0x0800);
      local.u16(8, 0);
      local.u16(10, dosTime(now));
      local.u16(12, dosDate(now));
      local.u32(14, checksum);
      local.u32(18, data.length);
      local.u32(22, data.length);
      local.u16(26, name.length);
      local.u16(28, 0);
      local.bytes.set(name, 30);
      localParts.push(local.bytes, data);

      var central = writer(46 + name.length);
      central.u32(0, 0x02014b50);
      central.u16(4, 20);
      central.u16(6, 20);
      central.u16(8, 0x0800);
      central.u16(10, 0);
      central.u16(12, dosTime(now));
      central.u16(14, dosDate(now));
      central.u32(16, checksum);
      central.u32(20, data.length);
      central.u32(24, data.length);
      central.u16(28, name.length);
      central.u16(30, 0);
      central.u16(32, 0);
      central.u16(34, 0);
      central.u16(36, 0);
      central.u32(38, 0);
      central.u32(42, offset);
      central.bytes.set(name, 46);
      centralParts.push(central.bytes);
      offset += local.bytes.length + data.length;
    });
    var centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var end = writer(22);
    end.u32(0, 0x06054b50);
    end.u16(4, 0);
    end.u16(6, 0);
    end.u16(8, centralParts.length);
    end.u16(10, centralParts.length);
    end.u32(12, centralSize);
    end.u32(16, offset);
    end.u16(20, 0);
    return new Blob(localParts.concat(centralParts, [end.bytes]), { type: 'application/zip' });
  }

  async function read(input, options) {
    options = options || {};
    var buffer = input instanceof ArrayBuffer ? input
      : input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        : input && typeof input.arrayBuffer === 'function' ? await input.arrayBuffer() : null;
    if (!buffer) throw new TypeError('ZIP input must be a Blob, ArrayBuffer, or Uint8Array');
    var bytes = new Uint8Array(buffer);
    var view = new DataView(buffer);
    var maximumBytes = Math.max(1024, Number(options.maxBytes) || 256 * 1024 * 1024);
    if (bytes.length > maximumBytes) throw new Error('ZIP archive exceeds the configured byte limit');
    var eocd = -1;
    for (var scan = bytes.length - 22; scan >= Math.max(0, bytes.length - 65557); scan -= 1) {
      if (view.getUint32(scan, true) === 0x06054b50) { eocd = scan; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-directory record is missing');
    var count = view.getUint16(eocd + 10, true);
    var centralOffset = view.getUint32(eocd + 16, true);
    if (count > 1000) throw new Error('ZIP archive contains too many entries');
    var decoder = new TextDecoder('utf-8', { fatal: true });
    var files = [];
    var cursor = centralOffset;
    for (var index = 0; index < count; index += 1) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP central directory is invalid');
      var method = view.getUint16(cursor + 10, true);
      var checksum = view.getUint32(cursor + 16, true);
      var compressedSize = view.getUint32(cursor + 20, true);
      var size = view.getUint32(cursor + 24, true);
      var nameLength = view.getUint16(cursor + 28, true);
      var extraLength = view.getUint16(cursor + 30, true);
      var commentLength = view.getUint16(cursor + 32, true);
      var localOffset = view.getUint32(cursor + 42, true);
      if (method !== 0 || compressedSize !== size) throw new Error('Only uncompressed conversation ZIP entries are supported');
      var name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (!name || name.charAt(0) === '/' || name.split('/').some(function (part) { return part === '..' || !part; })) {
        throw new Error('ZIP entry path is unsafe: ' + name);
      }
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP local entry is invalid');
      var localNameLength = view.getUint16(localOffset + 26, true);
      var localExtraLength = view.getUint16(localOffset + 28, true);
      var start = localOffset + 30 + localNameLength + localExtraLength;
      var end = start + size;
      if (end > bytes.length) throw new Error('ZIP entry exceeds archive bounds: ' + name);
      var data = bytes.slice(start, end);
      if (crc32(data) !== checksum) throw new Error('ZIP entry checksum mismatch: ' + name);
      files.push({ name: name, data: data });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return files;
  }

  return Object.freeze({ API_VERSION: 1, crc32: crc32, create: create, read: read });
});
