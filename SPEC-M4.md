# SPEC-M4 — Performance, Reliability & the Live-Session Guarantee

Status: DRAFT (2026-08-14). High-level milestone spec. Mechanism-level detail and the two
Codex consults live in `CONSULT-perf-reliability-2026-08-14.md`; this spec is what an engineer
(or agent) executes against. One open decision is flagged in §Track C / §5.

---

## 0. Why this milestone

Two projects dogfooded live (a Next.js 16 marketing site; a Vite/React-Router TMS app) surfaced
one honest gap: Marver is a great tool that is not yet reliable or fast enough while a user works
the canvas AND agents edit files in parallel. Thirteen findings sorted into four themes:

- **Reliability under live churn** — cold-boot timeouts, mid-edit crash cards, laser/comment mode
  dying board-wide, a rename resurrecting a ghost board, prototype scroll snapping to top.
- **Performance at scale** — slow/janky zoom-pan on heavy boards; a heavy frame flashing white and
  blanking during pan; the board-wide device sweep needing to stay smooth.
- **Multi-project / multi-agent hygiene** — two projects colliding on port 5199 (a tab shows the
  wrong project); board filenames doubling as routes so spaces break loading.
- **Authoring quality** — the agent hand-rolling diagram styling/colors, kebab dashes in sidebar
  labels, a mislabeled copy-path shortcut.

Root of the two big themes: every frame is a live full app in an iframe, all mounted at once,
re-executed on every change. 30 live apps = slow; a heavy one drops its compositor layer during
the canvas transform = white flash; churn in any one = crash / mode loss.

**Thesis (the whole milestone in one line):** *snapshot-first presentation, stable iframe
identity, bounded live residency, and shell-owned recoverable sessions* — which removes "all
frames must be live and painted at all times" as an accidental requirement while keeping every
live-DOM feature. Device sweeps and agent edits become **presentation transactions, not document
reloads**: the shell, board model, iframe identity, and session state stay mounted; only projected
geometry and frame revisions change.

---

## 1. The non-negotiable — what must NOT break

Every change in this milestone is gated on preserving these. If an optimization would weaken one,
it is wrong by definition.

- **Laser mode** — outlines every element in every visible frame; click copies its CSS path + source.
- **Comment on a specific interactive element** — drive the live app to a state, click an element,
  the thread anchors to it (semantic → CSS path → fuzzy quote), pins survive agent edits.
- **Prototype / play mode** — a fully live, interactive app; variant switching; data-goto navigation.
- **Live responsive resize** — dragging a frame reflows the real app at the new width (snaps to
  device widths); the frame is a live site, not a picture.
- **Board-wide device sweep** — clicking Mobile/Tablet/Laptop/Monitor with no selection re-lays-out
  every frame to that width via live reflow; "Default" restores hand-placed positions exactly.
- **Content frames** — Doc/Diagram/Md/Img, measured heights, the marver diagram palette.
- **Variant groups**, boards/scenes, theme matrix (global sticky / scoped pin), the password gate,
  published-canvas parity, the comment event-log + sync.

The user must be able to **stay in the action**: give agents instructions, return to the canvas,
and keep working in their active mode while agents cook — never cut out, never white-zapped.

---

## 2. Architectural model

A frame's state is **four orthogonal axes**, not one linear mode (the mistake to avoid):

| Axis | States |
|---|---|
| **Residency** | `hibernated` (iframe navigated to a tiny dormancy doc) / `mounted` |
| **Presentation** | `snapshot` (cached picture over it) / `live pixels` |
| **Interaction** | `passive` (pointer-events off) / `interactive` |
| **Health** | `queued` / `booting` / `committed` / `ready` / `updating` / `failed`, each with a generation id |

Invariant that preserves the existing iframe law while allowing memory reclaim:

> **One stable iframe element per node key. Its document moves between dormant and live
> generations only by assigning `.src` — never by React remounting a different element.**

State separation is the backbone of reliability — these three must never share a replace-all
hydration path:

- **SessionState** — activeBoard, camera, selection, activeMode, focusedFrame, stageHistory,
  stageScroll, panelState, pendingComment, laserState. *Owned by the live shell session; never
  replaced by a manifest or board reload.*
