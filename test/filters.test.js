import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, folders, toHash, fromHash, describe, isFiltered } from '../web/filters.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();

const items = [
  { i: 1, p: 'a/one.jpg', name: 'one.jpg', v: false, s: 2e6, t: at(2024, 3, 10) },
  { i: 2, p: 'a/b/two.mp4', name: 'two.mp4', v: true, s: 50e6, t: at(2024, 3, 20) },
  { i: 3, p: 'a/b/three.jpg', name: 'three.jpg', v: false, s: 500e3, t: at(2025, 1, 5) },
  { i: 4, p: 'c/four.png', name: 'four.png', v: false, s: 9e6, t: at(2026, 8, 1) },
];

const ids = (v) => v.map((o) => o.i);

test('mặc định: mới nhất trước', () => {
  assert.deepEqual(ids(applyFilters(items)), [4, 3, 2, 1]);
});

test('lọc theo loại', () => {
  assert.deepEqual(ids(applyFilters(items, { type: 'video' })), [2]);
  assert.deepEqual(ids(applyFilters(items, { type: 'image' })), [4, 3, 1]);
});

test('thư mục gồm cả cây con', () => {
  assert.deepEqual(ids(applyFilters(items, { dir: 'a' })), [3, 2, 1]);
  assert.deepEqual(ids(applyFilters(items, { dir: 'a/b' })), [3, 2]);
});

test('khoảng ngày tính trọn ngày cuối', () => {
  const v = applyFilters(items, { from: '2024-03-20', to: '2024-03-20' });
  assert.deepEqual(ids(v), [2]);
});

test('lọc theo dung lượng', () => {
  assert.deepEqual(ids(applyFilters(items, { minMB: 5 })), [4, 2]);
  assert.deepEqual(ids(applyFilters(items, { maxMB: 1 })), [3]);
});

test('lọc theo tên, không phân biệt hoa thường', () => {
  assert.deepEqual(ids(applyFilters(items, { q: 'THREE' })), [3]);
});

test('bốn loại filter kết hợp cùng lúc', () => {
  const v = applyFilters(items, {
    type: 'image',
    dir: 'a',
    from: '2024-01-01',
    to: '2024-12-31',
    minMB: 1,
  });
  assert.deepEqual(ids(v), [1]);
});

test('sort theo tên và dung lượng, hai chiều', () => {
  assert.deepEqual(ids(applyFilters(items, { sort: 'name', asc: true })), [4, 1, 3, 2]);
  assert.deepEqual(ids(applyFilters(items, { sort: 'size', asc: true })), [3, 1, 4, 2]);
  assert.deepEqual(ids(applyFilters(items, { sort: 'size', asc: false })), [2, 4, 1, 3]);
});

test('không khớp gì thì trả mảng rỗng, không ném', () => {
  assert.deepEqual(applyFilters(items, { q: 'không-có-đâu' }), []);
});

test('cây thư mục đếm gộp cả nhánh con', () => {
  assert.deepEqual(folders(items), [
    { path: 'a', count: 3, depth: 0 },
    { path: 'a/b', count: 2, depth: 1 },
    { path: 'c', count: 1, depth: 0 },
  ]);
});

test('hash chỉ ghi trường khác mặc định, và đọc lại đúng', () => {
  assert.equal(toHash({}), '');
  const c = { type: 'video', dir: 'a/b', minMB: 5, asc: true, group: 'month' };
  const back = fromHash(toHash(c));
  assert.deepEqual(back, c);
});

test('hash lạ không làm hỏng tiêu chí', () => {
  assert.deepEqual(fromHash('#rm=-rf&type=video'), { type: 'video' });
});

test('mô tả bộ lọc cho empty state', () => {
  assert.equal(isFiltered({}), false);
  assert.equal(isFiltered({ sort: 'name' }), false); // sort không phải là lọc
  assert.equal(isFiltered({ type: 'video' }), true);
  assert.equal(describe({ type: 'video', dir: 'a' }), 'chỉ video, trong a');
});
