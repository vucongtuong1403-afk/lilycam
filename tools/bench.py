#!/usr/bin/env python3
"""Đo hiệu năng thực tế của toàn bộ hệ thống camera.

- DNS / TCP 554 / TCP 37777 / snapshot HTTP (cho mọi cơ sở có địa chỉ)
- Thời gian mở luồng HD (một mẫu đại diện) qua API của LilyCam
- Lưu kết quả vào docs/bench.json và in bảng tóm tắt

Dùng:  python3 tools/bench.py [--hd 8] [--port 8790]
"""
import json, socket, subprocess, sys, time, statistics, urllib.request, argparse
from concurrent.futures import ThreadPoolExecutor

ROOT = '/'.join(__file__.split('/')[:-2])
DATA = ROOT + '/data/cameras.json'


def dns_time(host):
    t = time.time()
    try:
        socket.getaddrinfo(host, None)
        return (time.time() - t) * 1000
    except Exception:
        return None


def tcp_time(host, port, timeout=4):
    t = time.time()
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return (time.time() - t) * 1000
    except Exception:
        return None
    finally:
        s.close()


def snapshot(store, ch=1):
    url = f"http://{store['host']}:{store['port']}/cgi-bin/snapshot.cgi?channel={ch}"
    t = time.time()
    try:
        r = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
                            '--max-time', '8', '--digest', '-u',
                            f"{store.get('user') or 'admin'}:{store.get('pass') or ''}", url],
                           capture_output=True, text=True, timeout=12)
        code, size = (r.stdout.strip().split() + ['0', '0'])[:2]
        return code, (time.time() - t) * 1000, int(size)
    except Exception:
        return '000', (time.time() - t) * 1000, 0


def hd_ready(base, token, store, ch=1, timeout=30):
    url = f"{base}/hls/hd/{store['id']}/{ch}/index.m3u8"
    req = urllib.request.Request(url)
    req.add_header('Cookie', 'lilycam_sid=' + token)
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(64)
            return r.status, (time.time() - t) * 1000
    except Exception as e:
        return getattr(e, 'code', 'ERR'), (time.time() - t) * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='8790')
    ap.add_argument('--hd', type=int, default=8, help='số cơ sở đo mở HD')
    ap.add_argument('--token', required=True)
    args = ap.parse_args()
    base = f'http://127.0.0.1:{args.port}'

    data = json.load(open(DATA))
    stores = [s for s in data['stores'] if s.get('host')]

    rows = []

    def probe(s):
        d = dns_time(s['host'])
        p554 = tcp_time(s['host'], 554)
        p377 = tcp_time(s['host'], 37777)
        code, ms, size = snapshot(s)
        return {
            'id': s['id'], 'name': s['name'], 'host': s['host'], 'port': s['port'],
            'dns_ms': round(d) if d else None,
            'tcp554_ms': round(p554) if p554 else None,
            'tcp37777_ms': round(p377) if p377 else None,
            'snap_code': code, 'snap_ms': round(ms), 'snap_kb': round(size / 1024, 1),
        }

    with ThreadPoolExecutor(max_workers=6) as ex:
        for r in ex.map(probe, stores):
            rows.append(r)
            print(f"{r['name'][:34]:36} dns={str(r['dns_ms']):>5} 554={str(r['tcp554_ms']):>5} "
                  f"snap={r['snap_code']} {r['snap_ms']:>5}ms {r['snap_kb']:>6}KB", flush=True)

    # đo mở HD trên vài cơ sở (ưu tiên cơ sở đang phản hồi)
    alive = [r for r in rows if r['snap_code'] == '200']
    alive.sort(key=lambda r: r['snap_ms'])
    hd = []
    for r in alive[: args.hd]:
        s = next(x for x in stores if x['id'] == r['id'])
        code, ms = hd_ready(base, args.token, s, 1)
        hd.append({'id': s['id'], 'name': s['name'], 'code': code, 'ms': round(ms)})
        print(f"HD {s['name'][:30]:32} {code} {ms:>7.0f}ms", flush=True)

    out = {'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'stores': rows, 'hd': hd}
    json.dump(out, open(ROOT + '/docs/bench.json', 'w'), ensure_ascii=False, indent=1)

    ok = [r for r in rows if r['snap_code'] == '200']
    print('\n=== TÓM TẮT ===')
    print(f"cơ sở có địa chỉ: {len(rows)}, phản hồi: {len(ok)}")
    for key in ('dns_ms', 'tcp554_ms', 'snap_ms'):
        vals = [r[key] for r in ok if r[key]]
        if vals:
            vals.sort()
            print(f"{key:10} min={vals[0]:.0f}  med={statistics.median(vals):.0f}  p90={vals[int(len(vals)*0.9)-1]:.0f}  max={vals[-1]:.0f}")


if __name__ == '__main__':
    main()
