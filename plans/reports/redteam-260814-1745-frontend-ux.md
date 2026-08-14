# Red-team — frontend/UX (phases 5-8)

Advisory only. No project file modified. Empirical runs: Playwright 1.62.1, Chromium 1234 + WebKit 26.5
(= Safari 26.5 engine), 1512×900, real ffmpeg-generated JPEG thumbs (320×240, 43KB avg — conservative vs
real ~25KB), RSS measured per process via `ps`. Scripts in session scratchpad.

## Verdict

Two blockers, both verified by measurement, not argument:
`requestIdleCallback` does not exist in Safari 26.5 (ingest crashes), and the 500MB budget is
missed under the plan's own mitigations — which measure as ~3% effective.

---

## CRITICAL — will definitely break

### C1. `requestIdleCallback` is undefined in Safari 26.5 → zero images on the default macOS browser
Phase 5 step 4: "áp patch theo lô 500-1000 trong `requestIdleCallback`". Measured in WebKit 26.5:
`typeof requestIdleCallback === "undefined"`. caniuse confirms: disabled by default through Safari 26.5/27.
`gal` opens the *default* browser; on stock macOS that is Safari. Phase B patches throw
`ReferenceError` inside the NDJSON reader → the stream loop dies silently → grid stays at phase-A
placeholders forever. No error state in the 9 states covers "our own ingest threw".
Fix: `const idle = window.requestIdleCallback ?? (cb => setTimeout(() => cb({timeRemaining:()=>5}), 0))`,
plus a `try/catch` around the reader loop that surfaces a real error state.
Also verified fine in WebKit 26.5: `TextDecoderStream`, `Response.body` streaming, `content-visibility:auto`,
`contain:strict`, `img.decode()`, `loading=lazy`, `scrollend`. `performance.memory` is **absent** — so any
in-page RAM assertion in tests is Chromium-only.

### C2. RAM: 500MB is missed, and every mitigation the plan lists is ineffective
Chromium renderer RSS, 4000 unique real JPEGs, scrolled end-to-end:

| Scenario | tiles / DOM nodes | renderer peak | Δ over blank tab |
|---|---|---|---|
| A plan design: overscan 380px, `src` dropped, lazy | 77 / 162 | 544 MB | 394 MB |
| B same but `src` **kept** in pool | 77 / 162 | 552 MB | 406 MB |
| C overscan 6000px | 518 / 1044 | 554 MB | 405 MB |
| D overscan 15000px | 1232 / **2472** | 588 MB | 440 MB |
| E fast scroll (momentum-like) | 77 / 162 | 502 MB | 360 MB |
| F `loading=lazy` removed | 77 / 162 | 542 MB | 392 MB |

**A vs B = 12MB (3%).** Dropping `src` does essentially nothing. `loading=lazy` does nothing (A vs F).
16× more live tiles costs 44MB (A vs D). The plan's model — "2000 nodes × 300KB = 600MB" — is wrong in
both directions: the window is ~77 tiles, not 2000, and memory is **not** a function of the window at all.
It is Chrome's per-resource image cache, keyed by URL, retained after the `<img>` releases it.

Growth vs images *ever scrolled past* (30k unique URLs, plan design):
2.5k→425MB, 5k→536, 7.5k→574, 10k→582, 20k→623, **30k→658MB renderer**; 4s idle does not release it.
Saturates ~7.5k images then creeps ~+3MB/1k. WebKit 26.5, same workload, 10k images: 344MB blank →
**757MB total browser** (+413MB). Both engines land ~400MB above an empty tab.

So: "RAM tab <500MB" **fails** if read as renderer footprint (580-660MB), and only barely passes as
delta-over-blank. Decide which one the criterion means before Phase 5 starts — right now it is unfalsifiable.

The only lever that actually moves: pixel count. 160×120 thumbs, same run, 10k images → **422MB renderer**
vs 582MB. But 320px is *already* sub-Retina for a 190px-tall tile at DPR 2 (wants 380px). The plan's
fallback ladder ("giảm xuống 256px") buys ~50-70MB by interpolation and makes thumbs visibly softer on the
target hardware. The `<canvas>` last resort in the risk section is the only thing that actually caps this,
and it is budgeted at zero days.
Recommendation: state the budget as renderer footprint, raise it to ~700MB with the measurement above as
evidence, or accept 256px and say so explicitly as a quality trade. Do not ship the current
mitigation ladder as if it works — it is measured not to.

### C3. DOM pool recycling silently breaks focus, `alt`, and lightbox focus return
Phase 5 uses an index-keyed pool (`pool[k]` reassigned per render — same as the wireframe, `index.html:359-389`).
Phase 8 requires "giữ ô đang focus trong DOM dù ra ngoài viewport". These are incompatible: after two
renders, the node holding focus is reused for a *different* photo. No exception, no test failure — VoiceOver
just reads the wrong filename, and arrow-key navigation drifts. Same defect in Phase 6 step 5
("lưu element vừa mở, `focus()` lại khi đóng"): on close after scrolling, that element is now another photo,
so focus returns to the wrong image while the success criterion "focus trở lại đúng thumbnail" appears to pass.
Fix: pool keyed by item id, not slot index; one pinned out-of-pool node for the focused item; refocus on
close by id (scroll-to-index → render → focus), never by saved element reference.

