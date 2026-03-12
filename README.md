# bbb-livestream-service

The backend capture and control service for BigBlueButton v3 livestreaming.
Works with [bbb-livestream-plugin](https://github.com/your-org/bbb-livestream-plugin).

---

## Architecture

```
BBB Meeting
    │
    ▼
┌─────────────────────────────────────────────┐
│           bbb-livestream-service             │
│                                             │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │ Control API  │    │  Brewery Pool     │  │
│  │ Express:3020 │◄──►│  (Redis-backed)   │  │
│  └──────┬───────┘    └────────┬──────────┘  │
│         │                     │             │
│         ▼                     ▼             │
│  ┌──────────────────────────────────────┐   │
│  │         Capture Worker(s)            │   │
│  │  Xvfb + Chrome (Puppeteer) + FFmpeg  │   │
│  └──────────────────┬───────────────────┘   │
└─────────────────────│───────────────────────┘
                       │ RTMP push
                       ▼
              nginx-rtmp (127.0.0.1:1935)
               │              │
               ▼              ▼
           HLS output    External RTMP
        /var/www/bbb-hls  (YouTube, etc.)
```

---

## Repository Structure

```
bbb-livestream-service/
├── src/
│   ├── index.js                  # Control API server (Express)
│   ├── api/
│   │   └── routes.js             # All API routes
│   ├── brewery/
│   │   └── pool.js               # Redis worker pool manager
│   ├── capture/
│   │   ├── worker.js             # Capture worker — full stream lifecycle
│   │   ├── browser.js            # Chrome/Puppeteer — joins BBB as viewer
│   │   ├── ffmpeg.js             # FFmpeg spawn with quality profiles
│   │   └── xvfb.js               # Virtual display manager
│   └── utils/
│       ├── bbbAuth.js            # BBB join URL + checksum generator
│       └── logger.js             # Winston logger
├── ecosystem.config.js           # PM2 process config
├── install.sh                    # Automated installer
├── .env.example
└── package.json
```

---

## Quick Install (Automated)

```bash
git clone https://github.com/your-org/bbb-livestream-service
cd bbb-livestream-service
sudo bash install.sh
```

The installer handles: Chrome, PulseAudio, FFmpeg wrapper, nginx-rtmp,
systemd services, and writes your `.env` automatically.

---

## Manual Setup

See the full [Setup Guide](https://github.com/your-org/bbb-livestream-plugin#readme)
in the plugin repo for step-by-step manual installation.

---

## API Reference

All mutating routes require the `x-api-secret` header.

### POST /stream/start
```json
{
  "meetingId": "abc123",
  "streamKey": "xxxx-xxxx-xxxx",
  "rtmpUrl": "rtmp://a.rtmp.youtube.com/live2",  // optional — defaults to local relay
  "quality": "720p"   // "1080p" | "720p" | "480p"
}
```
Response:
```json
{
  "status": "starting",
  "streamId": "uuid",
  "workerId": "worker-1",
  "hlsUrl": "https://your-domain.com/live/xxxx-xxxx-xxxx.m3u8"
}
```

### POST /stream/stop
```json
{ "meetingId": "abc123" }
```

### GET /stream/stats/:meetingId
```json
{ "bitrate": 2987.3, "active": true, "timestamp": 1700000000000 }
```

### GET /stream/pool
```json
{
  "total": 1, "idle": 1, "busy": 0, "dead": 0,
  "workers": [{ "id": "worker-1", "status": "IDLE", ... }]
}
```

### GET /health
```json
{ "status": "ok", "redis": "connected", "workers": 1, "idle": 1 }
```

---

## Scaling Concurrent Streams

Each worker handles exactly one stream. To support N concurrent streams:

```bash
# Enable worker 2 (display :100)
sudo systemctl enable bbb-livestream-worker@100
sudo systemctl start bbb-livestream-worker@100
```

Each additional worker needs ~1.5 vCPU and ~1.5GB RAM.

---

## Logs

```bash
journalctl -u bbb-livestream-api -f
journalctl -u bbb-livestream-worker@99 -f
tail -f /var/log/bbb-livestream/ffmpeg-wrapper.log
```

---

## License

MIT
