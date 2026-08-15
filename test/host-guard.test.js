import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createServer, localHostnames } from '../src/server.js';

let base, url, srv, cacheDir;
const BODY = 'x'.repeat(1000);

before(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-srv-')));
  await writeFile(path.join(base, 'a.jpg'), BODY);
  await writeFile(path.join(base, 'evil.html'), '<script>fetch("/api/file?p=a.jpg")</script>');
  cacheDir = path.join(base, '.cache');
  const s = createServer(base, { cacheDir });
  srv = s.server;
  ({ url } = await s.listen());
});

after(() => srv.close());

// Dùng node:http thô, không dùng fetch: undici cấm ghi đè header Host,
// mà Host chính là thứ cần test.
function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url + p, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
          text: async () => Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('request bình thường qua', async () => {
  const r = await get('/api/file?p=a.jpg');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
});

test('Host lạ → 403', async () => {
  const r = await get('/', { Host: 'evil.com' });
  assert.equal(r.status, 403);
});

test('Origin chéo → 403', async () => {
  const r = await get('/api/file?p=a.jpg', { Origin: 'https://evil.com' });
  assert.equal(r.status, 403);
});

test('Sec-Fetch-Site: cross-site → 403', async () => {
  const r = await get('/api/file?p=a.jpg', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
});

test('Sec-Fetch-Site: same-site (khác cổng) → 403', async () => {
  const r = await get('/api/file?p=a.jpg', { 'Sec-Fetch-Site': 'same-site' });
  assert.equal(r.status, 403);
});

test('file .html trong thư mục ảnh không được phục vụ', async () => {
  const r = await get('/api/file?p=evil.html');
  assert.equal(r.status, 403);
});

test('path traversal bị chặn, kể cả khi đã encode', async () => {
  for (const p of [
    '../../../../etc/passwd',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/etc/passwd',
  ]) {
    const r = await get('/api/file?p=' + encodeURIComponent(p));
    assert.equal(r.status, 403, p);
  }
});

test('trang tĩnh phục vụ được', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>gal<\/title>/);
});

test('Range 206 đúng byte', async () => {
  const r = await get('/api/file?p=a.jpg', { Range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-99/1000');
  assert.equal((await r.text()).length, 100);
});

test('range ngoài file → 416', async () => {
  const r = await get('/api/file?p=a.jpg', { Range: 'bytes=5000-6000' });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */1000');
});

test('mặc định chỉ bind loopback', () => {
  assert.equal(srv.address().address, '127.0.0.1');
  assert.deepEqual(localHostnames(false), ['127.0.0.1', 'localhost', '[::1]']);
});

test('bind 0.0.0.0: URL in ra là loopback, không phải 0.0.0.0 (không gõ được)', async () => {
  const s = createServer(base, { cacheDir, host: '0.0.0.0' });
  const { url, lanUrls } = await s.listen();
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(!lanUrls.some((u) => u.includes('0.0.0.0')));
  } finally {
    s.server.close();
  }
});

test('--lan: bind mọi interface, chấp nhận Host là IP LAN thật', async () => {
  const s = createServer(base, { cacheDir, host: '0.0.0.0' });
  const { url: lanBase, lanUrls } = await s.listen();
  const port = s.server.address().port;
  const ip = new URL(lanUrls[0] ?? lanBase).hostname;

  try {
    assert.equal(s.server.address().address, '0.0.0.0');

    const ok = await new Promise((resolve) => {
      http
        .request(`${lanBase}/api/file?p=a.jpg`, { headers: { Host: `${ip}:${port}` } }, (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .end();
    });
    assert.equal(ok, 200);

    // Rebinding vẫn bị chặn: --lan không phải "chấp nhận mọi Host"
    const bad = await new Promise((resolve) => {
      http
        .request(`${lanBase}/api/file?p=a.jpg`, { headers: { Host: `evil.com:${port}` } }, (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .end();
    });
    assert.equal(bad, 403);

    assert.ok(localHostnames(true).includes(os.hostname()));
  } finally {
    s.server.close();
  }
});

test('--port cố định được tôn trọng; cổng bận → EADDRINUSE', async () => {
  const a = createServer(base, { cacheDir, port: 0 });
  await a.listen();
  const taken = a.server.address().port;
  try {
    const b = createServer(base, { cacheDir, port: taken });
    await assert.rejects(() => b.listen(), (e) => e.code === 'EADDRINUSE');

    const c = createServer(base, { cacheDir, port: taken + 1 });
    const { url: u } = await c.listen();
    assert.equal(new URL(u).port, String(taken + 1));
    c.server.close();
  } finally {
    a.server.close();
  }
});

test('/api/scan trả NDJSON hợp lệ: pha A rồi pha B', async () => {
  const r = await get('/api/scan');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/x-ndjson/);

  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  const kinds = lines.map((l) => l.t);
  assert.ok(kinds.includes('a'), 'phải có lô pha A');
  assert.ok(kinds.indexOf('done_a') < kinds.indexOf('done_b'), 'done_a phải trước done_b');

  const items = lines.filter((l) => l.t === 'a').flatMap((l) => l.items);
  assert.deepEqual(items.map((i) => i.p), ['a.jpg']); // evil.html không phải media
  assert.ok(Number.isInteger(items[0].i) && items[0].i > 0, 'phải có rowid');
  assert.equal(lines.find((l) => l.t === 'done_a').n, 1);
});

test('/api/thumb: hash lạ → placeholder, hash sai định dạng → 404', async () => {
  const unknown = await get(`/api/thumb/${'0'.repeat(40)}.jpg`);
  assert.equal(unknown.status, 404); // client vẽ ô hỏng, server không redirect

  for (const bad of ['/api/thumb/xyz.jpg', '/api/thumb/../../etc/passwd', '/api/thumb/abc']) {
    assert.equal((await get(bad)).status, 404, bad);
  }
});

test('/api/priority nhận danh sách khoá vùng đang xem', async () => {
  const post = (body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        url + '/api/priority',
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
        (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  assert.equal(await post(JSON.stringify({ keys: ['a'.repeat(40)] })), 204);
  assert.equal(await post('không phải json'), 400);
  // Vẫn nằm sau lớp guard cross-origin
  assert.equal(await post(JSON.stringify({ keys: [] }), { Origin: 'https://evil.com' }), 403);
});

test('If-Range khớp → 206, không khớp → 200 cả file', async () => {
  const head = await get('/api/file?p=a.jpg');
  const etag = head.headers.get('etag');

  const ok = await get('/api/file?p=a.jpg', { Range: 'bytes=0-9', 'If-Range': etag });
  assert.equal(ok.status, 206);

  const stale = await get('/api/file?p=a.jpg', { Range: 'bytes=0-9', 'If-Range': '"deadbeef-1"' });
  assert.equal(stale.status, 200);
  assert.equal((await stale.text()).length, 1000);
});
