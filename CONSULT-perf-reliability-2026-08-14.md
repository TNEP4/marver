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

---

# Codex follow-up: device sweep + multi-agent stay-in-action (2026-08-14)

Focused second pass on the two hardest pieces Nic named. Core reframe: **device sweep and
agent updates are PRESENTATION TRANSACTIONS, not document reloads** - the shell, board model,
iframe identity, and session state stay mounted; only projected geometry + frame revisions change.

The core design decision is: device sweep and agent updates must become presentation transactions, not document reloads. The shell, board model, iframe identity, and interaction state stay mounted; only projected geometry and frame revisions change.

This is tied to the spec’s named architecture (`server/plugin.ts`, `manifest.ts`, `api.ts`, `client/shell`, `FrameNode`, `bridge.ts`, `frame-host/main.tsx`). I did not inspect repository files.

# A. Device sweep

## 1. Exact transition mechanism

Do not animate live iframe widths continuously. Every intermediate width triggers responsive layout, style recalculation, paint, iframe compositing, and potentially expensive component work. Doing that across 30–50 frames will miss the frame budget.

Use a four-phase transaction:

```text
live frames at old width
        │
        ▼
freeze presentation with old-width snapshots
        │
        ▼
FLIP snapshot cards to target tidy positions and widths
        │
        ├── live visible frames reflow underneath, once, at target width
        ▼
crossfade each settled target-width live frame back in
```

### Phase 0: start a sweep transaction

The shell creates:

```ts
type SweepTransaction = {
  id: number
  target: "mobile" | "tablet" | "laptop" | "monitor" | "default"
  targetWidth: number | null
  startedAt: number
  pending: Set<NodeId>
  cancelled: boolean
}
```

A newer sweep invalidates the prior transaction. Every asynchronous completion must check the transaction ID before changing UI.

At start:

- Finish or cancel any frame drag/resize.
- Keep selection, mode, camera, focus-mode route, and board identity.
- Capture no new screenshots synchronously.
- Read no iframe layout.
- Use cached presentation geometry and cached snapshots.
- Set the board’s projected layout in one shell-store transaction.

### Phase 1: cover visible live frames

Each visible card receives a snapshot overlay before its width changes:

```text
FrameNode
├─ snapshot layer — old revision/width, visible
├─ live iframe — same browsing context, covered
└─ controls — remain in shell, never covered
```

Do not replace, reparent, or remount the iframe.

The overlay should use the latest valid snapshot for:

```ts
type SnapshotKey = {
  frameId: string
  sourceRevision: string
  width: number
  theme: string
  dprBucket: number
}
```

Width alone is insufficient. Otherwise an old source revision can be presented as current after an agent edit.

If no valid snapshot exists for a currently visible live frame, use the current iframe as the initial visual and skip its width animation. Snap-to-target is better than creating a white flash or blocking the sweep to synchronously rasterize it.

### Phase 2: move the presentation using FLIP

Compute target positions from model data in `tidy.ts`. Do not measure 50 DOM nodes.

For each card:

1. Set its logical box immediately to the target `{x, y, width, height}`.
2. Apply an inverse transform representing the old box.
3. Animate that transform to identity.

The snapshot is scaled during this movement. It may look slightly stretched for 150–220 ms, but it avoids live responsive work at every intermediate width.

The live iframe underneath is set directly from old width to final width. Never CSS-transition the iframe’s `width`.

A reasonable timing:

```text
0 ms       snapshot visible; target geometry committed
0–180 ms   snapshot card FLIP movement
1–3 rAF    target-width reflow batches begin underneath
180 ms     movement settles
180–280 ms settled live frames crossfade in
```

Movement and reflow can overlap because the user sees only the compositor-driven snapshot layer.

### Phase 3: detect live-frame settlement

The frame bridge should install a `ResizeObserver` on the frame root and emit:

```ts
{
  type: "sh:layout-settled",
  frameId,
  sweepId,
  width,
  sourceRevision,
  scrollHeight
}
```

“Settled” should mean:

- observed width equals the requested target;
- no root-size change for two animation frames;
- fonts are ready or a short deadline has expired;
- the message still matches the current sweep and source revision.

