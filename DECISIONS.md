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
