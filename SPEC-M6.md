# SPEC-M6 — Tiered rendering: hundreds of real web apps on one canvas

Status: **v2 — PROPOSED, codex-reviewed (2026-08-16).** v1 verdict was REVISE: the bounded-runtime-pool
thesis is sound, but four contracts couldn't hold simultaneously and the sequencing was wrong. v2 makes
three changes load-bearing per the review: (a) **tier-specific fidelity** (raster is a bounded approximation,
not M5-exact), (b) a **lease/generation state machine with conditional state-survival**, and (c) an
**artifact-first ordering** where the runtime cap lands atomically with canonical decoded proxies — Stage 1
is NOT independently shippable. All P1s from the review are folded in and marked `[cx]`. Grounded in two
convergent research passes (codex deep-web, 21 searches; research-agent teardown of tldraw/Figma/Miro/
Excalidraw/Framer/Webflow/Arc/Replit/Kosmik). Supersedes M5's residency model (§5 slice 2). The M5 lean tier
survives as the bounded T2. Work already on `fix/backdrop-white-flash-zoom` (culling + motion raster-LOD +
settle handoff) is the tactical first slice and is kept. Resolved decisions (was §12) are now §12; new open
items are few.

Companion decision-framing doc: the published "Hundreds of real web apps on one canvas" artifact.

---

## 0. Why this pivot

M5 made a passive frame cheap (scriptless DOM snapshot) but kept **every** node's live iframe AND lean
iframe mounted for life. At ~15 heavy Next.js frames that ships two dogfooded failures (2026-08-16):

| Symptom | Root cause | Why M5 can't fix it |
|---|---|---|
| Zoom → whole viewport flashes WHITE (canvas + frames + fixed chrome) | Chromium re-rasterises every iframe layer at the zoom scale each tick; N iframes starve the GPU tile budget → blank tiles | Both live and lean are iframes; both re-raster. |
| Deep zoom into one rich frame → blanks / laggy | Same starvation on one large surface | Lean is still an iframe rastered at scale. |
| Image-rich boards (tms-broker) → laggy zoom | Re-decode + re-raster many large images at scale | No image LOD. |
| Move-around → "refreshes the iframes and flashes white" | `content-visibility` hidden→visible repaints heavy content from blank | Patched by the settle handoff; must become the architecture's primitive. |

**The wall is physics.** Same-origin iframes share one renderer process + one main thread; each ~10–50 MB +
its own compositor layer. Chrome's whole decoded-image budget is 128–256 MB (a 4096² image ≈ 64 MB). No
product runs hundreds of live embeds — Figma caps at **exactly one**; tldraw/Excalidraw/Arc/Replit keep 1
live, freeze the rest.

**Thesis:** a board node stops owning a live iframe for life. The board owns metadata + cached proxy
**artifacts**; a global, budgeted **RuntimePool** *lends* a live surface to the tiny working set that earns
it. Every node stays a *real* app; its dormant form is a cached materialisation, promoted on demand. "Real"
= the authoritative artifact + the focused experience, not concurrent execution. The ceiling moves onto
cheap proxies (node count), which is where AI content pushes.

---

## 1. Invariants — what must not break

Inherits M5's laser, comments, prototype/goto, live-resize, theme-without-remount, iframe-identity,
single-writer, publish-parity. **M5's F1/F2 (exact color / reflow fidelity) become TIER-SCOPED** `[cx-P1.1]`
— see §2.1. New:

- **R1 — Never a blank frame.** A node's current visual is never removed until its replacement has *decoded
  and painted*. If no fresh artifact exists, the degradation ladder (§4.2) still guarantees a paint-ready
  visual. "Never blank" is achievable; "always a fresh high-fidelity proxy" is not `[cx-P1.3]`.
- **R2 — Real app on focus + crisp on inspect.** The focused/interacted node is always the genuine live
  iframe. Deep-zoom inspection past the raster ceiling escalates to a reserved **T2 inspection slot** or T4,
  so detail is never a stretched screenshot `[cx-P1.1]`.
- **R3 — Bounded working set.** Total live iframes NEVER exceed the global cap (§3), regardless of board
  size / zoom / pan speed. Node count unbounded; runtime count hard-capped. Play-mode stage + background
  capture runtimes count against the SAME budget `[cx-Q1]`.
