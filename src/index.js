// src/index.js — Control API server
'use strict';

require('dotenv').config();
const express = require('express');
const { createClient } = require('redis');
const { createRouter } = require('./api/routes');
const logger = require('./utils/logger');

const PORT = parseInt(process.env.CONTROL_PORT || '3020', 10);

async function main() {
  // ── Redis connection ──────────────────────────────────────────────────────
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

  redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
  redis.on('reconnecting', () => logger.warn('Redis reconnecting...'));
  redis.on('ready', () => logger.info('Redis connected'));

  await redis.connect();

  // ── Express app ───────────────────────────────────────────────────────────
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true })); // nginx-rtmp sends form-encoded POST bodies

  // Request logging
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`, { ip: req.ip });
    next();
  });

  // CORS — allow BBB's own origin
  app.use((req, res, next) => {
    const bbbDomain = process.env.BBB_DOMAIN || '';
    res.setHeader('Access-Control-Allow-Origin', `https://${bbbDomain}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Mount all routes
  app.use('/', createRouter(redis));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, _next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── Start server ──────────────────────────────────────────────────────────
  app.listen(PORT, '127.0.0.1', () => {
    logger.info(`bbb-livestream-service control API started`, { port: PORT });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
