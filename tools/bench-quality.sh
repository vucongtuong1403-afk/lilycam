#!/usr/bin/env bash
# So sánh chất lượng/CPU của các cấu hình encode: tools/bench-quality.sh <nhãn> <filter> <x264 args...>
set -u
FF="$(cd "$(dirname "$0")/.." && pwd)/bin/ffmpeg"
LABEL="$1"; VF="$2"; shift 2
OUT=$(mktemp -d /tmp/qbench.XXXXXX)
URL="rtsp://giamsat:VPSO98888@vpso972.homeip.vn:554/cam/realmonitor?channel=1&subtype=0"
"$FF" -hide_banner -loglevel error -rtsp_transport tcp -timeout 8000000 -flags low_delay \
  -i "$URL" -an -vf "$VF" "$@" \
  -f hls -hls_time 1 -hls_list_size 6 \
  -hls_flags delete_segments+omit_endlist+independent_segments+temp_file \
  -hls_segment_filename "$OUT/seg%03d.ts" "$OUT/index.m3u8" 2>"$OUT/err.log" &
PID=$!
for i in $(seq 1 200); do [ -n "$(ls "$OUT"/*.ts 2>/dev/null)" ] && break; sleep 0.1; done
sleep 10
CPU=$(ps -o %cpu= -p $PID 2>/dev/null | tr -d ' ')
kill $PID 2>/dev/null; wait $PID 2>/dev/null
SEGS=$(ls "$OUT"/*.ts 2>/dev/null | wc -l)
BYTES=$(du -sb "$OUT" 2>/dev/null | cut -f1)
KBPS=$(( BYTES * 8 / 1000 / (SEGS>0?SEGS:1) ))
SEG=$(ls "$OUT"/*.ts 2>/dev/null | sed -n '3p')
[ -z "$SEG" ] && SEG=$(ls -t "$OUT"/*.ts 2>/dev/null | head -1)
"$FF" -hide_banner -loglevel error -i "$SEG" -frames:v 1 -update 1 -y "/tmp/frame-$LABEL.png" 2>/dev/null
echo "$LABEL | cpu=${CPU}% bitrate~=${KBPS}kbps segs=$SEGS frame=/tmp/frame-$LABEL.png"
rm -rf "$OUT"
