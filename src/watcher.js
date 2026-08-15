import { watch } from 'node:fs';

/**
 * Theo dõi thay đổi dưới root và đánh số `rev` tăng dần cho mỗi đợt thay đổi.
 *
 * Client long-poll `rev` thay vì nhận từng sự kiện: copy 500 ảnh vào thư mục là
 * 500+ sự kiện, nhưng chỉ cần một lần quét lại. Debounce gom chúng thành một.
 *
 * Trả về `null` khi nền tảng không cho watch đệ quy — gọi bên ngoài coi như
 * không bật, không làm hỏng server.
 */
export function createWatcher(root, { debounce = 800 } = {}) {
  const self = root.replace(/[/\\]+$/, '').split(/[/\\]/).pop();

  /**
   * Bỏ qua hai loại sự kiện không phải "thư viện đổi":
   * - `<root>/.gal`: chính gal ghi thumbnail vào đó, không lọc là tự kích hoạt mình.
   * - Sự kiện mang đúng tên chính root: FSEvents báo kèm cho mọi thay đổi bên
   *   trong, và thay đổi thật luôn có sự kiện đường dẫn riêng đi cùng.
   */
  const ignore = (filename) => {
    const first = filename.split(/[/\\]/)[0];
    return first === '.gal' || (filename === self && !filename.includes('/'));
  };

  let rev = 0;
  let timer = null;
  const waiters = new Set();

  const bump = () => {
    rev += 1;
    for (const w of waiters) w(rev);
    waiters.clear();
  };

  let w;
  try {
    w = watch(root, { recursive: true, persistent: false }, (_type, filename) => {
      if (typeof filename === 'string' && ignore(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(bump, debounce);
    });
  } catch {
    return null;
  }
  w.on('error', () => {}); // watcher chết thì mất auto-refresh, server vẫn chạy

  return {
    get rev() {
      return rev;
    },
    /** Chờ tới khi rev vượt `since`, hoặc hết `timeoutMs` thì trả về rev hiện tại. */
    wait(since, timeoutMs) {
      if (rev > since) return Promise.resolve(rev);
      return new Promise((resolve) => {
        const done = (v) => {
          clearTimeout(t);
          waiters.delete(done);
          resolve(v);
        };
        const t = setTimeout(() => done(rev), timeoutMs);
        waiters.add(done);
      });
    },
    close() {
      clearTimeout(timer);
      w.close();
      for (const cb of waiters) cb(rev);
      waiters.clear();
    },
  };
}
