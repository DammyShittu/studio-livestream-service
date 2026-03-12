// ecosystem.config.js — PM2 process manager config
// Usage: pm2 start ecosystem.config.js
// Scale workers: pm2 scale bbb-worker-1 +1

module.exports = {
  apps: [
    // ── Control API ──────────────────────────────────────────────────────────
    {
      name: 'bbb-livestream-api',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/bbb-livestream/api-error.log',
      out_file: '/var/log/bbb-livestream/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Capture Worker 1 (display :99) ───────────────────────────────────────
    // Each worker handles ONE concurrent stream.
    // Add more workers for more concurrent streams — each needs a unique DISPLAY_NUM.
    {
      name: 'bbb-worker-1',
      script: 'src/capture/worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G', // Chrome + FFmpeg can use ~1.5GB per stream
      env: {
        NODE_ENV: 'production',
        WORKER_ID: 'worker-1',
        DISPLAY_NUM: '99',
      },
      error_file: '/var/log/bbb-livestream/worker-1-error.log',
      out_file: '/var/log/bbb-livestream/worker-1-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Capture Worker 2 (display :100) — uncomment for 2 concurrent streams ──
    // {
    //   name: 'bbb-worker-2',
    //   script: 'src/capture/worker.js',
    //   instances: 1,
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '2G',
    //   env: {
    //     NODE_ENV: 'production',
    //     WORKER_ID: 'worker-2',
    //     DISPLAY_NUM: '100',
    //   },
    //   error_file: '/var/log/bbb-livestream/worker-2-error.log',
    //   out_file: '/var/log/bbb-livestream/worker-2-out.log',
    // },
  ],
};
