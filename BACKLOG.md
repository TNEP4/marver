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
- **Distribution (DECIDED 2026-08-11)**: Apache-2.0 (patent grant + trademark carve-out
  protects the Marver name; delta-harness precedent reviewed). Personal open-source:
  Nic's personal npm account creates the free `marver` ORG (not user scope) and
  publishes @marver/design from it - brand-aligned, transferable, still 100% personally
  owned. Steps: npm login + create org (Nic, before it's squatted) -> LICENSE + NOTICE +
  license field Apache-2.0 -> repo public -> trusted-publishing workflow (OIDC, tag-
  triggered) -> pilot switches tarball -> registry dep. Also: move the marver-pilot
  Railway project from the Carrara Labs workspace to a personal one (personal project,
  personal infra - the vault's Personal/Carrara boundary applied).
- **Interact-mode goto silently grows the board, with no way back.** In interact mode,
  clicking a data-goto whose target frame is not on the current board spawns a node for
  it (App's sh:go handler). Problems: the UI has no node-remove control (deliberate -
  only agents edit boards), so the addition is irreversible from the canvas; and the
  sidebar reportedly does not render these board-added frames. Decide the right model:
  goto-to-off-board could pan/spawn as a TRANSIENT (unsaved) node, or prompt, or follow
  without adding. Discuss before building. (Reported 2026-08-11, parked for publishing.)
- **npm dispute email for bare `marver`**: drafted (to hhutton@spurpose.com, cc
  support@npmjs.com) - Nic to send; 4-week clock, then npm adjudicates. If won, publish
  bare `marver` and deprecate @marver-design/marver with a pointer.
- **CLI version banner is hardcoded** (`cli.version('0.1.0')` in src/cli/index.ts) -
  read from package.json at next release.
- **DOGFOOD: marver.design website (NEXT, 2026-08-11)** - fresh repo `~/marver-site`,
  fresh Claude session, official registry install, README-and-AGENTS.md-only onboarding,
  FRICTION.md kept by the dogfooding session. Supersedes the earlier "marver.design"
  bullet's open questions about approach. Friction log gets triaged here for 0.3.0.
- **Distribution: DONE 2026-08-11** (see DECISIONS.md) except user actions: send
  dispute email, flip repo public + register trusted publisher, carrara-labs npm org
  transfer, move Railway project to personal workspace.
