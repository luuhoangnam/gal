import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

const css = (await readFile(new URL('../web/styles.css', import.meta.url), 'utf8')).replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

// ---------- kiểm tra tĩnh: hai luật của design guidelines, chứng minh bằng grep ----------

test('mọi `outline: none` đều có thay thế nhìn thấy được', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /outline:\s*none/.test(body))
    .map(([, sel]) => sel.trim());
  // Chỗ duy nhất được phép: ô lưới, vì `contain: strict` cắt mất outline vẽ ngoài
  assert.deepEqual(rules, ['.tile:focus-visible']);
  assert.match(css, /\.tile:focus-visible::after\s*\{[^}]*inset 0 0 0 3px var\(--accent\)/);
});

test('không animate thuộc tính hình học', () => {
  const bad = [...css.matchAll(/transition:[^;]*;/g)]
    .map((m) => m[0])
    .filter((s) => /\b(width|height|top|left|right|bottom|margin|padding)\b/.test(s));
  assert.deepEqual(bad, []);
});

test('không có dấu hiệu AI-slop mà design guidelines cấm', () => {
  assert.doesNotMatch(css, /scale\(1\.0[3-9]\)/); // hover phóng to làm vỡ lưới justified
  assert.doesNotMatch(css, /linear-gradient\([^)]*#[0-9a-f]*(8b5cf6|a855f7|6366f1)/i);
});

/** Tỉ lệ tương phản WCAG giữa hai màu hex. */
function contrast(a, b) {
  const lum = (hex) => {
    const v = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('tương phản chữ đạt WCAG AA, nền lightbox đạt yêu cầu 18:1', () => {
  const vars = Object.fromEntries(
    [...css.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]),
  );
  const canvas = vars['--bg-canvas'];
  assert.ok(contrast(vars['--fg-primary'], canvas) >= 4.5);
  assert.ok(contrast(vars['--fg-secondary'], canvas) >= 4.5);
  assert.ok(contrast(vars['--fg-tertiary'], canvas) >= 4.5);
  assert.ok(contrast(vars['--accent'], canvas) >= 4.5);
  assert.ok(contrast('#ffffff', vars['--bg-immersive']) >= 18);
});

// ---------- kiểm tra trong Chrome thật ----------

let base, url, srv, browser;

before(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'gal-a11y-')));
  // Một file "ảnh" hỏng là đủ: mọi kiểm tra lưới chạy trên item tổng hợp bơm
  // thẳng vào client, không cần 4000 file thật trên đĩa.
  await writeFile(path.join(base, 'hỏng.jpg'), 'không phải JPEG');
  const s = createServer(base, { cacheDir: path.join(base, '.cache') });
  srv = s.server;
  ({ url } = await s.listen());

  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    browser = null; // không có Chrome → phần này bỏ qua, phần tĩnh vẫn chạy
  }
});

after(async () => {
  await browser?.close();
  srv.close();
});

/** Mở app với N item tổng hợp để kiểm tra lưới ảo hoá ở quy mô thật. */
async function openApp(n = 4000) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__gal !== undefined, null, { timeout: 20000 });
  await page.evaluate((count) => {
    const { items, setCriteria } = window.__gal;
    const k = [...items.values()][0]?.k;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      items.set(9000 + i, {
        i: 9000 + i, p: `d/I${i}.jpg`, name: `I${i}.jpg`, v: false, k,
        s: 1e6, ar: 1.4, w: 1400, h: 1000, t: now - i * 36e5, ds: 1, dur: null,
      });
    }
    setCriteria({});
  }, n);
  await page.waitForTimeout(600);
  return { page, errors };
}

test('lưới là MỘT điểm dừng Tab, không phải hàng nghìn', async (t) => {
  if (!browser) return t.skip('không có Chrome');
  const { page } = await openApp();
  const zero = await page.$$eval('.tile[tabindex="0"]', (els) => els.length);
  const all = await page.$$eval('.tile', (els) => els.length);
  assert.equal(zero, 1);
  assert.ok(all > 10, 'phải có nhiều ô trong DOM');
  await page.close();
});

test('ô đang focus không bị ảo hoá mất khi cuộn xa', async (t) => {
  if (!browser) return t.skip('không có Chrome');
  const { page } = await openApp();
  await page.evaluate(() => window.__gal.grid.focusIndex(2));
  const id = await page.evaluate(() => document.activeElement?.dataset?.id);
  assert.ok(id, 'phải focus được vào ô');

  await page.evaluate(() => window.__gal.grid.scrollTo(60000));
  await page.waitForTimeout(300);
  const still = await page.evaluate(() => document.activeElement?.dataset?.id);
  assert.equal(still, id, 'focus phải ở nguyên ô cũ, không rơi về body');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), false);
  await page.close();
});

test('ô báo đúng vị trí trong tập cho screen reader', async (t) => {
  if (!browser) return t.skip('không có Chrome');
  const { page } = await openApp();
  // Ô đầu tiên theo THỨ TỰ HIỂN THỊ, không phải theo thứ tự trong DOM: pool tái
  // dùng element nên hai thứ tự đó khác nhau.
  const first = await page.$eval('.tile[aria-posinset="1"]', (el) => ({
    pos: el.getAttribute('aria-posinset'),
    size: el.getAttribute('aria-setsize'),
    alt: el.querySelector('img').alt,
    role: el.getAttribute('role'),
  }));
  assert.equal(first.role, 'listitem');
  assert.equal(first.pos, '1');
  assert.ok(Number(first.size) > 1000);
  assert.match(first.alt, /\.jpg, \d+ tháng \d+, \d{4}$/); // tên + ngày
  await page.close();
});

test('lightbox: Esc trả focus về đúng thumbnail', async (t) => {
  if (!browser) return t.skip('không có Chrome');
  const { page } = await openApp(200);
  await page.evaluate(() => window.__gal.grid.focusIndex(3));
  const id = await page.evaluate(() => document.activeElement?.dataset?.id);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pswp', { timeout: 10000 });
  await page.waitForTimeout(900); // để animation mở chạy xong rồi mới đóng
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.id), id);
  await page.close();
});

test('zoom 200% không sinh cuộn ngang', async (t) => {
  if (!browser) return t.skip('không có Chrome');
  const { page } = await openApp(300);
  await page.evaluate(() => (document.body.style.zoom = '2'));
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  assert.ok(over.doc <= over.win + 1, `cuộn ngang: ${over.doc} > ${over.win}`);
  await page.close();
});

test('tiến trình quét không đọc dồn dập: live region throttle 5s', async (t) => {
  if (!browser) return t.skip('không có Chrome');
  const page = await browser.newPage();
  const seen = new Set();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gal !== undefined, null, { timeout: 20000 });
  for (let i = 0; i < 12; i++) {
    seen.add(await page.$eval('#live', (el) => el.textContent));
    await page.waitForTimeout(100);
  }
  // Trong ~1,2s chỉ được có một thông báo (thêm chuỗi rỗng lúc đầu)
  assert.ok(seen.size <= 2, `live region đổi ${seen.size} lần trong 1,2s`);
  assert.equal(await page.$eval('#live', (el) => el.getAttribute('aria-live')), 'polite');
  await page.close();
});
