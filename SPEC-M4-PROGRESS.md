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
- [ ] B2.1 snapshot cache (real screenshots, keyed by frame+revision+width+theme+dpr; publish pre-bakes)
- [ ] B2.2 white-flash: snapshot during transform (verify cause with Chrome Layers first)
- [ ] B2.3 device sweep: 4-phase FLIP transaction (baseLayout sacred; tidy+crossfade one txn)
- [ ] B2.4 reflow scheduler (bounded batches; heavy work off the critical path)

## Stage 3 — visible working set + suspension  (Track B)
- [ ] B3 visibility rings + hysteresis; `content-visibility` behind snapshots; comment-pin rect cache

## Stage 4 — deep hibernation  (Track B)
- [ ] B4 dormant iframe navigation + weighted LRU + memory budget

## Stage 5 — screen-space portal  (Track B — CONDITIONAL, only if the perf gate is missed)
- [ ] B5 portal visible live iframes out of the transformed world

## Track C — multi-project & board-identity hygiene  (ongoing, alongside)
- [ ] C1 deterministic per-project port
- [ ] C2 show the project name in the sidebar
- [ ] C3 board identity = kebab slug + separate `title` field
- [ ] C4 DECISION: boards single-writer (agents author scenes/frames, shell owns board JSON)

## Track D — authoring quality & polish  (ongoing, alongside)
- [ ] D1 diagram title/subtitle sugar (`Corporate HQ · control tower`)
- [ ] D2 built-in `:::family` colors from `palette.ts`
- [ ] D3 colored/highlighted inline Md (`:blue[…]`)
- [ ] D4 full-width rich Md
- [ ] D5 humanize sidebar labels
- [ ] D6 copy-path shortcut → `Shift+P` + fix stale tooltip
- [ ] D7 teach-the-agent authoring doctrine in `instructions/`

## Gate for the milestone
- [ ] every §1 feature works in dev AND publish
- [ ] perf gate holds: p95 < 16ms @ 50 frames (heavy Next board + Vite/RR board)
- [ ] stay-in-action session-preservation tests pass
