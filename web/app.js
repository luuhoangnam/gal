import { createGrid, yieldToMain, DEFAULT_TARGET } from './grid.js';
import { createScrubber } from './scrubber.js';
import { bindKeyboard } from './keyboard.js';
import {
  DEFAULTS,
  applyFilters,
  describe,
  folders,
  fromHash,
  isFiltered,
  toHash,
} from './filters.js';

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

const scrubber = createScrubber({ el: $('#scrub'), scroller, grid });

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

// ---------- trạng thái ----------
const items = new Map(); // id -> item
let criteria = { ...DEFAULTS, ...fromHash(location.hash) };
let dirty = false;
let scheduled = false;
let scanned = 0;
let metaDone = 0;
let phase = 'a';
let busy = false;
let pending = false;
// Pha A là danh sách file THẬT đang có. Id nào không xuất hiện trong lượt quét
// là file đã bị xoá/đổi tên — không có tập này thì quét lại chỉ thêm, không bớt.
let seen = null;
let readonly = false;
// Từ `done_a`: đường dẫn đã quét, số bundle và thư mục bị bỏ qua. Empty state
// không có mấy con số này thì chỉ là câu "không có ảnh" vô dụng.
let info = { root: '', bundles: 0, skipped: 0, denied: [] };

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
    s: o.s ?? 0,
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

/** Nhóm theo ngày chỉ có nghĩa khi view đang xếp theo ngày. */
const effectiveGroup = () => (criteria.sort === 'date' ? criteria.group : 'none');

function rebuild() {
  dirty = false;
  grid.setGroup(effectiveGroup());
  grid.setView(applyFilters(items.values(), criteria));
  scrubber.build();
  // Thanh năm chỉ đúng khi thứ tự là thời gian; xếp theo tên thì năm nhảy loạn.
  $('#scrub').hidden = criteria.sort !== 'date' || grid.count < 2;
  updateStatus();
  updateEmpty();
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
    bar.style.transform = 'scaleX(1)';
    bar.style.opacity = '0';
    $('#sub').textContent = `— ${fmtN(items.size)} mục`;
    return;
  }
  const p = phase === 'a' ? 0.5 : 0.5 + (scanned > 0 ? (metaDone / scanned) * 0.5 : 0);
  bar.style.transform = `scaleX(${Math.min(0.99, p)})`;
  announce(phase === 'a' ? `Đang quét, ${fmtN(items.size)} mục.` : 'Đang đọc ngày chụp.');
  $('#sub').textContent =
    phase === 'a' ? `— đang quét… ${fmtN(items.size)} mục` : '— đang đọc ngày chụp…';
}

function updateEmpty() {
  const filtered = isFiltered(criteria);
  const none = grid.count === 0;
  const scanning = phase !== 'done';
  // Chưa có ảnh nào mà vẫn đang quét → khung nhịp thở, không phải "trống rỗng"
  $('#skel').classList.toggle('on', none && scanning && items.size === 0);
  $('#empty').classList.toggle('on', none && !scanning);
  $('#emptytitle').textContent = filtered
    ? 'Không có mục nào khớp bộ lọc'
    : 'Không tìm thấy ảnh hay video nào';
  $('#emptysub').textContent = filtered
    ? `Đang lọc: ${describe(criteria)}`
    : `Đã quét ${info.root || 'thư mục này'} và mọi thư mục con.`;

  const hint = $('#emptyhint');
  hint.replaceChildren();
  if (!filtered) {
    if (info.bundles > 0) {
      // Trên máy Mac điển hình phần lớn ảnh nằm trong .photoslibrary, bị bỏ qua
      // mặc định — nói thẳng ra cùng lệnh để quét vào.
      hint.append(
        `Đã bỏ qua ${fmtN(info.bundles)} thư viện ảnh (.photoslibrary, .aplibrary…). Quét cả chúng: `,
      );
      hint.append(Object.assign(document.createElement('code'), { textContent: 'gal --include-bundles' }));
    }
    if (info.denied.length > 0) {
      const p = document.createElement('span');
      p.textContent =
        `Không đọc được ${fmtN(info.skipped)} thư mục, ví dụ ${info.denied[0]}. ` +
        'Cấp quyền ở Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Toàn bộ ổ đĩa.';
      hint.append(p);
    }
  }
  $('#emptyclear').hidden = !filtered;
  $('#clear').hidden = !filtered;
}

/**
 * Tiến trình cho screen reader, tối đa 5 giây một lần. Đọc theo từng ảnh thì
 * VoiceOver nói không dứt và người dùng không nghe được gì khác.
 */
let liveAt = 0;
function announce(text, force = false) {
  const now = Date.now();
  if (!force && now - liveAt < 5000) return;
  liveAt = now;
  $('#live').textContent = text;
}

