# SPEC-M6 — Scalable canvas: crisp-DOM-first, frame-type-aware, bounded live apps

Status: **v3 — the raster-primary bet is RETRACTED.** v1/v2 (codex-reviewed) made a flat raster image the
default passive + motion representation. Dogfooding (2026-08-16, tms-broker `shipper-flows`) proved that is
wrong: a full-frame image jiggles under motion, cannot reflow (line-returns differ moving vs settled), and
ruins mermaid — the *exact* failures M5's DOM snapshot was built to fix. It also slowed load (an
`html-to-image` per frame). **v3 pivots to the model Nic specified and the research actually supports:** the
compiled DOM snapshot (pixel-perfect HTML+CSS) is the **universal default** at every zoom/theme/device/resize;
the **full live web app runs ONLY when a frame is active** (interactive / laser / comment / prototype),
bounded by a small pool; optimisation is **frame-type-aware** — markdown/image/mermaid frames are cheap and
need only per-image resolution LOD, while heavy web-app frames get the full DOM-snapshot treatment; reachable
next frames are **pre-warmed**. **No full-frame raster of any frame, ever.** Supersedes v2's tier table.
Retains M5's serializer + lean renderer (now the universal default, not a bounded exception) and the shipped
culling + settle-handoff. The shipped motion raster-LOD is REMOVED (§9). Open decisions for codex in §12.

Reference correction (v2 was wrong here): the right lodestar is **tldraw** — the one product that hosts live
web on a zoomable canvas — which keeps shapes as **crisp DOM**, does **per-image** resolution LOD, and
**activates the live embed only on click**. Figma/Miro's raster tiles are for *vector/bitmap* content, not
live apps, and pulled v2 the wrong way.

---

## 0. Why v3 (the retraction)

| v2 bet | What dogfooding showed | v3 |
|---|---|---|
| Raster (image) = default for every passive node + all motion | Text jiggles, "everything moves around", mermaid weird — a bitmap can't reflow or re-theme | DOM snapshot is the default at all times; **no full-frame raster** |
| Crisp DOM demoted to a 2–4 cap | The DOM crispness *is* the differentiator; users see the image degrade | DOM snapshot is universal; live app only when active |
| One-size raster pyramid | A markdown page and a heavy React app got the same expensive treatment | **Frame-type-aware**: cheap frames stay cheap; only heavy web-apps get heavy optimisation |
| Eager `html-to-image` per frame | ~1s/frame on image-rich boards → slow load | No per-frame capture; image LOD is per-`<img>`, lazy + debounced |

**The core realisation (Nic):** Marver is not one content type. A board of markdown + a few images is
featherweight; a board of 4–5 heavy web-apps is not. Optimisation must be **per frame type**, and the crisp
DOM snapshot — not an image — is what keeps every frame pixel-perfect across theme, device, resize and motion.
Run the *full* web app only where it's actually being used.

---

## 1. Invariants — what must not break

Inherits M5's F1 (exact color) and F2 (exact reflow). New / promoted:

- **Q1 — Pixel-perfect at every state.** Every visible frame is pixel-perfect — same layout, color, and
  look — **at rest AND during motion**, across theme switch, device sweep, resize, and pan/zoom. Nothing a
  user sees is ever a stretched or re-sampled bitmap of a frame. (This is now the top invariant; it is what
  the raster violated.)
- **R2 — Real app only where used.** The genuine live web app runs when and only when a frame is active
  (interactive / laser / comment / prototype). Everything else is its crisp DOM snapshot.
- **R3 — Bounded live set.** Concurrent live web apps NEVER exceed the pool cap, regardless of board size /
  zoom / pan speed. Node count unbounded; live-app count hard-capped.
- **R1 — Never blank / never wrong.** A frame's current crisp visual is never removed until its replacement
  has painted; a stale snapshot is marked stale and reconverges, never shown as if fresh.

---

## 2. Frame taxonomy → representation (the core of v3)

Classify each frame **cheaply from its already-serialised DOM** (the lean serializer walks it anyway): node
count, image pixel-area, presence of a mermaid/SVG diagram, and JS-liveness (does it keep mutating after
`ready`?). Four classes, four optimisation profiles:

