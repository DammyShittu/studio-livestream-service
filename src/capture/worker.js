// src/capture/worker.js
'use strict';

require('dotenv').config();
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const { BreweryPool } = require('../brewery/pool');
const { startXvfb } = require('./xvfb');
const { launchBrowser } = require('./browser');
const { spawnFFmpeg } = require('./ffmpeg');
const { generateJoinUrl } = require('../utils/bbbAuth');
const logger = require('../utils/logger');

const WORKER_ID = process.env.WORKER_ID || `worker-${uuidv4().slice(0, 8)}`;
const DISPLAY_NUM = parseInt(process.env.DISPLAY_NUM || '99', 10);

// Active stream context for this worker
let activeStream = null;

async function main() {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await redis.connect();

  const pool = new BreweryPool(redis);
  await pool.registerWorker(WORKER_ID, DISPLAY_NUM);

  // Subscriber client (Redis requires a separate client for pub/sub)
  const sub = redis.duplicate();
  await sub.connect();

  // Listen for START commands directed at this worker
  const startChannel = `bbb:worker:${WORKER_ID}:start`;
  const stopChannel = `bbb:worker:${WORKER_ID}:stop`;

  await sub.subscribe(startChannel, async (message) => {
    const cmd = JSON.parse(message);
    logger.info('Received START command', { workerId: WORKER_ID, meetingId: cmd.meetingId });

    if (activeStream) {
      logger.warn('Worker is already busy — ignoring START', { workerId: WORKER_ID });
      return;
    }

    try {
      await runStream(cmd, pool, redis);
    } catch (err) {
      logger.error('Stream failed', { error: err.message, stack: err.stack });
      await pool.markWorkerDead(WORKER_ID, err.message);
    }
  });

  await sub.subscribe(stopChannel, async () => {
    logger.info('Received STOP command', { workerId: WORKER_ID });
    await stopActiveStream();
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — shutting down worker', { workerId: WORKER_ID });
    await stopActiveStream();
    await pool.removeWorker(WORKER_ID);
    await redis.quit();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await stopActiveStream();
    process.exit(0);
  });

  logger.info(`Worker ready`, { workerId: WORKER_ID, display: `:${DISPLAY_NUM}` });
}

async function runStream(cmd, pool, redis) {
  const { meetingId, streamId, rtmpUrl, streamKey, quality } = cmd;
  const fullRtmpUrl = `${rtmpUrl}/${streamKey}`;

  // 1. Start virtual display
  const { proc: xvfbProc, display } = await startXvfb(DISPLAY_NUM);

  // 2. Generate BBB join URL
  const joinUrl = generateJoinUrl(
    process.env.BBB_URL,
    process.env.BBB_SECRET,
    meetingId,
  );

  // 3. Launch browser and join meeting
  const { browser, page } = await launchBrowser(joinUrl, display);

  // 4. Start FFmpeg capture
  const ffmpegProc = spawnFFmpeg({
    display,
    rtmpUrl: fullRtmpUrl,
    quality: quality || '720p',
    onBitrate: async (bitrate) => {
      // Persist latest bitrate for API polling
      await redis.set(
        `bbb:livestream:stats:${meetingId}`,
        JSON.stringify({ bitrate, timestamp: Date.now() }),
        { EX: 10 }, // expire after 10s — if FFmpeg dies, stats go stale
      );
      await pool.publishStats(WORKER_ID, meetingId, bitrate);
    },
    onExit: async (code) => {
      logger.info('FFmpeg exited', { code, workerId: WORKER_ID });
      await cleanup(browser, xvfbProc, pool);
      activeStream = null;
    },
  });

  // 5. Register in brewery
  await pool.assignWorker(WORKER_ID, meetingId, streamId);

  // 6. Store active stream context for stop command
  activeStream = { browser, ffmpegProc, xvfbProc, meetingId, streamId };

  // Handle browser crash
  browser.on('disconnected', async () => {
    logger.warn('Browser disconnected unexpectedly', { workerId: WORKER_ID });
    if (activeStream) {
      ffmpegProc.kill('SIGINT');
    }
  });

  // Handle page crash
  page.on('close', () => {
    logger.warn('Page closed unexpectedly', { workerId: WORKER_ID });
    if (activeStream) {
      ffmpegProc.kill('SIGINT');
    }
  });
}

async function stopActiveStream() {
  if (!activeStream) return;

  const { browser, ffmpegProc, xvfbProc } = activeStream;

  // Stop FFmpeg gracefully — SIGINT triggers a clean stream end
  if (ffmpegProc && !ffmpegProc.killed) {
    ffmpegProc.kill('SIGINT');
    // Give FFmpeg 5s to flush, then force kill
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ffmpegProc.kill('SIGKILL');
        resolve();
      }, 5000);
      ffmpegProc.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  if (browser) {
    await browser.close().catch(() => {});
  }

  if (xvfbProc) {
    xvfbProc.kill();
  }

  activeStream = null;
}

async function cleanup(browser, xvfbProc, pool) {
  try {
    await browser.close();
  } catch {}
  try {
    xvfbProc.kill();
  } catch {}
  await pool.releaseWorker(WORKER_ID);
}

main().catch((err) => {
  logger.error('Worker crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
