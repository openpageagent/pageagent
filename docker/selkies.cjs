'use strict';

const fs = require('fs/promises');

async function waitForFile(file, stopping) {
  for (let attempt = 0; attempt < 100 && !stopping(); attempt++) {
    try { await fs.access(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Browser display service did not become ready: ' + file);
}

async function startSelkies({ start, stopping, state, runtime, deviceScaleFactor }) {
  // Match Chromium's rendering density; increasing only the screen adds space, not detail.
  const dimensions = [1920 * deviceScaleFactor, 1080 * deviceScaleFactor];
  const geometry = dimensions.join('x');
  start('Xvfb', [':99', '-screen', '0', geometry + 'x24', '-nolisten', 'tcp', '-ac']);
  await waitForFile('/tmp/.X11-unix/X99', stopping);
  // Apply the browser window rule before Chromium creates or restores windows.
  const windowManagerReady = runtime + '/openbox-ready';
  await fs.rm(windowManagerReady, { force: true });
  start('openbox', ['--config-file', __dirname + '/openbox.xml', '--sm-disable', '--startup', 'touch ' + windowManagerReady]);
  await waitForFile(windowManagerReady, stopping);
  start('/opt/selkies/bin/selkies', [], {
    SELKIES_ADDR: '0.0.0.0', SELKIES_PORT: '10000', SELKIES_MODE: 'websockets', SELKIES_ENABLE_DUAL_MODE: 'false',
    SELKIES_ENABLE_HTTPS: 'true', SELKIES_HTTPS_CERT: state + '/tls/selkies.crt', SELKIES_HTTPS_KEY: state + '/tls/selkies.key',
    SELKIES_ENCODER: process.env.SELKIES_ENCODER || 'jpeg',
    SELKIES_ENABLE_BASIC_AUTH: process.env.SELKIES_ENABLE_BASIC_AUTH || 'false',
    SELKIES_AUDIO_ENABLED: 'false', SELKIES_GAMEPAD_ENABLED: 'false',
    SELKIES_MANUAL_RESOLUTION: 'true', SELKIES_MANUAL_WIDTH: String(dimensions[0]), SELKIES_MANUAL_HEIGHT: String(dimensions[1]),
    SELKIES_ENABLE_RESIZE: 'false', SELKIES_COMMAND_ENABLED: 'false',
  });
  console.log('Selkies: https://localhost:10000/ (certificate: /data/tls/selkies.crt)');
}

module.exports = { startSelkies };
