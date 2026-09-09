#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const serverDir = path.resolve(__dirname, '..');
const outDir = path.join(serverDir, 'dist');
const outFile = path.join(outDir, 'page-agent-mcp-server.cjs');

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(serverDir, 'index.js')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    target: ['node16'],
    format: 'cjs',
    minify: true,
    external: [
      // Optional native speedups used by ws. They are safe to omit in a shared bundle.
      'bufferutil',
      'utf-8-validate',
    ],
    // Keep upstream license comments in the generated distributable.
    legalComments: 'eof',
    logLevel: 'info',
    sourcemap: false,
  });

  fs.chmodSync(outFile, 0o755);

  const sizeKiB = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`Built ${path.relative(process.cwd(), outFile)} (${sizeKiB} KiB)`);
  console.log('Cherry Studio command: node');
  console.log(`Cherry Studio args: ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
