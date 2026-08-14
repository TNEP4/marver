# Consult: canvas performance + reliability without breaking live features (2026-08-14)

Source: dogfooding two real projects (marver-site = Next.js 16; a TMS project = Vite/React Router).
Method: Fermi wrote the architecture brief (below the answer), Codex (high reasoning, read-only against
this repo) returned the recommendation. This doc is the decision input for the perf/reliability work
tracked in BACKLOG.md ("Canvas performance at scale" + "Concurrent user-interaction + agent-edit
resilience"). Nothing here is committed engineering yet - it is the plan of record to build against.

## The one-line thesis
**Snapshot-first presentation, stable iframe identity, bounded live residency, shell-owned recoverable
sessions.** This removes "all frames must be live and painted at all times" as an *accidental*
requirement while keeping every live-DOM feature (laser, element-comments, prototype, live-resize).

## The de-risked path (build in this order; each stage ships value alone)
- **Stage 0** - instrument + stop writing camera state into React during gestures (Canvas.tsx:321 /
  FrameNode.tsx:23 subscribe every frame to scale), fix wheel ownership, replace iframe DOM scans
  with a WindowProxy->node registry. No behavior change; kills a lot of zoom jank.
- **Stage 1** - self-healing frame sessions: generation handshake, fatal-vs-diagnostic errors
  (an app unhandledrejection must NOT card the frame), auto-retry on next HMR, replay modes on
  commit, preserve play-mode scroll. Fixes cold-boot false-fails + mid-edit dead cards + mode loss
  WITHOUT any snapshots.
- **Stage 2** - snapshot facade (real browser screenshots, cached; publish pre-bakes them): show
  snapshots during pan/zoom, resize target exempt, crossfade live back on settle. Fixes the white
  flash while keeping all iframe state and the iframe law.
- **Stage 3** - visible working set + `content-visibility` suspension behind snapshots.
- **Stage 4** - deep hibernation (navigate long-cold iframes to a dormancy doc; weighted LRU).
- **Stage 5** - screen-space live-surface portal ONLY if Stages 2-4 miss the p95<16ms gate.

Key corrections to our strawman: (1) the lifecycle is 4 orthogonal axes, not one linear state -
residency / presentation / interaction / health-with-generation-id. (2) We use `createRoot` not
`hydrateRoot`, so "Next hydration causes the flash" is UNPROVEN - the real cause is raster/main-thread
cost; verify with Chrome Layers/Paint Flashing before any Next-specific workaround. (3) Images can't be
fully avoided: `content-visibility` suspends CPU but a hidden DOM has no pixels, so a real cached
screenshot is required for the non-blank-during-transform guarantee.

---

# Codex answer (full)

## Recommendation

`Snapshot → warm → live` is the right user-facing model, but it should not be one linear internal state machine. It conflates four different concerns:

| Axis | States |
|---|---|
| Residency | `hibernated` / `mounted` |
| Presentation | `snapshot` / `live pixels` |
| Interaction | `passive` / `interactive` |
| Health | `queued` / `booting` / `ready` / `updating` / `failed`, with a generation ID |

This distinction matters. A frame can be mounted but covered by a snapshot during pan; ready but passive in laser mode; failed while continuing to show its last good snapshot; or hibernated without deleting its stable iframe element.

The intended operating policy should be:

- Off-screen: snapshot, then hibernate after a grace period.
- Near viewport: mounted behind its snapshot.
- Visible and stationary: live pixels, passive iframe.
- Selected: keep mounted.
- Interact/comment/resize target: live and interactive.
- Laser or comment-pick mode: all visible frames live/passive-interactive as required.
- Active canvas pan/zoom: snapshot over every frame except the actively resized frame.
- Play: unchanged single stage iframe.

Internally, keep the stable node wrapper and iframe element. Deep hibernation can navigate that same iframe element to a tiny dormancy document, then restore it by assigning `.src`; it does not require React to remount a different iframe element.

A useful invariant would become:

> One stable iframe element per node key. Its document may move between dormant and frame-host generations only by assigning `.src`.

That preserves the important part of the existing iframe law while allowing memory to be reclaimed.

## 1. Snapshot mechanism

There is no browser API that is simultaneously faithful, automatic, cheap, and capable of rasterizing an arbitrary DOM subtree.

- SVG `foreignObject` is not suitable as the primary path. It requires serializing styles, fonts, images and namespaces; canvas, video, shadow DOM, external resources and framework mutations are troublesome.
- `html2canvas` explicitly reconstructs the page from DOM/CSS rather than taking a real browser screenshot, supports only properties it implements, and is restricted by tainted resources. It is acceptable as a best-effort dev fallback, not as Marver’s canonical snapshot format. [html2canvas limitations](https://html2canvas.hertzen.com/documentation)
- Screen Capture is faithful but requires an explicit user-selected surface every time and cannot be silently used per frame. [W3C Screen Capture specification](https://www.w3.org/TR/screen-capture/)
- View Transitions create native static snapshots, but those snapshots are transient pseudo-elements and are destroyed after the transition; they are not an exportable frame cache. [View Transition lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using)
- `content-visibility:hidden` preserves cached rendering state and skips rendering work, making it a good suspension primitive. It does not leave pixels visible and does not stop iframe JavaScript, timers, subscriptions, WebSockets, or React effects. [content-visibility documentation](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)

Therefore:

1. Use actual browser screenshots as the durable snapshot.
2. Generate them asynchronously with Playwright/CDP or equivalent browser automation.
3. Never capture at gesture start. Gesture-time switching must use an already cached snapshot.
4. Use `content-visibility:hidden` inside the iframe root as a short-term suspended state behind the snapshot.
5. Navigate long-cold iframe documents to a dormancy URL to reclaim application memory.

For publish, capture after the static bundle has been produced, using the same generated frame-host page. Wait for:

- the generation’s committed-ready signal;
- content-frame measurement to settle;
- `document.fonts.ready`;
- image decoding;
- two animation frames;
- an optional bounded application settle window.

Capture exact board-instance keys such as:

```text
frame source revision + width + height + theme + snapshot schema
```

Deduplicate identical instances, but never deduplicate merely because two nodes share a variant group.

For dev, run a single-concurrency background capture worker after a frame successfully commits and the edit stream has been quiet briefly. Keep the last good snapshot while a newer one is pending.

A publish snapshot build executes application code that today is only bundled. Run capture with no user cookies, `?marverCapture=1`, restricted external network access, and a documented analytics/side-effect suppression hook.

### Can images be avoided?

Only partially.

- For off-screen CPU reduction, yes: keep the iframe mounted and use `content-visibility:hidden`.
- For a guaranteed non-blank image during a parent transform, no. A hidden DOM has no visible pixels, and cached rendering state is not a guaranteed retained compositor texture.
- A screen-space iframe portal could reduce the need for snapshots, but it still cannot guarantee that the browser never evicts a large iframe surface.

The reliable answer is a hybrid: bitmap facade for presentation, retained DOM for short suspension, dormant navigation for deep virtualization.

Also note that Marver currently calls `createRoot`, not `hydrateRoot`, in the frame host. The observed “Next frame” is a Next-originated component graph, but this path does not establish that Next hydration itself causes the white flash. See [frame-host/main.tsx](/Users/nictouron/marver/src/client/frame-host/main.tsx:49). A pre-baked snapshot should remain visible until the current live generation commits; it should never be assumed to “survive hydration.”

## 2. The white flash

My ordering is:

1. Snapshot during canvas transforms.
2. Measure a screen-space live-surface portal if needed.
3. Use containment/layer hints only as supporting experiments.

### Snapshot during transform

This is the safest fix because the user never observes the unstable iframe surface while its ancestor transform is changing.

- At pan/zoom start, reveal already-decoded snapshots synchronously.
- Keep live iframe documents mounted underneath.
- Do not snapshot the frame actively being resized.
- At gesture end, wait approximately 120–200 ms, then restore visible frames over one or two frames rather than all at once.
- Keep the snapshot behind the iframe during the crossfade, so a delayed first live paint does not expose the card background.

### Screen-space iframe layer

A later structural option is to keep node chrome and snapshots in the transformed world but portal only the visible live iframe elements into a fixed overlay layer. Each overlay surface receives:

```text
translate(screenX, screenY) scale(canvasScale)
```

This avoids one enormous transformed subtree containing every iframe. It is plausible for the one active frame plus a small visible warm set.

It is also high-risk:

- clipping and corner radii;
- z-order with captions and comment cards;
- wheel ownership across browsing contexts;
- coordinate mapping for element pins;
- device pixel ratio and browser page zoom;
- group drag and resize transitions;
- current message routing’s reliance on `iframe.closest('[data-node]')`.

I would not start there.

### Layer hints

`contain`, `will-change`, and `backface-visibility` cannot guarantee retention. The CSS specification explicitly treats `will-change` as a hint, and user agents may decline layer promotion when too many layers would exhaust resources. [CSS Will Change specification](https://www.w3.org/TR/css-will-change/)

Chromium tiles large layers, prioritizes tiles heuristically by proximity, and allocates them within a GPU memory budget. That makes eviction/raster delay expected under pressure rather than author-controllable. [Chromium compositing architecture](https://chromium.googlesource.com/website/+/1eb05d4b45d585e7e190b3a8103b794be77df56e/site/developers/design-documents/gpu-accelerated-compositing-in-chrome/index.md)

Use `contain:layout paint size` where valid to reduce invalidation and keep `will-change` gesture-scoped, as Marver already does. Do not ship `translateZ(0)`/`backface-visibility:hidden` as a claimed fix.

Why is Next worse? The verified fact is that the heavy Next-originated frame triggers the problem. The causal factor is more likely its raster and main-thread cost—larger DOM, images, fonts, fixed/sticky elements, filters, effects and runtime work—than the framework name itself. Confirm with Chrome’s Layers, Paint Flashing, long-task trace and GPU-memory behavior before adding a stack-specific workaround.

## 3. Laser, comments and resize

### Promotion policy

Use world-coordinate visibility calculated once per animation frame from `{tx, ty, scale}`. Fifty AABB intersections are trivial; this does not need an R-tree.

Suggested thresholds:

- Warm at 1.25 viewport margins.
- Keep warm until outside 2 viewport margins for 3 seconds.
- Hibernation eligible after 30–60 seconds outside the larger margin.
- Never hibernate selected, interacted, resized, comment-card-hosting, or play-stage frames.
- Limit normal mounted residency to a measured budget, initially perhaps 6–10 heavy frames.
- Laser/comment mode overrides the normal residency cap for visible frames.

State transitions happen only on threshold crossings, never on every transform callback.

### Laser

The current semantic contract requires all visible frames to show outlines, so all visible frames must be warmed before laser becomes fully armed. Per-hover promotion would be a different feature.

Recommended behavior:

- Activating laser enters “preparing N frames.”
- Warm all visible frames with bounded concurrency.
- Replay `sh:laser` after each committed-ready.
- Enable laser pointer interaction once all visible frames are ready.
- During pan/zoom, cover them with snapshots and disable iframe input.
- On settle, warm the new visible set, replay the mode, then uncover it.

### Comments

Cache the last resolved rect together with:

```text
anchor hash + document generation + logical width + snapshot revision
```

A snapshot may display a cached pin only when those keys match. Otherwise show a stale/parked pin until the frame warms.

When a thread is opened or its frame becomes visible, warm the frame and re-resolve immediately. Replace the current unconditional four-second polling in [Comments.tsx](/Users/nictouron/marver/src/client/shell/Comments.tsx:82) with bridge-originated invalidations from debounced scroll, resize and mutation signals, plus a slow safety poll for engaged frames only.

### Resize

Selection should proactively warm a frame. On resize pointer-down:

- promote it to mounted/live;
- leave its last snapshot behind it;
- keep that frame live throughout the drag;
- snapshots cover every other frame;
- do not start applying drag deltas until the live generation is ready.

A device sweep may show width-specific pre-baked snapshots for non-focused nodes, but never scale a desktop snapshot into a mobile card and call that responsive reflow. Visible/focused instances must reflow live; off-screen instances can update their snapshot asynchronously.

## 4. Reliability model

The shell should own desired state permanently. An iframe merely acknowledges a generation.

Extend every message—not only `sh:measure`—with:

```text
node key / frame ID / document generation / message sequence
```

Use a phased handshake:

1. `sh:bridge-alive`: bridge executed, before dynamic imports.
2. `sh:booting {phase}`: theme, frame import, wrappers.
3. `sh:committed`: emitted from a React layout effect after the tree commits.
4. `sh:ready`: fonts/application-ready if needed.
5. `sh:error {fatal, phase}`.
6. `sh:diagnostic`: nonfatal `window.error` and rejected promises.

The current host sends `sh:ready` immediately after `createRoot().render()`, before React has necessarily committed, at [frame-host/main.tsx](/Users/nictouron/marver/src/client/frame-host/main.tsx:72). That should change.

Also, an arbitrary application `unhandledrejection` must not card the entire frame. Only boot failure or an ErrorBoundary render failure should be fatal.

### Recovery

On fatal failure or timeout:

- Keep the last good snapshot visible.
- Keep shell laser/comment/interact intent unchanged.
- Leave HMR connected.
- On `vite:afterUpdate`, WebSocket reconnect, or manifest revision, retry only the affected frame by assigning a fresh generation URL to the same iframe element.
- Reset the frame-host ErrorBoundary with an HMR render epoch.
- On committed-ready, replay theme, laser, pick, anchor-resolution requests and focus state idempotently.
- Use bounded exponential retries; one frame never triggers shell reload or mode reset.

Vite exposes `vite:beforeUpdate`, `vite:afterUpdate`, `vite:error` and reconnect events expressly for this kind of tooling integration. [Vite HMR API](https://vite.dev/guide/api-hmr)

The current error UI hides the iframe with `display:none` and offers only manual reload at [FrameNode.tsx](/Users/nictouron/marver/src/client/shell/canvas/FrameNode.tsx:199). Preserve the iframe/HMR connection, show the error above the snapshot, and make manual reload only a fallback.

For play mode, preserve `at`, theme and device as today, plus scroll:

- On `vite:beforeUpdate` or `beforeFullReload`, save `window.scrollX/Y` and opted-in scroll containers to `sessionStorage`.
- Restore after the same stage/frame generation commits.
- Add a stable `data-marver-scroll-key` contract for application scroll containers; arbitrary React component state cannot be generically serialized.

## 5. Cold boot and the optimizer race

Marver already includes `marked` and `mermaid` in `optimizeDeps` and scans frame entries in [dev.ts](/Users/nictouron/marver/src/server/dev.ts:69), so repeating that configuration is not a sufficient fix.

Vite can rerun pre-bundling and reload when it discovers a dependency after startup, and offers `server.warmup` to avoid transform waterfalls. [Dependency pre-bundling](https://vite.dev/guide/dep-pre-bundling.html), [server.warmup](https://vite.dev/config/server-options#server-warmup)

Add three protections:

- Warm the generated frame-host, content primitives, and known heavy frame modules before scheduling iframe boots.
- Limit cold frame navigation concurrency—start with two, not thirty.
- Do not run a per-frame 10-second watchdog while the server reports that dependency optimization/warmup is still in progress.

The watchdog should distinguish:

- no bridge: navigation/server failure;
- bridge alive, import pending: optimizer/module-graph wait;
- committed but not measured: content measurement delay;
- fatal import/render error.

A global optimizer stall then becomes one dev-server status plus queued frames, not 30 false error cards.

## 6. Dev versus publish

### Dev

- Existing snapshots are allowed to be stale while edits are in flight, but visibly marked only if the live frame cannot recover.
- Collapse rapid agent saves into an edit-settle window for snapshot capture.
- Continue delivering HMR immediately, but treat `vite:error` as a recoverable candidate state.
- Warm and navigate frames with bounded concurrency.
- Preserve the last good pixels through broken intermediate saves.

### Publish

- Start snapshot-first.
- Pre-bake the exact widths/themes used by published boards.
- Include measured content dimensions in the snapshot manifest.
- Hydrate only near-visible frames; promote immediately on interact/comment/laser/resize.
- No optimizer or HMR machinery ships.
- The live path remains the same frame-host and bridge generated in [build.ts](/Users/nictouron/marver/src/server/build.ts:266), so publish is not a separate feature implementation.

## 7. Virtualization and the 16 ms target

Freezing all 50 documents reduces paint but does not stop their JavaScript or release their React trees. Eventually, true memory control requires dormant navigation.

Use three retention levels:

- Snapshot plus dormant iframe document: cheapest, app state lost.
- Snapshot plus suspended live document: DOM/React state retained, paint skipped, JS still running.
- Uncovered live document: rendered, optionally interactive.

Do not hibernate recently interacted frames because arbitrary app state cannot be restored. Use an LRU weighted by boot cost and memory observations.

For active pan/zoom, the critical rules are:

- No iframe pixels visible inside the transformed world.
- No React or Zustand updates per transform tick.
- Visibility calculation at most once per animation frame.
- Lifecycle transitions only at gesture boundaries or hysteresis crossings.
- Low-resolution snapshot mips at low zoom; do not decode 50 desktop-resolution images.
- No comment DOM scans or measurement work during the gesture.

There is a concrete current hot path to remove: `onTransformed` writes scale into the store, while every `FrameNode` subscribes to scale. See [Canvas.tsx](/Users/nictouron/marver/src/client/shell/canvas/Canvas.tsx:321) and [FrameNode.tsx](/Users/nictouron/marver/src/client/shell/canvas/FrameNode.tsx:23). Keep camera state in refs/CSS variables during gestures and commit only settled state if anything needs it.

The `<16 ms p95` result must be a release gate on the real heavy Next and Vite/RR boards, on named reference hardware. Measure rAF intervals, long tasks, warm-promotion latency, decoded snapshot memory and blank-frame occurrences in both dev and packed publish; it cannot be guaranteed from CSS choices alone.

## Top risks

1. **Snapshot freshness and cache size.** Width, theme, revision and interactive state can make an apparently valid image wrong. Use strict keys, low-resolution mips and decoded-image LRU limits.

2. **State loss from hibernation.** Navigating to dormancy frees memory but loses arbitrary application state. Keep focused/recent documents suspended, not hibernated.

3. **Publish capture side effects and nondeterminism.** Headless capture executes frame code and depends on fonts/assets/animations. Isolate credentials/network, add capture mode, and make failures fall back to live-first rather than fail the whole publish by default.

4. **Screen-space portal correctness.** Coordinates, wheel routing, comments and clipping are easy to get subtly wrong. Treat it as an optional later optimization, not the first white-flash fix.

5. **Mode/generation races.** A stale document’s message can otherwise mark a newer document ready or move a pin. Extend the existing measurement generation guard to every message.

## Staged rollout

### Stage 0 — Instrument and remove avoidable shell work

- Keep camera state out of React during gestures.
- Add real-board frame-time/blank/warm-latency instrumentation.
- Establish correct wheel ownership across iframe documents: passive/laser/comment frames forward and prevent canvas wheel gestures; the active interactive frame retains application scrolling.
- Replace iframe DOM scans with a `WindowProxy → node session` registry.
- No lifecycle behavior changes yet.

Value: lower zoom jank and reliable evidence with virtually no feature risk.

### Stage 1 — Self-healing frame sessions

- Add generation-wide handshake and fatal-versus-diagnostic errors.
- Reset boundaries on HMR updates.
- Automatically retry failed/timed-out frames on the next valid update.
- Replay shell-owned modes after every committed-ready.
- Preserve stage scroll across unavoidable reloads.
- Add dev warmup and bounded boot concurrency.

Value: fixes cold-boot false failures, mid-edit dead cards and mode loss without snapshots or virtualization.

### Stage 2 — Snapshot facade, no hibernation

- Build the asynchronous screenshot cache.
- Publish pre-baked snapshots.
- Keep all existing iframe elements and documents mounted.
- Show snapshots during pan/zoom, with the resize target exempt.
- Crossfade live surfaces back after settle.

Value: directly fixes the heavy-frame white flash while preserving all current iframe state and the strict iframe law.

### Stage 3 — Visible working set and suspension

- Add visibility rings and hysteresis.
- Apply `content-visibility:hidden` inside off-screen mounted documents behind snapshots.
- Warm selected/near-visible frames.
- Laser/comment activation warms every visible frame.
- Cache comment rects with generation and width.
- Gate content-frame demotion on a valid measurement.

Value: reduces paint/layout cost while retaining React state.

### Stage 4 — Deep hibernation

- Navigate long-cold iframe elements to a lightweight dormancy document.
- Restore only by assigning a new generation URL to the same element.
- Add weighted LRU and snapshot-memory budgets.
- Never hibernate focused, selected, open-comment, resizing or play frames.

Value: makes 50+ frame boards tractable in CPU and memory, with explicit state-loss boundaries.

### Stage 5 — Screen-space live surfaces only if needed

Prototype the overlay portal for the active frame and small visible set. Ship it only if Stage 2–4 still miss the measured gesture target and the full laser/comment/resize matrix passes in dev and published bundles.

The central architectural choice is therefore: **snapshot-first presentation, stable iframe identity, bounded live residency, and shell-owned recoverable sessions**. It retains every live-DOM feature while removing “all frames must be live and painted at all times” as an accidental requirement.


---

# Brief given to Codex (input of record)

# Marver: performance + reliability overhaul WITHOUT breaking the live-iframe features

You are consulting on the architecture of **Marver**, an agent-native design canvas. Read this
whole brief, then give a concrete recommended architecture, the risky bits, and a staged rollout
that never breaks laser / element-comments / prototype / live-resize — in BOTH dev and publish.

## What marver is
A `design/` folder of "frames" — each frame is a REAL app view (the host app's own React/Next
components) or a content frame (spec/diagram/mood). A **shell** (the canvas) lays frames out on an
infinite pannable/zoomable board. Same architecture in DEV (Vite dev server + HMR) and PUBLISH
(static build). Frames are **same-origin** with the shell (v1 trust boundary — frame code runs
same-origin; full sandboxing is a later item).

## Current architecture (load-bearing facts — do not casually break these)
- **One LIVE iframe per frame node.** "Iframe laws": the iframe element is created once per node
  key; a reload = setting `.src`. Each iframe runs the full frame app (its own React/Next tree +
  providers + layout chain).
- **The shell owns**: the viewport (zoom/pan is a CSS transform via react-zoom-pan-pinch on a
  "world" div that CONTAINS all the iframes), device sizing, walk order, the URL, and the
  interaction modes (laser, comment). Frames are positioned with `transform: translate(x,y)` and
  sized with explicit `width`/`height` on the iframe, all inside the transformed world.
- **frame-host** (inside each iframe): imports the frame module + providers + layout, renders with
  createRoot, posts `sh:ready`. A `bridge.js` in each iframe handles shell→frame postMessages:
  `sh:set-theme`, `sh:laser` (toggle laser outlines), `sh:pick` (comment element-pick mode),
  and posts back `sh:laser-copy {cssPath, source}`, `sh:measure {height}`, `sh:ready`, `sh:error`.
- **stage** (play/prototype mode): a SINGLE mounted tree (providers + layout chain) that swaps only
  the inner frame on `data-goto`, so the app shell persists across navigation like a real app.
  Play mode is already single-frame-live.
- **Content-frame sizing** is MEASURED from the live render (`sh:measure` posts the rendered
  height); the shell has no size without a real render.
- **Comments** anchor to a specific element via a stored ladder (semantic id → CSS path → fuzzy
  quote match); pins are re-resolved against the LIVE DOM to a rect each render; a dead anchor
  parks the thread at the frame edge.
- **Ready watchdog**: 10s without `sh:ready` → the shell cards the frame as "never reported ready".
- **Publish uses the SAME frame-host + bridge.js** (build.ts generates the frame-host page and
  copies bridge.js). A published canvas is also live iframes.

## The problems (observed dogfooding two real projects, Aug 2026)
1. Heavy board (~30 live iframes, "all scenes") → slow, janky zoom/pan; wheel sometimes scrolls the
   host page instead of zooming.
2. **White-flash / blank**: a very heavy frame (host app = **Next.js 16 + React 19**, frame is a
   775-line whole-website view "keynote-v2") FLASHES WHITE and sometimes vanishes entirely while
   panning/zooming the canvas; only recovers via click → enter play → fit-to-screen, then degrades
   again on the next pan. Contrast: the other project (**Vite + React Router**) is slow/janky but
   NEVER blanks. So the stack is a variable — heavy Next iframe layer gets dropped during the CSS
   transform; lighter Vite/RR frames just render slowly.
3. **Cold-boot / re-optimize race**: content frames dynamically import a chain that needs mermaid
   (209KB) + marked (162KB); on a cold `vite dev` (or a mid-session re-optimize) the import is held
   by Vite's dep optimizer, the import neither resolves (`sh:ready`) nor throws (`sh:error`), and
   the 10s watchdog fires on ALL frames at once. Reload heals.
4. **Mid-edit HMR crash**: an agent editing a frame file saves an INTERMEDIATE half-written state
   (a symbol used before its import lands); Vite HMR applies it → the frame throws a ReferenceError
   → a dead error card that only clears on a MANUAL reload, not on the agent's next (fixing) save.
5. **Churn breaks shell state**: a frame crash/HMR/reload kills laser and comment mode BOARD-WIDE
   and they don't re-arm; play-mode in-frame scroll resets to the TOP when an agent edits.

**Root**: every frame is a live full app in an iframe, all mounted at once, re-executed on every
change. 30 live apps = slow; a heavy one drops its compositing layer during the world's CSS
transform = white flash; a churn in any one = crash / mode-loss.

## THE CATCH — features that genuinely need live-ness. DO NOT break these (dev AND publish):
- **Laser mode**: outlines every element in every (visible) frame and, on click, copies the
  element's CSS path + source location. Needs the real DOM TREE present (an image can't be
  outlined). Only relevant for frames IN VIEW.
- **Comment on a specific interactive element (interact mode)**: the user interacts with the LIVE
  app to drive it to a state, then clicks an element to attach a comment thread; the anchor is
  stored (cssPath/quote) and pins are re-resolved against the live DOM. Needs live+interactive for
  the target frame; needs a resolvable DOM (or a cached rect) for frames merely SHOWING pins.
- **Prototype / play mode**: a fully live, interactive app. Already single-frame (the stage).
- **Resize = live responsive reflow**: because the frame is a live site, dragging the resize handle
  re-lays-out the real app at the new width (and snaps to device widths); device views show the
  same frame at mobile/tablet/desktop. The live reflow is the whole point — you resize to SEE
  responsive behavior.
- **Content-frame sizing** depends on measuring a live render.

Key observation: these need live-ness only for the frame(s) the user is FOCUSED on / interacting
with — never all frames at once. Play is already single-live; laser/comment/resize act on
visible/focused frames.

## Strawman for you to critique (NOT committed)
A per-frame lifecycle **snapshot → warm → live**:
- **snapshot**: a cached picture (or a paint-frozen iframe) for off-screen / during-active-
  gesture / below-zoom-threshold frames. Cheap, never blanks.
- **warm**: iframe mounted, DOM rendered, `pointer-events:none`, painting throttled → laser,
  comment-pin re-resolution, and measurement work for visible frames at rest.
- **live**: fully interactive → only the focused frame (interact target / play stage / frame being
  resized or commented).
Working set = visible frames `warm`, the interacted frame `live`, everything else `snapshot`;
hysteresis so panning doesn't thrash. During an ACTIVE pan/zoom gesture, drop visible heavy frames
to `snapshot` (an image scales cleanly and never blanks) and restore to `warm` on gesture-end →
kills the white-flash. Resize: the dragged frame stays `live` (real reflow); device sweep =
focused device live, others snapshot. Publish: PRE-BAKE snapshots at build → instant load, hydrate
to live on interaction.

## Questions — answer each concretely
1. Is snapshot→warm→live the right model? Better alternative decompositions?
2. **Snapshot mechanism** for a SAME-ORIGIN iframe that faithfully captures fonts/images/canvas and
   is cheap enough on demand: SVG `foreignObject` serialization, html2canvas-style, native paint
   APIs, or — instead of an image — FREEZE painting while keeping the DOM (`content-visibility`,
   `contain`, `display:none` on body via the bridge)? Can we avoid image snapshots entirely? What
   are the fidelity/perf trade-offs of each, and which survives Next.js hydration?
3. **The white-flash specifically**: better to (a) snapshot-during-transform, (b) NOT put iframes
   inside the CSS-transformed layer — position them in screen space via JS instead so the transform
   never re-rasterizes them, or (c) layer hints (`contain`, `will-change`, `backface-visibility`,
   forcing a persistent layer)? What actually prevents a browser from discarding a large iframe's
   compositing layer during a parent transform, and why is Next worse than Vite/RR here?
4. Keeping **laser / comment / resize** correct under the lifecycle without thrashing: promotion/
   demotion triggers + hysteresis; comment pins need a rect — cache last-known rect on snapshot and
   re-resolve on warm? Does laser require warming ALL visible frames (fine) or can it work per-hover?
5. Fold **reliability** into the same model: in-place auto-recovery (crash/timeout heals on next HMR
   update, never a full page reload), mode-survival across churn, one-frame-error-never-fatal.
6. **Dev vs publish** differences that change the answer (HMR/optimize churn in dev; static +
   pre-bakeable snapshots in publish).
7. **Culling/virtualization** vs the one-iframe-per-node invariant: unmount vs freeze; memory vs
   re-init cost; how to hold a p95 < 16ms frame-time while panning a 50-frame board.
8. Anything in the current design that makes a cleaner solution possible, or that a naive change
   would silently break (measurement protocol, same-origin trust boundary, variant groups,
   content-frame sizing, the iframe-per-node key law).

Deliver: a recommended architecture, the top 3–5 risks, and a STAGED rollout ordered so each stage
ships value without breaking laser/comment/prototype/resize in dev or publish.
