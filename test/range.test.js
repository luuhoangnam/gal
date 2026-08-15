import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, UNSATISFIABLE } from '../src/range.js';

const SIZE = 1000;

test('không có header → null', () => {
  assert.equal(parseRange(undefined, SIZE), null);
  assert.equal(parseRange('', SIZE), null);
});

test('cú pháp lạ → bỏ qua, phục vụ 200', () => {
  assert.equal(parseRange('items=0-10', SIZE), null);
  assert.equal(parseRange('bytes=0-10,20-30', SIZE), null); // multi-range không hỗ trợ
  assert.equal(parseRange('bytes=abc', SIZE), null);
  assert.equal(parseRange('bytes=-', SIZE), null);
});

test('range đóng', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 });
});

test('range mở đầu cuối', () => {
  assert.deepEqual(parseRange('bytes=100-', SIZE), { start: 100, end: 999 });
});

test('suffix range', () => {
  assert.deepEqual(parseRange('bytes=-500', SIZE), { start: 500, end: 999 });
});

test('suffix lớn hơn file → cả file', () => {
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 });
});

test('end vượt size bị kẹp', () => {
  assert.deepEqual(parseRange('bytes=990-5000', SIZE), { start: 990, end: 999 });
});

test('start ngoài file → 416', () => {
  assert.equal(parseRange('bytes=1000-', SIZE), UNSATISFIABLE);
  assert.equal(parseRange('bytes=5000-6000', SIZE), UNSATISFIABLE);
});

test('bytes=-0 → 416', () => {
  assert.equal(parseRange('bytes=-0', SIZE), UNSATISFIABLE);
});

test('file rỗng → mọi range 416', () => {
  assert.equal(parseRange('bytes=0-', 0), UNSATISFIABLE);
});
