# Review — HTTP server + security surface (`gal`)

Date: 2026-08-15 · Scope: `src/server.js`, `src/safe-path.js`, `src/range.js`, `src/cli.js`,
`bin/gal.js`, `src/cache-dir.js` + their tests. Read-only review, no files modified.
Baseline: `npm test` → 119 pass / 0 fail.

## Verdict

**No critical security escape found.** Path traversal, symlink escape, the extension
allowlist, and the three-layer Host/Origin/Sec-Fetch guard hold up under the stated threat
model — I tried to break them and could not (details in "Verified sound").

Two **critical resource leaks** are proven with runnable repros. Both are reachable by a
plain unauthenticated request and both are also hit during *normal* browsing, so they will
show up in production as "the server stopped serving after a while".

---

## Critical

### C1 — `.pipe(res)` leaks a file descriptor on every aborted response

`src/range.js:85`, `src/range.js:94`, `src/server.js:114`, `src/server.js:136`

`readable.pipe(dest)` does not destroy the source when the destination closes early. When
the browser aborts a response (scrolling cancels in-flight `<img>` loads, `<video>` seek
cancels the previous Range request, tab close), the `res` is destroyed and the
`fs.ReadStream` stays open forever.

Repro (identical pattern to `range.js:85`, 20 aborted downloads):

```
open fds on the served file after 20 aborted downloads: 20
```

Failure scenario: user scrubs a video or fast-scrolls a 70k-file grid → hundreds of aborted
requests → fds accumulate → `EMFILE: too many open files` → every subsequent request falls
into the generic `catch` and returns 500 until the process is restarted. A LAN client can
reach the default `ulimit -n` deliberately in seconds. `--lan` makes this remotely
triggerable by anyone on the network.

Fix: `await pipeline(createReadStream(...), res)` from `node:stream/promises` at all four
sites (a single shared helper covers all four — see D1). `pipeline` destroys the source on
destination close and surfaces the error to the existing `try/catch` instead of leaving it
on the floor.

### C2 — `/api/scan` handler hangs forever when the client disconnects mid-stream

`src/server.js:143` (`writeLine`), used at `src/server.js:255`, `257`, `261`

```js
if (!res.write(JSON.stringify(obj) + '\n')) await once(res, 'drain');
```

`events.once(res, 'drain')` resolves on `drain` and rejects on `error`. It does **not**
settle on `close`. If the client goes away while the socket buffer is full, `drain` never
fires and the promise never settles.

Repro (5 clients aborting mid-NDJSON-stream):

```
handlers that ran to completion (of 5): 0
handlers still pending forever: 5
```

The `if (res.destroyed) return` guards at `:254` and `:260` never get a turn, because
execution is parked *inside* the await. Each leaked handler pins the scan generator, its
`log` array and the batched rows.

Failure scenario: user reloads the tab during the initial scan of a large library (the exact
moment a user is most likely to reload, because the grid is still filling). Every reload
leaks one handler permanently. Combined with C1 it also holds fds.

Fix: bound the wait — race `drain` against `close`, or `once(res, 'drain', { signal })` with
an `AbortController` fired from `res.on('close')`, then re-check `res.destroyed`.

Knock-on (Important on its own): because the handler never returns, `scanner.reset()` at
`src/server.js:263` is never reached. `scan.js:94` re-attaches to a finished run whose `log`
is non-empty, so the next `/api/scan` replays the stale log instead of rescanning — the user
reloads after adding photos and does not see them.

---

## Important

### I1 — `--port 80` disables the Host guard's allowlist and 403s everything

`src/server.js:75` — `names.some((n) => host === `${n}:${port}`)`

Browsers omit the default port from the `Host` header. `sudo gal ~/Pictures --port 80` →
browser sends `Host: 127.0.0.1` → no entry matches `127.0.0.1:80` → every request, including
`/`, returns `403 bad host`. `--port` is a documented flag (`src/cli.js:17`) and 80 is the
obvious value for someone wanting a clean LAN URL.

Fix: normalize before comparing — strip a trailing `:80` from `req.headers.host` when
`port === 80`, or compare `(host, port)` after parsing rather than by string concat.

### I2 — Host allowlist is a startup snapshot; a DHCP/Wi-Fi change bricks `--lan`

`src/server.js:152` — `names` computed once in `createServer`, from
`os.networkInterfaces()`.

Scenario: `gal ~/Ảnh --lan` on a laptop, phone browsing happily. Laptop roams to another AP
or the DHCP lease renews with a new address. The listener on `0.0.0.0` still accepts the
connection, but `Host: 192.168.1.57:PORT` is not in the frozen allowlist → `403 bad host`,
with a message that gives the user no way to guess the cause. Same for sleep/wake and
VPN up/down.

