# SPEC-M5 — The lean-frame facade (DOM snapshot, not pixel snapshot)

Status: DRAFT (2026-08-15). Supersedes SPEC-M4 Stage 2 (raster facade) and folds in Stages 3–4.
Mechanism-level pivot inside the M4 milestone; the M4 non-negotiables (§1 there) still gate every
change here. One open decision is flagged in §11.

---

## 0. Why this pivot

The M4 raster facade (html-to-image → cached `<img>` shown during motion) met the p95 perf gate
but failed the thing a design canvas cannot fail: **fidelity**. Dogfooding surfaced three symptoms,
and all three are the same root cause — a raster is a resolution- and width-locked bitmap:

| Symptom | Root cause | Why a raster can never fix it |
|---|---|---|
| Text color "invented" vs the live frame | html-to-image serializes DOM→SVG→canvas; gamma / color-profile drift + it does not inherit every computed style | A rasteriser re-samples color. There is no faithful-color mode. |
| Text reflows / jiggles on swap | Snapshot baked at capture width W1, live frame now at W2 | A bitmap cannot reflow to a new width. |
| Device sweep (phone→tablet→laptop) looks wrong | Each device is a different *layout*, not a scaled bitmap | Stretching a phone screenshot to tablet width is a stretched bitmap, full stop. |

**Thesis (one line):** cache a **DOM snapshot** (a self-contained static HTML doc: post-render DOM
+ full inlined CSS, JS stripped), not a **pixel snapshot**. The lean tier then renders with the
browser's own layout engine and the app's own stylesheet — so color is identical (same tokens, no
re-sample), resize reflows natively (real CSS), theme switch is one attribute flip, and device
sweep is just a width change. It stays lean because it runs **zero JavaScript** (no React runtime,
no timers, no data fetch, no re-render) — which is the main-thread cost the raster facade was buying
its way out of, now removed without giving up real pixels.

This is the best-of-both Nic asked for: lean enough to scale to ~30 frames, pixel-perfect across
resize / theme / device, with the real app swapped in on focus for perfect interaction.

---

## 1. What must not break (inherits M4 §1; adds three)

Everything M4 §1 protects still holds: laser, element-comments, prototype/goto, live-resize, theme
without remount, the iframe-identity law, board single-writer, publish parity. **New invariants
this spec adds:**

- **F1 — Color fidelity.** A lean frame's rendered color for any element equals the live frame's
  computed color for that element (same stylesheet, same tokens; verified by computed-style diff,
  not eyeball).
- **F2 — Reflow fidelity.** Resizing or device-sweeping a lean frame produces the same layout the
  live app would at that width (for CSS-driven layout; JS-measured layout is the documented
  exception, §6).
- **F3 — Seamless swap.** The lean→live and live→lean transition shows no visible jump: both render
  the identical stylesheet at the identical width, so they are pixel-aligned by construction. (This
  is the structural advantage over the raster facade, where the swap always risked a mismatch.)

---

## 2. The model — two tiers, four axes (reuse M4's lifecycle)

M4's four orthogonal axes stay. This spec only changes what the **presentation** axis renders when a
frame is not the live target, and tightens the **residency** axis.

```
  RESIDENCY      live  |  lean  |  cold           (was: live | suspended | dormant)
  PRESENTATION   app   |  lean-static             (was: app | raster-snapshot)
  INTERACTION    focused/interacting | passive
  HEALTH         booting → committed → ready → error   (unchanged; generation id)
```

Two concrete representations of one frame:

- **Lean tier** — a sandboxed, script-less `<iframe srcdoc>` holding the DOM snapshot. Reflows,
  theme-flips, device-sweeps natively. Zero JS. This is the resting representation and the
  motion cover.
- **Live tier** — today's full app iframe (React + JS + data). Perfect laser / comment / prototype /
  interactive behavior. Instantiated for the working set (§5), swapped in on focus.

**Cache-key collapse (a real simplification).** The raster cache keyed on
`frame+revision+width+theme+dpr` — a matrix of bitmaps per frame. A DOM snapshot reflows across all
widths/themes/dprs, so the key collapses to **`frame+revision`**: one snapshot per revision. Less
memory, less bookkeeping, and the width/theme/dpr math in `snapshots.ts` (`bytesOf`, `keyOf`)
disappears.

