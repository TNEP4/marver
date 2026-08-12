# DECISIONS

Deviations and judgment calls the spec allows, newest first. One line each, with why.

- 2026-08-10 · The host's `vite.config.*` is never loaded; our instance is fully self-contained (spec §3, recorded here as required).
- 2026-08-10 · `optimizeDeps.include` covers the react family only; zustand/rzpp resolve fine from the package's own node_modules and pre-including them from the host root fails (warning noise). Revised during M0.
- 2026-08-10 · No top-level jsx option needed: Vite 8's oxc transforms package-client TSX (including from node_modules); plugin-react owns Fast Refresh for `design/**`. (An earlier esbuild option was ignored by Vite 8 and removed.)
- 2026-08-10 · Reserved-scene-name collision (`components`/`screens`) soft-fails: the scene is skipped with a loud console error instead of killing the dev server. A dead server helps nobody mid-session.
- 2026-08-10 · Entry HTML uses an `{{ENTRY}}` placeholder replaced by the routes middleware with an `/@fs/` absolute path - relative `./main.tsx` would resolve against the URL, not the package dir.
- 2026-08-10 · **Measured during M0:** our own manifest/board JSON writes made Vite full-reload every client (out-of-graph file change). Fix: `server.watch.ignored` for manifest.json, boards/, .local/, .dist/ - spec §5.6 said it; the build proved it.
- 2026-08-10 · Globs live in `frame-host/registry.ts` (JSX-free) - it is the HMR boundary. plugin-react force-invalidates modules it deems Refresh-incompatible, which killed a self-accept in main.tsx and escalated to full reloads.
- 2026-08-10 · react/react-dom removed from devDependencies - a second copy under the package's node_modules shadows dedupe when running from a linked checkout and produces the invalid-hook crash. Types-only deps remain.
- 2026-08-10 · rzpp gesture events are onPanningStart/Stop + onZoomStart/Stop (no onTransformStart/Stop in v3.7); ref type is ReactZoomPanPinchContentRef.
- 2026-08-10 · Post-Codex-review: client constants live in `src/client/const.ts` (packed `files` never included `src/cli` - the shell could not resolve in real installs; smoke now loads the full module graph from the tarball). Bridge html-mode via `?html=1` on its own URL (no globals racing module order). Missing nodes persist through save/boot; removal is the explicit button. `--mode` stays flag-only (no interactive prompt) - recorded deviation. `sh:dblclick` dropped from the bridge until focus mode (M1) consumes it.

## M1-UX: the interaction model pass (2026-08-10)

**The both-move drag bug.** React `stopPropagation` cannot stop react-zoom-pan-pinch:
rzpp binds native listeners on its wrapper, which sits BELOW React's delegation root in
the bubble path, so rzpp starts panning before any React handler runs. Fix is layered:
`panning.excluded` classes (`sh-no-pan`) on every interactive element - rzpp checks only
the event TARGET's classList, so buttons need `button svg { pointer-events: none }` to
keep targets on the button - plus a store `gesture` flag that hard-disables panning for
the duration of a frame drag (covers any target the classes miss).

**Scroll-pan was dead code.** rzpp's `onWheelPanning` early-returns unless
`wheel.wheelDisabled === true`; our old config left wheel zoom enabled, so
`wheelPanning: true` did nothing. Now: `wheelDisabled: true` frees plain scroll for
two-axis panning while ctrlKey wheels (trackpad pinch) still zoom. cmd+scroll on mac
arrives as metaKey, not ctrlKey - a capture-phase listener rewrites it before rzpp sees it.

**Fit replaces zoomToElement.** rzpp's `zoomToElement` fills the viewport edge-to-edge,
hiding the context bar. Custom fit computes scale/position from store coordinates with
asymmetric padding (116 top for the context bar, 72 bottom, 96 sides), capped at 100%.

**Icons are inline SVG, not a package.** The shell ships as source into unknown hosts;
an icon dependency would have to resolve through whatever package-manager layout the host
uses (pnpm does not hoist, npm does). Eleven lucide-style icons in icons.tsx cost less
than that risk. Same reason the shell stays vanilla CSS instead of Tailwind: the shell
must render identically in Tailwind-less hosts, and shadcn look is a palette, not a dep.

**Space-pan.** Hold space = grab cursor + nodes drop pointer-events, so the drag lands on
the canvas. Matches Figma; also the escape hatch when a frame covers the whole viewport.

