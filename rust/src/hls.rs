//! Quản lý phiên HLS: mỗi phiên = 1 ffmpeg đọc RTSP luồng chính và ghi .m3u8/.ts.
use crate::Store;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Không ai xem quá bao lâu thì tắt phiên (giây). Mặc định 90.
fn idle_secs() -> u64 {
    std::env::var("IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(90)
}
fn idle() -> Duration { Duration::from_secs(idle_secs()) }

/// Sau khi ffmpeg của một kênh chết sớm (mất điện, sai mật khẩu, chặn cổng…), không mở
/// lại kênh đó trong bao lâu (giây). Trước đây trình duyệt thử lại 3 lần × mỗi ô, mỗi lần
/// spawn một ffmpeg mới rồi chết ngay → hàng trăm tiến trình/giờ, đốt CPU và GPU vô ích.
fn fail_backoff() -> Duration {
    let s = std::env::var("FAIL_BACKOFF").ok().and_then(|v| v.parse().ok()).unwrap_or(20u64);
    Duration::from_secs(s)
}

/// Phiên bị đuổi/đóng cách đây chưa quá bao lâu thì không mở lại (giây).
const EVICT_COOLDOWN: Duration = Duration::from_secs(10);

/// Lần cuối in cảnh báo "đủ phiên" (mili giây UNIX) — để không spam log mỗi request.
static LAST_FULL_LOG: AtomicU64 = AtomicU64::new(0);

struct Profile { width: u32, fps: u32, rate: u32, crf: u32, threads: u32 }

/// Thiết bị VAAPI để giải mã + mã hoá bằng GPU Intel. `VAAPI=0` để tắt hẳn.
fn vaapi_device() -> Option<PathBuf> {
    let off = std::env::var("VAAPI").map(|v| v == "0" || v.eq_ignore_ascii_case("off")).unwrap_or(false);
    if off { return None; }
    let p = std::env::var("VAAPI_DEV").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/dev/dri/renderD128"));
    if p.exists() { Some(p) } else { None }
}

/// Máy không có GPU/driver phù hợp thì ffmpeg không mở được thiết bị → dùng libx264.
fn vaapi_works(ffmpeg: &std::path::Path, dev: &std::path::Path) -> bool {
    let args: Vec<String> = vec![
        "-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-init_hw_device".into(), format!("vaapi=va:{}", dev.display()),
        "-f".into(), "lavfi".into(), "-i".into(), "nullsrc=s=320x240:d=0.2".into(),
        "-vf".into(), "format=nv12,hwupload".into(),
        "-c:v".into(), "h264_vaapi".into(), "-f".into(), "null".into(), "-".into(),
    ];
    match std::process::Command::new(ffmpeg).args(&args)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

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

/// Mở TCP nhanh (ms) để biết cổng RTSP có vào được từ máy này không.
pub fn tcp_open(host: &str, port: u16, ms: u64) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let addr = match (host, port).to_socket_addrs().ok().and_then(|mut it| it.next()) {
        Some(a) => a,
        None => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(ms)).is_ok()
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
    /// Có GPU Intel dùng được VAAPI thì giải mã + mã hoá bằng GPU, không thì libx264.
    vaapi: Option<PathBuf>,
    /// Cơ sở nào bị chặn cổng RTSP (554) thì đi RTSP-trong-HTTP qua cổng web (80).
    /// Nhớ kết quả theo id để không phải dò lại mỗi lần mở.
    http_mode: Mutex<HashMap<String, bool>>,
    /// Khoá phiên đang chờ segment đầu. Trong lúc chờ, phiên mới mở KHÔNG bị đuổi dù
    /// chưa "được xem" — trước đây bị `or_else` đuổi ngay nên ffmpeg chết rồi mở lại liên tục.
    probing: Mutex<HashMap<String, Instant>>,
    /// Khoá phiên vừa chết sớm → không mở lại trước mốc này (xem `fail_backoff`).
    fail_until: Mutex<HashMap<String, Instant>>,
    /// Khoá phiên vừa bị đuổi/đóng → không mở lại ngay, tránh đuổi–mở–đuổi vòng tròn.
    evict_at: Mutex<HashMap<String, Instant>>,
    /// Kênh nào hỏng luồng chính (subtype=0) thì nhớ đã chuyển sang luồng phụ (subtype=1).
    sub: Mutex<HashMap<String, u8>>,
    /// Kênh có luồng chính "h264, none" (ffmpeg không đọc được thông số trong 5 MB đầu) thì
    /// nhớ để mở lại với probesize/analyzeduration lớn hơn.
    deep: Mutex<HashMap<String, Instant>>,
}

/// Tạo (hoặc dùng lại) thư mục ghi được dưới base; không ghi được thì thử tên khác.
fn writable_dir(base: &std::path::Path, name: &str) -> Option<PathBuf> {
    for attempt in 0..2 {
        let dir = if attempt == 0 {
            base.join(name)
        } else {
            base.join(format!("{name}-{}", crate::auth::now_ms()))
        };
        let _ = std::fs::create_dir_all(&dir);
        let probe = dir.join(".write-test");
        if std::fs::write(&probe, b"x").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return Some(dir);
        }
    }
    println!("  ⚠ Không ghi được thư mục hls trong {} — kiểm tra quyền (chown) thư mục data/hls", base.display());
    None
}