- **DocumentState** — manifest revision, boards, baseLayouts. *Server-derived from disk; applied
  as scoped diffs.*
- **FrameRuntimeState** — iframe identity, liveRevision, pendingRevision, liveWidth, scrollState,
  interactionLease. *Per frame.*

---

## 3. Tracks & rollout

| Stage | Track | Ships | Needs snapshots? |
|---|---|---|---|
| **0** | B | Instrument + stop bleeding shell work | no |
| **1** | A | Self-healing sessions → **"stay in the action"** | no |
| **2** | B | Snapshot facade → white-flash + **smooth device sweep** | yes |
| **3** | B | Visible working set + `content-visibility` suspension | yes |
| **4** | B | Deep hibernation (50+ frame boards tractable) | yes |
| **5** | B | Screen-space portal — **only if** 2–4 miss the perf gate | — |
| ongoing | C | Multi-project / board-identity hygiene | no |
| ongoing | D | Authoring quality & polish | no |

Each stage ships value on its own. **Do Stage 0 then Stage 1 first** — they fix the reliability
findings and deliver the stay-in-the-action guarantee with no snapshot machinery.

---

## Track A — Live-session reliability  (Stage 1, PRIORITY)

**Problem.** Agent edits and cold boots currently reload, crash, or dead-card frames and drop the
user's viewport and mode. This is the thing that most hurts the live experience.

**Invariant to enforce.**
> A filesystem revision may update frame content and the catalog, but it may never replace or
> reinitialize the shell session. The shell applies every external change as a scoped, revisioned
> diff while preserving all unrelated session state and every unaffected iframe browsing context.

**Under any agent edit, these must NEVER happen:** browser full-page reload · shell React-root
remount · board-route replacement · zoom/pan reset · selection reset (unless that node was deleted)
· comment/laser/prototype mode drop · play history or scroll reset · iframe reparenting · unrelated
iframe reload · focus steal · panel reset · autosave triggered by a derived manifest change · white
iframe exposure · a stale async update applying after a newer revision · a deleted/renamed board
recreated by a stale debounce.

**Work items & acceptance.**

- **A1. Split the stores.** Session / Document / FrameRuntime state on separate update paths; a
  manifest or board change applies as a diff, never a store replace.
  *Done when:* editing a frame while panned/zoomed leaves camera, selection, and mode byte-identical.
- **A2. Stable shell + iframe identity.** Shell root never reloads for a `design/**` change;
  `FrameNode` insertion order and keys stay stable across manifest updates.
  *Done when:* a manifest update never remounts an unaffected iframe (assert identity in a test).
- **A3. Phased, generationed handshake.** Replace the fire-immediately `sh:ready` (currently posted
  before React commits) with `sh:bridge-alive → sh:booting{phase} → sh:committed (from a layout
  effect) → sh:ready → sh:error{fatal,phase} → sh:diagnostic`. Every message carries
  node-key / frame-id / document-generation / sequence. An app `unhandledrejection` is
  `diagnostic`, **not** fatal — only boot failure or an ErrorBoundary render failure cards a frame.
  *Done when:* a runtime console error in a frame does not card it; only a real render/boot failure does.
- **A4. In-place auto-recovery.** On fatal failure or timeout: keep the last good snapshot/pixels
  visible, keep shell mode/intent unchanged, leave HMR connected, and retry ONLY the affected frame
  on the next `vite:afterUpdate` / reconnect / manifest revision by assigning a fresh generation URL
  to the same iframe element. Reset the frame-host ErrorBoundary on an HMR epoch. Manual reload
  becomes a fallback, not the only path.
  *Done when:* a mid-edit half-written save cards the frame, and the agent's next (fixing) save
  clears it with zero user action; the error card shows above the last snapshot, not a blank iframe.
- **A5. Replay modes on commit.** After every committed-ready, idempotently replay theme, laser,
  comment-pick, anchor resolution, and focus. One frame's error never resets a board-wide mode; the
  overlay is per-frame so a dead frame is skipped, not fatal.
  *Done when:* crashing/HMR-reloading one frame leaves laser/comment active on every other frame.
