# Red-team: backend + security (phases 1,2,3,4,9)

Reviewed: plan.md, phase-01/02/03/04/09, brainstorm contract, both research reports. Advisory only, no files changed.
Verified locally: `node:sqlite` default `journal_mode=delete`, no busy_timeout, 2nd writer → `ERR_SQLITE_ERROR`; `os.cpus().length`=12; ephemeral port range 49152-65535 (16384 ports); ffmpeg 9.0.1.

## WILL DEFINITELY BREAK

**B1. `i` (id) is not stable across reopen → `/api/thumb?i=N` serves the wrong file.**
Phase 2 defines `i` = discovery order, and calls it the scroll anchor. Phase 3 reopens from SQLite (rowid order) and then runs a *background phase A rescan* whose discovery order depends on `readdir` order and on files added/removed. Nothing in the plan says ids are persisted and re-bound to `rel`. Consequence: after one file is deleted from the middle of the tree, every subsequent id shifts by one; the grid shows photo N with the thumbnail/lightbox of photo N+1. Fix: `id` = SQLite rowid, allocated once per `rel`, never reused, and phase A rescan must look up existing ids by `rel` instead of counting. Add a unique index on `rel`.

**B2. Two `/api/scan` requests = two walkers, two id sequences, one shared id space.** Just pressing reload mid-scan does it (or two tabs). Nothing in phases 2/3 mentions a single scan session. Also doubles ffmpeg/CPU. Fix: one scan session per root per process; second request attaches to the same session and replays the buffered stream (or 409).

