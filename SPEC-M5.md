# SPEC-M5 — The lean-frame facade (DOM snapshot, not pixel snapshot)

Status: v3 — **LEAN-PRIMARY SHIPPED** (2026-08-15, dev path). The motion-cover model (slice 1) was
reworked: dogfooding proved a cross-document cover↔live swap on every pan/zoom shifts text ~1-2px
(jiggle) and flashes mermaid/theme, because two documents never render pixel-identically. So the lean
DOM is now the PRIMARY visible layer for a passive frame (rest + motion); live shows only when
interacted / in laser+comment / while a fresh lean is building. No per-gesture swap = no jiggle.
Codex-designed + reviewed (commit 89bd53a). F3 ("seamless swap") is retired — the invariant is now
STABLE PRIMARY RENDERING with intentional, bounded focus transitions. Below, "cover shown during
motion" is superseded by "lean shown always except when live-required"; §5 slice-2 residency is moot
(all frames stay live-mounted underneath for instant focus). Supersedes SPEC-M4 Stage 2 (raster facade)
and folds in Stages 3–4. Rewrote v1 after the de-risk prototype (`/__mv/proto/`, dd74297) + two Codex
reviews (architecture 12×P1, then code review). Slice 1 replaces the raster `<img>` facade with the
DOM-snapshot lean `<iframe>` (commits c89aa3e + f78d8a8, both Codex-reviewed): fidelity fixed, all 43
pilot frames serialise clean, perf gate held, no feature regressions (real-canvas verified). Slice 2
(bounded live residency) is the next, optional increment (perf gate already met). Open items in §12.

---

## 0. Why this pivot

The M4 raster facade (html-to-image → cached `<img>` shown during motion) met the p95 perf gate but
failed the thing a design canvas cannot fail: **fidelity**. Three dogfooding symptoms, one root cause
— a raster is a resolution- and width-locked bitmap:

| Symptom | Root cause | Why a raster can never fix it |
|---|---|---|
| Text color "invented" vs live | html-to-image serializes DOM→SVG→canvas; gamma / profile drift + missed computed styles | A rasteriser re-samples color. No faithful-color mode. |
| Text reflows / jiggles on swap | Snapshot baked at capture width W1, live frame now at W2 | A bitmap cannot reflow. |
| Device sweep (phone→tablet→laptop) wrong | Each device is a different *layout*, not a scaled bitmap | Stretching a phone shot to tablet width is a stretched bitmap. |

**Thesis (one line):** cache a **DOM snapshot** — a self-contained static HTML doc (post-render DOM
+ full inlined CSS, JS stripped) rendered in a `sandbox="allow-same-origin"` (no `allow-scripts`)
`<iframe srcdoc>`. It reflows / theme-flips / device-sweeps with the browser's own layout engine and
the app's own stylesheet, so color is identical and layout is real CSS, while running **zero JS** so
it is cheap at ~30 frames. The live app swaps in on focus for perfect interaction.

## 0.1 What the prototype proved (2026-08-15)

Measured on the pilot via a standalone same-origin harness (live vs lean side-by-side + an N-frame
reflow probe):

- **Fidelity:** live and lean pixel-identical on cart + dashboard frames, light AND dark. Serialiser
  clean (no degradation), ~21 KB html / ~20 KB css per frame.
- **Theme flip:** the shell mutates the lean doc's root `data-theme` attribute directly (allowed by
  `allow-same-origin`); full CSS is already inlined, so only which rules match changes. No re-capture,
  no `srcdoc` reload. (v1 wrongly speced a `srcdoc` rewrite — codex P1, now fixed.)
- **Reflow:** at 1440 px the lean dashboard reflowed stacked→wide columns in lockstep with live.
- **Perf (the load-bearing unknown):** 30 lean docs reflowing *simultaneously* through a phone↔laptop
  sweep = **p95 9.3 ms, max 9.4 ms, 0 dropped, 0 long-tasks** — equal to the M4 raster pan baseline.

