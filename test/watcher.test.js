import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatcher } from '../src/watcher.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gal-watch-'));

test('rev tăng khi có file mới, chờ đúng lượt', async () => {
  const root = tmp();
  const w = createWatcher(root, { debounce: 30 });
  if (w === null) return; // nền tảng không hỗ trợ watch đệ quy

  const waiting = w.wait(0, 5000);
  writeFileSync(path.join(root, 'a.jpg'), 'x');
  assert.equal(await waiting, 1);
  w.close();
});

test('nhiều thay đổi liên tiếp gom thành một rev', async () => {
  const root = tmp();
  const w = createWatcher(root, { debounce: 50 });
  if (w === null) return;

  for (let i = 0; i < 20; i++) writeFileSync(path.join(root, `${i}.jpg`), 'x');
  assert.equal(await w.wait(0, 5000), 1);
  w.close();
});

test('ghi vào .gal không đánh thức watcher', async () => {
  const root = tmp();
  mkdirSync(path.join(root, '.gal', 'thumbs'), { recursive: true });
  const w = createWatcher(root, { debounce: 30 });
  if (w === null) return;

  writeFileSync(path.join(root, '.gal', 'thumbs', 'x.jpg'), 'x');
  // Hết timeout mà rev vẫn 0 = watcher đã bỏ qua thư mục cache
  assert.equal(await w.wait(0, 300), 0);
  w.close();
});
