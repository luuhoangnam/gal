import path from 'node:path';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from './server.js';

const USAGE = `gal <thư mục> [tuỳ chọn]

  --lan                cho phép truy cập từ máy khác trong LAN (= --host 0.0.0.0)
  --host <địa chỉ>     địa chỉ bind, mặc định 127.0.0.1
  --port <số>          cổng, mặc định 0 = cổng ngẫu nhiên còn trống
  --include-bundles    quét cả bundle macOS (.photoslibrary, .app, ...)
  --follow-symlinks    đi theo symlink thư mục`;

const FLAGS = new Set(['--lan', '--include-bundles', '--follow-symlinks', '-h', '--help']);
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

/** Mở Chrome cụ thể, không phải browser mặc định — v1 chỉ nhắm Chrome. */
function openChrome(url) {
  return new Promise((resolve) => {
    const p = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export async function main(argv) {
  let opts, positional;
  try {
    ({ opts, positional } = parseArgs(argv));
  } catch (err) {
    console.error(`gal: ${err.message}`);
    process.exit(1);
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

  const scan = {
    includeBundles: Boolean(opts['include-bundles']),
    followSymlinks: Boolean(opts['follow-symlinks']),
  };

  let url, lanUrls;
  let server;
  try {
    server = createServer(root, { host, port, scan });
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

  if (!(await openChrome(url))) {
    console.log('Không mở được Google Chrome — v1 nhắm Chrome. Mở URL trên thủ công.');
  }
}