---

## HIGH — will break under stated requirements

### H1. Anchor by "fixed id" contradicts the same phase's data structure
Phase 5 §Cấu trúc dữ liệu: "`placed[]` song song thứ tự với `view[]` → neo bằng **chỉ số**, không cần map id."
Phase 5 §Neo scroll: "chốt ô neo theo **`id`**". Both cannot hold. And index-anchoring is definitely wrong
here: sort is by EXIF capture date, which *arrives during phase B* — so `view[]` reorders continuously while
anchoring is active. An index anchor points at a different photo after every patch, which is exactly the
spike's 187px drift bug, reintroduced. Needs `Map<id,index>`, rebuilt per patch (70k entries ≈ few ms, fine).

### H2. "Hold until the user scrolls" is not implementable from `scroll` events
Measured: assigning `scrollTop` fires a `scroll` event in both Chromium and WebKit (1 event, indistinguishable
from user input). If anchor re-selection is triggered by `scroll`, every compensation re-picks the anchor →
the 2.7px/patch accumulation returns. Use intent events (`wheel`, `keydown`, `touchstart`, scrollbar
`pointerdown`) as the re-pick trigger, or a suppression flag comparing observed vs expected `scrollTop`.
This must be specified in the plan; "until the user scrolls" reads as done but is the actual bug surface.

### H3. Anchor lifecycle holes not covered
- **Anchor filtered out mid-scan** (Phase 7 filters run during Phase B): id no longer in `view[]` → delta
  undefined. Need re-pick + reset of the pre-patch Y snapshot.
- **Anchor's own dimensions arrive**: its height changes, so compensating on the *item's* top keeps the item
  pinned while it visibly resizes under the cursor. Anchor on the *row top*, and prefer an anchor whose
  dimensions are already known — those are stable by construction.
- **Layout mode / density / window resize mid-patch**: the old-Y snapshot was taken in the old layout;
  applying that delta after a mode switch injects garbage. Invalidate on every layout-parameter change.
- **Momentum**: compensating `scrollTop` during an inertial fling on macOS fights the platform scroller
  (cancel or visible stutter). Queue patches while a fling is in flight. Not addressed anywhere.
None of these appear in Phase 5's steps or success criteria; drift is only tested at 15/50/85% with no
filtering, no mode switch, and synthetic scroll.

### H4. ARIA `grid` is the wrong pattern for a justified layout
Phase 8's stated fix ("lưới là composite widget, một tab stop, pattern `grid` của ARIA") does not survive
contact with justified rows: rows contain *different numbers of cells* (5, 6, 4…), while `role=grid`
assumes a rectangular matrix. Screen readers will announce jumping column indices. Also missing entirely:
`aria-rowcount`/`aria-colcount` on the container and `aria-rowindex`/`aria-colindex` on rendered cells —
without them VoiceOver announces "row 3 of 3" for a 70k library, and there is no criterion catching it.
Recommend `role="listbox"` + `aria-setsize="70000"` + `aria-posinset` per cell (correct for a 1-D selectable
collection with a 2-D visual arrangement), roving tabindex, arrow keys mapped by geometry. Note VO's
"jump to end" cannot reach virtualized items in any pattern — handle `End` in JS.

### H5. Total-height instability vs the scrubber (Phase 7)
Unknown-aspect items are placed as 1:1; real photos average ~4:3, so total height shrinks materially as
Phase B lands. The Phase 7 scrubber maps year → fraction of `totalH`. During scanning the mapping moves
under the user's finger, and a drag lands in the wrong year. Not mentioned in either phase. Fix: drive the
scrubber from item-index → year boundaries, not from pixel fractions.

### H6. PhotoSwipe: the `decode()` snippet in Phase 6 is a no-op, and the real fix is `msrc`
The code sets `content.__ready = img.decode()...` and nothing ever awaits it. Gating a v5 swap requires
`e.preventDefault()` in `contentLoad`, building the element yourself, then `content.onLoaded()` — a
different shape from what is written. Separately, the *actual* zero-white-flash mechanism in PhotoSwipe v5
is `msrc` (the grid thumbnail as an immediate placeholder), which the plan never mentions; with `msrc` the
user sees the thumbnail, never white, even before decode. Do that first; keep the decode gate only if
measurement still shows a flash.
Also missing: `contentDeactivate` to pause video on slide change → audio keeps playing after ←/→, and
disabling PhotoSwipe's click-to-zoom/pointer capture over `<video>` or the native controls are unusable.