**B3. Two `gal` processes on the same root → SQLite crash.** Measured above: default rollback journal, no `busy_timeout`, second `DatabaseSync` write throws immediately. `gal ~/Pictures` in two terminals is a normal user action. Fix: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;` at open, and wrap all writes in try/catch that degrades to "no cache this run" rather than exiting.

**B4. Walker follows symlinked directories; `resolveInside` rejects them at serve time.** Phase 2's symlink defense is loop-only (dev+ino set), so files under a symlinked subdir are indexed with `rel = link/img.jpg`; Phase 1's realpath containment then 403s exactly those files. Result: a visibly broken grid section with no explanation. Decide one way: either don't descend into symlinks that leave the root, or record the realpath and mark such items. Do not leave the two layers disagreeing.

**B5. No negative cache for failures.** Phase 4 says "file hỏng → placeholder" but only writes cache on success. Every viewport pass over the same 0-byte/corrupt file respawns ffmpeg and waits up to the 10s timeout, 12 at a time. A folder of 5k junk `.mp4` files pins all cores indefinitely. Fix: write a failure marker keyed by the same hash, with a short TTL.

**B6. mtime rounding mismatch → full phase B re-run every reopen.** `mtimeMs` is a float (measured `...329068.0063`); the DB column is INTEGER. If insert uses `Math.round` and the rescan comparison uses `Math.floor` (or raw float `!==` INTEGER), *every* file looks changed. Pick one integer form and use it in both the DB and the thumb cache key. `fs.stat(p,{bigint:true}).mtimeNs` is available and free if you want real ns resolution — the ms-granularity collision risk itself is negligible for photos.

## SECURITY

**S1 (High). Host-header validation does not stop cross-origin *requests*, only rebinding-as-same-origin.** Any web page can emit `<img src="http://127.0.0.1:51234/api/thumb?i=9000&s=320">` — the Host header is literally `127.0.0.1:51234`, i.e. allowlisted. Reading is blocked by SOP, but the request executes: unauthenticated CPU DoS (spawns ffmpeg), plus existence oracles via `onload`/`onerror` and timing. Port scan over 16k ports is a few seconds of `<img>` probes. Add, at the same guard: reject when `Origin` is present and not the server's own origin; reject `Sec-Fetch-Site: cross-site`; require `Sec-Fetch-Dest` in {document, empty, image, video, audio} *and* `Sec-Fetch-Site: same-origin` for `/api/*`. Cheap, and it is the layer that actually closes this.

**S2 (High). Browser HTTP cache key is the URL, not your content hash — `Cache-Control: immutable` leaks thumbnails across roots.** `/api/thumb?i=5&s=320` on `http://127.0.0.1:51234` is cached for a year. macOS hands out ephemeral ports from a 16k range; after ~150 runs a repeat is more likely than not. Run `gal ~/A`, later `gal ~/B` lands on the same port → B's grid renders A's photos from cache, and the user has no way to know. Fix: put the cache key in the URL (`/api/thumb?h=<sha1>`) or add a per-process instance nonce to every asset URL. Phase 9's `--port 8080` makes this deterministic rather than probabilistic — and simultaneously deletes defense layer #3.

**S3 (High). `/api/file` has no content-type policy.** Phase 1 serves any file under root by path with no extension allowlist and no `X-Content-Type-Options`. If the content type is sniffed or defaults to `text/html`, an `.html`/`.svg` file sitting in the served tree (`gal ~/Downloads` is the obvious case) becomes same-origin script on the gal origin — and that origin can read every file under root. Fix: serve only ids present in the index, map content-type from a fixed extension allowlist, send `X-Content-Type-Options: nosniff`, and put a restrictive CSP on `/`. SVG should be served as `application/octet-stream` or not at all.

**S4 (Medium). `/api/thumb?i=` id→path mapping is never validated.** Index-based is a genuine improvement over path-based (no traversal surface) — say so — but only if the resolved `rel` is re-run through `resolveInside(root, rel)` *at serve time*, because ids come from a cache DB written by a previous run, when the tree looked different. Also validate `i` is a non-negative integer and `s` is in a fixed set {160,320,640}; an unbounded `s` lets a page spawn 8000px "thumbnail" encodes.

**S5 (Medium). TOCTOU between `realpath` and `open`.** Standard and unavoidable with this API shape; for a single-user local tool it is low-value to attack. Mitigate cheaply: `fs.open(p, O_NOFOLLOW)` on the final component, `fstat` the fd, and stream from the fd rather than reopening by path. Do not spend more than that.

**S6 (Low, correct as planned).** `spawn('open',[url])` with an argv array and no shell — no metacharacter exposure, and the URL contains no user path. Fine. Unicode NFD/NFC: `realpath`+`path.relative` on both sides is the right fix and does hold; the only residual is that `sha1(realpath(root))` differs between NFC and NFD spellings of the same directory, which duplicates the cache (waste, not a leak). Reject requests with a missing or duplicated `Host` header explicitly so the guard cannot throw on `undefined`.

## ISO-BMFF BOX-WALKER (Phase 3) — untested parser over 70k attacker-shaped files

Files are selected by *extension only* (Phase 2), so this parser will be fed whatever happens to be named `.mp4`. The phase text has zero hardening requirements. Minimum bar before this ships:

- `size == 0` means "extends to EOF" per spec; a naive loop that adds `size` advances 0 → **infinite loop**, walker never returns, scan hangs forever with no timeout anywhere in the plan.
- `size` in 1..7 is invalid (1 = 64-bit `largesize` follows). Enforce `size >= 8`, and `>= 16` when `size == 1`.
- `largesize` is uint64: `readBigUInt64BE` → `Number()` silently loses precision above 2^53 and can go negative/NaN through arithmetic. Reject anything > file size.
- Box size larger than the file → seek past EOF; `read` returns 0 bytes; the next `readUInt32BE` throws `RangeError` (also true for any file < 8 bytes, i.e. every 0-byte file).
- "đọc riêng box đó (~13KB)" — a hostile/corrupt `moov` header can claim 4GB. Unbounded `Buffer.alloc` → OOM kills the whole server process, taking the HTTP server and all in-flight work with it. Clamp to e.g. 32MB and bail.
- Recursive descent `moov→trak→mdia→minf→stbl` with no depth cap → crafted deep nesting = stack overflow (also uncatchable in some forms).
- `stsd`/`stts` entry counts are uint32 from the file: `0xFFFFFFFF` → 4-billion-iteration loop. Bound every count by remaining box bytes.
- Every per-file parse must be wrapped so a throw *or an async rejection* cannot kill the pool; Phase 3 asserts this for "ảnh hỏng" but never for the video path, and an unhandled rejection in Node terminates the process by default.
- Required test that the plan does not have: a fuzz/mutation suite (truncate, flip size fields, zero sizes, nest 10k deep) asserting bounded time and no throw. Without it, "không crash" in the success criteria is unverified.

## RESOURCE EXHAUSTION

- **Image decompression bomb.** `-frames:v 1` still decodes the full frame. A 30000×30000 PNG is ~3.6GB as RGBA; 12 of them concurrently is guaranteed swap death, and the 10s timeout does not help because the allocation happens fast. Gate on the `w*h` you already have from phase B (skip > ~100MP → placeholder), and pass `-threads 2` so 12 jobs don't oversubscribe 12 cores.
- **Concurrency is wrong on Apple Silicon.** `os.cpus().length`=12 counts efficiency cores; 12 concurrent ffmpeg jobs each multi-threaded is heavy oversubscription while the user is scrolling. Use ~half, measure.
- Zombie ffmpeg: `spawn` + `kill()` does not reap a process that ignores SIGTERM. Use `detached:true` + `process.kill(-pid,'SIGKILL')` after a grace period, and kill all children on server exit (`SIGINT` handler) or every abandoned `gal` run leaves ffmpeg processes behind.
- 100k 0-byte files: phase A fine; phase B throws per file (must be caught, see above); phase C is B5.
- SQLite writes during phase B are *synchronous* and block the event loop. 70k inserts batched at 1000/transaction is fine (31ms per 70k measured), but any per-file write, or a sync query on the request path, stalls thumbnail serving. Keep all reads client-side or batch them.
- No global timeout on phase A/B. A pathological tree (deep symlink fan-out, network mount) hangs the scan with no user-visible failure.

## HTTP RANGE — cases the phase text does not enumerate

Success criteria list 7 cases; these are the ones hand-rolled parsers actually get wrong: `Content-Length` on 206 must be `end-start+1`; `end >= size` clamps to `size-1` (200-with-range-header is wrong, 416 is also wrong); suffix longer than the file returns the whole file; `bytes=-0` → 416; any range on a 0-byte file → 416; 416 **must** carry `Content-Range: bytes */size`; `If-Range` with a weak validator must be ignored per RFC 9110; `createReadStream({start,end})` is inclusive (off-by-one); on client abort (`res` close, which `<video>` does constantly while scrubbing) the stream must be destroyed or fds and buffers accumulate; and non-numeric/overflowing range values must not reach `createReadStream`. Also: whatever `If-Range` validator you emit (ETag or Last-Modified) has to be derived from the same mtime integer as B6, or seeking silently refetches — the exact silent bug the phase warns about.

## ESTIMATES — not honest

- **Phase 3 "2d": no.** From-scratch ISO-BMFF walker with the hardening above + `mvhd` v0/v1 + `tkhd` matrix + fixed-point 16.16 + fuzz tests is 1.5–2d on its own. Progressive EXIF + orientation ≈0.5d. SQLite schema + stable ids + reopen diff + WAL/busy handling ≈1d. Bench script 0.25d. Realistic **3.5–4.5d**. The plan's own text calls this "phase kỹ thuật khó nhất" and "chưa từng được viết và đo" while pricing it the same as Phase 4. The ffprobe fallback is a good pre-committed escape hatch — but 6300 videos × 25ms sequential is 2.6 min *added to* the 3-minute budget, not inside it.
- **Phase 1 "1.5d": no.** Range done to the above standard plus tests is ~1d alone; add CLI, static serve, safe-path, host guard, three test files. Realistic **2–2.5d**.
- **Phase 4 "1.5d":** priority queue + cancellation + dedupe + atomic writes + LRU + timeouts + process-group kill + negative cache. Realistic **2–2.5d**.
- Phase 2 (1d) and Phase 9 (1d) look right.
- Total backend realistically ~11–13d vs the 7d implied, before frontend.

## CORRECT AS PLANNED (no objection)

`realpath` + `path.relative` instead of `startsWith`; mandatory Host validation; NDJSON + backpressure over SSE; `node:sqlite` over `better-sqlite3`; JPEG over WebP/AVIF with measured justification; dropping the embedded-thumbnail shortcut on measurement; `/api/scan` taking no root parameter (the root is CLI-fixed — keep it that way, and explicitly 400 on any `root`/`p` parameter so it cannot be added carelessly later).

## Unresolved questions

1. Is `--port` (Phase 9) worth deleting the random-port defense and making S2 deterministic? Recommend dropping it from v1, or requiring it to also bump the asset nonce.
2. Should `/api/file` become id-based like `/api/thumb`, eliminating client-supplied paths entirely? That would collapse S3+S4+S5 into one validated lookup.
3. Does the index cache survive a `gal` version bump? No schema version column in the Phase 3 DDL — add one, or the first schema change corrupts every existing user's cache.

Status: DONE_WITH_CONCERNS
Summary: Found 6 will-definitely-break defects (unstable ids across reopen, concurrent-scan and concurrent-process SQLite failures, walker/serve symlink disagreement, no negative cache, mtime rounding), 4 real security gaps (cross-origin request forgery despite Host validation, immutable-cache leak across roots via port reuse, no content-type policy on /api/file, unvalidated id→path), and an entirely unhardened binary parser with an infinite-loop and OOM surface.
Concerns/Blockers: Phase 3 (2d) and Phase 1 (1.5d) estimates are not credible; budget ~3.5-4.5d and ~2-2.5d respectively. Recommend adding a fuzz test requirement to Phase 3 and an Origin/Sec-Fetch check to Phase 1 before implementation starts.
