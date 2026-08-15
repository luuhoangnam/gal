import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve `rel` inside `root`, hoặc ném lỗi.
 *
 * Dùng realpath cả hai vế rồi path.relative, KHÔNG dùng startsWith:
 * - startsWith('/root') cho `/root-evil` đi lọt
 * - APFS case-insensitive + chuẩn hoá Unicode làm so chuỗi thô lệch khỏi inode thật
 * Đây chính là lớp lỗ hổng Deno dính (CVE-2026-49401).
 */
export async function resolveInside(root, rel) {
  // Nhiều root chỉ xuất hiện khi --follow-symlinks: walker đã đi ra ngoài root
  // nên vùng cho phép phải nới đúng bằng các thư mục nó thật sự đã đi vào.
  const roots = Array.isArray(root) ? root : [root];
  const realRoots = await Promise.all(roots.map((r) => realpath(r)));
  const target = path.resolve(realRoots[0], rel);

  let realTarget;
  try {
    realTarget = await realpath(target);
  } catch {
    // File chưa tồn tại: realpath thư mục cha để symlink cha vẫn bị soi
    const parent = await realpath(path.dirname(target));
    realTarget = path.join(parent, path.basename(target));
  }

  for (const realRoot of realRoots) {
    const r = path.relative(realRoot, realTarget);
    if (r !== '' && !r.startsWith('..') && !path.isAbsolute(r)) return realTarget;
  }
  throw new Error(`path outside root: ${rel}`);
}