## Theme-aware shell (2026-08-10, same day round 3)

The shell follows the board, not the OS: when a majority of frames are dark, the whole
chrome flips - dark canvas, dark glass, dark frame cards. Tokens live on `.sh-app` with a
`.dark` override class, so both palettes are one CSS file and the flip is a single class.
Light glass = white translucency over the paper canvas; the earlier always-dark chrome
only made sense on dark boards. Frame header strips joined the glass language
(translucent + backdrop blur) in both themes. `spawn()` now toasts - the + shortcut was
silent while agent-added frames toasted, which read as breakage.

## Rename: showhome -> Marver (2026-08-10)

Brand is Marver (marver.dev + marver.design owned). Package name, bin, plugin name,
log prefixes, and the internal route prefix (/__sh -> /__mv) all renamed; sh- CSS class
prefixes and sh:* postMessage types stay (internal, zero user surface, huge diff for no
gain). KNOWN: bare `marver` is squatted on npm (marver@1.0.0) - registry publishing will
need a scope (@marver/marver) or a variant; git/tarball installs are unaffected.

## M2a: play mode + deep links (2026-08-11)

**Stage owns navigation; the shell owns chrome and the URL.** The stage (one iframe,
`/__mv/stage/`) handles data-goto in place and walks arrow-order internally; the shell's
overlay handles device sizing, theme, exit, and history. New sh:stage-* message family -
the sh:go path stays canvas-only, so nothing about design mode changed.

**Play is tsx-only.** HTML frames are separate documents and cannot mount into the
persistent providers+layout chain; the walk list filters them out. A data-goto to an html
frame shows the stage's unknown-frame card. Documented limit, not a bug.

**Wrapper identity is module identity.** Vite caches dynamic imports, so re-resolving a
chain yields the same component references and React keeps layout instances mounted
across swaps - persistence comes free, no memo machinery needed.

**Selection deep links on an unmaterialized all-scenes board are per-session.** Node keys
are minted at load until first edit materializes the board. Curated boards (the sharing
unit) have stable keys. Recorded, not fixed - materialize to share.

## Codex review of M2a (2026-08-11)

8 findings, 7 fixed: cross-board popstate now re-applies the WHOLE hash after the switch
(a stale play overlay from board A could corrupt board B's URL); off-board play links
validate against the manifest, not the board list; `#/p/<board>` alone enters at board
start; the stage swap seq is rechecked inside the startViewTransition callback; the
ready handshake resends current at+theme so registry-HMR iframe reloads resync; play
chrome wakes on pointer events and never idles on coarse pointers; malformed hashes
parse to the default view instead of throwing at module init. DECLINED: promoting stage
async errors from toast to error card - render errors already get the Boundary card, and
killing a live demo over a stray rejection is worse than a toast. Judgment call, recorded.

## Play chrome ladder (2026-08-11)

Chrome states mirror the sidebar's panel/fab ladder: open / collapsed (chip) / hidden
(immersive). `C` collapses, `H` hides everything, corners reveal. The reported
hide-under-cursor bug: the reveal corners are narrower than the bar, so crossing
x = innerWidth-220 hid it mid-hover - fixed by `over` state (pointer on any chrome piece
always keeps it shown). The H coach bubble is the first localStorage use in the shell
(`mv-play-hint-off`); until dismissed forever, hidden-mode corners surface the bubble
(teaching H) rather than the chrome - after dismissal they reveal the chrome directly.
The design pill gained the same collapse/expand pair (.sh-pill-fab).

## Hidden mode is absolute (2026-08-11, closing the corner-reveal saga)

The corner-hover reveal is DELETED. Its two pointer sources (shell pointermove, stage
sh:stage-edge) are mutually blind - each goes stale the moment the pointer crosses into
the other's territory, and it stuck in both directions (windowed: bar wider than the
zone; fill: crossing the frame corner en route to the toolbar). H now hides everything,
period; the coach pill on entering hidden is the recovery path (OK = 15-min snooze via
mv-play-hint-snooze, "Don't show again" = mv-play-hint-off); a fresh session always
opens with controls visible. ⌘/ collapse is unrelated and untouched.

## M2b: publish + sync, codex-reviewed (2026-08-11)

