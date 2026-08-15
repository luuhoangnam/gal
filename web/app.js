import { createGrid, yieldToMain, DEFAULT_TARGET } from './grid.js';

const $ = (s) => document.querySelector(s);
const fmtN = (n) => n.toLocaleString('vi-VN');

const scroller = $('#scroller');
const sizer = $('#sizer');

const grid = createGrid({
  scroller,
  sizer,
  stick: $('#stick'),
  onViewport(keys) {
    // Best-effort: hàng đợi thumbnail chỉ ưu tiên lại, hỏng thì grid vẫn chạy
    fetch('/api/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    }).catch(() => {});
  },
  onOpen: (index) => openLightbox(index),
});

// PhotoSwipe chỉ tải khi người dùng thật sự mở ảnh đầu tiên — lưới hiện ra
// không phải chờ nó.
let lightbox = null;
async function openLightbox(index) {
  if (lightbox === null) {
    const { createLightbox } = await import('./lightbox.js');
    lightbox = createLightbox({ grid });
  }
  lightbox.open(index);
}

// ---------- trạng thái dữ liệu ----------
const items = new Map(); // id -> item
let dirty = false;
let scheduled = false;
let scanned = 0;
let metaDone = 0;
let phase = 'a';

function ingest(o) {
  const i = o.i ?? o.id; // pha A phát `i`, hàng từ cache phát `id`
  const prev = items.get(i);
  // Patch pha B chỉ mang metadata; không có pha A đi trước thì không dựng nổi item
  if (prev === undefined && o.p === undefined) return;
  const it = prev ?? {
    i,
    p: o.p,
    name: o.p.slice(o.p.lastIndexOf('/') + 1),
    v: o.v === 1,
    k: o.k,
    ar: 0,
    w: 0,
    h: 0,
    t: o.m,
    ds: null,
    dur: null,
  };
  if (o.k) it.k = o.k;
  // w/h từ server ĐÃ là kích thước lúc hiển thị: `exif-image` đảo theo EXIF
  // orientation và `video-meta` đảo theo rotation trước khi phát. Đảo lần nữa ở
  // đây là quay hai lần — mọi ảnh dọc chụp bằng máy cầm ngang sẽ sai tỉ lệ.
  if (o.w && o.h) {
    it.w = o.w;
    it.h = o.h;
    it.ar = o.w / o.h;
  }
  if (o.taken) {
    it.t = o.taken;
    it.ds = o.ds;
  }
  if (o.dur) it.dur = o.dur;
  items.set(i, it);
}

/** Sắp xếp giống server (`taken DESC, id DESC`) để thứ tự không đổi giữa hai nguồn. */
function rebuild() {
  dirty = false;
  const view = [...items.values()].sort((a, b) => b.t - a.t || b.i - a.i);
  grid.setView(view);
  updateStatus();
}

/**
 * Gom patch lại: pha B phát lô 200, re-layout mỗi lô là 350 lần sắp xếp 70k phần
 * tử. Neo scroll giữ đúng chỗ nên gom thưa hơn không ai thấy.
 */
function schedule() {
  dirty = true;
  if (scheduled) return;
  scheduled = true;
  setTimeout(
    () =>
      yieldToMain(() => {
        scheduled = false;
        if (dirty) rebuild();
      }),
    250,
  );
}

function updateStatus() {
  $('#cnt').textContent = `${fmtN(grid.count)} mục`;
  const bar = $('#scan');
  if (phase === 'done') {
    bar.style.width = '100%';
    bar.style.opacity = '0';
    $('#sub').textContent = `— ${fmtN(grid.count)} mục`;
    return;
  }
  const p = phase === 'a' ? 0.5 : 0.5 + (scanned > 0 ? (metaDone / scanned) * 0.5 : 0);
  bar.style.width = `${Math.min(99, p * 100)}%`;
  $('#sub').textContent =
    phase === 'a' ? `— đang quét… ${fmtN(items.size)} mục` : '— đang đọc ngày chụp…';
}

$('#empty').classList.remove('on');

// ---------- ingest NDJSON ----------
async function scan() {
  let res;
  try {
    res = await fetch('/api/scan');
  } catch {
    return fail('Không kết nối được server');
  }
  if (!res.ok) return fail('Server từ chối yêu cầu quét');

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line !== '') handle(JSON.parse(line));
    }
  }
  phase = 'done';
  if (dirty) rebuild();
  else updateStatus();
  if (items.size === 0) $('#empty').classList.add('on');
}

function handle(msg) {
  switch (msg.t) {
    case 'cache':
    case 'a':
    case 'b':
      for (const o of msg.items) ingest(o);
      if (msg.t === 'b') metaDone += msg.items.length;
      schedule();
      break;
    case 'done_a':
      scanned = msg.n;
      phase = 'b';
      break;
    case 'done_cache':
      rebuild();
      break;
    case 'done_b':
      phase = 'done';
      break;
  }
}

function fail(text) {
  phase = 'done';
  $('#sub').textContent = `— ${text}`;
  $('#scan').style.opacity = '0';
}

// ---------- điều khiển ----------
function setMode(m) {
  grid.setMode(m);
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  }
}

for (const b of document.querySelectorAll('[data-mode]')) {
  b.onclick = () => setMode(b.dataset.mode);
}
function setTarget(t) {
  grid.setTarget(t);
  $('#reset').textContent = `${Math.round((grid.target / DEFAULT_TARGET) * 100)}%`;
}
$('#plus').onclick = () => setTarget(grid.target * 1.25);
$('#minus').onclick = () => setTarget(grid.target / 1.25);
$('#reset').onclick = () => setTarget(DEFAULT_TARGET);

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (lightbox?.isOpen()) return; // lightbox tự lo phím của nó
  if (e.key === '+' || e.key === '=') setTarget(grid.target * 1.25);
  else if (e.key === '-') setTarget(grid.target / 1.25);
  else if (e.key === '0') setTarget(DEFAULT_TARGET);
  else if (e.key === '1') setMode('justified');
  else if (e.key === '2') setMode('square');
  else if (e.key === '3') setMode('masonry');
  else if (e.key === 'Home') scroller.scrollTop = 0;
  else if (e.key === 'End') scroller.scrollTop = sizer.offsetHeight;
  else return;
  e.preventDefault();
});

window.__gal = { grid, items };
scan();
