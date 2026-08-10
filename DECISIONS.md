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
