// src/utils/logger.js
const { createLogger, format, transports } = require('winston');
const path = require('path');

const LOG_DIR = '/var/log/bbb-livestream';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length
        ? ' ' + JSON.stringify(meta)
        : '';
      return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${metaStr}`;
    }),
  ),
  transports: [
    new transports.Console(),
    new transports.File({
      filename: path.join(LOG_DIR, 'service.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

module.exports = logger;
