//! Phát lại bản ghi qua NetSDK: helper C tải .dav, Rust bóc header DHAV rồi bơm vào ffmpeg.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

pub struct PbSession {
    pub dir: PathBuf,
    pub helper: Child,
    pub ff: Child,
    pub last: Instant,
}

impl PbSession {
    #[allow(dead_code)]
    pub async fn kill(&mut self) {
        let _ = self.ff.start_kill();
        let _ = self.helper.start_kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Bóc 44 byte header DHAV của mỗi khối 1024 byte (giống lib/netsdk.js).
fn strip(state: &mut Vec<u8>, chunk: &[u8]) -> Vec<u8> {
    state.extend_from_slice(chunk);
    let mut out = Vec::with_capacity(state.len());
    let mut i = 0;
    while state.len() - i >= 1024 {
        let blk = &state[i..i + 1024];
        if blk[0] == b'D' && blk[1] == b'H' && blk[2] == b'A' && blk[3] == b'V' {
            out.extend_from_slice(&blk[44..]);
        } else {
            out.extend_from_slice(blk);
        }
        i += 1024;
    }
    let rest = state[i..].to_vec();
    *state = rest;
    out
}

async fn pump(dav: PathBuf, mut pos: u64, mut stdin: ChildStdin) {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let mut f = match tokio::fs::File::open(&dav).await { Ok(f) => f, Err(_) => continue };
        let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
        if size <= pos { continue; }
        let want = (size - pos) as usize;
        let mut chunk = vec![0u8; want];
        if f.seek(std::io::SeekFrom::Start(pos)).await.is_err() { continue; }
        let n = match f.read(&mut chunk).await { Ok(n) => n, Err(_) => continue };
        pos += n as u64;
        let out = strip(&mut buf, &chunk[..n]);
        if !out.is_empty() && stdin.write_all(&out).await.is_err() { break; }
    }
}

/// Mở phiên phát lại cho kênh/giây bắt đầu; trả về thư mục chứa HLS.
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
    let dav = dir.join("rec.dav");
    let max_sec = 600i64;
    let end_sec = start_sec + max_sec;
    // Dahua NetSDK đánh kênh từ 0, còn web/RTSP đánh từ 1 → phải trừ 1.
    // "CAM N" (UI) = kênh N-1 của SDK. Đổi bằng PB_CHANNEL_OFFSET nếu đầu ghi khác.
    let offset: i64 = std::env::var("PB_CHANNEL_OFFSET").ok().and_then(|v| v.parse().ok()).unwrap_or(-1);
    let sdk_ch = (ch as i64 + offset).max(0);
    let helper_child = Command::new(helper)
        .args([store.host.as_str(), &store.sdk_port.max(1).to_string(), &store.user, &store.pass,
            &sdk_ch.to_string(), &start_sec.to_string(), &end_sec.to_string(), &max_sec.to_string()])
        .env("PB_DOWNLOAD", dav.to_string_lossy().to_string())
        .env("LD_LIBRARY_PATH", sdk_lib)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().ok()?;

    let mut enc: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-re".into(), "-f".into(), "hevc".into(), "-i".into(), "pipe:0".into()];
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
    enc.extend(["-g".into(), "50".into(), "-an".into(), "-f".into(), "hls".into(),
        "-hls_time".into(), "1".into(), "-hls_list_size".into(), "10".into(),
        "-hls_flags".into(), "delete_segments+omit_endlist+independent_segments".into(),
        "-hls_segment_filename".into(), dir.join("seg%03d.ts").to_string_lossy().to_string(),
        dir.join("index.m3u8").to_string_lossy().to_string()]);
    let mut ff = Command::new(ffmpeg)
        .args(&enc)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().ok()?;
    let stdin = ff.stdin.take()?;
    let dav2 = dav.clone();
    tokio::spawn(async move { pump(dav2, 0, stdin).await; });

    Some(PbSession { dir: dir.to_path_buf(), helper: helper_child, ff, last: Instant::now() })
}

/// Cắt một đoạn bản ghi thành MP4 1080p (H.264 + faststart) để tải về máy.
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
    let offset: i64 = std::env::var("PB_CHANNEL_OFFSET").ok().and_then(|v| v.parse().ok()).unwrap_or(-1);
    let sdk_ch = (ch as i64 + offset).max(0);
    let mut child = Command::new(helper)
        .args([store.host.as_str(), &store.sdk_port.max(1).to_string(), &store.user, &store.pass,
            &sdk_ch.to_string(), &start_sec.to_string(), &end_sec.to_string(), &dur.to_string()])
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
    let raw = std::fs::read(&dav).ok()?;
    if raw.len() < 1024 { return None; }
    let mut state: Vec<u8> = Vec::new();
    let stripped = strip(&mut state, &raw);
    if stripped.is_empty() { return None; }
    let h265 = dir.join("rec.h265");
    std::fs::write(&h265, &stripped).ok()?;
    let out = dir.join("clip.mp4");
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-f".into(), "hevc".into(), "-i".into(), h265.to_str()?.to_string()];
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
    let _ = std::fs::remove_file(&h265);
    if !status.success() || !out.exists() { return None; }
    Some(out)
}