Build generates its pages from the vite output instead of using html entries (the html
templates live outside the host root, which vite html inputs cannot express) - dev's
routes middleware has no static twin to keep in sync. The --boards privacy boundary is
two-layered: filtered manifest in virtual:sh-data AND a generated registry whose only
imports are published frames. Codex review (11 findings, 9 fixed): gated responses are
private/no-store (CDN cache leak); path containment is realpath+relative (encoded
separators, symlinks); auth compares scrypt verifiers (fixed length, cost per guess)
and cookies sign with a per-boot random secret (captured cookie ≠ offline material);
empty --boards fails closed (cac yields `true` for a bare flag - CLI normalizes);
published saves clear dirty (switchBoard wedged); filtered builds open on their first
published board (no synthesized all-scenes); boards watcher mkdirs + JSON-validates
before broadcasting. Deferred to BACKLOG: --base, per-IP throttling, public/ filtering.

## Boot-fit race + test pollution (2026-08-11, evening)

Published builds boot from inlined data fast enough that rzpp's async initial-transform
application landed AFTER the boot fit and stomped it back to identity - dev's fetch
latency had always hidden the race. Fix: the vestigial initialPositionX/Y props are gone
(the boot fit owns the first camera) plus a one-shot 150ms verify-refit. Separately: the
dark-and-scattered published all-scenes was DATA, not code - automated test sessions
pressed D and resized on all-scenes, materializing it with dark themes and churned
layout, and it got committed and published. Lesson: automated canvas tests mutate real
board files; reset design/boards/ before committing a pilot.

## Theme model v2: viewTheme + pins (2026-08-11, codex-reviewed)

node.theme is now the RESOLVED value; resolution = themeUser (explicit per-frame pin) >
frame meta.theme (author-declared one-mode frames) > viewTheme (the user's global
preference, localStorage, sticky across boards and reloads). Global toggle sets
viewTheme and clears pins; scoped toggle pins. The chrome follows viewTheme - per-frame
toggles can never flip the whole app. Pins persist as their own `themeUser` board field
(codex: a pin equal to the static default round-tripped to nothing under the legacy
heuristic); legacy `theme` values migrate by differ-from-static-default. applyManifest
re-resolves surviving nodes when meta.theme changes (derived, never dirties). The
earlier "themes switch randomly" reports were part model-surprise, part my stale test
tabs saving against the same board (writer hygiene: park test browsers on the published
site when done).

## Distribution executed (2026-08-11)

