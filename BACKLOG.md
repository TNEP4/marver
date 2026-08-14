# Backlog

Small items that are not milestone work. One line each; delete when done.

- **Play chrome hide/reveal still misbehaves in some flows.** Run a codex adversarial
  review of the chrome state machine in `src/client/shell/Play.tsx` (chrome open/
  collapsed/hidden × idle × over × hint/snooze, plus the H and ⌘/ transitions and the
  stage-forwarded keys) and fix the survivors. Known-fragile spots: `over` depends on
  pointerenter/leave pairs that break when elements unmount or gain pointer-events:none
  under the cursor; keys forwarded from the stage vs handled in the shell can double-fire
  if focus shifts mid-press.
- **Resize-shift report (SPEC-023 §8) - investigated 2026-08-12, not reproduced.**
  Code-level pass found the two plausible mechanisms already guarded: resize handles
  carry `sh-no-pan` AND the gesture flag hard-disables rzpp panning for the drag's
  duration; `resizeNode` touches only the dragged node's w/h. Tooling cannot emit
  trusted pointer-capture drags, so no live repro was possible. NOTE: since SPEC-024,
  boards WITH a layout recipe deliberately re-tidy at resize-gesture end - if the
  original report resurfaces, first ask whether the board had a layout (intentional
  reflow) and capture board + zoom + drag direction.
- **`--base` support for build** (SPEC-M2 §4a says base-aware; v1 is root-hosted only -
  fine for `marver serve`, Railway, and CF Pages). Root-absolute URLs live in the
  generated pages, `frameUrl`, and the favicon links.
- **Serve gate: attempt throttling beyond the scrypt cost** (per-IP backoff) if published
  canvases ever face real brute-force pressure.
- **`--boards` and the host `public/` directory**: the filter covers frames only; public
  assets ship in full (build prints a note). Revisit if a real leak case appears.
- **Sidebar labels keep kebab dashes - humanize them (dogfooding, 2026-08-14).** Board/scene
  names derive from kebab filenames via `cap()` (store.ts:40, rendered at App.tsx:26), which
  only upper-cases the first letter and KEEPS the hyphens: `tms-high-level` -> "Tms-high-level",
  `tms-specs` -> "Tms-specs". Nic had to hand-teach the agent not to leave dashes between
  words. Note the variant-group label path already de-hyphenates (`App.tsx:757` does
  `.replace(/-/g,' ')`) - boards/scenes just never got the same treatment. Fix: replace `cap()`
  in the nav-label path with a `humanize()` - `.replace(/-/g,' ')` + **Title Case** each word
  (the sidebar convention: Figma pages, Linear, Notion). Keep honoring a frame's explicit
  `meta.title` verbatim (authored sentence case like "The platform at a glance" - untouched).
  One caveat humanize can't solve: acronyms - "tms" renders "Tms", not "TMS". Real fix =
  an explicit display-title override for boards (board `.json` `title`) and scenes (folder
  meta), same escape hatch content frames already have via `meta.title`; a small acronym
  allowlist is the brittle alternative. Ship humanize now (drops the dashes, zero author
  effort); title-override as the follow-up for acronyms.
- **Copy-path shortcut: mislabeled `C`, rebind to `Shift+P` (dogfooding, 2026-08-14).** The
  toolbar "Copy file path" tooltip advertises `C` (App.tsx:203, `<span className="k">C</span>`)
  but that hint is stale - it was never updated when copy moved `c`->`y` in 0.4.0. The real
  handler is `y` ("yank", App.tsx:620); `c` is comment mode (App.tsx:613). So nothing is
  actually double-bound, but the UI CLAIMS copy=C and comment=C, which reads as a collision,
  and `y` is invisible/unintuitive (vim jargon, and the visible hint lies). Fix, two parts:
  (1) correct the tooltip regardless; (2) rebind copy-path to **`Shift+P`** - mnemonic (bare
  `p` = play/prototype is taken, so `Shift+P` = "copy **P**ath"), fits the existing Shift =
  secondary-action tier (`Shift+C` hide pins, `Shift+0/1/2` zoom), zero collision. Nic also
  floated `X` (free, easy reach, but cut/delete connotation - weaker mnemonic); recommended
  `Shift+P`. Nic to confirm the key before wiring; then update handler + tooltip + AGENTS +
  changelog. Small, self-contained.
