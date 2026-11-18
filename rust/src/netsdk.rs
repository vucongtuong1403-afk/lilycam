//! Phát lại bản ghi qua NetSDK: helper C đẩy nguyên khối DHAV ra stdout, ffmpeg tự bóc
//! bằng demuxer "dhav" rồi ghi HLS. Không bóc header bằng tay: demuxer của ffmpeg đồng bộ
//! lại đúng sau mỗi khối và sau cả ranh giới giữa hai cửa sổ bản ghi.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// Cửa sổ bản ghi tối đa mỗi phiên (giây). Dài hơn thì phải mở phiên mới.
const MAX_WINDOW: i64 = 3600;

pub struct PbSession {
    pub dir: PathBuf,
    pub helper: Child,
    pub ff: Child,
    pub last: Instant,
}

/// Kênh SDK của Dahua đánh từ 0, web/RTSP đánh từ 1.
pub fn sdk_channel(ch: u32) -> i64 {
    let offset: i64 = std::env::var("PB_CHANNEL_OFFSET").ok().and_then(|v| v.parse().ok()).unwrap_or(-1);
    (ch as i64 + offset).max(0)
}

/// Tốc độ đọc bản ghi so với thời gian thực. 2 = gom trước gấp đôi, nhờ đó tốc độ phát
/// 2× chạy liền mạch và các lần tua có sẵn dữ liệu trong đệm.
fn read_rate() -> String {
    std::env::var("PB_READRATE").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "2".to_string())
}

/// Nối ống helper → ffmpeg.
fn pipe(mut src: tokio::process::ChildStdout, mut dst: tokio::process::ChildStdin) {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match src.read(&mut buf).await { Ok(0) | Err(_) => break, Ok(n) => n };
            if tokio::io::AsyncWriteExt::write_all(&mut dst, &buf[..n]).await.is_err() { break; }
            let _ = tokio::io::AsyncWriteExt::flush(&mut dst).await;
        }
    });
}

/// Mở phiên phát lại cho kênh/giây bắt đầu; trả về thư mục chứa HLS.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    helper: &Path,
    sdk_lib: &Path,
    ffmpeg: &Path,
    store: &crate::Store,
    ch: u32,
    start_sec: i64,
    dir: &Path,
    vaapi: Option<&Path>,
) -> Option<PbSession> {
    if !helper.exists() || !ffmpeg.exists() { return None; }
    std::fs::create_dir_all(dir).ok()?;
    let end_sec = start_sec + MAX_WINDOW;
    let log = std::fs::File::create(dir.join("pb.log")).ok();
    let mut helper_child = Command::new(helper)
        .args([store.host.as_str(), &store.sdk_port.max(1).to_string(), &store.user, &store.pass,
            &sdk_channel(ch).to_string(), &start_sec.to_string(), &end_sec.to_string(), &MAX_WINDOW.to_string()])
        .env("PB_DLSTREAM", "1")
        // đẩy nguyên khối DHAV: ffmpeg có demuxer "dhav" hiểu đúng định dạng này
        .env("PB_RAW", "1")
        .env("LD_LIBRARY_PATH", sdk_lib)
        .stdin(Stdio::null()).stdout(Stdio::piped())
        .stderr(match log { Some(f) => Stdio::from(f), None => Stdio::null() })
        .spawn().ok()?;
    let helper_out = helper_child.stdout.take()?;

    let mut enc: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-readrate".into(), read_rate(), "-readrate_initial_burst".into(), "8".into(),
        "-f".into(), "dhav".into(), "-i".into(), "pipe:0".into()];
    if let Some(dev) = vaapi {
        enc.extend(["-vaapi_device".into(), dev.display().to_string(),
            "-vf".into(), "format=nv12,hwupload".into(),
            "-c:v".into(), "h264_vaapi".into(),
            "-b:v".into(), "3500k".into(), "-maxrate".into(), "3500k".into(),
            "-bufsize".into(), "7000k".into(), "-profile:v".into(), "main".into()]);
    } else {
        enc.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-tune".into(), "zerolatency".into(), "-threads".into(), "2".into(),
            "-crf".into(), "24".into(), "-maxrate".into(), "3500k".into(), "-bufsize".into(), "7000k".into(),
            "-profile:v".into(), "main".into(), "-pix_fmt".into(), "yuv420p".into()]);
    }
    // Playlist kiểu EVENT: giữ toàn bộ segment của cửa sổ và KHÔNG đóng danh sách, nên
    // trình phát coi đây là bản ghi đang dài thêm, phát tuần tự từ đầu thay vì đuổi mép
    // live. Nhờ vậy tốc độ 0.5–4× và tua lùi trong vùng đã tải đều chạy đúng.
    // Bản ghi Dahua có tiếng (khối 0xf0, G.711 A-law 8 kHz mono): giữ lại để nút loa
    // hoạt động khi xem lại. `0:a:0?` chịu được đầu ghi không ghi âm.
    enc.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0?".into(),
        "-c:a".into(), "aac".into(), "-b:a".into(), "64k".into(),
        "-ar".into(), "44100".into(), "-ac".into(), "1".into(),
        "-af".into(), "volume=8dB".into()]);
    enc.extend(["-g".into(), "50".into(), "-force_key_frames".into(), "expr:gte(t,n_forced*2)".into(),
        "-f".into(), "hls".into(),
        "-hls_time".into(), "2".into(), "-hls_playlist_type".into(), "event".into(),
        "-hls_flags".into(), "independent_segments".into(),
        "-hls_segment_filename".into(), dir.join("seg%04d.ts").to_string_lossy().to_string(),
        dir.join("index.m3u8").to_string_lossy().to_string()]);
    let mut ff = Command::new(ffmpeg)
        .args(&enc)
        .stdin(Stdio::piped()).stdout(Stdio::null())
        .stderr(Stdio::from(std::fs::File::create(dir.join("ff.log")).ok()?))
        .spawn().ok()?;
    if let Some(ff_in) = ff.stdin.take() {
        pipe(helper_out, ff_in);
    }

    Some(PbSession { dir: dir.to_path_buf(), helper: helper_child, ff, last: Instant::now() })
}

