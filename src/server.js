import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { openIndex } from './index-db.js';
import { createScanner } from './scan.js';
import { createThumbs } from './thumbs.js';
import { resolveInside } from './safe-path.js';
import { serveFile } from './range.js';
import { mediaType } from './media-types.js';

const WEB_DIR = path.join(import.meta.dirname, '..', 'web');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * Địa chỉ mà server chấp nhận trong header Host.
 *
 * Ở chế độ LAN vẫn phải là allowlist địa chỉ THẬT của máy, không phải "chấp nhận
 * mọi Host": nới lỏng hoàn toàn là mở lại đúng lỗ DNS rebinding mà lớp 2 sinh ra
 * để chặn — evil.com trỏ về 192.168.x.x cũng đi lọt như khi trỏ về 127.0.0.1.
 */
export function localHostnames(lan, bindHost) {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (!lan) return names;

  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.internal) continue;
      names.push(ni.family === 'IPv6' ? `[${ni.address}]` : ni.address);
    }
  }
  names.push(os.hostname(), `${os.hostname().replace(/\.local$/, '')}.local`);
  // Bind vào một địa chỉ cụ thể thì chính nó cũng phải hợp lệ
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::' && !names.includes(bindHost)) {
    names.push(bindHost);
  }
  return names;
}

/** Loopback thì giữ nguyên chế độ chặt; mọi địa chỉ khác là phơi ra ngoài máy. */
export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Lớp 2 — Host guard, chặn DNS rebinding. Port ngẫu nhiên một mình không đủ:
 * trang độc hại rebind evil.com → 127.0.0.1, và same-origin policy so hostname
 * chứ không so IP (Vite: GHSA-vg6x-rcgg-rjx6).
 */
function hostAllowed(host, port, names) {
  return names.some((n) => host === `${n}:${port}`);
}

/**
 * Lớp 3 — Origin / Sec-Fetch-Site. Host cũng không đủ:
 * <img src="http://127.0.0.1:PORT/..."> từ trang bất kỳ gửi Host HỢP LỆ.
 * Chỉ chấp nhận request không có ngữ cảnh chéo.
 */
function fetchContextAllowed(req, port, names) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const origin = req.headers.origin;
  if (origin) {
    let h;
    try {
      h = new URL(origin).host;
    } catch {
      return false;
    }
    if (!hostAllowed(h, port, names)) return false;
  }
  return true;
}

function deny(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

async function serveStatic(req, res, rel) {
  const abs = await resolveInside(WEB_DIR, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error('not a file');
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  createReadStream(abs).pipe(res);
}

const BATCH = 500;

/** Ghi một dòng NDJSON, tôn trọng backpressure — chỗ ReadableStream thắng SSE. */
async function writeLine(res, obj) {
  if (!res.write(JSON.stringify(obj) + '\n')) await once(res, 'drain');
}

export function createServer(
  root,
  { host = '127.0.0.1', port: wantPort = 0, scan = {}, cacheDir } = {},
) {
  let port = 0;
  const exposed = !isLoopback(host);
  const names = localHostnames(exposed, host);

  // Thư mục ngoài root mà walker đã đi vào qua symlink khi bật --follow-symlinks.
  // Không có tập này thì walker index được file mà /api/file lại trả 403.
  const extraRoots = new Set();
  const onExtraRoot = scan.followSymlinks ? (dir) => void extraRoots.add(dir) : undefined;

  const db = openIndex(root, cacheDir);
  const thumbs = createThumbs(root, {
    cacheDir: cacheDir ? path.join(cacheDir, 'thumbs') : undefined,
  });
  const scanner = createScanner(root, db, { ...scan, onExtraRoot });

  const resolveMedia = (p) => resolveInside([root, ...extraRoots], p);

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, port, names)) return deny(res, 403, 'bad host');
      if (!fetchContextAllowed(req, port, names))
        return deny(res, 403, 'cross-origin request denied');

      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      // Client báo vùng đang xem để hàng đợi thumbnail phục vụ chỗ đó trước
      if (url.pathname === '/api/priority' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) {
          chunks.push(c);
          if (chunks.reduce((n, b) => n + b.length, 0) > 1 << 20) return deny(res, 413, 'too big');
        }
        try {
          const { keys } = JSON.parse(Buffer.concat(chunks).toString());
          thumbs.setPriority(Array.isArray(keys) ? keys : []);
        } catch {
          return deny(res, 400, 'bad json');
        }
        res.writeHead(204).end();
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405, 'method');

      if (url.pathname.startsWith('/api/thumb/')) {
        const hash = /^\/api\/thumb\/([0-9a-f]{40})\.jpg$/.exec(url.pathname)?.[1];
        if (!hash) return deny(res, 404, 'not found');
        const file = await thumbs.get(hash);
        if (!file) {
          // File hỏng → placeholder, pipeline không chết
          res.writeHead(302, { Location: '/assets/broken.svg', 'Cache-Control': 'no-store' });
          return res.end();
        }
        const st = await stat(file);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': st.size,
          'X-Content-Type-Options': 'nosniff',
          // Khoá đã gồm mtime+size nên nội dung không bao giờ đổi dưới cùng URL
          'Cache-Control': 'max-age=31536000, immutable',
        });
        if (req.method === 'HEAD') return res.end();
        return void thumbs.stream(file).pipe(res);
      }

      if (url.pathname === '/api/file') {
        const p = url.searchParams.get('p');
        if (!p) return deny(res, 400, 'missing p');
        let abs;
        try {
          abs = await resolveMedia(p);
        } catch {
          return deny(res, 403, 'forbidden');
        }
        // Allowlist đuôi: file .html/.svg dưới thư mục ảnh không bao giờ được
        // phục vụ, nếu không script chạy trong origin của gal và đọc cả root.
        if (!mediaType(path.extname(abs))) return deny(res, 403, 'not a media file');
        return await serveFile(req, res, abs);
      }

      if (url.pathname === '/api/scan') {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();

        // Cache trước: grid đầy ngay, rồi pha A chạy nền để phát hiện thay đổi
        const cached = db.cached();
        for (let i = 0; i < cached.length; i += BATCH) {
          if (res.destroyed) return;
          await writeLine(res, { t: 'cache', items: thumbs.keyed(cached.slice(i, i + BATCH)) });
        }
        if (cached.length > 0) await writeLine(res, { t: 'done_cache', n: cached.length });

        for await (const msg of scanner.stream()) {
          if (res.destroyed) return; // client đóng tab
          await writeLine(res, msg.t === 'a' ? { ...msg, items: thumbs.keyed(msg.items) } : msg);
        }
        scanner.reset();
        return res.end();
      }

      if (url.pathname.startsWith('/api/')) return deny(res, 404, 'not found');

      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      return await serveStatic(req, res, rel);
    } catch (err) {
      if (!res.headersSent) deny(res, err?.code === 'ENOENT' ? 404 : 500, 'error');
      else res.destroy();
    }
  });

  server.on('close', () => db.close());

  return {
    server,
    db,
    thumbs,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, host, () => {
          port = server.address().port;
          resolve({
            url: `http://${isLoopback(host) ? '127.0.0.1' : host}:${port}`,
            // URL để gõ từ máy khác trong LAN; rỗng khi chỉ bind loopback
            lanUrls: exposed
              ? names
                  .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n) && n !== '127.0.0.1')
                  .map((n) => `http://${n}:${port}`)
              : [],
          });
        });
      });
    },
  };
}
