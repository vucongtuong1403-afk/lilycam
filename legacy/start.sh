#!/usr/bin/env bash
# Chạy LilyCam ở nền
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8790}"
if pgrep -f "node .*camera-web/server.js" >/dev/null; then
  echo "LilyCam đang chạy rồi. Mở http://localhost:$PORT"
  exit 0
fi
nohup node server.js > server.log 2>&1 &
sleep 1
echo "LilyCam: http://localhost:$PORT  (log: server.log)"
