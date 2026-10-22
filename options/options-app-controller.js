(function (root) {
  'use strict';
  function create(options) {
    var section = document.getElementById('section-apps'), client = options.resourceClient, C = root.AppContract;
    var apps = [], sequence = 0, loading = false, loadError = false, managing = false, editor = null, permissionView = null;
    var layoutKey = 'app_launcher_' + (chrome.extension.inIncognitoContext ? 'incognito' : 'regular');
    var layout = { order: [], favorites: [] }, layoutReady = false, layoutBusy = false, favoritesOnly = false, disposed = false;
    var drag = null, redrawPending = false;
    function el(tag, text, className) { var node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
    function button(text, action) { var node = el('button', text, 'btn-secondary'); node.type = 'button'; node.onclick = function () { Promise.resolve().then(action).catch(fail); }; return node; }
    function fail(error) { options.toast(error.message || String(error), true); }
    function unwrap(response) { if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code }); return response.primary.data; }
    function get(uri) { return client.get(uri).then(unwrap); }
    function manage(operation, input) {
      return chrome.runtime.sendMessage({ type: 'APP_MANAGE', operation: operation, input: input }).then(function (response) {
        if (!response) throw new Error('后台未响应');
        if (response.error) throw Object.assign(new Error(response.error.message), response.error);
        if (operation === 'open') {
          var app = apps.find(function (item) { return item.appId === input.appId; });
          if (app) { app.lastUsedAt = Date.now(); draw(); }
        }
        return response.result;
      });
    }
    var header = el('header', undefined, 'section-header app-header'), heading = el('div', undefined, 'app-header-copy'), actions = el('div', undefined, 'app-actions');
    var description = el('p', '点击应用即可打开。', 'section-desc');
    heading.append(el('h2', '应用入口'), description);
    var newApp = button('新建应用', createApp); newApp.className = 'btn-primary';
    var manageApps = button('管理应用', function () {
      managing = !managing;
      manageApps.textContent = managing ? '取消管理' : '管理应用';
      manageApps.setAttribute('aria-pressed', String(managing));
      description.textContent = managing ? '点击管理进入应用管理页面。' : '点击应用即可打开。';
      draw();
    });
    manageApps.setAttribute('aria-pressed', 'false'); manageApps.setAttribute('aria-controls', 'app-catalog');
    actions.append(button('导入应用', function () { document.getElementById('file-import-config').click(); }), newApp, manageApps);
    header.append(heading, actions);
    var recent = el('section', undefined, 'app-recent'), recentList = el('ul', undefined, 'app-recent-list');
    var recentTitle = el('h3', '最近使用'); recentTitle.id = 'app-recent-title';
    recent.setAttribute('aria-labelledby', recentTitle.id); recent.hidden = true; recent.append(recentTitle, recentList);
    var toolbar = el('div', undefined, 'app-toolbar'), search = el('input'), filters = el('div', undefined, 'app-filters');
    search.type = 'search'; search.placeholder = '搜索应用名称'; search.setAttribute('aria-label', '搜索应用名称');
    var allApps = button('全部', function () { favoritesOnly = false; draw(); });
    var favoriteApps = button('收藏', function () { favoritesOnly = true; draw(); });
    filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '应用筛选'); filters.append(allApps, favoriteApps);
    var status = el('span', '正在加载…', 'app-list-status'), retry = button('重新加载', render);
    status.setAttribute('role', 'status'); retry.hidden = true;
    toolbar.append(filters, search, status, retry);
    var orderHint = el('p', undefined, 'app-order-hint'); orderHint.id = 'app-order-hint';
    var catalog = el('section', undefined, 'app-catalog-section'), catalogTitle = el('h3', '全部应用'); catalog.id = 'app-catalog';
    catalogTitle.id = 'app-catalog-title'; catalog.setAttribute('aria-labelledby', catalogTitle.id);
    var grid = el('ul', undefined, 'app-grid'); grid.id = 'app-grid'; grid.setAttribute('aria-label', '应用');
    catalog.append(catalogTitle, grid);
    section.append(header, recent, toolbar, orderHint, catalog);
    search.oninput = draw;
    function normalizeLayout(value) {
      var normalized = {};
      ['order', 'favorites'].forEach(function (key) {
        normalized[key] = Array.from(new Set(value && Array.isArray(value[key]) ? value[key].filter(function (id) { return typeof id === 'string'; }) : []));
      });
      // Preserve the displayed order when removing the previous separate pin list.
      var previousPins = value && Array.isArray(value.pinned) ? value.pinned.filter(function (id) { return typeof id === 'string'; }) : [];
      normalized.order = Array.from(new Set(previousPins.concat(normalized.order)));
      return normalized;
    }
    function byCreated(a, b) { return (a.createdAt || 0) - (b.createdAt || 0) || a.appId.localeCompare(b.appId); }
    function writeLayout(items, change) {
      return navigator.locks.request(layoutKey, async function () {
        var stored = await chrome.storage.local.get(layoutKey), next = normalizeLayout(stored[layoutKey]), before = JSON.stringify(stored[layoutKey] || next);
        var known = new Set(next.order);
        items.slice().sort(byCreated).forEach(function (app) { if (!known.has(app.appId)) { next.order.push(app.appId); known.add(app.appId); } });
        if (change) change(next);
        if (JSON.stringify(next) !== before) await chrome.storage.local.set({ [layoutKey]: next });
        return next;
      });
    }
    async function changeLayout(change) {
      if (loading || layoutBusy || !layoutReady) return;
      var focused = catalog.contains(document.activeElement) ? document.activeElement : null;
      layoutBusy = true; draw();
      try { layout = await writeLayout(apps, change); }
      finally {
        layoutBusy = false;
        if (!disposed) {
          draw();
          if (focused && document.activeElement === document.body) {
            var replacement = Array.from(catalog.querySelectorAll('button[data-app-id]')).find(function (node) { return node.dataset.appId === focused.dataset.appId && node.dataset.control === focused.dataset.control; });
            if (replacement) replacement.focus({ preventScroll: true }); else if (favoritesOnly) favoriteApps.focus({ preventScroll: true });
          }
        }
      }
    }
    function toggleLayout(key, appId) {
      return changeLayout(function (next) {
        var index = next[key].indexOf(appId);
        if (index < 0) next[key].push(appId); else next[key].splice(index, 1);
      });
    }
    function orderedApps() {
      var positions = new Map(layout.order.map(function (id, index) { return [id, index]; }));
      return apps.slice().sort(function (a, b) {
        var aPosition = positions.has(a.appId) ? positions.get(a.appId) : Infinity, bPosition = positions.has(b.appId) ? positions.get(b.appId) : Infinity;
        return aPosition - bPosition || byCreated(a, b);
      });
    }
    function canReorder() { return layoutReady && !loading && !layoutBusy && !favoritesOnly && !search.value.trim(); }
    async function moveApp(appId, targetId, after) {
      if (targetId && !canReorder() || appId === targetId) return;
      await changeLayout(function (next) {
        if (!apps.some(function (app) { return app.appId === appId; }) || targetId && !apps.some(function (app) { return app.appId === targetId; })) return;
        next.order = next.order.filter(function (id) { return id !== appId; });
        var index = targetId ? next.order.indexOf(targetId) + (after ? 1 : 0) : 0;
        next.order.splice(index, 0, appId);
      });
      if (disposed) return;
      var moved = Array.from(catalog.querySelectorAll('.app-card-main')).find(function (node) { return node.dataset.appId === appId; });
      if (moved) moved.focus({ preventScroll: true });
    }
    function clearDropTarget() {
      catalog.querySelectorAll('.app-drop-before, .app-drop-after').forEach(function (node) { node.classList.remove('app-drop-before', 'app-drop-after'); });
    }
    function endDrag() {
      drag = null; clearDropTarget();
      catalog.querySelectorAll('.app-dragging').forEach(function (node) { node.classList.remove('app-dragging'); });
      if (redrawPending) { redrawPending = false; draw(); }
    }
    function dropTarget(event) {
      var card = event.target.closest('.app-card');
      if (!drag || !canReorder() || !card || !catalog.contains(card) || card.dataset.appId === drag.appId) return null;
      return card;
    }
    catalog.addEventListener('dragstart', function (event) {
      var main = event.target.closest('.app-card-main');
      if (!main || !canReorder()) { event.preventDefault(); return; }
      drag = { appId: main.dataset.appId };
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', drag.appId);
      main.closest('.app-card').classList.add('app-dragging');
    });
    catalog.addEventListener('dragover', function (event) {
      var card = dropTarget(event); clearDropTarget();
      if (!card) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      var rect = card.getBoundingClientRect();
      card.classList.add(event.clientX > rect.left + rect.width / 2 ? 'app-drop-after' : 'app-drop-before');
    });
    catalog.addEventListener('dragleave', function (event) { if (!catalog.contains(event.relatedTarget)) clearDropTarget(); });
    catalog.addEventListener('drop', function (event) {
      var card = dropTarget(event);
      if (!card) { endDrag(); return; }
      event.preventDefault();
      var appId = drag.appId, targetId = card.dataset.appId, rect = card.getBoundingClientRect(), after = event.clientX > rect.left + rect.width / 2;
      endDrag(); moveApp(appId, targetId, after).catch(fail);
    });
    catalog.addEventListener('dragend', endDrag);
    function addressField(input, id) {
      var row = el('div', undefined, 'form-row'), label = el('label', '应用别名');
      input.id = id; input.type = 'text'; input.maxLength = 64; input.placeholder = 'my-tools'; input.spellcheck = false; input.autocapitalize = 'none';
      label.htmlFor = id;
      var help = el('p', '1–64 位英文字母或数字，可用单个 - 连接，自动转小写。留空使用 ID；改名后旧别名失效。', 'form-help');
      help.id = id + '-help'; input.setAttribute('aria-describedby', help.id);
      row.append(label, input, help); return row;
    }
    function createApp() {
      if (!confirmDrawerClose()) return;
      var form = el('form'), name = el('input'), description = el('textarea'), slug = el('input');
      form.id = 'app-create-form';
      name.type = 'text'; name.id = 'app-create-name'; name.required = true; name.maxLength = C.limits.nameLength; name.placeholder = '应用名称，最多 ' + C.limits.nameLength + ' 个字符';
      description.id = 'app-create-description'; description.rows = 3; description.placeholder = '简要说明应用用途（可选）';
      var nameRow = el('div', undefined, 'form-row'), nameLabel = el('label', '应用名称'); nameLabel.htmlFor = name.id; nameRow.append(nameLabel, name);
      var descriptionRow = el('div', undefined, 'form-row'), descriptionLabel = el('label', '描述'); descriptionLabel.htmlFor = description.id; descriptionRow.append(descriptionLabel, description);
      var submit = el('button', '创建应用', 'btn-primary'); submit.type = 'submit'; submit.setAttribute('form', form.id);
      var cancel = el('button', '取消', 'btn-secondary'); cancel.type = 'button'; cancel.dataset.action = 'cancel-drawer';
      form.append(nameRow, addressField(slug, 'app-create-slug'), descriptionRow);
      document.getElementById('drawer-title').textContent = '新建应用';
      document.getElementById('drawer-content').replaceChildren(form);
      document.getElementById('drawer-actions').replaceChildren(cancel, submit);
      options.openDrawer(); name.focus();
      form.onsubmit = async function (event) {
        event.preventDefault();
        if (submit.disabled) return;
        name.value = name.value.trim();
        if (!form.reportValidity()) return;
        newApp.disabled = true; submit.disabled = true; cancel.disabled = true; name.disabled = true; description.disabled = true; slug.disabled = true;
        try {
          slug.value = C.slug(slug.value) || '';
          var capabilities = await get('/apps/capabilities');
          var content = el('main', undefined, 'app-page'), header = el('header', undefined, 'app-header');
          header.append(el('h1', name.value), el('p', description.value.trim() || '从这里开始构建你的应用。', 'section-desc'));
          content.append(header);
          var app = unwrap(await client.post('/apps', {
            name: name.value, slug: slug.value, description: description.value.trim(), icon: 'fa-cube',
            code: {
              html: content.outerHTML, css: '', javascript: '', themeCss: capabilities.defaults.ui.themeCss,
              description: description.value.trim(), capabilities: [], actions: [], dependencies: [], customBehavior: [], externalResources: []
            }
          }));
          options.toast('应用已创建');
          search.value = ''; favoritesOnly = false; render().catch(fail);
          if (form.isConnected && document.getElementById('drawer').classList.contains('active')) {
            options.closeDrawer();
            await edit(app.appId);
          }
        } catch (error) { fail(error); }
        finally { newApp.disabled = false; submit.disabled = false; cancel.disabled = false; name.disabled = false; description.disabled = false; slug.disabled = false; }
      };
    }
    async function render() {
      if (disposed || !options.isActive()) return;
      var ticket = ++sequence, collected = new Map(), cursor = null;
      loading = true; loadError = false; catalog.setAttribute('aria-busy', 'true'); draw();
      try {
        do {
          var query = new URLSearchParams({ limit: '100', sort: 'updated' });
          if (cursor) query.set('cursor', cursor);
          var page = await get('/apps?' + query);
          if (ticket !== sequence) return;
          page.items.forEach(function (app) { collected.set(app.appId, app); });
          cursor = page.nextCursor;
        } while (cursor);
        var nextApps = Array.from(collected.values()), nextLayout = await writeLayout(nextApps);
        if (ticket !== sequence) return;
        apps = nextApps; layout = nextLayout; layoutReady = true;
      } catch (error) {
        if (ticket !== sequence) return;
        loadError = true;
        throw error;
      } finally {
        if (ticket === sequence) { loading = false; catalog.setAttribute('aria-busy', 'false'); draw(); }
      }
    }
    function draw() {
      if (disposed) return;
      if (drag) { redrawPending = true; return; }
      var term = C.normalizeName(search.value), favorites = new Set(layout.favorites), ordered = orderedApps();
      var visibleApps = ordered.filter(function (app) { return C.normalizeName(app.name).includes(term) && (!favoritesOnly || favorites.has(app.appId)); });
      status.textContent = loading ? '正在加载…' : layoutBusy ? '正在保存…' : loadError ? '加载失败，请重试。' : (term ? '找到 ' : '') + visibleApps.length + ' 个应用';
      retry.hidden = !loadError;
      allApps.setAttribute('aria-pressed', String(!favoritesOnly)); favoriteApps.setAttribute('aria-pressed', String(favoritesOnly));
      favoriteApps.textContent = '收藏 ' + apps.filter(function (app) { return favorites.has(app.appId); }).length;
      orderHint.textContent = term || favoritesOnly ? '清空搜索并切换到“全部”后可拖拽调整顺序。' : '拖拽卡片调整顺序。';
      var focused = catalog.contains(document.activeElement) || recentList.contains(document.activeElement) ? document.activeElement : null;
      recentList.replaceChildren();
      apps.filter(function (app) { return app.lastUsedAt > 0 && app.lastUsedAt !== app.createdAt; })
        .sort(function (a, b) { return b.lastUsedAt - a.lastUsedAt || a.appId.localeCompare(b.appId); }).slice(0, 10).forEach(function (app) {
          var item = el('li'), open = button('', function () { return manage('open', { appId: app.appId }); });
          open.className = 'app-recent-open'; open.title = app.name; open.setAttribute('aria-label', '打开 ' + app.name);
          open.dataset.appId = app.appId; open.dataset.control = 'recent';
          var icon = el('span', C.ICONS[app.icon] || C.ICONS['fa-cube'], 'app-icon'); icon.setAttribute('aria-hidden', 'true');
          open.append(icon); item.append(open); recentList.append(item);
        });
      recent.hidden = !recentList.childElementCount;
      grid.replaceChildren();
      catalogTitle.textContent = favoritesOnly ? '收藏的应用' : '全部应用';
      if (!visibleApps.length) grid.append(el('li', loading ? '正在加载应用…' : loadError ? '暂时无法加载应用。' : term ? '没有找到匹配的应用，试试其他名称。' : favoritesOnly ? '还没有收藏，切换到“全部”，点击卡片上的五角星即可收藏。' : '还没有应用，点击“新建应用”或“导入应用”开始。', 'app-empty'));
      visibleApps.forEach(function (app) {
        var card = el('li', undefined, 'app-card'); card.dataset.appId = app.appId;
        var main = button('', function () { return manage('open', { appId: app.appId }); }); main.className = 'app-card-main';
        main.title = app.name + (app.description ? '\n' + app.description : ''); main.setAttribute('aria-label', '打开 ' + app.name + (favorites.has(app.appId) ? '，已收藏' : ''));
        main.dataset.appId = app.appId; main.dataset.control = 'open'; main.draggable = canReorder(); main.setAttribute('aria-describedby', orderHint.id);
        var icon = el('span', C.ICONS[app.icon] || C.ICONS['fa-cube'], 'app-icon'); icon.setAttribute('aria-hidden', 'true');
        var copy = el('span', undefined, 'app-card-copy'); copy.append(el('span', app.name, 'app-card-name'));
        if (app.description) copy.append(el('span', app.description, 'app-card-description'));
        main.append(icon, copy); card.append(main);
        if (app.__builtin) main.append(el('span', '内置', 'app-card-builtin'));
        var favorite = button('', function () { return toggleLayout('favorites', app.appId); }); favorite.className = 'app-card-favorite';
        favorite.dataset.appId = app.appId; favorite.dataset.control = 'favorites'; favorite.disabled = loading || layoutBusy || !layoutReady;
        favorite.title = (favorites.has(app.appId) ? '取消收藏 ' : '收藏 ') + app.name;
        favorite.setAttribute('aria-label', favorite.title); favorite.setAttribute('aria-pressed', String(favorites.has(app.appId)));
        var star = el('span', favorites.has(app.appId) ? '\uf005' : '\uf006'); star.setAttribute('aria-hidden', 'true'); favorite.append(star); card.append(favorite);
        if (managing) {
          var controls = el('div', undefined, 'app-card-controls');
          var pin = button('置顶', function () { return moveApp(app.appId, null, false); }); pin.className = 'app-card-manage';
          pin.dataset.appId = app.appId; pin.dataset.control = 'move-first'; pin.disabled = loading || layoutBusy || !layoutReady || ordered[0].appId === app.appId;
          pin.title = '移到列表第一位'; pin.setAttribute('aria-label', '将 ' + app.name + ' 移到列表第一位'); controls.append(pin);
          var settings = button('管理', function () { showManagement(app); }); settings.className = 'app-card-manage';
          settings.setAttribute('aria-label', '管理 ' + app.name); settings.dataset.appId = app.appId; settings.dataset.control = 'manage'; controls.append(settings); card.append(controls);
        }
        grid.append(card);
      });
      if (focused) {
        var replacement = Array.from(section.querySelectorAll('button[data-app-id]')).find(function (node) { return node.dataset.appId === focused.dataset.appId && node.dataset.control === focused.dataset.control; });
        if (replacement) replacement.focus({ preventScroll: true }); else if (favoritesOnly) favoriteApps.focus({ preventScroll: true });
      }
    }
    function showManagement(app) {
      if (!confirmDrawerClose()) return;
      var container = el('div', undefined, 'app-management'), overview = el('div', undefined, 'app-management-overview');
      var icon = el('button'), iconPreview = el('span', undefined, 'app-icon'), copy = el('div');
      var iconGrid = el('div', undefined, 'app-icon-grid'), iconButtons = [];
      iconGrid.id = 'app-management-icon-grid'; iconGrid.setAttribute('popover', 'auto');
      iconGrid.setAttribute('role', 'group'); iconGrid.setAttribute('aria-label', '选择应用图标');
      icon.type = 'button'; icon.className = 'app-icon-trigger'; icon.title = '更换图标，选择后立即保存';
      if (app.__builtin) { icon.disabled = true; icon.title = '内置应用请复制后修改'; }
      icon.setAttribute('popovertarget', iconGrid.id);
      icon.setAttribute('aria-controls', iconGrid.id); icon.setAttribute('aria-expanded', 'false');
      iconPreview.setAttribute('aria-hidden', 'true'); icon.append(iconPreview);
      function setIcon(value) {
        icon.value = value; iconPreview.textContent = C.ICONS[value];
        icon.setAttribute('aria-label', '更换应用图标，当前：' + value);
        iconButtons.forEach(function (item) {
          var selected = item.value === value;
          item.setAttribute('aria-pressed', String(selected)); item.tabIndex = selected ? 0 : -1;
        });
      }
      Object.keys(C.ICONS).forEach(function (key) {
        var option = el('button', undefined, 'app-icon-option'), glyph = el('span', C.ICONS[key]);
        option.type = 'button'; option.value = key; option.setAttribute('aria-label', key);
        glyph.setAttribute('aria-hidden', 'true'); option.append(glyph);
        option.onclick = async function () {
          if (icon.disabled) return;
          iconGrid.hidePopover(); icon.focus({ preventScroll: true });
          if (icon.value === key) return;
          icon.disabled = true; icon.setAttribute('aria-busy', 'true');
          try {
            var current = await get('/apps/' + app.appId);
            app = unwrap(await client.patch('/apps/' + app.appId, { icon: key }, { preconditions: { ifMatch: '"' + current.revision + '"' } }));
            setIcon(app.icon);
            var listed = apps.find(function (item) { return item.appId === app.appId; });
            if (listed) Object.assign(listed, app);
            if (!disposed) draw();
            options.toast('图标已保存'); render().catch(fail);
          } catch (error) { fail(error); }
          finally {
            icon.disabled = false; icon.removeAttribute('aria-busy');
            if (container.isConnected && document.getElementById('drawer').classList.contains('active') && document.activeElement === document.body) icon.focus({ preventScroll: true });
          }
        };
        iconButtons.push(option); iconGrid.append(option);
      });
      setIcon(app.icon);
      iconGrid.addEventListener('beforetoggle', function (event) {
        icon.setAttribute('aria-expanded', String(event.newState === 'open'));
        if (event.newState !== 'open') return;
        var rect = icon.getBoundingClientRect(), width = Math.min(360, window.innerWidth - 24);
        var below = window.innerHeight - rect.bottom - 12, above = rect.top - 12, openBelow = below >= Math.min(320, above);
        var height = Math.min(320, Math.max(0, openBelow ? below : above));
        iconGrid.style.width = width + 'px';
        iconGrid.style.maxHeight = height + 'px';
        iconGrid.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
        iconGrid.style.top = (openBelow ? rect.bottom + 6 : rect.top - height - 6) + 'px';
        setIcon(icon.value);
      });
      iconGrid.addEventListener('toggle', function (event) {
        if (event.newState !== 'open') return;
        var selected = iconButtons.find(function (item) { return item.value === icon.value; });
        selected.focus({ preventScroll: true }); selected.scrollIntoView({ block: 'nearest' });
      });
      iconGrid.onkeydown = function (event) {
        var index = iconButtons.indexOf(document.activeElement); if (index === -1) return;
        var columns = getComputedStyle(iconGrid).gridTemplateColumns.split(' ').length, next;
        if (event.key === 'ArrowRight') next = index + 1;
        else if (event.key === 'ArrowLeft') next = index - 1;
        else if (event.key === 'ArrowDown') next = index + columns;
        else if (event.key === 'ArrowUp') next = index - columns;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = iconButtons.length - 1;
        else return;
        event.preventDefault(); next = Math.max(0, Math.min(iconButtons.length - 1, next));
        iconButtons[index].tabIndex = -1; iconButtons[next].tabIndex = 0; iconButtons[next].focus();
      };
      var appName = el('h4', app.name); appName.title = app.name; copy.append(appName);
      if (app.__builtin) copy.append(el('p', '内置应用只读，可复制后修改。副本包含应用源码文件，不包含业务数据和授权。', 'form-help'));
      else copy.append(el('p', '点击编辑图标', 'form-help'));
      overview.append(icon, copy);
      overview.append(el('p', app.description || '', 'form-help app-management-description'));
      container.append(overview, iconGrid);
      function group(title, controls) {
        var group = el('section', undefined, 'app-management-group'), row = el('div', undefined, 'app-actions');
        row.append.apply(row, controls); group.append(el('h4', title), row); return group;
      }
      var info = el('section', undefined, 'app-management-group'), details = el('dl', undefined, 'app-management-details');
      var idValue = el('dd'), aliasValue = el('dd');
      var idCode = el('code', app.appId); idCode.title = '点击选中 ID'; idValue.append(idCode);
      aliasValue.append(app.slug ? el('code', app.slug) : el('span', '未设置（使用 ID）'));
      details.append(el('dt', 'ID'), idValue, el('dt', '别名'), aliasValue);
      var accessActions = el('div', undefined, 'app-actions');
      accessActions.append(
        button('打开应用', function () { return manage('open', { appId: app.appId }); }),
        button('复制链接', async function () { var current = await get('/apps/' + app.appId); await navigator.clipboard.writeText(current.slots.published ? current.links.open : current.links.preview); options.toast('应用链接已复制'); })
      );
      info.append(el('h4', '应用信息'), details, accessActions); container.append(info);
      var managementActions = el('fieldset', undefined, 'app-management-actions'); managementActions.setAttribute('aria-label', '应用操作');
      var publishDraft = button('发布', async function () {
        publishDraft.disabled = true;
        try { await publish(app.appId); if (container.isConnected) options.closeDrawer(); }
        finally { publishDraft.disabled = false; }
      });
      var copyApp = button('复制后修改', async function () {
        var current = await get('/apps/' + app.appId);
        var result = await manage('copy', { appId: app.appId, revision: current.revision });
        await render(); options.toast('已创建副本，请在权限设置中启用所需能力');
        await edit(result.appId);
      });
      if (app.__builtin) managementActions.append(group('编辑', [copyApp]));
      else managementActions.append(group('编辑', [
        button('对话调整', function () { if (options.closeDrawer() !== false) return options.converse(app.appId); }),
        button('编辑代码', function () { return edit(app.appId); }),
        copyApp
      ]), group('发布', [
        button('预览草稿', function () { return manage('open', { appId: app.appId, slot: 'draft' }); }),
        publishDraft
      ]), group('导出', [
        button('导出应用', function () { return options.exportApp(app.appId); })
      ]));
      managementActions.append(group('权限', [button('权限设置', function () { return permissions(app.appId); })]));
      var running = group('运行', [
        button('查看运行记录', function () { if (options.closeDrawer() !== false) options.showRuns(); }),
        button('关闭应用标签页', function () { return manage('stop', { appId: app.appId }); }),
        button('取消此应用的任务', async function () { var result = await manage('cancel-runs', { appId: app.appId }); options.toast('已请求取消 ' + result.requested + ' 个任务；已发生的操作不会回滚。'); })
      ]);
      var remove = button('删除应用', async function () {
        if (!confirm('删除“' + app.name + '”及其业务数据和主题资源？共享流程会保留。')) return;
        remove.disabled = true;
        try {
          var current = await get('/apps/' + app.appId);
          unwrap(await client.delete('/apps/' + app.appId, { preconditions: { ifMatch: '"' + current.revision + '"' } }));
          if (container.isConnected) options.closeDrawer();
          await render();
        } finally { remove.disabled = false; }
      }); remove.className = 'btn-danger';
      if (app.__builtin) { remove.disabled = true; remove.title = '内置应用不能删除'; }
      var danger = group('删除', [remove]);
      managementActions.append(running, danger); container.append(managementActions);
      var cancel = button('关闭', function () { options.closeDrawer(); });
      document.getElementById('drawer-title').textContent = app.name + ' · 管理';
      document.getElementById('drawer-content').replaceChildren(container);
      document.getElementById('drawer-actions').replaceChildren(cancel);
      options.openDrawer(); cancel.focus();
    }
    async function publish(appId) {
      var app = await get('/apps/' + appId);
      unwrap(await client.post('/apps/' + appId + '/publish', {}, { preconditions: { ifMatch: '"' + app.revision + '"' } }));
      options.toast('已发布'); await render();
    }
    async function permissions(appId) {
      if (!confirmDrawerClose()) return;
      var app = null, draft = null, readSequence = 0, pendingRefresh = false, ready = false;
      var container = el('div', undefined, 'app-permissions'), form = el('fieldset'), content = el('div', undefined, 'app-permission-content');
      var notice = el('p', '正在读取权限…', 'app-permission-notice'); notice.setAttribute('role', 'status');
      form.append(content); form.disabled = true; container.append(notice, form);
      var state = { appId: appId, container: container, notice: notice, busy: false, dirty: false, refresh: refresh };
      permissionView = state;
      var done = button('取消', function () { options.closeDrawer(); });
      var save = button('保存权限', commit); save.className = 'btn-primary'; save.disabled = true;
      document.getElementById('drawer-title').textContent = '应用权限';
      document.getElementById('drawer-content').replaceChildren(container);
      document.getElementById('drawer-actions').replaceChildren(done, save);
      options.openDrawer(); done.focus();
      function active() { return permissionView === state && container.isConnected && document.getElementById('drawer').classList.contains('active'); }
      function report(message, error) { notice.textContent = message; notice.hidden = !message; notice.classList.toggle('error', !!error); }
      function resetDraft() {
        draft = { enabled: app.permissions.enabled, generationScope: app.permissions.generationScope.slice(), resources: app.permissions.resources.slice() };
        state.dirty = false; save.disabled = true;
      }
      async function refresh() {
        if (!active()) return;
        if (state.busy) { pendingRefresh = true; return; }
        if (state.dirty) return;
        var ticket = ++readSequence;
        form.disabled = true; save.disabled = true; report('正在读取权限…');
        try {
          var fresh = await get('/apps/' + appId);
          if (!active() || ticket !== readSequence) return;
          app = fresh; ready = true; resetDraft(); draw(); report('');
        } catch (error) {
          if (!active() || ticket !== readSequence) return;
          ready = false; report((error.message || String(error)) + '。请关闭后重新打开权限设置。', true);
        } finally {
          if (active() && ticket === readSequence) form.disabled = !ready;
        }
      }
      function change(input) {
        if (!active() || state.busy || !ready) return;
        Object.assign(draft, input);
        state.dirty = true; save.disabled = false; report(''); draw();
      }
      async function commit() {
        if (!active() || state.busy || !ready || !state.dirty) return;
        var failed = false;
        state.busy = true; readSequence++;
        form.disabled = true; done.disabled = true; save.disabled = true; report('正在保存权限…');
        try {
          var updated = await manage('permissions', Object.assign({ appId: appId, generation: app.permissions.generation }, draft));
          if (!active()) return;
          app = updated; resetDraft(); report(''); options.toast('权限已保存');
        } catch (error) {
          failed = true;
          if (!active()) return;
          report(error.code === 'AUTHORIZATION_CHANGED'
            ? '权限已被其他页面修改。当前输入已保留，请关闭后重新打开权限设置。'
            : (error.message || String(error)) + '。当前输入已保留。', true);
        } finally {
          state.busy = false;
          if (active()) {
            draw(); form.disabled = !ready; done.disabled = false; save.disabled = !state.dirty;
            if (pendingRefresh) { pendingRefresh = false; if (!failed) refresh(); }
          }
        }
      }
      function checkbox(text, checked, action) {
        var label = el('label', undefined, 'switch-label'), input = el('input'), slider = el('span', undefined, 'switch-slider');
        input.type = 'checkbox'; input.checked = checked; slider.setAttribute('aria-hidden', 'true');
        input.onchange = function () { Promise.resolve().then(function () { return action(input.checked); }).catch(fail); };
        label.append(input, slider, el('span', text, 'switch-text')); return label;
      }
      function draw() {
        var opened = new Set(Array.from(content.querySelectorAll('details[open]')).map(function (item) { return item.dataset.group; }));
        document.getElementById('drawer-title').textContent = app.name + ' · 权限';
        content.replaceChildren();
        var master = el('section', undefined, 'app-permission-card');
        master.append(checkbox('允许此应用通过 SDK 调用能力', draft.enabled, function (enabled) { change({ enabled: enabled }); }),
          el('p', '所有权限统一作用于整个应用，草稿和发布共用。自定义原生调用不受 SDK 完整管理。', 'form-help'));
        var permissionActions = el('div', undefined, 'app-actions');
        permissionActions.append(button('重置为默认权限', function () {
          change({ enabled: app.permissions.defaultEnabled, generationScope: app.permissions.defaultGenerationScope.slice(), resources: app.permissions.defaultResources.slice() });
        }));
        master.append(permissionActions, el('p', '重置会同时恢复 SDK 开关、应用数据与绑定动作范围、插件模块权限，点击「保存权限」后生效。', 'form-help'));
        var scope = el('section', undefined, 'app-permission-card');
        scope.append(el('h4', '应用数据与绑定动作范围'), el('p', '关闭后停止调用对应能力，保存或发布代码不会重新开启。', 'form-help'));
        var capabilityLabels = { 'data.read': '读取本应用数据', 'data.write': '保存本应用数据', 'data.delete': '删除本应用数据', 'actions.run': '运行绑定的流程或脚本' };
        C.CAPABILITIES.forEach(function (capability) {
          scope.append(checkbox(capabilityLabels[capability] || capability, draft.generationScope.includes(capability), function (enabled) {
            var selected = draft.generationScope.filter(function (key) { return key !== capability; });
            if (enabled) selected.push(capability); change({ generationScope: selected });
          }));
        });
        content.append(master, scope, el('h4', '插件模块权限'), el('p', (app.__builtin && app.__builtinDefaultPermissions && app.__builtinDefaultPermissions.resources !== 'system' ? '此内置应用使用随包声明的默认权限，可按需调整。' : '此应用使用系统默认运行权限，可按需调整。') + '本地文件、命令与桌面还需在连接配置中启用本地操作服务。', 'form-help'));
        var groups = new Map(), operationLabels = { read: '读取', write: '创建和修改', delete: '删除', execute: '执行', cancel: '取消运行', call: '调用工具', interact: '页面交互', javascript: '执行页面脚本', navigate: '导航', debugger: '调试器', 'tabs.write': '管理标签页', 'windows.write': '管理窗口', 'downloads.read': '读取下载', 'downloads.write': '管理下载', 'nodes.read': '读取节点', 'nodes.write': '修改节点', 'nodes.delete': '删除节点', 'report.read': '读取报告', 'debug.read': '读取调试数据', 'trace.read': '读取追踪记录', 'export.read': '导出' };
        app.permissions.resourceCatalog.forEach(function (item) {
          if (!groups.has(item.group)) groups.set(item.group, []);
          groups.get(item.group).push(item);
        });
        groups.forEach(function (items, group) {
          var panel = el('details', undefined, 'app-permission-scope'); panel.dataset.group = group; panel.open = opened.has(group);
          panel.append(el('summary', group + ' · ' + items.filter(function (item) { return draft.resources.includes(item.name); }).length + '/' + items.length));
          if (items.length > 1) panel.append(checkbox('允许此模块全部权限', items.every(function (item) { return draft.resources.includes(item.name); }), function (enabled) {
            var names = items.map(function (item) { return item.name; });
            change({ resources: draft.resources.filter(function (name) { return !names.includes(name); }).concat(enabled ? names : []) });
          }));
          items.forEach(function (item) {
            var operation = item.name.slice(item.name.indexOf('.') + 1);
            var label = item.name === 'local.execute' ? '操作本地文件、执行命令和控制桌面' : operationLabels[operation] || operation;
            var control = checkbox(label, draft.resources.includes(item.name), function (enabled) {
              var selected = draft.resources.filter(function (name) { return name !== item.name; });
              if (enabled) selected.push(item.name); change({ resources: selected });
            });
            control.title = item.name + '：' + (item.name === 'local.execute' ? label : item.description);
            panel.append(control);
          });
          content.append(panel);
        });
      }
      await refresh();
    }
    function confirmDrawerClose() {
      if (permissionView && permissionView.container.isConnected && permissionView.busy) {
        permissionView.notice.textContent = '正在保存权限，请完成后再关闭。'; return false;
      }
      if (permissionView && permissionView.container.isConnected && permissionView.dirty && !confirm('放弃未保存的权限修改？')) return false;
      if (editor && editor.container.isConnected) {
        if (editor.busy) { editor.notice.textContent = '正在处理，请完成后再关闭。'; return false; }
        if (editor.dirty && !confirm('放弃当前未保存的输入？')) return false;
      }
      editor = null; permissionView = null;
      return true;
    }
    async function edit(appId) {
      if (editor && editor.container.isConnected) { editor.focus(); return; }
      if (!confirmDrawerClose()) return;
      var loading = el('p', '正在读取草稿…', 'drawer-hint');
      document.getElementById('drawer-title').textContent = '编辑代码';
      document.getElementById('drawer-content').replaceChildren(loading);
      document.getElementById('drawer-actions').replaceChildren(button('取消', function () { options.closeDrawer(); }));
      options.openDrawer();
      var app;
      try { app = await get('/apps/' + appId + '/draft'); }
      catch (error) {
        if (!loading.isConnected || !document.getElementById('drawer').classList.contains('active')) return;
        loading.textContent = error.message || String(error); throw error;
      }
      if (!loading.isConnected || !document.getElementById('drawer').classList.contains('active')) return;
      if (app.__builtin) { showManagement(app); return; }
      var container = el('div', undefined, 'app-editor'), notice = el('p', '已保存', 'app-editor-notice');
      notice.setAttribute('role', 'status');
      editor = { appId: appId, revision: app.revision, container: container, notice: notice, dirty: false, busy: false, inputGeneration: 0 };
      var activeEditor = editor, name = el('input'), description = el('textarea'), slug = el('input');
      name.type = 'text'; name.required = true; name.maxLength = C.limits.nameLength; name.placeholder = '应用名称，最多 ' + C.limits.nameLength + ' 个字符'; name.value = app.name;
      slug.value = app.slug || '';
      description.rows = 2; description.value = app.description || ''; description.placeholder = '简要说明应用用途';
      function field(label, input, id) {
        var row = el('div', undefined, 'form-row'), caption = el('label', label);
        input.id = id; caption.htmlFor = id; row.append(caption, input); return row;
      }
      var metadata = el('div', undefined, 'app-editor-meta');
      metadata.append(field('应用名称', name, 'app-edit-name'), addressField(slug, 'app-edit-slug'));
      var tabs = el('div', undefined, 'app-editor-tabs'), panes = el('div'), inputs = {}, tabButtons = [];
      tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '源码类型');
      var fields = [['html', 'HTML'], ['css', 'CSS'], ['javascript', 'JavaScript'], ['themeCss', '主题'], ['declarations', '功能与依赖']];
      var declarations = Object.assign({}, app.code); ['html', 'css', 'javascript', 'themeCss', 'description', 'files'].forEach(function (key) { delete declarations[key]; });
      fields.forEach(function (field, index) {
        var input = el('page-code-editor'); input.setAttribute('aria-label', field[1]); input.className = 'app-source'; input.hidden = index !== 0;
        input.setAttribute('language', { html: 'html', css: 'css', javascript: 'javascript', themeCss: 'css', declarations: 'json' }[field[0]]);
        input.rows = 20;
        input.id = 'app-source-' + field[0];
        input.value = field[0] === 'declarations' ? JSON.stringify(declarations, null, 2) : app.code[field[0]];
        if (field[0] === 'declarations') {
          var properties = Object.assign({}, C.codeSchema.properties);
          ['html', 'css', 'javascript', 'themeCss', 'description', 'files'].forEach(function (key) { delete properties[key]; });
          input.schema = { type: 'object', properties: properties, required: C.codeSchema.required.filter(function (key) { return Object.hasOwn(properties, key); }), additionalProperties: false };
        }
        inputs[field[0]] = input; panes.append(input);
        var tab = button(field[1], function () {
          Object.values(inputs).forEach(function (item) { item.hidden = item !== input; });
          tabButtons.forEach(function (item) { item.setAttribute('aria-pressed', String(item === tab)); });
          input.focus();
        });
        tab.className = 'app-editor-tab'; tab.setAttribute('aria-pressed', String(index === 0)); tab.setAttribute('aria-controls', input.id);
        tabButtons.push(tab); tabs.append(tab);
      });
      var fileSources = Object.assign({}, app.code.files), filePane = el('div'), fileSelect = el('select'), fileEditor = el('page-code-editor');
      filePane.id = 'app-source-files'; filePane.hidden = true;
      fileSelect.setAttribute('aria-label', '选择源码文件'); fileEditor.setAttribute('aria-label', '源码文件内容'); fileEditor.rows = 20; fileEditor.className = 'app-source';
      function selectFile() {
        var name = fileSelect.value;
        fileEditor.value = name ? fileSources[name] : ''; fileEditor.readOnly = !name;
        fileEditor.setAttribute('language', name.endsWith('.css') ? 'css' : 'javascript');
      }
      function loadFiles(files) {
        var selected = fileSelect.value;
        fileSources = Object.assign({}, files); fileSelect.replaceChildren();
        Object.keys(fileSources).forEach(function (name) { var option = el('option', name); option.value = name; fileSelect.append(option); });
        if (!fileSelect.childElementCount) { var empty = el('option', '暂无源码文件'); empty.value = ''; fileSelect.append(empty); }
        if (Object.prototype.hasOwnProperty.call(fileSources, selected)) fileSelect.value = selected;
        selectFile();
      }
      fileSelect.onchange = selectFile;
      fileEditor.addEventListener('input', function () { if (fileSelect.value) fileSources[fileSelect.value] = fileEditor.value; });
      var fileActions = el('div', undefined, 'form-row app-actions app-source-file-actions');
      var addFile = button('新增文件', function () {
        var name = prompt('源码文件名，例如 helpers.js 或 layout.css'); if (name === null) return;
        name = C.sourceFileName(name.trim());
        if (Object.prototype.hasOwnProperty.call(fileSources, name)) throw new Error('文件已存在');
        fileSources[name] = ''; loadFiles(fileSources); fileSelect.value = name; selectFile(); markDirty();
      }); addFile.className = 'btn-primary';
      var removeFile = button('删除文件', function () {
        var name = fileSelect.value; if (!name || !confirm('删除源码文件 ' + name + '？请同时移除对它的引用。')) return;
        delete fileSources[name]; loadFiles(fileSources); markDirty();
      }); removeFile.className = 'btn-danger';
      fileActions.append(fileSelect, addFile, removeFile);
      filePane.append(fileActions, fileEditor); filePane.focus = function () { fileEditor.focus(); }; inputs.files = filePane; panes.append(filePane); loadFiles(fileSources);
      var fileTab = button('源码文件', function () {
        Object.values(inputs).forEach(function (item) { item.hidden = item !== filePane; });
        tabButtons.forEach(function (item) { item.setAttribute('aria-pressed', String(item === fileTab)); }); filePane.focus();
      });
      fileTab.className = 'app-editor-tab'; fileTab.setAttribute('aria-pressed', 'false'); fileTab.setAttribute('aria-controls', filePane.id); tabButtons.push(fileTab); tabs.append(fileTab);
      function report(message, error) { notice.textContent = message; notice.classList.toggle('error', !!error); }
      function markDirty() {
        activeEditor.dirty = true; activeEditor.inputGeneration++;
        if (!activeEditor.busy) report('有变更未保存');
      }
      [name, slug, description].forEach(function (input) { input.addEventListener('input', markDirty); });
      panes.addEventListener('input', markDirty);
      activeEditor.focus = function () { options.openDrawer(); Object.values(inputs).find(function (input) { return !input.hidden; }).focus(); };
      var review = el('section', undefined, 'app-editor-review'); review.hidden = true;
      var asset = el('input'); asset.type = 'file'; asset.accept = 'image/*,.woff,.woff2,.ttf,.otf';
      var controls = [];
      async function runBusy(message, action) {
        if (editor !== activeEditor || activeEditor.busy) return;
        activeEditor.busy = true; report(message);
        controls.forEach(function (control) { control.disabled = true; }); asset.disabled = true;
        review.querySelectorAll('button').forEach(function (control) { control.disabled = true; });
        try { await action(); }
        catch (error) {
          if (error.code === 'REVISION_CONFLICT') refresh.hidden = false;
          report(error.message || String(error), true); throw error;
        }
        finally {
          activeEditor.busy = false; controls.forEach(function (control) { control.disabled = false; }); asset.disabled = false;
          review.querySelectorAll('button').forEach(function (control) { control.disabled = false; });
          if (activeEditor.dirty && !notice.classList.contains('error')) report('有变更未保存');
        }
      }
      var save = button('保存草稿', function () {
        name.value = name.value.trim();
        if (name.value.length > C.limits.nameLength) { options.toast('应用名称最多 ' + C.limits.nameLength + ' 个字符', true); name.focus(); return; }
        if (!name.reportValidity()) return;
        return runBusy('正在保存草稿…', async function () {
          slug.value = C.slug(slug.value) || '';
          review.hidden = true;
          var fields = { description: description.value }, inputGeneration = activeEditor.inputGeneration, savedRevision = activeEditor.revision;
          var metadata = { name: name.value, slug: slug.value, description: description.value };
          ['html', 'css', 'javascript', 'themeCss'].forEach(function (key) { fields[key] = inputs[key].value; });
          fields.files = Object.assign({}, fileSources);
          var code = await root.AppBackup.work('prepare-code', { declarations: inputs.declarations.value, fields: fields, scope: app.permissions.generationScope });
          var current = unwrap(await client.put('/apps/' + appId + '/draft', Object.assign(metadata, { code: code }), { preconditions: { ifMatch: '"' + savedRevision + '"' } }));
          activeEditor.revision = current.revision; activeEditor.dirty = activeEditor.inputGeneration !== inputGeneration; app = current;
          refresh.hidden = true;
          report(activeEditor.dirty ? '有变更未保存' : '已保存'); await render();
        });
      });
      save.className = 'btn-primary';
      var preview = button('打开预览', function () {
        return runBusy('正在打开预览…', async function () {
          await manage('open', { appId: appId, slot: 'draft' }); report('已打开预览');
        });
      });
      var publishButton = button('发布', function () {
        return runBusy('正在发布…', async function () {
          review.hidden = true;
          var current = unwrap(await client.post('/apps/' + appId + '/publish', {}, { preconditions: { ifMatch: '"' + activeEditor.revision + '"' } }));
          refresh.hidden = true;
          activeEditor.revision = current.revision; app = current; report('已发布'); await render();
        });
      });
      var refresh = button('查看最新代码', function () {
        return runBusy('正在读取最新草稿…', async function () {
          var current = await get('/apps/' + appId + '/draft'), external = el('page-code-editor');
          external.className = 'app-source'; external.readOnly = true; external.setAttribute('language', 'json'); external.rows = 20;
          external.setAttribute('aria-label', '外部最新源码');
          external.value = JSON.stringify({ name: current.name, slug: current.slug || '', description: current.description, code: current.code }, null, 2);
          var reviewActions = el('div', undefined, 'app-actions');
          reviewActions.append(
            button('保留输入，采用最新版本', function () {
              if (activeEditor.busy || editor !== activeEditor) return;
              activeEditor.revision = current.revision; activeEditor.dirty = true; app = current;
              refresh.hidden = true;
              report('有变更未保存'); review.hidden = true;
            }),
            button('载入最新草稿', function () {
              if (activeEditor.busy || editor !== activeEditor) return;
              if (activeEditor.dirty && !confirm('确认放弃当前未保存输入，载入上述最新草稿？')) return;
              name.value = current.name; slug.value = current.slug || ''; description.value = current.description || '';
              var declarations = Object.assign({}, current.code);
              ['html', 'css', 'javascript', 'themeCss'].forEach(function (key) { inputs[key].value = current.code[key]; delete declarations[key]; });
              delete declarations.description;
              delete declarations.files; loadFiles(current.code.files);
              inputs.declarations.value = JSON.stringify(declarations, null, 2);
              activeEditor.inputGeneration++;
              refresh.hidden = true;
              activeEditor.revision = current.revision; activeEditor.dirty = false; app = current; report('已载入最新草稿。'); review.hidden = true;
            }), button('收起', function () { review.hidden = true; }));
          review.replaceChildren(el('h4', '核对最新草稿 · ' + current.name), el('p', '原编辑器输入仍保留。可复制需要合并的内容，再选择保留输入或载入最新草稿。', 'form-help'), external, reviewActions);
          review.hidden = false; report('已读取最新草稿，请核对下方内容。'); review.scrollIntoView({ block: 'start' });
        });
      });
      refresh.className = 'btn-small'; refresh.hidden = true;
      activeEditor.showExternalChange = function () {
        refresh.hidden = false;
        report('代码已在其他位置更新' + (activeEditor.dirty ? ' · 有变更未保存' : ''));
      };
      controls.push(save, preview, publishButton, refresh);
      var status = el('div', undefined, 'app-editor-status'); status.append(notice, refresh);
      asset.onchange = async function () {
        var file = asset.files[0]; if (!file) return;
        try {
          await runBusy('正在保存主题资源…', async function () {
            review.hidden = true;
            var current = await root.AppBackup.work('asset', { appId: appId, revision: activeEditor.revision, name: file.name, file: file });
            activeEditor.revision = current.revision;
            refresh.hidden = true;
            await manage('content-committed', { appId: appId, revision: current.revision });
            report('主题资源已保存：app-asset:assets/' + file.name + '。当前代码输入仍保留，需单独保存。');
          });
        } catch (error) { fail(error); }
        asset.value = '';
      };
      var assetRow = field('主题图片和字体', asset, 'app-edit-asset');
      assetRow.append(el('p', '文件名使用字母、数字、点、横线或下划线。上传后用 app-asset:assets/文件名 引用。', 'form-help'));
      metadata.append(assetRow, field('应用描述', description, 'app-edit-description'));
      var source = el('div'); source.append(tabs, panes);
      container.append(metadata, source, review);
      document.getElementById('drawer-title').textContent = app.name + ' · 编辑代码';
      document.getElementById('drawer-content').replaceChildren(container);
      document.getElementById('drawer-actions').replaceChildren(save, preview, publishButton, status);
      activeEditor.focus();
    }
    function onChanged(event) {
      if (event.type !== 'APP_CHANGED') return;
      if (event.change === 'deleted') writeLayout([], function (next) {
        ['order', 'favorites'].forEach(function (key) { next[key] = next[key].filter(function (id) { return id !== event.appId; }); });
      }).catch(fail);
      if (permissionView && event.appId === permissionView.appId && !document.hidden) permissionView.refresh();
      if (editor && !editor.busy && event.appId === editor.appId && event.revision && event.revision !== editor.revision) editor.showExternalChange();
      if (options.isActive() && !document.hidden) render().catch(fail);
    }
    function onLayoutChanged(changes, area) {
      if (area !== 'local' || !changes[layoutKey] || disposed) return;
      layout = normalizeLayout(changes[layoutKey].newValue);
      if (options.isActive() && !document.hidden) draw();
    }
    function visible() {
      if (document.hidden) return;
      if (permissionView) permissionView.refresh();
      if (options.isActive()) render().catch(fail);
      var currentEditor = editor;
      if (currentEditor) get('/apps/' + currentEditor.appId).then(function (app) {
        if (editor === currentEditor && !currentEditor.busy && app.revision !== currentEditor.revision) currentEditor.showExternalChange();
      }).catch(function (error) { if (editor === currentEditor && !currentEditor.busy) currentEditor.notice.textContent = error.message + '，当前输入仍保留'; });
    }
    chrome.runtime.onMessage.addListener(onChanged); document.addEventListener('visibilitychange', visible);
    chrome.storage.onChanged.addListener(onLayoutChanged);
    return { render: render, edit: edit, permissions: permissions, manage: manage, confirmDrawerClose: confirmDrawerClose, destroy: function () {
      disposed = true; sequence++; endDrag();
      chrome.runtime.onMessage.removeListener(onChanged); document.removeEventListener('visibilitychange', visible);
      chrome.storage.onChanged.removeListener(onLayoutChanged);
      editor = null; permissionView = null;
    } };
  }
  root.OptionsAppController = Object.freeze({ create: create });
})(globalThis);
