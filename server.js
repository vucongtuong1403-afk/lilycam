'use strict';
/**
 * LilyCam — web nội bộ xem camera các cửa hàng.
 * Chỉ dùng thư viện lõi của Node.js (>= 18). Không cần npm install.
 *
 *   node server.js                 # chạy ở http://0.0.0.0:8787
 *   PORT=9000 node server.js
 *   node server.js --reset-password
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dahua = require('./lib/dahua');
const { jpegSize } = require('./lib/jpeg');
const { createHls } = require('./lib/hls');
const { createNetSdk } = require('./lib/netsdk');
const larkLib = require('./lib/lark');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE = 'lilycam_sid';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* Dữ liệu                                                             */
/* ------------------------------------------------------------------ */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const camerasFile = path.join(DATA, 'cameras.json');
let cameras = readJSON(camerasFile, { stores: [] });
const stores = new Map(cameras.stores.map((s) => [s.id, s]));

const FFMPEG = process.env.FFMPEG || path.join(ROOT, 'bin', 'ffmpeg');

const hls = createHls({
  ffmpeg: FFMPEG,
  dir: path.join(DATA, 'hls'),
  maxSessions: Number(process.env.MAX_STREAMS || 20),
  maxHd: Number(process.env.MAX_HD || 3),
  maxPerStore: Number(process.env.MAX_PER_STORE || 12),
  // 3 phút không ai xem → ngủ (mặc định), đổi bằng IDLE_SECS
  idleMs: Number(process.env.IDLE_SECS || 180) * 1000,
  idleGridMs: Number(process.env.IDLE_SECS || 180) * 1000,
  // chụp 1 khung từ segment đầu để lần mở sau có ảnh xem trước tức thì
  onPoster: (storeId, ch, segFile) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', segFile,
      '-frames:v', '1', '-f', 'mjpeg', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('exit', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 2000) return;
      const key = storeId + ':' + ch;
      const t = Date.now();
      lastFrame.set(key, { t, buf });
      snapCache.set(key, { t, buf });
    });
    p.on('error', () => {});
  },
  codecFile: path.join(DATA, 'codecs.json'),
  log: (m) => console.log(m),
});

const recCache = new Map();

/* ------------------------------------------------------------------ */
/* Giám sát tháng (Lark Base) — nút Chụp ảnh trong trình xem           */
/* ------------------------------------------------------------------ */
const normName = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();

const larkCfg = readJSON(path.join(DATA, 'lark.json'), null);
const larkViews = readJSON(path.join(DATA, 'lark-views.json'), null);
const lark = larkLib.create(larkCfg || {});
/** Tab (view) riêng của từng cơ sở trong bảng Giám sát tháng — để mở đúng chỗ ghi nhận. */
function viewOf(storeId) {
  if (!larkViews) return null;
  return (larkViews.views && larkViews.views[storeId]) || larkViews.fallback || null;
}
const CAPTURE_DIR = path.join(DATA, 'captures');
const looseKey = (s) => normName(s).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
let fieldOpts = { t: 0, data: null }; // cache danh mục sự cố / hạng mục 5S
const zonesFile = path.join(DATA, 'zones.json');
let zones = readJSON(zonesFile, {});
const storeChat = (() => {
  const exact = new Map();
  const loose = new Map();
  try {
    const raw = fs.readFileSync(path.join(DATA, 'dm.ndjson'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const name = normName(rec['Tên cơ sở']);
        if (!name || !rec.chat_id) continue;
        exact.set(name, rec.chat_id);
        loose.set(looseKey(name), rec.chat_id);
      } catch {}
    }
  } catch {}
  return { exact, loose };
})();
/** Tên cơ sở → chat_id (nhóm chat của cơ sở trong bảng Giám sát tháng). */
function chatOf(storeName) {
  return storeChat.exact.get(normName(storeName)) || storeChat.loose.get(looseKey(storeName)) || null;
}