@marver-design/marver@0.2.0 is live on the public npm registry (Apache-2.0, LICENSE +
NOTICE in the tarball, homepage marver.design). The bare `marver` name is squatted by a
2015 placeholder, which also blocks the `marver` org - so the org is `marver-design`
under Nic's personal `nictouron` account; a dispute email is drafted (Nic to send,
4-week clock). Trusted-publishing workflow (.github/workflows/release.yml, OIDC,
tag-triggered) is committed but inert until the repo goes public and is registered as a
trusted publisher; until then releases are `npm version` + `npm publish` from Nic's
terminal (passkey 2FA needs a real TTY - harness sessions can't publish). The pilot now
installs from the registry (`^0.2.0`, tarball retired) and the Railway production
deploy was rebuilt from that registry install and verified live - the exact path a
stranger's repo takes.

## Next milestone: dogfood marver.design (decided 2026-08-11)

The website is built in a SEPARATE fresh repo by a SEPARATE Claude session that gets
only what a stranger gets: the README install line and whatever `npx marver init`
scaffolds. No specs, no source knowledge, no help from this session. It keeps a
FRICTION.md of every confusion, doc gap, and workaround (including every time it had to
read package source in node_modules to answer something AGENTS.md should have). That
log flows back to this session and becomes the 0.3.0 backlog. This tests studio mode
end to end (the pilot covers embedded mode) and doubles as the stress test.

## Friction triage shipped as 0.2.1 (2026-08-12, codex-reviewed)

The marver-site dogfood produced a 23-issue FRICTION.md; everything bug-shaped shipped
in 0.2.1, verified end-to-end in a real browser against a fresh Next 16 + Tailwind v4 +
shadcn repro app (the blessed stack). Root causes worth remembering:

- **#20 (stale canvas) was HTTP caching all along.** registry.ts lives in node_modules,
  so Vite stamps `?v=<hash>` and serves it `max-age=31536000,immutable` - correct for
  static package code, poison for a module whose TRANSFORM is dynamic (the glob map
  tracks the host's design/ tree). Restart → same hash → year-old glob map, unfixable
  by hard reload (iframe subresources never revalidate immutable entries). Fix: a
  middleware forces `no-cache` on that one URL; plus rev-stamped frame URLs
  (`&r=<manifestRev>`), `no-store` on marver-served HTML, and an auto-retry (nav nonce)
  for errored frames when a manifest lands.
- **#22 (new frames lose Tailwind classes)**: the scan set is computed when the theme
  CSS compiles; frame add/unlink now synchronously invalidates the theme module chain
  and pushes the recompiled CSS via reloadModule (debounced).
- **detect.ts stripJsonComments ate glob patterns**: `.next/types/**/*.ts` contains
  `/*`, the regex stripper corrupted the whole tsconfig, detection silently saw null -
  so init never patched exclude and `next build` failed typechecking design/. Rewritten
  string-aware (comments AND trailing commas). Detection bugs are silent-degrade bugs.

Spec deviations (spec §7 said tombstones persist until removed): AUTO boards now prune
deleted frames at load and on manifest events, and the prune dirties the board so disk
converges; curated boards keep the explicit deleted card. Board GET returns 200
`{board:null}` for never-materialized boards (404 was red console noise). AGENTS.md is
now a marker-carrying regenerating contract: re-running init rewrites it when detection
changes; deleting the marker line opts out. init refuses nothing but says NO APP
DETECTED loudly and generates a STOP contract when there is nothing to build from.

Codex adversarial review caught 4 real issues pre-commit (prune not persisted, a
rescan/manifest race, init re-run couldn't actually regenerate the contract, trailing
commas inside strings). Accepted trade-offs: transient unlink+add across >150ms loses
an auto-board node's position/pins (auto boards are auto-laid; debounce absorbs editor
atomic saves); registry revalidates per iframe navigation (localhost 304s, correctness
over micro-perf); tsconfig exclude patch can be unnecessary for exotic `**/src/**`
includes (harmless, printed, reversible).

## The Method layer + release train (decided with Nic, 2026-08-12)

The product gap is guidance: unguided coding agents produce confident slop, and the
weaker the model the worse it gets. Marver ships the METHOD, not just the canvas.

- **design/instructions/** (not "guides" - authoritative by name) holds the method:
  discover, wireframe, brand, craft, components, review + setup.md (the no-app
  presence file moves in here). AGENTS.md stays the lean every-session contract and
  MUST-routes agents into the phase instruction before working in that phase. Files
  carry the same regeneration markers as AGENTS.md (init refreshes them on upgrade;
  delete the marker to own a file).
- **Craft rules are STRICT**, distilled from studying public best-in-class design
  references - re-expressed entirely in our own words (methods and ideas, never
  copied text; Nic's call 2026-08-12: these are a prototyping baseline we will
  rewrite through dogfood). Low-fi (wireframe) rules are our own. Lo-fi refinement
  from Nic: throwaway code is CORRECT for wireframes (never build real components
  for them, never touch the app's components dir); existing branded components may
  be composed as-is; lo-fi is for NEW work only. Configure phase added: three repo
  maturities (new / fresh / old) all route to one "idle state" (theme wired,
  components importable, brand documented, manifest honest).
- **Release train reordered**: 0.2.2 = staged infra (update pill, setup presence
  file, collision guard) + the Method layer, so dogfooding the method starts
  immediately. 0.2.3 = grouping/variants/iteration management - agent gets real
  canvas control to diverge/converge (design-thinking loop; creative UI work to do).
  0.2.4 = comments management (SPEC-M3 promotion). Comments moved BEHIND iteration:
  you iterate before you collect feedback.

## 0.2.3 variants: codex round + deviations (2026-08-12)

Codex review of the build: 3 P1s fixed (live-JOIN now places a grouped newcomer
beside its siblings; meta.of cross-directory groups refused with a warning - variants
are local comparisons; inference is tsx-only so no group forms that play cannot
switch). P2s fixed: extractor property-boundary (covariant != variant), no invented
'?' keys, orphan meta.variant swept, sceneRows dedupes twice-listed scenes, captions
count distinct frames not node instances + indexed lookup, play control suppressed on
off-board frames + shows the current variant name, badge letter fades below ~6% zoom
(the pad cannot hold the clamp there). DEVIATIONS from spec/codex kept deliberately:
sidebar scene-level groups label as "Variants" not the group name (repeating the
scene header directly beneath itself is worse); root-level frames (design/scenes/
a-x.tsx) never group (scenes are directories - documented convention).