Fix: recompute the interface-derived names lazily on a Host miss (cheap — only on the
failure path), or on an `os.networkInterfaces()` re-read every N seconds. Keep the allowlist
semantics; only make it live.

### I3 — read-only-root cache falls back to a predictable path in world-writable `/tmp`

`src/cache-dir.js:25` — `path.join('/tmp', 'gal', flatten(root))`

`/tmp` is hardcoded (not `os.tmpdir()`) and the name is fully derived from the library path,
so it is guessable by any other local user. `/tmp` is world-writable + sticky on macOS.
`mkdirSync(fallback, { recursive: true })` succeeds on a pre-existing directory *and*
follows a pre-existing symlink to a directory.

Scenario (multi-user Mac / shared build box, library on a read-only mount): attacker
pre-creates `/tmp/gal/Volumes-Photos` mode 0777 (or as a symlink into their own home). `gal`
then writes `index.db` (full file listing of the library) and every generated thumbnail
there. Attacker reads renderings of private photos. Pre-creating it as a *file* instead is a
plain DoS — `mkdirSync` throws out of `cacheDirFor` and, via I4, crashes with a raw stack.
`fs.rm` on `--clear-cache` also then deletes the wrong thing's link.

Note `flatten` collides: `/a/b-c` and `/a-b/c` both flatten to `a-b-c`.

Fix: `os.tmpdir()`, `mkdtemp`-style ownership-checked directory or 0700 + `lstat` ownership
verification before use, and refuse the fallback if the existing entry is not a directory
owned by the current uid.

### I4 — `main()` is never awaited and `sweep()` has no `.catch()`; failures become process crashes

`bin/gal.js:16`, `src/cli.js:123`

`main(process.argv.slice(2))` is fire-and-forget. Anything that rejects after the
`try/catch` blocks — most concretely `clearCache` (`src/cli.js:159` `rm`, and `cacheDirFor`'s
`mkdirSync` on the I3 path) — becomes an unhandled rejection, which Node 22 turns into a
process abort with a raw stack trace. That directly contradicts the intent of commit
"lỗi nói được".

Same shape at `src/cli.js:123`: `server.thumbs.sweep().then(cb)` with no `.catch`. `sweep`
itself is well guarded, but a `console.log` EPIPE inside the callback (piping `gal` into
`head`) kills a server that is otherwise healthy.

Fix: `main(...).catch((err) => { console.error(`gal: ${err.message}`); process.exit(1); })`
and a `.catch()` on the sweep.

---

## Minor

- **M1 — `--clear-cache` creates the directory it is about to delete, and the "no cache"
  branch is dead.** `src/cli.js:150-158`: `cacheDirFor(root)` `mkdirSync`s `<root>/.gal`
  before `dirSize` runs, so `dirSize` never throws and `cli.js:155-157` is unreachable.
  Verified on a fresh empty dir: prints `Đã xoá …/.gal — giải phóng 0.0 MB` for a library
  that never had a cache, and leaves a `.gal` write as a side effect of a "delete" command.
  Fix: `existsSync`/`stat` the computed path instead of calling the creating helper.
- **M2 — `decodeURIComponent` throws → 500 instead of 400.** `src/server.js:274`. `GET /%`
  raises `URIError`, the generic catch at `:277` maps non-`ENOENT` to 500. Also inconsistent
  with the VENDOR branch at `:271`, which does *not* decode, so `/vendor/photoswipe/a%20b.js`
  404s while `/a%20b.js` resolves. Neither is a traversal (both go through `resolveInside`).
- **M3 — `bytes=500-100` returns 416.** `src/range.js:35`. RFC 9110 §14.1.1 treats a range
  with `last-pos < first-pos` as an invalid *syntax* → ignore the header and serve 200. The
  code classifies it unsatisfiable. No browser sends this; correctness nit only.
- **M4 — HEAD with a satisfiable Range returns 200 + full `Content-Length`.**
  `src/range.js:77` sits after the 416 check but before the range branch, so HEAD never
  produces `206`/`Content-Range`. Permitted by spec, but asymmetric with GET.
- **M5 — post-listen server errors are swallowed, then crash.** `src/server.js:293`:
  `server.once('error', reject)` survives a successful listen. The first error after listen
  is absorbed by an already-resolved promise (silent), the second has no listener → uncaught
  `error` event → crash. Fix: remove the listener in the `listen` callback and attach a
  permanent `server.on('error', …)`.
