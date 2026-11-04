#!/usr/bin/env bash
# Đo thời điểm có segment đầu tiên với các cấu hình HLS khác nhau.
set -u
FF="$(cd "$(dirname "$0")/.." && pwd)/bin/ffmpeg"
LABEL="$1"; shift
OUT=$(mktemp -d /tmp/startbench.XXXXXX)
URL="rtsp://giamsat:VPSO98888@vpso972.homeip.vn:554/cam/realmonitor?channel=1&subtype=0"
T0=$(date +%s%N)
"$FF" -hide_banner -loglevel error -rtsp_transport tcp -timeout 8000000 -flags low_delay "$@" \
  -i "$URL" -an -vf "scale=720:-2:flags=lanczos,fps=20" \
  -c:v libx264 -preset veryfast -threads 2 -crf 23 -maxrate 2500k -bufsize 5000k \
  -profile:v main -bf 2 -x264-params aq-mode=2 -g 10 \
  -force_key_frames 'expr:gte(t,n_forced*0.5)' -pix_fmt yuv420p \
  -f hls -hls_time "$HLS_TIME" -hls_list_size "$HLS_LIST" \
  -hls_flags delete_segments+omit_endlist+independent_segments+temp_file \
  -hls_segment_filename "$OUT/seg%03d.ts" "$OUT/index.m3u8" 2>"$OUT/err.log" &
PID=$!
for i in $(seq 1 300); do
  n=$(ls "$OUT"/*.ts 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] && break
  sleep 0.1
done
FIRST=$(( ($(date +%s%N)-T0)/1000000 ))
sleep 6
SEGS=$(ls "$OUT"/*.ts 2>/dev/null | wc -l)
kill $PID 2>/dev/null; wait $PID 2>/dev/null
echo "$LABEL | segment đầu: ${FIRST}ms | segment trong ~6s: $SEGS"
rm -rf "$OUT"
