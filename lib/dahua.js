'use strict';
/**
 * Client nhỏ cho đầu ghi Dahua (XVR/NVR) qua HTTP Digest.
 * Chỉ dùng module lõi của Node — không cần cài thêm gì.
 */
const http = require('http');
const { ipOf } = require('./dns');
const crypto = require('crypto');

const agent = new http.Agent({ keepAlive: true, maxSockets: 48 });

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  const out = {};
  const re = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3].trim();
  return out;
}

function buildAuth(ch, { user, pass, method, uri }) {
  const realm = ch.realm || '';
  const nonce = ch.nonce || '';
  const qop = (ch.qop || '').split(',').map((s) => s.trim()).find((s) => s === 'auth') || null;
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h =
    `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
    `response="${response}", algorithm=MD5`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.opaque !== undefined && ch.opaque !== '') h += `, opaque="${ch.opaque}"`;
  return h;
}

function attempt(store, path, hostIp, method, authHeader, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'LilyCam/1.0', Accept: '*/*' };
    if (authHeader) headers.Authorization = authHeader;
    const req = http.request(
      { host: hostIp, port: store.port, path, method, headers, agent, timeout },
      (res) => resolve(res)
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Hết thời gian chờ thiết bị'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Mở một request tới đầu ghi, tự xử lý challenge Digest.
 * Trả về http.IncomingMessage (status 200) — người gọi tự đọc/pipe.
 */
async function open(store, path, { method = 'GET', timeout = 9000 } = {}) {
  if (!store || !store.host) {
    const e = new Error('Chưa cấu hình địa chỉ cho cơ sở này');
    e.code = 'NOHOST';
    throw e;
  }
  const hostIp = await ipOf(store.host);
  let res = await attempt(store, path, hostIp, method, null, timeout);
  if (res.statusCode === 401) {
    const chal = res.headers['www-authenticate'];
    res.resume();
    if (!chal) {
      const e = new Error('Thiết bị từ chối (401)');
      e.code = 'AUTH';
      throw e;
    }
    const header = buildAuth(parseChallenge(chal), {
      user: store.user || 'admin',
      pass: store.pass || '',
      method,
      uri: path,
    });
    res = await attempt(store, path, hostIp, method, header, timeout);
    if (res.statusCode === 401) {
      res.resume();
      const e = new Error('Sai tài khoản / mật khẩu camera');
      e.code = 'AUTH';
      throw e;
    }
  }
  if (res.statusCode !== 200) {
    res.resume();
    const e = new Error(`Thiết bị trả về HTTP ${res.statusCode}`);
    e.code = 'STATUS';
    e.status = res.statusCode;
    throw e;
  }
  return res;
}

function readAll(stream, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error('Ảnh quá lớn'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Ảnh chụp nhanh 1 kênh: /cgi-bin/snapshot.cgi?channel=N */
async function snapshot(store, channel) {
  const res = await open(store, `/cgi-bin/snapshot.cgi?channel=${channel}`, { timeout: 6000 });
  const body = await readAll(res);
  if (!body.length) throw new Error('Ảnh rỗng');
  return body;
}

/** Luồng MJPEG: /cgi-bin/mjpg/video.cgi?channel=N&subtype=1 */
function mjpeg(store, channel, subtype = 1) {
  return open(store, `/cgi-bin/mjpg/video.cgi?channel=${channel}&subtype=${subtype}`, { timeout: 10000 });
}

/**
 * Điều khiển PTZ qua CGI của Dahua:
 *   /cgi-bin/ptz.cgi?action=start|stop&channel=N&code=Up&arg1=0&arg2=<speed>&arg3=0
 * code: Up Down Left Right LeftUp RightUp LeftDown RightDown ZoomTile ZoomWide
 *       FocusNear FocusFar IrisSmall IrisLarge
 */
const PTZ_CODES = new Set([
  'Up', 'Down', 'Left', 'Right', 'LeftUp', 'RightUp', 'LeftDown', 'RightDown',
  'ZoomTile', 'ZoomWide', 'FocusNear', 'FocusFar', 'IrisSmall', 'IrisLarge',
]);

async function ptz(store, channel, code, { action = 'start', speed = 4 } = {}) {
  if (!PTZ_CODES.has(code)) {
    const e = new Error('Mã điều khiển không hợp lệ');
    e.code = 'PARAM';
    throw e;
  }
  if (!(channel >= 1 && channel <= 64)) {
    const e = new Error('Kênh không hợp lệ');
    e.code = 'PARAM';
    throw e;
  }
  const sp = Math.min(8, Math.max(1, Number(speed) || 4));
  const path = `/cgi-bin/ptz.cgi?action=${action === 'stop' ? 'stop' : 'start'}&channel=${channel}` +
    `&code=${code}&arg1=0&arg2=${sp}&arg3=0`;
  const res = await open(store, path, { timeout: 6000 });
  const body = await readAll(res, 64 * 1024);
  const text = body.toString('utf8').trim();
  if (/error/i.test(text)) {
    const e = new Error('Đầu ghi báo lỗi PTZ: ' + text.slice(0, 100));
    e.code = 'PTZ';
    throw e;
  }
  return text || 'OK';
}

module.exports = { open, snapshot, mjpeg, ptz, PTZ_CODES };
