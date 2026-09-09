// Builtin Skill Loader — loads packaged SKILL.md bundles into read-only Knowledge P4.
(function attachBuiltinSkillLoader(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BuiltinSkillLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var INDEX_PATH = 'builtin-skills/index.json';

  function safePath(value, label) {
    var path = String(value || '').trim();
    if (!path || path.charAt(0) === '/' || path.indexOf('\\') !== -1) {
      throw new Error((label || '路径') + ' 无效: ' + path);
    }
    var parts = path.split('/');
    if (parts.some(function (part) { return !part || part === '.' || part === '..'; })) {
      throw new Error((label || '路径') + ' 禁止空段、. 或 ..: ' + path);
    }
    return parts.join('/');
  }

  function basename(path) {
    var parts = String(path || '').split('/');
    return parts[parts.length - 1] || '';
  }

  function createBuiltinSkillLoader(deps) {
    deps = deps || {};
    var chrome = deps.chrome || (typeof globalThis !== 'undefined' ? globalThis.chrome : null);
    var fetchImpl = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    var skillKnowledge = deps.skillKnowledge;
    if (!chrome || !chrome.runtime || typeof chrome.runtime.getURL !== 'function') {
      throw new Error('BuiltinSkillLoader requires chrome.runtime.getURL');
    }
    if (typeof fetchImpl !== 'function') throw new Error('BuiltinSkillLoader requires fetch');
    if (!skillKnowledge || typeof skillKnowledge.syncBuiltinCatalog !== 'function') {
      throw new Error('BuiltinSkillLoader requires SkillKnowledge.syncBuiltinCatalog');
    }

    function resourceUrl(path) {
      return chrome.runtime.getURL(path);
    }

    function loadResponse(path) {
      return fetchImpl(resourceUrl(path), { cache: 'no-store' }).then(function (response) {
        if (!response || !response.ok) {
          throw new Error(path + ' 加载失败: HTTP ' + (response && response.status || 0));
        }
        return response;
      });
    }

    function loadJson(path) {
      return loadResponse(path).then(function (response) { return response.json(); });
    }

    function loadText(path) {
      return loadResponse(path).then(function (response) { return response.text(); });
    }

    function validateIndex(index) {
      if (!index || typeof index !== 'object' || Array.isArray(index)) {
        throw new Error('内置 Skill 索引必须为对象');
      }
      if (Number(index.version) !== 1) throw new Error('不支持的内置 Skill 索引版本: ' + index.version);
      if (!Array.isArray(index.skills)) throw new Error('内置 Skill 索引缺少 skills 数组');
      var entries = index.skills;
      var ids = Object.create(null);
      return entries.map(function (entry, indexValue) {
        entry = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
        var id = String(entry.id || '').trim();
        if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) throw new Error('内置 Skill id 无效: ' + id);
        if (ids[id]) throw new Error('内置 Skill id 重复: ' + id);
        ids[id] = true;
        var rootPath = safePath(entry.path || id, '内置 Skill path');
        if (rootPath !== id) throw new Error('内置 Skill path 必须与 id 一致: ' + id + ' != ' + rootPath);
        var rawFiles = Array.isArray(entry.files) ? entry.files : [];
        if (!rawFiles.length) throw new Error('内置 Skill files 为空: ' + id);
        var filesSeen = Object.create(null);
        var files = rawFiles.map(function (file) {
          file = safePath(file, '内置 Skill file');
          if (filesSeen[file]) throw new Error('内置 Skill file 重复: ' + id + '/' + file);
          filesSeen[file] = true;
          return file;
        });
        if (!filesSeen['SKILL.md']) throw new Error('内置 Skill 缺少 SKILL.md: ' + id);
        return { id: id, path: rootPath, files: files, index: indexValue };
      });
    }

    function loadPackage(entry) {
      return Promise.all(entry.files.map(function (relativePath) {
        var packagePath = entry.path + '/' + relativePath;
        return loadText('builtin-skills/' + packagePath).then(function (content) {
          return {
            path: packagePath,
            name: basename(relativePath),
            type: /\.md$/i.test(relativePath) ? 'text/markdown' : 'text/plain',
            size: content.length,
            text: content,
          };
        });
      })).then(function (files) {
        return {
          builtinId: entry.id,
          name: entry.id,
          sourceUri: 'skill://builtin/' + entry.id + '/SKILL.md',
          files: files,
        };
      });
    }

    function loadPackages() {
      return loadJson(INDEX_PATH).then(validateIndex).then(function (entries) {
        return Promise.all(entries.map(loadPackage));
      });
    }

    function sync() {
      return loadPackages().then(function (packages) {
        return skillKnowledge.syncBuiltinCatalog(packages);
      });
    }

    return Object.freeze({
      INDEX_PATH: INDEX_PATH,
      loadPackages: loadPackages,
      sync: sync,
    });
  }

  return Object.freeze({
    INDEX_PATH: INDEX_PATH,
    createBuiltinSkillLoader: createBuiltinSkillLoader,
  });
});
