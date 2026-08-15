import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, createReadStream } from 'node:fs';
import { stat, rename, unlink, readdir } from 'node:fs/promises';
import { homedir, cpus } from 'node:os';
import path from 'node:path';
import { ffmpegPath } from './ffmpeg.js';

const TARGET = 320;
// Cạnh dài bản preview cho lightbox: đủ nét ở DPR 2 trên màn 13", vẫn rẻ hơn
// nhiều so với dựng full-res của một file HEIC 48MP.
const PREVIEW = 1600;
const TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Khoá cache = nội dung, không phải id.
 *
 * Dùng `?i=<id>` kèm `immutable` sẽ khiến browser tái dùng thumbnail của root
 * KHÁC khi trùng cổng — dải ephemeral macOS chỉ 16384 cổng, và `--port` làm việc
 * trùng thành tất định. `Math.floor(mtimeMs)` phải khớp đúng công thức của
 * index (mtimeMs là số thực), nếu không cache không bao giờ hit.
 */
export function thumbKey(absPath, mtime, size, target = TARGET) {
  return createHash('sha1')
    .update(`${absPath}\0${Math.floor(mtime)}\0${size}\0${target}`)
    .digest('hex');
}

export function createThumbs(root, { cacheDir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const dir = cacheDir ?? path.join(cacheDirFor(root), 'thumbs');
  mkdirSync(dir, { recursive: true });

  // hash → thông tin file nguồn. Client chỉ cầm hash nên server phải tra ngược.
  const registry = new Map();
  const inflight = new Map(); // hash → Promise, dedupe
  const failed = new Set(); // negative cache: file hỏng chỉ spawn ffmpeg MỘT lần
  const priority = new Set(); // hash trong viewport
  let running = 0;
  const waiting = [];
  const limit = cpus().length;
  let spawned = 0; // để test đếm được số job thật

  const fileFor = (hash) => path.join(dir, `${hash}.jpg`);

  /** Gắn khoá thumbnail vào item trước khi gửi cho client, và nhớ đường ngược lại. */
  function keyed(items) {
    return items.map((it) => {
      const k = thumbKey(path.join(root, it.p), it.m, it.s);
      registry.set(k, { rel: it.p, kind: it.v, target: TARGET });
      return { ...it, k };
    });
  }

  function acquire(isPriority) {
    if (running < limit) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      resolve.priority = isPriority;
      waiting.push(resolve);
    });
  }

  function release() {
    running--;
    if (waiting.length === 0) return;
    // Viewport trước: job của vùng đã cuộn qua chờ sau, không huỷ hẳn vì
    // người dùng cuộn ngược lại là chuyện thường.
    const idx = waiting.findIndex((w) => w.priority);
    const next = waiting.splice(idx >= 0 ? idx : 0, 1)[0];
    running++;
    next();
  }

  function runFfmpeg(src, out, isVideo, target, input) {
    return new Promise((resolve) => {
      const bin = ffmpegPath();
      if (!bin) return resolve(false);
      spawned++;
      const args = [
        ...(isVideo ? ['-ss', '1'] : []),
        '-i', src,
        // Chặn CẠNH DÀI, không phải chiều rộng: `scale=320:-1` cho ảnh dọc và
        // screenshot ra 320×693 (đo thật) — decode 887KB thay vì 307KB, và bộ nhớ
        // grid bám theo số ảnh đã cuộn qua nên đây là chi phí nhân lên 70k lần.
        //
        // filter_complex chứ không phải -filter:v: ảnh HEIC iPhone là lưới ô
        // 512×512 và chỉ đọc được qua stream group. `-filter:v` đơn giản thì
        // ffmpeg từ chối ("fed from a complex filtergraph"), còn `-map 0:v:0`
        // lấy đúng MỘT ô — đo thật: thumbnail ra 320×320 vuông, là một góc ảnh
        // chứ không phải tấm ảnh.
        '-filter_complex',
        `[${input}]scale=w=${target}:h=${target}:force_original_aspect_ratio=decrease[o]`,
        '-map', '[o]',
        '-frames:v', '1',
        '-q:v', '4',
        // Ghi ra .tmp nên ffmpeg không đoán được format từ đuôi file — phải nói rõ
        '-f', 'image2',
        '-y', out,
      ];
      const p = spawn(bin, ['-loglevel', 'error', '-nostdin', ...args], {
        stdio: 'ignore',
        detached: true, // để kill được cả nhóm process
      });
      const timer = setTimeout(() => {
        try {
          process.kill(-p.pid, 'SIGKILL');
        } catch {
          p.kill('SIGKILL');
        }
      }, TIMEOUT_MS);
      p.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  async function generate(hash) {
    const info = registry.get(hash);
    if (!info) return null;
    const src = path.join(root, info.rel);
    const out = fileFor(hash);
    const tmp = `${out}.${process.pid}.tmp`; // ghi tạm rồi rename: không đọc phải file nửa vời

    // HEIC không phải file nào cũng là lưới ô: bản một ô không có stream group
    // nên `0:g:0` sẽ không khớp stream nào. Thử group trước, rồi lùi về stream
    // thường — chỉ tốn thêm một lần spawn cho đúng nhánh hiếm.
    const isHeic = /\.hei[cf]$/i.test(info.rel);
    let ok = await runFfmpeg(src, tmp, info.kind === 1, info.target, isHeic ? '0:g:0' : '0:v:0');
    if (!ok && isHeic) ok = await runFfmpeg(src, tmp, false, info.target, '0:v:0');
    if (!ok) {
      await unlink(tmp).catch(() => {});
      failed.add(hash);
      return null;
    }
    try {
      await rename(tmp, out);
    } catch {
      failed.add(hash);
      return null;
    }
    return out;
  }

  return {
    keyed,
    get spawned() {
      return spawned;
    },
    knows: (hash) => registry.has(hash),

    /**
     * Đăng ký một bản preview cạnh dài 1600px và trả khoá của nó.
     * Chỉ dùng cho ảnh Chrome không tự giải mã được (HEIC, TIFF) — mọi định dạng
     * khác lightbox trỏ thẳng `/api/file`, không tốn thêm một lần ffmpeg nào.
     */
    async previewKey(rel) {
      const src = path.join(root, rel);
      const st = await stat(src);
      const k = thumbKey(src, st.mtimeMs, st.size, PREVIEW);
      registry.set(k, { rel, kind: 0, target: PREVIEW });
      return k;
    },

    /** Đánh dấu vùng đang xem để hàng đợi phục vụ trước. */
    setPriority(hashes) {
      priority.clear();
      for (const h of hashes) priority.add(h);
    },

    /** Đường dẫn file thumbnail đã sẵn sàng, hoặc null nếu không tạo được. */
    async get(hash) {
      if (failed.has(hash)) return null;
      const out = fileFor(hash);
      try {
        await stat(out);
        return out; // cache hit: không gọi ffmpeg
      } catch {
        /* chưa có, tạo tiếp */
      }
      if (!registry.has(hash)) return null;

      const existing = inflight.get(hash);
      if (existing) return existing; // 20 request cùng lúc → đúng 1 process

      const job = (async () => {
        await acquire(priority.has(hash));
        try {
          return await generate(hash);
        } finally {
          release();
          inflight.delete(hash);
        }
      })();
      inflight.set(hash, job);
      return job;
    },

    stream: (file) => createReadStream(file),

    /** Dọn LRU lúc khởi động, không chạy nền liên tục. */
    async sweep() {
      let entries;
      try {
        entries = await readdir(dir);
      } catch {
        return { bytes: 0, removed: 0 };
      }
      const files = [];
      let bytes = 0;
      for (const name of entries) {
        if (!name.endsWith('.jpg')) continue;
        try {
          const st = await stat(path.join(dir, name));
          files.push({ name, size: st.size, atime: st.atimeMs });
          bytes += st.size;
        } catch {
          /* biến mất giữa chừng */
        }
      }
      if (bytes <= maxBytes) return { bytes, removed: 0 };

      files.sort((a, b) => a.atime - b.atime); // cũ nhất trước
      let removed = 0;
      for (const f of files) {
        if (bytes <= maxBytes) break;
        await unlink(path.join(dir, f.name)).catch(() => {});
        bytes -= f.size;
        removed++;
      }
      return { bytes, removed };
    },

    dir,
  };
}
