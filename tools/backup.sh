#!/usr/bin/env bash
# Sao lưu dữ liệu LilyCam (chạy được cả khi service là Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${LILYCAM_BACKUP_DIR:-$HOME/lilycam-backups}"
KEEP=14
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
tar czf "$DEST/lilycam-data-$STAMP.tar.gz" -C "$ROOT" \
  data/cameras.json data/users.json data/stores.json data/zones.json \
  data/dm.ndjson data/lark.json data/lark-views.json data/.session-secret \
  data/captures 2>/dev/null
echo "→ $DEST/lilycam-data-$STAMP.tar.gz"
ls -1t "$DEST"/lilycam-data-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "giữ $KEEP bản mới nhất trong $DEST"
