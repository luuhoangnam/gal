# Research — Virtualized justified grid, 70k items, late dimensions

Status input: brainstorm contract at `plans/reports/brainstorm-260814-1718-gal-media-gallery.md`, accepted. This answers `/ak:research` handoff item on grid/lightbox tech.

## 1. Google Photos / justified-row algorithm (actual math)

Source: [Vjeux - Image Layout Algorithm for Google+](https://blog.vjeux.com/2012/image/image-layout-algorithm-google-plus.html), [Flickr justified-layout](https://github.com/flickr/justified-layout), [Google Design - Building Google Photos Web UI](https://medium.com/google-design/google-photos-45b714dfbed1).

Row-fill / "shrink-to-fit" algorithm, same idea in all 3 sources:
1. Set `targetRowHeight` (e.g. 200px).
2. Walk items left to right, accumulate `sumAspectRatio = Σ(width_i/height_i)` for the row.
3. Row's actual height `H = containerWidth / sumAspectRatio` (this is the closed-form: if every image in the row is scaled to the same height H, total row width = H·Σ(ar_i); solve H so total width = containerWidth).
4. Each image in row gets `width_i = H * ar_i`, `height_i = H`.
5. Keep adding images to the current row while `H` stays above/near `targetRowHeight`; once adding the next image would push `H` below `targetRowHeight - tolerance`, close the row (this is what Flickr's `targetRowHeightTolerance` config controls — how far actual H can stray from target).
6. Last row (widowed row, not enough items to fill width): Flickr's lib exposes `widowCount` and by default lets the last row be under-filled at target height rather than stretched — matches Google Photos behavior of an uneven last row.
7. Algorithm is O(n) single pass, pure function of aspect ratios + containerWidth — no DOM measurement needed for layout math itself, only aspect ratio must be known.

Flickr open-sourced exactly this as `justified-layout` npm package (config: `targetRowHeight`, `targetRowHeightTolerance`, `containerWidth`, `containerPadding`, `boxSpacing`, `fullWidthBreakoutRowCadence` for hero rows). It's a pure layout calculator — takes `aspectRatio[]` in, returns `{top,left,width,height}[]` out. It does **not** virtualize or render; you pair it with your own windowing. This is the correct primitive to use — do not reimplement the row-fill math, consume `justified-layout` directly since ffmpeg/EXIF pass already gives width/height per item.

Reimplementations found: `react-justified-layout` (wrapper), `use-justified-layout` (hook), `react-grid-gallery`, `react-photo-gallery` — all thin wrappers around the same Flickr algorithm, none add virtualization.

## 2. Library survey — variable rows + sticky headers + dynamic measurement + late-data scroll-anchor

| Lib | Variable row height | Sticky group headers | Dynamic/late measurement | Verdict at 70k |
|---|---|---|---|---|
| **react-window** (`bvaughn`) | `VariableSizeList` yes, but height must be known upfront per index — re-measuring after render requires manual `resetAfterIndex` + forces full re-layout below that index | Manual (render header rows inline) | Poor — no built-in remeasure-on-resize; DOM node/memory leak with `DynamicSizeList` reported: [issue #433](https://github.com/bvaughn/react-window/issues/433) grows from 2000 to ~9000 detached nodes; [issue #800](https://github.com/bvaughn/react-window/issues/800) "so many detached nodes added, memory became huge" | Breaks: memory leak documented at exactly your 2000-DOM-node budget |
| **TanStack Virtual** | Yes via `measureElement` (post-render ResizeObserver-backed) | Manual (`sticky` CSS on rendered header items + range-aware positioning) — [docs example](https://tanstack.com/virtual/v3/docs/framework/react/examples/sticky) | Best of the row-based libs: `measureElement` re-measures after real DOM paint, virtualizer recalculates offsets | Real reported lag with dynamic heights: [issue #832](https://github.com/TanStack/virtual/issues/832) — stutter when item height changes are grouped/frequent. No confirmed fix; workaround was to avoid separate variable-height sub-rows. Usable for justified-row mode (row is the unit, row height known once row is computed) but risk is real-time remeasure under heavy scroll |
| **react-virtuoso** | Yes, auto-measures without config | `GroupedVirtuoso` built-in sticky headers, is the strongest built-in story here | Handles append/prepend well (`firstItemIndex` API exists specifically for prepending without scroll jump) | Does NOT have first-class justified-row support; has a masonry addon (`@virtuoso.dev/masonry`) but masonry ≠ justified rows (masonry = column-packed, no aspect-preserving row-fill). Would need heavy customization to do justified mode inside Virtuoso's row model |
| **virtua** | Yes, "dynamic size measurement, scroll position adjustment... imperative scrolling" explicitly in scope ([github.com/inokawa/virtua](https://github.com/inokawa/virtua)) | Not built-in, DIY via sticky CSS | Explicitly designed for exactly this problem class per README | Smallest (~3kB), newest, smallest community — adoption risk (see §6) |
| **justified-layout (Flickr)** | N/A — pure math, not a virtualizer | N/A | N/A | Use as layout engine, pair with your own windowing (see §3) |
| **PhotoSwipe** | N/A — lightbox only, not a grid | N/A | N/A | Not a grid solution, see §5 |
| **photo-album (react-photo-album)** | Has justified/masonry/rows layouts built-in, wraps react-window internally for the virtual variant | Manual | Same underlying react-window issues apply to its `RowsPhotoAlbum`/virtual variants | Good API ergonomics, inherits react-window's ceiling problems if you pick the virtualized variant |

None of react-window/TanStack/Virtuoso/virtua ship "justified-row layout + sticky date headers + dynamic remeasure + scroll-anchor-safe late data" as one integrated feature. All require gluing `justified-layout`'s row math into a windowing lib yourself. This is the actual hard problem, not a library gap you can solve by picking the "right" package.

## 3. Hand-rolled windowing — viable, and probably the right call

Given: no library owns the full requirement set, and the row-fill math is already a 300-line solved algorithm (`justified-layout`), hand-rolling the virtualization layer is not exotic — it's gluing two well-understood pieces:

- **Layout math**: `justified-layout` (or a masonry/square variant of the same row-accumulator idea) run incrementally as new dimensions stream in from Pha B.
- **Windowing**: maintain a sorted array of row `{top, height, items[]}`, binary-search `scrollTop` against cumulative `top` to find visible range, render only rows overlapping viewport ± overscan, absolute-position each row (`transform: translateY`), `content-visibility: auto` + `contain: strict` on offscreen rows for paint/layout containment.
- **Sticky headers**: date-section header is just another "row" type in the same array; sticky via `position: sticky; top: 0` on the header row within a per-section wrapper — same technique GitHub/Linear timelines use, no library needed.

Rough size: 400-700 lines TS for the windowing core (measure, binary search range, render window, resize/late-data patch, scroll-anchor compensation) + `justified-layout` as dependency (don't reimplement) + ~150 lines for the square/masonry mode variants. This is comparable to or smaller than wiring TanStack Virtual's `measureElement` + custom sticky logic + a justified-layout bridge, and it avoids the two documented failure modes above (react-window leak, TanStack stutter) because you control exactly what triggers a re-layout.

**Where hand-rolled breaks**: scroll-to-index / scroll restoration on reload, RTL, accessibility (focus management, screen-reader row announcements), and edge cases (zero-height rows, huge aspect ratio outliers) — all things libraries have already hardened over years. Budget real QA time for these; they're the "boring 80%" that makes libraries worth their weight normally.

## 4. Scroll-anchor preservation on late dimensions — the core mechanism

Sources: [MDN overflow-anchor](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor), [MDN scroll anchoring overview](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll_anchoring/Scroll_anchoring).

- **`overflow-anchor: auto`** (default in Chromium/Firefox): browser auto-picks a DOM node near top of viewport as anchor and adjusts `scrollTop` when layout shifts *above* the anchor. Works natively for normal reflow (e.g., image `<img>` tags without explicit dimensions loading in). **Does not cover Safari** (no support, confirmed both desktop/iOS per MDN and [testmuai support table](https://www.testmuai.com/learning-hub/css-overflow-anchor-browser-support/)) — a hard blocker since Gal is likely used cross-browser and can't assume Chromium-only.
- Because Safari has zero support, and because in a virtualized/absolute-positioned grid the "content shift" isn't a native DOM reflow (you're repositioning items via `transform`, which native scroll anchoring doesn't observe the same way), **native `overflow-anchor` is not sufficient alone** — must implement manual compensation regardless.
- **Manual scrollTop compensation pattern** (used by chat apps, virtua, and Virtuoso internally): before applying a late-arriving dimension patch, compute `deltaHeight = newRowsTotalHeightAboveViewport - oldRowsTotalHeightAboveViewport`. If any row **above** the current scroll position changed height, immediately add `deltaHeight` to `scrollTop` in the same tick (before paint) so the visual position of content the user is looking at doesn't move. Only rows above viewport matter; rows below or in current viewport can re-layout freely (user sees it happen, not a jump — acceptable, and actually expected UX like a lazy-loading list).
- **ResizeObserver**: used to detect the *actual* rendered size of a row after content paints (needed because thumbnail aspect ratio might differ slightly from EXIF-reported aspect ratio, or fonts/zoom affect layout) — this is what TanStack's `measureElement` and virtua's dynamic sizing both wrap. For Gal: since Pha B delivers width/height explicitly (no unknown-until-render text reflow), you mostly need **direct patch application + manual scrollTop math**, not ResizeObserver-driven remeasurement — this is simpler than the general case libraries solve, use ResizeObserver only as a fallback/safety net for thumbnail load mismatches.
- **Practical rule for Gal**: since layout is entirely data-driven (row heights computed from `justified-layout` output, not measured from DOM), you always know old-height vs new-height before repaint — do the scrollTop delta compensation synchronously in the same event/microtask that applies the Pha B patch, never rely on `overflow-anchor` as primary mechanism (Safari gap) — treat it as free defense-in-depth only.

## 5. PhotoSwipe v5 vs custom lightbox

Source: [photoswipe.com/methods](https://photoswipe.com/methods/), [photoswipe.com/options](https://photoswipe.com/options/), [PhotoSwipe GitHub issues #1210, #904](https://github.com/dimsemenov/PhotoSwipe/issues/1210).

- PhotoSwipe v5's `preload` option: "parses and renders only nearby slides based on the preload option (but not less than 2 nearby)" — matches contract's ±2 preload requirement out of the box, no custom code needed.
- Has `zoomTo()`, pan, and native gesture handling already hardened across years of production use (used by huge % of photography sites) — reinventing zoom+pan physics (rubber-banding, double-tap-zoom, pinch) is significant surface area to hand-roll and get right; PhotoSwipe is the pragmatic choice here specifically, unlike the grid.
- Gap vs contract: PhotoSwipe does not itself call `img.decode()` and gate the swap — need to verify the exact swap-timing in v5 source to guarantee zero white flash; issues #1210/#904 show community requests around preload timing, meaning stock behavior needs a thin custom layer (a `contentLoad`/`contentAppend` hook wrapping `decode()` before swap) — small glue code, not full lightbox rewrite.
- Video native `<video>` + Range seeking: PhotoSwipe doesn't manage video natively out of the box (built for images); Gal needs a custom "video slide" content type registered via PhotoSwipe's plugin API (`contentType` extension point exists in v5) — moderate custom work, same amount regardless of lightbox choice since no lightbox lib handles 2GB seekable video well.
- **Recommendation**: PhotoSwipe v5 core + custom content-type plugin for video + thin `decode()`-gate wrapper. Do not hand-roll zoom/pan — that's the one place a mature library clearly wins on adoption risk (battle-tested gesture math) vs the grid (where no library fits your exact combination anyway).

## 6. Evidence of 70k ceiling — concrete breakage found

- react-window `DynamicSizeList`: documented memory leak from detached DOM nodes growing "from around 2000 DOM nodes and increasing to ~9000" during scroll ([issue #433](https://github.com/bvaughn/react-window/issues/433)) — directly violates your <2000 DOM node hard constraint; separately [issue #800](https://github.com/bvaughn/react-window/issues/800) reports same class of leak at only 1000 items.
- TanStack Virtual: [issue #832](https://github.com/TanStack/virtual/issues/832) — real stutter reported with grouped variable-height rows, open/unresolved as of last check, workaround was avoiding the variable-height feature that Gal specifically needs (mixed row heights from justified layout).
- No public benchmark found (via search) of any of these libs run at 70k *image grid* items specifically with continuous background dimension patching — this exact workload (streaming dimension arrival + justified layout + 70k) appears to have no precedent benchmark in open source; the two issues above are the closest real evidence and both point at the dynamic-height code paths as the weak point, which is precisely Gal's hardest requirement. This is a genuine engineering-risk area, not a solved-elsewhere problem — budget a spike/prototype before committing.

## 7. Recommendation (ranked)

1. **Grid**: Hand-rolled row-based virtualizer (§3) using `flickr/justified-layout` as the pure-math engine for justified mode, plus your own equivalent row-accumulator for square/masonry (masonry: standard column-height-balancing algorithm, well known, O(n log columns) with a min-heap). Reason: this is the only option that avoids both documented failure classes (react-window leak, TanStack stutter) because late-dimension patching and scroll-anchor math are fully first-party code, not fighting a library's internal remeasure cycle. Switching modes = recompute row-array from the same underlying item list + same scrollTop-anchor compensation, no reload.
2. **Fallback if hand-rolled proves too costly in the plan phase**: TanStack Virtual + `measureElement`, accept the stutter risk from #832 and mitigate by keeping justified-row as a single virtualized unit (row, not per-image) — this avoids the exact trigger in #832 (frequent per-sub-item height changes). Do not use react-window (leak is a hard blocker against your DOM-node budget) or GroupedVirtuoso (no justified-row primitive, would fight the library more than help).
3. **Lightbox**: PhotoSwipe v5 core, custom video content-type plugin, thin `decode()`-gate wrapper for guaranteed zero-flash swap. Ranked #1 outright — no real alternative reduces total engineering risk given zoom/pan is already solved there.
4. **Sticky headers**: implement as first-class row-type in your own row array (works identically for all 3 grid modes and both grid approaches above) — do not depend on library-specific "group" features that don't compose with justified-row math.
5. **Scroll-anchor**: manual scrollTop delta compensation as primary (§4), `overflow-anchor: auto` left on as free Chromium/Firefox defense-in-depth, never rely on it as sole mechanism (Safari has zero support).

## Adoption risk notes
- `justified-layout`: Flickr-authored, MIT, stable since 2016, low API surface, low risk, but appears lightly maintained (check recent commit activity before pinning — not verified in this pass).
- `virtua`: newest/smallest community of the 4 libs surveyed, explicitly designed for this exact problem class per its own README, but unproven at your specific 70k+justified+late-data combination — worth a timeboxed spike but not the default recommendation given hand-rolled avoids the same integration risk with more control.
- PhotoSwipe v5: mature (originally 2011, v5 rewrite ~2021), large install base, low abandonment risk.

## Limitations / not covered
- No hands-on benchmark run in this pass (advisory-only, no code executed) — the 70k+dynamic-height combination has no known public benchmark; treat §6 as risk signal, not proof of failure or success. Recommend a throwaway prototype (justified-layout + hand-rolled windowing, 5k synthetic items with staggered dimension arrival) before locking the plan.
- Masonry-mode algorithm details (column-height balancing) not researched in depth — standard technique, low risk, omitted for space.
- Did not verify `justified-layout` npm package's current maintenance status/last-publish date.
- Did not verify PhotoSwipe v5's exact internal slide-swap timing against `decode()` from source code — flagged as needing confirmation during implementation, not blocking the architecture decision.

## Unresolved questions
- Does Gal need RTL / accessibility screen-reader support for the grid in v1? Affects hand-rolled vs library trade-off (libraries have more of this hardened).
- Confirm `justified-layout` package activity/maintenance before pinning as a dependency.

Status: DONE
Summary: Justified-row math is Flickr's solved O(n) row-fill algorithm (`justified-layout` npm, MIT); no existing virtualization library (react-window, TanStack Virtual, react-virtuoso, virtua) supports the full combination of justified rows + sticky date headers + late-arriving dimensions + scroll-anchor safety at 70k, and react-window/TanStack both have documented breakage in the closest analogous scenarios — recommend hand-rolled row-based windowing using `justified-layout` as the math engine plus manual scrollTop-delta compensation for late data, and PhotoSwipe v5 (with a thin decode-gate wrapper + custom video content-type) for the lightbox.
Concerns/Blockers: No public benchmark exists for this exact workload (70k + streaming dimensions + justified layout) — recommend a timeboxed prototype spike before the plan phase locks the architecture.
