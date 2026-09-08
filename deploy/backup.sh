#!/usr/bin/env bash
# Consistent hourly snapshot of the SQLite DB. Keeps the newest 48.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DB_PATH:-$APP_DIR/data/mailtrack.db}"
OUT="$APP_DIR/backups"

mkdir -p "$OUT"
[[ -f "$DB" ]] || exit 0

STAMP="$(date +%Y%m%d-%H%M%S)"
sqlite3 "$DB" ".backup '$OUT/mailtrack-$STAMP.db'"

# prune: keep newest 48
ls -1t "$OUT"/mailtrack-*.db 2>/dev/null | tail -n +49 | xargs -r rm --

# Optional off-box copy (uncomment + set a bucket you own):
# aws s3 cp "$OUT/mailtrack-$STAMP.db" "s3://YOUR-BUCKET/mail-tracker/"
