#!/usr/bin/env node
// Đo tiêu chí perf của lưới trên Chrome THẬT với thumbnail JPEG thật.
// Dùng: node scripts/bench-grid.js [số item] [thư mục fixture]
//
// Không đo bằng `performance.memory` — WebKit không có, và con số nó trả về
// không gồm cache ảnh đã giải mã. Dùng RSS tiến trình cho mọi engine.
import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server.js';

const run = promisify(execFile);
// stdout của Node vào file là block-buffered: bench chạy hàng phút, cần thấy ngay
const log = (s) => writeSync(1, `${s}\n`);
const N = Number(process.argv[2] ?? 5000);
const DIR = process.argv[3] ?? path.join(os.tmpdir(), `gal-bench-${N}`);
const CACHE = path.join(DIR, '.cache');

// Vài kích thước khác nhau để justified layout có việc thật để làm
const SIZES = [
  [1600, 1067],
  [1067, 1600],
  [1600, 1200],
  [1200, 1600],
  [1600, 1600],
  [1920, 1080],
];

async function fixture() {
  await fs.rm(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.mkdir(DIR, { recursive: true });

  const srcs = [];
  for (const [w, h] of SIZES) {
    const p = path.join(DIR, `src-${w}x${h}.jpg`);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `testsrc2=size=${w}x${h}:duration=1:rate=1`, '-frames:v', '1', '-y', p]);
    srcs.push(p);
  }

  // Hardlink, không copy: 70k × 200KB = 14GB đĩa cho một phép đo là vô lý.
  // Khoá thumbnail gồm đường dẫn nên mỗi link vẫn sinh thumbnail riêng.
  let made = 0;
  for (let d = 0; made < N; d++) {
    const sub = path.join(DIR, `d${String(d).padStart(4, '0')}`);
    await fs.mkdir(sub, { recursive: true });
    for (let k = 0; k < 200 && made < N; k++, made++) {
      await fs.link(srcs[made % srcs.length], path.join(sub, `img-${made}.jpg`));
    }
  }
  return made;
}

/**
 * RSS của cây tiến trình Chrome do bench khởi động, MB. Lọc theo pid gốc chứ
 * không theo tên: Chrome của chính người dùng đang chạy sẽ nuốt mất phép đo.
 */
