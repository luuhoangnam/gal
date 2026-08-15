# Code review — scan / index / metadata pipeline

Date: 2026-08-15 · Branch main · Scope: `src/walk.js`, `src/scan.js`, `src/index-db.js`,
`src/watcher.js`, `src/metadata.js`, `src/exif-image.js`, `src/video-meta.js`, `src/thumbs.js`,
`src/ffmpeg.js`, `src/media-types.js` (+ tests). Read-only review, no files modified.

Verification run: `node --test` from repo root → 119 tests, 119 pass on the second run;
the **first** run failed `test/watcher.test.js:10` (see IMP-11).

Two critical findings. Both are in code paths that ship today.

---

## Critical

### CRIT-1 — Read-only mode assigns colliding item ids; the gallery drops everything but the last batch

`src/scan.js:35`

```js
const rows = db.writable ? db.upsertBatch(batch, gen) : batch.map((b, k) => ({ ...b, i: -k }));
```

`batch` is reset to `[]` after every flush (`src/scan.js:37`) and flushed every 500 items
(`src/scan.js:42`), so `k` restarts at 0 for every batch. Every batch emits ids
`0, -1, … -499`.

The client keys items by `i` in a `Map` (`web/app.js:68`, `web/app.js:86`, `web/app.js:118`):
batch 2 overwrites batch 1, batch 3 overwrites batch 2. Worse, `web/app.js:306` prunes
`items` against the `seen` set of phase-A ids, so the positive rowids loaded from the
`t:'cache'` messages (`src/server.js:252-257`) are all deleted too.

Failure scenario: user runs a second `gal` on the same folder (an explicitly supported mode —
`src/index-db.js:56`, asserted by `test/index-db.test.js:98`), or points gal at a read-only
mount where `tryLock` cannot write. Library of 12,000 photos → the grid ends up showing at
most 500 items and reports `Quét xong, 500 mục`. No error anywhere.

Also note `i: 0` and `i: -0`: `Object.is` aside, `Map` treats `-0` and `0` as the same key, so
the first item of every batch collides with itself across batches as well.

Fix direction: in read-only mode derive a stable, unique id (e.g. a monotonic counter held on
the run, negated) instead of the per-batch index — the counter must live outside `flushA`.

### CRIT-2 — Every error in the scan pipeline is swallowed; the UI reports a truncated scan as complete

`src/scan.js:77-81`

```js
promise.catch(() => {
  done = true;
  ...
});
```

Nothing is pushed onto `log`. Any throw from `walk`, `db.upsertBatch`, `db.writeMeta`,
`db.endScan` or `metaBatches` ends the stream silently: `src/server.js:259-264` finishes the
NDJSON body normally with HTTP 200, and the client renders whatever arrived as a finished scan
(`web/app.js:270` announces `Quét xong, N mục`).

Concrete trigger, not hypothetical: `tryLock` (`src/index-db.js:31-41`) is a TOCTOU check, so
two gal processes started at the same second can both consider themselves writable. The second
writer then hits `SQLITE_BUSY` after `busy_timeout=5000` inside `upsertBatch`, which throws
after `ROLLBACK` (`src/index-db.js:122-125`). Result: the user sees a gallery containing the
first N×500 photos and an explicit "scan finished" message; the rest of the library appears
to have vanished. A ROLLBACK also discards a whole batch of already-emitted `t:'a'` rows, so
the ids the client is holding no longer exist in the DB.

Fix direction: emit a terminal `{ t: 'error', … }` message into `log` in the catch and render it
client-side; do not let `done` mean "success".

---

## Important

### IMP-3 — Directory symlink loop produces duplicate index entries and duplicate ffmpeg work

`src/walk.js:53`, `src/walk.js:86-92`

`visited` is only allocated when `followSymlinks` is on, and only symlinked directories are
recorded. The root itself is never inserted, so a link pointing back at an ancestor is walked
exactly once more before the guard trips. Verified empirically:

