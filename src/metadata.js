import os from 'node:os';
import path from 'node:path';
import { imageMeta } from './exif-image.js';
import { videoMeta } from './video-meta.js';

export const DATE_EXIF = 0;
export const DATE_MTIME = 1;

/**
 * Pha B cho một file. Ảnh đi đường thuần JS; ffprobe CHỈ dùng cho video —
 * 70k ảnh × 25ms/spawn = 29 phút, chi phí nằm ở spawn chứ không ở giải mã.
 */
export async function fileMeta(root, row) {
  const abs = path.join(root, row.rel);
  const m = row.kind === 1 ? await videoMeta(abs) : await imageMeta(abs);
  const hasExif = m.taken !== null && m.taken !== undefined;
  return {
    i: row.id,
    w: m.w ?? null,
    h: m.h ?? null,
    orient: m.orient ?? null,
    // Không có EXIF → rơi về mtime, nhưng đánh dấu nguồn để UI phân biệt được
    taken: hasExif ? m.taken : row.mtime,
    ds: hasExif ? DATE_EXIF : DATE_MTIME,
    dur: m.dur ?? null,
  };
}

/**
 * Chạy pha B theo pool, yield từng lô kết quả để stream ngay.
 * Ảnh và video dùng chung pool: video chậm hơn ~20× nhưng chỉ ~9% số file,
 * tách hai pool riêng không đáng thêm cơ chế.
 */
export async function* metaBatches(root, rows, { concurrency = os.cpus().length, batch = 200 } = {}) {
  let next = 0;
  let out = [];
  const inflight = new Set();

  const start = () => {
    if (next >= rows.length) return false;
    const row = rows[next++];
    const p = fileMeta(root, row)
      .catch(() => ({ i: row.id, w: null, h: null, orient: null, taken: row.mtime, ds: DATE_MTIME, dur: null }))
      .then((r) => {
        out.push(r);
        inflight.delete(p);
      });
    inflight.add(p);
    return true;
  };

  while (inflight.size < concurrency && start());

  while (inflight.size > 0) {
    await Promise.race(inflight);
    while (inflight.size < concurrency && start());
    if (out.length >= batch) {
      yield out;
      out = [];
    }
  }
  if (out.length > 0) yield out;
}
