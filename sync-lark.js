'use strict';
/**
 * Đồng bộ danh sách cơ sở + số camera từ Lark Base "List camera Lily".
 *
 *   node sync-lark.js
 *
 * - Chỉ cập nhật tên / đơn vị / số camera / gói cước / SN / số hợp đồng.
 * - Giữ nguyên host, cổng và mật khẩu đang lưu trong data/cameras.json
 *   (vì các giá trị đó đã được kiểm tra thực tế và có thể đã sửa tay trong web).
 * - Cơ sở mới (chưa có trong file) sẽ lấy host/mật khẩu từ bảng Lark.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const FILE = path.join(DATA, 'cameras.json');
const SOURCE = JSON.parse(fs.readFileSync(path.join(DATA, 'source.json'), 'utf8'));

const CLI = process.env.LARK_CLI || SOURCE.cli || 'lark-cli';

function lark(args) {
  const out = execFileSync(CLI, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function main() {
  console.log('→ Đọc bảng Lark:', SOURCE.baseToken, SOURCE.tableId);
  const res = lark([
    'base', '+record-list',
    '--base-token', SOURCE.baseToken,
    '--table-id', SOURCE.tableId,
    '--limit', '200',
    '--format', 'json',
  ]);
  if (!res.ok) throw new Error('Lark trả lỗi: ' + JSON.stringify(res.error));
  const d = res.data;
  const rows = d.data.map((r) => Object.fromEntries(d.fields.map((f, i) => [f, r[i]])));

  const current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const byName = new Map(current.stores.map((s) => [s.name, s]));

  const slug = (s) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

  const hostFrom = (val) => {
    if (!val) return { host: null, port: null };
    const m = String(val).match(/\]\((https?:\/\/[^)]+)\)/);
    const url = m ? m[1] : String(val).trim();
    try {
      const u = new URL(url.includes('://') ? url : 'http://' + url);
      return { host: u.hostname, port: u.port ? Number(u.port) : null };
    } catch {
      return { host: null, port: null };
    }
  };

  let added = 0;
  for (const r of rows) {
    const name = (r['Bộ phận'] || '').trim();
    if (!name) continue;
    const n = Number(r['Số lượng camera của cơ sở']) || null;
    const existing = byName.get(name);
    if (existing) {
      existing.unit = r['Đơn vị'] || existing.unit;
      existing.cameras = n || existing.cameras;
      existing.plan = r['Gói cước'] || existing.plan;
      existing.sn = r['SN'] || existing.sn;
      existing.contract = r['Số Hợp Đồng'] || existing.contract;
      continue;
    }
    const { host, port } = hostFrom(r['IP/Domain Name']);
    const pass = r['Mật khẩu'] && r['Mật khẩu'] !== 'Ko đc quyền tra cứu'
      ? r['Mật khẩu']
      : (r['Password'] || null);
    let id = slug(name);
    while (current.stores.some((s) => s.id === id)) id += '-2';
    current.stores.push({
      id, name, unit: r['Đơn vị'] || 'Cửa hàng',
      host, port: port || (Number(r['Port (Web)']) || 80),
      user: r['User Name'] || 'admin', pass,
      cameras: n || 8, plan: r['Gói cước'], type: r['Phân loại'],
      sn: r['SN'], contract: r['Số Hợp Đồng'], verified: false,
    });
    added++;
  }

  current.updatedAt = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  console.log(`✓ Đã đồng bộ ${rows.length} dòng — thêm mới ${added} cơ sở.`);
  console.log('  Khởi động lại server để áp dụng.');
}

main();
