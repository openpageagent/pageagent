'use strict';

const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { readScreenshot } = require('./screenshot-image');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SCREEN_PIXELS = 20 * 1000 * 1000;
let binding;

function installed() {
  try { require.resolve('robotjs'); return true; } catch (_) { return false; }
}

function robot(permission) {
  if (!binding) {
    try { binding = require('robotjs'); }
    catch (error) { throw new Error('无法加载 robotjs 0.9.1，请安装匹配系统和架构的预编译包：' + error.message); }
    binding.setMouseDelay(0);
    binding.setKeyboardDelay(0);
  }
  if (process.platform === 'darwin') {
    if (permission === 'input' && binding.getAccessibilityPermission() === false) throw new Error('请为启动 MCP Server 的应用授予 macOS 辅助功能权限');
    if (permission === 'screen' && binding.getScreenCapturePermission() === false) throw new Error('请为启动 MCP Server 的应用授予 macOS 屏幕录制权限');
  }
  return binding;
}

function check(signal) {
  if (signal.aborted) throw new Error('桌面操作已取消；已经发生的输入或修改不会撤销');
}

function pause(ms, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('桌面操作已取消')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function contains(display, x, y) {
  return x >= display.x && y >= display.y && x < display.x + display.width && y < display.y + display.height;
}

function checkPoint(api, x, y) {
  if (!api.getDisplays().some(display => contains(display, x, y))) throw new Error('鼠标坐标不在任何显示器范围内');
}

async function move(api, x, y, duration, signal, drag = false) {
  checkPoint(api, x, y);
  const start = api.getMousePos();
  const started = performance.now();
  while (true) {
    check(signal);
    const progress = duration ? Math.min(1, (performance.now() - started) / duration) : 1;
    const eased = progress * progress * (3 - 2 * progress);
    const nextX = Math.round(start.x + (x - start.x) * eased);
    const nextY = Math.round(start.y + (y - start.y) * eased);
    if (drag) api.dragMouse(nextX, nextY);
    else api.moveMouse(nextX, nextY);
    if (progress === 1) break;
    await pause(16, signal);
  }
}

async function mouse(input, signal) {
  const api = robot(input.action === 'position' ? null : 'input');
  check(signal);
  if (input.action === 'position') return Object.assign(api.getMousePos(), { displays: api.getDisplays() });
  const duration = input.durationMs === undefined ? 300 : input.durationMs;
  if (input.action === 'scroll') api.scrollMouse(input.deltaX || 0, input.deltaY);
  else if (input.action === 'drag') {
    checkPoint(api, input.x, input.y);
    await move(api, input.fromX, input.fromY, duration, signal);
    check(signal);
    try {
      api.mouseToggle('down', 'left');
      await move(api, input.x, input.y, duration, signal, true);
    } finally { api.mouseToggle('up', 'left'); }
  } else {
    await move(api, input.x, input.y, duration, signal);
    check(signal);
    if (input.action === 'click') {
      const button = input.button || 'left';
      try { api.mouseClick(button, input.double === true); }
      finally { api.mouseToggle('up', button); }
    }
  }
  check(signal);
  return Object.assign({ action: input.action }, api.getMousePos());
}

async function keyboard(input, signal, clipboard) {
  const api = robot('input');
  const primary = process.platform === 'darwin' ? 'command' : 'control';
  check(signal);
  if (input.action === 'type' && input.mode === 'keys') {
    const characters = Array.from(input.text);
    const interval = input.intervalMs === undefined ? 50 : input.intervalMs;
    if (characters.length * (interval + 5) > 30000) throw new Error('逐字输入预计超过 30 秒，请缩短文本或减小间隔');
    for (let index = 0; index < characters.length; index++) {
      check(signal);
      api.typeString(characters[index]);
      if (index + 1 < characters.length) await pause(interval, signal);
    }
    return { action: 'type', characters: characters.length, clipboardChanged: false };
  }
  const key = input.action === 'type' ? 'v' : input.key.toLowerCase();
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|tab|space|backspace|delete|escape|left|right|up|down|home|end|pageup|pagedown)$/.test(key)) {
    throw new Error('不支持的键名：' + key);
  }
  const names = { primary, command: 'command', ctrl: 'control', alt: 'alt', shift: 'shift' };
  const modifiers = input.action === 'type' ? [primary] : (input.modifiers || []).map(name => names[name]);
  if (new Set(modifiers).size !== modifiers.length) throw new Error('组合键包含重复修饰键');
  if (input.action === 'type') await clipboard({ action: 'write', text: input.text }, signal);
  check(signal);
  try { api.keyTap(key, modifiers); }
  finally { api.keyToggle(key, 'up', modifiers); }
  return { action: input.action, sent: true, clipboardChanged: input.action === 'type' };
}

