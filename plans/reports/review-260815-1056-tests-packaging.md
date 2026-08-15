# Review: test suite, packaging, README accuracy — gal v0.1.0

Date: 2026-08-15 · Branch main · Reviewer: code-reviewer · Read-only, no files modified

## 1. Actual `npm test` output

Command: `npm test` (= `node --test`), Node v26.7.0, macOS.

```
ℹ tests 119
ℹ suites 0
ℹ pass 119
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8898.843
```

Wall time: `npm test  5.86s user 2.21s system 89% cpu 9.048 total`.

**119 pass, 0 fail, 0 skipped, ~8.9 s.** The modified/untracked working tree (`src/media-types.js`,
`web/{app.js,index.html,keyboard.js,styles.css}`, untracked `web/feed.js`) does **not** break any
test — because no test covers any of those changes (see C-1, I-7).

`skipped 0` is environment-specific: Chrome and ffmpeg are present on this machine. On a box
without them, 17 tests disappear and the run still reports success (see I-4).

---

## Critical

### C-1. `web/feed.js` is untracked — the documented install produces a broken app
`web/app.js:59` dynamically imports `./feed.js`, and `web/app.js:44` routes every mobile tile open
to it. `git status` shows `?? web/feed.js`: the file is not committed. README's only install path is
`git clone … && npm install && npm link` (README.md:44-47), so a fresh clone at this commit has no
`feed.js` → the dynamic import 404s.

`openFeed` has no error handling:

```js
// web/app.js:57-63
async function openFeed(index) {
  if (feed === null) {
    const { createFeed } = await import('./feed.js');
```

A failed module fetch rejects, nothing catches it, the tap silently does nothing and an unhandled
rejection lands in the console. Same shape in `openLightbox` (web/app.js:46-51).

Note `npm pack` *does* include `feed.js` (it packs the working tree, not git), so the tarball and the
git install disagree — the worst possible split for a first release.

Action: commit `web/feed.js` (and the other four modified files) before tagging; add a `.catch()`
around both dynamic imports that surfaces a visible failure.

### C-2. `engines: >=22` and the bin guard are both wrong for `node:sqlite`
`src/index-db.js:1` does `import { DatabaseSync } from 'node:sqlite'`. Per the Node docs, `node:sqlite`
was added in **v22.5.0** and only stopped requiring `--experimental-sqlite` in **v22.13.0 / v23.4.0**.

- `package.json:10` declares `"node": ">=22"`.
- `bin/gal.js:6-13` gates on `major < 22`.
- README.md:40 says "Requires Node ≥ 22 (uses the built-in `node:sqlite`)".

On Node 22.0–22.12 all three checks pass and the import then dies with
`ERR_UNKNOWN_BUILTIN_MODULE` — the exact failure the comment at `bin/gal.js:3-5` says it exists to
prevent. Node 22.11 is a real LTS line people are on.

Action: bump `engines` to `>=22.13.0` and change the bin guard to compare against 22.13 (semver
compare, not `major`), and correct README.md:40.

---

## Important

### I-3. README "Read-only" claim is false
README.md:36: "**Read-only** — `gal` never writes to, moves, or renames anything in the folder you
point it at."

`src/cache-dir.js:16-23` does exactly that by default:

```js
const local = path.join(root, '.gal');
mkdirSync(local, { recursive: true });
const probe = path.join(local, `.w-${process.pid}`);
writeFileSync(probe, '');
```

README.md:104-107 then correctly describes `<root>/.gal`. The feature bullet contradicts the "How it
works" section. For a tool whose pitch is "points a browser at your photos", this is the claim users
will hold you to. Reword to "never modifies your media — the only thing it writes is its own `.gal`
cache directory".

### I-4. Green suite with entire layers silently absent
- `test/a11y.test.js:74-79`: `try { chromium.launch(...) } catch { browser = null }`. A bare `catch`
  swallows *everything* — no Chrome, a broken playwright install, a launch crash — and the 6 browser
  tests then `t.skip`. Every DOM/virtualization/lightbox-focus assertion vanishes without a failure.
- `test/thumbs.test.js` (6 tests) and `test/metadata.test.js` (4 tests) skip without ffmpeg.

On a clean CI runner `npm test` prints "pass" having exercised none of thumbnails, EXIF, video
metadata, virtualization, or a11y. There is no `.github/` workflow to pin the environment, and
README.md:129 relies on contributors running `npm test` locally.