// ---------- ingest NDJSON ----------
async function scan() {
  // Đang quét mà có thay đổi mới: hẹn quét lại một lượt sau, không chồng hai
  // stream lên cùng một Map
  if (busy) {
    pending = true;
    return;
  }
  pending = false;
  busy = true;
  $('#refresh').disabled = true;
  scanned = 0;
  metaDone = 0;
  phase = 'a';
  seen = new Set();
  readonly = false;

  let res;
  try {
    res = await fetch('/api/scan');
  } catch {
    busy = false;
    $('#refresh').disabled = false;
    return fail('Không kết nối được server');
  }
  if (!res.ok) {
    busy = false;
    $('#refresh').disabled = false;
    return fail('Server từ chối yêu cầu quét');
  }

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
  busy = false;
  $('#refresh').disabled = false;
  rebuild();
  renderFolders();
  announce(`Quét xong, ${fmtN(items.size)} mục.`, true);
  demoState(); // ép lại sau khi quét xong, nếu không dữ liệu thật ghi đè lên
  if (pending) scan();
}

function handle(msg) {
  switch (msg.t) {
    case 'cache':
    case 'a':
    case 'b':
      for (const o of msg.items) ingest(o);
      if (msg.t === 'a') for (const o of msg.items) seen?.add(o.i);
      if (msg.t === 'b') metaDone += msg.items.length;
      schedule();
      break;
    case 'done_a':
      scanned = msg.n;
      phase = 'b';
      readonly = Boolean(msg.readonly);
      info = {
        root: msg.root ?? '',
        bundles: msg.bundles ?? 0,
        skipped: msg.skipped ?? 0,
        denied: msg.denied ?? [],
      };
      announce(`Đã tìm thấy ${fmtN(scanned)} mục, đang đọc ngày chụp.`, true);
      renderFolders();
      break;
    case 'done_cache':
      rebuild();
      renderFolders();
      break;
    case 'done_b':
      phase = 'done';
      // Index chỉ-đọc phát id tạm (âm), không so được với id từ cache → không prune
      if (!readonly && seen) {
        for (const id of items.keys()) if (!seen.has(id)) items.delete(id);
        schedule();
      }
      break;
  }
}

function fail(text) {
  phase = 'done';
  busy = false;
  pending = false;
  $('#sub').textContent = `— ${text}`;
  $('#scan').style.opacity = '0';
}

// ---------- bộ lọc ----------
function setCriteria(patch, { relayoutSide = false } = {}) {
  criteria = { ...criteria, ...patch };
  history.replaceState(null, '', toHash(criteria) || location.pathname);
  syncControls();
  rebuild();
  if (relayoutSide) grid.relayout(8);
}

function syncControls() {
  $('#q').value = criteria.q;
  $('#from').value = criteria.from;
  $('#to').value = criteria.to;
  $('#minmb').value = criteria.minMB || '';
  $('#maxmb').value = criteria.maxMB || '';
  $('#sort').value = criteria.sort;
  $('#group').value = criteria.group;
  $('#asc').textContent = criteria.asc ? '↑' : '↓';
  $('#group').disabled = criteria.sort !== 'date';
  for (const b of document.querySelectorAll('[data-type]')) {
    b.setAttribute('aria-pressed', String(b.dataset.type === criteria.type));
  }
  for (const b of document.querySelectorAll('.dir')) {
    b.setAttribute('aria-pressed', String(b.dataset.dir === criteria.dir));
  }
}

/**
 * Cây thư mục: danh sách thụt lề theo độ sâu, không có nút thu gọn.
 * ponytail: thu gọn/mở rộng thêm trạng thái cho mỗi nhánh mà không cho biết
 * thêm thông tin gì — danh sách đã cuộn được và đã hiện số mục mỗi nhánh.
 */
function renderFolders() {
  const list = folders(items.values());
  $('#dirs').replaceChildren(
    ...list.map((d) => {
      const b = document.createElement('button');
      b.className = 'dir';
      b.dataset.dir = d.path;
      b.style.paddingLeft = `${10 + d.depth * 12}px`;
      b.setAttribute('aria-pressed', String(d.path === criteria.dir));
      b.append(
        d.path.slice(d.path.lastIndexOf('/') + 1),
        Object.assign(document.createElement('em'), { textContent: fmtN(d.count) }),
      );
      b.onclick = () => setCriteria({ dir: d.path });
      return b;
    }),
  );
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
  grid.setTarget(t || DEFAULT_TARGET);
  $('#reset').textContent = `${Math.round((grid.target / DEFAULT_TARGET) * 100)}%`;
}
$('#plus').onclick = () => setTarget(grid.target * 1.25);
$('#minus').onclick = () => setTarget(grid.target / 1.25);
$('#reset').onclick = () => setTarget(0);

