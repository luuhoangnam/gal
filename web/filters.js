/**
 * Lọc / sắp xếp / nhóm — hàm thuần, không chạm DOM nên test bằng `node:test`.
 *
 * Không có Web Worker: plan bảo đo trước. Đo trên 70k item — lọc 3ms, sort theo
 * ngày 17ms, sort theo tên (localeCompare) 30ms. Đều dưới ngưỡng 50ms, nên
 * worker chỉ thêm một tầng postMessage để giải quyết một vấn đề không tồn tại.
 * Cũng không dựng sẵn `Map<dir, id[]>`: quét tuyến tính 70k đã là 3ms.
 */

export const DEFAULTS = {
  type: 'all', // all | image | video
  dir: '', // thư mục con, gồm cả cây bên dưới
  from: '', // YYYY-MM-DD
  to: '',
  minMB: 0,
  maxMB: 0,
  q: '',
  sort: 'date', // date | name | size
  asc: false,
  group: 'day', // day | month | year | none
};

const MB = 1024 * 1024;

/** Nửa đêm địa phương của "YYYY-MM-DD", hoặc null. Ngày người dùng nghĩ là ngày ở đây. */
export function dayStart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}

const cmp = {
  date: (a, b) => a.t - b.t || a.i - b.i,
  name: (a, b) => a.name.localeCompare(b.name) || a.i - b.i,
  size: (a, b) => a.s - b.s || a.i - b.i,
};

/**
 * @param {Iterable} items
 * @param {object} c tiêu chí, thiếu trường nào thì lấy từ DEFAULTS
 * @returns {Array} view đã lọc và sắp xếp
 */
export function applyFilters(items, c = {}) {
  const f = { ...DEFAULTS, ...c };
  const from = dayStart(f.from);
  // `to` là cả ngày đó, không phải 00:00 của nó — người dùng chọn 20/3 nghĩa là
  // gồm ảnh chụp 23:59 ngày 20/3.
  const toStart = dayStart(f.to);
  const to = toStart === null ? null : toStart + 864e5;
  const min = f.minMB > 0 ? f.minMB * MB : 0;
  const max = f.maxMB > 0 ? f.maxMB * MB : Infinity;
  const q = f.q.trim().toLowerCase();
  const prefix = f.dir ? f.dir + '/' : '';

  const out = [];
  for (const o of items) {
    if (f.type === 'image' && o.v) continue;
    if (f.type === 'video' && !o.v) continue;
    if (prefix && !o.p.startsWith(prefix)) continue;
    if (from !== null && o.t < from) continue;
    if (to !== null && o.t >= to) continue;
    if (o.s < min || o.s > max) continue;
    if (q && !o.name.toLowerCase().includes(q)) continue;
    out.push(o);
  }

  out.sort(cmp[f.sort] ?? cmp.date);
  if (!f.asc) out.reverse();
  return out;
}

/** Có tiêu chí nào khác mặc định không — dùng để bật/tắt nút "Xoá lọc". */
export function isFiltered(c = {}) {
  const f = { ...DEFAULTS, ...c };
  return ['type', 'dir', 'from', 'to', 'minMB', 'maxMB', 'q'].some((k) => f[k] !== DEFAULTS[k]);
}

/** Mô tả bộ lọc đang áp bằng tiếng người, cho empty state. */
export function describe(c = {}) {
  const f = { ...DEFAULTS, ...c };
  const parts = [];
  if (f.type !== 'all') parts.push(f.type === 'video' ? 'chỉ video' : 'chỉ ảnh');
  if (f.dir) parts.push(`trong ${f.dir}`);
  if (f.from) parts.push(`từ ${f.from}`);
  if (f.to) parts.push(`đến ${f.to}`);
  if (f.minMB > 0) parts.push(`≥ ${f.minMB} MB`);
  if (f.maxMB > 0) parts.push(`≤ ${f.maxMB} MB`);
  if (f.q.trim()) parts.push(`tên chứa “${f.q.trim()}”`);
  return parts.join(', ');
}

/**
 * Danh sách thư mục kèm số item TÍNH CẢ cây con — click một thư mục là muốn thấy
 * mọi ảnh bên dưới nó, nên con số phải khớp với cái bộ lọc sẽ trả về.
 */
export function folders(items) {
  const n = new Map();
  for (const o of items) {
    const cut = o.p.lastIndexOf('/');
    if (cut <= 0) continue;
    let d = o.p.slice(0, cut);
    for (;;) {
      n.set(d, (n.get(d) ?? 0) + 1);
      const up = d.lastIndexOf('/');
      if (up <= 0) break;
      d = d.slice(0, up);
    }
  }
  return [...n]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, count]) => ({ path, count, depth: path.split('/').length - 1 }));
}

/** Tiêu chí ⇄ URL hash. Chỉ ghi trường khác mặc định để hash ngắn và đọc được. */
export function toHash(c) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...DEFAULTS, ...c })) {
    if (v !== DEFAULTS[k]) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '#' + s : '';
}

export function fromHash(hash) {
  const p = new URLSearchParams((hash ?? '').replace(/^#/, ''));
  const c = {};
  for (const [k, v] of p) {
    if (!(k in DEFAULTS)) continue;
    if (typeof DEFAULTS[k] === 'number') c[k] = Number(v) || 0;
    else if (typeof DEFAULTS[k] === 'boolean') c[k] = v === 'true' || v === '1';
    else c[k] = v;
  }
  return c;
}
