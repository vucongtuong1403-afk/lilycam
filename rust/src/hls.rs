//! Quản lý phiên HLS: mỗi phiên = 1 ffmpeg đọc RTSP luồng chính và ghi .m3u8/.ts.
use crate::Store;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const IDLE: Duration = Duration::from_secs(180);

struct Profile { width: u32, fps: u32, rate: u32, crf: u32, threads: u32 }

fn profile_of(name: &str) -> Option<Profile> {
    Some(match name {
        "hd" => Profile { width: 0, fps: 0, rate: 4500, crf: 21, threads: 4 },
        "g2" => Profile { width: 960, fps: 20, rate: 3000, crf: 22, threads: 2 },
        "g4" => Profile { width: 720, fps: 20, rate: 2500, crf: 23, threads: 2 },
        "g6" => Profile { width: 640, fps: 15, rate: 1800, crf: 24, threads: 2 },
        "g8" => Profile { width: 640, fps: 15, rate: 1800, crf: 24, threads: 1 },
        "g10" => Profile { width: 560, fps: 12, rate: 1400, crf: 25, threads: 1 },
        _ => return None,
    })
}

struct Session {
    dir: PathBuf,
    child: tokio::process::Child,
    last: Instant,
    profile: String,
}

pub struct Hls {
    max: usize,
    ffmpeg: PathBuf,
    helper: PathBuf,
    sdk_lib: PathBuf,
    base: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
    pb: Mutex<HashMap<String, crate::netsdk::PbSession>>,
    enabled: bool,
}