```
root/{a.jpg, sub/b.jpg, sub/loop -> root}   with followSymlinks: true
→ ["a.jpg","sub/b.jpg","sub/loop/a.jpg","sub/loop/sub/b.jpg"]   (stats.files = 4)
```

Every physical file is indexed twice under two `rel` paths → two rowids, two grid tiles, two
distinct `thumbKey`s (`src/thumbs.js:25` hashes the absolute path) → **two ffmpeg spawns per
photo**. On the advertised 70k library with one such link this is 140k items and double the
thumbnail cost. `test/walk.test.js:86` only asserts `out.length < 50`, so it passes.

The same gap exists with `followSymlinks` off: `visited` is `null`, so a recursive bind mount
(Linux `mount --bind`) or a firmlink chain recurses without any dev/ino guard. On macOS the
`/System/Volumes/Data` firmlink does not nest (checked), so `gal /` "only" double-indexes rather
than looping forever — but nothing in the code prevents the looping case.

Fix direction: make `visited` unconditional and check `dev:ino` for **every** directory pushed
onto the stack, including `root`.

### IMP-4 — Cache invalidation ignores `size`, so same-mtime replacements keep stale metadata

`src/index-db.js:65`

```sql
date_src = CASE WHEN media.mtime = excluded.mtime THEN media.date_src ELSE NULL END
```

`size` is available in the same statement but is not part of the comparison, and `pending`
(`src/index-db.js:70-72`) only selects rows where `date_src IS NULL`.

Scenario: `rsync -t` / `cp -p` / any restore-from-backup replaces `IMG_1234.jpg` with a
re-edited 6000×4000 version while preserving mtime. gal keeps the old `w/h/orient/taken`
forever. Meanwhile `thumbKey` *does* include size (`src/thumbs.js:27`), so a fresh thumbnail is
generated with the new aspect ratio — the grid reserves the old geometry and renders the new
image into it. Silent, permanent, and only fixable via `--clear-cache`.

Fix direction: add `OR media.size <> excluded.size` to the CASE condition.

### IMP-5 — Sentinel EXIF/QuickTime dates become real capture dates in 1899/1904

`src/exif-image.js:38-44` and `src/video-meta.js:56-59`

`parseExifDate` accepts any regex-shaped string. Verified:

```
'0000:00:00 00:00:00' → new Date(0, -1, 0, 0, 0, 0) → 1899-11-29T16:53:30Z
'1904-01-01T00:00:00Z' (QuickTime epoch, very common in stripped .mov) → 1904-01-01
```

`src/metadata.js:16` then sets `ds: DATE_EXIF`, i.e. the UI presents these as *authoritative
capture dates*, not mtime fallbacks. With `ORDER BY taken DESC` (`src/index-db.js:75`) those
items sink to the bottom of the library and the date filter/timeline shows an 1899 bucket.
Note `new Date(0, ...)` maps year 0 to 1900 via the two-digit-year rule, which is why the
result is 1899 rather than year 0 — the value cannot be sanity-checked downstream either.

Fix direction: reject parsed timestamps outside a plausible range (e.g. `< 1970` or in the
future) in both parsers and fall through to mtime.

### IMP-6 — `ffprobe` is looked up on bare PATH while `ffmpeg` gets the Homebrew fallback

`src/video-meta.js:13` and `src/video-meta.js:67` call `execFile('ffprobe', …)` directly.
`src/ffmpeg.js:33` exists precisely because macOS GUI/launchd processes start with a minimal
PATH that lacks `/opt/homebrew/bin` — and `src/thumbs.js:80` uses it.

Scenario: gal launched from a GUI/Automator/LaunchAgent on macOS. Thumbnails work (ffmpeg found
via the Homebrew fallback), but every `probe()` fails with ENOENT → `resolve(null)`
(`src/video-meta.js:17`) → every video gets `w/h/dur = null` and `taken = mtime`. No warning:
`hasFfprobe()` has the same blind spot, so the "install ffmpeg" hint never fires. The whole
video half of the index degrades silently.

Fix direction: resolve `ffprobe` through the same `searchDirs()` lookup (generalize
`ffmpegPath` to take a binary name).