/** Lưu ảnh chụp vào data/captures/YYYY-MM-DD/ và trả đường dẫn. */
function saveCapture(storeId, ch, buf, when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  const dir = path.join(CAPTURE_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  const name = `${storeId.replace(/[^\w-]+/g, '_')}-cam${ch}-${stamp}.jpg`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return { file, rel: `${day}/${name}` };
}

const netsdk = createNetSdk({
  helper: process.env.DAHUA_PB || path.join(ROOT, 'bin', 'dahua-pb'),
  sdkLib: path.join(ROOT, 'sdk', 'lib'),
  dir: path.join(DATA, 'pb'),
  ffmpeg: FFMPEG,
  codecOf: (store, ch) => hls.probe(store, ch),
  log: (m) => console.log(m),
});

const secretFile = path.join(DATA, '.session-secret');
let secret;
try {
  secret = fs.readFileSync(secretFile);
} catch {
  secret = crypto.randomBytes(48);
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
}

/* ------------------------------------------------------------------ */
/* Mật khẩu (scrypt)                                                   */
/* ------------------------------------------------------------------ */
const usersFile = path.join(DATA, 'users.json');
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const calc = crypto.scryptSync(password, rec.salt, 64, { N: 16384, r: 8, p: 1 });
  const known = Buffer.from(rec.hash, 'hex');
  return calc.length === known.length && crypto.timingSafeEqual(calc, known);
}

function loadUsers() {
  let db = readJSON(usersFile, null);
  if (!db || !db.users || !db.users.length) {
    const pw = 'Lily@' + crypto.randomBytes(6).toString('base64url');
    const u = { username: 'admin', ...hashPassword(pw), createdAt: new Date().toISOString() };
    db = { users: [u] };
    writeJSON(usersFile, db);
    fs.chmodSync(usersFile, 0o600);
    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log('  │  Tài khoản quản trị được tạo mới             │');
    console.log('  │  user: admin                                 │');
    console.log('  │  pass: ' + pw.padEnd(38) + '│');
    console.log('  └──────────────────────────────────────────────┘\n');
  }
  return db;
}

if (process.argv.includes('--reset-password')) {
  const pw = 'Lily@' + crypto.randomBytes(6).toString('base64url');
  const db = readJSON(usersFile, { users: [] });
  const u = db.users.find((x) => x.username === 'admin');
  const rec = { username: 'admin', ...hashPassword(pw), createdAt: new Date().toISOString() };
  if (u) Object.assign(u, rec);
  else db.users.push(rec);
  writeJSON(usersFile, db);
  console.log('Mật khẩu mới cho "admin":', pw);
  process.exit(0);
}

const users = loadUsers();