| Class | Detect | Default representation | Optimisation it needs |
|---|---|---|---|
| **A · Markdown / prose** | few nodes, no big images, no canvas/video, quiet after ready | DOM snapshot | ~none. It's already trivial. |
| **B · Image-heavy** | large `<img>`/background pixel-area | DOM snapshot | **per-image resolution LOD** (§5) — the only real cost |
| **C · Diagram (mermaid/SVG)** | baked `<svg>` from mermaid/similar | DOM snapshot (SVG inlined) | **SVG parity** (§6) — vector, so infinitely crisp for free |
| **D · Heavy web-app** | many nodes, JS-live, real layout (React/Next/RR/any stack) | DOM snapshot (compiled HTML+CSS) | the full treatment — this is the bandwidth killer; live only when active |

The point Nic made and v2 missed: **A/B/C are nearly free and must not pay web-app tax.** Only class **D**
warrants the heavy machinery. A canvas of A+B+C frames should be featherweight even at hundreds.

---

## 3. Two representations per frame — and only two (raster is gone)

1. **Crisp DOM snapshot (default, all frames, all the time).** The M5 scriptless `<iframe srcdoc>`: post-
   render DOM + inlined CSS, JS stripped. Pixel-perfect, reflows natively, theme-flips by attribute, device-
   sweeps as real CSS. This is a *compiled* form of the app (Nic's "compile to HTML+CSS so it's pixel-perfect
   no matter theme/device/screen") — and because it re-rasters *natively*, it is **crisp at any zoom** (a
   DOM re-raster is sharp; only a bitmap is blurry). It is what you see at rest and in motion.
2. **Full live web app (active frames only).** The genuine running app, mounted **only** when the frame is
   interactive / laser / comment / prototype, from a bounded pool (§4). This is Marver's differentiator, kept
   real exactly where it matters.

There is no third "image" representation. The v2 raster tier is deleted.

---

## 4. The live-app pool (bounded, active-only, pre-warming)

Today every node mounts BOTH a live iframe and a lean iframe for life — that double-mount is the single
biggest cost. v3: passive frames mount **only** the crisp DOM snapshot; the live app is lent by a pool.

- **Cap: small (start 3–4 concurrent live apps), LRU.** Only active frames (interactive/laser/comment/
  prototype) hold a live app; leaving the active state demotes back to the crisp snapshot behind a covered
  hard-cut (the shipped settle-handoff primitive). R3 holds by construction.
- **Pre-warm reachable frames (Nic).** In **interactive/prototype** mode we know the reachable next frames
  (the `data-goto` targets, the prototype graph). Warm those in advance — mount + boot + cover with their
  crisp snapshot — so a click transition is instant. In **laser/comment** mode, keep the frames the user is
  hovering warm. Warm apps are `inert`, `aria-hidden`, `opacity:0`, fully covered by their snapshot; evicted
  first under pressure.
