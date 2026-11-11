//! LilyCam — bản Rust. Cổng từ server.js (Node) sang axum + tokio.
//! Hành vi API giữ nguyên; xem PORTING.md để biết phần nào đã port.
mod auth;
mod dahua;
mod hls;
mod lark;
mod netsdk;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Router,
};
use serde_json::{json, Value};
use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc};

use auth::Users;
use hls::Hls;

#[derive(Clone, Debug)]
pub struct Store {
    pub id: String,
    pub name: String,
    pub unit: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub cameras: u32,
    pub plan: Option<String>,
    pub verified: bool,
    pub note: Option<String>,
    pub channels: Option<Vec<u32>>,
    pub allowed_users: Option<Vec<String>>,
}

pub struct App {
    pub root: PathBuf,
    pub data: PathBuf,
    pub public: PathBuf,
    pub ffmpeg: PathBuf,
    pub stores: Vec<Store>,
    pub by_id: HashMap<String, Store>,
    pub users: Users,
    pub secret: Vec<u8>,
    pub hls: Arc<Hls>,
    pub snap: dahua::SnapCache,
    pub zones: lark::Zones,
    pub lark: lark::Lark,
    pub zones_path: PathBuf,
    pub codes: std::sync::Mutex<HashMap<String, Option<String>>>,
    /// Đếm số lần đăng nhập sai theo tài khoản (8 lần / 10 phút, như bản Node).
    pub login_attempts: std::sync::Mutex<HashMap<String, (u32, i64)>>,
    /// Bản ghi đã sửa qua hộp thoại "Sửa thông tin kết nối" (đè lên cameras.json trong RAM).
    pub overrides: std::sync::Mutex<HashMap<String, Store>>,
    /// Kết quả dò sức khỏe camera (nền 10 phút/lần).
    pub cam_health: std::sync::Mutex<Value>,
}

static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn uptime_secs() -> u64 {
    START.get_or_init(std::time::Instant::now).elapsed().as_secs()
}

/// Chờ Ctrl+C hoặc SIGTERM (systemd stop) để dọn phiên trước khi thoát.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

fn read_json(path: &std::path::Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn load_stores(path: &std::path::Path) -> Vec<Store> {
    let v = match read_json(path) { Some(v) => v, None => return Vec::new() };
    v.get("stores").and_then(|s| s.as_array()).map(|arr| {
        arr.iter().filter_map(|s| {
            Some(Store {
                id: s.get("id")?.as_str()?.to_string(),
                name: s.get("name")?.as_str().unwrap_or("").to_string(),
                unit: s.get("unit").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                host: s.get("host").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                port: s.get("port").and_then(|x| x.as_u64()).unwrap_or(80) as u16,
                user: s.get("user").and_then(|x| x.as_str()).unwrap_or("admin").to_string(),
                pass: s.get("pass").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                cameras: s.get("cameras").and_then(|x| x.as_u64()).unwrap_or(1) as u32,
                plan: s.get("plan").and_then(|x| x.as_str()).map(String::from),
                verified: s.get("verified").and_then(|x| x.as_bool()).unwrap_or(false),
                note: s.get("note").and_then(|x| x.as_str()).map(String::from),
                channels: s.get("activeChannels").and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|n| n.as_u64()).map(|n| n as u32).collect()),
                allowed_users: None,
            })
        }).collect()
    }).unwrap_or_default()
}

/// Đặt/đổi mật khẩu quản trị:  lilycam --set-password admin MatKhauMoi
fn set_password(data: &std::path::Path, user: &str, pass: &str) -> std::io::Result<()> {
    let path = data.join("users.json");
    let mut doc: Value = std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "users": [] }));
    let salt = format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
    let params = scrypt::Params::new(14, 8, 1, 64).expect("scrypt params");
    let mut out = [0u8; 64];
    scrypt::scrypt(pass.as_bytes(), salt.as_bytes(), &params, &mut out).expect("scrypt");
    let hash: String = out.iter().map(|b| format!("{b:02x}")).collect();
    let users = doc.get_mut("users").and_then(|u| u.as_array_mut()).expect("users");
    let rec = json!({ "username": user, "salt": salt, "hash": hash, "createdAt": crate::lark::iso_local(crate::lark::Dt::now()) });
    if let Some(existing) = users.iter_mut().find(|u| u.get("username").and_then(|x| x.as_str()) == Some(user)) {
        *existing = rec;
    } else {
        users.push(rec);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default())?;
    println!("Đã đặt mật khẩu cho '{user}' trong {}", path.display());
    Ok(())
}