### IMP-7 — Orphan ffmpeg processes survive gal exit, with no timeout enforcement

`src/thumbs.js:104-114`

`detached: true` puts each ffmpeg in its own process group; the only kill switch is a
`setTimeout` living in gal's event loop. When gal exits (Ctrl-C, terminal close,
`server.close()`), that timer dies with it and nothing signals the children.

Scenario: user scrolls a folder of 4K/HEIC files, then Ctrl-C. Up to `cpus().length` ffmpeg
processes keep decoding, unsupervised and now past any timeout — on a 48MP HEIC or a long
video that is tens of seconds of full-core CPU after the user believes gal is gone. Repeated
start/stop cycles accumulate them.

Fix direction: track live child pids and `process.kill(-pid,'SIGKILL')` them from a
`server.on('close')` / SIGINT handler; `src/server.js:282` already has the hook.

### IMP-8 — AppleDouble sidecars are indexed as media

`src/walk.js:27-31` skips hidden *directories* only; `src/walk.js:104` classifies any file whose
extension matches. macOS writes `._IMG_0001.jpg` next to every file on exFAT/FAT32/SMB volumes.

Scenario: a 70k-photo USB drive or NAS share → 140k index rows, half of them 4KB AppleDouble
resource forks that ffmpeg cannot decode. Each one costs a spawn (two for anything matching
`/\.hei[cf]$/`, `src/thumbs.js:136-138`), lands in `failed`, and renders as a broken tile.
The README's "70,000 items / first photo in under a second" claim does not survive this.

Fix direction: skip basenames starting with `._` (and, arguably, any dotfile) in `classify`
or in the walk's file branch.

### IMP-9 — No schema version, no corrupt-DB recovery, and the failure is reported as a port error

`src/index-db.js:5-20` uses `CREATE TABLE IF NOT EXISTS` only; there is no `user_version`, no
migration, and `openIndex` prepares every statement eagerly (`src/index-db.js:58-81`).

Scenario A: a future release adds a column. Every existing `.gal/index.db` makes
`db.prepare(...)` throw `ERR_SQLITE_ERROR` at startup for every library the user owns.
Scenario B: power loss during a WAL checkpoint → `file is not a database` at `db.exec(SCHEMA)`.

In both cases `src/cli.js:106-116` catches it and prints
`gal: không bind được 127.0.0.1:0 — <raw sqlite message>` — the exception is attributed to
port binding, and the actual recovery (`--clear-cache`) is never suggested.

Fix direction: set/read `PRAGMA user_version`, drop+recreate on mismatch or corruption, and
separate the index-open failure from the listen failure in the CLI error path.

### IMP-10 — Lock file: TOCTOU race, and an empty lock file locks the library forever

`src/index-db.js:31-41`

* Read-then-write with no `wx` flag: two simultaneous starts both become writable (feeds CRIT-2).
* `Number(readFileSync(...))` on a **zero-byte** lock file (crash between `open` and `write`)
  yields `0`, and `process.kill(0, 0)` targets the caller's own process group — it always
  succeeds, so `tryLock` returns `false` permanently. gal stays read-only on that folder until
  the user manually deletes `.gal/index.lock`, and read-only mode is broken by CRIT-1.
* PID reuse: an unrelated process inheriting the recorded pid pins the library read-only.

Fix direction: `writeFileSync(lockPath, pid, { flag: 'wx' })` and treat a non-positive parsed
pid as a stale lock.

### IMP-11 — Watcher misses events fired immediately after `watch()` returns

`src/watcher.js:38`. `node --test` from the repo root failed on the first run:

```
✖ rev tăng khi có file mới, chờ đúng lượt (5005ms)  — 0 !== 1
```

and passed when the file was run alone. The test waits 5s, so this is not a debounce-timing
artifact — the FSEvents registration behind `fs.watch({recursive:true})` is asynchronous, and
under load the write landed before the watcher was armed. In production: files created in the
first moments after `gal --watch` starts never bump `rev`, and since `rev` only moves on the
*next* change, the UI can stay stale indefinitely.

