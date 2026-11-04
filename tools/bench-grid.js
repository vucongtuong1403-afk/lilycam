// Đo tải khi mở N ô lưới: thời điểm có segment đầu, lỗi, CPU, băng thông.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [ff, host, user, pass, channelsCsv, subtype, vf, rate, label, ms] = process.argv.slice(2);
const channels = channelsCsv.split(',').map(Number);
const dur = Number(ms || 20000);
const HZ = 100;

function cpuTicks(pid) {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(' ');
    return Number(s[13]) + Number(s[14]);
  } catch { return 0; }
}

(async () => {
  const dirs = [], procs = [], stats = [];
  const t0 = Date.now();
  for (const ch of channels) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-' + ch + '-'));
    dirs.push(dir);
    const url = `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:554/cam/realmonitor?channel=${ch}&subtype=${subtype}`;
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000',
      '-flags', 'low_delay', '-i', url,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-vf', vf,
      '-crf', '26', '-maxrate', rate, '-bufsize', `${parseInt(rate) * 2}k`, '-profile:v', 'main',
      '-g', '10', '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-pix_fmt', 'yuv420p', '-an',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '4',
      '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
      '-hls_segment_filename', path.join(dir, 'seg%03d.ts'), path.join(dir, 'index.m3u8')],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const st = { ch, first: null, errs: 0, pid: p.pid, ticks0: 0 };
    stats.push(st);
    procs.push(p);
    st.ticks0 = cpuTicks(p.pid);
    p.stderr.on('data', (d) => { st.errs += (d.toString().match(/Error|error/g) || []).length; });
    const iv = setInterval(() => {
      if (st.first === null && fs.existsSync(path.join(dir, 'index.m3u8')) && fs.readdirSync(dir).some((f) => f.endsWith('.ts'))) {
        st.first = Date.now() - t0; clearInterval(iv);
      }
    }, 100);
    st.iv = iv;
  }
  await new Promise((r) => setTimeout(r, dur));
  const ticks = stats.map((s) => cpuTicks(s.pid) - s.ticks0);
  const cpuSec = ticks.reduce((a, b) => a + b, 0) / HZ;
  let bytes = 0;
  for (const d of dirs) { try { for (const f of fs.readdirSync(d)) bytes += fs.statSync(path.join(d, f)).size; } catch {} }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const s of stats) clearInterval(s.iv);
  await new Promise((r) => setTimeout(r, 300));
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  const firsts = stats.map((s) => s.first).filter((x) => x !== null);
  const errs = stats.reduce((a, s) => a + s.errs, 0);
  console.log(JSON.stringify({
    label, sessions: channels.length, firstSegMs: firsts.sort((a, b) => a - b),
    maxFirstSegMs: firsts.length ? Math.max(...firsts) : null,
    failed: channels.length - firsts.length, errLines: errs,
    cpuCores: Math.round(cpuSec / (dur / 1000) * 100) / 100,
    outKB: Math.round(bytes / 1024),
  }));
})();
