import { execFile } from 'node:child_process';

const ARGS = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format'];

// File được chọn chỉ theo đuôi tên, nên bất cứ thứ gì tên .mp4 cũng đi qua đây.
// Trần buffer + timeout để một file méo không treo cả pha B.
const MAX_BUFFER = 4 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

function probe(path) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [...ARGS, path],
      { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Góc xoay nằm ở side_data (hoặc tag rotate cũ). Bỏ qua = mọi video iPhone dọc
 * sai tỉ lệ: đo trên thư viện thật, 14/15 video có `rotation: -90` với stream
 * 1920×1440, tức hiển thị đúng phải là 1440×1920.
 */
export function rotationOf(stream) {
  const sd = stream.side_data_list?.find((s) => s.rotation !== undefined);
  const deg = sd ? Number(sd.rotation) : Number(stream.tags?.rotate ?? 0);
  return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : 0;
}

/** Không bao giờ ném: video hỏng trả mọi trường null, item vẫn vào index. */
export async function videoMeta(path) {
  const out = { w: null, h: null, orient: null, taken: null, dur: null };
  const data = await probe(path);
  if (!data) return out;

  const v = data.streams?.find((s) => s.codec_type === 'video');
  if (v) {
    out.w = Number(v.width) || null;
    out.h = Number(v.height) || null;
    const rot = rotationOf(v);
    if ((rot === 90 || rot === 270) && out.w !== null) [out.w, out.h] = [out.h, out.w];
  }

  const dur = Number(data.format?.duration ?? v?.duration);
  if (Number.isFinite(dur) && dur > 0) out.dur = dur;

  // creation_time là ISO-8601 kèm Z — khác EXIF ảnh, parse thẳng được
  const iso = data.format?.tags?.creation_time ?? v?.tags?.creation_time;
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(t)) out.taken = t;

  return out;
}

/** ffprobe có sẵn trên máy hay không — Phase 9 dùng để báo lỗi kèm lệnh cài. */
export function hasFfprobe() {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-version'], (err) => resolve(!err));
  });
}
