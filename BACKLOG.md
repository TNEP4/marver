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

- **0.2.2 BUILT incl. THE METHOD LAYER (2026-08-12) - staged for publish.** Infra:
  update discovery (daily-cached registry check, stdout + glass update pill,
  MARVER_NO_UPDATE_CHECK opt-out); setup presence-file; design/ collision guard
  (content-based). THE METHOD: design/instructions/ - configure (idle state, three
  repo maturities), discover (repo-first interview, mode taxonomy), wireframe (strict
  lo-fi: throwaway code correct, real copy, structure only), brand (extract-or-create
  + anti-slop list), craft (strict floor: verify/refuse lists), components
  (props-not-APIs, a11y baseline, gallery contract), review (bounded passes + keyboard
  walk), boards (extracted from AGENTS.md). AGENTS.md = lean routed contract w/
  binding method table; managed-file regeneration (marker prefix check survives
  wording changes); init tests added (17 total). Craft rules distilled from public
  best-practice references, re-expressed entirely in our own words. Two codex rounds; deferred:
  legacy design/SETUP.md migration (no published version ever wrote it), --dir.
  After publish: unattended agent upgrade test on marver-site (0.2.1 -> 0.2.2).
- **From the 0.2.2 upgrade test (2026-08-12) - triage results.** FIXED in repo:
  design/tsconfig self-exclusion (TS18003 - host exclude inherited via extends; template
  now overrides exclude + allowImportingTsExtensions), unattended-mode path in
  discover.md, init notes the missing DESIGN.md. OPEN: (1) new npm import in a frame ->
  blank white frame + 504 Outdated Optimize Dep, no error card; ALSO manifests as
  dual-React 'Cannot read properties of null (useRef)' error cards on frames adding
  their first component-library import mid-session (hit twice now, 2026-08-12) -
  restart + rm node_modules/.vite heals; likely fix = optimizer warm-up or auto-restart-on-504 (frame-host should catch
  the failed import and card it; investigate optimizeDeps discovery); (2) two dev
  canvases on one repo both own the auto board with no warning (lockfile or banner);
  (3) host eslint sweeps design/.dist (document, or init hints an ignore); (4) cac
  prints "(default: true)" on --no-demo regardless of description (suppress or restructure
  flag); (5) consider making design/tsconfig.json a managed file so template fixes reach
  existing workspaces (currently write-once; ours fixed by hand).
- **From the day-zero TMS test (2026-08-12) - triage.** FIXED in repo: the @/ alias
  P0 (init now re-roots host tsconfig paths into design/tsconfig.json - Vite resolves
  against the nearest config, inherited paths point at the wrong dir); setup.md's
  create-next-app collision (temp-dir + merge dance documented) and stale shadcn flags.
  OPEN: (1) **`marver check` - strong feature candidate**: validate data-goto targets,
  orphan frames, duplicate view-transition-names, frames that fail to render - all
  answerable from manifest.json + a headless pass; the agent hand-rolled exactly this
  (merge with the `marver smoke` bullet); (2) frames that 500 look identical to healthy
  boards until a browser opens - dev could surface frame HTTP errors in the terminal;
  (3) tsconfig edits need a Vite restart + node_modules/.vite delete to take - detect
  and say so, or auto-bust; (4) three marver instances on one machine collided on ports
  5199/5200 (relates to the dual-canvas contention item).
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
- **FRICTION TRIAGE DONE (2026-08-12) - 0.2.1 staged, Nic to publish.** All 23 friction
  issues triaged; every bug-shaped one fixed and browser-verified (see DECISIONS.md).
  Remaining product decisions parked below. Publish: `cd ~/marver && git push && npm
  publish` from a real terminal (passkey 2FA), then bump the pilot + marver-site to
  `@marver-design/marver@^0.2.1` and redeploy Railway.
- **PARKED for Nic - variant groups (friction #19, the big product idea).** The
  convention (scene = surface, variants = a-/b-/c- sibling frames) is now documented in
  AGENTS.md and survives tidy/device views. The FEATURE half needs product decisions:
  `meta.of/variant/order` as a first-class group, group-aware tidy (never split or
  interleave a group), a caption + variant chrome on canvas, variant switching in play
  mode (←/→ swaps direction A/B/C on the same screen mid-flow - the killer review
  feature), sidebar variant switcher. Also #16's ask that tidy lay out in rows, and
  "make board layout durable" (device-view keys currently rewrite hand-placed x/y even
  on `auto:false` boards - decide what `auto:false` should promise).
- **Serve host needs a persistent volume note** - when M3 comments land, publish docs
  must say loudly that `marver serve` hosts need a volume (SPEC-M3 §5 already flags it).
- **M3 comments/identity/access: SPEC-M3.md written as WIP (2026-08-12)** - event-log
  comments, dev<->published union sync, one publish target per repo (decided), email
  allowlist w/ READ vs READ+COMMENT roles. Five UNRESOLVED questions in §3 (identity
  verification, read-gating, unknown-email UX, allowlist editing, avatars). Promote to
  contract after the dogfood friction triage; no code before promotion.
- **Distribution: DONE 2026-08-11** (see DECISIONS.md) except user actions: send
  dispute email, flip repo public + register trusted publisher, carrara-labs npm org
  transfer, move Railway project to personal workspace.