- **M6 — wrong error message for non-bind startup failures.** `src/cli.js:107-115`:
  `createServer` (which opens sqlite and creates the cache dir) is inside the `try` whose
  catch prints `không bind được ${host}:${port}`. A corrupt `index.db` reports a bind
  failure.
- **M7 — `dir` shadowing.** `src/server.js:269` destructures `dir` from `VENDOR`, shadowing
  the cache dir `dir` from `:159` in the same closure. Rename the loop variable; a future
  edit that reaches for `dir` in this block silently gets the wrong root.
- **M8 — layer 3 depends on a header old browsers do not send.** `src/server.js:83-97`: with
  no `Sec-Fetch-Site` and no `Origin` the request is allowed. `<img src>` / `<video src>`
  send neither on Safari < 16.4. Such a page still needs the random port and cannot read
  pixels (canvas taint), so the residual capability is an existence oracle over the library.
  Acceptable for v1 in my read — recording it so it is a decision, not an oversight.
- **M9 — `/api/priority` body accounting is O(n²) and the request is not drained.**
  `src/server.js:180` re-reduces every chunk on every chunk. Bounded by the 1 MiB cap, but a
  client sending 1-byte chunks does ~5·10⁸ additions inside the event loop. Also, on 413 the
  loop returns without `req.destroy()`, leaving the peer writing into a dead socket. Fix:
  running total + `req.destroy()`.
- **M10 — `lanUrls` is IPv4-only.** `src/server.js:303` filters with `/^\d+\.\d+\.\d+\.\d+$/`
  while `localHostnames` happily allowlists IPv6. On an IPv6-only LAN, `--lan` prints no
  usable URL even though the guard would accept it.
- **M11 — CLI parsing edges.** `src/cli.js:36-50`: a directory whose name starts with `-`
  (`gal -photos`) is rejected as an unknown option (no `--` terminator); extra positionals
  are silently ignored; `gal . --host --port 8080` consumes `--port` as the host value and
  then fails at bind; `--port 0x50` is accepted as 80 (`Number` accepts hex/`1e3`).

## Verified sound (no action)

Stated briefly so these are not re-litigated:

- `resolveInside` (`src/safe-path.js`) — realpath on both sides + `path.relative` is the
  correct construction. Absolute `p`, `../`, percent-encoded `../`, `root-evil` prefix,
  symlink-out, and APFS case variants all reject; covered by `test/safe-path.test.js` and
  the traversal test at `test/host-guard.test.js:78`.
- Extension allowlist ordering — `mediaType(path.extname(abs))` at `src/server.js:239` runs
  on the *realpath*, so `photo.jpg → secret.txt` is judged as `.txt`. `MEDIA_TYPES` contains
  no `.svg`/`.html`, and every media response carries `nosniff`. `evil.html.jpg` is served as
  `image/jpeg` and cannot execute.
- Host guard fails closed on a missing/odd `Host` (undefined never matches), and `--lan`
  widens to an allowlist of real interface addresses rather than `*` — the rebinding
  regression it was written to prevent is genuinely prevented (`host-guard.test.js:124`).
- No CORS headers anywhere; no state-changing endpoint beyond thumbnail priority.
- `parseRange` numeric edges: `bytes=99999999999999999999-` → 416, `bytes=-99999…` → whole
  file, empty file → 416, multi-range → ignored → 200. No overflow reachable.
- `scan.stream()` is log-replay based, so concurrent `/api/scan` clients do not steal each
  other's items.
- The generic `catch` at `src/server.js:276` is safe on an aborted request — `deny()` on a
  destroyed `res` does not throw (verified).

## DRY / dead code

- **D1** — four near-identical `createReadStream(...).pipe(res)` sites (C1). One
  `sendStream(res, readable)` helper built on `pipeline` removes the duplication and the bug
  at the same time.
- **D2** — `src/cli.js:155-157` is unreachable (M1).
- No speculative abstractions or parallel reimplementations found; module boundaries match
  the domain.

## Test gaps

Ranked by the risk they would have caught:

1. Aborted request → assert no leaked fd / no pending handler (would have caught C1 and C2).
2. `Host` header without a port (would have caught I1).
3. Static-route traversal: `GET /..%2f..%2fetc/passwd` and `GET /%` (currently only the
   `/api/file?p=` traversal path is tested).
4. `--clear-cache` on a directory with no cache (would have caught M1).

## Unresolved questions

- Is a multi-user machine in scope for the `/tmp` fallback (I3)? If `gal` is single-user
  desktop only, I3 drops to Minor — but the hardcoded `/tmp` instead of `os.tmpdir()` should
  change regardless.
- Is `--port 80` (I1) intended to be supported, or is the sudo requirement considered
  out-of-band? The fix is three lines either way.