---

## 3. The serializer contract (frame-side, replaces `snapshot.js`)

Runs INSIDE the frame document (the only place the live CSSOM, fonts, and rendered DOM exist),
invoked by the bridge on `sh:snapshot-request` exactly as today. Produces a self-contained HTML
string (not a Blob). Must fail soft: any throw/empty → `sh:snapshot-error`, shell keeps live pixels
(unchanged failure contract).

**Capture (in order):**

1. **Clone the rendered DOM.** `document.documentElement.cloneNode(true)` — this is React's committed
   output, so it is already "authored markup" that reflows under CSS.
2. **Inline every stylesheet.** For each `document.styleSheets` entry, serialize
   `Array.from(sheet.cssRules).map(r => r.cssText).join('\n')` into a single `<style>` in the clone's
   `<head>`. **Capture the full sheet — all media queries and both themes** — never just the
   currently-matching rules. This is what makes F2 (reflow) and theme-flip work without re-capture.
   Same-origin sheets read `cssRules` freely; a cross-origin sheet that throws on `cssRules` access
   is skipped and recorded (degradation, §6).
3. **Keep same-origin asset URLs as-is.** Images, fonts, background-images resolve cheaply because
   the lean iframe renders same-origin. (Publish/export path data-URI-inlines them for portability;
   dev keeps URLs — no base64 bloat in the hot path.)
4. **Neutralise execution.** Remove `<script>`, `<link rel=modulepreload|preload as=script>`, inline
   `on*` handler attributes, and `javascript:` URLs. The sandbox (§4) is the hard guarantee; this is
   defence in depth and keeps the snapshot small.
5. **Preserve authored CSS, not computed geometry.** Do NOT bake `getComputedStyle` widths/heights
   onto elements — that would freeze layout and defeat F2. Keep the markup + the authored CSS and let
   the engine lay it out. (Exception: elements the app sized with JS inline styles carry those inline
   styles in the clone; that is the JS-layout caveat in §6, not a serializer bug.)
6. **Carry the theme signal.** Stamp the clone's root with the same `data-theme` + `dark` class the
   bridge sets (bridge.js:8). Theme flips later are a root-attribute rewrite on the srcdoc (§4).

**Do not capture:** scroll position (the lean frame is not scrolled during motion), transient
laser/comment/hover chrome (already guarded — `modeActive()` refuses capture, bridge.js:67), or any
`#mv-laser-*` injected nodes.

Output: `{ html: string, degraded?: 'canvas'|'webgl'|'cross-origin-css'|'video' }` posted as
`sh:snapshot-result`.

---

## 4. The lean renderer (shell-side, replaces the `<img>` facade)

The facade element changes from `<img class="sh-snapshot">` to a script-less
`<iframe class="sh-lean" sandbox>` driven imperatively (still zero React renders per pan tick — the
whole point of the imperative `snapshots.ts` coordinator is preserved).

- **Mount:** `sandbox=""` (NO `allow-scripts`) → JS cannot run, guaranteeing lean + safe. Set
  `srcdoc` to the captured HTML.