Action: gate on an env var (e.g. `GAL_REQUIRE_FULL=1` in CI) that turns a missing dependency into a
failure instead of a skip; narrow the `catch` to launch errors only.

### I-5. ffmpeg availability is probed with one binary and exercised with another
- `test/thumbs.test.js:18` sets `hasFfmpeg = ffmpegPath() !== null`, then `test/thumbs.test.js:74`
  runs `ffprobe`.
- `test/metadata.test.js:17` sets `ffmpeg = await hasFfprobe()`, then `test/metadata.test.js:22`
  and `:88`/`:113` run `ffmpeg`.
- `src/ffmpeg.js:34` deliberately searches `/opt/homebrew/bin` and `/usr/local/bin` **beyond** `PATH`,
  while the tests call bare `ffmpeg`/`ffprobe` through `execFile` (PATH only).

So the guard can be true while `execFile` throws `ENOENT` → hard test failure instead of a clean
skip, precisely on the macOS-GUI-PATH case `src/ffmpeg.js:28-32` was written for. Probe both
binaries, and invoke them via `ffmpegPath()`/the resolved dirname rather than a bare name.

### I-6. Scan failures are swallowed with no signal anywhere
```js
// src/scan.js:77-81
promise.catch(() => {
  done = true;
  for (const w of waiters) w();
  waiters.clear();
});
```
Any throw in `walk`, `db.upsertBatch`, or `metaBatches` ends the NDJSON stream mid-flight: no
`done_b`, no error line, nothing on stderr. The client sees a truncated stream and (per the phase
state machine in `web/app.js`) sits in "scanning" forever. No test covers a failing scan; nothing in
`test/` imports `src/scan.js` at all. At minimum log the error and emit a `{t:'error'}` line.

### I-7. Uncommitted behavior change with zero coverage: `.mov` → `video/mp4`
`src/media-types.js:18-23` changes the `.mov` MIME from `video/quicktime` to `video/mp4`. No test
file imports `src/media-types.js`; the only MIME assertion in the suite is
`test/host-guard.test.js:49` (`image/jpeg`). The extension allowlist is a trust boundary
(`src/server.js:239`, `src/media-types.js:1-3`) — it deserves its own test file covering
`mediaType()`, `classify()`, `needsTranscode()`, case-insensitivity, and unknown extensions.

### I-8. npm metadata missing → README breaks on npmjs.com
`package.json` has no `repository`, `homepage`, or `bugs` fields. `files` (package.json:15-21)
correctly excludes `docs/`, but README.md:19-20 embeds `docs/screenshots/*.png` and README.md:123
links `plans/`. Without a `repository` field npm cannot rewrite relative links, so the published
README shows broken images and a dead link. Add `repository`/`homepage`/`bugs`, and either host the
screenshots absolutely or accept that npm rewrites them from the repo URL.

### I-9. Watcher tests pass vacuously on unsupported platforms
`test/watcher.test.js:13`, `:24`, `:35` all use `if (w === null) return;` — a bare return, not
`t.skip()`. On a platform without recursive `fs.watch` all three report a green checkmark having
asserted nothing. Use `t.skip('watch đệ quy không hỗ trợ')` so the report is honest.

### I-10. Two tests fail when the suite runs as root
- `test/walk.test.js:99`: `chmod(locked, 0o000)` then asserts `stats.skippedDirs === 1`.
- `test/cache-dir.test.js:17`: `chmod(root, 0o555)` then asserts the `/tmp` fallback.

Root ignores mode bits, so both assertions invert inside the typical `node:22` Docker CI image.
Either skip when `process.getuid?.() === 0` or document that CI must not run as root.

---

## Minor

- **M-11 — LRU test does not test LRU.** `test/thumbs.test.js:146` ("dọn LRU theo atime") asserts only
  `removed > 0`, `bytes <= threshold`, and "not everything deleted" (:164-169). It never checks
  *which* files were evicted, so it passes under arbitrary or reverse eviction order. Touch the atimes
  and assert the surviving set.
- **M-12 — Time-dependent assertions.** `test/a11y.test.js` uses fixed `waitForTimeout(600/900/1000/
  300/400)`; `:180-193` asserts `seen.size <= 2` over a ~1.2 s sampling loop; `test/watcher.test.js:39`
  proves a negative with a 300 ms timeout. All are load-sensitive on shared CI.
