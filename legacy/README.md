# legacy/ — bản Node.js cũ (chỉ để tham chiếu)

Thư mục này là **bản server Node.js trước khi chuyển sang Rust**. Không còn được dùng để chạy.

| File | Vai trò trước đây |
|---|---|
| `server.js` | HTTP server, API, phân quyền, session cookie |
| `lib/dahua.js` | Digest client cho đầu ghi Dahua (snapshot, MJPEG, PTZ) |
| `lib/hls.js` | Quản lý phiên ffmpeg → HLS |
| `lib/netsdk.js` | Phát lại bản ghi qua Dahua NetSDK |
| `lib/lark.js` | Ghi sự cố sang Lark "Giám sát tháng" |
| `lib/dns.js`, `lib/jpeg.js`, `sync-lark.js` | tiện ích |
| `start.sh`, `restart.sh`, `package.json` | chạy/khởi động lại bản Node |

Bản đang chạy: **Rust** (`rust/`), đóng gói Docker (`Dockerfile`, `docker-compose.yml`).
Xem `PORTING.md` để biết bảng đối chiếu Node → Rust.
