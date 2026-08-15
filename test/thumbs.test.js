import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, stat, readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createThumbs, thumbKey } from '../src/thumbs.js';
import { ffmpegPath } from '../src/ffmpeg.js';

const run = promisify(execFile);
let dir, root, hasFfmpeg;

before(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-th-')));
  root = path.join(dir, 'media');
  await import('node:fs/promises').then((m) => m.mkdir(root, { recursive: true }));
  hasFfmpeg = ffmpegPath() !== null;
});

async function makeImage(name, size = '400x300') {
  const f = path.join(root, name);
  await run('ffmpeg', [
    '-y', '-loglevel', 'quiet',
    '-f', 'lavfi', '-i', `color=c=orange:s=${size}:d=1`, '-frames:v', '1', f,
  ]);
  return f;
}

async function makeVideo(name) {
  const f = path.join(root, name);
  await run('ffmpeg', [
    '-y', '-loglevel', 'quiet',
    // testsrc chứ không phải màu phẳng: khung đen và khung có nội dung mới phân biệt được
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f,
  ]);
  return f;
}

async function itemFor(abs) {
  const st = await stat(abs);
  return {
    p: path.relative(root, abs),
    s: st.size,
    m: Math.floor(st.mtimeMs),
    v: /\.(mp4|mov)$/.test(abs) ? 1 : 0,
  };
}

function thumbsFor(sub, opts = {}) {
  return createThumbs(root, { cacheDir: path.join(dir, sub), ...opts });
}

test('khoá là hash nội dung, đổi mtime/size/root là đổi khoá', () => {
  const a = thumbKey('/r/a.jpg', 1000, 50);
  assert.equal(a, thumbKey('/r/a.jpg', 1000, 50), 'cùng đầu vào → cùng khoá');
  assert.notEqual(a, thumbKey('/r/a.jpg', 1001, 50), 'mtime đổi');
  assert.notEqual(a, thumbKey('/r/a.jpg', 1000, 51), 'size đổi');
  assert.notEqual(a, thumbKey('/other/a.jpg', 1000, 50), 'root khác → không lẫn cache');
  // mtimeMs là số thực; floor phải khớp công thức của index
  assert.equal(thumbKey('/r/a.jpg', 1000.9876, 50), a);
});

test('ảnh → JPEG 320px, video → poster frame không đen', async (t) => {
  if (!hasFfmpeg) return t.skip('không có ffmpeg');
  const th = thumbsFor('c1');
  const img = await makeImage('a.jpg');
  const vid = await makeVideo('v.mp4');
  const [ki, kv] = th.keyed([await itemFor(img), await itemFor(vid)]).map((i) => i.k);

  const fi = await th.get(ki);
  assert.ok(fi, 'phải tạo được thumbnail ảnh');
  const { stdout } = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', fi,
  ]);
  assert.equal(JSON.parse(stdout).streams[0].width, 320);

  const fv = await th.get(kv);
  assert.ok(fv, 'phải tạo được poster frame video');
  assert.ok((await stat(fv)).size > 1000, 'poster frame rỗng nghi là khung đen');
});

test('20 request song song cùng hash → đúng 1 process ffmpeg', async (t) => {
  if (!hasFfmpeg) return t.skip('không có ffmpeg');
  const th = thumbsFor('c2');
  const [it] = th.keyed([await itemFor(await makeImage('dedupe.jpg'))]);
  const before = th.spawned;
  const files = await Promise.all(Array.from({ length: 20 }, () => th.get(it.k)));
  assert.equal(th.spawned - before, 1);
  assert.ok(files.every((f) => f === files[0]));
});

test('lần thứ hai lấy từ cache, không gọi ffmpeg', async (t) => {
  if (!hasFfmpeg) return t.skip('không có ffmpeg');
  const th = thumbsFor('c3');
  const [it] = th.keyed([await itemFor(await makeImage('cached.jpg'))]);
  await th.get(it.k);
  const after = th.spawned;
  await th.get(it.k);
  assert.equal(th.spawned, after, 'cache hit không được spawn thêm');
});

test('sửa mtime → khoá đổi → thumbnail sinh lại', async (t) => {
  if (!hasFfmpeg) return t.skip('không có ffmpeg');
  const th = thumbsFor('c4');
  const f = await makeImage('touch.jpg');
  const [before] = th.keyed([await itemFor(f)]);
  await th.get(before.k);

  const t2 = new Date(Date.now() + 60_000);
  await utimes(f, t2, t2);
  const [after] = th.keyed([await itemFor(f)]);
  assert.notEqual(after.k, before.k);

  const n = th.spawned;
  await th.get(after.k);
  assert.equal(th.spawned - n, 1, 'file đã đổi phải sinh lại');
});

test('file hỏng: placeholder, và chỉ spawn ffmpeg MỘT lần dù gọi lại nhiều lần', async (t) => {
  if (!hasFfmpeg) return t.skip('không có ffmpeg');
  const th = thumbsFor('c5');
  await writeFile(path.join(root, 'broken.jpg'), 'không phải ảnh');
  await writeFile(path.join(root, 'empty.jpg'), '');
  const items = th.keyed([
    await itemFor(path.join(root, 'broken.jpg')),
    await itemFor(path.join(root, 'empty.jpg')),
  ]);

  const before = th.spawned;
  for (const it of items) assert.equal(await th.get(it.k), null);
  const afterFirst = th.spawned - before;
  assert.equal(afterFirst, 2, 'mỗi file hỏng thử đúng một lần');

  // cuộn qua lại nhiều lần: negative cache phải chặn bão process
  for (let i = 0; i < 5; i++) for (const it of items) await th.get(it.k);
  assert.equal(th.spawned - before, 2, 'không được spawn lại file đã biết là hỏng');
});

test('hash không biết → null, không tạo file lạ', async () => {
  const th = thumbsFor('c6');
  assert.equal(await th.get('0'.repeat(40)), null);
});

test('vượt ngưỡng → dọn LRU theo atime, dừng khi đã dưới ngưỡng', async (t) => {
  if (!hasFfmpeg) return t.skip('không có ffmpeg');
  const th = thumbsFor('c7');
  const keys = [];
  for (let i = 0; i < 4; i++) {
    const [it] = th.keyed([await itemFor(await makeImage(`lru${i}.jpg`, `${400 + i}x300`))]);
    keys.push(it.k);
    await th.get(it.k);
  }
  const files = await readdir(th.dir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 4);

  const total = (
    await Promise.all(files.map((f) => stat(path.join(th.dir, f)).then((s) => s.size)))
  ).reduce((a, b) => a + b, 0);

  const small = createThumbs(root, { cacheDir: th.dir, maxBytes: Math.floor(total / 2) });
  const { removed, bytes } = await small.sweep();
  assert.ok(removed > 0, 'phải xoá ít nhất một file');
  assert.ok(bytes <= Math.floor(total / 2), 'phải xuống dưới ngưỡng');
  assert.ok(
    (await readdir(th.dir)).filter((f) => f.endsWith('.jpg')).length > 0,
    'không được xoá sạch',
  );
});
