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

/**
 * 7431s → `2:03:51`, không phải `123:51`. Làm tròn giây TRƯỚC khi chia, nếu
 * không 3599.7s ra `59:60`.
 */
export function fmtDur(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = (t / 3600) | 0;
  const m = ((t % 3600) / 60) | 0;
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const fmtHead = (t, group) => {
  const d = new Date(t);
  if (group === 'year') return String(d.getFullYear());
  if (group === 'month') return `Tháng ${d.getMonth() + 1}, ${d.getFullYear()}`;
  return `${d.getDate()} tháng ${d.getMonth() + 1}, ${d.getFullYear()}`;
};

export const DEFAULT_TARGET = 190;

export function createGrid({ scroller, sizer, stick, onViewport, onOpen }) {
  let view = [];
  let mode = 'justified';
  let target = DEFAULT_TARGET;
  let group = 'day';
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

  /** Ô đang mang tabindex=0 (roving) và được giữ lại trong DOM khi cuộn xa. */
  let activeId = null;

  function relayout(probe) {
    if (held === null || probe !== undefined) {
      held = anchorAt(placed, scroller.scrollTop, probe ?? 8);
    }
    ({ placed, heads, byId, totalH } = layout(view, {
      mode,
      width: scroller.clientWidth - PAD * 2,
      target,
      group,
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
    el.tabIndex = -1;
    el.innerHTML =
      '<img alt="" decoding="async" loading="lazy"><span class="nm"></span><span class="vid"></span>';
    sizer.appendChild(el);
    return el;
  }

  function bind(el, o) {
    const img = el.firstChild;
    // alt = tên + ngày: screen reader đọc "IMG_2451.jpg, 5 tháng 8, 2026" chứ
    // không phải một danh sách tên file trần trụi.
    // Badge thời lượng chỉ là chữ trên ảnh; screen reader không nghe được nếu
    // không đưa vào alt
    img.alt = `${o.name}, ${fmtHead(o.t, 'day')}${o.v && o.dur ? `, video ${fmtDur(o.dur)}` : ''}`;
    img.classList.remove('in');
    img.src = `/api/thumb/${o.k}.jpg`;
    el.dataset.id = o.i;
    el.children[1].textContent = o.name; // chỉ hiện khi ô ở trạng thái .broken
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

  let fresh = 0;

  /** Gắn (nếu chưa) và đặt ô ở vị trí `i`. */
  function place(i) {
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
      el.classList.remove('broken');
      if (img.complete) shown(el, img);
      else {
        img.onload = () => shown(el, img);
        // Thumbnail dựng không nổi (file hỏng, ffmpeg thất bại) → ô phải nêu tên
        // file chứ không câm lặng một mảng xám.
        img.onerror = () => el.classList.add('broken');
      }
    }
    el.classList.toggle('pending', !p.o.ar);
    // Screen reader cần biết "ảnh thứ N trên tổng M"; lưới ảo hoá không tự có
    // thông tin đó vì DOM chỉ chứa vài chục ô.
    el.setAttribute('aria-posinset', i + 1);
    el.setAttribute('aria-setsize', placed.length);
    el.style.transform = `translate(${p.x}px,${p.y}px)`;
    el.style.width = `${p.w}px`;
    el.style.height = `${p.h}px`;
  }

  /** Thumbnail hỏng: server trả placeholder, ô phải nêu tên file chứ không câm. */
  function shown(el, img) {
    img.classList.add('in');
    el.classList.toggle('broken', img.currentSrc.endsWith('/assets/broken.svg'));
  }

  function render() {
    const top = scroller.scrollTop;
    const vh = scroller.clientHeight;
    let [start, end] = visibleRange(placed, top - OVER, top + vh + OVER);
    // Ô cao bất thường (panorama dựng đứng) làm vị từ binary search không đơn điệu
    // tuyệt đối; lùi vài ô là đủ bù, rẻ hơn nhiều so với quét tuyến tính.
    start = Math.max(0, start - 8);

    // Ô đang giữ focus phải ở lại DOM dù đã cuộn ra ngoài viewport. Ảo hoá nó đi
    // thì focus rơi về <body> và người dùng bàn phím mất hẳn vị trí — đây là chỗ
    // virtual scroll phá a11y nhiều nhất.
    const activeIdx = activeId !== null ? byId.get(activeId) : undefined;
    const pinned = activeIdx !== undefined && (activeIdx < start || activeIdx >= end);

    const keep = new Set();
    for (let i = start; i < end; i++) keep.add(placed[i].o.i);
    if (pinned) keep.add(activeId);
    for (const [id, el] of bound) {
      if (keep.has(id)) continue;
      bound.delete(id);
      release(el);
    }

    fresh = 0;
    for (let i = start; i < end; i++) place(i);
    if (pinned) place(activeIdx);

    // Roving tabindex: cả lưới là MỘT điểm dừng Tab. Để 2000 ô cùng tabindex=0
    // thì Tab qua thư viện là 70k lần bấm.
    const rover = activeId ?? placed[start]?.o.i;
    for (const [id, el] of bound) el.tabIndex = id === rover ? 0 : -1;

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
      el.innerHTML = `${fmtHead(h.t, group)} <em>${h.n.toLocaleString('vi-VN')} mục</em>`;
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
    stick.textContent = cur ? fmtHead(cur.t, group) : '';
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
  // Roving tabindex đi theo ô người dùng thật sự chạm vào, dù bằng chuột hay Tab
  sizer.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('.tile');
    if (el) activeId = Number(el.dataset.id);
  });
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
    setGroup(g) {
      if (g === group) return;
      group = g;
      relayout(8);
    },
    relayout,
    render,
    /** Mốc thời gian + vị trí y, cho thanh scrubber. */
    get marks() {
      return heads;
    },
    get totalH() {
      return totalH;
    },
    scrollTo(y) {
      scroller.scrollTop = Math.max(0, Math.min(totalH, y));
      render();
    },
    /**
     * Di chuyển ô đang focus. ←/→ đi theo thứ tự view; ↑/↓ tìm ô gần nhất theo
     * TÂM NGANG ở hàng trên/dưới — justified có số ô mỗi hàng khác nhau nên
     * cộng/trừ một hằng số sẽ nhảy lung tung.
     */
    moveFocus(key) {
      if (placed.length === 0) return;
      const cur = document.activeElement?.closest?.('.tile');
      const i = cur ? byId.get(Number(cur.dataset.id)) : undefined;
      if (i === undefined) return void this.focusIndex(0);

      if (key === 'ArrowRight') return void this.focusIndex(Math.min(placed.length - 1, i + 1));
      if (key === 'ArrowLeft') return void this.focusIndex(Math.max(0, i - 1));

      const p = placed[i];
      const cx = p.x + p.w / 2;
      const up = key === 'ArrowUp';
      let best = -1;
      let bestDx = Infinity;
      // Hàng kế tiếp = ô đầu tiên có y khác hẳn y hiện tại theo đúng chiều
      for (let j = i; up ? j >= 0 : j < placed.length; up ? j-- : j++) {
        const q = placed[j];
        if (up ? q.y >= p.y : q.y <= p.y) continue;
        if (best >= 0 && q.y !== placed[best].y) break;
        const dx = Math.abs(q.x + q.w / 2 - cx);
        if (dx < bestDx) {
          bestDx = dx;
          best = j;
        }
      }
      if (best >= 0) this.focusIndex(best);
    },
    focusIndex(i) {
      const p = placed[i];
      if (!p) return;
      activeId = p.o.i;
      const top = scroller.scrollTop;
      if (p.y < top + 8 || p.y + p.h > top + scroller.clientHeight) {
        scroller.scrollTop = p.y - scroller.clientHeight / 2 + p.h / 2;
      }
      render();
      bound.get(p.o.i)?.focus({ preventScroll: true });
    },
    /** Ô đang focus, cho phím Space/Enter mở lightbox từ handler tập trung. */
    focusedIndex() {
      const el = document.activeElement?.closest?.('.tile');
      return el ? byId.get(Number(el.dataset.id)) : undefined;
    },
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
      activeId = id;
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