- **Concurrent user-interaction + agent-edit resilience - the priority UX-damage theme
  (dogfooding marver-site, 2026-08-14).** The user is IN the canvas (lasering, commenting,
  scrolling, preparing the next request) WHILE the agent edits frame files in parallel, and
  the churn breaks things: whole-frame crashes, and laser/comment mode stop working and don't
  come back. Two distinct problems under one theme:
    1. **Mid-edit HMR crashes are transient half-written modules.** Confirmed live: play mode
       carded "frame crashed / FolderTree is not defined" on `landing/keynote-v2` while the
       agent was mid-edit. `FolderTree` is a valid `lucide-react` export and the on-disk file
       is correct (import line 4, used line 429) - so Vite HMR applied an INTERMEDIATE save
       where the symbol was used before its import landed (or mid-rename). Inherent to live
       editing, BUT the error card is dead: it only clears on a manual `reload`, not on the
       agent's NEXT save that fixes it. FIX: the stage/frame-host ErrorBoundary should
       auto-clear and re-render on the next HMR module update for that frame (Boundary resets
       on resetKey today; also reset on `import.meta.hot` update), so a transient bad save
       heals itself the instant the agent saves again - no user action.
    2. **Shell-owned modes die on frame churn and don't re-arm (the real damage).** Laser and
       comment mode "stop working" after a frame crashes/HMR-reloads. FrameNode already
       re-sends `sh:laser`/`sh:pick` when a frame becomes `ready` (line ~41), but a CRASHED
       frame goes to `status:'error'` and never returns to `ready`, so it drops out of the
       lasered/comment set permanently; and reports say the mode breaks BOARD-WIDE, not just
       on the crashed frame - suggesting one frame's error also throws in the shell's
       laser/comment overlay path and kills the whole mode. FIX: (a) shell-owned interaction
       state (laser, comment, scroll, zoom) must survive ANY frame lifecycle event and
       re-attach after crash-recover/HMR/reload; (b) one frame erroring must NEVER break the
       board-level mode - isolate the overlay per frame so a dead frame is skipped, not fatal.
  Needs a codex adversarial pass on the frame-lifecycle × mode-state matrix (like the Play
  chrome item): {loading, ready, error, HMR-updating, reloading} × {laser on/off, comment
  on/off} × user mid-gesture. Connects to the cold-boot item below and the multiplayer
  concern - unifying principle: **frame churn must never damage shell-owned state or leave a
  dead frame; always recover in-place.** High priority - Nic flags this as the thing that
  most hurts the live dogfood experience.
- **Content frames time out to a dead error card, and recovery loses the user's place
  (dogfooding hertz-transpo, 2026-08-14 - bugs "a fair bit," priority).** On a fresh
  `marver dev` (empty `node_modules/.vite`, e.g. right after `npm i` to a new version) - and
  intermittently after, whenever Vite re-optimizes mid-session - content frames show "frame
  failed / frame never reported ready (10s)" and just sit there; the only recovery is the
  per-frame `reload` button or a full-page refresh, and a page refresh throws away the
  user's scroll/zoom/pan and canvas work. Mechanism: `content/index.tsx` STATICALLY
  re-exports `Diagram` from `diagram.tsx`, so every content frame - diagram or not - pulls
  the mermaid (209KB) + marked (162KB) chain. marver force-adds those to
  `optimizeDeps.include`, but Vite pre-bundles them async at boot without blocking. If a
  frame iframe's `import()` of the content chain lands mid-optimize, Vite holds the request;
  on a cold machine the optimize runs >10s, so the import neither resolves (no `sh:ready`)
  nor throws (no `sh:error`) and the shell's 10s watchdog fires on ALL frames. Distinct from
  the line-~55 mid-session-new-import 504 item but the fix converges. **Requirement (Nic):
  recover silently in the background, never a full-page refresh - the canvas must keep the
  user's scroll/zoom/pan/work.** The mechanism is already isolated: the shell owns
  scroll/zoom, each frame is a child iframe, and the error card's `reload` button just does
  `iframe.src = frameUrl(...)` (FrameNode.tsx:206) WITHOUT touching the shell - so doing that
  automatically inherently preserves canvas state. Fix: (a) on ready-timeout, auto-reload the
  iframe once (maybe with a brief backoff, 1-2 tries) before ever showing the error card -
  smallest change, masks any transient boot/optimize race in place; (b) also await the dep
  optimizer at `marver dev` boot before printing "canvas ready" to remove the race at source
  (costs a few cold-boot seconds). Do (a) regardless - it's the "hot reload in the background"
  behavior Nic wants. Verified the frames render clean once warm.