### H7. Hand-rolled FLIP fights PhotoSwipe's own opening animation
PhotoSwipe v5 already animates from thumbnail bounds (`thumbBounds` / `getThumbBoundsFn`), and already
falls back to fade when bounds are null — which *is* the "source tile virtualized away" case Phase 6 step 4
budgets custom work for. Porting the spike's standalone FLIP on top means two transitions competing.
Use PhotoSwipe's bounds hook; this removes work rather than adding it.

---

## MEDIUM

- **M1. Factual error in the evidence table.** "`overflow-anchor`: Safari không hỗ trợ (cả desktop lẫn iOS)."
  Measured in WebKit 26.5: `CSS.supports('overflow-anchor','auto')` true **and** behaviorally correct —
  inserting 500px above a scrolled container compensated +501px, identical to Chromium. The *conclusion*
  (manual compensation required) still holds, but for the other reason the plan already gives: native
  anchoring doesn't observe `transform`-based repositioning. Fix the citation, keep the decision.
- **M2. Extreme aspect ratios are in the risk section only** — not in steps, not in success criteria, and
  not in `test/layouts.test.js`. A single 10:1 panorama forces `H = W/10` for its row; a 1:8 receipt scan
  inverts it. Clamp `ar` to ~[0.3, 3.0] in the layout function and unit-test both extremes.
- **M3. Scroll restoration on reload is missing everywhere.** Research named it as a "boring 80%" item;
  Phase 7 restores *filters* via URL hash but not position, and no phase owns it. Restoring position while
  Phase B is still streaming is the hard version of the anchor problem.
- **M4. Selection model is unspecified.** Phase 7's Esc hierarchy includes "bỏ chọn", Phase 8's focus work
  implies a selected cell, but no phase defines selection UI, multi-select, or what selection is *for*.
  Either cut it from the Esc chain or give it an owner.
- **M5. `Space` opens/plays** but also scrolls the page by default — needs `preventDefault`, and it
  collides with "Space = select" muscle memory from Google Photos.

## LOW / correct-as-is

- Dropping `justified-layout` (2022-06-19) for 15 lines of closed-form math: correct, evidenced, move on.
- PhotoSwipe for zoom/pan physics instead of hand-rolling: correct.
- Worker gated behind "measure first, delete if sort <50ms on main": correct instinct, keep it honest.
- Last-row-at-target-height instead of stretching: correct, matches Google Photos.

## Estimates — not honest

| Phase | Planned | Realistic | Why |
|---|---|---|---|
| 5 | 2.5d | **4.5-5d** | 3 layout algos + pool + sticky + NDJSON ingest + anchor correctness (H1-H3) + density + stagger + priority + RAM investigation (C2 alone is a day) + drift regression harness |
| 6 | 1.5d | 2-2.5d | v5 lifecycle spelunking, video content type + activate/deactivate + pointer conflicts, 2GB Range verification |
| 7 | 1.5d | **3d** | 4 combinable filters + 3 sorts + 4 groupings + worker + scrubber + full keymap + help sheet + URL hash + empty states ≈ 9 features |
| 8 | 1.5d | 2.5-3d | 9 states + focus/pool rework (C3) + ARIA rework (H4) + manual VoiceOver + contrast + 200% zoom |
| **FE total** | **7d** | **~12-13d** | |

## Recommended order

1. Fix C1 (one line + a `try/catch`) — otherwise the app is blank on the default macOS browser.
2. Resolve C2 before writing `grid.js`: define what "RAM tab" means, re-measure, then pick 320px + higher
   budget *or* 256px + stated quality trade. Delete the mitigation ladder that measures at 3%.
3. Reconcile H1's contradiction and write down the H2 intent-event mechanism *in the plan* before coding.
4. Move C3 (id-keyed pool) into Phase 5 — it is a core data-structure decision, not Phase 8 polish.
5. Re-pattern the grid a11y (H4) before Phase 8 estimates are locked.

## Unresolved questions

1. Is "RAM tab <500MB" renderer footprint, or delta over a blank tab? The criterion is currently unfalsifiable.
2. Is Safari a supported target, or does `gal` force-open Chrome? Phases 5-7 test in neither explicitly.
3. Is selection (multi-select) in v1 scope? Two phases assume it, none specifies it.
4. Retina: is 320px accepted as sub-DPR-2 sharpness, or does the budget give way?

Status: DONE_WITH_CONCERNS
Summary: Two verified blockers — `requestIdleCallback` is absent in Safari 26.5 (kills NDJSON ingest on the
default macOS browser), and the 500MB RAM budget is missed at 580-660MB renderer while every mitigation the
plan lists measures at ~3% effect; plus a self-contradicting scroll-anchor spec and a pool design that
silently breaks focus and a11y.
Concerns/Blockers: Frontend estimate is ~7d against a realistic ~12-13d; RAM budget semantics must be
defined and re-measured before Phase 5 begins.