- **Theme flip:** rewrite the root `data-theme`/`dark` token in the srcdoc string and reassign
  `srcdoc` (cheap; the full CSS is already inlined, so only which rules match changes). No
  re-capture, no message channel needed (a no-script sandbox can't receive `postMessage`).
- **Device sweep / resize:** change the iframe's CSS width/height. Media queries in the inlined CSS
  fire natively; layout reflows. This is F2, and it is the device-sweep fix.
- **Cover semantics (unchanged from M4):** shown during `sh-camera` (canvas pan/zoom) and `sh-preset`
  (device sweep / tidy), never during a bare frame click/drag (`sh-gesturing` only) — the jiggle fix
  (704a225) stays exactly as-is; only the covered element's tag changes.

CSS: `.sh-lean` gets the same `position:absolute; inset:0` placement `.sh-snapshot` had, minus
`object-fit` (an iframe needs none). `pointer-events:none` while it is a cover.

---

## 5. Residency & the swap protocol

Build this in two slices so slice 1 ships fidelity with near-zero risk.

**Slice 1 — fidelity, drop-in (residency unchanged).** Lean-static replaces the raster as the motion
cover only. Every frame stays live-mounted exactly as today; the lean iframe covers during
`sh-camera`/`sh-preset` and uncovers on settle. This alone fixes F1/F2/F3, the color bug, the
jiggle, and the device sweep — with no change to residency, so no state-loss risk. Lowest-risk path
to "it looks right."

**Slice 2 — bounded live residency (the scale win).** Make lean-static the *resting* representation
for cold frames and keep only a bounded **live pool** (weighted LRU, e.g. the focused frame + N most
recently focused) mounted as live apps. This is where ~30 frames truly scale: the cold majority run
zero JS. Collapses M4 Stages 3 (working set) and 4 (hibernation) into this one mechanism.

Swap protocol (slice 2):
- **Focus/interact a cold frame:** overlay a live iframe under the lean cover, boot it, and on
  `sh:ready` (generation-matched) crossfade lean→live. Because both render identical CSS at identical
  width, the crossfade has no seam (F3).
- **Blur out of the live pool (evicted by LRU):** re-capture a fresh DOM snapshot (frame may have
  changed), swap live→lean, tear down the live iframe. State loss on eviction is acceptable *only*
  for frames outside the pool; the pool size is the "state survives" guarantee for the working set
  (M4 iframe-law compliance for the working set, bounded residency for the rest).
- **Never evict a frame that holds an open comment thread, an active prototype, or a lease**
  (reuse A6 interaction leases, bridge.js:127).

---

## 6. Degradation & fallbacks (design for it, not around it)

Three bounded failure modes; each degrades gracefully and is recorded on the snapshot:

1. **Un-serialisable pixels** — `<canvas>`, WebGL, `<video>`, cross-origin iframe. These do not
   reflow as DOM. Policy: keep a **raster fallback for that subtree only** (reuse the M4 html-to-image
   path, scoped to the offending node) composited into the lean HTML at capture width; the rest of
   the frame stays live-reflowing DOM. If a frame is canvas-dominant, mark it **live-on-focus,
   lean-never** (it renders live or not at all). For a design canvas the dominant content is DOM/CSS
   UI, so this is the edge, not the norm.
2. **JS-measured layout** — an app that measures width in JS and writes inline `style="width:Npx"`
   bakes that width into the clone (§3.5). CSS-driven layout (flex/grid/media queries) reflows
   perfectly; JS-measured does not. Policy: such frames are flagged **live-on-focus** (which they get
   anyway) and show a static approximation during motion. Detection heuristic: presence of inline
   width/height on layout containers at capture time → flag `degraded:'js-layout'` for telemetry; do
   not block the snapshot.
3. **Cross-origin stylesheet** — `sheet.cssRules` throws. Skip that sheet, record
   `degraded:'cross-origin-css'`. Same-origin is the marver norm (frames are served same-origin), so
   this is rare; when it happens the lean frame may miss some styling and the shell prefers keeping
   that frame live.

**Serialisation failure (any throw/empty):** identical to today — `sh:snapshot-error`, keep live
pixels. Never show a broken lean frame.

---

## 7. Why it hits the perf gate

The p95<16ms gate was already met by the raster facade; the risk is that a script-less iframe is
heavier to composite than a decoded bitmap. It is not, on the axis that matters:

- **During motion**, all frames are GPU-transformed by the parent regardless of representation — the
  transform is cheap either way. The raster facade's win was removing *JS execution* (resize/scroll/
  IntersectionObserver handlers, React re-renders) from live iframes during the gesture. A no-script
  lean iframe removes that same JS execution — it has none. So the main-thread frame-time win is
  preserved.
- **At rest (slice 2)**, cold frames run zero JS: no React fiber tree in memory, no timers, no data
  polling. A lean DOM + `content-visibility:auto` on off-screen lean frames is cheaper than a live
  app at rest. This is the ~30-frame scale win.