**Consequence — the design simplifies to ONE lean tier.** v1 hedged with "raster for pan/zoom,
DOM-snapshot for resize/theme" in case reflow-per-tick was too costly. It is not. Pan/zoom changes no
width, so the lean tier reflows nothing then; resize/sweep reflow cheaply. So the DOM snapshot is the
**single** non-focused representation. html-to-image is retired from the facade and survives only as
the scoped canvas/video subtree fallback (§6.1).

---

## 1. What must not break (inherits M4 §1; adds three)

Everything M4 §1 protects still holds: laser, element-comments, prototype/goto, live-resize, theme
without remount, the iframe-identity law, board single-writer, publish parity. **New invariants:**

- **F1 — Color fidelity.** A lean frame's rendered color for any element equals the live frame's
  computed color (same stylesheet, same tokens; verified by computed-style diff, not eyeball). *Proto: met.*
- **F2 — Reflow fidelity.** Resizing / device-sweeping a lean frame produces the layout the live app
  would at that width (CSS-driven layout; JS-measured layout is the §6.2 exception). *Proto: met.*
- **F3 — Seamless swap.** lean→live and live→lean show no visible jump: both render the identical
  stylesheet at the identical width, pixel-aligned by construction — GATED on a font+paint readiness
  check (§5), not `load` alone (codex P1). *Proto: met for static; readiness gate is new work.*

---

## 2. The model — two tiers, four axes (reuse M4's lifecycle)

M4's four orthogonal axes stay. M5 changes only what the **presentation** axis renders when a frame
is not the live target, and tightens **residency**.

```
  RESIDENCY      live  |  lean  |  cold           (cold = element retained, navigated to a dormancy doc)
  PRESENTATION   app   |  lean-static            (ONE lean representation - the DOM snapshot)
  INTERACTION    focused/interacting | passive
  HEALTH         booting → committed → ready → error   (generation id; unchanged)
```

Two concrete representations of one frame:

- **Lean tier** — a `sandbox="allow-same-origin"` (no `allow-scripts`) `<iframe srcdoc>` holding the
  DOM snapshot. Reflows / theme-flips / device-sweeps natively. Zero JS. The resting representation
  and the motion cover.
- **Live tier** — today's full app iframe (React + JS + data). Perfect laser / comment / prototype /
  interactive behavior. Instantiated for the working set (§5), swapped in on focus.