impl Hls {
    pub fn new(ffmpeg: PathBuf, helper: PathBuf, sdk_lib: PathBuf, base: PathBuf, _codecs: PathBuf) -> Hls {
        let dir = base.join(format!("p{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // dọn segment cũ trong thư mục của chính tiến trình này
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() { let _ = std::fs::remove_file(e.path()); }
        }
        // dọn thư mục p* của các lần chạy trước (tránh tích rác như 23k thư mục)
        if let Some(parent) = dir.parent() {
            if let Ok(rd) = std::fs::read_dir(parent) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p != dir && p.file_name().map(|n| n.to_string_lossy().starts_with('p')).unwrap_or(false) {
                        let _ = std::fs::remove_dir_all(&p);
                    }
                }
            }
        }
        let enabled = ffmpeg.exists();
        let max = std::env::var("MAX_STREAMS").ok().and_then(|v| v.parse().ok()).unwrap_or(20usize);
        println!("  Giới hạn phiên: {max}");
        Hls { max, ffmpeg, helper, sdk_lib, base: dir, sessions: Mutex::new(HashMap::new()), pb: Mutex::new(HashMap::new()), enabled }
    }

    /// Phát lại bản ghi qua NetSDK (hồ sơ pbNNN).
    async fn playlist_pb(&self, store: &Store, ch: u32, profile: &str, file: &str) -> Option<Vec<u8>> {
        let start: i64 = profile.get(2..)?.parse().ok()?;
        let key = format!("{}-{}-{}", store.id, ch, profile);
        let existing = {
            let m = self.pb.lock().unwrap_or_else(|e| e.into_inner());
            m.get(&key).map(|s| s.dir.clone())
        };
        let dir = match existing {
            Some(d) => {
                if let Ok(mut m) = self.pb.lock() {
                    if let Some(s) = m.get_mut(&key) { s.last = Instant::now(); }
                }
                d
            }
            None => {
                let dir = self.base.join(format!("{}-{}", key, crate::auth::now_ms()));
                let sess = crate::netsdk::start(&self.helper, &self.sdk_lib, &self.ffmpeg, store, ch, start, &dir).await?;
                println!("[netsdk] mở {key}");
                self.pb.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), sess);
                dir
            }
        };
        for _ in 0..300 {
            if let Ok(b) = tokio::fs::read(dir.join(file)).await {
                if !b.is_empty() { return Some(b); }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        None
    }

    pub fn enabled(&self) -> bool { self.enabled }

    pub fn stats(&self) -> Value {
        let m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let by: Vec<String> = m.values().map(|s| s.profile.clone()).collect();
        json!({ "sessions": m.len(), "max": self.max, "idleSec": 180, "byProfile": by, "list": [] })
    }

    /// Trả nội dung file trong phiên (tự mở phiên nếu chưa có, chờ tới khi có segment đầu).
    pub async fn playlist_file(&self, store: &Store, ch: u32, profile: &str, file: &str) -> Option<Vec<u8>> {
        self.sweep();
        if profile.starts_with("pb") { return self.playlist_pb(store, ch, profile, file).await; }
        let key = format!("{}-{}-{}", store.id, ch, profile);
        let dir = self.ensure(store, ch, profile, &key).await?;
        let path = dir.join(file);
        for _ in 0..100 {
            if let Ok(mut f) = tokio::fs::File::open(&path).await {
                let mut buf = Vec::new();
                if f.read_to_end(&mut buf).await.is_ok() && !buf.is_empty() { return Some(buf); }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        None
    }

    async fn ensure(&self, store: &Store, ch: u32, profile: &str, key: &str) -> Option<PathBuf> {
        if !self.enabled { return None; }
        let p = profile_of(profile)?;
        let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = m.get_mut(key) {
            s.last = Instant::now();
            return Some(s.dir.clone());
        }
        // (A) quá trần phiên → đuổi phiên lâu không ai xem nhất
        if m.len() >= self.max {
            if let Some(victim) = m.iter().min_by_key(|(_, s)| s.last).map(|(k, _)| k.clone()) {
                if let Some(mut old) = m.remove(&victim) {
                    let _ = old.child.start_kill();
                    let _ = std::fs::remove_dir_all(&old.dir);
                    println!("[hls] đuổi {victim} (quá {} phiên)", self.max);
                }
            }
        }
        let dir = self.base.join(format!("{}-{}", key, crate::auth::now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        let url = format!("rtsp://{}:{}@{}:{}/cam/realmonitor?channel={}&subtype=0",
            store.user, store.pass, store.host, store.rtsp_port, ch);
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-rtsp_transport".into(), "tcp".into(), "-timeout".into(), "8000000".into(),
            "-flags".into(), "low_delay".into(), "-i".into(), url];
        args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-threads".into(), p.threads.to_string(), "-crf".into(), p.crf.to_string(),
            "-maxrate".into(), format!("{}k", p.rate), "-bufsize".into(), format!("{}k", p.rate * 2),
            "-profile:v".into(), "main".into(), "-bf".into(), "2".into(),
            "-x264-params".into(), "aq-mode=2".into(),
            "-pix_fmt".into(), "yuv420p".into()]);
        if profile == "hd" {
            // luồng xem 1 camera: kèm âm thanh nếu đầu ghi có (AAC, mono)
            args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0?".into(),
                "-c:a".into(), "aac".into(), "-b:a".into(), "64k".into(),
                "-ar".into(), "44100".into(), "-ac".into(), "1".into(),
                // micro đầu ghi thường rất nhỏ (~-34 dB) → nâng +8 dB cho dễ nghe
                "-af".into(), "volume=8dB".into()]);
        } else {
            args.push("-an".into());
        }
        if p.width > 0 {
            args.extend(["-vf".into(), format!("scale={}:-2:flags=lanczos,fps={}", p.width, p.fps)]);
        }
        // (C) lưới dày dùng keyframe 1 giây: ít CPU/bitrate hơn
        let kf = if profile == "g8" || profile == "g10" { "1" } else { "0.5" };
        let gop = if kf == "1" { "12" } else { "10" };
        args.extend(["-g".into(), gop.to_string(),
            "-force_key_frames".into(), format!("expr:gte(t,n_forced*{kf})"),
            "-f".into(), "hls".into(),
            "-hls_time".into(), if profile == "hd" { "0.5".into() } else { "1".into() },
            "-hls_list_size".into(), if profile == "hd" { "8".into() } else { "6".into() },
            "-hls_flags".into(), "delete_segments+omit_endlist+independent_segments+temp_file".into(),
            "-hls_segment_filename".into(), dir.join("seg%03d.ts").to_string_lossy().to_string(),
            dir.join("index.m3u8").to_string_lossy().to_string()]);
        let child = Command::new(&self.ffmpeg).args(&args)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().ok()?;
        println!("[hls] mở {key}");
        m.insert(key.to_string(), Session { dir: dir.clone(), child, last: Instant::now(), profile: profile.to_string() });
        Some(dir)
    }

    /// Làm nóng phiên HD trước khi người dùng bấm (hover ô camera).
    pub async fn warm(&self, store: &Store, ch: u32) {
        let key = format!("{}-{}-hd", store.id, ch);
        let _ = self.ensure(store, ch, "hd", &key).await;
    }

    /// Đóng ngay các phiên lưới của một cơ sở để nhường kết nối cho cửa sổ xem.
    pub fn release(&self, store_id: &str) {
        let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let prefix = format!("{store_id}-");
        let keys: Vec<String> = m.keys()
            .filter(|k| k.starts_with(&prefix) && !k.ends_with("-hd"))
            .cloned().collect();
        for k in keys {
            if let Some(mut s) = m.remove(&k) {
                let _ = s.child.start_kill();
                let _ = std::fs::remove_dir_all(&s.dir);
                println!("[hls] đóng {k} (nhường chỗ cho cửa sổ xem)");
            }
        }
    }

    /// Tắt server: đóng hết ffmpeg (tránh tiến trình mồ côi giữ kết nối đầu ghi).
    pub fn shutdown(&self) {
        if let Ok(mut m) = self.sessions.lock() {
            for (_, mut s) in m.drain() {
                let _ = s.child.start_kill();
                let _ = std::fs::remove_dir_all(&s.dir);
            }
        }
        if let Ok(mut pb) = self.pb.lock() {
            for (_, mut s) in pb.drain() {
                let _ = s.ff.start_kill();
                let _ = s.helper.start_kill();
                let _ = std::fs::remove_dir_all(&s.dir);
            }
        }
        println!("[hls] đã đóng toàn bộ phiên");
    }

    /// Đóng các phiên không ai xem quá 3 phút.
    pub fn sweep(&self) {
        if let Ok(mut pb) = self.pb.lock() {
            let dead: Vec<String> = pb.iter().filter(|(_, s)| s.last.elapsed() > IDLE).map(|(k, _)| k.clone()).collect();
            for k in dead {
                if let Some(mut s) = pb.remove(&k) {
                    let _ = std::fs::remove_dir_all(&s.dir);
                    let _ = s.helper.start_kill();
                    let _ = s.ff.start_kill();
                    println!("[netsdk] đóng {k} (không còn người xem)");
                }
            }
        }
        let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let dead: Vec<String> = m.iter().filter(|(_, s)| s.last.elapsed() > IDLE).map(|(k, _)| k.clone()).collect();
        for k in dead {
            if let Some(mut s) = m.remove(&k) {
                let _ = s.child.start_kill();
                let _ = std::fs::remove_dir_all(&s.dir);
                println!("[hls] đóng {k} (không còn người xem)");
            }
        }
    }
}

