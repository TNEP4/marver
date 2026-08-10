# Marver

The agent-native design canvas. A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

```bash
pnpm add -D @marver/design
npx marver init   # scaffolds design/ (detects shadcn, Tailwind, your router)
npx marver dev    # canvas at localhost:5199
```

Then, to your agent:

> Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components.

- **Frames** are plain TSX/HTML files - zero imports from this package required.
- **Everything hot-reloads**; frames appear on the canvas the moment the file lands.
- Drag a frame's edge and the real breakpoints fire - each frame is a true iframe viewport.
- **Boards**: one canvas on screen at a time. Agents write `design/boards/<name>.json` (a frame list is enough); switch boards at the top of the sidebar. `everything` is auto-managed.
- **Devices view**: the Devices menu (or hotkeys `1`-`5`) sizes every frame to mobile / tablet / laptop / monitor / tv to sweep your breakpoints; `0` restores your own layout exactly. Widths live in `design/config.ts`.
- `data-goto="scene/frame"` on any element links frames into a walkable prototype.
- Uninstall: delete `design/`, remove the dependency. (If `init` patched your tsconfig `exclude`, revert that one line.)

The implementation contract is [SPEC.md](./SPEC.md). Deviations live in [DECISIONS.md](./DECISIONS.md).

Working name; private; TNEP4.

## Shortcuts

**Canvas** - two-finger scroll pans · pinch or ctrl/cmd+scroll zooms · space+drag pans from anywhere · click empty canvas deselects / exits interact.

**Zoom** - `⇧0` 100% · `⇧1` fit all · `⇧2` fit selection · click the % readout for presets (200-10%).

**Device views** - plain digits, auto-tidy + refit every time. Scoped to the selection when frames are selected, board-wide otherwise.
`0` default sizes (restores your free-form layout) · `1` mobile · `2` tablet · `3` laptop · `4` monitor · `5` tv (when enabled in design/config.ts).

**Board & chrome** - `t` tidy · `d` toggle light/dark for the board · `⌘\` (ctrl+\) collapse/open sidebar.

**Selection** - click selects · shift+click (canvas or sidebar) builds a multi-selection · double-click enters interact mode (`esc` or click outside leaves) · drag the title bar to move, edges to resize (widths snap to devices).
