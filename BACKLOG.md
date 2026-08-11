# Backlog

Small items that are not milestone work. One line each; delete when done.

- **Play chrome hide/reveal still misbehaves in some flows.** Run a codex adversarial
  review of the chrome state machine in `src/client/shell/Play.tsx` (chrome open/
  collapsed/hidden × idle × over × hint/snooze, plus the H and ⌘/ transitions and the
  stage-forwarded keys) and fix the survivors. Known-fragile spots: `over` depends on
  pointerenter/leave pairs that break when elements unmount or gain pointer-events:none
  under the cursor; keys forwarded from the stage vs handled in the shell can double-fire
  if focus shifts mid-press.
- **`--base` support for build** (SPEC-M2 §4a says base-aware; v1 is root-hosted only -
  fine for `marver serve`, Railway, and CF Pages). Root-absolute URLs live in the
  generated pages, `frameUrl`, and the favicon links.
- **Serve gate: attempt throttling beyond the scrypt cost** (per-IP backoff) if published
  canvases ever face real brute-force pressure.
- **`--boards` and the host `public/` directory**: the filter covers frames only; public
  assets ship in full (build prints a note). Revisit if a real leak case appears.

## Next phase (2026-08-11 evening - the stabilize-then-launch arc)

- **Release smoke checklist** (each version bump, BEFORE railway up): build the pilot,
  serve locally, verify: glass blur computed on .sh-panel, boot opens fit-all light,
  theme matrix (global sticky / scoped pin / pin round-trip), gate + deep link through
  it, play walk. The dev-vs-published divergences (lightningcss, rzpp race, read-only
  pins) all ship silently without this. Candidate: script it as `marver smoke`.
- **Verify & close GitHub issues #1/#2** (cold-boot double-boot) - the module-level
  boot guard likely fixed both.
- **M1 leftovers**: focus mode (#/f/ reserved in the URL scheme), ⌘K jump, built-in
  theme frame, culling with hysteresis, pan perf gate (p95 < 16ms @ 30 frames).
- **marver.design - the actual website**: the gate footer and metadata already point
  there. Landing page telling the story (agent-native canvas, design → prototype →
  publish), install instructions, the cookbooks, live demo link (the pilot deploy).
- **Stress test pass**: big boards (50+ frames), rapid board switching, multi-tab sync
  under sustained edits, published build on slow connections, play mode long flows.
- **Distribution**: claim @marver npm scope (bare name squatted); pick a license (MIT
  fits) + repo visibility before any "open source" claim; connect Railway service to
  GitHub for push-to-deploy.
- **Interact-mode goto silently grows the board, with no way back.** In interact mode,
  clicking a data-goto whose target frame is not on the current board spawns a node for
  it (App's sh:go handler). Problems: the UI has no node-remove control (deliberate -
  only agents edit boards), so the addition is irreversible from the canvas; and the
  sidebar reportedly does not render these board-added frames. Decide the right model:
  goto-to-off-board could pan/spawn as a TRANSIENT (unsaved) node, or prompt, or follow
  without adding. Discuss before building. (Reported 2026-08-11, parked for publishing.)
