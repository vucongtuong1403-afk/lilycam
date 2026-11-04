//! Giám sát tháng (Lark Base) + vùng cảnh báo.
use crate::App;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Zones { path: PathBuf, map: Mutex<HashMap<String, Value>> }

impl Zones {
    pub fn load(path: &Path) -> Zones {
        let map = std::fs::read_to_string(path).ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, Value>>(&s).ok())
            .unwrap_or_default();
        Zones { path: path.to_path_buf(), map: Mutex::new(map) }
    }
    pub fn get(&self, store: &str, ch: u32) -> Value {
        self.map.lock().unwrap().get(&format!("{store}:{ch}")).cloned().unwrap_or(Value::Null)
    }
    pub fn put(&self, _path: &Path, store: &str, ch: u32, v: &Value) -> Value {
        let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(16).clamp(1, 64);
        let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(9).clamp(1, 64);
        let max = cols * rows;
        let mut cells: Vec<u64> = v.get("cells").and_then(|x| x.as_array()).map(|a| {
            a.iter().filter_map(|n| n.as_u64()).filter(|n| *n < max).collect()
        }).unwrap_or_default();
        cells.sort_unstable();
        cells.dedup();
        let zone = json!({ "cols": cols, "rows": rows, "cells": cells, "updatedAt": iso_local(Dt::now()) });
        self.map.lock().unwrap().insert(format!("{store}:{ch}"), zone.clone());
        if let Ok(s) = serde_json::to_string_pretty(&*self.map.lock().unwrap()) {
            let _ = std::fs::write(&self.path, s);
        }
        zone
    }
}

#[derive(Clone, Copy)]
pub struct Dt { pub y: i32, pub m: u32, pub d: u32, pub hh: u32, pub mm: u32, pub ss: u32 }

impl Dt {
    pub fn from_secs(secs: i64) -> Dt {
        let secs = (secs + 7 * 3600) as u64;
        let days = secs / 86400;
        let rem = secs % 86400;
        let (y, m, d) = civil_from_days(days as i64);
        Dt { y, m, d, hh: (rem / 3600) as u32, mm: ((rem % 3600) / 60) as u32, ss: (rem % 60) as u32 }
    }

    pub fn now() -> Dt {
        let secs = (crate::auth::now_ms() / 1000 + 7 * 3600) as u64; // Asia/Saigon, không cần DST
        let days = secs / 86400;
        let rem = secs % 86400;
        let (y, m, d) = civil_from_days(days as i64);
        Dt { y, m, d, hh: (rem / 3600) as u32, mm: ((rem % 3600) / 60) as u32, ss: (rem % 60) as u32 }
    }
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((y + if m <= 2 { 1 } else { 0 }) as i32, m, d)
}

pub fn iso_local(d: Dt) -> String {
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", d.y, d.m, d.d, d.hh, d.mm, d.ss)
}

