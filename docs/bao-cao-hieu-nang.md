# Báo cáo hiệu năng hệ thống camera — LilyCam

**Thời điểm đo:** 03/11/2026 17:31
**Công cụ:** `tools/bench.py` (DNS/TCP/snapshot/HLS) + `GET /api/stats` (phiên đang chạy, RAM)
**Phạm vi:** 35/37 cơ sở có địa chỉ (2 cơ sở chỉ có SN)

## 1. Số đo tổng hợp

| Chỉ số | min | trung vị | p90 | max |
|---|---:|---:|---:|---:|
| Phân giải DDNS | 22 ms | **238 ms** | 277 ms | 319 ms |
| Kết nối TCP 554 (RTSP) | 4 ms | 24 ms | 28 ms | 57 ms |
| Ảnh snapshot (HTTP digest) | 284 ms | **552 ms** | 998 ms | 1725 ms |
| Mở luồng HD (HLS sẵn sàng) | 2,8 s | **2,9 s** | 3,6 s | 11,7 s |

- Đang phản hồi: **31–32 / 35** cơ sở.
- Codec: **20 HEVC**, 2 H.264, còn lại chưa dò được (offline).
- RAM tiến trình Node: ~55–90 MB; mỗi phiên HD (HEVC) ăn ~0,5–1 core CPU.

## 2. Điểm chưa tối ưu (xếp theo mức ảnh hưởng)

### 2.1. DNS là chi phí cố định ~240 ms mỗi kết nối — ĐÃ XỬ LÝ
Mỗi lần mở stream/ảnh, hệ thống phải phân giải `*.homeip.vn` lại từ đầu (ffmpeg + Node + SDK).
**Đã sửa:** cache DDNS → IP 5 phút (`lib/dns.js`), mọi kết nối dùng IP trực tiếp.
Kết quả đo lại: snapshot trung vị **697 → 552 ms**.

### 2.2. HEVC phải transcode — nút cổ chai lớn nhất còn lại
20/22 đầu ghi dùng HEVC, Chrome không giải mã được nên server phải transcode H.264.
- Mất **1,5–2,5 s** khởi động (chờ keyframe + encode segment đầu).
- Ăn CPU gấp ~5 lần so với copy luồng.
**Đề xuất:** với các cửa hàng xem thường xuyên, hạ codec đầu ghi về **H.264** trong cấu hình camera
(Encode → H.264, GOP 25) → HD mở trong ~1 s và CPU giảm mạnh. Không cần sửa web.

### 2.3. Lỗi giải mã khi mở nhiều luồng HEVC cùng lúc
Log có 55 dòng `[hevc] Error constructing the frame RPS` — xảy ra khi một đầu ghi phục vụ 6–10
luồng đồng thời (băng thông upload hoặc CPU đầu ghi không đủ).
**Đề xuất:** giới hạn số ô lưới với đầu ghi HEVC còn **6 ô** (thay vì 10), hoặc tự động hạ khi phát hiện lỗi.
Ước tính giảm ~70% lỗi.

### 2.4. Snapshot chậm (p90 ~1 s) ảnh hưởng poster và timeline
Do phải chờ digest 2 vòng + encode JPEG trên đầu ghi.
**Đề xuất:** tăng thời gian cache khung cuối (đang 0 s cho `?fast=1`, 4 s cho cache thường) lên 30–60 s
cho ảnh poster — người dùng gần như không phân biệt được.

### 2.5. Cơ sở chết / chập chờn (cần người kiểm tra vật lý, không phải lỗi web)

| Cơ sở | Hiện tượng |
|---|---|
| 115 Kim Mã | không kết nối (000) |
| 186 Nguyễn Văn Cừ | vừa rớt trong lúc đo (000) |
| 356 Cầu Giấy (kho) | cổng 80 đóng |
| 153 Trần Đại Nghĩa (DVR 2) | không phân giải được DDNS |
| 274 Nguyễn Trãi | HD trả 503 |
| 179 Trâu Quỳ | HD trả 503 (kết nối bị từ chối) |

### 2.6. Cửa hàng xa có HD chậm
287 Nguyễn Trãi – HCM mở HD **11,7 s** (mạng đầu ghi yếu). 319 Lê Lợi – Hải Phòng 3,8 s.
**Đề xuất:** với các máy này nên dùng luồng phụ (Nhẹ) hoặc nâng gói upload của cửa hàng.

## 3. Việc nên làm tiếp (theo thứ tự)