impl Hls {
    pub fn new(ffmpeg: PathBuf, helper: PathBuf, sdk_lib: PathBuf, base: PathBuf, _codecs: PathBuf) -> Hls {
        // Thư mục làm việc phải GHI ĐƯỢC: nếu không, ffmpeg thoát ngay và MỌI camera 404
        // (đã gặp: thư mục còn lại của lần chạy trước do user khác tạo).
        let dir = writable_dir(&base, &format!("p{}", std::process::id()))
            .unwrap_or_else(|| base.join(format!("p{}", std::process::id())));
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
        // GPU: thử một lần lúc khởi động (encode 0,2 s) rồi quyết định dùng cả phiên chạy.
        let vaapi = match vaapi_device() {
            Some(dev) if enabled && vaapi_works(&ffmpeg, &dev) => {
                println!("  Giải mã/mã hoá: VAAPI ({})", dev.display());
                Some(dev)
            }
            Some(_) => {
                println!("  Giải mã/mã hoá: libx264 (VAAPI không khởi tạo được)");
                None
            }
            None => {
                println!("  Giải mã/mã hoá: libx264 (không có GPU hoặc VAAPI=0)");
                None
            }
        };
        Hls { max, ffmpeg, helper, sdk_lib, base: dir, sessions: Mutex::new(HashMap::new()), pb: Mutex::new(HashMap::new()), enabled, vaapi, http_mode: Mutex::new(HashMap::new()),
            probing: Mutex::new(HashMap::new()), fail_until: Mutex::new(HashMap::new()), evict_at: Mutex::new(HashMap::new()),
            sub: Mutex::new(HashMap::new()), deep: Mutex::new(HashMap::new()) }
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
                let sess = crate::netsdk::start(&self.helper, &self.sdk_lib, &self.ffmpeg, store, ch, start, &dir, self.vaapi.as_deref()).await?;
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
        json!({ "sessions": m.len(), "max": self.max, "idleSec": idle_secs(),
                "codec": if self.vaapi.is_some() { "vaapi" } else { "libx264" }, "byProfile": by, "list": [] })
    }