- **A6. Interaction leases.** While a frame has an active gesture or is in comment/laser/prototype,
  defer applying a new revision until a safe point (pointer-up, blur, nav complete, or an explicit
  "Update ready" affordance for prototype). Coalesce N saves into the latest pending revision. Never
  yank the user mid-gesture; snapshot-shield visible-but-idle frames and crossfade the update in.
  *Done when:* editing a frame the user is actively prototyping shows an "Update ready" badge instead
  of reloading under their cursor; editing a visible idle frame updates with no white flash.
- **A7. Controlled HMR for `design/**`.** Stock Vite HMR executes the module + React Refresh before
  the shell can decide it is safe — it cannot deliver A6. `handleHotUpdate` recognizes affected
  `design/**` modules, suppresses the default reload, and emits `sh:frame-invalidated{frameIds,
  revision}`; frame-hosts load the accepted revision only when the shell authorizes it (revisioned
  module URLs / a revisioned virtual-frame module); invalidations coalesce under a lease. Shared
  `src/**` deps (e.g. a Button) that fan out to many frames are deferred to Track B / Stage 3
  (module-graph traversal); Stage 1 guarantees controlled updates for direct frame/layout/provider/
  fixture edits and prevents shell reloads for everything else.
  *Done when:* saving a frame file never triggers a browser full reload; the shell decides when it applies.
- **A8. Cold-boot / optimizer race.** `marked`+`mermaid` are already in `optimizeDeps` — insufficient.
  Add `server.warmup` for the frame-host + content primitives + known-heavy frame modules; cap cold
  frame-navigation concurrency (start at ~2, not 30); do NOT run the 10s ready-watchdog while the dev
  server reports optimization/warmup in progress. The watchdog distinguishes no-bridge (nav/server
  failure) vs bridge-alive-import-pending (optimizer wait) vs committed-not-measured vs fatal.
  *Done when:* a cold `dev` start never shows 30 simultaneous "frame failed" cards.
- **A9. Board autosave hardening + ghost-board fix.** Per-board save timers + generations; every
  save carries `baseHash` + `clientId` + `mutationId` + `mustExist:true` and the server does an
  atomic compare-and-swap immediately before rename. A missing destination under `mustExist` returns
  409/410 and NEVER creates. External unlink/rename increments the board's generation and cancels its
  pending save; rename is correlated by content hash / stable board id, not resurrected. Manifest
  changes never mark a board dirty. Disk stays authoritative, but "disk wins" applies a node-level
  diff — it never resets the session or reloads the route.
  *Done when:* renaming/deleting a board out from under the shell during a pending autosave does not
  recreate it; the session (camera/mode) survives an external board change.
- **A10. Play-mode scroll preservation.** On `vite:beforeUpdate`/`beforeFullReload`, save
  `window.scrollX/Y` and opted-in scroll containers (`data-sh-scroll-key`) to `sessionStorage`;
  restore after the same stage/frame generation commits. Arbitrary component state is not promised —
  the update is deferred (A6), not magically preserved.
  *Done when:* an agent edit during prototype no longer snaps the user to the top.

---

## Track B — Canvas performance  (Stages 0, 2–5)

**Problem.** Heavy boards zoom/pan slowly and janky; a heavy frame flashes white during the canvas
transform; the device sweep must stay board-wide-live yet smooth. Perf must hold in dev AND publish.

**Perf gate (release gate, real hardware, both a heavy Next board and a Vite/RR board):**
`p95 main-thread work < 16 ms per animation frame during pan/zoom and during a device sweep on a
50-frame board.` Not "all 50 frames in 16 ms" — that is impossible with real reflow. Measure rAF
intervals, long tasks, warm-promotion latency, decoded-snapshot memory, and blank-frame occurrences.

### Stage 0 — instrument + remove avoidable shell work (no behavior change)
- **B0.1** Keep camera state out of React during gestures. Today `onTransformed` writes scale into
  the store and every `FrameNode` subscribes → ~30 React updates per gesture frame. Keep camera in
  refs / CSS variables during gestures; commit only settled state.