**Cache key: `frame+revision`.** A DOM snapshot reflows across all widths/themes/dprs, so one
snapshot per revision (vs the raster's per-width/theme entry). NB (codex correction): the current
coordinator already keeps one entry per node, so this is a *fidelity* + *reflow* win, not primarily a
memory win — do not claim a memory saving against an imagined bitmap matrix.

---

## 3. The serializer contract (frame-side; `serialize.ts`)

Runs where the live CSSOM/fonts/rendered DOM exist. Same-origin so it reads `cssRules` directly.
Fail soft: any throw/empty → `sh:snapshot-error`, shell keeps live pixels (unchanged contract).
Prototype `src/client/frame-host/serialize.ts` is the seed; production must add the ⚠ items.

**Capture (in order):**

1. **Clone the rendered DOM** (`documentElement.cloneNode(true)`) — React's committed output.
2. **Inline ALL CSS** — every `document.styleSheets` entry AND `document.adoptedStyleSheets`
   (constructable sheets a clone never carries). Capture the FULL sheet (all media queries, both
   themes). Cross-origin sheets throw on `cssRules` → skip + record `degraded:'cross-origin-css'`
   (codex P1: never silently claim fidelity for them; the shell prefers keeping such a frame live).
3. **⚠ Absolutize `url()` per source sheet** against that sheet's href, and inject `<base href=frameURL>`
   so relative `url()` / `img[src]` / `@font-face` resolve (codex P1). Fonts resolve because the lean
   doc is same-origin (the `allow-same-origin` fix — v1's bare `sandbox=""` gave an opaque origin and
   broke fonts).
4. **Neutralise execution** — strip `<script>`, `<link rel=modulepreload|preload>`, `on*` handlers,
   `javascript:` URLs, and the clone's own `<style>`/`<link rel=stylesheet>` (CSS already collected).
   The no-`allow-scripts` sandbox is the hard guarantee; this is defence in depth.
5. **Preserve authored CSS, not computed geometry** — do not bake `getComputedStyle` widths (would
   freeze layout, defeat F2). JS-written inline widths are the §6.2 caveat, not a serializer job.
6. **Carry the theme signal** — the clone already carries the root `data-theme`/`dark` from bridge.js.
7. **⚠ Shadow DOM** — walk open shadow roots and re-emit as declarative `<template shadowrootmode>`
   with the shadow's own `adoptedStyleSheets` inlined; closed roots are unreachable → record
   `degraded:'shadow-dom'`, prefer live.
8. **⚠ Scroll** — record each scrolled container's offset + a stable selector into a `scrollMap`
   returned alongside the html. The lean doc runs no JS, but the shell is same-origin to it
   (`allow-same-origin`), so the shell restores scroll by setting `leanDoc.querySelector(sel).scrollTop`
   after load (§4). No inline script in the lean doc.

Output: `{ html, scrollMap, degraded[], notes[], cssBytes }`.

## 4. The lean renderer (shell-side; replaces the `<img>` facade)

Facade element changes from `<img class="sh-snapshot">` to `<iframe class="sh-lean" sandbox="allow-same-origin">`,
still driven imperatively by the `snapshots.ts` coordinator (zero React renders per pan tick preserved).

- **Mount:** `sandbox="allow-same-origin"` (NO `allow-scripts`) → no JS runs, and the shell can touch
  `contentDocument`. `srcdoc` = captured html. On load, restore scroll from `scrollMap`.
- **Theme flip:** shell sets `leanDoc.documentElement.dataset.theme` + toggles `dark` — no re-capture,
  no reload (prototype-verified).
- **Device sweep / resize:** change the iframe's CSS width/height; inlined media queries reflow natively.
- **Cover semantics (unchanged from M4):** shown during `sh-camera` (canvas pan/zoom) + `sh-preset`
  (device sweep / tidy), never a bare frame click/drag (`sh-gesturing` only) — the jiggle fix
  (704a225) stays; only the covered element's tag changes.

CSS: `.sh-lean` inherits `.sh-snapshot`'s `position:absolute; inset:0`, minus `object-fit`;
`pointer-events:none` while a cover.

## 5. Residency & the swap protocol (two slices)

**Slice 1 — fidelity, drop-in (residency unchanged).** Lean-static replaces the raster as the motion
cover only. Every frame stays live-mounted as today; the lean iframe covers during `sh-camera`/`sh-preset`
and uncovers on settle. Fixes F1/F2/F3, the color bug, the jiggle, the device sweep — zero residency
change, so zero state-loss risk. Lowest-risk path to "the real canvas looks right." **Nic tests this
on an actual board, not the harness.**

**Slice-1 contract (codex v2 review — these are slice-1 requirements, not slice-2):**
- **Dual iframe roles (THE regression risk).** The node now hosts TWO iframes. The live app iframe
  carries `.sh-live`; the lean cover carries `.sh-lean`. ONLY `.sh-live` enters the WindowProxy
  registry, message routing, comments, laser, goto, resize, and the theme bridge. Every existing
  `iframe` CSS selector and DOM query (styles.css `.sh-node ... iframe`, Comments.tsx, FrameNode
  `iframeRef`) is scoped to `.sh-live`. The lean iframe is `pointer-events:none`, never registered,
  never messaged. Assert `iframeRef.current` and its `contentWindow` are identity-stable before/after
  capture, theme flip, resize, preset, and lean reload.
- **Generation-safe admission (slice 1, not slice 2).** A cover shown during motion must be the RIGHT
  content. The capture carries `{nodeKey, generation, sourceRevision}`; the coordinator admits a
  result only when all three match the in-flight request, and drops a stale cover immediately (a
  frame that renavigated/resized mid-flight must not flash old pixels).
- **Cover suppression = hard admission rule.** No `data-ready`, no cover, keep live pixels, when:
  laser OR comment mode is active (a scriptless cover kills outlines/picking); OR the serializer
  reported ANY degradation (`cross-origin-css`, `canvas`, `video`, `shadow-dom`, `js-layout`, `scroll`
  it could not fully restore). Degraded frame = stays live under motion; correctness beats the flash-guard.
- **Scroll: all-or-nothing.** Restore EVERY mapped native scroller after load (shell mutation). If any
  mapped scroller cannot be restored (virtualised / missing DOM), the frame is degraded → no cover.
- **Shadow DOM.** Open roots serialise (declarative `<template shadowrootmode>`). Closed roots are
  undetectable after the fact, so the bridge instruments `attachShadow` at boot to record a
  closed-root flag; a flagged frame is degraded → no cover.
- **Publish untouched in slice 1.** Capture is already dev-only (`FrameNode.tsx:70`); slice 1 keeps
  the published path exactly as today (live-only, no lean tier). The build-time serializer (§9) is a
  separate follow-up so publish cannot regress.

**Slice 2 — bounded live residency (the scale win).** Lean-static becomes the *resting* representation
for cold frames; a bounded **live pool** (weighted LRU: focused + N most-recently-focused) stays live.
Collapses M4 Stages 3 (working set) + 4 (hibernation) into one mechanism.

- **Iframe-identity (codex P1 fix):** eviction NEVER tears down the iframe element. Per M4's law, the
  stable element is retained and navigated to a dormancy/lean doc; shell-owned `FrameRuntimeState`
  persists. Document state (forms/scroll) may be dropped for frames outside the pool; the pool size is
  the "state survives" guarantee for the working set.
- **Focus a cold frame:** overlay a live iframe under the lean cover, boot it, and on generation-matched
  `sh:ready` + a **font+paint readiness gate** crossfade lean→live (F3). Both render identical CSS at
  identical width, so no seam.
- **Laser / comment modes force live (codex P1):** a scriptless lean frame cannot outline, hover-pick,
  or return anchor rects. Entering laser or comment mode promotes the visible working set to live for
  the mode's duration; on exit they fall back to lean. Never evict a frame holding an open thread, an
  active prototype, or an A6 lease.
- **Revision-safety (codex P1):** as a *resting* representation (not a brief cover), the capture must
  carry a real generation and the coordinator must verify the echoed node+revision matches the
  in-flight request before it swaps live→lean. Harden `snapshots.ts` accordingly.

## 6. Degradation & fallbacks (design for it, not around it)

1. **Un-serialisable pixels — canvas / WebGL / video / cross-origin iframe.** Do not reflow as DOM.
   Policy: scoped **subtree raster** (the retained html-to-image path, scoped to that node, composited
   into the lean html at capture width); a cross-origin-tainted canvas cannot be read → that subtree
   stays blank with a marker, or the whole frame is flagged **live-on-focus, lean-never**. Design
   canvas content is overwhelmingly DOM/CSS UI, so this is the edge (none of the pilot frames hit it).
2. **JS-measured layout** — an app that writes inline `style="width:Npx"` from JS bakes that width.
   CSS-driven layout reflows; JS-measured freezes. Flag `degraded:'js-layout'` (heuristic: inline
   width/height on layout containers) → live-on-focus; static approximation during motion.
3. **Cross-origin stylesheet** — `cssRules` throws → skip, record, prefer keeping live. Same-origin is
   the marver norm.
4. **Serialisation failure** — any throw/empty → `sh:snapshot-error`, keep live pixels. Never show a
   broken lean frame.

## 7. Why it hits the perf gate (now measured, not asserted)

The prototype settled the open question codex raised (v1 asserted the win):

- **During a device sweep** — the worst case, all frames reflowing — 30 lean docs held p95 9.3 ms,
  0 dropped, 0 long-tasks. Reflow-per-tick is NOT more expensive than raster at this scale.
- **During pan/zoom** — no width change → the lean tier reflows nothing; cost ≤ the sweep number.
- **At rest (slice 2)** — cold frames run zero JS: no React fiber tree, no timers, no polling.
  `content-visibility:auto` on off-screen lean frames trims paint further.

Caveat (honest): measured on pilot frames (~20 KB CSS, moderate DOM). A monster frame (very large
Tailwind sheet, deep DOM) could cost more; re-measure on the heaviest real board at slice 1, and gate
slice 2 on holding p95<16 ms there.

## 8. Security

- Lean iframe is `sandbox="allow-same-origin"` **without** `allow-scripts` → captured markup cannot
  execute, even if an `on*`/`javascript:` slipped past §3.4. `allow-same-origin` (not full sandbox
  escape) only lets the parent read/adjust the doc; scripts still cannot run inside it.
- Same-origin assets only; no new cross-origin surface. The snapshot is a clone of the live DOM (no
  new secrets) running with strictly fewer capabilities. Net attack surface decreases.

## 9. Publish parity — DONE via runtime capture (2026-08-15, commit 543b813)

**Shipped:** the lean tier now works in published builds (`marver build` → `design/.dist`, `marver
serve`). Published frames are bundled SAME-ORIGIN, so the existing client-side serializer runs at
runtime there exactly as in dev - no headless build step, no heavy dependency. Removing the two
`import.meta.env.DEV` gates was the whole change. Fail-soft: a frame that can't serialise stays live
(== old publish behaviour), so publish can never regress. Codex-reviewed: no board/password leak
(`allow-same-origin` without scripts/forms/top-nav adds nothing beyond the already-same-origin live
iframe); added a CSP sentinel (stay live if a hardened host blocks the inline `<style>`) and
nested-iframe degradation. Verified in a real published build: 43/43 lean ready, no swap, identical to
dev. The milestone gate "works in dev AND publish" is now MET.

**Optional future optimization (not required):** build-time pre-baked lean HTML would give an instant
first paint (runtime capture makes each viewer boot all live frames + capture serially on first load).
It needs a headless renderer at build (puppeteer/playwright) - a heavy dep deferred unless first-view
latency on large shared boards becomes a real complaint. The original build-time text is kept below.

### (deferred) build-time pre-bake

Runtime capture is dev-only today (`FrameNode.tsx:70`), so **slice 1 leaves publish exactly as it is
now (live-only, no lean tier) — no regression, by construction.** The lean tier reaching published
boards is a separate milestone item: the command is `marver build` (there is no `publish`), and it has
no headless-capture phase today. Adding one means at `marver build` rendering each frame headless,
running the §3 serializer, data-URI-inlining same-origin assets (no dev server in the output), and
emitting the static html beside the frame; the published shell then loads the lean tier from those
pre-baked files, live-on-focus still boots the real frame. Speced here; built after slice 1 + slice 2
land and the dev path is proven. The milestone gate "works in dev AND publish" is met for slice 1 by
publish being unchanged.

## 9b. Known limitations of the shipped release (honest scope)

The lean tier is robust for authoring-scale boards. Two things it deliberately does NOT promise, both
from the codex release review (2026-08-15):

- **Memory does not scale to dozens of heavy production apps.** LEAN-PRIMARY keeps every frame's live
  iframe mounted (for instant focus + state) AND adds a lean each - it improves presentation
  stability, not residency. ~40 light frames are fine (verified); 30+ heavy real apps (each a full
  React tree + timers + data clients) will pressure memory. **This release targets typical authoring
  boards (a handful to ~15-20 frames).** Bounded live residency (M4 Stage 3/4: only the working set
  stays live, cold frames navigate to a dormancy doc) is the next milestone for large heavy boards. An
  over-heavy single frame (>4 MB serialized) degrades to live automatically.

- **Animations replay on their own timeline in the lean.** A passive frame's CSS animation runs in the
  lean (no JS needed) but from t=0, out of phase with the live app; focusing the frame swaps to live
  at a different phase - a one-time, minor visual jump. JS-driven animations freeze at the captured
  moment. Faithful animation phase-transfer is out of scope; neither breaks correctness.

Everything else is fail-soft: a frame the serializer can't render faithfully (canvas, video, WebGL,
shadow DOM, cross-origin CSS, nested iframe, unrestorable scroll, blocked CSP, oversized) stays live.