- **R4 — Conditional state survival** `[cx-P1.2]`. **Shell-owned state (URL, route, theme, device, root
  scroll, ordinary form controls) always survives** a live→proxy→live round-trip. **App-owned state
  (arbitrary React/router/dialog/virtualised-scroller/media/worker/unsaved state) survives exactly only when
  the runtime advertises `checkpoint` capability**; otherwise dormancy restores a documented generic
  baseline, and the user is never shown a *wrong* live state (the proxy covers until a valid runtime exists).

Three health axes, tracked independently — the single `node.status` cannot represent a cold node `[cx-P1.4]`:

```
artifact:  missing → stale → capturing → decoded → degraded
runtime:   absent → booting → paused → active → error
lease:     none → requested → granted → releasing
```

---

## 2. The tier model — five tiers, chosen by screen rectangle

Tier is a pure function of the node's transformed screen rect (`worldW×zoom`, `worldH×zoom`), focus/
selection, and pool budgets. Not DOM/registration order.

| Tier | Representation | Fidelity | Admission (roughly) | Hard cap |
|---|---|---|---:|---:|
| **T0 — model only** | bounds+title+theme+keys+placeholder | n/a | off-screen or < ~48 screen-px | ∞ |
| **T1 — raster proxy** | bitmap from a resolution pyramid; large proxies tiled | **bounded approximation** (§2.1) | default: every passive node + ALL motion | budget |
| **T2 — crisp DOM snapshot** | M5 scriptless inlined-CSS `<iframe srcdoc>` | **F1/F2 exact** | settled; selected/largest; **reserved inspection slot** for the zoom target | 2 (→4 post-measure) |
| **T3 — warm runtime** | loaded iframe, cooperatively **paused**, covered | live doc (hidden) | recently-used / predicted-next / capability-verified | (in global cap) |
| **T4 — interactive runtime** | live app iframe in a screen-space overlay | **live, exact** | focus / interact | 1 (2 compare) |