pub fn week_of_month(d: Dt) -> u32 {
    let days = days_from_civil(d.y, d.m, d.d);
    let weekday = ((days + 4).rem_euclid(7)) as i64; // 0 = Thứ Hai
    let monday = days - weekday;
    let thu = civil_from_days(monday + 3);
    ((thu.2 - 1) / 7) + 1
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

pub struct Lark {
    pub enabled: bool,
    cli: PathBuf,
    base_token: String,
    table_id: String,
    pub base_url: Option<String>,
    photo_field: String,
    view_for: HashMap<String, String>,
    fallback_view: Option<String>,
    chat: HashMap<String, String>,
    options: Mutex<Option<(Instant, Value)>>,
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || *c == ' ').collect::<String>()
        .to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn loose(s: &str) -> String {
    norm(s).replace(['(', ')'], " ").chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

impl Lark {
    pub fn load(data: &Path) -> Lark {
        let cfg: Value = std::fs::read_to_string(data.join("lark.json")).ok()
            .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let cli = cfg.get("cli").and_then(|x| x.as_str()).map(PathBuf::from).unwrap_or_default();
        let views: Value = std::fs::read_to_string(data.join("lark-views.json")).ok()
            .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let mut view_for = HashMap::new();
        if let Some(map) = views.get("views").and_then(|v| v.as_object()) {
            for (k, v) in map { if let Some(s) = v.as_str() { view_for.insert(k.clone(), s.to_string()); } }
        }
        let fallback_view = views.get("fallback").and_then(|v| v.as_str()).map(String::from);
        let mut chat = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(data.join("dm.ndjson")) {
            for line in raw.lines() {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    let name = v.get("Tên cơ sở").and_then(|x| x.as_str()).unwrap_or("");
                    if let (c, Some(id)) = (norm(name), v.get("chat_id").and_then(|x| x.as_str())) {
                        if !c.is_empty() { chat.insert(c, id.to_string()); }
                    }
                }
            }
        }
        Lark {
            enabled: !cli.as_os_str().is_empty() && cli.exists(),
            cli,
            base_token: cfg.get("base_token").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            table_id: cfg.get("table_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            base_url: cfg.get("base_url").and_then(|x| x.as_str()).map(String::from),
            photo_field: cfg.get("photo_field").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            view_for, fallback_view, chat,
            options: Mutex::new(None),
        }
    }

    pub fn chat_count(&self) -> usize { self.chat.len() }

    pub fn chat_of(&self, name: &str) -> Option<String> {
        self.chat.get(&norm(name)).cloned().or_else(|| self.chat.get(&loose(name)).cloned())
    }

    pub fn view_of(&self, store: &str) -> Option<String> {
        self.view_for.get(store).cloned().or_else(|| self.fallback_view.clone())
    }

    async fn run(&self, args: Vec<String>, timeout: Duration) -> Result<Value, String> {
        let mut cmd = tokio::process::Command::new(&self.cli);
        cmd.args(&args).env("XDG_RUNTIME_DIR", "/run/user/1000")
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let fut = cmd.output();
        let out = tokio::time::timeout(timeout, fut).await.map_err(|_| "lark-cli quá thời gian chờ".to_string())?
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        for text in [stdout, stderr] {
            let t = text.trim();
            if t.starts_with('{') {
                if let Ok(v) = serde_json::from_str::<Value>(t) { return Ok(v); }
            }
        }
        Err("lark-cli không trả JSON".to_string())
    }

    pub async fn options(&self) -> Value {
        if let Ok(m) = self.options.lock() {
            if let Some((t, v)) = &*m { if t.elapsed() < Duration::from_secs(3600) { return v.clone(); } }
        }
        let v = self.run(vec!["base".into(), "+field-list".into(), "--base-token".into(), self.base_token.clone(),
            "--table-id".into(), self.table_id.clone(), "--format".into(), "json".into()], Duration::from_secs(60)).await;
        let mut cats = Vec::new();
        let mut items = Vec::new();
        if let Ok(v) = &v {
            if let Some(fields) = v.get("data").and_then(|d| d.get("fields")).and_then(|f| f.as_array()) {
                for f in fields {
                    let name = f.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    let opts: Vec<String> = f.get("options").and_then(|o| o.as_array())
                        .map(|a| a.iter().filter_map(|o| o.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
                        .unwrap_or_default();
                    if name == "DANH MỤC SỰ CỐ" { cats = opts.clone(); }
                    if name == "HẠNG MỤC 5S" { items = opts; }
                }
            }
        }
        let out = json!({ "categories": cats, "items": items });
        if let Ok(mut m) = self.options.lock() { *m = Some((Instant::now(), out.clone())); }
        out
    }

    pub async fn capture(&self, app: &App, body: &str) -> Value {
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let store_id = v.get("store").and_then(|x| x.as_str()).unwrap_or("");
        let ch = v.get("ch").and_then(|x| x.as_u64()).unwrap_or(0);
        let img = v.get("image").and_then(|x| x.as_str()).unwrap_or("");
        let store = match app.store(store_id) { Some(s) => s.clone(), None => return json!({ "error": "Không có cơ sở này" }) };
        if !(1..=64).contains(&ch) { return json!({ "ok": false, "error": "Kênh không hợp lệ" }); }
        let b64 = img.split_once("base64,").map(|(_, b)| b).unwrap_or("");
        let buf = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).unwrap_or_default();
        if buf.len() < 1024 { return json!({ "ok": false, "error": "Ảnh không hợp lệ (chỉ nhận JPEG)" }); }
        let now = Dt::now();
        let day = format!("{:04}-{:02}-{:02}", now.y, now.m, now.d);
        let dir = app.data.join("captures").join(&day);
        let _ = std::fs::create_dir_all(&dir);
        let name = format!("{}-cam{}-{:02}{:02}{:02}.jpg", store.id.replace(|c: char| !c.is_alphanumeric() && c != '-', "_"), ch, now.hh, now.mm, now.ss);
        let file = dir.join(&name);
        if std::fs::write(&file, &buf).is_err() { return json!({ "ok": false, "error": "Không lưu được ảnh" }); }

        let week = week_of_month(now);
        let mut fields = serde_json::Map::new();
        fields.insert("TUẦN".into(), json!([format!("Tuần {week}")]));
        fields.insert("THỜI GIAN GHI NHẬN".into(), json!(iso_local(now)));
        if let Some(chat) = self.chat_of(&store.name) { fields.insert("CƠ SỞ".into(), json!([{ "id": chat }])); }
        if let Some(d) = v.get("desc").and_then(|x| x.as_str()) { if !d.is_empty() { fields.insert("MÔ TẢ SỰ CỐ".into(), json!(d)); } }
        if let Some(c) = v.get("category").and_then(|x| x.as_str()) { if !c.is_empty() { fields.insert("DANH MỤC SỰ CỐ".into(), json!([c])); } }
        if let Some(i) = v.get("item").and_then(|x| x.as_str()) { if !i.is_empty() { fields.insert("HẠNG MỤC 5S".into(), json!([i])); } }
        fields.insert("Đã gửi sự cố".into(), json!(true));

        let payload = json!({ "create_records": [fields] }).to_string();
        let tmp = std::env::temp_dir().join(format!("lilycam-lark-{}.json", std::process::id()));
        let _ = std::fs::write(&tmp, payload);
        let res = self.run(vec!["base".into(), "+record-batch-create".into(), "--base-token".into(), self.base_token.clone(),
            "--table-id".into(), self.table_id.clone(), "--json".into(), format!("@{}", tmp.display()), "--as".into(), "user".into()],
            Duration::from_secs(90)).await;
        let _ = std::fs::remove_file(&tmp);
        let record_id = res.as_ref().ok()
            .and_then(|v| v.get("data")).and_then(|d| d.get("record_id_list")).and_then(|l| l.as_array())
            .and_then(|l| l.first()).and_then(|x| x.as_str()).map(String::from);
        let record_id = match record_id {
            Some(r) => r,
            None => return json!({ "ok": true, "saved": format!("{day}/{name}"), "week": week, "recordId": null,
                "url": self.base_url.clone().map(|b| format!("{b}?table={}", self.table_id)), "warning": "Chưa gửi được lên Lark" }),
        };
        let _ = self.run(vec!["base".into(), "+record-upload-attachment".into(), "--base-token".into(), self.base_token.clone(),
            "--table-id".into(), self.table_id.clone(), "--record-id".into(), record_id.clone(),
            "--field-id".into(), self.photo_field.clone(), "--file".into(), file.to_string_lossy().to_string(),
            "--as".into(), "user".into()], Duration::from_secs(120)).await;
        let url = self.base_url.as_ref().map(|b| match self.view_of(&store.id) {
            Some(v) => format!("{b}?table={}&view={v}", self.table_id),
            None => format!("{b}?table={}", self.table_id),
        });
        json!({ "ok": true, "saved": format!("{day}/{name}"), "week": week, "recordId": record_id, "url": url, "warning": Value::Null })
    }
}
