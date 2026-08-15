import path from 'node:path';
import { readFileSync } from 'node:fs';
import { stat, rm, readdir } from 'node:fs/promises';
import { createServer } from './server.js';
import { cacheDirFor } from './cache-dir.js';
import { ffmpegPath, ffmpegMissingMessage } from './ffmpeg.js';

const PKG = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const USAGE = `gal <thư mục> [tuỳ chọn]

  --lan                cho phép truy cập từ máy khác trong LAN (= --host 0.0.0.0)
  --host <địa chỉ>     địa chỉ bind, mặc định 127.0.0.1
  --port <số>          cổng, mặc định 0 = cổng ngẫu nhiên còn trống
  --watch              tự quét lại khi thư mục có thay đổi
  --include-bundles    quét cả bundle macOS (.photoslibrary, .app, ...)
  --follow-symlinks    đi theo symlink thư mục
  --clear-cache        xoá index + thumbnail của thư mục rồi thoát
  --version            in phiên bản
  --help               bảng này

Ví dụ:
  gal ~/Pictures
  gal . --port 8080
  gal ~/Ảnh --lan --watch`;

const FLAGS = new Set([
  '--lan', '--watch', '--include-bundles', '--follow-symlinks',
  '--clear-cache', '-h', '--help', '-v', '--version',
]);
const OPTS = new Set(['--host', '--port']);

/** Parser tối giản: đủ cho 5 tuỳ chọn, không kéo thêm thư viện. */
export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) opts[a.replace(/^--?/, '')] = true;
    else if (OPTS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`thiếu giá trị cho ${a}`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new Error(`tuỳ chọn không biết: ${a}`);
    else positional.push(a);
  }
  return { opts, positional };
}

export async function main(argv) {
  let opts, positional;
  try {
    ({ opts, positional } = parseArgs(argv));
  } catch (err) {
    console.error(`gal: ${err.message}`);
    process.exit(1);
  }

  if (opts.v || opts.version) {
    console.log(PKG.version);
    process.exit(0);
  }

  if (positional.length === 0 || opts.h || opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const port = opts.port === undefined ? 0 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`gal: cổng không hợp lệ: ${opts.port}`);
    process.exit(1);
  }
  const host = opts.host ?? (opts.lan ? '0.0.0.0' : '127.0.0.1');

  const root = path.resolve(positional[0]);
  try {
    const st = await stat(root);
    if (!st.isDirectory()) {
      console.error(`gal: không phải thư mục: ${root}`);
      process.exit(1);
    }
  } catch {
    console.error(`gal: không tìm thấy: ${root}`);
    process.exit(1);
  }

  if (opts['clear-cache']) return clearCache(root);

  // Kiểm ffmpeg TRƯỚC khi mở server: không có nó thì mọi thumbnail đều hỏng, và
  // một lưới toàn ô xám khó hiểu hơn nhiều so với một câu báo lỗi.
  if (ffmpegPath() === null) {
    console.error(ffmpegMissingMessage());
    process.exit(1);
  }

  const scan = {
    includeBundles: Boolean(opts['include-bundles']),
    followSymlinks: Boolean(opts['follow-symlinks']),
  };

  let url, lanUrls;
  let server;
  try {
    server = createServer(root, { host, port, scan, watch: Boolean(opts.watch) });
    ({ url, lanUrls } = await server.listen());
  } catch (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `gal: cổng ${port} đang bận`
        : `gal: không bind được ${host}:${port} — ${err.message}`,
    );
    process.exit(1);
  }

  console.log(url);
  for (const u of lanUrls) console.log(`${u}   (LAN)`);
  if (lanUrls.length > 0) console.log(`Cả mạng đọc được mọi file media dưới ${root}.`);

  // Dọn cache một lần lúc khởi động, không chạy nền liên tục
  server.thumbs.sweep().then(({ bytes, removed }) => {
    if (removed > 0) console.log(`Đã dọn ${removed} thumbnail cũ (vượt ngưỡng cache).`);
    else if (bytes > 500 * 1024 * 1024) {
      console.log(`Cache thumbnail đang dùng ${(bytes / 1024 ** 3).toFixed(1)}GB tại ${server.thumbs.dir}`);
    }
  });
}

/** Dung lượng thư mục, đệ quy. Đủ dùng cho một con số in ra một lần. */
async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await stat(p)).size;
    } catch {
      /* file biến mất giữa chừng */
    }
  }
  return total;
}

/**
 * Cache nằm trong `<root>/.gal` (hoặc /tmp khi root chỉ đọc), không phải một
 * thư mục chung — nên xoá cache cần biết xoá cache CỦA THƯ MỤC NÀO.
 */
async function clearCache(root) {
  const dir = cacheDirFor(root);
  let bytes = 0;
  try {
    bytes = await dirSize(dir);
  } catch {
    console.log(`gal: không có cache nào tại ${dir}`);
    return;
  }
  await rm(dir, { recursive: true, force: true });
  console.log(`Đã xoá ${dir} — giải phóng ${(bytes / 1024 ** 2).toFixed(1)} MB`);
}
