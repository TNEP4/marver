# Marver

[![npm](https://img.shields.io/npm/v/%40marver-design%2Fmarver?color=2f6fed&label=npm)](https://www.npmjs.com/package/@marver-design/marver)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](package.json)

**The agent-native design canvas.** A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

Screens, prototypes, specs, and now slide decks - all real code, all on one canvas, all shareable with people who sign in as themselves.

[marver.design](https://marver.design) · [Slides](docs/slides.md) · [Live Jam](docs/live-jam.md) · [Deploying a canvas](docs/publish.md) · [Sharing](docs/sharing.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/TNEP4/marver/issues)

## Quickstart

```bash
npm i -D @marver-design/marver
npx marver init   # scaffolds design/ (detects shadcn, Tailwind, your router)
npx marver dev    # canvas at localhost:5199 (npx marver canvas works too - same thing)
```

Then, to your agent:

> Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components.

or

> Read design/AGENTS.md. Build me a 12-slide pitch deck from this brief, in our brand.

Frames appear on the canvas the moment the files land. That's the loop.

## Why marver

- **Frames are real code.** Plain TSX/HTML files rendered from your repo's actual components and theme - zero imports from this package required. An approved design promotes into the app by moving a file, not by re-implementing a picture.
- **Decks are real code too.** A slide is a frame with `slide: true`. One `Slide` primitive, your own markup inside it, a doctrine that teaches the agent to argue rather than decorate - and a stage that scales itself to any screen without the agent writing a single breakpoint. See [Slides](#slides).
- **Everything hot-reloads.** The agent writes, you watch it land - live.
- **True viewports.** Each frame is a real iframe: drag its edge and your actual breakpoints fire.
- **Your agent answers on the canvas.** Tag `@marver` in a comment and it picks up the job, edits the real source, and replies in the thread - no wiring, on by default. See [Live Jam](#live-jam).
- **Feedback without a signup wall.** Publish the canvas and invite people by email; they sign in as themselves with one free Marver account that opens every canvas anyone ever shares with them. @-mention a reviewer, they get the mail; reply, and the thread's people hear about it. Or keep it entirely self-hosted behind a shared password. See [Collaboration](#collaboration).
- **No AI inside.** The designer is the coding agent you already run and pay for. `init` generates `design/AGENTS.md` and a `design/instructions/` method - configure, discover, wireframe, brand, build, review, slides, publish - that teaches it the whole workflow.

## The canvas

- **Frames, scenes, boards.** Frames are screens, scenes group them (`design/scenes/<scene>/<frame>.tsx`), boards arrange them. Agents write `design/boards/<name>.json` (a frame list is enough); switch boards at the top of the sidebar. `all-scenes` is auto-managed. Right-click any board, scene, or frame in the sidebar to copy its path - the exact string to paste to your agent - and rename or drag-reorder boards from there too.
- **Devices view.** Hotkeys `1`-`5` (or the Devices menu) size every frame to mobile / tablet / laptop / monitor / tv to sweep your breakpoints; `0` restores your own layout exactly. Widths live in `design/config.ts`.
- **Prototype links.** `data-goto="scene/frame"` on any element links frames into a walkable prototype - across boards, too.
- **Five ways to view a board.** The canvas (frames on a plane), the board (the same, tidy), **present** (`p`: a full-screen clickable walkthrough - `data-goto` navigates, arrows step, `[` / `]` cycle variants, laser, comments, theme and device pickers in the toolbar), **focus** (one frame as a document - the reading preset for specs), and **slides** (a deck). A published board names its landing view; a frame deep link opens straight into it.
- **Content frames.** Specs, Mermaid diagrams, mood boards, and slides live on the same canvas as the screens - import `Doc`, `Md`, `Diagram`, `Img`, `Slide`, `Chart`, `Video` from `@marver-design/marver/content` and think a feature through before any pixels exist. Works in a repo with no app at all: idea first, design second.

## Slides

A deck is a scene of `slide: true` frames. On the canvas they are 1280×720 frames like any other - comment on them, laser them, fork variants, drag them to reorder the deck (the board's reading order is the play order). Press `p` on a slides board and you get slides mode: the 16:9 stage, arrows / Space / click to advance, `d` for dark, devices including fill window, morphs between slides where the agent named the same element twice.

What makes it light on the agent side, and good on every screen:

- **One primitive, no component library.** `Slide` owns the stage, the margins, six fixed type roles, your theme's tokens, and the motion contract. Everything inside is your project's own markup and components - a slide is built the way a screen is built.
- **The fit is pure CSS.** The agent authors at exactly 1280×720; the root scales and centers itself to a phone, a laptop, a projector, or a resized canvas node. No `vw`, no media queries, no breakpoints - the composition you approved is the composition everyone sees, and a dev-only overflow marker outlines any slide that escapes the stage or collides inside it.
- **Still at rest.** Charts are final-state SVG in a lazy chunk, videos are posters, every animation is suspended until slides mode plays - so a 40-slide deck pans like 40 statics on the canvas.
- **A doctrine, not a template.** `init` ships `design/instructions/slides.md`: assertion-first argument, the space (three bands, the 85% rule, one spacing scale), seven silhouettes chosen before any recipe so a deck never reads as one repeated shape, 19 recipes with budgets, choreography rules, and a review gate - plus two depth references and your own project-owned `design/slides.md` with a fill-in **deck look** the agent drafts from your brand.

Publish a deck with `{ "pitch": { "max": "read", "type": "slides", "open": "slides", "lock": true } }` in `design/publish.json` and the link opens straight into the deck, read-only, with no canvas behind it. The [slides guide](docs/slides.md) has the rest - morphs, build steps, `Chart` and `Video`, the theme tokens.

## Collaboration

- **Comments.** Google-Docs-style feedback pinned to actual elements. Press `c`, click a div inside a frame, write - the thread lives on that element and survives edits via a layered anchor (source semantics → structure → fuzzy text). Type `@` to mention someone who can already see the canvas; they get a mail with the comment and a link that lands on the thread, and the mention pulses its pin in their canvas with an in-app notification. A reply mails the thread's other participants, throttled per person and thread; anyone can mute a canvas's mail. `marver dev` syncs the same threads into `design/comments/*.jsonl`, where your agent works the queue: `npx marver comments list --open --json` → fork a variant → `resolve --addressed-in`. Live via SSE; one deploy, no extra services.
- **Laser mode.** Press `l`: every element in every frame gets depth-hued outlines plus a hover label - the fastest way to see structure. Click any element to copy its full address (frame file + CSS path) for the agent.
- **Publishing.** `npx marver build` exports a static canvas (default-closed: `design/publish.json` names what ships, each board's ceiling - `read` or `comment` - and, since 0.12, its **type** and **landing view**: `{ "max", "type": "doc" | "slides" | "design" | "sketch" | "refs" | "mix", "open": "canvas" | "board" | "present" | "focus" | "slides", "lock": true }`); `npx marver serve` hosts it. One deploy on Railway, Docker, or any static host - the [publishing guide](docs/publish.md) has the one-pagers.
- **Sharing, person by person.** On a canvas with a persistent volume, `marver share add sam@acme.com --role comment` (or the browser's share dialog) grants one person access, `@acme.com` grants a domain, `general private|password|public` sets the floor, and a refused visitor can ask to get in - approve from the terminal. One resolver answers "what can this person do here", and `marver share explain <email>` shows its reasoning. The [sharing guide](docs/sharing.md) has the whole surface.

- **Two ways to let people in.** They are alternatives, not layers - pick one per canvas.

  **Marver Sign In.** Set `MARVER_ID_ISSUER=https://id.marver.design` and reviewers sign in as themselves, with Google or a six-digit code emailed to them. One free Marver account opens *every* canvas gated this way, so the second board you share costs them nothing: no new signup, no new password, no link to keep. Their real name and face ride along, so a thread is from a person rather than from an address. And **[app.marver.design](https://app.marver.design)** is their front door: every canvas they can reach, in one signed-in list, each row lit by a summary the canvas itself signs - the front door holds no roster and makes no access decision.

  **A shared password** (`MARVER_PASSWORD`). Fully self-hosted, no account anywhere but your own volume, nothing about your reviewers leaves your infrastructure - and still fully supported. The trade is that every canvas is an island: reviewers claim an invite link and pick a name and password *on that canvas*, and do it again for the next one.

  Either way the canvas runs on your infrastructure and stores its own comments and members. With Marver Sign In the identity service only ever tells your canvas that a verified address matched an entry on your list - it never sees your frames, your files, or your comments. Rights stay yours: `design/publish.json` decides which boards are readable and which are commentable, and the roster decides who is on the list.

## Live Jam

Tag `@marver` in a comment and your own coding agent picks it up - reads the thread, edits the real frame source, replies with a receipt - while the frame wears a live working glow. Nothing to start and nothing to wire: it rides along with `marver dev`, on by default, armed with whichever agent CLI you have - Claude Code, Codex, Cursor, Factory's droid, opencode, grok, or pi, which also covers the apps built on them. The tool running the process wins, then whatever is on PATH, and `init` writes what it found into `design/config.ts` as `jam: { agent: "claude", concurrency: 6 }` - visible, one word to correct, `jam: false` to switch off.

The trust boundary is hard: only comments written on the owner's machine trigger (a device-bound ledger - a drive-by comment on a published canvas cannot start work), the agent runs locked down (each CLI with its shell removed or OS-sandboxed - the per-agent table is in the guide), and every reply carries provenance: which agent ran it, as which dev user, on which model when the agent names one. Marver ships no AI; the agent that acts is the one you already run. The [Live Jam guide](docs/live-jam.md) has the config block, every agent's jail, and what to check when a mention does nothing.

## Working state

The same glow, driven from the terminal. When your agent takes a request, it creates the frame files first, pins them on a board, and runs `npx marver work start <scene/frame ...>` - you see the work land on the canvas in seconds, watch it shimmer while subagents build in parallel, and see it settle on `work done`. Marks self-expire, so a crashed agent never leaves a frame glowing. And `npx marver shot <scene/frame>` renders one frame headless to a PNG, so the agent can look at what it built before it says it is done.

## Commands

| Command | What it does |
|---|---|
| `npx marver init` | Scaffold `design/` in this repo (safe to re-run; refreshes managed files) |
| `npx marver dev` / `canvas` | Start the local canvas - hot reload, comments, Live Jam armed (`--port`, default 5199) |
| `npx marver build` | Static export → `design/.dist`; what ships comes from `design/publish.json` (default-closed) |
| `npx marver serve` | Serve the export; `MARVER_ID_ISSUER` or `MARVER_PASSWORD` gates it, `MARVER_DATA_DIR` persists comments + accounts |
| `npx marver share …` | The roster (owner): `add <who> [--role]` · `remove` · `block` / `unblock` · `general <mode>` · `list` · `requests` · `explain <who>` · `who` |
| `npx marver comments …` | The agent's queue: `connect <url>` · `sync` · `list` · `reply` · `resolve` · `invite <email>` · `revoke <email>` |
| `npx marver work …` | Working glow from the terminal: `start <scene/frame …>` · `done … \| --all` · `list` |
| `npx marver shot <frame>` | Render one frame headless and print the PNG path (needs `dev` running) |

## Shortcuts

**Canvas** - two-finger scroll pans · pinch or ctrl/cmd+scroll zooms · space+drag pans from anywhere · click empty canvas deselects / exits interact.

**Zoom** - `⇧0` 100% · `⇧1` fit all · `⇧2` fit selection · click the % readout for presets (200-10%).

**Device views** - plain digits, auto-tidy + refit every time. Scoped to the selection when frames are selected, board-wide otherwise.
`0` default sizes (restores your free-form layout) · `1` mobile · `2` tablet · `3` laptop · `4` monitor · `5` tv (when enabled in design/config.ts).

**Board & chrome** - `t` tidy · `d` toggle light/dark for the board · `⌘\` (ctrl+\) collapse/open sidebar.

**Selection** - click selects · shift+click (canvas or sidebar) builds a multi-selection · `⌘A` selects every frame on the board · `⇧P` copies the selected frames' paths (board, frame, and file) · double-click enters interact mode (`esc` or click outside leaves) · drag the title bar to move, edges to resize (widths snap to devices).

**Modes** - `c` comment mode · `l` laser mode · `⇧C` hide/show comment pins · `⇧L` laser comment (spotlight a thread's element) · `p` play (present, or slides on a slides board) · `h` hide all chrome.

**In play** - `←` `→` or Space step · click advances a deck · `[` `]` cycle variants · `d` theme · digits pick a device, the digit after your last one fills the window · `esc` exits.

## Notes

- **Next.js**: supported with one caveat - frames render in Vite, outside Next. `next/font` CSS variables are undefined inside frames (give font tokens a fallback chain), `next/image`/`next/link` should be plain `img`/`data-goto` in frames, and Server Components cannot run there. `init` writes the specifics into `design/AGENTS.md` when it detects Next.
- **Upgrade**: `npm i -D @marver-design/marver@latest && npx marver init`. The canvas tells you when a new version is out (one anonymous registry check per day, cached in `design/.local/`; `MARVER_NO_UPDATE_CHECK=1` disables), and warns when your `design/instructions/` predate the installed package. Re-running init refreshes the managed files (AGENTS.md, `design/instructions/`) - your edits to them are detected and preserved; when both you and a release changed a file, the fresh version is staged at `design/.local/latest/` for you (or your agent) to merge. Everything else in `design/` is yours and never touched.
- **Name your canvas**: `share: { name: "Your App" }` in `design/config.ts` titles the gate and the brand pill and tags every powered-by link; unset, it falls back to the directory name - `app` inside most containers.
- **Uninstall**: delete `design/`, remove the dependency. (If `init` patched your tsconfig `exclude`, revert that one line.)

## Status

Marver is a young solo side project - it works, it's dogfooded daily, and it has rough edges. The known weak spot: boards with many heavy frames (animation-rich, component-dense) can strain the canvas, especially while zooming - snapshot-based rendering helps but isn't finished. Sharing controls who gets in and who may comment; per-board read privacy (a board some people can see and others cannot) is next. If you hit a wall, an issue with your board shape and frame count genuinely helps.

## Contributing

Bug reports, ideas, and PRs are welcome - start with [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [private vulnerability reporting](SECURITY.md), not public issues. Agents running marver are taught to file what they hit as issues here, too - expect some robot reporters.

## License

[Apache-2.0](LICENSE) · built by [Nic Touron](https://github.com/TNEP4)