## 10. Migration from M4 Stage 2

**Ports unchanged:** the imperative coordinator (single-in-flight, idle-scheduled, never-during-motion
pump; LRU; cover/uncover on `sh-camera`/`sh-preset`); the bridge request/echo protocol; the fail-soft
contract; the FrameNode capture-scheduling effect.

**Changes:** representation `<img>`→`<iframe srcdoc sandbox="allow-same-origin">`; payload `Blob`→`{html,
scrollMap}`; cache key → `frame+revision`; theme flip → shell attribute mutation; add generation to
the capture protocol (§5); add the residency pool (slice 2).

**Retired:** html-to-image from the facade hot path (kept ONLY as the §6.1 subtree fallback);
`snapshot.js`'s `toBlob` producer (replaced by `serialize.ts`); the width/theme/dpr key math.

Update `SPEC-M4-PROGRESS.md`: Stage 2 → "raster, superseded by M5"; Stages 3–4 → "folded into M5 §5".

## 11. Test plan

**Already de-risked (prototype):** F1 color, F2 reflow, theme-flip-without-recapture, 30-frame sweep
perf, clean serialization on real frames. Keep `/__mv/proto/` as the fidelity bench.

**Slice-1 acceptance (on a real board):**
- F1 computed-style diff (live vs lean) across a sample of elements — automated, not eyeball.
- F2 reflow diff at 390/834/1440 vs live at each width (bounding-box tolerance).
- F3 swap seam: screenshot lean vs live same width/theme, pixel-diff under threshold; assert the
  font+paint readiness gate fired (not `load`).