- **B0.2** Correct wheel ownership across iframe documents: passive/laser/comment frames forward and
  prevent-default canvas wheel gestures; the active interactive frame keeps app scrolling. (Fixes
  "wheel scrolls the page instead of zooming.")
- **B0.3** Replace `iframe.closest('[data-node]')` DOM scans with a `WindowProxy → node session` registry.
- **B0.4** Add real-board frame-time / blank-frame / warm-latency instrumentation.
  *Done when:* pan/zoom jank measurably drops with zero feature change; we have trustworthy evidence.

### Stage 2 — snapshot facade → white-flash + smooth device sweep
- **B2.1 Snapshot cache.** Durable snapshots are **real browser screenshots** (Playwright/CDP-class),
  generated asynchronously, keyed by `{frameId, sourceRevision, width, theme, dprBucket}` (width-only
  keys are a trap — they show a stale post-edit frame as current). Never captured synchronously at
  gesture start; gesture-time switching uses an already-cached snapshot. Dev: a single-concurrency
  background worker captures after a frame commits and the edit stream is briefly quiet, keeping the
  last good snapshot while a newer one is pending. Publish: pre-bake the exact widths/themes each
  published board uses, into a snapshot manifest, so a published canvas loads instantly and hydrates
  live on interaction. Bounded decoded-bitmap LRU (50 desktop snapshots = hundreds of MB of GPU mem).
- **B2.2 White-flash fix — snapshot during transform.** At pan/zoom start, reveal already-decoded
  snapshots over every frame except the actively-resized one; keep live docs mounted underneath; at
  gesture end wait ~120–200 ms then restore over 1–2 frames, snapshot behind the iframe during the
  crossfade so a delayed first paint never exposes the card background. Layer hints (`contain`,
  gesture-scoped `will-change`) reduce invalidation but CANNOT guarantee retention — do not ship
  `translateZ(0)`/`backface-visibility` as a claimed fix. (The Next-worse-than-Vite cause is
  raster/main-thread cost, not hydration — Marver uses `createRoot`; verify with Chrome Layers /
  Paint Flashing before any stack-specific workaround.)
- **B2.3 Device sweep — the 4-phase FLIP transaction.** A sweep is a transaction with an id (a newer
  sweep invalidates the older; every async completion checks the id):
  1. **Cover** each visible live frame with an old-width snapshot (never remount/reparent the iframe).
  2. **FLIP** the snapshot cards to their tidied target `{x,y,width,height}` via compositor transform
     (~180 ms). **Never CSS-animate the iframe's width** — every intermediate width is a full reflow.
  3. **Reflow** each visible live iframe ONCE straight to final width underneath; off-screen frames
     only move their box (lazy reflow on scroll-in).
  4. **Crossfade** the snapshot out when a bridge `ResizeObserver` posts `sh:layout-settled{frameId,
     sweepId, width, sourceRevision, scrollHeight}` (bounded 300–500 ms deadline; on timeout reveal
     the painted live frame — never leave a permanent snapshot). Snapshot rebake happens AFTER reveal.
  `baseLayout` is sacred: device projection is separate state; a sweep never writes device positions
  over hand-placed x/y; "Default" FLIPs back to the stored rectangles. Tidy + crossfade compose as
  ONE transaction (compute the full target layout first; do not animate width-in-place then tidy; do
  not re-tidy as heights settle). For v1 a device preset fixes both width and card height.
- **B2.4 Reflow scheduler.** Process the visible set in bounded batches (1–2 iframe width commits per
  rAF, raise only if measured headroom), priority: selected → visible-nearest-center → visible →
  overscan-in-scroll-direction → other overscan → cold-on-approach. `scheduler.postTask` /
  `requestIdleCallback` for snapshot rebakes and cold maintenance. **Off the critical path:**
  screenshot capture/encoding, FS/API writes, board autosave, manifest rescans, per-card DOM
  measurement, `scrollHeight` reads, reflowing all iframes, cache eviction, font waits, React remounts.
  *Done when:* the white flash is gone on the heavy Next frame; a board-wide device sweep animates
  smoothly and holds the perf gate; the resize target still reflows live.

