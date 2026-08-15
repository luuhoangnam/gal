/**
 * Feed toàn màn hình cho mobile: mỗi mục chiếm trọn viewport, vuốt dọc để sang
 * mục kế, video tự phát khi tới lượt. Kiểu TikTok.
 *
 * Cuộn và bắt điểm dừng là `scroll-snap-type: y mandatory` của trình duyệt —
 * không có thư viện gesture, không tự tính vận tốc vuốt. Phần JS ở đây chỉ làm
 * ba việc: gắn/nhả slide quanh mục đang xem, phát/dừng video, và cập nhật
 * thông tin ở đáy.
 */
import { fmtDur } from './grid.js';

// Chrome không giải mã HEIC/TIFF trong <img> — đúng những đuôi này đi qua
// /api/preview (ffmpeg 1600px), còn lại trỏ thẳng file gốc. Cùng luật với lightbox.
const TRANSCODE = /\.(heic|heif|tiff?)$/i;
const q = (p) => encodeURIComponent(p);

/**
 * Số slide giữ trong DOM mỗi bên mục đang xem. 2 là đủ để vuốt nhanh không thấy
 * ô trống, mà vẫn chỉ có 5 <video>/<img> lớn sống cùng lúc.
 */
const MOUNT = 2;

/**
 * ponytail: cửa sổ 2000 mục quanh chỗ vào feed, không phải cả thư viện. Chiều
 * cao sizer = số mục × chiều cao màn hình, và 70.000 × 800px vượt giới hạn
 * ~33 triệu px của trình duyệt — lưới sẽ ngừng cuộn. Vuốt hết 2000 mục trong
 * một lần mở là chuyện không xảy ra; nếu có, cách nâng là dịch cửa sổ khi tới
 * mép rồi bù `scrollTop`.
 */
const WINDOW = 2000;

/** Bước tua của cú đúp trái/phải, giây. Đúng con số YouTube dùng. */
const SEEK_STEP = 10;
/** Hai cú chạm cách nhau dưới ngần này, cùng một bên, là một cú đúp. */
const DOUBLE_TAP_MS = 320;
/** Vùng đúp để tua: 35% mép trái và 35% mép phải. Giữa màn hình không tua. */
const SIDE_ZONE = 0.35;

const fmtDate = (t) =>
  new Date(t).toLocaleDateString('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' });

