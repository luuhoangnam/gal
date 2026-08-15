import { layout, anchorAt, anchorTo, visibleRange, PAD } from './layouts.js';

const OVER = 380; // overscan trên/dưới viewport, px
const STAGGER = 15; // ms giữa hai ô fade-in
const STAGGER_MAX = 8;

/**
 * WebKit thiếu **cả** `requestIdleCallback` **lẫn** `scheduler.postTask` (đo bằng
 * Playwright). Gọi thẳng cái nào cũng là `ReferenceError` chết app khi ai đó dán
 * URL vào Safari — 3 dòng shim đổi lấy chuyện đó là rẻ.
 */
export const yieldToMain = globalThis.scheduler?.postTask
  ? (fn) => scheduler.postTask(fn, { priority: 'background' })
  : (fn) => setTimeout(fn, 0);

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const fmtDur = (s) => `${(s / 60) | 0}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtDay = (t) => {
  const d = new Date(t);
  return `${d.getDate()} tháng ${d.getMonth() + 1}, ${d.getFullYear()}`;
};

export const DEFAULT_TARGET = 190;

export function createGrid({ scroller, sizer, stick, onViewport, onOpen }) {
  let view = [];
  let mode = 'justified';
  let target = DEFAULT_TARGET;
  let placed = [];
  let heads = [];
  let byId = new Map();
  let totalH = 0;

  // Pool gắn theo ID, không theo chỉ số. Pool theo chỉ số hỏng âm thầm: `alt` sai
  // ảnh, focus nhảy sang ảnh khác khi layout đổi, lightbox trả focus nhầm ô.
  const bound = new Map(); // id -> element
  const free = [];
  const headPool = [];

  let isCompensating = false;
  let rafPending = false;
  let viewportTimer = 0;

  /**
   * Ô neo, chốt theo id và GIỮ NGUYÊN qua nhiều lần re-layout. Spike dò lại ô neo
   * mỗi lần nên danh tính ô đổi giữa các lần, sai số ~2,7px cộng dồn thành 187px.
   * Chỉ bỏ neo khi người dùng thật sự cuộn.
   */
  let held = null;

  function relayout(probe) {
    if (held === null || probe !== undefined) {
      held = anchorAt(placed, scroller.scrollTop, probe ?? 8);
    }
    ({ placed, heads, byId, totalH } = layout(view, {
      mode,
      width: scroller.clientWidth - PAD * 2,
      target,
    }));
    sizer.style.height = `${totalH}px`;

    // Bù trong CÙNG tick với patch, trước khi paint — nếu không thì người xem
    // thấy một frame đã dịch chuyển rồi mới nhảy về.
    const want = anchorTo(placed, byId, held);
    if (want !== null) {
      isCompensating = true;
      scroller.scrollTop = Math.max(0, want);
      isCompensating = false;
      // Chạm đáy/đỉnh thì trình duyệt kẹp scrollTop; ghi lại độ lệch THẬT,
      // nếu không lần bù sau lại cố kéo về một vị trí không tồn tại.
      held.off = placed[byId.get(held.id)].y - scroller.scrollTop;
    }
    render();
  }

  function newTile() {
    const el = document.createElement('div');
    el.className = 'tile';
    // ARIA `list`, không phải `grid`: `grid` giả định số ô mỗi hàng đều nhau,
    // justified thì không.
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    el.innerHTML = '<img alt="" decoding="async" loading="lazy"><span class="vid"></span>';
    sizer.appendChild(el);
    return el;
  }

  function bind(el, o) {
    const img = el.firstChild;
    img.alt = o.name;
    img.classList.remove('in');
    img.src = `/api/thumb/${o.k}.jpg`;
    el.dataset.id = o.i;
    const vid = el.lastChild;
    vid.hidden = !o.v;
    vid.textContent = o.v && o.dur ? fmtDur(o.dur) : '';
  }

  function release(el) {
    el.hidden = true;
    // Nhả tham chiếu tới ảnh đã giải mã. Đo được là chỉ ~3% RAM — cache ảnh của
    // browser mới giữ phần lớn — nhưng đây là phần duy nhất ta điều khiển được.
    el.firstChild.removeAttribute('src');
    free.push(el);
  }

  function render() {
    const top = scroller.scrollTop;
    const vh = scroller.clientHeight;
    let [start, end] = visibleRange(placed, top - OVER, top + vh + OVER);
    // Ô cao bất thường (panorama dựng đứng) làm vị từ binary search không đơn điệu
    // tuyệt đối; lùi vài ô là đủ bù, rẻ hơn nhiều so với quét tuyến tính.
    start = Math.max(0, start - 8);

    const keep = new Set();
    for (let i = start; i < end; i++) keep.add(placed[i].o.i);
    for (const [id, el] of bound) {
      if (keep.has(id)) continue;
      bound.delete(id);
      release(el);
    }

    let fresh = 0;
    for (let i = start; i < end; i++) {
      const p = placed[i];
      let el = bound.get(p.o.i);
      if (el === undefined) {
        el = free.pop() ?? newTile();
        bound.set(p.o.i, el);
        bind(el, p.o);
        el.hidden = false;
        const img = el.firstChild;
        const delay = reduced.matches ? 0 : Math.min(fresh++, STAGGER_MAX - 1) * STAGGER;
        img.style.transitionDelay = `${delay}ms`;
        if (img.complete) img.classList.add('in');
        else img.onload = () => img.classList.add('in');
      }
      el.classList.toggle('pending', !p.o.ar);
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
      el.style.width = `${p.w}px`;
      el.style.height = `${p.h}px`;
    }

    renderHeads(top - OVER, top + vh + OVER);
    renderStick(top);
  }

  function renderHeads(a, b) {
    let n = 0;
    const w = scroller.clientWidth - PAD * 2;
    for (const h of heads) {
      if (h.y + h.h < a || h.y > b) continue;
      let el = headPool[n];
      if (el === undefined) {
        el = document.createElement('div');
        el.className = 'hdr';
        sizer.appendChild(el);
        headPool.push(el);
      }
      el.hidden = false;
      el.style.transform = `translate(${PAD}px,${h.y}px)`;
      el.style.width = `${w}px`;
      el.innerHTML = `${fmtDay(h.t)} <em>${h.n.toLocaleString('vi-VN')} mục</em>`;
      n++;
    }
    for (let i = n; i < headPool.length; i++) headPool[i].hidden = true;
  }

  function renderStick(top) {
    let cur = null;
    for (const h of heads) {
      if (h.y <= top + 46) cur = h;
      else break;
    }
    stick.textContent = cur ? fmtDay(cur.t) : '';
    stick.classList.toggle('on', cur !== null && top > 40);
  }

  /** Báo vùng đang xem để hàng đợi thumbnail phục vụ chỗ đó trước. */
  function reportViewport() {
    if (onViewport === undefined) return;
    const top = scroller.scrollTop;
    const [s, e] = visibleRange(placed, top, top + scroller.clientHeight);
    const keys = [];
    for (let i = s; i < e; i++) if (placed[i].o.k) keys.push(placed[i].o.k);
    onViewport(keys);
  }

  scroller.addEventListener(
    'scroll',
    () => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          render();
        });
      }
      // Sự kiện do CHÍNH ta bù ra không phải người dùng cuộn; không phân biệt
      // được từ `scroll` nên phải dùng cờ.
      if (isCompensating) return;
      held = null; // người dùng cuộn → neo cũ hết ý nghĩa, lần sau dò lại
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(reportViewport, 150);
    },
    { passive: true },
  );

  addEventListener('resize', () => relayout(8));

  // Uỷ quyền trên container: 2000 ô mà gắn listener từng ô là 2000 lần đăng ký
  // mỗi lần re-layout.
  function openFrom(el) {
    const i = byId.get(Number(el.dataset.id));
    if (i !== undefined) onOpen?.(i);
  }
  sizer.addEventListener('click', (e) => {
    const el = e.target.closest?.('.tile');
    if (el) openFrom(el);
  });
  sizer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest?.('.tile');
    if (!el) return;
    e.preventDefault();
    openFrom(el);
  });

  return {
    get mode() {
      return mode;
    },
    get target() {
      return target;
    },
    get count() {
      return view.length;
    },
    setView(next) {
      view = next;
      relayout();
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      relayout(8);
    },
    /** Đổi mật độ neo vào tâm viewport — ảnh đang nhìn phải ở nguyên tâm. */
    setTarget(t) {
      const next = Math.max(90, Math.min(400, t));
      if (next === target) return;
      target = next;
      relayout(scroller.clientHeight / 2);
    },
    relayout,
    render,
    /** Item ở vị trí hiển thị `i` — lightbox đi theo đúng thứ tự mắt thấy. */
    at: (i) => placed[i]?.o,
    /**
     * Ảnh thumbnail của item, hoặc undefined nếu ô đã bị ảo hoá khỏi DOM.
     * PhotoSwipe dùng nó làm gốc zoom; không có thì nó tự lùi về fade.
     */
    tileImg(id) {
      const el = bound.get(id);
      return el && !el.hidden ? el.firstChild : undefined;
    },
    /** Cuộn tới item rồi trả focus về ô của nó — dùng khi đóng lightbox. */
    focusId(id) {
      const i = byId.get(id);
      if (i === undefined) return;
      const p = placed[i];
      const top = scroller.scrollTop;
      if (p.y < top || p.y + p.h > top + scroller.clientHeight) {
        scroller.scrollTop = p.y - scroller.clientHeight / 2 + p.h / 2;
        render();
      }
      bound.get(id)?.focus({ preventScroll: true });
    },
    /** Cho script đo tự động (Playwright) và test hồi quy trôi scroll. */
    get placed() {
      return placed;
    },
    get domNodes() {
      return sizer.childElementCount;
    },
  };
}
