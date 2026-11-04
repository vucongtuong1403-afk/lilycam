#!/usr/bin/env node
'use strict';
/**
 * Sinh lại data/lark-views.json: gán mỗi cơ sở trong data/cameras.json sang tab (view)
 * tương ứng của bảng "Giám sát tháng", để nút Chụp ảnh mở thẳng đúng tab của cửa hàng.
 *
 * Dùng sau khi thêm/đổi tab bên Lark:   node tools/lark-views.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/lark.json'), 'utf8'));
const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cameras.json'), 'utf8')).stores;

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

const r = spawnSync(cfg.cli, ['base', '+view-list', '--base-token', cfg.base_token,
  '--table-id', cfg.table_id, '--format', 'json'], { encoding: 'utf8', timeout: 90000 });
if (r.status !== 0) {
  console.error('lark-cli lỗi:', (r.stderr || r.stdout || '').slice(0, 300));
  process.exit(1);
}
const views = JSON.parse(r.stdout).data.views;
const byKey = new Map();
const byLoose = new Map();
for (const v of views) { byKey.set(key(v.name), v.id); byLoose.set(alnum(v.name), v.id); }

const OVERRIDE = { '116a': 'vewiP5Rfez' };
const map = {};
const missing = [];
for (const s of stores) {
  const plain = String(s.name).replace(/\([^)]*\)/g, ' ').trim();
  const id = OVERRIDE[String(s.id).toLowerCase()]
    || byKey.get(key(s.name)) || byKey.get(key(plain))
    || byLoose.get(alnum(s.name)) || byLoose.get(alnum(plain)) || null;
  if (id) map[s.id] = id; else missing.push(s.name);
}
const fallback = (views.find((v) => /tổng hợp/i.test(v.name)) || {}).id || views[0].id;
fs.writeFileSync(path.join(ROOT, 'data/lark-views.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), fallback, views: map }, null, 1) + '\n');

console.log('Đã ghi data/lark-views.json —', Object.keys(map).length + '/' + stores.length, 'cơ sở có tab riêng.');
if (missing.length) console.log('Chưa có tab (dùng "' + views.find((v) => v.id === fallback).name + '"):', missing.join(' | '));