function captureRegion(input, api) {
  const displays = api.getDisplays();
  const main = displays.find(display => display.isMain);
  const region = input.region || main;
  if (!region || !displays.some(display => contains(display, region.x, region.y)
      && contains(display, region.x + region.width - 1, region.y + region.height - 1))) {
    throw new Error('截图区域必须完全位于同一显示器内');
  }
  if (region.width * region.height > MAX_SCREEN_PIXELS) throw new Error('截图区域超过 2000 万像素，请缩小 region');
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

async function screenshot(input, signal) {
  const format = input.format || 'png';
  if (!['png', 'bmp'].includes(format)) throw new Error('robotjs 截图只支持 PNG 和 BMP');
  const api = robot('screen');
  if (format === 'png' && !api.image.supportsPNG) throw new Error('当前 robotjs 预编译包不支持 PNG');
  const region = captureRegion(input, api);
  check(signal);
  const image = api.screen.capture(region.x, region.y, region.width, region.height);
  if (image.width * image.height > MAX_SCREEN_PIXELS) throw new Error('截图实际像素超过 2000 万，请缩小 region');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'page-agent-screen-'));
  try {
    const file = path.join(directory, 'screen.' + format);
    check(signal);
    if (!image.save(file)) throw new Error('robotjs 无法保存截图');
    const result = await readScreenshot(file, format, signal);
    check(signal);
    return { ...result, region,
      originX: image.screenX === undefined ? region.x : image.screenX,
      originY: image.screenY === undefined ? region.y : image.screenY,
      pixelsPerUnitX: image.scaleX || image.width / region.width, pixelsPerUnitY: image.scaleY || image.height / region.height };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function readTemplate(templatePath, directory, signal) {
  if (templatePath.includes('\0')) throw new Error('模板路径不能包含空字符');
  const file = await fs.realpath(path.resolve(directory, templatePath));
  const relative = path.relative(directory, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('模板图片必须位于配置的工作目录内');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('模板必须是不超过 8MB 的 PNG 文件');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      check(signal);
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('模板文件在读取时发生变化，请重新调用');
    const data = buffer.subarray(0, size);
    if (size < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('模板只支持 PNG');
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!width || !height || width * height > 2000000) throw new Error('模板像素必须为 1 至 200 万');
    return data;
  } finally { await handle.close(); }
}

// Matching is synchronous native work. Reuse the command runner so cancellation/timeout can kill it.
const MATCH_SCRIPT = String.raw`
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const robot = require(input.robotPath);
const region = input.region;
const target = robot.image.load(input.template);
const screen = robot.screen.capture(region.x, region.y, region.width, region.height);
if (screen.width * screen.height > 20000000) throw new Error('截图实际像素超过 2000 万，请缩小 region');
if (target.width > screen.width || target.height > screen.height) throw new Error('模板尺寸大于截图区域');
const point = screen.findImage(target, { tolerance: input.tolerance });
const result = { found: point !== null, tolerance: input.tolerance, region, center: null, bounds: null };
if (point) {
  result.center = screen.toScreenPoint(point, target);
  result.bounds = Object.assign(screen.toScreenPoint(point), {
    width: target.width / (screen.scaleX || 1), height: target.height / (screen.scaleY || 1)
  });
}
process.stdout.write(JSON.stringify(result));
`;

async function locate(input, signal, directory, command) {
  const api = robot('screen');
  if (!api.image.supportsPNG) throw new Error('当前 robotjs 预编译包不支持 PNG');
  const region = captureRegion(input, api);
  const data = await readTemplate(input.templatePath, directory, signal);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'page-agent-locate-'));
  try {
    const template = path.join(temporary, 'template.png');
    await fs.writeFile(template, data, { signal });
    const result = await command(process.execPath, ['-e', MATCH_SCRIPT], signal, JSON.stringify({
      robotPath: require.resolve('robotjs'), template, region, tolerance: input.tolerance === undefined ? 0.1 : input.tolerance,
    }), directory);
    return JSON.parse(result);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { installed, mouse, keyboard, screenshot, locate };
