# SPEC-M6 — Scalable canvas: crisp-DOM-first, frame-type-aware, bounded live apps

Status: **v3.1 — build-ready.** v3 established the right thesis (crisp DOM is the universal representation;
raster stays dead; live apps are bounded and active-only) and codex confirmed it (*"the architectural pivot
is right"*). v3.1 folds in every codex P1: the two missing protocols (**Passive-Artifact Lifecycle** §4 and
**Live-Lease Arbiter** §5), the promotion state machine (the old handoff was removed with the raster, §5.3),
laser/comment made **snapshot-native** (§8), per-image LOD made **shell-driven** (§6), the honest motion
ceiling (§9), the frame **profiler** (independent capability axes, not one label; §3), and the corrected
real-board gates + sequencing (§11–12). §1 maps every concrete problem we hit to its fix. Retains M5's
serializer/renderer; the motion raster-LOD is removed (shipped). Reference: **tldraw** (DOM shapes +
per-image LOD + activate-on-click), not Figma/Miro raster tiles.

---

## 1. The problems, and exactly what fixes each

| Problem we hit | Root cause | The fix in this spec |
|---|---|---|
| Whole-viewport **white flash** on zoom (marver-site) | N live iframes re-raster at scale → GPU tile starvation | Bounded live pool (§5): only ~3 apps ever live; the rest are cheap DOM snapshots. Plus culling (shipped). |
| **Deep-zoom blank/lag** on a rich frame | one large iframe re-rastering at high scale | The inspected frame promotes to live/native-crisp (§5.3); it's the only heavy thing on screen. |
| **tms-broker laggy** on image boards | re-decoding/re-rastering big images at scale (this board is 10 image + 10 mermaid, **not** web-apps) | **Per-image resolution LOD** (§6): low-res zoomed out, sharp on settle. Mermaid = inline SVG, crisp for free (§7). |
| **Text jiggle / images look bad** | the raster (image) facade during motion | **Removed.** Crisp DOM snapshot at rest AND motion (§2). No frame is ever a bitmap. |
| **Reflow differs moving vs still** | a bitmap can't reflow; DOM does | Same DOM snapshot in both states → identical reflow (§2). |
| **Slow board load** | eager `html-to-image` per frame | Removed. Snapshots compile from the DOM (~ms), background-scheduled, capped (§4). |
| **Mermaid weirdness** | bitmap of a diagram + captured mid-render | Inline SVG, captured after render, no mode-chrome, theme-keyed (§7). |
| **Hundreds of apps + images** (the goal) | can't run hundreds of live iframes (physics) | Hundreds of cheap crisp snapshots + a handful live; frame-type-aware so light frames stay light (§3). |

The honest boundary (§9): for a board of **many heavy web-apps all visible in continuous motion**, crisp DOM
re-rasters natively — crisp, but not as buttery as a bitmap would be. That is the deliberate fidelity-first
trade; the mitigation is culling + the pool + density limits, **never** a frame image.

---

## 2. Two representations, only two (raster is gone)

1. **Crisp DOM snapshot — the universal default, rest AND motion.** M5's scriptless `<iframe srcdoc>`:
   post-render DOM + inlined CSS, JS stripped. Pixel-perfect; reflows natively; theme-flips by attribute;
   device-sweeps as real CSS; **re-rasters crisp at any zoom** (a DOM re-raster is sharp — only a bitmap is
   blurry). It is a *compiled* form of the app: pixel-perfect regardless of theme/device/screen.
2. **Live web app — active frames only.** The genuine running app, mounted only when the frame is
   interactive / laser-pick / comment-pick / prototype, from the bounded pool (§5).

No third "image" representation. Ever.

---

## 3. Frame profiling — independent capability axes (codex Q2)

Do **not** assign one A/B/C/D label; the classes overlap (a React app can be image-heavy *and* have mermaid
*and* keep mutating). Profile each frame on **independent axes**, auto-detected from the serialized DOM +
runtime observation, with an optional authored override:

| Axis | Cheap signal | Drives |
|---|---|---|
| DOM/paint weight | node count, CSS bytes | recapture cost, motion cost |
| Image weight | total `<img>`/bg pixel-area | needs per-image LOD (§6) |
| Diagram presence | inline mermaid/D3 `<svg>` | SVG parity path (§7) |
| Runtime dynamism | mutates / holds sockets/timers after ready | whether the snapshot can go stale silently; pre-warm value |
| Snapshot compatibility | canvas / video / shadow / oversized / cross-origin CSS | **incompatible** → counted live lease (§4.4) |
| JS-driven responsiveness | ResizeObserver / JS-measured layout | width-keyed recapture, else CSS-only parity (§4.5) |

- **`kind` (`tsx`/`html`) and `intent` are NOT predictive** — a TSX page can be static prose; an HTML file a
  live app. Don't overload them.
- **Authored override:** optional manifest `meta.renderProfile: 'static' | 'image' | 'diagram' | 'app'`,
  required only when auto-detection reports ambiguity or incompatibility. `auto` is the normal path.
- **Consequence (the point):** a markdown/prose frame pays almost nothing; only genuinely heavy, dynamic
  web-app frames carry the full machinery. A board of light frames is featherweight at hundreds.

---

## 4. Passive-Artifact Lifecycle (codex P1.1, P1.2, P1.5, Q6) — the missing protocol

The crux codex named: today a snapshot is serialized from the **mounted live** iframe
([snapshots.ts](src/client/shell/canvas/snapshots.ts)), and every `FrameNode` mounts both live + lean
([FrameNode.tsx](src/client/shell/canvas/FrameNode.tsx)). If passive frames stop mounting the live app, we
must define how a **cold** frame gets and keeps its snapshot.

