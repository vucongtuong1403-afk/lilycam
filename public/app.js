'use strict';
/* LilyCam — giao diện */

const state = {
  stores: [],
  meta: {},
  currentId: null,
  unit: 'all',
  query: '',
  layout: (() => { const v = Number(localStorage.getItem('lilycam.layout')); return [2, 4, 6, 8, 10].includes(v) ? v : 4; })(),
  page: 0,
  viewer: { id: null, ch: 1, fallback: null, closing: false, lightFor: null },
  quality: (() => { try { return localStorage.getItem('lilycam.quality') || 'hd'; } catch { return 'hd'; } })(),
  hd: false,
  raw: (() => { try { return localStorage.getItem('lilycam.raw') === '1'; } catch { return false; } })(),
  codecs: {},
  soundOn: false,
  // mặc định VỪA KHUNG (thấy đủ hình); chỉ bật "đầy khung" khi người dùng chọn
  fill: (() => { try { return localStorage.getItem('lilycam.fitmode') === 'fill'; } catch { return false; } })(),
  playback: null, // mốc thời gian đang xem lại (ms)
  pbDay: null,    // đầu ngày (ms) đang hiển thị trên timeline
  pbSegs: [],     // các đoạn có bản ghi trong ngày
  pbT0: 0,        // thời điểm bắt đầu phát (để chạy con trỏ)
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ------------------------------------------------------------------ */
/* Gọi API                                                             */
/* ------------------------------------------------------------------ */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  if (res.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error('Chưa đăng nhập');
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('Lỗi máy chủ (' + res.status + ')');
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Lỗi (' + res.status + ')');
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ------------------------------------------------------------------ */
/* Đăng nhập                                                           */
/* ------------------------------------------------------------------ */
function showLogin() {
  stopTiles();
  closeViewer();
  $('#app').hidden = true;
  $('#auth').hidden = false;
  setTimeout(() => $('#loginForm input[name="password"]')?.focus(), 60);
}

function showApp(user) {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#userName').textContent = user;
  $('#avatar').textContent = user.slice(0, 1).toUpperCase();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type="submit"]');
  $('#loginError').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Đang đăng nhập…';
  try {
    const d = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: f.get('username'), password: f.get('password') }),
    });
    e.target.querySelector('input[name="password"]').value = '';
    showApp(d.user);
    await loadStores();
    // chỉ mở khi có link trỏ đúng cơ sở; không tự mở cơ sở đầu tiên để camera "ngủ" khi chưa ai xem
    const hashId = decodeURIComponent(location.hash.slice(1));
    const pick = state.stores.find((s) => s.id === hashId);
    if (pick) selectStore(pick.id);
    else showEmpty();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Đăng nhập';
  }
});

/* ------------------------------------------------------------------ */
/* Nạp dữ liệu                                                         */
/* ------------------------------------------------------------------ */
async function loadStores() {
  const d = await api('/api/stores');
  state.stores = d.stores;
  state.meta = { updatedAt: d.updatedAt, source: d.source };
  state.hd = !!d.hd;
  state.quality = 'hd';
  renderStores();
  if (state.currentId && state.stores.some((s) => s.id === state.currentId)) {
    selectStore(state.currentId, true);
  }
}

function dotClass(s) {
  if (s.online === true) return 'ok';
  if (s.online === false) return 'bad';
  return 'unknown';
}

function renderStores() {
  const list = $('#storeList');
  list.textContent = '';
  const q = state.query.trim().toLowerCase();
  const items = state.stores
    .filter((s) => state.unit === 'all' || s.unit === state.unit)
    .filter((s) => !q || (s.name + ' ' + s.unit).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

  for (const s of items) {
    const li = el('li', 'store-item' + (s.id === state.currentId ? ' is-active' : ''));
    li.tabIndex = 0;
    li.dataset.id = s.id;
    const dot = el('span', 'st-dot ' + dotClass(s));
    const main = el('div', 'st-main');
    main.append(el('div', 'st-name', s.name));
    const sub = el('div', 'st-sub');
    sub.append(el('span', null, s.unit));
    if (s.note) sub.append(el('span', null, '•'));
    main.append(sub);
    const cnt = el('span', 'st-count', String(s.cameras || '—'));
    li.append(dot, main, cnt);
    li.addEventListener('click', () => selectStore(s.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStore(s.id); }
    });
    list.append(li);
  }

  $('#storeCount').textContent = items.length + ' cơ sở';
  const online = state.stores.filter((s) => s.online === true).length;
  const bad = state.stores.filter((s) => s.online === false).length;
  $('#onlineCount').textContent = online || bad ? `${online} online · ${bad} lỗi` : '';

  if (!items.length) {
    $('#storeList').append(el('li', 'store-item', 'Không tìm thấy cơ sở phù hợp'));
  }
}

/* ------------------------------------------------------------------ */
/* Chọn cơ sở                                                          */
/* ------------------------------------------------------------------ */
function selectStore(id, keepScroll = false) {
  const s = state.stores.find((x) => x.id === id);
  if (!s) return;
  if (state.currentId !== id) state.page = 0;
  state.currentId = id;
  $('#emptyState').hidden = true;
  $('#storeView').hidden = false;
  $('#sidebar').classList.remove('open');

  $('#storeName').textContent = s.name;
  $('#storeUnit').textContent = s.unit;
  $('#storeCamCount').textContent = s.cameras ? `${s.cameras} camera` : 'chưa rõ số camera';
  const st = $('#storeStatus');
  st.className = 'status-text ' + (s.online === true ? 'ok' : s.online === false ? 'bad' : '');
  st.textContent = s.online === true ? 'Đang kết nối' : s.online === false ? 'Mất kết nối' : 'Chưa kiểm tra';
  $('#dvrLink').href = '/api/dvr/' + encodeURIComponent(s.id);

  const panel = $('#offlinePanel');
  panel.hidden = s.online !== false;
  $('#offlineMsg').textContent = s.note
    || 'Kiểm tra DDNS / cổng forward, hoặc cập nhật lại địa chỉ trong nút bút chì.';

  renderStores();
  updateRawButton();
  if (state.codecs[s.id] === undefined) ensureCodec(s.id);
  renderGrid(s);
  if (!keepScroll) $('#content').scrollTop = 0;
  history.replaceState(null, '', '#' + encodeURIComponent(s.id));
}

/* ------------------------------------------------------------------ */
/* Lưới camera                                                         */
/* ------------------------------------------------------------------ */
const tiles = new Map(); // ch -> { hls, video, sndBtn, timer }
const posterCache = new Map(); // `${storeId}:${ch}` -> { url, t }  khung cuối của ô lưới
let tileGen = 0;
let tileStartTimers = [];

const SND_ICONS =
  '<svg class="ic-off" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4v-5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m16 9.5 4 5m0-5-4 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
  '<svg class="ic-on" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4v-5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.8a7.5 7.5 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function muteAllTiles(exceptCh) {
  for (const [c, t] of tiles) {
    if (c === exceptCh) continue;
    t.video.muted = true;
    t.sndBtn?.classList.remove('is-on');
  }
}

function toggleTileSound(ch, video, btn) {
  if (!video.muted) {
    video.muted = true;
    btn.classList.remove('is-on');
    return;
  }
  muteAllTiles(ch);
  video.muted = false;
  btn.classList.add('is-on');
  video.play().catch(() => {});
  setTimeout(() => {
    if (video.muted) return;
    if (typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount === 0) {
      video.muted = true;
      btn.classList.remove('is-on');
      toast('Camera này không có âm thanh', true);
    }
  }, 3000);
}


function hlsProfile() {
  const s = state.stores.find((x) => x.id === state.currentId);
  const codec = s ? state.codecs[s.id] : null;
  return state.raw && codec === 'h264' ? 'raw' : `g${state.layout}`;
}

async function ensureCodec(id) {
  if (state.codecs[id] !== undefined) return state.codecs[id];
  state.codecs[id] = null; // đánh dấu đang dò
  try {
    const r = await api('/api/codec/' + encodeURIComponent(id));
    state.codecs[id] = r.codec || 'unknown';
  } catch {
    state.codecs[id] = 'unknown';
  }
  updateRawButton();
  if (state.codecs[id] !== 'h264' && state.raw) {
    state.raw = false;
    try { localStorage.setItem('lilycam.raw', '0'); } catch {}
    updateRawButton();
    const cur = state.stores.find((x) => x.id === state.currentId);
    if (cur && cur.id === id) renderGrid(cur);
  }
  return state.codecs[id];
}

function updateRawButton() {
  const btn = $('#rawToggle');
  if (!btn) return;
  const s = state.stores.find((x) => x.id === state.currentId);
  const codec = s ? state.codecs[s.id] : null;
  const blocked = codec && codec !== 'h264';
  btn.disabled = !!blocked;
  btn.classList.toggle('is-active', state.raw && !blocked);
  btn.title = blocked
    ? 'Đầu ghi dùng HEVC — không xem trực tiếp luồng gốc được (trình duyệt không giải mã HEVC)'
    : 'Xem luồng gốc, không qua xử lý (nhẹ CPU, nặng mạng hơn)';
}

