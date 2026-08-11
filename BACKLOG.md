# Backlog

Small items that are not milestone work. One line each; delete when done.

- **Play chrome hide/reveal still misbehaves in some flows.** Run a codex adversarial
  review of the chrome state machine in `src/client/shell/Play.tsx` (chrome open/
  collapsed/hidden × idle × over × hint/snooze, plus the H and ⌘/ transitions and the
  stage-forwarded keys) and fix the survivors. Known-fragile spots: `over` depends on
  pointerenter/leave pairs that break when elements unmount or gain pointer-events:none
  under the cursor; keys forwarded from the stage vs handled in the shell can double-fire
  if focus shifts mid-press.