Do not wait indefinitely for animation, polling widgets, or late-loading content. Use a bounded deadline, approximately 300–500 ms. On timeout, reveal the live frame if it has painted; do not leave a permanent snapshot.

Once both conditions are true—

- card movement finished;
- matching live frame settled—

crossfade the snapshot out over roughly 80–120 ms.

Snapshot rebaking happens after the live frame is revealed. It is not a prerequisite for the crossfade.

### Default restoration

Keep these as distinct state:

```ts
type BoardState = {
  baseLayout: Record<NodeId, Rect>       // persisted free-form positions
  deviceProjection: DeviceProjection | null
}
```

A device sweep must never mutate `baseLayout`. “Default” discards the projection and FLIPs back to the exact stored rectangles.

Naive break: if the device layout is written into the regular board frames and autosaved, “Default” cannot restore the hand-placed layout reliably.

Dragging in a device view needs an explicit rule:

- Simplest: device layouts are derived, so position dragging is disabled.
- If dragging must remain: store per-device overrides separately.
- Never reinterpret a device-view drag as a base-layout edit.

## 2. Visible versus off-screen reflow

Yes: only the visible working set should reflow immediately.

Use three sets:

```ts
visible       // intersects the viewport
nearby        // within a 1–2 viewport overscan margin
cold          // everything else
```

On sweep:

- `visible`: cover, resize live iframe to target width, settle, reveal.
- `nearby`: queue target-width reflow behind visible work.
- `cold`: update only shell geometry; do not touch live iframe width yet.

Each frame tracks:

```ts
type FramePresentationState = {
  desiredWidth: number
  liveWidth: number
  desiredRevision: string
  liveRevision: string
  phase:
    | "ready"
    | "queued"
    | "reflowing"
    | "settling"
    | "crossfading"
  snapshotKey?: SnapshotKey
  sweepId: number
}
```

When a cold frame enters the overscan region:

1. Look for an exact `{revision, width, theme}` snapshot.
2. Show it immediately if available.
3. Otherwise show the newest snapshot scaled into the target card.
4. Mark it internally as stale.
5. Resize the live iframe underneath directly to target width.
6. Wait for its matching settlement message.
7. Crossfade to live.
8. Re-bake its exact target snapshot later.

So, yes: on a cache miss, a rapidly scrolling user may briefly see a scaled stale-width snapshot. They must not see white, an empty iframe, or the old card width disturbing the board layout.

A subtle “updating” treatment is acceptable after roughly 150 ms. Do not flash a loader for frames that settle within a couple of frames.

Prewarming the overscan region should make the stale interval uncommon.

Naive breaks:

- Showing a snapshot with the right width but wrong source revision.
- Revealing an old-width live iframe inside a target-width card.
- Resizing all cold iframes immediately because they remain mounted.
- Allowing late completions from an abandoned sweep to overwrite the newest sweep.

## 3. Tidy ordering

Tidy and crossfade should compose as one transaction, not run as independent animations.

Correct sequence:

1. Choose snapshot presentation.
2. Compute the complete target tidy layout.
3. Commit target positions and widths.
4. FLIP snapshot cards from old geometry to target geometry.
5. Reflow visible live frames underneath at final width.
6. Crossfade each frame only after movement and live settlement.
7. Queue exact target-width snapshot rebakes.

Do not first animate width in place and then run tidy. That creates two board movements and twice the visual instability.

Do not tidy again as live frames settle. Tidy must use predetermined card dimensions. If responsive content can change card height, choose one of these contracts:

- Device preset defines both frame width and fixed viewport height; recommended.
- Board frame height remains unchanged during width sweep.
- Use previously cached target-width heights and tolerate later corrections.

Dynamically discovering 50 content heights and repeatedly shifting rows will make the board swim. For v1, device sweep should change width while frame/card height remains model-controlled.

The shell controls remain live throughout. Only the frame presentation layer is covered.

## 4. What runs inside the p95 <16 ms gate

The gate should mean p95 main-thread work per animation frame during the interaction, not “all 50 frames complete within 16 ms.” The latter is impossible while preserving real reflow.

### Allowed on the click’s critical path