function stopTiles() {
  tileGen++;
  for (const t of tileStartTimers) clearTimeout(t);
  tileStartTimers = [];
  for (const t of tiles.values()) {
    clearTimeout(t.timer);
    try { t.hls && t.hls.destroy(); } catch {}
    try { t.video && t.video.pause(); } catch {}
  }
  tiles.clear();
}

function tileError(thumb, msg) {
  thumb.querySelector('.spinner')?.remove();
  if (!thumb.querySelector('.cam-err')) thumb.append(el('div', 'cam-err', msg || 'Không có tín hiệu'));
}

function startTile(s, ch, thumb, video) {
  const url = `/hls/${hlsProfile()}/${encodeURIComponent(s.id)}/${ch}/index.m3u8`;
  let attempt = 0;
  let inst = null;
  let started = false;
  const gen = tileGen;

  if (!(window.Hls && Hls.isSupported())) {
    video.src = url;
    video.play().catch(() => {});
    return;
  }

  const cleanup = () => {
    if (inst) { try { inst.destroy(); } catch {} }
    inst = null;
  };

  const fail = (msg, canRetry) => {
    if (gen !== tileGen) return;
    const cur = inst;
    cleanup();
    if (canRetry && attempt < 3) {
      setTimeout(() => { if (gen === tileGen) spin(); }, 2500);
      return;
    }
    if (tiles.get(ch)?.hls === cur) tiles.delete(ch);
    tileError(thumb, msg || 'Không có tín hiệu');
  };

  const spin = () => {
    if (gen !== tileGen) return;
    attempt++;
    cleanup();
    started = false;
    const rec = { hls: null, video, sndBtn: thumb.parentElement.querySelector('.tile-sound'), timer: null };
    tiles.set(ch, rec);

    inst = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 20,
      liveSyncDurationCount: 2,
      // khi tụt lại sau live edge thì tăng tốc nhẹ để bắt kịp thay vì giật/khựng
      maxLiveSyncPlaybackRate: 1.5,
      manifestLoadingTimeOut: 15000,
      fragLoadingTimeOut: 15000,
    });
    rec.hls = inst;

    inst.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    inst.on(Hls.Events.ERROR, (_e, d) => {
      if (gen !== tileGen || tiles.get(ch)?.hls !== inst) return;
      // hoãn destroy ra khỏi callback của hls.js (destroy ngay trong handler gây lỗi "null.trigger")
      if (d && d.fatal) setTimeout(() => fail('Không mở được luồng chính', true), 0);
    });
    inst.loadSource(url);
    inst.attachMedia(video);

    video.addEventListener('playing', () => {
      started = true;
      video.classList.add('is-live');
      thumb.querySelector('.spinner')?.remove();
      updateOnline(s.id, true);
      const pk = `${s.id}:${ch}`;
      const pc = posterCache.get(pk);
      if (!pc || Date.now() - pc.t > 15000) {
        const url = grabFrame(video);
        if (url) posterCache.set(pk, { url, t: Date.now() });
      }
    });

    rec.timer = setTimeout(() => {
      if (gen !== tileGen || started) return;
      fail('Kênh không có tín hiệu', true);
    }, 15000);
  };

  spin();
}

function markOnlineFail(id) {
  const s = state.stores.find((x) => x.id === id);
  if (!s) return;
  s.tileFails = (s.tileFails || 0) + 1;
  if (s.tileFails >= 2 && s.online !== true) {
    s.online = false;
    $('#offlinePanel').hidden = false;
    $('#storeStatus').className = 'status-text bad';
    $('#storeStatus').textContent = 'Mất kết nối';
  }
}

/* Danh sách kênh được phép xem: server trả s.channels khi user bị giới hạn */
function camList(s) {
  if (Array.isArray(s.channels) && s.channels.length) return s.channels.map(Number);
  const n = Math.max(1, Math.min(64, Number(s.cameras) || 8));
  return Array.from({ length: n }, (_, i) => i + 1);
}