/// Cắt một đoạn bản ghi thành MP4 1080p (H.264 + faststart) để tải về máy.
#[allow(clippy::too_many_arguments)]
pub async fn clip(
    helper: &Path,
    sdk_lib: &Path,
    ffmpeg: &Path,
    store: &crate::Store,
    ch: u32,
    start_sec: i64,
    dur: i64,
    dir: &Path,
    vaapi: Option<&Path>,
) -> Option<PathBuf> {
    if !helper.exists() || !ffmpeg.exists() { return None; }
    std::fs::create_dir_all(dir).ok()?;
    let dav = dir.join("rec.dav");
    let end_sec = start_sec + dur;
    let mut child = Command::new(helper)
        .args([store.host.as_str(), &store.sdk_port.max(1).to_string(), &store.user, &store.pass,
            &sdk_channel(ch).to_string(), &start_sec.to_string(), &end_sec.to_string(), &dur.to_string()])
        .env("PB_DOWNLOAD", dav.to_string_lossy().to_string())
        .env("LD_LIBRARY_PATH", sdk_lib)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().ok()?;

    // chờ helper tải xong: file ngừng tăng trong ~3 giây, hoặc quá hạn
    let deadline = Instant::now() + Duration::from_secs(dur as u64 + 60);
    let mut last = 0u64;
    let mut quiet = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let size = std::fs::metadata(&dav).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size == last { quiet += 1; } else { quiet = 0; }
        last = size;
        if quiet >= 8 || Instant::now() > deadline { break; }
    }
    let _ = child.start_kill();
    if std::fs::metadata(&dav).map(|m| m.len()).unwrap_or(0) < 1024 { return None; }

    let out = dir.join("clip.mp4");
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-f".into(), "dhav".into(), "-i".into(), dav.to_str()?.to_string()];
    if let Some(dev) = vaapi {
        a.extend(["-vaapi_device".into(), dev.display().to_string(),
            "-vf".into(), "fps=20,format=nv12,hwupload,scale_vaapi=w=-2:h=1080".into(),
            "-c:v".into(), "h264_vaapi".into(),
            "-b:v".into(), "6M".into(), "-maxrate".into(), "6M".into(), "-bufsize".into(), "12M".into(),
            "-profile:v".into(), "main".into()]);
    } else {
        a.extend(["-vf".into(), "scale=-2:1080:flags=lanczos,fps=20,format=yuv420p".into(),
            "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-crf".into(), "20".into(), "-maxrate".into(), "6M".into(), "-bufsize".into(), "12M".into(),
            "-profile:v".into(), "main".into(), "-pix_fmt".into(), "yuv420p".into()]);
    }
    a.extend(["-color_range".into(), "tv".into(), "-colorspace".into(), "bt709".into(),
        "-color_primaries".into(), "bt709".into(), "-color_trc".into(), "bt709".into(),
        "-an".into(), "-movflags".into(), "+faststart".into(), out.to_str()?.to_string()]);
    let status = Command::new(ffmpeg).args(&a).status().await.ok()?;
    let _ = std::fs::remove_file(&dav);
    if !status.success() || !out.exists() { return None; }
    Some(out)
}