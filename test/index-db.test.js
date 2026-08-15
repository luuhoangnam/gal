import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openIndex } from '../src/index-db.js';

async function fresh() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-db-')));
  return { root: dir, cacheDir: path.join(dir, 'cache') };
}

const mk = (p, m = 1000) => ({ p, s: 1, m, v: 0 });

test('id là rowid gắn với rel, không phải thứ tự phát hiện', async () => {
  const { cacheDir } = await fresh();
  let db = openIndex(cacheDir);
  let gen = db.beginScan();
  const first = db.upsertBatch([mk('b.jpg'), mk('c.jpg')], gen);
  const idOfC = first.find((r) => r.p === 'c.jpg').i;
  db.writeMeta(first.map((r) => ({ ...r, w: 1, h: 1, orient: null, taken: 5, ds: 1, dur: null })));
  db.endScan(gen);
  db.close();

  // Thêm file xếp TRƯỚC c.jpg theo thứ tự duyệt: thứ tự phát hiện sẽ dịch, rowid thì không
  db = openIndex(cacheDir);
  gen = db.beginScan();
  const second = db.upsertBatch([mk('a.jpg'), mk('b.jpg'), mk('c.jpg')], gen);
  assert.equal(second.find((r) => r.p === 'c.jpg').i, idOfC);
  db.endScan(gen);
  db.close();
});

test('mtime không đổi → không chạy lại pha B; đổi → chạy lại', async () => {
  const { cacheDir } = await fresh();
  let db = openIndex(cacheDir);
  let gen = db.beginScan();
  const rows = db.upsertBatch([mk('a.jpg', 111)], gen);
  assert.equal(db.pending(gen).length, 1, 'lần đầu phải cần pha B');
  db.writeMeta(rows.map((r) => ({ ...r, w: 4, h: 3, orient: null, taken: 9, ds: 0, dur: null })));
  db.endScan(gen);
  db.close();

  db = openIndex(cacheDir);
  gen = db.beginScan();
  db.upsertBatch([mk('a.jpg', 111)], gen);
  assert.equal(db.pending(gen).length, 0, 'mtime khớp → bỏ qua pha B');
  db.endScan(gen);
  db.close();

  db = openIndex(cacheDir);
  gen = db.beginScan();
  db.upsertBatch([mk('a.jpg', 222)], gen);
  assert.equal(db.pending(gen).length, 1, 'mtime đổi → phải đọc lại');
  db.endScan(gen);
  db.close();
});

test('file bị xoá biến khỏi cache, id file khác không dịch', async () => {
  const { cacheDir } = await fresh();
  let db = openIndex(cacheDir);
  let gen = db.beginScan();
  const rows = db.upsertBatch([mk('a.jpg'), mk('b.jpg')], gen);
  const idB = rows.find((r) => r.p === 'b.jpg').i;
  db.writeMeta(rows.map((r) => ({ ...r, w: 1, h: 1, orient: null, taken: 1, ds: 1, dur: null })));
  db.endScan(gen);
  db.close();

  db = openIndex(cacheDir);
  gen = db.beginScan();
  db.upsertBatch([mk('b.jpg')], gen); // a.jpg đã bị xoá khỏi đĩa
  db.endScan(gen);
  const cached = db.cached();
  assert.deepEqual(cached.map((r) => r.p), ['b.jpg']);
  assert.equal(cached[0].id, idB);
  db.close();
});

test('cache nạp lại được sau khi đóng', async () => {
  const { cacheDir } = await fresh();
  let db = openIndex(cacheDir);
  const gen = db.beginScan();
  const rows = db.upsertBatch([mk('a.jpg')], gen);
  db.writeMeta(rows.map((r) => ({ ...r, w: 4032, h: 3024, orient: 6, taken: 777, ds: 0, dur: null })));
  db.endScan(gen);
  db.close();

  db = openIndex(cacheDir);
  assert.equal(db.cachedCount(), 1);
  const [row] = db.cached();
  assert.equal(row.w, 4032);
  assert.equal(row.orient, 6);
  assert.equal(row.taken, 777);
  assert.equal(row.ds, 0);
  db.close();
});

test('tiến trình thứ hai cùng root vào chế độ chỉ đọc, không crash', async () => {
  const { cacheDir } = await fresh();
  const first = openIndex(cacheDir);
  assert.equal(first.writable, true);

  const second = openIndex(cacheDir);
  assert.equal(second.writable, false, 'tiến trình thứ hai phải là chỉ đọc');
  assert.doesNotThrow(() => second.cached());
  second.close();

  first.close();
  // Lock đã nhả → lần mở sau lại ghi được
  const third = openIndex(cacheDir);
  assert.equal(third.writable, true);
  third.close();
});
