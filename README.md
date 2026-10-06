# Marver

[![npm](https://img.shields.io/npm/v/%40marver-design%2Fmarver?color=2f6fed&label=npm)](https://www.npmjs.com/package/@marver-design/marver)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](package.json)

**The agent-native design canvas.** A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

Screens, prototypes, specs, and now slide decks - all real code, all on one canvas, all shareable with people who sign in as themselves.

[marver.design](https://marver.design) · [Boards and folders](docs/boards-and-folders.md) · [Context](docs/context.md) · [Slides](docs/slides.md) · [Sticky notes](docs/sticky-notes.md) · [Live Jam](docs/live-jam.md) · [Deploying a canvas](docs/publish.md) · [Sharing](docs/sharing.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/TNEP4/marver/issues)

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
- **Decks are real code too.** A slide is a frame with `slide: true` - nothing else. Any layout, typeface, drawing or animation the browser can render, a guide that teaches the agent to argue and to wear your brand rather than decorate, and a player that scales the stage to any screen without the agent writing a single breakpoint. See [Slides](#slides).
- **Everything hot-reloads.** The agent writes, you watch it land - live.
- **True viewports.** Each frame is a real iframe: drag its edge and your actual breakpoints fire.
- **Your agent answers on the canvas.** Tag `@marver` in a comment and it picks up the job, edits the real source, and replies in the thread - no wiring, on by default. See [Live Jam](#live-jam).
- **Feedback without a signup wall.** Publish the canvas and invite people by email; they sign in as themselves with one free Marver account that opens every canvas anyone ever shares with them. @-mention a reviewer, they get the mail; reply, and the thread's people hear about it. Or keep it entirely self-hosted behind a shared password. See [Collaboration](#collaboration).
- **No AI inside.** The designer is the coding agent you already run and pay for. `init` generates `design/AGENTS.md` and a `design/instructions/` method - configure, discover, wireframe, brand, build, review, slides, publish - that teaches it the whole workflow.

## The canvas

- **Frames, scenes, boards.** Frames are screens, scenes group them (`design/scenes/<scene>/<frame>.tsx`), boards arrange them. Agents write `design/boards/<name>.json` (a frame list is enough); switch boards at the top of the sidebar. `all-scenes` is auto-managed. Right-click any board, scene, or frame in the sidebar to copy its path - the exact string to paste to your agent - and rename or drag-reorder boards from there too. Boards can live in folders, two levels deep - a folder holds boards and folders, a sub-folder holds boards: right-click the Boards header (or its `+`) for a new folder, a folder for a new one inside it, name it inline, drag boards in and out at either level (the seam shows exactly where a release lands, indented with the level) and folders among boards or into a folder; agents do the same by writing `"folder": "<name>"` on a board and `design/boards/_folders.json` for empty, ranked or nested folders (a sub-folder names its `"parent"`; `npx marver boards` prints the tree). The [boards and folders guide](docs/boards-and-folders.md) has every move. Boards, folders and scenes take a `title` - any name you like, "MVP", "UI", "Checkout (v2) 🛒" - while their file, key and directory stay the slug agents address; Rename in the sidebar edits the title. Every board wears an icon for its type - start, feature, surface, project, feedback, context, deck, archive - its own or its folder's, and feature boards wear a status read from the project's `context/`. Every object takes a one-sentence `description` (project in `design/config.ts`, boards and folders in their JSON, a scene's first `_brief.md` line, `meta.description` on a frame) and `design/manifest.json` carries them all - a new agent session orients in one read.
- **Devices view.** Hotkeys `1`-`5` (or the Devices menu) size every frame to mobile / tablet / laptop / monitor / tv to sweep your breakpoints; `0` restores your own layout exactly. Widths live in `design/config.ts`.
- **Prototype links.** `data-goto="scene/frame"` on any element links frames into a walkable prototype - across boards, too.
- **Five ways to view a board.** The canvas (frames on a plane), the board (the same, tidy), **present** (`p`: a full-screen clickable walkthrough - `data-goto` navigates, arrows step, `[` / `]` cycle variants, laser, comments, theme and device pickers in the toolbar), **focus** (one frame as a document - the reading preset for specs), and **slides** (a deck). A published board names its landing view; a frame deep link opens straight into it.
- **Content frames.** Specs, Mermaid diagrams, mood boards, and slides live on the same canvas as the screens - import `Doc`, `Md`, `Diagram`, `Img`, `Slide`, `Chart`, `Video` from `@marver-design/marver/content` and think a feature through before any pixels exist. Works in a repo with no app at all: idea first, design second.
- **Sticky notes.** A markdown file beside a frame (`cart.note.md`) or a scene (`_note.md`) becomes a yellow note left of the frame on the canvas - what it is for, how two variations differ, an open question. Markdown, `goto:` links to frames, hand-drawn Mermaid; readers comment on a note's text like on a frame's, fold it to its corner, hide them all with `n`. The layout makes room for it, beside the frame and below; published canvases carry them.
- **Hi-fi at rest.** A frame at rest is its own live document, asleep: animations paused and every `backdrop-filter` element painted with a certified texture of its filtered backdrop (compiled by the dev server's headless Chrome), so a board of 30 glass screens pans like 30 statics and wakes pixel-identical on interact. Glass inside glass, blend modes and frames whose paint depends on random data or the clock stay live; `?awake=1` keeps every frame live for comparison.
- **Charts and video in any frame.** `Chart` (Apache ECharts, SVG, still at rest) inherits the ink, typeface and accent of whatever frame it sits in - a Tailwind dashboard, a dark spec, a slide - sizes its type to the context and follows the layout on resize. `Video` is poster-first everywhere: click to play wherever the frame is live, `autoplay` for an ambient loop, `ratio` for vertical clips; omit the poster and marver renders one from the clip. A screen with a chart or a clip is still a screen.
- **Copy as image.** Select a frame, press `i` - a 2x PNG of it lands on the clipboard, rendered by the same headless Chrome that serves `marver shot`; `⇧i` for 4x (a 1280×720 slide is 5120×2880, whatever size its node has). Paste into Slack, a doc, or a chat with your agent.

## Context

Code says what is implemented; `context/` says the rest - what is available and to whom, how each
capability works, why, what is next - with evidence, in files any agent reads first.
`npx marver context init` sets it up, `npx marver context check` keeps it true in ci (availability
only in the shipped record, every claim with a level and a citation, a contract change with every
behaviour change), and the canvas reads the same files: feature boards wear Backlog, To do, In
progress, Done - never set by hand. Existing projects with scattered specs get a playbook that
reorganizes them on a branch and proves it with a blind eval. [The context guide](docs/context.md).

## Slides

A deck is a scene of `slide: true` frames. On the canvas they are frames like any other - comment on them, laser them, fork variants, drag them to reorder the deck (the board's reading order is the play order). Press `p` on a slides board and you get slides mode: arrows / Space / click to advance, `d` cycles the theme, morphs between slides where the agent named the same element twice.

- **A slide is just code.** No component library, no wrapper, no fixed type scale: the agent builds each slide from your project's own components and styles - an intricate diagram, a full-bleed photograph, an SVG drawing that animates in - the way it builds a screen.
- **A stage, and a player that scales it.** A slide renders at 1280×720, or at the `viewport` it declares (a 16:10 deck at 1280×800). Slides mode scales the whole stage to the screen - up on a projector, down on a phone - so the composition you approved is the one everyone sees.
- **Still at rest, alive in play.** On the canvas a resting slide is asleep like any frame; while the deck plays, the stage marks `data-sl-play` and `data-sl-entered` on the document so the agent's own animations run when a slide arrives, and `view-transition-name` morphs carry elements from one slide to the next.
- **Craft, not rules.** `init` ships `design/instructions/slides.md`: the deck kit a strong deck is built on (a master, whole-slide tones, the brand's type, a drawing system), the habits that make a deck look made rather than typed, the method (the answer first, a slide list that tells the argument, notes that carry the talk track), an idea bank of compositions, and your own project-owned `design/slides.md` with a **deck look** the agent drafts from your brand.

Publish a deck with `{ "boards": { "pitch": { "max": "read", "type": "slides", "open": "slides", "lock": true } } }` in `design/publish.json` and the link opens straight into the deck, read-only, with no canvas behind it. The [slides guide](docs/slides.md) has the rest - motion, build steps, `Chart` and `Video`, notes.

## Collaboration

- **Comments.** Google-Docs-style feedback pinned to actual elements. Press `c`, click a div inside a frame, write - the thread lives on that element and survives edits via a layered anchor (source semantics → structure → fuzzy text). Type `@` to mention someone who can already see the canvas; they get a mail with the comment and a link that lands on the thread, and the mention pulses its pin in their canvas with an in-app notification. A reply mails the thread's other participants, throttled per person and thread; anyone can mute a canvas's mail. `marver dev` syncs the same threads into `design/comments/*.jsonl`, where your agent works the queue: `npx marver comments list --open --json` → fork a variant → `resolve --addressed-in`. Live via SSE; one deploy, no extra services.
- **Laser mode.** Press `l`: every element in every frame gets depth-hued outlines plus a hover label - the fastest way to see structure. Click any element to copy its full address (frame file + CSS path) for the agent. (On a published canvas, laser needs `"reveal": { "source": true }` in `publish.json` - source paths go opaque by default.)
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

The same glow, driven from the terminal. When your agent takes a request, it creates the frame files first, pins them on a board, and runs `npx marver work start <scene/frame ...>` - you see the work land on the canvas in seconds, watch it shimmer while subagents build in parallel, and see it settle on `work done`. Marks self-expire, so a crashed agent never leaves a frame glowing. And `npx marver shot --scene <scene>` (or `<scene/frame ...>`, `--all`; `[--scale 4]`) renders frames headless to PNGs - a whole scene in one browser, several frames at a time - so the agent can look at what it built before it says it is done - the same picture you get from the canvas's copy-as-image.

## Commands

| Command | What it does |
|---|---|
| `npx marver init [--kind product\|knowledge]` | Scaffold `design/` in this repo (safe to re-run; refreshes managed files); a fresh canvas gets the kind's typed folders |
| `npx marver dev` / `canvas` | Start the local canvas - hot reload, comments, Live Jam armed (`--port`, default 5199) |
| `npx marver build` | Static export → `design/.dist`; what ships comes from `design/publish.json` (default-closed) |
| `npx marver serve` | Serve the export; `MARVER_ID_ISSUER` or `MARVER_PASSWORD` gates it, `MARVER_DATA_DIR` persists comments + accounts |
| `npx marver share …` | The roster (owner): `add <who> [--role]` · `remove` · `block` / `unblock` · `general <mode>` · `list` · `requests` · `explain <who>` · `who` |
| `npx marver comments …` | The agent's queue: `connect <url>` · `sync` · `list` · `reply` · `resolve` · `invite <email>` · `revoke <email>` |
| `npx marver work …` | Working glow from the terminal: `start <scene/frame …>` · `done … \| --all` · `list` |
| `npx marver shot <frame ...> \| --scene <name> \| --all [--scale 1-4] [--json]` | Render frames headless and print the PNG paths (needs `dev` running); a scene is one browser, several frames at a time; 2x by default |
| `npx marver boards [--json]` | The sidebar as the files say it is: folders and sub-folders, boards in reading order with their title, type, status, `order` and description, the landing board |
| `npx marver boards new <name> [--folder f] [--type t]` | A board in its type's starting layout - a feature's spec, lo-fi and hi-fi bands, a start board rendering `context/` |
| `npx marver folders add <module ...>` | Add a typed folder: `start`, `features`, `surfaces`, `projects`, `feedback`, `context`, `decks`, `archive` |
| `npx marver context init \| check \| index` | Set up `context/`; check it (exit 0 / 1 / 2; `--base`, `--body-file` for a pull request); regenerate the index's capability table |

## Shortcuts

**Canvas** - two-finger scroll pans · pinch or ctrl/cmd+scroll zooms · space+drag pans from anywhere · click empty canvas deselects / exits interact.

**Zoom** - `⇧0` 100% · `⇧1` fit all · `⇧2` fit selection · click the % readout for presets (200-10%).

**Device views** - plain digits, auto-tidy + refit every time. Scoped to the selection when frames are selected, board-wide otherwise.
`0` default sizes (restores your free-form layout) · `1` mobile · `2` tablet · `3` laptop · `4` monitor · `5` tv (when enabled in design/config.ts).

**Board & chrome** - `t` tidy · `d` toggle light/dark for the board · `⌘\` (ctrl+\) collapse/open sidebar.

**Selection** - click selects · shift+click (canvas or sidebar) builds a multi-selection · `⌘A` selects every frame on the board · `⇧P` copies the selected frames' paths (board, frame, and file) · `i` copies the selected frame to the clipboard as a 2x PNG (`⇧i` for 4x; also the images-square button in the floating toolbar - dev canvases only, the renderer is the dev server's headless Chrome) · double-click enters interact mode (`esc` or click outside leaves) · drag the title bar to move, edges to resize (widths snap to devices).

**Modes** - `c` comment mode · `l` laser mode · `⇧C` hide/show comment pins · `⇧L` laser comment (spotlight a thread's element) · `p` play (present, or slides on a slides board) · `h` hide all chrome.

**In play** - `←` `→` step (Space and click advance a deck) · `[` `]` cycle variants · `d` cycles the theme · digits pick a device, the digit after your last one fills the window · `esc` exits, unless the board is locked to that view.

## Notes

- **Next.js**: supported with one caveat - frames render in Vite, outside Next. `next/font` CSS variables are undefined inside frames (give font tokens a fallback chain), `next/image`/`next/link` should be plain `img`/`data-goto` in frames, and Server Components cannot run there. `init` writes the specifics into `design/AGENTS.md` when it detects Next.
- **Upgrade**: `npm i -D @marver-design/marver@latest && npx marver init`. The canvas tells you when a new version is out (one anonymous registry check per day, cached in `design/.local/`; `MARVER_NO_UPDATE_CHECK=1` disables), and warns when your `design/instructions/` predate the installed package. Re-running init refreshes the managed files (AGENTS.md, `design/instructions/`) - your edits to them are detected and preserved; when both you and a release changed a file, the fresh version is staged at `design/.local/latest/` for you (or your agent) to merge. Everything else in `design/` is yours and never touched.
- **Name your canvas**: `share: { name: "Your App" }` in `design/config.ts` titles the gate, labels the brand pill, and tags every powered-by link. Unset, the gate falls back to your `package.json` name and the canvas shell to the directory name - `app` inside most containers.
- **Uninstall**: delete `design/`, remove the dependency. (If `init` patched your tsconfig `exclude`, revert that one line.)

## Status

Marver is a young solo side project - it works, it's dogfooded daily, and it has rough edges. The known weak spot: boards with many heavy frames (animation-rich, component-dense) can strain the canvas, especially while zooming - snapshot-based rendering helps but isn't finished. Sharing controls who gets in and who may comment; per-board read privacy (a board some people can see and others cannot) is next. If you hit a wall, an issue with your board shape and frame count genuinely helps.

## Contributing

Bug reports, ideas, and PRs are welcome - start with [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [private vulnerability reporting](SECURITY.md), not public issues. Agents running marver are taught to file what they hit as issues here, too - expect some robot reporters.

## License

[Apache-2.0](LICENSE) · built by [Nic Touron](https://github.com/TNEP4)