- One Zustand/store transaction.
- Pure target-layout calculation from stored dimensions.
- Updating lightweight wrapper geometry.
- Adding snapshot overlays for the visible set.
- Starting compositor transforms.
- Enqueuing reflow work.

For 50 frames, `tidy.ts` should be O(n), using model rectangles only.

### Must not run on the critical path

- Screenshot capture or bitmap encoding.
- Filesystem/API writes.
- Board autosave.
- Manifest rescans.
- DOM measurement of every card.
- Iframe `scrollHeight` reads.
- Sequential forced layout.
- Reflowing all 30–50 iframe documents.
- Snapshot cache eviction.
- PNG/WebP compression.
- Font waits.
- React remounts.
- Rebuilding the whole `FrameNode[]` array with different keys/order.

### Reflow scheduler

Process the visible set in bounded batches. Start with one or two iframe width commits per animation frame; increase only after measurement proves headroom.

Priority:

```text
selected frame
→ visible frames nearest viewport center
→ remaining visible
→ overscan in scroll direction
→ other overscan
→ cold frames only when approached
```

Use `requestAnimationFrame` for visible scheduling. Use `scheduler.postTask` when available or `requestIdleCallback` with a timeout for snapshot rebakes and cold maintenance.

CSS transforms and snapshot opacity should be compositor animations. Do not animate box `left`, `top`, or live iframe `width`.

Also cap active bitmap overlays to visible plus overscan. Fifty desktop-resolution snapshots can consume hundreds of megabytes of GPU memory.

# B. Multi-agent “stay in the action”

## 1. Exact invariant

The invariant should be:

> A filesystem revision may update frame content and the catalog, but it may never replace or reinitialize the shell session. The shell applies every external change as a scoped, revisioned diff while preserving all unrelated session state and every unaffected iframe browsing context.

Session state must be separate from disk document state:

```ts
type SessionState = {
  activeBoard
  camera
  selectedNode
  activeMode
  focusedFrame
  stageHistory
  stageScroll
  panelState
  pendingComment
  laserState
}

type DocumentState = {
  manifestRevision
  boards
  baseLayouts
}

type FrameRuntimeState = {
  iframeIdentity
  liveRevision
  pendingRevision
  liveWidth
  scrollState
  interactionLease
}
```

Under an agent edit, these must never happen:

- No browser full-page reload.
- No shell React-root remount.
- No board route replacement.
- No zoom/pan reset.
- No selected-frame reset unless that node was actually deleted.
- No comment, laser, or prototype-mode drop.
- No play/stage history reset.
- No stage or iframe scroll reset.
- No iframe reparenting.
- No unrelated iframe reload.
- No focus steal.
- No sidebar/panel reset.
- No autosave of derived manifest changes.
- No white iframe exposure.
- No old asynchronous update applying after a newer revision.
- No deleted or renamed board being recreated by a stale debounce.

“Preserve focus” cannot mean preserving an input that the agent deleted from the source. It means the shell does not proactively move focus, and active prototype updates are deferred until a safe point.

## 2. Updating inactive versus actively used frames

### Frame not visible or not active

Apply silently:

1. `server/plugin.ts` emits a revisioned frame-change event.
2. Shell marks that frame’s existing snapshots stale.
3. If cold, record `pendingRevision`; perform no visible work.
4. If nearby, update/reflow in the background under its current snapshot.
5. Re-bake `{newRevision, currentWidth, theme}`.
6. Never toast ordinary successful edits.

If the frame is on another board, only its catalog/runtime record changes. Do not mount that board or mutate the active camera.

### Visible but not being interacted with

Use snapshot shielding:

1. Put the last valid snapshot over the iframe.
2. Apply the frame update underneath.
3. Wait for `ready` plus layout settlement.
4. Restore frame scroll if necessary.
5. Crossfade back.
6. Keep the shell selection and mode unchanged.

This eliminates the white zap while still showing the update promptly.

### Active comment, laser, drag, or resize gesture

Defer the visual/live swap until the gesture ends.

The shell creates an interaction lease:

```ts
type InteractionLease = {
  frameId: string
  mode: "comment" | "laser" | "prototype" | "drag" | "resize"
  startedAt: number
  pendingRevision?: string
}
```

