import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { walk, newStats } from '../src/walk.js';

async function tree() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-walk-')));
  await mkdir(path.join(root, 'sub', 'deep'), { recursive: true });
  await mkdir(path.join(root, '.hidden'));
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'Photos Library.photoslibrary'));
  await writeFile(path.join(root, 'a.jpg'), 'a');
  await writeFile(path.join(root, 'sub', 'b.png'), 'bb');
  await writeFile(path.join(root, 'sub', 'deep', 'c.mp4'), 'ccc');
  await writeFile(path.join(root, 'sub', 'ảnh 🌞 đẹp.HEIC'), 'dddd');
  await writeFile(path.join(root, 'readme.txt'), 'x');
  await writeFile(path.join(root, '.hidden', 'nope.jpg'), 'x');
  await writeFile(path.join(root, 'node_modules', 'nope.jpg'), 'x');
  await writeFile(path.join(root, 'Photos Library.photoslibrary', 'inside.jpg'), 'x');
  return root;
}

const collect = async (root, opts = {}) => {
  const stats = newStats();
  const out = [];
  for await (const it of walk(root, { ...opts, stats })) out.push(it);
  return { out, stats };
};

test('duyệt đệ quy, chỉ lấy media, đường dẫn tương đối', async () => {
  const { out } = await collect(await tree());
  const ps = out.map((i) => i.p).sort();
  assert.deepEqual(ps, [
    'a.jpg',
    path.join('sub', 'b.png'),
    path.join('sub', 'deep', 'c.mp4'),
    path.join('sub', 'ảnh 🌞 đẹp.HEIC'),
  ]);
  assert.ok(!ps.some((p) => path.isAbsolute(p)));
});

test('tên emoji và dấu tiếng Việt không mojibake', async () => {
  const { out } = await collect(await tree());
  const f = out.find((i) => i.p.includes('🌞'));
  assert.ok(f, 'không tìm thấy file emoji');
  assert.match(f.p, /ảnh 🌞 đẹp\.HEIC$/);
});

test('phân loại video và metadata cơ bản', async () => {
  const { out } = await collect(await tree());
  const mp4 = out.find((i) => i.p.endsWith('.mp4'));
  assert.equal(mp4.v, 1);
  assert.equal(mp4.s, 3);
  assert.ok(Number.isInteger(mp4.m), 'mtime phải là số nguyên');
  assert.equal(out.find((i) => i.p === 'a.jpg').v, 0);
});

test('bỏ qua thư mục ẩn, node_modules, bundle macOS', async () => {
  const { out, stats } = await collect(await tree());
  assert.ok(!out.some((i) => i.p.includes('.hidden')));
  assert.ok(!out.some((i) => i.p.includes('node_modules')));
  assert.ok(!out.some((i) => i.p.includes('photoslibrary')));
  assert.equal(stats.skippedBundles, 1);
});

test('--include-bundles quét vào .photoslibrary', async () => {
  const { out } = await collect(await tree(), { includeBundles: true });
  assert.ok(out.some((i) => i.p.includes('photoslibrary')));
});

test('symlink thư mục: mặc định không đi vào', async () => {
  const root = await tree();
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-out-')));
  await writeFile(path.join(outside, 'secret.jpg'), 'x');
  await symlink(outside, path.join(root, 'link'));

  const { out } = await collect(root);
  assert.ok(!out.some((i) => i.p.includes('link')));

  const { out: followed } = await collect(root, { followSymlinks: true });
  assert.ok(followed.some((i) => i.p.includes('secret.jpg')));
});

test('symlink lặp về thư mục cha không treo', async () => {
  const root = await tree();
  await symlink(root, path.join(root, 'sub', 'loop'));
  const { out } = await collect(root, { followSymlinks: true });
  // Kết thúc là đủ; và mỗi file chỉ ra một lần cho mỗi nhánh hữu hạn
  assert.ok(out.length < 50, `nghi ngờ lặp: ${out.length} mục`);
});

test('thư mục không quyền đọc bị bỏ qua, scan chạy tiếp', async () => {
  const root = await tree();
  const locked = path.join(root, 'locked');
  await mkdir(locked);
  await writeFile(path.join(locked, 'x.jpg'), 'x');
  await chmod(locked, 0o000);
  try {
    const { out, stats } = await collect(root);
    assert.equal(stats.skippedDirs, 1);
    assert.ok(out.some((i) => i.p === 'a.jpg'), 'các file khác vẫn phải ra');
  } finally {
    await chmod(locked, 0o755);
  }
});
