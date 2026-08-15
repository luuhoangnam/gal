import { readdir, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { classify } from './media-types.js';

// Bundle macOS: thư mục thật nhưng người dùng coi là một file. Nhận theo ĐUÔI
// thư mục ở mọi độ sâu, không phải glob toàn cục — fs.glob không làm tốt việc này.
const BUNDLE_EXTS = new Set([
  '.photoslibrary',
  '.app',
  '.fcpbundle',
  '.imovielibrary',
  '.tvlibrary',
  '.aplibrary',
  '.photolibrary',
]);

const STAT_BATCH = 64;

export function newStats() {
  // `denied` giữ vài đường dẫn đầu tiên bị chặn, không giữ hết: empty state chỉ
  // cần nêu tên cụ thể để người dùng biết cấp quyền cho cái gì.
  return { files: 0, dirs: 0, skippedDirs: 0, skippedBundles: 0, denied: [] };
}

const DENIED_KEEP = 3;

function skipDir(name, includeBundles) {
  if (name.startsWith('.') || name === 'node_modules') return 'hidden';
  if (!includeBundles && BUNDLE_EXTS.has(path.extname(name).toLowerCase())) return 'bundle';
  return null;
}

/**
 * Duyệt đệ quy, yield từng file media ngay khi gặp.
 *
 * Symlink thư mục: mặc định KHÔNG đi vào. Nếu walker đi ra ngoài root thì
 * `resolveInside` của Phase 1 sẽ trả 403 cho đúng những file đó — index có mục
 * mà không xem được. Hai lớp phải nhất quán, và lớp an toàn là lớp đúng.
 *
 * @param onExtraRoot gọi khi đi theo symlink ra ngoài root; server dùng để nới
 *   vùng cho phép của /api/file, nếu không cờ này sẽ tự mâu thuẫn.
 */
export async function* walk(root, opts = {}) {
  const {
    includeBundles = false,
    followSymlinks = false,
    stats = newStats(),
    onExtraRoot,
  } = opts;

  const stack = [root];
  // Chống lặp symlink: dev+ino, chỉ cần khi thật sự đi theo symlink
  const visited = followSymlinks ? new Set() : null;

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      stats.skippedDirs++; // EACCES/ENOENT: bỏ qua thư mục, scan chạy tiếp
      if (err?.code === 'EACCES' && stats.denied.length < DENIED_KEEP) stats.denied.push(dir);
      continue;
    }
    stats.dirs++;
    const pending = [];

    for (const e of entries) {
      const abs = path.join(dir, e.name);

      if (e.isDirectory()) {
        const why = skipDir(e.name, includeBundles);
        if (why === 'bundle') stats.skippedBundles++;
        if (!why) stack.push(abs);
        continue;
      }

      if (e.isSymbolicLink()) {
        if (!followSymlinks) continue;
        let st;
        try {
          st = await stat(abs); // theo link
        } catch {
          continue; // link gãy
        }
        if (st.isDirectory()) {
          const key = `${st.dev}:${st.ino}`;
          if (visited.has(key)) continue; // đã thăm → lặp
          visited.add(key);
          if (skipDir(e.name, includeBundles)) continue;
          if (onExtraRoot) await onExtraRoot(abs);
          stack.push(abs);
        } else if (st.isFile()) {
          const kind = classify(e.name);
          if (kind) {
            stats.files++;
            yield item(root, abs, st, kind);
          }
        }
        continue;
      }

      if (!e.isFile()) continue;
      const kind = classify(e.name);
      if (kind) pending.push([abs, kind]);
    }

    // lstat là nút thắt thật của pha A: tuần tự 2,9s cho 135k file, song song 0,43s.
    // Gom theo thư mục và chạy theo lô để không mở vô hạn fd trên thư mục khổng lồ.
    for (let i = 0; i < pending.length; i += STAT_BATCH) {
      const chunk = pending.slice(i, i + STAT_BATCH);
      const sts = await Promise.all(chunk.map(([abs]) => lstat(abs).catch(() => null)));
      for (let j = 0; j < chunk.length; j++) {
        if (sts[j] === null) continue;
        stats.files++;
        yield item(root, chunk[j][0], sts[j], chunk[j][1]);
      }
    }
  }
}

function item(root, abs, st, kind) {
  return {
    p: path.relative(root, abs),
    s: st.size,
    // mtimeMs là số THỰC (đo được `…984.1538`); floor một chỗ duy nhất, ở đây
    m: Math.floor(st.mtimeMs),
    v: kind === 'video' ? 1 : 0,
  };
}
