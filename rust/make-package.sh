#!/usr/bin/env bash
# Đóng gói LilyCam (bản Rust) để gửi cho người khác dùng.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="lilycam-$(date +%Y%m%d)"
OUT="$ROOT/dist/$NAME"
rm -rf "$OUT"; mkdir -p "$OUT/data" "$OUT/bin" "$OUT/src"

echo "→ binary + UI"
cp "$ROOT/rust/target/release/lilycam" "$OUT/lilycam"
cp -r "$ROOT/public" "$OUT/public"
cp "$ROOT/README.md" "$ROOT/PORTING.md" "$OUT/" 2>/dev/null || true

echo "→ nguồn Rust"
cp -r "$ROOT/rust/src" "$OUT/src/"
cp "$ROOT/rust/Cargo.toml" "$ROOT/rust/Cargo.lock" "$OUT/src/" 2>/dev/null || true

echo "→ ffmpeg + helper NetSDK + SDK"
cp "$ROOT/bin/ffmpeg" "$OUT/bin/ffmpeg"
cp "$ROOT/bin/dahua-pb" "$OUT/bin/dahua-pb" 2>/dev/null || true
cp -r "$ROOT/sdk" "$OUT/sdk"

echo "→ dữ liệu mẫu (đã xoá mật khẩu camera)"
python3 - "$ROOT/data/cameras.json" "$OUT/data/cameras.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
for s in d.get("stores", []):
    s["pass"] = ""
json.dump(d, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("   ", len(d.get("stores", [])), "cơ sở, đã để trống mật khẩu")
PY
: > "$OUT/data/dm.ndjson"          # không kèm danh bạ nội bộ
echo '{}' > "$OUT/data/lark-views.json"
python3 - "$ROOT/data/lark.json" "$OUT/data/lark.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
d["enabled"] = False
# không kèm base/bảng thật của công ty
for k in ("base_token", "table_id", "cli", "base", "table"):
    if k in d:
        d[k] = ""
json.dump(d, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

echo "→ tài khoản admin mới"
( cd "$OUT" && ./lilycam --reset-password admin | tee /tmp/lilycam-pass.txt | sed 's/^/    /' )
{
  echo "LilyCam — tài khoản mặc định của gói này"
  echo "----------------------------------------"
  echo "  Tên đăng nhập : admin"
  echo "  Mật khẩu      : $(grep -o 'pass: .*' /tmp/lilycam-pass.txt | sed 's/pass: //')"
  echo
  echo "Đổi mật khẩu:  ./lilycam --set-password admin MatKhauMoi"
  echo "(chạy trong chính thư mục này, rồi khởi động lại ./lilycam)"
} > "$OUT/MAT-KHAU.txt"

echo "→ tài liệu cài đặt"
cp "$ROOT/rust/INSTALL.md" "$OUT/INSTALL.md"
cp "$ROOT/rust/camera-web.service.example" "$OUT/" 2>/dev/null || true

echo "→ nén"
( cd "$ROOT/dist" && tar czf "$NAME.tar.gz" "$NAME" )
rm -rf "$OUT"
ls -lh "$ROOT/dist/$NAME.tar.gz"
