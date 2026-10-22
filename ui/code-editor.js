(function (root) {
  'use strict';
  var base = chrome.runtime.getURL('dependencies/monaco/vs/');
  var extensionPage = location.protocol === 'chrome-extension:';
  var loading, editorStyles, nextModel = 0, schemas = new Map();
  var defaults = { bg: '#ffffff', 'bg-secondary': '#f9fafb', 'bg-muted': '#eaeef0', text: '#262626', 'text-secondary': '#728e9b', value: '#775351', border: '#d0dbe0', 'border-link': '#ccdadb', accent: '#004849', danger: '#ba554a', success: '#3da67a', transmitting: '#44a3cf', warn: '#cf9f5d' };
  var style = ':host{display:block;box-sizing:border-box;width:100%;min-width:0;height:var(--code-height,220px);padding:0;border:1px solid var(--control-border,var(--border-link,#ccdadb));border-radius:var(--control-radius,4px);background:var(--bg-secondary,#f9fafb);overflow:hidden;text-align:left;white-space:normal}:host([hidden]){display:none!important}:host(:focus-within){outline:2px solid var(--accent,#004849);outline-offset:1px}:host([disabled]){opacity:.65}.surface{height:100%;width:100%;min-width:0}.status{padding:10px 12px;color:var(--text-secondary,#728e9b);font:12px/1.5 system-ui}.status button{color:var(--accent,#004849);background:var(--bg-secondary,#f9fafb);border:1px solid var(--border,#d0dbe0);border-radius:4px;padding:4px 8px}iframe{display:block;width:100%;height:100%;border:0}';
  style += ':host([readonly]:not([rows]):not([data-original])){height:min(var(--code-content-height,67px),var(--code-height,220px));}';
  function loadEditorStyles() {
    if (!editorStyles) editorStyles = fetch(base + 'editor/editor.main.css').then(function (response) {
      if (!response.ok) throw new Error('代码编辑器样式加载失败');
      return response.text();
    }).catch(function (error) { editorStyles = null; throw error; });
    return editorStyles;
  }
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function html(value, language, attributes) {
    return '<page-code-editor readonly language="' + escape(language || 'plaintext') + '"' + Object.keys(attributes || {}).map(function (key) {
      return ' ' + key + '="' + escape(attributes[key]) + '"';
    }).join('') + '>' + escape(value) + '</page-code-editor>';
  }
  function palette(element) {
    var computed = getComputedStyle(element), result = {};
    Object.keys(defaults).forEach(function (key) { result[key] = computed.getPropertyValue('--' + key).trim() || defaults[key]; });
    return result;
  }
  function theme(monaco, colors) {
    function token(key) { return colors[key].replace('#', ''); }
    monaco.editor.defineTheme('page-agent', {
      base: 'vs', inherit: false,
      rules: [
        { token: '', foreground: token('text') }, { token: 'comment', foreground: token('text-secondary') },
        { token: 'keyword', foreground: token('accent') }, { token: 'string', foreground: token('value') },
        { token: 'number', foreground: token('value') }, { token: 'type', foreground: token('accent') },
        { token: 'tag', foreground: token('accent') }, { token: 'attribute.name', foreground: token('text-secondary') },
        { token: 'delimiter', foreground: token('text-secondary') }, { token: 'invalid', foreground: token('danger') }
      ],
      colors: {
        'editor.background': colors['bg-secondary'], 'editor.foreground': colors.text,
        'editorLineNumber.foreground': colors['text-secondary'], 'editorLineNumber.activeForeground': colors.accent,
        'editorCursor.foreground': colors.accent, 'editor.selectionBackground': colors['border-link'] + '99',
        'editor.inactiveSelectionBackground': colors['bg-muted'], 'editor.lineHighlightBackground': colors['bg-muted'] + '66',
        'editorIndentGuide.background1': colors.border, 'editorIndentGuide.activeBackground1': colors['text-secondary'],
        'editorWidget.background': colors.bg, 'editorWidget.border': colors.border,
        'editorSuggestWidget.background': colors.bg, 'editorSuggestWidget.border': colors.border,
        'editorSuggestWidget.foreground': colors.text, 'editorSuggestWidget.selectedBackground': colors['bg-muted'],
        'editorSuggestWidget.highlightForeground': colors.accent,
        'editorHoverWidget.background': colors.bg, 'editorHoverWidget.border': colors.border,
        'editor.findMatchBackground': colors.warn + '55', 'editor.findMatchHighlightBackground': colors.warn + '22',
        'list.activeSelectionBackground': colors['bg-muted'], 'list.activeSelectionForeground': colors.accent,
        'list.focusBackground': colors['bg-muted'], 'list.focusForeground': colors.text, 'list.hoverBackground': colors['bg-muted'],
        'menu.background': colors.bg, 'menu.foreground': colors.text, 'menu.selectionBackground': colors['bg-muted'], 'menu.selectionForeground': colors.accent,
        'editorError.foreground': colors.danger, 'editorWarning.foreground': colors.warn, 'editorInfo.foreground': colors.transmitting,
        'editorGutter.background': colors['bg-secondary'], 'editorOverviewRuler.border': colors.border,
        'editorBracketMatch.background': colors['bg-muted'], 'editorBracketMatch.border': colors['border-link'],
        'diffEditor.insertedTextBackground': colors.success + '28', 'diffEditor.removedTextBackground': colors.danger + '28',
        'diffEditor.insertedLineBackground': colors.success + '12', 'diffEditor.removedLineBackground': colors.danger + '12',
        'scrollbarSlider.background': colors['text-secondary'] + '44', 'scrollbarSlider.hoverBackground': colors['text-secondary'] + '66',
        'focusBorder': colors.accent, 'input.background': colors.bg, 'input.foreground': colors.text, 'input.border': colors.border
      }
    });
    monaco.editor.setTheme('page-agent');
  }
  function load() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var script = document.createElement('script'); script.src = base + 'loader.js';
      script.onerror = function () { script.remove(); reject(new Error('代码编辑器资源加载失败')); };
      script.onload = function () {
        var locale = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
        root.require.config({ paths: { vs: base.slice(0, -1) } });
        // MV3 workers use packaged URLs. JavaScript shares Monaco's TypeScript service.
        root.MonacoEnvironment = { getWorker: function (_, label) {
          var files = { json: 'json.worker-Csf_TLih.js', css: 'css.worker-BpD9FCKP.js', html: 'html.worker-CLuInTTy.js', javascript: 'ts.worker-g3pjEjl4.js' };
          return new Worker(base + 'assets/' + (files[label] || 'editorWebWorkerMain-DEgFqX2K.js'));
        } };
        function loadEditor() {
          // Use the editor core and four services, without the all-language entry.
          // The toggleHighContrast chunk also registers find, formatting and completion actions.
          root.require([
            'vs/editor', 'vs/monaco.contribution-C7tY_xnl', 'vs/monaco.contribution-BuX2NvO2',
            'vs/monaco.contribution-CY2lwFI8', 'vs/monaco.contribution-D1-wBxcq', 'vs/toggleHighContrast-DuqAmExZ'
          ], function (monaco, css, html, typescript, json) {
            try {
              root.monaco = monaco;
              Object.assign(monaco.languages, { css: css.register, html: html.register, typescript: typescript.register, json: json.register });
              var stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = base + 'editor/editor.main.css'; document.head.append(stylesheet);
              configure(monaco); resolve(monaco);
            } catch (error) { reject(error); }
          }, reject);
        }
        // The locale file sets globals without defining an AMD module. Wait for its script before loading the core.
        if (locale !== 'en') {
          var messages = document.createElement('script'); messages.src = base + 'nls/lang/' + locale + '.js';
          messages.onload = loadEditor;
          messages.onerror = function () { messages.remove(); reject(new Error('代码编辑器语言包加载失败')); };
          document.head.append(messages);
        } else loadEditor();
      };
      document.head.append(script);
    }).catch(function (error) { loading = null; throw error; });
    return loading;
  }
  function configure(monaco) {
    // JSON registers its own tokenizer. These are the only additional code languages.
    [
      { id: 'html', extensions: ['.html', '.htm'], aliases: ['HTML', 'html'], mimetypes: ['text/html'], module: 'vs/html-BTio3wpy' },
      { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], aliases: ['JavaScript', 'javascript', 'js'], mimetypes: ['text/javascript', 'application/javascript'], module: 'vs/javascript-B_IYblwB' },
      { id: 'css', extensions: ['.css'], aliases: ['CSS', 'css'], mimetypes: ['text/css'], module: 'vs/css-CaeNmE3S' }
    ].forEach(function (entry) {
      var loadingLanguage;
      var loader = function () {
        if (!loadingLanguage) loadingLanguage = new Promise(function (resolve, reject) { root.require([entry.module], resolve, reject); });
        return loadingLanguage;
      };
      monaco.languages.register({ id: entry.id, extensions: entry.extensions, aliases: entry.aliases, mimetypes: entry.mimetypes, loader: loader });
      monaco.languages.registerTokensProviderFactory(entry.id, { create: async function () { return (await loader()).language; } });
      monaco.languages.onLanguageEncountered(entry.id, function () {
        loader().then(function (module) { monaco.languages.setLanguageConfiguration(entry.id, module.conf); }).catch(function (error) { console.error('代码语法加载失败', error); });
      });
    });
    syncSchemas(monaco);
    var ts = monaco.languages.typescript;
    ts.javascriptDefaults.setCompilerOptions({ allowJs: true, checkJs: false, allowNonTsExtensions: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext });
    // Script bodies run inside an async function; top-level return/await are valid here.
    ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, diagnosticCodesToIgnore: [1108, 1375, 1378] });
    ts.javascriptDefaults.addExtraLib([
      'interface PageAgentContext { get(name: string): Promise<any>; set(name: string, value: any): Promise<any>; addAttribute(...args: any[]): Promise<any>; getAttribute(...args: any[]): Promise<any>; getAttributes(...args: any[]): Promise<any>; }',
      'declare const ctx: PageAgentContext;',
      'declare function log(message: any, level?: string): Promise<void>;',
      'declare function sleep(milliseconds: number): Promise<void>;',
      'declare const page: { open(pageId: string, options?: any): Promise<any>; click(tabId: number, locator: any): Promise<any>; fill(tabId: number, locator: any, value: string): Promise<any>; extractTable(tabId: number, options?: any): Promise<any>; [method: string]: (...args: any[]) => Promise<any>; };',
      'declare const http: { fetch(url: string, options?: any): Promise<any>; webhook(url: string, body?: any): Promise<any>; };',
      'declare const api: { page: typeof page; http: typeof http; ctx: PageAgentContext; log: typeof log; sleep: typeof sleep; file: { save(...args: any[]): Promise<any> }; model: { chat(input: string | object): Promise<any> }; };',
      'declare const PageAgent: { readonly ready: Promise<any>; readonly state: any; refresh(): Promise<any>; close(): void; onChange(listener: (event: any) => void): () => void; ui: { readonly apiVersion: number; load(id: "code-editor" | "markdown" | "message-list" | "icons" | "feedback" | "floating"): Promise<any> }; data: { get(key: string): Promise<any>; list(query?: any): Promise<any>; set(key: string, value: any, version?: any): Promise<any>; delete(key: string, version?: any): Promise<any> }; actions: { run(name: string, input?: any, options?: any): Promise<any>; status(runId: string): Promise<any>; cancel(runId: string): Promise<any> }; resources: { request(method: string, request: any): Promise<any> }; asset(name: string): Promise<string>; createWorker(): Worker; manageWorker(worker: Worker): Worker; };'
    ].join('\n'), 'file:///page-agent-sdk.d.ts');
    // Templates retain highlighting but do not receive misleading JSON/JS diagnostics.
    ['javascript', 'json', 'html', 'css', 'plaintext'].forEach(function (language) {
      monaco.languages.register({ id: 'page-template-' + language });
      // JSON templates use Monaco's JS lexer without attaching its language service.
      var registration = monaco.languages.getLanguages().find(function (entry) { return entry.id === (language === 'json' ? 'javascript' : language); });
      if (registration && registration.loader) monaco.languages.onLanguage('page-template-' + language, function () {
        registration.loader().then(function (module) {
          monaco.languages.setMonarchTokensProvider('page-template-' + language, module.language);
          if (module.conf) monaco.languages.setLanguageConfiguration('page-template-' + language, module.conf);
        }).catch(function (error) { console.error('模板语法加载失败', error); });
      });
    });
  }
  function languageFor(element, monaco) {
    var value = (element.getAttribute('language') || 'plaintext').toLowerCase();
    var aliases = { js: 'javascript', jsx: 'javascript', text: 'plaintext' };
    value = aliases[value] || value;
    var filename = element.getAttribute('data-filename');
    if (filename) {
      var extension = '.' + filename.split('.').pop().toLowerCase();
      var registered = monaco.languages.getLanguages().find(function (entry) { return (entry.extensions || []).includes(extension); });
      if (registered) value = registered.id;
    }
    if (value === 'auto') value = /^[\s]*[\[{]/.test(element.value) ? 'json' : /^\s*</.test(element.value) ? 'html' : 'plaintext';
    if (!['javascript', 'json', 'html', 'css', 'plaintext'].includes(value)) value = 'plaintext';
    if (element.hasAttribute('template') && element.value.includes('{{') && ['javascript', 'json', 'html', 'css', 'plaintext'].includes(value)) return 'page-template-' + value;
    return monaco.languages.getLanguages().some(function (entry) { return entry.id === value; }) ? value : 'plaintext';
  }
  function syncSchemas(monaco) {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, enableSchemaRequest: false, schemas: Array.from(schemas.values()) });
  }
  class CodeEditor extends HTMLElement {
    static formAssociated = true;
    static get observedAttributes() { return ['readonly', 'disabled', 'language', 'rows', 'aria-label', 'placeholder', 'template', 'data-original', 'data-diff-editable', 'data-filename', 'data-label']; }
    constructor() {
      super(); this._value = null; this._revision = 0; this._internals = this.attachInternals();
      var shadow = this.attachShadow({ mode: 'open', delegatesFocus: true }), css = document.createElement('style'); css.textContent = style;
      css.textContent += '.shell{height:100%;display:flex;flex-direction:column}.surface{flex:1;min-height:0}.toolbar{display:flex;align-items:center;gap:4px;flex:0 0 28px;padding:0 6px;border-bottom:1px solid var(--border,#d0dbe0);background:var(--bg-secondary,#f9fafb);color:var(--text-secondary,#728e9b);font:11px/1.4 system-ui}.toolbar span{margin-right:auto}.toolbar button{padding:2px 6px;border:0;border-radius:var(--control-radius,4px);background:transparent;color:var(--accent,#004849);font:inherit;cursor:pointer}.toolbar button:hover{background:var(--bg-muted,#eaeef0)}.toolbar button:focus-visible{outline:1px solid var(--accent,#004849)}.toolbar button:disabled{opacity:.5;cursor:default}';
      this._stylesheet = document.createElement('style');
      this._surface = document.createElement('div'); this._surface.className = 'surface'; this._surface.setAttribute('part', 'surface');
      var shell = document.createElement('div'); shell.className = 'shell';
      var toolbar = document.createElement('div'); toolbar.className = 'toolbar'; toolbar.setAttribute('part', 'toolbar'); toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '代码操作');
      this._toolbar = toolbar;
      this._languageLabel = document.createElement('span'); toolbar.append(this._languageLabel);
      var addAction = (label, action, successLabel) => {
        var button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        var resetTimer;
        if (successLabel) button.setAttribute('aria-live', 'polite');
        button.onclick = async () => {
          clearTimeout(resetTimer);
          try {
            await action(); button.textContent = successLabel || label; button.title = '';
            if (successLabel) resetTimer = setTimeout(() => { button.textContent = label; }, 2000);
          }
          catch (error) { button.textContent = label + '失败，重试'; button.title = error.message || '操作失败'; }
        };
        toolbar.append(button); return button;
      };
      addAction('查找', async () => { await this._ensure(); if (this._editor) (this._editor.getModifiedEditor ? this._editor.getModifiedEditor() : this._editor).getAction('actions.find').run(); });
      this._formatButton = addAction('格式化', () => this.format());
      addAction('复制', async () => {
        var failure = '';
        try { await navigator.clipboard.writeText(this.value); }
        catch (error) { failure = error.message || '无法写入剪贴板'; throw error; }
        finally { this.dispatchEvent(new CustomEvent('copy-result', { bubbles: true, composed: true, detail: { error: failure } })); }
      }, '已复制');
      shell.append(toolbar, this._surface); shadow.append(css, this._stylesheet, shell);
      shadow.addEventListener('input', function (event) { event.stopPropagation(); });
      shadow.addEventListener('focusout', event => {
        if (this._userDirty && !shadow.contains(event.relatedTarget)) {
          this._userDirty = false;
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
      });
      this._sourceObserver = new MutationObserver(() => { this.value = super.textContent; });
      this._layoutFrame = 0;
      this._resize = new ResizeObserver(() => {
        if (!this._editor || this._layoutFrame) return;
        // 布局会改变内部尺寸，移到下一帧，避免在尺寸通知期间再次触发布局。
        this._layoutFrame = requestAnimationFrame(() => {
          this._layoutFrame = 0;
          if (this._editor && this.isConnected) this._editor.layout();
        });
      });
      this._visibility = new IntersectionObserver(entries => {
        clearTimeout(this._releaseTimer);
        this._inView = entries.some(entry => entry.isIntersecting);
        if (this._inView) this._ensure();
        else if (this.readOnly) this._releaseTimer = setTimeout(() => this._release(), 10000);
      }, { rootMargin: '160px' });
    }
    connectedCallback() {
      if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
      this._sourceObserver.observe(this, { childList: true, characterData: true, subtree: true });
      this._resize.observe(this); this._resize.observe(this._surface); this._visibility.observe(this);
      this.attributeChangedCallback();
    }
    disconnectedCallback() {
      queueMicrotask(() => {
        if (this.isConnected) return;
        this._sourceObserver.disconnect(); this._resize.disconnect(); this._visibility.disconnect();
        clearTimeout(this._releaseTimer); this._release();
      });
    }
    attributeChangedCallback() {
      if (this.hasAttribute('rows')) this.style.setProperty('--code-height', Math.max(110, Math.min(600, Number(this.getAttribute('rows')) * 20 + 46)) + 'px');
      this._syncHeight();
      var language = this.getAttribute('language');
      this._languageLabel.textContent = this.getAttribute('data-label') ?? (this.hasAttribute('data-original') ? '差异' : language === 'auto' ? '内容' : ['javascript', 'js', 'jsx', 'json', 'html', 'css'].includes(language) ? language : '文本');
      this._formatButton.hidden = this.readOnly || !['javascript', 'js', 'jsx', 'json', 'html', 'css', 'auto'].includes(language);
      this._formatButton.disabled = this.disabled || this.hasAttribute('template') && this.value.includes('{{');
      if (!this._editor) return;
      this._editor.updateOptions(this._options()); this._syncLanguage();
      if (this._original && this._original.getValue() !== this.getAttribute('data-original')) this._original.setValue(this.getAttribute('data-original') || '');
    }
    get value() { return this._value === null ? super.textContent : this._value; }
    set value(value) {
      value = String(value == null ? '' : value); this._value = value;
      if (super.textContent !== value) super.textContent = value;
      this._internals.setFormValue(value);
      if (this._model && this._model.getValue() !== value) {
        this._setting = true;
        // Preserve scroll and selection on streaming updates; user edits keep Monaco's undo stack.
        var state = this._editor.saveViewState(); this._model.setValue(value); this._editor.restoreViewState(state);
        this._setting = false; this._syncLanguage();
      }
      this._syncHeight();
    }
    get textContent() { return this.value; }
    set textContent(value) { this.value = value; }
    get disabled() { return this.hasAttribute('disabled') || !!this._formDisabled; }
    set disabled(value) { this.toggleAttribute('disabled', !!value); }
    get readOnly() { return this.hasAttribute('readonly'); }
    set readOnly(value) { this.toggleAttribute('readonly', !!value); }
    get placeholder() { return this.getAttribute('placeholder') || ''; }
    set placeholder(value) { this.setAttribute('placeholder', value); }
    get rows() { return Number(this.getAttribute('rows')) || 10; }
    set rows(value) { this.setAttribute('rows', value); }
    set schema(value) { this._schema = value; this._syncSchema(); }
    get schema() { return this._schema; }
    formDisabledCallback(disabled) { this._formDisabled = disabled; this.attributeChangedCallback(); }
    focus() { if (!this.disabled) { this._focusRequested = true; this._ensure(); } }
    async format() {
      await this._ensure();
      if (!this._editor || this.readOnly || this.disabled) return;
      var language = this._model.getLanguageId();
      // Language providers load asynchronously after a model first becomes visible.
      if (language === 'json') await root.monaco.languages.json.getWorker();
      else if (language === 'javascript') await root.monaco.languages.typescript.getJavaScriptWorker();
      else if (language === 'html' || language === 'css') {
        await new Promise(function (resolve, reject) {
          root.require([language === 'html' ? 'vs/htmlMode-aw5QYZo7' : 'vs/cssMode-eIUIN_ru'], resolve, reject);
        });
      }
      if (!this._editor || this.disabled) return;
      var action = this._editor.getAction('editor.action.formatDocument');
      if (!action || !action.isSupported()) throw new Error('当前内容尚不支持格式化');
      await action.run();
    }
    _options() {
      return { readOnly: this.readOnly || this.disabled, domReadOnly: this.readOnly || this.disabled,
        ariaLabel: this.getAttribute('aria-label') || (this._internals.labels[0] && this._internals.labels[0].textContent) || (this.readOnly ? '代码详情' : '代码编辑'),
        placeholder: this.placeholder, theme: 'page-agent', fontFamily: '"SF Mono", "JetBrains Mono", Consolas, monospace', fontSize: 12, lineHeight: 20,
        minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, insertSpaces: true,
        folding: true, glyphMargin: false, lineNumbersMinChars: 3, renderLineHighlight: this.readOnly ? 'none' : 'line',
        padding: { top: 8, bottom: 8 }, scrollbar: { alwaysConsumeMouseWheel: false },
        renderValidationDecorations: this.readOnly ? 'off' : 'on', fixedOverflowWidgets: false,
        automaticLayout: false, renderSideBySide: this.hasAttribute('data-diff-editable'),
        originalEditable: this.hasAttribute('data-diff-editable') && !this.readOnly && !this.disabled };
    }
    _syncLanguage() {
      if (!this._model) return;
      var language = languageFor(this, root.monaco);
      if (language !== this._model.getLanguageId()) root.monaco.editor.setModelLanguage(this._model, language);
      this._languageLabel.textContent = this.getAttribute('data-label') ?? (this.hasAttribute('data-original') ? '差异' : language.replace('page-template-', '') === 'plaintext' ? '文本' : language.replace('page-template-', ''));
      this._formatButton.hidden = this.readOnly || !['javascript', 'json', 'html', 'css'].includes(language.replace('page-template-', ''));
      this._formatButton.disabled = this.disabled || language.startsWith('page-template-');
    }
    _syncSchema() {
      if (!this._model) return;
      var uri = this._model.uri.toString();
      if (this._schema) schemas.set(uri, { uri: uri + '.schema', fileMatch: [uri], schema: this._schema });
      else schemas.delete(uri);
      syncSchemas(root.monaco);
    }
    _syncHeight() {
      if (!this.readOnly || this.hasAttribute('rows') || this.hasAttribute('data-original')) {
        this.style.removeProperty('--code-content-height');
        return;
      }
      // Monaco includes wrapped lines and padding; use a line estimate until it loads.
      var contentHeight = this._editor ? this._editor.getContentHeight() : this.value.split(/\r\n|\r|\n/).length * 20 + 16;
      var height = Math.ceil(contentHeight + (this._toolbar.offsetHeight || 29) + 2);
      if (this.style.getPropertyValue('--code-content-height') === height + 'px') return;
      this.style.setProperty('--code-content-height', height + 'px');
      this.dispatchEvent(new CustomEvent('code-editor-resize', { detail: { height: height } }));
    }
    async _ensure() {
      if (this._editor) { if (this._focusRequested) { this._editor.focus(); this._focusRequested = false; } return; }
      if (this._pending || !this.isConnected) return this._pending;
      var revision = this._revision;
      this._surface.textContent = '';
      var status = document.createElement('div'); status.className = 'status'; status.textContent = '正在加载代码编辑器…'; this._surface.append(status);
      this._pending = Promise.all([load(), loadEditorStyles()]).then(([monaco, css]) => {
        if (!this.isConnected || revision !== this._revision) return;
        // Inline the shared local CSS before mounting. Unlike a link, it survives DOM moves without reloading.
        if (this._stylesheet.textContent !== css) this._stylesheet.textContent = css;
        this._value = this.value; this._surface.replaceChildren(); theme(monaco, palette(this));
        var language = languageFor(this, monaco), uri = monaco.Uri.parse('file:///page-agent/editor-' + (++nextModel) + '.' + ({ javascript: 'js', json: 'json', html: 'html', css: 'css' }[language] || 'txt'));
        this._model = monaco.editor.createModel(this.value, language, uri);
        if (this.hasAttribute('data-original')) {
          this._original = monaco.editor.createModel(this.getAttribute('data-original'), language);
          this._editor = monaco.editor.createDiffEditor(this._surface, this._options());
          this._editor.setModel({ original: this._original, modified: this._model });
          this._originalChanges = this._original.onDidChangeContent(() => {
            const value = this._original.getValue();
            if (value === this.getAttribute('data-original')) return;
            this.setAttribute('data-original', value);
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          });
        } else this._editor = monaco.editor.create(this._surface, Object.assign(this._options(), { model: this._model }));
        if (!this._original) this._contentSize = this._editor.onDidContentSizeChange(() => this._syncHeight());
        this._syncHeight();
        this._syncLanguage();
        if (this._viewState) this._editor.restoreViewState(this._viewState);
        this._changes = this._model.onDidChangeContent(() => {
          this._value = this._model.getValue(); this._internals.setFormValue(this._value);
          if (!this._setting) {
            this._userDirty = true; this._syncLanguage();
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          }
        });
        if (this._schema) this._syncSchema();
        if (this._focusRequested) { this._editor.focus(); this._focusRequested = false; }
      }).catch(error => {
        if (!this.isConnected || revision !== this._revision) return;
        this._release(); revision = this._revision;
        status.textContent = error.message || '代码编辑器加载失败';
        var retry = document.createElement('button'); retry.textContent = '重试'; retry.type = 'button'; retry.onclick = () => this._ensure(); status.append(' ', retry);
        this._surface.replaceChildren(status);
      }).finally(() => {
        this._pending = null;
        if (revision !== this._revision && this.isConnected && (this._inView || this._focusRequested)) this._ensure();
      });
      return this._pending;
    }
    _release() {
      if (this._layoutFrame) cancelAnimationFrame(this._layoutFrame);
      this._layoutFrame = 0;
      this._revision++;
      if (this._editor) this._viewState = this._editor.saveViewState();
      if (this._model) { this._value = this._model.getValue(); if (schemas.delete(this._model.uri.toString())) syncSchemas(root.monaco); }
      if (this._changes) this._changes.dispose();
      if (this._originalChanges) this._originalChanges.dispose();
      if (this._contentSize) this._contentSize.dispose();
      if (this._editor) this._editor.dispose();
      if (this._model) this._model.dispose();
      if (this._original) this._original.dispose();
      this._editor = this._model = this._original = this._changes = this._originalChanges = this._contentSize = null;
      this._surface.replaceChildren();
    }
  }
  // Page content uses an extension frame so the site's CSP, globals and styles cannot own Monaco.
  function attach(container) {
    var mounted = new Map(), known = new WeakMap();
    var visibility = new IntersectionObserver(entries => entries.forEach(function (entry) {
      var state = mounted.get(entry.target); if (!state) return;
      clearTimeout(state.timer);
      if (entry.isIntersecting) state.open();
      else state.timer = setTimeout(state.close, 10000);
    }), { rootMargin: '160px' });
    function scan() {
      mounted.forEach(function (state, node) { if (!container.contains(node)) { state.close(); visibility.unobserve(node); clearTimeout(state.timer); mounted.delete(node); } });
      container.querySelectorAll('page-code-editor').forEach(function (node) {
        var existing = mounted.get(node);
        if (existing) { existing.update(); return; }
        if (known.has(node)) { mounted.set(node, known.get(node)); visibility.observe(node); return; }
        var shadow = node.attachShadow({ mode: 'closed' }), css = document.createElement('style'); css.textContent = style; shadow.append(css);
        var frame, port, contentHeight, last = '', token = crypto.randomUUID();
        var state = {
          update: function () {
            // Streaming reconciliation can replace attributes while retaining this view.
            if (contentHeight) node.style.setProperty('--code-content-height', contentHeight + 'px');
            var value = node.textContent, language = node.getAttribute('language') || 'plaintext';
            var key = language + '\0' + value;
            if (port && last !== key) { last = key; port.postMessage({ value: value, language: language, colors: palette(node), label: node.getAttribute('aria-label') || '代码详情' }); }
          },
          open: function () {
            if (frame) return;
            frame = document.createElement('iframe'); frame.title = node.getAttribute('aria-label') || '代码详情'; frame.allow = 'clipboard-write';
            frame.src = chrome.runtime.getURL('ui/code-editor-frame.html') + '#' + token;
            var currentFrame = frame;
            frame.addEventListener('load', function () {
              if (frame !== currentFrame) return;
              if (port) port.close();
              var channel = new MessageChannel(); port = channel.port1;
              port.onmessage = function (message) {
                var height = message.data && message.data.height;
                if (frame !== currentFrame || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
                contentHeight = height;
                node.style.setProperty('--code-content-height', height + 'px');
              };
              frame.contentWindow.postMessage({ type: 'PAGE_AGENT_CODE_VIEW', token: token }, chrome.runtime.getURL('').replace(/\/$/, ''), [channel.port2]);
              last = ''; state.update();
            });
            shadow.append(frame);
          },
          close: function () { if (port) port.close(); if (frame) frame.remove(); port = frame = null; last = ''; }
        };
        known.set(node, state); mounted.set(node, state); visibility.observe(node);
      });
    }
    var observer = new MutationObserver(scan); observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['language'] }); scan();
    return function () { observer.disconnect(); visibility.disconnect(); mounted.forEach(function (state) { clearTimeout(state.timer); state.close(); }); mounted.clear(); };
  }
  function preserveViews(before, after) {
    var previous = Array.from(before.querySelectorAll('page-code-editor'));
    after.querySelectorAll('page-code-editor').forEach(function (replacement, index) {
      var current = previous[index];
      if (!current || current.hasAttribute('data-original') !== replacement.hasAttribute('data-original')) return;
      current.textContent = replacement.textContent;
      Array.from(current.attributes).forEach(function (attribute) { if (!replacement.hasAttribute(attribute.name)) current.removeAttribute(attribute.name); });
      Array.from(replacement.attributes).forEach(function (attribute) { current.setAttribute(attribute.name, attribute.value); });
      replacement.replaceWith(current);
    });
  }
  root.PageAgentCodeEditor = { html: html, attach: attach, preserveViews: preserveViews };
  if (extensionPage && !customElements.get('page-code-editor')) customElements.define('page-code-editor', CodeEditor);
})(globalThis);
