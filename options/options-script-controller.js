// Script list/editor state, persistence, dependency checks, and test execution for options.html.
(function attachOptionsScriptController(root, factory) {
  'use strict';

  function isApi(value) {
    return !!(value && typeof value.create === 'function');
  }

  var commonJs = typeof module === 'object' && module.exports;
  var existing = root && root.OptionsScriptController;
  if (isApi(existing)) {
    if (commonJs) module.exports = existing;
    return;
  }

  var lifecycleApi = root && root.PageAutomationLifecycle;
  if (commonJs && !lifecycleApi) lifecycleApi = require('../ui/lifecycle.js');
  var api = factory(lifecycleApi);
  if (commonJs) module.exports = api;
  if (root) root.OptionsScriptController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LifecycleApi) {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error('OptionsScriptController missing dependency: ' + name);
    return value;
  }

  var UNSAFE_KEYS = Object.create(null);
  UNSAFE_KEYS.__proto__ = true;
  UNSAFE_KEYS.prototype = true;
  UNSAFE_KEYS.constructor = true;

  function isSafeKey(value) {
    return typeof value === 'string' && !UNSAFE_KEYS[value];
  }

  function isSafeId(value) {
    return isSafeKey(value) && value.length > 0;
  }

  function ownDataValue(value, key) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  }

  function cloneData(value, ancestors, path) {
    path = path || '$';
    if (value === null || value === undefined) return value;
    var valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType !== 'object') throw new TypeError('脚本数据包含不支持的字段: ' + path);
    ancestors = ancestors || [];
    if (ancestors.indexOf(value) !== -1) throw new TypeError('脚本数据包含循环引用: ' + path);
    var nextAncestors = ancestors.concat([value]);
    if (Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
        throw new TypeError('脚本数据禁止自定义 toJSON: ' + path);
      }
      var array = new Array(value.length);
      for (var index = 0; index < value.length; index++) {
        var arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!arrayDescriptor) {
          array[index] = null;
          continue;
        }
        if (arrayDescriptor.get || arrayDescriptor.set
            || !Object.prototype.hasOwnProperty.call(arrayDescriptor, 'value')) {
          throw new TypeError('脚本数据禁止访问器字段: ' + path + '[' + index + ']');
        }
        array[index] = arrayDescriptor.value === undefined
          ? null
          : cloneData(arrayDescriptor.value, nextAncestors, path + '[' + index + ']');
      }
      return array;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
      throw new TypeError('脚本数据禁止自定义 toJSON: ' + path);
    }
    var output = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!isSafeKey(key)) return;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError('脚本数据禁止访问器字段: ' + path + '.' + key);
      }
      if (descriptor.value === undefined || typeof descriptor.value === 'function'
          || typeof descriptor.value === 'symbol') return;
      Object.defineProperty(output, key, {
        value: cloneData(descriptor.value, nextAncestors, path + '.' + key),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    return output;
  }

  function errorText(error, fallback) {
    var ownMessage = ownDataValue(error, 'message');
    var message = ownMessage !== undefined ? ownMessage : error;
    if (message === undefined || message === null || message === '') return fallback || '未知错误';
    try {
      return String(message);
    } catch (_) {
      return fallback || '未知错误';
    }
  }

  function formatTestResult(value) {
    try {
      var serialized = JSON.stringify(cloneData(value), null, 2);
      return serialized === undefined ? 'undefined' : serialized;
    } catch (error) {
      return '[返回值无法序列化: ' + errorText(error, '未知错误') + ']';
    }
  }

  function create(options) {
    options = options || {};
    var lifecycleFactory = options.lifecycleApi || LifecycleApi;
    if (!lifecycleFactory || typeof lifecycleFactory.create !== 'function') {
      throw new Error('PageAutomationLifecycle must load before OptionsScriptController');
    }

    var window = options.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    var lifecycle = options.lifecycle || lifecycleFactory.create(window);
    var $ = requireFunction(options.$, '$');
    var esc = requireFunction(options.esc, 'esc');
    var getConfig = requireFunction(options.getConfig, 'getConfig');
    var mutateConfig = requireFunction(options.mutateConfig, 'mutateConfig');
    var executeScript = requireFunction(options.executeScript, 'executeScript');
    var userConfigValues = requireFunction(options.userConfigValues, 'userConfigValues');
    var renderConfigListItems = requireFunction(options.renderConfigListItems, 'renderConfigListItems');
    var resetConfigListPage = requireFunction(options.resetConfigListPage, 'resetConfigListPage');
    var itemIdHtml = requireFunction(options.itemIdHtml, 'itemIdHtml');
    var fmtTime = requireFunction(options.fmtTime, 'fmtTime');
    var scrollOpenedEditor = requireFunction(options.scrollOpenedEditor, 'scrollOpenedEditor');
    var toast = requireFunction(options.toast, 'toast');
    var confirmAction = requireFunction(options.confirm, 'confirm');
    var isActive = requireFunction(options.isActive, 'isActive');

    var initialized = false;
    var destroyed = false;
    var draft = null;
    var draftRevision = 0;
    var codeRevision = 0;
    var saveInFlight = null;
    var saveRevision = -1;
    var saveTargetId = '';
    var testInFlight = null;
    var testSequence = 0;
    var deleteInFlight = Object.create(null);

    function currentConfig() {
      var config = getConfig();
      return config && typeof config === 'object' ? config : {};
    }

    function findScript(scriptId) {
      var scripts = ownDataValue(currentConfig(), 'scripts');
      if (!isSafeId(scriptId) || !scripts || typeof scripts !== 'object') return null;
      var descriptor = Object.getOwnPropertyDescriptor(scripts, scriptId);
      if (!descriptor || descriptor.get || descriptor.set
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      var script = cloneData(descriptor.value);
      if (!script || typeof script !== 'object' || Array.isArray(script)) {
        throw new TypeError('脚本配置必须是对象');
      }
      return script;
    }

    function render() {
      if (destroyed) return { ok: false, destroyed: true };
      var list = $('#scripts-list');
      if (!list) return { ok: false, error: '脚本列表不存在' };
      var scripts = userConfigValues('scripts');
      if (!Array.isArray(scripts)) scripts = [];
      list.innerHTML = renderConfigListItems('scripts', scripts, '<div class="placeholder">还没有脚本，点击「新建脚本」开始</div>', function (script) {
        var code = script && script.code;
        var lines = String(code === undefined || code === null ? '' : code).split('\n').length;
        return '<div class="item-card' + (draft && draft.id === script.id ? ' selected' : '') + '" data-action="edit-script" data-id="' + esc(script.id) + '">'
          + '<span class="item-title">' + esc(script.label || '(未命名)') + '</span>'
          + '<span class="item-sub">' + lines + ' 行 · 更新于 ' + fmtTime(script.updatedAt) + '</span>'
          + itemIdHtml(script.id)
          + '</div>';
      });
      renderEditor();
      return { ok: true, draftOpen: !!draft };
    }

    function renderEditor() {
      var editor = $('#script-editor');
      if (!editor) return;
      if (!draft) {
        editor.classList.add('hidden');
        editor.innerHTML = '';
        return;
      }
      editor.classList.remove('hidden');
      editor.innerHTML =
        '<h3>' + (draft.id ? '编辑脚本' : '新建脚本') + '</h3>'
        + '<div class="form-row"><label>脚本名称</label><input type="text" id="script-label" value="' + esc(draft.label) + '" placeholder="如：表格数据清洗"></div>'
        + '<div class="form-row"><label>脚本代码（顶层支持 await；return 的值作为节点输出）</label>'
        + '<textarea id="script-code" class="code" spellcheck="false" placeholder="const t = await ctx.get(\'orders\');\nawait log(\'共 \' + t.rowCount + \' 行\');\nreturn t.rows.filter(r => r[\'状态\'] === \'待处理\');">' + esc(draft.code) + '</textarea></div>'
        + '<div class="editor-actions">'
        + '<button class="btn-primary" data-action="save-script">保存</button>'
        + '<button class="btn-secondary" data-action="test-script">保存并运行</button>'
        + '<button class="btn-secondary" data-action="cancel-script">取消</button>'
        + '<span class="spacer"></span>'
        + (draft.id ? '<button class="btn-danger" data-action="delete-script" data-id="' + esc(draft.id) + '">删除</button>' : '')
        + '</div>'
        + '<div id="script-test-result" class="test-result hidden"></div>';
    }

    function clearTestResult() {
      var resultElement = $('#script-test-result');
      if (!resultElement) return;
      resultElement.classList.add('hidden');
      resultElement.classList.remove('error');
      resultElement.textContent = '';
    }

    function updateDraftField(field, value) {
      if (!draft || draft[field] === value) return false;
      draft[field] = value;
      draftRevision++;
      if (field === 'code') {
        codeRevision++;
        testSequence++;
        clearTestResult();
      }
      return true;
    }

    function syncDraftFromEditor() {
      if (!draft) return false;
      var labelElement = $('#script-label');
      var codeElement = $('#script-code');
      if (!labelElement || !codeElement) return false;
      var changed = false;
      var codeChanged = false;
      if (draft.label !== labelElement.value) {
        draft.label = labelElement.value;
        changed = true;
      }
      if (draft.code !== codeElement.value) {
        draft.code = codeElement.value;
        changed = true;
        codeChanged = true;
      }
      if (changed) draftRevision++;
      if (codeChanged) {
        codeRevision++;
        testSequence++;
        clearTestResult();
      }
      return true;
    }

    function handleEditorInput(event) {
      if (destroyed || !draft || !event || !event.target) return;
      if (event.target.id === 'script-label') updateDraftField('label', event.target.value);
      else if (event.target.id === 'script-code') updateDraftField('code', event.target.value);
    }

    function handleEditorKeydown(event) {
      if (destroyed || !draft || !event || !event.target
          || event.target.id !== 'script-code' || event.key !== 'Tab') return;
      event.preventDefault();
      var codeElement = event.target;
      var start = codeElement.selectionStart;
      var end = codeElement.selectionEnd;
      codeElement.value = codeElement.value.slice(0, start) + '  ' + codeElement.value.slice(end);
      codeElement.selectionStart = codeElement.selectionEnd = start + 2;
      updateDraftField('code', codeElement.value);
    }

    function openNew() {
      if (destroyed) return { ok: false, destroyed: true };
      draft = { label: '', code: '' };
      draftRevision++;
      codeRevision++;
      testSequence++;
      if (isActive()) {
        render();
        scrollOpenedEditor('#script-editor');
      }
      return { ok: true };
    }

    function edit(scriptId) {
      if (destroyed) return { ok: false, destroyed: true };
      scriptId = String(scriptId || '');
      var nextDraft;
      try {
        nextDraft = findScript(scriptId);
      } catch (error) {
        var message = '无法打开脚本: ' + errorText(error, '脚本数据无效');
        toast(message, true);
        return { ok: false, error: message };
      }
      draft = nextDraft;
      draftRevision++;
      codeRevision++;
      testSequence++;
      if (isActive()) {
        render();
        if (draft) scrollOpenedEditor('#script-editor');
      }
      return draft ? { ok: true } : { ok: false, error: '脚本不存在' };
    }

    function clearDraft(clearOptions) {
      clearOptions = clearOptions || {};
      draft = null;
      draftRevision++;
      codeRevision++;
      testSequence++;
      if (clearOptions.render !== false && !destroyed && isActive()) render();
      return { ok: !destroyed, destroyed: destroyed };
    }

    function validationFailure(message) {
      if (!destroyed) toast(message, true);
      return Promise.resolve({ ok: false, error: message });
    }

    function save() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (!draft) return validationFailure('没有可保存的脚本');
      if (testInFlight) return validationFailure('脚本正在保存并运行，请稍后再保存');
      if (!syncDraftFromEditor()) return validationFailure('脚本编辑器不可用');
      var draftId = String(draft.id || '');
      if (isSafeId(draftId) && deleteInFlight[draftId]) {
        return Promise.resolve({ ok: false, deleting: true, error: '脚本正在删除' });
      }
      if (saveInFlight) {
        if (saveRevision === draftRevision) return saveInFlight;
        var queuedRevision = draftRevision;
        function saveQueuedRevision() {
          if (destroyed) return { ok: false, destroyed: true };
          if (!draft || draftRevision !== queuedRevision) return { ok: false, stale: true };
          return save();
        }
        return saveInFlight.then(saveQueuedRevision, saveQueuedRevision);
      }

      var item;
      try {
        item = Object.assign({}, cloneData(draft), {
          label: String(draft.label || '').trim(),
          code: String(draft.code === undefined || draft.code === null ? '' : draft.code),
        });
      } catch (error) {
        return validationFailure('无法保存脚本: ' + errorText(error, '脚本数据无效'));
      }
      if (!item.label) return validationFailure('脚本名称不能为空');

      var revision = draftRevision;
      function stillCurrent() {
        return !destroyed && !!draft && revision === draftRevision;
      }
      var operation = Promise.resolve().then(function () {
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        return mutateConfig('upsert', 'scripts', item);
      }).then(function (config) {
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        if (!config) return { ok: false, error: '保存失败' };
        draft = null;
        draftRevision++;
        codeRevision++;
        testSequence++;
        resetConfigListPage('scripts');
        toast('脚本已保存');
        if (isActive()) render();
        return { ok: true };
      }).catch(function (error) {
        if (!stillCurrent()) return { ok: false, stale: true, destroyed: destroyed };
        var message = '保存失败: ' + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, error: message };
      });
      saveInFlight = operation;
      saveRevision = revision;
      saveTargetId = item.id === undefined || item.id === null ? '' : String(item.id);
      operation.then(function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
          saveTargetId = '';
        }
      }, function () {
        if (saveInFlight === operation) {
          saveInFlight = null;
          saveRevision = -1;
          saveTargetId = '';
        }
      });
      return operation;
    }

    function isCurrentTest(sequence, revision, resultElement) {
      return !destroyed && !!draft && sequence === testSequence && revision === codeRevision
        && resultElement && $('#script-test-result') === resultElement;
    }

    function testScript() {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      if (testInFlight) return testInFlight;
      if (saveInFlight) return validationFailure('脚本正在保存，请稍后运行');
      if (!draft) return validationFailure('没有可测试的脚本');
      if (!syncDraftFromEditor()) return validationFailure('脚本编辑器不可用');
      var resultElement = $('#script-test-result');
      if (!resultElement) return validationFailure('脚本测试结果区域不可用');
      var item;
      try {
        item = Object.assign({}, cloneData(draft), {
          label: String(draft.label || '').trim(),
          code: String(draft.code === undefined || draft.code === null ? '' : draft.code),
        });
      } catch (error) {
        return validationFailure('无法运行脚本: ' + errorText(error, '脚本数据无效'));
      }
      if (!item.label) return validationFailure('请填写脚本名称后保存并运行');
      var revision = codeRevision;
      var sequence = ++testSequence;
      resultElement.classList.remove('hidden', 'error');
      resultElement.textContent = '正在保存并运行...';

      var operation = Promise.resolve().then(function () {
        return executeScript(item);
      }).then(function (response) {
        if (!isCurrentTest(sequence, revision, resultElement)) {
          return { ok: false, stale: true, destroyed: destroyed };
        }
        var savedScript = ownDataValue(response, 'script');
        var run = ownDataValue(response, 'run');
        if (savedScript && typeof savedScript === 'object') {
          draft = cloneData(savedScript);
        }
        var result = run ? ownDataValue(run, 'result') : null;
        resultElement.textContent = '✓ 已保存并执行成功\n返回值: ' + formatTestResult(result);
        return { ok: true, script: savedScript, run: run, result: result };
      }).catch(function (error) {
        if (!isCurrentTest(sequence, revision, resultElement)) {
          return { ok: false, stale: true, destroyed: destroyed };
        }
        var savedScript = ownDataValue(error, 'savedScript');
        if (savedScript && typeof savedScript === 'object') draft = cloneData(savedScript);
        var message = errorText(error, '未知错误');
        resultElement.classList.add('error');
        resultElement.textContent = savedScript
          ? '✗ 脚本已保存，但运行失败: ' + message
          : '✗ 保存或运行失败: ' + message;
        return { ok: false, saved: !!savedScript, script: savedScript || null, error: message };
      });
      testInFlight = operation;
      operation.then(function () {
        if (testInFlight === operation) testInFlight = null;
      }, function () {
        if (testInFlight === operation) testInFlight = null;
      });
      return operation;
    }

    function remove(scriptId) {
      if (destroyed) return Promise.resolve({ ok: false, destroyed: true });
      scriptId = String(scriptId || '');
      if (!isSafeId(scriptId)) return Promise.resolve({ ok: false, error: '脚本不存在' });
      if (testInFlight) return validationFailure('脚本正在保存并运行，请稍后删除');
      if (deleteInFlight[scriptId]) return deleteInFlight[scriptId];
      if (saveInFlight && saveTargetId === scriptId) {
        var savingMessage = '脚本正在保存，请稍后删除';
        toast(savingMessage, true);
        return Promise.resolve({ ok: false, saving: true, error: savingMessage });
      }
      if (!confirmAction('确定删除该脚本？')) return Promise.resolve({ ok: false, canceled: true });
      if (draft && String(draft.id) === scriptId) {
        draftRevision++;
        codeRevision++;
        testSequence++;
        clearTestResult();
      }
      var deleteCommitted = false;
      var operation = Promise.resolve().then(function () {
        return mutateConfig('delete', 'scripts', scriptId);
      }).then(function (config) {
        if (destroyed) return { ok: false, destroyed: true };
        if (!config) return { ok: false, error: '删除失败' };
        deleteCommitted = true;
        if (draft && String(draft.id) === scriptId) {
          draft = null;
          draftRevision++;
          codeRevision++;
          testSequence++;
        }
        toast('脚本已删除');
        if (isActive()) render();
        return { ok: true };
      }).catch(function (error) {
        if (destroyed) return { ok: false, destroyed: true };
        var message = (deleteCommitted ? '脚本已删除，但刷新失败: ' : '删除失败: ')
          + errorText(error, '未知错误');
        toast(message, true);
        return { ok: false, committed: deleteCommitted, error: message };
      });
      deleteInFlight[scriptId] = operation;
      operation.then(function () {
        if (deleteInFlight[scriptId] === operation) delete deleteInFlight[scriptId];
      }, function () {
        if (deleteInFlight[scriptId] === operation) delete deleteInFlight[scriptId];
      });
      return operation;
    }

    function handleAction(action, scriptId) {
      if (action === 'edit-script') {
        edit(scriptId);
        return true;
      }
      if (action === 'save-script') {
        save();
        return true;
      }
      if (action === 'test-script') {
        testScript();
        return true;
      }
      if (action === 'cancel-script') {
        clearDraft();
        return true;
      }
      if (action === 'delete-script') {
        remove(scriptId);
        return true;
      }
      return false;
    }

    function init() {
      if (initialized || destroyed) return { ok: !destroyed, initialized: initialized, destroyed: destroyed };
      initialized = true;
      lifecycle.listen($('#btn-new-script'), 'click', openNew);
      lifecycle.listen($('#script-editor'), 'input', handleEditorInput);
      lifecycle.listen($('#script-editor'), 'keydown', handleEditorKeydown);
      return { ok: true, initialized: true };
    }

    function destroy() {
      if (destroyed) return { ok: true, destroyed: true };
      destroyed = true;
      draft = null;
      draftRevision++;
      codeRevision++;
      testSequence++;
      lifecycle.destroy();
      return { ok: true, destroyed: true };
    }

    return {
      init: init,
      destroy: destroy,
      render: render,
      handleAction: handleAction,
      clearDraft: clearDraft,
      getState: function () {
        return {
          initialized: initialized,
          destroyed: destroyed,
          saving: !!saveInFlight,
          testing: !!testInFlight,
          deleting: Object.keys(deleteInFlight).length > 0,
          draftId: draft && draft.id || '',
          revision: draftRevision,
        };
      },
    };
  }

  return { create: create };
});
