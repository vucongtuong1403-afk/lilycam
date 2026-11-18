#!/usr/bin/env bash
# Kiểm tra nhanh một bản LilyCam đang chạy (không cần Node, không so sánh bản cũ).
#
#   bash rust/smoke.sh                                  # chỉ kiểm tra route công khai + chặn truy cập
#   SMOKE_USER=admin SMOKE_PASS=... bash rust/smoke.sh   # đăng nhập rồi kiểm tra cả route camera
#
# Mã thoát 0 = tất cả đạt, 1 = có mục hỏng.
set -u
URL=${URL:-http://127.0.0.1:8790}
STORE=${STORE:-57-nguyen-ngoc-doan-hn}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
fail=0

# code <path> [cookie] → in mã HTTP
code() {
  local path="$1" jar="${2:-}"
  if [ -n "$jar" ]; then
    curl -s -o /dev/null -w "%{http_code}" --max-time 60 -b "$jar" "$URL$path"
  else
    curl -s -o /dev/null -w "%{http_code}" --max-time 60 "$URL$path"
  fi
}

# expect <mã mong đợi> <mô tả> <path> [cookie]
expect() {
  local want="$1" label="$2" path="$3" jar="${4:-}" got
  got=$(code "$path" "${jar}")
  if [ "$got" = "$want" ]; then
    printf "OK   %-46s %s\n" "$label" "$got"
  else
    printf "FAIL %-46s mong %s, nhận %s\n" "$label" "$want" "$got"
    fail=1
  fi
}

echo "== $URL — route công khai =="
expect 200 "/api/health"                    /api/health
expect 200 "/api/capture/status"            /api/capture/status

echo "== chặn truy cập khi chưa đăng nhập (phải 401) =="
expect 401 "/api/stores"                    /api/stores
expect 401 "/api/stats"                     /api/stats
expect 401 "/api/snap/$STORE/1"             "/api/snap/$STORE/1"
expect 401 "/hls/g4/$STORE/1/index.m3u8"    "/hls/g4/$STORE/1/index.m3u8"

if [ -n "${SMOKE_USER:-}" ] && [ -n "${SMOKE_PASS:-}" ]; then
  echo "== sau khi đăng nhập ($SMOKE_USER) =="
  body=$(printf '{"username":"%s","password":"%s"}' "$SMOKE_USER" "$SMOKE_PASS")
  got=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 -c "$JAR" -X POST \
        -H 'Content-Type: application/json' -d "$body" "$URL/api/login")
  if [ "$got" = "200" ]; then
    printf "OK   %-46s %s\n" "đăng nhập" "$got"
    expect 200 "/api/stores"                  /api/stores         "$JAR"
    expect 200 "/api/stats"                   /api/stats          "$JAR"
    expect 200 "/api/snap/$STORE/1"           "/api/snap/$STORE/1"        "$JAR"
    expect 200 "/hls/g4/$STORE/1/index.m3u8"  "/hls/g4/$STORE/1/index.m3u8" "$JAR"
  else
    printf "FAIL %-46s đăng nhập trả %s\n" "đăng nhập" "$got"
    fail=1
  fi
else
  echo "(bỏ qua kiểm tra sau đăng nhập: đặt SMOKE_USER và SMOKE_PASS để chạy)"
fi

echo
if [ "$fail" = 0 ]; then echo "Tất cả đạt."; else echo "Có mục hỏng."; fi
exit $fail
