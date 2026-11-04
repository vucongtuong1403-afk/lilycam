#!/usr/bin/env bash
# Chuyển service camera-web sang binary Rust. Chạy bằng:  sudo bash "…/switch-to-rust.sh"
set -euo pipefail
UNIT=/etc/systemd/system/camera-web.service
BIN="/home/tuong-vu/Camera xịn vãi /rust/target/release/lilycam"

[ -x "$BIN" ] || { echo "!! Không thấy binary: $BIN"; exit 1; }
[ -f "$UNIT" ] || { echo "!! Không thấy unit: $UNIT"; exit 1; }

cp -f "$UNIT" "$UNIT.bak-$(date +%Y%m%d-%H%M%S)"
echo "→ đã sao lưu unit cũ"

sed -i "s|^ExecStart=.*|ExecStart=\"$BIN\"|" "$UNIT"
echo "→ ExecStart mới:"; grep '^ExecStart=' "$UNIT"

systemctl daemon-reload
systemctl restart camera-web
sleep 2
systemctl is-active camera-web.service
systemctl show camera-web.service -p MainPID -p ExecStart --no-pager | head -2
curl -s -o /dev/null -w "health: %{http_code}\n" http://127.0.0.1:8790/api/health || true
echo
echo "Nếu cần quay lại bản Node:  sudo cp $UNIT.bak-* $UNIT && sudo systemctl daemon-reload && sudo systemctl restart camera-web"
