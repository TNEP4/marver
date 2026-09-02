# Design canvas - agent contract (embedded mode)

You design by writing files. The canvas at the printed localhost URL reflects them live.
Never drive or automate the canvas UI; read and write files only. (Starting
`npx marver dev` so the human has a live canvas - first session, or on request -
is the one allowed touch.)

## The method (binding)

Design work moves through phases. BEFORE working in a phase, read its instruction
file in design/instructions/ - they are short, strict, and part of this contract:

| Phase | When | Read |
|---|---|---|
| Welcome | the human's FIRST session, or "what is this?" | instructions/welcome.md |
| Configure | first session in a repo, or frames render unstyled | instructions/configure.md |
| Discover | any new surface, feature, or flow | instructions/discover.md |
| Shape | thinking a feature through on canvas (specs, diagrams, mood boards) - never the first session | instructions/shape.md |
| Wireframe | new work: nail structure + copy in throwaway lo-fi | instructions/wireframe.md |
| Brand | before the first hi-fi work: extract or create the world | instructions/brand.md |
| Build | hi-fi frames from real components | instructions/craft.md + components.md |
| Iterate | changing a frame the human has seen, a round of feedback on a scene, or retiring explorations | instructions/iterate.md |
| Review | before presenting anything | instructions/review.md |
| Boards | creating a board, choosing what ships | instructions/boards.md |
| Slides | a deck is asked for, or `slide: true` frames exist | instructions/slides.md + design/slides.md |
| Publish | deploying the canvas: gate, volume, accounts, invites | instructions/publish.md |
| Live Jam | responding to an `@marver` comment (a spawned job); on by default - confirm it names YOUR tool | instructions/jam.md |

Refining an existing screen: Configure must hold, then Build + Review. New work runs
the full ladder. Unsure which phase you are in? Ask the human - one question beats a
phase of wrong work.

First sessions are teaching sessions: narrate what you do and why in short plain
sentences - story, not machinery; never read these files aloud to the human
(voice rules in welcome.md).
The first-session draft is the ladder's one exception: it skips the written
brief (the human just said what they are building) but never the craft bar.

Stuck, or the human is unhappy with a result? instructions/reference/ holds the deep
guides (layout, typography, color, motion, copy, states, tuning, critique, concepts) -
the routing index is at the top of instructions/craft.md. Pull ONE file, apply, return.

## When the human points at a specific element

Two channels carry element-precise feedback - honor both:
- **A pasted address** - the human copied it off the canvas to point you at something.
  Two shapes:
  - A LASER-COPIED element pointer like `[shipper-flow ▸ flow-00-scope]  design/scenes/flow-00-scope/01-orientation.tsx · #root > div > h1 (01-orientation.tsx:5:3)`.
    They pressed L (laser mode), hovered, and clicked. Read it left to right: `[board ▸ scene]`
    is WHERE it sits on the canvas, then the frame file, then the exact css path to the element
    inside it, then the source location when present. Open that file and go straight to that element.
  - A SIDEBAR copy (right-click a board, scene, or frame in the panel) names a SCOPE, not one
    element, and leads with the board the human was viewing: `board: shipper-flow` (a whole board),
    `board: shipper-flow · scene: flow-00-scope  (design/scenes/flow-00-scope/)` (a scene folder),
    or `board: shipper-flow · frame: flow-00-scope/01-orientation  (design/scenes/flow-00-scope/01-orientation.tsx)`
    (one frame file). Work within the scope it names.
- **A pinned comment** on an element: run `npx marver comments list --open --json` - each
  thread carries the anchored element (tag, quoted text, css path, frame). Work that queue
  per instructions/iterate.md; the comment names the div, so read the anchor before the words.

Either way, **a pointer names where the human noticed it, not the only place it is.** Before
you answer, look sideways: every other LIVE frame on that board that shares the component,
the pattern, the copy or the state (never `archive/` or a `<scene>-v<N>` version - history is
not a sibling). Same defect there? Fix it in the same pass and say which frames you touched.
A judgment call? Do the pinned one, then ask in the thread or the reply whether to roll it
across the others - never silently fix one and leave its siblings wrong.

## Show the work (working state)

The canvas can wear your effort live. When a request will create or change frames, making
it visible is your FIRST act - before research, before reading the codebase, before
planning. The human should see the request land on the canvas within the first minute:

1. **Create the frame files immediately** - right name, right scene, `meta` (title,
   viewport), and a minimal skeleton (a heading and a few placeholder blocks - enough
   to give it shape) - and pin them on the target board (APPEND a node to the board
   JSON - adding is always yours, only rearranging belongs to the shell; auto boards pick
   new frames up on their own). Changing existing frames only? Skip this step.
2. **Light them up**: `npx marver work start <scene/frame ...>` - each frame wears the
   live working shimmer. Only now do research, discovery, and planning begin - under a
   lit frame, never before one.
3. Build. Independent frames can go in parallel - one subagent per frame, each marking
   its own; frames that depend on one another go in order.
4. **Clear as you finish**: `npx marver work done <scene/frame ...>` (or `--all`). Marks
   self-expire (default 10 min; `--ttl <min>` up to 30) - re-run `start` on long jobs,
   and never lean on expiry instead of `done`.

Report where the request came from: chat requests get chat replies; only comment-born
(`@marver`) work replies in its thread.

## Frames
- A frame = one file: design/scenes/<scene>/<name>.tsx or .html. One frame, one surface.
- It default-exports a React component. No imports from the tool are needed. Optional:
  export const meta = { title: "...", viewport: "mobile" }   // literal values only
  // viewport names come from design/config.ts (default: mobile, tablet, laptop, monitor;
  // tv available commented-out). Pick the one the screen is designed for - the human can
  // flip the whole board to any device (Devices menu; digit keys - 0 restores each
  // frame's own size, 1..n per configured device) to check responsiveness.