function renderGrid(s) {
  stopTiles();
  const grid = $('#camGrid');
  grid.textContent = '';
  grid.dataset.layout = String(state.layout);

  const list = camList(s);
  const n = list.length;
  const per = state.layout;
  const pages = Math.max(1, Math.ceil(n / per));
  if (state.page > pages - 1) state.page = 0;
  const from = state.page * per;
  const to = Math.min(n, state.page * per + per);
  let votesP = 0;
  let votesL = 0;
  let votes = 0;

  for (let idx = from; idx < to; idx++) {
    const ch = list[idx];
    const card = el('div', 'cam-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Xem CAM ${ch}`);

    const thumb = el('div', 'cam-thumb');
    const spin = el('div', 'spinner');
    spin.append(el('span', 'spin-text', 'Đang kết nối…'));
    const video = document.createElement('video');
    // hiện ngay khung hình gần nhất (ảnh tĩnh) trong lúc chờ HLS — cảm giác mở tức thì
    const cached = posterCache.get(`${s.id}:${ch}`);
    video.poster = cached ? cached.url : `/api/snap/${encodeURIComponent(s.id)}/${ch}?fast=1&t=${Date.now()}`;
    video.classList.add('has-poster');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    video.addEventListener('loadedmetadata', () => {
      if (!video.videoWidth) return;
      if (video.videoHeight > video.videoWidth * 1.05) votesP++;
      else votesL++;
      votes++;
      // đa số camera dọc thì xoay lưới; cập nhật dần khi thêm camera vào hình
      if (votes <= 4) {
        grid.classList.toggle('is-portrait', votesP > votesL);
        fitGrid();
      }
    }, { once: true });
    const badge = el('span', 'cam-badge');
    badge.append(el('span', null, 'CAM ' + ch), el('i', 'cam-dot'));
    thumb.append(spin, video, badge);
    const live = el('span', 'cam-live');
    live.append(el('span', 'live-dot'), el('span', null, 'PHÓNG TO'));
    thumb.append(live);

    const foot = el('div', 'cam-foot');
    const right = el('span', 'foot-right');
    const sndBtn = el('button', 'tile-sound');
    sndBtn.type = 'button';
    sndBtn.title = 'Nghe tiếng camera này';
    sndBtn.innerHTML = SND_ICONS;
    sndBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTileSound(ch, video, sndBtn);
    });
    right.append(sndBtn);
    foot.append(el('span', 'cam-name', 'Camera ' + ch), right);
    card.dataset.snd = '1';

    card.append(thumb, foot);

  // rê chuột 0.5s → làm nóng phiên HD để lúc bấm là có hình ngay
  let warmTimer = null;
  card.addEventListener('pointerenter', () => {
    if (matchMedia('(pointer: coarse)').matches) return;
    warmTimer = setTimeout(() => {
      const key = `${s.id}:${ch}`;
      if (state.warmed && state.warmed[key] && Date.now() - state.warmed[key] < 30000) return;
      state.warmed = state.warmed || {};
      state.warmed[key] = Date.now();
      fetch(`/api/warm/${encodeURIComponent(s.id)}/${ch}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    }, 500);
  });
  card.addEventListener('pointerleave', () => clearTimeout(warmTimer));
    const open = () => openViewer(s.id, ch);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    grid.append(card);

    if (s.online === false) {
      tileError(thumb, 'Không có tín hiệu');
    } else {
      // khởi động so le để không dồn 10 kết nối cùng lúc vào đầu ghi
      const delay = (ch - from) * 180;
      tileStartTimers.push(setTimeout(() => {
        if (state.currentId !== s.id || !grid.contains(card) || !$('#viewer').hidden) return;
        startTile(s, ch, thumb, video);
      }, delay));
    }
  }

  const pager = $('#pager');
  pager.hidden = pages <= 1;
  $('#pageInfo').textContent = `Trang ${state.page + 1}/${pages}`;
  $('#prevPage').disabled = state.page === 0;
  $('#nextPage').disabled = state.page >= pages - 1;

  requestAnimationFrame(fitGrid);
}

let fitTimer = null;

/** Co giãn lưới vừa đúng 1 màn hình (không phải cuộn). */
function fitGrid() {
  const grid = $('#camGrid');
  if (!grid || !grid.children.length) return;
  const content = $('#content');
  const head = document.querySelector('.store-head');
  const pager = $('#pager');
  const used = (head ? head.offsetHeight + 12 : 0) + (pager && !pager.hidden ? pager.offsetHeight + 12 : 0);
  const avail = content.clientHeight - used - 32;
  const rows = Math.max(1, Math.ceil(grid.children.length / (Number(state.layout) || 4)));
  grid.style.height = Math.round(Math.max(130 * rows, avail)) + 'px';
  // chốt lại: nếu vẫn tràn thì bớt đúng phần thừa để không phải cuộn
  const over = content.scrollHeight - content.clientHeight;
  if (over > 0) grid.style.height = Math.max(120 * rows, grid.offsetHeight - over - 2) + 'px';
}

window.addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitGrid, 150);
});

function showEmpty() {
  state.currentId = null;
  stopTiles();
  if ($('#storeView')) $('#storeView').hidden = true;
  if ($('#emptyState')) $('#emptyState').hidden = false;
}

function resumeTiles() {
  if (!state.currentId || document.hidden || !$('#viewer').hidden) return;
  const s = state.stores.find((x) => x.id === state.currentId);
  if (s) renderGrid(s);
}

function updateOnline(id, ok) {
  const s = state.stores.find((x) => x.id === id);
  if (!s) return;
  const next = ok ? true : s.online === true ? s.online : false;
  if (s.online === next) return;
  s.online = next;
  const li = document.querySelector(`.store-item[data-id="${CSS.escape(id)}"] .st-dot`);
  if (li) li.className = 'st-dot ' + dotClass(s);
  if (state.currentId === id) {
    const st = $('#storeStatus');
    st.className = 'status-text ' + (next ? 'ok' : 'bad');
    st.textContent = next ? 'Đang kết nối' : 'Mất kết nối';
  }
  const online = state.stores.filter((x) => x.online === true).length;
  const bad = state.stores.filter((x) => x.online === false).length;
  $('#onlineCount').textContent = online || bad ? `${online} online · ${bad} lỗi` : '';
}

/* ------------------------------------------------------------------ */
/* Trình xem live                                                      */
/* ------------------------------------------------------------------ */
function grabFrame(video) {
  try {
    if (!video || !video.videoWidth) return null;
    const w = 480;
    const h = Math.round(w * video.videoHeight / video.videoWidth);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.65);
  } catch { return null; }
}

function dropPromoted() {
  const p = state.viewer.promoted;
  if (!p) return;
  try { p.rec.hls && p.rec.hls.destroy(); } catch {}
  try { p.rec.video.remove(); } catch {}
  state.viewer.promoted = null;
}

function openViewer(storeId, ch) {
  const s = state.stores.find((x) => x.id === storeId);
  if (!s) return;

  // ô lưới đang phát sẵn → bê nguyên video đó sang cửa sổ xem (hiện hình ngay lập tức)
  const rec = tiles.get(ch);
  let promoted = null;
  if (rec && state.currentId === storeId && rec.video && rec.video.readyState >= 2) {
    promoted = rec;
    tiles.delete(ch);
    clearTimeout(rec.timer);
  }
  // nhường kết nối cho luồng phóng to: tắt lưới ở client + đóng phiên ffmpeg lưới ở server
  stopTiles();
  const keepQ = promoted ? `?keep=${ch}` : '';
  const release = fetch(`/api/release/${encodeURIComponent(storeId)}${keepQ}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  state.viewer.id = storeId;
  state.viewer.ch = ch;
  state.playback = null;
  state.soundOn = false;
  const sv = $('#playerVideo');
  if (sv) sv.muted = true;
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';

  if (promoted) {
    dropPromoted();
    promoted.video.classList.add('promoted');
    promoted.video.muted = true;
    promoted.video.hidden = false;
    promoted.video.play().catch(() => {});
    $('#player').appendChild(promoted.video);
    state.viewer.promoted = { ch, rec: promoted };
    const m = $('#playerMsg');
    m.hidden = true;
    m.textContent = '';
  }

  const poster = posterCache.get(`${storeId}:${ch}`);
  const posterEl = $('#posterImg');
  if (!promoted && poster) {
    posterEl.src = poster.url;
    posterEl.hidden = false;
    $('#playerMsg').hidden = true;
  } else if (!promoted) {
    posterEl.hidden = true;
  }

  // chờ tối đa 300ms để server đóng phiên lưới, giúp đầu ghi nhận kết nối mới nhanh hơn
  Promise.race([release, new Promise((r) => setTimeout(r, 300))]).then(() => {
    if (state.viewer.id === storeId) renderViewer();
  });
}

let hlsPlayer = null;
let hdTimer = null;

function stopPlayback() {
  clearTimeout(hdTimer);
  clearInterval(state.pbTimer);
  state.pbTimer = null;
  hdTimer = null;
  if (hlsPlayer) {
    try { hlsPlayer.destroy(); } catch {}
    hlsPlayer = null;
  }
  const v = $('#playerVideo');
  v.muted = true;
  $('#soundBtn')?.classList.remove('is-on');
  try { v.pause(); } catch {}
  v.removeAttribute('src');
  try { v.load(); } catch {}
  v.hidden = true;
  v.muted = true;
  $('#playerImg').hidden = false;
}

function applySound() {
  const v = $('#playerVideo');
  v.muted = !state.soundOn;
  v.volume = 1;
  const btn = $('#soundBtn');
  btn.classList.toggle('is-on', state.soundOn);
  btn.setAttribute('aria-pressed', String(state.soundOn));
  if (state.soundOn) v.play().catch(() => {});
}

function toggleSound() {
  if (state.quality !== 'hd') {
    setQuality('hd');
    state.soundOn = true;
    renderViewer();
    return;
  }
  state.soundOn = !state.soundOn;
  applySound();
}

let audioTimer = null;

function checkAudio() {
  clearTimeout(audioTimer);
  const v = $('#playerVideo');
  const btn = $('#soundBtn');
  const decide = (final) => {
    let has;
    if (typeof v.webkitAudioDecodedByteCount === 'number') has = v.webkitAudioDecodedByteCount > 0;
    else if (typeof v.mozHasAudio === 'boolean') has = v.mozHasAudio;
    else has = true;

    if (!has && !final) return false;
    btn.disabled = !has;
    btn.title = has ? 'Bật/tắt tiếng (M)' : 'Camera này không có âm thanh';
    if (!has) {
      state.soundOn = false;
      v.muted = true;
      btn.classList.remove('is-on');
      btn.setAttribute('aria-pressed', 'false');
    } else {
      applySound();
    }
    return true;
  };
  if (decide(false)) return;
  audioTimer = setTimeout(() => decide(true), 4000);
}

function applyFit() {
  const player = $('#player');
  if (!player) return;
  player.classList.toggle('is-fill', !!state.fill);
  const btn = $('#fitBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(!!state.fill));
    btn.title = state.fill ? 'Đang đầy khung (bấm để vừa khung)' : 'Đang vừa khung (bấm để đầy khung)';
  }
}

function maybeHintPortrait(video) {
  if (state.hintedPortrait || !state.fill) return;
  if (!video || !video.videoWidth) return;
  if (video.videoHeight > video.videoWidth * 1.05 && innerWidth > innerHeight) {
    state.hintedPortrait = true;
    toast('Camera dọc — đang cắt trên/dưới để đầy khung. Bấm V để xem đủ hình.');
  }
}

function toggleFit() {
  state.fill = !state.fill;
  try { localStorage.setItem('lilycam.fitmode', state.fill ? 'fill' : 'fit'); } catch {}
  applyFit();
}

function setQuality(q) {
  state.quality = q === 'light' ? 'light' : 'hd';
  try { localStorage.setItem('lilycam.quality', state.quality); } catch {}
  document.querySelectorAll('#quality button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.q === state.quality);
  });
}

async function renderViewer() {
  const s = state.stores.find((x) => x.id === state.viewer.id);
  if (!s) return;
  const ch = state.viewer.ch;
  clearInterval(state.viewer.fallback);
  state.viewer.fallback = null;
  stopPlayback();
  if (!state.viewer.promoted || state.viewer.promoted.ch !== ch || state.quality !== 'hd') dropPromoted();

  $('#viewerCam').textContent = 'CAM ' + ch;
  $('#viewerStore').textContent = s.name;
  const msg = $('#playerMsg');
  msg.hidden = true;
  msg.textContent = '';

  const pills = $('#camPills');
  pills.textContent = '';
  for (const i of camList(s)) {
    const b = el('button', 'pill' + (i === ch ? ' is-active' : ''), 'CAM ' + i);
    b.addEventListener('click', () => { state.viewer.ch = i; renderViewer(); });
    pills.append(b);
  }
  pills.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' });

  updatePbBar();
  applyFit();
  applyZoom();
  setTimeout(fitAspectBox, 30);
  if (state.playback) return startPlayback(s, ch);
  // Luôn chạy luồng chính; chỉ hạ sang ảnh/MJPEG khi luồng chính lỗi (tự động, không cần bấm)
  if (state.hd && state.viewer.lightFor !== ch) return startHd(s, ch);
  return startLight(s, ch);
}

function fmtDT(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}
const fmtDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fmtTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const fmtDay = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

function renderTimeline() {
  const segs = $('#tlSegs');
  if (!segs) return;
  segs.textContent = '';
  const day = state.pbDay || dayStart(new Date());
  for (const seg of state.pbSegs) {
    const a = Math.max(seg.s * 1000, day);
    const b = Math.min(seg.e * 1000, day + 86400e3);
    if (b <= a) continue;
    const el2 = el('div', 'tl-seg');
    el2.style.left = ((a - day) / 86400e3) * 100 + '%';
    el2.style.width = ((b - a) / 86400e3) * 100 + '%';
    segs.append(el2);
  }
}

async function loadRecords(storeId, ch) {
  const day = state.pbDay || dayStart(new Date());
  const d = new Date(day);
  const p = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  $('#pbDate').textContent = fmtDay(day);
  state.pbSegs = [];
  renderTimeline();
  try {
    const r = await api(`/api/records/${encodeURIComponent(storeId)}/${ch}?date=${dateStr}`);
    if (state.viewer.id !== storeId || state.viewer.ch !== ch || state.pbDay !== day) return;
    state.pbSegs = r.segments || [];
    renderTimeline();
  } catch { /* không có dữ liệu timeline */ }
}

function updatePlayhead() {
  const head = $('#tlHead');
  if (!head || !state.playback) return;
  const day = state.pbDay || dayStart(new Date(state.playback));
  const cur = state.playback + (Date.now() - state.pbT0);
  const pct = Math.min(100, Math.max(0, ((cur - day) / 86400e3) * 100));
  head.style.left = pct + '%';
  $('#pbTime').textContent = fmtDT(cur);
}

function seekTo(ms, quiet) {
  const store = state.stores.find((x) => x.id === state.viewer.id);
  if (!store) return;
  let t = Math.max(0, Math.min(Date.now(), ms));

  // nếu rơi vào khoảng không có bản ghi thì nhảy tới đoạn gần nhất
  if (state.pbSegs && state.pbSegs.length) {
    const sec = t / 1000;
    const inside = state.pbSegs.some((g) => sec >= g.s && sec <= g.e);
    if (!inside) {
      let best = null;
      for (const g of state.pbSegs) {
        const d = sec < g.s ? g.s - sec : sec - g.e;
        if (!best || d < best.d) best = { d, t: (sec < g.s ? g.s : g.e) * 1000 };
      }
      if (best && !quiet) toast('Khung giờ đó không có bản ghi — nhảy tới ' + fmtDT(best.t));
      if (best) t = best.t;
    }
  }
  state.playback = t;
  state.pbDay = dayStart(new Date(state.playback));
  renderViewer();
  loadRecords(store.id, state.viewer.ch);
}

function updatePbBar() {
  const bar = $('#pbBar');
  if (!bar) return;
  bar.hidden = !state.playback;
  if (state.playback) {
    if (!state.pbDay) state.pbDay = dayStart(new Date(state.playback));
    $('#pbDate').textContent = fmtDay(state.pbDay);
    $('#pbTime').textContent = fmtDT(state.playback);
    updatePlayhead();
  }
}

function startPlayback(s, ch) {
  const video = $('#playerVideo');
  const img = $('#playerImg');
  const msg = $('#playerMsg');
  img.hidden = true;
  img.removeAttribute('src');
  video.hidden = false;
  video.muted = !state.soundOn;
  msg.hidden = false;
  msg.textContent = 'Đang tải bản ghi để phát mượt (5–10 giây)…';

  state.pbT0 = Date.now();
  if (!state.pbDay || state.playback < state.pbDay || state.playback >= state.pbDay + 86400e3) {
    state.pbDay = dayStart(new Date(state.playback));
  }
  loadRecords(s.id, ch);
  clearInterval(state.pbTimer);
  state.pbTimer = setInterval(updatePlayhead, 1000);

  const sec = Math.floor(state.playback / 1000);
  const url = `/hls/pb${sec}/${encodeURIComponent(s.id)}/${ch}/index.m3u8`;
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');

  clearTimeout(hdTimer);
  hdTimer = setTimeout(() => {
    if (video.readyState < 2) {
      msg.hidden = false;
      msg.textContent = 'Không có bản ghi ở khoảng này, hoặc đầu ghi đang bận. Thử chọn giờ khác.';
    }
  }, 25000);

  if (window.Hls && Hls.isSupported()) {
    const inst = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 2,
      maxBufferLength: 30,
      backBufferLength: 30,
      maxLiveSyncPlaybackRate: 1.2,
      manifestLoadingTimeOut: 20000,
      fragLoadingTimeOut: 20000,
    });
    hlsPlayer = inst;
    inst.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    inst.on(Hls.Events.ERROR, (_e, d) => {
      if (hlsPlayer !== inst) return;
      if (d && d.fatal) {
        msg.hidden = false;
        msg.textContent = 'Không mở được bản ghi ở khoảng này. Thử chọn giờ khác.';
      }
    });
    inst.loadSource(url);
    inst.attachMedia(video);
  } else if (nativeHls) {
    video.src = url;
    video.play().catch(() => {});
  } else {
    msg.hidden = false;
    msg.textContent = 'Trình duyệt không hỗ trợ phát lại.';
  }

  video.onplaying = () => { msg.hidden = true; clearTimeout(hdTimer); };
}

function openPlaybackDialog() {
  const s = state.stores.find((x) => x.id === state.viewer.id);
  if (!s) return;
  const ch = state.viewer.ch;
  const base = state.playback ? new Date(state.playback) : new Date(Date.now() - 3600e3);

  openDialog('Xem lại bản ghi — ' + s.name + ' · CAM ' + ch, (b) => {
    const d = field('Ngày', fmtDate(base), { type: 'date' });
    const t = field('Giờ bắt đầu', fmtTime(base), { type: 'time' });
    b.append(d.wrap, t.wrap);

    const quick = el('div', 'quick-times');
    const setTo = (dt) => { d.input.value = fmtDate(dt); t.input.value = fmtTime(dt); };
    const presets = [
      ['30 phút trước', () => new Date(Date.now() - 30 * 60e3)],
      ['1 giờ trước', () => new Date(Date.now() - 60 * 60e3)],
      ['3 giờ trước', () => new Date(Date.now() - 180 * 60e3)],
      ['8:00 hôm nay', () => { const x = new Date(); x.setHours(8, 0, 0, 0); return x; }],
      ['8:00 hôm qua', () => { const x = new Date(Date.now() - 24 * 3600e3); x.setHours(8, 0, 0, 0); return x; }],
    ];
    for (const [label, fn] of presets) {
      const btn = el('button', 'chip', label);
      btn.type = 'button';
      btn.addEventListener('click', () => setTo(fn()));
      quick.append(btn);
    }
    b.append(quick);
    b.append(el('p', 'hint',
      'Giờ tính theo đồng hồ của đầu ghi (nhiều cửa hàng đang lệch giờ). Nếu không thấy hình, lùi/tiến 5 phút.'));

    const note = el('p', 'hint', 'Đang kiểm tra khả năng xem lại của đầu ghi…');
    b.append(note);
    api('/api/pbcheck/' + encodeURIComponent(s.id))
      .then((r) => {
        note.className = 'hint ' + (r.supported ? 'ok' : 'warn');
        if (r.engine === 'rtsp') note.textContent = 'Đầu ghi hỗ trợ xem lại qua RTSP — mở gần như tức thì.';
        else if (r.engine === 'netsdk') note.textContent = 'Đầu ghi không mở RTSP playback — web sẽ lấy bản ghi qua Dahua NetSDK (chờ ~5–10 giây).';
        else note.textContent = 'Chưa hỗ trợ xem lại cho đầu ghi này.';
      })
      .catch(() => { note.remove(); });
  }, async () => {
    const dv = $('#dialogBody input[type="date"]').value;
    const tv = $('#dialogBody input[type="time"]').value;
    if (!dv || !tv) return toast('Chọn ngày và giờ', true);
    const ms = new Date(`${dv}T${tv}:00`).getTime();
    if (!Number.isFinite(ms)) return toast('Ngày giờ không hợp lệ', true);
    if (ms > Date.now() + 60e3) return toast('Thời điểm ở tương lai', true);
    state.playback = ms;
    state.pbDay = dayStart(new Date(ms));
    closeDialog();
    renderViewer();
  }, 'Phát');
}

function fallbackToLight(why) {
  if (state.viewer.closing) return;
  state.viewer.lightFor = state.viewer.ch; // chỉ hạ cho camera đang xem
  if (why) toast(why, true);
  renderViewer();
}

function startHd(s, ch) {
  const video = $('#playerVideo');
  const img = $('#playerImg');
  const msg = $('#playerMsg');
  const promoted = state.viewer.promoted && state.viewer.promoted.ch === ch;

  // Luôn hiển thị LUỒNG CHÍNH: không mở MJPEG nữa, chỉ treo ảnh tĩnh trong lúc chờ
  const poster = $('#posterImg');
  if (!promoted) {
    video.hidden = true;
    img.hidden = true;
    img.removeAttribute('src');
    poster.hidden = false;
    poster.onerror = () => { poster.hidden = true; };
    poster.src = `/api/snap/${encodeURIComponent(s.id)}/${ch}?fast=1&t=${Date.now()}`;
    msg.hidden = false;
    msg.textContent = 'Đang mở luồng chính…';
  }

  let hdAttempt = 0;
  const retryHd = (why) => {
    if (state.viewer.id !== s.id || state.viewer.ch !== ch) return;
    if (hdAttempt >= 2) {
      fallbackToLight(why + ' — tạm hiện chế độ nhẹ (bấm vào ô để thử lại)');
      return;
    }
    hdAttempt++;
    toast(`Luồng chính chưa lên — thử lại (${hdAttempt}/2)…`);
    try { if (hlsPlayer) hlsPlayer.destroy(); } catch {}
    hlsPlayer = null;
    setTimeout(() => {
      if (state.viewer.id === s.id && state.viewer.ch === ch && $('#viewer').hidden === false) initHd();
    }, 1200);
  };

  clearTimeout(hdTimer);
  // đang bê stream lưới sang: chờ đầu ghi đóng kết nối cũ rồi mới mở HD
  hdTimer = setTimeout(initHd, promoted ? 900 : 0);

  function initHd() {
    const url = `/hls/hd/${encodeURIComponent(s.id)}/${ch}/index.m3u8`;
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');

    if (window.Hls && Hls.isSupported()) {
      const inst = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 12,
        liveSyncDurationCount: 1,
        maxLiveSyncPlaybackRate: 1.5,
        manifestLoadingTimeOut: 14000,
        fragLoadingTimeOut: 14000,
      });
      hlsPlayer = inst;
      inst.on(Hls.Events.MANIFEST_PARSED, () => { if (hlsPlayer === inst) video.play().catch(() => {}); });
      inst.on(Hls.Events.ERROR, (_evt, data) => {
        if (hlsPlayer !== inst) return;
        if (data && data.fatal) retryHd('Luồng chính không mở được');
      });
      inst.loadSource(url);
      inst.attachMedia(video);
    } else if (nativeHls) {
      video.src = url;
      video.play().catch(() => {});
    } else {
      fallbackToLight('Trình duyệt không hỗ trợ HD');
      return;
    }

    video.onloadedmetadata = () => {
      if (video.videoWidth && video.videoHeight) {
        $('#player').style.setProperty('--ar', `${video.videoWidth} / ${video.videoHeight}`);
        maybeHintPortrait(video);
      }
    };

    video.onplaying = () => {
      msg.hidden = true;
      clearTimeout(hdTimer);
      video.hidden = false;
      img.removeAttribute('src');
      img.hidden = true;
      $('#posterImg').hidden = true;
      dropPromoted();
      setTimeout(checkAudio, 2500);
    };

    hdTimer = setTimeout(() => {
      if (video.readyState < 2) retryHd('Luồng chính quá chậm');
    }, 15000);
  }
}