#[tokio::main]
async fn main() {
    let root = std::env::var("LILYCAM_ROOT").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let data = root.join("data");
    let public = root.join("public");

    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && (args[1] == "--set-password" || args[1] == "--reset-password") {
        let user = if args.len() >= 3 { args[2].clone() } else { "admin".to_string() };
        let pass = if args[1] == "--reset-password" || args.len() < 4 {
            format!("Lily@{:08x}", rand::random::<u32>())
        } else {
            args[3].clone()
        };
        match set_password(&data, &user, &pass) {
            Ok(_) => {
                println!("  user: {user}");
                println!("  pass: {pass}");
            }
            Err(e) => eprintln!("Lỗi: {e}"),
        }
        return;
    }
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8790);
    let host: String = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());

    let stores = load_stores(&data.join("cameras.json"));
    let by_id = stores.iter().map(|s| (s.id.clone(), s.clone())).collect();
    let users = {
        let mut u = Users::load(&data.join("users.json"));
        if u.list.is_empty() {
            // cài mới: tự tạo admin để không bị "không đăng nhập được"
            let pass = format!("Lily@{:08x}", rand::random::<u32>());
            if set_password(&data, "admin", &pass).is_ok() {
                println!("  Chưa có tài khoản — đã tạo 'admin', mật khẩu: {pass}");
                println!("  (đổi: ./lilycam --set-password admin MatKhauMoi)");
            }
            u = Users::load(&data.join("users.json"));
        }
        u
    };
    let secret = std::fs::read(data.join(".session-secret")).unwrap_or_else(|_| {
        let s: Vec<u8> = (0..48).map(|_| rand::random::<u8>()).collect();
        let path = data.join(".session-secret");
        let _ = std::fs::write(&path, &s);
        // chỉ chủ sở hữu đọc được
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        s
    });

    let ffmpeg = std::env::var("FFMPEG").map(PathBuf::from).unwrap_or_else(|_| root.join("bin/ffmpeg"));
    let helper = std::env::var("DAHUA_PB").map(PathBuf::from).unwrap_or_else(|_| root.join("bin/dahua-pb"));
    let sdk_lib = root.join("sdk/lib");
    let hls = Arc::new(Hls::new(ffmpeg.clone(), helper, sdk_lib, data.join("hls"), data.join("codecs.json")));
    let snap = dahua::SnapCache::new();
    let zones_path = data.join("zones.json");
    let zones = lark::Zones::load(&zones_path);
    let lark = lark::Lark::load(&data);

    let app = Arc::new(App { root, data, public, ffmpeg, stores, by_id, users, secret, hls, snap, zones, lark, zones_path, codes: Default::default(), login_attempts: Default::default(), overrides: Default::default(), cam_health: Default::default() });

    spawn_health(app.clone());
    let router = Router::new()
        .route("/api/health", get(api_health))
        .route("/api/login", post(api_login))
        .route("/api/logout", post(api_logout))
        .route("/api/session", get(api_session))
        .route("/api/stores", get(api_stores))
        .route("/api/stats", get(api_stats))
        .route("/api/clip", get(api_clip))
        .route("/api/snap/{store}/{ch}", get(api_snap))
        .route("/api/meta/{store}/{ch}", get(api_meta))
        .route("/api/stream/{store}/{ch}", get(api_stream))
        .route("/api/ptz/{store}/{ch}", post(api_ptz))
        .route("/api/storecfg/{store}", get(api_storecfg))
        .route("/api/stores/{store}", put(api_store_put))
        .route("/api/stores", post(api_store_new))
        .route("/api/cameras/health", get(api_cam_health))
        .route("/api/cameras/health/{store}", get(api_cam_health_one))
        .route("/api/warm/{store}/{ch}", post(api_warm))
        .route("/api/release/{store}", post(api_release))
        .route("/api/probe/{store}", post(api_probe))
        .route("/api/dvr/{store}", get(api_dvr))
        .route("/api/pbcheck/{store}", get(api_pbcheck))
        .route("/api/records/{store}/{ch}", get(api_records))
        .route("/api/zones/{store}/{ch}", get(api_zone_get).post(api_zone_put))
        .route("/api/capture/status", get(api_capture_status))
        .route("/api/capture/options", get(api_capture_options))
        .route("/api/capture", post(api_capture))
        .route("/hls/{profile}/{store}/{ch}/{file}", get(api_hls))
        .fallback(get(static_or_404))
        .with_state(app.clone());

    let addr: SocketAddr = format!("{host}:{port}").parse().expect("địa chỉ không hợp lệ");
    println!("LilyCam (Rust) — http://localhost:{port}");
    println!("  Dữ liệu: {} cơ sở", app.stores.len());
    let listener = tokio::net::TcpListener::bind(addr).await.expect("không mở được cổng");
    let app_sig = app.clone();
    tokio::select! {
        _ = axum::serve(listener, router) => {}
        _ = shutdown_signal() => {
            println!("Đang tắt: đóng các phiên camera…");
            app_sig.hls.shutdown();
        }
    }
}