### Stage 3 — visible working set + suspension
- Visibility computed once per rAF from `{tx,ty,scale}` (50 AABB intersections; no R-tree). Warm at
  ~1.25 viewport margins; stay warm until outside ~2 margins for ~3 s; hibernation-eligible after
  ~30–60 s. Never demote selected / interacted / resized / comment-hosting / play frames. Cap live
  residency (~6–10 heavy frames initially). Laser/comment activation warms ALL visible frames
  (bounded concurrency, replay the mode on each committed-ready) — the laser contract is "outline
  every visible frame," so this is required, not optional.
- `content-visibility:hidden` inside off-screen mounted docs behind snapshots (suspends paint/layout,
  keeps DOM + React state; note it does NOT stop JS/timers/effects).
- Comment pins cache their last resolved rect keyed by `{anchorHash, docGeneration, logicalWidth,
  snapshotRevision}`; a snapshot shows a cached pin only when keys match, else a parked pin until warm.
  Replace the unconditional 4 s comment poll with bridge-originated invalidations (debounced scroll/
  resize/mutation) plus a slow safety poll for engaged frames only.
  *Done when:* paint/layout cost drops on heavy boards with React state retained; laser/comment stay correct.

### Stage 4 — deep hibernation
- Navigate long-cold iframes to a lightweight dormancy document; restore only by assigning a new
  generation URL to the same element. Weighted LRU by boot cost + observed memory; snapshot-memory
  budget. Never hibernate focused/selected/open-comment/resizing/play frames (arbitrary app state is lost).
  *Done when:* a 50+ frame board stays within a defined CPU/memory budget with explicit state-loss boundaries.

### Stage 5 — screen-space live-surface portal (conditional)
- Only if Stages 2–4 still miss the gate: portal the visible live iframes into a fixed overlay layer
  (transform `translate(screenX,screenY) scale(canvasScale)`) so the huge transformed subtree stops
  re-rasterizing every iframe. High-risk (clipping, radii, z-order vs comment cards, wheel ownership,
  pin coordinate mapping, DPR/page-zoom, group drag/resize). Prototype for the active + small visible
  set; ship only if the full laser/comment/resize/device-sweep matrix passes in dev and published bundles.

---

## Track C — Multi-project & board-identity hygiene  (ongoing)

**Problem.** Two dev servers collide on the hardcoded `port: 5199`, so a tab silently serves the
wrong project; board filenames double as URL routes so spaces/caps break loading; renames leave ghosts.

- **C1. Deterministic per-project port.** Derive the default from a hash of the project path into a
  range instead of scaffolding a fixed `5199` into every `init`; on a genuine collision with ANOTHER
  marver instance, pick a deterministic alternate and log loudly "5199 held by <other>, serving <this>
  on 5201." *Done when:* two concurrent projects never share a port and each repo always lands on its own.
- **C2. Show the project in the UI.** The sidebar header says only "Marver"; show the project name
  (host package.json / dir) so a port swap reads as "wrong project," not corruption.
- **C3. Board identity = slug + title.** A board file is a lowercase kebab **slug** (the filename and
  the `#/b/<slug>` route); the display name is a separate `title` field in the JSON (or a humanized
  slug). Reject/slugify board names with spaces/caps on save; `encodeURIComponent` the board name in
  the fetch. This, plus A9's `mustExist` + CAS, structurally ends ghost boards and broken routes.
- **C4. Boards stay single-writer [DECISION — see §5].** Plain JSON board files cannot be safely
  co-edited by multiple agents (no compare-and-swap). Recommended scope: **agents author scenes/frames
  across boards concurrently; the shell is the single writer of board-layout JSON.** True multi-writer
  boards (stable node ids + CAS API or an op-log/CRDT) are Track B/Stage-4-style later machinery, only
  if agents must co-edit one board's layout.

---

## Track D — Authoring quality & polish  (ongoing)

**Problem.** The agent hand-rolls presentation that Marver should own, so a human keeps teaching it
the convention. Principle: **one named palette everywhere; the primitives absorb the CSS/HTML so the
agent expresses intent, not styling.**

- **D1. Diagram node title/subtitle sugar.** A plain delimiter (`Corporate HQ · control tower`) in a
  mermaid node label auto-renders bold title over muted subtitle, via a preprocess in `diagram.tsx`
  `cleanSource()` — no inline `<div style="opacity">` HTML hacks.