- States are sibling frames: empty.tsx, filled.tsx, error.tsx, success.tsx.
- VERSIONS are sibling frames with letter prefixes, and the canvas understands them:
  design/scenes/landing/a-terminal.tsx + b-editorial.tsx form a VARIANT GROUP - kept
  contiguous through tidy and device views, badged A/B on the canvas, one row with
  chips in the sidebar, and switchable in place in play mode ([ and ]). Scope
  alternatives inside a busy scene with a nested dir: checkout/payment/a-card.tsx vs
  b-wallet.tsx groups beside checkout/cart.tsx. meta `of`/`variant` (literal strings)
  override when filenames can't carry it. Never spread versions across scenes.
- {{UI_GUIDANCE}}
{{NEXT_NOTES}}
- Navigation: put data-goto="scene/frame" on any element. That is the whole prototype system.
  In play mode (the human presses P) frames swap in place inside one device - design flows
  as complete graphs: every screen a data-goto points at should itself link somewhere or be
  a terminal state; play mode makes dead ends visible. Give an element the same
  view-transition-name CSS in two frames and play mode morphs it between screens.
- Files starting with _ are infrastructure (never frames): _layout.tsx, _fixtures.ts.
- CONTENT frames (specs, mermaid diagrams, mood boards) are ordinary tsx frames built
  from the block primitives in '@marver-design/marver/content' - import them directly
  in the frame file and declare meta.intent. Full guide: instructions/shape.md.

## Structure ladder (embedded mode: screens live in src/)
1. First pass: write the whole page inline in the frame file. Diverge fast.
2. When a direction wins: extract the screen into src/features/<feature>/<Name>.tsx as a
   presentational component (props in, JSX out - no hooks into stores or the network),
   and shrink the frame to a ~5-line harness mounting it with fixtures.
3. Layouts: design/scenes/<scene>/_layout.tsx wraps every frame in the scene (Next.js
   convention). The root design/scenes/_layout.tsx mounts the app's real shell component.

## Fixtures
- design/scenes/<scene>/_fixtures.ts - typed plain objects shaped like the component's PROPS (containers map real APIs into them at promotion; see instructions/components.md).
- Fixture shapes should match the component's props so tsc catches drift.
- Loading states are fixtures too: export const slowOrders = () => new Promise(r =>
  setTimeout(() => r(orders), 800)) and let the frame render its skeleton while awaiting.

## Orientation
- design/manifest.json lists every frame (id, file, scene, title) - read it before
  exploring. `init` writes the first one; `marver dev` keeps it fresh.
- Component galleries: create design/components/<name>/variants.tsx rendering each variant
  and each state (default / hover-styled / focus / disabled / loading) of one ui component.

## Rules
- Do not rearrange design/boards/*.json while the canvas is open unless asked - the shell
  owns the layout fields (x/y/w/h, keys). APPENDING a node for a frame you just created is
  always yours (Show the work, step 1).
- Do not import from "design/" inside src/ or app/. The arrow points one way.
- Do not add network calls, app stores, or auth to frames or the presentational screens.
- A scene may not be named "components" or "screens".

## Handoff (when a design is approved)
- The screen already lives in src/features/. Implementation wires routes, data, and handlers
  into the same component - fixtures are the only thing replaced. The frame stays, so the
  canvas remains living documentation of every screen and state.

## Boards (curated canvases)

A board is a saved canvas: `design/boards/<name>.json` - you create and manage them
by writing files; `all-scenes` is auto-managed, never write it. Compose a board
deliberately with `"layout"`: rows/columns lanes of scenes plus `{ "space": n }`
whitespace tokens, and the same grammar per scene for frames (columns align left
edges; a variant-group name is one indivisible atom). **The default composition is
ONE horizontal band**: scenes side by side, frames flowing left to right; a second
band only when you can say why the eye should move down, and then with generous
vertical space. Without a recipe the shell stacks every scene as its own row - so
every curated board carries one. BEFORE creating a board or publishing anything,
read instructions/boards.md (the layout grammar, file format, publishing rules).

A round of feedback on a scene the human has already reviewed starts with a
**version snapshot** (`design/scenes/<scene>-v<N>/` on the `archive` board) BEFORE
the first edit - the human iterates fast knowing every version is one board away.
instructions/iterate.md has the mechanics.

## Upstream feedback (when marver itself misbehaves)

You are also marver's eyes in the field. When the TOOL fails you - a canvas glitch, a CLI
error, a broken promise in these instructions, a missing capability you genuinely needed -
file it upstream so it gets fixed for everyone. This is about marver bugs, never about the
owner's designs.

- Search first, then file (one issue per problem):
  `gh issue list --repo TNEP4/marver --search "<keywords>"` - comment on a match instead
  of duplicating. Otherwise:
  `gh issue create --repo TNEP4/marver --label bug --title "<symptom>" --body "<report>"`
  (use `--label enhancement` for a capability wish). No `gh`? Give the owner the link:
  `https://github.com/TNEP4/marver/issues/new` with your drafted title and body.
- A useful report: the marver version (`npx marver --version`), what you did, what you
  expected, what happened instead, and the smallest reproduction you can DESCRIBE -
  e.g. "a board of 12 frames, one content frame with a mermaid diagram, hotkey 2".
- **Privacy is hard law - the issue is public.** Never include the owner's code, file
  contents or names, comment text, emails, screenshots, or anything that identifies this
  repo or its product. Recreate the failure in neutral terms; if it cannot be described
  without private detail, tell the owner instead of filing.
- Tell the owner what you filed, with the link - it is their machine and their voice.
