/**
 * Một handler duy nhất cho toàn bộ phím tắt. Rải listener khắp nơi thì thứ tự
 * ưu tiên phụ thuộc thứ tự đăng ký — và `Esc` phân cấp cần thứ tự tường minh.
 */

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function bindKeyboard({ grid, actions, lightbox, help }) {
  addEventListener('keydown', (e) => {
    // Đang gõ trong ô lọc: chỉ Esc có ý nghĩa (nhả focus), còn lại là ký tự.
    if (TYPING.has(e.target.tagName)) {
      if (e.key === 'Escape') {
        e.target.blur();
        e.preventDefault();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Lightbox và dialog trợ giúp tự lo phím của chúng (kể cả Esc).
    if (lightbox()?.isOpen() || help.open) return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
        grid.moveFocus(e.key);
        break;
      case ' ':
      case 'Enter': {
        const i = grid.focusedIndex();
        if (i === undefined) return;
        actions.open(i);
        break;
      }
      // Phân cấp: đóng cái hẹp nhất trước. Xoá sạch mọi thứ cùng lúc là phá
      // trạng thái người dùng đã dựng công.
      case 'Escape':
        if (document.activeElement?.closest?.('.tile')) document.activeElement.blur();
        else if (actions.isFiltered()) actions.clearFilters();
        else return;
        break;
      case '+':
      case '=':
        actions.density(1.25);
        break;
      case '-':
        actions.density(1 / 1.25);
        break;
      case '0':
        actions.density(0);
        break;
      case '1':
        actions.mode('justified');
        break;
      case '2':
        actions.mode('square');
        break;
      case '3':
        actions.mode('masonry');
        break;
      case 'g':
      case 'G':
        actions.jumpToDate();
        break;
      case 'r':
      case 'R':
        actions.refresh?.();
        break;
      case '/':
        actions.focusFilter();
        break;
      case '?':
        help.showModal();
        break;
      case 'Home':
        grid.scrollTo(0);
        break;
      case 'End':
        grid.scrollTo(grid.totalH);
        break;
      default:
        return;
    }
    e.preventDefault();
  });
}
