//! Client Dahua: HTTP Digest, snapshot, MJPEG, PTZ.
use crate::Store;
use sha2::Digest;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(9)).build().expect("http client")
}

fn md5_hex(data: &[u8]) -> String {
    // Dahua dùng MD5 cho digest; cài đặt gọn tại chỗ (RFC 1321).
    const S: [u32; 64] = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K: [u32; 64] = [
        0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
        0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
        0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
        0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
        0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
        0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
        0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
        0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
    ];
    let mut h: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([chunk[i*4], chunk[i*4+1], chunk[i*4+2], chunk[i*4+3]]);
        }
        let (mut a, mut b, mut c, mut d) = (h[0], h[1], h[2], h[3]);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let sum = a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(S[i]));
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
    }
    h.iter().map(|x| format!("{:02x}{:02x}{:02x}{:02x}", x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff)).collect()
}

fn parse_challenge(h: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let body = h.trim_start_matches("Digest ").trim();
    let mut key = String::new();
    let mut val = String::new();
    let mut in_quotes = false;
    let mut reading_key = true;
    for c in body.chars() {
        match c {
            '"' => { in_quotes = !in_quotes; }
            '=' if !in_quotes && reading_key => { reading_key = false; }
            ',' if !in_quotes => {
                if !key.trim().is_empty() { out.insert(key.trim().to_lowercase(), val.trim().trim_matches('"').to_string()); }
                key.clear(); val.clear(); reading_key = true;
            }
            _ => { if reading_key { key.push(c) } else { val.push(c) } }
        }
    }
    if !key.trim().is_empty() { out.insert(key.trim().to_lowercase(), val.trim().trim_matches('"').to_string()); }
    out
}

fn build_auth(ch: &HashMap<String, String>, user: &str, pass: &str, method: &str, uri: &str) -> String {
    let realm = ch.get("realm").cloned().unwrap_or_default();
    let nonce = ch.get("nonce").cloned().unwrap_or_default();
    let qop = if ch.get("qop").map(|q| q.contains("auth")).unwrap_or(false) { Some("auth") } else { None };
    let nc = "00000001";
    let cnonce = format!("{:016x}", rand::random::<u64>());
    let ha1 = md5_hex(format!("{user}:{realm}:{pass}").as_bytes());
    let ha2 = md5_hex(format!("{method}:{uri}").as_bytes());
    let response = match qop {
        Some(q) => md5_hex(format!("{ha1}:{nonce}:{nc}:{cnonce}:{q}:{ha2}").as_bytes()),
        None => md5_hex(format!("{ha1}:{nonce}:{ha2}").as_bytes()),
    };
    let mut out = format!("Digest username=\"{user}\", realm=\"{realm}\", nonce=\"{nonce}\", uri=\"{uri}\", response=\"{response}\", algorithm=MD5");
    if let Some(q) = qop { out.push_str(&format!(", qop={q}, nc={nc}, cnonce=\"{cnonce}\"")); }
    if let Some(op) = ch.get("opaque") { if !op.is_empty() { out.push_str(&format!(", opaque=\"{op}\"")); } }
    out
}

async fn open(store: &Store, path: &str, method: &str) -> Result<reqwest::Response, String> {
    let url = format!("http://{}:{}{}", store.host, store.port, path);
    let c = client();
    let m = if method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET };
    let first = c.request(m.clone(), &url).send().await.map_err(|e| e.to_string())?;
    if first.status() == reqwest::StatusCode::UNAUTHORIZED {
        let chal = first.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if chal.is_empty() { return Err("Thiết bị từ chối (401)".into()); }
        let hdr = build_auth(&parse_challenge(&chal), &store.user, &store.pass, method, path);
        let second = c.request(m, &url).header(reqwest::header::AUTHORIZATION, hdr).send().await.map_err(|e| e.to_string())?;
        if second.status() == reqwest::StatusCode::UNAUTHORIZED { return Err("Sai tài khoản / mật khẩu camera".into()); }
        if !second.status().is_success() { return Err(format!("Thiết bị trả về HTTP {}", second.status())); }
        return Ok(second);
    }
    if !first.status().is_success() { return Err(format!("Thiết bị trả về HTTP {}", first.status())); }
    Ok(first)
}

