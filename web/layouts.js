/**
 * Toán layout thuần — không chạm DOM, nên test được bằng `node:test`.
 *
 * `justified-layout` của Flickr bị bỏ: công thức đóng H = W / Σ(aspect) viết được
 * trong ~15 dòng, còn thư viện thì không cập nhật từ 2022.
 */

export const GAP = 2;
export const PAD = 16;
export const HDR_H = 34;
const DAY = 864e5;

/** Ngày địa phương, không phải UTC — người xem nghĩ theo múi giờ của họ. */
export const dayKey = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / DAY);

/**
 * Tỉ lệ dùng để TÍNH layout bị kẹp: một ảnh panorama 10:1 kéo cả hàng justified
 * lùn xuống còn W/10. Ô vẫn `object-fit: cover` nên ảnh chỉ bị cắt, không méo.
 */
const AR_MIN = 1 / 3;
const AR_MAX = 3;
const arOf = (o) => (o.ar ? Math.min(AR_MAX, Math.max(AR_MIN, o.ar)) : 1);

/**
 * @param {Array} view - đã sắp xếp, mỗi item có `{ i, ar, t }`
 * @returns {{placed: Array, heads: Array, byId: Map, totalH: number}}
 */
export function layout(view, { mode = 'justified', width, target = 190 } = {}) {
  const W = Math.max(80, width);
  const placed = [];
  const heads = [];
  let y = 8;

  for (let s = 0; s < view.length; ) {
    const k = dayKey(view[s].t);
    let e = s;
    while (e < view.length && dayKey(view[e].t) === k) e++;

    heads.push({ y, h: HDR_H, t: view[s].t, n: e - s });
    y += HDR_H;

    const from = placed.length;
    if (mode === 'square') y = rowsSquare(view, s, e, W, target, placed, y);
    else if (mode === 'masonry') {
      y = rowsMasonry(view, s, e, W, target, placed, y);
      // Masonry rải theo cột nên y không tăng dần theo thứ tự view; binary search
      // dải hiển thị đòi hỏi placed[] sắp theo y, nên sắp lại từng nhóm.
      const g = placed.splice(from).sort((p, q) => p.y - q.y);
      for (const p of g) placed.push(p);
    } else y = rowsJustified(view, s, e, W, target, placed, y);

    s = e;
  }

  // Tra ô theo id — pha B đổi thứ tự sắp xếp nên chỉ số trỏ sang item khác
  const byId = new Map();
  for (let i = 0; i < placed.length; i++) byId.set(placed[i].o.i, i);

  return { placed, heads, byId, totalH: y + 40 };
}

function rowsJustified(view, s, e, W, target, placed, y) {
  let row = [];
  let sum = 0;

  const flush = (last) => {
    if (row.length === 0) return;
    let h = (W - GAP * (row.length - 1)) / sum;
    // Hàng cuối nhóm KHÔNG giãn cho đầy: giãn ra tạo một hàng cao bất thường,
    // phá nhịp lưới. Giữ chiều cao target, để hở bên phải.
    if (last) h = Math.min(h, target);
    let x = PAD;
    for (const o of row) {
      const w = arOf(o) * h;
      placed.push({ o, x, y, w, h });
      x += w + GAP;
    }
    y += h + GAP;
    row = [];
    sum = 0;
  };

  for (let i = s; i < e; i++) {
    row.push(view[i]);
    sum += arOf(view[i]);
    if (sum * target >= W - GAP * row.length) flush(false);
  }
  flush(true);
  return y + 18;
}

function rowsSquare(view, s, e, W, target, placed, y) {
  const cols = Math.max(2, Math.floor((W + GAP) / (target * 0.78 + GAP)));
  const cw = (W - GAP * (cols - 1)) / cols;
  for (let i = s; i < e; i++) {
    const c = (i - s) % cols;
    if (c === 0 && i > s) y += cw + GAP;
    placed.push({ o: view[i], x: PAD + c * (cw + GAP), y, w: cw, h: cw });
  }
  return y + cw + 22;
}

function rowsMasonry(view, s, e, W, target, placed, y) {
  const cols = Math.max(2, Math.floor((W + GAP) / (target * 1.05 + GAP)));
  const cw = (W - GAP * (cols - 1)) / cols;
  const ch = new Array(cols).fill(y);
  for (let i = s; i < e; i++) {
    let c = 0;
    for (let j = 1; j < cols; j++) if (ch[j] < ch[c]) c = j;
    const h = cw / arOf(view[i]);
    placed.push({ o: view[i], x: PAD + c * (cw + GAP), y: ch[c], w: cw, h });
    ch[c] += h + GAP;
  }
  return Math.max(...ch) + 20;
}

/**
 * Chốt ô neo theo **id ổn định**. Spike neo theo chỉ số và trôi 187px: mỗi lần
 * re-layout nó dò lại ô neo theo y nên danh tính ô đổi, sai số ~2,7px cộng dồn.
 */
export function anchorAt(placed, scrollTop, probe = 120) {
  const y = scrollTop + probe;
  let lo = 0;
  let hi = placed.length - 1;
  let k = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (placed[m].y < y) {
      k = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return k < 0 ? null : { id: placed[k].o.i, off: placed[k].y - scrollTop };
}

/** `scrollTop` mới giữ đúng ô neo ở nguyên chỗ cũ, hoặc null nếu ô neo đã biến mất. */
export function anchorTo(placed, byId, a) {
  if (!a) return null;
  const k = byId.get(a.id);
  if (k === undefined) return null;
  return placed[k].y - a.off;
}

/** Dải `[start, end)` của `placed` giao với [a, b]. O(log n). */
export function visibleRange(placed, a, b) {
  let lo = 0;
  let hi = placed.length - 1;
  let start = placed.length;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (placed[m].y + placed[m].h >= a) {
      start = m;
      hi = m - 1;
    } else lo = m + 1;
  }
  let end = start;
  while (end < placed.length && placed[end].y <= b) end++;
  return [start, end];
}
