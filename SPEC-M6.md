# SPEC-M6 — Scalable canvas: crisp-DOM-first, frame-type-aware, bounded live apps

Status: **v3.2 — build-ready.** Three codex reviews have confirmed the thesis (crisp DOM is the universal
representation; raster stays dead; live apps are bounded and active-only) and progressively hardened the
lifecycle. v3.2 resolves the last five P1s from the v3.1 review: the **cold-bootstrap contradiction** (a
deterministic placeholder, only leased frames ever mount live — §4.2), **artifact identity end-to-end** (a
real per-frame `revision`, conservative invalidation, a publish artifact schema — §4.1/4.3/4.6), the
**JS-responsive contract** (chosen, not offered — §4.5), **coarse-image-at-serialize** so an original is
never fetched first (§6), and a **consistent single-vertical-slice sequencing** (§12). The governing
invariant, and the first thing to build: **no live iframe — FrameNode, Play, compiler, warm, or fallback —
may be created without a synchronous Live-Lease grant.** Retains M5's serializer/renderer; the motion
raster-LOD is removed. Reference: tldraw.

---

## 1. The problems, and exactly what fixes each

| Problem we hit | Root cause | The fix |
|---|---|---|
| Whole-viewport **white flash** on zoom | N live iframes re-raster at scale → GPU tile starvation | Live-lease pool (§5): ≤3 apps ever live; the rest are cheap DOM snapshots + culling. |
| **Deep-zoom blank/lag** on a rich frame | one large iframe re-rastering at high scale | The inspected frame promotes to live/native-crisp (§5.3); it's the only heavy thing on screen. |
| **tms-broker laggy** (10 image + 10 mermaid — not web-apps) | re-decoding big images at scale | **Per-image LOD** (§6): coarse zoomed-out, sharp on settle. Mermaid = inline SVG, crisp free (§7). |
| **Text jiggle / images look bad** | the raster facade | Removed. Crisp DOM snapshot at rest AND motion (§2). No frame is ever a bitmap. |
| **Reflow differs moving vs still** | a bitmap can't reflow | Same DOM snapshot both states → identical reflow (§2). |
| **Slow board load** | eager `html-to-image` per frame | Removed. Snapshots compile from DOM (~ms), one background compiler, capped (§4). |
| **Mermaid weirdness** | bitmap of a diagram, mid-render | Inline SVG, captured after render, theme-keyed, no mode-chrome (§7). |
| **Hundreds of apps + images** (goal) | can't run hundreds of live iframes | Hundreds of cheap crisp snapshots + ≤3 live; frame-type-aware so light frames stay light (§3). |

Honest boundary (§9): a board of **many heavy web-apps all visible in continuous motion** re-rasters the
crisp DOM natively — crisp, but not as buttery as a bitmap. Deliberate fidelity-first trade; mitigation is
culling + pool + an honest density ceiling, never a frame image.

---

## 2. Two representations, only two

1. **Crisp DOM snapshot — universal default, rest AND motion.** M5's scriptless `<iframe srcdoc>`. Pixel-
   perfect; reflows natively; theme-flips by attribute; device-sweeps as real CSS; re-rasters crisp at any
   zoom. A *compiled* HTML+CSS form of the app.
2. **Live web app — active frames only** (interactive / laser-pick / comment-pick / prototype), from the
   bounded pool (§5).

No third "image" representation.

---

## 3. Frame profiling — independent capability axes (per-axis overrides)

Not one A/B/C/D label — the classes overlap. Profile on independent axes, auto-detected + optionally
overridden **per axis** (a single categorical override would fight the model):

| Axis | Signal | Drives |
|---|---|---|
| DOM/paint weight | node count, CSS bytes | recapture + motion cost |
| Image weight | `<img>`/bg pixel-area | per-image LOD (§6) |
| Diagram | inline mermaid/SVG | SVG parity (§7) |
| Runtime dynamism | timers/sockets/mutations after ready — **boot-time instrumented**, not just `domQuiet` | staleness/TTL, pre-warm value |
| Snapshot compatibility | canvas/video/shadow/oversized/xo-CSS | **incompatible → counted live lease** (§4.4) |
| JS-responsiveness | ResizeObserver / JS-measured layout — boot-time instrumented | the §4.5 contract |

