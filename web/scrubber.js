/**
 * Thanh năm bám mép phải. Với thư viện 70k ảnh trải nhiều năm, đây là tương tác
 * giá trị cao nhất: không có nó thì thư viện lớn là một hố cuộn vô tận.
 *
 * Vị trí nhãn là tỉ lệ y/totalH của mốc nhóm — nghĩa là khoảng cách giữa hai năm
 * phản ánh đúng số ảnh của năm đó, không chia đều. Nhìn vào thanh là biết năm nào
 * chụp nhiều.
 */
const HIDE_MS = 1500;

export function createScrubber({ el, scroller, grid }) {
  let marks = [];
  let hideTimer = 0;
  let dragging = false;

  function show() {
    el.classList.add('on');
    clearTimeout(hideTimer);
    if (!dragging) hideTimer = setTimeout(() => el.classList.remove('on'), HIDE_MS);
  }

  /**
   * Mỗi năm một nhãn, lấy ô ĐẦU TIÊN của năm đó theo thứ tự đang hiển thị.
   * Quét `placed` chứ không quét header nhóm: nhóm có thể đang là "không nhóm"
   * hoặc theo tháng, thanh năm vẫn phải chạy.
   */
  function build() {
    const seen = new Set();
    marks = [];
    const total = grid.totalH || 1;
    for (const p of grid.placed) {
      const y = new Date(p.o.t).getFullYear();
      if (seen.has(y)) continue;
      seen.add(y);
      marks.push({ label: String(y), y: p.y, pct: (p.y / total) * 100 });
    }
    el.replaceChildren(
      ...marks.map((m) => {
        const b = document.createElement('button');
        b.className = 'tick';
        b.style.top = `${m.pct}%`;
        b.textContent = m.label;
        b.tabIndex = -1; // điều hướng bằng bàn phím đã có G / Home / End
        b.onclick = () => grid.scrollTo(m.y);
        return b;
      }),
    );
    el.hidden = marks.length < 2; // một năm duy nhất thì thanh này vô nghĩa
  }

  function seek(clientY) {
    const r = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    grid.scrollTo(pct * grid.totalH - scroller.clientHeight / 2);
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('tick')) return; // click nhãn là nhảy đúng mốc
    dragging = true;
    el.setPointerCapture(e.pointerId);
    seek(e.clientY);
    show();
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) seek(e.clientY);
  });
  el.addEventListener('pointerup', () => {
    dragging = false;
    show();
  });
  el.addEventListener('pointerleave', () => show());

  scroller.addEventListener('scroll', show, { passive: true });

  return { build, show };
}
