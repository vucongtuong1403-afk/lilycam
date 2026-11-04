#!/usr/bin/env bash
# Khởi động lại LilyCam một cách chắc chắn (chờ cổng thực sự trống)
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-8790}"
for p in $(pgrep -x node); do
  cmd=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  case "$cmd" in *"server.js "*) kill "$p" 2>/dev/null;; esac
done
for i in $(seq 1 30); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " || break
  sleep 0.4
done
nohup env PORT="$PORT" node server.js >> server.log 2>&1 &
for i in $(seq 1 20); do
  sleep 0.4
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health")
  if [ "$code" = "200" ]; then echo "LilyCam OK trên cổng $PORT"; exit 0; fi
done
echo "Khởi động thất bại — xem server.log"; exit 1
