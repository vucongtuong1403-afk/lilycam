#!/usr/bin/env bash
# Đo chi phí mở luồng: thời điểm có segment đầu + CPU + dung lượng.
# dùng: tools/bench-stream.sh "<input url>" "<video filter>" <maxrate> "<nhãn>"
set -u
FF="$(cd "$(dirname "$0")/.." && pwd)/bin/ffmpeg"
IN="$1"; VF="$2"; RATE="$3"; LABEL="${4:-$IN}"
OUT=$(mktemp -d /tmp/hlsbench.XXXXXX)
"$FF" -hide_banner -loglevel error -rtsp_transport tcp -timeout 8000000 \
  -flags low_delay -i "$IN" \
  -c:v libx264 -preset ultrafast -tune zerolatency -threads 2 -vf "$VF" \
  -crf 26 -maxrate "$RATE" -bufsize "$(( ${RATE%k} * 2 ))k" -profile:v main \
  -g 12 -force_key_frames 'expr:gte(t,n_forced*0.5)' -pix_fmt yuv420p -an \
  -f hls -hls_time 1 -hls_list_size 4 \
  -hls_flags delete_segments+omit_endlist+independent_segments \
  -hls_segment_filename "$OUT/seg%03d.ts" "$OUT/index.m3u8" 2>"$OUT/err.log" &
PID=$!
T0=$(date +%s%N); FIRST=0
for i in $(seq 1 250); do
  n=$(ls "$OUT"/*.ts 2>/dev/null | wc -l)
  if [ "$n" -gt 0 ]; then FIRST=$(( ($(date +%s%N)-T0)/1000000 )); break; fi
  sleep 0.1
done
sleep 12
CPU=$(ps -o %cpu= -p $PID 2>/dev/null | tr -d ' ')
RSS=$(ps -o rss= -p $PID 2>/dev/null | tr -d ' ')
kill $PID 2>/dev/null; wait $PID 2>/dev/null
SZ=$(du -sk "$OUT" | cut -f1)
ERRS=$(grep -c "Error\|error" "$OUT/err.log" 2>/dev/null || true)
echo "$LABEL | first_segment=${FIRST}ms cpu=${CPU:-?}% rss=${RSS:-?}KB out=${SZ}KB err_lines=${ERRS}"
rm -rf "$OUT"
