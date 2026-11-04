//! Người dùng (scrypt) + phiên HMAC-SHA256 — giữ đúng định dạng cookie của bản Node.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::path::Path;

pub struct UserRec { pub username: String, pub salt: String, pub hash: String }

pub struct Users { pub list: Vec<UserRec> }

impl Users {
    pub fn load(path: &Path) -> Users {
        let v: Value = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let list = v.get("users").and_then(|u| u.as_array()).map(|arr| arr.iter().filter_map(|u| {
            Some(UserRec {
                username: u.get("username")?.as_str()?.to_string(),
                salt: u.get("salt")?.as_str()?.to_string(),
                hash: u.get("hash")?.as_str()?.to_string(),
            })
        }).collect()).unwrap_or_default();
        Users { list }
    }

    pub fn verify(&self, user: &str, pass: &str) -> bool {
        self.list.iter().find(|u| u.username == user).map(|u| {
            let params = match scrypt::Params::new(14, 8, 1, 64) { Ok(p) => p, Err(_) => return false };
            let mut out = [0u8; 64];
            if scrypt::scrypt(pass.as_bytes(), u.salt.as_bytes(), &params, &mut out).is_err() { return false; }
            let known = hex_decode(&u.hash);
            known.len() == out.len() && constant_time_eq(&known, &out)
        }).unwrap_or(false)
    }
}

fn hex_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut i = 0;
    while i + 1 < b.len() {
        let hi = (b[i] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = (b[i + 1] as char).to_digit(16).unwrap_or(0) as u8;
        out.push((hi << 4) | lo);
        i += 2;
    }
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) { diff |= x ^ y; }
    diff == 0
}

pub fn issue_session(user: &str, secret: &[u8], ttl_secs: u64) -> String {
    let exp = now_ms() + ttl_secs as i64 * 1000;
    let payload = format!("{{\"u\":{},\"exp\":{}}}", serde_json::to_string(user).unwrap_or_else(|_| "\"\"".into()), exp);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("hmac key");
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes();
    format!("{}.{}", URL_SAFE_NO_PAD.encode(payload.as_bytes()), URL_SAFE_NO_PAD.encode(sig))
}

pub fn verify_session(token: &str, secret: &[u8]) -> Option<String> {
    let (p, s) = token.split_once('.')?;
    let payload = URL_SAFE_NO_PAD.decode(p).ok()?;
    let sig = URL_SAFE_NO_PAD.decode(s).ok()?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).ok()?;
    mac.update(p.as_bytes()); // Node ký trên chuỗi base64url, không phải JSON gốc
    let expect = mac.finalize().into_bytes();
    if !constant_time_eq(&sig, &expect) { return None; }
    let v: Value = serde_json::from_slice(&payload).ok()?;
    let exp = v.get("exp")?.as_i64()?;
    if exp < now_ms() { return None; }
    Some(v.get("u")?.as_str()?.to_string())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
