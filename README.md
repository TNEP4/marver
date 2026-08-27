# Marver

[![npm](https://img.shields.io/npm/v/%40marver-design%2Fmarver?color=2f6fed&label=npm)](https://www.npmjs.com/package/@marver-design/marver)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](package.json)

**The agent-native design canvas.** A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

[marver.design](https://marver.design) · [Live Jam](docs/live-jam.md) · [Deploying a canvas](docs/publish.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/TNEP4/marver/issues)

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
- **Your agent answers on the canvas.** Tag `@marver` in a comment and it picks up the job, edits the real source, and replies in the thread - no wiring, on by default. See [Live Jam](#live-jam).
- **Feedback without a signup wall.** Publish the canvas, invite people by email, and they sign in as themselves - one free Marver account, Google or an emailed code, and it opens every canvas you ever share with them. Or keep it entirely self-hosted behind a shared password. See [Collaboration](#collaboration).
- **No AI inside.** The designer is the coding agent you already run and pay for. `init` generates the `design/AGENTS.md` contract that teaches it the whole workflow.

## The canvas

- **Frames, scenes, boards.** Frames are screens, scenes group them (`design/scenes/<scene>/<frame>.tsx`), boards arrange them. Agents write `design/boards/<name>.json` (a frame list is enough); switch boards at the top of the sidebar. `all-scenes` is auto-managed. Right-click any board, scene, or frame in the sidebar to copy its path - the exact string to paste to your agent - and rename or drag-reorder boards from there too.
- **Devices view.** Hotkeys `1`-`5` (or the Devices menu) size every frame to mobile / tablet / laptop / monitor / tv to sweep your breakpoints; `0` restores your own layout exactly. Widths live in `design/config.ts`.
- **Prototype links.** `data-goto="scene/frame"` on any element links frames into a walkable prototype - across boards, too.
- **Play mode.** Press `p`: the board becomes a full-screen, clickable walkthrough. `data-goto` links navigate, arrow keys step between frames, `[` / `]` cycle variants, `Escape` exits. Publish it and you have a shareable prototype.
- **Content frames.** Specs, Mermaid diagrams, and mood boards live on the same canvas as the screens - import `Doc`, `Md`, `Diagram`, `Img` from `@marver-design/marver/content` and think a feature through before any pixels exist. Works in a repo with no app at all: idea first, design second.

## Collaboration

- **Comments.** Google-Docs-style feedback pinned to actual elements. Press `c`, click a div inside a frame, write - the thread lives on that element and survives edits via a layered anchor (source semantics → structure → fuzzy text). Viewers on a published canvas comment with real names and avatars - either a Marver account they already have, or an invite-link account on that canvas alone. `marver dev` syncs the same threads into `design/comments/*.jsonl`, where your agent works the queue: `npx marver comments list --open --json` → fork a variant → `resolve --addressed-in`. Live via SSE; one deploy, no extra services.
- **Laser mode.** Press `l`: every element in every frame gets depth-hued outlines plus a hover label - the fastest way to see structure. Click any element to copy its full address (frame file + CSS path) for the agent.
- **Publishing.** `npx marver build` exports a static canvas (default-closed: `design/publish.json` names what ships, and whether each board is `read` or `comment`); `npx marver serve` hosts it. One deploy on Railway, Docker, or any static host - the [publishing guide](docs/publish.md) has the one-pagers.

- **Two ways to let people in.** They are alternatives, not layers - pick one per canvas.

  **Marver Sign In** (new in 0.11). Set `MARVER_ID_ISSUER=https://id.marver.design` and reviewers sign in as themselves, with Google or a six-digit code emailed to them. One free Marver account opens *every* canvas gated this way, so the second board you share costs them nothing: no new signup, no new password, no link to keep. You invite an email address and they are in.

  That is the whole difference, and it is the difference between "I'll look later" and a comment actually landing on the board. It also means their real name and face ride along, so a thread is from a person rather than from an address.

  **A shared password** (`MARVER_PASSWORD`). Fully self-hosted, no account anywhere but your own volume, nothing about your reviewers leaves your infrastructure - and still fully supported, not a legacy path. The trade is that every canvas is an island: reviewers claim an invite link and pick a name and password *on that canvas*, and do it again for the next one. Fine for one board, a toll on the fifth.

  Either way the canvas runs on your infrastructure and stores its own comments and members. With Marver Sign In the identity service only ever tells your canvas that a verified address matched an entry on your invite list - it never sees your frames, your files, or your comments. Rights stay yours: `design/publish.json` decides which boards are readable and which are commentable, and `marver comments invite`/`revoke` decides who is on the list.

  *Coming next:* one home for your account - every canvas you have been invited to, every canvas you have shared, and the access each one carries, in a single list. Today the account page at `id.marver.design` shows the canvases you have approved and lets you revoke them.

## Live Jam

Tag `@marver` in a comment and your own coding agent picks it up - reads the thread, edits the real frame source, replies with a receipt - while the frame wears a live working glow. Nothing to start and nothing to wire: it rides along with `marver dev`, on by default, armed with whichever agent CLI you have - Claude Code, Codex, Cursor, Factory's droid, opencode, grok, or pi, which also covers the apps built on them. The tool running the process wins, then whatever is on PATH, and `init` writes what it found into `design/config.ts` as `jam: { agent: "claude", concurrency: 6 }` - visible, one word to correct, `jam: false` to switch off.

The trust boundary is hard: only comments written on the owner's machine trigger (a device-bound ledger - a drive-by comment on a published canvas cannot start work), the agent runs locked down (each CLI with its shell removed or OS-sandboxed - the per-agent table is in the guide), and every reply carries provenance: which agent ran it, as which dev user, on which model when the agent names one. Marver ships no AI; the agent that acts is the one you already run. The [Live Jam guide](docs/live-jam.md) has the config block, every agent's jail, and what to check when a mention does nothing.

## Working state

The same glow, driven from the terminal. When your agent takes a request, it creates the frame files first, pins them on a board, and runs `npx marver work start <scene/frame ...>` - you see the work land on the canvas in seconds, watch it shimmer while subagents build in parallel, and see it settle on `work done`. Marks self-expire, so a crashed agent never leaves a frame glowing.

## Commands

| Command | What it does |
|---|---|
| `npx marver init` | Scaffold `design/` in this repo (safe to re-run; refreshes managed files) |
| `npx marver dev` / `canvas` | Start the local canvas - hot reload, comments, Live Jam armed (`--port`, default 5199) |
| `npx marver build` | Static export → `design/.dist`; what ships comes from `design/publish.json` (default-closed) |
| `npx marver serve` | Serve the export; `MARVER_ID_ISSUER` or `MARVER_PASSWORD` gates it, `MARVER_DATA_DIR` persists comments + accounts |
| `npx marver comments …` | The agent's queue: `connect <url>` · `sync` · `list` · `reply` · `resolve` · `invite <email>` · `revoke <email>` |
| `npx marver work …` | Working glow from the terminal: `start <scene/frame …>` · `done … \| --all` · `list` |

## Shortcuts

**Canvas** - two-finger scroll pans · pinch or ctrl/cmd+scroll zooms · space+drag pans from anywhere · click empty canvas deselects / exits interact.

**Zoom** - `⇧0` 100% · `⇧1` fit all · `⇧2` fit selection · click the % readout for presets (200-10%).

**Device views** - plain digits, auto-tidy + refit every time. Scoped to the selection when frames are selected, board-wide otherwise.
`0` default sizes (restores your free-form layout) · `1` mobile · `2` tablet · `3` laptop · `4` monitor · `5` tv (when enabled in design/config.ts).

**Board & chrome** - `t` tidy · `d` toggle light/dark for the board · `⌘\` (ctrl+\) collapse/open sidebar.

**Selection** - click selects · shift+click (canvas or sidebar) builds a multi-selection · `⌘A` selects every frame on the board · `⇧P` copies the selected frames' paths (board, frame, and file) · double-click enters interact mode (`esc` or click outside leaves) · drag the title bar to move, edges to resize (widths snap to devices).

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
