# DECISIONS

Deviations and judgment calls the spec allows, newest first. One line each, with why.

- 2026-08-10 · The host's `vite.config.*` is never loaded; our instance is fully self-contained (spec §3, recorded here as required).
- 2026-08-10 · `optimizeDeps.include` gets `react`, `react-dom`, `react/jsx-runtime`, `react-dom/client`, `zustand`, `react-zoom-pan-pinch` - the shell/frame-host are excluded source, so their deps would otherwise be discovered late and trigger reload churn. Complements the spec's `exclude`/`entries` rules.
- 2026-08-10 · Top-level `esbuild: { jsx: 'automatic' }` in the dev config so package client TSX compiles even where plugin-react's include misses node_modules paths (plugin-react still owns Fast Refresh for `design/**`).
- 2026-08-10 · Reserved-scene-name collision (`components`/`screens`) soft-fails: the scene is skipped with a loud console error instead of killing the dev server. A dead server helps nobody mid-session.
- 2026-08-10 · Entry HTML uses an `{{ENTRY}}` placeholder replaced by the routes middleware with an `/@fs/` absolute path - relative `./main.tsx` would resolve against the URL, not the package dir.
- 2026-08-10 · **Measured during M0:** our own manifest/board JSON writes made Vite full-reload every client (out-of-graph file change). Fix: `server.watch.ignored` for manifest.json, boards/, .local/, .dist/ - spec §5.6 said it; the build proved it.
- 2026-08-10 · Globs live in `frame-host/registry.ts` (JSX-free) - it is the HMR boundary. plugin-react force-invalidates modules it deems Refresh-incompatible, which killed a self-accept in main.tsx and escalated to full reloads.
- 2026-08-10 · react/react-dom removed from devDependencies - a second copy under the package's node_modules shadows dedupe when running from a linked checkout and produces the invalid-hook crash. Types-only deps remain.
- 2026-08-10 · rzpp gesture events are onPanningStart/Stop + onZoomStart/Stop (no onTransformStart/Stop in v3.7); ref type is ReactZoomPanPinchContentRef.
