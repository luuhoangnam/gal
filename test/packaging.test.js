import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegMissingMessage, searchDirs } from '../src/ffmpeg.js';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gal.js');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

/** Chạy CLI và trả cả stdout/stderr/code, kể cả khi nó exit khác 0. */
async function gal(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--version in đúng phiên bản trong package.json', async () => {
  const { code, stdout } = await gal('--version');
  assert.equal(code, 0);
  assert.equal(stdout.trim(), pkg.version);
});

test('--help in usage kèm ví dụ, thoát 0', async () => {
  const { code, stdout } = await gal('--help');
  assert.equal(code, 0);
  assert.match(stdout, /Ví dụ:/);
  assert.match(stdout, /gal ~\/Pictures/);
  for (const flag of ['--port', '--lan', '--clear-cache', '--include-bundles']) {
    assert.ok(stdout.includes(flag), `usage thiếu ${flag}`);
  }
});

test('tuỳ chọn sai: một dòng lỗi, không stack trace', async () => {
  const { code, stderr } = await gal('--khong-co-that', '.');
  assert.equal(code, 1);
  assert.match(stderr, /^gal: /);
  assert.doesNotMatch(stderr, /at .*\.js:\d+/); // dấu hiệu stack trace lọt ra
});

test('cổng sai và thư mục không tồn tại đều thoát 1', async () => {
  assert.equal((await gal('.', '--port', 'abc')).code, 1);
  assert.equal((await gal(path.join(tmpdir(), 'không-tồn-tại-đâu-2026'))).code, 1);
});

test('--clear-cache xoá cache của đúng thư mục đó và in dung lượng', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gal-pack-'));
  const cache = path.join(dir, '.gal');
  await writeFile(path.join(dir, 'a.jpg'), 'x');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'index.db'), 'x'.repeat(4096));

  const { code, stdout } = await gal(dir, '--clear-cache');
  assert.equal(code, 0);
  assert.match(stdout, /giải phóng/);
  await assert.rejects(stat(cache), 'cache phải bị xoá');
  await stat(path.join(dir, 'a.jpg')); // ảnh thì không được đụng tới
});

test('thông điệp thiếu ffmpeg nêu cách cài và nơi đã tìm', () => {
  const msg = ffmpegMissingMessage();
  assert.match(msg, /ffmpeg/);
  assert.match(msg, /brew install ffmpeg|apt install ffmpeg|winget/);
  assert.match(msg, /Đã tìm trong \d+ thư mục/);
  assert.ok(searchDirs().length > 0);
});

/**
 * Rủi ro thật của việc phát hành: `files` thiếu một thư mục thì chạy từ repo vẫn
 * đúng, chỉ vỡ sau khi cài từ npm. Kiểm bằng cách đi theo mọi import tương đối.
 */
test('mọi import tương đối đều nằm trong `files` của package.json', async () => {
  const shipped = new Set(pkg.files);
  const missing = [];

  async function scanDir(rel) {
    for (const e of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) {
        await scanDir(child);
        continue;
      }
      if (!/\.(js|html|css)$/.test(e.name)) continue;
      const src = await readFile(path.join(ROOT, child), 'utf8');
      for (const m of src.matchAll(/from\s+'(\.[^']+)'|import\('(\.[^']+)'\)/g)) {
        const spec = m[1] ?? m[2];
        const target = path.normalize(path.join(path.dirname(child), spec));
        const top = target.split(path.sep)[0];
        if (!shipped.has(top)) missing.push(`${child} → ${spec}`);
        else await stat(path.join(ROOT, target));
      }
    }
  }

  await scanDir('src');
  await scanDir('bin');
  await scanDir('web');
  assert.deepEqual(missing, []);
});

test('gói không kèm test, plans hay docs', () => {
  for (const bad of ['test', 'plans', 'docs', 'node_modules']) {
    assert.ok(!pkg.files.includes(bad), `files không được chứa ${bad}`);
  }
  assert.equal(pkg.bin.gal, './bin/gal.js');
  assert.match(pkg.engines.node, />=\s*22/);
  assert.equal(pkg.license, 'MIT');
});

test('không có dependency native nào len vào', async () => {
  const deps = Object.keys(pkg.dependencies);
  assert.deepEqual(deps.sort(), ['exifreader', 'image-size', 'photoswipe']);
  for (const d of deps) {
    const meta = JSON.parse(await readFile(path.join(ROOT, 'node_modules', d, 'package.json'), 'utf8'));
    assert.ok(meta.gypfile !== true, `${d} cần biên dịch native`);
  }
});
