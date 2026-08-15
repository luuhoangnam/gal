import { mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** `/Users/nam/Pics` → `Users-nam-Pics`; dùng làm tên thư mục fallback duy nhất. */
export function flatten(root) {
  return realpathSync(root).replace(/^\/+/, '').replace(/\//g, '-');
}

/**
 * Cache nằm cạnh thư viện (`<root>/.gal`) để xoá thư viện là xoá luôn cache,
 * và ổ ngoài mang đi máy khác vẫn còn index. `.gal` là dotdir nên walker bỏ qua.
 *
 * Quyền ghi phải thử thật: thư mục chỉ-đọc, mount ro, NAS không cho tạo dir đều
 * chỉ lộ ra lúc ghi, không đọc được từ mode bits.
 */
export function cacheDirFor(root) {
  const local = path.join(root, '.gal');
  try {
    mkdirSync(local, { recursive: true });
    const probe = path.join(local, `.w-${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    return local;
  } catch {
    const fallback = path.join('/tmp', 'gal', flatten(root));
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