let frozen = false;

function startLight(s, ch) {
  const video = $('#playerVideo');
  const img = $('#playerImg');
  const msg = $('#playerMsg');
  video.hidden = true;
  img.hidden = false;

  /* Ảnh tĩnh: dùng JPEG thật để chuột phải → "Sao chép hình ảnh" hoạt động bình thường */
  if (frozen) {
    msg.hidden = true;
    img.src = `/api/snap/${encodeURIComponent(s.id)}/${ch}?t=${Date.now()}`;
    return;
  }

  msg.hidden = false;
  msg.textContent = 'Đang kết nối…';

  // mở luồng MJPEG NGAY (không chờ dò tỉ lệ), tỉ lệ cập nhật sau ở nền
  img.src = `/api/stream/${encodeURIComponent(s.id)}/${ch}?t=${Date.now()}`;

  api(`/api/meta/${encodeURIComponent(s.id)}/${ch}?t=${Date.now()}`)
    .then((meta) => {
      if (state.viewer.id === s.id && state.viewer.ch === ch && meta && meta.w && meta.h) {
        $('#player').style.setProperty('--ar', `${meta.w} / ${meta.h}`);
      }
    })
    .catch(() => {});
  img.onerror = () => {
    msg.hidden = false;
    msg.textContent = 'Không mở được luồng trực tiếp — chuyển sang ảnh cập nhật mỗi 1,5 giây…';
    img.removeAttribute('src');
    startFallback(s.id, ch);
  };
  img.onload = () => { msg.hidden = true; $('#posterImg').hidden = true; };
}

