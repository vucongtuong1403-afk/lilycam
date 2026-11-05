'use strict';
/** Cache phân giải DDNS → IP (5 phút) để mỗi kết nối không phải chờ DNS ~250ms. */
const dns = require('dns').promises;
const cache = new Map();
const TTL = 5 * 60e3;

async function ipOf(host) {
  if (!host) return host;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.t < TTL) return hit.ip;
  try {
    const r = await dns.lookup(host, { family: 4 });
    cache.set(host, { ip: r.address, t: Date.now() });
    return r.address;
  } catch {
    return host; // không phân giải được thì để nguyên tên miền
  }
}

function clear(host) { cache.delete(host); }

module.exports = { ipOf, clear };
