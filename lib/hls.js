'use strict';
/**
 * Quản lý phiên HLS cho luồng chính (subtype=0) của đầu ghi Dahua.
 *
 * Mỗi phiên = 1 tiến trình ffmpeg đọc RTSP và ghi playlist .m3u8 + .ts.
 *
 * Hồ sơ (profile):
 *   hd  — xem 1 camera phóng to: giữ nguyên độ phân giải, H.264 thì copy luồng.
 *   g2..g10 — ô lưới (2/4/6/8/10 camera): thu nhỏ + hạ fps để 10 ô cùng lúc
 *             vẫn vừa băng thông của cửa hàng.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const { ipOf } = require('./dns');
const path = require('path');

const PROFILES = {
  // crf thấp + bitrate rộng + preset veryfast: hết "nhiễu/mờ" của cấu hình cũ (crf 26, ultrafast)
  hd: { width: 0, fps: 0, rate: 4500, crf: 21, threads: 4 },
  raw: { raw: true },
  g2: { width: 960, fps: 20, rate: 3000, crf: 22, threads: 2 },
  g4: { width: 720, fps: 20, rate: 2500, crf: 23, threads: 2 },
  g6: { width: 640, fps: 15, rate: 1800, crf: 24, threads: 2 },
  // Mọi hồ sơ đều lấy LUỒNG CHÍNH (subtype=0) — hình nét đồng nhất, không phải bấm "HD".
  g8: { width: 640, fps: 15, rate: 1800, crf: 24, threads: 2 },
  g10: { width: 560, fps: 12, rate: 1400, crf: 25, threads: 2 },
};

function rtspUrl(store, channel, host = null, subtype = 0) {
  const user = encodeURIComponent(store.user || 'admin');
  const pass = encodeURIComponent(store.pass || '');
  return `rtsp://${user}:${pass}@${host || store.host}:554/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
}

/** Giờ theo đồng hồ của đầu ghi: YYYY-MM-DDTHH:MM:SS (giờ máy chủ). */
function deviceTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** URL xem lại bản ghi (playback) — dùng chung cú pháp realmonitor + starttime/endtime. */
function rtspPlaybackUrl(store, channel, startSec, durationSec = 7200) {
  const user = encodeURIComponent(store.user || 'admin');
  const pass = encodeURIComponent(store.pass || '');
  const start = startSec * 1000;
  const end = start + durationSec * 1000;
  return `rtsp://${user}:${pass}@${store.host}:554/cam/playback?channel=${channel}&subtype=0` +
    `&starttime=${deviceTime(start)}&endtime=${deviceTime(end)}`;
}

