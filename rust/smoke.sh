#!/usr/bin/env bash
# So sánh nhanh Node (8790) với Rust (8793) trên cùng cookie + cùng dữ liệu.
set -u
NODE_URL=${NODE_URL:-http://127.0.0.1:8790}
RUST_URL=${RUST_URL:-http://127.0.0.1:8793}
TOKEN=$(node /tmp/pw/tok.js)
STORE=${STORE:-57-nguyen-ngoc-doan-hn}
OUT="$(cd "$(dirname "$0")" && pwd)/.smoke"
mkdir -p "$OUT"
fail=0
check() {
  local path="$1" a b
  a=$(curl -s -o "$OUT/n.out" -w "%{http_code}" --max-time 60 -H "Cookie: lilycam_sid=$TOKEN" "$NODE_URL$path")
  b=$(curl -s -o "$OUT/r.out" -w "%{http_code}" --max-time 60 -H "Cookie: lilycam_sid=$TOKEN" "$RUST_URL$path")
  if [ "$a" = "$b" ]; then
    printf "OK   %-44s %s\n" "$path" "$a"
  else
    printf "DIFF %-44s node=%s rust=%s\n" "$path" "$a" "$b"
    fail=1
  fi
}
check /api/health
check /api/stores
check /api/stats
check /api/capture/status
check "/api/storecfg/$STORE"
check "/api/zones/$STORE/1"
check "/api/meta/$STORE/2"
check "/hls/g4/$STORE/1/index.m3u8"
echo
[ "$fail" = 0 ] && echo "Tất cả khớp." || echo "Có khác biệt."
exit $fail
