// Media resource discovery and link rewriting helpers.
(function attachMediaResources(root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MediaResources = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EXTENSION_TYPES = {
    image: /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i,
    video: /\.(?:3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)(?:$|[?#])/i,
    audio: /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)(?:$|[?#])/i,
    hls: /\.m3u8(?:$|[?#])/i,
    dash: /\.mpd(?:$|[?#])/i,
  };

  function decodeHtml(value) {
    return String(value || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  function classifyUrl(url, hint) {
    var value = String(url || '');
    if (hint === 'hls' || hint === 'dash') return hint;
    if (EXTENSION_TYPES.hls.test(value)) return 'hls';
    if (EXTENSION_TYPES.dash.test(value)) return 'dash';
    if (EXTENSION_TYPES.image.test(value)) return 'image';
    if (EXTENSION_TYPES.video.test(value)) return 'video';
    if (EXTENSION_TYPES.audio.test(value)) return 'audio';
    if (hint === 'image' || hint === 'video' || hint === 'audio') return hint;
    return hint === 'stream' ? 'stream' : 'unknown';
  }

  function isEnabled(type, options) {
    if (type === 'image') return options.images !== false;
    if (type === 'video') return options.video !== false;
    if (type === 'audio') return options.audio !== false;
    if (type === 'hls' || type === 'dash' || type === 'stream') return options.streams !== false;
    return false;
  }

  function normalizeUrl(rawUrl, baseUrl) {
    var raw = decodeHtml(rawUrl).trim().replace(/^<|>$/g, '');
    if (!raw || /^(?:data|blob|javascript|mailto|tel):/i.test(raw) || raw.charAt(0) === '#') return '';
    try {
      var absolute = new URL(raw, baseUrl || undefined);
      return /^https?:$/i.test(absolute.protocol) ? absolute.href : '';
    } catch (_) {
      return '';
    }
  }

  function pushCandidate(list, seen, rawUrl, hint, start, end, sourceKind, options) {
    var absoluteUrl = normalizeUrl(rawUrl, options.baseUrl);
    if (!absoluteUrl) return;
    var type = classifyUrl(absoluteUrl, hint);
    if (!isEnabled(type, options)) return;
    var key = absoluteUrl + '|' + start + '|' + end;
    if (seen[key]) return;
    seen[key] = true;
    list.push({
      url: absoluteUrl,
      originalUrl: decodeHtml(rawUrl).trim().replace(/^<|>$/g, ''),
      type: type,
      start: start,
      end: end,
      sourceKind: sourceKind || '',
    });
  }

  function discoverMarkdown(source, options, list, seen) {
    var linkedImageRe = /\[!\[[^\]]*\]\([^)]*\)\]\(\s*(<[^>]+>|[^\s)]+)(?=\s|\))/g;
    var linkedMatch;
    while ((linkedMatch = linkedImageRe.exec(source))) {
      var linkedOffset = linkedMatch.index + linkedMatch[0].lastIndexOf(linkedMatch[1]);
      var linkedRaw = linkedMatch[1];
      var linkedLeft = linkedRaw.charAt(0) === '<' ? 1 : 0;
      var linkedRight = linkedRaw.charAt(linkedRaw.length - 1) === '>' ? 1 : 0;
      pushCandidate(list, seen, linkedRaw, 'image', linkedOffset + linkedLeft, linkedOffset + linkedRaw.length - linkedRight, 'markdown-linked-image', options);
    }

    var imageRe = /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?=\s|\))/g;
    var match;
    while ((match = imageRe.exec(source))) {
      var offset = match.index + match[0].indexOf(match[1]);
      var raw = match[1];
      var trimLeft = raw.charAt(0) === '<' ? 1 : 0;
      var trimRight = raw.charAt(raw.length - 1) === '>' ? 1 : 0;
      pushCandidate(list, seen, raw, 'image', offset + trimLeft, offset + raw.length - trimRight, 'markdown-image', options);
    }

    var linkRe = /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?=\s|\))/g;
    while ((match = linkRe.exec(source))) {
      if (match.index > 0 && source.charAt(match.index - 1) === '!') continue;
      var linkOffset = match.index + match[0].indexOf(match[1]);
      var linkRaw = match[1];
      var absolute = normalizeUrl(linkRaw, options.baseUrl);
      var type = classifyUrl(absolute, '');
      if (type === 'unknown') continue;
      var left = linkRaw.charAt(0) === '<' ? 1 : 0;
      var right = linkRaw.charAt(linkRaw.length - 1) === '>' ? 1 : 0;
      pushCandidate(list, seen, linkRaw, type, linkOffset + left, linkOffset + linkRaw.length - right, 'markdown-link', options);
    }
  }

  function discoverHtml(source, options, list, seen) {
    var tagRe = /<(img|source|video|audio|track|a)\b[^>]*>/gi;
    var tagMatch;
    while ((tagMatch = tagRe.exec(source))) {
      var tag = tagMatch[1].toLowerCase();
      var tagText = tagMatch[0];
      var mimeMatch = /\btype\s*=\s*(["'])(.*?)\1/i.exec(tagText);
      var mime = mimeMatch ? mimeMatch[2].toLowerCase() : '';
      var attrRe = /\b(src|poster|href)\s*=\s*(["'])(.*?)\2/gi;
      var attrMatch;
      while ((attrMatch = attrRe.exec(tagText))) {
        var attr = attrMatch[1].toLowerCase();
        if (tag === 'a' && attr !== 'href') continue;
        if (tag !== 'a' && attr === 'href') continue;
        var hint = /(?:application\/vnd\.apple\.mpegurl|application\/x-mpegurl)/i.test(mime) ? 'hls'
          : (/application\/dash\+xml/i.test(mime) ? 'dash'
            : (tag === 'img' || attr === 'poster' ? 'image'
              : (tag === 'audio' ? 'audio' : (tag === 'a' ? '' : 'video'))));
        var absolute = normalizeUrl(attrMatch[3], options.baseUrl);
        if (tag === 'a' && classifyUrl(absolute, '') === 'unknown') continue;
        var valueOffset = tagMatch.index + attrMatch.index + attrMatch[0].indexOf(attrMatch[3]);
        pushCandidate(list, seen, attrMatch[3], hint, valueOffset, valueOffset + attrMatch[3].length, 'html-' + attr, options);
      }

      var srcsetRe = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
      var srcsetMatch;
      while ((srcsetMatch = srcsetRe.exec(tagText))) {
        var value = srcsetMatch[2];
        var itemRe = /(?:^|,)\s*([^\s,]+)(?=\s|,|$)/g;
        var itemMatch;
        while ((itemMatch = itemRe.exec(value))) {
          var rawUrl = itemMatch[1];
          var baseOffset = tagMatch.index + srcsetMatch.index + srcsetMatch[0].indexOf(value);
          var itemOffset = baseOffset + itemMatch.index + itemMatch[0].indexOf(rawUrl);
          pushCandidate(list, seen, rawUrl, 'image', itemOffset, itemOffset + rawUrl.length, 'html-srcset', options);
        }
      }
    }
  }

  function discoverUrlList(source, options, list, seen) {
    var rawItems = [];
    var trimmed = String(source || '').trim();
    if (!trimmed) return;
    if (trimmed.charAt(0) === '[') {
      try { rawItems = JSON.parse(trimmed); } catch (_) {}
    }
    if (!Array.isArray(rawItems)) rawItems = trimmed.split(/[\r\n,]+/);
    rawItems.forEach(function (item) {
      var raw = typeof item === 'string' ? item : (item && (item.url || item.src));
      var absolute = normalizeUrl(raw, options.baseUrl);
      var type = classifyUrl(absolute, '');
      if (!absolute || type === 'unknown' || !isEnabled(type, options)) return;
      if (seen[absolute]) return;
      seen[absolute] = true;
      list.push({ url: absolute, originalUrl: String(raw), type: type, start: -1, end: -1, sourceKind: 'url-list' });
    });
  }

  function discover(source, options) {
    source = String(source || '');
    options = Object.assign({ format: 'auto', images: true, video: true, audio: true, streams: true }, options || {});
    var format = options.format || 'auto';
    var list = [];
    var seen = Object.create(null);
    if (format === 'urlList') discoverUrlList(source, options, list, seen);
    else {
      if (format === 'auto' || format === 'markdown') discoverMarkdown(source, options, list, seen);
      if (format === 'auto' || format === 'html') discoverHtml(source, options, list, seen);
    }
    return list;
  }

  function rewrite(source, candidates, localByUrl) {
    var replacements = (candidates || []).filter(function (item) {
      return item.start >= 0 && localByUrl[item.url];
    }).sort(function (a, b) { return b.start - a.start; });
    var result = String(source || '');
    replacements.forEach(function (item) {
      result = result.slice(0, item.start) + localByUrl[item.url] + result.slice(item.end);
    });
    return result;
  }

  function sanitizeFileName(value) {
    var name = String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '');
    return name || 'media';
  }

  function fileNameFromUrl(url, fallbackExtension) {
    var name = '';
    try {
      var parsed = new URL(url);
      var parts = parsed.pathname.split('/');
      name = decodeURIComponent(parts[parts.length - 1] || '');
    } catch (_) {}
    name = sanitizeFileName(name);
    if (!/\.[a-z0-9]{1,8}$/i.test(name) && fallbackExtension) name += fallbackExtension;
    return name;
  }

  function createNameAllocator() {
    var used = Object.create(null);
    return function allocate(preferred) {
      var clean = sanitizeFileName(preferred);
      var dot = clean.lastIndexOf('.');
      var stem = dot > 0 ? clean.slice(0, dot) : clean;
      var ext = dot > 0 ? clean.slice(dot) : '';
      var key = clean.toLowerCase();
      if (!used[key]) {
        used[key] = 1;
        return clean;
      }
      var index = ++used[key];
      var candidate;
      do {
        candidate = stem + '-' + index + ext;
        index++;
      } while (used[candidate.toLowerCase()]);
      used[candidate.toLowerCase()] = 1;
      return candidate;
    };
  }

  function hlsReferences(text, baseUrl) {
    var refs = [];
    var lines = String(text || '').split(/\r?\n/);
    var cursor = 0;
    var nextUriIsPlaylist = false;
    lines.forEach(function (line, lineIndex) {
      var trimmed = line.trim();
      if (trimmed && trimmed.charAt(0) !== '#') {
        var startInLine = line.indexOf(trimmed);
        refs.push({
          url: normalizeUrl(trimmed, baseUrl),
          raw: trimmed,
          start: cursor + startInLine,
          end: cursor + startInLine + trimmed.length,
          playlist: nextUriIsPlaylist || /\.m3u8(?:$|[?#])/i.test(trimmed),
          line: lineIndex,
        });
        nextUriIsPlaylist = false;
      }
      var uriRe = /URI=("([^"]+)"|'([^']+)')/gi;
      var match;
      while ((match = uriRe.exec(line))) {
        var raw = match[2] || match[3] || '';
        var rawOffset = match.index + match[0].indexOf(raw);
        refs.push({
          url: normalizeUrl(raw, baseUrl),
          raw: raw,
          start: cursor + rawOffset,
          end: cursor + rawOffset + raw.length,
          playlist: /(?:EXT-X-MEDIA|EXT-X-I-FRAME-STREAM-INF)/i.test(line) || /\.m3u8(?:$|[?#])/i.test(raw),
          line: lineIndex,
        });
      }
      if (/^#EXT-X-STREAM-INF\b/i.test(trimmed)) nextUriIsPlaylist = true;
      cursor += line.length + 1;
    });
    return refs.filter(function (ref) { return !!ref.url; });
  }

  return {
    classifyUrl: classifyUrl,
    normalizeUrl: normalizeUrl,
    discover: discover,
    rewrite: rewrite,
    sanitizeFileName: sanitizeFileName,
    fileNameFromUrl: fileNameFromUrl,
    createNameAllocator: createNameAllocator,
    hlsReferences: hlsReferences,
  };
});