Only the newest pending revision matters. Coalesce five saves into one eventual update.

After pointer-up/cancel:

- cover with snapshot;
- apply latest revision;
- settle;
- restore the same mode;
- crossfade;
- preserve comment draft or laser state in the shell.

### Active prototype interaction

Defer the update. Do not apply HMR underneath a live click, input edit, drag, dialog, or pointer capture. Snapshot shielding alone protects appearance, not DOM targets or event handlers.

A safe moment is:

- explicit exit from prototype mode;
- pointer capture released and active element blurred;
- navigation completed;
- or a visible “update ready” action after a bounded defer period.

Do not force it after an arbitrary 500 ms timeout. Someone may be completing a form or inspecting a dialog.

If freshness matters, show a quiet “Update ready” badge in the frame chrome. The user can apply it without losing the entire canvas session.

### Stock Vite HMR is a problem

Naively importing every design module through ordinary Vite HMR cannot provide this guarantee. Vite may execute the module and trigger React Refresh before the shell decides whether the frame is safe to update.

For design files, updates need to be controlled:

- `handleHotUpdate` recognizes affected `design/**` modules.
- Suppress default full reload for those modules.
- Emit `sh:frame-invalidated` with frame IDs and source revisions.
- Frame hosts load the accepted revision only when the shell authorizes it.
- Use revisioned module URLs or a revisioned virtual-frame module.
- Coalesce invalidations while a frame has an interaction lease.

Shared dependencies such as `src/components/ui/Button.tsx` are harder because one edit can affect many frames. The server must traverse Vite’s module graph to determine affected frame entrypoints. Until that exists, Stage 1 should guarantee controlled updates for direct frame/layout/provider/fixture edits and prevent shell reloads for everything else.

Naive break: claiming updates are deferrable while leaving React Fast Refresh fully automatic inside every frame.

## 3. Multiple agents, manifests, and board autosave

Three classes of state must have different ownership:

| State | Authority | Reconciliation |
|---|---|---|
| Scenes, frames, fixtures | Disk | Revisioned per-frame invalidation |
| Manifest | Server-derived from disk | Atomic full scan, shell applies catalog diff |
| Board layouts | Shell-owned file with CAS | Hash-guarded save; external disk change wins |
| Camera/mode/panels | Current shell session | Never replaced by manifest or board reload |

### Manifest behavior

`server/manifest.ts` should produce a monotonically ordered scan result:

```ts
{
  revision: number,
  contentHash: string,
  frames: [...]
}
```

The shell should receive either the full manifest plus revision or an explicit diff. It must:

- ignore revisions older than the last applied;
- update the catalog by frame ID;
- never replace the whole shell store;
- never reset the active board;
- never autosave merely because the manifest changed;
- preserve missing board references as “frame missing” tombstones;
- add new frames to the virtual `everything` projection without touching `baseLayout`.

Filesystem events must be coalesced into scan transactions. An editor’s temp-file rename can produce unlink/add/change events for one logical save.

### Board autosave

Every loaded persisted board needs:

```ts
type BoardDocument = {
  name: string
  diskHash: string
  diskRevision: number
  dirtyGeneration: number
  saveGeneration: number
  status: "clean" | "dirty" | "saving" | "conflicted" | "deleted"
}
```

Every save carries:

```json
{
  "board": {},
  "baseHash": "hash-loaded-from-disk",
  "clientId": "shell-session-id",
  "mutationId": "monotonic-local-id",
  "mustExist": true
}
```

The server atomically checks `baseHash` immediately before rename.

A debounce callback must capture the board’s generation. Before writing, it verifies:

- board still has the same name;
- board is still dirty;
- generation still matches;
- board was not externally modified, renamed, or deleted;
- base hash still matches;
- the shell still owns this pending mutation.

Otherwise it drops the write.

### Fixing ghost-board resurrection

The old failure is predictable:

```text
shell schedules save for old-name.json
external actor renames old-name.json → new-name.json
watcher reports deletion/addition
stale debounce fires
PUT old-name.json creates it again
```

Prevent it structurally:

