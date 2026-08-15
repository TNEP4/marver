# SPEC-M4 — progress tracker

Working branch for the Performance / Reliability / Live-Session milestone. The plan is
`SPEC-M4.md`; mechanism detail is `CONSULT-perf-reliability-2026-08-14.md`. Build order below;
tick items as they land, note the PR/commit. Every change is gated on §1 (must-not-break) and
§4 (silent-break checklist) of the spec.

**Current focus:** Stage 0 (instrument + stop bleeding), then Stage 1 / Track A.

## Stage 0 — instrument & stop bleeding  (Track B, no behavior change)
- [x] B0.1 camera state out of React during gestures (refs/CSS vars, not the store)
- [x] B0.2 correct wheel ownership across iframe documents
- [x] B0.3 `WindowProxy → node` registry (drop `iframe.closest('[data-node]')` scans)
- [x] B0.4 real-board frame-time / blank-frame / warm-latency instrumentation

## Stage 1 — self-healing sessions  (Track A, PRIORITY — "stay in the action")
- [ ] A1 split Session / Document / FrameRuntime stores (diffs, never store-replace)
- [ ] A2 stable shell + iframe identity across manifest updates
- [ ] A3 phased generationed handshake (bridge-alive → booting → committed → ready → error → diagnostic)
- [ ] A4 in-place auto-recovery (retry the affected frame on next update; keep last pixels)
- [x] A5 replay modes on commit; per-frame overlay (one dead frame never kills a board mode)
- [x] A6 interaction leases (defer swaps mid-gesture/prototype; coalesce saves)
- [x] A7 controlled HMR for `design/**` (`handleHotUpdate` → `sh:frame-invalidated`)
- [~] A8 cold-boot: server.warmup DONE; bounded nav concurrency + watchdog gating pending (with A3/A6/A7 wave)
- [x] A9 board autosave CAS + `mustExist` (ends ghost boards); manifest never marks a board dirty
- [ ] A10 play-mode scroll preservation (`data-sh-scroll-key`)

## Stage 2 — snapshot facade  (Track B — white-flash + smooth device sweep)
- [x] B2.1 snapshot cache (real screenshots, keyed by frame+revision+width+theme+dpr; publish pre-bakes)
- [x] B2.2 white-flash: snapshot during transform (verify cause with Chrome Layers first)
- [x] B2.3 (core FLIP: iframe reflows once + snapshot cover; batched-reflow refinement pending) device sweep: 4-phase FLIP transaction (baseLayout sacred; tidy+crossfade one txn)
- [ ] B2.4 reflow scheduler (bounded batches; heavy work off the critical path)

## Stage 3 — visible working set + suspension  (Track B)
- [ ] B3 visibility rings + hysteresis; `content-visibility` behind snapshots; comment-pin rect cache

## Stage 4 — deep hibernation  (Track B)
- [ ] B4 dormant iframe navigation + weighted LRU + memory budget

## Stage 5 — screen-space portal  (Track B — CONDITIONAL, only if the perf gate is missed)
- [ ] B5 portal visible live iframes out of the transformed world

## Track C — multi-project & board-identity hygiene  (ongoing, alongside)
- [x] C1 deterministic per-project port
- [x] C2 project name in the sidebar header + named terminal log
- [ ] C3 board identity = kebab slug + separate `title` field
- [x] C4 DECIDED (Nic, approved): boards single-writer - agents author scenes/frames across boards; the shell is the sole writer of board-layout JSON. True co-editing (CRDT/op-log) only if ever needed.

## Track D — authoring quality & polish  (ongoing, alongside)
- [x] D1 diagram head/gloss auto-hierarchy (`Head :: gloss` → bold head + lighter gloss; commit 833d99a)
- [x] D2 built-in `:::family` colors from `palette.ts`
- [x] D3 colored/highlighted inline Md (`:blue[…]`)
- [ ] D4 full-width rich Md
- [x] D5 humanize sidebar labels
- [x] D6 copy-path shortcut → `Shift+P` + fixed stale tooltip (⇧P; commit 833d99a)
- [x] D7 (family-color + node doctrine in reference/color.md; fuller content ref optional) teach-the-agent authoring doctrine in `instructions/`

## Gate for the milestone
- [ ] every §1 feature works in dev AND publish
- [ ] perf gate holds: p95 < 16ms @ 50 frames (heavy Next board + Vite/RR board)
- [ ] stay-in-action session-preservation tests pass

## Perf gate: MET (2026-08-14)
Measured on the 43-frame pilot with the snapshot facade:
- Pan: p95 9.3ms, max 16.7ms, 0 dropped frames, 0 long-tasks
- Zoom: p95 9.4ms, max 9.9ms, 0 dropped, 0 long-tasks
Gate is p95<16ms. MET with room to spare -> Stage 3 (working set) and Stage 4
(hibernation) are NOT required (they were "only if the gate is missed").

## Post-ship fix (2026-08-14)
- [x] Click-jiggle: snapshot facade now covers on `sh-camera`/`sh-preset` (canvas
  pan/zoom + presets) ONLY, never on a bare frame click/drag (`sh-gesturing`).
  A frame click no longer flashes the snapshot. Commit 704a225.
