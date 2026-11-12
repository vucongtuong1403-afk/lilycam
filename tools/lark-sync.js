#!/usr/bin/env node
'use strict';
/**
 * Sinh lại 2 tệp ánh xạ cơ sở → Lark:
 *   data/lark-views.json  — tab (view) của từng cơ sở trong bảng "Giám sát tháng"
 *   data/lark-chats.json  — nhóm chat (CƠ SỞ) + cửa hàng trưởng của từng cơ sở
 *
 * Dùng sau khi thêm/đổi cơ sở hoặc tab bên Lark:   node tools/lark-sync.js
 * (server cũng tự đọc bảng "Danh mục trưởng bộ phận" lúc chạy, nên bước này chỉ để
 *  chốt sẵn kết quả và xem báo cáo cơ sở nào còn thiếu.)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/lark.json'), 'utf8'));
const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cameras.json'), 'utf8')).stores;
const DIR_TABLE = cfg.dir_table || 'tbl0QTtu2Ne6UUa9';

// data/lark.json có thể ghi đường dẫn của container (/app/bin/lark-cli) — chạy trên máy
// này thì dùng bin/lark-cli của dự án, hoặc gọi qua docker exec nếu image đang chạy.
// Chạy trên máy này thì lark-cli trong container là chắc chắn nhất (token nằm trong
// ~/.local/share/lark-cli, ngoài sandbox bị "permission denied").
const localCli = path.join(ROOT, 'bin/lark-cli');
let cli;
let prefix = [];
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
if (run('docker', ['inspect', '-f', '{{.State.Running}}', 'lilycam']).stdout.trim() === 'true') {
  cli = 'docker';
  prefix = ['exec', 'lilycam', '/app/bin/lark-cli'];
} else if (cfg.cli && fs.existsSync(cfg.cli)) {
  cli = cfg.cli;
} else if (fs.existsSync(localCli)) {
  cli = localCli;
} else {
  throw new Error('không thấy lark-cli: bật container lilycam hoặc đặt "cli" trong data/lark.json');
}

function lark(args) {
  const r = spawnSync(cli, [...prefix, ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error('lark-cli lỗi: ' + String(r.stderr || r.stdout || '').slice(0, 300));
  return JSON.parse(r.stdout);
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const alnum = (s) => norm(s).replace(/[^a-z0-9]+/g, '');
const PROV = { hn: 'hanoi', hcm: 'hochiminh', dn: 'danang', hp: 'haiphong', tn: 'thainguyen',
  bl: 'baclieu', na: 'nghean', bd: 'binhduong', ct: 'cantho', bn: 'bacninh', th: 'thanhhoa' };
const provKey = (p) => (PROV[p] || p).replace(/[^a-z0-9]+/g, '');
function key(name) {
  const n = norm(name);
  const i = n.lastIndexOf(' - ');
  const addr = alnum(i > 0 ? n.slice(0, i) : n);
  const prov = i > 0 ? provKey(n.slice(i + 3).replace(/[^a-z0-9]+/g, '')) : '';
  return addr + '|' + prov;
}
// tên cơ sở trong cameras.json ↔ tên trong bảng danh mục Lark thường lệch nhau vài chữ
function score(a, b) {
  const x = alnum(a), y = alnum(b);
  if (!x || !y) return 0;
  if (x === y) return 1000;
  let hit = 0;
  for (const w of norm(a).split(' ')) if (w.length > 1 && norm(b).includes(w)) hit += w.length;
  return x.includes(y) || y.includes(x) ? 500 + hit : hit;
}

// ---------- tab (view) ----------
const views = lark(['base', '+view-list', '--base-token', cfg.base_token,
  '--table-id', cfg.table_id, '--format', 'json', '--as', 'user']).data.views;
const byKey = new Map();
const byLoose = new Map();
for (const v of views) { byKey.set(key(v.name), v.id); byLoose.set(alnum(v.name), v.id); }
const OVERRIDE = { '116a': 'vewiP5Rfez' };
const viewMap = {};
const missingView = [];
for (const s of stores) {
  const plain = String(s.name).replace(/\([^)]*\)/g, ' ').trim();
  const id = OVERRIDE[String(s.id).toLowerCase()]
    || byKey.get(key(s.name)) || byKey.get(key(plain))
    || byLoose.get(alnum(s.name)) || byLoose.get(alnum(plain)) || null;
  if (id) viewMap[s.id] = id; else missingView.push(s.name);
}
const fallback = (views.find((v) => /tổng hợp/i.test(v.name)) || {}).id || views[0].id;
fs.writeFileSync(path.join(ROOT, 'data/lark-views.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), fallback, views: viewMap }, null, 1) + '\n');

// ---------- nhóm chat + cửa hàng trưởng ----------
// +record-list trả về mảng giá trị + mảng tên cột, phải ghép lại theo tên
const dirRes = lark(['base', '+record-list', '--base-token', cfg.base_token, '--table-id', DIR_TABLE,
  '--limit', '200', '--format', 'json', '--as', 'user']).data;
const col = (n) => dirRes.fields.indexOf(n);
const iName = col('Tên cơ sở');
const iChat = col('chat_id');
const iOwner = col('Account đã được cấp quyền xử lý');
const dirList = dirRes.data.map((row) => ({
  name: String(row[iName] ?? ''),
  chat: String(row[iChat] ?? ''),
  people: (row[iOwner] || []).map((a) => ({ id: a.id, name: String(a.name || '') })),
})).filter((r) => r.name && r.name !== 'null' && r.chat && r.chat !== 'null');

// cửa hàng trưởng từ dự án 5S (nguồn chắc nhất khi có)
const chtByStore = new Map();
for (const s of JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stores.json'), 'utf8'))) {
  if (s.cht_id) chtByStore.set(alnum(s.ten), s.cht_id);
}
const chtByChat = new Map();
for (const d of dirList) {
  const cht = d.people.find((p) => /(^|[^a-z])cht([^a-z]|$)/i.test(norm(p.name)));
  const pick = cht || d.people[0];
  if (pick) chtByChat.set(d.chat, pick.id);
}
// Ba cơ sở không có dòng trong bảng danh mục (Lily Home, Kho tổng HCM, 116A) — nhóm chat
// chốt tay theo cột "CƠ SỞ" đang dùng thật trong bảng sự cố.
const CHAT_FIXED = {
  'lily-home': 'oc_cc491948c41ed27db3bcd552186dbfa5',
  'kho-tong-hcm': 'oc_20e2305be2096e9267381a0c62b9f651',
  '116a': 'oc_aaf7a8fbbc26afe04158f28eb81ab8d2',
};
const chats = {};
const cht = {};
const alias = {};
const missingChat = [];
for (const s of stores) {
  if (CHAT_FIXED[s.id]) { chats[s.id] = CHAT_FIXED[s.id]; continue; }
  let best = null;
  let bestScore = 0;
  for (const d of dirList) {
    const sc = score(s.name, d.name);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  if (!best || bestScore < 5) { missingChat.push(s.name); continue; }
  chats[s.id] = best.chat;
  if (norm(best.name) !== norm(s.name)) alias[s.id] = best.name;
  const c = chtByStore.get(alnum(s.name)) || chtByChat.get(best.chat);
  if (c) cht[s.id] = c;
}
fs.writeFileSync(path.join(ROOT, 'data/lark-chats.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), chats, cht, alias }, null, 1) + '\n');

console.log('data/lark-views.json —', Object.keys(viewMap).length + '/' + stores.length, 'cơ sở có tab riêng');
console.log('data/lark-chats.json —', Object.keys(chats).length + '/' + stores.length, 'cơ sở có nhóm chat,',
  Object.keys(cht).length, 'có người chịu trách nhiệm');
if (missingView.length) console.log('Chưa có tab (dùng "' + views.find((v) => v.id === fallback).name + '"):', missingView.join(' | '));
if (missingChat.length) console.log('Chưa khớp nhóm chat:', missingChat.join(' | '));
