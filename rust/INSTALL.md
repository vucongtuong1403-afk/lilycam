# LilyCam — hướng dẫn cài đặt (bản Rust)

Gói này là **server LilyCam viết bằng Rust**: web nội bộ xem camera Dahua (37 cơ sở), có HLS,
xem lại bản ghi, PTZ, chụp ảnh gửi Lark "Giám sát tháng".

## 1. Yêu cầu

- Linux x86_64 (đã test trên Ubuntu, Intel i5-14400), **glibc ≥ 2.35**
- Không cần Node, không cần npm. `bin/ffmpeg` và `sdk/lib` đã kèm sẵn.
- Mở được RTSP (554) và HTTP (80/85/8181…) tới các đầu ghi.

## 2. Chạy thử (30 giây)

```bash
tar xzf lilycam-*.tar.gz && cd lilycam-*
./lilycam                      # http://localhost:8790
```

Lần chạy đầu, đặt mật khẩu quản trị:

```bash
./lilycam --reset-password admin    # in ra mật khẩu ngẫu nhiên
./lilycam --set-password admin 12345678
```

rồi tải lại trang, đăng nhập `admin` + mật khẩu vừa đặt.

## 3. Đổi sang camera của bạn

Mở `data/cameras.json`, mỗi cơ sở:

```json
{ "id": "cua-hang-1", "name": "Tên hiển thị", "unit": "Cửa hàng",
  "host": "ddns-cua-ban.homeip.vn", "port": 80,
  "user": "admin", "pass": "mật-khẩu-đầu-ghi", "cameras": 8 }
```

- `id`: chữ thường, không dấu, không cách (dùng trong URL).
- `port`: cổng web của đầu ghi (80/85/8181…); RTSP luôn là 554.
- `cameras`: số kênh; hoặc thêm `activeChannels: [1,2,3,…]` nếu kênh không liên tục.

Sửa xong khởi động lại: `Ctrl+C` rồi `./lilycam` (hoặc `systemctl restart camera-web`).

## 4. Tuỳ chỉnh

| Muốn đổi | Sửa ở |
|---|---|
| Cổng web | `PORT=9000 ./lilycam` |
| Camera "ngủ" sau bao lâu | `IDLE_SECS=300 ./lilycam` (mặc định 180) |
| Số phiên tối đa / phiên HD | `MAX_STREAMS=20 MAX_HD=3` |
| Chất lượng hình (720p/crf/bitrate) | `src/hls.rs` → hằng `PROFILES`, rồi build lại |
| Tỉ lệ khung mặc định (16:9) | `public/app.js` → `applyAspect(... || '16:9')` |
| Giao diện, màu sắc | `public/styles.css`, `public/index.html` |
| Tên thương hiệu | `public/index.html` (tiêu đề, logo) |

Build lại sau khi sửa mã (cần cài Rust: https://rustup.rs):

```bash
cd src && cargo build --release && cp target/release/lilycam ../lilycam
```

## 5. Chạy nền bằng systemd

```bash
sudo cp camera-web.service.example /etc/systemd/system/camera-web.service
sudo nano /etc/systemd/system/camera-web.service     # sửa đường dẫn + User
sudo systemctl daemon-reload && sudo systemctl enable --now camera-web
```

## 6. Nút "Chụp ảnh → Giám sát tháng" (tuỳ chọn)

Cần `lark-cli` đã đăng nhập bằng tài khoản Lark, và `data/lark.json` trỏ đúng base/bảng.
Không dùng thì để `"enabled": false` — ảnh vẫn được lưu vào `data/captures/`.

## 7. Kiểm tra sức khoẻ

```bash
curl -s localhost:8790/api/health           # {"ok":true,"stores":N}
tail -f server.log                          # nếu chạy qua systemd
```

## 8. Cấu trúc

```
lilycam          binary server
public/          giao diện web (HTML/CSS/JS)
data/            cameras.json, users.json, zones.json, captures/, hls/ (tự tạo)
bin/ffmpeg       ffmpeg tĩnh (kèm sẵn)
bin/dahua-pb     helper NetSDK cho phần xem lại bản ghi
sdk/lib/         thư viện Dahua NetSDK
src/             mã nguồn Rust (Cargo.toml + src/*.rs)
```

## Dữ liệu cần có trong `data/`

| Tệp | Vai trò |
|---|---|
| `cameras.json` | danh sách cơ sở + tài khoản đầu ghi (điền tay) |
| `users.json` | tài khoản đăng nhập (hash scrypt) — tạo bằng `./lilycam --set-password admin …` |
| `stores.json` | danh mục cơ sở có `cht_id` (cửa hàng trưởng) để tự gắn người chịu trách nhiệm khi lỗi 5S/4C |
| `dm.ndjson` | (tuỳ chọn) danh bạ cũ — nguồn dự phòng cho CHT và nhóm chat |
| `lark.json` | cấu hình base Giám sát tháng (đặt `enabled: false` nếu không dùng) |
| `lark-views.json` | bản đồ cơ sở → tab (view) trong bảng |

Thiếu `stores.json` thì web vẫn chạy, chỉ là không tự gắn được CHT cho lỗi 5S/4C.

