#!/usr/bin/env bash
# Rebuild + restart. Run as a sudo-capable user:
#   sudo bash deploy/update.sh
#
# By default it `git pull`s first. The CI pipeline rsyncs the code in and then
# runs this with SKIP_GIT=1 so the box needs no git credentials.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo:  sudo bash deploy/update.sh" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="mailtrack"
BUILD_AS="${SUDO_USER:-root}"

cd "$APP_DIR"
if [[ -z "${SKIP_GIT:-}" ]]; then
  sudo -u "$BUILD_AS" git pull --ff-only
fi
sudo -u "$BUILD_AS" env PATH="$PATH" pnpm install --frozen-lockfile
sudo -u "$BUILD_AS" env PATH="$PATH" pnpm run build
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR/data" "$APP_DIR/backups" "$APP_DIR/.env"

systemctl restart mail-tracker
sleep 1
systemctl --no-pager status mail-tracker | head -n 12