Related, same file: `clearTimeout(timer)` on every event means a long-running copy (e.g. 30 min
of importing from an SD card) never reaches a quiet 800 ms window, so `rev` never bumps during
the import. A max-wait cap would bound that.

Also `w.on('error', () => {})` (`src/watcher.js:46`): if the watcher dies, clients long-poll a
frozen `rev` forever with no signal. At minimum, flip a flag so `/api/watch` can answer 204.

### IMP-12 — `/tmp` cache fallback is a predictable path in a world-writable directory

`src/cache-dir.js:25` — `path.join('/tmp', 'gal', flatten(root))`.

`mkdirSync(..., {recursive:true})` follows an existing symlink, and the path is fully
predictable (`/tmp/gal/Users-nam-Pics`). On a shared macOS/Linux host, another local user can
pre-create that path (or a symlink from it) and receive `index.db` — a complete listing of the
victim's photo paths and capture dates — plus every generated thumbnail, i.e. downsized copies
of the images themselves. Even without an attacker, default `/tmp` permissions make the
thumbnails world-readable.

This fallback fires exactly when the library is on a read-only mount, i.e. shared/NAS/external
media — the case most likely to be on a multi-user box.

Fix direction: use `os.tmpdir()` (per-user `/var/folders/...` on macOS) and create the directory
with mode `0o700`.

### IMP-13 — README states gal never writes into the scanned folder; it does

`README.md:36` — "**Read-only** — `gal` never writes to, moves, or renames anything in the
folder you point it at" — contradicts `README.md:100-107` and `src/cache-dir.js:16-23`, which
create `<root>/.gal/`, write a `.w-<pid>` probe file, `index.db`, `index.lock`, and the
thumbnail cache there.

The `<root>/.gal` design is a deliberate, documented decision (portable external drives,
`--clear-cache` semantics) and I am **not** recommending changing it. The line at `README.md:36`
is the defect: it is the sentence a user reads before pointing gal at a curated archive, and it
is false. Either scope it ("never modifies your media files") or state the cache exception
inline.

### IMP-14 — Unbounded retained scan log at the advertised scale

`src/scan.js:16-24`. `log` retains **every** message for the lifetime of the run so late clients
can replay it, and is only released by `reset()` (`src/server.js:263`) — which never runs if the
last client disconnects mid-stream (`src/server.js:260` returns early).

At the advertised 70k items that is ~70k phase-A item objects plus ~70k phase-B result objects,
plus a 70k-entry `thumbs.registry` Map (`src/thumbs.js:51`) that is never pruned at all. The
replay design is sound; the missing piece is a release once `done` and no waiters remain, and a
registry bounded by the current generation.

---

## Minor

* `src/thumbs.js:131` writes `${out}.${pid}.tmp`; `sweep()` (`src/thumbs.js:220`) only considers
  `*.jpg`. Crashed/killed renders leave `.tmp` files that are never counted toward `maxBytes`
  and never deleted.
* `src/thumbs.js:231` sorts the LRU by `atimeMs`. With `relatime`/`noatime` mounts (Linux
  default) atime barely moves, so eviction order is close to arbitrary.
* `src/thumbs.js:165-169` `previewKey(rel)` re-joins the **raw** client-supplied `p`
  (`src/server.js:225`) rather than the `abs` that `resolveMedia` just validated. Currently safe
  because the route validates first, but the trust boundary is re-crossed for no reason — pass
  the validated path.
* `src/ffmpeg.js:12-26` memoizes `null` for the process lifetime; installing ffmpeg while gal
  runs requires a restart, and `accessSync(p, X_OK)` accepts a *directory* named `ffmpeg`
  (spawn then fails and every thumbnail silently 404s).
* `src/walk.js:90` skips bundle-suffixed symlinked directories without incrementing
  `stats.skippedBundles`, so the empty-state message under-reports.
* `src/media-types.js:52` `classify('.jpg')` (a dotfile literally named `.jpg`) returns
  `'image'`; harmless today, but it shows the extension split has no basename guard — same root
  cause as IMP-8.