/* ------------------------------- tiện ích ------------------------------- */

fn json_res(code: StatusCode, v: Value) -> Response {
    (code, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], v.to_string()).into_response()
}

fn err_res(code: StatusCode, msg: &str) -> Response {
    json_res(code, json!({ "error": msg }))
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let p = part.trim();
        if let Some(v) = p.strip_prefix(&format!("{name}=")) {
            return Some(v.to_string());
        }
    }
    None
}

impl App {
    fn user_of(&self, headers: &HeaderMap) -> Option<String> {
        let tok = cookie_value(headers, "lilycam_sid")?;
        auth::verify_session(&tok, &self.secret)
    }
    fn store(&self, id: &str) -> Option<Store> {
        if let Ok(m) = self.overrides.lock() {
            if let Some(s) = m.get(id) { return Some(s.clone()); }
        }
        self.by_id.get(id).cloned()
    }
    fn is_allowed(&self, user: &str, store: &Store) -> bool {
        match &store.allowed_users {
            None => true,
            Some(list) => list.iter().any(|u| u == user),
        }
    }
}

/* -------------------------------- routes -------------------------------- */

async fn api_health(State(app): State<Arc<App>>) -> Response {
    json_res(StatusCode::OK, json!({ "ok": true, "stores": app.stores.len() }))
}

async fn api_login(State(app): State<Arc<App>>, headers: HeaderMap, body: String) -> Response {
    let v: Value = match serde_json::from_str(&body) { Ok(v) => v, Err(_) => return err_res(StatusCode::BAD_REQUEST, "JSON không hợp lệ") };
    let user = v.get("username").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let pass = v.get("password").and_then(|x| x.as_str()).unwrap_or("");
    let key = user.to_lowercase();
    let now = auth::now_ms();
    {
        let mut m = app.login_attempts.lock().unwrap_or_else(|e| e.into_inner());
        let e = m.entry(key.clone()).or_insert((0, now + 600_000));
        if e.1 < now { *e = (0, now + 600_000); }
        if e.0 >= 8 {
            return err_res(StatusCode::TOO_MANY_REQUESTS, "Tài khoản bị tạm khoá 10 phút do sai nhiều lần.");
        }
    }
    if user.is_empty() || !app.users.verify(&user, pass) {
        if let Ok(mut m) = app.login_attempts.lock() {
            if let Some(e) = m.get_mut(&key) { e.0 += 1; }
        }
        return err_res(StatusCode::UNAUTHORIZED, "Sai tên đăng nhập hoặc mật khẩu.");
    }
    if let Ok(mut m) = app.login_attempts.lock() { m.remove(&key); }
    let token = auth::issue_session(&user, &app.secret, 12 * 3600);
    let _ = headers;
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8".to_string()),
            (header::SET_COOKIE, format!("lilycam_sid={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200")),
        ],
        json!({ "user": user }).to_string(),
    ).into_response()
}

async fn api_logout() -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8".to_string()),
            (header::SET_COOKIE, "lilycam_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0".to_string()),
        ],
        "{\"ok\":true}".to_string(),
    ).into_response()
}

async fn api_session(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    match app.user_of(&headers) {
        Some(u) => json_res(StatusCode::OK, json!({ "user": u })),
        None => err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập"),
    }
}