async function rssTree(rootPid) {
  let stdout;
  try {
    ({ stdout } = await run('ps', ['-Ao', 'pid=,ppid=,rss=']));
  } catch {
    return -1; // phép đo phụ, không được làm hỏng cả lần chạy bench
  }
  const kids = new Map();
  const rss = new Map();
  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    rss.set(pid, kb);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  while (stack.length > 0) {
    const p = stack.pop();
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return Math.round(total / 1024);
}

const t0 = performance.now();
const n = await fixture();
log(`fixture: ${n} file trong ${DIR} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

const app = createServer(DIR, { cacheDir: CACHE });
const { url } = await app.listen();

// launchServer để lấy pid gốc — launch() không phơi tiến trình ra
const chrome = await chromium.launchServer({ channel: 'chrome' });
const browser = await chromium.connect(chrome.wsEndpoint());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const rss0 = await rssTree(chrome.process().pid);
await page.goto(url);

// Chờ pha A + B xong (thanh tiến trình tắt)
await page.waitForFunction(() => window.__gal?.grid.count > 0, null, { timeout: 120_000 });
await page.waitForFunction((want) => window.__gal.items.size >= want, n, { timeout: 600_000 });
await page.waitForFunction(
  () => [...window.__gal.items.values()].every((o) => o.ar > 0),
  null,
  { timeout: 600_000 },
);
log(`scan xong: ${await page.evaluate(() => window.__gal.grid.count)} mục`);

/** Cuộn `steps` bước, ghi frame time và số node DOM. */
async function scroll(steps, px) {
  return page.evaluate(
    ([steps, px]) =>
      new Promise((resolve) => {
        const sc = document.querySelector('#scroller');
        const frames = [];
        let maxNodes = 0;
        let i = 0;
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          maxNodes = Math.max(maxNodes, document.querySelectorAll('#sizer > *').length);
          if (i++ < steps) {
            sc.scrollTop += px;
            requestAnimationFrame(tick);
          } else {
            frames.sort((a, b) => a - b);
            resolve({
              p50: frames[frames.length >> 1],
              p95: frames[Math.floor(frames.length * 0.95)],
              maxNodes,
              scrolled: sc.scrollTop,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    [steps, px],
  );
}

const warm = await scroll(120, 900);
log(`cuộn đầu   p50 ${warm.p50.toFixed(1)}ms  p95 ${warm.p95.toFixed(1)}ms  node ${warm.maxNodes}`);

// Tiêu chí thật là 60fps SAU KHI đã cuộn qua nhiều nghìn ảnh, không phải lúc vừa mở
const deep = await scroll(1200, 900);
log(`cuộn sâu   p50 ${deep.p50.toFixed(1)}ms  p95 ${deep.p95.toFixed(1)}ms  node ${deep.maxNodes}`);
// Cuộn ngược qua đúng vùng vừa đi: thumbnail đã nằm trong cache trình duyệt.
// Chênh lệch giữa hai lần tách bạch chi phí JS của ta và chi phí decode ảnh.
const back = await scroll(1200, -900);
log(`cuộn ngược p50 ${back.p50.toFixed(1)}ms  p95 ${back.p95.toFixed(1)}ms  node ${back.maxNodes}`);

// Tốc độ của người thật (một cú vuốt mạnh ~ 300px/frame), không phải 900px/frame
await page.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
await page.waitForTimeout(500);
const human = await scroll(1200, 300);
log(`cuộn người p50 ${human.p50.toFixed(1)}ms  p95 ${human.p95.toFixed(1)}ms  node ${human.maxNodes}`);

log(`RSS Chrome ${rss0} → ${await rssTree(chrome.process().pid)} MB`);

// Về giữa thư viện trước khi đo: ở sát đáy, mode thấp hơn bị browser kẹp
// scrollTop — đó là kẹp biên, không phải trôi neo
await page.evaluate(() => {
  const sc = document.querySelector('#scroller');
  sc.scrollTop = sc.scrollHeight / 2;
});
await page.waitForTimeout(300);

// Đổi mode và mật độ: vị trí phải giữ trong sai số một hàng
for (const [label, fn, probe] of [
  ['square', () => window.__gal.grid.setMode('square'), 8],
  ['masonry', () => window.__gal.grid.setMode('masonry'), 8],
  ['justified', () => window.__gal.grid.setMode('justified'), 8],
  // Đổi mật độ neo vào TÂM viewport, nên phải đo bằng chính probe đó
  ['mật độ +', () => window.__gal.grid.setTarget(window.__gal.grid.target * 1.25), 450],
]) {
  const d = await page.evaluate(([f, probe]) => {
    const sc = document.querySelector('#scroller');
    const g = window.__gal.grid;
    // Cùng quy tắc mà grid dùng để chốt neo: đo ô khác thì đang đo reflow thật
    // của layout mới, không phải trôi
    const a = g.placed.findLast((p) => p.y < sc.scrollTop + probe) ?? g.placed[0];
    const before = { id: a.o.i, off: a.y - sc.scrollTop };
    new Function('return ' + f)()();
    const p = g.placed.find((p) => p.o.i === before.id);
    return Math.abs(p.y - sc.scrollTop - before.off);
  }, [fn.toString(), probe]);
  log(`đổi ${label}: ô neo lệch ${d.toFixed(1)}px`);
}

log(`node DOM cuối: ${await page.evaluate(() => window.__gal.grid.domNodes)}`);

await browser.close();
app.server.close();
await fs.rm(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