pub async fn snapshot(store: &Store, ch: u32) -> Result<Vec<u8>, String> {
    let res = open(store, &format!("/cgi-bin/snapshot.cgi?channel={ch}"), "GET").await?;
    let body = res.bytes().await.map_err(|e| e.to_string())?;
    if body.is_empty() { return Err("Ảnh rỗng".into()); }
    Ok(body.to_vec())
}

pub async fn mjpeg(store: &Store, ch: u32) -> Result<reqwest::Response, String> {
    open(store, &format!("/cgi-bin/mjpg/video.cgi?channel={ch}&subtype=1"), "GET").await
}

pub async fn ptz(store: &Store, ch: u32, code: &str, action: &str, speed: u64) -> Result<String, String> {
    const CODES: [&str; 14] = ["Up","Down","Left","Right","LeftUp","RightUp","LeftDown","RightDown","ZoomTile","ZoomWide","FocusNear","FocusFar","IrisSmall","IrisLarge"];
    if !CODES.contains(&code) { return Err("Mã điều khiển không hợp lệ".into()); }
    if !(1..=64).contains(&ch) { return Err("Kênh không hợp lệ".into()); }
    let sp = speed.clamp(1, 8);
    let path = format!("/cgi-bin/ptz.cgi?action={}&channel={ch}&code={code}&arg1=0&arg2={sp}&arg3=0",
        if action == "stop" { "stop" } else { "start" });
    let res = open(store, &path, "GET").await?;
    let body = res.text().await.map_err(|e| e.to_string())?;
    if body.to_lowercase().contains("error") { return Err(format!("Đầu ghi báo lỗi PTZ: {}", &body[..body.len().min(100)])); }
    Ok(if body.trim().is_empty() { "OK".to_string() } else { body.trim().to_string() })
}

pub struct SnapCache {
    map: Mutex<HashMap<String, (Instant, Vec<u8>)>>,
    last: Mutex<HashMap<String, (Instant, Vec<u8>)>>,
    /// Giống bản Node: tối đa 24 lượt chụp song song để không bóp nghẹt đầu ghi.
    slots: tokio::sync::Semaphore,
}

impl SnapCache {
    pub fn new() -> SnapCache {
        SnapCache {
            map: Mutex::new(HashMap::new()),
            last: Mutex::new(HashMap::new()),
            slots: tokio::sync::Semaphore::new(24),
        }
    }

    pub fn last_frame(&self, store: &str, ch: u32) -> Option<Vec<u8>> {
        self.last.lock().ok()?.get(&format!("{store}:{ch}")).map(|(_, b)| b.clone())
    }

    pub fn put_last(&self, store: &str, ch: u32, buf: Vec<u8>) {
        if let Ok(mut m) = self.last.lock() { m.insert(format!("{store}:{ch}"), (Instant::now(), buf)); }
    }

    pub async fn get(&self, store: &Store, ch: u32) -> Result<Vec<u8>, String> {
        let key = format!("{}:{}", store.id, ch);
        if let Ok(m) = self.map.lock() {
            if let Some((t, b)) = m.get(&key) { if t.elapsed() < Duration::from_secs(4) { return Ok(b.clone()); } }
        }
        let _permit = self.slots.acquire().await.map_err(|e| e.to_string())?;
        let buf = snapshot(store, ch).await?;
        if let Ok(mut m) = self.map.lock() { m.insert(key, (Instant::now(), buf.clone())); }
        self.put_last(&store.id, ch, buf.clone());
        Ok(buf)
    }
}