async fn api_stores(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let user = match app.user_of(&headers) { Some(u) => u, None => return err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập") };
    let merged: Vec<Store> = app.stores.iter().filter_map(|s| app.store(&s.id)).collect();
    let list: Vec<Value> = merged.iter().filter(|s| app.is_allowed(&user, s)).map(|s| {
        json!({
            "id": s.id, "name": s.name, "unit": s.unit,
            "cameras": s.channels.as_ref().map(|c| c.len() as u32).unwrap_or(s.cameras),
            "channels": s.channels, "plan": s.plan, "verified": s.verified,
            "note": s.note, "online": Value::Null, "lastCheck": Value::Null, "error": Value::Null,
        })
    }).collect();
    json_res(StatusCode::OK, json!({
        "user": user,
        "updatedAt": Value::Null,
        "source": "data/cameras.json",
        "hd": app.hls.enabled(),
        "netsdk": false,
        "stores": list,
    }))
}

fn rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status").ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).map(|l| l.to_string()))
        .and_then(|l| l.split_whitespace().nth(1).and_then(|n| n.parse::<u64>().ok()))
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

async fn api_stats(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if app.user_of(&headers).is_none() { return err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập"); }
    let up = uptime_secs();
    json_res(StatusCode::OK, json!({
        "uptimeSec": up,
        "nodeRssMB": rss_mb(),
        "stores": app.stores.len(),
        "hls": app.hls.stats(),
        "netsdk": { "enabled": false },
    }))
}

async fn api_snap(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>, Query(q): Query<HashMap<String, String>>) -> Response {
    let user = match app.user_of(&{ HeaderMap::new() }) { Some(u) => u, None => String::new() };
    let _ = user;
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let fast = q.get("fast").map(|v| v == "1").unwrap_or(false);
    if fast {
        match app.snap.last_frame(&store.id, ch) {
            Some(buf) => return jpeg_response(buf),
            None => return (StatusCode::NO_CONTENT, [(header::CACHE_CONTROL, "no-store")], Body::empty()).into_response(),
        }
    }
    match app.snap.get(&store, ch).await {
        Ok(buf) => jpeg_response(buf),
        Err(e) => err_res(StatusCode::BAD_GATEWAY, &e),
    }
}

fn jpeg_response(buf: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/jpeg".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        buf,
    ).into_response()
}

async fn api_meta(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>) -> Response {
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    match app.snap.get(&store, ch).await {
        Ok(buf) => match jpeg::size(&buf) {
            Some((w, h)) => json_res(StatusCode::OK, json!({ "w": w, "h": h })),
            None => json_res(StatusCode::OK, json!({ "w": 4, "h": 3 })),
        },
        Err(_) => json_res(StatusCode::OK, json!({ "w": 4, "h": 3 })),
    }
}

async fn api_stream(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>) -> Response {
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    match app.dahua_mjpeg(&store, ch).await {
        Ok(resp) => {
            let ct = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
                .unwrap_or("multipart/x-mixed-replace; boundary=myboundary").to_string();
            let body = Body::from_stream(resp.bytes_stream());
            (StatusCode::OK, [
                (header::CONTENT_TYPE, ct),
                (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate".to_string()),
                (header::CONNECTION, "close".to_string()),
            ], body).into_response()
        }
        Err(e) => err_res(StatusCode::BAD_GATEWAY, &e),
    }
}

async fn api_hls(State(app): State<Arc<App>>, Path((profile, id, ch, file)): Path<(String, String, u32, String)>) -> Response {
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    if !file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        return err_res(StatusCode::BAD_REQUEST, "Tên tệp không hợp lệ");
    }
    let valid = ["hd", "raw", "g2", "g4", "g6", "g8", "g10"];
    let is_pb = profile.starts_with("pb") && profile[2..].chars().all(|c| c.is_ascii_digit());
    if !valid.contains(&profile.as_str()) && !is_pb {
        return err_res(StatusCode::BAD_REQUEST, "Hồ sơ không hợp lệ");
    }
    match app.hls.playlist_file(&store, ch, &profile, &file).await {
        Some(bytes) => {
            let ct = if file.ends_with(".m3u8") { "application/vnd.apple.mpegurl" } else { "video/mp2t" };
            (StatusCode::OK, [(header::CONTENT_TYPE, ct.to_string()), (header::CACHE_CONTROL, "no-store".to_string())], bytes).into_response()
        }
        None => err_res(StatusCode::NOT_FOUND, "Chưa có"),
    }
}

async fn api_ptz(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>, body: String) -> Response {
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let v: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let code = v.get("code").and_then(|x| x.as_str()).unwrap_or("");
    let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("start");
    let speed = v.get("speed").and_then(|x| x.as_u64()).unwrap_or(4);
    match dahua::ptz(&store, ch, code, action, speed).await {
        Ok(out) => json_res(StatusCode::OK, json!({ "ok": true, "result": out })),
        Err(e) => json_res(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}

/// Cập nhật thông tin kết nối của một cơ sở — ghi cameras.json + RAM.
async fn api_store_put(State(app): State<Arc<App>>, Path(id): Path<String>, body: String) -> Response {
    let mut s = match app.store(&id) { Some(s) => s, None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if let Some(h) = v.get("host").and_then(|x| x.as_str()) { s.host = h.trim().to_string(); }
    if let Some(p) = v.get("port") { if let Some(n) = p.as_u64().or_else(|| p.as_str().and_then(|t| t.parse().ok())) { s.port = n as u16; } }
    if let Some(u) = v.get("user").and_then(|x| x.as_str()) { s.user = u.trim().to_string(); }
    if let Some(pw) = v.get("pass").and_then(|x| x.as_str()) { s.pass = pw.to_string(); }
    if let Some(c) = v.get("cameras") { if let Some(n) = c.as_u64().or_else(|| c.as_str().and_then(|t| t.parse().ok())) { s.cameras = n as u32; } }
    let path = app.data.join("cameras.json");
    if let Some(mut doc) = read_json(&path) {
        if let Some(arr) = doc.get_mut("stores").and_then(|x| x.as_array_mut()) {
            for item in arr.iter_mut() {
                if item.get("id").and_then(|x| x.as_str()) == Some(s.id.as_str()) {
                    item["host"] = json!(s.host);
                    item["port"] = json!(s.port);
                    item["user"] = json!(s.user);
                    item["pass"] = json!(s.pass);
                    item["cameras"] = json!(s.cameras);
                }
            }
        }
        if let Ok(text) = serde_json::to_string_pretty(&doc) { let _ = std::fs::write(&path, text); }
    }
    if let Ok(mut m) = app.overrides.lock() { m.insert(s.id.clone(), s); }
    json_res(StatusCode::OK, json!({ "ok": true }))
}

async fn api_warm(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>) -> Response {
    let s = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    app.hls.warm(&s, ch).await;
    json_res(StatusCode::OK, json!({ "ok": true }))
}

async fn api_release(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if app.store(&id).is_none() { return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này"); }
    app.hls.release(&id);
    json_res(StatusCode::OK, json!({ "ok": true }))
}

async fn api_probe(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let s = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let t0 = std::time::Instant::now();
    match dahua::snapshot(&s, 1).await {
        Ok(_) => json_res(StatusCode::OK, json!({ "ok": true, "ms": t0.elapsed().as_millis() as u64 })),
        Err(e) => json_res(StatusCode::OK, json!({ "ok": false, "ms": t0.elapsed().as_millis() as u64, "error": e })),
    }
}

async fn api_dvr(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let s = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    if s.host.is_empty() { return err_res(StatusCode::NOT_FOUND, "Cơ sở chưa có địa chỉ"); }
    (
        StatusCode::FOUND,
        [(header::LOCATION, format!("http://{}:{}/", s.host, s.port)), (header::CACHE_CONTROL, "no-store".to_string())],
        String::new(),
    ).into_response()
}

async fn api_storecfg(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let s = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    json_res(StatusCode::OK, json!({ "host": s.host, "port": s.port, "user": s.user, "pass": s.pass, "cameras": s.cameras }))
}

/// Kiểm tra nhanh đầu ghi có mở được RTSP playback (/cam/playback) không.
async fn api_pbcheck(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let s = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let supported = hls::rtsp_playback_supported(&app.ffmpeg, &s).await;
    json_res(StatusCode::OK, json!({ "supported": supported, "engine": if supported { "rtsp" } else { "netsdk" } }))
}

/// Danh sách đoạn có bản ghi trong 1 ngày (qua helper NetSDK bin/dahua-pb).
async fn api_records(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>, Query(q): Query<HashMap<String, String>>) -> Response {
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let day = q.get("date").cloned().unwrap_or_default();
    let parts: Vec<i64> = day.split('-').filter_map(|p| p.parse::<i64>().ok()).collect();
    if day.len() != 10 || parts.len() != 3 {
        return err_res(StatusCode::BAD_REQUEST, "Ngày không hợp lệ");
    }
    let start = days_from_civil(parts[0] as i32, parts[1] as u32, parts[2] as u32) * 86400 - 7 * 3600;
    let end = start + 86400;
    let segs = app.list_records(&store, ch, start, end).await;
    json_res(StatusCode::OK, json!({ "segments": segs }))
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

impl App {
    /// Gọi helper NetSDK 2 lần (bản ghi thường + bản ghi sự kiện) rồi gộp khoảng.
    async fn list_records(&self, store: &Store, ch: u32, start: i64, end: i64) -> Vec<Value> {
        let helper = self.root.join("bin/dahua-pb");
        if !helper.exists() { return Vec::new(); }
        let mut all: Vec<(i64, i64)> = Vec::new();
        for ftype in [0, 2] {
            let out = tokio::process::Command::new(&helper)
                .args([store.host.as_str(), &store.port.max(1).to_string(), &store.user, &store.pass,
                    &ch.to_string(), &start.to_string(), &end.to_string(), "5"])
                .env("PB_LIST", "1")
                .env("PB_LIST_TYPE", ftype.to_string())
                .env("LD_LIBRARY_PATH", self.root.join("sdk/lib"))
                .stdin(std::process::Stdio::null())
                .output();
            if let Ok(Ok(o)) = tokio::time::timeout(std::time::Duration::from_secs(25), out).await {
                let txt = String::from_utf8_lossy(&o.stdout);
                if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(txt.trim()) {
                    for v in arr {
                        if let (Some(s), Some(e)) = (v.get("s").and_then(|x| x.as_i64()), v.get("e").and_then(|x| x.as_i64())) {
                            if e > s { all.push((s, e)); }
                        }
                    }
                }
            }
        }
        all.sort_by_key(|(s, _)| *s);
        let mut merged: Vec<(i64, i64)> = Vec::new();
        for (s, e) in all {
            match merged.last_mut() {
                Some(last) if s <= last.1 + 5 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        merged.into_iter().map(|(s, e)| json!({ "s": s, "e": e })).collect()
    }
}

async fn api_zone_get(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>) -> Response {
    json_res(StatusCode::OK, app.zones.get(&id, ch))
}

async fn api_zone_put(State(app): State<Arc<App>>, Path((id, ch)): Path<(String, u32)>, body: String) -> Response {
    let v: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let z = app.zones.put(&app.zones_path, &id, ch, &v);
    json_res(StatusCode::OK, z)
}

async fn api_capture_status(State(app): State<Arc<App>>) -> Response {
    json_res(StatusCode::OK, json!({
        "enabled": app.lark.enabled,
        "week": lark::week_of_month(chrono_like_now()),
        "stores": app.lark.chat_count(),
        "base": app.lark.base_url,
    }))
}

fn chrono_like_now() -> lark::Dt { lark::Dt::now() }

async fn api_capture_options(State(app): State<Arc<App>>) -> Response {
    json_res(StatusCode::OK, app.lark.options().await)
}

async fn api_capture(State(app): State<Arc<App>>, body: String) -> Response {
    json_res(StatusCode::OK, app.lark.capture(&app, &body).await)
}

async fn static_or_404(State(app): State<Arc<App>>, req: axum::extract::Request) -> Response {
    let path = req.uri().path();
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let file = app.public.join(rel);
    let file = match std::fs::canonicalize(&file) {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "404").into_response(),
    };
    if !file.starts_with(&app.public) { return (StatusCode::NOT_FOUND, "404").into_response(); }
    match std::fs::read(&file) {
        Ok(buf) => {
            let mime = match file.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("json") => "application/json; charset=utf-8",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("ico") => "image/x-icon",
                Some("woff2") => "font/woff2",
                _ => "application/octet-stream",
            };
            (StatusCode::OK, [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=300")], buf).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "404").into_response(),
    }
}

mod jpeg {
    pub fn size(buf: &[u8]) -> Option<(u32, u32)> {
        let mut i = 2usize;
        while i + 9 < buf.len() {
            if buf[i] != 0xFF { i += 1; continue; }
            let m = buf[i + 1];
            if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
                let h = ((buf[i + 5] as u32) << 8) | buf[i + 6] as u32;
                let w = ((buf[i + 7] as u32) << 8) | buf[i + 8] as u32;
                return Some((w, h));
            }
            let len = ((buf[i + 2] as usize) << 8) | buf[i + 3] as usize;
            i += 2 + len;
        }
        None
    }
}

impl App {
    async fn dahua_mjpeg(&self, store: &Store, ch: u32) -> Result<reqwest::Response, String> {
        dahua::mjpeg(store, ch).await
    }
}

/// Cắt clip bản ghi thành MP4 1080p và trả về dạng tải xuống.
async fn api_clip(State(app): State<Arc<App>>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if app.user_of(&headers).is_none() {
        return err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập");
    }
    let id = q.get("store").cloned().unwrap_or_default();
    let store = match app.store(&id) { Some(s) => s.clone(), None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let ch: u32 = q.get("ch").and_then(|v| v.parse().ok()).unwrap_or(1);
    let from: i64 = q.get("from").and_then(|v| v.parse().ok()).unwrap_or(0);
    let to: i64 = q.get("to").and_then(|v| v.parse().ok()).unwrap_or(0);
    if from <= 0 || to <= from {
        return err_res(StatusCode::BAD_REQUEST, "Khung giờ không hợp lệ");
    }
    let dur = (to - from).min(1800);
    let path = match app.hls.clip(&store, ch, from, dur).await {
        Some(p) => p,
        None => return err_res(StatusCode::INTERNAL_SERVER_ERROR, "Không cắt được clip (không có bản ghi hoặc đầu ghi bận)"),
    };
    let bytes = match tokio::fs::read(&path).await { Ok(b) => b, Err(_) => Vec::new() };
    if let Some(dir) = path.parent() { let _ = tokio::fs::remove_dir_all(dir).await; }
    if bytes.is_empty() {
        return err_res(StatusCode::INTERNAL_SERVER_ERROR, "File clip rỗng");
    }
    let name = format!("{}-CAM{}-{}.mp4", store.id, ch, from);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "video/mp4".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"")),
        ],
        axum::body::Bytes::from(bytes),
    ).into_response()
}


/// Mở thử 1 kênh RTSP, lấy 1 khung hình → coi như kênh "sống".
async fn probe_rtsp(ffmpeg: &std::path::Path, s: &Store, ch: u32) -> bool {
    let url = format!("rtsp://{}:{}@{}:554/cam/realmonitor?channel={}&subtype=0", s.user, s.pass, s.host, ch);
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", "6000000",
            "-i", &url, "-frames:v", "1", "-f", "null", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match cmd.spawn() {
        Ok(mut c) => match tokio::time::timeout(std::time::Duration::from_secs(9), c.wait()).await {
            Ok(Ok(st)) => st.success(),
            _ => { let _ = c.start_kill(); false }
        },
        Err(_) => false,
    }
}

/// Vòng nền: mỗi 10 phút dò kênh đầu của từng cơ sở để biết online/offline.
fn spawn_health(app: Arc<App>) {
    tokio::spawn(async move {
        loop {
            let mut items = Vec::new();
            for chunk in app.stores.chunks(6) {
                let mut handles = Vec::new();
                for s in chunk {
                    let ff = app.ffmpeg.clone();
                    let st = s.clone();
                    handles.push(tokio::spawn(async move {
                        // thử kênh đầu; nếu chết thử thêm 2 kênh kế (kênh 1 có thể bị tắt)
                        let list: Vec<u32> = st.channels.clone().unwrap_or_else(|| (1..=st.cameras.max(1)).collect());
                        let mut ch = list.first().copied().unwrap_or(1);
                        let mut ok = false;
                        for cand in list.iter().take(3) {
                            if probe_rtsp(&ff, &st, *cand).await { ch = *cand; ok = true; break; }
                        }
                        json!({ "id": st.id, "name": st.name, "ch": ch, "ok": ok,
                            "at": crate::auth::now_ms() })
                    }));
                }
                for h in handles {
                    if let Ok(v) = h.await { items.push(v); }
                }
            }
            if let Ok(mut m) = app.cam_health.lock() {
                *m = json!({ "updatedAt": crate::auth::now_ms(), "stores": items });
            }
            println!("[health] quét xong {} cơ sở", app.stores.len());
            tokio::time::sleep(std::time::Duration::from_secs(900)).await;
        }
    });
}

/// "1,3,5-8" → [1,3,5,6,7,8]
fn parse_channels(spec: &str) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    for part in spec.split(',') {
        let p = part.trim();
        if p.is_empty() { continue; }
        if let Some((a, b)) = p.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
                for n in a..=b.min(a + 63) { out.push(n); }
            }
        } else if let Ok(n) = p.parse::<u32>() { out.push(n); }
    }
    out.sort_unstable();
    out.dedup();
    out.retain(|n| *n > 0 && *n <= 64);
    out
}

fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut dash = false;
    for ch in name.chars() {
        let c = ch.to_lowercase().next().unwrap_or(' ');
        if c.is_ascii_alphanumeric() { s.push(c); dash = false; }
        else if !dash && !s.is_empty() { s.push('-'); dash = true; }
    }
    while s.ends_with('-') { s.pop(); }
    if s.is_empty() { "co-so-moi".into() } else { s }
}

async fn api_cam_health(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if app.user_of(&headers).is_none() {
        return err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập");
    }
    let doc = app.cam_health.lock().map(|m| m.clone()).unwrap_or(Value::Null);
    json_res(StatusCode::OK, doc)
}

/// Quét sâu toàn bộ kênh của 1 cơ sở (bấm nút "Quét kênh").
async fn api_cam_health_one(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if app.user_of(&headers).is_none() {
        return err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập");
    }
    let s = match app.store(&id) { Some(s) => s, None => return err_res(StatusCode::NOT_FOUND, "Không có cơ sở này") };
    let chans = s.channels.clone().unwrap_or_else(|| (1..=s.cameras.max(1)).collect::<Vec<u32>>());
    let mut out = Vec::new();
    for ch in chans {
        let ok = probe_rtsp(&app.ffmpeg, &s, ch).await;
        out.push(json!({ "ch": ch, "ok": ok }));
    }
    json_res(StatusCode::OK, json!({ "id": s.id, "name": s.name, "port": s.port, "channels": out }))
}

/// Thêm đầu ghi mới (dải kênh "1,3,5-8"); chỉ lưu kênh thật sự có hình.
async fn api_store_new(State(app): State<Arc<App>>, headers: HeaderMap, body: String) -> Response {
    if app.user_of(&headers).is_none() {
        return err_res(StatusCode::UNAUTHORIZED, "Chưa đăng nhập");
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let user = v.get("user").and_then(|x| x.as_str()).unwrap_or("admin").trim().to_string();
    let pass = v.get("pass").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let unit = v.get("unit").and_then(|x| x.as_str()).unwrap_or("Cửa hàng").trim().to_string();
    let region = v.get("region").and_then(|x| x.as_str()).unwrap_or("Bắc").trim().to_string();
    let port = v.get("port").and_then(|p| p.as_u64().or_else(|| p.as_str().and_then(|t| t.parse().ok()))).unwrap_or(80) as u16;
    let spec = v.get("channels").and_then(|x| x.as_str()).unwrap_or("1-8");
    if name.len() < 3 { return err_res(StatusCode::BAD_REQUEST, "Tên cơ sở quá ngắn"); }
    if host.is_empty() || pass.is_empty() { return err_res(StatusCode::BAD_REQUEST, "Thiếu host hoặc mật khẩu"); }
    let channels = parse_channels(spec);
    if channels.is_empty() { return err_res(StatusCode::BAD_REQUEST, "Dải kênh không hợp lệ (ví dụ: 1-8 hoặc 1,3,5-8)"); }
    let id = v.get("id").and_then(|x| x.as_str()).map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()).unwrap_or_else(|| slugify(&name));

    let probe_store = Store { id: id.clone(), name: name.clone(), unit: unit.clone(), host: host.clone(),
        port, user: user.clone(), pass: pass.clone(), cameras: channels.len() as u32,
        plan: None, verified: true, note: None, channels: Some(channels.clone()), allowed_users: None };
    let mut live: Vec<u32> = Vec::new();
    for ch in channels.iter() {
        if probe_rtsp(&app.ffmpeg, &probe_store, *ch).await { live.push(*ch); }
    }
    if live.is_empty() {
        return err_res(StatusCode::BAD_REQUEST, "Không kênh nào có tín hiệu — kiểm tra host / tài khoản / mật khẩu");
    }

    let path = app.data.join("cameras.json");
    let mut doc = read_json(&path).unwrap_or_else(|| json!({ "stores": [] }));
    if !doc.get("stores").map(|x| x.is_array()).unwrap_or(false) { doc["stores"] = json!([]); }
    if let Some(arr) = doc.get("stores").and_then(|x| x.as_array()) {
        if arr.iter().any(|it| it.get("id").and_then(|x| x.as_str()) == Some(id.as_str())) {
            return err_res(StatusCode::CONFLICT, "Mã cơ sở này đã tồn tại");
        }
    }
    if let Some(arr) = doc.get_mut("stores").and_then(|x| x.as_array_mut()) {
        arr.push(json!({
            "id": id, "name": name, "unit": unit, "region": region,
            "host": host, "port": port, "user": user, "pass": pass,
            "cameras": live.len(), "activeChannels": live.clone()
        }));
    }
    if let Ok(text) = serde_json::to_string_pretty(&doc) { let _ = std::fs::write(&path, text); }
    println!("[stores] thêm {id} · {name} · {} kênh", live.len());
    // khởi động lại tiến trình để nạp danh sách mới (Docker tự bật lại)
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        std::process::exit(0);
    });
    json_res(StatusCode::OK, json!({ "ok": true, "id": id, "channels": live, "restarting": true }))
}

