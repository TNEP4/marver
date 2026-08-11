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