Rules that are easy to get wrong:
1. **Near-viewport = PREFETCH priority, not promotion.** Proximity warms an artifact; it never auto-mounts a runtime.
2. **Motion targets T1 for every node — but it is a TARGET, not an absolute** `[cx-P1.6]`. If a fling ends on
   the focused node before a fresh proxy exists, the single T4 runtime may TRACK the camera matrix until
   capture completes (one runtime can't recreate the N-iframe starvation). Never expose a second independently
   chasing live iframe. Prefer: install a fresh proxy *before* the first transform.
3. **Caps are hard admission budgets.** Crossing a size boundary makes a node *eligible*; it promotes only if
   it wins a slot. Losing = stays T1.

### 2.1 Tier-specific fidelity `[cx-P1.1]`

A resolution pyramid fixes sharpness — NOT raster color/gamma drift, reflow after width/device change,
JS-measured layout, animation phase, or pixel-identity with a separately-rendered live doc. Therefore:

- **T1 raster** = a *bounded visual approximation*, keyed by exact `viewport+theme+revision+state` with an
  explicit pixel-diff tolerance. After a resize/theme change, T1 may temporarily retain the last valid
  artifact **but must be marked STALE and converge asynchronously**.
- **T2 / T4** carry F1/F2 exactness.
- **Reserve one T2 "inspection slot"** for the selected / zoom-target node so the thing under inspection is
  never a stretched T1 (upholds R2). Without this the hard T2 cap could leave the inspected node blurry.

If we ever require *every* settled passive node to hold M5-exact fidelity, raster-primary is wrong and
hundreds-scale is off the table. Accept that cold nodes are faithful cached materialisations, not live
reflowing documents.

### 2.2 Tier-selection score (the one bespoke surface)

Rank promotion candidates: active interaction / focus → selected → viewport intersection → screen area →
distance-to-centre → recency → camera velocity + predicted direction → artifact freshness / restore cost →
remaining budget. **Explicit interaction bypasses dwell.** Hysteresis: fine LOD only after **150–250 ms
settled**; promote on dwell, **demote visually immediately** to an already-decoded proxy; warm TTL **15 s**
(evict instantly under pressure); raster bucket changes only past **≈1.4× up / 0.7× down**.

### 2.3 State machine `[cx-Q2]`

```
PROXY → STARTING → ACTIVE → PAUSING → WARM → EVICTING → PROXY
        (CRISP = independent T2 presentation overlay, orthogonal)
```
Every intent increments an **epoch**; a superseded starter can never reveal (latest-intent-wins). Demotion
requires a *decoded replacement* before it reveals. Camera motion cancels pending T2 promotions and freezes
new background-capture admissions. Selection earns T2 after ~200 ms settled.

---

## 3. RuntimePool with leases (Stage: foundation) `[cx-P1.4]`

`FrameNode` MUST stop permanently instantiating `.sh-live` + `.sh-lean`
([FrameNode.tsx](src/client/shell/canvas/FrameNode.tsx)). A singleton pool owns a fixed set of reusable
surfaces in ONE permanent overlay portal and lends them via **cancelable leases** — a bare `nodeKey` promise
is insufficient because a slot can be reassigned while old `sh:ready` / snapshot / anchor / checkpoint
messages are still in flight, and today most messages are not generation-guarded
([App.tsx](src/client/shell/App.tsx), [frame-registry.ts](src/client/shell/canvas/frame-registry.ts)).

```
RuntimePool
  GLOBAL_CAP = 3 total runtimes (active + booting + warm + background-capture, shared)  [cx-Q1]
  interactive = 1 (2 in compare); T2 DOM proxies start at 2 (→4 post-measure)
  request(nodeKey, targetTier, priority) → Lease | Denied      // cancelable
  release(leaseId) → warm | destroy
  onPressure() → evict lowest-priority beyond warm

Every runtime message carries:  { slotId, leaseId, nodeKey, documentGeneration, artifactKey }
Only the CURRENT lease may: change status · publish an artifact · resolve comments · become visible.
Superseded starters stay covered and are canceled or returned warm.
```

- **`deviceMemory` may only REDUCE caps, never raise them** `[cx-Q1]`.
- **A live iframe is never reparented and never `display:none`d.** All live/warm iframes are created directly
  inside the one overlay portal; we switch position/visibility, not parent `[cx-Q4]`. `Element.moveBefore()`
  (note: `Element`, not `Node`; Chrome 133+/FF 144+/**no Safari**; both nodes must stay connected) is an
  *optional enhancement* for the rare reparent, never foundational. The `appendChild` fallback = checkpoint →
  reload → restore-behind-proxy, NOT a state-preserving move `[cx-P1.6, feasibility]`.
- Culling ([Canvas.tsx cull()](src/client/shell/canvas/Canvas.tsx)) stays; its job becomes proxy
  mount/decode scheduling, not iframe suspension.

---

## 4. Raster = canonical passive representation (Stage: artifact pipeline)

The shipped raster coordinator ([raster.ts](src/client/shell/canvas/raster.ts)) is motion-only and depends
on a live iframe to produce it. Promote it to the default T1 producer, decoupled from per-node runtimes.

### 4.1 Capture & derive `[cx-feasibility]`
- **Do NOT do 5 DOM captures for 5 buckets.** Capture **one** useful source resolution within a strict pixel
  limit (frame-side html-to-image, [bridge.js](src/client/frame-host/bridge.js)), then derive smaller levels
  via `createImageBitmap` / `OffscreenCanvas` (worker). Tile the whole proxy artifact if it exceeds a
  pixel/texture threshold rather than allocating a 4× monolith.
- **Storage: `Blob`/object URLs, never retained base64.** `img.decode()` before every swap. Decode via
  `createImageBitmap` → draw → `ImageBitmap.close()` on eviction. `srcset` to never over-decode.
- **Artifact key MUST include:** `source-rev + route + viewport(w,h) + theme + state-rev + asset-rev +
  capture-engine-version`.
- Frame-side capture handles `<canvas>`/`<video>`/WebGL via `onclone`, but **tainting / preserveDrawingBuffer
  / nested iframes / video-readiness remain DEGRADATION cases** (§4.2), not solved.
- Deterministic screens SHOULD be captured **out-of-band via the project's real Chromium (Playwright)**,
  keyed as above; in-page capture is only for unsaved transient state.

### 4.2 Degradation ladder `[cx-P1.3]` — resolves the R1/R3 deadlock
When capture fails / no artifact / stale / offline / uncapturable node loses a slot, the node still needs a
paint-ready visual without keeping a runtime (which would violate R3). In order:
1. Fresh decoded proxy.
2. **Last-known-good proxy with a visible STALE/degraded status marker.**
3. **Deterministic placeholder / error card that is itself always paint-ready.**
4. Live-on-focus (only when the user targets it and a slot is free).

### 4.3 Images are three different problems `[cx-feasibility]`
- **First-class image nodes** (do not exist yet — `Node` = frames only,
  [store.ts](src/client/shell/store.ts)): tile pyramids (DZI/IIIF, 256–512px, ÷2 levels) once that node type
  exists.
- **Large captured app proxies:** tile the proxy artifact past a threshold (§4.1).
- **Images INSIDE a live app:** the shell cannot transparently IIIF-tile arbitrary DOM `<img>`. That is an
  app-level runtime concern (responsive images / virtualisation). **Removed from M6's first-class promise** —
  a single active app with many huge images may still be slow; that is a T4 runtime problem, not a proxy one.

---

## 5. The live handoff (Stage: portal & pool) — transactional promote/demote

Generalises the shipped settle-behind-cover handoff into the pool swap. **Both are single transactions** so
state can't mutate between capture and checkpoint `[cx-P1.2]`.

**Demote (live → proxy) — one transaction:**
1. Freeze input. 2. `pause()` / quiesce; **await ack with a deadline**. 3. Obtain `{checkpoint,
visualRevision}` from the paused state. 4. Capture the artifact **from that same paused state**. 5. Decode +
admit the artifact under the same revision. 6. Reveal the proxy. 7. Park (warm) or destroy.

**Promote (proxy → live):**
1. Hold the best decoded proxy as an opaque cover on the exact rect. 2. Acquire a slot (evict per §3).
3. Create/reuse the live iframe **behind** the cover in the portal. 4. **Restore shell state + `restore(cp)`
while covered.** 5. `resume()`. 6. Await generation-matched `marver:ready` + `document.fonts.ready` + image
readiness + **two paint frames**. 7. **Hard-cut** on a frame boundary — never crossfade (M5 proved 1–2px
double-text ghosting).

**Checkpoint payloads** need: version, size limit, structured-clone validation, timeout, revision-
compatibility, and **transient checkpoints are memory-only, never persisted/shared by default** `[cx-P1.2]`.

### 5.1 Live-overlay geometry `[cx-P1.6, cx-Q5]`
An iframe *sized to the screen rect* changes its layout viewport and can't hard-cut against a proxy captured
at `node.w×node.h`. So the overlay iframe **keeps its world/layout dimensions** and carries the camera
matrix locally:
```
iframe layout viewport = node.w × node.h CSS px
local transform       = translate(screenLeft, screenTop) scale(cameraScale);  transform-origin: 0 0
```
It lives OUTSIDE `.sh-content` (one fixed, clipped overlay root) but is not literally untransformed — it
carries an equivalent local transform for the ONE active runtime, using the exact matrix from `onTransformed`
(never independently accumulated). Z-order: proxy plane < live body < comments/selection/node-chrome/shell.
Warm runtimes are **`inert`, `aria-hidden`, unfocusable, fully clipped, `opacity:0`** (not `.001`). At the
cut: verify proxy-body and iframe rects agree within a small CSS-px tolerance, wait two frames, hard-cut.

### 5.2 Runtime bridge — capability negotiation `[cx-P1.2, cx-Q6]`
Not a silent no-op. Frames advertise capabilities; the pool only grants long warm residency to runtimes with
a **verified** `pause` (a no-op pause bounds runtime count but NOT CPU/network/workers/sockets/timers). Pause
timeout/failure → shorten warm TTL or destroy.
```ts
interface MarverRuntimeCapabilities { pause: boolean; checkpoint: boolean; restoreVersion: number }
interface MarverRuntimeBridge {
  ready(): Promise<void>
  pause(): Promise<void>; resume(): Promise<void>          // deadline-bounded
  checkpoint(): Promise<unknown>; restore(cp: unknown): Promise<void>   // size-limited, schema-versioned
  visualRevision(): Promise<string>
}
```
Same-origin repo frames are already trusted, so `pause()` is not a new sandbox boundary; the risks are hangs,
oversized/sensitive checkpoints, and stale restores — bound all three.

---

## 6. Memory & lifecycle budgets

- **Keep the global cap (3): 1 active + up to 2 warm; destroy the rest.** Destroy = checkpoint → navigate
  `about:blank` → detach ALL listeners/registry refs → remove element → revoke object URLs → verify memory
  returns. **Never** retain `contentWindow`/`contentDocument`/serialized refs in long-lived maps (detached-
  window leak class).
- `content-visibility:hidden` is a paint optimisation, NOT a lifecycle tool (keeps DOM/JS/decoded). `loading=
  lazy` doesn't unload a loaded iframe. Page-Lifecycle freeze isn't a dependable subframe API. Suspension is
  cooperative (§5.2).

Starting watermarks (tune from real boards; distinguish owned decoded bytes from unobservable compositor
copies `[cx-P2]`):

| Budget | Start |
|---|---|
| GPU proxy / tile cache | 96–256 MiB |
| CPU decoded-bitmap cache | 96–192 MiB |
| Live runtimes | global cap 3 |
| Total page memory ceiling | ~500–750 MiB |
| Disk artifact cache (hash-addressed) | large, independently evicted |

---

## 7. GPU proxy plane — DO NOT SCHEDULE `[cx-Q8]`

Inapplicable to the live layer (draws bitmaps, can't host a live node). And **not scheduled**: DOM proxies +
culling should cover hundreds total / dozens visible. First measure body-virtualisation + spatial-index
culling + large-proxy tiling. Build WebGL2 **only if 100+ visible decoded proxies still fail the frame-time
gate after those fixes.** Keep it as a contingency appendix, not a stage.

---

## 8. What already shipped is the first tactical slice (`fix/backdrop-white-flash-zoom`)

- **Viewport culling** (`content-visibility` off-screen) → the T0 skip.
- **Motion raster-LOD** → the T1 proxy, motion-only form; the artifact pipeline (§4) generalises it.
- **Settle-behind-cover handoff** (`sh-settling`) → the R1 primitive; §5 generalises it to the pool swap.
- **Live debug HUD + capture-cost instrumentation** (`__mvDiag`) → the §11 measurement rig.
- **`will-change` reverted** off `.sh-content` — confirmed it blanks nested iframes at high zoom; do not re-add.

---

## 9. Staged plan — ARTIFACT-FIRST ordering `[cx-P1.5, cx-Q7]`

Stage 1 is **not** independently shippable: removing per-node runtimes before a canonical passive artifact
exists leaves cold nodes with nothing to show. Correct order:

1. **Protocol foundation.** Artifact identity/key, lease + document generations, the three health axes,
   deterministic placeholder, diagnostics. (No behaviour change yet.)
2. **Artifact pipeline.** Persistent proxy cache, freshness/admission, decode-before-swap, ONE background
   capture role, degradation ladder.
3. **Portal + pool in SHADOW mode.** Preserve current presentation while validating routing, alignment,
   cancellation, memory — flagged, not yet load-bearing.
4. **Enforce the global runtime cap + remove node-owned live iframes — ATOMIC with canonical decoded
   proxies.** (This is the real "Stage 1"; it lands with 2.)
5. **T2 admission** (bounded DOM tier, inspection slot) + multiresolution derivatives + cache tuning.
6. **Image tiling / GPU** only after measurement (contingency).
7. **Release gates on real boards** (continuous, §11).

---

## 10. Migration from M5

- `serialize.ts` / lean renderer unchanged, but the lean is a **bounded T2** (RuntimePool DOM-proxy slots),
  not per-node. `FrameNode` drops its permanent `.sh-lean` and `.sh-live`.
- M5 §5 slice 2 ("all frames live-mounted") is **retired**.
- **Publish/export/print** is NOT covered by "same-origin in dev+serve" `[cx-missing-P1]`: runtime capture
  would boot hundreds of apps on first view. Publish needs a **versioned artifact manifest + pre-baked
  deterministic proxies**; print/export renders from artifacts without promoting every node.

---

## 11. Test plan / gates — on RECORDED real boards

Fixtures: **500 app nodes + 500 4K images**; dense overview **100+ visible proxies**; fit-all→one-frame;
focus-cycle **20 heavy React/Next apps**; repeated cold-region pan; **1-hour** memory plateau. Re-run the two
motivating boards: **marver-site** (Next.js, white-flash) and **tms-broker** (image, zoom lag).

**Fault / model tests (P1)** `[cx-missing]`: randomized rapid focus-cycling, hung readiness, capture failure,
stale messages, theme/nav during capture, slot reuse, play entry, tab backgrounding, forced cache eviction.
**Assert the live count after EVERY transition**, not just at the end.

Gates: no blank frame any transition (R1) · camera **p95 < 20 ms** on the Air · no gesture long-task > 50 ms
from capture/serialize/decode · **runtime count ≤ cap always** (R3) · caches return below watermark after nav
· focused DOM crisp at every zoom (R2) · proxy-vs-first-live-paint pixel-diff within tolerance.

**Precede with the 1-day spike — against the HEAVIEST real marver-site + tms-broker frames, not a 200-box
demo** `[cx-next-step]`. It must prove:
1. One overlay runtime hard-cuts against its proxy with **no blank and no viewport reflow**.
2. A 3-slot pool survives rapid focus-cycling + capture failure + stale messages **without exceeding cap**.
3. Proxy production cost, fidelity, and memory plateau are acceptable on real heavy frames.

If those pass → ship the architecture. If proxy generation fails → revisit the passive-artifact producer,
NOT the bounded-runtime thesis.

---

## 12. Resolved decisions (codex answers folded in)

- **Q1 capacities** → global cap **3** total runtimes; interactive 1 (2 compare); T2 start 2 (→4 measured);
  `deviceMemory` reduces only; play-stage + capture count in the same budget. (§3, R3)
- **Q2 heuristic** → §2.3 state machine + epochs; motion cancels T2/capture. (§2.2–2.3)
- **Q3 Safari** → **Chromium-first authoring**; Safari read/publish consumes precomputed raster artifacts +
  promotes ONE live on focus; bounded T2 is an optional fidelity fallback, never the passive plane. NOT
  "one T2 per visible node" and NOT "always live when visible" (both restore the scaling problem).
- **Q4 moving runtimes** → single permanent overlay portal, no movement; `Element.moveBefore` optional;
  `appendChild` = reload. (§3, §5.1)
- **Q5 alignment** → §5.1 (world-size viewport + local camera matrix; verify rects + two paints).
- **Q6 bridge/security** → §5.2 capability negotiation + deadlines + size/schema limits + memory-only
  transient.
- **Q7 sequencing** → §9 (Stages ship 1+2+min-3 together; pool prototyped behind a flag first).
- **Q8 GPU** → §7 (don't schedule; contingency only).

### Remaining open items for the spike to settle
- Exact pixel-diff tolerance for T1 acceptance (R1 vs perceptible drift).
- Whether the "T4 tracks camera during a fling" exception (§2 rule 2) is ever visibly worse than pre-covering.
- Real proxy-generation cost distribution on the heaviest frames (gates the whole thesis).

### Missing requirements now in-scope `[cx-missing]`
- **Comments/laser:** cold proxies can't resolve live anchors ([Comments.tsx](src/client/shell/Comments.tsx)
  polls the live iframe every 4 s). Store capture-time anchor geometry/semantic hit data, OR require
  promotion before element interaction. Global laser-over-all-visible is incompatible with T4=1 → redesign
  explicitly (laser drives the raster/proxy layer, or promotes).
- **Play mode:** entering play must release/pause canvas leases, or the stage counts in the global cap.
- **Accessibility:** accessible node summaries + keyboard-driven promotion; warm/T2/live duplicates must not
  coexist in the a11y / tab order; focus restores to shell after handoff.
- **Deep links:** boot-selection + comment links get first artifact/runtime priority; comment deep links must
  not start anchor resolution against an unleased iframe.
- **Collaboration / privacy:** deterministic source artifacts may be shared; transient proxies + checkpoints
  may hold personal data → viewer-local unless explicitly approved; board/HMR revisions invalidate leases +
  artifacts atomically.

---

*Basis: codex deep-web pass + research-agent teardown (both converged), then a codex spec review (verdict
REVISE → all P1s folded into this v2). Chromium process-model & image-decode-cache; MDN `Element.moveBefore`,
`ImageBitmap.close`, `createImageBitmap`; OpenSeadragon/IIIF; tldraw SDK perf + EmbedShapeUtil; Figma
"professional design tool on the web" + WebGPU renderer.*
