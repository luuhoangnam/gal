import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

// Lightbox tải PhotoSwipe từ /vendor và ảnh HEIC từ /api/preview. Hai route này
// phục vụ file ngoài WEB_DIR nên chúng phải chịu đúng ràng buộc như /api/file.
let base, url, srv;

before(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-lb-')));
  await writeFile(path.join(base, 'a.jpg'), 'x');
  const s = createServer(base, { cacheDir: path.join(base, '.cache') });
  srv = s.server;
  ({ url } = await s.listen());
});

after(() => srv.close());

test('phục vụ PhotoSwipe ESM offline từ node_modules', async () => {
  const res = await fetch(`${url}/vendor/photoswipe/photoswipe.esm.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await res.text(), /export/);
});

test('CSS của PhotoSwipe cũng phục vụ được', async () => {
  const res = await fetch(`${url}/vendor/photoswipe/photoswipe.css`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
});

test('không đi ngược ra khỏi thư mục vendor', async () => {
  const res = await fetch(`${url}/vendor/photoswipe/../../../package.json`, { redirect: 'manual' });
  assert.notEqual(res.status, 200);
});

test('preview chỉ dành cho định dạng browser không giải mã được', async () => {
  const res = await fetch(`${url}/api/preview?p=a.jpg`);
  assert.equal(res.status, 404); // .jpg thì lightbox trỏ thẳng /api/file
});

test('preview chặn path traversal', async () => {
  const res = await fetch(`${url}/api/preview?p=${encodeURIComponent('../../etc/hosts.heic')}`);
  assert.equal(res.status, 403);
});