function startFallback(storeId, ch) {
  const img = $('#playerImg');
  clearInterval(state.viewer.fallback);
  const tick = () => { img.src = `/api/snap/${encodeURIComponent(storeId)}/${ch}?t=${Date.now()}`; };
  tick();
  state.viewer.fallback = setInterval(tick, 1500);
}

function closeViewer() {
  if ($('#viewer').hidden) return;
  state.viewer.closing = true;
  state.playback = null;
  dropPromoted();
  stopPlayback();
  $('#viewer').hidden = true;
  $('#playerImg').removeAttribute('src');
  clearInterval(state.viewer.fallback);
  state.viewer.fallback = null;
  document.body.style.overflow = '';
  state.viewer.zoom = 1;
  state.viewer.panX = 0;
  state.viewer.panY = 0;
  applyZoom();
  state.viewer.closing = false;
  setTimeout(resumeTiles, 150);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function stepCam(dir) {
  const s = state.stores.find((x) => x.id === state.viewer.id);
  if (!s) return;
  const list = camList(s);
  const i = Math.max(0, list.indexOf(Number(state.viewer.ch)));
  const next = (i + dir + list.length) % list.length;
  state.viewer.ch = list[next];
  renderViewer();
}

function toggleFullscreen() {
  const panel = document.querySelector('.viewer-panel');
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  panel.requestFullscreen?.().catch(() => toast('Trình duyệt không cho toàn màn hình', true));
}

/* ---------------- Kính lúp: phóng to / thu nhỏ + kéo để di chuyển ---------------- */
const ZOOM_STEPS = [1, 1.5, 2, 3];

function zoomMedia() {
  return [$('#playerVideo'), $('#playerImg')].filter(Boolean);
}

function clampPan() {
  const v = state.viewer;
  const s = v.zoom || 1;
  if (s <= 1) { v.panX = 0; v.panY = 0; return; }
  const r = $('#player').getBoundingClientRect();
  const maxX = ((s - 1) * r.width) / 2;
  const maxY = ((s - 1) * r.height) / 2;
  v.panX = Math.max(-maxX, Math.min(maxX, v.panX));
  v.panY = Math.max(-maxY, Math.min(maxY, v.panY));
}

function applyZoom() {
  const v = state.viewer;
  const s = v.zoom || 1;
  const t = s === 1 ? '' : `translate(${v.panX || 0}px, ${v.panY || 0}px) scale(${s})`;
  for (const el of zoomMedia()) el.style.transform = t;
  const player = $('#player');
  if (player) player.classList.toggle('is-zoomed', s > 1);
  const btn = $('#zoomBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(s > 1));
    btn.classList.toggle('is-active', s > 1);
    btn.title = s > 1 ? `Zoom ${s}× — bấm để đổi mức, kéo chuột để di chuyển (Z)` : 'Kính lúp: phóng to / thu nhỏ (Z)';
  }
}

function cycleZoom(dir = 1) {
  const v = state.viewer;
  const cur = v.zoom || 1;
  const i = ZOOM_STEPS.indexOf(cur);
  const next = ZOOM_STEPS[(i + dir + ZOOM_STEPS.length) % ZOOM_STEPS.length];
  v.zoom = next;
  if (next === 1) { v.panX = 0; v.panY = 0; }
  clampPan();
  applyZoom();
  if (next > 1) toast(`Zoom ${next}× — kéo chuột để di chuyển`);
}

(() => {
  const player = $('#player');
  if (!player) return;
  let drag = null;
  player.addEventListener('pointerdown', (e) => {
    if ((state.viewer.zoom || 1) <= 1) return;
    if (e.target.closest('.nav-arrow')) return;
    drag = { x: e.clientX, y: e.clientY, px: state.viewer.panX || 0, py: state.viewer.panY || 0 };
    player.classList.add('is-dragging');
    try { player.setPointerCapture(e.pointerId); } catch {}
  });
  player.addEventListener('pointermove', (e) => {
    if (!drag) return;
    state.viewer.panX = drag.px + (e.clientX - drag.x);
    state.viewer.panY = drag.py + (e.clientY - drag.y);
    clampPan();
    applyZoom();
  });
  const stop = () => { drag = null; player.classList.remove('is-dragging'); };
  player.addEventListener('pointerup', stop);
  player.addEventListener('pointercancel', stop);
  player.addEventListener('wheel', (e) => {
    if ($('#viewer').hidden) return;
    if (!e.ctrlKey && (state.viewer.zoom || 1) === 1) return;
    e.preventDefault();
    cycleZoom(e.deltaY > 0 ? -1 : 1);
  }, { passive: false });
})();

$('#zoomBtn').addEventListener('click', () => cycleZoom(1));

$('#closeViewer').addEventListener('click', closeViewer);
$('#prevCam').addEventListener('click', () => stepCam(-1));
$('#nextCam').addEventListener('click', () => stepCam(1));
document.querySelector('#viewer [data-close]').addEventListener('click', closeViewer);

/* Nhấp đúp chuột trái vào cửa sổ cam → phóng to / thu nhỏ */
$('#player').addEventListener('dblclick', (e) => {
  if (e.target.closest('.nav-arrow')) return;
  toggleFullscreen();
});

$('#pbBtn').addEventListener('click', openPlaybackDialog);
$('#pbPick').addEventListener('click', openPlaybackDialog);
$('#pbPrevDay').addEventListener('click', () => {
  if (!state.playback) return;
  const d = new Date(state.pbDay || dayStart(new Date(state.playback)));
  d.setDate(d.getDate() - 1);
  state.pbDay = dayStart(d);
  seekTo(state.pbDay + 12 * 3600e3 > Date.now() ? Date.now() - 60e3 : state.pbDay + 12 * 3600e3);
});

$('#pbNextDay').addEventListener('click', () => {
  if (!state.playback) return;
  const d = new Date(state.pbDay || dayStart(new Date(state.playback)));
  d.setDate(d.getDate() + 1);
  const next = dayStart(d);
  if (next > Date.now()) return toast('Chưa tới ngày đó', true);
  state.pbDay = next;
  seekTo(Math.min(Date.now() - 60e3, next + 60e3));
});

const tl = $('#pbTimeline');
let tlDragging = false;
const timeFromEvent = (e) => {
  const r = tl.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  return (state.pbDay || dayStart(new Date())) + ratio * 86400e3;
};
const showGhost = (ms) => {
  const head = $('#tlHead');
  const day = state.pbDay || dayStart(new Date());
  head.style.left = Math.min(100, Math.max(0, ((ms - day) / 86400e3) * 100)) + '%';
  $('#pbTime').textContent = fmtDT(ms);
};
tl.addEventListener('pointerdown', (e) => {
  if (!state.playback) return;
  tlDragging = true;
  tl.classList.add('is-dragging');
  tl.setPointerCapture(e.pointerId);
  showGhost(timeFromEvent(e));
});
tl.addEventListener('pointermove', (e) => {
  if (!tlDragging) return;
  showGhost(timeFromEvent(e));
});
tl.addEventListener('pointerup', (e) => {
  if (!tlDragging) return;
  tlDragging = false;
  tl.classList.remove('is-dragging');
  const t = Math.min(Date.now() - 1000, timeFromEvent(e));
  seekTo(t);
});
$('#pbLive').addEventListener('click', () => {
  state.playback = null;
  renderViewer();
});

$('#soundBtn').addEventListener('click', toggleSound);

/* Lấy khung hình hiện tại: ưu tiên khung đang phát (video), không có thì lấy ảnh JPEG mới nhất */
async function grabShot() {
  const video = $('#playerVideo');
  if (video && !video.hidden && video.videoWidth) {
    const cv = document.createElement('canvas');
    cv.width = video.videoWidth;
    cv.height = video.videoHeight;
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
    return await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
  }
  const { id, ch } = state.viewer;
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`/api/snap/${encodeURIComponent(id)}/${ch}?t=${Date.now()}`, { credentials: 'same-origin' });
    if (res.ok) return res.blob();
    if (i === 0) await new Promise((r) => setTimeout(r, 700));
    else throw new Error('Đầu ghi chưa trả được khung hình — thử lại sau vài giây');
  }
  throw new Error('Chưa có khung hình để chụp');
}

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