### 4.1 Artifact states (freshness)
```
missing → compiling → ready → stale → (incompatible | error)
```
Every artifact is keyed by `source-revision + theme + viewport(device) + capture-engine-version`. A **stale**
artifact stays visible (marked stale) and reconverges asynchronously (upholds R1: never blank, never shown
as fresh when it isn't).

### 4.2 Initial production (how a cold frame first appears)
- On first need (frame enters T0→visible, or board load for near-viewport frames), a **background
  compilation lease** is granted (counts against the pool cap, §5): the app boots **hidden**, serializes its
  snapshot, and the runtime is **released** (unless it wins a keep-warm slot). Compilation is one-at-a-time
  (the "one background capture role" the spike proved — two requesters collide).
- **Until the first snapshot exists, the frame shows live** (today's fail-soft), then goes cold once the
  snapshot is admitted. So there is never a blank first paint; a heavy board simply compiles its snapshots
  over the first seconds, capped, without the eager `html-to-image` cost.
- **Published boards ship pre-baked artifacts** (§4.6) — no boot-on-first-view.

### 4.3 Invalidation
- **Content revision** (file change / nav) → snapshot `stale` → recompile (background lease).
- **Theme** → CSS-only snapshots flip by attribute (no recapture, M5 already does this). **Baked content
  (mermaid SVG, D-class)** needs a **theme-keyed recapture** — precompile both theme variants, or recompile
  on flip behind the current (stale-marked) one.
- **Device/width** → CSS-responsive frames reflow the snapshot natively (no recapture). **JS-responsive
  frames** (§4.5) need a width-keyed recapture.
- **HMR (dev)** → a cold frame's edit takes a background recompile lease; the stale snapshot stays covered
  and marked until the new revision is admitted.

### 4.4 Snapshot-incompatible frames (codex P1.2)
The serializer degrades canvas / video / nested-frame / shadow-DOM / oversized (>~6000 nodes) → these cannot
be faithfully snapshotted. v3.1 makes the outcome explicit, not a silent "stay live forever":
- Mark the frame **`incompatible`** and give it a **counted emergency-live lease** — it holds a live slot
  while visible (so R3's cap still holds; it just consumes one of the ~3). If more incompatible frames are
  visible than slots, the lowest-priority ones show a **deterministic placeholder card** (never blank),
  promoting to live on focus.
- Future compatibility (compatible with "no full-frame raster"): declarative-closed shadow emission; a
  **scoped canvas-subtree bitmap** (a bitmap of just the `<canvas>` element, not the frame); a video
  **poster/frozen** frame. Each is a per-element surrogate, not a frame image.

### 4.5 JS-responsive layout (codex Q6)
A scriptless snapshot cannot reproduce ResizeObserver / JS-measured relayout. Two allowed answers per frame:
restrict passive parity to **CSS-responsive** frames (the snapshot reflows natively), or **width-keyed
recapture** for frames flagged JS-responsive (§3) — recompile at the new device width behind the stale cover.

### 4.6 Publish / export (codex Q6)
Published snapshots must NOT be produced by booting every app in each viewer. Publish runs a **sequential,
capped, clean-boot compiler** that emits pre-baked artifacts (via the project's real Chromium / Playwright),
keyed as §4.1. **Persist only deterministic clean-boot state — never viewer form/session data.** Print/export
renders from artifacts without promoting every node.

---

## 5. Live-Lease Arbiter (codex P1.3, P1.4, Q1) — the pool

A single **synchronous arbiter** decides every live mount **before** it happens — never an after-the-fact
LRU cleanup. Reparenting a shared iframe navigates/reloads it, so "lend an iframe" means **lend permission to
mount a node-local iframe** in the node (or the screen-space portal for the interactive one), not move one
element around.

### 5.1 Capacity
- **Fixed total cap = 3** live documents (start; 2 on constrained devices; 4 only after telemetry).
  `deviceMemory` may only reduce. **Every running document counts:** active, pre-warm, background-compile,
  outgoing-during-handoff, incompatible-lease, and the play-stage iframe.
- The three slots are exactly enough for: the interactive/prototype target · the outgoing/incoming frame
  during a handoff · one pre-warm or background-compile job.

### 5.2 Priority (eviction order, lowest evicted first)
```
foreground active  >  transition destination  >  outgoing handoff  >
required lease (incompatible on-screen)  >  hover warm  >  reachable warm  >  background compiler
```
Pre-warms and background compilers are always evicted first. **Never temporarily exceed the cap** — if no
slot is free, the request waits or is denied (the requester keeps its snapshot).

### 5.3 Promotion / demotion state machine (rebuilt — the old handoff was removed)
```
PROMOTE:  snapshot visible (cover) → slot granted → live mounted BEHIND cover →
          restore url/scroll/theme/device + app checkpoint → generation-matched ready
          + document.fonts.ready + two paints → HARD-CUT cover away (frame boundary)
DEMOTE:   freeze input → pause()/quiesce (deadline) → obtain {checkpoint, visualRevision} →
          compile/admit the snapshot FROM the paused state → decode/verify → reveal snapshot →
          release or park-warm the runtime
```
Never crossfade (M5's 1–2px double-text ghosting). The demotion admits the replacement snapshot **before**
tearing down the live doc (R1). This reuses the *covered-hard-cut idea* the settle-handoff proved, now
re-implemented between snapshot and live (the CSS was removed with the raster; the primitive is re-added
here, snapshot↔live, not image↔DOM).

### 5.4 Bridge additions (frame-side)
Capability-negotiated, deadline-bounded, size-limited (from the v2 review, kept):
`ready · pause · resume · checkpoint · restore · visualRevision`, with `{ pause, checkpoint, restoreVersion }`
capabilities. No-op defaults so unmodified frames still work (they just don't pause/checkpoint efficiently);
only capability-verified runtimes earn a long warm residency.

---

## 6. Per-image resolution LOD — shell-driven, snapshot-only (codex Q4)

The one thing scaled by resolution: individual **images**, not frames. We rewrite `<img>` in the **snapshot**
(which we own) — the live app is never touched.

- **At serialize:** annotate eligible snapshot `<img>`/`<source>` with their original candidate info + a
  reference to a **build-time derivative manifest** (stepped ¼/½/1×/2× of local raster assets).
- **At runtime:** a shell-side controller mutates the same-origin lean document **after camera settle**
  (~150–250ms), choosing a derivative by `rendered image rect × outer canvas scale × devicePixelRatio` with
  **stepped thresholds + hysteresis** (longer on downgrade to avoid thrash) and **decode-before-swap** (keep
  the coarse image until the finer decodes → no flash). Plain `srcset`/`sizes` is **insufficient** — the
  browser sees the iframe's CSS viewport, not that the whole iframe is displayed at canvas zoom 0.12; the
  shell must drive selection.
- **Leave alone:** remote/signed/blob/data URLs, `<svg>` (vector, infinitely crisp), animated GIF/APNG,
  authored `<picture>`/art-direction (defer to it). CSS `background-image` needs build-time
  `image-set()`/URL analysis (not runtime-discoverable from arbitrary CSS) — handle at build for local assets,
  else leave.
- **Guard reflow:** derivatives preserve intrinsic aspect/orientation; never change layout. Memory is browser
  `<img>` decode — treat the 128–256MB budget as **telemetry/backpressure**, not a manual `ImageBitmap.close`
  heap (that API doesn't fit DOM `<img>`).

Result: images are cheap when small/zoomed-out, sharp when zoomed-in, and the **DOM structure stays crisp**.

---

## 7. Diagram (mermaid/SVG) parity (codex Q6)

Mermaid → inline `<svg>` in the snapshot → **infinitely crisp at any zoom, free**. Parity requirement with
laser/comment, with the edge cases codex named:
- Capture **after** render (M5 `domQuiet`), but raise the font gate: `document.fonts.ready` is currently
  bounded at 400ms; extend + detect late font-metric changes for diagrams. Never capture mid-render.
- Never bake laser/comment chrome (M5 `modeActive()` guard).
- **Theme-keyed recapture** for baked fills/strokes (§4.3).
- Mermaid `foreignObject` HTML labels have their own font/CSS readiness — gate on it.
- A mermaid that **re-lays-out on ResizeObserver** is JS-responsive (§4.5) — width-key it, don't assume one
  width-independent SVG.
- `<use href>` / external SVG refs need URL/ID validation.

---

## 8. Laser / comment on cold frames (codex P1.4) — snapshot-native

Today enabling either mode hides every lean and broadcasts to every live iframe
([Comments.tsx](src/client/shell/Comments.tsx)) — a board can have more visible frames than the pool cap, so
"promote all visible" is incompatible with R3. **Decision: make inspection/picking snapshot-native.**

- The lean is a **same-origin** document the shell can touch. Attach the shell-owned laser outline / hover
  highlight / element-pick handlers **to the snapshot document** directly (the M5 `allow-same-origin` sandbox
  permits it). Then laser/comment work on **cold frames** with no promotion, no boot delay, no cap pressure.
- Element anchors resolve against the snapshot's DOM (it shares structure with the live app — the M5 anchor
  ladder already keys on tag/role/testid/quote/cssPath). The 4s live-poll anchor refresh
  ([Comments.tsx](src/client/shell/Comments.tsx)) is replaced by resolving against the snapshot; only a frame
  the user actively enters (interact) promotes to live.
- Fallback for `incompatible` frames (no snapshot): promote-on-hover (accepts a small boot delay), counted.

---

## 9. The honest motion ceiling (codex P1.5, Q3)

Correcting v3's §7: **the camera path already hides the covered live iframe during motion**
([styles.css](src/client/shell/styles.css)), so the pool's big wins are **boot, memory, timers, idle CPU** —
**not** the motion paint cost of the lean DOM itself. On a board of many heavy web-app frames all visible in
continuous motion, the crisp lean re-rasters natively, and **no fidelity-preserving trick removes that cost**
(compositor promotion = the rejected bitmap; foreignObject/canvas = raster in disguise; reduced render scale
= not crisp; per-tick CSS `zoom` = more expensive; flattening into the shell breaks iframe viewport/isolation).

Fidelity-preserving levers (all applied): tighter motion-time culling + small overscan; verified
paint/layout `contain` where it yields zero layout diff; zero JS in passive snapshots; per-image LOD; only
truly-visible frames paint. **If N heavy frames are genuinely visible, their paint cost is real.** The
product answer is: accept the lower frame rate on such boards, or **cap how many heavy frames render at once**
(a density limit, honestly surfaced) — never a frame bitmap. Light/image/diagram boards are unaffected.

---

## 10. What's shipped — keep / removed

KEEP (on `fix/backdrop-white-flash-zoom`): viewport culling; camera blur-drop for glass chrome;
drop-live-during-camera (crisp lean shows in motion); reverted `will-change`; `__mvDiag` HUD.
REMOVED: the motion raster-LOD (`raster.ts`, `sh-raster`, `captureRaster`, `sh-settling`) — crisp DOM is the
sole passive representation again.

---

## 11. Test plan / gates — recorded REAL boards (codex Q3, Q7, P2)

Real boards (codex correction — pick the right stressors):
- **tms-broker/shipper-flows** = 10 diagram + 10 moodboard → the **B/C image + mermaid** regression board.
- **marver-site/all-scenes** = the real **D-class heavy-DOM** board.
- the heaviest existing real board at fit-all + several zoom levels; **dev AND built/published** bundles.
- synthetic **500-A** (must be featherweight) and **20-D** (the hard case) as stress tests only, never a
  substitute for the real-board gate.

Gates:
- **Pixel-perfect (Q1):** snapshot == live for text/layout/color, at rest AND mid-motion, across theme flip +
  device sweep + resize; no jiggle; reflow identical moving↔settled; mermaid identical to laser/comment.
  Asserted by computed-style + layout diff, not eyeball. (Per-image downsampling at low zoom is intentional,
  not source-pixel identity.)
- **R3:** live-document count ≤ 3, always, under rapid focus-cycling (assert after every transition).
- **Motion:** camera **p95 ≤ 16.7ms** (true 60fps, not the looser 20ms) **+ a long-task/blank-frame gate**,
  on the target laptop, per board class. Heavy-D board reports its honest number (§9).
- **Cheap frames:** the 500-A board loads fast, pans/zooms at 60fps, zero capture cost. Image frames upgrade
  resolution only after settle, never mid-gesture, never flash.
- **Never blank:** no blank/stale-as-fresh frame in any transition, promote/demote, theme flip, or HMR.
- Metrics recorded: snapshot parse time, retained HTML/CSS bytes, image transfer/decode, renderer memory,
  promotion latency (warm→live < 150ms p50; cold→interactive < 500–800ms p95).

---

## 12. Sequencing (codex Q7) & open items

**Order (corrected):**
1. **Post-raster real-board gate** — the current crisp-DOM + culling branch, run on the real boards above
   (dev + published). If it passes, it ships as a **0.5.x interim** (correctness-safe: right visual, keeps
   today's live fallback). It will NOT fix heavy-D motion (§9); that's fine for an interim.
2. **Passive-Artifact Lifecycle** (§4) — the prerequisite for removing per-node live mounts.
3. **Live-Lease Arbiter + pool** (§5) — lands atomically with §4.
4. **Hybrid frame profiler** (§3).
5. **Per-image LOD** (§6).
6. **Pre-warm** (§5, reachable=1) + laser/comment-on-snapshot (§8).

**Resolved decisions:** laser/comment = **snapshot-native** (§8). Heavy-D density = **accept honest lower FPS
+ optional visible-D cap**, never a bitmap (§9). Live cap = **3, fixed** (§5.1).

**Remaining open (for the spike/build to settle):**
- The exact background-compile scheduling cadence that keeps a heavy board's first-paint fast without janking.
- Whether `incompatible`-frame emergency leases need their own smaller sub-cap so they can't starve the
  interactive slot on a canvas/video-dense board.
- Per-image LOD build-time derivative pipeline for CSS `background-image` (local assets only).

---

*v3.1 = v3 (crisp-DOM-first, frame-type-aware, retract raster) + all codex P1s folded in (passive-artifact
lifecycle, live-lease arbiter, promotion state machine, snapshot-native laser/comment, shell-driven image
LOD, honest motion ceiling, capability-axis profiler, corrected real-board gates + sequencing). Retains M5
serializer/renderer + shipped culling/handoff-primitive; motion raster-LOD removed. Reference: tldraw.*