for (const b of document.querySelectorAll('[data-type]')) {
  b.onclick = () => setCriteria({ type: b.dataset.type });
}
$('#from').onchange = () => setCriteria({ from: $('#from').value });
$('#to').onchange = () => setCriteria({ to: $('#to').value });
$('#minmb').onchange = () => setCriteria({ minMB: Number($('#minmb').value) || 0 });
$('#maxmb').onchange = () => setCriteria({ maxMB: Number($('#maxmb').value) || 0 });
$('#sort').onchange = () => setCriteria({ sort: $('#sort').value });
$('#group').onchange = () => setCriteria({ group: $('#group').value });
$('#asc').onclick = () => setCriteria({ asc: !criteria.asc });

// Lọc theo tên có debounce: chạy lại 70k mỗi lần gõ phím là nguồn jank thật sự
let qTimer = 0;
$('#q').oninput = () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => setCriteria({ q: $('#q').value }), 80);
};

const clearFilters = () =>
  setCriteria({ type: 'all', dir: '', from: '', to: '', minMB: 0, maxMB: 0, q: '' });
$('#clear').onclick = clearFilters;
$('#emptyclear').onclick = clearFilters;
for (const b of document.querySelectorAll('#side > .dir')) {
  b.onclick = () => setCriteria({ dir: '' });
}

$('#sidetoggle').onclick = () => {
  const open = $('#side').hidden;
  $('#side').hidden = !open;
  $('#sidetoggle').setAttribute('aria-pressed', String(open));
  document.body.classList.toggle('side-on', open);
  grid.relayout(8); // bề rộng lưới đổi → phải xếp lại, giữ nguyên ô đang xem
};

$('#helpbtn').onclick = () => $('#help').showModal();

// Nhảy tới ngày: dùng luôn date picker native thay vì tự vẽ lịch
const goto_ = $('#goto');
goto_.onchange = () => {
  const t = new Date(goto_.value).getTime();
  if (!Number.isFinite(t)) return;
  // View xếp giảm dần theo ngày → ô đầu tiên có t <= mốc chọn
  const i = grid.placed.findIndex((p) => (criteria.asc ? p.o.t >= t : p.o.t <= t));
  if (i >= 0) grid.focusIndex(i);
};

$('#refresh').onclick = () => scan();

/**
 * `--watch`: server giữ kết nối tới khi thư mục đổi rồi mới trả `rev` mới.
 * 204 nghĩa là server không bật watch — dừng hỏi, nút ↻ vẫn dùng được.
 */
async function watchLoop() {
  let rev = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(`/api/watch?rev=${rev}`);
    } catch {
      return; // server tắt hoặc mất mạng: thôi, không quay vòng vô ích
    }
    if (res.status !== 200) return;
    const { rev: next } = await res.json();
    if (next > rev) {
      rev = next;
      await scan();
    }
  }
}

bindKeyboard({
  grid,
  lightbox: () => lightbox,
  help: $('#help'),
  actions: {
    open: openLightbox,
    mode: setMode,
    density: (f) => setTarget(f === 0 ? 0 : grid.target * f),
    isFiltered: () => isFiltered(criteria),
    clearFilters,
    focusFilter: () => $('#q').focus(),
    refresh: () => scan(),
    jumpToDate: () => (goto_.showPicker ? goto_.showPicker() : goto_.focus()),
  },
});

addEventListener('hashchange', () => {
  criteria = { ...DEFAULTS, ...fromHash(location.hash) };
  syncControls();
  rebuild();
});

/**
 * `?state=` để xem từng trạng thái mà không phải dựng thư mục giả cho mỗi cái.
 * Chỉ ép phần hiển thị, không đụng dữ liệu.
 */
function demoState() {
  const want = new URLSearchParams(location.search).get('state');
  if (!want) return;
  if (want === 'scanning') {
    phase = 'a';
    items.clear();
    rebuild();
  } else if (want === 'bundles' || want === 'denied' || want === 'empty') {
    phase = 'done';
    info = {
      root: info.root || '/Users/ai-do/Pictures',
      bundles: want === 'bundles' ? 3 : 0,
      skipped: want === 'denied' ? 12 : 0,
      denied: want === 'denied' ? ['/Users/ai-do/Pictures/Ảnh riêng'] : [],
    };
    items.clear();
    rebuild();
  } else if (want === 'filter') {
    setCriteria({ q: 'không-khớp-gì-cả' });
  }
}
demoState();

syncControls();
setTarget(0);
window.__gal = { grid, items, get criteria() { return criteria; }, setCriteria, applyFilters };
scan();
watchLoop();
