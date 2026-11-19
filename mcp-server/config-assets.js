'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Reuse the extension's actual stylesheet and fonts. Source startup reads the
// workspace files; build-single embeds this fixed map into the standalone .cjs.
function asset(file, type, encoding = 'utf8') {
  return { type, encoding, body: fs.readFileSync(path.join(__dirname, file), encoding) };
}
module.exports = {
  '/config': asset('config/index.html', 'text/html; charset=utf-8'),
  '/config/favicon.png': asset('../icons/icon32.png', 'image/png', 'base64'),
  '/config/icon.png': asset('../icons/icon128.png', 'image/png', 'base64'),
  '/config/config.js': asset('config/config.js', 'text/javascript; charset=utf-8'),
  '/config/platforms.js': asset('config/platforms.js', 'text/javascript; charset=utf-8'),
  '/config/devtools-catalog.js': asset('../shared/devtools-catalog.js', 'text/javascript; charset=utf-8'),
  '/config/devtools.js': asset('config/devtools.js', 'text/javascript; charset=utf-8'),
  '/config/config.css': asset('config/config.css', 'text/css; charset=utf-8'),
  '/config/options/options.css': asset('../options/options.css', 'text/css; charset=utf-8'),
  '/config/font-notices': asset('../assets/ui-fonts/NOTICE.md', 'text/plain; charset=utf-8'),
  '/config/license': asset('../LICENSE', 'text/plain; charset=utf-8'),
  ...Object.fromEntries([
    'Roboto/Roboto-Regular.ttf',
    'Roboto/Roboto-Medium.ttf',
    'Roboto_Slab/RobotoSlab-Regular.ttf',
    'Roboto_Slab/RobotoSlab-Bold.ttf',
    'font-awesome/fonts/fontawesome-webfont.woff2',
    'flowfont/flowfont.woff2',
  ].map(file => ['/config/assets/ui-fonts/' + file,
    asset('../assets/ui-fonts/' + file, file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf', 'base64')])),
};