/* Lưu ảnh về máy (phím S) */
async function saveShot() {
  const { id, ch } = state.viewer;
  try {
    const blob = await grabShot();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lilycam-${id}-cam${ch}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Đã lưu ảnh');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- Chụp ảnh → hộp thoại ghi lỗi → Giám sát tháng ---------------- */
const capState = { blob: null, img: null, shapes: [], tool: 'rect', drag: null, store: null, ch: null, options: null };

function capCanvasEl() { return $('#capCanvas'); }

function capDrawShape(ctx, s) {
  const x = Math.min(s.x1, s.x2);
  const y = Math.min(s.y1, s.y2);
  const w = Math.abs(s.x2 - s.x1);
  const h = Math.abs(s.y2 - s.y1);
  if (w < 3 || h < 3) return;
  ctx.beginPath();
  if (s.type === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(x, y, w, h);
  ctx.stroke();
}

function capRedraw() {
  const cv = capCanvasEl();
  if (!cv || !cv.width) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (capState.img) ctx.drawImage(capState.img, 0, 0, cv.width, cv.height);
  const lw = Math.max(3, Math.round(cv.width / 320));
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#ff3b30';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = lw;
  for (const s of capState.shapes) capDrawShape(ctx, s);
  if (capState.drag) capDrawShape(ctx, capState.drag);
  ctx.shadowBlur = 0;
}

function capPoint(e) {
  const cv = capCanvasEl();
  const r = cv.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cv.width / r.width),
    y: (e.clientY - r.top) * (cv.height / r.height),
  };
}

async function capLoadOptions() {
  if (capState.options) return capState.options;
  try {
    capState.options = await api('/api/capture/options');
  } catch {
    capState.options = { categories: [], items: [] };
  }
  const fill = (sel, list) => {
    sel.textContent = '';
    sel.append(new Option('— chọn —', ''));
    for (const v of list || []) sel.append(new Option(v, v));
  };
  fill($('#capCategory'), capState.options.categories);
  fill($('#capItem'), capState.options.items);
  return capState.options;
}

async function openCaptureDialog(s, ch, blob) {
  capState.shapes = [];
  capState.drag = null;
  capState.tool = 'rect';
  capState.store = s.id;
  capState.ch = ch;
  document.querySelectorAll('#capDialog .cap-tools [data-tool]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tool === 'rect');
  });
  $('#capDesc').value = '';
  $('#capWhere').textContent = s.name + ' · CAM ' + ch;
  $('#capDialog').hidden = false;

  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  capState.img = img;
  const cv = capCanvasEl();
  const maxW = 1500;
  const k = Math.min(1, maxW / (img.naturalWidth || maxW));
  cv.width = Math.max(320, Math.round((img.naturalWidth || 960) * k));
  cv.height = Math.max(180, Math.round((img.naturalHeight || 540) * k));
  capRedraw();
  capLoadOptions();
}

function closeCaptureDialog() {
  $('#capDialog').hidden = true;
  capState.shapes = [];
  capState.drag = null;
  capState.img = null;
}

async function submitCaptureDialog() {
  const btn = $('#capSend');
  if (btn.disabled) return;
  const cv = capCanvasEl();
  if (!cv.width) return toast('Chưa có ảnh', true);
  // mở tab ngay trong thao tác bấm để trình duyệt không chặn popup
  const tab = window.open('', '_blank');
  btn.disabled = true;
  try {
    const out = await api('/api/capture', {
      method: 'POST',
      body: JSON.stringify({
        store: capState.store,
        ch: capState.ch,
        image: cv.toDataURL('image/jpeg', 0.92),
        category: $('#capCategory').value,
        item: $('#capItem').value,
        desc: $('#capDesc').value.trim(),
      }),
    });
    if (!out || !out.ok) throw new Error((out && out.error) || 'Không gửi được ảnh');
    closeCaptureDialog();
    if (out.warning) toast('Đã lưu ảnh nhưng chưa gửi được Lark: ' + out.warning, true);
    else toast(`Đã gửi sự cố — Tuần ${out.week}`);
    if (out.url && tab) tab.location.href = out.url;
    else if (out.url) window.open(out.url, '_blank', 'noopener');
    else if (tab) tab.close();
  } catch (e) {
    if (tab) tab.close();
    toast(e.message || 'Không gửi được ảnh', true);
  } finally {
    btn.disabled = false;
  }
}

async function captureShot() {
  const { id, ch } = state.viewer;
  if (!id) return;
  const btn = $('#captureBtn');
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
  try {
    const blob = await grabShot();
    const s = state.stores.find((x) => x.id === id);
    await openCaptureDialog(s || { id, name: id }, ch, blob);
  } catch (e) {
    toast(e.message || 'Không chụp được ảnh', true);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
  }
}

$('#captureBtn').addEventListener('click', captureShot);
$('#capClose').addEventListener('click', closeCaptureDialog);
$('#capCancel').addEventListener('click', closeCaptureDialog);
document.querySelector('#capDialog [data-cap-close]').addEventListener('click', closeCaptureDialog);
$('#capSend').addEventListener('click', submitCaptureDialog);

document.querySelectorAll('#capDialog .cap-tools [data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    capState.tool = b.dataset.tool;
    document.querySelectorAll('#capDialog .cap-tools [data-tool]').forEach((x) => {
      x.classList.toggle('is-active', x === b);
    });
  });
});
$('#capUndo').addEventListener('click', () => { capState.shapes.pop(); capRedraw(); });
$('#capClear').addEventListener('click', () => { capState.shapes = []; capRedraw(); });

