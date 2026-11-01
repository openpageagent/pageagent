'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const native = require('./desktop-native.js');
const { terminateChild, observeChild } = require('./execution-control');

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// All connections to this server share the same desktop.
let busy = false;

const MAC_SCRIPT = String.raw`
function run(argv) {
  var input = JSON.parse(argv[0]);
  var system = Application('System Events');
  if (input.operation === 'keyboard') {
    if (input.code !== undefined) system.keyCode(input.code, { using: input.modifiers });
    else system.keystroke(input.key, { using: input.modifiers });
    return JSON.stringify({ action: input.action, sent: true });
  }
  var processes = system.applicationProcesses.whose(input.pid ? { unixId: input.pid } : { backgroundOnly: false })();
  if (input.operation === 'window' && input.action === 'list') {
    var windows = [], skipped = 0, truncated = false;
    for (var p = 0; p < processes.length; p++) {
      try {
        var app = processes[p], pid = app.unixId(), name = app.name(), entries = app.windows();
        for (var w = 0; w < entries.length; w++) {
          var title = entries[w].name() || '';
          if (input.title && title.indexOf(input.title) < 0) continue;
          if (windows.length >= 200) { truncated = true; break; }
          windows.push({ pid: pid, application: name, title: title });
        }
      } catch (error) { skipped++; }
      if (truncated) break;
    }
    return JSON.stringify({ windows: windows, skipped: skipped, truncated: truncated });
  }
  if (processes.length !== 1) throw new Error('应用不存在，请重新获取窗口列表中的 PID');
  var target = processes[0];
  if (input.operation === 'window') {
    var matches = target.windows.whose({ name: input.title })();
    if (matches.length !== 1) throw new Error('窗口标题不存在或不唯一，请重新获取窗口列表');
    var window = matches[0];
    var minimized = window.attributes.byName('AXMinimized');
    var focusedWindow = target.attributes.byName('AXFocusedWindow');
    function isMinimized() { return minimized.exists() && minimized.value() === true; }
    function isActive() {
      if (!target.frontmost() || !focusedWindow.exists()) return false;
      var focused = focusedWindow.value();
      return !!focused && focused.name() === input.title;
    }
    if (input.action === 'activate') {
      target.visible = true;
      if (isMinimized()) minimized.value = false;
      target.frontmost = true;
      window.actions.byName('AXRaise').perform();
      for (var attempt = 0; attempt < 20 && (isMinimized() || !isActive()); attempt++) delay(0.1);
      if (isMinimized() || !isActive()) throw new Error('系统未能恢复并激活指定窗口，请检查桌面和辅助功能权限');
    }
    if ((input.action === 'bounds' || input.action === 'activate') && isMinimized()) {
      throw new Error('窗口已最小化，请先激活窗口再获取边界');
    }
    if (input.action === 'move') window.position = [input.x, input.y];
    else if (input.action === 'resize') window.size = [input.width, input.height];
    var position = window.position(), size = window.size();
    var result = { pid: input.pid, title: input.title, x: position[0], y: position[1], width: size[0], height: size[1] };
    if (input.action === 'bounds' || input.action === 'activate') {
      result.minimized = isMinimized();
      result.active = isActive();
      if (result.minimized || !(result.width > 0 && result.height > 0)) throw new Error('窗口边界不可用，请确认窗口已恢复显示');
      if (input.action === 'activate' && !result.active) throw new Error('指定窗口已失去前台焦点');
    }
    return JSON.stringify(result);
  }
  if (input.action === 'close') {
    var bundleId = target.bundleIdentifier();
    if (!bundleId) throw new Error('无法取得应用标识，未发送退出请求');
    Application(bundleId).quit();
    return JSON.stringify({ pid: input.pid, quitRequested: true });
  }
  if (!target.windows().length) throw new Error('应用没有可打印的窗口');
  target.frontmost = true;
  delay(0.2);
  if (!target.frontmost()) throw new Error('无法激活应用，未发送打印快捷键');
  system.keystroke('p', { using: ['command down'] });
  return JSON.stringify({ pid: input.pid, printDialogRequested: true, printed: false });
}
`;

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.operation -eq 'clipboard') {
  if ($request.action -eq 'read') {
    $result = @{ text = [string](Get-Clipboard -Raw) }
  } else {
    if ($request.action -eq 'clear' -or $request.text -eq '') { Set-Clipboard -Value $null }
    else { Set-Clipboard -Value ([string]$request.text) }
    $result = @{ action = $request.action }
  }
} elseif ($request.operation -eq 'window') {
  if ($request.action -notin @('list', 'activate', 'bounds')) { throw 'Windows 不支持此窗口操作' }
  # Load Windows assemblies only; no source compilation or generated native helper.
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $windowType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $windowPattern = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::IsWindowPatternAvailableProperty, $true)
  $condition = [System.Windows.Automation.OrCondition]::new($windowType, $windowPattern)
  if ($request.pid) {
    $processCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$request.pid)
    $condition = [System.Windows.Automation.AndCondition]::new($condition, $processCondition)
  }
  # A filtered walker includes windows nested under owners or non-window containers.
  # Walk incrementally; never request all desktop descendants in one operation.
  $walker = [System.Windows.Automation.TreeWalker]::new($condition)
  $parents = [System.Collections.Generic.Queue[object]]::new()
  $parents.Enqueue([System.Windows.Automation.AutomationElement]::RootElement)
  $windows = [System.Collections.Generic.List[object]]::new()
  $matches = [System.Collections.Generic.List[object]]::new()
  $applications = @{}
  $visited = 0
  $skipped = 0
  $truncated = $false
  $listing = $request.action -eq 'list'
  while ($parents.Count -gt 0 -and !$truncated -and ($listing -or $matches.Count -lt 2)) {
    try { $candidate = $walker.GetFirstChild($parents.Dequeue()) }
    catch { $skipped++; continue }
    while ($null -ne $candidate) {
      if ($visited -ge 2000) { $truncated = $true; break }
      $visited++
      $parents.Enqueue($candidate)
      try {
        $current = $candidate.Current
        $titleMatches = if ($listing) {
          !$request.title -or $current.Name.Contains([string]$request.title)
        } else { [string]::Equals($current.Name, [string]$request.title, [StringComparison]::Ordinal) }
        if ((!$request.pid -or $current.ProcessId -eq $request.pid) -and $titleMatches) {
          if ($listing) {
            if ($windows.Count -ge 200) { $truncated = $true; break }
            $processId = $current.ProcessId
            if (!$applications.ContainsKey($processId)) {
              try { $applications[$processId] = (Get-Process -Id $processId).ProcessName }
              catch { $applications[$processId] = '' }
            }
            $windows.Add(@{ pid = $processId; application = $applications[$processId]; title = $current.Name })
          } else {
            $matches.Add($candidate)
            if ($matches.Count -ge 2) { break }
          }
        }
      } catch { $skipped++ }
      try { $candidate = $walker.GetNextSibling($candidate) }
      catch { $skipped++; break }
    }
  }
  if ($listing) {
    @{ windows = $windows.ToArray(); truncated = $truncated; skipped = $skipped } | ConvertTo-Json -Compress -Depth 5
    exit
  }
  if ($matches.Count -gt 1) { throw '该 PID 下有多个同标题窗口，无法唯一定位，请使用可区分的窗口标题' }
  if ($truncated -or $skipped -gt 0) { throw '窗口枚举不完整，无法确认目标唯一，请检查应用状态和进程权限后重试' }
  if ($matches.Count -ne 1) { throw '窗口不存在或标题已变化，请重新获取窗口列表' }
  $element = $matches[0]
  $current = $element.Current
  if ($current.ProcessId -ne $request.pid -or ![string]::Equals($current.Name, [string]$request.title, [StringComparison]::Ordinal)) {
    throw '目标窗口已变化，请重新获取窗口列表'
  }
  $pattern = $element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  function Test-WindowFocused($target) {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    for ($depth = 0; $null -ne $focused -and $depth -lt 64; $depth++) {
      if ([System.Windows.Automation.Automation]::Compare($focused, $target)) { return $true }
      # A focused dialog must not make its owner appear to be the active window.
      if ($focused.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -or
          $focused.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsWindowPatternAvailableProperty)) { return $false }
      $focused = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($focused)
    }
    return $false
  }
  if ($request.action -eq 'activate') {
    # Restore minimized owners first, then the requested window/dialog.
    $restore = [System.Collections.Generic.List[object]]::new()
    $ancestor = $element
    for ($depth = 0; $null -ne $ancestor -and $depth -lt 64; $depth++) {
      $ancestorPattern = $null
      if ($ancestor.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$ancestorPattern)) {
        $restore.Add($ancestorPattern)
      }
      $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
    }
    for ($index = $restore.Count - 1; $index -ge 0; $index--) {
      if ($restore[$index].Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
        $restore[$index].SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
      }
    }
    try { $element.SetFocus() } catch { }
    if (!(Test-WindowFocused $element)) {
      $shell = New-Object -ComObject WScript.Shell
      [void]$shell.AppActivate([int]$request.pid)
      # AppActivate selects a process, so always refocus and verify the exact window.
      try { $element.SetFocus() } catch { }
    }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      if ($pattern.Current.WindowVisualState -ne [System.Windows.Automation.WindowVisualState]::Minimized -and (Test-WindowFocused $element)) { break }
      Start-Sleep -Milliseconds 100
    }
  }
  if ($pattern.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
    throw '窗口已最小化，请先激活窗口再获取边界'
  }
  $current = $element.Current
  if ($current.ProcessId -ne $request.pid -or ![string]::Equals($current.Name, [string]$request.title, [StringComparison]::Ordinal)) {
    throw '目标窗口已变化，请重新获取窗口列表'
  }
  if ($current.IsOffscreen) { throw '窗口当前不可见，请先恢复并显示窗口' }
  $rect = $current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw '窗口边界不可用，请确认窗口已恢复显示' }
  $active = Test-WindowFocused $element
  if ($request.action -eq 'activate' -and !$active) { throw '系统未将指定窗口切换到前台，请检查桌面和进程权限' }
  # UI Automation reports physical screen coordinates; no DPI-virtualized Win32 rectangle.
  $left = [Math]::Ceiling($rect.Left)
  $top = [Math]::Ceiling($rect.Top)
  $result = @{ pid = $request.pid; title = $request.title; x = $left; y = $top;
    width = [Math]::Floor($rect.Right) - $left; height = [Math]::Floor($rect.Bottom) - $top; minimized = $false; active = $active }
} else {
  $process = Get-Process -Id $request.pid
  if ($request.action -eq 'print') {
    if ($process.MainWindowHandle -eq 0) { throw '应用没有可打印的主窗口' }
    $shell = New-Object -ComObject WScript.Shell
    if (!$shell.AppActivate([int]$request.pid)) { throw '无法激活应用，未发送打印快捷键' }
    Start-Sleep -Milliseconds 200
    $shell.SendKeys('^p')
    $result = @{ pid = $request.pid; printDialogRequested = $true; printed = $false }
  } else {
    if (!$process.CloseMainWindow()) { throw '应用没有可关闭的主窗口，或系统拒绝关闭请求' }
    $result = @{ pid = $request.pid; closeRequested = $true }
  }
}
$result | ConvertTo-Json -Compress -Depth 5
`;

function checkCancelled(signal) {
  if (signal.aborted) throw new Error('桌面操作已取消；已经发生的输入或修改不会撤销');
}

function capabilities() {
  const supported = {};
  const nativeInstalled = (process.platform === 'darwin' || process.platform === 'win32') && native.installed();
  if (process.platform === 'darwin' || process.platform === 'win32') {
    supported.clipboard = ['read', 'write', 'clear'];
    supported.window = ['list', 'activate', 'bounds'];
    supported.application = ['open', 'close', 'print'];
    if (nativeInstalled) {
      supported.mouse = ['position', 'move', 'click', 'drag', 'scroll'];
      supported.keyboard = ['press', 'hotkey', 'type'];
      supported.screenshot = ['capture'];
      supported.locate = ['match'];
    }
  }
  if (process.platform === 'darwin') {
    supported.keyboard = ['press', 'hotkey', 'type'];
    supported.screenshot = ['capture'];
    supported.window.push('move', 'resize');
  }
  return { platform: process.platform, supported, robotjs: { version: '0.9.1', installed: nativeInstalled },
    unsupported: ['semanticLocate'].concat(process.platform === 'darwin' ? [] : ['windowMove', 'windowResize']),
    requirements: process.platform === 'darwin' ? '鼠标/图片定位需 robotjs；输入/窗口需辅助功能，系统脚本需自动化权限，截图需屏幕录制权限'
      : process.platform === 'win32' ? '鼠标/键盘/截图/图片定位需 robotjs；剪贴板和窗口操作需 Windows PowerShell，窗口查询/激活/边界需系统 UI Automation，需交互式登录桌面'
        : '桌面操作仅支持 macOS 和 Windows',
    permissionsVerified: false };
}

function command(executable, args, signal, input = '', cwd) {
  return new Promise((resolve, reject) => {
    checkCancelled(signal);
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd, windowsHide: true, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'],
      env: process.platform === 'darwin' ? Object.assign({}, process.env, { LC_ALL: 'en_US.UTF-8' }) : process.env });
    observeChild(signal, child);
    const chunks = [], errors = [];
    let bytes = 0, errorBytes = 0, failure;
    const stop = error => {
      failure = failure || error;
      terminateChild(child, signal).catch(() => {});
    };
    const abort = () => stop(new Error('桌面操作已取消；实际结果可能未知，请确认后再重试'));
    const timer = setTimeout(() => stop(new Error('桌面操作超过 30 秒；实际结果可能未知，请确认后再重试')), 30000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(new Error('系统命令输出超过 1MB'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (errorBytes < 8192) errors.push(chunk.subarray(0, 8192 - errorBytes));
      errorBytes += chunk.length;
    });
    child.stdin.on('error', () => {});
    child.once('error', error => { failure = failure || new Error('无法启动系统命令：' + error.message); });
    child.once('close', code => {
      cleanup();
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(Buffer.concat(errors).toString('utf8').trim() || '系统命令失败：' + code)); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function systemOperation(operation, input, signal) {
  const payload = Object.assign({ operation }, input);
  const output = process.platform === 'darwin'
    ? await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, '--', JSON.stringify(payload)], signal)
    : await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], signal, JSON.stringify(payload));
  const result = JSON.parse(output.trim());
  if (operation === 'window' && (input.action === 'activate' || input.action === 'bounds')) {
    if (![result.x, result.y, result.width, result.height].every(Number.isFinite)) throw new Error('系统没有返回有效窗口边界');
    const right = Math.floor(result.x + result.width), bottom = Math.floor(result.y + result.height);
    result.x = Math.ceil(result.x);
    result.y = Math.ceil(result.y);
    result.width = right - result.x;
    result.height = bottom - result.y;
    if (result.width <= 0 || result.height <= 0) throw new Error('窗口没有可用的屏幕区域');
  }
  return result;
}

async function clipboard(input, signal) {
  if (Buffer.byteLength(input.text || '', 'utf8') > MAX_TEXT_BYTES) throw new Error('剪贴板文本超过 64KB UTF-8');
  let result;
  if (process.platform === 'win32') result = await systemOperation('clipboard', input, signal);
  else if (input.action === 'read') result = { text: await command('/usr/bin/pbpaste', [], signal) };
  else {
    await command('/usr/bin/pbcopy', [], signal, input.text || '');
    result = { action: input.action };
  }
  if (Buffer.byteLength(result.text || '', 'utf8') > MAX_TEXT_BYTES) throw new Error('剪贴板文本超过 64KB UTF-8');
  return result;
}

async function keyboard(input, signal) {
  if (native.installed()) return native.keyboard(input, signal, clipboard);
  if (input.mode === 'keys') throw new Error('逐字输入需要安装 robotjs 0.9.1');
  if (input.action === 'type') {
    await clipboard({ action: 'write', text: input.text }, signal);
    await systemOperation('keyboard', { action: 'type', key: 'v', modifiers: ['command down'] }, signal);
    return { action: 'type', clipboardChanged: true, pasteRequested: true };
  }
  const codes = { enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117,
    left: 123, right: 124, down: 125, up: 126 };
  const key = input.key.toLowerCase();
  if (!/^[a-z0-9]$/.test(key) && !Object.prototype.hasOwnProperty.call(codes, key)) throw new Error('不支持的键名：' + input.key);
  const names = { primary: 'command down', command: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down' };
  const modifiers = (input.modifiers || []).map(name => names[name]);
  if (new Set(modifiers).size !== modifiers.length) throw new Error('组合键包含重复修饰键');
  return systemOperation('keyboard', { action: input.action, key, code: codes[key], modifiers }, signal);
}

async function screenshot(input, signal) {
  if (native.installed()) return native.screenshot(input, signal);
  if (input.region) throw new Error('区域截图需要安装 robotjs 0.9.1');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'page-agent-screen-'));
  try {
    const file = path.join(directory, 'screen.png');
    await command('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', file], signal);
    checkCancelled(signal);
    if ((await fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error('截图 PNG 超过 8MB');
    const data = await fs.readFile(file);
    if (data.length > MAX_IMAGE_BYTES || data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error('系统截图没有返回有效的 PNG');
    }
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (width * height > 20000000) throw new Error('截图实际像素超过 2000 万，请安装 robotjs 后使用区域截图');
    return { width, height, coordinateSpace: 'image-pixels',
      modelContent: [{ type: 'image', mimeType: 'image/png', data: data.toString('base64') }] };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function openApplication(input, signal, directory) {
  const application = input.application, args = input.args || [];
  if ([application].concat(args).some(value => value.includes('\0'))) throw new Error('应用路径与参数不能包含空字符');
  if (process.platform === 'darwin') {
    await command('/usr/bin/open', ['-a', application, '--args'].concat(args), signal, '', directory);
  } else if (process.platform === 'win32') {
    if (!/\.(exe|com)$/i.test(application)) throw new Error('Windows 请指定 .exe/.com 可执行程序');
    checkCancelled(signal);
    await new Promise((resolve, reject) => {
      const child = spawn(application, args, { cwd: directory, detached: true, stdio: 'ignore' });
      observeChild(signal, child);
      const abort = () => { terminateChild(child, signal).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', error => { signal.removeEventListener('abort', abort); reject(error); });
      child.once('spawn', () => {
        if (signal.aborted) {
          abort(); child.once('close', () => { signal.removeEventListener('abort', abort); reject(new Error('应用启动已请求取消')); });
        } else { signal.removeEventListener('abort', abort); child.unref(); resolve(); }
      });
    });
  } else throw new Error('桌面操作仅支持 macOS 和 Windows');
  return { application, launchRequested: true };
}

async function executeDesktop(operation, input, signal, directory) {
  checkCancelled(signal);
  if (operation === 'desktop') return capabilities();
  const supported = capabilities().supported[operation];
  if (!supported || !supported.includes(input.action || (operation === 'locate' ? 'match' : 'capture'))) {
    throw new Error('当前平台或已安装的依赖不支持此桌面操作，请先查询 /local/desktop');
  }
  if (busy) throw new Error('桌面正在执行另一个操作，请等待其完成');
  busy = true;
  try {
    let result;
    if (operation === 'clipboard') result = await clipboard(input, signal);
    else if (operation === 'keyboard') result = await keyboard(input, signal);
    else if (operation === 'mouse') result = await native.mouse(input, signal);
    else if (operation === 'screenshot') result = await screenshot(input, signal);
    else if (operation === 'locate') result = await native.locate(input, signal, directory, command);
    else if (operation === 'application' && input.action === 'open') result = await openApplication(input, signal, directory);
    else result = await systemOperation(operation, input, signal);
    checkCancelled(signal);
    return result;
  } finally { busy = false; }
}

module.exports = { executeDesktop, capabilities };
