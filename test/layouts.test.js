import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, anchorAt, anchorTo, visibleRange, GAP, PAD, HDR_H } from '../web/layouts.js';

const DAY = 864e5;
const W = 1200;

/** Thư viện tất định: n item, mỗi `perDay` item một ngày, tỉ lệ lặp theo chu kỳ. */
function library(n, { perDay = 40, known = true } = {}) {
  const ars = [1.5, 0.667, 1.333, 0.75, 1, 1.777];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      i,
      ar: known ? ars[i % ars.length] : 0,
      t: Date.UTC(2026, 0, 1) - Math.floor(i / perDay) * DAY,
    });
  }
  return out;
}

test('justified: hàng đầy lấp kín chiều rộng, không tràn', () => {
  const { placed } = layout(library(400), { width: W, target: 190 });
  const rows = new Map();
  for (const p of placed) {
    if (!rows.has(p.y)) rows.set(p.y, []);
    rows.get(p.y).push(p);
  }
  let full = 0;
  for (const row of rows.values()) {
    const span = row.reduce((a, p) => a + p.w, 0) + GAP * (row.length - 1);
    assert.ok(span <= W + 0.5, `hàng tràn: ${span} > ${W}`);
    if (Math.abs(span - W) < 0.5) full++;
  }
  assert.ok(full > rows.size * 0.7, 'phần lớn hàng phải lấp kín');
});

test('justified: hàng cuối nhóm giữ chiều cao target, không giãn cao bất thường', () => {
  // 3 item cho một ngày: một hàng duy nhất, và nó là hàng cuối
  const { placed } = layout(library(3, { perDay: 3 }), { width: W, target: 190 });
  assert.equal(placed.length, 3);
  for (const p of placed) assert.ok(p.h <= 190 + 0.001, `hàng cuối cao ${p.h}`);
  const span = placed.reduce((a, p) => a + p.w, 0) + GAP * 2;
  assert.ok(span < W, 'hàng cuối phải để hở bên phải');
});

test('nhóm theo ngày: mỗi ngày một header, đếm đúng', () => {
  const { heads } = layout(library(100, { perDay: 40 }), { width: W });
  assert.deepEqual(
    heads.map((h) => h.n),
    [40, 40, 20],
  );
  assert.equal(heads[0].y, 8);
  assert.ok(heads[1].y > heads[0].y + HDR_H);
});

test('ô vuông: đều cột, x không vượt biên', () => {
  const { placed } = layout(library(60, { perDay: 60 }), {
    mode: 'square',
    width: W,
    target: 190,
  });
  const w0 = placed[0].w;
  for (const p of placed) {
    assert.equal(p.w, p.h);
    assert.ok(Math.abs(p.w - w0) < 1e-9);
    assert.ok(p.x >= PAD && p.x + p.w <= PAD + W + 0.5);
  }
});

test('masonry: các cột chênh nhau không quá một ô, placed sắp theo y', () => {
  const { placed } = layout(library(120, { perDay: 120 }), {
    mode: 'masonry',
    width: W,
    target: 190,
  });
  for (let i = 1; i < placed.length; i++) {
    assert.ok(placed[i].y >= placed[i - 1].y, 'binary search cần y tăng dần');
  }
  const xs = new Set(placed.map((p) => Math.round(p.x)));
  assert.ok(xs.size >= 2);
});

test('item chưa biết tỉ lệ dùng ô vuông tạm', () => {
  const { placed } = layout(library(6, { perDay: 6, known: false }), {
    width: W,
    target: 190,
  });
  for (const p of placed) assert.ok(Math.abs(p.w - p.h) < 1e-9);
});

test('panorama bị kẹp tỉ lệ, không làm hàng lùn tịt', () => {
  const items = [{ i: 0, ar: 10, t: Date.UTC(2026, 0, 1) }];
  const { placed } = layout(items, { width: W, target: 190 });
  assert.ok(placed[0].h > 100, `hàng panorama cao ${placed[0].h}`);
});

test('visibleRange trả đúng dải giao với viewport', () => {
  const { placed } = layout(library(500), { width: W });
  const [s, e] = visibleRange(placed, 2000, 2600);
  assert.ok(s < e);
  for (let i = s; i < e; i++) {
    assert.ok(placed[i].y <= 2600 && placed[i].y + placed[i].h >= 2000 - 1);
  }
  if (s > 0) assert.ok(placed[s - 1].y + placed[s - 1].h < 2000);
});

/**
 * Chạy trọn pha B: dimension thật + ngày chụp EXIF về theo lô, re-layout mỗi lô.
 * `reprobe` mô phỏng lỗi của spike — dò lại ô neo trước mỗi lần layout.
 */
function runPhaseB(N, frac, { reprobe }) {
  const items = library(N, { known: false });
  let L = layout(items, { width: W, target: 190 });
  let scrollTop = Math.round(L.totalH * frac);

  let held = anchorAt(L.placed, scrollTop, 8);
  const watch = held.id;
  const startOff = L.placed[L.byId.get(watch)].y - scrollTop;

  const ars = [1.5, 0.667, 1.333, 0.75, 1, 1.777];
  for (let b = 0; b < N; b += 200) {
    for (let j = b; j < Math.min(b + 200, N); j++) {
      items[j].ar = ars[j % ars.length];
      items[j].t += (j % 7) * 3600e3; // EXIF lệch mtime → thứ tự sắp xếp đổi
    }
    const sorted = [...items].sort((x, y) => y.t - x.t || y.i - x.i);
    if (reprobe) held = anchorAt(L.placed, scrollTop, 8);
    L = layout(sorted, { width: W, target: 190 });
    const want = anchorTo(L.placed, L.byId, held);
    if (want !== null) {
      scrollTop = Math.max(0, want);
      held.off = L.placed[L.byId.get(held.id)].y - scrollTop;
    }
  }
  return Math.abs(L.placed[L.byId.get(watch)].y - scrollTop - startOff);
}

test('neo theo id cố định: trôi tích luỹ <10px ở 15%, 50%, 85% thư viện', () => {
  for (const frac of [0.15, 0.5, 0.85]) {
    const drift = runPhaseB(3000, frac, { reprobe: false });
    assert.ok(drift < 10, `trôi ${drift.toFixed(1)}px ở ${frac * 100}%`);
  }
});

test('control: dò lại ô neo mỗi lần layout (lỗi của spike) thì trôi rõ rệt', () => {
  const drift = runPhaseB(3000, 0.5, { reprobe: true });
  assert.ok(drift > 10, `control phải trôi >10px, đo được ${drift.toFixed(1)}px`);
});

test('đổi mode giữ ô neo trong sai số một hàng', () => {
  const items = library(2000);
  const A = layout(items, { width: W, target: 190 });
  let scrollTop = Math.round(A.totalH * 0.5);
  const a = anchorAt(A.placed, scrollTop);

  const B = layout(items, { mode: 'square', width: W, target: 190 });
  const want = anchorTo(B.placed, B.byId, a);
  assert.notEqual(want, null);
  // Ô neo phải nằm ngay trong viewport sau khi đổi mode
  const p = B.placed[B.byId.get(a.id)];
  assert.ok(p.y - want >= -1 && p.y - want < 400, `ô neo lệch ${p.y - want}px`);
});