* `src/index-db.js:146-151`: if a scan crashes before `endScan`, `meta.gen` is never advanced,
  so the next run reuses the same generation number and rows written by the crashed scan are
  never swept. Deleted files linger for one extra scan.
* DRY: `src/video-meta.js:65-68` (`hasFfprobe`) is a second, independent binary-availability
  probe alongside `src/ffmpeg.js:11` — the direct cause of IMP-6.

---

## `.mov` → `video/mp4` (uncommitted change in `src/media-types.js:23`)

**Verdict: safe for every current consumer.** Grepped consumers: `src/range.js:4`,
`src/server.js:14`, `src/walk.js:3`, plus the derived sets inside the module itself.

* `VIDEO_EXTS` (`src/media-types.js:33-35`) is derived by `startsWith('video/')`, so `.mov`
  remains a video; `classify()` still returns `'video'`, `walk` still sets `v: 1`, and
  `metadata.js:15` still routes `.mov` to `videoMeta`.
* `needsTranscode` (`src/media-types.js:40-44`) is a separate list — untouched.
* Thumbnail branch selection uses `info.kind === 1` (`src/thumbs.js:137`), which comes from
  `classify`, not from the MIME string — unaffected.
* `/api/file`'s allowlist check (`src/server.js:239`) only tests truthiness — unaffected.
* Range/streaming (`src/range.js`) only forwards the string as `Content-Type`.
* No test asserts `video/quicktime` anywhere in `test/`. `node --test` is green.
* The rationale in the comment is correct: `.mov` is ISO-BMFF and Chrome's
  `canPlayType('video/quicktime')` returns `''`. `nosniff` does not interfere (it constrains
  script/style only).

Two things worth knowing rather than fixing:

1. Classification is now *derived from the MIME label*. Relabelling an extension silently
   changes which pipeline it takes. A one-line test pinning `VIDEO_EXTS.has('.mov')` and
   `classify('x.mov') === 'video'` would make the coupling explicit and cheap to keep honest.
2. A browser "Save video as…" on a `.mov` served as `video/mp4` may suggest a `.mp4` filename
   (no `Content-Disposition` is set in `serveFile`). Cosmetic; the bytes are unchanged.

---

## Test coverage notes

* No test exercises the read-only scan path end-to-end — which is why CRIT-1 ships green.
  `test/index-db.test.js:98` covers the lock, but never streams items through `createScanner`
  with `db.writable === false`.
* No test covers the scan error path (CRIT-2): nothing asserts what the client sees when
  `upsertBatch` throws mid-scan.
* `test/walk.test.js:86` ("symlink loop") asserts only `out.length < 50`, which is satisfied by
  the duplicated output in IMP-3. Assert the exact path set instead.
* `test/index-db.test.js:34` covers mtime-based invalidation but not size (IMP-4).
* `test/watcher.test.js:10` is order/load dependent (IMP-11).

## Recommended order

1. CRIT-1 (read-only id collision) and CRIT-2 (error surfacing) — both are user-visible data loss.
2. IMP-4 (size in invalidation), IMP-5 (sentinel dates), IMP-6 (ffprobe lookup) — one-line-ish
   fixes with large correctness payoff.
3. IMP-3 (unconditional dev/ino guard), IMP-8 (`._` sidecars) — both hit the 70k claim directly.
4. IMP-7, IMP-9, IMP-10, IMP-12 — robustness and local-trust boundary.
5. IMP-13 (README sentence), IMP-11, IMP-14, then the minors.

## Unresolved questions

* Is single-user-machine the intended threat model? IMP-12 is only a real exposure on a shared
  host; if shared hosts are out of scope, the `0o700` + `os.tmpdir()` change is still nearly free.
* Should the `<root>/.gal` cache stay opt-out-able (a `--cache-dir` flag already exists
  internally via `createServer`)? That would resolve IMP-13 without touching the default.
* At 70k items, what is the acceptable RSS ceiling? IMP-14 needs a target before it can be sized.
