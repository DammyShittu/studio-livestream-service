// src/capture/xvfb.js
const { spawn } = require('child_process');
const logger = require('../utils/logger');

/**
 * Starts an Xvfb virtual display and waits for it to be ready.
 * Returns the process handle and the display string (e.g. ':99').
 */
async function startXvfb(displayNum) {
  const display = `:${displayNum}`;

  return new Promise((resolve, reject) => {
    const proc = spawn('Xvfb', [
      display,
      '-screen', '0', '1920x1080x24',
      '-ac',                    // disable access control
      '-nolisten', 'tcp',       // security: no TCP connections
      '+extension', 'RANDR',    // needed by some Chrome features
    ], {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let ready = false;

    // Xvfb writes to stderr when it's ready
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!ready && (msg.includes('ready') || msg.includes('Starting'))) {
        ready = true;
        resolve({ proc, display });
      }
    });

    proc.on('error', reject);

    proc.on('close', (code) => {
      if (!ready) reject(new Error(`Xvfb exited with code ${code} before ready`));
      logger.warn('Xvfb exited', { display, code });
    });

    // Xvfb is usually ready within 1-2s — give it 3s before timing out
    setTimeout(() => {
      if (!ready) {
        ready = true; // assume it's up
        resolve({ proc, display });
      }
    }, 3000);
  });
}

module.exports = { startXvfb };