function getUser(name) {
  return users.users.find((u) => u.username.toLowerCase() === String(name || '').toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Phiên đăng nhập (cookie ký HMAC, không lưu server)                  */
/* ------------------------------------------------------------------ */
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function issueSession(username) {
  const payload = b64u(JSON.stringify({ u: username, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  return payload + '.' + sign(payload);
}
function checkSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return getUser(data.u) ? data.u : null;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function sessionUser(req) {
  return checkSession(parseCookies(req)[COOKIE]);
}

/* ------------------------------------------------------------------ */
/* Chống dò mật khẩu                                                   */
/* ------------------------------------------------------------------ */
const attempts = new Map(); // key -> {n, reset}
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  rec.n++;
  return rec.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}, 60e3).unref();

/* ------------------------------------------------------------------ */
/* Cache ảnh + giới hạn tải mỗi đầu ghi                                */
/* ------------------------------------------------------------------ */
const SNAP_TTL = 4000;
const snapCache = new Map(); // key -> {t, buf}
const lastFrame = new Map(); // key -> {t, buf}  (khung cuối, dùng làm poster tức thì)
const pending = new Map(); // key -> Promise
const MAX_PER_STORE = 4;
const MAX_GLOBAL = 24;
const waiters = [];
const activePerStore = new Map();
let activeTotal = 0;

function pump() {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i];
    if (activeTotal < MAX_GLOBAL && (activePerStore.get(w.id) || 0) < MAX_PER_STORE) {
      waiters.splice(i, 1);
      activeTotal++;
      activePerStore.set(w.id, (activePerStore.get(w.id) || 0) + 1);
      w.resolve(() => {
        activeTotal--;
        activePerStore.set(w.id, Math.max(0, (activePerStore.get(w.id) || 1) - 1));
        pump();
      });
    } else i++;
  }
}

function acquire(id) {
  return new Promise((resolve) => {
    waiters.push({ id, resolve });
    pump();
  });
}

function snapshotCached(store, channel) {
  const key = `${store.id}:${channel}`;
  const hit = snapCache.get(key);
  if (hit && Date.now() - hit.t < SNAP_TTL) return Promise.resolve(hit.buf);
  if (pending.has(key)) return pending.get(key);
  const p = acquire(store.id)
    .then(async (release) => {
      try {
        return await dahua.snapshot(store, channel);
      } finally {
        release();
      }
    })
    .then((buf) => {
      snapCache.set(key, { t: Date.now(), buf });
      lastFrame.set(key, { t: Date.now(), buf });
      setStatus(store.id, true);
      return buf;
    })
    .catch((err) => {
      // lỗi kênh không tồn tại (HTTP 400/404) không có nghĩa là mất kết nối
      if (err.code !== 'STATUS') setStatus(store.id, false, err.message);
      throw err;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/* Trạng thái online gần nhất của từng cơ sở */
const status = new Map();
function setStatus(id, ok, error) {
  status.set(id, { ok, error: error || null, at: Date.now() });
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}
function sendJSON(res, code, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; " +
    "script-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------------ */
/* Dịch vụ tĩnh                                                        */
/* ------------------------------------------------------------------ */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Không tìm thấy');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Phân quyền theo người dùng                                          */
/*   user.allowed = { stores: ['116a'], channels: { '116a': [1,2,...] } }
/*   Không có .allowed  => toàn quyền (admin)                          */
/* ------------------------------------------------------------------ */
function isRestricted(user) {
  return !!(user && user.allowed && Array.isArray(user.allowed.stores));
}
function allowedStoreIds(user) {
  return isRestricted(user) ? user.allowed.stores.map(String) : null;
}
function channelsFor(user, storeId) {
  if (!isRestricted(user)) return null;
  const c = (user.allowed.channels || {})[storeId];
  return Array.isArray(c) ? c.map(Number) : null;
}
/* Trả về null nếu được phép, hoặc 'store' / 'channel' nếu bị chặn */
function checkPathPermission(user, p) {
  if (!isRestricted(user)) return null;
  const allowed = allowedStoreIds(user);
  let m;
  /* API quản trị: cấm hoàn toàn với user bị giới hạn */
  if (/^\/api\/(dvr|storecfg|probe)\//.test(p)) return 'store';
  if (/^\/api\/stores\/[^/]+$/.test(p)) return 'store';
  m = p.match(/^\/api\/(pbcheck|codec)\/([^/]+)/);
  if (m) return allowed.includes(decodeURIComponent(m[2])) ? null : 'store';
  m = p.match(/^\/api\/(meta|snap|stream)\/([^/]+)\/(\d+)/);
  if (m) {
    const id = decodeURIComponent(m[2]);
    const ch = Number(m[3]);
    if (!allowed.includes(id)) return 'store';
    const list = channelsFor(user, id);
    return (!list || list.includes(ch)) ? null : 'channel';
  }
  m = p.match(/^\/hls\/(?:[\w]+\/)?([^/]+)\/(\d+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const ch = Number(m[2]);
    if (!allowed.includes(id)) return 'store';
    const list = channelsFor(user, id);
    return (!list || list.includes(ch)) ? null : 'channel';
  }
  return null;
}

function publicStore(s, user) {
  const st = status.get(s.id);
  const chans = channelsFor(user, s.id);
  return {
    id: s.id,
    name: s.name,
    unit: s.unit,
    cameras: chans ? chans.length : s.cameras,
    channels: chans || undefined,
    plan: s.plan || null,
    verified: !!s.verified,
    note: s.note || null,
    online: st ? st.ok : null,
    lastCheck: st ? st.at : null,
    error: st && st.ok === false ? st.error : null,
  };
}

async function handleLogin(req, res) {
  const ip = clientIP(req);
  if (tooMany('ip:' + ip, 10, 10 * 60e3)) {
    return sendJSON(res, 429, { error: 'Quá nhiều lần thử. Vui lòng chờ 10 phút.' });
  }
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = getUser(username);
  if (tooMany('u:' + username.toLowerCase(), 8, 10 * 60e3)) {
    return sendJSON(res, 429, { error: 'Tài khoản bị tạm khoá 10 phút do sai nhiều lần.' });
  }
  if (!user || !verifyPassword(password, user)) {
    await new Promise((r) => setTimeout(r, 350)); // giảm tốc dò
    return sendJSON(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }
  attempts.delete('u:' + username.toLowerCase());
  const token = issueSession(user.username);
  const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? ' Secure;' : '';
  sendJSON(
    res,
    200,
    { user: user.username },
    {
      'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600};${secure}`,
    }
  );
}

async function handleChangePassword(req, res, user) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  const rec = getUser(user);
  if (!verifyPassword(String(body.current || ''), rec)) {
    return sendJSON(res, 403, { error: 'Mật khẩu hiện tại không đúng.' });
  }
  const next = String(body.next || '');
  if (next.length < 8) return sendJSON(res, 400, { error: 'Mật khẩu mới phải từ 8 ký tự.' });
  Object.assign(rec, hashPassword(next));
  writeJSON(usersFile, users);
  const token = issueSession(rec.username);
  sendJSON(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}` });
}

async function handleSnapshot(req, res, store, channel) {
  if (!channel || channel < 1 || channel > 64) return send(res, 400, 'Kênh không hợp lệ');
  try {
    const buf = await snapshotCached(store, channel);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  } catch (err) {
    sendJSON(res, 502, { error: err.message, code: err.code || 'ERROR' });
  }
}

async function handleStream(req, res, store, channel) {
  if (!channel || channel < 1 || channel > 64) return send(res, 400, 'Kênh không hợp lệ');
  let up;
  try {
    up = await dahua.mjpeg(store, channel, 1);
  } catch (err) {
    // đầu ghi có thể đang bận vì lưới ảnh vừa refresh — thử lại 1 lần
    await new Promise((r) => setTimeout(r, 600));
    try {
      up = await dahua.mjpeg(store, channel, 1);
    } catch (err2) {
      return sendJSON(res, 502, { error: err2.message, code: err2.code || 'ERROR' });
    }
  }
  res.writeHead(200, {
    'Content-Type': up.headers['content-type'] || 'multipart/x-mixed-replace; boundary=myboundary',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close',
    'X-Content-Type-Options': 'nosniff',
  });
  setStatus(store.id, true);
  let last = Date.now();
  up.on('data', () => (last = Date.now()));
  const idle = setInterval(() => {
    if (Date.now() - last > 20000) up.destroy();
  }, 5000);
  const done = () => {
    clearInterval(idle);
    up.destroy();
  };
  res.on('close', done);
  res.on('error', done);
  up.on('error', done);
  up.pipe(res);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, stores: stores.size });

    if (p === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (p === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return res.end('{"ok":true}');
    }

    /* --- các API cần đăng nhập --- */
    if (p.startsWith('/api/')) {
      const uid = sessionUser(req);
      if (!uid) return sendJSON(res, 401, { error: 'Chưa đăng nhập' });
      const account = getUser(uid) || { username: uid };

      if (p === '/api/session') return sendJSON(res, 200, { user: uid });

      if (p === '/api/stats') {
        const mem = process.memoryUsage();
        return sendJSON(res, 200, {
          uptimeSec: Math.round(process.uptime()),
          nodeRssMB: Math.round(mem.rss / 1048576),
          stores: cameras.stores.length,
          hls: hls.stats(),
          netsdk: { enabled: netsdk.enabled },
        });
      }
      if (p === '/api/password' && req.method === 'POST') return handleChangePassword(req, res, uid);

      if (p === '/api/stores') {
        const allow = allowedStoreIds(account);
        const list = allow ? cameras.stores.filter((s) => allow.includes(String(s.id))) : cameras.stores;
        return sendJSON(res, 200, {
          user: uid,
          updatedAt: cameras.updatedAt,
          source: cameras.source,
          hd: hls.enabled,
          netsdk: netsdk.enabled,
          stores: list.map((s) => publicStore(s, account)),
        });
      }

      /* Chặn sớm mọi API vượt quyền (cơ sở / kênh) */
      const perm = checkPathPermission(account, p);
      if (perm === 'store') return sendJSON(res, 403, { error: 'Không có quyền với cơ sở này' });
      if (perm === 'channel') return sendJSON(res, 403, { error: 'Không có quyền với kênh này' });

      /* Mở giao diện web gốc của đầu ghi */
      let m = p.match(/^\/api\/dvr\/([^/]+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store || !store.host) return sendJSON(res, 404, { error: 'Cơ sở chưa có địa chỉ' });
        res.writeHead(302, { Location: `http://${store.host}:${store.port}/`, 'Cache-Control': 'no-store' });
        return res.end();
      }

      /* Cấu hình kết nối đầy đủ (chỉ để hiển thị trong form sửa) */
      /* Làm nóng phiên HD trước khi người dùng bấm (hover) */
      m = p.match(/^\/api\/warm\/([^/]+)\/(\d+)$/);
      if (m && req.method === 'POST') {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store || !store.host) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        try { hls.get(store, Number(m[2]), 'hd'); } catch {}
        return sendJSON(res, 200, { ok: true });
      }

      /* Nhường kết nối: đóng ngay các phiên lưới của cơ sở khi mở cửa sổ xem */
      m = p.match(/^\/api\/release\/([^/]+)$/);
      if (m && req.method === 'POST') {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const keepCh = Number(url.searchParams.get('keep'));
        hls.release(store.id, ['hd'], Number.isFinite(keepCh) ? keepCh : null);
        return sendJSON(res, 200, { ok: true });
      }

      /* Danh sách đoạn có bản ghi trong 1 ngày (cho timeline) */
      m = p.match(/^\/api\/records\/([^/]+)\/(\d+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        const ch = Number(m[2]);
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const day = String(url.searchParams.get('date') || '');
        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
        if (!dm) return sendJSON(res, 400, { error: 'Ngày không hợp lệ' });
        const start = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0).getTime() / 1000;
        const end = start + 86400;
        const key = `${store.id}:${ch}:${day}`;
        const hit = recCache.get(key);
        if (hit && Date.now() - hit.t < 5 * 60e3) return sendJSON(res, 200, { segments: hit.segments });
        if (!netsdk.enabled) return sendJSON(res, 200, { segments: [] });
        const segs = await netsdk.listRecords(store, ch, start, end);
        recCache.set(key, { t: Date.now(), segments: segs });
        return sendJSON(res, 200, { segments: segs });
      }

      /* Đầu ghi có hỗ trợ xem lại qua RTSP không */
      m = p.match(/^\/api\/pbcheck\/([^/]+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const rtspOk = await hls.playbackSupported(store);
        const engine = rtspOk ? 'rtsp' : (netsdk.enabled ? 'netsdk' : null);
        return sendJSON(res, 200, { supported: !!engine, engine });
      }

      /* Codec luồng chính (để biết có dùng được "luồng gốc" không) */
      m = p.match(/^\/api\/codec\/([^/]+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        try {
          const codec = await hls.probe(store, 1);
          return sendJSON(res, 200, { codec: codec || null });
        } catch {
          return sendJSON(res, 200, { codec: null });
        }
      }

      m = p.match(/^\/api\/storecfg\/([^/]+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        return sendJSON(res, 200, {
          host: store.host, port: store.port, user: store.user, pass: store.pass, cameras: store.cameras,
        });
      }

      /* Kích thước khung hình để canh tỉ lệ cho trình xem */
      m = p.match(/^\/api\/meta\/([^/]+)\/(\d+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        try {
          const buf = await snapshotCached(store, Number(m[2]));
          const size = jpegSize(buf) || { w: 4, h: 3 };
          return sendJSON(res, 200, { w: size.w, h: size.h });
        } catch (err) {
          return sendJSON(res, 200, { w: 4, h: 3, error: err.message });
        }
      }

      m = p.match(/^\/api\/snap\/([^/]+)\/(\d+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const ch = Number(m[2]);
        if (url.searchParams.get('fast') === '1') {
          const lf = lastFrame.get(`${store.id}:${ch}`);
          // poster tức thì: chỉ trả khung đã có sẵn, không gọi đầu ghi (giữ kết nối cho luồng chính)
          if (!lf) {
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            return res.end();
          }
          if (lf) {
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Content-Length': lf.buf.length,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            return res.end(lf.buf);
          }
        }
        return handleSnapshot(req, res, store, ch);
      }

      m = p.match(/^\/api\/stream\/([^/]+)\/(\d+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        return handleStream(req, res, store, Number(m[2]));
      }

      /* Danh mục sự cố / hạng mục 5S lấy từ Lark (cache 1 giờ) */
      if (p === '/api/capture/options') {
        if (fieldOpts.data && Date.now() - fieldOpts.t < 3600e3) return sendJSON(res, 200, fieldOpts.data);
        if (!larkCfg || !larkCfg.cli || !larkCfg.fields) return sendJSON(res, 200, { categories: [], items: [] });
        const r = await lark.execCli(larkCfg.cli, ['base', '+field-list',
          '--base-token', larkCfg.base_token, '--table-id', larkCfg.table_id, '--format', 'json'], 60000)
          .catch(() => ({ ok: false }));
        const fields = (r.ok && r.data && r.data.data && r.data.data.fields) || [];
        const optionsOf = (name) => {
          const f = fields.find((x) => x.name === name);
          return f && Array.isArray(f.options) ? f.options.map((o) => o.name) : [];
        };
        const data = {
          categories: optionsOf(larkCfg.fields.category),
          items: optionsOf(larkCfg.fields.item),
        };
        if (data.categories.length) fieldOpts = { t: Date.now(), data };
        return sendJSON(res, 200, data);
      }

      /* Điều khiển PTZ */
      m = p.match(/^\/api\/ptz\/([^/]+)\/(\d+)$/);
      if (m && req.method === 'POST') {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store || !store.host) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const allowP = allowedStoreIds(account);
        if (allowP && !allowP.includes(String(store.id))) return sendJSON(res, 403, { error: 'Không có quyền với cơ sở này' });
        let body;
        try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
        try {
          const out = await dahua.ptz(store, Number(m[2]), String(body.code || ''), {
            action: String(body.action || 'start'),
            speed: Number(body.speed) || 4,
          });
          return sendJSON(res, 200, { ok: true, result: out });
        } catch (err) {
          return sendJSON(res, 502, { error: err.message, code: err.code || 'ERROR' });
        }
      }

      /* Vùng cảnh báo từng camera (lưới ô vuông) */
      m = p.match(/^\/api\/zones\/([^/]+)\/(\d+)$/);
      if (m) {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const allowZ = allowedStoreIds(account);
        if (allowZ && !allowZ.includes(String(store.id))) return sendJSON(res, 403, { error: 'Không có quyền với cơ sở này' });
        const ch = Number(m[2]);
        const key = `${store.id}:${ch}`;
        if (req.method === 'GET') return sendJSON(res, 200, zones[key] || null);
        if (req.method === 'POST') {
          let body;
          try { body = await readBody(req, 512 * 1024); } catch (e) { return sendJSON(res, 413, { error: e.message }); }
          const cols = Math.max(1, Math.min(64, Number(body.cols) || 16));
          const rows = Math.max(1, Math.min(64, Number(body.rows) || 9));
          const max = cols * rows;
          const cells = Array.isArray(body.cells)
            ? [...new Set(body.cells.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < max))]
            : [];
          zones[key] = { cols, rows, cells, updatedAt: new Date().toISOString() };
          writeJSON(zonesFile, zones);
          return sendJSON(res, 200, zones[key]);
        }
      }

      /* Trạng thái nút Chụp ảnh: tuần hiện tại + đã cấu hình Lark chưa */
      if (p === '/api/capture/status') {
        return sendJSON(res, 200, {
          enabled: lark.enabled,
          week: lark.weekOfMonth(new Date()),
          stores: storeChat.exact.size,
          base: larkCfg ? larkCfg.base_url || null : null,
        });
      }

      /* Chụp ảnh từ trình xem → lưu vào data/captures + đẩy sang Giám sát tháng */
      if (p === '/api/capture' && req.method === 'POST') {
        let body;
        try {
          body = await readBody(req, 14 * 1024 * 1024);
        } catch (e) {
          return sendJSON(res, 413, { error: e.message });
        }
        const store = stores.get(String(body.store || ''));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const allow = allowedStoreIds(account);
        if (allow && !allow.includes(String(store.id))) {
          return sendJSON(res, 403, { error: 'Không có quyền với cơ sở này' });
        }
        const ch = Number(body.ch);
        if (!Number.isFinite(ch) || ch < 1 || ch > 64) return sendJSON(res, 400, { error: 'Kênh không hợp lệ' });
        const dm = /^data:image\/jpeg;base64,(.+)$/i.exec(String(body.image || ''));
        if (!dm) return sendJSON(res, 400, { error: 'Ảnh không hợp lệ (chỉ nhận JPEG)' });
        const buf = Buffer.from(dm[1], 'base64');
        if (buf.length < 1024) return sendJSON(res, 400, { error: 'Ảnh quá nhỏ' });
        const saved = saveCapture(store.id, ch, buf);
        const chatId = chatOf(store.name);
        const viewId = viewOf(store.id);
        const info = await lark.submitCapture({
          storeName: store.name, chatId, ch, file: saved.file, viewId,
          category: String(body.category || '').slice(0, 200),
          item: String(body.item || '').slice(0, 200),
          desc: String(body.desc || '').slice(0, 2000),
        }).catch((e) => ({ ok: false, error: e.message }));
        return sendJSON(res, 200, {
          ok: true,
          saved: saved.rel,
          week: info.week || lark.weekOfMonth(new Date()),
          recordId: info.recordId || null,
          url: info.url || (larkCfg && larkCfg.base_url ? lark.recordUrl(null, viewId) : null),
          view: viewId,
          warning: info.ok ? null : (info.error || 'Chưa gửi được lên Lark'),
        });
      }

      m = p.match(/^\/api\/probe\/([^/]+)$/);
      if (m && req.method === 'POST') {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const t0 = Date.now();
        try {
          await dahua.snapshot(store, 1);
          setStatus(store.id, true);
          return sendJSON(res, 200, { ok: true, ms: Date.now() - t0 });
        } catch (err) {
          setStatus(store.id, false, err.message);
          return sendJSON(res, 200, { ok: false, ms: Date.now() - t0, error: err.message });
        }
      }

      /* Sửa thông tin kết nối của 1 cơ sở (dùng khi DDNS/mật khẩu đổi) */
      m = p.match(/^\/api\/stores\/([^/]+)$/);
      if (m && req.method === 'PUT') {
        const store = stores.get(decodeURIComponent(m[1]));
        if (!store) return sendJSON(res, 404, { error: 'Không có cơ sở này' });
        const body = await readBody(req);
        for (const k of ['host', 'port', 'user', 'pass', 'cameras']) {
          if (body[k] !== undefined) store[k] = k === 'port' || k === 'cameras' ? Number(body[k]) || null : String(body[k]).trim() || null;
        }
        store.verified = false;
        snapCache.clear();
        writeJSON(camerasFile, cameras);
        return sendJSON(res, 200, { ok: true });
      }
    }

    if (p.startsWith('/hls/')) {
      const uid = sessionUser(req);
      if (!uid) return sendJSON(res, 401, { error: 'Chưa đăng nhập' });
      const hperm = checkPathPermission(getUser(uid) || { username: uid }, p);
      if (hperm) return sendJSON(res, 403, { error: 'Không có quyền với nguồn này' });
      /* ---- HLS (luồng chính, nét) ---- */
      const hm = p.match(/^\/hls\/(?:(\w+)\/)?([^/]+)\/(\d+)\/([\w.-]+)$/);
      if (hm) {
        const profile = hm[1] || 'hd';
        const store = stores.get(decodeURIComponent(hm[2]));
        const ch = Number(hm[3]);
        const file = hm[4];
        if (!store) return send(res, 404, 'Không có cơ sở này');
        if (!/^[\w.-]+\.(m3u8|ts)$/.test(file)) return send(res, 400, 'Tên tệp không hợp lệ');
        if (!/^(hd|raw|g2|g4|g6|g8|g10|pb\d+)$/.test(profile)) return send(res, 400, 'Hồ sơ không hợp lệ');
        let sess;
        if (/^pb\d+$/.test(profile)) {
          const rtspOk = await hls.playbackSupported(store);
          sess = rtspOk ? hls.get(store, ch, profile) : (netsdk.enabled ? netsdk.get(store, ch, profile) : null);
        } else {
          sess = hls.get(store, ch, profile);
        }
        if (!sess) return sendJSON(res, 503, { error: 'Máy chủ chưa có ffmpeg cho chế độ HD' });
        sess.last = Date.now();
        if (file === 'index.m3u8') {
          const ok = await sess.ready;
          if (!ok) return sendJSON(res, 503, { error: sess.error || 'Không mở được luồng HD' });
        }
        const fp = path.join(sess.dir, file);
        if (!fp.startsWith(sess.dir + path.sep)) return send(res, 403, 'Forbidden');
        return fs.readFile(fp, (err, buf) => {
          if (err) return send(res, 404, 'Chưa có');
          res.writeHead(200, {
            'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(buf);
        });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[err]', req.method, p, err.message);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Lỗi máy chủ' });
    else res.destroy();
  }
});

server.headersTimeout = 20000;
server.requestTimeout = 120000;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    hls.shutdown();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`\n  LilyCam đang chạy`);
  console.log(`  → http://localhost:${PORT}`);
  lan.forEach((ip) => console.log(`  → http://${ip}:${PORT}  (trong LAN)`));
  console.log(`  Dữ liệu: ${cameras.stores.length} cơ sở — ${path.relative(ROOT, camerasFile)}`);
  console.log(`  Chế độ HD (HLS): ${hls.enabled ? 'bật' : 'TẮT (thiếu bin/ffmpeg)'}`);

  // làm nóng cache codec cho mọi cơ sở (nền) để lần mở đầu không phải dò
  setTimeout(async () => {
    let n = 0;
    for (const st of cameras.stores) {
      if (!st.host) continue;
      try { await hls.probe(st, 1); n++; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    if (n) console.log(`  Đã dò codec ${n} cơ sở`);
  }, 4000).unref();

  console.log('');
});