- Autosave of a previously loaded board always sends `mustExist: true`.
- Creating a board requires a separate explicit create operation.
- A missing destination under `mustExist` returns `410` or `409`; it never creates.
- External unlink immediately increments that board’s generation and cancels its save timer.
- Rename correlation updates the active document name without remounting the board.
- If correlation is uncertain, mark the active board deleted/read-only and offer “Save as”; never resurrect it.

Within the watcher debounce window, correlate unlink/add pairs by board content hash or stable board ID. A stable board ID in schema v2 is safer than filename/hash heuristics.

### External board modifications

Disk remains authoritative under the existing disk-wins policy, but “disk wins” must not mean “reset the session.”

On a changed active board:

1. Cancel pending autosave.
2. Mark the board externally changed.
3. Apply a node-level document diff.
4. Preserve camera, mode, panel state, and unaffected iframe identities.
5. Drop conflicting unsaved board-layout edits with an explicit notice.
6. Do not reload the shell or route.

If an external edit removes the currently selected node, that selection cannot remain valid. Clear or orphan only that selection; preserve the active tool mode.

### Multiple external board writers

Plain JSON files cannot guarantee conflict-free N-writer editing when agents write them directly. They have no compare-and-swap and can overwrite one another between watcher observations.

There are only three honest options:

1. Keep `design/boards/*.json` single-writer and shell-owned. Agents edit scene/frame files, not boards. This is the lean Stage 1 answer.
2. Require agents to use the guarded board API, which conflicts with the filesystem-only agent contract.
3. Replace board files with an operation log or mergeable CRDT-like format. This is later machinery.

For the current product principle, retain one writer for boards. Multi-agent support should mean concurrent frame/scene authorship across boards, not concurrent direct editing of the same board JSON.

## 4. Rollout

## Stage 1: self-healing sessions

This is the minimum that delivers “stay in the action”:

1. **Separate stores**
   - Session state, board document state, manifest state, and frame runtime state cannot share a replace-all hydration path.

2. **Stable shell and iframe identity**
   - Shell root never reloads for design changes.
   - FrameNode insertion order and keys remain stable.
   - Manifest updates are diffs, not remount triggers.

3. **Revisioned invalidation**
   - `plugin.ts` emits `{frameIds, revision}`.
   - Stale completions are ignored.
   - Direct design-file updates never trigger a browser full reload.

4. **Interaction leases**
   - Active gestures and prototype interaction defer frame application.
   - Inactive frames update silently.
   - Visible inactive frames update under a snapshot.
   - Only the latest queued revision is eventually applied.

5. **No-white presentation**
   - Snapshot remains until matching revision emits ready/layout-settled.
   - Errors replace it with the existing per-frame error card, not a blank iframe.

6. **Board save hardening**
   - Per-board timers and generations.
   - CAS on every existing-board save.
   - `mustExist` prevents resurrection.
   - External rename/delete cancels pending saves.
   - Manifest changes never trigger board saves.

7. **Session-preservation tests**
   - Edit active/inactive frames while panned and zoomed.
   - Edit during laser/comment/prototype modes.
   - Rename/delete a board during pending autosave.
   - Burst-save five revisions.
   - Edit two scenes simultaneously.
   - Assert shell root and unaffected iframe identities are unchanged.

Stage 1 does not need perfect state preservation inside an actively changing prototype DOM. It must defer that change rather than pretending it can preserve arbitrary component state.

## Stage 2: smooth device sweep

Add:

- derived device projection distinct from `baseLayout`;
- snapshot-key revision correctness;
- FLIP snapshot movement;
- visible/overscan/cold scheduler;
- target-width settlement protocol;
- lazy off-screen reflow;
- bounded bitmap cache;
- performance instrumentation.

This can ship after session survival because it builds on the same revisioned snapshot coordinator.

## Stage 3: broader controlled HMR

Add:

- Vite module-graph traversal from shared `src/` dependencies to affected frames;
- controlled refresh for shared layouts/providers/UI components;
- scroll restoration for window and explicitly keyed scroll containers;
- optional hidden shadow-frame warming;
- snapshot rebaking across commonly used widths.

Nested scroll restoration cannot be universally exact without frame cooperation. Support `data-sh-scroll-key` for durable restoration rather than guessing arbitrary DOM identity.

