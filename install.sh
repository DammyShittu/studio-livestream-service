#!/bin/bash
# bbb-livestream-service installer
# Run as root on your BBB v3 server:  sudo bash install.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash install.sh"

BBB_DOMAIN="${BBB_DOMAIN:-$(bbb-conf --check 2>/dev/null | grep 'URL:' | awk '{print $2}' | sed 's|https://||' | sed 's|/.*||')}"
[[ -z "$BBB_DOMAIN" ]] && read -p "Enter your BBB domain (e.g. bbb.example.com): " BBB_DOMAIN
BBB_SECRET="${BBB_SECRET:-$(bbb-conf --secret 2>/dev/null | grep 'Secret:' | awk '{print $2}')}"
[[ -z "$BBB_SECRET" ]] && read -p "Enter your BBB secret: " BBB_SECRET
API_SECRET=$(openssl rand -hex 32)

info "Setting up bbb-livestream-service on: $BBB_DOMAIN"

# ── System packages ───────────────────────────────────────────────────────────
info "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  xvfb \
  pulseaudio pulseaudio-utils \
  ffmpeg \
  libnginx-mod-rtmp \
  stunnel4 \
  curl wget gnupg2 \
  2>/dev/null

# ── Google Chrome ─────────────────────────────────────────────────────────────
if ! command -v google-chrome-stable &>/dev/null; then
  info "Installing Google Chrome..."
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
    http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq && apt-get install -y -qq google-chrome-stable
  apt-mark hold google-chrome-stable  # prevent auto-updates breaking Puppeteer
  info "Chrome installed and pinned"
fi

# ── Node.js ───────────────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q "v1[89]\|v2"; then
  info "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

# ── PM2 ───────────────────────────────────────────────────────────────────────
npm install -g pm2 -q

# ── Service user ──────────────────────────────────────────────────────────────
if ! id bbb-stream &>/dev/null; then
  useradd -m -s /bin/bash bbb-stream
  usermod -aG audio,video bbb-stream
  info "Created user: bbb-stream"
fi

# ── Log directory ─────────────────────────────────────────────────────────────
mkdir -p /var/log/bbb-livestream
chown bbb-stream:bbb-stream /var/log/bbb-livestream

# ── PulseAudio virtual sink config ───────────────────────────────────────────
info "Configuring PulseAudio virtual sink..."
mkdir -p /home/bbb-stream/.config/pulse
cat > /etc/pulse/bbb-stream.pa << 'PULSE'
#!/usr/bin/pulseaudio -nF
load-module module-null-sink sink_name=bbb_virtual_out sink_properties=device.description="BBB-Stream-Output"
load-module module-virtual-source source_name=bbb_virtual_in master=bbb_virtual_out.monitor source_properties=device.description="BBB-Stream-Input"
set-default-sink bbb_virtual_out
set-default-source bbb_virtual_in
PULSE

cat > /usr/local/bin/start-bbb-pulse.sh << 'SCRIPT'
#!/bin/bash
export HOME=/home/bbb-stream
export XDG_RUNTIME_DIR=/run/user/$(id -u bbb-stream)
mkdir -p "$XDG_RUNTIME_DIR"
pulseaudio --kill 2>/dev/null || true
sleep 1
pulseaudio --file=/etc/pulse/bbb-stream.pa --exit-idle-time=-1 \
  --disallow-exit --daemonize=yes \
  --log-target=file:/var/log/bbb-livestream/pulse.log
echo "PulseAudio started"
SCRIPT
chmod +x /usr/local/bin/start-bbb-pulse.sh

# ── FFmpeg wrapper ────────────────────────────────────────────────────────────
info "Installing FFmpeg wrapper..."
cat > /usr/local/bin/ffmpeg << 'WRAPPER'
#!/bin/bash
LOG=/var/log/bbb-livestream/ffmpeg-wrapper.log
echo "[$(date '+%Y-%m-%d %H:%M:%S')] $@" >> "$LOG"
ARGS=("$@")
FINAL=()
for ARG in "${ARGS[@]}"; do
  case "$ARG" in
    slow|medium) FINAL+=("veryfast") ;;
    *) FINAL+=("$ARG") ;;
  esac
done
exec /usr/bin/ffmpeg "${FINAL[@]}"
WRAPPER
chmod 755 /usr/local/bin/ffmpeg

# ── nginx-rtmp ────────────────────────────────────────────────────────────────
info "Configuring nginx-rtmp..."
mkdir -p /var/www/bbb-hls
chown www-data:www-data /var/www/bbb-hls

# Inject RTMP block into nginx config (non-destructive — appends after http block)
if ! grep -q "rtmp {" /etc/nginx/nginx.conf; then
  cat >> /etc/nginx/nginx.conf << NGINX

