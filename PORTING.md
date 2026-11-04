# PORTING — LilyCam: Node.js → Rust

Bản Rust nằm trong `rust/` (crate `lilycam`, axum + tokio). Chạy:

```bash
cd rust
./cargo.sh run            # cổng 8790, hoặc PORT=8792 ./cargo.sh run
./cargo.sh build --release
```

`rust/cargo.sh` chỉ đặt `CARGO_HOME`/`RUSTUP_HOME` vào trong dự án (`.cargo`, `.rustup`) để không cần quyền ghi `$HOME`.

## Đã port

| Node | Rust | Ghi chú |
|---|---|---|
| `server.js` router/API | `src/main.rs` | cùng đường dẫn, cùng JSON |
| `lib/dahua.js` | `src/dahua.rs` | Digest MD5 tự viết, snapshot, MJPEG, PTZ |
| `lib/hls.js` | `src/hls.rs` | mỗi phiên 1 ffmpeg, hồ sơ g2…g10/hd, ngủ sau 180 s |
| `lib/lark.js` | `src/lark.rs` | chụp ảnh → Giám sát tháng qua `lark-cli`, tuần tự tính |
| `lib/jpeg.js` | `mod jpeg` trong `main.rs` | đọc kích thước JPEG |
| phiên đăng nhập (HMAC) | `src/auth.rs` | **cookie của bản Node vẫn dùng được** |
| mật khẩu scrypt | `src/auth.rs` | N=16384, r=8, p=1, 64 byte — đọc thẳng `users.json` |

Đã kiểm: `/api/health`, `/api/stores` (nhận cookie cũ), `/api/snap` (ảnh thật từ đầu ghi), trang tĩnh `/`.

Đã kiểm thêm (vòng 2): `POST /api/warm/{store}/{ch}`, `POST /api/release/{store}`,
`POST /api/probe/{store}` → `{"ok":true,"ms":1242}`, `GET /api/dvr/{store}` → 302 sang giao diện đầu ghi,
`GET /api/pbcheck/{store}`, `GET /api/storecfg/{store}`.
`GET /api/records/{store}/{ch}?date=` gọi helper NetSDK: với 57 Nguyễn Ngọc Doãn trả đúng đoạn
`{"s":1793725200,"e":1793784024}` — **trùng khớp bản Node**.

## Chưa port (còn ở bản Node)

- ~~Xem lại bản ghi~~ **đã port**: `src/netsdk.rs` spawn helper, tail-read `.dav`, bóc header DHAV
  44 byte/1024, bơm vào ffmpeg. Kiểm: `GET /hls/pb<ts>/57-…/1/index.m3u8` → 200 sau 3,2 s, playlist hợp lệ.
- Cache `pending` (gộp request trùng) — semaphore 24 toàn cục đã có.
- Rate-limit đăng nhập (10 lần/10 phút theo IP, 8 lần theo tài khoản).
- `PUT /api/stores/{id}` (lưu sửa thông tin kết nối), `/api/stats` chưa có uptime/RSS thật.

Cho tới khi port xong các phần trên, service systemd vẫn chạy bản Node (`ExecStart=…/node server.js`).
Muốn chuyển hẳn sang Rust (cần quyền root):

```bash
sudo sed -i 's|ExecStart=.*|ExecStart=/home/tuong-vu/Camera xịn vãi /rust/target/release/lilycam|' /etc/systemd/system/camera-web.service
sudo sed -i 's|^WorkingDirectory=.*|WorkingDirectory=/home/tuong-vu/Camera xịn vãi |' /etc/systemd/system/camera-web.service
sudo systemctl daemon-reload && sudo systemctl restart camera-web
```

## Đối chiếu Node ↔ Rust (cùng dữ liệu, cùng cookie)

| Kiểm | Node (8790) | Rust (8793, release) |
|---|---|---|
| `/api/health` | 200 | 200 |
| `/api/stores` | 37 cơ sở, `hd:true` | 37 cơ sở, `hd:true` |
| `/api/snap/57-…/2` | 200 (10.325 B) | 200 (14.307 B) — cùng nguồn, khác thời điểm |
| `/api/records/57-…/1?date=` | `{s:1793725200,e:1793784024}` | trùng |
| `/hls/pb<ts>/…/index.m3u8` | 200 | 200 (3,2 s) |
| RAM tiến trình | ~60 MB | **~5 MB** |
| 8 endpoint (`rust/smoke.sh`) | 200 | **200 — tất cả khớp** |

> Lưu ý khi viết script so sánh: môi trường có biến `NODE` trỏ tới binary node
> (`/home/…/bin/node`), nên đừng đặt tên biến URL là `NODE`/`RUST` — dùng `NODE_URL`/`RUST_URL`
> (đã sửa trong `rust/smoke.sh`).

## Quy ước từ nay

Mọi thay đổi phía server làm bằng Rust trong `rust/`; bản Node chỉ giữ để đối chiếu hành vi cho tới khi port đủ.
