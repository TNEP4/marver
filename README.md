# Marver

The agent-native design canvas. A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

```bash
npm i -D @marver-design/marver
npx marver init   # scaffolds design/ (detects shadcn, Tailwind, your router)
npx marver dev    # canvas at localhost:5199
```

Then, to your agent:

> Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components.

- **Frames** are plain TSX/HTML files - zero imports from this package required.
- **Everything hot-reloads**; frames appear on the canvas the moment the file lands.
- Drag a frame's edge and the real breakpoints fire - each frame is a true iframe viewport.
- **Boards**: one canvas on screen at a time. Agents write `design/boards/<name>.json` (a frame list is enough); switch boards at the top of the sidebar. `all-scenes` is auto-managed.
- **Devices view**: the Devices menu (or hotkeys `1`-`5`) sizes every frame to mobile / tablet / laptop / monitor / tv to sweep your breakpoints; `0` restores your own layout exactly. Widths live in `design/config.ts`.
- `data-goto="scene/frame"` on any element links frames into a walkable prototype.
- **Content frames**: specs, Mermaid diagrams, and mood boards live on the same canvas as the screens - import `Doc`, `Md`, `Diagram`, `Img` from `@marver-design/marver/content` and think a feature through *before* any pixels exist. Diagrams ship pre-themed (both modes), content frames auto-size to their content, and everything - devices, play mode, publish - works on them identically. Works in a repo with no app at all: idea first, design second.
- **Comments**: Google-Docs-style feedback, pinned to actual elements. Press `C`, click a div inside a frame, write - the thread lives on that element, survives edits via a layered anchor (source semantics → structure → fuzzy text), and collapses to an avatar stack when the frame isn't active. Viewers on a published canvas comment with real names and avatars (invite-link accounts, no email infrastructure); `marver dev` syncs the same threads into `design/comments/*.jsonl`, where your agent works the queue: `npx marver comments list --open --json` → fork a variant → `resolve --addressed-in`. Live via SSE; one deploy, no extra services (set `MARVER_DATA_DIR` on a volume + `MARVER_OWNER_EMAIL` for the first account).
- **Laser mode**: `L` outlines every element in every frame with depth-hued borders plus a hover label - the fastest way to see structure. Click any element to copy its full address (frame file + CSS path) for the agent. Comment mode is the calm cousin - one at a time with laser - showing only the hovered element so picking a comment target never overwhelms.
- **Upgrade**: `npm i -D @marver-design/marver@latest && npx marver init`. The canvas tells you when a new version is out (one anonymous registry check per day, cached in `design/.local/`; `MARVER_NO_UPDATE_CHECK=1` disables). Re-running init refreshes the managed files (AGENTS.md, `design/instructions/`) - your edits to them are detected and preserved; when both you and a release changed a file, the fresh version is staged at `design/.local/latest/` for you (or your agent) to merge. Everything else in `design/` is yours and never touched.
- Uninstall: delete `design/`, remove the dependency. (If `init` patched your tsconfig `exclude`, revert that one line.)

**Next.js**: supported with one caveat - frames render in Vite, outside Next. `next/font` CSS variables are undefined inside frames (give font tokens a fallback chain), `next/image`/`next/link` should be plain `img`/`data-goto` in frames, and Server Components cannot run there. `init` writes the specifics into `design/AGENTS.md` when it detects Next.

Implementation contracts (SPEC.md, DECISIONS.md) live in the [GitHub repo](https://github.com/TNEP4/marver).

## Shortcuts

**Canvas** - two-finger scroll pans · pinch or ctrl/cmd+scroll zooms · space+drag pans from anywhere · click empty canvas deselects / exits interact.

**Zoom** - `⇧0` 100% · `⇧1` fit all · `⇧2` fit selection · click the % readout for presets (200-10%).

**Device views** - plain digits, auto-tidy + refit every time. Scoped to the selection when frames are selected, board-wide otherwise.
`0` default sizes (restores your free-form layout) · `1` mobile · `2` tablet · `3` laptop · `4` monitor · `5` tv (when enabled in design/config.ts).

**Board & chrome** - `t` tidy · `d` toggle light/dark for the board · `⌘\` (ctrl+\) collapse/open sidebar.

**Selection** - click selects · shift+click (canvas or sidebar) builds a multi-selection · `⌘A` selects every frame on the board · `c` copies the selected frames' file paths · double-click enters interact mode (`esc` or click outside leaves) · drag the title bar to move, edges to resize (widths snap to devices).
