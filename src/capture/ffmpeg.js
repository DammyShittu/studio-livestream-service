// src/capture/ffmpeg.js
const { spawn } = require('child_process');
const logger = require('../utils/logger');

// Quality profiles — maps to bitrate/resolution settings
const QUALITY_PROFILES = {
  '1080p': { videoBitrate: '3000k', maxrate: '3500k', bufsize: '6000k', scale: '1920x1080' },
  '720p':  { videoBitrate: '2000k', maxrate: '2500k', bufsize: '4000k', scale: '1280x720'  },
  '480p':  { videoBitrate: '1000k', maxrate: '1200k', bufsize: '2000k', scale: '854x480'   },
};

/**
 * Spawns FFmpeg to capture Xvfb display + PulseAudio and push to RTMP.
 * Uses /usr/local/bin/ffmpeg wrapper (applies preset + latency optimizations).
 *
 * @param {Object} opts
 * @param {string} opts.display       - e.g. ':99'
 * @param {string} opts.rtmpUrl       - Full RTMP destination URL
 * @param {string} opts.quality       - '1080p' | '720p' | '480p'
 * @param {Function} opts.onBitrate   - Called with parsed bitrate number (kbps)
 * @param {Function} opts.onExit      - Called when FFmpeg exits (code)
 */
function spawnFFmpeg({ display, rtmpUrl, quality = '720p', onBitrate, onExit }) {
  const profile = QUALITY_PROFILES[quality] || QUALITY_PROFILES['720p'];

  // /usr/local/bin/ffmpeg is the wrapper — it rewrites slow presets to veryfast
  // and adds zerolatency tune automatically. Falls back to /usr/bin/ffmpeg if
  // wrapper isn't present.
  const ffmpegBin = '/usr/local/bin/ffmpeg';

  const args = [
    // ---- Video input: X11 screen grab ----
    '-f', 'x11grab',
    '-video_size', profile.scale,
    '-framerate', '30',
    '-draw_mouse', '0',           // don't show cursor in stream
    '-i', `${display}.0+0,0`,

    // ---- Audio input: PulseAudio virtual sink monitor ----
    '-f', 'pulse',
    '-ac', '2',
    '-i', 'bbb_virtual_in',       // matches name in PulseAudio config

    // ---- Video encoding ----
    '-c:v', 'libx264',
    '-preset', 'veryfast',        // wrapper ensures this even if overridden
    '-tune', 'zerolatency',
    '-b:v', profile.videoBitrate,
    '-maxrate', profile.maxrate,
    '-bufsize', profile.bufsize,
    '-pix_fmt', 'yuv420p',
    '-g', '60',                   // keyframe every 2s at 30fps — HLS needs this
    '-keyint_min', '60',
    '-sc_threshold', '0',         // disable scene-change keyframes for stable HLS

    // ---- Audio encoding ----
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',

    // ---- Output ----
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize', // required for live RTMP
    rtmpUrl,
  ];

  logger.info('Spawning FFmpeg', { display, rtmpUrl, quality });

  const proc = spawn(ffmpegBin, args, {
    env: {
      ...process.env,
      DISPLAY: display,
      PULSE_SERVER: 'unix:/run/user/1001/pulse/native', // bbb-stream user
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Parse bitrate from FFmpeg stderr output lines like:
  // frame= 1234 fps=30 q=28.0 size=   45678kB time=00:00:41.26 bitrate=3012.3kbits/s
  let buffer = '';
  proc.stderr.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\r');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const match = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
      if (match && onBitrate) {
        onBitrate(parseFloat(match[1]));
      }

      // Log only meaningful FFmpeg output, not every frame stat
      if (line.includes('Error') || line.includes('error') || line.includes('Warning')) {
        logger.warn('FFmpeg output', { line: line.trim() });
      }
    }
  });

  proc.on('close', (code) => {
    logger.info('FFmpeg exited', { code, rtmpUrl });
    if (onExit) onExit(code);
  });

  proc.on('error', (err) => {
    logger.error('FFmpeg process error', { error: err.message });
    if (onExit) onExit(-1);
  });

  return proc;
}

module.exports = { spawnFFmpeg, QUALITY_PROFILES };
