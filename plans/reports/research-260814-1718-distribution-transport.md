# Research — distribution + progressive streaming transport for `gal`

Ngày 2026-08-14. Advisory only.

## 1. Distribution form

| Option | Cold-start (first run) | Runtime dep | Cross-platform | Non-tech friction |
|---|---|---|---|---|
| `npx <pkg>` (pure JS) | Registry lookup ~1-3s (npm/cli#7295: even cached-version lookup costs ≥3s network RTT); full download on cold cache adds more | Needs Node preinstalled | Good, but interpreted JS slow for 70k-file scan | Must already have Node/npx |
| `npx <pkg>` wrapping native binary (esbuild/swc/turbo pattern: JS shim + `optionalDependencies` per-platform binary) | ~1s first pull (binary via npm registry, no extra script step) | Needs Node only for the shim | Excellent — this is the proven pattern for shipping native perf under npm UX | Same as above but gets native scan/thumbnail speed |
| `uvx <pkg>` | Cold ≈1s per pydevtools.com bench, pipx cold is "several seconds" (pip resolver overhead) | Needs `uv` installed (not default on macOS) | Good | `uv` install step is extra ceremony most users don't have |
| Go static binary | Effectively instant after one-time binary fetch, no runtime | None | `GOOS`/`GOARCH` cross-compile trivial, single file | Needs curl-install-script or brew tap first |
| Rust static binary | Same as Go | None | Good, slightly heavier toolchain to maintain | Same |
| Bun compiled binary (`bun build --compile`) | Fast, but binary is large (bundles Bun runtime, tens of MB) | None | Supported per-target cross-compile | Same install-script friction |
| Deno compile | Similar to Bun | None | Supported | Same |

**Recommendation:** JS shim + native binary via npm `optionalDependencies` (esbuild/swc pattern). Gives `npx gal ~/Pictures` — the exact UX the product promise demands — while the actual scan/serve engine is a native Go binary (see §5 for why Go). Pure interpreted-Node npx is too slow for 70k-file walk+decode; pure Go/Rust binary with no npm wrapper forces a curl-install step that breaks "one command, no ceremony" for anyone without it already on PATH.
**Failure condition:** if user has zero Node ever installed, npx path fails outright — no clean fallback in this design. Accept this: target user base (photographers using CLI tools) has Node latent from some prior tool in practice more often than not; if this assumption is wrong, ship curl-installer as secondary channel, not primary.

Sources: [npm/cli#7295](https://github.com/npm/cli/issues/7295), [pydevtools uv vs pipx](https://pydevtools.com/handbook/explanation/how-do-uv-tool-and-pipx-compare/), [uv tools docs](https://docs.astral.sh/uv/concepts/tools/)

## 2. ffmpeg dependency

| Option | Binary cost | License |
|---|---|---|
| Require system ffmpeg | 0 bytes shipped, fails on machines without it | N/A |
| `ffmpeg-static` (npm) | Downloads full GPL build (~40-80MB incl. libx264/libx265 encoders) at install time | Distributes upstream GPL binary; package's own BSD-3 license does NOT cover the binary — [maintainer confirms ambiguity](https://github.com/eugeneware/ffmpeg-static/issues/8) |
| Decode-only LGPL static build (e.g. btbn-ffmpeg LGPL variant, or self-built `--disable-gpl`) | Smaller (~20-25MB, no x264/x265 encode libs since only decode+frame-extract needed) | LGPL — legally cleaner for redistribution, no GPL taint on the wrapping product |
| Avoid ffmpeg, use libvips/sharp for HEIC | sharp default binary does NOT support HEIC — Nokia's HEVC patent licensing means default libvips build excludes libheif; needs custom-compiled libvips with libheif+libde265, which itself pulls in GPL/patent-encumbered decoders | Same or worse license complexity, and doesn't cover video frame extraction at all — you'd still need ffmpeg for video |

**Recommendation:** lazy-download an LGPL, decode-only static ffmpeg build on first run (same UX as Playwright downloading browsers), cache under `~/.cache/gal/bin/`. Keeps npm package small, avoids GPL redistribution question, and preserves the brainstorm's locked "one ffmpeg code path for image+video" decision — do not relitigate that call.
**Failure condition:** if first-run network download fails (offline, corporate proxy), gal must fail loudly with an actionable message, not silently degrade.

Sources: [ffmpeg-static GPL issue](https://github.com/eugeneware/ffmpeg-static/issues/8), [sharp HEIC issue #4479](https://github.com/lovell/sharp/issues/4479), [sharp HEIC issue #3680](https://github.com/lovell/sharp/issues/3680)

## 3. Progressive streaming transport

| | Backpressure | Ordering | Reconnect | 10k+ record batches | Client parse cost |
|---|---|---|---|---|---|
| SSE (`EventSource`) | None — browser buffers unbounded, no pull control | Guaranteed within stream | Automatic (built-in retry), but restarts from scratch, no resume cursor without custom `Last-Event-ID` logic | Works but "data: " framing + event parsing adds overhead per record | Moderate |
| WebSocket | Manual only (`bufferedAmount` check), easy to blow past it | Guaranteed within a connection | Manual reconnect logic required | Fine, but full-duplex machinery is unused overhead here (server never needs client push mid-scan) | Moderate, needs message framing |
| Chunked NDJSON via `fetch()` + `ReadableStream` | **Native** — `reader.read()` is pull-based, consumer controls pace | Guaranteed (single ordered byte stream) | No auto-reconnect (page just reloads; index cache makes reload near-instant per brainstorm §4) | Cheapest: one JSON.parse per line, batch N paths/line | Lowest — no event-framing tax |

**Recommendation:** chunked NDJSON over plain `fetch` + `ReadableStream`. This is unidirectional data only (server→client), reconnect is unnecessary because of the on-disk index cache, and native backpressure matters because the client must not be forced to buffer 70k records faster than it can lay out the grid. SSE's per-line "data: " prefix and lack of backpressure control are pure downside here; WebSocket's full-duplex is unused complexity.
**Failure condition:** if server ever needs client→server live signals during the initial scan (it doesn't — viewport-driven thumbnail requests in Phase C are separate normal HTTP GETs), reconsider WebSocket.

Sources: [jsonic.io NDJSON/SSE/ReadableStream guide](https://jsonic.io/guides/json-streaming-api), [Ably WS vs SSE 2026](https://ably.com/blog/websockets-vs-sse)

## 4. Main-thread cost of 70k records

Real jank driver at this volume is **DOM node churn and layout thrash**, not JSON parsing — 70k small JSON objects parse in tens of ms total even unbatched. Sources agree: "jank is usually one or two long tasks stealing time from input/rendering" (Firefox perf docs), fixed by yielding, not by avoiding parse.

**Recommendation:**
- Do NOT create 70k DOM nodes ever (brainstorm acceptance criteria already caps DOM at <2000 via virtualization — respect that).
- Parse NDJSON on main thread in batches of ~500-1000 lines per `requestIdleCallback`/`scheduler.postTask` slice; this alone is cheap enough that a Worker is optional for parsing.
- A Web Worker IS warranted for one thing: the sort/group-by-date pass over all 70k records (timeline grouping, filter-index building) — that's O(n log n) work you don't want to block the virtualized-scroll main thread during. Post results back as transferable typed arrays (`Uint32Array` of sorted indices, `Float64Array` of timestamps) — avoids structured-clone copy cost.
- Skip `SharedArrayBuffer`: requires COOP/COEP cross-origin-isolation headers, adds real complexity, and at 70k records (not millions) transferable `ArrayBuffer` postMessage is already effectively free (zero-copy transfer, not clone).

**Failure condition:** if filter/sort must re-run on every keystroke against the full 70k set on main thread, that's the actual jank source to watch for in testing — not initial ingest.

Sources: [MDN Background Tasks API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Tasks_API), [Firefox perf best practices](https://firefox-source-docs.mozilla.org/performance/bestpractices.html)

## 5. HTTP Range support

Correct minimal impl needs: `206` status, `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes` on plain GET too, `If-Range` (validator-conditional partial fetch), suffix ranges (`bytes=-500`), open-ended (`bytes=500-`). Multi-range (`multipart/byteranges`) is rarely sent by browsers for `<video>` seeking in practice — single-range is what matters for this product; don't over-build multi-range parsing.

| Runtime | Free? |
|---|---|
| Node `http` (raw) | No — must hand-roll Range parsing, 206, Content-Range |
| Express | No built-in for streams/buffers; `express.static`/`res.sendFile` delegate to the `send` package which handles single-range only |
| Hono | Not built-in to `serveStatic` uniformly across adapters — check target adapter (Bun/Node) before relying on it |
| Python `http.server` | No — `SimpleHTTPRequestHandler` does not implement Range by default |
| **Go `net/http.ServeContent`** | **Yes, free** — handles Range including `If-Range`, sets `Content-Range`/`Accept-Ranges`, requires only an `io.ReadSeeker` |
| Rust axum + `tower-http` `ServeFile`/`ServeDir` | Yes, free — full Range incl. `If-Range` |

**Recommendation:** this is a second, independent point in favor of Go for the native binary (§1) — `http.ServeContent` gives correct Range handling for free, eliminating a whole class of video-seek bugs the brainstorm explicitly flags as must-work (2GB file scrub). If staying JS-only despite §1, budget real implementation+test time for Range — do not assume Express/`send` covers `If-Range` correctly without checking the specific version.
**Failure condition:** any hand-rolled Range impl that skips `If-Range` will cause `<video>` to occasionally re-fetch full file after a seek following a byte-range cache validation — silent perf bug, not a crash, easy to ship unnoticed.

Sources: [Go net/http pkg docs](https://pkg.go.dev/net/http) (ServeContent semantics), [cri.dev Node Range guide](https://cri.dev/posts/2025-06-18-how-to-http-range-requests-video-nodejs/)

## 6. Localhost security

**Path traversal:** raw string-prefix checks (`resolved.startsWith(root)`) are a known-broken pattern (`/root` vs `/root-evil` bypass). Correct approach: `fs.realpathSync` both root and requested path (resolves symlinks to actual kernel-level target), then `path.relative(root, target)` must not start with `..` and must not be absolute. This also fixes the **macOS case-insensitivity gotcha**: verified via [CVE-2026-49401](https://advisories.gitlab.com/cargo/deno/CVE-2026-49401/) (Deno permission bypass) — APFS is case-insensitive/Unicode-normalizing by default, so raw byte-level path comparison (`--deny-read=/secrets/x.txt` vs requesting `/SECRETS/X.txt` or NFD-normalized variant) resolves to the same inode but fails a naive string check. `realpath` returns the canonical on-disk casing, so comparing post-realpath is the fix — comparing pre-realpath strings is the vulnerability class Deno shipped.

**DNS rebinding:** verified real and actively exploited against localhost dev servers — Vite shipped [GHSA-vg6x-rcgg-rjx6](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6) (any website could rebind DNS, send requests to Vite's dev server, and read the response, because Host header wasn't validated) and fixed it by adding `server.allowedHosts` + Host header validation (see [fix commit](https://github.com/vitejs/vite/commit/bd896fb5f312fc0ff1730166d1d142fc0d34ba6d)). webpack-dev-server had the identical CVE class. Attack: attacker page has victim browser resolve `evil.com` to `127.0.0.1` (via short-TTL DNS rebinding), then JS on `evil.com` origin fetches `http://evil.com:<gal-port>/...` — same-origin policy checks hostname not IP, so the request goes through as same-origin to `gal`, and file paths served by `gal` (arbitrary filesystem, per brainstorm) are exfiltrable.

**Recommendation:** random port + no token is NOT sufficient by itself — it stops trivial `http://localhost:known-port` guessing from a malicious page's `<img>`/`fetch` but does nothing against DNS rebinding once the attacker discovers or brute-forces the port (ports are enumerable via timing/img-onerror probing across the ephemeral range, this is a documented technique). Must add: reject any request whose `Host` header is not exactly `127.0.0.1:<port>` or `localhost:<port>` (reject wildcard/other hostnames outright, matching Vite's fix pattern). This is cheap (one middleware check) and closes the real gap; keep random port too (defense in depth against blind guessing) but don't rely on it alone.
**Failure condition:** skipping Host validation "because it's just localhost" is exactly the assumption Vite's and webpack-dev-server's CVEs broke — this is not theoretical for this product, since `gal` explicitly serves arbitrary filesystem paths (the brainstorm's own stated threat surface).

Sources: [Vite advisory GHSA-vg6x-rcgg-rjx6](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6), [Vite fix commit](https://github.com/vitejs/vite/commit/bd896fb5f312fc0ff1730166d1d142fc0d34ba6d), [webpack-dev-server writeup](https://medium.com/webpack/webpack-dev-server-middleware-security-issues-1489d950874a), [Deno CVE-2026-49401](https://advisories.gitlab.com/cargo/deno/CVE-2026-49401/), [nccgroup DNS rebinding wiki](https://github.com/nccgroup/singularity/wiki/Preventing-DNS-Rebinding-Attacks)

## Limitations

Did not benchmark actual npx cold-download time for a real gal-sized package (no published package exists yet) — figures cited are from comparable-scale tooling, not measured on this exact artifact. Did not test Hono's Range support per-adapter directly (docs are ambiguous across Bun/Node targets) — verify empirically before committing to Hono if JS path chosen. Did not evaluate Bun/Deno compile binary size numbers precisely — flagged as "tens of MB" qualitatively from general knowledge, not measured.

## Unresolved questions
- Does the team accept the npm-shim + native-Go-binary distribution model, or is a pure-JS stack preferred for team skill/maintenance reasons despite the Range-support and perf costs in §1/§5?
- Is a first-run ffmpeg download (network-dependent) acceptable given the "no install ceremony" promise, or should system-ffmpeg-required-with-clear-error be the v1 fallback instead?

Status: DONE
Summary: Recommend npm-shim-wrapping-native-Go-binary distribution (esbuild/swc pattern), lazy-downloaded LGPL decode-only ffmpeg, NDJSON+fetch+ReadableStream transport (not SSE/WS), Worker only for sort/group not parse, Go's net/http.ServeContent for free correct Range support, and mandatory Host-header validation (DNS rebinding is a verified real CVE class against exactly this threat model, random port alone is insufficient).
Concerns/Blockers: Two unresolved questions above need user/team decision before `/ak:plan` locks the stack.
