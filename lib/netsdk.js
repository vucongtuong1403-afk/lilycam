'use strict';
/**
 * Xem lại bản ghi qua Dahua NetSDK (dùng cho các đầu ghi không mở RTSP playback).
 *
 * Luồng: helper C (bin/dahua-pb) tải đoạn ghi về file .dav với tốc độ tối đa,
 * Node đọc file đang lớn dần, bóc header DHAV (44 byte mỗi khối 1024), đẩy vào
 * ffmpeg (-re) để phát đúng 1× và đóng gói HLS.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ipOf } = require('./dns');

const BLOCK = 1024;
const HDR = 44;

function createNetSdk({ helper, sdkLib, dir, maxSec = 600, idleMs = 30000, ffmpeg, codecOf, log = () => {} }) {
  // thư mục riêng theo tiến trình: instance khác không xoá mất bản đang ghi
  dir = path.join(dir, 'p' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  // dọn rác lần chạy trước
  try { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch {}
  const enabled = !!helper && fs.existsSync(helper);
  const sessions = new Map();

  function kill(sess, why) {
    if (!sess) return;
    sessions.delete(sess.key);
    sess.dead = true;
    try { sess.child.kill('SIGKILL'); } catch {}
    try { sess.ff.kill('SIGTERM'); } catch {}
    clearInterval(sess.pumpTimer);
    setTimeout(() => {
      try { fs.rmSync(sess.dir, { recursive: true, force: true }); } catch {}
    }, 1500).unref();
    log(`[netsdk] đóng ${sess.key} (${why})`);
  }

  function strip(chunk, state) {
    // Ghép thêm dữ liệu vào bộ đệm, cắt từng khối 1024 byte và bỏ 44 byte header
    state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
    const out = [];
    while (state.buf.length >= BLOCK) {
      const blk = state.buf.subarray(0, BLOCK);
      state.buf = state.buf.subarray(BLOCK);
      if (blk[0] === 0x44 && blk[1] === 0x48 && blk[2] === 0x41 && blk[3] === 0x56) out.push(blk.subarray(HDR));
      else out.push(blk); // không phải khối DHAV → giữ nguyên
    }
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }

  function start(store, ch, profile) {
    const startSec = Number(/^pb(\d+)$/.exec(profile)[1]);
    const endSec = startSec + maxSec;
    const key = `${store.id}-${ch}-${profile}`;
    const sess = {
      key,
      dir: path.join(dir, `${key}-${Date.now().toString(36)}`),
      last: Date.now(),
      dead: false,
      error: null,
    };
    sessions.set(key, sess);
    fs.mkdirSync(sess.dir, { recursive: true });
    const dav = path.join(sess.dir, 'rec.dav');

    sess.ready = (async () => {
      const codec = await codecOf(store, ch);
      const hostIp = await ipOf(store.host);
      const fmt = codec === 'hevc' ? 'hevc' : 'h264';

      const spawnHelper = () => spawn(helper, [
        hostIp, String(store.port || 37777), store.user || 'admin', store.pass || '',
        String(ch), String(startSec), String(endSec), String(maxSec),
      ], {
        env: { ...process.env, PB_DOWNLOAD: dav, LD_LIBRARY_PATH: sdkLib },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      sess.child = spawnHelper();
      sess.child.stderr.on('data', (d) => { sess.lastErr = d.toString().trim().split('\n').pop(); log('[netsdk] helper: ' + sess.lastErr); });
      sess.child.on('exit', (code) => {
        log(`[netsdk] helper thoát ${code}`);
        if (code !== 0 && !sess.retried && /download failed/.test(sess.lastErr || '')) {
          sess.retried = true;
          try { fs.rmSync(dav, { force: true }); } catch {}
          setTimeout(() => { if (!sess.dead) { sess.child = spawnHelper(); sess.child.stderr.on('data', (d) => { sess.lastErr = d.toString().trim().split('\n').pop(); }); sess.child.on('exit', () => { sess.childDone = true; }); } }, 2000);
          return;
        }
        sess.childDone = true;
      });

      const vArgs = codec === 'hevc'
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2',
           '-crf', '24', '-maxrate', '3500k', '-bufsize', '7000k', '-profile:v', 'main',
           '-g', '50', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'copy'];

      sess.ff = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-re', '-f', fmt, '-i', 'pipe:0',
        ...vArgs, '-an',
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
        '-hls_segment_filename', path.join(sess.dir, 'seg%03d.ts'),
        path.join(sess.dir, 'index.m3u8'),
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      sess.ff.stderr.on('data', (d) => { sess.ffErr = d.toString().trim().split('\n').pop(); });
      sess.ff.stdin.on('error', () => { sess.stdinBroken = true; });
      sess.ff.on('exit', (code) => {
        log(`[netsdk] ffmpeg thoát ${code} ${sess.ffErr || ''}`);
        sess.stdinBroken = true;
        try { sess.child.kill('SIGKILL'); } catch {}
        sess.dead = true;
        sessions.delete(sess.key);
        clearInterval(sess.pumpTimer);
        setTimeout(() => { try { fs.rmSync(sess.dir, { recursive: true, force: true }); } catch {} }, 1200).unref();
      });

      // Đọc file .dav đang lớn dần, bóc header, đẩy vào ffmpeg
      const state = { buf: Buffer.alloc(0) };
      let pos = 0;
      let ended = false;

      const endInput = () => {
        if (ended) return;
        ended = true;
        try { sess.ff.stdin.end(); } catch {}
      };

      const pump = () => {
        if (sess.dead || ended) return;
        // ffmpeg đọc 1×; nếu bộ đệm stdin còn nhiều thì tạm dừng đọc file
        if (sess.ff.stdin.writableLength > 4 * 1024 * 1024) return;
        let fd;
        try { fd = fs.openSync(dav, 'r'); } catch { return; }
        try {
          const size = fs.fstatSync(fd).size;
          if (size > pos) {
            const len = size - pos;
            const buf = Buffer.allocUnsafe(len);
            const n = fs.readSync(fd, buf, 0, len, pos);
            pos += n;
            const out = strip(buf.subarray(0, n), state);
            if (out.length && !sess.stdinBroken && sess.ff.stdin.writable) {
              try { sess.ff.stdin.write(out); } catch { sess.stdinBroken = true; }
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        if (sess.childDone && pos >= (fs.statSync(dav, { throwIfNoEntry: false })?.size || 0)) endInput();
      };

      sess.pumpTimer = setInterval(pump, 120);

      const playlist = path.join(sess.dir, 'index.m3u8');
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        if (sess.dead) return false;
        try {
          const st = fs.statSync(playlist);
          const segs = fs.readdirSync(sess.dir).filter((f) => f.endsWith('.ts')).length;
          if (st.size > 0 && segs >= 4) return true; // có ~5 giây đệm trước khi phát
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      sess.error = sess.lastErr || sess.ffErr || 'Không mở được bản ghi (NetSDK)';
      return false;
    })();

    sess.ready.catch(() => false);
    return sess;
  }

  /** Liệt kê các đoạn có bản ghi trong [startSec, endSec] (giây). */
  function listRecords(store, ch, startSec, endSec) {
    const query = (ftype) => new Promise((resolve) => {
      const proc = spawn(helper, [
        store.host, String(store.port || 37777), store.user || 'admin', store.pass || '',
        String(ch), String(startSec), String(endSec), '5',
      ], {
        env: { ...process.env, PB_LIST: '1', PB_LIST_TYPE: String(ftype), LD_LIBRARY_PATH: sdkLib },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', () => {});
      const done = (v) => { try { resolve(v); } catch { resolve([]); } };
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} done([]); }, 25000);
      proc.on('error', () => { clearTimeout(timer); done([]); });
      proc.on('exit', () => {
        clearTimeout(timer);
        try { done(JSON.parse(out.trim() || '[]')); } catch { done([]); }
      });
    });

    return (async () => {
      const [a, b] = await Promise.all([query(0), query(2)]);
      const all = [...(a || []), ...(b || [])].filter((x) => x && x.e > x.s).sort((x, y) => x.s - y.s);
      const merged = [];
      for (const seg of all) {
        const last = merged[merged.length - 1];
        if (last && seg.s <= last.e + 5) last.e = Math.max(last.e, seg.e);
        else merged.push({ s: seg.s, e: seg.e });
      }
      return merged;
    })();
  }

  function get(store, ch, profile) {
    if (!enabled) return null;
    const key = `${store.id}-${ch}-${profile}`;
    const cur = sessions.get(key);
    if (cur && !cur.dead) { cur.last = Date.now(); return cur; }
    return start(store, ch, profile);
  }

  setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) if (now - s.last > idleMs) kill(s, 'không còn người xem');
  }, 5000).unref();

  return { enabled, get, listRecords, killAll: () => { for (const s of [...sessions.values()]) kill(s, 'tắt'); } };
}

module.exports = { createNetSdk };