function createHls({ ffmpeg, dir, maxSessions = 15, maxHd = 3, maxPerStore = 12, idleMs = 180000, idleGridMs = 180000, codecFile = null, onPoster = null, log = () => {} }) {
  // idleMs: không ai xem quá 3 phút thì "ngủ" (tắt ffmpeg + nhả RTSP) để dồn tài nguyên/băng thông
  // cho các camera đang thật sự chạy.
  // mỗi tiến trình dùng thư mục riêng để nhiều instance không xoá dữ liệu của nhau
  dir = path.join(dir, 'p' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  } catch {}
  const enabled = !!ffmpeg && fs.existsSync(ffmpeg);
  const sessions = new Map();
  // cơ sở nào lỗi luồng phụ thì quay lại luồng chính (30 phút mới thử lại)
  const subFallback = new Map();
  const codecCache = new Map();
  try {
    if (codecFile && fs.existsSync(codecFile)) {
      const saved = JSON.parse(fs.readFileSync(codecFile, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(saved)) codecCache.set(k, { t: now, v });
    }
  } catch {}
  let saveTimer = null;
  function saveCodecs() {
    if (!codecFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const out = {};
        for (const [k, v] of codecCache) out[k] = v.v;
        fs.writeFileSync(codecFile, JSON.stringify(out));
      } catch {}
    }, 500).unref();
  }
  const keyOf = (store, ch, profile) => `${store.id}-${ch}-${profile}`;
  const codecKey = (store, subtype = 0) => 'c:' + store.id + (subtype ? ':s' : '');

  function probeCodec(store, ch, subtype = 0) {
    const k = codecKey(store, subtype);
    const hit = codecCache.get(k);
    // codec gần như không đổi → nhớ 6 giờ, tránh dò lại (mỗi lần dò mất ~1,5–2 giây khi mở HD)
    if (hit && Date.now() - hit.t < 6 * 3600e3) return Promise.resolve(hit.v);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.kill('SIGKILL'); } catch {}
        codecCache.set(k, { t: Date.now(), v });
        saveCodecs();
        resolve(v);
      };
      const proc = spawn(ffmpeg, [
        '-hide_banner', '-rtsp_transport', 'tcp', '-timeout', '6000000',
        '-i', rtspUrl(store, ch, null, subtype), '-t', '0', '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let buf = '';
      proc.stderr.on('data', (d) => {
        buf += d.toString();
        if (buf.length > 30000) buf = buf.slice(-15000);
        const m = /Stream #\d+:\d+.*?: Video:\s*([a-zA-Z0-9_]+)/.exec(buf);
        if (m) finish(m[1].toLowerCase());
      });
      proc.on('error', () => finish(null));
      proc.on('exit', () => finish(null));
      const timer = setTimeout(() => finish(null), 12000);
      timer.unref();
    });
  }

  function kill(sess, why) {
    if (!sess) return;
    sessions.delete(sess.key);
    sess.dead = true;
    sess.intentional = true; // đóng có chủ đích → không ghi log "lỗi"
    try { sess.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try { sess.proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(sess.dir, { recursive: true, force: true }); } catch {}
    }, 1500).unref();
    log(`[hls] đóng ${sess.key} (${why})`);
  }

  function evictIfNeeded(exceptKey, profile) {
    const hdCount = [...sessions.values()].filter((s) => s.profile === 'hd').length;
    const overHd = profile === 'hd' && hdCount >= maxHd;
    if (sessions.size < maxSessions && !overHd) return;

    let pool = [...sessions.values()].filter((s) => s.key !== exceptKey);
    if (overHd) {
      const hdPool = pool.filter((s) => s.profile === 'hd');
      if (hdPool.length) pool = hdPool;
    }
    // ưu tiên đuổi phiên lưới (nhẹ) trước, rồi tới phiên cũ nhất
    pool.sort((a, b) => (a.profile === 'hd' ? 1 : 0) - (b.profile === 'hd' ? 1 : 0) || a.last - b.last);
    const victim = pool[0];
    if (victim) kill(victim, overHd ? 'quá số phiên HD' : 'quá số phiên');
  }

  function videoArgs(profile, codec) {
    const p = PROFILES[profile] || PROFILES.hd;
    if (profile === 'raw') return codec === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-crf', '24', '-pix_fmt', 'yuv420p'];
    if ((profile === 'hd' || profile.startsWith('pb')) && codec === 'h264') return ['-c:v', 'copy'];
    // veryfast + aq-mode=2 + B-frame: nét hơn hẳn ultrafast ở cùng bitrate
    const args = ['-c:v', 'libx264', '-preset', 'veryfast', '-threads', String(p.threads || 2)];
    if (p.width && p.sub) {
      // luồng phụ thường chỉ 352×288…640×480 → giữ nguyên cỡ gốc, chỉ hạ fps (không phóng to)
      args.push('-vf', `fps=${p.fps}`);
    } else if (p.width) {
      // lanczos giữ chi tiết tốt hơn bicubic khi thu nhỏ 1080p
      args.push('-vf', `scale=${p.width}:-2:flags=lanczos,fps=${p.fps}`);
    }
    args.push(
      '-crf', String(p.crf),
      '-maxrate', `${p.rate || 3500}k`,
      '-bufsize', `${(p.rate || 3500) * 2}k`,
      '-profile:v', 'main',
      '-bf', '2',
      '-x264-params', 'aq-mode=2',
      '-g', String(Math.max(12, Math.round((p.fps || 25) / 2))),
      '-force_key_frames', 'expr:gte(t,n_forced*0.5)',
      '-pix_fmt', 'yuv420p'
    );
    return args;
  }

  /** Kiểm tra nhanh đầu ghi có hỗ trợ xem lại qua RTSP (/cam/playback) không. */
  const pbCache = new Map();
  function playbackSupported(store) {
    const key = 'pb:' + store.id;
    const hit = pbCache.get(key);
    if (hit && Date.now() - hit.t < 30 * 60e3) return Promise.resolve(hit.ok);
    return new Promise((resolve) => {
      const now = Math.floor(Date.now() / 1000);
      const url = rtspPlaybackUrl(store, 1, now - 900, 300);
      const proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '5000000',
        '-i', url, '-t', '0', '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.kill('SIGKILL'); } catch {}
        pbCache.set(key, { t: Date.now(), ok });
        resolve(ok);
      };
      proc.stderr.on('data', (d) => {
        err = (err + d.toString()).slice(-2000);
        if (/404|401|not found|unauthor/i.test(err)) finish(false);
      });
      proc.on('error', () => finish(false));
      proc.on('exit', (code) => finish(code === 0 || !/\b404\b/.test(err)));
      const timer = setTimeout(() => finish(false), 15000);
      timer.unref();
    });
  }

  function start(store, ch, profile = 'hd') {
    const key = keyOf(store, ch, profile);
    const pbMatch = /^pb(\d+)$/.exec(profile);
    const isPb = !!pbMatch;
    const pbStart = isPb ? Number(pbMatch[1]) : 0;
    const prof = PROFILES[profile] || PROFILES.hd;
    const fbAt = subFallback.get(store.id);
    const wantSub = !!prof.sub && !(fbAt && Date.now() - fbAt < 30 * 60e3);
    const subtype = wantSub ? 1 : 0;
    const existing = sessions.get(key);
    if (existing && !existing.dead) {
      existing.last = Date.now();
      return existing;
    }

    const sess = {
      key,
      store: store.id,
      ch,
      profile,
      dir: path.join(dir, `${key}-${Date.now().toString(36)}`),
      last: Date.now(),
      started: Date.now(),
      dead: false,
      error: null,
    };

    sessions.set(key, sess);

    sess.ready = (async () => {
      // giới hạn số kết nối tới cùng một đầu ghi
      const sameStore = [...sessions.values()].filter((x) => x.store === store.id && x !== sess);
      if (sameStore.length >= maxPerStore) {
        sameStore.sort((a, b) => a.last - b.last);
        for (const old of sameStore.slice(0, sameStore.length - maxPerStore + 1)) kill(old, 'quá kết nối tới đầu ghi');
      }
      evictIfNeeded(key, profile);
      const codec = profile === 'hd' || profile === 'raw' || isPb ? await probeCodec(store, ch, subtype) : null;
      if (profile === 'raw' && codec && codec !== 'h264') {
        sess.error = 'Đầu ghi dùng HEVC nên không xem trực tiếp luồng gốc được';
        sess.dead = true;
        sessions.delete(key);
        return false;
      }
      try { fs.rmSync(sess.dir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(sess.dir, { recursive: true });

      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp', '-timeout', '8000000',
        // KHÔNG dùng '-fflags nobuffer': với HEVC của Dahua nó làm mất khung tham chiếu
        // ("Error constructing the frame RPS") và đẩy thời gian mở luồng lên ~9 giây.
        '-flags', 'low_delay',
        '-i', isPb ? rtspPlaybackUrl(store, ch, pbStart) : rtspUrl(store, ch, await ipOf(store.host), subtype),
        ...videoArgs(profile, codec),
        '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1',
        '-f', 'hls',
        // 0,5 giây cho HD (mở nhanh), 1 giây cho ô lưới — HLS không cho TARGETDURATION lẻ
        '-hls_time', profile === 'hd' || isPb || profile === 'raw' ? '0.5' : '1',
        // giữ nhiều segment hơn để trình phát có đệm, tránh 404 khi mạng chậm
        '-hls_list_size', profile === 'hd' || isPb ? '8' : '6',
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(sess.dir, 'seg%03d.ts'),
        path.join(sess.dir, 'index.m3u8'),
      ];

      sess.codec = codec;
      sess.proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let errBuf = '';
      sess.proc.stderr.on('data', (d) => {
        errBuf = (errBuf + d.toString()).slice(-4000);
        sess.lastError = errBuf.trim().split('\n').pop();
      });
      sess.proc.on('error', (e) => {
        sess.error = e.message;
        sess.dead = true;
        sessions.delete(key);
      });
      sess.proc.on('exit', (code) => {
        sess.dead = true;
        if (sessions.get(key) === sess) sessions.delete(key);
        setTimeout(() => {
          try { fs.rmSync(sess.dir, { recursive: true, force: true }); } catch {}
        }, 800).unref();
        if (code !== 0 && !sess.intentional) {
          sess.error = sess.lastError || `ffmpeg thoát (${code})`;
          log(`[hls] ${key} lỗi: ${sess.error}`);
        }
      });

      log(`[hls] mở ${key}${codec ? ' codec=' + codec : ''}${subtype ? ' (luồng phụ)' : ''}`);

      const playlist = path.join(sess.dir, 'index.m3u8');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (sess.dead) {
          if (subtype === 1) { subFallback.set(store.id, Date.now()); log(`[hls] ${key}: luồng phụ lỗi → dùng luồng chính cho cơ sở này`); }
          return false;
        }
        try {
          const st = fs.statSync(playlist);
          const ts = fs.readdirSync(sess.dir).filter((f) => f.endsWith('.ts'));
          if (st.size > 0 && ts.length > 0) {
            log(`[hls] ${key} sẵn sàng sau ${Date.now() - sess.started}ms`);
            // lưu 1 khung làm ảnh xem trước cho lần mở sau (hiện tức thì, không chờ HLS)
            if (onPoster && !sess.posterDone) {
              sess.posterDone = true;
              try { onPoster(store.id, ch, path.join(sess.dir, ts.sort()[0])); } catch {}
            }
            return true;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      sess.error = sess.error || 'Hết thời gian chờ luồng';
      if (subtype === 1) { subFallback.set(store.id, Date.now()); log(`[hls] ${key}: luồng phụ quá chậm → dùng luồng chính cho cơ sở này`); }
      return false;
    })();

    sess.ready.catch(() => false);
    return sess;
  }

  /** Đóng ngay các phiên lưới (g2..g10, raw) của một cơ sở để nhường kết nối cho viewer. */
  function release(storeId, keep = ['hd'], keepChannel = null) {
    for (const s of [...sessions.values()]) {
      if (s.store !== storeId) continue;
      if (keep.includes(s.profile)) continue;
      if (keepChannel != null && s.ch === keepChannel) continue; // giữ ô vừa bấm để bê sang viewer
      kill(s, 'nhường chỗ cho cửa sổ xem');
    }
  }

  function get(store, ch, profile = 'hd') {
    if (!enabled || !store || !store.host) return null;
    if (!PROFILES[profile] && !/^pb\d+$/.test(profile)) profile = 'hd';
    const sess = start(store, ch, profile);
    sess.last = Date.now();
    return sess;
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      const limit = s.profile === 'hd' || s.profile.startsWith('pb') ? idleMs : idleGridMs;
      if (now - s.last > limit) kill(s, 'không còn người xem');
    }
  }, 3000);
  sweeper.unref();

  function shutdown() {
    for (const s of [...sessions.values()]) {
      s.intentional = true;
      try { s.proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
    }
    sessions.clear();
  }

  return {
    enabled,
    get,
    probe: probeCodec,
    release,
    playbackSupported,
    shutdown,
    stats: () => ({
      sessions: sessions.size,
      max: maxSessions,
      idleSec: Math.round(idleGridMs / 1000),
      byProfile: [...sessions.values()].reduce((a, x) => { a[x.profile] = (a[x.profile] || 0) + 1; return a; }, {}),
      list: [...sessions.values()].map((x) => ({
        store: x.store, ch: x.ch, profile: x.profile,
        ageSec: Math.round((Date.now() - x.started) / 1000),
        idleSec: Math.round((Date.now() - x.last) / 1000),
        codec: x.codec || null, error: x.error || null,
      })),
    }),
  };
}

module.exports = { createHls, rtspUrl, rtspPlaybackUrl, deviceTime, PROFILES };