- **M-13 — Packaging import-graph test has blind spots.** `test/packaging.test.js:93` matches only
  `from '...'` and `import('...')` with relative specifiers. CSS `url()`, `<link href>`, `<script src>`
  (web/index.html:191), and bare specifiers are invisible to it — `web/assets/broken.svg` ships by
  luck, not by test. Also `test/packaging.test.js:109-116` asserts on the `files` array, not on what
  `npm pack` actually emits.
- **M-14 — Dev scaffolding ships to users.** `web/app.js:507-530` keeps a `?state=` demo hook with
  hardcoded `/Users/ai-do/Pictures` and `/Users/ai-do/Pictures/Ảnh riêng` strings; `web/app.js:536`
  exposes `window.__gal`. Both are in the tarball. Not a security issue (client-only, same-origin
  guarded), but it is a fake-data path in a shipped artifact and a personal-looking path in the diff.
- **M-15 — Top-level resolve can crash before any output.** `src/server.js:23` calls
  `import.meta.resolve('photoswipe')` in a module-scope `const`. Under a broken/strict install the CLI
  dies with a raw stack, bypassing the friendly-error work in `src/cli.js`.
- **M-16 — Perf claims are not verified by the suite.** README.md:29-30 promises "first photo in under
  a second" and "70,000 items, 60fps, DOM under 2,000 nodes". No test asserts a DOM node ceiling —
  `test/a11y.test.js:116` only asserts `> 10` tiles. `scripts/bench-grid.js` and
  `scripts/bench-metadata.js` measure these but are not part of `npm test` and need a real library +
  Chrome. Either soften the claims or add a node-count assertion to the a11y run (cheap: it already
  loads 4000 synthetic items).
- **M-17 — Unbounded scan log.** `src/scan.js:16,21` retains every phase-A and phase-B message for the
  life of the run so late clients can replay. For 70k items that is the whole index resident in RAM
  twice. Documented as a deliberate tradeoff (`src/scan.js:4-10`) but untested and unbounded.
- **M-18 — Native-dep test is weaker than the badge it defends.**
  `test/packaging.test.js:118-124` checks `gypfile !== true` on the three direct deps only. It misses
  transitive deps and install scripts — `exifreader` has `"hasInstallScript": true`
  (package-lock.json:40). The "zero native dependencies" claim (README.md:35) does hold today
  (exifreader/image-size/photoswipe and the optional `@xmldom/xmldom` are all pure JS), but the test
  would not catch a regression through a transitive dependency.
- **M-19 — Undocumented short flags.** `src/cli.js:31` accepts `-v` and `-h`; neither README nor the
  usage block (`src/cli.js:12-27`) mentions them. Every flag README documents (`--host`, `--port`,
  `--lan`, `--watch`, `--include-bundles`, `--follow-symlinks`, `--clear-cache`, `--version`,
  `--help`) exists and behaves as described — verified against `src/cli.js:29-33,61-107`.
- **M-20 — No CI, no lint, no typecheck.** `scripts` contains only `test`. README.md:129 asks
  contributors to run `npm test` manually; nothing enforces it.

---

## Answers to the specific questions

**1. Happy-path only?** No — this is better than average. The pure-function and trust-boundary layers
are genuinely adversarial: `test/safe-path.test.js` covers `..`, absolute paths, the `root-evil`
`startsWith` trap (:38), symlink escape (:44), APFS case-insensitivity (:50), and non-existent files
(:59). `test/range.test.js` covers suffix ranges, `bytes=-0`, empty files, and clamping.
`test/host-guard.test.js` covers DNS rebinding, `Origin`, `Sec-Fetch-Site: same-site`, encoded
traversal, and `.html` in the media root. `test/walk.test.js` covers symlink loops, unreadable dirs,
and emoji/Vietnamese filenames.

The gaps are in **orchestration and client code**, not in the primitives. Zero direct coverage for:

| Module | Status |
|---|---|
| `src/scan.js` | no test imports it; only indirectly via `test/host-guard.test.js:177` |
| `src/metadata.js` | no test imports it (only `scripts/bench-metadata.js:7`) |
| `src/media-types.js` | no test imports it — and it was just changed (I-7) |
| `web/feed.js` | 0 tests, 8.9 kB, new, untracked, mobile-only (C-1) |
| `web/keyboard.js` | signature changed `lightbox` → `overlay`; no direct test |
| `web/scrubber.js` | 0 tests |
| `web/app.js` | 0 direct tests (exercised only via the a11y browser run) |
| `/api/watch` long-poll route | `src/watcher.js` unit-tested; the route (`src/server.js:196-206`) is not |
| read-only second-process mode end-to-end | `test/index-db.test.js:98` covers the DB layer only |
| thumbnail write failure (ENOSPC/EACCES) | not covered |

