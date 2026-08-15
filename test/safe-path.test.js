import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInside } from '../src/safe-path.js';

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-')));
  const root = path.join(base, 'root');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await writeFile(path.join(root, 'a.jpg'), 'a');
  await writeFile(path.join(root, 'sub', 'b.jpg'), 'b');
  await writeFile(path.join(base, 'secret.txt'), 'secret');
  await mkdir(path.join(base, 'root-evil'));
  await writeFile(path.join(base, 'root-evil', 'c.jpg'), 'c');
  return { base, root };
}

test('cho phép file trong root', async () => {
  const { root } = await fixture();
  assert.equal(await resolveInside(root, 'a.jpg'), path.join(root, 'a.jpg'));
  assert.equal(await resolveInside(root, 'sub/b.jpg'), path.join(root, 'sub', 'b.jpg'));
});

test('chặn traversal bằng ..', async () => {
  const { root } = await fixture();
  await assert.rejects(() => resolveInside(root, '../secret.txt'));
  await assert.rejects(() => resolveInside(root, '../../../../etc/passwd'));
  await assert.rejects(() => resolveInside(root, 'sub/../../secret.txt'));
});

test('chặn absolute path', async () => {
  const { root } = await fixture();
  await assert.rejects(() => resolveInside(root, '/etc/passwd'));
});

test('startsWith sẽ trượt: root-evil không được coi là trong root', async () => {
  const { base, root } = await fixture();
  await assert.rejects(() => resolveInside(root, path.join('..', 'root-evil', 'c.jpg')));
  assert.ok(base);
});

test('symlink trỏ ra ngoài root bị chặn', async () => {
  const { base, root } = await fixture();
  await symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  await assert.rejects(() => resolveInside(root, 'link.txt'));
});

test('root khác case không mở được đường ra ngoài (APFS)', async () => {
  const { root } = await fixture();
  const upper = root.toUpperCase();
  // Dù APFS case-insensitive, không biến thể nào được trả về path ngoài root thật
  for (const rel of [`${upper}/../secret.txt`, '../SECRET.TXT']) {
    await assert.rejects(() => resolveInside(root, rel));
  }
});

test('file chưa tồn tại vẫn được kiểm tra qua thư mục cha', async () => {
  const { root } = await fixture();
  assert.equal(await resolveInside(root, 'new.jpg'), path.join(root, 'new.jpg'));
  await assert.rejects(() => resolveInside(root, '../new.jpg'));
});