/// Thử mở RTSP playback 15 phút trước, trả true nếu đầu ghi đọc được.
pub async fn rtsp_playback_supported(ffmpeg: &std::path::Path, store: &crate::Store) -> bool {
    if !ffmpeg.exists() { return false; }
    let now = crate::auth::now_ms() / 1000;
    let start = now - 900;
    let d = crate::lark::Dt::now();
    let _ = d;
    let fmt = |secs: i64| {
        let dt = crate::lark::Dt::from_secs(secs);
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", dt.y, dt.m, dt.d, dt.hh, dt.mm, dt.ss)
    };
    let url = format!("rtsp://{}:{}@{}:{}/cam/playback?channel=1&subtype=0&starttime={}&endtime={}",
        store.user, store.pass, store.host, store.rtsp_port, fmt(start), fmt(start + 300));
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", "5000000",
        "-i", &url, "-t", "0", "-f", "null", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match tokio::time::timeout(std::time::Duration::from_secs(15), cmd.status()).await {
        Ok(Ok(st)) => st.success(),
        _ => false,
    }
}


impl Hls {
    /// Tạo clip tải về (đường dẫn MP4 trong thư mục tạm của tiến trình).
    pub async fn clip(&self, store: &crate::Store, ch: u32, from: i64, dur: i64) -> Option<std::path::PathBuf> {
        let dir = self.base.join(format!("clip-{}", crate::auth::now_ms()));
        let r = crate::netsdk::clip(&self.helper, &self.sdk_lib, &self.ffmpeg, store, ch, from, dur, &dir).await;
        r
    }
}
