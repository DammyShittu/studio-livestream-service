// src/brewery/pool.js
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const POOL_KEY = 'bbb:brewery:workers';
const EVENTS_CHANNEL = 'bbb:livestream:events';
const STATS_CHANNEL = 'bbb:livestream:stats';

const STATUS = {
  IDLE: 'IDLE',
  BUSY: 'BUSY',
  DEAD: 'DEAD',
};

class BreweryPool extends EventEmitter {
  constructor(redisClient) {
    super();
    this.redis = redisClient;
  }

  async registerWorker(workerId, displayNum) {
    await this.redis.hSet(POOL_KEY, workerId, JSON.stringify({
      id: workerId,
      status: STATUS.IDLE,
      displayNum,
      meetingId: null,
      streamId: null,
      startedAt: null,
      pid: process.pid,
      registeredAt: Date.now(),
    }));
    logger.info(`Worker registered`, { workerId, displayNum });
  }

  async getIdleWorker() {
    const all = await this.redis.hGetAll(POOL_KEY);
    for (const raw of Object.values(all)) {
      const worker = JSON.parse(raw);
      if (worker.status === STATUS.IDLE) return worker;
    }
    return null;
  }

  async assignWorker(workerId, meetingId, streamId) {
    const raw = await this.redis.hGet(POOL_KEY, workerId);
    if (!raw) throw new Error(`Worker ${workerId} not found`);

    const worker = JSON.parse(raw);
    worker.status = STATUS.BUSY;
    worker.meetingId = meetingId;
    worker.streamId = streamId;
    worker.startedAt = Date.now();

    await this.redis.hSet(POOL_KEY, workerId, JSON.stringify(worker));

    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({
      type: 'STREAM_STARTED',
      workerId,
      meetingId,
      streamId,
      timestamp: Date.now(),
    }));

    logger.info(`Worker assigned`, { workerId, meetingId, streamId });
  }

  async releaseWorker(workerId) {
    const raw = await this.redis.hGet(POOL_KEY, workerId);
    if (!raw) return;

    const worker = JSON.parse(raw);
    const meetingId = worker.meetingId;

    worker.status = STATUS.IDLE;
    worker.meetingId = null;
    worker.streamId = null;
    worker.startedAt = null;

    await this.redis.hSet(POOL_KEY, workerId, JSON.stringify(worker));

    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({
      type: 'STREAM_STOPPED',
      workerId,
      meetingId,
      timestamp: Date.now(),
    }));

    logger.info(`Worker released`, { workerId, meetingId });
  }

  async markWorkerDead(workerId, reason) {
    const raw = await this.redis.hGet(POOL_KEY, workerId);
    if (!raw) return;

    const worker = JSON.parse(raw);
    worker.status = STATUS.DEAD;
    worker.error = reason;

    await this.redis.hSet(POOL_KEY, workerId, JSON.stringify(worker));

    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({
      type: 'WORKER_DEAD',
      workerId,
      meetingId: worker.meetingId,
      reason,
      timestamp: Date.now(),
    }));

    logger.error(`Worker marked dead`, { workerId, reason });
  }

  async publishStats(workerId, meetingId, bitrate) {
    await this.redis.publish(STATS_CHANNEL, JSON.stringify({
      workerId,
      meetingId,
      bitrate,
      timestamp: Date.now(),
    }));
  }

  async getPoolStatus() {
    const all = await this.redis.hGetAll(POOL_KEY);
    return Object.values(all).map(raw => JSON.parse(raw));
  }

  async getWorkerByMeeting(meetingId) {
    const all = await this.redis.hGetAll(POOL_KEY);
    for (const raw of Object.values(all)) {
      const worker = JSON.parse(raw);
      if (worker.meetingId === meetingId && worker.status === STATUS.BUSY) {
        return worker;
      }
    }
    return null;
  }

  async removeWorker(workerId) {
    await this.redis.hDel(POOL_KEY, workerId);
    logger.info(`Worker removed from pool`, { workerId });
  }
}

module.exports = { BreweryPool, STATUS, EVENTS_CHANNEL, STATS_CHANNEL };
