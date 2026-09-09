const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageDir = path.join(root, 'node_modules/turndown');
const gfmDir = path.join(root, 'node_modules/turndown-plugin-gfm');
const outputDir = path.join(root, 'dependencies/turndown');

if (!fs.existsSync(packageDir) || !fs.existsSync(gfmDir)) {
  throw new Error('turndown and turndown-plugin-gfm must be installed; run npm install first');
}

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(
  path.join(packageDir, 'lib/turndown.browser.umd.js'),
  path.join(outputDir, 'turndown.browser.umd.js')
);
fs.copyFileSync(
  path.join(gfmDir, 'dist/turndown-plugin-gfm.js'),
  path.join(outputDir, 'turndown-plugin-gfm.js')
);

console.log('Prepared Turndown browser runtime');
