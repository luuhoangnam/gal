import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cacheDirFor, flatten } from '../src/cache-dir.js';

const fresh = async () => realpath(await mkdtemp(path.join(tmpdir(), 'gal-cd-')));

test('thư viện ghi được thì cache nằm trong <root>/.gal', async () => {
  const root = await fresh();
  assert.equal(cacheDirFor(root), path.join(root, '.gal'));
});

test('thư viện chỉ đọc thì rơi về /tmp/gal/<path phẳng>', async () => {
  const root = await fresh();
  await chmod(root, 0o555);
  try {
    const dir = cacheDirFor(root);
    assert.equal(dir, path.join('/tmp/gal', flatten(root)));
    await rm(dir, { recursive: true, force: true });
  } finally {
    await chmod(root, 0o755); // trả quyền để dọn tmpdir được
  }
});

test('flatten bỏ dấu / đầu và nối bằng gạch ngang', async () => {
  const root = await fresh();
  assert.equal(flatten(root), root.replace(/^\/+/, '').replaceAll('/', '-'));
});