1. **Hạ codec các đầu ghi quan trọng về H.264** — hiệu quả lớn nhất, không cần sửa code.
2. Giới hạn 6 ô lưới cho đầu ghi HEVC, hoặc thêm nút "tiết kiệm băng thông".
3. Tăng cache poster lên 30–60 s.
4. Kiểm tra 6 cơ sở ở mục 2.5.
5. Theo dõi bằng `GET /api/stats` (phiên đang chạy, RAM, uptime) — có thể log mỗi 5 phút để xem xu hướng.

## 4. Tái lập phép đo

```bash
TOKEN=$(node -e "...")        # cookie phiên admin
python3 tools/bench.py --port 8790 --hd 8 --token "$TOKEN"
# kết quả thô: docs/bench.json
```

---

## 5. Đợt tối ưu 04/11/2026 (sau khi chuyển dự án sang `~/Camera xịn vãi`)

### 5.1. Nguyên nhân gốc của "mở chậm + giật": cờ `-fflags nobuffer`

Đo trực tiếp cùng một luồng (Lily Home, kênh 1, HEVC 1080p25), thời điểm có khung hình đầu tiên:

| Bộ cờ ffmpeg | Khung đầu tiên | Số dòng lỗi |
|---|---:|---:|
| `-fflags nobuffer -flags low_delay` (code cũ) | **9.514 ms** | 178 |
| chỉ `-flags low_delay` | **1.958 ms** | 0 |
| không cờ đặc biệt | 2.126 ms | 0 |
| `nobuffer+genpts+discardcorrupt` | 9.195 ms | 178 |

Với HEVC của Dahua, `nobuffer` làm ffmpeg bỏ qua các khung tham chiếu đầu luồng → trình giải mã
báo `Error constructing the frame RPS` liên tục và phải chờ IDR kế tiếp, nên vừa chậm ~7 giây
vừa giật. **Đã bỏ `nobuffer`, giữ `low_delay`.**

Kết quả (cùng máy, cùng đầu ghi):

| Luồng | Trước | Sau |
|---|---:|---:|
| Lưới 4 ô – Lily Home | 9.029 ms | **2.080 ms** |
| 4 ô mở cùng lúc | 9–11 s | **2,0–2,3 s** (cả 4 ô) |
| HD 1 camera | 2,8–3,0 s | **1,4–2,9 s** |
| Lỗi `frame RPS` trong log | có, liên tục | **0** (200+ dòng log sau khi restart) |

Đo lại trên bản chạy thật ngay sau khi restart (63 phiên đủ loại 2/4/6/8/10 ô + HD):
trung vị **1,8 s**, p90 **3,7 s**, max 8,0 s, **0 lỗi RPS**.

### 5.2. Lưới 8–10 ô chuyển sang luồng phụ (`subtype=1`)

Đo 10 ô cùng lúc trên đầu ghi 116A (17 kênh):

| Nguồn | CPU tổng | Segment đầu | Kích thước ô |
|---|---:|---|---|
| Luồng chính 1080p (cũ) | **2,55 core** | 1,7–4,4 s | 480×270 |
| Luồng phụ (mới) | **0,79 core** | 1,5–4,7 s | 640×360 |

Ô lưới 10 chỉ rộng ~300 px nên 640×360 là đủ; đổi lại đầu ghi giảm ~85% băng thông upload
(nguyên nhân gây lỗi HEVC khi mở 8–10 ô). Đầu ghi không có luồng phụ → tự quay lại luồng chính
sau một lần thử (ghi nhớ 30 phút).

### 5.3. Các chỉnh nhỏ khác

- `hls_list_size`: lưới 4 → **6** segment, HD 6 → **8** (thêm đệm, bớt khựng khi mạng chậm).
- Thêm cờ `temp_file`: ffmpeg ghi segment ra `.tmp` rồi đổi tên → trình phát không bao giờ
  đọc phải segment đang ghi dở.
- Tăng độ mượt: lưới 2/4 ô **15 → 20 fps**, lưới 6 ô **12 → 15 fps** (CPU gần như không đổi vì
  chi phí giải mã HEVC mới là phần lớn).
- Trình phát: `maxLiveSyncPlaybackRate: 1.5` — tụt sau live edge thì tăng tốc nhẹ để bắt kịp
  thay vì khựng hình.
- Sửa log sai: đóng phiên có chủ đích không còn ghi `lỗi: ffmpeg thoát (255)`.
- Cache codec tách theo luồng chính/phụ (`data/codecs.json` khoá `c:<id>:s`).

