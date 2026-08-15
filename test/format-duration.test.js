import test from 'node:test';
import assert from 'node:assert/strict';

// grid.js chạm matchMedia ngay lúc import; stub để test được hàm thuần bên trong
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const { fmtDur } = await import('../web/grid.js');

test('thời lượng ≥ 1 giờ hiện đủ giờ:phút:giây', () => {
  assert.equal(fmtDur(7431), '2:03:51'); // trước đây ra 123:51
  assert.equal(fmtDur(3600), '1:00:00');
  assert.equal(fmtDur(36000), '10:00:00');
});

test('dưới 1 giờ giữ dạng phút:giây', () => {
  assert.equal(fmtDur(0), '0:00');
  assert.equal(fmtDur(9), '0:09');
  assert.equal(fmtDur(3599), '59:59');
});

test('làm tròn không sinh 60 giây', () => {
  assert.equal(fmtDur(59.7), '1:00');
  assert.equal(fmtDur(3599.7), '1:00:00');
});
