// src/capture/browser.js
const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--window-size=1920,1080',
  '--start-fullscreen',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
];

// CSS to hide BBB chrome UI elements for a clean stream output
const HIDE_UI_CSS = `
  /* Hide toolbars and controls */
  #actions-bar,
  .toolbar-wrapper,
  .react-draggable[style*="z-index: 1600"],
  .notifications-container,
  .Toastify,
  [data-test="userListToggleBtn"],
  [data-test="chatButton"],
  [data-test="whiteboardOptionsButton"],
  [data-test="leaveSessionBtn"],
  .presentationUploadToken,
  #error-screen { display: none !important; }

  /* Maximize the main content area */
  #app { padding: 0 !important; }
  .ReactModal__Overlay { z-index: -1 !important; }
`;

/**
 * Launches Chrome and joins a BBB meeting as a hidden viewer.
 *
 * @param {string} joinUrl   - Full BBB join URL
 * @param {string} display   - Xvfb display string e.g. ':99'
 * @returns {{ browser, page }}
 */
async function launchBrowser(joinUrl, display) {
  logger.info('Launching Chrome', { display });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable',
    headless: false, // must be false — Xvfb provides the virtual display
    args: CHROME_ARGS,
    env: {
      ...process.env,
      DISPLAY: display,
      PULSE_SERVER: 'unix:/run/user/1001/pulse/native',
    },
    defaultViewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();

  // Suppress unnecessary console noise from BBB's React app
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      logger.debug('Browser console error', { text: msg.text() });
    }
  });

  page.on('pageerror', (err) => {
    logger.warn('Page JS error', { error: err.message });
  });

  logger.info('Navigating to BBB meeting', { joinUrl: joinUrl.split('?')[0] }); // don't log the full URL with checksum

  await page.goto(joinUrl, {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });

  // Wait for BBB media to fully initialize (WebRTC takes a few seconds)
  await page.waitForTimeout(8000);

  // Inject CSS to hide UI chrome for a clean stream
  await page.addStyleTag({ content: HIDE_UI_CSS });

  // Click through any "Listen Only" modal if it appears
  try {
    await page.waitForSelector('[data-test="listenOnlyBtn"]', { timeout: 5000 });
    await page.click('[data-test="listenOnlyBtn"]');
    logger.info('Clicked listen-only join button');
  } catch {
    logger.debug('No listen-only button found — already joined or not needed');
  }

  // Additional wait for audio to connect
  await page.waitForTimeout(3000);

  logger.info('Browser ready and joined BBB meeting');
  return { browser, page };
}

module.exports = { launchBrowser };