- **D2. Built-in family colors.** Pre-define named family classDefs from `content/palette.ts`
  (shipper=blue, carrier=orange, driver=purple, platform=gray, mover=green …) so the agent tags
  `HQ:::shipper` with zero classDef boilerplate — same named families as D3.
- **D3. Colored/highlighted inline Md.** A `marked` inline extension (`:blue[…]` / `:carrier[…]`,
  optional `==mark==`) emitting theme-aware classes bound to the SAME palette as D2 — never raw HTML.
- **D4. Full-width rich Md** under a diagram (confirm `Doc layout="wide"` / Row/Col coverage; add
  full-bleed measure as needed).
- **D5. Humanize sidebar labels.** Replace `cap()` in the nav path with `humanize()` (de-hyphenate +
  Title Case); honor explicit `meta.title` verbatim; acronyms handled by the C3 board `title` field.
- **D6. Copy-path shortcut.** Fix the stale `C` tooltip; rebind copy-path to `Shift+P` (P = Path;
  `p` is play). Confirm key with Nic before wiring.
- **D7. Teach-the-agent doctrine.** A content-frame + diagram authoring reference in `instructions/`
  (routed from AGENTS + `craft.md`): family-color discipline, the title/subtitle convention, when to
  go full-width, composing prose/image/diagram into one rich document — so the agent does D1–D5 unprompted.

---

## 4. Cross-cutting invariants & the silent-break checklist (review gate)

Every PR in this milestone is reviewed against these. A change that trips one is wrong even if it
looks faster:

- Never animate a live iframe's `width` across intermediate values.
- Never reflow all off-screen frames during a sweep; never resize all cold iframes just because they're mounted.
- Never let target-width settlement re-run tidy; never let content-height discovery make the board swim.
- Never write device-projected positions over `baseLayout`.
- Never use width-only snapshot keys (must include source revision + theme + dpr).
- Never let an old sweep/update completion apply after a newer one (generation-guard every message).
- Never assume a snapshot overlay makes an ACTIVE prototype HMR safe (it protects pixels, not DOM
  targets / handlers) — defer the swap.
- Never leave default Vite/React Fast Refresh in control while claiming updates are deferrable.
- Never replace the whole shell store when a manifest or board changes; apply diffs.
- Never treat FS-watcher events as isolated logical edits (coalesce unlink/add/change of one save).
- Never let a manifest change mark a board dirty or trigger a board autosave.
- Never let an autosave PUT create a previously-existing-but-now-missing board (`mustExist`).
- Never reload an active board or route to resolve a disk-wins conflict; diff it.
- Never promise conflict-free direct JSON editing of one board by multiple agents.
- Never card a frame for an app runtime error (only boot/render failure is fatal).
- Never blow away the user's camera, selection, mode, or scroll on an agent edit.

---

## 5. Sequencing & the open decision

**Build order:** Stage 0 (instrument) → **Stage 1 / Track A (self-healing sessions = stay in the
action)** → Stage 2 (snapshot facade = white-flash + device sweep) → Stage 3 (working set) →
Stage 4 (hibernation) → Stage 5 (portal, only if the gate is missed). Track C and Track D land
alongside (C3 + A9 together end ghost boards; D items are independent polish). Ship each stage
behind the perf gate and the review checklist.

**Open decision (Nic):** confirm **Track C4** — boards stay single-writer (agents author
scenes/frames concurrently across boards; the shell owns board-layout JSON). This keeps Stage 1
lean and structurally kills the ghost-board class. Only if Nic wants two agents co-editing the SAME
board layout do we add Stage-4 multi-writer board machinery. Everything else in this spec is
independent of that call.

**Definition of done for M4:** every feature in §1 still works in dev and publish; the perf gate
holds on a heavy Next board and a Vite/RR board; and the stay-in-the-action guarantee passes its
session-preservation tests (edit active/inactive frames while panned/zoomed and in each mode;
rename/delete a board mid-autosave; burst-save five revisions; edit two scenes at once — asserting
the shell root and unaffected iframe identities never change).