- **Make rich diagram/doc authoring EASY - the agent struggles to hand-roll it
  (dogfooding hertz-transpo, 2026-08-14; Nic's biggest content-frame ask so far).** The
  agent CAN produce beautiful content frames (the "platform at a glance" board is genuinely
  good) but only with heavy hand-holding from Nic, because two common patterns have no easy
  primitive and force fragile hacks:
    1. **Node with a bold title + muted subtitle.** To get "**Corporate HQ**" on top and
       "control tower" muted below, the agent resorted to inline HTML inside the mermaid
       label: `HQ["<div><b>Corporate HQ</b></div><div style='opacity:0.65'>control tower
       </div>"]` - fragile (see the `<br/>` parse-error item), hard to teach, easy to break.
       FIX: a tiny preprocess in `diagram.tsx` `cleanSource()` (the pass already runs before
       `mermaid.render`) - a plain delimiter convention like `HQ["Corporate HQ · control
       tower"]` or `title :: subtitle` auto-renders title bold on top, remainder muted below,
       via a marver-controlled span/class styled in the injected `THEME_CSS` (mermaid
       markdown-string + `<br/>` under the hood). Agent writes plain text; marver does the
       two-tier styling. No HTML, no opacity hacks.
    2. **Family colors.** Today the agent hand-writes `classDef shipper fill:#… stroke:#…
       color:#…` per family and gets it inconsistent/off-brand. `palette.ts` ALREADY holds
       every family (Apple system series + gray ramp + blue/purple accents, light+dark).
       FIX: pre-define named family classDefs in the injected mermaid theme (shipper=blue,
       carrier=orange, driver=purple, platform=gray, mover=green …) so the agent just tags
       `HQ:::shipper` (mermaid's native `:::` shorthand) - zero boilerplate, guaranteed
       on-brand and dark-safe. SAME named families as the `Md` `:blue[…]` highlight item
       above: one palette drives prose highlights AND diagram fills, so copy and the diagram
       beside it read as one color language (exactly Nic's "highlight the shipper's world,
       carrier market, driver pool, platform with the right colors so it's easy to link").
    3. **Full-width / rich Md documents.** Nic wants a full-width `Md` region below a diagram
       to build genuinely rich docs (prose + images + mermaid + more) with real layout
       flexibility. Confirm what `Doc layout="wide"` / `Row`/`Col` already give, and add
       what's missing for full-bleed Md at a comfortable measure so a "platform at a glance"
       page can carry a long rich body under the diagram.
    4. **Teach the agent to do this unprompted (doctrine).** The point of 1-3 is that the
       agent does it ITSELF without Nic hand-editing. Add/expand a content-frame + diagram
       authoring reference in `instructions/` (and route it from AGENTS + `craft.md`):
       family-color discipline, the title/subtitle node convention, when to go full-width,
       how to compose prose/image/diagram into one rich document. Ground truth to encode:
       the good version Nic converged on (bold family word top, muted example below,
       consistent family colors, scannable two-column body).
  Through-line: ONE named palette (`palette.ts`) everywhere, and marver primitives absorb the
  fiddly CSS/HTML so the agent expresses semantic intent, not styling hacks. Small, seam
  already exists (`cleanSource` + injected `THEME_CSS`); high leverage for how good boards look.
- **Colored / highlighted inline text in `Md` (requested dogfooding hertz-transpo,
  2026-08-14).** Nic wants to color inline prose to match a board's color guidelines - e.g.
  "**blue** is the shipper's world, **orange** is the carrier market, **gray** is the
  platform" where those words actually render in-family, so the copy and the diagram beside
  it read as one color language. Today `md.ts` (marked, custom renderer) makes raw HTML
  inert by construction, so `<span style>` is a non-starter - correct default. Fix: add a
  `marked` INLINE extension emitting our own controlled, theme-aware class (never user CSS),
  mapped to the SAME named families the diagrams use (`content/palette.ts` - blue/orange/
  gray/green/etc.), so one palette drives both. Syntax candidates: `:blue[text]` /
  `:carrier[text]` directive style (semantic names preferred over hex - stays on-brand and
  dark-mode-safe), plus optionally `==text==` -> `<mark>` for a plain highlighter. Keep it
  to the guideline palette, not arbitrary color, so boards can't drift off-brand. Small,
  self-contained; document the syntax in `instructions/reference/color.md` + typography.
- **Mermaid labels reject `<br/>`** (found dogfooding the M3 board, 2026-08-13): a
  quoted node label containing `<br/>` renders an in-frame parse-error card ("Opening
  and ending tag mismatch: br and p") - the sanitizer/htmlLabels path chokes on the
  void tag. Either support it (mermaid renders `<br/>` natively when htmlLabels is on)
  or strip it with a clear warning; today's failure mode is a red error box.

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
  (merge with the `marver smoke` bullet); also flag self-referential CSS custom
  properties in the theme (`--font-sans: var(--font-sans)` - the shadcn-init scaffold
  bug that silently drops the app to the browser default font, 2/2 cold starts); (2) frames that 500 look identical to healthy
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
- **Recipe edits don't re-tidy materialized boards.** An agent changing a board's
  `layout` in the file sees no effect until positions are stripped or a human
  gesture retriggers tidy (hit on routines-story, 2026-08-13 - had to delete x/y
  by hand). Candidate fix: store a recipe hash in the board file; loadBoardState
  retidies when the recipe changed since materialization.