## Stage 4: true multi-writer boards, only if required

Add stable board/node IDs and either:

- API-mediated CAS operations; or
- an append-only board-operation journal with deterministic reduction.

Do not introduce this to solve concurrent scene editing. It is only necessary if agents must concurrently modify board layout documents.

# Silent-break checklist

The naive implementations most likely to betray the product are:

- Animating live iframe width across intermediate values.
- Reflowing all off-screen frames during a sweep.
- Letting target-width layout settlement repeatedly re-run tidy.
- Saving device-projected positions over `baseLayout`.
- Using width-only snapshot keys without source revision and theme.
- Allowing old sweep completions to apply after a new device click.
- Assuming a snapshot overlay makes active prototype HMR safe.
- Leaving default Vite/React HMR in control while claiming updates can be deferred.
- Replacing the whole Zustand store when a manifest or board changes.
- Treating filesystem watcher events as isolated logical edits.
- Letting manifest changes mark boards dirty.
- Allowing an autosave PUT to create a previously existing but now missing board.
- Reloading an active board to resolve disk-wins conflicts.
- Promising conflict-free direct JSON editing by multiple external agents.

---

# Codex consult: Stage 2 snapshot facade (2026-08-14)

Verdict: DOM snapshot facade in dev (html-to-image, frame-produced), NOT the portal (Stage 5
fallback). Min first slice = snapshot-during-gesture (kills white-flash); device-sweep FLIP next.

The smallest robust path is: **frame-produced DOM snapshots in dev, cached and displayed by the shell; keep the portal out of Stage 2.**