(() => {
  const cv = capCanvasEl();
  if (!cv) return;
  cv.addEventListener('pointerdown', (e) => {
    const p = capPoint(e);
    capState.drag = { type: capState.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener('pointermove', (e) => {
    if (!capState.drag) return;
    const p = capPoint(e);
    capState.drag.x2 = p.x;
    capState.drag.y2 = p.y;
    capRedraw();
  });
  const end = () => {
    if (!capState.drag) return;
    const s = capState.drag;
    capState.drag = null;
    if (Math.abs(s.x2 - s.x1) > 4 && Math.abs(s.y2 - s.y1) > 4) capState.shapes.push(s);
    capRedraw();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
})();

/* ---------------- Vùng cảnh báo (lưới ô vuông) ---------------- */
const zoneState = { store: null, ch: null, img: null, cols: 16, rows: 9, cells: new Set(), paint: null };

function zoneCanvasEl() { return $('#zoneCanvas'); }

function zoneDraw() {
  const cv = zoneCanvasEl();
  if (!cv || !cv.width) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (zoneState.img) ctx.drawImage(zoneState.img, 0, 0, cv.width, cv.height);
  const cw = cv.width / zoneState.cols;
  const chh = cv.height / zoneState.rows;
  ctx.fillStyle = 'rgba(255,59,48,.34)';
  for (const i of zoneState.cells) {
    ctx.fillRect((i % zoneState.cols) * cw, Math.floor(i / zoneState.cols) * chh, cw, chh);
  }
  ctx.lineWidth = Math.max(1, cv.width / 760);
  ctx.strokeStyle = 'rgba(255,255,255,.34)';
  ctx.beginPath();
  for (let c = 1; c < zoneState.cols; c++) { const x = c * cw; ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); }
  for (let r = 1; r < zoneState.rows; r++) { const y = r * chh; ctx.moveTo(0, y); ctx.lineTo(cv.width, y); }
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, cv.width / 480);
  ctx.strokeStyle = 'rgba(255,59,48,.85)';
  ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
  const cnt = $('#zoneCount');
  if (cnt) cnt.textContent = `Đã chọn ${zoneState.cells.size}/${zoneState.cols * zoneState.rows} ô — bấm hoặc kéo để chọn`;
}

function zoneCellAt(e) {
  const cv = zoneCanvasEl();
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return -1;
  const c = Math.min(zoneState.cols - 1, Math.floor(x * zoneState.cols));
  const rr = Math.min(zoneState.rows - 1, Math.floor(y * zoneState.rows));
  return rr * zoneState.cols + c;
}

async function openZoneDialog(s, ch) {
  $('#zoneWhere').textContent = s.name + ' · CAM ' + ch;
  $('#zoneDialog').hidden = false;
  zoneState.store = s.id;
  zoneState.ch = ch;
  zoneState.cells = new Set();

  let blob = null;
  try { blob = await grabShot(); } catch { blob = null; }
  const img = new Image();
  if (blob) {
    const url = URL.createObjectURL(blob);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }).catch(() => {});
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  zoneState.img = img.naturalWidth ? img : null;
  const w = img.naturalWidth || 960;
  const h = img.naturalHeight || 540;
  // lưới ô VUÔNG: 9 hàng, số cột suy ra từ tỉ lệ khung hình
  zoneState.rows = 9;
  zoneState.cols = Math.max(4, Math.min(32, Math.round((w / h) * zoneState.rows)));

  const cv = zoneCanvasEl();
  const k = Math.min(1, 1500 / w);
  cv.width = Math.round(w * k);
  cv.height = Math.round(h * k);

  try {
    const z = await api(`/api/zones/${encodeURIComponent(s.id)}/${ch}`);
    if (z && z.cols && z.rows && Array.isArray(z.cells) && z.cells.length) {
      // đổi lưới cũ sang lưới ô vuông hiện tại theo vị trí tương đối
      const next = new Set();
      for (const i of z.cells) {
        const nx = ((i % z.cols) + 0.5) / z.cols;
        const ny = (Math.floor(i / z.cols) + 0.5) / z.rows;
        const c = Math.min(zoneState.cols - 1, Math.floor(nx * zoneState.cols));
        const r = Math.min(zoneState.rows - 1, Math.floor(ny * zoneState.rows));
        next.add(r * zoneState.cols + c);
      }
      zoneState.cells = next;
    }
  } catch {}
  zoneDraw();
}

function closeZoneDialog() {
  $('#zoneDialog').hidden = true;
  zoneState.paint = null;
}

async function saveZone() {
  const btn = $('#zoneSave');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await api(`/api/zones/${encodeURIComponent(zoneState.store)}/${zoneState.ch}`, {
      method: 'POST',
      body: JSON.stringify({ cols: zoneState.cols, rows: zoneState.rows, cells: [...zoneState.cells] }),
    });
    toast(`Đã lưu vùng cảnh báo: ${zoneState.cells.size}/${zoneState.cols * zoneState.rows} ô`);
    closeZoneDialog();
  } catch (e) {
    toast(e.message || 'Không lưu được vùng cảnh báo', true);
  } finally {
    btn.disabled = false;
  }
}

$('#zoneBtn').addEventListener('click', () => {
  const s = state.stores.find((x) => x.id === state.viewer.id);
  if (s) openZoneDialog(s, state.viewer.ch);
});
$('#zoneClose').addEventListener('click', closeZoneDialog);
$('#zoneCancel').addEventListener('click', closeZoneDialog);
document.querySelector('#zoneDialog [data-zone-close]').addEventListener('click', closeZoneDialog);
$('#zoneSave').addEventListener('click', saveZone);
$('#zoneAll').addEventListener('click', () => {
  const total = zoneState.cols * zoneState.rows;
  for (let i = 0; i < total; i++) zoneState.cells.add(i);
  zoneDraw();
});
$('#zoneNone').addEventListener('click', () => { zoneState.cells.clear(); zoneDraw(); });
$('#zoneInvert').addEventListener('click', () => {
  const total = zoneState.cols * zoneState.rows;
  const next = new Set();
  for (let i = 0; i < total; i++) if (!zoneState.cells.has(i)) next.add(i);
  zoneState.cells = next;
  zoneDraw();
});

