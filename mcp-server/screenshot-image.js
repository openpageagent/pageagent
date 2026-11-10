'use strict';

const fs = require('fs/promises');
const { LIMITS } = require('../shared/mcp-contract');

function dimensions(data, format) {
  if (format === 'png' && data.length >= 24 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (format === 'gif' && data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (format === 'bmp' && data.length >= 26 && data.toString('ascii', 0, 2) === 'BM') {
    const header = data.readUInt32LE(14);
    if (header === 12) return { width: data.readUInt16LE(18), height: data.readUInt16LE(20) };
    if (header >= 40 && 14 + header <= data.length) return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
  }
  if (format === 'jpeg' && data.length >= 4 && data.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= data.length && data[offset] === 0xff) {
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  throw new Error('截图没有返回有效的 ' + format.toUpperCase() + ' 图像');
}

async function readScreenshot(file, format, signal) {
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('未生成截图；交互选择可能已取消，或系统不支持指定的图像编码格式');
    throw error;
  }
  if (stat.size > LIMITS.imageBytes) throw new Error('截图超过 8MB，请缩小区域或使用更小的图像格式');
  const data = await fs.readFile(file, { signal });
  if (data.length > LIMITS.imageBytes) throw new Error('截图超过 8MB');
  const size = dimensions(data, format);
  if (!(size.width > 0 && size.height > 0) || size.width * size.height > LIMITS.imagePixels) {
    throw new Error('截图实际像素必须为 1 至 2000 万，请缩小区域或降低显示器分辨率');
  }
  return { ...size, format, modelContent: [{ type: 'image', mimeType: 'image/' + format, data: data.toString('base64') }] };
}

module.exports = { readScreenshot };