`kind`/`intent` are not predictive; don't overload them. Optional manifest override: `meta.render: { profile?,
image?, diagram?, dynamic?, responsive? }` (per-axis), `auto` normally. Minimum profiling (compatibility +
dynamism + responsiveness) **lands with the lifecycle**, not after it (§12).

---

## 4. Passive-Artifact Lifecycle — the cold-frame protocol

### 4.1 Identity & states
Artifact key = **`frameRevision + theme + deviceWidth + capture-engine-version`**. `frameRevision` is a real
new field: the **server computes a content hash** of the frame's module graph on scan/HMR (added to
`FrameEntry` / the manifest — today only a node-local `nav` nonce exists, which is insufficient). States:
```
missing → waiting → compiling → ready → stale → (incompatible | error)
```
`waiting`/`missing` render a **deterministic placeholder** (§4.2). `stale` stays visible, marked, and
reconverges async (R1). `error` on first capture → placeholder, retry-with-backoff, then live-on-focus only.

### 4.2 Cold bootstrap (resolves the cap contradiction)
- **A frame with no ready artifact shows a deterministic placeholder** (its box + title + theme ground + a
  faint skeleton) — NOT a live app. This is the never-blank guarantee for cold frames.
- **Only a frame holding a lease may mount a live document.** Near-viewport frames are granted a
  **background-compile lease** (counts against the cap, §5) one at a time: boot hidden → serialize → release
  the runtime → admit the artifact behind the placeholder with a hard-cut. On a 20-frame board, at most one
  compiles at a time; the other 19 show placeholders until their turn, then go crisp. No board ever mounts
  more than the cap.
- First-view latency on a heavy board is "placeholders fill in over the first seconds," capped and jank-free
  — vs the old eager `html-to-image` that booted everything.

### 4.3 Invalidation (conservative for unmapped deps)
- **Content:** `frameRevision` change → `stale` → recompile.
- **Theme:** CSS-only snapshots flip by attribute (no recapture); baked content (mermaid/D-class) is
  theme-keyed → precompile both variants or recompile behind the stale cover.
- **Device width:** CSS-responsive reflows natively; JS-responsive per §4.5.
- **HMR / unmapped deps:** direct design-file edits already emit shell invalidations; **theme/helpers/`src/**`
  /config changes fall back to default Vite HMR that a cold (unmounted) runtime cannot consume** → treat any
  such change as a **conservative board-wide artifact invalidation** (bump a board-level `engineRevision`
  folded into every key), recompiling lazily as frames re-enter view.
- **Dynamic frames** (timers/sockets, rare DOM change): a **TTL** (e.g. recompile on next idle if older than
  N minutes while visible) so a data-driven screen doesn't show an arbitrarily stale artifact.

### 4.4 Incompatible frames
Serializer degrades canvas/video/nested-frame/shadow/oversized → mark **`incompatible`** + a **counted
emergency-live lease** (holds a slot while visible; if more visible than slots, lowest-priority show the
placeholder, promote on focus). Future per-element surrogates (declarative-closed shadow; scoped
canvas-subtree bitmap; video poster) are compatible with "no full-frame raster."

### 4.5 JS-responsive contract (CHOSEN, not offered)
A JS-responsive frame (JS-measured layout / ResizeObserver relayout) **is treated as `incompatible` during an
active resize/device-sweep** — it holds a live lease for the duration of the sweep (so it lays out for real),
then re-settles to a snapshot **captured at the discrete target device width**. Between discrete device
presets it shows the width-matched snapshot. The mid-sweep pixel-parity gate is **explicitly relaxed for the
JS-responsive axis only** (a documented residual): every *other* frame is pixel-perfect mid-sweep; a
JS-responsive frame is pixel-perfect at each settled device width and shows its real live layout while the
sweep is in flight.

### 4.6 Publish / export (schema, not just "Playwright")
- **Artifact schema:** published boards emit `artifacts/{frameId}/{theme}-{deviceWidth}.html` + an
  `artifacts/manifest.json` mapping `frameId → {revision, variants[]}`. The client loads the matching artifact
  directly — no boot-on-view.
- **Compiler ownership:** the `marver build` step runs a **sequential, capped, clean-boot** compiler (headless
  Chromium / Playwright, added as a build-only dependency) producing the theme×deviceWidth matrix.
- **Build-failure behavior:** a frame whose compile fails (or that is `incompatible`) ships with a **live
  fallback flag** — it boots live on view in the published board (today's behavior), never blank. Publish
  never fails the whole board for one frame.
- **Privacy:** persist only deterministic clean-boot state; never viewer form/session data.

---

## 5. Live-Lease Arbiter — the pool (the governing invariant)

**No live document is created anywhere without a synchronous arbiter grant** — FrameNode, Play stage,
background compiler, pre-warm, or incompatible-fallback. This is enforced at construction (§ first
increment), not by after-the-fact cleanup.

### 5.1 Capacity
- **Fixed cap = 3 live documents** (2 on constrained devices; `deviceMemory` may only reduce). **Every**
  running document counts: active, background-compile, pre-warm, outgoing-during-handoff, incompatible-lease,
  **and the Play stage** — Play must obtain a lease before mounting and **park (lease-release) canvas runtimes**
  while open (Canvas stays mounted behind Play today, so its runtimes must be released, not left live).
- Three slots cover: interactive/prototype target · outgoing/incoming during a handoff · one compile-or-warm.

### 5.2 Priority (evict lowest first; never exceed the cap)
```
foreground active > transition destination > outgoing handoff > incompatible on-screen lease
  > hover warm > reachable warm > background compiler
```

### 5.3 Promote / demote (rebuilt hard-cut; the raster handoff was removed)
```
PROMOTE:  placeholder/snapshot cover up → slot granted → live mounted BEHIND cover →
          restore url/scroll/theme/device + checkpoint → generation-matched ready
          + fonts.ready + two paints → HARD-CUT cover away (frame boundary)
DEMOTE:   freeze input → pause()/quiesce (deadline) → {checkpoint, visualRevision} →
          compile/admit the snapshot FROM the paused state → decode/verify → reveal → release/park
```
Never crossfade. Demote admits the replacement before tearing down the live doc (R1).

### 5.4 Bridge (capability-negotiated): `ready · pause · resume · checkpoint · restore · visualRevision`,
`{pause, checkpoint, restoreVersion}` caps, deadline+size bounded, no-op defaults so unmodified frames work.

---

## 6. Per-image LOD — coarse-at-serialize, then shell-driven upgrade (Q4)

Individual images, snapshot-only (the live app untouched):
- **At serialize (before `srcdoc` install):** replace eligible `<img>` `src`/`srcset` with a **coarse
  derivative**, stashing the original candidates in `data-mv-src`. This prevents the browser from fetching the
  full-res original the instant the snapshot loads (today the serializer clones `src`/`srcset` unchanged and
  `srcdoc` immediately fetches them).
- **At runtime, after camera settle:** a shell-side controller mutates the same-origin lean doc, choosing a
  derivative by `rendered rect × outer canvas scale × devicePixelRatio` with stepped thresholds + hysteresis
  (longer on downgrade) + **decode-before-swap**. Plain `srcset` is insufficient (the browser sees the
  iframe's CSS viewport, not the 0.12 canvas zoom) → shell drives selection.
- **Derivatives:** a build-time stepped manifest for local raster assets; **in dev**, an on-the-fly downscale
  route (or skip LOD in dev, full-res only — dev boards are small). Leave remote/signed/blob/data/SVG/animated
  and authored `<picture>` alone. Preserve intrinsic aspect (no reflow). Treat the decode budget as
  telemetry/backpressure, not a manual `ImageBitmap.close` heap (doesn't fit DOM `<img>`).

---

## 7. Mermaid / SVG parity
Inline `<svg>` → crisp free. Capture after render (extend the 400ms `fonts.ready` bound + detect late diagram
font-metric changes); no mode-chrome; theme-keyed recapture; gate `foreignObject` label font readiness;
ResizeObserver-relayout mermaid is JS-responsive (§4.5); validate `<use href>`/external SVG refs.

## 8. Laser / comment — snapshot-native (viable without live)
The lean is same-origin; the anchor ladder is ordinary DOM matching + `getBoundingClientRect`
([bridge.js](src/client/frame-host/bridge.js)), so it resolves against a fresh snapshot. **Extract the ladder
+ laser/hover/pick handlers into shared pure code** and run them on the snapshot document (grant it
pointer-events + inject the shell-owned outline/pick handlers there; today `Comments.tsx` posts only to the
live `WindowProxy` and the lean is `pointer-events:none`). Resolve anchors on artifact-generation/resize, not
a 4s poll. Only a frame the user *enters* (interact) promotes to live. `incompatible` frames fall back to
promote-on-hover (counted).

## 9. The honest motion ceiling (confirmed by codex)
The camera path already hides the covered live frame during motion, so the pool improves **boot, memory,
timers, sockets, idle CPU — not** the visible lean's motion paint. No generic fidelity-preserving flattening
exists for arbitrary isolated app documents. Levers: tighter motion culling; verified `contain` where it
yields zero layout diff; zero-JS snapshots; per-image LOD; only-visible paint. If N heavy frames are truly
visible, the paint cost is real → **accept the honest FPS + an optional visible-heavy-frame density ceiling**,
never a bitmap. Light/image/diagram boards are unaffected.

## 10. Shipped: keep culling · blur-drop · drop-live-in-motion · reverted will-change · `__mvDiag`. Removed:
the motion raster-LOD.

---

## 11. Gates — recorded REAL boards, decidable pass/fail
Boards: **tms-broker/shipper-flows** (B/C image+mermaid), **marver-site/all-scenes** (real D-class), the
heaviest real board at fit-all + several zooms, **dev AND published**. Synthetic 500-A / 20-D are stress
tests only.

- **Pixel-perfect:** snapshot==live for text/layout/color at rest AND mid-motion, across theme/device/resize;
  no jiggle; reflow identical moving↔settled; mermaid==laser/comment. Computed-style + layout diff.
  (Exceptions, documented: per-image downsampling at low zoom; the JS-responsive axis mid-sweep, §4.5.)
- **R3:** live-document count ≤ 3 **after every transition** (focus-cycle, Play enter/exit, pan-fling).
- **Motion, per board class:** camera **p95 ≤ 16.7ms + a dropped-refresh/long-task gate** (the `__mvPerf`
  sampler already reports intervals + long-tasks — use those, not "main-thread work"). **Heavy-D is
  report-only against a declared density ceiling** (decidable: pass if ≤ the ceiling's frame count; the
  ceiling is a product number, surfaced honestly).
- **Cheap frames:** 500-A loads fast, 60fps, zero capture cost. Images upgrade only after settle, never flash.
- **Never blank/stale-as-fresh:** in any transition/promote/demote/theme/HMR.
- Recorded: parse time, retained HTML/CSS bytes, image decode, renderer memory, promote latency (warm→live
  <150ms p50; cold→interactive <500–800ms p95).

---

## 12. Sequencing — one vertical slice at a time (consistent)

1. **Post-raster real-board gate.** Current crisp-DOM + culling branch on the real boards (dev + published).
   Passes → ships as **0.5.x interim** (right visual, keeps live fallback; does NOT fix heavy-D motion — fine).
2. **The governing invariant + slice 1 (atomic):** the **Live-Lease Arbiter** enforced at construction +
   **minimum profiling** (compatibility/dynamism/responsiveness) + the **Passive-Artifact Lifecycle**
   (placeholder → background-compile → hard-cut). These land as ONE slice — the lifecycle can't exist without
   the arbiter, and the arbiter is pointless without artifacts. **Proof:** 20 artifact-missing frames show
   placeholders, ≤1 compiler runs, artifacts hard-cut in after paint, rapid focus/Play never exceed 3 live
   docs, and no JSX/Play/compiler path can create a live iframe without a grant.
3. **Per-image LOD** (§6). 4. **Laser/comment snapshot-native** (§8) + **pre-warm** (reachable=1). 5. Publish
   artifact pipeline (§4.6). 6. Profiler refinements + density-ceiling tuning.

**Resolved:** cap = 3 fixed (no "4 after telemetry"); laser/comment snapshot-native; JS-responsive =
incompatible-during-sweep + width-keyed; heavy-D = honest FPS + density ceiling; publish = pre-baked artifact
manifest + live-fallback on compile failure.

**Open for the build to settle:** background-compile cadence that keeps first-paint fast without jank; whether
`incompatible` leases need a sub-cap so canvas/video-dense boards can't starve the interactive slot; the CSS
`background-image` LOD build pipeline (local assets only).

---

## First implementation increment (codex's, adopted)

**Make lease ownership a construction-time capability.** No live iframe — FrameNode, Play, compiler, warm, or
incompatible fallback — is created without a synchronous arbiter grant. Prove the one vertical slice in §12.2.
Everything else depends on that invariant being real rather than advisory.

*v3.2 = v3.1 + the last five codex P1s resolved (cold-bootstrap placeholder, artifact identity/invalidation/
publish schema, JS-responsive contract chosen, coarse-image-at-serialize, consistent single-slice sequencing)
+ per-axis profiling + Play lease accounting + snapshot-native laser ladder extraction. Thesis confirmed by
three reviews; this is the build spec.*