Use `html-to-image` as the first producer. It already implements the `<foreignObject>` pipeline, including computed styles, font/image embedding, pseudo-elements, open shadow roots, canvas, and current video frames where origin-clean. Do not write a second serializer. It is still a DOM reconstruction—not a true screenshot—and must fail soft. [html-to-image documents its pipeline and limits](https://github.com/bubkoo/html-to-image#how-it-works); html2canvas has a narrower CSS renderer and explicitly lacks filters, box shadows, blending, and other properties used by modern sites. [html2canvas limitations](https://html2canvas.hertzen.com/documentation), [supported CSS](https://html2canvas.hertzen.com/features).

## 1. Capture mechanism and portal decision

Default in dev:

- Run `html-to-image.toBlob()` **inside the frame document**, not from the parent over `iframe.contentDocument`.
- The frame bridge receives `sh:snapshot-request`, dynamically loads the capture code, captures its own viewport, and posts a `Blob` back.
- The shell never captures synchronously at gesture start.

Why frame-side:

- Fonts, CSSOM, relative URLs, `document.fonts`, scrolling, canvas, and the renderer’s ambient `window` all belong to the iframe realm.
- It works through the existing source-validated `WindowProxy → node` route in [App.tsx](/Users/nictouron/marver/src/client/shell/App.tsx:534).
- It gives TSX and injected-bridge HTML frames one protocol. Make the existing injected bridge a bundled entry so capture can be dynamically imported without putting the rasterizer into every frame’s boot path.

Important correction: a same-origin iframe does **not** make all its pixels origin-clean. Cross-origin images, fonts, nested iframes, video, or canvases can still taint or disappear without suitable CORS headers. [MDN explains canvas tainting](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image).

Silent failures to record as `sh:snapshot-error`, never as frame failure:

- Cross-origin assets without CORS; tainted 2D/WebGL canvas.
- Closed shadow roots, DRM/video, browser-native controls, nested cross-origin frames.
- Fixed/sticky positioning and root or nested scroll positions unless explicitly reproduced in the clone.
- DOM changing during capture, producing a torn image.
- Very large DOM/data-URL limits and expensive style cloning.
- Browser-specific `<foreignObject>` rendering differences.

The portal is not simpler here. A permanent portal can preserve real pixels, but it changes the canvas’s fundamental layering:

- The iframe currently receives radius/clipping from `.sh-node-body`; a fixed overlay loses that ancestor clipping.
- Comment pins/cards deliberately live outside the clipped body and raise the whole node to `z-index: 30` in [FrameNode.tsx](/Users/nictouron/marver/src/client/shell/canvas/FrameNode.tsx:264). A global iframe layer cannot naturally interleave beneath each node’s comments but above neighboring artwork.
- The passive drag overlay would sit in a different stacking tree from the iframe.
- B0.2’s wheel coordinate conversion currently trusts the iframe’s transformed `getBoundingClientRect()` in [App.tsx](/Users/nictouron/marver/src/client/shell/App.tsx:597). It remains mathematically viable, but only if the portal and world camera never diverge by a frame.
- Pin rects are iframe-local and are presently placed into the same transformed node coordinate system in [Comments.tsx](/Users/nictouron/marver/src/client/shell/Comments.tsx:112). Portal lag would visibly detach them.
- Per-visible-frame screen transforms introduce O(visible frames) style writes on every camera tick. A single transformed portal wrapper recreates the original compositor problem.
- Moving existing iframes into/out of the portal conflicts with Marver’s stable browsing-context invariant. Rendering there permanently avoids reparenting, but becomes a substantial architecture change.
- It only addresses pan/zoom. Device sweep still needs shielding while live documents reflow.

So: **snapshot first; portal remains a measured Stage 5 fallback.**

Browser View Transitions are interesting because the browser produces genuine visual snapshots, but they are ephemeral pseudo-elements, destroyed after the transition, unavailable as blobs, and live in a topmost transition layer. They cannot back the cache, arbitrary-length pan gestures, or publish pre-bakes. [View Transition lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using).

## 2. Capture lifecycle and cache

Protocol:

```ts
// shell → frame
{
  type: 'sh:snapshot-request',
  requestId,
  nodeKey,
  generation,
  sourceRevision,
  width,
  height,
  theme,
  dprBucket
}

// frame → shell
{
  type: 'sh:snapshot-result',
  requestId,
  generation,
  sourceRevision,
  width,
  height,
  theme,
  dprBucket,
  blob
}
```

The frame should capture only after:

1. Its current generation is ready.
2. The source edit stream has been quiet for roughly 250 ms.
3. It is not leased, resizing, or inside a sweep transaction.
4. `document.fonts.ready`, visible image `decode()` calls, and two stable animation frames complete, each with bounded deadlines.

The current `sh:ready` is insufficient by itself: it is posted immediately after `createRoot(...).render(...)`, before React necessarily commits or paints, in [frame-host/main.tsx](/Users/nictouron/marver/src/client/frame-host/main.tsx:72). The capture handler must perform its own paint-settle wait.

One correction to the proposed cache key: live dev snapshots need more than `frameId`.

```ts
type LiveSnapshotKey = {
  nodeKey: string
  frameId: string
  documentGeneration: string
  sourceRevision: string
  width: number
  height: number
  theme: string
  dprBucket: 1 | 1.5 | 2
}
```

`nodeKey` matters because two placements of the same frame can have different scroll/form/runtime state. `height` matters because Marver supports independent vertical resize. Publish-time canonical assets can deduplicate by frame/revision/viewport/theme.

For an `<img>` facade, cache:

- The encoded `Blob`.
- Its object URL.
- A preloaded `HTMLImageElement` whose `decode()` has completed.
- Metadata and estimated decoded bytes: `width × height × 4 × dpr²`.

Do not cache `ImageBitmap` unless the facade becomes `<canvas>`; an `<img>` cannot display an `ImageBitmap` directly.

Start with:

- 96 MiB decoded budget.
- 24–32 MiB encoded budget.
- Capture DPR capped at 1.5 in dev.
- Visible/current-transaction entries pinned.
- LRU eviction elsewhere; revoke object URLs on eviction.
- Single capture in flight, scheduled with `requestIdleCallback`/`scheduler.postTask`.

## 3. FrameNode, Canvas, and gesture behavior

Add one always-mounted facade element beside the stable iframe in [FrameNode.tsx](/Users/nictouron/marver/src/client/shell/canvas/FrameNode.tsx:229):

```tsx
<div className="sh-live-surface">
  <img ref={snapshotRef} className="sh-snapshot" alt="" />
  <iframe ref={bindIframe} ... />
</div>
```

The snapshot coordinator updates `src`, readiness attributes, and classes imperatively. No Zustand snapshot subscription is needed in every `FrameNode`.

Use the existing `#sh-world.sh-gesturing` signal, but centralize its begin/end bookkeeping because wheel, RZPP pan/zoom, frame drag, and resize currently add/remove the class independently in [Canvas.tsx](/Users/nictouron/marver/src/client/shell/canvas/Canvas.tsx:248).

At motion start:

- Compute the visible set once from `{tx,ty,scale}` and node rectangles.
- Mark exact, decoded snapshots as active.
- Add `.sh-resizing` to the live resize target; it is exempt.
- Never capture on this path.
- If a frame has no usable snapshot, leave it live.

During motion:

- `paintGrid()` continues writing camera CSS vars as it does now in [Canvas.tsx](/Users/nictouron/marver/src/client/shell/canvas/Canvas.tsx:51).
- A throttled imperative visibility pass may mark newly entering frames; no React render.
- CSS controls snapshot/iframe opacity.

At settle:

- Wait two rAFs plus roughly 120 ms.
- Put the snapshot behind the iframe.
- Fade the iframe from `opacity: 0` to `1` over 80–120 ms.
- On `transitionend`, hide the snapshot and clear facade classes.

This is safer than fading a foreground snapshot directly to transparent over an iframe that may still be white.

Comments remain outside the clipped facade and keep their current z-order. Freeze their last-known pin rects while a sweep is active; resume anchor resolution only after the matching layout-settled message.

## 4. Minimum shippable first slice

Do **snapshot-during-gesture only**, not portal-only:

1. Add the frame-side `html-to-image` producer for TSX frames.
2. Keep one latest exact snapshot per node at its current width/height/theme/revision.
3. Add the `<img>` facade to `FrameNode`.
4. Drive it from `.sh-gesturing`, excluding `.sh-resizing`.
5. Crossfade back after settle.
6. Verify the 775-line Next frame with the existing blank-frame counter, Chrome Paint Flashing/Layers, trackpad pan, pinch zoom, space-pan, theme, comment pins, and several zoom levels.

This slice makes no device-layout or residency changes. If the heavy Next frame’s DOM snapshot is visibly unacceptable, treat that as producer failure and keep live pixels—do not immediately commit to the portal. First isolate the unsupported feature and assess a narrow renderer patch.

## 5. Device-sweep FLIP on the same primitive

The current device path must change structurally. Today `setDeviceView()` immediately changes every node’s `w/h` and calls tidy in [store.ts](/Users/nictouron/marver/src/client/shell/store.ts:628), while `.sh-preset` CSS animates the iframe’s width through every intermediate value in [styles.css](/Users/nictouron/marver/src/client/shell/styles.css:146). That is exactly what Stage 2 must stop doing.

Implement the second slice as:

1. Extract a pure `planDeviceProjection(name, scope)` returning final nodes, `baseLayout`, and device state without mutating.
2. Separate target card geometry from each iframe’s `liveWidth/liveHeight`.
3. `canvasCtl.deviceSweep()` creates a monotonically increasing transaction id and captures First geometry.
4. Cover visible frames using the existing facade.
5. Commit final card geometry and tidy once. Keep `baseLayout` untouched for Default restoration.
6. Animate visible node cards First→Last with Web Animations/compositor transforms for ~180 ms. Do not apply `.sh-preset` width transitions.
7. Commit visible iframe widths directly to the final value in batches of 1–2 per rAF. Off-screen iframes retain their old live width until they enter overscan.
8. The frame bridge’s `ResizeObserver` posts `sh:layout-settled` with transaction id, generation, revision, and measured width after two stable frames.
9. Reveal each live iframe independently; use a 500 ms upper bound.
10. Re-bake the exact target snapshot later at idle priority.

Publish then plugs a second producer into the same cache/manifest contract: preferably a real Playwright/CDP build-time screenshot. If unavailable, explicitly persist accepted live-browser blobs during the publish preparation step. The consumer, keys, facade, and FLIP transaction remain identical.

That gives the clean staging line: **DOM snapshot facade now; FLIP next; native build-time screenshots later; portal only if measured pan/zoom performance still fails.**

