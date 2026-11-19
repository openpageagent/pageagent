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
    plugins: [{
      name: 'standalone-config-page',
      setup(build) {
        build.onLoad({ filter: /[\\/]config-assets\.js$/ }, () => ({
          contents: 'module.exports = ' + JSON.stringify(require('../config-assets')) + ';',
          loader: 'js',
        }));
      },
    }, {
      name: 'formidable-builtin-parsers',
      setup(build) {
        // Formidable 2 joins __dirname at runtime to load its four built-in
        // parsers. Its existing index already exports all four statically.
        // Adapt only the build input; leave installed upstream sources intact.
        build.onLoad({ filter: /[\\/]formidable[\\/]src[\\/]Formidable\.js$/ }, async ({ path: sourcePath }) => {
          const source = await fs.promises.readFile(sourcePath, 'utf8');
          const dynamic = "require(path.join(__dirname, 'plugins', `${plgName}.js`))";
          if (source.split(dynamic).length !== 2) {
            throw new Error('Formidable parser loader changed; review single-file compatibility.');
          }
          return { contents: source.replace(dynamic, "require('./plugins/index')[plgName]"),
            loader: 'js', resolveDir: path.dirname(sourcePath) };
        });
      },
    }],
    external: [
      // Desktop control loads the platform-specific addon from an adjacent node_modules.
      'robotjs',
      // Optional native speedups used by ws. They are safe to omit in a shared bundle.
      'bufferutil',
      'utf-8-validate',
      // PostgreSQL uses the pure JavaScript driver in this Node-only bundle.
      'pg-native',
      'pg-cloudflare',
      // ssh2 falls back to Node's crypto when these optional native modules are absent.
      'cpu-features',
      '*.node',
    ],
    // Keep upstream license comments in the generated distributable.
    legalComments: 'eof',
    // These workspace notices also cover upstream packages that omit LICENSE
    // from their npm file lists. Keep the notice inside the executable artifact.
    footer: { js: '/*!\n' + fs.readFileSync(path.join(serverDir, 'KOISHI_LICENSE'), 'utf8')
      + '\n' + fs.readFileSync(path.join(serverDir, 'POSTGRES_LICENSE'), 'utf8')
      + '\n' + ['REDIS_LICENSE', 'SSH2_LICENSE', 'AWS_S3_LICENSE', 'MYSQL2_LICENSE', 'WECOM_AIBOT_LICENSE'].map(file => fs.readFileSync(path.join(serverDir, file), 'utf8')).join('\n') + '\n*/' },
    logLevel: 'info',
    sourcemap: false,
  });

  fs.chmodSync(outFile, 0o755);

  const sizeKiB = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`Built ${path.relative(process.cwd(), outFile)} (${sizeKiB} KiB)`);
  console.log('Requires Node >=22.16.0. First start generates a pairing password and an HTTP token if not configured; data defaults to ./data under the current working directory (override with --state-dir).');
  console.log(`Start independently: node ${outFile}`);
  console.log('MCP transport: Streamable HTTP; URL: http://127.0.0.1:9998/mcp; /local runs on the server, /clients discovers ARP clients.');
  console.log('Standalone configuration: http://127.0.0.1:9998/config; --http-port overrides the default port 9998.');
  console.log('Authorization: Bearer <HTTP token from startup output or PAGE_AGENT_HTTP_BEARER_TOKEN>; stdio MCP is not supported.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
