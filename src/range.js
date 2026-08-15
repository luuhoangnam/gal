import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { mediaType } from './media-types.js';

export const UNSATISFIABLE = Symbol('unsatisfiable');

/**
 * Parse header `Range`.
 * @returns null nếu không có range (hoặc cú pháp lạ → RFC 9110 nói bỏ qua),
 *          UNSATISFIABLE nếu range hợp lệ nhưng nằm ngoài file → 416,
 *          hoặc {start, end} inclusive.
 * Multi-range cố ý không hỗ trợ: browser gần như không gửi cho <video>.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;

  if (rawStart === '' && rawEnd === '') return null;

  let start, end;
  if (rawStart === '') {
    // suffix range: bytes=-500 → 500 byte cuối
    const len = Number(rawEnd);
    if (len === 0) return UNSATISFIABLE;
    start = Math.max(0, size - len);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (size === 0 || start >= size || start > end) return UNSATISFIABLE;
  return { start, end };
}

function etagOf(st) {
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/**
 * Điều kiện If-Range: chỉ áp dụng range khi validator còn khớp.
 * Thiếu bước này gây bug im lặng — <video> thỉnh thoảng tải lại cả file sau khi seek.
 */
function ifRangeMatches(header, st) {
  if (!header) return true;
  if (header.startsWith('"') || header.startsWith('W/')) return header === etagOf(st);
  const t = Date.parse(header);
  return Number.isFinite(t) && Math.floor(st.mtimeMs / 1000) * 1000 === t;
}

/** Phục vụ một file đã được xác thực nằm trong root, có hỗ trợ Range. */
export async function serveFile(req, res, absPath) {
  const st = await stat(absPath);
  const type = mediaType(path.extname(absPath));
  const etag = etagOf(st);

  const headers = {
    'Content-Type': type ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
    'Last-Modified': new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString(),
  };

  const useRange = ifRangeMatches(req.headers['if-range'], st);
  const range = useRange ? parseRange(req.headers.range, st.size) : null;

  if (range === UNSATISFIABLE) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    res.end();
    return;
  }

  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    createReadStream(absPath).pipe(res);
    return;
  }

  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
    'Content-Length': range.end - range.start + 1,
  });
  createReadStream(absPath, { start: range.start, end: range.end }).pipe(res);
}
