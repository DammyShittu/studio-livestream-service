// src/api/routes.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { BreweryPool } = require('../brewery/pool');
const { verifyApiSecret } = require('../utils/bbbAuth');
const logger = require('../utils/logger');

function createRouter(redis) {
  const router = express.Router();
  const pool = new BreweryPool(redis);

  // ── Middleware: verify shared secret on mutating routes ──────────────────
  const requireSecret = (req, res, next) => {
    if (!verifyApiSecret(req)) {
      logger.warn('Unauthorized API request', { ip: req.ip, path: req.path });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  // ── POST /stream/start ────────────────────────────────────────────────────
  router.post('/stream/start', requireSecret, async (req, res) => {
    const { meetingId, rtmpUrl, streamKey, quality } = req.body;

    if (!meetingId || !streamKey) {
      return res.status(400).json({ error: 'meetingId and streamKey are required' });
    }

    // Check if this meeting already has an active stream
    const existing = await pool.getWorkerByMeeting(meetingId);
    if (existing) {
      return res.status(409).json({
        error: 'Stream already active for this meeting',
        streamId: existing.streamId,
      });
    }

    const worker = await pool.getIdleWorker();
    if (!worker) {
      return res.status(503).json({
        error: 'No capture workers available',
        remedy: 'All workers are busy. Scale up by running additional worker instances.',
      });
    }

    const streamId = uuidv4();
    const resolvedRtmpUrl = rtmpUrl
      || `rtmp://${process.env.RTMP_RELAY_HOST || '127.0.0.1'}:${process.env.RTMP_RELAY_PORT || 1935}/${process.env.RTMP_APP || 'bbb-live'}`;

    // Dispatch START to the worker via Redis pub/sub
    await redis.publish(`bbb:worker:${worker.id}:start`, JSON.stringify({
      meetingId,
      streamId,
      rtmpUrl: resolvedRtmpUrl,
      streamKey,
      quality: quality || '720p',
    }));

    const hlsUrl = `https://${process.env.BBB_DOMAIN}/live/${streamKey}.m3u8`;

    logger.info('Stream start dispatched', { meetingId, streamId, workerId: worker.id });

    res.json({
      status: 'starting',
      streamId,
      workerId: worker.id,
      hlsUrl,
    });
  });

  // ── POST /stream/stop ─────────────────────────────────────────────────────
  router.post('/stream/stop', requireSecret, async (req, res) => {
    const { meetingId } = req.body;

    if (!meetingId) {
      return res.status(400).json({ error: 'meetingId is required' });
    }

    const worker = await pool.getWorkerByMeeting(meetingId);
    if (!worker) {
      return res.status(404).json({ error: 'No active stream found for this meeting' });
    }

    await redis.publish(`bbb:worker:${worker.id}:stop`, '1');

    logger.info('Stream stop dispatched', { meetingId, workerId: worker.id });

    res.json({ status: 'stopping', workerId: worker.id });
  });

  // ── GET /stream/stats/:meetingId ──────────────────────────────────────────
  router.get('/stream/stats/:meetingId', async (req, res) => {
    const { meetingId } = req.params;

    const raw = await redis.get(`bbb:livestream:stats:${meetingId}`);
    if (!raw) {
      return res.json({ bitrate: null, active: false });
    }

    const stats = JSON.parse(raw);
    const isStale = (Date.now() - stats.timestamp) > 10000;

    res.json({
      bitrate: isStale ? null : stats.bitrate,
      active: !isStale,
      timestamp: stats.timestamp,
    });
  });

  // ── GET /stream/pool ──────────────────────────────────────────────────────
  router.get('/stream/pool', async (req, res) => {
    const workers = await pool.getPoolStatus();
    res.json({
      total: workers.length,
      idle: workers.filter(w => w.status === 'IDLE').length,
      busy: workers.filter(w => w.status === 'BUSY').length,
      dead: workers.filter(w => w.status === 'DEAD').length,
      workers,
    });
  });

  // ── POST /hooks/on-publish (nginx-rtmp callback) ──────────────────────────
  // nginx-rtmp calls this when FFmpeg starts pushing a stream
  router.post('/hooks/on-publish', (req, res) => {
    const { name, addr } = req.body;
    logger.info('nginx-rtmp: stream published', { streamKey: name, from: addr });
    res.sendStatus(200); // 200 = allow; 4xx = reject
  });

  // ── POST /hooks/on-done (nginx-rtmp callback) ─────────────────────────────
  router.post('/hooks/on-done', (req, res) => {
    const { name } = req.body;
    logger.info('nginx-rtmp: stream ended', { streamKey: name });
    res.sendStatus(200);
  });

  // ── GET /health ───────────────────────────────────────────────────────────
  router.get('/health', async (req, res) => {
    try {
      await redis.ping();
      const workers = await pool.getPoolStatus();
      res.json({
        status: 'ok',
        redis: 'connected',
        workers: workers.length,
        idle: workers.filter(w => w.status === 'IDLE').length,
        uptime: process.uptime(),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  return router;
}

module.exports = { createRouter };