- Theme flip matches live at each theme; assert no re-capture.
- Device sweep across all frames: smooth (0 dropped) AND each reflows (not scales).
- Degradation: canvas frame → subtree raster, rest reflows; JS-layout frame → live-on-focus;
  cross-origin-CSS frame → kept live.
- Publish parity: a published board renders lean frames from pre-baked files; live-on-focus boots.
- Perf gate on the HEAVIEST real board, slice 1 and slice 2.
- Fail-soft: force a serializer throw → live pixels kept, no broken lean frame.

**Slice-2 acceptance:** a pooled frame keeps form/scroll across a pan; an evicted frame re-captures on
next focus; laser/comment promotes the visible set to live; eviction retains the iframe element
(iframe-identity assertion).

## 12. Open decisions for Codex (v2)

1. **Scroll restore via shell mutation (§3.8/§4).** Is "shell sets `leanDoc.scrollTop` after load"
   robust across nested/virtualised scrollers, or do we accept a scroll seam for cold frames and rely
   on live-on-focus? Recommendation: shell-restore for the top 1–2 scroll containers, accept seam
   deeper.
2. **Live-pool size N (§5).** Fixed (N=3–4) or memory-budget-driven (weighted LRU under a heap budget)?
   Recommendation: start fixed, add budget only if the heaviest-board gate needs it.
3. **`cssRules` serialisation cost.** Large sheets (full Tailwind) per revision — acceptable given it
   is idle-scheduled + coalesced, or need incremental capture? Recommendation: measure on the heaviest
   frame; optimise only if it shows.
4. **Publish build-time serializer (§9).** Headless render per frame at publish — reuse the dev
   frame-host in a headless pass, or a separate SSR path? Which keeps one code path?
5. **Single-tier confirmation.** Confirm retiring the raster facade entirely (keeping html-to-image
   only as the §6.1 subtree fallback) is right, given the 30-frame sweep held the gate. Recommendation: yes.
