// Skill Knowledge — import SKILL.md packages into Knowledge P4.
(function attachSkillKnowledge(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.SkillKnowledge = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LARGE_SKILL_MD_CHARS = 120000;
  var LARGE_RESOURCE_TEXT_CHARS = 240000;
  var LARGE_TOTAL_TEXT_CHARS = 1000000;

  function clone(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function compactString(value, max) {
    var text = String(value === undefined || value === null ? '' : value);
    max = Math.max(20, Number(max) || 2000);
    return text.length > max ? text.slice(0, max).replace(/\s+$/g, '') : text;
  }

  function sanitizeSingleLine(value, max) {
    return compactString(String(value || '').replace(/\s+/g, ' ').trim(), max || 2000);
  }

  function normalizePath(value) {
    var text = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    var parts = [];
    text.split('/').forEach(function (part) {
      part = part.trim();
      if (!part || part === '.') return;
      if (part === '..') return;
      parts.push(part);
    });
    return parts.join('/');
  }

  function basename(path) {
    path = normalizePath(path);
    var parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  function dirname(path) {
    path = normalizePath(path);
    var idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  }

  function slugify(value) {
    var slug = String(value || '').trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 64);
    return slug || ('skill-' + hashText(String(value || 'skill')).slice(0, 10));
  }

  function hashText(text) {
    text = String(text || '');
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function stripQuotes(value) {
    value = String(value === undefined || value === null ? '' : value).trim();
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"')
      || (value.charAt(0) === '\'' && value.charAt(value.length - 1) === '\'')) {
      value = value.slice(1, -1);
    }
    return value.replace(/\\"/g, '"').replace(/\\'/g, '\'').trim();
  }

  function extractFrontmatter(markdown) {
    var text = String(markdown || '').replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/);
    if (!lines.length || lines[0].trim() !== '---') {
      throw new Error('Skill 导入失败：SKILL.md 必须以 YAML frontmatter 开头');
    }
    var fm = [];
    var end = -1;
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i;
        break;
      }
      fm.push(lines[i]);
    }
    if (end === -1 || !fm.length) throw new Error('Skill 导入失败：SKILL.md frontmatter 缺少结束 ---');
    return {
      frontmatter: fm.join('\n'),
      body: lines.slice(end + 1).join('\n').trim(),
    };
  }

  function parseFrontmatterScalarLines(text) {
    var lines = String(text || '').split(/\r?\n/);
    var out = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || /^\s*#/.test(line)) continue;
      var match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      var key = match[1];
      var raw = match[2] || '';
      var blockMatch = /^([|>])[-+]?$/.exec(raw.trim());
      if (blockMatch) {
        var blockMode = blockMatch[1];
        var block = [];
        var baseIndent = null;
        while (i + 1 < lines.length) {
          var next = lines[i + 1];
          if (!/^\s+/.test(next) && next.trim()) break;
          i += 1;
          if (!next.trim()) {
            block.push('');
            continue;
          }
          var indent = (/^\s*/.exec(next) || [''])[0].length;
          if (baseIndent === null || indent < baseIndent) baseIndent = indent;
          block.push(next);
        }
        baseIndent = baseIndent || 0;
        out[key] = block.map(function (item) { return item.slice(Math.min(baseIndent, (/^\s*/.exec(item) || [''])[0].length)); }).join(blockMode === '>' ? ' ' : '\n').trim();
      } else {
        var scalar = raw.trim();
        if (!/^['"]/.test(scalar)) scalar = scalar.replace(/\s+#.*$/, '');
        out[key] = stripQuotes(scalar);
      }
    }
    return out;
  }

  function parseSkillMarkdown(markdown, fallbackName) {
    markdown = String(markdown || '');
    if (!markdown.trim()) throw new Error('Skill 导入失败：SKILL.md 内容为空');
    var extracted = extractFrontmatter(markdown);
    var meta = parseFrontmatterScalarLines(extracted.frontmatter);
    var name = sanitizeSingleLine(meta.name || fallbackName || '', 120);
    var description = sanitizeSingleLine(meta.description || '', 1200);
    if (!name) throw new Error('Skill 导入失败：frontmatter 缺少 name');
    if (!description) throw new Error('Skill 导入失败：frontmatter 缺少 description');
    var warnings = [];
    if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
      warnings.push('name 不是 Codex 推荐的 hyphen-case；已保留原值并用归一化 slug 存储');
    }
    if (markdown.length > LARGE_SKILL_MD_CHARS) warnings.push('SKILL.md 较大（' + markdown.length + ' 字符），导入和检索可能变慢；正文会完整拆分为 P4 文本分片保存');
    if (description.length > 1024) warnings.push('description 超过 1024 字符，触发判断可能不够聚焦');
    if (!extracted.body) warnings.push('SKILL.md 正文为空，只会作为 Skill 目录元数据使用');
    return {
      name: name,
      slug: slugify(name),
      description: description,
      body: extracted.body,
      frontmatter: meta,
      rawFrontmatter: extracted.frontmatter,
      raw: markdown,
      warnings: warnings,
    };
  }

  function findSkillFile(files) {
    files = Array.isArray(files) ? files : [];
    var exact = null;
    var loose = null;
    function shallower(next, current) {
      if (!current) return true;
      var nextPath = normalizePath(next && (next.path || next.webkitRelativePath || next.name));
      var currentPath = normalizePath(current && (current.path || current.webkitRelativePath || current.name));
      return nextPath.split('/').length < currentPath.split('/').length;
    }
    files.forEach(function (file) {
      var path = normalizePath(file && (file.path || file.webkitRelativePath || file.name));
      var base = basename(path);
      if (base === 'SKILL.md' && shallower(file, exact)) exact = file;
      else if (base.toLowerCase() === 'skill.md' && shallower(file, loose)) loose = file;
    });
    return exact || loose || null;
  }

  function relativeToSkillRoot(filePath, skillPath) {
    filePath = normalizePath(filePath);
    skillPath = normalizePath(skillPath);
    var rootDir = dirname(skillPath);
    if (rootDir && filePath.indexOf(rootDir + '/') === 0) return filePath.slice(rootDir.length + 1);
    return filePath;
  }

  function classifyResource(path) {
    var normalized = normalizePath(path);
    if (/^references\//i.test(normalized)) return 'reference';
    if (/^scripts\//i.test(normalized)) return 'script';
    if (/^assets\//i.test(normalized)) return 'asset';
    if (/^agents\//i.test(normalized)) return 'agent-metadata';
    return 'extra';
  }

  function extname(path) {
    var base = basename(path).toLowerCase();
    var idx = base.lastIndexOf('.');
    return idx === -1 ? '' : base.slice(idx);
  }

  function runtimeInfoForPath(path, kind) {
    path = normalizePath(path);
    kind = kind || classifyResource(path);
    var ext = extname(path);
    var map = {
      '.py': ['Python', 'requires a Python interpreter and installed packages'],
      '.sh': ['POSIX shell', 'requires a local shell'],
      '.bash': ['Bash', 'requires a local Bash shell'],
      '.zsh': ['Zsh', 'requires a local Zsh shell'],
      '.fish': ['Fish shell', 'requires a local Fish shell'],
      '.ps1': ['PowerShell', 'requires PowerShell'],
      '.bat': ['Windows batch', 'requires Windows command shell'],
      '.cmd': ['Windows command script', 'requires Windows command shell'],
      '.js': ['JavaScript', 'may be browser or Node.js code; imported text is not registered as an extension script'],
      '.mjs': ['JavaScript module', 'may be browser or Node.js code; imported text is not registered as an extension module'],
      '.cjs': ['Node.js CommonJS', 'requires Node.js'],
      '.ts': ['TypeScript', 'requires compilation or a TypeScript runtime'],
      '.tsx': ['TypeScript/React', 'requires compilation or a TypeScript runtime'],
      '.jsx': ['JavaScript/React', 'requires a compatible JS runtime and bundling when applicable'],
      '.rb': ['Ruby', 'requires Ruby'],
      '.php': ['PHP', 'requires PHP'],
      '.pl': ['Perl', 'requires Perl'],
      '.r': ['R', 'requires R'],
      '.lua': ['Lua', 'requires Lua'],
      '.go': ['Go', 'requires compilation or Go toolchain'],
      '.rs': ['Rust', 'requires compilation or Rust toolchain'],
      '.java': ['Java', 'requires compilation and JVM'],
      '.kt': ['Kotlin', 'requires compilation and JVM'],
      '.cs': ['.NET/C#', 'requires .NET runtime or compilation'],
      '.swift': ['Swift', 'requires Swift toolchain'],
      '.sql': ['SQL', 'requires a database engine'],
      '.dockerfile': ['Docker', 'requires Docker or compatible container runtime'],
    };
    var lower = basename(path).toLowerCase();
    var mapped = map[ext] || (lower === 'dockerfile' ? map['.dockerfile'] : null);
    if (kind !== 'script' && !mapped) {
      return {
        runtime: 'none',
        executionMode: 'knowledge-reference',
        browserSupport: 'not an executable Skill script',
        note: 'stored as reference knowledge',
      };
    }
    if (!mapped) {
      mapped = ['Unknown script runtime', 'requires a configured runner or browser-native rewrite'];
    }
    return {
      runtime: mapped[0],
      executionMode: 'reference-only',
      browserSupport: 'not executable by this browser extension from an imported Skill package',
      note: mapped[1],
    };
  }

  function runtimeCatalog(pkg) {
    var seen = {};
    var lines = [];
    function add(path, kind) {
      path = normalizePath(path);
      kind = kind || classifyResource(path);
      if (!path || kind !== 'script' || seen[path]) return;
      seen[path] = true;
      var info = runtimeInfoForPath(path, kind);
      lines.push('- ' + path + ': runtime=' + info.runtime + '; extension support=' + info.browserSupport + '; ' + info.note + '.');
    }
    (pkg.resources || []).forEach(function (resource) {
      add(resource.originalPath || resource.path, resource.kind);
    });
    (pkg.unsupportedResources || []).forEach(function (resource) {
      add(resource.path, resource.kind);
    });
    return lines;
  }

  function normalizeFiles(input) {
    var files = Array.isArray(input && input.files) ? input.files : [];
    return files.map(function (file) {
      file = file && typeof file === 'object' ? file : {};
      return {
        path: normalizePath(file.path || file.webkitRelativePath || file.name || ''),
        name: String(file.name || basename(file.path || '') || '').trim(),
        type: String(file.type || '').trim(),
        size: Math.max(0, Number(file.size) || 0),
        text: typeof file.text === 'string' ? file.text : (typeof file.content === 'string' ? file.content : ''),
        textStored: file.textStored !== false && (typeof file.text === 'string' || typeof file.content === 'string'),
        reason: String(file.reason || '').trim(),
      };
    }).filter(function (file) { return !!file.path; });
  }

  function resourcesFromFiles(files, skillFile) {
    var skillPath = normalizePath(skillFile && (skillFile.path || skillFile.webkitRelativePath || skillFile.name) || 'SKILL.md');
    var rootDir = dirname(skillPath);
    var resources = [];
    var unsupported = [];
    var warnings = [];
    var totalChars = 0;
    files.forEach(function (file) {
      var path = normalizePath(file.path);
      if (!path || path === skillPath) return;
      if (rootDir && path.indexOf(rootDir + '/') !== 0) return;
      if (basename(path).toLowerCase() === 'skill.md') return;
      var relativePath = relativeToSkillRoot(path, skillPath);
      if (!relativePath || relativePath === 'SKILL.md') return;
      var text = String(file.text || '');
      if (!text) {
        unsupported.push({
          path: relativePath,
          kind: classifyResource(relativePath),
          type: file.type || '',
          size: file.size || 0,
          reason: file.reason || 'non-text-or-unreadable',
        });
        return;
      }
      totalChars += text.length;
      if (text.length > LARGE_RESOURCE_TEXT_CHARS) {
        warnings.push('资源 ' + relativePath + ' 较大（' + text.length + ' 字符），全文内联到 Skill 主知识，检索可能变慢');
      }
      resources.push({
        path: relativePath,
        kind: classifyResource(relativePath),
        type: file.type || '',
        size: file.size || text.length,
        text: text,
        textStored: true,
      });
    });
    if (totalChars > LARGE_TOTAL_TEXT_CHARS) {
      warnings.push('Skill 文本资源总量较大（' + totalChars + ' 字符），不会截断，但导入、存储和知识检索都会变慢');
    }
    return { resources: resources, unsupported: unsupported, warnings: warnings };
  }

  function prepareSkillPackage(input) {
    input = input || {};
    var files = normalizeFiles(input);
    var skillFile = findSkillFile(files);
    var markdown = skillFile ? String(skillFile.text || '').trim() : String(input.skillMarkdown || input.markdown || '').trim();
    var fallbackName = input.name || (skillFile ? basename(dirname(skillFile.path || skillFile.name)) : '');
    var parsed = parseSkillMarkdown(markdown, fallbackName);
    var fileResources = resourcesFromFiles(files, skillFile || { path: 'SKILL.md' });
    var resources = fileResources.resources || [];
    var unsupportedResources = fileResources.unsupported || [];
    var sourceUri = sanitizeSingleLine(input.sourceUri || input.uri || '', 600);
    var skillKey = 'skill-import:' + parsed.slug;
    var skillUri = 'skill://imported/' + parsed.slug + '/SKILL.md';
    return {
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      rawFrontmatter: parsed.rawFrontmatter,
      rawSkillMarkdown: parsed.raw,
      warnings: (parsed.warnings || []).concat(fileResources.warnings || []),
      resources: resources,
      unsupportedResources: unsupportedResources,
      sourceUri: sourceUri,
      skillKey: skillKey,
      skillUri: skillUri,
      importedAt: Date.now(),
    };
  }

  function prepareBuiltinSkillPackage(input) {
    var pkg = prepareSkillPackage(input || {});
    pkg.builtIn = true;
    pkg.skillKey = 'skill-builtin:' + pkg.slug;
    pkg.skillUri = 'skill://builtin/' + pkg.slug + '/SKILL.md';
    return pkg;
  }

  function buildMainContent(pkg) {
    var unsupportedLimit = 20;
    var runtimeLines = runtimeCatalog(pkg);
    var lines = [
      pkg.builtIn ? 'Built-in Skill(P4).' : 'Imported Skill(P4).',
      '',
      'Skill name: ' + pkg.name,
      'Skill key: ' + pkg.skillKey,
      'Description: ' + pkg.description,
      'Source URI: ' + (pkg.sourceUri || pkg.skillUri),
      '',
      'This single knowledge item contains the complete SKILL.md and the full text of every bundled text resource. No further retrieval is needed for this Skill.',
      'scripts/ and assets/ are reference text only: the extension cannot execute imported scripts, and binary or unreadable resources are listed as unavailable below.',
    ];
    if (runtimeLines.length) {
      lines = lines.concat(['', 'Detected Skill script runtimes:'], runtimeLines);
    }
    if (pkg.warnings.length) {
      lines.push('', 'Import warnings:');
      pkg.warnings.forEach(function (warning) { lines.push('- ' + warning); });
    }
    if (pkg.unsupportedResources && pkg.unsupportedResources.length) {
      lines.push('', 'Unavailable resources (not imported):');
      pkg.unsupportedResources.slice(0, unsupportedLimit).forEach(function (resource) {
        lines.push('- [' + resource.kind + '] ' + compactString(resource.path, 220) + ' (' + (resource.type || 'unknown') + ', ' + (resource.size || 0) + ' bytes, reason=' + resource.reason + ')');
      });
      if (pkg.unsupportedResources.length > unsupportedLimit) {
        lines.push('- ...and ' + (pkg.unsupportedResources.length - unsupportedLimit) + ' more skipped resources.');
      }
    }
    lines.push('', 'SKILL.md frontmatter:', pkg.rawFrontmatter);
    lines.push('', 'SKILL.md body:', pkg.body || '(empty)');
    (pkg.resources || []).forEach(function (resource) {
      lines.push(
        '',
        '--- Bundled resource: ' + resource.path + ' [' + resource.kind + ', ' + (resource.type || 'unknown') + ', ' + (resource.size || 0) + ' bytes] ---',
        resource.text || ''
      );
    });
    return lines.join('\n');
  }

  function tagsForPackage(pkg) {
    var tags = ['Skill', 'Skill(P4)', pkg.builtIn ? '内置 Skill' : '导入 Skill', pkg.name, pkg.slug];
    if (pkg.builtIn) tags.push('builtin-skill');
    var kinds = {};
    pkg.resources.forEach(function (resource) { kinds[resource.kind] = true; });
    Object.keys(kinds).forEach(function (kind) { tags.push(kind); });
    pkg.resources.forEach(function (resource) { tags.push(resource.path); });
    return tags.filter(Boolean);
  }

  // /skills 投影层从这两个结构化字段读取正文与资源全文,不做 content 反解析。
  function skillEmbeddedFields(pkg) {
    return {
      skillInstructions: String(pkg.body || ''),
      skillResources: (pkg.resources || []).map(function (resource) {
        return {
          id: hashText(resource.path),
          path: resource.path,
          kind: resource.kind,
          type: resource.type || '',
          size: resource.size || 0,
          text: resource.text || '',
        };
      }),
    };
  }

  function builtinKnowledgeItems(pkg) {
    var sourceBase = {
      kind: 'skill',
      key: pkg.skillKey,
      uri: pkg.skillUri,
      remoteSync: true,
      managed: 'builtin',
      importer: 'builtin-skill-loader',
    };
    return [Object.assign({
      id: 'builtin_skill_' + pkg.slug.replace(/-/g, '_'),
      type: 'skill',
      sourceKind: 'skill',
      skillImport: true,
      builtinSkill: true,
      title: 'Skill: ' + pkg.name,
      summary: pkg.description,
      content: buildMainContent(pkg),
      tags: tagsForPackage(pkg),
      source: sourceBase,
      confidence: 0.95,
      archived: false,
      builtIn: true,
      protected: true,
      createdAt: 1,
      updatedAt: 1,
    }, skillEmbeddedFields(pkg))];
  }

  function syncBuiltinCatalog(inputs, deps) {
    deps = deps || {};
    var knowledge = deps.knowledge || root.Knowledge;
    var addLog = deps.addLog || function () {};
    if (!knowledge || typeof knowledge.syncBuiltinSkillCatalog !== 'function') {
      return Promise.reject(new Error('Knowledge 未加载或不支持内置 Skill 同步'));
    }
    return Promise.resolve().then(function () {
      var packages = (Array.isArray(inputs) ? inputs : []).map(function (input) {
        var pkg = prepareBuiltinSkillPackage(input || {});
        var expectedId = String(input && input.builtinId || '').trim();
        if (expectedId && pkg.slug !== expectedId) {
          throw new Error('内置 Skill id 与 SKILL.md name 不一致: ' + expectedId + ' != ' + pkg.slug);
        }
        return {
          name: pkg.name,
          slug: pkg.slug,
          description: pkg.description,
          sourceKey: pkg.skillKey,
          resourceCount: pkg.resources.length,
          warnings: pkg.warnings,
          items: builtinKnowledgeItems(pkg),
        };
      });
      return knowledge.syncBuiltinSkillCatalog({ packages: packages }).then(function (result) {
        try { addLog('内置 Skill 已同步: ' + packages.length + ' 个，知识 ' + (result.synced || 0) + ' 条', { scope: 'system', source: 'builtin-skill-loader' }); } catch (_) {}
        return {
          provider: 'skill-knowledge',
          ok: true,
          packages: packages.map(function (pkg) {
            return {
              name: pkg.name,
              slug: pkg.slug,
              description: pkg.description,
              sourceKey: pkg.sourceKey,
              resourceCount: pkg.resourceCount,
              warnings: pkg.warnings,
            };
          }),
          synced: result.synced || 0,
          removed: result.removed || 0,
        };
      });
    });
  }

  function archiveStaleSkillKnowledge(knowledge, pkg, liveKeys) {
    if (!knowledge || typeof knowledge.list !== 'function' || typeof knowledge.get !== 'function' || typeof knowledge.upsert !== 'function') {
      return Promise.resolve({ archived: 0 });
    }
    var archived = 0;
    var cursor = 0;
    function page() {
      return knowledge.list({ sourceKind: 'skill', includeArchived: true, cursor: cursor, limit: 120 }).then(function (result) {
        var items = result && result.items || [];
        var chain = Promise.resolve();
        items.forEach(function (item) {
          var key = item && item.source && item.source.key || '';
          if ((key !== pkg.skillKey && key.indexOf(pkg.skillKey + ':') !== 0) || liveKeys[key] || item.archived) return;
          chain = chain.then(function () {
            return knowledge.get({ id: item.id }).then(function (detail) {
              var full = detail && detail.item || item;
              archived += 1;
              return knowledge.upsert({
                id: full.id,
                type: full.type || 'skill',
                sourceKind: 'skill',
                remoteSync: true,
                title: full.title,
                summary: full.summary || '',
                content: full.content || full.summary || full.title,
                tags: full.tags || [],
                source: Object.assign({}, full.source || {}, { kind: 'skill', remoteSync: true, managed: 'remote', importer: 'skill-knowledge' }),
                skillImport: true,
                archived: true,
                confidence: full.confidence || 0.85,
              });
            });
          });
        });
        return chain.then(function () {
          cursor = result && result.nextCursor !== null && result.nextCursor !== undefined ? result.nextCursor : null;
          return cursor !== null ? page() : { archived: archived };
        });
      });
    }
    return page();
  }

  function archivePackage(input, deps) {
    deps = deps || {};
    input = input || {};
    var knowledge = deps.knowledge || root.Knowledge;
    if (!knowledge || typeof knowledge.list !== 'function' || typeof knowledge.get !== 'function' || typeof knowledge.upsert !== 'function') {
      return Promise.reject(new Error('Knowledge 未加载'));
    }
    var sourceKey = String(input.sourceKey || input.key || '').trim();
    var id = String(input.id || input.knowledgeId || '').trim();
    function resolveKey() {
      if (sourceKey) return Promise.resolve(sourceKey);
      if (!id) return Promise.reject(new Error('缺少 Skill sourceKey'));
      return knowledge.get({ id: id }).then(function (detail) {
        var item = detail && detail.item || {};
        var key = item && item.source && item.source.key || '';
        if (!/^skill-import:[^:]+$/.test(key)) throw new Error('目标不是 Skill 导入主条目: ' + id);
        return key;
      });
    }
    return resolveKey().then(function (prefix) {
      if (!/^skill-import:[^:]+$/.test(prefix)) throw new Error('无效 Skill sourceKey: ' + prefix);
      var archived = 0;
      var cursor = 0;
      function page() {
        return knowledge.list({ sourceKind: 'skill', includeArchived: true, cursor: cursor, limit: 120 }).then(function (result) {
          var items = result && result.items || [];
          var chain = Promise.resolve();
          items.forEach(function (item) {
            var key = item && item.source && item.source.key || '';
            if (item.archived || (key !== prefix && key.indexOf(prefix + ':resource:') !== 0)) return;
            chain = chain.then(function () {
              return knowledge.get({ id: item.id }).then(function (detail) {
                var full = detail && detail.item || item;
                archived += 1;
                return knowledge.upsert({
                  id: full.id,
                  type: full.type || 'skill',
                  sourceKind: 'skill',
                  remoteSync: true,
                  title: full.title,
                  summary: full.summary || '',
                  content: full.content || full.summary || full.title,
                  tags: full.tags || [],
                  source: Object.assign({}, full.source || {}, { kind: 'skill', remoteSync: true, managed: 'remote', importer: 'skill-knowledge' }),
                  skillImport: true,
                  archived: true,
                  confidence: full.confidence || 0.85,
                });
              });
            });
          });
          return chain.then(function () {
            cursor = result && result.nextCursor !== null && result.nextCursor !== undefined ? result.nextCursor : null;
            return cursor !== null ? page() : null;
          });
        });
      }
      return page().then(function () {
        return { provider: 'skill-knowledge', ok: true, sourceKey: prefix, archived: archived };
      });
    });
  }

  function deletePackage(input, deps) {
    deps = deps || {};
    input = input || {};
    var knowledge = deps.knowledge || root.Knowledge;
    if (!knowledge || typeof knowledge.get !== 'function' || typeof knowledge.removeManagedSource !== 'function') {
      return Promise.reject(new Error('Knowledge 未加载或不支持受管知识删除'));
    }
    var sourceKey = String(input.sourceKey || input.key || '').trim();
    var id = String(input.id || input.knowledgeId || '').trim();
    function resolveKey() {
      if (sourceKey) return Promise.resolve(sourceKey);
      if (!id) return Promise.reject(new Error('缺少 Skill sourceKey'));
      return knowledge.get({ id: id }).then(function (detail) {
        var item = detail && detail.item || {};
        var key = item && item.source && item.source.key || '';
        if (!/^skill-import:[^:]+$/.test(key)) throw new Error('目标不是 Skill 导入主条目: ' + id);
        return key;
      });
    }
    return resolveKey().then(function (prefix) {
      if (!/^skill-import:[^:]+$/.test(prefix)) throw new Error('无效 Skill sourceKey: ' + prefix);
      return knowledge.removeManagedSource({
        sourceKind: 'skill',
        sourceKey: prefix,
        includeChildren: true,
      }).then(function (result) {
        return {
          provider: 'skill-knowledge',
          ok: true,
          sourceKey: prefix,
          deleted: result && result.deleted || 0,
        };
      });
    });
  }

  function importPackage(input, deps) {
    return Promise.resolve().then(function () {
      deps = deps || {};
      var knowledge = deps.knowledge || root.Knowledge;
      var addLog = deps.addLog || function () {};
      if (!knowledge || typeof knowledge.upsert !== 'function') throw new Error('Knowledge 未加载');
      var pkg = prepareSkillPackage(input || {});
      var liveKeys = {};
      var imported = 0;
      liveKeys[pkg.skillKey] = true;
      var sourceBase = {
        kind: 'skill',
        key: pkg.skillKey,
        uri: pkg.sourceUri || pkg.skillUri,
        remoteSync: true,
        managed: 'remote',
        importer: 'skill-knowledge',
      };
      var chain = knowledge.upsert(Object.assign({
        type: 'skill',
        sourceKind: 'skill',
        remoteSync: true,
        skillImport: true,
        title: 'Skill: ' + pkg.name,
        summary: pkg.description,
        content: buildMainContent(pkg),
        tags: tagsForPackage(pkg),
        source: sourceBase,
        confidence: 0.9,
        archived: false,
      }, skillEmbeddedFields(pkg))).then(function () {
        imported += 1;
      });
      return chain.then(function () {
        return archiveStaleSkillKnowledge(knowledge, pkg, liveKeys);
      }).then(function (stale) {
        try { addLog('Skill 已导入知识: ' + pkg.name + ' resources=' + pkg.resources.length, { scope: 'system', source: 'skill-knowledge' }); } catch (_) {}
        return {
          provider: 'skill-knowledge',
          ok: true,
          skill: {
            name: pkg.name,
            slug: pkg.slug,
            description: pkg.description,
            sourceKey: pkg.skillKey,
            sourceUri: pkg.sourceUri || pkg.skillUri,
            resourceCount: pkg.resources.length,
            warnings: pkg.warnings,
          },
          imported: imported,
          archived: stale && stale.archived || 0,
        };
      });
    });
  }

  function createSkillKnowledgeImporter(deps) {
    deps = deps || {};
    return {
      importPackage: function (input) { return importPackage(input || {}, deps); },
      archivePackage: function (input) { return archivePackage(input || {}, deps); },
      deletePackage: function (input) { return deletePackage(input || {}, deps); },
      syncBuiltinCatalog: function (inputs) { return syncBuiltinCatalog(inputs || [], deps); },
      prepareSkillPackage: prepareSkillPackage,
      parseSkillMarkdown: parseSkillMarkdown,
    };
  }

  return {
    createSkillKnowledgeImporter: createSkillKnowledgeImporter,
    parseSkillMarkdown: parseSkillMarkdown,
    prepareSkillPackage: prepareSkillPackage,
    importPackage: importPackage,
    syncBuiltinCatalog: syncBuiltinCatalog,
    archivePackage: archivePackage,
    deletePackage: deletePackage,
  };
});