    /// Trả nội dung file trong phiên (tự mở phiên nếu chưa có, chờ tới khi có segment đầu).
    pub async fn playlist_file(&self, store: &Store, ch: u32, profile: &str, file: &str) -> Option<Vec<u8>> {
        self.sweep();
        if profile.starts_with("pb") { return self.playlist_pb(store, ch, profile, file).await; }
        let key = format!("{}-{}-{}", store.id, ch, profile);
        // Ngân sách chờ segment đầu: ~20 s (133 × 150 ms). Trước đây 15 s thì các đầu ghi
        // chậm (vd 308 Võ Văn Ngân cần ~15 s để ra m3u8 đầu) luôn bị 404 oan.
        // Nếu ffmpeg CHẾT SỚM (DESCRIBE bị từ chối, "Invalid data found"…) thì mở lại ngay
        // một lần — nhiều đầu ghi Dahua chỉ từ chối lần mở đầu tiên rồi lần sau vào được.
        const BUDGET: u32 = 133;
        let mut waited = 0u32;
        // 0 = luồng chính, 1 = đọc sâu hơn, 2 = luồng phụ. Mỗi bậc chỉ thử một lần.
        let mut stage: u8 = 0;
        let skey = format!("{}-{}", store.id, ch);
        let mut dir;
        loop {
            self.probing.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), Instant::now());
            let opened = self.ensure(store, ch, profile, &key).await;
            self.probing.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            dir = match opened { Some(d) => d, None => return None };
            let path = dir.join(file);
            let mut dead = false;
            while waited < BUDGET {
                // giữ phiên "còn người xem" trong lúc chờ segment đầu, nếu không sweep/đuổi
                // có thể tắt đúng phiên đang được chờ (=> 404 dù camera sống)
                if waited % 10 == 0 { self.touch(&key); }
                if let Ok(mut f) = tokio::fs::File::open(&path).await {
                    let mut buf = Vec::new();
                    if f.read_to_end(&mut buf).await.is_ok() && !buf.is_empty() { return Some(buf); }
                }
                waited += 1;
                if waited % 4 == 0 && self.session_dead(&key) { dead = true; break; }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            // ffmpeg thoát trước khi ra segment đầu: đi lên từng bậc thay vì bỏ cuộc ngay.
            // KHÔNG đổi luồng khi ffmpeg vẫn sống mà chỉ chậm quá ngân sách — kênh chậm
            // (15–20 s mới ra hình) vẫn phải giữ luồng chính, không bị hạ xuống luồng phụ.
            if dead {
                let cur = self.sub.lock().unwrap_or_else(|e| e.into_inner()).get(&skey).copied().unwrap_or(0);
                if stage == 0 {
                    // Nhiều đầu ghi trả SPS/PPS chậm: ffmpeg báo "Could not find codec parameters
                    // for stream 0 (Video: h264, none): unspecified size" rồi thoát. Lần thử lại
                    // đọc sâu hơn (12 MB / 5 s) — vd 186 Nguyễn Văn Cừ ch1.
                    stage = 1;
                    self.deep.lock().unwrap_or_else(|e| e.into_inner())
                        .insert(skey.clone(), Instant::now() + Duration::from_secs(600));
                    self.kill_session(&key);
                    waited = 0;
                    println!("[hls] thử lại {key} (đọc sâu hơn)");
                    continue;
                }
                if stage == 1 && cur == 0 {
                    // Có kênh chỉ hỏng LUỒNG CHÍNH trong khi luồng phụ vẫn sống — vd 308 Võ Văn
                    // Ngân ch7/ch8, 186 Nguyễn Văn Cừ ch1. Thử luồng phụ trước khi báo "Chưa có".
                    stage = 2;
                    self.sub.lock().unwrap_or_else(|e| e.into_inner()).insert(skey.clone(), 1);
                    self.fail_until.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                    self.kill_session(&key);
                    waited = 0;
                    println!("[hls] {key} hỏng luồng chính → thử luồng phụ (subtype=1)");
                    continue;
                }
                if cur == 1 {
                    // luồng phụ cũng không xong: trả về luồng chính cho lần mở sau
                    self.sub.lock().unwrap_or_else(|e| e.into_inner()).insert(skey.clone(), 0);
                }
                self.kill_session(&key);
                self.fail_until.lock().unwrap_or_else(|e| e.into_inner())
                    .insert(key.clone(), Instant::now() + fail_backoff());
                println!("[hls] tạm khoá {key} trong {}s (không ra được hình)", fail_backoff().as_secs());
            }
            break;
        }
        // không có segment: in lý do ffmpeg ghi trong ff.log để không còn "404 im lặng"
        if let Ok(txt) = tokio::fs::read_to_string(dir.join("ff.log")).await {
            let why: Vec<&str> = txt.lines().filter(|l| !l.trim().is_empty()).rev().take(2).collect();
            if !why.is_empty() {
                println!("[hls] lỗi {key}: {}", why.into_iter().rev().collect::<Vec<_>>().join(" | "));
            }
        }
        None
    }

    /// Đóng và dọn một phiên (dùng khi phải mở lại với tham số khác).
    fn kill_session(&self, key: &str) {
        let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut s) = m.remove(key) {
            let _ = s.child.start_kill();
            let _ = std::fs::remove_dir_all(&s.dir);
        }
    }

    /// ffmpeg của phiên đã thoát (lỗi) chưa? Nếu rồi thì in lý do rồi dọn phiên.
    fn session_dead(&self, key: &str) -> bool {
        let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let dead = match m.get_mut(key) {
            Some(s) => matches!(s.child.try_wait(), Ok(Some(_)) | Err(_)),
            None => true,
        };
        if dead {
            if let Some(mut s) = m.remove(key) {
                let _ = s.child.start_kill();
                if let Ok(txt) = std::fs::read_to_string(s.dir.join("ff.log")) {
                    let why: Vec<&str> = txt.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
                    if !why.is_empty() {
                        println!("[hls] {key} ffmpeg thoát: {}", why.into_iter().rev().collect::<Vec<_>>().join(" | "));
                    }
                }
                let _ = std::fs::remove_dir_all(&s.dir);
            }
        }
        dead
    }

    async fn ensure(&self, store: &Store, ch: u32, profile: &str, key: &str) -> Option<PathBuf> {
        if !self.enabled { return None; }
        let p = profile_of(profile)?;
        let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = m.get_mut(key) {
            s.last = Instant::now();
            return Some(s.dir.clone());
        }
        // Bị đuổi/đóng cách đây chưa lâu thì chưa mở lại: nếu không, mỗi vòng thử lại của
        // trình duyệt lại spawn ffmpeg mới và đuổi một phiên khác → quay vòng không dừng.
        {
            let now = Instant::now();
            let mut ev = self.evict_at.lock().unwrap_or_else(|e| e.into_inner());
            ev.retain(|_, t| now.duration_since(*t) < EVICT_COOLDOWN);
            if ev.contains_key(key) {
                return None;
            }
        }
        // ffmpeg của kênh này vừa chết sớm (mất điện, sai mật khẩu, chặn cổng…): chờ hết
        // backoff rồi mới thử lại, thay vì spawn–chết–spawn hàng trăm lần mỗi giờ.
        {
            let now = Instant::now();
            let mut fu = self.fail_until.lock().unwrap_or_else(|e| e.into_inner());
            fu.retain(|_, t| *t > now);
            if fu.contains_key(key) {
                // không in mỗi request: 6 kênh × thử lại của trình duyệt sẽ ngập log.
                // Dấu vết đã có ở dòng "[hls] tạm khoá … trong Ns" lúc khoá.
                return None;
            }
        }
        // (A) quá trần phiên → đuổi phiên lâu không ai xem nhất.
        // KHÔNG đuổi phiên vừa mở trong 8 s qua: người dùng vừa bấm vào ô đó, ffmpeg
        // còn đang chờ segment đầu — đuổi nó sẽ ra "404 Chưa có" dù camera vẫn sống.
        // Hết chỗ mà mọi phiên đều mới → trả None (ô báo "Chưa có") thay vì đuổi phiên
        // vừa mở rồi mở lại chính nó: đó là nguồn churn lớn nhất trước đây.
        if m.len() >= self.max {
            let now = Instant::now();
            let probing: Vec<String> = {
                let p = self.probing.lock().unwrap_or_else(|e| e.into_inner());
                p.keys().cloned().collect()
            };
            let fresh = Duration::from_secs(8);
            let pick = m.iter()
                .filter(|(k, s)| !probing.contains(k) && now.duration_since(s.last) > fresh)
                .min_by_key(|(_, s)| s.last)
                .map(|(k, _)| k.clone());
            match pick {
                Some(victim) => {
                    if let Some(mut old) = m.remove(&victim) {
                        let _ = old.child.start_kill();
                        let _ = std::fs::remove_dir_all(&old.dir);
                        self.evict_at.lock().unwrap_or_else(|e| e.into_inner())
                            .insert(victim.clone(), Instant::now());
                        println!("[hls] đuổi {victim} (quá {} phiên)", self.max);
                    }
                }
                None => {
                    // không có phiên nào đủ cũ để đuổi: báo rõ (tối đa 30 s một lần),
                    // không đuổi bừa rồi mở lại chính khoá đó.
                    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64).unwrap_or(0);
                    if now_ms.saturating_sub(LAST_FULL_LOG.load(Ordering::Relaxed)) > 30_000 {
                        LAST_FULL_LOG.store(now_ms, Ordering::Relaxed);
                        println!("[hls] đủ {} phiên, không mở thêm {key}", self.max);
                    }
                    return None;
                }
            }
        }
        let dir = self.base.join(format!("{}-{}", key, crate::auth::now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        // Nhiều đầu ghi bị nhà mạng chặn cổng 554 nhưng vẫn mở cổng web 80 và hỗ trợ
        // RTSP-trong-HTTP (Dahua gọi là "RTSP over HTTP"). Khi 554 không vào được thì
        // đâm thẳng vào cổng web, ffmpeg tự dò GET/POST /cam/realmonitor.
        let http_mode = {
            let mut hm = self.http_mode.lock().unwrap_or_else(|e| e.into_inner());
            match hm.get(&store.id) {
                Some(v) => *v,
                None => {
                    let v = !tcp_open(&store.host, store.rtsp_port, 2500);
                    hm.insert(store.id.clone(), v);
                    if v { println!("[hls] {} chặn cổng {} → dùng RTSP-qua-HTTP (cổng {})", store.id, store.rtsp_port, store.port); }
                    v
                }
            }
        };
        // RTSP-qua-HTTP đi qua đúng cổng web của đầu ghi, không phải cổng RTSP.
        let port = if http_mode { store.port } else { store.rtsp_port };
        // Kênh hỏng luồng chính (xem playlist_file) thì nhớ dùng luồng phụ.
        let subtype = self.sub.lock().unwrap_or_else(|e| e.into_inner())
            .get(&format!("{}-{}", store.id, ch)).copied().unwrap_or(0);
        let url = format!("rtsp://{}:{}@{}:{}/cam/realmonitor?channel={}&subtype={}",
            store.user, store.pass, store.host, port, ch, subtype);
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
        if http_mode {
            args.extend(["-rtsp_transport".into(), "http".into()]);
        }
        if let Some(dev) = &self.vaapi {
            // giải mã ngay trên GPU: khung hình không phải copy về RAM rồi encode lại
            args.extend(["-hwaccel".into(), "vaapi".into(),
                "-hwaccel_device".into(), dev.display().to_string(),
                "-hwaccel_output_format".into(), "vaapi".into()]);
        }
        if !http_mode {
            args.extend(["-rtsp_transport".into(), "tcp".into()]);
        }
        args.extend(["-timeout".into(), "8000000".into(),
            "-flags".into(), "low_delay".into()]);
        // Kênh từng báo "unspecified size": đọc sâu hơn để lấy được SPS/PPS.
        let deep = self.deep.lock().unwrap_or_else(|e| e.into_inner())
            .get(&format!("{}-{}", store.id, ch))
            .map(|t| *t > Instant::now()).unwrap_or(false);
        if deep {
            args.extend(["-analyzeduration".into(), "5000000".into(),
                "-probesize".into(), "12000000".into()]);
        }
        args.extend(["-i".into(), url]);
        if self.vaapi.is_some() {
            args.extend(["-c:v".into(), "h264_vaapi".into(),
                "-b:v".into(), format!("{}k", p.rate), "-maxrate".into(), format!("{}k", p.rate),
                "-bufsize".into(), format!("{}k", p.rate * 2),
                "-profile:v".into(), "main".into()]);
        } else {
            args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
                "-threads".into(), p.threads.to_string(), "-crf".into(), p.crf.to_string(),
                "-maxrate".into(), format!("{}k", p.rate), "-bufsize".into(), format!("{}k", p.rate * 2),
                "-profile:v".into(), "main".into(), "-bf".into(), "2".into(),
                "-x264-params".into(), "aq-mode=2".into(),
                "-pix_fmt".into(), "yuv420p".into()]);
        }
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
        if self.vaapi.is_some() {
            // scale_vaapi giữ khung hình trong VRAM; hd giữ nguyên độ phân giải gốc
            if p.width > 0 && p.fps > 0 {
                args.extend(["-vf".into(), format!("fps={},scale_vaapi=w={}:h=-2", p.fps, p.width)]);
            }
        } else if p.width > 0 {
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
        // ghi stderr của ffmpeg ra ff.log trong thư mục phiên: lỗi RTSP trước đây bị nuốt
        // hoàn toàn, chỉ thấy "404 Chưa có" sau 15 s mà không biết vì sao
        let log = std::fs::File::create(dir.join("ff.log")).ok();
        let child = Command::new(&self.ffmpeg).args(&args)
            .stdin(Stdio::null()).stdout(Stdio::null())
            .stderr(match log { Some(f) => Stdio::from(f), None => Stdio::null() })
            .spawn().ok()?;
        println!("[hls] mở {key}");
        m.insert(key.to_string(), Session { dir: dir.clone(), child, last: Instant::now(), profile: profile.to_string() });
        Some(dir)
    }

    /// Đánh dấu phiên vẫn có người chờ (dùng khi đang chờ segment đầu).
    fn touch(&self, key: &str) {
        if let Ok(mut m) = self.sessions.lock() {
            if let Some(s) = m.get_mut(key) { s.last = Instant::now(); }
        }
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

    /// Giữ tối đa `keep` phiên, đóng phiên lâu không xem nhất (dùng khi CPU quá nhiệt).
    pub fn trim_to(&self, keep: usize) {
        let mut killed = 0usize;
        {
            let mut m = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            while m.len() > keep {
                let victim = m.iter().max_by_key(|(_, s)| s.last.elapsed()).map(|(k, _)| k.clone());
                match victim.and_then(|k| m.remove(&k)) {
                    Some(mut old) => {
                        let _ = old.child.start_kill();
                        let _ = std::fs::remove_dir_all(&old.dir);
                        killed += 1;
                    }
                    None => break,
                }
            }
        }
        {
            let mut pb = self.pb.lock().unwrap_or_else(|e| e.into_inner());
            while pb.len() > 1 {
                let victim = pb.iter().max_by_key(|(_, s)| s.last.elapsed()).map(|(k, _)| k.clone());
                match victim.and_then(|k| pb.remove(&k)) {
                    Some(mut old) => {
                        let _ = old.helper.start_kill();
                        let _ = old.ff.start_kill();
                        let _ = std::fs::remove_dir_all(&old.dir);
                        killed += 1;
                    }
                    None => break,
                }
            }
        }
        if killed > 0 { println!("[hls] giảm tải: đóng {killed} phiên (còn {keep})"); }
    }

    /// Số phiên đang chạy.
    pub fn count(&self) -> usize {
        self.sessions.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// Đóng các phiên không ai xem quá thời gian chờ.
    pub fn sweep(&self) {
        if let Ok(mut pb) = self.pb.lock() {
            let dead: Vec<String> = pb.iter().filter(|(_, s)| s.last.elapsed() > idle()).map(|(k, _)| k.clone()).collect();
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
        let dead: Vec<String> = m.iter().filter(|(_, s)| s.last.elapsed() > idle()).map(|(k, _)| k.clone()).collect();
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
        crate::netsdk::clip(&self.helper, &self.sdk_lib, &self.ffmpeg, store, ch, from, dur, &dir, self.vaapi.as_deref()).await
    }
}
