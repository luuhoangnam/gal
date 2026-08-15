import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageMeta } from '../src/exif-image.js';
import { videoMeta, hasFfprobe, rotationOf } from '../src/video-meta.js';

const run = promisify(execFile);
let dir;
let ffmpeg = false;

before(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-meta-')));
  ffmpeg = await hasFfprobe();
});

/** JPEG thật (từ ffmpeg) + APP1 EXIF tự dựng: orientation 6 + DateTimeOriginal. */
async function jpegWithExif(file, { orientation = 6, date = '2020:01:02 03:04:05' } = {}) {
  await run('ffmpeg', [
    '-y', '-loglevel', 'quiet',
    '-f', 'lavfi', '-i', 'color=c=red:s=64x32:d=1', '-frames:v', '1', file,
  ]);
  const jpeg = await readFile(file);

  const tiff = Buffer.alloc(76);
  tiff.write('II', 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset IFD0
  tiff.writeUInt16LE(2, 8); // 2 entry
  // Orientation (0x0112), SHORT, 1
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  // ExifIFDPointer (0x8769), LONG, 1 → offset 38
  tiff.writeUInt16LE(0x8769, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(38, 30);
  tiff.writeUInt32LE(0, 34); // không có IFD1
  // Exif IFD: DateTimeOriginal (0x9003), ASCII, 20 byte, dữ liệu ở offset 56
  tiff.writeUInt16LE(1, 38);
  tiff.writeUInt16LE(0x9003, 40);
  tiff.writeUInt16LE(2, 42);
  tiff.writeUInt32LE(20, 44);
  tiff.writeUInt32LE(56, 48); // entry = tag(2)+type(2)+count(4)+value(4) = 12 byte
  tiff.writeUInt32LE(0, 52);
  tiff.write(date + '\0', 56, 'ascii');

  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(2 + 6 + tiff.length);
      return b;
    })(),
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
  ]);

  const out = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
  await writeFile(file, out);
  return file;
}

test('JPEG có EXIF: đọc được ngày chụp, orientation 6 đảo w/h', async (t) => {
  if (!ffmpeg) return t.skip('không có ffmpeg');
  const f = await jpegWithExif(path.join(dir, 'exif.jpg'));
  const m = await imageMeta(f);

  assert.equal(m.orient, 6);
  // Ảnh gốc 64x32; orientation 6 = xoay 90° nên tỉ lệ hiển thị phải là 32x64
  assert.equal(m.w, 32);
  assert.equal(m.h, 64);
  const d = new Date(m.taken);
  assert.equal(d.getFullYear(), 2020);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 2);
  assert.equal(d.getHours(), 3);
});

test('ảnh không EXIF vẫn lấy được kích thước', async (t) => {
  if (!ffmpeg) return t.skip('không có ffmpeg');
  const f = path.join(dir, 'plain.jpg');
  await run('ffmpeg', [
    '-y', '-loglevel', 'quiet',
    '-f', 'lavfi', '-i', 'color=c=blue:s=48x24:d=1', '-frames:v', '1', f,
  ]);
  const m = await imageMeta(f);
  assert.equal(m.w, 48);
  assert.equal(m.h, 24);
  assert.equal(m.taken, null, 'không có EXIF → để null, tầng trên mới rơi về mtime');
});

test('ảnh 0 byte và ảnh hỏng: trả rỗng, không ném', async () => {
  const empty = path.join(dir, 'empty.jpg');
  const broken = path.join(dir, 'broken.jpg');
  await writeFile(empty, '');
  await writeFile(broken, 'không phải ảnh, chỉ là chữ');

  for (const f of [empty, broken, path.join(dir, 'khong-ton-tai.jpg')]) {
    const m = await imageMeta(f);
    assert.deepEqual(m, { w: null, h: null, orient: null, taken: null });
  }
});

test('video: width/height/duration/creation_time', async (t) => {
  if (!ffmpeg) return t.skip('không có ffmpeg');
  const f = path.join(dir, 'v.mp4');
  await run('ffmpeg', [
    '-y', '-loglevel', 'quiet',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f,
  ]);
  const m = await videoMeta(f);
  assert.equal(m.w, 320);
  assert.equal(m.h, 240);
  assert.ok(m.dur > 0.5 && m.dur < 2, `duration lạ: ${m.dur}`);
});

// ffmpeg không dựng được file có side_data rotation (mọi cách đều xoay khung
// hình thật thay vì ghi metadata), nên kiểm trực tiếp hàm chuẩn hoá góc trên
// đúng những hình dạng đã đo được ở thư viện iPhone thật.
test('rotation: -90 và 270 là cùng một góc, 0/180 không đảo', () => {
  assert.equal(rotationOf({ side_data_list: [{ rotation: -90 }] }), 270);
  assert.equal(rotationOf({ side_data_list: [{ rotation: 90 }] }), 90);
  assert.equal(rotationOf({ side_data_list: [{ rotation: 180 }] }), 180);
  assert.equal(rotationOf({}), 0);
  assert.equal(rotationOf({ tags: { rotate: '90' } }), 90, 'tag rotate kiểu cũ');
  assert.equal(rotationOf({ side_data_list: [{ rotation: 'xxx' }] }), 0, 'giá trị rác → 0');
});

test('.mp4 thực chất là text: ffprobe fail sạch, không ném', async () => {
  const f = path.join(dir, 'fake.mp4');
  await writeFile(f, 'đây không phải video');
  const m = await videoMeta(f);
  assert.deepEqual(m, { w: null, h: null, orient: null, taken: null, dur: null });
});
