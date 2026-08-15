import PhotoSwipe from '/vendor/photoswipe/photoswipe.esm.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// Chrome không giải mã HEIC/TIFF trong <img>. Với đúng những đuôi này lightbox đi
// qua `/api/preview` (ffmpeg dựng 1600px); mọi thứ khác trỏ thẳng file gốc.
const TRANSCODE = /\.(heic|heif|tiff?)$/i;

const q = (p) => encodeURIComponent(p);
const fmtDate = (t) =>
  new Date(t).toLocaleString('vi-VN', { dateStyle: 'long', timeStyle: 'short' });

/**
 * Lightbox trên PhotoSwipe v5.
 *
 * Ba thứ plan dự tính tự viết mà PhotoSwipe đã làm sẵn, nên không viết lại:
 * zoom shared-element theo ô nguồn (`element` + `thumbCropped`), chống chớp
 * trắng bằng ảnh thumbnail tại chỗ (`msrc`), và fallback fade khi ô nguồn đã bị
 * ảo hoá khỏi DOM (`thumbEl` trả undefined → nó tự chuyển).
 */
export function createLightbox({ grid }) {
  let pswp = null;
  let openedId = null;

  function slideOf(it) {
    const preview = !it.v && TRANSCODE.test(it.p);
    return {
      it,
      src: preview ? `/api/preview?p=${q(it.p)}` : `/api/file?p=${q(it.p)}`,
      // Thumbnail đã nằm sẵn trong cache trình duyệt → hiện ngay tại chỗ trong
      // lúc ảnh lớn tải. Đây mới là cách chống chớp trắng, không phải decode().
      msrc: it.k ? `/api/thumb/${it.k}.jpg` : undefined,
      type: it.v ? 'video' : undefined,
      // Ảnh: 0 = chưa có metadata pha B, lấy lại từ naturalWidth ở `loadComplete`.
      // Video: cố ý để 0 — PhotoSwipe không phóng quá 100% (đúng với ảnh), nên
      // khai kích thước thật sẽ giữ clip 640×480 bé tí giữa màn hình. Để trống
      // thì nó cấp trọn viewport, và `object-fit: contain` của <video> lo tỉ lệ.
      width: it.v ? 0 : it.w || 0,
      height: it.v ? 0 : it.h || 0,
      alt: it.name,
      thumbCropped: true,
    };
  }

  function buildMeta(el) {
    const name = document.createElement('b');
    const rest = document.createElement('span');
    el.append(name, rest);
    const sync = () => {
      const it = pswp?.currSlide?.data?.it;
      if (!it) return;
      // File ngay tại gốc không có '/': slice(0, -1) sẽ cắt cụt tên file
      const cut = it.p.lastIndexOf('/');
      const dir = cut > 0 ? it.p.slice(0, cut) : '';
      name.textContent = it.name;
      rest.textContent = [
        fmtDate(it.t),
        it.w ? `${it.w}×${it.h}` : '',
        dir ? `📁 ${dir}` : '',
      ]
        .filter(Boolean)
        .join('  ·  ');
    };
    pswp.on('change', sync);
    sync();
  }

  function open(index) {
    if (pswp) return;
    openedId = grid.at(index)?.i ?? null;

    pswp = new PhotoSwipe({
      dataSource: [],
      index,
      bgOpacity: 1,
      // Trả focus tự làm: ô nguồn có thể đã bị tái dùng cho ảnh khác lúc đóng,
      // focus lại đúng element cũ sẽ trỏ nhầm ảnh.
      returnFocus: false,
      showHideAnimationType: reduced.matches ? 'fade' : 'zoom',
      showAnimationDuration: reduced.matches ? 80 : 300,
      hideAnimationDuration: reduced.matches ? 80 : 220,
      easing: 'cubic-bezier(0.32,0.72,0,1)',
      errorMsg: 'Không mở được tệp này',
      closeTitle: 'Đóng',
      zoomTitle: 'Phóng to',
      arrowPrevTitle: 'Trước',
      arrowNextTitle: 'Sau',
    });

    // Lười dựng slide: thư viện 70k ảnh không dựng 70k object mỗi lần mở.
    pswp.addFilter('numItems', () => grid.count);
    pswp.addFilter('itemData', (data, i) => {
      const it = grid.at(i);
      return it ? slideOf(it) : data;
    });
    // Gốc của zoom mở/đóng. undefined khi ô đã cuộn ra khỏi DOM → PhotoSwipe fade.
    pswp.addFilter('thumbEl', (el, data) => (data.it ? grid.tileImg(data.it.i) : el));
    pswp.addFilter('isContentZoomable', (z, content) => content.type !== 'video' && z);

    pswp.on('contentLoad', (e) => {
      if (e.content.type !== 'video') return;
      e.preventDefault();
      const v = document.createElement('video');
      v.className = 'pswp__video';
      v.controls = true;
      v.playsInline = true;
      // metadata thôi: seek dựa vào HTTP Range của server, không cần tải trước.
      v.preload = 'metadata';
      if (e.content.data.msrc) v.poster = e.content.data.msrc;
      v.src = e.content.data.src;
      e.content.element = v;
    });
    pswp.on('contentDeactivate', ({ content }) => content.element?.pause?.());

    // Ảnh chưa qua pha B thì width=0; PhotoSwipe sẽ kéo full viewport và méo tỉ lệ.
    pswp.on('loadComplete', ({ content }) => {
      const img = content.element;
      if (content.width || !img?.naturalWidth) return;
      content.width = img.naturalWidth;
      content.height = img.naturalHeight;
      if (content.slide) {
        content.slide.width = content.width;
        content.slide.height = content.height;
        content.slide.resize();
      }
    });

    pswp.on('change', () => {
      openedId = pswp.currSlide?.data?.it?.i ?? openedId;
    });

    pswp.on('uiRegister', () => {
      pswp.ui.registerElement({
        name: 'meta',
        appendTo: 'root',
        order: 9,
        isButton: false,
        onInit: buildMeta,
      });
    });

    pswp.on('destroy', () => {
      pswp = null;
      if (openedId !== null) grid.focusId(openedId);
    });

    pswp.init();
  }

  return { open, isOpen: () => pswp !== null };
}