- **Promote/demote** ride the shipped covered-hard-cut: snapshot covers → live boots behind → ready-gated
  (fonts + two paints) → hard-cut. Never a crossfade (M5's 1–2px ghosting).

---

## 5. Image-resolution LOD — the ONE thing we scale by resolution

Not full frames — individual **images** inside B-class frames (and images inside any frame). The tldraw/Miro
image recipe, and exactly Nic's ask ("lower the image resolution when zoomed out, make it clear as you zoom
in, with a light debounce so it doesn't load on every zoom step").

- Serve each `<img>` at a resolution matched to its **on-screen** pixel size: `srcset` + `sizes`, or swap the
  `src` to a stepped derivative (¼/½/1×/2×) chosen by `worldW × zoom × dpr`, snapping on power-of-two
  thresholds.
- **Debounced + lazy:** upgrade resolution only after the camera **settles** (~150–250ms), never mid-gesture,
  and keep the current (lower-res) image until the higher-res **decodes** (`img.decode()`), so zoom-in is
  smooth and never flashes. Coarse image stays until the finer one is ready.
- Very large images (uploaded photos, once first-class image nodes exist) use real **tile pyramids**
  (DZI/IIIF, 256–512px, decode only visible tiles). Ordinary in-frame images just need the stepped `srcset`.
- Respect a decode budget (128–256MB); `createImageBitmap`→draw→`ImageBitmap.close()` on eviction; `Blob`
  URLs, not retained base64.

This keeps the **DOM structure crisp** (never a frame bitmap) while making images cheap when small/zoomed-out
and sharp when zoomed-in.

---

## 6. Diagram (mermaid/SVG) parity

Mermaid renders to an inline `<svg>`. In the snapshot it is inlined as vector → **infinitely crisp at any
zoom for free** (no raster, no LOD). The one requirement is **parity with laser/comment**: the snapshot's
mermaid must equal what the live frame shows in laser/comment mode. Two rules:

- Capture the snapshot **after** mermaid has finished rendering its SVG (the M5 `domQuiet` settle already
  does this — it exists precisely because lazy mermaid renders after `ready`). Never capture mid-render.
- The snapshot must **not** bake laser/comment chrome (outline styles, hover highlights) — capture only when
  those modes are off (the M5 `modeActive()` guard). A theme change re-captures (baked SVG colors can't be
  attribute-flipped) — already handled by keying the snapshot on theme.

Result: mermaid frames are class-C, effectively free, and identical across rest / motion / laser / comment.

---

## 7. Motion cost — why crisp DOM is acceptable now (the honest part)

A DOM snapshot is still an `<iframe>`, so it re-rasters at the zoom scale during motion — the cost that drove
v2 to images. v3 accepts a **crisp** re-raster over a **blurry** bitmap, and makes the cost affordable with
four levers instead of hiding it behind an image:

1. **Half the iframes.** Passive frames mount only the snapshot, not snapshot **+** live app. The double-mount
   was the dominant cost.
2. **Culling** (shipped). Only on-screen frames render; a deep zoom into one frame stops the other ~N−1
   entirely.
3. **Frame-type weighting.** A/B/C frames are cheap to re-raster; only D frames are heavy, and there are few
   of those per board. A markdown-heavy board pays almost nothing.
4. **Deep-zoom escalation.** When one frame fills the screen (the case culling can't help), it is the
   *selected/inspected* frame → promote it to the **live app** (or keep its crisp snapshot, which re-rasters
   sharp). The heavy-motion-of-many-frames case does not occur at deep zoom.

**Honest trade:** a board of many **D-class** frames, all visible, in continuous motion, will re-raster more
than a raster-primary design would — crisp but potentially less buttery on the very heaviest boards. That is
the deliberate choice: **fidelity first** (Nic's differentiator). The levers above make it affordable for
realistic boards (dozens of frames, a few heavy); the extreme is bounded by culling + the pool, not by
degrading to images. Whether it's smooth enough on the heaviest real boards is the spike's job (§11) — and if
a specific board is still choppy, the fallback is *more culling / smaller live cap*, never a frame bitmap.

---

## 8. Research alignment (take inspiration, keep our specificity)

- **tldraw** (our closest analog — live web on a zoomable canvas): crisp **DOM** shapes, off-screen
  `display:none`, **per-image** power-of-two resolution LOD, embeds `pointer-events:none` and activated on a
  deliberate gesture. → v3 §3/§4/§5 mirror this directly.
- **Miro:** image LOD (120px preview + ÷2 mipmap by on-screen size). → §5.
- **Figma:** raster/GPU tiles — for **vector** content, **not** live apps; caps live embeds at **one**. → we
  take "few live at once", we reject "raster the frames".
- **Marver's specificity:** we uniquely *own the repo runtime, same-origin*, so we can (a) **compile any
  frame to a faithful DOM snapshot** (most products can't — they screenshot), and (b) cooperatively pause /
  pre-warm reachable frames. That's why crisp-DOM-first is available to us and not to a generic embed tool —
  it's our edge, and v3 leans into it instead of copying Figma's bitmap tiles.

---

## 9. What's shipped — keep, and what to REMOVE

On `fix/backdrop-white-flash-zoom`:

- **KEEP · viewport culling** (`content-visibility` off-screen) — §7 lever 2.
- **KEEP · settle-behind-cover handoff** (`sh-settling`) — the promote/demote cover primitive (§4), now
  between snapshot and live app (not snapshot and image).
- **KEEP · `will-change` reverted** off `.sh-content` (blanks nested iframes — never re-add).
- **KEEP · `__mvDiag` HUD** — the §11 measurement rig.
- **REMOVE · the motion raster-LOD** (`raster.ts`, the `sh-raster` `<img>`, `bridge.js` `captureRaster`, the
  `body.sh-cam` image-swap CSS). It reintroduced images. The crisp DOM snapshot is shown at rest **and**
  motion; the only motion optimisation is culling (+ image-resolution LOD for B frames).

Net after removal: back to **crisp DOM lean, always** + culling + handoff — Nic's original, minus the
regression — as the foundation v3 builds the pool + frame-type-LOD on.

---

## 10. Staged plan (impact-ranked)

1. **Remove the raster layer; snapshot is the sole passive representation, rest + motion.** Immediate: crisp
   restored. (Small, do first.)
2. **Bounded live-app pool.** Passive frames mount only the snapshot; live app lent to active frames (cap 3–4,
   LRU). This is the scale unlock (drops the double-mount). Promote/demote on the shipped handoff.
3. **Frame-type classifier** (A/B/C/D from the serialized DOM) + route each to its profile.
4. **Per-image resolution LOD** for B frames (srcset/stepped src, settle-debounced, decode-before-swap).
5. **Pre-warm reachable frames** in interactive/prototype (goto/prototype graph) and hovered frames in
   laser/comment.
6. **Mermaid/SVG parity checks** (capture-after-render, no-mode-chrome) as an explicit test.
7. **Release gates on real boards** (§11).

---

## 11. Test plan / gates — on RECORDED real boards

Boards: **marver-site** (heavy D-class Next.js), **tms-broker** (mixed — image-heavy B + mermaid C + prose A +
some D). Also synthesise a **500-A-frame** board (must be featherweight) and a **20-D-frame** board (the hard
case).

Gates:
- **Q1 pixel-perfect:** snapshot == live for color + reflow, at rest AND mid-motion, across theme flip +
  device sweep + resize. No visible jiggle, no reflow difference moving↔settled, mermaid identical to
  laser/comment. (This is the invariant the raster broke — assert it explicitly with a computed-style +
  layout diff, not eyeball.)
- **R3:** live-app count ≤ cap, always, under rapid focus-cycling.
- **A/B/C frames are cheap:** a 500-A-frame board loads fast and pans/zooms at p95 < 20ms with no capture
  cost. Image frames upgrade resolution only after settle, never mid-gesture, never flash.
- **D frames:** camera p95 < 20ms on the Air with culling + pool; deep-zoom into one D frame is crisp (live
  or native snapshot re-raster), never blank.
- Pre-warm: a prototype/interactive transition to a reachable frame is instant (no boot flash).

---

## 12. Open decisions for Codex (review this v3)

- **Q1 — Live-app cap.** Is 3–4 concurrent live apps the right start, or should it scale with `deviceMemory`?
  Interaction with pre-warm (a warmed reachable frame is a live app — does it count against the cap)?
- **Q2 — Frame-type classifier.** Is "classify from the serialized DOM (node count / image-area / mermaid-SVG
  / JS-liveness)" robust, or does a frame need to *declare* its class in frontmatter? What misclassifies (a
  markdown page with one huge hero image; a mostly-static React page)?
- **Q3 — Does crisp-DOM-in-motion actually hold on a heavy D board** without the raster crutch, given culling
  + half-the-iframes + pool? If not, what's the *fidelity-preserving* fallback (smaller live cap? lower the
  snapshot's own raster scale during motion via a crisp-preserving trick? cap max simultaneous D frames)?
  Explicitly: is there any crisp option better than "just re-raster the DOM"?
- **Q4 — Per-image LOD mechanism.** `srcset`/`sizes` vs JS `src` swapping vs a stepped derivative service —
  which, given frames are arbitrary same-origin apps we don't control the markup of? Can we rewrite `<img>`
  in the *snapshot* (which we do control) without touching the live app?
- **Q5 — Pre-warm policy.** How many reachable frames to warm (prototype graphs can fan out), and the evict
  order vs the interactive frame + LRU. Does pre-warm risk exceeding R3?
- **Q6 — Mermaid parity edge cases.** Beyond capture-after-render + no-mode-chrome, any mermaid/theme/font
  case where the inlined SVG still diverges from live (web-font metrics, `foreignObject` inside the SVG)?
- **Q7 — Sequencing.** Is "remove raster (Stage 1) → pool (Stage 2)" safe, i.e. does removing the raster
  regress motion enough to be unshippable before the pool lands, or is culling + crisp-DOM already
  acceptable as an interim (0.5.x) while the pool is built?

---

*v3 written after Nic's frame-type-aware direction (2026-08-16), retracting the v1/v2 raster-primary bet.
Reference: tldraw (DOM shapes + per-image LOD + activate-on-click) — the correct analog for a live-web-app
canvas — over Figma/Miro raster tiles. Retains M5's serializer/renderer and the shipped culling + handoff.*
