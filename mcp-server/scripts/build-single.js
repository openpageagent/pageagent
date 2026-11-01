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
    target: ['node22'],
    format: 'cjs',
    minify: true,
    external: [
      // Desktop automation loads the platform-specific addon from an adjacent node_modules.
      'robotjs',
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
  console.log('Requires Node >=22.16.0. First start generates a pairing password and an HTTP token if not configured; data defaults to ./data under the current working directory (override with --state-dir).');
  console.log(`Start independently: node ${outFile}`);
  console.log('MCP transport: Streamable HTTP; URL: http://127.0.0.1:9998/mcp; /local runs on the server, /clients discovers ARP clients.');
  console.log('Authorization: Bearer <HTTP token from startup output or PAGE_AGENT_HTTP_BEARER_TOKEN>; stdio MCP is not supported.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
