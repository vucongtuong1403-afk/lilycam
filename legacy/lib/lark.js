'use strict';
/**
 * Gửi ảnh chụp từ camera sang Lark Base "Giám sát tháng".
 *
 * Không dùng OpenAPI trực tiếp vì app nội bộ chưa được cấp quyền bitable;
 * ở đây gọi lark-cli (đăng nhập bằng tài khoản người dùng) giống công cụ 5S:
 *   1. base +record-batch-create  -> tạo 1 dòng mới
 *   2. base +record-upload-attachment -> đính ảnh vào trường "HÌNH ẢNH SỰ CỐ"
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Tuần trong tháng — tính theo tháng chứa thứ Năm của tuần đó (giống 5s-check). */
function weekOfMonth(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const monday = new Date(x);
  monday.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  const thu = new Date(monday);
  thu.setDate(monday.getDate() + 3);
  return Math.floor((thu.getDate() - 1) / 7) + 1;
}

function isoLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function envFor(cli) {
  const env = { ...process.env };
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  env.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`;
  env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  return env;
}

function run(cli, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cli, args, { env: envFor(cli), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish({ ok: false, error: 'lark-cli quá thời gian chờ' }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => finish({ ok: false, error: e.message }));
    p.on('exit', (code) => {
      let json = null;
      // lark-cli in JSON ra stdout khi thành công, ra stderr khi lỗi
      for (const t of [out.trim(), err.trim()]) {
        if (!t || json) continue;
        try { json = JSON.parse(t); } catch {
          const i = t.lastIndexOf('{');
          if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch {} }
        }
      }
      if (json && json.ok === true) return finish({ ok: true, data: json });
      if (code === 0 && json) return finish({ ok: true, data: json });
      const e = json && json.error;
      const msg = (e && (e.message || e.subtype))
        || (e && JSON.stringify(e).slice(0, 240))
        || err.trim().split('\n').filter(Boolean).pop()
        || ('lark-cli thoát mã ' + code);
      const sub = (e && (e.subtype || '')) + ' ' + (e && (e.message || ''));
      finish({ ok: false, error: String(msg).slice(0, 300), needAuth: /author|token_missing|token_revoked/i.test(sub) });
    });
  });
}

function create(config) {
  const cli = config && config.cli;
  const enabled = !!(cli && fs.existsSync(cli) && config.base_token && config.table_id);
  const env = envFor(cli || '');

  /** Tạo 1 dòng trong "Giám sát tháng" rồi đính ảnh vào trường ảnh. */
  async function submitCapture({ storeName, chatId, ch, file, viewId = null, category = '', item = '', desc = '', at = new Date() }) {
    if (!enabled) return { ok: false, error: 'Chưa cấu hình Lark (data/lark.json)' };
    const week = weekOfMonth(at);
    const fields = {};
    const f = config.fields || {};
    if (f.week) fields[f.week] = [`Tuần ${week}`];
    if (f.time) fields[f.time] = isoLocal(at);
    if (f.store && chatId) fields[f.store] = [{ id: chatId }];
    if (f.description) fields[f.description] = desc || `CAM ${ch}`;
    if (f.category && category) fields[f.category] = [category];
    if (f.item && item) fields[f.item] = [item];
    if (f.sent) fields[f.sent] = true; // đánh dấu "Đã gửi sự cố"

    const payloadFile = path.join(os.tmpdir(), `lilycam-lark-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify({ create_records: [fields] }, null, 1));
    let res;
    try {
      res = await run(cli, ['base', '+record-batch-create', '--base-token', config.base_token,
        '--table-id', config.table_id, '--json', '@' + payloadFile, '--as', 'user'], 90000);
    } finally {
      try { fs.rmSync(payloadFile, { force: true }); } catch {}
    }
    if (!res.ok) return { ok: false, error: res.error, needAuth: res.needAuth, week };

    const list = (res.data && res.data.data && res.data.data.record_id_list) || [];
    const recordId = list[0];
    if (!recordId) return { ok: false, error: 'Lark không trả về record_id', week };

    let attach = { ok: true };
    if (config.photo_field) {
      attach = await run(cli, ['base', '+record-upload-attachment', '--base-token', config.base_token,
        '--table-id', config.table_id, '--record-id', recordId,
        '--field-id', config.photo_field, '--file', file, '--as', 'user'], 120000);
    }
    return {
      ok: attach.ok,
      week,
      recordId,
      // mặc định mở thẳng tab (view) để gõ trực tiếp trên bảng; 'record' thì mở chi tiết bản ghi
      url: recordUrl(config.open === 'record' ? recordId : null, viewId),
      error: attach.ok ? null : attach.error,
    };
  }

  function recordUrl(recordId, viewId) {
    const base = (config.base_url || '').replace(/\/+$/, '');
    if (!base) return null;
    const q = [];
    if (config.table_id) q.push('table=' + encodeURIComponent(config.table_id));
    if (viewId) q.push('view=' + encodeURIComponent(viewId));
    if (recordId) q.push('record=' + encodeURIComponent(recordId));
    return base + (q.length ? '?' + q.join('&') : '');
  }

  return { enabled, submitCapture, recordUrl, weekOfMonth, isoLocal, execCli: run };
}

module.exports = { create, weekOfMonth, isoLocal };
