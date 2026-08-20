# Marver

[![npm](https://img.shields.io/npm/v/%40marver-design%2Fmarver?color=2f6fed&label=npm)](https://www.npmjs.com/package/@marver-design/marver)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](package.json)

**The agent-native design canvas.** A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

[marver.design](https://marver.design) · [Deploying a canvas](docs/publish.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/TNEP4/marver/issues)

## Quickstart

```bash
npm i -D @marver-design/marver
npx marver init   # scaffolds design/ (detects shadcn, Tailwind, your router)
npx marver dev    # canvas at localhost:5199 (npx marver canvas works too - same thing)
```

Then, to your agent:

> Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components.

Frames appear on the canvas the moment the files land. That's the loop.

## Why marver

- **Frames are real code.** Plain TSX/HTML files rendered from your repo's actual components and theme - zero imports from this package required. An approved design promotes into the app by moving a file, not by re-implementing a picture.
- **Everything hot-reloads.** The agent writes, you watch it land - live.
- **True viewports.** Each frame is a real iframe: drag its edge and your actual breakpoints fire.
- **No AI inside.** The designer is the coding agent you already run and pay for. `init` generates the `design/AGENTS.md` contract that teaches it the whole workflow.

## The canvas

- **Frames, scenes, boards.** Frames are screens, scenes group them (`design/scenes/<scene>/<frame>.tsx`), boards arrange them. Agents write `design/boards/<name>.json` (a frame list is enough); switch boards at the top of the sidebar. `all-scenes` is auto-managed.
- **Devices view.** Hotkeys `1`-`5` (or the Devices menu) size every frame to mobile / tablet / laptop / monitor / tv to sweep your breakpoints; `0` restores your own layout exactly. Widths live in `design/config.ts`.
- **Prototype links.** `data-goto="scene/frame"` on any element links frames into a walkable prototype - across boards, too.
- **Play mode.** Press `p`: the board becomes a full-screen, clickable walkthrough. `data-goto` links navigate, arrow keys step between frames, `[` / `]` cycle variants, `Escape` exits. Publish it and you have a shareable prototype.
- **Content frames.** Specs, Mermaid diagrams, and mood boards live on the same canvas as the screens - import `Doc`, `Md`, `Diagram`, `Img` from `@marver-design/marver/content` and think a feature through before any pixels exist. Works in a repo with no app at all: idea first, design second.

## Collaboration

- **Comments.** Google-Docs-style feedback pinned to actual elements. Press `c`, click a div inside a frame, write - the thread lives on that element and survives edits via a layered anchor (source semantics → structure → fuzzy text). Viewers on a published canvas comment with real names and avatars (invite-link accounts, no email infrastructure). `marver dev` syncs the same threads into `design/comments/*.jsonl`, where your agent works the queue: `npx marver comments list --open --json` → fork a variant → `resolve --addressed-in`. Live via SSE; one deploy, no extra services.
- **Laser mode.** Press `l`: every element in every frame gets depth-hued outlines plus a hover label - the fastest way to see structure. Click any element to copy its full address (frame file + CSS path) for the agent.
- **Publishing.** `npx marver build` exports a static canvas (default-closed: `design/publish.json` names what ships); `npx marver serve` hosts it with an optional password gate. One deploy on Railway, Docker, or any static host - the [publishing guide](docs/publish.md) has the one-pagers.

## Live Jam

Tag `@marver` in a comment and your own coding agent picks it up - reads the thread, edits the real frame source, replies with a receipt - while the frame wears a live working glow. Opt in with `jam: { agent: "claude" }` (or `"codex"`) in `design/config.ts`.

The trust boundary is hard: only comments written on the owner's machine trigger (a device-bound ledger - a drive-by comment on a published canvas cannot start work), the agent runs locked down (Claude Code with shell disabled entirely; Codex confined to its workspace-write sandbox), and every reply carries provenance: agent, model, dev user. Marver ships no AI; the agent that acts is the one you already run.

## Working state

The same glow, driven from the terminal. When your agent takes a request, it creates the frame files first, pins them on a board, and runs `npx marver work start <scene/frame ...>` - you see the work land on the canvas in seconds, watch it shimmer while subagents build in parallel, and see it settle on `work done`. Marks self-expire, so a crashed agent never leaves a frame glowing.

## Commands

| Command | What it does |
|---|---|
| `npx marver init` | Scaffold `design/` in this repo (safe to re-run; refreshes managed files) |
| `npx marver dev` / `canvas` | Start the local canvas - hot reload, comments, Live Jam (`--port`, default 5199) |
| `npx marver build` | Static export → `design/.dist`; what ships comes from `design/publish.json` (default-closed) |
| `npx marver serve` | Serve the export; `MARVER_PASSWORD` gates it, `MARVER_DATA_DIR` persists comments + accounts |
| `npx marver comments …` | The agent's queue: `connect <url>` · `sync` · `list` · `reply` · `resolve` · `invite <email>` · `revoke <email>` |
| `npx marver work …` | Working glow from the terminal: `start <scene/frame …>` · `done … \| --all` · `list` |

## Shortcuts

**Canvas** - two-finger scroll pans · pinch or ctrl/cmd+scroll zooms · space+drag pans from anywhere · click empty canvas deselects / exits interact.

**Zoom** - `⇧0` 100% · `⇧1` fit all · `⇧2` fit selection · click the % readout for presets (200-10%).

**Device views** - plain digits, auto-tidy + refit every time. Scoped to the selection when frames are selected, board-wide otherwise.
`0` default sizes (restores your free-form layout) · `1` mobile · `2` tablet · `3` laptop · `4` monitor · `5` tv (when enabled in design/config.ts).

**Board & chrome** - `t` tidy · `d` toggle light/dark for the board · `⌘\` (ctrl+\) collapse/open sidebar.

**Selection** - click selects · shift+click (canvas or sidebar) builds a multi-selection · `⌘A` selects every frame on the board · `⇧P` copies the selected frames' file paths · double-click enters interact mode (`esc` or click outside leaves) · drag the title bar to move, edges to resize (widths snap to devices).

**Modes** - `c` comment mode · `l` laser mode · `⇧C` hide/show comment pins · `⇧L` laser comment (spotlight a thread's element) · `p` play mode · `h` hide all chrome.

## Notes

- **Next.js**: supported with one caveat - frames render in Vite, outside Next. `next/font` CSS variables are undefined inside frames (give font tokens a fallback chain), `next/image`/`next/link` should be plain `img`/`data-goto` in frames, and Server Components cannot run there. `init` writes the specifics into `design/AGENTS.md` when it detects Next.
- **Upgrade**: `npm i -D @marver-design/marver@latest && npx marver init`. The canvas tells you when a new version is out (one anonymous registry check per day, cached in `design/.local/`; `MARVER_NO_UPDATE_CHECK=1` disables). Re-running init refreshes the managed files (AGENTS.md, `design/instructions/`) - your edits to them are detected and preserved; when both you and a release changed a file, the fresh version is staged at `design/.local/latest/` for you (or your agent) to merge. Everything else in `design/` is yours and never touched.
- **Uninstall**: delete `design/`, remove the dependency. (If `init` patched your tsconfig `exclude`, revert that one line.)

## Status

Marver is a young solo side project - it works, it's dogfooded daily, and it has rough edges. The known weak spot: boards with many heavy frames (animation-rich, component-dense) can strain the canvas, especially while zooming - snapshot-based rendering helps but isn't finished. If you hit a wall, an issue with your board shape and frame count genuinely helps.

## Contributing

Bug reports, ideas, and PRs are welcome - start with [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [private vulnerability reporting](SECURITY.md), not public issues. Agents running marver are taught to file what they hit as issues here, too - expect some robot reporters.

## License

[Apache-2.0](LICENSE) · built by [Nic Touron](https://github.com/TNEP4)
