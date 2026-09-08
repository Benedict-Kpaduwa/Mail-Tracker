#!/usr/bin/env bash
#
# One-shot provisioner for a fresh Ubuntu 22.04/24.04 box (AWS Lightsail or EC2).
# Installs Node + pnpm + Caddy, builds the app, and runs it as a systemd service
# behind Caddy with automatic HTTPS.
#
# Usage (from the cloned repo directory, as a sudo-capable user):
#   sudo bash deploy/setup.sh [hostname]
#
# hostname:
#   - omit it  -> uses <public-ip>.sslip.io  (no signup, works immediately)
#   - or pass a domain / DuckDNS name you've pointed at this box's public IP
#
# Re-running is safe (idempotent).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo:  sudo bash deploy/setup.sh ${*:-}" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="mailtrack"
NODE_MAJOR=20
BUILD_AS="${SUDO_USER:-root}"

echo "==> App directory: $APP_DIR"

# --- resolve the public hostname -----------------------------------------------
SITE_ADDRESS="${1:-}"
if [[ -z "$SITE_ADDRESS" ]]; then
  IMDS_TOKEN="$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)"
  PUBLIC_IP="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
  [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="$(curl -s https://api.ipify.org || true)"
  if [[ -z "$PUBLIC_IP" ]]; then
    echo "Could not determine public IP. Pass a hostname explicitly." >&2
    exit 1
  fi
  SITE_ADDRESS="${PUBLIC_IP//./-}.sslip.io"
  echo "==> No hostname given; using $SITE_ADDRESS (points at $PUBLIC_IP)"
fi
echo "==> Public URL will be: https://$SITE_ADDRESS"

# --- system packages ---------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg build-essential python3 sqlite3 \
  debian-keyring debian-archive-keyring apt-transport-https

# --- Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  echo "==> Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
command -v pnpm >/dev/null || npm install -g pnpm

# --- Caddy ---------------------------------------------------------------
if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

# --- service user ---------------------------------------------------------
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"

# --- build the app ------------------------------------------------------------
echo "==> Installing dependencies + building (as $BUILD_AS)"
cd "$APP_DIR"
sudo -u "$BUILD_AS" env PATH="$PATH" pnpm install --frozen-lockfile
sudo -u "$BUILD_AS" env PATH="$PATH" pnpm run build

# --- .env ------------------------------------------------------------------
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> Generating .env + MAILTRACK_TOKEN"
  sudo -u "$BUILD_AS" env PATH="$PATH" pnpm run init
fi
# Point the app at its public URL and bind to localhost only (Caddy fronts it).
sed -i "s|^BASE_URL=.*|BASE_URL=https://$SITE_ADDRESS|" "$APP_DIR/.env"
if grep -q '^HOST=' "$APP_DIR/.env"; then
  sed -i "s|^HOST=.*|HOST=127.0.0.1|" "$APP_DIR/.env"
else
  echo "HOST=127.0.0.1" >> "$APP_DIR/.env"
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR/data" "$APP_DIR/backups" "$APP_DIR/.env"

# --- systemd service -------------------------------------------------------
# If the checkout lives under /home, make its parent traversable by the service
# user and skip ProtectHome (which would hide /home from the service entirely).
PROTECT_HOME="ProtectHome=true"
case "$APP_DIR" in
  /home/*)
    chmod o+x "$(dirname "$APP_DIR")" 2>/dev/null || true
    PROTECT_HOME="ProtectHome=read-only"
    ;;
esac

NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/mail-tracker.service <<EOF
[Unit]
Description=Mail Tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN $APP_DIR/dist/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
$PROTECT_HOME
PrivateTmp=true
ReadWritePaths=$APP_DIR/data $APP_DIR/backups

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mail-tracker

# --- Caddy config -------------------------------------------------------------
cat > /etc/caddy/Caddyfile <<EOF
$SITE_ADDRESS {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy || systemctl restart caddy

# --- hourly SQLite backup --------------------------------------------------
cat > /etc/cron.d/mail-tracker-backup <<EOF
0 * * * * $RUN_USER $APP_DIR/deploy/backup.sh >/dev/null 2>&1
EOF

echo
echo "=========================================================="
echo " Mail Tracker is up:  https://$SITE_ADDRESS"
echo
echo " Token (for the dashboard + extension options):"
grep '^MAILTRACK_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-
echo
echo " Service:   systemctl status mail-tracker"
echo " Logs:      journalctl -u mail-tracker -f"
echo " Update:    sudo bash deploy/update.sh"
echo
echo " Make sure the firewall allows inbound 80 AND 443."
echo " First HTTPS request may take ~30s while Caddy gets a cert."
echo "=========================================================="