### 5.4. Còn tồn tại (không phải lỗi web)

- `186 Nguyễn Văn Cừ`, `237 Chùa Bọc` kênh 10: đầu ghi trả dữ liệu hỏng
  (`Invalid data found when processing input`) — cần kiểm tra kênh/cấu hình trên đầu ghi.
- 6 cơ sở trong mục 2.5 vẫn offline hoặc cổng đóng.
- Transcode HEVC vẫn tốn ~20% core cho mỗi ô 720p; muốn nhẹ nhất thì hạ codec đầu ghi về H.264
  (giữ nguyên `g4` 20 fps, H.264 sẽ được copy nguyên luồng, CPU ~0).

### 5.4b. Giảm nhiễu hình (04/11/2026, sau phản hồi "hình bị nhiễu")

Cấu hình cũ `-preset ultrafast -tune zerolatency -crf 26 -maxrate 1100k` cho ô 720p: hệ số nén quá
cao + ultrafast tắt B-frame/mbtree nên ảnh bị block/mosquito quanh mép. Đã đổi:

| Tham số | Cũ | Mới |
|---|---|---|
| preset | ultrafast | **veryfast** |
| tune | zerolatency | (bỏ — cho phép B-frame) |
| crf (720p) | 26 | **23** |
| maxrate (720p) | 1100k | **2500k** |
| thu nhỏ | bicubic | **lanczos** |
| x264 | — | `aq-mode=2`, `bf=2` |
| HD 1080p | crf 24 / 3500k | **crf 21 / 4500k** |

Giá phải trả: CPU mỗi phiên ~20% → **~40%** core (4 ô ≈ 1,6 core, 10 ô ≈ 4 core), băng thông
mỗi ô ~1,1 → **~1,4–2,5 Mbps**. Đo lại: 4 ô mở trong 2,0–2,8 giây, 10 ô 3,3–6,1 giây, 0 lỗi.

### 5.4c. Tăng tốc hiển thị (04/11/2026)

Đo trên bản chạy thật sau khi chỉnh:

| Tình huống | Trước | Sau |
|---|---:|---:|
| Mở lưới một cửa hàng (nguội) | ~2,8 s | **2,5 s** |
| Mở lại cùng cửa hàng trong 3 phút | ~2,8 s | **~0 s** (phiên còn ấm) |
| Mở HD 1 camera | 2,8–3,0 s | **1,35 s** (nhớ codec 6 giờ thay vì 15 phút) |
| Ảnh xem trước khi chờ HLS | không có | **poster tức thì** từ khung đã cache (~1 ms) |

Đã làm:
- Poster lấy khung gần nhất hiện ngay khi ô camera xuất hiện (không chờ HLS).
- `/api/snap?fast=1` trả 204 ngay nếu chưa có khung, **không gọi đầu ghi** (giữ kết nối cho luồng chính).
- Codec được nhớ **6 giờ** (trước 15 phút) nên mở HD không phải dò lại — mỗi lần dò mất ~1,5–2 s.
- Phiên giữ ấm 3 phút (mục 5.4b) nên bấm lại cùng cửa hàng là có hình ngay.

Giới hạn còn lại của HLS: ~1,3–2,5 s cho khung đầu (chờ keyframe của đầu ghi + encode segment đầu).
Muốn nhanh hơn nữa phải đổi công nghệ hoặc đổi cấu hình đầu ghi:

1. **Hạ I-frame interval trên đầu ghi** (Encode → I Frame Interval 25–50 thay vì 50–100):
   ffmpeg không phải chờ keyframe lâu → giảm ~0,5–1 s mỗi lần mở.
2. **H.264 cho các đầu ghi hay xem**: server copy nguyên luồng, bỏ hẳn bước transcode.
3. **WebRTC (go2rtc)**: độ trễ ~0,3–0,5 s thay vì 1–3 s, nhưng phải thêm 1 service + signaling.
4. **Encode bằng GPU Intel (QSV)**: cần `sudo usermod -aG render tuong-vu` rồi đăng nhập lại
   (hiện tài khoản chưa thuộc nhóm `render` nên `/dev/dri/renderD128` bị từ chối).

### 5.5. Đo lại

```bash
tools/bench-stream.sh "<rtsp url>" "scale=720:-2,fps=20" 1100k "g4"   # 1 phiên: ms + CPU
node tools/bench-grid.js bin/ffmpeg <host> <user> <pass> 1,2,3,4,5 1 "fps=10" 450k "luồng phụ" 20000
```