(() => {
  const cv = zoneCanvasEl();
  if (!cv) return;
  cv.addEventListener('pointerdown', (e) => {
    const i = zoneCellAt(e);
    if (i < 0) return;
    zoneState.paint = !zoneState.cells.has(i);
    e.preventDefault();
    if (zoneState.paint) zoneState.cells.add(i); else zoneState.cells.delete(i);
    zoneDraw();
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener('pointermove', (e) => {
    if (zoneState.paint === null) return;
    const i = zoneCellAt(e);
    if (i < 0) return;
    if (zoneState.paint) zoneState.cells.add(i); else zoneState.cells.delete(i);
    zoneDraw();
  });
  const end = () => { zoneState.paint = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
})();

/* ---------------- Điều khiển PTZ ---------------- */
const PTZ_ALL = ['Up', 'Down', 'Left', 'Right', 'LeftUp', 'RightUp', 'LeftDown', 'RightDown', 'ZoomTile', 'ZoomWide'];

function ptzSpeedNow() {
  const el = $('#ptzSpeed');
  return el ? Number(el.value) || 4 : 4;
}

function ptzSend(code, action) {
  const id = state.viewer.id;
  if (!id) return;
  api(`/api/ptz/${encodeURIComponent(id)}/${state.viewer.ch}`, {
    method: 'POST',
    body: JSON.stringify({ code, action, speed: ptzSpeedNow() }),
  }).catch((e) => toast(e.message || 'Không điều khiển được camera', true));
}

function openPtz() {
  const s = state.stores.find((x) => x.id === state.viewer.id);
  if (!s) return;
  $('#ptzWhere').textContent = s.name + ' · CAM ' + state.viewer.ch;
  $('#ptzDialog').hidden = false;
}

function closePtz() {
  document.querySelectorAll('#ptzDialog .ptz-key.is-down, #ptzDialog .is-down').forEach((b) => b.classList.remove('is-down'));
  $('#ptzDialog').hidden = true;
}

$('#ptzBtn').addEventListener('click', openPtz);
$('#ptzClose').addEventListener('click', closePtz);
$('#ptzDone').addEventListener('click', closePtz);
document.querySelector('#ptzDialog [data-ptz-close]').addEventListener('click', closePtz);
$('#ptzStop').addEventListener('click', () => PTZ_ALL.forEach((c) => ptzSend(c, 'stop')));

document.querySelectorAll('#ptzDialog [data-ptz]').forEach((b) => {
  const code = b.dataset.ptz;
  const start = (e) => {
    e.preventDefault();
    if (b.classList.contains('is-down')) return;
    b.classList.add('is-down');
    ptzSend(code, 'start');
  };
  const stop = () => {
    if (!b.classList.contains('is-down')) return;
    b.classList.remove('is-down');
    ptzSend(code, 'stop');
  };
  b.addEventListener('pointerdown', start);
  b.addEventListener('pointerup', stop);
  b.addEventListener('pointerleave', stop);
  b.addEventListener('pointercancel', stop);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});

/* ---------------- Tỉ lệ khung hình hiển thị ---------------- */
function fitAspectBox() {
  const player = $('#player');
  if (!player) return;
  const val = state.viewer.ar || 'full';
  const media = [$('#playerVideo'), $('#playerImg'), $('#posterImg')].filter(Boolean);
  if (val === 'full') {
    for (const el of media) { el.style.width = ''; el.style.height = ''; }
    return;
  }
  const [rw, rh] = val.split(':').map(Number);
  const W = player.clientWidth || 1;
  const H = player.clientHeight || 1;
  let w = W;
  let h = (W * rh) / rw;
  if (h > H) { h = H; w = (H * rw) / rh; }
  for (const el of media) {
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
  }
}

function applyAspect(v) {
  const player = $('#player');
  if (!player) return;
  const val = v || 'full';
  state.viewer.ar = val;
  player.dataset.ar = val;
  player.classList.toggle('is-fill', val === 'full');
  fitAspectBox();
  const sel = $('#arSelect');
  if (sel && sel.value !== val) sel.value = val;
  try { localStorage.setItem('lilycam.ar.v2', val); } catch {}
}

$('#arSelect').addEventListener('change', (e) => applyAspect(e.target.value));
window.addEventListener('resize', () => { if (!$('#viewer').hidden) fitAspectBox(); });
// phóng to / thu nhỏ toàn màn hình cũng phải tính lại khung 16:9
document.addEventListener('fullscreenchange', () => { if (!$('#viewer').hidden) setTimeout(fitAspectBox, 60); });
applyAspect(localStorage.getItem('lilycam.ar.v2') || '16:9');

document.addEventListener('keydown', (e) => {
  if (!$('#dialog').hidden) {
    if (e.key === 'Escape') closeDialog();
    return;
  }
  if (!$('#ptzDialog').hidden) {
    if (e.key === 'Escape') closePtz();
    return;
  }
  if (!$('#zoneDialog').hidden) {
    if (e.key === 'Escape') closeZoneDialog();
    return;
  }
  if (!$('#capDialog').hidden) {
    if (e.key === 'Escape') closeCaptureDialog();
    return;
  }
  if ($('#viewer').hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') stepCam(-1);
  else if (e.key === 'ArrowRight') stepCam(1);
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 's' || e.key === 'S') saveShot();
  else if (e.key === 'c' || e.key === 'C') captureShot();
  else if (e.key === 'z' || e.key === 'Z') cycleZoom(1);
  else if (e.key === 'g' || e.key === 'G') $('#zoneBtn').click();
  else if (e.key === 't' || e.key === 'T') $('#ptzBtn').click();
  else if (e.key === 'm' || e.key === 'M') toggleSound();
  else if (e.key === 'p' || e.key === 'P') openPlaybackDialog();
  else if (e.key === 'v' || e.key === 'V') toggleFit();
});

/* ------------------------------------------------------------------ */
/* Hộp thoại chung                                                     */
/* ------------------------------------------------------------------ */
let dialogOk = null;
function openDialog(title, buildBody, onOk, okLabel = 'Lưu') {
  $('#dialogTitle').textContent = title;
  const body = $('#dialogBody');
  body.textContent = '';
  buildBody(body);
  $('#dialogOk').textContent = okLabel;
  dialogOk = onOk;
  $('#dialog').hidden = false;
  setTimeout(() => body.querySelector('input')?.focus(), 50);
}
function closeDialog() { $('#dialog').hidden = true; dialogOk = null; }
$('#dialogOk').addEventListener('click', async () => {
  if (!dialogOk) return;
  const btn = $('#dialogOk');
  btn.disabled = true;
  try { await dialogOk(); } finally { btn.disabled = false; }
});
document.querySelectorAll('[data-dialog-close]').forEach((b) => b.addEventListener('click', closeDialog));

function field(label, value, opts = {}) {
  const l = el('label', 'field');
  l.append(el('span', null, label));
  const i = el('input');
  i.value = value ?? '';
  if (opts.type) i.type = opts.type;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  if (opts.readonly) i.readOnly = true;
  l.append(i);
  return { wrap: l, input: i };
}

/* ------------------------------------------------------------------ */
/* Menu người dùng                                                     */
/* ------------------------------------------------------------------ */
const userMenu = $('#userMenu');
$('#userBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = userMenu.hidden;
  userMenu.hidden = !open;
  $('#userBtn').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', () => { userMenu.hidden = true; });

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('#openPwd').addEventListener('click', () => {
  userMenu.hidden = true;
  openDialog('Đổi mật khẩu', (b) => {
    const cur = field('Mật khẩu hiện tại', '', { type: 'password' });
    const n1 = field('Mật khẩu mới (≥ 8 ký tự)', '', { type: 'password' });
    const n2 = field('Nhập lại mật khẩu mới', '', { type: 'password' });
    b.append(cur.wrap, n1.wrap, n2.wrap);
  }, async () => {
    const inputs = $('#dialogBody').querySelectorAll('input');
    if (inputs[1].value !== inputs[2].value) return toast('Hai mật khẩu mới không khớp', true);
    try {
      await api('/api/password', {
        method: 'POST',
        body: JSON.stringify({ current: inputs[0].value, next: inputs[1].value }),
      });
      closeDialog();
      toast('Đã đổi mật khẩu');
    } catch (e) { toast(e.message, true); }
  });
});

$('#syncInfo').addEventListener('click', () => {
  userMenu.hidden = true;
  const d = state.meta.updatedAt ? new Date(state.meta.updatedAt).toLocaleString('vi-VN') : '—';
  openDialog('Nguồn dữ liệu', (b) => {
    b.append(
      el('p', null, 'Danh sách camera được đồng bộ từ Lark Base:'),
      el('p', null, state.meta.source || '—'),
      el('p', null, 'Cập nhật lần cuối: ' + d)
    );
    b.append(el('p', null, 'Để làm mới: chạy "node sync-lark.js" trong thư mục camera-web, sau đó khởi động lại server.'));
  }, async () => closeDialog(), 'Đóng');
});

/* ------------------------------------------------------------------ */
/* Sửa thông tin kết nối                                               */
/* ------------------------------------------------------------------ */
$('#editStore').addEventListener('click', () => {
  const s = state.stores.find((x) => x.id === state.currentId);
  if (!s) return;
  api(`/api/storecfg/${encodeURIComponent(s.id)}`).then((cfg) => {
    openDialog('Thông tin kết nối — ' + s.name, (b) => {
      const host = field('Địa chỉ (domain hoặc IP)', cfg.host || '');
      const port = field('Cổng web', cfg.port || '');
      const user = field('Tài khoản', cfg.user || 'admin');
      const pass = field('Mật khẩu', cfg.pass || '', { type: 'password' });
      const cams = field('Số camera', cfg.cameras || '');
      b.append(host.wrap, port.wrap, user.wrap, pass.wrap, cams.wrap);
      b.append(el('p', null, 'Thay đổi được lưu vào data/cameras.json trên máy chủ.'));
    }, async () => {
      const i = $('#dialogBody').querySelectorAll('input');
      try {
        await api(`/api/stores/${encodeURIComponent(s.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            host: i[0].value.trim(), port: i[1].value, user: i[2].value.trim(),
            pass: i[3].value, cameras: i[4].value,
          }),
        });
        closeDialog();
        toast('Đã lưu');
        await loadStores();
        selectStore(s.id);
      } catch (e) { toast(e.message, true); }
    });
  }).catch((e) => toast(e.message, true));
});

/* ------------------------------------------------------------------ */
/* Kiểm tra kết nối toàn bộ                                            */
/* ------------------------------------------------------------------ */
$('#refreshAll').addEventListener('click', async () => {
  const btn = $('#refreshAll');
  btn.disabled = true;
  toast('Đang kiểm tra kết nối các cơ sở…');
  const queue = state.stores.slice();
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const r = await api('/api/probe/' + encodeURIComponent(s.id), { method: 'POST' });
        s.online = r.ok;
      } catch { s.online = false; }
      done++;
      updateOnline(s.id, s.online === true);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  btn.disabled = false;
  const on = state.stores.filter((s) => s.online === true).length;
  toast(`Đã kiểm tra ${done} cơ sở — ${on} đang online`);
});

/* ------------------------------------------------------------------ */
/* Bộ lọc / tìm kiếm                                                   */
/* ------------------------------------------------------------------ */
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('is-active', c === b));
  state.unit = b.dataset.unit;
  renderStores();
});

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderStores();
});

$('#backBtn').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

$('#menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#sidebar').classList.toggle('open');
});

$('#rawToggle').addEventListener('click', async () => {
  const s = state.stores.find((x) => x.id === state.currentId);
  if (!s) return;
  if (state.raw) {
    state.raw = false;
  } else {
    const codec = await ensureCodec(s.id);
    if (codec !== 'h264') {
      toast('Đầu ghi này dùng HEVC — không xem trực tiếp luồng gốc được', true);
      return;
    }
    state.raw = true;
  }
  try { localStorage.setItem('lilycam.raw', state.raw ? '1' : '0'); } catch {}
  updateRawButton();
  renderGrid(s);
});

$('#layoutPick').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-l]');
  if (!b) return;
  state.layout = Number(b.dataset.l);
  state.page = 0;
  try { localStorage.setItem('lilycam.layout', String(state.layout)); } catch {}
  document.querySelectorAll('#layoutPick button').forEach((x) => x.classList.toggle('is-active', x === b));
  const s = state.stores.find((x) => x.id === state.currentId);
  if (s) renderGrid(s);
});

$('#prevPage').addEventListener('click', () => {
  if (state.page > 0) { state.page--; resumeTiles(); }
});
$('#nextPage').addEventListener('click', () => {
  state.page++;
  resumeTiles();
});

$('#liveAll').addEventListener('click', () => openViewer(state.currentId, 1));

$('#retryStore').addEventListener('click', async () => {
  const s = state.stores.find((x) => x.id === state.currentId);
  if (!s) return;
  const btn = $('#retryStore');
  btn.disabled = true;
  btn.textContent = 'Đang thử…';
  try {
    const r = await api('/api/probe/' + encodeURIComponent(s.id), { method: 'POST' });
    s.online = r.ok;
    $('#offlinePanel').hidden = r.ok;
    if (r.ok) {
      const st = $('#storeStatus');
      st.className = 'status-text ok';
      st.textContent = 'Đang kết nối';
      renderGrid(s);
    } else {
      $('#offlineMsg').textContent = r.error || 'Không kết nối được.';
    }
  } catch (e) {
    $('#offlineMsg').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Thử lại';
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTiles();
  else resumeTiles();
});

window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && state.stores.some((s) => s.id === id)) selectStore(id);
});

/* ------------------------------------------------------------------ */
/* Khởi động                                                           */
/* ------------------------------------------------------------------ */
document.querySelectorAll('#layoutPick button').forEach((b) => {
  b.classList.toggle('is-active', Number(b.dataset.l) === state.layout);
});
applyFit();

(async function boot() {
  try {
    const d = await api('/api/session');
    showApp(d.user);
    await loadStores();
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && state.stores.some((s) => s.id === id)) selectStore(id);
    else showEmpty(); // chưa bấm xem → không mở luồng nào, để camera "ngủ"
  } catch {
    showLogin();
  }
})();
