import { open } from 'node:fs/promises';
import ExifReader from 'exifreader';
import { imageSize } from 'image-size';

// Đọc dần thay vì đọc cả file. Chỉ HEIC/HEIF mới cần đọc thêm: box `meta` nằm
// sau hdlr/iloc/iinf/iref/iprp nên vị trí không cố định. JPEG đặt APP1 ngay đầu
// file — đo trên 400 ảnh thật: 64KB bắt được 100% số ảnh CÓ EXIF, đọc thêm
// 128/256KB hay cả file không thêm được hit nào. Escalate cho JPEG là đọc phí.
const CHUNKS_DEFAULT = [65536];
const CHUNKS_ISO_BMFF = [65536, 131072, 262144];

function chunksFor(path) {
  return /\.(heic|heif|avif)$/i.test(path) ? CHUNKS_ISO_BMFF : CHUNKS_DEFAULT;
}

async function readHead(path, len) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function num(tag) {
  if (!tag) return null;
  const v = Array.isArray(tag.value) ? tag.value[0] : tag.value;
  return typeof v === 'number' ? v : null;
}

/**
 * EXIF ghi ngày dạng "2025:03:14 09:26:01" theo giờ **địa phương lúc chụp**,
 * không có timezone. Parse thủ công như giờ địa phương: dùng Date.parse thẳng
 * sẽ hỏng vì dấu hai chấm ở phần ngày.
 */
function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  const t = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Đọc metadata một ảnh. Không bao giờ ném: file hỏng / 0 byte trả về mọi trường
 * null để pool không dừng giữa chừng.
 */
export async function imageMeta(path) {
  const out = { w: null, h: null, orient: null, taken: null };

  for (const len of chunksFor(path)) {
    let buf;
    try {
      buf = await readHead(path, len);
    } catch {
      return out;
    }
    if (buf.length === 0) return out;

    if (out.w === null) {
      try {
        const d = imageSize(buf);
        out.w = d.width ?? null;
        out.h = d.height ?? null;
        if (d.orientation) out.orient = d.orientation;
      } catch {
        /* thử chunk lớn hơn */
      }
    }

    try {
      const tags = ExifReader.load(buf, { expanded: false });
      out.orient ??= num(tags.Orientation);
      out.taken ??=
        parseExifDate(tags.DateTimeOriginal?.description) ??
        parseExifDate(tags.CreateDate?.description) ??
        parseExifDate(tags.DateTimeDigitized?.description) ??
        parseExifDate(tags.DateTime?.description);
    } catch {
      /* không có EXIF hoặc chunk chưa đủ */
    }

    if (out.w !== null && out.taken !== null) break;
    if (buf.length < len) break; // đã đọc hết file, đọc thêm cũng vô ích
  }

  // Orientation 5-8 = xoay 90°: w/h trong file là trước khi xoay, phải đảo
  // ở đây, nếu không toàn bộ ảnh dọc chụp ngang sẽ sai tỉ lệ trong grid.
  if (out.orient >= 5 && out.orient <= 8 && out.w !== null) {
    [out.w, out.h] = [out.h, out.w];
  }
  return out;
}