- **Memory:** one snapshot HTML string per revision (vs the raster's width×theme×dpr bitmap matrix).
  Lower and simpler.

Gate re-measured on the 43-frame pilot after slice 1, and again after slice 2, with the same
harness that produced the M4 numbers (pan/zoom p95, dropped frames, long-tasks).

---

## 8. Security

- Lean iframe is `sandbox=""` **without** `allow-scripts` → captured markup cannot execute, even if
  a malicious `on*`/`javascript:` slipped past the §3.4 scrub. Hard guarantee, not best-effort.
- Same-origin asset URLs only; no new cross-origin surface.
- The snapshot HTML never contains secrets the live DOM did not already expose (it is a clone of the
  live DOM), and it runs with strictly fewer capabilities (no script). Net attack surface decreases.

---

## 9. Migration from M4 Stage 2

**Ports unchanged:** the imperative coordinator in `snapshots.ts` (single-in-flight, idle-scheduled,
never-during-motion pump; LRU; cover/uncover on `sh-camera`/`sh-preset`); the bridge request/echo
protocol; the fail-soft contract; the FrameNode capture-scheduling effect.

**Changes:** representation `<img>`→`<iframe srcdoc sandbox>`; payload `Blob`→`html string`;
cache key `frame+rev+width+theme+dpr`→`frame+rev`; `bytesOf`/`keyOf`/dpr-bucket logic deleted;
theme flip becomes a srcdoc-string rewrite; add the §5 residency pool (slice 2).

**Deleted:** `html-to-image` from the hot path (kept only as the scoped subtree-raster fallback,
§6.1); the width/theme/dpr snapshot matrix; `snapshot.js`'s `toBlob` producer (replaced by the §3
serialiser).

Update `SPEC-M4-PROGRESS.md`: Stage 2 items re-scoped to "raster (superseded by M5)"; Stages 3–4
marked "folded into M5 §5".

---

## 10. Test plan (thorough, per the standing directive)

**De-risk first (before building slice 1):** prototype the §3 serialiser on the pilot's two hardest
frames — (a) a themed + responsive frame (proves F1 color, F2 reflow, theme flip, device sweep),
(b) a canvas or JS-measured frame (proves §6 degradation). If both behave, the approach is proven
end to end and we build.

**Acceptance tests:**
- **F1 color** — for a sample of elements, `getComputedStyle(live).color/backgroundColor` ===
  `getComputedStyle(lean)` for the same element. Automated, not eyeball.
- **F2 reflow** — capture at width 390 (phone); render lean at 390/834/1440; assert layout matches a
  live app rendered at each width (bounding-box diff within tolerance).
- **F3 swap seam** — screenshot lean and live at the same width/theme; pixel-diff below threshold
  (excluding known-degraded subtrees).
- **Theme flip** — flip lean light↔dark; assert it matches live at each theme; assert no re-capture
  fired.
- **Device sweep** — sweep phone→tablet→laptop across all frames; assert smooth (no dropped frames)
  AND each frame reflows (not scales).
- **Degradation** — canvas frame shows subtree-raster fallback, rest reflows; JS-layout frame flagged
  live-on-focus; cross-origin-CSS frame kept live.
- **Perf gate** — pan/zoom p95<16ms on the 43-frame pilot, slice 1 and slice 2.
- **State survives (slice 2)** — a frame in the live pool keeps form/scroll state across a pan; a
  frame evicted from the pool re-captures correctly on next focus.
- **Fail-soft** — force a serialiser throw; assert live pixels are kept, no broken lean frame.

---

## 11. Open decisions for Codex

1. **Live-pool size N (§5).** Fixed N, or memory-budget-driven (evict by weighted LRU under a heap
   budget)? Trade-off: simplicity vs adapting to frame weight. Recommendation: start fixed (N=3–4),
   add budget only if the gate needs it — mirror M4's "conditional Stage 5" discipline.
2. **Slice-1 residency (§5).** Confirm slice 1 keeps *all* frames live-mounted (lean is cover-only)
   so the fidelity fix ships with zero state-loss risk, deferring residency reduction to slice 2.
   Recommendation: yes.
3. **`cssRules` cost.** Serialising large stylesheets (Tailwind's full sheet can be big) on every
   revision — is per-revision cost acceptable given it is idle-scheduled and coalesced, or do we
   need an incremental/diff capture? Recommendation: measure on the pilot's heaviest frame first;
   optimise only if it shows.
4. **`adoptedStyleSheets` / constructable stylesheets.** Some frameworks put CSS in
   `document.adoptedStyleSheets`, not `<style>`/`<link>`. §3.2 must also serialise those. Confirm
   coverage across the pilot's stacks (Next.js, Vite/React-Router).