export function createFeed({ grid, root }) {
  const sizer = root.querySelector('#fsizer');
  const posEl = root.querySelector('#fpos');
  const metaEl = root.querySelector('#fmeta');
  const soundBtn = root.querySelector('#fsound');
  const ctl = root.querySelector('#fctl');
  const playBtn = root.querySelector('#fplaypause');
  const seek = root.querySelector('#fseek');
  const timeEl = root.querySelector('#ftime');
  const durEl = root.querySelector('#fdur');
  const hint = root.querySelector('#fseekhint');

  const slides = new Map(); // chỉ số toàn cục -> element
  const pool = [];

  let start = 0; // [start, end) là cửa sổ mục đang phục vụ
  let end = 0;
  let h = 0; // chiều cao một slide, px
  let cur = -1;
  let opened = false;
  // Tự phát phải câm thì trình duyệt mới cho. Một khi người xem bật tiếng, giữ
  // nguyên cho các video sau — không bắt bật lại từng cái.
  let muted = true;

  // Đang kéo thanh tua: `timeupdate` không được ghi đè vị trí ngón tay
  let scrubbing = false;
  let lastTap = 0;
  let lastSide = 0;

  const mediaOf = (el) => el?.children[1] ?? null;
  const clamp = (i) => Math.max(start, Math.min(end - 1, i));
  const activeVideo = () => {
    const m = mediaOf(slides.get(cur));
    return m?.tagName === 'VIDEO' ? m : null;
  };

  function newSlide() {
    const el = document.createElement('div');
    el.className = 'fslide';
    el.innerHTML = '<div class="fbg"></div>';
    sizer.appendChild(el);
    return el;
  }

  function mount(i) {
    if (slides.has(i)) return;
    const it = grid.at(i);
    if (it === undefined) return;

    const el = pool.pop() ?? newSlide();
    slides.set(i, el);

    const thumb = it.k ? `/api/thumb/${it.k}.jpg` : '';
    el.firstChild.style.backgroundImage = thumb ? `url("${thumb}")` : 'none';

    const m = document.createElement(it.v ? 'video' : 'img');
    m.className = 'fmedia';
    if (it.v) {
      m.playsInline = true;
      m.loop = true;
      m.muted = muted;
      m.preload = 'metadata'; // tua dựa vào HTTP Range của server, không tải trước
      m.setAttribute('aria-label', `${it.name}, video ${it.dur ? fmtDur(it.dur) : ''}`);
      if (thumb) m.poster = thumb;
      m.classList.add('in');
      // Element được tạo mới mỗi lần mount và bỏ hẳn khi nhả, nên listener chết
      // theo nó — không cần gỡ tay. Lọc theo slide đang xem: bốn slide hàng xóm
      // cũng bắn `timeupdate` nếu chúng từng chạy.
      for (const ev of ['timeupdate', 'seeked']) m.addEventListener(ev, () => syncTime(m));
      m.addEventListener('loadedmetadata', () => syncDuration(m));
      m.addEventListener('play', () => syncPlay(m));
      m.addEventListener('pause', () => syncPlay(m));
    } else {
      m.alt = `${it.name}, ${fmtDate(it.t)}`;
      m.decoding = 'async';
      // Ảnh lớn chỉ hiện khi đã tải xong; trước đó người xem nhìn thumbnail nền
      // (đã nằm trong cache trình duyệt) chứ không phải một ô đen.
      m.onload = () => m.classList.add('in');
    }
    m.src = it.v || !TRANSCODE.test(it.p) ? `/api/file?p=${q(it.p)}` : `/api/preview?p=${q(it.p)}`;

    el.replaceChildren(el.firstChild, m);
    el.hidden = false;
    el.style.top = `${(i - start) * h}px`;
    el.style.height = `${h}px`;
  }

  function release(i) {
    const el = slides.get(i);
    if (el === undefined) return;
    slides.delete(i);
    const m = mediaOf(el);
    if (m !== null) {
      m.pause?.();
      m.removeAttribute('src');
      m.load?.(); // không có nó thì Chrome vẫn tải nốt video vừa nhả
      m.remove();
    }
    el.hidden = true;
    pool.push(el);
  }

  function setActive(i) {
    if (i === cur) return;
    cur = i;

    const lo = Math.max(start, i - MOUNT);
    const hi = Math.min(end - 1, i + MOUNT);
    for (const j of [...slides.keys()]) if (j < lo || j > hi) release(j);
    for (let j = lo; j <= hi; j++) mount(j);

    for (const [j, el] of slides) {
      const m = mediaOf(el);
      if (m === null || m.tagName !== 'VIDEO') continue;
      if (j !== i) m.pause();
      else {
        m.muted = muted;
        m.play().catch(() => {}); // bị chặn tự phát thì thôi, poster vẫn ở đó
      }
    }
    const it = grid.at(i);
    posEl.textContent = `${(i + 1).toLocaleString('vi-VN')} / ${grid.count.toLocaleString('vi-VN')}`;
    soundBtn.hidden = !it?.v;
    ctl.hidden = !it?.v;
    renderMeta(it);

    // Đặt lại thanh tua về mục mới; nếu metadata đã có sẵn thì điền luôn, còn
    // không `loadedmetadata` sẽ điền sau.
    root.classList.remove('paused');
    scrubbing = false;
    const v = activeVideo();
    seek.value = '0';
    seek.max = '1';
    seek.style.setProperty('--p', '0%');
    timeEl.textContent = '0:00';
    durEl.textContent = it?.v && it.dur ? fmtDur(it.dur) : '0:00';
    if (v !== null) {
      syncDuration(v);
      syncTime(v);
      syncPlay(v);
    }
  }

  /**
   * Thanh tua là `<input type="range">` chứ không phải một div tự bắt pointer:
   * kéo bằng ngón tay, mũi tên bàn phím, và nhãn cho screen reader đều là hành
   * vi sẵn có của nó. Phần duy nhất phải tự vẽ là vệt đã xem — cái mà range
   * không có — nên `--p` đổ vào một linear-gradient trên track.
   */
  function syncTime(v) {
    if (v !== activeVideo()) return;
    timeEl.textContent = fmtDur(v.currentTime);
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    seek.style.setProperty('--p', `${(v.currentTime / d) * 100}%`);
    if (scrubbing) return;
    seek.value = String(v.currentTime);
    seek.setAttribute('aria-valuetext', `${fmtDur(v.currentTime)} trên ${fmtDur(d)}`);
  }

  function syncDuration(v) {
    if (v !== activeVideo() || !Number.isFinite(v.duration) || v.duration <= 0) return;
    seek.max = String(v.duration);
    durEl.textContent = fmtDur(v.duration);
  }

  function syncPlay(v) {
    if (v !== activeVideo()) return;
    playBtn.classList.toggle('playing', !v.paused);
    playBtn.setAttribute('aria-label', v.paused ? 'Phát' : 'Tạm dừng');
    root.classList.toggle('paused', v.paused);
  }

  function togglePlay() {
    const v = activeVideo();
    if (v === null) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  /** Tua tương đối và nhá chỉ báo. Kẹp trong [0, duration] — tua quá đuôi làm
   *  Chrome nhảy về 0 và người xem tưởng video tự tua lại từ đầu. */
  function nudge(d) {
    const v = activeVideo();
    if (v === null) return;
    const max = Number.isFinite(v.duration) ? v.duration : v.currentTime;
    v.currentTime = Math.max(0, Math.min(max, v.currentTime + d));
    syncTime(v);
    hint.textContent = `${d > 0 ? '+' : '−'}${Math.abs(d)} giây`;
    hint.className = 'fseekhint';
    void hint.offsetWidth; // ép reflow để animation chạy lại từ đầu khi đúp liên tiếp
    hint.classList.add('on', d > 0 ? 'right' : 'left');
  }

  function renderMeta(it) {
    metaEl.replaceChildren();
    if (it === undefined) return;
    const cut = it.p.lastIndexOf('/');
    metaEl.append(
      Object.assign(document.createElement('b'), { textContent: it.name }),
      Object.assign(document.createElement('span'), {
        textContent: [fmtDate(it.t), it.w ? `${it.w}×${it.h}` : '', cut > 0 ? it.p.slice(0, cut) : '']
          .filter(Boolean)
          .join('  ·  '),
      }),
    );
  }

  /** Chiều cao slide = chiều cao feed; đo lại khi xoay máy. */
  function measure() {
    h = root.clientHeight;
    sizer.style.height = `${(end - start) * h}px`;
    for (const [i, el] of slides) {
      el.style.top = `${(i - start) * h}px`;
      el.style.height = `${h}px`;
    }
  }

  function goTo(i) {
    root.scrollTo({ top: (clamp(i) - start) * h, behavior: 'smooth' });
  }

  function toggleSound() {
    muted = !muted;
    const m = mediaOf(slides.get(cur));
    if (m?.tagName === 'VIDEO') {
      m.muted = muted;
      if (m.paused) m.play().catch(() => {});
    }
    soundBtn.classList.toggle('unmuted', !muted);
    soundBtn.setAttribute('aria-label', muted ? 'Bật tiếng' : 'Tắt tiếng');
  }

  function open(index) {
    const n = grid.count;
    if (opened || n === 0) return;
    index = Math.max(0, Math.min(n - 1, index));
    start = Math.max(0, Math.min(index - (WINDOW >> 1), n - WINDOW));
    end = Math.min(n, start + WINDOW);

    opened = true;
    root.hidden = false;
    document.body.classList.add('feed-on');
    measure();
    cur = -1;
    // Đặt scrollTop TRƯỚC setActive: snap mandatory sẽ kéo về slide gần nhất, và
    // slide gần nhất phải là slide người dùng vừa chạm vào.
    root.scrollTop = (index - start) * h;
    setActive(index);
    root.focus({ preventScroll: true });

    // Nút Back của điện thoại phải đóng feed, không phải rời khỏi app.
    history.pushState({ feed: true }, '');
  }

  function close() {
    if (!opened) return;
    opened = false;
    for (const i of [...slides.keys()]) release(i);
    root.hidden = true;
    root.classList.remove('bare', 'paused');
    document.body.classList.remove('feed-on');
    const it = grid.at(cur);
    if (it) grid.focusId(it.i); // lưới cuộn về đúng ô vừa xem
  }

  let raf = 0;
  root.addEventListener(
    'scroll',
    () => {
      if (raf || h === 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setActive(clamp(start + Math.round(root.scrollTop / h)));
      });
    },
    { passive: true },
  );

  /**
   * Một cú chạm ẩn/hiện lớp điều khiển; đúp vào mép trái/phải tua ∓10s — đúng
   * quy ước YouTube. Không cần hoãn cú chạm đầu để chờ xem có cú thứ hai không:
   * cú đầu chỉ bật/tắt lớp chữ, việc lỡ chạy nó trước khi tua là vô hại. Dừng
   * và phát nằm ở nút riêng, không phải cử chỉ — không có nút thì người dùng
   * chỉ dựa vào một cử chỉ không nhìn thấy được.
   */
  root.addEventListener('click', (e) => {
    if (e.target.closest('.fchrome, .fctl')) return;
    const now = performance.now();
    const x = e.clientX - root.getBoundingClientRect().left;
    const w = root.clientWidth;
    const side = x < w * SIDE_ZONE ? -1 : x > w * (1 - SIDE_ZONE) ? 1 : 0;

    if (side !== 0 && side === lastSide && now - lastTap < DOUBLE_TAP_MS && activeVideo()) {
      lastTap = 0;
      lastSide = 0;
      root.classList.remove('bare'); // tua mà chữ đang ẩn thì không thấy mình tua tới đâu
      return nudge(side * SEEK_STEP);
    }
    lastTap = now;
    lastSide = side;
    root.classList.toggle('bare');
  });

  root.querySelector('#fclose').onclick = () => history.back();
  soundBtn.onclick = toggleSound;
  playBtn.onclick = togglePlay;

  seek.addEventListener('input', () => {
    const v = activeVideo();
    if (v === null) return;
    scrubbing = true;
    v.currentTime = Number(seek.value);
    syncTime(v);
  });
  // `change` chốt lúc nhả ngón tay/chuột — từ đây `timeupdate` lại được quyền ghi
  seek.addEventListener('change', () => {
    scrubbing = false;
  });

  root.addEventListener('keydown', (e) => {
    // Mũi tên ngang khi đang focus thanh tua là việc của chính nó
    const onSeek = e.target === seek;
    if (e.key === 'Escape') history.back();
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') goTo(cur + 1);
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') goTo(cur - 1);
    else if (e.key === 'ArrowLeft' && !onSeek) nudge(-SEEK_STEP);
    else if (e.key === 'ArrowRight' && !onSeek) nudge(SEEK_STEP);
    else if (e.key === ' ') togglePlay();
    else return;
    e.preventDefault();
  });

  addEventListener('popstate', close);

  // Xoay máy: đo lại và giữ nguyên mục đang xem. Chỉ khi chiều cao ĐỔI THẬT —
  // bàn phím ảo và thanh URL cũng bắn resize, đo lại mỗi lần là giật cuộn.
  addEventListener('resize', () => {
    if (!opened || root.clientHeight === h) return;
    const i = cur;
    measure();
    root.scrollTop = (i - start) * h;
  });

  return { open, close, isOpen: () => opened };
}