Vacuous/overclaiming tests: I-9 (watcher), M-11 (LRU). Absence-only assertions that would pass on an
empty file: `test/a11y.test.js:31-34`. Flaky/time-dependent: M-12. FS/permission-dependent: I-10.

**2. ffmpeg/network skips.** ffmpeg tests use `t.skip()` and skip cleanly *if* the probe is right —
but the probe checks a different binary than the tests invoke (I-5), so a PATH/Homebrew mismatch
gives a hard failure. No test requires the network: `chromium.launch({ channel: 'chrome' })`
(test/a11y.test.js:76) uses the system Chrome, no download.

**3. Packaging.** Import trace from `bin/gal.js` → `src/cli.js` → `server.js` → `{index-db, cache-dir,
scan, thumbs, watcher, safe-path, range, media-types}` → `{walk, metadata, exif-image, video-meta,
ffmpeg}` — all under `src/`, all in `files`. `web/` is served by `src/server.js:17` and is in `files`.
No devDependency is imported by runtime code (`playwright-core` appears only in `test/a11y.test.js:75`
and `scripts/bench-grid.js:13`). `npm pack --dry-run` emits **30 files, 54.2 kB**, including
`web/assets/broken.svg`, with no test/plans/docs/dotfiles. PhotoSwipe is **not** vendored into `web/`
— it is a real runtime dependency served from `node_modules` via
`import.meta.resolve('photoswipe')` → `node_modules/photoswipe/dist/` and mounted at `/vendor/photoswipe/`
(`src/server.js:20-24`), consumed by `web/lightbox.js:1` and `web/index.html:8`. That works from an
npm install and is covered by `test/lightbox-assets.test.js:22-38`. **`npm pack` would produce a
working install today** — the failure mode is the git-clone path (C-1) and the Node-version floor
(C-2), not the tarball.

**4. README.** Verified: `--version`/`--help`/`--port`/`--lan`/`--watch`/`--follow-symlinks`/
`--include-bundles`/`--clear-cache`/`--host` all exist and behave as documented; ffmpeg is required at
startup (`src/cli.js:94-97`); the `/tmp/gal/<flattened>` fallback matches `src/cache-dir.js:25`;
"zero native dependencies" holds. Wrong: "read-only, never writes" (I-3) and "Node ≥ 22" (C-2).
Undocumented: `-v`/`-h` (M-19). Unverified by tests: the perf numbers (M-16).

**5. Secrets / stray files.** No secrets, tokens, dotenv files, or keys anywhere in the shipped set.
The only personal-looking strings are the demo constants in `web/app.js:521,524`
(`/Users/ai-do/Pictures`) and the doc comment in `src/cache-dir.js:4`. The tarball is clean — no
`.DS_Store`, `.idea/`, `plans/`, `docs/`, or `node_modules`.

## Verdict

**Nothing critical in the trust-boundary code** — path resolution, host guard, range handling, and
the extension allowlist are the best-tested part of this repo and I found no defect in them.

The two blockers are release-mechanics, not logic: an uncommitted module the app dynamically imports
(C-1), and a Node version floor that is wrong in three places (C-2). Both are ~10-minute fixes.

## Recommended order

1. Commit `web/feed.js` + the four modified files; add `.catch()` to both dynamic imports (C-1).
2. Fix the Node floor to 22.13 in `package.json`, `bin/gal.js`, and README (C-2).
3. Correct the "read-only" bullet (I-3).
4. Add `repository`/`homepage`/`bugs` to `package.json` (I-8).
5. Add `test/media-types.test.js` covering the allowlist and the new `.mov` mapping (I-7).
6. Fix the ffmpeg probe/invoke mismatch and turn skips into failures under a CI env var (I-4, I-5).
7. Surface scan errors instead of swallowing them (I-6).
8. Replace the bare `return`s in `test/watcher.test.js` with `t.skip` (I-9); guard the chmod tests
   against root (I-10).
9. Add a `.github/workflows/test.yml` pinning Node 22.13 + ffmpeg + Chrome so the suite cannot go
   green while skipping half of itself.

## Unresolved questions

- Is `web/feed.js` intentionally held back, or simply not yet committed?
- Is the `?state=` demo hook meant to ship in the published package, or is it a dev-only affordance?
- Is Node 22.13 an acceptable floor, or should `--experimental-sqlite` be detected and re-execed on
  older 22.x?