rtmp {
  server {
    listen 127.0.0.1:1935;
    chunk_size 4096;
    ping 30s;
    ping_timeout 10s;
    application bbb-live {
      live on;
      record off;
      hls on;
      hls_path /var/www/bbb-hls;
      hls_fragment 2s;
      hls_playlist_length 20s;
      hls_cleanup on;
      allow publish 127.0.0.1;
      deny publish all;
      allow play all;
      on_publish http://127.0.0.1:3020/hooks/on-publish;
      on_done http://127.0.0.1:3020/hooks/on-done;
    }
  }
}
NGINX
  info "nginx RTMP block added"
fi

# Add HLS serving location to BBB's nginx vhost
BBB_NGINX="/etc/bigbluebutton/nginx/bbb-livestream.nginx"
cat > "$BBB_NGINX" << VHOST
location /live/ {
  alias /var/www/bbb-hls/;
  types {
    application/vnd.apple.mpegurl m3u8;
    video/mp2t ts;
  }
  add_header Cache-Control no-cache;
  add_header Access-Control-Allow-Origin *;
  expires -1;
}
VHOST

nginx -t && systemctl reload nginx
info "nginx configured"

# ── Install bbb-livestream-service ────────────────────────────────────────────
info "Installing bbb-livestream-service..."
SERVICE_DIR="/opt/bbb-livestream-service"
mkdir -p "$SERVICE_DIR"
cp -r . "$SERVICE_DIR/"
chown -R bbb-stream:bbb-stream "$SERVICE_DIR"

sudo -u bbb-stream bash -c "cd $SERVICE_DIR && npm install --production"

# Write .env
cat > "$SERVICE_DIR/.env" << ENV
BBB_URL=https://${BBB_DOMAIN}/bigbluebutton
BBB_SECRET=${BBB_SECRET}
BBB_DOMAIN=${BBB_DOMAIN}
REDIS_URL=redis://localhost:6379
CONTROL_PORT=3020
RTMP_RELAY_HOST=127.0.0.1
RTMP_RELAY_PORT=1935
RTMP_APP=bbb-live
CHROME_BIN=/usr/bin/google-chrome-stable
LOG_LEVEL=info
API_SECRET=${API_SECRET}
ENV
chown bbb-stream:bbb-stream "$SERVICE_DIR/.env"
chmod 600 "$SERVICE_DIR/.env"

# ── Systemd services ──────────────────────────────────────────────────────────
info "Setting up systemd services..."

cat > /etc/systemd/system/bbb-livestream-pulse.service << UNIT
[Unit]
Description=BBB Livestream PulseAudio Virtual Sink
After=network.target

[Service]
Type=forking
User=bbb-stream
ExecStart=/usr/local/bin/start-bbb-pulse.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/bbb-livestream-api.service << UNIT
[Unit]
Description=BBB Livestream Control API
After=network.target redis.service bbb-livestream-pulse.service
Requires=redis.service

[Service]
Type=simple
User=bbb-stream
WorkingDirectory=${SERVICE_DIR}
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bbb-livestream-api

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/bbb-livestream-worker@.service << UNIT
[Unit]
Description=BBB Livestream Capture Worker %i
After=bbb-livestream-api.service

[Service]
Type=simple
User=bbb-stream
WorkingDirectory=${SERVICE_DIR}
Environment=WORKER_ID=worker-%i
Environment=DISPLAY_NUM=%i
ExecStart=/usr/bin/node src/capture/worker.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bbb-worker-%i

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable bbb-livestream-pulse
systemctl enable bbb-livestream-api
systemctl enable bbb-livestream-worker@99   # Worker 1 on display :99

systemctl start bbb-livestream-pulse
sleep 2
systemctl start bbb-livestream-api
sleep 1
systemctl start bbb-livestream-worker@99

# ── Inject API URL into BBB HTML ──────────────────────────────────────────────
BBB_HTML="/var/www/bigbluebutton-default/assets/index.html"
if ! grep -q "BBB_LIVESTREAM_API_URL" "$BBB_HTML"; then
  sed -i "s|</head>|<script>window.BBB_LIVESTREAM_API_URL='https://${BBB_DOMAIN}:3020';</script>\n</head>|" "$BBB_HTML"
fi

# ── Open port 3020 internally (no public access needed) ──────────────────────
# The API only listens on 127.0.0.1 so no firewall change is needed.

info "======================================================"
info " bbb-livestream-service installed successfully!"
info "======================================================"
info " Control API:  http://127.0.0.1:3020/health"
info " HLS output:   https://${BBB_DOMAIN}/live/<streamkey>.m3u8"
info " API Secret:   ${API_SECRET}"
info ""
warn " SAVE your API secret — add it to the plugin config:"
warn " window.BBB_LIVESTREAM_API_SECRET = '${API_SECRET}'"
info "======================================================"
